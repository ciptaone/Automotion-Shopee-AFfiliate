# PART 6 — Repository Audit & Implementation Plan

Mandatory pre-edit audit for PART 6 (custom AI providers, model selection, flexible
posting schedule). Written **before any source file was modified**.

Audit date: 2026-10-12 · Baseline commit: `5fd5431` (PART 5, clean working tree,
branch `master`, no remote).

---

## 1. Repository state at audit time

```
$ git status --porcelain
(no output — clean)

$ git log --oneline -6
5fd5431 Part 5: PostgreSQL persistence, migration safety and crash-safe scheduling
02a79cb Part 4: editorial policy gate, image-quality honesty, AI resilience, scheduler to pipeline
1f6d9a1 Part 3: persistent catalog, selection policy, real content pipeline
d8390e8 Part 2: dashboard control surface (settings, status, preview, history, integrations)
2fa19a8 Part 1: integration feasibility + foundation
```

| Area | Version / value |
| --- | --- |
| Node engine | `>=20.11.0` |
| fastify | `^5.6.1` |
| zod | `^3.25.76` |
| drizzle-orm / drizzle-kit | `^0.45.2` / `^0.31.11` |
| postgres (postgres.js) | `^3.4.9` |
| vitest | `^3.2.4` |
| embedded-postgres (test PG 17.10) | `^17.10.0-beta.17` |
| Flutter SDK | `^3.12.2`, app version `1.0.0+1` |
| Backend test baseline | `npm test` = **533 tests / 20 files**; `npm run test:db` = **60 tests / 6 files** |
| Flutter test baseline | `flutter test` = **147 tests**; `flutter analyze` = 0 issues |

Scripts available: `typecheck`, `lint`, `test`, `test:db`, `build`, `db:generate`,
`db:migrate`, `db:status`, `db:verify`, `db:import`, `env:check`.

## 2. Prior documentation read (as required)

* `docs/implementation/part-04-audit.md`, `part-04-evidence.md` — editorial policy
  gate (`pipeline/editorial-policy.ts`), image-quality honesty (`null` when no score),
  AI resilience layer (`integrations/ai/provider-runner.ts`), scheduler→pipeline loop.
  Live Facebook/Threads remain hard-disabled (`allowLive:false`, stub transport).
* `docs/implementation/part-05-audit.md`, `part-05-evidence.md` — PostgreSQL
  persistence, migration chain `0000→0001→0002`, `db:status` exit codes, lease/claim
  recovery, `FOR UPDATE SKIP LOCKED`, exactly-once limits, 60 DB tests, PART 4 smoke
  51/51. Nine defects found by tests are listed in evidence §6.

No open PART 5 blockers affect PART 6 except the documented NOT_TESTED items
(no live provider credentials, no managed PG instance, no always-on deployment).

## 3. Architecture inventory (what exists and will be reused)

### 3.1 Provider / AI layer today

* `src/contracts/index.ts` — provider-neutral contracts: `ImageGenerator`,
  `CaptionGenerator`, `ImageGenerationRequest/GeneratedImage`,
  `CaptionGenerationRequest/GeneratedCaption`, `ProviderInfo`, `JobQueue`,
  `Publisher`. **No vendor code outside `src/integrations/**`.**
* `src/integrations/ai/create-ai.ts` — env factory: `mock`/`disabled` → deterministic
  mock; `openai`/`google` → `unavailable-provider.ts` (fails fast, `ready:false`,
  never silently mock). No live HTTP adapter exists yet.
* `src/integrations/ai/provider-runner.ts` — resilience wrapper (timeout, bounded
  retries, rate-limit honouring, usage accounting, redaction). Wraps any
  `CaptionGenerator`/`ImageGenerator`; reusable for new adapters.
* `src/integrations/ai/mock-ai.ts` — deterministic mocks (labelled `kind:'mock'`),
  real PNG bytes, first-person-free captions ending `#ai #automation`.
* `src/automation/pipeline.ts` — stages: reserve product → validate URL → resolve
  reference image → **persist image count** → generate N images → validate/upload →
  caption + editorial validation → `publish_ready`/`blocked`/`failed`. Reuses valid
  assets on retry; explicit `regenerate` only.
