/**
 * PART 8 §2/§3 — operational health model (pure evaluators).
 *
 * These tests lock the semantics the dashboard and /v1/ops/health depend on:
 *  - the seven-status vocabulary and the worst-status roll-up,
 *  - configured ≠ healthy (a provider that was never tested is `not_tested`),
 *  - readiness is database + migrations only, with documented blocker rules,
 *  - `disabled`/`not_configured` optional components never degrade overall,
 *  - messages/codes are stable machine-readable values, never secrets.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateOverall,
  buildHealthReport,
  evaluateAssetStorage,
  evaluateBackend,
  evaluateBudget,
  evaluateDatabase,
  evaluateMigrations,
  evaluateProvider,
  evaluatePublishingGate,
  evaluateQueue,
  evaluateScheduler,
  evaluateTelegram,
  HEALTH_STATUSES,
  worstStatus,
  type HealthComponent,
} from '../../src/ops/component-health.js';
import type { MigrationStatusReport } from '../../src/db/migration-status.js';
import type { ProviderView } from '../../src/providers/provider-service.js';
import type { BudgetStatus, BudgetWindow } from '../../src/usage/usage-service.js';

const NOW = new Date('2026-10-13T10:00:00.000Z');

function migrationReport(
  overrides: Partial<MigrationStatusReport> = {},
): MigrationStatusReport {
  return {
    migrationsFolder: 'drizzle',
    journalEntries: 4,
    appliedRows: 4,
    tablePresent: true,
    entries: [],
    unknownApplied: [],
    appliedCount: 4,
    pendingCount: 0,
    divergedCount: 0,
    consistent: true,
    problems: [],
    ...overrides,
  } as MigrationStatusReport;
}

function providerView(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    id: 'prov-1',
    name: 'openai-main',
    displayName: 'OpenAI main',
    adapterType: 'openai_chat_completions',
    adapterLabel: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4o-mini',
    auth: { type: 'bearer' },
    extraHeaders: {},
    params: {},
    timeoutMs: 30_000,
    maxRetries: 2,
    enabled: true,
    capabilities: {
      text_generation: true,
      image_generation: false,
      image_reference_input: false,
      image_editing: false,
      structured_output: true,
    },
    supportedTasks: ['caption'],
    secret: { present: true, keyConfigured: true } as ProviderView['secret'],
    readiness: {},
    selectedFor: ['caption'],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  } as ProviderView;
}

/* ========================================================================== */
/*  Vocabulary                                                                */
/* ========================================================================== */

describe('health vocabulary', () => {
  it('exposes exactly the locked seven statuses', () => {
    expect([...HEALTH_STATUSES]).toEqual([
      'healthy',
      'degraded',
      'blocked',
      'unavailable',
      'not_configured',
      'not_tested',
      'disabled',
    ]);
  });

  it('worstStatus orders by severity and defaults to healthy', () => {
    expect(worstStatus([])).toBe('healthy');
    expect(worstStatus(['healthy', 'disabled', 'not_configured'])).toBe('not_configured');
    expect(worstStatus(['degraded', 'not_tested'])).toBe('degraded');
    expect(worstStatus(['unavailable', 'blocked'])).toBe('blocked');
    expect(worstStatus(['healthy', 'unavailable'])).toBe('unavailable');
  });
});

/* ========================================================================== */
/*  Database + migrations                                                     */
/* ========================================================================== */

describe('evaluateDatabase', () => {
  it('is not_configured without DATABASE_URL (valid dev mode, not a failure)', () => {
    const component = evaluateDatabase({ now: NOW, configured: false, healthy: false, detail: '' });
    expect(component.status).toBe('not_configured');
    expect(component.code).toBe('database_not_configured');
    expect(component.criticality).toBe('required');
  });

  it('is unavailable when configured but unreachable (blocks generation)', () => {
    const component = evaluateDatabase({ now: NOW, configured: true, healthy: false, detail: 'refused' });
    expect(component.status).toBe('unavailable');
    expect(component.code).toBe('database_unreachable');
    expect(component.message).toMatch(/not accepted until it is reachable/);
  });

  it('is healthy only after a real round-trip succeeded', () => {
    const component = evaluateDatabase({ now: NOW, configured: true, healthy: true, detail: '' });
    expect(component.status).toBe('healthy');
    expect(component.data.reachable).toBe(true);
  });
});

