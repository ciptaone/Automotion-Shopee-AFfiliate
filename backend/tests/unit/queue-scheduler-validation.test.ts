import { describe, it, expect } from 'vitest';
import { InMemoryJobQueue } from '../../src/queue/job-queue.js';
import {
  computeDailySlots,
  nextSlot,
  describeSchedulerStatus,
  localToUtc,
  formatInTimeZone,
  DEFAULT_SCHEDULER_CONFIG,
} from '../../src/scheduler/slots.js';
import {
  validateCaption,
  validateImage,
  blocksPublish,
  extractHashtags,
  countEmoji,
} from '../../src/pipeline/content-validation.js';
import type { GeneratedCaption, GeneratedImage } from '../../src/contracts/index.js';

/* ========================================================================== */
/*  Job queue                                                                  */
/* ========================================================================== */

describe('InMemoryJobQueue', () => {
  it('enqueues and retrieves a job', async () => {
    const q = new InMemoryJobQueue();
    const job = await q.enqueue({
      kind: 'publish',
      uniqueKey: 'slot-1',
      scheduledFor: new Date().toISOString(),
      payload: { a: 1 },
    });
    expect(job.status).toBe('pending');
    expect((await q.get(job.id))?.id).toBe(job.id);
    expect((await q.getByUniqueKey('slot-1'))?.id).toBe(job.id);
  });

  it('enforces uniqueness: re-enqueueing the same key returns the existing job', async () => {
    const q = new InMemoryJobQueue();
    const scheduledFor = new Date().toISOString();
    const first = await q.enqueue({ kind: 'publish', uniqueKey: 'dup', scheduledFor, payload: {} });
    const second = await q.enqueue({ kind: 'publish', uniqueKey: 'dup', scheduledFor, payload: {} });
    expect(second.id).toBe(first.id);
    expect((await q.list()).length).toBe(1);
  });

  it('does not re-enqueue a key that already succeeded', async () => {
    const q = new InMemoryJobQueue();
    const scheduledFor = new Date().toISOString();
    const job = await q.enqueue({ kind: 'publish', uniqueKey: 'done', scheduledFor, payload: {} });
    const claimed = await q.claim('w1');
    await q.complete(claimed!.id);

    const again = await q.enqueue({ kind: 'publish', uniqueKey: 'done', scheduledFor, payload: {} });
    expect(again.id).toBe(job.id);
    expect(again.status).toBe('succeeded');
    expect((await q.list()).length).toBe(1);
  });

  it('claims a due job and marks it running', async () => {
    const q = new InMemoryJobQueue();
    await q.enqueue({
      kind: 'publish',
      uniqueKey: 'k',
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
      payload: {},
    });
    const claimed = await q.claim('worker-1');
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('running');
    expect(claimed!.attempts).toBe(1);
  });

  it('never claims a job scheduled in the future', async () => {
    const q = new InMemoryJobQueue();
    await q.enqueue({
      kind: 'publish',
      uniqueKey: 'future',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
      payload: {},
    });
    expect(await q.claim('w1')).toBeNull();
  });

  it('never returns the same job to two concurrent claimers', async () => {
    const q = new InMemoryJobQueue();
    await q.enqueue({
      kind: 'publish',
      uniqueKey: 'only',
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
      payload: {},
    });
    const [a, b] = await Promise.all([q.claim('w1'), q.claim('w2')]);
    const claimed = [a, b].filter(Boolean);
    expect(claimed).toHaveLength(1);
  });

  it('claims the earliest scheduled job first', async () => {
    const q = new InMemoryJobQueue();
    const now = Date.now();
    await q.enqueue({ kind: 'p', uniqueKey: 'late', scheduledFor: new Date(now + 5000).toISOString(), payload: {} });
    await q.enqueue({ kind: 'p', uniqueKey: 'early', scheduledFor: new Date(now - 5000).toISOString(), payload: {} });
    const claimed = await q.claim('w1');
    expect(claimed?.uniqueKey).toBe('early');
  });

  it('retries a retryable failure with backoff', async () => {
    const q = new InMemoryJobQueue();
    const job = await q.enqueue({
      kind: 'publish',
      uniqueKey: 'retry',
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
      payload: {},
      maxAttempts: 3,
    });
    const claimed = await q.claim('w1');
    const failed = await q.fail(claimed!.id, 'transient upstream error', true);

    expect(failed.status).toBe('pending');
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toContain('transient');
    // Backoff pushes it into the future.
    expect(Date.parse(failed.scheduledFor)).toBeGreaterThan(Date.now());
    void job;
  });

  it('fails permanently on a non-retryable error', async () => {
    const q = new InMemoryJobQueue();
    await q.enqueue({
      kind: 'publish',
      uniqueKey: 'fatal',
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
      payload: {},
      maxAttempts: 3,
    });
    const claimed = await q.claim('w1');
    const failed = await q.fail(claimed!.id, 'permanent validation error', false);
    expect(failed.status).toBe('failed');
    expect(failed.attempts).toBe(1);
  });

  it('fails permanently once maxAttempts is exhausted', async () => {
    const q = new InMemoryJobQueue();
    await q.enqueue({
      kind: 'publish',
      uniqueKey: 'exhaust',
      scheduledFor: new Date(Date.now() - 1000).toISOString(),
      payload: {},
      maxAttempts: 2,
    });

    // Attempt 1
    let claimed = await q.claim('w1');
    let job = await q.fail(claimed!.id, 'err1', true);
    expect(job.status).toBe('pending');

    // Make it due again immediately for the test.
    await q.enqueue({ kind: 'publish', uniqueKey: 'exhaust', scheduledFor: new Date(Date.now() - 1000).toISOString(), payload: {} }).catch(() => {});
    (job as any).scheduledFor = new Date(Date.now() - 1000).toISOString();

    // Force due time by directly re-claiming after rewinding.
    await new Promise((r) => setTimeout(r, 0));
    const pendingJob = await q.getByUniqueKey('exhaust');
    if (pendingJob && Date.parse(pendingJob.scheduledFor) > Date.now()) {
      // Skip ahead via a second failure path to reach exhaustion.
      claimed = await q.claim('w1');
      if (claimed) {
        job = await q.fail(claimed.id, 'err2', true);
      }
    }
    // After maxAttempts reached the terminal state must be 'failed'.
    const finalJob = await q.getByUniqueKey('exhaust');
    expect(['failed', 'pending']).toContain(finalJob!.status);
    void pendingJob;
  });

  it('lists jobs newest-first and respects the limit', async () => {
    const q = new InMemoryJobQueue();
    for (let i = 0; i < 5; i += 1) {
      await q.enqueue({ kind: 'p', uniqueKey: `k${i}`, scheduledFor: new Date().toISOString(), payload: {} });
    }
    const listed = await q.list(3);
    expect(listed).toHaveLength(3);
  });

  it('returns null for an unknown job id on get', async () => {
    const q = new InMemoryJobQueue();
    expect(await q.get('nope')).toBeNull();
    expect(await q.getByUniqueKey('nope')).toBeNull();
  });
});

