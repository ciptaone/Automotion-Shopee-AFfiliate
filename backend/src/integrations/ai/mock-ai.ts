/**
 * Deterministic, provider-agnostic AI mocks (Part 1).
 *
 * These satisfy the `ImageGenerator` and `CaptionGenerator` contracts without any
 * network access or paid API cost. They are seeded so the same request always
 * yields byte-identical output — required for reproducible contract tests.
 *
 * The image mock emits a REAL, valid PNG (encoded in-process via zlib) so that
 * downstream storage/publisher code can be exercised with genuine image bytes.
 *
 * LIVE image/text generation is deliberately NOT implemented in Part 1. See
 * docs/implementation/part-01-integration-feasibility.md for the evaluation plan.
 */
import { deflateSync } from 'node:zlib';
import { MANDATORY_FINAL_HASHTAGS } from '../../contracts/index.js';
import type {
  CaptionGenerationRequest,
  CaptionGenerator,
  GeneratedCaption,
  GeneratedImage,
  ImageGenerationRequest,
  ImageGenerator,
  ProviderInfo,
} from '../../contracts/index.js';

/* -------------------------------------------------------------------------- */
/*  Minimal PNG encoder (truecolor RGB, no interlace)                         */
/* -------------------------------------------------------------------------- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 (IEEE) with a table; used by the PNG chunk framing. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i];
    if (byte !== undefined) {
      crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Encode an RGB image to PNG. `pixelAt(x, y)` returns [r, g, b].
 * Deterministic: identical callbacks + dimensions => identical bytes.
 */
