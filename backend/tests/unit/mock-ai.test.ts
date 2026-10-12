import { describe, it, expect } from 'vitest';
import {
  MockImageGenerator,
  MockCaptionGenerator,
  encodePng,
} from '../../src/integrations/ai/mock-ai.js';
import type { FeedProduct } from '../../src/contracts/index.js';

const generator = new MockImageGenerator();
const captioner = new MockCaptionGenerator();

const sampleProduct: FeedProduct = {
  id: '101',
  name: 'Tumbler Stainless 500ml',
  marketplace: 'shopee.co.id',
  productUrl: 'https://s.co.id/p/101',
  affiliateUrl: 'https://s.shopee.co.id/9aBcDeF',
  price: 150000,
  currency: 'Rp',
  commissionRate: null,
  imageUrl: 'https://img/101.jpg',
  category: 'Rumah Tangga',
  rating: 4.8,
  soldCount: 1200,
  raw: {},
};

/* -------------------------------------------------------------------------- */
/*  PNG encoder                                                                */
/* -------------------------------------------------------------------------- */

describe('encodePng', () => {
  it('produces a valid PNG signature', () => {
    const png = encodePng(4, 4, () => [255, 0, 0]);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('contains IHDR, IDAT and IEND chunks', () => {
    const png = encodePng(2, 2, () => [0, 0, 0]);
    const text = png.toString('latin1');
    expect(text).toContain('IHDR');
    expect(text).toContain('IDAT');
    expect(text).toContain('IEND');
  });

  it('is deterministic for identical input', () => {
    const a = encodePng(8, 8, (x, y) => [x * 3, y * 3, 128]);
    const b = encodePng(8, 8, (x, y) => [x * 3, y * 3, 128]);
    expect(a.equals(b)).toBe(true);
  });

  it('encodes the requested dimensions in IHDR', () => {
    const png = encodePng(12, 34, () => [1, 2, 3]);
    // IHDR width/height sit at bytes 16..23 (8 sig + 4 len + 4 type).
    expect(png.readUInt32BE(16)).toBe(12);
    expect(png.readUInt32BE(20)).toBe(34);
  });
});

/* -------------------------------------------------------------------------- */
/*  Image generator                                                            */
/* -------------------------------------------------------------------------- */

describe('MockImageGenerator', () => {
  it('reports itself as a ready mock', () => {
    expect(generator.info.kind).toBe('mock');
    expect(generator.info.ready).toBe(true);
  });

  it('generates a non-empty PNG at the requested size', async () => {
    const image = await generator.generate({
      seed: 1,
      prompt: 'test',
      width: 64,
      height: 128,
      referenceImageUrls: [],
    });

    expect(image.bytes.byteLength).toBeGreaterThan(0);
    expect(image.mimeType).toBe('image/png');
    expect(image.width).toBe(64);
    expect(image.height).toBe(128);
    expect(image.model).toBe('mock-image-v1');
    // Starts with the PNG signature.
    expect(image.bytes.subarray(0, 4)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it('is deterministic for the same seed and prompt', async () => {
    const req = { seed: 42, prompt: 'p', width: 16, height: 16, referenceImageUrls: [] };
    const a = await generator.generate(req);
    const b = await generator.generate(req);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it('produces different output for different seeds', async () => {
    const a = await generator.generate({ seed: 1, prompt: 'p', width: 16, height: 16, referenceImageUrls: [] });
    const b = await generator.generate({ seed: 2, prompt: 'p', width: 16, height: 16, referenceImageUrls: [] });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(false);
  });

  it('reports zero cost', async () => {
    const image = await generator.generate({
      seed: 1,
      prompt: 'p',
      width: 8,
      height: 8,
      referenceImageUrls: [],
    });
    expect(image.estimatedCostUsd).toBe(0);
  });

  it('normalizes degenerate dimensions rather than throwing', async () => {
    const image = await generator.generate({
      seed: 1,
      prompt: 'p',
      width: 0,
      height: -5,
      referenceImageUrls: [],
    });
    expect(image.width).toBeGreaterThanOrEqual(1);
    expect(image.height).toBeGreaterThanOrEqual(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Caption generator                                                          */
/* -------------------------------------------------------------------------- */

describe('MockCaptionGenerator', () => {
  it('embeds the affiliate URL verbatim', async () => {
    const caption = await captioner.generate({
      product: sampleProduct,
      affiliateUrl: sampleProduct.affiliateUrl,
      language: 'id',
      tone: 'soft_sell',
    });
    expect(caption.fullText).toContain(sampleProduct.affiliateUrl);
    expect(caption.embeddedUrl).toBe(sampleProduct.affiliateUrl);
  });

  it('includes the product name', async () => {
    const caption = await captioner.generate({
      product: sampleProduct,
      affiliateUrl: sampleProduct.affiliateUrl,
      language: 'id',
      tone: 'soft_sell',
    });
    expect(caption.fullText).toContain(sampleProduct.name);
  });

  it('produces a hook, body, cta and hashtags', async () => {
    const caption = await captioner.generate({
      product: sampleProduct,
      affiliateUrl: sampleProduct.affiliateUrl,
      language: 'id',
      tone: 'soft_sell',
    });
    expect(caption.hook.length).toBeGreaterThan(0);
    expect(caption.body.length).toBeGreaterThan(0);
    expect(caption.cta.length).toBeGreaterThan(0);
    expect(caption.hashtags.length).toBeGreaterThan(0);
    expect(caption.hashtags.every((t) => t.startsWith('#'))).toBe(true);
  });

  it('uses Indonesian language markers', async () => {
    const caption = await captioner.generate({
      product: sampleProduct,
      affiliateUrl: sampleProduct.affiliateUrl,
      language: 'id',
      tone: 'soft_sell',
    });
    // The CTA and body must be Indonesian, not English.
    expect(caption.fullText).toMatch(/cek|klik|beli|link/i);
    expect(caption.fullText).not.toMatch(/\b(buy now|shop now|check out our)\b/i);
  });

  it('is deterministic for the same product', async () => {
    const req = {
      product: sampleProduct,
      affiliateUrl: sampleProduct.affiliateUrl,
      language: 'id' as const,
      tone: 'soft_sell' as const,
    };
    const a = await captioner.generate(req);
    const b = await captioner.generate(req);
    expect(a.fullText).toBe(b.fullText);
  });

  it('does NOT fabricate commission values when commissionRate is null', async () => {
    const caption = await captioner.generate({
      product: { ...sampleProduct, commissionRate: null },
      affiliateUrl: sampleProduct.affiliateUrl,
      language: 'id',
      tone: 'soft_sell',
    });
    expect(caption.fullText).not.toMatch(/komisi/i);
  });

  it('does NOT fabricate a discount or promo', async () => {
    const caption = await captioner.generate({
      product: sampleProduct,
      affiliateUrl: sampleProduct.affiliateUrl,
      language: 'id',
      tone: 'soft_sell',
    });
    expect(caption.fullText).not.toMatch(/diskon|promo|flash sale|% off/i);
  });

  it('does NOT fabricate a first-person testimonial', async () => {
    const caption = await captioner.generate({
      product: sampleProduct,
      affiliateUrl: sampleProduct.affiliateUrl,
      language: 'id',
      tone: 'soft_sell',
    });
    expect(caption.fullText).not.toMatch(/saya (sudah|pernah) (pakai|pake|beli)/i);
  });

  it('omits price when the product has none', async () => {
    const caption = await captioner.generate({
      product: { ...sampleProduct, price: null, currency: null },
      affiliateUrl: sampleProduct.affiliateUrl,
      language: 'id',
      tone: 'soft_sell',
    });
    expect(caption.fullText).not.toMatch(/harga/i);
  });

  it('formats Indonesian thousands separators for price', async () => {
    const caption = await captioner.generate({
      product: { ...sampleProduct, price: 1250000, currency: 'Rp' },
      affiliateUrl: sampleProduct.affiliateUrl,
      language: 'id',
      tone: 'soft_sell',
    });
    expect(caption.fullText).toContain('1.250.000');
  });
});
