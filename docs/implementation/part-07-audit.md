# PART 7 — Audit: End-to-End Content Generation, Provider Configuration & GitHub Delivery

**Baseline:** PART 6 `f3cfeda`, PART 6A docs correction `1457072`.
**Scope:** audit before editing; PART 7 only; no PART 8; live publishing stays disabled.
**Classification vocabulary:** `PASS` / `FAIL` / `BLOCKED` / `NOT_TESTED`.

---

## 1. Git & repository state (pre-edit)

| Check | Result |
|---|---|
| Branch / HEAD | `master` @ `1457072` (PART 6A), history: `2fa19a8 → … → f3cfeda → 1457072` |
| Working tree | **Clean** — 0 modified/untracked files; no user work to preserve or lose |
| Remotes configured | **NONE** (`git remote -v` empty) |
| Local author | `Autopilot Agent <agent@local>` (repo-local); global identity unset |
| Target remote | `https://github.com/ciptaone/Automotion-Shopee-AFfiliate` |
| Target reachable? | **FAIL — connection reset** (`git ls-remote` → `Recv failure: Connection was reset`) |

**Remote discrepancy report (required by brief §1.4):** the local repository does
**not** point at the target URL — it points at *nothing*. Because no remote
exists, there is no unrelated remote work to overwrite or unrelated history to
merge; adding `origin` is an addition, not a silent replacement. The target
could not be probed read-only because outbound HTTPS to GitHub is unavailable in
this environment, so the remote's contents are unknown until authentication and
connectivity exist (see §11 plan).

**Planned identity:** repository-local `user.email = ciptaone1@gmail.com`,
author **name preserved** as `Autopilot Agent` (the repo already specifies that
name; the brief only mandates the email). No historical commit is amended.

---

## 2. Manual provider configuration without API keys — pre-existing (PART 6)

Audited `backend/src/providers/provider-service.ts`, `types.ts`, `server.ts`:

| Requirement | Status | Evidence |
|---|---|---|
| Independent text/image configs, display name, adapter type, base URL, model, params, enable/disable | **PASS** | `providerInputSchema` (`types.ts`), `POST/PATCH /v1/providers` |
| Credentials write-only, backend-encrypted, never returned | **PASS** | `PUT/DELETE /v1/providers/:id/secret`; views return `secret: {present, masked, keyConfigured}` only |
| **Save config before entering a key** | **PASS (already implemented)** | `create()` records config even when the secret is absent: *"Required-but-missing secret at creation time is a normal state: the operator adds it next"* (`provider-service.ts:255`) |
| Clear `not_configured` status, not an app-wide error | **PASS** | missing `SECRETS_ENCRYPTION_KEY` ⇒ `configuration_invalid` with explicit detail; untested capabilities ⇒ `not_configured`; `PROVIDER_SECRET_UNAVAILABLE` is an exposed, typed configuration error (never a bare 500) |
| SSRF-safe endpoint validation | **PASS** | `EndpointPolicy.validate()` on create/update; contract suite asserts metadata/loopback/private rejection |
| Timeouts, redirect rejection, size cap, bounded retries | **PASS** | `timeoutMs` schema `[1 s, 120 s]` + transport re-clamp; `redirect:'error'`; streamed 8 MB cap; `maxRetries` `[0,3]` |
| No auto-switch to another provider/mock on failure | **PASS** | `fallback:'none'`; router throws on selected-provider failure; `PROVIDER_IN_USE` blocks disabling a selected provider |
| Independent text/image readiness | **PASS** | per-capability probes; config change resets each capability to `not_configured` |
| Missing key does not block non-AI features | **PASS** | catalog import, settings, history, preview are provider-independent; only generation is gated |

**Conclusion: §2 needs no backend change.** The remaining §2/§3 concern is that
the *pipeline's* failure reason is not surfaced (§3 GAP A below).

---

## 3. End-to-end generation pipeline — wiring audit

### 3.1 The components are already connected (no parallel pipeline exists)

```
scheduler tick ─▶ queue job (content:<slotKey>) ─▶ ContentPipeline.runSlot
   reserve(product, affiliateUrl)          ── catalog + selection policy
   generateImages  ──┐
   generateCaptions ─┤── ImageGenerator / CaptionGenerator
   runPublishGate    │      = generationRouter.forImage() / .forCaption()
   buildPipelinePreview   = router ─▶ selected provider ─▶ adapter ─▶ transport
                        └────────▶ env default ONLY when no selection (labelled `env_default`)
```

