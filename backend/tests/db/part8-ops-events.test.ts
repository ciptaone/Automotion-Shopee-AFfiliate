/**
 * PART 8 §6/§7/§4 — PostgreSQL integration for ops events and queue stats.
 *
 * These tests run against a REAL PostgreSQL and prove what an in-memory map
 * cannot imitate:
 *  - the `ops_events` migration (0004) is applied and its unique fingerprint
 *    index is what deduplicates concurrent recorders,
 *  - concurrent upserts collapse to ONE row with an exact occurrence count,
 *  - the notification cooldown claim is a conditional UPDATE: N concurrent
 *    claimants produce EXACTLY one winner,
 *  - `markDelivery` keeps confirmed timestamps while recording later failures,
 *  - retention cleanup enforces age + per-kind bounds with real timestamps,
 *  - `PostgresJobQueue.stats()` reports low-cardinality counts/ages using the
 *    DATABASE clock, including expired leases (crashed workers).
 *
 * No external API is touched: the store and queue are pure storage. Nothing
 * here can reach Telegram or any AI provider.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresJobQueue } from '../../src/db/postgres-job-queue.js';
import { PostgresOpsEventStore } from '../../src/ops/ops-events.js';
import { openTestDatabase, resetDatabase, uniqueKey, type TestDatabase } from './helpers.js';

let primary: TestDatabase;
let store: PostgresOpsEventStore;
let queue: PostgresJobQueue;

beforeAll(async () => {
  primary = openTestDatabase();
  store = new PostgresOpsEventStore(primary.db);
  queue = new PostgresJobQueue({ db: primary.db });
});

afterAll(async () => {
  await primary.close();
});

beforeEach(async () => {
  await resetDatabase(primary.db);
});

const EVENT = {
  kind: 'scheduler_tick_failed' as const,
  severity: 'critical' as const,
  title: 'Scheduler tick failed',
  detail: 'boom',
};

/* ========================================================================== */
/*  Migration 0004: schema + constraints                                      */
/* ========================================================================== */

describe('ops_events migration (0004)', () => {
  it('created the table with its unique fingerprint index', async () => {
    const table = await primary.raw`
      select to_regclass('ops_events') as present`;
    expect(table[0]?.present).toBe('ops_events');

    const indexes = (await primary.raw`
      select indexname from pg_indexes where tablename = 'ops_events'`) as unknown as Array<{ indexname: string }>;
    const names = indexes.map((row) => row.indexname);
    expect(names.some((name: string) => name.includes('fingerprint'))).toBe(true);
  });

  it('rejects a duplicate fingerprint at the CONSTRAINT level (defense in depth)', async () => {
    await store.upsert({ fingerprint: 'dup', ...EVENT });
    await expect(
      primary.raw`
        insert into ops_events (fingerprint, kind, severity, title)
        values ('dup', 'scheduler_tick_failed', 'critical', 'x')`,
    ).rejects.toThrow();
  });

  it('enforces the severity and delivery CHECK constraints', async () => {
    await expect(
      primary.raw`
        insert into ops_events (fingerprint, kind, severity, title)
        values ('bad-sev', 'k', 'apocalyptic', 'x')`,
    ).rejects.toThrow();
    await expect(
      primary.raw`
        insert into ops_events (fingerprint, kind, severity, title, last_delivery_status)
        values ('bad-delivery', 'k', 'info', 'x', 'teleported')`,
    ).rejects.toThrow();
  });
});

/* ========================================================================== */
/*  Upsert dedupe under concurrency                                           */
/* ========================================================================== */

describe('PostgresOpsEventStore.upsert', () => {
  it('collapses 8 concurrent recorders into ONE row with occurrences = 8', async () => {
    await Promise.all(
      Array.from({ length: 8 }, () =>
        store.upsert({ fingerprint: 'concurrent', ...EVENT }),
      ),
    );
    const rows = await primary.raw`select * from ops_events where fingerprint = 'concurrent'`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.occurrences)).toBe(8);
    expect(rows[0]?.last_delivery_status).toBe('not_sent');
  });

  it('keeps first-seen identity while refreshing title/detail/last-seen', async () => {
    const first = await store.upsert({ fingerprint: 'f1', ...EVENT });
    expect(first.isNew).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await store.upsert({
      fingerprint: 'f1',
      ...EVENT,
      title: 'Scheduler tick failed again',
      detail: 'boom 2',
    });
    expect(second.isNew).toBe(false);
    expect(second.occurrences).toBe(2);

    const row = (await store.recent(10))[0]!;
    expect(row.title).toBe('Scheduler tick failed again');
    expect(row.firstSeenAt).toBe(first.firstSeenAt);
    expect(Date.parse(row.lastSeenAt)).toBeGreaterThan(Date.parse(first.lastSeenAt));
  });
});

/* ========================================================================== */
/*  Cooldown claim: exactly one winner                                        */
/* ========================================================================== */

