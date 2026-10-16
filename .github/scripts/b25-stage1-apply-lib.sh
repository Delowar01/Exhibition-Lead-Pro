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
readonly B25PHYS_CENSUS_MARKED=1          # objects carrying the lcp-object-id marker (with_marker); the run-38847884691 census read 0 generationless / 1 with_marker
readonly B25PHYS_CENSUS_GENERATIONLESS=0
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

# =============================================================================
# B25 STAGE 2A — CORRECTION 1: EXACT RESIDUE OF THE FAILED SMOKE RUN 38847884691
# (tag 1c512c90f2c8). That run's VPS-side verification stopped on a TOOLING
# assertion (the stored-logo digest was compared against the UPLOADED bytes
# although the product normalizes every logo before storing it — lib/branding/
# logo.ts); its always-step cleanup removed the disposable principals but, by
# design, never removes storage rows, so TWO plain `deleted` tombstones of the
# deleted company 54 remain (fs primary and mirror copy reported removed by the
# product's company purge: state deleted, last_error NULL, nothing retained).
# This block binds the settlement to EXACTLY that residue by READONLY CONSTANTS —
# never a workflow input — and provides the two pure evaluators the local test
# suite exercises with golden facts and mutations:
#   stage2a_residue_eligibility   key=value facts → 26 prerequisites (the 21
#                                 review-listed ones + 5 fail-closed physical /
#                                 census proofs) → B25_STAGE2A_RESIDUE_ELIGIBLE
#   stage2a_residue_settled       key=value facts → 12 post-settlement proofs →
#                                 B25_STAGE2A_RESIDUE_SETTLED
# The Stage 1 exception (row f048b5d4…, company 53) is denied by constant here,
# in the allow-list (stage2a_purge_rows_sql) and in every SQL predicate of the
# hosted phases. Nothing here touches a bucket, a file, a row or a key.
# =============================================================================
readonly S2AR_RUN="38847884691"
readonly S2AR_TAG="1c512c90f2c8"
readonly S2AR_COMPANY=54
readonly S2AR_COMPANIES="54,55"
readonly S2AR_USERS="101"
readonly S2AR_UUID_DOC="593fd8be-72be-4798-b56a-e3af02574dfb"
readonly S2AR_UUID_LOGO="b3cf7f44-8d23-4eae-8d44-27e4138a0249"
readonly S2AR_DOC_SIZE=21546
readonly S2AR_LOGO_SIZE=181
readonly S2AR_ROWS=2
readonly S2AR_UUIDS_Q="'$S2AR_UUID_DOC','$S2AR_UUID_LOGO'"
readonly S2AR_MANIFEST="$S2AR_UUID_DOC,$S2AR_UUID_LOGO|$S2AR_COMPANIES|$S2AR_USERS|$S2AR_TAG"
# Both rows were created during the smoke run (upload intent 03:55:36Z, logo upload 03:55:45Z) and tombstoned by
# the API deletion of tenant 54 (03:55:53Z; both rows read `deleted` at 03:55:59Z) — run 38847884691 log.
readonly S2AR_CREATED_FROM="2026-10-16 03:55:30"
readonly S2AR_CREATED_TO="2026-10-16 03:56:00"
readonly S2AR_DELETED_FROM="2026-10-16 03:55:50"
readonly S2AR_DELETED_TO="2026-10-16 03:57:00"
s2ar_kind() { case "$1" in "$S2AR_UUID_DOC") echo document;; "$S2AR_UUID_LOGO") echo branding_logo;; *) return 1;; esac; }
s2ar_size() { case "$1" in "$S2AR_UUID_DOC") echo "$S2AR_DOC_SIZE";; "$S2AR_UUID_LOGO") echo "$S2AR_LOGO_SIZE";; *) return 1;; esac; }
# The constants can never name the Stage 1 exception (row or company) — checked by the evaluator as well.
s2ar_constants_ok() {
  [ "$S2AR_UUID_DOC" != "$B25PHYS_UUID" ] && [ "$S2AR_UUID_LOGO" != "$B25PHYS_UUID" ] && [ "$S2AR_UUID_DOC" != "$S2AR_UUID_LOGO" ] \
    && [ "$S2AR_COMPANY" != "$B25PHYS_COMPANY" ] && [[ ",$S2AR_COMPANIES," != *",$B25PHYS_COMPANY,"* ]] && [[ ",$S2AR_COMPANIES," == *",$S2AR_COMPANY,"* ]] \
    && [[ "$S2AR_UUID_DOC" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] && [[ "$S2AR_UUID_LOGO" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
    && [ "$S2AR_ROWS" = "2" ]
}

# ---- s2ar_read_facts: shared fact reader of the two evaluators (facts on stdin → associative array `f`) ----
s2ar_read_facts() {
  local line k v
  while IFS= read -r line; do
    [[ "$line" =~ ^([a-z0-9_]+)=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"; f[$k]="$v"
  done
}

# ---- stage2a_residue_eligibility ----
# key=value facts on stdin → the 26 settlement prerequisites with OK / FAIL, then
#   B25_STAGE2A_${MK}_CONDITIONS_FAILED=<n>
#   B25_STAGE2A_${MK}_ELIGIBLE=TRUE|FALSE
# A missing or malformed fact fails its condition (never defaults to a pass). Always returns 0.
stage2a_residue_eligibility_for() {   # <manifest prefix: S2AR | S2AR2 | S2AR3> <marker: RESIDUE | RESIDUE2 | RESIDUE3>
  local P="$1" MK="$2"
  [[ "$P" =~ ^S2AR[23]?$ ]] && [[ "$MK" =~ ^RESIDUE[23]?$ ]] || { echo "stage2a_residue_eligibility_for: unknown manifest" >&2; return 1; }
  local -n M_RUN="${P}_RUN" M_TAG="${P}_TAG" M_COMPANY="${P}_COMPANY" M_COMPANIES="${P}_COMPANIES" M_USERS="${P}_USERS" M_UUID_DOC="${P}_UUID_DOC" M_UUID_LOGO="${P}_UUID_LOGO" M_DOC_SIZE="${P}_DOC_SIZE" M_LOGO_SIZE="${P}_LOGO_SIZE" M_ROWS="${P}_ROWS"
  local -A f=()
  s2ar_read_facts
  local failed=0 n=0
  g() { printf '%s' "${f[$1]:-<missing>}"; }
  is_true() { [ "$(g "$1")" = "true" ]; }
  is_false() { [ "$(g "$1")" = "false" ]; }
  is_zero() { [ "$(g "$1")" = "0" ]; }
  is_eq() { [ "$(g "$1")" = "$2" ]; }
  cond() { n=$((n + 1)); if [ "$2" = "0" ]; then echo "res $n: $1 — OK ($3)"; else echo "res $n: $1 — FAIL ($3)"; failed=$((failed + 1)); fi; }
  local ok R="$M_ROWS"
  ok=1; is_eq head_sha "$STAGE2A_PRODUCT_SHA" && is_eq current_deploy_sha "$STAGE2A_PRODUCT_SHA" && is_zero dirty && ok=0
  cond "hosted product commit is still $STAGE2A_PRODUCT_SHA (checkout and current-deploy.sha; clean)" $ok "head=$(g head_sha) current=$(g current_deploy_sha) dirty=$(g dirty)"
  ok=1; is_true init_record_found && is_eq init_driver fs && is_eq init_fallback true && is_eq init_mirror true && is_eq init_legacy_delete false && is_true env_driver_is_fs && is_true env_root_is_locked && is_true env_fallback_is_true && is_true env_mirror_is_gcs && is_true env_legacy_delete_off && is_true env_key_set && ok=0
  cond "storage configuration is still DRIVER=fs / FS_ROOT=$STAGE2A_FS_ROOT / LEGACY_FALLBACK=true / MIRROR=gcs / LEGACY_DELETE=false (startup record and container environment; key present, never read)" $ok "record=$(g init_record_found) driver=$(g init_driver) fallback=$(g init_fallback) mirror=$(g init_mirror) legacy_delete=$(g init_legacy_delete) env_fs=$(g env_driver_is_fs) env_root=$(g env_root_is_locked) env_fallback=$(g env_fallback_is_true) env_mirror=$(g env_mirror_is_gcs) env_legacy_delete_off=$(g env_legacy_delete_off) key_set=$(g env_key_set)"
  ok=1; is_true lock_absent && is_true env_record_present && is_true env_core_identity_ok && is_eq env_mode 600 && is_eq key_line_count 1 && is_true env_file_managed_ok && ok=0
  cond "no activation lock; the activation env record still matches the env file (core identity, mode 600, exactly one key line, managed lines = the fixed activation set)" $ok "lock_absent=$(g lock_absent) record_present=$(g env_record_present) core_identity_ok=$(g env_core_identity_ok) mode=$(g env_mode) key_line_count=$(g key_line_count) managed_ok=$(g env_file_managed_ok)"
  ok=1; is_zero res_companies_present && ok=0
  cond "company $M_COMPANY is absent (and every other company of $M_COMPANIES and every 'B25 SMOKE $M_TAG' tenant)" $ok "companies_present=$(g res_companies_present)"
  ok=1; is_zero res_users_present && is_zero res_sessions && is_zero res_feature_rows && ok=0
  cond "the disposable identities of run $M_RUN are absent (user $M_USERS, every b25-smoke-$M_TAG address, sessions, feature / audit / activity / login rows)" $ok "users_present=$(g res_users_present) sessions=$(g res_sessions) feature_rows=$(g res_feature_rows)"
  ok=1; is_eq res_rows_named "$R" && ok=0
  cond "exactly the two named company-$M_COMPANY storage rows exist ($M_UUID_DOC, $M_UUID_LOGO)" $ok "rows_named=$(g res_rows_named)"
  ok=1; is_zero res_rows_other && is_zero res_rows_wrong_company && ok=0
  cond "no third storage row of companies $M_COMPANIES exists and neither named row belongs to another company" $ok "rows_other=$(g res_rows_other) rows_wrong_company=$(g res_rows_wrong_company)"
  ok=1; is_eq res_rows_deleted "$R" && ok=0
  cond "both rows are state = deleted" $ok "rows_deleted=$(g res_rows_deleted)"
  ok=1; is_eq res_rows_fs "$R" && ok=0
  cond "both rows are driver = fs" $ok "rows_fs=$(g res_rows_fs)"
  ok=1; is_eq res_rows_legacy_null "$R" && ok=0
  cond "legacy_key is null on both rows" $ok "rows_legacy_null=$(g res_rows_legacy_null)"
  ok=1; is_eq res_rows_mirror_canonical "$R" && is_eq res_rows_mirror_ok "$R" && ok=0
  cond "mirror_key exists and is the canonical bucket location of storage_key, mirror_state = ok, on both rows" $ok "rows_mirror_canonical=$(g res_rows_mirror_canonical) rows_mirror_ok=$(g res_rows_mirror_ok)"
  ok=1; is_eq res_rows_error_null "$R" && ok=0
  cond "last_error is null on both rows (nothing retained, unproven or cleanup-pending)" $ok "rows_error_null=$(g res_rows_error_null)"
  ok=1; is_eq res_rows_not_uncertain "$R" && ok=0
  cond "publication_uncertain_at is null on both rows" $ok "rows_not_uncertain=$(g res_rows_not_uncertain)"
  ok=1; is_eq res_rows_no_lease "$R" && ok=0
  cond "lease_token and lease_expires_at are cleared on both rows" $ok "rows_no_lease=$(g res_rows_no_lease)"
  ok=1; is_eq res_rows_deleted_at_set "$R" && is_eq res_rows_deleted_in_window "$R" && ok=0
  cond "deleted_at is set on both rows and lies in the tenant-deletion window of run $M_RUN" $ok "rows_deleted_at_set=$(g res_rows_deleted_at_set) rows_deleted_in_window=$(g res_rows_deleted_in_window)"
  ok=1; is_zero res_live_refs && is_zero res_docs_company && is_zero res_brand_refs && ok=0
  cond "no live document / company / branding association (no document version, export, report, scan or brand_logo_key references either row; no document of company $M_COMPANY)" $ok "live_refs=$(g res_live_refs) docs_company=$(g res_docs_company) brand_refs=$(g res_brand_refs)"
  ok=1; is_true res_constants_ok && is_zero res_rows_exception && ok=0
  cond "neither uuid is the Stage 1 exception $B25PHYS_UUID (constants and rows)" $ok "constants_ok=$(g res_constants_ok) rows_exception=$(g res_rows_exception)"
  ok=1; is_true res_constants_ok && is_zero res_rows_company53 && [ "$M_COMPANY" != "$B25PHYS_COMPANY" ] && ok=0
  cond "company != $B25PHYS_COMPANY (constants and rows)" $ok "constants_ok=$(g res_constants_ok) rows_company53=$(g res_rows_company53)"
  ok=1; is_zero res_foreign_mentions && is_zero res_jobs_pending && is_zero res_inflight_sessions && ok=0
  cond "no cross-tenant / live reference: no other storage row mentions a residue id, no pending or running job references the residue, no in-flight database session on storage_objects" $ok "foreign_mentions=$(g res_foreign_mentions) jobs_pending=$(g res_jobs_pending) inflight_sessions=$(g res_inflight_sessions)"
  ok=1; is_eq exc_row_count 1 && is_eq exc_state deleted && is_eq exc_last_error LEGACY_RETAINED && is_eq exc_driver gcs && is_eq exc_company "$B25PHYS_COMPANY" && is_eq exc_kind document && is_eq exc_size "$B25PHYS_OBJECT_SIZE" && is_true exc_identity_ok && is_false exc_uncertain && is_false exc_lease && is_false exc_mirror && is_zero exc_live_refs && is_true exc_company_absent && is_true exc_provider_present && is_true exc_provider_marker_ok && is_true exc_provider_size_matches && is_true exc_generation_canonical && is_true exc_generation_stable && is_eq exc_generation_digest "$B25PHYS_PRE_GEN_DIGEST" && ok=0
  cond "Stage 1 exception still exactly intact (row $B25PHYS_UUID deleted / LEGACY_RETAINED / gcs / company $B25PHYS_COMPANY absent / 0 live references; provider object present, marker, size $B25PHYS_OBJECT_SIZE, canonical stable generation with the proven digest)" $ok "rows=$(g exc_row_count) state=$(g exc_state) last_error=$(g exc_last_error) driver=$(g exc_driver) company=$(g exc_company) kind=$(g exc_kind) size=$(g exc_size) identity=$(g exc_identity_ok) uncertain=$(g exc_uncertain) lease=$(g exc_lease) mirror=$(g exc_mirror) live_refs=$(g exc_live_refs) company_absent=$(g exc_company_absent) present=$(g exc_provider_present) marker=$(g exc_provider_marker_ok) size_matches=$(g exc_provider_size_matches) canonical=$(g exc_generation_canonical) stable=$(g exc_generation_stable) digest=$(g exc_generation_digest)"
  ok=1; is_eq inv_total 3 && is_zero res_inv_outside && is_zero inv_uncertain && is_zero inv_unproven && is_zero inv_cleanup_pending && is_zero inv_leases && is_zero inv_inflight && ok=0
  cond "no unexpected storage_objects row outside the exception and the two tombstones (total 3; none uncertain / unproven / cleanup-pending / leased / in flight)" $ok "total=$(g inv_total) outside=$(g res_inv_outside) uncertain=$(g inv_uncertain) unproven=$(g inv_unproven) cleanup_pending=$(g inv_cleanup_pending) leases=$(g inv_leases) inflight=$(g inv_inflight)"
  ok=1; is_eq res_rows_identity_ok "$R" && is_eq res_rows_created_in_window "$R" && is_eq res_doc_size "$M_DOC_SIZE" && is_eq res_logo_size "$M_LOGO_SIZE" && ok=0
  cond "row identity: document $M_DOC_SIZE bytes and branding_logo $M_LOGO_SIZE bytes (sizes read from the rows; the logo size must equal the normalized served-object size observed by the run) with the product-shaped reference and key, a 64-hex digest and a content type, both created in the smoke window of run $M_RUN" $ok "rows_identity_ok=$(g res_rows_identity_ok) rows_created_in_window=$(g res_rows_created_in_window) doc_size=$(g res_doc_size) logo_size=$(g res_logo_size)"
  ok=1; is_true api_running && is_eq api_health healthy && is_eq readyz_status ok && is_eq readyz_database ok && is_eq readyz_storage ok && is_zero dead_jobs_total && is_zero storage_jobs_active && is_eq schema_fingerprint "30c4ecbd867cd2cd59abcb58581ecb04" && ok=0
  cond "api running and healthy, readiness ok / ok / ok, no dead job, no active storage job, schema fingerprint = the accepted post-Stage-1 fingerprint" $ok "api=$(g api_running)/$(g api_health) readyz=$(g readyz_status)/$(g readyz_database)/$(g readyz_storage) dead_jobs=$(g dead_jobs_total) storage_jobs_active=$(g storage_jobs_active) fingerprint=$(g schema_fingerprint)"
  ok=1; is_eq res_fs_checked "$R" && is_eq res_fs_absent "$R" && is_zero res_fs_tenant_files && ok=0
  cond "FS PRIMARY ABSENT: the encrypted file of each row is absent at its stored key and no file remains under the tenant directories of companies $M_COMPANIES (nothing is deleted to make this true)" $ok "fs_checked=$(g res_fs_checked) fs_absent=$(g res_fs_absent) tenant_files=$(g res_fs_tenant_files) tenant_dirs=$(g res_fs_tenant_dirs)"
  ok=1; is_true res_prov_read_ok && is_eq res_prov_checked "$R" && is_eq res_prov_absent "$R" && ok=0
  cond "GCS MIRROR ABSENT: every persisted provider location of each row answers 404 (provider read succeeded — a read failure is NOT absence)" $ok "provider_read_ok=$(g res_prov_read_ok) provider_checked=$(g res_prov_checked) provider_absent=$(g res_prov_absent)"
  ok=1; is_eq census_objects "$B25PHYS_CENSUS_OBJECTS" && is_eq census_bytes "$B25PHYS_CENSUS_BYTES" && is_eq census_marked "$B25PHYS_CENSUS_MARKED" && is_eq census_generationless "$B25PHYS_CENSUS_GENERATIONLESS" && is_eq census_md5 "$B25PHYS_CENSUS_MD5" && is_eq unmarked_objects 4 && is_eq unmarked_md5 "$B25PHYS_ORIGINALS_MD5" && is_eq originals_present 4 && is_zero originals_missing && is_eq originals_size_match 4 && ok=0
  cond "bucket census = the locked baseline ($B25PHYS_CENSUS_OBJECTS / $B25PHYS_CENSUS_BYTES / marked $B25PHYS_CENSUS_MARKED / generationless $B25PHYS_CENSUS_GENERATIONLESS / $B25PHYS_CENSUS_MD5) and the four originals intact" $ok "objects=$(g census_objects) bytes=$(g census_bytes) marked=$(g census_marked) generationless=$(g census_generationless) md5=$(g census_md5) unmarked_objects=$(g unmarked_objects) unmarked_md5=$(g unmarked_md5) originals_present=$(g originals_present) missing=$(g originals_missing) size_match=$(g originals_size_match)"
  echo "B25_STAGE2A_${MK}_CONDITIONS_FAILED=$failed"
  if [ "$failed" = "0" ]; then echo "B25_STAGE2A_${MK}_ELIGIBLE=TRUE"; else echo "B25_STAGE2A_${MK}_ELIGIBLE=FALSE"; fi
  return 0
}

# ---- stage2a_residue_settled_for <prefix> <marker> ----
# Wrappers: stage2a_residue_settled (S2AR / RESIDUE) and stage2a_residue2_settled (S2AR2 / RESIDUE2).
# key=value facts (read AFTER the row removal, the fs / provider absence facts re-read with the key blobs captured
# BEFORE it) on stdin → the 12 post-settlement proofs with OK / FAIL, then
#   B25_STAGE2A_${MK}_SETTLED_CONDITIONS_FAILED=<n>
#   B25_STAGE2A_${MK}_SETTLED=TRUE|FALSE
# A missing or malformed fact fails its proof. Always returns 0.
stage2a_residue_settled_for() {   # <manifest prefix: S2AR | S2AR2 | S2AR3> <marker: RESIDUE | RESIDUE2 | RESIDUE3>
  local P="$1" MK="$2"
  [[ "$P" =~ ^S2AR[23]?$ ]] && [[ "$MK" =~ ^RESIDUE[23]?$ ]] || { echo "stage2a_residue_settled_for: unknown manifest" >&2; return 1; }
  local -n M_RUN="${P}_RUN" M_TAG="${P}_TAG" M_COMPANY="${P}_COMPANY" M_COMPANIES="${P}_COMPANIES" M_USERS="${P}_USERS" M_UUID_DOC="${P}_UUID_DOC" M_UUID_LOGO="${P}_UUID_LOGO" M_DOC_SIZE="${P}_DOC_SIZE" M_LOGO_SIZE="${P}_LOGO_SIZE" M_ROWS="${P}_ROWS"
  local -A f=()
  s2ar_read_facts
  local failed=0 n=0
  g() { printf '%s' "${f[$1]:-<missing>}"; }
  is_true() { [ "$(g "$1")" = "true" ]; }
  is_false() { [ "$(g "$1")" = "false" ]; }
  is_zero() { [ "$(g "$1")" = "0" ]; }
  is_eq() { [ "$(g "$1")" = "$2" ]; }
  cond() { n=$((n + 1)); if [ "$2" = "0" ]; then echo "post $n: $1 — OK ($3)"; else echo "post $n: $1 — FAIL ($3)"; failed=$((failed + 1)); fi; }
  local ok R="$M_ROWS"
  ok=1; is_zero res_rows_named && ok=0
  cond "the two tombstones $M_UUID_DOC and $M_UUID_LOGO are absent" $ok "rows_named=$(g res_rows_named)"
  ok=1; is_zero res_companies_present && is_zero res_rows_other && ok=0
  cond "company $M_COMPANY absent; no storage row of companies $M_COMPANIES remains" $ok "companies_present=$(g res_companies_present) rows_other=$(g res_rows_other)"
  ok=1; is_zero res_users_present && is_zero res_sessions && is_zero res_feature_rows && ok=0
  cond "no disposable identity of run $M_RUN remains" $ok "users_present=$(g res_users_present) sessions=$(g res_sessions) feature_rows=$(g res_feature_rows)"
  ok=1; is_eq res_fs_checked "$R" && is_eq res_fs_absent "$R" && is_zero res_fs_tenant_files && is_zero root_tenant_files && ok=0
  cond "no tenant-$M_COMPANY file on the volume: both stored keys (captured before the removal) absent, no file under the tenant directories, no tenant file anywhere under the root" $ok "fs_checked=$(g res_fs_checked) fs_absent=$(g res_fs_absent) tenant_files=$(g res_fs_tenant_files) root_tenant_files=$(g root_tenant_files)"
  ok=1; is_true res_prov_read_ok && is_eq res_prov_checked "$R" && is_eq res_prov_absent "$R" && ok=0
  cond "no corresponding mirror object: every persisted provider location (captured before the removal) answers 404; provider read succeeded" $ok "provider_read_ok=$(g res_prov_read_ok) provider_checked=$(g res_prov_checked) provider_absent=$(g res_prov_absent)"
  ok=1; is_eq exc_row_count 1 && is_eq exc_state deleted && is_eq exc_last_error LEGACY_RETAINED && is_eq exc_driver gcs && is_eq exc_company "$B25PHYS_COMPANY" && is_eq exc_kind document && is_eq exc_size "$B25PHYS_OBJECT_SIZE" && is_true exc_identity_ok && is_false exc_uncertain && is_false exc_lease && is_false exc_mirror && is_zero exc_live_refs && is_true exc_company_absent && is_true exc_provider_present && is_true exc_provider_marker_ok && is_true exc_provider_size_matches && is_true exc_generation_canonical && is_true exc_generation_stable && is_eq exc_generation_digest "$B25PHYS_PRE_GEN_DIGEST" && ok=0
  cond "Stage 1 exception $B25PHYS_UUID still intact and its provider object still at the accepted generation (digest $B25PHYS_PRE_GEN_DIGEST)" $ok "rows=$(g exc_row_count) state=$(g exc_state) last_error=$(g exc_last_error) driver=$(g exc_driver) company=$(g exc_company) size=$(g exc_size) identity=$(g exc_identity_ok) uncertain=$(g exc_uncertain) lease=$(g exc_lease) mirror=$(g exc_mirror) live_refs=$(g exc_live_refs) company_absent=$(g exc_company_absent) present=$(g exc_provider_present) marker=$(g exc_provider_marker_ok) size_matches=$(g exc_provider_size_matches) canonical=$(g exc_generation_canonical) stable=$(g exc_generation_stable) digest=$(g exc_generation_digest)"
  ok=1; is_eq inv_total 1 && is_zero res_inv_outside_exception && is_zero inv_uncertain && is_zero inv_unproven && is_zero inv_cleanup_pending && is_zero inv_leases && is_zero inv_inflight && ok=0
  cond "storage_objects outside the exception = 0 (total 1; nothing uncertain / unproven / cleanup-pending / leased / in flight)" $ok "total=$(g inv_total) outside_exception=$(g res_inv_outside_exception) uncertain=$(g inv_uncertain) unproven=$(g inv_unproven) cleanup_pending=$(g inv_cleanup_pending) leases=$(g inv_leases) inflight=$(g inv_inflight)"
  ok=1; is_eq census_objects "$B25PHYS_CENSUS_OBJECTS" && is_eq census_bytes "$B25PHYS_CENSUS_BYTES" && is_eq census_marked "$B25PHYS_CENSUS_MARKED" && is_eq census_generationless "$B25PHYS_CENSUS_GENERATIONLESS" && is_eq census_md5 "$B25PHYS_CENSUS_MD5" && is_eq unmarked_objects 4 && is_eq unmarked_md5 "$B25PHYS_ORIGINALS_MD5" && is_eq originals_present 4 && is_zero originals_missing && is_eq originals_size_match 4 && ok=0
  cond "bucket census RE-READ = the locked baseline ($B25PHYS_CENSUS_OBJECTS / $B25PHYS_CENSUS_BYTES / marked $B25PHYS_CENSUS_MARKED / generationless $B25PHYS_CENSUS_GENERATIONLESS / $B25PHYS_CENSUS_MD5); originals 4/4 unchanged" $ok "objects=$(g census_objects) bytes=$(g census_bytes) marked=$(g census_marked) generationless=$(g census_generationless) md5=$(g census_md5) unmarked_objects=$(g unmarked_objects) unmarked_md5=$(g unmarked_md5) originals_present=$(g originals_present) missing=$(g originals_missing) size_match=$(g originals_size_match)"
  ok=1; is_true init_record_found && is_eq init_driver fs && is_eq init_fallback true && is_eq init_mirror true && is_eq init_legacy_delete false && is_true env_driver_is_fs && is_true env_root_is_locked && is_true env_fallback_is_true && is_true env_mirror_is_gcs && is_true env_legacy_delete_off && is_true env_key_set && is_true env_record_present && is_true env_core_identity_ok && is_eq env_mode 600 && is_eq key_line_count 1 && is_true env_file_managed_ok && ok=0
  cond "storage configuration unchanged (fs / $STAGE2A_FS_ROOT / fallback true / mirror gcs / legacy delete false; env record, mode 600, one key line, managed lines fixed)" $ok "record=$(g init_record_found) driver=$(g init_driver) fallback=$(g init_fallback) mirror=$(g init_mirror) legacy_delete=$(g init_legacy_delete) env_fs=$(g env_driver_is_fs) env_root=$(g env_root_is_locked) env_fallback=$(g env_fallback_is_true) env_mirror=$(g env_mirror_is_gcs) env_legacy_delete_off=$(g env_legacy_delete_off) key_set=$(g env_key_set) record_present=$(g env_record_present) core_identity_ok=$(g env_core_identity_ok) mode=$(g env_mode) key_line_count=$(g key_line_count) managed_ok=$(g env_file_managed_ok)"
  ok=1; is_true api_running && is_eq api_health healthy && is_eq readyz_status ok && is_eq readyz_database ok && is_eq readyz_storage ok && is_zero dead_jobs_total && ok=0
  cond "api still running and healthy, readiness ok / ok / ok, no dead job" $ok "api=$(g api_running)/$(g api_health) readyz=$(g readyz_status)/$(g readyz_database)/$(g readyz_storage) dead_jobs=$(g dead_jobs_total)"
  ok=1; is_zero leak_root_path && is_zero leak_key_shaped && is_zero leak_key_assignment && is_zero leak_bucket_ref && is_zero leak_signature && is_zero web_leak_root_path && is_zero web_leak_signature && ok=0
  cond "no secret leaked: no plaintext storage path, key-shaped token, key assignment, bucket reference or signed-URL text in the api / web logs" $ok "root_path=$(g leak_root_path) key_shaped=$(g leak_key_shaped) key_assignment=$(g leak_key_assignment) bucket_ref=$(g leak_bucket_ref) signature=$(g leak_signature) web_root_path=$(g web_leak_root_path) web_signature=$(g web_leak_signature)"
  ok=1; is_eq head_sha "$STAGE2A_PRODUCT_SHA" && is_eq current_deploy_sha "$STAGE2A_PRODUCT_SHA" && is_zero dirty && is_true lock_absent && ok=0
  cond "hosted product commit still $STAGE2A_PRODUCT_SHA, checkout clean, no foreign lock" $ok "head=$(g head_sha) current=$(g current_deploy_sha) dirty=$(g dirty) lock_absent=$(g lock_absent)"
  echo "B25_STAGE2A_${MK}_SETTLED_CONDITIONS_FAILED=$failed"
  if [ "$failed" = "0" ]; then echo "B25_STAGE2A_${MK}_SETTLED=TRUE"; else echo "B25_STAGE2A_${MK}_SETTLED=FALSE"; fi
  return 0
}

# ---- the two manifests behind the generic evaluators (names kept for the reviewed Correction 1 phases and tests) ----
stage2a_residue_eligibility() { stage2a_residue_eligibility_for S2AR RESIDUE; }
stage2a_residue_settled() { stage2a_residue_settled_for S2AR RESIDUE; }
stage2a_residue2_eligibility() { stage2a_residue_eligibility_for S2AR2 RESIDUE2; }
stage2a_residue2_settled() { stage2a_residue_settled_for S2AR2 RESIDUE2; }

# =============================================================================
# B25 STAGE 2A — CORRECTION 2: EXACT RESIDUE OF THE FAILED CORRECTED SMOKE RUN
# 38922592504 (tag 5d408c442c64). That run's client-side gate on the PUBLIC logo
# route's Content-Length stopped STEP=run after the logo upload; the always-step
# teardown deleted the disposable tenants through the product API and the
# product's purge settled the two fresh rows to plain `deleted` tombstones of the
# deleted company 56 (fs primary and mirror copy reported removed; last_error
# NULL). The branding uuid below is the CANDIDATE reconstructed from GitHub's
# masking of the digit pair "22" in the run log ("06***8d82-…"): it is NOT trusted —
# the hosted read-only eligibility must prove it is the ONE branding_logo residue
# row of company 56 satisfying every identity predicate, or the verdict is FALSE
# and the settlement stays impossible. Both manifests deny the Stage 1 exception
# (f048b5d4…, company 53) and each other.
# =============================================================================
readonly S2AR2_RUN="38922592504"
readonly S2AR2_TAG="5d408c442c64"
readonly S2AR2_COMPANY=56
readonly S2AR2_COMPANIES="56,57"
readonly S2AR2_USERS="105"
readonly S2AR2_UUID_DOC="c69a3706-84f8-456b-ba40-e983118f2751"
readonly S2AR2_UUID_LOGO="06228d82-7da6-4c5c-9ed7-d66fb97a1a2f"
readonly S2AR2_DOC_SIZE=21546
readonly S2AR2_LOGO_SIZE=181          # the normalized served-object size observed by the failed client run (public GET body length)
readonly S2AR2_ROWS=2
readonly S2AR2_UUIDS_Q="'$S2AR2_UUID_DOC','$S2AR2_UUID_LOGO'"
readonly S2AR2_MANIFEST="$S2AR2_UUID_DOC,$S2AR2_UUID_LOGO|$S2AR2_COMPANIES|$S2AR2_USERS|$S2AR2_TAG"
# Both rows were created during STEP=run (upload intent 15:17:46Z, logo upload 15:17:55Z) and tombstoned by the API
# deletion of tenant 56 (15:17:57Z; both rows read `deleted` at 15:18:03Z) — run 38922592504 log.
readonly S2AR2_CREATED_FROM="2026-10-16 15:17:40"
readonly S2AR2_CREATED_TO="2026-10-16 15:18:00"
readonly S2AR2_DELETED_FROM="2026-10-16 15:17:55"
readonly S2AR2_DELETED_TO="2026-10-16 15:19:00"
s2ar2_kind() { case "$1" in "$S2AR2_UUID_DOC") echo document;; "$S2AR2_UUID_LOGO") echo branding_logo;; *) return 1;; esac; }
s2ar2_size() { case "$1" in "$S2AR2_UUID_DOC") echo "$S2AR2_DOC_SIZE";; "$S2AR2_UUID_LOGO") echo "$S2AR2_LOGO_SIZE";; *) return 1;; esac; }
# The Correction 2 constants can never name the Stage 1 exception, nor overlap the Correction 1 manifest.
s2ar2_constants_ok() {
  [ "$S2AR2_UUID_DOC" != "$B25PHYS_UUID" ] && [ "$S2AR2_UUID_LOGO" != "$B25PHYS_UUID" ] && [ "$S2AR2_UUID_DOC" != "$S2AR2_UUID_LOGO" ] \
    && [ "$S2AR2_COMPANY" != "$B25PHYS_COMPANY" ] && [[ ",$S2AR2_COMPANIES," != *",$B25PHYS_COMPANY,"* ]] && [[ ",$S2AR2_COMPANIES," == *",$S2AR2_COMPANY,"* ]] \
    && [[ "$S2AR2_UUID_DOC" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] && [[ "$S2AR2_UUID_LOGO" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
    && [ "$S2AR2_UUID_DOC" != "$S2AR_UUID_DOC" ] && [ "$S2AR2_UUID_LOGO" != "$S2AR_UUID_LOGO" ] && [ "$S2AR2_UUID_DOC" != "$S2AR_UUID_LOGO" ] && [ "$S2AR2_UUID_LOGO" != "$S2AR_UUID_DOC" ] \
    && [[ ",$S2AR2_COMPANIES," != *",$S2AR_COMPANY,"* ]] && [ "$S2AR2_TAG" != "$S2AR_TAG" ] && [ "$S2AR2_ROWS" = "2" ]
}

# =============================================================================
# B25 STAGE 2A — CORRECTION 4: EXACT RESIDUE OF THE CORRECTION-3 SMOKE RUN
# 38958264416 (tag ec7ceda89a58). That run passed its setup (switched state,
# B25_STAGE2A_TENANT_START_GATE=PASS, pre-smoke snapshot), STEP=run (62 / 62) and
# the VPS-side verification (two fs rows, encrypted files 2 / 2, mirror objects
# 2 / 2, leak gates 0, census 7 / 23125 / marked 3), then stopped in
# stage2a-recreate-api: the PRE-SMOKE form of guards_stage2a_switched demanded
# "inventory = the exception row only" while the smoke's own two rows
# legitimately existed — the state-form defect corrected in b25-stage1-apply.sh
# (guards_stage2a_switched_with_smoke_rows + stage2a_midsmoke_eval below; no
# container was recreated). The always-cleanup deleted the two disposable
# tenants through the product API (both 200), removed the disposable owner and
# the explicit disposable rows, then stopped closed on the two tombstones that
# only the settle step may remove (never broadened) — so the Correction 3
# post-smoke comparison of the existing tenant was never reached. The residue:
# two plain `deleted` fs tombstones of deleted company 58 (document ac3c33c3…,
# branding_logo c097cd52…; mirror recorded; last_error NULL; both uuids read
# unmasked from the run log). The pre-smoke snapshot that run's setup printed
# (one base64 line: snapshot instant, identity digests, business counts and
# highest ids — no customer value) is recorded below so the read-only inspection
# can prove the incident window retrospectively. Denies the Stage 1 exception
# (f048b5d4…, company 53) and both earlier manifests.
# =============================================================================
readonly S2AR3_RUN="38958264416"
readonly S2AR3_TAG="ec7ceda89a58"
readonly S2AR3_COMPANY=58
readonly S2AR3_COMPANIES="58,59"
readonly S2AR3_USERS="109"
readonly S2AR3_UUID_DOC="ac3c33c3-853e-4003-a03e-a8b357a282ac"
readonly S2AR3_UUID_LOGO="c097cd52-270e-418c-8e75-0a0dfd1f2312"
readonly S2AR3_DOC_SIZE=21546
readonly S2AR3_LOGO_SIZE=181          # the stored plaintext size of the kept logo (run 38958264416 verification: size=181)
readonly S2AR3_ROWS=2
readonly S2AR3_UUIDS_Q="'$S2AR3_UUID_DOC','$S2AR3_UUID_LOGO'"
readonly S2AR3_MANIFEST="$S2AR3_UUID_DOC,$S2AR3_UUID_LOGO|$S2AR3_COMPANIES|$S2AR3_USERS|$S2AR3_TAG"
# Both rows were created during STEP=run (upload intent 19:54:56Z, logo upload 19:55:04Z) and tombstoned by the API
# deletion of tenant 58 in the always-cleanup (19:55:22Z; both rows read `deleted` at 19:55:35Z) — run 38958264416 log.
readonly S2AR3_CREATED_FROM="2026-10-16 19:54:50"
readonly S2AR3_CREATED_TO="2026-10-16 19:55:10"
readonly S2AR3_DELETED_FROM="2026-10-16 19:55:20"
readonly S2AR3_DELETED_TO="2026-10-16 19:56:00"
# The incident window of the retrospective Correction 3 proof: from the pre-smoke snapshot instant printed by the
# setup of run 38958264416 to the end of its always-cleanup step (19:55:37Z, rounded up).
readonly S2AR3_SNAPSHOT_AT="2026-10-16 19:54:40.127290"
readonly S2AR3_INCIDENT_END="2026-10-16 19:55:40"
# The pre-smoke snapshot of the existing tenant exactly as the setup of run 38958264416 printed it (B25_TENANT_SNAPSHOT:
# key=value facts, base64). Counts, booleans and digests only — the Correction 3 fact shape.
readonly S2AR3_TENANT_SNAPSHOT_B64="c25hcHNob3RfYXQ9MjAyNi0xMC0xNiAxOTo1NDo0MC4xMjcyOTAKcHJlX2lkX2NvbXBhbnlfbWQ1PTRiNDUwNmM1YzdhNjg1ZTY1MjQ4MDZiZmM2NzA3N2FiCnByZV9pZF9jb21wYW55X3N0YXR1c19tZDU9OTA3MzA3Mjg2MDNjMzU0YjJhYjZiOTIyOTljNzUzZWQKcHJlX2lkX3N1Yl9jb3JlX21kNT02MjJjOTQ5MjVjMjAzZGU3YmYxYzUzNzgzM2NlNmQ0YwpwcmVfaWRfc3ViX3N0YXR1c19tZDU9NTRmZjM2NDAxMDVjNmNlODA2ZjM3ZWNmZmI3OTAzZDIKcHJlX2lkX3VzZXJzX2NvdW50PTEKcHJlX2lkX3VzZXJzX2FjdGl2ZT0xCnByZV9pZF91c2Vyc19tZDU9ZjFiMTVkNzQ5OTY2OTJlNjJiOWMxM2FiMzkwY2UwYTUKcHJlX2lkX3JvbGVzX2NvdW50PTAKcHJlX2lkX3JvbGVzX21kNT1kNDFkOGNkOThmMDBiMjA0ZTk4MDA5OThlY2Y4NDI3ZQpwcmVfaWRfdXNlcl9yb2xlc19jb3VudD0wCnByZV9pZF91c2VyX3JvbGVzX21kNT1kNDFkOGNkOThmMDBiMjA0ZTk4MDA5OThlY2Y4NDI3ZQpwcmVfaWRfYnJhbmRfbG9nb19zZXQ9ZmFsc2UKcHJlX2NvbnRhY3RzX2NvdW50PTEKcHJlX2NvbnRhY3RzX21heF9pZD0yMQpwcmVfbGVhZHNfY291bnQ9MQpwcmVfbGVhZHNfbWF4X2lkPTE0CnByZV9ldmVudHNfY291bnQ9MQpwcmVfZXZlbnRzX21heF9pZD0xNgpwcmVfdGFza3NfY291bnQ9MApwcmVfdGFza3NfbWF4X2lkPTAKcHJlX3RhZ3NfY291bnQ9MApwcmVfdGFnc19tYXhfaWQ9MApwcmVfbGVhZF90YWdzX2NvdW50PTAKcHJlX2xlYWRfdGFnc19tYXhfaWQ9MApwcmVfZG9jdW1lbnRzX2NvdW50PTAKcHJlX2RvY3VtZW50c19tYXhfaWQ9MApwcmVfZG9jdW1lbnRfdmVyc2lvbnNfY291bnQ9MApwcmVfZG9jdW1lbnRfdmVyc2lvbnNfbWF4X2lkPTAKcHJlX2ZvbGxvd191cHNfY291bnQ9MApwcmVfZm9sbG93X3Vwc19tYXhfaWQ9MApwcmVfd29ya2Zsb3dfZGVmaW5pdGlvbnNfY291bnQ9MApwcmVfd29ya2Zsb3dfZGVmaW5pdGlvbnNfbWF4X2lkPTAKcHJlX3dvcmtmbG93X3J1bnNfY291bnQ9MApwcmVfd29ya2Zsb3dfcnVuc19tYXhfaWQ9MApwcmVfYmlsbGluZ19jaGVja291dF9zZXNzaW9uc19jb3VudD0wCnByZV9iaWxsaW5nX2NoZWNrb3V0X3Nlc3Npb25zX21heF9pZD0wCnByZV9zdWJzY3JpcHRpb25fdXNhZ2VfcmVzZXJ2YXRpb25zX2NvdW50PTYKcHJlX3N1YnNjcmlwdGlvbl91c2FnZV9yZXNlcnZhdGlvbnNfbWF4X2lkPTkKcHJlX3NjYW5zX2NvdW50PTcKcHJlX3NjYW5zX21heF9pZD0zMQo="
s2ar3_kind() { case "$1" in "$S2AR3_UUID_DOC") echo document;; "$S2AR3_UUID_LOGO") echo branding_logo;; *) return 1;; esac; }
s2ar3_size() { case "$1" in "$S2AR3_UUID_DOC") echo "$S2AR3_DOC_SIZE";; "$S2AR3_UUID_LOGO") echo "$S2AR3_LOGO_SIZE";; *) return 1;; esac; }
# The Correction 4 constants can never name the Stage 1 exception, nor overlap the Correction 1 / 2 manifests; the
# recorded snapshot must decode to the Correction 3 fact shape with the recorded instant and the 12 identity digests;
# the incident window must be ordered.
s2ar3_constants_ok() {
  local snap
  [ "$S2AR3_UUID_DOC" != "$B25PHYS_UUID" ] && [ "$S2AR3_UUID_LOGO" != "$B25PHYS_UUID" ] && [ "$S2AR3_UUID_DOC" != "$S2AR3_UUID_LOGO" ] \
    && [ "$S2AR3_COMPANY" != "$B25PHYS_COMPANY" ] && [[ ",$S2AR3_COMPANIES," != *",$B25PHYS_COMPANY,"* ]] && [[ ",$S2AR3_COMPANIES," == *",$S2AR3_COMPANY,"* ]] \
    && [[ ",$S2AR3_COMPANIES," != *",1,"* ]] && [[ ",$S2AR3_USERS," != *",1,"* ]] && [[ ",$S2AR3_USERS," != *",2,"* ]] \
    && [[ "$S2AR3_UUID_DOC" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] && [[ "$S2AR3_UUID_LOGO" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
    && [ "$S2AR3_UUID_DOC" != "$S2AR_UUID_DOC" ] && [ "$S2AR3_UUID_LOGO" != "$S2AR_UUID_LOGO" ] && [ "$S2AR3_UUID_DOC" != "$S2AR_UUID_LOGO" ] && [ "$S2AR3_UUID_LOGO" != "$S2AR_UUID_DOC" ] \
    && [ "$S2AR3_UUID_DOC" != "$S2AR2_UUID_DOC" ] && [ "$S2AR3_UUID_LOGO" != "$S2AR2_UUID_LOGO" ] && [ "$S2AR3_UUID_DOC" != "$S2AR2_UUID_LOGO" ] && [ "$S2AR3_UUID_LOGO" != "$S2AR2_UUID_DOC" ] \
    && [[ ",$S2AR3_COMPANIES," != *",$S2AR_COMPANY,"* ]] && [[ ",$S2AR3_COMPANIES," != *",$S2AR2_COMPANY,"* ]] && [ "$S2AR3_TAG" != "$S2AR_TAG" ] && [ "$S2AR3_TAG" != "$S2AR2_TAG" ] && [ "$S2AR3_ROWS" = "2" ] \
    && [[ "$S2AR3_SNAPSHOT_AT" < "$S2AR3_INCIDENT_END" ]] && [[ "$S2AR3_CREATED_FROM" < "$S2AR3_CREATED_TO" ]] && [[ "$S2AR3_DELETED_FROM" < "$S2AR3_DELETED_TO" ]] \
    && [[ "$S2AR3_TENANT_SNAPSHOT_B64" =~ ^[A-Za-z0-9+/=]{40,20000}$ ]] && snap="$(printf '%s' "$S2AR3_TENANT_SNAPSHOT_B64" | base64 -d 2>/dev/null)" \
    && s2a_facts_ok "$snap" && [ "$(s2a_fv "$snap" snapshot_at)" = "$S2AR3_SNAPSHOT_AT" ] && [ "$(printf '%s\n' "$snap" | grep -cE '^pre_id_[a-z0-9_]+=')" = "12" ]
}
stage2a_residue3_eligibility() { stage2a_residue_eligibility_for S2AR3 RESIDUE3; }
stage2a_residue3_settled() { stage2a_residue_settled_for S2AR3 RESIDUE3; }

# ---- stage2a_midsmoke_eval (Correction 4): the Stage 2A guard's inventory / physical state in its MID-SMOKE form ----
# Used ONLY by stage2a-recreate-api, which runs after stage2a-smoke-verify proved the smoke's two rows and before the
# settle step. key=value facts on stdin (the predicates of the two recorded smoke rows, the Stage 1 exception facts,
# the fs / mirror proofs re-read for those rows, the census) → 13 numbered conditions with OK / FAIL, then
#   B25_STAGE2A_MIDSMOKE_CONDITIONS_FAILED=<n>
#   B25_STAGE2A_MIDSMOKE_GATE=PASS|FAIL
# The pre-smoke form (guards_stage2a_switched: the exception row ONLY) is untouched and remains the gate of every
# other phase. A missing or malformed fact fails its condition. Always returns 0 (the caller decides on the marker).
stage2a_midsmoke_eval() {
  local -A f=()
  s2ar_read_facts
  local failed=0 n=0
  g() { printf '%s' "${f[$1]:-<missing>}"; }
  is_true() { [ "$(g "$1")" = "true" ]; }
  is_zero() { [ "$(g "$1")" = "0" ]; }
  is_eq() { [ "$(g "$1")" = "$2" ]; }
  is_num_ge() { [[ "$(g "$1")" =~ ^[0-9]+$ ]] && [ "$(g "$1")" -ge "$2" ]; }
  cond() { n=$((n + 1)); if [ "$2" = "0" ]; then echo "mid $n: $1 — OK ($3)"; else echo "mid $n: $1 — FAIL ($3)"; failed=$((failed + 1)); fi; }
  local ok R=2 bytes_expected="?"
  ok=1; is_true ms_ids_ok && is_eq ms_ids_count "$R" && ok=0
  cond "exactly $R canonical, distinct smoke row uuids recorded by this run's stage2a-smoke-verify (never an input; never the Stage 1 exception)" $ok "ids_ok=$(g ms_ids_ok) count=$(g ms_ids_count)"
  ok=1; is_eq inv_total 3 && is_eq ms_rows_named "$R" && is_zero ms_rows_outside && ok=0
  cond "storage_objects = the Stage 1 exception + exactly the $R recorded smoke rows (total 3; no other row)" $ok "total=$(g inv_total) named=$(g ms_rows_named) outside=$(g ms_rows_outside)"
  ok=1; is_eq ms_rows_active "$R" && is_eq ms_rows_fs "$R" && is_eq ms_rows_legacy_null "$R" && ok=0
  cond "both smoke rows are state = active, driver = fs, legacy_key null" $ok "active=$(g ms_rows_active) fs=$(g ms_rows_fs) legacy_null=$(g ms_rows_legacy_null)"
  ok=1; is_eq ms_rows_mirror_canonical "$R" && is_eq ms_rows_mirror_ok "$R" && ok=0
  cond "both smoke rows carry the canonical mirror location of their key with mirror_state = ok" $ok "mirror_canonical=$(g ms_rows_mirror_canonical) mirror_ok=$(g ms_rows_mirror_ok)"
  ok=1; is_eq ms_rows_error_null "$R" && is_eq ms_rows_not_uncertain "$R" && is_eq ms_rows_no_lease "$R" && ok=0
  cond "no last_error, no publication uncertainty, no lease on either smoke row" $ok "error_null=$(g ms_rows_error_null) not_uncertain=$(g ms_rows_not_uncertain) no_lease=$(g ms_rows_no_lease)"
  ok=1; is_eq ms_rows_sized "$R" && is_eq ms_rows_digest_ok "$R" && is_eq ms_rows_identity_ok "$R" && is_eq ms_rows_fixture_match "$R" && is_eq ms_rows_document 1 && is_eq ms_rows_logo 1 && ok=0
  cond "row identity: one document + one branding_logo with the product-shaped reference / key, a populated plaintext size and a 64-hex digest equal to this run's fixture and logo facts" $ok "sized=$(g ms_rows_sized) digest_ok=$(g ms_rows_digest_ok) identity_ok=$(g ms_rows_identity_ok) fixture_match=$(g ms_rows_fixture_match) document=$(g ms_rows_document) logo=$(g ms_rows_logo)"
  ok=1; is_eq ms_rows_smoke_tenant "$R" && is_eq ms_rows_companies 1 && is_zero ms_rows_company1 && is_zero ms_rows_company53 && is_zero inv_company1 && is_zero inv_company53_outside_exception && ok=0
  cond "both smoke rows belong to ONE disposable 'B25 SMOKE' tenant; no row of company 1; no company-$B25PHYS_COMPANY row besides the exception; no foreign row" $ok "smoke_tenant=$(g ms_rows_smoke_tenant) companies=$(g ms_rows_companies) company1=$(g ms_rows_company1) company53=$(g ms_rows_company53) inv_company1=$(g inv_company1) inv_company53_outside_exception=$(g inv_company53_outside_exception)"
  ok=1; is_eq exc_row_count 1 && is_eq exc_state deleted && is_eq exc_last_error LEGACY_RETAINED && is_eq exc_driver gcs && is_eq exc_company "$B25PHYS_COMPANY" && is_eq exc_kind document && is_eq exc_size "$B25PHYS_OBJECT_SIZE" && is_true exc_identity_ok && is_eq exc_uncertain false && is_eq exc_lease false && is_zero exc_live_refs && is_true exc_provider_present && is_true exc_provider_marker_ok && is_true exc_provider_size_matches && is_true exc_generation_canonical && is_true exc_generation_stable && is_eq exc_generation_digest "$B25PHYS_PRE_GEN_DIGEST" && ok=0
  cond "Stage 1 exception $B25PHYS_UUID intact (deleted / LEGACY_RETAINED / gcs / company $B25PHYS_COMPANY / size $B25PHYS_OBJECT_SIZE / 0 live references; provider object present with its marker at the accepted generation $B25PHYS_PRE_GEN_DIGEST)" $ok "rows=$(g exc_row_count) state=$(g exc_state) last_error=$(g exc_last_error) driver=$(g exc_driver) company=$(g exc_company) size=$(g exc_size) identity_ok=$(g exc_identity_ok) uncertain=$(g exc_uncertain) lease=$(g exc_lease) live_refs=$(g exc_live_refs) provider_present=$(g exc_provider_present) marker_ok=$(g exc_provider_marker_ok) size_matches=$(g exc_provider_size_matches) generation=$(g exc_generation_canonical)/$(g exc_generation_stable)/$(g exc_generation_digest)"
  ok=1; is_zero inv_uncertain && is_zero inv_unproven && is_zero inv_cleanup_pending && is_zero inv_leases && is_zero inv_inflight && is_eq inv_active "$R" && ok=0
  cond "inventory hygiene: nothing uncertain / unproven / cleanup-pending / leased / in flight; the active rows are the $R smoke rows" $ok "uncertain=$(g inv_uncertain) unproven=$(g inv_unproven) cleanup_pending=$(g inv_cleanup_pending) leases=$(g inv_leases) inflight=$(g inv_inflight) active=$(g inv_active)"
  ok=1; is_eq ms_fs_rows "$R" && is_eq ms_fs_present "$R" && is_eq ms_fs_regular "$R" && is_eq ms_fs_owner_ok "$R" && is_eq ms_fs_mode_ok "$R" && is_eq ms_fs_magic_ok "$R" && is_eq ms_fs_marker_free "$R" && is_eq ms_fs_pdf_free "$R" && is_eq ms_fs_size_differs "$R" && is_eq ms_fs_tenant_files "$R" && is_zero ms_fs_other_files && is_zero ms_fs_symlinks && is_true ms_fs_keys_match && ok=0
  cond "FS: exactly the $R encrypted files (regular, runtime-owned, 0600, envelope magic, no plaintext marker, no PDF header, ciphertext size differs), the tenant file set = the stored keys, no other / symlinked file" $ok "rows=$(g ms_fs_rows) present=$(g ms_fs_present) regular=$(g ms_fs_regular) owner=$(g ms_fs_owner_ok) mode=$(g ms_fs_mode_ok) magic=$(g ms_fs_magic_ok) marker_free=$(g ms_fs_marker_free) pdf_free=$(g ms_fs_pdf_free) size_differs=$(g ms_fs_size_differs) tenant_files=$(g ms_fs_tenant_files) other=$(g ms_fs_other_files) symlinks=$(g ms_fs_symlinks) keys_match=$(g ms_fs_keys_match)"
  ok=1; is_eq ms_mirror_rows "$R" && is_eq ms_mirror_present "$R" && is_eq ms_mirror_bucket_ok "$R" && is_eq ms_mirror_canonical_key "$R" && is_eq ms_mirror_marker_ok "$R" && is_eq ms_mirror_generation_ok "$R" && is_eq ms_mirror_size_ok "$R" && is_eq ms_mirror_sha_ok "$R" && is_num_ge ms_mirror_generation_digits_min 10 && ok=0
  cond "GCS: exactly the $R mirror objects in the configured bucket at the canonical keys, each with the row's marker, a canonical generation, the plaintext size and the row digest" $ok "rows=$(g ms_mirror_rows) present=$(g ms_mirror_present) bucket=$(g ms_mirror_bucket_ok) canonical=$(g ms_mirror_canonical_key) marker=$(g ms_mirror_marker_ok) generation=$(g ms_mirror_generation_ok) size=$(g ms_mirror_size_ok) sha=$(g ms_mirror_sha_ok) generation_digits_min=$(g ms_mirror_generation_digits_min)"
  if [[ "$(g ms_rows_bytes)" =~ ^[0-9]+$ ]]; then bytes_expected=$((B25PHYS_CENSUS_BYTES + $(g ms_rows_bytes))); fi
  ok=1; is_eq census_objects "$((B25PHYS_CENSUS_OBJECTS + R))" && is_eq census_bytes "$bytes_expected" && is_eq census_marked "$((B25PHYS_CENSUS_MARKED + R))" && is_eq census_generationless "$B25PHYS_CENSUS_GENERATIONLESS" && is_eq unmarked_objects 4 && is_eq unmarked_md5 "$B25PHYS_ORIGINALS_MD5" && is_eq originals_present 4 && is_zero originals_missing && is_eq originals_size_match 4 && ok=0
  cond "bucket census = the locked baseline + the $R smoke mirrors (objects $((B25PHYS_CENSUS_OBJECTS + R)), bytes $B25PHYS_CENSUS_BYTES + the verified plaintext sizes = $bytes_expected, marked $((B25PHYS_CENSUS_MARKED + R)), generationless $B25PHYS_CENSUS_GENERATIONLESS); the four originals intact" $ok "objects=$(g census_objects) bytes=$(g census_bytes) marked=$(g census_marked) generationless=$(g census_generationless) unmarked_objects=$(g unmarked_objects) unmarked_md5=$(g unmarked_md5) originals_present=$(g originals_present) missing=$(g originals_missing) size_match=$(g originals_size_match)"
  ok=1; is_zero dead_jobs && [ "$(g references)" != "<missing>" ] && [ -n "$(g references)" ] && is_eq references "$(g references_expected)" && ok=0
  cond "no dead-letter job; legacy original references = $(g references_expected)" $ok "dead_jobs=$(g dead_jobs) references=$(g references)"
  echo "B25_STAGE2A_MIDSMOKE_CONDITIONS_FAILED=$failed"
  if [ "$failed" = "0" ]; then echo "B25_STAGE2A_MIDSMOKE_GATE=PASS"; else echo "B25_STAGE2A_MIDSMOKE_GATE=FAIL"; fi
  return 0
}

# =============================================================================
# B25 Stage 2A — CORRECTION 3: the existing-tenant safety model of the disposable smoke.
#
# The former gate compared ONE md5 over the whole composition of the existing tenant (users, roles,
# permissions, subscription fields and every mutable business count) with a constant accepted at the
# Stage 1 inspection. Any ordinary use of the product by that tenant (one card scan creates a scan row
# and a usage reservation) changed the digest and stopped every future smoke before it started — the
# read-only drift localization of run 38946910989 proved exactly that (three scans, three reservations,
# one login touch; nothing else). A frozen whole-tenant hash is therefore the wrong invariant: it cannot
# tell a login from a permission grant, and it can never be true again once the tenant works.
#
# The corrected invariant is PRE-SMOKE SNAPSHOT → disposable smoke → POST-SMOKE COMPARISON, in tiers:
#   IDENTITY tier (strict): company identity / security configuration, subscription plan / source /
#     provider identity / overrides / trial, the user set, each user's role + permissions + activity +
#     MFA + visibility, roles, user_roles, the managed logo. Identical before and after the smoke, or
#     the smoke FAILS. Before the smoke the same tier must be UNMOVED since the last owner review
#     (S2A_TENANT_REVIEW_UTC) — proven by row evidence (no user created / removed, every modified user
#     row explained by its own login, no role / user_role movement, no identity / permission audit
#     action) — or the gate FAILS and names the moved component for review. The one expected automated
#     movement (the manual-trial lifecycle sweep: status → expired) is accepted ONLY with evidence:
#     the sweep's own audit row (subscription.trial_expired, system actor) + an elapsed trial + the
#     expired status; the subscription's plan / source / provider identity / overrides stay strict.
#   BUSINESS tier (attributed): contacts, leads, events, tasks, tags, lead_tags, documents, versions,
#     follow-ups, workflow definitions / runs, checkout intents, usage reservations, scans. Counts and
#     the highest id are snapshotted; after the smoke a hard deletion (count decreased) FAILS; rows
#     created / modified / soft-deleted during the smoke FAIL when attributed to a disposable identity
#     (actor column or audit row), are reported as concurrent tenant activity when attributed to the
#     tenant's own users (actor column and / or the tenant's own audit rows in the window) or to a
#     deterministic automated product transition, and FAIL CLOSED when nothing attributes them.
#   ISOLATION: no audit row of a disposable actor on the tenant, no tenant row referencing a
#     disposable event / user, no disposable row referencing a tenant user, no tenant storage object
#     created or deleted, the legacy originals' references unchanged.
# Only counts, booleans, md5 digests, fixed status tokens and the tooling's own timestamps leave the
# host; no customer value is ever printed. TENANT_BASELINE_MD5 is no longer a gate: it stays a
# documented historical reference for the read-only drift report.
# =============================================================================
readonly S2A_TENANT_ID=1
readonly S2A_TENANT_REVIEW_UTC="2026-10-16 15:17:33"   # run 38922592504, stage2a-smoke-setup: the last instant the whole accepted composition was proven equal; advanced only by owner review
readonly S2A_IDENTITY_KEYS="id_company_md5 id_sub_core_md5 id_users_count id_users_active id_users_md5 id_roles_count id_roles_md5 id_user_roles_count id_user_roles_md5 id_brand_logo_set"
readonly S2A_SWEEP_KEYS="id_company_status_md5 id_sub_status_md5"
readonly S2A_BUSINESS_TABLES="contacts leads events tasks tags lead_tags documents document_versions follow_ups workflow_definitions workflow_runs billing_checkout_sessions subscription_usage_reservations scans"
# Every fact line: a key and a count, a boolean, an md5, a fixed token, a tooling timestamp or '-' (not applicable).
readonly S2A_FACT_LINE_RE='^[a-z0-9_]+=([0-9]+|true|false|[0-9a-f]{32}|-|[A-Za-z_][A-Za-z0-9_.-]{0,39}|[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?)?$'
s2a_facts_ok() {   # <facts text> → 0 when every non-empty line has the sanitized shape (nothing else may leave the host)
  local line; while IFS= read -r line; do [ -z "$line" ] && continue; [[ "$line" =~ $S2A_FACT_LINE_RE ]] || return 1; done <<<"$1"; return 0
}
s2a_fv() {   # <facts text> <key> → value ('' when absent)
  printf '%s\n' "$1" | awk -F= -v k="$2" '$1==k{print substr($0, length(k)+2); exit}'
}
s2a_num() { [[ "$1" =~ ^[0-9]+$ ]] && echo "$1" || echo 0; }
# Per-table attribution capabilities (the schema facts the readers rely on): deleted_at column? updated_at column?
# actor column? creation-instant column (document_versions records uploaded_at instead of created_at).
s2a_tbl_spec() {   # <table> → "deleted updated actor created_column"
  case "$1" in
    contacts|leads|events|documents) echo "yes yes created_by_id created_at" ;;
    tags) echo "yes yes - created_at" ;;
    tasks) echo "no yes - created_at" ;;
    lead_tags) echo "no no - created_at" ;;
    document_versions) echo "no no uploaded_by_id uploaded_at" ;;
    follow_ups|workflow_definitions) echo "no yes created_by_id created_at" ;;
    workflow_runs|billing_checkout_sessions) echo "no yes - created_at" ;;
    subscription_usage_reservations) echo "no no - created_at" ;;
    scans) echo "yes no user_id created_at" ;;
    *) return 1 ;;
  esac
}

