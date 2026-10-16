# =============================================================================
# TEMPORARY — B25 Stage 1 schema-apply decision rules (ONE-OFF ops library, not
# application code). Sourced by the VPS-side activation script (prepended on the
# SSH stdin stream) and by .github/scripts/b25-stage1-cleanup.test.sh, so the
# allow-list and the backup-structure rules are unit-tested locally with canned
# and mutated inputs. Defines ONLY functions — nothing executes on load.
# =============================================================================

# ---- push_allowlist_check <drizzle push log> ----
# Returns 0 only when the log contains EXACTLY the five accepted statements of the
# B25 design (CREATE TABLE storage_objects with the accepted column definitions +
# the four index statements) and no ALTER / DROP / RENAME / data statement, no
# statement on another table and no data-loss warning. Prints one reason on failure.
push_allowlist_check() {
  local logf="$1" st n
  [ -f "$logf" ] || { echo "allowlist: log missing"; return 1; }
  grep -q 'Changes applied' "$logf" || { echo "allowlist: push did not report 'Changes applied'"; return 1; }
  grep -qiE 'data.loss|you.re about to|truncate' "$logf" && { echo "allowlist: data-loss warning raised"; return 1; }
  st="$(grep -E '^(ALTER|CREATE|DROP|TRUNCATE|DELETE|UPDATE|INSERT)' "$logf" || true)"
  n="$(printf '%s\n' "$st" | grep -c . || true)"
  [ "$n" = "5" ] || { echo "allowlist: statement count is $n, not 5"; return 1; }
  [ "$(printf '%s\n' "$st" | grep -c '^CREATE TABLE "storage_objects" (' || true)" = "1" ] || { echo "allowlist: CREATE TABLE storage_objects missing"; return 1; }
  local idx
  for idx in 'CREATE UNIQUE INDEX "storage_objects_company_kind_reference_uq" ON "storage_objects" USING btree ("company_id","kind","reference");' 'CREATE INDEX "storage_objects_company_idx" ON "storage_objects" USING btree ("company_id");' 'CREATE INDEX "storage_objects_state_updated_idx" ON "storage_objects" USING btree ("state","updated_at");' 'CREATE INDEX "storage_objects_entity_idx" ON "storage_objects" USING btree ("entity_type","entity_id");'; do
    grep -qF -- "$idx" "$logf" || { echo "allowlist: expected index statement missing: ${idx:0:60}"; return 1; }
  done
  [ "$(printf '%s\n' "$st" | grep -ciE '^(ALTER|DROP|TRUNCATE|DELETE|UPDATE|INSERT)|RENAME' || true)" = "0" ] || { echo "allowlist: forbidden statement class proposed"; return 1; }
  [ "$(printf '%s\n' "$st" | grep -vc '"storage_objects"' || true)" = "0" ] || { echo "allowlist: a statement touches another table"; return 1; }
  grep -qiE 'ALTER TABLE|DROP |RENAME|SET DATA TYPE|SET NOT NULL|DROP NOT NULL|DROP DEFAULT' "$logf" && { echo "allowlist: alter / drop / rename / type / nullability / default text present"; return 1; }
  local col
  for col in '"id" uuid PRIMARY KEY NOT NULL' '"company_id" integer NOT NULL' '"kind" text NOT NULL' '"entity_type" text' '"entity_id" integer' '"reference" text NOT NULL' '"storage_key" text NOT NULL' '"driver" text NOT NULL' '"legacy_key" text' '"mirror_key" text' '"lease_token" text' '"lease_expires_at" timestamp' '"content_type" text NOT NULL' '"size_bytes" bigint' '"sha256" text' "\"state\" text DEFAULT 'pending' NOT NULL" '"mirror_state" text' '"last_error" text' '"created_at" timestamp DEFAULT now() NOT NULL' '"updated_at" timestamp DEFAULT now() NOT NULL' '"deleted_at" timestamp' '"reconciled_at" timestamp' '"publication_uncertain_at" timestamp'; do
    grep -qF -- "$col" "$logf" || { echo "allowlist: accepted column definition missing: $col"; return 1; }
  done
  grep -qE '"publication_uncertain_at" timestamp\s*(,|$)' "$logf" || { echo "allowlist: publication_uncertain_at is not a bare nullable timestamp"; return 1; }
  [ "$(grep -c '^CREATE TABLE' "$logf" || true)" = "1" ] || { echo "allowlist: more than one CREATE TABLE"; return 1; }
  echo "allowlist: exactly the 5 accepted statements"
  return 0
}

# ---- backup_structure_check <gzip dump> <expected CREATE TABLE count> <expected companies rows> ----
# Returns 0 only when the dump is a complete pg_dump (completion marker exactly once),
# contains the expected number of CREATE TABLE statements and the companies COPY
# block carries exactly the expected number of rows.
backup_structure_check() {
  local f="$1" tables="$2" companies="$3" marker ct rows
  [ -f "$f" ] || { echo "backup: file missing"; return 1; }
  gzip -t "$f" 2>/dev/null || { echo "backup: gzip integrity failed"; return 1; }
  marker="$(zcat "$f" | grep -c '^-- PostgreSQL database dump complete' || true)"
  ct="$(zcat "$f" | grep -c '^CREATE TABLE' || true)"
  rows="$(zcat "$f" | awk '/^COPY public.companies /{f=1; next} f && /^\\\.$/{exit} f{n++} END{print n+0}')"
  echo "backup structure: complete_marker=$marker CREATE_TABLE=$ct companies_rows=$rows (expected tables=$tables companies=$companies)"
  [ "$marker" = "1" ] || { echo "backup: not a complete dump"; return 1; }
  [ "$ct" = "$tables" ] || { echo "backup: CREATE TABLE count differs"; return 1; }
  [ "$rows" = "$companies" ] || { echo "backup: companies row count differs from the live table"; return 1; }
  return 0
}

# =============================================================================
# B25 PHYSICAL TEST RESIDUE — READ-ONLY INSPECTION RULES (b25phys_inspect).
# The manifest of the physical Android test (company 53, its dedicated test
# admin, event, contact 22, document 6, storage row f048b5d4…) is a CONSTANT of
# this library: it is never an input, never an argument, never an environment
# value, and `readonly` so a later assignment is refused by the shell. The hosted
# phase (apply.sh, PHASE=b25phys-inspect) only READS — q sessions pinned
# read-only, provider metadata reads, bucket listing — gathers facts and hands
# them to the evaluator below, which decides B25_PHYSICAL_SETTLEMENT_ELIGIBLE.
# Everything here is a pure function (SQL text builders and the evaluator) so
# b25-stage1-cleanup.test.sh can exercise it locally. No settle mode exists for
# this manifest; adding one is a separately reviewed change.
# =============================================================================
readonly B25PHYS_COMPANY=53
readonly B25PHYS_CONTACT=22
readonly B25PHYS_DOCUMENT=6
readonly B25PHYS_UUID="f048b5d4-b366-4227-857f-42b2589e54b7"
readonly B25PHYS_COMPANY_NAME="B25 Physical Android Test 20261015"
readonly B25PHYS_EVENT_NAME="B25 Physical Test Event"
readonly B25PHYS_CONTACT_NAME="B25 Physical Test Contact"
# Census BEFORE cleanup (read-only inspection must leave it exactly so): originals (4 / 1299 /
# c1b900fd…) plus the one marked 99-byte object of the row above.
readonly B25PHYS_CENSUS_OBJECTS=5
readonly B25PHYS_CENSUS_BYTES=1398
readonly B25PHYS_CENSUS_MARKED=1
readonly B25PHYS_CENSUS_MD5="36d90200a6dc0b043a11aeadee20863c"
readonly B25PHYS_STORAGE_ROWS=1
readonly B25PHYS_ORIGINALS_MD5="c1b900fd509bafa1f980d863dc0d195b"
readonly B25PHYS_OBJECT_SIZE=99

