/**
 * PostgreSQL job queue (Part 5) — durable, lease-based, safe for many workers.
 *
 * Same `JobQueue` contract as `InMemoryJobQueue`, but every guarantee that was
 * previously provided by "Node is single-threaded" is now provided by the
 * database:
 *
 *  - **Identity**: `jobs_unique_key_idx` is a UNIQUE index. Enqueueing an
 *    existing key is a no-op; re-enqueueing a FAILED/CANCELLED key resets that
 *    SAME row instead of inserting a second one, so a slot can never have two
 *    logical jobs (the in-memory queue would allocate a new id there).
 *  - **Claiming**: a single statement picks the oldest due job with
 *    `FOR UPDATE SKIP LOCKED` and flips it to `running`, so two workers never
 *    claim the same row and neither blocks the other.
 *  - **Ownership**: every claim mints a `claim_token` and a lease deadline.
 *    `complete`/`fail` must present the token AND a still-valid lease; a stale
 *    worker gets `StaleClaimError` instead of overwriting newer results.
 *  - **Crash recovery**: a worker that dies leaves `status='running'` with an
 *    expiring lease. `recoverExpiredLeases()` (startup) and `claim()` (inline)
 *    hand the job back to the queue, bounded by `attempts < max_attempts`, so
 *    a crash loop terminates instead of running forever.
 *  - **Retry**: identical backoff to the in-memory queue — 30s * 2^(n-1),
 *    capped at 15 minutes — computed in SQL so every process agrees.
 *
 * Time comes from the DATABASE clock (`now()`), never from the app, so leases
 * cannot be extended or missed because of clock skew between workers.
 *
 * Live publishing is not touched here: a succeeded content job only ever means
 * "reached publish_ready".
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { DailyPostLimitError, StaleClaimError } from '../core/errors.js';
import type {
  EnqueueJobInput,
  JobClaimOptions,
  JobQueue,
  JobRecord,
  LeaseRecoverySummary,
  QueueStats,
} from '../contracts/index.js';
import type { Database } from './client.js';

const DEFAULT_LEASE_MS = 120_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

type Row = Record<string, unknown>;

/**
 * Anything that can run SQL: the pooled database, or a transaction. Used by the
 * PART 6 capped enqueue so the count and the insert share one transaction.
 */
interface SqlExecutor {
  execute(query: SQL): unknown;
}

/** Row -> `JobRecord`, tolerating driver differences in timestamp types. */
function toRecord(row: Row): JobRecord {
  return {
    id: String(row.id),
    kind: String(row.kind),
    status: row.status as JobRecord['status'],
    uniqueKey: String(row.unique_key),
    scheduledFor: iso(row.scheduled_for),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    claimedBy: row.claimed_by === null || row.claimed_by === undefined ? null : String(row.claimed_by),
    claimedAt: row.claimed_at === null || row.claimed_at === undefined ? null : iso(row.claimed_at),
    leaseExpiresAt:
      row.lease_expires_at === null || row.lease_expires_at === undefined
        ? null
        : iso(row.lease_expires_at),
    claimToken: row.claim_token === null || row.claim_token === undefined ? null : String(row.claim_token),
    completedAt:
      row.completed_at === null || row.completed_at === undefined ? null : iso(row.completed_at),
  };
}

/** Normalise Date | string | number (epoch or ms) to an ISO-8601 UTC string. */
function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return new Date(Number(value)).toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') {
    // postgres.js may hand back an offset-less timestamp for timestamptz.
    const parsed = new Date(value.includes('T') && !/(Z|[+-]\d{2}:?\d{2})$/.test(value) ? `${value}Z` : value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}

async function rowsOf(db: SqlExecutor, query: SQL): Promise<Row[]> {
  const result = (await db.execute(query)) as unknown;
  if (Array.isArray(result)) return result as Row[];
  // Some drivers wrap the row list; unwrap defensively.
  const maybeRows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(maybeRows) ? (maybeRows as Row[]) : [];
}

async function firstOf(db: SqlExecutor, query: SQL): Promise<Row | null> {
  const rows = await rowsOf(db, query);
  return rows[0] ?? null;
}

/**
 * The insert/reset half of `enqueue`, reusable inside a transaction (the
 * capped path) and on the pooled connection (the uncapped path).
 */
