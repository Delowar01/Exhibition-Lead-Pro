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
check "workflow offers only READ-ONLY b25phys modes (inspect, postdelete_verify) and no b25phys mutation mode" "$(grep -oE 'b25phys_[a-z_]+' "$WF" | sort -u | tr '\n' ' ')" "b25phys_inspect b25phys_postdelete_verify "
check "workflow SSH step for the mode passes no ARG" "$(grep -E "PHASE='b25phys-inspect'" "$WF" | grep -cE "ARG[123]=" || true)" "0"
check "workflow SSH step for the mode exists exactly once" "$(grep -cE "PHASE='b25phys-inspect' bash -s" "$WF")" "1"
check "workflow validation for the mode uses no input and refuses a mutation confirmation" "$(awk '/"\$MODE" = "b25phys_inspect"/{on=1} on && /fi$/{print; exit} on' "$WF" | grep -cE 'need |IN_DRES|IN_SHA|IN_WINDOW')" "0"
check "workflow job guard is the dedicated Stage 2A tooling branch (supersedes the physical-residue branches)" "$(grep -c "github.ref == 'refs/heads/ops/b25-stage2a-fs-activation-tooling'" "$WF")" "1"
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
# 5. boolean facts reach the evaluator as the words true/false (psql -tA prints a bare boolean as t/f — the run
#    38808916359 defect): every boolean fact of the phase is cast ::text, and the evaluator never accepts t/f
check "a bare boolean from psql renders as t (why the cast is required)" "$(q "select 1 = 1")" "t"
check "a ::text boolean renders as the word the evaluator expects" "$(q "select (1 = 1)::text")" "true"
check "every boolean fact of the phase is cast ::text (company name, contact, document, storage row, version link)" "$(printf '%s\n' "$PH" | grep -E '^\s*fact (company_name_matches|contact_ok|document_ok|storage_row_ok|storage_linked_to_document) ' | grep -vc '::text")"' || true)" "0"
check "the evaluator treats t as a failed condition, never as true" "$(golden | sed -E 's/^contact_ok=true/contact_ok=t/' | b25phys_eligibility | verdict)" "FALSE"
check "a t value is counted as exactly one failed (fatal) condition, not silently accepted" "$(golden | sed -E 's/^contact_ok=true/contact_ok=t/' | b25phys_eligibility | grep -oE '^B25PHYS_(CONDITIONS_FAILED|FATAL)=[0-9]+$' | tr '\n' ' ')" "B25PHYS_CONDITIONS_FAILED=1 B25PHYS_FATAL=1 "
check "the evaluator accepts the ::text rendering of a TRUE predicate straight from psql" "$(golden | sed -E "s/^contact_ok=true/contact_ok=$(q "select (1 = 1)::text")/" | b25phys_eligibility | verdict)" "TRUE"
check "an actually FALSE predicate rendered ::text still fails eligibility (fatal)" "$(golden | sed -E "s/^document_ok=true/document_ok=$(q "select (1 = 2)::text")/" | b25phys_eligibility | grep -oE '^(B25PHYS_FATAL=[0-9]+|B25_PHYSICAL_SETTLEMENT_ELIGIBLE=[A-Z]+)$' | tr '\n' ' ')" "B25PHYS_FATAL=1 B25_PHYSICAL_SETTLEMENT_ELIGIBLE=FALSE "
check "exactly fifteen conditions are still evaluated (none removed or merged)" "$(grep -cE '^  cond (yes|no) "' "$HERE/b25-stage1-apply-lib.sh")" "15"
check "the golden set fails zero conditions (no condition was weakened into an unconditional pass either way)" "$(golden | b25phys_eligibility | grep -oE '^B25PHYS_CONDITIONS_FAILED=[0-9]+$')" "B25PHYS_CONDITIONS_FAILED=0"
check "the evaluator never hard-codes its verdict (the TRUE/FALSE lines are derived from the failed count)" "$(grep -cE 'if \[ "\$failed" = "0" \]; then echo "B25_PHYSICAL_SETTLEMENT_ELIGIBLE=TRUE"; else echo "B25_PHYSICAL_SETTLEMENT_ELIGIBLE=FALSE"; fi' "$HERE/b25-stage1-apply-lib.sh")" "1"
# 6. masked e-mail rule
check "masked e-mail: first character, ***, domain only" "$(q "select $(b25phys_mask_email_sql "'alpha.person@tenant.example'")")" "a***@tenant.example"

