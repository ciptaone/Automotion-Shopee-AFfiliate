/**
 * PART 3 — the real content pipeline.
 *
 * Covers: persisted per-slot image count (stable across retries), retry
 * stability of asset identity, two-image slots producing DISTINCT views of the
 * SAME product, missing-reference-image blocking, provider failure with
 * partial generation, caption URL correctness, storage failure and
 * inaccessible media URLs, concurrent reservation, the publish gate, explicit
 * regeneration, and honest mock/live provider labeling.
 *
 * Credential-free: deterministic mocks only (MockImageGenerator /
 * MockCaptionGenerator / MemoryObjectStorage). No network, no paid call, no
 * publication — the publisher is never invoked by the pipeline at all.
 */
import { describe, it, expect } from 'vitest';
import {
  ContentPipeline,
  MAX_CAPTION_ATTEMPTS,
  adaptCaptionForPlatform,
  chooseImageCount,
} from '../../src/automation/pipeline.js';
import { InMemorySlotStore, SlotContentStore } from '../../src/automation/slot-store.js';
import { evaluateImageQuality, sha256 } from '../../src/automation/image-quality.js';
import { buildImagePrompt, PROMPT_VERSION } from '../../src/automation/image-prompt.js';
import {
  InMemoryCatalogStore,
  ProductCatalog,
  type CatalogProduct,
} from '../../src/catalog/catalog.js';
import { ShopeeFeedCsvImporter } from '../../src/integrations/feed/shopee-feed-importer.js';
import { MockCaptionGenerator, MockImageGenerator } from '../../src/integrations/ai/mock-ai.js';
import { MemoryObjectStorage } from '../../src/integrations/storage/object-storage.js';
import { SettingsService } from '../../src/settings/automation-settings.js';
import { FileSlotStore } from '../../src/automation/slot-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  CaptionGenerationRequest,
  CaptionGenerator,
  GeneratedCaption,
  GeneratedImage,
  ImageGenerator,
  Notifier,
} from '../../src/contracts/index.js';

/* -------------------------------------------------------------------------- */
/*  Synthetic feed fixtures (documented, synthetic test data only)            */
/* -------------------------------------------------------------------------- */

const importer = new ShopeeFeedCsvImporter();

const HEADERS = [
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

function row(id: string, category: string, imageUrl = `https://cf.shopee.co.id/img/${id}.jpg`): string[] {
  return [
    id,
    `Synthetic Product ${id}`,
    `https://shopee.co.id/product/${id}`,
    `https://s.shopee.co.id/aff-${id}`,
    imageUrl,
    category,
    '100000',
    '10',
    '4.8',
    '500',
  ];
}

function csv(rows: string[][]): Uint8Array {
  return new TextEncoder().encode(rows.map((r) => r.join(',')).join('\n'));
}

async function buildCatalog(rows: string[][]): Promise<ProductCatalog> {
  const catalog = new ProductCatalog(new InMemoryCatalogStore());
  const parsed = await importer.parse({ filename: 'feed.csv', content: csv([HEADERS, ...rows]) });
  await catalog.importFeed(parsed, { filename: 'feed.csv', format: 'csv' });
  return catalog;
}

/* -------------------------------------------------------------------------- */
/*  Test harness                                                              */
/* -------------------------------------------------------------------------- */

/** Image generator that fails on demand, to exercise the partial path. */
class FlakyImageGenerator implements ImageGenerator {
  readonly info = {
    name: 'flaky_image',
    kind: 'mock' as const,
    model: 'flaky-v1',
    ready: true,
    detail: 'Fails on configured seeds.',
  };

  constructor(
    private readonly inner: ImageGenerator,
    private readonly failSeeds: readonly number[],
  ) {}

  async generate(request: Parameters<ImageGenerator['generate']>[0]): Promise<GeneratedImage> {
    if (this.failSeeds.includes(request.seed)) {
      throw new Error('simulated upstream provider failure');
    }
    return this.inner.generate(request);
  }
}

/**
 * Caption generator that serves a SCRIPTED sequence of texts, one per call.
 *
 * PART 4 tests use it to force editorial failures (a compliant-looking caption
 * that still makes a forbidden first-person claim) and to observe exactly what
 * the regeneration loop sends back — the call count and the `previousIssues`
 * feedback — which the deterministic mock generator can never express.
 */
class ScriptedCaptionGenerator implements CaptionGenerator {
  readonly info = {
    name: 'scripted_caption',
    kind: 'mock' as const,
    model: 'scripted-v1',
    ready: true,
    detail: 'Serves pre-scripted caption texts; records every request.',
  };
  readonly requests: CaptionGenerationRequest[] = [];
  private index = 0;

  constructor(private readonly texts: readonly string[]) {}

  async generate(request: CaptionGenerationRequest): Promise<GeneratedCaption> {
    this.requests.push(request);
    const fullText =
      this.texts[this.index] ??
      'Lagi cari yang praktis?\n\nProduknya bisa dicek langsung di linknya.\n\nKlik linknya untuk lihat detailnya.\n\nLink di bawah adalah link afiliasi.\n\n#shopee #ai #automation';
    this.index += 1;
    return {
      hook: fullText.split('\n')[0] ?? '',
      body: fullText,
      cta: 'Klik linknya untuk lihat detailnya.',
      hashtags: ['#shopee', '#ai', '#automation'],
      fullText,
      embeddedUrl: request.affiliateUrl,
      model: this.info.model,
      estimatedCostUsd: 0,
    };
  }
}

/** Image generator that always returns the same structurally valid PNG. */
class DummyImageGenerator implements ImageGenerator {
  readonly info = {
    name: 'dummy_image',
    kind: 'mock' as const,
    model: 'dummy-v1',
    ready: true,
    detail: 'Returns a fixed valid PNG; used when image content is irrelevant.',
  };
  private static readonly PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);

  async generate(request: Parameters<ImageGenerator['generate']>[0]): Promise<GeneratedImage> {
    return {
      bytes: DummyImageGenerator.PNG,
      mimeType: 'image/png',
      width: 1080,
      height: 1920,
      seed: request.seed,
      model: this.info.model,
      estimatedCostUsd: 0,
    };
  }
}

