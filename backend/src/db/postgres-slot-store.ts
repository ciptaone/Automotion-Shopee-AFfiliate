/**
 * PostgreSQL slot store (Part 5) — row-per-slot, version-guarded writes.
 *
 * The file/in-memory `SlotStore` persists whole snapshots. That is fine for a
 * single process, but it cannot express "two workers, one slot". This store
 * implements the same `SlotStore` contract PLUS an `atomic` capability that
 * `SlotContentStore` uses instead of snapshot saving:
 *
 *   refresh(slotKey)   — re-read one row so a mutation starts from DATABASE
 *                        truth, not from this process' possibly stale copy;
 *   write(record)      — insert-if-absent (the reservation race) or a
 *                        conditional `UPDATE ... WHERE version = <expected>`
 *                        (the stale-writer guard). The winner bumps `version`;
 *                        a loser updates 0 rows and receives the current row
 *                        instead of clobbering it.
 *
 * Consequences that matter for PART 5:
 *   - Two concurrent runs of the same slot cannot both reserve it: exactly one
 *     INSERT wins (`slot_contents_slot_key_idx` is UNIQUE).
 *   - A worker whose lease expired cannot overwrite a newer result: its
 *     version no longer matches, so `write` reports a conflict and the caller
 *     retries against the fresh state.
 *   - Nothing is written through a snapshot anymore, so a slow read can never
 *     resurrect an old record over a newer one.
 *
 * Storage of large binaries is NOT done here: `assets` holds object-storage
 * references + checksums + validation, exactly like the file store.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { ImageCountPolicy } from '../settings/automation-settings.js';
import { slotContents } from './schema.js';
import type { Database } from './client.js';
import type {
  AtomicSlotStore,
  AtomicSlotWriteOutcome,
  SlotAsset,
  SlotBlocker,
  SlotCaption,
  SlotContentRecord,
  SlotSelectionSnapshot,
  SlotStage,
  SlotStoreSnapshot,
} from '../automation/slot-store.js';

type Row = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/*  Row <-> record mapping                                                    */
/* -------------------------------------------------------------------------- */

