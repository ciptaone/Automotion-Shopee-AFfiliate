/**
 * PART 8 §2-§4/§6 — OpsService: health→event mapping and evaluation loop.
 *
 * `eventsForComponent` and `automationPausedEvent` are pure and fully covered
 * here; `evaluateAndNotify` is exercised with structural fakes so no database,
 * provider or Telegram access happens in the default suite.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  OpsService,
  automationPausedEvent,
  eventsForComponent,
  median,
  type OpsEventEmission,
} from '../../src/ops/ops-service.js';
import type { HealthComponent } from '../../src/ops/component-health.js';

const NOW = new Date('2026-10-13T10:00:00.000Z');

function component(overrides: Partial<HealthComponent> & { key: string }): HealthComponent {
  return {
    displayName: overrides.key,
    status: 'healthy',
    code: 'ok',
    message: 'ok',
    criticality: 'operational',
    data: {},
    checkedAt: NOW.toISOString(),
    ...overrides,
  } as HealthComponent;
}

/* ========================================================================== */
/*  median                                                                    */
/* ========================================================================== */

describe('median', () => {
  it('returns null for an empty sample and handles odd/even sizes', () => {
    expect(median([])).toBeNull();
    expect(median([300, 100, 200])).toBe(200);
    expect(median([100, 200, 300, 400])).toBe(250);
    expect(median([150])).toBe(150);
  });
});

/* ========================================================================== */
/*  eventsForComponent (pure §6 mapping)                                      */
/* ========================================================================== */

describe('eventsForComponent', () => {
  it('maps an unreachable database to a critical database_unavailable event', () => {
    const emission = eventsForComponent(
      component({ key: 'database', criticality: 'required', status: 'unavailable', code: 'database_unreachable', message: 'refused' }),
    );
    expect(emission).toMatchObject({ kind: 'database_unavailable', severity: 'critical' });
    expect(emission?.detail).toBe('refused');
  });

  it('does NOT emit for an unconfigured database (valid dev mode)', () => {
    expect(
      eventsForComponent(component({ key: 'database', criticality: 'required', status: 'not_configured' })),
    ).toBeNull();
  });

  it('maps migration drift to critical and pending to warning', () => {
    expect(
      eventsForComponent(component({ key: 'migrations', criticality: 'required', status: 'blocked', code: 'migration_drift' }))?.kind,
    ).toBe('migration_drift');
    expect(
      eventsForComponent(component({ key: 'migrations', criticality: 'required', status: 'degraded', code: 'migration_pending' })),
    ).toMatchObject({ kind: 'migration_pending', severity: 'warning' });
  });

  it('maps scheduler staleness to scheduler_stale but stays silent on a healthy/disabled loop', () => {
    expect(
      eventsForComponent(component({ key: 'scheduler', status: 'degraded', code: 'scheduler_stale' }))?.kind,
    ).toBe('scheduler_stale');
    expect(eventsForComponent(component({ key: 'scheduler', status: 'healthy' }))).toBeNull();
    expect(eventsForComponent(component({ key: 'scheduler', status: 'disabled', code: 'scheduler_disabled' }))).toBeNull();
    expect(eventsForComponent(component({ key: 'scheduler', status: 'not_tested', code: 'scheduler_no_tick_yet' }))).toBeNull();
  });

  it('maps degraded queues (expired leases / backlog) to queue_degraded warnings', () => {
    expect(
      eventsForComponent(component({ key: 'queue', status: 'degraded', code: 'queue_expired_leases' })),
    ).toMatchObject({ kind: 'queue_degraded', severity: 'warning' });
    expect(eventsForComponent(component({ key: 'queue', status: 'healthy' }))).toBeNull();
  });

  it('maps blocked providers to auth or capability events with a per-provider scope', () => {
    const auth = eventsForComponent(
      component({
        key: 'caption_provider',
        status: 'blocked',
        code: 'provider_auth_failed',
        data: { providerId: 'prov-1' },
      }),
    );
    expect(auth?.kind).toBe('provider_auth_failed');
    expect(auth?.scope).toBe('caption_provider:prov-1');

    const capability = eventsForComponent(
      component({
        key: 'image_provider',
        status: 'blocked',
        code: 'provider_capability_unsupported',
        data: { providerId: 'prov-2' },
      }),
    );
    expect(capability?.kind).toBe('provider_capability_unsupported');
    expect(capability?.scope).toBe('image_provider:prov-2');

    // Degraded providers (failed tests, transient) stay dashboard-only.
    expect(eventsForComponent(component({ key: 'caption_provider', status: 'degraded', code: 'provider_test_failed' }))).toBeNull();
    expect(eventsForComponent(component({ key: 'caption_provider', status: 'not_configured' }))).toBeNull();
  });

  it('maps degraded storage to storage_unavailable; mock storage in dev stays silent', () => {
    expect(
      eventsForComponent(component({ key: 'asset_storage', status: 'degraded', code: 'storage_not_ready' }))?.kind,
    ).toBe('storage_unavailable');
    expect(eventsForComponent(component({ key: 'asset_storage', status: 'not_configured', code: 'storage_mock' }))).toBeNull();
  });

  it('maps budget states: exhausted → critical, threshold → warning, healthy/unbounded → nothing', () => {
    expect(
      eventsForComponent(component({ key: 'budget', status: 'blocked', code: 'budget_exhausted' })),
    ).toMatchObject({ kind: 'budget_exhausted', severity: 'critical' });
    expect(
      eventsForComponent(component({ key: 'budget', status: 'degraded', code: 'budget_threshold' }))?.kind,
    ).toBe('budget_threshold');
    expect(eventsForComponent(component({ key: 'budget', status: 'healthy', code: 'budget_not_configured' }))).toBeNull();
  });

  it('NEVER emits for telegram, backend or the publishing gate (no recursion, no expected-state noise)', () => {
    expect(eventsForComponent(component({ key: 'telegram', criticality: 'optional', status: 'degraded', code: 'telegram_delivery_failed' }))).toBeNull();
    expect(eventsForComponent(component({ key: 'backend', criticality: 'required', status: 'healthy' }))).toBeNull();
    expect(eventsForComponent(component({ key: 'publishing_gate', criticality: 'optional', status: 'disabled' }))).toBeNull();
  });
});