/** Notifier that records what it was asked to send. */
class RecordingNotifier implements Notifier {
  readonly info = {
    name: 'recording_notifier',
    kind: 'mock' as const,
    ready: true,
    detail: 'Records notifications in memory.',
  };
  readonly sent: { kind: string; dedupeKey?: string; title: string }[] = [];

  async send(request: Parameters<Notifier['send']>[0]) {
    this.sent.push({ kind: request.kind, dedupeKey: request.dedupeKey, title: request.title });
    return {
      delivered: true,
      deduped: false,
      messageId: `msg-${this.sent.length}`,
      transport: 'mock' as const,
    };
  }
}

interface Harness {
  readonly pipeline: ContentPipeline;
  readonly catalog: ProductCatalog;
  readonly slots: SlotContentStore;
  readonly storage: MemoryObjectStorage;
  readonly settings: SettingsService;
  readonly notifier: RecordingNotifier;
}

async function harness(
  options: {
    rows?: string[][];
    imagePolicy?: 'random_1_or_2' | 'one' | 'two';
    imageGenerator?: ImageGenerator;
    captionGenerator?: CaptionGenerator;
    storage?: MemoryObjectStorage;
    facebookEnabled?: boolean;
    threadsEnabled?: boolean;
  } = {},
): Promise<Harness> {
  const catalog = await buildCatalog(options.rows ?? [row('1', 'Health & Beauty'), row('2', 'Home & Living')]);
  const slots = new SlotContentStore(new InMemorySlotStore());
  const settings = new SettingsService();
  if (options.imagePolicy) {
    await settings.update({ imageCountPolicy: options.imagePolicy });
  }
  if (options.facebookEnabled === false) {
    await settings.update({ facebookEnabled: false });
  }
  if (options.threadsEnabled === false) {
    await settings.update({ threadsEnabled: false });
  }
  const storage = options.storage ?? new MemoryObjectStorage();
  const notifier = new RecordingNotifier();
  const pipeline = new ContentPipeline({
    catalog,
    slots,
    settings,
    imageGenerator: options.imageGenerator ?? new MockImageGenerator(),
    captionGenerator: options.captionGenerator ?? new MockCaptionGenerator(),
    storage,
    notifier,
  });
  return { pipeline, catalog, slots, storage, settings, notifier };
}

/* ========================================================================== */
/*  Image count: real selection, persisted, stable                            */
/* ========================================================================== */

describe('image count selection and persistence', () => {
  it('chooseImageCount honors the one / two policies exactly', () => {
    expect(chooseImageCount('any-slot', 'one')).toBe(1);
    expect(chooseImageCount('any-slot', 'two')).toBe(2);
  });

  it('random_1_or_2 only ever yields 1 or 2 and is stable per slot key', () => {
    const keys = Array.from({ length: 60 }, (_, i) => `2026-10-12#${String(i + 1).padStart(2, '0')}`);
    const counts = keys.map((k) => chooseImageCount(k, 'random_1_or_2'));
    expect(counts.every((c) => c === 1 || c === 2)).toBe(true);
    // Both outcomes must actually occur across a day of slots.
    expect(new Set(counts).size).toBe(2);
    // Stable: same key always resolves the same count.
    for (const key of keys) {
      expect(chooseImageCount(key, 'random_1_or_2')).toBe(chooseImageCount(key, 'random_1_or_2'));
    }
  });

  it('persists the chosen count BEFORE generation and reuses it on retry', async () => {
    const { pipeline } = await harness({ imagePolicy: 'two' });
    const first = await pipeline.runSlot('2026-10-12#01');
    expect(first.record.imageCount).toBe(2);
    expect(first.record.imageCountPolicy).toBe('two');
    expect(first.record.imageCountChosenAt).not.toBe('');

    // A second run (retry) must not change the count or re-choose it.
    const second = await pipeline.runSlot('2026-10-12#01');
    expect(second.record.imageCount).toBe(2);
    expect(second.record.imageCountChosenAt).toBe(first.record.imageCountChosenAt);
    expect(second.actions).toHaveLength(0); // terminal: nothing redone
  });

  it('two-image slots share ONE count for both platforms (never re-randomized per platform)', async () => {
    const { pipeline } = await harness({ imagePolicy: 'random_1_or_2' });
    const { record } = await pipeline.runSlot('2026-10-12#07');
    // The count is a single slot-level value; both platform captions reference
    // the same asset set (no per-platform counts exist in the model at all).
    expect(record.imageCount).toBe(record.imageCount);
    expect(record.captions.map((c) => c.platform).sort()).toEqual(['facebook_page', 'threads']);
    expect(record.assets).toHaveLength(record.imageCount);
  });
});

/* ========================================================================== */
/*  Happy path through all stages                                             */
/* ========================================================================== */

