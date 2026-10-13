# PART 9 — Evidence (Production Deployment, Persistence, Recovery & Disaster Readiness)

Every result below was executed in this repository on 2026-10-13 against the
accepted PART 8 baseline. Labels are strict (§10): **PASS** = executed and
verified here · **BLOCKED** = executable here but impossible without external
credentials/infrastructure · **NOT_TESTED** = deliberately not attempted ·
**DOCUMENTED_ONLY** = procedure shipped, no infrastructure attached to claim
execution against.

Environment: Windows host, Node 24.15.0, Flutter (app/), embedded PostgreSQL
17.10 test cluster (throwaway, `127.0.0.1:55432`, never production
credentials). Live publishing remained **disabled** throughout.

---

## 1. Regression gates (§11) — full suite, actual counts

| # | Gate | Command | Result |
|---|---|---|---|
| 1 | Backend typecheck | `npm run typecheck` | **PASS** — exit 0 |
| 2 | Backend lint | `npm run lint` | **PASS** — exit 0 (0 problems) |
| 3 | Backend unit + contract | `npm test` | **PASS** — exit 0, **44 files, 953/953 tests** (PART 8: 890; +63 new PART 9 tests) |
| 4 | PostgreSQL integration | `npm run test:db` | **PASS** — exit 0, **11 files, 109/109 tests** (PART 8: 95; +14 new), plus `db:status` (6/6 applied, no drift) and `db:verify` (live schema == `src/db/schema.ts`) |
| 5 | Migration files | `npx drizzle-kit check` | **PASS** — exit 0 |
| 6 | Build | `npm run build` | **PASS** — exit 0 (`dist/src/main.js`) |
| 7 | PART 4 live smoke | `part-04-smoke.ps1` vs `127.0.0.1:8794` (`SCHEDULER_ENABLED=true SCHEDULER_MODE=mock` mock providers, fresh data dir) | **PASS** — **`TOTAL=52 PASS=51 FAIL=0`**, script unchanged; boot log: 0 error lines, real enqueue `2026-10-13#02`, `#01` skipped `catch_up_limited`, executed → `blocked` (publishing gate). NOTE: a first run FAILED 2/51 because the on-disk `backend/data/` still held **today's terminal slots from the PART 8 smoke run** (documented precondition: fresh data dir); stale state moved aside, re-run green, original state restored afterwards. Not a code defect. |
| 8 | Preflight | `npm run preflight` | **PASS** — exit 0, 6 checks (migrations, daily_target, windows, timezone, budget, publishing_gate), "No state was changed" |
| 9 | PART 7 provider live smoke | `npm run smoke:providers` | **BLOCKED / NOT_TESTED** — exit 2, missing `LIVE_SMOKE_*` keys (names printed only, no values). No live AI call made. |
| 10 | PART 8 Telegram live smoke | `npm run smoke:telegram` | **BLOCKED / NOT_TESTED** — exit 2, missing `LIVE_SMOKE_TELEGRAM_*`. No message sent. |
| 11 | Flutter analyze | `flutter analyze` | **PASS** — 0 issues (190.9 s) |
| 12 | Flutter test | `flutter test` | **PASS** — **176/176** |
| 13 | Flutter debug APK | `flutter build apk --debug` | **PASS** — built `app-debug.apk` |
| 14 | Live S3 validation | — | **BLOCKED** — no bucket credentials; the adapter is proven by deterministic unit tests + `live_ready` wiring in the prod drill |
| 15 | Live cloud deployment | — | **DOCUMENTED_ONLY** — `part-09-deployment-runbook.md`; no server/domain/TLS/managed DB attached |

No assertion was weakened. Two existing PART 5/PART 8 **journal-length pins**
were advanced 5 → 6 when migration 0005 was added (count update, same
strictness); all other tests are untouched.

## 2. New tests shipped (all PASS)