* `src/pipeline/editorial-policy.ts` — centralized semantic validation: mandatory
  `#ai #automation` ending, affiliate URL + disclosure, first-person ownership/
  receipt/usage/endorsement detection (direct and possessive `-ku`/phrasal variants),
  with exact feedback used for bounded regeneration (`MAX_CAPTION_ATTEMPTS = 3`).

**Gaps vs PART 6:** all provider choice is env-driven (`AI_IMAGE_PROVIDER`,
`AI_TEXT_PROVIDER`), fixed at boot; no user-configurable base URL/model; no capability
contract; no health probes; no encrypted secret storage; no usage/cost ledger with
budgets.

### 3.2 Scheduling today

* `src/scheduler/slots.ts` — `SchedulerConfig{timezone, intervalMinutes,
  maxSlotsPerDay}`, `computeDailySlots()` builds a **60-minute grid capped at 24
  slots/day** (00:00 … 23:00 WIB), keys `YYYY-MM-DD#NN`, `nextSlot`,
  `describeSchedulerStatus`.
* `src/scheduler/content-scheduler.ts` — tick → due slots → anti-catch-up
  (`maxCatchUpPerTick` default 1) → idempotent `queue.enqueue` with
  `uniqueKey = content:<slotKey>` → claim → `pipeline.runSlot` → lease heartbeat.
  Cross-process tick lock (PG advisory) from PART 5.
* `src/settings/automation-settings.ts` — validated settings (`intervalMinutes`,
  `maxSlotsPerDay` ≤ 24, image-count policy, platform switches, selection mode),
  `SettingsStore` with memory/file/postgres backends.
* `src/db/postgres-job-queue.ts` — unique `jobs_unique_key_idx`, lease claims,
  `FOR UPDATE SKIP LOCKED`, crash recovery. **No explicit daily-count guard**: the
  24/day cap is only an emergent property of the slot grid.

**Gaps vs PART 6:** four fixed WIB windows (06–07, 12–13, 16–17, 19–20), target
3/4 (default 4), and a **transactional** daily cap in PostgreSQL.

### 3.3 Persistence / migrations

* `src/db/schema.ts` + `backend/drizzle/` journal `0000_init`, `0001_part3_catalog`,
  `0002_part5_persistence` (+ committed snapshots), `drizzle-kit check` OK.
* Single-document stores via `ON CONFLICT DO UPDATE` (`app_settings`,
  `scheduler_checkpoints`), `src/db/postgres-settings-store.ts`.
* `core/persistence.ts` fail-closed backend selection (production without
  `DATABASE_URL` refuses to start; no in-memory fallback).
* `db:status` (0/1/2/3/4), `db:verify`, `db:import` (dry-run default).

**Gaps vs PART 6:** no tables for provider configuration, encrypted secrets, or
generation usage.

### 3.4 HTTP API (`src/app/server.ts`, 794 lines)

Existing pattern: Fastify + `authenticate()` (HS256 JWT, issuer/audience) +
`requireScopes(['read'|'control'])` + Zod request schema + redacted error envelope
(`{error:{code,message,issues?}}`). 18 routes (`/health`, `/v1/auth/token`,
`/v1/settings`, `/v1/automation/*`, `/v1/catalog/*`, `/v1/pipeline/*`, …).
**Health contract locked:** `/health` keeps `part: 1`.

### 3.5 Flutter app

`app/lib`: `core/backend_client.dart` (typed HTTP + error mapping),
`core/autopilot_api.dart`, `models/automation_models.dart` + `api_models.dart`,
screens (`dashboard`, `settings`, `integrations`, `preview`, `history`, `login`,
`home_shell` with bottom navigation), 14 test files (147 tests) including
`find.textContaining('FAILED') exactly once` and `'24 slots scheduled'` fixtures.

### 3.6 Security primitives available for reuse

`src/core/redact.ts` (`redactString`, `redactDeep`, `[REDACTED]`),
`src/core/errors.ts` (`AppError` hierarchy with `code/category/httpStatus/expose/
retryable/context`), `src/core/env.ts` (single `process.env` read point, key names
only in errors, exit-78 `EnvironmentError`), `src/core/auth.ts`.

## 4. Findings (F) — what PART 6 must fix or add

