# PART 9A — Android Local-Device Compatibility Audit (No VPS)

**Question answered:** can the Shopee Affiliate Autopilot backend, scheduler,
queue and asset-storage abstraction operate on an Android device (Termux)
without a VPS — and if so, in exactly which mode?

**Baseline:** PART 9 commit `6cd405c`. This audit inspects that exact tree;
nothing in PART 9A changes backend behaviour. One focused Android
compatibility fix was required on the app side (§2.1) — everything else is
documentation.

**Status legend** (strict, §8 of the PART 9A brief): **PASS** = executed and
verified here (on the PC development host) · **FAIL** · **BLOCKED** = a
prerequisite is missing · **NOT_TESTED** = deliberately not executed ·
**DOCUMENTED_ONLY** = procedure shipped, no Android runtime was available to
verify it. **No part of this audit was executed on an Android device** — the
device-facing sections are DOCUMENTED_ONLY by definition, and the evidence
document records exactly which claims rest on which.

---

## 1. Inspection findings (actual repository, `6cd405c`)

### 1.1 Node.js runtime

- `backend/package.json` declares `engines.node >= 20.11.0`. Termux's `nodejs`
  package targets current Node LTS/current (22/24.x) on `aarch64`/`arm`/`x86_64`
  — satisfies the constraint. No Android-specific Node patching is required:
  the backend uses only POSIX APIs (`node:fs`, `node:crypto`, `node:net` via
  postgres.js), no `cluster`, no native addons.

### 1.2 Dependencies — the make-or-break question for Termux

Full inventory from `package-lock.json`:

| Category | Packages | Android status |
|---|---|---|
| Runtime dependencies | `fastify`, `@fastify/cors`, `dotenv`, `drizzle-orm`, `papaparse`, `pino`, `postgres` (postgres.js), `xlsx`, `zod` | **All pure JavaScript. Zero install scripts, zero native code.** |
| Build/test toolchain binaries | `esbuild` ×4 copies (0.18.20 / 0.25.12 / 0.28.2) | Lockfile pins official `@esbuild/android-arm64` (and `android-arm`) optional packages → tsx/vite/vitest have Android prebuilds |
| Build/test toolchain binaries | `rollup` (via vite) | Lockfile pins `rollup-android-arm64` **and** `rollup-android-arm-eabi` → native rollup has Android prebuilds |
| Install-script packages | 8 × `@embedded-postgres/*` (dev-only, from `embedded-postgres`) | **No Android build exists** (darwin/linux/windows only). Optional platform packages: npm skips them on Android; only `npm run test:db` (PC-only embedded cluster) would care |
| Install-script packages | `fsevents` | macOS-only optional — skipped everywhere else |

Consequences:

- **Runtime install on the device is clean:** `npm ci --omit=dev` installs only
  pure-JS runtime dependencies — no compilers, no ABI questions.
- **Tooling (`tsx`, `vitest`, `tsc`, `eslint`) is expected to work** on Termux
  arm64 because every native component ships Android prebuilds. This is
  *lockfile evidence*, classified DOCUMENTED_ONLY until run on a device; the
  runbook does not depend on it (the production path uses plain `node`).
- `npm run test:db` (embedded PostgreSQL cluster, PowerShell launcher,
  `@embedded-postgres/linux-*` glibc binaries) is **PC-only** — not portable to
  Android, and not needed there.

### 1.3 Build output and startup command

- Production build: `npm run build` → `tsc -p tsconfig.build.json` →
  `dist/src/main.js` (verified in PART 9). Start with **`node dist/src/main.js`**
  — no `tsx`, no bundler, no dev dependency at runtime.
- Every CLI (`db-migrate`, `db-status`, `db-verify`, `db-backup`, `db-restore`,
  `preflight`, …) compiles to `dist/src/cli/*.js` and can be invoked as
  `node dist/src/cli/<name>.js` on the device, even though the `package.json`
  convenience scripts use `tsx` (PC convenience only).