describe('evaluateMigrations', () => {
  it('reports drift (diverged entries) as blocked — schema mismatch is unsafe', () => {
    const component = evaluateMigrations({
      now: NOW,
      configured: true,
      report: migrationReport({ consistent: false, divergedCount: 1 }),
    });
    expect(component.status).toBe('blocked');
    expect(component.code).toBe('migration_drift');
  });

  it('reports unknown applied rows or a missing bookkeeping table as blocked', () => {
    expect(
      evaluateMigrations({
        now: NOW,
        configured: true,
        report: migrationReport({ consistent: false, unknownApplied: [{ when: 1, hash: 'x' }] }),
      }).status,
    ).toBe('blocked');
    expect(
      evaluateMigrations({
        now: NOW,
        configured: true,
        report: migrationReport({ consistent: false, tablePresent: false }),
      }).status,
    ).toBe('blocked');
  });

  it('reports pending migrations as degraded with an actionable message', () => {
    const component = evaluateMigrations({
      now: NOW,
      configured: true,
      report: migrationReport({ consistent: false, pendingCount: 2, appliedCount: 2 }),
    });
    expect(component.status).toBe('degraded');
    expect(component.code).toBe('migration_pending');
    expect(component.message).toMatch(/db:migrate/);
  });

  it('is healthy when everything is applied and nothing drifted', () => {
    const component = evaluateMigrations({ now: NOW, configured: true, report: migrationReport() });
    expect(component.status).toBe('healthy');
  });

  it('is not_tested when the status could not be read', () => {
    expect(
      evaluateMigrations({ now: NOW, configured: true, report: null }).code,
    ).toBe('migrations_status_unknown');
  });
});

/* ========================================================================== */
/*  Scheduler                                                                 */
/* ========================================================================== */

const schedulerBase = {
  now: NOW,
  loopEnabled: true,
  mode: 'mock',
  automationState: 'running',
  tickIntervalMs: 60_000,
  lastTickAt: NOW.toISOString(),
  lastTickFailedJobs: 0,
  dailyPostTarget: 4,
  slotsToday: 2,
  nextSlotAt: '2026-10-13T11:00:00+07:00',
  timezone: 'Asia/Jakarta',
};

describe('evaluateScheduler', () => {
  it('is disabled when the loop is off, with an explicit code', () => {
    const component = evaluateScheduler({ ...schedulerBase, loopEnabled: false });
    expect(component.status).toBe('disabled');
    expect(component.code).toBe('scheduler_disabled');
  });

  it('flags the dangerous loop-off-but-automation-running combination', () => {
    const component = evaluateScheduler({
      ...schedulerBase,
      loopEnabled: false,
      automationState: 'running',
    });
    expect(component.message).toMatch(/SCHEDULER_ENABLED=true/);
  });

  it('is disabled (not degraded) while automation is paused by the operator', () => {
    const component = evaluateScheduler({ ...schedulerBase, automationState: 'paused' });
    expect(component.status).toBe('disabled');
    expect(component.code).toBe('automation_paused');
  });

  it('is not_tested before the first tick completes', () => {
    const component = evaluateScheduler({ ...schedulerBase, lastTickAt: null });
    expect(component.status).toBe('not_tested');
    expect(component.code).toBe('scheduler_no_tick_yet');
  });

  it('is degraded when the last tick is older than 3 cadences', () => {
    const stale = new Date(NOW.getTime() - 20 * 60_000).toISOString();
    const component = evaluateScheduler({ ...schedulerBase, lastTickAt: stale });
    expect(component.status).toBe('degraded');
    expect(component.code).toBe('scheduler_stale');
  });

  it('is healthy while ticks flow and reports the daily target/slots in data', () => {
    const component = evaluateScheduler(schedulerBase);
    expect(component.status).toBe('healthy');
    expect(component.data.dailyPostTarget).toBe(4);
    expect(component.data.slotsToday).toBe(2);
    expect(component.data.timezone).toBe('Asia/Jakarta');
  });
});

