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
check "the read-only Stage 2A modes refuse EVERY confirmation input" "$(awk '/^            stage2a_precheck\|stage2a_postswitch_verify\|stage2a_residue_inspect_1c512c90f2c8\|stage2a_residue_inspect_5d408c442c64\|stage2a_residue_inspect_ec7ceda89a58\|stage2a_tenant_drift_inspect\)$/{on=1;next} on&&/;;$/{print;exit} on{print}' "$WF" | grep -oE 'empty confirm_[a-z0-9_]+' | sort -u | tr '\n' ' ')" "empty confirm_product_sha empty confirm_residue empty confirm_stage2a empty confirm_stage2a_residue empty confirm_stage2a_residue2 empty confirm_stage2a_residue3 empty confirm_stage2a_rollback empty confirm_stage2a_smoke empty confirm_window "
check "no workflow input, env or secret carries the encryption key" "$(grep -cE '^\s+(IN_[A-Z_]+|[A-Z_]+):.*(ENCRYPTION_KEY|secrets\.OBJECT)' "$WF" || true)" "0"
check "no workflow input names a driver, a root or a bucket" "$(grep -cE '^      (driver|fs_root|root|bucket|storage_[a-z_]+):$' "$WF" || true)" "0"
for ph in stage2a-precheck stage2a-postswitch-verify stage2a-activate stage2a-rollback stage2a-state stage2a-smoke-setup stage2a-smoke-verify stage2a-recreate-api stage2a-smoke-settle stage2a-cleanup stage2a-residue-eligibility stage2a-residue-settle stage2a-residue2-eligibility stage2a-residue2-settle stage2a-tenant-drift; do
  check "workflow SSH step for $ph exists exactly once" "$(grep -cE "PHASE='$ph' " "$WF")" "1"
  check "dispatch entry maps $ph to its phase" "$(grep -cE "^  $ph\) phase_$(printf '%s' "$ph" | tr '-' '_') ;;$" "$APPLY")" "1"
done
for ph in stage2a-precheck stage2a-postswitch-verify stage2a-activate stage2a-rollback stage2a-state stage2a-residue-eligibility stage2a-residue-settle stage2a-residue2-eligibility stage2a-residue2-settle stage2a-tenant-drift; do
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
for fn in stage2a_precheck_run stage2a_postswitch_run phase_stage2a_state stage2a_host_facts stage2a_init_facts stage2a_container_env_facts stage2a_root_facts stage2a_exception_facts stage2a_readyz_facts stage2a_residue_eligibility_run stage2a_residue_row_facts stage2a_residue_blobs stage2a_residue_fs_facts stage2a_residue_provider_facts stage2a_residue_host_facts stage2a_residue2_eligibility_run stage2a_residue2_row_facts stage2a_residue2_blobs phase_stage2a_tenant_drift stage2a_tenant_drift_table_facts s2a_counts_line; do
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


# =============================================================================
# B25 STAGE 2A — CORRECTION 1 (failed smoke run 38847884691, tag 1c512c90f2c8)
#                CORRECTION 2 (failed corrected smoke run 38922592504, tag 5d408c442c64)
# =============================================================================
echo "== Correction 2 — served-logo rules (pure functions of the smoke, behavioural with canned responses)"
# contentLengthRule / servedLogoRule are extracted verbatim from the smoke and exercised with canned responses:
# Content-Length absent → accepted; present + exact → accepted; present + malformed / smaller / larger → rejected;
# the stored-logo expectation comes ONLY from the authenticated body; the public body must be byte-identical.
RULES_DIR="$(mktemp -d)"
cleanup_all() { rm -rf "$RULES_DIR"; if declare -f cleanup_s2ar >/dev/null; then cleanup_s2ar; fi; if declare -f cleanup_c3 >/dev/null; then cleanup_c3; fi; cleanup; }   # the modeled-settlement cleanup is added once it exists
trap cleanup_all EXIT
{ echo 'const { createHash } = require("node:crypto");'; echo 'const sha256 = (b) => createHash("sha256").update(b).digest("hex");'
  awk '/^function contentLengthRule\(/{on=1} on{print} on&&/^}$/{exit}' "$SMOKE"; awk '/^function servedLogoRule\(/{on=1} on{print} on&&/^}$/{exit}' "$SMOKE"
  cat <<'JS'
const H = (cl) => ({ get: (k) => (k === "content-length" ? (cl === undefined ? null : cl) : null) });
const A = Buffer.from("\x89PNG\r\n\x1a\nserved-normalized-logo-bytes-A"); const B = Buffer.from("\x89PNG\r\n\x1a\nserved-normalized-logo-bytes-B"); // same length, different bytes
const upload = Buffer.from("\x89PNG\r\n\x1a\nuploaded-fixture-which-is-never-the-stored-object");
const r = (status, ct, buf, cl) => ({ status, contentType: ct, buf, headers: H(cl) });
const out = [];
const cl = (label, h, n) => { const v = contentLengthRule(H(h), n); out.push(`${label}=${v.ok ? "ok" : "fail"}/present=${v.present}/exact=${v.exact}`); };
cl("cl_absent", undefined, 181); cl("cl_exact", "181", 181); cl("cl_zero_body_exact", "0", 0); cl("cl_leading_zero", "0181", 181); cl("cl_list", "181, 181", 181);
cl("cl_negative", "-1", 181); cl("cl_space", " 181", 181); cl("cl_smaller", "180", 181); cl("cl_larger", "182", 181); cl("cl_text", "abc", 181);
const v = (label, auth, pub) => { const x = servedLogoRule(auth, pub); out.push(`${label}=${x.ok ? "ok" : "fail"}`); return x; };
const g = v("golden", r(200, "image/png", A), r(200, "image/png", A));
out.push(`golden_sha_is_auth=${g.logoSha === sha256(A)}`); out.push(`golden_size_is_auth=${g.logoSize === A.length}`); out.push(`golden_sha_not_upload=${g.logoSha !== sha256(upload)}`); out.push(`golden_size_not_upload=${g.logoSize !== upload.length}`);
out.push(`golden_public_facts=${g.public.status}/${g.public.contentType}/${g.public.length === A.length}/${g.public.contentLengthPresent}/${Object.keys(g.public).sort().join(",")}`);
v("auth_404", r(404, "image/png", A), r(200, "image/png", A)); v("auth_json", r(200, "application/json", A), r(200, "image/png", A)); v("auth_empty", r(200, "image/png", Buffer.alloc(0)), r(200, "image/png", A));
v("auth_cl_mismatch", r(200, "image/png", A, String(A.length + 1)), r(200, "image/png", A)); v("auth_cl_malformed", r(200, "image/png", A, "01"), r(200, "image/png", A)); v("auth_cl_exact", r(200, "image/png", A, String(A.length)), r(200, "image/png", A)); v("auth_cl_absent", r(200, "image/png", A), r(200, "image/png", A));
const nf = v("auth_fail_no_expectation", r(500, "image/png", A), r(200, "image/png", A)); out.push(`auth_fail_sha_null=${nf.logoSha === null && nf.logoSize === 0}`);
v("pub_404", r(200, "image/png", A), r(404, "image/png", A)); v("pub_html", r(200, "image/png", A), r(200, "text/html", A)); v("pub_empty", r(200, "image/png", A), r(200, "image/png", Buffer.alloc(0)));
v("pub_cl_absent", r(200, "image/png", A), r(200, "image/png", A)); v("pub_cl_exact", r(200, "image/png", A), r(200, "image/png", A, String(A.length))); v("pub_cl_mismatch", r(200, "image/png", A), r(200, "image/png", A, String(A.length - 1))); v("pub_cl_malformed", r(200, "image/png", A), r(200, "image/png", A, "1e3"));
v("pub_same_length_different_bytes", r(200, "image/png", A), r(200, "image/png", B)); v("pub_different_length", r(200, "image/png", A), r(200, "image/png", Buffer.concat([A, Buffer.from("x")]))); v("pub_is_upload_not_stored", r(200, "image/png", A), r(200, "image/png", upload));
v("pub_jpeg_type_same_bytes", r(200, "image/png", A), r(200, "image/jpeg", A));
console.log(out.join("\n"));
JS
} > "$RULES_DIR/rules.js"
RULES_OUT="$(node "$RULES_DIR/rules.js" 2>&1 || echo "harness_failed=$?")"
rule() { printf '%s\n' "$RULES_OUT" | sed -nE "s/^$1=(.*)$/\1/p" | head -1; }
check "the two rule functions extract and run as plain functions (no harness failure; 36 canned cases answered)" "$(printf '%s\n' "$RULES_OUT" | grep -c 'harness_failed' || true)|$(printf '%s\n' "$RULES_OUT" | grep -cE '^(cl_|golden|auth_|pub_)')" "0|36"
check "Content-Length absent → accepted (present=false)" "$(rule cl_absent)" "ok/present=false/exact=null"
check "Content-Length present and exact → accepted" "$(rule cl_exact)|$(rule cl_zero_body_exact)" "ok/present=true/exact=true|ok/present=true/exact=true"
check "Content-Length present but malformed (leading zero / list / negative / space / text) → rejected" "$(rule cl_leading_zero)|$(rule cl_list)|$(rule cl_negative)|$(rule cl_space)|$(rule cl_text)" "fail/present=true/exact=false|fail/present=true/exact=false|fail/present=true/exact=false|fail/present=true/exact=false|fail/present=true/exact=false"
check "Content-Length present but smaller / larger than the body → rejected" "$(rule cl_smaller)|$(rule cl_larger)" "fail/present=true/exact=false|fail/present=true/exact=false"
check "golden: authenticated 200 image + identical public bytes → ok; expectation = sha256 / length of the AUTHENTICATED body" "$(rule golden)|$(rule golden_sha_is_auth)|$(rule golden_size_is_auth)" "ok|true|true"
check "the uploaded fixture's digest / size are never the expectation (different object → different facts)" "$(rule golden_sha_not_upload)|$(rule golden_size_not_upload)" "true|true"
check "sanitized public facts only (status / content type / length / content-length presence, value, exactness — nothing else)" "$(rule golden_public_facts)" "200/image/png/true/false/contentLengthExact,contentLengthPresent,contentLengthValue,contentType,length,status"
check "authenticated route must serve 200 + image/* + non-empty body (404 / json / empty → rejected)" "$(rule auth_404)|$(rule auth_json)|$(rule auth_empty)" "fail|fail|fail"
check "authenticated Content-Length: absent → ok, exact → ok, mismatch → rejected, malformed → rejected" "$(rule auth_cl_absent)|$(rule auth_cl_exact)|$(rule auth_cl_mismatch)|$(rule auth_cl_malformed)" "ok|ok|fail|fail"
check "no expectation exists before the authenticated GET succeeded (logoSha null, logoSize 0 on failure)" "$(rule auth_fail_no_expectation)|$(rule auth_fail_sha_null)" "fail|true"
check "public route must serve 200 + image/* + non-empty body (404 / html / empty → rejected)" "$(rule pub_404)|$(rule pub_html)|$(rule pub_empty)" "fail|fail|fail"
check "public Content-Length: absent → ok, exact → ok, mismatch → rejected, malformed → rejected" "$(rule pub_cl_absent)|$(rule pub_cl_exact)|$(rule pub_cl_mismatch)|$(rule pub_cl_malformed)" "ok|ok|fail|fail"
check "public body must equal the authenticated body byte-for-byte (same length / different bytes, different length, the upload instead of the stored object → rejected)" "$(rule pub_same_length_different_bytes)|$(rule pub_different_length)|$(rule pub_is_upload_not_stored)" "fail|fail|fail"
check "a different image content type with identical bytes is still accepted as an image (type is checked for image/*, bytes for identity)" "$(rule pub_jpeg_type_same_bytes)" "ok"

