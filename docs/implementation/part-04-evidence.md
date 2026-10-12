# PART 4 — Evidence

> Status: **PASS** for everything listed as verified below. Items that depend on
> unavailable infrastructure (PostgreSQL, live Shopee feed, live AI providers,
> S3/object storage, Facebook/Threads/Telegram credentials) remain explicitly
> **BLOCKED** or **NOT_TESTED** and are called out in §7. No live publishing
> exists anywhere in this part: `allowLive:false`, no publisher is ever invoked,
> and no caption/image is ever labelled as live when it came from a mock.

Date: 2026-10-12 · Baseline commit: `1f6d9a1` (PART 3) · All PART 4 changes are
**uncommitted** at the time of writing (deliberate: the user reviews before any
commit) · Verifier: automated tests + a live local smoke test against a real
server.

---

## 1. Verification summary

| Surface | Command | Result |
| --- | --- | --- |
| Backend typecheck | `cd backend && npm run typecheck` | PASS (0 errors) |
| Backend lint | `cd backend && npm run lint` | PASS (0 problems) |
| Backend tests | `cd backend && npm test` | **533 passed** (412 from PART 1–3 + 121 new) |
| Backend build | `cd backend && npm run build` | PASS (`BUILD OK`) |
| Flutter analyze | `cd app && flutter analyze` | PASS (`No issues found!`) |
| Flutter tests | `cd app && flutter test` | **147 passed** (137 from PART 1–3 + 10 new) |
| Flutter APK | `cd app && flutter build apk --debug` | PASS — 168.2 MB |
| Live smoke test | `docs/implementation/part-04-smoke.ps1` vs `127.0.0.1:8794` | **51 / 51 PASS** |
| Bug found by the smoke test | file-store write race | **FOUND + FIXED + regression-tested** (§5) |

Every PART 1–3 test still passes unmodified. The only behavioural changes to
pre-existing code are additive or bug-fixes:

- `pipeline.reserve()` now persists the reservation (it previously only kept it
  in memory — a real PART 3 bug, covered by the contract tests),
- `selectProduct()` tie-breaks score ties on `marketplace:sourceProductId`
  instead of the per-instance `internalId` (a `randomUUID()`, which made two
  catalog loads disagree on the same slot — found while writing PART 4),
- the three file stores now write atomically **and safely under concurrency**
  (§5),
- `validateCaption` itself is untouched, so the PART 1 editorial test stays green
  and the new policy is a strictly additional gate.

---

## 2. New backend test coverage (121 tests)

### `tests/unit/editorial-policy.test.ts` (45 tests — new)
- Mandatory ending locked to exactly `#ai #automation`; limitations published
  verbatim (**never claims human-level review**).
- Rejects ownership / usage / receipt / interest-endorsement / firsthand-result
  claims, plus the **indirect variants**: first-person possessives, fused
  `ku`-clitics, subject-less receipt phrases, phrasal opinion markers.
- Applies the same rules to Threads captions.
- Accepts a neutral product-focused Indonesian caption, imperative CTAs and
  third-person product statements (no false positives); zero issues for the
  exact structure the mock generator emits.
- Fabrication guards: strong/medical benefits, unverifiable promotions and
  discounts, commission figures, a price that differs from the catalog price,
  **any** price when the product record has none; a matching catalog price and
  the machine-provided affiliate URL are never flagged.
- URL rules: altered (case-changed) URL rejected, missing URL rejected, exact
  URL accepted.
- Ending rules: missing ending rejected, **any text after the ending rejected**,
  trailing punctuation rejected, wrong hashtag order rejected, extra hashtags
  after the mandatory pair rejected.
- Disclosure must be prose (`link afiliasi`); a composite hashtag does not count.
- Normalization: case, extra whitespace/NBSP, NFKC fullwidth, punctuation.
- Structured `ValidationIssue` mapping with severities and claim-category
  prefixes; compliant copy → empty issue list.

### `tests/unit/provider-runner.test.ts` (24 tests — new)
- Timeout: hung call fails with typed `AI_TIMEOUT`, the cooperative `AbortSignal`
  is aborted, request `timeoutMs` wins over the policy default.
- Bounded retries: transient failure recovers, `maxAttempts` is respected,
  permanent errors are not retried, unknown errors are transient but bounded.
