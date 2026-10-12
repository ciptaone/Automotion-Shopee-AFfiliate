/**
 * Content scheduler (Part 4) — connects the EXISTING scheduler + queue to the
 * REAL content pipeline, so the backend produces content on its own while the
 * APK is closed or the phone is restarted.
 *
 * WHAT THIS MODULE DOES (and what it deliberately does NOT do):
 *  - Computes the due content slots for "today" using the already-tested slot
 *    math in `scheduler/slots.ts` (60-minute interval, ≤24 slots per
 *    Asia/Jakarta day) — it does NOT reinvent scheduling.
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
import type { Logger } from '../core/logger.js';
import type { ContentPipeline } from '../automation/pipeline.js';
import type { SettingsService } from '../settings/automation-settings.js';
import {
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
}

export interface SlotOutcome {
  readonly slotKey: string;
  readonly stage: string;
  readonly productId: string | null;
  readonly attempts: number;
}

export interface SkippedSlot {
  readonly slotKey: string;
  readonly reason: 'catch_up_limited' | 'not_due';
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
   * One scheduling pass. Serialized: a tick never overlaps itself, so two
   * ticks can never race to reserve/execute the same slot.
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
    this.ticking = true;
    try {
      const result = await this.runTick();
      this.lastTick = result;
      return result;
    } finally {
      this.ticking = false;
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
    for (const entry of runnable) {
      // Skip slots already in a terminal stage (never republish / regenerate).
      const existing = pipeline.get(entry.slot.key);
      if (existing && (existing.stage === 'publish_ready' || existing.stage === 'blocked')) {
        skipped.push({ slotKey: entry.slot.key, reason: 'not_due' });
        continue;
      }
      const job = await queue.enqueue({
        kind: CONTENT_JOB_KIND,
        uniqueKey: contentJobKey(entry.slot.key),
        scheduledFor: new Date(entry.instantMs).toISOString(),
        payload: { slotKey: entry.slot.key, scheduledFor: entry.slot.scheduledFor },
        maxAttempts: 3,
      });
      if (!enqueued.includes(entry.slot.key)) {
        enqueued.push(entry.slot.key);
      }
      logger?.debug({ slotKey: entry.slot.key, jobId: job.id, status: job.status }, 'slot enqueued');
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
          await queue.fail(
            job.id,
            result.record.lastError ?? 'pipeline reported a failed stage',
            true,
          );
          logger?.warn(
            { slotKey, stage: result.record.stage, error: result.record.lastError },
            'content slot failed; queued for retry',
          );
        } else {
          // publish_ready or blocked (terminal) — done, never republished.
          executed.push(outcome);
          await queue.complete(job.id, { stage: result.record.stage });
          logger?.info(
            { slotKey, stage: result.record.stage, productId: result.record.productId },
            `content slot ${result.record.stage}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0]?.slice(0, 200) : 'unknown';
        failed.push({ slotKey, stage: 'failed', productId: null, attempts: job.attempts });
        await queue.fail(job.id, message ?? 'unknown error', true);
        logger?.error({ slotKey, err: error }, 'content slot execution threw; queued for retry');
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

  private async countPending(queue: JobQueue): Promise<number> {
    const jobs = await queue.list(100);
    return jobs.filter((j: JobRecord) => j.status === 'pending' || j.status === 'running').length;
  }
}