| # | Finding | Impact |
| --- | --- | --- |
| F1 | Provider selection is env-only and fixed at boot; no base URL / model / auth configuration. | Blocks §2–§3. |
| F2 | No capability contract: nothing prevents a text-only endpoint being used for images. | Blocks §2/§5. |
| F3 | No outbound URL policy (SSRF, private ranges, metadata endpoints, redirect refusal, response-size caps). | Blocks §3. |
| F4 | No encrypted-at-rest secret storage; credentials would have nowhere safe to live. | Blocks §4. |
| F5 | No provider health/readiness states beyond `ready`/`detail`; connection success would be conflated with generation success. | Blocks §5. |
| F6 | No usage/cost ledger and no budget enforcement. | Blocks §10. |
| F7 | Schedule is a 24×60-minute grid; windows/target policy does not exist and the daily cap is not enforced transactionally. | Blocks §7. |
| F8 | No API/dashboard surface for provider management or schedule windows. | Blocks §3/§11. |
| F9 | `SchedulerConfig.maxSlotsPerDay` and several tests encode the 24-slot policy (`queue-scheduler-validation`, `content-scheduler`, `api`, `automation-api`, DB `scheduler-concurrency`, Flutter fixtures). | Expected test updates — **spec change, not assertion weakening**. |

## 5. Implementation plan (decided before editing)

### 5.1 New modules (backend)

| Module | Responsibility |
| --- | --- |
| `src/providers/types.ts` | `ProviderConfig` (id, name, displayName, adapterType, kind, baseUrl, model, auth, headers, params, timeouts, capabilities, enabled), Zod schemas, `CapabilityStatus` vocabulary (`not_configured`, `configuration_invalid`, `authentication_failed`, `ready`, `capability_unsupported`, `temporarily_unavailable`, `rate_limited`, `test_failed`). |
| `src/providers/endpoint-policy.ts` | URL validation: http/https only, no userinfo, length cap, literal-IP range blocking (loopback/private/link-local/CGNAT/metadata), hostname blocklist (`localhost`, `*.internal`, metadata hosts), **DNS resolution check**, and an explicit `SELF_HOSTED_ENDPOINT_ALLOWLIST` escape hatch for self-hosted endpoints. |
| `src/providers/transport.ts` | Bounded HTTP: hard timeout + `AbortSignal`, `redirect:'error'`, streamed response-size cap, JSON content-type check, status→error classification (401/403 auth, 429 rate limit, 5xx transient), redacted diagnostics, injectable `fetch` for tests. |
| `src/providers/adapters.ts` | Adapter registry with **explicit capability declarations**: `openai_chat_completions` (text + optional structured output), `openai_images` (image gen; reference/edit only when declared), `ollama_chat` (self-hosted text). No provider-name conditionals anywhere else. |
| `src/providers/provider-store.ts` | Workspace document (providers + text/image selection) with memory/file/postgres backends (same pattern as `SettingsStore`). |
| `src/secrets/secret-store.ts` | AES-256-GCM encryption (`SECRETS_ENCRYPTION_KEY` from server env), memory/file/postgres backends, `set/get/delete`, fail-closed when the key is missing, never returns stored secrets. |
| `src/providers/provider-service.ts` | CRUD + validation + selection + readiness tracking + bounded test actions (`test connection`, `test text`, `test image`), sanitized errors. |
| `src/providers/generation-router.ts` | Implements `CaptionGenerator`/`ImageGenerator` for the pipeline: resolves the **selected** provider per task, enforces capabilities + budgets, records usage, attributes provider/model, never falls back silently. |
| `src/usage/usage-store.ts` | Durable usage ledger (memory/file/postgres) + budget summary (day/month, actual vs estimated vs unknown). |

### 5.2 Changed modules

* `src/scheduler/slots.ts` — four WIB windows, `dailyPostTarget` 3|4 (default 4),
  `computeDailySlots` returns one slot per selected window (deterministic: first
  N windows in chronological order), status reports windows.
* `src/settings/automation-settings.ts` — additive `dailyPostTarget`, nullable
  `dailyBudgetUsd`/`monthlyBudgetUsd`; constraints extended; legacy
  `intervalMinutes`/`maxSlotsPerDay` fields preserved for compatibility.
* `src/contracts/index.ts` — additive optional `EnqueueJobInput.dailyCap`
  `{dayPrefix,max}`; typed errors carry `DAILY_POST_LIMIT`.
