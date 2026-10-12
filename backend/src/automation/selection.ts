/**
 * Product selection policy (Part 3).
 *
 * Two typed modes:
 *  - `auto`                — select across ALL eligible imported products.
 *  - `selected_categories` — select ONLY within the operator's chosen
 *    categories. When none of them holds an eligible product the slot is
 *    SKIPPED with an explicit reason — it NEVER silently falls back to auto.
 *
 * Scoring is transparent and configurable, but deliberately humble: it ranks
 * data quality and diversity signals that are actually present in the catalog
 * (affiliate link, reference image, category, rating, sold count). It does NOT
 * claim to predict sales, and no output of this module may be presented as a
 * sales forecast.
 *
 * Controlled randomization: candidates are scored, grouped into a top band,
 * and one is drawn with the INJECTED random source. Tests inject a seeded PRNG
 * so selection is fully deterministic; production uses a seeded-by-slot PRNG
 * so the same (slot, catalog, policy) triple always resolves the same way —
 * which is what keeps retries stable.
 */
import type { CatalogProduct } from '../catalog/catalog.js';

export const SELECTION_MODES = ['auto', 'selected_categories'] as const;
export type SelectionMode = (typeof SELECTION_MODES)[number];

export interface SelectionPolicy {
  readonly mode: SelectionMode;
  /** Stable category ids (only meaningful in `selected_categories` mode). */
  readonly selectedCategoryIds: readonly string[];
  /** Exclude products whose reference image is missing (default true). */
  readonly requireReferenceImage: boolean;
}

export const DEFAULT_SELECTION_POLICY: SelectionPolicy = {
  mode: 'auto',
  selectedCategoryIds: [],
  requireReferenceImage: true,
};

/**
 * Scoring weights. Configurable so operators can retune without code changes
 * later; the defaults favor data quality + diversity over unverifiable
 * signals. Commission/price weights only apply when the feed actually
 * provided those numbers.
 */
export interface SelectionWeights {
  readonly hasAffiliateLink: number;
  readonly hasReferenceImage: number;
  readonly hasCategory: number;
  readonly hasPrice: number;
  readonly hasCommission: number;
  readonly rating: number;
  readonly soldCount: number;
  /** Penalty per same-category product used within the recent window. */
  readonly categoryRepetitionPenalty: number;
  /** Penalty when this exact product was used recently. */
  readonly recentProductPenalty: number;
}

export const DEFAULT_SELECTION_WEIGHTS: SelectionWeights = {
  hasAffiliateLink: 40,
  hasReferenceImage: 30,
  hasCategory: 10,
  hasPrice: 5,
  hasCommission: 5,
  rating: 10,
  soldCount: 10,
  categoryRepetitionPenalty: 25,
  recentProductPenalty: 100,
};

/** Top-scoring candidates (within a band) that the draw may pick from. */
export const DEFAULT_TOP_BAND = 5;

export interface SelectionContext {
  readonly policy: SelectionPolicy;
  readonly weights?: SelectionWeights;
  /** How many recent products/categories to penalize. */
  readonly recentMemory?: number;
  /** Internal ids of recently used products (most recent first). */
  readonly recentProductIds?: readonly string[];
  /** Category ids of recently used slots (most recent first). */
  readonly recentCategoryIds?: readonly string[];
  /** Deterministic random source in [0, 1). Injected for tests. */
  readonly random: () => number;
  readonly topBand?: number;
}

export type SelectionOutcome =
  | {
      readonly status: 'selected';
      readonly product: CatalogProduct;
      readonly score: number;
      /** Score breakdown, for the preview/debug surface. */
      readonly signals: Readonly<Record<string, number>>;
      readonly considered: number;
    }
  | {
      readonly status: 'skipped';
      readonly code:
        | 'empty_catalog'
        | 'no_eligible_products'
        | 'no_eligible_products_in_selected_categories'
        | 'unknown_categories';
      readonly message: string;
      /** Categories that were requested but do not exist in the catalog. */
      readonly unknownCategoryIds?: readonly string[];
      readonly considered: number;
    };

/* -------------------------------------------------------------------------- */
/*  Scoring                                                                   */
/* -------------------------------------------------------------------------- */

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface ScoredProduct {
  readonly product: CatalogProduct;
  readonly score: number;
  readonly signals: Record<string, number>;
}

/** Score one eligible product. Pure and deterministic. */
export function scoreProduct(
  product: CatalogProduct,
  context: Pick<SelectionContext, 'weights' | 'recentProductIds' | 'recentCategoryIds' | 'recentMemory'>,
): ScoredProduct {
  const weights = context.weights ?? DEFAULT_SELECTION_WEIGHTS;
  const memory = context.recentMemory ?? 6;
  const signals: Record<string, number> = {};

  signals['hasAffiliateLink'] = product.hasAffiliateLink ? weights.hasAffiliateLink : 0;
  signals['hasReferenceImage'] = product.imageUrl ? weights.hasReferenceImage : 0;
  signals['hasCategory'] = product.categoryId ? weights.hasCategory : 0;
  signals['hasPrice'] = product.price !== null ? weights.hasPrice : 0;
  signals['hasCommission'] = product.commissionRate !== null ? weights.hasCommission : 0;

  // Normalized quality signals in [0, 1] * weight. Rating is out of 5; sold
  // count uses a soft log scale so a single viral product cannot dominate.
  signals['rating'] = product.rating !== null ? clamp(product.rating / 5, 0, 1) * weights.rating : 0;
  signals['soldCount'] =
    product.soldCount !== null && product.soldCount > 0
      ? clamp(Math.log10(product.soldCount + 1) / 5, 0, 1) * weights.soldCount
      : 0;

  const recentCategories = (context.recentCategoryIds ?? []).slice(0, memory);
  const categoryHits = product.categoryId
    ? recentCategories.filter((id) => id === product.categoryId).length
    : 0;
  signals['categoryRepetition'] = -categoryHits * weights.categoryRepetitionPenalty;

  const recentProducts = (context.recentProductIds ?? []).slice(0, memory);
  const productHits = recentProducts.filter((id) => id === product.internalId).length;
  signals['recentProduct'] = -productHits * weights.recentProductPenalty;

  const score = Object.values(signals).reduce((sum, value) => sum + value, 0);
  return { product, score, signals };
}

