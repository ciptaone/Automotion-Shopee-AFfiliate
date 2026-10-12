# PART 4 — Pre-Implementation Audit

Date: 2026-10-12 · Baseline: PART 3 commit `1f6d9a1` · Verifier: manual code audit of
backend (`backend/src`), Flutter (`app/lib`), and every existing test suite
(412 backend + 137 Flutter, all green at baseline).

The rule for this part: **extend, do not rewrite**. Everything listed under
"Already exists" is working, tested, and contract-locked; PART 4 closes the gaps
listed at the end without touching those contracts.

---

## 1. AI image and caption interfaces — ALREADY EXISTS

- `src/contracts/index.ts` defines the provider-neutral surfaces:
  `ImageGenerator.generate(ImageGenerationRequest) -> GeneratedImage` and
  `CaptionGenerator.generate(CaptionGenerationRequest) -> GeneratedCaption`.
  Typed inputs/outputs, deterministic `seed`, `timeoutMs` hint, reference image
  URLs, `estimatedCostUsd`, and `ProviderInfo {name, kind: mock|live, model,
  ready, detail}` for the honest mock-vs-live distinction.
- Error taxonomy already exists in `src/core/errors.ts`: `AiProviderError`
  (retryable flag), `RateLimitError` (with `retryAfterMs`), `UpstreamServiceError`.
- Deterministic mocks exist: `src/integrations/ai/mock-ai.ts` (`MockImageGenerator`
  emits a real encoded PNG; `MockCaptionGenerator` emits neutral Indonesian copy
  from verified product fields only). Byte-identical for identical requests.
- `src/core/redact.ts` (`redactString`, `redactDeep`) and a redacting logger
  exist for redacted error logging.

**GAP (§3 of the brief):** there is no resilience layer around the contracts —
no timeout enforcement, no bounded retries, no explicit rate-limit handling, no
usage/cost aggregation. Also, the container always builds a **mock** even when
`AI_IMAGE_PROVIDER=openai|google`, while `/v1/meta/integrations` reports the env
mode — a live-provider claim the code cannot back. No live adapter is
implemented (correct: no credentials, no authorized paid calls).

## 2. Content pipeline and publish gate — ALREADY EXISTS

`src/automation/pipeline.ts` (`ContentPipeline.runSlot`) already executes the
11-stage pipeline: reserve (atomic, per-slot lock) → product/affiliate-URL
validation → reference-image resolution (BLOCK when absent) → image count
persisted BEFORE generation → N images (position-specific POV/lifestyle views,
distinct seeds) → structural quality check + duplicate detection → storage
upload + public-access verification → one canonical caption adapted per
platform → per-platform validation through the publish gate → `publish_ready`
or `blocked`/`failed`. Retry contract: terminal slots return unchanged, partial
slots reuse valid assets, regeneration is explicit only.

`src/pipeline/content-validation.ts` (publish gate) covers structural rules
(length, CTA, hashtags, emoji, Threads limits) plus heuristic fabrication
guards (testimonial/discount/commission markers).

**GAP (§5):** no mandatory `#ai #automation` ending; no structured
first-person claim policy (ownership / receipt / usage / firsthand result /
endorsement / interest — only a small testimonial regex exists); no affiliate
disclosure requirement; no unsupported-benefit rule; no bounded caption
regeneration driven by validation errors.

## 3. Product reservations and persisted image counts — ALREADY EXISTS

`src/automation/slot-store.ts`: `SlotContentRecord` persists the reservation,
selection snapshot (mode + category ids + score), `imageCount` +
`imageCountChosenAt`, assets (storage key, public URL, SHA-256, provider kind,
model, prompt version, seed, reference URL, validation), captions per platform,
stage, blockers, `lastError`, attempts. `SlotContentStore.mutate()` provides the
per-slot promise-chain lock (concurrency-safe reservation). Verified by PART 3
tests (stable count on retry, asset identity reuse, concurrent single-reserve).

