/**
 * Publish-gate content validation.
 *
 * Per the locked product decisions, AUTOMATIC PUBLICATION IS ALLOWED ONLY AFTER
 * ALL CONTENT VALIDATIONS PASS. This module is that gate. It returns a list of
 * issues; a result containing any `severity: 'error'` issue MUST block publish.
 *
 * Two categories of rule are enforced:
 *  1. Structural rules (deterministic, testable): caption length, CTA presence,
 *     hashtag count, and the affiliate link appearing VERBATIM in the text.
 *  2. Fabrication-guard rules (heuristic): detect claims the copy is forbidden to
 *     make — testimonials, invented discounts, invented commission values, and
 *     first-person usage experiences. These are heuristic detectors; a `warning`
 *     is surfaced for human review, and an `error` for high-confidence matches.
 *
 * These detectors are intentionally conservative: they only flag text that uses
 * explicit fabricated-claim markers. They are NOT a substitute for human review
 * in production, and the feasibility report documents that limitation.
 */
import type { GeneratedCaption, GeneratedImage } from '../contracts/index.js';
import type { ValidationIssue } from '../core/errors.js';

export interface CaptionValidationInput {
  readonly caption: GeneratedCaption;
  /** The affiliate URL that MUST appear verbatim in the published text. */
  readonly requiredAffiliateUrl: string;
  /** Destination platform constraints. */
  readonly platform: 'facebook_page' | 'threads';
}

