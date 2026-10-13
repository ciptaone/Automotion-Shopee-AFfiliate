/**
 * PART 8 §2 — operational health model (PURE: no I/O, no provider calls).
 *
 * Every evaluator takes plain, already-collected inputs and returns a
 * `HealthComponent`. `collectHealth()` in ops-service.ts is the only place that
 * performs real round-trips; the HTTP layer and the tests use these pure
 * functions, so status semantics can never drift between surfaces.
 *
 * Rules honoured here:
 *  - "Configured" is NOT "healthy": a provider is healthy only when its cached
 *    capability probe says `ready`; never tested → `not_tested`.
 *  - Status vocabulary (locked): healthy | degraded | blocked | unavailable |
 *    not_configured | not_tested | disabled.
 *  - Messages are sanitized, single-line and actionable. Components never carry
 *    credentials, tokens, prompts, product data or raw provider bodies.
 */
import type { MigrationStatusReport } from '../db/migration-status.js';
import type { QueueStats } from '../contracts/index.js';
import type { BudgetStatus } from '../usage/usage-service.js';
import type { ProviderView } from '../providers/provider-service.js';

/* -------------------------------------------------------------------------- */
/*  Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

export const HEALTH_STATUSES = [
  'healthy',
  'degraded',
  'blocked',
  'unavailable',
  'not_configured',
  'not_tested',
  'disabled',
] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** Aggregation order: worst score wins. Informational states score lowest. */
const STATUS_SEVERITY: Readonly<Record<HealthStatus, number>> = {
  healthy: 0,
  disabled: 1,
  not_configured: 2,
  not_tested: 3,
  degraded: 4,
  unavailable: 5,
  blocked: 6,
};

/** Criticality classes drive the overall roll-up (§2). */
export type ComponentCriticality = 'required' | 'operational' | 'optional';

export interface HealthComponent {
  /** Stable, low-cardinality identifier (safe as a metric label). */
  readonly key: string;
  readonly displayName: string;
  readonly status: HealthStatus;
  /** Machine-readable reason code (stable across releases). */
  readonly code: string;
  /** Sanitized, single-line, actionable explanation. Never a secret. */
  readonly message: string;
  readonly criticality: ComponentCriticality;
  /** Non-sensitive structured context: counts, booleans, enums, timestamps. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly checkedAt: string;
}

export interface OpsHealthReport {
  /** Worst status across required + operational components (+ optional when degraded+). */
  readonly overall: HealthStatus;
  /**
   * True when nothing prevents the service from accepting generation jobs:
   * PostgreSQL reachable (when configured) and migrations consistent.
   * Provider/budget blocks surface per component and in the pipeline's own
   * explicit blocked reasons — they never silently accept fabricated success.
   */
  readonly ready: boolean;
  /** Codes of every component currently preventing generation (secret-free). */
  readonly blockers: readonly string[];
  readonly components: readonly HealthComponent[];
  readonly checkedAt: string;
}

export function worstStatus(statuses: readonly HealthStatus[]): HealthStatus {
  let worst: HealthStatus = 'healthy';
  for (const status of statuses) {
    if (STATUS_SEVERITY[status] > STATUS_SEVERITY[worst]) worst = status;
  }
  return worst;
}

/* -------------------------------------------------------------------------- */
/*  Individual evaluators (pure)                                               */
/* -------------------------------------------------------------------------- */

function component(input: {
  key: string;
  displayName: string;
  status: HealthStatus;
  code: string;
  message: string;
  criticality: ComponentCriticality;
  data?: Readonly<Record<string, unknown>>;
  now: Date;
}): HealthComponent {
  return {
    key: input.key,
    displayName: input.displayName,
    status: input.status,
    code: input.code,
    message: input.message,
    criticality: input.criticality,
    data: input.data ?? {},
    checkedAt: input.now.toISOString(),
  };
}

