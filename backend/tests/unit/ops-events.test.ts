/**
 * PART 8 §6/§7 — operational events: persistent dedup, cooldowns, delivery.
 *
 * Proves the delivery semantics documented in ops-events.ts:
 *  - every occurrence is durably recorded (one row per fingerprint),
 *  - at most ONE notification per cooldown window, even when events repeat,
 *  - `sent` is recorded only when the transport confirms; failures are recorded
 *    as failures and never re-emitted (no recursive notification loops),
 *  - a store or transport failure never throws into the emitting code path,
 *  - text is redacted and bounded before storage/transport.
 *
 * Default unit tests send NOTHING: the notifier here is an in-memory fake.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_COOLDOWN_MS,
  InMemoryOpsEventStore,
  OpsMonitor,
  fingerprintOf,
  sanitizeEventText,
  type EventDeliveryResult,
  type EventNotifier,
  type OpsEventInput,
} from '../../src/ops/ops-events.js';

/* ========================================================================== */
/*  Text hygiene + fingerprints                                               */
/* ========================================================================== */

describe('sanitizeEventText', () => {
  it('collapses whitespace to a single line', () => {
    expect(sanitizeEventText('a\nb\r\nc   d', 100)).toBe('a b c d');
  });

  it('redacts credential-shaped substrings', () => {
    // The shared redactString masks Telegram-token shapes (>=25 base64url chars).
    const text = sanitizeEventText(
      'send failed for bot 123456789:AAHbigSecretValueHere-abcdefghijk',
      200,
    );
    expect(text).not.toContain('AAHbigSecretValueHere');
    expect(text).toContain('[REDACTED]');
  });

  it('bounds the output length with an ellipsis', () => {
    const bounded = sanitizeEventText('x'.repeat(500), 50);
    expect(bounded.length).toBeLessThanOrEqual(50);
    expect(bounded.endsWith('…')).toBe(true);
  });
});

describe('fingerprintOf', () => {
  it('uses the bare kind without a scope and folds the scope in when given', () => {
    expect(fingerprintOf('scheduler_tick_failed')).toBe('scheduler_tick_failed');
    expect(fingerprintOf('generation_job_failed', 'content:2026-10-13#19:00')).toBe(
      'generation_job_failed:content:2026-10-13#19:00',
    );
  });

  it('bounds fingerprints to the column width', () => {
    expect(fingerprintOf('kind', 'y'.repeat(400)).length).toBeLessThanOrEqual(255);
  });
});

/* ========================================================================== */
/*  In-memory store semantics                                                 */
/* ========================================================================== */

