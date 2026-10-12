# PART 3 — Evidence

> Status: **PASS** for everything listed as verified below. Items that depend on
> unavailable infrastructure (PostgreSQL, live Shopee feed, live AI providers,
> S3, Facebook/Threads/Telegram credentials) remain explicitly **BLOCKED** or
> **NOT_TESTED** and are called out in each section. No live publishing exists
> anywhere in this part.

Date: 2026-10-12 · Commit: (see git log, PART 3 commit) · Verifier: automated
tests + live local smoke test against a running backend.

---

## 1. Verification summary

| Surface | Command | Result |
| --- | --- | --- |
| Backend typecheck | `cd backend && npm run typecheck` | PASS (0 errors) |
| Backend lint | `cd backend && npm run lint` | PASS (0 problems) |
| Backend tests | `cd backend && npm test` | **412 passed** (293 from PART 1+2 + 119 new) |
| Flutter analyze | `cd app && flutter analyze` | PASS (0 issues) |
| Flutter tests | `cd app && flutter test` | **137 passed** (97 from PART 1+2 + 40 new) |
| Flutter APK | `cd app && flutter build apk --debug` | PASS — 168.2 MB |
| Live smoke test | script against real server on `127.0.0.1:8791` | PASS (see §7) |

All PART 1 + PART 2 tests keep passing unmodified; the only PART 1/2 source
change in this part is additive (unknown feed columns are now preserved in
`raw`, which no earlier test asserted on).

---

## 2. New backend test coverage (119 tests)

### `tests/unit/catalog.test.ts` (23 tests)
- CSV import through the **real parser** → eligibility computed, batch recorded.
- XLSX import through the real parser.
- Malformed rows rejected with row number + field + reason; valid rows kept.
- Feed with no recognizable columns → throws before any mutation.
- **Affiliate URL preserved verbatim** (never swapped for the product URL).
- Row without an affiliate link → `hasAffiliateLink=false`, ineligible with
  `missing_affiliate_link`, no fabricated link.
- **Unknown source columns preserved** (`extraColumns`), canonical fields not
  duplicated.
- **Idempotency**: re-import updates in place, zero duplicates; a different id
  with the same URL is deduped (`urlDuplicatesSkipped`).
- **A failed import never destroys the previous catalog.**
- Stable identity across imports (`internalId` stable, new `sourceImportId`).
- Categories derived from the **actual** catalog with eligible vs total counts.
- File store persists and reloads across instances; corrupt file → warning,
  not a crash.

### `tests/unit/selection.test.ts` (20 tests)
- Auto mode selects eligible products; deterministic for same slot+seed.
- **Category diversity** across 40 seeded slots (all 3 categories used).
- Empty catalog → `empty_catalog` skip; all-ineligible → `no_eligible_products`.
- **No reference image → skipped** (fidelity anchor), unless policy relaxes it.
- Recent-product and category-repetition penalties reduce the score.
- Signals only scored when the data exists (no invented commission/price).
- **Selected-categories mode never selects outside the chosen categories.**
- **Empty/ineligible selected category → skip, never an auto fallback**
  (`no_eligible_products_in_selected_categories`, message states "no fallback").
- Unknown category ids reported (`unknown_categories` + `unknownCategoryIds`).
- `seededRandom`/`slotSeed` determinism and range.

### `tests/unit/pipeline.test.ts` (39 tests)
- `chooseImageCount`: `one`→1, `two`→2, `random_1_or_2`→ only 1 or 2, both
  outcomes occur across a day, stable per slot key.
- **Image count persisted BEFORE generation** and reused on retry
  (`imageCountChosenAt` unchanged; retry does nothing when terminal).
- Full run → `publish_ready`, product reserved, assets+captions created,
  actions logged.
- **Two-image slot: distinct images (different seed+checksum), same product,
  same reference image, position-specific views.**
- Assets uploaded with public URLs, 64-char checksums, real PNG mime, 1080×1920.
- **Honest labeling**: every asset/caption reports `providerKind: 'mock'`.
- **Caption embeds the exact affiliate URL** and passes the real publish gate.
- Fabrication guards: mock caption passes; forbidden phrases never appear.
- Retry stability: same source product and count after a provider failure;
  **retry on the SAME store keeps the reservation and reuses the first asset
  verbatim** (assetId unchanged); `attempts` increments.
- Terminal `publish_ready` slot is not regenerated on repeat runs.
- **Explicit regeneration** replaces assets (new run id, new asset ids) but
  keeps reservation + image count.
