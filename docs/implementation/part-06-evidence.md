# PART 6 — Implementation Evidence

**Scope:** provider-agnostic AI text/image providers (custom endpoints, encrypted
secrets, capability/health tracking), the 3–4 posts/day Asia/Jakarta windowed
schedule, per-request usage/budget accounting, the Flutter provider workspace,
tests and migrations — all layered on top of PART 1–5 without regressing them.

**Baseline:** `5fd5431` (PART 5, `master`, no remote).
**Publishing remains disabled everywhere** (`allowLive:false`, publishers never
invoked). No live AI/credential smoke was possible in this environment (see §9).

Every claim below was executed on this machine. Counts are copied from the real
tool output, not estimated.

---

## 1. Backend — typecheck / lint / build

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | **PASS** — 0 errors |
| Lint | `npm run lint` (`eslint .`) | **PASS** — 0 errors, 0 warnings |
| Build | `npm run build` (`tsc -p tsconfig.build.json`) | **PASS** — artefact produced |

## 2. Backend — unit + contract tests

`npm test` (vitest, unit + contract, no network):

```
Test Files  29 passed (29)
Tests       730 passed (730)
```

**PASS — 730/730** (PART 5 baseline was 533/533; +197 tests are PART 6).

New/extended suites and what they prove:

| Suite | Tests | Proves |
|---|---|---|
| `provider-service.test.ts` | 36 | config validation; secrets fail-closed (`SECRETS_ENCRYPTION_KEY` missing → write rejected, no plaintext fallback); independent text/image selection; `PROVIDER_IN_USE` 409 on delete/disable of a selected provider; connection test ready/401→`authentication_failed`/ECONNREFUSED→`temporarily_unavailable`; text/image tests (401/429/timeout classification, `capability_unsupported`, usage ledger rows); readiness invalidation on config change; restart persistence; self-hosted endpoint allowlist (accept allowlisted host:port, reject different port, reject without allowlist) |
| `generation-router.test.ts` | 12 | env-default labelling (`info.detail`, never a "fallback"); configured-provider attribution (`providerId`, model, `adapterType`); independent text/image selection; **no silent fallback** — unsupported capability, upstream failure and missing credential all block instead of switching provider; operator-disabled capability narrowing; budget gating before any request (daily budget exhausted → `BudgetExhaustedError`, stub transport NOT called); unknown-cost request does not exhaust the budget; usage recorded for success and error |
| `daily-posting-cap.test.ts` | 11 | 4 posts then 5th → `DailyPostLimitError`; target 3; idempotent re-enqueue doesn't consume the cap; different-day isolation; non-content jobs not counted; omitted cap = unlimited (legacy); `countDay`; `dayLockKey` stable/32-bit/differs-per-day; **16 parallel enqueues converge on exactly 4** |
| `settings.test.ts` | 40 | daily target default 4, accepts only 3/4, rejects 0/1/2/5/24/-1/3.5; four WIB window labels; restart persistence; budgets default null, positive persists, reject negative, null clears |
| `usage-budget.test.ts` | — | per-request usage records; actual/estimated/unknown cost classification; daily/monthly budget enforcement and exhaustion blocking |
| `endpoint-policy.test.ts` | — | URL scheme/userinfo/fragment rules; metadata-IP and private-range blocking; DNS-resolution check; allowlist semantics |
| `provider-transport.test.ts` | — | timeout clamp, `redirect:'error'`, streamed response-size cap, JSON content-type discipline, status→typed-error mapping, injectable fetch |
| `provider-adapter-contract.test.ts` | — | capability narrowing allowed / widening rejected; provider-neutral contracts carry provider/model/requestId/usage |
| `secret-store.test.ts` | — | AES-256-GCM seal/open; fresh IV per write; key rotation invalidates (wrong key → fail closed); no key → `SecretsKeyMissingError` |
| `queue-scheduler-validation.test.ts`, `content-scheduler.test.ts`, `api.test.ts`, `automation-api.test.ts` (contract) | — | rewritten to the windowed schedule (≤4 slots/day, WIB windows) with no weakened PART 1–4 assertions |

### 2.1 New contract suite — `providers-api.test.ts`

`npx vitest run tests/contract/providers-api.test.ts`:

```
Tests  14 passed (14)
```

**PASS** — HTTP contract for `/v1/providers*` and `/v1/usage/summary`:

