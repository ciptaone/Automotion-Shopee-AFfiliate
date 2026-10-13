/**
 * Generation usage ledger + budget inputs (Part 6 §10).
 *
 * Records EVERY generation request (pipeline runs and dashboard test actions)
 * with the provider/model actually used, the request id WHEN the provider
 * reported one, token/image usage when available, and a cost that is explicitly
 * classified as `actual` / `estimated` / `unknown`. Nothing is ever invented:
 * a provider that reports no cost produces `unknown`, never `0.0000` presented
 * as a real charge.
 *
 * Persistence mirrors the other stores: memory (tests), file (dev) and
 * PostgreSQL (`generation_usage`) so records survive restarts in production.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { atomicWriteText, createSerialQueue } from '../core/atomic-file.js';
import { AppError } from '../core/errors.js';
import { generationUsage } from '../db/schema.js';
import type { Database } from '../db/client.js';

export type UsageOperation =
  | 'text_generation'
  | 'image_generation'
  | 'test_text'
  | 'test_image'
  | 'test_connection';

export type CostKind = 'actual' | 'estimated' | 'unknown';

export interface UsageRecord {
  readonly id: string;
  /** ISO instant of the request. */
  readonly at: string;
  readonly providerId: string | null;
  readonly providerName: string;
  readonly adapterType: string | null;
  readonly model: string;
  readonly operation: UsageOperation;
  /** Provider-reported request id — null when the provider reported none. */
  readonly requestId: string | null;
  readonly status: 'success' | 'error';
  readonly latencyMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly images: number | null;
  readonly costUsd: number | null;
  readonly costKind: CostKind;
  readonly errorCode: string | null;
}

export interface UsageRecordInput {
  readonly providerId: string | null;
  readonly providerName: string;
  readonly adapterType: string | null;
  readonly model: string;
  readonly operation: UsageOperation;
  readonly requestId?: string | null;
  readonly status: 'success' | 'error';
  readonly latencyMs: number;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly images?: number | null;
  readonly costUsd?: number | null;
  readonly costKind?: CostKind;
  readonly errorCode?: string | null;
}

export interface UsageTotals {
  readonly requests: number;
  readonly failures: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly images: number;
  /** Sum of costs that were actually reported (actual or provider estimate). */
  readonly knownCostUsd: number;
  readonly actualCostUsd: number;
  readonly estimatedCostUsd: number;
  /** Requests whose cost could not be determined — surfaced as "unknown". */
  readonly unknownCostRequests: number;
}

export function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    failures: 0,
    inputTokens: null,
    outputTokens: null,
    images: 0,
    knownCostUsd: 0,
    actualCostUsd: 0,
    estimatedCostUsd: 0,
    unknownCostRequests: 0,
  };
}

/** Fold one record into running totals (shared by memory/file/SQL semantics). */
export function accumulate(total: UsageTotals, record: UsageRecord): UsageTotals {
  const known = record.costKind !== 'unknown' && typeof record.costUsd === 'number';
  return {
    requests: total.requests + 1,
    failures: total.failures + (record.status === 'error' ? 1 : 0),
    inputTokens:
      total.inputTokens === null && record.inputTokens === null
        ? null
        : (total.inputTokens ?? 0) + (record.inputTokens ?? 0),
    outputTokens:
      total.outputTokens === null && record.outputTokens === null
        ? null
        : (total.outputTokens ?? 0) + (record.outputTokens ?? 0),
    images: total.images + (record.images ?? 0),
    knownCostUsd: total.knownCostUsd + (known ? (record.costUsd as number) : 0),
    actualCostUsd:
      total.actualCostUsd + (known && record.costKind === 'actual' ? (record.costUsd as number) : 0),
    estimatedCostUsd:
      total.estimatedCostUsd +
      (known && record.costKind === 'estimated' ? (record.costUsd as number) : 0),
    unknownCostRequests: total.unknownCostRequests + (known ? 0 : 1),
  };
}