async function enqueueRow(exec: SqlExecutor, input: EnqueueJobInput): Promise<Row | null> {
  const id = randomUUID();
  return firstOf(
    exec,
    sql`
      insert into jobs (id, kind, status, unique_key, scheduled_for, attempts, max_attempts,
                        payload, created_at, updated_at)
      values (${id}, ${input.kind}, 'pending', ${input.uniqueKey}, ${input.scheduledFor}::timestamptz,
              0, ${input.maxAttempts ?? 3}, ${JSON.stringify(input.payload ?? {})}, now(), now())
      on conflict (unique_key) do update set
        kind = excluded.kind,
        status = 'pending',
        scheduled_for = excluded.scheduled_for,
        attempts = 0,
        max_attempts = excluded.max_attempts,
        payload = excluded.payload,
        last_error = null,
        claimed_by = null,
        claimed_at = null,
        lease_expires_at = null,
        claim_token = null,
        completed_at = null,
        result = '{}',
        updated_at = now()
      where jobs.status in ('failed', 'cancelled')
      returning *`,
  );
}

async function fetchByUniqueKey(exec: SqlExecutor, uniqueKey: string): Promise<Row | null> {
  return firstOf(exec, sql`select * from jobs where unique_key = ${uniqueKey} limit 1`);
}

/**
 * Stable advisory-lock key for a day prefix (FNV-1a, signed 32-bit). Two
 * processes planning the same day therefore serialize on the same lock, which
 * is what makes the daily cap transactional instead of best-effort.
 */
export function dayLockKey(dayPrefix: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < dayPrefix.length; i += 1) {
    hash ^= dayPrefix.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash | 0;
}

export interface PostgresJobQueueOptions {
  readonly db: Database;
  /** Lease window for a claimed job. Default 120s. */
  readonly leaseMs?: number;
}

export class PostgresJobQueue implements JobQueue {
  private readonly db: Database;
  private readonly leaseMs: number;

  constructor(options: PostgresJobQueueOptions) {
    this.db = options.db;
    this.leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  }

  /**
   * Idempotent insert-or-reset keyed by `unique_key`.
   *
   * A live or already-succeeded job returns as-is (no duplicate). A failed or
   * cancelled job is RESET IN PLACE — one row per logical slot, forever.
   *
   * PART 6 §7: when the caller supplies `dailyCap`, the count and the insert
   * run inside ONE transaction guarded by a per-day advisory lock, so two
   * workers (or two processes) can never exceed the configured daily target.
   */
  async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    if (!input.dailyCap) {
      const inserted = await enqueueRow(this.db, input);
      if (inserted) return toRecord(inserted);
      const existing = await fetchByUniqueKey(this.db, input.uniqueKey);
      if (!existing) {
        // Extremely unlikely (the row vanished between the two statements), but
        // never invent success: surface it as a normal not-found.
        throw new Error(`Job ${input.uniqueKey} not found after enqueue`);
      }
      return toRecord(existing);
    }

    const cap = input.dailyCap;
    const day = cap.dayPrefix.replace(/#$/, '');

    return this.db.transaction(async (tx) => {
      const executor = tx as unknown as SqlExecutor;
      // Serialize every planner working on this day (same key => same lock).
      await executor.execute(sql`select pg_advisory_xact_lock(${dayLockKey(cap.dayPrefix)}::int)`);

      // Idempotent path first: an existing key is NEVER refused by the cap.
      const existing = await fetchByUniqueKey(executor, input.uniqueKey);
      const resettable =
        existing !== null && (existing.status === 'failed' || existing.status === 'cancelled');
      if (existing && !resettable) {
        return toRecord(existing);
      }

      // Count NEW logical jobs for the day (a reset reuses its own row, so it
      // must not consume another unit of the target).
      const countRow = await firstOf(
        executor,
        sql`
          select count(*)::int as count
          from jobs
          where unique_key like ${`${cap.dayPrefix}%`}
            and unique_key <> ${input.uniqueKey}`,
      );
      const used = countRow ? Number(countRow.count) : 0;
      if (used >= cap.max) {
        throw new DailyPostLimitError(day, cap.max);
      }

      const inserted = await enqueueRow(executor, input);
      if (inserted) return toRecord(inserted);

      const raced = await fetchByUniqueKey(executor, input.uniqueKey);
      if (!raced) throw new Error(`Job ${input.uniqueKey} not found after capped enqueue`);
      return toRecord(raced);
    });
  }

