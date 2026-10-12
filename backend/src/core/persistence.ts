/**
 * Persistence backend selection (Part 5).
 *
 * One question, answered in exactly one place: **where does this process
 * store its state?**
 *
 * The rules are deliberately conservative, because the dangerous failure mode
 * is silent: a production process that cannot reach PostgreSQL must NOT carry
 * on with a file store or an in-memory map and report success. So:
 *
 *   - `PERSISTENCE_BACKEND` pins the choice when set (explicit wins).
 *   - Otherwise it is derived: production -> postgres, test -> memory,
 *     development -> file.
 *   - `postgres` (explicit or derived) requires `DATABASE_URL`; if it is
 *     missing the decision carries an error and the process must exit with a
 *     clear, secret-free message instead of starting degraded.
 *   - `production` can never be file or memory (also enforced by env
 *     validation, so both layers agree).
 *
 * This module is pure: no I/O, no process.exit, no secrets. `env.ts` performs
 * the same invariants during validation (defence in depth), `main.ts` acts on
 * the returned errors, and the container reads `backend` to pick its stores.
 */

export const PERSISTENCE_BACKENDS = ['postgres', 'file', 'memory'] as const;
export type PersistenceBackend = (typeof PERSISTENCE_BACKENDS)[number];

export type NodeEnv = 'development' | 'test' | 'production';

export interface PersistenceInput {
  readonly nodeEnv: NodeEnv;
  /** Raw value from `PERSISTENCE_BACKEND` (undefined when unset). */
  readonly persistenceBackend?: PersistenceBackend | undefined;
  /** Raw value from `DATABASE_URL` (undefined when unset/empty). */
  readonly databaseUrl?: string | undefined;
}

export interface PersistenceDecision {
  readonly backend: PersistenceBackend;
  readonly source: 'explicit' | 'derived';
  /** Secret-free explanation, safe to log and to show in `/v1` payloads. */
  readonly reason: string;
  /** Non-empty means: refuse to start (fail closed). */
  readonly errors: readonly string[];
  /** Whether a connection URL was supplied (never the URL itself). */
  readonly hasDatabaseUrl: boolean;
}

/** Derive the backend for an environment that did not pin one. */
export function derivePersistenceBackend(nodeEnv: NodeEnv): PersistenceBackend {
  switch (nodeEnv) {
    case 'production':
      return 'postgres';
    case 'test':
      return 'memory';
    case 'development':
    default:
      return 'file';
  }
}

/**
 * Resolve the persistence backend and collect any fail-closed errors.
 *
 * Pure and side-effect free so it can be unit tested for every combination of
 * (nodeEnv, explicit backend, database URL present/absent).
 */
export function resolvePersistenceBackend(input: PersistenceInput): PersistenceDecision {
  const errors: string[] = [];
  const hasDatabaseUrl = Boolean(input.databaseUrl && input.databaseUrl.trim() !== '');
  const explicit = input.persistenceBackend;

  const backend = explicit ?? derivePersistenceBackend(input.nodeEnv);
  const source: PersistenceDecision['source'] = explicit ? 'explicit' : 'derived';

  if (input.nodeEnv === 'production' && backend !== 'postgres') {
    errors.push(
      `PERSISTENCE_BACKEND is "${backend}" but production requires "postgres" -- ` +
        'refusing to run production on file/in-memory storage.',
    );
  }

  if (backend === 'postgres' && !hasDatabaseUrl) {
    errors.push(
      'DATABASE_URL is required for the "postgres" persistence backend ' +
        '(set it server-side; never commit it).',
    );
  }

  const reason = explicit
    ? `PERSISTENCE_BACKEND="${explicit}" was set explicitly.`
    : `derived from NODE_ENV=${input.nodeEnv}.`;

  return {
    backend,
    source,
    reason,
    errors,
    hasDatabaseUrl,
  };
}

/** Human-readable summary for startup logs (contains no credentials). */
export function describePersistence(decision: PersistenceDecision): string {
  const state = decision.errors.length === 0 ? 'ok' : 'invalid';
  return `persistence=${decision.backend} (${decision.source}: ${decision.reason}) status=${state}`;
}