# ---- stage2a_tenant_start_eval: the pre-smoke gate over the "since the review" evidence (facts on stdin) ----
stage2a_tenant_start_eval() {
  local F; F="$(cat)"; local failed=0 surfaced=0 r
  s2a_facts_ok "$F" || { echo "start: facts have an unexpected shape (nothing printed)"; echo "B25_STAGE2A_TENANT_START_GATE=FAIL"; return 1; }
  v() { s2a_fv "$F" "$1"; }
  say() { echo "start: $*"; }
  bad() { say "SURFACED FOR REVIEW: $*"; failed=$((failed+1)); surfaced=$((surfaced+1)); }
  [ "$(v review_utc_ok)" = "true" ] || { say "review instant is not in the past or unreadable"; failed=$((failed+1)); }
  # identity tier since the review
  [ "$(s2a_num "$(v users_created_since)")" = "0" ] && [ "$(s2a_num "$(v users_soft_deleted_since)")" = "0" ] && say "user set unchanged since the review: OK" || bad "user set changed since the review (created=$(v users_created_since) removed=$(v users_soft_deleted_since))"
  local um le; um="$(s2a_num "$(v users_modified_since)")"; le="$(s2a_num "$(v users_modified_login_explained)")"
  [ "$um" -le "$le" ] && say "modified user rows since the review: $um, every one explained by its own login (last_login_at = updated_at): OK" || bad "$((um-le)) user row(s) modified since the review without a login explanation"
  [ "$(s2a_num "$(v sec_audit_rows_since)")" = "0" ] && say "identity / permission audit actions since the review: 0: OK" || bad "$(v sec_audit_rows_since) identity / permission audit action(s) since the review (team / profile / roles / security / user.* other than login)"
  [ "$(s2a_num "$(v roles_changed_since)")" = "0" ] && [ "$(s2a_num "$(v user_roles_created_since)")" = "0" ] && say "roles / user_roles unmoved since the review: OK" || bad "role movement since the review (roles changed=$(v roles_changed_since) user_roles created=$(v user_roles_created_since))"
  # billing: strict unless the expected sweep is proven
  local sweep_ok=false
  if [ "$(s2a_num "$(v sweep_audit_rows_since)")" -ge 1 ] && [ "$(v sub_status)" = "expired" ] && [ "$(v sub_trial_elapsed)" = "true" ]; then sweep_ok=true; fi
  if [ "$(v sub_modified_since)" = "true" ] || [ "$(v sub_status_changed_since)" = "true" ]; then
    if [ "$sweep_ok" = true ]; then say "subscription moved since the review — EXPECTED SWEEP (evidence: subscription.trial_expired audit row by the system actor, elapsed trial, status expired): accepted"; else bad "subscription movement since the review without sweep evidence (modified=$(v sub_modified_since) status_changed=$(v sub_status_changed_since) sweep_audit=$(v sweep_audit_rows_since) status=$(v sub_status) trial_elapsed=$(v sub_trial_elapsed))"; fi
  else say "subscription unmoved since the review: OK"; fi
  if [ "$(v company_modified_since)" = "true" ]; then
    if [ "$sweep_ok" = true ]; then say "company row moved since the review — the sweep's status mirror: accepted"; else bad "company row modified since the review without sweep evidence"; fi
  else say "company row unmoved since the review: OK"; fi
  [ "$(s2a_num "$(v tenant_storage_rows)")" = "0" ] && say "tenant storage objects: 0: OK" || { say "the existing tenant holds $(v tenant_storage_rows) storage object(s) — the Stage 2A inventory baseline is the exception row only"; failed=$((failed+1)); }
  [ -n "$(v references)" ] && [ "$(v references)" = "$(v references_expected)" ] && say "legacy original references = $(v references_expected): OK" || { say "legacy original references $(v references) differ from the expected $(v references_expected)"; failed=$((failed+1)); }
  # business tier: ordinary activity since the review is reported, never a reason to stop
  local t spec c m d
  for t in $S2A_BUSINESS_TABLES; do
    c="$(v "bz_${t}_created_since")"; m="$(v "bz_${t}_modified_since")"; d="$(v "bz_${t}_soft_deleted_since")"
    [ "$(s2a_num "$c")$(s2a_num "$m")$(s2a_num "$d")" = "000" ] || say "ordinary tenant activity since the review in $t (created=${c:--} modified=${m:--} soft_deleted=${d:--}): allowed"
  done
  echo "B25_STAGE2A_TENANT_START_SURFACED=$surfaced"
  if [ "$failed" = "0" ]; then echo "B25_STAGE2A_TENANT_START_GATE=PASS"; return 0; fi
  echo "B25_STAGE2A_TENANT_START_GATE=FAIL"; return 1
}