/** Backend process itself — the server answering this request. */
export function evaluateBackend(input: {
  now: Date;
  uptimeSeconds: number;
  version: string;
  nodeEnv: string;
  persistenceBackend: string;
}): HealthComponent {
  return component({
    key: 'backend',
    displayName: 'Backend process',
    status: 'healthy',
    code: 'ok',
    message: `Process running for ${input.uptimeSeconds}s (${input.persistenceBackend} persistence).`,
    criticality: 'required',
    data: {
      version: input.version,
      nodeEnv: input.nodeEnv,
      uptimeSeconds: input.uptimeSeconds,
      persistenceBackend: input.persistenceBackend,
    },
    now: input.now,
  });
}

/**
 * PostgreSQL connectivity. `not_configured` when running in-memory (a valid
 * development mode); `unavailable` when configured but unreachable — that
 * blocks generation jobs because durable slot identity, leases and the daily
 * cap all live in the database.
 */
export function evaluateDatabase(input: {
  now: Date;
  configured: boolean;
  healthy: boolean;
  detail: string;
}): HealthComponent {
  if (!input.configured) {
    return component({
      key: 'database',
      displayName: 'PostgreSQL',
      status: 'not_configured',
      code: 'database_not_configured',
      message: 'DATABASE_URL is not set — running in in-memory mode (development only).',
      criticality: 'required',
      data: { configured: false, mode: 'in_memory' },
      now: input.now,
    });
  }
  if (!input.healthy) {
    return component({
      key: 'database',
      displayName: 'PostgreSQL',
      status: 'unavailable',
      code: 'database_unreachable',
      message:
        'DATABASE_URL is set but the connection failed. Durable slots, job leases and the daily cap need PostgreSQL — generation jobs are not accepted until it is reachable.',
      criticality: 'required',
      data: { configured: true, reachable: false, detail: input.detail },
      now: input.now,
    });
  }
  return component({
    key: 'database',
    displayName: 'PostgreSQL',
    status: 'healthy',
    code: 'ok',
    message: 'PostgreSQL reachable (round-trip succeeded).',
    criticality: 'required',
    data: { configured: true, reachable: true },
    now: input.now,
  });
}

/** Migration/schema consistency. Drift (`diverged`, unknown rows) is unsafe. */
export function evaluateMigrations(input: {
  now: Date;
  configured: boolean;
  report: MigrationStatusReport | null;
}): HealthComponent {
  if (!input.configured) {
    return component({
      key: 'migrations',
      displayName: 'Migrations',
      status: 'not_configured',
      code: 'migrations_not_configured',
      message: 'No database configured — migration state is not applicable.',
      criticality: 'required',
      data: { applicable: false },
      now: input.now,
    });
  }
  const report = input.report;
  if (!report) {
    return component({
      key: 'migrations',
      displayName: 'Migrations',
      status: 'not_tested',
      code: 'migrations_status_unknown',
      message: 'Migration status could not be read. Run `npm run db:status` to diagnose.',
      criticality: 'required',
      data: { readable: false },
      now: input.now,
    });
  }
  const drift = report.divergedCount > 0 || report.unknownApplied.length > 0 || !report.tablePresent;
  const data = {
    applicable: true,
    journalEntries: report.journalEntries,
    appliedCount: report.appliedCount,
    pendingCount: report.pendingCount,
    divergedCount: report.divergedCount,
    tablePresent: report.tablePresent,
    consistent: report.consistent,
  };
  if (drift) {
    return component({
      key: 'migrations',
      displayName: 'Migrations',
      status: 'blocked',
      code: 'migration_drift',
      message:
        'Applied migrations do not match the files on disk (diverged or unknown entries). Running against an unexpected schema is unsafe — restore the migration files or repair the journal before accepting work.',
      criticality: 'required',
      data,
      now: input.now,
    });
  }
  if (report.pendingCount > 0) {
    return component({
      key: 'migrations',
      displayName: 'Migrations',
      status: 'degraded',
      code: 'migration_pending',
      message: `${report.pendingCount} migration(s) are pending. Run \`npm run db:migrate\` to bring the schema up to date.`,
      criticality: 'required',
      data,
      now: input.now,
    });
  }
  return component({
    key: 'migrations',
    displayName: 'Migrations',
    status: 'healthy',
    code: 'ok',
    message: `All ${report.appliedCount} migration(s) applied; schema matches the journal.`,
    criticality: 'required',
    data,
    now: input.now,
  });
}

