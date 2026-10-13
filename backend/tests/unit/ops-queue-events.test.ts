/**
 * PART 8 §4/§6 — queue observability + terminal-failure event emission.
 *
 *  - `InMemoryJobQueue.stats()`: low-cardinality counts/ages only (the shape
 *    the dashboard and metrics endpoint consume; `expiredLeases` is 0 by
 *    definition in memory).
 *  - ContentScheduler terminal failures: a job that exhausts its attempt
 *    budget emits exactly ONE `generation_job_failed` ops event (scoped to the
 *    slot key, no product data); retryable failures along the way emit nothing,
 *    and a missing opsMonitor changes nothing (backward compatible).
 *
 * Deterministic: in-memory queue, injected clock, mock AI. No network, no
 * Telegram, no publication.
 */
import { describe, expect, it } from 'vitest';
import { ContentPipeline } from '../../src/automation/pipeline.js';
import { InMemorySlotStore, SlotContentStore } from '../../src/automation/slot-store.js';
import { InMemoryCatalogStore, ProductCatalog } from '../../src/catalog/catalog.js';
import { ShopeeFeedCsvImporter } from '../../src/integrations/feed/shopee-feed-importer.js';
import { MockCaptionGenerator } from '../../src/integrations/ai/mock-ai.js';
import { MemoryObjectStorage } from '../../src/integrations/storage/object-storage.js';
import { SettingsService } from '../../src/settings/automation-settings.js';
import { InMemoryJobQueue } from '../../src/queue/job-queue.js';
import {
  CONTENT_JOB_KIND,
  ContentScheduler,
  contentJobKey,
} from '../../src/scheduler/content-scheduler.js';
import { DEFAULT_SCHEDULER_CONFIG } from '../../src/scheduler/slots.js';
import type { GeneratedImage, ImageGenerator } from '../../src/contracts/index.js';

/* -------------------------------------------------------------------------- */
/*  Always-failing image provider (synthetic outage)                          */
/* -------------------------------------------------------------------------- */

class OutageImageGenerator implements ImageGenerator {
  readonly info = {
    name: 'outage_image',
    kind: 'mock' as const,
    model: 'outage-v1',
    ready: true,
    detail: 'Always fails — forces the retry budget to be spent.',
  };
  async generate(): Promise<GeneratedImage> {
    throw new Error('simulated provider outage');
  }
}

const importer = new ShopeeFeedCsvImporter();

async function buildCatalog(): Promise<ProductCatalog> {
  const catalog = new ProductCatalog(new InMemoryCatalogStore());
  const csvText = [
    'Item ID,Name,Product URL,Affiliate Link,Image URL,Category,Price,Commission Rate,Rating,Sold',
    '1,Synthetic Product 1,https://shopee.co.id/product/1,https://s.shopee.co.id/aff-1,https://cf.shopee.co.id/img/1.jpg,Health & Beauty,100000,10,4.8,500',
  ].join('\n');
  const parsed = await importer.parse({
    filename: 'feed.csv',
    content: new TextEncoder().encode(csvText),
  });
  await catalog.importFeed(parsed, { filename: 'feed.csv', format: 'csv' });
  return catalog;
}

/* ========================================================================== */
/*  InMemoryJobQueue.stats()                                                  */
/* ========================================================================== */

describe('InMemoryJobQueue.stats', () => {
  const start = new Date('2026-10-13T10:00:00.000Z');
  const nowFn = (): Date => start;

  it('reports zeroed counts for an empty queue with null ages', async () => {
    const queue = new InMemoryJobQueue(nowFn);
    const stats = await queue.stats();
    expect(stats).toEqual({
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      retrying: 0,
      oldestPendingAt: null,
      oldestPendingAgeMs: null,
      expiredLeases: 0,
    });
  });

  it('counts by status, marks retried pendings, and ages the oldest pending job', async () => {
    let ms = start.getTime();
    const now = (): Date => new Date(ms);
    const queue = new InMemoryJobQueue(now);

    const first = await queue.enqueue({
      kind: CONTENT_JOB_KIND,
      uniqueKey: 'k1',
      scheduledFor: new Date(start.getTime() - 120_000).toISOString(),
      payload: {},
    });
    await queue.enqueue({
      kind: CONTENT_JOB_KIND,
      uniqueKey: 'k2',
      scheduledFor: new Date(start.getTime() - 30_000).toISOString(),
      payload: {},
    });

    const claimed = await queue.claim('w1');
    await queue.complete(claimed!.id);
    const second = await queue.claim('w1');
    await queue.fail(second!.id, 'boom', false); // non-retryable → failed

    // A retryable failure leaves a pending job with attempts=1 (backoff +30s).
    const retryable = await queue.enqueue({
      kind: CONTENT_JOB_KIND,
      uniqueKey: 'k3',
      scheduledFor: new Date(start.getTime() - 10_000).toISOString(),
      payload: {},
      maxAttempts: 3,
    });
    const third = await queue.claim('w1');
    await queue.fail(third!.id, 'flaky', true); // retryable → pending, rescheduled

    // Advance past the backoff so k3 is a genuinely overdue pending job.
    ms += 45_000;

    const stats = await queue.stats();
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.retrying).toBe(1);
    expect(stats.expiredLeases).toBe(0); // in-memory queue has no leases
    const k3 = await queue.getByUniqueKey('k3');
    expect(stats.oldestPendingAt).toBe(k3!.scheduledFor);
    expect(stats.oldestPendingAgeMs).toBe(15_000); // 45s elapsed − 30s backoff

    // The completed/failed jobs are not pendings; identities stayed stable.
    expect((await queue.getByUniqueKey('k1'))!.id).toBe(first.id);
    expect((await queue.getByUniqueKey('k3'))!.id).toBe(retryable.id);
  });
});

