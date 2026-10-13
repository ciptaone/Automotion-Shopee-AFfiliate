/**
 * Two backends, one database (PART 5).
 *
 * Every test here builds TWO independent "processes" — separate pools,
 * separate in-memory caches, separate locks — against the same PostgreSQL, and
 * then lets them collide:
 *
 *   - concurrent ticks must not create duplicate jobs;
 *   - the advisory tick lock turns the loser's tick into a no-op;
 *   - anti-catch-up still limits a tick to one slot after downtime;
 *   - no sequence of concurrent ticks can exceed the daily posting target
 *     (PART 6 §7: 3–4 WIB windows per day);
 *   - the Jakarta day boundary is used (UTC date is not);
 *   - each tick writes a durable checkpoint.
 *
 * No publishing, no credentials, mock AI providers only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresSchedulerTickLock } from '../../src/db/postgres-tick-lock.js';
import { seedCatalog, startTestProcess, type TestProcess } from './harness.js';
import { openTestDatabase, resetDatabase, type TestDatabase } from './helpers.js';

/** The name every process in this suite contends for. */
const TICK_LOCK_NAME = 'test_content_scheduler_tick';

/**
 * A controlled instant at 23:00 Asia/Jakarta (16:00Z) on the PREVIOUS Jakarta
 * day — i.e. every slot of that day has fired, but the instant is always in
 * the past.
 *
 * It has to be in the past: `claim()` compares `scheduled_for` with the
 * DATABASE clock, so a fixed future timestamp would enqueue a slot that simply
 * cannot be claimed yet and the test would silently assert nothing.
 */
function endOfPreviousJakartaDay(): { now: Date; date: string } {
  // Jakarta is UTC+7 all year (no DST): shifting by +7h gives the UTC instant
  // whose calendar date equals the Jakarta date of (now - 24h).
  const reference = new Date(Date.now() - 86_400_000 + 7 * 3_600_000);
  const date = reference.toISOString().slice(0, 10);
  return { now: new Date(`${date}T16:00:00.000Z`), date };
}

/**
 * 23:30Z on day D is 06:30 on D+1 in Asia/Jakarta: the UTC calendar day and
 * the Jakarta calendar day DISAGREE, which is exactly what the timezone test
 * is for. It also lands INSIDE the first posting window (06:00-07:00 WIB), so
 * the 06:00 WIB slot of the Jakarta day is due. Anchored in the past so the
 * slot is claimable.
 */
function earlyMorningInJakarta(): { now: Date; utcDate: string; jakartaDate: string } {
  const reference = new Date(Date.now() - 86_400_000 + 7 * 3_600_000);
  const utcDate = reference.toISOString().slice(0, 10);
  const now = new Date(`${utcDate}T23:30:00.000Z`);
  const jakartaDate = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  return { now, utcDate, jakartaDate };
}

afterAll(() => {
  /* per-test processes are closed in their own finally blocks */
});

/**
 * Boot two fresh processes over a clean database, run the body, then tear
 * everything down. `boot` is a third handle used only for assertions.
 */
async function withTwoProcesses<T>(
  body: (a: TestProcess, b: TestProcess, boot: TestDatabase) => Promise<T>,
  options: { now?: () => Date } = {},
): Promise<T> {
  const boot = openTestDatabase();
  await resetDatabase(boot.db);
  const a = await startTestProcess(options);
  await seedCatalog(a);
  const b = await startTestProcess(options);
  try {
    return await body(a, b, boot);
  } finally {
    await a.close();
    await b.close();
    await boot.close();
  }
}

async function jobRows(boot: TestDatabase, datePrefix?: string): Promise<Record<string, unknown>[]> {
  const like = datePrefix ? ` where unique_key like $1` : '';
  const params = datePrefix ? [`content:${datePrefix}%`] : [];
  return (await boot.raw.unsafe(
    `select id, unique_key, status, attempts from jobs${like} order by unique_key`,
    params as never[],
  )) as unknown as Record<string, unknown>[];
}

describe('concurrent ticks in two processes', () => {
  it('never creates duplicate jobs and never executes one slot twice', async () => {
    await withTwoProcesses(async (a, b, boot) => {
      const [resultA, resultB] = await Promise.all([a.scheduler.tick(), b.scheduler.tick()]);

      const jobs = await jobRows(boot);
      expect(jobs.length).toBeGreaterThanOrEqual(1);
      expect(jobs.length).toBeLessThanOrEqual(4); // PART 6 §7: 3–4 windows/day

      const keys = jobs.map((job) => String(job.unique_key));
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) expect(key.startsWith('content:')).toBe(true);

      // Job identity is the slot key: content:<slotKey>.
      for (const key of keys) {
        expect(key).toMatch(/^content:\d{4}-\d{2}-\d{2}#\d{2}$/);
      }

      // No slot was executed by both processes.
      const executed = [...resultA.executed, ...resultB.executed].map((entry) => entry.slotKey);
      expect(new Set(executed).size).toBe(executed.length);

      // Only one row per executed slot.
      const slotRows = (await boot.raw.unsafe(
        `select slot_key, count(*)::int as count from slot_contents group by slot_key`,
      )) as unknown as { slot_key: string; count: number }[];
      for (const row of slotRows) expect(row.count).toBe(1);
    });
  });

  it('writes exactly one durable checkpoint for the contended key', async () => {
    await withTwoProcesses(async (a, b, boot) => {
      await Promise.all([a.scheduler.tick(), b.scheduler.tick()]);

      const rows = (await boot.raw.unsafe(
        `select key, doc from scheduler_checkpoints`,
      )) as unknown as { key: string; doc: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.key).toBe('content_scheduler');

      const doc = JSON.parse(rows[0]!.doc) as Record<string, unknown>;
      expect(typeof doc.at).toBe('string');
      expect(typeof doc.executed).toBe('number');
      expect(typeof doc.catchUpLimit).toBe('number');
    });
  });
});