/* ========================================================================== */
/*  Queue                                                                     */
/* ========================================================================== */

const queueStatsBase = {
  pending: 1,
  running: 0,
  succeeded: 5,
  failed: 1,
  cancelled: 0,
  retrying: 1,
  oldestPendingAt: new Date(NOW.getTime() - 60_000).toISOString(),
  oldestPendingAgeMs: 60_000,
  expiredLeases: 0,
};

describe('evaluateQueue', () => {
  it('is not_tested when the queue exposes no stats', () => {
    expect(evaluateQueue({ now: NOW, stats: null, persistence: 'memory' }).code).toBe(
      'queue_stats_unavailable',
    );
  });

  it('is degraded when leases expired (crashed workers)', () => {
    const component = evaluateQueue({
      now: NOW,
      stats: { ...queueStatsBase, expiredLeases: 2 },
      persistence: 'postgres',
    });
    expect(component.status).toBe('degraded');
    expect(component.code).toBe('queue_expired_leases');
  });

  it('is degraded when the oldest pending job is older than the backoff ceiling', () => {
    const component = evaluateQueue({
      now: NOW,
      stats: { ...queueStatsBase, oldestPendingAgeMs: 30 * 60_000 },
      persistence: 'postgres',
    });
    expect(component.status).toBe('degraded');
    expect(component.code).toBe('queue_backlog');
  });

  it('is healthy with counts in data; terminal failures are outcomes, not health', () => {
    const component = evaluateQueue({ now: NOW, stats: queueStatsBase, persistence: 'memory' });
    expect(component.status).toBe('healthy');
    expect(component.data.failed).toBe(1);
    expect(component.data.retrying).toBe(1);
  });
});

/* ========================================================================== */
/*  Providers (text and image tracked independently)                          */
/* ========================================================================== */

