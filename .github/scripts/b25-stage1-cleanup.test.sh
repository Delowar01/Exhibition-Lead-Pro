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
# Default shapes are the PRODUCT's: document reference /objects/<id>, key tenants/<cid>/documents/<id>;
# branding_logo reference branding/<cid>/<id without dashes>.png, key tenants/<cid>/branding/<id without dashes>.png
# (storage.service.ts storeBuffer removes the dashes of a logo's id in both the reference and the key).
hex() { printf '%s' "$1" | tr -d '-'; }
ins() {
  local id="$1" cid="$2" kind="$3" state="$4" err="$5" unc="$6" drv="$7" mk="$8" ref="${9:-}" key="${10:-}"
  [ -n "$ref" ] || { if [ "$kind" = "branding_logo" ]; then ref="branding/$cid/$(hex "$id").png"; else ref="/objects/$id"; fi; }
  [ -n "$key" ] || { if [ "$kind" = "branding_logo" ]; then key="tenants/$cid/branding/$(hex "$id").png"; else key="tenants/$cid/documents/$id"; fi; }
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
# 5b. branding_logo storage-key shapes the product never generates (the key rule is anchored on the id WITHOUT dashes)
mk R19; ins "$R19" $CA branding_logo deleted LEGACY_RETAINED no gcs NULL "" "tenants/$CA/branding/$R19.png"
mk R20; ins "$R20" $CA branding_logo deleted LEGACY_RETAINED no gcs NULL "" "tenants/$CA/branding/$(hex "$R20").gif"
mk R21; mk R21b; ins "$R21" $CA branding_logo deleted LEGACY_RETAINED no gcs NULL "" "tenants/$CA/branding/$(hex "$R21b").png"
mk R22; ins "$R22" $CA branding_logo deleted LEGACY_RETAINED no gcs NULL "" "tenants/$CA/branding/$(hex "$R22").png/extra"
mk R23; ins "$R23" $CA document deleted LEGACY_RETAINED no gcs NULL "" "tenants/$CA/branding/$(hex "$R23").png"
mk R24; ins "$R24" $CA document deleted LEGACY_RETAINED no gcs NULL "" "tenants/$CA/branding/$R24"
mk R25; ins "$R25" $CA branding_logo deleted LEGACY_RETAINED no gcs NULL "" "tenants/$CB/branding/$(hex "$R25").png"
mk R26; ins "$R26" $CA branding_logo deleted LEGACY_RETAINED no gcs NULL "" "tenants/$CA/documents/$R26"
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

for pair in "$R1:company still exists" "$R2:active" "$R3:pending" "$R4:uploading" "$R5:staged" "$R6:failed" "$R7:deleting" "$R8:publication_uncertain_at set" "$R9:OWNERSHIP_UNPROVEN" "$R10:CLEANUP_PENDING" "$R11:no LEGACY_RETAINED" "$R12:fs driver" "$R13:mirror key set" "$R14:foreign reference identity" "$R15:foreign storage key" "$R16:another company" "$R17:live document_versions association (company 1)" "$R18:live scans association (company 1)" "$R19:logo key with the DASHED id" "$R20:logo key with an extension outside png/jpg/webp" "$R21:logo key carrying another id (hex)" "$R22:logo key with trailing path material" "$R23:document row with a branding-shaped (hex) key" "$R24:document row under the branding directory (dashed id)" "$R25:logo key under another tenant" "$R26:branding_logo row with a document-shaped key"; do
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

echo "== branding_logo storage-key rule (logo_key_rule_sql, as shipped; product shape tenants/<cid>/branding/<id without dashes>.<png|jpg|webp>)"
# rule_is <want true|false> <label> <id> <company id> <storage_key or NULL>
rule_is() {
  local want="$1" label="$2" id="$3" cid="$4" key="$5" val keysql
  if [ "$key" = "NULL" ]; then keysql="NULL::text"; else keysql="'$key'::text"; fi
  val="$(q "select coalesce($(logo_key_rule_sql), false)::text from (values ('$id'::uuid, $cid, $keysql)) as t(id, company_id, storage_key)")"
  [ "$val" = "$want" ] && ok "logo key rule: $label (=$val)" || bad "logo key rule: $label (got '$val', want $want)"
}
K="$(q "select gen_random_uuid()::text")"; KH="$(hex "$K")"; K2="$(q "select gen_random_uuid()::text")"
KSIB="${K:0:34}$(printf '%02x' $(( (16#${K:34:2} + 1) % 256 )))"   # same first 34 characters, last two differ
check "fixture: the sibling id shares a 34-character prefix with the id" "${KSIB:0:34}" "${K:0:34}"
check "fixture: a uuid carries four dashes (every id transforms through the same replace)" "$(printf '%s' "$K" | tr -cd '-' | wc -c)" "4"
rule_is true  "correct tenant, branding directory, id without dashes, .png" "$K" 900001 "tenants/900001/branding/$KH.png"
rule_is true  "correct key with .jpg (product-accepted)" "$K" 900001 "tenants/900001/branding/$KH.jpg"
rule_is true  "correct key with .webp (product-accepted)" "$K" 900001 "tenants/900001/branding/$KH.webp"
rule_is false "dashed id in the key" "$K" 900001 "tenants/900001/branding/$K.png"
rule_is false "another id (hex) in the key" "$K" 900001 "tenants/900001/branding/$(hex "$K2").png"
rule_is false "sibling id sharing a 34-character prefix" "$K" 900001 "tenants/900001/branding/$(hex "$KSIB").png"
rule_is false "another tenant" "$K" 900001 "tenants/900002/branding/$KH.png"
rule_is false "wrong directory (documents)" "$K" 900001 "tenants/900001/documents/$KH.png"
rule_is false "malformed path (empty component)" "$K" 900001 "tenants/900001//branding/$KH.png"
rule_is false "malformed path (leading slash)" "$K" 900001 "/tenants/900001/branding/$KH.png"
rule_is false "missing file name" "$K" 900001 "tenants/900001/branding/"
rule_is false "trailing path material after the extension" "$K" 900001 "tenants/900001/branding/$KH.png/extra"
rule_is false "trailing material (.png.bak)" "$K" 900001 "tenants/900001/branding/$KH.png.bak"
rule_is false "prefix-only match (truncated key)" "$K" 900001 "tenants/900001/branding/${KH:0:20}"
rule_is false "prefix-only match (no extension)" "$K" 900001 "tenants/900001/branding/$KH"
rule_is false "extension outside png/jpg/webp (.gif)" "$K" 900001 "tenants/900001/branding/$KH.gif"
rule_is false "extension outside the set (.bin)" "$K" 900001 "tenants/900001/branding/$KH.bin"
rule_is false "uppercase hex (the product's id text is lowercase)" "$K" 900001 "tenants/900001/branding/$(printf '%s' "$KH" | tr a-f A-F).png"
rule_is false "document-shaped key (dashed id, documents directory)" "$K" 900001 "tenants/900001/documents/$K"
rule_is false "empty storage_key" "$K" 900001 ""
rule_is false "NULL storage_key (coalesced to false)" "$K" 900001 NULL
rule_is false "tenant id as a prefix of a longer tenant id" "$K" 90000 "tenants/900001/branding/$KH.png"

echo "== positive and idempotent path"
check "fixture: P2 is a product-shaped branding_logo row (key tenants/<cid>/branding/<hex>.png)" "$(q "select storage_key = 'tenants/' || company_id || '/branding/' || replace(id::text, '-', '') || '.png' from storage_objects where id='$P2'")" "t"
triple="$(run_purge "'$P2','$P3'" "$CA,$CB" 2)"; purge_result_check "$triple" 2 >/dev/null && [ "$(present "$P2")" = "0" ] && [ "$(present "$P3")" = "0" ] && ok "both allow-listed tombstones deleted in one transaction — a document and a product-shaped branding logo ($triple)" || bad "positive path failed ($triple)"
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

echo "== b25phys_inspect — READ-ONLY physical-test residue inspection rules"
APPLY="$HERE/b25-stage1-apply.sh"; WF="$HERE/../workflows/b25-stage1-inspection.yml"
# 1. the manifest is a readonly constant: a later assignment is refused by the shell and the printed manifest never changes
check "manifest constant" "$(b25phys_manifest)" "f048b5d4-b366-4227-857f-42b2589e54b7|53|22|6"
( B25PHYS_COMPANY=1 ) 2>/dev/null && bad "B25PHYS_COMPANY could be reassigned" || ok "B25PHYS_COMPANY is readonly (reassignment refused)"
( B25PHYS_UUID=x ) 2>/dev/null && bad "B25PHYS_UUID could be reassigned" || ok "B25PHYS_UUID is readonly (reassignment refused)"
check "manifest ignores ARG1/ARG2/ARG3 and the environment" "$(ARG1=9 ARG2=9 ARG3="00000000-0000-0000-0000-000000000000|1|1|zzzzzz" B25PHYS_COMPANY_OVERRIDE=1 bash -c 'source "'"$HERE"'/b25-stage1-apply-lib.sh"; b25phys_manifest')" "$(b25phys_manifest)"
# 2. the hosted phase never reads an argument, never writes, and the workflow step passes no ARG
PH="$(awk '/^phase_b25phys_inspect\(\) \{/{on=1} on{print} on && /^\}/{exit}' "$APPLY")"
check "phase body present" "$(printf '%s\n' "$PH" | grep -c '^phase_b25phys_inspect')" "1"
check "phase never references ARG1/ARG2/ARG3" "$(printf '%s\n' "$PH" | grep -cE '\$ARG[123]|\$\{ARG[123]' || true)" "0"
check "phase never calls the writing psql helper (qw)" "$(printf '%s\n' "$PH" | grep -cE '(^|[^a-z_])qw ' || true)" "0"
check "phase never invokes a mutation (delete/update/insert/truncate/drop/alter/rm -r/compose up|down|rm|restart/docker rm)" "$(printf '%s\n' "$PH" | grep -ciE '"(delete|update|insert|truncate|drop|alter) |compose (up|down|rm|restart|stop|kill)|docker (rm|stop|kill|restart)|rm -r|purge_rows_sql|RESIDUE_DELETE_JS|ifGenerationMatch|\.delete\(' || true)" "0"
check "phase writes only the node stderr temp file (removed in-phase)" "$(printf '%s\n' "$PH" | grep -cE '> *"?\$HOME|>>' || true)" "0"
check "phase proves the read-only session before reading (write attempt must fail)" "$(printf '%s\n' "$PH" | grep -c 'create temp table b25_should_fail')" "1"
check "phase fails closed on identity / ownership / provider mismatches (B25PHYS_FATAL)" "$(printf '%s\n' "$PH" | grep -c 'B25PHYS_FATAL')" "1"
check "dispatch entry maps b25phys-inspect to the phase" "$(grep -c '^  b25phys-inspect) phase_b25phys_inspect ;;$' "$APPLY")" "1"
check "no settle / delete phase exists for this manifest" "$(grep -ciE 'b25phys[-_](settle|delete|purge)' "$APPLY" "$WF" "$HERE/b25-stage1-apply-lib.sh" "$HERE/b25-stage1-purge-lib.sh" | awk -F: '{ s += $2 } END { print s + 0 }')" "0"
check "workflow offers b25phys_inspect and no b25phys mutation mode" "$(grep -oE 'b25phys_[a-z]+' "$WF" | sort -u | tr '\n' ' ')" "b25phys_inspect "
check "workflow SSH step for the mode passes no ARG" "$(grep -E "PHASE='b25phys-inspect'" "$WF" | grep -cE "ARG[123]=" || true)" "0"
check "workflow SSH step for the mode exists exactly once" "$(grep -cE "PHASE='b25phys-inspect' bash -s" "$WF")" "1"
check "workflow validation for the mode uses no input and refuses a mutation confirmation" "$(awk '/"\$MODE" = "b25phys_inspect"/{on=1} on && /fi$/{print; exit} on' "$WF" | grep -cE 'need |IN_DRES|IN_SHA|IN_WINDOW')" "0"
check "workflow job guard is the dedicated inspect branch" "$(grep -c "github.ref == 'refs/heads/ops/b25-physical-residue-inspect'" "$WF")" "1"
# 3. the SQL builders are read-only and catalog-driven (local database, read-only session)
check "fk generator refuses a non-integer id" "$(b25phys_fk_counts_gen_sql companies 'x; drop table y' 2>/dev/null | wc -c)" "0"
check "fk generator refuses a non-identifier parent" "$(b25phys_fk_counts_gen_sql 'companies; drop' 1 2>/dev/null | wc -c)" "0"
check "cross-tenant builder refuses a non-integer id" "$(b25phys_cross_tenant_sql '1 or 1=1' 2>/dev/null | wc -c)" "0"
GEN="$(q "$(b25phys_fk_counts_gen_sql companies 900001)")"
check "fk generator finds the catalog's foreign keys to companies (>= 40 single-column constraints)" "$([ "$(q "$GEN" | wc -l)" -ge 40 ] && echo yes || echo no)" "yes"
check "fk counts are all zero for a company that does not exist" "$(q "$GEN" | awk -F'|' '$4 != "0"' | wc -l)" "0"
check "fk counts report the on-delete action per constraint" "$(q "$GEN" | awk -F'|' '$3 !~ /^(cascade|set null|set default|restrict|no action)$/' | wc -l)" "0"
check "fk counts: ai tables cascade, ai_invocations set null" "$(q "$GEN" | grep -E '^(ai_insights|ai_conversations|ai_copilot_outputs|ai_workflow_recommendations|ai_invocations)\|' | cut -d'|' -f1,3 | tr '\n' ' ')" "ai_conversations|cascade ai_copilot_outputs|cascade ai_insights|cascade ai_invocations|set null ai_workflow_recommendations|cascade "
check "plain company_id tables (no fk) include the inventory and the log tables" "$(q "$(q "$(b25phys_plain_company_counts_gen_sql 900001)")" | cut -d'|' -f1 | grep -cE '^(storage_objects|audit_logs|activity_logs)$')" "3"
check "cross-tenant closure of a company that does not exist is 0" "$(q "$(b25phys_cross_tenant_sql 900001)")" "0"
mk SX; ins "$SX" $CA document active NULL no gcs NULL
check "the plain (no-fk) table census counts exactly the synthetic company's storage rows" "$(q "$(q "$(b25phys_plain_company_counts_gen_sql $CA)")" | grep '^storage_objects|' | cut -d'|' -f2)" "$(q "select count(*) from storage_objects where company_id = $CA")"
check "every builder runs inside the read-only session (a write in the same session is refused)" "$(q "create temp table b25phys_should_fail (x int)" >/dev/null 2>&1 && echo wrote || echo refused)" "refused"
# 4. the eligibility evaluator: a golden fact set is TRUE; every mutated prerequisite is FALSE; identity faults are FATAL
golden() { cat <<'F'
company_present=1
company_name_matches=true
users_total=1
users_outside_company=0
users_platform_role=0
admin_candidates=1
admin_user_id=97
contact_ok=true
event_ok=true
event_id=12
events_unexpected=0
document_ok=true
document_versions=1
storage_row_ok=true
storage_linked_to_document=true
provider_present=true
provider_marker_ok=true
provider_marked_is_target=1
provider_size=99
provider_size_matches=true
provider_generation_canonical=true
provider_generation_stable=true
provider_generation_digits=16
live_refs_other=0
deps_blocking=0
cross_tenant_links=0
ai_rows_classified=true
ai_insights=0
ai_conversations=0
ai_copilot_outputs=0
ai_workflow_recommendations=0
ai_invocations=0
jobs_conflicting=0
dead_storage_jobs=0
census_objects=5
census_bytes=1398
census_marked=1
census_md5=36d90200a6dc0b043a11aeadee20863c
storage_rows=1
originals_ok=true
unmarked_md5_ok=true
F
}
verdict() { grep -oE '^B25_PHYSICAL_SETTLEMENT_ELIGIBLE=(TRUE|FALSE)$' | cut -d= -f2; }
fatal()   { grep -oE '^B25PHYS_FATAL=[0-9]+$' | cut -d= -f2; }
G="$(golden | b25phys_eligibility)"
check "golden facts → ELIGIBLE TRUE" "$(printf '%s\n' "$G" | verdict)" "TRUE"
check "golden facts → no fatal condition" "$(printf '%s\n' "$G" | fatal)" "0"
check "golden facts → fifteen conditions evaluated" "$(printf '%s\n' "$G" | grep -c '^cond [0-9]*: ')" "15"
# mut <label> <want FALSE> <want fatal 0|1> <sed expression applied to the golden facts>
mut() {
  local out; out="$(golden | sed -E "$4" | b25phys_eligibility)"
  local v f; v="$(printf '%s\n' "$out" | verdict)"; f="$(printf '%s\n' "$out" | fatal)"
  if [ "$v" = "$2" ] && { [ "$3" = "any" ] || [ "$f" = "$3" ]; }; then ok "$1 → $v fatal=$f"; else bad "$1 → got $v fatal=$f, want $2 fatal=$3"; fi
}
mut "wrong company name fails closed"                      FALSE 1 's/^company_name_matches=true/company_name_matches=false/'
mut "company absent fails closed"                          FALSE 1 's/^company_present=1/company_present=0/'
mut "contact 22 wrong ownership/identity fails closed"     FALSE 1 's/^contact_ok=true/contact_ok=false/'
mut "document 6 wrong ownership fails closed"              FALSE 1 's/^document_ok=true/document_ok=false/'
mut "storage row wrong ownership fails closed"             FALSE 1 's/^storage_row_ok=true/storage_row_ok=false/'
mut "storage row not the document's object fails closed"   FALSE 1 's/^storage_linked_to_document=true/storage_linked_to_document=false/'
mut "provider marker mismatch fails closed"                FALSE 1 's/^provider_marker_ok=true/provider_marker_ok=false/'
mut "provider object absent fails closed"                  FALSE 1 's/^provider_present=true/provider_present=false/'
mut "another marked object fails closed"                   FALSE 1 's/^provider_marked_is_target=1/provider_marked_is_target=0/'
mut "provider size 98 fails closed"                        FALSE 1 's/^provider_size=99/provider_size=98/'
mut "provider size not matching the row fails closed"      FALSE 1 's/^provider_size_matches=true/provider_size_matches=false/'
mut "generation instability → eligibility FALSE (not fatal)"   FALSE 0 's/^provider_generation_stable=true/provider_generation_stable=false/'
mut "non-canonical generation → eligibility FALSE"             FALSE 0 's/^provider_generation_canonical=true/provider_generation_canonical=false/'
mut "unexpected blocking dependency → eligibility FALSE"       FALSE 0 's/^deps_blocking=0/deps_blocking=1/'
mut "cross-tenant link → eligibility FALSE"                    FALSE 0 's/^cross_tenant_links=0/cross_tenant_links=2/'
mut "unexpected extra event → eligibility FALSE"               FALSE 0 's/^events_unexpected=0/events_unexpected=1/'
mut "ambiguous admin (two candidates) → eligibility FALSE"     FALSE 0 's/^admin_candidates=1/admin_candidates=2/'
mut "no admin candidate → eligibility FALSE"                   FALSE 0 's/^admin_candidates=1/admin_candidates=0/; s/^admin_user_id=97/admin_user_id=none/'
mut "admin id not numeric → eligibility FALSE"                 FALSE 0 's/^admin_user_id=97/admin_user_id=none/'
mut "a platform-role user under the company → eligibility FALSE" FALSE 0 's/^users_platform_role=0/users_platform_role=1/'
mut "expected event missing → eligibility FALSE"               FALSE 0 's/^event_ok=true/event_ok=false/; s/^event_id=12/event_id=none/'
mut "live reference outside document 6 → eligibility FALSE"    FALSE 0 's/^live_refs_other=0/live_refs_other=1/'
mut "unclassified AI rows → eligibility FALSE"                 FALSE 0 's/^ai_rows_classified=true/ai_rows_classified=false/'
mut "conflicting job → eligibility FALSE"                      FALSE 0 's/^jobs_conflicting=0/jobs_conflicting=1/'
mut "census object count mismatch → eligibility FALSE"         FALSE 0 's/^census_objects=5/census_objects=6/'
mut "census bytes mismatch → eligibility FALSE"                FALSE 0 's/^census_bytes=1398/census_bytes=1299/'
mut "census digest mismatch → eligibility FALSE"               FALSE 0 's/^census_md5=.*/census_md5=00000000000000000000000000000000/'
mut "marked count mismatch → eligibility FALSE"                FALSE 0 's/^census_marked=1/census_marked=2/'
mut "storage row count mismatch → eligibility FALSE"           FALSE 0 's/^storage_rows=1/storage_rows=0/'
mut "originals drifted → eligibility FALSE"                    FALSE 0 's/^unmarked_md5_ok=true/unmarked_md5_ok=false/'
mut "original references invalid → eligibility FALSE"          FALSE 0 's/^originals_ok=true/originals_ok=false/'
mut "a missing fact never passes (census fact removed)"        FALSE 0 '/^census_md5=/d'
mut "a missing identity fact is fatal (contact fact removed)"  FALSE 1 '/^contact_ok=/d'
check "evaluator ignores malformed lines (no key=value)" "$(printf 'garbage line\n%s\n' "$(golden)" | b25phys_eligibility | verdict)" "TRUE"
# 5. masked e-mail rule
check "masked e-mail: first character, ***, domain only" "$(q "select $(b25phys_mask_email_sql "'alpha.person@tenant.example'")")" "a***@tenant.example"

echo; echo "cleanup tests: $pass passed, $failn failed"
[ "$failn" = "0" ]
