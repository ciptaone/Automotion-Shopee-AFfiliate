# PART 7 — Evidence: End-to-End Content Generation, Provider Configuration & GitHub Delivery

**Baseline:** PART 6 `f3cfeda` + PART 6A `1457072` (working tree clean at start).
**Audit/plan:** `docs/implementation/part-07-audit.md` (written before any edit).
**Classification vocabulary:** `PASS` / `FAIL` / `BLOCKED` / `NOT_TESTED`.

---

## 0. Summary

| # | Requirement | Classification | Evidence |
|---|---|---|---|
| 1 | Initial audit, no destructive Git action | **PASS** | §1 |
| 2 | Manual provider config usable without API keys | **PASS (pre-existing, verified)** | §2 |
| 3 | Real end-to-end pipeline: explicit failure reason surfaced | **PASS (fixed)** | §3 |
| 4 | Image quality / product fidelity invariants | **PASS (unchanged, verified)** | §4 |
| 5 | Caption policy invariants | **PASS (unchanged)** | §7 |
| 6 | Scheduling / publishing gate invariants | **PASS (unchanged)** | §7 |
| 7 | Opt-in live provider smoke (BLOCKED without creds) | **PASS (script)** — live requests **NOT_TESTED** | §5 |
| 8 | Usage/cost attribution persisted | **PASS (verified in E2E)** | §3 |
| 9 | Full verification suite | **PASS** | §6 |
| 10 | Docs (this + audit) | **PASS** | §10 |
| 11 | PART 7 commit + push | **PASS** — commit `353e4aa`, pushed to `origin/master` (see §9 addendum) | §1, §9 |

---

## 1. Git & remote (requirement 11)

Pre-edit state: `master` @ `1457072`, working tree **clean**, **no remote
configured**, local identity `Autopilot Agent <agent@local>`.
Full discrepancy report in `part-07-audit.md` §1: because no remote existed,
there was no unrelated remote work to overwrite and no unrelated history to
merge — adding `origin` is an addition, not a replacement.

`git ls-remote https://github.com/ciptaone/Automotion-Shopee-AFfiliate` failed
at audit time with `Recv failure: Connection was reset` (exit 128) — the
GitHub connection from this environment is intermittent (it succeeded later;
see the push addendum below). At audit time, therefore:

- The PART 7 commit is created locally with the mandated repo-local identity
  (`user.email=ciptaone1@gmail.com`, author **name preserved** as the repo-specified
  `Autopilot Agent`); **no historical commit is amended**.
- `origin` is configured to the target URL (safe addition — see audit §1).
- At audit time the target was unreachable (`Recv failure: Connection was
  reset`), so the audit flagged the push as a likely BLOCKER; the actual push
  later succeeded — see the addendum below and §9.

Never used: `git reset --hard`, force-push, history rewrite, `--mirror`,
`update-ref`. No `.env`, keys, secrets, or runtime data staged (diff reviewed
file-by-file; §6).

**Push outcome (addendum, corrected after execution):** the earlier draft of
this section predicted the push would be BLOCKED because `git ls-remote` failed
with `Recv failure: Connection was reset` during the audit. The GitHub
connection from this environment is **intermittent**: the actual
`git push -u origin master` **succeeded** — git exited `0` with
`* [new branch] master -> master` and set up tracking
(`branch 'master' set up to track 'origin/master'`). A final read-only
verification then succeeded as well: `git ls-remote origin` reports
`refs/heads/master = 149b04a58676b26fc70678c3f9ce49e2f5341608`, identical to
the local HEAD. Both PART 7 commits (`353e4aa`, `149b04a`) are on GitHub.

## 2. Provider configuration without API keys — verified pre-existing (no change)

Re-verified against `provider-service.ts` after PART 6 (nothing regressed, no
PART 7 edit needed):

| Behaviour | Evidence |
|---|---|
| Config saves **before** a key exists | `create()` records the provider and marks readiness honestly: *"Required-but-missing secret at creation time is a normal state: the operator adds it next"* (`provider-service.ts:255`) |
| Missing `SECRETS_ENCRYPTION_KEY` ⇒ `configuration_invalid` with explicit detail, config still saved | same block (`:257–264`) |
| Untested capability ⇒ `not_configured`, not an error | `readinessOf()` (`:881`) |
| Use-time credential absence ⇒ typed `PROVIDER_SECRET_UNAVAILABLE` (category `configuration`, `expose:true`) with an actionable message — never a bare 500 | `contextFor()` (`:761–769`) |
| Text/image readiness independent | separate probes + per-capability reset on config change (`:320–324`) |
| Non-AI features unaffected by a missing key | catalog import, settings, history, preview, scheduler do not depend on `providers.*` |

