/**
 * Durable job queue.
 *
 * Part 1 ships a contract-faithful IN-MEMORY implementation. A PostgreSQL
 * implementation (using `SELECT ... FOR UPDATE SKIP LOCKED` for safe concurrent
 * claiming) is scaffolded in src/db and shares this interface, so swapping the
 * persistence layer does not change any caller.
 *
 * Contracts enforced here and asserted by tests:
 *  - Uniqueness: enqueueing an existing non-terminal `uniqueKey` is a no-op that
 *    returns the existing job (prevents double-scheduling a slot/product).
 *  - Safe retry: a failed retryable job is rescheduled with exponential backoff
 *    until `maxAttempts`; a non-retryable failure moves straight to `failed`.
 *  - Claim atomicity: `claim()` marks a job `running` and returns it once; a
 *    second concurrent claim never returns the same job.
 */
import { randomUUID } from 'node:crypto';
import { DailyPostLimitError } from '../core/errors.js';
import type { EnqueueJobInput, JobQueue, JobRecord, QueueStats } from '../contracts/index.js';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/** Base backoff in ms; attempt N waits BASE * 2^(N-1), capped at MAX_BACKOFF. */
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

interface MutableJob {
  id: string;
  kind: string;
  status: JobRecord['status'];
  uniqueKey: string;
  scheduledFor: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  payload: Readonly<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
  claimedBy: string | null;
}

function toRecord(job: MutableJob): JobRecord {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    uniqueKey: job.uniqueKey,
    scheduledFor: job.scheduledFor,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    lastError: job.lastError,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export class InMemoryJobQueue implements JobQueue {
  private readonly jobs = new Map<string, MutableJob>();
  private readonly byUniqueKey = new Map<string, string>();
  /** Injectable clock so tests can advance time deterministically. */
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    const existingId = this.byUniqueKey.get(input.uniqueKey);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      // Uniqueness contract: skip only when the job is still live or already done.
      if (existing && !TERMINAL_STATUSES.has(existing.status)) {
        return toRecord(existing);
      }
      if (existing && existing.status === 'succeeded') {
        // Already completed for this key — do not re-run.
        return toRecord(existing);
      }
    }

    // PART 6 §7: the daily target is a hard cap, enforced before the row is
    // created (the PostgreSQL queue does the same check transactionally).
    if (input.dailyCap) {
      const used = this.countDay(input.dailyCap.dayPrefix);
      if (used >= input.dailyCap.max) {
        throw new DailyPostLimitError(input.dailyCap.dayPrefix.replace(/#$/, ''), input.dailyCap.max);
      }
    }

    const timestamp = this.now().toISOString();
    const job: MutableJob = {
      id: randomUUID(),
      kind: input.kind,
      status: 'pending',
      uniqueKey: input.uniqueKey,
      scheduledFor: input.scheduledFor,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      lastError: null,
      payload: input.payload,
      createdAt: timestamp,
      updatedAt: timestamp,
      claimedBy: null,
    };
    this.jobs.set(job.id, job);
    this.byUniqueKey.set(input.uniqueKey, job.id);
    return toRecord(job);
  }

  async claim(workerId: string): Promise<JobRecord | null> {
    const nowMs = this.now().getTime();
    let best: MutableJob | null = null;

    for (const job of this.jobs.values()) {
      if (job.status !== 'pending') {
        continue;
      }
      if (Date.parse(job.scheduledFor) > nowMs) {
        continue;
      }
      if (!best || Date.parse(job.scheduledFor) < Date.parse(best.scheduledFor)) {
        best = job;
      }
    }

    if (!best) {
      return null;
    }

    // Atomic claim: flip to running exactly once.
    best.status = 'running';
    best.attempts += 1;
    best.claimedBy = workerId;
    best.updatedAt = this.now().toISOString();
    return toRecord(best);
  }

  async complete(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }
    job.status = 'succeeded';
    job.claimedBy = null;
    job.updatedAt = this.now().toISOString();
  }

  async fail(jobId: string, error: string, retryable: boolean): Promise<JobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    job.lastError = error;
    job.claimedBy = null;
    job.updatedAt = this.now().toISOString();

    const canRetry = retryable && job.attempts < job.maxAttempts;
    if (canRetry) {
      job.status = 'pending';
      job.scheduledFor = new Date(this.now().getTime() + backoffMs(job.attempts)).toISOString();
    } else {
      job.status = 'failed';
    }
    return toRecord(job);
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const job = this.jobs.get(jobId);
    return job ? toRecord(job) : null;
  }

  async getByUniqueKey(uniqueKey: string): Promise<JobRecord | null> {
    const id = this.byUniqueKey.get(uniqueKey);
    if (!id) {
      return null;
    }
    const job = this.jobs.get(id);
    return job ? toRecord(job) : null;
  }

  async list(limit = 100): Promise<readonly JobRecord[]> {
    const all = [...this.jobs.values()]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit)
      .map(toRecord);
    return all;
  }

  /** Test helper: expose payload for assertions. */
  getPayload(jobId: string): Readonly<Record<string, unknown>> | null {
    return this.jobs.get(jobId)?.payload ?? null;
  }

  /** Test helper: number of jobs in a given status. */
  countByStatus(status: JobRecord['status']): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === status) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * PART 8 4: observability snapshot. The in-memory queue has no leases, so
   * `expiredLeases` is always 0 there by definition.
   */
  async stats(): Promise<QueueStats> {
    const counts: Record<JobRecord['status'], number> = {
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    };
    let retrying = 0;
    let oldestPendingAt: string | null = null;

    for (const job of this.jobs.values()) {
      counts[job.status] = (counts[job.status] ?? 0) + 1;
      if (job.status === 'pending') {
        if (job.attempts > 0) retrying += 1;
        if (oldestPendingAt === null || Date.parse(job.scheduledFor) < Date.parse(oldestPendingAt)) {
          oldestPendingAt = job.scheduledFor;
        }
      }
    }

    return {
      pending: counts.pending,
      running: counts.running,
      succeeded: counts.succeeded,
      failed: counts.failed,
      cancelled: counts.cancelled,
      retrying,
      oldestPendingAt,
      oldestPendingAgeMs:
        oldestPendingAt === null ? null : Math.max(0, this.now().getTime() - Date.parse(oldestPendingAt)),
      expiredLeases: 0,
    };
  }

  /**
   * PART 6 §7: how many logical jobs a day already holds. Every row counts
   * (including failed ones) — a slot can never be re-created to sneak past
   * the cap.
   */
  countDay(dayPrefix: string): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.uniqueKey.startsWith(dayPrefix)) {
        count += 1;
      }
    }
    return count;
  }
}

function backoffMs(attempt: number): number {
  const exp = BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(exp, MAX_BACKOFF_MS);
}
