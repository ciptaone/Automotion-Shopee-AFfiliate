/**
 * PART 3 — persistent product catalog.
 *
 * Covers: CSV/XLSX import through the real parser, malformed-row rejection,
 * import idempotency, affiliate-URL preservation and eligibility, unknown
 * source column retention, category derivation, and the rule that a FAILED
 * import never destroys a previously valid catalog.
 *
 * Credential-free: only the in-memory catalog store and the real feed parser
 * are used; no network, no database.
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  FileCatalogStore,
  InMemoryCatalogStore,
  ProductCatalog,
  normalizeProductUrl,
} from '../../src/catalog/catalog.js';
import {
  evaluateEligibility,
  normalizeCategoryId,
} from '../../src/catalog/eligibility.js';
import { ShopeeFeedCsvImporter } from '../../src/integrations/feed/shopee-feed-importer.js';
import { ShopeeFeedError } from '../../src/core/errors.js';
import type { ImportBatchRecord } from '../../src/catalog/catalog.js';

const importer = new ShopeeFeedCsvImporter();

function csv(rows: string[][]): Uint8Array {
  return new TextEncoder().encode(rows.map((r) => r.join(',')).join('\n'));
}

const VALID_HEADERS = [
  'Item ID',
  'Name',
  'Product URL',
  'Affiliate Link',
  'Image URL',
  'Category',
  'Price',
  'Commission Rate',
  'Rating',
  'Sold',
];

const ROW_A = [
  '1001',
  'Serum Vitamin C',
  'https://shopee.co.id/product/1001',
  'https://s.shopee.co.id/aff-1001',
  'https://cf.shopee.co.id/img/1001.jpg',
  'Health & Beauty',
  '120000',
  '10',
  '4.8',
  '900',
];

const ROW_B = [
  '1002',
  'Tumbler Stainless',
  'https://shopee.co.id/product/1002',
  'https://s.shopee.co.id/aff-1002',
  'https://cf.shopee.co.id/img/1002.jpg',
  'Home & Living',
  '85000',
  '5',
  '4.9',
  '1200',
];

async function importCsv(
  catalog: ProductCatalog,
  rows: string[][],
  filename = 'feed.csv',
): Promise<ImportBatchRecord> {
  const parsed = await importer.parse({ filename, content: csv(rows) });
  return catalog.importFeed(parsed, { filename, format: parsed.summary.format });
}

/* ========================================================================== */
/*  Eligibility + category identity                                           */
/* ========================================================================== */

describe('evaluateEligibility', () => {
  const base = {
    name: 'Serum Vitamin C',
    productUrl: 'https://shopee.co.id/product/1',
    affiliateUrl: 'https://s.shopee.co.id/aff-1',
    hasAffiliateLink: true,
  };

  it('accepts a product with a real affiliate link', () => {
    expect(evaluateEligibility(base)).toEqual({ eligible: true, reasons: [] });
  });

  it('rejects a plain product URL that is not an affiliate link', () => {
    const result = evaluateEligibility({ ...base, hasAffiliateLink: false });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('missing_affiliate_link');
  });

  it('rejects a missing name', () => {
    const result = evaluateEligibility({ ...base, name: '   ' });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('missing_name');
  });

  it('rejects non-http URLs', () => {
    const result = evaluateEligibility({ ...base, affiliateUrl: 'not-a-url' });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('invalid_affiliate_url');
  });
});

describe('normalizeCategoryId', () => {
  it('produces stable slugs from display names', () => {
    expect(normalizeCategoryId('Health & Beauty')).toBe('health-beauty');
    expect(normalizeCategoryId('Health & Beauty')).toBe(normalizeCategoryId('health  &   beauty'));
  });

  it('never returns an empty id', () => {
    expect(normalizeCategoryId('   ')).toBe('uncategorized');
  });
});

describe('normalizeProductUrl', () => {
  it('drops tracking params so volatile links collapse to one key', () => {
    const a = normalizeProductUrl('https://shopee.co.id/product/1?spid=abc&utm=x');
    const b = normalizeProductUrl('https://shopee.co.id/product/1?spid=zzz');
    expect(a).toBe(b);
  });
});

/* ========================================================================== */
/*  Import: CSV / XLSX / malformed rows                                       */
/* ========================================================================== */

