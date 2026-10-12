/**
 * PostgreSQL job queue — concurrency, leases and recovery (PART 5).
 *
 * These tests run against a REAL PostgreSQL. They prove the guarantees the
 * brief demands and that an in-memory queue can only imitate:
 *   - two concurrent workers never claim the same job;
 *   - job identity is a database unique index, not an in-process map;
 *   - a crashed worker's lease expires and the job comes back;
 *   - a stale worker cannot commit a result over a newer owner;
 *   - retry/backoff/attempt budgets behave exactly like the in-memory queue.
 *
 * No external API is touched: the queue is pure storage.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StaleClaimError } from '../../src/core/errors.js';
import { PostgresJobQueue } from '../../src/db/postgres-job-queue.js';
import { sql } from 'drizzle-orm';
import {
  isoNow,
  openTestDatabase,
  resetDatabase,
  uniqueKey,
  type TestDatabase,
} from './helpers.js';

let primary: TestDatabase;
let queue: PostgresJobQueue;

beforeAll(async () => {
  primary = openTestDatabase();
  queue = new PostgresJobQueue({ db: primary.db });
});

afterAll(async () => {
  await primary.close();
});

beforeEach(async () => {
  await resetDatabase(primary.db);
});

/** Enqueue a due job (scheduled in the past so it is claimable immediately). */
async function enqueueDueJob(key = uniqueKey('job'), maxAttempts = 3) {
  return queue.enqueue({
    kind: 'content_slot',
    uniqueKey: key,
    scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    payload: { slotKey: key },
    maxAttempts,
  });
}

describe('PostgresJobQueue — identity', () => {
  it('enqueue + claim returns the job exactly once', async () => {
    const job = await enqueueDueJob();
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);

    const claimed = await queue.claim('worker-a');
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.claimedBy).toBe('worker-a');
    expect(claimed?.claimToken).toBeTruthy();
    expect(new Date(claimed!.leaseExpiresAt!).getTime()).toBeGreaterThan(Date.now());

    expect(await queue.claim('worker-b')).toBeNull();
  });

  it('enqueueing the same unique key twice is a no-op that returns the existing job', async () => {
    const key = uniqueKey('idempotent');
    const first = await enqueueDueJob(key);
    const second = await enqueueDueJob(key);
    expect(second.id).toBe(first.id);
    expect(await queue.countByStatus('pending')).toBe(1);
  });

  it('re-enqueueing a FAILED job resets the SAME row (never a second logical job)', async () => {
    const key = uniqueKey('resettable');
    const first = await enqueueDueJob(key);
    const claimed = await queue.claim('worker-a');
    expect(claimed?.id).toBe(first.id);
    await queue.fail(first.id, 'boom', false); // non-retryable -> failed

    const requeued = await enqueueDueJob(key);
    expect(requeued.id).toBe(first.id);
    expect(requeued.status).toBe('pending');
    expect(requeued.attempts).toBe(0);
    expect(requeued.lastError).toBeNull();
    expect(await queue.countByStatus('pending')).toBe(1);
  });

  it('survives a restart: a second queue instance reads the same rows', async () => {
    const job = await enqueueDueJob();
    const restarted = new PostgresJobQueue({ db: primary.db });
    const loaded = await restarted.getByUniqueKey(job.uniqueKey);
    expect(loaded?.id).toBe(job.id);
    expect(loaded?.status).toBe('pending');
  });
});