## 3. End-to-end pipeline — GAP A fixed, GAP B closed by test

### 3.1 What was connected (audit finding, verified)

`container.ts:389–393` already injects `generationRouter.forImage()` /
`forCaption()` views into `ContentPipeline` — one single path:
catalog → reservation (exact affiliate URL + reference image) → router →
selected provider adapter → transport → editorial/image validation →
`storage.upload` + checksum persistence → preview → `publish_ready` only after
every gate. **No parallel pipeline was created.**

### 3.2 GAP A — explicit failure reason now exposed (FAIL before → PASS after)

**Defect:** `SlotContentRecord.lastError` carried the exact (redacted) reason
generation stopped (missing credential, unsupported capability, upstream
error…) but was persisted-only — neither `PipelinePreview` nor
`GET /v1/pipeline/slots` returned it, and the Flutter preview rendered a failed
slot as a bare *"FAILED. Retry the slot."* with an empty blockers list. That
violated §3 "return an explicit blocked reason" and §2 "clear status rather
than an application-wide error".

**Fix (additive, 3 small edits):**

- `pipeline-preview.ts` — `PipelinePreview.lastError: string | null` (+ builder).
- `server.ts` `/v1/pipeline/slots` — maps `lastError` per slot.
- `automation_models.dart` — `ContentPreview.lastError` parsed;
  `preview_screen.dart` — renders *"Reason generation stopped:"* under the
  blockers list (rule label `generation_stopped`, deliberately lower-case to
  preserve the `find.textContaining('FAILED')` single-match invariant).

