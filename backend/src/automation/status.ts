/**
 * Automation status aggregation (Part 2).
 *
 * Answers the APK dashboard's questions from REAL runtime state:
 *  - is the automation running or paused,
 *  - how many of today's Asia/Jakarta slots are used and how many remain,
 *  - how many publish jobs succeeded / failed / are retrying today,
 *  - what the backend did recently (job activity).
 *
 * It deliberately reports `latestContent: null`: nothing has been generated
 * yet, because the generation pipeline is not implemented. The dashboard shows
 * an honest "not generated yet" state instead of a fabricated preview.
 */
import { computeDailySlots, todayKey, type SchedulerConfig } from '../scheduler/slots.js';
import type { JobRecord } from '../contracts/index.js';
import type { AutomationSettings } from '../settings/automation-settings.js';

export interface AutomationActivity {
  readonly id: string;
  readonly kind: string;
  readonly status: JobRecord['status'];
  readonly slotKey: string;
  readonly scheduledFor: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly updatedAt: string;
}

export interface AutomationStatus {
  readonly state: AutomationSettings['automationState'];
  readonly degraded: boolean;
  readonly degradedReasons: readonly string[];
  readonly timezone: string;
  readonly today: string;
  readonly slotsScheduled: number;
  readonly slotsUsed: number;
  readonly slotsRemaining: number;
  readonly publications: {
    readonly succeeded: number;
    readonly failed: number;
    readonly retrying: number;
    /** Counts come from the live job queue, never from fixtures. */
    readonly source: 'job_queue';
  };
  /** Always null until the content-generation pipeline exists. */
  readonly latestContent: null;
  readonly latestContentNote: string;
  readonly recentActivity: readonly AutomationActivity[];
  readonly recentActivitySource: 'job_queue';
  readonly serverTime: string;
}

export const LATEST_CONTENT_NOTE =
  'No content has been generated yet: the generation pipeline is not implemented (deferred to the content part).';

export interface DescribeAutomationStatusInput {
  readonly settings: AutomationSettings;
  readonly schedulerConfig: SchedulerConfig;
  readonly schedulerMode: string;
  readonly degradedReasons: readonly string[];
  readonly jobs: readonly JobRecord[];
  readonly now: Date;
}

export function describeAutomationStatus(input: DescribeAutomationStatusInput): AutomationStatus {
  const { settings, schedulerConfig, degradedReasons, jobs, now } = input;

  const today = todayKey(schedulerConfig, now);
  const slots = computeDailySlots(today, schedulerConfig);

  const todaysJobs = jobs.filter((job) => job.uniqueKey.startsWith(`${today}#`));
  const slotsUsed = todaysJobs.length;
  const slotsRemaining = Math.max(0, slots.length - slotsUsed);

  const succeeded = todaysJobs.filter((job) => job.status === 'succeeded').length;
  const failed = todaysJobs.filter((job) => job.status === 'failed').length;
  const retrying = todaysJobs.filter((job) => job.status === 'pending' && job.attempts > 0).length;

  return {
    state: settings.automationState,
    degraded: degradedReasons.length > 0,
    degradedReasons,
    timezone: schedulerConfig.timezone,
    today,
    slotsScheduled: slots.length,
    slotsUsed,
    slotsRemaining,
    publications: { succeeded, failed, retrying, source: 'job_queue' },
    latestContent: null,
    latestContentNote: LATEST_CONTENT_NOTE,
    recentActivity: jobs.slice(0, 8).map((job) => ({
      id: job.id,
      kind: job.kind,
      status: job.status,
      slotKey: job.uniqueKey,
      scheduledFor: job.scheduledFor,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      lastError: job.lastError,
      updatedAt: job.updatedAt,
    })),
    recentActivitySource: 'job_queue',
    serverTime: now.toISOString(),
  };
}

/** Degraded reasons that only apply while the automation claims to be running. */
export function automationDegradedReasons(input: {
  readonly settings: AutomationSettings;
  readonly schedulerMode: string;
  readonly hasLiveDestination: boolean;
}): string[] {
  const reasons: string[] = [];
  if (input.settings.automationState !== 'running') {
    return reasons;
  }
  if (input.schedulerMode === 'disabled') {
    reasons.push('Scheduler mode is "disabled" while automation is running; no jobs will be dispatched.');
  }
  if (!input.hasLiveDestination) {
    reasons.push('No publishing destination is live-configured, so running slots cannot publish.');
  }
  if (!input.settings.facebookEnabled && !input.settings.threadsEnabled) {
    reasons.push('Both destinations are switched off in automation settings.');
  }
  return reasons;
}
