/**
 * PART 8 §2-§4 — live health/metrics aggregation.
 *
 * This is the ONLY place that performs real round-trips for operational
 * diagnostics. It reads the existing surfaces (database, migrations, scheduler,
 * queue, providers, storage, usage ledger, secrets, ops events) and feeds the
 * PURE evaluators in component-health.ts. It never calls a paid AI API, never
 * mutates state, and never invents status: every component reflects what is
 * configured, reachable, authenticated or capability-tested right now.
 */
import type { JobQueue, ObjectStorage, QueueStats } from '../contracts/index.js';
import type { DatabaseHandle } from '../db/client.js';
import type { MigrationStatusReport } from '../db/migration-status.js';
import type { Logger } from '../core/logger.js';
import type { SchedulerStatus } from '../scheduler/slots.js';
import type { TickResult } from '../scheduler/content-scheduler.js';
import type { AutomationSettings } from '../settings/automation-settings.js';
import type { SecretStore } from '../secrets/secret-store.js';
import type { ProviderService, ProviderView } from '../providers/provider-service.js';
import type { BudgetStatus, UsageService } from '../usage/usage-service.js';
import type { UsageRecord } from '../usage/usage-store.js';
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
  type OpsHealthReport,
} from './component-health.js';
import type { StoredOpsEvent } from './ops-events.js';

/** Reserved SecretStore ids for the Telegram credential (PART 8 §6). */
export const TELEGRAM_SECRET_BOT_TOKEN = 'telegram_bot_token';
export const TELEGRAM_SECRET_CHAT_ID = 'telegram_chat_id';

export interface OpsServiceDeps {
  readonly env: {
    readonly NODE_ENV: string;
    readonly SCHEDULER_ENABLED: string;
    readonly SCHEDULER_MODE: string;
    readonly PERSISTENCE_BACKEND?: string | undefined;
    readonly TELEGRAM_BOT_TOKEN?: string | undefined;
    readonly TELEGRAM_CHAT_ID?: string | undefined;
  };
  readonly version: string;
  readonly startTime: Date;
  readonly logger?: Logger;
  readonly database: DatabaseHandle;
  readonly persistenceBackend: string;
  readonly queue: JobQueue;
  readonly settings: { current(): AutomationSettings };
  readonly providers: Pick<ProviderService, 'selection' | 'list'>;
  readonly usage: Pick<UsageService, 'budgetStatus' | 'summary'>;
  readonly storage: ObjectStorage;
  readonly contentScheduler: { peekLastTick(): TickResult | null };
  schedulerStatus(now?: Date): SchedulerStatus;
  schedulerLoopStatus(): { enabled: boolean; mode: string; tickIntervalMs: number; reason: string };
  readonly secrets: Pick<SecretStore, 'has'>;
  /** Newest-first ops events (already persisted; used for recent errors). */
  recentEvents(limit: number): Promise<readonly StoredOpsEvent[]>;
  /** Optional event sink (OpsMonitor). Present in production and tests alike. */
  readonly monitor?: {
    record(event: OpsEventEmission): Promise<unknown>;
  };
}

export interface OpsHealthResponse extends OpsHealthReport {
  readonly uptimeSeconds: number;
  readonly persistenceBackend: string;
  /** §4 scheduler diagnostics (Jakarta calendar day). */
  readonly scheduler: {
    readonly enabled: boolean;
    readonly mode: string;
    readonly timezone: string;
    readonly automationState: string;
    readonly dailyPostTarget: number;
    readonly slotsToday: number;
    readonly today: string;
    readonly nextSlotAt: string | null;
    readonly lastTickAt: string | null;
    readonly lastSuccessfulTickAt: string | null;
    readonly lastTickSkipped: number | null;
    readonly lastTickExecuted: number | null;
  };
  /** §4 queue diagnostics (low-cardinality counts/ages only). */
  readonly queue: QueueStats | null;
  /** §5 recent operational errors (sanitized, bounded). */
  readonly recentEvents: readonly StoredOpsEvent[];
}