- Rate limits: `retryAfterMs` honored, clamped to `maxDelayMs`, exponential
  backoff fallback, gives up after the bound.
- Usage/cost metadata: calls/retries/cost accumulated, **cost total marked
  unknown when any call omits it** (no fabricated totals), caption vs image
  usage tracked separately.
- Logging: one warning per failed attempt, credentials redacted in both the log
  line and the rethrown error.
- Live providers without credentials: labeled live **without any network call**,
  `ready:false` with a BLOCKED/NOT_TESTED detail, typed non-retryable
  `AI_PROVIDER_UNAVAILABLE`, not retried by the resilience layer — for both the
  image and caption adapters.

### `tests/unit/content-scheduler.test.ts` (27 tests — new)
- 60-minute interval honored exactly; day capped at 24 slots; never early.
- Job identity `content:<slotKey>` with kind `content_slot`; exactly one job per
  due slot; a second tick does not duplicate it.
- Automation paused → no-op; started → executes.
- Anti-catch-up: only the most recent due slot runs, the rest are recorded as
  `catch_up_limited`; `maxCatchUpPerTick > 1` honored; a nonsensical bound still
  keeps ≥ 1.
- Stage progression `reserved → generating_images → generating_captions → … →
  publish_ready`; **stops at `publish_ready` and never invokes a publisher**;
  an already-terminal slot is skipped (never regenerated/republished).
- No eligible product → explicit skip reason; pipeline failure → precise reason
  + reschedule with backoff; future slots still scheduled after a failure;
  interrupted jobs resumed with the **same product and image count**; valid
  assets reused; a thrown pipeline is failed, not lost; a job left by an
  interrupted run is picked up; an overlapping tick is a no-op.
- `lastTick` and the catch-up bound are surfaced; worker id reported.

### `tests/unit/atomic-file.test.ts` (6 tests — new, written for the bug in §5)
- 20 concurrent writes to one path: no throw, no `*.tmp` leftovers.
- Failure leaves the previous file intact and cleans up the temp file.
- `createSerialQueue`: FIFO order; a rejection does not wedge later work.
- Concurrent scheduler-vs-API slot saves: **no slot record lost**, reload sees
  both keys, no temp leftovers; a 12-key parallel burst survives.

### `tests/unit/pipeline.test.ts` (+10 → 49)
- Regenerates up to `MAX_CAPTION_ATTEMPTS` then **BLOCKS** a non-compliant
  caption; regeneration is driven by the exact failing rules and succeeds on the
  next attempt; a fabricated discount is rejected by the guard, not published.
- Every `publish_ready` caption ends EXACTLY with `#ai #automation` and embeds
  the affiliate URL; `publish_ready` **requires** the editorial gate (never
  bypassed for the schedule).
- Reference binding: `reference_product_mismatch`, `reference_product_missing`,
  `invalid_reference_image`, `missing_reference_image` — each blocks with its
  own code; the reserved product + reference survive a retry unchanged.

### `tests/unit/selection.test.ts` (+2 → 22)
- The same source product is picked regardless of per-instance UUIDs; stays
  stable across many independently built catalogs (regression for the tie-break
  fix).

### `tests/contract/catalog-pipeline-api.test.ts` (+7 → 44)
- Preview exposes the editorial result with the mandatory ending; image quality
  **without any fidelity score**; reference availability explicitly reported;
  `publish_ready` preview reports availability as true.
- `GET /v1/scheduler/status` reports the content scheduler block additively;
  `lastTick` surfaced; the queue exposes `content_slot` jobs under the
  persistent identity.

---

## 3. New Flutter test coverage (10 tests)

### `app/test/part4_preview_test.dart` (10 tests — new)
- Model contract: editorial + image-quality + reference blocks parse; fixture
  payloads keep `editorial`/`imageQuality`/`referenceAvailable` **null** (no
  invented data); a failing editorial report carries the explicit rejected
  claim rules.
- Screen: editorial card renders `Required ending`, `Ends with #ai #automation`,
  `Ending present`, disclosure `Present` and the "not a substitute for human
  editorial review" limitation; a blocked caption surfaces the rejected rule id,
  the message and `Missing required ending #ai #automation`.
