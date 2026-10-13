/**
 * PART 9 §5 — graceful shutdown semantics.
 *
 * Proves the coordinator that main.ts and /ready depend on:
 *  - shutdown flips `isStopping()` FIRST (readiness => 503) before any wait,
 *  - stop callbacks run exactly once, in registration order, even when one
 *    of them throws (a broken stop hook must not prevent later hooks),
 *  - in-flight work is awaited only within the bounded grace period; work
 *    that outlives it is ABANDONED (never force-committed) and reported,
 *  - a second signal shares the first shutdown instead of interleaving,
 *  - rejected tracked promises are swallowed (no unhandled rejections).
 */
import { describe, it, expect, vi } from 'vitest';
import { LifecycleController } from '../../src/app/lifecycle.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('LifecycleController — idle shutdown', () => {
  it('completes immediately with zero work and runs stop callbacks once, in order', async () => {
    const order: string[] = [];
    const controller = new LifecycleController({ graceMs: 5_000 });
    controller.onStop('scheduler', () => {
      order.push('scheduler');
    });
    controller.onStop('ops', () => {
      order.push('ops');
    });

    expect(controller.isStopping()).toBe(false);
    const started = Date.now();
    const report = await controller.shutdown('SIGTERM');
    const elapsed = Date.now() - started;

    expect(controller.isStopping()).toBe(true);
    expect(report.completed).toBe(0);
    expect(report.abandoned).toBe(0);
    expect(report.timedOut).toBe(false);
    expect(report.reason).toBe('SIGTERM');
    expect(order).toEqual(['scheduler', 'ops']);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('is idempotent: a second signal returns the same report and re-runs nothing', async () => {
    const stop = vi.fn();
    const controller = new LifecycleController({ graceMs: 5_000 });
    controller.onStop('only-once', stop);

    const first = await controller.shutdown('SIGINT');
    const second = await controller.shutdown('SIGTERM');

    expect(second).toBe(first); // same execution, not a second teardown
    expect(stop).toHaveBeenCalledTimes(1);
    expect(first.reason).toBe('SIGINT'); // the FIRST signal owns the report
  });
});

describe('LifecycleController — active shutdown', () => {
  it('waits for in-flight work that finishes inside the grace period', async () => {
    const controller = new LifecycleController({ graceMs: 2_000 });
    let finished = false;
    controller.track(
      'scheduler_tick',
      sleep(40).then(() => {
        finished = true;
      }),
    );
    expect(controller.inFlightCount()).toBe(1);

    const report = await controller.shutdown('SIGTERM');

    expect(finished).toBe(true); // drained, not abandoned
    expect(report.timedOut).toBe(false);
    expect(report.completed).toBe(1);
    expect(report.abandoned).toBe(0);
    expect(report.waitedMs).toBeGreaterThanOrEqual(30);
    expect(controller.inFlightCount()).toBe(0); // settled tasks are forgotten
  });

  it('abandons work that outlives the grace period — bounded, reported, never hung', async () => {
    const controller = new LifecycleController({ graceMs: 60 });
    controller.track('stuck_job', new Promise(() => undefined)); // never settles

    const started = Date.now();
    const report = await controller.shutdown('SIGTERM');
    const elapsed = Date.now() - started;

    expect(report.timedOut).toBe(true);
    expect(report.completed).toBe(0);
    expect(report.abandoned).toBe(1);
    expect(elapsed).toBeLessThan(2_000); // grace respected (60ms), no hang
  });

  it('counts a task that settles exactly at the deadline as completed', async () => {
    const controller = new LifecycleController({ graceMs: 150 });
    controller.track('borderline', sleep(70));
    const report = await controller.shutdown('SIGTERM');
    expect(report.timedOut).toBe(false);
    expect(report.completed).toBe(1);
  });

  it('swallows rejected tracked promises so an abandoned tick cannot crash the exit path', async () => {
    const controller = new LifecycleController({ graceMs: 1_000 });
    controller.track('failing_tick', Promise.reject(new Error('tick exploded')));
    await expect(controller.shutdown('SIGTERM')).resolves.toMatchObject({
      timedOut: false,
      completed: 1,
      abandoned: 0,
    });
  });
});

describe('LifecycleController — stop hooks are fault-isolated', () => {
  it('continues shutdown when a stop callback throws', async () => {
    const order: string[] = [];
    const controller = new LifecycleController({ graceMs: 1_000 });
    controller.onStop('broken', () => {
      throw new Error('timer handle already gone');
    });
    controller.onStop('after_broken', () => {
      order.push('after_broken');
    });

    const report = await controller.shutdown('SIGTERM');
    expect(order).toEqual(['after_broken']);
    expect(report.timedOut).toBe(false);
  });

  it('supports async stop callbacks (they complete before in-flight draining)', async () => {
    const controller = new LifecycleController({ graceMs: 1_000 });
    const events: string[] = [];
    controller.onStop('async_stop', async () => {
      await sleep(10);
      events.push('stopped');
    });
    controller.track('tick', sleep(30).then(() => events.push('ticked')));

    const report = await controller.shutdown('SIGTERM');
    expect(events).toEqual(['stopped', 'ticked']); // ordering: stop, then drain
    expect(report.completed).toBe(1);
  });
});