/* ========================================================================== */
/*  automationPausedEvent (cross-component rule)                              */
/* ========================================================================== */

describe('automationPausedEvent', () => {
  it('emits when paused AND a required dependency is unavailable', () => {
    expect(
      automationPausedEvent({ automationState: 'paused', databaseStatus: 'unavailable', migrationsStatus: 'healthy' }),
    ).toMatchObject({ kind: 'automation_paused', severity: 'warning' });
    expect(
      automationPausedEvent({ automationState: 'paused', databaseStatus: 'healthy', migrationsStatus: 'blocked' }),
    ).toMatchObject({ kind: 'automation_paused' });
  });

  it('stays silent when running, or when paused with everything healthy', () => {
    expect(automationPausedEvent({ automationState: 'running', databaseStatus: 'unavailable', migrationsStatus: 'healthy' })).toBeNull();
    expect(automationPausedEvent({ automationState: 'paused', databaseStatus: 'healthy', migrationsStatus: 'healthy' })).toBeNull();
    expect(automationPausedEvent({ automationState: 'paused', databaseStatus: 'not_configured', migrationsStatus: 'not_configured' })).toBeNull();
  });
});

/* ========================================================================== */
/*  evaluateAndNotify with structural fakes                                   */
/* ========================================================================== */

function fakeDeps(overrides: Record<string, unknown> = {}) {
  const emissions: OpsEventEmission[] = [];
  const monitor = {
    record: vi.fn(async (event: OpsEventEmission) => {
      emissions.push(event);
      return {};
    }),
  };
  const deps = {
    env: { NODE_ENV: 'test', SCHEDULER_ENABLED: 'false', SCHEDULER_MODE: 'mock' },
    version: '0.1.0',
    startTime: NOW,
    database: { configured: false, healthy: async () => false, statusDetail: async () => '', migrationStatus: async () => null },
    persistenceBackend: 'memory',
    queue: { stats: async () => null },
    settings: { current: () => ({ automationState: 'paused', telegramNotificationsEnabled: false, notificationMinSeverity: 'warning', notificationEventKinds: [] }) },
    providers: { selection: async () => null, list: async () => [] },
    usage: { budgetStatus: async () => null, summary: async () => null },
    storage: { info: { kind: 'mock', ready: true, detail: 'in-memory' } },
    contentScheduler: { peekLastTick: () => null },
    schedulerStatus: () => ({
      enabled: false,
      mode: 'mock',
      timezone: 'Asia/Jakarta',
      intervalMinutes: 60,
      maxSlotsPerDay: 24,
      dailyPostTarget: 4,
      postingWindows: ['a', 'b', 'c', 'd'],
      todayWindows: [],
      today: '2026-10-13',
      slotsToday: 0,
      nextSlot: null,
    }),
    schedulerLoopStatus: () => ({ enabled: false, mode: 'mock', tickIntervalMs: 60_000, reason: 'disabled' }),
    secrets: { has: async () => false },
    recentEvents: async () => [],
    monitor,
    ...overrides,
  };
  return { deps, monitor, emissions };
}