/** Scheduler loop, cadence and tick freshness (Jakarta calendar day). */
export function evaluateScheduler(input: {
  now: Date;
  loopEnabled: boolean;
  mode: string;
  automationState: string;
  tickIntervalMs: number;
  lastTickAt: string | null;
  lastTickFailedJobs: number | null;
  dailyPostTarget: number;
  slotsToday: number;
  nextSlotAt: string | null;
  timezone: string;
}): HealthComponent {
  const data = {
    loopEnabled: input.loopEnabled,
    mode: input.mode,
    automationState: input.automationState,
    tickIntervalMs: input.tickIntervalMs,
    lastTickAt: input.lastTickAt,
    dailyPostTarget: input.dailyPostTarget,
    slotsToday: input.slotsToday,
    nextSlotAt: input.nextSlotAt,
    timezone: input.timezone,
  };

  if (!input.loopEnabled) {
    return component({
      key: 'scheduler',
      displayName: 'Scheduler',
      status: 'disabled',
      code: 'scheduler_disabled',
      message:
        input.automationState === 'running'
          ? 'The scheduler loop is not running while automation claims to be running — no jobs will be dispatched. Enable it with SCHEDULER_ENABLED=true.'
          : 'The scheduler loop is disabled (SCHEDULER_ENABLED is not "true").',
      criticality: 'operational',
      data,
      now: input.now,
    });
  }
  if (input.automationState !== 'running') {
    return component({
      key: 'scheduler',
      displayName: 'Scheduler',
      status: 'disabled',
      code: 'automation_paused',
      message: `Automation is paused (state "${input.automationState}") — the loop runs but dispatches no jobs.`,
      criticality: 'operational',
      data,
      now: input.now,
    });
  }
  if (input.lastTickAt === null) {
    return component({
      key: 'scheduler',
      displayName: 'Scheduler',
      status: 'not_tested',
      code: 'scheduler_no_tick_yet',
      message: `Loop enabled but no tick has completed yet (cadence ${Math.round(input.tickIntervalMs / 1000)}s).`,
      criticality: 'operational',
      data,
      now: input.now,
    });
  }

  // Stale when no tick completed for 3 cadences (floor 5 minutes).
  const staleAfterMs = Math.max(3 * input.tickIntervalMs, 5 * 60_000);
  const ageMs = input.now.getTime() - Date.parse(input.lastTickAt);
  if (ageMs > staleAfterMs) {
    return component({
      key: 'scheduler',
      displayName: 'Scheduler',
      status: 'degraded',
      code: 'scheduler_stale',
      message: `Last successful tick was ${Math.round(ageMs / 60_000)} minute(s) ago (expected every ${Math.round(input.tickIntervalMs / 1000)}s). The loop may be stuck or the process was suspended.`,
      criticality: 'operational',
      data,
      now: input.now,
    });
  }

  const failedNote =
    input.lastTickFailedJobs !== null && input.lastTickFailedJobs > 0
      ? ` Last tick: ${input.lastTickFailedJobs} job(s) failed (being retried).`
      : '';
  return component({
    key: 'scheduler',
    displayName: 'Scheduler',
    status: 'healthy',
    code: 'ok',
    message: `Ticking every ${Math.round(input.tickIntervalMs / 1000)}s; next slot ${input.nextSlotAt ?? 'unknown'} (${input.slotsToday}/${input.dailyPostTarget} used today, ${input.timezone}).${failedNote}`,
    criticality: 'operational',
    data,
    now: input.now,
  });
}

/**
 * Queue and worker health: backlog age and expired leases are the two signals
 * that indicate workers are stuck or crashed. Terminal job failures are job
 * OUTCOMES (reported via recent errors and ops events), not queue health.
 */
