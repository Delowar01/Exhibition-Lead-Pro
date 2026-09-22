# Backup and recovery — hosted development stack (dev.kaptnow.com)

Document of record for the bundled-PostgreSQL backups of the development VPS
(B23 G-6, G-6 Correction 1 and Correction 2). It describes what exists and is
proven, the hardened backup script, the **proposed** daily schedule (not
installed), the **proposed** off-host copy (not configured, not verified), the
restore procedures and the exact commands to inspect success. Nothing here applies to a production
deployment; production must use a managed database with provider backups.

## 1. What exists and what is proven (as of 2026-09-18)

| Item | State | Evidence |
|---|---|---|
| Backup script | `docker/scripts/backup-postgres.sh` (this revision: lock, unique temporary file, integrity checks, checksum computed **before** publication, no-clobber hard-link publication, post-publish verification, prune-after-verify) | test harness `docker/scripts/test/backup-postgres.test.sh` (37 assertions) |
| Backup location | `/opt/lead-capture-pro/backups/postgres/` on the VPS root filesystem, directory `700`, files `600`, owner = deploy user; outside every Docker volume | G-6 inventory (Actions runs 35404789095, 35405027051) |
| Local backups | 7 activation-time dumps (2026-09-02 … 2026-09-15, schema F0 or older, no sidecar) + `leadcapture-20260918-234035.sql.gz` (F2, 72 tables, 3,525 rows, sha256 `9d51ae6d…0693`) + the Correction 2 bridging capture of 2026-09-22 (F2; see `docs/B23_FINAL_RECONCILIATION.md` §1.8). All were made by the pre-sidecar script and have no `.sha256` sidecar. | G-6 C1 run 35406595433, G-6 C2 run (§1.8) |
| Restore proof | the 2026-09-15 dump (F0), the 2026-09-18 dump (F2) and the 2026-09-22 bridging dump (F2) were each restored into a disposable, network-less `postgres:16-alpine` container with `ON_ERROR_STOP`; every table's row count equalled the dump's COPY blocks; both F2 restores reproduced the live schema fingerprint | runs 35405027051, 35406595433, §1.8 |
| Schedule | **none installed** — no cron entry, timer or workflow runs the script (root's crontab is not readable by the deploy user and remains unknown) | G-6 / G-6 C1 preflights |
| Off-host copy | **none evidenced** (no tool configuration for the deploy user, 0 backup-like objects in the app's dev bucket; hosting-panel snapshots not verifiable from the VPS) | G-6 preflight |
| Rollback / live restore | deploy rollback mechanism present in `deploy-vps.sh`, never exercised; the live `dropdb`/`createdb` restore (§4.2) is a **disaster-recovery plan that has never been rehearsed on the running stack** | G-6 §9 |

## 2. The backup script

`bash docker/scripts/backup-postgres.sh` as the deploy user (`leadpro`), from any
directory. Environment (all optional): `DEPLOY_PATH` (default
`/opt/lead-capture-pro/app`), `BACKUP_DIR` (default
`/opt/lead-capture-pro/backups/postgres`), `KEEP` (default 7),
`BACKUP_MIN_BYTES` (default 1024).

Sequence:

1. acquire `$BACKUP_DIR/.backup.lock` (`flock -n`); a second invocation exits
   **75** at once with `another backup is already running` and touches nothing;
2. remove `.leadcapture-*.tmp` files and sidecars whose dump does not exist
   (only an interrupted earlier run can have left them — this run holds the
   lock);
3. require the `postgres` compose service to be running;
4. refuse early if `leadcapture-<stamp>.sql.gz` or its sidecar already exists;
5. `pg_dump` **inside** the postgres container as its own `POSTGRES_USER` over
   the local socket (no password is read, passed or printed) → `gzip` → a
   unique `.leadcapture-<stamp>.XXXXXX.tmp` on the destination filesystem;
6. verify before publishing: `gzip -t`, size ≥ `BACKUP_MIN_BYTES`, the
   `-- PostgreSQL database dump` header, the `-- PostgreSQL database dump
   complete` marker;
7. compute the sha256 of the temporary dump and write it to a temporary
   sidecar (`sha256sum` format, mode 600); a failure here publishes nothing;
8. publish **without clobbering**: the sidecar and then the dump are
   hard-linked into their final names (`ln` fails atomically when the target
   exists — a name that appeared while the dump ran is never overwritten; the
   run's own sidecar is removed again in that case);
9. re-verify the published pair with `sha256sum -c`; a mismatch removes the
   pair again. A `leadcapture-*.sql.gz` name produced by this script therefore
   always means a complete, verified dump with a matching `.sha256` sidecar;
10. only now prune: keep the newest `KEEP` backups, deleting older ones
    together with their sidecar (older files without a sidecar are handled the
    same way); orphan sidecars are removed;
11. any failure exits 1 with a `[backup] … ERROR:` line, removes only the run's
    own temporary files (and its own half-published sidecar) and never prunes.

Output lines carry a UTC timestamp and name only the file, its size and its
sha256 — never database contents or credentials. File stamps are UTC.

Verification of an existing backup by hand:

```bash
cd /opt/lead-capture-pro/backups/postgres
sha256sum -c leadcapture-<stamp>.sql.gz.sha256          # sidecar present since C1
gzip -t leadcapture-<stamp>.sql.gz && zcat leadcapture-<stamp>.sql.gz | tail -n 3
```

### Freshness check — `docker/scripts/backup-check.sh`

Exits 0 only when the newest backup is younger than `BACKUP_MAX_AGE_HOURS`,
passes `gzip -t`, carries the completion marker, **and** every backup of the
sidecar generation has a matching `.sha256` sidecar. The sidecar generation
starts with the oldest backup (by name = UTC stamp) that has a sidecar; every
backup from that one on must have a matching sidecar, so a newer backup
without one is never reported healthy. Backups older than that (the seven
activation-time dumps and the 2026-09 captures made by the pre-sidecar script)
stay valid without a sidecar. Otherwise it exits 1 with one `FAIL:` line.

`BACKUP_MAX_AGE_HOURS` **defaults to 26**, the general-purpose meaning "a
backup was produced within roughly the last day". That default is **wrong for
the checks that run shortly after the scheduled backup**: at 03:45 UTC
yesterday's 03:15 file is only 24 h 30 min old, so a failed run would still
pass. The post-run checks therefore pass `BACKUP_MAX_AGE_HOURS=4` (§3), which
catches the first missed run that same morning. `BACKUP_CHECK_NOW` (epoch
seconds) overrides the clock for tests only.

### Tests — `docker/scripts/test/backup-postgres.test.sh`

Runs the unchanged scripts with stubbed `docker`/`gzip`/`sha256sum` commands
against a disposable PostgreSQL role that may create databases (never the VPS):

```bash
BACKUP_TEST_ADMIN_URL='postgresql://<createdb-role>:<pw>@localhost:5432/postgres' \
  bash docker/scripts/test/backup-postgres.test.sh
# red/green against another revision of the scripts:
BACKUP_TEST_SCRIPT=/path/to/old/backup-postgres.sh BACKUP_TEST_CHECK=/path/to/old/backup-check.sh …
```

Cases (37 assertions): successful backup published with sidecar and
permissions **and restored into a second disposable database** (row counts and
a content digest must match); dump failure; corrupt gzip stream; incomplete
dump; tiny dump; postgres down; concurrent invocation (second run exits 75
while the first's temporary file is untouched); early overwrite guard; **late
name collision** while the dump runs, with and without a pre-existing sidecar
(publish refused, sentinels byte-identical, no foreign sidecar left); retention
(a failed run prunes nothing among files with and without sidecars; a
successful run prunes the oldest together with their sidecars); **checksum
step failure** (exit non-zero, nothing published, no stray sidecar, the checker
still names the last good backup); the **sidecar-generation rule** (a newer
backup without a sidecar fails, legacy files stay valid); stale temp and orphan
sidecar cleanup; the checker with the default limit, a stale directory and a
wrong sidecar; and the **missed-run scenarios with controlled timestamps**:
a successful run passes at 03:45 and 04:30 UTC with the 4 h limit, a missed
run fails at both times with 4 h and would wrongly pass with 26 h.

## 3. Proposed daily schedule — NOT installed (activation needs approval)

**Mechanism:** the deploy user's own crontab. Reasons: the cron daemon is
active and enabled on the VPS, the deploy user owns the checkout and the
backup directory and can run `docker compose`, no root access is needed, and
it is the mechanism `docs/HOSTINGER_VPS_DEPLOYMENT.md` already describes. A
systemd *user* timer with `Persistent=true` would catch up missed runs but
needs `loginctl enable-linger` (root); a system timer needs root. Both are
alternatives, not the proposal.

**Running user:** `leadpro` (the SSH deploy user; member of `docker`).
**Time:** 03:15 UTC daily (the VPS clock is UTC; the other site's nightly job
runs at 02:15 UTC and is finished by then; app traffic is lowest). The
freshness check runs at 03:45 UTC with a **4 h** limit: a backup that did not
happen at 03:15 is reported that morning (yesterday's file is ~24.5 h old,
which the general-purpose 26 h default would accept).

Proposed entries (`crontab -e` as `leadpro`):

```
# Lead Capture Pro — daily PostgreSQL backup (UTC) and freshness check
15 3 * * * DEPLOY_PATH=/opt/lead-capture-pro/app BACKUP_DIR=/opt/lead-capture-pro/backups/postgres KEEP=14 bash /opt/lead-capture-pro/app/docker/scripts/backup-postgres.sh >> /opt/lead-capture-pro/backups/postgres/backup.log 2>&1
45 3 * * * BACKUP_DIR=/opt/lead-capture-pro/backups/postgres BACKUP_MAX_AGE_HOURS=4 bash /opt/lead-capture-pro/app/docker/scripts/backup-check.sh >> /opt/lead-capture-pro/backups/postgres/backup.log 2>&1
```

- **Retention:** `KEEP=14` (two weeks of daily dumps; ≈0.4 MB each today).
  The script default stays 7 for manual use.
- **Log handling:** both jobs append to `backup.log` inside the 700 directory
  (≈4 lines/day). Rotate by hand when it exceeds a few MB
  (`tail -n 5000 backup.log > backup.log.new && mv backup.log.new backup.log`)
  or add a user `logrotate` state file later; no secrets are ever logged.
- **Missed runs:** cron does not run a job the machine slept through. A missed
  night shows up as an age failure the same morning: with the 4 h limit the
  03:45 check prints `FAIL: newest backup … is ~1470 minutes old (limit 4 h)`
  to the log, and the external alert below turns red (tested with controlled
  timestamps in the harness). A user timer with `Persistent=true` is the alternative if
  catch-up is wanted.
- **Backup-age alert (external, so a dead VPS is also noticed):** a scheduled
  GitHub Actions workflow (proposed name `backup-check.yml`, `schedule: 30 4 * * *`)
  that reuses the existing deploy SSH secrets, runs
  `BACKUP_MAX_AGE_HOURS=4 bash docker/scripts/backup-check.sh` over SSH (the
  same 4 h post-run limit — 26 h would accept a missed run) and fails the run
  otherwise;
  GitHub notifies the owner of a failed scheduled run. Constraint: scheduled
  workflows run only from the repository's default branch (`export-ready`
  today), so the workflow file must land there (or the default branch must
  change) before it fires — a separate approval.
- **Concurrency with activations:** an ops phase that takes a backup (e.g. a
  schema migration) will exit 75 if the nightly job is running; re-run it.

### Activation procedure (later, with approval)

1. Confirm the branch carrying this script is deployed on the VPS
   (`git -C /opt/lead-capture-pro/app rev-parse HEAD`, then
   `sha256sum docker/scripts/backup-postgres.sh` against the repository).
2. First manual run as `leadpro`: `bash docker/scripts/backup-postgres.sh`
   → expect one `OK — … sha256=…` line, one new file + sidecar, older files
   untouched; then `BACKUP_MAX_AGE_HOURS=4 bash docker/scripts/backup-check.sh`
   → `OK: … sidecars verified=1 …`.
3. Install the two crontab lines (`crontab -e`), then `crontab -l` to confirm.
4. Next day: `tail -n 20 backup.log`, `ls -lt --time-style=+%FT%TZ`,
   `bash docker/scripts/backup-check.sh`.
5. Record the first scheduled run in `docs/B23_FINAL_RECONCILIATION.md`.

### Rollback of the schedule

`crontab -l | grep -vE 'backup-postgres\.sh|backup-check\.sh' | crontab -`
then `crontab -l`. Existing backup files, sidecars and the log are left in
place; nothing else was changed by the activation.

### Inspecting success

```bash
crontab -l                                              # the two lines present
tail -n 20 /opt/lead-capture-pro/backups/postgres/backup.log
ls -lt --time-style=+%FT%TZ /opt/lead-capture-pro/backups/postgres/
BACKUP_MAX_AGE_HOURS=4 bash /opt/lead-capture-pro/app/docker/scripts/backup-check.sh   # post-run limit
bash /opt/lead-capture-pro/app/docker/scripts/backup-check.sh                        # general-purpose 26 h
( cd /opt/lead-capture-pro/backups/postgres && sha256sum -c "$(ls -1t leadcapture-*.sql.gz.sha256 | head -1)" )
```

## 4. Restore procedures

### 4.1 Rehearsal into a disposable container (safe; what G-6 did)

Run as `leadpro`; nothing touches the live container, volume or credentials.

```bash
F=/opt/lead-capture-pro/backups/postgres/leadcapture-<stamp>.sql.gz
IMG="$(docker inspect -f '{{.Image}}' "$(docker compose -f /opt/lead-capture-pro/app/docker/docker-compose.yml -f /opt/lead-capture-pro/app/docker/compose.vps.yml ps -q postgres)")"
docker volume create g6-restore-pgdata
docker run -d --name g6-restore --network none --memory 640m --cpus 1 \
  -e POSTGRES_USER=g6 -e POSTGRES_DB=g6restore -e POSTGRES_PASSWORD="$(openssl rand -hex 24)" \
  -v g6-restore-pgdata:/var/lib/postgresql/data -v "$F:/backup/dump.sql.gz:ro" "$IMG"
until docker exec g6-restore pg_isready -q -U g6 -d g6restore; do sleep 1; done
# the dump references the live database role by name (pg_dump without --no-owner):
docker exec g6-restore psql -q -U g6 -d g6restore -c "create role \"$(zcat "$F" | grep -m1 -oE 'OWNER TO [^;]+' | awk '{print $3}' | tr -d '"')\" login"
docker exec g6-restore sh -c 'gunzip -c /backup/dump.sql.gz > /tmp/r.sql && psql -X -v ON_ERROR_STOP=1 --single-transaction -U g6 -d g6restore -f /tmp/r.sql'
docker exec g6-restore psql -tA -U g6 -d g6restore -c "select count(*) from information_schema.tables where table_schema='public'"
docker rm -f g6-restore && docker volume rm g6-restore-pgdata
```

### 4.2 Restore into the live database — disaster-recovery PLAN, not a verified procedure

**This sequence has never been rehearsed on the running stack.** It is the
plan for a real disaster and requires its own approved drill (on a disposable
copy of the stack or in an announced maintenance window) before it can be
called a verified restore or rollback command. What *is* verified is §4.1:
every dump to date restores cleanly into a disposable container.

Prerequisites: explicit owner approval, a fresh backup taken first, the API
stopped, and the target schema state understood (a pre-migration dump cannot be
restored under a newer schema without also re-running the migration).

```bash
cd /opt/lead-capture-pro/app/docker
docker compose -f docker-compose.yml -f compose.vps.yml stop api
# clean slate inside the container (the dump contains CREATE statements):
docker compose -f docker-compose.yml -f compose.vps.yml exec -T postgres sh -c \
  'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
gunzip -c /opt/lead-capture-pro/backups/postgres/leadcapture-<stamp>.sql.gz \
  | docker compose -f docker-compose.yml -f compose.vps.yml exec -T postgres \
      sh -c 'psql -X -v ON_ERROR_STOP=1 --single-transaction -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose -f docker-compose.yml -f compose.vps.yml start api
curl -fsS http://127.0.0.1:18080/api/readyz
```

The volume is never deleted; `dropdb`/`createdb` run inside the container as
`POSTGRES_USER`, which is also the owner named in the dump. Untested points a
drill must cover: `dropdb` while the API is stopped but the durable-queue
worker may still hold connections, the `\\restrict` trailer of pg_dump ≥ 16.10
under `--single-transaction` on the live server, and the `readyz` recovery
time.

### 4.3 Observed recovery measurements (not guarantees)

| Measurement | G-6 (F0 dump, 1.2 MB) | G-6 C1 (F2 dump, 1.3 MB) | G-6 C2 bridging (F2) |
|---|---|---|---|
| Recovery point at the rehearsal | 79 h (no schedule) | ≈1 min (backup just taken) | ≈1 min (backup just taken); 82 h before it |
| Container ready | ≈5 s | ≈4 s | see §1.8 of the reconciliation |
| `psql` restore | 867 ms | 914 ms | see §1.8 |
| Verification queries | 587 ms | 594 ms | see §1.8 |

A live restore adds the API stop/start (seconds) and any schema migration.

## 5. Proposed off-host copy — NOT configured (needs approval and credentials)

| Aspect | Proposal |
|---|---|
| Destination | a **separate private GCS bucket** in the existing project (e.g. `<project>-lcp-dev-db-backups`), uniform bucket-level access, public access prevention on, **not** the application's object bucket |
| Credential | a **dedicated service account** with `roles/storage.objectCreator` on that bucket only (write-only: it cannot read or delete existing objects); key file at `/opt/lead-capture-pro/env/backup-uploader.json`, owner `leadpro`, mode 600. The application's runtime credential (`gcs-service-account.json`) is never reused |
| Transfer | `rclone copy` (already installed on the VPS) with a remote of type `google cloud storage` pointing at the key file, `--immutable` so an existing object is never overwritten; runs as a third crontab line after the freshness check. **Needs a separate permissions test before it can be called workable:** an `objectCreator`-only credential has no `storage.objects.get`/`list`, and rclone relies on those to detect existing objects and to honour `--immutable`; the test must show a first upload succeeds, a second upload of the same name is refused, and nothing else in the bucket can be read or deleted with that credential |
| Encryption | client-side before upload: `age -r <recipient>` (or `gpg --symmetric`) so the bucket never holds plaintext tenant data; the private key/passphrase is kept outside the VPS (owner's password manager) — restoring from off-host then requires it. Bucket-side: Google-managed encryption at rest plus a **retention policy** (30 days, locked) so an attacker with the uploader key cannot shorten history |
| Retention | lifecycle rule: delete after 35 days; monthly copies kept 12 months (a second lifecycle rule on a `monthly/` prefix written on the 1st) |
| Independent verification | a **read-only** principal (`roles/storage.objectViewer` on the bucket, key held only in a GitHub secret or used from the owner's workstation) lists the bucket daily from outside the VPS: newest object age ≤ 26 h, size > 0, sha256 sidecar present; a quarterly rehearsal restores the newest off-host object into a disposable container (procedure 4.1) |
| Not claimed | **off-host protection is unverified**: until a copy has been listed and restored from the destination with the read-only principal, and the uploader permissions have been tested as above, no off-host protection exists |

## 6. Remaining approvals

1. Install the two crontab lines on the VPS (§3) — after this revision of the
   script is deployed.
2. Create the off-host bucket, the write-only and read-only service accounts,
   and place the key file on the VPS (§5).
3. Land the scheduled GitHub check on the default branch (§3, alert).
4. Permissions test of the `objectCreator`-only uploader with `rclone copy
   --immutable` (§5) before any off-host schedule.
5. A separately approved drill of the live restore plan (§4.2) and of the
   deploy rollback (`docs/B23_FINAL_RECONCILIATION.md` §1.6).
