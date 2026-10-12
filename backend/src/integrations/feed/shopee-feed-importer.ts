/**
 * Shopee Affiliate Product Feed parser.
 *
 * Part 1 supports USER-PROVIDED CSV and XLSX exports only. No live Shopee API is
 * assumed — see docs/implementation/part-01-integration-feasibility.md.
 *
 * The parser is deliberately schema-tolerant: real affiliate exports vary by
 * marketplace, locale and export date. Instead of inventing a fixed column list,
 * we:
 *   1. normalize every header (trim, lowercase, collapse separators),
 *   2. resolve each canonical field against a list of accepted aliases,
 *   3. reject rows missing the minimum viable fields,
 *   4. deduplicate by canonical product id (first occurrence wins).
 *
 * Nothing here throws on malformed rows; problems are reported per-row so a
 * single bad line cannot abort an import.
 */
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { ShopeeFeedError } from '../../core/errors.js';
import type {
  FeedParseRequest,
  FeedParseResult,
  FeedProduct,
  FeedRowIssue,
  ProductFeedImporter,
  ProviderInfo,
} from '../../contracts/index.js';

/* -------------------------------------------------------------------------- */
/*  Canonical fields & aliases                                                */
/* -------------------------------------------------------------------------- */

/** Canonical field -> accepted source header aliases (already normalized). */
const FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  id: ['id', 'itemid', 'productid', 'productidstr', 'itemidstr', 'shopeeproductid', 'sku'],
  name: ['name', 'productname', 'itemname', 'title', 'producttitle', 'namaproduct'],
  marketplace: ['marketplace', 'site', 'country', 'region', 'domain', 'shopeesite'],
  productUrl: [
    'producturl',
    'itemurl',
    'url',
    'link',
    'productlink',
    'itemlink',
    'shalink',
    'deeplink',
  ],
  affiliateUrl: [
    'affiliateurl',
    'affiliatelink',
    'afflink',
    'shopeeaffiliatelink',
    'customlink',
    'trackinglink',
    'deeplinkaffiliate',
  ],
  price: ['price', 'saleprice', 'itemprice', 'productprice', 'harga', 'lowestprice', 'pricebefore Discount'.toLowerCase()],
  currency: ['currency', 'cur', 'matauang', 'pricecurrency'],
  commissionRate: [
    'commissionrate',
    'commission',
    'commissionpct',
    'commissionpercent',
    'komisi',
    'komisirate',
    'ratemission',
  ],
  imageUrl: ['imageurl', 'image', 'img', 'imgurl', 'productimage', 'thumbnail', 'cover', 'gambar'],
  category: ['category', 'categoryname', 'catid', 'subcategory', 'kategori'],
  rating: ['rating', 'averagerating', 'stars', 'reviewrating', 'scorereview'],
  soldCount: ['soldcount', 'sold', 'sales', 'quantities Sold'.toLowerCase(), 'terjual', 'soldcountstr'],
};

/** A row must resolve at least these canonical fields to be accepted. */
const REQUIRED_FIELDS = ['id', 'name', 'productUrl'] as const;

/** Extra fields that make a product publishable. Missing ones are warnings. */
const RECOMMENDED_FIELDS = ['imageUrl', 'affiliateUrl'] as const;

/* -------------------------------------------------------------------------- */
/*  Header normalization                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a header cell: lowercase, strip non-alphanumerics, collapse runs.
 * "Product URL" -> "producturl", "Item ID " -> "itemid".
 */
