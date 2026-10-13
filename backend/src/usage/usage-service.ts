/**
 * Usage accounting + budget enforcement (Part 6 §10).
 *
 * Responsibilities:
 *  - record every generation request (provider, model, request id, latency,
 *    token/image usage, cost classification),
 *  - expose honest totals: actual vs estimated vs UNKNOWN cost are never merged,
 *  - enforce configurable daily/monthly budgets BEFORE a new generation starts,
 *    so an exhausted budget blocks spending instead of running up a tab.
 *
 * Budget semantics (documented limitation): only costs the provider actually
 * reported are summed. Requests with `costKind: 'unknown'` are counted and
 * displayed separately — they are never treated as $0.00 of real spend, and
 * they never silently block the pipeline either (blocking on unknown cost would
 * be equally dishonest). See part-06-evidence.md §"Usage and cost limitations".
 */
import { formatInTimeZone, localToUtc } from '../scheduler/slots.js';
import { BudgetExhaustedError } from '../core/errors.js';
import {
  emptyTotals,
  toRecord,
  type UsageRecord,
  type UsageRecordInput,
  type UsageStore,
  type UsageTotals,
} from './usage-store.js';

export interface BudgetConfig {
  readonly dailyBudgetUsd: number | null;
  readonly monthlyBudgetUsd: number | null;
}

export interface BudgetWindow {
  readonly from: string;
  readonly to: string;
  readonly spentUsd: number;
  readonly budgetUsd: number | null;
  readonly exhausted: boolean;
}

export interface BudgetStatus {
  readonly timezone: string;
  readonly dailyBudgetUsd: number | null;
  readonly monthlyBudgetUsd: number | null;
  readonly day: BudgetWindow;
  readonly month: BudgetWindow;
  readonly blocked: boolean;
  readonly blockedScope: 'daily' | 'monthly' | null;
  readonly unknownCostRequests: number;
  readonly note: string;
}

export interface UsageSummary {
  readonly day: UsageTotals;
  readonly month: UsageTotals;
  readonly recent: readonly UsageRecord[];
  readonly budget: BudgetStatus;
  readonly storage: 'memory' | 'file' | 'postgres';
}

/** Next calendar day key (Jakarta has no DST, so date arithmetic is exact). */
export function addDays(dateKey: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = dateKey
    .split('-')
    .map((part) => Number.parseInt(part, 10));
  const base = Date.UTC(y, m - 1, d);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/** First day of the month containing `dateKey`, plus `months` offset. */
export function addMonths(dateKey: string, months: number): string {
  const year = Number.parseInt(dateKey.slice(0, 4), 10);
  const month = Number.parseInt(dateKey.slice(5, 7), 10);
  const total = (year * 12 + (month - 1)) + months;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12) + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`;
}

export function dayWindow(dateKey: string, timezone: string): { from: string; to: string } {
  return {
    from: localToUtc(`${dateKey}T00:00:00`, timezone).toISOString(),
    to: localToUtc(`${addDays(dateKey, 1)}T00:00:00`, timezone).toISOString(),
  };
}

export function monthWindow(dateKey: string, timezone: string): { from: string; to: string } {
  const firstOfMonth = `${dateKey.slice(0, 7)}-01`;
  return {
    from: localToUtc(`${firstOfMonth}T00:00:00`, timezone).toISOString(),
    to: localToUtc(`${addMonths(firstOfMonth, 1)}T00:00:00`, timezone).toISOString(),
  };
}

export class UsageService {
  constructor(
    private readonly store: UsageStore,
    private readonly budgets: () => BudgetConfig,
    private readonly timezone: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get storage(): 'memory' | 'file' | 'postgres' {
    return this.store.kind;
  }

  /** Persist one usage record. Failures never break the generation itself. */
  async record(input: UsageRecordInput): Promise<UsageRecord | null> {
    try {
      const record = toRecord(input);
      await this.store.append(record);
      return record;
    } catch {
      return null;
    }
  }

  /**
   * Throw when the configured budget is exhausted. Called BEFORE any
   * generation request so an exhausted budget blocks new spend.
   */
  async assertWithinBudget(): Promise<void> {
    const status = await this.budgetStatus();
    if (status.blocked && status.blockedScope === 'daily') {
      throw new BudgetExhaustedError('daily', status.dailyBudgetUsd ?? 0, status.day.spentUsd);
    }
    if (status.blocked && status.blockedScope === 'monthly') {
      throw new BudgetExhaustedError('monthly', status.monthlyBudgetUsd ?? 0, status.month.spentUsd);
    }
  }

  async budgetStatus(): Promise<BudgetStatus> {
    const now = this.now();
    const today = formatInTimeZone(now, this.timezone);
    const budget = this.budgets();
    const day = dayWindow(today, this.timezone);
    const month = monthWindow(today, this.timezone);

    const dayTotals = await this.store.totals(day.from, day.to);
    const monthTotals = await this.store.totals(month.from, month.to);

    const daySpent = round4(dayTotals.knownCostUsd);
    const monthSpent = round4(monthTotals.knownCostUsd);

    const dayExhausted =
      budget.dailyBudgetUsd !== null && budget.dailyBudgetUsd >= 0 && daySpent >= budget.dailyBudgetUsd;
    const monthExhausted =
      budget.monthlyBudgetUsd !== null &&
      budget.monthlyBudgetUsd >= 0 &&
      monthSpent >= budget.monthlyBudgetUsd;

    return {
      timezone: this.timezone,
      dailyBudgetUsd: budget.dailyBudgetUsd,
      monthlyBudgetUsd: budget.monthlyBudgetUsd,
      day: {
        from: day.from,
        to: day.to,
        spentUsd: daySpent,
        budgetUsd: budget.dailyBudgetUsd,
        exhausted: dayExhausted,
      },
      month: {
        from: month.from,
        to: month.to,
        spentUsd: monthSpent,
        budgetUsd: budget.monthlyBudgetUsd,
        exhausted: monthExhausted,
      },
      blocked: dayExhausted || monthExhausted,
      blockedScope: dayExhausted ? 'daily' : monthExhausted ? 'monthly' : null,
      unknownCostRequests: monthTotals.unknownCostRequests,
      note:
        'Spend counts only provider-reported costs. Requests whose cost the provider does not report are counted as "unknown cost" and are not treated as $0.00.',
    };
  }

  async summary(recentLimit = 20): Promise<UsageSummary> {
    const now = this.now();
    const today = formatInTimeZone(now, this.timezone);
    const day = dayWindow(today, this.timezone);
    const month = monthWindow(today, this.timezone);
    const [dayTotals, monthTotals, recent] = await Promise.all([
      this.store.totals(day.from, day.to),
      this.store.totals(month.from, month.to),
      this.store.list(recentLimit),
    ]);
    return {
      day: dayTotals,
      month: monthTotals,
      recent,
      budget: await this.budgetStatus(),
      storage: this.store.kind,
    };
  }

  /** Empty totals helper re-exported for tests. */
  static empty(): UsageTotals {
    return emptyTotals();
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
