# PART 9 — Production Deployment Runbook

**Scope:** bringing the Shopee Affiliate Autopilot backend from a merged
release to a running, monitored, recoverable production service — and taking
it down again without losing work. The Flutter APK is unchanged by this
runbook.

**Status legend** (PART 9 §10): every command below is either **tested in this
repository** against a local production-mode drill (labelled `[TESTED]`) or
**documented for the target host** (`[DOCUMENTED]`). No step here has been
executed against real cloud infrastructure, because none is attached to this
repository.

**Never-regress facts this runbook depends on**

- Live Facebook/Threads publishing is **disabled at the publisher allow-live
  latch** and is not enabled by anything in this file.
- Automation state defaults to `paused` on a fresh database (unless
  `SCHEDULER_ENABLED=true` seeds `running` — see §7).
- The four posting windows are `06/12/16/19:00-…:00 WIB`, target 3–4 posts/day.
- PostgreSQL is the only production persistence backend; the process **refuses
  to boot** without it (exit 78), and never falls back to memory/file/mock
  storage for jobs or assets.

---

## 1. Architecture deployed (§2, Topology A)

```
 phone / APK ──HTTPS──▶ nginx (TLS termination, 127.0.0.1:8080 proxy)
                             │
                             ▼
                  node dist/src/main.js   (single process: API + scheduler
                                           + ops loop; systemd managed)
                             │
             ┌───────────────┼──────────────────────┐
             ▼               ▼                      ▼
      PostgreSQL        S3-compatible          (no local state:
      (jobs, lease,     bucket (generated      everything durable lives
       settings,        images, durable)       in PG and the bucket)
       catalog, events)
```

One combined process is the documented topology. Duplicate schedulers are
**safe** even if you scale out: ticks serialize on a PostgreSQL advisory lock
(`autopilot_schema_migration` for releases; per-tick locks for the scheduler),
claims serialize on job leases, and daily output serializes on a transactional
cap. To split API from worker later, run the same image twice with
`SCHEDULER_ENABLED=false` on API replicas (Topology B, optional).

Artifacts in this repository:

| Artifact | Purpose |
|---|---|
| `deploy/systemd/shopee-autopilot.service` | systemd unit (graceful stop, crash-loop guard, hardening) |
| `deploy/nginx/shopee-autopilot.conf` | HTTPS reverse proxy template (placeholders only) |
| `backend/.env.production.example` | production environment template (placeholders only) |
| `backend/src/cli/db-migrate.ts` | release migration runner (`npm run db:migrate`) |
| `backend/src/cli/db-backup.ts` / `db-restore.ts` | repo-native backup/restore (see the backup runbook) |

## 2. Host prerequisites `[DOCUMENTED]`

- Ubuntu/Debian-like host (or any systemd host), unprivileged user `autopilot`
  (no sudo), Node.js ≥ 20.11 (24 LTS recommended), nginx with a certificate
  (certbot or equivalent).
- Managed PostgreSQL 14+ (17 recommended) on a **private network**, TLS on,
  a dedicated database and role, `pg_dump`/`pg_restore` client tooling
  installed on the host for the backup runbook.
- An S3-compatible bucket (AWS S3 / R2 / Spaces / MinIO / B2) with:
  a dedicated access key, and either a public-read bucket policy for the
  `generated/` prefix or a CDN in front (`S3_PUBLIC_BASE_URL`).
- The host firewall exposes **only 80/443**. PostgreSQL and the app port are
  never public.

## 3. First deployment `[DOCUMENTED]` (steps verified locally)

```bash
# 1. Code
sudo -u autopilot git clone https://github.com/ciptaone/Automotion-Shopee-AFfiliate /opt/shopee-autopilot
cd /opt/shopee-autopilot/backend
sudo -u autopilot npm ci
sudo -u autopilot npm run build          # emits dist/src/main.js (note: dist/src/, not dist/)

# 2. Environment — copy the template and fill in REAL values.
#    Root-owned, mode 0600, NEVER committed:
sudo install -d -m 700 -o autopilot /etc/shopee-autopilot
sudo -u autopilot cp .env.production.example /tmp/env.prod
sudoedit /tmp/env.prod                    # every CHANGE_ME placeholder MUST be replaced
sudo install -m 600 -o root -g root /tmp/env.prod /etc/shopee-autopilot/env
sudo shred -u /tmp/env.prod

# 3. Release migration — EXPLICIT, once per release, never at service start.
#    Refuses drifted databases; never drops/resets/recreates anything.
sudo -u autopilot env $(grep -v '^#' /etc/shopee-autopilot/env | xargs) npm run db:migrate
#    -> "RESULT: applied N migration(s) … consistent." (exit 0)
sudo -u autopilot env $(grep -v '^#' /etc/shopee-autopilot/env | xargs) npm run db:verify
#    -> "RESULT: live schema matches src/db/schema.ts." (exit 0)

# 4. Service
sudo cp deploy/systemd/shopee-autopilot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now shopee-autopilot

# 5. Probes — 200 ONLY when DB + schema are ready; a bad deploy fails closed
#    with exit 78 and systemd does NOT restart-loop it (RestartPreventExitStatus=78).
curl -fsS https://autopilot.example.com/ready   # {"status":"ready",...}
curl -fsS https://autopilot.example.com/health  # {"status":"ok","part":1,...}

# 6. Readiness checks BEFORE touching automation (this command enables nothing).
sudo -u autopilot env $(grep -v '^#' /etc/shopee-autopilot/env | xargs) npm run preflight
```

`[TESTED]` The boot/probe/migrate/drift-refusal/exit-78/ graceful-stop
sequence above was executed end to end in production mode against a local
PostgreSQL (see `part-09-evidence.md` §Drills), including the failure paths.