| Suite | Tests | What it proves |
|---|---|---|
| `tests/unit/startup-gate.test.ts` | 9 | gate refuses pending/drift/unreadable schema; file/memory boot never probes a DB; production mock warnings are loud but never fatal; problems carry only sanitized strings |
| `tests/unit/lifecycle.test.ts` | 9 | stop-first ordering, callbacks once + fault-isolated, bounded grace, abandoned work reported, idempotent double-signal, rejected promises swallowed |
| `tests/unit/s3-storage.test.ts` | 19 | **known-answer test vs the published AWS SigV4 test-suite vector**, canonical-request pinning, URL styles, bounded retries (5xx/429/network; 4xx terminal), interrupted upload, missing asset → `null`, public verification, delete idempotency, constructor validation, **no secret/Authorization in any error surface** |
| `tests/unit/env-production.test.ts` | 10 | production requires `PUBLIC_URL` (https), full S3 set, non-placeholder secret, explicit CORS; pool/lifecycle bounds; pool max ≥ min everywhere |
| `tests/unit/dotenv.test.ts` | 4 | `.env` loads once, real env wins, missing file is normal |
| `tests/unit/migrations-folder.test.ts` | 2 | migrations folder resolves to the real journal in src AND dist layouts |
| `tests/contract/part9-lifecycle-api.test.ts` | 6 | `/ready` → 503 `stopping`/`shutting_down` with the same 5-key body and **no DB round-trip**; `/health` liveness unaffected; transient DB outage degrades and recovers; pending schema reported distinctly |
| `tests/db/part9-release-migration.test.ts` | 4 | fresh apply + idempotent re-run; **two concurrent releases serialize** (one applies, bookkeeping never duplicated); drift refused with zero statements executed; lock name pinned |
| `tests/db/part9-backup-restore.test.ts` | 8 | full backup/restore drill (§backup runbook §5): counts, settings/catalog content, **queue usable post-restore**, lease survived, events/ledger round-trip, secret-free manifest, both refusals |
| `tests/db/part9-ops-delivery.test.ts` | 2 | migration 0005 fix: `skipped` delivery status persists; `teleported` still rejected |

## 3. Configuration & startup gate (§3)

- New keys (validated, bounded, documented in `.env.production.example`):
  `PUBLIC_URL`, `DATABASE_POOL_MIN/MAX`, `SHUTDOWN_GRACE_MS`,
  `JOB_LEASE_SECONDS`, `S3_OBJECT_ACL`.
- Production fail-closed at startup: `PUBLIC_URL` required + https, complete S3
  credential set (no silent in-memory assets), `AUTH_JWT_SECRET` must not be a
  `CHANGE_ME` placeholder, explicit CORS, pool max ≥ min. `[TESTED]` live:
  an incomplete/invalid production env exits 78 with key NAMES only.
- `.env` is actually loaded now (`src/core/dotenv.ts`, real env wins) — wired
  into main + all CLIs. Template-only repo contents verified (placeholders).

## 4. Release migrations (§4)

`npm run db:migrate` is an explicit, advisory-locked release step that refuses
drift/divergence/unknown/missing-files and never drops, resets or recreates.
`[TESTED]` live drill: fresh apply **6/6** → re-run "already current" →
bookkeeping dropped (simulated hand-restored DB) → **REFUSED, exit 1, zero
statements executed** → production boot against the drifted DB **exited 78**
with the exact problem quoted and a `startup_failed` (critical) ops event
recorded; drill DB then recovered via reset + re-migrate (6/6) — a destructive
step performed ONLY on the throwaway drill cluster.

## 5. Lifecycle, recovery & monitoring drills (§5/§8) — `[TESTED]`

