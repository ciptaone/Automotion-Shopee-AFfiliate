/**
 * Pipeline preview payload (Part 3).
 *
 * Maps a REAL slot content record into the content-preview shape the APK
 * already understands (Part 2 contract), with additive pipeline fields:
 * stage, blockers, per-image metadata and honest provider labels.
 *
 * Compatibility rule: `source` is `'pipeline'` for real records and
 * `'fixture'` for the Part 2 fixtures; every Part 2 field keeps its exact
 * meaning so an older APK renders both without crashing.
 */
import type { SlotContentRecord, SlotAsset, SlotCaption } from './slot-store.js';
import type { ValidationIssue } from '../core/errors.js';
import {
  MANDATORY_FINAL_HASHTAGS,
} from '../contracts/index.js';
import { EDITORIAL_LIMITATIONS } from '../pipeline/editorial-policy.js';
import {
  NO_VISION_SCORER_REASON,
  QUALITY_LIMITATIONS,
} from './image-quality.js';

export interface PipelinePreviewImage {
  readonly position: number;
  readonly view: string;
  readonly publicUrl: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly provider: string;
  readonly providerKind: 'mock' | 'live';
  readonly model: string;
  readonly promptVersion: string;
  readonly referenceImageUrl: string | null;
}

export interface PipelinePreviewCaption {
  readonly platform: string;
  readonly fullText: string;
  readonly hashtags: readonly string[];
  readonly provider: string;
  readonly providerKind: 'mock' | 'live';
  readonly model: string;
  readonly validationPassed: boolean;
  readonly blocking: ReadonlyArray<{ rule: string; message: string }>;
  readonly warnings: ReadonlyArray<{ rule: string; message: string }>;
}

export interface PipelinePreview {
  readonly source: 'pipeline';
  readonly note: string;
  readonly slotKey: string;
  readonly stage: SlotContentRecord['stage'];
  readonly imageCountPolicy: SlotContentRecord['imageCountPolicy'];
  /** ONE count for the slot, shared by Facebook and Threads. */
  readonly imageCount: number;
  /** `pipeline_persisted`: the real count chosen once and stored per slot. */
  readonly imageCountSource: 'pipeline_persisted';
  readonly imageCountShared: true;
  readonly imageCountStable: true;
  readonly product: {
    readonly name: string;
    readonly affiliateUrl: string;
    readonly sourceProductId: string | null;
    readonly categoryId: string | null;
    readonly referenceImageUrl: string | null;
    readonly source: 'catalog';
    /** PART 4: explicit product-reference availability (never silent). */
    readonly referenceAvailable: boolean;
    /** PART 4: why the reference is unavailable, when it is. */
    readonly referenceUnavailableReason: string | null;
  };
  readonly caption: {
    readonly source: 'generated';
    readonly fullText: string;
    readonly hashtags: readonly string[];
    /** Per-platform captions; the first enabled platform is canonical. */
    readonly platforms: readonly PipelinePreviewCaption[];
    /** PART 4: the locked mandatory ending, shown explicitly in the APK. */
    readonly mandatoryFinalHashtags: string;
    /** PART 4: whether the canonical caption ends exactly with them. */
    readonly mandatoryEndingPresent: boolean;
  };
  readonly images: readonly PipelinePreviewImage[];
  /** PART 4: editorial policy validation (first-person claims, disclosure…). */
  readonly editorial: {
    readonly source: 'editorial_policy';
    readonly passed: boolean;
    readonly mandatoryFinalHashtags: string;
    readonly mandatoryEndingPresent: boolean;
    readonly disclosurePresent: boolean;
    readonly blocking: ReadonlyArray<{ rule: string; message: string }>;
    readonly warnings: ReadonlyArray<{ rule: string; message: string }>;
    readonly limitations: string;
  };
  /** PART 4: image-quality status with honest limitation disclosure. */
  readonly imageQuality: {
    readonly source: 'structural_image_quality';
    readonly passed: boolean;
    /** Always null: no vision-based fidelity scorer is implemented. */
    readonly automatedFidelityScore: null;
    readonly limitations: string;
    /** Dimensions that were NOT assessed and why (never fabricated). */
    readonly notAssessed: readonly { dimension: string; reason: string }[];
    readonly blocking: ReadonlyArray<{ rule: string; message: string }>;
  };
  readonly validation: {
    readonly source: 'real_validator_on_generated_content';
    readonly passed: boolean;
    readonly blocking: ReadonlyArray<{ rule: string; message: string }>;
    readonly warnings: ReadonlyArray<{ rule: string; message: string }>;
    readonly platformsChecked: readonly string[];
  };
  readonly platforms: {
    readonly facebook: {
      readonly enabled: boolean;
      readonly status: 'not_attempted';
      readonly url: null;
      readonly detail: string;
    };
    readonly threads: {
      readonly enabled: boolean;
      readonly status: 'not_attempted';
      readonly url: null;
      readonly detail: string;
    };
  };
  readonly blockers: ReadonlyArray<{ code: string; message: string }>;
  readonly publishReady: boolean;
  readonly attempts: number;
  readonly generationRunId: string;
  readonly updatedAt: string;
  /** Honest provider summary: the APK must never claim a live provider ran. */
  readonly providers: {
    readonly image: { readonly name: string; readonly kind: 'mock' | 'live' } | null;
    readonly caption: { readonly name: string; readonly kind: 'mock' | 'live' } | null;
  };
}

