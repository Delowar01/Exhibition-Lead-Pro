#!/bin/bash
# =============================================================================
# TEMPORARY — B25 Stage 1 schema-push REHEARSAL on the GitHub runner (ONE-OFF
# ops script, not application code). Restores the hosted SCHEMA-ONLY dump into
# a throw-away PostgreSQL 16 (the job's service container), proves the restored
# schema carries the hosted fingerprint, runs `drizzle-kit push --verbose` from
# the accepted B25 code (eb2edb0) against that scratch database, prints and
# classifies EVERY proposed statement, checks the delta against the accepted
# B25 design (exactly the additive storage_objects table and its indexes —
# the hosted database has no storage_objects table, so the Correction 4 column
# publication_uncertain_at arrives inside that CREATE TABLE), and runs the push
# a second time (must report "No changes detected"). The hosted database is
# never touched by this script.
# =============================================================================
set -euo pipefail
set +x

DUMP="${DUMP:?DUMP (path to the schema-only dump) is required}"
SCRATCH_URL="${SCRATCH_URL:?SCRATCH_URL is required}"
REPO="${REPO:-$PWD}"
EXPECTED_HOSTED_FP="${EXPECTED_HOSTED_FP:-}"
EXPECTED_LOCAL_FP="${EXPECTED_LOCAL_FP:-}"
OUT="${OUT:-$RUNNER_TEMP}"

log()  { echo "[b25-s1:schema-push] $*" >&2; }
fail() { echo "[b25-s1:schema-push] ERROR: $*" >&2; exit 1; }
section() { echo; echo "== $* =="; }
sq() { psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -tA -c "$1"; }
fingerprint() { sq "select md5(string_agg(t, '|' order by t)) from (select table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') as t from information_schema.columns where table_schema='public' union all select 'idx:'||indexname||':'||indexdef from pg_indexes where schemaname='public' union all select 'con:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace) s"; }
counts() { sq "select 'tables='||(select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')||' columns='||(select count(*) from information_schema.columns where table_schema='public')||' indexes='||(select count(*) from pg_indexes where schemaname='public')||' constraints='||(select count(*) from pg_constraint where connamespace='public'::regnamespace)||' foreign_keys='||(select count(*) from pg_constraint where connamespace='public'::regnamespace and contype='f')"; }
statements() { grep -E '^(ALTER|CREATE|DROP|TRUNCATE|DELETE|UPDATE|INSERT)' "$1" || true; }
classify() { statements "$1" | sed -E 's/^(ALTER TABLE "[a-z_]+" (ADD COLUMN|ALTER COLUMN|ADD CONSTRAINT "[a-z_]+" (CHECK|FOREIGN KEY|UNIQUE|PRIMARY KEY)|DROP [A-Z]+|RENAME)|CREATE (TABLE|INDEX|UNIQUE INDEX)|DROP [A-Z ]+|[A-Z]+).*/\1/' | sort | uniq -c; }
destructive() { grep -ciE '^(drop|.*rename|truncate|delete|update |insert|alter table "[a-z_]+" alter column "[a-z_]+" (set data type|drop not null|set not null|drop default))' "$1" || true; }

section "scratch database (runner service container; never the hosted database)"
sq "select 'server='||version()"
[ "$(sq "select count(*) from information_schema.tables where table_schema='public'")" = "0" ] || fail "scratch database is not empty"