  /**
   * Atomically claim the oldest due job.
   *
   * Also picks up jobs whose previous owner's lease expired (crash recovery),
   * but only while that job still has attempt budget left.
   */
  async claim(workerId: string): Promise<JobRecord | null> {
    const token = randomUUID();
    const row = await firstOf(
      this.db,
      sql`
        with candidate as (
          select id from jobs
          where (status = 'pending' and scheduled_for <= now())
             or (status = 'running'
                 and lease_expires_at is not null
                 and lease_expires_at <= now()
                 and attempts < max_attempts)
          order by scheduled_for asc
          limit 1
          for update skip locked
        )
        update jobs j
        set status = 'running',
            claimed_by = ${workerId},
            claimed_at = now(),
            lease_expires_at = now() + (${this.leaseMs}::double precision * interval '1 millisecond'),
            claim_token = ${token}::uuid,
            attempts = j.attempts + 1,
            updated_at = now()
        from candidate c
        where j.id = c.id
        returning j.*`,
    );
    return row ? toRecord(row) : null;
  }

  async complete(
    jobId: string,
    result?: Readonly<Record<string, unknown>>,
    options?: JobClaimOptions,
  ): Promise<void> {
    const token = options?.claimToken ?? null;
    // Even the tokenless bookkeeping path refuses a job that already finished:
    // a late/duplicate completion must never overwrite a newer result.
    const updated = await firstOf(
      this.db,
      sql`
        update jobs
        set status = 'succeeded',
            completed_at = now(),
            claimed_by = null,
            lease_expires_at = null,
            claim_token = null,
            last_error = null,
            result = ${JSON.stringify(result ?? {})}::text,
            updated_at = now()
        where id = ${jobId}::uuid
          and (
            case
              when ${token}::uuid is null then status not in ('succeeded', 'failed')
              else (claim_token = ${token}::uuid and status = 'running')
            end
          )
        returning id`,
    );
    if (updated) return;
    await this.rejectWrite(jobId, token, 'complete', { softWhenMissing: true });
  }

  async fail(
    jobId: string,
    error: string,
    retryable: boolean,
    options?: JobClaimOptions,
  ): Promise<JobRecord> {
    const token = options?.claimToken ?? null;
    const message = error.split('\n')[0]?.slice(0, 500) ?? 'unknown error';
    const row = await firstOf(
      this.db,
      sql`
        update jobs
        set last_error = ${message},
            claimed_by = null,
            lease_expires_at = null,
            claim_token = null,
            status = case when ${retryable}::boolean and attempts < max_attempts then 'pending' else 'failed' end,
            scheduled_for = case
              when ${retryable}::boolean and attempts < max_attempts
                then now() + (least(${BASE_BACKOFF_MS}::double precision * power(2, greatest(attempts - 1, 0)), ${MAX_BACKOFF_MS}::double precision) * interval '1 millisecond')
              else scheduled_for
            end,
            updated_at = now()
        where id = ${jobId}::uuid
          and (
            case
              when ${token}::uuid is null then status not in ('succeeded', 'failed')
              else (claim_token = ${token}::uuid and status = 'running')
            end
          )
        returning *`,
    );
    if (row) return toRecord(row);
    await this.rejectWrite(jobId, token, 'fail', { softWhenMissing: false });
    // `rejectWrite` always throws; this only satisfies the control-flow type.
    throw new Error(`Job ${jobId} not found`);
  }

  /** Renew the lease of a job we still own (long generations). */
  async extendLease(jobId: string, claimToken: string, leaseMs?: number): Promise<boolean> {
    const ms = Math.max(1_000, leaseMs ?? this.leaseMs);
    const row = await firstOf(
      this.db,
      sql`
        update jobs
        set lease_expires_at = now() + (${ms}::double precision * interval '1 millisecond'),
            updated_at = now()
        where id = ${jobId}::uuid
          and claim_token = ${claimToken}::uuid
          and status = 'running'
        returning id`,
    );
    return row !== null;
  }

  /**
   * Startup sweep: hand jobs back whose worker died holding a lease.
   * Bounded by `attempts < max_attempts` — recovery never loops forever and
   * never republishes anything (it only touches queue state).
   */
  async recoverExpiredLeases(): Promise<LeaseRecoverySummary> {
    const failedRows = await rowsOf(
      this.db,
      sql`
        update jobs
        set status = 'failed',
            claimed_by = null,
            lease_expires_at = null,
            claim_token = null,
            last_error = 'worker lease expired and attempt budget exhausted',
            updated_at = now()
        where status = 'running'
          and lease_expires_at is not null
          and lease_expires_at <= now()
          and attempts >= max_attempts
        returning id`,
    );

    const requeuedRows = await rowsOf(
      this.db,
      sql`
        update jobs
        set status = 'pending',
            claimed_by = null,
            claimed_at = null,
            lease_expires_at = null,
            claim_token = null,
            scheduled_for = now(),
            last_error = coalesce(last_error, 'worker lease expired before completion'),
            updated_at = now()
        where status = 'running'
          and lease_expires_at is not null
          and lease_expires_at <= now()
          and attempts < max_attempts
        returning id`,
    );

    return {
      requeued: requeuedRows.length,
      failed: failedRows.length,
      jobIds: [...requeuedRows, ...failedRows].map((row) => String(row.id)),
    };
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const row = await firstOf(this.db, sql`select * from jobs where id = ${jobId}::uuid limit 1`);
    return row ? toRecord(row) : null;
  }

