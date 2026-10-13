/**
 * PART 6 §10 — generation usage ledger and budget controls.
 *
 * Covers: honest cost classification (actual vs estimated vs unknown), daily
 * and monthly budgets that block generation before the request, unknown-cost
 * requests being counted but never treated as $0 spend, Jakarta day/month
 * windows, and persistence of the ledger across restarts.
 *
 * Credential-free: synthetic records only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FileUsageStore,
  InMemoryUsageStore,
  accumulate,
  emptyTotals,
  type UsageRecord,
  type UsageStore,
} from '../../src/usage/usage-store.js';
import { UsageService, addDays, addMonths, dayWindow, monthWindow } from '../../src/usage/usage-service.js';
import { BudgetExhaustedError } from '../../src/core/errors.js';

/* Fixed clock: 2026-10-12 10:00 WIB (= 03:00 UTC). */
const NOW = new Date('2026-10-12T10:00:00+07:00');

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: `rec-${Math.random().toString(36).slice(2)}`,
    at: '2026-10-12T03:00:00.000Z', // 10:00 WIB — inside the fixed "today"
    providerId: 'p1',
    providerName: 'Test Provider',
    adapterType: 'openai_chat_completions',
    model: 'test-model',
    operation: 'text_generation',
    requestId: null,
    status: 'success',
    latencyMs: 100,
    inputTokens: 10,
    outputTokens: 20,
    images: null,
    costUsd: null,
    costKind: 'unknown',
    errorCode: null,
    ...overrides,
  };
}

function service(
  store: UsageStore,
  budgets: { dailyBudgetUsd: number | null; monthlyBudgetUsd: number | null },
): UsageService {
  return new UsageService(store, () => budgets, 'Asia/Jakarta', () => NOW);
}

async function seed(store: UsageStore, records: UsageRecord[]): Promise<void> {
  for (const item of records) await store.append(item);
}

/* ========================================================================== */
/*  Cost classification                                                       */
/* ========================================================================== */

describe('usage totals — honest cost classification', () => {
  it('separates actual, estimated and unknown costs', async () => {
    const store = new InMemoryUsageStore();
    await seed(store, [
      record({ id: 'a', costUsd: 0.01, costKind: 'actual' }),
      record({ id: 'b', costUsd: 0.004, costKind: 'estimated' }),
      record({ id: 'c', costUsd: null, costKind: 'unknown' }),
      record({ id: 'd', costUsd: 0.006, costKind: 'unknown' }), // number, no classification
    ]);

    const totals = await store.totals(
      dayWindow('2026-10-12', 'Asia/Jakarta').from,
      dayWindow('2026-10-12', 'Asia/Jakarta').to,
    );
    expect(totals.requests).toBe(4);
    expect(totals.actualCostUsd).toBeCloseTo(0.01, 10);
    expect(totals.estimatedCostUsd).toBeCloseTo(0.004, 10);
    // Only classified numbers count as spend…
    expect(totals.knownCostUsd).toBeCloseTo(0.014, 10);
    // …the unclassified one is surfaced as unknown, never as $0.
    expect(totals.unknownCostRequests).toBe(2);
  });

  it('counts failures, tokens and images', async () => {
    const totals = accumulate(
      accumulate(
        accumulate(emptyTotals(), record({ id: 'a', inputTokens: 10, outputTokens: 5 })),
        record({ id: 'b', inputTokens: null, outputTokens: null, images: 2 }),
      ),
      record({ id: 'c', status: 'error', inputTokens: 1, outputTokens: 1 }),
    );
    expect(totals.requests).toBe(3);
    expect(totals.failures).toBe(1);
    expect(totals.inputTokens).toBe(11);
    expect(totals.outputTokens).toBe(6);
    expect(totals.images).toBe(2);
  });

  it('records a ledger entry with costKind "unknown" when none was reported', async () => {
    const store = new InMemoryUsageStore();
    const usage = service(store, { dailyBudgetUsd: null, monthlyBudgetUsd: null });
    const saved = await usage.record({
      providerId: 'p1',
      providerName: 'Test Provider',
      adapterType: 'openai_chat_completions',
      model: 'test-model',
      operation: 'test_text',
      status: 'success',
      latencyMs: 42,
    });
    expect(saved).not.toBeNull();
    expect(saved?.costKind).toBe('unknown');
    expect(saved?.costUsd).toBeNull();
    expect(saved?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await usage.summary(5)).toMatchObject({ storage: 'memory' });
  });

  it('never lets a ledger write failure break the generation itself', async () => {
    const broken: UsageStore = {
      kind: 'memory',
      append: async () => {
        throw new Error('disk full (mock)');
      },
      list: async () => [],
      totals: async () => emptyTotals(),
    };
    const usage = service(broken, { dailyBudgetUsd: null, monthlyBudgetUsd: null });
    const saved = await usage.record({
      providerId: null,
      providerName: 'env default',
      adapterType: 'env_default',
      model: 'mock-text-v1',
      operation: 'text_generation',
      status: 'success',
      latencyMs: 5,
    });
    expect(saved).toBeNull();
  });
});