describe('PostgresOpsEventStore.claimNotify', () => {
  it('lets exactly ONE of 6 concurrent claimants win the cooldown window', async () => {
    await store.upsert({ fingerprint: 'f1', ...EVENT });
    const future = new Date(Date.now() + 60_000);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => store.claimNotify('f1', future)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);

    const row = (await store.recent(1))[0]!;
    expect(row.lastNotifiedAt).not.toBeNull();
    expect(Date.parse(row.cooldownUntil!)).toBeGreaterThan(Date.now());
  });

  it('allows a fresh claim only after the cooldown genuinely expires', async () => {
    await store.upsert({ fingerprint: 'f1', ...EVENT });
    expect(await store.claimNotify('f1', new Date(Date.now() + 60_000))).toBe(true);
    expect(await store.claimNotify('f1', new Date(Date.now() + 60_000))).toBe(false);

    // Simulate the window elapsing (direct clock manipulation in the row).
    await primary.raw`
      update ops_events set cooldown_until = now() - interval '1 second'
      where fingerprint = 'f1'`;
    expect(await store.claimNotify('f1', new Date(Date.now() + 60_000))).toBe(true);
  });

  it('never claims a notification right for an unknown fingerprint', async () => {
    expect(await store.claimNotify('missing', new Date(Date.now() + 60_000))).toBe(false);
  });
});

/* ========================================================================== */
/*  Delivery recording + retention                                            */
/* ========================================================================== */

describe('PostgresOpsEventStore.markDelivery', () => {
  it('records sent + messageId, then keeps the confirmed timestamp on a later failure', async () => {
    await store.upsert({ fingerprint: 'f1', ...EVENT });
    await store.claimNotify('f1', new Date(Date.now() + 60_000));

    const sentAt = new Date();
    await store.markDelivery('f1', { delivered: true, status: 'sent', messageId: '42' }, sentAt);
    let row = (await store.recent(1))[0]!;
    expect(row.lastDeliveryStatus).toBe('sent');
    expect(row.lastMessageId).toBe('42');

    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.markDelivery(
      'f1',
      { delivered: false, status: 'failed', errorCode: 'rate_limited' },
      new Date(),
    );
    row = (await store.recent(1))[0]!;
    expect(row.lastDeliveryStatus).toBe('failed');
    expect(row.lastErrorCode).toBe('rate_limited');
    expect(row.lastMessageId).toBe('42'); // the confirmed id is not erased
    expect(row.lastNotifiedAt).toBe(sentAt.toISOString()); // confirmed time kept
  });

  it('marking an unknown fingerprint changes nothing', async () => {
    await store.markDelivery(
      'missing',
      { delivered: true, status: 'sent', messageId: 'x' },
      new Date(),
    );
    expect(await store.recent(10)).toHaveLength(0);
  });
});

