# PART 5 — Evidence: PostgreSQL production persistence

**Date:** 2026-10-12
**Baseline:** `02a79cb` (PART 4, approved) — this document is committed together with the
PART 5 code as its own commit (the commit hash is quoted in the delivery report).
**Scope:** PART 5 only. No PART 6 work, no live publishing, no UI changes.

Everything below is a real command run on this machine, with its real output.
Nothing is estimated. Where something could not be exercised it is listed under
**NOT_TESTED** or **BLOCKED** — never as a pass.

---

## 1. Verdict

| # | Check | Command | Result |
|---|-------|---------|--------|
| 1 | Backend type-check | `cd backend && npm run typecheck` | **PASS** (0 errors) |
| 2 | Backend lint | `cd backend && npm run lint` | **PASS** (0 problems) |
| 3 | Backend unit + integration (in-memory) | `cd backend && npm test` | **PASS — 533 / 533** (20 files) |
| 4 | Backend build | `cd backend && npm run build` | **PASS** (`tsc -p tsconfig.build.json`) |
| 5 | Migration chain integrity | `cd backend && npx drizzle-kit check` | **PASS** — `Everything's fine` |
| 6 | Schema == migrations | `cd backend && npm run db:generate` | **PASS** — `No schema changes, nothing to migrate` |
| 7 | **PostgreSQL integration suite** | `cd backend && npm run test:db` | **PASS — 60 / 60** (6 files) on a real PG 17.10 |
| 8 | Migration status CLI (4 states) | `npm run db:status` | **PASS** — pending=3, applied=0, drifted=4, unreachable=1, no-URL=2 |
| 9 | Schema-vs-live verification CLI | `npm run db:verify` | **PASS** — `live schema matches src/db/schema.ts` |
| 10 | File → PostgreSQL import CLI | `npm run db:import` (dry run, `--apply`, re-run) | **PASS** — dry run writes nothing; re-run idempotent |
| 11 | Flutter analyze | `cd app && flutter analyze` | **PASS** — `No issues found!` (50.1s) |
| 12 | Flutter tests | `cd app && flutter test` | **PASS — 147 / 147** |
| 13 | Debug APK | `cd app && flutter build apk --debug` | **PASS** — `app-debug.apk` **168.2 MB** |
| 14 | PART 4 live smoke re-run | `docs/implementation/part-04-smoke.ps1` | **PASS — 51 / 51** |

**FAIL: none.** **BLOCKED: 2 (see §9).** **NOT_TESTED: 2 (see §9).**

---

## 2. What PART 5 added

| Area | Files |
|------|-------|
| Schema + migration `0002_part5_persistence` | `backend/src/db/schema.ts`, `backend/drizzle/0000…0002` |
| Connection / pool / sanitised errors | `backend/src/db/client.ts` |
| Migration status (pure + live) | `backend/src/db/migration-status.ts` |
| Job queue (leases, claims, backoff) | `backend/src/db/postgres-job-queue.ts` |
| Slot store (atomic, version-guarded) | `backend/src/db/postgres-slot-store.ts` |
| Settings + scheduler checkpoints | `backend/src/db/postgres-settings-store.ts` |
| Catalog (upsert by natural key) | `backend/src/db/postgres-catalog-store.ts` |
| Cross-process tick lock | `backend/src/db/postgres-tick-lock.ts` |
| Startup recovery | `backend/src/db/recovery.ts` |
| Backend selection (fail-closed) | `backend/src/core/persistence.ts`, `src/core/env.ts` |
| Wiring + startup gate (exit 78) | `src/app/container.ts`, `src/main.ts` |
| CLIs | `src/cli/db-status.ts`, `db-verify.ts`, `db-import.ts` |
| Cluster + runner scripts | `scripts/db.ps1`, `scripts/pg-lifecycle.mjs`, `scripts/test-db.ps1` |
| DB test suite | `tests/db/*` (6 files), `vitest.db.config.ts` |

**Test split:** `npm test` still runs the original 533 tests (in-memory / file stores,
`tests/db/**` excluded); `npm run test:db` runs the 60 PostgreSQL tests. The two never
share a database.

---

## 3. Migration workflow (fresh database, real PostgreSQL)