/* ========================================================================== */
/*  Budgets                                                                   */
/* ========================================================================== */

describe('budgets — block generation before spending', () => {
  it('blocks when the daily budget is exhausted', async () => {
    const store = new InMemoryUsageStore();
    await seed(store, [record({ costUsd: 0.05, costKind: 'actual' })]);
    const usage = service(store, { dailyBudgetUsd: 0.05, monthlyBudgetUsd: null });

    await expect(usage.assertWithinBudget()).rejects.toThrow(BudgetExhaustedError);
    const status = await usage.budgetStatus();
    expect(status.blocked).toBe(true);
    expect(status.blockedScope).toBe('daily');
    expect(status.day.exhausted).toBe(true);
    expect(status.day.spentUsd).toBeCloseTo(0.05, 10);
    expect(status.note).toMatch(/unknown cost/i);
  });

  it('blocks when the monthly budget is exhausted', async () => {
    const store = new InMemoryUsageStore();
    await seed(store, [
      // Earlier in the same month, but on a previous day.
      record({ at: '2026-10-05T03:00:00.000Z', costUsd: 0.02, costKind: 'actual' }),
    ]);
    const usage = service(store, { dailyBudgetUsd: null, monthlyBudgetUsd: 0.01 });

    await expect(usage.assertWithinBudget()).rejects.toThrow(/monthly budget/);
    const status = await usage.budgetStatus();
    expect(status.blockedScope).toBe('monthly');
    expect(status.month.spentUsd).toBeCloseTo(0.02, 10);
    expect(status.day.exhausted).toBe(false);
  });

  it('prefers the daily scope when both are exhausted', async () => {
    const store = new InMemoryUsageStore();
    await seed(store, [record({ costUsd: 1, costKind: 'actual' })]);
    const usage = service(store, { dailyBudgetUsd: 0.5, monthlyBudgetUsd: 0.5 });
    expect((await usage.budgetStatus()).blockedScope).toBe('daily');
    await expect(usage.assertWithinBudget()).rejects.toThrow(/daily budget/);
  });

  it('allows generation when the budgets are unset (unlimited)', async () => {
    const store = new InMemoryUsageStore();
    await seed(store, [record({ costUsd: 99.5, costKind: 'actual' })]);
    const usage = service(store, { dailyBudgetUsd: null, monthlyBudgetUsd: null });
    await expect(usage.assertWithinBudget()).resolves.toBeUndefined();
    expect((await usage.budgetStatus()).blocked).toBe(false);
  });

  it('does NOT block on unknown-cost requests, but counts them honestly', async () => {
    const store = new InMemoryUsageStore();
    await seed(store, [
      record({ id: 'u1', costUsd: null, costKind: 'unknown' }),
      record({ id: 'u2', costUsd: null, costKind: 'unknown' }),
    ]);
    const usage = service(store, { dailyBudgetUsd: 0.001, monthlyBudgetUsd: null });

    await expect(usage.assertWithinBudget()).resolves.toBeUndefined();
    const status = await usage.budgetStatus();
    expect(status.blocked).toBe(false);
    expect(status.day.spentUsd).toBe(0);
    expect(status.unknownCostRequests).toBe(2);
  });

  it('a cost without a classification never counts as spend', async () => {
    const store = new InMemoryUsageStore();
    await seed(store, [record({ costUsd: 5, costKind: 'unknown' })]);
    const usage = service(store, { dailyBudgetUsd: 0.01, monthlyBudgetUsd: null });
    await expect(usage.assertWithinBudget()).resolves.toBeUndefined();
    expect((await usage.budgetStatus()).unknownCostRequests).toBe(1);
  });

  it('excludes spend from other days; earlier days still count for the month', async () => {
    const store = new InMemoryUsageStore();
    await seed(store, [
      record({ at: '2026-10-11T03:00:00.000Z', costUsd: 5, costKind: 'actual' }), // yesterday
      record({ at: '2026-09-30T03:00:00.000Z', costUsd: 7, costKind: 'actual' }), // last month
    ]);
    const usage = service(store, { dailyBudgetUsd: 0.01, monthlyBudgetUsd: 10 });
    const status = await usage.budgetStatus();
    expect(status.day.spentUsd).toBe(0); // not today
    expect(status.month.spentUsd).toBe(5); // yesterday counts, last month does not (not 12)
    expect(status.blocked).toBe(false);
  });
});

