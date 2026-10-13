/**
 * PART 8 §6/§7 — operational events, alert deduplication and cooldowns.
 *
 * Delivery semantics (documented, deliberately NOT exactly-once):
 *  - Every occurrence is DURABLY recorded in `ops_events` (one row per
 *    fingerprint; repeats bump `occurrences`/`last_seen_at`).
 *  - A notification is attempted at most once per cooldown window. The claim
 *    is a conditional UPDATE, so two concurrent processes cannot both claim.
 *  - Delivery is best-effort: Telegram being down never loses the event (the
 *    row survives with `last_delivery_status = 'failed'`), but a crash between
 *    a successful send and `markDelivery` can produce a duplicate later.
 *    Exactly-once external delivery is NOT claimed.
 *  - Failures are NEVER fed back in as new events — `record()` swallows and
 *    logs its own errors, so notification delivery can never recurse.
 *
 * Text hygiene: titles/details are redacted (`redactString`) and bounded
 * before they ever reach storage or a transport. Callers must still pass only
 * operational context (error codes, counts) — never prompts, product data or
 * raw provider bodies.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Logger } from '../core/logger.js';
import { redactString } from '../core/redact.js';
import type { Database } from '../db/client.js';

/* -------------------------------------------------------------------------- */
/*  Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

export const OPS_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type OpsSeverity = (typeof OPS_SEVERITIES)[number];

/** Canonical event kinds (stable metric/label cardinality — no job ids). */
export const OPS_EVENT_KINDS = [
  'scheduler_tick_failed',
  'scheduler_stale',
  'generation_job_failed',
  'recovery_performed',
  'database_unavailable',
  'migration_drift',
  'migration_pending',
  'budget_threshold',
  'budget_exhausted',
  'provider_auth_failed',
  'provider_capability_unsupported',
  'queue_degraded',
  'storage_unavailable',
  'automation_paused',
] as const;
export type OpsEventKind = (typeof OPS_EVENT_KINDS)[number];

/** Default cooldown windows per severity (§6 deduplication). */
export const DEFAULT_COOLDOWN_MS: Readonly<Record<OpsSeverity, number>> = {
  info: 30 * 60_000,
  warning: 30 * 60_000,
  critical: 15 * 60_000,
};

const TITLE_MAX = 200;
const DETAIL_MAX = 600;
const FINGERPRINT_MAX = 255;

/* -------------------------------------------------------------------------- */
/*  Contracts                                                                  */
/* -------------------------------------------------------------------------- */

export interface OpsEventInput {
  readonly kind: OpsEventKind | (string & {});
  readonly severity: OpsSeverity;
  /** Single-line, operational. Redacted + bounded by the monitor. */
  readonly title: string;
  /** Optional bounded context (codes, counts, slot keys). Redacted too. */
  readonly detail?: string;
  /** Optional stable scope folded into the fingerprint (e.g. a slot key). */
  readonly scope?: string;
  /** Per-event cooldown override; defaults to DEFAULT_COOLDOWN_MS[severity]. */
  readonly cooldownMs?: number;
}

export interface EventDeliveryResult {
  /** True ONLY when the transport confirmed success. */
  readonly delivered: boolean;
  readonly status: 'sent' | 'failed' | 'not_configured' | 'skipped';
  readonly messageId?: string | null;
  /** Sanitized error code (never a raw body or token). */
  readonly errorCode?: string | null;
}

/** What the monitor asks the transport layer to do (implemented by Telegram). */
export interface EventNotifier {
  notifyEvent(event: {
    readonly fingerprint: string;
    readonly kind: string;
    readonly severity: OpsSeverity;
    readonly title: string;
    readonly detail: string;
  }): Promise<EventDeliveryResult>;
}

export interface StoredOpsEvent {
  readonly fingerprint: string;
  readonly kind: string;
  readonly severity: OpsSeverity;
  readonly title: string;
  readonly detail: string | null;
  readonly occurrences: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly cooldownUntil: string | null;
  readonly lastDeliveryStatus: string;
  readonly lastErrorCode: string | null;
  readonly lastMessageId: string | null;
  readonly lastNotifiedAt: string | null;
}

