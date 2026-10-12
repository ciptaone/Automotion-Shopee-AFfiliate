/**
 * PostgreSQL catalog store (Part 5) — row per product, row per import batch.
 *
 * Replaces the whole-catalog JSON snapshot with the same semantics the file
 * catalog already had, expressed as database constraints:
 *
 *   - one row per `(feed_id, marketplace)` — `products_feed_id_marketplace_idx`
 *     is UNIQUE, so re-importing the same feed can only UPSERT;
 *   - `products.product_url_normalized` reproduces the importer's URL
 *     deduplication (`urlDuplicatesSkipped`) at the storage layer;
 *   - `import_batches` keeps the per-import counters and the parser's row
 *     issues, so "what happened during that import" survives a restart.
 *
 * Only references (storage keys / URLs) and metadata are stored — never image
 * binaries. `save()` runs inside one transaction so a half-applied import can
 * never be observed.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type {
  CatalogProduct,
  CatalogSnapshot,
  CatalogStore,
  ImportBatchRecord,
} from '../catalog/catalog.js';
import { importBatches, products } from './schema.js';
import type { Database } from './client.js';

type Row = Record<string, unknown>;

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  return {};
}

/**
 * Drizzle's timestamp columns require real `Date` values (`toISOString()` is
 * called on them at the driver boundary), so ISO strings from the record
 * contract are converted here rather than at every call site.
 */
function toDateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toDate(value: string | null | undefined, fallback: Date = new Date()): Date {
  return toDateOrNull(value) ?? fallback;
}

/**
 * Row -> `CatalogProduct`.
 *
 * Drizzle returns SCHEMA PROPERTY names (camelCase), not column names — this
 * mapper must read `feedId`, `productUrl`, `importBatchId`, ... Reading
 * `row.feed_id` here would yield `undefined` for every multi-word field and a
 * catalog that loads "successfully" but is missing its data.
 */
function rowToProduct(row: Row): CatalogProduct {
  return {
    internalId: String(row.id),
    sourceProductId: String(row.feedId),
    name: String(row.name ?? ''),
    marketplace: String(row.marketplace ?? ''),
    productUrl: String(row.productUrl ?? ''),
    affiliateUrl: String(row.affiliateUrl ?? ''),
    hasAffiliateLink: row.hasAffiliateLink === true,
    productUrlNormalized: String(row.productUrlNormalized ?? ''),
    category: nullableText(row.category),
    categoryId: nullableText(row.categoryId),
    imageUrl: nullableText(row.imageUrl),
    description: nullableText(row.description),
    price: nullableNumber(row.price),
    currency: nullableText(row.currency),
    commissionRate: nullableNumber(row.commissionRate),
    rating: nullableNumber(row.rating),
    soldCount: nullableNumber(row.soldCount),
    eligible: row.eligible === true,
    eligibilityReasons: jsonArray<string>(row.eligibilityReasons),
    lastImportedAt: nullableIso(row.lastImportedAt) ?? new Date(0).toISOString(),
    sourceImportId: nullableText(row.importBatchId) ?? '',
    extraColumns: jsonObject(row.extraColumns),
  };
}

function rowToBatch(row: Row): ImportBatchRecord {
  const format = String(row.format ?? 'csv');
  return {
    id: String(row.id),
    filename: String(row.filename ?? ''),
    format: (format === 'xlsx' ? 'xlsx' : 'csv') as ImportBatchRecord['format'],
    importedAt: nullableIso(row.createdAt) ?? new Date(0).toISOString(),
    totalRows: Number(row.totalRows ?? 0),
    accepted: Number(row.accepted ?? 0),
    newProducts: Number(row.newProducts ?? 0),
    updatedProducts: Number(row.updatedProducts ?? 0),
    rejected: Number(row.rejected ?? 0),
    duplicatesRemoved: Number(row.duplicatesRemoved ?? 0),
    urlDuplicatesSkipped: Number(row.urlDuplicatesSkipped ?? 0),
    categoriesSeen: Number(row.categoriesSeen ?? 0),
    issues: jsonArray<ImportBatchRecord['issues'][number]>(row.issues),
    source: 'feed_import',
  };
}

export class PostgresCatalogStore implements CatalogStore {
  readonly kind = 'postgres' as const;

  constructor(private readonly db: Database) {}

  async load(): Promise<CatalogSnapshot | null> {
    const productRows = (await this.db
      .select()
      .from(products)
      .orderBy(products.updatedAt)) as unknown as Row[];
    const batchRows = (await this.db
      .select()
      .from(importBatches)
      .orderBy(importBatches.createdAt)) as unknown as Row[];

    if (productRows.length === 0 && batchRows.length === 0) return null;

    return {
      version: 1,
      products: productRows.map(rowToProduct),
      batches: batchRows.map(rowToBatch),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Upsert the whole snapshot atomically.
   *
   * Batches are written before products because `products.import_batch_id`
   * references them. Conflicts update in place (a re-import must not create a
   * second row for the same batch id or the same feed product).
   */
  async save(snapshot: CatalogSnapshot): Promise<void> {
    const batchIds = new Set(snapshot.batches.map((batch) => batch.id));

    await this.db.transaction(async (tx) => {
      for (const batch of snapshot.batches) {
        const values: Record<string, unknown> = {
          id: batch.id,
          filename: batch.filename,
          format: batch.format,
          totalRows: batch.totalRows,
          accepted: batch.accepted,
          newProducts: batch.newProducts,
          updatedProducts: batch.updatedProducts,
          rejected: batch.rejected,
          duplicatesRemoved: batch.duplicatesRemoved,
          urlDuplicatesSkipped: batch.urlDuplicatesSkipped,
          categoriesSeen: batch.categoriesSeen,
          issues: JSON.stringify(batch.issues ?? []),
          source: 'feed_import',
          createdAt: toDate(batch.importedAt),
        };
        await tx
          .insert(importBatches)
          .values(values as never)
          .onConflictDoUpdate({ target: importBatches.id, set: values as never });
      }

      for (const product of snapshot.products) {
        const importBatchId =
          product.sourceImportId && batchIds.has(product.sourceImportId)
            ? product.sourceImportId
            : null;
        const values: Record<string, unknown> = {
          id: product.internalId || randomUUID(),
          feedId: product.sourceProductId,
          name: product.name,
          marketplace: product.marketplace,
          productUrl: product.productUrl,
          productUrlNormalized: product.productUrlNormalized,
          affiliateUrl: product.affiliateUrl,
          hasAffiliateLink: product.hasAffiliateLink,
          price: product.price,
          currency: product.currency,
          commissionRate: product.commissionRate,
          imageUrl: product.imageUrl,
          category: product.category,
          categoryId: product.categoryId,
          description: product.description,
          rating: product.rating,
          soldCount: product.soldCount,
          eligible: product.eligible,
          eligibilityReasons: JSON.stringify(product.eligibilityReasons ?? []),
          extraColumns: JSON.stringify(product.extraColumns ?? {}),
          lastImportedAt: toDate(product.lastImportedAt),
          importBatchId,
          updatedAt: toDate(snapshot.updatedAt),
        };
        await tx
          .insert(products)
          .values(values as never)
          .onConflictDoUpdate({
            target: [products.feedId, products.marketplace],
            // An update refreshes everything EXCEPT the surrogate key: the
            // catalog's internal id must stay stable for the lifetime of the
            // entry, however many times the feed is re-imported.
            set: { ...values, createdAt: sql`now()` } as never,
          });
      }
    });
  }
}