Test cluster: **PostgreSQL 17.10** from the `embedded-postgres` dev dependency, started by
`scripts/db.ps1` on `127.0.0.1:55432/autopilot_test`, **recreated from scratch on every
`test:db` run** (`-Fresh`, dropped unless `-Reuse`), encoding **UTF-8 + locale C**, torn
down afterwards. The connection URL never leaves the process environment and is never
printed.

Every `npm run test:db` also applies the committed migration chain through
`drizzle-kit migrate` (suite `globalSetup`), so *the integration suite is itself a
from-zero migration test*.

### 3.1 The four states, actually exercised

```
=== db:status on an EMPTY database ===
bookkeeping table : absent
[pending] 0000_init               not yet applied to this database
[pending] 0001_part3_catalog      not yet applied to this database
[pending] 0002_part5_persistence   not yet applied to this database
note: this database has never been migrated — run `npm run db:migrate` (an empty
      database is pending, not drifted)
RESULT: migrations are pending — run `npm run db:migrate`.
exit=3

=== db:migrate ===
[✓] migrations applied successfully!

=== db:status ===
applied records   : 3
bookkeeping table : present
[applied] 0000_init / 0001_part3_catalog / 0002_part5_persistence
RESULT: database schema matches the committed migrations.
exit=0
```

**Drift** — the recorded hash of the last migration is corrupted (simulating "somebody
edited an applied migration"; only the throwaway bookkeeping row is touched, never a file):

```
[DRIFTED] 0002_part5_persistence  changed after it was applied
           (recorded hash deadbeefdead…, file hash 5efb07aba7e2…)
problems:
  - 0002_part5_persistence.sql diverged from the applied migration
RESULT: drift detected. Do NOT re-edit an applied migration — add a new one …
exit=4
```

**Configuration / connectivity**

```
db:status without DATABASE_URL            -> "DATABASE_URL is not set…"                exit=2
db:status against 127.0.0.1:1 with a
  password in the URL                     -> "Could not reach PostgreSQL:
                                             PostgreSQL unreachable: connect ECONNREFUSED 127.0.0.1:1"
                                             (password, user and URL never echoed)     exit=1
db:verify                                 -> "live schema matches src/db/schema.ts"    exit=0
```

Exit codes are part of the contract: `0` ok · `2` no URL · `3` pending · `4` drift ·
`1` unreachable/other — usable directly from CI.

### 3.2 Ordering, freshness and recovery rules (as implemented)

1. Order is fixed by `drizzle/meta/_journal.json` (`0000 → 0001 → 0002`). A fresh
   database applies all three in order; an up-to-date one applies nothing.
2. An **empty** database is *pending* (exit 3). Application tables **without**
   bookkeeping are *drift* (exit 4) — the tool refuses to run migrations over a schema it
   did not create.
3. An applied migration is never re-run and never rewritten: `drizzle-kit generate`
   reports `No schema changes`, and `drizzle-kit check` validates the journal/snapshots.
   Changing an already-applied file is reported as **DRIFTED**, not silently ignored
   (drizzle itself only compares `created_at` — that is why the SHA-256 check exists).
4. **No automatic `DROP`/`TRUNCATE` anywhere** in production code. `DROP TABLE` appears
   only in `tests/db/global-setup.ts`-driven `resetDatabase()` (test-only, `TRUNCATE …
   CASCADE`) and in `scripts/db.ps1 -Fresh`, which only ever deletes the throwaway local
   cluster directory.
5. Recovery order on boot: validate env → connect → check migration status →
   `recoverOnStartup()` → start serving. Any failure before "connect + consistent
   schema" exits with code **78 (EX_CONFIG)** and a secret-free message.

---

### 3.3 Backing up / migrating existing local (file-store) data

`npm run db:import` reads the file store's own snapshot files (`settings.json`,
`catalog.json`, `slots.json` from a directory such as `backend/data`) and writes them into
PostgreSQL. It is **dry-run by default**, never called by the application, never deletes a
row, and converts nothing destructively — an existing `slot_contents` row is left alone so
older file data can never overwrite newer database state.

