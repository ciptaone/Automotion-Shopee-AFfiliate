/**
 * Runtime automation settings (Part 2).
 *
 * These are the values the APK's Automation Settings screen reads and writes:
 * posting interval, daily slot limit, per-platform enablement, the image-count
 * policy and the running/paused state of the automation.
 *
 * Design rules:
 *  - The backend is the single source of truth. The APK never persists an
 *    authoritative copy; it only mirrors what the backend returns.
 *  - Values are validated server-side against the LOCKED product decisions:
 *    at most 24 slots per Asia/Jakarta day, and a schedule that fits inside a
 *    single calendar day.
 *  - Persistence is pluggable: a file-backed store by default (no database
 *    required), an in-memory store for tests. A PostgreSQL-backed store can be
 *    dropped in later without changing any caller, because everything talks to
 *    the `SettingsStore` interface.
 *  - Nothing here ever stores a credential. Settings are pure configuration.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { atomicWriteText, createSerialQueue } from '../core/atomic-file.js';
import { AppError } from '../core/errors.js';
import type { ValidationIssue } from '../core/errors.js';

/* -------------------------------------------------------------------------- */
/*  Locked value space                                                        */
/* -------------------------------------------------------------------------- */

export const IMAGE_COUNT_POLICIES = ['random_1_or_2', 'one', 'two'] as const;
export type ImageCountPolicy = (typeof IMAGE_COUNT_POLICIES)[number];

export const SELECTION_MODES = ['auto', 'selected_categories'] as const;
export type SelectionMode = (typeof SELECTION_MODES)[number];

export const AUTOMATION_STATES = ['running', 'paused'] as const;
export type AutomationState = (typeof AUTOMATION_STATES)[number];

export const AUTOMATION_ACTIONS = ['start', 'pause', 'resume'] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

/** Locked decision: one product per 60 minutes by default. */
export const DEFAULT_INTERVAL_MINUTES = 60;
/** Locked decision: maximum 24 slots per Asia/Jakarta calendar day. */
export const MAX_SLOTS_PER_DAY = 24;

export const MIN_INTERVAL_MINUTES = 15;
export const MAX_INTERVAL_MINUTES = 12 * 60;
const MINUTES_PER_DAY = 24 * 60;

export interface AutomationSettings {
  readonly intervalMinutes: number;
  readonly maxSlotsPerDay: number;
  readonly facebookEnabled: boolean;
  readonly threadsEnabled: boolean;
  readonly imageCountPolicy: ImageCountPolicy;
  readonly telegramNotificationsEnabled: boolean;
  readonly automationState: AutomationState;
  /** Product selection mode (Part 3). Default: auto across all eligible categories. */
  readonly selectionMode: SelectionMode;
  /** Stable category ids from the imported catalog (only used in selected_categories mode). */
  readonly selectedCategoryIds: readonly string[];
}

/** Everything EXCEPT the run state (state changes go through `control()`). */
export type AutomationSettingsPatch = Partial<Omit<AutomationSettings, 'automationState'>>;

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  maxSlotsPerDay: MAX_SLOTS_PER_DAY,
  facebookEnabled: true,
  threadsEnabled: true,
  imageCountPolicy: 'random_1_or_2',
  telegramNotificationsEnabled: true,
  // Honest default: nothing publishes until an operator explicitly starts it.
  automationState: 'paused',
  // Locked decision (Part 3): products are selected across ALL eligible
  // categories unless the operator explicitly narrows the selection.
  selectionMode: 'auto',
  selectedCategoryIds: [],
};

/** Machine-readable constraints, surfaced to the APK so it can validate offline. */
export const SETTINGS_CONSTRAINTS = {
  minIntervalMinutes: MIN_INTERVAL_MINUTES,
  maxIntervalMinutes: MAX_INTERVAL_MINUTES,
  maxSlotsPerDay: MAX_SLOTS_PER_DAY,
  imageCountPolicies: IMAGE_COUNT_POLICIES,
  automationActions: AUTOMATION_ACTIONS,
  selectionModes: SELECTION_MODES,
  slotsMustFitOneDay: true,
} as const;

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