describe('OpsService.evaluateAndNotify', () => {
  it('records one event per unhealthy mapped component and stays quiet otherwise', async () => {
    const brokenDatabase = {
      configured: true,
      healthy: async () => false,
      statusDetail: async () => 'refused',
      migrationStatus: async () => null,
    };
    const { deps, emissions } = fakeDeps({ database: brokenDatabase });
    const service = new OpsService(deps as never);

    const result = await service.evaluateAndNotify(NOW);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(emissions.some((e) => e.kind === 'database_unavailable')).toBe(true);
    // Migrations unreadable (not_tested) and scheduler disabled are not events.
    expect(emissions.some((e) => e.kind === 'migration_drift')).toBe(false);
    expect(emissions.some((e) => e.kind === 'scheduler_stale')).toBe(false);
  });

  it('never throws when the monitor itself fails (timer safety)', async () => {
    const monitor = { record: vi.fn(async () => { throw new Error('monitor down'); }) };
    const { deps } = fakeDeps({
      monitor,
      database: { configured: true, healthy: async () => false, statusDetail: async () => 'x', migrationStatus: async () => null },
    });
    const service = new OpsService(deps as never);
    await expect(service.evaluateAndNotify(NOW)).resolves.toBeDefined();
  });

  it('emits automation_paused when paused with a broken required dependency', async () => {
    const brokenDatabase = {
      configured: true,
      healthy: async () => false,
      statusDetail: async () => 'refused',
      migrationStatus: async () => null,
    };
    const { deps, emissions } = fakeDeps({ database: brokenDatabase });
    const service = new OpsService(deps as never);
    await service.evaluateAndNotify(NOW);
    expect(emissions.some((e) => e.kind === 'automation_paused')).toBe(true);
  });

  it('returns [] and records nothing when no monitor is wired', async () => {
    const { deps } = fakeDeps({ monitor: undefined });
    const service = new OpsService(deps as never);
    expect(await service.evaluateAndNotify(NOW)).toEqual([]);
  });

  it('never calls a paid AI API: health only reads cached probes and config state', async () => {
    const generationCall = vi.fn(async () => {
      throw new Error('generation must never run during health');
    });
    const { deps } = fakeDeps({
      providers: { selection: async () => null, list: async () => [] },
      usage: {
        budgetStatus: async () => null,
        summary: async () => {
          throw new Error('summary unavailable');
        },
      },
      generationCall,
    });
    const service = new OpsService(deps as never);
    const report = await service.health(NOW);

    expect(report.overall).toBeDefined();
    expect(report.ready).toBe(true); // dev: no DB configured
    expect(generationCall).not.toHaveBeenCalled();

    const keys = report.components.map((c) => c.key);
    expect(keys).toEqual([
      'backend',
      'database',
      'migrations',
      'scheduler',
      'queue',
      'caption_provider',
      'image_provider',
      'asset_storage',
      'telegram',
      'budget',
      'publishing_gate',
    ]);
    // Publishing gate is always explicitly present.
    expect(report.components.find((c) => c.key === 'publishing_gate')?.code).toBe('publishing_disabled');
  });

  it('health exposes scheduler diagnostics and queue stats for the dashboard', async () => {
    const stats = {
      pending: 2,
      running: 1,
      succeeded: 3,
      failed: 0,
      cancelled: 0,
      retrying: 1,
      oldestPendingAt: NOW.toISOString(),
      oldestPendingAgeMs: 1_000,
      expiredLeases: 0,
    };
    const { deps } = fakeDeps({ queue: { stats: async () => stats } });
    const service = new OpsService(deps as never);
    const report = await service.health(NOW);

    expect(report.scheduler.dailyPostTarget).toBe(4);
    expect(report.scheduler.timezone).toBe('Asia/Jakarta');
    expect(report.queue).toEqual(stats);

    const metrics = await service.metrics(NOW);
    expect(metrics.scheduler.dailyPostTarget).toBe(4);
    expect(metrics.queue).toEqual(stats);
    expect(metrics.events.sampled).toBe(0);
  });
});