export function evaluateQueue(input: {
  now: Date;
  stats: QueueStats | null;
  persistence: string;
  backlogWarnMs?: number;
}): HealthComponent {
  const backlogWarnMs = input.backlogWarnMs ?? 15 * 60_000; // >= max retry backoff
  if (!input.stats) {
    return component({
      key: 'queue',
      displayName: 'Job queue',
      status: 'not_tested',
      code: 'queue_stats_unavailable',
      message: 'Queue statistics are not available from this queue implementation.',
      criticality: 'operational',
      data: { persistence: input.persistence },
      now: input.now,
    });
  }
  const stats = input.stats;
  const data = {
    persistence: input.persistence,
    pending: stats.pending,
    running: stats.running,
    succeeded: stats.succeeded,
    failed: stats.failed,
    cancelled: stats.cancelled,
    retrying: stats.retrying,
    oldestPendingAt: stats.oldestPendingAt,
    oldestPendingAgeMs: stats.oldestPendingAgeMs,
    expiredLeases: stats.expiredLeases,
  };

  if (stats.expiredLeases > 0) {
    return component({
      key: 'queue',
      displayName: 'Job queue',
      status: 'degraded',
      code: 'queue_expired_leases',
      message: `${stats.expiredLeases} running job(s) hold an expired lease (crashed worker). They will be recovered on the next claim or restart.`,
      criticality: 'operational',
      data,
      now: input.now,
    });
  }
  if (stats.oldestPendingAgeMs !== null && stats.oldestPendingAgeMs > backlogWarnMs) {
    return component({
      key: 'queue',
      displayName: 'Job queue',
      status: 'degraded',
      code: 'queue_backlog',
      message: `Oldest queued job has waited ${Math.round(stats.oldestPendingAgeMs / 60_000)} minute(s) — longer than the maximum retry backoff. Check worker throughput and the daily cap.`,
      criticality: 'operational',
      data,
      now: input.now,
    });
  }
  return component({
    key: 'queue',
    displayName: 'Job queue',
    status: 'healthy',
    code: 'ok',
    message: `${stats.pending} pending, ${stats.running} running, ${stats.succeeded} succeeded, ${stats.failed} failed; no expired leases.`,
    criticality: 'operational',
    data,
    now: input.now,
  });
}

/**
 * Independent text/image provider readiness (§2: text and image readiness are
 * tracked separately and never conflated). Uses ONLY cached probe results —
 * health never triggers a paid API call.
 */
