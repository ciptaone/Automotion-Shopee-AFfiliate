/**
 * Part 2 — automation settings: validation, persistence and control.
 *
 * These tests cover the contract the APK settings screen depends on:
 *  - locked defaults (60 minutes, 24 slots, random 1-2 images),
 *  - validation bounds (>=15m interval, <=24 slots/day, schedule fits a day),
 *  - persistence through a pluggable store (memory + file, atomic write),
 *  - idempotent start/pause/resume.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AutomationSettings,
  AutomationSettingsPatch,
  DEFAULT_AUTOMATION_SETTINGS,
  FileSettingsStore,
  InMemorySettingsStore,
  SETTINGS_CONSTRAINTS,
  SettingsService,
  SettingsStoreError,
  SettingsValidationError,
  parseAutomationSettings,
  parseSettingsPatch,
} from '../../src/settings/automation-settings.js';

function validSettings(overrides: Partial<AutomationSettings> = {}): AutomationSettings {
  return { ...DEFAULT_AUTOMATION_SETTINGS, ...overrides };
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  return (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'autopilot-settings-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
}

/* ========================================================================== */
/*  Defaults                                                                  */
/* ========================================================================== */

describe('locked defaults', () => {
  it('matches the locked product decisions', () => {
    expect(DEFAULT_AUTOMATION_SETTINGS.intervalMinutes).toBe(60);
    expect(DEFAULT_AUTOMATION_SETTINGS.maxSlotsPerDay).toBe(24);
    expect(DEFAULT_AUTOMATION_SETTINGS.imageCountPolicy).toBe('random_1_or_2');
    expect(DEFAULT_AUTOMATION_SETTINGS.facebookEnabled).toBe(true);
    expect(DEFAULT_AUTOMATION_SETTINGS.threadsEnabled).toBe(true);
    expect(DEFAULT_AUTOMATION_SETTINGS.telegramNotificationsEnabled).toBe(true);
  });

  it('defaults to paused so nothing publishes without an operator action', () => {
    expect(DEFAULT_AUTOMATION_SETTINGS.automationState).toBe('paused');
  });

  it('accepts the defaults without any validation issue', () => {
    expect(parseAutomationSettings(DEFAULT_AUTOMATION_SETTINGS)).toEqual(
      DEFAULT_AUTOMATION_SETTINGS,
    );
  });
});

/* ========================================================================== */
/*  Validation                                                                */
/* ========================================================================== */

describe('parseAutomationSettings', () => {
  it('rejects an interval below the 15 minute floor', () => {
    expect(() => parseAutomationSettings(validSettings({ intervalMinutes: 10 }))).toThrow(
      SettingsValidationError,
    );
  });

  it('rejects an interval above the 12 hour ceiling', () => {
    expect(() => parseAutomationSettings(validSettings({ intervalMinutes: 721 }))).toThrow(
      SettingsValidationError,
    );
  });

  it('rejects more than the locked 24 slots per day', () => {
    try {
      parseAutomationSettings(validSettings({ maxSlotsPerDay: 25 }));
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsValidationError);
      const err = error as SettingsValidationError;
      expect(err.code).toBe('INVALID_SETTINGS');
      expect(err.httpStatus).toBe(400);
      expect(err.issues.some((i) => i.rule === 'settings.maxSlotsPerDay')).toBe(true);
    }
  });

  it('rejects a schedule that cannot fit into one calendar day', () => {
    // 720 minutes apart x 24 slots = 17280 minutes >> 1440.
    expect(() =>
      parseAutomationSettings(validSettings({ intervalMinutes: 720, maxSlotsPerDay: 24 })),
    ).toThrow(/exceed one 24-hour day/);
  });

  it('accepts the tightest valid schedule (15 minutes x 24 slots)', () => {
    const parsed = parseAutomationSettings(
      validSettings({ intervalMinutes: 15, maxSlotsPerDay: 24 }),
    );
    expect(parsed.intervalMinutes).toBe(15);
  });

  it('rejects an unknown image-count policy', () => {
    expect(() =>
      parseAutomationSettings({
        ...DEFAULT_AUTOMATION_SETTINGS,
        imageCountPolicy: 'random_1_to_5',
      }),
    ).toThrow(SettingsValidationError);
  });

  it('rejects non-integer values', () => {
    expect(() =>
      parseAutomationSettings(validSettings({ intervalMinutes: 60.5 })),
    ).toThrow(SettingsValidationError);
  });

  it('rejects a non-object payload', () => {
    expect(() => parseAutomationSettings('nope')).toThrow(SettingsValidationError);
  });

  it('strips unknown keys instead of failing (forward compatible)', () => {
    const parsed = parseAutomationSettings({ ...DEFAULT_AUTOMATION_SETTINGS, futureKey: 1 });
    expect(Object.keys(parsed)).not.toContain('futureKey');
  });
});

