# PART 1 — STEP B: Integration Feasibility

**Product:** Shopee Affiliate Autopilot
**Date:** 2026-10-12 (Asia/Jakarta)
**Method:** Direct `webfetch` of official vendor documentation. Web search was
unavailable in this session, so every claim below is attributed to a URL that was
actually retrieved, or explicitly marked as **UNVERIFIED / BLOCKED**.

> **Honesty rule applied throughout:** documentation existing is NOT proof an
> integration works. Where a capability could not be exercised against a live
> service in this environment, the status is **BLOCKED** or **NOT_TESTED**, never
> "works".

## Status legend

| Status | Meaning |
|---|---|
| **VERIFIED** | Requirements confirmed against official docs fetched this session. |
| **CONTRACT_READY** | Provider-neutral interface + credential-free contract tests exist and pass. |
| **BLOCKED** | Cannot proceed without an external artifact (credential, sample, account, or DB). |
| **NOT_TESTED** | Interface exists; live behaviour not exercised (by design in Part 1). |

---

## 1. Shopee Affiliate Product Feed — **BLOCKED**

**Goal:** ingest the user's Shopee Affiliate Product Feed.

### What was attempted

| URL | Result |
|---|---|
| `https://affiliate.shopee.co.id/` | No content returned (JS-rendered SPA / bot-blocked). |
| `https://open.shopee.com/docs/affiliate` | No content returned. |
| `https://open.shopee.com/docs/api/affiliate` | No content returned. |
| `https://open.shopee.com/docs/general/affiliate` | No content returned. |

**No official, machine-readable Shopee Affiliate feed API contract could be
retrieved in this session.** No real-time API is assumed.

### Decision (per locked requirements)

- Support **user-provided CSV / XLSX exports**, parsed from the *actual* file
  format. No feed columns were invented; the parser uses a **schema-tolerant
  alias table** (`FIELD_ALIASES` in `shopee-feed-importer.ts`) that maps many
  plausible header spellings onto canonical fields.
- Minimum viable per row: a product id (or derivable id), a name and a product
  URL. Recommended: image URL and affiliate URL (missing ones raise warnings).
- Deduplication is by canonical product id (first occurrence wins).

### Status

| Aspect | Status |
|---|---|
| CSV parsing, validation, dedup | **CONTRACT_READY** — 24 unit tests pass (fixtures). |
| XLSX parsing, validation, dedup | **CONTRACT_READY** — real `.xlsx` bytes parsed via SheetJS in tests. |
| **Live feed compatibility** | **BLOCKED** — no real feed sample and no official API contract available. |

### To unblock

1. Provide one real (sanitized) Shopee Affiliate CSV/XLSX export so the alias
   table can be confirmed against the true column names.
2. Confirm whether the affiliate portal exposes a programmatic API (and its auth
   model) or whether upload-only is the intended long-term path.

---

## 2. Facebook Page Publishing — **VERIFIED / NOT_TESTED**

**Source fetched:** `developers.facebook.com/docs/graph-api/reference/page/feed`
(Graph API reference, Publishing section).

### Confirmed requirements

- **Endpoint:** `POST /{page-id}/feed` on `https://graph.facebook.com/{version}/`.
- **Either `link` or `message` must be supplied.**
- **Permissions required to publish:**
  - `pages_manage_posts`
  - `pages_read_engagement`
  - `pages_show_list`
- **Token:** a **Page access token** requested by someone who can perform the
  `CREATE_CONTENT` task on that Page. Posts appear "in the voice of the Page".
- **Response:** `{"id":"{post-id}"}`. The endpoint supports read-after-write.
- **Link preview customisation:** `picture` (URL) or `thumbnail` (local file,
  `.jpg/.jpeg/.gif/.png`); the link generally must be owned by the posting Page
  for full customisation.
- **Version note:** the doc served references v23.0 but displays v26.0 as current.

### Quotas / limitations

- Reading `/feed` returns ~600 ranked posts/year; `limit` capped at 100.
- No single "publishing quota" endpoint equivalent to Threads' — the adapter
  therefore returns `null` quota rather than inventing a number.

### Test status

| Aspect | Status |
|---|---|
| Credential-free contract test (request shape) | **CONTRACT_READY** — asserts `POST .../v23.0/{page}/feed` with `message`, `link`, `access_token`. |
| Token redaction in described requests | **CONTRACT_READY** — access token never appears in output. |
| **Live publication** | **NOT_TESTED / deliberately disabled.** `allowLive:false` latch; no real post was made. |