export interface OpsEventStore {
  readonly persistence: 'memory' | 'postgres';
  /** Concurrency-safe upsert by fingerprint. */
  upsert(event: {
    fingerprint: string;
    kind: string;
    severity: OpsSeverity;
    title: string;
    detail: string | null;
  }): Promise<{ occurrences: number; firstSeenAt: string; lastSeenAt: string; isNew: boolean }>;
  /** Atomic claim: succeeds only when the fingerprint's cooldown has expired. */
  claimNotify(fingerprint: string, cooldownUntil: Date): Promise<boolean>;
  /** Record exactly what the transport reported. Never upgrades failures to sent. */
  markDelivery(
    fingerprint: string,
    result: EventDeliveryResult,
    at: Date,
  ): Promise<void>;
  /** Newest-first operational feed for the dashboard (bounded). */
  recent(limit: number): Promise<readonly StoredOpsEvent[]>;
  /** Bounded retention: drop rows last seen before `olderThan`, then keep only
   *  the newest `maxPerKind` rows per kind. Returns rows deleted. */
  cleanup(options: { olderThan: Date; maxPerKind: number }): Promise<{ deleted: number }>;
}

/* -------------------------------------------------------------------------- */
/*  In-memory store (development + deterministic tests)                        */
/* -------------------------------------------------------------------------- */

export class InMemoryOpsEventStore implements OpsEventStore {
  readonly persistence = 'memory' as const;
  private readonly rows = new Map<string, StoredOpsEvent>();

  async upsert(event: {
    fingerprint: string;
    kind: string;
    severity: OpsSeverity;
    title: string;
    detail: string | null;
  }): Promise<{ occurrences: number; firstSeenAt: string; lastSeenAt: string; isNew: boolean }> {
    const now = new Date().toISOString();
    const existing = this.rows.get(event.fingerprint);
    if (!existing) {
      this.rows.set(event.fingerprint, {
        fingerprint: event.fingerprint,
        kind: event.kind,
        severity: event.severity,
        title: event.title,
        detail: event.detail,
        occurrences: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        cooldownUntil: null,
        lastDeliveryStatus: 'not_sent',
        lastErrorCode: null,
        lastMessageId: null,
        lastNotifiedAt: null,
      });
      return { occurrences: 1, firstSeenAt: now, lastSeenAt: now, isNew: true };
    }
    const updated: StoredOpsEvent = {
      ...existing,
      severity: event.severity,
      title: event.title,
      detail: event.detail,
      occurrences: existing.occurrences + 1,
      lastSeenAt: now,
    };
    this.rows.set(event.fingerprint, updated);
    return {
      occurrences: updated.occurrences,
      firstSeenAt: updated.firstSeenAt,
      lastSeenAt: updated.lastSeenAt,
      isNew: false,
    };
  }

  async claimNotify(fingerprint: string, cooldownUntil: Date): Promise<boolean> {
    const row = this.rows.get(fingerprint);
    if (!row) return false;
    const nowMs = Date.now();
    if (row.cooldownUntil !== null && Date.parse(row.cooldownUntil) > nowMs) {
      return false; // still cooling down
    }
    this.rows.set(fingerprint, {
      ...row,
      cooldownUntil: cooldownUntil.toISOString(),
      lastNotifiedAt: new Date(nowMs).toISOString(),
    });
    return true;
  }

  async markDelivery(
    fingerprint: string,
    result: EventDeliveryResult,
    at: Date,
  ): Promise<void> {
    const row = this.rows.get(fingerprint);
    if (!row) return;
    this.rows.set(fingerprint, {
      ...row,
      lastDeliveryStatus: result.status,
      lastErrorCode: result.errorCode ?? null,
      // A later failure never erases the last CONFIRMED message id.
      lastMessageId: result.messageId ?? row.lastMessageId,
      lastNotifiedAt: result.delivered ? at.toISOString() : row.lastNotifiedAt,
    });
  }

  async recent(limit: number): Promise<readonly StoredOpsEvent[]> {
    return [...this.rows.values()]
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
      .slice(0, Math.max(1, Math.min(limit, 500)));
  }

  async cleanup(options: { olderThan: Date; maxPerKind: number }): Promise<{ deleted: number }> {
    let deleted = 0;
    for (const [fingerprint, row] of this.rows) {
      if (Date.parse(row.lastSeenAt) < options.olderThan.getTime()) {
        this.rows.delete(fingerprint);
        deleted += 1;
      }
    }
    const byKind = new Map<string, StoredOpsEvent[]>();
    for (const row of this.rows.values()) {
      const list = byKind.get(row.kind) ?? [];
      list.push(row);
      byKind.set(row.kind, list);
    }
    for (const list of byKind.values()) {
      list.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
      for (const row of list.slice(Math.max(1, options.maxPerKind))) {
        this.rows.delete(row.fingerprint);
        deleted += 1;
      }
    }
    return { deleted };
  }

  /** Test helper. */
  get(fingerprint: string): StoredOpsEvent | null {
    return this.rows.get(fingerprint) ?? null;
  }
}

/* -------------------------------------------------------------------------- */
/*  PostgreSQL store (durable; concurrency-safe via row locks)                 */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value.includes('T') && !/(Z|[+-]\d{2}:?\d{2})$/.test(value) ? `${value}Z` : value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}