**GAP (§4):** the reference image is checked for *existence* only. There is no
explicit check that the reference URL still *belongs to the reserved catalog
product* (wrong-product / stale-reference guard), and no explicit invalid-URL
scheme guard.

## 4. Image-generation mocks — ALREADY EXISTS

`MockImageGenerator` (real PNG via in-process zlib encoder, seeded palette) and
`MockCaptionGenerator` (template-based neutral copy). Both labelled
`kind: 'mock'` on every asset. Determinism covered by `tests/unit/mock-ai.test.ts`.

**GAP:** mocks ignore `timeoutMs` and cannot simulate transient/rate-limit
failures out of the box (tests currently hand-roll throwing stubs — fine, but a
labelled failure-injection option makes the resilience tests honest and
self-documenting).

## 5. Asset storage contracts — ALREADY EXISTS

`ObjectStorage` (S3-compatible surface: `upload`, `head`, `verifyPublicAccess`,
`delete`, `publicUrlFor`) + `MemoryObjectStorage` mock with failure injection
(`failKeySubstring`, `denyPublicAccessKeySubstring`). The pipeline uploads,
verifies public accessibility, and blocks on inaccessible URLs. Live S3 adapter
intentionally absent (BLOCKED, no credentials); `createObjectStorage` never
fabricates readiness.

## 6. Category-selection settings — ALREADY EXISTS

`SettingsService` + Zod validation: `selectionMode` (`auto` |
`selected_categories`), `selectedCategoryIds`, unknown category IDs rejected by
`PUT /v1/settings`, empty selection rejected. `src/automation/selection.ts`
implements the weighted/seeded policy with recent-avoidance and skip reasons.

## 7. Scheduler and queue — FOUNDATION ONLY

- `src/scheduler/slots.ts`: pure slot math (60-min interval, ≤24 slots per
  Asia/Jakarta day), deterministic slot keys `YYYY-MM-DD#NN`, `nextSlot`,
  `describeSchedulerStatus`. Fully unit-tested.
- `src/queue/job-queue.ts`: `InMemoryJobQueue` with uniqueness by `uniqueKey`,
  atomic `claim()`, exponential-backoff `fail()`. Surfaced by `GET /v1/queue/jobs`.

**GAP (§7 — the core of PART 4): NOTHING consumes the queue.** No code calls
`enqueue`/`claim` outside tests. The pipeline only runs on demand via
`POST /v1/pipeline/run`. There is no due-slot planner, no catch-up policy (risk
of an unlimited posting burst after downtime), no recovery of interrupted jobs,
and no timer loop in `main.ts`. PART 4 wires scheduler → queue → pipeline.

## 8. Image quality validation — PARTIAL

`src/automation/image-quality.ts` evaluates structural rules (format, size,
dimensions, aspect), duplicate detection, and reference presence;
`automatedFidelityScore` is permanently `null` with a documented limitation
string. Honesty contract already correct.

**GAP (§6):** the result is an aggregate, not a typed per-dimension assessment.
The brief asks for a typed contract distinguishing structural checks from
visual fidelity (product identity/packaging, color/details, anatomy, lighting,
artifacts), each with an explicit status and a `null`-with-reason where no
reliable assessment is possible. Extend additively; never fabricate scores.

## 9. Flutter content preview — PART 3 STATE

`ContentPreview` model parses the PART 3 pipeline payload (stage, images with
checksums/prompt version/reference, providers mock-vs-live, blockers,
publishReady, attempts, run id). `preview_screen.dart` renders a pipeline
banner, pipeline card, image tiles, validation card, publish-gate row; fixture
fallback preserved. Settings screen has the Auto/Selected-Categories selector
with backend-derived categories.

**GAP (§9):** no display of (a) editorial validation results as such, (b)
image-quality status + the honest limitations note, (c) product-reference
availability as an explicit row, (d) mandatory-final-hashtag verification.