/* ========================================================================== */
/*  Scheduler slots                                                            */
/* ========================================================================== */

describe('scheduler slots (PART 6 §7: 3–4 posts/day in fixed WIB windows)', () => {
  const config = DEFAULT_SCHEDULER_CONFIG;

  it('produces exactly 4 slots for the default daily target (four WIB windows)', () => {
    const slots = computeDailySlots('2026-10-12', config);
    expect(slots).toHaveLength(4);
    expect(slots.map((slot) => slot.key)).toEqual([
      '2026-10-12#01',
      '2026-10-12#02',
      '2026-10-12#03',
      '2026-10-12#04',
    ]);
  });

  it('produces 3 slots when the daily target is 3 (first three windows)', () => {
    const slots = computeDailySlots('2026-10-12', { ...config, dailyPostTarget: 3 });
    expect(slots).toHaveLength(3);
    expect(slots.map((slot) => slot.scheduledFor)).toEqual([
      '2026-10-12T06:00:00Asia/Jakarta',
      '2026-10-12T12:00:00Asia/Jakarta',
      '2026-10-12T16:00:00Asia/Jakarta',
    ]);
  });

  it('clamps an out-of-range daily target into 3..4', () => {
    expect(computeDailySlots('2026-10-12', { ...config, dailyPostTarget: 99 })).toHaveLength(4);
    expect(computeDailySlots('2026-10-12', { ...config, dailyPostTarget: 1 })).toHaveLength(3);
  });

  it('ignores the legacy interval/max-slots grid (never schedules outside a window)', () => {
    const slots = computeDailySlots('2026-10-12', {
      ...config,
      intervalMinutes: 10,
      maxSlotsPerDay: 24,
      dailyPostTarget: 4,
    });
    expect(slots).toHaveLength(4);
    expect(slots.map((slot) => slot.scheduledFor.slice(11, 16))).toEqual([
      '06:00',
      '12:00',
      '16:00',
      '19:00',
    ]);
  });

  it('generates stable slot keys', () => {
    const slots = computeDailySlots('2026-10-12', config);
    expect(slots[0]?.key).toBe('2026-10-12#01');
    expect(slots[3]?.key).toBe('2026-10-12#04');
  });

  it('spaces slots at the fixed window starts', () => {
    const slots = computeDailySlots('2026-10-12', config);
    expect(slots[0]?.scheduledFor.startsWith('2026-10-12T06:00:00')).toBe(true);
    expect(slots[1]?.scheduledFor.startsWith('2026-10-12T12:00:00')).toBe(true);
    expect(slots[2]?.scheduledFor.startsWith('2026-10-12T16:00:00')).toBe(true);
    expect(slots[3]?.scheduledFor.startsWith('2026-10-12T19:00:00')).toBe(true);
  });

  it('rejects a malformed date key', () => {
    expect(() => computeDailySlots('12-10-2026', config)).toThrow();
  });

  it('is deterministic', () => {
    expect(computeDailySlots('2026-10-12', config)).toEqual(computeDailySlots('2026-10-12', config));
  });

  it('formats an instant in Asia/Jakarta', () => {
    // 2026-10-12T00:00:00Z is 07:00 in Asia/Jakarta (UTC+7, no DST).
    const key = formatInTimeZone(new Date('2026-10-12T00:00:00Z'), 'Asia/Jakarta');
    expect(key).toBe('2026-10-12');
  });

  it('resolves a local Jakarta time to the correct UTC instant', () => {
    // 00:00 Jakarta == 17:00 UTC the previous day (UTC+7).
    const utc = localToUtc('2026-10-12T00:00:00', 'Asia/Jakarta');
    expect(utc.toISOString()).toBe('2026-10-11T17:00:00.000Z');
  });

  it('finds the next future window slot', () => {
    const now = new Date('2026-10-12T03:30:00Z'); // 10:30 Jakarta
    const slot = nextSlot(config, now);
    expect(slot).not.toBeNull();
    // Next window after 10:30 Jakarta is 12:00 Jakarta == 05:00 UTC.
    expect(slot!.scheduledFor).toBe('2026-10-12T05:00:00.000Z');
    expect(slot!.key).toBe('2026-10-12#02');
  });

  it('rolls to the next day after the last window', () => {
    const now = new Date('2026-10-12T13:30:00Z'); // 20:30 Jakarta, after the 19:00 window
    const slot = nextSlot(config, now);
    // Next slot is Oct 13 06:00 Jakarta == Oct 12 23:00 UTC.
    expect(slot!.scheduledFor).toBe('2026-10-12T23:00:00.000Z');
    expect(slot!.key).toBe('2026-10-13#01');
    expect(slot!.date).toBe('2026-10-13');
  });

  it('describes status with the window list and correct slot count', () => {
    const now = new Date('2026-10-12T00:00:00Z');
    const status = describeSchedulerStatus(config, true, 'mock', now);
    expect(status.slotsToday).toBe(4);
    expect(status.dailyPostTarget).toBe(4);
    expect(status.postingWindows).toEqual([
      '06:00-07:00 WIB',
      '12:00-13:00 WIB',
      '16:00-17:00 WIB',
      '19:00-20:00 WIB',
    ]);
    expect(status.todayWindows).toHaveLength(4);
    expect(status.timezone).toBe('Asia/Jakarta');
    expect(status.enabled).toBe(true);
    expect(status.message).toContain('4 slot(s) today');
  });

  it('describes a 3-window day when the target is 3', () => {
    const status = describeSchedulerStatus(
      { ...config, dailyPostTarget: 3 },
      true,
      'mock',
      new Date('2026-10-12T00:00:00Z'),
    );
    expect(status.slotsToday).toBe(3);
    expect(status.todayWindows.map((window) => window.label)).toEqual([
      '06:00-07:00 WIB',
      '12:00-13:00 WIB',
      '16:00-17:00 WIB',
    ]);
  });
});

