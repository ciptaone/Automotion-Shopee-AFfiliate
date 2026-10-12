# Shopee Affiliate Autopilot

Always-on backend + Flutter Android control app for automated, validated
Shopee-affiliate content publishing to **Facebook Page** and **Threads**, with
**Telegram** notifications.

> **Part 3 status: CATALOG + REAL CONTENT PIPELINE (NO PUBLICATION).** Parts
> 1–3 deliver the verified foundation (auth, scheduler, queue, integration
> contracts), the Flutter control surface, a **persistent product catalog**
> with idempotent feed import, the **Auto / Selected-Categories selection
> policy**, and the **real content pipeline** (product reservation → persisted
> image count → grounded image generation → validation → caption → publish
> gate → `publish_ready`). The pipeline **generates and validates** content but
> **never publishes**: the publisher is not invoked, and every third-party
> integration still runs behind a deterministic mock or a hard "live disabled"
> latch, so **no real post, message, or paid API call can occur** from this
> codebase as-is. Live Shopee feed ingestion and the PostgreSQL store remain
> explicitly **BLOCKED** (no official contract / no database in this
> environment).

---

## Repository layout

```
backend/   Node 24 + TypeScript always-on service (scheduler, jobs, integrations)
app/       Flutter Android client (dashboard, health, auth — control surface only)
docs/implementation/   Part 1 audit, feasibility and evidence documents
```

### Architectural boundary (locked)

| Concern | Where it lives |
|---|---|
| Scheduling, job queue, feed import, AI, storage, publishing, notifications | **Backend only** |
| Auth, dashboard, health, integration status, controls | **Flutter APK** |
| Shopee / Meta / AI / DB / storage secrets | **Backend `.env` only — never in the APK** |

The backend keeps working when the APK is closed, the phone is offline, or the
device restarts, because the scheduler and queue are server-side and durable.

---

## Prerequisites

- **Node.js ≥ 20.11** (developed on 24.x) + npm
- **Flutter 3.x** + Dart (developed on 3.44.4 / Dart 3.12.2) for the APK
- *(Optional)* PostgreSQL for durable persistence — not required for Part 1

---

## Backend quickstart

```bash
cd backend
npm install

# 1. Configure the environment (placeholders only in the example).
copy .env.example .env      # Windows
# cp .env.example .env      # macOS/Linux
# Then edit .env and set at minimum:
#   AUTH_JWT_SECRET  (>= 32 chars, random)
#   CORS_ORIGINS

# 2. Validate the environment (prints key names only, never secret values).
npm run env:check

# 3. Run the type checker, linter and tests.
npm run typecheck
npm run lint
npm test

# 4. Start the server.
npm run dev                 # http://localhost:8080
```

### Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | public | Readiness, DB, scheduler and per-integration status (no secrets). |
| GET | `/v1/meta/integrations` | public | Per-service configuration state + health classification. |
| POST | `/v1/auth/token` | install key | Exchange the install key for a session JWT. |
| GET | `/v1/me` | JWT | Echo verified token claims. |
| GET | `/v1/scheduler/status` | JWT | Current Asia/Jakarta slot schedule. |
| GET | `/v1/queue/jobs` | JWT | Recent job records. |
| GET | `/v1/automation/status` | JWT | Dashboard status (Running/Paused/Degraded/Offline), today's slot counters. |
| GET | `/v1/settings` | JWT | Current automation settings + effective scheduler config. |
| PUT | `/v1/settings` | JWT | Update interval/slots/platform toggles/image policy (validated). |
| POST | `/v1/automation/control` | JWT | Start / pause / resume automation (idempotent). |
| GET | `/v1/content/preview?slot=` | JWT | Slot preview: real pipeline record when one exists, otherwise the PART 2 fixture. |
| GET | `/v1/history/publishes` | JWT | Recent publish history (fixture-tagged until publishing is enabled). |
| POST | `/v1/catalog/import` | JWT + control | Import a CSV/XLSX Shopee feed (idempotent; failed imports never destroy the catalog). |
| GET | `/v1/catalog` | JWT | List catalog products (`category=`, `eligible=` filters). |
| GET | `/v1/catalog/categories` | JWT | Categories derived from the ACTUAL imported catalog. |
| GET | `/v1/catalog/status` | JWT | Catalog totals, storage kind and recent import batches. |
| POST | `/v1/pipeline/run` | JWT + control | Run the content pipeline for a slot (generation only — never publishes). |
| GET | `/v1/pipeline/slots` | JWT | Slot records: stage, image count, validation, exact blockers. |

