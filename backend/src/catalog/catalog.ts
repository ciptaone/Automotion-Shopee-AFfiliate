/**
 * Persistent product catalog (Part 3).
 *
 * Turns one-shot feed parse results into a durable, queryable catalog that the
 * selection policy and content pipeline consume.
 *
 * Design rules (from the PART 3 brief):
 *  - Persistence is pluggable: an atomic FILE store by default (verified in
 *    this environment), an in-memory store for tests. The Drizzle/PostgreSQL
 *    schema exists (see db/schema.ts + drizzle/0001_part3_catalog.sql) but is
 *    BLOCKED for live verification here (no database server available).
 *  - Imports are IDEMPOTENT: re-importing the same feed must not duplicate
 *    products; product identity is (sourceProductId, marketplace), with a
 *    normalized-product-URL fallback dedupe.
 *  - A failed import NEVER destroys a previously valid catalog: the parse
 *    either produced products (then we upsert) or threw (then the catalog is
 *    untouched).
 *  - Unknown/extra source columns are preserved verbatim per product, so a
 *    richer Shopee export never loses data we do not yet understand.
 *  - Nothing here fabricates product metadata: eligibility is computed strictly
 *    from imported fields (see eligibility.ts).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FeedParseResult, FeedProduct, FeedRowIssue } from '../contracts/index.js';
import { AppError } from '../core/errors.js';
import { evaluateEligibility, normalizeCategoryId } from './eligibility.js';

/* -------------------------------------------------------------------------- */
/*  Records                                                                   */
/* -------------------------------------------------------------------------- */

export interface CatalogProduct {
  /** Internal surrogate id (stable for the lifetime of the catalog entry). */
  readonly internalId: string;
  /** Product id as provided by (or derived from) the feed. */
  readonly sourceProductId: string;
  readonly name: string;
  readonly marketplace: string;
  readonly productUrl: string;
  /** Published verbatim; never replaced by the plain product URL. */
  readonly affiliateUrl: string;
  /** False when the feed supplied no affiliate link and the URL is the plain product link. */
  readonly hasAffiliateLink: boolean;
  readonly productUrlNormalized: string;
  readonly category: string | null;
  readonly categoryId: string | null;
  readonly imageUrl: string | null;
  readonly description: string | null;
  readonly price: number | null;
  readonly currency: string | null;
  readonly commissionRate: number | null;
  readonly rating: number | null;
  readonly soldCount: number | null;
  readonly eligible: boolean;
  readonly eligibilityReasons: readonly string[];
  /** Last time ANY import touched this product (ISO-8601). */
  readonly lastImportedAt: string;
  /** Most recent import batch id that included this product. */
  readonly sourceImportId: string;
  /** Unrecognized source columns, preserved verbatim for traceability. */
  readonly extraColumns: Readonly<Record<string, unknown>>;
}

export interface CatalogCategory {
  readonly id: string;
  readonly name: string;
  readonly productCount: number;
  readonly eligibleProductCount: number;
}

export interface ImportBatchRecord {
  readonly id: string;
  readonly filename: string;
  readonly format: 'csv' | 'xlsx';
  readonly importedAt: string;
  readonly totalRows: number;
  readonly accepted: number;
  /** Rows accepted by the parser AND upserted as new catalog entries. */
  readonly newProducts: number;
  /** Rows that updated an existing catalog entry. */
  readonly updatedProducts: number;
  readonly rejected: number;
  readonly duplicatesRemoved: number;
  /** Rows skipped because an identical normalized product URL already existed. */
  readonly urlDuplicatesSkipped: number;
  readonly categoriesSeen: number;
  /** Per-row rejection reasons from the parser (capped upstream). */
  readonly issues: readonly FeedRowIssue[];
  readonly source: 'feed_import';
}

export interface CatalogSnapshot {
  readonly version: 1;
  readonly products: readonly CatalogProduct[];
  readonly batches: readonly ImportBatchRecord[];
  readonly updatedAt: string;
}