- `MIGRATIONS_FOLDER` resolves by walking up to `drizzle/meta/_journal.json`
  (PART 9 fix) — independent of `cwd` and of the src/dist layout, so migrations
  ship with the source tree on-device.

### 1.4 PostgreSQL driver and connection requirements

- Driver is **postgres.js — pure JavaScript** over TCP; no `pg-native`, no
  `libpq`, nothing to compile. It works on any platform Node works on,
  including Android.
- Connection options (`src/db/client.ts`): idle timeout 30 s, max lifetime
  300 s, `prepare:false`, pool bounds from `DATABASE_POOL_MIN/MAX` (defaults
  0/5 — deliberately small for a phone).
- TLS to a remote PostgreSQL: postgres.js honours `?sslmode=require` in the
  connection URL with no code change. CA-pinned `verify-full` would need the
  `ssl.ca` option wired through `createDatabase` (currently not exposed) —
  documented limitation, not silently claimed.
- `PERSISTENCE_BACKEND` (`src/core/env.ts`): production **requires**
  `postgres`; `file`/`memory` are development-only and the env validator
  rejects anything else under `NODE_ENV=production`. This invariant is
  preserved untouched — a phone without reachable PostgreSQL cannot run
  production mode, by design.

### 1.5 Scheduler / worker process model

- One Node process: Fastify API + `ContentScheduler` interval loop (60 s
  default tick) + ops-evaluation loop. No daemonizing, no separate worker
  binary, no `systemd` requirement — Termux runs it as a foreground process
  (or under `termux-services`).
- PostgreSQL mode serializes schedulers via advisory tick locks, jobs via
  leases, and daily output via a transactional cap — duplicate processes are
  safe but pointless on one phone.
- In-memory mode (no `DATABASE_URL`, development): queue is RAM-only, so a
  killed process loses queued jobs. **Restart-recovery can only be demonstrated
  with PostgreSQL.**

### 1.6 File-system and atomic-write assumptions

- `src/core/atomic-file.ts`: temp file + `rename()` with a bounded retry for
  Windows transient codes. POSIX rename is atomic on the same filesystem;
  Termux app-private storage (`~/...`) is ext4/f2fs — fully compatible, and the
  Windows retry path is simply never triggered.
- Paths are built with `path.join`/`fileURLToPath` throughout; no hardcoded
  `\` separators, no `/tmp` reliance, no permission-sensitive locations. The
  dev `data/` directory is `process.cwd()/data` (development-only file store).
- No file locks are used anywhere (leases and locks live in PostgreSQL).

### 1.7 Signals and shutdown

- `src/app/lifecycle.ts`: SIGTERM/SIGINT → stop new work → drain in-flight
  ticks under `SHUTDOWN_GRACE_MS` (default 20 s, hard deadline +15 s) → exit 0
  (or forced exit 1). Verified live in PART 9; signal delivery works in any
  Termux foreground session (`Ctrl+C`, `kill -TERM`). Android adds no new
  signal semantics — the risk is *process death without signal* (§6), which the
  existing crash-recovery (lease requeue at boot) already tolerates.

### 1.8 Object storage

- S3-compatible adapter is pure JS (SigV4 via `node:crypto`, PART 9 tests
  include the published AWS known-answer vector) — works wherever Node works.
- The file-storage adapter is development-only (`ObjectStorage` factory only
  returns it outside production, and production requires the complete S3
  credential set or fails closed). No persistence is claimed from local FS.

### 1.9 Verification commands

All transport-agnostic and device-runnable where noted:

| Command | On Termux | Notes |
|---|---|---|
| `GET /health`, `GET /ready` | yes (`curl` from the device itself) | liveness vs readiness split (PART 9) |
| `node dist/src/cli/preflight.js` | yes | read-only, enables nothing |
| `npm run smoke:providers` / `smoke:telegram` | not applicable | require `LIVE_SMOKE_*` credentials by design (BLOCKED on PC too) |
| `npm test` (vitest) | expected yes (Android prebuilds), unverified | run on PC for the release gate |
| `npm run test:db` | **no** — PC-only embedded cluster | remote-PG integration possible in principle, not wired |

---

## 2. Compatibility classification

### 2.1 The one concrete incompatibility found — Android cleartext policy (FIXED in PART 9A)

The app's default backend URL is `http://10.0.2.2:8080` and the on-device
topology is `http://127.0.0.1:8080` — both **plain HTTP**. Android 9+
(`targetSdk = flutter.targetSdkVersion`, currently 35/36) blocks *all*
cleartext traffic by default, **including loopback**, and the manifest had no
exception. The on-device app could therefore never have reached a Termux
backend. This is a real incompatibility requiring a code change, fixed in the
most narrow release-safe way:

- new `app/android/app/src/main/res/xml/network_security_config.xml` —
  cleartext permitted **only** for `127.0.0.1`, `localhost`, `10.0.2.2`;
  `base-config` keeps cleartext **blocked** for everything else;
- `AndroidManifest.xml` references it via `android:networkSecurityConfig`.

Production posture is unchanged: production terminates TLS at nginx and the
backend requires `https://` `PUBLIC_URL`; this config only unblocks loopback
and emulator-host HTTP used by local-device validation. Verified by the debug
APK build (evidence doc); runtime behaviour on a phone is DOCUMENTED_ONLY.

### 2.2 Component classification table

| Component | Classification | Evidence |
|---|---|---|
| Node.js ≥ 20.11 on Termux (arm64) | **Compatible** (with limitation: background execution, §5) | engines constraint vs Termux nodejs; POSIX-only API usage |
| Runtime npm dependencies (fastify/postgres.js/drizzle/pino/zod/xlsx/papaparse/dotenv) | **Compatible** | pure JS, no install scripts (lockfile) |
| `tsx` / `vitest` / `rollup` / `esbuild` toolchain | **Compatible — requires verification** | lockfile pins official `@esbuild/android-arm64` + `rollup-android-arm64`; DOCUMENTED_ONLY until run on device |
| `npm run test:db` (embedded PostgreSQL) | **Not supported on Android** | glibc-only `@embedded-postgres/linux-*` binaries + PowerShell launcher; PC-only by design |
| Build (`tsc`) + production start (`node dist/src/main.js`) | **Compatible** | pure-JS typescript; dist verified in PART 9 |
| PostgreSQL adapter (postgres.js) | **Compatible** (requires configuration: a reachable PG) | pure JS; `?sslmode=require` supported; `verify-full` needs `ssl.ca` wiring (limitation) |
| Production startup without PostgreSQL | **Correctly fails closed** — preserved | env validator: production ⇒ `postgres`; startup gate exit 78 |
| File/memory persistence adapters | **Development-only** (unchanged) | `PERSISTENCE_BACKEND` validator rejects non-postgres in production |
| Atomic file writes (`atomic-file.ts`) | **Compatible** | POSIX rename; no Windows-only assumptions leak |
| Signal handling / graceful shutdown | **Compatible** (in a Termux foreground session) | PART 9 live drill; `kill -TERM` semantics identical |
| S3-compatible storage (SigV4, pure JS) | **Compatible** (needs explicit configuration) | PART 9 unit suite incl. AWS known-answer vector |
| Scheduler under Android background policy | **Compatible with limitations — see §5** (the honest section) | doze/OEM killers terminate processes; catch-up bounds already tolerate gaps |
| Flutter APK ↔ Termux backend (loopback) | **Compatible after the §2.1 fix** | network-security-config; runtime DOCUMENTED_ONLY |
| `adb reverse` / LAN variants | **Compatible with limitations** | documented in the runbook; LAN needs one host line added to the config |
| PG inside Termux itself (proot-distro) | **Requires configuration; not recommended; untested** | no native PG for Android; proot overhead + manual pg_ctl — lab curiosity only |

---

## 3. Local-device architecture (smallest compatible topology)