export class PostgresOpsEventStore implements OpsEventStore {
  readonly persistence = 'postgres' as const;
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  private async rows(query: Parameters<Database['execute']>[0]): Promise<Row[]> {
    const result = (await this.db.execute(query)) as unknown;
    if (Array.isArray(result)) return result as Row[];
    const maybeRows = (result as { rows?: unknown } | null)?.rows;
    return Array.isArray(maybeRows) ? (maybeRows as Row[]) : [];
  }

  async upsert(event: {
    fingerprint: string;
    kind: string;
    severity: OpsSeverity;
    title: string;
    detail: string | null;
  }): Promise<{ occurrences: number; firstSeenAt: string; lastSeenAt: string; isNew: boolean }> {
    // `xmax = 0` distinguishes an INSERT from an UPDATE in the RETURNING row.
    const rows = await this.rows(sql`
      insert into ops_events (id, fingerprint, kind, severity, title, detail)
      values (${randomUUID()}, ${event.fingerprint}, ${event.kind}, ${event.severity},
              ${event.title}, ${event.detail})
      on conflict (fingerprint) do update set
        occurrences = ops_events.occurrences + 1,
        last_seen_at = now(),
        severity = excluded.severity,
        title = excluded.title,
        detail = excluded.detail
      returning fingerprint, occurrences, first_seen_at, last_seen_at, (xmax = 0) as inserted`);
    const row = rows[0] ?? {};
    return {
      occurrences: Number(row.occurrences ?? 1),
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
      isNew: Boolean(row.inserted),
    };
  }

  async claimNotify(fingerprint: string, cooldownUntil: Date): Promise<boolean> {
    // Conditional claim: the row lock serialises concurrent claimants, and the
    // WHERE clause keeps the loser out — only one process per cooldown window.
    const rows = await this.rows(sql`
      update ops_events
      set cooldown_until = ${cooldownUntil.toISOString()}::timestamptz,
          last_notified_at = now()
      where fingerprint = ${fingerprint}
        and (cooldown_until is null or cooldown_until <= now())
      returning fingerprint`);
    return rows.length > 0;
  }

  async markDelivery(fingerprint: string, result: EventDeliveryResult, at: Date): Promise<void> {
    // A failed delivery must never erase the previous successful timestamp:
    // `last_notified_at` only advances when the transport actually confirmed.
    await this.rows(sql`
      update ops_events
      set last_delivery_status = ${result.status},
          last_error_code = ${result.errorCode ?? null},
          last_message_id = coalesce(${result.messageId ?? null}::text, last_message_id),
          last_notified_at = case when ${result.delivered}::boolean
                                  then ${at.toISOString()}::timestamptz
                                  else last_notified_at end
      where fingerprint = ${fingerprint}`);
  }

  async recent(limit: number): Promise<readonly StoredOpsEvent[]> {
    const bounded = Math.max(1, Math.min(limit, 500));
    const rows = await this.rows(sql`
      select fingerprint, kind, severity, title, detail, occurrences,
             first_seen_at, last_seen_at, cooldown_until,
             last_delivery_status, last_error_code, last_message_id, last_notified_at
      from ops_events
      order by last_seen_at desc
      limit ${bounded}`);
    return rows.map((row) => ({
      fingerprint: String(row.fingerprint),
      kind: String(row.kind),
      severity: String(row.severity) as OpsSeverity,
      title: String(row.title),
      detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
      occurrences: Number(row.occurrences ?? 1),
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt: iso(row.last_seen_at),
      cooldownUntil:
        row.cooldown_until === null || row.cooldown_until === undefined ? null : iso(row.cooldown_until),
      lastDeliveryStatus: String(row.last_delivery_status ?? 'not_sent'),
      lastErrorCode:
        row.last_error_code === null || row.last_error_code === undefined
          ? null
          : String(row.last_error_code),
      lastMessageId:
        row.last_message_id === null || row.last_message_id === undefined
          ? null
          : String(row.last_message_id),
      lastNotifiedAt:
        row.last_notified_at === null || row.last_notified_at === undefined
          ? null
          : iso(row.last_notified_at),
    }));
  }

  async cleanup(options: { olderThan: Date; maxPerKind: number }): Promise<{ deleted: number }> {
    const aged = await this.rows(sql`
      delete from ops_events
      where last_seen_at < ${options.olderThan.toISOString()}::timestamptz
      returning fingerprint`);
    const overflow = await this.rows(sql`
      delete from ops_events
      where id in (
        select id from (
          select id, row_number() over (partition by kind order by last_seen_at desc) as rn
          from ops_events
        ) ranked
        where ranked.rn > ${Math.max(1, options.maxPerKind)}
      )
      returning fingerprint`);
    return { deleted: aged.length + overflow.length };
  }
}