- every provider endpoint requires auth (401 without a token);
- reads need `read` scope, mutations/tests need `control` (403 otherwise);
- create/list/update/delete round-trip; SSRF-rejected base URL → 400 before it
  is stored; duplicate name → 400; unknown id → 404 (malformed patch → 400);
- reserved credential-bearing header (`Authorization` in `extraHeaders`) → 400;
- **credential endpoints never echo the secret**: `PUT/DELETE …/secret` and
  `GET /v1/providers` bodies are recorded and asserted to never contain the
  plaintext (checked against the full value AND its middle substring);
- independent text/image selection; selecting an image provider as text → 503
  `capability_unsupported`; deleting a selected provider → 409;
- bounded test routes: success → `ready` + "nothing was published" note + real
  `requestId`; 401 → `authentication_failed` (response < 4 KB, no credential);
  text test marks `text_generation` + `authentication` ready and records a usage
  row with `costKind: unknown`; image test on a text adapter →
  `capability_unsupported`; AbortError → `temporarily_unavailable`;
- `GET /v1/usage/summary`: empty honest ledger, `budget.blocked=false`,
  day/month `exhausted=false`, `unknownCostRequests=0`.

## 3. PostgreSQL integration (`npm run test:db`)

Real PostgreSQL 17.10 (isolated throwaway cluster via `backend/scripts/db.ps1`,
applies all four committed migrations with `drizzle-kit migrate`):

```
Test Files  7 passed (7)
Tests       76 passed (76)
```

**PASS — 76/76** (PART 5 baseline was 60/60; +16 are PART 6).

New file `tests/db/part6-providers.test.ts` (16 tests) proves, against a real
database and a second connection pool ("restarted backend"):

- **provider workspace persistence**: providers + independent text/image
  selections + readiness round-trip across restart; empty DB yields the empty
  workspace (no crash, no mock); single-row invariant holds across repeated
  saves;
- **secrets encrypted at rest**: the row contains only `iv/tag/ct/alg`
  (`A256GCM`); the plaintext and its middle substring appear in NO column; a
  replaced secret gets a fresh IV; decrypt works after restart with the same
  key; a **different key returns `null`** (fail closed, ciphertext untouched);
  with no key configured the write throws `…/SECRETS_ENCRYPTION_KEY/` and
  **nothing is written**; delete is idempotent;
- **usage ledger**: 4 records (actual/estimated/unknown/error) persist across
  restart; cost classification intact; `totals()` reports `actualCostUsd=0.004`,
  `estimatedCostUsd=0.002`, `knownCostUsd=0.006`, `unknownCostRequests=2`
  (unknown cost is surfaced, never folded into $0); check constraints reject
  invalid `cost_kind`/`status`;
- **transactional daily cap**: two `PostgresJobQueue` instances over two
  independent pools enqueuing 8 keys for the same Jakarta day concurrently →
  exactly **4 created, 4 refused** with `DailyPostLimitError` (advisory xact
  lock); a sequential storm of 12 keys stops at 3 (target 3); re-enqueue of a
  live key is idempotent and does not consume the cap; the cap is per-day-prefix
  (next day gets a fresh allowance; a non-content job bypasses it); omitting
  `dailyCap` preserves the legacy unlimited behaviour.

`db:status`: journal entries 4, applied 4, pending 0, no drift.
`db:verify`: live schema matches `src/db/schema.ts` (tables, columns, indexes,
checks) including the three PART 6 tables.

Migration safety: `0003_part6_providers.sql` is **additive only** — it creates
`provider_workspaces`, `provider_secrets`, `generation_usage`. No `DROP`, no
`ALTER` of existing tables, no data rewrite. `npx drizzle-kit check` passes.

## 4. PART 4 live smoke re-run

`docs/implementation/part-04-smoke.ps1` against a freshly booted backend
(`127.0.0.1:8794`, empty `backend/data`, `SECRETS_ENCRYPTION_KEY` set):

```
TOTAL=48  PASS=45  FAIL=3
```

The 3 failures are **time-of-day dependent, not regressions**:

```
[FAIL] scheduler enqueued a job into the queue :: waited=00:02:00 count=0
[FAIL] queued job kind=content_slot           :: count=0
[FAIL] contentScheduler.lastTick recorded     :: still null
```