### Known risk

Meta frequently deprecates Graph API versions. The version is configurable
(`FACEBOOK_GRAPH_API_VERSION`) and must be pinned + re-validated before any live
run.

---

## 3. Threads API (image publication) — **VERIFIED / NOT_TESTED**

**Sources fetched:**
- `developers.facebook.com/docs/threads/posts`
- `developers.facebook.com/docs/threads/overview`
- `developers.facebook.com/docs/threads/get-started`
- `developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions`

### Confirmed flow (two steps)

1. `POST https://graph.threads.net/{v}/{user-id}/threads` → creates a **media
   container**, returns `{ "id": "<CONTAINER_ID>" }`.
   - For images: `media_type=IMAGE`, `image_url=<public URL>`, optional `text`.
   - **The image must be on a publicly accessible server** — Threads cURLs it.
2. `POST https://graph.threads.net/{v}/{user-id}/threads_publish` with
   `creation_id=<CONTAINER_ID>` → returns `{ "id": "<MEDIA_ID>" }`.
   - Meta recommends waiting ~30 s between step 1 and step 2.

### Auth & permissions

- A Meta app created with the **Threads use case** (separate Threads App ID/Secret).
- OAuth 2.0. Scopes: `threads_basic` (always), `threads_content_publish` (publish).
- **Short-lived** token: 1 hour. Exchangeable for a **long-lived 60-day** token,
  refreshable via `GET /refresh_access_token`.
- Permission grants for public profiles are valid 90 days and extendable on
  refresh; **private profiles cannot be extended** (re-auth required).
- Authorization window: `https://threads.com/oauth/authorize?client_id=...&redirect_uri=...&scope=...&response_type=code`.
  Codes are single-use, valid 1 hour. Token exchange: `POST https://graph.threads.com/oauth/access_token`.

### Media requirements (image)

- **Format:** JPEG or PNG. **Max file size:** 8 MB.
- **Aspect-ratio limit:** 10:1. **Width:** clamped to [320, 1440]. sRGB.

### Text & link rules (directly affect caption design)

- **Text limit: 500 characters; emojis count as UTF-8 bytes.**
- **At most 5 unique links** per post (since 2025-12-22, more fails with
  `THREADS_API__LINK_LIMIT_EXCEEDED`). First URL in `text` becomes the link preview.
- `link_attachment` only works for **text-only** posts (not image posts).

### Rate limits (enforced profile-wide, 24 h rolling)

- **Publishing: 250 posts / 24 h** (`GET /{user-id}/threads_publishing_limit`,
  needs `threads_basic` + `threads_content_publish`; fields `quota_usage`, `config.quota_total`).
- Replies 1,000; deletions 100; location searches 500.
- App-level call count: `4800 × impressions` (min impressions = 10).

**Design implication:** the product's own cap (24 slots/day) is far below the 250/24 h
Threads limit, so the scheduler is safely within quota.

### Test status

| Aspect | Status |
|---|---|
| Two-step container→publish request shape | **CONTRACT_READY** — exact URLs + params asserted. |
| 500-char clamp + link de-duplication | **CONTRACT_READY** (`clampThreadsText` unit tests). |
| Token redaction | **CONTRACT_READY**. |
| **Live publication** | **NOT_TESTED / deliberately disabled.** No real Threads post was made. |
| **Long-lived token refresh** | **BLOCKED** — needs a real Threads app + user. |

---

## 4. Telegram Bot API — **VERIFIED / NOT_TESTED**

**Source fetched:** `core.telegram.org/bots/api` (Bot API reference).

### Confirmed integration contract

- **Base:** all calls over **HTTPS** to `https://api.telegram.org/bot<token>/METHOD_NAME`.
  GET and POST supported; params via query, form-urlencoded, JSON, or multipart.
- **Response envelope:** always has `ok: bool`; on failure also `description`,
  `error_code`, and optional `parameters` (e.g. `retry_after`).
- **Methods used:** `sendMessage`, `getMe` (verification), `getUpdates`/`setWebhook`.
- **Bot token** is obtained from **@BotFather**; recipient is a `chat_id`.

### Notification requirements mapping

