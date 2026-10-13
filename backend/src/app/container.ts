/**
 * Application container (composition root).
 *
 * Wires configuration, logging, database, integrations, queue and scheduler into
 * a single object that the HTTP layer and the tests both consume. Keeping all
 * wiring here means the HTTP layer never constructs a vendor client directly and
 * tests can swap any dependency for a mock.
 *
 * Part 1 wiring rules:
 *  - AI image/text default to deterministic mocks.
 *  - Object storage defaults to the in-memory mock.
 *  - Facebook/Threads publishers are constructed but HARD-DISABLED for live use.
 *  - Telegram uses the in-memory transport unless explicitly allowed live.
 */
import path from 'node:path';
import { createLogger, type Logger } from '../core/logger.js';
import {
  describeIntegrationStatus,
  parseCorsOrigins,
  type Env,
  type IntegrationStatus,
} from '../core/env.js';
import {
  DEFAULT_AUTOMATION_SETTINGS,
  FileSettingsStore,
  InMemorySettingsStore,
  MAX_INTERVAL_MINUTES,
  MAX_SLOTS_PER_DAY,
  MIN_INTERVAL_MINUTES,
  SettingsService,
  type SettingsStore,
} from '../settings/automation-settings.js';
import { automationDegradedReasons } from '../automation/status.js';
import {
  FileCatalogStore,
  InMemoryCatalogStore,
  ProductCatalog,
  type CatalogStore,
} from '../catalog/catalog.js';
import {
  FileSlotStore,
  InMemorySlotStore,
  SlotContentStore,
  type SlotStore,
} from '../automation/slot-store.js';
import { ContentPipeline } from '../automation/pipeline.js';
import { ContentScheduler } from '../scheduler/content-scheduler.js';
import { createDatabaseHandle, type DatabaseHandle } from '../db/client.js';
import { InMemoryJobQueue } from '../queue/job-queue.js';
import { ShopeeFeedCsvImporter } from '../integrations/feed/shopee-feed-importer.js';
import { createCaptionGenerator, createImageGenerator } from '../integrations/ai/create-ai.js';
import { createObjectStorage } from '../integrations/storage/object-storage.js';
import {
  FileProviderStore,
  InMemoryProviderStore,
  PostgresProviderStore,
  type ProviderStore,
} from '../providers/provider-store.js';
import {
  cipherFromEnv,
  FileSecretStore,
  InMemorySecretStore,
  PostgresSecretStore,
  type SecretStore,
} from '../secrets/secret-store.js';
import {
  FileUsageStore,
  InMemoryUsageStore,
  PostgresUsageStore,
  type UsageStore,
} from '../usage/usage-store.js';
import { UsageService } from '../usage/usage-service.js';
import { ProviderService } from '../providers/provider-service.js';
import { EndpointPolicy, parseAllowlist } from '../providers/endpoint-policy.js';
import { HttpTransport } from '../providers/transport.js';
import { createGenerationRouter, type GenerationRouter } from '../providers/generation-router.js';
import {
  FacebookPagePublisher,
  StubGraphTransport,
  ThreadsPublisher,
} from '../integrations/publishing/publishers.js';
import {
  LazyTelegramTransport,
  MemoryTelegramTransport,
  TelegramNotificationService,
  TelegramNotifier,
  type TelegramRuntimeConfig,
  type TelegramSettingsSource,
} from '../integrations/notifications/telegram.js';
import {
  InMemoryOpsEventStore,
  OpsMonitor,
  PostgresOpsEventStore,
  type OpsEventStore,
} from '../ops/ops-events.js';
import {
  OpsService,
  TELEGRAM_SECRET_BOT_TOKEN,
  TELEGRAM_SECRET_CHAT_ID,
} from '../ops/ops-service.js';
import {
  DEFAULT_SCHEDULER_CONFIG,
  clampDailyPostTarget,
  describeSchedulerStatus,
  type SchedulerConfig,
  type SchedulerStatus,
} from '../scheduler/slots.js';
import {
  InMemorySchedulerCheckpointStore,
  PostgresSchedulerCheckpointStore,
  PostgresSettingsStore,
  type SchedulerCheckpointStore,
} from '../db/postgres-settings-store.js';
import { PostgresCatalogStore } from '../db/postgres-catalog-store.js';
import { PostgresJobQueue } from '../db/postgres-job-queue.js';
import { PostgresSlotStore } from '../db/postgres-slot-store.js';
import { PostgresSchedulerTickLock } from '../db/postgres-tick-lock.js';
import {
  resolvePersistenceBackend,
  type PersistenceDecision,
} from '../core/persistence.js';
import { EnvironmentError } from '../core/errors.js';
import type {
  CaptionGenerator,
  ImageGenerator,
  JobQueue,
  Notifier,
  ObjectStorage,
  ProductFeedImporter,
  Publisher,
} from '../contracts/index.js';

