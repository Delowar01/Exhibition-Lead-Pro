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