export function normalizeHeader(header: string): string {
  return String(header ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/** Reverse lookup: normalized header -> canonical field name (or null). */
export function resolveField(normalizedHeader: string): string | null {
  if (!normalizedHeader) {
    return null;
  }
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.includes(normalizedHeader)) {
      return canonical;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Row parsing helpers                                                        */
/* -------------------------------------------------------------------------- */

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = String(value).trim();
  if (raw === '') {
    return null;
  }
  // Strip currency symbols, spaces and anything that is not a digit, dot, comma
  // or minus sign.
  let cleaned = raw.replace(/[^\d.,-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') {
    return null;
  }

  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');

  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: the RIGHTMOST separator is the decimal mark, the other is a
    // thousands separator. e.g. "1.234,56" (ID/EU) or "1,234.56" (US/UK).
    if (lastComma > lastDot) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (lastDot !== -1) {
    // Only dots. Treat as thousands separators when they group in 3s
    // (e.g. "1.250.000"), otherwise as a decimal point (e.g. "12.5").
    cleaned = /^\d{1,3}(\.\d{3})+$/.test(cleaned) ? cleaned.replace(/\./g, '') : cleaned;
  } else if (lastComma !== -1) {
    // Only commas: same grouping logic.
    cleaned = /^\d{1,3}(,\d{3})+$/.test(cleaned) ? cleaned.replace(/,/g, '') : cleaned.replace(',', '.');
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

/** Derive a stable, collision-resistant id when the feed omits one. */
function deriveId(name: string, productUrl: string): string | null {
  const basis = `${name}|${productUrl}`.toLowerCase();
  if (!name && !productUrl) {
    return null;
  }
  // FNV-1a 32-bit — deterministic, dependency-free, good enough for dedup.
  let hash = 0x811c9dc5;
  for (let i = 0; i < basis.length; i += 1) {
    hash ^= basis.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `auto_${hash.toString(16).padStart(8, '0')}`;
}

interface RawRow {
  readonly rowNumber: number;
  readonly cells: Record<string, unknown>;
}

/**
 * Convert a source row into a FeedProduct, or return a rejection reason.
 */
function buildProduct(
  row: RawRow,
  fieldMap: ReadonlyMap<number, string>,
  headers: readonly string[],
  defaultMarketplace: string,
): { product: FeedProduct } | { issue: FeedRowIssue } {
  const cells: Record<string, unknown> = {};
  for (const [index, canonical] of fieldMap.entries()) {
    const header = headers[index];
    cells[canonical] = header === undefined ? undefined : row.cells[header];
  }

  // Preserve UNKNOWN source columns verbatim under their original header name,
  // so a richer Shopee export never loses data we do not yet understand. The
  // catalog stores them as `extraColumns` (never used to infer facts).
  const mappedIndexes = new Set(fieldMap.keys());
  const extraCells: Record<string, unknown> = {};
  headers.forEach((header, index) => {
    if (!mappedIndexes.has(index) && header && header.trim().length > 0) {
      extraCells[header] = row.cells[header];
    }
  });

  const name = toText(cells['name']);
  const productUrl = toText(cells['productUrl']);
  const explicitId = toText(cells['id']);

  // Minimum viability check.
  for (const field of REQUIRED_FIELDS) {
    if (field === 'id') {
      continue; // id may be derived
    }
    if (!cells[field]) {
      return {
        issue: {
          rowNumber: row.rowNumber,
          field,
          reason: `Missing required field "${field}"`,
        },
      };
    }
  }

  const id = explicitId || deriveId(name, productUrl);
  if (!id) {
    return {
      issue: {
        rowNumber: row.rowNumber,
        field: 'id',
        reason: 'Could not derive a product id',
      },
    };
  }

  const affiliateUrl = toText(cells['affiliateUrl']);
  const marketplace = toText(cells['marketplace']) || defaultMarketplace;

  const product: FeedProduct = {
    id,
    name,
    marketplace,
    productUrl,
    // Contract: fall back to the canonical product URL when no affiliate link
    // is supplied, so downstream publishers always have a valid destination.
    affiliateUrl: affiliateUrl || productUrl,
    price: toNumber(cells['price']),
    currency: toText(cells['currency']) || null,
    commissionRate: toNumber(cells['commissionRate']),
    imageUrl: toText(cells['imageUrl']) || null,
    category: toText(cells['category']) || null,
    rating: toNumber(cells['rating']),
    soldCount: toNumber(cells['soldCount']),
    raw: { ...cells, ...extraCells },
  };

  return { product };
}

/* -------------------------------------------------------------------------- */
/*  CSV implementation                                                         */
/* -------------------------------------------------------------------------- */

function parseCsv(
  content: Uint8Array,
  defaultMarketplace: string,
): FeedParseResult {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(content);
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });

  if (parsed.errors.length > 0 && parsed.data.length === 0) {
    throw new ShopeeFeedError('CSV parsing produced no rows', {
      service: 'shopee_feed',
      operation: 'parse_csv',
      upstreamStatus: 422,
      upstreamCode: 'CSV_MALFORMED',
    });
  }

  const headers = parsed.meta.fields ?? [];
  return finalize(parsed.data, headers, parsed.errors.length, defaultMarketplace, 'csv');
}

/* -------------------------------------------------------------------------- */
/*  XLSX implementation                                                        */
/* -------------------------------------------------------------------------- */

function parseXlsx(
  content: Uint8Array,
  defaultMarketplace: string,
): FeedParseResult {
  let workbook: XLSX.WorkBook;
  try {
    // Copy into a plain Buffer — SheetJS mutates its input in some paths.
    workbook = XLSX.read(Buffer.from(content), { type: 'buffer', cellDates: false });
  } catch (cause) {
    throw new ShopeeFeedError('XLSX workbook could not be read', {
      service: 'shopee_feed',
      operation: 'parse_xlsx',
      upstreamStatus: 422,
      upstreamCode: 'XLSX_UNREADABLE',
    }, { cause });
  }

  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) {
    throw new ShopeeFeedError('XLSX workbook contains no sheets', {
      service: 'shopee_feed',
      operation: 'parse_xlsx',
      upstreamStatus: 422,
      upstreamCode: 'XLSX_EMPTY',
    });
  }

  const sheet = workbook.Sheets[firstSheet];
  if (!sheet) {
    throw new ShopeeFeedError('XLSX first sheet is unreadable', {
      service: 'shopee_feed',
      operation: 'parse_xlsx',
      upstreamStatus: 422,
      upstreamCode: 'XLSX_EMPTY_SHEET',
    });
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: false,
  });

  const headerRow = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })[0] ?? [];
  const headers = headerRow.map((h) => String(h ?? '').trim());

  return finalize(rows, headers, 0, defaultMarketplace, 'xlsx');
}