const settingsObjectSchema = z.object({
  intervalMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(MAX_INTERVAL_MINUTES),
  maxSlotsPerDay: z.number().int().min(1).max(MAX_SLOTS_PER_DAY),
  facebookEnabled: z.boolean(),
  threadsEnabled: z.boolean(),
  imageCountPolicy: z.enum(IMAGE_COUNT_POLICIES),
  telegramNotificationsEnabled: z.boolean(),
  automationState: z.enum(AUTOMATION_STATES),
  // Defaults keep pre-Part-3 persisted settings files loadable.
  selectionMode: z.enum(SELECTION_MODES).default('auto'),
  selectedCategoryIds: z
    .array(z.string().trim().min(1).max(64))
    .max(100)
    .default([]),
});

const settingsSchema = settingsObjectSchema.superRefine((value, ctx) => {
  if (value.intervalMinutes * value.maxSlotsPerDay > MINUTES_PER_DAY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['intervalMinutes'],
      message: `${value.maxSlotsPerDay} slot(s) every ${value.intervalMinutes} minute(s) exceed one 24-hour day; reduce the slot limit or the interval.`,
    });
  }
  if (value.selectionMode === 'selected_categories' && value.selectedCategoryIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedCategoryIds'],
      message: 'Selected-categories mode requires at least one category id.',
    });
  }
});

/** Patch schema: only provided keys are validated, then merged and re-validated. */
const patchSchema = settingsObjectSchema.partial().omit({ automationState: true });

export class SettingsValidationError extends AppError {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const first = issues.find((i) => i.severity === 'error');
    super({
      code: 'INVALID_SETTINGS',
      category: 'validation',
      message: first
        ? `Settings rejected: ${first.message}`
        : 'Settings rejected by validation.',
      httpStatus: 400,
      expose: true,
      retryable: false,
      context: { issues },
    });
    this.issues = issues;
  }
}

/** Thrown when a persisted settings file exists but cannot be trusted. */
export class SettingsStoreError extends AppError {
  constructor(message: string, cause?: unknown) {
    super({
      code: 'SETTINGS_STORE_FAILED',
      category: 'configuration',
      message,
      expose: false,
      retryable: false,
      cause,
      context: {},
    });
  }
}

function toIssues(issues: readonly z.ZodIssue[]): ValidationIssue[] {
  return issues.map((issue) => ({
    rule: issue.path.length > 0 ? `settings.${issue.path.join('.')}` : 'settings',
    message: issue.message,
    severity: 'error' as const,
  }));
}

/** Validate an object into a full `AutomationSettings`, or throw a typed 400. */
export function parseAutomationSettings(input: unknown): AutomationSettings {
  const result = settingsSchema.safeParse(input);
  if (!result.success) {
    throw new SettingsValidationError(toIssues(result.error.issues));
  }
  return result.data;
}

/** Validate a partial patch. Throws the same typed 400 as full validation. */
export function parseSettingsPatch(input: unknown): AutomationSettingsPatch {
  const result = patchSchema.safeParse(input ?? {});
  if (!result.success) {
    throw new SettingsValidationError(toIssues(result.error.issues));
  }
  return result.data;
}

/* -------------------------------------------------------------------------- */
/*  Persistence                                                               */
/* -------------------------------------------------------------------------- */

export interface SettingsStore {
  /** How settings are persisted, surfaced to the APK ("memory" | "file"). */
  readonly kind: 'memory' | 'file';
  load(): Promise<AutomationSettings | null>;
  save(settings: AutomationSettings): Promise<void>;
}

export class InMemorySettingsStore implements SettingsStore {
  readonly kind = 'memory' as const;
  private value: AutomationSettings | null = null;

  async load(): Promise<AutomationSettings | null> {
    return this.value;
  }