- **Missing reference image → blocked** (`missing_reference_image`), zero assets.
- Selected-categories with nothing eligible → blocked + **notified** via the
  existing notifier workflow (dedupe key `slot-skipped-…`).
- All destinations disabled → `no_destination_enabled`.
- Provider throws → `failed` (retryable), partial assets kept; position-1
  failure leaves zero assets.
- Storage upload failure → `failed` with `storage upload failed`.
- **Inaccessible media URL → blocked** (`media_url_inaccessible`), never
  treated as publish-ready.
- **Concurrency: two concurrent runs of the same slot reserve exactly once**;
  different slots reserve independently.
- `evaluateImageQuality`: structural pass, **fidelity score always null** with
  documented limitations, duplicate detection, reference-present rule.
- `buildImagePrompt`: grounds in real name/category, instructs "preserve
  packaging / do not invent", distinct compositions per view, omits category
  when absent, version stamped.
- `adaptCaptionForPlatform`: Facebook untouched; Threads trims hashtags only
  (facts + URL survive verbatim) when over 500 chars.
- File slot store reload preserves counts, assets and captions.

### `tests/contract/catalog-pipeline-api.test.ts` (37 tests)
- `POST /v1/catalog/import`: auth + scope required; valid import reports batch
  and totals; malformed body → 400; unknown keys → 400 (strict schema);
  **garbage file → 422 with machine-readable code and the existing catalog
  preserved**; idempotent re-import; no credential-looking strings.
- `GET /v1/catalog`: auth; listing with totals; category + eligibility filters;
  empty list for empty catalog.
- `GET /v1/catalog/categories`: derived from actual catalog with counts; empty
  list (never hardcoded); auth.
- `GET /v1/catalog/status`: totals + recent imports.
- Settings: new defaults and `selectionModes` constraint exposed; valid
  selection persisted and survives reload; **unknown category id → 400**;
  `selected_categories` with empty list → 400; invalid mode → 400; switching
  back to auto clears the list; `automationState` still rejected in patches.
- `POST /v1/pipeline/run`: auth + scope; **empty catalog → blocked with exact
  reason**; full run after import → `publish_ready`, `source: pipeline`,
  mock providers labeled, platforms `not_attempted`; idempotent; explicit
  regeneration; unknown keys rejected.
- `GET /v1/pipeline/slots`: stage/imageCount/publishReady listed; auth.
- `GET /v1/content/preview`: **PART 2 fixture served when no pipeline record**
  (shape preserved); **real pipeline record wins once it exists**
  (`imageCountSource: pipeline_persisted`, checksums on every image);
  fixture fallback still available for other slots.
- Honesty guarantees: no endpoint reports a live publication (both platform
  URLs null); no credential/storage secrets in catalog or pipeline responses;
  health reports empty catalog as degraded, not unready.

---

## 3. New Flutter test coverage (40 tests)

### `test/part3_models_test.dart` (23 tests)
SelectionMode parsing/labels/fallback; AutomationSettings selection defaults,
JSON round-trip, missing-field tolerance, copyWith, empty-selection issue;
CatalogCategoriesPayload (counts, empty-catalog-is-empty, missing payload);
CatalogStatusPayload; PipelineStage (parse, fallback, terminal);
ContentPreview pipeline payload (stage/images/providers/publish-ready, exact
blockers, live-not-mock, **fixture payload still parses**), empty payload;
PipelineRunResult/PipelineSlotSummary.

### `test/selection_settings_test.dart` (10 tests)
Auto default with policy explanation and **no sales-prediction claims**;
switching to Selected reveals backend-derived categories with real counts;
picked categories sent through `PUT /v1/settings`; **auto mode always sends an
empty list**; **empty selection never sent** (Save refused locally, zero PUTs);
pre-selected backend selection rendered as checked; **empty-catalog guidance
instead of invented categories**; category-load failure → retry works; stale
ids pruned and not re-sent; no credential-looking strings.

### `test/pipeline_preview_test.dart` (7 tests — plus fixture compatibility)
Publish-ready slot: real banner, stage, run id, **mock-provider honesty
notice**, real images (views, prompt version, reference grounding) replacing
placeholders, publish-gate row, explicit content source; blocked slot: exact
blockers surfaced, "NOT PASSED — nothing may be published", no placeholders;
failed slot labeled retryable; **live-provider run not labeled as mock**;
**never claims anything was published** (`Not attempted` ×2, `Published`
nowhere); unreachable image URL degrades honestly with metadata preserved;
**fixture fallback behavior from PART 2 unchanged**.