describe('PostgresJobQueue — concurrent claiming', () => {
  it('never hands the same job to two workers', async () => {
    const job = await enqueueDueJob();
    // Separate pools = separate sessions = a real concurrency test.
    const workerA = new PostgresJobQueue({ db: openTestDatabase().db });
    const workerB = new PostgresJobQueue({ db: openTestDatabase().db });

    const results = await Promise.all([workerA.claim('worker-a'), workerB.claim('worker-b')]);
    const claimed = results.filter((entry) => entry !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(job.id);

    const stored = await queue.get(job.id);
    expect(stored?.attempts).toBe(1);
    expect(stored?.status).toBe('running');
  });

  it('hands N distinct jobs to N concurrent workers', async () => {
    for (let i = 0; i < 4; i += 1) await enqueueDueJob(uniqueKey('many'));

    const workers = Array.from({ length: 4 }, () =>
      new PostgresJobQueue({ db: openTestDatabase().db }),
    );
    const claimed = await Promise.all(workers.map((w, i) => w.claim(`worker-${i}`)));
    const ids = new Set(claimed.filter(Boolean).map((job) => job!.id));
    expect(ids.size).toBe(4);
    expect(await queue.countByStatus('running')).toBe(4);
  });
});

describe('PostgresJobQueue — retry classification', () => {
  it('retryable failures reschedule with backoff; non-retryable failures go straight to failed', async () => {
    const retryable = await enqueueDueJob(uniqueKey('retry'), 2);
    await queue.claim('worker-a');
    const afterRetryable = await queue.fail(retryable.id, 'transient provider error', true);
    expect(afterRetryable.status).toBe('pending');
    expect(new Date(afterRetryable.scheduledFor).getTime()).toBeGreaterThan(Date.now());
    expect(afterRetryable.lastError).toContain('transient provider error');

    const permanent = await enqueueDueJob(uniqueKey('permanent'), 3);
    await queue.claim('worker-a');
    const afterPermanent = await queue.fail(permanent.id, 'validation error', false);
    expect(afterPermanent.status).toBe('failed');
    expect(afterPermanent.lastError).toContain('validation error');
  });

  it('stops retrying once the attempt budget is spent', async () => {
    const job = await enqueueDueJob(uniqueKey('budget'), 2);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const claimed = await queue.claim('worker-a');
      expect(claimed?.id).toBe(job.id);
      expect(claimed?.attempts).toBe(attempt);
      await queue.fail(job.id, `attempt ${attempt} failed`, true);
      // Make it due again instead of waiting out the backoff.
      await primary.db.execute(
        sql`update jobs set scheduled_for = now() - interval '1 second' where id = ${job.id}::uuid`,
      );
    }

    // The loop already spent the budget, so the job is terminal. A further
    // `fail` from a stale caller is REFUSED instead of rewriting the record.
    await expect(queue.fail(job.id, 'budget spent', true)).rejects.toBeInstanceOf(
      StaleClaimError,
    );

    const exhausted = await queue.get(job.id);
    expect(exhausted?.attempts).toBe(2);
    expect(exhausted?.status).toBe('failed');
    expect(exhausted?.lastError).toContain('attempt 2 failed');
    expect(await queue.claim('worker-a')).toBeNull();
  });
});

