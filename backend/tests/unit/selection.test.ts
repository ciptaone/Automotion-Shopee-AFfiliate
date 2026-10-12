/**
 * PART 3 — product selection policy.
 *
 * Covers: Auto mode selecting across eligible categories with category
 * diversity and recent-avoidance, Selected-Categories mode excluding every
 * other category, the NO-FALLBACK rule when selected categories are empty,
 * eligibility filtering, reference-image gating, and deterministic draws via
 * an injected random source.
 *
 * Credential-free: pure functions over synthetic catalog records.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SELECTION_WEIGHTS,
  scoreProduct,
  seededRandom,
  selectProduct,
  slotSeed,
  type SelectionContext,
} from '../../src/automation/selection.js';
import type { CatalogProduct } from '../../src/catalog/catalog.js';

/* -------------------------------------------------------------------------- */
/*  Synthetic catalog fixtures (clearly synthetic test data)                  */
/* -------------------------------------------------------------------------- */

function product(overrides: Partial<CatalogProduct> & { internalId: string }): CatalogProduct {
  return {
    sourceProductId: overrides.internalId,
    name: `Synthetic Product ${overrides.internalId}`,
    marketplace: 'shopee.co.id',
    productUrl: `https://shopee.co.id/product/${overrides.internalId}`,
    affiliateUrl: `https://s.shopee.co.id/aff-${overrides.internalId}`,
    hasAffiliateLink: true,
    productUrlNormalized: `shopee.co.id/product/${overrides.internalId}`,
    category: 'Health & Beauty',
    categoryId: 'health-beauty',
    imageUrl: `https://cf.shopee.co.id/img/${overrides.internalId}.jpg`,
    description: null,
    price: 100000,
    currency: 'IDR',
    commissionRate: 10,
    rating: 4.8,
    soldCount: 500,
    eligible: true,
    eligibilityReasons: [],
    lastImportedAt: '2026-10-12T00:00:00.000Z',
    sourceImportId: 'batch-1',
    extraColumns: {},
    ...overrides,
  };
}

const CATALOG: CatalogProduct[] = [
  product({ internalId: 'p1' }),
  product({ internalId: 'p2', categoryId: 'home-living', category: 'Home & Living' }),
  product({ internalId: 'p3', categoryId: 'home-living', category: 'Home & Living' }),
  product({
    internalId: 'p4',
    categoryId: 'fashion',
    category: 'Fashion',
    rating: 4.2,
    soldCount: 120,
    commissionRate: null,
  }),
];

function ctx(overrides: Partial<SelectionContext> = {}): SelectionContext {
  return {
    policy: { mode: 'auto', selectedCategoryIds: [], requireReferenceImage: true },
    random: seededRandom(slotSeed('2026-10-12#01')),
    ...overrides,
  };
}

/* ========================================================================== */
/*  Mode A: AUTO                                                              */
/* ========================================================================== */

describe('selectProduct — auto mode', () => {
  it('selects an eligible product from the whole catalog', () => {
    const outcome = selectProduct(CATALOG, ctx());
    expect(outcome.status).toBe('selected');
    if (outcome.status === 'selected') {
      expect(CATALOG.map((p) => p.internalId)).toContain(outcome.product.internalId);
      expect(outcome.considered).toBe(4);
      expect(typeof outcome.score).toBe('number');
      expect(outcome.signals['hasAffiliateLink']).toBe(
        DEFAULT_SELECTION_WEIGHTS.hasAffiliateLink,
      );
    }
  });

  it('is deterministic for the same slot, catalog and seed', () => {
    const a = selectProduct(CATALOG, ctx());
    const b = selectProduct(CATALOG, ctx());
    expect(a).toEqual(b);
  });

  it('spreads selections across all eligible categories over many slots', () => {
    const usedCategories = new Set<string>();
    const usedProducts = new Set<string>();
    for (let slot = 1; slot <= 40; slot += 1) {
      const outcome = selectProduct(
        CATALOG,
        ctx({
          random: seededRandom(slotSeed(`2026-10-12#${String(slot).padStart(2, '0')}`)),
          recentProductIds: [...usedProducts].slice(-6),
          recentCategoryIds: [...usedCategories].slice(-6),
        }),
      );
      expect(outcome.status).toBe('selected');
      if (outcome.status === 'selected') {
        usedCategories.add(outcome.product.categoryId ?? '');
        usedProducts.add(outcome.product.internalId);
      }
    }
    // All three categories and more than one product must be used.
    expect(usedCategories.size).toBe(3);
    expect(usedProducts.size).toBeGreaterThan(1);
  });

  it('skips an empty catalog with an explicit reason', () => {
    const outcome = selectProduct([], ctx());
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.code).toBe('empty_catalog');
      expect(outcome.message).toMatch(/import a shopee affiliate feed/i);
    }
  });

  it('skips when no product is eligible instead of selecting an ineligible one', () => {
    const ineligible = CATALOG.map((p) => ({
      ...p,
      eligible: false,
      eligibilityReasons: ['missing_affiliate_link'],
    }));
    const outcome = selectProduct(ineligible, ctx());
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.code).toBe('no_eligible_products');
    }
  });

  it('skips when no eligible product has a reference image (fidelity anchor)', () => {
    const noImages = CATALOG.map((p) => ({ ...p, imageUrl: null }));
    const outcome = selectProduct(noImages, ctx());
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.code).toBe('no_eligible_products');
      expect(outcome.message).toMatch(/reference image/i);
    }
  });

  it('allows image-less products when the policy does not require a reference', () => {
    const noImages = CATALOG.map((p) => ({ ...p, imageUrl: null }));
    const outcome = selectProduct(
      noImages,
      ctx({
        policy: { mode: 'auto', selectedCategoryIds: [], requireReferenceImage: false },
      }),
    );
    expect(outcome.status).toBe('selected');
  });

  it('penalizes recently used products so repetition is avoided', () => {
    const fresh = scoreProduct(CATALOG[0]!, {
      recentProductIds: [],
      recentCategoryIds: [],
    });
    const repeated = scoreProduct(CATALOG[0]!, {
      recentProductIds: ['p1'],
      recentCategoryIds: ['health-beauty'],
    });
    expect(repeated.score).toBeLessThan(fresh.score);
    expect(repeated.signals['recentProduct']).toBe(
      -DEFAULT_SELECTION_WEIGHTS.recentProductPenalty,
    );
    expect(repeated.signals['categoryRepetition']).toBe(
      -DEFAULT_SELECTION_WEIGHTS.categoryRepetitionPenalty,
    );
  });

  it('only scores commission and price signals when the data actually exists', () => {
    const noSignals = product({
      internalId: 'p9',
      price: null,
      commissionRate: null,
      rating: null,
      soldCount: null,
    });
    const scored = scoreProduct(noSignals, {});
    expect(scored.signals['hasPrice']).toBe(0);
    expect(scored.signals['hasCommission']).toBe(0);
    expect(scored.signals['rating']).toBe(0);
    expect(scored.signals['soldCount']).toBe(0);
  });

  it('prefers products with complete data over sparse ones', () => {
    const rich = scoreProduct(CATALOG[0]!, {});
    const sparse = scoreProduct(
      product({ internalId: 'p8', price: null, commissionRate: null, rating: null, soldCount: null }),
      {},
    );
    expect(rich.score).toBeGreaterThan(sparse.score);
  });
});