/* -------------------------------------------------------------------------- */
/*  Shared finalization: map -> validate -> dedupe                            */
/* -------------------------------------------------------------------------- */

/** Cap on retained per-row issues so a huge broken file cannot blow up logs. */
const MAX_ISSUES = 100;

function finalize(
  rows: readonly Record<string, unknown>[],
  headers: readonly string[],
  parseErrorCount: number,
  defaultMarketplace: string,
  format: 'csv' | 'xlsx',
): FeedParseResult {
  const issues: FeedRowIssue[] = [];

  // Build canonical field map from headers.
  const fieldMap = new Map<number, string>();
  const unmappedHeaders: string[] = [];
  headers.forEach((header, index) => {
    const canonical = resolveField(normalizeHeader(header));
    if (canonical && !fieldMapHasCanonical(fieldMap, canonical)) {
      fieldMap.set(index, canonical);
    } else if (!canonical) {
      unmappedHeaders.push(header);
    }
  });

  if (fieldMap.size === 0) {
    throw new ShopeeFeedError(
      'Feed contains no recognizable columns. Expected headers matching: ' +
        Object.keys(FIELD_ALIASES).join(', '),
      {
        service: 'shopee_feed',
        operation: 'parse',
        upstreamStatus: 422,
        upstreamCode: 'FEED_NO_RECOGNIZED_COLUMNS',
        totalHeaders: headers.length,
        sampleHeaders: headers.slice(0, 20),
      },
    );
  }

  if (issues.length < MAX_ISSUES && unmappedHeaders.length > 0) {
    issues.push({
      rowNumber: 0,
      reason: `${unmappedHeaders.length} column(s) ignored (no known alias): ${unmappedHeaders.slice(0, 10).join(', ')}`,
    });
  }

  // Surface a warning when recommended (not required) fields are absent, since
  // missing imageUrl/affiliateUrl degrade publish quality.
  const mappedCanonicals = new Set(fieldMap.values());
  for (const recommended of RECOMMENDED_FIELDS) {
    if (!mappedCanonicals.has(recommended)) {
      issues.push({
        rowNumber: 0,
        field: recommended,
        reason: `Recommended column "${recommended}" not found; affected products will fall back to defaults.`,
      });
    }
  }

  const seen = new Set<string>();
  const products: FeedProduct[] = [];
  let duplicatesRemoved = 0;
  let rejected = 0;

  rows.forEach((cells, index) => {
    const rowNumber = index + 2; // +2: 1-based, plus header row

    // Skip fully empty rows silently.
    const hasAnyValue = Object.values(cells).some((v) => toText(v) !== '');
    if (!hasAnyValue) {
      return;
    }

    const outcome = buildProduct({ rowNumber, cells }, fieldMap, headers, defaultMarketplace);

    if ('issue' in outcome) {
      rejected += 1;
      if (issues.length < MAX_ISSUES) {
        issues.push(outcome.issue);
      }
      return;
    }

    if (seen.has(outcome.product.id)) {
      duplicatesRemoved += 1;
      return;
    }
    seen.add(outcome.product.id);
    products.push(outcome.product);
  });

  if (parseErrorCount > 0) {
    issues.push({
      rowNumber: 0,
      reason: `Parser reported ${parseErrorCount} structural warning(s); rows were still processed.`,
    });
  }

  const summary = {
    totalRows: rows.length,
    accepted: products.length,
    rejected,
    duplicatesRemoved,
    format,
    issues,
  };

  return { products, summary };
}