export interface ImageValidationInput {
  readonly image: GeneratedImage;
  /** Locked visual spec targets a vertical, commercial-quality composition. */
  readonly minWidth?: number;
  readonly minHeight?: number;
  readonly requireVertical?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Forbidden-claim detectors                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Heuristic markers of fabricated claims (Indonesian + English).
 * Matched case-insensitively against the caption text.
 */
const TESTIMONIAL_MARKERS = [
  /\bsaya (sudah|pernah) (pakai|pake|coba|beli)\b/i,
  /\baku (sudah|pernah) (pakai|pake|coba|beli)\b/i,
  /\b(pengalaman|testimoni) (saya|aku|gue|gw)\b/i,
  /\bmenurut saya\b/i,
  /\bbanget banget\b/i,
  /\bbest (product|purchase)\b/i,
  /\bi've been using\b/i,
  /\breal (review|testimony)\b/i,
];

const DISCOUNT_MARKERS = [
  /\b(diskon|promo|sale|potongan|hemat|cuci gudang)\b.{0,25}\b\d{1,2}\s?%/i,
  /\b\d{1,2}\s?%\s?(off|diskon|potongan)\b/i,
  /\b(gratis ongkir|hanya hari ini|flash sale|limited offer)\b/i,
  /\brp\s?\d[\d.,]*\s?(saja|aja|aja)\b/i,
];

const COMMISSION_MARKERS = [
  /\b(komisi|commission)\b.{0,25}\b\d{1,2}(\.\d+)?\s?%/i,
  /\bkomisi\s?(sampai|hingga|max|tertinggi)\b/i,
  /\bearn\s?(up to\s?)?\$\d/i,
];

/* -------------------------------------------------------------------------- */
/*  Caption validation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Threads hard limit: 500 characters (emojis counted as UTF-8 bytes upstream,
 * so we additionally guard the byte length).
 */
const THREADS_MAX_CHARS = 500;
const THREADS_MAX_BYTES = 500;
/** Facebook Page post text limit (practical maximum). */
const FACEBOOK_MAX_CHARS = 63206;
const FACEBOOK_MIN_CHARS = 1;

const MAX_HASHTAGS = 10;
const MIN_HASHTAGS = 1;
const EMOJI_MIN = 0;
const EMOJI_MAX = 8;

export function validateCaption(input: CaptionValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { caption, platform, requiredAffiliateUrl } = input;
  const text = caption.fullText ?? '';

  /* --- Structural: non-empty --- */
  if (text.trim().length === 0) {
    issues.push({ rule: 'caption.not_empty', message: 'Caption is empty.', severity: 'error' });
    return issues;
  }

  /* --- Structural: length --- */
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (platform === 'threads') {
    if (text.length > THREADS_MAX_CHARS || byteLength > THREADS_MAX_BYTES) {
      issues.push({
        rule: 'caption.threads_length',
        message: `Threads caption is ${text.length} chars / ${byteLength} bytes; limit is ${THREADS_MAX_CHARS}.`,
        severity: 'error',
      });
    }
  } else if (text.length > FACEBOOK_MAX_CHARS || text.length < FACEBOOK_MIN_CHARS) {
    issues.push({
      rule: 'caption.facebook_length',
      message: `Facebook caption length ${text.length} is outside the allowed range.`,
      severity: 'error',
    });
  }

  /* --- Structural: hook present (first line is a hook) --- */
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  if (firstLine.trim().length < 5) {
    issues.push({
      rule: 'caption.hook_present',
      message: 'Caption has no discernible hook line.',
      severity: 'warning',
    });
  }

  /* --- Structural: CTA present --- */
  if (!CTA_PATTERN.test(text)) {
    issues.push({
      rule: 'caption.cta_present',
      message: 'Caption is missing a clear call-to-action.',
      severity: 'error',
    });
  }

  /* --- Structural: affiliate link appears VERBATIM --- */
  if (!requiredAffiliateUrl || requiredAffiliateUrl.trim().length === 0) {
    issues.push({
      rule: 'caption.required_url_provided',
      message: 'No required affiliate URL was supplied to validate against.',
      severity: 'error',
    });
  } else if (!text.includes(requiredAffiliateUrl)) {
    issues.push({
      rule: 'caption.affiliate_link_embedded',
      message: 'Affiliate URL does not appear verbatim in the caption.',
      severity: 'error',
    });
  }

  /* --- Consistency: generator must claim the same URL it embedded --- */
  if (caption.embeddedUrl && requiredAffiliateUrl && caption.embeddedUrl !== requiredAffiliateUrl) {
    issues.push({
      rule: 'caption.embedded_url_consistent',
      message: 'Generator-reported embedded URL differs from the required affiliate URL.',
      severity: 'error',
    });
  }

  /* --- Structural: hashtags --- */
  const hashtags = extractHashtags(text);
  if (hashtags.length < MIN_HASHTAGS) {
    issues.push({
      rule: 'caption.hashtag_minimum',
      message: `Caption has ${hashtags.length} hashtag(s); at least ${MIN_HASHTAGS} expected.`,
      severity: 'warning',
    });
  }
  if (hashtags.length > MAX_HASHTAGS) {
    issues.push({
      rule: 'caption.hashtag_maximum',
      message: `Caption has ${hashtags.length} hashtags; at most ${MAX_HASHTAGS} recommended.`,
      severity: 'warning',
    });
  }

  /* --- Structural: emoji moderation --- */
  const emojiCount = countEmoji(text);
  if (emojiCount > EMOJI_MAX) {
    issues.push({
      rule: 'caption.emoji_moderate',
      message: `Caption uses ${emojiCount} emoji; moderate usage is <= ${EMOJI_MAX}.`,
      severity: 'warning',
    });
  }
  if (emojiCount < EMOJI_MIN) {
    issues.push({
      rule: 'caption.emoji_minimum',
      message: 'Caption uses no emoji.',
      severity: 'warning',
    });
  }

  /* --- Fabrication guards --- */
  for (const [rule, pattern] of [['caption.no_testimonial', TESTIMONIAL_MARKERS]] as const) {
    for (const marker of pattern) {
      if (marker.test(text)) {
        issues.push({
          rule,
          message: `Caption appears to contain a fabricated testimonial/experience ("${marker.source.slice(0, 40)}").`,
          severity: 'error',
        });
        break;
      }
    }
  }

  for (const [rule, pattern] of [
    ['caption.no_invented_discount', DISCOUNT_MARKERS],
    ['caption.no_invented_commission', COMMISSION_MARKERS],
  ] as const) {
    for (const marker of pattern) {
      if (marker.test(text)) {
        issues.push({
          rule,
          message: `Caption may state an unverified promotion/figure ("${marker.source.slice(0, 40)}").`,
          severity: 'warning',
        });
        break;
      }
    }
  }

  /* --- Threads-specific link rules --- */
  if (platform === 'threads') {
    const linkCount = extractUrls(text).length;
    if (linkCount > 5) {
      issues.push({
        rule: 'caption.threads_link_limit',
        message: `Threads allows at most 5 unique links; caption has ${linkCount}.`,
        severity: 'error',
      });
    }
  }

  return issues;
}

const CTA_PATTERN =
  /\b(klik|cek|beli|pesan|checkout|order|lihat|dapatkan|grab|tap|shop now|check out|buy now|order now)\b/i;

/* -------------------------------------------------------------------------- */
/*  Image validation                                                           */
/* -------------------------------------------------------------------------- */

export function validateImage(input: ImageValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { image } = input;
  const minWidth = input.minWidth ?? 320;
  const minHeight = input.minHeight ?? 320;
  const requireVertical = input.requireVertical ?? true;

  if (!image.bytes || image.bytes.byteLength === 0) {
    issues.push({ rule: 'image.not_empty', message: 'Generated image has zero bytes.', severity: 'error' });
    return issues;
  }

  // Both Facebook and Threads cap images at 8 MB.
  const maxBytes = 8 * 1024 * 1024;
  if (image.bytes.byteLength > maxBytes) {
    issues.push({
      rule: 'image.file_size',
      message: `Image is ${(image.bytes.byteLength / 1024 / 1024).toFixed(2)} MB; platform limit is 8 MB.`,
      severity: 'error',
    });
  }

  if (image.mimeType !== 'image/jpeg' && image.mimeType !== 'image/png') {
    issues.push({
      rule: 'image.format',
      message: `Image mime type "${image.mimeType}" is not JPEG/PNG.`,
      severity: 'error',
    });
  }

  if (image.width < minWidth || image.height < minHeight) {
    issues.push({
      rule: 'image.min_dimensions',
      message: `Image ${image.width}x${image.height} is below minimum ${minWidth}x${minHeight}.`,
      severity: 'error',
    });
  }

  // Threads clamps width to [320, 1440]; flag extreme aspect ratios.
  if (requireVertical && image.height < image.width) {
    issues.push({
      rule: 'image.aspect_ratio_vertical',
      message: `Image is ${image.width}x${image.height} (landscape); locked spec targets vertical 9:16.`,
      severity: 'warning',
    });
  }
  if (image.width > 0) {
    const ratio = image.height / image.width;
    if (ratio > 10 || ratio < 0.1) {
      issues.push({
        rule: 'image.aspect_ratio_limit',
        message: `Aspect ratio ${ratio.toFixed(2)} exceeds the 10:1 platform limit.`,
        severity: 'error',
      });
    }
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function extractHashtags(text: string): string[] {
  const matches = text.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(matches.map((m) => m.toLowerCase()))];
}

const URL_PATTERN = /https?:\/\/[^\s<>"')]+/gi;

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_PATTERN) ?? [];
  return [...new Set(matches)];
}

/** Count emoji graphemes approximately (ranges covering common pictographs). */
const EMOJI_PATTERN =
  /[\u{1F1E6}-\u{1F1FF}]|[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{FE0F}]|[\u{1F900}-\u{1F9FF}]/gu;

export function countEmoji(text: string): number {
  const matches = text.match(EMOJI_PATTERN) ?? [];
  // Variation selectors shouldn't count on their own.
  return matches.filter((m) => m !== '\u{FE0F}').length;
}

/** Convenience: does this issue list block publication? */
export function blocksPublish(issues: readonly ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