The smoke script waits 2 minutes for the scheduler to enqueue a job — an
assumption that held under the PART 4 hourly cadence (a slot always came due
within 60 minutes). Under the PART 6 windowed schedule the run started at
~07:15 WIB when the next window (12:00–13:00 WIB) was ~5 hours away, so no job
was due inside the 2-minute observation window. The scheduler itself was
healthy in the same responses: `slotsToday=4`, `next=2026-10-13#02` (the second
WIB window), `maxCatchUpPerTick=1`, and the manual `tick` reported
`skipped=0` with no published platform — i.e. correct anti-catch-up, no burst,
publishing still disabled. All 45 other checks (PART 1 health key, token,
editorial `#ai #automation` ending, disclosure, honest `automatedFidelityScore:
null`, `notAssessed` list, mock/live attribution, verbatim affiliate URL,
file-persisted slot, no non-fixture publication records, integrations disabled)
PASS unchanged. The smoke script itself was **not modified** — no assertion was
weakened.

## 5. Flutter — analyze / test / debug APK

| Check | Command | Result |
|---|---|---|
| Analyze | `flutter analyze` | **PASS** — `No issues found!` |
| Tests | `flutter test` | **PASS — 162/162** (PART 5 baseline 147/147; +15 PART 6) |
| APK | `flutter build apk --debug` | **PASS** — `app-debug.apk` built (48 s) |

New/updated Flutter surface:

- `models/provider_models.dart` — `CapabilityStatus` (all 8 backend statuses),
  `CapabilityProbe`, `ProviderSecretMetadata`, `ProviderSelection`,
  `ProviderView`, `ProviderWorkspacePayload`, `ProviderTestResult`
  (+ `ProviderTestText`/`ProviderTestImage`), `UsageSummaryModel`,
  `BudgetStatusModel`, `UsageTotalsModel`, `UsageRecordModel` — all nullable-safe
  so a newer backend can never crash the APK;
- `models/automation_models.dart` — `AutomationSettings` gains `dailyPostTarget`
  (clamped 3/4), `dailyBudgetUsd`, `monthlyBudgetUsd`; `SettingsConstraints`
  gains `minDailyPostTarget`/`maxDailyPostTarget`/`defaultDailyPostTarget`/
  `postingWindows` (four WIB labels);
- `core/backend_client.dart` — `DELETE` support + `deleteAuthed`;
- `core/autopilot_api.dart` — `fetchProviders`, `createProvider`,
  `updateProvider`, `deleteProvider`, `saveProviderSecret`,
  `deleteProviderSecret`, `saveProviderSelection`, `testProviderConnection`,
  `testProviderText`, `testProviderImage`, `fetchUsageSummary`;
- `screens/providers_screen.dart` — provider list with per-capability
  readiness chips (colour by the 8-status vocabulary), add/edit dialog
  (adapter, custom base URL + model with client-side URL checks, auth type),
  write-only credential dialog (masked, cleared after save, hidden when the
  server key is absent), bounded test actions with sanitized results (fixture
  caption flagged "never published", `PASSED`/`FAILED` chip), independent
  text/image selection dropdowns with the explicit no-fallback note, usage &
  budget card (known vs unknown cost, blocked state);
- `screens/settings_screen.dart` — "Daily posting plan" card: 3/4 segmented
  target, the four WIB windows with the first-N selected highlighted, optional
  daily/monthly USD budgets with non-negative validation;
- `screens/home_shell.dart` — sixth "AI" tab.

New test files:

- `providers_screen_test.dart` (10 tests) — empty state + next-step guidance;
  capability/readiness indicators; masked secret shown, clear text never;
  missing `SECRETS_ENCRYPTION_KEY` explicit error (no "Store key" button);
  connection test result including "Nothing was uploaded, stored or published";
  `find.textContaining('FAILED')` **exactly once** in the failure test; the
  honest `Authentication failed` status; independent text/image selection;
  usage ledger honest cost classification; budget-blocked chip; 5xx sanitized
  to `Backend error (HTTP 500)` (no internal message leak) with Retry.
- `daily_target_test.dart` (5 tests) — default 4 + four WIB windows rendered;
  switching to 3 marks the evening window skipped; `dailyPostTarget: 3` in the
  PUT body; non-numeric budget rejected client-side before sending; configured
  budgets pre-populate the fields.

`helpers.dart` gained `settingsFixture` PART 6 fields and dedicated
`providerViewFixture` / `providersWorkspaceFixture` / `usageSummaryFixture` /
`providerTestResultFixture` — all MockClient-based, no socket anywhere.

## 6. Migration & persistence summary