section "restore the hosted schema-only dump"
echo "dump bytes=$(stat -c %s "$DUMP") lines=$(wc -l < "$DUMP") sha256_prefix=$(sha256sum "$DUMP" | cut -c1-16) create_table_statements=$(grep -c '^CREATE TABLE' "$DUMP" || true) data_statements=$(grep -cE '^(INSERT|COPY) ' "$DUMP" || true)"
# pg_dump >= 16.10 wraps the file in \restrict / \unrestrict psql meta-commands; an
# older psql client cannot parse them, so they are dropped (the dump is trusted here).
grep -vE '^\\(un)?restrict ' "$DUMP" > "$OUT/schema.restore.sql"
psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -q -f "$OUT/schema.restore.sql" > "$OUT/restore.log" 2>&1 || { tail -20 "$OUT/restore.log"; fail "restore failed"; }
echo "restore warnings: $(grep -ci 'warning\|error' "$OUT/restore.log" || true)"
echo "restored $(counts)"
F0="$(fingerprint)"; echo "restored_fingerprint=$F0 hosted_fingerprint=${EXPECTED_HOSTED_FP:-unknown}"
[ -z "$EXPECTED_HOSTED_FP" ] || [ "$F0" = "$EXPECTED_HOSTED_FP" ] || fail "the restored schema does not carry the hosted fingerprint — the rehearsal would not represent the hosted database"
echo "storage_objects on the restored hosted schema: $(sq "select coalesce(to_regclass('public.storage_objects')::text,'absent')")"

section "drizzle-kit push --verbose from the accepted code (scratch database only) — EVERY proposed statement"
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
TOTAL="$(statements "$OUT/push1.log" | wc -l)"
echo "statements=$TOTAL destructive_or_data=$(destructive "$OUT/push1.log")"
echo "classification:"; classify "$OUT/push1.log" | sed 's/^/  /' || true
OTHER="$(statements "$OUT/push1.log" | grep -vc '"storage_objects"' || true)"
echo "statements touching tables other than storage_objects: $OTHER"; { statements "$OUT/push1.log" | grep -v '"storage_objects"' | sed 's/^/  /'; } || true

section "delta vs the accepted B25 design"
ALTER_N="$(statements "$OUT/push1.log" | grep -c '^ALTER' || true)"
DROP_N="$(statements "$OUT/push1.log" | grep -ciE '^DROP|DROP |RENAME|SET DATA TYPE|SET NOT NULL|DROP NOT NULL|DROP DEFAULT' || true)"
DATA_N="$(statements "$OUT/push1.log" | grep -ciE '^(DELETE|UPDATE|INSERT|TRUNCATE)' || true)"
CT_N="$(statements "$OUT/push1.log" | grep -c '^CREATE TABLE "storage_objects"' || true)"
IDX_N="$(statements "$OUT/push1.log" | grep -cE '^CREATE (UNIQUE )?INDEX .* ON "storage_objects"' || true)"
echo "create_table_storage_objects=$CT_N indexes_on_storage_objects=$IDX_N alter=$ALTER_N drop_rename_type_nullability_default=$DROP_N data=$DATA_N other_tables=$OTHER total=$TOTAL"
echo "publication_uncertain_at inside the CREATE TABLE: $(grep -c '"publication_uncertain_at" timestamp' "$OUT/push1.log" || true) (nullable: $(grep -oE '"publication_uncertain_at" timestamp[^,)]*' "$OUT/push1.log" | grep -ci 'not null' | sed 's/^0$/yes (no NOT NULL)/; s/^[1-9].*/NO/'))"
if [ "$CT_N" = "1" ] && [ "$IDX_N" = "4" ] && [ "$ALTER_N" = "0" ] && [ "$DROP_N" = "0" ] && [ "$DATA_N" = "0" ] && [ "$OTHER" = "0" ] && [ "$TOTAL" = "5" ]; then
  echo "DELTA = exactly the accepted B25 design: CREATE TABLE storage_objects (all columns incl. publication_uncertain_at, nullable) + 1 unique index + 3 indexes; nothing else"
else
  echo "DELTA DIFFERS from the accepted design — every statement is listed above; STOP and review"
  [ "$DROP_N" = "0" ] && [ "$DATA_N" = "0" ] || fail "destructive, rename, type, nullability, default or data statement proposed: STOP"
fi
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
log "schema-push rehearsal complete (scratch database only)"
