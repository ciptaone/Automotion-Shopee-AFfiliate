# PART 8 — Evidence: Operational Readiness, Observability & Telegram Notifications

**Date:** 2026-10-13 · **Baseline:** PART 7B `6be5a85` (HEAD before this part) ·
**Classification:** `PASS` / `FAIL` / `BLOCKED` / `NOT_TESTED` per check.

## 0. Summary

| Area | Verdict |
|---|---|
| Health model + `/ready` + `/v1/ops/*` endpoints (§2/§3) | **PASS** — HTTP contract proven (auth, scopes, minimal public body) |
| Scheduler/queue observability (§4) | **PASS** — WIB diagnostics, daily target, DB-clock queue stats |
| Flutter Ops dashboard (§5) | **PASS** — 7th tab, 14 new tests, analyze clean, debug APK built |
| Telegram notifications (§6/§7) | **PASS** (delivery machinery) / **NOT_TESTED** (live send — no credentials) |
| `ops_events` migration 0004 + dedupe (§7) | **PASS** — real PostgreSQL incl. concurrency proofs |
| Preflight CLI §8 | **PASS** — `OK (development)` exit 0; blocker escalation verified in automation-running env |
| Security §9 | **PASS** — auth on diagnostics, no secrets in responses/commits, fixed Telegram host |
| Regression §11 (backend/DB/Flutter/smokes) | **PASS** — all gates green (numbers below) |
| Live external calls (AI providers, Telegram chat) | **NOT_TESTED / BLOCKED** — no credentials in this environment |
| Live Facebook/Threads publishing | **DISABLED (unchanged)** — gate untouched by PART 8 |

## 1. Endpoints (§3) — verified at the HTTP boundary

Live server (`127.0.0.1:8794`, documented PART 4 environment) plus 26 dedicated
contract tests (`tests/contract/ops-api.test.ts`):

| Check | Evidence | Verdict |
|---|---|---|
| `GET /health` unchanged | live: `200`, `part=1`, `status=ok`; contract asserts `part: 1` | **PASS** |
| `GET /ready` public, 200 in dev | live: `200 {"status":"ready","checks":{"database":"not_configured","migrations":"not_configured"},"reason":null,…}` | **PASS** |
| `/ready` body minimal — no hostnames/credentials/token shapes; exact key set | contract test serializes body and rejects `localhost|127.0.0.1|secret|token|api key|<telegram token shape>` | **PASS** |
| `/v1/ops/health` auth + read scope | live: `401` unauthenticated, `200` with Bearer; contract: `401` / `403` (dashboard-only token) | **PASS** |
| `/v1/ops/health` content | live: `overall`, `ready=true`, **11 components** incl. `publishing_gate=disabled/publishing_disabled`, scheduler `enabled/mode=mock/dailyPostTarget=4/Asia/Jakarta`; after 20 s: `scheduler=healthy`, `lastTickAt` set | **PASS** |
| `/v1/ops/metrics` low-cardinality | contract: `200`; serialized body contains no `uniqueKey`, no slot keys (`\d{4}-\d{2}-\d{2}#\d{2}`), no product/credential strings | **PASS** |
| `/v1/ops/preflight` control scope | live: `403` for read-only token, `200` for control token (`ok/blockers/warnings/passed` present) | **PASS** |
| Telegram settings GET/PUT | contract: `401`/`403` enforced; settings round-trip (`enabled`, `minSeverity`, `eventKinds`) with defaults restored; response never contains `botToken`/`chatId` keys or token-shaped strings | **PASS** |
| Telegram secret PUT/DELETE write-only | contract: PUT → `200 configured=true`, raw response does **not** contain the stored value; GET reports `secret.present/stored` only; DELETE idempotent → `present:false` | **PASS** |
| Missing encryption key fails closed | contract: PUT secret without `SECRETS_ENCRYPTION_KEY` → `503 SECRETS_KEY_MISSING` | **PASS** |
| Test action | contract: no credential → `200 status=not_configured`, `delivered=false`, `errorCode=telegram_not_configured` **with no network attempt**; immediate second call → `429 RATE_LIMITED`; read-only token → `403` | **PASS** |