export function evaluateProvider(input: {
  now: Date;
  task: 'caption' | 'image';
  selected: { id: string; name: string } | null;
  view: ProviderView | null;
}): HealthComponent {
  const key = input.task === 'caption' ? 'caption_provider' : 'image_provider';
  const displayName = input.task === 'caption' ? 'Caption provider' : 'Image provider';
  const capability = input.task === 'caption' ? 'text_generation' : 'image_generation';

  if (!input.selected) {
    return component({
      key,
      displayName,
      status: 'not_configured',
      code: 'provider_not_configured',
      message: `No ${input.task === 'caption' ? 'text' : 'image'} provider is selected. Choose one in Settings → AI providers (configuration alone never enables generation).`,
      criticality: 'operational',
      data: { task: input.task, selected: false },
      now: input.now,
    });
  }

  const view = input.view;
  if (!view) {
    return component({
      key,
      displayName,
      status: 'blocked',
      code: 'provider_missing',
      message: `The selected ${input.task} provider "${input.selected.id}" no longer exists in the workspace. Re-select a provider.`,
      criticality: 'operational',
      data: { task: input.task, selected: true, providerId: input.selected.id, found: false },
      now: input.now,
    });
  }

  const data = {
    task: input.task,
    selected: true,
    providerId: view.id,
    providerName: view.name,
    adapterType: view.adapterType,
    enabled: view.enabled,
    secretPresent: view.secret.present,
    keyConfigured: view.secret.keyConfigured,
    capability,
    capabilityDeclared: view.capabilities[capability] ?? false,
    referenceImageDeclared: view.capabilities.image_reference_input ?? false,
  };

  if (!view.enabled) {
    return component({
      key,
      displayName,
      status: 'disabled',
      code: 'provider_disabled',
      message: `Provider "${view.name}" is disabled in the workspace. Enable it or select another provider.`,
      criticality: 'operational',
      data,
      now: input.now,
    });
  }

  const configuration = view.readiness.configuration;
  const authentication = view.readiness.authentication;
  const probe = view.readiness[capability];

  if (configuration && configuration.status === 'configuration_invalid') {
    return component({
      key,
      displayName,
      status: 'blocked',
      code: 'provider_configuration_invalid',
      message: `Provider "${view.name}" failed configuration validation: ${configuration.detail}`,
      criticality: 'operational',
      data,
      now: input.now,
    });
  }
  if (authentication && authentication.status === 'authentication_failed') {
    return component({
      key,
      displayName,
      status: 'blocked',
      code: 'provider_auth_failed',
      message: `Provider "${view.name}" failed authentication in its last test (${authentication.testedAt ?? 'never'}). Update the credential and re-test.`,
      criticality: 'operational',
      data,
      now: input.now,
    });
  }
  if (!probe) {
    return component({
      key,
      displayName,
      status: 'not_tested',
      code: 'provider_not_tested',
      message: `Provider "${view.name}" is configured but its ${capability.replace('_', ' ')} capability has never been tested. Run a connection test in Settings → AI providers.`,
      criticality: 'operational',
      data,
      now: input.now,
    });
  }

  const detailed = { ...data, probeStatus: probe.status, probeTestedAt: probe.testedAt };
  switch (probe.status) {
    case 'ready':
      return component({
        key,
        displayName,
        status: 'healthy',
        code: 'ok',
        message: `Provider "${view.name}" ${capability.replace('_', ' ')} probe is ready (tested ${probe.testedAt ?? 'unknown'}).`,
        criticality: 'operational',
        data: detailed,
        now: input.now,
      });
    case 'capability_unsupported':
      return component({
        key,
        displayName,
        status: 'blocked',
        code: 'provider_capability_unsupported',
        message: `Provider "${view.name}" does not support ${capability.replace('_', ' ')}. Select a provider that declares this capability.`,
        criticality: 'operational',
        data: detailed,
        now: input.now,
      });
    case 'not_configured':
      return component({
        key,
        displayName,
        status: 'not_configured',
        code: 'provider_not_configured',
        message: `Provider "${view.name}" reports ${capability.replace('_', ' ')} as not configured.`,
        criticality: 'operational',
        data: detailed,
        now: input.now,
      });
    case 'test_failed':
      return component({
        key,
        displayName,
        status: 'degraded',
        code: 'provider_test_failed',
        message: `The last ${capability.replace('_', ' ')} test for "${view.name}" failed (${probe.testedAt ?? 'unknown'}): ${probe.detail}`,
        criticality: 'operational',
        data: detailed,
        now: input.now,
      });
    case 'temporarily_unavailable':
    case 'rate_limited':
      return component({
        key,
        displayName,
        status: 'degraded',
        code: 'provider_degraded',
        message: `Provider "${view.name}" reported ${probe.status} in its last test (${probe.testedAt ?? 'unknown'}). Bounded retries apply; no automatic switching occurs.`,
        criticality: 'operational',
        data: detailed,
        now: input.now,
      });
    default:
      // configuration_invalid / authentication_failed surfaces on the capability
      // probe itself — treat as blocked with the probe's own sanitized detail.
      return component({
        key,
        displayName,
        status: 'blocked',
        code: `provider_${probe.status}`,
        message: `Provider "${view.name}" is not usable for ${capability.replace('_', ' ')}: ${probe.detail}`,
        criticality: 'operational',
        data: detailed,
        now: input.now,
      });
  }
}

/** Asset storage: kind + whether public URLs are expected to resolve. */
export function evaluateAssetStorage(input: {
  now: Date;
  kind: string;
  infoReady: boolean;
  infoDetail: string;
}): HealthComponent {
  const data = { kind: input.kind, ready: input.infoReady };
  if (input.kind === 'mock') {
    return component({
      key: 'asset_storage',
      displayName: 'Asset storage',
      status: 'not_configured',
      code: 'storage_mock',
      message:
        'Assets are kept in in-memory mock storage — they vanish on restart and public URLs are placeholders. Configure durable storage before real publishing.',
      criticality: 'operational',
      data,
      now: input.now,
    });
  }
  if (!input.infoReady) {
    return component({
      key: 'asset_storage',
      displayName: 'Asset storage',
      status: 'degraded',
      code: 'storage_not_ready',
      message: `Asset storage reported not ready: ${input.infoDetail}`,
      criticality: 'operational',
      data,
      now: input.now,
    });
  }
  return component({
    key: 'asset_storage',
    displayName: 'Asset storage',
    status: 'healthy',
    code: 'ok',
    message: `Asset storage ready (${input.kind}).`,
    criticality: 'operational',
    data,
    now: input.now,
  });
}