| Required behaviour | Implementation |
|---|---|
| Success reports | `kind: publish_success` → ✅ icon + lines + post link. |
| Failure / partial success | `publish_failure` (❌) / `publish_partial_success` (🟡). |
| Link to published post | `links[]` rendered as `label: url` lines. |
| Affiliate product link | included in `links[]`. |
| Error details | `errorDetail` (pre-redacted) rendered under "Detail error:". |
| Notification retries | `TelegramNotificationError` is `retryable:true`; the job runner owns backoff. |
| Duplicate prevention | `dedupeKey` — same key is delivered **once**; LRU-bounded set. |

### Secrets

- The bot token is never logged: it is fully masked under any `*token*` key and
  by the Telegram-token value pattern in `redact.ts`.
- **No real Telegram message is sent by automated tests.** The default transport
  is in-memory (`MemoryTelegramTransport`); live sends require both credentials
  **and** an explicit `allowLive` flag.

### Test status

| Aspect | Status |
|---|---|
| Message formatting (all kinds) | **CONTRACT_READY**. |
| Duplicate suppression | **CONTRACT_READY**. |
| Retryable error surfacing | **CONTRACT_READY**. |
| **Live `getMe` verification** | **BLOCKED** — no bot token in this environment. |
| **Live `sendMessage`** | **NOT_TESTED** — intentionally disabled (no unauthorized messages). |

---

## 5. Candidate Image-Generation & Language-Model APIs — **CONTRACT_READY (mock) / live NOT_TESTED**

No provider was selected or paid for in Part 1, per the "do not incur paid API
costs" rule. The architecture is **provider-agnostic** via `ImageGenerator` and
`CaptionGenerator` contracts.

### Candidate providers to evaluate (decision deferred to a later part)

| Provider | Image | Text | Notes for evaluation |
|---|---|---|---|
| OpenAI | ✔ (`gpt-image-*`) | ✔ | Mature APIs, per-image + per-token pricing. |
| Google | ✔ (Gemini/Imagen) | ✔ | Strong value; region/availability to confirm. |
| Stability / others | ✔ | ✘ | Image-only; would need a second text vendor. |

Selection criteria (locked): **quality, cost, API availability, reliability.**
None was benchmarked here — **NOT_TESTED**.

### How actual product reference images will be supplied

1. The feed row provides `imageUrl` (the real marketplace product photo).
2. The importer stores it on the product record.
3. The image-generation step passes it as `referenceImageUrls[]` to whichever
   provider supports image-to-image / reference conditioning.
4. If the chosen provider cannot accept references, the prompt must instead be
   built from structured product facts (name, category) — and the fidelity gate
   below becomes even more important.

### How image fidelity will be evaluated (plan)

- **Automated gates (implemented in `content-validation.ts`):** non-empty bytes,
  ≤ 8 MB, JPEG/PNG only, ≥ 320 px minimum dimension, vertical-bias warning,
  10:1 aspect-ratio limit. These match the published Facebook/Threads constraints.
- **Human/visual gate (deferred):** side-by-side compare of generated image vs.
  the real product photo for packaging accuracy, readable label text, correct
  colourway, natural hand anatomy, soft lighting, commercial composition.
  A failed visual gate must block publication the same way an automated error does.

### Test status

| Aspect | Status |
|---|---|
| Deterministic image mock (real PNG bytes, seeded) | **CONTRACT_READY**. |
| Deterministic Indonesian caption mock (no fabrication) | **CONTRACT_READY**. |
| Cost reporting field plumbing | **CONTRACT_READY** (mock reports $0.00). |
| **Live image generation** | **NOT_TESTED / BLOCKED** — no provider key; no cost incurred. |
| **Live caption generation** | **NOT_TESTED / BLOCKED** — no provider key. |

---

## 6. S3-Compatible Object Storage — **CONTRACT_READY (mock) / live NOT_TESTED**

### Requirement driving this integration

Facebook (`picture`/`thumbnail`) and Threads (`image_url`) both need a **publicly
cURL-able URL** for the generated image. Generated images therefore must land in
object storage with public read, and the app must be able to verify that URL is
reachable before publishing.

### Providers (wire-compatible with the S3 REST API)

AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO, Backblaze B2. All expose the
same core operations, so one adapter covers them; only `S3_ENDPOINT`,
`S3_REGION`, `S3_BUCKET`, keys and path-style flag change.

### Contracts defined (`ObjectStorage`)