export interface AppContainer {
  readonly env: Env;
  readonly logger: Logger;
  readonly database: DatabaseHandle;
  /** PART 5: which persistence backend this process actually runs on. */
  readonly persistence: PersistenceDecision;
  readonly queue: JobQueue;
  readonly settings: SettingsService;
  readonly feedImporter: ProductFeedImporter;
  /** PART 6: user-configured provider workspace (configs + selection + readiness). */
  readonly providers: ProviderService;
  /** PART 6: generation usage ledger + budget enforcement (§10). */
  readonly usage: UsageService;
  /** PART 6: SSRF-safe endpoint policy applied to every configured URL. */
  readonly endpointPolicy: EndpointPolicy;
  /** PART 6: provider-aware generation router (attribution + no-fallback). */
  readonly generationRouter: GenerationRouter;
  readonly imageGenerator: ImageGenerator;
  readonly captionGenerator: CaptionGenerator;
  readonly storage: ObjectStorage;
  readonly facebookPublisher: Publisher;
  readonly threadsPublisher: Publisher;
  readonly notifier: Notifier;
  /** PART 8: encrypted credential store (write-only from the HTTP layer). */
  readonly secretStore: SecretStore;
  /** PART 8 §7: durable operational events + cooldowns (memory in dev/tests). */
  readonly opsEvents: OpsEventStore;
  /** PART 8 §6: deduplicated event recording + best-effort notification. */
  readonly opsMonitor: OpsMonitor;
  /** PART 8 §2-§4: health/readiness/metrics aggregation. */
  readonly opsService: OpsService;
  /** PART 8 §6: Telegram delivery (notifications + explicit test action). */
  readonly telegramService: TelegramNotificationService;
  readonly schedulerConfig: SchedulerConfig;
  /** PART 5: durable scheduler tick state (postgres) or process-local (dev). */
  readonly schedulerCheckpoints: SchedulerCheckpointStore;
  /** Persistent product catalog (Part 3). */
  readonly catalog: ProductCatalog;
  /** Per-slot content records: reservation, image count, assets, captions. */
  readonly slots: SlotContentStore;
  /** The real content pipeline (selection -> images -> captions -> gate). */
  readonly pipeline: ContentPipeline;
  /** Scheduler -> queue -> pipeline loop (Part 4). Runs while the APK is closed. */
  readonly contentScheduler: ContentScheduler;
  /** Scheduler config with the APK-managed interval/slot overrides applied. */
  effectiveSchedulerConfig(): SchedulerConfig;
  readonly corsOrigins: readonly string[];

  schedulerStatus(now?: Date): SchedulerStatus;
  /** Part 4: whether the scheduler -> pipeline timer loop is enabled by env. */
  schedulerLoopStatus(): {
    enabled: boolean;
    mode: string;
    tickIntervalMs: number;
    reason: string;
  };
  integrationStatuses(): IntegrationStatus[];
  /** Aggregate readiness used by /health. */
  readiness(): {
    ready: boolean;
    degradedReasons: string[];
  };
  shutdown(): Promise<void>;
}