export interface OpsMetricsResponse {
  readonly capturedAt: string;
  readonly scheduler: {
    readonly enabled: boolean;
    readonly mode: string;
    readonly dailyPostTarget: number;
    readonly slotsToday: number;
    readonly nextSlotAt: string | null;
    readonly lastTickAt: string | null;
  };
  readonly queue: QueueStats | null;
  /** Recent generation latency from the usage ledger (deterministic samples). */
  readonly generation: {
    readonly recentSamples: number;
    readonly medianLatencyMs: number | null;
    readonly maxLatencyMs: number | null;
    readonly errorSamples: number;
  };
  readonly budget: BudgetStatus | null;
  /** Event counts from the bounded recent window (not a full-table scan). */
  readonly events: {
    readonly sampled: number;
    readonly bySeverity: { readonly info: number; readonly warning: number; readonly critical: number };
  };
}

/** Median of a numeric sample (null when empty). */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lower = sorted[mid - 1] ?? 0;
  const upper = sorted[mid] ?? 0;
  return Math.round((lower + upper) / 2);
}

/** Emission shape accepted by `OpsMonitor.record` (structurally typed). */
export interface OpsEventEmission {
  readonly kind: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly title: string;
  readonly detail?: string;
  readonly scope?: string;
  readonly cooldownMs?: number;
}

/**
 * PURE mapping from a health component to the operational event it represents
 * (§6 event catalogue). Returns null when the component's current state must
 * NOT emit — healthy, informational, or an expected condition (mock storage in
 * development, notifications disabled, first tick not yet due, …).
 */
export function eventsForComponent(component: HealthComponent): OpsEventEmission | null {
  switch (component.key) {
    case 'database':
      if (component.status === 'unavailable') {
        return {
          kind: 'database_unavailable',
          severity: 'critical',
          title: 'PostgreSQL unreachable',
          detail: component.message,
        };
      }
      return null;
    case 'migrations':
      if (component.status === 'blocked') {
        return {
          kind: 'migration_drift',
          severity: 'critical',
          title: 'Migration/schema drift detected',
          detail: component.message,
        };
      }
      if (component.status === 'degraded') {
        return {
          kind: 'migration_pending',
          severity: 'warning',
          title: 'Migrations are pending',
          detail: component.message,
        };
      }
      return null;
    case 'scheduler':
      if (component.code === 'scheduler_stale') {
        return {
          kind: 'scheduler_stale',
          severity: 'warning',
          title: 'Scheduler has not ticked recently',
          detail: component.message,
        };
      }
      return null;
    case 'queue':
      if (component.status === 'degraded') {
        return {
          kind: 'queue_degraded',
          severity: 'warning',
          title: 'Job queue needs attention',
          detail: component.message,
        };
      }
      return null;
    case 'caption_provider':
    case 'image_provider':
      if (component.status === 'blocked') {
        const isAuth =
          component.code === 'provider_auth_failed' ||
          component.code === 'provider_configuration_invalid';
        const providerId = typeof component.data.providerId === 'string' ? component.data.providerId : 'unknown';
        return {
          kind: isAuth ? 'provider_auth_failed' : 'provider_capability_unsupported',
          severity: 'warning',
          title: `${component.displayName} is blocked`,
          detail: component.message,
          scope: `${component.key}:${providerId}`,
        };
      }
      return null;
    case 'asset_storage':
      if (component.status === 'degraded') {
        return {
          kind: 'storage_unavailable',
          severity: 'warning',
          title: 'Asset storage is not ready',
          detail: component.message,
        };
      }
      return null;
    case 'budget':
      if (component.status === 'blocked') {
        return {
          kind: 'budget_exhausted',
          severity: 'critical',
          title: 'Generation budget exhausted',
          detail: component.message,
        };
      }
      if (component.status === 'degraded' && component.code === 'budget_threshold') {
        return {
          kind: 'budget_threshold',
          severity: 'warning',
          title: 'Generation budget threshold reached',
          detail: component.message,
        };
      }
      return null;
    default:
      // backend, telegram (delivery failures already recorded on the event
      // row itself — never re-emitted, which would recurse), publishing gate.
      return null;
  }
}

/**
 * PURE cross-component rule (§6): automation is paused WHILE a required
 * dependency is unavailable — the operator should know that resuming will not
 * help until the dependency is fixed. A healthy pause emits nothing.
 */
export function automationPausedEvent(input: {
  readonly automationState: string;
  readonly databaseStatus: string | null;
  readonly migrationsStatus: string | null;
}): OpsEventEmission | null {
  const requiredBroken =
    input.databaseStatus === 'unavailable' ||
    input.migrationsStatus === 'blocked' ||
    input.migrationsStatus === 'unavailable';
  if (input.automationState !== 'paused' || !requiredBroken) return null;
  return {
    kind: 'automation_paused',
    severity: 'warning',
    title: 'Automation is paused while a required dependency is unavailable',
    detail: 'A required dependency (database or schema) is unavailable, so automation cannot run even if resumed.',
  };
}

