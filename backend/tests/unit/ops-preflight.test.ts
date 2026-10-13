/**
 * PART 8 §8 — preflight evaluation (pure).
 *
 * Locks the blocker/warning boundary: what prevents intended operation vs what
 * is merely recommended. Optional services (Telegram, budgets) can only ever
 * produce warnings in development; production-mode integrity issues escalate
 * to blockers. The preflight is evaluated from inputs — it changes nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluatePreflight,
  preflightImageReferenceDeclared,
  type PreflightInput,
} from '../../src/ops/preflight.js';
import {
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
  type HealthComponent,
} from '../../src/ops/component-health.js';
import type { MigrationStatusReport } from '../../src/db/migration-status.js';
import type { ProviderView } from '../../src/providers/provider-service.js';

const NOW = new Date('2026-10-13T10:00:00.000Z');

const RUNNING_SETTINGS = {
  intervalMinutes: 60,
  maxSlotsPerDay: 4,
  facebookEnabled: true,
  threadsEnabled: true,
  imageCountPolicy: 'random_1_or_2',
  telegramNotificationsEnabled: true,
  notificationMinSeverity: 'warning',
  notificationEventKinds: [],
  automationState: 'running',
  selectionMode: 'all_active',
  selectedCategoryIds: [],
  dailyPostTarget: 4,
  dailyBudgetUsd: null,
  monthlyBudgetUsd: null,
} as unknown as PreflightInput['settings'];

function migrationReport(overrides: Partial<MigrationStatusReport> = {}): MigrationStatusReport {
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

function readyProviderView(overrides: Partial<ProviderView> = {}): ProviderView {
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
      image_generation: true,
      image_reference_input: true,
      image_editing: false,
      structured_output: true,
    },
    supportedTasks: ['caption', 'image'],
    secret: { present: true, keyConfigured: true } as ProviderView['secret'],
    readiness: {
      configuration: { status: 'ready', detail: 'ok', testedAt: NOW.toISOString() },
      authentication: { status: 'ready', detail: 'ok', testedAt: NOW.toISOString() },
      text_generation: { status: 'ready', detail: 'ok', testedAt: NOW.toISOString() },
      image_generation: { status: 'ready', detail: 'ok', testedAt: NOW.toISOString() },
    } as ProviderView['readiness'],
    selectedFor: ['caption', 'image'],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  } as ProviderView;
}

/** Builds a full health report from the REAL evaluators with given overrides. */
function healthReport(options: {
  dbConfigured?: boolean;
  dbHealthy?: boolean;
  migration?: MigrationStatusReport | null;
  scheduler?: Partial<Parameters<typeof evaluateScheduler>[0]>;
  captionView?: ProviderView | null;
  imageView?: ProviderView | null;
  storageKind?: string;
  telegramEnabled?: boolean;
  telegramConfigured?: boolean;
  budget?: unknown;
  automationState?: string;
}) {
  const dbConfigured = options.dbConfigured ?? true;
  const automationState = options.automationState ?? 'running';
  const captionView = options.captionView === undefined ? readyProviderView() : options.captionView;
  const imageView =
    options.imageView === undefined
      ? readyProviderView({ selectedFor: ['image'] })
      : options.imageView;

  const components: HealthComponent[] = [
    evaluateBackend({ now: NOW, uptimeSeconds: 1, version: '0.1.0', nodeEnv: 'production', persistenceBackend: 'postgres' }),
    evaluateDatabase({ now: NOW, configured: dbConfigured, healthy: options.dbHealthy ?? true, detail: '' }),
    evaluateMigrations({
      now: NOW,
      configured: dbConfigured,
      report: options.migration === undefined ? migrationReport() : options.migration,
    }),
    evaluateScheduler({
      now: NOW,
      loopEnabled: true,
      mode: 'mock',
      automationState,
      tickIntervalMs: 60_000,
      lastTickAt: NOW.toISOString(),
      lastTickFailedJobs: 0,
      dailyPostTarget: 4,
      slotsToday: 1,
      nextSlotAt: NOW.toISOString(),
      timezone: 'Asia/Jakarta',
      ...options.scheduler,
    }),
    evaluateQueue({ now: NOW, stats: null, persistence: 'memory' }),
    evaluateProvider({
      now: NOW,
      task: 'caption',
      selected: captionView ? { id: captionView.id, name: captionView.name } : null,
      view: captionView,
    }),
    evaluateProvider({
      now: NOW,
      task: 'image',
      selected: imageView ? { id: imageView.id, name: imageView.name } : null,
      view: imageView,
    }),
    evaluateAssetStorage({
      now: NOW,
      kind: options.storageKind ?? 's3',
      infoReady: true,
      infoDetail: 'ok',
    }),
    evaluateTelegram({
      now: NOW,
      enabled: options.telegramEnabled ?? true,
      configured: options.telegramConfigured ?? true,
      lastDeliveryStatus: null,
      lastDeliveryAt: null,
    }),
    evaluateBudget({
      now: NOW,
      budget: (options.budget ?? {
        dailyBudgetUsd: 5,
        monthlyBudgetUsd: null,
        day: { spentUsd: 1, budgetUsd: 5, exhausted: false },
        month: { spentUsd: 1, budgetUsd: null, exhausted: false },
      }) as never,
    }),
    evaluatePublishingGate({ now: NOW }),
  ];
  return buildHealthReport({ components, now: NOW });
}

