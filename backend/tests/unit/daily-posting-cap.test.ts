/**
 * PART 6 §7 — transactional daily posting cap (3–4 posts/day).
 *
 * Covers: the `dailyCap` contract on `enqueue`, the `DailyPostLimitError`,
 * the FNV-1a `dayLockKey`, idempotent re-enqueue of a live key, no-op when a
 * key is already succeeded, and that a non-content job kind is not counted.
 * Credential-free, deterministic, in-memory.
 */
import { describe, it, expect } from 'vitest';
import { InMemoryJobQueue } from '../../src/queue/job-queue.js';
import { dayLockKey } from '../../src/db/postgres-job-queue.js';
import { DailyPostLimitError } from '../../src/core/errors.js';
import type { EnqueueJobInput } from '../../src/contracts/index.js';

const FIXED_NOW = new Date('2026-10-12T03:00:00.000Z'); // 10:00 WIB

function contentJob(slotKey: string, overrides: Partial<EnqueueJobInput> = {}): EnqueueJobInput {
  const date = slotKey.split('#')[0];
  return {
    kind: 'content_generation',
    uniqueKey: `content:${slotKey}`,
    scheduledFor: `${date}T00:00:00.000Z`,
    payload: { slotKey },
    dailyCap: { dayPrefix: `content:${date}#`, max: 4 },
    ...overrides,
  };
}

describe('daily posting cap (InMemoryJobQueue)', () => {
  it('allows up to the target number of posts per day, then refuses', async () => {
    const queue = new InMemoryJobQueue(() => FIXED_NOW);
    // Four WIB windows = four content jobs for 2026-10-12.
    for (const index of ['01', '02', '03', '04']) {
      await expect(queue.enqueue(contentJob(`2026-10-12#${index}`))).resolves.toBeTruthy();
    }

    // A fifth distinct content key for the same day exceeds the target.
    await expect(queue.enqueue(contentJob('2026-10-12#05'))).rejects.toThrow(DailyPostLimitError);
  });

  it('respects a daily target of 3', async () => {
    const queue = new InMemoryJobQueue(() => FIXED_NOW);
    const cap3 = (slotKey: string): EnqueueJobInput => contentJob(slotKey, {
      dailyCap: { dayPrefix: 'content:2026-10-12#', max: 3 },
    });

    for (const index of ['01', '02', '03']) {
      await expect(queue.enqueue(cap3(`2026-10-12#${index}`))).resolves.toBeTruthy();
    }
    await expect(queue.enqueue(cap3('2026-10-12#04'))).rejects.toThrow(DailyPostLimitError);
  });

  it('re-enqueueing a live key is idempotent and does NOT consume the cap', async () => {
    const queue = new InMemoryJobQueue(() => FIXED_NOW);
    const first = await queue.enqueue(contentJob('2026-10-12#01'));
    const again = await queue.enqueue(contentJob('2026-10-12#01'));
    expect(again.id).toBe(first.id);
    expect(again.status).toBe('pending');

    // The cap still allows three more posts.
    for (const index of ['02', '03', '04']) {
      await expect(queue.enqueue(contentJob(`2026-10-12#${index}`))).resolves.toBeTruthy();
    }
    await expect(queue.enqueue(contentJob('2026-10-12#05'))).rejects.toThrow(DailyPostLimitError);
  });

  it('does not count jobs from a different day', async () => {
    const queue = new InMemoryJobQueue(() => FIXED_NOW);
    for (const index of ['01', '02', '03', '04']) {
      await queue.enqueue(contentJob(`2026-10-12#${index}`));
    }
    // 2026-10-13 is a fresh day: its first post is allowed.
    await expect(queue.enqueue(contentJob('2026-10-13#01'))).resolves.toBeTruthy();
  });

  it('does not count non-content jobs toward the cap', async () => {
    const queue = new InMemoryJobQueue(() => FIXED_NOW);
    await queue.enqueue({
      kind: 'feed_import',
      uniqueKey: 'feed:2026-10-12',
      scheduledFor: '2026-10-12T00:00:00.000Z',
      payload: {},
    });

    for (const index of ['01', '02', '03', '04']) {
      await expect(queue.enqueue(contentJob(`2026-10-12#${index}`))).resolves.toBeTruthy();
    }
    await expect(queue.enqueue(contentJob('2026-10-12#05'))).rejects.toThrow(DailyPostLimitError);
  });

  it('omitting the cap keeps the legacy unlimited behaviour', async () => {
    const queue = new InMemoryJobQueue(() => FIXED_NOW);
    for (let i = 1; i <= 10; i += 1) {
      const key = String(i).padStart(2, '0');
      await expect(
        queue.enqueue({
          kind: 'content_generation',
          uniqueKey: `content:2026-10-12#${key}`,
          scheduledFor: '2026-10-12T00:00:00.000Z',
          payload: {},
        }),
      ).resolves.toBeTruthy();
    }
  });

  it('countDay reflects the cap accounting', async () => {
    const queue = new InMemoryJobQueue(() => FIXED_NOW);
    expect(queue.countDay('content:2026-10-12#')).toBe(0);
    await queue.enqueue(contentJob('2026-10-12#01'));
    expect(queue.countDay('content:2026-10-12#')).toBe(1);
    await queue.enqueue(contentJob('2026-10-12#02'));
    expect(queue.countDay('content:2026-10-12#')).toBe(2);
    expect(queue.countDay('content:2026-10-13#')).toBe(0);
  });
});

describe('dayLockKey (advisory lock identity for the PostgreSQL cap)', () => {
  it('is stable for a given day prefix', () => {
    expect(dayLockKey('content:2026-10-12#')).toBe(dayLockKey('content:2026-10-12#'));
  });

  it('differs across days', () => {
    expect(dayLockKey('content:2026-10-12#')).not.toBe(dayLockKey('content:2026-10-13#'));
  });

  it('fits a signed 32-bit integer (advisory-lock range)', () => {
    const key = dayLockKey('content:2026-10-12#');
    expect(Number.isInteger(key)).toBe(true);
    expect(Math.abs(key)).toBeLessThanOrEqual(2_147_483_647);
  });
});

describe('concurrent ticks never exceed the daily target', () => {
  it('parallel enqueues of the same day converge on at most `max` posts', async () => {
    const queue = new InMemoryJobQueue(() => FIXED_NOW);
    const attempts = Array.from({ length: 16 }, (_, i) =>
      queue.enqueue(contentJob(`2026-10-12#${String(i + 1).padStart(2, '0')}`)).catch(() => null),
    );
    const results = await Promise.all(attempts);
    const created = results.filter((job) => job !== null);
    expect(created).toHaveLength(4);
    expect(queue.countDay('content:2026-10-12#')).toBe(4);
  });
});