```
=== dry run (default) ===
source directory : C:\Users\MSI\AppData\Local\Temp\opencode\part5-import-sample
mode             : DRY RUN (pass --apply to write)
settings.json    : not present (skipped)
catalog.json     : would write (1 products, 0 import batches; upserted by natural key)
slots.json       : would insert 1 records (insert-if-absent)
RESULT: dry run complete — nothing was written.                                     exit=0

=== --apply (first) ===
mode             : APPLY
catalog.json     : written (1 products, 0 import batches; upserted by natural key)
slots.json       : 1 inserted, 0 already present (existing rows are never overwritten)
RESULT: imported 2 record(s).
Re-running is safe: every write is an idempotent upsert or an insert-if-absent.      exit=0

=== --apply (re-run) ===
catalog.json     : written (1 products, 0 import batches; upserted by natural key)
slots.json       : 0 inserted, 1 already present (existing rows are never overwritten)
RESULT: imported 1 record(s).                                                       exit=0

=== row counts after import ===
{ "products": 1, "import_batches": 0, "settings_rows": 0,
  "slots": [ { "slot_key": "2026-10-12#01", "stage": "publish_ready",
               "image_count": 2, "attempts": 1, "asset_json_bytes": 537 } ],
  "product_ids": [ { "feed_id": "9001", "marketplace": "shopee", "eligible": true } ] }
```

The dry run wrote nothing (the first `--apply` inserted the row that the dry run only
*reported*), the re-run inserted nothing new, and the imported slot still contains
references and metadata — 537 bytes, no image payloads.

---

## 4. What the 60 PostgreSQL tests prove

`cd backend && npm run test:db` → **6 files, 60 tests, all green**, cluster created,
migrated, exercised and stopped by one command.

| File | Tests | Covers |
|------|------:|--------|
| `tests/db/job-queue.test.ts` | 17 | claiming, leases, retry budget, stale writers |
| `tests/db/migrations.test.ts` | 11 | live schema, unique indexes, FKs, settings/catalog/checkpoints |
| `tests/db/slot-store.test.ts` | 9 | atomic reservation, version conflicts, restart durability |
| `tests/db/scheduler-concurrency.test.ts` | 8 | two processes, tick lock, cap, catch-up, timezone |
| `tests/db/failure-modes.test.ts` | 8 | fail-closed config, credential hygiene, mid-run DB loss |
| `tests/db/pipeline-recovery.test.ts` | 7 | durable pipeline output, restart, retry reuse |

### 4.1 Concurrency (two workers / two processes, one database)

- `never hands the same job to two workers` — two workers claim the same table at the same
  instant; exactly one receives the row (`FOR UPDATE SKIP LOCKED`).
- `hands N distinct jobs to N concurrent workers` — no duplicates, no starvation.
- `exactly one of two concurrent writers reserves the same slot` — `ON CONFLICT DO NOTHING`
  + `RETURNING`: one winner, one `SlotWriteConflictError`.
- `two independent slot repositories cannot both reserve one slot` — two separate store
  instances (as if two processes) race the same `slot_key`; the unique index decides.
- `rejects a write based on a stale version instead of overwriting newer state` — the
  `UPDATE … WHERE version = expected` guard; the loser reads the current row.
- `never creates duplicate jobs and never executes one slot twice` — `Promise.all` of two
  `tick()`s from two processes; job `unique_key` set is duplicate-free, executed slot keys
  are disjoint, every `slot_contents` group has `count = 1`.
- `skips a tick taken while another process holds the advisory lock` — session-level
  `pg_try_advisory_lock` on a reserved connection: the loser reports the lock and creates
  **zero** jobs; once released the same process ticks normally.
- `no sequence of concurrent ticks can exceed 24 slots per day` — 5 rounds × 2 processes
  ticking simultaneously stay inside the cap, one row per slot.
- `a second tick never produces a second logical job for the same slot` — job identity
  `content:<slotKey>` survives a restart of the worker.

### 4.2 Crash recovery, leases, stale workers

- `reclaims a job whose worker died (expired lease) without losing the attempt count`
  — attempt count preserved, new claim token, old token unusable.
- `recoverExpiredLeases requeues crashed jobs and fails ones out of budget` — expired
  leases are split into *requeue* (attempts left) vs *terminal failure* (budget spent);
  bounded, never an infinite loop.
- `a stale worker cannot complete a job that a newer worker now owns` — `STALE_JOB_CLAIM`
  (`StaleClaimError`, conflict + non-retryable) on both `complete` and `fail`.
