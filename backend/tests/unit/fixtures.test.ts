/**
 * Part 2 — FIXTURE payloads served to the APK (content preview + history).
 *
 * What is asserted here:
 *  - determinism: the same slot always yields the same payload and the same
 *    image count, so refreshing or retrying in the APK changes nothing,
 *  - the image count is ONE value shared by both destinations,
 *  - the count always honours the configured policy bounds (1..2),
 *  - the validation status is produced by the REAL publish-gate validator,
 *  - every payload is explicitly tagged as fixture data (no fabricated success).
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AUTOMATION_SETTINGS,
  type AutomationSettings,
} from '../../src/settings/automation-settings.js';
import {
  FIXTURE_CONTENT_NOTE,
  FIXTURE_HISTORY_NOTE,
  FIXTURE_PRODUCT,
  buildContentPreview,
  buildPublishHistory,
  fixtureCaption,
  selectImageCount,
} from '../../src/automation/fixtures.js';
import { blocksPublish, validateCaption } from '../../src/pipeline/content-validation.js';

function settings(overrides: Partial<AutomationSettings> = {}): AutomationSettings {
  return { ...DEFAULT_AUTOMATION_SETTINGS, ...overrides };
}

/* ========================================================================== */
/*  Image count selection                                                     */
/* ========================================================================== */

describe('selectImageCount', () => {
  it('is deterministic for the same slot key', () => {
    const a = selectImageCount('2026-10-12#05', 'random_1_or_2');
    const b = selectImageCount('2026-10-12#05', 'random_1_or_2');
    expect(a).toBe(b);
  });

  it('always yields 1 or 2 under the random_1_or_2 policy', () => {
    for (let i = 0; i < 200; i += 1) {
      const count = selectImageCount(`slot-${i}`, 'random_1_or_2');
      expect([1, 2]).toContain(count);
    }
  });

  it('uses both values across a realistic day of slots (not stuck on one)', () => {
    const values = new Set<number>();
    for (let i = 1; i <= 24; i += 1) {
      values.add(selectImageCount(`2026-10-12#${String(i).padStart(2, '0')}`, 'random_1_or_2'));
    }
    expect(values).toEqual(new Set([1, 2]));
  });

  it('honours explicit policies', () => {
    expect(selectImageCount('any', 'one')).toBe(1);
    expect(selectImageCount('any', 'two')).toBe(2);
  });
});

/* ========================================================================== */
/*  Content preview                                                           */
/* ========================================================================== */

