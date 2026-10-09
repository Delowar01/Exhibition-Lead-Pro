#!/bin/bash
# =============================================================================
# TEMPORARY — local/synthetic tests of the B25 Stage 1 smoke-cleanup rules
# (ONE-OFF ops test, not a product test; never run by the deploy pipeline).
# Runs against the LOCAL development database named by DATABASE_URL (never the
# hosted one): inserts synthetic storage_objects tombstones for company ids
# that do not exist (900001 / 900002) plus one for the existing company 1, then
# proves that purge_rows_sql refuses every disallowed shape and deletes exactly
# the allow-listed rows, and that the provider rules refuse wrong markers,
# numeric or non-canonical generations and present objects. Every synthetic
# row is removed at the end (trap). Exit 0 only when every assertion holds.
# =============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=b25-stage1-purge-lib.sh
source "$HERE/b25-stage1-purge-lib.sh"
# shellcheck source=b25-stage1-apply-lib.sh
source "$HERE/b25-stage1-apply-lib.sh"
: "${DATABASE_URL:?DATABASE_URL (local development database) is required}"
case "$DATABASE_URL" in *localhost*|*127.0.0.1*) ;; *) echo "refusing: DATABASE_URL is not a local database" >&2; exit 1;; esac

q()  { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA -F '|' -c "set default_transaction_read_only = on" -c "$1"; }
qw() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA -F '|' -c "$1"; }
pass=0; failn=0
ok()   { pass=$((pass + 1)); echo "PASS  $1"; }
bad()  { failn=$((failn + 1)); echo "FAIL  $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 (got '$2', want '$3')"; fi; }

CA=900001; CB=900002; TAG="t$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')"
[ "$(q "select count(*) from companies where id in ($CA,$CB)")" = "0" ] || { echo "synthetic company ids exist — aborting" >&2; exit 1; }
declare -a IDS=()
# mk <varname>: assign a fresh uuid to the named variable IN THIS SHELL and record it for the trap cleanup
mk() { local -n _v="$1"; _v="$(q "select gen_random_uuid()::text")"; IDS+=("$_v"); }
ASSOC_DOC=""; ASSOC_SCAN=""
cleanup() {
  local list; list="$(printf "'%s'," "${IDS[@]}")"; list="${list%,}"
  [ -n "$ASSOC_SCAN" ] && qw "delete from scans where id=$ASSOC_SCAN and company_id=1 and image_url like '/objects/%'" >/dev/null || true
  [ -n "$ASSOC_DOC" ] && qw "delete from documents where id=$ASSOC_DOC and company_id=1 and name like 'b25 cleanup test %'" >/dev/null || true
  [ -n "$list" ] && qw "delete from storage_objects where id in ($list) and company_id in ($CA,$CB,900003,1)" >/dev/null || true
}
trap cleanup EXIT

# insert <id> <company> <kind> <state> <last_error|NULL> <uncertain yes|no> <driver> <mirror_key|NULL> [reference_override] [storage_key_override]
ins() {
  local id="$1" cid="$2" kind="$3" state="$4" err="$5" unc="$6" drv="$7" mk="$8" ref="${9:-}" key="${10:-}"
  local dir="documents"; [ "$kind" = "branding_logo" ] && dir="branding"
  [ -n "$ref" ] || { if [ "$kind" = "branding_logo" ]; then ref="branding/$cid/$(printf '%s' "$id" | tr -d '-').png"; else ref="/objects/$id"; fi; }
  [ -n "$key" ] || { key="tenants/$cid/$dir/$id"; [ "$kind" = "branding_logo" ] && key="$key.png"; }
  local errsql="null"; [ "$err" != "NULL" ] && errsql="'$err'"
  local uncsql="null"; [ "$unc" = "yes" ] && uncsql="now()"
  local mksql="null"; [ "$mk" != "NULL" ] && mksql="'$mk'"
  qw "insert into storage_objects (id, company_id, kind, reference, storage_key, driver, legacy_key, content_type, size_bytes, sha256, state, last_error, publication_uncertain_at, mirror_key, deleted_at, created_at, updated_at) values ('$id', $cid, '$kind', '$ref', '$key', '$drv', 'gs://synthetic/$key', 'application/pdf', 10, repeat('a',64), '$state', $errsql, $uncsql, $mksql, case when '$state' in ('deleted','deleting') then now() else null end, now(), now())" >/dev/null
}
present() { q "select count(*) from storage_objects where id='$1'"; }
run_purge() { local triple; triple="$(qw "$(purge_rows_sql "$1" "$2" "$3")")"; echo "$triple"; }