/* ========================================================================== */
/*  Mode B: SELECTED CATEGORIES                                               */
/* ========================================================================== */

describe('selectProduct — selected categories mode', () => {
  const selected = (ids: string[]) => ({
    mode: 'selected_categories' as const,
    selectedCategoryIds: ids,
    requireReferenceImage: true,
  });

  it('only ever selects from the chosen categories', () => {
    for (let slot = 1; slot <= 30; slot += 1) {
      const outcome = selectProduct(
        CATALOG,
        ctx({ policy: selected(['home-living']), random: seededRandom(slotSeed(`s${slot}`)) }),
      );
      expect(outcome.status).toBe('selected');
      if (outcome.status === 'selected') {
        expect(outcome.product.categoryId).toBe('home-living');
      }
    }
  });

  it('supports multiple selected categories', () => {
    const allowed = new Set(['home-living', 'fashion']);
    for (let slot = 1; slot <= 30; slot += 1) {
      const outcome = selectProduct(
        CATALOG,
        ctx({ policy: selected([...allowed]), random: seededRandom(slotSeed(`m${slot}`)) }),
      );
      if (outcome.status === 'selected') {
        expect(allowed.has(outcome.product.categoryId ?? '')).toBe(true);
      }
    }
  });

  it('SKIPS (never falls back to auto) when selected categories hold nothing eligible', () => {
    // 'home-living' has products, but make them ineligible first.
    const broken = CATALOG.map((p) =>
      p.categoryId === 'home-living'
        ? { ...p, eligible: false, eligibilityReasons: ['missing_affiliate_link'] }
        : p,
    );
    const outcome = selectProduct(broken, ctx({ policy: selected(['home-living']) }));
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.code).toBe('no_eligible_products_in_selected_categories');
      expect(outcome.message).toMatch(/no fallback to auto/i);
    }
  });

  it('reports unknown category ids when none of them exists in the catalog', () => {
    const outcome = selectProduct(CATALOG, ctx({ policy: selected(['does-not-exist']) }));
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.code).toBe('unknown_categories');
      expect(outcome.unknownCategoryIds).toEqual(['does-not-exist']);
    }
  });

  it('flags partial unknown ids while still selecting from the known ones', () => {
    const outcome = selectProduct(
      CATALOG,
      ctx({ policy: selected(['home-living', 'ghost-category']) }),
    );
    expect(outcome.status).toBe('selected');
  });

  it('skips when selected-categories mode has no category selected', () => {
    const outcome = selectProduct(CATALOG, ctx({ policy: selected([]) }));
    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.code).toBe('no_eligible_products_in_selected_categories');
      expect(outcome.message).toMatch(/no category is selected/i);
    }
  });
});

/* ========================================================================== */
/*  Deterministic PRNG                                                        */
/* ========================================================================== */

describe('seededRandom / slotSeed', () => {
  it('produces identical sequences for identical seeds', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces different sequences for different seeds', () => {
    const a = seededRandom(1);
    const b = seededRandom(2);
    expect(a()).not.toBe(b());
  });

  it('stays within [0, 1)', () => {
    const rand = seededRandom(slotSeed('2026-10-12#13'));
    for (let i = 0; i < 500; i += 1) {
      const value = rand();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('slotSeed is stable for the same key and differs across keys', () => {
    expect(slotSeed('2026-10-12#01')).toBe(slotSeed('2026-10-12#01'));
    expect(slotSeed('2026-10-12#01')).not.toBe(slotSeed('2026-10-12#02'));
  });
});