export function toRecord(input: UsageRecordInput): UsageRecord {
  const costUsd = input.costUsd ?? null;
  return {
    id: randomUUID(),
    at: new Date().toISOString(),
    providerId: input.providerId,
    providerName: input.providerName,
    adapterType: input.adapterType,
    model: input.model,
    operation: input.operation,
    requestId: input.requestId ?? null,
    status: input.status,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    images: input.images ?? null,
    costUsd,
    // A number with no classification defaults to "unknown" — never assume it
    // is an actual charge.
    costKind: input.costKind ?? 'unknown',
    errorCode: input.errorCode ?? null,
  };
}

export interface UsageStore {
  readonly kind: 'memory' | 'file' | 'postgres';
  append(record: UsageRecord): Promise<void>;
  list(limit?: number): Promise<readonly UsageRecord[]>;
  /** Aggregated totals for `[from, to)` (ISO instants). */
  totals(fromIso: string, toIso: string): Promise<UsageTotals>;
}

function totalsOver(records: Iterable<UsageRecord>, fromIso: string, toIso: string): UsageTotals {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  let totals = emptyTotals();
  for (const record of records) {
    const at = Date.parse(record.at);
    if (at >= from && at < to) totals = accumulate(totals, record);
  }
  return totals;
}

/* -------------------------------------------------------------------------- */

export class InMemoryUsageStore implements UsageStore {
  readonly kind = 'memory' as const;
  private readonly records: UsageRecord[] = [];
  private readonly limit: number;

  constructor(limit = 5_000) {
    this.limit = limit;
  }

  async append(record: UsageRecord): Promise<void> {
    this.records.push(record);
    if (this.records.length > this.limit) {
      this.records.splice(0, this.records.length - this.limit);
    }
  }

  async list(limit = 100): Promise<readonly UsageRecord[]> {
    return this.records.slice(-Math.min(Math.max(1, limit), this.limit)).reverse();
  }

  async totals(fromIso: string, toIso: string): Promise<UsageTotals> {
    return totalsOver(this.records, fromIso, toIso);
  }
}

interface UsageFileDocument {
  readonly v: 1;
  readonly records: UsageRecord[];
}

export class FileUsageStore implements UsageStore {
  readonly kind = 'file' as const;
  private readonly queue = createSerialQueue();
  private cache: UsageFileDocument | null = null;

  constructor(
    private readonly filePath: string,
    private readonly limit = 2_000,
  ) {}

  private async load(): Promise<UsageFileDocument> {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = { v: 1, records: [] };
        return this.cache;
      }
      throw new AppError({
        code: 'USAGE_STORE_FAILED',
        category: 'configuration',
        message: 'Usage ledger could not be read.',
        expose: false,
        retryable: false,
        cause: error,
        context: {},
      });
    }
    try {
      const parsed = JSON.parse(raw) as UsageFileDocument;
      this.cache = { v: 1, records: Array.isArray(parsed.records) ? parsed.records : [] };
    } catch {
      this.cache = { v: 1, records: [] };
    }
    return this.cache;
  }

  async append(record: UsageRecord): Promise<void> {
    await this.queue(async () => {
      const doc = await this.load();
      const records = [...doc.records, record];
      const trimmed = records.slice(-this.limit);
      this.cache = { v: 1, records: trimmed };
      await atomicWriteText(this.filePath, `${JSON.stringify(this.cache, null, 2)}\n`);
    });
  }

  async list(limit = 100): Promise<readonly UsageRecord[]> {
    const doc = await this.load();
    return doc.records.slice(-Math.min(Math.max(1, limit), this.limit)).reverse();
  }

  async totals(fromIso: string, toIso: string): Promise<UsageTotals> {
    const doc = await this.load();
    return totalsOver(doc.records, fromIso, toIso);
  }
}

