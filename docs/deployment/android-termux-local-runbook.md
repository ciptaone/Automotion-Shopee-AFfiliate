# Android Local-Device Runbook — Termux (No VPS)

Run the Shopee Affiliate Autopilot backend **on the phone itself**, in Termux,
with the existing Flutter APK as the dashboard. This is the local-device
validation path (PART 9A). It is **not** a replacement for the production VPS
topology in `docs/implementation/part-09-deployment-runbook.md`.

**Status legend:** every step below is **DOCUMENTED_ONLY** — no Android device
was attached when PART 9A was written; the PC-side prerequisites each step
depends on (toolchain, tests, build output, gates) are PASS-recorded in
`docs/implementation/part-09a-android-local-evidence.md`. Commands use only
behaviour proven in that evidence; nothing here requires secrets in chat.

**Hard rules for this runbook**

- Facebook/Threads publishing stays **disabled** (no publisher credentials ever
  configured on-device; every slot ends `blocked`).
- No `.env` file is ever committed, and no key is pasted into chat. Generate
  secrets **on the phone** and keep them there.
- **Production mode (`NODE_ENV=production`) requires a reachable, migrated
  PostgreSQL** and will refuse to start (exit 78) without one. Nothing in this
  runbook weakens that.
- The demo/preview mode (step 8 option B) is explicitly **development-only**.

---

## 0. What you need

- An Android phone (arm64 — any recent phone) with ~1 GB free storage, or an
  Android emulator on your PC.
- Optional but recommended: a reachable PostgreSQL endpoint (managed cloud PG,
  or any server you operate) for the production-style mode.
- Optional: a PC with `adb` (for the USB-tunnel variant) and Flutter (to build
  the APK — the released debug APK from the PC works as-is).

## 1. Install Termux from a trustworthy source

- Install from **F-Droid** or the official GitHub releases
  (`termux/termux-app` releases). The Play Store build is abandoned and broken.
- Grant Termux notification/background permission if your OEM offers one, and
  exempt it from battery optimization now (Settings → Apps → Termux → Battery →
  **Unrestricted**). See §Background reality at the end.

```sh
pkg update && pkg upgrade
pkg install nodejs git openssh curl
node -v        # must print >= v20.11.0 (Termux ships 22/24.x — OK)
```

## 2. Get the repository onto the phone

```sh
# Option A: clone (needs a GitHub auth method — a fine-grained PAT as a
# git credential, or SSH via `ssh-keygen` + adding the key in GitHub):
git clone https://github.com/ciptaone/Automotion-Shopee-AFfiliate.git ~/autopilot
cd ~/autopilot

# Option B: transfer the tree from your PC without any GitHub credential:
#   PC>  cd <repo> ; tar -czf autopilot.tz app backend docs deploy
#   PC>  adb push autopilot.tz /sdcard/Download/
#   phone (Termux)>  tar -xzf /sdcard/Download/autopilot.tz -C ~/autopilot --strip-components=1
```

The repository contains no secrets by construction — this transfer is safe.

## 3. Install runtime dependencies and build (pure JS, no compilers)

```sh
cd ~/autopilot/backend
npm ci --omit=dev          # runtime deps only — all pure JavaScript

# Build the production output. tsc is pure JS but needs its types:
npm install --no-save typescript@5.9.3 @types/node@24
npx tsc -p tsconfig.build.json
ls dist/src/main.js        # the production entrypoint
```

Alternative: build `dist/` on your PC (`cd backend && npm ci && npm run build`)
and `adb push dist ...` into `~/autopilot/backend/dist`. Both produce the same
`node dist/src/main.js` runtime.

> Dev tooling note: `tsx`, `vitest`, `rollup` and `esbuild` all ship official
> Android arm64 prebuilds in this lockfile (see the audit doc §1.2), so the PC
> test suite is *expected* to run on-device too. It is not required by this
> runbook, and it is not claimed as verified.

## 4. Configure the environment (non-secret values now; secrets generated on-device)

```sh
mkdir -p ~/autopilot-data && cd ~/autopilot/backend
cat > .env <<'EOF'
# ---- PART 9A Termux local-device profile (development/preview) ----
NODE_ENV=development
HOST=127.0.0.1
PORT=8080
PUBLIC_URL=http://127.0.0.1:8080
LOG_LEVEL=info
SCHEDULER_ENABLED=false
# Production-style mode only (uncomment and fill if you have a PostgreSQL):
# DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/autopilot?sslmode=require
# PERSISTENCE_BACKEND=postgres
EOF
chmod 600 .env
```

Now generate the two secrets **on the phone** (never typed by hand, never
shared):

