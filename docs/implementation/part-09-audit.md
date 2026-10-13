# PART 9 — Audit: Production Deployment, Persistence, Recovery & Disaster Readiness

**Baseline:** PART 7B `6be5a85`, PART 8 `22e2608` — HEAD `22e2608`, working tree
**clean** at inspection, `origin` verified to target
`https://github.com/ciptaone/Automotion-Shopee-AFfiliate`, repo-local identity
`Autopilot Agent <ciptaone1@gmail.com>`. PART 8 present in the checked-out
source (`backend/src/ops/`, migration `0004_part8_ops_events.sql`,
`app/lib/screens/ops_screen.dart`, `backend/src/cli/preflight.ts` all verified
at HEAD). No history rewritten; PART 9 only; no PART 10; live publishing stays
disabled.

**Classification vocabulary:** `PASS` / `FAIL` / `BLOCKED` / `NOT_TESTED` /
`DOCUMENTED_ONLY` (new in PART 9: a runbook or config that exists and is
reviewable but was not executed against real infrastructure).

---

## 1. Inspection result — what actually exists (reuse map)

PART 9 must **reuse**, not parallel. Everything found during the audit:

| Area | What already exists (verified at HEAD) | Gap for PART 9 |
|---|---|---|
| Framework / start | Fastify 5 + Node 24 ESM, `tsx src/main.ts` (`npm run dev` / `npm run start`), `npm run build` → `dist/` via `tsc -p tsconfig.build.json` | No documented production start command, no service/proxy artifacts |
| Boot order | `main.ts`: env → logger → container → settings/catalog/slots init → **fail-closed DB gate (exit 78)** → `recoverOnStartup` → `buildServer` → listen → scheduler loop (60 s poll, first tick +2 s) → ops loop (5 min) | Gate logic is inline in `main.ts` and untested; no production-config validation beyond env schema |
| Shutdown | SIGINT/SIGTERM: `prepended` stop hooks clear the scheduler/ops intervals, then `app.close()` → `container.shutdown()` (closes pool) → `exit(0)` | **No grace period for an in-flight tick/job**, no readiness flip during shutdown, no bounded/force deadline, no test |
| Persistence | `core/persistence.ts`: production ⇒ `postgres` required (never file/memory), explicit `PERSISTENCE_BACKEND` pins the choice; `env.ts` enforces the same invariants | No production-required-settings validation (public URL, storage); no startup-gate unit tests |
| Migrations | Drizzle journal (5 entries, 13 tables), committed SQL `0000`–`0004`; `db:generate`, `db:migrate` (raw drizzle-kit), `db:status`, `db:verify` (schema diff, read-only) | No **single-run, race-safe release migrate step**; no test that refuses drifted databases; startup schema check untested |
| Schema verification | `db/migration-status.ts`: pure `computeMigrationStatus` (applied/pending/diverged/missing/unknown) + `loadMigrationStatus` live | Reuse as-is for the release step and the startup gate |
| Scheduler coordination | In-process overlap flag + **`PostgresSchedulerTickLock`** (advisory lock, one reserved connection, loser's tick becomes a no-op — proven in `tests/db/scheduler-concurrency.test.ts`), DB-backed checkpoints, **transactional daily cap** (`pg_advisory_xact_lock`, `daily-posting-cap` tests), `maxCatchUpPerTick=1` | Safe to run combined or split (API/worker) — must be **documented**, plus production verification that only one scheduler works |
| Queue | `PostgresJobQueue`: claim tokens + leases (default 120 s), `extendLease` heartbeat, `recoverExpiredLeases()` on boot, DB-clock stats; `InMemoryJobQueue` for dev | `leaseMs` not env-configurable; shutdown does not wait for active jobs |
| Recovery | `db/recovery.ts`: requeue expired leases (bounded by attempt budget), release expired slot locks, bump versions; idempotent; never touches `publish_ready` | Keep exactly as-is; only wire into the documented lifecycle |
| Health (PART 8) | `/health` (public, `part: 1`, liveness), `/ready` (public minimal: DB + migrations, 200/503), `/v1/ops/health|metrics|preflight` (scoped), cached provider probes, 11 components incl. `asset_storage`, `publishing_gate=disabled` | `/ready` must also fail **while shutting down** (liveness vs readiness split); boot/shutdown events not yet recorded |
| Notifications (PART 8) | `OpsMonitor.record` **never throws** (store failure ⇒ logged, delivery never claimed), fingerprint dedupe + cooldowns, bounded retries (3), no recursion, `TelegramHttpTransport` fixed to `api.telegram.org` | Add boot/shutdown event kinds (free-text `kind`, `varchar(40)`, **no migration needed**) |
| Storage | `ObjectStorage` contract (upload/head/verifyPublicAccess/delete/publicUrlFor), `MemoryObjectStorage` mock, **factory `createObjectStorage` currently returns the mock even when S3 creds are present**; container hardcodes `MemoryObjectStorage`; env already validates the S3 credential set as all-or-nothing | **No live S3 adapter at all** ⇒ durable production asset storage does not exist yet — must be implemented behind the same contract |
| Backup/restore | nothing | No runbook, no script, no drill. Local environment has **no `pg_dump` binary** (embedded-postgres ships only `initdb`/`pg_ctl`/`postgres`) ⇒ canonical pg_dump path is `DOCUMENTED_ONLY`/`BLOCKED` here |
| Deployment artifacts | nothing (README = local dev only) | Need systemd + reverse-proxy artifacts, runbooks, config matrix (dev/staging/prod) |
| Tooling | PowerShell harness `scripts/db.ps1` (embedded PG 17.10 at `127.0.0.1:55432`), `scripts/test-db.ps1`, `test:db` suite, `env:check`, `preflight`, `smoke:*` CLIs | Extend with release-migrate + backup/restore CLIs following the same conventions (documented exit codes, `sanitizeDatabaseError`, secret-free output) |

**Never-regress invariants carried into PART 9:** `/health` `part: 1`; no live
Facebook/Threads publishing (`allowLive:false` latch untouched); `maxCatchUpPerTick`
default 1; 3–4 posts/day in four WIB windows; caption/format rules;
`automatedFidelityScore` null; `MAX_CAPTION_ATTEMPTS = 3`; preflight enables
nothing; no secrets in responses/commits; `npm test` Flutter
`find.textContaining('FAILED')` semantics.

## 2. Chosen deployment architecture (§2)

**Topology A (default, least complex): one combined Node process**
(API + in-process scheduler + ops loop) started by systemd, behind an HTTPS
reverse proxy (nginx example), against managed/VM PostgreSQL and an
S3-compatible bucket. Chosen because the repository already runs this way, the
dangerous parts are already database-coordinated (advisory tick lock,
lease-based queue, transactional daily cap — all with real-PG tests), and no
Docker/cloud/VPS is assumed.

**Topology B (documented, optional): API/worker split** — same image/command,
`SCHEDULER_ENABLED=false` on API replicas, `true` on one or more workers.
Duplicate schedulers remain safe because every tick still goes through the
PostgreSQL advisory lock; the loser no-ops. Documented, not required.

**Automatic restart / health checks:** systemd `Restart=on-failure`,
`TimeoutStopSec` ≥ shutdown grace; liveness probe = `GET /health`, readiness
probe = `GET /ready` (fails during shutdown and on DB/schema problems).
TLS terminates at the proxy; PostgreSQL binds localhost/private network only.

**External blocker:** no server, domain, TLS certificate, managed database or
cloud credentials exist in this environment ⇒ live deployment stays
`DOCUMENTED_ONLY`/`BLOCKED`; artifacts + runbook ship, and every locally
verifiable piece (production-mode boot, migrate, probes, shutdown, outage
recovery, backup/restore drill) is executed against the embedded PostgreSQL.

## 3. Production configuration decisions (§3)

New env keys (all bounded, key-names-only errors, no values echoed):

| Key | Default | Bounds / rules |
|---|---|---|
| `PUBLIC_URL` | – | Required in `production`, must be `https://`; the public origin operators point the APK/reverse proxy at |
| `DATABASE_POOL_MIN` / `DATABASE_POOL_MAX` | 0 / 5 | Integers 0–8 / 1–50, `max ≥ min`; feeds `postgres.js` pool options (existing hard ceiling replaced by an explicit, validated one) |
| `SHUTDOWN_GRACE_MS` | 20000 | 1000–120000; bounded grace for in-flight jobs |
| `JOB_LEASE_SECONDS` | 120 | 30–3600; feeds `PostgresJobQueue.leaseMs` (today a hard-coded 120 s) |
| `S3_OBJECT_ACL` | unset | Optional (`public-read` etc.); only sent on upload when the bucket/endpoint supports ACLs — bucket policy remains the documented default |

New **production-only fail-closed rules** (added to the existing `superRefine`):
`DATABASE_URL` required (exists), non-wildcard CORS (exists), **`PUBLIC_URL`
required + https**, **complete S3 credential set required** (otherwise assets
would silently live in process memory — the exact failure §6 forbids),
**`AUTH_JWT_SECRET` must not be the `.env.example` `CHANGE_ME…` placeholder**.
Development/test keep working with zero extras — no unavailable credential is
required for local tests.

Mock providers in production are **not** a boot failure (PART 6 workspace
providers may supersede the env defaults; boot-failing would brick a legitimate
deployment) but they are never silent: a loud startup warning + a persistent
`production_mock_providers` ops event + PART 8 preflight already escalates
"provider not selected/tested while automation is running" to a blocker.
`preflight` continues to enable nothing.

Template: new `backend/.env.production.example` (placeholders only) + the new
keys appended to `.env.example`. Secrets never committed; APK never receives
backend credentials (unchanged boundary).

## 4. Migration & schema-safety decisions (§4)

- **New release step** `npm run db:migrate` → `src/cli/db-migrate.ts`:
  1. validate env, connect, refuse when unreachable (exit 1);
  2. take a dedicated PostgreSQL advisory lock (reusing
     `PostgresSchedulerTickLock` with name `autopilot_schema_migration`) so
     concurrent releases serialize — **no two instances ever race**;
  3. pre-check `loadMigrationStatus`: **refuse** on drift (app tables exist
     without bookkeeping), diverged/unknown records or missing files — never
     drops, resets or recreates anything (forward-fix only);
  4. apply pending journal entries via the drizzle-orm runtime migrator
     (single-run, inside the lock);
  5. re-read status and **require `consistent`**, release lock, exit 0.
  Exit codes follow the CLI convention: 0 OK, 1 blocker, 2 CLI/config failure.
  Raw drizzle-kit stays available (`drizzle-kit migrate` via npx) and documented
  as the escape hatch; journal history `0000–0004` untouched.
- **Startup schema verification** is extracted from `main.ts` into a pure-ish
  `src/app/startup-gate.ts` (`evaluateStartupGate`, injected database handle):
  postgres-backed boot requires healthy DB + consistent schema or exits 78 —
  now unit-testable for every failure mode (unreachable, pending, drift,
  unknown) plus dev/test paths (in-memory ⇒ ready). `main.ts` keeps acting.
- `db:status` / `db:verify` unchanged and re-run as evidence.

## 5. Lifecycle & graceful-shutdown decisions (§5)

- New `src/app/lifecycle.ts` shutdown coordinator (unit-tested):
  idempotent signal handling; registered stop callbacks run first (clear
  scheduler + ops intervals ⇒ **no new ticks, no new job claims**); tracked
  in-flight work (scheduler tick / ops pass) awaited under
  `SHUTDOWN_GRACE_MS`; readiness flips to 503 (`reason: shutting_down`) the
  moment shutdown begins; then `app.close()` (drain HTTP), then
  `container.shutdown()` (pool close); total deadline `SHUTDOWN_GRACE_MS + 15 s`
  forces exit 1 with a logged reason — the process can never hang a service
  manager.
- Jobs that outlive the grace window are **not** force-committed: claim-token +
  lease guards reject late writes (`StaleClaimError`, PART 5 tests), and
  `recoverOnStartup()` requeues them on the next boot. Daily caps stay
  transactional; `maxCatchUpPerTick=1` is untouched ⇒ **no catch-up bursts**;
  four WIB windows / 3–4 posts per day preserved.
- Existing startup order already matches §5 (validate → init stores → DB gate →
  recover → serve → start configured loops); it is kept, with the gate moved
  into the testable module and a best-effort `startup_failed` /
  `process_started` ops event added (monitor never throws).

## 6. Persistence & asset-storage decisions (§6)

- Implement `S3ObjectStorage` behind the existing `ObjectStorage` contract:
  AWS SigV4 (node:crypto), PUT/HEAD/DELETE through an **injected transport**
  (deterministic tests, no network in tests), 10 s timeout, bounded retries
  (≤3, network/5xx/429 only — never 4xx), path-style vs virtual-host style,
  `S3_PUBLIC_BASE_URL` honoured by `publicUrlFor`, `verifyPublicAccess` via a
  public HEAD/GET, errors/`info.detail` sanitized (secret key, auth header and
  query never appear).
- Factory `createObjectStorage(config)` (already present, currently a stub
  returning the mock) is fixed to return `S3ObjectStorage` when the credential
  set is complete, and wired into the container (which hardcodes the mock
  today). Production requires the S3 set at env validation ⇒ **production can
  never silently run on in-memory storage**; dev/test keep the free mock.
- Live bucket validation (real AWS/R2/Spaces/MinIO) needs credentials that do
  not exist here ⇒ live storage verification will be reported `BLOCKED`;
  adapter behaviour is proven with deterministic fixtures (interrupted upload,
  missing asset ⇒ `head` null, retry-then-success, 403 no-retry).
- Asset references in PostgreSQL (`slot_contents.assets[].storageKey/publicUrl`)
  are keys + URLs, not bytes ⇒ remain valid across restarts by construction;
  source/reference images live in the same bucket under `slots/…`. Retention:
  objects are kept as long as their DB row (deletion policy documented, not
  auto-executed).

## 7. Backup & restore decisions (§7)

- **Runbook** `part-09-backup-restore-runbook.md`: `pg_dump`/`pg_restore`
  (custom format, `--clean --if-exists` only against an **empty disposable**
  target), secure handling (0600, encrypted at rest via `gpg`/age or provider
  SSE, transfer over TLS/SSH), retention recommendation (7 daily / 4 weekly /
  6 monthly + WAL archiving for managed PG), verification steps, isolated
  restore procedure, post-restore `db:status` + `db:verify` + consistency
  checks (queue/lease/settings/catalog/events/usage-ledger row counts and
  invariants), RPO/RTO **targets** (not guarantees), and the hard rule: never
  restore over production. Local blocker: **no `pg_dump` binary in this
  environment** ⇒ that path is `DOCUMENTED_ONLY`/`BLOCKED`.
- **Repo-native, actually tested path** (compatible with the real tooling):
  `npm run db:backup` (`src/cli/db-backup.ts`) exports every public table as
  JSON plus a manifest (row counts, journal state, PG version) — read-only, no
  schema DDL; `npm run db:restore` loads into a **freshly migrated, empty**
  target (refuses non-empty tables, inserts in FK dependency order, then
  verifies row counts against the manifest + migration consistency). A real-PG
  test drills the whole cycle into a disposable second database.

## 8. Monitoring & recovery decisions (§8)

- Liveness (`/health`, unchanged `part: 1`) vs readiness (`/ready`, now also
  503 while shutting down) stay separate; `/v1/ops/health` remains the detailed
  authenticated view.
- New low-cardinality ops event kinds (no migration): `process_started` (info,
  recorded after successful boot+recovery ⇒ restart visibility across boots),
  `startup_failed` (critical, best-effort before exit 78 — recorded through the
  same bounded, deduplicated, non-recursive notification path),
  `shutdown_timeout` (warning), `production_mock_providers` (warning).
- Existing PART 8 5-minute evaluation loop already covers database/schema drift,
  scheduler heartbeat, queue backlog/oldest age/expired leases, budget state,
  provider readiness from **cached probes**, storage probe and publishing-gate
  state; cooldowns + fingerprint dedupe are the storm control (documented).
- Transient DB failure and restart recovery are verified by tests (contract
  test flipping the DB handle healthy→unhealthy→healthy for `/ready`, existing
  real-PG lease-recovery/pipeline-recovery tests) plus one live production-mode
  outage drill in §10.

## 9. Security & network-boundary decisions (§9)

- Ops/admin endpoints keep PART 8 auth + scope checks (tests re-run, unchanged).
- New server bounds: Fastify `connectionTimeout` 15 s, `requestTimeout` 600 s
  (existing `bodyLimit` 25 MB kept for feed uploads); storage retries ≤3 with
  10 s per-attempt timeout; shutdown grace bounded by `SHUTDOWN_GRACE_MS`;
  Telegram/provider retry bounds unchanged.
- PostgreSQL: documented as localhost/private-network only, credentials only in
  server-side env; `sanitizeDatabaseError` keeps DSNs out of logs/responses.
- SSRF: custom provider endpoint policy untouched; `S3_ENDPOINT` is
  operator-controlled env (never user input); Telegram host stays fixed.
- Deploy artifacts use placeholders only; CORS stays explicit-allowlist
  (wildcard rejected in production); `allowLive:false` publisher latch and
  preflight "enables nothing" are untouched.

## 10. Test plan (§10/§11)

New backend tests (deterministic mocks for units, real isolated PG for DB):
`startup-gate` unit (schema/db failure matrix + dev paths); env production-rule
matrix; `lifecycle` unit (idle stop, active stop waits, grace timeout, double
signal, readiness flip); `/ready` shutdown + transient-DB contract tests;
`db-migrate` DB tests (fresh apply, **concurrent lock serialization**, drift
refusal without destructive action); `s3-storage` unit (signing via an
independent HMAC computation in the test, retries, missing asset, redaction);
`part9-backup-restore` DB test (seed → backup → disposable DB → migrate →
restore → verify). Live production-mode drill (embedded PG): migrate → boot →
probes → scheduler init → graceful shutdown → restart/recovery → DB outage →
recovery. Regression: full backend typecheck/lint/tests/build, `test:db`,
`drizzle-kit check`, `db:status`/`db:verify`, PART 4 smoke, PART 7/8 contract
suites, `preflight`, `smoke:providers`/`smoke:telegram` (expect BLOCKED 2),
Flutter analyze/test/debug APK. No previous assertion weakened or removed.

## 11. Deliverables & non-goals

**Ships:** env additions + `.env.production.example`; `startup-gate.ts`;
`lifecycle.ts`; `cli/db-migrate.ts`; `cli/db-backup.ts` + `cli/db-restore.ts`;
`integrations/storage/s3-storage.ts` + fixed factory + container wiring;
`/ready` shutdown state + server timeouts; new ops event kinds; `deploy/`
systemd + nginx artifacts; four documents (`part-09-audit.md`,
`part-09-evidence.md`, `part-09-deployment-runbook.md`,
`part-09-backup-restore-runbook.md`); the tests above.

**Non-goals:** no PART 10 scope; no live Facebook/Threads publishing; no live
S3/AI/Telegram calls by default; no Docker/cloud-provider lock-in; no managed
infrastructure provisioning; no changes to the PART 4/5/6/7/8 behaviour or
migrations `0000–0004`; no Flutter feature work (gates only); no destructive
database operations anywhere in code or scripts.

---

## Addendum — implementation discoveries (recorded after the drills)

Two real defects were found by executing the PART 9 production-mode drills and
fixed forward-fix style, within PART 9 scope:

1. **Dist-layout migrations path.** `MIGRATIONS_FOLDER` resolved to
   `dist/drizzle` when running the compiled output (`node dist/src/main.js`),
   which does not exist. The startup gate failed closed exactly as designed
   (exit 78, secret-free problem), surfacing the bug instead of letting the
   process serve with an unreadable schema. Fixed in `src/db/client.ts` with a
   walk-up resolver that finds `drizzle/meta/_journal.json` in both the `src/`
   and `dist/src/` layouts; pinned by `tests/unit/migrations-folder.test.ts`
   and re-proven by the live production drills.
2. **`ops_events` delivery-check gap.** The notifier contract
   (`EventDeliveryResult.status`) allows `'skipped'` (severity/kind filter,
   notifications disabled), but the PART 8 CHECK constraint did not include
   it. The first info-severity event (`process_started`) triggered a failed
   `markDelivery` UPDATE — logged and non-fatal, but lossy. Fixed with a new
   migration `0005_part9_ops_delivery_skipped` (drop + re-add the check with
   `'skipped'` allowed), the matching `src/db/schema.ts` update, and
   `tests/db/part9-ops-delivery.test.ts` (also proving `'teleported'` is still
   rejected). The migration journal advanced 5 → 6; the PART 5/PART 8
   journal-length pins were advanced with the same strictness (counts and full
   tag lists asserted, nothing weakened); `drizzle-kit check`, `db:status` and
   `db:verify` all pass on the six-entry chain.

Decision confirmed by the drills: migrations are **never applied at service
start**; the systemd unit runs `node dist/src/main.js` only, and release
migrates happen as the explicit `npm run db:migrate` step, guarded by the
advisory lock. `RestartPreventExitStatus=78` keeps config/schema failures from
restart-looping.