describe('parseSettingsPatch', () => {
  it('accepts a partial patch', () => {
    const patch: AutomationSettingsPatch = parseSettingsPatch({ intervalMinutes: 90 });
    expect(patch).toEqual({ intervalMinutes: 90 });
  });

  it('accepts an empty patch', () => {
    expect(parseSettingsPatch({})).toEqual({});
  });

  it('rejects a wrongly-typed value', () => {
    expect(() => parseSettingsPatch({ facebookEnabled: 'yes' })).toThrow(
      SettingsValidationError,
    );
  });

  it('never accepts automationState (state changes go through control())', () => {
    const patch = parseSettingsPatch({ automationState: 'running' });
    expect(patch).toEqual({});
  });
});

/* ========================================================================== */
/*  Persistence                                                               */
/* ========================================================================== */

describe('InMemorySettingsStore', () => {
  it('round-trips settings and reports its kind', async () => {
    const store = new InMemorySettingsStore();
    expect(store.kind).toBe('memory');
    expect(await store.load()).toBeNull();
    const settings = validSettings({ intervalMinutes: 90 });
    await store.save(settings);
    expect(await store.load()).toEqual(settings);
  });
});

describe('FileSettingsStore', () => {
  it('round-trips settings through a JSON file', async () => {
    await withTempDir(async (dir) => {
      const store = new FileSettingsStore(path.join(dir, 'settings.json'));
      expect(store.kind).toBe('file');
      expect(await store.load()).toBeNull();

      const settings = validSettings({ intervalMinutes: 120, maxSlotsPerDay: 12 });
      await store.save(settings);
      expect(await store.load()).toEqual(settings);

      const raw = await readFile(path.join(dir, 'settings.json'), 'utf8');
      expect(JSON.parse(raw)).toEqual(settings);
    });
  });

  it('writes atomically (no temp file left behind)', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'settings.json');
      const store = new FileSettingsStore(file);
      await store.save(validSettings());
      await expect(access(`${file}.tmp`)).rejects.toThrow();
    });
  });

  it('returns null when the file does not exist', async () => {
    await withTempDir(async (dir) => {
      const store = new FileSettingsStore(path.join(dir, 'missing.json'));
      expect(await store.load()).toBeNull();
    });
  });

  it('refuses a corrupted (non-JSON) file', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'settings.json');
      await writeFile(file, '{ not json', 'utf8');
      const store = new FileSettingsStore(file);
      await expect(store.load()).rejects.toBeInstanceOf(SettingsStoreError);
    });
  });

  it('refuses a file whose values violate the locked limits', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'settings.json');
      await writeFile(file, JSON.stringify(validSettings({ maxSlotsPerDay: 99 })), 'utf8');
      const store = new FileSettingsStore(file);
      await expect(store.load()).rejects.toBeInstanceOf(SettingsStoreError);
    });
  });
});

/* ========================================================================== */
/*  Service                                                                   */
/* ========================================================================== */

