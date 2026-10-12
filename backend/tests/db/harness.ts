/**
 * A simulated backend "process" over the shared test cluster (PART 5).
 *
 * Each call to `startTestProcess()` builds a completely independent set of
 * stores, queues and pipeline over its OWN connection pool — exactly like two
 * separately deployed backends pointing at the same PostgreSQL. That is what
 * makes the concurrency and recovery tests meaningful: they are not two objects
 * sharing a JavaScript map, they are two sessions sharing a database.
 *
 * Everything credential-free: deterministic mock AI providers, in-memory object
 * storage, and a notifier that never sends anything.
 */
import { ContentPipeline } from '../../src/automation/pipeline.js';
import { SlotContentStore } from '../../src/automation/slot-store.js';
import { ProductCatalog } from '../../src/catalog/catalog.js';
import { MockCaptionGenerator, MockImageGenerator } from '../../src/integrations/ai/mock-ai.js';
import { MemoryObjectStorage } from '../../src/integrations/storage/object-storage.js';
import { PostgresCatalogStore } from '../../src/db/postgres-catalog-store.js';
import { PostgresJobQueue } from '../../src/db/postgres-job-queue.js';
import { PostgresSlotStore } from '../../src/db/postgres-slot-store.js';
import { PostgresSchedulerTickLock } from '../../src/db/postgres-tick-lock.js';
import {
  PostgresSchedulerCheckpointStore,
  PostgresSettingsStore,
} from '../../src/db/postgres-settings-store.js';
import { ContentScheduler } from '../../src/scheduler/content-scheduler.js';
import { DEFAULT_SCHEDULER_CONFIG, type SchedulerConfig } from '../../src/scheduler/slots.js';
import {
  DEFAULT_AUTOMATION_SETTINGS,
  SettingsService,
} from '../../src/settings/automation-settings.js';
import type { Notifier } from '../../src/contracts/index.js';
import { ShopeeFeedCsvImporter } from '../../src/integrations/feed/shopee-feed-importer.js';
import { openTestDatabase, type TestDatabase } from './helpers.js';

const notifier: Notifier = {
  info: {
    name: 'noop_notifier',
    kind: 'mock' as const,
    ready: true,
    detail: 'Never delivers anything (integration tests).',
  },
  async send() {
    return { delivered: false, transport: 'mock', deduped: false };
  },
} as unknown as Notifier;

export interface TestProcess {
  readonly id: string;
  readonly db: TestDatabase;
  readonly catalog: ProductCatalog;
  readonly slots: SlotContentStore;
  readonly queue: PostgresJobQueue;
  readonly settings: SettingsService;
  readonly pipeline: ContentPipeline;
  readonly scheduler: ContentScheduler;
  readonly storage: MemoryObjectStorage;
  close(): Promise<void>;
}

let processCounter = 0;

export async function startTestProcess(
  options: { leaseMs?: number; maxCatchUpPerTick?: number; now?: () => Date } = {},
): Promise<TestProcess> {
  processCounter += 1;
  const id = `process-${processCounter}`;
  const database = openTestDatabase();
  const db = database.db;

  const catalog = new ProductCatalog(new PostgresCatalogStore(db));
  const slots = new SlotContentStore(new PostgresSlotStore(db));
  const settings = new SettingsService(
    {
      ...DEFAULT_AUTOMATION_SETTINGS,
      automationState: 'running',
      intervalMinutes: 60,
      maxSlotsPerDay: 24,
    },
    new PostgresSettingsStore(db),
  );
  const queue = new PostgresJobQueue({ db, leaseMs: options.leaseMs });
  const storage = new MemoryObjectStorage({ publicBaseUrl: 'https://cdn.test' });

  const pipeline = new ContentPipeline({
    catalog,
    slots,
    settings,
    imageGenerator: new MockImageGenerator(),
    captionGenerator: new MockCaptionGenerator(),
    storage,
    notifier,
  });

  const schedulerConfig = (): SchedulerConfig => ({
    ...DEFAULT_SCHEDULER_CONFIG,
    timezone: 'Asia/Jakarta',
    intervalMinutes: 60,
    maxSlotsPerDay: 24,
  });

  const scheduler = new ContentScheduler({
    queue,
    pipeline,
    settings,
    schedulerConfig,
    now: options.now,
    checkpoints: new PostgresSchedulerCheckpointStore(db),
    // Deliberately the SAME lock name for every process in the suite: that is
    // the whole point — two processes must contend for one lock.
    tickLock: new PostgresSchedulerTickLock(database.raw, 'test_content_scheduler_tick'),
    maxCatchUpPerTick: options.maxCatchUpPerTick,
  });

  await catalog.init();
  await slots.init();
  await settings.init();

  return {
    id,
    db: database,
    catalog,
    slots,
    queue,
    settings,
    pipeline,
    scheduler,
    storage,
    async close() {
      await database.close();
    },
  };
}

const importer = new ShopeeFeedCsvImporter();

const FEED_HEADERS = [
  'Item ID',
  'Name',
  'Product URL',
  'Affiliate Link',
  'Image URL',
  'Category',
  'Price',
  'Commission Rate',
  'Rating',
  'Sold',
];

function feedRow(index: number, category: string): string {
  return [
    `syn-${index}`,
    `Synthetic Product ${index}`,
    `https://shopee.co.id/product/syn-${index}`,
    `https://s.shopee.co.id/aff-syn-${index}`,
    `https://cf.shopee.co.id/img/syn-${index}.jpg`,
    category,
    '100000',
    '10',
    '4.8',
    '500',
  ].join(',');
}

/**
 * Import a synthetic feed through the REAL importer into the given process'
 * PostgreSQL-backed catalog. Any other process sees the same rows, because the
 * catalog is durable — not a per-process map.
 */
export async function seedCatalog(process: TestProcess, productCount = 12): Promise<void> {
  const categories = ['electronics', 'beauty', 'home'];
  const lines = [FEED_HEADERS.join(',')];
  for (let i = 0; i < productCount; i += 1) {
    lines.push(feedRow(i, categories[i % categories.length] ?? 'electronics'));
  }
  const parsed = await importer.parse({
    filename: 'feed.csv',
    content: new TextEncoder().encode(lines.join('\n')),
  });
  await process.catalog.importFeed(parsed, { filename: 'feed.csv', format: 'csv' });
}
