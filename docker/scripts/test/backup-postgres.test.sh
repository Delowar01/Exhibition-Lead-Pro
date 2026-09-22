#!/bin/bash
# =============================================================================
# Failure-mode tests for docker/scripts/backup-postgres.sh and backup-check.sh
# =============================================================================
# The scripts under test run unchanged; `docker`, `gzip` and `sha256sum` are
# replaced by controlled stubs placed first on PATH. The stub `docker compose …
# exec -T postgres …` runs a REAL pg_dump against a disposable source database,
# so the "success" case proves the published file can be restored into a second
# disposable database (row counts and content digests must match) instead of
# merely repeating the script's own checks. Freshness scenarios use controlled
# file timestamps and the checker's BACKUP_CHECK_NOW override.
#
# Requirements: bash, flock, gzip, sha256sum, pg_dump/psql (16) on PATH and
#   BACKUP_TEST_ADMIN_URL — a PostgreSQL URL for a role with CREATEDB on a
#   DISPOSABLE server (never the hosted VPS). Example (local dev cluster):
#   BACKUP_TEST_ADMIN_URL=postgresql://backup_test:<pw>@localhost:5432/postgres
#
# Run:  bash docker/scripts/test/backup-postgres.test.sh
# Exit status is non-zero when any case fails. Nothing is printed from the
# databases except counts and digests.
# =============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# BACKUP_TEST_SCRIPT / BACKUP_TEST_CHECK point the harness at other revisions of the
# two scripts (red/green evidence against an older commit); default: this tree.
SCRIPT="${BACKUP_TEST_SCRIPT:-$HERE/../backup-postgres.sh}"
CHECK="${BACKUP_TEST_CHECK:-$HERE/../backup-check.sh}"
ADMIN="${BACKUP_TEST_ADMIN_URL:-}"
[ -n "$ADMIN" ] || { echo "BACKUP_TEST_ADMIN_URL is required (a CREATEDB role on a disposable PostgreSQL)"; exit 2; }
for t in flock gzip sha256sum pg_dump psql; do command -v "$t" >/dev/null || { echo "missing tool: $t"; exit 2; }; done

T="$(mktemp -d "${TMPDIR:-/tmp}/backup-test.XXXXXX")"
SUFFIX="$$"
SRC_DB="backup_test_src_$SUFFIX"; DST_DB="backup_test_dst_$SUFFIX"
BASE="${ADMIN%/*}"                      # url without the database name
SRC_URL="$BASE/$SRC_DB"; DST_URL="$BASE/$DST_DB"
pass=0; failn=0
ok()   { pass=$((pass + 1)); echo "PASS $1"; }
bad()  { failn=$((failn + 1)); echo "FAIL $1${2:+ — $2}"; }
finish() {
  psql "$ADMIN" -q -X -c "drop database if exists $SRC_DB" -c "drop database if exists $DST_DB" >/dev/null 2>&1 || true
  rm -rf "$T"
}
trap finish EXIT

# ── disposable source database with a small realistic shape ─────────────────
psql "$ADMIN" -q -X -v ON_ERROR_STOP=1 -c "create database $SRC_DB" >/dev/null || { echo "cannot create $SRC_DB"; exit 2; }
psql "$SRC_URL" -q -X -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
create table companies (id serial primary key, name text not null, created_at timestamptz not null default now());
create table users (id serial primary key, company_id int not null references companies(id) on delete cascade, email text not null unique, role text not null default 'employee');
create index users_company_idx on users (company_id);
create table job_queue (id bigserial primary key, name text not null, payload text not null, status text not null default 'completed', enqueued_at timestamptz not null default now());
insert into companies (name) select 'Company ' || g from generate_series(1, 25) g;
insert into users (company_id, email) select (g % 25) + 1, 'user' || g || '@example.invalid' from generate_series(1, 400) g;
insert into job_queue (name, payload) select 'recurring.sweep', repeat('x', 40) || g from generate_series(1, 3000) g;
SQL