```sh
cd ~/autopilot/backend
printf 'AUTH_JWT_SECRET=%s\n' "$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-48)" >> .env
printf 'APP_INSTALL_KEY=%s\n' "$(head -c 32 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-32)" >> .env
chmod 600 .env
```

For the production-style mode you also need the S3 credential set and
`SECRETS_ENCRYPTION_KEY` (production refuses to boot without them) — copy the
key *names* from `backend/.env.production.example` and store the values with
the same on-device discipline. Never commit this file.

## 5. Optional: run the PC test gates on the phone

```sh
cd ~/autopilot/backend
npm install --no-save typescript@5.9.3 @types/node@24 eslint@9 typescript-eslint@8 vitest@3
npx tsc -p tsconfig.json --noEmit   # typecheck
npx vitest run                      # unit + contract suites
```

`npm run test:db` (embedded PostgreSQL cluster) is **PC-only** — its launcher
and glibc binaries do not exist for Android; skip it on the phone.

## 6. Start the backend (publishing disabled by construction)

**Option A — production-style mode (requires `DATABASE_URL` above):**

```sh
cd ~/autopilot/backend
# Release migration — EXPLICIT, once per release (advisory-locked, refuses drift):
node dist/src/cli/db-migrate.js
node dist/src/cli/db-verify.js
node dist/src/main.js
```

**Option B — development/preview mode (no PostgreSQL; disposable state):**

```sh
cd ~/autopilot/backend
node dist/src/main.js
```

In option B the app boots fully in memory/file mode, automation is seeded
`paused` (because `SCHEDULER_ENABLED=false`), providers are mock, and
`/health` reports PostgreSQL `not_configured`. This is the credentials-free
walkthrough mode; it makes **no** production claims and loses queued jobs on
restart (queue is RAM).

Expected log line either way: `backend listening on http://127.0.0.1:8080`.

## 7. Verify liveness and readiness

From the phone itself (Termux):

```sh
curl -s http://127.0.0.1:8080/health   # -> "status":"ok","part":1
curl -s http://127.0.0.1:8080/ready    # option A -> {"status":"ready",...}
                                       # option B -> ready (database "not_configured" is fine in dev)
```

`/health` is liveness (200 while the process runs, even during a database
outage). `/ready` is readiness (200 only when the database is reachable and
the schema is consistent — production semantics). A production boot without
PostgreSQL never reaches this point: it exits 78 before serving.

## 8. Scheduler smoke in mock mode (mock providers, no live calls)

Automation is **paused** until you start it. This smoke is read-only plus the
start/pause controls — it performs no AI calls beyond mocks and **never
publishes** (no Facebook/Threads destination is configured, so executed slots
end `blocked`):

```sh
cd ~/autopilot/backend
# 1. Mint a device token with the install key you generated in step 4:
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/v1/auth/token \
  -H 'content-type: application/json' \
  -d "{\"installKey\":\"$(grep APP_INSTALL_KEY .env | cut -d= -f2)\",\"deviceLabel\":\"termux-smoke\"}" \
  | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
test -n "$TOKEN" && echo "token minted" || echo "TOKEN FAILED"

# 2. Read-only checks:
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:8080/v1/settings
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:8080/v1/scheduler/status

# 3. Start automation (seeds a real scheduler tick; mock generation only):
curl -s -X POST -H "authorization: Bearer $TOKEN" http://127.0.0.1:8080/v1/automation/control \
  -H 'content-type: application/json' -d '{"action":"start"}'

# 4. Watch the Termux log for a tick line, then pause again:
#    "content scheduler tick: Tick complete: ..." — catch-up is bounded to 1
#    slot per tick and the daily cap always holds.
curl -s -X POST -H "authorization: Bearer $TOKEN" http://127.0.0.1:8080/v1/automation/control \
  -H 'content-type: application/json' -d '{"action":"pause"}'
```

You should see no `error`-level log lines, and any executed slot recorded as
`blocked` — proof that the publishing gate held.

## 9. Queue recovery after a controlled restart (production-style mode only)

This drill needs PostgreSQL (option A) — the queue is durable there:

```sh
# 1. With automation running and a slot enqueued, stop the backend gracefully:
kill -TERM <pid>        # expect: "shutdown signal received" ... "shutdown complete", exit 0

# 2. Start it again:
node dist/src/main.js
#    Boot log proves recovery: "appliedMigrations":N,"requeuedJobs":0,"failedJobs":0
#    A job whose lease expired while the process was down is requeued automatically;
#    the anti-duplicate lease semantics are covered by the repository's DB suite.
```

In development/preview mode (option B) this drill is **not possible** — the
queue is in RAM by design. The equivalent guarantees are the PC-side
integration suite (`tests/db/job-queue.test.ts`, restart-recovery tests) —
PASS evidence in the evidence doc.