describe('evaluateProvider', () => {
  it('is not_configured when nothing is selected — even if env defaults exist', () => {
    const caption = evaluateProvider({ now: NOW, task: 'caption', selected: null, view: null });
    const image = evaluateProvider({ now: NOW, task: 'image', selected: null, view: null });
    expect(caption.status).toBe('not_configured');
    expect(image.status).toBe('not_configured');
    expect(caption.key).toBe('caption_provider');
    expect(image.key).toBe('image_provider');
  });

  it('is not_tested when configured but the capability probe never ran (configured ≠ healthy)', () => {
    const component = evaluateProvider({
      now: NOW,
      task: 'caption',
      selected: { id: 'prov-1', name: 'openai-main' },
      view: providerView(),
    });
    expect(component.status).toBe('not_tested');
    expect(component.code).toBe('provider_not_tested');
    expect(component.message).toMatch(/connection test/);
  });

  it('is healthy only when the cached capability probe says ready', () => {
    const component = evaluateProvider({
      now: NOW,
      task: 'caption',
      selected: { id: 'prov-1', name: 'openai-main' },
      view: providerView({
        readiness: {
          configuration: { status: 'ready', detail: 'ok', testedAt: NOW.toISOString() },
          authentication: { status: 'ready', detail: 'ok', testedAt: NOW.toISOString() },
          text_generation: { status: 'ready', detail: 'ok', testedAt: NOW.toISOString() },
        } as ProviderView['readiness'],
      }),
    });
    expect(component.status).toBe('healthy');
  });

  it('is blocked on authentication_failed with the sanitized probe detail', () => {
    const component = evaluateProvider({
      now: NOW,
      task: 'caption',
      selected: { id: 'prov-1', name: 'openai-main' },
      view: providerView({
        readiness: {
          configuration: { status: 'ready', detail: 'ok' },
          authentication: { status: 'authentication_failed', detail: 'invalid api key' },
          text_generation: { status: 'authentication_failed', detail: 'invalid api key' },
        } as ProviderView['readiness'],
      }),
    });
    expect(component.status).toBe('blocked');
    expect(component.code).toBe('provider_auth_failed');
  });

  it('is blocked when the capability is unsupported for the selected task', () => {
    const component = evaluateProvider({
      now: NOW,
      task: 'image',
      selected: { id: 'prov-2', name: 'img-main' },
      view: providerView({
        id: 'prov-2',
        name: 'img-main',
        adapterType: 'openai_images',
        selectedFor: ['image'],
        capabilities: {
          text_generation: false,
          image_generation: false,
          image_reference_input: false,
          image_editing: false,
          structured_output: false,
        },
        readiness: {
          configuration: { status: 'ready', detail: 'ok' },
          authentication: { status: 'ready', detail: 'ok' },
          image_generation: { status: 'capability_unsupported', detail: 'not supported' },
        } as ProviderView['readiness'],
      }),
    });
    expect(component.status).toBe('blocked');
    expect(component.code).toBe('provider_capability_unsupported');
  });

  it('is blocked when the selected provider was deleted from the workspace', () => {
    const component = evaluateProvider({
      now: NOW,
      task: 'caption',
      selected: { id: 'gone', name: 'gone' },
      view: null,
    });
    expect(component.status).toBe('blocked');
    expect(component.code).toBe('provider_missing');
  });

  it('is disabled when the provider is switched off in the workspace', () => {
    const component = evaluateProvider({
      now: NOW,
      task: 'caption',
      selected: { id: 'prov-1', name: 'openai-main' },
      view: providerView({ enabled: false }),
    });
    expect(component.status).toBe('disabled');
    expect(component.code).toBe('provider_disabled');
  });

  it('is degraded (not blocked) for a failed test or transient unavailability', () => {
    for (const status of ['test_failed', 'temporarily_unavailable', 'rate_limited'] as const) {
      const component = evaluateProvider({
        now: NOW,
        task: 'caption',
        selected: { id: 'prov-1', name: 'openai-main' },
        view: providerView({
          readiness: {
            text_generation: { status, detail: 'upstream hiccup', testedAt: NOW.toISOString() },
          } as ProviderView['readiness'],
        }),
      });
      expect(component.status).toBe('degraded');
    }
  });

  it('tracks image_reference_input support as data for the fidelity check', () => {
    const component = evaluateProvider({
      now: NOW,
      task: 'image',
      selected: { id: 'prov-2', name: 'img-main' },
      view: providerView({
        id: 'prov-2',
        name: 'img-main',
        selectedFor: ['image'],
        capabilities: {
          text_generation: false,
          image_generation: true,
          image_reference_input: true,
          image_editing: false,
          structured_output: false,
        },
        readiness: {
          image_generation: { status: 'ready', detail: 'ok', testedAt: NOW.toISOString() },
        } as ProviderView['readiness'],
      }),
    });
    expect(component.status).toBe('healthy');
    expect(component.data.referenceImageDeclared).toBe(true);
  });
});

/* ========================================================================== */
/*  Storage / Telegram / budget / publishing gate                             */
/* ========================================================================== */

describe('evaluateAssetStorage', () => {
  it('treats mock storage as not_configured — placeholders are not healthy', () => {
    const component = evaluateAssetStorage({
      now: NOW,
      kind: 'mock',
      infoReady: true,
      infoDetail: 'in-memory',
    });
    expect(component.status).toBe('not_configured');
    expect(component.code).toBe('storage_mock');
    expect(component.message).toMatch(/vanish on restart/);
  });

  it('is healthy for durable storage', () => {
    expect(
      evaluateAssetStorage({ now: NOW, kind: 's3', infoReady: true, infoDetail: 'ok' }).status,
    ).toBe('healthy');
  });

  it('is degraded when the storage implementation reports not ready', () => {
    expect(
      evaluateAssetStorage({ now: NOW, kind: 'file', infoReady: false, infoDetail: 'disk full' })
        .status,
    ).toBe('degraded');
  });
});

