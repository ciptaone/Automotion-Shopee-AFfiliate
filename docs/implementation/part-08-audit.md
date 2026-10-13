# PART 8 — Audit: Operational Readiness, Observability & Telegram Notifications

**Baseline:** PART 6 `f3cfeda`, PART 6A `1457072`, PART 7 `353e4aa`, PART 7A
`149b04a`, PART 7B `6be5a85` — HEAD `6be5a85`, working tree **clean**,
`origin` verified to target
`https://github.com/ciptaone/Automotion-Shopee-AFfiliate`, repo-local identity
`Autopilot Agent <ciptaone1@gmail.com>`. No history rewritten; PART 8 only; no
PART 9; live publishing stays disabled.

**Classification vocabulary:** `PASS` / `FAIL` / `BLOCKED` / `NOT_TESTED`.

---

## 1. Existing surfaces audited (reuse map)

PART 8 must **reuse**, not parallel. Everything found during the audit:

| Area | What already exists | Gap for PART 8 |
|---|---|---|
| Liveness | `GET /health` (public) — status, `part: 1`, uptime, DB configured/healthy/detail, scheduler block, integrations list; one cheap DB round-trip, no provider calls | Keep **unchanged** (invariant `part: 1`) |
| Readiness | none — no endpoint distinguishes "process up" from "dependencies permit generation" | **Add `GET /ready`** (200/503, minimal, no leak) |
| Migrations | `DatabaseHandle.migrationStatus()` (hash-compared drift detection: applied/pending/diverged/missing_file/unknown) + `db:status`/`db:verify` CLIs | Not surfaced in any runtime endpoint → surface in `/ready` + ops health |
| Scheduler | `container.schedulerStatus()`, `contentScheduler.peekLastTick()` (at/today/enqueued/executed/skipped/failed/pendingJobs/message), `schedulerLoopStatus()` (enabled/mode/tickIntervalMs/reason), `nextSlot`, `dailyPostTarget`, `slotsToday` | Aggregation into component statuses only |
| Queue | `JobQueue` contract: enqueue/claim/complete/fail/get/list (+ optional `extendLease`); `InMemoryJobQueue.countByStatus()`; `PostgresJobQueue` lease-based (`lease_expires_at`, DB-clock), inline crash recovery in `claim()`, `recoverExpiredLeases()`; `recovery.ts` (`recoverOnStartup`, `releaseExpiredSlotLocks`, `RecoveryReport`) | No `stats()` on the contract (counts by status, oldest queued age, expired-lease count) → **add optional `stats?()`** to both impls |
| Workers | `ContentScheduler` execution loop claims jobs; `safeFail(...retryable)` → queue backoff; terminal failure = `queue.fail` result `status:'failed'` (attempts exhausted) | Single choke point exists for the "job failed after exhausting retries" event — wire it |
| Providers | `ProviderService.selection()`, per-provider `readinessOf` (cached probes: configuration/authentication/each capability), `assertCapability`, `PROVIDER_SECRET_UNAVAILABLE` typed error | Cached readiness exists — read it, never call paid APIs from health |
| Storage | `ObjectStorage` (memory/file/S3-stub), `container.*.storageKind`, `verifyPublicAccess` | Expose kind + last upload result; no new probes on health |
| Budget | `UsageService.budgetStatus()` (day/month spent vs budget, `exhausted`), `assertWithinBudget()` throws `BudgetExhaustedError`, `summary()` with recent rows (latency, cost kind) | No warning-threshold event (only hard exhaustion) → add `budget.threshold` event |
| Telegram | `integrations/notifications/telegram.ts`: `TelegramNotifier` (Notifier contract), `MemoryTelegramTransport`, **in-memory** dedupe (bounded LRU), `allowLive:false` **hardcoded** in container, `formatNotification` (plain text, 4000-char bound), kinds publish_*/feed_import/health_alert; env `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (paired validation); `notifications` PG table (delivery ledger, unique `dedupe_key`) | No live transport, no backend-only runtime settings (env only), no persistent fingerprint/cooldown, no test action, no delivery persistence wired, no severity/event filters, no rate-limit/bounded-retry handling, no ops event sources → **complete all of §6** |
| Secrets | `SecretStore` (AES-256-GCM; memory/file/Postgres impls; `keyConfigured`; fail-closed `SecretsKeyMissingError`) | Reuse for the bot token + chat id (never settings/env-only at runtime) |
| Redaction | `core/redact.ts` (`redactDeep`, `redactMessage`) + logger redaction | Reuse for notification text and event details |
| Flutter | 6-tab `HomeShell` (Dashboard/Settings/Preview/History/Services/AI), typed `AutopilotApi`, `IntegrationsScreen` ping/loading/error/stale patterns, existing design system (`widgets/common.dart`) | No operations view → **add an Ops tab** |
| Startup | `main.ts`: env validation via `loadEnv` (throws `EnvironmentError` listing key names only), `recoverOnStartup` before listen, per-tick catch keeps the scheduler loop alive, graceful shutdown | No preflight gate, no loop-failure event → add both (non-blocking) |

## 2. Design decisions (recorded before editing)

1. **One new backend module, `src/ops/`** — pure status evaluators
   (`component-health.ts`), the live aggregator (`ops-service.ts`), the event
   store + monitor (`ops-events.ts`), and preflight (`preflight.ts`). It
   *reads existing surfaces* (database, scheduler, queue, providers, storage,
   usage, notifier); it never replaces them and creates no second health system.
2. **Status vocabulary** (§2): `healthy`, `degraded`, `blocked`, `unavailable`,
   `not_configured`, `not_tested`, `disabled`. "Configured ≠ healthy": a
   provider is `healthy` only when configured **and** its capability probe is
   `ready`; otherwise `not_tested`/`blocked`/`not_configured` per the cached
   readiness — **no paid API call is ever made by a health request**.
3. **Endpoint split**: `/health` unchanged (liveness+basic, public, cheap);
   `/ready` = readiness gate (public, minimal, DB + migrations only — the
   dependencies that must work for the service to accept generation jobs;
   200/503, no hostnames/credentials); `/v1/ops/health`, `/v1/ops/metrics`,
   `/v1/ops/preflight` = authenticated diagnostics (read/control scopes).
4. **Queue observability** = optional `stats?()` on the existing `JobQueue`
   contract (additive, non-breaking) implemented by both queues. Metrics are
   low-cardinality counts and ages — **no job ids, product names, or API keys
   in labels**.
5. **Telegram = complete the existing notifier, not a second pipeline.**
   `TelegramNotifier` gains: dynamic config (secrets + settings read at send
   time), severity/kind filters, persistent fingerprint dedupe with cooldown,
   bounded retry (429 → `retryAfterMs`, 5xx/timeout → bounded retry, other 4xx
   → permanent), and delivery recording. A new `TelegramHttpTransport` performs
   the real Bot API call with a 10 s timeout, never logs the token, and reports
   `delivered` **only** on Telegram's own `ok:true` + `result.message_id`.
   The constructor signature stays backward-compatible with the existing
   `adapters.test.ts` suites.
6. **Live sends are configuration-gated, not hardcoded forever**: a live send
   requires bot token + chat id present (API-stored secrets, encrypted; env
   bootstrap still honoured) **and** `notificationsEnabled=true` **and** the
   destination host is the fixed `api.telegram.org`. Default state everywhere
   is `not_configured`/disabled — unit and contract tests use the memory
   transport or an injected fetch, so **no test can reach a real chat**.
7. **Event persistence**: one additive migration
   `0004_part8_ops_events.sql` → `ops_events` (fingerprint unique,
   occurrences, first/last seen, cooldown_until, last delivery status/error
   code/message id). Dedupe is concurrency-safe (`INSERT … ON CONFLICT DO
   UPDATE … RETURNING`). Delivery is **best-effort with a durable event
   record** — the event row survives even when Telegram is down; exactly-once
   external delivery is **not** claimed (a crash between send and record can
   duplicate; cooldown bounds the damage).
8. **Event sources wired at existing choke points** (no new loops inside the
   pipeline): scheduler tick exception → `scheduler_tick_failed`; worker
   terminal failure (`queue.fail` → `failed`) → `generation_job_failed`;
   startup recovery report → `recovery_performed`; a 5-minute ops evaluation
   timer (independent of the scheduler) → `database_unavailable`,
   `migration_drift`, `budget_threshold`, `scheduler_stale`. Every emission is
   wrapped so notification code can never crash the process or recurse
   (delivery failures are recorded, never re-notified).
9. **Settings vs secrets**: non-sensitive notification settings
   (`notificationsEnabled`, `notificationMinSeverity`, `notificationEventKinds`)
   join `AutomationSettings` (additive fields with defaults, file/PG persisted,
   editable from the app). The **bot token and chat id live only in the
   encrypted `SecretStore`** under reserved ids — never returned by any API,
   never in settings payloads, logs, or Git.
10. **Preflight** = pure evaluator + live runner; CLI (`npm run preflight`) and
    authenticated endpoint; blockers vs warnings per §8; it enables nothing.
11. **Retention**: `ops_events` cleanup keeps the most recent 90 days /
    500 rows per kind, run opportunistically (on ops health read + daily in
    the ops timer). Bounded, documented.

## 3. Failures that must prevent accepting generation jobs (to document in evidence)

- PostgreSQL unreachable while `PERSISTENCE_BACKEND=postgres` (durable slot
  identity, lease ownership and the daily cap live there) → `/ready` 503.
- Migration drift (`diverged`/`missing_file`) → `/ready` 503 (running against
  an unexpected schema is unsafe).
- Automation paused or scheduler disabled → jobs are not dispatched (existing
  behaviour; surfaced as `disabled`, not a readiness failure).
- Budget exhausted → generation is blocked at request time (existing
  `assertWithinBudget`); surfaced as `blocked`.

## 4. Planned deliverables

| # | Deliverable | Files |
|---|---|---|
| 1 | Health model + aggregation | `src/ops/component-health.ts`, `src/ops/ops-service.ts` |
| 2 | `/ready`, `/v1/ops/health`, `/v1/ops/metrics`, `/v1/ops/preflight` | `src/app/server.ts` |
| 3 | Queue `stats?()` (both queues) | `src/contracts/index.ts`, `src/queue/job-queue.ts`, `src/db/postgres-job-queue.ts` |
| 4 | Telegram completion (transport, filters, persistent dedupe/cooldown, delivery recording, test action) | `src/integrations/notifications/telegram.ts`, `src/ops/ops-events.ts` |
| 5 | `ops_events` migration (additive) | `src/db/schema.ts`, `drizzle/0004_part8_ops_events.sql`, snapshots, `src/cli/db-verify.ts` |
| 6 | Notification settings + secrets endpoints | `src/settings/automation-settings.ts`, `src/app/server.ts` |
| 7 | Event wiring (scheduler tick, terminal job failure, recovery, ops timer) | `src/scheduler/content-scheduler.ts`, `src/main.ts` |
| 8 | Preflight CLI + smoke:telegram | `src/cli/preflight.ts`, `src/cli/live-telegram-smoke.ts`, `package.json` |
| 9 | Flutter Ops tab | `app/lib/screens/ops_screen.dart`, `app/lib/models/ops_models.dart`, `app/lib/core/autopilot_api.dart`, `app/lib/screens/home_shell.dart` |
| 10 | Tests (unit/contract/db/Flutter) + regression | `backend/tests/**`, `app/test/**` |
| 11 | Docs | `docs/implementation/part-08-{audit,evidence}.md` |

**Explicitly out of scope:** no PART 9; no live Facebook/Threads publishing
(the gate stays disabled and unmodified); no change to scheduling windows,
daily cap semantics, job identities, editorial rules, or provider behaviour.

## 5. Verification plan (§11)

Backend typecheck/lint/full tests/build; `npm run test:db` (real PostgreSQL
via `scripts/db.ps1`); `db:status`/`db:verify`/`drizzle-kit check`; Flutter
analyze/test/debug APK; PART 4 smoke (`SCHEDULER_ENABLED=true` …) — expect
51/51; PART 7 provider E2E contract suite re-run; `npm run smoke:providers`
without credentials — BLOCKED (exit 2); `npm run smoke:telegram` without
credentials — BLOCKED (exit 2). No assertion may be weakened.
