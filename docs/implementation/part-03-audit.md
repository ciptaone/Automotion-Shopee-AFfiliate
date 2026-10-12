# PART 3 — STEP A: Repository Audit (Product Catalog, Categories & AI Content Pipeline)

**Executed:** 2026-10-12 (Asia/Jakarta). **Baseline:** commit `d8390e8`
(Part 2, clean tree, 293 backend + 97 Flutter tests passing).

Purpose: record what PART 1/2 already provide, what PART 3 must add, and which
files change — BEFORE any edit. All PART 1/2 contracts and tests must survive.

---

## 1. Existing capabilities (verified by reading the code)

### 1.1 Feed ingestion (`backend/src/integrations/feed/shopee-feed-importer.ts`)
- Parses user-provided CSV (Papa) and XLSX (SheetJS); format detection by
  extension + ZIP magic bytes.
- Schema-tolerant: headers normalized, resolved against alias lists
  (`FIELD_ALIASES`) for id/name/marketplace/productUrl/affiliateUrl/price/
  currency/commissionRate/imageUrl/category/rating/soldCount.
- Per-row rejection with reasons (capped at 100), empty-row skip, id derivation
  (FNV-1a) when the feed omits an id, dedupe by id (first wins).
- `FeedProduct.raw` retains the full source row for traceability.
- **GAP:** parse results are discarded — no persistence, no catalog, no import
  batches written anywhere, no HTTP import endpoint. Affiliate URL falls back
  to `productUrl` when absent (acceptable, but catalog must record whether a
  REAL affiliate link exists, because eligibility for publishing requires one).

### 1.2 Database (`backend/src/db/schema.ts`, `drizzle/0000_init.sql`)
- Tables: `api_clients`, `products` (feed_id+marketplace unique), `jobs`
  (unique_key), `publish_runs` (slot+provider unique), `notifications`
  (dedupe), `import_batches`.
- **GAP:** no categories table (derivable from products), no slot-content /
  asset / caption tables, `products` lacks description/eligibility/raw-extra,
  `import_batches` lacks per-row issue detail. No migration beyond `0000_init`.
- `DatabaseHandle` (`db/client.ts`): lazy connect; null-handle when
  `DATABASE_URL` absent. **No PostgreSQL/Docker in this environment → any
  DB-backed path is BLOCKED for live verification; file/memory stores are the
  verified persistence.**

### 1.3 Settings (`backend/src/settings/automation-settings.ts`)
- Validated `AutomationSettings` (interval 15–720, slots 1–24,
  interval×slots≤1440), pluggable `SettingsStore` (atomic file / memory),
  `SettingsService.update()/control()`, `PUT` rejects `automationState`.
- **GAP:** no `selectionMode`, no `selectedCategoryIds`.

### 1.4 Fixtures (`backend/src/automation/fixtures.ts`)
- `selectImageCount` (FNV-1a placeholder), `buildContentPreview`,
  `buildPublishHistory` — all `source: "fixture"`, honest notes, real validator
  verdicts on fixture text. **Must stay untouched** (PART 2 tests + fallback).

### 1.5 Validation & publish gate (`backend/src/pipeline/content-validation.ts`)
- `validateCaption` (length per platform, CTA, verbatim affiliate URL,
  hashtag/emoji moderation, fabrication guards: testimonial/discount/commission
  markers), `validateImage` (non-empty, ≤8 MB, JPEG/PNG, min dimensions,
  vertical preference, aspect limit), `blocksPublish`.
- Ready to be reused as-is by the real pipeline. **No change needed.**

### 1.6 Queue & scheduler (`queue/job-queue.ts`, `scheduler/slots.ts`)
- In-memory durable queue: uniqueKey idempotency, atomic claim, retry backoff.
- Slot math: Asia/Jakarta, `YYYY-MM-DD#NN` keys, 60-min/24-slot defaults.
- **GAP:** no worker loop invokes any pipeline; the scheduler only computes
  status. Auto-execution of slots is deferred (PART 4 scope) — PART 3 makes the
  pipeline invocable and its records queryable, without publishing.

### 1.7 Provider-neutral integrations
- `ImageGenerator` already accepts `referenceImageUrls` + seed + prompt
  (`contracts/index.ts`): exactly what product-faithful generation needs.