function text(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function nullableIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function iso(value: unknown, fallback: string): string {
  return nullableIso(value) ?? fallback;
}

function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function jsonObject<T>(value: unknown): T | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as T;
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

/**
 * Read one row into a record.
 *
 * NOTE: Drizzle returns the SCHEMA PROPERTY names (camelCase), not the column
 * names — `select().from(slotContents)` yields `{ slotKey, productId, ... }`.
 * Reading `row.slot_key` here would silently produce `undefined` fields and a
 * record that looks loaded but is empty, which is exactly the class of bug
 * PART 5 exists to prevent. `tests/db/slot-store.test.ts` pins this down.
 */
export function rowToRecord(row: Row): SlotContentRecord {
  const createdAt = iso(row.createdAt, new Date(0).toISOString());
  return {
    slotKey: text(row.slotKey),
    stage: text(row.stage, 'reserved') as SlotStage,
    productId: nullableText(row.productId),
    sourceProductId: nullableText(row.sourceProductId),
    productName: nullableText(row.productName),
    affiliateUrl: nullableText(row.affiliateUrl),
    categoryId: nullableText(row.categoryId),
    imageCountPolicy: text(row.imageCountPolicy, 'random_1_or_2') as ImageCountPolicy,
    imageCount: Number(row.imageCount ?? 1),
    // The column is nullable for historical rows; the record contract is not.
    imageCountChosenAt: iso(row.imageCountChosenAt, createdAt),
    selection: jsonObject<SlotSelectionSnapshot>(row.selection),
    referenceImageUrl: nullableText(row.referenceImageUrl),
    generationRunId: text(row.generationRunId),
    assets: jsonArray<SlotAsset>(row.assets),
    captions: jsonArray<SlotCaption>(row.captions),
    validationPassed: row.validationPassed === true,
    blockers: jsonArray<SlotBlocker>(row.blockers),
    lastError: nullableText(row.lastError),
    attempts: Number(row.attempts ?? 0),
    createdAt,
    updatedAt: iso(row.updatedAt, createdAt),
    completedAt: nullableIso(row.completedAt),
  };
}

/**
 * Drizzle's timestamp columns call `value.toISOString()` — they need a real
 * `Date`, and an ISO string blows up at write time. Every timestamp therefore
 * crosses the driver boundary as `Date | null`.
 */
function toDateOrNull(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toDate(value: string | null | undefined, fallback: Date = new Date()): Date {
  return toDateOrNull(value) ?? fallback;
}

/**
 * Record -> `.values()` / `.set()` payload, again keyed by SCHEMA PROPERTY
 * names. Drizzle silently IGNORES unknown keys, so a snake_case object here
 * would insert `default` for every omitted column and the row would arrive
 * with a NULL `slot_key` — rejected by the NOT NULL constraint.
 */
function recordToValues(record: SlotContentRecord): Record<string, unknown> {
  return {
    slotKey: record.slotKey,
    stage: record.stage,
    productId: record.productId ?? null,
    sourceProductId: record.sourceProductId ?? null,
    productName: record.productName ?? null,
    affiliateUrl: record.affiliateUrl ?? null,
    categoryId: record.categoryId ?? null,
    imageCountPolicy: record.imageCountPolicy,
    imageCount: record.imageCount,
    imageCountChosenAt: toDateOrNull(record.imageCountChosenAt),
    selection: JSON.stringify(record.selection ?? null),
    referenceImageUrl: record.referenceImageUrl ?? null,
    generationRunId: record.generationRunId ?? null,
    assets: JSON.stringify(record.assets ?? []),
    captions: JSON.stringify(record.captions ?? []),
    validationPassed: record.validationPassed,
    blockers: JSON.stringify(record.blockers ?? []),
    lastError: record.lastError ?? null,
    attempts: record.attempts,
    createdAt: toDate(record.createdAt),
    updatedAt: toDate(record.updatedAt),
    completedAt: toDateOrNull(record.completedAt),
  };
}

/* -------------------------------------------------------------------------- */
/*  Store                                                                     */
/* -------------------------------------------------------------------------- */

export class PostgresSlotStore implements AtomicSlotStore {
  readonly kind = 'postgres' as const;
  readonly atomic = true as const;

  /** Optimistic versions, keyed by slot key (the write guard). */
  private readonly versions = new Map<string, number>();

  constructor(private readonly db: Database) {}

  async load(): Promise<SlotStoreSnapshot | null> {
    const rows = (await this.db
      .select()
      .from(slotContents)
      .orderBy(slotContents.updatedAt)) as unknown as Row[];
    this.versions.clear();
    const slots = rows.map((row) => {
      this.versions.set(text(row.slotKey), Number(row.version ?? 1));
      return rowToRecord(row);
    });
    return { version: 1, slots, updatedAt: new Date().toISOString() };
  }

  /**
   * Snapshot save is kept for interface compatibility only: the atomic path
   * writes rows one at a time through `write()`. If something does call this
   * (e.g. a future admin tool), it upserts rather than deleting — it can never
   * remove a row another process just created.
   */
  async save(snapshot: SlotStoreSnapshot): Promise<void> {
    for (const record of snapshot.slots) {
      await this.write(record);
    }
  }

  async refresh(slotKey: string): Promise<SlotContentRecord | null> {
    const rows = (await this.db
      .select()
      .from(slotContents)
      .where(eq(slotContents.slotKey, slotKey))
      .limit(1)) as unknown as Row[];
    const row = rows[0];
    if (!row) {
      this.versions.delete(slotKey);
      return null;
    }
    this.versions.set(slotKey, Number(row.version ?? 1));
    return rowToRecord(row);
  }

  /**
   * Insert-or-conditional-update.
   *
   *  - No local version  -> INSERT ... ON CONFLICT DO NOTHING. Winning the
   *    conflict means THIS caller performed the reservation.
   *  - Local version set -> UPDATE ... WHERE version = <expected>. Zero rows
   *    means somebody else committed first: re-read and report a conflict.
   */
  async write(record: SlotContentRecord): Promise<AtomicSlotWriteOutcome> {
    const expected = this.versions.get(record.slotKey);
    const values = recordToValues(record);

    if (expected === undefined) {
      const inserted = (await this.db
        .insert(slotContents)
        .values({ ...values, id: randomUUID(), version: 1 } as never)
        .onConflictDoNothing({ target: slotContents.slotKey })
        .returning({ slotKey: slotContents.slotKey, version: slotContents.version })) as unknown as Row[];

      if (inserted[0]) {
        this.versions.set(record.slotKey, Number(inserted[0].version ?? 1));
        return { ok: true, current: record };
      }
      // Conflict: someone else reserved it first. Report the fresh row.
      return { ok: false, current: await this.refresh(record.slotKey) };
    }

    const updated = (await this.db
      .update(slotContents)
      .set({ ...values, version: expected + 1, updatedAt: new Date() } as never)
      .where(sql`${slotContents.slotKey} = ${record.slotKey} and ${slotContents.version} = ${expected}`)
      .returning({ slotKey: slotContents.slotKey, version: slotContents.version })) as unknown as Row[];

    if (updated[0]) {
      this.versions.set(record.slotKey, Number(updated[0].version ?? expected + 1));
      return { ok: true, current: record };
    }
    return { ok: false, current: await this.refresh(record.slotKey) };
  }
}