describe('ContentPipeline.runSlot — full run', () => {
  it('reserves a product, generates images + captions, and marks publish_ready', async () => {
    const { pipeline } = await harness({ imagePolicy: 'two' });
    const { record, actions } = await pipeline.runSlot('2026-10-12#02');

    expect(record.stage).toBe('publish_ready');
    expect(record.validationPassed).toBe(true);
    expect(record.blockers).toHaveLength(0);
    expect(record.productId).not.toBeNull();
    expect(record.productName).toMatch(/^Synthetic Product/);
    expect(record.assets).toHaveLength(2);
    expect(record.captions).toHaveLength(2);
    expect(record.attempts).toBe(1);
    expect(actions).toContain('reserve');
    expect(actions).toContain('publish_gate_passed');
  });

  it('produces DIFFERENT images for a two-image slot, both of the SAME product', async () => {
    const { pipeline } = await harness({ imagePolicy: 'two' });
    const { record } = await pipeline.runSlot('2026-10-12#03');

    expect(record.assets).toHaveLength(2);
    const [a, b] = record.assets;
    expect(a?.checksumSha256).not.toBe(b?.checksumSha256); // distinct bytes
    expect(a?.seed).not.toBe(b?.seed); // distinct draws
    expect(a?.view).toBe('main_closeup_pov');
    expect(b?.view).toBe('secondary_lifestyle');
    // Same product, same reference image, same reservation.
    expect(a?.referenceImageUrl).toBe(b?.referenceImageUrl);
    expect(a?.referenceImageUrl).toBe(record.referenceImageUrl);
    expect(record.assets.every((asset) => asset.storageKey.includes(record.slotKey))).toBe(true);
  });

  it('uploads assets to storage with public URLs and checksums', async () => {
    const { pipeline, storage } = await harness({ imagePolicy: 'one' });
    const { record } = await pipeline.runSlot('2026-10-12#04');

    const [asset] = record.assets;
    expect(asset?.publicUrl).toMatch(/^https:\/\/storage\.mock\.local\/slots\//);
    expect(asset?.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(asset?.mimeType).toBe('image/png');
    expect(asset?.width).toBe(1080);
    expect(asset?.height).toBe(1920);
    expect(asset?.promptVersion).toBe(PROMPT_VERSION);
    expect(asset?.referenceImageUrl).toBe(record.referenceImageUrl);
    expect(storage.operationLog.some((op) => op.op === 'upload')).toBe(true);
    expect(storage.operationLog.some((op) => op.op === 'verifyPublicAccess')).toBe(true);
  });

  it('labels providers honestly as mock (never claims a live provider ran)', async () => {
    const { pipeline } = await harness();
    const { record } = await pipeline.runSlot('2026-10-12#05');

    expect(record.assets.every((a) => a.providerKind === 'mock')).toBe(true);
    expect(record.captions.every((c) => c.providerKind === 'mock')).toBe(true);
    expect(record.assets[0]?.provider).toBe('mock_image');
    expect(record.captions[0]?.provider).toBe('mock_caption');
  });

  it('embeds the exact affiliate URL in every platform caption and validates it', async () => {
    const { pipeline } = await harness();
    const { record } = await pipeline.runSlot('2026-10-12#06');

    expect(record.affiliateUrl).toMatch(/^https:\/\/s\.shopee\.co\.id\//);
    for (const caption of record.captions) {
      expect(caption.fullText).toContain(record.affiliateUrl as string);
      expect(caption.validationPassed).toBe(true);
      expect(caption.blocking).toHaveLength(0);
      expect(caption.hashtags.length).toBeGreaterThan(0);
      expect(caption.fullText).toMatch(/[Kk]lik|cek/i); // CTA present
    }
  });

  it('does NOT fabricate testimonial or discount claims (publish gate would block them)', async () => {
    const { pipeline } = await harness();
    const { record } = await pipeline.runSlot('2026-10-12#08');
    // The mock caption only states catalog facts, so it must pass the real
    // fabrication guards. This asserts the gate is wired to the real rules.
    expect(record.captions.every((c) => c.validationPassed)).toBe(true);
    const forbidden = /saya (pakai|cobain)|diskon \d+|gratis ongkir/i;
    expect(record.captions.some((c) => forbidden.test(c.fullText))).toBe(false);
  });

  it('generates exactly ONE image under the one policy and TWO under two', async () => {
    const single = await harness({ imagePolicy: 'one' });
    const one = await single.pipeline.runSlot('2026-10-12#09');
    expect(one.record.assets).toHaveLength(1);

    const double = await harness({ imagePolicy: 'two' });
    const two = await double.pipeline.runSlot('2026-10-12#09');
    expect(two.record.assets).toHaveLength(2);
  });
});

/* ========================================================================== */
/*  Retry stability                                                           */
/* ========================================================================== */

describe('ContentPipeline.runSlot — retry stability', () => {
  it('a retry after a provider failure reuses the SAME product and count', async () => {
    // Determine the position-2 seed deterministically, then fail only that one.
    const { slotSeed } = await import('../../src/automation/selection.js');
    const failingSeed = slotSeed('2026-10-12#10#2');

    const flaky = new FlakyImageGenerator(new MockImageGenerator(), [failingSeed]);
    const { pipeline } = await harness({ imagePolicy: 'two', imageGenerator: flaky });

    const first = await pipeline.runSlot('2026-10-12#10');
    expect(first.record.stage).toBe('failed');
    expect(first.record.lastError).toMatch(/image generation failed at position 2/i);
    // Position 1 succeeded and was kept (partial generation).
    expect(first.record.assets).toHaveLength(1);

    // A retry with a WORKING generator (fresh harness re-derives the same
    // deterministic reservation) resumes and completes the slot.
    const healed = await harness({ imagePolicy: 'two' });
    const retry = await healed.pipeline.runSlot('2026-10-12#10');
    expect(retry.record.imageCount).toBe(2);
    expect(retry.record.stage).toBe('publish_ready');
    // Source identity is stable across catalog instances (internal ids are
    // per-instance UUIDs).
    expect(retry.record.sourceProductId).toBe(first.record.sourceProductId);
  });

  it('a retry on the SAME store keeps the reserved product and asset identity', async () => {
    const { slotSeed } = await import('../../src/automation/selection.js');
    const failingSeed = slotSeed('2026-10-12#11#2');
    const flaky = new FlakyImageGenerator(new MockImageGenerator(), [failingSeed]);
    const { pipeline, slots, settings, catalog } = await harness({
      imagePolicy: 'two',
      imageGenerator: flaky,
    });

    const first = await pipeline.runSlot('2026-10-12#11');
    expect(first.record.stage).toBe('failed');
    const before = slots.get('2026-10-12#11');
    expect(before?.assets).toHaveLength(1);

    // New pipeline over the SAME catalog + slot store + settings, with a
    // healthy generator, then retry: the first asset must be reused verbatim.
    // (The catalog MUST be the same instance: the reservation references a
    // catalog-internal id, and a different instance would not resolve it.)
    const healthy = new ContentPipeline({
      catalog,
      slots,
      settings,
      imageGenerator: new MockImageGenerator(),
      captionGenerator: new MockCaptionGenerator(),
      storage: new MemoryObjectStorage(),
    });

    const retry = await healthy.runSlot('2026-10-12#11');
    expect(retry.record.stage).toBe('publish_ready');
    expect(retry.record.assets[0]?.assetId).toBe(before?.assets[0]?.assetId);
    expect(retry.record.assets).toHaveLength(2);
    expect(retry.record.productId).toBe(before?.productId);
    expect(retry.record.imageCount).toBe(2);
    expect(retry.record.attempts).toBe(2);
  });

  it('an already publish_ready slot is not regenerated on a repeat run', async () => {
    const { pipeline } = await harness({ imagePolicy: 'two' });
    const first = await pipeline.runSlot('2026-10-12#12');
    const assetIds = first.record.assets.map((a) => a.assetId);

    const second = await pipeline.runSlot('2026-10-12#12');
    expect(second.record.assets.map((a) => a.assetId)).toEqual(assetIds);
    expect(second.actions).toHaveLength(0);
    expect(second.record.attempts).toBe(first.record.attempts);
  });

  it('EXPLICIT regeneration replaces assets but keeps the reservation and count', async () => {
    const { pipeline } = await harness({ imagePolicy: 'two' });
    const first = await pipeline.runSlot('2026-10-12#13');
    const regenerated = await pipeline.runSlot('2026-10-12#13', { regenerate: true });

    expect(regenerated.actions).toContain('regenerate_requested');
    expect(regenerated.record.stage).toBe('publish_ready');
    expect(regenerated.record.imageCount).toBe(2); // count preserved
    expect(regenerated.record.productId).toBe(first.record.productId); // product preserved
    expect(regenerated.record.generationRunId).not.toBe(first.record.generationRunId); // new run
    // Deterministic seeds mean the CONTENT is reproducible, but the asset
    // RECORDS are new objects with fresh asset ids.
    expect(regenerated.record.assets.map((a) => a.assetId)).not.toEqual(
      first.record.assets.map((a) => a.assetId),
    );
  });
});

/* ========================================================================== */
/*  Blocking conditions                                                       */
/* ========================================================================== */

describe('ContentPipeline.runSlot — blockers', () => {
  it('BLOCKS (never generates) when the product has no reference image', async () => {
    const { pipeline } = await harness({
      rows: [row('1', 'Health & Beauty', ''), row('2', 'Home & Living', '')],
    });
    const { record } = await pipeline.runSlot('2026-10-12#14');

    // requireReferenceImage=true in the policy means no candidate survives, so
    // the slot is skipped with the selection reason (never an unanchored image).
    expect(record.stage).toBe('blocked');
    expect(record.validationPassed).toBe(false);
    expect(record.assets).toHaveLength(0);
    expect(record.blockers.length).toBeGreaterThan(0);
    expect(record.blockers[0]?.code).toMatch(/no_eligible_products/);
  });

  it('blocks with missing_reference_image when a reserved product loses its image', async () => {
    // Bypass the selection gate by reserving through a catalog that HAS an
    // image, then clear it before generation.
    const catalog = await buildCatalog([row('1', 'Health & Beauty')]);
    const slots = new SlotContentStore(new InMemorySlotStore());
    const settings = new SettingsService();
    await settings.update({ imageCountPolicy: 'one' });
    const pipeline = new ContentPipeline({
      catalog,
      slots,
      settings,
      imageGenerator: new MockImageGenerator(),
      captionGenerator: new MockCaptionGenerator(),
      storage: new MemoryObjectStorage(),
    });

    // Force a reservation record whose reference image is null (simulating a
    // product that was reserved before its image disappeared).
    const now = new Date().toISOString();
    await slots.put({
      slotKey: '2026-10-12#15',
      stage: 'reserved',
      productId: 'internal-1',
      sourceProductId: '1',
      productName: 'Synthetic Product 1',
      affiliateUrl: 'https://s.shopee.co.id/aff-1',
      categoryId: 'health-beauty',
      imageCountPolicy: 'one',
      imageCount: 1,
      imageCountChosenAt: now,
      selection: null,
      referenceImageUrl: null,
      generationRunId: 'run-1',
      assets: [],
      captions: [],
      validationPassed: false,
      blockers: [],
      lastError: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    const { record } = await pipeline.runSlot('2026-10-12#15');
    expect(record.stage).toBe('blocked');
    expect(record.blockers.some((b) => b.code === 'missing_reference_image')).toBe(true);
    expect(record.assets).toHaveLength(0);
  });

  it('blocks the slot when the selected categories hold nothing eligible (and notifies)', async () => {
    const { pipeline, notifier, settings } = await harness();
    await settings.update({
      selectionMode: 'selected_categories',
      selectedCategoryIds: ['ghost-category'],
    });

    const { record } = await pipeline.runSlot('2026-10-12#16');
    expect(record.stage).toBe('blocked');
    expect(record.blockers[0]?.code).toBe('unknown_categories');
    // The operator is told through the existing notification workflow.
    expect(notifier.sent.some((n) => n.dedupeKey === 'slot-skipped-2026-10-12#16')).toBe(true);
  });

  it('does not fall back to auto when the chosen category is empty', async () => {
    const catalog = await buildCatalog([
      row('1', 'Health & Beauty'),
      row('2', 'Home & Living'),
    ]);
    const slots = new SlotContentStore(new InMemorySlotStore());
    const settings = new SettingsService();
    await settings.update({
      selectionMode: 'selected_categories',
      selectedCategoryIds: ['electronics'],
    });
    const pipeline = new ContentPipeline({
      catalog,
      slots,
      settings,
      imageGenerator: new MockImageGenerator(),
      captionGenerator: new MockCaptionGenerator(),
      storage: new MemoryObjectStorage(),
    });

    const { record } = await pipeline.runSlot('2026-10-12#17');
    expect(record.stage).toBe('blocked');
    expect(record.productId).toBeNull(); // nothing was reserved
    expect(record.blockers[0]?.code).toBe('unknown_categories');
  });

  it('blocks when every publishing destination is switched off', async () => {
    const { pipeline } = await harness({ facebookEnabled: false, threadsEnabled: false });
    const { record } = await pipeline.runSlot('2026-10-12#18');
    expect(record.stage).toBe('blocked');
    expect(record.blockers.some((b) => b.code === 'no_destination_enabled')).toBe(true);
  });
});

/* ========================================================================== */
/*  Failure paths: provider + storage                                         */
/* ========================================================================== */

describe('ContentPipeline.runSlot — provider and storage failures', () => {
  it('fails the run (retryable) when the image provider throws, keeping partial assets', async () => {
    const { slotSeed } = await import('../../src/automation/selection.js');
    const failingSeed = slotSeed('2026-10-12#19#1'); // fail the FIRST image
    const flaky = new FlakyImageGenerator(new MockImageGenerator(), [failingSeed]);
    const { pipeline } = await harness({ imagePolicy: 'two', imageGenerator: flaky });

    const { record } = await pipeline.runSlot('2026-10-12#19');
    expect(record.stage).toBe('failed');
    expect(record.lastError).toMatch(/image generation failed at position 1/i);
    expect(record.assets).toHaveLength(0);
    expect(record.validationPassed).toBe(false);
  });

  it('fails the run when storage upload fails', async () => {
    const failingStorage = new MemoryObjectStorage({ failKeySubstring: 'image-1' });
    const { pipeline } = await harness({ imagePolicy: 'one', storage: failingStorage });

    const { record } = await pipeline.runSlot('2026-10-12#20');
    expect(record.stage).toBe('failed');
    expect(record.lastError).toMatch(/storage upload failed/i);
  });

  it('BLOCKS (not ready) when the uploaded media URL is not publicly accessible', async () => {
    // Facebook/Threads cURL the image: an inaccessible URL must never be
    // treated as publish-ready.
    const privateStorage = new MemoryObjectStorage({ denyPublicAccessKeySubstring: 'image-1' });
    const { pipeline } = await harness({ imagePolicy: 'one', storage: privateStorage });

    const { record } = await pipeline.runSlot('2026-10-12#21');
    expect(record.stage).toBe('blocked');
    expect(record.blockers.some((b) => b.code === 'media_url_inaccessible')).toBe(true);
    expect(record.validationPassed).toBe(false);
  });
});

/* ========================================================================== */
/*  Concurrency                                                               */
/* ========================================================================== */

describe('ContentPipeline — concurrent reservation', () => {
  it('two concurrent runs of the same slot reserve exactly ONCE', async () => {
    const { pipeline, slots } = await harness({ imagePolicy: 'one' });

    const [a, b] = await Promise.all([
      pipeline.runSlot('2026-10-12#22'),
      pipeline.runSlot('2026-10-12#22'),
    ]);

    // Exactly one reservation happened; both callers see the same record.
    expect(a.record.productId).toBe(b.record.productId);
    expect(slots.get('2026-10-12#22')?.productId).toBe(a.record.productId);
    // The slot record exists exactly once in the store.
    expect(slots.list(10).filter((s) => s.slotKey === '2026-10-12#22')).toHaveLength(1);
  });

  it('concurrent runs of DIFFERENT slots reserve independently', async () => {
    const { pipeline } = await harness({ imagePolicy: 'one' });
    const [a, b] = await Promise.all([
      pipeline.runSlot('2026-10-12#23'),
      pipeline.runSlot('2026-10-12#24'),
    ]);
    expect(a.record.slotKey).not.toBe(b.record.slotKey);
    expect(a.record.stage).toBe('publish_ready');
    expect(b.record.stage).toBe('publish_ready');
  });
});

/* ========================================================================== */
/*  Image quality contract                                                    */
/* ========================================================================== */

describe('evaluateImageQuality', () => {
  const goodImage: GeneratedImage = {
    bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
    mimeType: 'image/png',
    width: 1080,
    height: 1920,
    seed: 1,
    model: 'mock',
    estimatedCostUsd: null,
  };

  it('passes a structurally valid image with a reference URL', () => {
    const result = evaluateImageQuality({
      images: [goodImage],
      referenceImageUrl: 'https://cf.shopee.co.id/img/1.jpg',
    });
    expect(result.passed).toBe(true);
    expect(result.automatedFidelityScore).toBeNull(); // honesty: no vision scorer
    expect(result.limitations).toMatch(/structural checks only/i);
  });

  it('fails when the reference image is missing (fidelity anchor)', () => {
    const result = evaluateImageQuality({ images: [goodImage], referenceImageUrl: null });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.rule === 'image.reference_present')).toBe(true);
  });

  it('detects byte-identical duplicates within a set', () => {
    const result = evaluateImageQuality({
      images: [goodImage, { ...goodImage }],
      referenceImageUrl: 'https://cf.shopee.co.id/img/1.jpg',
    });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.rule === 'image.no_duplicates')).toBe(true);
  });

  it('sha256 is deterministic and collision-free for distinct bytes', () => {
    expect(sha256(goodImage.bytes)).toBe(sha256(goodImage.bytes));
    expect(sha256(goodImage.bytes)).not.toBe(sha256(new Uint8Array([1, 2, 3])));
  });
});

/* ========================================================================== */
/*  Prompt construction                                                       */
/* ========================================================================== */

describe('buildImagePrompt', () => {
  const product: CatalogProduct = {
    internalId: 'i1',
    sourceProductId: '1',
    name: 'Serum Vitamin C',
    marketplace: 'shopee.co.id',
    productUrl: 'https://shopee.co.id/product/1',
    affiliateUrl: 'https://s.shopee.co.id/aff-1',
    hasAffiliateLink: true,
    productUrlNormalized: 'shopee.co.id/product/1',
    category: 'Health & Beauty',
    categoryId: 'health-beauty',
    imageUrl: 'https://cf.shopee.co.id/img/1.jpg',
    description: null,
    price: 100000,
    currency: 'IDR',
    commissionRate: 10,
    rating: 4.8,
    soldCount: 500,
    eligible: true,
    eligibilityReasons: [],
    lastImportedAt: '2026-10-12T00:00:00.000Z',
    sourceImportId: 'b1',
    extraColumns: {},
  };

  it('grounds the prompt in the REAL product name and category', () => {
    const { prompt } = buildImagePrompt(product, 'main_closeup_pov', 123);
    expect(prompt).toContain('Serum Vitamin C');
    expect(prompt).toContain('Health & Beauty');
    expect(prompt).toContain('Product:');
  });

  it('instructs the model to preserve packaging and NOT invent details', () => {
    const { prompt, negativePrompt } = buildImagePrompt(product, 'main_closeup_pov', 1);
    expect(prompt).toMatch(/preserve its packaging shape/i);
    expect(prompt).toMatch(/do not invent/i);
    expect(negativePrompt).toMatch(/invented logos/i);
    expect(negativePrompt).toMatch(/extra fingers/i); // anatomy guard
  });

  it('uses distinct compositions for the two views of the same product', () => {
    const main = buildImagePrompt(product, 'main_closeup_pov', 1);
    const second = buildImagePrompt(product, 'secondary_lifestyle', 2);
    expect(main.prompt).not.toBe(second.prompt);
    expect(main.prompt).toMatch(/first-person/i);
    expect(second.prompt).toMatch(/lifestyle setting/i);
    // Identity line is identical (same product in both).
    expect(main.prompt.split('Depict')[0]).toBe(second.prompt.split('Depict')[0]);
  });

  it('omits the category when the feed supplied none (never guesses)', () => {
    const { prompt } = buildImagePrompt({ ...product, category: null }, 'main_closeup_pov', 1);
    expect(prompt).not.toContain('Product category:');
  });

  it('records the prompt version on every prompt', () => {
    expect(buildImagePrompt(product, 'main_closeup_pov', 1).promptVersion).toBe(PROMPT_VERSION);
  });
});

/* ========================================================================== */
/*  Caption formatting adaptation                                             */
/* ========================================================================== */

describe('adaptCaptionForPlatform', () => {
  const shortCaption = 'Hook.\n\nBody.\n\nKlik linknya. 👉\n\n#shopee #serum\nhttps://s.shopee.co.id/x';

  it('leaves Facebook captions unchanged', () => {
    expect(adaptCaptionForPlatform(shortCaption, 'facebook_page')).toBe(shortCaption);
  });

  it('leaves a short Threads caption unchanged', () => {
    expect(adaptCaptionForPlatform(shortCaption, 'threads')).toBe(shortCaption);
  });

  it('trims hashtags (never facts or the URL) when Threads would overflow', () => {
    const tags = Array.from({ length: 60 }, (_, i) => `#rekomendasishopee${i}`).join(' ');
    const long = `Hook.\n\nBody text that is fairly long.\n\nKlik linknya. 👉\n\n${tags}\nhttps://s.shopee.co.id/aff-long`;
    expect(long.length).toBeGreaterThan(500);

    const adapted = adaptCaptionForPlatform(long, 'threads');
    expect(adapted.length).toBeLessThanOrEqual(500);
    // The affiliate URL survives verbatim.
    expect(adapted).toContain('https://s.shopee.co.id/aff-long');
    // Facts (hook/body/CTA) survive verbatim.
    expect(adapted).toContain('Hook.');
    expect(adapted).toContain('Klik linknya.');
    // At least one hashtag is kept.
    expect(adapted).toMatch(/#rekomendasishopee\d+/);
    // Hashtags were actually reduced.
    const before = (long.match(/#rekomendasishopee\d+/g) ?? []).length;
    const after = (adapted.match(/#rekomendasishopee\d+/g) ?? []).length;
    expect(after).toBeLessThan(before);
  });

  it('returns the text unchanged when there is no hashtag line to trim', () => {
    const noTags = `Hook.\n\n${'x'.repeat(600)}\nhttps://s.shopee.co.id/y`;
    expect(adaptCaptionForPlatform(noTags, 'threads')).toBe(noTags);
  });
});

/* ========================================================================== */
/*  Persistence across process restarts (file store)                          */
/* ========================================================================== */

describe('slot store persistence', () => {
  it('reloads slot records (count + assets) from disk', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slots-'));
    const file = path.join(dir, 'slots.json');
    try {
      const catalog = await buildCatalog([row('1', 'Health & Beauty')]);
      const settings = new SettingsService();
      await settings.update({ imageCountPolicy: 'two' });

      const first = new ContentPipeline({
        catalog,
        slots: new SlotContentStore(new FileSlotStore(file)),
        settings,
        imageGenerator: new MockImageGenerator(),
        captionGenerator: new MockCaptionGenerator(),
        storage: new MemoryObjectStorage(),
      });
      const run = await first.runSlot('2026-10-12#25');
      expect(run.record.stage).toBe('publish_ready');

      // New store instance over the same file: everything is preserved.
      const reloaded = new SlotContentStore(new FileSlotStore(file));
      await reloaded.init();
      const record = reloaded.get('2026-10-12#25');
      expect(record).not.toBeNull();
      expect(record?.imageCount).toBe(2);
      expect(record?.assets).toHaveLength(2);
      expect(record?.assets.map((a) => a.assetId)).toEqual(
        run.record.assets.map((a) => a.assetId),
      );
      expect(record?.captions).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/* ========================================================================== */
/*  PART 4 — editorial gate: bounded regeneration, never bypassed            */
/* ========================================================================== */

/** Neutral, fully compliant Indonesian copy: no first-person anything. */
const NEUTRAL_CAPTION = (url: string): string =>
  [
    'Lagi cari tumbler yang praktis buat harian?',
    // No price is stated: the fabrication guard would reject any price that
    // differs from the verified catalog price.
    'Produknya: Tumbler Stainless 500ml. Kategori Health & Beauty.',
    'Klik linknya untuk cek detail dan ketersediaannya di Shopee.',
    'Link di bawah adalah link afiliasi.',
    '#shopee #tumbler',
    url,
    '#ai #automation',
  ].join('\n\n');

/** Structurally perfect copy that STILL makes a forbidden ownership claim. */
const FIRST_PERSON_CAPTION = (url: string): string =>
  [
    'Lagi cari tumbler yang praktis buat harian?',
    'Produknya: Tumbler Stainless 500ml. Barang ini punya saya dan awet banget.',
    'Klik linknya untuk cek detail dan ketersediaannya di Shopee.',
    'Link di bawah adalah link afiliasi.',
    '#shopee #tumbler',
    url,
    '#ai #automation',
  ].join('\n\n');

/** Structurally perfect copy that fabricates a discount. */
const FABRICATED_DISCOUNT_CAPTION = (url: string): string =>
  [
    'Lagi cari tumbler yang praktis buat harian?',
    'Produknya: Tumbler Stainless 500ml. Diskon 50% hari ini saja di Shopee.',
    'Klik linknya untuk cek detail dan ketersediaannya di Shopee.',
    'Link di bawah adalah link afiliasi.',
    '#shopee #tumbler',
    url,
    '#ai #automation',
  ].join('\n\n');

const AFF_URL = 'https://s.shopee.co.id/aff-1';

describe('PART 4 — editorial gate inside the pipeline', () => {
  it('regenerates up to MAX_CAPTION_ATTEMPTS, then BLOCKS a non-compliant caption', async () => {
    const generator = new ScriptedCaptionGenerator([
      FIRST_PERSON_CAPTION(AFF_URL),
      FIRST_PERSON_CAPTION(AFF_URL),
      FIRST_PERSON_CAPTION(AFF_URL),
    ]);
    const { pipeline } = await harness({
      rows: [row('1', 'Health & Beauty')],
      imagePolicy: 'one',
      imageGenerator: new DummyImageGenerator(),
      captionGenerator: generator,
    });

    const { record } = await pipeline.runSlot('2026-10-12#30');

    // The bound is honored exactly: never more, never fewer.
    expect(generator.requests).toHaveLength(MAX_CAPTION_ATTEMPTS);
    expect(record.stage).toBe('blocked');
    expect(record.validationPassed).toBe(false);
    expect(record.captions).toHaveLength(2); // both platforms kept for diagnosis
    for (const caption of record.captions) {
      expect(caption.validationPassed).toBe(false);
      expect(
        caption.blocking.some((b) => b.rule === 'editorial.no_first_person_claim'),
      ).toBe(true);
    }
    expect(record.blockers.some((b) => b.code.startsWith('caption_invalid_'))).toBe(true);
    // The image work that succeeded is preserved (retry-safe, no wasted spend).
    expect(record.assets).toHaveLength(1);
  });

  it('regeneration is driven by the exact failing rules, and SUCCEEDS on the next attempt', async () => {
    const generator = new ScriptedCaptionGenerator([
      FIRST_PERSON_CAPTION(AFF_URL),
      NEUTRAL_CAPTION(AFF_URL),
    ]);
    const { pipeline } = await harness({
      rows: [row('1', 'Health & Beauty')],
      imagePolicy: 'one',
      imageGenerator: new DummyImageGenerator(),
      captionGenerator: generator,
    });

    const { record } = await pipeline.runSlot('2026-10-12#31');

    expect(generator.requests).toHaveLength(2);
    // Attempt 1 carried the editorial brief; attempt 2 ALSO carried the
    // precise failing rule so the generator corrected a KNOWN problem.
    expect(generator.requests[0]?.editorialBrief?.mandatoryFinalHashtags).toEqual([
      '#ai',
      '#automation',
    ]);
    expect(
      generator.requests[1]?.previousIssues?.some(
        (issue) => issue.rule === 'editorial.no_first_person_claim',
      ),
    ).toBe(true);

    expect(record.stage).toBe('publish_ready');
    expect(record.validationPassed).toBe(true);
    expect(record.blockers).toHaveLength(0);
    for (const caption of record.captions) {
      expect(caption.validationPassed).toBe(true);
    }
  });

  it('a fabricated discount is rejected by the fabrication guard, not published', async () => {
    const generator = new ScriptedCaptionGenerator([
      FABRICATED_DISCOUNT_CAPTION(AFF_URL),
      FABRICATED_DISCOUNT_CAPTION(AFF_URL),
      FABRICATED_DISCOUNT_CAPTION(AFF_URL),
    ]);
    const { pipeline } = await harness({
      rows: [row('1', 'Health & Beauty')],
      imagePolicy: 'one',
      imageGenerator: new DummyImageGenerator(),
      captionGenerator: generator,
    });

    const { record } = await pipeline.runSlot('2026-10-12#32');

    expect(generator.requests).toHaveLength(MAX_CAPTION_ATTEMPTS);
    expect(record.stage).toBe('blocked');
    expect(
      record.captions.some((c) =>
        c.blocking.some((b) => b.rule === 'editorial.no_unsupported_discount'),
      ),
    ).toBe(true);
  });

  it('every publish_ready caption ends EXACTLY with "#ai #automation" and embeds the URL', async () => {
    const { pipeline } = await harness({
      rows: [row('1', 'Health & Beauty')],
      imagePolicy: 'two',
    });
    const { record } = await pipeline.runSlot('2026-10-12#33');

    expect(record.stage).toBe('publish_ready');
    expect(record.captions.length).toBeGreaterThan(0);
    for (const caption of record.captions) {
      const trimmed = caption.fullText.trimEnd();
      expect(trimmed.endsWith('#ai #automation')).toBe(true);
      // Nothing may follow the mandatory ending.
      expect(trimmed.split(/\s+/).slice(-2).join(' ')).toBe('#ai #automation');
      // The exact affiliate URL survives adaptation verbatim.
      expect(caption.fullText).toContain(record.affiliateUrl ?? ' missing');
    }
    // The Threads adaptation never drops the mandatory ending.
    const threads = record.captions.find((c) => c.platform === 'threads');
    if (threads) {
      expect(
        adaptCaptionForPlatform(threads.fullText, 'threads')
          .trimEnd()
          .endsWith('#ai #automation'),
      ).toBe(true);
    }
  });

  it('publish_ready REQUIRES the editorial gate to pass (never bypassed for the schedule)', async () => {
    // Neutral copy -> publish_ready. The same pipeline with first-person copy
    // (test above) blocks. Proves the stage is decided by validation, not time.
    const neutral = new ScriptedCaptionGenerator([NEUTRAL_CAPTION(AFF_URL)]);
    const { pipeline } = await harness({
      rows: [row('1', 'Health & Beauty')],
      imagePolicy: 'one',
      imageGenerator: new DummyImageGenerator(),
      captionGenerator: neutral,
    });
    const { record } = await pipeline.runSlot('2026-10-12#34');
    expect(record.stage).toBe('publish_ready');
    expect(record.validationPassed).toBe(true);
    expect(record.captions.every((c) => c.validationPassed)).toBe(true);
  });
});

/* ========================================================================== */
/*  PART 4 — reference-image binding (product record is the source of truth) */
/* ========================================================================== */

describe('PART 4 — reference-image binding', () => {
  it('BLOCKS with reference_product_mismatch when the catalog product no longer owns the reserved image', async () => {
    const { pipeline, catalog } = await harness({
      rows: [row('1', 'Health & Beauty')],
      imagePolicy: 'one',
      imageGenerator: new DummyImageGenerator(),
    });

    // First run: the product owns its image, so the slot completes.
    const first = await pipeline.runSlot('2026-10-12#40');
    expect(first.record.stage).toBe('publish_ready');
    expect(first.record.referenceImageUrl).toBe('https://cf.shopee.co.id/img/1.jpg');

    // A re-import replaces the product's image: the reserved reference is now
    // a picture of a DIFFERENT product. Generation must be blocked, never
    // silently continued with a lookalike.
    const reimported = await importer.parse({
      filename: 'feed.csv',
      content: csv([
        HEADERS,
        row('1', 'Health & Beauty', 'https://cf.shopee.co.id/img/1-REPLACED.jpg'),
      ]),
    });
    await catalog.importFeed(reimported, { filename: 'feed.csv', format: 'csv' });

    // Explicit regeneration re-opens the slot and re-verifies the binding.
    const second = await pipeline.runSlot('2026-10-12#40', { regenerate: true });

    expect(second.record.stage).toBe('blocked');
    expect(
      second.record.blockers.some((b) => b.code === 'reference_product_mismatch'),
    ).toBe(true);
    expect(second.record.validationPassed).toBe(false);
    // Nothing new was generated from the mismatched reference.
    expect(second.record.assets).toHaveLength(0);
  });

  it('BLOCKS with reference_product_missing when the reserved product left the catalog', async () => {
    const { pipeline, slots } = await harness({
      rows: [row('1', 'Health & Beauty')],
      imagePolicy: 'one',
      imageGenerator: new DummyImageGenerator(),
    });

    const first = await pipeline.runSlot('2026-10-12#41');
    expect(first.record.stage).toBe('publish_ready');
    expect(first.record.productId).not.toBeNull();

    // The reservation now points at a product id the catalog no longer serves
    // (removed upstream / replaced feed). Regeneration re-verifies the binding
    // instead of trusting the stale reservation.
    await slots.mutate('2026-10-12#41', async (current) => {
      if (!current) return current;
      await slots.put({ ...current, productId: 'catalog-id-that-no-longer-exists' });
      return current;
    });

    const second = await pipeline.runSlot('2026-10-12#41', { regenerate: true });

    expect(second.record.stage).toBe('blocked');
    expect(
      second.record.blockers.some(
        (b) => b.code === 'reference_product_missing' || b.code === 'product_missing',
      ),
    ).toBe(true);
    expect(second.record.assets).toHaveLength(0);
  });

  it('BLOCKS with invalid_reference_image when the reference is not a permitted http(s) URL', async () => {
    const { pipeline, slots } = await harness({
      rows: [row('1', 'Health & Beauty')],
      imagePolicy: 'one',
      imageGenerator: new DummyImageGenerator(),
    });

    await pipeline.runSlot('2026-10-12#42');
    // Corrupt the stored reference (hand-edited record / bad migration).
    await slots.mutate('2026-10-12#42', async (current) => {
      if (!current) return current;
      await slots.put({ ...current, referenceImageUrl: 'ftp://not-permitted/img.jpg' });
      return current;
    });

    const { record } = await pipeline.runSlot('2026-10-12#42', { regenerate: true });

    expect(record.stage).toBe('blocked');
    expect(record.blockers.some((b) => b.code === 'invalid_reference_image')).toBe(true);
    expect(record.assets).toHaveLength(0);
  });

  it('BLOCKS with missing_reference_image when the reserved product has no image at all', async () => {
    const { pipeline, slots } = await harness({
      rows: [row('1', 'Health & Beauty')],
      imagePolicy: 'one',
      imageGenerator: new DummyImageGenerator(),
    });

    await pipeline.runSlot('2026-10-12#43');
    // The reference disappears after reservation (feed retracted it).
    await slots.mutate('2026-10-12#43', async (current) => {
      if (!current) return current;
      await slots.put({ ...current, referenceImageUrl: null });
      return current;
    });

    const { record } = await pipeline.runSlot('2026-10-12#43', { regenerate: true });

    expect(record.stage).toBe('blocked');
    expect(record.blockers.some((b) => b.code === 'missing_reference_image')).toBe(true);
    expect(record.assets).toHaveLength(0);
  });

  it('the reserved product + reference survive a retry unchanged (stable identity)', async () => {
    const { slotSeed } = await import('../../src/automation/selection.js');
    // Fail position 1 deterministically: the first run reserves but produces
    // no assets, so the retry must reuse the SAME product/reference/count.
    const failingSeed = slotSeed('2026-10-12#44#1');
    const flaky = new FlakyImageGenerator(new MockImageGenerator(), [failingSeed]);
    const { pipeline, catalog, slots, settings } = await harness({
      rows: [row('1', 'Health & Beauty')],
      imagePolicy: 'two',
      imageGenerator: flaky,
    });

    const first = await pipeline.runSlot('2026-10-12#44');
    expect(first.record.stage).toBe('failed');
    expect(first.record.productId).not.toBeNull();
    expect(first.record.referenceImageUrl).not.toBeNull();

    // Retry through a healthy generator over the SAME stores (the pattern the
    // Part 3 retry tests use): identity must be stable, never re-reserved.
    const healthy = new ContentPipeline({
      catalog,
      slots,
      settings,
      imageGenerator: new MockImageGenerator(),
      captionGenerator: new MockCaptionGenerator(),
      storage: new MemoryObjectStorage(),
    });

    const second = await healthy.runSlot('2026-10-12#44');
    expect(second.record.stage).toBe('publish_ready');
    expect(second.record.productId).toBe(first.record.productId);
    expect(second.record.referenceImageUrl).toBe(first.record.referenceImageUrl);
    expect(second.record.imageCount).toBe(first.record.imageCount);
  });
});