```
┌──────────────── Android device ─────────────────┐
│  Flutter APK (dashboard UI)                     │
│     │  http://127.0.0.1:8080 (loopback)         │
│     ▼                                           │
│  Termux: node dist/src/main.js                  │
│     ├── PERSISTENCE_BACKEND=postgres            │
│     │        │ tls (sslmode=require)            │
│     │        ▼                                  │
│     │   Remote managed PostgreSQL  ◄── REQUIRED for production mode
│     └── S3-compatible bucket (optional, explicit)│
└─────────────────────────────────────────────────┘
```

- **UI:** the existing Flutter APK, `--dart-define=BACKEND_URL=http://127.0.0.1:8080`
  (or the default `10.0.2.2` on an emulator where the backend runs on the PC).
- **Backend:** one Node process in Termux, bound to `127.0.0.1:8080` — the app
  and backend share the device's loopback; **no LAN exposure, no ports opened
  to Wi-Fi** in the primary topology.
- **Database:** production mode requires the existing PostgreSQL adapter
  against a reachable server (remote managed PG over TLS is the supported
  option; §5). **No SQLite, no new database, no silent substitution.**
- **Dev/preview mode (explicitly development-only):** without `DATABASE_URL`,
  the existing code boots fully in memory/file mode with automation paused by
  default and publishing disabled — a credentials-free walkthrough mode, not a
  production deployment. Restart-recovery is not demonstrable in this mode.
- **Storage:** S3 adapter only when explicitly configured; otherwise assets are
  mock (development) — production fails closed on a missing credential set.

**Transport variants** (all documented in the runbook):

1. **Same-device loopback** (primary): backend in Termux, app on the phone →
   `127.0.0.1`. No ADB involved.
