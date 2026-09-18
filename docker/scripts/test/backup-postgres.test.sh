#!/bin/bash
# =============================================================================
# Failure-mode tests for docker/scripts/backup-postgres.sh and backup-check.sh
# =============================================================================
# The script under test is run unchanged; `docker` and `gzip` are replaced by
# controlled stubs placed first on PATH. The stub `docker compose … exec -T
# postgres …` runs a REAL pg_dump against a disposable source database, so the
# "success" case proves the published file can be restored into a second
# disposable database (row counts and content digests must match) instead of
# merely repeating the script's own checks.
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
SCRIPT="$HERE/../backup-postgres.sh"
CHECK="$HERE/../backup-check.sh"
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

# ── stubs: docker (compose ps / exec), gzip (optional corruption) ────────────
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
chmod 755 "$T/bin/docker" "$T/bin/gzip"
export STUB_SOURCE_URL="$SRC_URL" STUB_TMPDIR="$T"

tick() { sleep 1.1; }   # file names carry a one-second UTC stamp: never publish twice in one second
run_backup() {  # run_backup <keep> [env assignments…] → stdout+stderr in $T/last.out, status in $?
  local keep="$1"; shift; tick
  ( cd "$T" && env PATH="$T/bin:$PATH" DEPLOY_PATH="$T/app" BACKUP_DIR="$T/backups" KEEP="$keep" "$@" bash "$SCRIPT" ) >"$T/last.out" 2>&1
}
count_backups() { ls -1 "$T/backups"/leadcapture-*.sql.gz 2>/dev/null | wc -l; }
count_tmp()     { ls -1A "$T/backups" 2>/dev/null | grep -c '\.tmp$' || true; }
snapshot()      { ( cd "$T/backups" && for f in leadcapture-*; do [ -e "$f" ] && echo "$f $(sha256sum "$f" | cut -c1-64)"; done | sort ); }
mkold() {       # mkold <stamp> [sidecar] — a valid, complete, small gzip dump with an old mtime
  local f="$T/backups/leadcapture-$1.sql.gz"
  printf -- '--\n-- PostgreSQL database dump\n--\nCREATE TABLE public.t (id int);\n--\n-- PostgreSQL database dump complete\n--\n' | /usr/bin/gzip -c > "$f"
  chmod 600 "$f"; touch -d "${1:0:4}-${1:4:2}-${1:6:2} ${1:9:2}:${1:11:2}:${1:13:2} UTC" "$f"
  if [ "${2:-}" = "sidecar" ]; then ( cd "$T/backups" && sha256sum "$(basename "$f")" > "$(basename "$f").sha256" ); chmod 600 "$f.sha256"; touch -r "$f" "$f.sha256"; fi
}

# ── 1. success: publish, checksum, permissions, and a REAL restore ───────────
if run_backup 7; then
  n="$(count_backups)"; new="$(ls -1 "$T/backups"/leadcapture-*.sql.gz | head -1)"
  [ "$n" = "1" ] && [ "$(count_tmp)" = "0" ] && ok "success: exactly one published file, no temporary file left" || bad "success: files=$n tmp=$(count_tmp)"
  [ "$(stat -c %a "$new")" = "600" ] && [ "$(stat -c %a "$new.sha256")" = "600" ] && [ "$(stat -c %a "$T/backups")" = "700" ] && ok "success: modes 600/600/700" || bad "success: modes $(stat -c %a "$new") $(stat -c %a "$new.sha256" 2>/dev/null) $(stat -c %a "$T/backups")"
  ( cd "$T/backups" && sha256sum -c --quiet "$(basename "$new").sha256" >/dev/null 2>&1 ) && ok "success: .sha256 sidecar matches the published file" || bad "success: sidecar mismatch"
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

# ── 7b. an existing target name is never overwritten ──────────────────────────
# Pre-create the names the next run could pick (now … now+3 s) and run at once.
tick
for off in 0 1 2 3; do n="leadcapture-$(date -u -d "+$off seconds" +%Y%m%d-%H%M%S).sql.gz"; printf 'sentinel\n' > "$T/backups/$n"; chmod 600 "$T/backups/$n"; done
sentinels="$(snapshot)"
if ( cd "$T" && env PATH="$T/bin:$PATH" DEPLOY_PATH="$T/app" BACKUP_DIR="$T/backups" KEEP=7 bash "$SCRIPT" ) >"$T/same.out" 2>&1; then bad "overwrite guard: the script published over an existing name"; else
  grep -q 'already exists — refusing to overwrite' "$T/same.out" && [ "$(snapshot)" = "$sentinels" ] && [ "$(count_tmp)" = "0" ] && ok "overwrite guard: an existing target name is refused and left byte-identical" || bad "overwrite guard" "$(tail -1 "$T/same.out")"
