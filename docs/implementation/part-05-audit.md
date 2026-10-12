# PART 5 — Pre-Implementation Audit

Date: 2026-10-12 · Baseline: PART 4 commit **`02a79cb`** (working tree clean before
this part) · Verifier: manual code audit of `backend/src`, `backend/drizzle`,
`backend/package.json`, every store/scheduler/queue consumer, and the PART 4
evidence set. No code was edited before this document was written.

---

## 1. Git and baseline state

| Item | Value |
| --- | --- |
| Branch | `master`, no remote |
| Baseline | `02a79cb` (Part 4), preceded by `1f6d9a1` (Part 3), `d8390e8` (Part 2), `2fa19a8` (Part 1) |
| Working tree at start of PART 5 | clean (PART 4 was committed first, per user instruction) |
| Runtime data in repo | none (`backend/data/` gitignored and absent, no `.env`, no debug scripts) |
| Test totals at baseline | backend **533** (20 files), Flutter **147** |

## 2. Database stack already installed (reuse, do not add parallel stacks)

| Package | Version | Role |
| --- | --- | --- |
| `drizzle-orm` | `^0.45.2` | ORM (dependency) |
| `postgres` | `^3.4.9` | postgres.js driver (dependency) |
| `drizzle-kit` | `^0.31.11` | migration generator/runner (devDependency) |
| `zod` | `^3.25.76` | env validation (dependency) |

Existing scripts: `db:generate`, `db:migrate` (`drizzle-kit migrate`), `env:check`.
**No new database library is required.**

`drizzle.config.ts` reads `process.env.DATABASE_URL` directly and — audit finding —
**falls back to a hard-coded placeholder DSN**
(`postgres://postgres:postgres@localhost:5432/autopilot`) when the variable is
absent, which would silently target somebody else's local database. That default
must be removed (§3).

## 3. Migration audit (findings)

Files under `backend/drizzle/`:

| File | Tracked | In `_journal.json`? | Applied anywhere? |
| --- | --- | --- | --- |
| `0000_init.sql` | yes | **yes** (idx 0) | no database available |
| `0001_part3_catalog.sql` | yes | **NO — orphaned** | no database available |
| `meta/_journal.json` | yes | contains only idx 0 | — |
| `meta/0000_snapshot.json` | **ignored** by `.gitignore` (`backend/drizzle/meta/*_snapshot.json`) | — | — |

**Finding M1 (critical).** `0001_part3_catalog.sql` is not referenced by the
journal, so `drizzle-kit migrate` would **silently skip it** on a fresh
database: `slot_contents` and the Part 3 `products` columns would never be
created, and every later migration would run against a wrong baseline. This is
exactly the class of "migration that looks applied but is not" the brief warns
about.

**Finding M2.** Snapshots are gitignored, so `drizzle-kit generate` cannot
produce a trustworthy diff in a fresh clone (it sees no prior state).

**Finding M3.** No migration **status/check** command exists. `db:migrate`
applies; nothing reports pending / applied / failed, and nothing verifies the
live schema against `src/db/schema.ts`.