`container.ts:389-393` injects the router views directly into `ContentPipeline`
(`container.ts:443-451`), so **product selection → image generation → caption
generation → editorial validation → asset persistence → preview** is one path.
All ten §3 steps exist: catalog+exact affiliate URL, reference verification,
stable slot/job identity, image count persisted before generation (`imageCount`
stored at reservation), generation, editorial validation, `storage.upload` +
checksum persistence, preview UI, and `publish_ready` only after every gate.

### 3.2 GAP A — the explicit failure reason is persisted but never returned (FAIL)

**Exact defect:** `SlotContentRecord.lastError` is written on every generation
failure (`pipeline.ts:413,431,484,593`), persisted (file + Postgres
`last_error`), used by the scheduler for retry (`content-scheduler.ts:438`), but

* `PipelinePreview` exposes `stage` + `blockers` + `attempts`… **not `lastError`**;
* `GET /v1/pipeline/slots` maps `blockers`… **not `lastError`**;
* Flutter `ContentPreview` parses neither, and renders a failed slot as the
  generic *"Real pipeline content — FAILED. Retry the slot."* with an empty
  *"Exact blockers:"* list.

**Why it matters:** for §3's three configuration scenarios — provider missing,
credential absent, capability unsupported — the pipeline correctly blocks
generation (stage `failed`, no mock substitution, state preserved, auto-retry
with backoff up to `maxAttempts: 3`), and the *reason* is an honest, already
redacted, user-actionable string (e.g. `…requires a credential that is not
stored (or cannot be decrypted). Add the API key before using it.`). But the
operator cannot see it in the dashboard: §3 "return an explicit blocked reason"
and §2 "display a clear status rather than an application-wide error" are
therefore not met on the client.

**Decision — why `failed` (auto-retry) is kept rather than re-labelled
`blocked` (terminal):** `blocked`/`publish_ready` are terminal stages
(`pipeline.ts:119`) requiring an explicit regenerate, which would *break* §3's
"retried safely after configuration is corrected". `failed` already resumes and
reuses valid assets. The fix is to **surface the reason**, not to change the
stage machine.

### 3.3 GAP B — nothing proves the configured-provider path end-to-end (FAIL)

* `tests/unit/pipeline.test.ts` injects `MockImageGenerator`/`MockCaptionGenerator`.
* `tests/contract/catalog-pipeline-api.test.ts` asserts `providers.*.kind === 'mock'`.
* `generation-router.test.ts` tests the router in isolation.

No test drives **catalog → reservation → configured provider → adapter →
transport → editorial → persistence → preview** with a real (encrypted) secret
and a real selection, nor asserts the missing-credential failure surfaces an
explicit reason without silently falling back to the env mock. PART 7 adds one
focused contract suite for both paths (fetch + DNS injected; zero network).

### 3.4 Verified working (PASS)

- Router uses the env default **only when no provider is selected**, labelled
  `source: 'env_default'` with a warning — a configuration state, not a
  post-failure fallback; a *selected* provider's failure always throws.
- Attribution: preview exposes per-asset/caption `provider`, `providerKind`,
  `model`; usage ledger records provider/model/requestId/tokens/images/cost class.
- Text and image providers are selected independently (`textProviderId` /
  `imageProviderId`).

---

## 4. Image quality & product fidelity (§4) — PASS, no change

- Reference required before generation: missing ⇒ `blocked`
  (`missing_reference_image`); URL/product binding verified ⇒ quarantined on
  mismatch, never substituted.
- Reference usage respects capability declarations: the OpenAI-images adapter
  sends edits+reference **only** when `image_editing && image_reference_input`
  (declared by the adapter, user-narrowable); otherwise it uses the plain
  generations endpoint and does **not** send editing parameters — exactly the
  §4 rule. A reference fetch failure fails loudly (no unrelated substitute).
- Two requested images ⇒ two distinct views (`main_closeup_pov`,
  `secondary_lifestyle`) with position-specific seeds and byte-identical
  duplicate rejection; count persisted at reservation, stable across retries.