describe('InMemoryOpsEventStore', () => {
  it('upserts by fingerprint: repeats bump occurrences, never insert a second row', async () => {
    const store = new InMemoryOpsEventStore();
    const first = await store.upsert({
      fingerprint: 'f1',
      kind: 'scheduler_stale',
      severity: 'warning',
      title: 't',
      detail: null,
    });
    expect(first.isNew).toBe(true);
    expect(first.occurrences).toBe(1);

    const second = await store.upsert({
      fingerprint: 'f1',
      kind: 'scheduler_stale',
      severity: 'warning',
      title: 't2',
      detail: null,
    });
    expect(second.isNew).toBe(false);
    expect(second.occurrences).toBe(2);
    expect(store.get('f1')?.title).toBe('t2');
    expect(await store.recent(10)).toHaveLength(1);
  });

  it('claims the cooldown window exactly once', async () => {
    const store = new InMemoryOpsEventStore();
    await store.upsert({
      fingerprint: 'f1',
      kind: 'budget_threshold',
      severity: 'warning',
      title: 't',
      detail: null,
    });
    const future = new Date(Date.now() + 60_000);
    expect(await store.claimNotify('f1', future)).toBe(true);
    expect(await store.claimNotify('f1', future)).toBe(false); // still cooling down
    expect(store.get('f1')?.lastNotifiedAt).not.toBeNull();
    // Unknown fingerprints can never claim a notification right.
    expect(await store.claimNotify('missing', future)).toBe(false);
  });

  it('claimNotify arms the cooldown exactly as far into the future as asked', async () => {
    const store = new InMemoryOpsEventStore();
    await store.upsert({
      fingerprint: 'f1',
      kind: 'budget_threshold',
      severity: 'warning',
      title: 't',
      detail: null,
    });
    const target = new Date(Date.now() + 90_000);
    expect(await store.claimNotify('f1', target)).toBe(true);
    expect(store.get('f1')?.cooldownUntil).toBe(target.toISOString());
  });

  it('markDelivery records exactly what the transport said and keeps timestamps', async () => {
    const store = new InMemoryOpsEventStore();
    await store.upsert({
      fingerprint: 'f1',
      kind: 'budget_threshold',
      severity: 'warning',
      title: 't',
      detail: null,
    });
    const at = new Date();
    await store.markDelivery('f1', { delivered: true, status: 'sent', messageId: '42' }, at);
    expect(store.get('f1')?.lastDeliveryStatus).toBe('sent');
    expect(store.get('f1')?.lastMessageId).toBe('42');

    // A later FAILED delivery must not erase the previous confirmed timestamp.
    await store.markDelivery(
      'f1',
      { delivered: false, status: 'failed', errorCode: 'rate_limited' },
      new Date(),
    );
    expect(store.get('f1')?.lastDeliveryStatus).toBe('failed');
    expect(store.get('f1')?.lastErrorCode).toBe('rate_limited');
    expect(store.get('f1')?.lastNotifiedAt).toBe(at.toISOString());
    expect(store.get('f1')?.lastMessageId).toBe('42'); // confirmed id survives
  });

  it('cleanup enforces age and per-kind retention bounds', async () => {
    const store = new InMemoryOpsEventStore();
    for (let i = 0; i < 5; i += 1) {
      await store.upsert({
        fingerprint: `kind-a-${i}`,
        kind: 'kind_a',
        severity: 'info',
        title: `t${i}`,
        detail: null,
      });
    }
    // Nothing is old enough to age out; per-kind retention keeps the newest 2.
    const { deleted } = await store.cleanup({
      olderThan: new Date(Date.now() - 60_000),
      maxPerKind: 2,
    });
    expect(deleted).toBe(3);
    expect(await store.recent(50)).toHaveLength(2);

    // Everything older than "now" is aged out.
    const agedOut = await store.cleanup({
      olderThan: new Date(Date.now() + 1_000),
      maxPerKind: 2,
    });
    expect(agedOut.deleted).toBe(2);
  });

  it('recent() returns newest first, bounded', async () => {
    const store = new InMemoryOpsEventStore();
    await store.upsert({ fingerprint: 'a', kind: 'k', severity: 'info', title: 'a', detail: null });
    await store.upsert({ fingerprint: 'b', kind: 'k', severity: 'info', title: 'b', detail: null });
    const recent = await store.recent(1);
    expect(recent).toHaveLength(1);
  });
});

/* ========================================================================== */
/*  Monitor                                                                   */
/* ========================================================================== */

/** Controllable notifier recording every delivery attempt. */
class FakeNotifier implements EventNotifier {
  readonly calls: Array<{ fingerprint: string; kind: string }> = [];
  result: EventDeliveryResult = { delivered: true, status: 'sent', messageId: 'm-1', errorCode: null };
  throws: Error | null = null;

  async notifyEvent(event: {
    fingerprint: string;
    kind: string;
    severity: 'info' | 'warning' | 'critical';
    title: string;
    detail: string;
  }): Promise<EventDeliveryResult> {
    this.calls.push({ fingerprint: event.fingerprint, kind: event.kind });
    if (this.throws) throw this.throws;
    return this.result;
  }
}

const baseEvent: OpsEventInput = {
  kind: 'scheduler_tick_failed',
  severity: 'critical',
  title: 'Scheduler tick failed',
  detail: 'boom',
};

