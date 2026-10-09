# =============================================================================
# TEMPORARY — B25 Stage 1 disposable-smoke cleanup rules (ONE-OFF ops library,
# not application code). Sourced by the VPS-side activation script (prepended on
# the SSH stdin stream) and by the local test .github/scripts/b25-stage1-cleanup.test.sh.
# Defines ONLY functions and string constants — nothing executes on load.
#
# The product never deletes bucket objects of `gcs` rows while
# OBJECT_STORAGE_LEGACY_DELETE is off (their tombstones settle as
# LEGACY_RETAINED). A disposable hosted smoke must nevertheless finish with zero
# residue, so the smoke's own objects are removed by marker + exact generation
# and their tombstone rows are removed by an ops-only, allow-listed, single-
# transaction delete of EXACT UUIDs. This never changes the product's normal
# LEGACY_RETAINED behaviour for any other row.
# =============================================================================

# ---- provider rules (JavaScript, prepended to the in-container node snippets) ----
# shouldDeleteObject(rowId, meta): the object may be deleted ONLY when its ownership
# marker equals the tombstone id and its generation is a canonical decimal string;
# the returned generation is the exact string for ifGenerationMatch (never a number).
# rowAbsent(presence): a tombstone row may be purged ONLY when every persisted
# provider location (primary key, legacy key, mirror key when set) is absent.
PROVIDER_RULES_JS=$(cat <<'JS'
const B25_RULES = {
  shouldDeleteObject(rowId, meta) {
    const marker = meta && meta.metadata && meta.metadata["lcp-object-id"];
    const gen = meta && meta.generation != null ? String(meta.generation) : "";
    if (typeof rowId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(rowId)) return { ok: false, reason: "row id is not a uuid" };
    if (marker !== rowId) return { ok: false, reason: "ownership marker missing or not this row" };
    if (typeof meta.generation === "number") return { ok: false, reason: "generation reported as a number" };
    if (!/^[1-9]\d*$/.test(gen)) return { ok: false, reason: "generation is not a canonical decimal string" };
    return { ok: true, generation: gen };
  },
  rowAbsent(presence) {
    if (!presence || typeof presence !== "object") return false;
    if (presence.storage !== false) return false;
    if (presence.legacy !== false && presence.legacy !== null) return false;
    if (presence.mirror !== false && presence.mirror !== null) return false;
    return true;
  },
};
if (process.env.B25_RULES_EXPORT === "1") module.exports = B25_RULES;
JS
)

# ---- purge_rows_sql <quoted uuid csv> <company id csv> <expected count> ----
# ONE statement (one transaction): lock the explicit rows, re-evaluate the complete
# allow-list on the locked rows, delete ONLY when every locked row passes AND the
# locked count AND the passing count both equal the expected count; returns the
# number of rows deleted (0 when anything differs — nothing is deleted then).
purge_rows_sql() {
  local uuids="$1" cids="$2" expected="$3"
  [[ "$uuids" =~ ^\'[0-9a-f-]{36}\'(,\'[0-9a-f-]{36}\')*$ ]] || { echo "purge_rows_sql: uuid list malformed" >&2; return 1; }
  [[ "$cids" =~ ^[0-9]+(,[0-9]+)*$ ]] || { echo "purge_rows_sql: company list malformed" >&2; return 1; }
  [[ "$expected" =~ ^[0-9]+$ ]] || { echo "purge_rows_sql: expected count malformed" >&2; return 1; }
  cat <<SQL
with locked as (
  select s.* from storage_objects s where s.id in ($uuids) for update
), ok as (
  select l.id from locked l
  where l.company_id in ($cids)
    and not exists (select 1 from companies c where c.id = l.company_id)
    and l.state = 'deleted'
    and l.last_error = 'LEGACY_RETAINED'
    and l.publication_uncertain_at is null
    and l.driver = 'gcs'
    and l.mirror_key is null
    and l.lease_token is null
    and l.deleted_at is not null
    and (
      (l.kind <> 'branding_logo' and l.reference = '/objects/' || l.id::text)
      or (l.kind = 'branding_logo' and l.reference ~ ('^branding/' || l.company_id || '/' || replace(l.id::text, '-', '') || '\\.[a-z0-9]+\$'))
    )
    and l.storage_key ~ ('^tenants/' || l.company_id || '/(documents|exports|reports|scans|branding)/' || l.id::text || '(\\.[a-z0-9]+)?\$')
    and not exists (select 1 from document_versions dv where dv.company_id = l.company_id and dv.object_path = l.reference)
    and not exists (select 1 from documents d where d.company_id = l.company_id)
    and not exists (select 1 from export_runs e where e.company_id = l.company_id and e.object_path = l.reference)
    and not exists (select 1 from executive_reports r where r.company_id = l.company_id and r.object_path = l.reference)
    and not exists (select 1 from scans sc where sc.company_id = l.company_id and sc.image_url = l.reference)
    and not exists (select 1 from companies co where co.brand_logo_key = l.reference)
), gate as (
  select (select count(*) from locked) as locked_n, (select count(*) from ok) as ok_n
), deleted as (
  delete from storage_objects s
  where s.id in (select id from ok)
    and (select locked_n from gate) = $expected
    and (select ok_n from gate) = $expected
    and $expected > 0
  returning s.id
)
select (select count(*) from deleted) || '|' || (select locked_n from gate) || '|' || (select ok_n from gate);
SQL
}

# ---- purge_result_check "<deleted|locked|ok>" <expected> ----
# Prints the triple and returns 0 only when deleted = locked = ok = expected.
purge_result_check() {
  local triple="$1" expected="$2" d l o
  IFS='|' read -r d l o <<<"$triple"
  echo "purge: deleted=$d locked=$l allowed=$o expected=$expected"
  [ "$d" = "$expected" ] && [ "$l" = "$expected" ] && [ "$o" = "$expected" ]
}
