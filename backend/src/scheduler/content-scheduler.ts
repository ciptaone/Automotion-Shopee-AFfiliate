/**
 * Content scheduler (Part 4) — connects the EXISTING scheduler + queue to the
 * REAL content pipeline, so the backend produces content on its own while the
 * APK is closed or the phone is restarted.
 *
 * WHAT THIS MODULE DOES (and what it deliberately does NOT do):
 *  - Computes the due content slots for "today" using the already-tested slot
 *    math in `scheduler/slots.ts` (PART 6 §7: 3–4 slots per Asia/Jakarta day,
 *    one per selected WIB window — 06, 12, 16, 19) — it does NOT reinvent
 *    scheduling. The daily target is enforced as a transactional cap in the
 *    queue (`dailyCap`), and a slot refused by the cap is recorded as
 *    `skipped: daily_target_reached`.
 *  - Enqueues each due slot into the existing `JobQueue` under a PERSISTENT
 *    job identity: `content:<slotKey>`. Enqueueing an existing non-terminal
 *    slot is a no-op (the queue's uniqueness contract), so a slot can never be
 *    double-scheduled or duplicated across restarts or overlapping ticks.
 *  - Claims queued jobs and executes them through `ContentPipeline.runSlot`,
 *    which already reserves a product + slot atomically, snapshots the
 *    selection settings, persists the image count before generation, and
 *    reuses existing valid assets/captions on retry.
 *  - Records precise outcomes: `publish_ready` / `blocked` (with reasons) /
 *    `failed` (retryable, rescheduled by the queue with backoff).
 *  - Resumes interrupted jobs safely: a slot whose record is already in a
 *    terminal stage is skipped (never republished / never regenerated); a
 *    partially-generated slot resumes and reuses what already exists.
 *  - Continues future scheduling after recoverable failures: one failed job
 *    never stops the tick or the next slot.
 *
 * CATCH-UP / DOWNTIME (locked decision): after downtime the scheduler must NOT
 * post a burst of missed content. A tick processes at most
 * `maxCatchUpPerTick` DUE slots (the most recent ones); older overdue slots
 * are recorded as `skipped: catch_up_limited` and are NOT run. The backend is
 * therefore bounded: at most one product per interval going forward, never a
 * back-fill flood.
 *
 * PUBLISHING BOUNDARY (locked): this scheduler NEVER publishes. It only reaches
 * `publish_ready`. Facebook/Threads publishers are not invoked here or in the
 * pipeline; live publishing stays disabled in this part.
 *
 * HONESTY: "24/7 operation" is only true once this backend is deployed on an
 * always-on service AND verified there. In this environment the loop is tested
 * deterministically (injected clock, in-memory queue, mock AI); a live
 * deployment remains BLOCKED / NOT_TESTED.
 */
