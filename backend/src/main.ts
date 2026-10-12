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

  /* --- 4. Server --- */
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
}

void main();