| Operation | Contract |
|---|---|
| `upload` | key + bytes + contentType + publicRead + metadata → `StorageObjectMeta`. |
| `head` | metadata without body; `null` when absent. |
| `verifyPublicAccess` | confirms the object is reachable over its public URL. |
| `delete` | removes the object. |
| `publicUrlFor` | pure function; no network call. |

### Test status

| Aspect | Status |
|---|---|
| Upload success + metadata | **CONTRACT_READY** (in-memory mock). |
| Upload failure (typed `StorageError`) | **CONTRACT_READY** (deterministic failure key). |
| Public-access verification (true/false) | **CONTRACT_READY**. |
| Deletion | **CONTRACT_READY**. |
| **Live S3 upload** | **NOT_TESTED / BLOCKED** — no S3 credentials; no cost incurred. |

> Even when S3 credentials are later supplied, Part 1's factory still returns the
> mock and reports `ready:false`, so no live storage call can occur until a live
> adapter is deliberately implemented in a later part.

---

## 7. Flutter ↔ Backend Authentication & Communication — **CONTRACT_READY**

### Chosen design

- **Transport:** HTTPS in production (documented; local dev uses HTTP against the
  emulator host alias `10.0.2.2`).
- **Auth boundary:** the operator issues a one-time **install key**. The APK
  exchanges it via `POST /v1/auth/token` for a **short-lived HS256 JWT**
  (`AUTH_ACCESS_TOKEN_TTL_SECONDS`, default 3600 s).
- **JWT claims:** `iss`, `aud`, `sub`, `iat`, `nbf`, `exp`, `scope`. Verified on
  every authenticated request (signature → algorithm → time → issuer → audience →
  scope). Implemented dependency-free with `node:crypto`.
- **Token storage on device:** `flutter_secure_storage` (Android Keystore-backed).
- **Automatic refresh:** the APK retries once on HTTP 401 by re redeeming the
  stored install key.
- **Privileged calls never leave the backend** — the APK only calls `/health`,
  `/v1/auth/token`, `/v1/me`, `/v1/scheduler/status`, `/v1/queue/jobs`.

### CORS

Explicit allow-list from `CORS_ORIGINS`; wildcard `*` is rejected when
`NODE_ENV=production`. (The APK uses a native HTTP client, so browser CORS mainly
affects any future web tooling.)

### Test status

| Aspect | Status |
|---|---|
| Token issuance (valid/invalid key) | **CONTRACT_READY** (API contract tests). |
| 401 on missing/malformed/tampered/wrong-aud/expired token | **CONTRACT_READY**. |
| 403 on insufficient scope | **CONTRACT_READY**. |
| Secret-leak canary across endpoints | **CONTRACT_READY**. |
| Flutter model parsing of backend JSON | **CONTRACT_READY** (8 Flutter tests). |
| Flutter analyze | **PASS** (0 issues). |
| **Real device + HTTPS + real install key** | **NOT_TESTED** — requires a deployed backend and TLS. |

---

## 8. Feasibility Summary

| # | Service | Requirements verified | Contract tests | Live status | Primary blocker |
|---|---|---|---|---|---|
| 1 | Shopee Affiliate feed | ❌ docs unreachable | ✅ CSV+XLSX parse/dedup | **BLOCKED** | No feed sample / no official API doc |
| 2 | Facebook Page publish | ✅ official docs | ✅ request shape + redaction | **NOT_TESTED** | No Page token; live disabled by design |
| 3 | Threads image publish | ✅ official docs (4 pages) | ✅ 2-step flow + 500-char clamp | **NOT_TESTED** | No Threads app/token; live disabled |
| 4 | Telegram Bot | ✅ official docs | ✅ format + dedupe + retry | **NOT_TESTED** | No bot token; sends disabled in tests |
| 5 | AI image/text | ⚠️ candidates only | ✅ deterministic mocks | **NOT_TESTED** | No provider key; no cost incurred |
| 6 | S3-compatible storage | ✅ contract defined | ✅ upload/head/verify/delete | **NOT_TESTED** | No S3 credentials; live adapter deferred |
| 7 | APK ↔ backend auth | ✅ design + JWT implemented | ✅ full auth matrix | ✅ local verified | HTTPS/deployment deferred |

**Bottom line:** every provider-neutral contract compiles and is covered by
credential-free tests. **No live third-party call was made and no real post,
message, or paid API usage occurred.** Live compatibility for Facebook, Threads,
Telegram, AI and S3 remains **NOT_TESTED**; Shopee live feed is **BLOCKED**.