echo "== negative cases (each must delete nothing)"
# 1. a row of a company that still exists (company 1 — existing tenant)
mk R1; ins "$R1" 1 document deleted LEGACY_RETAINED no gcs NULL
# 2. active / pending / uploading / staged / failed / deleting rows of a smoke company
mk R2; ins "$R2" $CA document active NULL no gcs NULL
mk R3; ins "$R3" $CA document pending NULL no gcs NULL
mk R4; ins "$R4" $CA document uploading NULL no gcs NULL
mk R5; ins "$R5" $CA document staged NULL no gcs NULL
mk R6; ins "$R6" $CA document failed LEGACY_RETAINED no gcs NULL
mk R7; ins "$R7" $CA document deleting LEGACY_RETAINED no gcs NULL
# 3. uncertain / OWNERSHIP_UNPROVEN / CLEANUP_PENDING / no LEGACY_RETAINED marker
mk R8; ins "$R8" $CA document deleted LEGACY_RETAINED yes gcs NULL
mk R9; ins "$R9" $CA document deleted OWNERSHIP_UNPROVEN no gcs NULL
mk R10; ins "$R10" $CA document deleted CLEANUP_PENDING no gcs NULL
mk R11; ins "$R11" $CA document deleted NULL no gcs NULL
# 4. filesystem driver / mirror key set / foreign reference identity / foreign key identity
mk R12; ins "$R12" $CA document deleted LEGACY_RETAINED no fs NULL
mk R13; ins "$R13" $CA document deleted LEGACY_RETAINED no gcs "gs://synthetic/mirror"
mk R14; ins "$R14" $CA document deleted LEGACY_RETAINED no gcs NULL "/objects/uploads/not-this-row-$TAG"
mk R15; ins "$R15" $CA document deleted LEGACY_RETAINED no gcs NULL "" "tenants/$CA/documents/other-$TAG"
# 5. a row that belongs to another (non-smoke) company id
mk R16; ins "$R16" 900003 document deleted LEGACY_RETAINED no gcs NULL
# 6. live associations: the feature tables carry a cascading FK to companies, so synthetic association rows can only
#    exist for an existing company (company 1). The whole purge refuses such rows anyway (company exists); the
#    association predicates are therefore proven directly below as well.
mk R17; ins "$R17" 1 document deleted LEGACY_RETAINED no gcs NULL
ASSOC_DOC="$(qw "insert into documents (company_id, entity_type, entity_id, category, name, created_at, updated_at) values (1, 'company', 1, 'general', 'b25 cleanup test $TAG', now(), now()) returning id" 2>/dev/null || true)"
if [[ "$ASSOC_DOC" =~ ^[0-9]+$ ]]; then
  qw "insert into document_versions (company_id, document_id, version_number, object_path, file_name, file_size, mime_type, uploaded_at) values (1, $ASSOC_DOC, 1, '/objects/$R17', 'x-$TAG.pdf', 10, 'application/pdf', now())" >/dev/null
else
  echo "note: could not create a synthetic document (shape differs) — document association predicate not exercised"; ASSOC_DOC=""
fi
mk R18; ins "$R18" 1 scan_image deleted LEGACY_RETAINED no gcs NULL "/objects/$R18" "tenants/1/scans/$R18"
ASSOC_SCAN="$(qw "insert into scans (company_id, image_url, status, created_at) values (1, '/objects/$R18', 'failed', now()) returning id" 2>/dev/null || true)"
[[ "$ASSOC_SCAN" =~ ^[0-9]+$ ]] || { echo "note: could not create a synthetic scan (shape differs) — scan association predicate not exercised"; ASSOC_SCAN=""; }

for pair in "$R1:company still exists" "$R2:active" "$R3:pending" "$R4:uploading" "$R5:staged" "$R6:failed" "$R7:deleting" "$R8:publication_uncertain_at set" "$R9:OWNERSHIP_UNPROVEN" "$R10:CLEANUP_PENDING" "$R11:no LEGACY_RETAINED" "$R12:fs driver" "$R13:mirror key set" "$R14:foreign reference identity" "$R15:foreign storage key" "$R16:another company" "$R17:live document_versions association (company 1)" "$R18:live scans association (company 1)"; do
  id="${pair%%:*}"; label="${pair#*:}"
  triple="$(run_purge "'$id'" "$CA,$CB,1" 1)"
  if [[ "$triple" == 0\|* ]] && [ "$(present "$id")" = "1" ]; then ok "refused: $label ($triple)"; else bad "NOT refused: $label ($triple, present=$(present "$id"))"; fi
