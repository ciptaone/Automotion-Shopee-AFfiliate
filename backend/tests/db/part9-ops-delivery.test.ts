/**
 * PART 9 §8 — ops-event delivery bookkeeping must accept every status the
 * notifier contract can produce.
 *
 * Regression: the notifier reports `status: 'skipped'` when it intentionally
 * does not deliver (severity/kind filter, notifications disabled), but the
 * PART 8 schema check constraint predated that value. The mismatch surfaced
 * live during the PART 9 production drill as a failed `markDelivery` UPDATE
 * on the first info-severity event (`process_started`) — logged, but noisy
 * and lossy. Migration 0005 widened the constraint; this test pins the fix
 * against the real PostgreSQL store.
 *
 * The invalid-value guard stays: 'teleported' must still be rejected.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresOpsEventStore } from '../../src/ops/ops-events.js';
import { openTestDatabase, resetDatabase, type TestDatabase } from './helpers.js';

describe('PostgresOpsEventStore — delivery status constraint (0005)', () => {
  let primary: TestDatabase;
  let store: PostgresOpsEventStore;

  beforeAll(async () => {
    primary = openTestDatabase();
    store = new PostgresOpsEventStore(primary.db);
  });

  afterAll(async () => {
    await primary.close();
  });

  beforeEach(async () => {
    await resetDatabase(primary.db);
  });

  it("accepts the notifier's 'skipped' outcome and persists it", async () => {
    const fingerprint = 'part9_delivery_probe:drill';
    await store.upsert({
      fingerprint,
      kind: 'part9_delivery_probe',
      severity: 'info',
      title: 'PART 9 delivery probe',
      detail: 'severity-filtered info event',
    });

    // This UPDATE was the one that violated the PART 8 check constraint.
    await store.markDelivery(
      fingerprint,
      { delivered: false, status: 'skipped', errorCode: 'severity_filtered' },
      new Date(),
    );

    const events = await store.recent(10);
    const stored = events.find((event) => event.fingerprint === fingerprint);
    expect(stored?.lastDeliveryStatus).toBe('skipped');
    expect(stored?.lastErrorCode).toBe('severity_filtered');
  });

  it("still rejects delivery statuses outside the contract ('teleported')", async () => {
    await expect(
      primary.raw.unsafe(
        `insert into ops_events (id, fingerprint, kind, severity, title, last_delivery_status)
         values (gen_random_uuid(), 'part9-bad-delivery', 'k', 'info', 'x', 'teleported')`,
      ),
    ).rejects.toThrow(/ops_events_delivery_check/);
  });
});