/* -------------------------------------------------------------------------- */
/*  Monitor                                                                    */
/* -------------------------------------------------------------------------- */

export interface OpsMonitorDeps {
  readonly store: OpsEventStore;
  /** Optional transport layer; when absent events are recorded but not sent. */
  readonly notifier?: EventNotifier | null;
  readonly defaultCooldownMs?: Readonly<Record<OpsSeverity, number>>;
  readonly logger?: Logger;
}

export interface OpsEventOutcome {
  readonly fingerprint: string;
  readonly isNew: boolean;
  readonly occurrences: number;
  /** True when THIS call claimed the cooldown window and attempted delivery. */
  readonly notifyAttempted: boolean;
  readonly delivery: EventDeliveryResult | null;
}

/** Bounded, single-line, redacted text. Never throws. */
export function sanitizeEventText(text: string, max: number): string {
  const oneLine = redactString(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function fingerprintOf(kind: string, scope?: string): string {
  const base = scope ? `${kind}:${scope}` : kind;
  return base.length > FINGERPRINT_MAX ? base.slice(0, FINGERPRINT_MAX) : base;
}

export class OpsMonitor {
  private readonly store: OpsEventStore;
  private readonly notifier: EventNotifier | null;
  private readonly cooldowns: Readonly<Record<OpsSeverity, number>>;
  private readonly logger: Logger | null;

  constructor(deps: OpsMonitorDeps) {
    this.store = deps.store;
    this.notifier = deps.notifier ?? null;
    this.cooldowns = deps.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.logger = deps.logger ?? null;
  }

  /**
   * Record an operational event and, when the cooldown window allows,
   * attempt notification. NEVER throws: an event-store or transport failure is
   * logged and swallowed so monitoring can never crash the pipeline, and the
   * delivery result reported to callers is exactly what the transport said.
   */
  async record(input: OpsEventInput): Promise<OpsEventOutcome> {
    const fingerprint = fingerprintOf(input.kind, input.scope);
    const title = sanitizeEventText(input.title, TITLE_MAX);
    const detail = input.detail ? sanitizeEventText(input.detail, DETAIL_MAX) : null;
    const cooldownMs = input.cooldownMs ?? this.cooldowns[input.severity];

    try {
      const upserted = await this.store.upsert({
        fingerprint,
        kind: input.kind,
        severity: input.severity,
        title,
        detail,
      });

      if (!this.notifier) {
        return {
          fingerprint,
          isNew: upserted.isNew,
          occurrences: upserted.occurrences,
          notifyAttempted: false,
          delivery: null,
        };
      }

      const claimed = await this.store.claimNotify(
        fingerprint,
        new Date(Date.now() + cooldownMs),
      );
      if (!claimed) {
        return {
          fingerprint,
          isNew: upserted.isNew,
          occurrences: upserted.occurrences,
          notifyAttempted: false,
          delivery: null,
        };
      }

      let delivery: EventDeliveryResult;
      try {
        delivery = await this.notifier.notifyEvent({
          fingerprint,
          kind: input.kind,
          severity: input.severity,
          title,
          detail: detail ?? '',
        });
      } catch (error) {
        // A transport that throws is a failed delivery — recorded, never re-emitted.
        delivery = {
          delivered: false,
          status: 'failed',
          errorCode: 'transport_error',
        };
        this.logger?.warn(
          { fingerprint, err: error instanceof Error ? error.message : String(error) },
          'ops event notification transport error',
        );
      }

      await this.store.markDelivery(fingerprint, delivery, new Date());
      return {
        fingerprint,
        isNew: upserted.isNew,
        occurrences: upserted.occurrences,
        notifyAttempted: true,
        delivery,
      };
    } catch (error) {
      this.logger?.error(
        { fingerprint, err: error instanceof Error ? error.message : String(error) },
        'ops event could not be recorded (delivery never claimed)',
      );
      return {
        fingerprint,
        isNew: false,
        occurrences: 0,
        notifyAttempted: false,
        delivery: null,
      };
    }
  }

  /** Newest operational events for the dashboard (bounded, secret-free). */
  async recent(limit = 20): Promise<readonly StoredOpsEvent[]> {
    try {
      return await this.store.recent(limit);
    } catch {
      return [];
    }
  }

  /** Opportunistic retention: 90 days, at most 200 rows per kind. */
  async runCleanup(now = new Date()): Promise<{ deleted: number }> {
    try {
      return await this.store.cleanup({
        olderThan: new Date(now.getTime() - 90 * 24 * 60 * 60_000),
        maxPerKind: 200,
      });
    } catch {
      return { deleted: 0 };
    }
  }
}