echo "== b25phys_postdelete_verify — READ-ONLY post-operator-deletion tombstone verification rules"
# 1. constants: readonly, never from ARG/env/input
check "post-delete constants (user 100, event 17, version 6, pre-delete digest)" "$B25PHYS_USER|$B25PHYS_EVENT|$B25PHYS_VERSION|$B25PHYS_PRE_GEN_DIGEST" "100|17|6|3545c17e5f3aa940"
( B25PHYS_USER=1 ) 2>/dev/null && bad "B25PHYS_USER could be reassigned" || ok "B25PHYS_USER is readonly (reassignment refused)"
( B25PHYS_PRE_GEN_DIGEST=x ) 2>/dev/null && bad "B25PHYS_PRE_GEN_DIGEST could be reassigned" || ok "B25PHYS_PRE_GEN_DIGEST is readonly (reassignment refused)"
# 2. the phase never reads an argument, never writes, never mutates; the workflow step passes no ARG
PD="$(awk '/^phase_b25phys_postdelete_verify\(\) \{/{on=1} on{print} on && /^\}/{exit}' "$APPLY")"
check "post-delete phase body present" "$(printf '%s\n' "$PD" | grep -c '^phase_b25phys_postdelete_verify')" "1"
check "post-delete phase never references ARG1/ARG2/ARG3" "$(printf '%s\n' "$PD" | grep -cE '\$ARG[123]|\$\{ARG[123]' || true)" "0"
check "post-delete phase never calls the writing psql helper (qw)" "$(printf '%s\n' "$PD" | grep -cE '(^|[^a-z_])qw ' || true)" "0"
check "post-delete phase has no mutation command (delete/update/insert/truncate/drop/alter, compose/docker mutations, rm -r, purge/delete JS, ifGenerationMatch, enqueue call)" "$(printf '%s\n' "$PD" | grep -ciE '"(delete|update|insert|truncate|drop|alter) |compose (up|down|rm|restart|stop|kill)|docker (rm|stop|kill|restart)|rm -r|purge_rows_sql|RESIDUE_DELETE_JS|ifGenerationMatch|\.delete\(|enqueue\(|getQueue' || true)" "0"
check "post-delete phase writes nothing on the host except the node stderr temp file" "$(printf '%s\n' "$PD" | grep -cE '> *"?\$HOME|>>' || true)" "0"
check "post-delete phase proves the read-only session first" "$(printf '%s\n' "$PD" | grep -c 'create temp table b25_should_fail')" "1"
check "post-delete phase waits for the purge job read-only (bounded) and never enqueues or retries it" "$(printf '%s\n' "$PD" | grep -cE 'poll.*-lt 12' )" "1"
check "post-delete phase flags an already-settled inventory as UNEXPECTED (never as success)" "$(printf '%s\n' "$PD" | grep -c 'UNEXPECTED: the inventory already equals the pre-test baseline')" "1"
check "post-delete phase flags an absent provider object as UNEXPECTED" "$(printf '%s\n' "$PD" | grep -c 'UNEXPECTED: the provider object is ABSENT')" "1"
check "every boolean fact of the post-delete phase is cast ::text" "$(printf '%s\n' "$PD" | grep -E '^\s*fact (row_uncertain|row_deleted_at_set|row_lease|row_mirror|row_identity_ok) ' | grep -vc '::text' || true)" "0"
check "dispatch entry maps b25phys-postdelete-verify to the phase" "$(grep -c '^  b25phys-postdelete-verify) phase_b25phys_postdelete_verify ;;$' "$APPLY")" "1"
check "still no settle / delete / purge mode for the physical manifest" "$(grep -ciE 'b25phys[-_](settle|delete|purge)' "$APPLY" "$WF" "$HERE/b25-stage1-apply-lib.sh" "$HERE/b25-stage1-purge-lib.sh" | awk -F: '{ s += $2 } END { print s + 0 }')" "0"
check "workflow offers exactly the two read-only physical modes" "$(grep -oE 'b25phys_[a-z_]+' "$WF" | sort -u | tr '\n' ' ')" "b25phys_inspect b25phys_postdelete_verify "
check "workflow SSH step for the post-delete mode passes no ARG" "$(grep -E "PHASE='b25phys-postdelete-verify'" "$WF" | grep -cE "ARG[123]=" || true)" "0"
check "workflow SSH step for the post-delete mode exists exactly once" "$(grep -cE "PHASE='b25phys-postdelete-verify' bash -s" "$WF")" "1"
check "workflow validation for the read-only physical modes uses no input" "$(awk '/"\$MODE" = "b25phys_inspect"/{on=1} on && /fi$/{print; exit} on' "$WF" | grep -cE 'need |IN_DRES|IN_SHA|IN_WINDOW')" "0"
check "workflow job guard names no earlier ops branch" "$(grep -cE "github.ref == 'refs/heads/ops/b25-(physical|c9|stage1)" "$WF" || true)" "0"
# 3. the evaluator: golden post-delete facts TRUE; every unmet prerequisite FALSE
pgolden() { cat <<'F'
company_absent=true
company_dependents=0
ai_residue=0
user_absent=true
user_refs=0
event_absent=true
event_refs=0
contact_absent=true
contact_refs=0
document_absent=true
document_refs=0
version_absent=true
live_refs=0
row_count=1
row_state=deleted
row_last_error=LEGACY_RETAINED
row_uncertain=false
row_deleted_at_set=true
row_lease=false
row_mirror=false
row_identity_ok=true
provider_present=true
provider_marker_ok=true
provider_marked_is_target=1
provider_size=99
provider_size_matches=true
provider_generation_canonical=true
provider_generation_stable=true
provider_metageneration_stable=true
provider_generation_digits=16
provider_generation_digest=3545c17e5f3aa940
purge_total=1
purge_completed=1
purge_pending_running=0
purge_dead=0
jobs_conflicting=0
dead_storage_jobs=0
census_objects=5
census_bytes=1398
census_marked=1
census_md5=36d90200a6dc0b043a11aeadee20863c
unmarked_md5_ok=true
originals_ok=true
F
}
pverdict() { grep -oE '^B25_POSTDELETE_PROVIDER_SETTLEMENT_ELIGIBLE=(TRUE|FALSE)$' | cut -d= -f2; }
PG="$(pgolden | b25phys_postdelete_eligibility)"
check "post-delete golden facts → ELIGIBLE TRUE" "$(printf '%s\n' "$PG" | pverdict)" "TRUE"
check "post-delete golden facts → zero failed conditions" "$(printf '%s\n' "$PG" | grep -oE '^B25PHYS_POSTDELETE_CONDITIONS_FAILED=[0-9]+$')" "B25PHYS_POSTDELETE_CONDITIONS_FAILED=0"
check "post-delete evaluator evaluates exactly twenty-three conditions" "$(printf '%s\n' "$PG" | grep -c '^post [0-9]*: ')" "23"
check "post-delete evaluator derives its verdict from the failed count (never hard-coded)" "$(grep -cE 'if \[ "\$failed" = "0" \]; then echo "B25_POSTDELETE_PROVIDER_SETTLEMENT_ELIGIBLE=TRUE"; else echo "B25_POSTDELETE_PROVIDER_SETTLEMENT_ELIGIBLE=FALSE"; fi' "$HERE/b25-stage1-apply-lib.sh")" "1"
pmut() { local out; out="$(pgolden | sed -E "$2" | b25phys_postdelete_eligibility)"; local v; v="$(printf '%s\n' "$out" | pverdict)"; if [ "$v" = "FALSE" ]; then ok "$1 → FALSE"; else bad "$1 → got $v, want FALSE"; fi; }
pmut "company 53 still present"                 's/^company_absent=true/company_absent=false/'
pmut "a dependent tenant row remains"            's/^company_dependents=0/company_dependents=1/'
pmut "a tenant AI row remains"                   's/^ai_residue=0/ai_residue=1/'
pmut "user 100 still present"                    's/^user_absent=true/user_absent=false/'
pmut "a row still references user 100"           's/^user_refs=0/user_refs=1/'
pmut "event 17 still present"                    's/^event_absent=true/event_absent=false/'
pmut "a row still references event 17"           's/^event_refs=0/event_refs=1/'
pmut "contact 22 still present"                  's/^contact_absent=true/contact_absent=false/'
pmut "a row still references contact 22"         's/^contact_refs=0/contact_refs=1/'
pmut "document 6 still present"                  's/^document_absent=true/document_absent=false/'
pmut "document version 6 still present"          's/^version_absent=true/version_absent=false/'
pmut "a live application reference remains"      's/^live_refs=0/live_refs=1/'
pmut "storage row absent (row removed early)"    's/^row_count=1/row_count=0/'
pmut "two storage rows"                          's/^row_count=1/row_count=2/'
pmut "row still active (purge not applied)"      's/^row_state=deleted/row_state=active/'
pmut "row still deleting"                        's/^row_state=deleted/row_state=deleting/'
pmut "last_error not LEGACY_RETAINED"            's/^row_last_error=LEGACY_RETAINED/row_last_error=<null>/'
pmut "OWNERSHIP_UNPROVEN row"                    's/^row_last_error=LEGACY_RETAINED/row_last_error=OWNERSHIP_UNPROVEN/'
pmut "publication uncertainty set"               's/^row_uncertain=false/row_uncertain=true/'
pmut "deleted_at missing"                        's/^row_deleted_at_set=true/row_deleted_at_set=false/'
pmut "lease present"                             's/^row_lease=false/row_lease=true/'
pmut "mirror present"                            's/^row_mirror=false/row_mirror=true/'
pmut "row identity drifted (key/reference/size)" 's/^row_identity_ok=true/row_identity_ok=false/'
pmut "provider object absent (unexpected deletion)" 's/^provider_present=true/provider_present=false/'
pmut "provider marker mismatch"                  's/^provider_marker_ok=true/provider_marker_ok=false/'
pmut "another marked object"                     's/^provider_marked_is_target=1/provider_marked_is_target=0/'
pmut "provider size 98"                          's/^provider_size=99/provider_size=98/'
pmut "generation non-canonical"                  's/^provider_generation_canonical=true/provider_generation_canonical=false/'
pmut "generation unstable"                       's/^provider_generation_stable=true/provider_generation_stable=false/'
pmut "metageneration unstable"                   's/^provider_metageneration_stable=true/provider_metageneration_stable=false/'
pmut "generation digest changed since the pre-delete proof" 's/^provider_generation_digest=.*/provider_generation_digest=0000000000000000/'
pmut "purge job never completed"                 's/^purge_completed=1/purge_completed=0/'
pmut "purge job still pending/running"           's/^purge_pending_running=0/purge_pending_running=1/'
pmut "purge job dead"                            's/^purge_dead=0/purge_dead=1/'
pmut "conflicting job active"                    's/^jobs_conflicting=0/jobs_conflicting=1/'
pmut "dead storage job"                          's/^dead_storage_jobs=0/dead_storage_jobs=1/'
pmut "inventory already 4 objects (unexpected early settlement)" 's/^census_objects=5/census_objects=4/'
pmut "inventory bytes already 1299"              's/^census_bytes=1398/census_bytes=1299/'
pmut "marked count 0"                            's/^census_marked=1/census_marked=0/'
pmut "inventory digest mismatch"                 's/^census_md5=.*/census_md5=c1b900fd509bafa1f980d863dc0d195b/'
pmut "originals drifted"                         's/^unmarked_md5_ok=true/unmarked_md5_ok=false/'
pmut "original references invalid"               's/^originals_ok=true/originals_ok=false/'
pmut "a missing fact never passes (row_state removed)" '/^row_state=/d'
check "post-delete evaluator rejects a t boolean rendering" "$(pgolden | sed -E 's/^row_deleted_at_set=true/row_deleted_at_set=t/' | b25phys_postdelete_eligibility | pverdict)" "FALSE"

# =============================================================================
# B25 STAGE 2A — filesystem primary activation tooling (ops/b25-stage2a-fs-activation-tooling)
# =============================================================================
echo "== Stage 2A — constants, branch guard, workflow wiring (static)"
S2A_SHA="e559b0024b28d4a77becdcb10c4168004dddea75"
check "locked product commit" "$STAGE2A_PRODUCT_SHA" "$S2A_SHA"
check "locked previous commit" "$STAGE2A_PREVIOUS_SHA" "72a24378947134ca8e4d3460294474894c9aaee4"
check "locked root / volume / owner / mode" "$STAGE2A_FS_ROOT|$STAGE2A_VOLUME|$STAGE2A_ROOT_OWNER|$STAGE2A_ROOT_MODE" "/data/objects|card-scanner-pro_objectdata|999:999|700"
check "constants are readonly (a later assignment is refused by the shell)" "$(bash -c 'source "'"$HERE"'/b25-stage1-apply-lib.sh"; (STAGE2A_FS_ROOT=/evil) 2>/dev/null; (STAGE2A_PRODUCT_SHA=0) 2>/dev/null; (STAGE2A_FS_ROOT=/evil; echo "$STAGE2A_FS_ROOT") 2>/dev/null; echo "$STAGE2A_FS_ROOT|$STAGE2A_PRODUCT_SHA"')" "/data/objects|$S2A_SHA"
check "an environment value cannot override the locked root" "$(STAGE2A_FS_ROOT=/evil STAGE2A_VOLUME=evil bash -c 'source "'"$HERE"'/b25-stage1-apply-lib.sh"; stage2a_env_lines activate | grep OBJECT_STORAGE_FS_ROOT; echo "$STAGE2A_VOLUME"')" "OBJECT_STORAGE_FS_ROOT=/data/objects
card-scanner-pro_objectdata"
check "workflow BASE_SHA is the product commit (branch = product + ops files only)" "$(grep -cE '^  BASE_SHA: e559b0024b28d4a77becdcb10c4168004dddea75$' "$WF")" "1"
check "workflow STAGE2A_PRODUCT_SHA constant" "$(grep -cE '^  STAGE2A_PRODUCT_SHA: e559b0024b28d4a77becdcb10c4168004dddea75$' "$WF")" "1"
check "workflow offers exactly the five Stage 2A modes" "$(grep -oE 'stage2a_[a-z_]+' "$WF" | grep -E '^stage2a_(precheck|postswitch_verify|activate|smoke|rollback)$' | sort -u | tr '\n' ' ')" "stage2a_activate stage2a_postswitch_verify stage2a_precheck stage2a_rollback stage2a_smoke "
check "typed confirmations are fixed constants" "$(grep -oE '^  REQUIRED_STAGE2A(_SMOKE|_ROLLBACK)?: "[A-Z0-9_]+"$' "$WF" | sed -E 's/^ +//' | tr '\n' ' ')" "REQUIRED_STAGE2A: \"ACTIVATE_B25_STAGE2A_FS_MIRROR_GCS\" REQUIRED_STAGE2A_SMOKE: \"RUN_B25_STAGE2A_DISPOSABLE_SMOKE\" REQUIRED_STAGE2A_ROLLBACK: \"ROLLBACK_B25_STAGE2A_TO_GCS\" "
check "every Stage 1 mutation mode is refused before SSH on this branch" "$(grep -cE 'case "\$MODE" in preflight\|schema_apply\|postdeploy_verify\|residue_settle\|residue_settle_4fff751a3395\) echo "::error::mode' "$WF")" "1"
VALID_LINE="$(grep -n 'name: Validate inputs' "$WF" | head -1 | cut -d: -f1)"; SSH_LINE="$(grep -n 'name: Install SSH key' "$WF" | head -1 | cut -d: -f1)"
check "confirmations are validated BEFORE the SSH key is installed (step order)" "$([ "$VALID_LINE" -lt "$SSH_LINE" ] && echo before || echo after)" "before"
check "activate requires the product commit, the window and ACTIVATE_B25_STAGE2A_FS_MIRROR_GCS" "$(awk '/^            stage2a_activate\)$/{on=1;next} on&&/;;$/{print;exit} on{print}' "$WF" | grep -c 'need confirm_product_sha "$IN_PRODUCT_SHA" "$STAGE2A_PRODUCT_SHA"; need confirm_window "$IN_WINDOW" "$REQUIRED_WINDOW"; need confirm_stage2a "$IN_STAGE2A" "$REQUIRED_STAGE2A"')" "1"
check "activate refuses the smoke / rollback / residue confirmations (mutually exclusive)" "$(awk '/^            stage2a_activate\)$/{on=1;next} on&&/;;$/{print;exit} on{print}' "$WF" | grep -c 'empty confirm_stage2a_smoke "$IN_STAGE2A_SMOKE"; empty confirm_stage2a_rollback "$IN_STAGE2A_ROLLBACK"; empty confirm_residue "$IN_RESIDUE"')" "1"
check "smoke requires RUN_B25_STAGE2A_DISPOSABLE_SMOKE and refuses the activate / rollback confirmations" "$(awk '/^            stage2a_smoke\)$/{on=1;next} on&&/;;$/{print;exit} on{print}' "$WF" | grep -cE 'need confirm_stage2a_smoke "\$IN_STAGE2A_SMOKE" "\$REQUIRED_STAGE2A_SMOKE"|empty confirm_stage2a "\$IN_STAGE2A"; empty confirm_stage2a_rollback')" "2"
check "rollback requires ROLLBACK_B25_STAGE2A_TO_GCS and refuses the activate / smoke confirmations" "$(awk '/^            stage2a_rollback\)$/{on=1;next} on&&/;;$/{print;exit} on{print}' "$WF" | grep -cE 'need confirm_stage2a_rollback "\$IN_STAGE2A_ROLLBACK" "\$REQUIRED_STAGE2A_ROLLBACK"|empty confirm_stage2a "\$IN_STAGE2A"; empty confirm_stage2a_smoke')" "2"
check "the read-only Stage 2A modes refuse EVERY confirmation input" "$(awk '/^            stage2a_precheck\|stage2a_postswitch_verify\)$/{on=1;next} on&&/;;$/{print;exit} on{print}' "$WF" | grep -oE 'empty confirm_[a-z0-9_]+' | sort -u | tr '\n' ' ')" "empty confirm_product_sha empty confirm_residue empty confirm_stage2a empty confirm_stage2a_rollback empty confirm_stage2a_smoke empty confirm_window "
check "no workflow input, env or secret carries the encryption key" "$(grep -cE '^\s+(IN_[A-Z_]+|[A-Z_]+):.*(ENCRYPTION_KEY|secrets\.OBJECT)' "$WF" || true)" "0"
check "no workflow input names a driver, a root or a bucket" "$(grep -cE '^      (driver|fs_root|root|bucket|storage_[a-z_]+):$' "$WF" || true)" "0"
for ph in stage2a-precheck stage2a-postswitch-verify stage2a-activate stage2a-rollback stage2a-state stage2a-smoke-setup stage2a-smoke-verify stage2a-recreate-api stage2a-smoke-settle stage2a-cleanup; do
  check "workflow SSH step for $ph exists exactly once" "$(grep -cE "PHASE='$ph' " "$WF")" "1"
  check "dispatch entry maps $ph to its phase" "$(grep -cE "^  $ph\) phase_$(printf '%s' "$ph" | tr '-' '_') ;;$" "$APPLY")" "1"
done
for ph in stage2a-precheck stage2a-postswitch-verify stage2a-activate stage2a-rollback stage2a-state; do
  check "SSH step for $ph passes no ARG (no value, path or key can arrive through an argument)" "$(grep -E "PHASE='$ph' " "$WF" | grep -cE "ARG[123]=" || true)" "0"
done
check "the activate step requires the TRUE marker from the host" "$(grep -c "grep -qx 'B25_STAGE2A_ACTIVATED=TRUE'" "$WF")" "1"
check "the rollback step requires the OK marker from the host" "$(grep -c "grep -qx 'B25_STAGE2A_ROLLBACK_OK=TRUE'" "$WF")" "1"
check "the state report is an always-step of activate and rollback" "$(grep -cE "if: always\(\) && \(inputs.mode == 'stage2a_activate' \|\| inputs.mode == 'stage2a_rollback'\)" "$WF")" "1"
check "the smoke cleanup is an always-step" "$(grep -cE "if: always\(\) && inputs.mode == 'stage2a_smoke'" "$WF")" "1"
check "the smoke verify streams the fixture facts and the detector on stdin, never as ARG3" "$(grep -cE "printf 'B25_LEAK_DETECTOR=%s\\\\nB25_FIXTURE_SHA256=%s\\\\nB25_FIXTURE_SIZE=%s\\\\nB25_FIXTURE_MARKER=%s\\\\nB25_LOGO_SHA256=%s\\\\nB25_LOGO_SIZE=%s\\\\n'" "$WF")" "1"
check "the smoke runs with SMOKE_STAGE=2a" "$(grep -c 'echo "SMOKE_STAGE=2a"' "$WF")" "1"
check "branch guard refuses a migration wrapper in the scripts" "$(grep -c "a migration wrapper is present on the Stage 2A tooling branch" "$WF")" "1"

echo "== Stage 2A — fixed environment rendering (no value, name, root or key can be supplied)"
E="$(mktemp -d)"
cat > "$E/before.env" <<'ENV'
# runtime env (synthetic test copy — never the hosted file)
DATABASE_URL=postgres://u:p@postgres:5432/db
SESSION_SECRET=0123456789abcdef0123456789abcdef
COMPOSE_PROFILES=local-db
OBJECT_STORAGE_DRIVER=
OBJECT_STORAGE_FS_ROOT=
OBJECT_STORAGE_ENCRYPTION_KEY=
OBJECT_STORAGE_LEGACY_FALLBACK=
OBJECT_STORAGE_MIRROR=
OBJECT_STORAGE_LEGACY_DELETE=
DEFAULT_OBJECT_STORAGE_BUCKET_ID=synthetic-bucket
PRIVATE_OBJECT_DIR=/synthetic-bucket/.private
GOOGLE_APPLICATION_CREDENTIALS=/secrets/gcs-service-account.json
GCS_CREDENTIAL_GID=1001
ENV
# the owner stages the key line (synthetic value; shape only)
KEYLINE="OBJECT_STORAGE_ENCRYPTION_KEY=$(printf 'a%.0s' $(seq 1 64))"
sed -i "s|^OBJECT_STORAGE_ENCRYPTION_KEY=$|$KEYLINE|" "$E/before.env"
stage2a_env_render activate < "$E/before.env" > "$E/after.env"
check "activation renders exactly the five fixed managed lines, at the end, in order" "$(tail -5 "$E/after.env" | tr '\n' ' ')" "OBJECT_STORAGE_DRIVER=fs OBJECT_STORAGE_FS_ROOT=/data/objects OBJECT_STORAGE_LEGACY_FALLBACK=true OBJECT_STORAGE_MIRROR=gcs OBJECT_STORAGE_LEGACY_DELETE=false "
check "activation keeps every unmanaged line byte for byte (database, session, bucket, credentials, comments)" "$(grep -vE '^OBJECT_STORAGE_(DRIVER|FS_ROOT|LEGACY_FALLBACK|MIRROR|LEGACY_DELETE)=' "$E/after.env" | md5sum | cut -c1-32)" "$(grep -vE '^OBJECT_STORAGE_(DRIVER|FS_ROOT|LEGACY_FALLBACK|MIRROR|LEGACY_DELETE)=' "$E/before.env" | md5sum | cut -c1-32)"
check "activation preserves the owner's key line verbatim (never rendered from a parameter)" "$(grep -c "^$KEYLINE$" "$E/after.env")" "1"
check "activation removes the empty placeholders of the managed names (each name appears once)" "$(grep -cE '^OBJECT_STORAGE_(DRIVER|FS_ROOT|LEGACY_FALLBACK|MIRROR|LEGACY_DELETE)=' "$E/after.env")" "5"
check "rendering is idempotent" "$(stage2a_env_render activate < "$E/after.env" | md5sum | cut -c1-32)" "$(md5sum < "$E/after.env" | cut -c1-32)"
check "the rendered activation passes the before/after check" "$(stage2a_env_check_rendered activate "$E/before.env" "$E/after.env" >/dev/null && echo accepted || echo rejected)" "accepted"
check "legacyDelete cannot be enabled: a true line is replaced by false" "$(printf 'OBJECT_STORAGE_LEGACY_DELETE=true\nX=1\n' | stage2a_env_render activate | grep '^OBJECT_STORAGE_LEGACY_DELETE=')" "OBJECT_STORAGE_LEGACY_DELETE=false"
check "an arbitrary driver cannot be supplied (extra arguments are ignored; no parameter is a value)" "$(stage2a_env_render activate memory /evil < "$E/before.env" | grep -E '^OBJECT_STORAGE_(DRIVER|FS_ROOT)=' | tr '\n' ' ')" "OBJECT_STORAGE_DRIVER=fs OBJECT_STORAGE_FS_ROOT=/data/objects "
check "an unknown mode is refused" "$(stage2a_env_render purge < "$E/before.env" 2>/dev/null | wc -c)" "0"
stage2a_env_render rollback < "$E/after.env" > "$E/rollback.env"
check "rollback renders DRIVER=gcs explicitly, fallback false, mirror off, legacy delete false" "$(tail -4 "$E/rollback.env" | tr '\n' ' ')" "OBJECT_STORAGE_DRIVER=gcs OBJECT_STORAGE_LEGACY_FALLBACK=false OBJECT_STORAGE_MIRROR= OBJECT_STORAGE_LEGACY_DELETE=false "
check "rollback leaves the fs root line configured (DRIVER=gcs wins the resolution)" "$(grep -c '^OBJECT_STORAGE_FS_ROOT=/data/objects$' "$E/rollback.env")" "1"
check "rollback preserves the key line" "$(grep -c "^$KEYLINE$" "$E/rollback.env")" "1"
check "rollback passes the before/after check against the activated file" "$(stage2a_env_check_rendered rollback "$E/after.env" "$E/rollback.env" >/dev/null && echo accepted || echo rejected)" "accepted"
sed 's|^DATABASE_URL=.*|DATABASE_URL=postgres://evil|' "$E/after.env" > "$E/bad1.env"
check "the check rejects an after-file whose unmanaged line changed" "$(stage2a_env_check_rendered activate "$E/before.env" "$E/bad1.env" >/dev/null 2>&1 && echo accepted || echo rejected)" "rejected"
grep -v '^OBJECT_STORAGE_ENCRYPTION_KEY=' "$E/after.env" > "$E/bad2.env"
check "the check rejects an after-file that lost the key line" "$(stage2a_env_check_rendered activate "$E/before.env" "$E/bad2.env" >/dev/null 2>&1 && echo accepted || echo rejected)" "rejected"
sed 's|^OBJECT_STORAGE_DRIVER=fs$|OBJECT_STORAGE_DRIVER=memory|' "$E/after.env" > "$E/bad3.env"
check "the check rejects a managed line outside the fixed set (driver memory)" "$(stage2a_env_check_rendered activate "$E/before.env" "$E/bad3.env" >/dev/null 2>&1 && echo accepted || echo rejected)" "rejected"
sed 's|^OBJECT_STORAGE_FS_ROOT=/data/objects$|OBJECT_STORAGE_FS_ROOT=/evil|' "$E/after.env" > "$E/bad4.env"
check "the check rejects an arbitrary root" "$(stage2a_env_check_rendered activate "$E/before.env" "$E/bad4.env" >/dev/null 2>&1 && echo accepted || echo rejected)" "rejected"
sed 's|^OBJECT_STORAGE_LEGACY_DELETE=false$|OBJECT_STORAGE_LEGACY_DELETE=true|' "$E/after.env" > "$E/bad5.env"
check "the check rejects legacy deletion enabled" "$(stage2a_env_check_rendered activate "$E/before.env" "$E/bad5.env" >/dev/null 2>&1 && echo accepted || echo rejected)" "rejected"
check "the library never prints a line of either file (fixed-text reasons only)" "$(stage2a_env_check_rendered activate "$E/before.env" "$E/bad1.env" 2>&1 | grep -c 'postgres://' || true)" "0"
check "the key line shape rule accepts 64 lowercase hex and nothing else" "$(printf '%s\n' "$KEYLINE" | grep -cE "$STAGE2A_KEY_LINE_SHAPE")|$(printf 'OBJECT_STORAGE_ENCRYPTION_KEY=%s\n' "$(printf 'A%.0s' $(seq 1 64))" | grep -cE "$STAGE2A_KEY_LINE_SHAPE" || true)|$(printf 'OBJECT_STORAGE_ENCRYPTION_KEY=%s\n' "$(printf 'a%.0s' $(seq 1 63))" | grep -cE "$STAGE2A_KEY_LINE_SHAPE" || true)" "1|0|0"
rm -rf "$E"

echo "== Stage 2A — pre-switch evaluator (golden TRUE; every mutated prerequisite FALSE; exactly 30 conditions)"
s2golden() { cat <<'F'
head_sha=e559b0024b28d4a77becdcb10c4168004dddea75
current_deploy_sha=e559b0024b28d4a77becdcb10c4168004dddea75
previous_deploy_sha=72a24378947134ca8e4d3460294474894c9aaee4
dirty=0
worktrees=1
api_running=true
web_running=true
pg_running=true
api_health=healthy
web_health=healthy
pg_health=healthy
readyz_status=ok
readyz_database=ok
readyz_storage=ok
lock_absent=true
deploy_settled=true
stale_worktree_absent=true
stale_image_absent=true
leftover_files=0
storage_jobs_active=0
dead_storage_jobs=0
dead_jobs_total=0
schema_fingerprint=30c4ecbd867cd2cd59abcb58581ecb04
init_record_found=true
init_driver=gcs
init_fallback=false
init_mirror=false
init_legacy_delete=false
env_names_set=0
banner_root_not_set=true
env_core_identity_ok=true
env_mode=600
key_line_count=1
volume_exists=true
volume_driver=local
mount_type=volume
mount_name=card-scanner-pro_objectdata
mount_rw=true
root_owner=999:999
root_mode=700
root_is_symlink=false
root_is_dir=true
root_regular_files=0
root_entries_allowed=true
disk_avail_bytes=70411067392
inodes_free=12030013
exc_row_count=1
exc_state=deleted
exc_last_error=LEGACY_RETAINED
exc_driver=gcs
exc_company=53
exc_kind=document
exc_size=99
exc_identity_ok=true
exc_uncertain=false
exc_lease=false
exc_mirror=false
exc_live_refs=0
exc_company_absent=true
exc_provider_present=true
exc_provider_marker_ok=true
exc_provider_size_matches=true
exc_generation_canonical=true
exc_generation_stable=true
exc_generation_digest=3545c17e5f3aa940
inv_uncertain=0
inv_unproven=0
inv_cleanup_pending=0
inv_leases=0
inv_inflight=0
inv_total=1
inv_active=0
census_objects=5
census_bytes=1398
census_marked=1
census_md5=36d90200a6dc0b043a11aeadee20863c
unmarked_objects=4
unmarked_md5=c1b900fd509bafa1f980d863dc0d195b
refs_count=4
originals_referenced=4
originals_present=4
originals_missing=0
originals_size_match=4
F
}
s2v() { grep -oE '^B25_STAGE2A_PRECHECK_ELIGIBLE=(TRUE|FALSE)$' | cut -d= -f2; }
G2="$(s2golden | stage2a_precheck_eligibility)"
check "precheck golden facts → ELIGIBLE TRUE" "$(printf '%s\n' "$G2" | s2v)" "TRUE"
check "precheck golden facts → zero failed conditions" "$(printf '%s\n' "$G2" | grep -oE '^B25_STAGE2A_PRECHECK_CONDITIONS_FAILED=[0-9]+$')" "B25_STAGE2A_PRECHECK_CONDITIONS_FAILED=0"
check "precheck evaluates exactly thirty conditions" "$(printf '%s\n' "$G2" | grep -c '^pre [0-9]*: ')" "30"
check "precheck verdict is derived from the failed count (never hard-coded)" "$(grep -cE 'if \[ "\$failed" = "0" \]; then echo "B25_STAGE2A_PRECHECK_ELIGIBLE=TRUE"; else echo "B25_STAGE2A_PRECHECK_ELIGIBLE=FALSE"; fi' "$HERE/b25-stage1-apply-lib.sh")" "1"
check "precheck without a key line is still eligible (the key is staged by the owner later, never by the tooling)" "$(s2golden | sed -E 's/^key_line_count=1/key_line_count=0/' | stage2a_precheck_eligibility | s2v)" "TRUE"
s2mut() { local v; v="$(s2golden | sed -E "$2" | stage2a_precheck_eligibility | s2v)"; if [ "$v" = "FALSE" ]; then ok "precheck: $1 → FALSE"; else bad "precheck: $1 → got $v, want FALSE"; fi; }
s2mut "wrong deployed SHA (previous commit still deployed)" 's/^head_sha=.*/head_sha=72a24378947134ca8e4d3460294474894c9aaee4/'
s2mut "current-deploy.sha differs from the checkout" 's/^current_deploy_sha=.*/current_deploy_sha=0000000000000000000000000000000000000000/'
s2mut "dirty checkout" 's/^dirty=0/dirty=1/'
s2mut "api unhealthy" 's/^api_health=healthy/api_health=unhealthy/'
s2mut "readiness storage error" 's/^readyz_storage=ok/readyz_storage=error/'
s2mut "activation lock present" 's/^lock_absent=true/lock_absent=false/'
s2mut "stale migrate image present" 's/^stale_image_absent=true/stale_image_absent=false/'
s2mut "a storage job running" 's/^storage_jobs_active=0/storage_jobs_active=1/'
s2mut "a dead storage job" 's/^dead_storage_jobs=0/dead_storage_jobs=1/'
s2mut "schema fingerprint drifted" 's/^schema_fingerprint=.*/schema_fingerprint=ce55dfa2959cc89c2baad2923217842a/'
s2mut "wrong current driver (fs already active)" 's/^init_driver=gcs/init_driver=fs/'
s2mut "no startup record" 's/^init_record_found=true/init_record_found=false/'
s2mut "fallback already true" 's/^init_fallback=false/init_fallback=true/'
s2mut "mirror already on" 's/^init_mirror=false/init_mirror=true/'
s2mut "legacy delete true" 's/^init_legacy_delete=false/init_legacy_delete=true/'
s2mut "an OBJECT_STORAGE_* variable already set in the container" 's/^env_names_set=0/env_names_set=1/'
s2mut "fs root active (banner says set)" 's/^banner_root_not_set=true/banner_root_not_set=false/'
s2mut "env file core identity drifted" 's/^env_core_identity_ok=true/env_core_identity_ok=false/'
s2mut "env file mode 644" 's/^env_mode=600/env_mode=644/'
s2mut "two key lines" 's/^key_line_count=1/key_line_count=2/'
s2mut "volume absent" 's/^volume_exists=true/volume_exists=false/'
s2mut "mounted as a bind (not the named volume)" 's/^mount_type=volume/mount_type=bind/'
s2mut "another volume name" 's/^mount_name=.*/mount_name=other_volume/'
s2mut "mounted read-only" 's/^mount_rw=true/mount_rw=false/'
s2mut "wrong owner" 's/^root_owner=999:999/root_owner=0:0/'
s2mut "wrong mode" 's/^root_mode=700/root_mode=755/'
s2mut "symlink root" 's/^root_is_symlink=false/root_is_symlink=true/'
s2mut "root not a directory" 's/^root_is_dir=true/root_is_dir=false/'
s2mut "an object already on the volume" 's/^root_regular_files=0/root_regular_files=1/'
s2mut "a foreign entry under the root" 's/^root_entries_allowed=true/root_entries_allowed=false/'
s2mut "disk below the floor" 's/^disk_avail_bytes=.*/disk_avail_bytes=1073741824/'
s2mut "inodes below the floor" 's/^inodes_free=.*/inodes_free=999/'
s2mut "disk value malformed" 's/^disk_avail_bytes=.*/disk_avail_bytes=unavailable/'
s2mut "Stage 1 exception row absent" 's/^exc_row_count=1/exc_row_count=0/'
s2mut "Stage 1 exception no longer deleted" 's/^exc_state=deleted/exc_state=active/'
s2mut "Stage 1 exception not LEGACY_RETAINED" 's/^exc_last_error=LEGACY_RETAINED/exc_last_error=<null>/'
s2mut "Stage 1 exception driver changed" 's/^exc_driver=gcs/exc_driver=fs/'
s2mut "Stage 1 exception size changed" 's/^exc_size=99/exc_size=98/'
s2mut "Stage 1 exception identity drifted" 's/^exc_identity_ok=true/exc_identity_ok=false/'
s2mut "Stage 1 exception uncertain" 's/^exc_uncertain=false/exc_uncertain=true/'
s2mut "Stage 1 exception gained a live reference" 's/^exc_live_refs=0/exc_live_refs=1/'
s2mut "company 53 reappeared" 's/^exc_company_absent=true/exc_company_absent=false/'
s2mut "Stage 1 provider object absent" 's/^exc_provider_present=true/exc_provider_present=false/'
s2mut "Stage 1 provider marker mismatch" 's/^exc_provider_marker_ok=true/exc_provider_marker_ok=false/'
s2mut "Stage 1 generation digest changed" 's/^exc_generation_digest=.*/exc_generation_digest=0000000000000000/'
s2mut "a provider-uncertain row" 's/^inv_uncertain=0/inv_uncertain=1/'
s2mut "an OWNERSHIP_UNPROVEN row" 's/^inv_unproven=0/inv_unproven=1/'
s2mut "a CLEANUP_PENDING row" 's/^inv_cleanup_pending=0/inv_cleanup_pending=1/'
s2mut "a lease held" 's/^inv_leases=0/inv_leases=1/'
s2mut "an in-flight row" 's/^inv_inflight=0/inv_inflight=1/'
s2mut "a second inventory row" 's/^inv_total=1/inv_total=2/'
s2mut "starting GCS census: 4 objects" 's/^census_objects=5/census_objects=4/'
s2mut "starting GCS census: bytes differ" 's/^census_bytes=1398/census_bytes=1299/'
s2mut "starting GCS census: marked count" 's/^census_marked=1/census_marked=2/'
s2mut "starting GCS census: digest mismatch" 's/^census_md5=.*/census_md5=c1b900fd509bafa1f980d863dc0d195b/'
s2mut "originals drifted" 's/^unmarked_md5=.*/unmarked_md5=00000000000000000000000000000000/'
s2mut "a legacy reference missing at the provider" 's/^originals_missing=0/originals_missing=1/'
s2mut "a missing fact never passes (init_driver removed)" '/^init_driver=/d'
check "precheck rejects a t boolean rendering" "$(s2golden | sed -E 's/^root_is_dir=true/root_is_dir=t/' | stage2a_precheck_eligibility | s2v)" "FALSE"

echo "== Stage 2A — post-switch evaluator (golden TRUE; every mutated prerequisite FALSE; exactly 22 conditions)"
s2pgolden() { cat <<'F'
head_sha=e559b0024b28d4a77becdcb10c4168004dddea75
current_deploy_sha=e559b0024b28d4a77becdcb10c4168004dddea75
dirty=0
api_running=true
api_health=healthy
web_health=healthy
pg_health=healthy
readyz_status=ok
readyz_database=ok
readyz_storage=ok
readyz_inside=ok
banner_driver=fs
banner_root_set=true
banner_key_set=true
banner_fallback=true
banner_mirror=gcs
init_record_found=true
init_driver=fs
init_fallback=true
init_mirror=true
init_legacy_delete=false
init_encryption=configured
init_records_current=1
log_refusals=0
env_driver_is_fs=true
env_root_is_locked=true
env_fallback_is_true=true
env_mirror_is_gcs=true
env_legacy_delete_off=true
env_key_set=true
env_file_managed_ok=true
env_file_key_lines=1
env_mode=600
env_core_identity_ok=true
log_mirror_failures=0
log_integrity_failures=0
log_init_failures=0
log_level50=0
log_status5xx=0
inv_uncertain=0
inv_unproven=0
inv_cleanup_pending=0
inv_retained_legacy=1
inv_total=1
inv_active=0
inv_leases=0
exc_row_count=1
exc_state=deleted
exc_last_error=LEGACY_RETAINED
exc_driver=gcs
exc_identity_ok=true
exc_uncertain=false
exc_live_refs=0
exc_provider_present=true
exc_provider_marker_ok=true
exc_provider_size_matches=true
exc_generation_canonical=true
exc_generation_stable=true
exc_generation_digest=3545c17e5f3aa940
census_objects=5
census_bytes=1398
census_marked=1
census_md5=36d90200a6dc0b043a11aeadee20863c
unmarked_objects=4
unmarked_md5=c1b900fd509bafa1f980d863dc0d195b
refs_count=4
originals_present=4
originals_missing=0
originals_size_match=4
mount_type=volume
mount_name=card-scanner-pro_objectdata
mount_rw=true
root_owner=999:999
root_mode=700
root_is_symlink=false
root_is_dir=true
root_writable=true
root_tenant_files=0
root_entries_allowed=true
leak_root_path=0
leak_key_shaped=0
leak_key_assignment=0
leak_bucket_ref=0
leak_signature=0
web_leak_root_path=0
web_leak_signature=0
F
}
s2pv() { grep -oE '^B25_STAGE2A_POSTSWITCH_READY=(TRUE|FALSE)$' | cut -d= -f2; }
PG2="$(s2pgolden | stage2a_postswitch_eligibility)"
check "post-switch golden facts → READY TRUE" "$(printf '%s\n' "$PG2" | s2pv)" "TRUE"
check "post-switch golden facts → zero failed conditions" "$(printf '%s\n' "$PG2" | grep -oE '^B25_STAGE2A_POSTSWITCH_CONDITIONS_FAILED=[0-9]+$')" "B25_STAGE2A_POSTSWITCH_CONDITIONS_FAILED=0"
check "post-switch evaluates exactly twenty-two conditions" "$(printf '%s\n' "$PG2" | grep -c '^post-switch [0-9]*: ')" "22"
check "post-switch verdict is derived from the failed count (never hard-coded)" "$(grep -cE 'if \[ "\$failed" = "0" \]; then echo "B25_STAGE2A_POSTSWITCH_READY=TRUE"; else echo "B25_STAGE2A_POSTSWITCH_READY=FALSE"; fi' "$HERE/b25-stage1-apply-lib.sh")" "1"
s2pmut() { local v; v="$(s2pgolden | sed -E "$2" | stage2a_postswitch_eligibility | s2pv)"; if [ "$v" = "FALSE" ]; then ok "post-switch: $1 → FALSE"; else bad "post-switch: $1 → got $v, want FALSE"; fi; }
s2pmut "driver not fs (startup record)" 's/^init_driver=fs/init_driver=gcs/'
s2pmut "driver not fs (banner)" 's/^banner_driver=fs/banner_driver=<auto>/'
s2pmut "driver not fs (container environment)" 's/^env_driver_is_fs=true/env_driver_is_fs=false/'
s2pmut "fallback false" 's/^init_fallback=true/init_fallback=false/'
s2pmut "fallback false (container environment)" 's/^env_fallback_is_true=true/env_fallback_is_true=false/'
s2pmut "mirror off" 's/^init_mirror=true/init_mirror=false/'
s2pmut "mirror off (banner)" 's/^banner_mirror=gcs/banner_mirror=off/'
s2pmut "legacyDelete true" 's/^init_legacy_delete=false/init_legacy_delete=true/'
s2pmut "legacyDelete true (container environment)" 's/^env_legacy_delete_off=true/env_legacy_delete_off=false/'
s2pmut "encryption not configured (ephemeral test key)" 's/^init_encryption=configured/init_encryption=ephemeral-test-key/'
s2pmut "key not set in the container" 's/^env_key_set=true/env_key_set=false/'
s2pmut "root not the locked path" 's/^env_root_is_locked=true/env_root_is_locked=false/'
s2pmut "env file managed lines not the fixed set" 's/^env_file_managed_ok=true/env_file_managed_ok=false/'
s2pmut "env file key line count 0" 's/^env_file_key_lines=1/env_file_key_lines=0/'
s2pmut "env file core identity drifted" 's/^env_core_identity_ok=true/env_core_identity_ok=false/'
s2pmut "api not healthy" 's/^api_health=healthy/api_health=starting/'
s2pmut "readiness storage error" 's/^readyz_storage=ok/readyz_storage=error/'
s2pmut "readiness inside the container not ok" 's/^readyz_inside=ok/readyz_inside=not-ok/'
s2pmut "mirror failure counter nonzero" 's/^log_mirror_failures=0/log_mirror_failures=1/'
s2pmut "integrity failure counter nonzero" 's/^log_integrity_failures=0/log_integrity_failures=1/'
s2pmut "an initialization failure was logged" 's/^log_init_failures=0/log_init_failures=1/'
s2pmut "an error-level record since the switch" 's/^log_level50=0/log_level50=1/'
s2pmut "a 5xx since the switch" 's/^log_status5xx=0/log_status5xx=1/'
s2pmut "publication uncertainty nonzero" 's/^inv_uncertain=0/inv_uncertain=1/'
s2pmut "ownership unproven nonzero" 's/^inv_unproven=0/inv_unproven=1/'
s2pmut "cleanup pending nonzero" 's/^inv_cleanup_pending=0/inv_cleanup_pending=1/'
s2pmut "retainedLegacyObjects != 1 (0)" 's/^inv_retained_legacy=1/inv_retained_legacy=0/'
s2pmut "retainedLegacyObjects != 1 (2)" 's/^inv_retained_legacy=1/inv_retained_legacy=2/'
s2pmut "Stage 1 exception changed (state)" 's/^exc_state=deleted/exc_state=deleting/'
s2pmut "Stage 1 exception changed (last_error)" 's/^exc_last_error=LEGACY_RETAINED/exc_last_error=OWNERSHIP_UNPROVEN/'
s2pmut "Stage 1 exception changed (identity)" 's/^exc_identity_ok=true/exc_identity_ok=false/'
s2pmut "Stage 1 provider object absent" 's/^exc_provider_present=true/exc_provider_present=false/'
s2pmut "Stage 1 provider object changed (digest)" 's/^exc_generation_digest=.*/exc_generation_digest=ffffffffffffffff/'
s2pmut "GCS inventory changed before the smoke" 's/^census_md5=.*/census_md5=00000000000000000000000000000000/'
s2pmut "originals changed" 's/^unmarked_objects=4/unmarked_objects=3/'
s2pmut "volume not writable by the runtime" 's/^root_writable=true/root_writable=false/'
s2pmut "a tenant object already on the volume" 's/^root_tenant_files=0/root_tenant_files=1/'
s2pmut "symlink root" 's/^root_is_symlink=false/root_is_symlink=true/'
s2pmut "storage path leaked into the api log" 's/^leak_root_path=0/leak_root_path=1/'
s2pmut "key-shaped token in the api log" 's/^leak_key_shaped=0/leak_key_shaped=1/'
s2pmut "key assignment with a value in the api log" 's/^leak_key_assignment=0/leak_key_assignment=1/'
s2pmut "signed-URL text in the web log" 's/^web_leak_signature=0/web_leak_signature=1/'
s2pmut "storage path leaked into the web log" 's/^web_leak_root_path=0/web_leak_root_path=1/'
s2pmut "the process initialized storage twice" 's/^init_records_current=1/init_records_current=2/'
s2pmut "a missing fact never passes (init_mirror removed)" '/^init_mirror=/d'
check "post-switch rejects a t boolean rendering" "$(s2pgolden | sed -E 's/^env_key_set=true/env_key_set=t/' | stage2a_postswitch_eligibility | s2pv)" "FALSE"

echo "== Stage 2A — fs tombstone allow-list (stage2a_purge_rows_sql) against the local database"
# ins_fs <id> <company> <kind> <state> <last_error|NULL> <uncertain yes|no> <driver> <mirror canon|other|NULL> <mirror_state|NULL> <legacy set|NULL>
ins_fs() {
  local id="$1" cid="$2" kind="$3" state="$4" err="$5" unc="$6" drv="$7" mk="$8" ms="$9" lg="${10}" ref key
  if [ "$kind" = "branding_logo" ]; then ref="branding/$cid/$(hex "$id").png"; key="tenants/$cid/branding/$(hex "$id").png"; else ref="/objects/$id"; key="tenants/$cid/documents/$id"; fi
  local errsql="null"; [ "$err" != "NULL" ] && errsql="'$err'"
  local uncsql="null"; [ "$unc" = "yes" ] && uncsql="now()"
  local mksql="null"; [ "$mk" = "canon" ] && mksql="'gs://synthetic/$key'"; [ "$mk" = "other" ] && mksql="'gs://synthetic/tenants/$cid/documents/other'"
  local mssql="null"; [ "$ms" != "NULL" ] && mssql="'$ms'"
  local lgsql="null"; [ "$lg" = "set" ] && lgsql="'gs://synthetic/$key'"
  qw "insert into storage_objects (id, company_id, kind, reference, storage_key, driver, legacy_key, content_type, size_bytes, sha256, state, last_error, publication_uncertain_at, mirror_key, mirror_state, deleted_at, created_at, updated_at) values ('$id', $cid, '$kind', '$ref', '$key', '$drv', $lgsql, 'application/pdf', 10, repeat('a',64), '$state', $errsql, $uncsql, $mksql, $mssql, case when '$state' in ('deleted','deleting') then now() else null end, now(), now())" >/dev/null
}
run_fs_purge() { local triple; triple="$(qw "$(stage2a_purge_rows_sql "$1" "$2" "$3")")"; echo "$triple"; }
check "the deny constants are the Stage 1 exception" "$STAGE2A_DENY_UUID|$STAGE2A_DENY_COMPANY" "f048b5d4-b366-4227-857f-42b2589e54b7|53"
check "the rule text denies the exception uuid and company by constant" "$(stage2a_purge_rows_sql "'00000000-0000-0000-0000-000000000000'" "900001" 1 | grep -cE "l\.id <> 'f048b5d4-b366-4227-857f-42b2589e54b7'|l\.company_id <> 53")" "2"
mk F1; ins_fs "$F1" $CA document deleted NULL no gcs canon ok NULL
mk F2; ins_fs "$F2" $CA document deleted LEGACY_RETAINED no fs canon ok NULL
mk F3; ins_fs "$F3" $CA document deleted NULL no fs NULL NULL NULL
mk F4; ins_fs "$F4" $CA document deleted NULL no fs canon failed NULL
mk F5; ins_fs "$F5" $CA document deleted NULL no fs other ok NULL
mk F6; ins_fs "$F6" $CA document deleted NULL no fs canon ok set
mk F7; ins_fs "$F7" $CA document deleted NULL yes fs canon ok NULL
mk F8; ins_fs "$F8" $CA document active NULL no fs canon ok NULL
mk F9; ins_fs "$F9" $CA document deleted OWNERSHIP_UNPROVEN no fs canon ok NULL
mk F10; ins_fs "$F10" $CA document deleted CLEANUP_PENDING no fs canon ok NULL
mk F11; ins_fs "$F11" 1 document deleted NULL no fs canon ok NULL
mk F12; ins_fs "$F12" $CA document deleting NULL no fs canon ok NULL
for pair in "$F1:gcs driver (Stage 1 shape)" "$F2:LEGACY_RETAINED on an fs row" "$F3:no mirror location" "$F4:mirror_state failed" "$F5:mirror location not the canonical bucket key" "$F6:legacy location set on an fs row" "$F7:publication uncertainty" "$F8:active row" "$F9:OWNERSHIP_UNPROVEN" "$F10:CLEANUP_PENDING" "$F11:company still exists (company 1)" "$F12:deleting (not settled)"; do
  id="${pair%%:*}"; label="${pair#*:}"
  triple="$(run_fs_purge "'$id'" "$CA,$CB,1" 1)"
  if [[ "$triple" == 0\|* ]] && [ "$(present "$id")" = "1" ]; then ok "fs purge refused: $label ($triple)"; else bad "fs purge NOT refused: $label ($triple, present=$(present "$id"))"; fi
done
# the Stage 1 exception uuid is denied even in a shape that would otherwise pass, whatever company list is given
if [ "$(q "select count(*) from storage_objects where id = '$STAGE2A_DENY_UUID'")" = "0" ]; then
  IDS+=("$STAGE2A_DENY_UUID"); ins_fs "$STAGE2A_DENY_UUID" $CA document deleted NULL no fs canon ok NULL
  triple="$(run_fs_purge "'$STAGE2A_DENY_UUID'" "$CA" 1)"
  if [[ "$triple" == 0\|1\|0 ]] && [ "$(present "$STAGE2A_DENY_UUID")" = "1" ]; then ok "fs purge can never select the Stage 1 exception uuid ($triple)"; else bad "the Stage 1 exception uuid was not denied ($triple)"; fi
  qw "delete from storage_objects where id = '$STAGE2A_DENY_UUID' and company_id = $CA" >/dev/null
else
  echo "note: the local database already holds the exception uuid — deny-by-uuid exercised by the rule-text check only"
fi
if [ "$(q "select count(*) from companies where id = 53")" = "0" ]; then
  mk F13; ins_fs "$F13" 53 document deleted NULL no fs canon ok NULL
  triple="$(run_fs_purge "'$F13'" "53" 1)"
  if [[ "$triple" == 0\|1\|0 ]] && [ "$(present "$F13")" = "1" ]; then ok "fs purge can never select a row of company 53 ($triple)"; else bad "a company-53 row was not denied ($triple)"; fi
  qw "delete from storage_objects where id = '$F13' and company_id = 53" >/dev/null
else
  echo "note: company 53 exists locally — deny-by-company exercised by the rule-text check only"
fi
mk F14; ins_fs "$F14" $CA document deleted NULL no fs canon ok NULL
mk F15; ins_fs "$F15" $CB branding_logo deleted NULL no fs canon ok NULL
mk F16; ins_fs "$F16" $CA document deleted NULL no fs canon ok NULL
triple="$(run_fs_purge "'$F14'" "$CA,$CB" 1)"; check "explicit list only: an eligible row outside the list is untouched" "$(present "$F16")" "1"; purge_result_check "$triple" 1 >/dev/null && ok "fs purge removed the one listed eligible row ($triple)" || bad "fs purge did not remove the listed row ($triple)"
triple="$(run_fs_purge "'$F15','$F8'" "$CA,$CB" 2)"; if [[ "$triple" == 0\|2\|1 ]] && [ "$(present "$F15")" = "1" ]; then ok "fs purge: count mismatch refuses the whole transaction ($triple)"; else bad "fs purge count mismatch did not refuse ($triple)"; fi
triple="$(run_fs_purge "'$F15','$F16'" "$CA,$CB" 2)"; purge_result_check "$triple" 2 >/dev/null && [ "$(present "$F15")" = "0" ] && [ "$(present "$F16")" = "0" ] && ok "fs purge removed a document and a product-shaped branding logo in one transaction ($triple)" || bad "fs purge positive path failed ($triple)"
triple="$(run_fs_purge "'$F15','$F16'" "$CA,$CB" 0)"; [[ "$triple" == 0\|0\|0 ]] && ok "fs purge second run: already removed → 0|0|0" || bad "fs purge second run changed something ($triple)"
check "the Stage 1 purge rule (unchanged) still refuses an fs-shaped row" "$(run_purge "'$F3'" "$CA,$CB" 1 | cut -d'|' -f1)" "0"

echo "== Stage 2A — phase bodies (static: read-only modes never write; the key is never read; the activation is narrow)"
body() { awk -v f="$1" '$0 ~ "^"f"\\(\\) \\{" {on=1} on {print} on && /^}$/ {exit}' "$APPLY"; }
for fn in stage2a_precheck_run stage2a_postswitch_run phase_stage2a_state stage2a_host_facts stage2a_init_facts stage2a_container_env_facts stage2a_root_facts stage2a_exception_facts stage2a_readyz_facts; do
  B="$(body "$fn")"
  check "$fn: body present" "$(printf '%s\n' "$B" | grep -c "^$fn")" "1"
  check "$fn: never calls the writing psql helper (qw)" "$(printf '%s\n' "$B" | grep -cE '(^|[^a-z_])qw ' || true)" "0"
  check "$fn: no mutation command (sql writes, compose/docker mutations, rm -r, object deletes, env edits, recreate)" "$(printf '%s\n' "$B" | grep -ciE '"(delete|update|insert|truncate|drop|alter) |compose (up|down|rm|restart|stop|kill)|docker (rm|stop|kill|restart|volume rm)|rm -r|purge_rows_sql|ifGenerationMatch|\.delete\(|stage2a_env_apply|stage2a_recreate_api|mv -f|> *"?\$ENV_FILE' || true)" "0"
  check "$fn: never references ARG1/ARG2/ARG3" "$(printf '%s\n' "$B" | grep -cE '\$ARG[123]|\$\{ARG[123]' || true)" "0"
done
check "the read-only phases prove the read-only session before reading" "$(body stage2a_precheck_run | grep -c stage2a_readonly_guard)|$(body stage2a_postswitch_run | grep -c stage2a_readonly_guard)" "1|1"
check "the precheck performs no write test on the volume (facts come from stat / find / test only)" "$(body stage2a_root_facts | grep -cE 'touch|mktemp|dd |> *"?\$R|cp |tee ' || true)" "0"
check "the key is never captured: every grep on the key pattern is a count or an exclusion" "$(grep -E 'grep[^|]*(STAGE2A_KEY_RE|STAGE2A_KEY_LINE_SHAPE)' "$APPLY" | grep -vE 'grep -(c|cE|vE|v) ' | wc -l)" "0"
check "no phase echoes, cats or captures the env file content (only digests, counts and modes)" "$(grep -cE '(cat|less|head|tail|sed -n|awk)[^|]*"\$ENV_FILE"' "$APPLY" || true)" "0"
check "the container environment is compared to fixed values inside the container and never printed" "$(body stage2a_container_env_facts | grep -cE 'echo "?\$OBJECT_STORAGE|printf.*\$OBJECT_STORAGE|env$|printenv' || true)" "0"
AB="$(body phase_stage2a_activate)"
check "activate runs the fresh precheck gate before taking the lock" "$(printf '%s\n' "$AB" | grep -n -E 'stage2a_precheck_run|stage2a_lock' | head -2 | cut -d: -f2 | sed -E 's/^\s+//' | cut -c1-24 | tr '\n' '|')" "stage2a_precheck_run || |stage2a_lock|"
check "activate requires exactly one well-formed owner-staged key line (counted with grep -c, never read)" "$(printf '%s\n' "$AB" | grep -c '\[ "$kl" = "1" \] && \[ "$ks" = "1" \] || fail')" "1"
S2BLOCK="$(awk '/^# B25 STAGE 2A — FILESYSTEM PRIMARY ACTIVATION TOOLING/{on=1} on{print} /^case "\$PHASE" in$/{exit}' "$APPLY")"
check "activate renders ONLY through the fixed rendering (stage2a_env_apply activate) and recreates ONLY the api service" "$(printf '%s\n' "$AB" | grep -c 'stage2a_env_apply activate')|$(body stage2a_recreate_api | grep -c 'compose up -d --no-deps --force-recreate api')|$(printf '%s\n' "$S2BLOCK" | grep -cE 'compose (up|restart|stop|down|rm)' || true)|$(printf '%s\n' "$S2BLOCK" | grep -cE 'compose (up|restart|stop|down|rm)[^|]*(postgres|web)' || true)" "1|1|1|0"
check "the Stage 2A block never touches a volume, the database container or the web container" "$(printf '%s\n' "$S2BLOCK" | grep -ciE 'docker volume (rm|prune)|docker (rm|stop|kill|restart)|compose exec -T (postgres|web) [^|]*(delete|drop|truncate|rm )' || true)" "0"
check "activate rolls back on an unhealthy api and on a FALSE post-switch verification" "$(printf '%s\n' "$AB" | grep -c 'stage2a_rollback_inner ||')" "2"
check "activate reports the TRUE marker only after the post-switch verification" "$(printf '%s\n' "$AB" | grep -n -E 'stage2a_postswitch_run|B25_STAGE2A_ACTIVATED=TRUE' | cut -d: -f1 | tr '\n' ' ' | awk '{ print (NF == 2 && $1 < $2) ? "verify-then-marker" : "wrong-order" }')" "verify-then-marker"
check "the env writer edits only through the rendering + check pair and keeps mode 600" "$(body stage2a_env_apply | grep -cE 'stage2a_env_render "\$mode"|stage2a_env_check_rendered "\$mode"|chmod 600 "\$ENV_FILE"')" "3"
check "the env writer never edits with sed -i, echo >> or a text editor" "$(body stage2a_env_apply | grep -cE 'sed -i|>> *"?\$ENV_FILE|vi |nano ' || true)" "0"
check "the rollback record holds digests only (no env line is copied)" "$(body stage2a_env_record_write | grep -cE 'cat "\$ENV_FILE"|cp "?\$ENV_FILE' || true)" "0"
RB="$(body stage2a_rollback_inner)"
check "rollback uses the fixed rollback rendering (DRIVER=gcs explicit in the library)" "$(printf '%s\n' "$RB" | grep -c 'stage2a_env_apply rollback')|$(stage2a_env_lines rollback | head -1)" "1|OBJECT_STORAGE_DRIVER=gcs"
check "rollback never deletes an fs file or a bucket object" "$(printf '%s\n' "$RB" | grep -ciE 'rm -|unlink|\.delete\(|ifGenerationMatch|find[^|]*-delete|purge_rows_sql' || true)" "0"
check "rollback proves the bucket primary healthy again (startup record gcs / fallback off / mirror off / legacy delete off) and the inventory unchanged" "$(printf '%s\n' "$RB" | grep -c 'STAGE2A_INIT_GCS')|$(printf '%s\n' "$RB" | grep -c 'bucket inventory changed across the rollback')" "1|1"
check "the activation lock is released on exit" "$(body stage2a_lock | grep -c "trap 'rm -f \"\$STAGE2A_LOCK_FILE\"' EXIT")" "1"
SV="$(body phase_stage2a_smoke_verify)"; SS="$(body phase_stage2a_smoke_settle)"; SC="$(body phase_stage2a_cleanup)"
check "smoke verify: disposable targets only, the exception can never be a smoke row, every row on fs with an ok canonical mirror" "$(printf '%s\n' "$SV" | grep -cE "name not like 'B25 SMOKE %'|the Stage 1 exception can never be a smoke row|driver <> 'fs'|mirror_state is distinct from 'ok'|not the canonical bucket key")" "5"
check "smoke verify: exact bytes / digest, encrypted file without the plaintext marker, mirror marker + canonical generation + digest required" "$(printf '%s\n' "$SV" | grep -oE 'B25_FIXTURE_SHA256|marker_free|magic_ok|marker_ok|generation_ok|sha_ok' | sort -u | wc -l)" "6"
check "smoke verify: the leak gate and the root-path gate are hard failures" "$(printf '%s\n' "$SV" | grep -cE 'fail "this run.s capability found|fail "the storage root path appears in a log')" "5"
check "smoke settle: cleanup requires the exact recorded ids and can never select the exception uuid or company 53" "$(printf '%s\n' "$SS" | grep -cE 'can never be a recorded smoke row|can never be a smoke company|was not recorded during this run|belongs to a non-smoke company')" "4"
check "smoke settle: both disposable copies must be proven absent before any row is removed" "$(printf '%s\n' "$SS" | grep -n -E 'STAGE2A_FS_ABSENT_JS|STAGE2A_PROVIDER_ABSENT_JS|stage2a_purge_rows_sql' | cut -d: -f1 | tr '\n' ' ' | awk '{ if ($1 < $3 && $2 < $3) print "absence-before-removal"; else print "wrong-order" }')" "absence-before-removal"
check "smoke settle: provider census must return exactly to the locked pre-smoke values and the exception row must be intact" "$(printf '%s\n' "$SS" | grep -cE 'stage2a_census_expect "\$B25PHYS_CENSUS_OBJECTS" "\$B25PHYS_CENSUS_BYTES" "\$B25PHYS_CENSUS_MARKED" "\$B25PHYS_CENSUS_MD5"|the Stage 1 exception row changed')" "2"
check "smoke cleanup: final state = the exception row only, census locked, no tenant file on the volume" "$(printf '%s\n' "$SC" | grep -cE 'not back to the one documented exception row|stage2a_census_expect|a tenant file remains on the volume')" "3"
check "no Stage 2A phase uses the existing 99-byte exception as a smoke object" "$(grep -cE "B25PHYS_UUID.*(upload|fixture|smoke object)" "$APPLY" || true)" "0"

echo "== Stage 2A — smoke script (static) and general guards"
SMOKE="$HERE/b25-stage1-smoke.mjs"
check "smoke script parses" "$(node --check "$SMOKE" >/dev/null 2>&1 && echo ok || echo fail)" "ok"
check "smoke script accepts only SMOKE_STAGE 1 or 2a" "$(grep -c 'if (STAGE !== "1" && STAGE !== "2a") throw' "$SMOKE")" "1"
check "stage 2a expects driver fs / fallback true / mirror true / legacyReads fallback and zero failure counters" "$(grep -cE 'st\.driver === "fs" && st\.legacyFallback === true && st\.mirror === true && st\.legacyReads === "fallback"|st\.mirrorFailures === 0 && st\.integrityFailures === 0' "$SMOKE")" "2"
check "stage 2a fixture is deterministic and carries the plaintext marker" "$(grep -cE 'B25-STAGE2A-PLAINTEXT-MARKER-\$\{TAG\}|repeat\(512\)' "$SMOKE")" "2"
check "stage 2a keeps the logo for the tenant purge (replace / remove only in stage 1)" "$(awk '/if \(STAGE2A\) \{/{on=1} on&&/logo kept for the tenant purge/{print "kept"; exit}' "$SMOKE")" "kept"
check "cross-tenant 404, platform-owner 403 and anonymous 401 probes remain" "$(grep -cE 'cross-tenant GET → 404|platform owner GET → 403|anonymous GET → 401' "$SMOKE")" "3"
check "the query-string credential guard is unchanged" "$(grep -c 'refusing a query-string value that is not the synthetic probe' "$SMOKE")" "1"
check "no new origin was added to the smoke script" "$(grep -cE '^const HOSTED_(CUSTOMER|PLATFORM) = ' "$SMOKE")" "2"
check "no Stage 2B migration wrapper in the ops scripts" "$(grep -cE 'migrate.storage|--dry-run|--copy|--verify' "$APPLY" "$HERE/b25-stage1-apply-lib.sh" "$HERE/b25-stage1-purge-lib.sh" | awk -F: '{ s += $2 } END { print s + 0 }')" "0"
check "no GCS retirement in the ops files (no driver / dependency / credential removal)" "$(grep -ciE 'gcs-driver\.ts|@google-cloud/storage"? *(removed|delete)|rm .*gcs-service-account|GCS_CREDENTIAL_GID=' "$APPLY" "$WF" "$HERE/b25-stage1-apply-lib.sh" "$HERE/b25-stage1-purge-lib.sh" | awk -F: '{ s += $2 } END { print s + 0 }')" "0"
check "no EAS / APK / mobile build path in the ops files (the Stage 1 device-confirmation constant is text, not a build)" "$(grep -ciE 'eas build|eas\.json|expo (build|run)|gradlew|assembleRelease|\.apk' "$APPLY" "$WF" "$HERE/b25-stage1-apply-lib.sh" "$HERE/b25-stage1-purge-lib.sh" "$SMOKE" | awk -F: '{ s += $2 } END { print s + 0 }')" "0"
check "no B26 path in the ops files" "$(grep -c 'B26' "$APPLY" "$WF" "$HERE/b25-stage1-apply-lib.sh" "$HERE/b25-stage1-purge-lib.sh" "$SMOKE" | awk -F: '{ s += $2 } END { print s + 0 }')" "0"
check "OBJECT_STORAGE_LEGACY_DELETE=true never appears in the ops files" "$(grep -c 'OBJECT_STORAGE_LEGACY_DELETE=true' "$APPLY" "$WF" "$HERE/b25-stage1-apply-lib.sh" | awk -F: '{ s += $2 } END { print s + 0 }')" "0"
check "bash -n passes for every script" "$(bash -n "$APPLY" && bash -n "$HERE/b25-stage1-apply-lib.sh" && bash -n "$HERE/b25-stage1-purge-lib.sh" && bash -n "$HERE/b25-stage1-cleanup.test.sh" && echo ok)" "ok"
check "the workflow parses as YAML with the single Stage 2A job" "$(python3 -I -c 'import yaml,sys; d=yaml.safe_load(open(sys.argv[1])); print(list(d["jobs"].keys())[0], d["jobs"]["stage1"]["if"].split(" && ")[0])' "$WF" 2>/dev/null || echo "yaml unavailable")" "stage1 github.ref == 'refs/heads/ops/b25-stage2a-fs-activation-tooling'"

echo; echo "cleanup tests: $pass passed, $failn failed"
[ "$failn" = "0" ]