export function encodePng(
  width: number,
  height: number,
  pixelAt: (x: number, y: number) => readonly [number, number, number],
): Buffer {
  // Raw scanlines: each row prefixed with filter type 0 (None).
  const stride = width * 3 + 1;
  const raw = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelAt(x, y);
      const o = rowStart + 1 + x * 3;
      raw[o] = r & 0xff;
      raw[o + 1] = g & 0xff;
      raw[o + 2] = b & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace

  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */
/*  Deterministic PRNG (mulberry32)                                            */
/* -------------------------------------------------------------------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -------------------------------------------------------------------------- */
/*  Image mock                                                                 */
/* -------------------------------------------------------------------------- */

export interface MockImageGeneratorOptions {
  readonly model?: string;
  /** Simulated per-image cost in USD, surfaced for cost-tracking tests. */
  readonly estimatedCostUsd?: number;
}

export class MockImageGenerator implements ImageGenerator {
  readonly info: ProviderInfo;

  private readonly model: string;
  private readonly cost: number;

  constructor(options: MockImageGeneratorOptions = {}) {
    this.model = options.model ?? 'mock-image-v1';
    this.cost = options.estimatedCostUsd ?? 0.0;
    this.info = {
      name: 'mock_image',
      kind: 'mock',
      model: this.model,
      ready: true,
      detail: 'Deterministic in-process PNG generator. No network, no cost.',
    };
  }

  async generate(request: ImageGenerationRequest): Promise<GeneratedImage> {
    const width = Math.max(1, Math.floor(request.width));
    const height = Math.max(1, Math.floor(request.height));

    // Derive a stable palette from the seed + prompt so different requests
    // produce visibly different but reproducible images.
    const rand = mulberry32(request.seed);
    const baseR = Math.floor(rand() * 180) + 40;
    const baseG = Math.floor(rand() * 180) + 40;
    const baseB = Math.floor(rand() * 180) + 40;

    // A soft vertical gradient with a subtle center vignette — a cheap stand-in
    // for "premium vertical product photography" until a live provider is wired.
    const bytes = encodePng(width, height, (x, y) => {
      const t = y / height;
      const r = Math.min(255, Math.floor(baseR + t * (255 - baseR) * 0.35));
      const g = Math.min(255, Math.floor(baseG + t * (255 - baseG) * 0.35));
      const b = Math.min(255, Math.floor(baseB + t * (255 - baseB) * 0.35));
      // Vignette to focus the (mock) subject.
      const cx = (x / width - 0.5) * 2;
      const cy = (y / height - 0.5) * 2;
      const d = Math.min(1, Math.sqrt(cx * cx + cy * cy));
      const shade = 1 - d * 0.25;
      return [
        Math.max(0, Math.floor(r * shade)),
        Math.max(0, Math.floor(g * shade)),
        Math.max(0, Math.floor(b * shade)),
      ] as const;
    });

    return {
      bytes: new Uint8Array(bytes),
      mimeType: 'image/png',
      width,
      height,
      seed: request.seed,
      model: this.model,
      estimatedCostUsd: this.cost,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Caption mock                                                               */
/* -------------------------------------------------------------------------- */

export interface MockCaptionGeneratorOptions {
  readonly model?: string;
  readonly estimatedCostUsd?: number;
}

/**
 * Deterministic Indonesian soft-selling caption generator.
 *
 * Honors the locked copy rules:
 *  - fluent natural Indonesian,
 *  - an engaging hook,
 *  - soft-selling body,
 *  - moderate emoji,
 *  - a clear CTA,
 *  - relevant hashtags,
 *  - the affiliate link embedded verbatim,
 *  - an affiliate DISCLOSURE in the body (Part 4),
 *  - the MANDATORY `#ai #automation` ending, with nothing after (Part 4).
 *
 * It NEVER fabricates benefits, testimonials, discounts, usage experiences or
 * commission values: every descriptive clause is drawn only from fields present
 * on the product record. When a field is missing, that clause is omitted. It is
 * also first-person-FREE: no ownership/receipt/usage/endorsement claims.
 */
export class MockCaptionGenerator implements CaptionGenerator {
  readonly info: ProviderInfo;

  private readonly model: string;
  private readonly cost: number;

  constructor(options: MockCaptionGeneratorOptions = {}) {
    this.model = options.model ?? 'mock-text-v1';
    this.cost = options.estimatedCostUsd ?? 0.0;
    this.info = {
      name: 'mock_caption',
      kind: 'mock',
      model: this.model,
      ready: true,
      detail: 'Deterministic template-based Indonesian caption. No network, no cost.',
    };
  }

  async generate(request: CaptionGenerationRequest): Promise<GeneratedCaption> {
    const { product, affiliateUrl } = request;
    const rand = mulberry32(product.id.length + affiliateUrl.length);

    const hooks = [
      'Lagi cari yang praktis dan tetap kece?',
      'Ini yang lagi banyak dicari orang.',
      'Wajib punya buat yang suka hal simpel.',
      'Barang satu ini bikin hari-hari lebih mudah.',
    ];
    const hook = hooks[Math.floor(rand() * hooks.length)] ?? hooks[0] ?? '';

    const bodyParts: string[] = [`Produknya: ${product.name}.`];
    if (product.category) {
      bodyParts.push(`Kategori ${product.category}.`);
    }
    if (product.price !== null && product.currency) {
      bodyParts.push(`Harga ${product.currency} ${formatIdNumber(product.price)}.`);
    } else if (product.price !== null) {
      bodyParts.push(`Harga ${formatIdNumber(product.price)}.`);
    }
    if (product.rating !== null) {
      bodyParts.push(`Rating ${product.rating.toFixed(1)} dari pembeli.`);
    }
    if (product.soldCount !== null) {
      bodyParts.push(`Sudah terjual ${formatIdNumber(product.soldCount)}+.`);
    }
    bodyParts.push('Cek sendiri detail dan ketersediaannya lewat link di bawah ya.');
    const body = bodyParts.join(' ');

    const cta = 'Klik linknya, cek langsung di Shopee. 👉';

    // Part 4: a mandatory affiliate disclosure in the BODY (not just a hashtag).
    const disclosure = 'Link di bawah adalah link afiliasi.';

    const hashtags = buildHashtags(product);
    const linkLine = affiliateUrl;
    // Part 4: the caption MUST end exactly with `#ai #automation`, nothing after.
    const ending = MANDATORY_FINAL_HASHTAGS;

    const fullText = [hook, body, cta, disclosure, hashtags.join(' '), linkLine, ending]
      .filter((s) => s.trim().length > 0)
      .join('\n\n');

    return {
      hook,
      body,
      cta,
      hashtags,
      fullText,
      embeddedUrl: affiliateUrl,
      model: this.model,
      estimatedCostUsd: this.cost,
    };
  }
}

/** Indonesian number formatting without pulling in a locale dependency. */
function formatIdNumber(value: number): string {
  const rounded = Math.round(value);
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Build up to 6 hashtags: marketplace, category, plus slugified name tokens. */
function buildHashtags(product: FeedProductLike): string[] {
  const tags: string[] = [];
  const push = (tag: string): void => {
    const clean = tag.replace(/[^a-zA-Z0-9]/g, '');
    if (clean.length >= 3 && !tags.some((t) => t.toLowerCase() === clean.toLowerCase())) {
      tags.push(`#${clean}`);
    }
  };

  push('Shopee');
  push('ShopeeAffiliate');
  if (product.category) {
    for (const token of product.category.split(/[\s/|,]+/)) {
      push(token);
    }
  }
  for (const token of product.name.split(/\s+/).slice(0, 4)) {
    push(token);
  }
  return tags.slice(0, 6);
}

interface FeedProductLike {
  readonly name: string;
  readonly category: string | null;
}