# ── stubs: docker (compose ps / exec), gzip (optional corruption), sha256sum (optional failure) ─
mkdir -p "$T/bin" "$T/app/docker" "$T/backups"
cat > "$T/bin/docker" <<'STUB'
#!/bin/bash
# Stub for `docker compose -f … -f … <subcommand> …` used by backup-postgres.sh.
args="$*"
case "$args" in
  *"ps --status running postgres"*)
    [ "${STUB_POSTGRES_DOWN:-0}" = "1" ] && exit 0
    echo "stub-postgres-1" ;;
  *"exec -T postgres sh -c"*)
    case "${STUB_DUMP_MODE:-ok}" in
      ok)        exec pg_dump "$STUB_SOURCE_URL" ;;
      slow)      pg_dump "$STUB_SOURCE_URL" > "$STUB_TMPDIR/slow.sql" && sleep "${STUB_DUMP_SLEEP:-4}" && cat "$STUB_TMPDIR/slow.sql" ;;
      fail)      echo "pg_dump: error: stub failure (connection refused)" >&2; exit 1 ;;
      truncated) pg_dump "$STUB_SOURCE_URL" | head -c 20000; exit 0 ;;
      empty)     exit 0 ;;
      collide)   # a late name collision: the final names appear WHILE the dump is running
                 now="$(date +%s)"
                 for off in -2 -1 0 1; do
                   n="leadcapture-$(date -u -d "@$((now + off))" +%Y%m%d-%H%M%S).sql.gz"
                   [ -e "$BACKUP_DIR/$n" ] || printf 'sentinel\n' > "$BACKUP_DIR/$n"
                   if [ "${STUB_COLLIDE_SIDECAR:-0}" = "1" ] && [ ! -e "$BACKUP_DIR/$n.sha256" ]; then printf '%064d  %s\n' 0 "$n" > "$BACKUP_DIR/$n.sha256"; fi
                 done
                 exec pg_dump "$STUB_SOURCE_URL" ;;
      *) echo "unknown STUB_DUMP_MODE" >&2; exit 98 ;;
    esac ;;
  *) echo "unexpected docker invocation: $args" >&2; exit 99 ;;
esac
STUB
cat > "$T/bin/gzip" <<'STUB'
#!/bin/bash
# Real gzip, except that STUB_GZIP_CORRUPT=1 truncates the compressed stream.
REAL="$(command -v -p gzip || echo /usr/bin/gzip)"
if [ "${STUB_GZIP_CORRUPT:-0}" = "1" ] && [ "${1:-}" = "-c" ]; then "$REAL" -c | head -c -64; exit 0; fi
exec "$REAL" "$@"
STUB
cat > "$T/bin/sha256sum" <<'STUB'
#!/bin/bash
# Real sha256sum, except that STUB_SHA_FAIL=1 makes checksum COMPUTATION fail (the checksum step).
REAL="$(command -v -p sha256sum || echo /usr/bin/sha256sum)"
if [ "${STUB_SHA_FAIL:-0}" = "1" ] && [ "${1:-}" != "-c" ]; then echo "sha256sum: stub failure" >&2; exit 1; fi
exec "$REAL" "$@"
STUB
chmod 755 "$T/bin/docker" "$T/bin/gzip" "$T/bin/sha256sum"
export STUB_SOURCE_URL="$SRC_URL" STUB_TMPDIR="$T"

tick() { sleep 1.1; }   # file names carry a one-second UTC stamp: never publish twice in one second
run_backup() {  # run_backup <keep> [env assignments…] → stdout+stderr in $T/last.out, status in $?
  local keep="$1"; shift; tick
  ( cd "$T" && env PATH="$T/bin:$PATH" DEPLOY_PATH="$T/app" BACKUP_DIR="$T/backups" KEEP="$keep" "$@" bash "$SCRIPT" ) >"$T/last.out" 2>&1
}
run_check() {   # run_check <dir> [env assignments…] → output in $T/check.out, status in $?
  local dir="$1"; shift
  ( cd "$T" && env BACKUP_DIR="$dir" "$@" bash "$CHECK" ) >"$T/check.out" 2>&1
}
count_backups() { ls -1 "$T/backups"/leadcapture-*.sql.gz 2>/dev/null | wc -l; }
count_tmp()     { ls -1A "$T/backups" 2>/dev/null | grep -c '\.tmp$' || true; }
snapshot()      { ( cd "$T/backups" && for f in leadcapture-*; do [ -e "$f" ] && echo "$f $(/usr/bin/sha256sum "$f" | cut -c1-64)"; done | sort ); }
mkold() {       # mkold <dir> <stamp> [sidecar] — a valid, complete, small gzip dump with the stamp as mtime (UTC)
  local f="$1/leadcapture-$2.sql.gz" s="$2"
  printf -- '--\n-- PostgreSQL database dump\n--\nCREATE TABLE public.t (id int);\n--\n-- PostgreSQL database dump complete\n--\n' | /usr/bin/gzip -c > "$f"
  chmod 600 "$f"; touch -d "${s:0:4}-${s:4:2}-${s:6:2} ${s:9:2}:${s:11:2}:${s:13:2} UTC" "$f"
  if [ "${3:-}" = "sidecar" ]; then ( cd "$1" && /usr/bin/sha256sum "$(basename "$f")" > "$(basename "$f").sha256" ); chmod 600 "$f.sha256"; touch -r "$f" "$f.sha256"; fi
}
epoch() { date -u -d "$1" +%s; }