  async getByUniqueKey(uniqueKey: string): Promise<JobRecord | null> {
    const row = await firstOf(this.db, sql`select * from jobs where unique_key = ${uniqueKey} limit 1`);
    return row ? toRecord(row) : null;
  }

  async list(limit = 100): Promise<readonly JobRecord[]> {
    const rows = await rowsOf(
      this.db,
      sql`select * from jobs order by created_at desc limit ${Math.min(Math.max(1, limit), 500)}`,
    );
    return rows.map(toRecord);
  }

  /** Test/ops helper: how many jobs are in a given status. */
  async countByStatus(status: JobRecord['status']): Promise<number> {
    const row = await firstOf(
      this.db,
      sql`select count(*)::int as count from jobs where status = ${status}`,
    );
    return row ? Number(row.count) : 0;
  }

  /**
   * PART 8 4: observability snapshot in ONE round trip. Age uses the database
   * clock, like leases, so app clock skew cannot inflate or hide a backlog.
   * Low-cardinality: counts and ages only — never job ids or payloads.
   */
  async stats(): Promise<QueueStats> {
    const row = await firstOf(
      this.db,
      sql`
        select
          count(*) filter (where status = 'pending')::int                 as pending,
          count(*) filter (where status = 'running')::int                 as running,
          count(*) filter (where status = 'succeeded')::int               as succeeded,
          count(*) filter (where status = 'failed')::int                  as failed,
          count(*) filter (where status = 'cancelled')::int               as cancelled,
          count(*) filter (where status = 'pending' and attempts > 0)::int as retrying,
          min(scheduled_for) filter (where status = 'pending')            as oldest_pending_at,
          round(extract(epoch from (now() - min(scheduled_for) filter (where status = 'pending'))) * 1000)::bigint
                                                                          as oldest_pending_age_ms,
          count(*) filter (where status = 'running'
                             and lease_expires_at is not null
                             and lease_expires_at <= now())::int          as expired_leases
        from jobs`,
    );
    const numberOf = (key: string): number => (row?.[key] === null || row?.[key] === undefined ? 0 : Number(row[key]));
    const oldestPendingAt =
      row?.oldest_pending_at === null || row?.oldest_pending_at === undefined
        ? null
        : iso(row.oldest_pending_at);
    return {
      pending: numberOf('pending'),
      running: numberOf('running'),
      succeeded: numberOf('succeeded'),
      failed: numberOf('failed'),
      cancelled: numberOf('cancelled'),
      retrying: numberOf('retrying'),
      oldestPendingAt,
      oldestPendingAgeMs:
        row?.oldest_pending_age_ms === null || row?.oldest_pending_age_ms === undefined
          ? null
          : Number(row.oldest_pending_age_ms),
      expiredLeases: numberOf('expired_leases'),
    };
  }

  /**
   * Interpret a zero-row write — the distinction the brief calls "never
   * report success for a write that did not happen".
   *
   *  - Row does not exist: `complete` throws `StaleClaimError` ("job no longer
   *    exists") because reporting success for a vanished row would be a lie —
   *    the in-memory queue silently no-ops there, but that behaviour is only
   *    safe when nothing is durable. `fail` reports not-found like the
   *    in-memory queue does.
   *  - Row exists but the claim guard rejected us: the worker lost its lease,
   *    which is ALWAYS an error so the caller logs it instead of pretending.
   */
  private async rejectWrite(
    jobId: string,
    token: string | null,
    action: 'complete' | 'fail',
    options: { softWhenMissing: boolean },
  ): Promise<never> {
    const row = await firstOf(
      this.db,
      sql`select id, status, claim_token, lease_expires_at from jobs where id = ${jobId}::uuid limit 1`,
    );
    if (!row) {
      if (options.softWhenMissing) {
        throw new StaleClaimError(jobId, 'job no longer exists');
      }
      throw new Error(`Job ${jobId} not found`);
    }
    throw new StaleClaimError(
      jobId,
      token
        ? `worker no longer owns the claim (status ${String(row.status)})`
        : `claim guard rejected the ${action} (status ${String(row.status)})`,
    );
  }
}