describe('OpsMonitor.record', () => {
  it('records durably and attempts delivery on the FIRST occurrence', async () => {
    const store = new InMemoryOpsEventStore();
    const notifier = new FakeNotifier();
    const monitor = new OpsMonitor({ store, notifier });

    const outcome = await monitor.record(baseEvent);
    expect(outcome.isNew).toBe(true);
    expect(outcome.occurrences).toBe(1);
    expect(outcome.notifyAttempted).toBe(true);
    expect(outcome.delivery).toEqual({
      delivered: true,
      status: 'sent',
      messageId: 'm-1',
      errorCode: null,
    });
    expect(store.get('scheduler_tick_failed')?.lastDeliveryStatus).toBe('sent');
  });

  it('suppresses the SECOND notification inside the cooldown but keeps counting', async () => {
    const store = new InMemoryOpsEventStore();
    const notifier = new FakeNotifier();
    const monitor = new OpsMonitor({ store, notifier });

    await monitor.record(baseEvent);
    const second = await monitor.record(baseEvent);

    expect(second.isNew).toBe(false);
    expect(second.occurrences).toBe(2);
    expect(second.notifyAttempted).toBe(false);
    expect(notifier.calls).toHaveLength(1); // exactly one send per window
  });

  it('re-notifies when the cooldown has passed (persistent problems resurface)', async () => {
    const store = new InMemoryOpsEventStore();
    const notifier = new FakeNotifier();
    const monitor = new OpsMonitor({ store, notifier, defaultCooldownMs: { info: 0, warning: 0, critical: 0 } });

    await monitor.record(baseEvent);
    const second = await monitor.record(baseEvent);
    expect(second.notifyAttempted).toBe(true);
    expect(notifier.calls).toHaveLength(2);
    expect(second.occurrences).toBe(2);
  });

  it('applies per-kind default cooldowns by severity', () => {
    expect(DEFAULT_COOLDOWN_MS.critical).toBeLessThanOrEqual(DEFAULT_COOLDOWN_MS.warning);
    expect(DEFAULT_COOLDOWN_MS.info).toBeGreaterThan(0);
  });

  it('redacts and bounds text before it reaches storage or the transport', async () => {
    const store = new InMemoryOpsEventStore();
    const notifier = new FakeNotifier();
    const monitor = new OpsMonitor({ store, notifier });

    await monitor.record({
      ...baseEvent,
      title: 'Failure with token 123456789:AAHsupersecrettokenvalue-xyz123',
      detail: 'line1\nline2 '.repeat(100),
    });

    const row = store.get('scheduler_tick_failed');
    expect(row?.title).not.toContain('AAHsupersecrettokenvalue');
    expect(row?.title).toContain('[REDACTED]');
    expect((row?.detail ?? '').length).toBeLessThanOrEqual(600);
    expect((row?.detail ?? '')).not.toContain('\n');
  });

  it('records a transport THROWN error as a failed delivery and never re-emits', async () => {
    const store = new InMemoryOpsEventStore();
    const notifier = new FakeNotifier();
    notifier.throws = new Error('transport exploded with 123456789:AAHtok');
    const monitor = new OpsMonitor({ store, notifier });

    const outcome = await monitor.record(baseEvent);
    expect(outcome.notifyAttempted).toBe(true);
    expect(outcome.delivery?.delivered).toBe(false);
    expect(outcome.delivery?.status).toBe('failed');
    expect(outcome.delivery?.errorCode).toBe('transport_error');
    expect(store.get('scheduler_tick_failed')?.lastDeliveryStatus).toBe('failed');
    // The failure did NOT create a second event (no recursion).
    expect(await store.recent(50)).toHaveLength(1);
    expect(notifier.calls).toHaveLength(1);
  });

  it('never throws when the event STORE fails — callers can record blindly', async () => {
    const brokenStore = {
      persistence: 'memory' as const,
      upsert: vi.fn(async () => {
        throw new Error('disk gone');
      }),
      claimNotify: vi.fn(async () => true),
      markDelivery: vi.fn(async () => undefined),
      recent: vi.fn(async () => {
        throw new Error('disk gone');
      }),
      cleanup: vi.fn(async () => {
        throw new Error('disk gone');
      }),
    };
    const monitor = new OpsMonitor({ store: brokenStore, notifier: new FakeNotifier() });

    const outcome = await monitor.record(baseEvent);
    expect(outcome.notifyAttempted).toBe(false);
    expect(outcome.delivery).toBeNull();
    expect(await monitor.recent(5)).toEqual([]);
    expect(await monitor.runCleanup()).toEqual({ deleted: 0 });
  });

  it('records without sending when no notifier is wired (dev/tests)', async () => {
    const store = new InMemoryOpsEventStore();
    const monitor = new OpsMonitor({ store });
    const outcome = await monitor.record(baseEvent);
    expect(outcome.isNew).toBe(true);
    expect(outcome.notifyAttempted).toBe(false);
    expect(store.get('scheduler_tick_failed')?.lastDeliveryStatus).toBe('not_sent');
  });

  it('uses distinct fingerprints per scope (each failed slot dedupes on its own)', async () => {
    const store = new InMemoryOpsEventStore();
    const notifier = new FakeNotifier();
    const monitor = new OpsMonitor({ store, notifier });

    await monitor.record({ ...baseEvent, kind: 'generation_job_failed', scope: 'content:2026-10-13#19:00' });
    const other = await monitor.record({
      ...baseEvent,
      kind: 'generation_job_failed',
      scope: 'content:2026-10-13#11:00',
    });

    expect(other.isNew).toBe(true);
    expect(notifier.calls.map((call) => call.fingerprint)).toEqual([
      'generation_job_failed:content:2026-10-13#19:00',
      'generation_job_failed:content:2026-10-13#11:00',
    ]);
    expect(await store.recent(10)).toHaveLength(2);
  });
});
