# PART 9 — PostgreSQL Backup & Restore Runbook

**Scope:** protecting the only durable state of the autopilot (jobs + leases,
settings, catalog, ops events, usage ledger, provider workspaces) and proving
recoverability with a **tested** drill.

**Status legend** (PART 9 §10): `[TESTED]` = executed in this repository
against real, isolated PostgreSQL instances; `[DOCUMENTED]` = the canonical
procedure for the production host, which has no attached infrastructure here
and is therefore not claimed as executed.

---

## 1. What must be backed up

| Data | Store | In `pg_dump`? | In repo-native backup? |
|---|---|---|---|
| Jobs, claims, leases, slot contents, publish runs, catalog, settings, checkpoints, notifications, api clients, provider workspaces, usage ledger, ops events | PostgreSQL `public` schema | yes | yes (JSON export) |
| Provider credential material | `provider_secrets` (AES-256-GCM) | yes (ciphertext) | yes (ciphertext) |
| **`SECRETS_ENCRYPTION_KEY`** | environment file only | **NO — back up separately** | **NO** |
| Generated images | S3-compatible bucket | not in the DB dump | not in the DB dump |
| `.env` (incl. `AUTH_JWT_SECRET`, `DATABASE_URL`, S3 keys) | `/etc/shopee-autopilot/env` | **NO — back up separately** | **NO** |

> A database restored **without** `SECRETS_ENCRYPTION_KEY` keeps every stored
> provider secret permanently unreadable (fail-closed by design). Store the key
> and the env file in a different secret store than the database dumps.

## 2. Canonical backups with pg_dump `[DOCUMENTED]`

The production host has native PostgreSQL tooling; this remains the canonical
path. This repository has **no `pg_dump` binary** (embedded dev clusters ship
only the server), so this path is documented, not executed here.

```bash
# One command per scheduled run (cron/systemd timer, off-peak):
umask 077
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump --format=custom --compress=9 --no-owner --no-privileges \
        --file "/var/backups/autopilot/db-$STAMP.dump" "$DATABASE_URL"

# Encrypt for off-host storage (age/gpg/sops — pick one, keep the key elsewhere):
age -r <recipient.pub> "db-$STAMP.dump" > "db-$STAMP.dump.age" && shred -u "db-$STAMP.dump"

# VERIFY every backup when written (a backup that cannot be restored is not one):
pg_restore --list "db-$STAMP.dump" >/dev/null            # archive integrity
createdb autopilot_verify && \
pg_restore --exit-on-error --dbname=autopilot_verify "db-$STAMP.dump" && \
psql -d autopilot_verify -c "select count(*) from drizzle.__drizzle_migrations" \
  && dropdb autopilot_verify                              # restore drill (isolated!)
```

**Retention (suggested):** 30 daily, 12 monthly, keep the dump taken immediately
before every release migrate. **Never** run `pg_restore` against production to
"fix" it — restoring is always into an EMPTY, freshly created database.

## 3. Repo-native backup/restore (tested fallback) `[TESTED]`

For environments without pg tooling (and for the drill itself), the repository
ships a read-only exporter and a guarded importer:

```bash
cd backend
npm run db:backup  -- --out tmp/backup-$(date -u +%Y%m%dT%H%M%SZ)   # SELECTs only
npm run db:restore -- --in  tmp/backup-<stamp> --yes                # refuses dirty targets
```

Properties (proven by `tests/db/part9-backup-restore.test.ts`):

- **Backup** exports every `public` table plus a `manifest.json` recording
  per-table row counts, the migration state and the PostgreSQL version. The
  manifest contains the database NAME only — never a host, user or password.
- **Restore** refuses unless (a) the target schema is migrated and consistent
  (schema is code — never restored from data) and (b) every overlapping table
  is EMPTY. It inserts in live foreign-key order and then verifies row counts
  against the manifest, so it **cannot** overwrite or lose data silently.

## 4. Restore procedure (either tool) `[DOCUMENTED for prod / TESTED locally]`

1. **Do not touch the failing production database.** Create a NEW empty
   database (`createdb autopilot_restore`).
2. Migrate it from the release checkout: `npm run db:migrate` (exit 0,
   consistent). Schema comes from code, never from the dump.
3. Restore rows: `pg_restore --exit-on-error --dbname=autopilot_restore <dump>`
   or `npm run db:restore -- --in <dir> --yes`.
4. **Post-restore checks** (all must pass before cutover):

```sql
-- (a) schema + bookkeeping consistent with the release
--     (npm run db:status / db:verify already assert this)
-- (b) queue / lease sanity: no job stuck 'running' with an EXPIRED lease
select count(*) from jobs where status='running' and lease_expires_at < now(); -- expect 0
-- (c) settings intact and single-row invariant holds
select count(*) from app_settings;                                             -- expect 1
-- (d) catalog present
select (select count(*) from products) products, (select count(*) from import_batches) batches;
-- (e) events + usage ledger present
select max(last_seen_at) from ops_events; select count(*) from generation_usage;
```

5. **Cutover:** repoint `DATABASE_URL` at the restored database, restart the
   service, confirm `curl -fsS https://$HOST/ready` → 200. Expired leases from
   the incident window are requeued automatically at boot (crash recovery) —
   in-flight work at backup time resumes by lease expiry, it is never lost and
   never double-committed.
6. **S3 bucket:** not part of the DB restore. If the bucket was also lost,
   restore it from its provider's versioning/replication; asset references in
   PostgreSQL remain valid keys, and missing objects surface as `blocked`
   slots rather than crashes.

## 5. The drill performed for PART 9 `[TESTED]`

Executed against real, isolated PostgreSQL databases on the test cluster
(`tests/db/part9-backup-restore.test.ts`, part of `npm run test:db`):

1. SOURCE scratch database: migrated by the release runner, seeded through the
   REAL stores — settings document, catalog snapshot, one **running job with a
   live lease** + one claimable job, an ops event, a usage-ledger row.
2. `createBackup` → manifest with correct counts, secret-free.
3. TARGET scratch database: migrated fresh, `restoreBackup` → every table count
   verified; settings/catalog content identical.
4. The restored queue is **usable**: the pending job was claimable by a new
   worker; the running job kept its claim/lease (resumes via expiry, not loss).
5. Refusals proven: restore into the now non-empty target → refused; restore
   into a never-migrated database → refused; nothing destroyed in either case.

The pg_dump path itself is `[DOCUMENTED]` — no pg binaries exist in this
environment, and no claim of live cloud verification is made.

## 6. Scheduling & alerting `[DOCUMENTED]`

- Nightly `pg_dump` + weekly full restore drill into a scratch database
  (automate the §4 checks; a failing drill pages).
- Before every release migrate: take a dump (retention key), then migrate.
- Backups off-host within 24 h; restore-tested at least quarterly.

## 7. RPO / RTO targets `[DOCUMENTED]`

| Scenario | RPO | RTO |
|---|---|---|
| Nightly dump only | ≤ 24 h | ≤ 60 min (restore + checks + cutover) |
| Continuous archiving (optional, WAL) | ≤ 5 min | ≤ 30 min |
| Single host crash (no data loss) | 0 | systemd restart ≤ 60 s; leases requeue automatically |

Honest note: these are **targets for the production host**, not measurements —
no production database is attached to this repository.