/** Telegram notification readiness — an OPTIONAL service (never blocks jobs). */
export function evaluateTelegram(input: {
  now: Date;
  enabled: boolean;
  configured: boolean;
  lastDeliveryStatus: string | null;
  lastDeliveryAt: string | null;
}): HealthComponent {
  const data = {
    enabled: input.enabled,
    configured: input.configured,
    lastDeliveryStatus: input.lastDeliveryStatus,
    lastDeliveryAt: input.lastDeliveryAt,
  };
  if (!input.enabled) {
    return component({
      key: 'telegram',
      displayName: 'Telegram notifications',
      status: 'disabled',
      code: 'telegram_disabled',
      message: 'Telegram notifications are switched off. Enable them in Settings → Operations.',
      criticality: 'optional',
      data,
      now: input.now,
    });
  }
  if (!input.configured) {
    return component({
      key: 'telegram',
      displayName: 'Telegram notifications',
      status: 'not_configured',
      code: 'telegram_not_configured',
      message:
        'Notifications are enabled but no bot token/chat id is stored. Save the secret in Settings → Operations (stored encrypted, backend-only).',
      criticality: 'optional',
      data,
      now: input.now,
    });
  }
  if (input.lastDeliveryStatus === 'failed') {
    return component({
      key: 'telegram',
      displayName: 'Telegram notifications',
      status: 'degraded',
      code: 'telegram_delivery_failed',
      message: `The last notification delivery failed (${input.lastDeliveryAt ?? 'unknown time'}). Events are still recorded durably in ops_events.`,
      criticality: 'optional',
      data,
      now: input.now,
    });
  }
  return component({
    key: 'telegram',
    displayName: 'Telegram notifications',
    status: 'healthy',
    code: 'ok',
    message: 'Bot token stored and notifications enabled. Delivery is confirmed by Telegram before anything is recorded as sent.',
    criticality: 'optional',
    data,
    now: input.now,
  });
}

/**
 * Budget status from the usage ledger. Exhausted budgets BLOCK generation
 * (asserted before every request); reaching the warning threshold degrades.
 */