  async save(settings: AutomationSettings): Promise<void> {
    this.value = settings;
  }
}

/**
 * File-backed store (default when no database is available).
 *
 * Writes are atomic: a temp file is written and renamed into place, so a crash
 * mid-write can never leave a half-written configuration behind. Contents are
 * re-validated on load, so a hand-edited or corrupted file cannot put the
 * scheduler into an illegal state.
 */
export class FileSettingsStore implements SettingsStore {
  readonly kind = 'file' as const;

  constructor(private readonly filePath: string) {}

  async load(): Promise<AutomationSettings | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new SettingsStoreError(`Could not read settings file ${this.filePath}`, error);
    }

    try {
      return parseAutomationSettings(JSON.parse(raw));
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        throw new SettingsStoreError(
          `Settings file ${this.filePath} is invalid (${error.issues.length} issue(s)); fix or delete it.`,
          error,
        );
      }
      throw new SettingsStoreError(`Settings file ${this.filePath} is not valid JSON`, error);
    }
  }

  async save(settings: AutomationSettings): Promise<void> {
    // Serialized per instance: an older snapshot must never overwrite a newer
    // one (settings are written by API control calls and by the scheduler).
    await this.queue(async () => {
      try {
        await atomicWriteText(this.filePath, `${JSON.stringify(settings, null, 2)}\n`);
      } catch (error) {
        throw new SettingsStoreError(`Could not write settings file ${this.filePath}`, error);
      }
    });
  }

  private readonly queue = createSerialQueue();
}

/* -------------------------------------------------------------------------- */
/*  Service                                                                   */
/* -------------------------------------------------------------------------- */

export interface AutomationControlResult {
  readonly settings: AutomationSettings;
  readonly changed: boolean;
  readonly action: AutomationAction;
}

/**
 * Holds the current settings in memory (so synchronous readers such as the
 * health endpoint never block), while all mutations are validated and
 * persisted through the configured store.
 */
export class SettingsService {
  private value: AutomationSettings;
  private initialized = false;
  private warning: string | null = null;

  constructor(
    private readonly defaults: AutomationSettings = DEFAULT_AUTOMATION_SETTINGS,
    readonly store: SettingsStore = new InMemorySettingsStore(),
  ) {
    this.value = defaults;
  }

  /** Current (in-memory) settings. Safe to call synchronously. */
  current(): AutomationSettings {
    return this.value;
  }

  /** How settings are persisted: "memory" | "file". */
  get storageKind(): 'memory' | 'file' {
    return this.store.kind;
  }

  /** Non-fatal load problem (e.g. an invalid settings file fell back to defaults). */
  get loadWarning(): string | null {
    return this.warning;
  }

  /** Load persisted settings once. Idempotent; safe to call from every request. */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    try {
      const loaded = await this.store.load();
      if (loaded) {
        this.value = loaded;
      }
    } catch (error) {
      // Never fail boot over settings: fall back to defaults and surface why.
      this.warning = error instanceof AppError ? error.message : 'Settings could not be loaded.';
      this.value = this.defaults;
    }
  }

  /** Apply a partial patch, validate the merge, persist and publish it. */
  async update(patch: AutomationSettingsPatch): Promise<AutomationSettings> {
    await this.init();
    const merged: AutomationSettings = { ...this.value, ...patch };
    const next = parseAutomationSettings(merged);
    return this.persist(next);
  }

  /** Start / pause / resume. Idempotent: repeating an action reports changed=false. */
  async control(action: AutomationAction): Promise<AutomationControlResult> {
    await this.init();
    const target: AutomationState = action === 'pause' ? 'paused' : 'running';
    if (this.value.automationState === target) {
      return { settings: this.value, changed: false, action };
    }
    const next = await this.persist({ ...this.value, automationState: target });
    return { settings: next, changed: true, action };
  }

  private async persist(next: AutomationSettings): Promise<AutomationSettings> {
    await this.store.save(next);
    this.value = next;
    return next;
  }
}