export interface CatalogListFilter {
  readonly categoryId?: string;
  readonly eligibleOnly?: boolean;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/* -------------------------------------------------------------------------- */
/*  Store                                                                     */
/* -------------------------------------------------------------------------- */

export interface CatalogStore {
  readonly kind: 'memory' | 'file';
  load(): Promise<CatalogSnapshot | null>;
  save(snapshot: CatalogSnapshot): Promise<void>;
}

export class InMemoryCatalogStore implements CatalogStore {
  readonly kind = 'memory' as const;
  private value: CatalogSnapshot | null = null;

  async load(): Promise<CatalogSnapshot | null> {
    return this.value;
  }

  async save(snapshot: CatalogSnapshot): Promise<void> {
    this.value = snapshot;
  }
}

/** Thrown when a persisted catalog file exists but cannot be trusted. */
export class CatalogStoreError extends AppError {
  constructor(message: string, cause?: unknown) {
    super({
      code: 'CATALOG_STORE_FAILED',
      category: 'configuration',
      message,
      expose: false,
      retryable: false,
      cause,
      context: {},
    });
  }
}

/** Atomic file store: temp-file write + rename, same pattern as the settings store. */
export class FileCatalogStore implements CatalogStore {
  readonly kind = 'file' as const;

  constructor(private readonly filePath: string) {}

  async load(): Promise<CatalogSnapshot | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new CatalogStoreError(`Could not read catalog file ${this.filePath}`, error);
    }
    try {
      const parsed = JSON.parse(raw) as CatalogSnapshot;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.products)) {
        return parsed;
      }
      throw new CatalogStoreError(`Catalog file ${this.filePath} has an unsupported shape`);
    } catch (error) {
      if (error instanceof CatalogStoreError) {
        throw error;
      }
      throw new CatalogStoreError(`Catalog file ${this.filePath} is not valid JSON`, error);
    }
  }

  async save(snapshot: CatalogSnapshot): Promise<void> {
    const dir = path.dirname(this.filePath);
    const tmp = `${this.filePath}.tmp`;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(tmp, `${JSON.stringify(snapshot)}\n`, 'utf8');
      await rename(tmp, this.filePath);
    } catch (error) {
      throw new CatalogStoreError(`Could not write catalog file ${this.filePath}`, error);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a product URL for dedupe purposes: lowercase host, drop the
 * scheme, drop query/fragment (Shopee URLs carry volatile tracking params) and
 * trailing slashes. Two feed rows pointing at the same item page normalize to
 * the same key even when their tracking parameters differ.
 */
export function normalizeProductUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host.toLowerCase()}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Canonical fields carried onto the catalog record. */
const KNOWN_FEED_FIELDS = new Set([
  'id',
  'name',
  'marketplace',
  'productUrl',
  'affiliateUrl',
  'price',
  'currency',
  'commissionRate',
  'imageUrl',
  'category',
  'rating',
  'soldCount',
]);

function extraColumnsOf(product: FeedProduct): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(product.raw ?? {})) {
    if (!KNOWN_FEED_FIELDS.has(key) && value !== undefined && value !== null && value !== '') {
      extra[key] = value;
    }
  }
  return extra;
}

/* -------------------------------------------------------------------------- */
/*  Service                                                                   */
/* -------------------------------------------------------------------------- */

export interface ImportFeedMeta {
  readonly filename: string;
  readonly format: 'csv' | 'xlsx';
  /** Optional externally-assigned batch id; generated when absent. */
  readonly sourceImportId?: string;
}

export class ProductCatalog {
  private products: CatalogProduct[] = [];
  private batches: ImportBatchRecord[] = [];
  private initialized = false;
  private loadWarning: string | null = null;

  constructor(private readonly store: CatalogStore = new InMemoryCatalogStore()) {}

  get storageKind(): 'memory' | 'file' {
    return this.store.kind;
  }

  /** Non-fatal load problem (e.g. an unreadable catalog file). */
  get warning(): string | null {
    return this.loadWarning;
  }