describe('usage summary', () => {
  it('returns day/month totals, recent records and the budget state', async () => {
    const store = new InMemoryUsageStore();
    await seed(store, [
      record({ id: 's1', costUsd: 0.01, costKind: 'actual' }),
      record({ id: 's2', costUsd: null, costKind: 'unknown' }),
    ]);
    const usage = service(store, { dailyBudgetUsd: 1, monthlyBudgetUsd: 10 });
    const summary = await usage.summary(10);

    expect(summary.storage).toBe('memory');
    expect(summary.day.requests).toBe(2);
    expect(summary.month.knownCostUsd).toBeCloseTo(0.01, 10);
    expect(summary.recent).toHaveLength(2);
    expect(summary.budget.blocked).toBe(false);
    expect(summary.budget.timezone).toBe('Asia/Jakarta');
    expect(summary.budget.day.from < summary.budget.day.to).toBe(true);
  });
});

/* ========================================================================== */
/*  Persistence                                                               */
/* ========================================================================== */

describe('file usage ledger', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'part6-usage-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('survives a restart (totals are re-read from disk)', async () => {
    const file = path.join(dir, 'usage.json');
    const first = new FileUsageStore(file);
    await first.append(record({ id: 'r1', costUsd: 0.02, costKind: 'actual' }));

    const restarted = new FileUsageStore(file);
    const totals = await restarted.totals(
      dayWindow('2026-10-12', 'Asia/Jakarta').from,
      dayWindow('2026-10-12', 'Asia/Jakarta').to,
    );
    expect(totals.requests).toBe(1);
    expect(totals.knownCostUsd).toBeCloseTo(0.02, 10);
  });
});

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

describe('window helpers', () => {
  it('computes Jakarta day and month windows', () => {
    const day = dayWindow('2026-10-12', 'Asia/Jakarta');
    // Midnight WIB on 2026-10-12 = 2026-10-11T17:00:00Z (UTC+7, no DST).
    expect(day.from).toBe('2026-10-11T17:00:00.000Z');
    expect(day.to).toBe('2026-10-12T17:00:00.000Z');

    const month = monthWindow('2026-10-12', 'Asia/Jakarta');
    expect(month.from).toBe('2026-09-30T17:00:00.000Z');
    expect(month.to).toBe('2026-10-31T17:00:00.000Z');
  });

  it('adds days and first-of-month keys', () => {
    expect(addDays('2026-10-12', 1)).toBe('2026-10-13');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addMonths('2026-10-12', 1)).toBe('2026-11-01');
    expect(addMonths('2026-12-12', 1)).toBe('2027-01-01');
  });
});