# ── 1. success: publish, checksum, permissions, and a REAL restore ───────────
if run_backup 7; then
  n="$(count_backups)"; new="$(ls -1 "$T/backups"/leadcapture-*.sql.gz | head -1)"
  [ "$n" = "1" ] && [ "$(count_tmp)" = "0" ] && ok "success: exactly one published file, no temporary file left" || bad "success: files=$n tmp=$(count_tmp)"
  [ "$(stat -c %a "$new")" = "600" ] && [ "$(stat -c %a "$new.sha256")" = "600" ] && [ "$(stat -c %a "$T/backups")" = "700" ] && ok "success: modes 600/600/700" || bad "success: modes $(stat -c %a "$new") $(stat -c %a "$new.sha256" 2>/dev/null) $(stat -c %a "$T/backups")"
  ( cd "$T/backups" && /usr/bin/sha256sum -c --quiet "$(basename "$new").sha256" >/dev/null 2>&1 ) && ok "success: .sha256 sidecar matches the published file" || bad "success: sidecar mismatch"
  grep -q '^\[backup\] .* OK — .*leadcapture-.*\.sql\.gz (.* bytes) sha256=[0-9a-f]\{64\}$' "$T/last.out" && ok "success: OK line names the file, size and sha256 only" || bad "success: unexpected OK line" "$(tail -1 "$T/last.out")"
  ! grep -qiE 'password|postgresql://|@example\.invalid' "$T/last.out" && ok "success: no credential or row content in the output" || bad "success: output leaks content"
  # real restore into a second disposable database
  psql "$ADMIN" -q -X -v ON_ERROR_STOP=1 -c "create database $DST_DB" >/dev/null
  if zcat "$new" > "$T/restore.sql" && psql "$DST_URL" -q -X -v ON_ERROR_STOP=1 --single-transaction -f "$T/restore.sql" >/dev/null 2>"$T/restore.err"; then
    srcc="$(psql "$SRC_URL" -tA -c "select (select count(*) from companies)||'/'||(select count(*) from users)||'/'||(select count(*) from job_queue)")"
    dstc="$(psql "$DST_URL" -tA -c "select (select count(*) from companies)||'/'||(select count(*) from users)||'/'||(select count(*) from job_queue)")"
    srcd="$(psql "$SRC_URL" -tA -c "select md5(string_agg(id||':'||company_id||':'||email||':'||role, '|' order by id)) from users")"
    dstd="$(psql "$DST_URL" -tA -c "select md5(string_agg(id||':'||company_id||':'||email||':'||role, '|' order by id)) from users")"
    fks="$(psql "$DST_URL" -tA -c "select count(*) from pg_constraint where contype='f' and connamespace='public'::regnamespace")"
    [ "$srcc" = "$dstc" ] && [ -n "$srcc" ] && ok "restore: row counts identical (companies/users/job_queue = $dstc)" || bad "restore: counts src=$srcc dst=$dstc"
    [ "$srcd" = "$dstd" ] && [ -n "$srcd" ] && ok "restore: users content digest identical" || bad "restore: content digest differs"
    [ "$fks" = "1" ] && ok "restore: foreign key restored" || bad "restore: fks=$fks"
  else
    bad "restore: psql failed" "$(head -1 "$T/restore.err")"
  fi
  rm -f "$T/restore.sql"
else
  bad "success: script exited $? " "$(tail -2 "$T/last.out" | tr '\n' ' ')"
fi