  /** Load persisted state once. Idempotent; never throws. */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    try {
      const loaded = await this.store.load();
      if (loaded) {
        this.products = [...loaded.products];
        this.batches = [...loaded.batches];
      }
    } catch (error) {
      this.loadWarning =
        error instanceof AppError ? error.message : 'Catalog could not be loaded; starting empty.';
      this.products = [];
      this.batches = [];
    }
  }

  /**
   * Upsert a parsed feed into the catalog.
   *
   * Idempotency: product identity is (sourceProductId, marketplace). A second
   * import of the same feed updates `lastImportedAt`/`sourceImportId` and any
   * changed fields, but creates no duplicates. Rows whose normalized product
   * URL already exists under a different id are skipped and reported.
   *
   * The catalog is only mutated after a successful parse — a parse error
   * (thrown by the importer) leaves the previous catalog fully intact.
   */
  async importFeed(result: FeedParseResult, meta: ImportFeedMeta): Promise<ImportBatchRecord> {
    await this.init();
    const now = new Date().toISOString();
    const batchId = meta.sourceImportId ?? randomUUID();

    const byIdentity = new Map<string, CatalogProduct>();
    const byUrl = new Map<string, CatalogProduct>();
    for (const product of this.products) {
      byIdentity.set(identityKey(product.sourceProductId, product.marketplace), product);
      if (!byUrl.has(product.productUrlNormalized)) {
        byUrl.set(product.productUrlNormalized, product);
      }
    }

    const nextProducts = [...this.products];
    let newProducts = 0;
    let updatedProducts = 0;
    let urlDuplicatesSkipped = 0;
    const categoryIds = new Set<string>();

    for (const feedProduct of result.products) {
      const identity = identityKey(feedProduct.id, feedProduct.marketplace);
      const normalizedUrl = normalizeProductUrl(feedProduct.productUrl);
      const existing = byIdentity.get(identity);

      const eligibility = evaluateEligibility({
        name: feedProduct.name,
        productUrl: feedProduct.productUrl,
        affiliateUrl: feedProduct.affiliateUrl,
        // The importer falls back to the plain product URL; the catalog must
        // know whether a REAL affiliate link was supplied.
        hasAffiliateLink: hasExplicitAffiliateLink(feedProduct),
      });

      const categoryId =
        feedProduct.category && feedProduct.category.trim().length > 0
          ? normalizeCategoryId(feedProduct.category)
          : null;
      if (categoryId) {
        categoryIds.add(categoryId);
      }

      if (existing) {
        const merged: CatalogProduct = {
          ...existing,
          name: feedProduct.name,
          productUrl: feedProduct.productUrl,
          affiliateUrl: feedProduct.affiliateUrl,
          hasAffiliateLink: hasExplicitAffiliateLink(feedProduct),
          productUrlNormalized: normalizedUrl,
          category: feedProduct.category,
          categoryId,
          imageUrl: feedProduct.imageUrl,
          // description is not part of the current feed contract; keep whatever
          // an earlier (richer) import provided rather than erasing it.
          description: existing.description,
          price: feedProduct.price,
          currency: feedProduct.currency,
          commissionRate: feedProduct.commissionRate,
          rating: feedProduct.rating,
          soldCount: feedProduct.soldCount,
          eligible: eligibility.eligible,
          eligibilityReasons: eligibility.reasons,
          lastImportedAt: now,
          sourceImportId: batchId,
          extraColumns: extraColumnsOf(feedProduct),
        };
        const index = nextProducts.findIndex((p) => p.internalId === existing.internalId);
        if (index >= 0) {
          nextProducts[index] = merged;
        }
        byIdentity.set(identity, merged);
        updatedProducts += 1;
        continue;
      }

      const urlExisting = byUrl.get(normalizedUrl);
      if (urlExisting) {
        // Same destination page under a different source id — treat as a
        // duplicate rather than a distinct catalog entry.
        urlDuplicatesSkipped += 1;
        const index = nextProducts.findIndex((p) => p.internalId === urlExisting.internalId);
        if (index >= 0) {
          nextProducts[index] = { ...urlExisting, lastImportedAt: now, sourceImportId: batchId };
        }
        continue;
      }

      const created: CatalogProduct = {
        internalId: randomUUID(),
        sourceProductId: feedProduct.id,
        name: feedProduct.name,
        marketplace: feedProduct.marketplace,
        productUrl: feedProduct.productUrl,
        affiliateUrl: feedProduct.affiliateUrl,
        hasAffiliateLink: hasExplicitAffiliateLink(feedProduct),
        productUrlNormalized: normalizedUrl,
        category: feedProduct.category,
        categoryId,
        imageUrl: feedProduct.imageUrl,
        description: null,
        price: feedProduct.price,
        currency: feedProduct.currency,
        commissionRate: feedProduct.commissionRate,
        rating: feedProduct.rating,
        soldCount: feedProduct.soldCount,
        eligible: eligibility.eligible,
        eligibilityReasons: eligibility.reasons,
        lastImportedAt: now,
        sourceImportId: batchId,
        extraColumns: extraColumnsOf(feedProduct),
      };
      nextProducts.push(created);
      byIdentity.set(identity, created);
      byUrl.set(normalizedUrl, created);
      newProducts += 1;
    }

    const batch: ImportBatchRecord = {
      id: batchId,
      filename: meta.filename,
      format: meta.format,
      importedAt: now,
      totalRows: result.summary.totalRows,
      accepted: result.summary.accepted,
      newProducts,
      updatedProducts,
      rejected: result.summary.rejected,
      duplicatesRemoved: result.summary.duplicatesRemoved,
      urlDuplicatesSkipped,
      categoriesSeen: categoryIds.size,
      issues: result.summary.issues,
      source: 'feed_import',
    };

    this.products = nextProducts;
    this.batches = [batch, ...this.batches].slice(0, 50);
    await this.persist();
    return batch;
  }

  list(filter: CatalogListFilter = {}): readonly CatalogProduct[] {
    let items = [...this.products];
    if (filter.categoryId) {
      items = items.filter((p) => p.categoryId === filter.categoryId);
    }
    if (filter.eligibleOnly) {
      items = items.filter((p) => p.eligible);
    }
    if (filter.search && filter.search.trim().length > 0) {
      const needle = filter.search.trim().toLowerCase();
      items = items.filter((p) => p.name.toLowerCase().includes(needle));
    }
    const offset = Math.max(0, filter.offset ?? 0);
    const limit = Math.min(Math.max(1, filter.limit ?? 50), 500);
    return items.slice(offset, offset + limit);
  }

  count(filter: Pick<CatalogListFilter, 'categoryId' | 'eligibleOnly'> = {}): number {
    return this.products.filter((p) => {
      if (filter.categoryId && p.categoryId !== filter.categoryId) return false;
      if (filter.eligibleOnly && !p.eligible) return false;
      return true;
    }).length;
  }

  total(): number {
    return this.products.length;
  }

  get(internalId: string): CatalogProduct | null {
    return this.products.find((p) => p.internalId === internalId) ?? null;
  }

  /** Distinct categories derived from the ACTUAL catalog, sorted by size. */
  categories(): CatalogCategory[] {
    const groups = new Map<string, { name: string; total: number; eligible: number }>();
    for (const product of this.products) {
      const id = product.categoryId ?? 'uncategorized';
      const entry = groups.get(id) ?? { name: product.category ?? 'Uncategorized', total: 0, eligible: 0 };
      entry.total += 1;
      if (product.eligible) {
        entry.eligible += 1;
      }
      groups.set(id, entry);
    }
    return [...groups.entries()]
      .map(([id, entry]) => ({
        id,
        name: entry.name,
        productCount: entry.total,
        eligibleProductCount: entry.eligible,
      }))
      .sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name));
  }

  recentBatches(limit = 10): readonly ImportBatchRecord[] {
    return this.batches.slice(0, Math.min(Math.max(1, limit), 50));
  }

  private async persist(): Promise<void> {
    await this.store.save({
      version: 1,
      products: this.products,
      batches: this.batches,
      updatedAt: new Date().toISOString(),
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Internals                                                                 */
/* -------------------------------------------------------------------------- */

function identityKey(sourceProductId: string, marketplace: string): string {
  return `${marketplace}::${sourceProductId}`;
}

/**
 * Did the FEED supply an affiliate link for this row (as opposed to the
 * importer's product-URL fallback)? The importer keeps canonical cells in
 * `raw`, so an empty/absent affiliateUrl cell means "no link provided".
 */
function hasExplicitAffiliateLink(product: FeedProduct): boolean {
  const cell = product.raw?.['affiliateUrl'];
  return typeof cell === 'string' && cell.trim().length > 0;
}