export function evaluateBudget(input: {
  now: Date;
  budget: BudgetStatus | null;
  warnRatio?: number;
}): HealthComponent {
  const warnRatio = input.warnRatio ?? 0.9;
  if (!input.budget) {
    return component({
      key: 'budget',
      displayName: 'Budget',
      status: 'not_tested',
      code: 'budget_status_unavailable',
      message: 'Budget status could not be read from the usage ledger.',
      criticality: 'operational',
      data: {},
      now: input.now,
    });
  }
  const budget = input.budget;
  const data = {
    dailyBudgetUsd: budget.dailyBudgetUsd,
    monthlyBudgetUsd: budget.monthlyBudgetUsd,
    daySpentUsd: budget.day.spentUsd,
    monthSpentUsd: budget.month.spentUsd,
    dayExhausted: budget.day.exhausted,
    monthExhausted: budget.month.exhausted,
  };
  if (budget.day.exhausted || budget.month.exhausted) {
    const which = budget.day.exhausted ? 'daily' : 'monthly';
    return component({
      key: 'budget',
      displayName: 'Budget',
      status: 'blocked',
      code: 'budget_exhausted',
      message: `The ${which} budget is exhausted — new generation requests are refused until the window rolls over.`,
      criticality: 'operational',
      data,
      now: input.now,
    });
  }
  const ratio = (spent: number, cap: number | null): number =>
    cap !== null && cap > 0 ? spent / cap : 0;
  const dayRatio = ratio(budget.day.spentUsd, budget.day.budgetUsd);
  const monthRatio = ratio(budget.month.spentUsd, budget.month.budgetUsd);
  if (dayRatio >= warnRatio || monthRatio >= warnRatio) {
    return component({
      key: 'budget',
      displayName: 'Budget',
      status: 'degraded',
      code: 'budget_threshold',
      message: `Spending has reached ${Math.round(Math.max(dayRatio, monthRatio) * 100)}% of the configured ${dayRatio >= monthRatio ? 'daily' : 'monthly'} budget.`,
      criticality: 'operational',
      data,
      now: input.now,
    });
  }
  if (budget.dailyBudgetUsd === null && budget.monthlyBudgetUsd === null) {
    return component({
      key: 'budget',
      displayName: 'Budget',
      status: 'healthy',
      code: 'budget_not_configured',
      message: 'No budget configured — generation is unbounded (development default).',
      criticality: 'operational',
      data,
      now: input.now,
    });
  }
  return component({
    key: 'budget',
    displayName: 'Budget',
    status: 'healthy',
    code: 'ok',
    message: `Daily $${budget.day.spentUsd.toFixed(2)}/$${budget.day.budgetUsd ?? '∞'}, monthly $${budget.month.spentUsd.toFixed(2)}/$${budget.month.budgetUsd ?? '∞'}.`,
    criticality: 'operational',
    data,
    now: input.now,
  });
}

/**
 * Publishing gate. Live Facebook/Threads publishing is DISABLED BY DESIGN for
 * the whole PART 1-8 arc; this component exists so the dashboard states that
 * explicitly instead of leaving it implied. `disabled` is the expected state
 * and never degrades the overall roll-up.
 */
export function evaluatePublishingGate(input: { now: Date }): HealthComponent {
  return component({
    key: 'publishing_gate',
    displayName: 'Live publishing',
    status: 'disabled',
    code: 'publishing_disabled',
    message:
      'Live Facebook/Threads publishing is disabled by design. The pipeline stops at publish_ready; nothing is ever posted to a social network.',
    criticality: 'optional',
    data: { facebook: 'disabled', threads: 'disabled', pipelineTerminalStage: 'publish_ready' },
    now: input.now,
  });
}

/* -------------------------------------------------------------------------- */
/*  Aggregation                                                                */
/* -------------------------------------------------------------------------- */

export function aggregateOverall(
  components: readonly HealthComponent[],
): { overall: HealthStatus; blockers: string[] } {
  let overall: HealthStatus = 'healthy';
  const blockers: string[] = [];

  for (const entry of components) {
    const relevant =
      entry.criticality === 'optional'
        ? // Optional components only drag the roll-up down when actually broken;
          // `disabled`/`not_configured`/`not_tested` are expected for them.
          ['degraded', 'blocked', 'unavailable'].includes(entry.status)
        : true;
    if (relevant && STATUS_SEVERITY[entry.status] > STATUS_SEVERITY[overall]) {
      overall = entry.status;
    }
    if (entry.status === 'blocked' || entry.status === 'unavailable') {
      blockers.push(entry.code);
    }
  }
  return { overall, blockers };
}

/** Assemble the final report from evaluated components. */
export function buildHealthReport(input: {
  components: readonly HealthComponent[];
  now: Date;
}): OpsHealthReport {
  const { overall, blockers } = aggregateOverall(input.components);
  // Readiness (§3): the service may accept generation jobs only when the
  // database (when configured) is reachable AND the schema matches. Everything
  // else reports per-component status and the pipeline's explicit blocked
  // reasons — it never fabricates success and never switches to mock silently.
  const database = input.components.find((c) => c.key === 'database');
  const migrations = input.components.find((c) => c.key === 'migrations');
  const ready =
    (database?.status === 'healthy' || database?.status === 'not_configured') &&
    (migrations?.status === 'healthy' || migrations?.status === 'not_configured');
  return {
    overall,
    ready,
    blockers,
    components: input.components,
    checkedAt: input.now.toISOString(),
  };
}