export class OpsService {
  private readonly deps: OpsServiceDeps;

  constructor(deps: OpsServiceDeps) {
    this.deps = deps;
  }

  /** True when a complete Telegram credential exists (env bootstrap OR secrets). */
  async telegramConfigured(): Promise<boolean> {
    const envReady = Boolean(this.deps.env.TELEGRAM_BOT_TOKEN && this.deps.env.TELEGRAM_CHAT_ID);
    if (envReady) return true;
    try {
      return (
        (await this.deps.secrets.has(TELEGRAM_SECRET_BOT_TOKEN)) &&
        (await this.deps.secrets.has(TELEGRAM_SECRET_CHAT_ID))
      );
    } catch {
      return false;
    }
  }

  /** §2/§3: component health + readiness + safe diagnostics. */
  async health(now = new Date()): Promise<OpsHealthResponse> {
    const { deps } = this;
    const current = deps.settings.current();
    const loop = deps.schedulerLoopStatus();
    const status = deps.schedulerStatus(now);
    const lastTick = deps.contentScheduler.peekLastTick();

    const [dbHealthy, dbDetail, migrationReport, queueStats, selection, providerViews, budget, telegramReady, recentEvents] =
      await Promise.all([
        deps.database.configured ? deps.database.healthy() : Promise.resolve(false),
        deps.database.configured ? deps.database.statusDetail() : Promise.resolve(''),
        deps.database.configured ? deps.database.migrationStatus() : Promise.resolve(null),
        deps.queue.stats ? deps.queue.stats() : Promise.resolve(null),
        deps.providers.selection().catch(() => null),
        deps.providers.list().catch(() => [] as ProviderView[]),
        deps.usage.budgetStatus().catch(() => null),
        this.telegramConfigured(),
        deps.recentEvents(20).catch(() => [] as StoredOpsEvent[]),
      ]);

    const viewFor = (id: string | null): ProviderView | null =>
      id ? (providerViews.find((view) => view.id === id) ?? null) : null;

    const lastDelivery = recentEvents.find((event) => event.lastNotifiedAt !== null) ?? null;

    const components: HealthComponent[] = [
      evaluateBackend({
        now,
        uptimeSeconds: Math.floor((now.getTime() - deps.startTime.getTime()) / 1000),
        version: deps.version,
        nodeEnv: deps.env.NODE_ENV,
        persistenceBackend: deps.persistenceBackend,
      }),
      evaluateDatabase({
        now,
        configured: deps.database.configured,
        healthy: dbHealthy,
        detail: dbDetail,
      }),
      evaluateMigrations({
        now,
        configured: deps.database.configured,
        report: migrationReport as MigrationStatusReport | null,
      }),
      evaluateScheduler({
        now,
        loopEnabled: loop.enabled,
        mode: loop.mode,
        automationState: current.automationState,
        tickIntervalMs: loop.tickIntervalMs,
        lastTickAt: lastTick?.at ?? null,
        lastTickFailedJobs: lastTick ? lastTick.failed.length : null,
        dailyPostTarget: status.dailyPostTarget,
        slotsToday: status.slotsToday,
        nextSlotAt: status.nextSlot?.scheduledFor ?? null,
        timezone: status.timezone,
      }),
      evaluateQueue({
        now,
        stats: queueStats,
        persistence: deps.persistenceBackend,
      }),
      evaluateProvider({
        now,
        task: 'caption',
        selected: selection?.textProviderId
          ? { id: selection.textProviderId, name: selection.textProviderName ?? selection.textProviderId }
          : null,
        view: viewFor(selection?.textProviderId ?? null),
      }),
      evaluateProvider({
        now,
        task: 'image',
        selected: selection?.imageProviderId
          ? { id: selection.imageProviderId, name: selection.imageProviderName ?? selection.imageProviderId }
          : null,
        view: viewFor(selection?.imageProviderId ?? null),
      }),
      evaluateAssetStorage({
        now,
        kind: deps.storage.info.kind,
        infoReady: deps.storage.info.ready,
        infoDetail: deps.storage.info.detail,
      }),
      evaluateTelegram({
        now,
        enabled: current.telegramNotificationsEnabled,
        configured: telegramReady,
        lastDeliveryStatus: lastDelivery?.lastDeliveryStatus ?? null,
        lastDeliveryAt: lastDelivery?.lastNotifiedAt ?? null,
      }),
      evaluateBudget({ now, budget }),
      evaluatePublishingGate({ now }),
    ];

    const report = buildHealthReport({ components, now });

    return {
      ...report,
      uptimeSeconds: Math.floor((now.getTime() - deps.startTime.getTime()) / 1000),
      persistenceBackend: deps.persistenceBackend,
      scheduler: {
        enabled: loop.enabled,
        mode: loop.mode,
        timezone: status.timezone,
        automationState: current.automationState,
        dailyPostTarget: status.dailyPostTarget,
        slotsToday: status.slotsToday,
        today: status.today,
        nextSlotAt: status.nextSlot?.scheduledFor ?? null,
        lastTickAt: lastTick?.at ?? null,
        lastSuccessfulTickAt: lastTick?.at ?? null,
        lastTickSkipped: lastTick ? lastTick.skipped.length : null,
        lastTickExecuted: lastTick ? lastTick.executed.length : null,
      },
      queue: queueStats,
      recentEvents,
    };
  }