/* -------------------------------------------------------------------------- */
/*  Selection                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Choose the product for a content slot.
 *
 * Determinism contract: given the SAME catalog, policy, recent-memory and a
 * random source producing the SAME sequence, the outcome is identical. The
 * pipeline persists the outcome per slot, so even a divergent re-run cannot
 * silently change what was reserved.
 */
export function selectProduct(
  catalog: readonly CatalogProduct[],
  context: SelectionContext,
): SelectionOutcome {
  const { policy } = context;

  if (catalog.length === 0) {
    return {
      status: 'skipped',
      code: 'empty_catalog',
      message:
        'The product catalog is empty. Import a Shopee Affiliate feed before starting automation.',
      considered: 0,
    };
  }

  let candidates = catalog.filter((p) => p.eligible);

  if (policy.mode === 'selected_categories') {
    const requested = [...new Set(policy.selectedCategoryIds)];
    if (requested.length === 0) {
      // Defensive: settings validation should prevent this combination.
      return {
        status: 'skipped',
        code: 'no_eligible_products_in_selected_categories',
        message: 'Selected-categories mode is active but no category is selected.',
        considered: 0,
      };
    }
    const known = new Set(catalog.map((p) => p.categoryId).filter((id): id is string => Boolean(id)));
    const unknown = requested.filter((id) => !known.has(id));
    const requestedSet = new Set(requested);
    candidates = candidates.filter((p) => p.categoryId && requestedSet.has(p.categoryId));

    if (candidates.length === 0) {
      // NEVER fall back to auto: an explicit operator choice wins over
      // convenience. The slot is skipped and the reason is surfaced.
      if (unknown.length === requested.length) {
        return {
          status: 'skipped',
          code: 'unknown_categories',
          message:
            'None of the selected categories exists in the imported catalog. Re-import the feed or update the category selection.',
          unknownCategoryIds: unknown,
          considered: 0,
        };
      }
      return {
        status: 'skipped',
        code: 'no_eligible_products_in_selected_categories',
        message:
          'No eligible product is available in the selected categories. The slot is skipped (no fallback to Auto).',
        unknownCategoryIds: unknown.length > 0 ? unknown : undefined,
        considered: 0,
      };
    }
  }

  if (candidates.length === 0) {
    return {
      status: 'skipped',
      code: 'no_eligible_products',
      message: 'The catalog contains no eligible products (check affiliate links and product URLs).',
      considered: 0,
    };
  }

  if (policy.requireReferenceImage) {
    candidates = candidates.filter((p) => Boolean(p.imageUrl));
    if (candidates.length === 0) {
      return {
        status: 'skipped',
        code: 'no_eligible_products',
        message:
          'Eligible products exist but none has a reference image; image generation would risk an unrelated result, so the slot is skipped.',
        considered: 0,
      };
    }
  }

  const scored = candidates
    .map((product) => scoreProduct(product, context))
    // Tie-break on the STABLE product identity (marketplace + source id), never
    // on `internalId`: that value is a per-instance UUID, so breaking ties with
    // it made two catalog loads of the same feed choose different products for
    // the same slot key — non-deterministic selection across restarts/imports.
    .sort(
      (a, b) =>
        b.score - a.score ||
        `${a.product.marketplace}:${a.product.sourceProductId}`.localeCompare(
          `${b.product.marketplace}:${b.product.sourceProductId}`,
        ) ||
        a.product.internalId.localeCompare(b.product.internalId),
    );

  const band = Math.max(1, context.topBand ?? DEFAULT_TOP_BAND);
  const topScore = scored[0]?.score ?? 0;
  // Include every candidate whose score is within a small margin of the best,
  // capped to the band size, so randomization operates among strong options.
  const bandCandidates = scored
    .filter((entry) => entry.score >= topScore - Math.abs(topScore) * 0.15)
    .slice(0, band);

  const index = Math.min(
    bandCandidates.length - 1,
    Math.floor(context.random() * bandCandidates.length),
  );
  const chosen = bandCandidates[index] ?? bandCandidates[0];
  if (!chosen) {
    // Unreachable given the length checks above; kept for exhaustiveness.
    return {
      status: 'skipped',
      code: 'no_eligible_products',
      message: 'No candidate survived scoring.',
      considered: scored.length,
    };
  }

  return {
    status: 'selected',
    product: chosen.product,
    score: chosen.score,
    signals: chosen.signals,
    considered: scored.length,
  };
}

/* -------------------------------------------------------------------------- */
/*  Deterministic PRNG for slot-seeded draws                                  */
/* -------------------------------------------------------------------------- */

/** mulberry32: tiny, dependency-free, deterministic from a 32-bit seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a: stable slot-key -> 32-bit seed. */
export function slotSeed(slotKey: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < slotKey.length; i += 1) {
    hash ^= slotKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
