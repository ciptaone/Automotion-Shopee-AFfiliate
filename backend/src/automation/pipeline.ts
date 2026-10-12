/**
 * AI content pipeline (Part 3).
 *
 * Replaces fixture-based preview generation with a REAL, staged pipeline:
 *
 *   1. reserve an eligible product (typed selection policy, persisted),
 *   2. validate the product + affiliate URL,
 *   3. resolve the real reference image (BLOCK when absent — never generate
 *      an unanchored, potentially unrelated product image),
 *   4. persist the slot's image count BEFORE generation,
 *   5. generate exactly that many images (view 1: POV close-up, view 2: a
 *      complementary lifestyle angle of the SAME product),
 *   6. validate outputs (structure + duplicate detection) and upload to
 *      S3-compatible storage, verifying public accessibility,
 *   7. generate ONE canonical Indonesian caption and adapt formatting per
 *      platform (facts and the affiliate URL never change),
 *   8. validate captions per platform through the existing publish-gate,
 *   9. persist assets/captions/checksums/versions,
 *  10. run the publish gate and mark `publish_ready` (or blocked/failed).
 *
 * NOTHING here publishes. Live publishing stays disabled (PART 4+). The
 * publisher is never invoked by this module.
 *
 * RETRY CONTRACT: the reserved product, image count, generation run id and
 * any already-valid assets are REUSED on retry. A failed slot is never
 * re-randomized. Replacing assets requires the explicit `regenerate()` call.
 *
 * HONESTY CONTRACT: every asset/caption records the concrete provider and
 * whether it was `mock` or `live`. A mock generation is labelled as mock; the
 * pipeline never claims a real provider produced content when it did not.
 */
import { randomUUID } from 'node:crypto';
import type {
  CaptionGenerator,
  FeedProduct,
  GeneratedImage,
  ImageGenerator,
  Notifier,
  ObjectStorage,
} from '../contracts/index.js';
import type { ProductCatalog, CatalogProduct } from '../catalog/catalog.js';
import type { SettingsService, AutomationSettings } from '../settings/automation-settings.js';
import { validateCaption, blocksPublish } from '../pipeline/content-validation.js';
import { evaluateImageQuality, sha256 } from './image-quality.js';
import { buildImagePrompt, type ImageView } from './image-prompt.js';
import { seededRandom, selectProduct, slotSeed, type SelectionPolicy } from './selection.js';
import type { SlotAsset, SlotBlocker, SlotCaption, SlotContentRecord, SlotStage } from './slot-store.js';
import { SlotContentStore } from './slot-store.js';

/* -------------------------------------------------------------------------- */
/*  Composition root for the pipeline                                         */
/* -------------------------------------------------------------------------- */

export interface ContentPipelineDeps {
  readonly catalog: ProductCatalog;
  readonly slots: SlotContentStore;
  readonly settings: SettingsService;
  readonly imageGenerator: ImageGenerator;
  readonly captionGenerator: CaptionGenerator;
  readonly storage: ObjectStorage;
  readonly notifier?: Notifier;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
}

export interface RunSlotResult {
  readonly record: SlotContentRecord;
  /** What this invocation did, for logs/tests. */
  readonly actions: readonly string[];
}

export class ContentPipeline {
  private readonly now: () => Date;