- Image-quality card: `Automated fidelity score → Not available (never
  fabricated)`, `Structural checks only`, the not-assessed dimensions including
  `product_identity`; the score is never rendered as a number.
- Reference availability: available chip + catalog id; a missing reference
  explains *why* generation is blocked.
- PART 2 fixture payloads render **without** any PART 4 section.
- No screen ever claims a publication (`Not attempted`, never `Published`).

Existing suites keep their constraints: `pipeline_preview_test.dart` still
expects `textContaining('FAILED')` once, so the image-quality chip label is
`Structural problems found` rather than `FAILED`.

---

## 4. Live smoke test (real server, real HTTP, 51 / 51 PASS)

Script: `docs/implementation/part-04-smoke.ps1` (committed with this evidence).

Setup: `npm start` on `127.0.0.1:8794`, `NODE_ENV=development` (file storage),
`SCHEDULER_ENABLED=true`, `SCHEDULER_MODE=mock`, `AI_IMAGE_PROVIDER=mock`,
`AI_TEXT_PROVIDER=mock`, throwaway secrets (never committed), **fresh
`backend/data`** so the scheduler starts with no pre-existing slots. A 3-row CSV
(2 eligible products, 1 without an affiliate link) was imported through the real
parser.

Verified end-to-end:

- **Boot/auth**: `/health` ok; token issued for the install key.
- **Scheduler block (additive)**: `contentScheduler.connected=true`,
  `jobKind=content_slot`, `publishing=disabled`, `interval=60`, `maxSlots=24`,
  `maxCatchUpPerTick=1`, note `…never invokes Facebook/Threads publishers`.
- **Scheduler → queue → pipeline**: a tick enqueued `content:2026-10-12#18`,
  the worker executed it to `succeeded` (`attempts=1`), `lastTick` shows
  `enqueued=…#18 executed=1 skipped=17`, and **no publish-kind job ever exists**.
- **Anti-catch-up**: 17 overdue slots skipped as `catch_up_limited` — no burst
  after downtime.
- **Manual run** (`POST /v1/pipeline/run`, same code path as the scheduler):
  `stage=publish_ready`, `source=pipeline`.
- **Editorial**: `passed=true`, `blocking=0`, required ending `#ai #automation`,
  `mandatoryEndingPresent=true`, `disclosurePresent=true`, limitations list
  contains "Not a substitute…".
- **Caption**: ends **exactly** with `#ai #automation` (nothing after it),
  contains the affiliate URL verbatim, hashtags block present, no first-person
  subject, `mandatoryEndingPresent=true`.
- **Image quality**: present + passed, `automatedFidelityScore = null`,
  `notAssessed` lists `product_identity, packaging_fidelity, main_color,
  anatomy_realism, lighting, generation_artifacts`, limitations disclosed.
- **Reference binding**: `referenceAvailable=true`, the reference URL is the
  catalog image of the reserved product.
- **Providers**: `providers.image = mock_image/mock`,
  `providers.caption = mock_caption/mock` (mock vs live explicit on the wire).
- **Stability**: `imageCount=2` persisted; after another 60 s of ticks,
  `publish_ready` slots unchanged (`changed=0`, 2 before / 2 after).
- **Persistence**: `storageKind=file`; no `*.tmp` leftovers.
- **Never published**: `facebook=not_attempted`, `threads=not_attempted`,
  history `source=fixture` with the note "…no real post was made", zero
  non-fixture publications, Facebook integration `configured=false, mode=disabled`.

Full output (51 lines) is reproducible by running the script; the only FAILs
observed during development were (a) three wrong field-name guesses in the
script itself and (b) the real product bug in §5.

---

## 5. Bug found by the smoke test (and fixed)

The first smoke run failed the manual pipeline call with this real server error:

```
SlotStoreError: Could not write slot store ...\backend\data\slots.json
  at FileSlotStore.save (src/automation/slot-store.ts)
  at async SlotContentStore.persist / .put
  at async ContentPipeline.generateCaptions
  cause: ENOENT: no such file or directory, rename
         '...\slots.json.tmp' -> '...\slots.json'
```

**Cause.** All three file stores wrote one fixed temp path `<file>.tmp`. When an
API-triggered pipeline run persisted slot `#90` at the same moment a scheduler
tick persisted slot `#18`, writer A renamed the shared temp file away and
writer B's rename failed with `ENOENT` — i.e. the concurrency PART 4 introduces
(scheduler + API sharing one store) could fail a real run.

