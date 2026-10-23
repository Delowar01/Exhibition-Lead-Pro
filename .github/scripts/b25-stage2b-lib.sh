#!/bin/bash
# =============================================================================
# B25 STAGE 2B — legacy bucket → encrypted filesystem migration tooling: CONTRACT LIBRARY
# (ops/b25-stage2b-migration-tooling; streamed over SSH stdin after b25-stage1-purge-lib.sh and b25-stage1-apply-lib.sh
# and BEFORE b25-stage2b-apply.sh / b25-stage1-apply.sh; never written to the VPS filesystem).
#
# The two-class protected model (design §6): every storage row outside the Stage 1 exception is EXACTLY one of
#   FS_NATIVE_MIRRORED                 the unchanged Correction 5 live predicate (stage2a_live_row_sql, apply.sh) — never weakened here
#   FS_MIGRATED_WITH_RETAINED_LEGACY   written by `migrate-storage --copy`: driver fs, legacy_key RETAINED (the rollback copy),
#                                      NO mirror, canonical key, the UNCHANGED legacy-shaped feature reference
#   LEGACY_GCS_SOURCE                  registered by --copy, not yet copied (driver gcs + legacy_key; transient inside one run)
#   MIGRATION_FAILED_OR_UNPROVEN       anything else (fail closed; never repaired by the tooling)
# plus the two row-less states LEGACY_UNREGISTERED (a legacy-shaped feature reference without an inventory row — today's
# four export originals) and MIGRATION_PENDING (= unregistered ∪ legacy source: nothing copied yet).
# Constants only: no input, secret or environment value selects a row, a key, a bucket or a path. Nothing here deletes.
# =============================================================================
# the Stage 2B product commit = the approved mobile R1/R2 head (develop after its authorized fast-forward); the branch guard
# compares this line verbatim with the workflow pin, so it carries no trailing comment
readonly STAGE2B_PRODUCT_SHA="6a8dad1fe161dc1b31041794e5e3532e9f13327c"
# the Stage 2A ops commit whose libraries this branch streams unchanged (guard + tests); compared verbatim as well
readonly STAGE2B_STAGE2A_OPS_SHA="66807b5b67c4a6471e85b42306730b5a4a80d5c3"
readonly S2B_BASE_SCHEMA_FINGERPRINT="30c4ecbd867cd2cd59abcb58581ecb04"
readonly S2B_BASE_NATIVE_ROWS=2             # protected native rows recorded unchanged by every hosted read-only run since 2026-10-22
readonly S2B_BASE_CANDIDATES=4              # the four export originals (LEGACY_UNREGISTERED before the first copy)
readonly S2B_BASE_CENSUS_MD5="b7c8dd371c7d7e076f05ae8f69fc44e2"   # bucket inventory digest: the copy writes NO bucket object, so it must not move
readonly S2B_HEADROOM_BYTES=268435456       # 256 MiB
readonly S2B_CAPACITY_FACTOR=2
readonly S2B_IMAGE_REPO="cardscanner/migrate"
readonly S2B_IMAGE_LABEL="b25.stage2b.commit"
readonly S2B_LOCK_NAME=".b25-stage2b-copy.lock"
readonly S2B_RUNTIME_UID_GID="999:999"      # the api runtime user that owns the encrypted files (= STAGE2A_ROOT_OWNER)
readonly S2B_COPY_CONCURRENCY=2
readonly S2B_COPY_BATCH=50
readonly S2B_STATES="FS_NATIVE_MIRRORED FS_MIGRATED_WITH_RETAINED_LEGACY LEGACY_GCS_SOURCE LEGACY_UNREGISTERED MIGRATION_PENDING MIGRATION_FAILED_OR_UNPROVEN"
# textual rollback boundary: the branch guard and the tests refuse these in every Stage 2B file (the regex line itself excepted)
readonly S2B_FORBIDDEN_RE='OBJECT_STORAGE_LEGACY_DELETE=true|--legacy-delete|gsutil rm|objects\.delete|bucket\.delete|OBJECT_STORAGE_LEGACY_FALLBACK=false|OBJECT_STORAGE_MIRROR=none|--rollback|stage2a_env_render|stage2a_env_apply'
s2b_constants_ok() {
  [[ "$STAGE2B_PRODUCT_SHA" =~ ^[0-9a-f]{40}$ ]] && [[ "$STAGE2B_STAGE2A_OPS_SHA" =~ ^[0-9a-f]{40}$ ]] \
    && [ "$STAGE2B_PRODUCT_SHA" != "${STAGE2A_PRODUCT_SHA:-}" ] && [[ "$S2B_BASE_SCHEMA_FINGERPRINT" =~ ^[0-9a-f]{32}$ ]] \
    && [[ "$S2B_BASE_CENSUS_MD5" =~ ^[0-9a-f]{32}$ ]] && [[ "$S2B_BASE_NATIVE_ROWS$S2B_BASE_CANDIDATES" =~ ^[0-9]+$ ]] \
    && [[ "$S2B_HEADROOM_BYTES" =~ ^[1-9][0-9]*$ ]] && [[ "$S2B_COPY_CONCURRENCY" =~ ^([1-9]|1[0-6])$ ]] && [[ "$S2B_COPY_BATCH" =~ ^[1-9][0-9]{0,3}$ ]]
}
: "${B25PHYS_UUID:=f048b5d4-b366-4227-857f-42b2589e54b7}"
: "${B25PHYS_COMPANY:=53}"
s2b_alias_ok() { [[ "${1:-}" =~ ^([a-z]+\.)?$ ]]; }
# the real-tenant / hygiene core shared by every live class (the Correction 5 core without the location rules)
s2b_core_sql() {
  local a="${1:-}"; s2b_alias_ok "$a" || { echo "s2b_core_sql: prefix malformed" >&2; return 1; }
  printf '%s' "(${a}state = 'active' and ${a}deleted_at is null and ${a}last_error is null and ${a}publication_uncertain_at is null and ${a}lease_token is null and ${a}lease_expires_at is null and ${a}sha256 ~ '^[0-9a-f]{64}\$' and ${a}size_bytes > 0 and coalesce(${a}content_type, '') <> '' and ${a}id <> '$B25PHYS_UUID' and ${a}company_id <> $B25PHYS_COMPANY and exists (select 1 from companies lc where lc.id = ${a}company_id and lc.name not like 'B25 SMOKE %'))"
}
s2b_canonical_key_sql() {   # keys.ts: tenants/<cid>/<kind dir>/<id>[.<ext>]
  local a="${1:-}"; s2b_alias_ok "$a" || return 1
  printf '%s' "(${a}storage_key ~ ('^tenants/' || ${a}company_id || '/(documents|exports|reports|scans|branding)/'))"
}
s2b_native_sql() {   # CLASS 1 — unchanged Correction 5 shape (no legacy location; canonical ok mirror)
  local a="${1:-}"; s2b_alias_ok "$a" || return 1
  printf '%s' "($(s2b_core_sql "$a") and ${a}driver = 'fs' and ${a}legacy_key is null and ${a}mirror_key is not null and ${a}mirror_key = 'gs://' || split_part(split_part(${a}mirror_key, '://', 2), '/', 1) || '/' || ${a}storage_key and ${a}mirror_state = 'ok' and $(s2b_canonical_key_sql "$a"))"
}
s2b_migrated_sql() {   # CLASS 2 — fs + retained legacy_key + NO mirror + canonical key + the preserved legacy-shaped reference (never a native handle)
  local a="${1:-}"; s2b_alias_ok "$a" || return 1
  printf '%s' "($(s2b_core_sql "$a") and ${a}driver = 'fs' and ${a}legacy_key is not null and ${a}legacy_key ~ '^gs://[^/]+/.+' and ${a}mirror_key is null and ${a}mirror_state is null and $(s2b_canonical_key_sql "$a") and ${a}reference !~ '^/objects/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\$')"
}
s2b_legacy_source_sql() {   # registered by --copy (driver gcs, legacy_key set) but not yet copied
  local a="${1:-}"; s2b_alias_ok "$a" || return 1
  printf '%s' "(${a}state = 'active' and ${a}deleted_at is null and ${a}driver = 'gcs' and ${a}legacy_key is not null and ${a}legacy_key ~ '^gs://[^/]+/.+' and ${a}mirror_key is null and ${a}mirror_state is null and ${a}id <> '$B25PHYS_UUID' and ${a}company_id <> $B25PHYS_COMPANY and $(s2b_canonical_key_sql "$a"))"
}
s2b_duplicate_legacy_sql() {   # one legacy object claimed by two rows (any company) — never migrated
  local a="${1:-}"; s2b_alias_ok "$a" || return 1
  printf '%s' "(${a}legacy_key is not null and (select count(*) from storage_objects d where d.legacy_key = ${a}legacy_key and d.state <> 'deleted') > 1)"
}
s2b_smoke_row_sql() {   # a row of a disposable smoke tenant — counted separately, never a class member
  local a="${1:-}"; s2b_alias_ok "$a" || return 1
  printf '%s' "(exists (select 1 from companies sc where sc.id = ${a}company_id and sc.name like 'B25 SMOKE %'))"
}
s2b_state_sql() {   # <row id> → SQL returning one state token for that row
  local id="$1"
  [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "s2b_state_sql: id malformed" >&2; return 1; }
  printf '%s' "select case when so.id = '$B25PHYS_UUID' then 'STAGE1_EXCEPTION' when $(s2b_duplicate_legacy_sql 'so.') then 'MIGRATION_FAILED_OR_UNPROVEN' when $(s2b_native_sql 'so.') then 'FS_NATIVE_MIRRORED' when $(s2b_migrated_sql 'so.') then 'FS_MIGRATED_WITH_RETAINED_LEGACY' when $(s2b_legacy_source_sql 'so.') then 'LEGACY_GCS_SOURCE' else 'MIGRATION_FAILED_OR_UNPROVEN' end from storage_objects so where so.id = '$id'"
}
# the inventory partition of the whole table (counts only): every row outside the exception is exactly one class or FAILED
s2b_partition_sql() {
  printf '%s' "select 's2b_total='||count(*)||E'\n'||'s2b_exception='||count(*) filter (where so.id = '$B25PHYS_UUID')||E'\n'||'s2b_native='||count(*) filter (where so.id <> '$B25PHYS_UUID' and not $(s2b_smoke_row_sql 'so.') and $(s2b_native_sql 'so.'))||E'\n'||'s2b_migrated='||count(*) filter (where so.id <> '$B25PHYS_UUID' and not $(s2b_smoke_row_sql 'so.') and not $(s2b_duplicate_legacy_sql 'so.') and $(s2b_migrated_sql 'so.'))||E'\n'||'s2b_legacy_source='||count(*) filter (where so.id <> '$B25PHYS_UUID' and not $(s2b_smoke_row_sql 'so.') and not $(s2b_duplicate_legacy_sql 'so.') and $(s2b_legacy_source_sql 'so.'))||E'\n'||'s2b_duplicates='||count(*) filter (where so.id <> '$B25PHYS_UUID' and $(s2b_duplicate_legacy_sql 'so.'))||E'\n'||'s2b_smoke_rows='||count(*) filter (where so.id <> '$B25PHYS_UUID' and $(s2b_smoke_row_sql 'so.'))||E'\n'||'s2b_failed='||(count(*) filter (where so.id <> '$B25PHYS_UUID' and not $(s2b_smoke_row_sql 'so.')) - count(*) filter (where so.id <> '$B25PHYS_UUID' and not $(s2b_smoke_row_sql 'so.') and $(s2b_native_sql 'so.')) - count(*) filter (where so.id <> '$B25PHYS_UUID' and not $(s2b_smoke_row_sql 'so.') and not $(s2b_duplicate_legacy_sql 'so.') and $(s2b_migrated_sql 'so.')) - count(*) filter (where so.id <> '$B25PHYS_UUID' and not $(s2b_smoke_row_sql 'so.') and not $(s2b_duplicate_legacy_sql 'so.') and $(s2b_legacy_source_sql 'so.'))) from storage_objects so"
}
# the complete legacy reference census over the five feature tables (the product's discovery set, migration-db.ts):
# legacy-shaped references only (native handles /objects/<uuid> are not candidates); each reference is classified by the
# inventory row it resolves to; the census is COMPLETE when unregistered + legacy source + migrated + native-resolved =
# total and nothing resolves to an unclassified row; duplicates are counted within one company (the product's grouping)
# and across companies (an ownership stop); the exception's company never contributes a candidate
S2B_LEGACY_HANDLE_RE='^/objects/uploads/[0-9a-f-]{36}$'
S2B_LEGACY_SCAN_RE='^scans/[0-9]+/[0-9]+\.jpg$'
S2B_LEGACY_LOGO_RE='^branding/[0-9]+/[0-9a-f]{32}\.(png|jpg|webp)$'
s2b_refs_cte() {
  printf '%s' "refs as (select 'document'::text kind, dv.company_id, dv.object_path ref from document_versions dv where dv.object_path ~ '$S2B_LEGACY_HANDLE_RE' union all select 'export', er.company_id, er.object_path from export_runs er where er.object_path ~ '$S2B_LEGACY_HANDLE_RE' union all select 'report', xr.company_id, xr.object_path from executive_reports xr where xr.object_path ~ '$S2B_LEGACY_HANDLE_RE' union all select 'scan_image', sc.company_id, sc.image_url from scans sc where sc.image_url ~ '$S2B_LEGACY_SCAN_RE' union all select 'branding_logo', c.id, c.brand_logo_key from companies c where c.brand_logo_key ~ '$S2B_LEGACY_LOGO_RE')"
}
s2b_census_sql() {
  local row="(select so.id from storage_objects so where so.company_id = r.company_id and so.kind = r.kind and so.reference = r.ref and so.state <> 'deleted' limit 1)"
  printf '%s' "with $(s2b_refs_cte) select 'census_total='||count(*)||E'\n'||'census_unregistered='||count(*) filter (where $row is null)||E'\n'||'census_legacy_source='||count(*) filter (where exists (select 1 from storage_objects so where so.id = $row and $(s2b_legacy_source_sql 'so.')))||E'\n'||'census_migrated='||count(*) filter (where exists (select 1 from storage_objects so where so.id = $row and $(s2b_migrated_sql 'so.')))||E'\n'||'census_native_resolved='||count(*) filter (where exists (select 1 from storage_objects so where so.id = $row and $(s2b_native_sql 'so.')))||E'\n'||'census_unclassified='||count(*) filter (where $row is not null and not exists (select 1 from storage_objects so where so.id = $row and ($(s2b_legacy_source_sql 'so.') or $(s2b_migrated_sql 'so.') or $(s2b_native_sql 'so.'))))||E'\n'||'census_dup_same_company='||(select count(*) from (select company_id, ref from refs group by company_id, ref having count(*) > 1) d)||E'\n'||'census_dup_cross_company='||(select count(*) from (select ref from refs group by ref having count(distinct company_id) > 1) d)||E'\n'||'census_exception_refs='||count(*) filter (where r.company_id = $B25PHYS_COMPANY)||E'\n'||'census_smoke_refs='||count(*) filter (where exists (select 1 from companies sc where sc.id = r.company_id and sc.name like 'B25 SMOKE %')) from refs r"
}
# candidate bytes for the capacity rule: the unregistered export originals carry a recorded size; any other unregistered
# candidate (no size column in its feature table) is counted as UNKNOWN and fails the capacity rule closed
s2b_candidate_bytes_sql() {
  local row="(select so.id from storage_objects so where so.company_id = r.company_id and so.kind = r.kind and so.reference = r.ref and so.state <> 'deleted' limit 1)"
  printf '%s' "with $(s2b_refs_cte) select 'cand_rows='||count(*)||E'\n'||'cand_bytes_known='||coalesce(sum(case when r.kind = 'export' then (select er.file_size from export_runs er where er.company_id = r.company_id and er.object_path = r.ref order by er.id limit 1) else null end), 0)||E'\n'||'cand_bytes_unknown_rows='||count(*) filter (where r.kind <> 'export' or (select er.file_size from export_runs er where er.company_id = r.company_id and er.object_path = r.ref order by er.id limit 1) is null) from refs r where $row is null"
}
s2b_unregistered_count_sql() { printf '%s' "with $(s2b_refs_cte) select count(*) from refs r where not exists (select 1 from storage_objects so where so.company_id = r.company_id and so.kind = r.kind and so.reference = r.ref and so.state <> 'deleted')"; }
s2b_protected_counts_sql() {   # [smoke uuid csv] → native= migrated= other= total= over every row outside the exception (and the recorded smoke rows)
  local csv="${1:-}" w="so.id <> '$B25PHYS_UUID'"
  if [ -n "$csv" ]; then [[ "$csv" =~ ^[0-9a-f-]{36}(,[0-9a-f-]{36})*$ ]] || { echo "s2b_protected_counts_sql: csv malformed" >&2; return 1; }; w="$w and so.id not in ('$(printf '%s' "$csv" | sed "s/,/','/g")')"; fi
  printf '%s' "select 'native='||count(*) filter (where $(s2b_native_sql 'so.'))||' migrated='||count(*) filter (where $(s2b_migrated_sql 'so.'))||' other='||(count(*) - count(*) filter (where $(s2b_native_sql 'so.')) - count(*) filter (where $(s2b_migrated_sql 'so.')))||' total='||count(*) from storage_objects so where $w"
}
s2b_migrated_acceptance_sql() {   # <row id> → the DB-visible acceptance facts of one migrated row (the file / source probes are host-side)
  local id="$1"; [[ "$id" =~ ^[0-9a-f-]{36}$ ]] || return 1
  printf '%s' "select 'shape_ok='||($(s2b_migrated_sql 'so.'))::text||' source_retained_shape='||coalesce(so.legacy_key ~ '^gs://[^/]+/.+', false)::text||' no_mirror='||(so.mirror_key is null and so.mirror_state is null)::text||' digest_ok='||coalesce(so.sha256 ~ '^[0-9a-f]{64}\$', false)::text||' size_ok='||(coalesce(so.size_bytes,0) > 0)::text||' tenant_ok='||(exists (select 1 from companies c where c.id = so.company_id and c.name not like 'B25 SMOKE %') and so.company_id <> $B25PHYS_COMPANY)::text||' reference_preserved='||(so.reference !~ '^/objects/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\$')::text||' association_ok='||(exists (select 1 from export_runs er where er.company_id = so.company_id and er.object_path = so.reference and er.status = 'completed') or exists (select 1 from document_versions dv where dv.company_id = so.company_id and dv.object_path = so.reference) or exists (select 1 from scans sc where sc.company_id = so.company_id and sc.image_url = so.reference) or exists (select 1 from executive_reports xr where xr.company_id = so.company_id and xr.object_path = so.reference) or exists (select 1 from companies bc where bc.id = so.company_id and bc.brand_logo_key = so.reference))::text||' not_duplicate='||(not $(s2b_duplicate_legacy_sql 'so.'))::text||' no_uncertainty='||(so.publication_uncertain_at is null and so.lease_token is null and so.last_error is null)::text||' not_exception='||(so.id <> '$B25PHYS_UUID')::text from storage_objects so where so.id = '$id'"
}
# the product's item statuses and their effect on the row (pure; the modeled tests and the design review)
s2b_transition() {   # <from state> <product mode> <item status> → "<to state>|<row change>|<bucket change>"
  local from="$1" mode="$2" st="$3"
  case "$from|$mode|$st" in
    "LEGACY_UNREGISTERED|dry-run|planned")            echo "LEGACY_UNREGISTERED|none|none" ;;
    "LEGACY_UNREGISTERED|copy|registered")            echo "LEGACY_GCS_SOURCE|row inserted (driver gcs, legacy_key)|none" ;;
    "LEGACY_GCS_SOURCE|copy|copied")                  echo "FS_MIGRATED_WITH_RETAINED_LEGACY|driver fs, sha256 + size_bytes set, legacy_key retained, mirror untouched (null)|none (source retained)" ;;
    "LEGACY_GCS_SOURCE|copy|missing_source")          echo "MIGRATION_FAILED_OR_UNPROVEN|none|none" ;;
    "LEGACY_GCS_SOURCE|copy|conflict")                echo "MIGRATION_FAILED_OR_UNPROVEN|none (foreign file never overwritten)|none" ;;
    "LEGACY_GCS_SOURCE|copy|checksum_mismatch")       echo "MIGRATION_PENDING|none (the tooling's own write removed at its attempt key)|none" ;;
    "LEGACY_GCS_SOURCE|copy|failed")                  echo "MIGRATION_FAILED_OR_UNPROVEN|none|none" ;;
    "LEGACY_GCS_SOURCE|dry-run|planned")              echo "LEGACY_GCS_SOURCE|none|none" ;;
    "LEGACY_GCS_SOURCE|verify|not_migrated")          echo "MIGRATION_PENDING|none|none" ;;
    "FS_MIGRATED_WITH_RETAINED_LEGACY|copy|already")  echo "FS_MIGRATED_WITH_RETAINED_LEGACY|none|none" ;;
    "FS_MIGRATED_WITH_RETAINED_LEGACY|verify|verified") echo "FS_MIGRATED_WITH_RETAINED_LEGACY|none|none" ;;
    "FS_MIGRATED_WITH_RETAINED_LEGACY|verify|checksum_mismatch") echo "MIGRATION_FAILED_OR_UNPROVEN|none|none" ;;
    "FS_MIGRATED_WITH_RETAINED_LEGACY|copy|missing_target") echo "MIGRATION_FAILED_OR_UNPROVEN|none in a read-only mode; a re-copy needs a new authorized copy mode|none" ;;
    "FS_NATIVE_MIRRORED|"*)                            echo "FS_NATIVE_MIRRORED|none (no legacy_key: never a candidate)|none" ;;
    "STAGE1_EXCEPTION|"*)                              echo "STAGE1_EXCEPTION|none (state deleted: skipped)|none" ;;
    "DUPLICATE_LEGACY|dry-run|duplicate")             echo "MIGRATION_FAILED_OR_UNPROVEN|none (run incomplete; copy blocked)|none" ;;
    "DUPLICATE_LEGACY|copy|"*)                         echo "MIGRATION_FAILED_OR_UNPROVEN|none (copy refused for the group)|none" ;;
    *) echo "UNDEFINED|refused|refused"; return 1 ;;
  esac
}
s2b_forbidden_present() {   # <files…> → true when a forbidden operation string appears outside the regex definition line
  grep -hvE '^readonly S2B_FORBIDDEN_RE=' "$@" | grep -qE "$S2B_FORBIDDEN_RE"
}
# ---- the summary of migrate-storage (sanitized JSON by product contract) → pure interpretation of its exit code --------
s2b_exit_meaning() {   # <exit code> → COMPLETE | INCOMPLETE | USAGE | UNKNOWN
  case "${1:-}" in 0) echo COMPLETE ;; 2) echo INCOMPLETE ;; 1) echo USAGE ;; *) echo UNKNOWN ;; esac
}
# =============================================================================================================
# stage2b_eligibility <preflight|dryrun|copy|postverify> — reads the k=v fact stream of stage2b-apply's readers, prints
# "stage2b N: … — OK|FAIL (…)" per condition and the markers; returns 0 like every Stage 2A evaluator (the markers carry
# the verdict; the phases gate on the TRUE marker). Facts never carry a key, a path, a bucket name or a content.
# =============================================================================================================
stage2b_eligibility() {
  local FORM="${1:-}"
  local -A f=()
  local line k v
  while IFS= read -r line; do
    [[ "$line" =~ ^([a-z0-9_]+)=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"; f[$k]="$v"
  done
  local failed=0 n=0
  g() { printf '%s' "${f[$1]:-<missing>}"; }
  is_true() { [ "$(g "$1")" = "true" ]; }
  is_false() { [ "$(g "$1")" = "false" ]; }
  is_zero() { [ "$(g "$1")" = "0" ]; }
  is_eq() { [ "$(g "$1")" = "$2" ]; }
  is_num() { [[ "$(g "$1")" =~ ^[0-9]+$ ]]; }
  cond() { n=$((n + 1)); if [ "$2" = "0" ]; then echo "stage2b $n: $1 — OK ($3)"; else echo "stage2b $n: $1 — FAIL ($3)"; failed=$((failed + 1)); fi; }
  local ok N M L U D F
  case "$FORM" in preflight|dryrun|copy|postverify) ;; *) echo "B25_STAGE2B_CONDITIONS_FAILED=1"; echo "B25_STAGE2B_FORM=UNKNOWN"; echo "B25_STAGE2B_PREFLIGHT_READY=FALSE"; echo "B25_STAGE2B_DRY_RUN_REPORTED=FALSE"; echo "B25_STAGE2B_COPY_VERIFIED=FALSE"; echo "B25_STAGE2B_POSTVERIFY_READY=FALSE"; return 0 ;; esac
  N="$(g s2b_native)"; M="$(g s2b_migrated)"; L="$(g s2b_legacy_source)"; U="$(g census_unregistered)"; D="$(g s2b_duplicates)"; F="$(g s2b_failed)"
  for x in N M L U D F; do [[ "${!x}" =~ ^[0-9]+$ ]] || eval "$x=-1"; done
  # 1 product / host
  ok=1; s2b_constants_ok && is_eq head_sha "$STAGE2B_PRODUCT_SHA" && is_eq current_deploy_sha "$STAGE2B_PRODUCT_SHA" && is_zero dirty && is_true lock_absent && is_true s2b_lock_absent && ok=0
  cond "product commit = $STAGE2B_PRODUCT_SHA (checkout and current-deploy.sha; clean; no Stage 2A activation lock, no Stage 2B copy lock; constants coherent)" $ok "head=$(g head_sha) current=$(g current_deploy_sha) dirty=$(g dirty) lock_absent=$(g lock_absent) s2b_lock_absent=$(g s2b_lock_absent) constants_ok=$(s2b_constants_ok && echo true || echo false)"
  # 2 runtime health
  ok=1; is_true api_running && is_eq api_health healthy && is_eq web_health healthy && is_eq pg_health healthy && is_eq readyz_status ok && is_eq readyz_database ok && is_eq readyz_storage ok && is_eq readyz_inside ok && ok=0
  cond "api / web / postgres healthy; readiness ok / database ok / storage ok (proxy and inside the container)" $ok "api=$(g api_running)/$(g api_health) web=$(g web_health) postgres=$(g pg_health) readyz=$(g readyz_status)/$(g readyz_database)/$(g readyz_storage)/$(g readyz_inside)"
  # 3 the five locked variables (fs primary, root, key, fallback, mirror) + legacy delete off + encryption configured
  ok=1; is_eq banner_driver fs && is_true banner_root_set && is_true banner_key_set && is_eq banner_fallback true && is_eq banner_mirror gcs && is_true init_record_found && is_eq init_driver fs && is_eq init_fallback true && is_eq init_mirror true && is_eq init_legacy_delete false && is_eq init_encryption configured \
    && is_true env_driver_is_fs && is_true env_root_is_locked && is_true env_fallback_is_true && is_true env_mirror_is_gcs && is_true env_legacy_delete_off && is_true env_key_set && is_true env_file_managed_ok && is_eq env_file_key_lines 1 && is_eq env_mode 600 && is_true env_core_identity_ok && ok=0
  cond "the Stage 2A activation set is unchanged: driver fs, root locked, key present (never printed), legacy fallback true, mirror gcs, legacy delete false, encryption configured — banner, startup record, container env and VPS env file agree" $ok "banner=$(g banner_driver)/$(g banner_root_set)/$(g banner_key_set)/$(g banner_fallback)/$(g banner_mirror) init=$(g init_record_found)/$(g init_driver)/$(g init_fallback)/$(g init_mirror)/$(g init_legacy_delete)/$(g init_encryption) env=$(g env_driver_is_fs)/$(g env_root_is_locked)/$(g env_fallback_is_true)/$(g env_mirror_is_gcs)/$(g env_legacy_delete_off)/$(g env_key_set) file=$(g env_file_managed_ok)/$(g env_file_key_lines)/$(g env_mode)/$(g env_core_identity_ok)"
  # 4 schema + jobs + counters
  ok=1; is_eq schema_fingerprint "$S2B_BASE_SCHEMA_FINGERPRINT" && is_zero storage_jobs_active && is_zero dead_jobs_total && is_zero log_mirror_failures && is_zero log_integrity_failures && is_zero log_init_failures && is_eq init_records_current 1 && is_zero log_refusals && ok=0
  cond "schema fingerprint $S2B_BASE_SCHEMA_FINGERPRINT; no active storage job, no dead job; mirror / integrity / initialization failures 0; storage initialized once; no start refusal" $ok "fingerprint=$(g schema_fingerprint) storage_jobs=$(g storage_jobs_active) dead_jobs=$(g dead_jobs_total) mirror_failures=$(g log_mirror_failures) integrity_failures=$(g log_integrity_failures) init_failures=$(g log_init_failures) init_records=$(g init_records_current) refusals=$(g log_refusals)"
  # 5 inventory partition: every row outside the exception is exactly one class; nothing failed, no smoke row, no duplicate
  ok=1; [ "$F" = 0 ] && [ "$D" = 0 ] && is_zero s2b_smoke_rows && is_eq s2b_exception 1 && is_eq s2b_total "$((1 + N + M + L))" && [ "$N" -ge 1 ] && is_zero inv_uncertain && is_zero inv_unproven && is_zero inv_cleanup_pending && is_zero inv_leases && is_zero inv_inflight && is_eq inv_retained_legacy 1 && ok=0
  cond "inventory partition: total = 1 exception + native N + migrated M + legacy source L; FAILED_OR_UNPROVEN 0, duplicates 0, smoke rows 0; nothing uncertain / unproven / cleanup-pending / leased / in flight" $ok "total=$(g s2b_total) exception=$(g s2b_exception) native=$N migrated=$M legacy_source=$L failed=$F duplicates=$D smoke_rows=$(g s2b_smoke_rows) uncertain=$(g inv_uncertain) unproven=$(g inv_unproven) cleanup_pending=$(g inv_cleanup_pending) leases=$(g inv_leases) inflight=$(g inv_inflight) retained=$(g inv_retained_legacy)"
  # 6 census complete + ownership
  ok=1; is_num census_total && is_eq census_total "$(( $(g census_unregistered 2>/dev/null | grep -E '^[0-9]+$' || echo 0) + $(g census_legacy_source | grep -E '^[0-9]+$' || echo 0) + $(g census_migrated | grep -E '^[0-9]+$' || echo 0) + $(g census_native_resolved | grep -E '^[0-9]+$' || echo 0) ))" && is_zero census_unclassified && is_zero census_dup_same_company && is_zero census_dup_cross_company && is_zero census_exception_refs && is_zero census_smoke_refs && is_eq census_legacy_source "$L" && is_eq census_migrated "$M" && ok=0
  cond "legacy reference census complete (unregistered + legacy source + migrated + native-resolved = total; nothing unclassified), no duplicate within a company, no reference claimed by two companies, no candidate of the exception's company or of a smoke tenant; the census agrees with the inventory classes" $ok "total=$(g census_total) unregistered=$U legacy_source=$(g census_legacy_source) migrated=$(g census_migrated) native_resolved=$(g census_native_resolved) unclassified=$(g census_unclassified) dup_same=$(g census_dup_same_company) dup_cross=$(g census_dup_cross_company) exception_refs=$(g census_exception_refs) smoke_refs=$(g census_smoke_refs)"
  # 7 capacity
  ok=1; is_num vol_free_bytes && is_num cand_bytes_known && is_zero cand_bytes_unknown_rows && is_eq cand_rows "$U" && [ "$(g vol_free_bytes)" -ge "$(( S2B_CAPACITY_FACTOR * $(g cand_bytes_known) + S2B_HEADROOM_BYTES ))" ] && ok=0
  cond "capacity: free bytes on the object volume ≥ $S2B_CAPACITY_FACTOR × the candidates' recorded sizes + $S2B_HEADROOM_BYTES; every candidate size known" $ok "free=$(g vol_free_bytes) candidates=$(g cand_rows) bytes_known=$(g cand_bytes_known) unknown_rows=$(g cand_bytes_unknown_rows)"
  # 8 native class proven (Stage 2A proofs over the native rows only)
  ok=1; is_eq nat_rows "$N" && is_eq nat_live_ok "$N" && is_eq nat_assoc_ok "$N" && is_true nat_pf_read_ok && is_eq nat_pf_present "$N" && is_eq nat_pf_regular "$N" && is_eq nat_pf_owner_ok "$N" && is_eq nat_pf_mode_ok "$N" && is_eq nat_pf_magic_ok "$N" && is_eq nat_pf_size_differs "$N" && is_true nat_pm_read_ok && is_eq nat_pm_present "$N" && is_eq nat_pm_bucket_ok "$N" && is_eq nat_pm_canonical_key "$N" && is_eq nat_pm_marker_ok "$N" && is_eq nat_pm_generation_ok "$N" && is_eq nat_pm_size_ok "$N" && is_eq nat_pm_sha_ok "$N" && ok=0
  cond "native class (unchanged Correction 5 proofs): every native row ownership- and association-proven, its encrypted file present (regular, runtime-owned, 0600, envelope magic, ciphertext size differs) and its mirror present (bucket, canonical key, marker, generation, size, digest)" $ok "rows=$(g nat_rows) live=$(g nat_live_ok) assoc=$(g nat_assoc_ok) file=$(g nat_pf_read_ok)/$(g nat_pf_present)/$(g nat_pf_regular)/$(g nat_pf_owner_ok)/$(g nat_pf_mode_ok)/$(g nat_pf_magic_ok)/$(g nat_pf_size_differs) mirror=$(g nat_pm_read_ok)/$(g nat_pm_present)/$(g nat_pm_bucket_ok)/$(g nat_pm_canonical_key)/$(g nat_pm_marker_ok)/$(g nat_pm_generation_ok)/$(g nat_pm_size_ok)/$(g nat_pm_sha_ok)"
  # 9 migrated class proven (Stage 2B proofs over the migrated rows only; trivially satisfied while M = 0)
  ok=1; is_eq mig_rows "$M" && is_eq mig_shape_ok "$M" && is_eq mig_assoc_ok "$M" && is_true mig_mf_read_ok && is_eq mig_mf_present "$M" && is_eq mig_mf_regular "$M" && is_eq mig_mf_owner_ok "$M" && is_eq mig_mf_mode_ok "$M" && is_eq mig_mf_magic_ok "$M" && is_eq mig_mf_size_differs "$M" && is_true mig_ms_read_ok && is_eq mig_ms_present "$M" && is_eq mig_ms_bucket_ok "$M" && is_eq mig_ms_size_ok "$M" && is_eq mig_ms_sha_ok "$M" && is_eq mig_ms_generation_ok "$M" && is_zero mig_ms_marked && ok=0
  cond "migrated class: every migrated row in the exact FS_MIGRATED_WITH_RETAINED_LEGACY shape and associated, its encrypted file present (regular, runtime-owned, 0600, envelope magic, ciphertext size differs) and its RETAINED legacy source present in the configured bucket (size and plaintext digest = the row, canonical generation, unmarked original)" $ok "rows=$(g mig_rows) shape=$(g mig_shape_ok) assoc=$(g mig_assoc_ok) file=$(g mig_mf_read_ok)/$(g mig_mf_present)/$(g mig_mf_regular)/$(g mig_mf_owner_ok)/$(g mig_mf_mode_ok)/$(g mig_mf_magic_ok)/$(g mig_mf_size_differs) source=$(g mig_ms_read_ok)/$(g mig_ms_present)/$(g mig_ms_bucket_ok)/$(g mig_ms_size_ok)/$(g mig_ms_sha_ok)/$(g mig_ms_generation_ok)/marked=$(g mig_ms_marked)"
  # 10 the volume holds exactly the native + migrated files
  ok=1; is_eq mount_type volume && is_true mount_rw && is_eq root_owner "${STAGE2A_ROOT_OWNER:-999:999}" && is_eq root_mode "${STAGE2A_ROOT_MODE:-700}" && is_false root_is_symlink && is_true root_is_dir && is_true root_writable && is_eq root_tenant_files "$((N + M))" && is_true root_entries_allowed && is_eq fs_tenant_files "$((N + M))" && is_zero fs_other_files && is_zero fs_symlinks && ok=0
  cond "filesystem root: the named volume, runtime-owned 0700 directory, writable, exactly N + M tenant files, no foreign entry, no symlink" $ok "type=$(g mount_type) rw=$(g mount_rw) owner=$(g root_owner) mode=$(g root_mode) symlink=$(g root_is_symlink) dir=$(g root_is_dir) writable=$(g root_writable) root_tenant_files=$(g root_tenant_files) entries_allowed=$(g root_entries_allowed) fs_tenant_files=$(g fs_tenant_files) other=$(g fs_other_files) symlinks=$(g fs_symlinks)"
  # 11 Stage 1 exception intact + never a candidate
  ok=1; is_eq exc_row_count 1 && is_eq exc_state deleted && is_eq exc_last_error LEGACY_RETAINED && is_eq exc_driver gcs && is_eq exc_company "$B25PHYS_COMPANY" && is_true exc_identity_ok && is_false exc_uncertain && is_false exc_lease && is_zero exc_live_refs && is_true exc_provider_present && is_true exc_provider_marker_ok && is_true exc_provider_size_matches && is_true exc_generation_canonical && is_true exc_generation_stable && is_eq exc_generation_digest "${B25PHYS_PRE_GEN_DIGEST:-3545c17e5f3aa940}" && ok=0
  cond "Stage 1 exception intact (deleted / LEGACY_RETAINED / gcs / company $B25PHYS_COMPANY; provider object present, marker, size, canonical stable generation with the proven digest) and never a candidate" $ok "rows=$(g exc_row_count) state=$(g exc_state) last_error=$(g exc_last_error) driver=$(g exc_driver) company=$(g exc_company) identity=$(g exc_identity_ok) uncertain=$(g exc_uncertain) lease=$(g exc_lease) live_refs=$(g exc_live_refs) provider=$(g exc_provider_present)/$(g exc_provider_marker_ok)/$(g exc_provider_size_matches)/$(g exc_generation_canonical)/$(g exc_generation_stable)/$(g exc_generation_digest)"
  # 12 bucket partition unchanged: the copy writes no bucket object and deletes none
  ok=1; is_eq census_objects "$((4 + 1 + N))" && is_eq census_marked "$((1 + N))" && is_eq census_generationless "${B25PHYS_CENSUS_GENERATIONLESS:-0}" && is_eq census_md5 "$S2B_BASE_CENSUS_MD5" && is_eq unmarked_objects 4 && is_eq unmarked_md5 "${B25PHYS_ORIGINALS_MD5:-c1b900fd509bafa1f980d863dc0d195b}" && is_eq originals_referenced 4 && is_eq originals_present 4 && is_zero originals_missing && is_eq originals_size_match 4 && is_eq refs_legacy_count 4 && is_zero refs_ambiguous && ok=0
  cond "bucket partition unchanged by Stage 2B: 4 unmarked originals (locked digest; referenced, present, size-matched) + 1 exception + N native mirrors, no object added or removed (locked inventory digest), legacy references 4 / ambiguous 0 (the feature references are never rewritten here)" $ok "objects=$(g census_objects) marked=$(g census_marked) generationless=$(g census_generationless) inventory_md5_equal=$([ "$(g census_md5)" = "$S2B_BASE_CENSUS_MD5" ] && echo true || echo false) unmarked=$(g unmarked_objects) originals_md5_equal=$([ "$(g unmarked_md5)" = "${B25PHYS_ORIGINALS_MD5:-c1b900fd509bafa1f980d863dc0d195b}" ] && echo true || echo false) originals=$(g originals_referenced)/$(g originals_present)/$(g originals_missing)/$(g originals_size_match) refs=$(g refs_legacy_count)/$(g refs_ambiguous)"
  # 13 no leak
  ok=1; is_zero leak_root_path && is_zero leak_key_shaped && is_zero leak_key_assignment && is_zero leak_bucket_ref && is_zero leak_signature && is_zero web_leak_root_path && is_zero web_leak_signature && is_zero s2b_output_leaks && ok=0
  cond "no plaintext storage path, key-shaped token, key assignment, bucket reference or signed-URL text in the api / web logs or in this mode's own output" $ok "api=$(g leak_root_path)/$(g leak_key_shaped)/$(g leak_key_assignment)/$(g leak_bucket_ref)/$(g leak_signature) web=$(g web_leak_root_path)/$(g web_leak_signature) mode_output=$(g s2b_output_leaks)"
  # 14 form-specific
  case "$FORM" in
    preflight)
      ok=1; [ "$L" = 0 ] && is_eq census_unregistered "$U" && [ "$U" -ge 0 ] && ok=0
      cond "preflight form: no transient legacy-source row (L = 0); candidates = the unregistered legacy references (reported, never selected by value)" $ok "legacy_source=$L candidates=$U migrated=$M native=$N image_present=$(g image_present) image_commit_ok=$(g image_commit_ok)" ;;
    dryrun)
      ok=1; is_true image_present && is_true image_commit_ok && is_true dr_parse_ok && is_eq dr_mode dry-run && is_eq dr_exit_meaning COMPLETE && is_true dr_complete && is_true dr_read_only && is_eq dr_target_root present && is_eq dr_planned "$((U + L))" && is_eq dr_already "$M" && is_zero dr_missing_source && is_zero dr_checksum_mismatch && is_zero dr_conflict && is_zero dr_duplicate && is_zero dr_failed && is_zero dr_duplicate_groups && is_zero dr_unattributable && is_zero dr_exception_listed && is_eq dr_source_references "$(g census_total)" && is_true dr_repeat_identical && is_true dr_inventory_unchanged && ok=0
      cond "dry-run form: the migrate image was built from this product commit; the product's --dry-run (read-only target, nothing written) ran twice with identical sanitized summaries: COMPLETE, planned = unregistered + legacy source, already = migrated, no missing source / mismatch / conflict / duplicate / failure / unattributable reference, the exception never listed, source references = the census; the inventory unchanged across the runs" $ok "image=$(g image_present)/$(g image_commit_ok) parse=$(g dr_parse_ok) mode=$(g dr_mode) exit=$(g dr_exit_meaning) complete=$(g dr_complete) read_only=$(g dr_read_only) target_root=$(g dr_target_root) planned=$(g dr_planned) already=$(g dr_already) missing=$(g dr_missing_source) mismatch=$(g dr_checksum_mismatch) conflict=$(g dr_conflict) duplicate=$(g dr_duplicate) failed=$(g dr_failed) dup_groups=$(g dr_duplicate_groups) unattributable=$(g dr_unattributable) exception_listed=$(g dr_exception_listed) source_refs=$(g dr_source_references) repeat_identical=$(g dr_repeat_identical) inventory_unchanged=$(g dr_inventory_unchanged)" ;;
    copy)
      ok=1; is_true image_present && is_true image_commit_ok && is_true cp_parse_ok && is_eq cp_mode copy && is_eq cp_exit_meaning COMPLETE && is_true cp_complete && is_eq cp_copied "$(g pre_candidates)" && is_eq cp_already "$(g pre_migrated)" && is_zero cp_missing_source && is_zero cp_checksum_mismatch && is_zero cp_conflict && is_zero cp_duplicate && is_zero cp_failed && is_zero cp_exception_listed \
        && is_true vf_parse_ok && is_eq vf_mode verify && is_eq vf_exit_meaning COMPLETE && is_true vf_complete && is_eq vf_verified "$M" && is_zero vf_unregistered && is_zero vf_not_migrated && is_zero vf_checksum_mismatch && is_zero vf_failed \
        && [ "$L" = 0 ] && [ "$U" = 0 ] && is_eq s2b_migrated "$(( $(g pre_migrated | grep -E '^[0-9]+$' || echo 0) + $(g pre_candidates | grep -E '^[0-9]+$' || echo 0) ))" && is_eq s2b_native "$(g pre_native)" && is_eq nat_keys_md5 "$(g pre_nat_keys_md5)" && is_eq nat_pf_cipher_md5 "$(g pre_nat_pf_cipher_md5)" && is_eq nat_pm_generations_md5 "$(g pre_nat_pm_generations_md5)" && is_eq census_md5 "$(g pre_census_md5)" && ok=0
      cond "copy form: --copy COMPLETE (copied = the preflight candidates, already = the previously migrated rows, nothing missing / mismatched / conflicting / duplicated / failed, the exception never listed) then --verify COMPLETE (verified = every migrated row, nothing unregistered / unmigrated / mismatched); afterwards L = 0, U = 0, migrated = before + candidates; the native class (keys, ciphertexts, mirror generations) and the bucket inventory digest identical to the preflight" $ok "image=$(g image_present)/$(g image_commit_ok) copy=$(g cp_parse_ok)/$(g cp_mode)/$(g cp_exit_meaning)/$(g cp_complete) copied=$(g cp_copied) already=$(g cp_already) missing=$(g cp_missing_source) mismatch=$(g cp_checksum_mismatch) conflict=$(g cp_conflict) duplicate=$(g cp_duplicate) failed=$(g cp_failed) exception_listed=$(g cp_exception_listed) verify=$(g vf_parse_ok)/$(g vf_mode)/$(g vf_exit_meaning)/$(g vf_complete) verified=$(g vf_verified) unregistered=$(g vf_unregistered) not_migrated=$(g vf_not_migrated) vf_mismatch=$(g vf_checksum_mismatch) vf_failed=$(g vf_failed) after: L=$L U=$U migrated=$M native=$N pre: candidates=$(g pre_candidates) migrated=$(g pre_migrated) native=$(g pre_native) native_unchanged=$([ "$(g nat_keys_md5)" = "$(g pre_nat_keys_md5)" ] && [ "$(g nat_pf_cipher_md5)" = "$(g pre_nat_pf_cipher_md5)" ] && [ "$(g nat_pm_generations_md5)" = "$(g pre_nat_pm_generations_md5)" ] && echo true || echo false) census_unchanged=$([ "$(g census_md5)" = "$(g pre_census_md5)" ] && echo true || echo false)" ;;
    postverify)
      ok=1; is_true image_present && is_true image_commit_ok && is_true vf_parse_ok && is_eq vf_mode verify && is_eq vf_exit_meaning COMPLETE && is_true vf_complete && is_true vf_read_only && is_eq vf_verified "$M" && is_zero vf_unregistered && is_zero vf_not_migrated && is_zero vf_checksum_mismatch && is_zero vf_failed && is_zero vf_exception_listed && [ "$L" = 0 ] && [ "$U" = 0 ] && [ "$M" -ge 1 ] && ok=0
      cond "postverify form: the product's --verify (read-only) COMPLETE with verified = every migrated row, nothing unregistered / unmigrated / mismatched / failed, the exception never listed; no pending reference remains (L = 0, U = 0) and at least one migrated row exists" $ok "image=$(g image_present)/$(g image_commit_ok) verify=$(g vf_parse_ok)/$(g vf_mode)/$(g vf_exit_meaning)/$(g vf_complete)/read_only=$(g vf_read_only) verified=$(g vf_verified) unregistered=$(g vf_unregistered) not_migrated=$(g vf_not_migrated) mismatch=$(g vf_checksum_mismatch) failed=$(g vf_failed) exception_listed=$(g vf_exception_listed) L=$L U=$U migrated=$M" ;;
  esac
  echo "B25_STAGE2B_CONDITIONS_FAILED=$failed"; echo "B25_STAGE2B_FORM=$(printf '%s' "$FORM" | tr '[:lower:]' '[:upper:]')"
  echo "B25_STAGE2B_INVENTORY=native:$N migrated:$M legacy_source:$L unregistered:$U failed:$F duplicates:$D"
  local T; T="$([ "$failed" = 0 ] && echo TRUE || echo FALSE)"
  echo "B25_STAGE2B_PREFLIGHT_READY=$([ "$FORM" = preflight ] && echo "$T" || echo FALSE)"
  echo "B25_STAGE2B_DRY_RUN_REPORTED=$([ "$FORM" = dryrun ] && echo "$T" || echo FALSE)"
  echo "B25_STAGE2B_COPY_VERIFIED=$([ "$FORM" = copy ] && echo "$T" || echo FALSE)"
  echo "B25_STAGE2B_POSTVERIFY_READY=$([ "$FORM" = postverify ] && echo "$T" || echo FALSE)"
  return 0   # the markers carry the verdict; the phases gate on the TRUE marker of their own form
}