**Finding M4.** The `0001` header comment claims BLOCKED status ("has NOT been
applied … verified only by the Drizzle schema snapshot"). That claim must stay
accurate: nothing may be reported as applied unless a real run recorded it in
`__drizzle_migrations`.

**Plan:** repair the journal (add idx 1 → `0001_part3_catalog`), add `0002_part5_*.sql`
for this part, add `db:status` + `db:verify` CLI commands, remove the placeholder
DSN fallback, and verify the whole chain from scratch against a **real** PostgreSQL
(§10).

## 4. Production-critical state inventory (where it lives today)

| State | Today | Durable across restart? | PART 5 target |
| --- | --- | --- | --- |
| Slot records (reservation, product, image count, assets, captions, stage, blockers) | `FileSlotStore` → `backend/data/slots.json` (memory under `NODE_ENV=test`) | yes (file), no (memory) | **PostgreSQL** |
| Job queue (`content:<slotKey>` identities, attempts, retry) | `InMemoryJobQueue` — a `Map` | **NO — lost on restart** | **PostgreSQL** |
| Job claim / ownership | `claimedBy` string, no lease, no expiry | NO | **PostgreSQL + lease** |
| Scheduler `lastTick` / checkpoint | `ContentScheduler` instance field | **NO** | **PostgreSQL checkpoint** |
| Automation settings (automationState, interval, cap, image policy) | `FileSettingsStore` → `settings.json` | yes (file) | **PostgreSQL** |
| Product catalog + import metadata | `FileCatalogStore` → `catalog.json` | yes (file) | **PostgreSQL** (`products` + `import_batches`) |
| Publish ledger / notifications / api_clients | schema only — **never written by any runtime path** | n/a | left as-is (publishing stays disabled) |
| Object storage (image bytes) | `MemoryObjectStorage` | NO | **unchanged** — S3 is BLOCKED; bytes are never put in PostgreSQL |
| Database handle | `createDatabaseHandle(env.DATABASE_URL)` created in the container but **no store ever uses it** | n/a | becomes the real store backend |

**Finding P1.** `container.ts` builds a `DatabaseHandle` that only `/health` and
the integration-health view read. Zero persistence paths touch Drizzle today —
the schema is aspirational, not wired.

**Finding P2 (brief §7).** With `DATABASE_URL` unset the app silently runs on
file/memory stores; `client.ts` documents this as intentional ("running in
in-memory mode"). For **production** that is a silent-fallback violation: it must
become a hard startup failure.

## 5. Concurrency model today (and its limits)

- `SlotContentStore.mutate()` — per-slot-key **in-process** promise chain. Correct
  for one process; **no protection at all against a second process/worker**.
- `FileSlotStore.save()` — unique temp + rename + per-path FIFO queue (PART 4 fix).
  Single-writer-per-host only.
- `InMemoryJobQueue.claim()` — flips `pending → running` in JS; atomic only because
  Node is single-threaded. Not shared between processes.
- Scheduler `tick()` — in-process `running` flag (overlapping tick = no-op).

**Finding C1.** Every uniqueness guarantee in PART 1–4 is in-process. The brief's
requirements (two concurrent ticks, two workers, stale workers, lease expiry)
**cannot** be met without database-level enforcement: `INSERT … ON CONFLICT`,
`FOR UPDATE SKIP LOCKED`, unique indexes, and conditional updates.

**Finding C2.** `InMemoryJobQueue.enqueue()` creates a *second* job row for a
`uniqueKey` whose previous job `failed` (it only short-circuits for
non-terminal/succeeded). The `jobs_unique_key_idx` unique index in `0000_init.sql`
would **reject** that insert — i.e. the in-memory semantics and the committed
schema already disagree. PART 5 must pick one semantic and document it.

## 6. Schema gaps for PART 5

Existing `src/db/schema.ts` tables: `api_clients`, `products`, `slot_contents`,
`jobs`, `publish_runs`, `notifications`, `import_batches`.

| Need (brief §4/§5) | Present? |
| --- | --- |
| unique slot identity | yes — `slot_contents_slot_key_idx` UNIQUE |
| unique job identity | yes — `jobs_unique_key_idx` UNIQUE |
| job lease / claim deadline / claim token | **missing** |
| job completion timestamp / result | **missing** |
| slot optimistic version / lock owner (stale-writer guard) | **missing** |
| scheduler checkpoint | **missing** (no table) |
| settings document | **missing** (no table) |
| FK from slot → product | yes (`ON DELETE SET NULL`) |
| indexes for due-job scan, stage scan | partial (`jobs_status_scheduled_idx`, `slot_contents_stage_idx`) |

Catalog `products` already has the unique `(feed_id, marketplace)` index used for
idempotent re-import.

## 7. File-store consumers (brief §7)

`FileSettingsStore`, `FileCatalogStore`, `FileSlotStore` share the PART 4
`atomicWriteText` primitive. Their `kind` unions are literally typed
`'memory' | 'file'` in three places (`SettingsStore`, `CatalogStore`,
`SlotContentStore.storageKind`), and `server.ts` reports them to the APK.

**Finding F1.** Adding a PostgreSQL backend therefore requires widening those
unions to include `'postgres'` — an additive contract change that must be
reflected in `/v1/settings`, `/v1/catalog*` and `/v1/pipeline/slots` responses.

**Finding F2.** Existing local `backend/data/*.json` files are user data. The
brief forbids silent discard/overwrite and unreviewed one-way conversion, so the
migration path must be: **backup first, explicit opt-in import, deterministic
conflict handling, idempotent (never re-import the same record twice)**.

## 8. Live publishing safety (must not regress)

- `allowLive: false` is hard-coded in `container.ts` for the notifier; Facebook /
  Threads publishers exist but **no code path invokes them** (`publish_ready` is
  terminal; `/v1/history/publishes` only ever returns `source: 'fixture'` rows).
- `publish_runs` has `dry_run` defaulting to `true` and a unique
  `(slot_key, provider)` index — reserved for a future, separately approved part.
- **PART 5 writes no publish rows, calls no external publish API, and does not
  add any publication path.**

## 9. Test infrastructure

- `vitest.config.ts` includes `tests/**/*.test.ts` with the explicit comment
  *"Contract/unit tests must never touch the network or a real database"* and a
  15 s timeout. 533 tests currently run there.
- **Finding T1.** Database integration tests must therefore live in a **separate
  vitest project/config** (`tests/integration/**`, own config, longer timeout,
  `test:db` script) so the default `npm test` stays DB-free and the integration
  suite is an explicit, reproducible command.
- **Finding T2.** The environment has **no PostgreSQL, no Docker, no psql, port
  5432 closed, no postgres Windows service**; `winget` offers installers but they
  require a UAC/admin prompt.

**Decision (user-approved):** add `embedded-postgres` as a **devDependency** — it
ships real PostgreSQL server binaries, runs unprivileged on a random local port,
is torn down after tests, and is never used by production code. This makes the
brief's "real isolated PostgreSQL database, not a mock" requirement achievable.
Production still connects through `DATABASE_URL` to a real server.

## 10. Constraints confirmed with the user

1. **PostgreSQL for tests** → `embedded-postgres` devDependency (real server, no admin).
2. **Git** → commit PART 4 separately (done: `02a79cb`), then PART 5 on top.

---

## 11. Implementation plan (derived from the findings above)

1. **Config & fail-closed startup** — new `PERSISTENCE_BACKEND`
   (`postgres` | `file` | `memory`); `production` ⇒ `postgres` mandatory,
   `DATABASE_URL` validated at startup, connectivity + migration state checked
   before serving, failure = exit with a **sanitized** message (never the DSN).
   Remove the placeholder DSN fallback in `drizzle.config.ts`.
2. **Migrations** — repair `_journal.json` (M1); add `0002_part5_persistence.sql`
   (job lease columns, slot version/lock columns, `scheduler_checkpoints`,
   `app_settings`); add `db:status` and `db:verify` commands; document ordering +
   recovery; verify from scratch on a real database.
3. **PostgreSQL stores** implementing the *existing* interfaces:
   `PostgresSlotStore`, `PostgresJobQueue` (lease + claim token + `SKIP LOCKED`),
   `PostgresSettingsStore`, `PostgresCatalogStore`, `SchedulerCheckpointStore`.
4. **Atomic reservation + concurrency** — `INSERT … ON CONFLICT DO NOTHING` for
   reservation, conditional `UPDATE … WHERE version = ?` for every later write,
   tick-level advisory lock, per-claim token so stale workers cannot commit.
5. **Crash recovery** — on boot: requeue expired leases (bounded by
   `attempts < maxAttempts`), report reclaimed jobs, resume non-terminal slots and
   **reuse** persisted image count + valid assets; never republish, never
   regenerate silently.
6. **File-store compatibility** — backend made explicit, production never falls
   back, `db:backup` guidance + idempotent `db:import-local` for existing
   `backend/data/*.json` (opt-in, no destruction).
7. **Tests** — unit (mapping, state transitions, lease/retry/recovery decisions,
   fail-closed config, editorial + `#ai #automation` preservation) + a real
   PostgreSQL integration suite covering the 10 scenarios in brief §9.
8. **Verification** — backend typecheck/lint/test/build, Flutter
   analyze/test/debug-APK, migration status, `test:db`, re-run of the PART 4 live
   smoke test.
9. **Evidence** — `part-05-evidence.md` with real commands/outcomes, PASS /
   BLOCKED / NOT_TESTED classification.

**Out of scope (will not be touched):** live Facebook/Threads publishing, S3
credentials, PART 6.