- `the owner completes with its token, and a later renewal by anyone else is refused` —
  lease renewal requires the live token.
- `completing a job that was never claimed (no token) still requires a real row` and
  `completing a job that no longer exists is reported` — no silent success.
- `releases an expired slot lock and bumps the version so a late writer is rejected` —
  `recoverOnStartup()` clears `lock_owner`/`lock_expires_at` **and** bumps `version`, so a
  zombie worker that wakes up afterwards cannot overwrite the new state.
- `never touches completed rows and never clears their error history` — recovery is not a
  reset.
- `is idempotent: running recovery twice changes nothing the second time`.
- `rejects queue and slot writes once the connection is gone` — losing PostgreSQL mid-run
  makes writes **throw**; the store keeps `kind === 'postgres'` (no silent backend swap).

### 4.3 Durability of pipeline output

- `writes a publish_ready slot to PostgreSQL with captions, assets and checksums` — the
  row is read back over a *second* connection (`stage`, `asset_count`, `completed_at`).
- `a failed slot keeps its persisted image count and valid assets across a retry` — the
  image count and every asset checksum are unchanged; still exactly **one** row per slot.
- `reloads the exact same record and regenerates nothing` — a second process gets the same
  `generationRunId`, same asset ids and checksums (no second generation run).
- `stores only references and metadata - never image bytes` (slot-store) and
  `keeps the persisted slot row free of image bytes` (pipeline-recovery) — the assets
  column holds storage keys + checksums as JSON and the test asserts the whole column
  weighs **< 4096 bytes**; the import demo in §3.3 measured **537 bytes** for one slot
  with one asset.
- `never records a publication — publish_ready stays separate from publishing` —
  `select count(*) from publish_runs` is **0**.
- `uses the Jakarta calendar day, not the UTC day` — at 18:00Z the scheduler runs
  `2026-10-13…` while UTC still says the 12th; `Asia/Jakarta` is fixed UTC+7 (DST-free),
  and the previous UTC day has zero jobs.
- `after downtime a tick runs ONE slot, not the whole day` — clock frozen at 23:00 Jakarta
  so every slot of the day is overdue → 1 enqueued, 1 executed, the remainder reported as
  `catch_up_limited` (asserted `> 1`). Live smoke agrees: `executed=1 skipped=21`.
- `writes exactly one durable checkpoint for the contended key` — the scheduler checkpoint
  row is written by whichever process wins the tick, exactly once.

---

## 5. Fail-closed configuration (no mock fallback, ever)

`tests/db/failure-modes.test.ts` (8 tests):

- production configured as `file`/`memory` → decision carries
  `production requires "postgres"`;
- `PERSISTENCE_BACKEND=postgres` without `DATABASE_URL` → error in **both** production and
  development, message contains no `postgres://`;
- `NODE_ENV=production` without `DATABASE_URL` → `EnvironmentError` with
  `missingKeys` containing `DATABASE_URL`;
- the decision object is serialisable without leaking user/password/URL;
- an unreachable database reports `unreachable … ECONNREFUSED 127.0.0.1:1` **without**
  the password, user or URL, and `migrationStatus()` degrades to `null` instead of
  throwing;
- an unconfigured handle reports `configured=false`, `db=null`,
  `DATABASE_URL not set` — it does not pretend to be healthy.

In code: `buildContainer()` throws `EnvironmentError` when `PERSISTENCE_BACKEND=postgres`
but no handle exists; `main.ts` refuses to start (exit **78**) when the backend is
`postgres` and the database is unreachable or the migration status is not consistent.
File/memory stores remain available for development and tests only — they can never be
selected implicitly while postgres is configured.

---

## 6. Defects found **by these tests** and fixed in PART 5

These are real bugs that existed in the PART 5 code before the suite caught them. They are
listed because they are the evidence that the suite tests something.

1. **Broken SQL in migration `0002`** — `"id smallint` (missing closing quote) rejected by
   PostgreSQL. drizzle-kit exits `1` with no message, so the statement was applied
   manually to surface it.