  /** §4: low-cardinality metrics (no job ids, product data or keys). */
  async metrics(now = new Date()): Promise<OpsMetricsResponse> {
    const { deps } = this;
    const status = deps.schedulerStatus(now);
    const loop = deps.schedulerLoopStatus();
    const lastTick = deps.contentScheduler.peekLastTick();

    const [queueStats, usageSummary, recentEvents] = await Promise.all([
      deps.queue.stats ? deps.queue.stats() : Promise.resolve(null),
      deps.usage.summary().catch(() => null),
      deps.recentEvents(100).catch(() => [] as StoredOpsEvent[]),
    ]);

    const latencies = (usageSummary?.recent ?? [])
      .filter((row: UsageRecord) => row.status === 'success' && row.latencyMs > 0)
      .map((row: UsageRecord) => row.latencyMs);
    const errorSamples = (usageSummary?.recent ?? []).filter((row: UsageRecord) => row.status === 'error').length;

    const bySeverity = { info: 0, warning: 0, critical: 0 };
    for (const event of recentEvents) {
      if (event.severity === 'info' || event.severity === 'warning' || event.severity === 'critical') {
        bySeverity[event.severity] += 1;
      }
    }

    return {
      capturedAt: now.toISOString(),
      scheduler: {
        enabled: loop.enabled,
        mode: loop.mode,
        dailyPostTarget: status.dailyPostTarget,
        slotsToday: status.slotsToday,
        nextSlotAt: status.nextSlot?.scheduledFor ?? null,
        lastTickAt: lastTick?.at ?? null,
      },
      queue: queueStats,
      generation: {
        recentSamples: latencies.length,
        medianLatencyMs: median(latencies),
        maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : null,
        errorSamples,
      },
      budget: usageSummary?.budget ?? null,
      events: { sampled: recentEvents.length, bySeverity },
    };
  }

  /**
   * §6 periodic evaluation: gather health once, map each component (and the
   * cross-component pause rule) to its operational event, and hand every
   * emission to the monitor. The monitor deduplicates by fingerprint/cooldown,
   * so running this on a timer is safe and quiet when everything is fine.
   * Never throws — a monitoring failure must not stop the timer that called it.
   */
  async evaluateAndNotify(now = new Date()): Promise<OpsEventEmission[]> {
    const monitor = this.deps.monitor;
    if (!monitor) return [];
    try {
      const report = await this.health(now);
      const emissions: OpsEventEmission[] = [];
      for (const component of report.components) {
        const emission = eventsForComponent(component);
        if (emission) emissions.push(emission);
      }
      const paused = automationPausedEvent({
        automationState: this.deps.settings.current().automationState,
        databaseStatus:
          report.components.find((component) => component.key === 'database')?.status ?? null,
        migrationsStatus:
          report.components.find((component) => component.key === 'migrations')?.status ?? null,
      });
      if (paused) emissions.push(paused);

      for (const emission of emissions) {
        await monitor.record(emission);
      }
      return emissions;
    } catch (error) {
      this.deps.logger?.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'ops evaluation skipped (monitoring must never crash the process)',
      );
      return [];
    }
  }
}