describe('ProductCatalog.importFeed', () => {
  it('imports a valid CSV feed and computes eligibility', async () => {
    const catalog = new ProductCatalog(new InMemoryCatalogStore());
    const batch = await importCsv(catalog, [VALID_HEADERS, ROW_A, ROW_B]);

    expect(batch.newProducts).toBe(2);
    expect(batch.rejected).toBe(0);
    expect(catalog.total()).toBe(2);
    expect(catalog.count({ eligibleOnly: true })).toBe(2);
    expect(batch.source).toBe('feed_import');
    expect(batch.format).toBe('csv');
  });

  it('imports an XLSX feed', async () => {
    const sheet = XLSX.utils.json_to_sheet([
      Object.fromEntries(VALID_HEADERS.map((h, i) => [h, ROW_A[i]])),
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Feed');
    const bytes = new Uint8Array(
      XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
    );

    const catalog = new ProductCatalog(new InMemoryCatalogStore());
    const parsed = await importer.parse({ filename: 'feed.xlsx', content: bytes });
    const batch = await catalog.importFeed(parsed, { filename: 'feed.xlsx', format: 'xlsx' });

    expect(parsed.summary.format).toBe('xlsx');
    expect(batch.newProducts).toBe(1);
    expect(catalog.total()).toBe(1);
  });

  it('rejects malformed rows and keeps the valid ones, reporting reasons', async () => {
    const catalog = new ProductCatalog(new InMemoryCatalogStore());
    const missingUrl = ['1003', 'Broken Row', '', 'https://s.shopee.co.id/aff-1003', '', '', '', '', '', ''];
    const batch = await importCsv(catalog, [VALID_HEADERS, ROW_A, missingUrl]);

    expect(catalog.total()).toBe(1);
    expect(batch.rejected).toBe(1);
    const issue = batch.issues.find((i) => i.field === 'productUrl');
    expect(issue).toBeDefined();
    expect(issue?.reason).toMatch(/productUrl/i);
    expect(issue?.rowNumber).toBe(3);
  });

  it('throws on a feed with no recognizable columns', async () => {
    await expect(
      importer.parse({ filename: 'bad.csv', content: csv([['a', 'b'], ['1', '2']]) }),
    ).rejects.toBeInstanceOf(ShopeeFeedError);
  });

  it('preserves the affiliate URL verbatim (never swapped for the product URL)', async () => {
    const catalog = new ProductCatalog(new InMemoryCatalogStore());
    await importCsv(catalog, [VALID_HEADERS, ROW_A]);
    const [product] = catalog.list();

    expect(product?.affiliateUrl).toBe('https://s.shopee.co.id/aff-1001');
    expect(product?.productUrl).toBe('https://shopee.co.id/product/1001');
    expect(product?.affiliateUrl).not.toBe(product?.productUrl);
    expect(product?.hasAffiliateLink).toBe(true);
  });

  it('marks a row without an affiliate link ineligible instead of pretending it has one', async () => {
    const headers = VALID_HEADERS.filter((h) => h !== 'Affiliate Link');
    const row = ROW_A.filter((_, i) => VALID_HEADERS[i] !== 'Affiliate Link');
    const catalog = new ProductCatalog(new InMemoryCatalogStore());
    await importCsv(catalog, [headers, row]);

    const [product] = catalog.list();
    expect(product?.hasAffiliateLink).toBe(false);
    expect(product?.eligible).toBe(false);
    expect(product?.eligibilityReasons).toContain('missing_affiliate_link');
    // The fallback still records a usable destination URL, just not a tracked one.
    expect(product?.affiliateUrl).toBe('https://shopee.co.id/product/1001');
  });

  it('preserves unknown source columns for traceability', async () => {
    const headers = [...VALID_HEADERS, 'Seller Name'];
    const row = [...ROW_A, 'Toko Maju Jaya'];
    const catalog = new ProductCatalog(new InMemoryCatalogStore());
    await importCsv(catalog, [headers, row]);

    const [product] = catalog.list();
    expect(product?.extraColumns).toHaveProperty('Seller Name', 'Toko Maju Jaya');
    // Known canonical fields are NOT duplicated into extraColumns.
    expect(product?.extraColumns).not.toHaveProperty('name');
  });
});

/* ========================================================================== */
/*  Idempotency + safety                                                      */
/* ========================================================================== */

describe('ProductCatalog idempotency and safety', () => {
  it('re-importing the same feed does not duplicate products', async () => {
    const catalog = new ProductCatalog(new InMemoryCatalogStore());
    await importCsv(catalog, [VALID_HEADERS, ROW_A, ROW_B]);
    const second = await importCsv(catalog, [VALID_HEADERS, ROW_A, ROW_B]);

    expect(catalog.total()).toBe(2);
    expect(second.newProducts).toBe(0);
    expect(second.updatedProducts).toBe(2);
    expect(second.urlDuplicatesSkipped).toBe(0);
  });

  it('treats a different id pointing at the same URL as a duplicate', async () => {
    const catalog = new ProductCatalog(new InMemoryCatalogStore());
    await importCsv(catalog, [VALID_HEADERS, ROW_A]);
    const dupe = [...ROW_A];
    dupe[0] = '9999'; // new id, same destination URL
    const batch = await importCsv(catalog, [VALID_HEADERS, dupe]);

    expect(catalog.total()).toBe(1);
    expect(batch.urlDuplicatesSkipped).toBe(1);
    expect(batch.newProducts).toBe(0);
  });

  it('a FAILED import leaves the previously valid catalog intact', async () => {
    const catalog = new ProductCatalog(new InMemoryCatalogStore());
    await importCsv(catalog, [VALID_HEADERS, ROW_A, ROW_B]);
    expect(catalog.total()).toBe(2);

    // A feed with no recognizable columns throws before any mutation.
    await expect(
      importer.parse({ filename: 'garbage.csv', content: csv([['x'], ['y']]) }),
    ).rejects.toBeInstanceOf(ShopeeFeedError);

    expect(catalog.total()).toBe(2);
    expect(catalog.count({ eligibleOnly: true })).toBe(2);
  });

  it('stamps re-imported products with the new batch id and import time', async () => {
    const catalog = new ProductCatalog(new InMemoryCatalogStore());
    await importCsv(catalog, [VALID_HEADERS, ROW_A]);
    const first = catalog.list()[0];

    await new Promise((resolve) => setTimeout(resolve, 5));
    const batch = await importCsv(catalog, [VALID_HEADERS, ROW_A], 'feed-2.csv');
    const second = catalog.list()[0];

    expect(second?.internalId).toBe(first?.internalId); // identity is stable
    expect(second?.sourceImportId).toBe(batch.id);
    expect((second?.lastImportedAt ?? '') >= (first?.lastImportedAt ?? '')).toBe(true);
    expect(catalog.recentBatches(5)).toHaveLength(2);
  });
});

/* ========================================================================== */
/*  Categories                                                                */
/* ========================================================================== */

describe('ProductCatalog.categories', () => {
  it('derives categories from the ACTUAL catalog with counts', async () => {
    const catalog = new ProductCatalog(new InMemoryCatalogStore());
    await importCsv(catalog, [VALID_HEADERS, ROW_A, ROW_B]);

    const categories = catalog.categories();
    expect(categories.map((c) => c.id).sort()).toEqual([
      'health-beauty',
      'home-living',
    ]);
    const health = categories.find((c) => c.id === 'health-beauty');
    expect(health?.name).toBe('Health & Beauty');
    expect(health?.productCount).toBe(1);
    expect(health?.eligibleProductCount).toBe(1);
  });

  it('separates eligible from ineligible counts inside one category', async () => {
    // Same category, but the second product's affiliate cell is empty: the
    // catalog must count it in the category while excluding it from eligible.
    const noLink = [
      '1004',
      'Pillow Mist Aromaterapi',
      'https://shopee.co.id/product/1004',
      '',
      'https://cf.shopee.co.id/img/1004.jpg',
      'Health & Beauty',
      '60000',
      '8',
      '4.7',
      '300',
    ];
    const catalog = new ProductCatalog(new InMemoryCatalogStore());
    await importCsv(catalog, [VALID_HEADERS, ROW_A, noLink]);

    const health = catalog.categories().find((c) => c.id === 'health-beauty');
    expect(health?.productCount).toBe(2);
    expect(health?.eligibleProductCount).toBe(1);
  });

  it('returns an empty list for an empty catalog', () => {
    const catalog = new ProductCatalog(new InMemoryCatalogStore());
    expect(catalog.categories()).toEqual([]);
    expect(catalog.total()).toBe(0);
  });
});

/* ========================================================================== */
/*  File persistence                                                          */
/* ========================================================================== */

describe('FileCatalogStore', () => {
  it('persists and reloads the catalog across instances', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-'));
    const file = path.join(dir, 'catalog.json');
    try {
      const first = new ProductCatalog(new FileCatalogStore(file));
      await importCsv(first, [VALID_HEADERS, ROW_A, ROW_B]);
      expect(first.storageKind).toBe('file');

      const second = new ProductCatalog(new FileCatalogStore(file));
      await second.init();
      expect(second.total()).toBe(2);
      expect(second.warning).toBeNull();
      expect(second.categories()).toHaveLength(2);
      expect(second.recentBatches(5)).toHaveLength(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a warning instead of crashing when the file is corrupt', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-corrupt-'));
    const file = path.join(dir, 'catalog.json');
    try {
      await fs.writeFile(file, '{not json', 'utf8');
      const catalog = new ProductCatalog(new FileCatalogStore(file));
      await catalog.init();
      expect(catalog.warning).toMatch(/catalog/i);
      expect(catalog.total()).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