## 10. Test inventory (baseline, all green)

- Backend: 412 tests — `catalog` 23, `selection` 20, `pipeline` 39,
  `catalog-pipeline-api` 37, plus the PART 1/2 suites (settings, queue,
  scheduler slot math, content validation, mock AI, feed parser, adapters,
  auth, env, redaction, fixtures, automation API).
- Flutter: 137 tests — models, selection settings, pipeline preview, plus the
  PART 1/2 suites.
- Constraints these tests lock in (must keep passing):
  - `validateCaption` on the PART 1 sample caption must stay publishable, so the
    mandatory-ending rule belongs to the new editorial layer (the publish gate
    runs **both** layers; pipeline captions must satisfy both).
  - Mock caption must not contain `komisi`, `diskon|promo|flash sale|% off`,
    first-person testimonial markers, or `harga` when the product has no price;
    must embed the affiliate URL, keep the hook/body/cta/hashtag structure and
    stay deterministic.
  - `evaluateImageQuality` fixtures use real PNG-signature bytes; fidelity score
    stays null; limitations string matched case-insensitively.
  - `/health` reports `part: 1` (locked API-version marker — unchanged).
  - `/v1/scheduler/status` field access is by key (additive fields allowed).

## 11. Planned PART 4 changes (files)

Backend:
1. `src/contracts/index.ts` — additive: `MANDATORY_FINAL_HASHTAGS`, optional
   `signal` + `validationFeedback` + `editorialBrief` on generation requests.
2. `src/integrations/ai/provider-runner.ts` (new) — timeout + bounded retry +
   rate-limit classification + usage/cost accounting + redacted logging,
   wrapping any `ImageGenerator`/`CaptionGenerator`.
3. `src/integrations/ai/unavailable-provider.ts` (new) — honest adapter for
   configured-but-unimplemented live providers (`ready:false`, throws typed
   `AI_PROVIDER_UNAVAILABLE`, never claims a call happened).
4. `src/pipeline/editorial-policy.ts` (new) — structured Indonesian editorial
   validation: normalized first-person claim detection (6 categories),
   mandatory `#ai #automation` ending (no trailing text), affiliate URL
   preservation, disclosure requirement, unsupported benefit/price/discount/
   commission claims.
5. `src/automation/image-quality.ts` — additive typed per-dimension check list
   (structural vs not-assessed-with-reason); no fabricated scores.
6. `src/automation/pipeline.ts` — reference-binding guard (wrong-product
   block), editorial validation in the caption stage, bounded regeneration
   driven by validation errors, combined publish-gate evidence.
7. `src/scheduler/content-scheduler.ts` (new) — due-slot planner (interval +
   daily cap + bounded catch-up), queue enqueue/claim loop, pipeline execution,
   interrupted-job recovery, precise failure recording; continues after
   recoverable failures.
8. `src/app/container.ts` — build the resilient AI wrappers via an honest
   factory; construct the content scheduler.
9. `src/main.ts` — start/stop the scheduler timer (backend runs without the APK).
10. `src/app/server.ts` — additive scheduler-integration info on
    `/v1/scheduler/status`.

Tests (new): `tests/unit/editorial-policy.test.ts`,
`tests/unit/provider-runner.test.ts`, `tests/unit/content-scheduler.test.ts`,
plus pipeline-part4 additions (regeneration, wrong-reference, storage/provider
failure paths) and contract additions. All PART 1–3 suites must stay green.

Flutter: extend `ContentPreview` parsing + preview screen (editorial results,
image-quality status/limitations, reference availability, mandatory-hashtag
row); new PART 4 widget/model tests.

## 12. Environment blockers (unchanged)

No PostgreSQL/Docker · no live Shopee feed contract · no AI/S3/FB/Threads/
Telegram credentials (`allowLive:false` stays). Everything live remains
BLOCKED/NOT_TESTED; nothing in PART 4 publishes or spends money.