describe('SettingsService', () => {
  it('serves defaults before init and after init on an empty store', async () => {
    const service = new SettingsService(DEFAULT_AUTOMATION_SETTINGS, new InMemorySettingsStore());
    expect(service.current().intervalMinutes).toBe(60);
    await service.init();
    expect(service.current()).toEqual(DEFAULT_AUTOMATION_SETTINGS);
    expect(service.storageKind).toBe('memory');
    expect(service.loadWarning).toBeNull();
  });

  it('applies a validated patch and persists it', async () => {
    const store = new InMemorySettingsStore();
    const service = new SettingsService(DEFAULT_AUTOMATION_SETTINGS, store);
    const next = await service.update({ intervalMinutes: 90, maxSlotsPerDay: 12 });
    expect(next.intervalMinutes).toBe(90);
    expect(next.maxSlotsPerDay).toBe(12);
    expect(service.current().intervalMinutes).toBe(90);
    expect(await store.load()).toEqual(next);
  });

  it('rejects an invalid patch and keeps the previous settings', async () => {
    const store = new InMemorySettingsStore();
    const service = new SettingsService(DEFAULT_AUTOMATION_SETTINGS, store);
    await expect(service.update({ maxSlotsPerDay: 40 })).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
    expect(service.current().maxSlotsPerDay).toBe(24);
    expect(await store.load()).toBeNull();
  });

  it('control() is idempotent and reports whether state changed', async () => {
    const service = new SettingsService(DEFAULT_AUTOMATION_SETTINGS, new InMemorySettingsStore());

    const paused = await service.control('pause');
    expect(paused.changed).toBe(false); // already paused
    expect(paused.settings.automationState).toBe('paused');

    const started = await service.control('start');
    expect(started.changed).toBe(true);
    expect(started.settings.automationState).toBe('running');

    const startedAgain = await service.control('start');
    expect(startedAgain.changed).toBe(false);

    const resumed = await service.control('resume');
    expect(resumed.settings.automationState).toBe('running');
    expect(resumed.changed).toBe(false);

    const pausedNow = await service.control('pause');
    expect(pausedNow.changed).toBe(true);
    expect(pausedNow.settings.automationState).toBe('paused');
  });

  it('control() cannot create an impossible schedule', async () => {
    const service = new SettingsService(
      validSettings({ maxSlotsPerDay: 24 }),
      new InMemorySettingsStore(),
    );
    // 360 minutes apart with 24 slots cannot fit one day; it is refused outright.
    await expect(service.update({ intervalMinutes: 360 })).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
    expect(service.current().intervalMinutes).toBe(60);

    // Control still works from the last valid state.
    const started = await service.control('start');
    expect(started.settings.automationState).toBe('running');
    expect(started.settings.intervalMinutes).toBe(60);
  });

  it('loads persisted settings on init (restart-safe)', async () => {
    const store = new InMemorySettingsStore();
    const first = new SettingsService(DEFAULT_AUTOMATION_SETTINGS, store);
    await first.update({ intervalMinutes: 45, imageCountPolicy: 'one' });
    await first.control('start');

    // Simulate a backend restart with the same store.
    const second = new SettingsService(DEFAULT_AUTOMATION_SETTINGS, store);
    await second.init();
    expect(second.current().intervalMinutes).toBe(45);
    expect(second.current().imageCountPolicy).toBe('one');
    expect(second.current().automationState).toBe('running');
  });

  it('falls back to defaults with a warning when the persisted file is corrupt', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'settings.json');
      await writeFile(file, 'not json at all', 'utf8');
      const service = new SettingsService(
        DEFAULT_AUTOMATION_SETTINGS,
        new FileSettingsStore(file),
      );
      await expect(service.init()).resolves.toBeUndefined();
      expect(service.current()).toEqual(DEFAULT_AUTOMATION_SETTINGS);
      expect(service.loadWarning).toMatch(/invalid|JSON/i);
    });
  });

  it('init() is idempotent', async () => {
    const service = new SettingsService(DEFAULT_AUTOMATION_SETTINGS, new InMemorySettingsStore());
    await service.update({ intervalMinutes: 45 });
    await service.init();
    await service.init();
    expect(service.current().intervalMinutes).toBe(45);
  });
});

/* ========================================================================== */
/*  PART 6 §7/§10 — daily posting target and budgets                         */
/* ========================================================================== */