describe('cross-process tick lock', () => {
  it('skips a tick taken while another process holds the advisory lock', async () => {
    await withTwoProcesses(async (a, b, boot) => {
      const lock = new PostgresSchedulerTickLock(boot.raw, TICK_LOCK_NAME);
      expect(await lock.acquire()).toBe(true);
      try {
        const result = await b.scheduler.tick();
        expect(result.message).toMatch(/scheduler tick lock/i);
        expect(result.enqueued).toHaveLength(0);
        expect(result.executed).toHaveLength(0);
        expect(await jobRows(boot)).toHaveLength(0);
      } finally {
        await lock.release();
      }

      // Once released, the very same process ticks normally.
      const free = await b.scheduler.tick();
      expect(free.enqueued.length + free.executed.length).toBeGreaterThan(0);
      expect((await jobRows(boot)).length).toBeGreaterThan(0);
    });
  });
});

describe('anti-catch-up and the daily cap', () => {
  it('after downtime a tick runs ONE slot, not the whole day', async () => {
    // 23:00 Asia/Jakarta: every slot of that day has fired, so 23 of them are
    // overdue — and exactly one of them may run.
    const { now, date } = endOfPreviousJakartaDay();
    await withTwoProcesses(
      async (a, b, boot) => {
        const result = await a.scheduler.tick();

        expect(result.today).toBe(date);
        expect(result.executed).toHaveLength(1);
        expect(result.enqueued).toHaveLength(1);
        const catchUpSkips = result.skipped.filter((entry) => entry.reason === 'catch_up_limited');
        // Four windows per day; one may run, the other three are skipped.
        expect(catchUpSkips).toHaveLength(3);

        expect(await jobRows(boot, date)).toHaveLength(1);
        const slotRows = (await boot.raw.unsafe(
          `select count(*)::int as count from slot_contents`,
        )) as unknown as { count: number }[];
        expect(slotRows[0]!.count).toBe(1);
      },
      { now: () => now },
    );
  });

  it('no sequence of concurrent ticks can exceed the daily posting target', async () => {
    const { now, date } = endOfPreviousJakartaDay();
    await withTwoProcesses(
      async (a, b, boot) => {
        // Five rounds of BOTH processes ticking at the same instant.
        for (let round = 0; round < 5; round += 1) {
          await Promise.all([a.scheduler.tick(), b.scheduler.tick()]);
        }

        const jobs = await jobRows(boot, date);
        expect(jobs.length).toBeGreaterThanOrEqual(1);
        expect(jobs.length).toBeLessThanOrEqual(4); // PART 6 §7: at most the target

        const slots = (await boot.raw.unsafe(
          `select slot_key, count(*)::int as count from slot_contents group by slot_key`,
        )) as unknown as { slot_key: string; count: number }[];
        expect(slots.length).toBeLessThanOrEqual(4);
        for (const row of slots) expect(row.count).toBe(1);
      },
      { now: () => now },
    );
  });

  it('a tick runs at most one slot (anti-catch-up), scheduled at a WIB window', async () => {
    const { now, date } = endOfPreviousJakartaDay();
    await withTwoProcesses(
      async (a, b, boot) => {
        const result = await a.scheduler.tick();
        expect(String(result.executed[0]?.slotKey)).toMatch(new RegExp(`^${date}#\\d{2}$`));
        const jobs = await jobRows(boot, date);
        expect(jobs).toHaveLength(1);
      },
      { now: () => now },
    );
  });
});

describe('timezone: Asia/Jakarta boundaries, DST-independent', () => {
  it('uses the Jakarta calendar day, not the UTC day', async () => {
    // 18:00 UTC on day D == 01:00 on D+1 in Asia/Jakarta (UTC+7, no DST), so
    // the two calendar dates disagree by construction.
    const { now, utcDate, jakartaDate } = earlyMorningInJakarta();
    expect(jakartaDate).not.toBe(utcDate);

    await withTwoProcesses(
      async (a, b, boot) => {
        const result = await a.scheduler.tick();
        expect(result.today).toBe(jakartaDate);
        expect(result.executed).toHaveLength(1);
        expect(result.executed[0]?.slotKey.startsWith(`${jakartaDate}#`)).toBe(true);

        // Nothing from the previous UTC day leaks in.
        expect(await jobRows(boot, utcDate)).toHaveLength(0);
        expect(await jobRows(boot, jakartaDate)).toHaveLength(1);
      },
      { now: () => now },
    );
  });
});

describe('job identity survives every restart', () => {
  it('a second tick never produces a second logical job for the same slot', async () => {
    await withTwoProcesses(async (a, b, boot) => {
      await a.scheduler.tick();
      const first = await jobRows(boot);
      expect(first).toHaveLength(1);

      // Another tick, later, in a process that has just been restarted.
      const fresh = await startTestProcess();
      try {
        await fresh.scheduler.tick();
        const second = await jobRows(boot);
        expect(second).toHaveLength(1);
        expect(second[0]!.id).toBe(first[0]!.id);
        expect(second[0]!.unique_key).toBe(first[0]!.unique_key);
      } finally {
        await fresh.close();
      }
    });
  });
});