2. **Broken migration journal** — snapshot named `0003_snapshot.json` while the journal
   ended at idx 2; `drizzle-kit check` failed and `generate` wanted to re-create existing
   migrations. Renamed to `0002_snapshot.json`; `check` OK, `generate` → no changes.
3. **snake_case vs camelCase row mapping** — Drizzle returns *schema property* names.
   `recordToValues()` used column names, so Drizzle silently ignored them and the INSERT
   shipped `default` for every field (NULL `slot_key` → NOT NULL violation), while the
   readers returned `undefined` fields for multi-word columns.
4. **Timestamps passed as ISO strings** — Drizzle's timestamp columns call
   `toISOString()`; every write failed with `TypeError: value.toISOString is not a
   function`. All timestamps now cross the driver boundary as `Date | null`.
5. **SQL_ASCII cluster** — with `initdb` defaults the throwaway cluster stored text as
   SQL_ASCII and rejected the emoji in a caption (`22P05`). `initdbFlags:
   ['--encoding=UTF8','--locale=C']` added; captions with emoji now round-trip.
6. **`releaseExpiredSlotLocks()` always reported 0** — an `UPDATE` without `RETURNING`
   has no rows to count. Added `returning slot_key`.
7. **Tokenless `complete`/`fail` could rewrite a terminal job** — a stale/duplicate
   completion succeeded because the tokenless path was unguarded. Both now refuse a job
   already in `succeeded`/`failed`.
8. **`db:import` wrote rows during a dry run** — the slot insert loop ran before the
   `--apply` check. Moved inside the apply branch; the dry run is now provably read-only.
9. **`db:status` called an empty database "drift"** — a never-migrated database reported
   exit 4 with a misleading problem line. Now: empty → *pending* (exit 3); application
   tables without bookkeeping → *drift* (exit 4).

---

## 7. Regression matrix — PART 1–4 behaviour preserved

| Invariant | Where it is asserted | Result |
|-----------|----------------------|--------|
| Backend tests | `npm test` | **533 / 533** (unchanged from PART 4) |
| `/health` reports `part: 1` | smoke + unit tests | PASS |
| Flutter tests | `flutter test` | **147 / 147** |
| Flutter `find.textContaining('FAILED')` appears once | Flutter tests | PASS |
| `automatedFidelityScore` stays `null` | unit + smoke (`value=` empty) | PASS |
| Caption ends **exactly** `#ai #automation` | DB test + smoke (`tail=#ai #automation`) | PASS |
| `MAX_CAPTION_ATTEMPTS = 3` | unit tests | PASS |
| Anti-catch-up `maxCatchUpPerTick = 1` (no bursts) | DB test + smoke (`enqueued=2026-10-12#22 executed=1 skipped=21`) | PASS |
| 60-minute interval, 24 slots/day, Asia/Jakarta | DB test + smoke | PASS |
| Job identity `content:<slotKey>` | DB test + smoke (`content:2026-10-12#22`, `succeeded attempts=1`) | PASS |
| **Facebook/Threads publishing disabled** | smoke (`mode=disabled configured=False`, both `not_attempted`, 0 publish-kind jobs, 0 non-fixture publish records) | PASS |
| No live publishers invoked anywhere | `SCHEDULER_MODE=mock`, `AI_*_provider=mock`, `allowLive:false` | PASS |

**PART 4 live smoke re-run:** `TOTAL=51 PASS=51 FAIL=0` — identical to the PART 4 result,
against the PART 5 code, on `127.0.0.1:8794`, `NODE_ENV=development`, fresh
`backend/data`, mock providers, throwaway secrets (never committed).

---

## 8. Exactly-once: what is and is not guaranteed

**Guaranteed (database-enforced):**

- *One job per slot per day* — `jobs.unique_key = content:<slotKey>` is UNIQUE; re-running
  a tick can only reset the same row, never create a second logical job.
- *One row per slot* — `slot_contents.slot_key` is UNIQUE; a second reservation loses the
  `INSERT … ON CONFLICT DO NOTHING` race.
- *One claimer per job* — `FOR UPDATE SKIP LOCKED` + claim token; a worker that lost the
  claim cannot `complete`/`fail` the job (`STALE_JOB_CLAIM`).
- *One writer per version* — `UPDATE … WHERE version = <expected>`; a stale writer gets a
  conflict instead of clobbering newer state, and expired slot locks bump the version.
