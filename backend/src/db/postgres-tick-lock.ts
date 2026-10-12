/**
 * Cross-process scheduler tick lock (Part 5).
 *
 * `ContentScheduler` already guarantees "a tick never overlaps itself" with an
 * in-process flag. That is worthless when two backend processes (or a dev box
 * plus a server) point at the same database: both would plan the same due
 * slots and both would try to execute them.
 *
 * A PostgreSQL advisory lock closes that gap. The lock is taken on ONE RESERVED
 * connection (advisory locks are session-scoped, so releasing must happen on
 * the same connection — that is exactly why `reserve()` is used instead of the
 * pooled query path). A second process that arrives while the lock is held gets
 * `false` from `acquire()` and turns its tick into a no-op.
 *
 * Failure mode: if the lock cannot be taken (connection error), `acquire()`
 * returns false — the tick is skipped and logged rather than run without the
 * protection. Skipping a tick is always safe: the next one re-plans.
 */
import postgres from 'postgres';

export interface SchedulerTickLock {
  /** Try to take the tick lock. `false` means another tick owns it right now. */
  acquire(): Promise<boolean>;
  /** Release the lock (no-op when not held). Must not throw on the happy path. */
  release(): Promise<void>;
}

/** A postgres.js connection reserved for this session (`release()` returns it). */
type ReservedConnection = postgres.Sql & { release(): void };

/** No-op lock used for single-process / in-memory deployments. */
export class NullSchedulerTickLock implements SchedulerTickLock {
  async acquire(): Promise<boolean> {
    return true;
  }
  async release(): Promise<void> {
    /* nothing held */
  }
}

export class PostgresSchedulerTickLock implements SchedulerTickLock {
  private connection: ReservedConnection | null = null;
  private held = false;

  constructor(
    private readonly sql: postgres.Sql,
    /** Human name of the lock; hashed to a 64-bit advisory lock key. */
    private readonly name = 'content_scheduler_tick',
  ) {}

  async acquire(): Promise<boolean> {
    if (this.held) return true;
    try {
      const connection = (await this.sql.reserve()) as unknown as ReservedConnection;
      const rows = (await connection`select pg_try_advisory_lock(hashtext(${this.name})) as locked`) as unknown as Array<{
        locked: boolean;
      }>;
      if (rows[0]?.locked === true) {
        this.connection = connection;
        this.held = true;
        return true;
      }
      connection.release();
      return false;
    } catch {
      // Never run an unprotected tick when the lock layer itself is broken.
      await this.release();
      return false;
    }
  }

  async release(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    const wasHeld = this.held;
    this.held = false;
    if (!connection) return;
    try {
      if (wasHeld) {
        await connection`select pg_advisory_unlock(hashtext(${this.name}))`;
      }
    } catch {
      /* the connection is going away anyway */
    } finally {
      try {
        connection.release();
      } catch {
        /* ignore */
      }
    }
  }
}