# The constant manifest in one line (printed by the hosted phase; the only source of these ids).
b25phys_manifest() {
  printf '%s|%s|%s|%s\n' "$B25PHYS_UUID" "$B25PHYS_COMPANY" "$B25PHYS_CONTACT" "$B25PHYS_DOCUMENT"
}

# ---- b25phys_int <value> <label>: a positive decimal integer or failure (every id interpolated into SQL passes here)
b25phys_int() { [[ "$1" =~ ^[1-9][0-9]*$ ]] || { echo "b25phys: $2 is not a positive integer" >&2; return 1; }; }
b25phys_ident() { [[ "$1" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "b25phys: '$2' is not a plain identifier" >&2; return 1; }; }
# ---- b25phys_mask_email_sql <column expr>: first character of the local part, ***, the domain (never the full address)
b25phys_mask_email_sql() { printf "left(%s, 1) || '***@' || split_part(%s, '@', 2)" "$1" "$1"; }

# ---- b25phys_fk_counts_gen_sql <parent table> <id> ----
# Prints the SQL that GENERATES (from the catalog, never a hand-written table list) one SELECT per
# single-column foreign key referencing <parent table>(id): table | column | on-delete action |
# count of rows whose column = <id>. Executed in two read-only steps by the caller:
#   gen="$(q "$(b25phys_fk_counts_gen_sql companies 53)")"; [ -n "$gen" ] && q "$gen"
# Identifiers come from pg_constraint through format('%I'); the id is validated here. Empty output
# from the generator means the parent has no foreign-key dependents at all.
b25phys_fk_counts_gen_sql() {
  local parent="$1" id="$2"
  b25phys_ident "$parent" "parent table" || return 1
  b25phys_int "$id" "parent id" || return 1
  cat <<SQL
select string_agg(format('select %L as tbl, %L as col, %L as on_delete, (select count(*) from %I where %I = $id) as n', c.conrelid::regclass::text, a.attname, case c.confdeltype when 'c' then 'cascade' when 'n' then 'set null' when 'd' then 'set default' when 'r' then 'restrict' else 'no action' end, c.conrelid::regclass::text, a.attname), ' union all ' order by c.conrelid::regclass::text, a.attname)
from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
where c.contype = 'f' and c.confrelid = '$parent'::regclass and array_length(c.conkey, 1) = 1
  and exists (select 1 from pg_attribute p where p.attrelid = c.confrelid and p.attnum = c.confkey[1] and p.attname = 'id')
SQL
}

# ---- b25phys_plain_company_counts_gen_sql <company id> ----
# Tables that carry a company_id column WITHOUT a foreign key to companies (inventory and log tables that
# outlive a tenant by design: storage_objects, audit_logs, activity_logs, …): generated from the catalog,
# counted per table for <company id>. Same two-step execution as above.
b25phys_plain_company_counts_gen_sql() {
  local id="$1"
  b25phys_int "$id" "company id" || return 1
  cat <<SQL
select string_agg(format('select %L as tbl, (select count(*) from %I where company_id = $id) as n', t.table_name, t.table_name), ' union all ' order by t.table_name)
from information_schema.columns t
where t.table_schema = 'public' and t.column_name = 'company_id'
  and not exists (select 1 from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
                  where c.contype = 'f' and c.confrelid = 'companies'::regclass and c.conrelid = ('public.' || quote_ident(t.table_name))::regclass and a.attname = 'company_id')
SQL
}

# ---- b25phys_cross_tenant_sql <company id> ----
# Rows of the tenant whose parent references (event, contact, document, user, manager) resolve OUTSIDE the
# tenant, plus rows of OTHER tenants that reference the tenant's events / contacts / documents / users.
# One number; 0 = the tenant's data closes over itself (a company cascade removes exactly its own graph).
b25phys_cross_tenant_sql() {
  local c="$1"
  b25phys_int "$c" "company id" || return 1
  cat <<SQL
select
  (select count(*) from contacts x where x.company_id = $c and ((x.event_id is not null and not exists (select 1 from events e where e.id = x.event_id and e.company_id = $c)) or (x.assigned_to_id is not null and not exists (select 1 from users u where u.id = x.assigned_to_id and u.company_id = $c)) or (x.created_by_id is not null and not exists (select 1 from users u where u.id = x.created_by_id and u.company_id = $c))))
+ (select count(*) from leads x where x.company_id = $c and ((x.contact_id is not null and not exists (select 1 from contacts k where k.id = x.contact_id and k.company_id = $c)) or (x.event_id is not null and not exists (select 1 from events e where e.id = x.event_id and e.company_id = $c)) or (x.assigned_to_id is not null and not exists (select 1 from users u where u.id = x.assigned_to_id and u.company_id = $c)) or (x.created_by_id is not null and not exists (select 1 from users u where u.id = x.created_by_id and u.company_id = $c))))
+ (select count(*) from scans x where x.company_id = $c and ((x.contact_id is not null and not exists (select 1 from contacts k where k.id = x.contact_id and k.company_id = $c)) or (x.event_id is not null and not exists (select 1 from events e where e.id = x.event_id and e.company_id = $c)) or (x.user_id is not null and not exists (select 1 from users u where u.id = x.user_id and u.company_id = $c))))
+ (select count(*) from documents x where x.company_id = $c and (x.created_by_id is not null and not exists (select 1 from users u where u.id = x.created_by_id and u.company_id = $c)))
+ (select count(*) from document_versions x where x.company_id = $c and (not exists (select 1 from documents d where d.id = x.document_id and d.company_id = $c) or (x.uploaded_by_id is not null and not exists (select 1 from users u where u.id = x.uploaded_by_id and u.company_id = $c))))
+ (select count(*) from users x where x.company_id = $c and x.manager_id is not null and not exists (select 1 from users m where m.id = x.manager_id and m.company_id = $c))
+ (select count(*) from contacts x where x.company_id <> $c and (x.event_id in (select id from events where company_id = $c) or x.assigned_to_id in (select id from users where company_id = $c) or x.created_by_id in (select id from users where company_id = $c)))
+ (select count(*) from leads x where x.company_id <> $c and (x.contact_id in (select id from contacts where company_id = $c) or x.event_id in (select id from events where company_id = $c) or x.assigned_to_id in (select id from users where company_id = $c) or x.created_by_id in (select id from users where company_id = $c)))
+ (select count(*) from scans x where x.company_id <> $c and (x.contact_id in (select id from contacts where company_id = $c) or x.event_id in (select id from events where company_id = $c) or x.user_id in (select id from users where company_id = $c)))
+ (select count(*) from documents x where x.company_id <> $c and (x.created_by_id in (select id from users where company_id = $c) or (x.entity_type = 'contact' and x.entity_id in (select id from contacts where company_id = $c))))
+ (select count(*) from document_versions x where x.company_id <> $c and (x.document_id in (select id from documents where company_id = $c) or x.uploaded_by_id in (select id from users where company_id = $c)))
SQL
}

# ---- b25phys_eligibility ----
# Reads key=value facts on stdin (one per line; the hosted phase prints exactly these after reading the
# host) and prints the fifteen deletion prerequisites with OK / FAIL, then
#   B25PHYS_FATAL=<n>                      identity / ownership / provider-metadata mismatches (the
#                                          phase fails closed on any)
#   B25_PHYSICAL_SETTLEMENT_ELIGIBLE=TRUE|FALSE
# A missing or malformed fact fails its condition (never defaults to a pass). Always returns 0 so the
# whole report is printed; the caller inspects the two summary lines.
b25phys_eligibility() {
  local -A f=()
  local line k v
  while IFS= read -r line; do
    [[ "$line" =~ ^([a-z0-9_]+)=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
    f[$k]="$v"
  done
  local fatal=0 failed=0 n=0
  g() { printf '%s' "${f[$1]:-<missing>}"; }
  is_true() { [ "$(g "$1")" = "true" ]; }
  is_zero() { [ "$(g "$1")" = "0" ]; }
  is_eq() { [ "$(g "$1")" = "$2" ]; }
  cond() {   # cond <fatal yes|no> <name> <ok 0|1> <detail>
    n=$((n + 1))
    if [ "$3" = "0" ]; then echo "cond $n: $2 — OK ($4)"; else echo "cond $n: $2 — FAIL ($4)"; failed=$((failed + 1)); [ "$1" = "yes" ] && fatal=$((fatal + 1)); fi
  }
  local ok
  ok=1; is_eq company_present 1 && is_true company_name_matches && ok=0
  cond yes "company $B25PHYS_COMPANY exists and its name is exactly the B25 test company" $ok "present=$(g company_present) name_matches=$(g company_name_matches)"
  ok=1; is_zero users_outside_company && is_zero users_platform_role && [[ "$(g users_total)" =~ ^[1-9][0-9]*$ ]] && ok=0
  cond no "every enumerated user belongs to company $B25PHYS_COMPANY only (no platform role among them)" $ok "users=$(g users_total) outside=$(g users_outside_company) platform_role=$(g users_platform_role)"
  ok=1; is_eq admin_candidates 1 && [[ "$(g admin_user_id)" =~ ^[1-9][0-9]*$ ]] && ok=0
  cond no "exactly one dedicated B25 test admin (active primary_admin of company $B25PHYS_COMPANY)" $ok "candidates=$(g admin_candidates) user_id=$(g admin_user_id)"
  ok=1; is_true contact_ok && ok=0
  cond yes "contact $B25PHYS_CONTACT belongs to company $B25PHYS_COMPANY and carries the expected test identity" $ok "contact_ok=$(g contact_ok)"
  ok=1; is_true event_ok && [[ "$(g event_id)" =~ ^[1-9][0-9]*$ ]] && ok=0
  cond no "the expected B25 event belongs to company $B25PHYS_COMPANY" $ok "event_ok=$(g event_ok) event_id=$(g event_id)"
  ok=1; is_true document_ok && ok=0
  cond yes "document $B25PHYS_DOCUMENT belongs to company $B25PHYS_COMPANY / contact $B25PHYS_CONTACT" $ok "document_ok=$(g document_ok) versions=$(g document_versions)"
  ok=1; is_true storage_row_ok && is_true storage_linked_to_document && ok=0
  cond yes "storage row $B25PHYS_UUID belongs to company $B25PHYS_COMPANY and is the object of document $B25PHYS_DOCUMENT" $ok "row_ok=$(g storage_row_ok) linked=$(g storage_linked_to_document)"
  ok=1; is_true provider_present && is_true provider_marker_ok && is_eq provider_marked_is_target 1 && ok=0
  cond yes "provider object present, metadata lcp-object-id == the row id, and it is the only marked object" $ok "present=$(g provider_present) marker=$(g provider_marker_ok) marked_is_target=$(g provider_marked_is_target)"
  ok=1; is_eq provider_size "$B25PHYS_OBJECT_SIZE" && is_true provider_size_matches && ok=0
  cond yes "provider object size = $B25PHYS_OBJECT_SIZE bytes (= the row)" $ok "size=$(g provider_size) matches_row=$(g provider_size_matches)"
  ok=1; is_true provider_generation_canonical && is_true provider_generation_stable && ok=0
  cond no "provider generation is a canonical decimal string and identical across two immediate reads" $ok "canonical=$(g provider_generation_canonical) stable=$(g provider_generation_stable) digits=$(g provider_generation_digits)"
  ok=1; is_zero live_refs_other && ok=0
  cond no "no reference to this object outside document $B25PHYS_DOCUMENT's version" $ok "other_references=$(g live_refs_other)"
  ok=1; is_zero deps_blocking && is_zero cross_tenant_links && is_zero events_unexpected && ok=0
  cond no "no unexpected dependency under company $B25PHYS_COMPANY (no restrict/no-action dependent rows, no cross-tenant link, no unexpected event)" $ok "blocking=$(g deps_blocking) cross_tenant=$(g cross_tenant_links) unexpected_events=$(g events_unexpected)"
  ok=1; is_true ai_rows_classified && ok=0
  cond no "tenant AI rows are cascade rows of the test company or set-null historical rows" $ok "classified=$(g ai_rows_classified) insights=$(g ai_insights) conversations=$(g ai_conversations) copilot=$(g ai_copilot_outputs) workflow=$(g ai_workflow_recommendations) invocations=$(g ai_invocations)"
  ok=1; is_zero jobs_conflicting && ok=0
  cond no "no queued/running purge, delete or AI job and no dead storage job touches company $B25PHYS_COMPANY or the object" $ok "conflicting=$(g jobs_conflicting) dead_storage=$(g dead_storage_jobs)"
  ok=1; is_eq census_objects "$B25PHYS_CENSUS_OBJECTS" && is_eq census_bytes "$B25PHYS_CENSUS_BYTES" && is_eq census_marked "$B25PHYS_CENSUS_MARKED" && is_eq census_md5 "$B25PHYS_CENSUS_MD5" && is_eq storage_rows "$B25PHYS_STORAGE_ROWS" && is_true originals_ok && is_true unmarked_md5_ok && ok=0
  cond no "census = $B25PHYS_CENSUS_OBJECTS / $B25PHYS_CENSUS_BYTES / $B25PHYS_CENSUS_MARKED / $B25PHYS_CENSUS_MD5, $B25PHYS_STORAGE_ROWS row, originals 4/4 and unchanged" $ok "objects=$(g census_objects) bytes=$(g census_bytes) marked=$(g census_marked) md5=$(g census_md5) rows=$(g storage_rows) originals_ok=$(g originals_ok) unmarked_md5_ok=$(g unmarked_md5_ok)"
  echo "B25PHYS_CONDITIONS_FAILED=$failed"
  echo "B25PHYS_FATAL=$fatal"
  if [ "$failed" = "0" ]; then echo "B25_PHYSICAL_SETTLEMENT_ELIGIBLE=TRUE"; else echo "B25_PHYSICAL_SETTLEMENT_ELIGIBLE=FALSE"; fi
  return 0
}

# =============================================================================
# B25 PHYSICAL TEST RESIDUE — POST-OPERATOR-DELETION TOMBSTONE VERIFICATION
# (b25phys_postdelete_verify). READ-ONLY. After the real platform owner deleted
# company 53 through the Platform portal, the product cascade must have removed
# the tenant graph (user 100, event 17, contact 22, document 6, version 6), the
# storage.purgeCompany job must have settled the one storage row to the
# product's tombstone (deleted / LEGACY_RETAINED; the bucket object is retained
# because legacy delete is off) and the provider inventory must be UNCHANGED
# (5 / 1398 / 1 marked). The evaluator below decides whether the tombstone is
# eligible for a later, separately reviewed provider settlement. Nothing here
# mutates anything; no settle mode exists for this manifest.
# =============================================================================
readonly B25PHYS_USER=100
readonly B25PHYS_EVENT=17
readonly B25PHYS_VERSION=6
# sha256/16 of the provider generation proven by the pre-delete gate (run 38822576943); a changed
# generation after the deletion is a settlement blocker, never something to adopt.
readonly B25PHYS_PRE_GEN_DIGEST="3545c17e5f3aa940"
# Log window start = the pre-delete gate; the operator deletion and the purge happened after it.
readonly B25PHYS_POSTDELETE_WINDOW_START="2026-10-15T23:16:00Z"

# ---- b25phys_postdelete_eligibility ----
# key=value facts on stdin → the 23 post-delete prerequisites with OK / FAIL, then
#   B25PHYS_POSTDELETE_CONDITIONS_FAILED=<n>
#   B25_POSTDELETE_PROVIDER_SETTLEMENT_ELIGIBLE=TRUE|FALSE
# A missing or malformed fact fails its condition. Always returns 0 (the caller reads the lines).
b25phys_postdelete_eligibility() {
  local -A f=()
  local line k v
  while IFS= read -r line; do
    [[ "$line" =~ ^([a-z0-9_]+)=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"; f[$k]="$v"
  done
  local failed=0 n=0
  g() { printf '%s' "${f[$1]:-<missing>}"; }
  is_true() { [ "$(g "$1")" = "true" ]; }
  is_zero() { [ "$(g "$1")" = "0" ]; }
  is_eq() { [ "$(g "$1")" = "$2" ]; }
  cond() { n=$((n + 1)); if [ "$2" = "0" ]; then echo "post $n: $1 — OK ($3)"; else echo "post $n: $1 — FAIL ($3)"; failed=$((failed + 1)); fi; }
  local ok
  ok=1; is_true company_absent && is_zero company_dependents && is_zero ai_residue && ok=0
  cond "company $B25PHYS_COMPANY absent, no dependent tenant row, no tenant AI row" $ok "absent=$(g company_absent) dependents=$(g company_dependents) ai_residue=$(g ai_residue)"
  ok=1; is_true user_absent && is_zero user_refs && ok=0
  cond "user $B25PHYS_USER absent and unreferenced" $ok "absent=$(g user_absent) references=$(g user_refs)"
  ok=1; is_true event_absent && is_zero event_refs && ok=0
  cond "event $B25PHYS_EVENT absent and unreferenced" $ok "absent=$(g event_absent) references=$(g event_refs)"
  ok=1; is_true contact_absent && is_zero contact_refs && ok=0
  cond "contact $B25PHYS_CONTACT absent and unreferenced" $ok "absent=$(g contact_absent) references=$(g contact_refs)"
  ok=1; is_true document_absent && is_zero document_refs && ok=0
  cond "document $B25PHYS_DOCUMENT absent and unreferenced" $ok "absent=$(g document_absent) references=$(g document_refs)"
  ok=1; is_true version_absent && ok=0
  cond "document version $B25PHYS_VERSION absent" $ok "absent=$(g version_absent)"
  ok=1; is_zero live_refs && ok=0
  cond "no live application reference to the storage uuid" $ok "live_references=$(g live_refs)"
  ok=1; is_eq row_count 1 && ok=0
  cond "exactly one storage row for the uuid" $ok "rows=$(g row_count)"
  ok=1; is_eq row_state deleted && ok=0
  cond "row state = deleted" $ok "state=$(g row_state)"
  ok=1; is_eq row_last_error LEGACY_RETAINED && ok=0
  cond "row last_error = LEGACY_RETAINED" $ok "last_error=$(g row_last_error)"
  ok=1; is_eq row_uncertain false && is_true row_deleted_at_set && ok=0
  cond "no publication uncertainty; deleted_at populated" $ok "uncertain=$(g row_uncertain) deleted_at_set=$(g row_deleted_at_set)"
  ok=1; is_eq row_lease false && ok=0
  cond "no lease" $ok "lease=$(g row_lease)"
  ok=1; is_eq row_mirror false && is_true row_identity_ok && ok=0
  cond "no mirror; reference / storage_key / legacy_key keep the approved identity" $ok "mirror=$(g row_mirror) identity=$(g row_identity_ok)"
  ok=1; is_true provider_present && ok=0
  cond "provider object present (retained by design: legacy delete off)" $ok "present=$(g provider_present)"
  ok=1; is_true provider_marker_ok && is_eq provider_marked_is_target 1 && ok=0
  cond "provider marker == the uuid; it is the only marked object" $ok "marker=$(g provider_marker_ok) marked_is_target=$(g provider_marked_is_target)"
  ok=1; is_eq provider_size "$B25PHYS_OBJECT_SIZE" && is_true provider_size_matches && ok=0
  cond "provider size = $B25PHYS_OBJECT_SIZE" $ok "size=$(g provider_size) matches_row=$(g provider_size_matches)"
  ok=1; is_true provider_generation_canonical && is_true provider_generation_stable && is_true provider_metageneration_stable && ok=0
  cond "provider generation canonical and stable across two reads (metageneration stable)" $ok "canonical=$(g provider_generation_canonical) stable=$(g provider_generation_stable) metagen=$(g provider_metageneration_stable) digits=$(g provider_generation_digits)"
  ok=1; is_eq provider_generation_digest "$B25PHYS_PRE_GEN_DIGEST" && ok=0
  cond "provider generation digest unchanged from the pre-delete proof" $ok "digest=$(g provider_generation_digest) expected=$B25PHYS_PRE_GEN_DIGEST"
  ok=1; is_zero jobs_conflicting && is_zero purge_pending_running && [[ "$(g purge_completed)" =~ ^[1-9][0-9]*$ ]] && ok=0
  cond "purge job completed; no purge / delete / settlement / AI job active" $ok "purge_completed=$(g purge_completed) purge_pending_running=$(g purge_pending_running) conflicting=$(g jobs_conflicting)"
  ok=1; is_zero dead_storage_jobs && is_zero purge_dead && ok=0
  cond "no dead storage job" $ok "dead_storage=$(g dead_storage_jobs) purge_dead=$(g purge_dead)"
  ok=1; is_eq census_objects "$B25PHYS_CENSUS_OBJECTS" && is_eq census_bytes "$B25PHYS_CENSUS_BYTES" && is_eq census_marked "$B25PHYS_CENSUS_MARKED" && is_eq census_md5 "$B25PHYS_CENSUS_MD5" && ok=0
  cond "provider inventory still exactly $B25PHYS_CENSUS_OBJECTS / $B25PHYS_CENSUS_BYTES / $B25PHYS_CENSUS_MARKED / $B25PHYS_CENSUS_MD5 (not yet settled)" $ok "objects=$(g census_objects) bytes=$(g census_bytes) marked=$(g census_marked) md5=$(g census_md5)"
  ok=1; is_true unmarked_md5_ok && ok=0
  cond "the four original objects unchanged ($B25PHYS_ORIGINALS_MD5)" $ok "unmarked_md5_ok=$(g unmarked_md5_ok)"
  ok=1; is_true originals_ok && ok=0
  cond "original references 4/4 present and size-matched" $ok "originals_ok=$(g originals_ok)"
  echo "B25PHYS_POSTDELETE_CONDITIONS_FAILED=$failed"
  if [ "$failed" = "0" ]; then echo "B25_POSTDELETE_PROVIDER_SETTLEMENT_ELIGIBLE=TRUE"; else echo "B25_POSTDELETE_PROVIDER_SETTLEMENT_ELIGIBLE=FALSE"; fi
  return 0
}

# =============================================================================
# B25 STAGE 2A — FILESYSTEM PRIMARY ACTIVATION (fs primary on the EXISTING named
# volume `objectdata` + strict GCS mirror + legacy fallback). Constants, the
# FIXED activation / rollback environment rendering and the two READ-ONLY
# evaluators. Everything here is a pure function or a readonly constant so
# b25-stage1-cleanup.test.sh exercises it locally:
#   stage2a_env_render <activate|rollback>   stdin = the env file, stdout = the
#                                            file with ONLY the managed storage
#                                            variables replaced by their fixed
#                                            values (no value is ever a parameter)
#   stage2a_precheck_eligibility             key=value facts → 30 prerequisites →
#                                            B25_STAGE2A_PRECHECK_ELIGIBLE
#   stage2a_postswitch_eligibility           key=value facts → 22 prerequisites →
#                                            B25_STAGE2A_POSTSWITCH_READY
# The encryption key is NEVER read, rendered, compared or printed by anything in
# this library: the activation leaves the owner's OBJECT_STORAGE_ENCRYPTION_KEY
# line of the VPS env file untouched (its presence is counted, nothing more).
# There is NO migration wrapper (Stage 2B) and NO GCS retirement (Stage 2E) here.
# =============================================================================
readonly STAGE2A_PRODUCT_SHA="e559b0024b28d4a77becdcb10c4168004dddea75"
readonly STAGE2A_PREVIOUS_SHA="72a24378947134ca8e4d3460294474894c9aaee4"
readonly STAGE2A_FS_ROOT="/data/objects"
readonly STAGE2A_VOLUME="card-scanner-pro_objectdata"
readonly STAGE2A_ROOT_OWNER="999:999"
readonly STAGE2A_ROOT_MODE="700"
# Capacity floor for the activation (the live inventory is 1,398 bytes; the Phase 2A record measured ~68 GB free).
readonly STAGE2A_MIN_DISK_BYTES=10737418240
readonly STAGE2A_MIN_INODES=1000000
# The ONLY variables the activation / rollback may touch (fixed names; the key is deliberately absent).
readonly STAGE2A_ACTIVATE_VARS="OBJECT_STORAGE_DRIVER OBJECT_STORAGE_FS_ROOT OBJECT_STORAGE_LEGACY_FALLBACK OBJECT_STORAGE_MIRROR OBJECT_STORAGE_LEGACY_DELETE"
readonly STAGE2A_ROLLBACK_VARS="OBJECT_STORAGE_DRIVER OBJECT_STORAGE_LEGACY_FALLBACK OBJECT_STORAGE_MIRROR OBJECT_STORAGE_LEGACY_DELETE"
readonly STAGE2A_KEY_VAR="OBJECT_STORAGE_ENCRYPTION_KEY"
# Shape of the owner-staged key line (64 lowercase hex characters); used ONLY with `grep -c` on the env file.
readonly STAGE2A_KEY_LINE_SHAPE='^OBJECT_STORAGE_ENCRYPTION_KEY=[0-9a-f]{64}$'

# ---- stage2a_env_lines <activate|rollback> ----
# The fixed managed lines. Activation: fs primary on the locked root, legacy fallback ON, strict mirror to the
# bucket, legacy deletion OFF. Rollback: the bucket is the explicit primary again (DRIVER=gcs wins over a root
# that may stay configured), fallback OFF, mirror OFF, legacy deletion OFF. OBJECT_STORAGE_FS_ROOT is NOT
# managed by the rollback (it may remain) and the key is managed by neither.
stage2a_env_lines() {
  case "$1" in
    activate)
      printf '%s\n' "OBJECT_STORAGE_DRIVER=fs" "OBJECT_STORAGE_FS_ROOT=$STAGE2A_FS_ROOT" "OBJECT_STORAGE_LEGACY_FALLBACK=true" "OBJECT_STORAGE_MIRROR=gcs" "OBJECT_STORAGE_LEGACY_DELETE=false" ;;
    rollback)
      printf '%s\n' "OBJECT_STORAGE_DRIVER=gcs" "OBJECT_STORAGE_LEGACY_FALLBACK=false" "OBJECT_STORAGE_MIRROR=" "OBJECT_STORAGE_LEGACY_DELETE=false" ;;
    *) echo "stage2a_env_lines: unknown mode" >&2; return 1 ;;
  esac
}
stage2a_env_managed_vars() {
  case "$1" in activate) printf '%s\n' $STAGE2A_ACTIVATE_VARS ;; rollback) printf '%s\n' $STAGE2A_ROLLBACK_VARS ;; *) echo "stage2a_env_managed_vars: unknown mode" >&2; return 1 ;; esac
}
# ---- stage2a_env_unmanaged <activate|rollback> ---- stdin → every line that is NOT a managed assignment (verbatim)
stage2a_env_unmanaged() {
  local mode="$1" re
  re="^($(stage2a_env_managed_vars "$mode" | paste -sd'|' -))="
  [ "$re" != "^()=" ] || return 1
  grep -vE "$re" || true
}
# ---- stage2a_env_render <activate|rollback> ---- stdin = env file → stdout = the same file with the managed
# assignments removed wherever they were and the fixed lines appended once, at the end. Every other line
# (comments, blank lines, DATABASE_URL, SESSION_SECRET, the legacy bucket variables, the encryption key line)
# passes through byte for byte. No parameter can supply a value, a name or a path.
stage2a_env_render() {
  local mode="$1"
  case "$mode" in activate|rollback) ;; *) echo "stage2a_env_render: unknown mode" >&2; return 1 ;; esac
  stage2a_env_unmanaged "$mode"
  stage2a_env_lines "$mode"
}
# ---- stage2a_env_managed_of <activate|rollback> ---- stdin → the managed assignments present, in file order
stage2a_env_managed_of() {
  local mode="$1" re
  re="^($(stage2a_env_managed_vars "$mode" | paste -sd'|' -))="
  grep -E "$re" || true
}
# ---- stage2a_env_check_rendered <activate|rollback> <before file> <after file> ----
# Returns 0 only when: the unmanaged content is byte-identical before and after; the managed assignments of
# the after file are EXACTLY the fixed lines (order and count); the key line count is unchanged. Prints
# fixed-text reasons only — never a line of either file.
stage2a_env_check_rendered() {
  local mode="$1" before="$2" after="$3" ub ua mb kb ka
  ub="$(stage2a_env_unmanaged "$mode" < "$before" | sha256sum | cut -c1-64)"
  ua="$(stage2a_env_unmanaged "$mode" < "$after" | sha256sum | cut -c1-64)"
  [ "$ub" = "$ua" ] || { echo "env check: an unmanaged line changed"; return 1; }
  mb="$(stage2a_env_managed_of "$mode" < "$after" | sha256sum | cut -c1-64)"
  [ "$mb" = "$(stage2a_env_lines "$mode" | sha256sum | cut -c1-64)" ] || { echo "env check: managed lines are not exactly the fixed set"; return 1; }
  kb="$(grep -c "^$STAGE2A_KEY_VAR=" "$before" || true)"; ka="$(grep -c "^$STAGE2A_KEY_VAR=" "$after" || true)"
  [ "$kb" = "$ka" ] || { echo "env check: the key line count changed"; return 1; }
  echo "env check: only the managed storage variables differ ($(stage2a_env_managed_vars "$mode" | paste -sd' ' -)); key line count $ka unchanged"
  return 0
}

