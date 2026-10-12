/**
 * Integration health classification (Part 2).
 *
 * The APK's Integrations screen must distinguish four honest states. This
 * module owns the mapping so the HTTP layer, the dashboard and the tests all
 * agree on what each term means:
 *
 *  - `connected`    Live credentials are present AND a live call has been
 *                   verified in this deployment. (None of the integrations
 *                   reach this state in Part 1/2: no credentials exist and the
 *                   publishers/notifier are deliberately hard-latched to
 *                   `allowLive: false`.)
 *  - `blocked`      A required external prerequisite is missing — e.g. the
 *                   Shopee live API contract is unverifiable, so feed
 *                   ingestion is explicitly blocked.
 *  - `not_tested`   An adapter exists and may even be configured, but its live
 *                   path has never been exercised (safety latch, no
 *                   authorization, or only deterministic mocks ran).
 *  - `disconnected` Nothing is configured for this service at all.
 *
 * This function never invents a `connected` state from configuration alone:
 * "configured" is NOT "verified".
 */
import type { IntegrationStatus } from '../core/env.js';

export const INTEGRATION_HEALTH_VALUES = [
  'connected',
  'blocked',
  'not_tested',
  'disconnected',
] as const;

export type IntegrationHealth = (typeof INTEGRATION_HEALTH_VALUES)[number];

export interface HealthClassification {
  readonly health: IntegrationHealth;
  /** One-line, human-readable justification shown under the status chip. */
  readonly healthDetail: string;
}

export function classifyIntegrationHealth(status: IntegrationStatus): HealthClassification {
  const { service, configured, mode } = status;

  if (service === 'shopee_feed') {
    if (mode === 'blocked') {
      return {
        health: 'blocked',
        healthDetail:
          'Blocked: no official live-feed contract or sample is available, so ingestion stays upload-only.',
      };
    }
    return {
      health: 'not_tested',
      healthDetail:
        'Not tested live: the CSV/XLSX importer is unit-tested, but no real Shopee Affiliate export has been validated yet.',
    };
  }

  if (service === 'ai_image' || service === 'ai_text') {
    if (mode === 'disabled') {
      return { health: 'disconnected', healthDetail: 'Provider disabled by configuration.' };
    }
    if (!configured) {
      return { health: 'disconnected', healthDetail: 'No provider or API key configured.' };
    }
    if (mode === 'mock') {
      return {
        health: 'not_tested',
        healthDetail:
          'Deterministic mock only — no paid AI provider has been called or verified.',
      };
    }
    return {
      health: 'not_tested',
      healthDetail: 'Provider configured, but no live generation has been verified in this deployment.',
    };
  }

  if (service === 'postgresql') {
    return configured
      ? {
          health: 'not_tested',
          healthDetail:
            'DATABASE_URL is set, but connectivity has not been verified from this environment.',
        }
      : { health: 'disconnected', healthDetail: 'DATABASE_URL not set; running on in-memory stores.' };
  }

  if (!configured) {
    return {
      health: 'disconnected',
      healthDetail: 'Not configured — no credentials present for this service.',
    };
  }

  // Configured, but live publication/notification is hard-latched off in this
  // build and no live call has ever been made.
  return {
    health: 'not_tested',
    healthDetail:
      'Configured but not tested live — publication is deliberately disabled until authorization is granted.',
  };
}

/** Attach `health` + `healthDetail` to every integration status. */
export function withIntegrationHealth(
  statuses: readonly IntegrationStatus[],
): Array<IntegrationStatus & HealthClassification> {
  return statuses.map((status) => ({ ...status, ...classifyIntegrationHealth(status) }));
}