---

## 4. Contract additions (backward compatible)

- `PUT /v1/settings` accepts `selectionMode` (`auto` | `selected_categories`)
  and `selectedCategoryIds`; unknown category ids rejected (400);
  `selected_categories` with an empty list rejected (400).
- New endpoints (all JWT-protected, import/run additionally require `control`):
  - `POST /v1/catalog/import` — `{filename, contentBase64, format?}`
  - `GET /v1/catalog` — listing with filters `category`, `eligible`
  - `GET /v1/catalog/categories` — derived from actual catalog
  - `GET /v1/catalog/status` — totals + recent import batches
  - `POST /v1/pipeline/run` — `{slot?, regenerate?}` → stage + preview
  - `GET /v1/pipeline/slots` — slot records
- `GET /v1/content/preview` upgraded: real pipeline record first, PART 2
  fixture fallback otherwise; **existing PART 2 JSON shape unchanged**
  (additive fields only).
- CORS methods now include `PUT` (previously only GET/POST; corrected).

## 5. Persistence

- File-backed stores (atomic tmp+rename) at `backend/data/{catalog,slots,settings}.json`
  — verified default; gitignored. Reload-across-instances covered by tests.
- In-memory stores under `NODE_ENV=test`.
- PostgreSQL/Drizzle schema + migration `0001_part3_catalog.sql` written but
  **BLOCKED** — no PostgreSQL/Docker in this environment, migration not applied,
  DB-backed store not verified. File/memory stores never presented as proof of
  DB persistence.

## 6. Live smoke test (real server, real HTTP)

Server started with `npm start` on `127.0.0.1:8791` (file storage). Verified:

```
health: status=ok, degradedReasons include "The product catalog is empty…"
import (3 rows, 1 without affiliate link): new=3 rejected=0 total=3 eligible=2 categories=2
re-import same feed:            new=0 updated=3 total=3        (idempotent)
categories:                     Health & Beauty 2/1 eligible; Home & Living 1/1 eligible
settings → selected_categories: selectionMode=selected_categories ids=home-living
pipeline run (#90):             stage=publish_ready, product="Tumbler Stainless" (home-living only),
                                2 images, publishReady=true, source=pipeline,
                                imageProvider=mock_image/mock, captionProvider=mock_caption/mock,
                                facebook=not_attempted, threads=not_attempted
caption:                        source=generated, affiliate URL embedded, validation=passed
images:                         2 distinct URLs with distinct sha256 prefixes
preview (#90):                  source=pipeline, imageCountSource=pipeline_persisted
preview (#99, unknown slot):    source=fixture                     (PART 2 fallback intact)
settings → auto, run (#91):     stage=publish_ready, product="Serum Vitamin C"
garbage import:                 HTTP 422 FEED_NO_RECOGNIZED_COLUMNS,
                                catalog preserved (total=3 eligible=2)
unknown category id in settings:HTTP 400
```

The ineligible product (row 9003, no affiliate link) was **never** selected in
either run. No live AI, Telegram, Facebook, Threads or S3 call was made; smoke
data was deleted afterwards.

## 7. Remains BLOCKED / NOT_TESTED (unchanged)

- **PostgreSQL migration apply + DB-backed stores** — no database available.
- **Live Shopee feed compatibility** — no official API contract or real feed
  sample; import tested against the documented CSV/XLSX shapes only.
- **Live AI image/caption providers** — mocks only in this environment; the
  provider contract, prompt grounding and validation are implemented but a live
  call is `NOT_TESTED`.
- **S3-compatible storage upload** — memory mock verified; real upload and
  public URL verification `NOT_TESTED`.
- **Facebook/Threads publication, Telegram delivery** — implemented surface
  stays disabled (`allowLive:false`); the pipeline does not invoke the
  publisher at all in this part.
- **Scheduler → pipeline automatic execution** — deferred to PART 4; the
  pipeline runs on demand via `POST /v1/pipeline/run`.

## 8. Safety review

- No live publishing path was executed or enabled; publisher never invoked.
- No live Telegram send; no paid AI call in any test.
- No secrets committed; `.env` gitignored; smoke used throwaway secrets.
- Media URLs are storage URLs, never local filesystem paths.
- Publish gate enforced; blocked/failed slots cannot reach `publish_ready`.
