/**
 * Deterministic FIXTURES for content preview and publishing history (Part 2).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The content-generation pipeline (product selection -> AI image -> AI caption
 * -> validation -> publish) is NOT implemented yet; it belongs to a later part.
 * The APK still needs real payloads to build and test its Content Preview and
 * Publishing History screens against. So this module serves fixtures that are:
 *
 *  - DETERMINISTIC: the same slot key always yields the same image count and
 *    the same payload, so refreshing or retrying never changes what is shown.
 *  - HONEST: every payload is tagged `source: "fixture"` and carries a note.
 *    No image is generated, no caption is produced by a model, and no
 *    publication happens here.
 *  - REAL WHERE IT CAN BE: the validation status shown for a fixture caption is
 *    computed by the REAL publish-gate validator (`pipeline/content-validation`),
 *    so the APK is wired to the same rules that will later gate live publishing.
 *
 * IMAGE-COUNT POLICY
 * ------------------
 * The locked policy is `random_1_or_2`: a content slot uses either one or two
 * images, chosen ONCE per slot and shared by BOTH destinations (Facebook and
 * Threads never get independent counts). Actual random selection + asset
 * persistence is implemented in the content-generation part; here the count is
 * a deterministic placeholder derived from the slot key, clearly labelled as
 * such, so the client contract (stable per slot, shared across platforms) is
 * real and testable today.
 */
import type { GeneratedCaption } from '../contracts/index.js';
import { validateCaption } from '../pipeline/content-validation.js';
import type { ValidationIssue } from '../core/errors.js';
import {
  DEFAULT_AUTOMATION_SETTINGS,
  type AutomationSettings,
  type ImageCountPolicy,
} from '../settings/automation-settings.js';

export const FIXTURE_SOURCE = 'fixture' as const;

export const FIXTURE_CONTENT_NOTE =
  'Fixture content — the generation pipeline is not implemented yet. Nothing has been generated or published.';

export const FIXTURE_HISTORY_NOTE =
  'Fixture history — these publication records are sample data for the UI; no real post was made.';

export const FIXTURE_IMAGE_COUNT_NOTE =
  'Placeholder selection derived deterministically from the slot key. Real random selection happens in the content-generation part.';

/* -------------------------------------------------------------------------- */
/*  Image count selection                                                     */
/* -------------------------------------------------------------------------- */

/** FNV-1a: tiny, dependency-free, stable across processes and platforms. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic image count for a slot under a policy.
 *
 * `random_1_or_2` maps the slot key to 1 or 2 via a stable hash, so repeated
 * refreshes/retries for the SAME slot always return the SAME count, while
 * different slots differ. Both destinations share this single value.
 */
export function selectImageCount(slotKey: string, policy: ImageCountPolicy): number {
  if (policy === 'one') {
    return 1;
  }
  if (policy === 'two') {
    return 2;
  }
  return (fnv1a(slotKey) % 2) + 1;
}

/* -------------------------------------------------------------------------- */
/*  Fixture product + caption                                                 */
/* -------------------------------------------------------------------------- */

/** Clearly-marked sample product. No price, discount or commission is invented. */
export const FIXTURE_PRODUCT = {
  name: 'Tumbler Stainless 500 ml (contoh fixture)',
  affiliateUrl: 'https://shopee.co.id/contoh-tumbler-fixture?afrom=FIXTURE',
  source: FIXTURE_SOURCE,
} as const;

const FIXTURE_HOOK = ' lagi cari tumbler yang ringkas buat dibawa tiap hari?';
const FIXTURE_BODY =
  'Produk contoh ini berukuran 500 ml dan mudah dibawa ke kantor atau kampus. ' +
  'Sebelum memutuskan, cek detail bahan, dimensi, dan ulasan pembeli langsung di halaman Shopee.';
const FIXTURE_CTA = 'Klik link di bawah untuk lihat detail dan harga terbaru di Shopee.';
const FIXTURE_HASHTAGS = ['#tumbler', '#shopeeaffiliate', '#rekomendasishopee'];