**Fix** — new `backend/src/core/atomic-file.ts`:

1. `atomicWriteText()` uses a **unique** temp name per attempt
   (`<file>.<pid>.<uuid>.tmp`), removes it on failure, and serializes writes to
   the same path through one FIFO chain;
2. `rename` retries a bounded number of times with backoff for the
   Windows-specific transient codes (`EPERM`/`EBUSY`/`EACCES`/`ENOTEMPTY`) —
   reproduced by the concurrency test on this machine;
3. `createSerialQueue()` is used by `FileSlotStore`, `FileSettingsStore` and
   `FileCatalogStore` so an older snapshot can never overwrite a newer one.

**Verified**: `tests/unit/atomic-file.test.ts` (6 tests) + the full suite (533)
+ a re-run of the smoke test, where the same pipeline run now succeeds while the
scheduler tick is executing (`51/51 PASS`, server log shows **0 error lines**).

---

## 6. Static checks and builds — actual outcomes

```
$ cd backend && npm run typecheck
  tsc -p tsconfig.json --noEmit          → no output, exit 0

$ cd backend && npm run lint
  eslint .                               → no output, exit 0

$ cd backend && npm test
  Test Files  20 passed (20)
  Tests       533 passed (533)           ← 25 s wall time

$ cd backend && npm run build
  tsc -p tsconfig.build.json             → BUILD OK

$ cd app && flutter analyze
  Analyzing app... No issues found! (ran in 6.1s)

$ cd app && flutter test
  00:28 +147: All tests passed!

$ cd app && flutter build apk --debug
  ✓ Built build\app\outputs\flutter-apk\app-debug.apk   (168.2 MB)
```

---

## 7. BLOCKED / NOT_TESTED in this part

| Item | Status | Why |
| --- | --- | --- |
| PostgreSQL / Drizzle stores | **BLOCKED** | No PostgreSQL and no Docker; `db/schema.ts` + `0001_part3_catalog.sql` are committed but not applied. File-backed stores are the verified default. |
| Live Shopee feed | **BLOCKED** | No official API contract / real feed sample; verified against the documented CSV shape only. |
| Live AI image + caption generation | **NOT_TESTED** | No provider credentials and `allowLive:false`. Configuring `openai`/`google` yields `UnavailableImageGenerator` / `UnavailableCaptionGenerator` (`ready:false`, BLOCKED/NOT_TESTED), never a silent mock fallback. |
| S3-compatible upload | **NOT_TESTED** | No credentials; `MemoryObjectStorage` is the verified path. |
| Facebook Page + Threads publishing | **NOT_TESTED** | Live publishing is disabled in PART 4 by design; no publisher is ever invoked (`facebook`/`threads` stay `not_attempted`). |
| Telegram notifications | **NOT_TESTED** | No bot token; no send was attempted. |
| 24/7 operation | **NOT_TESTED** | Requires deployment to an always-on service. The backend is *designed* to run independently of the APK (verified: it keeps ticking with no APK connected), but no uptime claim is made. |
| Human-level image verification | **NOT_TESTED by definition** | Structural checks only. No test or UI claims a machine fidelity score (`automatedFidelityScore` is always `null`) or human equivalence. |

---

## 8. Honesty constraints this part actually enforces

- A caption that implies ownership, receipt, usage, firsthand results or a
  personal endorsement is rejected **by code**, regenerated with the exact
  failing rules up to `MAX_CAPTION_ATTEMPTS`, and then **blocks** the slot —
  it is never published and never silently downgraded.
- Every caption that reaches `publish_ready` ends exactly `#ai #automation` with
  nothing after it and embeds the affiliate URL verbatim.
- `publish_ready` requires **every** gate: editorial, caption validation,
  reference binding, image validation, storage verification, platform config.
- Image count and asset identity are stable across retries; regeneration only
  happens on an explicit request.
- Mock output is always labeled `providerKind: 'mock'`; live providers without
  credentials fail loudly instead of degrading.
- No endpoint, screen or log claims a publication that did not happen; the only
  "published" records in the app are explicitly `source: fixture` samples.