describe('evaluateTelegram', () => {
  it('is disabled when notifications are switched off (optional service)', () => {
    const component = evaluateTelegram({
      now: NOW,
      enabled: false,
      configured: true,
      lastDeliveryStatus: null,
      lastDeliveryAt: null,
    });
    expect(component.status).toBe('disabled');
    expect(component.criticality).toBe('optional');
  });

  it('is not_configured when enabled without a stored credential — never a crash', () => {
    const component = evaluateTelegram({
      now: NOW,
      enabled: true,
      configured: false,
      lastDeliveryStatus: null,
      lastDeliveryAt: null,
    });
    expect(component.status).toBe('not_configured');
    expect(component.code).toBe('telegram_not_configured');
  });

  it('is degraded when the last confirmed delivery failed', () => {
    const component = evaluateTelegram({
      now: NOW,
      enabled: true,
      configured: true,
      lastDeliveryStatus: 'failed',
      lastDeliveryAt: NOW.toISOString(),
    });
    expect(component.status).toBe('degraded');
    expect(component.code).toBe('telegram_delivery_failed');
    expect(component.message).toMatch(/ops_events/);
  });

  it('is healthy when configured and enabled', () => {
    expect(
      evaluateTelegram({
        now: NOW,
        enabled: true,
        configured: true,
        lastDeliveryStatus: 'sent',
        lastDeliveryAt: NOW.toISOString(),
      }).status,
    ).toBe('healthy');
  });
});

describe('evaluateBudget', () => {
  const budgetStatus = (
    overrides: {
      dailyBudgetUsd?: number | null;
      monthlyBudgetUsd?: number | null;
      day?: Partial<BudgetWindow>;
      month?: Partial<BudgetWindow>;
    } = {},
  ): BudgetStatus => ({
    timezone: 'Asia/Jakarta',
    dailyBudgetUsd:
      overrides.dailyBudgetUsd !== undefined ? overrides.dailyBudgetUsd : 5,
    monthlyBudgetUsd:
      overrides.monthlyBudgetUsd !== undefined ? overrides.monthlyBudgetUsd : 50,
    day: {
      from: '2026-10-13T00:00:00.000Z',
      to: '2026-10-14T00:00:00.000Z',
      spentUsd: 1,
      budgetUsd: 5,
      exhausted: false,
      ...overrides.day,
    },
    month: {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
      spentUsd: 10,
      budgetUsd: 50,
      exhausted: false,
      ...overrides.month,
    },
    blocked: false,
    blockedScope: null,
    unknownCostRequests: 0,
    note: '',
  });

  it('is blocked when the daily or monthly budget is exhausted', () => {
    const daily = evaluateBudget({
      now: NOW,
      budget: budgetStatus({ day: { spentUsd: 5, budgetUsd: 5, exhausted: true } }),
    });
    expect(daily.status).toBe('blocked');
    expect(daily.code).toBe('budget_exhausted');
  });

  it('is degraded at the 90% warning threshold', () => {
    const component = evaluateBudget({
      now: NOW,
      budget: budgetStatus({ day: { spentUsd: 4.6, budgetUsd: 5, exhausted: false } }),
    });
    expect(component.status).toBe('degraded');
    expect(component.code).toBe('budget_threshold');
    expect(component.message).toMatch(/92%/);
  });

  it('is healthy under the threshold and says so when no budget is configured', () => {
    expect(evaluateBudget({ now: NOW, budget: budgetStatus() }).status).toBe('healthy');
    const unbounded = evaluateBudget({
      now: NOW,
      budget: budgetStatus({
        dailyBudgetUsd: null,
        monthlyBudgetUsd: null,
        day: { spentUsd: 0, budgetUsd: null },
        month: { spentUsd: 0, budgetUsd: null },
      }),
    });
    expect(unbounded.code).toBe('budget_not_configured');
  });

  it('is not_tested when the ledger could not be read', () => {
    expect(evaluateBudget({ now: NOW, budget: null }).code).toBe('budget_status_unavailable');
  });
});

describe('evaluatePublishingGate', () => {
  it('always reports disabled-by-design with publish_ready as the terminal stage', () => {
    const component = evaluatePublishingGate({ now: NOW });
    expect(component.status).toBe('disabled');
    expect(component.code).toBe('publishing_disabled');
    expect(component.data.pipelineTerminalStage).toBe('publish_ready');
    expect(component.data.facebook).toBe('disabled');
    expect(component.data.threads).toBe('disabled');
  });
});

/* ========================================================================== */
/*  Aggregation + readiness                                                   */
/* ========================================================================== */

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