- `automatedFidelityScore` is structurally `null`; `notAssessed` discloses
  `product_identity` etc.; unassessable outputs block for review.

## 5–6. Caption policy & scheduling (§5, §6) — PASS, no change

Editorial policy centralised (`editorial-policy.ts`), bounded regeneration
(`MAX_CAPTION_ATTEMPTS = 3`), exact `#ai #automation` ending enforced, semantic
first-person-claim rejection, exact affiliate URL + disclosure. Schedule: target
3/4 (default 4), `Asia/Jakarta`, four WIB windows, `slotsToday ≤ 4`, transactional
Postgres daily cap under advisory lock, anti-catch-up `maxCatchUpPerTick = 1`,
stable slot/job identity, publishing gate untouched (`publishing: disabled`).

## 7. Live provider smoke (§7) — MISSING (BLOCKED until credentials exist)

Test routes already exist (`POST /v1/providers/:id/test/{connection,text,image}` —
bounded, sanitized, never publishing), but there is **no opt-in runner** that
reports `BLOCKED`/`NOT_CONFIGURED` when credentials are absent. PART 7 adds
`backend/scripts/live-provider-smoke.ts` + `npm run smoke:providers`:

- reads `LIVE_SMOKE_TEXT_*` / `LIVE_SMOKE_IMAGE_*` env vars (base URL, model,
  key, optional adapter);
- **no credentials ⇒ prints `BLOCKED: NOT_CONFIGURED` and exits 2 — never PASS**;
- with credentials ⇒ boots the real server, creates the provider, stores the
  encrypted secret, runs **one text and one image test separately**, records
  provider/model, auth outcome, capability outcome, request id, usage/cost,
  sanitized error, duration; deletes the provider; **never publishes**;
- exit codes: `0 = PASS` (both capabilities actually exercised),
  `1 = FAIL`, `2 = BLOCKED/NOT_CONFIGURED`.

Live generation stays **NOT_TESTED** until real authenticated requests succeed.

## 8. Usage, cost, persistence (§8) — PASS, no change

Per-request ledger rows (provider, model, request id, timestamp, tokens/images),
`actual`/`estimated`/`unknown` cost classes, budgets checked **before** the
request, unknown cost never treated as $0, `fallback:'none'`, job lease/heartbeat
ownership and idempotent slot identity in Postgres.

---

## 9. Planned PART 7 changes (narrow scope)

| # | Change | Files |
|---|---|---|
| 1 | **GAP A:** expose `lastError: string \| null` on `PipelinePreview` and in `GET /v1/pipeline/slots` | `automation/pipeline-preview.ts`, `app/server.ts` |
| 2 | **GAP A (client):** parse + render the failure reason (stage banner/pipeline card) | `app/lib/models/automation_models.dart`, `app/lib/screens/preview_screen.dart` |
| 3 | **GAP B:** new contract suite: configured-provider end-to-end (live kind, real model names, editorial pass, assets persisted, usage recorded) + missing-credential path returns an explicit reason with **no mock substitution** | `tests/contract/pipeline-provider-e2e.test.ts` |
| 4 | **§7:** opt-in live smoke runner + npm script | `scripts/live-provider-smoke.ts`, `package.json` |
| 5 | **§10:** this audit + evidence doc | `docs/implementation/part-07-{audit,evidence}.md` |
| 6 | **§11:** repo-local identity, add `origin`, commit, push attempt | `.git/config`, git metadata only |

**Explicitly out of scope:** no changes to scheduling, editorial rules, image
counts, retries, budgets, publishing gate, migrations, or any PART 1–6 behaviour;
no live publishing; no PART 8.

## 10. Verification plan (§9)

1. `npm run typecheck && npm run lint && npm test && npm run build`
2. `npm run test:db` + `db:status` + `db:verify` + `npx drizzle-kit check`
3. `flutter analyze && flutter test && flutter build apk --debug`
4. PART 4 smoke with documented env (`SCHEDULER_ENABLED=true`, `SCHEDULER_MODE=mock`, mock AI providers) — expect **51/51**
5. `npm run smoke:providers` without credentials — must report **BLOCKED**, not PASS
6. `git status`/`git diff` hygiene: no `.env`, keys, runtime data, dumps

**No test assertion may be weakened to achieve these results.**