export const PIPELINE_PREVIEW_NOTE =
  'Generated by the backend content pipeline. Publication to Facebook/Threads is not enabled yet.';

function toIssueList(
  items: ReadonlyArray<{ rule: string; message: string }>,
): ReadonlyArray<{ rule: string; message: string }> {
  return items.map((item) => ({ rule: item.rule, message: item.message }));
}

function assetToImage(asset: SlotAsset): PipelinePreviewImage {
  return {
    position: asset.position,
    view: asset.view,
    publicUrl: asset.publicUrl,
    width: asset.width,
    height: asset.height,
    sizeBytes: asset.sizeBytes,
    checksumSha256: asset.checksumSha256,
    provider: asset.provider,
    providerKind: asset.providerKind,
    model: asset.model,
    promptVersion: asset.promptVersion,
    referenceImageUrl: asset.referenceImageUrl,
  };
}

function captionToPlatform(caption: SlotCaption): PipelinePreviewCaption {
  return {
    platform: caption.platform,
    fullText: caption.fullText,
    hashtags: caption.hashtags,
    provider: caption.provider,
    providerKind: caption.providerKind,
    model: caption.model,
    validationPassed: caption.validationPassed,
    blocking: toIssueList(caption.blocking),
    warnings: toIssueList(caption.warnings),
  };
}

export interface BuildPipelinePreviewInput {
  readonly record: SlotContentRecord;
  readonly facebookEnabled: boolean;
  readonly threadsEnabled: boolean;
}