done
# association predicates proven directly (independent of the company-exists condition)
if [ -n "$ASSOC_DOC" ]; then check "document_versions association detected for R17" "$(q "select count(*) from storage_objects l where l.id='$R17' and not exists (select 1 from document_versions dv where dv.company_id=l.company_id and dv.object_path=l.reference)")" "0"; fi
if [ -n "$ASSOC_SCAN" ]; then check "scans association detected for R18" "$(q "select count(*) from storage_objects l where l.id='$R18' and not exists (select 1 from scans sc where sc.company_id=l.company_id and sc.image_url=l.reference)")" "0"; fi
check "company-exists predicate detected for R1" "$(q "select count(*) from storage_objects l where l.id='$R1' and not exists (select 1 from companies c where c.id=l.company_id)")" "0"
# 7. a row NOT in the explicit uuid list is never touched even though it would pass
mk P1; ins "$P1" $CA document deleted LEGACY_RETAINED no gcs NULL
mk P2; ins "$P2" $CB branding_logo deleted LEGACY_RETAINED no gcs NULL
triple="$(run_purge "'$P1'" "$CA,$CB" 1)"; check "explicit list only: P2 untouched" "$(present "$P2")" "1"; purge_result_check "$triple" 1 >/dev/null && ok "P1 (allow-listed) deleted alone ($triple)" || bad "P1 not deleted ($triple)"
# 8. count mismatch: expected 2 but only one allow-listed row in the list → nothing deleted
mk P3; ins "$P3" $CA document deleted LEGACY_RETAINED no gcs NULL
triple="$(run_purge "'$P3','$R2'" "$CA,$CB" 2)"; if [[ "$triple" == 0\|2\|1 ]] && [ "$(present "$P3")" = "1" ] && [ "$(present "$R2")" = "1" ]; then ok "count mismatch refuses the whole transaction ($triple)"; else bad "count mismatch did not refuse ($triple)"; fi
# 9. expected count 0 never deletes
triple="$(run_purge "'$P3'" "$CA,$CB" 0)"; if [[ "$triple" == 0\|1\|1 ]] && [ "$(present "$P3")" = "1" ]; then ok "expected=0 deletes nothing ($triple)"; else bad "expected=0 deleted something ($triple)"; fi

echo "== positive and idempotent path"
triple="$(run_purge "'$P2','$P3'" "$CA,$CB" 2)"; purge_result_check "$triple" 2 >/dev/null && [ "$(present "$P2")" = "0" ] && [ "$(present "$P3")" = "0" ] && ok "both allow-listed tombstones deleted in one transaction ($triple)" || bad "positive path failed ($triple)"
triple="$(run_purge "'$P2','$P3'" "$CA,$CB" 0)"; [[ "$triple" == 0\|0\|0 ]] && ok "second run: already removed → 0|0|0, nothing else touched" || bad "second run changed something ($triple)"
check "non-smoke synthetic row (company 1) still present after both runs" "$(present "$R1")" "1"
check "other-company row still present" "$(present "$R16")" "1"

echo "== provider rules (node)"
RULES="$(mktemp)"; printf '%s\n' "$PROVIDER_RULES_JS" > "$RULES"
out="$(B25_RULES_EXPORT=1 node -e '
const r = require(process.argv[1]); const id = "0b7c2f2e-1d7a-4c0e-9a7b-3c3d1a2b4c5d";
const res = {
  ok: r.shouldDeleteObject(id, { generation: "9007199254740993", metadata: { "lcp-object-id": id } }),
  wrongMarker: r.shouldDeleteObject(id, { generation: "5", metadata: { "lcp-object-id": "other" } }).ok,
  noMarker: r.shouldDeleteObject(id, { generation: "5", metadata: {} }).ok,
  numericGen: r.shouldDeleteObject(id, { generation: 5, metadata: { "lcp-object-id": id } }).ok,
  nonCanonical: r.shouldDeleteObject(id, { generation: "05", metadata: { "lcp-object-id": id } }).ok,
  emptyGen: r.shouldDeleteObject(id, { generation: "", metadata: { "lcp-object-id": id } }).ok,
  absent: r.rowAbsent({ storage: false, legacy: false, mirror: null }),
  storagePresent: r.rowAbsent({ storage: true, legacy: false, mirror: null }),
  legacyPresent: r.rowAbsent({ storage: false, legacy: true, mirror: null }),
  mirrorPresent: r.rowAbsent({ storage: false, legacy: false, mirror: true }),
};
process.stdout.write(JSON.stringify(res));' "$RULES")"; rm -f "$RULES"
check "marker + canonical large generation accepted with the exact string" "$(printf '%s' "$out" | grep -o '"ok":{"ok":true,"generation":"9007199254740993"}' | wc -l)" "1"
for k in wrongMarker noMarker numericGen nonCanonical emptyGen storagePresent legacyPresent mirrorPresent; do check "rule refuses $k" "$(printf '%s' "$out" | grep -o "\"$k\":[a-z]*" | cut -d: -f2)" "false"; done
check "rule accepts a fully absent row" "$(printf '%s' "$out" | grep -o '"absent":[a-z]*' | cut -d: -f2)" "true"

