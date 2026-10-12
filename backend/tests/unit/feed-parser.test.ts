import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  ShopeeFeedCsvImporter,
  normalizeHeader,
  resolveField,
  detectFormat,
} from '../../src/integrations/feed/shopee-feed-importer.js';
import { ShopeeFeedError } from '../../src/core/errors.js';
import type { FeedProduct, FeedRowIssue } from '../../src/contracts/index.js';

const importer = new ShopeeFeedCsvImporter();

function toCsv(rows: string[][]): Uint8Array {
  return new TextEncoder().encode(rows.map((r) => r.join(',')).join('\n'));
}

function toCsvQuoted(rows: Record<string, string>[]): Uint8Array {
  const headers = Object.keys(rows[0] ?? {});
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(','));
  }
  return new TextEncoder().encode(lines.join('\n'));
}

function toXlsx(rows: Record<string, unknown>[]): Uint8Array {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Feed');
  const buf = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return new Uint8Array(buf);
}

/* -------------------------------------------------------------------------- */
/*  Header normalization                                                       */
/* -------------------------------------------------------------------------- */

describe('normalizeHeader / resolveField', () => {
  it('normalizes spaced and cased headers', () => {
    expect(normalizeHeader('Product URL')).toBe('producturl');
    expect(normalizeHeader('Item ID ')).toBe('itemid');
    expect(normalizeHeader('Commission Rate')).toBe('commissionrate');
  });

  it('resolves known aliases to canonical fields', () => {
    expect(resolveField('producturl')).toBe('productUrl');
    expect(resolveField('itemid')).toBe('id');
    expect(resolveField('name')).toBe('name');
    expect(resolveField('imageurl')).toBe('imageUrl');
    expect(resolveField('affiliateurl')).toBe('affiliateUrl');
  });

  it('returns null for unknown headers', () => {
    expect(resolveField('totallyunrelatedcolumn')).toBeNull();
    expect(resolveField('')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  Format detection                                                           */
/* -------------------------------------------------------------------------- */

describe('detectFormat', () => {
  it('detects csv by extension', () => {
    expect(detectFormat('feed.csv', new Uint8Array([65]))).toBe('csv');
  });

  it('detects xlsx by extension', () => {
    expect(detectFormat('feed.xlsx', new Uint8Array([65]))).toBe('xlsx');
  });

  it('falls back to PK magic bytes for unknown extensions', () => {
    expect(detectFormat('feed.dat', new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('xlsx');
    expect(detectFormat('feed.dat', new TextEncoder().encode('a,b,c'))).toBe('csv');
  });
});

/* -------------------------------------------------------------------------- */
/*  CSV parsing                                                                */
/* -------------------------------------------------------------------------- */

describe('CSV feed parsing', () => {
  it('parses a well-formed feed', async () => {
    const csv = toCsv([
      ['Item ID', 'Name', 'Product URL', 'Affiliate URL', 'Price', 'Image URL', 'Category'],
      ['101', 'Tumbler Stainless', 'https://s.co.id/p/101', 'https://s.shopee.co.id/aff101', '150000', 'https://img/101.jpg', 'Rumah Tangga'],
      ['102', 'Lampu LED', 'https://s.co.id/p/102', 'https://s.shopee.co.id/aff102', '45000', 'https://img/102.jpg', 'Elektronik'],
    ]);

    const result = await importer.parse({ filename: 'feed.csv', content: csv });

    expect(result.summary.format).toBe('csv');
    expect(result.summary.totalRows).toBe(2);
    expect(result.summary.accepted).toBe(2);
    expect(result.summary.rejected).toBe(0);
    expect(result.products).toHaveLength(2);
    expect(result.products[0]?.id).toBe('101');
    expect(result.products[0]?.name).toBe('Tumbler Stainless');
    expect(result.products[0]?.price).toBe(150000);
    expect(result.products[0]?.marketplace).toBe('shopee.co.id');
  });

  it('applies the default marketplace when the column is absent', async () => {
    const csv = toCsv([
      ['Item ID', 'Name', 'Product URL'],
      ['1', 'A', 'https://s.co.id/p/1'],
    ]);
    const result = await importer.parse({ filename: 'f.csv', content: csv });
    expect(result.products[0]?.marketplace).toBe('shopee.co.id');
  });

  it('honors an explicit defaultMarketplace override', async () => {
    const csv = toCsv([
      ['Item ID', 'Name', 'Product URL'],
      ['1', 'A', 'https://s.co.id/p/1'],
    ]);
    const result = await importer.parse({
      filename: 'f.csv',
      content: csv,
      defaultMarketplace: 'shopee.sg',
    });
    expect(result.products[0]?.marketplace).toBe('shopee.sg');
  });

  it('falls back to productUrl when no affiliate url is present', async () => {
    const csv = toCsv([
      ['Item ID', 'Name', 'Product URL'],
      ['1', 'A', 'https://s.co.id/p/1'],
    ]);
    const result = await importer.parse({ filename: 'f.csv', content: csv });
    expect(result.products[0]?.affiliateUrl).toBe('https://s.co.id/p/1');
  });

  it('deduplicates repeated product ids, keeping the first occurrence', async () => {
    const csv = toCsv([
      ['Item ID', 'Name', 'Product URL'],
      ['1', 'First', 'https://s.co.id/p/1'],
      ['1', 'Duplicate', 'https://s.co.id/p/1'],
      ['2', 'Other', 'https://s.co.id/p/2'],
    ]);
    const result = await importer.parse({ filename: 'f.csv', content: csv });

    expect(result.summary.accepted).toBe(2);
    expect(result.summary.duplicatesRemoved).toBe(1);
    expect(result.products.find((p: FeedProduct) => p.id === '1')?.name).toBe('First');
  });

  it('rejects rows missing a required field and reports the reason', async () => {
    const csv = toCsv([
      ['Item ID', 'Name', 'Product URL'],
      ['1', 'Valid', 'https://s.co.id/p/1'],
      ['2', '', 'https://s.co.id/p/2'],
    ]);
    const result = await importer.parse({ filename: 'f.csv', content: csv });

    expect(result.summary.accepted).toBe(1);
    expect(result.summary.rejected).toBe(1);
    expect(result.summary.issues.some((i: FeedRowIssue) => i.field === 'name')).toBe(true);
  });

  it('handles quoted values containing commas', async () => {
    const csv = toCsvQuoted([
      { 'Item ID': '1', Name: 'Mug, Gelas, dan Cangkir', 'Product URL': 'https://s.co.id/p/1' },
    ]);
    const result = await importer.parse({ filename: 'f.csv', content: csv });
    expect(result.products[0]?.name).toBe('Mug, Gelas, dan Cangkir');
  });

  it('derives a stable id when the feed omits one', async () => {
    const csv = toCsv([
      ['Name', 'Product URL'],
      ['Produk A', 'https://s.co.id/p/a'],
    ]);
    const result = await importer.parse({ filename: 'f.csv', content: csv });
    const id = result.products[0]?.id;
    expect(id).toMatch(/^auto_[0-9a-f]{8}$/);

    // Determinism: same input yields the same derived id.
    const again = await importer.parse({ filename: 'f.csv', content: csv });
    expect(again.products[0]?.id).toBe(id);
  });

  it('skips fully empty rows without rejecting them', async () => {
    const csv = toCsv([
      ['Item ID', 'Name', 'Product URL'],
      ['1', 'A', 'https://s.co.id/p/1'],
      ['', '', ''],
    ]);
    const result = await importer.parse({ filename: 'f.csv', content: csv });
    expect(result.summary.accepted).toBe(1);
    expect(result.summary.rejected).toBe(0);
  });

  it('throws ShopeeFeedError when no columns are recognizable', async () => {
    const csv = toCsv([
      ['colA', 'colB'],
      ['x', 'y'],
    ]);
    await expect(importer.parse({ filename: 'f.csv', content: csv })).rejects.toThrow(
      ShopeeFeedError,
    );
  });

  it('throws ShopeeFeedError for an empty file', async () => {
    await expect(
      importer.parse({ filename: 'f.csv', content: new Uint8Array(0) }),
    ).rejects.toThrow(ShopeeFeedError);
  });

  it('ignores unrecognized columns but still parses', async () => {
    const csv = toCsv([
      ['Item ID', 'Name', 'Product URL', 'Some Random Column'],
      ['1', 'A', 'https://s.co.id/p/1', 'zzz'],
    ]);
    const result = await importer.parse({ filename: 'f.csv', content: csv });
    expect(result.summary.accepted).toBe(1);
    expect(
      result.summary.issues.some((i: FeedRowIssue) => i.reason.includes('ignored')),
    ).toBe(true);
  });

  it('parses numeric-ish price strings with thousands separators', async () => {
    const csv = toCsvQuoted([
      { 'Item ID': '1', Name: 'A', 'Product URL': 'https://x', Price: '1.250.000' },
    ]);
    const result = await importer.parse({ filename: 'f.csv', content: csv });
    expect(result.products[0]?.price).toBe(1250000);
  });
});

/* -------------------------------------------------------------------------- */
/*  XLSX parsing                                                               */
/* -------------------------------------------------------------------------- */

describe('XLSX feed parsing', () => {
  it('parses an xlsx feed', async () => {
    const xlsx = toXlsx([
      {
        'Item ID': '201',
        Name: 'Keyboard Mechanical',
        'Product URL': 'https://s.co.id/p/201',
        'Affiliate URL': 'https://s.shopee.co.id/aff201',
        Price: 350000,
        'Image URL': 'https://img/201.jpg',
      },
    ]);

    const result = await importer.parse({ filename: 'feed.xlsx', content: xlsx });

    expect(result.summary.format).toBe('xlsx');
    expect(result.summary.accepted).toBe(1);
    expect(result.products[0]?.id).toBe('201');
    expect(result.products[0]?.name).toBe('Keyboard Mechanical');
    expect(result.products[0]?.price).toBe(350000);
  });

  it('deduplicates within an xlsx feed', async () => {
    const xlsx = toXlsx([
      { 'Item ID': '1', Name: 'A', 'Product URL': 'https://x/1' },
      { 'Item ID': '1', Name: 'A dup', 'Product URL': 'https://x/1' },
      { 'Item ID': '2', Name: 'B', 'Product URL': 'https://x/2' },
    ]);
    const result = await importer.parse({ filename: 'f.xlsx', content: xlsx });
    expect(result.summary.accepted).toBe(2);
    expect(result.summary.duplicatesRemoved).toBe(1);
  });

  it('rejects corrupt xlsx bytes with a typed error', async () => {
    const corrupt = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]);
    await expect(importer.parse({ filename: 'bad.xlsx', content: corrupt })).rejects.toThrow(
      ShopeeFeedError,
    );
  });

  it('auto-detects xlsx from magic bytes even with a .dat name', async () => {
    const xlsx = toXlsx([
      { 'Item ID': '9', Name: 'Z', 'Product URL': 'https://x/9' },
    ]);
    const result = await importer.parse({ filename: 'export.dat', content: xlsx });
    expect(result.summary.format).toBe('xlsx');
    expect(result.summary.accepted).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Live feed compatibility                                                    */
/* -------------------------------------------------------------------------- */

describe('live Shopee affiliate API', () => {
  it('is intentionally NOT implemented in Part 1', async () => {
    // The importer only ever handles uploaded bytes. There is no network client.
    expect(importer.info.name).toBe('shopee_feed_upload');
    expect(importer.info.detail).toContain('Live Shopee API is NOT assumed');
  });
});