## 4. nginx + TLS `[DOCUMENTED]`

Adapt `deploy/nginx/shopee-autopilot.conf` (`server_name`, certificate paths)
and include it from `nginx.conf`; `nginx -t && systemctl reload nginx`.
Key invariants: `client_max_body_size 25m` (matches the Fastify body limit),
`proxy_read_timeout 600s` (matches the app request timeout), and the app
listens on `127.0.0.1` only.

## 5. Upgrades `[DOCUMENTED]`

```bash
# Per release: build first, migrate second, restart last. Never in parallel on
# two hosts without the advisory lock (the runner serializes anyway).
sudo -u autopilot git fetch && git checkout <tag>
sudo -u autopilot npm ci && sudo -u autopilot npm run build
sudo -u autopilot env … npm run db:migrate    # "already current" is a valid outcome
sudo systemctl restart shopee-autopilot
curl -fsS https://autopilot.example.com/ready
```

The process **stops taking readiness** the moment it receives SIGTERM
(`/ready` → 503 `stopping`), drains in-flight scheduler/job work within
`SHUTDOWN_GRACE_MS` (default 20 s, hard deadline +15 s), then exits 0.

## 6. Rollback `[DOCUMENTED]`

- Code rollback: `git checkout <previous tag> && npm ci && npm run build &&
  systemctl restart`. The previous build boots only if its schema is
  compatible — the startup gate reads the SAME journal, so a database migrated
  FORWARD past the old release reports `diverged/unknown` and refuses (exit 78).
- Schema rollback: **forward-fix only.** Migrations are never edited or
  dropped; to undo a schema change, ship a new forward migration. If data must
  be rolled back, restore the pre-release backup into an **isolated** database
  first and re-run the restore drill (backup runbook §5) — never restore
  destructively over production.

## 7. Operational semantics you should know

- **Automation seed** (`container.ts`): a database with no settings row seeds
  `automationState` from `SCHEDULER_ENABLED` (`true` → `running`, else
  `paused`). To ship the first release paused, deploy with
  `SCHEDULER_ENABLED=false` and flip it on in `/v1/settings` after preflight.
- **Scheduler ticks** no-op while paused, are bounded to one catch-up slot per
  tick (`maxCatchUpPerTick=1`), and can never exceed the daily target.
- **Publishing gate**: generation can progress to `publish_ready`/`blocked`;
  with no live-configured destination, slots end `blocked` — nothing publishes.
- **Mock generation in production**: allowed at boot (so the API can be
  exercised with automation paused) but LOUD — a startup warning, a persistent
  `production_mock_providers` ops event, and a preflight blocker. Select real
  providers (workspace settings or `AI_*` env defaults) before enabling
  automation.
- **Ops events** deduplicate by fingerprint (`occurrences` grows, no storm) and
  record `process_started`, `startup_failed` (critical), `shutdown_timeout`,
  `migration_pending` (drift while running) and `production_mock_providers`.
- **Secrets** live only in `/etc/shopee-autopilot/env` (0600) and in
  PostgreSQL-encrypted provider secrets (`SECRETS_ENCRYPTION_KEY`, backed up
  SEPARATELY — a restored DB without the key keeps provider secrets locked).

## 8. Monitoring & alerts `[DOCUMENTED]`

| Signal | Where | Expected |
|---|---|---|
| Liveness | `GET /health` | always 200 while the process runs (even during a DB outage) |
| Readiness | `GET /ready` | 200 = DB reachable + schema consistent + not draining; 503 = do not send work |
| Restart loop | systemd journal | none; exit 78 repeats must be investigated, not restarted |
| Schema drift while running | ops event `migration_pending` (warning) | investigate, deploy a release migrate |
| Storage failures | ops events + `/v1/ops/health` | S3 errors are retry-bounded (≤3 attempts), then surfaced |
| Telegram failures | ops event delivery status | never recurses; `not_configured` is a valid outcome |

Alert on: `/ready` 503 > 2 min, any `critical` ops event, repeated
`startup_failed`, and backup job failures (backup runbook §6).

## 9. Security invariants (§9) `[TESTED locally / DOCUMENTED for the host]`

- HTTPS only (nginx redirect + HSTS is left to the operator's TLS policy);
  `PUBLIC_URL` must be `https://` or the process refuses to start.
- Ops endpoints keep their scopes (read/control) — no unauthenticated
  mutation; `/health` and `/ready` are deliberately minimal.
- PostgreSQL is private-network only; the app user is not a superuser.
- No secrets in logs (structured redaction; boot logs print key names only),
  metrics, backups' manifests, or this repository (placeholders only).
- Request bounds: 25 MB body, 15 s connection / 600 s request timeouts,
  bounded retries, bounded shutdown grace.
- CORS is an explicit allow-list (wildcards rejected in production); session
  cookies/tokens ride the HTTPS origin only.
- Live publishing stays latched off until a separate, reviewed change.

## 10. Drills performed for this release (see `part-09-evidence.md`)

1. Production-mode boot (scheduler off) → `/ready` 200, S3 `live_ready`. `[TESTED]`
2. Graceful shutdown (SIGINT/SIGTERM handler) → exit 0, in-flight drained,
   0 abandoned. `[TESTED]`
3. Release migration: fresh 6/6, idempotent re-run, drift REFUSED (exit 1),
   drifted boot refused with **exit 78**. `[TESTED]`
4. Scheduler-on production boot: mock warning + persistent ops event, ticks
   bounded, slot executed → `blocked` (publishing gate). `[TESTED]`
5. Transient PostgreSQL outage → `/ready` 503 while `/health` stays 200 →
   PG back → `/ready` 200 on the SAME process. `[TESTED]`
6. Full backup/restore drill on isolated scratch databases (backup runbook). `[TESTED]`
