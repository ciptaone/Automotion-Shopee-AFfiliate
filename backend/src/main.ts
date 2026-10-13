/**
 * Backend entrypoint.
 *
 * Boot order:
 *   1. Validate + freeze environment (fail fast with key NAMES only).
 *   2. Build the logger (redacting) + the PART 9 lifecycle controller.
 *   3. Compose the application container.
 *   4. Startup gate: database reachability + schema verification (exit 78 on
 *      failure) and startup recovery; publish a process_started event.
 *   5. Build the HTTP server; start listening; wire bounded graceful
 *      shutdown on SIGINT/SIGTERM (Part 9 §5).
 *
 * Nothing downstream reads process.env directly.
 */
import { loadEnv } from './core/env.js';
import { loadDotEnv } from './core/dotenv.js';
import { EnvironmentError } from './core/errors.js';
import { createLogger } from './core/logger.js';
import { buildContainer } from './app/container.js';
import { buildServer } from './app/server.js';
import { recoverOnStartup } from './db/recovery.js';
import { evaluateStartupGate } from './app/startup-gate.js';
import { LifecycleController } from './app/lifecycle.js';
import { fingerprintOf, type EventNotifier } from './ops/ops-events.js';

async function main(): Promise<void> {
  /* --- 0. .env file (real environment variables always win) ------------- */
  loadDotEnv();

  /* --- 1. Environment --- */
  let env;
  try {
    env = loadEnv(process.env);
  } catch (error) {
    if (error instanceof EnvironmentError) {
      // Use a bare console write: the structured logger may depend on env too.
      console.error(`[FATAL] ${error.message}`);
      console.error(
        '[FATAL] Copy backend/.env.example to backend/.env and fill in the required values.',
      );
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  /* --- 2. Logger --- */
  const logger = createLogger({
    name: 'autopilot',
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY === 'true',
    base: { env: env.NODE_ENV },
  });

  logger.info(
    {
      nodeEnv: env.NODE_ENV,
      port: env.PORT,
      schedulerEnabled: env.SCHEDULER_ENABLED === 'true',
      schedulerTimezone: env.SCHEDULER_TIMEZONE,
    },
    'starting Shopee Affiliate Autopilot backend (Part 3: catalog + content pipeline)',
  );

  /* --- 3. Container --- */
  const container = buildContainer({ env, logger });

  /* --- 3a. Lifecycle controller (Part 9 §5: bounded graceful shutdown) --- */
  const lifecycle = new LifecycleController({ graceMs: env.SHUTDOWN_GRACE_MS, logger });

  /* --- 3b. Automation settings (validated + persisted) --- */
  // Load before serving: init() is idempotent and never fails boot (it falls
  // back to defaults and records a warning that /v1/settings surfaces).
  await container.settings.init();
  logger.info(
    {
      settingsStorage: container.settings.storageKind,
      automationState: container.settings.current().automationState,
      intervalMinutes: container.settings.current().intervalMinutes,
      maxSlotsPerDay: container.settings.current().maxSlotsPerDay,
      warning: container.settings.loadWarning,
    },
    'automation settings loaded',
  );

  /* --- 3c. Product catalog + slot content store (Part 3) --- */
  await container.catalog.init();
  await container.slots.init();
  logger.info(
    {
      catalogStorage: container.catalog.storageKind,
      products: container.catalog.total(),
      categories: container.catalog.categories().length,
      warning: container.catalog.warning,
    },
    'product catalog loaded',
  );

  /* --- 4. Startup gate (Part 9 §4/§5) + crash recovery (Part 5) ---------- */
  // Fail closed: a database-backed process that cannot reach its database, or
  // whose schema was never migrated, must NOT start and look healthy while
  // every write goes nowhere. Every rule lives in the testable startup gate;
  // this block only acts on the verdict. Exit 78 (EX_CONFIG), secret-free.
  const gate = await evaluateStartupGate({
    env,
    persistenceBackend: container.persistence.backend,
    database: container.database,
  });

  for (const warning of gate.warnings) {
    logger.warn({ warning }, 'startup warning');
    // PART 9 §8: dangerous-but-legal production settings are never silent —
    // they become a persistent, deduplicated ops event (Telegram only when
    // configured and the severity/event filters allow it).
    await container.opsMonitor.record({
      kind: 'production_mock_providers',
      severity: 'warning',
      title: 'Production running with mock AI generation defaults',
      detail: warning,
      scope: 'startup',
    });
  }

  if (!gate.ok) {
    logger.fatal(
      { problems: gate.problems, persistence: container.persistence.backend },
      'refusing to start: startup gate failed',
    );
    // PART 9 §8: record first (persistent + deduplicated when the store is
    // reachable). When the store itself is the broken dependency, fall back to
    // ONE bounded direct delivery attempt through the same notifier policy —
    // single attempt, no loop, never throws, so a boot failure can still reach
    // Telegram while never recursing or stalling the exit path.
    const outcome = await container.opsMonitor.record({
      kind: 'startup_failed',
      severity: 'critical',
      title: 'Backend refused to start',
      detail: gate.problems.join('; '),
      scope: 'startup',
    });
    if (outcome.occurrences === 0) {
      await notifyStartupFailureDirect(container.telegramService, gate.problems, logger);
    }
    await container.shutdown();
    process.exit(78); // EX_CONFIG
  }

  if (container.persistence.backend === 'postgres') {
    const migrations = await container.database.migrationStatus();
    const recovery = await recoverOnStartup({
      db: container.database.db,
      queue: container.queue,
      logger,
    });
    logger.info(
      {
        appliedMigrations: migrations?.appliedCount ?? 0,
        requeuedJobs: recovery.requeuedJobs,
        failedJobs: recovery.failedJobs,
        releasedSlotLocks: recovery.releasedSlotLocks,
        storage: {
          settings: container.settings.storageKind,
          catalog: container.catalog.storageKind,
          slots: container.slots.storageKind,
        },
      },
      'database ready; startup recovery complete',
    );

    // PART 8 §6: stuck leases found at boot are worth an operator's attention.
    if (recovery.requeuedJobs > 0 || recovery.failedJobs > 0) {
      void container.opsMonitor.record({
        kind: 'recovery_performed',
        severity: 'warning',
        title: 'Startup recovery touched stuck jobs',
        detail: `${recovery.requeuedJobs} job(s) requeued, ${recovery.failedJobs} marked failed (attempt budget spent), ${recovery.releasedSlotLocks} slot lock(s) released.`,
        scope: 'startup',
      });
    }
  }

  // PART 9 §8: restart visibility. This info event persists across boots, so
  // "when did the process last restart?" is answerable from /v1/ops/health
  // even after the log is gone. It never notifies (default minSeverity is
  // warning) and never throws.
  void container.opsMonitor.record({
    kind: 'process_started',
    severity: 'info',
    title: 'Backend process started',
    detail:
      `env=${env.NODE_ENV} persistence=${container.persistence.backend} ` +
      `scheduler=${env.SCHEDULER_ENABLED === 'true' && env.SCHEDULER_MODE !== 'disabled' ? 'configured' : 'off'}.`,
    scope: 'boot',
  });

  /* --- 5. Server --- */
  const app = await buildServer(container, { isShuttingDown: () => lifecycle.isStopping() });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutdown signal received');
    // PART 9 §5: whatever happens below, the process is gone within
    // SHUTDOWN_GRACE_MS + 15 s — a service manager must never wait forever.
    const hardDeadline = setTimeout(() => {
      logger.fatal({ signal }, 'shutdown hard deadline exceeded — forcing exit(1)');
      process.exit(1);
    }, env.SHUTDOWN_GRACE_MS + 15_000);
    hardDeadline.unref?.();
    try {
      // (1) flip readiness to 503, (2) stop scheduler/ops loops so no new
      // ticks or job claims start, (3) drain in-flight work within the grace.
      const report = await lifecycle.shutdown(signal);
      if (report.timedOut) {
        // Persist the warning while the pool is still open. Bounded by 5 s:
        // a slow notification must never push us past the hard deadline, and
        // `record` never rejects if the pool closes underneath it.
        await Promise.race([
          container.opsMonitor.record({
            kind: 'shutdown_timeout',
            severity: 'warning',
            title: 'Shutdown grace period expired',
            detail: `${report.abandoned} in-flight task(s) abandoned after ${report.waitedMs}ms; lease recovery requeues them on the next boot.`,
            scope: 'lifecycle',
          }),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 5_000);
            t.unref?.();
          }),
        ]);
      }
      // (4) drain in-flight HTTP, then close database/storage resources.
      await app.close();
      await container.shutdown();
      clearTimeout(hardDeadline);
      logger.info(
        {
          signal,
          completed: report.completed,
          abandoned: report.abandoned,
          waitedMs: report.waitedMs,
        },
        'shutdown complete',
      );
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception — exiting');
    process.exit(1);
  });

  /* --- 5. Listen --- */
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    const readiness = container.readiness();
    logger.info(
      { degradedReasons: readiness.degradedReasons },
      `backend listening on http://${env.HOST}:${env.PORT}`,
    );
    logger.info(
      { integrations: container.integrationStatuses().map((s) => ({ service: s.service, mode: s.mode })) },
      'integration status',
    );
  } catch (error) {
    logger.fatal({ err: error }, 'failed to start server');
    process.exit(1);
  }

  /* --- 6. Content scheduler loop (Part 4) --- */
  // Runs INDEPENDENTLY of the APK: the backend computes due slots, enqueues
  // them under persistent job identities and executes the content pipeline.
  // `tick()` is self-serializing, so an overlapping tick is a no-op, and each
  // tick is individually caught so one failure never kills the loop.
  //
  // Enabled only when SCHEDULER_ENABLED=true and SCHEDULER_MODE != 'disabled'.
  // The loop itself never publishes: it stops at `publish_ready`.
  const schedulerEnabled = env.SCHEDULER_ENABLED === 'true' && env.SCHEDULER_MODE !== 'disabled';
  const TICK_INTERVAL_MS = 60_000; // poll; slot cadence itself is intervalMinutes
  let schedulerTimer: NodeJS.Timeout | null = null;

  if (schedulerEnabled) {
    const runTick = async (): Promise<void> => {
      try {
        const result = await container.contentScheduler.tick();
        logger.info(
          {
            today: result.today,
            enqueued: result.enqueued,
            executed: result.executed.map((e) => ({ slotKey: e.slotKey, stage: e.stage })),
            skipped: result.skipped,
            failed: result.failed.map((f) => ({ slotKey: f.slotKey })),
            pendingJobs: result.pendingJobs,
          },
          `content scheduler tick: ${result.message}`,
        );
      } catch (error) {
        // Recoverable: log and keep the loop alive for the next tick.
        logger.error({ err: error }, 'content scheduler tick failed; continuing');
        // PART 8 §6: repeated tick failures are how "scheduler stopped
        // unexpectedly" becomes visible. Fingerprinted per fault class by the
        // monitor's cooldown, so a persistent failure notifies once per window.
        void container.opsMonitor.record({
          kind: 'scheduler_tick_failed',
          severity: 'critical',
          title: 'Scheduler tick failed',
          detail:
            error instanceof Error
              ? (error.message.split('\n')[0] ?? 'unknown error').slice(0, 300)
              : 'unknown error',
        });
      }
    };

    // PART 9 §5: every tick is tracked so shutdown waits (bounded by
    // SHUTDOWN_GRACE_MS) for an in-flight tick instead of closing the pool
    // under it, and no new tick can start once stopping has begun.
    let tickSequence = 0;
    const scheduleTick = (): void => {
      if (lifecycle.isStopping()) return;
      const work = runTick();
      lifecycle.track(`scheduler_tick_${++tickSequence}`, work);
    };

    schedulerTimer = setInterval(() => scheduleTick(), TICK_INTERVAL_MS);
    // First pass shortly after boot so an interrupted slot resumes promptly.
    setTimeout(() => scheduleTick(), 2_000);
    logger.info(
      { tickIntervalMs: TICK_INTERVAL_MS, mode: env.SCHEDULER_MODE },
      'content scheduler loop started (scheduler -> queue -> pipeline; no publishing)',
    );
  } else {
    logger.info(
      { schedulerEnabled: env.SCHEDULER_ENABLED, mode: env.SCHEDULER_MODE },
      'content scheduler loop NOT started (SCHEDULER_ENABLED=false or SCHEDULER_MODE=disabled)',
    );
  }

  const stopScheduler = (): void => {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
      logger.info({}, 'content scheduler loop stopped');
    }
  };

  /* --- 7. PART 8 §6: periodic operational evaluation + notifications --- */
  // Runs INDEPENDENTLY of the scheduler loop so database, schema, budget and
  // provider faults surface even when scheduling is disabled. Each pass is one
  // health gathering + a deduplicated record (persistent fingerprint, cooldown
  // window), so a standing problem re-notifies at most once per cooldown
  // instead of every pass. It never throws, and it never enables anything.
  const OPS_EVAL_INTERVAL_MS = 5 * 60_000;
  const OPS_CLEANUP_EVERY_N_TICKS = 288; // ~once a day at 5-minute cadence
  let opsTimer: NodeJS.Timeout | null = null;
  let opsEvalCount = 0;

  const runOpsEvaluation = async (): Promise<void> => {
    try {
      await container.opsService.evaluateAndNotify();
      opsEvalCount += 1;
      if (opsEvalCount % OPS_CLEANUP_EVERY_N_TICKS === 0) {
        const { deleted } = await container.opsMonitor.runCleanup();
        if (deleted > 0) {
          logger.info({ deleted }, 'ops_events retention cleanup (90 days / 200 per kind)');
        }
      }
    } catch (error) {
      // Defensive: evaluateAndNotify already swallows its own failures.
      logger.warn({ err: error }, 'ops evaluation pass failed; continuing');
    }
  };

  // PART 9 §5: the ops pass is tracked exactly like a scheduler tick — shutdown
  // drains it within the grace period and no new pass starts while stopping.
  let opsSequence = 0;
  const scheduleOpsPass = (): void => {
    if (lifecycle.isStopping()) return;
    const work = runOpsEvaluation();
    lifecycle.track(`ops_pass_${++opsSequence}`, work);
  };

  opsTimer = setInterval(() => scheduleOpsPass(), OPS_EVAL_INTERVAL_MS);
  // First pass shortly after boot (post-recovery, DB verified), then cadence.
  setTimeout(() => scheduleOpsPass(), 15_000);
  logger.info(
    { intervalMs: OPS_EVAL_INTERVAL_MS },
    'ops evaluation loop started (health events + notifications)',
  );

  const stopOpsEvaluation = (): void => {
    if (opsTimer) {
      clearInterval(opsTimer);
      opsTimer = null;
      logger.info({}, 'ops evaluation loop stopped');
    }
  };

  // PART 9 §5: stop callbacks run (in order) inside `lifecycle.shutdown()`,
  // before the HTTP server closes — replacing the old prepend-listener trick
  // with one explicit, testable ordering.
  lifecycle.onStop('content_scheduler_loop', stopScheduler);
  lifecycle.onStop('ops_evaluation_loop', stopOpsEvaluation);
}

/**
 * PART 9 §8 — ONE bounded delivery attempt for a startup failure, used only
 * when the ops store itself was unreachable (so the durable path never ran).
 * Single attempt with an 8 s ceiling; it inherits every Telegram policy
 * (enable flag, severity/event filters, sanitized bounded text) and it can
 * never recurse, retry in a loop or delay the exit beyond its own timeout.
 */
async function notifyStartupFailureDirect(
  notifier: EventNotifier,
  problems: readonly string[],
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    const delivery = await Promise.race([
      notifier.notifyEvent({
        fingerprint: fingerprintOf('startup_failed', 'direct'),
        kind: 'startup_failed',
        severity: 'critical',
        title: 'Backend refused to start',
        detail: problems.join('; ').slice(0, 500),
      }),
      new Promise<'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 8_000);
        timer.unref?.();
      }),
    ]);
    if (delivery === 'timeout') {
      logger.warn({}, 'startup failure notification timed out (single attempt)');
    } else if (!delivery.delivered) {
      logger.info(
        { status: delivery.status, errorCode: delivery.errorCode ?? null },
        'startup failure notification not delivered (single attempt, no retry)',
      );
    }
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'startup failure notification failed (single attempt, no retry)',
    );
  }
}

void main();