function input(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    health: healthReport({}),
    settings: RUNNING_SETTINGS,
    nodeEnv: 'production',
    persistenceBackend: 'postgres',
    secretsKeyConfigured: true,
    envImageProvider: 'openai',
    envCaptionProvider: 'openai',
    timezone: 'Asia/Jakarta',
    postingWindowsCount: 4,
    allowedWindowsCount: 4,
    imageReferenceDeclared: true,
    now: NOW,
    ...overrides,
  };
}

function statusOf(report: ReturnType<typeof evaluatePreflight>, id: string): string {
  const all = [...report.blockers, ...report.warnings, ...report.passed];
  return all.find((check) => check.id === id)?.status ?? 'missing';
}

/* ========================================================================== */

describe('evaluatePreflight', () => {
  it('a fully ready production configuration passes with zero blockers and warnings', () => {
    const report = evaluatePreflight(input());
    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(statusOf(report, 'publishing_gate')).toBe('pass');
    expect(statusOf(report, 'windows')).toBe('pass');
    expect(statusOf(report, 'daily_target')).toBe('pass');
  });

  it('database unreachable is always a blocker; unconfigured is dev-warning/prod-blocker', () => {
    expect(statusOf(evaluatePreflight(input({ health: healthReport({ dbConfigured: true, dbHealthy: false }) })), 'database')).toBe('blocker');

    const devUnconfigured = evaluatePreflight(
      input({ nodeEnv: 'development', persistenceBackend: 'file', health: healthReport({ dbConfigured: false }) }),
    );
    expect(statusOf(devUnconfigured, 'database')).toBe('warning');
    expect(devUnconfigured.ok).toBe(true);

    expect(statusOf(evaluatePreflight(input({ health: healthReport({ dbConfigured: false }) })), 'database')).toBe('blocker');
  });

  it('migration drift and pending migrations are blockers (schema must match the code)', () => {
    expect(
      statusOf(
        evaluatePreflight(input({ health: healthReport({ migration: migrationReport({ consistent: false, divergedCount: 1 }) }) })),
        'migrations',
      ),
    ).toBe('blocker');
    expect(
      statusOf(
        evaluatePreflight(input({ health: healthReport({ migration: migrationReport({ consistent: false, pendingCount: 1 }) }) })),
        'migrations',
      ),
    ).toBe('blocker');
  });

  it('scheduler disabled while automation claims to be running is a blocker; paused is a warning', () => {
    expect(
      statusOf(evaluatePreflight(input({ health: healthReport({ scheduler: { loopEnabled: false } }) })), 'scheduler'),
    ).toBe('blocker');

    const paused = evaluatePreflight(
      input({
        settings: { ...RUNNING_SETTINGS, automationState: 'paused' },
        health: healthReport({ automationState: 'paused', scheduler: { loopEnabled: false } }),
      }),
    );
    expect(statusOf(paused, 'scheduler')).toBe('warning');
    expect(paused.ok).toBe(true);
  });

  it('providers not configured/tested block a RUNNING system but only warn when paused', () => {
    const notTested = readyProviderView({ readiness: {} } as Partial<ProviderView>);
    const running = evaluatePreflight(input({ health: healthReport({ captionView: notTested }) }));
    expect(statusOf(running, 'caption_provider')).toBe('blocker');
    expect(running.ok).toBe(false);

    const paused = evaluatePreflight(
      input({
        settings: { ...RUNNING_SETTINGS, automationState: 'paused' },
        health: healthReport({ automationState: 'paused', captionView: notTested }),
      }),
    );
    expect(statusOf(paused, 'caption_provider')).toBe('warning');
    expect(paused.ok).toBe(true);
  });

  it('image-reference support is only a warning (documented fidelity limitation)', () => {
    const report = evaluatePreflight(input({ imageReferenceDeclared: false }));
    expect(statusOf(report, 'image_reference')).toBe('warning');
    expect(report.ok).toBe(true);

    const unknown = evaluatePreflight(input({ imageReferenceDeclared: null }));
    expect(statusOf(unknown, 'image_reference')).toBe('warning');
  });

  it('mock asset storage blocks production but only warns in development', () => {
    expect(
      statusOf(
        evaluatePreflight(input({ health: healthReport({ storageKind: 'mock' }) })),
        'asset_storage',
      ),
    ).toBe('blocker');
    expect(
      statusOf(
        evaluatePreflight(input({ nodeEnv: 'development', persistenceBackend: 'memory', health: healthReport({ dbConfigured: false, storageKind: 'mock' }) })),
        'asset_storage',
      ),
    ).toBe('warning');
  });

  it('an exhausted budget blocks; the warning threshold and unbounded prod only warn', () => {
    expect(
      statusOf(
        evaluatePreflight(
          input({
            health: healthReport({
              budget: {
                dailyBudgetUsd: 5,
                monthlyBudgetUsd: null,
                day: { spentUsd: 5, budgetUsd: 5, exhausted: true },
                month: { spentUsd: 5, budgetUsd: null, exhausted: false },
              },
            }),
          }),
        ),
        'budget',
      ),
    ).toBe('blocker');

    const unboundedProd = evaluatePreflight(
      input({
        health: healthReport({
          budget: {
            dailyBudgetUsd: null,
            monthlyBudgetUsd: null,
            day: { spentUsd: 0, budgetUsd: null, exhausted: false },
            month: { spentUsd: 0, budgetUsd: null, exhausted: false },
          },
        }),
      }),
    );
    expect(statusOf(unboundedProd, 'budget')).toBe('warning');
    expect(unboundedProd.ok).toBe(true);
  });

  it('Telegram problems are warnings only — an optional service never blocks', () => {
    const notConfigured = evaluatePreflight(
      input({ health: healthReport({ telegramConfigured: false }) }),
    );
    expect(statusOf(notConfigured, 'telegram')).toBe('warning');
    expect(notConfigured.ok).toBe(true);

    const disabled = evaluatePreflight(
      input({
        settings: { ...RUNNING_SETTINGS, telegramNotificationsEnabled: false },
        health: healthReport({ telegramEnabled: false }),
      }),
    );
    expect(statusOf(disabled, 'telegram')).toBe('pass');
  });

  it('the publishing gate is always reported as pass (disabled-by-design is the goal)', () => {
    expect(statusOf(evaluatePreflight(input()), 'publishing_gate')).toBe('pass');
  });

  it('production-mode integrity: non-postgres persistence, missing secrets key, silent mock defaults', () => {
    expect(statusOf(evaluatePreflight(input({ persistenceBackend: 'file' })), 'production_persistence')).toBe('blocker');
    expect(statusOf(evaluatePreflight(input({ secretsKeyConfigured: false })), 'secrets_key')).toBe('blocker');
    expect(
      statusOf(evaluatePreflight(input({ envImageProvider: 'mock', envCaptionProvider: 'mock' })), 'production_producers'),
    ).toBe('blocker');
    // Mock defaults without a running automation only warn.
    const paused = evaluatePreflight(
      input({
        settings: { ...RUNNING_SETTINGS, automationState: 'paused' },
        envImageProvider: 'mock',
        envCaptionProvider: 'mock',
        health: healthReport({ automationState: 'paused' }),
      }),
    );
    expect(statusOf(paused, 'production_producers')).toBe('warning');
  });

  it('posting target outside 3..4 and wrong window counts are blockers', () => {
    const badTarget = evaluatePreflight(
      input({ settings: { ...RUNNING_SETTINGS, dailyPostTarget: 2 } }),
    );
    expect(statusOf(badTarget, 'daily_target')).toBe('blocker');

    const badWindows = evaluatePreflight(input({ postingWindowsCount: 3 }));
    expect(statusOf(badWindows, 'windows')).toBe('blocker');
  });

  it('a non-Jakarta timezone is a warning (product decision locks Asia/Jakarta)', () => {
    const report = evaluatePreflight(input({ timezone: 'UTC' }));
    expect(statusOf(report, 'timezone')).toBe('warning');
    expect(report.ok).toBe(true);
  });

  it('ok is true when only warnings exist and false only with blockers', () => {
    expect(evaluatePreflight(input({ timezone: 'UTC' })).ok).toBe(true);
    expect(evaluatePreflight(input({ secretsKeyConfigured: false })).ok).toBe(false);
  });

  it('reports the node env and generation timestamp', () => {
    const report = evaluatePreflight(input());
    expect(report.nodeEnv).toBe('production');
    expect(report.generatedAt).toBe(NOW.toISOString());
  });
});

describe('preflightImageReferenceDeclared', () => {
  it('reads the boolean from the image provider component data when present', () => {
    const report = healthReport({});
    // The built report's image provider carries referenceImageDeclared data.
    expect(typeof preflightImageReferenceDeclared(report)).toBe('boolean');
  });

  it('returns null when no image provider component exists', () => {
    expect(preflightImageReferenceDeclared({ components: [] } as never)).toBeNull();
  });
});