- `MockImageGenerator` emits real deterministic PNGs; `MockCaptionGenerator`
  emits truthful Indonesian captions from product fields only.
- `MemoryObjectStorage` supports failure injection
  (`failKeySubstring`) and public-access denial
  (`denyPublicAccessKeySubstring`) — enough to test storage blockers.
- Publishers remain hard-latched `allowLive:false`. **No publishing in PART 3.**

### 1.8 HTTP surface (`backend/src/app/server.ts`)
- 12 endpoints incl. PART 2 control surface. Body limit 25 MB (feed uploads OK).
- **GAP:** no catalog/import/categories/pipeline endpoints. `/v1/content/preview`
  is fixture-only.

### 1.9 Flutter APK
- Screens: Dashboard, Settings, Preview, History, Integrations; typed
  `AutopilotApi`; nullable-safe models; injected `api` for tests.
- **GAP:** no product-selection UI, no category list, preview shows fixture
  placeholders only and cannot render pipeline records.

---

## 2. PART 3 gaps → planned changes

| # | Gap | Plan | Files |
|---|---|---|---|
| G1 | No persistent catalog | `ProductCatalog` service + `CatalogStore` (memory / atomic file / Drizzle) with idempotent import, eligibility, categories, batch reporting, never-delete-on-failure | new `src/catalog/catalog.ts`, `src/catalog/eligibility.ts`; `src/db/schema.ts` + new migration `0001_part3_catalog.sql` |
| G2 | No selection policy | `selection.ts`: typed `auto` / `selected_categories`, weighted scoring + injectable seeded RNG, category diversity + recent-avoidance, skip-with-reason (never silent auto-fallback) | new `src/automation/selection.ts` |
| G3 | Settings lack selection fields | add `selectionMode` + `selectedCategoryIds` (defaults keep old behavior), validate (empty list in selected-mode, unknown category IDs at the API layer) | `src/settings/automation-settings.ts`, `src/app/server.ts` |
| G4 | No real pipeline | `ContentPipeline.runSlot()`: reserve product → validate → resolve reference image → persist image count → generate N images → validate → caption → validate → store assets → publish-gate → `publish_ready` (NO publish). Honest `provider: mock|live` labeling, exact blockers | new `src/automation/pipeline.ts`, `src/automation/image-prompt.ts`, `src/automation/slot-store.ts` |
| G5 | Fixture image count | replace with real persisted per-slot count (RNG at reservation, reused on retry); fixtures keep their placeholder | `src/automation/pipeline.ts` |
| G6 | No API for catalog/pipeline | new endpoints: `POST /v1/catalog/import`, `GET /v1/catalog`, `GET /v1/catalog/categories`, `GET /v1/catalog/status`, `POST /v1/pipeline/run`, `GET /v1/pipeline/slots`; upgrade `GET /v1/content/preview` to serve real records when present, fixture fallback otherwise | `src/app/server.ts`, `src/app/container.ts` |
| G7 | Flutter selection UI | Auto/Selected-categories selector + backend-sourced category multi-select + empty-catalog states | `app/lib/screens/settings_screen.dart`, new `app/lib/models/catalog_models.dart` |
| G8 | Flutter preview is fixture-only | render real pipeline records (stage, blockers, image metadata, provider honesty) while keeping fixture rendering | `app/lib/screens/preview_screen.dart`, `app/lib/models/automation_models.dart`, `app/lib/core/autopilot_api.dart` |

## 3. Contracts that must not break
- `/v1/content/preview` and `/v1/history/publishes` keep their PART 2 JSON
  shape (extra additive fields only) — PART 2 Flutter tests parse them.
- `AutomationSettings` gains only new keys; `PUT /v1/settings` patch remains
  `.strict()` — the patch schema gains the two new optional keys.
- `fixtures.ts` stays as-is (fixture fallback + tests).
- Auth: all new endpoints require JWT; mutations require `control` scope.

## 4. Environment constraints (re-confirmed)
- No PostgreSQL, no Docker, no live credentials → DB-backed catalog/slot stores
  are implemented against the Drizzle schema but **marked BLOCKED** for live
  verification; memory/file stores are the verified path.
- AI image/text run through deterministic mocks by default; live AI remains
  config-gated and NOT_TESTED. No paid call is made by any test.
- Live publishing stays disabled end-to-end (publish-gate result is stored, the
  publisher is never invoked in PART 3).