# ---- stage2a_precheck_eligibility ----
# key=value facts on stdin → the 30 pre-switch prerequisites with OK / FAIL, then
#   B25_STAGE2A_PRECHECK_CONDITIONS_FAILED=<n>
#   B25_STAGE2A_PRECHECK_ELIGIBLE=TRUE|FALSE
# A missing or malformed fact fails its condition (never defaults to a pass). Always returns 0.
stage2a_precheck_eligibility() {
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
  is_int_ge() { [[ "$(g "$1")" =~ ^(0|[1-9][0-9]*)$ ]] && [ "$(g "$1")" -ge "$2" ]; }
  cond() { n=$((n + 1)); if [ "$2" = "0" ]; then echo "pre $n: $1 — OK ($3)"; else echo "pre $n: $1 — FAIL ($3)"; failed=$((failed + 1)); fi; }
  local ok
  ok=1; is_eq head_sha "$STAGE2A_PRODUCT_SHA" && is_eq current_deploy_sha "$STAGE2A_PRODUCT_SHA" && ok=0
  cond "hosted checkout and current-deploy.sha = the locked product commit $STAGE2A_PRODUCT_SHA" $ok "head=$(g head_sha) current=$(g current_deploy_sha) previous=$(g previous_deploy_sha)"
  ok=1; is_zero dirty && is_eq worktrees 1 && ok=0
  cond "product checkout clean (no modification, single worktree)" $ok "dirty=$(g dirty) worktrees=$(g worktrees)"
  ok=1; is_true api_running && is_true web_running && is_true pg_running && is_eq api_health healthy && is_eq web_health healthy && is_eq pg_health healthy && ok=0
  cond "api / web / postgres running and healthy" $ok "api=$(g api_running)/$(g api_health) web=$(g web_running)/$(g web_health) postgres=$(g pg_running)/$(g pg_health)"
  ok=1; is_eq readyz_status ok && is_eq readyz_database ok && is_eq readyz_storage ok && ok=0
  cond "readiness status / database / storage = ok" $ok "status=$(g readyz_status) database=$(g readyz_database) storage=$(g readyz_storage)"
  ok=1; is_true lock_absent && is_true deploy_settled && ok=0
  cond "no activation lock on the host and the deployment is settled" $ok "lock_absent=$(g lock_absent) deploy_settled=$(g deploy_settled)"
  ok=1; is_true stale_worktree_absent && is_true stale_image_absent && is_zero leftover_files && ok=0
  cond "no residue of an earlier activation (ops worktree, migrate image, temporary files)" $ok "worktree_absent=$(g stale_worktree_absent) image_absent=$(g stale_image_absent) leftover_files=$(g leftover_files)"
  ok=1; is_zero storage_jobs_active && ok=0
  cond "no queued or running storage mutation job" $ok "storage_jobs_active=$(g storage_jobs_active)"
  ok=1; is_zero dead_storage_jobs && ok=0
  cond "dead storage jobs = 0" $ok "dead_storage_jobs=$(g dead_storage_jobs) dead_jobs_total=$(g dead_jobs_total)"
  ok=1; is_eq schema_fingerprint "30c4ecbd867cd2cd59abcb58581ecb04" && ok=0
  cond "schema fingerprint = the accepted post-Stage-1 fingerprint" $ok "fingerprint=$(g schema_fingerprint)"
  ok=1; is_true init_record_found && is_eq init_driver gcs && ok=0
  cond "current storage initialization record: driver = gcs" $ok "record_found=$(g init_record_found) driver=$(g init_driver)"
  ok=1; is_eq init_fallback false && ok=0
  cond "legacy fallback = false" $ok "legacyFallback=$(g init_fallback)"
  ok=1; is_eq init_mirror false && ok=0
  cond "mirror = off" $ok "mirror=$(g init_mirror)"
  ok=1; is_eq init_legacy_delete false && ok=0
  cond "legacy delete = false" $ok "legacyDelete=$(g init_legacy_delete)"
  ok=1; is_zero env_names_set && is_true banner_root_not_set && ok=0
  cond "no OBJECT_STORAGE_* variable active in the api container; banner reports the fs root as not set" $ok "names_set=$(g env_names_set) banner_root_not_set=$(g banner_root_not_set)"
  ok=1; is_true env_core_identity_ok && is_eq env_mode 600 && [[ "$(g key_line_count)" =~ ^[01]$ ]] && ok=0
  cond "env file core identity = the accepted Stage 1 file (mode 600), with at most the owner-staged key line added; the key value is never read" $ok "core_identity_ok=$(g env_core_identity_ok) mode=$(g env_mode) key_line_count=$(g key_line_count)"
  ok=1; is_true volume_exists && is_eq volume_driver local && ok=0
  cond "docker named volume $STAGE2A_VOLUME exists (local driver)" $ok "exists=$(g volume_exists) driver=$(g volume_driver)"
  ok=1; is_eq mount_type volume && is_eq mount_name "$STAGE2A_VOLUME" && is_true mount_rw && ok=0
  cond "the volume is mounted read-write at $STAGE2A_FS_ROOT in the api container" $ok "type=$(g mount_type) name=$(g mount_name) rw=$(g mount_rw)"
  ok=1; is_eq root_owner "$STAGE2A_ROOT_OWNER" && ok=0
  cond "root owner uid:gid = $STAGE2A_ROOT_OWNER (the api runtime identity)" $ok "owner=$(g root_owner)"
  ok=1; is_eq root_mode "$STAGE2A_ROOT_MODE" && ok=0
  cond "root mode = 0$STAGE2A_ROOT_MODE" $ok "mode=$(g root_mode)"
  ok=1; is_false root_is_symlink && is_true root_is_dir && ok=0
  cond "root is a directory, not a symbolic link" $ok "symlink=$(g root_is_symlink) dir=$(g root_is_dir)"
  ok=1; is_eq mount_type volume && is_zero root_regular_files && is_true root_entries_allowed && ok=0
  cond "root is persistent volume storage (not an image layer) and holds no object (only the health namespace may exist)" $ok "mount_type=$(g mount_type) regular_files=$(g root_regular_files) entries_allowed=$(g root_entries_allowed)"
  ok=1; is_int_ge disk_avail_bytes "$STAGE2A_MIN_DISK_BYTES" && is_int_ge inodes_free "$STAGE2A_MIN_INODES" && ok=0
  cond "capacity: free bytes ≥ $STAGE2A_MIN_DISK_BYTES and free inodes ≥ $STAGE2A_MIN_INODES" $ok "disk_avail_bytes=$(g disk_avail_bytes) inodes_free=$(g inodes_free)"
  ok=1; is_eq exc_row_count 1 && is_eq exc_state deleted && is_eq exc_last_error LEGACY_RETAINED && is_eq exc_driver gcs && is_eq exc_company "$B25PHYS_COMPANY" && is_eq exc_kind document && is_eq exc_size "$B25PHYS_OBJECT_SIZE" && is_true exc_identity_ok && is_false exc_uncertain && is_false exc_lease && is_false exc_mirror && is_zero exc_live_refs && is_true exc_company_absent && is_true exc_provider_present && is_true exc_provider_marker_ok && is_true exc_provider_size_matches && is_true exc_generation_canonical && is_true exc_generation_stable && is_eq exc_generation_digest "$B25PHYS_PRE_GEN_DIGEST" && ok=0
  cond "Stage 1 exception exact and isolated (row $B25PHYS_UUID deleted / LEGACY_RETAINED / gcs / company $B25PHYS_COMPANY absent / 0 live references; provider object present, marker, size $B25PHYS_OBJECT_SIZE, canonical stable generation with the proven digest)" $ok "rows=$(g exc_row_count) state=$(g exc_state) last_error=$(g exc_last_error) driver=$(g exc_driver) company=$(g exc_company) kind=$(g exc_kind) size=$(g exc_size) identity=$(g exc_identity_ok) uncertain=$(g exc_uncertain) lease=$(g exc_lease) mirror=$(g exc_mirror) live_refs=$(g exc_live_refs) company_absent=$(g exc_company_absent) present=$(g exc_provider_present) marker=$(g exc_provider_marker_ok) size_matches=$(g exc_provider_size_matches) canonical=$(g exc_generation_canonical) stable=$(g exc_generation_stable) digest=$(g exc_generation_digest)"
  ok=1; is_zero inv_uncertain && ok=0
  cond "provider-uncertain rows = 0" $ok "uncertain=$(g inv_uncertain)"
  ok=1; is_zero inv_unproven && ok=0
  cond "OWNERSHIP_UNPROVEN rows = 0" $ok "unproven=$(g inv_unproven)"
  ok=1; is_zero inv_cleanup_pending && ok=0
  cond "CLEANUP_PENDING rows = 0" $ok "cleanup_pending=$(g inv_cleanup_pending)"
  ok=1; is_zero inv_leases && is_zero inv_inflight && is_eq inv_total 1 && is_zero inv_active && ok=0
  cond "no lease, no in-flight row; the inventory is exactly the one exception row (0 active)" $ok "leases=$(g inv_leases) inflight=$(g inv_inflight) total=$(g inv_total) active=$(g inv_active)"
  ok=1; is_eq census_objects "$B25PHYS_CENSUS_OBJECTS" && is_eq census_bytes "$B25PHYS_CENSUS_BYTES" && is_eq census_marked "$B25PHYS_CENSUS_MARKED" && is_eq census_md5 "$B25PHYS_CENSUS_MD5" && ok=0
  cond "provider census exactly $B25PHYS_CENSUS_OBJECTS / $B25PHYS_CENSUS_BYTES / $B25PHYS_CENSUS_MARKED / $B25PHYS_CENSUS_MD5" $ok "objects=$(g census_objects) bytes=$(g census_bytes) marked=$(g census_marked) md5=$(g census_md5)"
  ok=1; is_eq unmarked_objects 4 && is_eq unmarked_md5 "$B25PHYS_ORIGINALS_MD5" && ok=0
  cond "the four original objects unchanged ($B25PHYS_ORIGINALS_MD5)" $ok "unmarked_objects=$(g unmarked_objects) unmarked_md5=$(g unmarked_md5)"
  ok=1; is_eq refs_count 4 && is_eq originals_referenced 4 && is_eq originals_present 4 && is_zero originals_missing && is_eq originals_size_match 4 && ok=0
  cond "original legacy references 4/4 present at the provider and size-matched" $ok "references=$(g refs_count) referenced=$(g originals_referenced) present=$(g originals_present) missing=$(g originals_missing) size_match=$(g originals_size_match)"
  echo "B25_STAGE2A_PRECHECK_CONDITIONS_FAILED=$failed"
  if [ "$failed" = "0" ]; then echo "B25_STAGE2A_PRECHECK_ELIGIBLE=TRUE"; else echo "B25_STAGE2A_PRECHECK_ELIGIBLE=FALSE"; fi
  return 0
}