/* ========================================================================== */
/*  Terminal failure → ops event                                              */
/* ========================================================================== */

interface FakeMonitorCall {
  kind: string;
  severity: string;
  title: string;
  detail?: string;
  scope?: string;
}

async function harnessWithOutage(options: { withMonitor: boolean }) {
  const catalog = await buildCatalog();
  const slots = new SlotContentStore(new InMemorySlotStore());
  const settings = new SettingsService();
  await settings.update({ imageCountPolicy: 'one' });
  await settings.control('start');

  let ms = Date.parse('2026-10-12T19:30:00+07:00');
  const now = (): Date => new Date(ms);
  const advance = (by: number): void => {
    ms += by;
  };

  const queue = new InMemoryJobQueue(now);
  const pipeline = new ContentPipeline({
    catalog,
    slots,
    settings,
    imageGenerator: new OutageImageGenerator(),
    captionGenerator: new MockCaptionGenerator(),
    storage: new MemoryObjectStorage(),
  });

  const calls: FakeMonitorCall[] = [];
  const scheduler = new ContentScheduler({
    queue,
    pipeline,
    settings,
    schedulerConfig: () => DEFAULT_SCHEDULER_CONFIG,
    now,
    ...(options.withMonitor
      ? { opsMonitor: { record: async (event: FakeMonitorCall) => (calls.push(event), {}) } }
      : {}),
  });

  return { scheduler, queue, calls, advance };
}

describe('ContentScheduler — terminal failure ops events (PART 8 §6)', () => {
  it('emits ONE generation_job_failed event when the attempt budget is spent', async () => {
    const { scheduler, calls, advance } = await harnessWithOutage({ withMonitor: true });

    // Attempt 1: retryable failure — no event yet.
    await scheduler.tick();
    expect(calls).toHaveLength(0);

    // Attempt 2 (past the 30s backoff): still retryable — no event yet.
    advance(31_000);
    await scheduler.tick();
    expect(calls).toHaveLength(0);

    // Attempt 3 (past the 60s backoff): terminal — exactly one event.
    advance(61_000);
    await scheduler.tick();
    expect(calls).toHaveLength(1);

    const event = calls[0]!;
    expect(event.kind).toBe('generation_job_failed');
    expect(event.severity).toBe('critical');
    expect(event.title).toContain('permanently');
    // Catch-up bounding runs only the CURRENT due slot (#04, the 19:00 window);
    // earlier missed windows are skipped by design. The event is scoped to the
    // slot's job identity; carries attempts + a sanitized error.
    expect(event.scope).toBe(contentJobKey('2026-10-12#04'));
    expect(event.detail).toMatch(/attempt\(s\)/);
    expect(event.detail).toContain('simulated provider outage');
  });

  it('works identically without an opsMonitor (backward compatible)', async () => {
    const { scheduler, advance } = await harnessWithOutage({ withMonitor: false });
    await scheduler.tick();
    advance(31_000);
    await scheduler.tick();
    advance(61_000);
    // Must not throw and must still record the terminal failure in the queue.
    await expect(scheduler.tick()).resolves.toBeDefined();
  });

  it('a monitor that rejects never breaks queue bookkeeping', async () => {
    const catalog = await buildCatalog();
    const slots = new SlotContentStore(new InMemorySlotStore());
    const settings = new SettingsService();
    await settings.update({ imageCountPolicy: 'one' });
    await settings.control('start');

    let ms = Date.parse('2026-10-12T19:30:00+07:00');
    const now = (): Date => new Date(ms);
    const queue = new InMemoryJobQueue(now);
    const pipeline = new ContentPipeline({
      catalog,
      slots,
      settings,
      imageGenerator: new OutageImageGenerator(),
      captionGenerator: new MockCaptionGenerator(),
      storage: new MemoryObjectStorage(),
    });
    const scheduler = new ContentScheduler({
      queue,
      pipeline,
      settings,
      schedulerConfig: () => DEFAULT_SCHEDULER_CONFIG,
      now,
      opsMonitor: {
        record: async () => {
          throw new Error('ops sink unavailable');
        },
      },
    });

    await scheduler.tick();
    ms += 31_000;
    await scheduler.tick();
    ms += 61_000;
    await expect(scheduler.tick()).resolves.toBeDefined();
    expect(await queue.countByStatus('failed')).toBe(1);
  });
});