describe('PostgresJobQueue — leases and crash recovery', () => {
  it('reclaims a job whose worker died (expired lease) without losing the attempt count', async () => {
    const shortLease = new PostgresJobQueue({ db: primary.db, leaseMs: 60_000 });
    const job = await enqueueDueJob(uniqueKey('crash'));

    const crashed = await shortLease.claim('worker-that-dies');
    expect(crashed?.attempts).toBe(1);

    // Simulate the crash: the lease is now in the past.
    await primary.db.execute(
      sql`update jobs set lease_expires_at = now() - interval '1 second' where id = ${job.id}::uuid`,
    );

    const survivor = new PostgresJobQueue({ db: openTestDatabase().db });
    const reclaimed = await survivor.claim('worker-after-restart');
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.attempts).toBe(2);
    expect(reclaimed?.claimedBy).toBe('worker-after-restart');
    expect(reclaimed?.claimToken).not.toBe(crashed?.claimToken);
  });

  it('recoverExpiredLeases requeues crashed jobs and fails ones out of budget', async () => {
    const requeueJob = await enqueueDueJob(uniqueKey('recover-requeue'), 3);
    const failJob = await enqueueDueJob(uniqueKey('recover-fail'), 1);

    // Two claims: BOTH jobs must be running (attempts=1) before their leases
    // are expired, so the recovery outcome differs only by attempt budget.
    await queue.claim('worker-a');
    await queue.claim('worker-a');
    await primary.db.execute(
      sql`update jobs set status = 'running', lease_expires_at = now() - interval '1 second'
          where id in (${requeueJob.id}::uuid, ${failJob.id}::uuid)`,
    );

    const report = await queue.recoverExpiredLeases();
    expect(report.requeued).toBe(1);
    expect(report.failed).toBe(1);
    expect([...report.jobIds].sort()).toEqual([requeueJob.id, failJob.id].sort());

    expect((await queue.get(requeueJob.id))?.status).toBe('pending');
    const failed = await queue.get(failJob.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.lastError).toContain('lease expired');
  });

  it('a stale worker cannot complete a job that a newer worker now owns', async () => {
    const job = await enqueueDueJob(uniqueKey('stale'));
    const staleClaim = await queue.claim('worker-slow');
    await primary.db.execute(
      sql`update jobs set lease_expires_at = now() - interval '1 second' where id = ${job.id}::uuid`,
    );

    const fresh = new PostgresJobQueue({ db: openTestDatabase().db });
    const freshClaim = await fresh.claim('worker-fast');
    expect(freshClaim?.id).toBe(job.id);

    // The slow worker comes back with its old token: rejected, loudly.
    await expect(
      queue.complete(job.id, { stage: 'publish_ready' }, { claimToken: staleClaim!.claimToken }),
    ).rejects.toBeInstanceOf(StaleClaimError);
    await expect(
      queue.fail(job.id, 'stale failure', true, { claimToken: staleClaim!.claimToken }),
    ).rejects.toBeInstanceOf(StaleClaimError);

    const stored = await queue.get(job.id);
    expect(stored?.status).toBe('running');
    expect(stored?.claimedBy).toBe('worker-fast');

    // The stale worker's result never reached the row.
    const rawRows = (await primary.db.execute(
      sql`select result from jobs where id = ${job.id}::uuid`,
    )) as unknown as Array<{ result: string }>;
    expect(rawRows[0]?.result ?? '{}').not.toContain('publish_ready');
  });

  it('the owner completes with its token, and a later renewal by anyone else is refused', async () => {
    const job = await enqueueDueJob(uniqueKey('owner'));
    const claimed = await queue.claim('worker-a');

    expect(await queue.extendLease(job.id, claimed!.claimToken!, 60_000)).toBe(true);
    await queue.complete(job.id, { stage: 'publish_ready' }, { claimToken: claimed!.claimToken });

    const stored = await queue.get(job.id);
    expect(stored?.status).toBe('succeeded');
    expect(stored?.claimToken).toBeNull();
    expect(stored?.completedAt).toBeTruthy();

    expect(await queue.extendLease(job.id, claimed!.claimToken!, 60_000)).toBe(false);
  });

  it('completing a job that no longer exists is reported, never silently treated as success', async () => {
    await expect(queue.complete('00000000-0000-4000-8000-000000000000', {})).rejects.toThrow();
  });

  it('completing a job that was never claimed (no token) still requires a real row', async () => {
    const job = await enqueueDueJob(uniqueKey('unclaimed'));
    await queue.complete(job.id, { stage: 'publish_ready' });
    expect((await queue.get(job.id))?.status).toBe('succeeded');
    // A second completion after the state changed is refused (guard rejects).
    await expect(queue.complete(job.id, { stage: 'again' })).rejects.toBeInstanceOf(StaleClaimError);
  });

  it('does not disturb a live worker: a valid lease is not reclaimable', async () => {
    const job = await enqueueDueJob(uniqueKey('live-lease'));
    const claimed = await new PostgresJobQueue({ db: primary.db, leaseMs: 10_000 }).claim('worker-a');
    expect(claimed?.id).toBe(job.id);

    const other = new PostgresJobQueue({ db: openTestDatabase().db });
    expect(await other.claim('worker-b')).toBeNull();
    expect((await queue.get(job.id))?.status).toBe('running');
    expect((await queue.get(job.id))?.claimedBy).toBe('worker-a');
  });
});

describe('PostgresJobQueue — listing', () => {
  it('lists jobs newest first and honours the limit', async () => {
    await enqueueDueJob(uniqueKey('list-1'));
    await enqueueDueJob(uniqueKey('list-2'));
    const listed = await queue.list(10);
    expect(listed).toHaveLength(2);
    expect(listed[0]!.createdAt >= listed[1]!.createdAt).toBe(true);
    expect(await queue.list(1)).toHaveLength(1);
  });

  it('stores timestamps as UTC ISO strings and payload as JSON', async () => {
    const job = await queue.enqueue({
      kind: 'content_slot',
      uniqueKey: uniqueKey('utc'),
      scheduledFor: isoNow(),
      payload: { nested: { value: 1 } },
    });
    expect(job.scheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(job.createdAt).toMatch(/Z$/);
  });
});