2. **Emulator**: app in the Android emulator, backend on the PC →
   `10.0.2.2:8080` (the emulator's alias for the host loopback) — the app's
   existing default.
3. **USB debugging**: backend on the PC, `adb reverse tcp:8080 tcp:8080`, app on
   the physical device → `127.0.0.1:8080` through the reversed tunnel.
4. **Same Wi-Fi LAN**: backend on the PC with `HOST=0.0.0.0`, app →
   `http://<pc-ip>:8080`; the device's host must be added to the
   network-security-config (one line, documented) — binding is a conscious
   choice; the backend still requires the install-key token for everything
   except `/health` and `/ready`.

---

## 4. Database strategy (§5 of the brief)

**Fact:** production mode on the phone fails closed (exit 78) without a
reachable, migrated PostgreSQL. PART 9A does not change that, and evidence
never claims production readiness without it.

Safe options, in order of recommendation:

1. **Remote managed PostgreSQL over TLS** (Neon / Supabase / Cloud SQL / RDS /
   any `postgres://` endpoint). Set `DATABASE_URL=postgres://…?sslmode=require`
   on the device env file; run `node dist/src/cli/db-migrate.js` once per
   release (advisory-locked, refuses drift). Small pool (0/5) is already the
   phone-appropriate default. *Backups:* the provider's PITR plus the
   repo-native `node dist/src/cli/db-backup.js` before every release migrate,
   per `part-09-backup-restore-runbook.md` (that runbook applies unchanged —
   the CLIs are the same code).
2. **A separately managed PostgreSQL instance you already operate** (home
   server, VPS) reachable over the phone's network/TLS tunnel — same
   mechanics as option 1.
3. **Development/preview mode** (no `DATABASE_URL`, `NODE_ENV=development`):
   existing, supported, credentials-free — automation paused by default,
   publishing disabled, queue in RAM. Backups and recovery drills are
   meaningless here (state is disposable) and the docs say so.
4. **PostgreSQL inside the phone via proot-distro** — technically possible
   (Debian arm64 userland ships PostgreSQL), not recommended: proot overhead,
   manual `pg_ctl` lifecycle, storage quirks, no battery benefit. Classified
   *requires configuration, untested*, and deliberately not part of the
   supported runbook.

---

## 5. Background-execution reality on Android (§6 of the brief)

This is the section where an honest answer matters more than a working demo:

- **Doze & app standby:** with the screen off and unplugged, Android defers
  network and CPU for background apps. Termux is a *foreground* app while a
  session is open, but after ~10 minutes in the background without a foreground
  service it becomes a candidate for freezing.
- **Battery optimization:** aggressive on many OEMs (Xiaomi, Huawei, Oppo,
  Samsung "adaptive"). Termux must be exempted (battery settings →
  "Unrestricted"/"No restrictions"), or it will be killed within hours.
- **Process termination:** Android kills background processes under memory/
  thermal pressure; some OEMs kill anything not on a whitelist. A killed Node
  process means *no ticks until restarted* — there is no guaranteed supervision
  equivalent to `systemd`'s `Restart=on-failure`.
- **Reboot:** nothing auto-starts by default. **Termux:Boot** (separate F-Droid
  app) runs `~/.termux/boot/start-backend.sh` after boot — an explicit,
  best-effort method, *not* a guarantee of continuous execution.
- **Network changes:** switching Wi-Fi/cellular changes reachability; a remote
  PG may be briefly unreachable. The backend handles this the PART 9 way:
  `/ready` degrades to 503, queries retry, the process does not exit; when the
  network returns, readiness recovers on the same process (verified live in
  PART 9 with a PostgreSQL outage).
- **Thermals/memory:** a 60 s interval loop is negligible load; the phone is
  not at risk from the workload, but sustained heat + low battery is exactly
  when Android kills background apps.
- **Power requirements:** to have any chance of staying alive, the device
  should be plugged in, battery-optimization exempt, with a Termux wake lock
  (`termux-wake-lock`) or `termux-services` running the process.

**What this means for scheduled posting:** the scheduler's four WIB windows,
the 3–4/day cap and the single-catch-up-per-tick bound already assume gaps are
normal (PART 6/8 semantics preserved untouched). If the process is dead at a
window's boundary, that slot ages into "overdue" and the *next* live tick
handles at most one catch-up slot — **never a burst, never more than the daily
cap**. What the phone cannot promise: on-time posting while asleep, offline,
powered off, or killed. Anyone needing exact-window reliability belongs on the
PART 9 VPS topology; the phone is a validation/demo/preview platform.

---

## 6. Safety-gate review (§7 of the brief)

- Facebook/Threads publishing: **disabled, untouched** — no publisher
  credentials exist on-device, and the allow-live latch is unchanged. Every
  slot ends `blocked` without a live destination, as in PART 4–9 evidence.
- `allowLive:false` and the preflight publishing gate: unchanged and not
  bypassed anywhere in PART 9A.
- Mock providers: the runbook boots with the default mock generation **in
  development mode with automation paused**, and says so explicitly; production
  mode still treats mock providers as a loud warning + ops event + preflight
  blocker (PART 9 behaviour preserved).
- Secrets: the runbook generates `APP_INSTALL_KEY` / `AUTH_JWT_SECRET` **on the
  device**, stores them in `~/autopilot/.env` (`chmod 600`), and instructs the
  user never to paste them into chat or commit them. Flutter receives only the
  backend URL at build time — no backend secret exists in the APK.
- Admin endpoints: keep install-key token auth (`POST /v1/auth/token`), never
  disabled; `/health` and `/ready` stay minimal; binding stays `127.0.0.1` in
  the primary topology.
- Nothing runtime (databases, backups, `.env`, generated assets) is committed;
  the PART 9A diff is reviewed for secrets before the commit (evidence doc).

---

## 7. Verdict

**Yes — with PostgreSQL reachable, the existing backend runs on an Android
device via Termux with zero backend code changes.** The runtime dependency
surface is pure JavaScript, the toolchain ships Android prebuilds, the
filesystem and signal assumptions are POSIX-clean, and every production
guarantee (fail-closed startup, real migrations, graceful shutdown, storage
abstraction, publishing disabled) carries over unchanged. Two honest caveats
define the result: (1) the Android cleartext policy needed one narrow,
release-safe app fix (shipped in PART 9A); (2) Android's background-execution
policy makes the phone a **validation/preview platform, not an always-on
scheduler** — the VPS topology in `part-09-deployment-runbook.md` remains the
production answer, and no document in this repository pretends otherwise.