echo "== schema-apply allow-list (canned drizzle output and mutations)"
W="$(mktemp -d)"; trap 'cleanup; rm -rf "$W"' EXIT
cat > "$W/good.log" <<'LOG'
Warning  You are about to execute current statements:
CREATE TABLE "storage_objects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"kind" text NOT NULL,
	"entity_type" text,
	"entity_id" integer,
	"reference" text NOT NULL,
	"storage_key" text NOT NULL,
	"driver" text NOT NULL,
	"legacy_key" text,
	"mirror_key" text,
	"lease_token" text,
	"lease_expires_at" timestamp,
	"content_type" text NOT NULL,
	"size_bytes" bigint,
	"sha256" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"mirror_state" text,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"reconciled_at" timestamp,
	"publication_uncertain_at" timestamp
);
CREATE UNIQUE INDEX "storage_objects_company_kind_reference_uq" ON "storage_objects" USING btree ("company_id","kind","reference");
CREATE INDEX "storage_objects_company_idx" ON "storage_objects" USING btree ("company_id");
CREATE INDEX "storage_objects_state_updated_idx" ON "storage_objects" USING btree ("state","updated_at");
CREATE INDEX "storage_objects_entity_idx" ON "storage_objects" USING btree ("entity_type","entity_id");
[✓] Changes applied
LOG
push_allowlist_check "$W/good.log" >/dev/null && ok "allow-list accepts exactly the 5 accepted statements" || bad "allow-list rejected the accepted output"
mut() { local name="$1"; shift; "$@" > "$W/$name.log"; if push_allowlist_check "$W/$name.log" >/dev/null 2>&1; then bad "allow-list did NOT reject: $name"; else ok "allow-list rejects: $name"; fi; }
mut "extra ALTER" sh -c "cat '$W/good.log'; echo 'ALTER TABLE \"users\" ADD COLUMN \"x\" text;'"
mut "DROP statement" sh -c "cat '$W/good.log'; echo 'DROP TABLE \"old\";'"
mut "RENAME" sh -c "cat '$W/good.log'; echo 'ALTER TABLE \"storage_objects\" RENAME COLUMN \"a\" TO \"b\";'"
mut "data mutation" sh -c "cat '$W/good.log'; echo \"UPDATE \\\"storage_objects\\\" SET state='x';\""
mut "other table" sh -c "cat '$W/good.log'; echo 'CREATE INDEX \"x_idx\" ON \"users\" USING btree (\"id\");'"
mut "missing index" grep -v 'storage_objects_entity_idx' "$W/good.log"
mut "missing publication_uncertain_at" grep -v 'publication_uncertain_at' "$W/good.log"
mut "NOT NULL on publication_uncertain_at" sed 's/"publication_uncertain_at" timestamp/"publication_uncertain_at" timestamp NOT NULL/' "$W/good.log"
mut "type change" sed 's/"size_bytes" bigint/"size_bytes" integer/' "$W/good.log"
mut "destructive default" sed "s/\"state\" text DEFAULT 'pending' NOT NULL/\"state\" text DEFAULT 'deleted' NOT NULL/" "$W/good.log"
mut "data-loss warning" sh -c "echo 'Warning: data loss may occur'; cat '$W/good.log'"
mut "not applied" grep -v 'Changes applied' "$W/good.log"
mut "second CREATE TABLE" sh -c "cat '$W/good.log'; echo 'CREATE TABLE \"storage_objects_extra\" (\"id\" int);'"

echo "== backup structure rules (real local pg_dump of the development database)"
pg_dump "$DATABASE_URL" | gzip -c > "$W/b.sql.gz"
T="$(q "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")"; CO="$(q "select count(*) from companies")"
backup_structure_check "$W/b.sql.gz" "$T" "$CO" >/dev/null && ok "backup structure accepted (tables=$T companies=$CO)" || bad "backup structure rejected a complete dump"
backup_structure_check "$W/b.sql.gz" "$((T + 1))" "$CO" >/dev/null 2>&1 && bad "backup check did not reject a table-count mismatch" || ok "backup check rejects a table-count mismatch"
backup_structure_check "$W/b.sql.gz" "$T" "$((CO + 1))" >/dev/null 2>&1 && bad "backup check did not reject a companies-row mismatch" || ok "backup check rejects a companies-row mismatch"
zcat "$W/b.sql.gz" | grep -v '^-- PostgreSQL database dump complete' | gzip -c > "$W/t.sql.gz"
backup_structure_check "$W/t.sql.gz" "$T" "$CO" >/dev/null 2>&1 && bad "backup check did not reject a truncated dump" || ok "backup check rejects a dump without the completion marker"

echo; echo "cleanup tests: $pass passed, $failn failed"
[ "$failn" = "0" ]
