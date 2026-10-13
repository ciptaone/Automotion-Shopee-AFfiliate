# PART 9A — Evidence (Android Local-Device Validation, No VPS)

**Baseline:** PART 9 commit `6cd405c` (approved). Executed 2026-10-14 on the
PC development host (Windows, Node 24.15.0, Flutter).

**The single most important fact in this document:** **no Android device or
emulator was attached during PART 9A.** Every claim about Android runtime
behaviour is **DOCUMENTED_ONLY**, derived from repository evidence (lockfile
binaries, POSIX-only API usage, platform policies) and labelled as such. Every
**PASS** below was executed on the PC. The runbook
(`docs/deployment/android-termux-local-runbook.md`) is written so its first
on-device execution is the moment the DOCUMENTED items convert to PASS/FAIL.

**Status legend (strict):** PASS = executed & verified here · FAIL · BLOCKED =
prerequisite missing · NOT_TESTED = not executed · DOCUMENTED_ONLY = procedure
shipped, runtime unverified on Android.

---

## 1. Inspection (§1 of the brief) — all PASS (executed on the PC tree)

| Check | Command / method | Result |
|---|---|---|
| Branch/HEAD/clean tree | `git branch`, `git log -1`, `git status` | **PASS** — `master` @ `6cd405c`, 0 uncommitted at inspection |
| Runtime dependency inventory | full `package-lock.json` analysis | **PASS** — runtime deps (`fastify`, `@fastify/cors`, `dotenv`, `drizzle-orm`, `papaparse`, `pino`, `postgres`, `xlsx`, `zod`) are **pure JS with zero install scripts** |
| Native/install-script packages | lockfile `hasInstallScript` scan | **PASS** — exactly 13: 8 × `@embedded-postgres/*` (dev-only; **no Android build exists**), 4 × `esbuild` copies, 1 × `fsevents` (macOS-only optional) |
| Android prebuilds in toolchain | lockfile scan | **PASS** — `@esbuild/android-arm64` pinned at **0.18.20, 0.25.12 and 0.28.2** (all four esbuild copies) and `rollup-android-arm64` + `rollup-android-arm-eabi` — tsx/vite/vitest/rollup carry official Android binaries |
| Build output & start command | PART 9 build + `tsconfig.build.json` | **PASS** — `npm run build` → `dist/src/main.js`; start = `node dist/src/main.js`; CLIs compile to `dist/src/cli/*.js` (no tsx needed at runtime) |
| PG driver | `src/db/client.ts` | **PASS** — postgres.js (pure JS TCP); pool 0/5 default; `?sslmode=require` via URL with no code change; CA-pinned `verify-full` **not wired** (`ssl.ca` not exposed) — documented limitation |
| Scheduler model | `src/scheduler/content-scheduler.ts`, container wiring | **PASS** — single in-process 60 s interval loop; PG advisory tick-lock + leases + daily cap; RAM queue without PG (restart drill impossible in dev mode) |
| FS/atomic-write assumptions | `src/core/atomic-file.ts` | **PASS** — temp + `rename()` (atomic on same FS: POSIX ✓, Android app-private storage ✓); Windows-retry path inert elsewhere; no `/tmp`, no file locks, `path.join` throughout |
| Signal handling | `src/app/lifecycle.ts` + PART 9 live drill | **PASS** — SIGTERM/SIGINT → bounded drain → exit 0; identical semantics under Termux |
| Storage abstraction | `ObjectStorage` factory + PART 9 S3 suite | **PASS** — S3 adapter pure JS (`node:crypto` SigV4, AWS known-answer vector); file adapter development-only; production fails closed on missing credential set |
| Health/readiness/preflight/smokes | routes + CLIs | **PASS** — `/health`, `/ready`, `preflight` are transport-agnostic; `smoke:providers`/`smoke:telegram` require `LIVE_SMOKE_*` by design (BLOCKED without credentials, on any platform) |
| Flutter transport surface | `app_config.dart`, `AndroidManifest.xml` | **PASS** — base URL via `--dart-define=BACKEND_URL` (default `http://10.0.2.2:8080`); **found: no cleartext exception** → on-device loopback HTTP was impossible (fixed, §2) |

## 2. The one code change — Android cleartext policy (focused, §8-allowed)

**Finding:** `targetSdk = flutter.targetSdkVersion` (≥ 28) blocks **all**
cleartext HTTP by default — including `127.0.0.1` — and the manifest had no
exception. The on-device topology (app ↔ Termux backend over loopback) could
never have worked. Backend had no equivalent issue (it is a plain TCP server).

