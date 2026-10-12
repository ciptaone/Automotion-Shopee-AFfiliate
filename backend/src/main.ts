/**
 * Backend entrypoint.
 *
 * Boot order:
 *   1. Validate + freeze environment (fail fast with key NAMES only).
 *   2. Build the logger (redacting).
 *   3. Compose the application container.
 *   4. Build the HTTP server.
 *   5. Start listening; wire graceful shutdown on SIGINT/SIGTERM.
 *
 * Nothing downstream reads process.env directly.
 */
import { loadEnv } from './core/env.js';
import { EnvironmentError } from './core/errors.js';
import { createLogger } from './core/logger.js';
import { buildContainer } from './app/container.js';
import { buildServer } from './app/server.js';
import { recoverOnStartup } from './db/recovery.js';

async function main(): Promise<void> {
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

  /* --- 4. Database readiness + crash recovery (Part 5) --- */
  // Fail closed: a database-backed process that cannot reach its database, or
  // whose schema was never migrated, must NOT start and look healthy while
  // every write goes nowhere. Exit 78 (EX_CONFIG) with a secret-free reason.
  if (container.persistence.backend === 'postgres') {
    const problems: string[] = [];
    if (!(await container.database.healthy())) {
      problems.push(`database unreachable: ${await container.database.statusDetail()}`);
    }
    const migrations = await container.database.migrationStatus();
    if (!migrations) {
      problems.push('migration status could not be read from the database.');
    } else if (!migrations.consistent) {
      problems.push(`database schema is not up to date: ${migrations.problems.join('; ')}`);
    }
    if (problems.length > 0) {
      logger.fatal(
        { problems, persistence: container.persistence.backend },
        'refusing to start: PostgreSQL persistence is required but unusable',
      );
      await container.shutdown();
      process.exit(78); // EX_CONFIG
    }

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
  }

  /* --- 5. Server --- */
  const app = await buildServer(container);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutdown signal received');
    try {
      await app.close();
      await container.shutdown();
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
      }
    };

    schedulerTimer = setInterval(() => void runTick(), TICK_INTERVAL_MS);
    // First pass shortly after boot so an interrupted slot resumes promptly.
    setTimeout(() => void runTick(), 2_000);
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

  // Register the stop hook on the existing shutdown path.
  process.prependListener('SIGINT', stopScheduler);
  process.prependListener('SIGTERM', stopScheduler);
}

void main();
