#!/bin/bash
# =============================================================================
# TEMPORARY — B25 Phase 2A schema-push INSPECTION on the GitHub runner (ONE-OFF
# ops script, not application code). Restores the hosted SCHEMA-ONLY dump into a
# throw-away PostgreSQL 16 (the job's service container), proves the restored
# schema carries the hosted fingerprint, runs `drizzle-kit push --verbose` from
# the accepted B25 code against that scratch database, classifies every proposed
# statement, and runs the push a second time (must report "No changes
# detected"). The hosted database is never touched by this script.
# =============================================================================
set -euo pipefail
set +x

DUMP="${DUMP:?DUMP (path to the schema-only dump) is required}"
SCRATCH_URL="${SCRATCH_URL:?SCRATCH_URL is required}"
REPO="${REPO:-$PWD}"
EXPECTED_HOSTED_FP="${EXPECTED_HOSTED_FP:-}"
EXPECTED_LOCAL_FP="${EXPECTED_LOCAL_FP:-}"
OUT="${OUT:-$RUNNER_TEMP}"

log()  { echo "[b25:schema-push] $*" >&2; }
fail() { echo "[b25:schema-push] ERROR: $*" >&2; exit 1; }
section() { echo; echo "== $* =="; }
sq() { psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -tA -c "$1"; }
fingerprint() { sq "select md5(string_agg(t, '|' order by t)) from (select table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') as t from information_schema.columns where table_schema='public' union all select 'idx:'||indexname||':'||indexdef from pg_indexes where schemaname='public' union all select 'con:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace) s"; }
counts() { sq "select 'tables='||(select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')||' indexes='||(select count(*) from pg_indexes where schemaname='public')||' constraints='||(select count(*) from pg_constraint where connamespace='public'::regnamespace)"; }
classify() { grep -E '^(ALTER|CREATE|DROP|TRUNCATE|DELETE|UPDATE|INSERT)' "$1" | sed -E 's/^(ALTER TABLE "[a-z_]+" (ADD COLUMN|ALTER COLUMN|ADD CONSTRAINT "[a-z_]+" (CHECK|FOREIGN KEY|UNIQUE|PRIMARY KEY)|DROP [A-Z]+|RENAME)|CREATE (TABLE|INDEX|UNIQUE INDEX)|DROP [A-Z ]+|[A-Z]+).*/\1/' | sort | uniq -c; }
destructive() { grep -ciE '^(drop|.*rename|truncate|delete|update |insert|alter table "[a-z_]+" alter column "[a-z_]+" (set data type|drop not null|set not null|drop default))' "$1" || true; }

section "scratch database (runner service container; never the hosted database)"
sq "select 'server='||version()"
[ "$(sq "select count(*) from information_schema.tables where table_schema='public'")" = "0" ] || fail "scratch database is not empty"

section "restore the hosted schema-only dump"
echo "dump bytes=$(stat -c %s "$DUMP") lines=$(wc -l < "$DUMP") sha256_prefix=$(sha256sum "$DUMP" | cut -c1-16) create_table_statements=$(grep -c '^CREATE TABLE' "$DUMP" || true)"
# pg_dump >= 16.10 wraps the file in \restrict / \unrestrict psql meta-commands; an
# older psql client cannot parse them, so they are dropped (the dump is trusted here).
grep -vE '^\\(un)?restrict ' "$DUMP" > "$OUT/schema.restore.sql"
psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -q -f "$OUT/schema.restore.sql" > "$OUT/restore.log" 2>&1 || { tail -20 "$OUT/restore.log"; fail "restore failed"; }
echo "restore warnings: $(grep -ci 'warning\|error' "$OUT/restore.log" || true)"
echo "restored $(counts)"
F0="$(fingerprint)"; echo "restored_fingerprint=$F0 hosted_fingerprint=${EXPECTED_HOSTED_FP:-unknown}"
[ -z "$EXPECTED_HOSTED_FP" ] || [ "$F0" = "$EXPECTED_HOSTED_FP" ] || fail "the restored schema does not carry the hosted fingerprint — the rehearsal would not represent the hosted database"

section "drizzle-kit push --verbose from the accepted code (scratch database only)"
cd "$REPO/lib/db"
echo "drizzle-kit: $(npx drizzle-kit --version 2>/dev/null | tail -1)"
set +e
DATABASE_URL="$SCRATCH_URL" timeout 300 npx drizzle-kit push --verbose --config ./drizzle.config.ts < /dev/null > "$OUT/push1.log" 2>&1
RC=$?
set -e
grep -v 'Pulling schema' "$OUT/push1.log" | sed 's/^/  /'
echo "push1 exit=$RC result=$(grep -oE 'Changes applied|No changes detected' "$OUT/push1.log" | tail -1)"
[ "$RC" = "0" ] || fail "first push did not complete (exit $RC — a confirmation prompt means a data-loss statement was proposed: STOP)"
grep -qiE 'data.loss|you.re about to|truncate' "$OUT/push1.log" && fail "drizzle-kit raised a data-loss warning: STOP" || true
echo "statements=$(grep -cE '^(ALTER|CREATE|DROP|TRUNCATE|DELETE|UPDATE|INSERT)' "$OUT/push1.log" || true) destructive_or_data=$(destructive "$OUT/push1.log")"
echo "classification:"; classify "$OUT/push1.log" | sed 's/^/  /' || true
echo "statements touching tables other than storage_objects:"; { grep -E '^(ALTER|CREATE|DROP|TRUNCATE|DELETE|UPDATE|INSERT)' "$OUT/push1.log" | grep -v '"storage_objects"' | sed 's/^/  /'; } || echo "  (none)"
F1="$(fingerprint)"; echo "after_push_fingerprint=$F1 expected_local_fingerprint=${EXPECTED_LOCAL_FP:-unknown}"
echo "after push $(counts)"
[ -z "$EXPECTED_LOCAL_FP" ] || { [ "$F1" = "$EXPECTED_LOCAL_FP" ] && echo "after-push schema equals the local development schema at the accepted commit" || echo "NOTE: after-push fingerprint differs from the local development schema (compare the statement list above)"; }

section "storage_objects as created on the scratch database"
sq "select column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'<none>') from information_schema.columns where table_schema='public' and table_name='storage_objects' order by ordinal_position" | sed 's/^/  column /'
sq "select indexname||' | '||indexdef from pg_indexes where schemaname='public' and tablename='storage_objects' order by indexname" | sed 's/^/  index /'
sq "select conname||' | '||contype::text||' | '||pg_get_constraintdef(oid) from pg_constraint where conrelid='storage_objects'::regclass order by conname" | sed 's/^/  constraint /'

section "second push (must be a no-op)"
set +e
DATABASE_URL="$SCRATCH_URL" timeout 300 npx drizzle-kit push --config ./drizzle.config.ts < /dev/null > "$OUT/push2.log" 2>&1
RC2=$?
set -e
echo "push2 exit=$RC2 result=$(grep -oE 'Changes applied|No changes detected' "$OUT/push2.log" | tail -1) statements=$(grep -cE '^(ALTER|CREATE|DROP)' "$OUT/push2.log" || true)"
grep -q 'No changes detected' "$OUT/push2.log" || fail "second push did not report 'No changes detected'"
F2="$(fingerprint)"; [ "$F2" = "$F1" ] || fail "fingerprint changed on the second push"
echo "second push: No changes detected; fingerprint stable ($F2)"
rm -f "$OUT/schema.restore.sql"
log "schema-push inspection complete (scratch database only)"
