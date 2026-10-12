# PART 2 — STEP F: Evidence Ledger (Dashboard & Control Surface)

**Product:** Shopee Affiliate Autopilot
**Executed:** 2026-10-12, times in **Asia/Jakarta (WIB, UTC+7)** unless a UTC
stamp is shown.
**Environment:** Windows 11 · Node v24.15.0 · npm 11.12.1 · Flutter 3.44.4 ·
Dart 3.12.2 · Git 2.55.0 · **no PostgreSQL, no Docker, no live credentials.**

Every row was produced by a command actually executed in this session. **No
output was fabricated.** Mock vs real is stated for each. No secrets appear in
any evidence below. PART 1 work, contracts and tests were preserved unchanged
(214 PART 1 tests still pass; total is now 293).

---

## Legend

- **PASS** — executed and behaved as expected.
- **FAIL** — executed and did not (fixed where possible; see remediation).
- **BLOCKED** — cannot run in this environment; precise reason given.
- **NOT_TESTED** — deliberately not exercised (by the "no unauthorized calls /
  no paid usage" rule).

---

## A. Backend (settings, status, control, fixtures)

**Commands:** `npm run typecheck`, `npm run lint`, `npx vitest run` (backend)
**Aggregate:** **12 test files · 293 tests · 293 passed · 0 failed** (~8.2 s).
Type check exit 0, lint exit 0. All offline; no network, no DB, no paid API.

| ID | Objective | Scope covered | Status | Mock/Real |
|---|---|---|---|---|
| BE2-01 | TypeScript type check | `tsc -p tsconfig.json --noEmit` | **PASS** | Real |
| BE2-02 | Lint | `eslint .` | **PASS** | Real |
| T-SETTINGS | Settings model & store | 30 tests: validation bounds (interval 15–720, slots 1–24, interval×slots≤1440), `SettingsService` defaults from env, `InMemorySettingsStore` (test), atomic `FileSettingsStore` (write-then-rename, JSON repair on corrupt file), `automationState` not settable via PUT. | **PASS** | Real (tmp files) |
| T-FIXTURES | Deterministic preview/history | 18 tests: `selectImageCount` stable per slot key, always 1–2 for `random_1_or_2`, same value for both platforms; preview embeds the **real validator** verdict; history entries carry independent FB/Threads statuses + error summaries. | **PASS** | Real (pure) |
| T-INTEGRATION-HEALTH | Health classification | 9 tests: configured+live ⇒ `connected`; configured+live-disabled ⇒ `blocked`; partially configured ⇒ `disconnected`; no credentials ⇒ `not_tested`; **no secret material in any label**. | **PASS** | Real (pure) |
| T-AUTOMATION-API | PART 2 contract endpoints | 22 tests: `GET /v1/automation/status` (401 without JWT, Running/Paused/Degraded mapping, slot counters), `GET/PUT /v1/settings` (validation issues surfaced verbatim), `POST /v1/automation/control` (start/pause/resume idempotency + `changed` flag), `GET /v1/content/preview` (`source: "fixture"` tag, stable image count), `GET /v1/history/publishes` (fixture tag, per-platform independence). | **PASS** | Real (mock integrations) |

## B. Live server smoke test (real process, real HTTP)

Procedure: start `npx tsx src/main.ts` on port 8099 with placeholder env,
exercise every PART 2 endpoint with `Invoke-RestMethod`, then **restart the
process** to prove persistence.

| ID | Objective | Result | Status | Mock/Real |
|---|---|---|---|---|
| SMOKE-01 | Boot with file settings store | log: `settingsStorage: "file"`, `automationState: "running"` | **PASS** | Real |
| SMOKE-02 | `GET /v1/settings` seeds defaults | interval=60 slots=24 policy=`random_1_or_2` state=running storage=file | **PASS** | Real |
| SMOKE-03 | `PUT /v1/settings` validates + persists | wrote 90/12/`one` → `backend/data/settings.json` written atomically | **PASS** | Real |
| SMOKE-04 | `POST /v1/automation/control` idempotent | start on running state ⇒ `changed: false` (no duplicate side effects) | **PASS** | Real |
| SMOKE-05 | Status degraded honesty | `state: running, degraded: true` with reason "No publishing destination is live-configured" — never claims healthy while integrations are blocked | **PASS** | Real |
| SMOKE-06 | Preview stability | same slot requested twice ⇒ identical `imageCount`; response tagged `source: fixture`; validation verdict from the real validator | **PASS** | Real |
| SMOKE-07 | History independence | fixture entries showed `published/published`, `published/failed`, `failed/not_attempted` pairs | **PASS** | Mock (pipeline not wired) |
| SMOKE-08 | Integrations classification | fb=disconnected threads=disconnected telegram=disconnected s3=disconnected ai_image=not_tested ai_text=not_tested postgresql=disconnected feed=not_tested — **no token/secret strings anywhere in responses** | **PASS** | Real |
| SMOKE-09 | Persistence across restart | killed process, restarted, re-read settings ⇒ **90/12/one survived** from `data/settings.json`; `pause` then `state: paused` persisted too | **PASS** | Real |
| SMOKE-10 | Cleanup | server stopped, `backend/data/settings.json` removed (gitignored anyway) | **PASS** | Real |

## C. Flutter app (dashboard, settings, preview, history, integrations)

**Commands:** `flutter analyze`, `flutter test`, `flutter build apk --debug` (app)
**Aggregate analyze:** **No issues found** (7.1 s).
**Aggregate test:** **97 tests · 97 passed · 0 failed** (8 PART 1 auth tests
preserved + 89 PART 2 tests).
**APK:** `app-debug.apk` built successfully — **168.1 MB (176,295,889 bytes)**.

| ID | Objective | Scope covered | Status | Mock/Real |
|---|---|---|---|---|
| FL-01 | Dashboard state rendering | Running/Paused/Degraded/Offline chips, slot counters, success/failure counts, latest-content "not implemented" honesty, activity list | **PASS** | Mock HTTP (`MockClient`) |
| FL-02 | Offline + recovery | backend down at startup ⇒ full error state with retry; refresh failure ⇒ Offline chip with cached data retained; next successful refresh ⇒ Running again | **PASS** | Mock HTTP |
| FL-03 | Settings defaults & validation | defaults rendered from backend, 15–720/1–24 bounds, interval×slots≤one-day cross-check, backend 400 issues surfaced verbatim | **PASS** | Mock HTTP |
| FL-04 | Start/pause/resume confirmation | control actions only fire after dialog confirmation; idempotent `changed` flag respected | **PASS** | Mock HTTP |
| FL-05 | `random_1_or_2` representation | typed enum ↔ API string mapping, invalid value fallback, per-slot display of the selected count | **PASS** | Real (pure + widget) |
| FL-06 | Stable image count per slot | same slot ⇒ same count across refresh; count not independently randomized per platform (FB and Threads show one shared value) | **PASS** | Real (pure + widget) |
| FL-07 | Auth failure & expired session | 401 ⇒ single refresh attempt then safe sign-out path; no infinite loop; auth errors never rendered as raw payloads | **PASS** | Mock HTTP |
| FL-08 | API client hardening | request timeouts, single controlled retry for GETs, typed `NetworkException`/`AuthException`/`ServerException.issues`, mock health never treated as live verification | **PASS** | Mock HTTP |
| FL-09 | Preview & history screens | product + affiliate URL + caption + hashtags render; per-platform independent status chips; fixture tag surfaced to the user (no fake success) | **PASS** | Mock HTTP |
| FL-10 | Integrations screen | Connected/Blocked/Not Tested/Disconnected chips, offline banner with cached entries retained, health legend | **PASS** | Mock HTTP |
| FL-11 | No credentials in logs/UI | tests assert the install key, JWT and any `secret`/`token`-looking strings never appear in rendered widgets or console output | **PASS** | Real (pure + widget) |
| FL-12 | Loading/empty/error states | every screen covered for loading skeleton, empty list, error-with-retry | **PASS** | Mock HTTP |
| FL-13 | Tab shell behaviour | dashboard-first navigation, state preserved when returning to a tab | **PASS** | Mock HTTP |

## D. Blocked / NOT_TESTED (unchanged from PART 1 plus PART 2 items)

| ID | Item | Reason |
|---|---|---|
| BLK-01 | DB migration-apply & DB-backed tests | No PostgreSQL server and no Docker in this environment. |
| BLK-02 | Live Shopee Affiliate feed compatibility | No official API documentation retrievable; no real feed sample provided. |
| BLK-03 | Live Facebook/Threads publish, Telegram send, AI, S3 | No credentials; hard-latched by `allowLive:false`. |
| BLK-04 | Deployed-HTTPS APK↔backend handshake | Requires a deployed TLS host; not available here. |
| BLK-05 | Real content pipeline behind preview/history | Deliberately deferred: responses are **fixture-tagged** (`source: "fixture"`). Image count is a deterministic per-slot **placeholder** (FNV-1a hash of the slot key), shared by both platforms — real selection/persistence belongs to a later backend part. No fake image generation occurs. |

---

## Security notes (PART 2)

- Install key is exchanged once for a short-lived HS256 JWT; the JWT lives in
  **Android Keystore** via `flutter_secure_storage` (pluggable `KeyValueStore`
  for tests — in-memory implementation only in tests).
- Provider secrets remain backend-`.env`-only; the APK holds none.
- `PUT /v1/settings` rejects `automationState` — run state changes only through
  the audited `/v1/automation/control` endpoint.
- All new API error paths reuse the PART 1 redacting logger; smoke responses
  (SMOKE-08) were checked for credential-looking strings.
- Integration health vocabulary (`connected`/`blocked`/`not_tested`/
  `disconnected`) never claims `connected` while live calls are latched off —
  configured ≠ verified.

## API contract gaps (documented, not invented)

1. **Content preview & publishing history** are served from deterministic
   fixtures tagged `source: "fixture"` because the publish pipeline does not
   exist yet. The validation verdict inside the preview is real (produced by
   `pipeline/content-validation.ts`), everything else is illustrative.
2. **`latestContent`** on the dashboard status is always `null` with an honest
   "not implemented" note — the app renders an empty state instead of a fake
   card.
3. **Image count** (`random_1_or_2`) resolves to a stable per-slot
   deterministic placeholder (1 or 2) shared by Facebook and Threads. Real
   image selection/persistence is deferred with the pipeline.
4. **Scheduler `nextRunAt`** reflects the configured interval but no slot will
   publish until a destination is live-configured; the status therefore reports
   `degraded` with explicit reasons.