# ── 2. dump failure: no file published, no temp file, existing untouched ─────
before="$(snapshot)"
if run_backup 7 STUB_DUMP_MODE=fail; then bad "dump failure: script exited 0"; else
  grep -q 'pg_dump or gzip failed — no backup published' "$T/last.out" && [ "$(snapshot)" = "$before" ] && [ "$(count_tmp)" = "0" ] && ok "dump failure: clear error, nothing published, temp removed, existing files untouched" || bad "dump failure" "$(tail -2 "$T/last.out" | tr '\n' ' ') tmp=$(count_tmp)"
fi

# ── 3. corrupt gzip stream ───────────────────────────────────────────────────
if run_backup 7 STUB_GZIP_CORRUPT=1; then bad "corrupt gzip: script exited 0"; else
  grep -q 'gzip integrity check failed' "$T/last.out" && [ "$(snapshot)" = "$before" ] && [ "$(count_tmp)" = "0" ] && ok "corrupt gzip: rejected before publishing, temp removed" || bad "corrupt gzip" "$(tail -2 "$T/last.out" | tr '\n' ' ')"
fi

# ── 4. incomplete dump (completion marker missing) ───────────────────────────
if run_backup 7 STUB_DUMP_MODE=truncated; then bad "truncated dump: script exited 0"; else
  grep -q 'completion marker missing' "$T/last.out" && [ "$(snapshot)" = "$before" ] && [ "$(count_tmp)" = "0" ] && ok "truncated dump: rejected (marker missing), nothing published" || bad "truncated dump" "$(tail -2 "$T/last.out" | tr '\n' ' ')"
fi

# ── 5. tiny dump (size floor) ────────────────────────────────────────────────
if run_backup 7 STUB_DUMP_MODE=empty; then bad "tiny dump: script exited 0"; else
  grep -q 'suspiciously small' "$T/last.out" && [ "$(snapshot)" = "$before" ] && ok "tiny dump: rejected by the size floor" || bad "tiny dump" "$(tail -2 "$T/last.out" | tr '\n' ' ')"
fi

# ── 6. postgres not running ──────────────────────────────────────────────────
if run_backup 7 STUB_POSTGRES_DOWN=1; then bad "postgres down: script exited 0"; else
  grep -q 'postgres service is not running' "$T/last.out" && [ "$(snapshot)" = "$before" ] && [ "$(count_tmp)" = "0" ] && ok "postgres down: clear error, nothing created" || bad "postgres down" "$(tail -1 "$T/last.out")"
fi

# ── 7. concurrent invocation: the second run exits 75 without touching the first ─
tick
( cd "$T" && env PATH="$T/bin:$PATH" DEPLOY_PATH="$T/app" BACKUP_DIR="$T/backups" KEEP=7 STUB_DUMP_MODE=slow STUB_DUMP_SLEEP=4 bash "$SCRIPT" ) >"$T/first.out" 2>&1 &
first_pid=$!
sleep 1.5
( cd "$T" && env PATH="$T/bin:$PATH" DEPLOY_PATH="$T/app" BACKUP_DIR="$T/backups" KEEP=7 bash "$SCRIPT" ) >"$T/second.out" 2>&1
second_rc=$?
tmp_during="$(count_tmp)"
wait "$first_pid"; first_rc=$?
[ "$second_rc" = "75" ] && grep -q 'another backup is already running' "$T/second.out" && ok "concurrency: second run exits 75 with a clear message" || bad "concurrency: second rc=$second_rc" "$(tail -1 "$T/second.out")"
[ "$tmp_during" = "1" ] && ok "concurrency: the first run's temporary file was still present when the second exited (untouched)" || bad "concurrency: tmp files during second run = $tmp_during"
[ "$first_rc" = "0" ] && [ "$(count_backups)" = "2" ] && [ "$(count_tmp)" = "0" ] && ok "concurrency: first run completed and published exactly one more file" || bad "concurrency: first rc=$first_rc files=$(count_backups) tmp=$(count_tmp)" "$(tail -1 "$T/first.out") | $(ls -1 "$T/backups" | tr '\n' ' ')"

# ── 7b. an existing target name is refused before the dump ───────────────────
tick
for off in 0 1 2 3; do n="leadcapture-$(date -u -d "+$off seconds" +%Y%m%d-%H%M%S).sql.gz"; printf 'sentinel\n' > "$T/backups/$n"; chmod 600 "$T/backups/$n"; done
sentinels="$(snapshot)"
if ( cd "$T" && env PATH="$T/bin:$PATH" DEPLOY_PATH="$T/app" BACKUP_DIR="$T/backups" KEEP=7 bash "$SCRIPT" ) >"$T/same.out" 2>&1; then bad "overwrite guard (early): the script published over an existing name"; else
  grep -q 'already exists — refusing to overwrite' "$T/same.out" && [ "$(snapshot)" = "$sentinels" ] && [ "$(count_tmp)" = "0" ] && ok "overwrite guard (early): an existing target name is refused and left byte-identical" || bad "overwrite guard (early)" "$(tail -1 "$T/same.out")"