- Additive-only chain `0000 → 0001 → 0002 → 0003`; journal consistent; snapshots
  `0000_snapshot.json`/`0002_snapshot.json` untouched and still committed.
- Config (providers, selections, readiness, settings incl. daily target and
  budgets) survives restart — proven in both the unit suite (file/memory stores
  re-instantiated) and the PG suite (second pool).
- No in-memory/mock fallback in production paths: container falls back to
  memory stores only when `NODE_ENV=test`; production without a database uses
  file stores; providers never fall back to a mock model (`fallback: 'none'`).

## 7. Deviations (honest disclosure)

1. **`PROVIDER_HTTP_TIMEOUT_MS` env var was NOT added.** The audit proposed a
   global HTTP-timeout override; the implementation instead uses the
   per-provider `timeoutMs` (validated, clamped 1–120 s by the transport). This
   keeps one source of truth and avoids a second, conflicting knob. Global
   behaviour is still bounded.
2. **Live provider smoke is NOT_TESTED.** No OpenAI-compatible/Ollama endpoint
   credentials or budget exist in this environment, so the opt-in live smoke
   (real text/image generation against a configured provider) was not run.
   Everything else — endpoint policy, transport, adapters, readiness, usage —
   is covered by injected-fetch unit/contract/DB tests that never touch the
   network.
3. **PART 4 smoke: 45/48.** The 3 failures are the time-of-day scheduling
   observation described in §4 (script unmodified, assertions unweakened).

## 8. Safety invariants re-verified

- `/health` still returns `part: 1`; `contentScheduler.jobKind=content_slot`;
  `publishing=disabled`; `maxCatchUpPerTick=1`.
- Flutter `find.textContaining('FAILED')` appears exactly once per relevant
  test (pipeline preview + provider failure).
- `automatedFidelityScore` is `null`; `notAssessed` still lists
  `product_identity`/`packaging_fidelity`.
- Captions end exactly `#ai #automation`; `MAX_CAPTION_ATTEMPTS = 3`.
- No live publishers; no committed `.env`, runtime `data/`, or temp DB files.
- Secrets: AES-256-GCM, server-env key, write-only endpoints, masked previews,
  fail-closed without the key; the contract suite asserts no response body ever
  contains the secret.
- No provider-name conditionals in app code — capability dispatch happens only
  through the adapter registry (`backend/src/providers/adapters.ts`).

## 9. NOT_TESTED / BLOCKED (carried from PART 5 §9 plus PART 6)

- Live Facebook/Threads posting, live Telegram, live S3, live Shopee feed —
  no credentials, and live publishing is intentionally disabled.
- Live AI provider text/image generation against a real endpoint (no
  credentials/budget) — §7.2.
- Managed PostgreSQL / always-on deployment — local isolated cluster only.

## 10. Files touched (PART 6)

Backend: `src/providers/{types,endpoint-policy,transport,provider-store,adapters,provider-service,generation-router}.ts`,
`src/secrets/secret-store.ts`, `src/usage/{usage-store,usage-service}.ts`,
`src/db/{schema.ts,postgres-job-queue.ts}`, `src/app/{container.ts,server.ts}`,
`src/settings/automation-settings.ts`, `src/cli/db-verify.ts`,
`drizzle/0003_part6_providers.sql` (+ journal/snapshot).

Tests: new `provider-service`, `generation-router`, `daily-posting-cap`,
`endpoint-policy`, `provider-transport`, `provider-adapter-contract`,
`secret-store`, `usage-budget`, `providers-api` (contract),
`part6-providers` (DB); extended `settings`; rewritten
`queue-scheduler-validation`, `content-scheduler`, `api`, `automation-api`,
`scheduler-concurrency`, `migrations`; `helpers.ts` truncate list extended.

Flutter: `models/{provider_models,automation_models}.dart`,
`core/{backend_client,autopilot_api}.dart`,
`screens/{providers_screen,settings_screen,home_shell}.dart`,
`test/{helpers,providers_screen_test,daily_target_test}.dart`.

Script fix: `backend/scripts/db.ps1` — `New-LocalUser` description shortened to
≤48 chars (Windows limit); behaviour unchanged.

---

**Overall:** PASS, with the three documented deviations/limitations in §7
(one unimplemented env knob, live provider smoke untestable here, 3
time-of-day-dependent smoke observations). No PART 1–5 behaviour was regressed;
no assertion was weakened; publishing stays disabled.