# ---- stage2a_tenant_post_eval: the post-smoke comparison (pre_* snapshot facts + post_* facts + window attribution on stdin) ----
stage2a_tenant_post_eval() {   # [strict (default: the smoke's own post gate) | incident (Correction 4: a retrospective window proof)]
  local MODE="${1:-strict}" F; F="$(cat)"; local failed=0 concurrent=0 k t spec
  [[ "$MODE" =~ ^(strict|incident)$ ]] || { echo "post: unknown mode"; echo "B25_STAGE2A_TENANT_POST_GATE=FAIL"; return 1; }
  s2a_facts_ok "$F" || { echo "post: facts have an unexpected shape (nothing printed)"; echo "B25_STAGE2A_TENANT_POST_GATE=FAIL"; return 1; }
  v() { s2a_fv "$F" "$1"; }
  say() { echo "post: $*"; }
  bad() { say "FAIL: $*"; failed=$((failed+1)); }
  [ -n "$(v snapshot_at)" ] || bad "no pre-smoke snapshot instant"
  local sweep_ok=false
  if [ "$(s2a_num "$(v sweep_audit_rows_window)")" -ge 1 ] && [ "$(v sub_status_post)" = "expired" ] && [ "$(v sub_trial_elapsed)" = "true" ]; then sweep_ok=true; fi
  if [ "$MODE" = strict ]; then
    for k in $S2A_IDENTITY_KEYS; do
      [ -n "$(v "pre_$k")" ] || { bad "snapshot lacks $k"; continue; }
      [ "$(v "pre_$k")" = "$(v "post_$k")" ] && say "identity: $k unchanged" || bad "identity / security state changed during the smoke: $k"
    done
    for k in $S2A_SWEEP_KEYS; do
      if [ "$(v "pre_$k")" = "$(v "post_$k")" ]; then say "identity: $k unchanged"
      elif [ "$sweep_ok" = true ]; then say "identity: $k moved — EXPECTED SWEEP during the smoke (evidence: subscription.trial_expired audit row by the system actor, elapsed trial, status expired): accepted"
      else bad "status movement during the smoke without sweep evidence: $k"; fi
    done
  else
    # Correction 4 — incident form: the identity tier is decided by the WINDOW evidence (the Correction 3 row / audit
    # rules of the start gate, bounded to the incident window), never by a frozen comparison with the present — the
    # tenant may have worked normally since the incident. Unknown movement inside the window still FAILS.
    say "incident form: identity tier decided by the window evidence (snapshot instant → incident end), business movement attributed, isolation proven"
    for k in $S2A_IDENTITY_KEYS; do [ -n "$(v "pre_$k")" ] || bad "snapshot lacks $k"; done
    [ "$(v review_utc_ok)" = "true" ] || bad "incident window is not ordered / not in the past"
    [ "$(s2a_num "$(v users_created_since)")" = "0" ] && [ "$(s2a_num "$(v users_soft_deleted_since)")" = "0" ] && say "identity: user set unchanged in the window" || bad "identity: user set changed in the window (created=$(v users_created_since) removed=$(v users_soft_deleted_since))"
    local um le; um="$(s2a_num "$(v users_modified_since)")"; le="$(s2a_num "$(v users_modified_login_explained)")"
    [ "$um" -le "$le" ] && say "identity: $um user row(s) modified in the window, every one explained by its own login" || bad "identity: $((um-le)) user row(s) modified in the window without a login explanation"
    [ "$(s2a_num "$(v sec_audit_rows_since)")" = "0" ] && say "identity: no identity / permission / security audit action in the window" || bad "identity: $(v sec_audit_rows_since) identity / permission audit action(s) in the window (team / profile / roles / security / user.* other than login)"
    [ "$(s2a_num "$(v roles_changed_since)")" = "0" ] && [ "$(s2a_num "$(v user_roles_created_since)")" = "0" ] && say "identity: roles / user_roles unmoved in the window" || bad "identity: role movement in the window (roles changed=$(v roles_changed_since) user_roles created=$(v user_roles_created_since))"
    if [ "$(v sub_modified_since)" = "true" ] || [ "$(v sub_status_changed_since)" = "true" ]; then
      if [ "$sweep_ok" = true ]; then say "billing: subscription moved in the window — EXPECTED SWEEP (evidence: subscription.trial_expired audit row by the system actor, elapsed trial, status expired): accepted"; else bad "billing: subscription movement in the window without sweep evidence (modified=$(v sub_modified_since) status_changed=$(v sub_status_changed_since) sweep_audit=$(v sweep_audit_rows_window))"; fi
    else say "billing: subscription unmoved in the window"; fi
    if [ "$(v company_modified_since)" = "true" ]; then
      if [ "$sweep_ok" = true ]; then say "company row moved in the window — the sweep's status mirror: accepted"; else bad "company row modified in the window without sweep evidence"; fi
    else say "company row unmoved in the window"; fi
  fi
  local tenant_audit tenant_audit_since; tenant_audit="$(s2a_num "$(v tenant_audit_rows_window)")"; tenant_audit_since="$(s2a_num "$(v tenant_audit_rows_since)")"
  for t in $S2A_BUSINESS_TABLES; do
    spec="$(s2a_tbl_spec "$t")" || { bad "unknown table $t"; continue; }
    local _d _u has_actor _c pre post cw mw dw cbd cbt auto activity
    read -r _d _u has_actor _c <<<"$spec"
    pre="$(v "pre_${t}_count")"; post="$(v "post_${t}_count")"
    [[ "$pre" =~ ^[0-9]+$ ]] && [[ "$post" =~ ^[0-9]+$ ]] || { bad "$t: counts unreadable"; continue; }
    if [ "$post" -lt "$pre" ]; then
      if [ "$MODE" = strict ]; then bad "$t: $((pre-post)) tenant row(s) hard-deleted during the smoke (count $pre → $post)"; continue
      elif [ "$tenant_audit_since" -ge 1 ]; then say "$t: $((pre-post)) row(s) fewer than at the snapshot — attributed to the tenant's own audited activity since the snapshot (tenant audit rows since=$tenant_audit_since); not smoke-caused: allowed"; concurrent=$((concurrent+1)); continue
      else bad "$t: $((pre-post)) tenant row(s) hard-deleted since the snapshot that nothing attributes (count $pre → $post; no tenant audit row since) — fail closed"; continue; fi
    fi
    cw="$(s2a_num "$(v "${t}_created_window")")"; mw="$(s2a_num "$(v "${t}_modified_window")")"; dw="$(s2a_num "$(v "${t}_soft_deleted_window")")"
    cbd="$(s2a_num "$(v "${t}_created_by_disposable")")"; cbt="$(s2a_num "$(v "${t}_created_by_tenant")")"; auto="$(s2a_num "$(v "${t}_automated_explained")")"
    activity=$((cw+mw+dw))
    if [ "$cbd" -gt 0 ]; then bad "$t: $cbd row(s) created by a disposable smoke identity — the smoke mutated the existing tenant"; continue; fi
    if [ "$activity" = "0" ]; then say "$t: no movement during the smoke"; continue; fi
    if [ "$has_actor" != "-" ] && [ "$cw" -gt 0 ] && [ "$cbt" -ne "$cw" ]; then bad "$t: $((cw-cbt)) row(s) created during the smoke by nobody attributable (not a tenant user)"; continue; fi
    if [ "$tenant_audit" -ge 1 ] || { [ "$cw" = "0" ] && [ "$dw" = "0" ] && [ "$auto" -ge "$mw" ]; } || { [ "$has_actor" != "-" ] && [ "$cw" -gt 0 ] && [ "$cbt" = "$cw" ] && [ "$mw" = "0" ] && [ "$dw" = "0" ]; }; then
      say "$t: concurrent tenant activity during the smoke (created=$cw modified=$mw soft_deleted=$dw; attributed: tenant users / tenant audit rows=$tenant_audit / automated=$auto) — not smoke-caused: allowed"; concurrent=$((concurrent+1))
    else bad "$t: movement during the smoke that nothing attributes (created=$cw modified=$mw soft_deleted=$dw tenant_audit=$tenant_audit automated=$auto) — fail closed"; fi
  done
  [ "$(s2a_num "$(v disposable_audit_on_tenant)")" = "0" ] && say "isolation: no audit action of a disposable identity on the tenant" || bad "isolation: $(v disposable_audit_on_tenant) audit action(s) of a disposable identity on the existing tenant"
  [ "$(s2a_num "$(v tenant_rows_ref_disposables)")" = "0" ] && say "isolation: no tenant row references a disposable event / user" || bad "isolation: $(v tenant_rows_ref_disposables) tenant row(s) reference a disposable event / user (cross-tenant association)"
  [ "$(s2a_num "$(v disposable_rows_ref_tenant)")" = "0" ] && say "isolation: no disposable row references a tenant user" || bad "isolation: $(v disposable_rows_ref_tenant) disposable row(s) reference a tenant user (cross-tenant association)"
  [ "$(s2a_num "$(v tenant_storage_rows_post)")" = "0" ] && [ "$(s2a_num "$(v tenant_storage_created_window)")" = "0" ] && [ "$(s2a_num "$(v tenant_storage_deleted_window)")" = "0" ] && say "isolation: no tenant storage object created / deleted / present" || bad "isolation: tenant storage objects moved (present=$(v tenant_storage_rows_post) created=$(v tenant_storage_created_window) deleted=$(v tenant_storage_deleted_window))"
  [ -n "$(v references_post)" ] && [ "$(v references_post)" = "$(v references_expected)" ] && say "legacy original references = $(v references_expected): OK" || bad "legacy original references $(v references_post) differ from the expected $(v references_expected)"
  echo "B25_STAGE2A_TENANT_CONCURRENT_TABLES=$concurrent"
  if [ "$failed" = "0" ]; then echo "B25_STAGE2A_TENANT_POST_GATE=PASS"; return 0; fi
  echo "B25_STAGE2A_TENANT_POST_GATE=FAIL"; return 1
}
