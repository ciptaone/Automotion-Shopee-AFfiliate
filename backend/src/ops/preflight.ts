/**
 * PART 8 §8 — production preflight (PURE evaluation over gathered inputs).
 *
 * Answers: "is this system configured for its INTENDED operation?" with
 * explicit blockers and warnings. A preflight NEVER changes state: it cannot
 * enable automation, cannot enable publishing, cannot store credentials and
 * cannot run migrations. Optional services (Telegram, budgets) never block a
 * local development run; they only matter for production intent.
 */
import type { OpsHealthReport, HealthComponent } from './component-health.js';
import type { AutomationSettings } from '../settings/automation-settings.js';

export const PREFLIGHT_STATUSES = ['pass', 'warning', 'blocker'] as const;
export type PreflightStatus = (typeof PREFLIGHT_STATUSES)[number];

export interface PreflightCheck {
  readonly id: string;
  readonly title: string;
  readonly status: PreflightStatus;
  /** Sanitized, actionable message. Never a secret. */
  readonly message: string;
}

export interface PreflightReport {
  /** True only when there are ZERO blockers (warnings are allowed). */
  readonly ok: boolean;
  readonly blockers: readonly PreflightCheck[];
  readonly warnings: readonly PreflightCheck[];
  readonly passed: readonly PreflightCheck[];
  readonly nodeEnv: string;
  readonly generatedAt: string;
}

export interface PreflightInput {
  readonly health: OpsHealthReport;
  readonly settings: AutomationSettings;
  readonly nodeEnv: string;
  readonly persistenceBackend: string;
  readonly secretsKeyConfigured: boolean;
  /** Env-configured default generators (mock/disabled/live-vendor names). */
  readonly envImageProvider: string;
  readonly envCaptionProvider: string;
  /** Scheduler window facts (Jakarta). */
  readonly timezone: string;
  readonly postingWindowsCount: number;
  readonly allowedWindowsCount: number;
  /** Provider view facts needed for the image-reference fidelity check. */
  readonly imageReferenceDeclared: boolean | null;
  readonly now: Date;
}

function pick(components: readonly HealthComponent[], key: string): HealthComponent | null {
  return components.find((component) => component.key === key) ?? null;
}