export interface BuildContainerOptions {
  readonly env: Env;
  readonly logger?: Logger;
  /** Override any dependency for tests. */
  readonly overrides?: Partial<{
    queue: JobQueue;
    settingsStore: SettingsStore;
    catalogStore: CatalogStore;
    slotStore: SlotStore;
    feedImporter: ProductFeedImporter;
    imageGenerator: ImageGenerator;
    captionGenerator: CaptionGenerator;
    storage: ObjectStorage;
    facebookPublisher: Publisher;
    threadsPublisher: Publisher;
    notifier: Notifier;
    database: DatabaseHandle;
    schedulerCheckpoints?: SchedulerCheckpointStore;
    providerStore?: ProviderStore;
    secretStore?: SecretStore;
    usageStore?: UsageStore;
    endpointPolicy?: EndpointPolicy;
    /** Test seam: deterministic transport instead of global fetch. */
    transport?: HttpTransport;
  }>;
}

export function buildContainer(options: BuildContainerOptions): AppContainer {
  const { env } = options;
  const logger = options.logger ?? createLogger({ name: 'autopilot', level: env.LOG_LEVEL });

  const schedulerConfig: SchedulerConfig = {
    ...DEFAULT_SCHEDULER_CONFIG,
    timezone: env.SCHEDULER_TIMEZONE,
    intervalMinutes: env.SCHEDULER_INTERVAL_MINUTES,
    maxSlotsPerDay: env.SCHEDULER_MAX_SLOTS_PER_DAY,
    dailyPostTarget: env.SCHEDULER_DAILY_POST_TARGET,
  };

  /* --- Persistence backend (Part 5: explicit, fail-closed) --- */
  const database =
    options.overrides?.database ??
    createDatabaseHandle(env.DATABASE_URL, {
      min: env.DATABASE_POOL_MIN,
      max: env.DATABASE_POOL_MAX,
    });

  const persistence = resolvePersistenceBackend({
    nodeEnv: env.NODE_ENV,
    persistenceBackend: env.PERSISTENCE_BACKEND,
    databaseUrl: env.DATABASE_URL,
  });

  if (persistence.errors.length > 0) {
    // Refusing to start beats the alternative: quietly switching to a file or
    // in-memory store would make the backend look healthy while every write
    // disappears at the next restart.
    throw new EnvironmentError(['DATABASE_URL', 'PERSISTENCE_BACKEND'], persistence.errors.join(' '));
  }

  const postgresDb = persistence.backend === 'postgres' ? database.db : null;
  if (persistence.backend === 'postgres' && !postgresDb) {
    throw new EnvironmentError(
      ['DATABASE_URL'],
      'PERSISTENCE_BACKEND is "postgres" but no database connection could be created.',
    );
  }

  /* --- Automation settings (Part 2: validated + persisted) --- */
  // Environment values seed the DEFAULTS only; after boot the APK-managed
  // settings (persisted via the store) are authoritative.
  const seededDefaults = {
    ...DEFAULT_AUTOMATION_SETTINGS,
    intervalMinutes: clampInterval(env.SCHEDULER_INTERVAL_MINUTES),
    maxSlotsPerDay: clampMaxSlots(env.SCHEDULER_INTERVAL_MINUTES, env.SCHEDULER_MAX_SLOTS_PER_DAY),
    automationState: env.SCHEDULER_ENABLED === 'true' ? ('running' as const) : ('paused' as const),
    // PART 6 §7: how many of the four WIB windows are used each day.
    dailyPostTarget: clampDailyPostTarget(env.SCHEDULER_DAILY_POST_TARGET),
  };

  const settingsStore: SettingsStore =
    options.overrides?.settingsStore ??
    (postgresDb
      ? new PostgresSettingsStore(postgresDb)
      : env.NODE_ENV === 'test'
        ? new InMemorySettingsStore()
        : new FileSettingsStore(path.join(process.cwd(), 'data', 'settings.json')));

  const settings = new SettingsService(seededDefaults, settingsStore);

  /* --- Catalog + slot content + pipeline (Part 3) --- */
  // Storage is chosen ONCE here: PostgreSQL when the process is database-backed,
  // otherwise the verified file store (development) or in-memory (tests). There
  // is no runtime fallback between them.
  const isTest = env.NODE_ENV === 'test';

  const catalogStore: CatalogStore =
    options.overrides?.catalogStore ??
    (postgresDb
      ? new PostgresCatalogStore(postgresDb)
      : isTest
        ? new InMemoryCatalogStore()
        : new FileCatalogStore(path.join(process.cwd(), 'data', 'catalog.json')));

  const slotStore: SlotStore =
    options.overrides?.slotStore ??
    (postgresDb
      ? new PostgresSlotStore(postgresDb)
      : isTest
        ? new InMemorySlotStore()
        : new FileSlotStore(path.join(process.cwd(), 'data', 'slots.json')));

  const catalog = new ProductCatalog(catalogStore);
  const slots = new SlotContentStore(slotStore);

  /** PART 5: durable scheduler checkpoints (postgres) or process-local (dev). */
  const schedulerCheckpoints: SchedulerCheckpointStore =
    options.overrides?.schedulerCheckpoints ??
    (postgresDb ? new PostgresSchedulerCheckpointStore(postgresDb) : new InMemorySchedulerCheckpointStore());

  /** PART 5: one queue implementation per backend, same contract.
   *  PART 9 §3: the job lease duration is operator-tunable (JOB_LEASE_SECONDS)
   *  and feeds the PostgreSQL claim/heartbeat window directly. */
  const queue: JobQueue =
    options.overrides?.queue ??
    (postgresDb
      ? new PostgresJobQueue({ db: postgresDb, leaseMs: env.JOB_LEASE_SECONDS * 1000 })
      : new InMemoryJobQueue());

  /** Scheduler config as currently configured through the APK settings screen. */
  const currentSchedulerConfig = (): SchedulerConfig => {
    const current = settings.current();
    return {
      ...schedulerConfig,
      intervalMinutes: current.intervalMinutes,
      maxSlotsPerDay: current.maxSlotsPerDay,
      // PART 6 §7: the daily posting target drives the WIB window slots.
      dailyPostTarget: clampDailyPostTarget(current.dailyPostTarget),
    };
  };

  /* --- Integrations (defaults are all credential-free mocks) --- */
  const feedImporter = options.overrides?.feedImporter ?? new ShopeeFeedCsvImporter();

  // Part 4: AI providers resolve through an HONEST factory. `mock`/`disabled`
  // give deterministic offline mocks (wrapped in the resilience layer: timeout,
  // bounded retries, rate-limit handling, usage accounting, redacted logging).
  // A configured-but-unimplemented live vendor (openai/google) returns an
  // UNAVAILABLE adapter that fails fast and reports ready:false — it NEVER
  // silently degrades to mock output while claiming a live provider.
  const aiLogger = {
    info: (fields: Record<string, unknown>, message: string) => logger.info(fields, message),
    warn: (fields: Record<string, unknown>, message: string) => logger.warn(fields, message),
    error: (fields: Record<string, unknown>, message: string) => logger.error(fields, message),
  };
  /* --- PART 6: provider workspace, secrets, usage ledger, endpoint policy --- */
  // Every user-configured endpoint is validated by this policy (SSRF defense)
  // before it is stored and again before it is fetched.
  const endpointPolicy =
    options.overrides?.endpointPolicy ??
    new EndpointPolicy({ allowlist: parseAllowlist(env.SELF_HOSTED_ENDPOINT_ALLOWLIST) });
  const transport =
    options.overrides?.transport ?? new HttpTransport({ policy: endpointPolicy });

  // Credentials: AES-256-GCM with a server-side key. No key => writes fail
  // closed and providers needing a credential stay unusable (never a fallback).
  const secretCipher = cipherFromEnv(env.SECRETS_ENCRYPTION_KEY);
  const secretStore: SecretStore =
    options.overrides?.secretStore ??
    (postgresDb
      ? new PostgresSecretStore(postgresDb, secretCipher)
      : isTest
        ? new InMemorySecretStore(secretCipher)
        : new FileSecretStore(
            path.join(process.cwd(), 'data', 'provider-secrets.enc.json'),
            secretCipher,
          ));

  const providerStore: ProviderStore =
    options.overrides?.providerStore ??
    (postgresDb
      ? new PostgresProviderStore(postgresDb)
      : isTest
        ? new InMemoryProviderStore()
        : new FileProviderStore(path.join(process.cwd(), 'data', 'providers.json')));

  const usageStore: UsageStore =
    options.overrides?.usageStore ??
    (postgresDb
      ? new PostgresUsageStore(postgresDb)
      : isTest
        ? new InMemoryUsageStore()
        : new FileUsageStore(path.join(process.cwd(), 'data', 'usage.json')));

  const usage = new UsageService(
    usageStore,
    () => ({
      dailyBudgetUsd: settings.current().dailyBudgetUsd,
      monthlyBudgetUsd: settings.current().monthlyBudgetUsd,
    }),
    env.SCHEDULER_TIMEZONE,
  );

  const providers = new ProviderService({
    store: providerStore,
    secrets: secretStore,
    policy: endpointPolicy,
    transport,
    usage,
  });
  // Warm the persisted workspace off the critical path so synchronous `info`
  // readers (health/integration status) reflect the selection after boot.
  void providers.init().catch((error: unknown) => {
    logger.warn({ err: error }, 'provider workspace could not be loaded at boot');
  });

  // Env-configured defaults (mock / disabled / unavailable) — used ONLY when no
  // provider is selected for a task; never as a silent fallback after a failure.
  const envImageGenerator = createImageGenerator(env, { logger: aiLogger });
  const envCaptionGenerator = createCaptionGenerator(env, { logger: aiLogger });

  const generationRouter = createGenerationRouter({
    providers,
    usage,
    defaultCaption: envCaptionGenerator,
    defaultImage: envImageGenerator,
  });

  const imageGenerator =
    options.overrides?.imageGenerator ?? generationRouter.forImage();

  const captionGenerator =
    options.overrides?.captionGenerator ?? generationRouter.forCaption();

  // PART 9 §6: the factory resolves the LIVE S3-compatible adapter when the
  // credential set is complete (production requires it at env validation), and
  // the in-memory mock otherwise — development/test keep the free mock, and a
  // production process can never silently fall back to process-memory assets.
  const storage =
    options.overrides?.storage ??
    createObjectStorage({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      publicBaseUrl: env.S3_PUBLIC_BASE_URL,
      objectAcl: env.S3_OBJECT_ACL,
    });

  // Part 1: publishers are constructed with a stub transport and allowLive=false,
  // so no live Graph API call can occur regardless of credential presence.
  const stubTransport = new StubGraphTransport({ id: 'stub-post-id' });
  const facebookPublisher =
    options.overrides?.facebookPublisher ??
    new FacebookPagePublisher(
      {
        apiBase: env.FACEBOOK_GRAPH_API_BASE,
        apiVersion: env.FACEBOOK_GRAPH_API_VERSION,
        pageId: env.FACEBOOK_PAGE_ID,
        pageAccessToken: env.FACEBOOK_PAGE_ACCESS_TOKEN,
        allowLive: false,
      },
      stubTransport,
    );

  const threadsPublisher =
    options.overrides?.threadsPublisher ??
    new ThreadsPublisher(
      {
        apiBase: env.THREADS_API_BASE,
        apiVersion: env.THREADS_API_VERSION,
        userId: env.THREADS_USER_ID,
        accessToken: env.THREADS_ACCESS_TOKEN,
        allowLive: false,
      },
      stubTransport,
    );

  const telegramTransport = new MemoryTelegramTransport();
  const notifier =
    options.overrides?.notifier ??
    new TelegramNotifier(
      {
        botToken: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
        allowLive: false,
      },
      telegramTransport,
    );

  /* --- PART 8 §6/§7: operational events + Telegram delivery ------------- */
  // Credential resolution is read PER DELIVERY: encrypted API-stored secrets
  // win, environment variables remain the documented bootstrap path, and
  // `enabled`/filters come from the persisted APK settings. Nothing is cached,
  // so rotating or revoking a credential takes effect on the next event.
  const telegramSettingsSource: TelegramSettingsSource = {
    async resolve(): Promise<TelegramRuntimeConfig> {
      const current = settings.current();
      let storedToken: string | null = null;
      let storedChatId: string | null = null;
      try {
        storedToken = await secretStore.get(TELEGRAM_SECRET_BOT_TOKEN);
        storedChatId = await secretStore.get(TELEGRAM_SECRET_CHAT_ID);
      } catch {
        // Missing encryption key or unreadable row => treated as not configured.
      }
      return {
        botToken: storedToken ?? env.TELEGRAM_BOT_TOKEN ?? null,
        chatId: storedChatId ?? env.TELEGRAM_CHAT_ID ?? null,
        enabled: current.telegramNotificationsEnabled,
        minSeverity: current.notificationMinSeverity,
        eventKinds:
          current.notificationEventKinds.length > 0 ? [...current.notificationEventKinds] : 'all',
      };
    },
  };

  const opsEventStore: OpsEventStore = postgresDb
    ? new PostgresOpsEventStore(postgresDb)
    : new InMemoryOpsEventStore();

  const telegramService = new TelegramNotificationService({
    settings: telegramSettingsSource,
    transport: new LazyTelegramTransport(telegramSettingsSource),
  });

  // The monitor deduplicates by persistent fingerprint + cooldown, so event
  // sources can record freely; delivery failures are recorded, never re-emitted.
  const opsMonitor = new OpsMonitor({ store: opsEventStore, notifier: telegramService, logger });

  const corsOrigins = parseCorsOrigins(env.CORS_ORIGINS);

  /** The real content pipeline. Never publishes: live publishing stays disabled. */
  const pipeline = new ContentPipeline({
    catalog,
    slots,
    settings,
    imageGenerator,
    captionGenerator,
    storage,
    notifier,
  });

  /** Part 4: scheduler -> queue -> pipeline. Never publishes; reaches publish_ready only. */
  const contentScheduler = new ContentScheduler({
    queue,
    pipeline,
    settings,
    schedulerConfig: currentSchedulerConfig,
    logger,
    // PART 5: durable tick bookkeeping + a cross-process lock, so two backend
    // processes on one database cannot both plan the same slot window.
    checkpoints: schedulerCheckpoints,
    tickLock:
      postgresDb && database.raw ? new PostgresSchedulerTickLock(database.raw) : undefined,
    // PART 8 §6: terminal job failures become durable, deduplicated events.
    opsMonitor,
  });

  /* --- PART 8 §2-§4: health / readiness / metrics aggregation ------------ */
  const opsService = new OpsService({
    env,
    version: '0.1.0',
    startTime: new Date(),
    logger,
    database,
    persistenceBackend: persistence.backend,
    queue,
    settings,
    providers,
    usage,
    storage,
    contentScheduler,
    schedulerStatus: (now?: Date) => container.schedulerStatus(now),
    schedulerLoopStatus: () => container.schedulerLoopStatus(),
    secrets: secretStore,
    recentEvents: (limit: number) => opsMonitor.recent(limit),
    monitor: opsMonitor,
  });

  const container: AppContainer = {
    env,
    logger,
    database,
    persistence,
    queue,
    settings,
    feedImporter,
    providers,
    usage,
    endpointPolicy,
    generationRouter,
    imageGenerator,
    captionGenerator,
    storage,
    facebookPublisher,
    threadsPublisher,
    notifier,
    secretStore,
    opsEvents: opsEventStore,
    opsMonitor,
    opsService,
    telegramService,
    schedulerConfig,
    schedulerCheckpoints,
    catalog,
    slots,
    pipeline,
    contentScheduler,
    effectiveSchedulerConfig: currentSchedulerConfig,
    corsOrigins,

    schedulerStatus(now = new Date()) {
      return describeSchedulerStatus(
        currentSchedulerConfig(),
        settings.current().automationState === 'running',
        env.SCHEDULER_MODE,
        now,
      );
    },

    schedulerLoopStatus() {
      // Mirrors the loop started in main.ts. The interval is a poll cadence;
      // the actual slot cadence comes from settings.intervalMinutes.
      const enabled = env.SCHEDULER_ENABLED === 'true' && env.SCHEDULER_MODE !== 'disabled';
      return {
        enabled,
        mode: env.SCHEDULER_MODE,
        tickIntervalMs: 60_000,
        reason: enabled
          ? 'Loop runs in-process: scheduler -> queue -> pipeline (independent of the APK).'
          : env.SCHEDULER_ENABLED !== 'true'
            ? 'SCHEDULER_ENABLED is not "true".'
            : 'SCHEDULER_MODE is "disabled".',
      };
    },

    integrationStatuses() {
      // Merge env-derived status with the live adapters' own readiness notes.
      const base = describeIntegrationStatus(env);
      return base.map((status) => {
        switch (status.service) {
          case 'facebook_page':
            return { ...status, detail: facebookPublisher.info.detail };
          case 'threads':
            return { ...status, detail: threadsPublisher.info.detail };
          case 'telegram':
            return { ...status, detail: notifier.info.detail };
          case 's3_storage':
            return { ...status, detail: storage.info.detail };
          case 'ai_image':
            return { ...status, detail: imageGenerator.info.detail };
          case 'ai_text':
            return { ...status, detail: captionGenerator.info.detail };
          default:
            return status;
        }
      });
    },

    readiness() {
      const degradedReasons: string[] = [];
      const current = settings.current();
      // The backend is READY if it can serve the APK. Missing optional
      // integrations degrade specific features but do not make it unready.
      if (current.automationState !== 'running') {
        degradedReasons.push(
          'Automation is paused - the backend stays up but publishes nothing until it is started.',
        );
      }
      if (catalog.total() === 0) {
        degradedReasons.push(
          'The product catalog is empty: import a Shopee Affiliate feed before slots can generate content.',
        );
      }
      degradedReasons.push(
        ...automationDegradedReasons({
          settings: current,
          schedulerMode: env.SCHEDULER_MODE,
          hasLiveDestination: facebookPublisher.info.ready || threadsPublisher.info.ready,
        }),
      );
      return { ready: true, degradedReasons };
    },

    async shutdown() {
      await database.close();
      logger.info({}, 'container shutdown complete');
    },
  };

  return container;
}


/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** Clamp an env-provided interval into the validated settings range. */
function clampInterval(value: number): number {
  return Math.min(Math.max(value, MIN_INTERVAL_MINUTES), MAX_INTERVAL_MINUTES);
}

/** Clamp env slot limits so the seeded defaults always pass validation. */
function clampMaxSlots(intervalMinutes: number, value: number): number {
  const capped = Math.min(Math.max(value, 1), MAX_SLOTS_PER_DAY);
  return Math.max(1, Math.min(capped, Math.floor((24 * 60) / clampInterval(intervalMinutes))));
}