describe('aggregateOverall', () => {
  it('takes the worst status across required/operational components', () => {
    const overall = aggregateOverall([
      component({ key: 'database', criticality: 'required', status: 'healthy' }),
      component({ key: 'scheduler', status: 'degraded' }),
      component({ key: 'queue', status: 'healthy' }),
    ]);
    expect(overall.overall).toBe('degraded');
    expect(overall.blockers).toEqual([]);
  });

  it('does NOT let disabled/not_configured optional services degrade overall', () => {
    const overall = aggregateOverall([
      component({ key: 'database', criticality: 'required', status: 'healthy' }),
      component({ key: 'telegram', criticality: 'optional', status: 'not_configured' }),
      component({ key: 'publishing_gate', criticality: 'optional', status: 'disabled' }),
    ]);
    expect(overall.overall).toBe('healthy');
  });

  it('DOES let a broken optional service degrade overall (delivery failing matters)', () => {
    const overall = aggregateOverall([
      component({ key: 'database', criticality: 'required', status: 'healthy' }),
      component({ key: 'telegram', criticality: 'optional', status: 'degraded' }),
    ]);
    expect(overall.overall).toBe('degraded');
  });

  it('collects blocked/unavailable codes as blockers', () => {
    const overall = aggregateOverall([
      component({ key: 'database', criticality: 'required', status: 'unavailable', code: 'database_unreachable' }),
      component({ key: 'image_provider', status: 'blocked', code: 'provider_capability_unsupported' }),
    ]);
    expect(overall.overall).toBe('blocked');
    expect(overall.blockers).toEqual(['database_unreachable', 'provider_capability_unsupported']);
  });
});

describe('buildHealthReport', () => {
  it('is ready when database and migrations are healthy (or not configured in dev)', () => {
    const report = buildHealthReport({
      components: [
        component({ key: 'database', criticality: 'required', status: 'not_configured' }),
        component({ key: 'migrations', criticality: 'required', status: 'not_configured' }),
      ],
      now: NOW,
    });
    expect(report.ready).toBe(true);
    expect(report.checkedAt).toBe(NOW.toISOString());
  });

  it('is NOT ready when PostgreSQL is configured but unreachable', () => {
    const report = buildHealthReport({
      components: [
        component({ key: 'database', criticality: 'required', status: 'unavailable' }),
        component({ key: 'migrations', criticality: 'required', status: 'healthy' }),
      ],
      now: NOW,
    });
    expect(report.ready).toBe(false);
  });

  it('is NOT ready on migration drift or pending migrations', () => {
    for (const status of ['blocked', 'degraded'] as const) {
      const report = buildHealthReport({
        components: [
          component({ key: 'database', criticality: 'required', status: 'healthy' }),
          component({ key: 'migrations', criticality: 'required', status }),
        ],
        now: NOW,
      });
      expect(report.ready).toBe(false);
    }
  });

  it('provider/budget blocks never flip `ready` (the pipeline reports them per-slot)', () => {
    const report = buildHealthReport({
      components: [
        component({ key: 'database', criticality: 'required', status: 'healthy' }),
        component({ key: 'migrations', criticality: 'required', status: 'healthy' }),
        component({ key: 'caption_provider', status: 'blocked', code: 'provider_auth_failed' }),
        component({ key: 'budget', status: 'blocked', code: 'budget_exhausted' }),
      ],
      now: NOW,
    });
    expect(report.ready).toBe(true);
    expect(report.overall).toBe('blocked');
    expect(report.blockers).toEqual(['provider_auth_failed', 'budget_exhausted']);
  });
});

describe('evaluateBackend', () => {
  it('reports process facts without exposing configuration secrets', () => {
    const componentResult = evaluateBackend({
      now: NOW,
      uptimeSeconds: 42,
      version: '0.1.0',
      nodeEnv: 'test',
      persistenceBackend: 'memory',
    });
    expect(componentResult.status).toBe('healthy');
    expect(componentResult.data.uptimeSeconds).toBe(42);
    expect(JSON.stringify(componentResult)).not.toMatch(/secret|token/i);
  });
});
