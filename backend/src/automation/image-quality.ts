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

export interface ImageQualityResult {
  /** True when every structural rule passed AND the set has no duplicates. */
  readonly passed: boolean;
  readonly issues: readonly ValidationIssue[];
  /** Always null in Part 3: no vision-based fidelity scorer is implemented. */
  readonly automatedFidelityScore: null;
  readonly limitations: string;
  readonly checksums: readonly string[];
}

export const QUALITY_LIMITATIONS =
  'Structural checks only (format, size, dimensions, composition, duplicate bytes). ' +
  'Product identity, packaging fidelity and anatomy realism are NOT automatically verified.';

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
  checksums.forEach((checksum, index) => {
    const firstIndex = seen.get(checksum);
    if (firstIndex !== undefined) {
      issues.push({
        rule: 'image.no_duplicates',
        message: `Image ${index + 1} is byte-identical to image ${firstIndex + 1}; two-image slots require distinct views.`,
        severity: 'error',
      });
    } else {
      seen.set(checksum, index);
    }
  });

  return {
    passed: issues.every((issue) => issue.severity !== 'error'),
    issues,
    automatedFidelityScore: null,
    limitations: QUALITY_LIMITATIONS,
    checksums,
  };
}
