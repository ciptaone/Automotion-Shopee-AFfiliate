/**
 * Startup crash recovery (Part 5).
 *
 * When a worker dies mid-run the database is left holding state that no
 * process will ever come back for: a `jobs` row stuck in `running` with a
 * lease that keeps ticking down, and a `slot_contents` row whose lock owner
 * will never release it. This module hands both back so the next tick can
 * resume exactly where the crashed run stopped.
 *
 * What recovery DOES:
 *   - requeues jobs whose lease expired, while attempt budget remains
 *     (`attempts < max_attempts`) — so a crash loop terminates by itself;
 *   - fails jobs whose budget is exhausted, with an explicit reason;
 *   - releases expired slot locks and bumps `version` so a worker that is
 *     merely SLOW (not dead) cannot later commit over the released state.
 *
 * What recovery deliberately does NOT do:
 *   - it never touches `completed_at`/`publish_ready` rows — recovery is not
 *     permission to publish anything;
 *   - it never regenerates or replaces assets — the persisted image count and
 *     the existing validated assets stay exactly as they were;
 *   - it never clears `last_error`, so the honest failure reason survives;
 *   - it never deletes data (no DROPs, no "cleanup").
 *
 * It is idempotent and bounded: running it twice changes nothing the second
 * time, and every action is a conditional UPDATE that affects 0 rows when
 * there is nothing to do.
 */
import { sql } from 'drizzle-orm';
import { isRecoverableJobQueue, type JobQueue, type LeaseRecoverySummary } from '../contracts/index.js';
import type { Logger } from '../core/logger.js';
import { sanitizeDatabaseError } from './client.js';
import type { Database } from './client.js';

export interface RecoveryReport {
  readonly requeuedJobs: number;
  readonly failedJobs: number;
  readonly releasedSlotLocks: number;
  readonly jobIds: readonly string[];
  readonly notes: readonly string[];
}

const EMPTY_REPORT: RecoveryReport = {
  requeuedJobs: 0,
  failedJobs: 0,
  releasedSlotLocks: 0,
  jobIds: [],
  notes: [],
};

/**
 * Release slot rows whose lock owner's lease expired.
 *
 * `version` is bumped on purpose: a worker that is still alive but too slow
 * will lose its optimistic write guard, so its late `put()` is rejected with a
 * conflict instead of overwriting whatever the next run produced.
 */
export async function releaseExpiredSlotLocks(db: Database): Promise<number> {
  const released = await db.execute(
    sql`
      update slot_contents
      set lock_owner = null,
          lock_expires_at = null,
          version = slot_contents.version + 1
      where lock_expires_at is not null
        and lock_expires_at <= now()
      returning slot_key`,
  );
  // `RETURNING` is what makes the count meaningful: an UPDATE without it has no
  // rows, and the report would claim "0 released" no matter what happened.
  return Array.isArray(released) ? released.length : 0;
}

/**
 * Run all recovery steps. Safe to call on every boot, including the first.
 *
 * Failures are logged, never swallowed silently and never fatal: a database
 * that is briefly unavailable at boot must not stop the process from starting
 * and telling the operator what is wrong (the scheduler tick will simply find
 * nothing to claim until it recovers).
 */
export async function recoverOnStartup(
  input: {
    readonly db: Database | null;
    readonly queue: JobQueue;
    readonly logger?: Logger | null;
  },
): Promise<RecoveryReport> {
  const { db, queue, logger } = input;
  const notes: string[] = [];

  let leaseSummary: LeaseRecoverySummary | null = null;
  if (isRecoverableJobQueue(queue)) {
    try {
      leaseSummary = await queue.recoverExpiredLeases();
    } catch (error) {
      notes.push(`job lease recovery failed: ${sanitizeDatabaseError(error)}`);
      logger?.warn({ err: sanitizeDatabaseError(error) }, 'job lease recovery skipped');
    }
  } else {
    notes.push('queue has no durable leases (in-memory) — nothing to recover');
  }

  let releasedSlotLocks = 0;
  if (db) {
    try {
      releasedSlotLocks = await releaseExpiredSlotLocks(db);
    } catch (error) {
      notes.push(`slot lock release failed: ${sanitizeDatabaseError(error)}`);
      logger?.warn({ err: sanitizeDatabaseError(error) }, 'slot lock release skipped');
    }
  }

  const report: RecoveryReport = {
    requeuedJobs: leaseSummary?.requeued ?? 0,
    failedJobs: leaseSummary?.failed ?? 0,
    releasedSlotLocks,
    jobIds: leaseSummary?.jobIds ?? [],
    notes,
  };

  if (report.requeuedJobs > 0 || report.failedJobs > 0 || report.releasedSlotLocks > 0) {
    logger?.info(
      {
        requeuedJobs: report.requeuedJobs,
        failedJobs: report.failedJobs,
        releasedSlotLocks: report.releasedSlotLocks,
      },
      'recovered interrupted work from the previous run',
    );
  } else {
    logger?.debug({ ...EMPTY_REPORT, jobIds: [] }, 'startup recovery: nothing to recover');
  }

  return report;
}