type Row = Record<string, unknown>;

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class PostgresUsageStore implements UsageStore {
  readonly kind = 'postgres' as const;

  constructor(private readonly db: Database) {}

  async append(record: UsageRecord): Promise<void> {
    await this.db.insert(generationUsage).values({
      id: record.id,
      providerId: record.providerId,
      providerName: record.providerName,
      adapterType: record.adapterType,
      model: record.model,
      operation: record.operation,
      requestId: record.requestId,
      status: record.status,
      latencyMs: record.latencyMs,
      at: new Date(record.at),
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      images: record.images,
      costUsd: record.costUsd,
      costKind: record.costKind,
      errorCode: record.errorCode,
    } as never);
  }

  async list(limit = 100): Promise<readonly UsageRecord[]> {
    const rows = (await this.db
      .select()
      .from(generationUsage)
      .orderBy(sql`${generationUsage.at} desc`)
      .limit(Math.min(Math.max(1, limit), 1_000))) as unknown as Row[];
    return rows.map((row) => ({
      id: String(row['id']),
      at: toIso(row['at']),
      providerId: row['providerId'] === null || row['providerId'] === undefined ? null : String(row['providerId']),
      providerName: String(row['providerName'] ?? ''),
      adapterType: row['adapterType'] === null || row['adapterType'] === undefined ? null : String(row['adapterType']),
      model: String(row['model'] ?? ''),
      operation: row['operation'] as UsageRecord['operation'],
      requestId: row['requestId'] === null || row['requestId'] === undefined ? null : String(row['requestId']),
      status: row['status'] as UsageRecord['status'],
      latencyMs: Number(row['latencyMs'] ?? 0),
      inputTokens: numberOrNull(row['inputTokens']),
      outputTokens: numberOrNull(row['outputTokens']),
      images: numberOrNull(row['images']),
      costUsd: numberOrNull(row['costUsd']),
      costKind: (row['costKind'] as CostKind) ?? 'unknown',
      errorCode: row['errorCode'] === null || row['errorCode'] === undefined ? null : String(row['errorCode']),
    }));
  }

  async totals(fromIso: string, toIso: string): Promise<UsageTotals> {
    const rows = (await this.db.execute(sql`
      select count(*)::int as requests,
             coalesce(sum(case when status = 'error' then 1 else 0 end), 0)::int as failures,
             sum(input_tokens)::bigint as input_tokens,
             sum(output_tokens)::bigint as output_tokens,
             coalesce(sum(images), 0)::int as images,
             coalesce(sum(case when cost_kind in ('actual','estimated') then cost_usd else 0 end), 0)::float as known_cost,
             coalesce(sum(case when cost_kind = 'actual' then cost_usd else 0 end), 0)::float as actual_cost,
             coalesce(sum(case when cost_kind = 'estimated' then cost_usd else 0 end), 0)::float as estimated_cost,
             coalesce(sum(case when cost_kind = 'unknown' then 1 else 0 end), 0)::int as unknown_cost_requests
      from generation_usage
      where at >= ${fromIso}::timestamptz and at < ${toIso}::timestamptz
    `)) as unknown;
    const list = Array.isArray(rows) ? (rows as Row[]) : ((rows as { rows?: Row[] }).rows ?? []);
    const row = list[0];
    if (!row) return emptyTotals();
    return {
      requests: Number(row['requests'] ?? 0),
      failures: Number(row['failures'] ?? 0),
      inputTokens: numberOrNull(row['input_tokens']),
      outputTokens: numberOrNull(row['output_tokens']),
      images: Number(row['images'] ?? 0),
      knownCostUsd: Number(row['known_cost'] ?? 0),
      actualCostUsd: Number(row['actual_cost'] ?? 0),
      estimatedCostUsd: Number(row['estimated_cost'] ?? 0),
      unknownCostRequests: Number(row['unknown_cost_requests'] ?? 0),
    };
  }
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}