describe('PostgresOpsEventStore.recent + cleanup', () => {
  it('recent() returns newest-first, bounded by the limit', async () => {
    for (const fp of ['a', 'b', 'c']) {
      await store.upsert({ fingerprint: fp, ...EVENT, title: `t-${fp}` });
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const recent = await store.recent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.title).toBe('t-c');
    expect(recent[1]!.title).toBe('t-b');
  });

  it('cleanup enforces the age bound and the per-kind retention cap', async () => {
    // 5 events of kind A (old) + 1 recent event of kind B.
    for (let i = 0; i < 5; i += 1) {
      await store.upsert({ fingerprint: `a-${i}`, ...EVENT, kind: 'queue_degraded' });
    }
    await primary.raw`
      update ops_events set first_seen_at = now() - interval '100 days',
                            last_seen_at  = now() - interval '100 days'
      where kind = 'queue_degraded'`;
    await store.upsert({ fingerprint: 'b-1', ...EVENT, kind: 'budget_threshold' });

    // Age-based purge removes the five 100-day-old rows; the fresh one stays.
    const aged = await store.cleanup({
      olderThan: new Date(Date.now() - 90 * 24 * 3_600_000),
      maxPerKind: 1_000,
    });
    expect(aged.deleted).toBe(5);
    expect(await store.recent(50)).toHaveLength(1);

    // Per-kind cap: insert three fresh rows of one kind, keep only the newest.
    for (let i = 0; i < 3; i += 1) {
      await store.upsert({ fingerprint: `c-${i}`, ...EVENT, kind: 'storage_unavailable' });
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    const capped = await store.cleanup({
      olderThan: new Date(Date.now() - 365 * 24 * 3_600_000), // nothing is this old
      maxPerKind: 1,
    });
    expect(capped.deleted).toBe(2);
    const remaining = await primary.raw`
      select fingerprint from ops_events where kind = 'storage_unavailable'`;
    expect(remaining).toHaveLength(1);
  });
});

/* ========================================================================== */
/*  PostgresJobQueue.stats()                                                  */
/* ========================================================================== */

describe('PostgresJobQueue.stats', () => {
  it('reports zeroed counts on an empty table', async () => {
    const stats = await queue.stats();
    expect(stats).toEqual({
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      retrying: 0,
      oldestPendingAt: null,
      oldestPendingAgeMs: null,
      expiredLeases: 0,
    });
  });

  it('counts by status, marks retried pendings, and ages the oldest pending via the DB clock', async () => {
    const past = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString();

    const first = await queue.enqueue({
      kind: 'content_slot',
      uniqueKey: uniqueKey('done'),
      scheduledFor: past(300),
      payload: {},
    });
    const claimed = await queue.claim('w1');
    await queue.complete(claimed!.id, { stage: 'publish_ready' });

    const failedJob = await queue.enqueue({
      kind: 'content_slot',
      uniqueKey: uniqueKey('failed'),
      scheduledFor: past(200),
      payload: {},
      maxAttempts: 1,
    });
    const failedClaim = await queue.claim('w1');
    await queue.fail(failedClaim!.id, 'terminal', false); // non-retryable

    const retried = await queue.enqueue({
      kind: 'content_slot',
      uniqueKey: uniqueKey('retry'),
      scheduledFor: past(90), // 90s overdue → age ≈ 90_000ms
      payload: {},
    });

    const stats = await queue.stats();
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.retrying).toBe(0); // pending with attempts = 0
    expect(stats.expiredLeases).toBe(0);
    expect(stats.oldestPendingAt).toBe(retried.scheduledFor);
    expect(stats.oldestPendingAgeMs).toBeGreaterThanOrEqual(89_000);
    expect(stats.oldestPendingAgeMs).toBeLessThan(120_000);

    // Identities untouched by the observation read.
    expect((await queue.getByUniqueKey(first.uniqueKey))!.id).toBe(first.id);
    expect((await queue.getByUniqueKey(failedJob.uniqueKey))!.id).toBe(failedJob.id);
  });

  it('counts a retried pending job once attempts are spent and requeued', async () => {
    await queue.enqueue({
      kind: 'content_slot',
      uniqueKey: uniqueKey('r'),
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
      payload: {},
      maxAttempts: 3,
    });
    const claimed = await queue.claim('w1');
    await queue.fail(claimed!.id, 'flaky', true); // retryable → pending, attempts=1

    const stats = await queue.stats();
    expect(stats.pending).toBe(1);
    expect(stats.retrying).toBe(1);
  });

  it('flags expired leases from crashed workers (status still running, lease past)', async () => {
    await queue.enqueue({
      kind: 'content_slot',
      uniqueKey: uniqueKey('crash'),
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
      payload: {},
    });
    const claimed = await queue.claim('ghost-worker');
    expect(claimed).not.toBeNull();

    // Simulate a worker that died 10 minutes ago without completing the job.
    await primary.raw`
      update jobs set lease_expires_at = now() - interval '10 minutes'
      where id = ${claimed!.id}`;

    const stats = await queue.stats();
    expect(stats.running).toBe(1);
    expect(stats.expiredLeases).toBe(1);
  });

  it('stays low-cardinality: the snapshot carries counts and ages only', async () => {
    await queue.enqueue({
      kind: 'content_slot',
      uniqueKey: uniqueKey('probe'),
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
      payload: { product: 'MUST NOT LEAK', affiliate: 'MUST NOT LEAK' },
    });
    const stats = await queue.stats();
    const serialized = JSON.stringify(stats);
    expect(serialized).not.toMatch(/MUST NOT LEAK|uniqueKey|payload/i);
    expect(Object.keys(stats).sort()).toEqual([
      'cancelled',
      'expiredLeases',
      'failed',
      'oldestPendingAgeMs',
      'oldestPendingAt',
      'pending',
      'retrying',
      'running',
      'succeeded',
    ]);
  });
});

/* ========================================================================== */
/*  Journal consistency for the PART 8 migration (guarded by migrations suite) */
/* ========================================================================== */

describe('migration journal reaches 0004', () => {
  it('lists exactly five applied migrations, each with its SHA-256 file hash', async () => {
    const rows = await primary.raw`
      select hash, created_at from drizzle.__drizzle_migrations order by id`;
    expect(rows).toHaveLength(5); // 0000 … 0004_part8_ops_events
    for (const row of rows as unknown as Array<{ hash: string; created_at: string }>) {
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/); // sha-256 of the applied .sql file
      expect(Number(row.created_at)).toBeGreaterThan(0);
    }
  });

  it('ops_events columns match the documented additive schema', async () => {
    const rows = await primary.raw`
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = 'ops_events'
      order by ordinal_position`;
    const columns =
      (rows as unknown as Array<{ column_name: string }>).map(
        (row) => row.column_name,
      );
    expect(columns).toEqual([
      'id',
      'fingerprint',
      'kind',
      'severity',
      'title',
      'detail',
      'occurrences',
      'first_seen_at',
      'last_seen_at',
      'cooldown_until',
      'last_delivery_status',
      'last_error_code',
      'last_message_id',
      'last_notified_at',
    ]);
  });
});