fi
rm -f "$T/backups"/leadcapture-*.sql.gz "$T/backups"/*.sha256 2>/dev/null; true

# ── 7c. LATE name collision (targets appear while the dump runs): never clobbered ─
SENT_SUM="$(printf 'sentinel\n' | /usr/bin/sha256sum | cut -c1-64)"
for variant in with-sidecar without-sidecar; do
  rm -f "$T/backups"/leadcapture-*.sql.gz "$T/backups"/*.sha256 2>/dev/null
  if [ "$variant" = "with-sidecar" ]; then extra=(STUB_COLLIDE_SIDECAR=1); else extra=(STUB_COLLIDE_SIDECAR=0); fi
  if run_backup 7 STUB_DUMP_MODE=collide "${extra[@]}"; then bad "late collision ($variant): the script published over a sentinel"; else
    n_files="$(count_backups)"; intact=0; other=0; sidecars_bad=0
    for f in "$T/backups"/leadcapture-*.sql.gz; do
      if [ "$(/usr/bin/sha256sum "$f" | cut -c1-64)" = "$SENT_SUM" ]; then intact=$((intact + 1)); else other=$((other + 1)); fi
      if [ "$variant" = "with-sidecar" ]; then [ "$(cut -c1-64 "$f.sha256" 2>/dev/null)" = "$(printf '%064d' 0)" ] || sidecars_bad=$((sidecars_bad + 1)); else [ ! -e "$f.sha256" ] || sidecars_bad=$((sidecars_bad + 1)); fi
    done
    grep -q 'appeared during the run — refusing to overwrite' "$T/last.out" && [ "$n_files" = "4" ] && [ "$intact" = "4" ] && [ "$other" = "0" ] && [ "$sidecars_bad" = "0" ] && [ "$(count_tmp)" = "0" ] && ok "late collision ($variant): publish refused, all 4 sentinels byte-identical, no foreign sidecar left, no temp file" || bad "late collision ($variant): files=$n_files intact=$intact other=$other sidecars_bad=$sidecars_bad tmp=$(count_tmp)" "$(tail -1 "$T/last.out")"
  fi
done
rm -f "$T/backups"/leadcapture-*.sql.gz "$T/backups"/*.sha256 2>/dev/null; true

# ── 8. retention: legacy files (no sidecar) older than the sidecar generation ─
#      20260901..04 legacy (no sidecar), 20260905..08 sidecar generation.
mkold "$T/backups" 20260901-030000; mkold "$T/backups" 20260902-030000; mkold "$T/backups" 20260903-030000; mkold "$T/backups" 20260904-030000
mkold "$T/backups" 20260905-030000 sidecar; mkold "$T/backups" 20260906-030000 sidecar; mkold "$T/backups" 20260907-030000 sidecar; mkold "$T/backups" 20260908-030000 sidecar
before="$(snapshot)"
if run_backup 7 STUB_DUMP_MODE=fail; then bad "retention on failure: script exited 0"; else
  [ "$(snapshot)" = "$before" ] && [ "$(count_backups)" = "8" ] && ok "retention on failure: all 8 older files (4 legacy without sidecar, 4 with) preserved, nothing pruned" || bad "retention on failure: files=$(count_backups)"
fi

# ── 8b. checksum step failure: exits non-zero, publishes nothing, prunes nothing ─
if run_backup 7 STUB_SHA_FAIL=1; then bad "checksum failure: script exited 0"; else
  grep -q 'checksum computation failed — no backup published' "$T/last.out" && [ "$(snapshot)" = "$before" ] && [ "$(count_backups)" = "8" ] && [ "$(count_tmp)" = "0" ] && [ "$(ls -1 "$T/backups"/*.sha256 | wc -l)" = "4" ] && ok "checksum failure: clear error, nothing published, no temp, no stray sidecar, all 8 earlier files preserved" || bad "checksum failure" "$(tail -2 "$T/last.out" | tr '\n' ' ') files=$(count_backups) sidecars=$(ls -1 "$T/backups"/*.sha256 | wc -l)"
  if run_check "$T/backups" BACKUP_CHECK_NOW="$(epoch '2026-09-08 04:00:00 UTC')" BACKUP_MAX_AGE_HOURS=4; then grep -q 'OK: leadcapture-20260908-030000.sql.gz' "$T/check.out" && ok "checksum failure: the checker still reports the last GOOD backup, nothing from the failed run" || bad "checksum failure: checker output" "$(cat "$T/check.out")"; else bad "checksum failure: checker failed unexpectedly" "$(cat "$T/check.out")"; fi
fi

# ── 8c. a new-generation backup without a sidecar is never healthy ───────────
mkold "$T/backups" 20260909-030000
if run_check "$T/backups" BACKUP_CHECK_NOW="$(epoch '2026-09-09 04:00:00 UTC')" BACKUP_MAX_AGE_HOURS=4; then bad "generation rule: a sidecar-less new-generation backup passed"; else grep -q 'has no .sha256 sidecar although the sidecar generation started with leadcapture-20260905-030000.sql.gz' "$T/check.out" && ok "generation rule: a backup newer than the first sidecar-bearing one without a sidecar FAILS" || bad "generation rule: wrong failure" "$(cat "$T/check.out")"; fi
rm -f "$T/backups/leadcapture-20260909-030000.sql.gz"
if run_check "$T/backups" BACKUP_CHECK_NOW="$(epoch '2026-09-08 04:00:00 UTC')" BACKUP_MAX_AGE_HOURS=4; then grep -q 'sidecars verified=4 (generation from leadcapture-20260905-030000.sql.gz), pre-sidecar backups=4' "$T/check.out" && ok "generation rule: the 4 legacy files without sidecar stay valid, the 4 newer ones are verified" || bad "generation rule: unexpected OK line" "$(cat "$T/check.out")"; else bad "generation rule: legacy files rejected" "$(cat "$T/check.out")"; fi

# ── 8d. retention on success: KEEP=3 prunes 6 oldest incl. two with sidecars ─
if run_backup 3; then
  remaining="$(ls -1 "$T/backups"/leadcapture-*.sql.gz | xargs -n1 basename | sort | tr '\n' ' ')"
  [ "$(count_backups)" = "3" ] && [ ! -e "$T/backups/leadcapture-20260906-030000.sql.gz" ] && [ ! -e "$T/backups/leadcapture-20260906-030000.sql.gz.sha256" ] && [ ! -e "$T/backups/leadcapture-20260901-030000.sql.gz" ] && [ -e "$T/backups/leadcapture-20260907-030000.sql.gz" ] && [ -e "$T/backups/leadcapture-20260907-030000.sql.gz.sha256" ] && [ -e "$T/backups/leadcapture-20260908-030000.sql.gz.sha256" ] && ok "retention on success: 3 kept, 6 oldest pruned (legacy files and files with sidecars alike), sidecars removed with their backups" || bad "retention on success" "remaining: $remaining"
  grep -q 'pruning leadcapture-20260906-030000.sql.gz (+ sidecar)' "$T/last.out" && grep -q 'pruning leadcapture-20260904-030000.sql.gz$' "$T/last.out" && ok "retention on success: prune log names each file (sidecar noted)" || bad "retention on success: prune log" "$(grep pruning "$T/last.out" | tr '\n' ' ')"
  orphans="$(ls -1 "$T/backups"/*.sha256 | while read -r sc; do [ -e "${sc%.sha256}" ] || echo "$sc"; done | wc -l)"
  [ "$orphans" = "0" ] && ok "retention on success: no orphan sidecar" || bad "retention on success: $orphans orphan sidecar(s)"
else
  bad "retention on success: script exited $?" "$(tail -2 "$T/last.out" | tr '\n' ' ')"
fi

# ── 9. stale temporary files and an orphan sidecar from an interrupted run are removed ─
: > "$T/backups/.leadcapture-20260101-000000.abcdef.tmp"
: > "$T/backups/.leadcapture-20260101-000000.abcdef.sha256.tmp"
printf '%064d  leadcapture-20260101-000000.sql.gz\n' 0 > "$T/backups/leadcapture-20260101-000000.sql.gz.sha256"
if run_backup 7; then
  [ "$(count_tmp)" = "0" ] && grep -q 'removed 2 stale temporary file' "$T/last.out" && [ ! -e "$T/backups/leadcapture-20260101-000000.sql.gz.sha256" ] && grep -q 'removed orphan sidecar leadcapture-20260101-000000.sql.gz.sha256' "$T/last.out" && ok "stale temp + orphan sidecar: removed and logged before the new run" || bad "stale temp/orphan: tmp=$(count_tmp)" "$(grep -E 'stale|orphan' "$T/last.out" | tr '\n' ' ')"
else bad "stale temp: script exited $?"; fi

# ── 10. backup-check on the live-like directory: fresh ok; all stale fails; wrong sidecar fails ─
if run_check "$T/backups"; then grep -q 'OK: leadcapture-' "$T/check.out" && ok "backup-check: fresh backup with sidecar passes (default 26 h)" || bad "backup-check: unexpected output" "$(cat "$T/check.out")"; else bad "backup-check: failed on a fresh backup" "$(cat "$T/check.out")"; fi
newest="$(ls -1t "$T/backups"/leadcapture-*.sql.gz | head -1)"; find "$T/backups" -name 'leadcapture-*.sql.gz' -exec touch -d '30 hours ago' {} +
if run_check "$T/backups"; then bad "backup-check: a 30 h old backup passed"; else grep -q 'minutes old' "$T/check.out" && ok "backup-check: stale backup (30 h) fails with the age" || bad "backup-check: wrong failure" "$(cat "$T/check.out")"; fi
touch "$newest"; ( cd "$T/backups" && printf '%064d  %s\n' 0 "$(basename "$newest")" > "$(basename "$newest").sha256" )
if run_check "$T/backups"; then bad "backup-check: a wrong sidecar passed"; else grep -q 'does not match its .sha256 sidecar' "$T/check.out" && ok "backup-check: sidecar mismatch fails" || bad "backup-check: wrong failure" "$(cat "$T/check.out")"; fi

# ── 11. the first missed daily run must be caught that morning (controlled timestamps) ─
#      Schedule: backup 03:15 UTC, checks at 03:45 UTC (local) and 04:30 UTC (external).
F="$T/fresh"; mkdir -p "$F"; chmod 700 "$F"
mkold "$F" 20260920-031530 sidecar; mkold "$F" 20260921-031530 sidecar      # yesterday and today succeeded
for when in '2026-09-21 03:45:00 UTC' '2026-09-21 04:30:00 UTC'; do
  if run_check "$F" BACKUP_CHECK_NOW="$(epoch "$when")" BACKUP_MAX_AGE_HOURS=4; then grep -q 'OK: leadcapture-20260921-031530.sql.gz age=' "$T/check.out" && ok "freshness: successful run — check at ${when#2026-09-21 } with limit 4 h passes" || bad "freshness: successful run at $when" "$(cat "$T/check.out")"; else bad "freshness: successful run rejected at $when" "$(cat "$T/check.out")"; fi
done
rm -f "$F/leadcapture-20260921-031530.sql.gz" "$F/leadcapture-20260921-031530.sql.gz.sha256"   # today's backup did not happen
for when in '2026-09-21 03:45:00 UTC' '2026-09-21 04:30:00 UTC'; do
  if run_check "$F" BACKUP_CHECK_NOW="$(epoch "$when")" BACKUP_MAX_AGE_HOURS=4; then bad "freshness: missed run NOT detected at $when with limit 4 h" "$(cat "$T/check.out")"; else grep -qE 'newest backup leadcapture-20260920-031530.sql.gz is (1469|1514) minutes old \(limit 4 h\)' "$T/check.out" && ok "freshness: missed run — check at ${when#2026-09-21 } with limit 4 h FAILS (yesterday's file is ~24.5 h old)" || bad "freshness: missed run wrong failure at $when" "$(cat "$T/check.out")"; fi
  if run_check "$F" BACKUP_CHECK_NOW="$(epoch "$when")" BACKUP_MAX_AGE_HOURS=26; then ok "freshness: the same missed run would PASS with the general-purpose 26 h limit at ${when#2026-09-21 } (why the post-run checks must use 4 h)" || true; else bad "freshness: 26 h limit unexpectedly failed at $when" "$(cat "$T/check.out")"; fi
done

echo "backup-postgres tests: $pass passed, $failn failed"
[ "$failn" = "0" ]
