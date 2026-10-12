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
import { createDatabaseHandle, type DatabaseHandle } from '../db/client.js';
import { InMemoryJobQueue } from '../queue/job-queue.js';
import { ShopeeFeedCsvImporter } from '../integrations/feed/shopee-feed-importer.js';
import { MockCaptionGenerator, MockImageGenerator } from '../integrations/ai/mock-ai.js';
import { MemoryObjectStorage } from '../integrations/storage/object-storage.js';
import {
  FacebookPagePublisher,
  StubGraphTransport,
  ThreadsPublisher,
} from '../integrations/publishing/publishers.js';
import { MemoryTelegramTransport, TelegramNotifier } from '../integrations/notifications/telegram.js';
import {
  DEFAULT_SCHEDULER_CONFIG,
  describeSchedulerStatus,
  type SchedulerConfig,
  type SchedulerStatus,
} from '../scheduler/slots.js';
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
  readonly queue: JobQueue;
  readonly settings: SettingsService;
  readonly feedImporter: ProductFeedImporter;
  readonly imageGenerator: ImageGenerator;
  readonly captionGenerator: CaptionGenerator;
  readonly storage: ObjectStorage;
  readonly facebookPublisher: Publisher;
  readonly threadsPublisher: Publisher;
  readonly notifier: Notifier;
  readonly schedulerConfig: SchedulerConfig;
  /** Persistent product catalog (Part 3). */
  readonly catalog: ProductCatalog;
  /** Per-slot content records: reservation, image count, assets, captions. */
  readonly slots: SlotContentStore;
  /** The real content pipeline (selection -> images -> captions -> gate). */
  readonly pipeline: ContentPipeline;
  /** Scheduler config with the APK-managed interval/slot overrides applied. */
  effectiveSchedulerConfig(): SchedulerConfig;
  readonly corsOrigins: readonly string[];

  schedulerStatus(now?: Date): SchedulerStatus;
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
  };

  /* --- Automation settings (Part 2: validated + persisted) --- */
  // Environment values seed the DEFAULTS only; after boot the APK-managed
  // settings (persisted via the store) are authoritative.
  const seededDefaults = {
    ...DEFAULT_AUTOMATION_SETTINGS,
    intervalMinutes: clampInterval(env.SCHEDULER_INTERVAL_MINUTES),
    maxSlotsPerDay: clampMaxSlots(env.SCHEDULER_INTERVAL_MINUTES, env.SCHEDULER_MAX_SLOTS_PER_DAY),
    automationState: env.SCHEDULER_ENABLED === 'true' ? ('running' as const) : ('paused' as const),
  };

  const settingsStore: SettingsStore =
    options.overrides?.settingsStore ??
    (env.NODE_ENV === 'test'
      ? new InMemorySettingsStore()
      : new FileSettingsStore(path.join(process.cwd(), 'data', 'settings.json')));

  const settings = new SettingsService(seededDefaults, settingsStore);

  /* --- Catalog + slot content + pipeline (Part 3) --- */
  // Like settings: file-backed persistence by default (verified here),
  // in-memory under test. A PostgreSQL-backed store plugs in behind the same
  // interfaces (schema in db/schema.ts, migration 0001_part3_catalog.sql).
  const isTest = env.NODE_ENV === 'test';

  const catalogStore: CatalogStore =
    options.overrides?.catalogStore ??
    (isTest
      ? new InMemoryCatalogStore()
      : new FileCatalogStore(path.join(process.cwd(), 'data', 'catalog.json')));

  const slotStore: SlotStore =
    options.overrides?.slotStore ??
    (isTest
      ? new InMemorySlotStore()
      : new FileSlotStore(path.join(process.cwd(), 'data', 'slots.json')));

  const catalog = new ProductCatalog(catalogStore);
  const slots = new SlotContentStore(slotStore);

  /** Scheduler config as currently configured through the APK settings screen. */
  const currentSchedulerConfig = (): SchedulerConfig => {
    const current = settings.current();
    return {
      ...schedulerConfig,
      intervalMinutes: current.intervalMinutes,
      maxSlotsPerDay: current.maxSlotsPerDay,
    };
  };

  /* --- Integrations (defaults are all credential-free mocks) --- */
  const feedImporter = options.overrides?.feedImporter ?? new ShopeeFeedCsvImporter();

  const imageGenerator =
    options.overrides?.imageGenerator ??
    (env.AI_IMAGE_PROVIDER === 'disabled'
      ? new MockImageGenerator({ model: 'disabled' })
      : new MockImageGenerator({ model: env.AI_IMAGE_MODEL }));

  const captionGenerator =
    options.overrides?.captionGenerator ??
    (env.AI_TEXT_PROVIDER === 'disabled'
      ? new MockCaptionGenerator({ model: 'disabled' })
      : new MockCaptionGenerator({ model: env.AI_TEXT_MODEL }));

  const storage =
    options.overrides?.storage ??
    new MemoryObjectStorage({ publicBaseUrl: env.S3_PUBLIC_BASE_URL });

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

  const queue = options.overrides?.queue ?? new InMemoryJobQueue();

  const database = options.overrides?.database ?? createDatabaseHandle(env.DATABASE_URL);

  const corsOrigins = parseCorsOrigins(env.CORS_ORIGINS);

  /** The real content pipeline. Never publishes: live publishing is PART 4+. */
  const pipeline = new ContentPipeline({
    catalog,
    slots,
    settings,
    imageGenerator,
    captionGenerator,
    storage,
    notifier,
  });

  const container: AppContainer = {
    env,
    logger,
    database,
    queue,
    settings,
    feedImporter,
    imageGenerator,
    captionGenerator,
    storage,
    facebookPublisher,
    threadsPublisher,
    notifier,
    schedulerConfig,
    catalog,
    slots,
    pipeline,
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