import type { JobQueue, JobRecord } from '../contracts/index.js';
import { DailyPostLimitError, StaleClaimError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { ContentPipeline } from '../automation/pipeline.js';
import type { SettingsService } from '../settings/automation-settings.js';
import type { SchedulerCheckpointStore } from '../db/postgres-settings-store.js';
import type { SchedulerTickLock } from '../db/postgres-tick-lock.js';
import {
  clampDailyPostTarget,
  computeDailySlots,
  formatInTimeZone,
  localToUtc,
  type SchedulerConfig,
  type Slot,
} from './slots.js';

export const CONTENT_JOB_KIND = 'content_slot';
export const CONTENT_WORKER_ID = 'content-scheduler';
/** uniqueKey prefix; the remainder is the slot key (\"content:<slotKey>\"). */
export const CONTENT_JOB_KIND_PREFIX = 'content:';

/** Job identity for a slot — persistent and idempotent across restarts. */
export function contentJobKey(slotKey: string): string {
  return `${CONTENT_JOB_KIND_PREFIX}${slotKey}`;
}

/** Durable checkpoint document key (PART 5). */
export const CONTENT_SCHEDULER_CHECKPOINT_KEY = 'content_scheduler';
/**
 * Lease heartbeat cadence for an executing job (PART 5). Jobs normally finish
 * well inside one lease (120s); a heartbeat is sent between pipeline attempts
 * so a slow but alive worker is not treated as crashed.
 */
export const CONTENT_JOB_HEARTBEAT_MS = 30_000;

export interface ContentSchedulerDeps {
  readonly queue: JobQueue;
  readonly pipeline: ContentPipeline;
  readonly settings: SettingsService;
  /** Effective scheduler config (interval, daily cap, timezone). */
  readonly schedulerConfig: () => SchedulerConfig;
  readonly logger?: Logger;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /** Max due slots executed per tick (anti catch-up burst). Default 1. */
  readonly maxCatchUpPerTick?: number;
  /** PART 5: durable tick bookkeeping (process-local store in dev/tests). */
  readonly checkpoints?: SchedulerCheckpointStore;
  /** PART 5: cross-process tick lock (advisory lock in PostgreSQL). */
  readonly tickLock?: SchedulerTickLock;
}

export interface SlotOutcome {
  readonly slotKey: string;
  readonly stage: string;
  readonly productId: string | null;
  readonly attempts: number;
}

export interface SkippedSlot {
  readonly slotKey: string;
  readonly reason: 'catch_up_limited' | 'not_due' | 'daily_target_reached';
}

export interface TickResult {
  readonly at: string;
  readonly today: string;
  /**
   * Slot keys for which enqueue() was invoked this tick. Enqueue is IDEMPOTENT
   * (queue uniqueness), so a key may be reported again when an existing pending
   * job is re-confirmed — the job itself is never duplicated.
   */
  readonly enqueued: readonly string[];
  /** Slots executed this tick with their terminal/in-progress stage. */
  readonly executed: readonly SlotOutcome[];
  /** Slots deliberately NOT run (e.g. catch-up limiting after downtime). */
  readonly skipped: readonly SkippedSlot[];
  /** Slots whose pipeline run failed (retryable; queue reschedules). */
  readonly failed: readonly SlotOutcome[];
  /** Jobs still pending/running after the tick (e.g. backing off). */
  readonly pendingJobs: number;
  readonly message: string;
}

/** A due slot with its resolved UTC instant. */
export interface DueSlot {
  readonly slot: Slot;
  readonly instantMs: number;
}

/**
 * Resolve "today's" slots that are DUE (instant ≤ now), newest first.
 * Exported for unit tests; pure given (config, now).
 */
export function dueSlotsFor(
  config: SchedulerConfig,
  now: Date,
): { due: DueSlot[]; today: string } {
  const today = formatInTimeZone(now, config.timezone);
  const all = computeDailySlots(today, config);
  const nowMs = now.getTime();
  const due: DueSlot[] = [];
  for (const slot of all) {
    // scheduledFor is "<local>Time<tz>"; strip the trailing tz id for parsing.
    const local = slot.scheduledFor.slice(0, slot.scheduledFor.length - config.timezone.length);
    const instant = localToUtc(local, config.timezone);
    if (instant.getTime() <= nowMs) {
      due.push({ slot, instantMs: instant.getTime() });
    }
  }
  // Oldest -> newest for execution order; caller may re-slice for recency.
  due.sort((a, b) => a.instantMs - b.instantMs);
  return { due, today };
}

export class ContentScheduler {
  private readonly now: () => Date;
  private readonly maxCatchUpPerTick: number;
  private ticking = false;
  private lastTick: TickResult | null = null;
  private tickLockHeld = false;

  constructor(private readonly deps: ContentSchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.maxCatchUpPerTick = Math.max(1, deps.maxCatchUpPerTick ?? 1);
  }

  /** Most recent tick result (surfaced by the scheduler status endpoint). */
  peekLastTick(): TickResult | null {
    return this.lastTick;
  }

  /** Anti-burst bound: max due slots a single tick may execute. */
  get catchUpLimit(): number {
    return this.maxCatchUpPerTick;
  }

  /**
   * One scheduling pass. Serialized in-process by a flag, and across processes
   * by the optional `tickLock` (a PostgreSQL advisory lock in production), so
   * two backends pointed at the same database can never both plan the same
   * slot window.
   */
  async tick(): Promise<TickResult> {
    if (this.ticking) {
      return {
        at: this.now().toISOString(),
        today: '',
        enqueued: [],
        executed: [],
        skipped: [],
        failed: [],
        pendingJobs: 0,
        message: 'Tick already in progress; skipped overlapping tick.',
      };
    }

    const lock = this.deps.tickLock;
    if (lock && !(await lock.acquire())) {
      // Another process is ticking right now. Doing nothing is always safe:
      // the next tick re-plans from durable state (job uniqueness is what
      // actually prevents duplicate work).
      const locked: TickResult = {
        at: this.now().toISOString(),
        today: '',
        enqueued: [],
        executed: [],
        skipped: [],
        failed: [],
        pendingJobs: 0,
        message: 'Another process holds the scheduler tick lock; this tick was skipped.',
      };
      this.lastTick = locked;
      return locked;
    }
    this.tickLockHeld = Boolean(lock);

    this.ticking = true;
    try {
      const result = await this.runTick();
      this.lastTick = result;
      await this.writeCheckpoint(result);
      return result;
    } finally {
      this.ticking = false;
      if (this.tickLockHeld) {
        this.tickLockHeld = false;
        await lock?.release();
      }
    }
  }

  /**
   * PART 5: persist what the tick did so a restart reports an honest last run
   * instead of pretending nothing ever happened. Best-effort by design: a
   * checkpoint failure must never fail the tick itself (the slot/job tables are
   * the real source of truth).
   */
  private async writeCheckpoint(result: TickResult): Promise<void> {
    const store = this.deps.checkpoints;
    if (!store) return;
    try {
      await store.write(CONTENT_SCHEDULER_CHECKPOINT_KEY, {
        at: result.at,
        today: result.today,
        enqueued: result.enqueued.length,
        executed: result.executed.length,
        failed: result.failed.length,
        skipped: result.skipped.length,
        pendingJobs: result.pendingJobs,
        message: result.message,
        catchUpLimit: this.maxCatchUpPerTick,
        lastExecutedSlots: result.executed.map((entry) => entry.slotKey).slice(-5),
      });
    } catch (error) {
      this.deps.logger?.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'scheduler checkpoint write failed (the tick itself still ran)',
      );
    }
  }

  /**
   * PART 5: bookkeeping writes are guarded by the claim token and never fatal.
   *
   * If the lease was lost, `StaleClaimError` tells us another worker owns the
   * job now — log it and walk away (forcing the write would overwrite newer
   * results). Any other failure is logged too: the pipeline's durable state in
   * `slot_contents` is already written, so the tick must keep going.
   */
  private async safeComplete(
    jobId: string,
    result: Readonly<Record<string, unknown>>,
    claimToken: string | null,
  ): Promise<void> {
    try {
      await this.deps.queue.complete(jobId, result, { claimToken });
    } catch (error) {
      this.deps.logger?.warn(
        { jobId, err: error instanceof Error ? error.message : String(error) },
        error instanceof StaleClaimError
          ? 'job completion skipped: this worker no longer owns the claim'
          : 'job completion could not be recorded',
      );
    }
  }

  private async safeFail(
    jobId: string,
    message: string,
    retryable: boolean,
    claimToken: string | null,
  ): Promise<void> {
    try {
      await this.deps.queue.fail(jobId, message, retryable, { claimToken });
    } catch (error) {
      this.deps.logger?.warn(
        { jobId, err: error instanceof Error ? error.message : String(error) },
        error instanceof StaleClaimError
          ? 'job failure skipped: this worker no longer owns the claim'
          : 'job failure could not be recorded',
      );
    }
  }

  private async runTick(): Promise<TickResult> {
    const { queue, pipeline, settings, schedulerConfig, logger } = this.deps;
    const now = this.now();
    const config = schedulerConfig();
    const enqueued: string[] = [];
    const executed: SlotOutcome[] = [];
    const failed: SlotOutcome[] = [];
    const skipped: SkippedSlot[] = [];

    /* --- Gate 1: automation must be running ---------------------------- */
    const current = settings.current();
    if (current.automationState !== 'running') {
      return {
        at: now.toISOString(),
        today: formatInTimeZone(now, config.timezone),
        enqueued,
        executed,
        skipped,
        failed,
        pendingJobs: await this.countPending(queue),
        message: 'Automation is paused; no slots were scheduled or executed.',
      };
    }

    /* --- Gate 2: compute due slots + bounded catch-up ------------------ */
    const { due, today } = dueSlotsFor(config, now);
    if (due.length === 0) {
      return {
        at: now.toISOString(),
        today,
        enqueued,
        executed,
        skipped,
        failed,
        pendingJobs: await this.countPending(queue),
        message: `No due slots for ${today}.`,
      };
    }

    // Anti catch-up: keep only the most recent `maxCatchUpPerTick` due slots.
    const runnable = due.slice(Math.max(0, due.length - this.maxCatchUpPerTick));
    const overflow = due.slice(0, Math.max(0, due.length - this.maxCatchUpPerTick));
    for (const entry of overflow) {
      skipped.push({ slotKey: entry.slot.key, reason: 'catch_up_limited' });
    }
    if (overflow.length > 0) {
      logger?.warn(
        { skippedCount: overflow.length, kept: runnable.length },
        `Catch-up limited: ${overflow.length} overdue slot(s) were NOT run to avoid a posting burst after downtime.`,
      );
    }

    /* --- Enqueue (persistent identity, idempotent) --------------------- */
    const dailyTarget = clampDailyPostTarget(config.dailyPostTarget);
    for (const entry of runnable) {
      // Skip slots already in a terminal stage (never republish / regenerate).
      const existing = pipeline.get(entry.slot.key);
      if (existing && (existing.stage === 'publish_ready' || existing.stage === 'blocked')) {
        skipped.push({ slotKey: entry.slot.key, reason: 'not_due' });
        continue;
      }
      try {
        const job = await queue.enqueue({
          kind: CONTENT_JOB_KIND,
          uniqueKey: contentJobKey(entry.slot.key),
          scheduledFor: new Date(entry.instantMs).toISOString(),
          payload: { slotKey: entry.slot.key, scheduledFor: entry.slot.scheduledFor },
          maxAttempts: 3,
          // PART 6 §7: the daily posting target is a hard cap. In PostgreSQL
          // this count+insert runs in one transaction under a per-day advisory
          // lock, so concurrent workers cannot exceed it.
          dailyCap: {
            dayPrefix: `${CONTENT_JOB_KIND_PREFIX}${entry.slot.date}#`,
            max: dailyTarget,
          },
        });
        if (!enqueued.includes(entry.slot.key)) {
          enqueued.push(entry.slot.key);
        }
        logger?.debug({ slotKey: entry.slot.key, jobId: job.id, status: job.status }, 'slot enqueued');
      } catch (error) {
        if (error instanceof DailyPostLimitError) {
          // Not an error condition: the operator's target for today is met.
          skipped.push({ slotKey: entry.slot.key, reason: 'daily_target_reached' });
          logger?.info(
            { slotKey: entry.slot.key, target: dailyTarget, day: entry.slot.date },
            'Daily posting target already reached; slot not scheduled.',
          );
          continue;
        }
        throw error;
      }
    }

    /* --- Execute due jobs --------------------------------------------- */
    // Claim until the queue is dry (bounded to avoid pathological loops).
    for (let guard = 0; guard < 24; guard += 1) {
      const job = await queue.claim(CONTENT_WORKER_ID);
      if (!job) break;
      if (job.kind !== CONTENT_JOB_KIND) {
        // Not ours (should not happen); leave it for its own worker.
        await queue.fail(job.id, 'claimed by content scheduler but kind mismatch', false);
        continue;
      }
      // The slot identity is carried in the persistent uniqueKey ("content:<slotKey>").
      const slotKey = job.uniqueKey.startsWith(`${CONTENT_JOB_KIND_PREFIX}`)
        ? job.uniqueKey.slice(CONTENT_JOB_KIND_PREFIX.length)
        : '';
      if (!slotKey) {
        await queue.fail(job.id, 'content job uniqueKey missing slot identity', false);
        continue;
      }
      const claimToken = job.claimToken ?? null;
      const heartbeat = this.startHeartbeat(job);
      try {
        const result = await pipeline.runSlot(slotKey);
        const outcome: SlotOutcome = {
          slotKey,
          stage: result.record.stage,
          productId: result.record.productId,
          attempts: result.record.attempts,
        };
        if (result.record.stage === 'failed') {
          // Recoverable: let the queue reschedule with backoff; the pipeline
          // resumes and reuses any valid assets already produced.
          failed.push(outcome);
          await this.safeFail(
            job.id,
            result.record.lastError ?? 'pipeline reported a failed stage',
            true,
            claimToken,
          );
          logger?.warn(
            { slotKey, stage: result.record.stage, error: result.record.lastError },
            'content slot failed; queued for retry',
          );
        } else {
          // publish_ready or blocked (terminal) — done, never republished.
          executed.push(outcome);
          await this.safeComplete(job.id, { stage: result.record.stage }, claimToken);
          logger?.info(
            { slotKey, stage: result.record.stage, productId: result.record.productId },
            `content slot ${result.record.stage}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0]?.slice(0, 200) : 'unknown';
        failed.push({ slotKey, stage: 'failed', productId: null, attempts: job.attempts });
        await this.safeFail(job.id, message ?? 'unknown error', true, claimToken);
        logger?.error({ slotKey, err: error }, 'content slot execution threw; queued for retry');
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    }

    const message =
      executed.length + failed.length === 0
        ? `Tick complete: ${enqueued.length} enqueued, nothing to execute.`
        : `Tick complete: ${enqueued.length} enqueued, ${executed.length} executed, ${failed.length} failed (retryable).`;

    return {
      at: now.toISOString(),
      today,
      enqueued,
      executed,
      skipped,
      failed,
      pendingJobs: await this.countPending(queue),
      message,
    };
  }

  /**
   * PART 5: keep a running job's lease alive while it works.
   *
   * Only relevant for the PostgreSQL queue (only it mints claim tokens). The
   * timer is unref'd, so it can never keep the process alive on its own, and a
   * refused renewal is only logged — the pipeline's own durable writes are
   * still protected by the slot row's optimistic version.
   */
  private startHeartbeat(job: JobRecord): NodeJS.Timeout | null {
    const token = job.claimToken;
    const extend = this.deps.queue.extendLease;
    if (!token || typeof extend !== 'function') return null;

    const timer = setInterval(() => {
      void extend
        .call(this.deps.queue, job.id, token)
        .then((renewed) => {
          if (!renewed) {
            this.deps.logger?.warn(
              { jobId: job.id },
              'lease renewal was refused — another worker may have taken this job',
            );
          }
        })
        .catch(() => {
          /* transient DB error: the lease simply expires later */
        });
    }, CONTENT_JOB_HEARTBEAT_MS);
    timer.unref?.();
    return timer;
  }

  private async countPending(queue: JobQueue): Promise<number> {
    const jobs = await queue.list(100);
    return jobs.filter((j: JobRecord) => j.status === 'pending' || j.status === 'running').length;
  }
}