## 10. Flutter APK against the on-device backend

```sh
# On your PC — build once, no secrets in the APK (only the backend URL):
cd app
flutter build apk --debug --dart-define=BACKEND_URL=http://127.0.0.1:8080
adb install -r build/app/outputs/flutter-apk/app-debug.apk
```

The app and the Termux backend share the device's loopback, so no ADB, LAN or
internet exposure is involved. This works because PART 9A ships an Android
**network-security-config permitting cleartext only to `127.0.0.1`,
`localhost` and `10.0.2.2`** — every other host stays blocked. In the app,
enter the same `APP_INSTALL_KEY` (typed on-device, never pasted from chat) to
mint the session.

**Variants**

- *Emulator (backend on the PC instead):* use the app default
  `http://10.0.2.2:8080`.
- *Physical device, backend on the PC, USB:* `adb reverse tcp:8080 tcp:8080`,
  app URL `http://127.0.0.1:8080`.
- *Same Wi-Fi LAN:* start the PC backend with `HOST=0.0.0.0`, use
  `http://<pc-ip>:8080`, and add that host to
  `app/android/app/src/main/res/xml/network_security_config.xml` before
  rebuilding. The API still demands the install-key token for everything
  except `/health` and `/ready`.

## 11. Stop the backend safely

```sh
kill -TERM <pid>     # graceful: stop new work -> drain in-flight ticks
                     # (SHUTDOWN_GRACE_MS, default 20 s) -> exit 0
```

Or `Ctrl+C` in the Termux session. Never `kill -9` unless the process is truly
wedged — the queue tolerates it (leases expire and requeue) but you lose the
graceful drain.

## 12. Best-effort auto-start (not a guarantee)

```sh
pkg install termux-boot   # separate F-Droid app, same developer
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/start-autopilot.sh <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd ~/autopilot/backend && node dist/src/main.js >> ~/autopilot-data/backend.log 2>&1 &
EOF
chmod 700 ~/.termux/boot/start-autopilot.sh
```

After a reboot (and with battery optimization disabled), Termux:Boot starts the
backend. **This is best-effort**: Android may still kill the process; there is
no systemd equivalent.

## Background reality — read this before trusting the phone

- **Doze, standby, OEM killers:** with the screen off, Android defers or kills
  background work. Exempt Termux from battery optimization, keep it plugged
  in, and use `termux-wake-lock`. Even then, *some* OEMs will kill it.
- **No on-time guarantee:** if the process is dead at a posting window, that
  slot ages to "overdue" and the next live tick handles **at most one**
  catch-up slot — never a burst, never above the daily cap (3–4/day, four WIB
  windows — semantics unchanged from PART 6/8). Exact-window posting while
  asleep/offline/powered-off is impossible on any platform; on a phone it is
  additionally at the mercy of Android.
- **Network flaps:** switching networks makes a remote PostgreSQL briefly
  unreachable. The PART 9 behaviour applies: `/ready` → 503, in-process
  retries, no crash, readiness returns on recovery (live-verified in PART 9).
- **Reboot:** nothing restarts without Termux:Boot, and even that is
  best-effort.

## Local development vs production operation

| | This runbook (local device) | Production (`part-09-deployment-runbook.md`) |
|---|---|---|
| Process supervision | Termux foreground / Termux:Boot (best-effort) | systemd (`Restart=on-failure`, `RestartPreventExitStatus=78`) |
| TLS | loopback HTTP (app ↔ Termux on one device) | HTTPS at nginx; `PUBLIC_URL` must be `https://` |
| Database | remote PG over `sslmode=require`, **or dev memory/file mode** | PostgreSQL mandatory; production fails closed without it |
| Backups | repo-native `db:backup` before release migrates (per `part-09-backup-restore-runbook.md`); dev mode has nothing to back up | pg_dump + drill runbook |
| Reliability | validation / demo / preview — gaps tolerated by design | always-on scheduling target |
| Publishing | disabled (no credentials, gate intact) | disabled until a separately reviewed change enables it |

## Troubleshooting

- **`curl: (7) Failed to connect`** — the backend exited. Check the log;
  production mode exits 78 with a secret-free `problems` list when PostgreSQL
  or the schema is unavailable (that is the gate working, not a crash).
- **`CLEARTEXT communication not permitted`** from the APK — you are using a
  host outside `127.0.0.1`/`localhost`/`10.0.2.2`; add it to the
  network-security-config and rebuild (step 10 variants).
- **`npm ci` fails** — make sure you used `--omit=dev` (the dev-only
  `embedded-postgres` package has no Android build and is not needed).
- **Backend healthy but the app cannot sign in** — the install key in the app
  must be the one generated in step 4 on this device; regenerate both together
  if in doubt.
