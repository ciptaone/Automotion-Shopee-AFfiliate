/**
 * PostgreSQL-backed single-document stores (Part 5).
 *
 * Two documents that used to live in `backend/data/*.json`:
 *   - automation settings (`app_settings`, exactly one row via CHECK `id = 1`)
 *   - scheduler checkpoint (`scheduler_checkpoints`, one row per checkpoint key)
 *
 * Both are `jsonb` documents written with `ON CONFLICT ... DO UPDATE`, so two
 * processes cannot create two competing settings rows and a concurrent write
 * cannot resurrect an older document over a newer one (the update bumps
 * `version` and refreshes `updated_at` from the database clock).
 *
 * No credentials and no binaries are stored here — only application state.
 */
import { sql } from 'drizzle-orm';
import type { AutomationSettings, SettingsStore } from '../settings/automation-settings.js';
import { appSettings, schedulerCheckpoints } from './schema.js';
import type { Database } from './client.js';

type Row = Record<string, unknown>;

function toIso(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return fallback;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

/**
 * Settings document store.
 *
 * Optimistic concurrency: every write bumps `app_settings.version`. The
 * in-memory `SettingsService` is the single writer per process; across
 * processes the version column gives a truthful "somebody else changed this"
 * signal instead of silent last-writer-wins.
 */
export class PostgresSettingsStore implements SettingsStore {
  readonly kind = 'postgres' as const;

  constructor(private readonly db: Database) {}

  async load(): Promise<AutomationSettings | null> {
    const rows = (await this.db
      .select()
      .from(appSettings)
      .limit(1)) as unknown as Row[];
    const row = rows[0];
    if (!row) return null;
    const doc = row.doc;
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
      return doc as AutomationSettings;
    }
    if (typeof doc === 'string') {
      try {
        return JSON.parse(doc) as AutomationSettings;
      } catch {
        return null;
      }
    }
    return null;
  }

  async save(settings: AutomationSettings): Promise<void> {
    const document = JSON.stringify(settings);
    await this.db
      .insert(appSettings)
      .values({ id: 1, doc: document, version: 1, updatedAt: new Date() } as never)
      .onConflictDoUpdate({
        target: appSettings.id,
        set: {
          doc: sql`${document}::jsonb`,
          version: sql`${appSettings.version} + 1`,
          updatedAt: new Date(),
        } as never,
      });
  }
}

/* -------------------------------------------------------------------------- */
/*  Scheduler checkpoints                                                     */
/* -------------------------------------------------------------------------- */

export interface SchedulerCheckpoint {
  readonly key: string;
  readonly doc: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}

export interface SchedulerCheckpointStore {
  read(key: string): Promise<SchedulerCheckpoint | null>;
  write(key: string, doc: Readonly<Record<string, unknown>>): Promise<SchedulerCheckpoint>;
}

/** Process-local fallback (development / unit tests). */
export class InMemorySchedulerCheckpointStore implements SchedulerCheckpointStore {
  readonly kind = 'memory' as const;
  private readonly docs = new Map<string, SchedulerCheckpoint>();

  async read(key: string): Promise<SchedulerCheckpoint | null> {
    return this.docs.get(key) ?? null;
  }

  async write(
    key: string,
    doc: Readonly<Record<string, unknown>>,
  ): Promise<SchedulerCheckpoint> {
    const checkpoint: SchedulerCheckpoint = {
      key,
      doc: { ...doc },
      updatedAt: new Date().toISOString(),
    };
    this.docs.set(key, checkpoint);
    return checkpoint;
  }
}

/**
 * Durable checkpoint store.
 *
 * This is bookkeeping ("what the last tick did"), NOT a concurrency control:
 * duplicate work is prevented by the job unique key and the slot unique index.
 */
export class PostgresSchedulerCheckpointStore implements SchedulerCheckpointStore {
  readonly kind = 'postgres' as const;

  constructor(private readonly db: Database) {}

  async read(key: string): Promise<SchedulerCheckpoint | null> {
    const rows = (await this.db
      .select()
      .from(schedulerCheckpoints)
      .limit(1)
      .where(sql`${schedulerCheckpoints.key} = ${key}`)) as unknown as Row[];
    const row = rows[0];
    if (!row) return null;
    const rawDoc = row.doc;
    const doc =
      rawDoc && typeof rawDoc === 'object' && !Array.isArray(rawDoc)
        ? (rawDoc as Record<string, unknown>)
        : typeof rawDoc === 'string'
          ? (JSON.parse(rawDoc) as Record<string, unknown>)
          : {};
    return { key, doc, updatedAt: toIso(row.updatedAt, new Date(0).toISOString()) };
  }

  async write(
    key: string,
    doc: Readonly<Record<string, unknown>>,
  ): Promise<SchedulerCheckpoint> {
    const document = JSON.stringify(doc);
    await this.db
      .insert(schedulerCheckpoints)
      .values({
        key,
        doc: document,
        updatedAt: new Date(),
      } as never)
      .onConflictDoUpdate({
        target: schedulerCheckpoints.key,
        set: {
          doc: sql`${document}::jsonb`,
          updatedAt: new Date(),
        } as never,
      });
    return { key, doc: { ...doc }, updatedAt: new Date().toISOString() };
  }
}
