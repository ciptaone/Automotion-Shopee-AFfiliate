/**
 * Product eligibility + category identity (Part 3).
 *
 * Eligibility answers one question: may this imported product be considered
 * for automatic content generation? The rules are deliberately conservative
 * and derived ONLY from data actually present in the feed — nothing is
 * inferred or fabricated:
 *
 *  - a REAL affiliate link must exist (the importer falls back to the plain
 *    product URL, which is fine for display but NOT sufficient for publishing:
 *    a post without a tracking link earns nothing and must not be treated as
 *    monetized content),
 *  - the product must have a name and a valid http(s) destination URL.
 *
 * Reference imagery is NOT part of catalog eligibility: a product without an
 * image may become image-able after a later import. The pipeline blocks such
 * a slot with an explicit `missing_reference_image` blocker instead.
 */

export interface EligibilityResult {
  readonly eligible: boolean;
  /** Machine-readable reasons; empty when eligible. */
  readonly reasons: readonly string[];
}

/** A stable, URL/JSON-safe identifier derived from a category display name. */
export function normalizeCategoryId(displayName: string): string {
  return String(displayName ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'uncategorized';
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface EligibilityInput {
  readonly name: string;
  readonly productUrl: string;
  /** The affiliate URL as it will be published (verbatim). */
  readonly affiliateUrl: string;
  /** False when the feed supplied no affiliate column/value and the URL is the plain product link. */
  readonly hasAffiliateLink: boolean;
}

/**
 * Evaluate catalog eligibility. Pure and deterministic.
 *
 * `hasAffiliateLink=false` marks the product ineligible for automatic
 * publishing: publishing a non-tracked link as affiliate content would be a
 * misleading monetization claim.
 */
export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const reasons: string[] = [];

  if (input.name.trim().length === 0) {
    reasons.push('missing_name');
  }
  if (!isHttpUrl(input.productUrl)) {
    reasons.push('invalid_product_url');
  }
  if (!isHttpUrl(input.affiliateUrl)) {
    reasons.push('invalid_affiliate_url');
  } else if (!input.hasAffiliateLink) {
    // The URL is technically valid but is only the plain product link — the
    // feed provided no affiliate/deeplink column value for this row.
    reasons.push('missing_affiliate_link');
  }

  return { eligible: reasons.length === 0, reasons };
}
