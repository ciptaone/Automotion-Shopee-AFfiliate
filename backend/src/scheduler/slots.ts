/**
 * Scheduler foundation (Part 1).
 *
 * Responsibilities in THIS part:
 *  - Compute the daily publish SLOTS in a given IANA time zone (Asia/Jakarta),
 *    honoring the locked defaults: one product per 60 minutes, at most 24 slots
 *    per calendar day.
 *  - Emit deterministic, idempotent slot identities ("YYYY-MM-DD#NN") that feed
 *    the job queue's uniqueness key, so a slot can never be double-scheduled
 *    across restarts.
 *
 * Deliberately NOT implemented in Part 1 (deferred to the automation part):
 *  - actual product selection and content generation,
 *  - live dispatch to Facebook/Threads,
 *  - persistence of a run history.
 *
 * The slot math is pure and fully unit-tested.
 */

export interface SchedulerConfig {
  readonly timezone: string;
  readonly intervalMinutes: number;
  readonly maxSlotsPerDay: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  timezone: 'Asia/Jakarta',
  intervalMinutes: 60,
  maxSlotsPerDay: 24,
};

export interface Slot {
  /** Stable identity, e.g. "2026-10-12#03". Used as the job uniqueness key. */
  readonly key: string;
  readonly date: string;
  readonly index: number;
  /** Instant the slot fires, ISO-8601 with offset. */
  readonly scheduledFor: string;
  readonly timezone: string;
}

/* -------------------------------------------------------------------------- */
/*  Time-zone-safe date formatting                                            */
/* -------------------------------------------------------------------------- */

/**
 * Format an instant in a target IANA time zone as `YYYY-MM-DD`.
 *
 * Uses Intl with `en-CA`, which yields ISO-style `YYYY-MM-DD` ordering.
 */
export function formatInTimeZone(instant: Date, timeZone: string): string {
  // en-CA -> YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * Return the wall-clock hour-of-day (0-23) for an instant in a time zone.
 */
export function hourInTimeZone(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '0';
  // Intl can render midnight as "24" with hour12:false in some engines.
  const parsed = Number.parseInt(hour, 10);
  return parsed === 24 ? 0 : parsed;
}

/* -------------------------------------------------------------------------- */
/*  Slot computation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Compute the publish slots for a given calendar day in `config.timezone`.
 *
 * Slots start at 00:00 local and repeat every `intervalMinutes`. The count is
 * capped at `maxSlotsPerDay`, so a 60-minute interval yields at most 24 slots.
 *
 * @param dateKey Calendar day in `YYYY-MM-DD` form, interpreted in the config time zone.
 */
export function computeDailySlots(dateKey: string, config: SchedulerConfig): Slot[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error(`Invalid date key "${dateKey}"; expected YYYY-MM-DD`);
  }
  if (config.intervalMinutes <= 0) {
    throw new Error('intervalMinutes must be positive');
  }

  const slotsPerDay = Math.min(
    config.maxSlotsPerDay,
    Math.floor((24 * 60) / config.intervalMinutes),
  );

  const slots: Slot[] = [];
  for (let i = 0; i < slotsPerDay; i += 1) {
    const totalMinutes = i * config.intervalMinutes;
    const hour = Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    slots.push({
      key: `${dateKey}#${String(i + 1).padStart(2, '0')}`,
      date: dateKey,
      index: i + 1,
      // A pure wall-clock stamp with the zone's current numeric offset would
      // require tzdata; we emit local time + the zone id so consumers can
      // resolve the exact instant unambiguously.
      scheduledFor: `${dateKey}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${config.timezone}`,
      timezone: config.timezone,
    });
  }
  return slots;
}

/**
 * Resolve a wall-clock local time (`YYYY-MM-DDTHH:mm:ss`) in an IANA zone to a
 * UTC instant. Uses the two-pass offset technique via Intl, which is correct
 * across DST transitions for the zones we care about.
 */
export function localToUtc(localDateTime: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localDateTime);
  if (!match) {
    throw new Error(`Invalid local datetime "${localDateTime}"`);
  }
  const [, y, mo, d, h, mi, s] = match as unknown as string[];
  const naiveUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? '0'),
  );

  // Offset of the zone at that instant.
  const offset = tzOffsetMs(new Date(naiveUtc), timeZone);
  // First guess: subtract the offset.
  const guess = new Date(naiveUtc - offset);
  // Refine once in case the offset differs near a DST boundary.
  const offset2 = tzOffsetMs(guess, timeZone);
  if (offset2 !== offset) {
    return new Date(naiveUtc - offset2);
  }
  return guess;
}

/** Offset (ms) of `timeZone` relative to UTC at a given instant. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string): number =>
    Number.parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);

  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - instant.getTime();
}

/** Today's `YYYY-MM-DD` in the configured zone. */
export function todayKey(config: SchedulerConfig, now: Date = new Date()): string {
  return formatInTimeZone(now, config.timezone);
}

/**
 * Compute the NEXT slot strictly after `now`, scanning forward day by day.
 * Returns null if no slot can be found within `lookAheadDays`.
 */
export function nextSlot(
  config: SchedulerConfig,
  now: Date = new Date(),
  lookAheadDays = 7,
): Slot | null {
  const nowMs = now.getTime();
  let cursor = new Date(now);

  for (let day = 0; day <= lookAheadDays; day += 1) {
    const dateKey = formatInTimeZone(cursor, config.timezone);
    const slots = computeDailySlots(dateKey, config);
    for (const slot of slots) {
      const local = slot.scheduledFor.slice(0, slot.scheduledFor.length - config.timezone.length);
      const instant = localToUtc(local, config.timezone);
      if (instant.getTime() > nowMs) {
        return { ...slot, scheduledFor: instant.toISOString() };
      }
    }
    // Advance to the start of the next day.
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Scheduler status                                                          */
/* -------------------------------------------------------------------------- */

export interface SchedulerStatus {
  readonly enabled: boolean;
  readonly mode: string;
  readonly timezone: string;
  readonly intervalMinutes: number;
  readonly maxSlotsPerDay: number;
  readonly today: string;
  readonly slotsToday: number;
  readonly nextSlot: { readonly key: string; readonly scheduledFor: string } | null;
  readonly message: string;
}

export function describeSchedulerStatus(
  config: SchedulerConfig,
  enabled: boolean,
  mode: string,
  now: Date = new Date(),
): SchedulerStatus {
  const today = todayKey(config, now);
  const slots = computeDailySlots(today, config);
  const upcoming = nextSlot(config, now);
  return {
    enabled,
    mode,
    timezone: config.timezone,
    intervalMinutes: config.intervalMinutes,
    maxSlotsPerDay: config.maxSlotsPerDay,
    today,
    slotsToday: slots.length,
    nextSlot: upcoming ? { key: upcoming.key, scheduledFor: upcoming.scheduledFor } : null,
    message: enabled
      ? `Scheduler ${mode}: ${slots.length} slot(s) today, ${config.intervalMinutes}m apart (${config.timezone}).`
      : 'Scheduler is disabled. No jobs will be dispatched.',
  };
}