* `src/queue/job-queue.ts`, `src/db/postgres-job-queue.ts` — transactional daily
  cap (advisory lock + count + insert in one transaction; idempotent re-enqueue of
  an existing key still allowed).
* `src/scheduler/content-scheduler.ts` — passes the cap, records
  `daily_target_reached` as a skip reason.
* `src/core/env.ts` — `SECRETS_ENCRYPTION_KEY`, `SELF_HOSTED_ENDPOINT_ALLOWLIST`,
  `PROVIDER_HTTP_TIMEOUT_MS` (all optional; invalid values fail boot with key names only).
* `src/db/schema.ts` + `drizzle/0003_part6_providers.sql` — additive tables:
  `provider_workspaces` (single doc row), `provider_secrets` (ciphertext only),
  `generation_usage`. No drops, no rewrites of `0000–0002`.
* `src/app/container.ts` — wire stores + router into the pipeline (`imageGenerator`
  /`captionGenerator` become the router, still wrapped by the resilience runner).
* `src/app/server.ts` — new authenticated routes (§5.3), same auth/error pattern.

### 5.3 New API surface (all authenticated; secrets never echoed)

```
GET    /v1/providers                 list + capability/readiness + masked secret metadata
POST   /v1/providers                 create (validation, SSRF checks)
PUT    /v1/providers/:id             edit (never accepts a stored secret value)
DELETE /v1/providers/:id             delete only when not selected; else 409
PUT    /v1/providers/:id/secret      replace secret (write-only)  | DELETE …/secret
GET    /v1/providers/selection       text/image selections + fallback policy
PUT    /v1/providers/selection       independent text & image selection
POST   /v1/providers/:id/test/connection | /test/text | /test/image
GET    /v1/usage/summary             today/month usage, budget state, cost honesty
```

`GET /v1/scheduler/status` and `GET /v1/settings` gain additive fields
(`postingWindows`, `dailyPostTarget`, selected windows for today).

### 5.4 Test plan (never weakened)

New backend unit tests: endpoint-policy (SSRF matrix incl. metadata/loopback/
private ranges/allowlist), transport (timeout, oversized body, redirect refusal,
redaction), adapters (request shapes, capability refusal), provider-service
(validation, CRUD, secret masking, health transitions), secrets (round-trip,
missing key fail-closed, redaction), generation-router (independent selection,
no silent fallback, attribution, budget exhaustion), slots/settings (3/4 targets,
four windows, Jakarta boundaries), queue daily cap (memory + concurrency).
New DB tests (`tests/db/`): `0003` migration from zero, provider/secret/usage
persistence across restart, **two-worker daily cap enforcement**, crash/lease
recovery still green.

Existing tests updated **only where the PART 6 spec changed the policy** (24-slot
grid → 3/4 window targets); every other assertion stays.

Flutter: provider workspace screen (list/add/edit/delete/secret mask/select/test),
daily target selector (3|4) + windows display, usage/budget panel, models +
client methods + tests; existing `find.textContaining('FAILED')` and health
constraints unchanged.

### 5.5 Explicit non-goals (per brief)

* No PART 7 work.
* Live publishing stays disabled (`allowLive:false`, no publisher invocation in any
  new path, no fake publish records).
* No provider-specific conditionals scattered outside `src/providers/adapters.ts`.
* No credentials in Flutter storage, logs, responses, or committed files; no
  committed `.env`, no runtime data or temp DB files.

## 6. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Schedule policy change breaks existing tests | Treat as spec change: update only schedule expectations, document each change in evidence §"test deltas"; keep anti-catch-up/idempotency assertions identical. |
| SSRF defense bypass via DNS rebinding | Resolve + verify every A/AAAA at request time; refuse redirects; allowlist only explicit hostnames. |
| Secrets leaked via errors/logs | All provider paths pass through `redact.ts`; secrets stored only as AES-GCM ciphertext; responses expose presence + masked metadata only. |
| Budget blocks legitimate work | Budgets default `null` (unlimited); exhaustion raises a typed, visible error — never a silent fallback. |
| Migration risk on existing DBs | Additive `0003` only; `db:status`/`db:verify` re-run; no changes to `0000–0002` semantics. |
| Live provider claims without evidence | Every adapter/test result classified PASS/BLOCKED/NOT_TESTED; live provider smoke requires credentials (expected BLOCKED here). |