echo "== Correction 2 — logo smoke flow (static rule over the shipped smoke + verify body; golden; mutations)"
# logo_flow_rule prints ok, or the first broken rule: the authenticated route is observed first, the expectation is the
# rule verdict only, the public route is fetched afterwards and judged by servedLogoRule, no upload / public / row
# derived expectation exists, and the VPS verification still demands BOTH digest and size from the stdin stream.
logo_flow_rule() {   # <smoke text> <verify-body text>
  local sm="$1" vb="$2" a g p s
  [ "$(printf '%s\n' "$sm" | grep -cE '^function contentLengthRule\(headers, bodyLength\) \{$')" = "1" ] && [ "$(printf '%s\n' "$sm" | grep -cE '^function servedLogoRule\(auth, pub\) \{$')" = "1" ] || { echo "rule-functions-missing"; return 0; }
  [ "$(printf '%s\n' "$sm" | grep -cF 's.logoSha = verdict.logoSha; s.logoSize = verdict.logoSize;')" = "1" ] || { echo "no-verdict-assignment"; return 0; }
  [ "$(printf '%s\n' "$sm" | grep -cE 's\.logoSha = sha256\(logo\)|s\.logoSize = logo\.length|s\.logoSha = sha256\(rd\.buf\)|s\.logoSize = rd\.buf\.length' || true)" = "0" ] || { echo "upload-or-public-derived-assignment"; return 0; }
  g="$(printf '%s\n' "$sm" | grep -nF 'const au = await api("GET", "/api/organization/branding/logo", { token: tA });' | head -1 | cut -d: -f1)"
  a="$(printf '%s\n' "$sm" | grep -nF 's.logoSha = verdict.logoSha; s.logoSize = verdict.logoSize;' | head -1 | cut -d: -f1)"
  p="$(printf '%s\n' "$sm" | awk '/if \(STAGE2A\) \{/{on=1} on&&/const rd = await api\("GET", logoPath\);/{print NR; exit}')"
  s="$(printf '%s\n' "$sm" | grep -nF 'const verdict = servedLogoRule(asServed(au), asServed(rd));' | head -1 | cut -d: -f1)"
  [ -n "$g" ] && [ -n "$a" ] && [ -n "$p" ] && [ -n "$s" ] || { echo "flow-lines-missing"; return 0; }
  [ "$g" -lt "$p" ] || { echo "public-fetched-before-authenticated"; return 0; }
  [ "$p" -lt "$s" ] && [ "$s" -lt "$a" ] || { echo "assignment-not-after-verdict"; return 0; }
  [ "$(printf '%s\n' "$sm" | grep -cF 'must("stage 2a: public randomized route serves exactly the authenticated stored bytes')" = "1" ] || { echo "public-equality-not-required"; return 0; }
  [ "$(printf '%s\n' "$vb" | grep -cF "kind = 'branding_logo' and sha256 = '\$B25_LOGO_SHA256' and size_bytes = \$B25_LOGO_SIZE\")\" = \"1\" ] || fail \"exactly one branding_logo row must carry the logo digest and size\"")" = "1" ] || { echo "vps-assertion-weakened-or-missing"; return 0; }
  [ "$(printf '%s\n' "$vb" | grep -cE '\[\[ "\$\{B25_LOGO_SHA256:-\}" =~ \^\[0-9a-f\]\{64\}\$ \]\] && \[\[ "\$\{B25_LOGO_SIZE:-\}" =~ \^\[1-9\]\[0-9\]\*\$ \]\] \|\| fail')" = "1" ] || { echo "vps-stdin-facts-not-required"; return 0; }
  echo ok
}
SMOKE_TXT="$(cat "$SMOKE")"; VERIFY_TXT="$(body phase_stage2a_smoke_verify)"
check "golden: the shipped smoke + verify satisfy the authenticated-first / verdict-only / public-equality rule" "$(logo_flow_rule "$SMOKE_TXT" "$VERIFY_TXT")" "ok"
check "mutation: the former upload-derived recording is rejected" "$(logo_flow_rule "$(printf '%s\n' "$SMOKE_TXT" | sed 's/s\.logoSha = verdict\.logoSha; s\.logoSize = verdict\.logoSize;/s.logoSha = sha256(logo); s.logoSize = logo.length;/')" "$VERIFY_TXT")" "no-verdict-assignment"
check "mutation: a public-route-derived recording (rd.buf) is rejected" "$(logo_flow_rule "$(printf '%s\n' "$SMOKE_TXT" | sed 's/s\.logoSha = verdict\.logoSha; s\.logoSize = verdict\.logoSize;/s.logoSha = verdict.logoSha; s.logoSize = verdict.logoSize; s.logoSha = sha256(rd.buf);/')" "$VERIFY_TXT")" "upload-or-public-derived-assignment"
check "mutation: removing the verdict assignment is rejected" "$(logo_flow_rule "$(printf '%s\n' "$SMOKE_TXT" | grep -vF 's.logoSha = verdict.logoSha; s.logoSize = verdict.logoSize;')" "$VERIFY_TXT")" "no-verdict-assignment"
check "mutation: fetching the public route BEFORE the authenticated observation is rejected" "$(logo_flow_rule "$(printf '%s\n' "$SMOKE_TXT" | awk '/const au = await api\("GET", "\/api\/organization\/branding\/logo"/{print "    const rd = await api(\"GET\", logoPath);"} {print}')" "$VERIFY_TXT")" "public-fetched-before-authenticated"
check "mutation: assigning the expectation before the verdict exists is rejected" "$(logo_flow_rule "$(printf '%s\n' "$SMOKE_TXT" | awk '/const verdict = servedLogoRule\(asServed\(au\), asServed\(rd\)\);/{print "    s.logoSha = verdict.logoSha; s.logoSize = verdict.logoSize;"} {print}' | awk 'BEGIN{n=0} /s\.logoSha = verdict\.logoSha; s\.logoSize = verdict\.logoSize;/{n++; if (n==2) next} {print}')" "$VERIFY_TXT")" "assignment-not-after-verdict"
check "mutation: dropping the public byte-equality requirement is rejected" "$(logo_flow_rule "$(printf '%s\n' "$SMOKE_TXT" | grep -vF 'must("stage 2a: public randomized route serves exactly the authenticated stored bytes')" "$VERIFY_TXT")" "public-equality-not-required"
check "mutation: removing a rule function is rejected" "$(logo_flow_rule "$(printf '%s\n' "$SMOKE_TXT" | sed 's/^function servedLogoRule(auth, pub) {$/function servedLogoRuleX(auth, pub) {/')" "$VERIFY_TXT")" "rule-functions-missing"
check "mutation: a size-only / digest-only / either-digest / removed VPS assertion is rejected" "$(logo_flow_rule "$SMOKE_TXT" "$(printf '%s\n' "$VERIFY_TXT" | sed "s/ and sha256 = '\$B25_LOGO_SHA256' and size_bytes = \$B25_LOGO_SIZE/ and size_bytes = \$B25_LOGO_SIZE/")")|$(logo_flow_rule "$SMOKE_TXT" "$(printf '%s\n' "$VERIFY_TXT" | sed "s/ and sha256 = '\$B25_LOGO_SHA256' and size_bytes = \$B25_LOGO_SIZE/ and sha256 = '\$B25_LOGO_SHA256'/")")|$(logo_flow_rule "$SMOKE_TXT" "$(printf '%s\n' "$VERIFY_TXT" | sed "s/ and sha256 = '\$B25_LOGO_SHA256' and/ and sha256 in ('\$B25_LOGO_SHA256', '\$B25_UPLOAD_SHA256') and/")")|$(logo_flow_rule "$SMOKE_TXT" "$(printf '%s\n' "$VERIFY_TXT" | grep -vF 'exactly one branding_logo row must carry the logo digest and size')")" "vps-assertion-weakened-or-missing|vps-assertion-weakened-or-missing|vps-assertion-weakened-or-missing|vps-assertion-weakened-or-missing"
check "mutation: no longer requiring the stdin logo facts is rejected" "$(logo_flow_rule "$SMOKE_TXT" "$(printf '%s\n' "$VERIFY_TXT" | grep -vF 'logo digest / size missing on the stdin stream')")" "vps-stdin-facts-not-required"
check "the smoke never reads the database (no digest can be copied from a row into the expectation)" "$(grep -ciE 'storage_objects|psql|DATABASE_URL|pg_|sha256_from_db' "$SMOKE" || true)" "0"
check "the VPS verification never derives the expected logo digest from the row (the expectation arrives on stdin only)" "$(printf '%s\n' "$VERIFY_TXT" | grep -cE 'B25_LOGO_SHA256=\$\(q |B25_LOGO_SIZE=\$\(q ' || true)" "0"
check "the authenticated observation uses the tenant's own session on the customer origin and the public route is the first-party randomized route" "$(grep -cF 'api("GET", "/api/organization/branding/logo", { token: tA })' "$SMOKE")|$(grep -cF 'firstParty(up1.json.logoUrl, /^\/api\/branding\/logos\/[0-9]+\/[0-9a-f-]+$/)' "$SMOKE")" "1|1"
check "the smoke logs sanitized response facts only (no header dump, no cookie / authorization / capability echo in the logo block)" "$(awk '/if \(STAGE2A\) \{/{on=1} /\} else \{/{on=0} on' "$SMOKE" | grep -ciE 'headers\.raw|\[\.\.\.(au|rd)\.headers|set-cookie|authorization|capability' || true)" "0"
check "stage 1 logo behaviour unchanged (replace + remove + no-logo probes remain in the else branch)" "$(grep -cE '"logo replace"|"logo remove"|"branding reports no managed logo after removal"' "$SMOKE")" "3"
check "the verdict recording lives only in the Stage 2A branch" "$(awk '/if \(STAGE2A\) \{/{on=1} on&&/s\.logoSha = verdict\.logoSha/{print "in-2a"; exit} /\} else \{/{on=0}' "$SMOKE")" "in-2a"
check "the Stage 2A document contract is unchanged (upload intent, capability probes, exact download, isolation probes, no-leak checks: 13 distinct checks present)" "$(grep -oE '"upload intent \(tenant admin\)"|"PUT without capability refused"|"PUT with a tampered capability refused"|"PUT without a session refused \(401\)"|"GET bytes identical \(sha256\)"|"GET Content-Length exact"|"GET Content-Type exact"|"HEAD supported \(200, Content-Length, empty body\)"|cross-tenant GET → 404|platform owner GET → 403|anonymous GET → 401|"no bucket / key / path / signature text in API bodies"|STORAGE_QUERY_CREDENTIAL_REJECTED' "$SMOKE" | sort -u | wc -l | tr -d ' ')" "13"
check "the smoke script still parses after the correction" "$(node --check "$SMOKE" >/dev/null 2>&1 && echo ok || echo fail)" "ok"

echo "== Corrections 1 + 2 — residue manifests: readonly constants (exact, exception-denied, mutually disjoint, never an input)"
check "manifest 1 = exactly the recorded residue of run 38847884691" "$S2AR_MANIFEST" "593fd8be-72be-4798-b56a-e3af02574dfb,b3cf7f44-8d23-4eae-8d44-27e4138a0249|54,55|101|1c512c90f2c8"
check "manifest 1 run / tag / company / companies / users / rows / sizes" "$S2AR_RUN|$S2AR_TAG|$S2AR_COMPANY|$S2AR_COMPANIES|$S2AR_USERS|$S2AR_ROWS|$S2AR_DOC_SIZE|$S2AR_LOGO_SIZE" "38847884691|1c512c90f2c8|54|54,55|101|2|21546|181"
check "manifest 2 = exactly the recorded residue of run 38922592504 (branding uuid = the candidate the hosted proof must confirm)" "$S2AR2_MANIFEST" "c69a3706-84f8-456b-ba40-e983118f2751,06228d82-7da6-4c5c-9ed7-d66fb97a1a2f|56,57|105|5d408c442c64"
check "manifest 2 run / tag / company / companies / users / rows / sizes" "$S2AR2_RUN|$S2AR2_TAG|$S2AR2_COMPANY|$S2AR2_COMPANIES|$S2AR2_USERS|$S2AR2_ROWS|$S2AR2_DOC_SIZE|$S2AR2_LOGO_SIZE" "38922592504|5d408c442c64|56|56,57|105|2|21546|181"
check "manifest 2 row identities (uuid → kind → recorded size)" "$(s2ar2_kind "$S2AR2_UUID_DOC")=$(s2ar2_size "$S2AR2_UUID_DOC")|$(s2ar2_kind "$S2AR2_UUID_LOGO")=$(s2ar2_size "$S2AR2_UUID_LOGO")|$(s2ar2_kind "$S2AR_UUID_DOC" 2>/dev/null || echo none)" "document=21546|branding_logo=181|none"
check "manifest 1 row identities and an unknown uuid" "$(s2ar_kind "$S2AR_UUID_DOC")=$(s2ar_size "$S2AR_UUID_DOC")|$(s2ar_kind "$S2AR_UUID_LOGO")=$(s2ar_size "$S2AR_UUID_LOGO")|$(s2ar_kind 00000000-0000-0000-0000-000000000000 2>/dev/null || echo none)|$(s2ar_size "$B25PHYS_UUID" 2>/dev/null || echo none)" "document=21546|branding_logo=181|none|none"
check "quoted uuid lists for SQL" "$S2AR_UUIDS_Q|$S2AR2_UUIDS_Q" "'593fd8be-72be-4798-b56a-e3af02574dfb','b3cf7f44-8d23-4eae-8d44-27e4138a0249'|'c69a3706-84f8-456b-ba40-e983118f2751','06228d82-7da6-4c5c-9ed7-d66fb97a1a2f'"
check "manifest 1 window constants" "$S2AR_CREATED_FROM|$S2AR_CREATED_TO|$S2AR_DELETED_FROM|$S2AR_DELETED_TO" "2026-10-16 03:55:30|2026-10-16 03:56:00|2026-10-16 03:55:50|2026-10-16 03:57:00"
check "manifest 2 window constants (STEP=run 15:17:46–15:17:55Z; tenant 56 deleted 15:17:57Z; rows deleted by 15:18:03Z)" "$S2AR2_CREATED_FROM|$S2AR2_CREATED_TO|$S2AR2_DELETED_FROM|$S2AR2_DELETED_TO" "2026-10-16 15:17:40|2026-10-16 15:18:00|2026-10-16 15:17:55|2026-10-16 15:19:00"
check "constants are readonly (a later assignment is refused by the shell)" "$(bash -c 'source "'"$HERE"'/b25-stage1-purge-lib.sh"; source "'"$HERE"'/b25-stage1-apply-lib.sh"; (S2AR_COMPANY=53) 2>/dev/null; (S2AR2_COMPANY=53) 2>/dev/null; (S2AR2_UUID_LOGO=f048b5d4-b366-4227-857f-42b2589e54b7) 2>/dev/null; (S2AR2_MANIFEST=x) 2>/dev/null; echo "$S2AR_COMPANY|$S2AR2_COMPANY|$S2AR2_UUID_LOGO|${S2AR2_MANIFEST%%|*}"')" "54|56|06228d82-7da6-4c5c-9ed7-d66fb97a1a2f|c69a3706-84f8-456b-ba40-e983118f2751,06228d82-7da6-4c5c-9ed7-d66fb97a1a2f"
check "an environment value cannot override either manifest (the child inherits the override through env; the library's readonly assignment wins)" "$(env S2AR_COMPANY=53 S2AR2_COMPANY=53 S2AR2_UUID_DOC=f048b5d4-b366-4227-857f-42b2589e54b7 bash -c 'source "'"$HERE"'/b25-stage1-purge-lib.sh"; source "'"$HERE"'/b25-stage1-apply-lib.sh"; echo "$S2AR_COMPANY|$S2AR2_COMPANY|$S2AR2_UUID_DOC"' 2>/dev/null)" "54|56|c69a3706-84f8-456b-ba40-e983118f2751"
check "neither manifest names the Stage 1 exception (row or company); the manifests are disjoint; both self-checks pass" "$(s2ar_constants_ok && echo true || echo false)|$(s2ar2_constants_ok && echo true || echo false)|$(printf '%s\n%s' "$S2AR_MANIFEST" "$S2AR2_MANIFEST" | grep -cE 'f048b5d4|\|53' || true)|$([ "$S2AR2_UUID_DOC" != "$S2AR_UUID_DOC" ] && [ "$S2AR2_UUID_LOGO" != "$S2AR_UUID_LOGO" ] && [ "$S2AR2_COMPANY" != "$S2AR_COMPANY" ] && [ "$S2AR2_TAG" != "$S2AR_TAG" ] && echo disjoint)" "true|true|0|disjoint"
# the self-check is exercised on MUTATED COPIES of the library (the readonly constants cannot be shadowed in place)
mutated_lib_ok() {   # <sed expression over the library> → the s2ar2_constants_ok verdict of that mutated copy
  sed -E "$1" "$HERE/b25-stage1-apply-lib.sh" > "$RULES_DIR/lib-mut.sh"
  bash -c 'source "'"$HERE"'/b25-stage1-purge-lib.sh"; source "'"$RULES_DIR"'/lib-mut.sh"; s2ar2_constants_ok && echo true || echo false' 2>/dev/null
}
check "the manifest-2 self-check denies a Stage 1 uuid collision, a company-53 collision and an overlap with manifest 1 (mutated library copies)" "$(mutated_lib_ok 's/^readonly S2AR2_UUID_LOGO=.*/readonly S2AR2_UUID_LOGO="f048b5d4-b366-4227-857f-42b2589e54b7"/')|$(mutated_lib_ok 's/^readonly S2AR2_COMPANY=.*/readonly S2AR2_COMPANY=53/')|$(mutated_lib_ok 's/^readonly S2AR2_COMPANIES=.*/readonly S2AR2_COMPANIES="56,53"/')|$(mutated_lib_ok 's/^readonly S2AR2_UUID_DOC=.*/readonly S2AR2_UUID_DOC="593fd8be-72be-4798-b56a-e3af02574dfb"/')|$(mutated_lib_ok 's/^readonly S2AR2_TAG=.*/readonly S2AR2_TAG="1c512c90f2c8"/')|$(mutated_lib_ok 's/^readonly S2AR2_ROWS=.*/readonly S2AR2_ROWS=3/')|$(mutated_lib_ok 's/^readonly S2AR2_UUID_LOGO=.*/readonly S2AR2_UUID_LOGO="not-a-uuid"/')" "false|false|false|false|false|false|false"
check "the manifest-1 self-check denies the same collisions on a mutated copy" "$(sed -E 's/^readonly S2AR_UUID_DOC=.*/readonly S2AR_UUID_DOC="f048b5d4-b366-4227-857f-42b2589e54b7"/' "$HERE/b25-stage1-apply-lib.sh" > "$RULES_DIR/lib-mut.sh"; bash -c 'source "'"$HERE"'/b25-stage1-purge-lib.sh"; source "'"$RULES_DIR"'/lib-mut.sh"; s2ar_constants_ok && echo true || echo false' 2>/dev/null)|$(sed -E 's/^readonly S2AR_COMPANY=.*/readonly S2AR_COMPANY=53/' "$HERE/b25-stage1-apply-lib.sh" > "$RULES_DIR/lib-mut.sh"; bash -c 'source "'"$HERE"'/b25-stage1-purge-lib.sh"; source "'"$RULES_DIR"'/lib-mut.sh"; s2ar_constants_ok && echo true || echo false' 2>/dev/null)" "false|false"
check "the generic evaluators refuse an unknown manifest prefix / marker" "$(printf '' | stage2a_residue_eligibility_for S2AR4 RESIDUE 2>/dev/null; echo "rc=$?")|$(printf '' | stage2a_residue_settled_for S2AR RESIDUE9 2>/dev/null; echo "rc=$?")" "rc=1|rc=1"
check "authoritative census constants of the locked baseline: 5 / 1398 / with_marker 1 / generationless 0" "$B25PHYS_CENSUS_OBJECTS|$B25PHYS_CENSUS_BYTES|$B25PHYS_CENSUS_MARKED|$B25PHYS_CENSUS_GENERATIONLESS|$B25PHYS_CENSUS_MD5" "5|1398|1|0|36d90200a6dc0b043a11aeadee20863c"
check "the exception deny constants of the allow-list and the residue constants agree on the protected row" "$STAGE2A_DENY_UUID|$STAGE2A_DENY_COMPANY" "$B25PHYS_UUID|$B25PHYS_COMPANY"

echo "== Corrections 1 + 2 — residue eligibility evaluators (golden TRUE; every mutated prerequisite FALSE; exactly 26 conditions, each covered)"
S2AR_GOLDEN="head_sha=e559b0024b28d4a77becdcb10c4168004dddea75
current_deploy_sha=e559b0024b28d4a77becdcb10c4168004dddea75
dirty=0
init_record_found=true
init_driver=fs
init_fallback=true
init_mirror=true
init_legacy_delete=false
env_driver_is_fs=true
env_root_is_locked=true
env_fallback_is_true=true
env_mirror_is_gcs=true
env_legacy_delete_off=true
env_key_set=true
lock_absent=true
env_record_present=true
env_core_identity_ok=true
env_mode=600
key_line_count=1
env_file_managed_ok=true
res_companies_present=0
res_users_present=0
res_sessions=0
res_feature_rows=0
res_rows_named=2
res_rows_other=0
res_rows_wrong_company=0
res_rows_deleted=2
res_rows_fs=2
res_rows_legacy_null=2
res_rows_mirror_canonical=2
res_rows_mirror_ok=2
res_rows_error_null=2
res_rows_not_uncertain=2
res_rows_no_lease=2
res_rows_deleted_at_set=2
res_rows_deleted_in_window=2
res_live_refs=0
res_docs_company=0
res_brand_refs=0
res_constants_ok=true
res_rows_exception=0
res_rows_company53=0
res_foreign_mentions=0
res_jobs_pending=0
res_inflight_sessions=0
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
inv_total=3
res_inv_outside=0
res_inv_outside_exception=2
inv_uncertain=0
inv_unproven=0
inv_cleanup_pending=0
inv_leases=0
inv_inflight=0
res_rows_identity_ok=2
res_rows_created_in_window=2
res_doc_size=21546
res_logo_size=181
api_running=true
api_health=healthy
readyz_status=ok
readyz_database=ok
readyz_storage=ok
dead_jobs_total=0
storage_jobs_active=0
schema_fingerprint=30c4ecbd867cd2cd59abcb58581ecb04
res_fs_checked=2
res_fs_absent=2
res_fs_tenant_files=0
res_fs_tenant_dirs=0
res_prov_read_ok=true
res_prov_checked=2
res_prov_absent=2
census_objects=5
census_bytes=1398
census_marked=1
census_generationless=0
census_md5=36d90200a6dc0b043a11aeadee20863c
unmarked_objects=4
unmarked_md5=c1b900fd509bafa1f980d863dc0d195b
originals_present=4
originals_missing=0
originals_size_match=4
root_tenant_files=0
leak_root_path=0
leak_key_shaped=0
leak_key_assignment=0
leak_bucket_ref=0
leak_signature=0
web_leak_root_path=0
web_leak_signature=0"
# s2ar_mut <facts> <"k=v;k2=v2;-k3"> → facts with each key replaced (or removed with a leading '-')
s2ar_mut() { local out="$1" kv k; IFS=';' read -ra arr <<<"$2"; for kv in "${arr[@]}"; do k="${kv%%=*}"; k="${k#-}"; out="$(printf '%s\n' "$out" | grep -vE "^${k}=")"; [[ "$kv" == -* ]] || out="$out"$'\n'"$kv"; done; printf '%s\n' "$out"; }
s2ar_failed() { printf '%s\n' "$1" | sed -nE 's/^(res|post) ([0-9]+): .* — FAIL \(.*$/\2/p' | sort -n | tr '\n' ',' | sed 's/,$//'; }
elig_suite() {   # <evaluator> <marker RESIDUE|RESIDUE2>
  local EVAL="$1" MK="$2" V covered="" label mut want got verdict
  V="$(printf '%s\n' "$S2AR_GOLDEN" | "$EVAL")"
  check "[$MK] golden facts → ELIGIBLE=TRUE, 0 failed" "$(printf '%s\n' "$V" | grep -E "^B25_STAGE2A_${MK}_" | tr '\n' ' ')" "B25_STAGE2A_${MK}_CONDITIONS_FAILED=0 B25_STAGE2A_${MK}_ELIGIBLE=TRUE "
  check "[$MK] exactly 26 numbered conditions, all OK; no other marker family printed" "$(printf '%s\n' "$V" | grep -cE '^res [0-9]+: ')|$(printf '%s\n' "$V" | grep -cE '^res [0-9]+: .* — OK \(')|$(printf '%s\n' "$V" | grep -cE '^B25_STAGE2A_RESIDUE[23]?_' )" "26|26|2"
  check "[$MK] the golden verdict prints no secret-shaped value (no 64-hex token, no gs:// reference, no signature text)" "$(printf '%s\n' "$V" | grep -cE '[0-9a-f]{64}|gs://|X-Goog' || true)" "0"
  while IFS='|' read -r label mut want; do
    [ -n "$label" ] || continue
    V="$(s2ar_mut "$S2AR_GOLDEN" "$mut" | "$EVAL")"
    got="$(s2ar_failed "$V")"; verdict="$(printf '%s\n' "$V" | grep -oE "^B25_STAGE2A_${MK}_ELIGIBLE=[A-Z]+")"
    if [ "$got" = "$want" ] && [ "$verdict" = "B25_STAGE2A_${MK}_ELIGIBLE=FALSE" ]; then ok "[$MK] denied: $label (condition $got FAIL → FALSE)"; else bad "[$MK] NOT denied as expected: $label (failed=[$got] want=[$want] $verdict)"; fi
    covered="$covered,$want"
  done <<'MUT'
hosted product commit changed|head_sha=0000000000000000000000000000000000000000|1
current-deploy.sha not the locked commit|current_deploy_sha=72a24378947134ca8e4d3460294474894c9aaee4|1
dirty checkout|dirty=1|1
driver no longer fs (startup record)|init_driver=gcs|2
legacy fallback off|init_fallback=false|2
mirror off|init_mirror=false|2
legacy delete ON|init_legacy_delete=true|2
container env mirror not gcs|env_mirror_is_gcs=false|2
container env legacy delete not off|env_legacy_delete_off=false|2
encryption key not present in the container|env_key_set=false|2
an activation lock exists|lock_absent=false|3
activation env record missing|env_record_present=false|3
env core identity differs from the record|env_core_identity_ok=false|3
env file mode not 600|env_mode=644|3
no key line|key_line_count=0|3
two key lines|key_line_count=2|3
managed env lines not the fixed activation set|env_file_managed_ok=false|3
disposable company (or a smoke-named tenant) present|res_companies_present=1|4
disposable user present|res_users_present=1|5
disposable session present|res_sessions=1|5
disposable feature / audit rows present|res_feature_rows=3|5
1 row instead of 2 (a uuid wrong by one character, or missing)|res_rows_named=1|6
3 rows carry the named ids|res_rows_named=3|6
a third storage row of the disposable companies|res_rows_other=1|7
a named row belongs to another company|res_rows_wrong_company=1|7
active row (not deleted)|res_rows_deleted=1|8
a row is not driver fs|res_rows_fs=1|9
legacy key present|res_rows_legacy_null=1|10
mirror location malformed / not canonical|res_rows_mirror_canonical=1|11
mirror_state not ok|res_rows_mirror_ok=1|11
last_error present|res_rows_error_null=1|12
publication uncertainty|res_rows_not_uncertain=1|13
lease present|res_rows_no_lease=1|14
deleted_at not set|res_rows_deleted_at_set=1|15
deleted_at outside the tenant-deletion window|res_rows_deleted_in_window=1|15
live association (document version / export / report / scan / brand_logo_key)|res_live_refs=1|16
a document of the disposable company exists|res_docs_company=1|16
another company's brand_logo_key points into the disposable branding prefix|res_brand_refs=1|16
constants collide with the exception|res_constants_ok=false|17,18
protected exception uuid among the rows|res_rows_exception=1|17
a row of company 53|res_rows_company53=1|18
another storage row mentions a residue id|res_foreign_mentions=1|19
pending / running job references the residue|res_jobs_pending=1|19
in-flight database session / transaction on storage_objects|res_inflight_sessions=1|19
exception row changed (state)|exc_state=active|20
exception row absent|exc_row_count=0|20
exception provider object absent|exc_provider_present=false|20
exception generation differs from the accepted digest|exc_generation_digest=0000000000000000|20
exception company present|exc_company_absent=false|20
a fourth storage row exists|inv_total=4|21
a row outside the exception + the two tombstones|res_inv_outside=1|21
an uncertain row anywhere|inv_uncertain=1|21
a leased row anywhere|inv_leases=1|21
row identity (kind / reference / key / digest / content type) wrong|res_rows_identity_ok=1|22
created outside the smoke window|res_rows_created_in_window=1|22
document size read from the row differs|res_doc_size=21545|22
branding size read from the row differs from the normalized served size|res_logo_size=182|22
api unhealthy|api_health=unhealthy|23
storage readiness degraded|readyz_storage=degraded|23
dead job present|dead_jobs_total=1|23
active storage job|storage_jobs_active=1|23
schema fingerprint differs|schema_fingerprint=00000000000000000000000000000000|23
FS object still present (one stored key answers)|res_fs_absent=1|24
a file remains under a tenant directory|res_fs_tenant_files=1|24
fs check covered one row only|res_fs_checked=1|24
fs read / check failure (unreadable counts)|res_fs_checked=?;res_fs_absent=?;res_fs_tenant_files=?;res_fs_tenant_dirs=?|24
GCS object still present (one location answers)|res_prov_absent=1|25
provider read failure (never absence)|res_prov_read_ok=false;res_prov_checked=?;res_prov_absent=?|25
provider check covered one row only|res_prov_checked=1|25
census objects 6|census_objects=6|26
census bytes drifted|census_bytes=1399|26
marked objects 0 (the exception object lost its marker)|census_marked=0|26
a generationless object|census_generationless=1|26
inventory digest differs|census_md5=00000000000000000000000000000000|26
an original object missing|originals_missing=1;originals_present=3|26
missing fact: rows_named|-res_rows_named|6
missing fact: provider read status|-res_prov_read_ok|25
missing fact: exception generation digest|-exc_generation_digest|20
missing fact: fs absence|-res_fs_absent|24
missing fact: branding row size|-res_logo_size|22
MUT
  check "[$MK] every one of the 26 conditions is covered by at least one denying mutation" "$(printf '%s' "$covered" | tr ',' '\n' | grep -E '^[0-9]+$' | sort -n -u | tr '\n' ',')" "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,"
  check "[$MK] a completely empty fact stream fails every condition" "$(printf '' | "$EVAL" | grep -E "^B25_STAGE2A_${MK}_" | tr '\n' ' ')" "B25_STAGE2A_${MK}_CONDITIONS_FAILED=26 B25_STAGE2A_${MK}_ELIGIBLE=FALSE "
}
elig_suite stage2a_residue_eligibility RESIDUE
elig_suite stage2a_residue2_eligibility RESIDUE2
elig_suite stage2a_residue3_eligibility RESIDUE3
check "the third evaluator names its own manifest (company 58; the two recorded uuids) in the same condition slot" "$(printf '%s\n' "$S2AR_GOLDEN" | stage2a_residue3_eligibility | grep -cE '^res 6: .*company-58 .*ac3c33c3-853e-4003-a03e-a8b357a282ac, c097cd52-270e-418c-8e75-0a0dfd1f2312')" "1"
check "the two evaluators name their own manifest (company 54 vs 56; the two uuid pairs) in the same condition slots" "$(printf '%s\n' "$S2AR_GOLDEN" | stage2a_residue_eligibility | grep -cE '^res 6: .*company-54 .*593fd8be-72be-4798-b56a-e3af02574dfb, b3cf7f44-8d23-4eae-8d44-27e4138a0249')|$(printf '%s\n' "$S2AR_GOLDEN" | stage2a_residue2_eligibility | grep -cE '^res 6: .*company-56 .*c69a3706-84f8-456b-ba40-e983118f2751, 06228d82-7da6-4c5c-9ed7-d66fb97a1a2f')" "1|1"

echo "== Corrections 1 + 2 — post-settlement evaluators (golden TRUE; mutations FALSE; exactly 12 proofs, each covered)"
S2AR_POST="$(s2ar_mut "$S2AR_GOLDEN" "res_rows_named=0;inv_total=1;res_inv_outside_exception=0")"
settled_suite() {   # <evaluator> <marker>
  local EVAL="$1" MK="$2" V covered="" label mut want got verdict
  V="$(printf '%s\n' "$S2AR_POST" | "$EVAL")"
  check "[$MK] golden post facts → SETTLED=TRUE, 0 failed" "$(printf '%s\n' "$V" | grep -E "^B25_STAGE2A_${MK}_SETTLED" | tr '\n' ' ')" "B25_STAGE2A_${MK}_SETTLED_CONDITIONS_FAILED=0 B25_STAGE2A_${MK}_SETTLED=TRUE "
  check "[$MK] exactly 12 numbered proofs, all OK" "$(printf '%s\n' "$V" | grep -cE '^post [0-9]+: ')|$(printf '%s\n' "$V" | grep -cE '^post [0-9]+: .* — OK \(')" "12|12"
  check "[$MK] the pre-settlement golden facts (rows still present) are NOT a settled state" "$(printf '%s\n' "$S2AR_GOLDEN" | "$EVAL" | grep -oE "^B25_STAGE2A_${MK}_SETTLED=[A-Z]+")|$(s2ar_failed "$(printf '%s\n' "$S2AR_GOLDEN" | "$EVAL")")" "B25_STAGE2A_${MK}_SETTLED=FALSE|1,7"
  while IFS='|' read -r label mut want; do
    [ -n "$label" ] || continue
    V="$(s2ar_mut "$S2AR_POST" "$mut" | "$EVAL")"
    got="$(s2ar_failed "$V")"; verdict="$(printf '%s\n' "$V" | grep -oE "^B25_STAGE2A_${MK}_SETTLED=[A-Z]+")"
    if [ "$got" = "$want" ] && [ "$verdict" = "B25_STAGE2A_${MK}_SETTLED=FALSE" ]; then ok "[$MK] not settled: $label (proof $got FAIL → FALSE)"; else bad "[$MK] NOT refused as expected: $label (failed=[$got] want=[$want] $verdict)"; fi
    covered="$covered,$want"
  done <<'MUT'
a tombstone row remains|res_rows_named=1|1
the disposable company reappeared|res_companies_present=1|2
another disposable-company storage row remains|res_rows_other=1|2
a disposable identity remains|res_users_present=1|3
a stored key still answers on the volume|res_fs_absent=1|4
a file remains under a tenant directory|res_fs_tenant_files=1|4
a tenant file remains anywhere under the root|root_tenant_files=1|4
provider read failure|res_prov_read_ok=false;res_prov_checked=?;res_prov_absent=?|5
a mirror object still answers|res_prov_absent=1|5
exception generation changed|exc_generation_digest=0000000000000000|6
exception row changed|exc_state=active|6
exception provider object gone|exc_provider_present=false|6
two storage rows remain (final total != 1)|inv_total=2|7
a row outside the exception|res_inv_outside_exception=1|7
census objects 4 (an original is gone)|census_objects=4;census_bytes=1299|8
a generationless object|census_generationless=1|8
inventory digest differs|census_md5=00000000000000000000000000000000|8
marked objects 0|census_marked=0|8
originals digest differs|unmarked_md5=00000000000000000000000000000000|8
driver no longer fs|init_driver=gcs|9
key line count changed|key_line_count=0|9
managed env lines changed|env_file_managed_ok=false|9
mirror off|init_mirror=false|9
api unhealthy|api_health=unhealthy|10
dead job present|dead_jobs_total=1|10
root path leaked into the api log|leak_root_path=1|11
signed-URL text leaked|leak_signature=1|11
root path leaked into the web log|web_leak_root_path=1|11
key-shaped token in the api log|leak_key_shaped=1|11
hosted product commit changed|head_sha=0000000000000000000000000000000000000000|12
a lock was left behind|lock_absent=false|12
MUT
  check "[$MK] every one of the 12 proofs is covered by at least one refusing mutation" "$(printf '%s' "$covered" | tr ',' '\n' | grep -E '^[0-9]+$' | sort -n -u | tr '\n' ',')" "1,2,3,4,5,6,7,8,9,10,11,12,"
}
settled_suite stage2a_residue_settled RESIDUE
settled_suite stage2a_residue2_settled RESIDUE2
settled_suite stage2a_residue3_settled RESIDUE3

echo "== Correction 1 — provider / fs probe readers (behavioural, with a stubbed in-container call): a read failure is never absence"
PROBE_SRC="$(body json_flat_field; body census_field; body stage2a_residue_provider_facts; body stage2a_residue_fs_facts)"
probe() {   # <provider|fs> <canned api_node output> → the facts lines
  B25_STUB="$2" bash -c "$PROBE_SRC"$'\n''api_node() { printf "%s\n" "$B25_STUB"; }; PROVIDER_RULES_JS=x; STAGE2A_PROVIDER_ABSENT_JS=y; STAGE2A_FS_ABSENT_JS=z; HOME=/nonexistent; if [ "$1" = provider ]; then stage2a_residue_provider_facts blob; else stage2a_residue_fs_facts blob; fi' probe "$1" 2>/dev/null | tr '\n' ' '
}
check "provider: both locations 404 → read ok, checked 2, absent 2" "$(probe provider '{"checked":2,"absent":2,"present_ids":[]}')" "res_prov_read_ok=true res_prov_checked=2 res_prov_absent=2 "
check "provider: one object still answers → absent 1 (settlement refused by condition 25)" "$(probe provider '{"checked":2,"absent":1,"present_ids":["593fd8be-72be-4798-b56a-e3af02574dfb"]}')" "res_prov_read_ok=true res_prov_checked=2 res_prov_absent=1 "
check "provider: an error document → read NOT ok, no count (never absence)" "$(probe provider '{"error":"ECONNRESET"}')" "res_prov_read_ok=false res_prov_checked=? res_prov_absent=? "
check "provider: counts accompanied by an error key → read NOT ok" "$(probe provider '{"checked":2,"absent":2,"error":"partial"}')" "res_prov_read_ok=false res_prov_checked=2 res_prov_absent=2 "
check "provider: the in-container call itself unavailable → read NOT ok" "$(probe provider 'unavailable (reason: <path>)')" "res_prov_read_ok=false res_prov_checked=? res_prov_absent=? "
check "provider: a truncated / malformed document → read NOT ok" "$(probe provider '{"checked":2,"absent":')" "res_prov_read_ok=false res_prov_checked=? res_prov_absent=? "
check "fs: both keys absent, no tenant file" "$(probe fs '{"checked":2,"absent":2,"tenant_files":0,"tenant_dirs":2}')" "res_fs_checked=2 res_fs_absent=2 res_fs_tenant_files=0 res_fs_tenant_dirs=2 "
check "fs: one key still present and a stray tenant file → reported, not hidden" "$(probe fs '{"checked":2,"absent":1,"tenant_files":1,"tenant_dirs":2}')" "res_fs_checked=2 res_fs_absent=1 res_fs_tenant_files=1 res_fs_tenant_dirs=2 "
check "fs: unavailable → unreadable counts (fail closed)" "$(probe fs 'unavailable (reason: x)')" "res_fs_checked=? res_fs_absent=? res_fs_tenant_files=? res_fs_tenant_dirs=? "
check "fs / provider: both evaluators deny unreadable counts (condition 24 / 25)" "$(s2ar_failed "$(s2ar_mut "$S2AR_GOLDEN" "res_fs_checked=?;res_fs_absent=?;res_fs_tenant_files=?;res_fs_tenant_dirs=?" | stage2a_residue_eligibility)")|$(s2ar_failed "$(s2ar_mut "$S2AR_GOLDEN" "res_prov_checked=?;res_prov_absent=?" | stage2a_residue2_eligibility)")" "24|25"

echo "== Corrections 1 + 2 — modeled settlement against the local database (the exact constants; allow-list; the exception and company 53 denied)"
SMOKE_DOMAIN="b25smoke.invalid"
eval "$(body stage2a_residue_row_facts)"; eval "$(body stage2a_residue2_row_facts)"; eval "$(body stage2a_residue3_row_facts)"   # the hosted fact readers, bound here to the local read-only q
C1_LOGO_BEFORE="$(q "select coalesce(brand_logo_key, '<null>') from companies where id = 1")"
cleanup_s2ar() {
  qw "delete from storage_objects where id in ($S2AR_UUIDS_Q, $S2AR2_UUIDS_Q, $S2AR3_UUIDS_Q, '$B25PHYS_UUID') and company_id in ($S2AR_COMPANIES, $S2AR2_COMPANIES, $S2AR3_COMPANIES, $B25PHYS_COMPANY)" >/dev/null || true
  if [ "$C1_LOGO_BEFORE" = "<null>" ]; then qw "update companies set brand_logo_key = null where id = 1" >/dev/null || true; else qw "update companies set brand_logo_key = '$C1_LOGO_BEFORE' where id = 1" >/dev/null || true; fi
}
FILTER='^res_(rows_|live_refs|docs_company|brand_refs|foreign_mentions|jobs_pending|inflight_sessions|companies_present|users_present|sessions|feature_rows|constants_ok|doc_size|logo_size)'
modeled_suite() {   # <prefix S2AR|S2AR2> <facts function> <evaluator> <marker>
  local P="$1" FACTS_FN="$2" EVAL="$3" MK="$4"
  local -n MP_UUID_DOC="${P}_UUID_DOC" MP_UUID_LOGO="${P}_UUID_LOGO" MP_UUIDS_Q="${P}_UUIDS_Q" MP_COMPANY="${P}_COMPANY" MP_COMPANIES="${P}_COMPANIES" MP_USERS="${P}_USERS" MP_DOC_SIZE="${P}_DOC_SIZE" MP_LOGO_SIZE="${P}_LOGO_SIZE" MP_ROWS="${P}_ROWS" MP_CREATED_FROM="${P}_CREATED_FROM" MP_DELETED_FROM="${P}_DELETED_FROM"
  local RF triple X3 X53 RF2
  if [ "$(q "select (select count(*) from companies where id in ($MP_COMPANIES)) + (select count(*) from storage_objects where id in ($MP_UUIDS_Q, '$B25PHYS_UUID')) + (select count(*) from users where id in ($MP_USERS))")" != "0" ]; then
    echo "note: the local database already holds the companies, the user or one of the ids of manifest $P — the modeled settlement of $P is exercised by the evaluator mutations only"; return 0
  fi
  seed_rows() {
    ins_fs "$MP_UUID_DOC" "$MP_COMPANY" document deleted NULL no fs canon ok NULL
    ins_fs "$MP_UUID_LOGO" "$MP_COMPANY" branding_logo deleted NULL no fs canon ok NULL
    qw "update storage_objects set size_bytes = case id when '$MP_UUID_DOC' then $MP_DOC_SIZE else $MP_LOGO_SIZE end, content_type = case id when '$MP_UUID_DOC' then 'application/pdf' else 'image/png' end, created_at = '$MP_CREATED_FROM', deleted_at = '$MP_DELETED_FROM', lease_token = null, lease_expires_at = null where id in ($MP_UUIDS_Q)" >/dev/null
  }
  seed_rows
  ins "$B25PHYS_UUID" "$B25PHYS_COMPANY" document deleted LEGACY_RETAINED no gcs NULL   # the protected exception, modeled (gcs / LEGACY_RETAINED / company 53)
  run_m() { local t; t="$(qw "$(stage2a_purge_rows_sql "$1" "$2" "$3")")"; echo "$t"; }
  both_present() { q "select count(*) from storage_objects where id in ($MP_UUIDS_Q)"; }
  RF="$("$FACTS_FN" 2>/dev/null)"
  rowfact() { printf '%s\n' "$RF" | sed -nE "s/^$1=(.*)$/\1/p" | head -1; }
  check "[$MK] row facts: 2 named rows, all deleted / fs / no legacy / canonical ok mirror / no error / not uncertain / no lease / deleted_at and created_at in window" "$(rowfact res_rows_named)|$(rowfact res_rows_deleted)|$(rowfact res_rows_fs)|$(rowfact res_rows_legacy_null)|$(rowfact res_rows_mirror_canonical)|$(rowfact res_rows_mirror_ok)|$(rowfact res_rows_error_null)|$(rowfact res_rows_not_uncertain)|$(rowfact res_rows_no_lease)|$(rowfact res_rows_deleted_at_set)|$(rowfact res_rows_deleted_in_window)|$(rowfact res_rows_created_in_window)" "2|2|2|2|2|2|2|2|2|2|2|2"
  check "[$MK] row facts: identity 2/2, sizes read from the rows ($MP_DOC_SIZE / $MP_LOGO_SIZE); none wrong-company / exception / company 53; no other disposable-company row" "$(rowfact res_rows_identity_ok)|$(rowfact res_doc_size)|$(rowfact res_logo_size)|$(rowfact res_rows_wrong_company)|$(rowfact res_rows_exception)|$(rowfact res_rows_company53)|$(rowfact res_rows_other)" "2|$MP_DOC_SIZE|$MP_LOGO_SIZE|0|0|0|0"
  check "[$MK] row facts: no live association, no foreign mention, no pending job, no disposable company / user / session / feature row; constants ok" "$(rowfact res_live_refs)|$(rowfact res_docs_company)|$(rowfact res_brand_refs)|$(rowfact res_foreign_mentions)|$(rowfact res_jobs_pending)|$(rowfact res_companies_present)|$(rowfact res_users_present)|$(rowfact res_sessions)|$(rowfact res_feature_rows)|$(rowfact res_constants_ok)" "0|0|0|0|0|0|0|0|0|true"
  check "[$MK] row facts: the protected exception is counted outside the residue but never among the named rows" "$(rowfact res_inv_outside_exception | awk '{ print ($1 >= 2) ? "ge2" : "lt2" }')|$(rowfact res_rows_exception)" "ge2|0"
  merge_facts() { printf '%s\n' "$S2AR_GOLDEN" | grep -vE "$FILTER"; printf '%s\n' "$1" | grep -vE '^res_inv_'; }
  check "[$MK] evaluator over the REAL row facts of the modeled residue → ELIGIBLE=TRUE" "$(merge_facts "$RF" | "$EVAL" | grep -oE "^B25_STAGE2A_${MK}_ELIGIBLE=[A-Z]+")" "B25_STAGE2A_${MK}_ELIGIBLE=TRUE"
  dbcase() {   # <label> <mutating sql> <restoring sql> <expected failing condition> <expected triple>
    local label="$1" mut="$2" restore="$3" want="$4" tp="$5" facts got t
    qw "$mut" >/dev/null; facts="$("$FACTS_FN" 2>/dev/null)"
    got="$(s2ar_failed "$(merge_facts "$facts" | "$EVAL")")"
    t="$(run_m "$MP_UUIDS_Q" "$MP_COMPANY" "$MP_ROWS")"; qw "$restore" >/dev/null
    if [ "$got" = "$want" ] && [ "$t" = "$tp" ] && [ "$(both_present)" = "2" ]; then ok "[$MK] db: $label — evaluator condition $got FAIL, allow-list $t, both rows kept"; else bad "[$MK] db: $label — failed=[$got] want=[$want] triple=$t present=$(both_present)"; fi
  }
  evalcase() {   # <label> <mutating sql> <restoring sql> <expected failing condition> — evaluator only (the settle phase stops before any transaction)
    local facts got; qw "$2" >/dev/null; facts="$("$FACTS_FN" 2>/dev/null)"; got="$(s2ar_failed "$(merge_facts "$facts" | "$EVAL")")"; qw "$3" >/dev/null
    if [ "$got" = "$4" ]; then ok "[$MK] db: $1 — evaluator condition $got FAIL (no transaction is opened)"; else bad "[$MK] db: $1 — failed=[$got] want=[$4]"; fi
  }
  dbcase "active row" "update storage_objects set state = 'active', deleted_at = null where id = '$MP_UUID_DOC'" "update storage_objects set state = 'deleted', deleted_at = '$MP_DELETED_FROM' where id = '$MP_UUID_DOC'" "8,15" "0|2|1"
  dbcase "legacy key present" "update storage_objects set legacy_key = 'gs://synthetic/legacy' where id = '$MP_UUID_LOGO'" "update storage_objects set legacy_key = null where id = '$MP_UUID_LOGO'" "10" "0|2|1"
  dbcase "publication uncertainty" "update storage_objects set publication_uncertain_at = now() where id = '$MP_UUID_DOC'" "update storage_objects set publication_uncertain_at = null where id = '$MP_UUID_DOC'" "13" "0|2|1"
  dbcase "last_error set (retained / unproven / cleanup-pending)" "update storage_objects set last_error = 'CLEANUP_PENDING' where id = '$MP_UUID_LOGO'" "update storage_objects set last_error = null where id = '$MP_UUID_LOGO'" "12" "0|2|1"
  dbcase "lease present (in-flight writer)" "update storage_objects set lease_token = 'x', lease_expires_at = now() + interval '5 minutes' where id = '$MP_UUID_DOC'" "update storage_objects set lease_token = null, lease_expires_at = null where id = '$MP_UUID_DOC'" "14" "0|2|1"
  dbcase "mirror_state not ok" "update storage_objects set mirror_state = 'failed' where id = '$MP_UUID_LOGO'" "update storage_objects set mirror_state = 'ok' where id = '$MP_UUID_LOGO'" "11" "0|2|1"
  dbcase "mirror location malformed" "update storage_objects set mirror_key = 'not-a-provider-location' where id = '$MP_UUID_DOC'" "update storage_objects set mirror_key = 'gs://synthetic/' || storage_key where id = '$MP_UUID_DOC'" "11" "0|2|1"
  dbcase "mirror location not canonical" "update storage_objects set mirror_key = 'gs://synthetic/tenants/$MP_COMPANY/documents/other' where id = '$MP_UUID_DOC'" "update storage_objects set mirror_key = 'gs://synthetic/' || storage_key where id = '$MP_UUID_DOC'" "11" "0|2|1"
  dbcase "driver not fs" "update storage_objects set driver = 'gcs' where id = '$MP_UUID_DOC'" "update storage_objects set driver = 'fs' where id = '$MP_UUID_DOC'" "9" "0|2|1"
  dbcase "wrong company on a named row" "update storage_objects set company_id = ${MP_COMPANIES##*,} where id = '$MP_UUID_LOGO'" "update storage_objects set company_id = $MP_COMPANY where id = '$MP_UUID_LOGO'" "7,22" "0|2|1"
  dbcase "live association: an existing company's brand_logo_key points at the residue logo" "update companies set brand_logo_key = (select reference from storage_objects where id = '$MP_UUID_LOGO') where id = 1" "update companies set brand_logo_key = $([ "$C1_LOGO_BEFORE" = "<null>" ] && echo null || echo "'$C1_LOGO_BEFORE'") where id = 1" "16" "0|2|1"
  evalcase "row identity: branding size read from the row differs from the normalized served size" "update storage_objects set size_bytes = $((MP_LOGO_SIZE + 1)) where id = '$MP_UUID_LOGO'" "update storage_objects set size_bytes = $MP_LOGO_SIZE where id = '$MP_UUID_LOGO'" "22"
  evalcase "row identity: document size differs" "update storage_objects set size_bytes = $((MP_DOC_SIZE - 1)) where id = '$MP_UUID_DOC'" "update storage_objects set size_bytes = $MP_DOC_SIZE where id = '$MP_UUID_DOC'" "22"
  evalcase "row identity: kind swapped" "update storage_objects set kind = 'document' where id = '$MP_UUID_LOGO'" "update storage_objects set kind = 'branding_logo' where id = '$MP_UUID_LOGO'" "22"
  evalcase "row identity: created outside the smoke window" "update storage_objects set created_at = '2026-10-17 04:30:00' where id = '$MP_UUID_DOC'" "update storage_objects set created_at = '$MP_CREATED_FROM' where id = '$MP_UUID_DOC'" "22"
  evalcase "tombstoned outside the tenant-deletion window" "update storage_objects set deleted_at = '2026-10-17 05:00:00' where id = '$MP_UUID_DOC'" "update storage_objects set deleted_at = '$MP_DELETED_FROM' where id = '$MP_UUID_DOC'" "15"
  # a uuid wrong by one character: the row exists under another id → only one named row → condition 6; the allow-list locks only the one listed row that exists → nothing deleted
  local WRONG; WRONG="${MP_UUID_LOGO%?}$([ "${MP_UUID_LOGO: -1}" = "f" ] && echo e || echo f)"
  qw "update storage_objects set id = '$WRONG' where id = '$MP_UUID_LOGO'" >/dev/null; IDS+=("$WRONG")
  RF2="$("$FACTS_FN" 2>/dev/null)"; triple="$(run_m "$MP_UUIDS_Q" "$MP_COMPANY" "$MP_ROWS")"
  check "[$MK] branding uuid wrong by one character → 1 named row + 1 other row (conditions 6, 7, every per-row 2/2 count, the foreign mention of the original id's key and the identity FAIL); the constant list locks 1 ≠ 2 → nothing deleted" "$(printf '%s\n' "$RF2" | sed -nE 's/^res_rows_named=(.*)$/\1/p')|$(printf '%s\n' "$RF2" | sed -nE 's/^res_rows_other=(.*)$/\1/p')|$(s2ar_failed "$(merge_facts "$RF2" | "$EVAL")")|$triple|$(q "select count(*) from storage_objects where id in ('$MP_UUID_DOC', '$WRONG')")" "1|1|6,7,8,9,10,11,12,13,14,15,19,22|0|1|1|2"
  qw "update storage_objects set id = '$MP_UUID_LOGO' where id = '$WRONG'" >/dev/null
  qw "update storage_objects set id = '$WRONG' where id = '$MP_UUID_DOC'" >/dev/null
  RF2="$("$FACTS_FN" 2>/dev/null)"; triple="$(run_m "$MP_UUIDS_Q" "$MP_COMPANY" "$MP_ROWS")"
  check "[$MK] document uuid wrong → conditions 6, 7, the per-row counts, the foreign mention and the identity FAIL; nothing deleted" "$(s2ar_failed "$(merge_facts "$RF2" | "$EVAL")")|$triple" "6,7,8,9,10,11,12,13,14,15,19,22|0|1|1"
  qw "update storage_objects set id = '$MP_UUID_DOC' where id = '$WRONG'" >/dev/null
  check "[$MK] modeled rows intact for the allow-list cases" "$(both_present)" "2"
  triple="$(run_m "$MP_UUIDS_Q" "${MP_COMPANIES##*,}" 2)"; [ "$triple" = "0|2|0" ] && [ "$(both_present)" = "2" ] && ok "[$MK] allow-list: wrong company list → nothing deleted ($triple)" || bad "[$MK] allow-list wrong company not refused ($triple)"
  triple="$(run_m "$MP_UUIDS_Q" "$MP_COMPANY" 1)"; [ "$triple" = "0|2|2" ] && [ "$(both_present)" = "2" ] && ok "[$MK] allow-list: expected 1 with 2 locked rows → nothing deleted ($triple)" || bad "[$MK] allow-list count mismatch (1) not refused ($triple)"
  triple="$(run_m "$MP_UUIDS_Q" "$MP_COMPANY" 3)"; [ "$triple" = "0|2|2" ] && [ "$(both_present)" = "2" ] && ok "[$MK] allow-list: expected 3 with 2 locked rows → nothing deleted ($triple)" || bad "[$MK] allow-list count mismatch (3) not refused ($triple)"
  mk X3; ins_fs "$X3" "$MP_COMPANY" document deleted NULL no fs canon ok NULL
  RF2="$("$FACTS_FN" 2>/dev/null)"
  check "[$MK] a third disposable-company storage row → condition 7 FAIL (rows_other=1)" "$(printf '%s\n' "$RF2" | sed -nE 's/^res_rows_other=(.*)$/\1/p')|$(s2ar_failed "$(merge_facts "$RF2" | "$EVAL")")" "1|7"
  triple="$(run_m "$MP_UUIDS_Q,'$X3'" "$MP_COMPANY" 2)"; [ "$triple" = "0|3|3" ] && [ "$(both_present)" = "2" ] && [ "$(present "$X3")" = "1" ] && ok "[$MK] allow-list: a third listed row with expected 2 → nothing deleted ($triple)" || bad "[$MK] allow-list third row not refused ($triple)"
  qw "delete from storage_objects where id = '$X3' and company_id = $MP_COMPANY" >/dev/null
  triple="$(run_m "$MP_UUIDS_Q,'$B25PHYS_UUID'" "$MP_COMPANY,$B25PHYS_COMPANY" 3)"; [ "$triple" = "0|3|2" ] && [ "$(both_present)" = "2" ] && [ "$(present "$B25PHYS_UUID")" = "1" ] && ok "[$MK] allow-list: the protected exception listed alongside → denied by constant, nothing deleted ($triple)" || bad "[$MK] exception not denied ($triple)"
  mk X53; ins_fs "$X53" "$B25PHYS_COMPANY" document deleted NULL no fs canon ok NULL
  triple="$(run_m "'$X53'" "$B25PHYS_COMPANY" 1)"; [ "$triple" = "0|1|0" ] && [ "$(present "$X53")" = "1" ] && ok "[$MK] allow-list: a company-53 row → denied by constant ($triple)" || bad "[$MK] company 53 not denied ($triple)"
  qw "delete from storage_objects where id = '$X53' and company_id = $B25PHYS_COMPANY" >/dev/null
  triple="$(run_m "$MP_UUIDS_Q" "$MP_COMPANY" "$MP_ROWS")"
  purge_result_check "$triple" "$MP_ROWS" >/dev/null && [ "$(both_present)" = "0" ] && ok "[$MK] settlement: exactly the two rows removed in one transaction ($triple)" || bad "[$MK] settlement positive path failed ($triple, present=$(both_present))"
  check "[$MK] exception row unchanged after the modeled settlement (present, deleted / LEGACY_RETAINED / gcs / company 53)" "$(q "select count(*) from storage_objects where id = '$B25PHYS_UUID' and state = 'deleted' and last_error = 'LEGACY_RETAINED' and driver = 'gcs' and company_id = $B25PHYS_COMPANY")" "1"
  triple="$(run_m "$MP_UUIDS_Q" "$MP_COMPANY" "$MP_ROWS")"; [ "$triple" = "0|0|0" ] && ok "[$MK] settlement second run: already removed → 0|0|0" || bad "[$MK] settlement second run changed something ($triple)"
  RF2="$("$FACTS_FN" 2>/dev/null)"
  check "[$MK] row facts after the settlement: 0 named rows, 0 disposable-company rows (the auto-purge race reads the same way: rows_named=0 → condition 6 FAIL, nothing to settle)" "$(printf '%s\n' "$RF2" | sed -nE 's/^res_rows_named=(.*)$/\1/p')|$(printf '%s\n' "$RF2" | sed -nE 's/^res_rows_other=(.*)$/\1/p')|$(s2ar_failed "$(merge_facts "$RF2" | "$EVAL")" | cut -d, -f1)" "0|0|6"
  cleanup_s2ar
  check "[$MK] modeled exception removed again; local database back to its previous state for these ids" "$(q "select count(*) from storage_objects where id in ($MP_UUIDS_Q, '$B25PHYS_UUID')")" "0"
}
modeled_suite S2AR stage2a_residue_row_facts stage2a_residue_eligibility RESIDUE
modeled_suite S2AR2 stage2a_residue2_row_facts stage2a_residue2_eligibility RESIDUE2
modeled_suite S2AR3 stage2a_residue3_row_facts stage2a_residue3_eligibility RESIDUE3

echo "== Corrections 1 + 2 — phase bodies and workflow wiring (static)"
wiring_suite() {   # <suffix ""|2> <prefix> <marker> <tag> <required env name> <required value>
  local SFX="$1" P="$2" MK="$3" TAG="$4" REQ="$5" REQV="$6" EB SB RB2 BLK
  local -n WP_UUID_DOC="${P}_UUID_DOC" WP_UUID_LOGO="${P}_UUID_LOGO"
  EB="$(body "phase_stage2a_residue${SFX}_eligibility")"; SB="$(body "phase_stage2a_residue${SFX}_settle")"; RB2="$(body "stage2a_residue${SFX}_eligibility_run")"
  if [ -z "$SFX" ]; then BLK="$(awk '/^# B25 STAGE 2A — CORRECTION 1: settlement of the EXACT residue/{on=1} /^# B25 STAGE 2A — CORRECTION 2: settlement of the EXACT residue/{exit} on{print}' "$APPLY")"
  elif [ "$SFX" = 3 ]; then BLK="$(awk '/^# B25 STAGE 2A — CORRECTION 4: settlement of the EXACT residue/{on=1} /^# Stage 2A — existing-tenant baseline DRIFT LOCALIZATION/{exit} on{print}' "$APPLY")"
  else BLK="$(awk '/^# B25 STAGE 2A — CORRECTION 2: settlement of the EXACT residue/{on=1} /^# B25 STAGE 2A — CORRECTION 4: settlement of the EXACT residue/{exit} on{print}' "$APPLY")"; fi
  check "[$MK] both residue phases exist and refuse any argument (the residue is bound by constants)" "$(printf '%s\n' "$EB" | grep -c '\[ -z "$ARG1$ARG2$ARG3" \] || fail')|$(printf '%s\n' "$SB" | grep -c '\[ -z "$ARG1$ARG2$ARG3" \] || fail')" "1|1"
  check "[$MK] the eligibility run proves the read-only session first and decides through the library evaluator" "$(printf '%s\n' "$RB2" | grep -c stage2a_readonly_guard)|$(printf '%s\n' "$RB2" | grep -c "| stage2a_residue${SFX}_eligibility)")|$(printf '%s\n' "$RB2" | grep -c "grep -qx 'B25_STAGE2A_${MK}_ELIGIBLE=TRUE'")" "1|1|1"
  check "[$MK] the eligibility run reads the fs and provider absence facts (read-only probes) and the Stage 1 exception facts" "$(printf '%s\n' "$RB2" | grep -oE 'stage2a_residue_fs_facts|stage2a_residue_provider_facts|stage2a_exception_facts' | sort -u | wc -l | tr -d ' ')" "3"
  check "[$MK] the eligibility phase never writes, inserts or recreates anything (auto-purge race: report only)" "$(printf '%s\n' "$EB" | grep -vE '^\s*#' | grep -ciE '(^|[^a-z_])qw |"insert |ins_fs|stage2a_recreate_api|compose up' || true)" "0"
  check "[$MK] settle: no mutation unless the SAME session returned ELIGIBLE=TRUE (eligibility run guarded by fail)" "$(printf '%s\n' "$SB" | grep -c "stage2a_residue${SFX}_eligibility_run || fail")" "1"
  check "[$MK] settle order: eligibility → lock → fs absence per uuid → provider absence per uuid → the ONE allow-listed delete → post evaluator" "$(printf '%s\n' "$SB" | grep -n -E "stage2a_residue${SFX}_eligibility_run \|\| fail|^  stage2a_lock\$|STAGE2A_FS_ABSENT_JS|STAGE2A_PROVIDER_ABSENT_JS|stage2a_purge_rows_sql \"\\\$${P}_UUIDS_Q\"|\| stage2a_residue${SFX}_settled\)" | cut -d: -f1 | tr '\n' ' ' | awk '{ ok = (NF == 6); for (i = 2; i <= NF; i++) if ($i <= $(i-1)) ok = 0; print ok ? "ordered" : "wrong-order" }')" "ordered"
  check "[$MK] settle: each uuid's fs primary and every provider location are re-proven absent individually (two loops over the two constants)" "$(printf '%s\n' "$SB" | grep -cF "for u in \"\$${P}_UUID_DOC\" \"\$${P}_UUID_LOGO\"; do")" "2"
  check "[$MK] settle: a provider read failure stops before any row removal (error document → fail), and a present copy stops too" "$(printf '%s\n' "$SB" | grep -c 'grep -q .\"error\".; then fail')|$(printf '%s\n' "$SB" | grep -cE 'fail "the fs primary of \$u still exists|fail "a persisted provider location of \$u still answers')" "1|2"
  check "[$MK] settle: the allow-listed delete uses exactly the constant uuid list, company and count, and requires locked = allowed = deleted = 2" "$(printf '%s\n' "$SB" | grep -cF "stage2a_purge_rows_sql \"\$${P}_UUIDS_Q\" \"\$${P}_COMPANY\" \"\$${P}_ROWS\"")|$(printf '%s\n' "$SB" | grep -cF "purge_result_check \"\$triple\" \"\$${P}_ROWS\" || fail")" "1|1"
  check "[$MK] settle: exactly ONE writing statement (the row-locked delete) — no other qw" "$(printf '%s\n' "$SB" | grep -cE '(^|[^a-z_])qw ')" "1"
  check "[$MK] settle: NO provider delete, NO file delete, NO unconditioned mutation (no ifGenerationMatch / .delete( / rm -r / find -delete / unlink / Stage 1 purge rule)" "$(printf '%s\n' "$SB" | grep -ciE 'ifGenerationMatch|\.delete\(|rm -r|find[^|]*-delete|unlink|[^a-z0-9_]purge_rows_sql ' || true)" "0"
  check "[$MK] settle: the post-settlement proof re-reads the fs / provider absence with the blobs captured BEFORE the removal and ends on the library verdict" "$(printf '%s\n' "$SB" | grep -c 'stage2a_residue_fs_facts "$frows"')|$(printf '%s\n' "$SB" | grep -c 'stage2a_residue_provider_facts "$loc"')|$(printf '%s\n' "$SB" | grep -c "grep -qx 'B25_STAGE2A_${MK}_SETTLED=TRUE' || fail")" "1|1|1"
  check "[$MK] settle: the lock is released before the read-only post proof and the post proof re-reads the census (exception facts) and the host facts" "$(printf '%s\n' "$SB" | grep -c 'rm -f "$STAGE2A_LOCK_FILE"')|$(printf '%s\n' "$SB" | grep -c 'facts+="$(stage2a_exception_facts)"')|$(printf '%s\n' "$SB" | grep -c 'facts+="$(stage2a_residue_host_facts "$cid")"')" "1|1|1"
  check "[$MK] the residue block never edits the environment, recreates a container, touches a volume or renders a storage variable" "$(printf '%s\n' "$BLK" | grep -ciE 'stage2a_env_apply|stage2a_recreate_api|OBJECT_STORAGE_[A-Z_]+=|compose (up|down|rm|restart|stop|kill)|docker (rm|stop|kill|restart|volume)|sed -i|>> *"?\$ENV_FILE' || true)" "0"
  check "[$MK] the residue block denies the exception in its own predicates (id <> exception, company 53 counted, constants checked)" "$(printf '%s\n' "$BLK" | grep -cE "id <> '\\\$B25PHYS_UUID'|company_id = \\\$B25PHYS_COMPANY|s2ar${SFX}_constants_ok \|\| fail")" "4"
  check "[$MK] the residue block contains no migration wrapper, no fallback / mirror disable, no legacyDelete enable, no GCS retirement" "$(printf '%s\n' "$BLK" | grep -ciE 'migrate.storage|--dry-run|--copy|--verify|LEGACY_FALLBACK=false|OBJECT_STORAGE_MIRROR=$|OBJECT_STORAGE_MIRROR=\"\"|LEGACY_DELETE=true|gcs-driver|service-account' || true)" "0"
  check "[$MK] the row facts are read through the read-only q only, in one statement for the named rows, and the sizes are read from the rows" "$(body "stage2a_residue${SFX}_row_facts" | grep -cE '(^|[^a-z_])qw ' || true)|$(body "stage2a_residue${SFX}_row_facts" | grep -c 'from storage_objects where id in ($Q)')|$(body "stage2a_residue${SFX}_row_facts" | grep -cE '^  echo "res_(doc|logo)_size=')" "0|1|2"
  check "[$MK] dispatch entries for both residue phases exist exactly once" "$(grep -cE "^  stage2a-residue${SFX}-(eligibility|settle)\) phase_stage2a_residue${SFX}_(eligibility|settle) ;;\$" "$APPLY")" "2"
  check "[$MK] workflow offers the two residue modes (inspect = read-only, settle = mutation)" "$(grep -oE "stage2a_residue_(inspect|settle)_${TAG}" "$WF" | sort -u | tr '\n' ' ')" "stage2a_residue_inspect_${TAG} stage2a_residue_settle_${TAG} "
  check "[$MK] the incident-specific typed confirmation is a fixed constant with its own input" "$(grep -cE "^  ${REQ}: \"${REQV}\"\$" "$WF")|$(grep -cE "^      confirm_stage2a_residue${SFX}:\$" "$WF")" "1|1"
  check "[$MK] settle mode requires the product commit, the window and ${REQV} and refuses every other confirmation" "$(awk "/^            stage2a_residue_settle_${TAG}\\)\$/{on=1;next} on&&/;;\$/{print;exit} on{print}" "$WF" | grep -cE "need confirm_product_sha \"\\\$IN_PRODUCT_SHA\" \"\\\$STAGE2A_PRODUCT_SHA\"; need confirm_window \"\\\$IN_WINDOW\" \"\\\$REQUIRED_WINDOW\"; need confirm_stage2a_residue${SFX} \"\\\$IN_STAGE2A_RESIDUE${SFX}\" \"\\\$${REQ}\"|empty confirm_stage2a \"\\\$IN_STAGE2A\"; empty confirm_stage2a_smoke \"\\\$IN_STAGE2A_SMOKE\"; empty confirm_stage2a_rollback \"\\\$IN_STAGE2A_ROLLBACK\"; empty confirm_residue \"\\\$IN_RESIDUE\"")" "2"
  check "[$MK] every other Stage 2A mode (read-only, activate, smoke, rollback, the two other residue settles) and the default branch refuse this residue confirmation" "$(grep -c "empty confirm_stage2a_residue${SFX} \"\$IN_STAGE2A_RESIDUE${SFX}\"" "$WF")" "7"
  check "[$MK] the residue manifest / uuids are NOT workflow inputs (no input default carries them; the SSH steps pass no ARG)" "$(grep -E '^        default:' "$WF" | grep -cE "${WP_UUID_DOC:0:8}|${WP_UUID_LOGO:0:8}|${TAG}" || true)|$(grep -E "PHASE='stage2a-residue${SFX}-(eligibility|settle)' " "$WF" | grep -cE 'ARG[123]=' || true)" "0|0"
  check "[$MK] both residue steps are ONE SSH session each and require the host's TRUE marker" "$(grep -c "grep -qx 'B25_STAGE2A_${MK}_ELIGIBLE=TRUE'" "$WF")|$(grep -c "grep -qx 'B25_STAGE2A_${MK}_SETTLED=TRUE'" "$WF")|$(grep -cE "if: inputs.mode == 'stage2a_residue_settle_${TAG}'\$" "$WF")|$(grep -cE "if: inputs.mode == 'stage2a_residue_inspect_${TAG}'\$" "$WF")" "1|1|1|1"
  check "[$MK] the branch guard requires the residue library (evaluators + manifest constant) before any SSH" "$(grep -c "grep -q '^stage2a_residue${SFX}_eligibility()'" "$WF")|$(grep -c "grep -q '^readonly ${P}_MANIFEST='" "$WF")" "1|1"
  check "[$MK] the residue log is removed by the always-step" "$(grep -c "\"\$RUNNER_TEMP\"/stage2a-residue${SFX}.log" "$WF")" "1"
}
wiring_suite "" S2AR RESIDUE 1c512c90f2c8 REQUIRED_STAGE2A_RESIDUE SETTLE_B25_STAGE2A_RESIDUE_1c512c90f2c8
wiring_suite 2 S2AR2 RESIDUE2 5d408c442c64 REQUIRED_STAGE2A_RESIDUE2 SETTLE_B25_STAGE2A_RESIDUE_5d408c442c64
wiring_suite 3 S2AR3 RESIDUE3 ec7ceda89a58 REQUIRED_STAGE2A_RESIDUE3 SETTLE_B25_STAGE2A_RESIDUE_ec7ceda89a58
check "the two settlement modes refuse each other's confirmation (Correction 1 settle refuses confirm_stage2a_residue2; Correction 2 settle refuses confirm_stage2a_residue)" "$(awk '/^            stage2a_residue_settle_1c512c90f2c8\)$/{on=1;next} on&&/;;$/{print;exit} on{print}' "$WF" | grep -c 'empty confirm_stage2a_residue2 "$IN_STAGE2A_RESIDUE2"')|$(awk '/^            stage2a_residue_settle_5d408c442c64\)$/{on=1;next} on&&/;;$/{print;exit} on{print}' "$WF" | grep -c 'empty confirm_stage2a_residue "$IN_STAGE2A_RESIDUE"')" "1|1"
check "the Correction 2 eligibility phase reports an already-purged residue explicitly (auto-purge race) without recreating anything" "$(body phase_stage2a_residue2_eligibility | grep -c 'B25_STAGE2A_RESIDUE2_ROWS_ALREADY_ABSENT=TRUE')|$(body phase_stage2a_residue2_eligibility | grep -c 'rows_present=$left')" "1|1"
check "the shared probe / host readers exist exactly once (reused by both corrections, not duplicated)" "$(grep -cE '^stage2a_residue_(fs|provider|host)_facts\(\) \{' "$APPLY")" "3"
check "the generic evaluators are the single implementation behind the three manifests (six thin wrappers)" "$(grep -cE '^stage2a_residue[23]?_(eligibility|settled)\(\) \{ stage2a_residue_(eligibility|settled)_for S2AR[23]? RESIDUE[23]?; \}$' "$HERE/b25-stage1-apply-lib.sh")|$(grep -cE '^stage2a_residue_(eligibility|settled)_for\(\) \{' "$HERE/b25-stage1-apply-lib.sh")" "6|2"
echo "== Stage 2A — tenant baseline drift localization (read-only; prepared after smoke run 38934705535 stopped in guards_stage2a_switched)"
check "the smoke setup still proves the switched state first, then the Correction 3 start gate, and only then inserts the disposable owner (the frozen digest is gone from the switched guard)" "$(body guards_stage2a_switched | grep -c 'fail "tenant baseline changed"' || true)|$(body phase_stage2a_smoke_setup | grep -n 'guards_stage2a_switched\|stage2a_tenant_start_gate$\|insert into users' | awk -F: '{print $1}' | tr '\n' ' ')" "0|2 8 11 "
check "the drift phase exists exactly once and is dispatched by PHASE=stage2a-tenant-drift" "$(grep -c '^phase_stage2a_tenant_drift() {$' "$APPLY")|$(grep -c '^  stage2a-tenant-drift) phase_stage2a_tenant_drift ;;$' "$APPLY")" "1|1"
check "the window constants are the tooling's own step instants (last matching guard of run 38922592504 < first differing guard of run 38934705535)" "$(grep -oE '^S2A_TENANT_LAST_MATCH="[^"]+"' "$APPLY")|$(grep -oE '^S2A_TENANT_FIRST_DIFFERS="[^"]+"' "$APPLY")" 'S2A_TENANT_LAST_MATCH="2026-10-16 15:17:33"|S2A_TENANT_FIRST_DIFFERS="2026-10-16 16:48:22"'
check "the window is ordered (last match precedes first differs)" "$([ "$(date -u -d "$(grep -oE '^S2A_TENANT_LAST_MATCH="[^"]+"' "$APPLY" | cut -d'"' -f2)Z" +%s)" -lt "$(date -u -d "$(grep -oE '^S2A_TENANT_FIRST_DIFFERS="[^"]+"' "$APPLY" | cut -d'"' -f2)Z" +%s)" ] && echo ordered)" "ordered"
check "the drift phase proves the read-only session first, then compares the digest without re-accepting it (TENANT_BASELINE_MD5 is read, never assigned)" "$(body phase_stage2a_tenant_drift | grep -n 'stage2a_readonly_guard\|tenant_md5)' | awk -F: '{print $1}' | tr '\n' ' ')|$(body phase_stage2a_tenant_drift | grep -c 'TENANT_BASELINE_MD5=' || true)" "3 5 |0"
check "the accepted baseline constant is unchanged (never edited to make a guard pass)" "$(grep -c '^TENANT_BASELINE_MD5="9f8f3adadc282d1b5b929582ec99b901"$' "$APPLY")" "1"
check "the drift phase prints no composition value: it never calls existing_core, never selects status / plan / name / permissions / overrides / trial fields" "$(body phase_stage2a_tenant_drift | grep -cE 'existing_core|name_md5|perms_md5|limit_overrides|trial_expires|billing_source|\.plan|c\.status|s\.status\b|permissions' || true)|$(body stage2a_tenant_drift_table_facts | grep -cE 'existing_core|name|permissions|status' || true)" "0|0"
check "every table of the existing-tenant digest is covered by the per-table movement report (users roles user_roles contacts leads events tasks tags lead_tags documents workflow_definitions workflow_runs billing_checkout_sessions subscription_usage_reservations) plus scans" "$(body phase_stage2a_tenant_drift | grep -oE 'stage2a_tenant_drift_table_facts [a-z_]+|s2a_counts_line "user_roles"' | sed 's/.* //; s/"//g' | sort | tr '\n' ' ')" "billing_checkout_sessions contacts documents events lead_tags leads roles scans subscription_usage_reservations tags tasks user_roles users workflow_definitions workflow_runs "
check "the per-table reader uses only created_at / updated_at / deleted_at comparisons against the constant window (no row content)" "$(body stage2a_tenant_drift_table_facts | grep -cE "count\(\*\) filter \(where (created_at|deleted_at|created_at < '\\\$T' and updated_at) ")|$(body stage2a_tenant_drift_table_facts | grep -cE 'select (id|name|email|title|status|plan)' || true)" "3|0"
check "every database line is shape-validated before it is printed (counts regex; the audit action and sweep lines are allow-listed identifiers + counts)" "$(body s2a_counts_line | grep -c 'S2A_COUNTS_RE')|$(body phase_stage2a_tenant_drift | grep -c '\[\[ "\$line" =~ ^\[A-Za-z0-9._:-\]{1,80}\\ n=\[0-9\]+\$ \]\]')|$(body phase_stage2a_tenant_drift | grep -c '\[\[ "\$line" =~ ^\[A-Za-z?\]{1,40}\\ \[a-z_\]{1,20}\\ n=\[0-9\]+\$ \]\]')|$(grep -c "^S2A_COUNTS_RE='\^\[a-z0-9_\]+=\[0-9\]+( \[a-z0-9_\]+=\[0-9\]+)\*\$'$" "$APPLY")" "1|1|1|1"
check "the audit section prints action identifiers and counts only (no entity, user, ip or metadata column is selected)" "$(body phase_stage2a_tenant_drift | grep 'from audit_logs' | grep -cE 'entity_id|user_name|user_id|ip_address|metadata' || true)|$(body phase_stage2a_tenant_drift | grep -c 'from audit_logs')" "0|3"
check "the api log counters are counts of fixed message literals (the log text itself is never printed)" "$(body phase_stage2a_tenant_drift | grep -o 'grep -cF' | wc -l | tr -d ' ')|$(body phase_stage2a_tenant_drift | grep -cE 'printf .%s.n. "\$alog" \| (jsum|san|sed|head|tail|awk)' || true)" "3|0"
check "the drift phase ends with the digest verdict marker and the REPORTED marker the workflow requires" "$(body phase_stage2a_tenant_drift | grep -c '^  echo "B25_STAGE2A_TENANT_DIGEST=\$verdict"$')|$(body phase_stage2a_tenant_drift | grep -c '^  echo "B25_STAGE2A_TENANT_DRIFT_REPORTED=TRUE"$')" "1|1"
check "workflow offers the read-only drift mode, validates it as read-only (every confirmation empty) and allow-lists it before SSH" "$(grep -c 'stage2a_tenant_drift_inspect, incident_diagnose' "$WF")|$(awk '/^            stage2a_precheck\|stage2a_postswitch_verify\|stage2a_residue_inspect_1c512c90f2c8\|stage2a_residue_inspect_5d408c442c64\|stage2a_residue_inspect_ec7ceda89a58\|stage2a_tenant_drift_inspect\)$/{on=1;next} on&&/;;$/{print;exit} on{print}' "$WF" | grep -oE 'empty confirm_[a-z0-9_]+' | sort -u | wc -l | tr -d ' ')|$(grep -c '|stage2a_tenant_drift_inspect|preflight|' "$WF")" "1|9|1"
check "the drift step runs only for its mode, passes no ARG, requires the REPORTED marker and its log is removed by the always-step" "$(grep -c "if: inputs.mode == 'stage2a_tenant_drift_inspect'" "$WF")|$(grep -E "PHASE='stage2a-tenant-drift' " "$WF" | grep -cE 'ARG[123]=' || true)|$(grep -c "grep -qx 'B25_STAGE2A_TENANT_DRIFT_REPORTED=TRUE'" "$WF")|$(grep -c '"\$RUNNER_TEMP"/stage2a-tenant-drift.log' "$WF")|$(grep -c 'tee "\$RUNNER_TEMP/stage2a-tenant-drift.log"' "$WF")" "1|0|1|1|1"
check "the branch guard requires the drift phase and its window constant" "$(grep -c "grep -q '^phase_stage2a_tenant_drift()' .github/scripts/b25-stage1-apply.sh && grep -q '^S2A_TENANT_LAST_MATCH=' .github/scripts/b25-stage1-apply.sh" "$WF")" "1"
# Modeled against the local read-only database: every reader returns a shape-valid counts line and nothing else.
eval "$(body s2a_counts_line)"; eval "$(body stage2a_tenant_drift_table_facts)"; eval "$(body s2a_bool)"
S2A_TENANT_COMPANY=1; S2A_TENANT_LAST_MATCH="$(grep -oE '^S2A_TENANT_LAST_MATCH="[^"]+"' "$APPLY" | cut -d'"' -f2)"; S2A_COUNTS_RE="$(grep -oE "^S2A_COUNTS_RE='[^']+'" "$APPLY" | cut -d"'" -f2)"
fail() { echo "FAIL:$*"; exit 1; }   # inside the command substitutions below: fail closed like the hosted script
td_lines=0; td_bad=0
for spec in "users 1 1" "roles 1 0" "contacts 1 1" "leads 1 1" "events 1 1" "tasks 1 0" "tags 1 1" "lead_tags 0 0" "documents 1 1" "workflow_definitions 1 0" "workflow_runs 1 0" "billing_checkout_sessions 1 0" "subscription_usage_reservations 0 0" "scans 0 1"; do
  # shellcheck disable=SC2086
  out="$(stage2a_tenant_drift_table_facts $spec 2>&1)" || { td_bad=$((td_bad+1)); continue; }
  td_lines=$((td_lines+1)); printf '%s' "$out" | grep -qE '^  [a-z_]+: total=[0-9]+ created_since=[0-9]+( modified_since=[0-9]+)?( soft_deleted_since=[0-9]+)?$' || td_bad=$((td_bad+1))
done
check "modeled: the fourteen per-table readers run read-only against the local database and return one shape-valid counts line each" "$td_lines|$td_bad" "14|0"
check "modeled: the kept-row counts and the user_roles / audit readers return shape-valid lines" "$(s2a_counts_line rows "select 'companies='||(select count(*) from companies)||' users='||(select count(*) from users)||' storage_objects='||(select count(*) from storage_objects)" | grep -cE '^  rows: companies=[0-9]+ users=[0-9]+ storage_objects=[0-9]+$')|$(s2a_counts_line user_roles "select 'total='||count(*)||' created_since='||count(*) filter (where ur.created_at >= '$S2A_TENANT_LAST_MATCH') from user_roles ur join users u on u.id = ur.user_id where u.company_id = 1" | grep -cE '^  user_roles: total=[0-9]+ created_since=[0-9]+$')|$(s2a_counts_line audit_rows_since "select 'company='||count(*) filter (where company_id = 1)||' other_company='||count(*) filter (where company_id is not null and company_id <> 1)||' no_company='||count(*) filter (where company_id is null) from audit_logs where created_at >= '$S2A_TENANT_LAST_MATCH'" | grep -cE '^  audit_rows_since: company=[0-9]+ other_company=[0-9]+ no_company=[0-9]+$')" "1|1|1"
check "modeled: a reader whose result is not a counts line fails closed and prints nothing of the value" "$(s2a_counts_line probe "select 'secret value'" 2>&1 | grep -c 'unexpected shape (not printed)')|$(s2a_counts_line probe "select 'secret value'" 2>&1 | grep -c 'secret' || true)" "1|0"
check "modeled: the subscription / company booleans and the sweep reader are valid read-only SQL" "$(q "select (updated_at >= '$S2A_TENANT_LAST_MATCH') from companies where id = 1" | grep -cE '^(t|f)?$')|$(q "select (status_changed_at >= '$S2A_TENANT_LAST_MATCH') from subscriptions where company_id = 1" >/dev/null && echo ok)|$(q "select t||' '||s||' n='||n from (select coalesce((payload::json)->>'task', '?') as t, status as s, count(*) as n from job_queue where name = 'recurring.sweep' and enqueued_at >= '$S2A_TENANT_LAST_MATCH' group by 1, 2) x order by 1" >/dev/null && echo ok)|$(s2a_bool t)|$(s2a_bool f)|$(s2a_bool "")" "1|ok|ok|true|false|unknown"
unset -f fail
echo "== Stage 2A — CORRECTION 3: existing-tenant safety model (pre-smoke snapshot → post-smoke comparison; attributed business movement; strict identity)"
LIB="$HERE/b25-stage1-apply-lib.sh"
check "constants: the protected tenant is company 1; the review instant is the last instant the whole accepted composition was proven equal (same as the drift report's last-match instant)" "$S2A_TENANT_ID|$S2A_TENANT_REVIEW_UTC|$(grep -oE '^S2A_TENANT_LAST_MATCH="[^"]+"' "$APPLY" | cut -d'"' -f2)" "1|2026-10-16 15:17:33|2026-10-16 15:17:33"
check "tiers: 10 strict identity keys, 2 sweep-movable status keys, 14 business tables each with an attribution spec" "$(echo $S2A_IDENTITY_KEYS | wc -w)|$(echo $S2A_SWEEP_KEYS | wc -w)|$(echo $S2A_BUSINESS_TABLES | wc -w)|$(n=0; for t in $S2A_BUSINESS_TABLES; do s2a_tbl_spec "$t" >/dev/null && n=$((n+1)); done; echo $n)|$(s2a_tbl_spec nonsense >/dev/null 2>&1 && echo bad || echo refused)" "10|2|14|14|refused"
check "the business tier covers every mutable table the old digest protected (contacts leads events tasks tags lead_tags documents workflow definitions/runs checkout intents usage reservations) plus scans, versions and follow-ups" "$(for t in contacts leads events tasks tags lead_tags documents workflow_definitions workflow_runs billing_checkout_sessions subscription_usage_reservations scans document_versions follow_ups; do echo " $S2A_BUSINESS_TABLES " | grep -q " $t " && printf y || printf n; done)" "yyyyyyyyyyyyyy"
check "the frozen whole-tenant digest and the fixed scan count are no longer Stage 2A gates (switched guard / smoke setup / cleanup bodies)" "$(for f in guards_stage2a_switched phase_stage2a_smoke_setup phase_stage2a_cleanup; do body "$f" | grep -cE 'TENANT_BASELINE_MD5|tenant_md5\)|company_id=1\")" = "4"' || true; done | tr '\n' ' ')" "0 0 0 "
check "the legacy originals' references invariant is kept in the switched guard" "$(body guards_stage2a_switched | grep -c 'references)" = "\$REFERENCES" ] || fail')" "1"
check "the start gate runs in the setup BEFORE the disposable owner insert" "$(a=$(body phase_stage2a_smoke_setup | grep -n '^  stage2a_tenant_start_gate$' | cut -d: -f1); b=$(body phase_stage2a_smoke_setup | grep -n 'insert into users' | cut -d: -f1); [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ] && echo ordered)" "ordered"
check "the post gate runs in the cleanup after the existing-rows equality proof and before the final inventory / census checks" "$(a=$(body phase_stage2a_cleanup | grep -n 'after" = "\$before"' | cut -d: -f1); b=$(body phase_stage2a_cleanup | grep -n '^  stage2a_tenant_post_gate "\$C" "\$U"$' | cut -d: -f1); c=$(body phase_stage2a_cleanup | grep -n 'final inventory / census / volume' | cut -d: -f1); [ -n "$a" ] && [ -n "$b" ] && [ -n "$c" ] && [ "$a" -lt "$b" ] && [ "$b" -lt "$c" ] && echo ordered)" "ordered"
check "the snapshot leaves the host as ONE base64 line and returns as the shell variable B25_TENANT_SNAPSHOT (never an argument; fail closed without it)" "$(body stage2a_tenant_start_gate | grep -c 'echo "B25_TENANT_SNAPSHOT=\$(printf')|$(body stage2a_tenant_post_gate | grep -c 'B25_TENANT_SNAPSHOT:-}" =~ \^\[A-Za-z0-9+/=\]{40,20000}\$')|$(body stage2a_tenant_post_gate | grep -c 'fail closed (no post-smoke verdict without it)')|$(body stage2a_tenant_post_gate | grep -cE '\$ARG[123]' || true)" "1|1|1|0"
check "every reader shape-checks its facts before anything is printed (counts, booleans, md5, fixed tokens, the tooling's own clock only)" "$(for fn in stage2a_tenant_start_gate stage2a_tenant_post_gate; do body "$fn" | grep -c 's2a_facts_ok'; done | tr '\n' ' ')|$(printf 'a_b=12\nc=true\nd=false\ne=0123456789abcdef0123456789abcdef\nf=-\ng=expired\nh=2026-10-16 15:17:33.123456\n' | { s2a_facts_ok "$(cat)" && echo ok; })|$(printf 'sub_status=John Doe\n' | { s2a_facts_ok "$(cat)" && echo accepted || echo refused; })|$(printf 'k=someone@example.com\n' | { s2a_facts_ok "$(cat)" && echo accepted || echo refused; })|$(printf 'k=/data/objects\n' | { s2a_facts_ok "$(cat)" && echo accepted || echo refused; })" "2 2 |ok|refused|refused|refused"
check "the identity digests never expose a value: emails and password hashes enter only through md5(), names through md5(), permissions only inside a digest" "$(body stage2a_tenant_identity_facts | grep -c 'md5(email)')|$(body stage2a_tenant_identity_facts | grep -c 'md5(password_hash)')|$(body stage2a_tenant_identity_facts | grep -c 'md5(name)')|$(body stage2a_tenant_identity_facts | grep -c '^  echo "id_')|$(body stage2a_tenant_identity_facts | grep -E '^  echo "id_' | grep -cvE 'select (md5\(|count\(|\(brand_logo_key is not null\))' || true)" "1|1|1|12|0"
check "the drift report reads the recurring sweep task from the plaintext dedupe key (queue payloads are encrypted at rest on the host)" "$(body phase_stage2a_tenant_drift | grep -c "split_part(dedupe_key, ':', 2)")|$(body phase_stage2a_tenant_drift | grep -c 'payload::json' || true)" "1|0"
for ph in stage2a-smoke-setup stage2a-cleanup; do
  check "workflow SSH step for $ph still exists exactly once" "$(grep -cE "PHASE='$ph' " "$WF")" "1"
done
check "workflow: the setup step requires B25_STAGE2A_TENANT_START_GATE=PASS, captures the snapshot line into a runner file and exports its path" "$(grep -c "grep -qx 'B25_STAGE2A_TENANT_START_GATE=PASS' \"\$RUNNER_TEMP/smoke-setup.log\"" "$WF")|$(grep -c "grep -oE '\^B25_TENANT_SNAPSHOT=\[A-Za-z0-9+/=\]+' \"\$RUNNER_TEMP/smoke-setup.log\"" "$WF")|$(grep -c 'printf .%s. "\$SNAP" > "\$RUNNER_TEMP/stage2a-tenant-snapshot.b64"' "$WF")|$(grep -c 'echo "S2A_TENANT_SNAPSHOT_FILE=\$RUNNER_TEMP/stage2a-tenant-snapshot.b64"' "$WF")" "1|1|1|1"
check "workflow: the cleanup step returns the snapshot as the FIRST stdin line (shell variable, never an argument) and fails closed without the runner file" "$(grep -c "{ printf 'B25_TENANT_SNAPSHOT=%s\\\\n' \"\$SNAP\"; cat .github/scripts/b25-stage1-purge-lib.sh .github/scripts/b25-stage1-apply-lib.sh .github/scripts/b25-stage1-apply.sh; } | ssh vps \"DEPLOY_PATH='\$VPS_DEPLOY_PATH' PHASE='stage2a-cleanup' ARG1='\$C' ARG2='\$U' ARG3='\$SMOKE_TAG' bash -s\"" "$WF")|$(grep -c 'echo "::error::pre-smoke tenant snapshot missing on the runner"' "$WF")|$(grep -E "PHASE='stage2a-cleanup' " "$WF" | grep -c 'SNAPSHOT' )" "1|1|1"
check "workflow: the snapshot file is removed by the cleanup and by the always-step; the branch guard requires the five Correction 3 functions and refuses a frozen digest inside the Stage 2A gates" "$(grep -c '"\$RUNNER_TEMP"/stage2a-tenant-snapshot.b64' "$WF")|$(grep -c '"\$RUNNER_TEMP/stage2a-tenant-snapshot.b64"' "$WF")|$(grep -c "grep -q '^stage2a_tenant_start_eval()' .github/scripts/b25-stage1-apply-lib.sh && grep -q '^stage2a_tenant_post_eval()' .github/scripts/b25-stage1-apply-lib.sh && grep -q '^readonly S2A_TENANT_REVIEW_UTC=' .github/scripts/b25-stage1-apply-lib.sh && grep -q '^stage2a_tenant_start_gate()' .github/scripts/b25-stage1-apply.sh && grep -q '^stage2a_tenant_post_gate()' .github/scripts/b25-stage1-apply.sh" "$WF")|$(grep -c 'the frozen whole-tenant digest is still a Stage 2A gate' "$WF")" "1|2|1|1"
for fn in stage2a_tenant_identity_facts stage2a_tenant_business_facts stage2a_tenant_window_facts stage2a_tenant_since_facts stage2a_tenant_start_gate stage2a_tenant_post_gate; do
  B="$(body "$fn")"
  check "$fn: body present, read-only (no qw, no mutation command), never ARG-driven" "$(printf '%s\n' "$B" | grep -c "^$fn")|$(printf '%s\n' "$B" | grep -cE '(^|[^a-z_])qw ' || true)|$(printf '%s\n' "$B" | grep -ciE '"(delete|update|insert|truncate|drop|alter) |compose (up|down|rm|restart|stop|kill)|docker (rm|stop|kill|restart|volume rm)|rm -r|purge_rows_sql|\.delete\(|stage2a_env_apply|stage2a_recreate_api' || true)|$(printf '%s\n' "$B" | grep -cE '\$ARG[123]|\$\{ARG[123]' || true)" "1|0|0|0"
done

# ---- evaluator unit tests (pure; canned facts) ----
c3_mut() { local F="$1" m k v; shift; for m in "$@"; do k="${m%%=*}"; v="${m#*=}"; if printf '%s\n' "$F" | grep -q "^$k="; then F="$(printf '%s\n' "$F" | sed "s|^$k=.*|$k=$v|")"; else F="$F"$'\n'"$k=$v"; fi; done; printf '%s\n' "$F"; }
c3_del() { local F="$1" k; shift; for k in "$@"; do F="$(printf '%s\n' "$F" | grep -v "^$k=")"; done; printf '%s\n' "$F"; }
START_GOLDEN="$(cat <<'G'
review_utc_ok=true
users_created_since=0
users_soft_deleted_since=0
users_modified_since=0
users_modified_login_explained=0
sec_audit_rows_since=0
roles_changed_since=0
user_roles_created_since=0
company_modified_since=false
sub_modified_since=false
sub_status_changed_since=false
sub_status=trialing
sweep_audit_rows_since=0
sub_trial_elapsed=false
tenant_storage_rows=0
references=4
references_expected=4
G
)"
sv() { printf '%s\n' "$1" | stage2a_tenant_start_eval || true; }   # a FAIL verdict is data here, never an abort
check "start gate: golden evidence → PASS, nothing surfaced" "$(sv "$START_GOLDEN" | grep -E '^B25_STAGE2A_TENANT_START_' | tr '\n' ' ')" "B25_STAGE2A_TENANT_START_SURFACED=0 B25_STAGE2A_TENANT_START_GATE=PASS "
while IFS='|' read -r label mut want; do
  V="$(sv "$(c3_mut "$START_GOLDEN" $mut)")"
  check "start gate: $label" "$(printf '%s\n' "$V" | grep -oE '^B25_STAGE2A_TENANT_START_GATE=(PASS|FAIL)' | cut -d= -f2)|$(printf '%s\n' "$V" | grep -cE 'SURFACED FOR REVIEW' || true)" "$want"
done <<'T'
ordinary contact creation between the historical review and today does NOT invalidate the gate|bz_contacts_created_since=25|PASS|0
ordinary event / task / lead activity before the smoke does NOT invalidate the starting gate|bz_events_created_since=2 bz_tasks_modified_since=3 bz_leads_created_since=1 bz_leads_modified_since=4|PASS|0
the exact evidence of run 38946910989 (three scans, three reservations, one login-explained user touch) → PASS|bz_scans_created_since=3 bz_subscription_usage_reservations_created_since=3 users_modified_since=1 users_modified_login_explained=1|PASS|0
a user created since the review is surfaced|users_created_since=1|FAIL|1
a user removed since the review is surfaced|users_soft_deleted_since=1|FAIL|1
a user row modified without a login explanation is surfaced|users_modified_since=1 users_modified_login_explained=0|FAIL|1
two modified rows with one login explanation are surfaced|users_modified_since=2 users_modified_login_explained=1|FAIL|1
a role change is surfaced|roles_changed_since=1|FAIL|1
a role assignment is surfaced|user_roles_created_since=1|FAIL|1
an identity / permission audit action is surfaced (permission digest change)|sec_audit_rows_since=1|FAIL|1
subscription modified without sweep evidence is surfaced|sub_modified_since=true|FAIL|1
subscription status moved without sweep evidence is surfaced|sub_status_changed_since=true|FAIL|1
the expected manual-trial sweep is accepted ONLY with evidence (audit row by the system actor + elapsed trial + expired status)|sub_modified_since=true sub_status_changed_since=true sub_status=expired sweep_audit_rows_since=1 sub_trial_elapsed=true|PASS|0
sweep claimed but the trial has not elapsed → surfaced|sub_modified_since=true sub_status_changed_since=true sub_status=expired sweep_audit_rows_since=1 sub_trial_elapsed=false|FAIL|1
sweep claimed without its audit row → surfaced|sub_modified_since=true sub_status_changed_since=true sub_status=expired sweep_audit_rows_since=0 sub_trial_elapsed=true|FAIL|1
sweep claimed but the status is not expired → surfaced|sub_modified_since=true sub_status_changed_since=true sub_status=active sweep_audit_rows_since=1 sub_trial_elapsed=true|FAIL|1
company row modified without sweep evidence is surfaced|company_modified_since=true|FAIL|1
company status mirror of a proven sweep is accepted|company_modified_since=true sub_status_changed_since=true sub_status=expired sweep_audit_rows_since=1 sub_trial_elapsed=true|PASS|0
a storage object of the existing tenant fails the gate|tenant_storage_rows=1|FAIL|0
a changed legacy originals' reference count fails the gate|references=5|FAIL|0
a review instant that is not in the past fails the gate|review_utc_ok=false|FAIL|0
T
check "start gate: a surfaced component is named (user set / role / permission / subscription) so the reviewer knows what moved" "$(sv "$(c3_mut "$START_GOLDEN" users_created_since=1 roles_changed_since=1 sec_audit_rows_since=2 sub_modified_since=true)" | grep -E 'SURFACED FOR REVIEW' | grep -oE 'user set changed|role movement|identity / permission audit|subscription movement' | sort -u | tr '\n' ' ')" "identity / permission audit role movement subscription movement user set changed "
check "start gate: evidence with a customer-looking value is refused before anything is evaluated" "$(sv "$(c3_mut "$START_GOLDEN" "sub_status=John")" | grep -c PASS || true)|$(sv "$(c3_mut "$START_GOLDEN" "sub_status=John Doe")" | grep -c 'unexpected shape')" "1|1"

POST_GOLDEN="$(cat <<'G'
snapshot_at=2026-10-16 17:00:00.000000
pre_id_company_md5=11111111111111111111111111111111
post_id_company_md5=11111111111111111111111111111111
pre_id_company_status_md5=22222222222222222222222222222222
post_id_company_status_md5=22222222222222222222222222222222
pre_id_sub_core_md5=33333333333333333333333333333333
post_id_sub_core_md5=33333333333333333333333333333333
pre_id_sub_status_md5=44444444444444444444444444444444
post_id_sub_status_md5=44444444444444444444444444444444
pre_id_users_count=1
post_id_users_count=1
pre_id_users_active=1
post_id_users_active=1
pre_id_users_md5=55555555555555555555555555555555
post_id_users_md5=55555555555555555555555555555555
pre_id_roles_count=0
post_id_roles_count=0
pre_id_roles_md5=66666666666666666666666666666666
post_id_roles_md5=66666666666666666666666666666666
pre_id_user_roles_count=0
post_id_user_roles_count=0
pre_id_user_roles_md5=77777777777777777777777777777777
post_id_user_roles_md5=77777777777777777777777777777777
pre_id_brand_logo_set=false
post_id_brand_logo_set=false
tenant_audit_rows_window=0
disposable_audit_on_tenant=0
tenant_rows_ref_disposables=0
disposable_rows_ref_tenant=0
tenant_storage_rows_post=0
tenant_storage_created_window=0
tenant_storage_deleted_window=0
sweep_audit_rows_window=0
sub_status_post=trialing
sub_trial_elapsed=false
references_post=4
references_expected=4
G
)"
for t in $S2A_BUSINESS_TABLES; do
  POST_GOLDEN="$POST_GOLDEN"$'\n'"pre_${t}_count=5"$'\n'"post_${t}_count=5"$'\n'"${t}_created_window=0"$'\n'"${t}_modified_window=0"$'\n'"${t}_soft_deleted_window=0"$'\n'"${t}_created_by_disposable=0"$'\n'"${t}_created_by_tenant=0"$'\n'"${t}_automated_explained=0"
done
pv() { printf '%s\n' "$1" | stage2a_tenant_post_eval || true; }
check "post gate: golden facts (nothing moved) → PASS, 0 concurrent tables" "$(pv "$POST_GOLDEN" | grep -E '^B25_STAGE2A_TENANT_' | tr '\n' ' ')" "B25_STAGE2A_TENANT_CONCURRENT_TABLES=0 B25_STAGE2A_TENANT_POST_GATE=PASS "
while IFS='|' read -r label mut want; do
  V="$(pv "$(c3_mut "$POST_GOLDEN" $mut)")"
  check "post gate: $label" "$(printf '%s\n' "$V" | grep -oE '^B25_STAGE2A_TENANT_POST_GATE=(PASS|FAIL)' | cut -d= -f2)|$(printf '%s\n' "$V" | grep -oE '^B25_STAGE2A_TENANT_CONCURRENT_TABLES=[0-9]+' | cut -d= -f2)|$(printf '%s\n' "$V" | grep -cE '^post: FAIL' || true)" "$want"
done <<'T'
concurrent tenant activity DURING the smoke, attributed by actor and audit (contacts created by tenant users) → allowed, reported|contacts_created_window=2 contacts_created_by_tenant=2 post_contacts_count=7 tenant_audit_rows_window=2|PASS|1|0
a scan + its reservation during the smoke by a tenant user (actor-less reservation attributed by the tenant's audit rows) → allowed|scans_created_window=1 scans_created_by_tenant=1 post_scans_count=6 subscription_usage_reservations_created_window=1 post_subscription_usage_reservations_count=6 tenant_audit_rows_window=1|PASS|2|0
the smoke itself created a tenant row (actor = disposable identity) → detected|contacts_created_window=1 contacts_created_by_disposable=1 post_contacts_count=6|FAIL|0|1
a disposable identity acted on the existing tenant (audit) → detected|disposable_audit_on_tenant=1|FAIL|0|1
a tenant row hard-deleted during the smoke → detected|post_contacts_count=4|FAIL|0|1
the existing tenant deleted during the smoke (identity gone, every count down) → detected|post_id_users_count=0 post_id_users_active=0 post_contacts_count=0 post_leads_count=0 post_events_count=0 post_scans_count=0|FAIL|0|6
a tenant row referencing a disposable event / user (cross-tenant association) → detected|tenant_rows_ref_disposables=1|FAIL|0|1
a disposable row referencing a tenant user → detected|disposable_rows_ref_tenant=1|FAIL|0|1
an unexplained during-smoke modification (no actor, no tenant audit, not automated) fails closed|contacts_modified_window=1|FAIL|0|1
an unexplained during-smoke creation in an actor-less table fails closed|tags_created_window=1 post_tags_count=6|FAIL|0|1
a creation in an actor table by nobody attributable fails closed|contacts_created_window=1 contacts_created_by_tenant=0 post_contacts_count=6 tenant_audit_rows_window=1|FAIL|0|1
an automated product transition (workflow runs finished) is explained|workflow_runs_modified_window=2 workflow_runs_automated_explained=2|PASS|1|0
a partially explained automated transition fails closed|workflow_runs_modified_window=2 workflow_runs_automated_explained=1|FAIL|0|1
permission digest changed during the smoke → detected|post_id_users_md5=99999999999999999999999999999999|FAIL|0|1
user count changed during the smoke → detected|post_id_users_count=2|FAIL|0|1
role digest changed during the smoke → detected|post_id_roles_md5=99999999999999999999999999999999|FAIL|0|1
role assignment changed during the smoke → detected|post_id_user_roles_count=1|FAIL|0|1
subscription plan / source / provider identity / overrides changed during the smoke → detected|post_id_sub_core_md5=99999999999999999999999999999999|FAIL|0|1
company identity (name / plan / mfa / logo key) changed during the smoke → detected|post_id_company_md5=99999999999999999999999999999999|FAIL|0|1
the managed logo touched during the smoke → detected|post_id_brand_logo_set=true|FAIL|0|1
subscription status moved during the smoke without sweep evidence → detected|post_id_sub_status_md5=99999999999999999999999999999999|FAIL|0|1
the expected sweep during the smoke is accepted with evidence (status + mirror)|post_id_sub_status_md5=99999999999999999999999999999999 post_id_company_status_md5=99999999999999999999999999999999 sweep_audit_rows_window=1 sub_status_post=expired sub_trial_elapsed=true|PASS|0|0
a tenant storage object created during the smoke → detected|tenant_storage_created_window=1|FAIL|0|1
a tenant storage object present after the smoke → detected|tenant_storage_rows_post=1|FAIL|0|1
a legacy originals' reference lost → detected|references_post=3|FAIL|0|1
T
check "post gate: a snapshot lacking an identity key fails closed" "$(pv "$(c3_del "$POST_GOLDEN" pre_id_users_md5)" | grep -oE '^B25_STAGE2A_TENANT_POST_GATE=(PASS|FAIL)' | cut -d= -f2)|$(pv "$(c3_del "$POST_GOLDEN" snapshot_at)" | grep -oE '^B25_STAGE2A_TENANT_POST_GATE=(PASS|FAIL)' | cut -d= -f2)" "FAIL|FAIL"
check "post gate: concurrent activity is distinguishable from smoke-caused activity in the same run (one table attributed to tenant users, another to the disposable owner → FAIL names the smoke-caused one)" "$(pv "$(c3_mut "$POST_GOLDEN" contacts_created_window=1 contacts_created_by_tenant=1 post_contacts_count=6 tenant_audit_rows_window=1 leads_created_window=1 leads_created_by_disposable=1 post_leads_count=6)" | grep -E '^post: (FAIL|contacts)' | sed -E 's/ *\(.*//' | tr '\n' ' ')" "post: contacts: concurrent tenant activity during the smoke post: FAIL: leads: 1 row "
check "post gate: no verdict line ever carries a customer-looking value (digests and counts only in the golden run)" "$(pv "$POST_GOLDEN" | grep -cE '@|/data|gs://|[A-Z][a-z]+ [A-Z][a-z]+' || true)" "0"

# ---- database-modeled tests: the readers against the local read-only database (company 1 = the local fixture tenant) ----
C3_C=900003; C3_TAG="c3$(head -c 2 /dev/urandom | od -An -tx1 | tr -d ' \n')"; C3_UIDS=""; C3_CIDS=""; C3_EIDS=""; C3_AIDS=""; C3_SUB_BEFORE=""
cleanup_c3() {
  [ -n "$C3_AIDS" ] && qw "delete from audit_logs where id in ($C3_AIDS)" >/dev/null 2>&1 || true
  [ -n "$C3_CIDS" ] && qw "delete from contacts where id in ($C3_CIDS)" >/dev/null 2>&1 || true
  [ -n "$C3_EIDS" ] && qw "delete from events where id in ($C3_EIDS)" >/dev/null 2>&1 || true
  qw "delete from contacts where company_id = $C3_C" >/dev/null 2>&1 || true
  qw "delete from events where company_id = $C3_C" >/dev/null 2>&1 || true
  [ -n "$C3_UIDS" ] && qw "delete from users where id in ($C3_UIDS)" >/dev/null 2>&1 || true
  qw "delete from users where company_id = $C3_C" >/dev/null 2>&1 || true
  qw "delete from subscriptions where company_id = $C3_C" >/dev/null 2>&1 || true
  qw "delete from companies where id = $C3_C" >/dev/null 2>&1 || true
  [ -n "$C3_SUB_BEFORE" ] && qw "update subscriptions set status = split_part('$C3_SUB_BEFORE','|',1), status_changed_at = split_part('$C3_SUB_BEFORE','|',2)::timestamp, trial_expires_at = nullif(split_part('$C3_SUB_BEFORE','|',3),'')::timestamp, ended_at = null where company_id = 1" >/dev/null 2>&1 || true
}
if [ "$(q "select count(*) from companies where id = 1")" = "1" ] && [ "$(q "select count(*) from companies where id = $C3_C")" = "0" ] && [ "$(q "select count(*) from users where company_id = 1 and deleted_at is null")" -ge 1 ]; then
  eval "$(body stage2a_tenant_identity_facts)"; eval "$(body stage2a_tenant_business_facts)"; eval "$(body stage2a_tenant_window_facts)"; eval "$(body stage2a_tenant_since_facts)"
  s2a_tenant_users_in="(select id from users where company_id = $S2A_TENANT_ID)"
  references() { echo 4; }; REFERENCES=4
  fail() { echo "FAIL:$*"; exit 1; }
  TENANT_UID="$(q "select min(id) from users where company_id = 1 and deleted_at is null")"
  # pre-smoke snapshot
  SNAP="$( { echo "snapshot_at=$(q "select to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS.US')")"; stage2a_tenant_identity_facts | sed 's/^/pre_/'; stage2a_tenant_business_facts pre; } )"
  check "modeled: the pre-smoke snapshot has the sanitized shape, every identity key, every business count and the instant" "$(s2a_facts_ok "$SNAP" && echo ok)|$(for k in $S2A_IDENTITY_KEYS $S2A_SWEEP_KEYS; do printf '%s\n' "$SNAP" | grep -q "^pre_$k=" && printf y || printf n; done)|$(for t in $S2A_BUSINESS_TABLES; do printf '%s\n' "$SNAP" | grep -q "^pre_${t}_count=[0-9]" && printf y || printf n; done)|$(printf '%s\n' "$SNAP" | grep -c '^snapshot_at=20')" "ok|yyyyyyyyyyyy|yyyyyyyyyyyyyy|1"
  check "modeled: the snapshot prints no email, name, path or permission text (digests and counts only)" "$(printf '%s\n' "$SNAP" | grep -cE '@|/|\{|"' || true)" "0"
  SINCE="$(printf '%s\n' "$SNAP" | awk -F= '$1=="snapshot_at"{print $2}')"
  B64="$(printf '%s\n' "$SNAP" | base64 -w0)"
  check "modeled: the snapshot round-trips through base64 unchanged" "$([ "$(printf '%s' "$B64" | base64 -d)" = "$SNAP" ] && echo same)" "same"
  # start gate evidence with a review instant one second in the past: a quiet tenant passes
  # The local fixture tenant carries the Stage 1 rehearsal's storage rows (a hosted tenant has none): that one fact is
  # neutralized here so the modeled run exercises the readers and every other rule on the quiet tenant.
  c3_quiet() { stage2a_tenant_since_facts "$1" | sed 's/^tenant_storage_rows=.*/tenant_storage_rows=0/'; }
  check "modeled: the start gate passes on a quiet tenant with a review instant in the past; fails closed on a review instant in the future; the real storage-row fact of the fixture tenant is read" "$(c3_quiet "$(date -u -d '1 second ago' '+%Y-%m-%d %H:%M:%S')" | stage2a_tenant_start_eval | grep -oE '^B25_STAGE2A_TENANT_START_GATE=(PASS|FAIL)' | cut -d= -f2)|$(c3_quiet "$(date -u -d '1 day' '+%Y-%m-%d %H:%M:%S')" | stage2a_tenant_start_eval | grep -oE '^B25_STAGE2A_TENANT_START_GATE=(PASS|FAIL)' | cut -d= -f2)|$(stage2a_tenant_since_facts "$(date -u -d '1 second ago' '+%Y-%m-%d %H:%M:%S')" | grep -c '^tenant_storage_rows=[0-9]')" "PASS|FAIL|1"
  # disposable identities: an owner without a tenant (as the smoke inserts it), a disposable company with an event
  DU="$(qw "insert into users (email, name, role, company_id, password_hash, is_active, permissions) values ('b25-smoke-$C3_TAG-owner@b25smoke.invalid', 'B25 smoke operator (disposable)', 'platform_owner', null, 'x', true, '{}'::jsonb) returning id")"; C3_UIDS="$DU"
  qw "insert into companies (id, name, plan, status) values ($C3_C, 'B25 SMOKE $C3_TAG', 'free', 'active')" >/dev/null
  DE="$(qw "insert into events (company_id, name, status, created_by_id) values ($C3_C, 'B25 SMOKE $C3_TAG event', 'active', $DU) returning id")"
  # The fixture tenant's Stage 1 rehearsal storage rows are neutralized the same way for the post gate (see c3_quiet);
  # the real reader value is asserted once below.
  post_facts() { { printf '%s\n' "$SNAP"; stage2a_tenant_identity_facts | sed 's/^/post_/'; stage2a_tenant_business_facts post; stage2a_tenant_window_facts "$SINCE" "$C3_C" "$DU"; echo "references_post=4"; echo "references_expected=4"; } | sed 's/^tenant_storage_rows_post=.*/tenant_storage_rows_post=0/'; }
  check "modeled: the storage reader reports the fixture tenant's real storage-row count (neutralized only for the modeled verdicts)" "$(stage2a_tenant_window_facts "$SINCE" "$C3_C" "$DU" | grep -oE '^tenant_storage_rows_post=[0-9]+' | cut -d= -f2)" "$(q "select count(*) from storage_objects where company_id = 1")"
  verdict() { post_facts | stage2a_tenant_post_eval | grep -oE '^B25_STAGE2A_TENANT_POST_GATE=(PASS|FAIL)' | cut -d= -f2; }
  check "modeled: a disposable owner (no tenant) and a disposable company with an event do not move the existing tenant → PASS" "$(verdict)|$(post_facts | grep -c '^disposable_rows_ref_tenant=0$')" "PASS|1"
  # (a) concurrent tenant activity during the smoke: a contact created by a tenant user with its audit row → allowed and attributed
  TC="$(qw "insert into contacts (company_id, first_name, last_name, full_name, tags, status, created_by_id) values (1, 'C3', 'Concurrent $C3_TAG', 'C3 Concurrent $C3_TAG', '[]', 'new', $TENANT_UID) returning id")"; C3_CIDS="$TC"
  TA="$(qw "insert into audit_logs (company_id, user_id, action, entity_type, entity_id) values (1, $TENANT_UID, 'contacts.post', 'contacts', '$TC') returning id")"; C3_AIDS="$TA"
  check "modeled: concurrent tenant activity during the smoke (contact by a tenant user + its audit row) → PASS, attributed (created_by_tenant=1, tenant audit=1), reported as concurrent" "$(verdict)|$(post_facts | grep -E '^(contacts_created_window|contacts_created_by_tenant|contacts_created_by_disposable|tenant_audit_rows_window)=' | tr '\n' ' ')|$(post_facts | stage2a_tenant_post_eval | grep -c '^post: contacts: concurrent tenant activity')" "PASS|contacts_created_window=1 contacts_created_by_disposable=0 contacts_created_by_tenant=1 tenant_audit_rows_window=1 |1"
  # (b) the smoke mutates the tenant: a contact created by the disposable owner → FAIL
  DC="$(qw "insert into contacts (company_id, first_name, last_name, full_name, tags, status, created_by_id) values (1, 'C3', 'Smoke $C3_TAG', 'C3 Smoke $C3_TAG', '[]', 'new', $DU) returning id")"; C3_CIDS="$C3_CIDS,$DC"
  check "modeled: a tenant row created by the disposable owner → FAIL (smoke mutated the existing tenant)" "$(verdict)|$(post_facts | stage2a_tenant_post_eval | grep -c 'created by a disposable smoke identity')" "FAIL|1"
  qw "delete from contacts where id = $DC" >/dev/null; C3_CIDS="$TC"
  # (c) a disposable identity acting on the tenant (audit) → FAIL
  DA="$(qw "insert into audit_logs (company_id, user_id, action, entity_type, entity_id) values (1, $DU, 'contacts.patch', 'contacts', '$TC') returning id")"; C3_AIDS="$C3_AIDS,$DA"
  check "modeled: an audit action of the disposable owner on the existing tenant → FAIL" "$(verdict)|$(post_facts | grep -c '^disposable_audit_on_tenant=1$')" "FAIL|1"
  qw "delete from audit_logs where id = $DA" >/dev/null; C3_AIDS="$TA"
  # (d) cross-tenant association: the tenant contact points at the disposable event → FAIL
  qw "update contacts set event_id = $DE where id = $TC" >/dev/null
  check "modeled: a tenant contact referencing a disposable event (cross-tenant association) → FAIL" "$(verdict)|$(post_facts | grep -c '^tenant_rows_ref_disposables=1$')" "FAIL|1"
  qw "update contacts set event_id = null where id = $TC" >/dev/null
  # (e) a disposable row referencing a tenant user → FAIL
  XC="$(qw "insert into contacts (company_id, first_name, last_name, full_name, tags, status, created_by_id) values ($C3_C, 'X', 'Ref $C3_TAG', 'X Ref $C3_TAG', '[]', 'new', $TENANT_UID) returning id")"
  check "modeled: a disposable-tenant row created by a tenant user → FAIL" "$(verdict)|$(post_facts | grep -c '^disposable_rows_ref_tenant=1$')" "FAIL|1"
  qw "delete from contacts where id = $XC" >/dev/null
  # (f) a hard deletion of a pre-existing tenant row is detected (count below the snapshot)
  PRE_CONTACT="$(q "select min(id) from contacts where company_id = 1 and created_at < '$SINCE'")"
  if [ -n "$PRE_CONTACT" ]; then
    ROW="$(q "select row_to_json(c)::text from contacts c where id = $PRE_CONTACT")"
    qw "delete from contacts where id = $PRE_CONTACT" >/dev/null
    check "modeled: a pre-existing tenant row hard-deleted during the smoke → FAIL (hard deletion named)" "$(verdict)|$(post_facts | stage2a_tenant_post_eval | grep -c 'hard-deleted during the smoke')" "FAIL|1"
    qw "insert into contacts select * from json_populate_record(null::contacts, '$(printf '%s' "$ROW" | sed "s/'/''/g")')" >/dev/null
  else
    TC2="$(qw "insert into contacts (company_id, first_name, last_name, full_name, tags, status, created_by_id, created_at) values (1, 'C3', 'Old $C3_TAG', 'C3 Old $C3_TAG', '[]', 'new', $TENANT_UID, now() - interval '1 day') returning id")"
    SNAP2="$( { echo "snapshot_at=$(q "select to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS.US')")"; stage2a_tenant_identity_facts | sed 's/^/pre_/'; stage2a_tenant_business_facts pre; } )"
    qw "delete from contacts where id = $TC2" >/dev/null
    check "modeled: a pre-existing tenant row hard-deleted during the smoke → FAIL (hard deletion named)" "$( { printf '%s\n' "$SNAP2"; stage2a_tenant_identity_facts | sed 's/^/post_/'; stage2a_tenant_business_facts post; stage2a_tenant_window_facts "$(printf '%s\n' "$SNAP2" | awk -F= '$1=="snapshot_at"{print $2}')" "$C3_C" "$DU"; echo "references_post=4"; echo "references_expected=4"; } | stage2a_tenant_post_eval | grep -cE 'hard-deleted during the smoke|B25_STAGE2A_TENANT_POST_GATE=FAIL')" "2"
  fi
  # (g) identity: a permission change of a tenant user during the smoke → FAIL (digest), then reverted
  PERM_BEFORE="$(q "select coalesce(permissions::text,'{}') from users where id = $TENANT_UID")"
  qw "update users set permissions = '{\"c3\":[\"view\"]}'::jsonb where id = $TENANT_UID" >/dev/null
  check "modeled: a permission change of a tenant user during the smoke → FAIL on the users digest" "$(verdict)|$(post_facts | stage2a_tenant_post_eval | grep -c 'id_users_md5')" "FAIL|1"
  qw "update users set permissions = '$(printf '%s' "$PERM_BEFORE" | sed "s/'/''/g")'::jsonb where id = $TENANT_UID" >/dev/null
  check "modeled: after the revert the users digest is the snapshot's again → PASS" "$(verdict)" "PASS"
  # (h) the expected sweep during the smoke: accepted only with the audit row by the system actor
  C3_SUB_BEFORE="$(q "select status||'|'||status_changed_at||'|'||coalesce(trial_expires_at::text,'') from subscriptions where company_id = 1")"
  if [ -n "$C3_SUB_BEFORE" ]; then
    # The sweep moves ONLY status / status_changed_at / ended_at: the trial instant is part of the strict core digest and
    # belongs to the PRE state, so the modeled snapshot is taken with the elapsed trial already recorded.
    qw "update subscriptions set trial_expires_at = now() - interval '1 hour' where company_id = 1" >/dev/null
    SNAP_SW="$( { echo "snapshot_at=$(q "select to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS.US')")"; stage2a_tenant_identity_facts | sed 's/^/pre_/'; stage2a_tenant_business_facts pre; } )"
    SINCE_SW="$(printf '%s\n' "$SNAP_SW" | awk -F= '$1=="snapshot_at"{print $2}')"
    sw_facts() { { printf '%s\n' "$SNAP_SW"; stage2a_tenant_identity_facts | sed 's/^/post_/'; stage2a_tenant_business_facts post; stage2a_tenant_window_facts "$SINCE_SW" "$C3_C" "$DU"; echo "references_post=4"; echo "references_expected=4"; } | sed 's/^tenant_storage_rows_post=.*/tenant_storage_rows_post=0/'; }
    sw_verdict() { sw_facts | stage2a_tenant_post_eval | grep -oE '^B25_STAGE2A_TENANT_POST_GATE=(PASS|FAIL)' | cut -d= -f2; }
    qw "update subscriptions set status = 'expired', status_changed_at = now(), ended_at = now() where company_id = 1" >/dev/null
    check "modeled: a subscription status movement during the smoke WITHOUT the sweep's audit row → FAIL (status digest named)" "$(sw_verdict)|$(sw_facts | stage2a_tenant_post_eval | grep -c 'status movement during the smoke without sweep evidence: id_sub_status_md5')" "FAIL|1"
    SA="$(qw "insert into audit_logs (company_id, user_id, action, entity_type, entity_id) values (1, null, 'subscription.trial_expired', 'subscription', '1') returning id")"; C3_AIDS="$C3_AIDS,$SA"
    check "modeled: the same movement WITH the sweep's audit row (system actor), an elapsed trial and the expired status → accepted as the expected sweep" "$(sw_verdict)|$(sw_facts | stage2a_tenant_post_eval | grep -c 'EXPECTED SWEEP')" "PASS|1"
    check "modeled: a sweep audit row written by a USER (not the system actor) is not sweep evidence" "$(qw "update audit_logs set user_id = $TENANT_UID where id = $SA" >/dev/null; sw_verdict)" "FAIL"
    qw "update subscriptions set status = split_part('$C3_SUB_BEFORE','|',1), status_changed_at = split_part('$C3_SUB_BEFORE','|',2)::timestamp, trial_expires_at = nullif(split_part('$C3_SUB_BEFORE','|',3),'')::timestamp, ended_at = null where company_id = 1" >/dev/null; C3_SUB_BEFORE=""
    qw "delete from audit_logs where id = $SA" >/dev/null; C3_AIDS="$TA"
  fi
  # (i) the start gate surfaces a user created since the review
  NU="$(qw "insert into users (email, name, role, company_id, password_hash, is_active, permissions) values ('c3-$C3_TAG@example.invalid', 'C3 new user', 'employee', 1, 'x', true, '{}'::jsonb) returning id")"; C3_UIDS="$C3_UIDS,$NU"
  check "modeled: a tenant user created since the review instant is SURFACED by the start gate; the post gate also sees the identity change" "$(c3_quiet "$(date -u -d '1 hour ago' '+%Y-%m-%d %H:%M:%S')" | stage2a_tenant_start_eval | grep -c 'SURFACED FOR REVIEW: user set changed' || true)|$(verdict)" "1|FAIL"
  qw "delete from users where id = $NU" >/dev/null; C3_UIDS="$DU"
  check "modeled: the Stage 1 exception row and the provider baseline are never touched by the tenant gates (the readers only select from the tenant's tables; the exception company is not the tenant)" "$(for fn in stage2a_tenant_identity_facts stage2a_tenant_business_facts stage2a_tenant_window_facts stage2a_tenant_since_facts; do body "$fn" | grep -cE 'B25PHYS_|gs://|ifGenerationMatch' || true; done | tr '\n' ' ')|$(q "select count(*) from storage_objects where id = '$B25PHYS_UUID'")" "0 0 0 0 |$(q "select count(*) from storage_objects where id = '$B25PHYS_UUID'")"
  unset -f fail
  cleanup_c3
else
  echo "note: the local database has no company-1 fixture tenant (or id $C3_C is taken) — the modeled Correction 3 cases are exercised by the evaluator mutations only"
fi

echo "== Stage 2A — CORRECTION 4: mid-smoke guard form, company-58 manifest, retrospective incident proof, residue-3 modes"
# ---- manifest 3 (the EXACT residue of run 38958264416) ----
check "manifest 3 = exactly the recorded residue of run 38958264416 (both uuids read unmasked from the run log)" "$S2AR3_MANIFEST" "ac3c33c3-853e-4003-a03e-a8b357a282ac,c097cd52-270e-418c-8e75-0a0dfd1f2312|58,59|109|ec7ceda89a58"
check "manifest 3 run / tag / company / companies / users / rows / sizes" "$S2AR3_RUN|$S2AR3_TAG|$S2AR3_COMPANY|$S2AR3_COMPANIES|$S2AR3_USERS|$S2AR3_ROWS|$S2AR3_DOC_SIZE|$S2AR3_LOGO_SIZE" "38958264416|ec7ceda89a58|58|58,59|109|2|21546|181"
check "manifest 3 row identities (uuid → kind → recorded size) and an unknown uuid" "$(s2ar3_kind "$S2AR3_UUID_DOC")=$(s2ar3_size "$S2AR3_UUID_DOC")|$(s2ar3_kind "$S2AR3_UUID_LOGO")=$(s2ar3_size "$S2AR3_UUID_LOGO")|$(s2ar3_kind "$S2AR2_UUID_DOC" 2>/dev/null || echo none)" "document=21546|branding_logo=181|none"
check "manifest 3 window constants (STEP=run 19:54:56–19:55:04Z; tenant 58 deleted 19:55:22Z; rows deleted by 19:55:35Z) and the incident window (snapshot instant → cleanup end)" "$S2AR3_CREATED_FROM|$S2AR3_CREATED_TO|$S2AR3_DELETED_FROM|$S2AR3_DELETED_TO|$S2AR3_SNAPSHOT_AT|$S2AR3_INCIDENT_END" "2026-10-16 19:54:50|2026-10-16 19:55:10|2026-10-16 19:55:20|2026-10-16 19:56:00|2026-10-16 19:54:40.127290|2026-10-16 19:55:40"
check "manifest 3 self-check passes; the recorded snapshot decodes to 41 sanitized facts (12 identity digests; 28 business counts / highest ids + 3 identity counts) with the recorded instant; no exception / company-53 text" "$(s2ar3_constants_ok && echo true || echo false)|$(printf '%s' "$S2AR3_TENANT_SNAPSHOT_B64" | base64 -d | grep -c '^')|$(printf '%s' "$S2AR3_TENANT_SNAPSHOT_B64" | base64 -d | grep -cE '^pre_id_[a-z0-9_]+=')|$(printf '%s' "$S2AR3_TENANT_SNAPSHOT_B64" | base64 -d | grep -cE '^pre_[a-z_]+_(count|max_id)=' )|$(printf '%s\n%s' "$S2AR3_MANIFEST" "$(printf '%s' "$S2AR3_TENANT_SNAPSHOT_B64" | base64 -d)" | grep -cE 'f048b5d4|\|53|=53$' || true)" "true|41|12|31|0"
mutated_lib3_ok() { sed -E "$1" "$HERE/b25-stage1-apply-lib.sh" > "$RULES_DIR/lib-mut3.sh"; bash -c 'source "'"$HERE"'/b25-stage1-purge-lib.sh"; source "'"$RULES_DIR"'/lib-mut3.sh"; s2ar3_constants_ok && echo true || echo false' 2>/dev/null; }
check "the manifest-3 self-check denies a Stage 1 uuid collision, a company-53 collision, an overlap with manifest 1 / 2, an unordered incident window and a tampered snapshot (mutated library copies)" "$(mutated_lib3_ok 's/^readonly S2AR3_UUID_LOGO=.*/readonly S2AR3_UUID_LOGO="f048b5d4-b366-4227-857f-42b2589e54b7"/')|$(mutated_lib3_ok 's/^readonly S2AR3_COMPANY=.*/readonly S2AR3_COMPANY=53/')|$(mutated_lib3_ok 's/^readonly S2AR3_UUID_DOC=.*/readonly S2AR3_UUID_DOC="593fd8be-72be-4798-b56a-e3af02574dfb"/')|$(mutated_lib3_ok 's/^readonly S2AR3_UUID_DOC=.*/readonly S2AR3_UUID_DOC="c69a3706-84f8-456b-ba40-e983118f2751"/')|$(mutated_lib3_ok 's/^readonly S2AR3_INCIDENT_END=.*/readonly S2AR3_INCIDENT_END="2026-10-16 19:00:00"/')|$(mutated_lib3_ok 's/^readonly S2AR3_TENANT_SNAPSHOT_B64=.*/readonly S2AR3_TENANT_SNAPSHOT_B64="c25hcHNob3RfYXQ9MjAyNi0xMC0xNiAxOTo1NDo0MC4xMjcyOTAK"/')" "false|false|false|false|false|false"
check "manifest 3 constants are readonly and cannot be overridden from the environment" "$(bash -c 'source "'"$HERE"'/b25-stage1-purge-lib.sh"; source "'"$HERE"'/b25-stage1-apply-lib.sh"; (S2AR3_COMPANY=53) 2>/dev/null; (S2AR3_UUID_DOC=x) 2>/dev/null; echo "$S2AR3_COMPANY|$S2AR3_UUID_DOC"')|$(env S2AR3_COMPANY=53 S2AR3_TENANT_SNAPSHOT_B64=x bash -c 'source "'"$HERE"'/b25-stage1-purge-lib.sh"; source "'"$HERE"'/b25-stage1-apply-lib.sh"; echo "$S2AR3_COMPANY|${#S2AR3_TENANT_SNAPSHOT_B64}"' 2>/dev/null)" "58|ac3c33c3-853e-4003-a03e-a8b357a282ac|58|1664"
check "the three settlement modes refuse each other's confirmations" "$(for m in 1c512c90f2c8 5d408c442c64 ec7ceda89a58; do awk "/^            stage2a_residue_settle_$m\\)\$/{on=1;next} on&&/;;\$/{print;exit} on{print}" "$WF" | grep -oE 'empty confirm_stage2a_residue[23]? "' | sed 's/^empty //; s/ "$//' | sort | tr '\n' ','; printf '|'; done)" "confirm_stage2a_residue2,confirm_stage2a_residue3,|confirm_stage2a_residue,confirm_stage2a_residue3,|confirm_stage2a_residue,confirm_stage2a_residue2,|"
check "the Correction 4 eligibility phase reports an already-purged residue explicitly (auto-purge race) without recreating anything" "$(body phase_stage2a_residue3_eligibility | grep -c 'B25_STAGE2A_RESIDUE3_ROWS_ALREADY_ABSENT=TRUE')|$(body phase_stage2a_residue3_eligibility | grep -c 'rows_present=$left')" "1|1"
check "the residue-3 reader filters the brand references against ITS manifest's companies (the Correction 2 reader filtered against manifest 1)" "$(body stage2a_residue3_row_facts | grep -c 'BR="${S2AR3_COMPANIES//,/|}"')" "1"
RB3="$(body stage2a_residue3_eligibility_run)"
check "residue-3 eligibility run: temporary stderr metadata is read FIRST (before the read-only guard and any in-container reader), the retrospective tenant proof runs as section 7 bound to the recorded snapshot and incident window, eligibility TRUE requires both verdicts, a pre-existing stderr file is reported and never removed" "$(printf '%s\n' "$RB3" | grep -n 'S2AR3_TMP_PRE="$(stage2a_tmp_stderr_facts)"\|stage2a_readonly_guard\|api_node\|stage2a_residue_fs_facts' | awk -F: 'NR==1{first=$1} {if ($1<first) first=$1} /stage2a_tmp_stderr_facts/{t=$1} END{print (t==first) ? "first" : "late"}')|$(printf '%s\n' "$RB3" | grep -c 'stage2a_tenant_incident_proof "$S2AR3_TENANT_SNAPSHOT_B64" "$S2AR3_INCIDENT_END" "$S2AR3_COMPANIES" "$S2AR3_USERS"')|$(printf '%s\n' "$RB3" | grep -c 'B25_STAGE2A_RESIDUE3_TENANT_PROOF=$S2AR3_TENANT_PROOF')|$(printf '%s\n' "$RB3" | grep -c "grep -qx 'B25_STAGE2A_RESIDUE3_ELIGIBLE=TRUE' && \[ \"\$S2AR3_TENANT_PROOF\" = \"PASS\" \]")|$(printf '%s\n' "$RB3" | grep -c "grep -qx 'tmp_stderr_present=true' || rm -f")|$(printf '%s\n' "$RB3" | grep -cE '^\s*rm -f' || true)|$(body phase_stage2a_residue3_settle | grep -c "grep -qx 'tmp_stderr_present=true' || rm -f")" "first|1|1|1|1|0|1"
eval "$(body stage2a_tmp_stderr_facts)"
TSF="$(HOME="$RULES_DIR" stage2a_tmp_stderr_facts)"; printf 'x' > "$RULES_DIR/.b25-s1-node.err"; TSF2="$(HOME="$RULES_DIR" stage2a_tmp_stderr_facts)"; rm -f "$RULES_DIR/.b25-s1-node.err"
check "temporary stderr metadata: absent → false / 0 / -; present → true, the byte size and an UTC mtime; never the contents" "$(printf '%s' "$TSF" | tr '\n' ' ')|$(printf '%s\n' "$TSF2" | grep -c '^tmp_stderr_present=true$')|$(printf '%s\n' "$TSF2" | grep -c '^tmp_stderr_size=1$')|$(printf '%s\n' "$TSF2" | grep -cE '^tmp_stderr_mtime=[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$')|$(printf '%s\n' "$TSF2" | grep -c '=x$' || true)|$(body stage2a_tmp_stderr_facts | grep -ciE '(^|[^a-z])(cat|head|tail|less|grep) ' || true)" "tmp_stderr_present=false tmp_stderr_size=0 tmp_stderr_mtime=-|1|1|1|0|0"
# ---- the mid-smoke guard form: the evaluator (golden PASS; every listed denial) ----
MS_GOLDEN="$(cat <<'G'
ms_ids_ok=true
ms_ids_count=2
inv_total=3
ms_rows_named=2
ms_rows_outside=0
ms_rows_active=2
ms_rows_fs=2
ms_rows_legacy_null=2
ms_rows_mirror_canonical=2
ms_rows_mirror_ok=2
ms_rows_error_null=2
ms_rows_not_uncertain=2
ms_rows_no_lease=2
ms_rows_sized=2
ms_rows_digest_ok=2
ms_rows_identity_ok=2
ms_rows_fixture_match=2
ms_rows_document=1
ms_rows_logo=1
ms_rows_smoke_tenant=2
ms_rows_companies=1
ms_rows_company1=0
ms_rows_company53=0
inv_company1=0
inv_company53_outside_exception=0
ms_rows_bytes=21727
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
exc_live_refs=0
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
inv_active=2
ms_fs_rows=2
ms_fs_present=2
ms_fs_regular=2
ms_fs_owner_ok=2
ms_fs_mode_ok=2
ms_fs_magic_ok=2
ms_fs_marker_free=2
ms_fs_pdf_free=2
ms_fs_size_differs=2
ms_fs_tenant_files=2
ms_fs_other_files=0
ms_fs_symlinks=0
ms_fs_keys_match=true
ms_mirror_rows=2
ms_mirror_present=2
ms_mirror_bucket_ok=2
ms_mirror_canonical_key=2
ms_mirror_marker_ok=2
ms_mirror_generation_ok=2
ms_mirror_size_ok=2
ms_mirror_sha_ok=2
ms_mirror_generation_digits_min=16
census_objects=7
census_bytes=23125
census_marked=3
census_generationless=0
unmarked_objects=4
unmarked_md5=c1b900fd509bafa1f980d863dc0d195b
originals_present=4
originals_missing=0
originals_size_match=4
dead_jobs=0
references=4
references_expected=4
G
)"
ms_verdict() { printf '%s\n' "$1" | stage2a_midsmoke_eval; }
MSV="$(ms_verdict "$MS_GOLDEN")"
check "mid-smoke evaluator: golden facts (exception + the two verified smoke rows, their files, their mirrors, census 7 / 23125 / marked 3) → PASS, 13 conditions all OK; it lives in the library" "$(printf '%s\n' "$MSV" | grep -E '^B25_STAGE2A_MIDSMOKE_' | tr '\n' ' ')|$(printf '%s\n' "$MSV" | grep -cE '^mid [0-9]+: ')|$(printf '%s\n' "$MSV" | grep -cE '^mid [0-9]+: .* — OK \(')|$(grep -c '^stage2a_midsmoke_eval() {$' "$LIB")" "B25_STAGE2A_MIDSMOKE_CONDITIONS_FAILED=0 B25_STAGE2A_MIDSMOKE_GATE=PASS |13|13|1"
check "mid-smoke evaluator: an empty fact stream fails every condition" "$(printf '' | stage2a_midsmoke_eval | grep -E '^B25_STAGE2A_MIDSMOKE_' | tr '\n' ' ')" "B25_STAGE2A_MIDSMOKE_CONDITIONS_FAILED=13 B25_STAGE2A_MIDSMOKE_GATE=FAIL "
ms_covered=""
while IFS='|' read -r label mut want; do
  [ -n "$label" ] || continue
  V="$(s2ar_mut "$MS_GOLDEN" "$mut" | stage2a_midsmoke_eval)"; got="$(printf '%s\n' "$V" | sed -nE 's/^mid ([0-9]+): .* — FAIL \(.*$/\1/p' | sort -n | tr '\n' ',' | sed 's/,$//')"
  verdict="$(printf '%s\n' "$V" | grep -oE '^B25_STAGE2A_MIDSMOKE_GATE=[A-Z]+')"
  if [ "$verdict" = "B25_STAGE2A_MIDSMOKE_GATE=FAIL" ] && [[ ",$got," == *",$want,"* ]]; then ok "mid-smoke denied: $label (condition $want FAIL; failed=[$got])"; else bad "mid-smoke NOT denied as expected: $label (failed=[$got] want=$want $verdict)"; fi
  ms_covered="$ms_covered,$want"
done <<'MUT'
exception-only inventory (the pre-smoke state) is NOT the mid-smoke state|inv_total=1;ms_rows_named=0;inv_active=0;ms_rows_active=0|2
a third storage row|inv_total=4;ms_rows_outside=1|2
a recorded row missing|inv_total=2;ms_rows_named=1|2
a wrong uuid in the list (one recorded row not found)|ms_rows_named=1|2
a malformed / non-canonical uuid list|ms_ids_ok=false|1
a duplicate uuid (the list is not two distinct rows)|ms_ids_ok=false;ms_ids_count=2|1
the Stage 1 exception uuid presented as a smoke row|ms_ids_ok=false|1
three uuids|ms_ids_ok=false;ms_ids_count=3|1
a company-53 smoke row|ms_rows_company53=1;ms_rows_smoke_tenant=1;inv_company53_outside_exception=1|7
a foreign (non-smoke) company row|ms_rows_smoke_tenant=1;ms_rows_companies=2|7
a company-1 row|ms_rows_company1=1;inv_company1=1|7
a row not active|ms_rows_active=1;inv_active=1|3
a row on the wrong driver|ms_rows_fs=1|3
a legacy key set|ms_rows_legacy_null=1|3
mirror location missing / not canonical|ms_rows_mirror_canonical=1|4
mirror state not ok|ms_rows_mirror_ok=1|4
publication uncertainty|ms_rows_not_uncertain=1;inv_uncertain=1|5
a lease|ms_rows_no_lease=1;inv_leases=1|5
last_error present|ms_rows_error_null=1|5
size or digest not populated / identity mismatch|ms_rows_sized=1;ms_rows_digest_ok=1|6
the rows do not match this run's fixture facts|ms_rows_fixture_match=1|6
two documents instead of document + logo|ms_rows_document=2;ms_rows_logo=0|6
Stage 1 exception moved (state)|exc_state=active|8
Stage 1 exception provider object missing|exc_provider_present=false|8
cleanup-pending / unproven rows|inv_cleanup_pending=1|9
an encrypted file missing before the recreate|ms_fs_present=1;ms_fs_regular=1;ms_fs_magic_ok=1|10
an extra tenant file on the volume|ms_fs_tenant_files=3;ms_fs_keys_match=false|10
a plaintext marker found in a file|ms_fs_marker_free=1|10
a mirror object missing before the recreate|ms_mirror_present=1;ms_mirror_sha_ok=1|11
a mirror digest mismatch|ms_mirror_sha_ok=1|11
provider census: unexpected object count|census_objects=8|12
provider census: unexpected bytes|census_bytes=23126|12
provider census: unexpected marked count|census_marked=4|12
provider census: an original changed|unmarked_md5=00000000000000000000000000000000|12
a dead-letter job|dead_jobs=1|13
legacy references changed|references=5|13
MUT
check "mid-smoke evaluator: every one of the 13 conditions is covered by at least one denying mutation" "$(printf '%s' "$ms_covered" | tr ',' '\n' | grep -E '^[0-9]+$' | sort -n -u | tr '\n' ',')" "1,2,3,4,5,6,7,8,9,10,11,12,13,"
check "mid-smoke evaluator: the expected census bytes are derived from the verified plaintext sizes (bytes = 1398 + the rows' bytes), never a loose constant" "$(ms_verdict "$(s2ar_mut "$MS_GOLDEN" "ms_rows_bytes=21728")" | grep -oE '^B25_STAGE2A_MIDSMOKE_GATE=[A-Z]+')|$(ms_verdict "$(s2ar_mut "$MS_GOLDEN" "ms_rows_bytes=21728;census_bytes=23126")" | grep -oE '^B25_STAGE2A_MIDSMOKE_GATE=[A-Z]+')" "B25_STAGE2A_MIDSMOKE_GATE=FAIL|B25_STAGE2A_MIDSMOKE_GATE=PASS"
# ---- the smoke-row list validator (shell level) ----
eval "$(body stage2a_smoke_rows_validate)"
U1="ac3c33c3-853e-4003-a03e-a8b357a282ac"; U2="c097cd52-270e-418c-8e75-0a0dfd1f2312"
check "smoke-row list validator: exactly two canonical distinct uuids pass; one uuid, three uuids, a duplicate, the exception uuid, a malformed / upper-case / spaced / empty list fail" "$(stage2a_smoke_rows_validate "$U1,$U2" && echo ok || echo no)|$(stage2a_smoke_rows_validate "$U1" && echo ok || echo no)|$(stage2a_smoke_rows_validate "$U1,$U2,$U1" && echo ok || echo no)|$(stage2a_smoke_rows_validate "$U1,$U1" && echo ok || echo no)|$(stage2a_smoke_rows_validate "$U1,$B25PHYS_UUID" && echo ok || echo no)|$(stage2a_smoke_rows_validate "$U1,xyz" && echo ok || echo no)|$(stage2a_smoke_rows_validate "${U1^^},$U2" && echo ok || echo no)|$(stage2a_smoke_rows_validate "$U1, $U2" && echo ok || echo no)|$(stage2a_smoke_rows_validate "" && echo ok || echo no)" "ok|no|no|no|no|no|no|no|no"
# ---- the mid-smoke guard + the recreate phase: static wiring ----
GB="$(body guards_stage2a_switched_with_smoke_rows)"; RB="$(body phase_stage2a_recreate_api)"; MF="$(body stage2a_midsmoke_facts)"
check "the normal switched guard is UNCHANGED since the reviewed f67c371 and still strict (exception-only inventory; still the gate of the smoke setup)" "$(body guards_stage2a_switched | md5sum | cut -c1-32)|$(body guards_stage2a_switched | grep -c 'fail "storage_objects is not exactly the one exception row"')|$(body phase_stage2a_smoke_setup | grep -c '^  guards_stage2a_switched$')" "$(git -C "$HERE/../.." show f67c371cdd085194e061179238d705241cfb2723:.github/scripts/b25-stage1-apply.sh | awk '$0 ~ "^guards_stage2a_switched\\(\\) \\{" {on=1} on {print} on && /^}$/ {exit}' | md5sum | cut -c1-32)|1|1"
check "the recreate phase applies ONLY the mid-smoke guard form (never the pre-smoke form), refuses any ARG and reads the uuids + the run's fixture facts from the stdin stream only" "$(printf '%s\n' "$RB" | grep -c 'guards_stage2a_switched_with_smoke_rows "$csv"')|$(printf '%s\n' "$RB" | grep -cE '^  guards_stage2a_switched$' || true)|$(printf '%s\n' "$RB" | grep -c '\[ -z "$ARG1$ARG2$ARG3" \] || fail')|$(printf '%s\n' "$RB" | grep -c 'B25_SMOKE_ROW_IDS:-')|$(printf '%s\n' "$RB" | grep -oE 'B25_(FIXTURE_SHA256|FIXTURE_SIZE|FIXTURE_MARKER|LOGO_SHA256|LOGO_SIZE):-' | sort -u | wc -l | tr -d ' ')" "1|0|1|1|5"
check "the mid-smoke guard keeps every host check of the normal guard (product commit, clean checkout, api, health, init record, fingerprint, mount, owner / mode) and decides through the library evaluator" "$(for s in 'STAGE2A_PRODUCT_SHA' 'checkout dirty' 'api not running' 'health || fail' 'STAGE2A_INIT_FS' 'fingerprint)" = "$FP_AFTER"' 'volume:$STAGE2A_VOLUME' 'STAGE2A_ROOT_OWNER'; do printf '%s\n' "$GB" | grep -cF "$s" | tr -d '\n'; done)|$(printf '%s\n' "$GB" | grep -c '| stage2a_midsmoke_eval)')|$(printf '%s\n' "$GB" | grep -c "grep -qx 'B25_STAGE2A_MIDSMOKE_GATE=PASS' || fail")|$(printf '%s\n' "$GB" | grep -c 'stage2a_readonly_guard')" "11111111|1|1|1"
check "the mid-smoke guard, its fact reader and the recreate phase never write to the database and never touch web / postgres (the recreation = the one api-only helper)" "$(printf '%s\n%s\n%s\n' "$GB" "$MF" "$RB" | grep -vE '^\s*#' | grep -ciE '(^|[^a-z_])qw |"(delete|update|insert|truncate|drop|alter) ' || true)|$(printf '%s\n' "$RB" | grep -c 'stage2a_recreate_api || fail')|$(printf '%s\n' "$RB" | grep -vE '^\s*(#|section )' | grep -ciE 'compose (up|down|restart|rm) |force-recreate (web|postgres)|compose exec -T (web|postgres)' || true)|$(printf '%s\n%s' "$GB" "$MF" | grep -ciE 'compose up|force-recreate|rm -r|unlink|\.delete\(' || true)" "0|1|0|0"
check "the recreate phase proves, after the recreation: readiness ok, the same product commit, the same volume identity, the same ciphertext set (sha256 of every tenant file), the same two rows (digest over state / driver / digest / size / mirror / lease / key / updated_at) and the two mirrors re-read" "$(printf '%s\n' "$RB" | grep -c '"status":"ok"')|$(printf '%s\n' "$RB" | grep -c 'product commit changed across the recreation')|$(printf '%s\n' "$RB" | grep -c 'objectdata volume identity changed')|$(printf '%s\n' "$RB" | grep -c 'sha256sum {} +')|$(printf '%s\n' "$RB" | grep -c 'the two smoke rows changed across the recreation')|$(printf '%s\n' "$RB" | grep -c 'stage2a_fields_ok "$mj" 2 rows present bucket_ok canonical_key marker_ok generation_ok size_ok sha_ok')" "1|1|1|2|1|1"
check "the mid-smoke fact reader re-proves the files with the run's plaintext marker, the mirrors with digest + size, the exception facts, the census and the references, and reads the two rows in one statement" "$(printf '%s\n' "$MF" | grep -c 'STAGE2A_FS_VERIFY_JS')|$(printf '%s\n' "$MF" | grep -c 'STAGE2A_MIRROR_JS')|$(printf '%s\n' "$MF" | grep -c 'stage2a_exception_facts')|$(printf '%s\n' "$MF" | grep -c "'marker', '\$B25_FIXTURE_MARKER'")|$(printf '%s\n' "$MF" | grep -c 'from storage_objects where id in ($Q)"$')|$(printf '%s\n' "$MF" | grep -c 'references=$(references)')" "1|1|1|1|1|1"
check "workflow: the recreate step validates exactly two recorded uuids and streams them with the fixture facts as the stdin preamble; no ARG and no workflow input carries a uuid" "$(grep -c "B25_SMOKE_ROW_IDS=%s" "$WF")|$(grep -E "PHASE='stage2a-recreate-api' " "$WF" | grep -cE 'ARG[123]=' || true)|$(grep -cF '[[ "${SMOKE_ROW_IDS:-}" =~ ^[0-9a-f-]{36},[0-9a-f-]{36}$ ]] ||' "$WF")|$(grep -E '^        default:' "$WF" | grep -cE 'ac3c33c3|c097cd52|SMOKE_ROW' || true)" "1|0|1|0"
check "workflow: the branch guard requires the Correction 4 functions and refuses a recreate phase that still applies the pre-smoke guard form" "$(grep -c "grep -q '^guards_stage2a_switched_with_smoke_rows()'" "$WF")|$(grep -c "grep -q '^stage2a_midsmoke_eval()'" "$WF")|$(grep -c "grep -q '^stage2a_tenant_incident_proof()'" "$WF")|$(grep -c 'the recreate phase still applies the pre-smoke form of the switched guard' "$WF")|$(grep -c "grep -q '^readonly S2AR3_TENANT_SNAPSHOT_B64='" "$WF")" "1|1|1|1|1"
# ---- the retrospective incident proof: the evaluator in its incident form ----
INC_GOLDEN="$(cat <<'G'
snapshot_at=2026-10-16 19:54:40.127290
review_utc_ok=true
pre_id_company_md5=11111111111111111111111111111111
post_id_company_md5=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
pre_id_company_status_md5=22222222222222222222222222222222
post_id_company_status_md5=22222222222222222222222222222222
pre_id_sub_core_md5=33333333333333333333333333333333
post_id_sub_core_md5=33333333333333333333333333333333
pre_id_sub_status_md5=44444444444444444444444444444444
post_id_sub_status_md5=44444444444444444444444444444444
pre_id_users_count=1
post_id_users_count=2
pre_id_users_active=1
post_id_users_active=2
pre_id_users_md5=55555555555555555555555555555555
post_id_users_md5=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
pre_id_roles_count=0
post_id_roles_count=0
pre_id_roles_md5=66666666666666666666666666666666
post_id_roles_md5=66666666666666666666666666666666
pre_id_user_roles_count=0
post_id_user_roles_count=0
pre_id_user_roles_md5=77777777777777777777777777777777
post_id_user_roles_md5=77777777777777777777777777777777
pre_id_brand_logo_set=false
post_id_brand_logo_set=false
users_created_since=0
users_soft_deleted_since=0
users_modified_since=1
users_modified_login_explained=1
sec_audit_rows_since=0
roles_changed_since=0
user_roles_created_since=0
company_modified_since=false
sub_modified_since=false
sub_status_changed_since=false
tenant_audit_rows_window=0
tenant_audit_rows_since=0
disposable_audit_on_tenant=0
tenant_rows_ref_disposables=0
disposable_rows_ref_tenant=0
tenant_storage_rows_post=0
tenant_storage_created_window=0
tenant_storage_deleted_window=0
sweep_audit_rows_window=0
sub_status_post=active
sub_trial_elapsed=true
references_post=4
references_expected=4
G
)"
for t in $S2A_BUSINESS_TABLES; do INC_GOLDEN+=$'\n'"pre_${t}_count=5"$'\n'"pre_${t}_max_id=5"$'\n'"post_${t}_count=6"$'\n'"post_${t}_max_id=6"$'\n'"${t}_created_window=0"$'\n'"${t}_modified_window=0"$'\n'"${t}_soft_deleted_window=0"$'\n'"${t}_created_by_disposable=0"$'\n'"${t}_created_by_tenant=0"$'\n'"${t}_automated_explained=0"; done
pi() { printf '%s\n' "$1" | stage2a_tenant_post_eval incident || true; }
IV="$(pi "$INC_GOLDEN")"
check "incident proof: golden (quiet window; the tenant worked normally afterwards — counts grew, a user was added later, identity digests differ from the snapshot NOW) → PASS in the incident form; the strict form of the same facts FAILS (frozen comparison)" "$(printf '%s\n' "$IV" | grep -oE '^B25_STAGE2A_TENANT_POST_GATE=[A-Z]+')|$(printf '%s\n' "$IV" | grep -c 'incident form')|$(pv "$INC_GOLDEN" | grep -oE '^B25_STAGE2A_TENANT_POST_GATE=[A-Z]+')" "B25_STAGE2A_TENANT_POST_GATE=PASS|1|B25_STAGE2A_TENANT_POST_GATE=FAIL"
check "incident proof: an unknown mode is refused; the strict form is the default (the smoke's own post gate is unchanged: the strict golden still passes)" "$(printf '%s\n' "$INC_GOLDEN" | stage2a_tenant_post_eval bogus | tail -1)|$(pv "$POST_GOLDEN" | grep -oE '^B25_STAGE2A_TENANT_POST_GATE=[A-Z]+')" "B25_STAGE2A_TENANT_POST_GATE=FAIL|B25_STAGE2A_TENANT_POST_GATE=PASS"
while IFS='|' read -r label mut want; do
  [ -n "$label" ] || continue
  V="$(pi "$(s2ar_mut "$INC_GOLDEN" "$mut")")"; got="$(printf '%s\n' "$V" | grep -oE '^B25_STAGE2A_TENANT_POST_GATE=[A-Z]+' | cut -d= -f2)"
  if [ "$got" = "$want" ]; then ok "incident proof: $label → $want"; else bad "incident proof: $label (got $got want $want)"; fi
done <<'MUT'
a disposable actor created a tenant row in the window|contacts_created_window=1;contacts_created_by_disposable=1|FAIL
a tenant row references a disposable event / user|tenant_rows_ref_disposables=1|FAIL
a disposable row references a tenant user|disposable_rows_ref_tenant=1|FAIL
an audit action of a disposable identity on the tenant|disposable_audit_on_tenant=1|FAIL
a tenant storage object created in the window|tenant_storage_created_window=1|FAIL
a tenant storage object deleted in the window|tenant_storage_deleted_window=1|FAIL
a security / permission audit action in the window|sec_audit_rows_since=1|FAIL
a user created in the window|users_created_since=1|FAIL
a user soft-deleted in the window|users_soft_deleted_since=1|FAIL
a user row modified in the window without a login explanation|users_modified_since=2;users_modified_login_explained=1|FAIL
a role / user_role movement in the window|user_roles_created_since=1|FAIL
a subscription status change in the window without sweep evidence|sub_status_changed_since=true|FAIL
a subscription status change in the window WITH sweep evidence (system-actor audit row, elapsed trial, expired)|sub_status_changed_since=true;sweep_audit_rows_window=1;sub_status_post=expired;sub_trial_elapsed=true|PASS
a company row modified in the window without sweep evidence|company_modified_since=true|FAIL
unexplained movement in the window (a table without actor column, no tenant audit row, no automation)|tasks_modified_window=1|FAIL
benign tenant activity in the window attributed to a tenant actor|contacts_created_window=1;contacts_created_by_tenant=1|PASS
benign tenant activity in the window attributed by the tenant's own audit rows|tasks_modified_window=1;tenant_audit_rows_window=1|PASS
an automated transition in the window (a workflow run finished)|workflow_runs_modified_window=1;workflow_runs_automated_explained=1|PASS
rows created in the window by nobody attributable|contacts_created_window=2;contacts_created_by_tenant=1;tenant_audit_rows_window=1|FAIL
a hard deletion since the snapshot that nothing attributes|post_tasks_count=4|FAIL
a hard deletion since the snapshot attributed to the tenant's own audited activity|post_tasks_count=4;tenant_audit_rows_since=1|PASS
legacy original references changed|references_post=5|FAIL
the window is not ordered / not in the past|review_utc_ok=false|FAIL
a snapshot lacking an identity digest|-pre_id_users_md5|FAIL
MUT
if [ "$(q "select count(*) from companies where id = 1")" = "1" ]; then
  s2a_tenant_users_in="(select id from users where company_id = 1)"; REFERENCES=4; references() { echo 4; }
  eval "$(body stage2a_tenant_identity_facts)"; eval "$(body stage2a_tenant_business_facts)"; eval "$(body stage2a_tenant_window_facts)"; eval "$(body stage2a_tenant_incident_facts)"; eval "$(body stage2a_tenant_incident_proof)"
  fail() { echo "FAIL:$*"; return 1; }; section() { :; }
  IW="$(date -u -d '2 hours ago' '+%Y-%m-%d %H:%M:%S')"; IE="$(date -u -d '1 hour ago' '+%Y-%m-%d %H:%M:%S')"
  IF="$(stage2a_tenant_incident_facts "$IW" "$IE" "900001,900002" "999999")"
  check "modeled: the incident reader runs against the local fixture tenant and prints only sanitized facts with the expected keys (identity window, 14 × 3 movement keys + the tenant storage window, attribution, isolation, references)" "$(s2a_facts_ok "$IF" && echo ok)|$(printf '%s\n' "$IF" | grep -cE '^(review_utc_ok|users_created_since|sec_audit_rows_since|tenant_audit_rows_window|tenant_audit_rows_since|disposable_audit_on_tenant|tenant_rows_ref_disposables|disposable_rows_ref_tenant|tenant_storage_rows_post|references_post|references_expected)=')|$(printf '%s\n' "$IF" | grep -cE '^[a-z_]+_(created|modified|soft_deleted)_window=')" "ok|11|43"
  LSNAP="$( { echo "snapshot_at=$IW"; stage2a_tenant_identity_facts | sed 's/^/pre_/'; stage2a_tenant_business_facts pre; } | base64 -w0)"
  IP="$(stage2a_tenant_incident_proof "$LSNAP" "$IE" "900001,900002" "999999" 2>&1 || true)"
  check "modeled: the incident proof over a quiet past window of the local fixture tenant evaluates end to end; the only FAIL it may report here is the fixture's own storage rows (the regression tenant holds fixture storage rows; the hosted tenant holds none)" "$(printf '%s\n' "$IP" | grep -cE '^B25_STAGE2A_TENANT_POST_GATE=')|$(printf '%s\n' "$IP" | grep -E '^post: FAIL' | grep -vc 'isolation: tenant storage objects moved' || true)|$(printf '%s\n' "$IP" | grep -c 'incident form')" "1|0|1"
  check "modeled: a malformed snapshot, an unordered window end or malformed disposable ids stop the proof before any read" "$(stage2a_tenant_incident_proof "not-base64!" "$IE" "1" "1" 2>&1 | grep -c '^FAIL:incident snapshot malformed')|$(stage2a_tenant_incident_proof "$LSNAP" "yesterday" "1" "1" 2>&1 | grep -c '^FAIL:incident end malformed')|$(stage2a_tenant_incident_proof "$LSNAP" "$IE" "a,b" "1" 2>&1 | grep -c '^FAIL:disposable ids malformed')" "1|1|1"
  unset -f fail section references
else
  echo "note: the local database has no company-1 fixture tenant — the modeled incident reader / proof cases are exercised by the evaluator mutations only"
fi

check "the branch guard also requires the served-logo rule function of the smoke" "$(grep -c "grep -q '^function servedLogoRule(' .github/scripts/b25-stage1-smoke.mjs" "$WF")" "1"
check "no product, mobile or schema file differs from the product commit (the branch is still product + the six ops files)" "$(git -C "$HERE/../.." diff --name-only e559b0024b28d4a77becdcb10c4168004dddea75 -- . ':(exclude).github' 2>/dev/null | wc -l | tr -d ' ')|$(git -C "$HERE/../.." diff --name-only e559b0024b28d4a77becdcb10c4168004dddea75 -- .github 2>/dev/null | wc -l | tr -d ' ')" "0|6"

echo; echo "cleanup tests: $pass passed, $failn failed"
[ "$failn" = "0" ]