export function evaluatePreflight(input: PreflightInput): PreflightReport {
  const checks: PreflightCheck[] = [];
  const production = input.nodeEnv === 'production';
  const automationRunning = input.settings.automationState === 'running';

  const add = (id: string, title: string, status: PreflightStatus, message: string): void => {
    checks.push({ id, title, status, message });
  };

  /* --- PostgreSQL + schema --- */
  const database = pick(input.health.components, 'database');
  if (database?.status === 'unavailable') {
    add('database', 'PostgreSQL reachable', 'blocker', database.message);
  } else if (database?.status === 'not_configured') {
    add(
      'database',
      'PostgreSQL reachable',
      production ? 'blocker' : 'warning',
      production
        ? 'No database configured. Production requires PostgreSQL for durable slots, leases and the daily cap.'
        : 'No database configured — fine for local development, but state is lost on restart.',
    );
  } else {
    add('database', 'PostgreSQL reachable', 'pass', database?.message ?? 'Database status unknown.');
  }

  const migrations = pick(input.health.components, 'migrations');
  if (migrations?.status === 'blocked') {
    add('migrations', 'Schema consistent', 'blocker', migrations.message);
  } else if (migrations?.status === 'degraded') {
    add('migrations', 'Schema consistent', 'blocker', migrations.message);
  } else if (migrations?.status === 'not_tested') {
    add(
      'migrations',
      'Schema consistent',
      production ? 'blocker' : 'warning',
      'Migration status could not be read; run `npm run db:status` before relying on this deployment.',
    );
  } else {
    add('migrations', 'Schema consistent', 'pass', migrations?.message ?? 'Schema matches the journal.');
  }

  /* --- Scheduler configuration --- */
  const scheduler = pick(input.health.components, 'scheduler');
  if (automationRunning && scheduler?.status === 'disabled') {
    add('scheduler', 'Scheduler dispatches jobs', 'blocker', scheduler.message);
  } else if (scheduler?.status === 'disabled') {
    add('scheduler', 'Scheduler dispatches jobs', 'warning', scheduler.message);
  } else if (scheduler?.status === 'degraded' || scheduler?.status === 'not_tested') {
    add('scheduler', 'Scheduler dispatches jobs', 'warning', scheduler.message);
  } else {
    add('scheduler', 'Scheduler dispatches jobs', 'pass', scheduler?.message ?? 'Scheduler healthy.');
  }

  if (input.settings.dailyPostTarget < 3 || input.settings.dailyPostTarget > 4) {
    add(
      'daily_target',
      'Posting target is 3 or 4',
      'blocker',
      `Configured dailyPostTarget is ${input.settings.dailyPostTarget}; only 3 or 4 posts per Asia/Jakarta day are allowed.`,
    );
  } else {
    add(
      'daily_target',
      'Posting target is 3 or 4',
      'pass',
      `Daily target ${input.settings.dailyPostTarget} within the allowed WIB windows.`,
    );
  }

  if (input.postingWindowsCount !== input.allowedWindowsCount) {
    add(
      'windows',
      'WIB windows valid',
      'blocker',
      `${input.postingWindowsCount} posting window(s) computed; exactly ${input.allowedWindowsCount} allowed WIB windows are required.`,
    );
  } else {
    add('windows', 'WIB windows valid', 'pass', `All ${input.allowedWindowsCount} WIB windows computed.`);
  }

  if (input.timezone !== 'Asia/Jakarta') {
    add(
      'timezone',
      'Timezone is Asia/Jakarta',
      'warning',
      `Scheduler timezone is "${input.timezone}"; the product decision locks daily scheduling to Asia/Jakarta.`,
    );
  } else {
    add('timezone', 'Timezone is Asia/Jakarta', 'pass', 'Asia/Jakarta calendar day in effect.');
  }

  /* --- Generation providers (caption + image independently) --- */
  for (const [id, title, key] of [
    ['caption_provider', 'Caption provider configured and tested', 'caption_provider'],
    ['image_provider', 'Image provider configured and tested', 'image_provider'],
  ] as const) {
    const component = pick(input.health.components, key);
    if (component?.status === 'healthy') {
      add(id, title, 'pass', component.message);
    } else if (component?.status === 'not_configured' || component?.status === 'not_tested') {
      add(
        id,
        title,
        automationRunning ? 'blocker' : 'warning',
        component.message +
          (automationRunning ? ' Automation is running, so generation will block on this.' : ''),
      );
    } else {
      add(
        id,
        title,
        automationRunning ? 'blocker' : 'warning',
        component?.message ?? 'Component status unavailable — cannot verify provider readiness.',
      );
    }
  }

  /* --- Image reference fidelity --- */
  if (input.imageReferenceDeclared === false) {
    add(
      'image_reference',
      'Image provider supports reference input',
      'warning',
      'The selected image provider does not declare reference-image input; generated images cannot be grounded on the product reference (PART 7 fidelity limitation).',
    );
  } else if (input.imageReferenceDeclared === null) {
    add(
      'image_reference',
      'Image provider supports reference input',
      'warning',
      'Reference-input support could not be determined (no healthy image provider selected).',
    );
  } else {
    add('image_reference', 'Image provider supports reference input', 'pass', 'Reference-image input declared.');
  }

  /* --- Asset storage --- */
  const storage = pick(input.health.components, 'asset_storage');
  if (storage?.status === 'not_configured' || storage?.status === 'unavailable' || storage?.status === 'blocked') {
    add(
      'asset_storage',
      'Durable asset storage',
      production ? 'blocker' : 'warning',
      production
        ? `${storage.message} Production needs durable storage with public URLs.`
        : storage.message,
    );
  } else {
    add('asset_storage', 'Durable asset storage', 'pass', storage?.message ?? 'Asset storage ready.');
  }

  /* --- Budget --- */
  const budget = pick(input.health.components, 'budget');
  if (budget?.status === 'blocked') {
    add('budget', 'Budget not exhausted', 'blocker', budget.message);
  } else if (budget?.status === 'degraded') {
    add('budget', 'Budget not exhausted', 'warning', budget.message);
  } else if (budget?.code === 'budget_not_configured' && production) {
    add(
      'budget',
      'Budget configured',
      'warning',
      'No generation budget is configured; production spending is unbounded. Set a daily/monthly budget in Settings.',
    );
  } else {
    add('budget', 'Budget not exhausted', 'pass', budget?.message ?? 'Budget status OK.');
  }

  /* --- Telegram (only when notifications are enabled) --- */
  if (input.settings.telegramNotificationsEnabled) {
    const telegram = pick(input.health.components, 'telegram');
    if (telegram?.status === 'not_configured') {
      add(
        'telegram',
        'Telegram configured',
        'warning',
        'Notifications are enabled but no bot token/chat id is stored; events will be recorded durably without delivery.',
      );
    } else if (telegram?.status === 'degraded') {
      add('telegram', 'Telegram configured', 'warning', telegram.message);
    } else {
      add('telegram', 'Telegram configured', 'pass', telegram?.message ?? 'Telegram ready.');
    }
  } else {
    add('telegram', 'Telegram configured', 'pass', 'Notifications are disabled — no Telegram setup required.');
  }

  /* --- Publishing gate: must remain disabled --- */
  add(
    'publishing_gate',
    'Live publishing disabled',
    'pass',
    'Live Facebook/Threads publishing is disabled by design; the pipeline terminates at publish_ready.',
  );

  /* --- Production-mode integrity --- */
  if (production) {
    if (input.persistenceBackend !== 'postgres') {
      add(
        'production_persistence',
        'Production persistence is PostgreSQL',
        'blocker',
        `PERSISTENCE_BACKEND is "${input.persistenceBackend}" in production; file/memory persistence is development-only.`,
      );
    } else {
      add('production_persistence', 'Production persistence is PostgreSQL', 'pass', 'PostgreSQL persistence active.');
    }

    if (!input.secretsKeyConfigured) {
      add(
        'secrets_key',
        'Secrets encryption key configured',
        'blocker',
        'SECRETS_ENCRYPTION_KEY is not set, so provider credentials cannot be stored (fail-closed).',
      );
    } else {
      add('secrets_key', 'Secrets encryption key configured', 'pass', 'AES-256-GCM key available.');
    }

    const mockDefaults =
      input.envImageProvider === 'mock' || input.envCaptionProvider === 'mock';
    if (mockDefaults && automationRunning) {
      add(
        'production_producers',
        'No silent mock generation in production',
        'blocker',
        `Env default providers (${input.envCaptionProvider}/${input.envImageProvider}) include "mock" while automation is running. Select real providers or pause automation.`,
      );
    } else if (mockDefaults) {
      add(
        'production_producers',
        'No silent mock generation in production',
        'warning',
        `Env default providers are ${input.envCaptionProvider}/${input.envImageProvider}; they are only used when no user provider is selected.`,
      );
    } else {
      add('production_producers', 'No silent mock generation in production', 'pass', 'Env defaults are not mock.');
    }
  }

  const blockers = checks.filter((check) => check.status === 'blocker');
  const warnings = checks.filter((check) => check.status === 'warning');
  const passed = checks.filter((check) => check.status === 'pass');

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    passed,
    nodeEnv: input.nodeEnv,
    generatedAt: input.now.toISOString(),
  };
}

/** Settings/health input builder for `evaluatePreflight` from a live OpsService report. */
export function preflightImageReferenceDeclared(health: OpsHealthReport): boolean | null {
  const component = pick(health.components, 'image_provider');
  const declared = component?.data.referenceImageDeclared;
  return typeof declared === 'boolean' ? declared : null;
}