| Drill | Observed |
|---|---|
| Prod boot (built output, scheduler off) | `/ready` → `{"status":"ready","checks":{"database":"ok","migrations":"ok"}}`; `/health` → 200 `part:1`; S3 `live_ready` |
| Graceful shutdown | `shutdown signal received` → `lifecycle: stopping new work` → loops stopped → `drained` → `container shutdown complete` → **exit 0**, 0 in-flight/0 abandoned, ~1 s |
| Scheduler-on prod boot (mock defaults) | loud startup **warning** + persistent `production_mock_providers` ops event; automation seeded `running` (documented `SCHEDULER_ENABLED` seed); tick enqueued `#02` → executed → **`blocked`** (publishing gate); catch-up bounded (`#01` skipped); restart recovery stats `appliedMigrations:6, requeuedJobs:0` |
| Transient PG outage | `/ready` → **503** `database_unreachable` while `/health` stayed **200** (liveness ≠ readiness) → PG restarted → `/ready` → **200 on the same process** |
| Ops-event dedup | `process_started` info ×2 and `startup_failed` critical ×2 as `occurrences` — **no storm**; a live `migration_pending` warning fired by itself when 0005 became pending on the running instance (drift-while-running detection) |
| Duplicate schedulers | pre-existing advisory tick-lock + lease + daily-cap tests still green in the DB suite |

## 6. Storage (§6)

- Live SigV4 S3 adapter behind `ObjectStorage`; production factory now returns
  it when credentials are complete (was hardcoded mock). Deterministic unit
  suite above; production drill showed `s3_storage: live_ready`.
- Asset references remain PG-persisted rows valid across restarts; missing
  objects surface as `blocked` slots. Live bucket upload: **BLOCKED** (no
  credentials). No persistence is claimed from the local-FS adapter.

## 7. Backup & restore (§7)

- Runbook: `part-09-backup-restore-runbook.md` (pg_dump canonical
  `[DOCUMENTED]`, repo-native tested, retention/encryption/verification,
  isolated restore, post-restore checks, RPO/RTO as targets).
- Drill `[TESTED]`: see §2 `part9-backup-restore.test.ts` — full round trip on
  isolated databases with a live lease and usable queue post-restore; both
  destructive paths refused. Live pg_dump: **BLOCKED** (no binary here).

## 8. Security review (§9) `[TESTED/DOCUMENTED]`

- HTTPS: `PUBLIC_URL` must be https in production (unit-tested); nginx TLS
  template shipped. Ops endpoints keep auth scopes (contract tests, unchanged).
- No secrets in logs (gate/migration/storage errors carry key names only —
  asserted in tests), in backup manifests (asserted), in deploy artifacts
  (placeholders only) or in this commit (diff reviewed, §12).
- SSRF policy, request bounds (25 MB body / 15 s connect / 600 s request),
  retry bounds and shutdown grace are all explicit and tested.
- Live publishing remains **latched off**; nothing in PART 9 enables it.

## 9. Defects found & fixed DURING PART 9 (drill value)

1. **Dist-layout migrations path** — `MIGRATIONS_FOLDER` resolved to
   `dist/drizzle` under the compiled output; the startup gate correctly failed
   closed (exit 78) and exposed it. Fixed with a walk-up resolver
   (`src/db/client.ts`) + pinned by `migrations-folder.test.ts` and the drills.
2. **`ops_events` delivery-check gap** — the notifier contract allows
   `status:'skipped'` (severity/kind filter) but the PART 8 CHECK constraint
   did not; the first info-severity event (`process_started`) hit a failed
   UPDATE. Fixed forward-fix style: migration
   `0005_part9_ops_delivery_skipped` + schema + regression test. Journal
   advanced 5 → 6; `drizzle-kit check`, `db:status`, `db:verify` all pass.

## 10. Delivery (§12/§13)

- Diff staged for secrets/runtime/temp files: only source, tests, deploy
  templates (placeholders), `.env.production.example` (placeholders) and docs.
  Git identity `ciptaone1@gmail.com`; single PART 9 commit on top of `22e2608`;
  push after remote-history check (never force); `git ls-remote` verification.
  *(Commit/push values recorded in the §14 delivery report.)*

## 11. Publishing-disabled confirmation

Across every drill: no Facebook or Threads call was possible (no tokens
configured, publisher latch off); slots ended `blocked`; the PART 4 smoke and
contract suites continue to pin `contentScheduler.publishing: disabled`.