describe('PART 6 — daily posting target', () => {
  it('defaults to 4 posts per day', () => {
    expect(DEFAULT_AUTOMATION_SETTINGS.dailyPostTarget).toBe(4);
    expect(SETTINGS_CONSTRAINTS.defaultDailyPostTarget).toBe(4);
    expect(SETTINGS_CONSTRAINTS.minDailyPostTarget).toBe(3);
    expect(SETTINGS_CONSTRAINTS.maxDailyPostTarget).toBe(4);
  });

  it('accepts 3 and 4', async () => {
    const service = new SettingsService(DEFAULT_AUTOMATION_SETTINGS, new InMemorySettingsStore());
    await expect(service.update({ dailyPostTarget: 3 })).resolves.toMatchObject({
      dailyPostTarget: 3,
    });
    await expect(service.update({ dailyPostTarget: 4 })).resolves.toMatchObject({
      dailyPostTarget: 4,
    });
  });

  it('rejects values outside 3..4', async () => {
    const service = new SettingsService(DEFAULT_AUTOMATION_SETTINGS, new InMemorySettingsStore());
    for (const value of [0, 1, 2, 5, 24, -1]) {
      await expect(service.update({ dailyPostTarget: value })).rejects.toBeInstanceOf(
        SettingsValidationError,
      );
    }
    expect(service.current().dailyPostTarget).toBe(4);
  });

  it('rejects a non-integer target', async () => {
    const service = new SettingsService(DEFAULT_AUTOMATION_SETTINGS, new InMemorySettingsStore());
    await expect(service.update({ dailyPostTarget: 3.5 })).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
  });

  it('exposes the four WIB windows to the dashboard', () => {
    expect(SETTINGS_CONSTRAINTS.postingWindows).toEqual([
      '06:00-07:00 WIB',
      '12:00-13:00 WIB',
      '16:00-17:00 WIB',
      '19:00-20:00 WIB',
    ]);
  });

  it('persists the target across a restart', async () => {
    const store = new InMemorySettingsStore();
    const first = new SettingsService(DEFAULT_AUTOMATION_SETTINGS, store);
    await first.update({ dailyPostTarget: 3 });

    const second = new SettingsService(DEFAULT_AUTOMATION_SETTINGS, store);
    await second.init();
    expect(second.current().dailyPostTarget).toBe(3);
  });
});

describe('PART 6 §10 — generation budgets', () => {
  it('defaults to no configured budget (unlimited)', () => {
    expect(DEFAULT_AUTOMATION_SETTINGS.dailyBudgetUsd).toBeNull();
    expect(DEFAULT_AUTOMATION_SETTINGS.monthlyBudgetUsd).toBeNull();
  });

  it('accepts a positive budget and persists it', async () => {
    const store = new InMemorySettingsStore();
    const service = new SettingsService(DEFAULT_AUTOMATION_SETTINGS, store);
    await expect(
      service.update({ dailyBudgetUsd: 1.5, monthlyBudgetUsd: 25 }),
    ).resolves.toMatchObject({ dailyBudgetUsd: 1.5, monthlyBudgetUsd: 25 });

    const restarted = new SettingsService(DEFAULT_AUTOMATION_SETTINGS, store);
    await restarted.init();
    expect(restarted.current().dailyBudgetUsd).toBe(1.5);
    expect(restarted.current().monthlyBudgetUsd).toBe(25);
  });

  it('rejects a negative budget', async () => {
    const service = new SettingsService(DEFAULT_AUTOMATION_SETTINGS, new InMemorySettingsStore());
    await expect(service.update({ dailyBudgetUsd: -0.01 })).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
    await expect(service.update({ monthlyBudgetUsd: -1 })).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
  });

  it('accepts null to clear a budget', async () => {
    const service = new SettingsService(DEFAULT_AUTOMATION_SETTINGS, new InMemorySettingsStore());
    await service.update({ dailyBudgetUsd: 10 });
    await expect(service.update({ dailyBudgetUsd: null })).resolves.toMatchObject({
      dailyBudgetUsd: null,
    });
  });
});