**Stage semantics deliberately unchanged:** `failed` (auto-retry with backoff,
`maxAttempts: 3`, resumes and reuses valid assets — satisfies "retried safely
after configuration is corrected") stays distinct from terminal `blocked`
(explicit regenerate). Only the reason was missing.

### 3.3 Bug found by the new E2E test: stale `lastError` after recovery (fixed)

`lastError` was only cleared on fresh reservation or explicit `regenerate`.
Consequence (proven by the new contract test): a slot that failed for a missing
credential and then **succeeded** after the key was added kept the old failure
reason — a healthy `publish_ready` preview would display a stale error.

**Fix:** `bumpAttempt()` now clears `lastError` at the start of every new
attempt (`pipeline.ts:731–744`). A failure re-sets it within the same attempt;
all five `stage:'failed'` persist sites set it (verified by grep), so the
scheduler's `safeFail(... lastError …)` path is unaffected. No existing test
asserted stale-error persistence (checked `pipeline.test.ts`,
`content-scheduler.test.ts`, `slot-store.test.ts` — the store test only asserts
dumb persistence of a value the pipeline supplies).

### 3.4 New contract suite `tests/contract/pipeline-provider-e2e.test.ts` (2 tests, PASS)

Offline by construction (injected DNS lookup + injected fetch stub imitating
OpenAI-compatible endpoints — unit mock at the fetch boundary, labelled as
such; zero network, nothing published):

**(A) Configured providers → publish-ready content** — catalog import (1 row)
→ `imageCountPolicy: two` → text provider (`openai_chat_completions`) + image
provider (`openai_images`) created, encrypted secrets stored, both selected →
`POST /v1/pipeline/run`. Asserts:

- `stage=publish_ready`, `publishReady=true`, `lastError=null`,
  `product.affiliateUrl` exact, `referenceAvailable=true`,
  both platforms `not_attempted` (nothing published);
- independent selections honoured: `providers.image={E2E Image, live}`,
  `providers.caption={E2E Text, live}`; per-image/caption `model` =
  configured model ids, `providerKind=live` everywhere;
- 2 images, **distinct checksums**, `imageCount=2` persisted;
- the **reference image was actually fetched and sent to the provider**
  (`GET cf.shopee.co.id` then `POST …/images/edits`) and only to the configured
  hosts;
- caption passes every editorial/structural rule (`blocking=[]`,
  disclosure, verbatim URL, exact `#ai #automation` ending) on **both**
  platforms; `automatedFidelityScore` stays `null`;
- usage ledger: exactly 3 rows (2× `image_generation` + 1× `text_generation`),
  each with the **actual provider name/adapter/model**, `status=success`,
  `costKind=unknown` (never an invented price);
- re-run is idempotent (terminal, `actions=[]`, same 2 assets);
- **no credential ever appears in any response body** (secret-leak scan).

**(B) Selected provider without credential → explicit reason, no mock,
retry-safe** — provider selected but secret deliberately not stored:

- `stage=failed`, `publishReady=false`, and — the PART 7 fix —
  `preview.lastError` matches `/credential/i` and names the provider; the same
  reason appears in `GET /v1/pipeline/slots`;
- **nothing fabricated**: `images=[]`, `caption.fullText=''`,
  `providers={image:null, caption:null}` (no mock content claimed);
- **fail-closed before any HTTP**: the outbound-call log is empty;
- state preserved: a retry keeps the same `sourceProductId` and bumps
  `attempts`; usage rows stay at 0 (nothing billed);
- **after the credential is added, the SAME slot reaches `publish_ready`**
  with `lastError=null` and 2 live-attributed images — proving the failure was
  configuration, not content, and that retry-after-fix works end-to-end.
  (This is the assertion that exposed and now guards the §3.3 stale-error bug.)

## 4. Product fidelity (§4) — unchanged, verified

No PART 7 edit; invariants re-confirmed while wiring the E2E test: the pipeline
blocks on a missing reference (`missing_reference_image`) and quarantines a
reference/URL binding mismatch; the OpenAI-images adapter sends edits+reference
only when `image_editing && image_reference_input` are effective (declared by
the adapter, user-narrowable) and never sends editing parameters to providers
that do not support them; a reference fetch failure aborts loudly instead of
substituting an unrelated image; byte-identical duplicates are rejected;
structural-only quality with honest `automatedFidelityScore: null` and
`notAssessed` disclosure.

## 5. Opt-in live provider smoke (§7) — `npm run smoke:providers`

New `backend/src/cli/live-provider-smoke.ts` (+ `smoke:providers` script):

- **Credential-free default run — BLOCKED, never PASS** (verified in this
  environment, exit code 2):

```
RESULT: BLOCKED — NOT_CONFIGURED
No live credentials are available, so no live request was attempted.
Missing environment variables (names only, no values):
  - LIVE_SMOKE_TEXT_BASE_URL … LIVE_SMOKE_IMAGE_API_KEY
Live generation verified: NO (NOT_TESTED).
EXIT=2
```

- TEXT and IMAGE are read from separate env pairs and tested **separately**
  (one bounded request each) through the real `ProviderService` test actions —
  which cannot publish. Reports per capability: adapter, endpoint, model,
  credential presence (values never printed), connection status + duration,
  **authentication outcome**, capability status, **request id**, generated-text
  preview + mandatory-ending check or image mime/size, readiness map, usage
  rows with **actual cost class**, then verdict.
- Classification: configured+ready ⇒ PASS; rejected/failed request ⇒ FAIL;
  missing/invalid configuration or unsupported capability ⇒ BLOCKED; overall
  `FAIL > BLOCKED > PASS`, and **PASS requires both capabilities actually
  exercised** (`Live generation verified: YES` only then). Exit codes
  0/1/2. The temporary provider + encrypted secret are deleted afterwards.
- **Live generation with real credentials: NOT_TESTED** — no AI API credentials
  exist in this environment, so no authenticated external request was made and
  none is claimed.

## 6. Verification (requirement 9) — all gates green

| Gate | Command | Result |
|---|---|---|
| Backend typecheck | `npm run typecheck` | **PASS** (clean) |
| Backend lint | `npm run lint` | **PASS** (clean) |
| Backend unit+contract | `npm test` | **PASS — 732/732** (30 files; 730 baseline **+ 2 new PART 7**, none weakened) |
| Backend build | `npm run build` | **PASS** (clean) |
| Drizzle consistency | `npx drizzle-kit check` | **PASS** (`Everything's fine`) |
| PostgreSQL integration | `npm run test:db` | **PASS — 76/76** (7 files) |
| Migration status | `db:status` | **PASS** — 4/4 applied, no drift (no new migration in PART 7) |
| Schema verification | `db:verify` | **PASS** — live schema matches `src/db/schema.ts` |
| Flutter analyze | `flutter analyze` | **PASS** — no issues |
| Flutter tests | `flutter test` | **PASS — 162/162** |
| Flutter debug APK | `flutter build apk --debug` | **PASS** (`app-debug.apk` built) |
| PART 4 live smoke | `part-04-smoke.ps1` vs `127.0.0.1:8794`, `SCHEDULER_ENABLED=true SCHEDULER_MODE=mock AI_IMAGE_PROVIDER=mock AI_TEXT_PROVIDER=mock` | **PASS — 51/51** (`TOTAL=51 PASS=51 FAIL=0`), boot log confirms `content scheduler loop started`; script unchanged |
| Live provider smoke (no creds) | `npm run smoke:providers` | **PASS (expected BLOCKED)** — exit 2, `RESULT: BLOCKED — NOT_CONFIGURED` |
| Live provider smoke (real creds) | — | **NOT_TESTED** (no credentials) |
| GitHub push | `git push -u origin master` | **PASS** — exit 0, `* [new branch] master -> master`, tracking set up (connection to GitHub is intermittent; later re-read attempts reset — §1 addendum) |

Diff hygiene: `git status`/`git diff` reviewed file-by-file — 6 modified + 4
new source/doc files; **no `.env`, keys, secrets, dumps, `backend/data`, or
build artifacts** staged. Invariants re-checked and unweakened: `/health`
`part: 1`; caption ends exactly `#ai #automation`; `automatedFidelityScore`
null; `MAX_CAPTION_ATTEMPTS=3`; `maxCatchUpPerTick=1`; four WIB windows,
`dailyPostTarget=4`; no live publishers; `find.textContaining('FAILED')`
single-match invariant respected by the new UI label.

## 7. Preserved invariants (spot checks)

- Scheduling: smoke shows `publishing=disabled`, `maxCatchUpPerTick=1`,
  `content_slot` job identity `content:<slotKey>`, terminal slots never
  re-run, no publish-kind job ever queued, fixture-only history.
- Caption/editorial: PART 4 smoke + E2E both verify the exact ending,
  disclosure, verbatim URL, no first-person subject.
- Provider isolation: the E2E suite asserts outbound calls hit **only** the
  configured provider hosts (plus the product reference host), and the
  missing-credential case performs **zero** outbound calls.

## 8. Files changed (PART 7)

| File | Change |
|---|---|
| `backend/src/automation/pipeline-preview.ts` | `PipelinePreview.lastError` (+ builder, + doc) |
| `backend/src/app/server.ts` | `/v1/pipeline/slots` maps `lastError` |
| `backend/src/automation/pipeline.ts` | `bumpAttempt()` clears stale `lastError` on a new attempt |
| `backend/src/cli/live-provider-smoke.ts` | **new** — opt-in live smoke (§7) |
| `backend/package.json` | `smoke:providers` script |
| `backend/tests/contract/pipeline-provider-e2e.test.ts` | **new** — 2 end-to-end contract tests (§3.4) |
| `app/lib/models/automation_models.dart` | `ContentPreview.lastError` |
| `app/lib/screens/preview_screen.dart` | "Reason generation stopped" line |
| `docs/implementation/part-07-audit.md` | **new** — audit/plan |
| `docs/implementation/part-07-evidence.md` | this file |

## 9. Delivery (requirement 11)

- Separate PART 7 commit `353e4aa` on `master` (no `PART 8` work included;
  10 files, +1385/−2; author `Autopilot Agent <ciptaone1@gmail.com>`, history
  untouched).
- Remote `origin` = `https://github.com/ciptaone/Automotion-Shopee-AFfiliate`
  added (repository had **no** remote before — no overwrite, no unrelated
  histories; discrepancy documented in the audit).
- **Push succeeded:** `git push -u origin master` exited `0` with
  `* [new branch] master -> master` and set up
  `master → origin/master` tracking; the follow-up PART 7A push was
  `353e4aa..149b04a  master -> master`. The connection to GitHub from this
  environment is intermittent (audit-time probe and some post-push attempts
  returned `Recv failure: Connection was reset`), but a final read-only
  verification succeeded: `git ls-remote origin` reports
  `refs/heads/master = 149b04a58676b26fc70678c3f9ce49e2f5341608` — identical
  to the local HEAD. The full PART 7 history is on GitHub.

## 10. Honest limits

- Live external AI requests: **NOT_TESTED** (no credentials; the smoke script
  is the designated path and refuses to claim PASS without them).
- Live Facebook/Threads publishing: remains **disabled** (unchanged; PART 7
  added no route around the gate).
- Fidelity is structural only: `automatedFidelityScore` stays `null`; reference
  usage is verified by request flow, not by machine vision.