  constructor(private readonly deps: ContentPipelineDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Run (or resume) the pipeline for one content slot. Idempotent: a slot in a
   * terminal stage returns unchanged; a partially-generated slot resumes and
   * reuses valid assets. `regenerate: true` explicitly replaces derived
   * artifacts while keeping the reservation and image count.
   */
  async runSlot(slotKey: string, options: { regenerate?: boolean } = {}): Promise<RunSlotResult> {
    const { slots, settings } = this.deps;
    await this.deps.catalog.init();
    await slots.init();
    const actions: string[] = [];

    const appSettings = settings.current();
    let record = await slots.mutate(slotKey, (current) => {
      if (current && options.regenerate && current.productId) {
        actions.push('regenerate_requested');
        return this.blankDerived(current);
      }
      return current;
    });

    if (!record) {
      record = await this.reserve(slotKey, appSettings, actions);
    }
    if (!record) {
      // reserve() always returns a record; guard keeps types honest.
      throw new Error('reservation produced no record');
    }

    // Terminal stages are returned unchanged (a regenerate reopens them above).
    if (record.stage === 'blocked' || record.stage === 'publish_ready') {
      await this.notifySkipIfApplicable(slotKey, record);
      return { record, actions };
    }

    // Count this invocation as an attempt whenever work is (re)done.
    record = await this.bumpAttempt(record);

    /* --- Stage: images --------------------------------------------- */
    if (record.assets.length < record.imageCount) {
      record = await this.generateImages(record, actions);
      if (record.stage === 'blocked' || record.stage === 'failed') {
        await this.notifySkipIfApplicable(slotKey, record);
        return { record, actions };
      }
    }

    /* --- Stage: captions ------------------------------------------- */
    if (record.captions.length === 0) {
      record = await this.generateCaptions(record, actions);
      if (record.stage === 'blocked' || record.stage === 'failed') {
        await this.notifySkipIfApplicable(slotKey, record);
        return { record, actions };
      }
    }

    /* --- Stage: publish gate ---------------------------------------- */
    record = await this.runPublishGate(record, actions);
    await this.notifySkipIfApplicable(slotKey, record);
    return { record, actions };
  }

  /** Latest slot records, newest first (for the pipeline status endpoint). */
  list(limit = 20): readonly SlotContentRecord[] {
    return this.deps.slots.list(limit);
  }

  get(slotKey: string): SlotContentRecord | null {
    return this.deps.slots.get(slotKey);
  }

  /* ---------------------------------------------------------------------- */
  /*  Reservation                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Select + reserve a product exactly once, even under concurrent workers:
   * the decision runs inside the per-slot lock, so the first caller wins and
   * later callers observe the same reservation.
   */
  private async reserve(
    slotKey: string,
    appSettings: AutomationSettings,
    actions: string[],
  ): Promise<SlotContentRecord> {
    const { catalog, slots } = this.deps;
    return slots.mutate(slotKey, (current) => {
      if (current) {
        return current; // another worker reserved first
      }
      actions.push('reserve');
      const now = this.now().toISOString();

      const selectionPolicy: SelectionPolicy = {
        mode: appSettings.selectionMode,
        selectedCategoryIds: appSettings.selectedCategoryIds,
        requireReferenceImage: true,
      };
      // Recent-avoidance memory: derive what EARLIER slots reserved so the
      // scorer can penalize repetition (products and their categories).
      // The CURRENT slot's own record is excluded: a retry must keep the
      // product it already reserved, never penalize itself into a new pick.
      const recent = slots
        .list(12)
        .filter((s) => s.productId !== null && s.slotKey !== slotKey);
      const recentProductIds = recent.map((s) => s.productId as string);
      const recentCategoryIds = recent
        .map((s) => s.categoryId)
        .filter((id): id is string => Boolean(id));
      // Deterministic per slot: identical (slot, catalog, policy) always
      // resolves identically, which keeps retries stable.
      const outcome = selectProduct(catalog.list({ limit: 500 }), {
        policy: selectionPolicy,
        recentProductIds,
        recentCategoryIds,
        random: seededRandom(slotSeed(slotKey)),
      });

      // The image count is chosen ONCE here and persisted before generation.
      const imageCount = chooseImageCount(slotKey, appSettings.imageCountPolicy);
      const base = {
        slotKey,
        imageCountPolicy: appSettings.imageCountPolicy,
        imageCount,
        imageCountChosenAt: now,
        generationRunId: randomUUID(),
        assets: [] as SlotAsset[],
        captions: [] as SlotCaption[],
        validationPassed: false,
        blockers: [] as SlotBlocker[],
        lastError: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      };

      if (outcome.status === 'skipped') {
        // The slot is recorded as BLOCKED with the exact reason. It is NEVER
        // silently re-selected under a different policy. The caller notifies
        // the operator through the normal blocked-stage path.
        return {
          ...base,
          stage: 'blocked' as SlotStage,
          productId: null,
          sourceProductId: null,
          productName: null,
          affiliateUrl: null,
          categoryId: null,
          selection: null,
          referenceImageUrl: null,
          blockers: [{ code: outcome.code, message: outcome.message }],
        };
      }

      const product = outcome.product;
      return {
        ...base,
        stage: 'reserved' as SlotStage,
        productId: product.internalId,
        sourceProductId: product.sourceProductId,
        productName: product.name,
        affiliateUrl: product.affiliateUrl,
        categoryId: product.categoryId,
        referenceImageUrl: product.imageUrl,
        selection: {
          mode: selectionPolicy.mode,
          selectedCategoryIds: selectionPolicy.selectedCategoryIds,
          score: outcome.score,
          signals: outcome.signals,
          considered: outcome.considered,
        },
      };
    });
  }

  /** Explicit regeneration: keep reservation + image count, drop derived work. */
  private blankDerived(current: SlotContentRecord): SlotContentRecord {
    const now = this.now().toISOString();
    return {
      ...current,
      stage: 'reserved',
      assets: [],
      captions: [],
      validationPassed: false,
      blockers: [],
      lastError: null,
      generationRunId: randomUUID(),
      updatedAt: now,
      completedAt: null,
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Images                                                                */
  /* ---------------------------------------------------------------------- */

  private async generateImages(
    record: SlotContentRecord,
    actions: string[],
  ): Promise<SlotContentRecord> {
    const { imageGenerator, storage } = this.deps;

    // Product fidelity anchor: without a real reference image we BLOCK rather
    // than generate a possibly unrelated product.
    if (!record.referenceImageUrl) {
      return this.persist(record, {
        stage: 'blocked',
        blockers: [
          ...record.blockers,
          {
            code: 'missing_reference_image',
            message:
              'The reserved product has no reference image; generation is blocked to avoid an unfaithful result. Import a feed with product images or pick another product.',
          },
        ],
        completedAt: this.now().toISOString(),
      });
    }

    let current = await this.persist(record, { stage: 'generating_images' });

    // Narrowed once: the guard above guarantees a reference image exists, but
    // `current` is reassigned through persist() so TS cannot keep the narrowing.
    const referenceImageUrl = current.referenceImageUrl;
    if (!referenceImageUrl) {
      // Defensive: unreachable given the guard above.
      return this.persist(current, { stage: 'failed', lastError: 'Reference image disappeared.' });
    }

    while (current.assets.length < current.imageCount) {
      const position = current.assets.length + 1;
      const view: ImageView = position === 1 ? 'main_closeup_pov' : 'secondary_lifestyle';
      // Deterministic, position-specific seed: view 2 is always a different
      // draw than view 1, so two-image slots get distinct images.
      const seed = slotSeed(`${current.slotKey}#${position}`);
      const prompt = buildImagePrompt(toPromptProduct(current), view, seed);

      let image: GeneratedImage;
      try {
        image = await imageGenerator.generate({
          seed,
          prompt: prompt.prompt,
          negativePrompt: prompt.negativePrompt,
          width: 1080,
          height: 1920,
          referenceImageUrls: [referenceImageUrl],
        });
      } catch (error) {
        // Partial generation: keep what succeeded, fail the run, and let a
        // retry resume from the remaining positions.
        actions.push(`image_${position}_failed`);
        return this.persist(current, {
          stage: 'failed',
          lastError: `Image generation failed at position ${position}: ${redactMessage(error)}`,
        });
      }

      // Structural validation of the NEW image alone.
      const quality = evaluateImageQuality({
        images: [image],
        referenceImageUrl,
      });

      // Duplicate detection against the assets already stored for this slot:
      // image 2 must never be a byte-copy of image 1.
      const checksum = sha256(image.bytes);
      const duplicateOf = current.assets.find((asset) => asset.checksumSha256 === checksum);
      if (duplicateOf) {
        actions.push(`image_${position}_duplicate`);
        return this.persist(current, {
          stage: 'failed',
          lastError: `Image ${position} is byte-identical to image ${duplicateOf.position}; two-image slots require distinct views. Retry resumes with a fresh draw.`,
        });
      }

      const blocking = quality.issues.filter((issue) => issue.severity === 'error');
      if (blocking.length > 0) {
        actions.push(`image_${position}_blocked`);
        return this.persist(current, {
          stage: 'blocked',
          blockers: [
            ...current.blockers,
            ...blocking.map((issue) => ({ code: issue.rule, message: issue.message })),
          ],
          completedAt: this.now().toISOString(),
        });
      }

      const key = `slots/${current.slotKey}/image-${position}-${view}.png`;
      let publicUrl: string;
      try {
        const uploaded = await storage.upload({
          key,
          bytes: image.bytes,
          contentType: image.mimeType,
          publicRead: true,
          metadata: {
            slot: current.slotKey,
            position: String(position),
            product: current.sourceProductId ?? 'unknown',
          },
        });
        const accessible = await storage.verifyPublicAccess(key);
        if (!accessible) {
          // An inaccessible media URL would make Facebook/Threads cURL fail;
          // publishing must never be marked ready with one.
          actions.push(`image_${position}_media_inaccessible`);
          return this.persist(current, {
            stage: 'blocked',
            blockers: [
              ...current.blockers,
              {
                code: 'media_url_inaccessible',
                message: `Uploaded asset ${key} is not publicly accessible; publishers require a cURL-able URL.`,
              },
            ],
            completedAt: this.now().toISOString(),
          });
        }
        publicUrl = uploaded.publicUrl;
      } catch (error) {
        actions.push(`image_${position}_upload_failed`);
        return this.persist(current, {
          stage: 'failed',
          lastError: `Storage upload failed at position ${position}: ${redactMessage(error)}`,
        });
      }

      const asset: SlotAsset = {
        assetId: randomUUID(),
        position,
        view,
        storageKey: key,
        publicUrl,
        checksumSha256: checksum,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        sizeBytes: image.bytes.byteLength,
        provider: imageGenerator.info.name,
        providerKind: imageGenerator.info.kind,
        model: image.model,
        promptVersion: prompt.promptVersion,
        seed,
        referenceImageUrl: current.referenceImageUrl,
        validationPassed: true,
        validationIssues: quality.issues.map((issue) => ({
          rule: issue.rule,
          message: issue.message,
          severity: issue.severity,
        })),
        generatedAt: this.now().toISOString(),
      };

      current = await this.persist({ ...current, assets: [...current.assets, asset] });
      actions.push(`image_${position}_generated`);
    }

    return this.persist(current, { stage: 'images_ready' });
  }

  /* ---------------------------------------------------------------------- */
  /*  Captions                                                              */
  /* ---------------------------------------------------------------------- */

  private async generateCaptions(
    record: SlotContentRecord,
    actions: string[],
  ): Promise<SlotContentRecord> {
    const { captionGenerator, settings } = this.deps;

    if (!record.affiliateUrl) {
      return this.persist(record, {
        stage: 'blocked',
        blockers: [
          ...record.blockers,
          { code: 'missing_affiliate_url', message: 'No affiliate URL is reserved for this slot.' },
        ],
        completedAt: this.now().toISOString(),
      });
    }

    const current = await this.persist(record, { stage: 'generating_captions' });

    const catalogProduct = this.deps.catalog.get(current.productId ?? '');
    if (!catalogProduct) {
      return this.persist(current, {
        stage: 'blocked',
        blockers: [
          ...current.blockers,
          { code: 'product_missing', message: 'The reserved product is no longer in the catalog.' },
        ],
        completedAt: this.now().toISOString(),
      });
    }

    let generated;
    try {
      generated = await captionGenerator.generate({
        product: toFeedProduct(catalogProduct),
        affiliateUrl: record.affiliateUrl,
        language: 'id',
        tone: 'soft_sell',
      });
    } catch (error) {
      actions.push('caption_failed');
      return this.persist(current, {
        stage: 'failed',
        lastError: `Caption generation failed: ${redactMessage(error)}`,
      });
    }

    const appSettings = settings.current();
    const platforms: Array<'facebook_page' | 'threads'> = [
      ...(appSettings.facebookEnabled ? (['facebook_page'] as const) : []),
      ...(appSettings.threadsEnabled ? (['threads'] as const) : []),
    ];
    if (platforms.length === 0) {
      return this.persist(current, {
        stage: 'blocked',
        blockers: [
          ...current.blockers,
          { code: 'no_destination_enabled', message: 'Both publishing destinations are switched off.' },
        ],
        completedAt: this.now().toISOString(),
      });
    }

    const captions: SlotCaption[] = [];
    for (const platform of platforms) {
      // ONE canonical caption; per-platform adaptation only adjusts FORMATTING
      // (hashtag trimming to fit Threads' 500-char limit). Product facts and
      // the affiliate URL are never altered.
      const text = adaptCaptionForPlatform(generated.fullText, platform);
      const issues = validateCaption({
        caption: { ...generated, fullText: text },
        requiredAffiliateUrl: record.affiliateUrl,
        platform,
      });
      captions.push({
        platform,
        fullText: text,
        hashtags: generated.hashtags,
        provider: captionGenerator.info.name,
        providerKind: captionGenerator.info.kind,
        model: generated.model,
        validationPassed: !blocksPublish(issues),
        blocking: issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => ({ rule: issue.rule, message: issue.message })),
        warnings: issues
          .filter((issue) => issue.severity === 'warning')
          .map((issue) => ({ rule: issue.rule, message: issue.message })),
        generatedAt: this.now().toISOString(),
      });
    }

    actions.push('captions_generated');
    return this.persist({ ...current, captions }, { stage: 'captions_ready' });
  }

  /* ---------------------------------------------------------------------- */
  /*  Publish gate                                                          */
  /* ---------------------------------------------------------------------- */

  private async runPublishGate(record: SlotContentRecord, actions: string[]): Promise<SlotContentRecord> {
    const blockers: SlotBlocker[] = record.blockers.filter(
      (blocker) => !blocker.code.startsWith('caption_invalid_') && !blocker.code.startsWith('asset_invalid_') && blocker.code !== 'incomplete_assets' && blocker.code !== 'missing_captions',
    );

    if (record.assets.length !== record.imageCount) {
      blockers.push({
        code: 'incomplete_assets',
        message: `Slot expects ${record.imageCount} image(s) but only ${record.assets.length} were generated.`,
      });
    }
    if (record.captions.length === 0) {
      blockers.push({ code: 'missing_captions', message: 'No caption was generated for this slot.' });
    }
    for (const caption of record.captions) {
      if (!caption.validationPassed) {
        blockers.push({
          code: `caption_invalid_${caption.platform}`,
          message: `Caption failed the publish gate for ${caption.platform}: ${caption.blocking.map((b) => b.rule).join(', ')}`,
        });
      }
    }
    for (const asset of record.assets) {
      if (!asset.validationPassed) {
        blockers.push({
          code: `asset_invalid_${asset.position}`,
          message: `Image ${asset.position} failed structural validation.`,
        });
      }
    }

    const passed = blockers.length === 0;
    const stage: SlotStage = passed ? 'publish_ready' : 'blocked';
    actions.push(passed ? 'publish_gate_passed' : 'publish_gate_blocked');
    return this.persist(record, {
      stage,
      validationPassed: passed,
      blockers,
      completedAt: this.now().toISOString(),
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  Helpers                                                               */
  /* ---------------------------------------------------------------------- */

  private async bumpAttempt(record: SlotContentRecord): Promise<SlotContentRecord> {
    const next = { ...record, attempts: record.attempts + 1, updatedAt: this.now().toISOString() };
    await this.deps.slots.put(next);
    return next;
  }

  private async persist(
    record: SlotContentRecord,
    patch: Partial<SlotContentRecord> = {},
  ): Promise<SlotContentRecord> {
    const next: SlotContentRecord = {
      ...record,
      ...patch,
      updatedAt: this.now().toISOString(),
    };
    await this.deps.slots.put(next);
    return next;
  }

  /**
   * Send the operator a Telegram notification (mock transport unless live is
   * authorized) when a slot is skipped for an actionable reason — e.g. the
   * selected categories hold no eligible product.
   */
  private async notifySkipIfApplicable(slotKey: string, record: SlotContentRecord): Promise<void> {
    if (!this.deps.notifier || record.stage !== 'blocked') {
      return;
    }
    const SKIPPABLE = new Set([
      'no_eligible_products_in_selected_categories',
      'unknown_categories',
      'empty_catalog',
      'no_eligible_products',
      'missing_reference_image',
    ]);
    const skip = record.blockers.find((blocker) => SKIPPABLE.has(blocker.code));
    if (!skip) {
      return;
    }
    try {
      await this.deps.notifier.send({
        kind: 'health_alert',
        dedupeKey: `slot-skipped-${slotKey}`,
        title: `Konten slot ${slotKey} dilewati`,
        lines: [skip.message],
      });
    } catch {
      // Notification failures must never fail the pipeline run itself.
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Pure helpers (exported for tests)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Choose the image count for a slot under a policy.
 *
 * `random_1_or_2` draws ONCE per slot key from a seeded PRNG; the pipeline
 * persists the result before generation, so retries reuse it. This is the
 * REAL selection that replaces the Part 2 fixture placeholder.
 */
export function chooseImageCount(slotKey: string, policy: 'random_1_or_2' | 'one' | 'two'): number {
  if (policy === 'one') return 1;
  if (policy === 'two') return 2;
  return 1 + Math.floor(seededRandom(slotSeed(slotKey))() * 2);
}

/**
 * Platform formatting adaptation.
 *
 * Facebook: unchanged. Threads: if the text exceeds the 500-char limit, drop
 * hashtags from the end (keeping at least one) until it fits. Product facts,
 * the CTA and the affiliate URL are never modified.
 */
export function adaptCaptionForPlatform(
  fullText: string,
  platform: 'facebook_page' | 'threads',
): string {
  if (platform !== 'threads' || fullText.length <= 500) {
    return fullText;
  }
  const lines = fullText.split('\n');
  const hashtagLineIndex = lines.findIndex((line) => line.trim().startsWith('#'));
  const hashtagLine = hashtagLineIndex >= 0 ? lines[hashtagLineIndex] : undefined;
  if (hashtagLine === undefined) {
    return fullText; // no hashtag line to trim; validation reports the overflow
  }
  const tags = hashtagLine.split(/\s+/).filter(Boolean);
  let text = fullText;
  while (text.length > 500 && tags.length > 1) {
    tags.pop();
    const copy = [...lines];
    copy[hashtagLineIndex] = tags.join(' ');
    text = copy.join('\n');
  }
  return text;
}

function redactMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]?.slice(0, 200) ?? 'unknown error';
}

/** Map a catalog record back into the feed-product shape the caption generator takes. */
function toFeedProduct(product: CatalogProduct): FeedProduct {
  return {
    id: product.sourceProductId,
    name: product.name,
    marketplace: product.marketplace,
    productUrl: product.productUrl,
    affiliateUrl: product.affiliateUrl,
    price: product.price,
    currency: product.currency,
    commissionRate: product.commissionRate,
    imageUrl: product.imageUrl,
    category: product.category,
    rating: product.rating,
    soldCount: product.soldCount,
    raw: product.extraColumns,
  };
}

/** Minimal catalog-shaped input for the prompt builder (verified fields only). */
function toPromptProduct(current: SlotContentRecord): CatalogProduct {
  return {
    internalId: current.productId ?? '',
    sourceProductId: current.sourceProductId ?? '',
    name: current.productName ?? '',
    marketplace: '',
    productUrl: '',
    affiliateUrl: current.affiliateUrl ?? '',
    hasAffiliateLink: true,
    productUrlNormalized: '',
    category: null,
    categoryId: current.categoryId,
    imageUrl: current.referenceImageUrl,
    description: null,
    price: null,
    currency: null,
    commissionRate: null,
    rating: null,
    soldCount: null,
    eligible: true,
    eligibilityReasons: [],
    lastImportedAt: '',
    sourceImportId: '',
    extraColumns: {},
  };
}
