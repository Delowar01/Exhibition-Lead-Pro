#!/bin/bash
# =============================================================================
# B25 STAGE 2B — local tests of the migration tooling (ONE-OFF ops test; never run by the deploy pipeline).
# Runs against the LOCAL regress database named by DATABASE_URL (never the hosted one): synthetic storage_objects rows of
# companies that do not exist (910001 / 910002) plus one synthetic real tenant (910003, inserted and removed) model every
# migration state; the evaluator, the summary parser and the workflow / guard wiring are proven statically or with
# synthetic facts. Nothing hosted is touched; the migrate-storage command is never executed here.
# =============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
source "$HERE/b25-stage1-purge-lib.sh"
source "$HERE/b25-stage1-apply-lib.sh"
source "$HERE/b25-stage2b-lib.sh"
: "${DATABASE_URL:?DATABASE_URL (local development database) is required}"
case "$DATABASE_URL" in *localhost*|*127.0.0.1*) ;; *) echo "refusing: DATABASE_URL is not a local database" >&2; exit 1;; esac
q()  { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA -F '|' -c "set default_transaction_read_only = on" -c "$1"; }
qw() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA -F '|' -c "$1"; }
pass=0; failn=0
ok()   { pass=$((pass + 1)); echo "PASS  $1"; }
bad()  { failn=$((failn + 1)); echo "FAIL  $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 (got '$2', want '$3')"; fi; }
APPLY="$HERE/b25-stage1-apply.sh"; LIB="$HERE/b25-stage1-apply-lib.sh"; S2BLIB="$HERE/b25-stage2b-lib.sh"; S2BAPPLY="$HERE/b25-stage2b-apply.sh"; WF="$ROOT/.github/workflows/b25-stage1-inspection.yml"
body()  { awk -v f="$1" '$0 ~ "^"f"\\(\\) \\{" {on=1} on {print} on && /^}$/ {exit}' "$S2BAPPLY"; }
abody() { awk -v f="$1" '$0 ~ "^"f"\\(\\) \\{" {on=1} on {print} on && /^}$/ {exit}' "$APPLY"; }
lbody() { awk -v f="$1" '$0 ~ "^"f"\\(\\) \\{" {on=1} on {print} on && /^}$/ {exit}' "$S2BLIB"; }
eval "$(abody census_field)"; eval "$(abody json_flat_field)"
CA=910001; CB=910002; CT=910003
[ "$(q "select count(*) from companies where id in ($CA,$CB,$CT)")" = "0" ] || { echo "synthetic company ids exist — aborting" >&2; exit 1; }
declare -a IDS=(); ER_ID=""
mk() { local -n _v="$1"; _v="$(q "select gen_random_uuid()::text")"; IDS+=("$_v"); }
cleanup() {
  local list; list="$(printf "'%s'," "${IDS[@]}")"; list="${list%,}"
  [ -n "$ER_ID" ] && qw "delete from export_runs where id = $ER_ID and company_id = $CT" >/dev/null 2>&1 || true
  [ -n "$list" ] && qw "delete from storage_objects where id in ($list)" >/dev/null 2>&1 || true
  qw "delete from companies where id = $CT" >/dev/null 2>&1 || true
  [ "${EXC_INSERTED:-0}" = 1 ] && qw "delete from storage_objects where id = '$B25PHYS_UUID' and legacy_key like 'gs://synthetic-bucket/%'" >/dev/null 2>&1 || true
}
trap cleanup EXIT
SHA="$(printf '%064d' 9)"
# the regress database may lack the Stage 1 exception row: model it (deleted / LEGACY_RETAINED / gcs / company 53 / 99 bytes, a
# synthetic-bucket legacy key) for the duration of the run; it is part of the captured baseline and removed by the cleanup
EXC_INSERTED=0
if [ "$(q "select count(*) from storage_objects where id = '$B25PHYS_UUID'")" = "0" ]; then
  qw "insert into storage_objects (id, company_id, kind, reference, storage_key, driver, legacy_key, mirror_key, mirror_state, content_type, size_bytes, sha256, state, last_error, deleted_at, created_at, updated_at) values ('$B25PHYS_UUID', $B25PHYS_COMPANY, 'document', '/objects/uploads/$B25PHYS_UUID', 'tenants/$B25PHYS_COMPANY/documents/$B25PHYS_UUID', 'gcs', 'gs://synthetic-bucket/.private/uploads/$B25PHYS_UUID', null, null, 'text/plain', 99, '$SHA', 'deleted', 'LEGACY_RETAINED', now(), now(), now())" >/dev/null
  EXC_INSERTED=1