function fieldMapHasCanonical(map: ReadonlyMap<number, string>, canonical: string): boolean {
  for (const value of map.values()) {
    if (value === canonical) {
      return true;
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Format detection                                                           */
/* -------------------------------------------------------------------------- */

/** XLSX files are ZIP archives; they begin with the "PK\x03\x04" magic bytes. */
const XLSX_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function detectFormat(
  filename: string,
  content: Uint8Array,
): 'csv' | 'xlsx' {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    return 'xlsx';
  }
  if (lower.endsWith('.csv')) {
    return 'csv';
  }
  // Fall back to magic-byte sniffing.
  const looksLikeZip = XLSX_MAGIC.every((byte, i) => content[i] === byte);
  return looksLikeZip ? 'xlsx' : 'csv';
}

/* -------------------------------------------------------------------------- */
/*  Concrete importer                                                         */
/* -------------------------------------------------------------------------- */

export class ShopeeFeedCsvImporter implements ProductFeedImporter {
  readonly info: ProviderInfo = {
    name: 'shopee_feed_upload',
    kind: 'live',
    ready: true,
    detail:
      'Parses user-provided Shopee Affiliate CSV/XLSX exports. Live Shopee API is NOT assumed in Part 1.',
  };

  async parse(request: FeedParseRequest): Promise<FeedParseResult> {
    if (!request.content || request.content.byteLength === 0) {
      throw new ShopeeFeedError('Feed file is empty', {
        service: 'shopee_feed',
        operation: 'parse',
        upstreamStatus: 422,
        upstreamCode: 'FEED_EMPTY_FILE',
      });
    }

    const format = request.format ?? detectFormat(request.filename, request.content);
    const defaultMarketplace = request.defaultMarketplace ?? 'shopee.co.id';

    if (format === 'xlsx') {
      return parseXlsx(request.content, defaultMarketplace);
    }
    return parseCsv(request.content, defaultMarketplace);
  }
}