**Fix (release-safe, minimal):**
- `app/android/app/src/main/res/xml/network_security_config.xml` (new) —
  cleartext permitted **only** to `127.0.0.1`, `localhost`, `10.0.2.2`;
  `base-config` keeps cleartext **blocked** for every other host.
- `AndroidManifest.xml` — one attribute:
  `android:networkSecurityConfig="@xml/network_security_config"`.

**Verification:** debug APK builds with the new resource (§4). Widget tests
and analysis unaffected. Runtime reachability on a phone: DOCUMENTED_ONLY.

## 3. Backend regression gates (§8 — rerun at `6cd405c`+docs, PASS)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **PASS** — exit 0 |
| Lint | `npm run lint` | **PASS** — exit 0 |
| Unit + contract | `npm test` | **PASS** — **44 files, 953/953** |
| PostgreSQL suite | `npm run test:db` | **PASS** — **11 files, 109/109**, `db:status` 6/6 no drift, `db:verify` clean |
| Build | `npm run build` | **PASS** — exit 0 (`dist/src/main.js`) |

No assertion changed or weakened in PART 9A; the backend source is untouched
(PART 9A touches only `app/android/**` and `docs/**`).

## 4. Flutter gates (§8 — rerun with the PART 9A manifest change, PASS)

| Gate | Command | Result |
|---|---|---|
| Analyze | `flutter analyze` | **PASS** — 0 issues (195.1 s) |
| Tests | `flutter test` | **PASS** — **176/176** |
| Debug APK (with new network-security-config) | `flutter build apk --debug` | **PASS** — built `app-debug.apk` |

## 5. Android/Termux runtime — NOT executed

| Item | Status |
|---|---|
| Termux install, `npm ci --omit=dev`, on-device `tsc` build | **DOCUMENTED_ONLY** — runbook steps 1–3 |
| `node dist/src/main.js` on a device (both modes) | **DOCUMENTED_ONLY** — runbook steps 6–7 |
| Device-side curl smoke (token/settings/control) | **DOCUMENTED_ONLY** — routes verified to exist on the PC (`server.ts`), commands written against the same API the PC smoke exercised; runbook step 8 |
| Queue recovery drill on-device | **DOCUMENTED_ONLY** (needs PG) — runbook step 9; equivalent guarantees PASS on PC via `tests/db/job-queue.test.ts` + restart-recovery DB tests (in the 109) |
| `tsx`/`vitest` on Termux | **NOT_TESTED** — lockfile proves Android prebuilds exist; expected to work; not claimed |
| proot-distro PostgreSQL on-device | **NOT_TESTED / not recommended** — audit §4 option 4 |
| Live AI provider / Telegram calls | **BLOCKED / NOT_TESTED** — no credentials, by design, on any platform |
| Live Facebook/Threads publishing | **DISABLED** — no publisher credentials configured anywhere; allow-live latch unchanged |

## 6. Database & storage blockers (honest)

- **Production mode on the phone requires a reachable, migrated PostgreSQL.**
  Without `DATABASE_URL`, `NODE_ENV=production` refuses to boot (env validator
  + startup gate exit 78) — verified live in PART 9, unchanged in PART 9A. No
  substitute database was introduced; SQLite was never considered; the
  dev `memory`/`file` adapters remain development-only.
- The **only** supported on-device production-style path is a **remote
  PostgreSQL over `?sslmode=require`** (or an instance you already operate).
  CA-pinned `verify-full` would need a small `ssl.ca` wiring — listed as a
  limitation, not silently claimed as working.
- `test:db`'s embedded cluster is **PC-only** (glibc binaries + PowerShell
  launcher) — a known, accepted boundary.
- **S3**: works anywhere Node works (pure JS), but needs explicit credentials;
  production fails closed without the full set. Live bucket validation remains
  **BLOCKED** (no bucket), same as PART 9.

## 7. Diff & secret review (§10)

- PART 9A diff = 1 new XML resource, 1 manifest attribute, 3 documents.
  No backend code, no tests, no dependency, no migration changed.
- Secret-pattern scan (AWS keys, private keys, tokens, passwords) over the
  staged diff: **clean**. No `.env`, no runtime data, no generated assets, no
  build output staged. Placeholders only; the runbook generates secrets
  on-device and never prints or commits them.

## 8. Delivery

Recorded in the §14-style completion report: PART 9A committed separately on
top of `6cd405c` (PART 9 not amended), pushed after remote-history check,
verified via `git ls-remote`. Publishing remains disabled.