describe('buildContentPreview', () => {
  it('returns an identical payload for repeated calls (stable on refresh)', () => {
    const first = buildContentPreview('2026-10-12#07', settings());
    const second = buildContentPreview('2026-10-12#07', settings());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('can differ between slots but never leaves 1..2', () => {
    for (let i = 1; i <= 24; i += 1) {
      const preview = buildContentPreview(`2026-10-12#${String(i).padStart(2, '0')}`, settings());
      expect([1, 2]).toContain(preview.imageCount);
    }
  });

  it('exposes ONE image count shared by both destinations', () => {
    const preview = buildContentPreview('2026-10-12#07', settings());
    expect(preview.imageCountShared).toBe(true);
    expect(preview.imageCountStable).toBe(true);
    // No per-platform counts exist anywhere in the payload.
    expect(preview.platforms.facebook).not.toHaveProperty('imageCount');
    expect(preview.platforms.threads).not.toHaveProperty('imageCount');
  });

  it('follows the configured policy', () => {
    expect(buildContentPreview('slot', settings({ imageCountPolicy: 'one' })).imageCount).toBe(1);
    expect(buildContentPreview('slot', settings({ imageCountPolicy: 'two' })).imageCount).toBe(2);
  });

  it('is honest about being fixture data', () => {
    const preview = buildContentPreview('2026-10-12#07', settings());
    expect(preview.source).toBe('fixture');
    expect(preview.note).toBe(FIXTURE_CONTENT_NOTE);
    expect(preview.imageCountSource).toBe('fixture_placeholder');
    expect(preview.product.source).toBe('fixture');
    expect(preview.caption.source).toBe('fixture');
    expect(preview.platforms.facebook.status).toBe('not_attempted');
    expect(preview.platforms.threads.status).toBe('not_attempted');
    expect(preview.platforms.facebook.url).toBeNull();
    expect(preview.platforms.threads.url).toBeNull();
  });

  it('runs the REAL validator over the fixture caption and passes it', () => {
    const preview = buildContentPreview('2026-10-12#07', settings());
    expect(preview.validation.source).toBe('real_validator_on_fixture_text');
    expect(preview.validation.passed).toBe(true);
    expect(preview.validation.blocking).toEqual([]);
    expect(preview.validation.platformsChecked).toEqual(['facebook_page', 'threads']);

    // Cross-check against the validator directly.
    const direct = validateCaption({
      caption: fixtureCaption(),
      requiredAffiliateUrl: FIXTURE_PRODUCT.affiliateUrl,
      platform: 'threads',
    });
    expect(blocksPublish(direct)).toBe(false);
  });

  it('only checks platforms that are enabled in settings', () => {
    const preview = buildContentPreview('slot', settings({ threadsEnabled: false }));
    expect(preview.validation.platformsChecked).toEqual(['facebook_page']);
    expect(preview.platforms.threads.enabled).toBe(false);
    expect(preview.platforms.facebook.enabled).toBe(true);
  });

  it('embeds the affiliate link verbatim and invents no price or discount', () => {
    const preview = buildContentPreview('slot', settings());
    expect(preview.caption.fullText).toContain(FIXTURE_PRODUCT.affiliateUrl);
    expect(preview.caption.fullText.toLowerCase()).not.toMatch(/diskon|sale|komisi/);
    expect(JSON.stringify(preview)).not.toMatch(/EAAB[A-Za-z0-9]{20,}/);
  });

  it('carries the caption hashtags for the APK preview', () => {
    const preview = buildContentPreview('slot', settings());
    expect(preview.caption.hashtags.length).toBeGreaterThan(0);
    for (const tag of preview.caption.hashtags) {
      expect(tag.startsWith('#')).toBe(true);
    }
  });
});

/* ========================================================================== */
/*  Publishing history                                                        */
/* ========================================================================== */

describe('buildPublishHistory', () => {
  it('labels every record as fixture data', () => {
    for (const record of buildPublishHistory(settings())) {
      expect(record.source).toBe('fixture');
    }
    expect(FIXTURE_HISTORY_NOTE).toMatch(/fixture/i);
  });

  it('reports Facebook and Threads results independently', () => {
    const items = buildPublishHistory(settings());
    const mixed = items.find(
      (r) => r.facebook.status === 'published' && r.threads.status === 'failed',
    );
    expect(mixed).toBeDefined();
    expect(mixed?.threads.error).toBeTruthy();
    expect(mixed?.facebook.url).toBeTruthy();

    const notAttempted = items.find((r) => r.threads.status === 'not_attempted');
    expect(notAttempted).toBeDefined();
    expect(notAttempted?.facebook.status).toBe('failed');
  });

  it('is stable across refreshes within the same hour', () => {
    const now = new Date('2026-10-12T10:23:45.000Z');
    const a = buildPublishHistory(settings(), now);
    const b = buildPublishHistory(settings(), new Date('2026-10-12T10:41:02.000Z'));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('keeps image counts inside the policy bounds for every record', () => {
    for (const record of buildPublishHistory(settings({ imageCountPolicy: 'one' }))) {
      expect(record.imageCount).toBe(1);
    }
    for (const record of buildPublishHistory(settings({ imageCountPolicy: 'two' }))) {
      expect(record.imageCount).toBe(2);
    }
    for (const record of buildPublishHistory(settings())) {
      expect([1, 2]).toContain(record.imageCount);
    }
  });

  it('exposes retry status alongside failures', () => {
    const items = buildPublishHistory(settings());
    const retried = items.find((r) => r.retry.status === 'pending');
    expect(retried?.retry.attempts).toBeGreaterThan(0);
    expect(retried?.threads.status).toBe('failed');
  });
});
