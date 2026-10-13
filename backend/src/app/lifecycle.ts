/**
 * Process lifecycle coordinator (Part 9 §5).
 *
 * One place owns the question "are we stopping, and how long may we wait?".
 *
 * Shutdown sequence, in order:
 *   1. flip `isStopping()` — `/ready` immediately answers 503 `shutting_down`
 *      so a load balancer stops sending generation work (liveness stays on
 *      `/health`, which is untouched);
 *   2. run the registered stop callbacks (clear scheduler/ops timers => no new
 *      ticks, no new job claims, no new ops passes);
 *   3. wait for tracked in-flight work (a scheduler tick, an ops pass) under a
 *      BOUNDED grace period — anything still running when the grace expires is
 *      abandoned, not force-committed: queue claim tokens + leases guarantee a
 *      stale worker's late write is rejected and `recoverOnStartup()` requeues
 *      the job on the next boot;
 *   4. the caller then closes the HTTP server and the database pool.
 *
 * The controller is idempotent: a second SIGINT while shutting down returns
 * the same promise instead of interleaving a second teardown. It never throws
 * out of `shutdown()` — every callback is isolated, because a broken stop hook
 * must not prevent the pool from closing.
 */
import type { Logger } from '../core/logger.js';

export interface LifecycleOptions {
  /** Bounded grace for in-flight work (env `SHUTDOWN_GRACE_MS`, validated 1–120 s). */
  readonly graceMs: number;
  readonly logger?: Logger | null;
}

export interface ShutdownReport {
  readonly reason: string;
  /** True once shutdown has begun (readiness already flipped). */
  readonly stopping: true;
  /** In-flight tasks that settled within the grace period. */
  readonly completed: number;
  /** In-flight tasks still pending when the grace period expired. */
  readonly abandoned: number;
  readonly timedOut: boolean;
  readonly waitedMs: number;
}

export class LifecycleController {
  private readonly graceMs: number;
  private readonly logger: Logger | null;
  private stopping = false;
  private shutdownPromise: Promise<ShutdownReport> | null = null;
  private readonly stopCallbacks: { name: string; run: () => void | Promise<void> }[] = [];
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(options: LifecycleOptions) {
    this.graceMs = options.graceMs;
    this.logger = options.logger ?? null;
  }

  /** True from the moment shutdown begins — drives `/ready` => 503. */
  isStopping(): boolean {
    return this.stopping;
  }

  /**
   * Register work that shutdown must wait for. The promise is tracked until it
   * settles; rejections are swallowed here (the producers already log their
   * own failures) so an abandoned tick can never become an unhandled rejection.
   */
  track(label: string, promise: Promise<unknown>): void {
    const tracked = promise.catch((error: unknown) => {
      this.logger?.warn(
        { label, err: error instanceof Error ? error.message : String(error) },
        'tracked shutdown work rejected',
      );
      return undefined;
    });
    this.inFlight.set(label, tracked);
    void tracked.finally(() => {
      this.inFlight.delete(label);
    });
  }

  /** Register a stop callback (run once, in order, when shutdown begins). */
  onStop(name: string, run: () => void | Promise<void>): void {
    this.stopCallbacks.push({ name, run });
  }

  /** Number of tracked in-flight tasks (test/observability seam). */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Begin shutdown and wait for in-flight work, bounded by the grace period.
   * Idempotent: concurrent/repeated calls share the first execution.
   */
  shutdown(reason: string): Promise<ShutdownReport> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.run(reason);
    }
    return this.shutdownPromise;
  }

  private async run(reason: string): Promise<ShutdownReport> {
    const startedAt = Date.now();
    this.stopping = true;
    this.logger?.info(
      { reason, graceMs: this.graceMs, inFlight: this.inFlight.size },
      'lifecycle: stopping new work',
    );

    // (2) Stop callbacks first: no new ticks or claims while we drain.
    for (const callback of this.stopCallbacks) {
      try {
        await callback.run();
      } catch (error) {
        this.logger?.warn(
          { callback: callback.name, err: error instanceof Error ? error.message : String(error) },
          'lifecycle: stop callback failed; continuing shutdown',
        );
      }
    }

    // (3) Bounded wait for in-flight work. Each promise gets a settle flag so
    // a task finishing exactly at the deadline is counted as completed.
    const tracked = [...this.inFlight.values()].map((promise) => {
      const flag = { settled: false };
      const wrapped = promise.then(
        () => {
          flag.settled = true;
        },
        () => {
          flag.settled = true;
        },
      );
      return { flag, wrapped };
    });
    let completed = tracked.length;
    let timedOut = false;
    if (tracked.length > 0) {
      const allSettled = Promise.all(tracked.map((entry) => entry.wrapped)).then(() => true);
      const deadline = new Promise<'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), this.graceMs);
        // Never keep the process alive purely for a grace timer.
        timer.unref?.();
      });
      const outcome = await Promise.race([allSettled, deadline]);
      if (outcome === 'timeout') {
        timedOut = true;
        completed = tracked.filter((entry) => entry.flag.settled).length;
      }
    }

    const abandoned = tracked.length - completed;
    const waitedMs = Date.now() - startedAt;
    if (timedOut) {
      this.logger?.warn(
        { reason, waitedMs, abandoned, graceMs: this.graceMs },
        'lifecycle: grace period expired; abandoning in-flight work (lease recovery will requeue)',
      );
    } else {
      this.logger?.info({ reason, waitedMs, completed }, 'lifecycle: in-flight work drained');
    }

    return { reason, stopping: true, completed, abandoned, timedOut, waitedMs };
  }
}