# ---- stage2a_postswitch_eligibility ----
# key=value facts on stdin → the 22 post-switch prerequisites with OK / FAIL, then
#   B25_STAGE2A_POSTSWITCH_CONDITIONS_FAILED=<n>
#   B25_STAGE2A_POSTSWITCH_READY=TRUE|FALSE
# The /metrics endpoint is platform-owner gated, so this READ-ONLY verifier proves the same runtime
# configuration from the api's own startup record ("Object storage initialized": driver / legacyFallback /
# mirror / legacyDelete / encryption), the entrypoint banner and the container environment (fixed values
# compared inside the container, never printed), and the failure counters from the database and from the
# counted log records that increment them; the disposable smoke reads /metrics through its own owner.
stage2a_postswitch_eligibility() {
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
  cond() { n=$((n + 1)); if [ "$2" = "0" ]; then echo "post-switch $n: $1 — OK ($3)"; else echo "post-switch $n: $1 — FAIL ($3)"; failed=$((failed + 1)); fi; }
  local ok
  ok=1; is_eq head_sha "$STAGE2A_PRODUCT_SHA" && is_eq current_deploy_sha "$STAGE2A_PRODUCT_SHA" && is_zero dirty && ok=0
  cond "hosted checkout and current-deploy.sha = the locked product commit, clean" $ok "head=$(g head_sha) current=$(g current_deploy_sha) dirty=$(g dirty)"
  ok=1; is_true api_running && is_eq api_health healthy && is_eq web_health healthy && is_eq pg_health healthy && ok=0
  cond "api running and healthy; web and postgres healthy" $ok "api=$(g api_running)/$(g api_health) web=$(g web_health) postgres=$(g pg_health)"
  ok=1; is_eq readyz_status ok && is_eq readyz_database ok && is_eq readyz_storage ok && is_eq readyz_inside ok && ok=0
  cond "readiness ok / database ok / storage ok (through the proxy and inside the api container)" $ok "status=$(g readyz_status) database=$(g readyz_database) storage=$(g readyz_storage) inside=$(g readyz_inside)"
  ok=1; is_eq banner_driver fs && is_true banner_root_set && is_true banner_key_set && is_eq banner_fallback true && is_eq banner_mirror gcs && ok=0
  cond "entrypoint banner: driver fs, fs root (set), encryption key (set), fallback true, mirror gcs" $ok "driver=$(g banner_driver) root_set=$(g banner_root_set) key_set=$(g banner_key_set) fallback=$(g banner_fallback) mirror=$(g banner_mirror)"
  ok=1; is_true init_record_found && is_eq init_driver fs && ok=0
  cond "storage initialization record (current process): driver = fs" $ok "record_found=$(g init_record_found) driver=$(g init_driver)"
  ok=1; is_eq init_fallback true && ok=0
  cond "legacy fallback = true (pre-B25 references stay readable from the bucket)" $ok "legacyFallback=$(g init_fallback)"
  ok=1; is_eq init_mirror true && ok=0
  cond "strict mirror = enabled (fs primary + verified bucket copy)" $ok "mirror=$(g init_mirror)"
  ok=1; is_eq init_legacy_delete false && ok=0
  cond "legacy delete = false" $ok "legacyDelete=$(g init_legacy_delete)"
  ok=1; is_eq init_encryption configured && ok=0
  cond "encryption = configured (the owner's key, never the ephemeral test key)" $ok "encryption=$(g init_encryption)"
  ok=1; is_true env_driver_is_fs && is_true env_root_is_locked && is_true env_fallback_is_true && is_true env_mirror_is_gcs && is_true env_legacy_delete_off && is_true env_key_set && ok=0
  cond "api container environment = exactly the locked activation set (compared inside the container; values never printed); key present" $ok "driver_fs=$(g env_driver_is_fs) root_locked=$(g env_root_is_locked) fallback_true=$(g env_fallback_is_true) mirror_gcs=$(g env_mirror_is_gcs) legacy_delete_off=$(g env_legacy_delete_off) key_set=$(g env_key_set)"
  ok=1; is_true env_file_managed_ok && is_eq env_file_key_lines 1 && is_eq env_mode 600 && is_true env_core_identity_ok && ok=0
  cond "VPS env file: managed lines = the fixed activation set, exactly one key line, mode 600, every other line = the accepted Stage 1 content" $ok "managed_ok=$(g env_file_managed_ok) key_lines=$(g env_file_key_lines) mode=$(g env_mode) core_identity_ok=$(g env_core_identity_ok)"
  ok=1; is_zero log_mirror_failures && is_zero log_integrity_failures && is_zero log_init_failures && ok=0
  cond "mirror failures = 0, integrity failures = 0, initialization failures = 0 (counted log records of the current process)" $ok "mirror_failures=$(g log_mirror_failures) integrity_failures=$(g log_integrity_failures) init_failures=$(g log_init_failures)"
  ok=1; is_zero log_level50 && is_zero log_status5xx && ok=0
  cond "no error-level record and no 5xx response since the switch" $ok "level50=$(g log_level50) status5xx=$(g log_status5xx)"
  ok=1; is_zero inv_uncertain && is_zero inv_unproven && is_zero inv_cleanup_pending && ok=0
  cond "publication uncertainty = 0, ownership unproven = 0, cleanup pending = 0" $ok "uncertain=$(g inv_uncertain) unproven=$(g inv_unproven) cleanup_pending=$(g inv_cleanup_pending)"
  ok=1; is_eq inv_retained_legacy 1 && is_eq inv_total 1 && is_zero inv_active && is_zero inv_leases && ok=0
  cond "retainedLegacyObjects = 1 and the inventory is still exactly the one exception row (0 active, no lease)" $ok "retained=$(g inv_retained_legacy) total=$(g inv_total) active=$(g inv_active) leases=$(g inv_leases)"
  ok=1; is_eq exc_row_count 1 && is_eq exc_state deleted && is_eq exc_last_error LEGACY_RETAINED && is_eq exc_driver gcs && is_true exc_identity_ok && is_false exc_uncertain && is_zero exc_live_refs && ok=0
  cond "Stage 1 exception row still deleted / LEGACY_RETAINED / gcs with its identity and 0 live references" $ok "rows=$(g exc_row_count) state=$(g exc_state) last_error=$(g exc_last_error) driver=$(g exc_driver) identity=$(g exc_identity_ok) uncertain=$(g exc_uncertain) live_refs=$(g exc_live_refs)"
  ok=1; is_true exc_provider_present && is_true exc_provider_marker_ok && is_true exc_provider_size_matches && is_true exc_generation_canonical && is_true exc_generation_stable && is_eq exc_generation_digest "$B25PHYS_PRE_GEN_DIGEST" && ok=0
  cond "Stage 1 provider object still present and unchanged (marker, size, canonical stable generation, proven digest)" $ok "present=$(g exc_provider_present) marker=$(g exc_provider_marker_ok) size_matches=$(g exc_provider_size_matches) canonical=$(g exc_generation_canonical) stable=$(g exc_generation_stable) digest=$(g exc_generation_digest)"
  ok=1; is_eq census_objects "$B25PHYS_CENSUS_OBJECTS" && is_eq census_bytes "$B25PHYS_CENSUS_BYTES" && is_eq census_marked "$B25PHYS_CENSUS_MARKED" && is_eq census_md5 "$B25PHYS_CENSUS_MD5" && ok=0
  cond "provider inventory unchanged before any smoke: $B25PHYS_CENSUS_OBJECTS / $B25PHYS_CENSUS_BYTES / $B25PHYS_CENSUS_MARKED / $B25PHYS_CENSUS_MD5" $ok "objects=$(g census_objects) bytes=$(g census_bytes) marked=$(g census_marked) md5=$(g census_md5)"
  ok=1; is_eq unmarked_objects 4 && is_eq unmarked_md5 "$B25PHYS_ORIGINALS_MD5" && is_eq refs_count 4 && is_eq originals_present 4 && is_zero originals_missing && is_eq originals_size_match 4 && ok=0
  cond "original legacy objects unchanged and references 4/4 present" $ok "unmarked_objects=$(g unmarked_objects) unmarked_md5=$(g unmarked_md5) references=$(g refs_count) present=$(g originals_present) missing=$(g originals_missing) size_match=$(g originals_size_match)"
  ok=1; is_eq mount_type volume && is_eq mount_name "$STAGE2A_VOLUME" && is_true mount_rw && is_eq root_owner "$STAGE2A_ROOT_OWNER" && is_eq root_mode "$STAGE2A_ROOT_MODE" && is_false root_is_symlink && is_true root_is_dir && is_true root_writable && is_zero root_tenant_files && is_true root_entries_allowed && ok=0
  cond "filesystem root: the named volume, $STAGE2A_ROOT_OWNER / 0$STAGE2A_ROOT_MODE, directory, writable by the runtime, no tenant object yet, only the health namespace" $ok "type=$(g mount_type) name=$(g mount_name) rw=$(g mount_rw) owner=$(g root_owner) mode=$(g root_mode) symlink=$(g root_is_symlink) dir=$(g root_is_dir) writable=$(g root_writable) tenant_files=$(g root_tenant_files) entries_allowed=$(g root_entries_allowed)"
  ok=1; is_zero leak_root_path && is_zero leak_key_shaped && is_zero leak_key_assignment && is_zero leak_bucket_ref && is_zero leak_signature && is_zero web_leak_root_path && is_zero web_leak_signature && ok=0
  cond "no plaintext storage path, key-shaped token, key assignment, bucket reference or signed-URL text in the api / web logs" $ok "root_path=$(g leak_root_path) key_shaped=$(g leak_key_shaped) key_assignment=$(g leak_key_assignment) bucket_ref=$(g leak_bucket_ref) signature=$(g leak_signature) web_root_path=$(g web_leak_root_path) web_signature=$(g web_leak_signature)"
  ok=1; is_eq init_records_current 1 && is_zero log_refusals && ok=0
  cond "the current process initialized storage exactly once and never refused to start" $ok "init_records=$(g init_records_current) refusals=$(g log_refusals)"
  echo "B25_STAGE2A_POSTSWITCH_CONDITIONS_FAILED=$failed"
  if [ "$failed" = "0" ]; then echo "B25_STAGE2A_POSTSWITCH_READY=TRUE"; else echo "B25_STAGE2A_POSTSWITCH_READY=FALSE"; fi
  return 0
}
