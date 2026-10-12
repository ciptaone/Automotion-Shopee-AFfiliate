# PART 1 — STEP E: Evidence Ledger

**Product:** Shopee Affiliate Autopilot
**Executed:** 2026-10-12, times in **Asia/Jakarta (WIB, UTC+7)** unless a UTC
stamp is shown. The environment clock reported UTC in machine output; WIB =
UTC+7.
**Environment:** Windows 11 · Node v24.15.0 · npm 11.12.1 · Flutter 3.44.4 ·
Dart 3.12.2 · Git 2.55.0 · **no PostgreSQL, no Docker, no live credentials.**

Every row was produced by a command actually executed in this session. **No
output was fabricated.** Mock vs real is stated for each. No secrets appear in
any evidence below.

---

## Legend

- **PASS** — executed and behaved as expected.
- **FAIL** — executed and did not (fixed where possible; see remediation).
- **BLOCKED** — cannot run in this environment; precise reason given.
- **NOT_TESTED** — deliberately not exercised (by the "no unauthorized calls /
  no paid usage" rule).

---

## A. Toolchain & environment

| ID | Objective | Command / procedure | Status | Mock/Real | Evidence / remediation |
|---|---|---|---|---|---|
| ENV-01 | Detect Flutter | `Get-Command flutter` + `flutter --version` | **PASS** | Real | Flutter 3.44.4 stable, Dart 3.12.2. First run triggered a one-time `fetch --tags`. |
| ENV-02 | Detect Node/npm | `node --version`, `npm --version` | **PASS** | Real | v24.15.0 / 11.12.1. |
| ENV-03 | Detect DB/container tooling | `Get-Command psql,docker` | **BLOCKED** | Real | Neither installed ⇒ no disposable Postgres for migration test. |
| ENV-04 | npm registry reachable | `Invoke-WebRequest https://registry.npmjs.org/-/ping` | **PASS** | Real | HTTP 200. |
| ENV-05 | Backend deps install | `npm install --no-audit --no-fund` (backend) | **PASS** | Real | 254 packages. First attempt **FAILED** (`drizzle-kit@^0.32.0` ETARGET); fixed to `^0.31.11` then reinstalled. |

## B. Backend static checks

| ID | Objective | Command | Status | Mock/Real | Evidence / remediation |
|---|---|---|---|---|---|
| BE-01 | TypeScript type check | `npx tsc -p tsconfig.json --noEmit` | **PASS** | Real | exit 0. Initial run had 40+ errors (relative paths, `any`, duplicate key, logger typing) — all fixed; clean on re-run. |
| BE-02 | Lint | `npx eslint .` | **PASS** | Real | exit 0. Initial run had 13 errors (unused vars, `any` in tests) — fixed via test override + `_`-prefix + using `RECOMMENDED_FIELDS`. |
| BE-03 | Production build | `npx tsc -p tsconfig.build.json` | **PASS** | Real | exit 0. |
| BE-04 | Env validation (invalid) | `npx tsx src/cli/check-env.ts` (no secrets set) | **PASS** | Real | exit **78** (EX_CONFIG); prints key **names** only. |
| BE-05 | Env validation (valid) | same, with `AUTH_JWT_SECRET` + `CORS_ORIGINS` set | **PASS** | Real | exit 0; lists 8 integrations, 3/8 credentialled, **no values printed**. |

## C. Backend unit + contract tests

**Command:** `npx vitest run` (backend)
**Aggregate:** **8 test files · 214 tests · 214 passed · 0 failed** (≈4.7 s).
All offline; no network, no DB, no paid API.

| ID | Objective | Scope covered | Status | Mock/Real |
|---|---|---|---|---|
| T-REDACT | Secret redaction | 20 tests: Telegram token, Meta token, AWS key, Bearer, JWT, URL query params, deep-struct masking, circular refs, non-mutation, truncation. | **PASS** | Real (pure functions) |
| T-ENV | Environment validation | 27 tests: required keys, key-name-only errors, frozen output, wildcard-CORS-in-prod reject, tz validation, 24-slot cap, interval-vs-cap invariant, AI-key pairing, FB/Threads/Telegram/S3 pairing, postgres URL, `describeIntegrationStatus` no-leak. | **PASS** | Real |
| T-AUTH | JWT auth | 17 tests: mint/verify round-trip, tamper rejection, alg=none rejection, malformed, wrong aud/iss, expiry + clock-skew, `requireScopes`. | **PASS** | Real (node:crypto) |
| T-FEED | Feed parse/dedupe | 24 tests: header alias resolution, format detection (ext + PK magic), CSV & real-XLSX parse, marketplace default/override, affiliate-URL fallback, id dedup (first wins), required-field rejection, quoted commas, derived-id determinism, empty-row skip, no-recognized-columns error, empty-file error, thousands-separator prices. | **PASS** | Real (SheetJS on real .xlsx bytes) |
| T-AI | AI mocks | 20 tests: PNG signature/IHDR/IDAT/IEND, determinism, seed variance, size, zero cost; caption embeds affiliate URL verbatim, Indonesian, **no fabricated testimonial/discount/commission**, price formatting, omits missing price. | **PASS** | Mock (deterministic, $0) |
| T-ADAPTER | Storage/Publishers/Telegram | 39 tests: storage upload/head/verify/delete + deterministic failure + public-access denial; FB request shape + redaction; Threads 2-step flow + 500-char clamp; **live-disabled latch (no network I/O)**; Telegram dedupe/retry/format. | **PASS** | Mock (stub transport) |
| T-QUEUE | Job queue + scheduler + validation | 46 tests: queue uniqueness, no re-run after success, claim atomicity (no double-claim), earliest-first, retryable backoff, non-retryable fail, max-attempts, list limit; **24 slots @60m**, slot cap, stable keys, Asia/Jakarta local↔UTC, next-slot, day rollover; caption + image publish-gate rules, fabrication detectors, hashtag/emoji helpers. | **PASS** | Real (pure) |
| T-API | HTTP API contract | 21 tests: `/health` 200 + no-secret-leak canary; integrations; token issuance 200/400/401; `/v1/me` 401 (missing/malformed/tampered/wrong-aud/expired) + 200; scheduler & jobs require auth; 403 on missing scope; JSON 404. | **PASS** | Real (Fastify inject) |

**Notable individual assertions (all PASS):**
- Publisher adapters **never** hit the stub transport unless `allowLive` is set —
  asserted via `transport.lastRequest === null`.
- Access token absent from every `describeRequest` output (key-aware redaction).
- `/health` and other bodies contain no Telegram-token or Meta-token patterns.

## D. Backend runtime verification

| ID | Objective | Procedure | Status | Mock/Real |
|---|---|---|---|---|
| RUN-01 | Server boots | Started `npx tsx src/main.ts` on `PORT=8099`, polled `/health` | **PASS** | Real process |
| RUN-02 | `/health` correctness | `Invoke-RestMethod http://127.0.0.1:8099/health` | **PASS** | Real | Returned `status:ok`, `part:1`, DB `not_configured`, scheduler `Asia/Jakarta / 60m / 24 slots`, 8 integrations with honest modes (`disabled`/`mock`), and 2 degraded reasons. |

## E. Database migrations

| ID | Objective | Command | Status | Mock/Real |
|---|---|---|---|---|
| DB-01 | Generate SQL migration | `npx drizzle-kit generate --name init` | **PASS** | Real | Produced `backend/drizzle/0000_init.sql`; 6 tables / 8 indexes / 2 FKs detected. |
| DB-02 | Apply migration to a disposable DB | `drizzle-kit migrate` | **BLOCKED** | — | **No PostgreSQL server or Docker in this environment.** Runtime uses the in-memory queue; Postgres shares the `JobQueue` interface for later. |
| DB-03 | DB-backed tests | — | **BLOCKED** | — | Same reason as DB-02. |

## F. Flutter app

| ID | Objective | Command | Status | Mock/Real |
|---|---|---|---|---|
| FE-01 | Scaffold + deps | `flutter create … app` + `flutter pub add http flutter_secure_storage` | **PASS** | Real | 35 files + 36 deps. |
| FE-02 | Static analysis | `flutter analyze` | **PASS** | Real | **No issues found.** Initial run had 4 issues (`encryptedSharedPreferences` removed in v9, `CardTheme`→`CardThemeData`, 1 string-interp, stale template test) — all fixed. |
| FE-03 | Unit tests | `flutter test` | **PASS** | Real | **8/8 passed** — model parsing of the exact backend JSON contract, resilience to missing/null fields. |
| FE-04 | Android debug build | `flutter build apk --debug` | **PASS** | Real | `✓ Built build\app\outputs\flutter-apk\app-debug.apk` (147.6 MB; multi-ABI debug artifact). |
| FE-05 | APK secret audit | Manual review of `app/lib/**` | **PASS** | Real | Only `BACKEND_URL` (non-secret) is build-time. **No Shopee/Meta/AI/DB/storage secret present.** |

## G. Integration live checks (explicitly NOT performed)

| ID | Integration | Status | Precise reason |
|---|---|---|---|
| LIVE-01 | Shopee Affiliate **live feed** | **BLOCKED** | No official feed API doc retrievable (`affiliate.shopee.co.id`, `open.shopee.com/...` returned no content) **and** no real feed sample. Parser built on sanitized fixtures. |
| LIVE-02 | Facebook **live publish** | **NOT_TESTED** | No Page token **and** live publishing is deliberately gated (`allowLive:false`). No real post created. |
| LIVE-03 | Threads **live publish** | **NOT_TESTED** | No Threads app/token **and** gated. No real post created. |
| LIVE-04 | Threads **token refresh** | **BLOCKED** | Requires a real Threads app + user consent. |
| LIVE-05 | Telegram **live send / getMe** | **NOT_TESTED** | No bot token; automated tests must not send real messages. In-memory transport used. |
| LIVE-06 | AI **live image generation** | **NOT_TESTED** | No provider key; no cost incurred. Deterministic PNG mock used. |
| LIVE-07 | AI **live caption generation** | **NOT_TESTED** | No provider key; no cost incurred. Deterministic template mock used. |
| LIVE-08 | S3 **live upload** | **NOT_TESTED** | No S3 credentials; live adapter deferred. In-memory mock used. |
| LIVE-09 | APK ↔ **deployed HTTPS backend** | **NOT_TESTED** | Requires a deployed host + TLS + real install key. Local loopback verified instead. |

## H. Compliance checks (acceptance criteria)

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| AC-01 | No unauthorized public post | **PASS** | Publishers hard-latched (`allowLive:false`); `transport.lastRequest===null` asserted in tests. |
| AC-02 | No real Telegram message | **PASS** | In-memory transport; dedupe/retry tested without network. |
| AC-03 | No paid API cost incurred | **PASS** | AI/S3 all mocks; mocks report $0.00. |
| AC-04 | No unrelated files overwritten | **PASS** | Directory was empty at audit; nothing pre-existing touched. |
| AC-05 | Secrets absent from logs/evidence | **PASS** | Redaction unit tests + API secret-leak canary + key-name-only env errors. |
| AC-06 | Automatic publish gated on validation | **PASS** | `blocksPublish()` publish-gate + fabrication detectors tested. |

---

## Summary

| Category | PASS | FAIL | BLOCKED | NOT_TESTED |
|---|---|---|---|---|
| Env & toolchain | 4 | 0 | 1 | 0 |
| Backend static | 4 | 0 | 0 | 0 |
| Backend tests | 8 files (214 tests) | 0 | 0 | 0 |
| Backend runtime | 2 | 0 | 0 | 0 |
| Database | 1 | 0 | 2 | 0 |
| Flutter | 5 | 0 | 0 | 0 |
| Live integrations | 0 | 0 | 3 | 6 |
| Compliance | 6 | 0 | 0 | 0 |

**Overall:** foundation **complete and verified locally**. All available unit and
contract tests executed and passing (214 backend + 8 Flutter). External live
compatibility is explicitly **BLOCKED / NOT_TESTED** — no unauthorized or paid
external activity occurred.