`PUT /v1/settings` additionally accepts `selectionMode`
(`auto` | `selected_categories`) and `selectedCategoryIds`; unknown category
ids and empty selections are rejected.

### Environment variables

See [`backend/.env.example`](backend/.env.example) — every value is a
placeholder. **Part 1 boots with only `AUTH_JWT_SECRET` and `CORS_ORIGINS` set**;
all integrations default to free, deterministic mocks.

Key groups: runtime, APK auth, CORS, database (optional), scheduler,
Shopee feed, Facebook, Threads, Telegram, S3, AI providers.

---

## Flutter app quickstart

```bash
cd app
flutter pub get
flutter analyze
flutter test

# Point at your backend (defaults to the Android-emulator host alias).
flutter run --dart-define=BACKEND_URL=http://10.0.2.2:8080

# Build a debug APK.
flutter build apk --debug
```

On first launch, paste the **install key** you set in the backend `.env`
(`APP_INSTALL_KEY`). The app exchanges it for a short-lived session token stored
in the Android Keystore. **The app never contains provider secrets.**

> Use a real device IP or a deployed HTTPS host instead of `10.0.2.2` when not
> running in the Android emulator.

---

## Database / migrations (optional)

The schema is defined with Drizzle ORM. Migrations are committed for review.

```bash
cd backend
npm run db:generate      # regenerate SQL from src/db/schema.ts
# npm run db:migrate     # requires a live DATABASE_URL + drizzle-kit
```

Without `DATABASE_URL` the backend persists settings, catalog and slot content
to **file-backed stores** under `backend/data/` (`settings.json`,
`catalog.json`, `slots.json` — gitignored, atomic writes) and runs the job
queue/storage as mocks; `/health` reports Postgres as `not_configured`. The
PostgreSQL catalog/slot schema (`0001_part3_catalog.sql`) is written but
**not applied** in this environment (no database available).

---

## Testing

```bash
cd backend && npm test       # 412 unit + contract tests (all offline)
cd app && flutter test       # 137 model + widget tests (all offline)
```

All tests are **credential-free and offline**. They never send a Telegram
message, publish to Facebook/Threads, or call a paid AI/S3 API. Blocked items
(e.g. live Shopee feed, live S3, live publish, PostgreSQL) are documented in
[`docs/implementation/part-03-evidence.md`](docs/implementation/part-03-evidence.md).

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/implementation/part-01-repository-audit.md`](docs/implementation/part-01-repository-audit.md) | Initial state, toolchain, constraints, architecture decision. |
| [`docs/implementation/part-01-integration-feasibility.md`](docs/implementation/part-01-integration-feasibility.md) | Per-service official requirements, auth, quotas, blockers. |
| [`docs/implementation/part-01-evidence.md`](docs/implementation/part-01-evidence.md) | Test-by-test evidence ledger with PASS/FAIL/BLOCKED. |
| [`docs/implementation/part-02-evidence.md`](docs/implementation/part-02-evidence.md) | Flutter control-surface evidence (dashboard, settings, preview, history). |
| [`docs/implementation/part-03-audit.md`](docs/implementation/part-03-audit.md) | PART 3 starting-state audit: capabilities, gaps, non-breaking contracts. |
| [`docs/implementation/part-03-evidence.md`](docs/implementation/part-03-evidence.md) | Catalog, selection policy and content-pipeline evidence with live smoke test. |

---

## Security notes

- Secrets are read **once** at startup (`backend/src/core/env.ts`) and never
  logged — every log line is deep-redacted (`redact.ts`).
- APK↔backend auth uses HS256 JWTs with issuer/audience/expiry/scope binding,
  implemented dependency-free with `node:crypto`.
- Publisher adapters cannot make a live call while `allowLive:false` (the Part 1
  default), even if credentials are present.
- Production rejects wildcard CORS and requires HTTPS for third-party calls.