fi
rm -f "$T/backups"/leadcapture-*.sql.gz "$T/backups"/*.sha256 2>/dev/null; true

# ── 8. retention: a failed run prunes nothing; a successful run prunes oldest + sidecars ─
rm -f "$T/backups"/leadcapture-* 
mkold 20260901-030000 sidecar; mkold 20260902-030000; mkold 20260903-030000 sidecar; mkold 20260904-030000
mkold 20260905-030000; mkold 20260906-030000 sidecar; mkold 20260907-030000; mkold 20260908-030000
before="$(snapshot)"; nb="$(count_backups)"
if run_backup 7 STUB_DUMP_MODE=fail; then bad "retention on failure: script exited 0"; else
  [ "$(snapshot)" = "$before" ] && [ "$(count_backups)" = "8" ] && ok "retention on failure: all 8 older files (with and without sidecars) preserved, nothing pruned" || bad "retention on failure: files=$(count_backups) (was $nb)"
fi
if run_backup 7; then
  remaining="$(ls -1 "$T/backups"/leadcapture-*.sql.gz | xargs -n1 basename | sort | tr '\n' ' ')"
  [ "$(count_backups)" = "7" ] && [ ! -e "$T/backups/leadcapture-20260901-030000.sql.gz" ] && [ ! -e "$T/backups/leadcapture-20260901-030000.sql.gz.sha256" ] && [ ! -e "$T/backups/leadcapture-20260902-030000.sql.gz" ] && [ -e "$T/backups/leadcapture-20260903-030000.sql.gz" ] && [ -e "$T/backups/leadcapture-20260903-030000.sql.gz.sha256" ] && [ -e "$T/backups/leadcapture-20260904-030000.sql.gz" ] && ok "retention on success: 7 kept, the two oldest pruned together with their sidecar; files without sidecars handled" || bad "retention on success" "remaining: $remaining"
  grep -q 'pruning leadcapture-20260901-030000.sql.gz (+ sidecar)' "$T/last.out" && grep -q 'pruning leadcapture-20260902-030000.sql.gz$' "$T/last.out" && ok "retention on success: prune log names each file (sidecar noted)" || bad "retention on success: prune log" "$(grep pruning "$T/last.out" | tr '\n' ' ')"
  orphans="$(ls -1 "$T/backups"/*.sha256 | while read -r sc; do [ -e "${sc%.sha256}" ] || echo "$sc"; done | wc -l)"
  [ "$orphans" = "0" ] && ok "retention on success: no orphan sidecar" || bad "retention on success: $orphans orphan sidecar(s)"
else
  bad "retention on success: script exited $?" "$(tail -2 "$T/last.out" | tr '\n' ' ')"
fi

# ── 9. stale temporary file from an interrupted earlier run is removed ───────
: > "$T/backups/.leadcapture-20260101-000000.abcdef.tmp"
if run_backup 7; then
  [ "$(count_tmp)" = "0" ] && grep -q 'removed 1 stale temporary file' "$T/last.out" && ok "stale temp: removed and logged" || bad "stale temp: tmp=$(count_tmp)"
else bad "stale temp: script exited $?"; fi

# ── 10. backup-check: fresh + sidecar ok; stale age fails; wrong sidecar fails ─
if ( cd "$T" && BACKUP_DIR="$T/backups" bash "$CHECK" >"$T/check.out" 2>&1 ); then grep -q 'OK: leadcapture-' "$T/check.out" && ok "backup-check: fresh backup with sidecar passes" || bad "backup-check: unexpected output" "$(cat "$T/check.out")"; else bad "backup-check: failed on a fresh backup" "$(cat "$T/check.out")"; fi
newest="$(ls -1t "$T/backups"/leadcapture-*.sql.gz | head -1)"; find "$T/backups" -name 'leadcapture-*.sql.gz' -exec touch -d '30 hours ago' {} +
if ( cd "$T" && BACKUP_DIR="$T/backups" bash "$CHECK" >"$T/check.out" 2>&1 ); then bad "backup-check: a 30 h old backup passed"; else grep -q 'minutes old' "$T/check.out" && ok "backup-check: stale backup (30 h) fails with the age" || bad "backup-check: wrong failure" "$(cat "$T/check.out")"; fi
touch "$newest"; ( cd "$T/backups" && printf '%064d  %s\n' 0 "$(basename "$newest")" > "$(basename "$newest").sha256" )
if ( cd "$T" && BACKUP_DIR="$T/backups" bash "$CHECK" >"$T/check.out" 2>&1 ); then bad "backup-check: a wrong sidecar passed"; else grep -q 'does not match its .sha256 sidecar' "$T/check.out" && ok "backup-check: sidecar mismatch fails" || bad "backup-check: wrong failure" "$(cat "$T/check.out")"; fi

echo "backup-postgres tests: $pass passed, $failn failed"
[ "$failn" = "0" ]