fi
BASE_PART="$(q "$(s2b_partition_sql)" | tr '\n' ' ')"; BASE_CENSUS="$(q "$(s2b_census_sql)" | tr '\n' ' ')"
qw "insert into companies (id, name, plan, status) values ($CT, 'S2B synthetic real tenant', 'free', 'active')" >/dev/null
ins() {   # <id> <cid> <kind> <state> <driver> <legacy_key|NULL> <canonical|foreign|NULL mirror> <reference> <key> [extra set clause]
  local id="$1" cid="$2" kind="$3" state="$4" drv="$5" lk="$6" mir="$7" ref="$8" key="$9" extra="${10:-}" lksql mk ms
  lksql="null"; [ "$lk" != "NULL" ] && lksql="'$lk'"
  case "$mir" in canonical) mk="'gs://synthetic-bucket/$key'"; ms="'ok'" ;; foreign) mk="'gs://synthetic-bucket/other/$key'"; ms="'ok'" ;; *) mk="null"; ms="null" ;; esac
  qw "insert into storage_objects (id, company_id, kind, reference, storage_key, driver, legacy_key, mirror_key, mirror_state, content_type, size_bytes, sha256, state, created_at, updated_at) values ('$id', $cid, '$kind', '$ref', '$key', '$drv', $lksql, $mk, $ms, 'text/csv', 1299, '$SHA', '$state', now(), now())" >/dev/null
  [ -n "$extra" ] && qw "update storage_objects set $extra where id = '$id'" >/dev/null || true
}
state() { q "$(s2b_state_sql "$1")"; }
echo "== Stage 2B constants and the rollback boundary"
check "constants: product pin = the approved mobile head, Stage 2A ops pin 40-hex, baseline schema fingerprint (a gate), the 2026-10-23 record (native rows 2, census digest; informational), headroom 256 MiB, bounded concurrency / batch (constants_ok)" "$(s2b_constants_ok && echo ok)|$STAGE2B_PRODUCT_SHA|${#STAGE2B_STAGE2A_OPS_SHA}|$S2B_BASE_SCHEMA_FINGERPRINT|$S2B_RECORD_NATIVE_ROWS_20261023|$S2B_RECORD_CENSUS_MD5_20261023|$S2B_HEADROOM_BYTES|$S2B_COPY_CONCURRENCY|$S2B_COPY_BATCH" "ok|6a8dad1fe161dc1b31041794e5e3532e9f13327c|40|30c4ecbd867cd2cd59abcb58581ecb04|2|b7c8dd371c7d7e076f05ae8f69fc44e2|268435456|2|50"
check "the Stage 2B product pin differs from the Stage 2A pin (never the Stage 2A commit e559b002); constants are readonly; no constant is read from an input" "$([ "$STAGE2B_PRODUCT_SHA" != "$STAGE2A_PRODUCT_SHA" ] && echo differs)|$(bash -c 'source "'"$HERE"'/b25-stage1-purge-lib.sh"; source "'"$HERE"'/b25-stage1-apply-lib.sh"; source "'"$HERE"'/b25-stage2b-lib.sh"; (STAGE2B_PRODUCT_SHA=0) 2>/dev/null; echo "$STAGE2B_PRODUCT_SHA"')|$(grep -cE 'S2B_[A-Z_]+=.*(ARG|inputs|IN_)' "$S2BLIB" "$S2BAPPLY" | awk -F: '{s+=$2} END {print s+0}')" "differs|6a8dad1fe161dc1b31041794e5e3532e9f13327c|0"
check "rollback boundary: no forbidden operation string in any Stage 2B file (the regex line excepted); the regex itself names legacy delete, bucket deletes, fallback / mirror off, rollback and the env renderers" "$(s2b_forbidden_present "$S2BLIB" "$S2BAPPLY" && echo present || echo absent)|$(printf '%s' "$S2B_FORBIDDEN_RE" | awk -F'|' '{print NF}')" "absent|10"
check "a planted forbidden string is detected" "$(printf 'x\nOBJECT_STORAGE_LEGACY_DELETE=true\n' > /tmp/s2b-forbid-$$; s2b_forbidden_present /tmp/s2b-forbid-$$ && echo present || echo absent; rm -f /tmp/s2b-forbid-$$)" "present"
check "the Stage 2B files never redefine a Stage 2A predicate / reader and read no argument or input" "$(grep -cE '^(stage2a_live_row_sql|stage2a_assoc_sql|stage2a_protected_facts|stage2a_protected_eval|references_legacy|references_ambiguous)\(\)' "$S2BLIB" "$S2BAPPLY" | awk -F: '{s+=$2} END {print s+0}')|$(grep -cE 'ARG[123]|inputs\.' "$S2BLIB" "$S2BAPPLY" | awk -F: '{s+=$2} END {print s+0}')" "0|0"
echo "== Stage 2B — two-class model: every state decided by an explicit predicate; everything else fails closed"
mk NAT; ins "$NAT" $CT export active fs NULL canonical "/objects/$NAT" "tenants/$CT/exports/$NAT"
mk MIG; ins "$MIG" $CT export active fs "gs://synthetic-bucket/.private/uploads/$MIG" NULL "/objects/uploads/$MIG" "tenants/$CT/exports/$MIG"
mk SRC; ins "$SRC" $CT export active gcs "gs://synthetic-bucket/.private/uploads/$SRC" NULL "/objects/uploads/$SRC" "tenants/$CT/exports/$SRC"
check "FS_NATIVE_MIRRORED / FS_MIGRATED_WITH_RETAINED_LEGACY / LEGACY_GCS_SOURCE / STAGE1_EXCEPTION resolve" "$(state "$NAT")|$(state "$MIG")|$(state "$SRC")|$(state "$B25PHYS_UUID")" "FS_NATIVE_MIRRORED|FS_MIGRATED_WITH_RETAINED_LEGACY|LEGACY_GCS_SOURCE|STAGE1_EXCEPTION"
mk D1; ins "$D1" $CT export active fs "gs://synthetic-bucket/.private/uploads/$D1" canonical "/objects/uploads/$D1" "tenants/$CT/exports/$D1"
mk D2; ins "$D2" $CT export active gcs NULL NULL "/objects/uploads/$D2" "tenants/$CT/exports/$D2"
mk D3; ins "$D3" $CT export deleted fs "gs://synthetic-bucket/.private/uploads/$D3" NULL "/objects/uploads/$D3" "tenants/$CT/exports/$D3"
mk D4; ins "$D4" $CT export active fs "gs://synthetic-bucket/.private/uploads/$D4" NULL "/objects/uploads/$D4" "tenants/$CT/exports/$D4" "publication_uncertain_at = now()"
mk D5; ins "$D5" $CT export active fs "gs://synthetic-bucket/.private/uploads/$D5" NULL "/objects/uploads/$D5" "tenants/$CT/exports/$D5" "lease_token = 'x', lease_expires_at = now()"
mk D6; ins "$D6" $CT export active fs "gs://synthetic-bucket/.private/uploads/$D6" NULL "/objects/uploads/$D6" "tenants/$CT/exports/$D6" "last_error = 'E'"
mk D7; ins "$D7" $CT export active fs "gs://synthetic-bucket/.private/uploads/$D7" NULL "/objects/uploads/$D7" "tenants/$CT/exports/$D7" "sha256 = null"
mk D8; ins "$D8" $CA export active fs "gs://synthetic-bucket/.private/uploads/$D8" NULL "/objects/uploads/$D8" "tenants/$CA/exports/$D8"
mk D9; ins "$D9" $B25PHYS_COMPANY export active fs "gs://synthetic-bucket/.private/uploads/$D9" NULL "/objects/uploads/$D9" "tenants/$B25PHYS_COMPANY/exports/$D9"
mk D10; ins "$D10" $CT export active fs "gs://synthetic-bucket/.private/uploads/$D10" NULL "/objects/uploads/$D10" "legacy/$D10"
mk D11; ins "$D11" $CT export active fs "gs://synthetic-bucket/.private/uploads/$D11" NULL "/objects/$D11" "tenants/$CT/exports/$D11"
mk X1; mk X2; ins "$X1" $CT export active fs "gs://synthetic-bucket/.private/uploads/shared" NULL "/objects/uploads/$X1" "tenants/$CT/exports/$X1"; ins "$X2" $CA export active gcs "gs://synthetic-bucket/.private/uploads/shared" NULL "/objects/uploads/$X2" "tenants/$CA/exports/$X2"
check "denials → MIGRATION_FAILED_OR_UNPROVEN: mirror + legacy key, gcs without legacy key, tombstone, uncertainty, lease, last_error, no digest, non-existent company, the Stage 1 company, non-canonical key, rewritten (native) reference, a duplicate legacy source (both rows)" "$(state "$D1")|$(state "$D2")|$(state "$D3")|$(state "$D4")|$(state "$D5")|$(state "$D6")|$(state "$D7")|$(state "$D8")|$(state "$D9")|$(state "$D10")|$(state "$D11")|$(state "$X1")|$(state "$X2")" "$(for i in 1 2 3 4 5 6 7 8 9 10 11 12 13; do printf 'MIGRATION_FAILED_OR_UNPROVEN|'; done | sed 's/|$//')"
check "partition over the synthetic rows: native 1, migrated 1, legacy source 1, duplicates 2 (also counted among the failed rows), failed = every other synthetic row (13), exception and smoke rows unchanged (relative to the baseline partition, which includes the modeled exception)" "$(q "$(s2b_partition_sql)" | tr '\n' ' ' | sed 's/ $//')" "$(printf '%s' "$BASE_PART" | awk -v RS=' ' -F= 'NF==2 {v[$1]=$2} END {printf "s2b_total=%d s2b_exception=%d s2b_native=%d s2b_migrated=%d s2b_legacy_source=%d s2b_duplicates=%d s2b_smoke_rows=%d s2b_failed=%d", v["s2b_total"]+16, v["s2b_exception"], v["s2b_native"]+1, v["s2b_migrated"]+1, v["s2b_legacy_source"]+1, v["s2b_duplicates"]+2, v["s2b_smoke_rows"], v["s2b_failed"]+13}')"
check "the native predicate is byte-for-byte the Correction 5 shape plus nothing weaker (legacy_key must be null, mirror required, canonical ok mirror); the migrated predicate requires a retained gs:// legacy key, NO mirror and a non-native reference" "$(s2b_native_sql 'so.' | grep -c 'so.legacy_key is null and so.mirror_key is not null')|$(s2b_migrated_sql 'so.' | grep -c "so.legacy_key ~ '^gs://\[^/\]+/.+' and so.mirror_key is null and so.mirror_state is null")|$(s2b_migrated_sql 'so.' | grep -c 'so.reference !~')" "1|1|1"
check "alias validation refuses an injection" "$(s2b_native_sql 'so.; drop' 2>/dev/null || echo refused)|$(s2b_state_sql 'x' 2>/dev/null || echo refused)" "refused|refused"
echo "== Stage 2B — census, candidates, acceptance facts, transitions"
ER_ID="$(qw "insert into export_runs (company_id, status, object_path, file_size, created_at) values ($CT, 'completed', '/objects/uploads/$MIG', 1299, now()) returning id" 2>/dev/null || true)"
if [ -z "$ER_ID" ]; then ER_ID="$(qw "insert into export_runs (company_id, status, object_path, file_size, format, created_at) values ($CT, 'completed', '/objects/uploads/$MIG', 1299, 'csv', now()) returning id" 2>/dev/null || true)"; fi
check "acceptance facts of the migrated row (DB-visible part): shape, retained source shape, no mirror, digest, size, tenant, preserved reference, association (export run), not a duplicate, no uncertainty, not the exception" "$(q "$(s2b_migrated_acceptance_sql "$MIG")")" "shape_ok=true source_retained_shape=true no_mirror=true digest_ok=true size_ok=true tenant_ok=true reference_preserved=true association_ok=$([ -n "$ER_ID" ] && echo true || echo false) not_duplicate=true no_uncertainty=true not_exception=true"
check "a synthetic mirror on a migrated row is refused; a cleared legacy key is refused (the row leaves the class)" "$(qw "update storage_objects set mirror_key = 'gs://synthetic-bucket/tenants/$CT/exports/$MIG', mirror_state = 'ok' where id = '$MIG'" >/dev/null; state "$MIG"; qw "update storage_objects set mirror_key = null, mirror_state = null, legacy_key = null where id = '$MIG'" >/dev/null; state "$MIG"; qw "update storage_objects set legacy_key = 'gs://synthetic-bucket/.private/uploads/$MIG' where id = '$MIG'" >/dev/null; state "$MIG")" "MIGRATION_FAILED_OR_UNPROVEN
MIGRATION_FAILED_OR_UNPROVEN
FS_MIGRATED_WITH_RETAINED_LEGACY"
C_NOW="$(q "$(s2b_census_sql)" | tr '\n' ' ')"
cen() { printf '%s' "$2" | tr ' ' '\n' | grep -E "^$1=" | cut -d= -f2; }
check "census: the synthetic export reference resolves to the migrated row (migrated + 1 vs the baseline), nothing unclassified, the baseline's unregistered count unchanged, no duplicate, no exception / smoke reference" "$(( $(cen census_migrated "$C_NOW") - $(cen census_migrated "$BASE_CENSUS") ))|$(( $(cen census_total "$C_NOW") - $(cen census_total "$BASE_CENSUS") ))|$(cen census_unclassified "$C_NOW")|$(( $(cen census_unregistered "$C_NOW") - $(cen census_unregistered "$BASE_CENSUS") ))|$(cen census_dup_same_company "$C_NOW")|$(cen census_dup_cross_company "$C_NOW")|$(cen census_exception_refs "$C_NOW")|$(cen census_smoke_refs "$C_NOW")" "$([ -n "$ER_ID" ] && echo 1 || echo 0)|$([ -n "$ER_ID" ] && echo 1 || echo 0)|0|0|0|0|0|0"
check "census completeness identity holds on the live regress database (unregistered + legacy source + migrated + native-resolved = total)" "$(( $(cen census_unregistered "$C_NOW") + $(cen census_legacy_source "$C_NOW") + $(cen census_migrated "$C_NOW") + $(cen census_native_resolved "$C_NOW") == $(cen census_total "$C_NOW") ))" "1"
check "candidate bytes: every unregistered candidate of the regress database is an export with a recorded size (unknown rows 0); rows = the unregistered census" "$(q "$(s2b_candidate_bytes_sql)" | tr '\n' ' ' | sed 's/ $//')" "cand_rows=$(cen census_unregistered "$C_NOW") cand_bytes_known=$(q "with $(s2b_refs_cte) select coalesce(sum((select er.file_size from export_runs er where er.company_id = r.company_id and er.object_path = r.ref order by er.id limit 1)),0) from refs r where r.kind = 'export' and not exists (select 1 from storage_objects so where so.company_id = r.company_id and so.kind = r.kind and so.reference = r.ref and so.state <> 'deleted')") cand_bytes_unknown_rows=0"
check "transition table: dry-run plans without a row change; copy registers then copies (source retained, mirror untouched); checksum mismatch stays PENDING; missing source / conflict / failed → FAILED; already / verified idempotent; native and exception never candidates; duplicates blocked; an undefined transition is refused; no transition changes the bucket" "$(s2b_transition LEGACY_UNREGISTERED dry-run planned | cut -d'|' -f1,3)|$(s2b_transition LEGACY_UNREGISTERED copy registered | cut -d'|' -f1)|$(s2b_transition LEGACY_GCS_SOURCE copy copied | cut -d'|' -f1)|$(s2b_transition LEGACY_GCS_SOURCE copy checksum_mismatch | cut -d'|' -f1)|$(s2b_transition LEGACY_GCS_SOURCE copy missing_source | cut -d'|' -f1)|$(s2b_transition LEGACY_GCS_SOURCE copy conflict | cut -d'|' -f1)|$(s2b_transition FS_MIGRATED_WITH_RETAINED_LEGACY copy already | cut -d'|' -f1)|$(s2b_transition FS_MIGRATED_WITH_RETAINED_LEGACY verify verified | cut -d'|' -f1)|$(s2b_transition FS_NATIVE_MIRRORED copy copied | cut -d'|' -f1)|$(s2b_transition STAGE1_EXCEPTION copy copied | cut -d'|' -f1)|$(s2b_transition DUPLICATE_LEGACY copy copied | cut -d'|' -f1)|$(s2b_transition LEGACY_GCS_SOURCE copy teleport >/dev/null 2>&1 && echo accepted || echo refused)|$(for t in 'LEGACY_UNREGISTERED copy registered' 'LEGACY_GCS_SOURCE copy copied' 'LEGACY_GCS_SOURCE copy missing_source' 'FS_MIGRATED_WITH_RETAINED_LEGACY copy already'; do s2b_transition $t | cut -d'|' -f3; done | grep -vc '^none')" "LEGACY_UNREGISTERED|none|LEGACY_GCS_SOURCE|FS_MIGRATED_WITH_RETAINED_LEGACY|MIGRATION_PENDING|MIGRATION_FAILED_OR_UNPROVEN|MIGRATION_FAILED_OR_UNPROVEN|FS_MIGRATED_WITH_RETAINED_LEGACY|FS_MIGRATED_WITH_RETAINED_LEGACY|FS_NATIVE_MIRRORED|STAGE1_EXCEPTION|MIGRATION_FAILED_OR_UNPROVEN|refused|0"
check "exit-code meaning: 0 COMPLETE, 2 INCOMPLETE, 1 USAGE, anything else UNKNOWN" "$(s2b_exit_meaning 0)|$(s2b_exit_meaning 2)|$(s2b_exit_meaning 1)|$(s2b_exit_meaning 255)|$(s2b_exit_meaning '')" "COMPLETE|INCOMPLETE|USAGE|UNKNOWN|UNKNOWN"
echo "== Stage 2B — the summary parser (the product's sanitized JSON → counts only)"
SUMJS="$(mktemp --suffix=.js)"; awk '/^STAGE2B_SUMMARY_JS=\$\(cat <<.JS.$/{on=1;next} on&&/^JS$/{exit} on{print}' "$S2BAPPLY" > "$SUMJS"
api_node_stdin() { B25_ARG_B64="$2" node "$SUMJS"; }
STAGE2B_SUMMARY_JS="$(cat "$SUMJS")"
eval "$(body stage2b_summary_facts)"
counts() { printf '{"planned":%s,"copied":%s,"already":%s,"verified":%s,"not_migrated":%s,"unregistered":%s,"missing_source":%s,"checksum_mismatch":%s,"conflict":%s,"duplicate":%s,"failed":%s,"skipped":%s}' "$@"; }
summ() {   # <mode> <complete> <readOnly> <targetRoot> <counts json> [problems json] [groups json]
  printf '{"mode":"%s","targetDriver":"fs","startedAt":"2026-10-23T00:00:00.000Z","durationMs":%s,"sourceReferences":4,"uniqueObjects":4,"discovered":4,"registered":0,"registrationsPlanned":4,"unattributable":0,"processed":4,"counts":%s,"duplicateGroups":%s,"complete":%s,"problems":%s,"targetRoot":"%s","readOnly":%s}' "$1" "$RANDOM" "$5" "${7:-[]}" "$2" "${6:-[]}" "$4" "$3"
}
sf() { stage2b_summary_facts "$1" "$2" "$3" | tr '\n' ' '; }
g() { printf '%s' "$2" | tr ' ' '\n' | grep -E "^$1=" | cut -d= -f2; }
R="$(sf dr 0 "$(summ dry-run true true present "$(counts 4 0 0 0 0 0 0 0 0 0 0 0)")")"
check "dry-run golden: parse ok, mode dry-run, COMPLETE, complete, read-only, root present, planned 4, nothing else, no problem, exception not listed, 32-hex digest" "$(g dr_parse_ok "$R")|$(g dr_mode "$R")|$(g dr_exit_meaning "$R")|$(g dr_complete "$R")|$(g dr_read_only "$R")|$(g dr_target_root "$R")|$(g dr_planned "$R")|$(g dr_missing_source "$R")|$(g dr_problems "$R")|$(g dr_exception_listed "$R")|$(g dr_source_references "$R")|$(printf '%s' "$(g dr_digest "$R")" | grep -cE '^[0-9a-f]{32}$')" "true|dry-run|COMPLETE|true|true|present|4|0|0|0|4|1"
R2="$(sf dr 0 "$(summ dry-run true true present "$(counts 4 0 0 0 0 0 0 0 0 0 0 0)")")"
check "the digest ignores the timing fields: two dry-run summaries that differ only in durationMs digest identically; a changed count changes the digest" "$([ "$(g dr_digest "$R")" = "$(g dr_digest "$R2")" ] && echo same)|$([ "$(g dr_digest "$R")" != "$(g dr_digest "$(sf dr 0 "$(summ dry-run true true present "$(counts 3 0 0 0 0 0 0 0 0 0 0 0)")")")" ] && echo differs)" "same|differs"
R="$(sf dr 2 "$(summ dry-run false true present "$(counts 2 0 0 0 0 0 1 0 0 1 0 0)" '[{"objectId":"","companyId":1,"kind":"export","status":"missing_source"},{"objectId":"","companyId":1,"kind":"export","status":"duplicate","code":"DUPLICATE_REFERENCE"}]' '[{"companyId":1,"legacyKeyHash":"0123456789abcdef","kinds":["export"],"entityIds":[1,2]}]')")"
check "an incomplete dry-run (exit 2): INCOMPLETE, complete false, missing source 1, duplicate 1, problems 2, duplicate groups 1" "$(g dr_exit_meaning "$R")|$(g dr_complete "$R")|$(g dr_missing_source "$R")|$(g dr_duplicate "$R")|$(g dr_problems "$R")|$(g dr_duplicate_groups "$R")" "INCOMPLETE|false|1|1|2|1"
R="$(sf cp 0 "$(summ copy true false present "$(counts 0 4 0 0 0 0 0 0 0 0 0 0)")")"; R3="$(sf vf 0 "$(summ verify true true present "$(counts 0 0 0 4 0 0 0 0 0 0 0 0)")")"
check "copy / verify goldens: copied 4 (not read-only) and verified 4 (read-only)" "$(g cp_mode "$R")|$(g cp_copied "$R")|$(g cp_read_only "$R")|$(g vf_mode "$R3")|$(g vf_verified "$R3")|$(g vf_read_only "$R3")" "copy|4|false|verify|4|true"
check "the exception uuid among the problems is counted (never accepted silently)" "$(g vf_exception_listed "$(sf vf 2 "$(summ verify false true present "$(counts 0 0 0 3 0 0 0 1 0 0 0 0)" '[{"objectId":"'"$B25PHYS_UUID"'","companyId":53,"kind":"document","status":"checksum_mismatch"}]')")")" "1"
check "malformed input fails closed: empty / non-JSON / a JSON without counts / an unknown mode / a usage exit → parse_ok false or USAGE, never a count" "$(g dr_parse_ok "$(sf dr 0 '')")|$(g dr_parse_ok "$(sf dr 0 'not json')")|$(g dr_parse_ok "$(sf dr 0 '{"mode":"dry-run"}')")|$(g dr_parse_ok "$(sf dr 0 "$(summ teleport true true present "$(counts 1 0 0 0 0 0 0 0 0 0 0 0)")")")|$(g dr_exit_meaning "$(sf dr 1 '')")|$(g dr_parse_ok "$(sf dr 1 '')")" "false|false|false|false|USAGE|false"
check "a negative or non-integer count is read as 0 (never trusted)" "$(g dr_planned "$(sf dr 0 "$(summ dry-run true true present '{"planned":-3,"copied":"x","already":0,"verified":0,"not_migrated":0,"unregistered":0,"missing_source":0,"checksum_mismatch":0,"conflict":0,"duplicate":0,"failed":0,"skipped":0}')")")|$(g dr_copied "$(sf dr 0 "$(summ dry-run true true present '{"planned":1,"copied":"x","already":0,"verified":0,"not_migrated":0,"unregistered":0,"missing_source":0,"checksum_mismatch":0,"conflict":0,"duplicate":0,"failed":0,"skipped":0}')")")" "0|0"
check "the parser never prints record text: no console.log of a key, path or problem object; the summary facts carry only counts, booleans, modes and one md5" "$(grep -cE 'console\.log\((s|p|line|txt)\b|legacyKey\b' "$SUMJS" || true)|$(printf '%s\n' "$R" | tr ' ' '\n' | grep -vcE '^(cp_[a-z_]+=([0-9]+|true|false|COMPLETE|INCOMPLETE|USAGE|UNKNOWN|copy|dry-run|verify|none|present|absent|n/a|unknown|[0-9a-f]{32}|\?))?$')" "0|0"
rm -f "$SUMJS"
echo "== Stage 2B — the evaluator: goldens and denials in the four forms"
s2bgolden() { cat <<'F'
head_sha=6a8dad1fe161dc1b31041794e5e3532e9f13327c
current_deploy_sha=6a8dad1fe161dc1b31041794e5e3532e9f13327c
dirty=0
lock_absent=true
s2b_lock_absent=true
s2b_lock_owned=false
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
schema_fingerprint=30c4ecbd867cd2cd59abcb58581ecb04
storage_jobs_active=0
dead_jobs_total=0
log_mirror_failures=0
log_integrity_failures=0
log_init_failures=0
s2b_total=3
s2b_exception=1
s2b_native=2
s2b_migrated=0
s2b_legacy_source=0
s2b_duplicates=0
s2b_smoke_rows=0
s2b_failed=0
inv_uncertain=0
inv_unproven=0
inv_cleanup_pending=0
inv_leases=0
inv_inflight=0
inv_retained_legacy=1
census_total=4
census_unregistered=4
census_legacy_source=0
census_migrated=0
census_native_resolved=0
census_unclassified=0
census_dup_same_company=0
census_dup_cross_company=0
census_exception_refs=0
census_smoke_refs=0
cand_rows=4
cand_bytes_known=1299
cand_bytes_unknown_rows=0
vol_free_bytes=50000000000
image_present=false
image_commit_ok=false
nat_rows=2
nat_live_ok=2
nat_assoc_ok=2
nat_keys_md5=5c4f378ee12117ad6d40d02457d8cf1a
nat_pf_read_ok=true
nat_pf_present=2
nat_pf_regular=2
nat_pf_owner_ok=2
nat_pf_mode_ok=2
nat_pf_magic_ok=2
nat_pf_pdf_free=2
nat_pf_size_differs=2
nat_pf_cipher_md5=c5f0796fffede47b7900def36ca59bd3
fs_tenant_files=2
fs_other_files=0
fs_symlinks=0
nat_pm_read_ok=true
nat_pm_present=2
nat_pm_bucket_ok=2
nat_pm_canonical_key=2
nat_pm_marker_ok=2
nat_pm_generation_ok=2
nat_pm_size_ok=2
nat_pm_sha_ok=2
nat_pm_generations_md5=2e554409f57e27a4874a840175146407
mig_rows=0
mig_shape_ok=0
mig_assoc_ok=0
mig_keys_md5=d41d8cd98f00b204e9800998ecf8427e
mig_pf_read_ok=true
mig_mf_read_ok=true
mig_mf_present=0
mig_mf_regular=0
mig_mf_owner_ok=0
mig_mf_mode_ok=0
mig_mf_magic_ok=0
mig_mf_size_differs=0
mig_ms_read_ok=true
mig_ms_present=0
mig_ms_bucket_ok=0
mig_ms_size_ok=0
mig_ms_sha_ok=0
mig_ms_generation_ok=0
mig_ms_marked=0
mount_type=volume
mount_name=card-scanner-pro_objectdata
mount_rw=true
root_owner=999:999
root_mode=700
root_is_symlink=false
root_is_dir=true
root_writable=true
root_tenant_files=2
root_entries_allowed=true
exc_row_count=1
exc_state=deleted
exc_last_error=LEGACY_RETAINED
exc_driver=gcs
exc_company=53
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
census_objects=7
census_marked=3
census_generationless=0
census_md5=b7c8dd371c7d7e076f05ae8f69fc44e2
unmarked_objects=4
unmarked_md5=c1b900fd509bafa1f980d863dc0d195b
originals_referenced=4
originals_present=4
originals_missing=0
originals_size_match=4
refs_legacy_count=4
refs_ambiguous=0
leak_root_path=0
leak_key_shaped=0
leak_key_assignment=0
leak_bucket_ref=0
leak_signature=0
web_leak_root_path=0
web_leak_signature=0
s2b_output_leaks=0
F
}
mark() { grep -oE "^$1=(TRUE|FALSE)$" | cut -d= -f2; }
s2bdry() { s2bgolden | sed -E 's/^image_present=false/image_present=true/; s/^image_commit_ok=false/image_commit_ok=true/'; printf '%s\n' pre_census_md5=b7c8dd371c7d7e076f05ae8f69fc44e2 dr_parse_ok=true dr_mode=dry-run dr_exit=0 dr_exit_meaning=COMPLETE dr_complete=true dr_read_only=true dr_target_root=present dr_planned=4 dr_already=0 dr_missing_source=0 dr_checksum_mismatch=0 dr_conflict=0 dr_duplicate=0 dr_failed=0 dr_duplicate_groups=0 dr_unattributable=0 dr_exception_listed=0 dr_source_references=4 dr_repeat_identical=true dr_inventory_unchanged=true; }
# after the copy of the four originals: migrated 4 (files + retained sources proven), unregistered 0, native unchanged, bucket unchanged
s2bpost() { s2bgolden | sed -E 's/^image_present=false/image_present=true/; s/^image_commit_ok=false/image_commit_ok=true/; s/^s2b_total=3/s2b_total=7/; s/^s2b_migrated=0/s2b_migrated=4/; s/^census_unregistered=4/census_unregistered=0/; s/^census_migrated=0/census_migrated=4/; s/^cand_rows=4/cand_rows=0/; s/^cand_bytes_known=1299/cand_bytes_known=0/; s/^(mig_(rows|shape_ok|assoc_ok|mf_present|mf_regular|mf_owner_ok|mf_mode_ok|mf_magic_ok|mf_size_differs|ms_present|ms_bucket_ok|ms_size_ok|ms_sha_ok|ms_generation_ok))=0/\1=4/; s/^fs_tenant_files=2/fs_tenant_files=6/; s/^root_tenant_files=2/root_tenant_files=6/'; }
# the copy form is evaluated WHILE this operation's lock is held: present and owned
s2bcopy() { s2bpost | sed -E 's/^s2b_lock_absent=true/s2b_lock_absent=false/; s/^s2b_lock_owned=false/s2b_lock_owned=true/'; printf '%s\n' pre_candidates=4 pre_migrated=0 pre_native=2 pre_nat_keys_md5=5c4f378ee12117ad6d40d02457d8cf1a pre_nat_pf_cipher_md5=c5f0796fffede47b7900def36ca59bd3 pre_nat_pm_generations_md5=2e554409f57e27a4874a840175146407 pre_census_md5=b7c8dd371c7d7e076f05ae8f69fc44e2 cp_parse_ok=true cp_mode=copy cp_exit=0 cp_exit_meaning=COMPLETE cp_complete=true cp_copied=4 cp_already=0 cp_missing_source=0 cp_checksum_mismatch=0 cp_conflict=0 cp_duplicate=0 cp_failed=0 cp_exception_listed=0 vf_parse_ok=true vf_mode=verify vf_exit=0 vf_exit_meaning=COMPLETE vf_complete=true vf_read_only=true vf_verified=4 vf_unregistered=0 vf_not_migrated=0 vf_checksum_mismatch=0 vf_failed=0 vf_exception_listed=0; }
s2bpv() { s2bpost; printf '%s\n' vf_parse_ok=true vf_mode=verify vf_exit=0 vf_exit_meaning=COMPLETE vf_complete=true vf_read_only=true vf_verified=4 vf_unregistered=0 vf_not_migrated=0 vf_checksum_mismatch=0 vf_failed=0 vf_exception_listed=0; }
V="$(s2bgolden | stage2b_eligibility preflight)"
check "preflight golden (today's hosted shape: native 2, migrated 0, legacy source 0, 4 unregistered export originals, bucket 4 + 1 + 2) → PREFLIGHT_READY TRUE, 0 of 14 conditions failed, every other marker FALSE, inventory line printed, the informational record lines printed, exit 0" "$(printf '%s\n' "$V" | mark B25_STAGE2B_PREFLIGHT_READY)|$(printf '%s\n' "$V" | grep -oE '^B25_STAGE2B_CONDITIONS_FAILED=[0-9]+$')|$(printf '%s\n' "$V" | grep -c '^stage2b [0-9]*: ')|$(printf '%s\n' "$V" | mark B25_STAGE2B_DRY_RUN_REPORTED)|$(printf '%s\n' "$V" | mark B25_STAGE2B_COPY_VERIFIED)|$(printf '%s\n' "$V" | mark B25_STAGE2B_POSTVERIFY_READY)|$(printf '%s\n' "$V" | grep -c '^B25_STAGE2B_INVENTORY=native:2 migrated:0 legacy_source:0 unregistered:4 failed:0 duplicates:0$')|$(printf '%s\n' "$V" | grep -c '^census_md5_record_match=true$')|$(printf '%s\n' "$V" | grep -c '^native_delta_vs_record=+0$')|$(s2bgolden | stage2b_eligibility preflight >/dev/null; echo $?)" "TRUE|B25_STAGE2B_CONDITIONS_FAILED=0|14|FALSE|FALSE|FALSE|1|1|1|0"
check "dry-run golden → DRY_RUN_REPORTED TRUE; copy golden → COPY_VERIFIED TRUE; postverify golden → POSTVERIFY_READY TRUE; an unknown form → every marker FALSE" "$(s2bdry | stage2b_eligibility dryrun | mark B25_STAGE2B_DRY_RUN_REPORTED)|$(s2bcopy | stage2b_eligibility copy | mark B25_STAGE2B_COPY_VERIFIED)|$(s2bpv | stage2b_eligibility postverify | mark B25_STAGE2B_POSTVERIFY_READY)|$(s2bgolden | stage2b_eligibility bogus | grep -c '=FALSE$')" "TRUE|TRUE|TRUE|4"
check "the verdict never prints a 64-hex digest, a tenant key path, the filesystem root or a bucket name" "$(printf '%s\n' "$V" | grep -cE '[0-9a-f]{64}|tenants/[0-9]+/|/data/objects|gs://' || true)" "0"
den() { local form="$1" label="$2" expr="$3" src marker v; case "$form" in preflight) src=s2bgolden; marker=B25_STAGE2B_PREFLIGHT_READY ;; dryrun) src=s2bdry; marker=B25_STAGE2B_DRY_RUN_REPORTED ;; copy) src=s2bcopy; marker=B25_STAGE2B_COPY_VERIFIED ;; postverify) src=s2bpv; marker=B25_STAGE2B_POSTVERIFY_READY ;; esac; v="$("$src" | sed -E "$expr" | stage2b_eligibility "$form" | mark "$marker")"; if [ "$v" = "FALSE" ]; then ok "stage2b $form: $label → FALSE"; else bad "stage2b $form: $label → expected FALSE, got '$v'"; fi; }
den preflight "the Stage 2A product commit instead of the Stage 2B one" 's/^(head_sha|current_deploy_sha)=.*/\1=e559b0024b28d4a77becdcb10c4168004dddea75/'
den preflight "checkout and current-deploy.sha disagree" 's/^current_deploy_sha=.*/current_deploy_sha=e559b0024b28d4a77becdcb10c4168004dddea75/'
den preflight "dirty checkout" 's/^dirty=0/dirty=1/'
den preflight "Stage 2A activation lock present" 's/^lock_absent=true/lock_absent=false/'
den preflight "Stage 2B copy lock present (a previous copy did not finish)" 's/^s2b_lock_absent=true/s2b_lock_absent=false/'
den preflight "G. a copy lock present and claimed as owned (no read-only form may own a lock)" 's/^s2b_lock_absent=true/s2b_lock_absent=false/; s/^s2b_lock_owned=false/s2b_lock_owned=true/'
den preflight "the lock facts missing" '/^s2b_lock_/d'
den dryrun "G. a Stage 2B copy lock present (an unexplained lock is rejected by the dry-run form)" 's/^s2b_lock_absent=true/s2b_lock_absent=false/'
den postverify "G. a Stage 2B copy lock present (an unexplained lock is rejected by the postverify form)" 's/^s2b_lock_absent=true/s2b_lock_absent=false/'
den copy "stale lock facts: the lock vanished before the post-copy facts were captured (the copy form requires its own lock present)" 's/^s2b_lock_absent=false/s2b_lock_absent=true/; s/^s2b_lock_owned=true/s2b_lock_owned=false/'
den copy "C. a foreign lock in the copy form (present, not owned by this operation)" 's/^s2b_lock_owned=true/s2b_lock_owned=false/'
den copy "inconsistent lock facts (absent yet owned)" 's/^s2b_lock_absent=false/s2b_lock_absent=true/'
den copy "the lock facts missing" '/^s2b_lock_/d'
den preflight "api unhealthy" 's/^api_health=healthy/api_health=unhealthy/'
den preflight "readiness storage degraded" 's/^readyz_storage=ok/readyz_storage=degraded/'
den preflight "driver not fs (banner)" 's/^banner_driver=fs/banner_driver=gcs/'
den preflight "legacy fallback off" 's/^env_fallback_is_true=true/env_fallback_is_true=false/'
den preflight "mirror off" 's/^init_mirror=true/init_mirror=false/'
den preflight "legacy delete on" 's/^init_legacy_delete=false/init_legacy_delete=true/'
den preflight "encryption key absent" 's/^env_key_set=true/env_key_set=false/'
den preflight "env file managed lines differ" 's/^env_file_managed_ok=true/env_file_managed_ok=false/'
den preflight "schema fingerprint changed" 's/^schema_fingerprint=.*/schema_fingerprint=00000000000000000000000000000000/'
den preflight "an active storage job" 's/^storage_jobs_active=0/storage_jobs_active=1/'
den preflight "a dead job" 's/^dead_jobs_total=0/dead_jobs_total=1/'
den preflight "a mirror failure" 's/^log_mirror_failures=0/log_mirror_failures=1/'
den preflight "an unproven row (FAILED_OR_UNPROVEN 1)" 's/^s2b_total=3/s2b_total=4/; s/^s2b_failed=0/s2b_failed=1/'
den preflight "a duplicate legacy source" 's/^s2b_duplicates=0/s2b_duplicates=1/'
den preflight "a smoke row present" 's/^s2b_smoke_rows=0/s2b_smoke_rows=1/'
den preflight "no native row at all" 's/^s2b_native=2/s2b_native=0/; s/^s2b_total=3/s2b_total=1/; s/^nat_(rows|live_ok|assoc_ok|pf_present|pf_regular|pf_owner_ok|pf_mode_ok|pf_magic_ok|pf_pdf_free|pf_size_differs|pm_present|pm_bucket_ok|pm_canonical_key|pm_marker_ok|pm_generation_ok|pm_size_ok|pm_sha_ok)=2/nat_\1=0/; s/^(fs|root)_tenant_files=2/\1_tenant_files=0/; s/^census_objects=7/census_objects=5/; s/^census_marked=3/census_marked=1/'
den preflight "partition arithmetic broken (a row outside every class)" 's/^s2b_total=3/s2b_total=4/'
den preflight "a leased row" 's/^inv_leases=0/inv_leases=1/'
den preflight "an uncertain row" 's/^inv_uncertain=0/inv_uncertain=1/'
den preflight "census incomplete (a reference resolving to an unclassified row)" 's/^census_unclassified=0/census_unclassified=1/; s/^census_total=4/census_total=5/'
den preflight "census arithmetic broken" 's/^census_total=4/census_total=5/'
den preflight "a duplicate reference within a company" 's/^census_dup_same_company=0/census_dup_same_company=1/'
den preflight "a reference claimed by two companies (ownership stop)" 's/^census_dup_cross_company=0/census_dup_cross_company=1/'
den preflight "a candidate of the exception's company" 's/^census_exception_refs=0/census_exception_refs=1/'
den preflight "a candidate of a smoke tenant" 's/^census_smoke_refs=0/census_smoke_refs=1/'
den preflight "census and inventory disagree on the migrated count" 's/^census_migrated=0/census_migrated=1/'
den preflight "insufficient capacity (free < 2 × candidates + headroom)" 's/^vol_free_bytes=.*/vol_free_bytes=268437000/'
den preflight "capacity unknown" 's/^vol_free_bytes=.*/vol_free_bytes=?/'
den preflight "a candidate of unknown size" 's/^cand_bytes_unknown_rows=0/cand_bytes_unknown_rows=1/'
den preflight "candidate rows disagree with the unregistered census" 's/^cand_rows=4/cand_rows=3/'
den preflight "a native row without ownership proof" 's/^nat_live_ok=2/nat_live_ok=1/'
den preflight "a native row without product association" 's/^nat_assoc_ok=2/nat_assoc_ok=1/'
den preflight "a native file missing" 's/^nat_pf_present=2/nat_pf_present=1/'
den preflight "a native file with the wrong owner" 's/^nat_pf_owner_ok=2/nat_pf_owner_ok=1/'
den preflight "a native file without the envelope magic" 's/^nat_pf_magic_ok=2/nat_pf_magic_ok=1/'
den preflight "a native mirror missing" 's/^nat_pm_present=2/nat_pm_present=1/'
den preflight "a native mirror with the wrong digest" 's/^nat_pm_sha_ok=2/nat_pm_sha_ok=1/'
den preflight "the file probe did not answer" 's/^nat_pf_read_ok=true/nat_pf_read_ok=false/'
den preflight "the mirror probe did not answer" 's/^nat_pm_read_ok=true/nat_pm_read_ok=false/'
den preflight "the source probe did not answer" 's/^mig_ms_read_ok=true/mig_ms_read_ok=false/'
den preflight "an extra tenant file on the volume" 's/^fs_tenant_files=2/fs_tenant_files=3/'
den preflight "a foreign file in the root" 's/^fs_other_files=0/fs_other_files=1/'
den preflight "a symlink in the root" 's/^fs_symlinks=0/fs_symlinks=1/'
den preflight "the root not the named volume" 's/^mount_type=volume/mount_type=bind/'
den preflight "the root owned by another uid" 's/^root_owner=999:999/root_owner=0:0/'
den preflight "the root not writable by the runtime" 's/^root_writable=true/root_writable=false/'
den preflight "the exception row no longer deleted" 's/^exc_state=deleted/exc_state=active/'
den preflight "the exception row leased" 's/^exc_lease=false/exc_lease=true/'
den preflight "the exception provider object missing" 's/^exc_provider_present=true/exc_provider_present=false/'
den preflight "the exception generation changed" 's/^exc_generation_digest=.*/exc_generation_digest=0000000000000000/'
den preflight "an extra provider object (the copy must write no bucket object)" 's/^census_objects=7/census_objects=8/'
den preflight "the bucket inventory digest unreadable" 's/^census_md5=.*/census_md5=?/'
den preflight "an original missing" 's/^originals_present=4/originals_present=3/; s/^originals_missing=0/originals_missing=1/'
den preflight "the originals digest changed" 's/^unmarked_md5=.*/unmarked_md5=00000000000000000000000000000000/'
den preflight "a fifth legacy reference" 's/^refs_legacy_count=4/refs_legacy_count=5/'
den preflight "an ambiguous reference" 's/^refs_ambiguous=0/refs_ambiguous=1/'
den preflight "a plaintext path in the api log" 's/^leak_root_path=0/leak_root_path=1/'
den preflight "a leak in the mode's own output" 's/^s2b_output_leaks=0/s2b_output_leaks=1/'
den preflight "a transient legacy-source row before the first copy" 's/^s2b_legacy_source=0/s2b_legacy_source=1/; s/^s2b_total=3/s2b_total=4/; s/^census_legacy_source=0/census_legacy_source=1/; s/^census_total=4/census_total=5/'
den preflight "a missing fact (the readiness line absent)" '/^readyz_status=/d'
den dryrun "image not built from the product commit" 's/^image_commit_ok=true/image_commit_ok=false/'
den dryrun "image absent" 's/^image_present=true/image_present=false/'
den dryrun "summary not parseable" 's/^dr_parse_ok=true/dr_parse_ok=false/'
den dryrun "wrong mode in the summary" 's/^dr_mode=dry-run/dr_mode=copy/'
den dryrun "exit 2 (incomplete)" 's/^dr_exit_meaning=COMPLETE/dr_exit_meaning=INCOMPLETE/; s/^dr_complete=true/dr_complete=false/'
den dryrun "exit 1 (usage / configuration)" 's/^dr_exit_meaning=COMPLETE/dr_exit_meaning=USAGE/'
den dryrun "target not opened read-only" 's/^dr_read_only=true/dr_read_only=false/'
den dryrun "target root absent" 's/^dr_target_root=present/dr_target_root=absent/'
den dryrun "planned ≠ unregistered + legacy source (a candidate not planned)" 's/^dr_planned=4/dr_planned=3/'
den dryrun "a missing source" 's/^dr_missing_source=0/dr_missing_source=1/'
den dryrun "a destination conflict" 's/^dr_conflict=0/dr_conflict=1/'
den dryrun "a duplicate reference" 's/^dr_duplicate=0/dr_duplicate=1/'
den dryrun "a duplicate group" 's/^dr_duplicate_groups=0/dr_duplicate_groups=1/'
den dryrun "a failed item" 's/^dr_failed=0/dr_failed=1/'
den dryrun "an unattributable reference" 's/^dr_unattributable=0/dr_unattributable=1/'
den dryrun "the exception listed by the product" 's/^dr_exception_listed=0/dr_exception_listed=1/'
den dryrun "source references ≠ the census" 's/^dr_source_references=4/dr_source_references=5/'
den dryrun "the two dry-runs differ (not idempotent)" 's/^dr_repeat_identical=true/dr_repeat_identical=false/'
den dryrun "the inventory moved across the dry-runs" 's/^dr_inventory_unchanged=true/dr_inventory_unchanged=false/'
den dryrun "9. the bucket inventory changed between this session's preflight and the dry-run (same-session digest)" 's/^pre_census_md5=.*/pre_census_md5=00000000000000000000000000000000/'
den dryrun "9b. the preflight census digest missing from the dry-run facts" '/^pre_census_md5=/d'
den dryrun "9c. the census digest unreadable in both" 's/^census_md5=.*/census_md5=?/; s/^pre_census_md5=.*/pre_census_md5=?/'
den copy "copied ≠ the preflight candidates (partial migration)" 's/^cp_copied=4/cp_copied=3/'
den copy "copy incomplete (exit 2)" 's/^cp_exit_meaning=COMPLETE/cp_exit_meaning=INCOMPLETE/; s/^cp_complete=true/cp_complete=false/'
den copy "a checksum mismatch in the copy" 's/^cp_checksum_mismatch=0/cp_checksum_mismatch=1/'
den copy "a conflict in the copy" 's/^cp_conflict=0/cp_conflict=1/'
den copy "a failed item in the copy" 's/^cp_failed=0/cp_failed=1/'
den copy "the exception listed by the copy" 's/^cp_exception_listed=0/cp_exception_listed=1/'
den copy "verify incomplete" 's/^vf_complete=true/vf_complete=false/; s/^vf_exit_meaning=COMPLETE/vf_exit_meaning=INCOMPLETE/'
den copy "verified ≠ migrated" 's/^vf_verified=4/vf_verified=3/'
den copy "an unregistered reference after the copy" 's/^vf_unregistered=0/vf_unregistered=1/'
den copy "a row still on the legacy driver" 's/^vf_not_migrated=0/vf_not_migrated=1/'
den copy "a legacy-source row left (interrupted copy)" 's/^s2b_legacy_source=0/s2b_legacy_source=1/; s/^s2b_total=7/s2b_total=8/; s/^census_legacy_source=0/census_legacy_source=1/; s/^census_total=4/census_total=5/'
den copy "an unregistered candidate left" 's/^census_unregistered=0/census_unregistered=1/; s/^census_total=4/census_total=5/; s/^cand_rows=0/cand_rows=1/'
den copy "migrated ≠ before + candidates" 's/^pre_candidates=4/pre_candidates=3/'
den copy "the native class changed (keys)" 's/^pre_nat_keys_md5=.*/pre_nat_keys_md5=00000000000000000000000000000000/'
den copy "a native ciphertext changed" 's/^pre_nat_pf_cipher_md5=.*/pre_nat_pf_cipher_md5=00000000000000000000000000000000/'
den copy "a native mirror generation changed" 's/^pre_nat_pm_generations_md5=.*/pre_nat_pm_generations_md5=00000000000000000000000000000000/'
den copy "the bucket inventory changed across the copy (an object added or deleted)" 's/^pre_census_md5=.*/pre_census_md5=00000000000000000000000000000000/'
den copy "10. the post-copy bucket digest differs from the preflight (same-session digest; the record digest is irrelevant)" 's/^census_md5=.*/census_md5=00000000000000000000000000000000/'
den copy "the post-copy census digest unreadable" 's/^census_md5=.*/census_md5=?/; s/^pre_census_md5=.*/pre_census_md5=?/'
den copy "a migrated file missing" 's/^mig_mf_present=4/mig_mf_present=3/'
den copy "a migrated file without the envelope magic (invalid encryption envelope)" 's/^mig_mf_magic_ok=4/mig_mf_magic_ok=3/'
den copy "a migrated file with the wrong owner" 's/^mig_mf_owner_ok=4/mig_mf_owner_ok=3/'
den copy "a retained source missing (source deletion forbidden)" 's/^mig_ms_present=4/mig_ms_present=3/'
den copy "a retained source with the wrong size" 's/^mig_ms_size_ok=4/mig_ms_size_ok=3/'
den copy "a retained source whose digest differs from the row" 's/^mig_ms_sha_ok=4/mig_ms_sha_ok=3/'
den copy "a source carrying a marker (not an original)" 's/^mig_ms_marked=0/mig_ms_marked=1/'
den copy "a migrated row without association" 's/^mig_assoc_ok=4/mig_assoc_ok=3/'
den copy "a migrated row outside the exact shape" 's/^mig_shape_ok=4/mig_shape_ok=3/'
den copy "the volume holds fewer files than native + migrated" 's/^root_tenant_files=6/root_tenant_files=5/'
den postverify "verify incomplete" 's/^vf_complete=true/vf_complete=false/; s/^vf_exit_meaning=COMPLETE/vf_exit_meaning=INCOMPLETE/'
den postverify "verify not read-only" 's/^vf_read_only=true/vf_read_only=false/'
den postverify "a checksum mismatch (a migrated file whose digest differs)" 's/^vf_checksum_mismatch=0/vf_checksum_mismatch=1/'
den postverify "a pending reference remains" 's/^census_unregistered=0/census_unregistered=1/; s/^census_total=4/census_total=5/; s/^cand_rows=0/cand_rows=1/'
den postverify "no migrated row at all" 's/^s2b_migrated=4/s2b_migrated=0/; s/^s2b_total=7/s2b_total=3/; s/^census_migrated=4/census_migrated=0/; s/^census_total=4/census_total=0/; s/^(mig_[a-z_]+)=4/\1=0/; s/^(fs|root)_tenant_files=6/\1_tenant_files=2/; s/^vf_verified=4/vf_verified=0/'
den postverify "image not from the product commit" 's/^image_commit_ok=true/image_commit_ok=false/'
check "a single fact moves exactly one condition (fingerprint / capacity / a native mirror / the originals digest); a changed record digest moves none" "$(s2bgolden | sed -E 's/^schema_fingerprint=.*/schema_fingerprint=00000000000000000000000000000000/' | stage2b_eligibility preflight | grep -c ' — FAIL')|$(s2bgolden | sed -E 's/^vol_free_bytes=.*/vol_free_bytes=1/' | stage2b_eligibility preflight | grep -c ' — FAIL')|$(s2bgolden | sed -E 's/^nat_pm_present=2/nat_pm_present=1/' | stage2b_eligibility preflight | grep -c ' — FAIL')|$(s2bgolden | sed -E 's/^unmarked_md5=.*/unmarked_md5=00000000000000000000000000000000/' | stage2b_eligibility preflight | grep -c ' — FAIL')|$(s2bgolden | sed -E 's/^census_md5=.*/census_md5=00000000000000000000000000000000/' | stage2b_eligibility preflight | grep -c ' — FAIL' || true)" "1|1|1|1|0"
echo "== Stage 2B — batch 17: the 2026-10-23 record is informational; the bucket partition proof (object by object) is the gate"
rec() { printf '%s\n' "$1" | grep -oE '^(census_md5_record_match|native_delta_vs_record)=[^ ]+$' | tr '\n' ' ' | sed 's/ $//'; }
V="$(s2bgolden | stage2b_eligibility preflight)"
check "1. the historical census digest matches and every proof holds → TRUE; census_md5_record_match=true and native_delta_vs_record=+0 printed as informational lines; condition 12 reports the record match in its detail only" "$(printf '%s\n' "$V" | mark B25_STAGE2B_PREFLIGHT_READY)|$(rec "$V")|$(printf '%s\n' "$V" | grep -cE '^stage2b 12: .* — OK \(.*census_md5_record_match=true')" "TRUE|census_md5_record_match=true native_delta_vs_record=+0|1"
# a new legitimate native mirror after the maintenance release: N = 3 — its row, encrypted file and mirror individually proven,
# the bucket grows by exactly one marked object, the digest no longer equals the record
s2bn3() { s2bgolden | sed -E 's/^s2b_native=2/s2b_native=3/; s/^s2b_total=3/s2b_total=4/; s/^(nat_(rows|live_ok|assoc_ok|pf_present|pf_regular|pf_owner_ok|pf_mode_ok|pf_magic_ok|pf_pdf_free|pf_size_differs|pm_present|pm_bucket_ok|pm_canonical_key|pm_marker_ok|pm_generation_ok|pm_size_ok|pm_sha_ok))=2/\1=3/; s/^(fs|root)_tenant_files=2/\1_tenant_files=3/; s/^census_objects=7/census_objects=8/; s/^census_marked=3/census_marked=4/; s/^census_md5=.*/census_md5=0123456789abcdef0123456789abcdef/'; }
V3="$(s2bn3 | stage2b_eligibility preflight)"
check "2. a new legitimate native mirror (N = 3: row, encrypted file and mirror individually proven; bucket 4 + 1 + 3; digest ≠ record) → TRUE with census_md5_record_match=false native_delta_vs_record=+1 (N derived from the proven rows, not from a constant)" "$(printf '%s\n' "$V3" | mark B25_STAGE2B_PREFLIGHT_READY)|$(rec "$V3")|$(printf '%s\n' "$V3" | grep -c '^B25_STAGE2B_INVENTORY=native:3 ')" "TRUE|census_md5_record_match=false native_delta_vs_record=+1|1"
den3() { local label="$1" expr="$2" v; v="$(s2bn3 | sed -E "$expr" | stage2b_eligibility preflight | mark B25_STAGE2B_PREFLIGHT_READY)"; if [ "$v" = "FALSE" ]; then ok "stage2b preflight (N = 3): $label → FALSE"; else bad "stage2b preflight (N = 3): $label → expected FALSE, got '$v'"; fi; }
den3 "2a. the new native row without its mirror proof" 's/^nat_pm_present=3/nat_pm_present=2/'
den3 "2b. the new native row without its encrypted file" 's/^nat_pf_present=3/nat_pf_present=2/'
den3 "2c. the new native row without ownership proof" 's/^nat_live_ok=3/nat_live_ok=2/'
den3 "2d. the new native row without product association" 's/^nat_assoc_ok=3/nat_assoc_ok=2/'
den3 "2e. the new mirror proven but the bucket carries one more object than the partition explains (objects 9 for N = 3)" 's/^census_objects=8/census_objects=9/'
den3 "2f. the new native row counted but its mirror object absent from the bucket (objects 7 / marked 3 for N = 3)" 's/^census_marked=4/census_marked=3/; s/^census_objects=8/census_objects=7/'
den3 "2g. the new native row's encrypted file missing from the volume (tenant files 2 for N = 3)" 's/^(fs|root)_tenant_files=3/\1_tenant_files=2/'
V="$(s2bgolden | sed -E 's/^census_md5=.*/census_md5=0123456789abcdef0123456789abcdef/' | stage2b_eligibility preflight)"
check "3. the historical census digest differs but the bucket partition is fully proven (4 + 1 + 2, every object explained) → TRUE with census_md5_record_match=false native_delta_vs_record=+0; 0 of 14 conditions failed" "$(printf '%s\n' "$V" | mark B25_STAGE2B_PREFLIGHT_READY)|$(rec "$V")|$(printf '%s\n' "$V" | grep -oE '^B25_STAGE2B_CONDITIONS_FAILED=[0-9]+$')" "TRUE|census_md5_record_match=false native_delta_vs_record=+0|B25_STAGE2B_CONDITIONS_FAILED=0"
check "3b. the same in the dry-run, copy and postverify forms: the record digest never gates; the SAME-SESSION digest (pre_census_md5 = census_md5) still must hold" "$(s2bdry | sed -E 's/^(pre_)?census_md5=.*/\1census_md5=0123456789abcdef0123456789abcdef/' | stage2b_eligibility dryrun | mark B25_STAGE2B_DRY_RUN_REPORTED)|$(s2bcopy | sed -E 's/^(pre_)?census_md5=.*/\1census_md5=0123456789abcdef0123456789abcdef/' | stage2b_eligibility copy | mark B25_STAGE2B_COPY_VERIFIED)|$(s2bpv | sed -E 's/^census_md5=.*/census_md5=0123456789abcdef0123456789abcdef/' | stage2b_eligibility postverify | mark B25_STAGE2B_POSTVERIFY_READY)" "TRUE|TRUE|TRUE"
den preflight "4. an extra unmarked bucket object (objects 8, unmarked 5)" 's/^census_objects=7/census_objects=8/; s/^unmarked_objects=4/unmarked_objects=5/'
den preflight "4b. an extra bucket object hidden behind unchanged marked / unmarked counts (objects 8)" 's/^census_objects=7/census_objects=8/'
den preflight "4c. a fifth unmarked object with the originals digest recomputed over five (objects 8, unmarked 5, digest changed)" 's/^census_objects=7/census_objects=8/; s/^unmarked_objects=4/unmarked_objects=5/; s/^unmarked_md5=.*/unmarked_md5=0123456789abcdef0123456789abcdef/'
den preflight "5. an extra unexplained marked object (objects 8, marked 4, N = 2)" 's/^census_objects=7/census_objects=8/; s/^census_marked=3/census_marked=4/'
den preflight "5b. a marked object in place of an original (unmarked 3, marked 4, objects 7)" 's/^unmarked_objects=4/unmarked_objects=3/; s/^census_marked=3/census_marked=4/'
den preflight "5c. a generationless object in the bucket" 's/^census_generationless=0/census_generationless=1/'
den preflight "6. a missing original legacy object (objects 6, unmarked 3, present 3, missing 1)" 's/^census_objects=7/census_objects=6/; s/^unmarked_objects=4/unmarked_objects=3/; s/^originals_present=4/originals_present=3/; s/^originals_missing=0/originals_missing=1/'
den preflight "6b. an original replaced by another object (count unchanged, originals digest changed)" 's/^unmarked_md5=.*/unmarked_md5=0123456789abcdef0123456789abcdef/'
den preflight "6c. an original with a changed size" 's/^originals_size_match=4/originals_size_match=3/'
den preflight "7. a native mirror with the wrong generation" 's/^nat_pm_generation_ok=2/nat_pm_generation_ok=1/'
den preflight "7b. a native mirror under a non-canonical key" 's/^nat_pm_canonical_key=2/nat_pm_canonical_key=1/'
den preflight "7c. a native mirror in another bucket" 's/^nat_pm_bucket_ok=2/nat_pm_bucket_ok=1/'
den preflight "7d. a native mirror without the marker" 's/^nat_pm_marker_ok=2/nat_pm_marker_ok=1/'
den preflight "7e. a native mirror with the wrong size" 's/^nat_pm_size_ok=2/nat_pm_size_ok=1/'
den preflight "7f. a native mirror with the wrong plaintext digest (ownership of the content unproven)" 's/^nat_pm_sha_ok=2/nat_pm_sha_ok=1/'
den preflight "8. an unproven native row (a third row outside every class, its object in the bucket)" 's/^s2b_total=3/s2b_total=4/; s/^s2b_failed=0/s2b_failed=1/; s/^census_objects=7/census_objects=8/; s/^census_marked=3/census_marked=4/'
den preflight "8b. a native row counted by the partition but not by the Correction 5 live predicate" 's/^nat_rows=2/nat_rows=1/'
den preflight "8c. a native row whose encrypted file lacks the envelope magic" 's/^nat_pf_magic_ok=2/nat_pf_magic_ok=1/'
check "the record constants are readonly, 32-hex / integer; the retired gate names are gone from every Stage 2B file; the record digest never appears in a condition's predicate line; the same-session census comparison is a predicate in exactly the dry-run and copy forms" "$(bash -c 'source "'"$HERE"'/b25-stage1-purge-lib.sh"; source "'"$HERE"'/b25-stage1-apply-lib.sh"; source "'"$HERE"'/b25-stage2b-lib.sh"; (S2B_RECORD_CENSUS_MD5_20261023=0) 2>/dev/null; (S2B_RECORD_NATIVE_ROWS_20261023=0) 2>/dev/null; echo "$S2B_RECORD_CENSUS_MD5_20261023/$S2B_RECORD_NATIVE_ROWS_20261023"')|$(grep -cE 'S2B_BASE_(CENSUS_MD5|NATIVE_ROWS|CANDIDATES)' "$S2BLIB" "$S2BAPPLY" | awk -F: '{s+=$2} END {print s+0}')|$(lbody stage2b_eligibility | grep -E '^\s*(ok=1;|&& )' | grep -c 'S2B_RECORD_CENSUS_MD5_20261023' || true)|$(lbody stage2b_eligibility | grep -c 'is_eq census_md5 "\$(g pre_census_md5)"')" "b7c8dd371c7d7e076f05ae8f69fc44e2/2|0|0|2"
echo "== Stage 2B — batch 17: the copy lock (unit) — absent / foreign / symlink / own / mode / content / no expectation"
eval "$(body stage2b_lock_owned)"; eval "$(body stage2b_lock_facts)"; stage2b_lock_file() { printf '%s/%s' "$HOME" "$S2B_LOCK_NAME"; }
S2B_LOCK_EXPECT=""
lf() { ( HOME="$1"; S2B_LOCK_EXPECT="${2:-}"; stage2b_lock_facts | tr '\n' ' ' | sed 's/ $//' ); }
U="$(mktemp -d)"; REC="started_at=2026-10-23T00:00:00Z product=$STAGE2B_PRODUCT_SHA token=0123456789abcdef0123456789abcdef"
check "lock facts: no entry → absent / not owned" "$(lf "$U" "$REC")" "s2b_lock_absent=true s2b_lock_owned=false"
check "lock facts: a foreign file → present / not owned" "$( ( umask 077; echo foreign > "$U/$S2B_LOCK_NAME" ); lf "$U" "$REC"; rm -f "$U/$S2B_LOCK_NAME")" "s2b_lock_absent=false s2b_lock_owned=false"
check "lock facts: a dangling symlink at the lock path → present (never absent) / not owned" "$(ln -s "$U/nowhere" "$U/$S2B_LOCK_NAME"; lf "$U" "$REC"; rm -f "$U/$S2B_LOCK_NAME")" "s2b_lock_absent=false s2b_lock_owned=false"
check "lock facts: the own record as a 0600 regular file → present / owned; mode 0644 → not owned; one changed byte → not owned; no expectation (a read-only phase) → never owned" "$( ( umask 077; printf '%s\n' "$REC" > "$U/$S2B_LOCK_NAME" ); lf "$U" "$REC")|$(chmod 644 "$U/$S2B_LOCK_NAME"; lf "$U" "$REC"; chmod 600 "$U/$S2B_LOCK_NAME")|$(lf "$U" "${REC%f}e")|$(lf "$U" "")" "s2b_lock_absent=false s2b_lock_owned=true|s2b_lock_absent=false s2b_lock_owned=false|s2b_lock_absent=false s2b_lock_owned=false|s2b_lock_absent=false s2b_lock_owned=false"
rm -rf "$U"
echo "== Stage 2B — batch 17: the copy-lock lifecycle (the REAL copy phase run with stubbed host readers in a private HOME; the lock functions are real)"
T17="$(mktemp -d)"
s2bgolden > "$T17/pre.facts"; s2bpost > "$T17/post.facts"; s2bdry | grep -E '^dr_' > "$T17/dr.facts"
s2bcopy | grep -E '^cp_' > "$T17/cp-ok.facts"; s2bcopy | grep -E '^vf_' > "$T17/vf-ok.facts"
sed -E 's/^cp_failed=0/cp_failed=1/' "$T17/cp-ok.facts" > "$T17/cp-failed.facts"
sed -E 's/^cp_copied=4/cp_copied=3/' "$T17/cp-ok.facts" > "$T17/cp-partial.facts"
sed -E 's/^vf_checksum_mismatch=0/vf_checksum_mismatch=1/' "$T17/vf-ok.facts" > "$T17/vf-mismatch.facts"
git -C "$ROOT" show 6c367dbe2a5c0764594fd8f6ba90c46f9ebab204:.github/scripts/b25-stage2b-lib.sh > "$T17/old-lib.sh"
git -C "$ROOT" show 6c367dbe2a5c0764594fd8f6ba90c46f9ebab204:.github/scripts/b25-stage2b-apply.sh > "$T17/old-apply.sh"
cat > "$T17/harness.sh" <<'H'
#!/bin/bash
# runs phase_stage2b_migrate_copy_verify of H_APPLY with H_LIB in a fresh process: every host reader is stubbed from the
# golden fact files, the product command is stubbed from the scenario's cp / vf facts, the lock functions are the REAL ones
set -uo pipefail
source "$H_PURGE"; source "$H_APPLYLIB"; source "$H_LIB"; source "$H_APPLY"
PHASE=stage2b-migrate-copy-verify
log() { echo "LOG: $*"; }
fail() { echo "FAIL: $*"; exit 1; }
section() { echo "## $*"; }
stage2a_readonly_guard() { echo "read-only guard: stubbed"; }
stage2b_sections() { :; }
stage2b_print() { :; }
stage2b_image_ensure() { :; }
stage2b_image_facts() { printf '%s\n' image_present=true image_commit_ok=true; }
stage2b_facts() { local f="$H_T/pre.facts"; [ -e "$H_T/copied" ] && f="$H_T/post.facts"; grep -vE '^(s2b_lock_|image_)' "$f"; printf '%s\n' image_present=true image_commit_ok=true; stage2b_lock_facts; }
stage2b_dryrun_facts() { cat "$H_T/dr.facts"; }
stage2b_cli_run() {
  case "$1" in
    copy) : > "$H_T/copied"
          case "$H_SCEN" in replaced) printf 'foreign=1\n' > "$(stage2b_lock_file)" ;; vanished) rm -f "$(stage2b_lock_file)" ;; esac
          cat "$H_T/$H_CP" ;;
    verify) cat "$H_T/$H_VF" ;;
  esac
}
phase_stage2b_migrate_copy_verify
H
lockrun() {   # <lib> <apply> <scenario> <cp facts> <vf facts> [pre-existing: content | SYMLINK] → "rc= verdict= absent= content= copied= cond1="
  local lib="$1" apply="$2" scen="$3" cpf="$4" vff="$5" pre="${6:-}" H out rc lock verdict content absent c1
  H="$(mktemp -d)"; rm -f "$T17/copied"; lock="$H/$S2B_LOCK_NAME"
  if [ "$pre" = SYMLINK ]; then ln -s "$H/nowhere" "$lock"; elif [ -n "$pre" ]; then ( umask 077; printf '%s\n' "$pre" > "$lock" ); fi
  out="$(cd "$T17" && HOME="$H" H_T="$T17" H_PURGE="$HERE/b25-stage1-purge-lib.sh" H_APPLYLIB="$HERE/b25-stage1-apply-lib.sh" H_LIB="$lib" H_APPLY="$apply" H_SCEN="$scen" H_CP="$cpf" H_VF="$vff" bash "$T17/harness.sh" 2>&1)"; rc=$?
  verdict="$(printf '%s\n' "$out" | grep -oE '^B25_STAGE2B_COPY_VERIFIED=(TRUE|FALSE)$' | tail -1 | cut -d= -f2)"; [ -n "$verdict" ] || verdict=none
  c1="$(printf '%s\n' "$out" | grep -E '^stage2b 1: ' | tail -1 | sed -E 's/^.* — (OK|FAIL) \(.*$/\1/')"; [ -n "$c1" ] || c1=none
  if [ -e "$lock" ] || [ -L "$lock" ]; then absent=false; if grep -qE '^started_at=[0-9T:Z-]+ product=[0-9a-f]{40} token=[0-9a-f]{32}$' "$lock" 2>/dev/null; then content=own; else content=foreign; fi; else absent=true; content=none; fi
  echo "rc=$rc verdict=$verdict absent=$absent content=$content copied=$([ -e "$T17/copied" ] && echo yes || echo no) cond1=$c1"
  printf '%s\n' "$out" > "$T17/last.out"; rm -rf "$H"
}
check "the 6c367dbe defect REPRODUCED on its own library + phase: a fully successful copy + verify still ends with B25_STAGE2B_COPY_VERIFIED=FALSE — the post-copy facts carried s2b_lock_absent=false (captured while the lock existed) and condition 1 demanded true; the lock had already been removed unconditionally (no review marker left)" "$(lockrun "$T17/old-lib.sh" "$T17/old-apply.sh" ok cp-ok.facts vf-ok.facts)|$(grep -E '^stage2b 1: ' "$T17/last.out" | grep -c 's2b_lock_absent=false')" "rc=1 verdict=FALSE absent=true content=none copied=yes cond1=FAIL|1"
check "B / D. corrected lifecycle: no pre-existing lock → the phase creates its own lock exclusively, copy + verify run, the verdict is evaluated while the lock is held (condition 1 OK: present and owned) → TRUE → the lock is released only then, and the release is logged" "$(lockrun "$S2BLIB" "$S2BAPPLY" ok cp-ok.facts vf-ok.facts)|$(grep -c 'copy lock released' "$T17/last.out")|$(grep -E '^stage2b 1: ' "$T17/last.out" | tail -1 | grep -c 's2b_lock_absent=false s2b_lock_owned=true')" "rc=0 verdict=TRUE absent=true content=none copied=yes cond1=OK|1|1"
check "A. a pre-existing (foreign) lock → FAIL CLOSED before the preflight; nothing copied; the foreign lock untouched" "$(lockrun "$S2BLIB" "$S2BAPPLY" ok cp-ok.facts vf-ok.facts 'foreign=1')|$(grep -c 'copy lock is present' "$T17/last.out")" "rc=1 verdict=none absent=false content=foreign copied=no cond1=none|1"
check "A. a pre-existing lock that is a dangling symlink → FAIL CLOSED before the preflight; nothing copied; the entry untouched" "$(lockrun "$S2BLIB" "$S2BAPPLY" ok cp-ok.facts vf-ok.facts SYMLINK)" "rc=1 verdict=none absent=false content=foreign copied=no cond1=none"
check "E. a failed copy (a failed item) → verdict FALSE; the own lock RETAINED as the review marker; the message says so" "$(lockrun "$S2BLIB" "$S2BAPPLY" ok cp-failed.facts vf-ok.facts)|$(grep -c 'copy lock is RETAINED' "$T17/last.out")" "rc=1 verdict=FALSE absent=false content=own copied=yes cond1=OK|1"
check "E. a partial copy (copied ≠ the preflight candidates) → verdict FALSE; lock RETAINED" "$(lockrun "$S2BLIB" "$S2BAPPLY" ok cp-partial.facts vf-ok.facts)" "rc=1 verdict=FALSE absent=false content=own copied=yes cond1=OK"
check "E. a failed post-copy verification (checksum mismatch) → verdict FALSE; lock RETAINED" "$(lockrun "$S2BLIB" "$S2BAPPLY" ok cp-ok.facts vf-mismatch.facts)" "rc=1 verdict=FALSE absent=false content=own copied=yes cond1=OK"
check "C. incorrect lock ownership (the lock replaced by a foreign actor during the copy) → condition 1 FAIL (present, not owned) → verdict FALSE; the foreign lock is NOT removed" "$(lockrun "$S2BLIB" "$S2BAPPLY" replaced cp-ok.facts vf-ok.facts)" "rc=1 verdict=FALSE absent=false content=foreign copied=yes cond1=FAIL"
check "stale lock facts: the lock vanished during the copy → condition 1 FAIL (the copy form requires its own lock present) → verdict FALSE; nothing recreated" "$(lockrun "$S2BLIB" "$S2BAPPLY" vanished cp-ok.facts vf-ok.facts)" "rc=1 verdict=FALSE absent=true content=none copied=yes cond1=FAIL"
check "F / G. after a retained lock every mode fails closed: a second copy attempt on the retained lock → FAIL CLOSED before the preflight (nothing copied); the read-only forms reject the lock (condition 1)" "$( ( umask 077; printf 'started_at=2026-10-23T00:00:00Z product=%s token=%s\n' "$STAGE2B_PRODUCT_SHA" 0123456789abcdef0123456789abcdef > "$T17/retained" ); lockrun "$S2BLIB" "$S2BAPPLY" ok cp-ok.facts vf-ok.facts "$(cat "$T17/retained")")|$(s2bgolden | sed -E 's/^s2b_lock_absent=true/s2b_lock_absent=false/' | stage2b_eligibility preflight | mark B25_STAGE2B_PREFLIGHT_READY)|$(s2bpv | sed -E 's/^s2b_lock_absent=true/s2b_lock_absent=false/' | stage2b_eligibility postverify | mark B25_STAGE2B_POSTVERIFY_READY)" "rc=1 verdict=none absent=false content=own copied=no cond1=none|FALSE|FALSE"
echo "== Stage 2B — batch 17: the object volume mount — read-only for --dry-run / --verify, read-write for --copy (the REAL wrapper with a recording docker stub)"
cat > "$T17/mount.sh" <<'H'
#!/bin/bash
set -uo pipefail
source "$H_PURGE"; source "$H_APPLYLIB"; source "$H_LIB"; source "$H_APPLY"
fail() { echo "FAIL: $*"; exit 1; }
ENV_FILE="$H_T/env"; printf 'GCS_CREDENTIAL_GID=1234\n' > "$ENV_FILE"
: > "$H_T/gcs-service-account.json"
compose() { case "$1" in ps) echo cid0 ;; config) echo "        source: $H_T/gcs-service-account.json" ;; esac; }
docker() { case "$1" in inspect) echo netx ;; run) printf '%s\n' "$@" > "$H_T/argv"; echo '{}'; echo "__S2B_EXIT=0" ;; esac; }
stage2b_cli "$1" >/dev/null || true
# STAGE2A_VOLUME is the Stage 2A library's readonly constant (the named volume); printed here as VOL
printf '%s ' "$(grep -E "^${STAGE2A_VOLUME}:/data/objects" "$H_T/argv" | sed "s#^${STAGE2A_VOLUME}:#VOL:#" | tr '\n' ' ' | sed 's/ $//')" "$(grep -cE "^${STAGE2A_VOLUME}:/data/objects$" "$H_T/argv")" "$(grep -cE 'gcs-service-account\.json:ro$' "$H_T/argv")" "$(grep -cE '^--rm$' "$H_T/argv")" "$(grep -cE '^--user$' "$H_T/argv")"
H
mnt() { ( cd "$T17" && rm -f "$T17/argv" && H_T="$T17" H_PURGE="$HERE/b25-stage1-purge-lib.sh" H_APPLYLIB="$HERE/b25-stage1-apply-lib.sh" H_LIB="$S2BLIB" H_APPLY="$S2BAPPLY" bash "$T17/mount.sh" "$1" 2>/dev/null ); }
check "12. --dry-run → the named object volume mounted :ro (no mode-less, writable mount obtainable); credential :ro; one-off --rm; runtime --user" "$(mnt dry-run)" "VOL:/data/objects:ro 0 1 1 1 "
check "12. --verify → the named object volume mounted :ro" "$(mnt verify)" "VOL:/data/objects:ro 0 1 1 1 "
check "12. --copy → the named object volume mounted :rw (the only mutating mode)" "$(mnt copy)" "VOL:/data/objects:rw 0 1 1 1 "
check "12. an unknown mode is refused before any container runs" "$(mnt teleport >/dev/null; [ -e "$T17/argv" ] && echo ran || echo refused)" "refused"
rm -rf "$T17"
echo "== Stage 2B — statics: phases, the CLI wrapper, the dispatch hook, the Stage 2A libraries unchanged, the workflow"
check "the four phases exist and dispatch; every phase starts with the read-only guard; the read-only phases never invoke the copy; the copy is invoked exactly once (copy phase) after preflight + dry-run, behind a lock written exclusively before it and released only after the TRUE copy verdict (no unconditional removal)" "$(body stage2b_dispatch | grep -c 'phase_stage2b_')|$(for f in phase_stage2b_preflight phase_stage2b_migrate_dry_run phase_stage2b_migrate_copy_verify phase_stage2b_postverify; do body $f | grep -c 'stage2a_readonly_guard'; done | tr '\n' ',')|$({ body phase_stage2b_preflight; body phase_stage2b_migrate_dry_run; body phase_stage2b_postverify; body stage2b_facts; body stage2b_class_facts; body stage2b_dryrun_facts; } | grep -cE 'stage2b_cli(_run)? copy|stage2b_lock_(write|release)' || true)|$(grep -c 'stage2b_cli_run copy cp' "$S2BAPPLY")|$(body phase_stage2b_migrate_copy_verify | grep -oE 'stage2b_evaluate preflight|stage2b_evaluate dryrun|stage2b_lock_write "\$lock"|stage2b_cli_run copy cp|stage2b_cli_run verify vf|stage2b_evaluate copy|stage2b_lock_release "\$lock"' | tr '\n' ';')|$(body phase_stage2b_migrate_copy_verify | grep -c 'rm -f "$lock"' || true)|$(body phase_stage2b_migrate_copy_verify | awk '/if stage2b_evaluate copy "\$facts"; then/{on=1} on{print} on&&/^  else$/{exit}' | grep -c 'stage2b_lock_release "$lock"')" "4|1,1,1,1,|0|1|stage2b_evaluate preflight;stage2b_evaluate dryrun;stage2b_lock_write \"\$lock\";stage2b_cli_run copy cp;stage2b_cli_run verify vf;stage2b_evaluate copy;stage2b_lock_release \"\$lock\";|0|1"
check "the lock helpers: exclusive creation (noclobber) with a 32-hex random token held in memory only, ownership = own regular non-symlink 0600 file with the exact record, release refuses a non-owned lock before any rm; the facts reader emits both booleans; the pre-check refuses a symlink" "$(body stage2b_lock_write | grep -c 'set -C')|$(body stage2b_lock_write | grep -c '\[\[ "$tok" =~ ^\[0-9a-f\]{32}$ \]\] || fail')|$(body stage2b_lock_owned | grep -c '"600:$(id -u)"')|$(body stage2b_lock_owned | grep -c '\[ ! -L "$l" \]')|$(body stage2b_lock_release | awk '/stage2b_lock_owned "\$l" \|\| fail/{a=NR} /rm -f "\$l"/{b=NR} END {print (a && b && a < b) ? "owned-before-rm" : "bad"}')|$(body stage2b_lock_facts | grep -c 's2b_lock_owned=')|$(body phase_stage2b_migrate_copy_verify | grep -c '\[ ! -e "$lock" \] && \[ ! -L "$lock" \] || fail')|$(grep -cE 'echo .*(S2B_LOCK_EXPECT|\$tok)' "$S2BAPPLY" || true)" "1|1|1|1|owned-before-rm|1|1|0"
check "the CLI wrapper: one-off --rm container of the migrate image, the compose network, the api env file read inside the container only, the api runtime uid/gid, the credential group, the object volume with an explicit per-mode access (ro for dry-run / verify, rw for copy only), the credential mounted read-only, stdin closed, the summary file inside the container; the copy arguments are bounded and never carry a delete / legacy-delete flag; dry-run and verify pass only their own flag" "$(body stage2b_cli | grep -c 'docker run --rm --network "$pg_net" --env-file "$ENV_FILE" -e HOME=/tmp -e NODE_ENV=production --user "$S2B_RUNTIME_UID_GID" --group-add "$gid" -v "${STAGE2A_VOLUME}:/data/objects:$vmode" -v "$cred:/secrets/gcs-service-account.json:ro" --entrypoint sh "$(stage2b_image_tag)"')|$(body stage2b_cli | grep -c '</dev/null')|$(body stage2b_cli | grep -c 'args="--copy --concurrency $S2B_COPY_CONCURRENCY --batch $S2B_COPY_BATCH --recheck"; vmode=rw')|$(body stage2b_cli | grep -c 'args="--dry-run"; vmode=ro')|$(body stage2b_cli | grep -c 'args="--verify"; vmode=ro')|$(body stage2b_cli | grep -c 'vmode=rw')|$(body stage2b_cli | grep -cE 'delete|rm -rf|gsutil' || true)|$(body stage2b_cli | grep -c 'pnpm --filter @workspace/api-server run migrate-storage -- $args --out /tmp/b25-s2b-summary.json')" "1|1|1|1|1|1|0|1"
check "the image is built only from the clean app checkout at the product commit and labelled with it; the summary parser runs inside the api container over stdin; the facts never print a key, a path or a bucket (readers emit counts, booleans and md5 digests only)" "$(body stage2b_image_ensure | grep -c 'rev-parse HEAD)" = "$STAGE2B_PRODUCT_SHA"')|$(body stage2b_image_ensure | grep -c -- '--label "$S2B_IMAGE_LABEL=$STAGE2B_PRODUCT_SHA"')|$(body stage2b_summary_facts | grep -c 'api_node_stdin "$STAGE2B_SUMMARY_JS"')|$(body stage2b_class_facts | grep -cE 'echo "[a-z_]+=\$\(q "select (so\.storage_key|so\.legacy_key|so\.mirror_key)' || true)|$(body stage2b_sections | grep -cE "storage_key|legacy_key|mirror_key" || true)" "1|1|1|0|0"
check "the Stage 2A dispatch hook is exactly one line and routes only stage2b-* phases; apply.sh otherwise equals the pinned Stage 2A ops commit; purge-lib and apply-lib are byte-identical to it" "$(grep -c '^  stage2b-\*) stage2b_dispatch "\$PHASE" ;;$' "$APPLY")|$(cd "$ROOT" && git diff "$STAGE2B_STAGE2A_OPS_SHA" HEAD -- .github/scripts/b25-stage1-apply.sh | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | tr '\n' '~')|$(cd "$ROOT" && git diff --quiet "$STAGE2B_STAGE2A_OPS_SHA" HEAD -- .github/scripts/b25-stage1-purge-lib.sh .github/scripts/b25-stage1-apply-lib.sh && echo identical)" "1|+  stage2b-*) stage2b_dispatch \"\$PHASE\" ;;~|identical"
check "the Correction 5 live-row predicate (streamed unchanged) keeps its smoke-tenant exclusion; the Stage 2A post-switch evaluator still has 23 conditions and its Stage 2A product pin" "$(abody stage2a_live_row_sql | grep -c "lc.name not like 'B25 SMOKE %'")|$(awk -v f="stage2a_postswitch_eligibility" '$0 ~ "^"f"\\(\\) \\{" {on=1} on {print} on && /^}$/ {exit}' "$LIB" | grep -c '  cond "')|$(grep -c '^readonly STAGE2A_PRODUCT_SHA="e559b0024b28d4a77becdcb10c4168004dddea75"' "$LIB")" "1|23|1"
check "workflow: the four modes only (no Stage 2A mode), the job pinned to this branch, read-only modes refuse every confirmation, the copy requires the Stage 2B product commit + the window + COPY_B25_STAGE2B_LEGACY_TO_FS, one SSH step per mode with no ARG requiring its marker, the stream order purge-lib → apply-lib → stage2b-lib → stage2b-apply → stage1-apply, logs removed, BASE_SHA = STAGE2B_PRODUCT_SHA = the library pin, STAGE2A_OPS_SHA = the library pin, no awk | grep -q pipeline, the backup-health step gates the copy only" "$(grep -c 'options: \[stage2b_preflight, stage2b_migrate_dry_run, stage2b_migrate_copy_verify, stage2b_postverify\]' "$WF")|$(grep -cE 'stage2a_(precheck|activate|smoke|rollback|residue)' "$WF" || true)|$(grep -c "if: github.ref == 'refs/heads/ops/b25-stage2b-migration-tooling' && github.event_name == 'workflow_dispatch'" "$WF")|$(awk '/^            stage2b_preflight\|stage2b_migrate_dry_run\|stage2b_postverify\)$/{on=1;next} on&&/;;$/{print;exit} on{print}' "$WF" | grep -oE 'empty confirm_[a-z0-9_]+' | sort -u | wc -l | tr -d ' ')|$(awk '/^            stage2b_migrate_copy_verify\)$/{on=1;next} on&&/;;$/{print;exit} on{print}' "$WF" | grep -oE 'need confirm_[a-z0-9_]+ "\$IN_[A-Z0-9_]+" "\$[A-Z0-9_]+"' | sort -u | tr '\n' ';')|$(for m in stage2b-preflight stage2b-migrate-dry-run stage2b-migrate-copy-verify stage2b-postverify; do grep -c "PHASE='$m' bash -s\" < <(cat .github/scripts/b25-stage1-purge-lib.sh .github/scripts/b25-stage1-apply-lib.sh .github/scripts/b25-stage2b-lib.sh .github/scripts/b25-stage2b-apply.sh .github/scripts/b25-stage1-apply.sh)" "$WF"; done | tr '\n' ',')|$(grep -E "PHASE='stage2b-" "$WF" | grep -c 'ARG' || true)|$(for mk in B25_STAGE2B_PREFLIGHT_READY B25_STAGE2B_DRY_RUN_REPORTED B25_STAGE2B_COPY_VERIFIED B25_STAGE2B_POSTVERIFY_READY; do grep -c "grep -qx '$mk=TRUE'" "$WF"; done | tr '\n' ',')|$(grep -c 'stage2b-copy.log' "$WF")|$(grep -c "^  BASE_SHA: $STAGE2B_PRODUCT_SHA$" "$WF")|$(grep -c "^  STAGE2B_PRODUCT_SHA: $STAGE2B_PRODUCT_SHA$" "$WF")|$(grep -c "^  STAGE2A_OPS_SHA: $STAGE2B_STAGE2A_OPS_SHA$" "$WF")|$(grep -cE "awk '[^']*' [^|<]*\| grep -q" "$WF" || true)|$(grep -c "if: inputs.mode == 'stage2b_migrate_copy_verify'" "$WF")" "1|0|1|3|need confirm_product_sha \"\$IN_PRODUCT_SHA\" \"\$STAGE2B_PRODUCT_SHA\";need confirm_stage2b \"\$IN_STAGE2B\" \"\$REQUIRED_STAGE2B\";need confirm_window \"\$IN_WINDOW\" \"\$REQUIRED_WINDOW\";|1,1,1,1,|0|1,1,1,1,|3|1|1|1|0|2"
check "the real hosted branch-guard step (extracted from the workflow; BASE_SHA / STAGE2A_OPS_SHA / STAGE2B_PRODUCT_SHA from the workflow env) passes on this tree 10 / 10 times under its own set -euo pipefail" "$(G="$(mktemp)"; awk '/- name: Guard — branch content/{g=1} g&&/^        run: \|$/{on=1;next} on&&/^      - name:/{exit} on{print}' "$WF" | sed 's/^          //' > "$G"; f=0; for i in $(seq 1 10); do T="$(mktemp -d)"; (cd "$ROOT" && env BASE_SHA="$STAGE2B_PRODUCT_SHA" STAGE2A_OPS_SHA="$STAGE2B_STAGE2A_OPS_SHA" STAGE2B_PRODUCT_SHA="$STAGE2B_PRODUCT_SHA" RUNNER_TEMP="$T" bash -e "$G" >/dev/null 2>&1) || f=$((f + 1)); rm -rf "$T"; done; rm -f "$G"; echo "$f")" "0"
echo; echo "stage2b tests: $pass passed, $failn failed"
[ "$failn" = "0" ]