- *One product per slot* — product reservation is a row write guarded by the same
  version/unique rules.
- *One import per natural key* — catalog upsert on `(feed_id, marketplace)`, batches by id.

**Not guaranteed (stated honestly):**

- **At-least-once, not exactly-once, for the pipeline body.** If the process dies *after*
  images were generated but *before* the row was written, generation repeats on the next
  attempt. The persisted image count and already-validated assets are reused (asserted),
  but a crash inside the provider call can cost one more call.
- **No distributed transaction across job + slot + storage.** The job row and the slot row
  are committed separately (both by the same worker, in the same order). A crash between
  them leaves a `succeeded` job with a `publish_ready` slot or vice versa; both are
  reconciled by the next tick because the slot — not the job — is the source of truth for
  content state.
- **Object storage is not transactional.** An uploaded object can exist without a slot row
  referencing it (orphan). Orphans are harmless (no slot points at them) and are not
  auto-deleted.
- **Exactly-once *publication* is out of scope by design** — publishing is disabled, so
  there is no delivery side to reason about yet. When it is enabled, `publish_runs` already
  enforces one row per `(slot_key, provider)` and publication retries will stay separate
  from generation retries.
- **Recovery never publishes.** `recoverOnStartup()` only requeues expired claims, fails
  jobs that exhausted their budget, and releases expired slot locks. It never marks a step
  complete without a durable write and never starts a publication.

---

## 9. NOT_TESTED / BLOCKED

| Item | Status | Why |
|------|--------|-----|
| Facebook / Threads live posting | **NOT_TESTED** | No credentials; `allowLive:false`; smoke asserts `configured=False`, `not_attempted` |
| Telegram live send, live AI text/image, S3 upload, live Shopee feed API | **NOT_TESTED** | No credentials; mock providers only, and they are labelled `mock` in every response |
| Managed/production PostgreSQL (RDS, Cloud SQL, …) | **BLOCKED** | No instance available. A real PostgreSQL **17.10** server was used locally, over TCP, with the same `DATABASE_URL` code path |
| 24/7 continuous operation | **BLOCKED** | Requires an always-on deployment, which does not exist in this environment. The scheduler's cross-process lock, lease renewal and checkpoint code paths are exercised in tests, but time-based availability is not observable here |
| Windows local test-cluster helper accounts | **DONE** | `db.ps1 -Action remove-helper` deletes the account recorded in the gitignored `backend/tmp/pg-helper.json`; both local accounts used by the throwaway cluster (`autopilot_pg_test` and the older `pglocal`) were removed as the last step of this delivery. A later `npm run test:db` recreates the helper on demand |

---

## 10. Hygiene

- **No credentials committed.** No `.env`, no `DATABASE_URL`, no `pg-*.json`. Cluster
  credentials live in gitignored `backend/tmp/`.
- **No runtime data committed.** `backend/tmp/`, `backend/data/`, `app/` build output are
  ignored; the throwaway cluster directory, probe scripts and test logs were deleted, and
  the two local helper accounts used only for the test cluster were removed.
- **Drizzle snapshots are now committed** (the old `.gitignore` rule hid them, which is
  what allowed the journal/snapshot mismatch reported in §6, item 2).
- **No temp database files, no debug scripts** (`debug-scheduler.ts`,
  `debug-selection.ts` remain deleted).
- The local PostgreSQL cluster is **stopped** at the end of every `test:db` run (unless
  `-KeepCluster`).

---

## 11. Reproduce everything

```bash
# backend
cd backend
npm run typecheck && npm run lint && npm test && npm run build
npx drizzle-kit check && npm run db:generate     # no changes expected
npm run test:db                                  # cluster + migrations + 60 tests + status + verify

# optional CLIs (need DATABASE_URL from backend/tmp/pg-status.json)
npm run db:status     # 0/2/3/4/1
npm run db:verify     # 0/2/5/1
npm run db:import -- --dir <folder>              # dry run; add --apply to write

# flutter
cd app
flutter analyze && flutter test && flutter build apk --debug

# PART 4 live smoke (server first, then script)
cd backend && npm start                          # env from §7
powershell -ExecutionPolicy Bypass -File ../docs/implementation/part-04-smoke.ps1
```