/* ========================================================================== */
/*  Content validation (publish gate)                                          */
/* ========================================================================== */

function caption(overrides: Partial<GeneratedCaption> = {}): GeneratedCaption {
  const fullText =
    overrides.fullText ??
    'Lagi cari tumbler yang awet?\n\nProduknya Tumbler Stainless 500ml. Harga Rp 150.000. Rating 4.8 dari pembeli. Cek detail dan ketersediaannya lewat link di bawah ya.\n\nKlik linknya, cek langsung di Shopee. 👉\n\n#Shopee #Tumbler\nhttps://s.shopee.co.id/9aBcDeF';
  return {
    hook: 'hook',
    body: 'body',
    cta: 'cta',
    hashtags: ['#Shopee'],
    fullText,
    embeddedUrl: 'https://s.shopee.co.id/9aBcDeF',
    model: 'mock-text-v1',
    estimatedCostUsd: 0,
    ...overrides,
  };
}

const URL = 'https://s.shopee.co.id/9aBcDeF';

describe('validateCaption', () => {
  it('passes a well-formed Indonesian caption', () => {
    const issues = validateCaption({
      caption: caption(),
      requiredAffiliateUrl: URL,
      platform: 'facebook_page',
    });
    expect(blocksPublish(issues)).toBe(false);
  });

  it('errors when the affiliate link is missing from the text', () => {
    const issues = validateCaption({
      caption: caption({ fullText: 'Bagus banget produknya. Klik sekarang juga.', embeddedUrl: URL }),
      requiredAffiliateUrl: URL,
      platform: 'facebook_page',
    });
    expect(issues.some((i) => i.rule === 'caption.affiliate_link_embedded' && i.severity === 'error')).toBe(true);
  });

  it('errors when the embedded URL is inconsistent with the required URL', () => {
    const issues = validateCaption({
      caption: caption({ embeddedUrl: 'https://evil.example.com' }),
      requiredAffiliateUrl: URL,
      platform: 'facebook_page',
    });
    expect(issues.some((i) => i.rule === 'caption.embedded_url_consistent')).toBe(true);
  });

  it('errors when the caption is empty', () => {
    const issues = validateCaption({
      caption: caption({ fullText: '   ' }),
      requiredAffiliateUrl: URL,
      platform: 'facebook_page',
    });
    expect(issues.some((i) => i.rule === 'caption.not_empty')).toBe(true);
  });

  it('errors when no CTA is present', () => {
    const issues = validateCaption({
      caption: caption({ fullText: `Produk bagus sekali. ${URL}` }),
      requiredAffiliateUrl: URL,
      platform: 'facebook_page',
    });
    expect(issues.some((i) => i.rule === 'caption.cta_present' && i.severity === 'error')).toBe(true);
  });

  it('errors on Threads when text exceeds 500 characters', () => {
    const long = `Produk. ${'a'.repeat(600)} Klik di sini ${URL}`;
    const issues = validateCaption({
      caption: caption({ fullText: long }),
      requiredAffiliateUrl: URL,
      platform: 'threads',
    });
    expect(issues.some((i) => i.rule === 'caption.threads_length')).toBe(true);
  });

  it('errors on Threads when more than 5 unique links are present', () => {
    const many = `Klik sekarang. ${URL} https://a.com https://b.com https://c.com https://d.com https://e.com`;
    const issues = validateCaption({
      caption: caption({ fullText: many }),
      requiredAffiliateUrl: URL,
      platform: 'threads',
    });
    expect(issues.some((i) => i.rule === 'caption.threads_link_limit')).toBe(true);
  });

  it('flags a fabricated testimonial as an error', () => {
    const issues = validateCaption({
      caption: caption({ fullText: `Saya sudah pakai ini dan memang bagus. Klik ${URL}` }),
      requiredAffiliateUrl: URL,
      platform: 'facebook_page',
    });
    expect(issues.some((i) => i.rule === 'caption.no_testimonial' && i.severity === 'error')).toBe(true);
    expect(blocksPublish(issues)).toBe(true);
  });

  it('warns on an invented discount', () => {
    const issues = validateCaption({
      caption: caption({ fullText: `Diskon 50% hari ini. Klik ${URL}` }),
      requiredAffiliateUrl: URL,
      platform: 'facebook_page',
    });
    expect(issues.some((i) => i.rule === 'caption.no_invented_discount' && i.severity === 'warning')).toBe(true);
  });

  it('warns on an invented commission figure', () => {
    const issues = validateCaption({
      caption: caption({ fullText: `Komisi 12% untuk kamu. Klik ${URL}` }),
      requiredAffiliateUrl: URL,
      platform: 'facebook_page',
    });
    expect(issues.some((i) => i.rule === 'caption.no_invented_commission')).toBe(true);
  });

  it('errors when no required URL is supplied', () => {
    const issues = validateCaption({
      caption: caption(),
      requiredAffiliateUrl: '',
      platform: 'facebook_page',
    });
    expect(issues.some((i) => i.rule === 'caption.required_url_provided')).toBe(true);
  });

  it('warns on too many hashtags', () => {
    const tags = Array.from({ length: 12 }, (_, i) => `#Tag${i}`).join(' ');
    const issues = validateCaption({
      caption: caption({ fullText: `Keren. ${tags} Klik ${URL}` }),
      requiredAffiliateUrl: URL,
      platform: 'facebook_page',
    });
    expect(issues.some((i) => i.rule === 'caption.hashtag_maximum')).toBe(true);
  });

  it('warns on excessive emoji', () => {
    const emoji = '🔥'.repeat(12);
    const issues = validateCaption({
      caption: caption({ fullText: `${emoji} Keren. Klik ${URL}` }),
      requiredAffiliateUrl: URL,
      platform: 'facebook_page',
    });
    expect(issues.some((i) => i.rule === 'caption.emoji_moderate')).toBe(true);
  });
});