No AI API call is ever made for a health request: `ops-service` is assembled
from cached probes/config only, and a unit test asserts the evaluator path
performs zero provider round-trips (`ops-service.test.ts`, "never calls a
provider").

## 2. Observability (§4)

- **Scheduler diagnostics:** live payload carries `timezone=Asia/Jakarta`,
  `dailyPostTarget=4`, `today=2026-10-13`, `slotsToday=4`, `nextSlot`,
  `lastTickAt`/`lastSuccessfulTickAt`, `lastTickExecuted/Skipped`. Unit tests
  pin the Jakarta-day target rule (3 vs 4 windows) and the mapping.
- **Queue diagnostics:** `QueueStats` (pending/running/succeeded/failed/
  cancelled/retrying, `oldestPendingAt`, `oldestPendingAgeMs`,
  `expiredLeases`) from one FILTER-aggregate round trip using the **database
  clock** — proven on real PG (`part8-ops-events.test.ts`): counts per status,
  age ≈ 90 s for a job scheduled 90 s ago, `expiredLeases=1` after a simulated
  crashed-worker lease, and a key-set assertion proving the snapshot contains
  counts/ages only (no job ids, payloads or keys).
- **Recent errors:** persisted `ops_events` (sanitized + bounded) are returned
  as `recentEvents`; the monitor redacts secret-shaped strings before storage
  (unit test: a telegram-token-shaped string in a title never reaches the
  store) and truncates detail.

## 3. Ops dashboard (§5) — Flutter

- 7th tab `Ops` added to `HomeShell` (IndexedStack, state preserved);
  `OpsScreen` reads `GET /v1/ops/health` only — **no AI credential needed to
  open** (tests inject a MockClient; no socket is ever opened).
- Renders: overall status + readiness banner, blockers, staleness chip
  (>2 min → "Data stale", auto-refresh 60 s), environment card with
  **mock-vs-live banner** (`Development configuration` when scheduler/storage
  is mock), scheduler card (target/slots/next/last tick), queue card
  (count chips, oldest-pending age, expired leases), component rows for all
  statuses, **explicit publishing-gate card** ("DISABLED by design",
  `publish_ready` terminal stage), recent events with severity/occurrences/
  delivery status, honest empty state.
- States covered by tests: loading, empty, error+retry (`SocketException` →
  "Backend unreachable"), partial (refresh failure keeps last known state),
  stale. `flutter analyze` → **No issues found**; `flutter test` →
  **176/176** (162 pre-existing + 14 new); `flutter build apk --debug` →
  **PASS** (`✓ Built build\app\outputs\flutter-apk\app-debug.apk`).

## 4. Telegram notifications (§6/§7)

**Delivery machinery — PASS (deterministic tests, no real chat):**

| Behaviour | Evidence |
|---|---|
| Missing config → `not_configured`, no crash, no send | unit `ops-telegram` + contract test (no network attempted) |
| Severity floor + event-kind filters (empty list = all) | unit `ops-telegram` (filter matrix); defaults `minSeverity=warning` |
| Test action bypasses filters but requires credential | unit `ops-telegram` |
| Bounded retries: max 3 attempts, wait capped 60 s; 429→`retry_after`, 5xx/network→retry, other 4xx→permanent | unit `ops-telegram` with injected `sleep`/`fetch` |
| Token never logged/leaked; fixed host `api.telegram.org`; 10 s timeout | unit: injected fetch asserts host, and that the request URL/error text never contains the token |
| Credential rotation picked up per delivery (lazy rebuild) | unit `LazyTelegramTransport` rotation test |
| Persistent dedupe: fingerprint upsert + cooldown claim | unit (memory) + **real PG**: 8 concurrent upserts → 1 row `occurrences=8`; **6 concurrent `claimNotify` → exactly 1 winner**; unknown fingerprint never claims; claim allowed again only after `cooldown_until` passes |
| Delivery status persisted; `delivered` only after confirm; failures never erase the confirmed message id/timestamp | PG `markDelivery` test: `sent`→`failed` keeps `lastMessageId='42'` and `lastNotifiedAt` (defect found & fixed — see §7) |
| No recursive failure notifications | monitor `record()` swallows/logs its own errors (unit); Telegram delivery failures are never re-emitted as events |
| Retention 90 days / 200 per kind | PG cleanup test: 5×100-day-old rows deleted, per-kind cap keeps newest 1 |
| Delivery semantics documented as best-effort (no exactly-once claim) | header docs in `src/ops/ops-events.ts` + audit §7 |

**Live delivery — NOT_TESTED / BLOCKED:** `npm run smoke:telegram` exits **2**
printing *variable names only* (`LIVE_SMOKE_TELEGRAM_BOT_TOKEN`,
`LIVE_SMOKE_TELEGRAM_CHAT_ID`) and
`Live Telegram delivery verified: NO (NOT_TESTED).` No message was sent to any
chat; the default suite cannot reach Telegram (no credential stored anywhere in
tests).

## 5. Preflight (§8) — read-only gate report

- `npm run preflight` (development env) → **`RESULT: OK (development)`,
  exit 0**, `Accepting generation: yes (no blockers)`, 7 warnings, 6 passed
  (migrations, daily_target, windows, timezone, budget, publishing_gate),
  `No state was changed`.
- With the automation-running environment (`SCHEDULER_ENABLED=true`, mock
  providers) → **exit 1 with 2 blockers** — `caption_provider` and
  `image_provider` ("not selected… Automation is running, so generation will
  block on this"). This is the intended escalation (configured ≠ tested) and
  the run stayed read-only.
- Blocker/warning boundary rules are unit-tested (17 tests in
  `ops-preflight.test.ts`), including production-integrity rules (silent mock
  persistence in production = blocker) and image-reference/budget/telegram
  warnings-only classification.
- Endpoint form `/v1/ops/preflight` requires the `control` scope (contract).

## 6. Security (§9)

- **Auth on diagnostics:** every `/v1/ops/*` and `/v1/notifications/*` route
  returns `401` without a Bearer token and `403` without the required scope
  (contract tests; live spot-check `401`/`403` on 127.0.0.1:8794).
- **No secrets in responses:** contract tests serialize `/ready`,
  `/v1/ops/health|metrics`, and Telegram GET/PUT responses and assert no
  token-shaped string, no `botToken`/`chatId` keys, no Bearer header material;
  secret values are stored sealed (AES-256-GCM) and reported as presence only.
- **SSRF:** the Telegram transport hardcodes `api.telegram.org` — unit tests
  with an injected fetch assert the exact host and that no configurable URL
  exists.
- **Nothing committed:** scan of the full tracked diff + every untracked file
  to be added found **0** secret-shaped strings in source changes; the 8
  token-shaped matches are synthetic test fixtures (`…:AAHfakefake…`,
  `…:AAHcontracttestfake…`, `…:AAHsupersecrettokenvalue…`) inside test files
  only, mirroring PART 1 redaction-fixture style. No `.env`, runtime `data/`,
  temp DB files or CLI scratch files are in the add list (`git ls-files
  --others --exclude-standard` lists source/tests/docs only).

## 7. Defects found & fixed during development (honesty record)

1. **`PostgresOpsEventStore` raw SQL failed with JS `Date` parameters**
   (`claimNotify`/`markDelivery`/`cleanup`) — fixed to the codebase convention
   of ISO strings with explicit `::timestamptz` casts. Found by the new PG
   integration tests.
2. **`markDelivery` erased the last confirmed message id** when a later
   delivery failed — fixed in **both** stores (`coalesce`/preserve); a PG test
   and a unit test now pin the behaviour (`sent` then `failed` keeps
   `lastMessageId` and `lastNotifiedAt`).
3. **Preflight/telegram CLIs required `CORS_ORIGINS` in CLI context** — both
   give themselves a local throwaway default (operator env still wins via
   spread order); without it `npm run preflight` died before reporting.
4. **`tests/db/migrations.test.ts` hard-coded 4 migrations / 12 tables** —
   updated to 5/13 with the full tag and table-name lists still asserted
   exactly (expectations strengthened for the new chain, not weakened).
5. **Test-environment discoveries encoded as tests instead of assumptions:**
   scheduler catch-up at 19:30 executes only the newest due slot (`#04`) and
   records the rest as `skipped`; in-memory queue re-enqueues a terminal-failed
   key as a new row (dedupe happens at the monitor, by design).
6. **Flutter wording/param mismatches caught by `flutter analyze`/tests:**
   status labels use sentence case ("Not configured"), the offline test uses
   `SocketException`, and `HomeShell` passes `onSignedOut` to the five screens
   that declare it (a rewrite briefly used `onSignOut`; analyzer caught it).

## 8. Verification (§11) — all gates green on the final tree

| Gate | Command | Result |
|---|---|---|
| Backend typecheck | `npm run typecheck` | **PASS** exit 0 |
| Backend lint | `npm run lint` | **PASS** exit 0 (0 problems) |
| Backend build | `npm run build` | **PASS** exit 0 |
| Backend unit + contract | `npm test` | **PASS — 890/890, 37 files** (732 pre-existing + **158 new**: 132 unit in 6 `ops-*` files, 26 contract `ops-api`) |
| PostgreSQL integration | `npm run test:db` | **PASS — 95/95, 8 files** (76 pre-existing + **19 new** in `part8-ops-events`), exit 0 |
| Migration status | `db:status` (in test:db) | **PASS** — journal 5 entries, applied 5, `database schema matches the committed migrations` (incl. `0004_part8_ops_events`) |
| Schema ↔ code | `db:verify` (in test:db) | **PASS** — `live schema matches src/db/schema.ts` |
| Snapshot consistency | `npx drizzle-kit check` | **PASS** — `Everything's fine` |
| Flutter analyze | `flutter analyze` | **PASS** — `No issues found` |
| Flutter tests | `flutter test` | **PASS — 176/176** (162 pre-existing + **14 new** `ops_screen_test`) |
| Flutter debug APK | `flutter build apk --debug` | **PASS** — `✓ Built …\app-debug.apk` |
| PART 4 live smoke | `docs/implementation/part-04-smoke.ps1` vs `127.0.0.1:8794` (`SCHEDULER_ENABLED=true SCHEDULER_MODE=mock AI_IMAGE_PROVIDER=mock AI_TEXT_PROVIDER=mock`, fresh data dir restored afterwards) | **PASS — `TOTAL=51 PASS=51 FAIL=0`**, script unchanged; boot log confirms `content scheduler loop started`, **0 error lines**; scheduler executed `content:2026-10-13#02` (`executed=1 skipped=1` anti-catch-up), `uniqueKey` identity intact |
| PART 7 provider contract suite | included in `npm test` (`pipeline-provider-e2e` + adapter contracts) | **PASS** (part of the 890) |
| Live provider smoke | `npm run smoke:providers` | **BLOCKED exit 2** (expected): missing `LIVE_SMOKE_*` names only; `Live generation verified: NO (NOT_TESTED).` |
| Live Telegram smoke | `npm run smoke:telegram` | **BLOCKED exit 2** (expected): missing `LIVE_SMOKE_TELEGRAM_*` names only; `Live Telegram delivery verified: NO (NOT_TESTED).` |
| Preflight | `npm run preflight` | **PASS** exit 0 — `OK (development)`, 7 warnings, 0 blockers (see §5 for the blocker run) |

**Preserved invariants (spot checks inside the above):** `/health` `part: 1`;
caption ends exactly `#ai #automation`; `automatedFidelityScore` null;
`maxCatchUpPerTick=1`; `MAX_CAPTION_ATTEMPTS=3`; publishing gate
`disabled/publishing_disabled` in every environment; no publish job kinds ever
queued; history remains fixture-only; Flutter `FAILED`-count assertions
unchanged.

## 9. Files changed (PART 8)

- **Backend module:** `src/ops/{component-health,ops-events,ops-service,preflight}.ts`
- **Endpoints/wiring:** `src/app/server.ts`, `src/app/container.ts`,
  `src/main.ts` (ops evaluation timer), `src/contracts/index.ts`,
  `src/queue/job-queue.ts`, `src/db/postgres-job-queue.ts` (`stats?()`)
- **Scheduler events:** `src/scheduler/content-scheduler.ts`
  (terminal-failure event; no behavioural change to enqueue/execute logic)
- **Telegram:** `src/integrations/notifications/telegram.ts` (HTTP transport +
  notification service; PART 1 `TelegramNotifier` untouched)
- **Settings:** `src/settings/automation-settings.ts` (notification fields)
- **Migration:** `src/db/schema.ts`, `drizzle/0004_part8_ops_events.sql`,
  `drizzle/meta/_journal.json`, `drizzle/meta/0004_snapshot.json`,
  `src/cli/db-verify.ts`
- **CLIs:** `src/cli/preflight.ts`, `src/cli/live-telegram-smoke.ts`,
  `package.json` (`preflight`, `smoke:telegram` scripts)
- **Tests:** `tests/unit/ops-{health,events,telegram,service,preflight,queue-events}.test.ts`,
  `tests/contract/ops-api.test.ts`, `tests/db/part8-ops-events.test.ts`,
  `tests/db/{helpers,migrations}.test.ts` (truncate list + 5th-migration counts)
- **Flutter:** `lib/models/ops_models.dart`, `lib/screens/ops_screen.dart`,
  `lib/screens/home_shell.dart`, `lib/core/autopilot_api.dart`,
  `test/{ops_screen_test,helpers}.dart`
- **Docs:** `docs/implementation/part-08-{audit,evidence}.md`

## 10. Delivery (requirement 11)

- PART 8 is committed as its **own commit** on `master` (no PART 9 work, no
  unrelated changes), author `Autopilot Agent <ciptaone1@gmail.com>`, history
  untouched (no reset/force-push/amend). This document is included in that
  commit; the exact hash and push verification are reported in the session
  delivery summary and are re-checkable with `git log -1 --format=%H` and
  `git ls-remote origin refs/heads/master`.
- Pre-push checks completed before staging: secret scan (§6) clean; staged set
  contains source/tests/docs only (no `.env`, no `backend/data`, no temp DB or
  scratch files).

## 11. Honest limits

- **Live Telegram delivery: NOT_TESTED** — no bot token/chat id exists in this
  environment; only the credential-aware BLOCKED path (exit 2) was executed.
  No claim of delivered uptime is made.
- **Live AI provider calls: NOT_TESTED** — no provider credentials/budget;
  `smoke:providers` refuses to claim PASS without them.
- **No managed PostgreSQL / always-on deployment:** readiness and stats were
  proven against an isolated local PG 17.10 cluster; production behaviour with
  real network latency is untested here.
- **Delivery semantics are best-effort, not exactly-once:** a crash between a
  confirmed Telegram send and `markDelivery` can produce a duplicate later;
  this is documented in `src/ops/ops-events.ts` and the audit.
- **Publishing remains disabled:** PART 8 added no route, key or setting that
  can publish to Facebook/Threads; the gate component reports `disabled` by
  design in all environments.