/** Fixture caption as the generator would return it (hook/body/cta/hashtags). */
export function fixtureCaption(affiliateUrl: string = FIXTURE_PRODUCT.affiliateUrl): GeneratedCaption {
  const fullText = [
    FIXTURE_HOOK,
    '',
    FIXTURE_BODY,
    FIXTURE_CTA,
    '',
    FIXTURE_HASHTAGS.join(' '),
    affiliateUrl,
  ].join('\n');

  return {
    hook: FIXTURE_HOOK,
    body: FIXTURE_BODY,
    cta: FIXTURE_CTA,
    hashtags: FIXTURE_HASHTAGS,
    fullText,
    embeddedUrl: affiliateUrl,
    model: 'fixture',
    estimatedCostUsd: null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Content preview                                                           */
/* -------------------------------------------------------------------------- */

export interface ContentPreviewPlatform {
  readonly enabled: boolean;
  /** Nothing has been published for this slot yet. */
  readonly status: 'not_attempted';
  readonly url: null;
  readonly detail: string;
}

export interface ContentPreviewValidation {
  /** The rules were really evaluated; only the TEXT is fixture data. */
  readonly source: 'real_validator_on_fixture_text';
  readonly passed: boolean;
  readonly blocking: ReadonlyArray<{ rule: string; message: string }>;
  readonly warnings: ReadonlyArray<{ rule: string; message: string }>;
  readonly platformsChecked: readonly string[];
}

export interface ContentPreview {
  readonly source: typeof FIXTURE_SOURCE;
  readonly note: string;
  readonly slotKey: string;
  readonly imageCountPolicy: ImageCountPolicy;
  /** ONE count shared by every destination — never per-platform. */
  readonly imageCount: number;
  readonly imageCountSource: 'fixture_placeholder';
  readonly imageCountNote: string;
  readonly imageCountShared: true;
  readonly imageCountStable: true;
  readonly product: typeof FIXTURE_PRODUCT;
  readonly caption: {
    readonly source: typeof FIXTURE_SOURCE;
    readonly fullText: string;
    readonly hashtags: readonly string[];
  };
  readonly validation: ContentPreviewValidation;
  readonly platforms: {
    readonly facebook: ContentPreviewPlatform;
    readonly threads: ContentPreviewPlatform;
  };
}

function summarise(issues: readonly ValidationIssue[]): {
  blocking: Array<{ rule: string; message: string }>;
  warnings: Array<{ rule: string; message: string }>;
} {
  return {
    blocking: issues
      .filter((i) => i.severity === 'error')
      .map((i) => ({ rule: i.rule, message: i.message })),
    warnings: issues
      .filter((i) => i.severity === 'warning')
      .map((i) => ({ rule: i.rule, message: i.message })),
  };
}

/**
 * Build the content preview for a slot.
 *
 * Deterministic: identical inputs always produce an identical payload, which
 * is what makes "the selected image count stays stable on refresh" true.
 */
export function buildContentPreview(
  slotKey: string,
  settings: AutomationSettings = DEFAULT_AUTOMATION_SETTINGS,
): ContentPreview {
  const imageCount = selectImageCount(slotKey, settings.imageCountPolicy);
  const caption = fixtureCaption();

  const checkedPlatforms: string[] = [];
  const blocking: Array<{ rule: string; message: string }> = [];
  const warnings: Array<{ rule: string; message: string }> = [];

  const platformList: Array<'facebook_page' | 'threads'> = [
    ...(settings.facebookEnabled ? (['facebook_page'] as const) : []),
    ...(settings.threadsEnabled ? (['threads'] as const) : []),
  ];

  for (const platform of platformList) {
    const issues = validateCaption({
      caption,
      requiredAffiliateUrl: FIXTURE_PRODUCT.affiliateUrl,
      platform,
    });
    const summary = summarise(issues);
    checkedPlatforms.push(platform);
    for (const issue of summary.blocking) {
      if (!blocking.some((b) => b.rule === issue.rule)) {
        blocking.push(issue);
      }
    }
    for (const issue of summary.warnings) {
      if (!warnings.some((w) => w.rule === issue.rule)) {
        warnings.push(issue);
      }
    }
  }

  const platformDetail = (label: string): ContentPreviewPlatform => ({
    enabled: label === 'facebook' ? settings.facebookEnabled : settings.threadsEnabled,
    status: 'not_attempted',
    url: null,
    detail: settings.imageCountPolicy === 'random_1_or_2'
      ? `${imageCount} image(s) reserved for this slot; publication is not implemented yet.`
      : `${imageCount} image(s) for this slot; publication is not implemented yet.`,
  });

  return {
    source: FIXTURE_SOURCE,
    note: FIXTURE_CONTENT_NOTE,
    slotKey,
    imageCountPolicy: settings.imageCountPolicy,
    imageCount,
    imageCountSource: 'fixture_placeholder',
    imageCountNote: FIXTURE_IMAGE_COUNT_NOTE,
    imageCountShared: true,
    imageCountStable: true,
    product: FIXTURE_PRODUCT,
    caption: {
      source: FIXTURE_SOURCE,
      fullText: caption.fullText,
      hashtags: caption.hashtags,
    },
    validation: {
      source: 'real_validator_on_fixture_text',
      passed: blocking.length === 0,
      blocking,
      warnings,
      platformsChecked: checkedPlatforms,
    },
    platforms: {
      facebook: platformDetail('facebook'),
      threads: platformDetail('threads'),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Publishing history                                                        */
/* -------------------------------------------------------------------------- */

export type FixturePublishStatus = 'published' | 'failed' | 'not_attempted';

export interface FixturePlatformResult {
  readonly status: FixturePublishStatus;
  readonly url: string | null;
  readonly error: string | null;
}

export interface PublishRecord {
  readonly source: typeof FIXTURE_SOURCE;
  readonly id: string;
  readonly slotKey: string;
  readonly publishedAt: string;
  readonly productName: string;
  /** Shared across both destinations — never randomized per platform. */
  readonly imageCount: number;
  readonly facebook: FixturePlatformResult;
  readonly threads: FixturePlatformResult;
  readonly retry: {
    readonly status: 'none' | 'pending' | 'exhausted';
    readonly attempts: number;
    readonly maxAttempts: number;
  };
}

/** Truncate an instant to the top of its hour, so refreshes are stable. */
function floorHour(now: Date): Date {
  return new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
}

/**
 * Sample publishing history covering the three outcome shapes the UI must
 * render: both platforms OK, one platform failed with a pending retry, and a
 * platform that was never attempted.
 */
export function buildPublishHistory(
  settings: AutomationSettings = DEFAULT_AUTOMATION_SETTINGS,
  now: Date = new Date(),
): PublishRecord[] {
  const base = floorHour(now).getTime();
  const hour = (offset: number): string => new Date(base - offset * 3_600_000).toISOString();

  const draft = [
    {
      slotSuffix: 'A',
      offsetHours: 1,
      facebook: {
        status: 'published' as const,
        url: 'https://www.facebook.com/permalink.php?fixture=1',
        error: null,
      },
      threads: {
        status: 'published' as const,
        url: 'https://www.threads.net/@fixture/post/FIXTURE1',
        error: null,
      },
      retry: { status: 'none' as const, attempts: 0, maxAttempts: 3 },
    },
    {
      slotSuffix: 'B',
      offsetHours: 2,
      facebook: {
        status: 'published' as const,
        url: 'https://www.facebook.com/permalink.php?fixture=2',
        error: null,
      },
      threads: {
        status: 'failed' as const,
        url: null,
        error: 'Threads container was not published (sample error, fixture only).',
      },
      retry: { status: 'pending' as const, attempts: 1, maxAttempts: 3 },
    },
    {
      slotSuffix: 'C',
      offsetHours: 3,
      facebook: {
        status: 'failed' as const,
        url: null,
        error: 'Page token rejected (sample error, fixture only).',
      },
      threads: {
        status: 'not_attempted' as const,
        url: null,
        error: null,
      },
      retry: { status: 'exhausted' as const, attempts: 3, maxAttempts: 3 },
    },
  ];

  return draft.map((entry, index) => {
    const slotKey = `fixture-${entry.slotSuffix}`;
    return {
      source: FIXTURE_SOURCE,
      id: `fixture-${index + 1}`,
      slotKey,
      publishedAt: hour(entry.offsetHours),
      productName: FIXTURE_PRODUCT.name,
      imageCount: selectImageCount(slotKey, settings.imageCountPolicy),
      facebook: entry.facebook,
      threads: entry.threads,
      retry: entry.retry,
    };
  });
}