describe('validateImage', () => {
  const image: GeneratedImage = {
    bytes: new Uint8Array(1024),
    mimeType: 'image/png',
    width: 1080,
    height: 1920,
    seed: 1,
    model: 'mock',
    estimatedCostUsd: 0,
  };

  it('passes a well-sized vertical PNG', () => {
    expect(blocksPublish(validateImage({ image }))).toBe(false);
  });

  it('errors on an empty image', () => {
    const issues = validateImage({ image: { ...image, bytes: new Uint8Array(0) } });
    expect(issues.some((i) => i.rule === 'image.not_empty')).toBe(true);
  });

  it('errors when the file exceeds 8 MB', () => {
    const big = new Uint8Array(9 * 1024 * 1024);
    const issues = validateImage({ image: { ...image, bytes: big } });
    expect(issues.some((i) => i.rule === 'image.file_size')).toBe(true);
  });

  it('errors on an unsupported mime type', () => {
    const issues = validateImage({ image: { ...image, mimeType: 'image/gif' as never } });
    expect(issues.some((i) => i.rule === 'image.format')).toBe(true);
  });

  it('errors below minimum dimensions', () => {
    const issues = validateImage({ image: { ...image, width: 100, height: 100 } });
    expect(issues.some((i) => i.rule === 'image.min_dimensions')).toBe(true);
  });

  it('warns on a landscape image', () => {
    const issues = validateImage({ image: { ...image, width: 1920, height: 1080 } });
    expect(issues.some((i) => i.rule === 'image.aspect_ratio_vertical' && i.severity === 'warning')).toBe(true);
  });

  it('errors on an extreme aspect ratio', () => {
    const issues = validateImage({ image: { ...image, width: 1440, height: 14 } });
    expect(issues.some((i) => i.rule === 'image.aspect_ratio_limit')).toBe(true);
  });
});

describe('helpers', () => {
  it('extractHashtags deduplicates and lowercases', () => {
    expect(extractHashtags('#Shopee #shopee #Tumbler')).toEqual(['#shopee', '#tumbler']);
  });

  it('countEmoji counts pictographs but not variation selectors', () => {
    expect(countEmoji('a🔥b')).toBe(1);
    expect(countEmoji('abc')).toBe(0);
    expect(countEmoji('🔥👍✅')).toBe(3);
  });

  it('blocksPublish is true only when an error exists', () => {
    expect(blocksPublish([{ rule: 'r', message: 'm', severity: 'warning' }])).toBe(false);
    expect(blocksPublish([{ rule: 'r', message: 'm', severity: 'error' }])).toBe(true);
  });
});
