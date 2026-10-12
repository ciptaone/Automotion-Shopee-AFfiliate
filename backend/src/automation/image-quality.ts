/**
 * Image quality evaluation contract (Part 3).
 *
 * HONEST LIMITATIONS — read before relying on this module:
 *  - These checks are STRUCTURAL and HEURISTIC. They verify what can be
 *    verified without a paid vision model: file integrity, format, dimensions,
 *    size budget, vertical composition, and whether two assets in one slot
 *    are byte-duplicates.
 *  - They do NOT prove product identity similarity, packaging fidelity, or
 *    hand/anatomy realism. A successful image-provider response is NOT proof
 *    of fidelity, and no pipeline output may claim otherwise.
 *  - A future part may add a vision-based similarity scorer behind this same
 *    interface; until then `automatedFidelityScore` stays null and the
 *    publish gate relies only on the structural rules below plus the
 *    reference-image requirement (a slot without a reference image is
 *    BLOCKED, not generated).
 *
 * Duplicate detection: two assets of one slot must never be the same image.
 * We compare SHA-256 checksums; identical checksums fail the set.
 */
import { createHash } from 'node:crypto';
import type { GeneratedImage } from '../contracts/index.js';
import { validateImage } from '../pipeline/content-validation.js';
import type { ValidationIssue } from '../core/errors.js';

export interface ImageQualityInput {
  readonly images: readonly GeneratedImage[];
  /** Publicly reachable URL of the real product reference (null => blocked upstream). */
  readonly referenceImageUrl: string | null;
}

/** PART 4 — a single named dimension of the assessment. */
export type ImageCheckDimension =
  | 'format'
  | 'file_size'
  | 'dimensions'
  | 'composition'
  | 'distinctness'
  | 'product_identity'
  | 'packaging_fidelity'
  | 'main_color'
  | 'anatomy_realism'
  | 'lighting'
  | 'generation_artifacts';

/**
 * PART 4 — typed assessment of ONE dimension.
 *
 * `method` is the honesty hinge:
 *  - 'structural' — asserted deterministically from the file bytes/metadata,
 *  - 'heuristic'  — a cheap, imperfect proxy (e.g. byte-duplicate detection),
 *  - 'not_assessed' — NO reliable automated check exists; `automatedScore` is
 *    null and `reason` explains why. This is the honest state for every
 *    visual-fidelity dimension until a vision model is wired in.
 */
export interface ImageDimensionCheck {
  readonly dimension: ImageCheckDimension;
  readonly method: 'structural' | 'heuristic' | 'not_assessed';
  readonly passed: boolean | null; // null === not assessed
  readonly automatedScore: number | null; // always null for 'not_assessed'
  readonly reason: string;
}

export interface ImageQualityResult {
  /** True when every structural rule passed AND the set has no duplicates. */
  readonly passed: boolean;
  readonly issues: readonly ValidationIssue[];
  /** Always null in Part 3/4: no vision-based fidelity scorer is implemented. */
  readonly automatedFidelityScore: null;
  readonly limitations: string;
  readonly checksums: readonly string[];
  /** PART 4 — per-dimension typed assessment (structural vs visual). */
  readonly checks: readonly ImageDimensionCheck[];
}

export const QUALITY_LIMITATIONS =
  'Structural checks only (format, size, dimensions, composition, duplicate bytes). ' +
  'Product identity, packaging fidelity and anatomy realism are NOT automatically verified.';

/** Why every visual-fidelity dimension is `not_assessed` in Part 3/4. */
export const NO_VISION_SCORER_REASON =
  'No vision-based fidelity scorer is configured; an image-generation API returning ' +
  'successfully does NOT prove the image depicts the correct product.';

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Evaluate a generated image set for one slot.
 *
 * Rules:
 *  1. every image passes `validateImage` (non-empty, JPEG/PNG, ≤8 MB, min
 *     dimensions, vertical preference, aspect limit),
 *  2. no two images in the set share a checksum (image 2 must be a genuinely
 *     different view, never a duplicate of image 1),
 *  3. a reference image URL must exist (product fidelity anchor).
 */
export function evaluateImageQuality(input: ImageQualityInput): ImageQualityResult {
  const issues: ValidationIssue[] = [];
  const checksums: string[] = [];

  if (!input.referenceImageUrl) {
    issues.push({
      rule: 'image.reference_present',
      message:
        'No product reference image is available; generation without a fidelity anchor is blocked.',
      severity: 'error',
    });
  }

  input.images.forEach((image, index) => {
    for (const issue of validateImage({ image })) {
      issues.push({
        ...issue,
        rule: `image[${index + 1}].${issue.rule}`,
      });
    }
    checksums.push(sha256(image.bytes));
  });

  // Duplicate detection within the set.
  const seen = new Map<string, number>();
  let hasDuplicates = false;
  checksums.forEach((checksum, index) => {
    const firstIndex = seen.get(checksum);
    if (firstIndex !== undefined) {
      hasDuplicates = true;
      issues.push({
        rule: 'image.no_duplicates',
        message: `Image ${index + 1} is byte-identical to image ${firstIndex + 1}; two-image slots require distinct views.`,
        severity: 'error',
      });
    } else {
      seen.set(checksum, index);
    }
  });

  const structuralErrors = issues.filter((issue) => issue.severity === 'error');
  const structuralPassed = structuralErrors.length === 0;

  return {
    passed: structuralPassed,
    issues,
    automatedFidelityScore: null,
    limitations: QUALITY_LIMITATIONS,
    checksums,
    checks: buildDimensionChecks(input, hasDuplicates),
  };
}

/** Derive the typed per-dimension checks from the structural results. */
function buildDimensionChecks(
  input: ImageQualityInput,
  hasDuplicates: boolean,
): ImageDimensionCheck[] {
  const structural = (
    dimension: ImageCheckDimension,
    passed: boolean,
    reason: string,
  ): ImageDimensionCheck => ({
    dimension,
    method: 'structural',
    passed,
    automatedScore: null,
    reason,
  });

  const notAssessed = (
    dimension: ImageCheckDimension,
    reason: string = NO_VISION_SCORER_REASON,
  ): ImageDimensionCheck => ({
    dimension,
    method: 'not_assessed',
    passed: null,
    automatedScore: null,
    reason,
  });

  return [
    structural(
      'format',
      input.images.every((i) => i.mimeType === 'image/jpeg' || i.mimeType === 'image/png'),
      'MIME type must be image/jpeg or image/png.',
    ),
    structural(
      'file_size',
      input.images.every((i) => i.bytes.byteLength > 0 && i.bytes.byteLength <= 8 * 1024 * 1024),
      'Non-empty and within the 8 MB platform limit.',
    ),
    structural(
      'dimensions',
      input.images.every((i) => i.width >= 320 && i.height >= 320 && i.height / i.width <= 10),
      'Minimum 320x320 and aspect ratio within the 10:1 platform limit.',
    ),
    structural(
      'composition',
      input.images.every((i) => i.height >= i.width),
      'Locked spec targets a vertical (portrait) composition.',
    ),
    {
      dimension: 'distinctness',
      method: 'heuristic',
      passed: !hasDuplicates,
      automatedScore: null,
      reason:
        input.images.length < 2
          ? 'Single-image slot; distinctness applies only to two-image sets.'
          : 'Byte-duplicate detection via SHA-256. Catches identical files, NOT visually-similar-but-distinct renders.',
    },
    notAssessed('product_identity'),
    notAssessed('packaging_fidelity'),
    notAssessed('main_color'),
    notAssessed('anatomy_realism'),
    notAssessed('lighting'),
    notAssessed('generation_artifacts'),
  ];
}