export function buildPipelinePreview(input: BuildPipelinePreviewInput): PipelinePreview {
  const { record } = input;
  const canonicalCaption = record.captions[0] ?? null;
  const blocking: Array<{ rule: string; message: string }> = [];
  const warnings: Array<{ rule: string; message: string }> = [];

  for (const caption of record.captions) {
    for (const issue of caption.blocking) {
      if (!blocking.some((b) => b.rule === issue.rule)) {
        blocking.push(issue);
      }
    }
    for (const issue of caption.warnings) {
      if (!warnings.some((w) => w.rule === issue.rule)) {
        warnings.push(issue);
      }
    }
  }
  for (const blocker of record.blockers) {
    const mapped: { rule: string; message: string } = { rule: blocker.code, message: blocker.message };
    if (!blocking.some((b) => b.rule === mapped.rule)) {
      blocking.push(mapped);
    }
  }

  const imageProvider = record.assets[0]
    ? { name: record.assets[0].provider, kind: record.assets[0].providerKind }
    : null;
  const captionProvider = canonicalCaption
    ? { name: canonicalCaption.provider, kind: canonicalCaption.providerKind }
    : null;

  /* --- PART 4: reference availability (explicit, never silent) --- */
  const referenceAvailable = Boolean(record.referenceImageUrl);
  let referenceUnavailableReason: string | null = null;
  if (!referenceAvailable) {
    const blocker = record.blockers.find((b) => b.code.includes('reference'));
    referenceUnavailableReason =
      blocker?.message ??
      'The reserved product has no reference image, so generation is blocked rather than risk an unfaithful image.';
  }

  /* --- PART 4: editorial + image-quality views of the same issues --- */
  const canonicalText = canonicalCaption?.fullText ?? '';
  const mandatoryEndingPresent = canonicalText
    .trimEnd()
    .endsWith(MANDATORY_FINAL_HASHTAGS);
  const editorialBlocking = blocking.filter((issue) => issue.rule.startsWith('editorial.'));
  const editorialWarnings = warnings.filter((issue) => issue.rule.startsWith('editorial.'));
  const imageBlocking = blocking.filter(
    (issue) => issue.rule.startsWith('image') || issue.rule.includes('reference'),
  );

  const disclosurePresent =
    canonicalText.length > 0 && !editorialBlocking.some((i) => i.rule === 'editorial.affiliate_disclosure');

  const platformDetail = (enabled: boolean): string => {
    if (!enabled) return 'Destination disabled in settings.';
    if (record.stage === 'publish_ready') {
      return `${record.imageCount} image(s) + caption validated and ready. Publication is not enabled yet.`;
    }
    if (record.stage === 'blocked') {
      return `Blocked: ${record.blockers.map((b) => b.code).join(', ') || 'unknown'}.`;
    }
    return `Stage: ${record.stage}.`;
  };

  return {
    source: 'pipeline',
    note: PIPELINE_PREVIEW_NOTE,
    slotKey: record.slotKey,
    stage: record.stage,
    imageCountPolicy: record.imageCountPolicy,
    imageCount: record.imageCount,
    imageCountSource: 'pipeline_persisted',
    imageCountShared: true,
    imageCountStable: true,
    product: {
      name: record.productName ?? '(no product reserved)',
      affiliateUrl: record.affiliateUrl ?? '',
      sourceProductId: record.sourceProductId,
      categoryId: record.categoryId,
      referenceImageUrl: record.referenceImageUrl,
      source: 'catalog',
      referenceAvailable,
      referenceUnavailableReason,
    },
    caption: {
      source: 'generated',
      fullText: canonicalCaption?.fullText ?? '',
      hashtags: canonicalCaption?.hashtags ?? [],
      platforms: record.captions.map(captionToPlatform),
      mandatoryFinalHashtags: MANDATORY_FINAL_HASHTAGS,
      mandatoryEndingPresent,
    },
    images: record.assets.map(assetToImage),
    editorial: {
      source: 'editorial_policy',
      passed: editorialBlocking.length === 0,
      mandatoryFinalHashtags: MANDATORY_FINAL_HASHTAGS,
      mandatoryEndingPresent,
      disclosurePresent,
      blocking: editorialBlocking,
      warnings: editorialWarnings,
      limitations: EDITORIAL_LIMITATIONS,
    },
    imageQuality: {
      source: 'structural_image_quality',
      passed: imageBlocking.length === 0 && record.assets.length === record.imageCount,
      automatedFidelityScore: null,
      limitations: QUALITY_LIMITATIONS,
      notAssessed: [
        'product_identity',
        'packaging_fidelity',
        'main_color',
        'anatomy_realism',
        'lighting',
        'generation_artifacts',
      ].map((dimension) => ({ dimension, reason: NO_VISION_SCORER_REASON })),
      blocking: imageBlocking,
    },
    validation: {
      source: 'real_validator_on_generated_content',
      passed: record.validationPassed,
      blocking,
      warnings,
      platformsChecked: record.captions.map((caption) => caption.platform),
    },
    platforms: {
      facebook: {
        enabled: input.facebookEnabled,
        status: 'not_attempted',
        url: null,
        detail: platformDetail(input.facebookEnabled),
      },
      threads: {
        enabled: input.threadsEnabled,
        status: 'not_attempted',
        url: null,
        detail: platformDetail(input.threadsEnabled),
      },
    },
    blockers: record.blockers.map((blocker) => ({ code: blocker.code, message: blocker.message })),
    publishReady: record.stage === 'publish_ready',
    attempts: record.attempts,
    generationRunId: record.generationRunId,
    updatedAt: record.updatedAt,
    providers: { image: imageProvider, caption: captionProvider },
  };
}

export type { ValidationIssue };
