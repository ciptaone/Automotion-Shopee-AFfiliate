/**
 * Startup gate (Part 9 §4/§5) — "may this process serve production traffic?".
 *
 * Everything the boot path used to decide inline now lives here so every rule
 * is unit-testable without starting a server:
 *
 *   - postgres-backed boot requires a REACHABLE database and a CONSISTENT
 *     schema (applied, not pending, not diverged, no unknown records);
 *   - file/memory boot (development/test) is ready by definition — no
 *     production rule applies there;
 *   - production warnings surface settings that are legal but dangerous, so
 *     they are never silent (a loud warning + a persistent ops event, plus the
 *     PART 8 preflight blockers — boot never silently runs on mock AI).
 *
 * The gate NEVER performs network calls to AI providers or publishers and it
 * never prints a value — only key names and sanitized database detail.
 * `main.ts` acts on the result: `ok:false` => exit 78 (EX_CONFIG) after a
 * best-effort startup_failed ops event.
 */
import type { MigrationStatusReport } from '../db/migration-status.js';
import type { PersistenceBackend } from '../core/persistence.js';

/** The slice of the environment the gate reasons about. */
export interface StartupGateEnv {
  readonly NODE_ENV: 'development' | 'test' | 'production';
  readonly SCHEDULER_ENABLED: string;
  readonly SCHEDULER_MODE: string;
  readonly AI_IMAGE_PROVIDER: string;
  readonly AI_TEXT_PROVIDER: string;
}

/** Injected database surface (matches `DatabaseHandle`). */
export interface StartupGateDatabase {
  readonly configured: boolean;
  healthy(): Promise<boolean>;
  statusDetail(): Promise<string>;
  migrationStatus(): Promise<MigrationStatusReport | null>;
}

export interface StartupGateInput {
  readonly env: StartupGateEnv;
  readonly persistenceBackend: PersistenceBackend;
  readonly database: StartupGateDatabase;
}

export interface StartupGateResult {
  /** False means: refuse to start (exit 78). */
  readonly ok: boolean;
  /** Secret-free reasons the process must not start. */
  readonly problems: readonly string[];
  /** Secret-free "legal but dangerous in production" notes (logged loudly). */
  readonly warnings: readonly string[];
}

/**
 * Evaluate startup rules. Idempotent and side-effect free apart from the
 * injected database round-trips (one connectivity probe + one status read).
 */
export async function evaluateStartupGate(input: StartupGateInput): Promise<StartupGateResult> {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (input.persistenceBackend === 'postgres') {
    if (!input.database.configured) {
      // Defence in depth: env validation and persistence resolution already
      // refuse this combination; reaching it means they were bypassed.
      problems.push('PERSISTENCE_BACKEND is "postgres" but DATABASE_URL is not configured.');
    } else if (!(await input.database.healthy())) {
      problems.push(`database unreachable: ${await input.database.statusDetail()}`);
    } else {
      const migrations = await input.database.migrationStatus();
      if (!migrations) {
        problems.push('migration status could not be read from the database.');
      } else if (!migrations.consistent) {
        problems.push(`database schema is not up to date: ${migrations.problems.join('; ')}`);
      }
    }
  }

  /* --- Production warnings (never silent, never fatal) ------------------ */
  if (input.env.NODE_ENV === 'production') {
    const schedulerLoopEnabled =
      input.env.SCHEDULER_ENABLED === 'true' && input.env.SCHEDULER_MODE !== 'disabled';
    const mockImage = input.env.AI_IMAGE_PROVIDER === 'mock';
    const mockText = input.env.AI_TEXT_PROVIDER === 'mock';
    if (schedulerLoopEnabled && (mockImage || mockText)) {
      warnings.push(
        'production runs the scheduler loop with MOCK AI generation defaults ' +
          `(image=${input.env.AI_IMAGE_PROVIDER}, text=${input.env.AI_TEXT_PROVIDER}); ` +
          'select and test real providers before enabling automation (npm run preflight).',
      );
    }
  }

  return { ok: problems.length === 0, problems, warnings };
}
