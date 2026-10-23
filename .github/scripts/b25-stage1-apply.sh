#!/bin/bash
# =============================================================================
# TEMPORARY — B25 Stage 1 hosted activation tooling (ONE-OFF ops script, not
# application code). Streamed over SSH stdin by
# .github/workflows/b25-stage1-apply.yml (`bash -s`); never written to the VPS
# filesystem. The whole script is one brace group whose stdin is /dev/null, so
# bash reads it completely before the first command runs.
#
# B25 CORRECTION 9 TOOLING (ops/b25-c9-postdeploy-tooling-r2): the SAME six ops files rebuilt on the
# Correction 9 product commit (72a2437) so the post-deployment verification can accept it:
# ACCEPTED_SHA = 72a2437 (the commit deploy-dev-vps must have deployed), EXPECTED_HOSTED_SHA = eb2edb0
# (previous-deploy.sha after that deployment). Every schema, census, tenant, scan and environment
# baseline is unchanged. The schema phases (preflight / schema_apply) are OBSOLETE on this branch: the
# workflow refuses those modes before any SSH session (Correction 9 changes no schema).
#
# PHASES (selected by PHASE; the workflow validates every typed confirmation
# BEFORE any SSH session is opened — this script additionally re-checks the
# fixed baselines on the host itself):
#   preflight         READ-ONLY final preflight against the fixed baselines
#   schema-apply      lock → preflight guards → fresh verified backup → migrate
#                     image from exactly ACCEPTED_SHA → stop api (EXIT trap
#                     restarts it) → zero active backends → drizzle-kit push
#                     (allow-list: exactly the 5 accepted statements) → verify
#                     → second push "No changes detected" → restart the OLD api
#                     (5a072fd) → health → unchanged-state proof. Never fast-
#                     forwards develop, never deploys.
#   recover           always-step safety net after schema-apply: api running &
#                     healthy, temporary worktree / image / logs removed
#   postdeploy-verify READ-ONLY verification of the deployed B25 api (eb2edb0)
#   smoke-setup       insert ONE disposable platform-owner user (bcrypt hash from
#                     the runner); nothing else
#   smoke-verify      VPS-side checks of the disposable smoke rows/objects
#                     (inventory, ownership marker, generation strings, logs,
#                     audit metadata, census). The capability leak gate uses a
#                     TOKEN-SPECIFIC literal detector (the capability's signature
#                     component) that arrives ONLY as the first line of the stdin
#                     stream (shell variable B25_LEAK_DETECTOR) — never ARG3.
#   recreate-api      `compose up -d --no-deps --force-recreate api` + health
#   smoke-settle      wait for the purge job, remove ONLY the disposable smoke
#                     objects (marker-proven, generation-conditioned), prove
#                     every persisted location absent, then remove the EXACT
#                     recorded tombstone UUIDs in one allow-listed transaction
#                     (b25-stage1-purge-lib.sh, prepended on the stdin stream);
#                     census back to the baseline, original generations
#                     unchanged, zero smoke rows / markers left
#   cleanup           always-step: guarded removal of the explicit disposable
#                     rows; durable tombstones identified and verified, never
#                     deleted; existing rows proven identical before/after
#   residue2-eligibility / residue2-settle / residue2-verify
#                     second incident (run 38005492289): the THREE recorded
#                     tombstones of disposable company 49 — see the block below
#   b25phys-inspect   READ-ONLY inspection of the physical-test residue (company 53,
#                     contact 22, document 6, storage row f048b5d4…): constant
#                     manifest (apply-lib), never ARG-driven; decides the fifteen
#                     deletion prerequisites; NO settle phase exists for it
#   b25phys-postdelete-verify
#                     READ-ONLY verification after the platform owner deleted company 53
#                     in the portal: cascade absent, purge job completed, product tombstone
#                     (deleted / LEGACY_RETAINED), provider object retained with the proven
#                     generation, inventory unchanged; decides the post-delete eligibility
#   (Correction 3)    the Stage 2A smoke protects the existing tenant with a tiered pre-smoke snapshot /
#                     post-smoke comparison (stage2a_tenant_start_gate / stage2a_tenant_post_gate) instead
#                     of the frozen whole-tenant digest TENANT_BASELINE_MD5, which stays a historical
#                     reference of the read-only drift report only
#   (Correction 4)    the recreate phase of the smoke applies the MID-SMOKE form of the switched guard
#                     (guards_stage2a_switched_with_smoke_rows: the exception row + exactly the two rows
#                     recorded by the same run's verification, re-proven with their files, mirrors and the
#                     census; the uuids travel on the stdin stream only) — run 38958264416 stopped there
#   (Correction 5)    the PROTECTED LIVE-INVENTORY model: the inspection run 39442358211 proved two healthy
#                     live fs objects of the existing tenant, so "inventory = the exception row only" is
#                     gone from every Stage 2A gate. Every row outside the exception and the recorded smoke
#                     rows must be a healthy live fs row of a real tenant, proven on disk and in the bucket
#                     (stage2a_protected_gate / stage2a_protected_eval), recorded before the smoke
#                     (B25_PROTECTED_SET on the stdin stream) and identical mid-smoke, post-settle and in
#                     the cleanup; the bucket is a partition (originals + exception + protected + smoke
#                     mirrors); legacy references exclude native keys (references_legacy = 4). Nothing in
#                     this tooling writes, moves or deletes a protected row, file or object.
#   stage2a-protected-inventory-inspect
#                     READ-ONLY (no input, no ARG): proves the CURRENT protected live inventory — every
#                     row outside the exception independently, its encrypted file, its mirror, the
#                     product association, the bucket partition, the reference reconciliation, the
#                     Stage 1 exception, host / runtime / fingerprint / volume — and prints the marker
#                     B25_STAGE2A_PROTECTED_INVENTORY_READY=TRUE|FALSE after a sanitized summary.
#   (Correction 6)    the start gate attributes a moved company row with EVIDENCE: exact tenant branding audit
#                     rows on the company entity bracketing the update, no organization / platform / security /
#                     billing / identity action, a consistent logo state, and today's identity / billing digests
#                     equal to the reviewed historical anchor (the run-38958264416 snapshot locked in the library)
#                     → BRANDING_CHANGE_PROVEN; anything else stays surfaced (CORRECTION6_HISTORICAL_CHANGE_UNPROVEN
#                     → the gate FAILS). The review instant is never advanced; no digest is replaced.
#   stage2a-company-change-inspect
#                     READ-ONLY (no input, no ARG): host / runtime / fingerprint / volume, the protected live
#                     inventory, the anchor, the start-gate evidence and the company-row classification;
#                     prints B25_STAGE2A_COMPANY_CHANGE_PROVEN=TRUE|FALSE and
#                     B25_STAGE2A_TENANT_START_READINESS=TRUE|FALSE (TRUE only when every host, protected and
#                     start-gate condition holds).
#   stage2a-residue3-eligibility / stage2a-residue3-settle
#                     third incident (run 38958264416, tag ec7ceda89a58): the two recorded tombstones of
#                     deleted company 58 (constants S2AR3_*), the retrospective incident-window proof of
#                     the existing tenant and the temporary stderr metadata — see the block below
#   (Correction 7)    the smoke run 39880703889 stopped in the RECORDED protected inventory of its VPS-side
#                     verification: the smoke tenant's own first-party logo key could not resolve (stage2a_live_row_sql
#                     rightly excludes smoke tenants → refs 5 / ambiguous 1) and the record comparison carried the smoke
#                     keys inside tenant_keys_md5. Fixes: the SAME-RUN smoke branding allowance (stage2a_smoke_logo_sql,
#                     only with the verified uuid pair of THIS run; P and stage2a_live_row_sql unchanged), tenant_keys_md5
#                     = P's keys in every form (+ tenant_live_keys_md5 for the file set), and every evaluator verdict
#                     printed before any decision (no FAIL line is ever swallowed by set -e).
#   stage2a-residue4-eligibility / stage2a-residue4-settle
#                     fourth incident (run 39880703889, tag 2c4bfb197fd4): the two recorded tombstones of deleted
#                     company 60 (constants S2AR4_*) judged under the protected model — ROWS_PRESENT → ELIGIBLE,
#                     ROWS_ABSENT → ALREADY_ABSENT (physical absence proven at the manifest's canonical locations);
#                     the settle removes exactly the two rows or skips an already-absent residue (see the block below)
#   stage2a-tenant-drift
#                     READ-ONLY localization of the existing-tenant baseline drift that stopped
#                     the corrected smoke run 38934705535 before any write (tenant_md5 ≠ the
#                     accepted TENANT_BASELINE_MD5): digest verdict, kept-row counts, per-table
#                     rows created / modified / soft-deleted since the last matching guard,
#                     audit action counts, recurring-sweep evidence; prints no tenant value and
#                     changes no constant (see the block before the dispatch)
#
# SAFETY: every SELECT runs in a psql session pinned read-only (q); writes use
# qw only inside the mutation phases and only against explicit disposable ids;
# no env VALUE, credential, bucket name, object name, key, path, database URL,
# token or tenant content is ever printed; nothing is left on the host.
# =============================================================================
{
set -euo pipefail
set +x

APP_DIR="${DEPLOY_PATH:-/opt/lead-capture-pro/app}"
STATE_DIR="${STATE_DIR:-/opt/lead-capture-pro/env}"
ENV_FILE="$STATE_DIR/.env"
PHASE="${PHASE:-preflight}"
ARG1="${ARG1:-}"; ARG2="${ARG2:-}"; ARG3="${ARG3:-}"
# Fixed baselines (never inputs): accepted commit, expected hosted commit, fingerprints, env file, census, tenant baseline.
ACCEPTED_SHA="72a24378947134ca8e4d3460294474894c9aaee4"
EXPECTED_HOSTED_SHA="eb2edb0ad84d859b66efbc24ea9b895f76c2ed02"
EXPECTED_PREVIOUS_SHA="5a072fdc50e3448bd548574698f81076191cd9bc"
FP_BEFORE="ce55dfa2959cc89c2baad2923217842a"
FP_AFTER="30c4ecbd867cd2cd59abcb58581ecb04"
ENV_SHA_PREFIX="8bc9ef9a2f8554bf"; ENV_SIZE="889"; ENV_MODE="600"
TENANT_BASELINE_MD5="9f8f3adadc282d1b5b929582ec99b901"
CENSUS_OBJECTS="4"; CENSUS_BYTES="1299"; REFERENCES="4"
COUNTS_BEFORE="tables=72 columns=1011 indexes=241 constraints=257 foreign_keys=148"
COUNTS_AFTER="tables=73 columns=1034 indexes=246 constraints=258 foreign_keys=148"
BACKUP_DIR="/opt/lead-capture-pro/backups/postgres"
LOCK_FILE="$HOME/.b25-stage1-activation.lock"
WT_ROOT="$HOME/b25-stage1-worktree"
IMAGE="cardscanner/migrate:b25-stage1"
SMOKE_DOMAIN="b25smoke.invalid"

log()  { echo "[b25-s1:$PHASE] $*" >&2; }
fail() { echo "[b25-s1:$PHASE] ERROR: $*" >&2; exit 1; }
section() { echo; echo "== $* =="; }
compose() { docker compose -f docker-compose.yml -f compose.vps.yml "$@"; }
q()  { compose exec -T postgres sh -c 'exec psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tA -F "|" -c "set default_transaction_read_only = on" -c "$1"' sh "$1"; }
qw() { compose exec -T postgres sh -c 'exec psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tA -F "|" -c "$1"' sh "$1"; }
envkey() {
  local key="$1" allow="${2:-no}" line val
  line="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 || true)"
  if [ -z "$line" ]; then echo "$key: unset"; return; fi
  val="${line#*=}"; val="${val%\"}"; val="${val#\"}"
  if [ "$allow" = "yes" ]; then echo "$key: '${val}'"; elif [ -z "$val" ]; then echo "$key: set-but-empty"; else echo "$key: set"; fi
}
fingerprint() { q "select md5(string_agg(t, '|' order by t)) from (select table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') as t from information_schema.columns where table_schema='public' union all select 'idx:'||indexname||':'||indexdef from pg_indexes where schemaname='public' union all select 'con:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace) s"; }
counts() { q "select 'tables='||(select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')||' columns='||(select count(*) from information_schema.columns where table_schema='public')||' indexes='||(select count(*) from pg_indexes where schemaname='public')||' constraints='||(select count(*) from pg_constraint where connamespace='public'::regnamespace)||' foreign_keys='||(select count(*) from pg_constraint where connamespace='public'::regnamespace and contype='f')"; }
existing_core() {
  q "select 'company1: status='||c.status||' plan='||c.plan||' name_md5='||md5(c.name)||' | sub: status='||s.status||' plan='||s.plan||' source='||s.billing_source||' overrides='||s.limit_overrides::text||' trial_expires='||coalesce(s.trial_expires_at::text,'null')||' status_changed='||s.status_changed_at::text||' stripe='||(s.stripe_customer_id is not null or s.stripe_subscription_id is not null)||' | users='||(select count(*) from users where company_id=1)||' users_active='||(select count(*) from users where company_id=1 and deleted_at is null and is_active)||' roles='||(select count(*) from roles where company_id=1)||' user_roles='||(select count(*) from user_roles ur join users u on u.id=ur.user_id where u.company_id=1)||' perms_md5='||md5(coalesce((select string_agg(u.id||':'||u.role||':'||u.permissions::text, ',' order by u.id) from users u where u.company_id=1),''))||' contacts='||(select count(*) from contacts where company_id=1)||' leads='||(select count(*) from leads where company_id=1)||' events='||(select count(*) from events where company_id=1)||' tasks='||(select count(*) from tasks where company_id=1)||' tags='||(select count(*) from tags where company_id=1)||' lead_tags='||(select count(*) from lead_tags where company_id=1)||' documents='||(select count(*) from documents where company_id=1)||' wf_defs='||(select count(*) from workflow_definitions where company_id=1)||' wf_runs='||(select count(*) from workflow_runs where company_id=1)||' intents='||(select count(*) from billing_checkout_sessions where company_id=1)||' reservations='||(select count(*) from subscription_usage_reservations where company_id=1) from companies c join subscriptions s on s.company_id=c.id where c.id=1"
}
# Canonical digest of the existing-tenant composition: the accepted TENANT_BASELINE_MD5 was computed by the Stage 1
# inspection as md5 of the composition WITHOUT a terminating newline. Bash command substitution removes the trailing
# newline(s) psql appends; every internal byte is preserved; printf '%s' adds nothing. Fail closed: a failed or empty
# (or whitespace-only) read never yields a digest, so a caller can never compare a bogus value as a valid baseline.
tenant_md5() {
  local core
  if ! core="$(existing_core)"; then
    echo "::error::could not read the existing-tenant baseline" >&2
    return 1
  fi
  [ -n "$core" ] || {
    echo "::error::existing-tenant baseline is empty" >&2
    return 1
  }
  [[ "$core" =~ [^[:space:]] ]] || {
    echo "::error::existing-tenant baseline is blank" >&2
    return 1
  }
  printf '%s' "$core" | md5sum | cut -c1-32
}
# Owner scan rows created during the Gate A device test: existing tenant data, never touched.
scan_rows_md5() { q "select md5(coalesce(string_agg(id||':'||company_id||':'||coalesce(status,'')||':'||coalesce(image_url,'<null>')||':'||created_at::text, ',' order by id),'')) from scans where company_id=1"; }
LEGACY_HANDLE='^/objects/uploads/[0-9a-f-]{36}$'
references() { q "select count(*) from (select object_path r from document_versions where object_path ~ '$LEGACY_HANDLE' union all select object_path from export_runs where object_path ~ '$LEGACY_HANDLE' union all select object_path from executive_reports where object_path ~ '$LEGACY_HANDLE' union all select image_url from scans where image_url ~ '^scans/[0-9]+/[0-9]+\.jpg$' union all select brand_logo_key from companies where brand_logo_key ~ '^branding/[0-9]+/[0-9a-f]{32}\.(png|jpg|webp)$') r"; }
# Correction 5 (batch 6 form): LEGACY vs ACTIVE NATIVE FIRST-PARTY reference. The product's native branding key
# (storage.service.ts referenceFor: branding/<cid>/<id without dashes>.<ext>) has the SAME SHAPE as the legacy logo key,
# so one live tenant logo inflated references() to 5 (run 39442358211: 4 originals + 1 native key). A reference leaves
# the legacy count ONLY when it resolves EXACTLY to one active, ownership-proven (stage2a_live_row_sql) branding_logo
# row of the SAME company and no other company and no other active row claims the key. An unknown key stays legacy
# (the count then differs from 4 and the gate fails); a colliding / duplicated key is counted by references_ambiguous
# (must be 0). references() itself is untouched (Stage 1 history). Only the branding kind can collide: every other
# legacy handle (/objects/uploads/<uuid>, scans/<cid>/<n>.jpg) differs in shape from the native /objects/<uuid>.
S2A_LEGACY_LOGO_RE='^branding/[0-9]+/[0-9a-f]{32}\.(png|jpg|webp)$'
# Correction 7 (batch 10, after smoke run 39880703889 stopped in the VPS-side verification with refs_legacy_count=5 /
# refs_ambiguous=1): the SAME-RUN disposable branding allowance. The product writes the smoke tenant's logo exactly like a
# real tenant's (companies.brand_logo_key = the native key, one active fs row with a healthy canonical mirror), but
# stage2a_live_row_sql rightly excludes every 'B25 SMOKE' tenant, so during a smoke the smoke tenant's own key could never
# resolve: it stayed in the legacy count AND in the ambiguous count. stage2a_live_row_sql is UNCHANGED (the protected set P
# keeps its strict real-tenant predicate; a smoke row is never a member of P). A SECOND, narrowly scoped resolution arm
# exists ONLY while a verified same-run smoke-row list is in hand — the csv recorded by this run's stage2a-smoke-verify
# and carried on the stdin stream (never a workflow input, never an SSH argument, never an operator choice): a smoke
# company's logo key resolves ONLY to the ONE recorded branding_logo row of THAT company (stage2a_smoke_logo_sql), and
# only when the recorded list is exactly one document + one branding_logo row of ONE disposable 'B25 SMOKE' tenant, both
# active fs rows with canonical healthy mirrors, a 64-hex digest, a size, no uncertainty, no lease, no legacy location.
# Without the list (every read-only mode, the pre-smoke record, the post-settle and final gates, the tombstone form after
# the smoke companies are deleted) the behaviour is byte-for-byte Correction 5. An unknown, unrecorded or malformed smoke
# key stays in BOTH counts; nothing is ever subtracted — the exclusion is computed from the independently verified row.
# The exclusivity conditions (no other active row claims the key; no other company claims it) apply to both arms.
S2A_SMOKE_NAME_RE='^B25 SMOKE [a-z0-9]{6,12} [a-z0-9]{1,8}$'   # the smoke names its tenants "B25 SMOKE <tag> <suffix>" (b25-stage1-smoke.mjs)
stage2a_smoke_row_sql() {   # [alias.] → SQL predicate: a healthy ACTIVE fs row of a DISPOSABLE 'B25 SMOKE' tenant in the product's own shape (the smoke counterpart of stage2a_live_row_sql; never a member of P; never company 53)
  local a="${1:-}"
  [[ "$a" =~ ^([a-z]+\.)?$ ]] || { echo "stage2a_smoke_row_sql: prefix malformed" >&2; return 1; }
  printf '%s' "(${a}state = 'active' and ${a}driver = 'fs' and ${a}legacy_key is null and ${a}deleted_at is null and ${a}mirror_key is not null and ${a}mirror_key = 'gs://' || split_part(split_part(${a}mirror_key, '://', 2), '/', 1) || '/' || ${a}storage_key and ${a}mirror_state = 'ok' and ${a}last_error is null and ${a}publication_uncertain_at is null and ${a}lease_token is null and ${a}lease_expires_at is null and ${a}sha256 ~ '^[0-9a-f]{64}\$' and ${a}size_bytes > 0 and coalesce(${a}content_type, '') <> '' and ${a}company_id <> $B25PHYS_COMPANY and exists (select 1 from companies lc where lc.id = ${a}company_id and lc.name ~ '$S2A_SMOKE_NAME_RE') and ((${a}kind = 'document' and ${a}reference = '/objects/' || ${a}id::text and ${a}storage_key = 'tenants/' || ${a}company_id || '/documents/' || ${a}id::text) or (${a}kind = 'branding_logo' and ${a}reference ~ ('^branding/' || ${a}company_id || '/' || replace(${a}id::text, '-', '') || '\\.(png|jpg|webp)\$') and $(logo_key_rule_sql "$a"))))"
}
stage2a_smoke_csv_q() {   # <csv> → the quoted uuid list of a VERIFIED same-run smoke-row list (exactly two canonical, distinct uuids, neither the Stage 1 exception); fails for anything else
  stage2a_smoke_rows_validate "$1" || return 1
  printf "'%s'" "$(printf '%s' "$1" | sed "s/,/','/g")"
}
stage2a_smoke_logo_sql() {   # <csv> → SQL boolean over an outer \`companies c\` row: its brand_logo_key resolves EXACTLY to the one recorded branding_logo row of THIS run's smoke tenant (Correction 7 arm; nothing without a verified list; the smoke tenant holds no other non-deleted row)
  local Q sr; Q="$(stage2a_smoke_csv_q "$1")" || { echo "stage2a_smoke_logo_sql: the smoke-row list is not a verified same-run pair" >&2; return 1; }
  sr="$(stage2a_smoke_row_sql 's.')" || return 1
  printf '%s' "(c.name ~ '$S2A_SMOKE_NAME_RE' and (select count(*) from storage_objects s where s.id in ($Q)) = 2 and (select count(*) from storage_objects s where s.id in ($Q) and $sr) = 2 and (select count(*) from storage_objects s where s.id in ($Q) and s.kind = 'document') = 1 and (select count(*) from storage_objects s where s.id in ($Q) and s.kind = 'branding_logo') = 1 and (select count(distinct s.company_id) from storage_objects s where s.id in ($Q)) = 1 and (select count(*) from storage_objects s where s.id in ($Q) and s.kind = 'branding_logo' and s.company_id = c.id and s.reference = c.brand_logo_key and $sr) = 1 and (select count(*) from storage_objects s where s.company_id = c.id and s.state <> 'deleted' and s.id not in ($Q)) = 0)"
}
stage2a_native_logo_sql() {   # [csv] → SQL boolean over an outer \`companies c\` row: its brand_logo_key resolves exactly to one own live branding row (Correction 5 arm) OR — only with a verified same-run list — to the one recorded smoke branding row of that smoke tenant (Correction 7 arm); in both arms no other active row and no other company may claim the key
  local arm sl
  arm="(select count(*) from storage_objects o where o.company_id = c.id and o.kind = 'branding_logo' and o.reference = c.brand_logo_key and $(stage2a_live_row_sql 'o.')) = 1"
  if [ -n "${1:-}" ]; then sl="$(stage2a_smoke_logo_sql "$1")" || return 1; arm="($arm or $sl)"; fi
  printf '%s' "($arm and (select count(*) from storage_objects o2 where o2.reference = c.brand_logo_key and o2.state = 'active') = 1 and (select count(*) from companies c2 where c2.brand_logo_key = c.brand_logo_key) = 1)"
}
references_legacy() {   # [csv] → references() minus the keys that resolve exactly to an active native first-party storage row of the same tenant (Correction 5), or — with the verified same-run list — to this run's recorded smoke branding row (Correction 7); '?' (never a count) when the list is not a verified pair
  local nl; nl="$(stage2a_native_logo_sql "${1:-}")" || { echo "?"; return 1; }
  q "select (select count(*) from (select object_path r from document_versions where object_path ~ '$LEGACY_HANDLE' union all select object_path from export_runs where object_path ~ '$LEGACY_HANDLE' union all select object_path from executive_reports where object_path ~ '$LEGACY_HANDLE' union all select image_url from scans where image_url ~ '^scans/[0-9]+/[0-9]+\.jpg$' union all select brand_logo_key from companies where brand_logo_key ~ '$S2A_LEGACY_LOGO_RE') r) - (select count(*) from companies c where c.brand_logo_key ~ '$S2A_LEGACY_LOGO_RE' and $nl)"
}
references_ambiguous() {   # [csv] → legacy-shaped branding keys that some active storage row claims but that do NOT resolve exactly (foreign tenant / duplicate row / duplicate company / an unrecorded smoke row); '?' when the list is not a verified pair
  local nl; nl="$(stage2a_native_logo_sql "${1:-}")" || { echo "?"; return 1; }
  q "select count(*) from companies c where c.brand_logo_key ~ '$S2A_LEGACY_LOGO_RE' and exists (select 1 from storage_objects o where o.reference = c.brand_logo_key and o.state = 'active') and not $nl"
}
health() { curl -fsS --max-time 5 http://127.0.0.1:18080/healthz >/dev/null && curl -fsS --max-time 5 http://127.0.0.1:18080/api/healthz >/dev/null && curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz | grep -q '"database":"ok","storage":"ok"'; }
wait_healthy() { local waited=0; until health; do waited=$((waited + 5)); [ "$waited" -ge "${1:-150}" ] && return 1; sleep 5; done; return 0; }
# capacity <label> <df options…>: ONE non-negative integer from a single-column df query. The header is
# removed and ONLY leading / trailing whitespace of the data row is trimmed: the row must then be exactly one
# canonical decimal integer. Embedded spaces or tabs (joined tokens), several columns, several data rows, an
# empty answer, "-" (no inode accounting), negative or non-numeric text and a df error all fail closed. Zero is
# a valid value; the caller compares it against the unchanged thresholds.
capacity() {
  local label="$1"; shift
  local out rows
  if ! out="$(df "$@" 2>/dev/null)"; then echo "::error::df failed ($label)" >&2; return 1; fi
  mapfile -t rows < <(printf '%s\n' "$out" | tail -n +2 | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' | awk 'NF')
  [ "${#rows[@]}" = "1" ] || { echo "::error::df returned ${#rows[@]} data rows ($label), expected exactly one" >&2; return 1; }
  [[ "${rows[0]}" =~ ^(0|[1-9][0-9]*)$ ]] || { echo "::error::df value is not a non-negative integer ($label)" >&2; return 1; }
  printf '%s' "${rows[0]}"
}
# Small read-only/controlled node script INSIDE the api container; script and argument travel in env vars (never on disk, never printed).
api_node() {
  local js="$1" arg="${2:-}" errf="$HOME/.b25-s1-node.err" out b64
  b64="$(printf '%s' "$js" | base64 -w0)"
  if out="$(timeout 240 docker compose -f docker-compose.yml -f compose.vps.yml exec -T -e B25_JS_B64="$b64" -e B25_ARG_B64="$arg" api sh -c 'exec node -e "$(printf "%s" "$B25_JS_B64" | base64 -d)"' 2>"$errf")"; then
    printf '%s\n' "$out"
  else
    echo "unavailable (reason: $(head -1 "$errf" | sed -E 's#gs://[^[:space:]]*#<gs>#g; s#https?://[^[:space:]]*#<url>#g; s#/[^[:space:]]+#<path>#g' | cut -c1-160))"
  fi
  rm -f "$errf"
}
# Same as api_node, but the probe's INPUT arrives on stdin (used by Correction 8 for the api process log: the records
# are parsed inside the container and only sanitized counts come back; no record text is ever printed).
api_node_stdin() {
  local js="$1" arg="${2:-}" errf="$HOME/.b25-s1-node.err" out b64
  b64="$(printf '%s' "$js" | base64 -w0)"
  if out="$(timeout 240 docker compose -f docker-compose.yml -f compose.vps.yml exec -T -e B25_JS_B64="$b64" -e B25_ARG_B64="$arg" api sh -c 'exec node -e "$(printf "%s" "$B25_JS_B64" | base64 -d)"' 2>"$errf")"; then
    printf '%s\n' "$out"
  else
    echo "unavailable (reason: $(head -1 "$errf" | sed -E 's#gs://[^[:space:]]*#<gs>#g; s#https?://[^[:space:]]*#<url>#g; s#/[^[:space:]]+#<path>#g' | cut -c1-160))"
  fi
  rm -f "$errf"
}
# Bucket census + per-object digest (names never leave the container): prints JSON {objects, bytes, inventory_md5, generationless, with_marker}.
CENSUS_JS=$(cat <<'JS'
const { Storage } = require("@google-cloud/storage");
const { createHash } = require("node:crypto");
(async () => {
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!bucket) { console.log(JSON.stringify({ census: "no bucket configured" })); return; }
  const storage = new Storage();
  let total = 0, bytes = 0, generationless = 0, withMarker = 0, pageToken, capped = false;
  const lines = [];
  do {
    const [files, next] = await storage.bucket(bucket).getFiles({ maxResults: 1000, autoPaginate: false, pageToken });
    for (const f of files) {
      total += 1; bytes += Number(f.metadata.size || 0);
      const gen = String(f.metadata.generation ?? "");
      if (!/^\d+$/.test(gen)) generationless += 1;
      if (f.metadata.metadata && f.metadata.metadata["lcp-object-id"]) withMarker += 1;
      lines.push(`${f.name}|${gen}|${f.metadata.size}`);
    }
    pageToken = next && next.pageToken;
    if (total >= 20000) { capped = true; break; }
  } while (pageToken);
  lines.sort();
  console.log(JSON.stringify({ objects: total, bytes, capped, generationless, with_marker: withMarker, inventory_md5: createHash("md5").update(lines.join("\n")).digest("hex") }));
})().catch((e) => console.log(JSON.stringify({ census: "error", code: e.code || e.name || "unknown" })));
JS
)
census() { api_node "$CENSUS_JS"; }
# json_flat_field <document> <key>
# Strict validation of a COMPLETE, flat JSON object as printed by the in-container node snippets
# (JSON.stringify of a one-level object: integers, booleans, null, plain strings, arrays of plain strings;
# no nesting, no escapes, no whitespace), followed by the value token of ONE top-level field.
#   - every integer token in the document must satisfy the JSON integer grammar -?(0|[1-9][0-9]*): a
#     leading-zero form such as 01 or -01 anywhere in the document rejects the whole document;
#   - a plain string may not contain a quote, a backslash (no escapes are supported) or ANY control
#     character (raw newline, tab, carriage return, …), inside a field value or inside an array element;
#   - anything before the opening or after the closing brace, a missing brace, a nested object, a duplicate
#     key, a trailing comma or an unexpected token rejects the whole document.
# The value is taken from the regex match of the requested field itself — there is no newline/tab
# intermediate text that string contents could forge — so a field can exist only at the top level.
# Prints nothing and returns 1 on any rejection or when the key is absent; error text names the key only.
# Implemented with bash's own regex engine — no jq, python or host-side node is assumed.
json_flat_field() {
  local doc="$1" want="$2" rest field key val found=0 out=""
  local STR='"[^"\\[:cntrl:]]*"'
  local INT='-?(0|[1-9][0-9]*)'
  local VAL="($INT|true|false|null|$STR|\[($STR(,$STR)*)?\])"
  local FIELD="\"[a-z0-9_]+\":$VAL"
  [[ "$want" =~ ^[a-z0-9_]+$ ]] || { echo "::error::census document: invalid key requested" >&2; return 1; }
  [[ "$doc" =~ ^\{($FIELD(,$FIELD)*)?\}$ ]] || { echo "::error::census document is not a complete flat JSON object" >&2; return 1; }
  rest="${doc:1:${#doc}-2}"
  local -A seen=()
  while [ -n "$rest" ]; do
    [[ "$rest" =~ ^$FIELD ]] || { echo "::error::census document: field parse failed" >&2; return 1; }
    field="${BASH_REMATCH[0]}"; rest="${rest:${#field}}"
    key="${field%%\":*}"; key="${key#\"}"; val="${field#*\":}"
    [ -z "${seen[$key]+x}" ] || { echo "::error::census document: duplicate key '$key'" >&2; return 1; }
    seen[$key]=1
    if [ "$key" = "$want" ]; then found=1; out="$val"; fi
    if [ -n "$rest" ]; then
      [ "${rest:0:1}" = "," ] || { echo "::error::census document: unexpected token after a field" >&2; return 1; }
      rest="${rest:1}"; [ -n "$rest" ] || { echo "::error::census document: trailing comma" >&2; return 1; }
    fi
  done
  [ "$found" = "1" ] || { echo "::error::census document: top-level field '$want' not found" >&2; return 1; }
  printf '%s' "$out"
}
# census_field <json document> <key> <count|hex32>
# The whole document must pass json_flat_field (so a truncated, prefixed, suffixed, nested, duplicate-key,
# control-character or malformed-number answer is rejected before any field is read); the key must be a
# TOP-LEVEL field; a count must be a bare non-negative decimal integer (zero is valid); a hex32 must be a
# quoted string of exactly 32 lowercase hex characters. Field order never matters. Anything else prints
# nothing, explains on stderr and returns 1, so a caller can never use a bogus or defaulted value. Raw
# provider output is never printed here.
census_field() {
  local json="$1" key="$2" kind="$3" raw
  [[ "$key" =~ ^[a-z0-9_]+$ ]] || { echo "::error::census_field: invalid key" >&2; return 1; }
  case "$kind" in count|hex32) ;; *) echo "::error::census_field: invalid kind for '$key'" >&2; return 1;; esac
  raw="$(json_flat_field "$json" "$key")" || return 1
  case "$kind" in
    count) [[ "$raw" =~ ^(0|[1-9][0-9]*)$ ]] || { echo "::error::census_field: '$key' is not a non-negative decimal integer" >&2; return 1; } ;;
    hex32) [[ "$raw" =~ ^\"[0-9a-f]{32}\"$ ]] || { echo "::error::census_field: '$key' is not a quoted 32-character lowercase hex digest" >&2; return 1; }; raw="${raw:1:32}" ;;
  esac
  printf '%s' "$raw"
}

cd "$APP_DIR/docker"
PG_CID="$(compose ps -q postgres)"; [ -n "$PG_CID" ] || fail "postgres container not found"
API_CID="$(compose ps -q api || true)"
WEB_CID="$(compose ps -q web || true)"; [ -n "$WEB_CID" ] || fail "web container not found"

# ---------------------------------------------------------------------------
# Guards shared by preflight and schema-apply (hosted state must equal the
# accepted inspection baseline — 2026-10-06 run 37480622922).
# ---------------------------------------------------------------------------
guards_before() {
  section "read-only guard"
  if q "create temp table b25_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard did not hold"; else echo "session refuses writes (default_transaction_read_only=on): OK"; fi

  section "1. hosted checkout / deploy state"
  local head cur prev dirty wts
  head="$(git -C "$APP_DIR" rev-parse HEAD)"; cur="$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null || echo none)"; prev="$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null || echo none)"
  dirty="$(git -C "$APP_DIR" status --porcelain | wc -l)"; wts="$(git -C "$APP_DIR" worktree list | wc -l)"
  echo "HEAD=$head current-deploy.sha=$cur previous-deploy.sha=$prev dirty_entries=$dirty worktrees=$wts branch=$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)"
  [ "$head" = "$EXPECTED_HOSTED_SHA" ] && [ "$cur" = "$EXPECTED_HOSTED_SHA" ] || fail "DRIFT: hosted checkout / current-deploy.sha is not $EXPECTED_HOSTED_SHA"
  [ "$prev" = "$EXPECTED_PREVIOUS_SHA" ] || fail "DRIFT: previous-deploy.sha is not $EXPECTED_PREVIOUS_SHA"
  [ "$dirty" = "0" ] || fail "DRIFT: hosted checkout is dirty"
  [ "$wts" = "1" ] || fail "DRIFT: more than one worktree"

  section "2. runtime"
  [ -n "$API_CID" ] || fail "api container not running"
  for svc in postgres api web; do
    local cid; cid="$(compose ps -q "$svc")"
    docker inspect -f "$svc: id={{.Id}} image={{.Config.Image}} started={{.State.StartedAt}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}} restarts={{.RestartCount}}" "$cid"
    [ "$(docker inspect -f '{{.State.Status}}' "$cid")" = "running" ] || fail "$svc is not running"
  done
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$PG_CID")" = "healthy" ] || fail "postgres is not healthy"
  echo "postgres volume: $(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}' "$PG_CID")"
  [ "$(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}' "$PG_CID")" = "card-scanner-pro_pgdata" ] || fail "DRIFT: postgres volume is not card-scanner-pro_pgdata"
  echo "api runtime identity: $(compose exec -T api id 2>/dev/null || echo unavailable)"
  echo "readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE)"
  health || fail "health / readiness (database + storage ok) failed"
  echo "objectdata volume present: $(docker volume ls --format '{{.Name}}' | grep -c 'objectdata' || true) (expected 0 before deployment)"

  section "3. database"
  q "select 'server='||version()"
  local c fp; c="$(counts)"; echo "$c"; [ "$c" = "$COUNTS_BEFORE" ] || fail "DRIFT: catalog counts differ from the inspection baseline ($COUNTS_BEFORE)"
  fp="$(fingerprint)"; echo "schema_fingerprint=$fp"; [ "$fp" = "$FP_BEFORE" ] || fail "DRIFT: schema fingerprint is not $FP_BEFORE"
  local so_exists; so_exists="$(q "select to_regclass('public.storage_objects') is not null")" || fail "could not verify that storage_objects is absent"
  [ "$so_exists" = "f" ] || fail "DRIFT: storage_objects already exists"
  q "select 'companies='||(select count(*) from companies)||' users='||(select count(*) from users)||' scans='||(select count(*) from scans)||' export_runs='||(select count(*) from export_runs)||' documents='||(select count(*) from documents)"
  local t; t="$(tenant_md5)" || fail "could not compute the existing-tenant baseline digest"
  echo "tenant_baseline_md5=$t accepted=$TENANT_BASELINE_MD5 (canonical digest: trailing newline excluded; composition never printed)"
  [ "$t" = "$TENANT_BASELINE_MD5" ] || fail "DRIFT: existing-tenant baseline differs from the accepted activation baseline"
  echo "owner_scan_rows_md5=$(scan_rows_md5) (4 image-less scan rows: existing tenant data, never touched)"
  [ "$(q "select count(*) from scans where company_id=1")" = "4" ] || fail "DRIFT: owner scan rows are not 4"
  local refs; refs="$(references)"; echo "database_references=$refs"; [ "$refs" = "$REFERENCES" ] || fail "DRIFT: legacy references are not $REFERENCES"
  q "select 'job_queue: '||coalesce(string_agg(status||'='||n, ' '), 'empty') from (select status, count(*) n from job_queue group by status order by status) s"
  [ "$(q "select count(*) from job_queue where status='dead'")" = "0" ] || fail "DRIFT: dead-letter jobs present"
  [ "$(q "select count(*) from job_queue where status='running'")" = "0" ] || echo "note: jobs currently running (ordinary scheduler activity)"

  section "4. environment"
  echo "$(stat -c 'mode=%a size=%s' "$ENV_FILE") sha256_prefix=$(sha256sum "$ENV_FILE" | cut -c1-16)"
  [ "$(stat -c %a "$ENV_FILE")" = "$ENV_MODE" ] && [ "$(stat -c %s "$ENV_FILE")" = "$ENV_SIZE" ] && [ "$(sha256sum "$ENV_FILE" | cut -c1-16)" = "$ENV_SHA_PREFIX" ] || fail "DRIFT: env file mode / size / checksum differ from the inspection baseline"
  for k in OBJECT_STORAGE_DRIVER OBJECT_STORAGE_FS_ROOT OBJECT_STORAGE_ENCRYPTION_KEY OBJECT_STORAGE_LEGACY_FALLBACK OBJECT_STORAGE_MIRROR OBJECT_STORAGE_LEGACY_DELETE; do
    envkey "$k"; grep -qE "^$k=" "$ENV_FILE" && fail "DRIFT: $k is present in the env file" || true
  done
  envkey OBJECT_STORAGE_AUTH yes; envkey JOBS_DRIVER yes
  [ "$(compose exec -T api sh -c 'for k in OBJECT_STORAGE_DRIVER OBJECT_STORAGE_FS_ROOT OBJECT_STORAGE_ENCRYPTION_KEY OBJECT_STORAGE_LEGACY_FALLBACK OBJECT_STORAGE_MIRROR OBJECT_STORAGE_LEGACY_DELETE; do eval v=\"\${$k:-}\"; [ -z "$v" ] || echo set; done' | grep -c set || true)" = "0" ] || fail "DRIFT: an OBJECT_STORAGE_* variable is set in the api container"
  echo "driver: Google Cloud (pre-B25 code; readyz storage=ok via the bucket probe)"

  section "5. Google Cloud census + reconciliation (read-only; counts and digests only)"
  local cj o b gl wm; cj="$(census)"; echo "$cj"
  o="$(census_field "$cj" objects count)" || fail "census: objects count missing or malformed"
  b="$(census_field "$cj" bytes count)" || fail "census: bytes count missing or malformed"
  [ "$o" = "$CENSUS_OBJECTS" ] && [ "$b" = "$CENSUS_BYTES" ] || fail "DRIFT: bucket census is not $CENSUS_OBJECTS objects / $CENSUS_BYTES bytes"
  gl="$(census_field "$cj" generationless count)" || fail "census: generationless count missing or malformed"
  [ "$gl" = "0" ] || fail "DRIFT: generation-less object present"
  wm="$(census_field "$cj" with_marker count)" || fail "census: with_marker count missing or malformed"
  [ "$wm" = "0" ] || fail "DRIFT: an object already carries the B25 ownership marker"
  INVENTORY_MD5="$(census_field "$cj" inventory_md5 hex32)" || fail "census: inventory digest missing or malformed"
  echo "gcs_inventory_md5=$INVENTORY_MD5 (sorted name|generation|size digest; names never printed)"
  local refs_b64; refs_b64="$(q "select coalesce(json_agg(json_build_object('r', object_path, 's', file_size)), '[]'::json) from export_runs where object_path ~ '$LEGACY_HANDLE'" | base64 -w0)"
  RECON_JS=$(cat <<'JS'
const { Storage } = require("@google-cloud/storage");
(async () => {
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  const priv = (process.env.PRIVATE_OBJECT_DIR || "").replace(/^\/+/, "").split("/").slice(1).join("/");
  const refs = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "[]");
  const storage = new Storage();
  let present = 0, missing = 0, sizeMatch = 0;
  for (const r of refs) {
    const name = `${priv}/uploads/${r.r.slice("/objects/uploads/".length)}`;
    try { const [m] = await storage.bucket(bucket).file(name).getMetadata(); present += 1; if (Number(m.size) === Number(r.s)) sizeMatch += 1; }
    catch (e) { if (e && e.code === 404) missing += 1; else throw e; }
  }
  console.log(JSON.stringify({ referenced: refs.length, present, missing, size_match: sizeMatch }));
})().catch((e) => console.log(JSON.stringify({ reconciliation: "error", code: e.code || e.name || "unknown" })));
JS
)
  local rj rpresent rmissing rsize; rj="$(api_node "$RECON_JS" "$refs_b64")"; echo "$rj"
  rpresent="$(census_field "$rj" present count)" || fail "reconciliation: present count missing or malformed"
  rmissing="$(census_field "$rj" missing count)" || fail "reconciliation: missing count missing or malformed"
  rsize="$(census_field "$rj" size_match count)" || fail "reconciliation: size_match count missing or malformed"
  [ "$rpresent" = "$REFERENCES" ] && [ "$rmissing" = "0" ] && [ "$rsize" = "$REFERENCES" ] || fail "DRIFT: a referenced legacy object is missing or its size changed"

  section "6. logs / capacity"
  echo "api error-level lines: $(docker logs "$API_CID" 2>&1 | grep -c '"level":50' || true); unhandled: $(docker logs "$API_CID" 2>&1 | grep '"level":50' | grep -vc '"type":"_AppError"' || true); storage/sweep warnings: $(docker logs "$API_CID" 2>&1 | grep -E '"level":(40|50)' | grep -ciE 'storage|sweep' || true)"
  [ "$(docker logs "$API_CID" 2>&1 | grep -E '"level":(40|50)' | grep -ciE 'storage|sweep' || true)" = "0" ] || fail "unexpected storage / sweep warnings in the api log"
  # GNU df: -i and --output are mutually exclusive; the inode column is requested through --output alone.
  local avail ifree
  avail="$(capacity "bytes available on /" -B1 --output=avail /)" || fail "could not read the free disk capacity"
  ifree="$(capacity "inodes available on /" --output=iavail /)" || fail "could not read the free inode capacity"
  echo "disk_avail_bytes=$avail inodes_free=$ifree backup_dir_bytes=$(du -sb "$BACKUP_DIR" 2>/dev/null | cut -f1)"
  [ "$avail" -gt $((10 * 1024 * 1024 * 1024)) ] || fail "less than 10 GiB free"
  [ "$ifree" -gt 1000000 ] || fail "fewer than 1,000,000 free inodes"
}

phase_preflight() {
  guards_before
  echo "now_utc=$(date -u +%FT%TZ)"
  log "preflight complete (read-only; every baseline matched)"
}

# ---------------------------------------------------------------------------
# schema-apply: the only database-mutating phase (additive CREATE TABLE).
# ---------------------------------------------------------------------------
STAGE="init"
api_was_stopped=0
on_exit_schema() {
  local rc=$?
  if [ "$api_was_stopped" = "1" ]; then
    echo "[b25-s1:schema-apply] EXIT trap (stage '$STAGE', rc=$rc): making sure the api is running" >&2
    compose up -d --no-deps api >/dev/null 2>&1 || true
    if wait_healthy 150; then echo "[b25-s1:schema-apply] api restored: healthy" >&2; else echo "[b25-s1:schema-apply] !!!! api NOT healthy after restore — operator action required" >&2; fi
  fi
  git -C "$APP_DIR" worktree remove --force "$WT_ROOT/apply" >/dev/null 2>&1 || true; rm -rf "$WT_ROOT"; git -C "$APP_DIR" worktree prune >/dev/null 2>&1 || true
  docker rmi "$IMAGE" >/dev/null 2>&1 || true
  rm -f "$HOME"/b25-stage1-push*.log
  rm -f "$LOCK_FILE"
  [ $rc -eq 0 ] || echo "!!!! SCHEMA-APPLY ABORTED at stage '$STAGE' (exit $rc)" >&2
}

phase_schema_apply() {
  section "0. activation lock"
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail "another activation holds the lock ($LOCK_FILE)"
  trap on_exit_schema EXIT
  STAGE="guards"
  guards_before
  [ "$(pgrep -fc 'backup-postgres.sh' || true)" = "0" ] || fail "a backup process is running"
  [ "$(pgrep -fc 'deploy-vps.sh' || true)" = "0" ] || fail "a deploy process is running"

  STAGE="backup"
  section "7. fresh verified backup (hardened backup-postgres.sh; KEEP = existing + 1)"
  grep -q 'flock -n' "$APP_DIR/docker/scripts/backup-postgres.sh" && grep -q '^if ! ln ' "$APP_DIR/docker/scripts/backup-postgres.sh" || fail "deployed backup script is not the hardened revision"
  local nb keep out size sum
  nb="$(ls -1 "$BACKUP_DIR"/leadcapture-*.sql.gz 2>/dev/null | wc -l)"; keep=$((nb + 1))
  out="$(cd "$APP_DIR" && DEPLOY_PATH="$APP_DIR" BACKUP_DIR="$BACKUP_DIR" KEEP="$keep" timeout 600 bash docker/scripts/backup-postgres.sh 2>&1 | tee /dev/stderr | grep -oE "$BACKUP_DIR/leadcapture-[0-9]{8}-[0-9]{6}\.sql\.gz" | head -1)"
  [ -n "$out" ] && [ -f "$out" ] && [ -f "$out.sha256" ] || fail "backup file / sidecar not found"
  gzip -t "$out" || fail "backup gzip integrity check failed"
  (cd "$BACKUP_DIR" && sha256sum -c --quiet "$(basename "$out").sha256") || fail "backup sidecar checksum mismatch"
  size="$(stat -c %s "$out")"; sum="$(cut -c1-16 "$out.sha256")"
  echo "backup_file=$(basename "$out") size=$size sha256_prefix=$sum retained=$(ls -1 "$BACKUP_DIR"/leadcapture-*.sql.gz | wc -l)"
  [ "$size" -ge 1024 ] || fail "backup is implausibly small"
  declare -f backup_structure_check >/dev/null || fail "apply library not loaded (stream b25-stage1-apply-lib.sh before this script)"
  backup_structure_check "$out" 72 "$(q "select count(*) from companies")" || fail "backup structure check failed (complete marker / 72 tables / companies rows)"
  (cd "$APP_DIR" && BACKUP_DIR="$BACKUP_DIR" BACKUP_MAX_AGE_HOURS=1 bash docker/scripts/backup-check.sh) || fail "backup-check.sh did not pass"

  STAGE="record"
  section "8. pre-mutation record"
  local tb; tb="$(tenant_md5)" || fail "could not compute the existing-tenant baseline digest"
  [ "$tb" = "$TENANT_BASELINE_MD5" ] || fail "tenant baseline changed before the mutation"
  echo "schema_fingerprint=$(fingerprint) env_sha256_prefix=$(sha256sum "$ENV_FILE" | cut -c1-16) api_container=$API_CID postgres_container=$PG_CID web_container=$WEB_CID pg_volume=card-scanner-pro_pgdata tenant_baseline_md5=$tb gcs_inventory_md5=$INVENTORY_MD5"
  local q_before; q_before="$(q "select coalesce(string_agg(status||'='||n, ' '), 'empty') from (select status, count(*) n from job_queue group by status order by status) s")"; echo "queue_baseline: $q_before"
  local pg_net; pg_net="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$PG_CID" | head -c 200)"

  STAGE="image"
  section "9. migrate image from exactly $ACCEPTED_SHA (isolated worktree; the app checkout stays at $EXPECTED_HOSTED_SHA)"
  git -C "$APP_DIR" fetch --quiet origin "refs/heads/claude/b25-object-storage-hostinger:refs/remotes/origin/claude/b25-object-storage-hostinger"
  git -C "$APP_DIR" cat-file -e "$ACCEPTED_SHA^{commit}" || fail "accepted commit not present after fetch"
  git -C "$APP_DIR" merge-base --is-ancestor "$EXPECTED_HOSTED_SHA" "$ACCEPTED_SHA" || fail "accepted commit does not descend from the deployed base"
  rm -rf "$WT_ROOT"; mkdir -p "$WT_ROOT"; git -C "$APP_DIR" worktree prune
  git -C "$APP_DIR" worktree add --quiet --detach "$WT_ROOT/apply" "$ACCEPTED_SHA"
  [ "$(git -C "$WT_ROOT/apply" rev-parse HEAD)" = "$ACCEPTED_SHA" ] || fail "worktree is not at the accepted commit"
  [ "$(git -C "$APP_DIR" rev-parse HEAD)" = "$EXPECTED_HOSTED_SHA" ] || fail "app checkout moved"
  export DOCKER_BUILDKIT=1
  docker build --quiet -f "$WT_ROOT/apply/docker/Dockerfile.api" --target migrate -t "$IMAGE" "$WT_ROOT/apply" >/dev/null || fail "migrate image build failed"
  echo "image: $(docker image inspect "$IMAGE" -f '{{.Id}} size={{.Size}}')"
  run_in_image() { docker run --rm --network "$pg_net" --env-file "$ENV_FILE" --entrypoint sh "$IMAGE" -c "$*" </dev/null; }
  echo "drizzle-kit: $(run_in_image 'cd lib/db && npx drizzle-kit --version' 2>/dev/null | tail -1)"

  STAGE="stop-api"
  section "10. stop the api (queue + schedulers live there); EXIT trap restores it"
  echo "downtime_start=$(date -u +%FT%TZ)"
  api_was_stopped=1
  compose stop api >/dev/null 2>&1 || fail "could not stop api"
  compose ps --status running api --format '{{.Name}}' | grep -q . && fail "api still running"
  STAGE="quiesce"
  local active tries=0
  until [ "$(q "select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state is not null and state<>'idle'")" = "0" ]; do tries=$((tries + 1)); [ "$tries" -le 12 ] || fail "database still has active application backends"; sleep 5; done
  active="$(q "select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state is not null and state<>'idle'")"; echo "non-idle backends (excluding this session): $active"
  [ "$(fingerprint)" = "$FP_BEFORE" ] || fail "fingerprint changed before the push"

  STAGE="push"
  section "11. drizzle-kit push --verbose (allow-list: exactly the 5 accepted statements)"
  run_in_image 'cd lib/db && npx drizzle-kit push --verbose --config ./drizzle.config.ts' 2>&1 | grep -v "Pulling schema" > "$HOME/b25-stage1-push1.log" || true
  sed 's/^/  /' "$HOME/b25-stage1-push1.log"
  declare -f push_allowlist_check >/dev/null || fail "apply library not loaded (stream b25-stage1-apply-lib.sh before this script)"
  push_allowlist_check "$HOME/b25-stage1-push1.log" || fail "the proposed statements are not exactly the 5 accepted ones — STOP (api restored by the EXIT trap)"

  STAGE="verify"
  section "12. verify"
  # Boolean, schema-qualified existence: regclass TEXT rendering depends on search_path (storage_objects vs
  # public.storage_objects) and must never be compared; a query error, empty or unexpected answer fails closed.
  local so_exists; so_exists="$(q "select to_regclass('public.storage_objects') is not null")" || fail "could not verify that storage_objects exists"
  [ "$so_exists" = "t" ] || fail "storage_objects not created"
  [ "$(q "select count(*) from storage_objects")" = "0" ] || fail "storage_objects is not empty"
  [ "$(q "select is_nullable||':'||coalesce(column_default,'<none>') from information_schema.columns where table_name='storage_objects' and column_name='publication_uncertain_at'")" = "YES:<none>" ] || fail "publication_uncertain_at is not nullable-without-default"
  local fp c; fp="$(fingerprint)"; c="$(counts)"; echo "schema_fingerprint=$fp"; echo "$c"
  [ "$fp" = "$FP_AFTER" ] || fail "fingerprint after push is not $FP_AFTER"
  [ "$c" = "$COUNTS_AFTER" ] || fail "catalog counts after push differ from the rehearsal ($COUNTS_AFTER)"
  q "select 'storage_objects indexes='||count(*) from pg_indexes where tablename='storage_objects'"
  run_in_image 'cd lib/db && npx drizzle-kit push --config ./drizzle.config.ts' 2>&1 | grep -v "Pulling schema" > "$HOME/b25-stage1-push2.log" || true
  grep -q 'No changes detected' "$HOME/b25-stage1-push2.log" || fail "second push did not report 'No changes detected'"
  echo "second push: No changes detected"
  [ "$(fingerprint)" = "$FP_AFTER" ] || fail "fingerprint changed on the second push"

  STAGE="restart"
  section "13. restart the existing api ($EXPECTED_HOSTED_SHA image; no deployment)"
  compose up -d --no-deps api >/dev/null 2>&1 || fail "could not start api"
  wait_healthy 150 || fail "old api did not become healthy"
  api_was_stopped=0
  API_CID="$(compose ps -q api)"
  echo "downtime_end=$(date -u +%FT%TZ) api_container=$API_CID readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz)"

  STAGE="unchanged"
  section "14. everything else unchanged"
  [ "$(git -C "$APP_DIR" rev-parse HEAD)" = "$EXPECTED_HOSTED_SHA" ] && [ "$(cat "$STATE_DIR/current-deploy.sha")" = "$EXPECTED_HOSTED_SHA" ] || fail "checkout / current-deploy.sha changed"
  [ "$(sha256sum "$ENV_FILE" | cut -c1-16)" = "$ENV_SHA_PREFIX" ] || fail "env file changed"
  [ "$(docker inspect -f '{{.Config.Image}}' "$API_CID")" = "cardscanner/api:latest" ] || fail "api image changed"
  [ "$(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}' "$PG_CID")" = "card-scanner-pro_pgdata" ] || fail "postgres volume changed"
  local tb; tb="$(tenant_md5)" || fail "could not compute the existing-tenant baseline digest"
  [ "$tb" = "$TENANT_BASELINE_MD5" ] || fail "tenant baseline changed"
  [ "$(q "select count(*) from scans where company_id=1")" = "4" ] || fail "owner scan rows changed"
  local cj im; cj="$(census)"; echo "$cj"
  im="$(census_field "$cj" inventory_md5 hex32)" || fail "census after the push: inventory digest missing or malformed"
  [ "$im" = "$INVENTORY_MD5" ] || fail "GCS inventory changed"
  echo "queue after: $(q "select coalesce(string_agg(status||'='||n, ' '), 'empty') from (select status, count(*) n from job_queue group by status order by status) s") (baseline: $q_before)"
  [ "$(q "select count(*) from job_queue where status='dead'")" = "0" ] || fail "dead-letter jobs after restart"
  echo "storage_objects left in place (empty, additive, inert for $EXPECTED_HOSTED_SHA) — never dropped automatically"
  STAGE="done"
  log "schema-apply complete"
}

phase_recover() {
  section "recover (always-step safety net)"
  if ! compose ps --status running api --format '{{.Name}}' | grep -q .; then compose up -d --no-deps api >/dev/null 2>&1 || true; fi
  wait_healthy 150 && echo "api healthy" || echo "!!!! api NOT healthy — operator action required"
  git -C "$APP_DIR" worktree remove --force "$WT_ROOT/apply" >/dev/null 2>&1 || true; rm -rf "$WT_ROOT"; git -C "$APP_DIR" worktree prune >/dev/null 2>&1 || true
  docker rmi "$IMAGE" >/dev/null 2>&1 || true
  rm -f "$HOME"/b25-stage1-push*.log "$LOCK_FILE"
  echo "worktrees=$(git -C "$APP_DIR" worktree list | wc -l) image_present=$(docker image inspect "$IMAGE" >/dev/null 2>&1 && echo yes || echo no) leftover_files=$(ls "$HOME" | grep -c '^b25-' || true) checkout=$(git -C "$APP_DIR" rev-parse HEAD) dirty=$(git -C "$APP_DIR" status --porcelain | wc -l)"
  echo "readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE) schema_fingerprint=$(fingerprint)"
}

# ---------------------------------------------------------------------------
# Post-deployment (B25 api at ACCEPTED_SHA deployed by deploy-dev-vps).
# ---------------------------------------------------------------------------
guards_deployed() {
  section "read-only guard"
  if q "create temp table b25_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard did not hold"; else echo "session refuses writes: OK"; fi
  section "deployed state"
  local head cur prev
  head="$(git -C "$APP_DIR" rev-parse HEAD)"; cur="$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null || echo none)"; prev="$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null || echo none)"
  echo "HEAD=$head current-deploy.sha=$cur previous-deploy.sha=$prev dirty=$(git -C "$APP_DIR" status --porcelain | wc -l) worktrees=$(git -C "$APP_DIR" worktree list | wc -l)"
  [ "$head" = "$ACCEPTED_SHA" ] && [ "$cur" = "$ACCEPTED_SHA" ] || fail "hosted checkout / current-deploy.sha is not $ACCEPTED_SHA (deployment not done or wrong SHA)"
  [ "$prev" = "$EXPECTED_HOSTED_SHA" ] || fail "previous-deploy.sha is not $EXPECTED_HOSTED_SHA"
  [ "$(git -C "$APP_DIR" status --porcelain | wc -l)" = "0" ] || fail "checkout dirty"
  [ -n "$API_CID" ] || fail "api not running"
  health || fail "health / readiness failed"
  echo "readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz)"
  [ "$(fingerprint)" = "$FP_AFTER" ] || fail "schema fingerprint is not $FP_AFTER"
  [ "$(sha256sum "$ENV_FILE" | cut -c1-16)" = "$ENV_SHA_PREFIX" ] && [ "$(stat -c %a "$ENV_FILE")" = "$ENV_MODE" ] || fail "env file changed"
  [ "$(compose exec -T api sh -c 'for k in OBJECT_STORAGE_DRIVER OBJECT_STORAGE_FS_ROOT OBJECT_STORAGE_ENCRYPTION_KEY OBJECT_STORAGE_LEGACY_FALLBACK OBJECT_STORAGE_MIRROR OBJECT_STORAGE_LEGACY_DELETE; do eval v=\"\${$k:-}\"; [ -z "$v" ] || echo set; done' | grep -c set || true)" = "0" ] || fail "an OBJECT_STORAGE_* variable is set"
  echo "entrypoint: $(docker logs "$API_CID" 2>&1 | grep -E '^\[entrypoint\]\s+OBJECT_STORAGE_' | tr -s ' ' | tr '\n' ';')"
  # Both readers consume the whole container log: an early-exiting consumer (head -1 / grep -q) closes
  # the pipe while `docker logs` is still writing, and under pipefail the producer's broken-pipe exit
  # fails the guard although the required record is present (observed in run 37925984811).
  echo "storage init: $(docker logs "$API_CID" 2>&1 | grep -oE '"driver":"[a-z]+","legacyFallback":(true|false),"mirror":(true|false),"legacyDelete":(true|false)' | awk 'NR == 1 { print }')"
  docker logs "$API_CID" 2>&1 | grep -F '"driver":"gcs","legacyFallback":false,"mirror":false,"legacyDelete":false' >/dev/null || fail "storage initialization is not driver=gcs / fallback off / mirror off / legacy delete off"
  [ "$(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}' "$PG_CID")" = "card-scanner-pro_pgdata" ] || fail "postgres volume changed"
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$PG_CID")" = "healthy" ] || fail "postgres not healthy"
  section "objectdata named volume (created by the deployment; must stay empty while GCS is primary)"
  docker volume inspect card-scanner-pro_objectdata -f 'volume card-scanner-pro_objectdata: created={{.CreatedAt}} driver={{.Driver}}' || fail "objectdata volume absent"
  [ "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data/objects"}}{{.Type}}:{{.Name}}{{end}}{{end}}' "$API_CID")" = "volume:card-scanner-pro_objectdata" ] || fail "objectdata is not mounted at /data/objects"
  echo "api /data/objects: $(compose exec -T api sh -c 'stat -c "owner=%u:%g mode=%a" /data/objects; echo "entries=$(ls -A /data/objects | wc -l)"' | tr '\n' ' ')"
  [ "$(compose exec -T api sh -c 'stat -c %u:%g /data/objects')" = "999:999" ] && [ "$(compose exec -T api sh -c 'stat -c %a /data/objects')" = "700" ] || fail "objectdata ownership / mode is not 999:999 / 700"
  [ "$(compose exec -T api sh -c 'ls -A /data/objects | wc -l')" = "0" ] || fail "objectdata is not empty"
  for body in "$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz)" "$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/healthz)"; do echo "$body" | grep -qE '/data/objects|/var/lib/docker|/opt/' && fail "a filesystem path appears in a health body" || true; done
  section "tenant data / references / census"
  local tb; tb="$(tenant_md5)" || fail "could not compute the existing-tenant baseline digest"
  [ "$tb" = "$TENANT_BASELINE_MD5" ] || fail "tenant baseline changed"
  [ "$(q "select count(*) from scans where company_id=1")" = "4" ] || fail "owner scan rows changed"
  [ "$(references)" = "$REFERENCES" ] || fail "legacy references changed"
  [ "$(q "select count(*) from job_queue where status='dead'")" = "0" ] || fail "dead-letter jobs present"
}

phase_postdeploy_verify() {
  guards_deployed
  section "storage_objects after deployment (must be 0 rows before any smoke)"
  local n; n="$(q "select count(*) from storage_objects")"; echo "storage_objects_rows=$n"
  if [ "$n" != "0" ]; then q "select 'row '||id||' company='||company_id||' kind='||kind||' state='||state||' driver='||driver||' created='||created_at from storage_objects order by created_at limit 20"; fail "unexpected storage_objects rows exist — STOP: determine whether a B25-native object was created before any rollback decision"; fi
  local cj o b wm im; cj="$(census)"; echo "$cj"
  o="$(census_field "$cj" objects count)" || fail "census: objects count missing or malformed"
  b="$(census_field "$cj" bytes count)" || fail "census: bytes count missing or malformed"
  [ "$o" = "$CENSUS_OBJECTS" ] && [ "$b" = "$CENSUS_BYTES" ] || fail "bucket census changed"
  wm="$(census_field "$cj" with_marker count)" || fail "census: with_marker count missing or malformed"
  [ "$wm" = "0" ] || fail "an object carries a marker before the smoke"
  im="$(census_field "$cj" inventory_md5 hex32)" || fail "census: inventory digest missing or malformed"
  echo "gcs_inventory_md5=$im"
  [ "$ARG1" = "" ] || { [ "$im" = "$ARG1" ] || fail "GCS inventory digest differs from the preflight baseline"; }
  echo "api error-level lines since start: $(docker logs "$API_CID" 2>&1 | grep -c '"level":50' || true); storage warnings: $(docker logs "$API_CID" 2>&1 | grep -E '"level":(40|50)' | grep -ciE 'storage|sweep' || true)"
  echo "now_utc=$(date -u +%FT%TZ)"
  log "postdeploy-verify complete (read-only)"
}

phase_smoke_setup() {
  guards_deployed
  [[ "$ARG1" =~ ^\$2[aby]\$10\$.{53}$ ]] || fail "ARG1 is not a bcrypt hash"
  [[ "$ARG2" =~ ^b25-smoke-[a-z0-9]{6,12}-owner@b25smoke\.invalid$ ]] || fail "ARG2 is not the disposable owner address"
  [ "$(q "select count(*) from storage_objects")" = "0" ] || fail "storage_objects not empty before the smoke"
  section "insert ONE disposable platform owner (the smoke creates its tenants and users through the API)"
  local pco uid; pco="$(q "select coalesce(min(company_id)::text,'null') from users where role='platform_owner' and deleted_at is null")"
  uid="$(qw "insert into users (email, name, role, company_id, password_hash, is_active, contact_visibility, company_visibility, permissions, email_verified_at) values ('$ARG2', 'B25 smoke operator (disposable)', 'platform_owner', $pco, '$ARG1', true, 'all', 'own', '{}'::jsonb, now()) returning id")"
  echo "disposable_owner_user_id=$uid"
  log "smoke-setup complete"
}

# ARG1 = csv of disposable company ids, ARG2 = csv of disposable user ids. ARG3 MUST be empty: the leak detector
# never travels as an argument. It arrives ONLY as the shell variable B25_LEAK_DETECTOR, set by the first line of the
# stdin stream the workflow prepends (`B25_LEAK_DETECTOR=<43 base64url chars>`), i.e. a variable of this very process:
# never an SSH command argument, never a URL, never an artifact, never SQL text, never a process-list argument.
# The detector is the capability's HMAC signature component — unique to the capability of THIS run. Every comparison
# is a LITERAL match: log bodies through count_literal (awk index(), a plain substring search; the literal reaches awk
# only as B25_LIT in its environment — there is no grep and no process-substitution pattern file; producer and matcher
# statuses are checked independently), and the database columns through psql `position()` with the value bound
# through psql's own variable on stdin. Historical lines of other runs (other capabilities, the shared base64url
# payload prefix, the former `?t=` probe requests) can never match it; a genuine match of this run's capability
# anywhere still fails; an unreadable log fails closed.
read_log_once() {   # <container id> <label>: the complete container log, read exactly once; unreadable or empty → failure
  local body
  body="$(docker logs "$1" 2>&1)" || { echo "[b25-s1:$PHASE] ERROR: $2 log unreadable" >&2; return 1; }
  [ -n "$body" ] || { echo "[b25-s1:$PHASE] ERROR: $2 log is empty" >&2; return 1; }
  printf '%s\n' "$body"
}
emit_text() { printf '%s\n' "$1"; }   # the producer stage of count_literal (a named stage so its status is attributable)
# count_literal <text> <literal>: the number of lines of <text> containing <literal> as PLAIN TEXT.
#   - Literal matching: awk index() (a substring search; never a regex, so regex punctuation in the literal is text).
#   - The literal reaches the matcher ONLY through its environment (B25_LIT) — never a command argument, never a
#     process substitution (an empty pattern file would silently match nothing), never printed.
#   - No blanket error suppression: the producer (emit_text) and the matcher (awk) statuses are captured
#     separately through PIPESTATUS in a subshell with errexit/pipefail off, so neither can be mistaken for a
#     legitimate zero. The count is accepted ONLY when both stages exited 0 AND the output is exactly one decimal
#     integer; a producer failure before or after its output, a matcher error (even one that printed a number),
#     an empty or non-numeric answer, an empty literal or empty input all fail closed (return 1, nothing printed).
#   - A genuine zero is a success: awk exits 0 whether or not anything matched and prints the count only in END,
#     after the whole input was consumed — no early-exiting consumer, so the producer never sees a broken pipe.
count_literal() {
  local lit="$2" out n p0 p1
  [ -n "$lit" ] || { echo "[b25-s1:$PHASE] ERROR: empty literal" >&2; return 1; }
  out="$(set +e +o pipefail; emit_text "$1" | B25_LIT="$lit" awk 'BEGIN { if (length(ENVIRON["B25_LIT"]) == 0) { bad = 3; exit 3 } } index($0, ENVIRON["B25_LIT"]) > 0 { n++ } END { if (bad) exit bad; if (NR == 0) exit 4; printf "%d", n + 0 }'; printf '|%s|%s' "${PIPESTATUS[0]}" "${PIPESTATUS[1]}")"
  n="${out%%|*}"; p1="${out##*|}"; p0="${out%|*}"; p0="${p0##*|}"
  [ "$p0" = "0" ] || { echo "[b25-s1:$PHASE] ERROR: literal count: producer failed (status ${p0:-?}) — fail closed" >&2; return 1; }
  [ "$p1" = "0" ] || { echo "[b25-s1:$PHASE] ERROR: literal count: matcher failed (status ${p1:-?}) — fail closed" >&2; return 1; }
  [[ "$n" =~ ^(0|[1-9][0-9]*)$ ]] || { echo "[b25-s1:$PHASE] ERROR: literal count unreadable — fail closed" >&2; return 1; }
  printf '%s' "$n"
}
qd() {   # <sql using :'det'>: read-only psql; the detector is bound through psql's variable mechanism on STDIN (never argv, never SQL text)
  printf '\\set det %s\n%s\n' "'$B25_LEAK_DETECTOR'" "$1" | compose exec -T postgres sh -c 'exec psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tA -F "|" -c "set default_transaction_read_only = on" -f -'
}
SMOKE_SYNTHETIC_QUERY_VALUE="b25-smoke-SYNTHETIC-NOT-A-CREDENTIAL"   # the ONLY query value the corrected smoke sends (informational count)
phase_smoke_verify() {
  [[ "$ARG1" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "ARG1 must be a csv of company ids"
  [[ "$ARG2" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "ARG2 must be a csv of user ids"
  [ -z "$ARG3" ] || fail "ARG3 must be empty — the leak detector travels on the stdin stream only, never as an argument"
  [[ "${B25_LEAK_DETECTOR:-}" =~ ^[A-Za-z0-9_-]{43}$ ]] || fail "leak detector missing or malformed on the stdin stream — fail closed (no leak verdict without it)"
  trap 'unset B25_LEAK_DETECTOR' EXIT
  local C="$ARG1" U="$ARG2"
  section "disposable targets (names verified)"
  [ "$(q "select count(*) from companies where id in ($C) and name not like 'B25 SMOKE %'")" = "0" ] || fail "a target company is not a smoke tenant"
  [ "$(q "select count(*) from users where id in ($U) and email not like '%@$SMOKE_DOMAIN'")" = "0" ] || fail "a target user is not a smoke user"
  section "inventory rows of the smoke tenants"
  # last_error is printed only when it is a bare code: free text (which could carry a token) is never echoed
  q "select 'row '||id||' company='||company_id||' kind='||kind||' state='||state||' driver='||driver||' legacy_key_set='||(legacy_key is not null)||' mirror_key_set='||(mirror_key is not null)||' lease_cleared='||(lease_token is null)||' size='||coalesce(size_bytes::text,'null')||' sha_set='||(sha256 is not null)||' last_error='||case when coalesce(last_error,'') ~ '^[A-Z_]{0,40}$' then coalesce(last_error,'<null>') else '<non-code text, not printed>' end||' uncertain='||(publication_uncertain_at is not null) from storage_objects where company_id in ($C) order by created_at"
  [ "$(q "select count(*) from storage_objects where company_id not in ($C)")" = "0" ] || fail "storage_objects rows exist outside the smoke tenants"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and driver<>'gcs'")" = "0" ] || fail "a smoke row is not on the gcs driver"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and state='active' and (lease_token is not null or publication_uncertain_at is not null or legacy_key is null)")" = "0" ] || fail "an active smoke row is inconsistent"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and last_error in ('OWNERSHIP_UNPROVEN','CLEANUP_PENDING')")" = "0" ] || fail "ownership-unproven / cleanup-pending residue"
  echo "smoke_row_ids=$(q "select string_agg(id::text, ',' order by created_at) from storage_objects where company_id in ($C)")"
  section "provider objects of the smoke rows (marker = row id, generation string, size) — names never printed"
  local rows_b64; rows_b64="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 's', size_bytes, 'st', state)), '[]'::json) from storage_objects where company_id in ($C)" | base64 -w0)"
  MARKER_JS=$(cat <<'JS'
const { Storage } = require("@google-cloud/storage");
(async () => {
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  const rows = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "[]");
  const storage = new Storage();
  const out = [];
  for (const r of rows) {
    try {
      const [m] = await storage.bucket(bucket).file(r.k).getMetadata();
      const gen = String(m.generation ?? "");
      out.push({ id: r.id, state: r.st, present: true, marker_matches_row: !!(m.metadata && m.metadata["lcp-object-id"] === r.id), generation_is_decimal_string: /^\d+$/.test(gen), generation_digits: gen.length, size_matches: r.s == null ? null : Number(m.size) === Number(r.s) });
    } catch (e) {
      out.push({ id: r.id, state: r.st, present: false, code: e && e.code });
    }
  }
  console.log(JSON.stringify(out));
})().catch((e) => console.log(JSON.stringify({ error: e.code || e.name || "unknown" })));
JS
)
  local mj; mj="$(api_node "$PROVIDER_RULES_JS"$'\n'"$MARKER_JS" "$rows_b64")"; echo "$mj"
  echo "$mj" | grep -q '"marker_matches_row":false' && fail "a smoke object lacks the ownership marker of its row" || true
  echo "$mj" | grep -q '"generation_is_decimal_string":false' && fail "a smoke object generation is not a decimal string" || true
  echo "$mj" | grep -q '"size_matches":false' && fail "a smoke object size differs from its row" || true
  section "capability leak gate — token-specific literal detector of THIS run's capability (counts and verdicts only)"
  # Every log is read exactly once and completely; a read failure or an empty log stops the phase (no verdict is
  # ever derived from a missing log). Producer failures are never masked by an all-zero count.
  local api_body web_body n_api n_web n_audit n_err n_hist n_probe
  api_body="$(read_log_once "$API_CID" api)" || fail "api log unreadable — fail closed"
  web_body="$(read_log_once "$WEB_CID" web)" || fail "web log unreadable — fail closed"
  n_api="$(count_literal "$api_body" "$B25_LEAK_DETECTOR")" || fail "api log: literal count failed — fail closed"
  n_web="$(count_literal "$web_body" "$B25_LEAK_DETECTOR")" || fail "web log: literal count failed — fail closed"
  n_audit="$(qd "select count(*) from audit_logs where position(:'det' in metadata::text) > 0")" || fail "audit metadata: detector query failed — fail closed"
  n_err="$(qd "select count(*) from storage_objects where position(:'det' in coalesce(last_error, '')) > 0")" || fail "storage last_error: detector query failed — fail closed"
  [[ "$n_audit" =~ ^[0-9]+$ ]] && [[ "$n_err" =~ ^[0-9]+$ ]] || fail "detector queries returned no count — fail closed"
  echo "current-run capability (token-specific literal): api log lines=$n_api web log lines=$n_web audit metadata rows=$n_audit storage last_error rows=$n_err"
  # Historical evidence is reported SEPARATELY and never gates a fresh smoke: request lines carrying a '?t=' query
  # (any run, any value — the former probe placed a genuine capability there; the corrected smoke sends only the
  # synthetic value) and the corrected smoke's own two synthetic probes. Logs are never erased or filtered here.
  n_hist="$(count_literal "$web_body" "?t=")" || fail "web log: historical count failed"
  n_probe="$(count_literal "$web_body" "$SMOKE_SYNTHETIC_QUERY_VALUE")" || fail "web log: synthetic-probe count failed"
  echo "historical / informational (web log, no verdict): request lines with a '?t=' query (any run, any value)=$n_hist; lines with this smoke's synthetic probe value=$n_probe (the api request log strips query strings by design)"
  [ "$n_api" = "0" ] || fail "this run's capability found in the api log ($n_api line(s))"
  [ "$n_web" = "0" ] || fail "this run's capability found in the web (proxy) log ($n_web line(s))"
  [ "$n_audit" = "0" ] || fail "this run's capability found in audit metadata ($n_audit row(s))"
  [ "$n_err" = "0" ] || fail "this run's capability found in storage last_error ($n_err row(s))"
  [ "$(q "select count(*) from audit_logs where metadata::text ~ 'gs://|/var/lib/docker|/data/objects|X-Goog-Signature'")" = "0" ] || fail "bucket / path / signature text found in audit metadata"
  echo "api error-level lines: $(printf '%s\n' "$api_body" | grep -c '"level":50' || true); unhandled: $(printf '%s\n' "$api_body" | grep '"level":50' | grep -vc '"type":"_AppError"' || true)"
  [ "$(printf '%s\n' "$api_body" | grep '"level":50' | grep -vc '"type":"_AppError"' || true)" = "0" ] || fail "unhandled error in the api log"
  unset api_body web_body
  section "census during the smoke"
  local cj; cj="$(census)"; echo "$cj"
  echo "storage driver: $(docker logs "$API_CID" 2>&1 | grep -oE '"driver":"[a-z]+","legacyFallback"' | tail -1)"
  unset B25_LEAK_DETECTOR
  log "smoke-verify complete"
}

phase_recreate_api() {
  guards_deployed
  section "recreate the api container (force-recreate; volumes untouched)"
  local before; before="$(docker volume inspect -f '{{.CreatedAt}}' card-scanner-pro_objectdata)"
  compose up -d --no-deps --force-recreate api >/dev/null 2>&1 || fail "recreate failed"
  wait_healthy 150 || fail "api not healthy after recreation"
  API_CID="$(compose ps -q api)"
  echo "api_container=$API_CID readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz)"
  [ "$(docker volume inspect -f '{{.CreatedAt}}' card-scanner-pro_objectdata)" = "$before" ] || fail "objectdata volume identity changed"
  [ "$(compose exec -T api sh -c 'ls -A /data/objects | wc -l')" = "0" ] || fail "objectdata not empty after recreation"
  echo "legacy objects readable at the provider: $(api_node "$CENSUS_JS")"
  log "recreate-api complete"
}

# ARG1 = csv of disposable company ids (already deleted through the API), ARG2 = preflight gcs_inventory_md5,
# ARG3 = csv of the smoke row UUIDs recorded by smoke-verify (the ONLY rows this phase may ever remove)
phase_smoke_settle() {
  [[ "$ARG1" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "ARG1 must be a csv of company ids"
  [[ "$ARG2" =~ ^[0-9a-f]{32}$ ]] || fail "ARG2 must be the preflight inventory md5"
  [[ "$ARG3" =~ ^[0-9a-f-]{36}(,[0-9a-f-]{36})*$ ]] || fail "ARG3 must be a csv of the recorded smoke row uuids"
  declare -f purge_rows_sql >/dev/null || fail "purge library not loaded (stream b25-stage1-purge-lib.sh before this script)"
  local C="$ARG1" UUIDS_Q; UUIDS_Q="'$(printf '%s' "$ARG3" | sed "s/,/','/g")'"
  section "wait for the purge job to settle the smoke tenants' tombstones"
  [ "$(q "select count(*) from companies where id in ($C)")" = "0" ] || fail "a smoke company still exists (API deletion did not happen)"
  local tries=0
  until [ "$(q "select count(*) from storage_objects where company_id in ($C) and state not in ('deleted')")" = "0" ]; do tries=$((tries + 1)); [ "$tries" -le 36 ] || break; sleep 10; done
  q "select 'tombstone '||id||' kind='||kind||' state='||state||' last_error='||case when coalesce(last_error,'') ~ '^[A-Z_]{0,40}$' then coalesce(last_error,'<null>') else '<non-code text, not printed>' end||' legacy_key_set='||(legacy_key is not null)||' mirror_key_set='||(mirror_key is not null)||' uncertain='||(publication_uncertain_at is not null)||' reconciled='||(reconciled_at is not null) from storage_objects where company_id in ($C) order by created_at"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and state<>'deleted'")" = "0" ] || fail "a smoke tombstone did not settle to deleted within 6 minutes"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and (publication_uncertain_at is not null or last_error in ('OWNERSHIP_UNPROVEN','CLEANUP_PENDING'))")" = "0" ] || fail "uncertain / unproven / cleanup-pending residue"
  # every row of the smoke companies must be one of the recorded uuids, and vice versa (present ones)
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and id not in ($UUIDS_Q)")" = "0" ] || fail "a smoke-company row was not recorded during this run — STOP, nothing removed"
  [ "$(q "select count(*) from storage_objects where id in ($UUIDS_Q) and company_id not in ($C)")" = "0" ] || fail "a recorded uuid belongs to a non-smoke company — STOP, nothing removed"
  echo "legacy_retained_before=$(q "select count(*) from storage_objects where company_id in ($C) and last_error='LEGACY_RETAINED'") (legacy deletion is OFF: the product never deletes bucket objects of gcs rows in Stage 1; this phase removes only the disposable smoke objects and their exact tombstones)"

  section "remove ONLY the disposable smoke objects (marker must equal the tombstone id; delete conditioned on the exact generation string)"
  local rows_b64; rows_b64="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key)), '[]'::json) from storage_objects where company_id in ($C) and id in ($UUIDS_Q) and state='deleted'" | base64 -w0)"
  DELETE_JS=$(cat <<'JS'
const { Storage } = require("@google-cloud/storage");
(async () => {
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  const rows = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "[]");
  const storage = new Storage();
  let deleted = 0, absent = 0, refused = 0;
  for (const r of rows) {
    const f = storage.bucket(bucket).file(r.k);
    let m;
    try { [m] = await f.getMetadata(); } catch (e) { if (e && e.code === 404) { absent += 1; continue; } throw e; }
    const d = B25_RULES.shouldDeleteObject(r.id, m);
    if (!d.ok) { refused += 1; continue; }
    await f.delete({ ifGenerationMatch: d.generation });  // exact decimal string; never a number, never unconditional
    deleted += 1;
  }
  console.log(JSON.stringify({ candidates: rows.length, deleted, absent, refused_no_marker_or_generation: refused }));
})().catch((e) => console.log(JSON.stringify({ error: e.code || e.name || "unknown" })));
JS
)
  local dj ddeleted drefused; dj="$(api_node "$PROVIDER_RULES_JS"$'\n'"$DELETE_JS" "$rows_b64")"; echo "$dj"
  ddeleted="$(census_field "$dj" deleted count)" || fail "provider cleanup did not run (no deleted count)"
  drefused="$(census_field "$dj" refused_no_marker_or_generation count)" || fail "provider cleanup did not report the refused count"
  echo "provider cleanup: deleted=$ddeleted refused=$drefused"
  [ "$drefused" = "0" ] || fail "an object was refused (marker / generation) — left in place; investigate (no row will be purged)"

  section "prove every persisted provider location of the recorded tombstones is absent (HEAD metadata; names never printed)"
  local loc_b64; loc_b64="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 'm', mirror_key)), '[]'::json) from storage_objects where id in ($UUIDS_Q)" | base64 -w0)"
  ABSENT_JS=$(cat <<'JS'
const { Storage } = require("@google-cloud/storage");
(async () => {
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  const rows = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "[]");
  const storage = new Storage();
  const name = (gs) => { if (!gs) return null; const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(gs); return m ? { bucket: m[1], object: m[2] } : null; };
  const exists = async (b, o) => { try { await storage.bucket(b).file(o).getMetadata(); return true; } catch (e) { if (e && e.code === 404) return false; throw e; } };
  const out = [];
  for (const r of rows) {
    const l = name(r.l), m = name(r.m);
    const presence = { storage: await exists(bucket, r.k), legacy: l ? await exists(l.bucket, l.object) : null, mirror: m ? await exists(m.bucket, m.object) : null };
    out.push({ id: r.id, absent: B25_RULES.rowAbsent(presence) });
  }
  console.log(JSON.stringify({ checked: rows.length, absent: out.filter((o) => o.absent).length, present_ids: out.filter((o) => !o.absent).map((o) => o.id) }));
})().catch((e) => console.log(JSON.stringify({ error: e.code || e.name || "unknown" })));
JS
)
  local aj achecked aabsent; aj="$(api_node "$PROVIDER_RULES_JS"$'\n'"$ABSENT_JS" "$loc_b64")"; echo "$aj"
  achecked="$(census_field "$aj" checked count)" || fail "absence verification did not run (no checked count)"
  aabsent="$(census_field "$aj" absent count)" || fail "absence verification did not report an absent count"
  local present_rows; present_rows="$(q "select count(*) from storage_objects where id in ($UUIDS_Q)")"
  [ "$achecked" = "$present_rows" ] && [ "$aabsent" = "$present_rows" ] || fail "a persisted provider location of a recorded tombstone still exists — its row is NOT removed; investigate"
  [ "$(compose exec -T api sh -c 'ls -A /data/objects | wc -l')" = "0" ] || fail "objectdata is not empty (a filesystem copy would exist)"

  section "remove the EXACT recorded tombstones (one allow-listed transaction; row-locked re-check; count must match)"
  echo "expected_rows=$present_rows"
  if [ "$present_rows" = "0" ]; then
    echo "already removed by a previous run — nothing to delete"
  else
    local triple; triple="$(qw "$(purge_rows_sql "$UUIDS_Q" "$C" "$present_rows")")"
    purge_result_check "$triple" "$present_rows" || fail "the allow-listed delete did not remove exactly the expected rows (nothing is removed when any row differs)"
  fi
  [ "$(q "select count(*) from storage_objects where id in ($UUIDS_Q)")" = "0" ] || fail "a recorded tombstone remains"
  [ "$(q "select count(*) from storage_objects where company_id in ($C)")" = "0" ] || fail "a storage row of a smoke company remains"
  [ "$(q "select count(*) from storage_objects s where exists (select 1 from unnest(array[$UUIDS_Q]) u where s.reference like '%' || u || '%' or s.storage_key like '%' || u || '%')")" = "0" ] || fail "a storage row still references a smoke object id"

  section "census back to the baseline; original objects unchanged; no marker anywhere"
  local cj o b im wm; cj="$(census)"; echo "$cj"
  o="$(census_field "$cj" objects count)" || fail "census: objects count missing or malformed"
  b="$(census_field "$cj" bytes count)" || fail "census: bytes count missing or malformed"
  [ "$o" = "$CENSUS_OBJECTS" ] && [ "$b" = "$CENSUS_BYTES" ] || fail "bucket census is not back to $CENSUS_OBJECTS / $CENSUS_BYTES"
  im="$(census_field "$cj" inventory_md5 hex32)" || fail "census: inventory digest missing or malformed"
  [ "$im" = "$ARG2" ] || fail "the original objects' names/generations/sizes changed"
  wm="$(census_field "$cj" with_marker count)" || fail "census: with_marker count missing or malformed"
  [ "$wm" = "0" ] || fail "a marked object remains"
  echo "storage_objects total=$(q "select count(*) from storage_objects") legacy_retained=$(q "select count(*) from storage_objects where last_error='LEGACY_RETAINED'") uncertain=$(q "select count(*) from storage_objects where publication_uncertain_at is not null") unproven=$(q "select count(*) from storage_objects where last_error='OWNERSHIP_UNPROVEN'") (pre-smoke baseline: 0 / 0 / 0 / 0)"
  [ "$(q "select count(*) from storage_objects")" = "0" ] || fail "storage_objects is not back to the pre-smoke baseline (0 rows)"
  log "smoke-settle complete"
}

# ARG1 = csv of disposable company ids or 'none', ARG2 = csv of disposable user ids, ARG3 = tag
phase_cleanup() {
  [[ "$ARG1" =~ ^([0-9]+(,[0-9]+)*|none)$ ]] || fail "ARG1 must be a csv of company ids or 'none'"
  [[ "$ARG2" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "ARG2 must be a csv of user ids"
  [[ "$ARG3" =~ ^[a-z0-9]{6,12}$ ]] || fail "ARG3 must be the smoke tag"
  local C="$ARG1" U="$ARG2" TAG="$ARG3" DOM="$SMOKE_DOMAIN"; [ "$C" = "none" ] && C="-1"
  section "guard: every explicit target is disposable"
  q "select 'company '||id||': '||case when name like 'B25 SMOKE %' then 'disposable' else 'NOT DISPOSABLE' end from companies where id in ($C) order by id" || true
  q "select 'user '||id||': role='||role||' company_id='||coalesce(company_id::text,'null')||' '||case when email like '%@$DOM' then 'disposable' else 'NOT DISPOSABLE' end from users where id in ($U) or company_id in ($C) order by id" || true
  [ "$(q "select count(*) from companies where id in ($C) and name not like 'B25 SMOKE %'")" = "0" ] || fail "a target company is not a smoke tenant"
  [ "$(q "select count(*) from users where id in ($U) and email not like '%@$DOM'")" = "0" ] || fail "a target user is not a smoke user"
  [ "$(q "select count(*) from users where company_id in ($C) and email not like '%@$DOM'")" = "0" ] || fail "a smoke tenant holds a non-smoke user"
  section "storage rows of the smoke tenants BEFORE any deletion (attribution for a later residue_settle: ids, state, key flags)"
  q "select 'row '||id||' company='||company_id||' kind='||kind||' state='||state||' driver='||driver||' legacy_key_set='||(legacy_key is not null)||' mirror_key_set='||(mirror_key is not null)||' lease_set='||(lease_token is not null)||' last_error='||case when coalesce(last_error,'') ~ '^[A-Z_]{0,40}$' then coalesce(last_error,'<null>') else '<non-code text, not printed>' end||' uncertain='||(publication_uncertain_at is not null)||' deleted_at='||coalesce(deleted_at::text,'<null>') from storage_objects where company_id in ($C) order by created_at" || true
  echo "smoke_row_ids=$(q "select coalesce(string_agg(id::text, ',' order by created_at), '') from storage_objects where company_id in ($C)" 2>/dev/null || echo unavailable)"
  section "existing rows BEFORE cleanup (must be identical afterwards)"
  local kept_sql="select 'companies='||(select count(*) from companies where id not in ($C))||' users='||(select count(*) from users where id not in ($U) and (company_id is null or company_id not in ($C)))||' subscriptions='||(select count(*) from subscriptions where company_id not in ($C))||' contacts='||(select count(*) from contacts where company_id not in ($C))||' leads='||(select count(*) from leads where company_id not in ($C))||' events='||(select count(*) from events where company_id not in ($C))||' scans='||(select count(*) from scans where company_id not in ($C))||' documents='||(select count(*) from documents where company_id not in ($C))||' export_runs='||(select count(*) from export_runs where company_id not in ($C))||' audit='||(select count(*) from audit_logs where (company_id is null or company_id not in ($C)) and (user_id is null or user_id not in ($U)))||' activity='||(select count(*) from activity_logs where (company_id is null or company_id not in ($C)) and (user_id is null or user_id not in ($U)))||' login_attempts='||(select count(*) from login_attempts where email not like 'b25-smoke-${TAG}%@$DOM')||' storage_objects_other='||(select count(*) from storage_objects where company_id not in ($C))"
  local before; before="$(q "$kept_sql")"; echo "$before"
  section "delete the explicit disposable rows (child tables first, counted)"
  echo "sessions=$(qw "with d as (delete from sessions where user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
  echo "notifications=$(qw "with d as (delete from notifications where user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
  echo "audit_logs=$(qw "with d as (delete from audit_logs where company_id in ($C) or user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
  echo "activity_logs=$(qw "with d as (delete from activity_logs where company_id in ($C) or user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
  echo "login_attempts=$(qw "with d as (delete from login_attempts where email like 'b25-smoke-${TAG}%@$DOM' returning 1) select count(*) from d")"
  echo "document_versions=$(qw "with d as (delete from document_versions where company_id in ($C) returning 1) select count(*) from d")"
  echo "documents=$(qw "with d as (delete from documents where company_id in ($C) returning 1) select count(*) from d")"
  echo "tenant_users=$(qw "with d as (delete from users where company_id in ($C) returning 1) select count(*) from d")"
  echo "owner_users=$(qw "with d as (delete from users where id in ($U) and email like '%@$DOM' returning 1) select count(*) from d")"
  echo "subscriptions=$(qw "with d as (delete from subscriptions where company_id in ($C) returning 1) select count(*) from d")"
  echo "companies=$(qw "with d as (delete from companies where id in ($C) and name like 'B25 SMOKE %' returning 1) select count(*) from d")"
  section "storage rows of the smoke tenants (smoke-settle must have removed the exact recorded tombstones)"
  q "select 'row '||id||' company='||company_id||' kind='||kind||' state='||state||' last_error='||case when coalesce(last_error,'') ~ '^[A-Z_]{0,40}$' then coalesce(last_error,'<null>') else '<non-code text, not printed>' end||' uncertain='||(publication_uncertain_at is not null) from storage_objects where company_id in ($C) order by created_at" || true
  [ "$(q "select count(*) from storage_objects where company_id in ($C)")" = "0" ] || fail "storage rows of a smoke tenant remain — smoke-settle did not complete; re-run postdeploy_verify's settle step (never broaden cleanup)"
  section "verify zero other disposable rows remain"
  local z; z="$(q "select 'companies='||(select count(*) from companies where id in ($C) or name like 'B25 SMOKE %')||' users='||(select count(*) from users where id in ($U) or email like '%@$DOM')||' subscriptions='||(select count(*) from subscriptions where company_id in ($C))||' sessions='||(select count(*) from sessions where user_id in ($U))||' audit='||(select count(*) from audit_logs where company_id in ($C) or user_id in ($U))||' activity='||(select count(*) from activity_logs where company_id in ($C) or user_id in ($U))||' login_attempts='||(select count(*) from login_attempts where email like 'b25-smoke-${TAG}%@$DOM')||' documents='||(select count(*) from documents where company_id in ($C))||' document_versions='||(select count(*) from document_versions where company_id in ($C))||' storage_rows='||(select count(*) from storage_objects where company_id in ($C))")"; echo "$z"
  echo "$z" | grep -vqE '=[1-9]' || fail "disposable rows remain: $z"
  section "existing rows AFTER cleanup"
  local after; after="$(q "$kept_sql")"; echo "$after"
  [ "$after" = "$before" ] || fail "existing rows changed during cleanup: before[$before] after[$after]"
  local tb; tb="$(tenant_md5)" || fail "could not compute the existing-tenant baseline digest"
  [ "$tb" = "$TENANT_BASELINE_MD5" ] || fail "tenant baseline changed"
  [ "$(q "select count(*) from scans where company_id=1")" = "4" ] || fail "owner scan rows changed"
  echo "owner_scan_rows_md5=$(scan_rows_md5)"
  [ "$(q "select count(*) from storage_objects where publication_uncertain_at is not null or last_error in ('OWNERSHIP_UNPROVEN','CLEANUP_PENDING')")" = "0" ] || fail "uncertain / unproven residue in the inventory"
  echo "storage_objects total=$(q "select count(*) from storage_objects") legacy_retained=$(q "select count(*) from storage_objects where last_error='LEGACY_RETAINED'") (pre-smoke baseline 0 / 0)"
  [ "$(q "select count(*) from storage_objects")" = "0" ] || fail "storage_objects is not back to the pre-smoke baseline"
  local cj o b wm; cj="$(census)"; echo "$cj"
  o="$(census_field "$cj" objects count)" || fail "census: objects count missing or malformed"
  b="$(census_field "$cj" bytes count)" || fail "census: bytes count missing or malformed"
  wm="$(census_field "$cj" with_marker count)" || fail "census: with_marker count missing or malformed"
  [ "$o" = "$CENSUS_OBJECTS" ] && [ "$b" = "$CENSUS_BYTES" ] && [ "$wm" = "0" ] || fail "bucket census / markers not back to the baseline"
  echo "objectdata entries: $(compose exec -T api sh -c 'ls -A /data/objects | wc -l' 2>/dev/null || echo unavailable)"
  [ "$(compose exec -T api sh -c 'ls -A /data/objects | wc -l' 2>/dev/null || echo 1)" = "0" ] || fail "objectdata is not empty"
  rm -f "$HOME"/.b25-s1-node.err
  echo "leftover_files=$(ls "$HOME" | grep -c '^b25-' || true) readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE) schema_fingerprint=$(fingerprint)"
  log "cleanup complete"
}

# ---------------------------------------------------------------------------
# incident_diagnose — READ-ONLY evidence collection after a failed postdeploy_verify run. Everything is
# reported, nothing is repaired: no fail-fast, no database write (q only — qw is never called), no
# container / volume / git / compose mutation, no deployment command, and nothing is written on the host
# except api_node's temporary stderr file (created and removed inside each invocation). Container logs are
# read ONCE per container with a status check (complete readers; a failed read is reported as FAILED and
# never as a count). Printed text is sanitized: URLs, bucket references, host paths, e-mail addresses and
# long tokens are replaced, JSON log lines are reduced to fixed fields, object names never leave the
# container. ARG1 = window start (UTC YYYY-MM-DDTHH:MM:SSZ), ARG2 = window end,
# ARG3 = "<storage row uuid>|<csv company ids>|<csv user ids>|<smoke tag>" (all regex-validated here).
# Section 9 (Correction 9 preparation) inspects the PUBLIC EDGE outside the compose stack read-only: which
# process answers :443, the effective host nginx configuration (`nginx -T`, or the readable files of the
# configuration tree when the dump needs privilege), reduced to structural / header directives of the
# main configuration, the project vhost and the files it includes (other sites: counted, never printed),
# and the response headers observed through the local edge versus the public name. No panel is assumed.
DIAG_BASELINE_INVENTORY_MD5="c1b900fd509bafa1f980d863dc0d195b"   # accepted original inventory digest (report-only comparison)
DIAG_MARKER_JS=$(cat <<'JS'
const { Storage } = require("@google-cloud/storage");
(async () => {
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  const rows = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "[]");
  const storage = new Storage();
  const out = [];
  for (const r of rows) {
    try {
      const [m] = await storage.bucket(bucket).file(r.k).getMetadata();
      const gen = String(m.generation ?? "");
      out.push({ id: r.id, state: r.st, present: true, marker_matches_row: !!(m.metadata && m.metadata["lcp-object-id"] === r.id), generation_is_decimal_string: /^\d+$/.test(gen), generation_digits: gen.length, size_matches: String(r.s) === String(m.size), updated: m.updated || null });
    } catch (e) {
      out.push({ id: r.id, state: r.st, present: false, code: e && e.code });
    }
  }
  console.log(JSON.stringify(out));
})().catch((e) => console.log(JSON.stringify({ error: e.code || e.name || "unknown" })));
JS
)
DIAG_RECON_JS=$(cat <<'JS'
const { Storage } = require("@google-cloud/storage");
(async () => {
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  const priv = (process.env.PRIVATE_OBJECT_DIR || "").replace(/^\/+/, "").split("/").slice(1).join("/");
  const refs = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "[]");
  const storage = new Storage();
  let present = 0, missing = 0, sizeMatch = 0;
  for (const r of refs) {
    const name = `${priv}/uploads/${r.r.slice("/objects/uploads/".length)}`;
    try { const [m] = await storage.bucket(bucket).file(name).getMetadata(); present += 1; if (Number(m.size) === Number(r.s)) sizeMatch += 1; }
    catch (e) { if (e && e.code === 404) missing += 1; else throw e; }
  }
  console.log(JSON.stringify({ referenced: refs.length, present, missing, size_match: sizeMatch }));
})().catch((e) => console.log(JSON.stringify({ reconciliation: "error", code: e.code || e.name || "unknown" })));
JS
)
san() { sed -E 's#gs://[^"[:space:]]*#<gs>#g; s#https?://[^"[:space:]]*#<url>#g; s#file:///?[^"[:space:])]*#<path>#g; s#(/data|/secrets|/opt|/home|/var|/app|/usr|/root|/etc|/tmp)/[^"[:space:])]*#<path>#g; s#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}#<email>#g; s#[A-Za-z0-9_-]{40,}#<token>#g' | cut -c1-240; }
# One sanitized summary line per JSON log line: time level msg err.type err.code statusCode method url(ids masked) err.message.
jsum() {
  local l lvl t ts msg typ code emsg st meth url
  while IFS= read -r l; do
    lvl="$(printf '%s' "$l" | sed -nE 's/.*"level":([0-9]+).*/\1/p')"
    t="$(printf '%s' "$l" | sed -nE 's/.*"time":([0-9]{13}).*/\1/p')"; ts="-"; [ -n "$t" ] && ts="$(date -u -d "@$((t / 1000))" +%H:%M:%S 2>/dev/null || echo "-")"
    msg="$(printf '%s' "$l" | sed -nE 's/.*"msg":"((\\.|[^"\\])*)".*/\1/p')"
    typ="$(printf '%s' "$l" | sed -nE 's/.*"type":"([^"]*)".*/\1/p')"
    code="$(printf '%s' "$l" | sed -nE 's/.*"code":"?([A-Za-z0-9_.-]+)"?.*/\1/p')"
    emsg="$(printf '%s' "$l" | sed -nE 's/.*"message":"((\\.|[^"\\])*)".*/\1/p')"
    st="$(printf '%s' "$l" | sed -nE 's/.*"statusCode":([0-9]+).*/\1/p')"
    meth="$(printf '%s' "$l" | sed -nE 's/.*"method":"([A-Z]+)".*/\1/p')"
    url="$(printf '%s' "$l" | sed -nE 's/.*"url":"([^"?]*)[^"]*".*/\1/p' | sed -E 's#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#<uuid>#g; s#/[0-9]+(/|$)#/<n>\1#g')"
    printf '%s level=%s msg=%s type=%s code=%s status=%s req=%s %s err=%s\n' "$ts" "${lvl:--}" "${msg:--}" "${typ:--}" "${code:--}" "${st:--}" "${meth:--}" "${url:--}" "${emsg:--}" | san
  done
}
# ---- public edge (host-level reverse proxy OUTSIDE the compose stack) — read-only inspection helpers ---------------
# The two public portals are already public constants of the smoke script; nothing else about the host is assumed
# (no CloudPanel / panel assumption: the edge is whatever process answers :443, found below).
PUBLIC_HOSTS="admin.kaptnow.com elite.kaptnow.com"
EDGE_DOMAIN_RE='kaptnow\.com'
EDGE_HDR_RE='^(referrer-policy|server|via|alt-svc|x-powered-by|cf-[a-z-]+|strict-transport-security|x-frame-options|x-content-type-options):'
# Mask addresses, OS user names, credentials and long tokens on configuration lines; certificate / key / log / auth
# lines are never selected by the summarizer in the first place.
edge_san() { sed -E 's#[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}#<email>#g; s#[0-9]{1,3}(\.[0-9]{1,3}){3}#<ip>#g; s#\[[0-9a-fA-F:]+\]#<ip6>#g; s#/home/[^/[:space:]"]+#/home/<user>#g; s#[A-Za-z0-9_-]{40,}#<token>#g; s#(auth_basic|auth_basic_user_file|ssl_[a-z_]*|secret|password|token|api_key)[^;]*#\1 <masked>#Ig' | cut -c1-200; }
# Read-only emulation of `nginx -T` from the readable files of a configuration tree (BFS over `include`; max 200
# files; unreadable files are reported as such). Used only when the real dump is unavailable to this user.
edge_conf_collect() {
  local root="$1" prefix="$2" f inc pat g i=0 n=0
  local -a queue=("$root"); local -A seen=()
  while [ $i -lt ${#queue[@]} ]; do
    f="${queue[$i]}"; i=$((i + 1))
    [ -n "${seen[$f]:-}" ] && continue; seen[$f]=1
    n=$((n + 1)); [ $n -le 200 ] || { echo "# configuration tree truncated at 200 files"; break; }
    if [ ! -r "$f" ]; then echo "# configuration file $f: (unreadable)"; continue; fi
    echo "# configuration file $f:"; cat "$f"; echo
    while IFS= read -r inc; do
      pat="$(printf '%s' "$inc" | sed -nE 's/^[[:space:]]*include[[:space:]]+"?([^;"]+)"?[[:space:]]*;.*/\1/p')"
      [ -n "$pat" ] || continue
      [[ "$pat" = /* ]] || pat="$prefix/$pat"
      for g in $pat; do [ -e "$g" ] && queue+=("$g"); done
    done < <(grep -E '^[[:space:]]*include[[:space:]]' "$f" 2>/dev/null || true)
  done
}
# Summarize a `nginx -T`-style dump: for the main configuration and every file that mentions the project domain or a
# Referrer-Policy, print ONLY structural lines (block openers/closers, listen, server_name, include, header directives,
# proxy_pass, return/rewrite/root/alias/try_files/error_page) with their line number and enclosing block path; every
# other file is counted by directory only (other sites on the host are never printed). Ends with a computed summary.
edge_conf_summary() {
  EDGE_DOMAIN_RE="$EDGE_DOMAIN_RE" awk -v prefix="$1" '
    BEGIN { dre = ENVIRON["EDGE_DOMAIN_RE"] }
    function ctxpath(   k, s) { s = ""; for (k = 1; k <= depth; k++) s = s (k > 1 ? " > " : "") blk[k]; return (s == "" ? "top" : s) }
    function glob2re(g,   r) { r = g; gsub(/[.+^$(){}|\\]/, "\\\\&", r); gsub(/\*/, "[^/]*", r); gsub(/\?/, ".", r); return "^" r "$" }
    function newfile(name, unread) { nf++; fname[nf] = name; funread[nf] = unread; flines[nf] = 0; fsel[nf] = 0; fproj[nf] = 0; fref[nf] = 0; finc[nf] = 0; cur = nf; depth = 0; inApi = 0; if (nf == 1 && name ~ /\/nginx\.conf$/) fmain[nf] = 1 }
    /^# configuration file .*: \(unreadable\)$/ { n = $0; sub(/^# configuration file /, "", n); sub(/: \(unreadable\)$/, "", n); newfile(n, 1); next }
    /^# configuration file .*:$/ { n = $0; sub(/^# configuration file /, "", n); sub(/:$/, "", n); newfile(n, 0); next }
    /^# configuration tree truncated/ { truncated = 1; next }
    cur == 0 { next }
    { flines[cur]++ }
    $0 ~ dre { fproj[cur] = 1 }
    /^[ \t]*#/ { next }
    { line = $0; gsub(/^[ \t]+/, "", line); gsub(/[ \t]+$/, "", line) }
    line == "" { next }
    {
      selected = 0
      if (line ~ /^(server|http|location|map|upstream|if|events|stream|limit_except|types)([ \t]|\{|$)/ || line ~ /^\}/) selected = 1
      if (line ~ /^(server_name|listen|include|add_header|more_set_headers|more_clear_headers|proxy_hide_header|proxy_pass_header|proxy_pass|return|rewrite|root|alias|try_files|error_page|proxy_redirect|proxy_http_version)([ \t]|;|$)/) selected = 1
      if (line ~ /^include[ \t]/) { g = line; sub(/^include[ \t]+"?/, "", g); sub(/"?[ \t]*;.*$/, "", g); if (g !~ /^\//) g = prefix "/" g; finc[cur]++; fincpat[cur, finc[cur]] = glob2re(g) }
      isref = (line ~ /[Rr]eferrer-[Pp]olicy/)
      if (isref) { selected = 1; fref[cur]++ }
      if (line ~ /^location[ \t]/ && line ~ /\/api/) nApiLoc++
      opens = gsub(/\{/, "{", line); closes = gsub(/\}/, "}", line)
      if (opens > 0) { b = line; sub(/[ \t]*\{.*$/, "", b); depth++; blk[depth] = b; if (b ~ /^location[ \t]/ && b ~ /\/api/) inApi = depth }
      if (selected) { fsel[cur]++; fselL[cur, fsel[cur]] = sprintf("L%d [%s] %s", flines[cur], ctxpath(), line); fselH[cur, fsel[cur]] = (line ~ /^(add_header|more_set_headers|more_clear_headers|proxy_hide_header|include)([ \t]|;|$)/) }
      if (isref) { tref++; reff[tref] = cur; refl[tref] = sprintf("%d [%s] %s", flines[cur], ctxpath(), line) }
      if (inApi > 0 && depth >= inApi && line ~ /^(add_header|more_set_headers)[ \t]/) apiOwnAdd++
      if (inApi > 0 && depth >= inApi && line ~ /^proxy_hide_header[ \t]/) apiHide++
      while (closes-- > 0 && depth > 0) { if (inApi == depth) inApi = 0; depth-- }
    }
    END {
      # printable set: main configuration, files mentioning the project domain, and (transitively) files they include
      for (f = 1; f <= nf; f++) show[f] = (fmain[f] || fproj[f]) ? 1 : 0
      do { changed = 0; for (f = 1; f <= nf; f++) if (show[f] && !fmain[f]) for (i = 1; i <= finc[f]; i++) for (g = 1; g <= nf; g++) if (!show[g] && fname[g] ~ fincpat[f, i]) { show[g] = 2; changed = 1 } } while (changed)
      for (f = 1; f <= nf; f++) {
        d = fname[f]; sub(/\/[^\/]*$/, "", d)
        if (funread[f]) { nunread++; udirs[d]++; continue }
        if (show[f]) {
          printf "-- file %d: %s (lines=%d; %s)\n", f, fname[f], flines[f], (fmain[f] ? "main configuration" : (fproj[f] ? "mentions the project domain" : "included by a project file"))
          for (i = 1; i <= fsel[f] && i <= 140; i++) print "  " fselL[f, i]
          if (fsel[f] > 140) printf "  ... %d more selected lines\n", fsel[f] - 140
        } else if (fref[f] > 0) {
          printf "-- file %d: %s/<other-file> (lines=%d; a Referrer-Policy directive in a file that is neither a project file nor included by one: header directives only, name masked)\n", f, d, flines[f]
          for (i = 1; i <= fsel[f] && i <= 140; i++) if (fselH[f, i]) print "  " fselL[f, i]
        } else { nother++; odirs[d]++ }
      }
      printf "-- other files (not printed): %d", nother + 0; for (d in odirs) printf " %s=%d", d, odirs[d]; printf "\n"
      if (nunread > 0) { printf "-- unreadable files: %d", nunread; for (d in udirs) printf " %s=%d", d, udirs[d]; printf "\n" }
      if (truncated) print "-- NOTE: configuration tree truncated at 200 files"
      printf "-- referrer_policy_directives=%d api_location_blocks=%d api_location_own_add_header=%d api_location_proxy_hide_header=%d\n", tref + 0, nApiLoc + 0, apiOwnAdd + 0, apiHide + 0
      for (k = 1; k <= tref; k++) print "   referrer-policy @ " (show[reff[k]] ? fname[reff[k]] : "<other-file>") ":" refl[k]
    }'
}
# Response headers of one URL through a given resolver target: names of every header (no values) + values of the
# allow-listed security/transport headers only.
edge_headers() {
  local url="$1" resolve="${2:-}" raw
  if [ -n "$resolve" ]; then raw="$(curl -sSI --max-time 8 --resolve "$resolve" "$url" 2>/dev/null | tr -d '\r')" || raw=""; else raw="$(curl -sSI --max-time 8 "$url" 2>/dev/null | tr -d '\r')" || raw=""; fi
  [ -n "$raw" ] || { echo "unavailable"; return 0; }
  echo "status=$(printf '%s\n' "$raw" | awk 'NR == 1 { print $2 }') names=[$(printf '%s\n' "$raw" | sed -nE 's/^([A-Za-z0-9-]+):.*/\1/p' | tr 'A-Z' 'a-z' | sort | uniq -c | awk '{ printf "%s%s", (NR > 1 ? "," : ""), ($1 > 1 ? $2 "x" $1 : $2) }')] $(printf '%s\n' "$raw" | tr 'A-Z' 'a-z' | grep -E "$EDGE_HDR_RE" | sed -E 's/[0-9]{1,3}(\.[0-9]{1,3}){3}/<ip>/g' | cut -c1-120 | tr '\n' ' ')"
}
phase_diagnose() {
  [[ "$ARG1" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || fail "ARG1 must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ"
  [[ "$ARG2" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || fail "ARG2 must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ"
  [[ "$ARG3" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\|[0-9]+(,[0-9]+)*\|[0-9]+(,[0-9]+)*\|[a-z0-9]{6,12}$ ]] || fail "ARG3 must be <uuid>|<csv company ids>|<csv user ids>|<tag>"
  local W1="$ARG1" W2="$ARG2" UUID C U TAG DOM="$SMOKE_DOMAIN" x cid svc p
  IFS='|' read -r UUID C U TAG <<<"$ARG3"

  section "0. observation"
  echo "now_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) window=$W1..$W2 residue_row=$UUID companies=$C users=$U tag=$TAG"
  echo "HEAD=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo unavailable) current-deploy.sha=$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null || echo none) previous-deploy.sha=$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null || echo none) dirty=$(git -C "$APP_DIR" status --porcelain 2>/dev/null | wc -l) worktrees=$(git -C "$APP_DIR" worktree list 2>/dev/null | wc -l)"
  if q "create temp table b25_should_fail (x int)" >/dev/null 2>&1; then echo "read-only guard: FAILED (a write succeeded)"; else echo "read-only guard: session refuses writes OK"; fi

  section "1. containers (state, restarts, exit code, OOM; health-check log = start time and exit code only)"
  for svc in api web postgres; do
    cid="$(compose ps -q "$svc" 2>/dev/null || true)"
    if [ -z "$cid" ]; then echo "$svc: NO RUNNING CONTAINER"; continue; fi
    docker inspect -f "$svc: id={{printf \"%.12s\" .Id}} image={{.Config.Image}} created={{.Created}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}} restarts={{.RestartCount}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} pid={{.State.Pid}} ip={{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}" "$cid" 2>/dev/null || echo "$svc: inspect unavailable"
    x="$(docker inspect -f '{{if .State.Health}}{{range .State.Health.Log}}{{.Start}} exit={{.ExitCode}}; {{end}}{{end}}' "$cid" 2>/dev/null | cut -c1-400 || true)"; echo "  health log: ${x:-n/a}"
  done
  echo "all project containers (including exited):"; docker ps -a --filter "name=card-scanner-pro" --format '  {{.Names}} | {{.Status}} | created {{.CreatedAt}}' 2>/dev/null || echo "  unavailable"

  section "2. health paths (through the proxy; inside the api container; from the web container to the api)"
  for p in /healthz /api/healthz /api/readyz; do
    x="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:18080$p" 2>/dev/null || echo 000)"; echo "proxy 127.0.0.1:18080$p -> $x"
  done
  echo "proxy readyz body: $(curl -sS --max-time 5 http://127.0.0.1:18080/api/readyz 2>/dev/null | cut -c1-200 || echo unavailable)"
  echo "direct api (node fetch inside the api container): $(compose exec -T api node -e 'fetch("http://127.0.0.1:8080/api/readyz").then(async (r) => console.log(r.status, (await r.text()).slice(0, 200))).catch((e) => console.log("FAILED", e.code || e.name))' 2>/dev/null || echo unavailable)"
  echo "web -> api over the compose network: $(compose exec -T web sh -c 'wget -q -O - --timeout=5 http://api:8080/api/readyz 2>/dev/null | cut -c1-200 || echo FAILED' 2>/dev/null || echo unavailable)"
  echo "web resolves 'api' to: $(compose exec -T web sh -c 'getent hosts api 2>/dev/null || nslookup api 2>/dev/null | grep -A1 "^Name" | tail -1' 2>/dev/null | tr '\n' ' ' || echo unavailable)"
  echo "proxy upstream (nginx -T): $(compose exec -T web sh -c 'nginx -T 2>/dev/null | grep -E "proxy_pass|resolver" | sort -u' 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo unavailable)"
  echo "API_UPSTREAM in the web container: $(compose exec -T web sh -c 'printf %s "$API_UPSTREAM"' 2>/dev/null | cut -c1-120 || echo unavailable)"

  section "2b. response headers by layer for /api/healthz (Referrer-Policy / Cache-Control / Server / Via / X-Powered-By only)"
  echo "direct api: $(compose exec -T api node -e 'fetch("http://127.0.0.1:8080/api/healthz").then((r) => { const h = r.headers; console.log(["referrer-policy","cache-control","server","via","x-powered-by"].map((k) => `${k}=${h.get(k) ?? "<absent>"}`).join(" ")); }).catch((e) => console.log("FAILED", e.code || e.name))' 2>/dev/null || echo unavailable)"
  echo "web proxy: $(curl -sSI --max-time 5 http://127.0.0.1:18080/api/healthz 2>/dev/null | tr -d '\r' | grep -iE '^(referrer-policy|cache-control|server|via|x-powered-by):' | tr '\n' ' ' || echo unavailable)"

  section "3. api log — window $W1..$W2 (sanitized summaries; each stream read once and status-checked)"
  local win all w2ms
  if [ -z "$API_CID" ]; then echo "api container not running — log not read"; win=""; all=""; else
    if ! win="$(docker logs --since "$W1" --until "$W2" "$API_CID" 2>&1)"; then echo "api window log read FAILED (status reported by docker logs)"; win=""; else
      echo "lines=$(printf '%s\n' "$win" | grep -c . || true) level30=$(printf '%s\n' "$win" | grep -c '"level":30' || true) level40=$(printf '%s\n' "$win" | grep -c '"level":40' || true) level50=$(printf '%s\n' "$win" | grep -c '"level":50' || true) level60=$(printf '%s\n' "$win" | grep -c '"level":60' || true) non_json=$(printf '%s\n' "$win" | grep -vc '^{' || true)"
      echo "-- level>=40 lines (max 40):"; printf '%s\n' "$win" | grep -E '"level":(40|50|60)' | awk 'NR<=40' | jsum | sed 's/^/  /' || true
      echo "-- non-JSON lines (max 25: stack traces / process output, paths masked):"; printf '%s\n' "$win" | grep -vE '^\{' | grep -E . | awk 'NR<=25' | san | sed 's/^/  /' || true
      echo "-- requests answered with status>=500 (max 20):"; printf '%s\n' "$win" | grep -E '"statusCode":5[0-9]{2}' | awk 'NR<=20' | jsum | sed 's/^/  /' || true
    fi
    if ! all="$(docker logs "$API_CID" 2>&1)"; then echo "api full log read FAILED"; all=""; else
      echo "-- process starts in the container's whole log (\"Server listening\"):"; printf '%s\n' "$all" | grep -F '"Server listening"' | jsum | sed 's/^/  /' || true
      echo "-- whole-log counters: level50=$(printf '%s\n' "$all" | grep -c '"level":50' || true) unhandled=$(printf '%s\n' "$all" | grep '"level":50' | grep -vc '"type":"_AppError"' || true) level60=$(printf '%s\n' "$all" | grep -c '"level":60' || true) non_json=$(printf '%s\n' "$all" | grep -vc '^{' || true)"
      echo "-- maintenance sweeps (whole log; time + numeric summary):"; printf '%s\n' "$all" | grep -F '"Maintenance sweep complete"' | sed -nE 's/.*"time":([0-9]{13}).*"summary":(\{[^}]*\}).*/\1 \2/p' | while read -r t s; do echo "  $(date -u -d "@$((t / 1000))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo -) $s"; done || true
      echo "-- storage lines mentioning the residual row (whole log, max 30):"; printf '%s\n' "$all" | grep -F "$UUID" | awk 'NR<=30' | jsum | sed 's/^/  /' || true
      w2ms="$(( $(date -u -d "$W2" +%s 2>/dev/null || echo 0) * 1000 ))"
      echo "-- level>=40 after the window (max 20):"; printf '%s\n' "$all" | awk -v w="$w2ms" 'match($0, /"time":[0-9]+/) { t = substr($0, RSTART + 7, RLENGTH - 7) + 0; if (t > w && $0 ~ /"level":(40|50|60)/) print }' | awk 'NR<=20' | jsum | sed 's/^/  /' || true
    fi
  fi

  section "4. web (nginx) log — window (status counts; sanitized upstream error reasons)"
  local wl
  if ! wl="$(docker logs --since "$W1" --until "$W2" "$WEB_CID" 2>&1)"; then echo "web window log read FAILED"; else
    echo "lines=$(printf '%s\n' "$wl" | grep -c . || true) status_502=$(printf '%s\n' "$wl" | grep -cE '" 502 ' || true) status_200=$(printf '%s\n' "$wl" | grep -cE '" 200 ' || true) status_4xx=$(printf '%s\n' "$wl" | grep -cE '" 4[0-9]{2} ' || true) error_lines=$(printf '%s\n' "$wl" | grep -c '\[error\]' || true)"
    echo "-- upstream error reasons (unique, max 10):"; printf '%s\n' "$wl" | grep '\[error\]' | sed -E 's/^.*\] [0-9#]+: \*[0-9]+ //; s/, client:.*$//; s/, server:.*$//' | sort | uniq -c | sort -rn | awk 'NR<=10' | san | sed 's/^/  /' || true
  fi

  section "5. residue of the recorded disposable identities (read-only)"
  echo "-- storage rows (id = residual uuid OR company in $C):"
  q "select 'row '||id||' company='||company_id||' kind='||kind||' state='||state||' driver='||driver||' legacy_key_set='||(legacy_key is not null)||' mirror_key_set='||(mirror_key is not null)||' lease_set='||(lease_token is not null)||' size='||coalesce(size_bytes::text,'null')||' sha_set='||(sha256 is not null)||' last_error='||case when coalesce(last_error,'') ~ '^[A-Z_]{0,40}$' then coalesce(last_error,'<null>') else '<non-code text, not printed>' end||' uncertain='||(publication_uncertain_at is not null)||' deleted_at='||coalesce(deleted_at::text,'<null>')||' reconciled_at='||coalesce(reconciled_at::text,'<null>')||' created='||created_at||' updated='||updated_at from storage_objects where id = '$UUID' or company_id in ($C) order by created_at" 2>/dev/null | sed 's/^/  /' || echo "  unavailable"
  echo "  rows_for_uuid=$(q "select count(*) from storage_objects where id = '$UUID'" 2>/dev/null || echo unavailable) rows_for_companies=$(q "select count(*) from storage_objects where company_id in ($C)" 2>/dev/null || echo unavailable) rows_mentioning_uuid=$(q "select count(*) from storage_objects where reference like '%$UUID%' or storage_key like '%$UUID%' or coalesce(legacy_key,'') like '%$UUID%' or coalesce(mirror_key,'') like '%$UUID%'" 2>/dev/null || echo unavailable)"
  echo "-- disposable rows still present:"
  q "select 'companies='||(select count(*) from companies where id in ($C) or name like 'B25 SMOKE %')||' users='||(select count(*) from users where id in ($U) or email like '%@$DOM')||' subscriptions='||(select count(*) from subscriptions where company_id in ($C))||' sessions='||(select count(*) from sessions where user_id in ($U))||' documents='||(select count(*) from documents where company_id in ($C))||' document_versions='||(select count(*) from document_versions where company_id in ($C))||' audit='||(select count(*) from audit_logs where company_id in ($C) or user_id in ($U))||' activity='||(select count(*) from activity_logs where company_id in ($C) or user_id in ($U))||' login_attempts='||(select count(*) from login_attempts where email like 'b25-smoke-${TAG}%@$DOM')" 2>/dev/null | sed 's/^/  /' || echo "  unavailable"
  echo "-- job queue since $W1 (name status n):"
  q "select '  '||name||' '||status||' n='||count(*) from job_queue where enqueued_at >= '$W1' group by name, status order by 1" 2>/dev/null || echo "  unavailable"
  echo "-- maintenance jobs (last 5):"
  q "select '  maintenance '||status||' enqueued='||enqueued_at||' started='||coalesce(started_at::text,'-')||' completed='||coalesce(completed_at::text,'-')||' attempts='||attempts||' err='||coalesce(left(last_error,100),'-') from job_queue where name='maintenance' order by enqueued_at desc limit 5" 2>/dev/null | san || echo "  unavailable"
  echo "-- storage jobs since $W1 (max 20):"
  q "select '  '||name||' '||status||' enqueued='||enqueued_at||' completed='||coalesce(completed_at::text,'-')||' attempts='||attempts||' err='||coalesce(left(last_error,100),'-') from job_queue where name like 'storage.%' and enqueued_at >= '$W1' order by enqueued_at limit 20" 2>/dev/null | san || echo "  unavailable"
  echo "  $(q "select 'dead_total='||count(*)||' dead_since_window='||count(*) filter (where dead_at >= '$W1') from job_queue where status='dead'" 2>/dev/null || echo "dead jobs: unavailable")"

  section "6. provider metadata of residual rows (ownership marker, generation string, size; names never printed)"
  local rows_json rows_b64
  rows_json="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 's', size_bytes, 'st', state)), '[]'::json) from storage_objects where id = '$UUID' or company_id in ($C)" 2>/dev/null || echo "")"
  if [ -z "$rows_json" ] || [ "$rows_json" = "[]" ]; then echo "no residual rows — provider metadata not queried (the census below shows whether a marked object remains)"; else
    rows_b64="$(printf '%s' "$rows_json" | base64 -w0)"; api_node "$DIAG_MARKER_JS" "$rows_b64" || true
  fi

  section "7. census + preservation (compared with the accepted baselines; report only)"
  local cj o b im wm tb fp
  cj="$(census)"; echo "$cj"
  o="$(census_field "$cj" objects count 2>/dev/null || echo "?")"; b="$(census_field "$cj" bytes count 2>/dev/null || echo "?")"; im="$(census_field "$cj" inventory_md5 hex32 2>/dev/null || echo "?")"; wm="$(census_field "$cj" with_marker count 2>/dev/null || echo "?")"
  local refs_b64 rj
  refs_b64="$(q "select coalesce(json_agg(json_build_object('r', object_path, 's', file_size)), '[]'::json) from export_runs where object_path ~ '$LEGACY_HANDLE'" 2>/dev/null | base64 -w0 || true)"
  rj="$(api_node "$DIAG_RECON_JS" "$refs_b64" 2>/dev/null || echo unavailable)"; echo "original references reconciliation (expected referenced=$REFERENCES present=$REFERENCES missing=0 size_match=$REFERENCES): $rj"
  if [ "$o" = "$CENSUS_OBJECTS" ] && [ "$b" = "$CENSUS_BYTES" ] && [ "$im" = "$DIAG_BASELINE_INVENTORY_MD5" ] && [ "$wm" = "0" ]; then echo "census: MATCHES the accepted original inventory ($CENSUS_OBJECTS / $CENSUS_BYTES / $DIAG_BASELINE_INVENTORY_MD5, no marked object)"; else echo "census: DIFFERS from the accepted original inventory (objects=$o/$CENSUS_OBJECTS bytes=$b/$CENSUS_BYTES digest_match=$([ "$im" = "$DIAG_BASELINE_INVENTORY_MD5" ] && echo yes || echo no) with_marker=$wm) — a marked object is a B25-written object"; fi
  tb="$(tenant_md5 2>/dev/null || echo unavailable)"; echo "tenant_baseline_md5=$tb accepted=$TENANT_BASELINE_MD5 $([ "$tb" = "$TENANT_BASELINE_MD5" ] && echo MATCH || echo DIFFERS)"
  echo "owner_scans=$(q "select count(*) from scans where company_id=1" 2>/dev/null || echo ?) (baseline 4) owner_scan_rows_md5=$(scan_rows_md5 2>/dev/null || echo unavailable) (accepted 8a3e378a2acd0d880c6f45613b32473d)"
  fp="$(fingerprint 2>/dev/null || echo unavailable)"; echo "schema_fingerprint=$fp $([ "$fp" = "$FP_AFTER" ] && echo MATCH || echo DIFFERS) $(counts 2>/dev/null || echo "counts unavailable")"
  echo "env: mode=$(stat -c %a "$ENV_FILE" 2>/dev/null || echo ?) size=$(stat -c %s "$ENV_FILE" 2>/dev/null || echo ?) sha256_prefix=$(sha256sum "$ENV_FILE" 2>/dev/null | cut -c1-16) (accepted $ENV_MODE / $ENV_SIZE / $ENV_SHA_PREFIX)"
  echo "objectdata: $(compose exec -T api sh -c 'stat -c "owner=%u:%g mode=%a" /data/objects; echo "entries=$(ls -A /data/objects | wc -l)"' 2>/dev/null | tr '\n' ' ' || echo unavailable)"
  echo "postgres volume: $(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}' "$PG_CID" 2>/dev/null || echo unavailable) (expected card-scanner-pro_pgdata)"
  echo "existing rows (excluding the disposable ids): $(q "select 'companies='||(select count(*) from companies where id not in ($C))||' users='||(select count(*) from users where id not in ($U) and (company_id is null or company_id not in ($C)))||' subscriptions='||(select count(*) from subscriptions where company_id not in ($C))||' contacts='||(select count(*) from contacts where company_id not in ($C))||' leads='||(select count(*) from leads where company_id not in ($C))||' events='||(select count(*) from events where company_id not in ($C))||' scans='||(select count(*) from scans where company_id not in ($C))||' documents='||(select count(*) from documents where company_id not in ($C))||' export_runs='||(select count(*) from export_runs where company_id not in ($C))||' storage_objects_other='||(select count(*) from storage_objects where company_id not in ($C))" 2>/dev/null || echo unavailable) (accepted companies=1 users=2 subscriptions=1 contacts=1 leads=1 events=1 scans=4 documents=0 export_runs=4 storage_objects_other=0)"
  echo "inventory totals: $(q "select 'storage_objects_total='||count(*)||' active='||count(*) filter (where state='active')||' deleting='||count(*) filter (where state='deleting')||' deleted='||count(*) filter (where state='deleted')||' uncertain='||count(*) filter (where publication_uncertain_at is not null)||' unproven='||count(*) filter (where last_error='OWNERSHIP_UNPROVEN')||' cleanup_pending='||count(*) filter (where last_error='CLEANUP_PENDING')||' legacy_retained='||count(*) filter (where last_error='LEGACY_RETAINED') from storage_objects" 2>/dev/null || echo unavailable)"

  section "8. capacity"
  echo "disk_avail_bytes=$(capacity "bytes available on /" -B1 --output=avail / 2>/dev/null || echo unavailable) inodes_free=$(capacity "inodes available on /" --output=iavail / 2>/dev/null || echo unavailable)"

  section "9. public edge (host-level reverse proxy outside the compose stack; read-only): what answers :443 and where Referrer-Policy is set"
  local nginx_bin="" dump="" dump_src="" conf_path="" prefix="" v h hr
  echo "-- listeners on :80 / :443 (addresses masked) and the owning process names (visible only with privilege):"
  echo "  ss: $(ss -ltnH '( sport = :443 or sport = :80 )' 2>/dev/null | awk '{ print $4 }' | sed -E 's/[0-9]{1,3}(\.[0-9]{1,3}){3}/<ip>/g; s/\[[0-9a-fA-F:]*\]/<ip6>/g' | sort -u | tr '\n' ' ' || echo unavailable) owners: $(ss -ltnpH '( sport = :443 )' 2>/dev/null | grep -oE 'users:\(\("[^"]+"' | sed -E 's/users:\(\("//' | sort -u | tr '\n' ' ' || true)"
  echo "  reverse-proxy / edge processes (user comm count): $(ps -eo user=,comm= 2>/dev/null | awk '$2 ~ /^(nginx|caddy|traefik|haproxy|apache2|httpd|openresty|litespeed|openlitespeed|lshttpd|cloudflared|varnish|envoy)$/ { c[$1 " " $2]++ } END { for (k in c) printf "%s=%d ", k, c[k] }' || echo unavailable)"
  echo "  containers publishing :80/:443 on the host: $(docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null | grep -E '(:80|:443)->' | sed -E 's/[0-9]{1,3}(\.[0-9]{1,3}){3}/<ip>/g' | tr '\n' ' ' || echo none)"
  echo "  systemd nginx: active=$({ systemctl is-active nginx 2>/dev/null || true; } | grep -m1 . || echo unknown) enabled=$({ systemctl is-enabled nginx 2>/dev/null || true; } | grep -m1 . || echo unknown) reload=$(systemctl show -p ExecReload --value nginx 2>/dev/null | sed -nE 's/.*argv\[\]=([^;]*);.*/\1/p' | head -1 | edge_san || true)"
  for v in nginx /usr/sbin/nginx /usr/local/nginx/sbin/nginx /usr/local/openresty/nginx/sbin/nginx; do
    if command -v "$v" >/dev/null 2>&1; then nginx_bin="$(command -v "$v")"; break; fi
  done
  if [ -z "$nginx_bin" ]; then echo "-- nginx binary: not found on PATH (the edge is not a host nginx reachable by this user)"; else
    echo "-- nginx binary: $nginx_bin version: $("$nginx_bin" -v 2>&1 | edge_san) modules: $("$nginx_bin" -V 2>&1 | grep -oE 'with-http_(ssl|v2|v3|realip|sub)_module|headers-more|ngx_http_headers_more|with-stream' | sort -u | tr '\n' ' ')"
    local master_args master_conf
    master_args="$(ps -eo comm=,args= 2>/dev/null | awk '$1 == "nginx" && $2 == "nginx:" && $3 == "master" { $1 = ""; $2 = ""; $3 = ""; $4 = ""; print; exit }' || true)"
    master_conf="$(printf '%s' "$master_args" | grep -oE -- '-c [^ ]+' | head -1 | cut -d' ' -f2 || true)"
    conf_path="$("$nginx_bin" -V 2>&1 | grep -oE -- '--conf-path=[^ ]+' | cut -d= -f2 || true)"; prefix="$("$nginx_bin" -V 2>&1 | grep -oE -- '--prefix=[^ ]+' | cut -d= -f2 || true)"
    conf_path="${master_conf:-${conf_path:-/etc/nginx/nginx.conf}}"
    # nginx resolves a relative `include` against the directory of the main configuration file (ngx_conf_full_name
    # with conf_prefix), not against the build prefix — a master started with an explicit -c moves that directory.
    prefix="$(dirname "$conf_path")"
    echo "   effective conf-path: $(printf '%s' "$conf_path" | edge_san) ($([ -n "$master_conf" ] && echo "from the running master's -c" || echo "compiled default")) prefix: $(printf '%s' "$prefix" | edge_san) master-process args: $(printf '%s' "$master_args" | edge_san)"
    echo "   conf-path readable by this user: $([ -r "$conf_path" ] && echo yes || echo no) ($(stat -c '%U:%G %a' "$conf_path" 2>/dev/null || echo 'stat unavailable')) running as: uid=$(id -u) groups=$(id -Gn 2>/dev/null | wc -w) sudo: $(command -v sudo >/dev/null 2>&1 && { sudo -n true 2>/dev/null && echo passwordless || echo 'not permitted non-interactively'; } || echo absent)"
    if dump="$("$nginx_bin" -T -c "$conf_path" 2>/dev/null)" && [ -n "$dump" ]; then dump_src="nginx -T (this user)"
    elif [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1 && dump="$(sudo -n "$nginx_bin" -T -c "$conf_path" 2>/dev/null)" && [ -n "$dump" ]; then dump_src="sudo -n nginx -T"
    else dump=""; fi
    if [ -n "$dump" ]; then echo "-- effective configuration: $dump_src ($(printf '%s\n' "$dump" | grep -c '^# configuration file ' || true) files; test: $("$nginx_bin" -t -c "$conf_path" 2>&1 | grep -oE 'syntax is ok|test is successful|test failed' | sort -u | tr '\n' ' ' || echo n/a))"
    else dump="$(edge_conf_collect "$conf_path" "$prefix")"; echo "-- effective configuration: nginx -T not available to this user — readable files of the tree under conf-path were read instead ($(printf '%s\n' "$dump" | grep -c '^# configuration file ' || true) files)"; fi
    printf '%s\n' "$dump" | edge_conf_summary "$prefix" | edge_san | sed 's/^/  /'
    echo "-- vhost file facts (owner:group mode, first comment lines; for files that mention the project domain):"
    printf '%s\n' "$dump" | sed -nE 's/^# configuration file (.*):$/\1/p' | while IFS= read -r v; do
      [ -r "$v" ] || continue; grep -qE "$EDGE_DOMAIN_RE" "$v" 2>/dev/null || continue
      echo "  $(printf '%s' "$v" | edge_san) $(stat -c '%U:%G %a %s bytes modified %y' "$v" 2>/dev/null | cut -c1-80 | edge_san) | $(grep -E '^[[:space:]]*#' "$v" | head -3 | tr -s ' ' | tr '\n' ' ' | cut -c1-160 | edge_san)"
    done
  fi
  echo "-- response headers through the LOCAL edge (TLS to 127.0.0.1 with the public host name; proves whether the host nginx is the layer that appends the header) and from the public name:"
  for h in $PUBLIC_HOSTS; do
    for v in /api/healthz /healthz /; do
      hr="$(edge_headers "https://$h$v" "$h:443:127.0.0.1")"; if [ "$hr" = "unavailable" ]; then hr="$(edge_headers "https://$h$v" "$h:443:$(hostname -I 2>/dev/null | awk '{ print $1 }')")"; [ "$hr" = "unavailable" ] || hr="(via primary interface) $hr"; fi
      echo "  local-edge $h$v -> $hr"
    done
    echo "  public     $h/api/healthz -> $(edge_headers "https://$h/api/healthz")"
  done
  echo "  web container (compose proxy) /api/healthz -> $(edge_headers "http://127.0.0.1:18080/api/healthz")"

  rm -f "$HOME"/.b25-s1-node.err
  log "diagnose complete (read-only; nothing changed)"
}

# ---------------------------------------------------------------------------
# residue_settle — RECOVERY of the single tombstone left behind by the disposable smoke of run
# 37930815158 (API crash mid-smoke; the always-cleanup removed every disposable row but stopped at its
# residue guard; the maintenance sweep then tombstoned the orphaned active row with its bucket object
# RETAINED — legacy deletion is off, so the product itself never removes that object and never purges
# the row). The recovery is INCIDENT-SPECIFIC: every identity below is a constant of this script and of
# the workflow; any other manifest is rejected before an SSH session is opened and again here.
#
# Phases:
#   residue-eligibility  READ-ONLY (q only; provider metadata/list only). Proves, in this order, that the
#                        host is the accepted coordination state and that the residue is exactly the
#                        recorded tombstone in one of the two recoverable states — before any mutation:
#                          STATE A  row present + the ONE marked object present at its persisted location
#                                   with marker == row id, canonical decimal generation, size == row size
#                          STATE B  row present + object absent at EVERY persisted location (a previous
#                                   run removed the object and stopped before the row)
#                          STATE C  row absent + no residue + census == accepted original inventory
#                                   (already completed: nothing to do)
#                        Anything else fails closed.
#   residue-settle       MUTATION, exactly two mutation points, each preceded by the full eligibility
#                        re-read in the same session:
#                          (1) provider delete of the ONE object, conditioned on the ownership marker AND
#                              the exact generation string read moments before (ifGenerationMatch; never
#                              unconditional) — then the object is proven absent at EVERY persisted
#                              location (storage_key, legacy_key, mirror_key, filesystem volume);
#                          (2) removal of the ONE row through the allow-listed, row-locked transaction
#                              (purge_rows_sql; count must equal 1).
#                        Partial progress: a failure before (1) changes nothing; a failure between (1)
#                        and (2) leaves the row in place (deleted / LEGACY_RETAINED, pointing to an
#                        absent object) — discoverable, and the next run resumes from STATE B; a failure
#                        after (2) is STATE C on the next run (nothing to do). The row is NEVER removed
#                        while any persisted location of the object still answers, and the object is
#                        NEVER deleted when any eligibility check fails.
#   residue-verify       READ-ONLY final verification (replaces the former always-step cleanup, which
#                        executed deletes): zero disposable rows, zero residue rows, census back to the
#                        accepted inventory, originals reconciled, every baseline unchanged, api healthy.
RESIDUE_UUID="8c91bc11-912a-42e7-abe1-37ddd95d3cc1"
RESIDUE_COMPANIES="47,48"; RESIDUE_COMPANY="47"; RESIDUE_USERS="88,89,90,91"; RESIDUE_TAG="8f07767767cc"
RESIDUE_MANIFEST="$RESIDUE_UUID|$RESIDUE_COMPANIES|$RESIDUE_USERS|$RESIDUE_TAG"
RESIDUE_KIND="document"
RESIDUE_CREATED_FROM="2026-10-09 12:34:00"; RESIDUE_CREATED_TO="2026-10-09 12:36:00"     # created during the smoke window
RESIDUE_BASELINE_INVENTORY_MD5="c1b900fd509bafa1f980d863dc0d195b"                       # accepted ORIGINAL inventory (4 / 1299)
RESIDUE_UUIDS_Q="'$RESIDUE_UUID'"
# Eligibility JS (read-only): the whole bucket inventory reduced to counts/digests (names never printed), the
# target object's metadata (marker / generation / size) and the legacy location's presence.
RESIDUE_ELIG_JS=$(cat <<'JS'
const { Storage } = require("@google-cloud/storage");
const { createHash } = require("node:crypto");
(async () => {
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  const a = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "{}");
  const storage = new Storage();
  const all = [], unmarked = []; let bytes = 0, marked = 0, markedIsTarget = 0, pageToken, capped = false;
  do {
    const [files, next] = await storage.bucket(bucket).getFiles({ maxResults: 1000, autoPaginate: false, pageToken });
    for (const f of files) {
      const gen = String(f.metadata.generation ?? ""); const line = `${f.name}|${gen}|${f.metadata.size}`;
      all.push(line); bytes += Number(f.metadata.size || 0);
      const mk = f.metadata.metadata && f.metadata.metadata["lcp-object-id"];
      if (mk) { marked += 1; if (f.name === a.k && mk === a.id) markedIsTarget += 1; } else unmarked.push(line);
    }
    pageToken = next && next.pageToken; if (all.length >= 20000) { capped = true; break; }
  } while (pageToken);
  all.sort(); unmarked.sort();
  const md5 = (l) => createHash("md5").update(l.join("\n")).digest("hex");
  // flat document (one level; the script's strict flat-JSON reader rejects nesting)
  const t = { target_present: false, target_marker_matches_row: null, target_generation_is_string: null, target_generation_canonical: null, target_generation_digits: 0, target_size_matches: null, target_updated: null };
  try {
    const [m] = await storage.bucket(bucket).file(a.k).getMetadata();
    const gen = m.generation; const gs = gen == null ? "" : String(gen);
    Object.assign(t, { target_present: true, target_marker_matches_row: !!(m.metadata && m.metadata["lcp-object-id"] === a.id), target_generation_is_string: typeof gen === "string", target_generation_canonical: /^[1-9]\d*$/.test(gs), target_generation_digits: gs.length, target_size_matches: String(m.size) === String(a.s), target_updated: String(m.updated || "") });
  } catch (e) { if (!(e && e.code === 404)) throw e; }
  const legacy = { legacy_same_object: null, legacy_present: null };
  const lm = /^gs:\/\/([^/]+)\/(.+)$/.exec(a.l || "");
  if (lm) {
    legacy.legacy_same_object = lm[1] === bucket && lm[2] === a.k;
    try { await storage.bucket(lm[1]).file(lm[2]).getMetadata(); legacy.legacy_present = true; } catch (e) { if (e && e.code === 404) legacy.legacy_present = false; else throw e; }
  }
  console.log(JSON.stringify({ objects: all.length, bytes, capped, with_marker: marked, marked_is_target: markedIsTarget, inventory_md5: md5(all), unmarked_md5: md5(unmarked), unmarked_objects: unmarked.length, ...t, ...legacy }));
})().catch((e) => console.log(JSON.stringify({ eligibility: "error", code: e.code || e.name || "unknown" })));
JS
)
# Settle JS (the ONLY provider mutation of the recovery): re-read metadata, apply the provider rules
# (marker == row id, canonical decimal generation string), delete at exactly that generation, re-read.
RESIDUE_DELETE_JS=$(cat <<'JS'
const { Storage } = require("@google-cloud/storage");
(async () => {
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  const a = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "{}");
  const storage = new Storage();
  const f = storage.bucket(bucket).file(a.k);
  let m;
  try { [m] = await f.getMetadata(); } catch (e) { if (e && e.code === 404) { console.log(JSON.stringify({ deleted: 0, absent_before: 1, absent_after: 1 })); return; } throw e; }
  const d = B25_RULES.shouldDeleteObject(a.id, m);
  if (!d.ok) { console.log(JSON.stringify({ deleted: 0, refused: 1, reason: d.reason })); return; }
  if (String(m.size) !== String(a.s)) { console.log(JSON.stringify({ deleted: 0, refused: 1, reason: "size differs from the row" })); return; }
  await f.delete({ ifGenerationMatch: d.generation });   // exact decimal string; never a number, never unconditional
  let absent = 0;
  try { await f.getMetadata(); } catch (e) { if (e && e.code === 404) absent = 1; else throw e; }
  console.log(JSON.stringify({ deleted: 1, absent_before: 0, absent_after: absent, generation_digits: d.generation.length }));
})().catch((e) => console.log(JSON.stringify({ error: e.code || e.name || "unknown" })));
JS
)
RESIDUE_ABSENT_JS=$(cat <<'JS'
const { Storage } = require("@google-cloud/storage");
(async () => {
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  const rows = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "[]");
  const storage = new Storage();
  const name = (gs) => { if (!gs) return null; const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(gs); return m ? { bucket: m[1], object: m[2] } : null; };
  const exists = async (b, o) => { try { await storage.bucket(b).file(o).getMetadata(); return true; } catch (e) { if (e && e.code === 404) return false; throw e; } };
  const out = [];
  for (const r of rows) {
    const l = name(r.l), m = name(r.m);
    const presence = { storage: await exists(bucket, r.k), legacy: l ? await exists(l.bucket, l.object) : null, mirror: m ? await exists(m.bucket, m.object) : null };
    out.push({ id: r.id, absent: B25_RULES.rowAbsent(presence) });
  }
  console.log(JSON.stringify({ checked: rows.length, absent: out.filter((o) => o.absent).length, present_ids: out.filter((o) => !o.absent).map((o) => o.id) }));
})().catch((e) => console.log(JSON.stringify({ error: e.code || e.name || "unknown" })));
JS
)
residue_manifest_check() {
  [ "$1" = "$RESIDUE_MANIFEST" ] || fail "manifest differs from the recorded incident residue — refused (nothing read, nothing changed)"
}
# json_bool <flat json> <key> → prints true/false; fails on anything else (strict flat reader; null is a failure)
json_bool() {
  local json="$1" key="$2" raw
  raw="$(json_flat_field "$json" "$key")" || return 1
  case "$raw" in true|false) printf '%s' "$raw";; *) return 1;; esac
}
RESIDUE_STATE=""   # A | B | C, set by residue_eligibility
RESIDUE_SIZE=""
# The complete eligibility proof. Read-only by construction (q, docker inspect/logs, provider list/HEAD).
residue_eligibility() {
  local manifest="$1" n=0
  residue_manifest_check "$manifest"
  local pass; pass() { n=$((n + 1)); echo "elig $n: $1 — OK"; }
  section "eligibility — coordination state of the host (accepted B25 product, healthy, idle, baselines intact)"
  [ "$(git -C "$APP_DIR" rev-parse HEAD)" = "$ACCEPTED_SHA" ] || fail "host checkout is not the accepted commit"
  [ "$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null)" = "$ACCEPTED_SHA" ] || fail "current-deploy.sha is not the accepted commit"
  [ "$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null)" = "$EXPECTED_HOSTED_SHA" ] || fail "previous-deploy.sha is not the pre-B25 commit"
  [ -z "$(git -C "$APP_DIR" status --porcelain 2>/dev/null)" ] || fail "host checkout is dirty"
  pass "checkout HEAD / current-deploy = accepted commit, previous-deploy = pre-B25 commit, clean"
  [ ! -e "$LOCK_FILE" ] || fail "an activation lock file exists ($LOCK_FILE)"
  [ -z "$(docker ps -a --filter "name=card-scanner-pro-api" --format '{{.Names}}' | grep -v '^card-scanner-pro-api-1$' || true)" ] || fail "an unexpected api container exists"
  for svc in api web postgres; do [ "$(compose ps --status running -q "$svc" | wc -l)" = "1" ] || fail "$svc is not running"; done
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$API_CID")" = "healthy" ] || fail "api is not healthy"
  echo "  api: $(docker inspect -f 'started={{.State.StartedAt}} restarts={{.RestartCount}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' "$API_CID")"
  local rz; rz="$(curl -sS --max-time 5 http://127.0.0.1:18080/api/readyz 2>/dev/null || echo "")"
  [[ "$rz" == *'"status":"ok"'* ]] && [[ "$rz" == *'"database":"ok"'* ]] && [[ "$rz" == *'"storage":"ok"'* ]] || fail "readiness is not ok/ok/ok"
  pass "no lock, one api container, api/web/postgres running, api healthy, readyz ok"
  echo "  storage init: $(docker logs "$API_CID" 2>&1 | grep -oE '"driver":"[a-z]+","legacyFallback":(true|false),"mirror":(true|false),"legacyDelete":(true|false)' | awk 'NR == 1 { print }')"
  docker logs "$API_CID" 2>&1 | grep -F '"driver":"gcs","legacyFallback":false,"mirror":false,"legacyDelete":false' >/dev/null || fail "storage initialization is not driver=gcs / fallback off / mirror off / legacy delete off"
  pass "storage initialization = gcs primary, no fallback, no mirror, legacy delete OFF (the product never deletes bucket objects)"
  [ "$(compose exec -T api sh -c 'ls -A /data/objects | wc -l')" = "0" ] || fail "objectdata is not empty"
  local fp; fp="$(fingerprint)"; [ "$fp" = "$FP_AFTER" ] || fail "schema fingerprint differs from the accepted post-apply fingerprint"
  [ "$(counts)" = "$COUNTS_AFTER" ] || fail "schema object counts differ"
  local tb; tb="$(tenant_md5)" || fail "tenant baseline unreadable"; [ "$tb" = "$TENANT_BASELINE_MD5" ] || fail "existing-tenant composition differs from the accepted baseline"
  [ "$(q "select count(*) from scans where company_id=1")" = "4" ] && [ "$(scan_rows_md5)" = "8a3e378a2acd0d880c6f45613b32473d" ] || fail "owner scan rows differ from the accepted baseline"
  [ "$(stat -c %a "$ENV_FILE")" = "$ENV_MODE" ] && [ "$(stat -c %s "$ENV_FILE")" = "$ENV_SIZE" ] && [ "$(sha256sum "$ENV_FILE" | cut -c1-16)" = "$ENV_SHA_PREFIX" ] || fail "environment file differs from the accepted baseline"
  pass "objectdata empty; schema fingerprint/counts, tenant composition, owner scans and environment file = accepted baselines"
  if q "create temp table b25_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard FAILED (a write succeeded in a q session)"; fi
  pass "read-only session guard"

  section "eligibility — the residue (exactly the recorded identities; nothing else may remain)"
  local C="$RESIDUE_COMPANIES" U="$RESIDUE_USERS" DOM="$SMOKE_DOMAIN" TAG="$RESIDUE_TAG" UUID="$RESIDUE_UUID"
  [ "$(q "select count(*) from companies where id in ($C) or name like 'B25 SMOKE %'")" = "0" ] || fail "a disposable company still exists"
  [ "$(q "select count(*) from users where id in ($U) or email like '%@$DOM'")" = "0" ] || fail "a disposable user still exists"
  [ "$(q "select (select count(*) from subscriptions where company_id in ($C)) + (select count(*) from sessions where user_id in ($U)) + (select count(*) from documents where company_id in ($C)) + (select count(*) from document_versions where company_id in ($C)) + (select count(*) from export_runs where company_id in ($C)) + (select count(*) from executive_reports where company_id in ($C)) + (select count(*) from scans where company_id in ($C)) + (select count(*) from contacts where company_id in ($C)) + (select count(*) from leads where company_id in ($C)) + (select count(*) from audit_logs where company_id in ($C) or user_id in ($U)) + (select count(*) from activity_logs where company_id in ($C) or user_id in ($U)) + (select count(*) from login_attempts where email like 'b25-smoke-${TAG}%@$DOM')")" = "0" ] || fail "a disposable feature row still exists"
  pass "companies $C, users $U and every disposable feature/audit/session row are absent"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and id <> '$UUID'")" = "0" ] || fail "another storage row of the disposable companies exists — not the recorded residue"
  [ "$(q "select count(*) from storage_objects where id <> '$UUID' and (reference like '%$UUID%' or storage_key like '%$UUID%' or coalesce(legacy_key,'') like '%$UUID%' or coalesce(mirror_key,'') like '%$UUID%')")" = "0" ] || fail "another storage row references the residue id"
  [ "$(q "select (select count(*) from document_versions where object_path = '/objects/$UUID') + (select count(*) from export_runs where object_path = '/objects/$UUID') + (select count(*) from executive_reports where object_path = '/objects/$UUID') + (select count(*) from scans where image_url = '/objects/$UUID') + (select count(*) from companies where brand_logo_key = '/objects/$UUID')")" = "0" ] || fail "a live feature row still references the residue object"
  [ "$(q "select count(*) from job_queue where status in ('pending','running') and (payload::text like '%$UUID%' or payload::text like '%\"companyId\":47%' or payload::text like '%\"companyId\":48%')")" = "0" ] || fail "a pending/running job still references the residue"
  pass "no other storage row, no live association, no pending job references the residue"
  local nrow; nrow="$(q "select count(*) from storage_objects where id = '$UUID'")"
  local cj o b im wm
  if [ "$nrow" = "0" ]; then
    section "eligibility — STATE C candidate (row absent): the inventory must already be the accepted original"
    cj="$(census)"; echo "  $cj"
    o="$(census_field "$cj" objects count)" || fail "census: objects missing"; b="$(census_field "$cj" bytes count)" || fail "census: bytes missing"
    im="$(census_field "$cj" inventory_md5 hex32)" || fail "census: digest missing"; wm="$(census_field "$cj" with_marker count)" || fail "census: with_marker missing"
    [ "$o" = "$CENSUS_OBJECTS" ] && [ "$b" = "$CENSUS_BYTES" ] && [ "$im" = "$RESIDUE_BASELINE_INVENTORY_MD5" ] && [ "$wm" = "0" ] || fail "row absent but the inventory is not the accepted original — manual review"
    [ "$(q "select count(*) from storage_objects")" = "0" ] || fail "row absent but other storage rows exist (pre-smoke baseline is 0 rows)"
    RESIDUE_STATE="C"; pass "STATE C — recovery already completed (row absent, inventory = accepted original, no marked object)"; echo "ELIGIBILITY: STATE C (nothing to do)"; return 0
  fi
  [ "$nrow" = "1" ] || fail "unexpected row count for the residue id: $nrow"
  section "eligibility — row identity (every column of the recorded tombstone)"
  local facts
  # every predicate is coalesced to false: a NULL column can never blank the whole line (and is itself a failure)
  facts="$(q "select coalesce(company_id = $RESIDUE_COMPANY, false)||'|'||coalesce(kind = '$RESIDUE_KIND', false)||'|'||coalesce(driver = 'gcs', false)||'|'||coalesce(state = 'deleted', false)||'|'||coalesce(last_error = 'LEGACY_RETAINED', false)||'|'||(publication_uncertain_at is null)||'|'||(lease_token is null and lease_expires_at is null)||'|'||(mirror_key is null and mirror_state is null)||'|'||(deleted_at is not null)||'|'||(legacy_key is not null)||'|'||coalesce(size_bytes > 0, false)||'|'||coalesce(sha256 ~ '^[0-9a-f]{64}$', false)||'|'||coalesce(reference = '/objects/' || id::text, false)||'|'||coalesce(storage_key ~ ('^tenants/' || company_id || '/documents/' || id::text || '(\\.[a-z0-9]+)?\$'), false)||'|'||coalesce(created_at >= '$RESIDUE_CREATED_FROM' and created_at < '$RESIDUE_CREATED_TO', false)||'|'||(reconciled_at is not null)||'|'||coalesce(content_type <> '', false) from storage_objects where id = '$UUID'")"
  echo "  facts(company|kind|driver|deleted|legacy_retained|not_uncertain|no_lease|no_mirror|deleted_at|legacy_key|size|sha|reference|storage_key|created_in_window|reconciled|content_type)=$facts"
  local names=(company kind driver state last_error uncertainty lease mirror deleted_at legacy_key size sha256 reference storage_key created_at reconciled content_type) i=0 v
  IFS='|' read -ra v <<<"$facts"; [ "${#v[@]}" = "17" ] || fail "row facts unreadable"
  for i in 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 16; do [ "${v[$i]}" = "true" ] || fail "row identity check failed: ${names[$i]}"; done
  echo "  reconciled_at set: ${v[15]} (either is eligible: the sweep's final reconciliation keeps LEGACY_RETAINED and never purges)"
  q "select 'row '||id||' company='||company_id||' kind='||kind||' state='||state||' last_error='||last_error||' size='||size_bytes||' deleted_at='||deleted_at||' reconciled_at='||coalesce(reconciled_at::text,'<null>')||' created='||created_at from storage_objects where id = '$UUID'" | sed 's/^/  /'
  local bucket; bucket="$(grep -E '^DEFAULT_OBJECT_STORAGE_BUCKET_ID=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"')"
  [[ "$bucket" =~ ^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$ ]] || fail "bucket name unreadable or malformed in the environment file"
  [ "$(q "select (legacy_key = 'gs://$bucket/' || storage_key)::text from storage_objects where id = '$UUID'")" = "true" ] || fail "legacy_key is not the canonical location of storage_key in the configured bucket"
  RESIDUE_SIZE="$(q "select size_bytes from storage_objects where id = '$UUID'")"
  pass "row = the recorded tombstone (company $RESIDUE_COMPANY, $RESIDUE_KIND, gcs, deleted, LEGACY_RETAINED, no uncertainty/lease/mirror, reference and storage_key identity, legacy_key canonical, created in the smoke window)"

  section "eligibility — provider state (ownership marker, generation string, size; the four original objects untouched)"
  local row_b64 ej
  row_b64="$(q "select json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 's', size_bytes) from storage_objects where id = '$UUID'" | base64 -w0)"
  ej="$(api_node "$RESIDUE_ELIG_JS" "$row_b64")"; echo "  $ej"
  local eo eb ewm emt eum euo tp lsame lpres
  eo="$(census_field "$ej" objects count)" || fail "eligibility: objects missing"; eb="$(census_field "$ej" bytes count)" || fail "eligibility: bytes missing"
  ewm="$(census_field "$ej" with_marker count)" || fail "eligibility: with_marker missing"; emt="$(census_field "$ej" marked_is_target count)" || fail "eligibility: marked_is_target missing"
  eum="$(census_field "$ej" unmarked_md5 hex32)" || fail "eligibility: unmarked digest missing"; euo="$(census_field "$ej" unmarked_objects count)" || fail "eligibility: unmarked count missing"
  tp="$(json_bool "$ej" target_present)" || fail "eligibility: target presence unreadable"
  [ "$euo" = "$CENSUS_OBJECTS" ] && [ "$eum" = "$RESIDUE_BASELINE_INVENTORY_MD5" ] || fail "the unmarked objects are not exactly the accepted original inventory (names/generations/sizes drifted) — STOP"
  local rj; rj="$(api_node "$DIAG_RECON_JS" "$(q "select coalesce(json_agg(json_build_object('r', object_path, 's', file_size)), '[]'::json) from export_runs where object_path ~ '$LEGACY_HANDLE'" | base64 -w0)")"; echo "  original references: $rj"
  [ "$(census_field "$rj" referenced count)" = "$REFERENCES" ] && [ "$(census_field "$rj" present count)" = "$REFERENCES" ] && [ "$(census_field "$rj" missing count)" = "0" ] && [ "$(census_field "$rj" size_match count)" = "$REFERENCES" ] || fail "original references are not fully present / size-matched — STOP"
  pass "the $CENSUS_OBJECTS original objects = accepted inventory digest; $REFERENCES references present and size-matched"
  if [ "$tp" = "true" ]; then
    [ "$eo" = "$((CENSUS_OBJECTS + 1))" ] && [ "$eb" = "$((CENSUS_BYTES + RESIDUE_SIZE))" ] && [ "$ewm" = "1" ] && [ "$emt" = "1" ] || fail "census is not exactly originals + the one marked target object (objects=$eo bytes=$eb marked=$ewm marked_is_target=$emt)"
    [ "$(json_bool "$ej" target_marker_matches_row)" = "true" ] || fail "the object at storage_key does not carry this row's ownership marker — STOP"
    [ "$(json_bool "$ej" target_generation_is_string)" = "true" ] && [ "$(json_bool "$ej" target_generation_canonical)" = "true" ] || fail "the object's generation is not a canonical decimal string — STOP"
    [ "$(json_bool "$ej" target_size_matches)" = "true" ] || fail "the object's size differs from the row — STOP"
    lsame="$(json_bool "$ej" legacy_same_object)" || fail "legacy location unreadable"; [ "$lsame" = "true" ] || fail "legacy_key is not the same object as storage_key — STOP"
    RESIDUE_STATE="A"; pass "STATE A — the one marked object is present at its persisted location with marker == row id, canonical generation ($(census_field "$ej" target_generation_digits count) digits), size == row"
    echo "ELIGIBILITY: STATE A (full recovery: provider delete at the exact generation, absence proof, row removal)"
  else
    [ "$eo" = "$CENSUS_OBJECTS" ] && [ "$eb" = "$CENSUS_BYTES" ] && [ "$ewm" = "0" ] || fail "object absent at storage_key but the census is not the accepted original (objects=$eo bytes=$eb marked=$ewm) — STOP"
    lpres="$(json_bool "$ej" legacy_present)" || fail "legacy location unreadable"; [ "$lpres" = "false" ] || fail "object absent at storage_key but present at legacy_key — STOP"
    RESIDUE_STATE="B"; pass "STATE B — object absent at every persisted location, row still present (a previous run stopped before the row removal)"
    echo "ELIGIBILITY: STATE B (resume: absence proof, row removal)"
  fi
}
phase_residue_eligibility() {
  residue_eligibility "$ARG1"
  rm -f "$HOME"/.b25-s1-node.err
  log "residue-eligibility complete (read-only; nothing changed; state=$RESIDUE_STATE)"
}
phase_residue_settle() {
  declare -f purge_rows_sql >/dev/null || fail "purge library not loaded (stream b25-stage1-purge-lib.sh before this script)"
  residue_manifest_check "$ARG1"
  exec 9>"$LOCK_FILE"; flock -n 9 || fail "another activation holds the lock"
  # The lock path is expanded NOW: the eligibility re-read below temporarily points LOCK_FILE at a '.none' path, and a
  # trap that read the variable at exit time would remove the wrong path when eligibility fails — leaving the real
  # lock on the host and refusing every later eligibility run until someone removes it by hand.
  trap "rm -f '$LOCK_FILE' \"\$HOME\"/.b25-s1-node.err" EXIT
  # the lock file now exists; the eligibility check tolerates OUR lock (the fd is held by this session)
  local lock_was="$LOCK_FILE"; LOCK_FILE="$LOCK_FILE.none"; residue_eligibility "$ARG1"; LOCK_FILE="$lock_was"
  local UUID="$RESIDUE_UUID" C="$RESIDUE_COMPANIES"
  if [ "$RESIDUE_STATE" = "C" ]; then section "settle — nothing to do (STATE C)"; echo "RESIDUE_SETTLE: already completed; no provider call, no SQL write"; log "residue-settle: nothing to do"; return 0; fi
  if [ "$RESIDUE_STATE" = "A" ]; then
    section "settle (1/2) — delete the ONE marked object at its exact generation (marker re-read in the same call; names never printed)"
    local row_b64 dj
    row_b64="$(q "select json_build_object('id', id, 'k', storage_key, 's', size_bytes) from storage_objects where id = '$UUID'" | base64 -w0)"
    dj="$(api_node "$PROVIDER_RULES_JS"$'\n'"$RESIDUE_DELETE_JS" "$row_b64")"; echo "  $dj"
    [ "$(census_field "$dj" deleted count 2>/dev/null || echo x)" = "1" ] || fail "the provider delete did not happen (refused or failed) — the object and the row stay; investigate"
    [ "$(census_field "$dj" absent_after count 2>/dev/null || echo x)" = "1" ] || fail "the object still answers after the conditional delete — the row stays; investigate"
    echo "  provider delete: done at the exact generation ($(census_field "$dj" generation_digits count 2>/dev/null || echo ?) digits)"
  else
    section "settle (1/2) — STATE B: the object was already removed by a previous run; no provider mutation"
  fi
  section "settle — absence proof at EVERY persisted location (storage_key, legacy_key, mirror_key; filesystem volume)"
  local loc_b64 aj
  loc_b64="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 'm', mirror_key)), '[]'::json) from storage_objects where id = '$UUID'" | base64 -w0)"
  aj="$(api_node "$PROVIDER_RULES_JS"$'\n'"$RESIDUE_ABSENT_JS" "$loc_b64")"; echo "  $aj"
  [ "$(census_field "$aj" checked count 2>/dev/null || echo x)" = "1" ] && [ "$(census_field "$aj" absent count 2>/dev/null || echo x)" = "1" ] || fail "a persisted provider location of the tombstone still answers — the row is NOT removed (resume from STATE B once it is absent)"
  [ "$(compose exec -T api sh -c 'ls -A /data/objects | wc -l')" = "0" ] || fail "objectdata is not empty — the row is NOT removed"
  section "settle (2/2) — remove the ONE row (allow-listed, row-locked transaction; count must be exactly 1)"
  local triple; triple="$(qw "$(purge_rows_sql "$RESIDUE_UUIDS_Q" "$C" 1)")"
  purge_result_check "$triple" 1 || fail "the allow-listed delete did not remove exactly the one row (nothing is removed when the row differs)"
  [ "$(q "select count(*) from storage_objects where id = '$UUID'")" = "0" ] || fail "the row remains"
  section "settle — final state"
  local cj o b im wm; cj="$(census)"; echo "  $cj"
  o="$(census_field "$cj" objects count)" || fail "census: objects missing"; b="$(census_field "$cj" bytes count)" || fail "census: bytes missing"
  im="$(census_field "$cj" inventory_md5 hex32)" || fail "census: digest missing"; wm="$(census_field "$cj" with_marker count)" || fail "census: with_marker missing"
  [ "$o" = "$CENSUS_OBJECTS" ] && [ "$b" = "$CENSUS_BYTES" ] && [ "$im" = "$RESIDUE_BASELINE_INVENTORY_MD5" ] && [ "$wm" = "0" ] || fail "census is not the accepted original inventory after the recovery — investigate (no further change is made)"
  [ "$(q "select count(*) from storage_objects")" = "0" ] || fail "storage_objects is not back to the pre-smoke baseline (0 rows)"
  echo "RESIDUE_SETTLE: COMPLETE — census $o / $b / $im, marked objects $wm, storage rows 0"
  log "residue-settle complete"
}
# READ-ONLY final verification (always-step): reports and FAILS on any deviation from the accepted end state; never writes.
phase_residue_verify() {
  residue_manifest_check "$ARG1"
  local C="$RESIDUE_COMPANIES" U="$RESIDUE_USERS" DOM="$SMOKE_DOMAIN" TAG="$RESIDUE_TAG" UUID="$RESIDUE_UUID" bad=0
  chk() { if [ "$2" = "$3" ]; then echo "verify: $1 = $2 OK"; else echo "verify: $1 = $2 (expected $3) FAILED"; bad=$((bad + 1)); fi; }
  section "residue-verify (read-only)"
  if q "create temp table b25_should_fail (x int)" >/dev/null 2>&1; then echo "verify: read-only guard FAILED"; bad=$((bad + 1)); else echo "verify: read-only session guard OK"; fi
  chk "residue rows" "$(q "select count(*) from storage_objects where id = '$UUID' or company_id in ($C)")" "0"
  chk "rows mentioning the residue id" "$(q "select count(*) from storage_objects where reference like '%$UUID%' or storage_key like '%$UUID%' or coalesce(legacy_key,'') like '%$UUID%' or coalesce(mirror_key,'') like '%$UUID%'")" "0"
  chk "storage_objects total" "$(q "select count(*) from storage_objects")" "0"
  chk "disposable companies" "$(q "select count(*) from companies where id in ($C) or name like 'B25 SMOKE %'")" "0"
  chk "disposable users" "$(q "select count(*) from users where id in ($U) or email like '%@$DOM'")" "0"
  chk "disposable feature/session/audit rows" "$(q "select (select count(*) from subscriptions where company_id in ($C)) + (select count(*) from sessions where user_id in ($U)) + (select count(*) from documents where company_id in ($C)) + (select count(*) from document_versions where company_id in ($C)) + (select count(*) from export_runs where company_id in ($C)) + (select count(*) from scans where company_id in ($C)) + (select count(*) from audit_logs where company_id in ($C) or user_id in ($U)) + (select count(*) from activity_logs where company_id in ($C) or user_id in ($U)) + (select count(*) from login_attempts where email like 'b25-smoke-${TAG}%@$DOM')")" "0"
  local cj; cj="$(census)"; echo "  $cj"
  chk "census objects" "$(census_field "$cj" objects count 2>/dev/null || echo ?)" "$CENSUS_OBJECTS"
  chk "census bytes" "$(census_field "$cj" bytes count 2>/dev/null || echo ?)" "$CENSUS_BYTES"
  chk "census inventory digest" "$(census_field "$cj" inventory_md5 hex32 2>/dev/null || echo ?)" "$RESIDUE_BASELINE_INVENTORY_MD5"
  chk "marked objects" "$(census_field "$cj" with_marker count 2>/dev/null || echo ?)" "0"
  local rj; rj="$(api_node "$DIAG_RECON_JS" "$(q "select coalesce(json_agg(json_build_object('r', object_path, 's', file_size)), '[]'::json) from export_runs where object_path ~ '$LEGACY_HANDLE'" | base64 -w0)")"; echo "  original references: $rj"
  chk "original references present" "$(census_field "$rj" present count 2>/dev/null || echo ?)" "$REFERENCES"
  chk "original references size-matched" "$(census_field "$rj" size_match count 2>/dev/null || echo ?)" "$REFERENCES"
  chk "tenant composition" "$(tenant_md5 2>/dev/null || echo unavailable)" "$TENANT_BASELINE_MD5"
  chk "owner scan rows" "$(scan_rows_md5 2>/dev/null || echo unavailable)" "8a3e378a2acd0d880c6f45613b32473d"
  chk "schema fingerprint" "$(fingerprint 2>/dev/null || echo unavailable)" "$FP_AFTER"
  chk "env file" "$(stat -c %a "$ENV_FILE" 2>/dev/null)/$(stat -c %s "$ENV_FILE" 2>/dev/null)/$(sha256sum "$ENV_FILE" 2>/dev/null | cut -c1-16)" "$ENV_MODE/$ENV_SIZE/$ENV_SHA_PREFIX"
  chk "objectdata entries" "$(compose exec -T api sh -c 'ls -A /data/objects | wc -l' 2>/dev/null | tr -d '[:space:]')" "0"
  chk "existing rows" "$(q "select 'companies='||(select count(*) from companies)||' users='||(select count(*) from users)||' subscriptions='||(select count(*) from subscriptions)||' contacts='||(select count(*) from contacts)||' leads='||(select count(*) from leads)||' events='||(select count(*) from events)||' scans='||(select count(*) from scans)||' documents='||(select count(*) from documents)||' export_runs='||(select count(*) from export_runs)")" "companies=1 users=2 subscriptions=1 contacts=1 leads=1 events=1 scans=4 documents=0 export_runs=4"
  chk "readyz" "$(curl -sS --max-time 5 http://127.0.0.1:18080/api/readyz 2>/dev/null | cut -c1-80)" '{"status":"ok","checks":{"database":"ok","storage":"ok"}}'
  echo "  api: $(docker inspect -f 'status={{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}} started={{.State.StartedAt}}' "$API_CID" 2>/dev/null || echo unavailable)"
  chk "dead jobs" "$(q "select count(*) from job_queue where status='dead'")" "0"
  rm -f "$HOME"/.b25-s1-node.err
  [ "$bad" = "0" ] || fail "residue-verify: $bad check(s) failed (read-only; nothing changed)"
  echo "RESIDUE_VERIFY: PASS (read-only)"
  log "residue-verify complete"
}

# ---------------------------------------------------------------------------
# residue_inspect_4fff751a3395 / residue_settle_4fff751a3395 — RECOVERY of the THREE tombstones left behind by the
# disposable smoke of run 38005492289 (postdeploy_verify on the Correction 9 product commit 72a2437: the smoke
# itself passed 55/55; the VPS-side leak gate then failed on its shared-prefix search, so the api recreation,
# re-read, settle and metrics steps never ran; the always-cleanup deleted the disposable tenants through the API,
# removed every remaining disposable principal / feature row and stopped at its residue guard). Recorded facts
# (smoke-verify and cleanup output of that run):
#   company 49 (disposable tenant a; company 50 held no storage row), rows created during the smoke:
#     e3f7f5fd-bbbe-4d7c-9111-4dfe6bef2daf  document       deleted  LEGACY_RETAINED  (tombstoned by the API company deletion, 23:40:52Z)
#     f45d91c9-2e2c-4c38-a97c-b3f95aa507e3  branding_logo  deleted  LEGACY_RETAINED  (replaced logo, 23:40:43Z)
#     665f114f-e100-4301-95e0-ad6a18eeae03  branding_logo  deleted  LEGACY_RETAINED  (removed logo, 23:40:43Z)
#   all gcs, legacy_key set, no mirror, no lease, no uncertainty. The three provider objects were PRESENT with
#   marker == row id, 16-digit decimal generation and matching size at smoke-verify time (BEFORE the cleanup) and
#   have not been measured since: the eligibility proof below establishes the CURRENT per-row state (A / B / C) and
#   never assumes a count of objects. Disposable principals: companies 49 and 50; the recorded owner user 92; the
#   three tenant users were deleted by the API together with their companies and their ids were never recorded —
#   they are checked by address pattern (%@b25smoke.invalid) only, never guessed.
# The recovery is INCIDENT-SPECIFIC: every identity is a constant of this script and of the workflow; any other
# manifest is refused before an SSH session is opened and again here. The first recovery's tooling
# (residue-eligibility / residue-settle / residue-verify, manifest 8c91bc11…) is retained unchanged above.
#
# Per-row states (fixed order: document, logo f45d91c9…, logo 665f114f…):
#   A  row present + the marked object present at its persisted location (marker == row id, canonical decimal
#      generation string, size == row size, legacy_key = the same object)
#   B  row present + object absent at EVERY persisted location (a previous run removed the object and stopped
#      before the row)
#   C  row absent (already removed)
# Whole-incident STATE C = every row absent, no marked object, census == accepted original inventory (4 / 1299).
# Key shapes (product-authoritative): document  reference /objects/<id>, storage_key tenants/<cid>/documents/<id>;
#   branding_logo  reference branding/<cid>/<id without dashes>.<ext>, storage_key tenants/<cid>/branding/<id without
#   dashes>.<png|jpg|webp> (storage.service.ts storeBuffer removes the dashes for logos) — the first read-only
#   inspection (run 38033721313) failed closed on a dashed-id predicate; the shared rule in purge-lib is now used.
#
#   residue2-eligibility  READ-ONLY (q only; provider list / metadata only): host coordination state, baselines,
#                         disposable principals absent, no other row / live association / pending job / in-flight
#                         writer, per-row identity (kind-specific reference and key shapes, creation and deletion
#                         windows), per-row provider state; prints the per-row states; changes nothing.
#   residue2-settle       MUTATION, row by row in the fixed order, after the full eligibility re-read in the same
#                         session: [A] provider delete conditioned on the marker AND the exact generation string
#                         read moments before (ifGenerationMatch; never unconditional) → absence proof at EVERY
#                         persisted location (storage_key, legacy_key, mirror_key, filesystem volume) → allow-listed,
#                         row-locked removal of THAT row (purge_rows_sql; count must equal 1). A failure anywhere
#                         stops the phase: rows already handled are gone (each only after its own object was proven
#                         absent), the current row keeps the state it reached (A or B), later rows are untouched;
#                         the next run resumes from the per-row states. A row is NEVER removed while any persisted
#                         location of its object still answers; an object is NEVER deleted when any check fails.
#   residue2-verify       READ-ONLY final verification (always): zero residue rows, zero disposable rows, census =
#                         accepted inventory, originals reconciled, every baseline unchanged, api healthy.
R2_UUID_DOC="e3f7f5fd-bbbe-4d7c-9111-4dfe6bef2daf"
R2_UUID_LOGO1="f45d91c9-2e2c-4c38-a97c-b3f95aa507e3"
R2_UUID_LOGO2="665f114f-e100-4301-95e0-ad6a18eeae03"
R2_UUIDS=("$R2_UUID_DOC" "$R2_UUID_LOGO1" "$R2_UUID_LOGO2")
R2_COMPANIES="49,50"; R2_COMPANY="49"; R2_KNOWN_USERS="92"; R2_TAG="4fff751a3395"
R2_MANIFEST="$R2_UUID_DOC,$R2_UUID_LOGO1,$R2_UUID_LOGO2|$R2_COMPANIES|$R2_KNOWN_USERS|$R2_TAG"
R2_UUIDS_Q="'$R2_UUID_DOC','$R2_UUID_LOGO1','$R2_UUID_LOGO2'"
R2_CREATED_FROM="2026-10-09 23:40:00"; R2_CREATED_TO="2026-10-09 23:41:00"   # created during the smoke (postdeploy-verify stamped 23:40:16Z)
R2_DELETED_FROM="2026-10-09 23:40:40"; R2_DELETED_TO="2026-10-09 23:41:00"   # tombstoned 23:40:43Z (logos) / 23:40:52Z (document)
R2_BASELINE_INVENTORY_MD5="c1b900fd509bafa1f980d863dc0d195b"                 # accepted ORIGINAL inventory (4 / 1299)
r2_kind() { case "$1" in "$R2_UUID_DOC") echo document;; "$R2_UUID_LOGO1"|"$R2_UUID_LOGO2") echo branding_logo;; *) return 1;; esac; }
r2_manifest_check() { [ "$1" = "$R2_MANIFEST" ] || fail "manifest differs from the recorded second-incident residue — refused (nothing read, nothing changed)"; }
declare -A R2_STATE=()   # uuid → A | B | C, set by residue2_eligibility
R2_PRESENT=0
# The complete eligibility proof. Read-only by construction (q, docker inspect/logs, provider list/HEAD).
residue2_eligibility() {
  local manifest="$1" n=0
  r2_manifest_check "$manifest"
  declare -f logo_key_rule_sql >/dev/null || fail "purge library not loaded (stream b25-stage1-purge-lib.sh before this script)"
  local pass; pass() { n=$((n + 1)); echo "elig $n: $1 — OK"; }
  section "eligibility — coordination state of the host (accepted B25 product, healthy, idle, baselines intact)"
  [ "$(git -C "$APP_DIR" rev-parse HEAD)" = "$ACCEPTED_SHA" ] || fail "host checkout is not the accepted commit"
  [ "$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null)" = "$ACCEPTED_SHA" ] || fail "current-deploy.sha is not the accepted commit"
  [ "$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null)" = "$EXPECTED_HOSTED_SHA" ] || fail "previous-deploy.sha is not the previously hosted commit"
  [ -z "$(git -C "$APP_DIR" status --porcelain 2>/dev/null)" ] || fail "host checkout is dirty"
  pass "checkout HEAD / current-deploy = accepted commit, previous-deploy = previously hosted commit, clean"
  [ ! -e "$LOCK_FILE" ] || fail "an activation lock file exists ($LOCK_FILE)"
  [ -z "$(docker ps -a --filter "name=card-scanner-pro-api" --format '{{.Names}}' | grep -v '^card-scanner-pro-api-1$' || true)" ] || fail "an unexpected api container exists"
  for svc in api web postgres; do [ "$(compose ps --status running -q "$svc" | wc -l)" = "1" ] || fail "$svc is not running"; done
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$API_CID")" = "healthy" ] || fail "api is not healthy"
  echo "  api: $(docker inspect -f 'started={{.State.StartedAt}} restarts={{.RestartCount}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' "$API_CID")"
  local rz; rz="$(curl -sS --max-time 5 http://127.0.0.1:18080/api/readyz 2>/dev/null || echo "")"
  [[ "$rz" == *'"status":"ok"'* ]] && [[ "$rz" == *'"database":"ok"'* ]] && [[ "$rz" == *'"storage":"ok"'* ]] || fail "readiness is not ok/ok/ok"
  pass "no lock, one api container, api/web/postgres running, api healthy, readyz ok"
  echo "  storage init: $(docker logs "$API_CID" 2>&1 | grep -oE '"driver":"[a-z]+","legacyFallback":(true|false),"mirror":(true|false),"legacyDelete":(true|false)' | awk 'NR == 1 { print }')"
  docker logs "$API_CID" 2>&1 | grep -F '"driver":"gcs","legacyFallback":false,"mirror":false,"legacyDelete":false' >/dev/null || fail "storage initialization is not driver=gcs / fallback off / mirror off / legacy delete off"
  pass "storage initialization = gcs primary, no fallback, no mirror, legacy delete OFF (the product never deletes bucket objects)"
  [ "$(compose exec -T api sh -c 'ls -A /data/objects | wc -l')" = "0" ] || fail "objectdata is not empty"
  local fp; fp="$(fingerprint)"; [ "$fp" = "$FP_AFTER" ] || fail "schema fingerprint differs from the accepted post-apply fingerprint"
  [ "$(counts)" = "$COUNTS_AFTER" ] || fail "schema object counts differ"
  local tb; tb="$(tenant_md5)" || fail "tenant baseline unreadable"; [ "$tb" = "$TENANT_BASELINE_MD5" ] || fail "existing-tenant composition differs from the accepted baseline"
  [ "$(q "select count(*) from scans where company_id=1")" = "4" ] && [ "$(scan_rows_md5)" = "8a3e378a2acd0d880c6f45613b32473d" ] || fail "owner scan rows differ from the accepted baseline"
  [ "$(stat -c %a "$ENV_FILE")" = "$ENV_MODE" ] && [ "$(stat -c %s "$ENV_FILE")" = "$ENV_SIZE" ] && [ "$(sha256sum "$ENV_FILE" | cut -c1-16)" = "$ENV_SHA_PREFIX" ] || fail "environment file differs from the accepted baseline"
  pass "objectdata empty; schema fingerprint/counts, tenant composition, owner scans and environment file = accepted baselines"
  if q "create temp table b25_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard FAILED (a write succeeded in a q session)"; fi
  pass "read-only session guard"

  section "eligibility — disposable principals and feature rows of the second incident are absent"
  local C="$R2_COMPANIES" U="$R2_KNOWN_USERS" DOM="$SMOKE_DOMAIN" TAG="$R2_TAG"
  [ "$(q "select count(*) from companies where id in ($C) or name like 'B25 SMOKE %'")" = "0" ] || fail "a disposable company still exists"
  [ "$(q "select count(*) from users where id in ($U) or email like '%@$DOM'")" = "0" ] || fail "a disposable user still exists"
  [ "$(q "select (select count(*) from subscriptions where company_id in ($C)) + (select count(*) from sessions where user_id in ($U)) + (select count(*) from documents where company_id in ($C)) + (select count(*) from document_versions where company_id in ($C)) + (select count(*) from export_runs where company_id in ($C)) + (select count(*) from executive_reports where company_id in ($C)) + (select count(*) from scans where company_id in ($C)) + (select count(*) from contacts where company_id in ($C)) + (select count(*) from leads where company_id in ($C)) + (select count(*) from audit_logs where company_id in ($C) or user_id in ($U)) + (select count(*) from activity_logs where company_id in ($C) or user_id in ($U)) + (select count(*) from login_attempts where email like 'b25-smoke-${TAG}%@$DOM')")" = "0" ] || fail "a disposable feature row still exists"
  echo "  note: the three tenant users' ids were never recorded — audit/activity rows that would carry only such a user id (company_id null) are not attributable from this manifest (reported by the read-only inspection, never guessed)"
  echo "  dangling user references (read-only, informational): audit_logs=$(q "select count(*) from audit_logs a where a.user_id is not null and a.company_id is null and not exists (select 1 from users u where u.id = a.user_id)") activity_logs=$(q "select count(*) from activity_logs a where a.user_id is not null and a.company_id is null and not exists (select 1 from users u where u.id = a.user_id)")"
  pass "companies $C, user $U, every %@$DOM address and every disposable feature/audit/session row are absent"

  section "eligibility — the residue is exactly the recorded rows (nothing else; no live association; no pending job; no in-flight writer)"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and id not in ($R2_UUIDS_Q)")" = "0" ] || fail "another storage row of the disposable companies exists — not the recorded residue"
  [ "$(q "select count(*) from storage_objects where id in ($R2_UUIDS_Q) and company_id <> $R2_COMPANY")" = "0" ] || fail "a recorded uuid belongs to another company"
  [ "$(q "select count(*) from storage_objects s where s.id not in ($R2_UUIDS_Q) and exists (select 1 from unnest(array[$R2_UUIDS_Q]) u, lateral (select replace(u, '-', '') as h) x where s.reference like '%' || u || '%' or s.reference like '%' || x.h || '%' or s.storage_key like '%' || u || '%' or s.storage_key like '%' || x.h || '%' or coalesce(s.legacy_key,'') like '%' || u || '%' or coalesce(s.legacy_key,'') like '%' || x.h || '%' or coalesce(s.mirror_key,'') like '%' || u || '%' or coalesce(s.mirror_key,'') like '%' || x.h || '%')")" = "0" ] || fail "another storage row references a residue id"
  [ "$(q "select count(*) from storage_objects l where l.id in ($R2_UUIDS_Q) and (exists (select 1 from document_versions dv where dv.object_path = l.reference) or exists (select 1 from export_runs e where e.object_path = l.reference) or exists (select 1 from executive_reports r where r.object_path = l.reference) or exists (select 1 from scans sc where sc.image_url = l.reference) or exists (select 1 from companies co where co.brand_logo_key = l.reference))")" = "0" ] || fail "a live feature row still references a residue object"
  [ "$(q "select count(*) from job_queue where status in ('pending','running') and (payload::text like '%$R2_UUID_DOC%' or payload::text like '%$R2_UUID_LOGO1%' or payload::text like '%$R2_UUID_LOGO2%' or payload::text like '%\"companyId\":49%' or payload::text like '%\"companyId\":50%')")" = "0" ] || fail "a pending/running job still references the residue"
  [ "$(q "select count(*) from storage_objects where id in ($R2_UUIDS_Q) and (lease_token is not null or lease_expires_at is not null)")" = "0" ] || fail "a residue row carries a lease (in-flight writer)"
  [ "$(q "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle' and query ilike '%storage_objects%'")" = "0" ] || fail "an in-flight database session is working on storage_objects"
  pass "no other storage row, no live association, no pending job, no lease, no in-flight writer"

  section "eligibility — row identity per recorded tombstone (every column; kind-specific reference and key shapes)"
  local u kind nrow facts v i names ref_pred key_pred bucket present=0
  names=(company kind driver state last_error uncertainty lease mirror deleted_at legacy_key size sha256 reference storage_key created_at reconciled content_type)
  bucket="$(grep -E '^DEFAULT_OBJECT_STORAGE_BUCKET_ID=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"')"
  [[ "$bucket" =~ ^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$ ]] || fail "bucket name unreadable or malformed in the environment file"
  for u in "${R2_UUIDS[@]}"; do
    kind="$(r2_kind "$u")"
    nrow="$(q "select count(*) from storage_objects where id = '$u'")"
    if [ "$nrow" = "0" ]; then R2_STATE[$u]="C"; echo "  row $u ($kind): absent — already removed"; continue; fi
    [ "$nrow" = "1" ] || fail "unexpected row count for $u: $nrow"
    if [ "$kind" = "branding_logo" ]; then
      ref_pred="coalesce(reference ~ ('^branding/' || company_id || '/' || replace(id::text, '-', '') || '\\.(png|jpg|webp)\$'), false)"
      # the product stores a logo under tenants/<cid>/branding/<id WITHOUT dashes>.<ext> — the shared, tested rule of purge-lib
      key_pred="coalesce($(logo_key_rule_sql), false)"
    else
      ref_pred="coalesce(reference = '/objects/' || id::text, false)"
      key_pred="coalesce(storage_key = 'tenants/' || company_id || '/documents/' || id::text, false)"
    fi
    # every predicate is coalesced to false: a NULL column can never blank the whole line (and is itself a failure)
    facts="$(q "select coalesce(company_id = $R2_COMPANY, false)||'|'||coalesce(kind = '$kind', false)||'|'||coalesce(driver = 'gcs', false)||'|'||coalesce(state = 'deleted', false)||'|'||coalesce(last_error = 'LEGACY_RETAINED', false)||'|'||(publication_uncertain_at is null)||'|'||(lease_token is null and lease_expires_at is null)||'|'||(mirror_key is null and mirror_state is null)||'|'||coalesce(deleted_at >= '$R2_DELETED_FROM' and deleted_at < '$R2_DELETED_TO', false)||'|'||(legacy_key is not null)||'|'||coalesce(size_bytes > 0, false)||'|'||coalesce(sha256 ~ '^[0-9a-f]{64}\$', false)||'|'||$ref_pred||'|'||$key_pred||'|'||coalesce(created_at >= '$R2_CREATED_FROM' and created_at < '$R2_CREATED_TO', false)||'|'||(reconciled_at is not null)||'|'||coalesce(content_type <> '', false) from storage_objects where id = '$u'")"
    echo "  $u ($kind) facts(company|kind|driver|deleted|legacy_retained|not_uncertain|no_lease|no_mirror|deleted_in_window|legacy_key|size|sha|reference|storage_key|created_in_window|reconciled|content_type)=$facts"
    IFS='|' read -ra v <<<"$facts"; [ "${#v[@]}" = "17" ] || fail "row facts unreadable for $u"
    for i in 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 16; do [ "${v[$i]}" = "true" ] || fail "row identity check failed for $u: ${names[$i]}"; done
    [ "$(q "select (legacy_key = 'gs://$bucket/' || storage_key)::text from storage_objects where id = '$u'")" = "true" ] || fail "legacy_key of $u is not the canonical location of storage_key in the configured bucket"
    q "select 'row '||id||' company='||company_id||' kind='||kind||' state='||state||' last_error='||last_error||' size='||size_bytes||' deleted_at='||deleted_at||' reconciled_at='||coalesce(reconciled_at::text,'<null>')||' created='||created_at from storage_objects where id = '$u'" | sed 's/^/  /'
    R2_STATE[$u]="present"; present=$((present + 1))
  done
  R2_PRESENT=$present
  pass "$present of 3 recorded rows present; each present row = its recorded tombstone (company $R2_COMPANY, kind, gcs, deleted, LEGACY_RETAINED, no uncertainty/lease/mirror, kind-specific reference and key identity, legacy_key canonical, created and tombstoned in the smoke window)"

  section "eligibility — provider state per present row (marker, generation string, size; the four original objects untouched)"
  local cj o b im wm
  if [ "$present" = "0" ]; then
    cj="$(census)"; echo "  $cj"
    o="$(census_field "$cj" objects count)" || fail "census: objects missing"; b="$(census_field "$cj" bytes count)" || fail "census: bytes missing"
    im="$(census_field "$cj" inventory_md5 hex32)" || fail "census: digest missing"; wm="$(census_field "$cj" with_marker count)" || fail "census: with_marker missing"
    [ "$o" = "$CENSUS_OBJECTS" ] && [ "$b" = "$CENSUS_BYTES" ] && [ "$im" = "$R2_BASELINE_INVENTORY_MD5" ] && [ "$wm" = "0" ] || fail "rows absent but the inventory is not the accepted original — manual review"
    [ "$(q "select count(*) from storage_objects")" = "0" ] || fail "rows absent but other storage rows exist (pre-smoke baseline is 0 rows)"
    pass "STATE C — recovery already completed (rows absent, inventory = accepted original, no marked object)"; echo "ELIGIBILITY: STATE C (nothing to do) doc=C logo1=C logo2=C"; return 0
  fi
  local rj; rj="$(api_node "$DIAG_RECON_JS" "$(q "select coalesce(json_agg(json_build_object('r', object_path, 's', file_size)), '[]'::json) from export_runs where object_path ~ '$LEGACY_HANDLE'" | base64 -w0)")"; echo "  original references: $rj"
  [ "$(census_field "$rj" referenced count)" = "$REFERENCES" ] && [ "$(census_field "$rj" present count)" = "$REFERENCES" ] && [ "$(census_field "$rj" missing count)" = "0" ] && [ "$(census_field "$rj" size_match count)" = "$REFERENCES" ] || fail "original references are not fully present / size-matched — STOP"
  local a_count=0 b_count=0 sum=0 eo="" eb="" ewm="" emt eum euo tp lsame lpres row_b64 ej size
  for u in "${R2_UUIDS[@]}"; do
    [ "${R2_STATE[$u]}" = "present" ] || continue
    row_b64="$(q "select json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 's', size_bytes) from storage_objects where id = '$u'" | base64 -w0)"
    size="$(q "select size_bytes from storage_objects where id = '$u'")"; [[ "$size" =~ ^[1-9][0-9]*$ ]] || fail "size of $u unreadable"
    ej="$(api_node "$RESIDUE_ELIG_JS" "$row_b64")"; echo "  $u: $ej"
    eo="$(census_field "$ej" objects count)" || fail "eligibility: objects missing"; eb="$(census_field "$ej" bytes count)" || fail "eligibility: bytes missing"
    ewm="$(census_field "$ej" with_marker count)" || fail "eligibility: with_marker missing"; emt="$(census_field "$ej" marked_is_target count)" || fail "eligibility: marked_is_target missing"
    eum="$(census_field "$ej" unmarked_md5 hex32)" || fail "eligibility: unmarked digest missing"; euo="$(census_field "$ej" unmarked_objects count)" || fail "eligibility: unmarked count missing"
    tp="$(json_bool "$ej" target_present)" || fail "eligibility: target presence unreadable"
    [ "$euo" = "$CENSUS_OBJECTS" ] && [ "$eum" = "$R2_BASELINE_INVENTORY_MD5" ] || fail "the unmarked objects are not exactly the accepted original inventory (names/generations/sizes drifted) — STOP"
    if [ "$tp" = "true" ]; then
      [ "$emt" = "1" ] || fail "the object at the storage_key of $u is not the marked target — STOP"
      [ "$(json_bool "$ej" target_marker_matches_row)" = "true" ] || fail "the object of $u does not carry this row's ownership marker — STOP"
      [ "$(json_bool "$ej" target_generation_is_string)" = "true" ] && [ "$(json_bool "$ej" target_generation_canonical)" = "true" ] || fail "the generation of the object of $u is not a canonical decimal string — STOP"
      [ "$(json_bool "$ej" target_size_matches)" = "true" ] || fail "the size of the object of $u differs from its row — STOP"
      lsame="$(json_bool "$ej" legacy_same_object)" || fail "legacy location of $u unreadable"; [ "$lsame" = "true" ] || fail "legacy_key of $u is not the same object as storage_key — STOP"
      R2_STATE[$u]="A"; a_count=$((a_count + 1)); sum=$((sum + size))
      echo "  row $u: STATE A (object present, marker == row id, canonical generation of $(census_field "$ej" target_generation_digits count) digits, size == row)"
    else
      [ "$emt" = "0" ] || fail "eligibility of $u is inconsistent (absent yet counted as the marked target)"
      lpres="$(json_bool "$ej" legacy_present)" || fail "legacy location of $u unreadable"; [ "$lpres" = "false" ] || fail "object of $u absent at storage_key but present at legacy_key — STOP"
      R2_STATE[$u]="B"; b_count=$((b_count + 1))
      echo "  row $u: STATE B (object absent at every persisted location, row present)"
    fi
  done
  # aggregate of the (identical) bucket listings: exactly the originals plus the present target objects, nothing else marked
  [ "$ewm" = "$a_count" ] || fail "marked objects in the bucket ($ewm) differ from the rows whose object is present ($a_count) — a foreign marked object exists — STOP"
  [ "$eo" = "$((CENSUS_OBJECTS + a_count))" ] && [ "$eb" = "$((CENSUS_BYTES + sum))" ] || fail "census is not exactly originals + the present target objects (objects=$eo bytes=$eb present=$a_count) — STOP"
  pass "the $CENSUS_OBJECTS original objects = accepted inventory digest; $REFERENCES references present and size-matched; bucket = originals + $a_count target object(s); rows: A=$a_count B=$b_count C=$((3 - present))"
  echo "ELIGIBILITY: per-row states doc=${R2_STATE[$R2_UUID_DOC]} logo1=${R2_STATE[$R2_UUID_LOGO1]} logo2=${R2_STATE[$R2_UUID_LOGO2]} (A = object present → delete at the exact generation, absence proof, row removal; B = object absent → absence proof, row removal; C = row absent)"
}
phase_residue2_eligibility() {
  residue2_eligibility "$ARG1"
  rm -f "$HOME"/.b25-s1-node.err
  log "residue2-eligibility complete (read-only; nothing changed; doc=${R2_STATE[$R2_UUID_DOC]:-?} logo1=${R2_STATE[$R2_UUID_LOGO1]:-?} logo2=${R2_STATE[$R2_UUID_LOGO2]:-?})"
}
phase_residue2_settle() {
  declare -f purge_rows_sql >/dev/null || fail "purge library not loaded (stream b25-stage1-purge-lib.sh before this script)"
  r2_manifest_check "$ARG1"
  exec 9>"$LOCK_FILE"; flock -n 9 || fail "another activation holds the lock"
  # The lock path is expanded NOW: the eligibility re-read below temporarily points LOCK_FILE at a '.none' path, and a
  # trap that read the variable at exit time would remove the wrong path when eligibility fails — leaving the real
  # lock on the host and refusing every later eligibility run until someone removes it by hand.
  trap "rm -f '$LOCK_FILE' \"\$HOME\"/.b25-s1-node.err" EXIT
  # the lock file now exists; the eligibility check tolerates OUR lock (the fd is held by this session)
  local lock_was="$LOCK_FILE"; LOCK_FILE="$LOCK_FILE.none"; residue2_eligibility "$ARG1"; LOCK_FILE="$lock_was"
  local C="$R2_COMPANIES" u st handled=0
  if [ "$R2_PRESENT" = "0" ]; then section "settle — nothing to do (STATE C)"; echo "RESIDUE2_SETTLE: already completed; no provider call, no SQL write"; log "residue2-settle: nothing to do"; return 0; fi
  for u in "${R2_UUIDS[@]}"; do
    st="${R2_STATE[$u]}"
    if [ "$st" = "C" ]; then echo "row $u: absent — nothing to do"; continue; fi
    [ "$st" = "A" ] || [ "$st" = "B" ] || fail "row $u has no eligibility state — STOP"
    section "settle row $u ($(r2_kind "$u"), STATE $st) — object first, row last"
    local row_b64 dj loc_b64 aj triple
    if [ "$st" = "A" ]; then
      echo "  (1/3) delete the marked object at its exact generation (marker and size re-read in the same call; names never printed)"
      row_b64="$(q "select json_build_object('id', id, 'k', storage_key, 's', size_bytes) from storage_objects where id = '$u'" | base64 -w0)"
      dj="$(api_node "$PROVIDER_RULES_JS"$'\n'"$RESIDUE_DELETE_JS" "$row_b64")"; echo "  $dj"
      [ "$(census_field "$dj" deleted count 2>/dev/null || echo x)" = "1" ] || fail "the provider delete of $u did not happen (refused or failed) — the object and the row stay; rows handled so far: $handled; investigate"
      [ "$(census_field "$dj" absent_after count 2>/dev/null || echo x)" = "1" ] || fail "the object of $u still answers after the conditional delete — the row stays; investigate"
      echo "  provider delete: done at the exact generation ($(census_field "$dj" generation_digits count 2>/dev/null || echo ?) digits)"
    else
      echo "  (1/3) STATE B: the object was already removed by a previous run — no provider mutation"
    fi
    echo "  (2/3) absence proof at EVERY persisted location (storage_key, legacy_key, mirror_key; filesystem volume)"
    loc_b64="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 'm', mirror_key)), '[]'::json) from storage_objects where id = '$u'" | base64 -w0)"
    aj="$(api_node "$PROVIDER_RULES_JS"$'\n'"$RESIDUE_ABSENT_JS" "$loc_b64")"; echo "  $aj"
    [ "$(census_field "$aj" checked count 2>/dev/null || echo x)" = "1" ] && [ "$(census_field "$aj" absent count 2>/dev/null || echo x)" = "1" ] || fail "a persisted provider location of $u still answers — the row is NOT removed (resume from STATE B once it is absent)"
    [ "$(compose exec -T api sh -c 'ls -A /data/objects | wc -l')" = "0" ] || fail "objectdata is not empty — the row of $u is NOT removed"
    echo "  (3/3) remove the row (allow-listed, row-locked transaction; count must be exactly 1)"
    triple="$(qw "$(purge_rows_sql "'$u'" "$C" 1)")"
    purge_result_check "$triple" 1 || fail "the allow-listed delete did not remove exactly the row $u (nothing is removed when the row differs)"
    [ "$(q "select count(*) from storage_objects where id = '$u'")" = "0" ] || fail "the row $u remains"
    handled=$((handled + 1)); echo "  row $u: removed (object proven absent first)"
  done
  section "settle — final state"
  local cj o b im wm; cj="$(census)"; echo "  $cj"
  o="$(census_field "$cj" objects count)" || fail "census: objects missing"; b="$(census_field "$cj" bytes count)" || fail "census: bytes missing"
  im="$(census_field "$cj" inventory_md5 hex32)" || fail "census: digest missing"; wm="$(census_field "$cj" with_marker count)" || fail "census: with_marker missing"
  [ "$o" = "$CENSUS_OBJECTS" ] && [ "$b" = "$CENSUS_BYTES" ] && [ "$im" = "$R2_BASELINE_INVENTORY_MD5" ] && [ "$wm" = "0" ] || fail "census is not the accepted original inventory after the recovery — investigate (no further change is made)"
  [ "$(q "select count(*) from storage_objects where id in ($R2_UUIDS_Q) or company_id in ($C)")" = "0" ] || fail "a residue row remains"
  [ "$(q "select count(*) from storage_objects")" = "0" ] || fail "storage_objects is not back to the pre-smoke baseline (0 rows)"
  echo "RESIDUE2_SETTLE: COMPLETE — rows handled $handled, census $o / $b / $im, marked objects $wm, storage rows 0"
  log "residue2-settle complete"
}
# READ-ONLY final verification (always-step): reports and FAILS on any deviation from the accepted end state; never writes.
phase_residue2_verify() {
  r2_manifest_check "$ARG1"
  local C="$R2_COMPANIES" U="$R2_KNOWN_USERS" DOM="$SMOKE_DOMAIN" TAG="$R2_TAG" bad=0
  chk() { if [ "$2" = "$3" ]; then echo "verify: $1 = $2 OK"; else echo "verify: $1 = $2 (expected $3) FAILED"; bad=$((bad + 1)); fi; }
  section "residue2-verify (read-only)"
  if q "create temp table b25_should_fail (x int)" >/dev/null 2>&1; then echo "verify: read-only guard FAILED"; bad=$((bad + 1)); else echo "verify: read-only session guard OK"; fi
  chk "residue rows" "$(q "select count(*) from storage_objects where id in ($R2_UUIDS_Q) or company_id in ($C)")" "0"
  chk "rows mentioning a residue id" "$(q "select count(*) from storage_objects s where exists (select 1 from unnest(array[$R2_UUIDS_Q]) u, lateral (select replace(u, '-', '') as h) x where s.reference like '%' || u || '%' or s.reference like '%' || x.h || '%' or s.storage_key like '%' || u || '%' or s.storage_key like '%' || x.h || '%' or coalesce(s.legacy_key,'') like '%' || u || '%' or coalesce(s.legacy_key,'') like '%' || x.h || '%' or coalesce(s.mirror_key,'') like '%' || u || '%' or coalesce(s.mirror_key,'') like '%' || x.h || '%')")" "0"
  chk "storage_objects total" "$(q "select count(*) from storage_objects")" "0"
  chk "disposable companies" "$(q "select count(*) from companies where id in ($C) or name like 'B25 SMOKE %'")" "0"
  chk "disposable users" "$(q "select count(*) from users where id in ($U) or email like '%@$DOM'")" "0"
  chk "disposable feature/session/audit rows" "$(q "select (select count(*) from subscriptions where company_id in ($C)) + (select count(*) from sessions where user_id in ($U)) + (select count(*) from documents where company_id in ($C)) + (select count(*) from document_versions where company_id in ($C)) + (select count(*) from export_runs where company_id in ($C)) + (select count(*) from scans where company_id in ($C)) + (select count(*) from audit_logs where company_id in ($C) or user_id in ($U)) + (select count(*) from activity_logs where company_id in ($C) or user_id in ($U)) + (select count(*) from login_attempts where email like 'b25-smoke-${TAG}%@$DOM')")" "0"
  local cj; cj="$(census)"; echo "  $cj"
  chk "census objects" "$(census_field "$cj" objects count 2>/dev/null || echo ?)" "$CENSUS_OBJECTS"
  chk "census bytes" "$(census_field "$cj" bytes count 2>/dev/null || echo ?)" "$CENSUS_BYTES"
  chk "census inventory digest" "$(census_field "$cj" inventory_md5 hex32 2>/dev/null || echo ?)" "$R2_BASELINE_INVENTORY_MD5"
  chk "marked objects" "$(census_field "$cj" with_marker count 2>/dev/null || echo ?)" "0"
  local rj; rj="$(api_node "$DIAG_RECON_JS" "$(q "select coalesce(json_agg(json_build_object('r', object_path, 's', file_size)), '[]'::json) from export_runs where object_path ~ '$LEGACY_HANDLE'" | base64 -w0)")"; echo "  original references: $rj"
  chk "original references present" "$(census_field "$rj" present count 2>/dev/null || echo ?)" "$REFERENCES"
  chk "original references size-matched" "$(census_field "$rj" size_match count 2>/dev/null || echo ?)" "$REFERENCES"
  chk "tenant composition" "$(tenant_md5 2>/dev/null || echo unavailable)" "$TENANT_BASELINE_MD5"
  chk "owner scan rows" "$(scan_rows_md5 2>/dev/null || echo unavailable)" "8a3e378a2acd0d880c6f45613b32473d"
  chk "schema fingerprint" "$(fingerprint 2>/dev/null || echo unavailable)" "$FP_AFTER"
  chk "env file" "$(stat -c %a "$ENV_FILE" 2>/dev/null)/$(stat -c %s "$ENV_FILE" 2>/dev/null)/$(sha256sum "$ENV_FILE" 2>/dev/null | cut -c1-16)" "$ENV_MODE/$ENV_SIZE/$ENV_SHA_PREFIX"
  chk "objectdata entries" "$(compose exec -T api sh -c 'ls -A /data/objects | wc -l' 2>/dev/null | tr -d '[:space:]')" "0"
  chk "existing rows" "$(q "select 'companies='||(select count(*) from companies)||' users='||(select count(*) from users)||' subscriptions='||(select count(*) from subscriptions)||' contacts='||(select count(*) from contacts)||' leads='||(select count(*) from leads)||' events='||(select count(*) from events)||' scans='||(select count(*) from scans)||' documents='||(select count(*) from documents)||' export_runs='||(select count(*) from export_runs)")" "companies=1 users=2 subscriptions=1 contacts=1 leads=1 events=1 scans=4 documents=0 export_runs=4"
  chk "readyz" "$(curl -sS --max-time 5 http://127.0.0.1:18080/api/readyz 2>/dev/null | cut -c1-80)" '{"status":"ok","checks":{"database":"ok","storage":"ok"}}'
  echo "  api: $(docker inspect -f 'status={{.State.Status}} health={{.State.Health.Status}} restarts={{.RestartCount}} started={{.State.StartedAt}}' "$API_CID" 2>/dev/null || echo unavailable)"
  chk "dead jobs" "$(q "select count(*) from job_queue where status='dead'")" "0"
  rm -f "$HOME"/.b25-s1-node.err
  [ "$bad" = "0" ] || fail "residue2-verify: $bad check(s) failed (read-only; nothing changed)"
  echo "RESIDUE2_VERIFY: PASS (read-only)"
  log "residue2-verify complete"
}

# =============================================================================
# b25phys_inspect — B25 PHYSICAL TEST RESIDUE, READ-ONLY MANIFEST INSPECTION.
# The physical Android acceptance (APK b36b2f36…) left ONE tenant behind: company 53 "B25 Physical
# Android Test 20261015" with its dedicated test admin, event, contact 22, document 6 and the active
# storage row f048b5d4… (99 bytes, gcs). Before any settlement is designed, this phase enumerates the
# exact rows, keys, dependencies, provider metadata and job state and decides the fifteen deletion
# prerequisites (b25phys_eligibility, apply-lib). It READS ONLY: every SQL statement runs through q
# (session pinned read-only; a write attempt is proven to fail first), the provider is listed and
# HEADed, nothing is written on the host except api_node's temporary stderr file. The manifest is the
# readonly constant set of apply-lib — this phase never reads ARG1 / ARG2 / ARG3, so no workflow
# input can redirect it. There is NO settle phase for this manifest (deliberately absent).
# Identity / ownership / provider-metadata mismatches fail the phase closed AFTER the full report;
# every other unmet prerequisite is reported as B25_PHYSICAL_SETTLEMENT_ELIGIBLE=FALSE.
# =============================================================================
# Two immediate metadata reads of the row's object (by the stored key, never derived from the id):
# presence, marker, size, canonical generation, stability across the two reads, a digest of the
# generation (the value itself stays in-session), legacy location identity. Flat JSON only.
B25PHYS_GEN_JS=$(cat <<'JS'
const { Storage } = require("@google-cloud/storage");
const { createHash } = require("node:crypto");
(async () => {
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  const a = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "{}");
  const storage = new Storage();
  const file = storage.bucket(bucket).file(a.k);
  const read = async () => { try { const [m] = await file.getMetadata(); return m; } catch (e) { if (e && e.code === 404) return null; throw e; } };
  const t1 = new Date().toISOString(); const m1 = await read(); const m2 = await read(); const t2 = new Date().toISOString();
  const out = { present: !!m1, present_again: !!m2, read1_at: t1, read2_at: t2 };
  if (m1 && m2) {
    const g1 = m1.generation == null ? "" : String(m1.generation), g2 = m2.generation == null ? "" : String(m2.generation);
    const marker = (m) => !!(m.metadata && m.metadata["lcp-object-id"] === a.id);
    const lm = /^gs:\/\/([^/]+)\/(.+)$/.exec(a.l || "");
    Object.assign(out, {
      marker_matches_row: marker(m1) && marker(m2),
      size: Number(m1.size), size_matches: Number(m1.size) === Number(a.s) && Number(m2.size) === Number(a.s),
      generation_is_string: typeof m1.generation === "string" && typeof m2.generation === "string",
      generation_canonical: /^[1-9]\d*$/.test(g1) && /^[1-9]\d*$/.test(g2),
      generation_digits: g1.length, generation_stable: g1 !== "" && g1 === g2,
      generation_sha256_16: createHash("sha256").update(g1).digest("hex").slice(0, 16),
      metageneration_stable: String(m1.metageneration ?? "") === String(m2.metageneration ?? ""),
      updated: String(m1.updated || ""), content_type_set: !!m1.contentType,
      legacy_same_object: lm ? (lm[1] === bucket && lm[2] === a.k) : false,
    });
  }
  console.log(JSON.stringify(out));
})().catch((e) => console.log(JSON.stringify({ provider: "error", code: e.code || e.name || "unknown" })));
JS
)
phase_b25phys_inspect() {
  declare -f b25phys_eligibility >/dev/null || fail "apply library not loaded (stream b25-stage1-apply-lib.sh before this script)"
  local n=0; pass() { n=$((n + 1)); echo "inspect $n: $1 — OK"; }
  local facts=""; fact() { facts+="$1=$2"$'\n'; }
  local C="$B25PHYS_COMPANY" K="$B25PHYS_CONTACT" D="$B25PHYS_DOCUMENT" U="$B25PHYS_UUID"

  section "0. host state (read-only guard, accepted product, healthy, idle) — manifest $(b25phys_manifest)"
  [ "$(git -C "$APP_DIR" rev-parse HEAD)" = "$ACCEPTED_SHA" ] || fail "host checkout is not the accepted commit"
  [ "$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null)" = "$ACCEPTED_SHA" ] || fail "current-deploy.sha is not the accepted commit"
  [ -z "$(git -C "$APP_DIR" status --porcelain 2>/dev/null)" ] || fail "host checkout is dirty"
  [ ! -e "$LOCK_FILE" ] || fail "an activation lock file exists"
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$API_CID")" = "healthy" ] || fail "api is not healthy"
  local rz; rz="$(curl -sS --max-time 5 http://127.0.0.1:18080/api/readyz 2>/dev/null || echo "")"
  [[ "$rz" == *'"status":"ok"'* ]] && [[ "$rz" == *'"database":"ok"'* ]] && [[ "$rz" == *'"storage":"ok"'* ]] || fail "readiness is not ok/ok/ok"
  if q "create temp table b25_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard FAILED (a write succeeded in a q session)"; fi
  docker logs "$API_CID" 2>&1 | grep -F '"driver":"gcs","legacyFallback":false,"mirror":false,"legacyDelete":false' >/dev/null || fail "storage initialization is not driver=gcs / fallback off / mirror off / legacy delete off"
  local fp; fp="$(fingerprint)"; [ "$fp" = "$FP_AFTER" ] || fail "schema fingerprint differs from the accepted post-apply fingerprint"
  pass "accepted commit deployed and clean, no lock, api healthy, readyz ok, q session refuses writes, storage init gcs/no fallback/no mirror/legacy delete OFF, schema fingerprint accepted"

  section "A. company $C"
  local crow; crow="$(q "select id||'|'||name||'|'||status||'|'||plan||'|'||coalesce(suspended_reason,'<null>')||'|'||created_at||'|'||updated_at||'|'||coalesce(created_by_id::text,'<null>') from companies where id = $C")"
  echo "  company(id|name|status|plan|suspended_reason|created|updated|created_by_id)=${crow:-<absent>}"
  if [ -n "$crow" ]; then fact company_present 1; else fact company_present 0; fi
  fact company_name_matches "$(q "select coalesce((select name = '$B25PHYS_COMPANY_NAME' from companies where id = $C), false)::text")"
  echo "  subscriptions(id|plan|status|billing_source|created):"; q "select '  '||id||'|'||plan||'|'||status||'|'||billing_source||'|'||created_at from subscriptions where company_id = $C order by id"
  echo "  dependency census from the catalog (every foreign key to companies.id; table|column|on_delete|rows for company $C; zero rows omitted):"
  local gen deps blocking=0 nonzero=0 total=0 line tbl col del cnt
  gen="$(q "$(b25phys_fk_counts_gen_sql companies "$C")")"; [ -n "$gen" ] || fail "no foreign key references companies — catalog unreadable"
  deps="$(q "$gen")"
  while IFS='|' read -r tbl col del cnt; do
    [ -n "$tbl" ] || continue; total=$((total + 1))
    [[ "$cnt" =~ ^[0-9]+$ ]] || fail "dependency count unreadable for $tbl.$col"
    [ "$cnt" = "0" ] && continue
    nonzero=$((nonzero + 1)); echo "    $tbl|$col|$del|$cnt"
    case "$del" in cascade|"set null") ;; *) blocking=$((blocking + 1)); echo "    ^ BLOCKING: on_delete=$del would refuse the company cascade";; esac
  done <<<"$deps"
  echo "  foreign keys examined=$total tables_with_rows=$nonzero blocking=$blocking"
  fact deps_blocking "$blocking"; fact deps_tables_with_rows "$nonzero"
  echo "  company_id columns WITHOUT a foreign key (retained by design on tenant deletion; table|rows for company $C):"
  gen="$(q "$(b25phys_plain_company_counts_gen_sql "$C")")"; [ -n "$gen" ] && q "$gen" | sed 's/^/    /'
  local xt; xt="$(q "$(b25phys_cross_tenant_sql "$C")")"; [[ "$xt" =~ ^[0-9]+$ ]] || fail "cross-tenant check unreadable"
  echo "  cross-tenant links (tenant rows whose parents resolve outside company $C, or other tenants' rows pointing into it): $xt"
  fact cross_tenant_links "$xt"
  pass "company row, subscriptions, catalog-driven dependency census ($total foreign keys), retained-by-design tables, cross-tenant closure read"

  section "B. users of company $C (id|company|role|active|deleted|mfa|created|last_login|masked email|name_is_expected_label)"
  local urows; urows="$(q "select id||'|'||company_id||'|'||role||'|'||is_active||'|'||(deleted_at is not null)||'|'||mfa_enabled||'|'||created_at||'|'||coalesce(last_login_at::text,'<never>')||'|'||$(b25phys_mask_email_sql email)||'|'||(name = 'B25 Test Admin') from users where company_id = $C order by id")"
  printf '%s\n' "$urows" | sed 's/^/  /'
  fact users_total "$(q "select count(*) from users where company_id = $C")"
  fact users_outside_company "$(q "select count(*) from users where company_id = $C and company_id <> $C")"
  fact users_platform_role "$(q "select count(*) from users where company_id = $C and role = 'platform_owner'")"
  local cand; cand="$(q "select count(*) from users where company_id = $C and role = 'primary_admin' and is_active and deleted_at is null")"
  fact admin_candidates "$cand"
  local admin_id=""; [ "$cand" = "1" ] && admin_id="$(q "select id from users where company_id = $C and role = 'primary_admin' and is_active and deleted_at is null")"
  fact admin_user_id "${admin_id:-none}"
  if [ -n "$admin_id" ]; then
    echo "  dedicated B25 test admin: user id $admin_id (proof: company_id = $C, role primary_admin, active, not deleted; name label matches = $(q "select (name = 'B25 Test Admin')::text from users where id = $admin_id"))"
    echo "  sessions of the company's users: $(q "select count(*)||' (revoked='||count(*) filter (where revoked_at is not null)||')' from sessions where user_id in (select id from users where company_id = $C)")"
    echo "  dependency census of user $admin_id (foreign keys to users.id; table|column|on_delete|rows; zero rows omitted):"
    gen="$(q "$(b25phys_fk_counts_gen_sql users "$admin_id")")"; [ -n "$gen" ] && q "$gen" | awk -F'|' '$4 != "0" { print "    " $0 }'
  else
    echo "  dedicated B25 test admin: $cand candidate(s) — AMBIGUOUS / UNIDENTIFIED (nothing is inferred from names)"
  fi
  pass "$(q "select count(*) from users where company_id = $C") user row(s) enumerated by company ownership; admin candidates=$cand"

  section "C. events of company $C (id|company|name|status|start|end|created|deleted|contacts|leads|scans)"
  q "select '  '||e.id||'|'||e.company_id||'|'||e.name||'|'||e.status||'|'||coalesce(e.start_date::text,'<null>')||'|'||coalesce(e.end_date::text,'<null>')||'|'||e.created_at||'|'||coalesce(e.deleted_at::text,'<null>')||'|'||(select count(*) from contacts where event_id = e.id)||'|'||(select count(*) from leads where event_id = e.id)||'|'||(select count(*) from scans where event_id = e.id) from events e where e.company_id = $C order by e.id"
  local ev_n ev_id; ev_n="$(q "select count(*) from events where company_id = $C and name = '$B25PHYS_EVENT_NAME'")"
  if [ "$ev_n" = "1" ]; then ev_id="$(q "select id from events where company_id = $C and name = '$B25PHYS_EVENT_NAME'")"; fact event_ok true; fact event_id "$ev_id"; else fact event_ok false; fact event_id none; fi
  fact events_unexpected "$(q "select count(*) from events where company_id = $C and name <> '$B25PHYS_EVENT_NAME'")"
  if [ -n "${ev_id:-}" ]; then
    echo "  dependency census of event $ev_id (foreign keys to events.id; zero rows omitted):"
    gen="$(q "$(b25phys_fk_counts_gen_sql events "$ev_id")")"; [ -n "$gen" ] && q "$gen" | awk -F'|' '$4 != "0" { print "    " $0 }'
  fi
  pass "expected event rows=$ev_n (id ${ev_id:-none}); unexpected events of company $C=$(q "select count(*) from events where company_id = $C and name <> '$B25PHYS_EVENT_NAME'")"

  section "D. contact $K (id|company|label|status|source|event_id|assigned_to|created_by|created|deleted)"
  q "select '  '||id||'|'||company_id||'|'||coalesce(full_name, trim(coalesce(first_name,'')||' '||coalesce(last_name,'')))||'|'||status||'|'||coalesce(source,'<null>')||'|'||coalesce(event_id::text,'<null>')||'|'||coalesce(assigned_to_id::text,'<null>')||'|'||coalesce(created_by_id::text,'<null>')||'|'||created_at||'|'||coalesce(deleted_at::text,'<null>') from contacts where id = $K"
  fact contact_ok "$(q "select coalesce((select company_id = $C and coalesce(full_name, trim(coalesce(first_name,'')||' '||coalesce(last_name,''))) = '$B25PHYS_CONTACT_NAME' from contacts where id = $K), false)::text")"
  echo "  documents of contact $K in company $C: $(q "select count(*) from documents where company_id = $C and entity_type = 'contact' and entity_id = $K")  AI rows naming contact $K (insights|copilot|workflow): $(q "select (select count(*) from ai_insights where company_id = $C and entity_type = 'contact' and entity_id = $K)||'|'||(select count(*) from ai_copilot_outputs where company_id = $C and entity_type = 'contact' and entity_id = $K)||'|'||(select count(*) from ai_workflow_recommendations where company_id = $C and entity_type = 'contact' and entity_id = $K)")"
  echo "  dependency census of contact $K (foreign keys to contacts.id; zero rows omitted):"
  gen="$(q "$(b25phys_fk_counts_gen_sql contacts "$K")")"; [ -n "$gen" ] && q "$gen" | awk -F'|' '$4 != "0" { print "    " $0 }'
  pass "contact $K read with ownership and dependents"

  section "E. document $D (id|company|entity_type|entity_id|name|category|current_version|created_by|created|deleted) and its versions"
  q "select '  '||id||'|'||company_id||'|'||entity_type||'|'||entity_id||'|'||name||'|'||category||'|'||coalesce(current_version_id::text,'<null>')||'|'||coalesce(created_by_id::text,'<null>')||'|'||created_at||'|'||coalesce(deleted_at::text,'<null>') from documents where id = $D"
  echo "  versions (id|company|version|object_path_is_row_reference|file_size|mime|uploaded_by|uploaded_at):"
  q "select '  '||id||'|'||company_id||'|'||version_number||'|'||(object_path = '/objects/$U')||'|'||file_size||'|'||mime_type||'|'||coalesce(uploaded_by_id::text,'<null>')||'|'||uploaded_at from document_versions where document_id = $D order by version_number"
  fact document_ok "$(q "select coalesce((select company_id = $C and entity_type = 'contact' and entity_id = $K from documents where id = $D), false)::text")"
  fact document_versions "$(q "select count(*) from document_versions where document_id = $D")"
  echo "  dependency census of document $D (foreign keys to documents.id; zero rows omitted):"
  gen="$(q "$(b25phys_fk_counts_gen_sql documents "$D")")"; [ -n "$gen" ] && q "$gen" | awk -F'|' '$4 != "0" { print "    " $0 }'
  pass "document $D and $(q "select count(*) from document_versions where document_id = $D") version(s) read"

  section "F. storage row $U (every column in a safe form; keys never printed)"
  local srow; srow="$(q "select 'company='||company_id||' kind='||kind||' state='||state||' driver='||driver||' entity='||coalesce(entity_type,'<null>')||'/'||coalesce(entity_id::text,'<null>')||' reference_is_/objects/<id>='||(reference = '/objects/' || id::text)||' storage_key_is_tenants/'||company_id||'/documents/<id>='||(storage_key = 'tenants/' || company_id || '/documents/' || id::text)||' legacy_key_set='||(legacy_key is not null)||' mirror_key_set='||(mirror_key is not null)||' lease_set='||(lease_token is not null or lease_expires_at is not null)||' size='||coalesce(size_bytes::text,'null')||' sha256_set='||(sha256 is not null)||' content_type='||content_type||' last_error='||coalesce(last_error,'<null>')||' uncertain='||(publication_uncertain_at is not null)||' mirror_state='||coalesce(mirror_state,'<null>')||' created='||created_at||' updated='||updated_at||' deleted_at='||coalesce(deleted_at::text,'<null>')||' reconciled_at='||coalesce(reconciled_at::text,'<null>') from storage_objects where id = '$U'")"
  echo "  ${srow:-<absent>}"
  fact storage_row_ok "$(q "select coalesce((select company_id = $C and kind = 'document' and driver = 'gcs' and state = 'active' and reference = '/objects/' || id::text and storage_key = 'tenants/' || company_id || '/documents/' || id::text and mirror_key is null and lease_token is null and lease_expires_at is null and publication_uncertain_at is null and last_error is null and deleted_at is null and size_bytes = $B25PHYS_OBJECT_SIZE from storage_objects where id = '$U'), false)::text")"
  fact storage_linked_to_document "$(q "select ((select count(*) from document_versions v where v.document_id = $D and v.company_id = $C and v.object_path = '/objects/$U') = 1)::text")"
  local refs_other; refs_other="$(q "select (select count(*) from document_versions v where v.object_path = '/objects/$U' and v.document_id <> $D) + (select count(*) from export_runs where object_path = '/objects/$U') + (select count(*) from executive_reports where object_path = '/objects/$U') + (select count(*) from scans where image_url = '/objects/$U') + (select count(*) from storage_objects where id <> '$U' and (reference like '%$U%' or storage_key like '%$U%' or coalesce(legacy_key,'') like '%$U%' or coalesce(mirror_key,'') like '%$U%'))")"
  echo "  references: document_versions of document $D with this object=$(q "select count(*) from document_versions where document_id = $D and object_path = '/objects/$U'") other references anywhere=$refs_other"
  fact live_refs_other "$refs_other"
  echo "  legacy_key is the canonical location of storage_key: $(q "select coalesce((select legacy_key = 'gs://' || split_part(split_part(legacy_key, '://', 2), '/', 1) || '/' || storage_key from storage_objects where id = '$U'), false)::text") (bucket identity is checked by the provider read below)"
  pass "storage row read; one live version reference of document $D; other references=$refs_other"

  section "G. provider object (by the stored key; two immediate metadata reads; generation kept in-session)"
  local row_b64 gj; row_b64="$(q "select json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 's', size_bytes) from storage_objects where id = '$U'" | base64 -w0)"
  gj="$(api_node "$B25PHYS_GEN_JS" "$row_b64")"; echo "  $gj"
  local present marker sizem gcan gstab gdig
  present="$(json_bool "$gj" present)" || fail "provider read unreadable"
  fact provider_present "$present"
  if [ "$present" = "true" ]; then
    marker="$(json_bool "$gj" marker_matches_row)" || fail "provider marker unreadable"; sizem="$(json_bool "$gj" size_matches)" || fail "provider size unreadable"
    gcan="$(json_bool "$gj" generation_canonical)" || fail "provider generation unreadable"; gstab="$(json_bool "$gj" generation_stable)" || fail "provider stability unreadable"
    gdig="$(census_field "$gj" generation_digits count)" || fail "provider generation digits unreadable"
    fact provider_marker_ok "$marker"; fact provider_size "$(census_field "$gj" size count)"; fact provider_size_matches "$sizem"
    fact provider_generation_canonical "$gcan"; fact provider_generation_stable "$gstab"; fact provider_generation_digits "$gdig"
    echo "  generation: $gdig digits, canonical=$gcan, stable across two reads=$gstab, sha256/16=$(json_flat_field "$gj" generation_sha256_16), legacy_same_object=$(json_flat_field "$gj" legacy_same_object)"
  else
    fact provider_marker_ok false; fact provider_size 0; fact provider_size_matches false; fact provider_generation_canonical false; fact provider_generation_stable false; fact provider_generation_digits 0
  fi
  local ej; ej="$(api_node "$RESIDUE_ELIG_JS" "$row_b64")"; echo "  listing: $ej"
  fact provider_marked_is_target "$(census_field "$ej" marked_is_target count 2>/dev/null || echo "?")"
  local eum euo; eum="$(census_field "$ej" unmarked_md5 hex32 2>/dev/null || echo "?")"; euo="$(census_field "$ej" unmarked_objects count 2>/dev/null || echo "?")"
  if [ "$eum" = "$B25PHYS_ORIGINALS_MD5" ] && [ "$euo" = "$CENSUS_OBJECTS" ]; then fact unmarked_md5_ok true; else fact unmarked_md5_ok false; fi
  pass "provider object read twice by the stored key; the unmarked objects are exactly the accepted originals ($euo / $eum)"

  section "H. tenant AI tables for company $C (rows; on-delete action from the catalog) and ai_invocations"
  local t aic aiok=true del_act
  for t in ai_insights ai_conversations ai_messages ai_copilot_outputs ai_workflow_recommendations ai_settings ai_usage_reservations; do
    aic="$(q "select count(*) from $t where company_id = $C")"
    del_act="$(q "select case c.confdeltype when 'c' then 'cascade' when 'n' then 'set null' else 'other' end from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1] where c.contype = 'f' and c.conrelid = '$t'::regclass and c.confrelid = 'companies'::regclass and a.attname = 'company_id'")"
    echo "  $t: rows=$aic on_delete=${del_act:-<no fk>} $( [ "$aic" != "0" ] && q "select '  statuses: '||string_agg(s||'='||n, ', ') from (select coalesce(status,'-') s, count(*) n from $t where company_id = $C group by 1) x" 2>/dev/null || true)"
    fact "$t" "$aic"
    [ "$aic" = "0" ] || [ "$del_act" = "cascade" ] || aiok=false
  done
  local inv; inv="$(q "select count(*) from ai_invocations where company_id = $C or user_id in (select id from users where company_id = $C) or (entity_type = 'contact' and entity_id = $K)")"
  echo "  ai_invocations relevant rows=$inv (company_id set null, user_id set null on deletion: historical ledger rows are RETAINED with nulled ownership) $( [ "$inv" != "0" ] && q "select '  (feature|status|n): '||string_agg(f||'|'||s||'|'||n, ', ') from (select feature f, status s, count(*) n from ai_invocations where company_id = $C or user_id in (select id from users where company_id = $C) or (entity_type = 'contact' and entity_id = $K) group by 1,2) x" || true)"
  fact ai_invocations "$inv"; fact ai_rows_classified "$aiok"
  pass "AI tables classified (cascade rows of the tenant only; ledger rows set-null)"

  section "I. job queue (dedupe keys are plain text; payloads are encrypted and never read)"
  echo "  storage jobs for company $C / object $U (name|status|enqueued|completed|attempts):"; q "select '  '||name||'|'||status||'|'||enqueued_at||'|'||coalesce(completed_at::text,'-')||'|'||attempts from job_queue where dedupe_key like 'storage.purge:$C:%' or dedupe_key = 'storage.delete:$U' order by enqueued_at"
  local jc; jc="$(q "select (select count(*) from job_queue where status in ('pending','running') and (dedupe_key like 'storage.purge:$C:%' or dedupe_key = 'storage.delete:$U')) + (select count(*) from job_queue where status in ('pending','running') and name like 'ai.%') + (select count(*) from job_queue where status = 'dead' and name like 'storage.%')")"
  fact jobs_conflicting "$jc"; fact dead_storage_jobs "$(q "select count(*) from job_queue where status = 'dead' and name like 'storage.%'")"
  echo "  pending/running jobs by name: $(q "select coalesce(string_agg(name||'='||n, ', '), 'none') from (select name, count(*) n from job_queue where status in ('pending','running') group by name) x")  dead jobs total=$(q "select count(*) from job_queue where status = 'dead'")"
  echo "  in-flight sessions on storage_objects: $(q "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle' and query ilike '%storage_objects%'")"
  pass "no conflicting job = $jc"

  section "J. census (same method as the locked baseline: sorted name|generation|size → md5) and originals"
  local cj o b im wm; cj="$(census)"; echo "  $cj"
  o="$(census_field "$cj" objects count)" || fail "census: objects missing"; b="$(census_field "$cj" bytes count)" || fail "census: bytes missing"
  im="$(census_field "$cj" inventory_md5 hex32)" || fail "census: digest missing"; wm="$(census_field "$cj" with_marker count)" || fail "census: with_marker missing"
  fact census_objects "$o"; fact census_bytes "$b"; fact census_marked "$wm"; fact census_md5 "$im"
  fact storage_rows "$(q "select count(*) from storage_objects")"
  local rj; rj="$(api_node "$DIAG_RECON_JS" "$(q "select coalesce(json_agg(json_build_object('r', object_path, 's', file_size)), '[]'::json) from export_runs where object_path ~ '$LEGACY_HANDLE'" | base64 -w0)")"; echo "  original references: $rj"
  if [ "$(census_field "$rj" referenced count 2>/dev/null)" = "$REFERENCES" ] && [ "$(census_field "$rj" present count 2>/dev/null)" = "$REFERENCES" ] && [ "$(census_field "$rj" missing count 2>/dev/null)" = "0" ] && [ "$(census_field "$rj" size_match count 2>/dev/null)" = "$REFERENCES" ]; then fact originals_ok true; else fact originals_ok false; fi
  pass "census objects=$o bytes=$b marked=$wm md5=$im storage_rows=$(q "select count(*) from storage_objects")"

  section "K. deletion prerequisites (read-only decision; nothing is changed by this phase)"
  local verdict; if verdict="$(printf '%s' "$facts" | b25phys_eligibility)"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "b25phys eligibility evaluator failed — the lines above are the verdict (read-only; nothing changed)"; fi
  rm -f "$HOME"/.b25-s1-node.err
  echo "FACTS: $(printf '%s' "$facts" | tr '\n' ' ')"
  local fatal; fatal="$(printf '%s\n' "$verdict" | grep -oE '^B25PHYS_FATAL=[0-9]+$' | cut -d= -f2)"
  [ "${fatal:-1}" = "0" ] || fail "b25phys-inspect: $fatal identity / ownership / provider mismatch(es) — the manifest does not describe the hosted state (read-only; nothing changed)"
  log "b25phys-inspect complete (read-only; nothing changed; $(printf '%s\n' "$verdict" | grep -oE '^B25_PHYSICAL_SETTLEMENT_ELIGIBLE=(TRUE|FALSE)$'))"
}

# =============================================================================
# b25phys_postdelete_verify — READ-ONLY verification after the real platform owner deleted
# company 53 through the Platform portal. Proves the product cascade (user 100, event 17,
# contact 22, document 6, version 6 absent and unreferenced), the storage.purgeCompany job
# (identified by its plaintext dedupe key; waited for read-only, never enqueued or retried),
# the product tombstone of row f048b5d4… (deleted / LEGACY_RETAINED / no lease / no mirror /
# no uncertainty), the RETAINED provider object (two metadata reads by the stored key; the
# generation digest must equal the pre-delete proof) and the unchanged inventory
# (5 / 1398 / 1 marked; originals 4 / c1b900fd…). Then decides
# B25_POSTDELETE_PROVIDER_SETTLEMENT_ELIGIBLE (apply-lib). Reads only: q sessions pinned
# read-only (write attempt proven to fail first), provider HEAD/list, container logs. Never
# reads ARG1 / ARG2 / ARG3; the manifest is the readonly constant set. No settle phase exists.
# =============================================================================
phase_b25phys_postdelete_verify() {
  declare -f b25phys_postdelete_eligibility >/dev/null || fail "apply library not loaded (stream b25-stage1-apply-lib.sh before this script)"
  local n=0; pass() { n=$((n + 1)); echo "postdelete $n: $1 — OK"; }
  local facts=""; fact() { facts+="$1=$2"$'\n'; }
  local C="$B25PHYS_COMPANY" K="$B25PHYS_CONTACT" D="$B25PHYS_DOCUMENT" U="$B25PHYS_UUID" AU="$B25PHYS_USER" EV="$B25PHYS_EVENT" VR="$B25PHYS_VERSION"
  local gen cnt

  section "0. host state (read-only guard, accepted product, healthy, idle) — manifest $(b25phys_manifest)|user $AU|event $EV|version $VR"
  [ "$(git -C "$APP_DIR" rev-parse HEAD)" = "$ACCEPTED_SHA" ] || fail "host checkout is not the accepted commit"
  [ "$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null)" = "$ACCEPTED_SHA" ] || fail "current-deploy.sha is not the accepted commit"
  [ -z "$(git -C "$APP_DIR" status --porcelain 2>/dev/null)" ] || fail "host checkout is dirty"
  [ ! -e "$LOCK_FILE" ] || fail "an activation lock file exists"
  local svc; for svc in api web postgres; do [ "$(compose ps --status running -q "$svc" | wc -l)" = "1" ] || fail "$svc is not running"; done
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$API_CID")" = "healthy" ] || fail "api is not healthy"
  local rz; rz="$(curl -sS --max-time 5 http://127.0.0.1:18080/api/readyz 2>/dev/null || echo "")"
  [[ "$rz" == *'"status":"ok"'* ]] && [[ "$rz" == *'"database":"ok"'* ]] && [[ "$rz" == *'"storage":"ok"'* ]] || fail "readiness is not ok/ok/ok"
  if q "create temp table b25_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard FAILED (a write succeeded in a q session)"; fi
  docker logs "$API_CID" 2>&1 | grep -F '"driver":"gcs","legacyFallback":false,"mirror":false,"legacyDelete":false' >/dev/null || fail "storage initialization is not driver=gcs / fallback off / mirror off / legacy delete off"
  local fp; fp="$(fingerprint)"; [ "$fp" = "$FP_AFTER" ] || fail "schema fingerprint differs from the accepted post-apply fingerprint"
  echo "  api: $(docker inspect -f 'started={{.State.StartedAt}} restarts={{.RestartCount}} health={{.State.Health.Status}}' "$API_CID")"
  pass "accepted commit deployed and clean, no lock, api/web/postgres running, api healthy, readyz ok, q session refuses writes, storage init gcs/no fallback/no mirror/legacy delete OFF, schema fingerprint accepted"

  section "A. company $C — must be absent with no dependent tenant row (catalog-driven) and no tenant AI row"
  cnt="$(q "select count(*) from companies where id = $C")"; echo "  companies rows for id $C: $cnt"
  if [ "$cnt" = "0" ]; then fact company_absent true; else fact company_absent false; fi
  local deps total=0 nonzero=0 tbl col del
  gen="$(q "$(b25phys_fk_counts_gen_sql companies "$C")")"; [ -n "$gen" ] || fail "no foreign key references companies — catalog unreadable"
  deps="$(q "$gen")"
  while IFS='|' read -r tbl col del cnt; do
    [ -n "$tbl" ] || continue; total=$((total + 1)); [[ "$cnt" =~ ^[0-9]+$ ]] || fail "dependency count unreadable for $tbl.$col"
    [ "$cnt" = "0" ] && continue; nonzero=$((nonzero + cnt)); echo "    STILL PRESENT: $tbl|$col|$del|$cnt"
  done <<<"$deps"
  echo "  foreign keys examined=$total dependent rows remaining=$nonzero"
  fact company_dependents "$nonzero"
  echo "  company_id columns WITHOUT a foreign key (retained by schema design; table|rows for company $C):"
  gen="$(q "$(b25phys_plain_company_counts_gen_sql "$C")")"; [ -n "$gen" ] && q "$gen" | sed 's/^/    /'
  local t ai=0 aic
  for t in ai_insights ai_conversations ai_messages ai_copilot_outputs ai_workflow_recommendations ai_settings ai_usage_reservations; do
    aic="$(q "select count(*) from $t where company_id = $C")"; [ "$aic" = "0" ] || echo "    AI residue: $t rows=$aic"; ai=$((ai + aic))
  done
  echo "  tenant AI rows for company $C: $ai; ai_invocations rows still carrying company $C or user $AU: $(q "select count(*) from ai_invocations where company_id = $C or user_id = $AU") (set-null on deletion: must be 0)"
  fact ai_residue "$ai"
  pass "company $C rows=$(q "select count(*) from companies where id = $C"); dependents remaining=$nonzero; AI residue=$ai"

  section "B. user $AU — absent and unreferenced (every foreign key to users.id)"
  cnt="$(q "select count(*) from users where id = $AU")"; echo "  users rows for id $AU: $cnt (sessions of user $AU: $(q "select count(*) from sessions where user_id = $AU"))"
  if [ "$cnt" = "0" ]; then fact user_absent true; else fact user_absent false; fi
  gen="$(q "$(b25phys_fk_counts_gen_sql users "$AU")")"; cnt="$(q "$gen" | awk -F'|' '{ s += $4 } END { print s + 0 }')"; q "$gen" | awk -F'|' '$4 != "0" { print "    STILL REFERENCED: " $0 }'
  fact user_refs "$cnt"; pass "user $AU references remaining=$cnt"

  section "C. event $EV — absent and unreferenced"
  cnt="$(q "select count(*) from events where id = $EV")"; echo "  events rows for id $EV: $cnt; events of company $C: $(q "select count(*) from events where company_id = $C")"
  if [ "$cnt" = "0" ]; then fact event_absent true; else fact event_absent false; fi
  gen="$(q "$(b25phys_fk_counts_gen_sql events "$EV")")"; cnt="$(q "$gen" | awk -F'|' '{ s += $4 } END { print s + 0 }')"; q "$gen" | awk -F'|' '$4 != "0" { print "    STILL REFERENCED: " $0 }'
  fact event_refs "$cnt"; pass "event $EV references remaining=$cnt"

  section "D. contact $K — absent and unreferenced"
  cnt="$(q "select count(*) from contacts where id = $K")"; echo "  contacts rows for id $K: $cnt; contacts of company $C: $(q "select count(*) from contacts where company_id = $C")"
  if [ "$cnt" = "0" ]; then fact contact_absent true; else fact contact_absent false; fi
  gen="$(q "$(b25phys_fk_counts_gen_sql contacts "$K")")"; cnt="$(q "$gen" | awk -F'|' '{ s += $4 } END { print s + 0 }')"; q "$gen" | awk -F'|' '$4 != "0" { print "    STILL REFERENCED: " $0 }'
  fact contact_refs "$cnt"; pass "contact $K references remaining=$cnt"

  section "E. document $D and version $VR — absent and unreferenced"
  cnt="$(q "select count(*) from documents where id = $D")"; echo "  documents rows for id $D: $cnt; documents of company $C: $(q "select count(*) from documents where company_id = $C")"
  if [ "$cnt" = "0" ]; then fact document_absent true; else fact document_absent false; fi
  gen="$(q "$(b25phys_fk_counts_gen_sql documents "$D")")"; cnt="$(q "$gen" | awk -F'|' '{ s += $4 } END { print s + 0 }')"; q "$gen" | awk -F'|' '$4 != "0" { print "    STILL REFERENCED: " $0 }'
  fact document_refs "$cnt"
  cnt="$(q "select count(*) from document_versions where id = $VR or document_id = $D or object_path = '/objects/$U'")"; echo "  document_versions rows (id $VR, document $D, or the object path): $cnt"
  if [ "$cnt" = "0" ]; then fact version_absent true; else fact version_absent false; fi
  pass "document $D references remaining=$(q "$gen" | awk -F'|' '{ s += $4 } END { print s + 0 }'); version rows=$cnt"

  section "F. storage.purgeCompany job of company $C (identified by its plaintext dedupe key; payloads never read; read-only wait, never enqueued or retried)"
  local pr poll=0
  pr="$(q "select count(*) from job_queue where dedupe_key like 'storage.purge:$C:%' and status in ('pending','running')")"
  while [ "$pr" != "0" ] && [ "$poll" -lt 12 ]; do poll=$((poll + 1)); echo "  purge job still $(q "select string_agg(status, ',') from job_queue where dedupe_key like 'storage.purge:$C:%' and status in ('pending','running')") — waiting (poll $poll of 12, 10 s)"; sleep 10; pr="$(q "select count(*) from job_queue where dedupe_key like 'storage.purge:$C:%' and status in ('pending','running')")"; done
  echo "  purge jobs (id|status|enqueued|started|completed|attempts|last_error):"
  q "select '  '||id||'|'||status||'|'||enqueued_at||'|'||coalesce(started_at::text,'-')||'|'||coalesce(completed_at::text,'-')||'|'||attempts||'|'||coalesce(left(last_error, 80),'-') from job_queue where dedupe_key like 'storage.purge:$C:%' order by enqueued_at" | san
  fact purge_total "$(q "select count(*) from job_queue where dedupe_key like 'storage.purge:$C:%'")"
  fact purge_completed "$(q "select count(*) from job_queue where dedupe_key like 'storage.purge:$C:%' and status = 'completed'")"
  fact purge_pending_running "$pr"
  fact purge_dead "$(q "select count(*) from job_queue where dedupe_key like 'storage.purge:$C:%' and status = 'dead'")"
  echo "  storage.deleteObject job for the uuid: $(q "select count(*) from job_queue where dedupe_key = 'storage.delete:$U'") (status: $(q "select coalesce(string_agg(status, ','), 'none') from job_queue where dedupe_key = 'storage.delete:$U'"))"
  fact jobs_conflicting "$(q "select (select count(*) from job_queue where status in ('pending','running') and (dedupe_key like 'storage.purge:$C:%' or dedupe_key = 'storage.delete:$U')) + (select count(*) from job_queue where status in ('pending','running') and name like 'ai.%')")"
  fact dead_storage_jobs "$(q "select count(*) from job_queue where status = 'dead' and name like 'storage.%'")"
  echo "  pending/running jobs by name: $(q "select coalesce(string_agg(name||'='||n, ', '), 'none') from (select name, count(*) n from job_queue where status in ('pending','running') group by name) x")  dead jobs total=$(q "select count(*) from job_queue where status = 'dead'")  in-flight sessions on storage_objects: $(q "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle' and query ilike '%storage_objects%'")"
  pass "purge jobs total=$(q "select count(*) from job_queue where dedupe_key like 'storage.purge:$C:%'") completed=$(q "select count(*) from job_queue where dedupe_key like 'storage.purge:$C:%' and status = 'completed'") pending/running=$pr"

  section "G. storage row $U — the product tombstone (every column in a safe form; keys never printed)"
  cnt="$(q "select count(*) from storage_objects where id = '$U'")"; fact row_count "$cnt"
  echo "  rows for the uuid: $cnt; storage rows of company $C: $(q "select count(*) from storage_objects where company_id = $C"); storage_objects total: $(q "select count(*) from storage_objects")"
  q "select '  company='||company_id||' kind='||kind||' state='||state||' driver='||driver||' entity='||coalesce(entity_type,'<null>')||'/'||coalesce(entity_id::text,'<null>')||' reference_is_/objects/<id>='||(reference = '/objects/' || id::text)||' storage_key_is_tenants/'||company_id||'/documents/<id>='||(storage_key = 'tenants/' || company_id || '/documents/' || id::text)||' legacy_key_canonical='||coalesce(legacy_key = 'gs://' || split_part(split_part(legacy_key, '://', 2), '/', 1) || '/' || storage_key, false)||' mirror_key_set='||(mirror_key is not null)||' mirror_state='||coalesce(mirror_state,'<null>')||' lease_set='||(lease_token is not null or lease_expires_at is not null)||' size='||coalesce(size_bytes::text,'null')||' sha256_set='||(sha256 is not null)||' last_error='||coalesce(last_error,'<null>')||' uncertain='||(publication_uncertain_at is not null)||' created='||created_at||' updated='||updated_at||' deleted_at='||coalesce(deleted_at::text,'<null>')||' reconciled_at='||coalesce(reconciled_at::text,'<null>') from storage_objects where id = '$U'"
  fact row_state "$(q "select coalesce((select state from storage_objects where id = '$U'), '<absent>')")"
  fact row_last_error "$(q "select coalesce((select coalesce(last_error, '<null>') from storage_objects where id = '$U'), '<absent>')")"
  fact row_uncertain "$(q "select coalesce((select (publication_uncertain_at is not null)::text from storage_objects where id = '$U'), '<absent>')")"
  fact row_deleted_at_set "$(q "select coalesce((select (deleted_at is not null)::text from storage_objects where id = '$U'), 'false')")"
  fact row_lease "$(q "select coalesce((select (lease_token is not null or lease_expires_at is not null)::text from storage_objects where id = '$U'), '<absent>')")"
  fact row_mirror "$(q "select coalesce((select (mirror_key is not null or mirror_state is not null)::text from storage_objects where id = '$U'), '<absent>')")"
  fact row_identity_ok "$(q "select coalesce((select (company_id = $C and kind = 'document' and driver = 'gcs' and reference = '/objects/' || id::text and storage_key = 'tenants/' || company_id || '/documents/' || id::text and coalesce(legacy_key = 'gs://' || split_part(split_part(legacy_key, '://', 2), '/', 1) || '/' || storage_key, false) and size_bytes = $B25PHYS_OBJECT_SIZE)::text from storage_objects where id = '$U'), 'false')")"
  local refs; refs="$(q "select (select count(*) from document_versions where object_path = '/objects/$U') + (select count(*) from export_runs where object_path = '/objects/$U') + (select count(*) from executive_reports where object_path = '/objects/$U') + (select count(*) from scans where image_url = '/objects/$U') + (select count(*) from storage_objects where id <> '$U' and (reference like '%$U%' or storage_key like '%$U%' or coalesce(legacy_key,'') like '%$U%' or coalesce(mirror_key,'') like '%$U%'))")"
  fact live_refs "$refs"; echo "  live application references to the object: $refs"
  pass "tombstone row read; live references=$refs"

  section "H. provider object — RETAINED by design (two immediate metadata reads by the stored key; generation kept in-session)"
  local row_b64 gj present
  row_b64="$(q "select coalesce((select json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 's', size_bytes) from storage_objects where id = '$U'), '{}'::json)" | base64 -w0)"
  gj="$(api_node "$B25PHYS_GEN_JS" "$row_b64")"; echo "  $gj"
  present="$(json_bool "$gj" present)" || fail "provider read unreadable"
  fact provider_present "$present"
  if [ "$present" = "true" ]; then
    fact provider_marker_ok "$(json_bool "$gj" marker_matches_row || echo false)"; fact provider_size "$(census_field "$gj" size count || echo 0)"; fact provider_size_matches "$(json_bool "$gj" size_matches || echo false)"
    fact provider_generation_canonical "$(json_bool "$gj" generation_canonical || echo false)"; fact provider_generation_stable "$(json_bool "$gj" generation_stable || echo false)"
    fact provider_metageneration_stable "$(json_bool "$gj" metageneration_stable || echo false)"; fact provider_generation_digits "$(census_field "$gj" generation_digits count || echo 0)"
    local dg; dg="$(json_flat_field "$gj" generation_sha256_16 2>/dev/null | tr -d '"' || true)"; fact provider_generation_digest "${dg:-none}"
    echo "  generation digest sha256/16=$dg (pre-delete proof $B25PHYS_PRE_GEN_DIGEST → $([ "$dg" = "$B25PHYS_PRE_GEN_DIGEST" ] && echo UNCHANGED || echo CHANGED))"
  else
    echo "  UNEXPECTED: the provider object is ABSENT although legacy delete is off and no settlement was authorized — investigate before any further step"
    fact provider_marker_ok false; fact provider_size 0; fact provider_size_matches false; fact provider_generation_canonical false; fact provider_generation_stable false; fact provider_metageneration_stable false; fact provider_generation_digits 0; fact provider_generation_digest none
  fi
  local ej; ej="$(api_node "$RESIDUE_ELIG_JS" "$row_b64")"; echo "  listing: $ej"
  fact provider_marked_is_target "$(census_field "$ej" marked_is_target count 2>/dev/null || echo "?")"
  local eum euo; eum="$(census_field "$ej" unmarked_md5 hex32 2>/dev/null || echo "?")"; euo="$(census_field "$ej" unmarked_objects count 2>/dev/null || echo "?")"
  if [ "$eum" = "$B25PHYS_ORIGINALS_MD5" ] && [ "$euo" = "$CENSUS_OBJECTS" ]; then fact unmarked_md5_ok true; else fact unmarked_md5_ok false; fi
  pass "provider object present=$present; unmarked objects $euo / $eum"

  section "I. census (locked method) and originals"
  local cj o b im wm; cj="$(census)"; echo "  $cj"
  o="$(census_field "$cj" objects count)" || fail "census: objects missing"; b="$(census_field "$cj" bytes count)" || fail "census: bytes missing"
  im="$(census_field "$cj" inventory_md5 hex32)" || fail "census: digest missing"; wm="$(census_field "$cj" with_marker count)" || fail "census: with_marker missing"
  fact census_objects "$o"; fact census_bytes "$b"; fact census_marked "$wm"; fact census_md5 "$im"
  if [ "$o" = "$CENSUS_OBJECTS" ] && [ "$b" = "$CENSUS_BYTES" ]; then echo "  UNEXPECTED: the inventory already equals the pre-test baseline ($o / $b) although no provider settlement was authorized — not a success; investigate"; fi
  local rj; rj="$(api_node "$DIAG_RECON_JS" "$(q "select coalesce(json_agg(json_build_object('r', object_path, 's', file_size)), '[]'::json) from export_runs where object_path ~ '$LEGACY_HANDLE'" | base64 -w0)")"; echo "  original references: $rj"
  if [ "$(census_field "$rj" referenced count 2>/dev/null)" = "$REFERENCES" ] && [ "$(census_field "$rj" present count 2>/dev/null)" = "$REFERENCES" ] && [ "$(census_field "$rj" missing count 2>/dev/null)" = "0" ] && [ "$(census_field "$rj" size_match count 2>/dev/null)" = "$REFERENCES" ]; then fact originals_ok true; else fact originals_ok false; fi
  echo "  inventory totals: $(q "select 'storage_objects_total='||count(*)||' active='||count(*) filter (where state='active')||' deleting='||count(*) filter (where state='deleting')||' deleted='||count(*) filter (where state='deleted')||' uncertain='||count(*) filter (where publication_uncertain_at is not null)||' unproven='||count(*) filter (where last_error='OWNERSHIP_UNPROVEN')||' cleanup_pending='||count(*) filter (where last_error='CLEANUP_PENDING')||' legacy_retained='||count(*) filter (where last_error='LEGACY_RETAINED') from storage_objects")"
  pass "census objects=$o bytes=$b marked=$wm md5=$im"

  section "J. api log window $B25PHYS_POSTDELETE_WINDOW_START..now (sanitized; the operator deletion and the purge)"
  local W1="$B25PHYS_POSTDELETE_WINDOW_START" W2 win; W2="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if ! win="$(docker logs --since "$W1" --until "$W2" "$API_CID" 2>&1)"; then echo "  api window log read FAILED"; win=""; fi
  echo "  lines=$(printf '%s\n' "$win" | grep -c . || true) level50=$(printf '%s\n' "$win" | grep -c '"level":50' || true) status5xx=$(printf '%s\n' "$win" | grep -cE '"statusCode":5[0-9]{2}' || true)"
  echo "  -- company deletion requests (method DELETE on /api/companies/<n>; max 10):"; printf '%s\n' "$win" | grep -E '"method":"DELETE"' | grep -E '"url":"/api/companies/[0-9]+' | awk 'NR<=10' | jsum | sed 's/^/    /' || true
  echo "  -- storage / purge lines (max 20):"; printf '%s\n' "$win" | grep -iE 'purge|tombstone|storage' | grep -vE '"url":"/api/(healthz|readyz)' | awk 'NR<=20' | jsum | sed 's/^/    /' || true
  echo "  -- lines mentioning the uuid (max 10):"; printf '%s\n' "$win" | grep -F "$U" | awk 'NR<=10' | jsum | sed 's/^/    /' || true
  echo "  -- level>=50 lines (max 20):"; printf '%s\n' "$win" | grep -E '"level":(50|60)' | awk 'NR<=20' | jsum | sed 's/^/    /' || true
  echo "  -- uncertainty / dead-job / storage error lines (max 10):"; printf '%s\n' "$win" | grep -iE 'uncertain|dead|STORAGE_UNAVAILABLE|DELETE_RETRY|OWNERSHIP_UNPROVEN' | awk 'NR<=10' | jsum | sed 's/^/    /' || true
  pass "log window read (status5xx=$(printf '%s\n' "$win" | grep -cE '"statusCode":5[0-9]{2}' || true))"

  section "K. post-delete prerequisites (read-only decision; nothing is changed by this phase)"
  local verdict; if verdict="$(printf '%s' "$facts" | b25phys_postdelete_eligibility)"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "b25phys post-delete eligibility evaluator failed — the lines above are the verdict (read-only; nothing changed)"; fi
  rm -f "$HOME"/.b25-s1-node.err
  echo "FACTS: $(printf '%s' "$facts" | tr '\n' ' ')"
  printf '%s\n' "$verdict" | grep -qx 'B25_POSTDELETE_PROVIDER_SETTLEMENT_ELIGIBLE=TRUE' || fail "b25phys-postdelete-verify: $(printf '%s\n' "$verdict" | grep -oE '^B25PHYS_POSTDELETE_CONDITIONS_FAILED=[0-9]+$') — the tombstone is not in the expected state (read-only; nothing changed)"
  log "b25phys-postdelete-verify complete (read-only; nothing changed; B25_POSTDELETE_PROVIDER_SETTLEMENT_ELIGIBLE=TRUE)"
}

# =============================================================================
# B25 STAGE 2A — FILESYSTEM PRIMARY ACTIVATION TOOLING (ops/b25-stage2a-fs-activation-tooling)
# The product commit is e559b002 (locked in apply-lib: STAGE2A_PRODUCT_SHA); the Stage 1 phases
# above are pinned to 72a2437 and are refused by the workflow before any SSH session.
#   stage2a-precheck          READ-ONLY: 30 pre-switch prerequisites → B25_STAGE2A_PRECHECK_ELIGIBLE
#   stage2a-postswitch-verify READ-ONLY: 22 post-switch prerequisites → B25_STAGE2A_POSTSWITCH_READY
#   stage2a-state             READ-ONLY report (always-step after a mutation mode; never fails)
#   stage2a-activate          MUTATION: precheck TRUE in this session → owner-staged key line present
#                             (shape counted, value never read) → managed-lines record → the FIVE
#                             locked variables rendered into the env file (nothing else changes) →
#                             api recreated (same image / commit) → healthy → post-switch verify TRUE;
#                             any failure before the smoke → rollback (DRIVER=gcs explicit) → api
#                             recreated → bucket primary healthy again → exit 1. Never touches
#                             postgres / web / volumes; never deletes an object anywhere.
#   stage2a-rollback          MUTATION: the explicit rollback (same env rendering, api recreate,
#                             bucket primary healthy, fs files and bucket objects untouched).
#   stage2a-smoke-setup / stage2a-smoke-verify / stage2a-recreate-api / stage2a-smoke-settle /
#   stage2a-cleanup           the disposable fs + strict-mirror smoke (Stage 1 architecture): one
#                             object-holding disposable tenant + one object-less foreign tenant,
#                             first-party upload / download, encrypted file + mirror proofs, api
#                             recreate persistence proof, tenant deletion through the product API,
#                             purge job, absence proofs, exact tombstone removal, census and
#                             filesystem back to the pre-smoke state; the Stage 1 exception
#                             (f048b5d4…, company 53) is denied by constant everywhere.
# No phase here reads, renders, compares or prints OBJECT_STORAGE_ENCRYPTION_KEY: the owner stages
# the line in the VPS env file (mode 600) through the existing secret mechanism; the tooling counts
# its presence with grep -c and leaves the line untouched in both directions.
# No migration wrapper (Stage 2B) and no GCS retirement exists here.
# =============================================================================
STAGE2A_LOCK_FILE="$HOME/.b25-stage2a-activation.lock"
# Non-secret record written by stage2a-activate BEFORE its first edit: the digest of the env file's
# unmanaged, key-stripped content and the managed storage lines as they were. Read by the verifiers.
STAGE2A_ENV_RECORD="$STATE_DIR/.b25-stage2a-env-record"
STAGE2A_MANAGED_RE='^OBJECT_STORAGE_(DRIVER|FS_ROOT|LEGACY_FALLBACK|MIRROR|LEGACY_DELETE)='
STAGE2A_KEY_RE='^OBJECT_STORAGE_ENCRYPTION_KEY='
STAGE2A_INIT_FS='"driver":"fs","legacyFallback":true,"mirror":true,"legacyDelete":false'
STAGE2A_INIT_GCS='"driver":"gcs","legacyFallback":false,"mirror":false,"legacyDelete":false'

# ---- small readers (facts only; nothing is ever printed from the env file or the container env) ----
stage2a_env_core_sha() {   # sha256/16 of the env file WITHOUT the managed storage lines and WITHOUT the key line
  grep -vE "$STAGE2A_MANAGED_RE|$STAGE2A_KEY_RE" "$ENV_FILE" | sha256sum | cut -c1-16
}
stage2a_env_strict_sha() { # sha256/16 of the env file WITHOUT the key line only (the accepted Stage 1 file + the staged key)
  grep -vE "$STAGE2A_KEY_RE" "$ENV_FILE" | sha256sum | cut -c1-16
}
stage2a_key_lines() { grep -c "$STAGE2A_KEY_RE" "$ENV_FILE" || true; }
stage2a_key_shape_lines() { grep -cE "$STAGE2A_KEY_LINE_SHAPE" "$ENV_FILE" || true; }
stage2a_record_core() { [ -f "$STAGE2A_ENV_RECORD" ] && sed -nE 's/^core_sha256_16=([0-9a-f]{16})$/\1/p' "$STAGE2A_ENV_RECORD" | head -1 || true; }
# env_core_identity_ok: with a record → the current core equals the recorded core; without → the strict
# Stage 1 identity (file minus the staged key line = the accepted file).
stage2a_env_core_identity() {
  local rec cur; rec="$(stage2a_record_core)"
  if [ -n "$rec" ]; then cur="$(stage2a_env_core_sha)"; [ "$cur" = "$rec" ] && echo true || echo false
  else [ "$(stage2a_env_strict_sha)" = "$ENV_SHA_PREFIX" ] && echo true || echo false; fi
}
stage2a_readyz_facts() {
  local rz; rz="$(curl -sS --max-time 5 http://127.0.0.1:18080/api/readyz 2>/dev/null || echo "")"
  echo "readyz_status=$(printf '%s' "$rz" | sed -nE 's/.*"status":"([a-z_]+)".*/\1/p')"
  echo "readyz_database=$(printf '%s' "$rz" | sed -nE 's/.*"database":"([a-z_]+)".*/\1/p')"
  echo "readyz_storage=$(printf '%s' "$rz" | sed -nE 's/.*"storage":"([a-z_]+)".*/\1/p')"
  echo "readyz_inside=$(compose exec -T api node -e 'fetch("http://127.0.0.1:8080/api/readyz").then(async (r) => { const j = await r.json(); console.log(j && j.status === "ok" && j.checks && j.checks.database === "ok" && j.checks.storage === "ok" ? "ok" : "not-ok"); }).catch(() => console.log("unavailable"))' 2>/dev/null || echo unavailable)"
}
stage2a_container_facts() {
  local cid="$1"
  echo "api_running=$([ -n "$cid" ] && [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" = "true" ] && echo true || echo false)"
  echo "api_health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo unavailable)"
  echo "web_running=$([ "$(docker inspect -f '{{.State.Running}}' "$WEB_CID" 2>/dev/null)" = "true" ] && echo true || echo false)"
  echo "web_health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$WEB_CID" 2>/dev/null || echo unavailable)"
  echo "pg_running=$([ "$(docker inspect -f '{{.State.Running}}' "$PG_CID" 2>/dev/null)" = "true" ] && echo true || echo false)"
  echo "pg_health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$PG_CID" 2>/dev/null || echo unavailable)"
}
# The LAST "Object storage initialized" record of the container's log (one per process start) and the entrypoint banner.
# ---- B25 STAGE 2A — CORRECTION 8: exact attribution of the api process' error-level log records ----------------
# Runs INSIDE the api container (api_node_stdin): the docker log text of the current process arrives on stdin, every
# line is parsed as structured JSON, and ONLY counts / booleans come back. The only records that may be classified as
# expected are the cleanup 404 probes of the constant smoke run (arg: companies, window, expected): msg "Unhandled
# request error", err.type AppError (or esbuild's renamed _AppError of the same class), err.statusCode 404, err.message
# "Company not found", req.method GET, req.url exactly /api/companies/<constant id>, time inside the constant window,
# a request id, and exactly ONE request-completion record (same request id, same method and url, res.statusCode 404,
# level below 50) inside the window — each company at most once. Everything else at level 50 is unclassified (reported
# by sanitized class), every level-60 record is fatal, every unparsable line that looks like a record is malformed,
# every duplicated record is a duplicate; nothing is subtracted; no record text is printed.
STAGE2A_LOG_CLASSIFY_JS=$(cat <<'JS'
const fs = require("node:fs");
const a = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "{}");
const txt = fs.readFileSync(0, "utf8");
const from = Date.parse(String(a.from || "")), to = Date.parse(String(a.to || ""));
const prefix = String(a.route_prefix || "/api/companies/");
const want = new Map(); for (const c of (a.companies || [])) { const id = String(c); if (/^[1-9][0-9]*$/.test(id)) want.set(id, { url: prefix + id, hits: 0 }); }
const out = { read_ok: false, records_total: 0, json_records: 0, nonjson_lines: 0, malformed_records: 0, level50_total: 0, level60: 0, status5xx: 0,
  expected_smoke_cleanup_404: 0, unclassified_level50: 0, unclassified_storage: 0, unclassified_auth: 0, unclassified_client: 0, unclassified_server: 0, unclassified_other: 0,
  duplicate_records: 0, completion_records: 0, window_ok: Number.isFinite(from) && Number.isFinite(to) && from < to, c8_both_attributed: false };
for (const id of want.keys()) out["c8_company_" + id] = false;
const recs = [];
for (const raw of txt.split(/\r?\n/)) {
  const line = raw.trim(); if (line === "") continue; out.records_total += 1;
  let rec = null;
  if (line.startsWith("{")) { try { rec = JSON.parse(line); } catch { rec = null; } }
  if (rec === null) { if (line.startsWith("{") || line.includes('"level":')) out.malformed_records += 1; else out.nonjson_lines += 1; continue; }
  if (typeof rec !== "object" || Array.isArray(rec) || typeof rec.level !== "number" || typeof rec.time !== "number") { out.malformed_records += 1; continue; }
  out.json_records += 1; recs.push(rec);
}
out.read_ok = out.json_records > 0;
const sc = (x) => (x && typeof x === "object" && typeof x.statusCode === "number") ? x.statusCode : null;
const completions = new Map();   // request id → completion records (level < 50, a res.statusCode, a request id)
for (const r of recs) {
  const rs = sc(r.res), es = sc(r.err);
  if ((rs !== null && rs >= 500) || (es !== null && es >= 500)) out.status5xx += 1;
  if (r.level < 50 && r.req && typeof r.req === "object" && r.req.id !== undefined && r.req.id !== null && rs !== null) {
    const k = String(r.req.id); if (!completions.has(k)) completions.set(k, []); completions.get(k).push(r); out.completion_records += 1;
  }
}
const seenErr = new Set();
const inWindow = (t) => out.window_ok && t >= from && t <= to;
for (const r of recs) {
  if (r.level >= 60) { out.level60 += 1; continue; }
  if (r.level < 50) continue;
  out.level50_total += 1;
  const es = sc(r.err); const req = (r.req && typeof r.req === "object") ? r.req : null;
  const rid = req && req.id !== undefined && req.id !== null ? String(req.id) : null;
  let expected = false;
  if (r.msg === "Unhandled request error" && r.err && typeof r.err === "object" && (r.err.type === "AppError" || r.err.type === "_AppError") && es === 404
      && r.err.message === "Company not found" && req && req.method === "GET" && typeof req.url === "string" && rid !== null && inWindow(r.time)) {
    for (const [id, w] of want) {
      if (req.url !== w.url) continue;
      const sig = rid + "|" + req.url;
      if (seenErr.has(sig)) { out.duplicate_records += 1; break; }
      const cs = (completions.get(rid) || []).filter((c) => c.req && c.req.method === "GET" && c.req.url === w.url && sc(c.res) === 404 && inWindow(c.time));
      if (cs.length === 1 && w.hits === 0) { w.hits = 1; seenErr.add(sig); expected = true; out["c8_company_" + id] = true; }
      break;
    }
  }
  if (expected) { out.expected_smoke_cleanup_404 += 1; continue; }
  out.unclassified_level50 += 1;
  if (r.msg === "Unhandled storage error") out.unclassified_storage += 1;
  else if (es === 401 || es === 403) out.unclassified_auth += 1;
  else if (es !== null && es >= 400 && es < 500) out.unclassified_client += 1;
  else if (es !== null && es >= 500) out.unclassified_server += 1;
  else out.unclassified_other += 1;
}
out.c8_both_attributed = want.size > 0 && [...want.values()].every((w) => w.hits === 1);
console.log(JSON.stringify(out));
JS
)
stage2a_log_classify_facts() {   # <api log text> → Correction 8 facts (classified inside the api container; counts and booleans only)
  local arg cj k
  arg="$(printf '{"companies":[%s],"from":"%s","to":"%s","expected":%s,"route_prefix":"%s"}' "$S2A_C8_COMPANIES" "$S2A_C8_WINDOW_FROM" "$S2A_C8_WINDOW_TO" "$S2A_C8_EXPECTED" "$S2A_C8_ROUTE_PREFIX" | base64 -w0)"
  cj="$(printf '%s\n' "$1" | api_node_stdin "$STAGE2A_LOG_CLASSIFY_JS" "$arg")"
  if ! [[ "$cj" == \{* ]]; then echo "log_read_ok=false"; echo "log_classifier=unavailable"; return 0; fi
  for k in records_total json_records nonjson_lines malformed_records level50_total level60 status5xx expected_smoke_cleanup_404 unclassified_level50 unclassified_storage unclassified_auth unclassified_client unclassified_server unclassified_other duplicate_records completion_records; do
    echo "log_$k=$(census_field "$cj" "$k" count 2>/dev/null || echo '?')"
  done
  for k in read_ok window_ok c8_both_attributed "c8_company_${S2A_C8_COMPANIES%%,*}" "c8_company_${S2A_C8_COMPANIES##*,}"; do
    echo "log_$k=$(json_flat_field "$cj" "$k" 2>/dev/null | grep -xE 'true|false' || echo '?')"
  done
}
stage2a_init_facts() {
  local body rec n
  body="$(docker logs "$1" 2>&1 || true)"
  n="$(printf '%s\n' "$body" | grep -c '"msg":"Object storage initialized"' || true)"; echo "init_records_current=$n"
  rec="$(printf '%s\n' "$body" | grep '"msg":"Object storage initialized"' | tail -1 || true)"
  if [ -n "$rec" ]; then echo "init_record_found=true"; else echo "init_record_found=false"; fi
  echo "init_driver=$(printf '%s' "$rec" | sed -nE 's/.*"driver":"([a-z]+)".*/\1/p')"
  echo "init_fallback=$(printf '%s' "$rec" | sed -nE 's/.*"legacyFallback":(true|false).*/\1/p')"
  echo "init_mirror=$(printf '%s' "$rec" | sed -nE 's/.*"mirror":(true|false).*/\1/p')"
  echo "init_legacy_delete=$(printf '%s' "$rec" | sed -nE 's/.*"legacyDelete":(true|false).*/\1/p')"
  echo "init_encryption=$(printf '%s' "$rec" | sed -nE 's/.*"encryption":"([a-z/-]+)".*/\1/p')"
  echo "log_refusals=$(printf '%s\n' "$body" | grep -c 'Object storage initialization failed' || true)"
  echo "log_init_failures=$(printf '%s\n' "$body" | grep -c 'Object storage initialization failed' || true)"
  echo "log_mirror_failures=$(printf '%s\n' "$body" | grep -c 'strict mirror write failed' || true)"
  echo "log_integrity_failures=$(printf '%s\n' "$body" | grep -c 'copy failed integrity verification' || true)"
  echo "log_level50=$(printf '%s\n' "$body" | grep -c '"level":50' || true)"
  # Correction 8: parsed classification of the error-level records (the raw count above must equal the parsed total)
  stage2a_log_classify_facts "$body"
  echo "banner_driver=$(printf '%s\n' "$body" | grep -oE '^\[entrypoint\]\s+OBJECT_STORAGE_DRIVER=[^ ]+' | tail -1 | sed -E 's/.*=//')"
  echo "banner_root_set=$(printf '%s\n' "$body" | grep -E '^\[entrypoint\]\s+OBJECT_STORAGE_FS_ROOT=' | tail -1 | grep -q '=(set)' && echo true || echo false)"
  echo "banner_root_not_set=$(printf '%s\n' "$body" | grep -E '^\[entrypoint\]\s+OBJECT_STORAGE_FS_ROOT=' | tail -1 | grep -q '=(not set)' && echo true || echo false)"
  echo "banner_key_set=$(printf '%s\n' "$body" | grep -E '^\[entrypoint\]\s+OBJECT_STORAGE_ENCRYPTION_KEY=' | tail -1 | grep -q '=(set)' && echo true || echo false)"
  echo "banner_fallback=$(printf '%s\n' "$body" | grep -oE '^\[entrypoint\]\s+OBJECT_STORAGE_LEGACY_FALLBACK=[a-z]+' | tail -1 | sed -E 's/.*=//')"
  echo "banner_mirror=$(printf '%s\n' "$body" | grep -oE 'OBJECT_STORAGE_MIRROR=[a-z]+' | tail -1 | sed -E 's/.*=//')"
  # leak gate (counts only): the root path literal, key-shaped 64-hex tokens, a key ASSIGNMENT with a value, bucket references, signed-URL text
  echo "leak_root_path=$(printf '%s\n' "$body" | grep -c -F -- "$STAGE2A_FS_ROOT" || true)"
  echo "leak_key_shaped=$(printf '%s\n' "$body" | grep -cE '[^0-9a-f][0-9a-f]{64}([^0-9a-f]|$)' || true)"
  echo "leak_key_assignment=$(printf '%s\n' "$body" | grep -E 'OBJECT_STORAGE_ENCRYPTION_KEY=' | grep -vcE 'OBJECT_STORAGE_ENCRYPTION_KEY=\((not )?set\)' || true)"
  echo "leak_bucket_ref=$(printf '%s\n' "$body" | grep -c -F 'gs://' || true)"
  echo "leak_signature=$(printf '%s\n' "$body" | grep -c -F 'X-Goog-Signature' || true)"
}
stage2a_web_leak_facts() {
  local wb; wb="$(docker logs "$WEB_CID" 2>&1 || true)"
  echo "web_leak_root_path=$(printf '%s\n' "$wb" | grep -c -F -- "$STAGE2A_FS_ROOT" || true)"
  echo "web_leak_signature=$(printf '%s\n' "$wb" | grep -c -F 'X-Goog-Signature' || true)"
}
# Fixed-value comparisons INSIDE the api container (nothing of the environment leaves it; the key is only tested for presence).
stage2a_container_env_facts() {
  compose exec -T api sh -s <<'SH'
n=0; for k in OBJECT_STORAGE_DRIVER OBJECT_STORAGE_FS_ROOT OBJECT_STORAGE_LEGACY_FALLBACK OBJECT_STORAGE_MIRROR OBJECT_STORAGE_LEGACY_DELETE; do eval v="\${$k:-}"; [ -z "$v" ] || n=$((n + 1)); done; echo "env_names_set=$n"
[ "${OBJECT_STORAGE_DRIVER:-}" = "fs" ] && echo env_driver_is_fs=true || echo env_driver_is_fs=false
[ "${OBJECT_STORAGE_FS_ROOT:-}" = "/data/objects" ] && echo env_root_is_locked=true || echo env_root_is_locked=false
[ "${OBJECT_STORAGE_LEGACY_FALLBACK:-}" = "true" ] && echo env_fallback_is_true=true || echo env_fallback_is_true=false
[ "${OBJECT_STORAGE_MIRROR:-}" = "gcs" ] && echo env_mirror_is_gcs=true || echo env_mirror_is_gcs=false
case "${OBJECT_STORAGE_LEGACY_DELETE:-}" in ""|false) echo env_legacy_delete_off=true ;; *) echo env_legacy_delete_off=false ;; esac
[ -n "${OBJECT_STORAGE_ENCRYPTION_KEY:-}" ] && echo env_key_set=true || echo env_key_set=false
SH
}
# Root facts INSIDE the api container (the locked root; names of entries never printed).
stage2a_root_facts() {
  echo "volume_exists=$(docker volume inspect "$STAGE2A_VOLUME" >/dev/null 2>&1 && echo true || echo false)"
  echo "volume_driver=$(docker volume inspect -f '{{.Driver}}' "$STAGE2A_VOLUME" 2>/dev/null || echo unavailable)"
  local m; m="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data/objects"}}{{.Type}}|{{.Name}}|{{.RW}}{{end}}{{end}}' "$1" 2>/dev/null || true)"
  echo "mount_type=${m%%|*}"; m="${m#*|}"; echo "mount_name=${m%%|*}"; echo "mount_rw=${m#*|}"
  compose exec -T api sh -s <<'SH'
R=/data/objects
if [ -L "$R" ]; then echo root_is_symlink=true; else echo root_is_symlink=false; fi
if [ -d "$R" ]; then echo root_is_dir=true; else echo root_is_dir=false; fi
echo "root_owner=$(stat -c %u:%g "$R" 2>/dev/null || echo unavailable)"
echo "root_mode=$(stat -c %a "$R" 2>/dev/null || echo unavailable)"
if [ -w "$R" ]; then echo root_writable=true; else echo root_writable=false; fi
echo "root_regular_files=$(find "$R" -type f 2>/dev/null | wc -l)"
echo "root_tenant_files=$(find "$R/tenants" -type f 2>/dev/null | wc -l)"
echo "root_health_files=$(find "$R/health" -type f 2>/dev/null | wc -l)"
echo "root_symlinks=$(find "$R" -type l 2>/dev/null | wc -l)"
bad=0; for e in $(ls -A "$R" 2>/dev/null); do case "$e" in health|tenants) ;; *) bad=$((bad + 1)) ;; esac; done; echo "root_other_entries=$bad"
SH
}
stage2a_root_entries_allowed() {   # <facts text> → true when no symlink and no entry outside health / tenants
  local s o; s="$(printf '%s\n' "$1" | sed -nE 's/^root_symlinks=([0-9]+)$/\1/p')"; o="$(printf '%s\n' "$1" | sed -nE 's/^root_other_entries=([0-9]+)$/\1/p')"
  [ "$s" = "0" ] && [ "$o" = "0" ] && echo true || echo false
}
# Stage 1 exception + inventory + census + originals: shared by precheck and post-switch verify (reads only).
stage2a_exception_facts() {
  local U="$B25PHYS_UUID" C="$B25PHYS_COMPANY"
  echo "exc_row_count=$(q "select count(*) from storage_objects where id = '$U'")"
  echo "exc_state=$(q "select coalesce((select state from storage_objects where id = '$U'), '<absent>')")"
  echo "exc_last_error=$(q "select coalesce((select coalesce(last_error, '<null>') from storage_objects where id = '$U'), '<absent>')")"
  echo "exc_driver=$(q "select coalesce((select driver from storage_objects where id = '$U'), '<absent>')")"
  echo "exc_company=$(q "select coalesce((select company_id::text from storage_objects where id = '$U'), '<absent>')")"
  echo "exc_kind=$(q "select coalesce((select kind from storage_objects where id = '$U'), '<absent>')")"
  echo "exc_size=$(q "select coalesce((select size_bytes::text from storage_objects where id = '$U'), '<absent>')")"
  echo "exc_identity_ok=$(q "select coalesce((select (company_id = $C and kind = 'document' and driver = 'gcs' and reference = '/objects/' || id::text and storage_key = 'tenants/' || company_id || '/documents/' || id::text and coalesce(legacy_key = 'gs://' || split_part(split_part(legacy_key, '://', 2), '/', 1) || '/' || storage_key, false) and size_bytes = $B25PHYS_OBJECT_SIZE and deleted_at is not null)::text from storage_objects where id = '$U'), 'false')")"
  echo "exc_uncertain=$(q "select coalesce((select (publication_uncertain_at is not null)::text from storage_objects where id = '$U'), '<absent>')")"
  echo "exc_lease=$(q "select coalesce((select (lease_token is not null or lease_expires_at is not null)::text from storage_objects where id = '$U'), '<absent>')")"
  echo "exc_mirror=$(q "select coalesce((select (mirror_key is not null or mirror_state is not null)::text from storage_objects where id = '$U'), '<absent>')")"
  echo "exc_live_refs=$(q "select (select count(*) from document_versions where object_path = '/objects/$U') + (select count(*) from export_runs where object_path = '/objects/$U') + (select count(*) from executive_reports where object_path = '/objects/$U') + (select count(*) from scans where image_url = '/objects/$U') + (select count(*) from storage_objects where id <> '$U' and (reference like '%$U%' or storage_key like '%$U%' or coalesce(legacy_key,'') like '%$U%' or coalesce(mirror_key,'') like '%$U%'))")"
  echo "exc_company_absent=$(q "select ((select count(*) from companies where id = $C) = 0)::text")"
  local row_b64 gj present
  row_b64="$(q "select coalesce((select json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 's', size_bytes) from storage_objects where id = '$U'), '{}'::json)" | base64 -w0)"
  gj="$(api_node "$B25PHYS_GEN_JS" "$row_b64")"; echo "  provider: $gj" >&2
  present="$(json_bool "$gj" present 2>/dev/null || echo false)"; echo "exc_provider_present=$present"
  if [ "$present" = "true" ]; then
    echo "exc_provider_marker_ok=$(json_bool "$gj" marker_matches_row 2>/dev/null || echo false)"
    echo "exc_provider_size_matches=$(json_bool "$gj" size_matches 2>/dev/null || echo false)"
    echo "exc_generation_canonical=$(json_bool "$gj" generation_canonical 2>/dev/null || echo false)"
    echo "exc_generation_stable=$(json_bool "$gj" generation_stable 2>/dev/null || echo false)"
    echo "exc_generation_digest=$(json_flat_field "$gj" generation_sha256_16 2>/dev/null | tr -d '"' || echo none)"
  else
    echo "exc_provider_marker_ok=false"; echo "exc_provider_size_matches=false"; echo "exc_generation_canonical=false"; echo "exc_generation_stable=false"; echo "exc_generation_digest=none"
  fi
  echo "inv_uncertain=$(q "select count(*) from storage_objects where publication_uncertain_at is not null")"
  echo "inv_unproven=$(q "select count(*) from storage_objects where last_error = 'OWNERSHIP_UNPROVEN'")"
  echo "inv_cleanup_pending=$(q "select count(*) from storage_objects where last_error = 'CLEANUP_PENDING'")"
  echo "inv_leases=$(q "select count(*) from storage_objects where lease_token is not null or lease_expires_at is not null")"
  echo "inv_inflight=$(q "select count(*) from storage_objects where state in ('pending','uploading','staged','deleting')")"
  echo "inv_total=$(q "select count(*) from storage_objects")"
  echo "inv_active=$(q "select count(*) from storage_objects where state = 'active'")"
  echo "inv_retained_legacy=$(q "select count(*) from storage_objects where state = 'deleted' and last_error = 'LEGACY_RETAINED' and legacy_key is not null")"
  local cj; cj="$(census)"; echo "  census: $cj" >&2
  echo "census_objects=$(census_field "$cj" objects count 2>/dev/null || echo "?")"
  echo "census_bytes=$(census_field "$cj" bytes count 2>/dev/null || echo "?")"
  echo "census_marked=$(census_field "$cj" with_marker count 2>/dev/null || echo "?")"
  echo "census_md5=$(census_field "$cj" inventory_md5 hex32 2>/dev/null || echo "?")"
  echo "census_generationless=$(census_field "$cj" generationless count 2>/dev/null || echo "?")"
  local ej; ej="$(api_node "$RESIDUE_ELIG_JS" "$row_b64")"; echo "  listing: $ej" >&2
  echo "unmarked_objects=$(census_field "$ej" unmarked_objects count 2>/dev/null || echo "?")"
  echo "unmarked_md5=$(census_field "$ej" unmarked_md5 hex32 2>/dev/null || echo "?")"
  echo "refs_count=$(references)"
  local rj; rj="$(api_node "$DIAG_RECON_JS" "$(q "select coalesce(json_agg(json_build_object('r', object_path, 's', file_size)), '[]'::json) from export_runs where object_path ~ '$LEGACY_HANDLE'" | base64 -w0)")"; echo "  originals: $rj" >&2
  echo "originals_referenced=$(census_field "$rj" referenced count 2>/dev/null || echo "?")"
  echo "originals_present=$(census_field "$rj" present count 2>/dev/null || echo "?")"
  echo "originals_missing=$(census_field "$rj" missing count 2>/dev/null || echo "?")"
  echo "originals_size_match=$(census_field "$rj" size_match count 2>/dev/null || echo "?")"
}
stage2a_host_facts() {
  echo "head_sha=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo unavailable)"
  echo "current_deploy_sha=$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null || echo none)"
  echo "previous_deploy_sha=$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null || echo none)"
  echo "dirty=$(git -C "$APP_DIR" status --porcelain 2>/dev/null | wc -l)"
  echo "worktrees=$(git -C "$APP_DIR" worktree list 2>/dev/null | wc -l)"
  echo "lock_absent=$([ ! -e "$LOCK_FILE" ] && [ ! -e "$STAGE2A_LOCK_FILE" ] && echo true || echo false)"
  echo "deploy_settled=$([ "$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null)" = "$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null)" ] && echo true || echo false)"
  echo "stale_worktree_absent=$([ ! -e "$WT_ROOT" ] && echo true || echo false)"
  echo "stale_image_absent=$(docker image inspect "$IMAGE" >/dev/null 2>&1 && echo false || echo true)"
  echo "leftover_files=$(ls "$HOME" 2>/dev/null | grep -c '^b25-' || true)"
  echo "storage_jobs_active=$(q "select count(*) from job_queue where status in ('pending','running') and name like 'storage.%'")"
  echo "dead_storage_jobs=$(q "select count(*) from job_queue where status = 'dead' and name like 'storage.%'")"
  echo "dead_jobs_total=$(q "select count(*) from job_queue where status = 'dead'")"
  echo "schema_fingerprint=$(fingerprint)"
  echo "env_mode=$(stat -c %a "$ENV_FILE" 2>/dev/null || echo unavailable)"
  echo "key_line_count=$(stage2a_key_lines)"
  echo "env_core_identity_ok=$(stage2a_env_core_identity)"
  echo "disk_avail_bytes=$(capacity "bytes available on /" -B1 --output=avail / 2>/dev/null || echo unavailable)"
  echo "inodes_free=$(capacity "inodes available on /" --output=iavail / 2>/dev/null || echo unavailable)"
}
stage2a_readonly_guard() { if q "create temp table b25_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard FAILED (a write succeeded in a q session)"; else echo "read-only guard: session refuses writes OK"; fi; }

# ---- stage2a_precheck_run: gathers every fact, prints the 30 prerequisites, returns 0 only on TRUE ----
stage2a_precheck_run() {
  declare -f stage2a_precheck_eligibility >/dev/null || fail "apply library not loaded (stream b25-stage1-apply-lib.sh before this script)"
  local facts="" rf
  section "0. read-only guard"; stage2a_readonly_guard
  section "1. host / deployment / containers / readiness"
  facts+="$(stage2a_host_facts)"$'\n'; facts+="$(stage2a_container_facts "$API_CID")"$'\n'; facts+="$(stage2a_readyz_facts)"$'\n'
  printf '%s\n' "$facts" | grep -E '^(head_sha|current_deploy_sha|previous_deploy_sha|dirty|worktrees|api_health|web_health|pg_health|readyz_status|readyz_database|readyz_storage|lock_absent|deploy_settled|storage_jobs_active|dead_storage_jobs|schema_fingerprint|env_mode|key_line_count|env_core_identity_ok|disk_avail_bytes|inodes_free)=' | sed 's/^/  /'
  section "2. storage runtime configuration (startup record, banner, container environment — names and fixed values only)"
  facts+="$(stage2a_init_facts "$API_CID")"$'\n'; facts+="$(stage2a_container_env_facts)"$'\n'
  printf '%s\n' "$facts" | grep -E '^(init_record_found|init_driver|init_fallback|init_mirror|init_legacy_delete|init_encryption|banner_driver|banner_root_not_set|env_names_set)=' | sed 's/^/  /'
  section "3. the named volume $STAGE2A_VOLUME at $STAGE2A_FS_ROOT (no write test)"
  rf="$(stage2a_root_facts "$API_CID")"; facts+="$rf"$'\n'; facts+="root_entries_allowed=$(stage2a_root_entries_allowed "$rf")"$'\n'
  printf '%s\n' "$rf" | sed 's/^/  /'
  section "4. Stage 1 exception, inventory, census, originals (read-only)"
  facts+="$(stage2a_exception_facts)"$'\n'
  printf '%s\n' "$facts" | grep -E '^(exc_|inv_|census_|unmarked_|refs_count|originals_)' | sed 's/^/  /'
  section "5. pre-switch prerequisites (read-only decision; nothing is changed)"
  local verdict; if verdict="$(printf '%s' "$facts" | stage2a_precheck_eligibility)"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "pre-switch eligibility evaluator failed — the lines above are the verdict (read-only; nothing changed)"; fi
  rm -f "$HOME"/.b25-s1-node.err
  printf '%s\n' "$verdict" | grep -qx 'B25_STAGE2A_PRECHECK_ELIGIBLE=TRUE'
}
phase_stage2a_precheck() {
  if stage2a_precheck_run; then log "stage2a-precheck complete (read-only; nothing changed; B25_STAGE2A_PRECHECK_ELIGIBLE=TRUE)"
  else fail "stage2a-precheck: prerequisites not met (read-only; nothing changed; B25_STAGE2A_PRECHECK_ELIGIBLE=FALSE)"; fi
}

# ---- stage2a_postswitch_run: gathers every fact, prints the 22 prerequisites, returns 0 only on TRUE ----
stage2a_postswitch_run() {
  declare -f stage2a_postswitch_eligibility >/dev/null || fail "apply library not loaded (stream b25-stage1-apply-lib.sh before this script)"
  local facts="" rf cid; cid="$(compose ps -q api || true)"
  section "0. read-only guard"; stage2a_readonly_guard
  section "1. host / containers / readiness"
  facts+="$(stage2a_host_facts)"$'\n'; facts+="$(stage2a_container_facts "$cid")"$'\n'; facts+="$(stage2a_readyz_facts)"$'\n'
  printf '%s\n' "$facts" | grep -E '^(head_sha|current_deploy_sha|dirty|api_running|api_health|web_health|pg_health|readyz_status|readyz_database|readyz_storage|readyz_inside|env_mode|key_line_count|env_core_identity_ok)=' | sed 's/^/  /'
  section "2. storage runtime configuration after the switch (startup record, banner, container environment; values never printed)"
  facts+="$(stage2a_init_facts "$cid")"$'\n'; facts+="$(stage2a_container_env_facts)"$'\n'; facts+="$(stage2a_web_leak_facts)"$'\n'
  local mg; mg="$(stage2a_env_managed_of activate < "$ENV_FILE" | sha256sum | cut -c1-64)"
  facts+="env_file_managed_ok=$([ "$mg" = "$(stage2a_env_lines activate | sha256sum | cut -c1-64)" ] && echo true || echo false)"$'\n'
  facts+="env_file_key_lines=$(stage2a_key_lines)"$'\n'
  printf '%s\n' "$facts" | grep -E '^(init_|banner_|env_|log_|leak_|web_leak_)' | sed 's/^/  /'
  section "3. the named volume after the switch"
  rf="$(stage2a_root_facts "$cid")"; facts+="$rf"$'\n'; facts+="root_entries_allowed=$(stage2a_root_entries_allowed "$rf")"$'\n'
  printf '%s\n' "$rf" | sed 's/^/  /'
  section "4. Stage 1 exception, protected live inventory, census, originals (unchanged by the switch; Correction 5)"
  facts+="$(stage2a_protected_facts)"$'\n'
  printf '%s\n' "$facts" | grep -E '^(protected_|tenant_keys_md5|pf_|pm_|exc_|inv_|census_|unmarked_|refs_count|refs_legacy_count|originals_)' | sed 's/^/  /'
  section "5. post-switch prerequisites (read-only decision; nothing is changed)"
  local verdict; if verdict="$(printf '%s' "$facts" | stage2a_postswitch_eligibility)"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "post-switch eligibility evaluator failed — the lines above are the verdict (read-only; nothing changed)"; fi
  rm -f "$HOME"/.b25-s1-node.err
  printf '%s\n' "$verdict" | grep -qx 'B25_STAGE2A_POSTSWITCH_READY=TRUE'
}
phase_stage2a_postswitch_verify() {
  if stage2a_postswitch_run; then log "stage2a-postswitch-verify complete (read-only; nothing changed; B25_STAGE2A_POSTSWITCH_READY=TRUE)"
  else fail "stage2a-postswitch-verify: prerequisites not met (read-only; nothing changed; B25_STAGE2A_POSTSWITCH_READY=FALSE)"; fi
}

# ---- stage2a-state: read-only report for the always-steps (never fails) ----
phase_stage2a_state() {
  local cid; cid="$(compose ps -q api || true)"
  section "stage2a-state (read-only report)"
  stage2a_host_facts | grep -E '^(head_sha|current_deploy_sha|dirty|lock_absent|env_mode|key_line_count|env_core_identity_ok)=' | sed 's/^/  /' || true
  stage2a_container_facts "$cid" | sed 's/^/  /' || true
  stage2a_readyz_facts | sed 's/^/  /' || true
  stage2a_init_facts "$cid" | grep -E '^(init_|banner_|log_)' | sed 's/^/  /' || true
  stage2a_root_facts "$cid" | sed 's/^/  /' || true
  echo "  inventory: $(q "select 'storage_objects_total='||count(*)||' active='||count(*) filter (where state='active')||' deleted='||count(*) filter (where state='deleted')||' uncertain='||count(*) filter (where publication_uncertain_at is not null)||' unproven='||count(*) filter (where last_error='OWNERSHIP_UNPROVEN')||' cleanup_pending='||count(*) filter (where last_error='CLEANUP_PENDING')||' legacy_retained='||count(*) filter (where last_error='LEGACY_RETAINED') from storage_objects" 2>/dev/null || echo unavailable)"
  echo "  census: $(census 2>/dev/null || echo unavailable)"
  echo "  env record present: $([ -f "$STAGE2A_ENV_RECORD" ] && echo yes || echo no)"
  rm -f "$HOME"/.b25-s1-node.err
  log "stage2a-state reported (read-only)"
}

# ---- environment edit (the ONLY writer of the env file in this tooling) ----
stage2a_env_apply() {   # <activate|rollback>
  local mode="$1" tmp b a
  case "$mode" in activate|rollback) ;; *) fail "stage2a_env_apply: unknown mode" ;; esac
  b="$(sha256sum "$ENV_FILE" | cut -c1-16)"
  tmp="$(umask 077; mktemp "$STATE_DIR/.env.b25-stage2a.XXXXXX")" || fail "cannot create the temporary env file"
  stage2a_env_render "$mode" < "$ENV_FILE" > "$tmp" || { rm -f "$tmp"; fail "env rendering failed"; }
  stage2a_env_check_rendered "$mode" "$ENV_FILE" "$tmp" || { rm -f "$tmp"; fail "rendered env file rejected — nothing changed"; }
  chmod 600 "$tmp"
  mv -f "$tmp" "$ENV_FILE" || { rm -f "$tmp"; fail "could not replace the env file"; }
  chmod 600 "$ENV_FILE"
  a="$(sha256sum "$ENV_FILE" | cut -c1-16)"
  [ "$(stat -c %a "$ENV_FILE")" = "600" ] || fail "env file mode is not 600 after the edit"
  [ -e "$APP_DIR/docker/.env" ] || fail "docker/.env link missing after the edit"
  echo "env file ($mode): sha256/16 before=$b after=$a mode=600 managed=[$(stage2a_env_managed_vars "$mode" | paste -sd' ' -)] key_line_count=$(stage2a_key_lines) (values never printed)"
}
stage2a_env_record_write() {
  local core; core="$(stage2a_env_core_sha)"
  ( umask 077; { echo "core_sha256_16=$core"; echo "managed_before_sha256_16=$(stage2a_env_managed_of activate < "$ENV_FILE" | sha256sum | cut -c1-16)"; echo "recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "product_sha=$STAGE2A_PRODUCT_SHA"; } > "$STAGE2A_ENV_RECORD" )
  chmod 600 "$STAGE2A_ENV_RECORD"
  echo "env record written (non-secret digests only): core_sha256_16=$core"
}
stage2a_recreate_api() {
  compose up -d --no-deps --force-recreate api >/dev/null 2>&1 || return 1
  API_CID="$(compose ps -q api || true)"
  wait_healthy 150
}
stage2a_lock() {
  ( set -o noclobber; echo "$$ $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE2A_LOCK_FILE" ) 2>/dev/null || fail "another Stage 2A activation / rollback holds the lock"
  trap 'rm -f "$STAGE2A_LOCK_FILE"' EXIT
}
stage2a_rollback_inner() {   # used by the activation failure path and by stage2a-rollback; proves the bucket primary is back
  section "ROLLBACK — the bucket becomes the explicit primary again (DRIVER=gcs; fallback off; mirror off; legacy delete off; root and key lines untouched)"
  local files_before cj_before; files_before="$(compose exec -T api sh -c 'find /data/objects/tenants -type f 2>/dev/null | wc -l' 2>/dev/null || echo unavailable)"
  cj_before="$(census)"
  stage2a_env_apply rollback
  stage2a_recreate_api || { echo "!!!! api NOT healthy after the rollback recreate — operator action required"; return 1; }
  local f; f="$(stage2a_init_facts "$API_CID")"
  printf '%s\n' "$f" | grep -E '^(init_record_found|init_driver|init_fallback|init_mirror|init_legacy_delete|banner_driver)=' | sed 's/^/  /'
  docker logs "$API_CID" 2>&1 | grep -F "$STAGE2A_INIT_GCS" >/dev/null || { echo "!!!! storage initialization after the rollback is not driver=gcs / fallback off / mirror off / legacy delete off"; return 1; }
  echo "  readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE)"
  local cj; cj="$(census)"; echo "  census after rollback: $cj"
  [ "$(census_field "$cj" inventory_md5 hex32 2>/dev/null)" = "$(census_field "$cj_before" inventory_md5 hex32 2>/dev/null)" ] || { echo "!!!! bucket inventory changed across the rollback"; return 1; }
  echo "  fs tenant files before=$files_before after=$(compose exec -T api sh -c 'find /data/objects/tenants -type f 2>/dev/null | wc -l' 2>/dev/null || echo unavailable) (never deleted by the rollback)"
  echo "B25_STAGE2A_ROLLBACK_OK=TRUE"
  return 0
}

# ---- stage2a-activate (MUTATION) ----
phase_stage2a_activate() {
  section "A. fresh pre-switch gate in this session (must be TRUE; the lock is taken only after it)"
  stage2a_precheck_run || fail "stage2a-activate: the pre-switch gate is FALSE — nothing changed"
  stage2a_lock
  section "B. the owner-staged key line (presence and shape counted with grep -c; the value is never read, rendered or printed)"
  local kl ks; kl="$(stage2a_key_lines)"; ks="$(stage2a_key_shape_lines)"
  echo "  key lines=$kl well-formed=$ks"
  [ "$kl" = "1" ] && [ "$ks" = "1" ] || fail "stage2a-activate: OBJECT_STORAGE_ENCRYPTION_KEY is not staged as exactly one well-formed line in the VPS env file — nothing changed (the owner stages it through the existing secret mechanism)"
  section "C. rollback record (non-secret digests) and the pre-edit managed state"
  local rec; rec="$(stage2a_record_core)"
  if [ -n "$rec" ]; then [ "$rec" = "$(stage2a_env_core_sha)" ] || fail "stage2a-activate: the env file's unmanaged content differs from the recorded core — review before any activation (nothing changed)"; echo "  existing record matches the current core"
  else stage2a_env_record_write; fi
  echo "  managed lines before: $(stage2a_env_managed_of activate < "$ENV_FILE" | sed -E 's/=.*$/=<value not printed>/' | paste -sd' ' -)"
  section "D. render the five locked variables into the env file (nothing else changes) and recreate ONLY the api service"
  stage2a_env_apply activate
  if ! stage2a_recreate_api; then
    echo "!!!! api did not become healthy after the switch (bounded wait) — rolling back"
    docker logs "$(compose ps -q api || true)" 2>&1 | grep -E 'Object storage initialization failed|"reason":"[^"]*"' | tail -3 | san | sed 's/^/  /' || true
    stage2a_rollback_inner || fail "stage2a-activate: switch FAILED and the rollback did not prove the bucket primary healthy — operator action required"
    fail "stage2a-activate: switch FAILED (api not healthy) — ROLLED BACK to the bucket primary"
  fi
  echo "  api recreated: $(docker inspect -f 'id={{printf "%.12s" .Id}} started={{.State.StartedAt}} health={{.State.Health.Status}}' "$API_CID")"
  section "E. post-switch verification in this session (must be TRUE before any smoke)"
  if ! stage2a_postswitch_run; then
    echo "!!!! post-switch verification FALSE — rolling back"
    stage2a_rollback_inner || fail "stage2a-activate: post-switch verification FAILED and the rollback did not prove the bucket primary healthy — operator action required"
    fail "stage2a-activate: post-switch verification FAILED — ROLLED BACK to the bucket primary"
  fi
  echo "B25_STAGE2A_ACTIVATED=TRUE"
  log "stage2a-activate complete (fs primary + strict mirror + legacy fallback; no object copied, moved or deleted)"
}

# ---- stage2a-rollback (MUTATION; explicit) ----
phase_stage2a_rollback() {
  section "A. host guard"
  stage2a_readonly_guard
  [ "$(git -C "$APP_DIR" rev-parse HEAD)" = "$STAGE2A_PRODUCT_SHA" ] && [ "$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null)" = "$STAGE2A_PRODUCT_SHA" ] || fail "host checkout / current-deploy.sha is not the locked product commit"
  [ -z "$(git -C "$APP_DIR" status --porcelain 2>/dev/null)" ] || fail "host checkout is dirty"
  stage2a_lock
  echo "  before: $(stage2a_init_facts "$API_CID" | grep -E '^(init_driver|init_fallback|init_mirror|init_legacy_delete)=' | paste -sd' ' -)"
  stage2a_rollback_inner || fail "stage2a-rollback: the bucket primary is not proven healthy — operator action required"
  log "stage2a-rollback complete (DRIVER=gcs explicit; key and root lines preserved; no fs file and no bucket object deleted)"
}

# =============================================================================
# Stage 2A disposable smoke (fs primary + strict mirror). Same architecture as the Stage 1 smoke.
# =============================================================================
# =============================================================================
# Stage 2A — CORRECTION 3: existing-tenant safety gates of the disposable smoke (readers; the rules live in
# apply-lib: stage2a_tenant_start_eval / stage2a_tenant_post_eval). Company $S2A_TENANT_ID is the protected
# existing tenant. Readers print only counts, booleans, md5 digests, fixed status tokens and the database's own
# clock; every line is shape-checked before it leaves the host. The snapshot travels back to the runner as ONE
# base64 line (B25_TENANT_SNAPSHOT=…) and returns on the stdin stream of the later sessions as a shell variable —
# never as an SSH argument.
# =============================================================================
s2a_tenant_users_in="(select id from users where company_id = $S2A_TENANT_ID)"
stage2a_tenant_identity_facts() {   # the IDENTITY tier (strict) + the two sweep-movable status digests
  local T="$S2A_TENANT_ID"
  echo "id_company_md5=$(q "select md5(coalesce(name,'')||'|'||coalesce(plan,'')||'|'||coalesce(mfa_required::text,'')||'|'||coalesce(brand_logo_key,'')||'|'||coalesce(brand_logo_content_type,'')||'|'||coalesce(created_by_id::text,'')||'|'||coalesce(trial_ends_at::text,'')||'|'||coalesce(legal_name,'')||'|'||coalesce(registration_number,'')||'|'||coalesce(vat_number,'')) from companies where id = $T")"
  echo "id_company_status_md5=$(q "select md5(coalesce(status,'')||'|'||coalesce(suspended_reason,'')) from companies where id = $T")"
  echo "id_sub_core_md5=$(q "select md5(coalesce(plan,'')||'|'||coalesce(billing_source,'')||'|'||coalesce(limit_overrides::text,'')||'|'||coalesce(trial_started_at::text,'')||'|'||coalesce(trial_expires_at::text,'')||'|'||(stripe_customer_id is not null)::text||'|'||(stripe_subscription_id is not null)::text||'|'||coalesce(stripe_price_id,'')||'|'||coalesce(provider_status,'')||'|'||coalesce(cancel_at_period_end::text,'')||'|'||coalesce(usage_anchor_at::text,'')||'|'||coalesce(current_period_ends_at::text,'')) from subscriptions where company_id = $T")"
  echo "id_sub_status_md5=$(q "select md5(coalesce(status,'')||'|'||coalesce(status_changed_at::text,'')||'|'||coalesce(ended_at::text,'')||'|'||coalesce(suspended_at::text,'')||'|'||coalesce(past_due_since::text,'')||'|'||coalesce(canceled_at::text,'')) from subscriptions where company_id = $T")"
  echo "id_users_count=$(q "select count(*) from users where company_id = $T")"
  echo "id_users_active=$(q "select count(*) from users where company_id = $T and deleted_at is null and is_active")"
  echo "id_users_md5=$(q "select md5(coalesce(string_agg(id||':'||role||':'||coalesce(permissions::text,'')||':'||is_active||':'||(deleted_at is not null)||':'||coalesce(mfa_enabled::text,'')||':'||coalesce(contact_visibility,'')||':'||coalesce(company_visibility,'')||':'||coalesce(selected_user_ids::text,'')||':'||coalesce(manager_id::text,'')||':'||coalesce(department_id::text,'')||':'||coalesce(team_id::text,'')||':'||(email_verified_at is not null)||':'||md5(email)||':'||md5(password_hash), ',' order by id),'')) from users where company_id = $T")"
  echo "id_roles_count=$(q "select count(*) from roles where company_id = $T")"
  echo "id_roles_md5=$(q "select md5(coalesce(string_agg(id||':'||md5(name)||':'||coalesce(is_system::text,'')||':'||coalesce(is_default::text,''), ',' order by id),'')) from roles where company_id = $T")"
  echo "id_user_roles_count=$(q "select count(*) from user_roles ur join users u on u.id = ur.user_id where u.company_id = $T")"
  echo "id_user_roles_md5=$(q "select md5(coalesce(string_agg(ur.user_id||':'||ur.role_id, ',' order by ur.user_id, ur.role_id),'')) from user_roles ur join users u on u.id = ur.user_id where u.company_id = $T")"
  echo "id_brand_logo_set=$(q "select (brand_logo_key is not null) from companies where id = $T" | sed 's/^t$/true/; s/^f$/false/')"
}
stage2a_tenant_business_facts() {   # <prefix pre|post>: counts + highest id per BUSINESS table (soft-deleted rows stay counted; a count can only fall by a hard delete)
  local P="$1" T="$S2A_TENANT_ID" t
  for t in $S2A_BUSINESS_TABLES; do
    echo "${P}_${t}_count=$(q "select count(*) from $t where company_id = $T")"
    echo "${P}_${t}_max_id=$(q "select coalesce(max(id),0) from $t where company_id = $T")"
  done
}
stage2a_tenant_storage_facts() {   # <prefix pre|post>: the tenant's storage rows — count + row digest (Correction 5: live rows are protected, never required absent)
  local P="$1" T="$S2A_TENANT_ID"
  echo "${P}_storage_rows=$(q "select count(*) from storage_objects where company_id = $T")"
  echo "${P}_storage_md5=$(q "select md5(coalesce(string_agg(id||'|'||kind||'|'||state||'|'||driver||'|'||coalesce(sha256,'')||'|'||coalesce(size_bytes::text,'')||'|'||coalesce(mirror_key,'')||'|'||coalesce(mirror_state,'')||'|'||coalesce(last_error,'')||'|'||coalesce(lease_token,'')||'|'||storage_key||'|'||updated_at::text, ',' order by id), '')) from storage_objects where company_id = $T")"
}
stage2a_tenant_window_facts() {   # <since ts> <disposable company csv or -1> <disposable user csv or -1>: movement + attribution in the window
  local W="$1" C="$2" U="$3" T="$S2A_TENANT_ID" t spec del upd actor cc cw mw dw cbd cbt auto
  for t in $S2A_BUSINESS_TABLES; do
    spec="$(s2a_tbl_spec "$t")" || fail "unknown business table $t"
    read -r del upd actor cc <<<"$spec"
    cw="$(q "select count(*) from $t where company_id = $T and $cc >= '$W'")"
    if [ "$upd" = yes ]; then mw="$(q "select count(*) from $t where company_id = $T and $cc < '$W' and updated_at >= '$W'")"; else mw="-"; fi
    if [ "$del" = yes ]; then dw="$(q "select count(*) from $t where company_id = $T and deleted_at >= '$W'")"; else dw="-"; fi
    if [ "$actor" != "-" ]; then
      cbd="$(q "select count(*) from $t where company_id = $T and $cc >= '$W' and $actor in ($U)")"
      cbt="$(q "select count(*) from $t where company_id = $T and $cc >= '$W' and $actor in $s2a_tenant_users_in")"
    else cbd="-"; cbt="-"; fi
    case "$t" in
      workflow_runs) auto="$(q "select count(*) from $t where company_id = $T and created_at < '$W' and updated_at >= '$W' and status not in ('pending','queued','running','scheduled')")" ;;
      billing_checkout_sessions) auto="$(q "select count(*) from $t where company_id = $T and created_at < '$W' and updated_at >= '$W' and status = 'expired' and expires_at <= now()")" ;;
      *) auto="-" ;;
    esac
    echo "${t}_created_window=$cw"; echo "${t}_modified_window=$mw"; echo "${t}_soft_deleted_window=$dw"
    echo "${t}_created_by_disposable=$cbd"; echo "${t}_created_by_tenant=$cbt"; echo "${t}_automated_explained=$auto"
  done
  echo "tenant_audit_rows_window=$(q "select count(*) from audit_logs where company_id = $T and created_at >= '$W' and user_id in $s2a_tenant_users_in")"
  echo "disposable_audit_on_tenant=$(q "select count(*) from audit_logs where created_at >= '$W' and user_id in ($U) and company_id = $T")"
  echo "tenant_rows_ref_disposables=$(q "select (select count(*) from contacts where company_id = $T and (event_id in (select id from events where company_id in ($C)) or assigned_to_id in ($U) or created_by_id in ($U))) + (select count(*) from leads where company_id = $T and (event_id in (select id from events where company_id in ($C)) or assigned_to_id in ($U) or created_by_id in ($U))) + (select count(*) from scans where company_id = $T and (event_id in (select id from events where company_id in ($C)) or user_id in ($U))) + (select count(*) from documents where company_id = $T and created_by_id in ($U)) + (select count(*) from tasks where company_id = $T and assigned_to_id in ($U)) + (select count(*) from follow_ups where company_id = $T and (assigned_to_id in ($U) or created_by_id in ($U)))")"
  echo "disposable_rows_ref_tenant=$(q "select (select count(*) from contacts where company_id in ($C) and (created_by_id in $s2a_tenant_users_in or assigned_to_id in $s2a_tenant_users_in)) + (select count(*) from documents where company_id in ($C) and created_by_id in $s2a_tenant_users_in) + (select count(*) from scans where company_id in ($C) and user_id in $s2a_tenant_users_in) + (select count(*) from events where company_id in ($C) and created_by_id in $s2a_tenant_users_in) + (select count(*) from users where company_id in ($C) and manager_id in $s2a_tenant_users_in)")"
  echo "tenant_storage_rows_post=$(q "select count(*) from storage_objects where company_id = $T")"
  echo "tenant_storage_created_window=$(q "select count(*) from storage_objects where company_id = $T and created_at >= '$W'")"
  echo "tenant_storage_deleted_window=$(q "select count(*) from storage_objects where company_id = $T and deleted_at >= '$W'")"
  echo "sweep_audit_rows_window=$(q "select count(*) from audit_logs where company_id = $T and created_at >= '$W' and action = 'subscription.trial_expired' and user_id is null")"
  echo "sub_status_post=$(q "select coalesce(status,'-') from subscriptions where company_id = $T")"
  echo "sub_trial_elapsed=$(q "select coalesce((trial_expires_at <= now())::text, 'false') from subscriptions where company_id = $T" | sed 's/^t$/true/; s/^f$/false/')"
}
stage2a_tenant_since_facts() {   # <review instant>: the IDENTITY tier evidence since the last owner review (start gate)
  local R="$1" T="$S2A_TENANT_ID" t spec del upd actor cc
  echo "review_utc_ok=$(q "select ('$R'::timestamp <= now())::text" | sed 's/^t$/true/; s/^f$/false/')"
  echo "users_created_since=$(q "select count(*) from users where company_id = $T and created_at >= '$R'")"
  echo "users_soft_deleted_since=$(q "select count(*) from users where company_id = $T and deleted_at >= '$R'")"
  echo "users_modified_since=$(q "select count(*) from users where company_id = $T and created_at < '$R' and updated_at >= '$R'")"
  echo "users_modified_login_explained=$(q "select count(*) from users where company_id = $T and created_at < '$R' and updated_at >= '$R' and last_login_at >= '$R' and abs(extract(epoch from (updated_at - last_login_at))) <= 2")"
  echo "sec_audit_rows_since=$(q "select count(*) from audit_logs where company_id = $T and created_at >= '$R' and (action ~ '^(team|profile|roles|security)\\.' or (action ~ '^user\\.' and action <> 'user.login'))")"
  echo "roles_changed_since=$(q "select count(*) from roles where company_id = $T and (created_at >= '$R' or updated_at >= '$R')")"
  echo "user_roles_created_since=$(q "select count(*) from user_roles ur join users u on u.id = ur.user_id where u.company_id = $T and ur.created_at >= '$R'")"
  echo "company_modified_since=$(q "select (updated_at >= '$R')::text from companies where id = $T" | sed 's/^t$/true/; s/^f$/false/')"
  echo "sub_modified_since=$(q "select coalesce((updated_at >= '$R')::text,'false') from subscriptions where company_id = $T" | sed 's/^t$/true/; s/^f$/false/')"
  echo "sub_status_changed_since=$(q "select coalesce((status_changed_at >= '$R')::text,'false') from subscriptions where company_id = $T" | sed 's/^t$/true/; s/^f$/false/')"
  echo "sub_status=$(q "select coalesce(status,'-') from subscriptions where company_id = $T")"
  echo "sweep_audit_rows_since=$(q "select count(*) from audit_logs where company_id = $T and created_at >= '$R' and action = 'subscription.trial_expired' and user_id is null")"
  echo "sub_trial_elapsed=$(q "select coalesce((trial_expires_at <= now())::text, 'false') from subscriptions where company_id = $T" | sed 's/^t$/true/; s/^f$/false/')"
  echo "tenant_storage_rows=$(q "select count(*) from storage_objects where company_id = $T")"
  echo "tenant_storage_live_ok=$(q "select count(*) from storage_objects where company_id = $T and $(stage2a_live_row_sql)")"
  echo "references=$(references_legacy)"; echo "references_expected=$REFERENCES"
  for t in $S2A_BUSINESS_TABLES; do
    spec="$(s2a_tbl_spec "$t")" || fail "unknown business table $t"; read -r del upd actor cc <<<"$spec"
    echo "bz_${t}_created_since=$(q "select count(*) from $t where company_id = $T and $cc >= '$R'")"
    [ "$upd" = yes ] && echo "bz_${t}_modified_since=$(q "select count(*) from $t where company_id = $T and $cc < '$R' and updated_at >= '$R'")"
    [ "$del" = yes ] && echo "bz_${t}_soft_deleted_since=$(q "select count(*) from $t where company_id = $T and deleted_at >= '$R'")"
  done
  stage2a_company_change_facts "$R"   # Correction 6: the company-row attribution evidence since the review instant
}
# ---- Correction 6: the company-row attribution evidence over a window (counts, booleans, timestamps, digests and fixed tokens only) ----
# <window start> [<window end>; default: open]. Read by the start gate (since the review instant) and by the incident
# form (the incident window). The anchor is the reviewed constant S2A_C6_ANCHOR_B64 (the Correction 4 snapshot) — never
# an input, never today's digest. No customer value is selected into the output: actions are compared with fixed
# identifiers, actors are classified by membership, timestamps are the tooling's own comparison instants.
stage2a_company_change_facts() {
  local W="$1" E="${2:-}" T="$S2A_TENANT_ID" ew acts ent aok=false snap="" alogo fa la last_action last_logo lk lr_at live assoc idf k short act_rows lrow_live lrow_ok lsm=false masked
  [[ "$W" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?$ ]] || fail "company change facts: window start malformed"
  if [ -n "$E" ]; then [[ "$E" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?$ ]] || fail "company change facts: window end malformed"; ew="created_at >= '$W' and created_at < '$E'"; else ew="created_at >= '$W'"; fi
  acts="'branding.update','branding.logo.replace','branding.logo.remove','branding.reset'"
  ent="entity_type = 'company' and entity_id = '$T'"
  if s2a_c6_constants_ok; then aok=true; snap="$(printf '%s' "$S2A_C6_ANCHOR_B64" | base64 -d 2>/dev/null)"; fi
  echo "c6_anchor_ok=$aok"; echo "c6_anchor_at=$S2A_C6_ANCHOR_AT"
  alogo="$(s2a_fv "$snap" pre_id_brand_logo_set)"; echo "c6_anchor_logo_set=${alogo:--}"
  echo "c6_company_updated_at=$(q "select coalesce(to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS.US'), '-') from companies where id = $T")"
  echo "c6_company_updated_after_anchor=$(q "select coalesce((updated_at > '$S2A_C6_ANCHOR_AT'::timestamp)::text, 'false') from companies where id = $T" | sed 's/^t$/true/; s/^f$/false/')"
  echo "c6_branding_rows=$(q "select count(*) from audit_logs where company_id = $T and $ew and action in ($acts)")"
  echo "c6_branding_update_rows=$(q "select count(*) from audit_logs where company_id = $T and $ew and action = 'branding.update'")"
  echo "c6_logo_replace_rows=$(q "select count(*) from audit_logs where company_id = $T and $ew and action = 'branding.logo.replace'")"
  echo "c6_logo_remove_rows=$(q "select count(*) from audit_logs where company_id = $T and $ew and action = 'branding.logo.remove'")"
  echo "c6_branding_reset_rows=$(q "select count(*) from audit_logs where company_id = $T and $ew and action = 'branding.reset'")"
  echo "c6_branding_actor_tenant=$(q "select count(*) from audit_logs where company_id = $T and $ew and action in ($acts) and user_id in $s2a_tenant_users_in")"
  echo "c6_branding_actor_other=$(q "select count(*) from audit_logs where company_id = $T and $ew and action in ($acts) and (user_id is null or user_id not in $s2a_tenant_users_in)")"
  echo "c6_branding_entity_ok=$(q "select count(*) from audit_logs where company_id = $T and $ew and action in ($acts) and $ent")"
  echo "c6_organization_rows=$(q "select count(*) from audit_logs where company_id = $T and $ew and action ~ '^organization\\.'")"
  echo "c6_company_patch_rows=$(q "select count(*) from audit_logs where $ew and action ~ '^company\\.' and (company_id = $T or ($ent))")"
  echo "c6_security_rows=$(q "select count(*) from audit_logs where company_id = $T and $ew and action ~ '^security\\.'")"
  echo "c6_billing_rows=$(q "select count(*) from audit_logs where company_id = $T and $ew and action ~ '^(subscription|billing)\\.'")"
  echo "c6_identity_rows=$(q "select count(*) from audit_logs where company_id = $T and $ew and (action ~ '^(team|profile|roles)\\.' or (action ~ '^user\\.' and action <> 'user.login'))")"
  echo "c6_other_rows=$(q "select count(*) from audit_logs where company_id = $T and $ew and not (action in ($acts) or action ~ '^(organization|company|security|subscription|billing|team|profile|roles|user)\\.')")"
  fa="$(q "select coalesce(to_char(min(created_at), 'YYYY-MM-DD HH24:MI:SS.US'), '-') from audit_logs where company_id = $T and $ew and action in ($acts) and $ent")"
  la="$(q "select coalesce(to_char(max(created_at), 'YYYY-MM-DD HH24:MI:SS.US'), '-') from audit_logs where company_id = $T and $ew and action in ($acts) and $ent")"
  echo "c6_branding_first_at=$fa"; echo "c6_branding_last_at=$la"
  last_action="$(q "select coalesce((select action from audit_logs where company_id = $T and $ew and action in ($acts) and $ent order by created_at desc, id desc limit 1), '-')")"
  last_logo="$(q "select coalesce((select action from audit_logs where company_id = $T and $ew and action in ('branding.logo.replace','branding.logo.remove','branding.reset') and $ent order by created_at desc, id desc limit 1), '-')")"
  echo "c6_branding_last_action=$last_action"; echo "c6_logo_last_action=$last_logo"
  if [ "$la" != "-" ]; then
    echo "c6_company_update_bracketed=$(q "select coalesce((updated_at <= '$la'::timestamp and updated_at >= '$la'::timestamp - interval '$S2A_C6_BRACKET_SECONDS seconds')::text, 'false') from companies where id = $T" | sed 's/^t$/true/; s/^f$/false/')"
    echo "c6_branding_ordered=$(q "select ('$fa'::timestamp >= '$W'::timestamp and '$la'::timestamp <= now()${E:+ and '$la'::timestamp < '$E'::timestamp})::text" | sed 's/^t$/true/; s/^f$/false/')"
  else echo "c6_company_update_bracketed=false"; echo "c6_branding_ordered=false"; fi
  lk="$(q "select coalesce((brand_logo_key is not null)::text, 'false') from companies where id = $T" | sed 's/^t$/true/; s/^f$/false/')"; echo "c6_logo_key_set=$lk"
  act_rows="$(q "select count(*) from storage_objects where company_id = $T and kind = 'branding_logo' and state = 'active'")"; echo "c6_logo_rows_active=$act_rows"
  live="$(stage2a_live_row_sql 'so.')"; assoc="$(stage2a_assoc_sql 'so.')"
  lrow_live="$(q "select (count(*) = 1)::text from storage_objects so join companies c on c.id = so.company_id where so.company_id = $T and so.kind = 'branding_logo' and so.state = 'active' and so.reference = c.brand_logo_key and $live and $assoc" | sed 's/^t$/true/; s/^f$/false/')"
  lr_at="$(q "select coalesce(to_char(max(created_at), 'YYYY-MM-DD HH24:MI:SS.US'), '-') from audit_logs where company_id = $T and $ew and action = 'branding.logo.replace' and $ent")"
  if [ "$lr_at" != "-" ]; then
    lrow_ok="$(q "select (count(*) = 1)::text from storage_objects so join companies c on c.id = so.company_id where so.company_id = $T and so.kind = 'branding_logo' and so.state = 'active' and so.reference = c.brand_logo_key and $live and $assoc and so.created_at > '$S2A_C6_ANCHOR_AT'::timestamp and so.created_at <= c.updated_at and so.created_at <= '$lr_at'::timestamp" | sed 's/^t$/true/; s/^f$/false/')"
  else lrow_ok=false; fi
  echo "c6_logo_row_live=$lrow_live"; echo "c6_logo_row_ok=$lrow_ok"
  echo "c6_foreign_logo_refs=$(q "select count(*) from storage_objects so, companies c where c.id = $T and c.brand_logo_key is not null and so.reference = c.brand_logo_key and so.company_id <> $T")"
  case "$last_logo" in
    branding.logo.replace) [ "$lk" = true ] && [ "$lrow_ok" = true ] && lsm=true ;;
    branding.logo.remove|branding.reset) [ "$lk" = false ] && [ "$act_rows" = "0" ] && lsm=true ;;
    -) if [ "$aok" = true ] && [ "$lk" = "$alogo" ]; then if [ "$lk" = true ]; then [ "$lrow_live" = true ] && lsm=true; else [ "$act_rows" = "0" ] && lsm=true; fi; fi ;;
  esac
  echo "c6_logo_state_matches=$lsm"
  idf="$(stage2a_tenant_identity_facts)"
  for k in id_company_status_md5:company_status id_sub_core_md5:sub_core id_sub_status_md5:sub_status id_users_count:users_count id_users_active:users_active id_users_md5:users_md5 id_roles_count:roles_count id_roles_md5:roles_md5 id_user_roles_count:user_roles_count id_user_roles_md5:user_roles_md5; do
    short="${k#*:}"; k="${k%%:*}"
    if [ "$aok" = true ] && [ -n "$(s2a_fv "$idf" "$k")" ] && [ "$(s2a_fv "$idf" "$k")" = "$(s2a_fv "$snap" "pre_$k")" ]; then echo "c6_${short}_match=true"; else echo "c6_${short}_match=false"; fi
  done
  if [ "$aok" = true ] && [ "$alogo" = false ]; then
    # today's company identity digest with the two logo fields masked (the anchor had no logo): equal ⇒ name / plan / mfa / creator / trial / legal fields unchanged since the anchor
    masked="$(q "select md5(coalesce(name,'')||'|'||coalesce(plan,'')||'|'||coalesce(mfa_required::text,'')||'|'||''||'|'||''||'|'||coalesce(created_by_id::text,'')||'|'||coalesce(trial_ends_at::text,'')||'|'||coalesce(legal_name,'')||'|'||coalesce(registration_number,'')||'|'||coalesce(vat_number,'')) from companies where id = $T")"
    if [ -n "$masked" ] && [ "$masked" = "$(s2a_fv "$snap" pre_id_company_md5)" ]; then echo "c6_company_id_match_masked=true"; else echo "c6_company_id_match_masked=false"; fi
  else echo "c6_company_id_match_masked=na"; fi
}
# The START gate: runs BEFORE the disposable owner exists. Prints the evidence, the verdict and the snapshot line.
stage2a_tenant_start_gate() {
  section "existing tenant (company $S2A_TENANT_ID) — identity tier unmoved since the review $S2A_TENANT_REVIEW_UTC; business tier reported (read-only; counts, booleans and digests only)"
  local facts verdict
  facts="$(stage2a_tenant_since_facts "$S2A_TENANT_REVIEW_UTC")" || fail "tenant start gate: evidence unreadable"
  s2a_facts_ok "$facts" || fail "tenant start gate: evidence has an unexpected shape (not printed)"
  printf '%s\n' "$facts" | grep -E '^(users_|sec_audit|roles_|user_roles|company_modified|sub_|sweep_|tenant_storage|references|review_utc|c6_)' | sed 's/^/  /'
  verdict="$(printf '%s\n' "$facts" | stage2a_tenant_start_eval)" || { printf '%s\n' "$verdict"; fail "tenant start gate FAILED — the existing tenant's identity / security / billing state moved since the last review; nothing was created (review the surfaced components; never widen the gate)"; }
  printf '%s\n' "$verdict"
  section "pre-smoke snapshot of the existing tenant (identity digests + business counts; carried back to the runner as one base64 line)"
  local snap
  snap="$( { echo "snapshot_at=$(q "select to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS.US')")"; stage2a_tenant_identity_facts | sed 's/^/pre_/'; stage2a_tenant_business_facts pre; stage2a_tenant_storage_facts pre; } )" || fail "tenant snapshot unreadable"
  s2a_facts_ok "$snap" || fail "tenant snapshot has an unexpected shape (not printed)"
  printf '%s\n' "$snap" | grep -E '^(snapshot_at|pre_id_users_count|pre_id_users_active|pre_id_roles_count|pre_id_user_roles_count|pre_id_brand_logo_set|pre_[a-z_]+_count)=' | sed 's/^/  /'
  echo "B25_TENANT_SNAPSHOT=$(printf '%s\n' "$snap" | base64 -w0)"
}
# The POST gate: recomputes the tiers, attributes every movement of the window and decides. The snapshot arrives as
# the shell variable B25_TENANT_SNAPSHOT (first stdin line of this session), never as an argument.
stage2a_tenant_post_gate() {   # <disposable company csv or -1> <disposable user csv>
  local C="$1" U="$2" snap since facts verdict
  s2a_b64_line_ok "${B25_TENANT_SNAPSHOT:-}" || fail "pre-smoke tenant snapshot missing or malformed on the stdin stream — fail closed (no post-smoke verdict without it)"
  snap="$(printf '%s' "$B25_TENANT_SNAPSHOT" | base64 -d 2>/dev/null)" || fail "pre-smoke tenant snapshot does not decode"
  s2a_facts_ok "$snap" || fail "pre-smoke tenant snapshot has an unexpected shape"
  since="$(s2a_fv "$snap" snapshot_at)"; [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?$ ]] || fail "pre-smoke snapshot instant malformed"
  section "post-smoke comparison of the existing tenant (company $S2A_TENANT_ID) against the pre-smoke snapshot taken at $since (identity strict; business attributed; isolation)"
  facts="$( { printf '%s\n' "$snap"; stage2a_tenant_identity_facts | sed 's/^/post_/'; stage2a_tenant_business_facts post; stage2a_tenant_storage_facts post; stage2a_tenant_window_facts "$since" "$C" "$U"; echo "references_post=$(references_legacy)"; echo "references_expected=$REFERENCES"; } )" || fail "tenant post gate: evidence unreadable"
  s2a_facts_ok "$facts" || fail "tenant post gate: evidence has an unexpected shape (not printed)"
  printf '%s\n' "$facts" | grep -E '^([a-z_]+_(created|modified|soft_deleted)_window|[a-z_]+_created_by_(disposable|tenant)|[a-z_]+_automated_explained|tenant_audit_rows_window|disposable_audit_on_tenant|tenant_rows_ref_disposables|disposable_rows_ref_tenant|tenant_storage_|(pre|post)_storage_|sweep_audit_rows_window|sub_status_post|sub_trial_elapsed|references_post)=' | grep -vE '=(0|-)$' | sed 's/^/  /'
  verdict="$(printf '%s\n' "$facts" | stage2a_tenant_post_eval)" || { printf '%s\n' "$verdict"; fail "tenant post gate FAILED — see the FAIL lines above (identity change, smoke-caused or unattributed movement, cross-tenant association or storage movement of the existing tenant)"; }
  printf '%s\n' "$verdict"
  unset B25_TENANT_SNAPSHOT
}
# =============================================================================
# Correction 4 — retrospective Correction 3 proof over an INCIDENT WINDOW (the post gate of run 38958264416 was
# never reached). The same tiers, read with the window bounded on BOTH ends: identity movement inside the window
# (the start gate's row / audit rules), business movement inside the window attributed to tenant actors / tenant
# audit rows / deterministic automation, isolation against the disposable identities, the tenant's storage objects,
# the legacy references. A hard deletion since the snapshot is attributed to the tenant's own audited activity since
# the snapshot or fails closed. The present is NOT compared with the snapshot digest by digest — the tenant may have
# worked normally since the incident. Only counts, booleans, digests and status tokens leave the host.
# =============================================================================
stage2a_tenant_incident_facts() {   # <window start> <window end> <disposable company csv> <disposable user csv>
  local W="$1" E="$2" C="$3" U="$4" T="$S2A_TENANT_ID" t spec del upd actor cc cw mw dw cbd cbt auto
  echo "review_utc_ok=$(q "select ('$W'::timestamp < '$E'::timestamp and '$E'::timestamp <= now())::text" | sed 's/^t$/true/; s/^f$/false/')"
  echo "users_created_since=$(q "select count(*) from users where company_id = $T and created_at >= '$W' and created_at < '$E'")"
  echo "users_soft_deleted_since=$(q "select count(*) from users where company_id = $T and deleted_at >= '$W' and deleted_at < '$E'")"
  echo "users_modified_since=$(q "select count(*) from users where company_id = $T and created_at < '$W' and updated_at >= '$W' and updated_at < '$E'")"
  echo "users_modified_login_explained=$(q "select count(*) from users where company_id = $T and created_at < '$W' and updated_at >= '$W' and updated_at < '$E' and last_login_at >= '$W' and last_login_at < '$E' and abs(extract(epoch from (updated_at - last_login_at))) <= 2")"
  echo "sec_audit_rows_since=$(q "select count(*) from audit_logs where company_id = $T and created_at >= '$W' and created_at < '$E' and (action ~ '^(team|profile|roles|security)\\.' or (action ~ '^user\\.' and action <> 'user.login'))")"
  echo "roles_changed_since=$(q "select count(*) from roles where company_id = $T and ((created_at >= '$W' and created_at < '$E') or (updated_at >= '$W' and updated_at < '$E'))")"
  echo "user_roles_created_since=$(q "select count(*) from user_roles ur join users u on u.id = ur.user_id where u.company_id = $T and ur.created_at >= '$W' and ur.created_at < '$E'")"
  echo "company_modified_since=$(q "select (updated_at >= '$W' and updated_at < '$E')::text from companies where id = $T" | sed 's/^t$/true/; s/^f$/false/')"
  echo "sub_modified_since=$(q "select coalesce((updated_at >= '$W' and updated_at < '$E')::text,'false') from subscriptions where company_id = $T" | sed 's/^t$/true/; s/^f$/false/')"
  echo "sub_status_changed_since=$(q "select coalesce((status_changed_at >= '$W' and status_changed_at < '$E')::text,'false') from subscriptions where company_id = $T" | sed 's/^t$/true/; s/^f$/false/')"
  echo "sub_status_post=$(q "select coalesce(status,'-') from subscriptions where company_id = $T")"
  echo "sub_trial_elapsed=$(q "select coalesce((trial_expires_at <= now())::text, 'false') from subscriptions where company_id = $T" | sed 's/^t$/true/; s/^f$/false/')"
  echo "sweep_audit_rows_window=$(q "select count(*) from audit_logs where company_id = $T and created_at >= '$W' and created_at < '$E' and action = 'subscription.trial_expired' and user_id is null")"
  for t in $S2A_BUSINESS_TABLES; do
    spec="$(s2a_tbl_spec "$t")" || fail "unknown business table $t"
    read -r del upd actor cc <<<"$spec"
    cw="$(q "select count(*) from $t where company_id = $T and $cc >= '$W' and $cc < '$E'")"
    if [ "$upd" = yes ]; then mw="$(q "select count(*) from $t where company_id = $T and $cc < '$W' and updated_at >= '$W' and updated_at < '$E'")"; else mw="-"; fi
    if [ "$del" = yes ]; then dw="$(q "select count(*) from $t where company_id = $T and deleted_at >= '$W' and deleted_at < '$E'")"; else dw="-"; fi
    if [ "$actor" != "-" ]; then
      cbd="$(q "select count(*) from $t where company_id = $T and $cc >= '$W' and $cc < '$E' and $actor in ($U)")"
      cbt="$(q "select count(*) from $t where company_id = $T and $cc >= '$W' and $cc < '$E' and $actor in $s2a_tenant_users_in")"
    else cbd="-"; cbt="-"; fi
    case "$t" in
      workflow_runs) auto="$(q "select count(*) from $t where company_id = $T and created_at < '$W' and updated_at >= '$W' and updated_at < '$E' and status not in ('pending','queued','running','scheduled')")" ;;
      billing_checkout_sessions) auto="$(q "select count(*) from $t where company_id = $T and created_at < '$W' and updated_at >= '$W' and updated_at < '$E' and status = 'expired' and expires_at <= now()")" ;;
      *) auto="-" ;;
    esac
    echo "${t}_created_window=$cw"; echo "${t}_modified_window=$mw"; echo "${t}_soft_deleted_window=$dw"
    echo "${t}_created_by_disposable=$cbd"; echo "${t}_created_by_tenant=$cbt"; echo "${t}_automated_explained=$auto"
  done
  echo "tenant_audit_rows_window=$(q "select count(*) from audit_logs where company_id = $T and created_at >= '$W' and created_at < '$E' and user_id in $s2a_tenant_users_in")"
  echo "tenant_audit_rows_since=$(q "select count(*) from audit_logs where company_id = $T and created_at >= '$W' and user_id in $s2a_tenant_users_in")"
  echo "disposable_audit_on_tenant=$(q "select count(*) from audit_logs where created_at >= '$W' and user_id in ($U) and company_id = $T")"
  # the two cross-reference isolation facts are read by the reviewed Correction 3 reader (unbounded: an association is wrong whenever it exists)
  stage2a_tenant_window_facts "$W" "$C" "$U" | grep -E '^(tenant_rows_ref_disposables|disposable_rows_ref_tenant)='
  echo "tenant_storage_rows_post=$(q "select count(*) from storage_objects where company_id = $T")"
  echo "tenant_storage_created_window=$(q "select count(*) from storage_objects where company_id = $T and created_at >= '$W' and created_at < '$E'")"
  echo "tenant_storage_deleted_window=$(q "select count(*) from storage_objects where company_id = $T and deleted_at >= '$W' and deleted_at < '$E'")"
  echo "references_post=$(references_legacy)"; echo "references_expected=$REFERENCES"
  stage2a_company_change_facts "$W" "$E"   # Correction 6: the company-row attribution evidence bounded to the window
}
stage2a_tenant_incident_proof() {   # <pre-smoke snapshot b64 (reviewed constant)> <incident end> <disposable company csv> <disposable user csv>
  local SNAPB="$1" E="$2" C="$3" U="$4" snap since facts verdict
  s2a_b64_line_ok "$SNAPB" || fail "incident snapshot malformed"
  snap="$(printf '%s' "$SNAPB" | base64 -d 2>/dev/null)" || fail "incident snapshot does not decode"
  s2a_facts_ok "$snap" || fail "incident snapshot has an unexpected shape"
  since="$(s2a_fv "$snap" snapshot_at)"; [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?$ ]] || fail "incident snapshot instant malformed"
  [[ "$E" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?$ ]] || fail "incident end malformed"
  [[ "$C" =~ ^[0-9]+(,[0-9]+)*$ ]] && [[ "$U" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "disposable ids malformed"
  section "existing tenant (company $S2A_TENANT_ID) — retrospective Correction 3 comparison over the incident window $since → $E (identity by window evidence; business attributed; isolation; read-only)"
  facts="$( { printf '%s\n' "$snap"; stage2a_tenant_identity_facts | sed 's/^/post_/'; stage2a_tenant_business_facts post; stage2a_tenant_incident_facts "$since" "$E" "$C" "$U"; } )" || fail "incident evidence unreadable"
  s2a_facts_ok "$facts" || fail "incident evidence has an unexpected shape (not printed)"
  printf '%s\n' "$facts" | grep -E '^(review_utc_ok|users_|sec_audit|roles_|user_roles|company_modified|sub_|sweep_|c6_|[a-z_]+_(created|modified|soft_deleted)_window|[a-z_]+_created_by_(disposable|tenant)|[a-z_]+_automated_explained|tenant_audit_rows_(window|since)|disposable_audit_on_tenant|tenant_rows_ref_disposables|disposable_rows_ref_tenant|tenant_storage_|references_)' | sed 's/^/  /'
  if verdict="$(printf '%s\n' "$facts" | stage2a_tenant_post_eval incident)"; then printf '%s\n' "$verdict"; return 0; fi
  printf '%s\n' "$verdict"; return 1
}

# =============================================================================
# B25 STAGE 2A — CORRECTION 5: the PROTECTED LIVE-INVENTORY model. The read-only inspection run 39442358211 proved
# that the existing tenant (company 1) holds two healthy live fs objects (uploaded after the company-58 incident):
# the "exception row only" baseline is FALSE and cannot be re-proven without removing customer data (the owner's
# hard stop). The smoke therefore proves ITS OWN effects and the NON-MOVEMENT of everything else:
#   P = every storage row that is neither the Stage 1 exception nor a recorded smoke row. Every member of P must be
#   a healthy live fs row of a real tenant (stage2a_live_row_sql: active / fs / no legacy location / canonical ok
#   mirror / no error / no uncertainty / no lease / digest / size / the product's own key shape; never company 53,
#   never a 'B25 SMOKE' tenant). P is recorded before the smoke (one base64 line, B25_PROTECTED_SET=…, counts and
#   digests only) and must be IDENTICAL — rows, row digest, bytes, keys, ciphertexts, mirror generations — in the
#   middle of the smoke, after the settle and in the cleanup. The bucket is a PARTITION: 4 unmarked originals (locked
#   digest) + 1 exception (locked generation digest) + |P| protected mirrors (each proven per row) + the smoke mirrors.
#   Legacy references = references_legacy() = 4 (a native key is never a legacy reference).
# NOTHING in this tooling writes, moves or deletes a member of P: a changed P stops the phase with the fact lines.
# The record travels like the tenant snapshot: printed by the smoke setup, kept on the runner, returned as the first
# line of the stdin stream of the later sessions (a shell variable) — never an SSH argument, never a workflow input.
# =============================================================================
S2A_PROTECTED_N=""; S2A_PROTECTED_BYTES=""; S2A_PROTECTED_FACTS=""   # set by stage2a_protected_gate (in-session only)
stage2a_live_row_sql() {   # [alias.] → SQL predicate: a healthy live fs row of a real tenant in the product's own shape (keys.ts / referenceFor)
  local a="${1:-}"
  [[ "$a" =~ ^([a-z]+\.)?$ ]] || { echo "stage2a_live_row_sql: prefix malformed" >&2; return 1; }
  printf '%s' "(${a}state = 'active' and ${a}driver = 'fs' and ${a}legacy_key is null and ${a}deleted_at is null and ${a}mirror_key is not null and ${a}mirror_key = 'gs://' || split_part(split_part(${a}mirror_key, '://', 2), '/', 1) || '/' || ${a}storage_key and ${a}mirror_state = 'ok' and ${a}last_error is null and ${a}publication_uncertain_at is null and ${a}lease_token is null and ${a}lease_expires_at is null and ${a}sha256 ~ '^[0-9a-f]{64}\$' and ${a}size_bytes > 0 and coalesce(${a}content_type, '') <> '' and ${a}company_id <> $B25PHYS_COMPANY and exists (select 1 from companies lc where lc.id = ${a}company_id and lc.name not like 'B25 SMOKE %') and ((${a}kind in ('document', 'export', 'report', 'scan_image') and ${a}reference = '/objects/' || ${a}id::text and ${a}storage_key = 'tenants/' || ${a}company_id || '/' || case ${a}kind when 'document' then 'documents' when 'export' then 'exports' when 'report' then 'reports' else 'scans' end || '/' || ${a}id::text) or (${a}kind = 'branding_logo' and ${a}reference ~ ('^branding/' || ${a}company_id || '/' || replace(${a}id::text, '-', '') || '\\.(png|jpg|webp)\$') and $(logo_key_rule_sql "$a"))))"
}
stage2a_assoc_sql() {   # [alias.] → SQL boolean: the row has the product's live feature association (storage.service.ts liveAssociationInner)
  local a="${1:-}"
  [[ "$a" =~ ^([a-z]+\.)?$ ]] || { echo "stage2a_assoc_sql: prefix malformed" >&2; return 1; }
  printf '%s' "((${a}kind = 'document' and exists (select 1 from document_versions dv join documents d on d.id = dv.document_id where dv.company_id = ${a}company_id and dv.object_path = ${a}reference and d.company_id = ${a}company_id and d.deleted_at is null)) or (${a}kind = 'export' and exists (select 1 from export_runs er where er.company_id = ${a}company_id and er.object_path = ${a}reference and er.status = 'completed')) or (${a}kind = 'report' and exists (select 1 from executive_reports xr where xr.company_id = ${a}company_id and xr.object_path = ${a}reference and xr.status = 'ready')) or (${a}kind = 'scan_image' and exists (select 1 from scans sc where sc.company_id = ${a}company_id and sc.image_url = ${a}reference and sc.deleted_at is null)) or (${a}kind = 'branding_logo' and exists (select 1 from companies bc where bc.id = ${a}company_id and bc.brand_logo_key = ${a}reference)))"
}
stage2a_protected_where() {   # [smoke uuid csv] → SQL: every row that is neither the Stage 1 exception nor a recorded smoke row
  local csv="${1:-}" w="so.id <> '$B25PHYS_UUID'"
  if [ -n "$csv" ]; then stage2a_smoke_rows_validate "$csv" || return 1; w="$w and so.id not in ('$(printf '%s' "$csv" | sed "s/,/','/g")')"; fi
  printf '%s' "$w"
}
stage2a_protected_facts() {   # [smoke uuid csv] → key=value facts about P (counts, booleans and md5 digests only; includes the exception / census facts)
  local csv="${1:-}" W live assoc
  if ! W="$(stage2a_protected_where "$csv")"; then echo "protected_where_ok=false"; return 0; fi
  echo "protected_where_ok=true"
  live="$(stage2a_live_row_sql 'so.')"; assoc="$(stage2a_assoc_sql 'so.')"
  q "select 'protected_rows='||count(*)||E'\n'||'protected_live_ok='||count(*) filter (where $live)||E'\n'||'protected_assoc_ok='||count(*) filter (where $live and $assoc)||E'\n'||'protected_other='||(count(*) - count(*) filter (where $live))||E'\n'||'protected_bytes='||coalesce(sum(so.size_bytes) filter (where $live), 0)||E'\n'||'protected_companies='||count(distinct so.company_id)||E'\n'||'protected_kinds='||count(distinct so.kind)||E'\n'||'protected_md5='||md5(coalesce(string_agg(so.id||'|'||so.company_id||'|'||so.kind||'|'||so.state||'|'||so.driver||'|'||coalesce(so.sha256,'')||'|'||coalesce(so.size_bytes::text,'')||'|'||coalesce(so.mirror_key,'')||'|'||coalesce(so.mirror_state,'')||'|'||coalesce(so.last_error,'')||'|'||coalesce(so.lease_token,'')||'|'||so.storage_key||'|'||so.updated_at::text, ',' order by so.id), ''))||E'\n'||'protected_keys_md5='||md5(coalesce(string_agg(so.storage_key, E'\n' order by so.storage_key collate \"C\"), '')) from storage_objects so where $W"
  # Correction 7: tenant_keys_md5 = the stored keys of P (every row outside the exception and the recorded smoke rows) —
  # the value the pre-smoke record carries (the list is empty before the smoke), comparable in EVERY form (live, recorded,
  # tombstone, post-settle, final); tenant_live_keys_md5 = P + the ACTIVE recorded smoke rows = the file set the volume must
  # hold at this instant (live forms: P + the smoke files; tombstone form: P only, the smoke files already purged). The
  # failed run 39880703889 showed the former single digest changing with the smoke keys and breaking the record comparison.
  local LW="$W"
  if [ -n "$csv" ]; then LW="so.id <> '$B25PHYS_UUID' and (so.id not in ('$(printf '%s' "$csv" | sed "s/,/','/g")') or so.state = 'active')"; fi
  echo "tenant_keys_md5=$(q "select md5(coalesce(string_agg(so.storage_key, E'\n' order by so.storage_key collate \"C\"), '')) from storage_objects so where $W")"
  echo "tenant_live_keys_md5=$(q "select md5(coalesce(string_agg(so.storage_key, E'\n' order by so.storage_key collate \"C\"), '')) from storage_objects so where $LW")"
  stage2a_exception_facts
  local rows_b64 fj k mrows_b64 mj
  rows_b64="$(q "select json_build_object('marker', '', 'rows', coalesce(json_agg(json_build_object('id', so.id, 'k', so.storage_key, 's', so.size_bytes)), '[]'::json)) from storage_objects so where $W" | base64 -w0)"
  fj="$(api_node "$STAGE2A_FS_VERIFY_JS" "$rows_b64")"; echo "  protected fs: $fj" >&2
  echo "pf_read_ok=$(census_field "$fj" rows count >/dev/null 2>&1 && echo true || echo false)"
  for k in rows present regular owner_ok mode_ok magic_ok pdf_free size_differs tenant_files other_files symlinks; do echo "pf_$k=$(census_field "$fj" "$k" count 2>/dev/null || echo '?')"; done
  echo "pf_cipher_md5=$(census_field "$fj" rows_cipher_md5 hex32 2>/dev/null || echo '?')"
  echo "pf_tenant_keys_md5=$(census_field "$fj" tenant_files_md5 hex32 2>/dev/null || echo '?')"
  mrows_b64="$(q "select coalesce(json_agg(json_build_object('id', so.id, 'k', so.storage_key, 'm', so.mirror_key, 's', so.size_bytes, 'sha', so.sha256)), '[]'::json) from storage_objects so where $W" | base64 -w0)"
  mj="$(api_node "$STAGE2A_MIRROR_JS" "$mrows_b64")"; echo "  protected mirror: $mj" >&2
  echo "pm_read_ok=$(census_field "$mj" rows count >/dev/null 2>&1 && echo true || echo false)"
  for k in rows present bucket_ok canonical_key marker_ok generation_ok size_ok sha_ok generation_digits_min; do echo "pm_$k=$(census_field "$mj" "$k" count 2>/dev/null || echo '?')"; done
  echo "pm_generations_md5=$(census_field "$mj" generations_md5 hex32 2>/dev/null || echo '?')"
  # the partition's expected bytes are DERIVED from verified evidence: the four originals' recorded sizes (size-matched
  # against the provider by the originals probe above) + the exception's constant size + the protected / smoke plaintext sizes
  echo "originals_bytes=$(q "select coalesce(sum(file_size), 0) from export_runs where object_path ~ '$LEGACY_HANDLE'")"
  echo "refs_legacy_count=$(references_legacy "$csv")"
  echo "refs_ambiguous=$(references_ambiguous "$csv")"
}
S2A_PROTECTED_RECORD_KEYS="protected_rows protected_md5 protected_bytes protected_keys_md5 tenant_keys_md5 pf_cipher_md5 pm_generations_md5 refs_legacy_count"
stage2a_protected_record_line() {   # <facts> → B25_PROTECTED_SET=<one base64 line> (the database clock, counts and md5 digests only; shape-checked)
  local F="$1" rec k
  rec="$( { echo "protected_at=$(q "select to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS.US')")"; for k in $S2A_PROTECTED_RECORD_KEYS; do echo "rec_$k=$(s2a_fv "$F" "$k")"; done; } )" || fail "protected-set record unreadable"
  s2a_facts_ok "$rec" || fail "protected-set record has an unexpected shape (not printed)"
  [ "$(printf '%s\n' "$rec" | grep -cE '^rec_[a-z0-9_]+=([0-9]+|[0-9a-f]{32})$')" = "8" ] || fail "protected-set record incomplete (not printed)"
  echo "B25_PROTECTED_SET=$(printf '%s\n' "$rec" | base64 -w0)"
}
stage2a_protected_recorded_facts() {   # ← the shell variable B25_PROTECTED_SET (first stdin line of this session) → the rec_* facts; fails closed without it
  s2a_b64_line_ok "${B25_PROTECTED_SET:-}" || fail "pre-smoke protected-set record missing or malformed on the stdin stream — fail closed (no verdict without it)"
  local rec; rec="$(printf '%s' "$B25_PROTECTED_SET" | base64 -d 2>/dev/null)" || fail "protected-set record does not decode"
  s2a_facts_ok "$rec" || fail "protected-set record has an unexpected shape"
  [ "$(printf '%s\n' "$rec" | grep -cE '^rec_(protected_rows|protected_md5|protected_bytes|protected_keys_md5|tenant_keys_md5|pf_cipher_md5|pm_generations_md5|refs_legacy_count)=([0-9]+|[0-9a-f]{32})$')" = "8" ] || fail "protected-set record incomplete"
  printf '%s\n' "$rec" | grep -E '^(protected_at|rec_[a-z0-9_]+)='
}
stage2a_protected_gate() {   # <label> <smoke uuid csv or ''> <smoke bytes> <none|require> [live|tombstone] → facts + verdict (fails closed); exports S2A_PROTECTED_N / _BYTES / _FACTS
  local label="$1" csv="$2" sb="$3" rec="$4" form="${5:-live}" facts verdict R=0
  [[ "$sb" =~ ^[0-9]+$ ]] || fail "protected gate: smoke bytes malformed"
  [[ "$rec" =~ ^(none|require)$ ]] || fail "protected gate: record mode malformed"
  [[ "$form" =~ ^(live|tombstone)$ ]] || fail "protected gate: smoke-row form malformed"
  section "protected live inventory ($label): storage_objects = the Stage 1 exception + every live row of the real tenants + the recorded smoke rows; files, mirrors, bucket partition and legacy references re-proven (counts, booleans and digests only)"
  facts="$(stage2a_protected_facts "$csv")" || fail "protected set unreadable"
  if [ "$rec" = require ]; then facts+=$'\n'"$(stage2a_protected_recorded_facts)"; fi
  printf '%s\n' "$facts" | grep -E '^(protected_|tenant_keys_md5|pf_|pm_|rec_|inv_|exc_(row_count|state|last_error|driver|company|size|provider_present|generation_digest)|census_|unmarked_|originals_|refs_)' | sed 's/^/  /'
  [ -n "$csv" ] && R=$(($(printf '%s' "$csv" | tr -cd ',' | wc -c) + 1))
  if verdict="$(printf '%s\n' "$facts" | stage2a_protected_eval "$R" "$sb" "$rec" "$form")"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "protected live inventory ($label) FAILED — see the FAIL lines above; nothing is changed and nothing is repaired by this tooling"; fi
  printf '%s\n' "$verdict" | grep -qx 'B25_STAGE2A_PROTECTED_GATE=PASS' || fail "protected live inventory ($label) FAILED — see the FAIL lines above; nothing is changed and nothing is repaired by this tooling"
  S2A_PROTECTED_N="$(s2a_fv "$facts" protected_rows)"; S2A_PROTECTED_BYTES="$(s2a_fv "$facts" protected_bytes)"; S2A_PROTECTED_FACTS="$facts"
}

# ---- stage2a-protected-inventory-inspect (READ-ONLY; no input, no ARG; every confirmation refused by the workflow) ----
# Proves the CURRENT protected live inventory and its physical locations: host / deployment / readiness / runtime
# configuration / schema fingerprint / volume, then the protected set (every row outside the Stage 1 exception
# independently proven: tenant, identity, kind, key, mirror, state, hygiene, digest, size, encrypted file, mirror
# object, product association), the bucket partition, the reference reconciliation, the Stage 1 exception. Prints
# counts, booleans, digests and fixed tokens only; never fails before the summary; the marker
# B25_STAGE2A_PROTECTED_INVENTORY_READY is TRUE only when every condition holds. No record is compared (none exists
# outside a smoke) and none is produced.
stage2a_protected_inventory_run() {
  declare -f stage2a_protected_eval >/dev/null || fail "apply library not loaded (stream b25-stage1-apply-lib.sh before this script)"
  local facts="" rf cid verdict hv="" hf=0 pf=0 n=0
  cid="$(compose ps -q api || true)"
  section "0. read-only guard"; stage2a_readonly_guard
  section "1. host / deployment / containers / readiness"
  facts+="$(stage2a_host_facts)"$'\n'; facts+="$(stage2a_container_facts "$cid")"$'\n'; facts+="$(stage2a_readyz_facts)"$'\n'
  printf '%s\n' "$facts" | grep -E '^(head_sha|current_deploy_sha|dirty|worktrees|lock_absent|deploy_settled|api_running|api_health|web_health|pg_health|readyz_status|readyz_database|readyz_storage|readyz_inside|storage_jobs_active|dead_storage_jobs|dead_jobs_total|schema_fingerprint|env_mode|key_line_count|env_core_identity_ok)=' | sed 's/^/  /'
  section "2. storage runtime configuration (startup record, banner; names and fixed values only)"
  facts+="$(stage2a_init_facts "$cid")"$'\n'
  printf '%s\n' "$facts" | grep -E '^(init_record_found|init_driver|init_fallback|init_mirror|init_legacy_delete|init_encryption|banner_driver|banner_fallback|banner_mirror)=' | sed 's/^/  /'
  section "3. the named volume"
  rf="$(stage2a_root_facts "$cid")"; facts+="$rf"$'\n'; facts+="root_entries_allowed=$(stage2a_root_entries_allowed "$rf")"$'\n'
  printf '%s\n' "$rf" | grep -E '^(mount_type|mount_name|mount_rw|root_owner|root_mode|root_is_symlink|root_is_dir|root_tenant_files|root_regular_files|root_symlinks|root_other_entries)=' | sed 's/^/  /'
  section "4. protected live inventory: every row outside the Stage 1 exception proven independently; files; mirrors; partition; references; the exception"
  facts+="$(stage2a_protected_facts)"$'\n'
  printf '%s\n' "$facts" | grep -E '^(protected_|tenant_keys_md5|pf_|pm_|inv_|exc_(row_count|state|last_error|driver|company|size|identity_ok|uncertain|lease|live_refs|provider_present|provider_marker_ok|provider_size_matches|generation_canonical|generation_stable|generation_digest)|census_(objects|bytes|marked|generationless)|unmarked_|originals_|refs_)=' | sed 's/^/  /'
  section "5. decision (read-only; nothing is changed)"
  local g; g() { printf '%s\n' "$facts" | awk -F= -v k="$1" '$1==k{print substr($0, length(k)+2); exit}'; }
  hc() { n=$((n + 1)); if [ "$2" = "0" ]; then echo "inventory host $n: $1 — OK ($3)"; else echo "inventory host $n: $1 — FAIL ($3)"; hf=$((hf + 1)); fi; }
  local ok
  ok=1; [ "$(g head_sha)" = "$STAGE2A_PRODUCT_SHA" ] && [ "$(g current_deploy_sha)" = "$STAGE2A_PRODUCT_SHA" ] && [ "$(g dirty)" = "0" ] && [ "$(g lock_absent)" = "true" ] && ok=0
  hc "hosted checkout and current-deploy.sha = the locked product commit, clean, no activation lock" $ok "head=$(g head_sha) current=$(g current_deploy_sha) dirty=$(g dirty) lock_absent=$(g lock_absent)"
  ok=1; [ "$(g api_running)" = "true" ] && [ "$(g api_health)" = "healthy" ] && [ "$(g readyz_status)" = "ok" ] && [ "$(g readyz_database)" = "ok" ] && [ "$(g readyz_storage)" = "ok" ] && ok=0
  hc "api running and healthy; readiness ok / database ok / storage ok" $ok "api=$(g api_running)/$(g api_health) status=$(g readyz_status) database=$(g readyz_database) storage=$(g readyz_storage)"
  ok=1; [ "$(g init_record_found)" = "true" ] && [ "$(g init_driver)" = "fs" ] && [ "$(g init_fallback)" = "true" ] && [ "$(g init_mirror)" = "true" ] && [ "$(g init_legacy_delete)" = "false" ] && ok=0
  hc "storage runtime = fs primary, legacy fallback on, strict mirror on, legacy delete off (the activated Stage 2A configuration)" $ok "found=$(g init_record_found) driver=$(g init_driver) fallback=$(g init_fallback) mirror=$(g init_mirror) legacy_delete=$(g init_legacy_delete)"
  ok=1; [ "$(g schema_fingerprint)" = "$FP_AFTER" ] && ok=0
  hc "schema fingerprint = the accepted post-apply fingerprint" $ok "fingerprint=$(g schema_fingerprint)"
  ok=1; [ "$(g mount_type)" = "volume" ] && [ "$(g mount_name)" = "$STAGE2A_VOLUME" ] && [ "$(g root_owner)" = "$STAGE2A_ROOT_OWNER" ] && [ "$(g root_mode)" = "$STAGE2A_ROOT_MODE" ] && [ "$(g root_is_symlink)" = "false" ] && [ "$(g root_entries_allowed)" = "true" ] && [ "$(g root_tenant_files)" = "$(g protected_rows)" ] && ok=0
  hc "the named volume at the root: owner / mode / no symlink / only tenants + health; tenant files = the protected rows" $ok "type=$(g mount_type) owner=$(g root_owner) mode=$(g root_mode) symlink=$(g root_is_symlink) entries_allowed=$(g root_entries_allowed) tenant_files=$(g root_tenant_files) protected_rows=$(g protected_rows)"
  ok=1; [ "$(g dead_jobs_total)" = "0" ] && [ "$(g pf_read_ok)" = "true" ] && [ "$(g pm_read_ok)" = "true" ] && ok=0
  hc "no dead-letter job; both in-container probes (files, mirrors) answered" $ok "dead_jobs=$(g dead_jobs_total) fs_probe=$(g pf_read_ok) mirror_probe=$(g pm_read_ok)"
  verdict="$(printf '%s\n' "$facts" | stage2a_protected_eval 0 0 none live)" || true; printf '%s\n' "$verdict"
  pf="$(printf '%s\n' "$verdict" | sed -nE 's/^B25_STAGE2A_PROTECTED_CONDITIONS_FAILED=([0-9]+)$/\1/p')"; [[ "$pf" =~ ^[0-9]+$ ]] || pf=99
  section "6. summary (counts, booleans and digests only)"
  echo "  protected_rows=$(g protected_rows) ownership_valid=$(g protected_live_ok) association_valid=$(g protected_assoc_ok) encrypted_fs_files=$(g pf_present) verified_mirrors=$(g pm_sha_ok) unrelated_rows=$(g protected_other) tenant_companies=$(g protected_companies)"
  echo "  uncertain=$(g inv_uncertain) unproven=$(g inv_unproven) cleanup_pending=$(g inv_cleanup_pending) leased=$(g inv_leases) inflight=$(g inv_inflight) retained_legacy=$(g inv_retained_legacy) inventory_total=$(g inv_total)"
  echo "  references: legacy=$(g refs_legacy_count) (expected 4) ambiguous=$(g refs_ambiguous) (expected 0)"
  echo "  provider partition: objects=$(g census_objects) = 4 originals (unmarked=$(g unmarked_objects), locked digest match=$([ "$(g unmarked_md5)" = "$B25PHYS_ORIGINALS_MD5" ] && echo true || echo false)) + 1 exception + $(g protected_rows) protected mirrors; marked=$(g census_marked); generationless=$(g census_generationless); bytes=$(g census_bytes)"
  echo "  Stage 1 exception: state=$(g exc_state) last_error=$(g exc_last_error) driver=$(g exc_driver) provider=$(g exc_provider_present) generation_digest=$(g exc_generation_digest) (expected $B25PHYS_PRE_GEN_DIGEST)"
  echo "  runtime: readyz=$(g readyz_status)/$(g readyz_database)/$(g readyz_storage) fingerprint=$(g schema_fingerprint) product=$(g head_sha)"
  echo "  read errors: fs_probe_ok=$(g pf_read_ok) mirror_probe_ok=$(g pm_read_ok)"
  echo "  failed predicates: host=$hf protected=$pf"
  echo "B25_STAGE2A_PROTECTED_INVENTORY_FAILED=$((hf + pf))"
  rm -f "$HOME"/.b25-s1-node.err
  if [ "$hf" = "0" ] && [ "$pf" = "0" ]; then echo "B25_STAGE2A_PROTECTED_INVENTORY_READY=TRUE"; return 0; fi
  echo "B25_STAGE2A_PROTECTED_INVENTORY_READY=FALSE"; return 1
}
phase_stage2a_protected_inventory_inspect() {   # no argument is read: nothing is selected by an input (the read-only phases never reference ARG1-3)
  if stage2a_protected_inventory_run; then log "stage2a-protected-inventory-inspect complete (read-only; nothing changed; B25_STAGE2A_PROTECTED_INVENTORY_READY=TRUE)"
  else fail "stage2a-protected-inventory-inspect: conditions not met (read-only; nothing changed; B25_STAGE2A_PROTECTED_INVENTORY_READY=FALSE)"; fi
}

# ---- Correction 6: READ-ONLY company-change inspection (no input, no ARG): host / runtime / fingerprint / volume, the protected
# live inventory (Correction 5, pre-smoke form), the historical anchor, the start-gate evidence with the company-row
# classification; prints B25_STAGE2A_COMPANY_CHANGE_PROVEN and B25_STAGE2A_TENANT_START_READINESS; writes nothing ----
stage2a_company_change_run() {
  declare -f stage2a_company_change_classify >/dev/null || fail "apply library not loaded (stream b25-stage1-apply-lib.sh before this script)"
  local facts="" rf cid verdict hf=0 pf=0 n=0 sfacts sverdict c6 cls reasons sg=FAIL proven=FALSE ready=FALSE cok=false
  cid="$(compose ps -q api || true)"
  section "0. read-only guard"; stage2a_readonly_guard
  section "1. host / deployment / containers / readiness"
  facts+="$(stage2a_host_facts)"$'\n'; facts+="$(stage2a_container_facts "$cid")"$'\n'; facts+="$(stage2a_readyz_facts)"$'\n'
  printf '%s\n' "$facts" | grep -E '^(head_sha|current_deploy_sha|dirty|worktrees|lock_absent|deploy_settled|api_running|api_health|web_health|pg_health|readyz_status|readyz_database|readyz_storage|readyz_inside|schema_fingerprint|storage_jobs_active|dead_storage_jobs|dead_jobs_total|env_mode|key_line_count|env_core_identity_ok)=' | sed 's/^/  /'
  section "2. storage runtime configuration (startup record, banner; names and fixed values only)"
  facts+="$(stage2a_init_facts "$cid")"$'\n'
  printf '%s\n' "$facts" | grep -E '^(init_record_found|init_driver|init_fallback|init_mirror|init_legacy_delete|init_encryption|banner_driver|banner_fallback|banner_mirror)=' | sed 's/^/  /'
  section "3. the named volume"
  rf="$(stage2a_root_facts "$cid")"; facts+="$rf"$'\n'; facts+="root_entries_allowed=$(stage2a_root_entries_allowed "$rf")"$'\n'
  printf '%s\n' "$rf" | grep -E '^(mount_type|mount_name|mount_rw|root_owner|root_mode|root_is_symlink|root_is_dir|root_tenant_files|root_regular_files|root_symlinks|root_other_entries)=' | sed 's/^/  /'
  section "4. protected live inventory (Correction 5, pre-smoke form): every row outside the Stage 1 exception proven independently; files; mirrors; partition; references; the exception"
  facts+="$(stage2a_protected_facts)"$'\n'
  printf '%s\n' "$facts" | grep -E '^(protected_|tenant_keys_md5|pf_|pm_|inv_|exc_(row_count|state|last_error|driver|company|size|identity_ok|uncertain|lease|live_refs|provider_present|provider_marker_ok|provider_size_matches|generation_canonical|generation_stable|generation_digest)|census_(objects|bytes|marked|generationless)|originals_|refs_)' | sed 's/^/  /'
  verdict="$(printf '%s\n' "$facts" | stage2a_protected_eval 0 0 none live)" || true; printf '%s\n' "$verdict"
  pf="$(printf '%s\n' "$verdict" | sed -nE 's/^B25_STAGE2A_PROTECTED_CONDITIONS_FAILED=([0-9]+)$/\1/p')"; [[ "$pf" =~ ^[0-9]+$ ]] || pf=99
  section "5. the historical review anchor (reviewed constants; never an input) and the company-row attribution since the review instant $S2A_TENANT_REVIEW_UTC"
  if s2a_c6_constants_ok; then cok=true; fi
  echo "  anchor_run=$S2A_C6_ANCHOR_RUN anchor_at=$S2A_C6_ANCHOR_AT review_utc=$S2A_TENANT_REVIEW_UTC bracket_seconds=$S2A_C6_BRACKET_SECONDS anchor_constants_ok=$cok"
  sfacts="$(stage2a_tenant_since_facts "$S2A_TENANT_REVIEW_UTC")" || fail "company change inspection: tenant evidence unreadable"
  s2a_facts_ok "$sfacts" || fail "company change inspection: tenant evidence has an unexpected shape (not printed)"
  printf '%s\n' "$sfacts" | grep -E '^(review_utc_ok|users_|sec_audit|roles_|user_roles|company_modified|sub_|sweep_|tenant_storage|references|c6_)' | sed 's/^/  /'
  c6="$(stage2a_company_change_classify "$sfacts")"; cls="$(printf '%s\n' "$c6" | sed -nE 's/^c6_classification=([A-Z_]+)$/\1/p')"; reasons="$(printf '%s\n' "$c6" | sed -nE 's/^c6 reasons: (.*)$/\1/p')"
  [[ "$cls" =~ ^[A-Z_]+$ ]] || cls=UNCLASSIFIED
  echo "  classification=$cls reasons=${reasons:--}"
  section "6. the tenant START gate (Correction 3 with the Correction 6 company-row rule; the gate that stopped run 39840120375)"
  if sverdict="$(printf '%s\n' "$sfacts" | stage2a_tenant_start_eval)"; then sg=PASS; else sg=FAIL; fi; printf '%s\n' "$sverdict"
  section "7. decision (read-only; nothing is changed)"
  local g; g() { printf '%s\n' "$facts" | awk -F= -v k="$1" '$1==k{print substr($0, length(k)+2); exit}'; }
  hc() { n=$((n + 1)); if [ "$2" = "0" ]; then echo "company-change host $n: $1 — OK ($3)"; else echo "company-change host $n: $1 — FAIL ($3)"; hf=$((hf + 1)); fi; }
  local ok
  ok=1; [ "$(g head_sha)" = "$STAGE2A_PRODUCT_SHA" ] && [ "$(g current_deploy_sha)" = "$STAGE2A_PRODUCT_SHA" ] && [ "$(g dirty)" = "0" ] && [ "$(g lock_absent)" = "true" ] && ok=0
  hc "hosted checkout and current-deploy.sha = the locked product commit, clean, no activation lock" $ok "head=$(g head_sha) current=$(g current_deploy_sha) dirty=$(g dirty) lock_absent=$(g lock_absent)"
  ok=1; [ "$(g api_running)" = "true" ] && [ "$(g api_health)" = "healthy" ] && [ "$(g readyz_status)" = "ok" ] && [ "$(g readyz_database)" = "ok" ] && [ "$(g readyz_storage)" = "ok" ] && ok=0
  hc "api running and healthy; readiness ok / database ok / storage ok" $ok "api=$(g api_running)/$(g api_health) status=$(g readyz_status) database=$(g readyz_database) storage=$(g readyz_storage)"
  ok=1; [ "$(g init_record_found)" = "true" ] && [ "$(g init_driver)" = "fs" ] && [ "$(g init_fallback)" = "true" ] && [ "$(g init_mirror)" = "true" ] && [ "$(g init_legacy_delete)" = "false" ] && ok=0
  hc "storage runtime = fs primary, legacy fallback on, strict mirror on, legacy delete off (the activated Stage 2A configuration)" $ok "found=$(g init_record_found) driver=$(g init_driver) fallback=$(g init_fallback) mirror=$(g init_mirror) legacy_delete=$(g init_legacy_delete)"
  ok=1; [ "$(g schema_fingerprint)" = "$FP_AFTER" ] && ok=0
  hc "schema fingerprint = the accepted post-apply fingerprint" $ok "fingerprint=$(g schema_fingerprint)"
  ok=1; [ "$(g mount_type)" = "volume" ] && [ "$(g mount_name)" = "$STAGE2A_VOLUME" ] && [ "$(g root_owner)" = "$STAGE2A_ROOT_OWNER" ] && [ "$(g root_mode)" = "$STAGE2A_ROOT_MODE" ] && [ "$(g root_is_symlink)" = "false" ] && [ "$(g root_is_dir)" = "true" ] && [ "$(g root_entries_allowed)" = "true" ] && [ "$(g root_tenant_files)" = "$(g protected_rows)" ] && ok=0
  hc "the named volume at the root: owner / mode / no symlink / only tenants + health; tenant files = the protected rows" $ok "type=$(g mount_type) owner=$(g root_owner) mode=$(g root_mode) symlink=$(g root_is_symlink) entries_allowed=$(g root_entries_allowed) tenant_files=$(g root_tenant_files) protected_rows=$(g protected_rows)"
  ok=1; [ "$(g dead_jobs_total)" = "0" ] && [ "$(g pf_read_ok)" = "true" ] && [ "$(g pm_read_ok)" = "true" ] && ok=0
  hc "no dead-letter job; both in-container probes (files, mirrors) answered" $ok "dead_jobs=$(g dead_jobs_total) fs_probe=$(g pf_read_ok) mirror_probe=$(g pm_read_ok)"
  ok=1; [ "$cok" = true ] && ok=0
  hc "the historical review anchor is the reviewed Correction 4 snapshot (decodable, 12 digests, later than the review instant); no input supplied a date or a company" $ok "anchor_run=$S2A_C6_ANCHOR_RUN anchor_constants_ok=$cok"
  section "8. summary (counts, booleans, timestamps, digests and fixed tokens only)"
  local sv; sv() { printf '%s\n' "$sfacts" | awk -F= -v k="$1" '$1==k{print substr($0, length(k)+2); exit}'; }
  echo "  company: modified_since_review=$(sv company_modified_since) updated_at=$(sv c6_company_updated_at) updated_after_anchor=$(sv c6_company_updated_after_anchor) bracketed_by_last_branding_audit=$(sv c6_company_update_bracketed)"
  echo "  branding audit: rows=$(sv c6_branding_rows) update=$(sv c6_branding_update_rows) logo_replace=$(sv c6_logo_replace_rows) logo_remove=$(sv c6_logo_remove_rows) reset=$(sv c6_branding_reset_rows) tenant_actor=$(sv c6_branding_actor_tenant) other_actor=$(sv c6_branding_actor_other) entity_ok=$(sv c6_branding_entity_ok) first_at=$(sv c6_branding_first_at) last_at=$(sv c6_branding_last_at) last_action=$(sv c6_branding_last_action) ordered=$(sv c6_branding_ordered)"
  echo "  conflicting actions: organization=$(sv c6_organization_rows) platform_company=$(sv c6_company_patch_rows) security=$(sv c6_security_rows) billing=$(sv c6_billing_rows) identity=$(sv c6_identity_rows) other_modules=$(sv c6_other_rows)"
  echo "  logo: key_set=$(sv c6_logo_key_set) active_rows=$(sv c6_logo_rows_active) row_live=$(sv c6_logo_row_live) row_ok=$(sv c6_logo_row_ok) last_logo_action=$(sv c6_logo_last_action) state_matches=$(sv c6_logo_state_matches) foreign_refs=$(sv c6_foreign_logo_refs)"
  echo "  anchor continuity: company_identity_masked=$(sv c6_company_id_match_masked) company_status=$(sv c6_company_status_match) sub_core=$(sv c6_sub_core_match) sub_status=$(sv c6_sub_status_match) users=$(sv c6_users_count_match)/$(sv c6_users_active_match)/$(sv c6_users_md5_match) roles=$(sv c6_roles_count_match)/$(sv c6_roles_md5_match) user_roles=$(sv c6_user_roles_count_match)/$(sv c6_user_roles_md5_match)"
  echo "  identity tier since the review: users_created=$(sv users_created_since) users_removed=$(sv users_soft_deleted_since) users_modified=$(sv users_modified_since) login_explained=$(sv users_modified_login_explained) identity_audit=$(sv sec_audit_rows_since) roles_changed=$(sv roles_changed_since) user_roles_created=$(sv user_roles_created_since) subscription_modified=$(sv sub_modified_since) status_changed=$(sv sub_status_changed_since) storage_rows=$(sv tenant_storage_rows)/$(sv tenant_storage_live_ok) references=$(sv references)"
  echo "  protected inventory: rows=$(g protected_rows) ownership_valid=$(g protected_live_ok) association_valid=$(g protected_assoc_ok) files=$(g pf_present) mirrors=$(g pm_sha_ok) unrelated=$(g protected_other) uncertain=$(g inv_uncertain) unproven=$(g inv_unproven) cleanup_pending=$(g inv_cleanup_pending) leased=$(g inv_leases) inflight=$(g inv_inflight)"
  echo "  Stage 1 exception: state=$(g exc_state) last_error=$(g exc_last_error) driver=$(g exc_driver) provider=$(g exc_provider_present) generation_digest=$(g exc_generation_digest) (expected $B25PHYS_PRE_GEN_DIGEST)"
  echo "  runtime: readyz=$(g readyz_status)/$(g readyz_database)/$(g readyz_storage) fingerprint=$(g schema_fingerprint) product=$(g head_sha)"
  echo "  failed predicates: host=$hf protected=$pf start_gate=$sg classification=$cls"
  if [ "$cls" = "BRANDING_CHANGE_PROVEN" ] || [ "$cls" = "NO_COMPANY_CHANGE" ]; then proven=TRUE; fi
  echo "B25_STAGE2A_COMPANY_CHANGE_CLASSIFICATION=$cls"
  echo "B25_STAGE2A_COMPANY_CHANGE_PROVEN=$proven"
  if [ "$hf" = "0" ] && [ "$pf" = "0" ] && [ "$sg" = "PASS" ] && [ "$proven" = "TRUE" ]; then ready=TRUE; fi
  rm -f "$HOME"/.b25-s1-node.err
  echo "B25_STAGE2A_TENANT_START_READINESS=$ready"
  [ "$ready" = "TRUE" ]
}
phase_stage2a_company_change_inspect() {   # no argument is read: nothing is selected by an input (the read-only phases never reference an argument)
  if stage2a_company_change_run; then log "stage2a-company-change-inspect complete (read-only; nothing changed; B25_STAGE2A_TENANT_START_READINESS=TRUE)"
  else fail "stage2a-company-change-inspect: conditions not met (read-only; nothing changed; B25_STAGE2A_TENANT_START_READINESS=FALSE)"; fi
}

guards_stage2a_switched() {
  section "read-only guard"; stage2a_readonly_guard
  section "switched state"
  local head cur; head="$(git -C "$APP_DIR" rev-parse HEAD)"; cur="$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null || echo none)"
  echo "HEAD=$head current-deploy.sha=$cur dirty=$(git -C "$APP_DIR" status --porcelain | wc -l)"
  [ "$head" = "$STAGE2A_PRODUCT_SHA" ] && [ "$cur" = "$STAGE2A_PRODUCT_SHA" ] || fail "hosted checkout / current-deploy.sha is not the locked product commit"
  [ "$(git -C "$APP_DIR" status --porcelain | wc -l)" = "0" ] || fail "checkout dirty"
  [ -n "$API_CID" ] || fail "api not running"
  health || fail "health / readiness failed"
  docker logs "$API_CID" 2>&1 | grep -F "$STAGE2A_INIT_FS" >/dev/null || fail "storage initialization is not driver=fs / fallback on / mirror on / legacy delete off (activate first)"
  [ "$(fingerprint)" = "$FP_AFTER" ] || fail "schema fingerprint is not $FP_AFTER"
  [ "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data/objects"}}{{.Type}}:{{.Name}}{{end}}{{end}}' "$API_CID")" = "volume:$STAGE2A_VOLUME" ] || fail "objectdata is not mounted at /data/objects"
  [ "$(compose exec -T api sh -c 'stat -c %u:%g /data/objects')" = "$STAGE2A_ROOT_OWNER" ] && [ "$(compose exec -T api sh -c 'stat -c %a /data/objects')" = "$STAGE2A_ROOT_MODE" ] || fail "objectdata ownership / mode is not $STAGE2A_ROOT_OWNER / $STAGE2A_ROOT_MODE"
  section "inventory baseline = the Stage 1 exception + the protected live set (Correction 5: the exception-only rule is gone)"
  [ "$(q "select count(*) from storage_objects where id = '$B25PHYS_UUID' and state = 'deleted' and last_error = 'LEGACY_RETAINED' and driver = 'gcs' and company_id = $B25PHYS_COMPANY")" = "1" ] || fail "the Stage 1 exception row is not in its documented state"
  [ "$(q "select count(*) from storage_objects where publication_uncertain_at is not null or last_error in ('OWNERSHIP_UNPROVEN','CLEANUP_PENDING') or lease_token is not null")" = "0" ] || fail "uncertain / unproven / cleanup-pending / leased rows exist"
  [ "$(q "select count(*) from job_queue where status='dead'")" = "0" ] || fail "dead-letter jobs present"
  # Correction 3: the existing tenant is protected by the tiered start / post gates (stage2a_tenant_start_gate before
  # the disposable owner exists, stage2a_tenant_post_gate in the cleanup) instead of a frozen whole-tenant digest and a
  # fixed scan count — ordinary use of the product by the tenant no longer stops the smoke, while identity / security /
  # billing movement, smoke-caused or unattributed movement and cross-tenant association still fail closed.
  # Correction 5: every row outside the exception is a healthy live fs row of a real tenant, proven on disk and in the
  # bucket (the bucket partition replaces the locked census digest); a native key is never a legacy reference.
  stage2a_protected_gate "pre-smoke" "" 0 none
  [ "$(references_legacy)" = "$REFERENCES" ] || fail "legacy references changed"
}
stage2a_census_expect() {   # <objects> <bytes-or-skip> <marked> <md5-or-skip> <label>
  local cj o b wm im; cj="$(census)"; echo "$cj"
  o="$(census_field "$cj" objects count)" || fail "census: objects missing"; b="$(census_field "$cj" bytes count)" || fail "census: bytes missing"
  wm="$(census_field "$cj" with_marker count)" || fail "census: with_marker missing"; im="$(census_field "$cj" inventory_md5 hex32)" || fail "census: digest missing"
  [ "$o" = "$1" ] || fail "$5: objects=$o expected $1"
  [ "$2" = "skip" ] || [ "$b" = "$2" ] || fail "$5: bytes=$b expected $2"
  [ "$wm" = "$3" ] || fail "$5: marked=$wm expected $3"
  [ "$4" = "skip" ] || [ "$im" = "$4" ] || fail "$5: inventory digest differs from the locked pre-smoke census"
}
phase_stage2a_smoke_setup() {
  guards_stage2a_switched
  [[ "$ARG1" =~ ^\$2[aby]\$10\$.{53}$ ]] || fail "ARG1 is not a bcrypt hash"
  [[ "$ARG2" =~ ^b25-smoke-[a-z0-9]{6,12}-owner@b25smoke\.invalid$ ]] || fail "ARG2 is not the disposable owner address"
  stage2a_tenant_start_gate
  section "pre-smoke record of the protected live set (read with the tenant snapshot; carried back to the runner as one base64 line of counts and digests)"
  stage2a_protected_gate "pre-smoke record" "" 0 none
  stage2a_protected_record_line "$S2A_PROTECTED_FACTS"
  section "insert ONE disposable platform owner (the smoke creates its tenants and users through the API)"
  local pco uid; pco="$(q "select coalesce(min(company_id)::text,'null') from users where role='platform_owner' and deleted_at is null")"
  uid="$(qw "insert into users (email, name, role, company_id, password_hash, is_active, contact_visibility, company_visibility, permissions, email_verified_at) values ('$ARG2', 'B25 smoke operator (disposable)', 'platform_owner', $pco, '$ARG1', true, 'all', 'own', '{}'::jsonb, now()) returning id")"
  echo "disposable_owner_user_id=$uid"
  log "stage2a-smoke-setup complete"
}
# Encrypted-file proofs INSIDE the api container: for every smoke row the file at the stored key must be a
# regular file owned by the runtime, mode 600, carry the envelope magic, differ from the plaintext size and
# contain neither the plaintext marker nor the PDF header; the set of tenant files must equal the set of
# stored keys (digests compared; names never printed); nothing may exist outside tenants/ and health/.
STAGE2A_FS_VERIFY_JS=$(cat <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const a = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "{}");
const root = "/data/objects";
const marker = Buffer.from(String(a.marker || ""), "utf8");
const out = { rows: 0, present: 0, regular: 0, owner_ok: 0, mode_ok: 0, magic_ok: 0, marker_free: 0, pdf_free: 0, size_differs: 0, tenant_files: 0, tenant_files_md5: "", other_files: 0, health_files: 0, symlinks: 0 };
const rel = []; const shas = [];
function walk(dir, cb) { let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const e of ents) { const p = path.join(dir, e.name); if (e.isSymbolicLink()) { out.symlinks += 1; continue; } if (e.isDirectory()) walk(p, cb); else if (e.isFile()) cb(p); } }
walk(root, (p) => { const r = path.relative(root, p); if (r.startsWith("tenants/")) { out.tenant_files += 1; rel.push(r); } else if (r.startsWith("health/")) out.health_files += 1; else out.other_files += 1; });
rel.sort(); out.tenant_files_md5 = createHash("md5").update(rel.join("\n")).digest("hex");
for (const r of a.rows || []) {
  out.rows += 1;
  const p = path.join(root, ...String(r.k).split("/"));
  let st; try { st = fs.lstatSync(p); } catch { continue; }
  out.present += 1;
  if (!st.isFile()) continue;
  out.regular += 1;
  if (st.uid === 999 && st.gid === 999) out.owner_ok += 1;
  if ((st.mode & 0o777) === 0o600) out.mode_ok += 1;
  const size = Number(r.s); if (st.size !== size) out.size_differs += 1;
  if (st.size <= 8 * 1024 * 1024) {
    const buf = fs.readFileSync(p);
    if (buf.subarray(0, 4).toString("ascii") === "LCPO") out.magic_ok += 1;
    if (marker.length === 0 || !buf.includes(marker)) out.marker_free += 1;
    if (!buf.includes(Buffer.from("%PDF", "ascii"))) out.pdf_free += 1;
    shas.push(createHash("sha256").update(buf).digest("hex"));
  } else shas.push("large:" + st.size);
}
shas.sort(); out.rows_cipher_md5 = createHash("md5").update(shas.join("\n")).digest("hex");
console.log(JSON.stringify(out));
JS
)
# Mirror proofs INSIDE the api container through the provider SDK: the mirror object must sit in the configured
# bucket at the canonical key, carry the row's ownership marker, a canonical decimal generation and the row's
# plaintext size, and its bytes must hash to the row's digest (bounded download). Names never printed.
STAGE2A_MIRROR_JS=$(cat <<'JS'
const { Storage } = require("@google-cloud/storage");
const { createHash } = require("node:crypto");
(async () => {
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  const rows = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "[]");
  const storage = new Storage();
  const out = { rows: rows.length, present: 0, bucket_ok: 0, canonical_key: 0, marker_ok: 0, generation_ok: 0, size_ok: 0, sha_ok: 0, generation_digits_min: 0, generations_md5: "" };
  let minDigits = 0; const gens = [];
  for (const r of rows) {
    const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(String(r.m || ""));
    if (!m) continue;
    if (m[1] === bucket) out.bucket_ok += 1;
    if (m[2] === r.k) out.canonical_key += 1;
    const f = storage.bucket(m[1]).file(m[2]);
    let meta; try { [meta] = await f.getMetadata(); } catch (e) { if (e && e.code === 404) continue; throw e; }
    out.present += 1;
    if (meta.metadata && meta.metadata["lcp-object-id"] === r.id) out.marker_ok += 1;
    const gen = typeof meta.generation === "string" ? meta.generation : "";
    if (/^[1-9]\d*$/.test(gen)) { out.generation_ok += 1; minDigits = minDigits === 0 ? gen.length : Math.min(minDigits, gen.length); }
    gens.push(String(r.id) + ":" + gen);
    if (String(meta.size) === String(r.s)) out.size_ok += 1;
    if (Number(meta.size) <= 8 * 1024 * 1024) { const [buf] = await f.download(); if (createHash("sha256").update(buf).digest("hex") === r.sha) out.sha_ok += 1; }
  }
  out.generation_digits_min = minDigits;
  gens.sort(); out.generations_md5 = createHash("md5").update(gens.join("\n")).digest("hex");
  console.log(JSON.stringify(out));
})().catch((e) => console.log(JSON.stringify({ error: e.code || e.name || "unknown" })));
JS
)
# Provider absence proof for the Stage 2A settle (top-level copy of the Stage 1 reader, which is scoped to its phase):
# every persisted bucket location of a recorded tombstone (canonical key, legacy key when set, mirror key) must be absent.
STAGE2A_PROVIDER_ABSENT_JS=$(cat <<'JS'
const { Storage } = require("@google-cloud/storage");
(async () => {
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  const rows = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "[]");
  const storage = new Storage();
  const name = (gs) => { if (!gs) return null; const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(gs); return m ? { bucket: m[1], object: m[2] } : null; };
  const exists = async (b, o) => { try { await storage.bucket(b).file(o).getMetadata(); return true; } catch (e) { if (e && e.code === 404) return false; throw e; } };
  const out = [];
  for (const r of rows) {
    const l = name(r.l), m = name(r.m);
    const presence = { storage: await exists(bucket, r.k), legacy: l ? await exists(l.bucket, l.object) : null, mirror: m ? await exists(m.bucket, m.object) : null };
    out.push({ id: r.id, absent: B25_RULES.rowAbsent(presence) });
  }
  console.log(JSON.stringify({ checked: rows.length, absent: out.filter((o) => o.absent).length, present_ids: out.filter((o) => !o.absent).map((o) => o.id) }));
})().catch((e) => console.log(JSON.stringify({ error: e.code || e.name || "unknown" })));
JS
)
STAGE2A_FS_ABSENT_JS=$(cat <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const a = JSON.parse(Buffer.from(process.env.B25_ARG_B64 || "", "base64").toString("utf8") || "{}");
const root = "/data/objects";
const out = { checked: 0, absent: 0, tenant_files: 0, tenant_dirs: 0 };
for (const r of a.rows || []) { out.checked += 1; try { fs.lstatSync(path.join(root, ...String(r.k).split("/"))); } catch (e) { if (e && e.code === "ENOENT") out.absent += 1; } }
function walk(dir) { let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) { out.tenant_dirs += 1; walk(p); } else out.tenant_files += 1; } }
for (const c of a.companies || []) walk(path.join(root, "tenants", String(c)));
console.log(JSON.stringify(out));
JS
)
stage2a_fields_ok() {   # <json> <expected count> <field>... → fails when any field differs from the expected count
  local j="$1" n="$2" f v; shift 2
  for f in "$@"; do v="$(census_field "$j" "$f" count 2>/dev/null || echo "?")"; [ "$v" = "$n" ] || fail "$f=$v (expected $n)"; done
}
phase_stage2a_smoke_verify() {
  [[ "$ARG1" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "ARG1 must be a csv of company ids"
  [[ "$ARG2" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "ARG2 must be a csv of user ids"
  [ -z "$ARG3" ] || fail "ARG3 must be empty — the leak detector and the fixture facts travel on the stdin stream only"
  [[ "${B25_LEAK_DETECTOR:-}" =~ ^[A-Za-z0-9_-]{43}$ ]] || fail "leak detector missing or malformed on the stdin stream — fail closed"
  [[ "${B25_FIXTURE_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] && [[ "${B25_FIXTURE_SIZE:-}" =~ ^[1-9][0-9]*$ ]] || fail "fixture digest / size missing on the stdin stream — fail closed"
  [[ "${B25_FIXTURE_MARKER:-}" =~ ^B25-STAGE2A-PLAINTEXT-MARKER-[a-z0-9]{6,12}$ ]] || fail "fixture marker missing or malformed on the stdin stream"
  [[ "${B25_LOGO_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] && [[ "${B25_LOGO_SIZE:-}" =~ ^[1-9][0-9]*$ ]] || fail "logo digest / size missing on the stdin stream — fail closed"
  trap 'unset B25_LEAK_DETECTOR' EXIT
  local C="$ARG1" U="$ARG2"
  section "disposable targets (names verified)"
  [ "$(q "select count(*) from companies where id in ($C) and name not like 'B25 SMOKE %'")" = "0" ] || fail "a target company is not a smoke tenant"
  [ "$(q "select count(*) from users where id in ($U) and email not like '%@$SMOKE_DOMAIN'")" = "0" ] || fail "a target user is not a smoke user"
  [ "$(q "select count(*) from companies where id in ($C) and id = $B25PHYS_COMPANY")" = "0" ] || fail "the Stage 1 company id can never be a smoke target"
  section "inventory rows of the smoke tenants (fs primary; mirror recorded; no legacy location)"
  q "select 'row '||id||' company='||company_id||' kind='||kind||' state='||state||' driver='||driver||' legacy_key_set='||(legacy_key is not null)||' mirror_key_set='||(mirror_key is not null)||' mirror_state='||coalesce(mirror_state,'<null>')||' lease_cleared='||(lease_token is null)||' size='||coalesce(size_bytes::text,'null')||' sha_set='||(sha256 is not null)||' last_error='||case when coalesce(last_error,'') ~ '^[A-Z_]{0,40}$' then coalesce(last_error,'<null>') else '<non-code text, not printed>' end||' uncertain='||(publication_uncertain_at is not null) from storage_objects where company_id in ($C) order by created_at"
  [ "$(q "select count(*) from storage_objects where company_id not in ($C) and id = '$B25PHYS_UUID'")" = "1" ] || fail "the Stage 1 exception row is missing"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and id = '$B25PHYS_UUID'")" = "0" ] || fail "the Stage 1 exception can never be a smoke row"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and driver <> 'fs'")" = "0" ] || fail "a smoke row is not on the fs driver"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and state <> 'active'")" = "0" ] || fail "a smoke row is not active"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and (legacy_key is not null or mirror_key is null or mirror_state is distinct from 'ok' or lease_token is not null or lease_expires_at is not null or publication_uncertain_at is not null or sha256 is null or size_bytes is null)")" = "0" ] || fail "an active smoke row is inconsistent (legacy location / missing mirror / mirror not ok / lease / uncertainty / missing digest)"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and mirror_key <> 'gs://' || split_part(split_part(mirror_key, '://', 2), '/', 1) || '/' || storage_key")" = "0" ] || fail "a mirror location is not the canonical bucket key"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and last_error in ('OWNERSHIP_UNPROVEN','CLEANUP_PENDING')")" = "0" ] || fail "ownership-unproven / cleanup-pending residue"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and kind = 'document' and sha256 = '$B25_FIXTURE_SHA256' and size_bytes = $B25_FIXTURE_SIZE")" = "1" ] || fail "exactly one document row must carry the fixture digest and size"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and kind = 'branding_logo' and sha256 = '$B25_LOGO_SHA256' and size_bytes = $B25_LOGO_SIZE")" = "1" ] || fail "exactly one branding_logo row must carry the logo digest and size"
  local nrows; nrows="$(q "select count(*) from storage_objects where company_id in ($C)")"; echo "smoke_rows=$nrows"
  echo "smoke_row_ids=$(q "select string_agg(id::text, ',' order by created_at) from storage_objects where company_id in ($C)")"
  section "encrypted files on the volume (regular, runtime-owned, 0600, envelope magic, no plaintext marker, no PDF header; the tenant file set = the stored keys)"
  local rows_b64 fj expect_md5
  rows_b64="$(q "select json_build_object('marker', '$B25_FIXTURE_MARKER', 'rows', coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 's', size_bytes)), '[]'::json)) from storage_objects where company_id in ($C)" | base64 -w0)"
  fj="$(api_node "$STAGE2A_FS_VERIFY_JS" "$rows_b64")"; echo "$fj"
  stage2a_fields_ok "$fj" "$nrows" rows present regular owner_ok mode_ok magic_ok marker_free pdf_free size_differs
  stage2a_fields_ok "$fj" 0 other_files symlinks
  expect_md5="$(q "select md5(string_agg(storage_key, E'\n' order by storage_key collate \"C\")) from storage_objects where id <> '$B25PHYS_UUID'")"
  [ "$(census_field "$fj" tenant_files_md5 hex32)" = "$expect_md5" ] || fail "the tenant files on the volume are not exactly the stored keys of the smoke rows and the protected rows"
  echo "health namespace files at this instant: $(census_field "$fj" health_files count)"
  section "mirror objects in the bucket (marker = row id, canonical decimal generation, plaintext size, bytes hash to the row digest; names never printed)"
  local mrows_b64 mj
  mrows_b64="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 'm', mirror_key, 's', size_bytes, 'sha', sha256)), '[]'::json) from storage_objects where company_id in ($C)" | base64 -w0)"
  mj="$(api_node "$STAGE2A_MIRROR_JS" "$mrows_b64")"; echo "$mj"
  stage2a_fields_ok "$mj" "$nrows" rows present bucket_ok canonical_key marker_ok generation_ok size_ok sha_ok
  [ "$(census_field "$mj" generation_digits_min count)" -ge 10 ] || fail "a mirror generation is implausibly short"
  section "capability leak gate — token-specific literal detector of THIS run's capability (counts and verdicts only)"
  local api_body web_body n_api n_web n_audit n_err
  api_body="$(read_log_once "$API_CID" api)" || fail "api log unreadable — fail closed"
  web_body="$(read_log_once "$WEB_CID" web)" || fail "web log unreadable — fail closed"
  n_api="$(count_literal "$api_body" "$B25_LEAK_DETECTOR")" || fail "api log: literal count failed — fail closed"
  n_web="$(count_literal "$web_body" "$B25_LEAK_DETECTOR")" || fail "web log: literal count failed — fail closed"
  n_audit="$(qd "select count(*) from audit_logs where position(:'det' in metadata::text) > 0")" || fail "audit metadata: detector query failed — fail closed"
  n_err="$(qd "select count(*) from storage_objects where position(:'det' in coalesce(last_error, '')) > 0")" || fail "storage last_error: detector query failed — fail closed"
  [[ "$n_audit" =~ ^[0-9]+$ ]] && [[ "$n_err" =~ ^[0-9]+$ ]] || fail "detector queries returned no count — fail closed"
  echo "current-run capability (token-specific literal): api log lines=$n_api web log lines=$n_web audit metadata rows=$n_audit storage last_error rows=$n_err"
  [ "$n_api" = "0" ] || fail "this run's capability found in the api log ($n_api line(s))"
  [ "$n_web" = "0" ] || fail "this run's capability found in the web (proxy) log ($n_web line(s))"
  [ "$n_audit" = "0" ] || fail "this run's capability found in audit metadata ($n_audit row(s))"
  [ "$n_err" = "0" ] || fail "this run's capability found in storage last_error ($n_err row(s))"
  [ "$(q "select count(*) from audit_logs where metadata::text ~ 'gs://|/var/lib/docker|/data/objects|X-Goog-Signature'")" = "0" ] || fail "bucket / path / signature text found in audit metadata"
  echo "root path literal in logs: api=$(count_literal "$api_body" "$STAGE2A_FS_ROOT") web=$(count_literal "$web_body" "$STAGE2A_FS_ROOT") (both must be 0)"
  [ "$(count_literal "$api_body" "$STAGE2A_FS_ROOT")" = "0" ] && [ "$(count_literal "$web_body" "$STAGE2A_FS_ROOT")" = "0" ] || fail "the storage root path appears in a log"
  echo "api error-level lines: $(printf '%s\n' "$api_body" | grep -c '"level":50' || true); unhandled: $(printf '%s\n' "$api_body" | grep '"level":50' | grep -vc '"type":"_AppError"' || true); mirror failures: $(printf '%s\n' "$api_body" | grep -c 'strict mirror write failed' || true); integrity failures: $(printf '%s\n' "$api_body" | grep -c 'copy failed integrity verification' || true)"
  [ "$(printf '%s\n' "$api_body" | grep '"level":50' | grep -vc '"type":"_AppError"' || true)" = "0" ] || fail "unhandled error in the api log"
  [ "$(printf '%s\n' "$api_body" | grep -c 'strict mirror write failed' || true)" = "0" ] || fail "a strict mirror write failed during the smoke"
  unset api_body web_body
  local smoke_ids smoke_bytes
  smoke_ids="$(q "select string_agg(id::text, ',' order by created_at) from storage_objects where company_id in ($C)")"
  smoke_bytes="$(q "select coalesce(sum(size_bytes), 0) from storage_objects where company_id in ($C)")"
  stage2a_protected_gate "during the smoke" "$smoke_ids" "$smoke_bytes" require
  echo "storage driver: $(docker logs "$API_CID" 2>&1 | grep -oE '"driver":"[a-z]+","legacyFallback":(true|false),"mirror":(true|false)' | tail -1)"
  unset B25_LEAK_DETECTOR
  log "stage2a-smoke-verify complete"
}
# =============================================================================
# B25 STAGE 2A — CORRECTION 4: the switched guard in its MID-SMOKE form. Run 38958264416 stopped in this phase
# because the PRE-SMOKE form — "inventory = the exception row only" — was applied while the smoke's own two rows
# legitimately existed (the api was never recreated). guards_stage2a_switched is UNCHANGED and remains the gate of
# the smoke setup and of every read-only mode. The recreate phase now uses guards_stage2a_switched_with_smoke_rows:
# the same host checks, then "inventory = the Stage 1 exception + exactly the two rows recorded by THIS run's
# stage2a-smoke-verify" with every row predicate, the encrypted files, the mirror objects and the census re-proven
# (stage2a_midsmoke_eval in apply-lib). The two uuids and the run's fixture / logo facts arrive ONLY as the first
# lines of the stdin stream (shell variables of the streamed script): never an SSH argument, never a workflow input,
# never chosen by an operator.
# =============================================================================
stage2a_tmp_stderr_facts() {   # metadata of the in-container reader's temporary stderr file (present / size / mtime); never its contents
  local f="$HOME/.b25-s1-node.err"
  if [ -e "$f" ]; then
    echo "tmp_stderr_present=true"; echo "tmp_stderr_size=$(stat -c %s "$f" 2>/dev/null || echo '?')"
    echo "tmp_stderr_mtime=$(date -u -d "@$(stat -c %Y "$f" 2>/dev/null || echo 0)" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo '?')"
  else echo "tmp_stderr_present=false"; echo "tmp_stderr_size=0"; echo "tmp_stderr_mtime=-"; fi
}
stage2a_smoke_rows_validate() {   # <csv> → 0 only for exactly two canonical, distinct uuids, neither the Stage 1 exception
  local csv="$1" a b
  [[ "$csv" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12},[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || return 1
  a="${csv%,*}"; b="${csv#*,}"
  [ "$a" != "$b" ] && [ "$a" != "$B25PHYS_UUID" ] && [ "$b" != "$B25PHYS_UUID" ]
}
stage2a_midsmoke_facts() {   # <csv of the two recorded smoke row uuids> → key=value facts (counts, booleans, digests only)
  local csv="$1" Q n ok=false k
  stage2a_smoke_rows_validate "$csv" && ok=true
  n=0; [ -n "$csv" ] && n=$(($(printf '%s' "$csv" | tr -cd ',' | wc -c) + 1))
  echo "ms_ids_ok=$ok"; echo "ms_ids_count=$n"
  [ "$ok" = true ] || return 0
  Q="'$(printf '%s' "$csv" | sed "s/,/','/g")'"
  q "select 'ms_rows_named='||count(*)||E'\n'||'ms_rows_active='||count(*) filter (where state = 'active')||E'\n'||'ms_rows_fs='||count(*) filter (where driver = 'fs')||E'\n'||'ms_rows_legacy_null='||count(*) filter (where legacy_key is null)||E'\n'||'ms_rows_mirror_canonical='||count(*) filter (where mirror_key is not null and mirror_key = 'gs://' || split_part(split_part(mirror_key, '://', 2), '/', 1) || '/' || storage_key)||E'\n'||'ms_rows_mirror_ok='||count(*) filter (where mirror_state = 'ok')||E'\n'||'ms_rows_error_null='||count(*) filter (where last_error is null)||E'\n'||'ms_rows_not_uncertain='||count(*) filter (where publication_uncertain_at is null)||E'\n'||'ms_rows_no_lease='||count(*) filter (where lease_token is null and lease_expires_at is null)||E'\n'||'ms_rows_sized='||count(*) filter (where size_bytes is not null and size_bytes > 0)||E'\n'||'ms_rows_digest_ok='||count(*) filter (where sha256 ~ '^[0-9a-f]{64}\$')||E'\n'||'ms_rows_identity_ok='||count(*) filter (where coalesce(content_type, '') <> '' and ((kind = 'document' and reference = '/objects/' || id::text and storage_key = 'tenants/' || company_id || '/documents/' || id::text) or (kind = 'branding_logo' and reference ~ ('^branding/' || company_id || '/' || replace(id::text, '-', '') || '\\.(png|jpg|webp)\$') and $(logo_key_rule_sql))))||E'\n'||'ms_rows_fixture_match='||count(*) filter (where (kind = 'document' and sha256 = '$B25_FIXTURE_SHA256' and size_bytes = $B25_FIXTURE_SIZE) or (kind = 'branding_logo' and sha256 = '$B25_LOGO_SHA256' and size_bytes = $B25_LOGO_SIZE))||E'\n'||'ms_rows_document='||count(*) filter (where kind = 'document')||E'\n'||'ms_rows_logo='||count(*) filter (where kind = 'branding_logo')||E'\n'||'ms_rows_smoke_tenant='||count(*) filter (where company_id not in (1, $B25PHYS_COMPANY) and exists (select 1 from companies c where c.id = storage_objects.company_id and c.name like 'B25 SMOKE %'))||E'\n'||'ms_rows_companies='||count(distinct company_id)||E'\n'||'ms_rows_company1='||count(*) filter (where company_id = 1)||E'\n'||'ms_rows_company53='||count(*) filter (where company_id = $B25PHYS_COMPANY)||E'\n'||'ms_rows_bytes='||coalesce(sum(size_bytes), 0) from storage_objects where id in ($Q)"
  echo "ms_rows_outside=$(q "select count(*) from storage_objects where id <> '$B25PHYS_UUID' and id not in ($Q)")"
  echo "inv_company1=$(q "select count(*) from storage_objects where company_id = 1")"
  echo "inv_company53_outside_exception=$(q "select count(*) from storage_objects where company_id = $B25PHYS_COMPANY and id <> '$B25PHYS_UUID'")"
  stage2a_protected_facts "$csv"
  local rows_b64 fj expect_md5 mrows_b64 mj
  rows_b64="$(q "select json_build_object('marker', '$B25_FIXTURE_MARKER', 'rows', coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 's', size_bytes)), '[]'::json)) from storage_objects where id in ($Q)" | base64 -w0)"
  fj="$(api_node "$STAGE2A_FS_VERIFY_JS" "$rows_b64")"; echo "  fs: $fj" >&2
  for k in rows present regular owner_ok mode_ok magic_ok marker_free pdf_free size_differs tenant_files other_files symlinks; do echo "ms_fs_$k=$(census_field "$fj" "$k" count 2>/dev/null || echo '?')"; done
  expect_md5="$(q "select md5(string_agg(storage_key, E'\n' order by storage_key collate \"C\")) from storage_objects where id <> '$B25PHYS_UUID'")"
  echo "ms_fs_keys_match=$([ "$(census_field "$fj" tenant_files_md5 hex32 2>/dev/null || echo x)" = "$expect_md5" ] && echo true || echo false)"
  mrows_b64="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 'm', mirror_key, 's', size_bytes, 'sha', sha256)), '[]'::json) from storage_objects where id in ($Q)" | base64 -w0)"
  mj="$(api_node "$STAGE2A_MIRROR_JS" "$mrows_b64")"; echo "  mirror: $mj" >&2
  for k in rows present bucket_ok canonical_key marker_ok generation_ok size_ok sha_ok generation_digits_min; do echo "ms_mirror_$k=$(census_field "$mj" "$k" count 2>/dev/null || echo '?')"; done
  echo "dead_jobs=$(q "select count(*) from job_queue where status='dead'")"
  echo "references=$(references_legacy "$csv")"; echo "references_expected=$REFERENCES"
}
guards_stage2a_switched_with_smoke_rows() {   # <csv of the two smoke row uuids recorded by THIS run's stage2a-smoke-verify>
  local csv="$1" facts verdict head cur
  stage2a_smoke_rows_validate "$csv" || fail "mid-smoke guard: the smoke row list is not exactly two canonical, distinct uuids free of the Stage 1 exception — STOP"
  section "read-only guard"; stage2a_readonly_guard
  section "switched state (mid-smoke form: the host checks of guards_stage2a_switched, unchanged)"
  head="$(git -C "$APP_DIR" rev-parse HEAD)"; cur="$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null || echo none)"
  echo "HEAD=$head current-deploy.sha=$cur dirty=$(git -C "$APP_DIR" status --porcelain | wc -l)"
  [ "$head" = "$STAGE2A_PRODUCT_SHA" ] && [ "$cur" = "$STAGE2A_PRODUCT_SHA" ] || fail "hosted checkout / current-deploy.sha is not the locked product commit"
  [ "$(git -C "$APP_DIR" status --porcelain | wc -l)" = "0" ] || fail "checkout dirty"
  [ -n "$API_CID" ] || fail "api not running"
  health || fail "health / readiness failed"
  docker logs "$API_CID" 2>&1 | grep -F "$STAGE2A_INIT_FS" >/dev/null || fail "storage initialization is not driver=fs / fallback on / mirror on / legacy delete off"
  [ "$(fingerprint)" = "$FP_AFTER" ] || fail "schema fingerprint is not $FP_AFTER"
  [ "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data/objects"}}{{.Type}}:{{.Name}}{{end}}{{end}}' "$API_CID")" = "volume:$STAGE2A_VOLUME" ] || fail "objectdata is not mounted at /data/objects"
  [ "$(compose exec -T api sh -c 'stat -c %u:%g /data/objects')" = "$STAGE2A_ROOT_OWNER" ] && [ "$(compose exec -T api sh -c 'stat -c %a /data/objects')" = "$STAGE2A_ROOT_MODE" ] || fail "objectdata ownership / mode is not $STAGE2A_ROOT_OWNER / $STAGE2A_ROOT_MODE"
  section "inventory = the Stage 1 exception + exactly the two recorded smoke rows; their encrypted files, mirror objects and the census re-proven (mid-smoke form; counts, booleans and digests only)"
  facts="$(stage2a_midsmoke_facts "$csv")" || fail "mid-smoke evidence unreadable"
  facts+=$'\n'"$(stage2a_protected_recorded_facts)"
  printf '%s\n' "$facts" | grep -E '^(ms_|protected_|tenant_keys_md5|pf_|pm_|rec_|inv_|exc_(row_count|state|last_error|driver|company|size|provider_present|generation_digest)|census_|unmarked_|originals_|dead_jobs|references|refs_legacy_count)' | sed 's/^/  /'
  if verdict="$(printf '%s\n' "$facts" | stage2a_midsmoke_eval)"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "mid-smoke guard FAILED — see the FAIL lines above; the api is NOT recreated"; fi
  printf '%s\n' "$verdict" | grep -qx 'B25_STAGE2A_MIDSMOKE_GATE=PASS' || fail "mid-smoke guard FAILED — see the FAIL lines above; the api is NOT recreated"
  if verdict="$(printf '%s\n' "$facts" | stage2a_protected_eval 2 "$(s2a_num "$(s2a_fv "$facts" ms_rows_bytes)")" require)"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "mid-smoke protected live inventory FAILED — see the FAIL lines above; the api is NOT recreated"; fi
  printf '%s\n' "$verdict" | grep -qx 'B25_STAGE2A_PROTECTED_GATE=PASS' || fail "mid-smoke protected live inventory FAILED — see the FAIL lines above; the api is NOT recreated"
  S2A_PROTECTED_N="$(s2a_fv "$facts" protected_rows)"; S2A_PROTECTED_BYTES="$(s2a_fv "$facts" protected_bytes)"; S2A_PROTECTED_FACTS="$facts"
}
# The smoke-row uuids recorded by THIS run's stage2a-smoke-verify step and the fixture / logo facts of the same run
# arrive on the stdin stream only (B25_SMOKE_ROW_IDS, B25_FIXTURE_*, B25_LOGO_*); an ARG is refused.
phase_stage2a_recreate_api() {
  [ -z "$ARG1$ARG2$ARG3" ] || fail "stage2a-recreate-api takes no argument — the smoke rows travel on the stdin stream only"
  [[ "${B25_SMOKE_ROW_IDS:-}" =~ ^[0-9a-f-]{36},[0-9a-f-]{36}$ ]] || fail "smoke row uuids missing or malformed on the stdin stream — fail closed"
  [[ "${B25_FIXTURE_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] && [[ "${B25_FIXTURE_SIZE:-}" =~ ^[1-9][0-9]*$ ]] || fail "fixture digest / size missing on the stdin stream — fail closed"
  [[ "${B25_FIXTURE_MARKER:-}" =~ ^B25-STAGE2A-PLAINTEXT-MARKER-[a-z0-9]{6,12}$ ]] || fail "fixture marker missing or malformed on the stdin stream"
  [[ "${B25_LOGO_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] && [[ "${B25_LOGO_SIZE:-}" =~ ^[1-9][0-9]*$ ]] || fail "logo digest / size missing on the stdin stream — fail closed"
  local csv="$B25_SMOKE_ROW_IDS" Q rows_sql files_before rows_before vol_before head cur mrows_b64 mj
  Q="'$(printf '%s' "$csv" | sed "s/,/','/g")'"
  guards_stage2a_switched_with_smoke_rows "$csv"
  section "recreate ONLY the api container (force-recreate; web and postgres untouched; volumes untouched; the encrypted smoke files, their rows and their mirrors must survive unchanged)"
  rows_sql="select md5(coalesce(string_agg(id||'|'||state||'|'||driver||'|'||coalesce(sha256,'')||'|'||coalesce(size_bytes::text,'')||'|'||coalesce(mirror_key,'')||'|'||coalesce(mirror_state,'')||'|'||coalesce(last_error,'')||'|'||coalesce(lease_token,'')||'|'||storage_key||'|'||updated_at::text, ',' order by id), '')) from storage_objects where id <> '$B25PHYS_UUID'"
  [[ "$S2A_PROTECTED_N" =~ ^[0-9]+$ ]] || fail "protected row count unknown — the mid-smoke guard did not run"
  files_before="$(compose exec -T api sh -c 'find /data/objects/tenants -type f -exec sha256sum {} + 2>/dev/null | sort | md5sum | cut -c1-32')"
  rows_before="$(q "$rows_sql")"
  vol_before="$(docker volume inspect -f '{{.CreatedAt}}' "$STAGE2A_VOLUME")"
  stage2a_recreate_api || fail "api not healthy after recreation"
  echo "api_container=$API_CID readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz)"
  curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz | grep -q '"status":"ok"' || fail "readiness is not ok after recreation"
  head="$(git -C "$APP_DIR" rev-parse HEAD)"; cur="$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null || echo none)"
  [ "$head" = "$STAGE2A_PRODUCT_SHA" ] && [ "$cur" = "$STAGE2A_PRODUCT_SHA" ] || fail "product commit changed across the recreation"
  [ "$(docker volume inspect -f '{{.CreatedAt}}' "$STAGE2A_VOLUME")" = "$vol_before" ] || fail "objectdata volume identity changed"
  [ "$(compose exec -T api sh -c 'find /data/objects/tenants -type f -exec sha256sum {} + 2>/dev/null | sort | md5sum | cut -c1-32')" = "$files_before" ] || fail "the encrypted files (smoke + protected; set or ciphertext) changed across the recreation"
  [ "$(q "$rows_sql")" = "$rows_before" ] || fail "the smoke rows or the protected rows changed across the recreation"
  docker logs "$API_CID" 2>&1 | grep -F "$STAGE2A_INIT_FS" >/dev/null || fail "storage initialization after recreation is not fs / fallback / mirror / legacy delete off"
  mrows_b64="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 'm', mirror_key, 's', size_bytes, 'sha', sha256)), '[]'::json) from storage_objects where id <> '$B25PHYS_UUID'" | base64 -w0)"
  mj="$(api_node "$STAGE2A_MIRROR_JS" "$mrows_b64")"; echo "$mj"
  stage2a_fields_ok "$mj" "$((2 + S2A_PROTECTED_N))" rows present bucket_ok canonical_key marker_ok generation_ok size_ok sha_ok
  echo "ciphertext set digest unchanged across the recreation: $files_before; smoke + protected rows digest unchanged: $rows_before (protected rows: $S2A_PROTECTED_N)"
  log "stage2a-recreate-api complete"
}
# ARG1 = csv of disposable company ids (already deleted through the API), ARG2 = csv of the smoke row UUIDs recorded
# by stage2a-smoke-verify (the ONLY rows this phase may ever remove); ARG3 must be empty.
phase_stage2a_smoke_settle() {
  [[ "$ARG1" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "ARG1 must be a csv of company ids"
  [[ "$ARG2" =~ ^[0-9a-f-]{36}(,[0-9a-f-]{36})*$ ]] || fail "ARG2 must be a csv of the recorded smoke row uuids"
  [ -z "$ARG3" ] || fail "ARG3 must be empty"
  declare -f stage2a_purge_rows_sql >/dev/null || fail "purge library not loaded (stream b25-stage1-purge-lib.sh before this script)"
  local C="$ARG1" UUIDS_Q; UUIDS_Q="'$(printf '%s' "$ARG2" | sed "s/,/','/g")'"
  [[ ",$ARG2," != *",$B25PHYS_UUID,"* ]] || fail "the Stage 1 exception uuid can never be a recorded smoke row — STOP"
  [[ ",$C," != *",$B25PHYS_COMPANY,"* ]] || fail "the Stage 1 company id can never be a smoke company — STOP"
  section "wait for the purge job to settle the smoke tenants' tombstones (product lifecycle: fs file removed, mirror removed by marker + exact generation)"
  [ "$(q "select count(*) from companies where id in ($C)")" = "0" ] || fail "a smoke company still exists (API deletion did not happen)"
  local tries=0
  until [ "$(q "select count(*) from storage_objects where company_id in ($C) and state not in ('deleted')")" = "0" ]; do tries=$((tries + 1)); [ "$tries" -le 36 ] || break; sleep 10; done
  q "select 'tombstone '||id||' kind='||kind||' state='||state||' driver='||driver||' last_error='||case when coalesce(last_error,'') ~ '^[A-Z_]{0,40}$' then coalesce(last_error,'<null>') else '<non-code text, not printed>' end||' legacy_key_set='||(legacy_key is not null)||' mirror_key_set='||(mirror_key is not null)||' mirror_state='||coalesce(mirror_state,'<null>')||' uncertain='||(publication_uncertain_at is not null)||' reconciled='||(reconciled_at is not null) from storage_objects where company_id in ($C) order by created_at"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and state<>'deleted'")" = "0" ] || fail "a smoke tombstone did not settle to deleted within 6 minutes"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and (publication_uncertain_at is not null or last_error is not null)")" = "0" ] || fail "a smoke tombstone carries uncertainty or a retained / unproven / cleanup-pending state (an fs row with a removed mirror settles with last_error NULL)"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and (driver <> 'fs' or legacy_key is not null)")" = "0" ] || fail "a smoke tombstone is not an fs row without a legacy location"
  [ "$(q "select count(*) from storage_objects where company_id in ($C) and id not in ($UUIDS_Q)")" = "0" ] || fail "a smoke-company row was not recorded during this run — STOP, nothing removed"
  [ "$(q "select count(*) from storage_objects where id in ($UUIDS_Q) and company_id not in ($C)")" = "0" ] || fail "a recorded uuid belongs to a non-smoke company — STOP, nothing removed"
  local present_rows; present_rows="$(q "select count(*) from storage_objects where id in ($UUIDS_Q)")"; echo "expected_rows=$present_rows"
  section "prove the encrypted files are gone from the volume (every stored key absent; no file left under the smoke tenants)"
  local frows_b64 aj; frows_b64="$(q "select json_build_object('companies', array[$C], 'rows', coalesce(json_agg(json_build_object('id', id, 'k', storage_key)), '[]'::json)) from storage_objects where id in ($UUIDS_Q)" | base64 -w0)"
  aj="$(api_node "$STAGE2A_FS_ABSENT_JS" "$frows_b64")"; echo "$aj"
  [ "$(census_field "$aj" checked count)" = "$present_rows" ] && [ "$(census_field "$aj" absent count)" = "$present_rows" ] || fail "an encrypted file of a recorded tombstone still exists on the volume — its row is NOT removed; investigate"
  [ "$(census_field "$aj" tenant_files count)" = "0" ] || fail "a file remains under a smoke tenant directory"
  echo "empty tenant directories left behind (informational; no object): $(census_field "$aj" tenant_dirs count)"
  section "prove every persisted provider location of the recorded tombstones is absent (HEAD metadata; names never printed)"
  local loc_b64 pj; loc_b64="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 'm', mirror_key)), '[]'::json) from storage_objects where id in ($UUIDS_Q)" | base64 -w0)"
  pj="$(api_node "$PROVIDER_RULES_JS"$'\n'"$STAGE2A_PROVIDER_ABSENT_JS" "$loc_b64")"; echo "$pj"
  [ "$(census_field "$pj" checked count)" = "$present_rows" ] && [ "$(census_field "$pj" absent count)" = "$present_rows" ] || fail "a mirror / primary bucket location of a recorded tombstone still exists — its row is NOT removed; investigate"
  # Correction 5: with the recorded tombstones still present, the protected live set must equal the pre-smoke record
  # (tombstone form: the recorded rows are settled, without files or mirrors). A recorded uuid that were a protected
  # row would leave the set one row short of the record — the phase stops here and nothing is removed.
  if [ "$present_rows" != "0" ]; then stage2a_protected_gate "pre-settlement (the recorded tombstones present; every protected row outside the allow-list)" "$ARG2" 0 require tombstone; fi
  section "remove the EXACT recorded tombstones (Stage 2A allow-list; one row-locked transaction; the Stage 1 exception is denied by constant)"
  if [ "$present_rows" = "0" ]; then echo "already removed by a previous run — nothing to delete"
  else
    local triple; triple="$(qw "$(stage2a_purge_rows_sql "$UUIDS_Q" "$C" "$present_rows")")"
    purge_result_check "$triple" "$present_rows" || fail "the allow-listed delete did not remove exactly the expected rows (nothing is removed when any row differs)"
  fi
  [ "$(q "select count(*) from storage_objects where id in ($UUIDS_Q)")" = "0" ] || fail "a recorded tombstone remains"
  [ "$(q "select count(*) from storage_objects where company_id in ($C)")" = "0" ] || fail "a storage row of a smoke company remains"
  section "inventory, census and volume back to the pre-smoke state: the Stage 1 exception untouched; the protected live set identical to the pre-smoke record; no smoke file left"
  stage2a_protected_gate "post-settle" "" 0 require
  [ "$(q "select count(*) from storage_objects where id = '$B25PHYS_UUID' and state = 'deleted' and last_error = 'LEGACY_RETAINED' and driver = 'gcs' and company_id = $B25PHYS_COMPANY and size_bytes = $B25PHYS_OBJECT_SIZE and publication_uncertain_at is null and mirror_key is null and lease_token is null")" = "1" ] || fail "the Stage 1 exception row changed"
  echo "storage_objects total=$((1 + S2A_PROTECTED_N)) (the exception + $S2A_PROTECTED_N protected live rows) legacy_retained=$(q "select count(*) from storage_objects where last_error='LEGACY_RETAINED'") uncertain=0 unproven=0"
  log "stage2a-smoke-settle complete"
}
# ARG1 = csv of disposable company ids or 'none', ARG2 = csv of disposable user ids, ARG3 = tag
phase_stage2a_cleanup() {
  [[ "$ARG1" =~ ^([0-9]+(,[0-9]+)*|none)$ ]] || fail "ARG1 must be a csv of company ids or 'none'"
  [[ "$ARG2" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "ARG2 must be a csv of user ids"
  [[ "$ARG3" =~ ^[a-z0-9]{6,12}$ ]] || fail "ARG3 must be the smoke tag"
  local C="$ARG1" U="$ARG2" TAG="$ARG3" DOM="$SMOKE_DOMAIN"; [ "$C" = "none" ] && C="-1"
  [[ ",$C," != *",$B25PHYS_COMPANY,"* ]] || fail "the Stage 1 company id can never be a cleanup target — STOP"
  section "guard: every explicit target is disposable"
  q "select 'company '||id||': '||case when name like 'B25 SMOKE %' then 'disposable' else 'NOT DISPOSABLE' end from companies where id in ($C) order by id" || true
  [ "$(q "select count(*) from companies where id in ($C) and name not like 'B25 SMOKE %'")" = "0" ] || fail "a target company is not a smoke tenant"
  [ "$(q "select count(*) from users where id in ($U) and email not like '%@$DOM'")" = "0" ] || fail "a target user is not a smoke user"
  [ "$(q "select count(*) from users where company_id in ($C) and email not like '%@$DOM'")" = "0" ] || fail "a smoke tenant holds a non-smoke user"
  section "storage rows of the smoke tenants BEFORE any deletion (ids, state, key flags)"
  q "select 'row '||id||' company='||company_id||' kind='||kind||' state='||state||' driver='||driver||' mirror_key_set='||(mirror_key is not null)||' last_error='||case when coalesce(last_error,'') ~ '^[A-Z_]{0,40}$' then coalesce(last_error,'<null>') else '<non-code text, not printed>' end||' uncertain='||(publication_uncertain_at is not null) from storage_objects where company_id in ($C) order by created_at" || true
  echo "smoke_row_ids=$(q "select coalesce(string_agg(id::text, ',' order by created_at), '') from storage_objects where company_id in ($C)" 2>/dev/null || echo unavailable)"
  section "existing rows BEFORE cleanup (must be identical afterwards)"
  local kept_sql="select 'companies='||(select count(*) from companies where id not in ($C))||' users='||(select count(*) from users where id not in ($U) and (company_id is null or company_id not in ($C)))||' subscriptions='||(select count(*) from subscriptions where company_id not in ($C))||' contacts='||(select count(*) from contacts where company_id not in ($C))||' leads='||(select count(*) from leads where company_id not in ($C))||' events='||(select count(*) from events where company_id not in ($C))||' scans='||(select count(*) from scans where company_id not in ($C))||' documents='||(select count(*) from documents where company_id not in ($C))||' export_runs='||(select count(*) from export_runs where company_id not in ($C))||' audit='||(select count(*) from audit_logs where (company_id is null or company_id not in ($C)) and (user_id is null or user_id not in ($U)))||' activity='||(select count(*) from activity_logs where (company_id is null or company_id not in ($C)) and (user_id is null or user_id not in ($U)))||' login_attempts='||(select count(*) from login_attempts where email not like 'b25-smoke-${TAG}%@$DOM')||' storage_objects_other='||(select count(*) from storage_objects where company_id not in ($C))"
  local before; before="$(q "$kept_sql")"; echo "$before"
  section "delete the explicit disposable rows (child tables first, counted)"
  echo "sessions=$(qw "with d as (delete from sessions where user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
  echo "notifications=$(qw "with d as (delete from notifications where user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
  echo "audit_logs=$(qw "with d as (delete from audit_logs where company_id in ($C) or user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
  echo "activity_logs=$(qw "with d as (delete from activity_logs where company_id in ($C) or user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
  echo "login_attempts=$(qw "with d as (delete from login_attempts where email like 'b25-smoke-${TAG}%@$DOM' returning 1) select count(*) from d")"
  echo "document_versions=$(qw "with d as (delete from document_versions where company_id in ($C) returning 1) select count(*) from d")"
  echo "documents=$(qw "with d as (delete from documents where company_id in ($C) returning 1) select count(*) from d")"
  echo "tenant_users=$(qw "with d as (delete from users where company_id in ($C) returning 1) select count(*) from d")"
  echo "owner_users=$(qw "with d as (delete from users where id in ($U) and email like '%@$DOM' returning 1) select count(*) from d")"
  echo "subscriptions=$(qw "with d as (delete from subscriptions where company_id in ($C) returning 1) select count(*) from d")"
  echo "companies=$(qw "with d as (delete from companies where id in ($C) and name like 'B25 SMOKE %' returning 1) select count(*) from d")"
  section "storage rows of the smoke tenants (stage2a-smoke-settle must have removed the exact recorded tombstones)"
  [ "$(q "select count(*) from storage_objects where company_id in ($C)")" = "0" ] || fail "storage rows of a smoke tenant remain — stage2a-smoke-settle did not complete; re-run the smoke's settle step (never broaden cleanup)"
  section "verify zero other disposable rows remain"
  local z; z="$(q "select 'companies='||(select count(*) from companies where id in ($C) or name like 'B25 SMOKE %')||' users='||(select count(*) from users where id in ($U) or email like '%@$DOM')||' subscriptions='||(select count(*) from subscriptions where company_id in ($C))||' sessions='||(select count(*) from sessions where user_id in ($U))||' audit='||(select count(*) from audit_logs where company_id in ($C) or user_id in ($U))||' activity='||(select count(*) from activity_logs where company_id in ($C) or user_id in ($U))||' login_attempts='||(select count(*) from login_attempts where email like 'b25-smoke-${TAG}%@$DOM')||' documents='||(select count(*) from documents where company_id in ($C))||' document_versions='||(select count(*) from document_versions where company_id in ($C))||' storage_rows='||(select count(*) from storage_objects where company_id in ($C))")"; echo "$z"
  echo "$z" | grep -vqE '=[1-9]' || fail "disposable rows remain: $z"
  section "existing rows AFTER cleanup"
  local after; after="$(q "$kept_sql")"; echo "$after"
  [ "$after" = "$before" ] || fail "existing rows changed during cleanup: before[$before] after[$after]"
  stage2a_tenant_post_gate "$C" "$U"
  section "final inventory / census / volume = the pre-smoke Stage 2A state (the exception row + the protected live set, identical to the pre-smoke record)"
  [ "$(q "select count(*) from storage_objects where publication_uncertain_at is not null or last_error in ('OWNERSHIP_UNPROVEN','CLEANUP_PENDING')")" = "0" ] || fail "uncertain / unproven residue in the inventory"
  [ "$(q "select count(*) from storage_objects where id = '$B25PHYS_UUID' and state = 'deleted' and last_error = 'LEGACY_RETAINED' and driver = 'gcs' and company_id = $B25PHYS_COMPANY")" = "1" ] || fail "the Stage 1 exception row is not in its documented state"
  stage2a_protected_gate "final" "" 0 require
  echo "tenant files on the volume: $(compose exec -T api sh -c 'find /data/objects/tenants -type f 2>/dev/null | wc -l' 2>/dev/null || echo unavailable) (= the $S2A_PROTECTED_N protected live files; no smoke file)"
  rm -f "$HOME"/.b25-s1-node.err
  echo "leftover_files=$(ls "$HOME" | grep -c '^b25-' || true) readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE) schema_fingerprint=$(fingerprint)"
  log "stage2a-cleanup complete"
}

# =============================================================================
# B25 STAGE 2A — CORRECTION 1: settlement of the EXACT residue of the failed smoke
# run 38847884691 (tag 1c512c90f2c8): the two plain `deleted` tombstones of the
# deleted company 54 (document 593fd8be…, branding_logo b3cf7f44…; driver fs,
# mirror recorded, nothing retained). Every identifier is a readonly constant of
# b25-stage1-apply-lib.sh (S2AR_*) — these phases read NO ARG and refuse one.
#   stage2a-residue-eligibility  READ-ONLY: 26 prerequisites (B25_STAGE2A_RESIDUE_ELIGIBLE)
#   stage2a-residue-settle       MUTATION, one session: the same eligibility proof →
#                                fs + mirror absence re-proven PER UUID → exactly the two
#                                rows removed by the Stage 2A allow-list in one row-locked
#                                transaction → post-settlement proof (B25_STAGE2A_RESIDUE_SETTLED)
# The Stage 1 exception (f048b5d4…, company 53) is denied by constant in the
# library, in the allow-list and in every predicate below. No provider delete and
# no file delete exists in these phases: a copy that still exists STOPS the phase.
# =============================================================================
S2AR_FROWS_B64=""; S2AR_LOC_B64=""   # key blobs of the two rows, captured by the eligibility read (in-session; never printed)
# Read-only facts about the two named rows, the disposable identities and everything that could reference them.
stage2a_residue_row_facts() {
  local C="$S2AR_COMPANIES" U="$S2AR_USERS" DOM="$SMOKE_DOMAIN" TAG="$S2AR_TAG" Q="$S2AR_UUIDS_Q" DOC="$S2AR_UUID_DOC" LOGO="$S2AR_UUID_LOGO" BR="${S2AR_COMPANIES//,/|}" cid jobs=""
  echo "res_constants_ok=$(s2ar_constants_ok && echo true || echo false)"
  echo "res_companies_present=$(q "select count(*) from companies where id in ($C) or name like 'B25 SMOKE $TAG%'")"
  echo "res_users_present=$(q "select count(*) from users where id in ($U) or email like 'b25-smoke-$TAG-%@$DOM'")"
  echo "res_sessions=$(q "select count(*) from sessions where user_id in ($U) or user_id in (select id from users where company_id in ($C))")"
  echo "res_feature_rows=$(q "select (select count(*) from subscriptions where company_id in ($C)) + (select count(*) from documents where company_id in ($C)) + (select count(*) from document_versions where company_id in ($C)) + (select count(*) from export_runs where company_id in ($C)) + (select count(*) from executive_reports where company_id in ($C)) + (select count(*) from scans where company_id in ($C)) + (select count(*) from contacts where company_id in ($C)) + (select count(*) from leads where company_id in ($C)) + (select count(*) from audit_logs where company_id in ($C) or user_id in ($U)) + (select count(*) from activity_logs where company_id in ($C) or user_id in ($U)) + (select count(*) from login_attempts where email like 'b25-smoke-$TAG%@$DOM')")"
  # the two named rows: one read-only statement, one fact per line (counts over the rows whose id is in the constant list)
  q "select 'res_rows_named='||count(*)||E'\n'||'res_rows_deleted='||count(*) filter (where state = 'deleted')||E'\n'||'res_rows_fs='||count(*) filter (where driver = 'fs')||E'\n'||'res_rows_legacy_null='||count(*) filter (where legacy_key is null)||E'\n'||'res_rows_mirror_canonical='||count(*) filter (where mirror_key is not null and mirror_key = 'gs://' || split_part(split_part(mirror_key, '://', 2), '/', 1) || '/' || storage_key)||E'\n'||'res_rows_mirror_ok='||count(*) filter (where mirror_state = 'ok')||E'\n'||'res_rows_error_null='||count(*) filter (where last_error is null)||E'\n'||'res_rows_not_uncertain='||count(*) filter (where publication_uncertain_at is null)||E'\n'||'res_rows_no_lease='||count(*) filter (where lease_token is null and lease_expires_at is null)||E'\n'||'res_rows_deleted_at_set='||count(*) filter (where deleted_at is not null)||E'\n'||'res_rows_deleted_in_window='||count(*) filter (where deleted_at >= '$S2AR_DELETED_FROM' and deleted_at < '$S2AR_DELETED_TO')||E'\n'||'res_rows_created_in_window='||count(*) filter (where created_at >= '$S2AR_CREATED_FROM' and created_at < '$S2AR_CREATED_TO')||E'\n'||'res_rows_wrong_company='||count(*) filter (where company_id <> $S2AR_COMPANY)||E'\n'||'res_rows_exception='||count(*) filter (where id = '$B25PHYS_UUID')||E'\n'||'res_rows_company53='||count(*) filter (where company_id = $B25PHYS_COMPANY)||E'\n'||'res_rows_identity_ok='||count(*) filter (where company_id = $S2AR_COMPANY and sha256 ~ '^[0-9a-f]{64}\$' and coalesce(content_type, '') <> '' and ((id = '$DOC' and kind = 'document' and size_bytes = $S2AR_DOC_SIZE and reference = '/objects/' || id::text and storage_key = 'tenants/' || company_id || '/documents/' || id::text) or (id = '$LOGO' and kind = 'branding_logo' and size_bytes = $S2AR_LOGO_SIZE and reference ~ ('^branding/' || company_id || '/' || replace(id::text, '-', '') || '\\.(png|jpg|webp)\$') and $(logo_key_rule_sql)))) from storage_objects where id in ($Q)"
  echo "res_rows_other=$(q "select count(*) from storage_objects where company_id in ($C) and id not in ($Q)")"
  echo "res_doc_size=$(q "select coalesce((select size_bytes::text from storage_objects where id = '$DOC'), '<absent>')")"
  echo "res_logo_size=$(q "select coalesce((select size_bytes::text from storage_objects where id = '$LOGO'), '<absent>')")"
  echo "res_live_refs=$(q "select count(*) from storage_objects l where l.id in ($Q) and (exists (select 1 from document_versions dv where dv.object_path = l.reference) or exists (select 1 from export_runs e where e.object_path = l.reference) or exists (select 1 from executive_reports r where r.object_path = l.reference) or exists (select 1 from scans sc where sc.image_url = l.reference) or exists (select 1 from companies co where co.brand_logo_key = l.reference))")"
  echo "res_docs_company=$(q "select count(*) from documents where company_id in ($C)")"
  echo "res_brand_refs=$(q "select count(*) from companies co where co.brand_logo_key ~ '^branding/($BR)/'")"
  echo "res_foreign_mentions=$(q "select count(*) from storage_objects s where s.id not in ($Q) and exists (select 1 from unnest(array[$Q]) u, lateral (select replace(u, '-', '') as h) x where s.reference like '%' || u || '%' or s.reference like '%' || x.h || '%' or s.storage_key like '%' || u || '%' or s.storage_key like '%' || x.h || '%' or coalesce(s.legacy_key,'') like '%' || u || '%' or coalesce(s.legacy_key,'') like '%' || x.h || '%' or coalesce(s.mirror_key,'') like '%' || u || '%' or coalesce(s.mirror_key,'') like '%' || x.h || '%')")"
  for cid in ${C//,/ }; do jobs+=" or payload::text like '%\"companyId\":$cid%'"; done
  echo "res_jobs_pending=$(q "select count(*) from job_queue where status in ('pending','running') and (payload::text like '%$DOC%' or payload::text like '%$LOGO%'$jobs)")"
  echo "res_inflight_sessions=$(q "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle' and query ilike '%storage_objects%'")"
  echo "res_inv_outside=$(q "select count(*) from storage_objects where id <> '$B25PHYS_UUID' and id not in ($Q)")"
  echo "res_inv_outside_exception=$(q "select count(*) from storage_objects where id <> '$B25PHYS_UUID'")"
}
# Capture the key blobs of the named rows (base64 JSON, in-session only; never printed) for the physical proofs —
# taken BEFORE any removal so the post-settlement proof re-reads the very same locations.
stage2a_residue_blobs() {
  S2AR_FROWS_B64="$(q "select json_build_object('companies', array[$S2AR_COMPANIES], 'rows', coalesce(json_agg(json_build_object('id', id, 'k', storage_key)), '[]'::json)) from storage_objects where id in ($S2AR_UUIDS_Q)" | base64 -w0)"
  S2AR_LOC_B64="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 'm', mirror_key)), '[]'::json) from storage_objects where id in ($S2AR_UUIDS_Q)" | base64 -w0)"
}
# <frows blob> → lstat of each stored key + walk of the tenant directories INSIDE the api container (read-only; counts only).
stage2a_residue_fs_facts() {
  local aj; aj="$(api_node "$STAGE2A_FS_ABSENT_JS" "$1")"; echo "  fs: $aj" >&2
  echo "res_fs_checked=$(census_field "$aj" checked count 2>/dev/null || echo "?")"
  echo "res_fs_absent=$(census_field "$aj" absent count 2>/dev/null || echo "?")"
  echo "res_fs_tenant_files=$(census_field "$aj" tenant_files count 2>/dev/null || echo "?")"
  echo "res_fs_tenant_dirs=$(census_field "$aj" tenant_dirs count 2>/dev/null || echo "?")"
}
# <loc blob> → HEAD of every persisted provider location (names never printed). A provider read failure is reported
# as res_prov_read_ok=false and never counts as absence.
stage2a_residue_provider_facts() {
  local pj c a; pj="$(api_node "$PROVIDER_RULES_JS"$'\n'"$STAGE2A_PROVIDER_ABSENT_JS" "$1")"; echo "  provider: $pj" >&2
  c="$(census_field "$pj" checked count 2>/dev/null || echo "?")"; a="$(census_field "$pj" absent count 2>/dev/null || echo "?")"
  if [[ "$c" =~ ^[0-9]+$ ]] && [[ "$a" =~ ^[0-9]+$ ]] && ! printf '%s' "$pj" | grep -q '"error"'; then echo "res_prov_read_ok=true"; else echo "res_prov_read_ok=false"; fi
  echo "res_prov_checked=$c"; echo "res_prov_absent=$a"
}
# Host / configuration facts shared by the eligibility read and the post-settlement proof (values never printed).
stage2a_residue_host_facts() {
  local cid="$1" mg
  stage2a_host_facts; stage2a_container_facts "$cid"; stage2a_readyz_facts; stage2a_init_facts "$cid"; stage2a_container_env_facts; stage2a_web_leak_facts
  echo "env_record_present=$([ -f "$STAGE2A_ENV_RECORD" ] && echo true || echo false)"
  mg="$(stage2a_env_managed_of activate < "$ENV_FILE" | sha256sum | cut -c1-64)"
  echo "env_file_managed_ok=$([ "$mg" = "$(stage2a_env_lines activate | sha256sum | cut -c1-64)" ] && echo true || echo false)"
}
# ---- stage2a_residue_eligibility_run: READ-ONLY; gathers every fact; returns 0 only on B25_STAGE2A_RESIDUE_ELIGIBLE=TRUE ----
stage2a_residue_eligibility_run() {
  declare -f stage2a_residue_eligibility >/dev/null && declare -f logo_key_rule_sql >/dev/null || fail "libraries not loaded (stream b25-stage1-purge-lib.sh and b25-stage1-apply-lib.sh before this script)"
  s2ar_constants_ok || fail "residue constants collide with the Stage 1 exception or are malformed — STOP"
  local facts="" cid rf rfacts ff pf verdict; cid="$(compose ps -q api || true)"
  section "0. read-only guard"; stage2a_readonly_guard
  section "1. host / containers / readiness / storage configuration (names, counts, digests and booleans only)"
  facts+="$(stage2a_residue_host_facts "$cid")"$'\n'
  printf '%s\n' "$facts" | grep -E '^(head_sha|current_deploy_sha|dirty|lock_absent|api_running|api_health|readyz_status|readyz_database|readyz_storage|init_record_found|init_driver|init_fallback|init_mirror|init_legacy_delete|env_names_set|env_mode|key_line_count|env_core_identity_ok|env_record_present|env_file_managed_ok|dead_jobs_total|storage_jobs_active|schema_fingerprint)=' | sed 's/^/  /'
  section "2. the named volume (no write test)"
  rf="$(stage2a_root_facts "$cid")"; facts+="$rf"$'\n'; printf '%s\n' "$rf" | grep -E '^(mount_type|mount_name|root_tenant_files|root_regular_files|root_symlinks|root_other_entries)=' | sed 's/^/  /'
  section "3. Stage 1 exception, inventory, census, originals (read-only)"
  facts+="$(stage2a_exception_facts)"$'\n'
  printf '%s\n' "$facts" | grep -E '^(exc_|inv_|census_|unmarked_|refs_count|originals_)' | sed 's/^/  /'
  section "4. the residue rows, the disposable identities and every possible reference (ids, counts, booleans only)"
  rfacts="$(stage2a_residue_row_facts)"; facts+="$rfacts"$'\n'; printf '%s\n' "$rfacts" | sed 's/^/  /'
  section "5. physical absence (read-only): fs primary by stored key + tenant directory walk; every persisted provider location by HEAD"
  stage2a_residue_blobs
  ff="$(stage2a_residue_fs_facts "$S2AR_FROWS_B64")"; pf="$(stage2a_residue_provider_facts "$S2AR_LOC_B64")"
  facts+="$ff"$'\n'; facts+="$pf"$'\n'; printf '%s\n%s\n' "$ff" "$pf" | sed 's/^/  /'
  section "6. settlement prerequisites (read-only decision; nothing is changed)"
  if verdict="$(printf '%s' "$facts" | stage2a_residue_eligibility)"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "residue eligibility evaluator failed — the lines above are the verdict (read-only; nothing changed)"; fi
  rm -f "$HOME"/.b25-s1-node.err
  printf '%s\n' "$verdict" | grep -qx 'B25_STAGE2A_RESIDUE_ELIGIBLE=TRUE'
}
phase_stage2a_residue_eligibility() {
  [ -z "$ARG1$ARG2$ARG3" ] || fail "stage2a-residue-eligibility takes no argument — the residue is bound by constants"
  section "manifest (readonly constants of the library; never an input)"; echo "  $S2AR_MANIFEST (run $S2AR_RUN)"
  if stage2a_residue_eligibility_run; then log "stage2a-residue-eligibility complete (read-only; nothing changed; B25_STAGE2A_RESIDUE_ELIGIBLE=TRUE)"
  else fail "stage2a-residue-eligibility: prerequisites not met (read-only; nothing changed; B25_STAGE2A_RESIDUE_ELIGIBLE=FALSE)"; fi
}
# MUTATION — ONE session: A eligibility (TRUE or nothing happens) → B1/B2 absence re-proven per uuid → C the two rows
# removed in one row-locked, allow-listed transaction → D post-settlement proof over re-read facts.
phase_stage2a_residue_settle() {
  [ -z "$ARG1$ARG2$ARG3" ] || fail "stage2a-residue-settle takes no argument — the residue is bound by constants"
  declare -f purge_result_check >/dev/null || fail "purge library not loaded (stream b25-stage1-purge-lib.sh before this script)"
  section "manifest (readonly constants of the library; never an input)"; echo "  $S2AR_MANIFEST (run $S2AR_RUN)"
  section "A. eligibility — read-only proof in THIS session (no mutation unless B25_STAGE2A_RESIDUE_ELIGIBLE=TRUE)"
  stage2a_residue_eligibility_run || fail "settlement refused: B25_STAGE2A_RESIDUE_ELIGIBLE is not TRUE in this session — nothing changed"
  stage2a_lock
  local frows="$S2AR_FROWS_B64" loc="$S2AR_LOC_B64" u k1 fj pj triple
  [ -n "$frows" ] && [ -n "$loc" ] || fail "the key blobs of the residue rows were not captured — STOP (nothing changed)"
  section "B1. fs primary absence re-proven PER UUID immediately before the removal (lstat of the stored key; nothing is deleted to make this true)"
  for u in "$S2AR_UUID_DOC" "$S2AR_UUID_LOGO"; do
    k1="$(q "select json_build_object('companies', array[$S2AR_COMPANIES], 'rows', coalesce(json_agg(json_build_object('id', id, 'k', storage_key)), '[]'::json)) from storage_objects where id = '$u'" | base64 -w0)"
    fj="$(api_node "$STAGE2A_FS_ABSENT_JS" "$k1")"; echo "  $u ($(s2ar_kind "$u")): fs $fj"
    [ "$(census_field "$fj" checked count 2>/dev/null || echo x)" = "1" ] && [ "$(census_field "$fj" absent count 2>/dev/null || echo x)" = "1" ] && [ "$(census_field "$fj" tenant_files count 2>/dev/null || echo x)" = "0" ] || fail "the fs primary of $u still exists or could not be checked — STOP: no row is removed, nothing is deleted"
  done
  section "B2. mirror absence re-proven PER UUID (every persisted provider location by HEAD; a read failure is NOT absence)"
  for u in "$S2AR_UUID_DOC" "$S2AR_UUID_LOGO"; do
    k1="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 'm', mirror_key)), '[]'::json) from storage_objects where id = '$u'" | base64 -w0)"
    pj="$(api_node "$PROVIDER_RULES_JS"$'\n'"$STAGE2A_PROVIDER_ABSENT_JS" "$k1")"; echo "  $u ($(s2ar_kind "$u")): provider $pj"
    if printf '%s' "$pj" | grep -q '"error"'; then fail "the provider state of $u could not be read — STOP: no row is removed, no provider call is issued"; fi
    [ "$(census_field "$pj" checked count 2>/dev/null || echo x)" = "1" ] && [ "$(census_field "$pj" absent count 2>/dev/null || echo x)" = "1" ] || fail "a persisted provider location of $u still answers — STOP: no row is removed, no provider delete is issued (never unconditioned)"
  done
  section "C. remove EXACTLY the two tombstone rows (Stage 2A allow-list; ONE row-locked transaction; locked = allowed = deleted = $S2AR_ROWS or nothing is deleted)"
  triple="$(qw "$(stage2a_purge_rows_sql "$S2AR_UUIDS_Q" "$S2AR_COMPANY" "$S2AR_ROWS")")"
  purge_result_check "$triple" "$S2AR_ROWS" || fail "the allow-listed delete did not remove exactly the two rows (the statement deletes nothing unless locked = allowed = expected = $S2AR_ROWS): $triple — STOP"
  [ "$(q "select count(*) from storage_objects where id in ($S2AR_UUIDS_Q)")" = "0" ] || fail "a residue row remains after the transaction — STOP"
  echo "  rows removed: $S2AR_ROWS ($S2AR_UUID_DOC, $S2AR_UUID_LOGO)"
  rm -f "$STAGE2A_LOCK_FILE"   # the mutation is complete; the proof below is read-only and must find no lock
  section "D. post-settlement proof (read-only; fs / provider absence re-read with the key blobs captured BEFORE the removal; census re-read)"
  local facts="" cid verdict; cid="$(compose ps -q api || true)"
  facts+="$(stage2a_residue_host_facts "$cid")"$'\n'
  facts+="$(stage2a_root_facts "$cid")"$'\n'
  facts+="$(stage2a_exception_facts)"$'\n'
  facts+="$(stage2a_residue_row_facts)"$'\n'
  facts+="$(stage2a_residue_fs_facts "$frows")"$'\n'; facts+="$(stage2a_residue_provider_facts "$loc")"$'\n'
  printf '%s\n' "$facts" | grep -E '^(res_|exc_|inv_|census_|unmarked_|originals_|root_tenant_files|leak_|web_leak_|readyz_|api_health|lock_absent|head_sha|current_deploy_sha|dirty|init_driver|init_fallback|init_mirror|init_legacy_delete|env_record_present|env_file_managed_ok|key_line_count|env_mode)=' | sed 's/^/  /'
  if verdict="$(printf '%s' "$facts" | stage2a_residue_settled)"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "residue post-settlement evaluator failed — the lines above are the verdict; the rows are removed; no further change is made; independent review required"; fi
  rm -f "$HOME"/.b25-s1-node.err
  printf '%s\n' "$verdict" | grep -qx 'B25_STAGE2A_RESIDUE_SETTLED=TRUE' || fail "post-settlement proof FAILED — the two rows are removed; no further change is made; independent review required"
  log "stage2a-residue-settle complete (B25_STAGE2A_RESIDUE_SETTLED=TRUE)"
}

# =============================================================================
# B25 STAGE 2A — CORRECTION 2: settlement of the EXACT residue of the failed
# corrected smoke run 38922592504 (tag 5d408c442c64): the two plain `deleted`
# tombstones of the deleted company 56 (document c69a3706…, branding_logo
# candidate 06228d82… — a reconstruction the eligibility must PROVE). Same
# structure as the reviewed and executed Correction 1 phases above, bound to the
# readonly S2AR2_* constants (no ARG is read; one is refused); the shared probe
# readers stage2a_residue_fs_facts / _provider_facts / _host_facts are reused.
#   stage2a-residue2-eligibility  READ-ONLY: 26 prerequisites (B25_STAGE2A_RESIDUE2_ELIGIBLE);
#                                 reports explicitly when the product sweep already
#                                 purged the rows (nothing to settle, ever)
#   stage2a-residue2-settle       MUTATION, one session: the same eligibility proof →
#                                 fs + mirror absence re-proven PER UUID → exactly the
#                                 two rows removed by the Stage 2A allow-list in one
#                                 row-locked transaction → post proof (B25_STAGE2A_RESIDUE2_SETTLED)
# No provider delete and no file delete exist in these phases either.
# =============================================================================
S2AR2_FROWS_B64=""; S2AR2_LOC_B64=""   # key blobs of the two rows, captured by the eligibility read (in-session; never printed)
# Read-only facts about the two named rows, the disposable identities and everything that could reference them.
stage2a_residue2_row_facts() {
  local C="$S2AR2_COMPANIES" U="$S2AR2_USERS" DOM="$SMOKE_DOMAIN" TAG="$S2AR2_TAG" Q="$S2AR2_UUIDS_Q" DOC="$S2AR2_UUID_DOC" LOGO="$S2AR2_UUID_LOGO" BR="${S2AR_COMPANIES//,/|}" cid jobs=""
  echo "res_constants_ok=$(s2ar2_constants_ok && echo true || echo false)"
  echo "res_companies_present=$(q "select count(*) from companies where id in ($C) or name like 'B25 SMOKE $TAG%'")"
  echo "res_users_present=$(q "select count(*) from users where id in ($U) or email like 'b25-smoke-$TAG-%@$DOM'")"
  echo "res_sessions=$(q "select count(*) from sessions where user_id in ($U) or user_id in (select id from users where company_id in ($C))")"
  echo "res_feature_rows=$(q "select (select count(*) from subscriptions where company_id in ($C)) + (select count(*) from documents where company_id in ($C)) + (select count(*) from document_versions where company_id in ($C)) + (select count(*) from export_runs where company_id in ($C)) + (select count(*) from executive_reports where company_id in ($C)) + (select count(*) from scans where company_id in ($C)) + (select count(*) from contacts where company_id in ($C)) + (select count(*) from leads where company_id in ($C)) + (select count(*) from audit_logs where company_id in ($C) or user_id in ($U)) + (select count(*) from activity_logs where company_id in ($C) or user_id in ($U)) + (select count(*) from login_attempts where email like 'b25-smoke-$TAG%@$DOM')")"
  # the two named rows: one read-only statement, one fact per line (counts over the rows whose id is in the constant list)
  q "select 'res_rows_named='||count(*)||E'\n'||'res_rows_deleted='||count(*) filter (where state = 'deleted')||E'\n'||'res_rows_fs='||count(*) filter (where driver = 'fs')||E'\n'||'res_rows_legacy_null='||count(*) filter (where legacy_key is null)||E'\n'||'res_rows_mirror_canonical='||count(*) filter (where mirror_key is not null and mirror_key = 'gs://' || split_part(split_part(mirror_key, '://', 2), '/', 1) || '/' || storage_key)||E'\n'||'res_rows_mirror_ok='||count(*) filter (where mirror_state = 'ok')||E'\n'||'res_rows_error_null='||count(*) filter (where last_error is null)||E'\n'||'res_rows_not_uncertain='||count(*) filter (where publication_uncertain_at is null)||E'\n'||'res_rows_no_lease='||count(*) filter (where lease_token is null and lease_expires_at is null)||E'\n'||'res_rows_deleted_at_set='||count(*) filter (where deleted_at is not null)||E'\n'||'res_rows_deleted_in_window='||count(*) filter (where deleted_at >= '$S2AR2_DELETED_FROM' and deleted_at < '$S2AR2_DELETED_TO')||E'\n'||'res_rows_created_in_window='||count(*) filter (where created_at >= '$S2AR2_CREATED_FROM' and created_at < '$S2AR2_CREATED_TO')||E'\n'||'res_rows_wrong_company='||count(*) filter (where company_id <> $S2AR2_COMPANY)||E'\n'||'res_rows_exception='||count(*) filter (where id = '$B25PHYS_UUID')||E'\n'||'res_rows_company53='||count(*) filter (where company_id = $B25PHYS_COMPANY)||E'\n'||'res_rows_identity_ok='||count(*) filter (where company_id = $S2AR2_COMPANY and sha256 ~ '^[0-9a-f]{64}\$' and coalesce(content_type, '') <> '' and ((id = '$DOC' and kind = 'document' and size_bytes = $S2AR2_DOC_SIZE and reference = '/objects/' || id::text and storage_key = 'tenants/' || company_id || '/documents/' || id::text) or (id = '$LOGO' and kind = 'branding_logo' and size_bytes = $S2AR2_LOGO_SIZE and reference ~ ('^branding/' || company_id || '/' || replace(id::text, '-', '') || '\\.(png|jpg|webp)\$') and $(logo_key_rule_sql)))) from storage_objects where id in ($Q)"
  echo "res_rows_other=$(q "select count(*) from storage_objects where company_id in ($C) and id not in ($Q)")"
  echo "res_doc_size=$(q "select coalesce((select size_bytes::text from storage_objects where id = '$DOC'), '<absent>')")"
  echo "res_logo_size=$(q "select coalesce((select size_bytes::text from storage_objects where id = '$LOGO'), '<absent>')")"
  echo "res_live_refs=$(q "select count(*) from storage_objects l where l.id in ($Q) and (exists (select 1 from document_versions dv where dv.object_path = l.reference) or exists (select 1 from export_runs e where e.object_path = l.reference) or exists (select 1 from executive_reports r where r.object_path = l.reference) or exists (select 1 from scans sc where sc.image_url = l.reference) or exists (select 1 from companies co where co.brand_logo_key = l.reference))")"
  echo "res_docs_company=$(q "select count(*) from documents where company_id in ($C)")"
  echo "res_brand_refs=$(q "select count(*) from companies co where co.brand_logo_key ~ '^branding/($BR)/'")"
  echo "res_foreign_mentions=$(q "select count(*) from storage_objects s where s.id not in ($Q) and exists (select 1 from unnest(array[$Q]) u, lateral (select replace(u, '-', '') as h) x where s.reference like '%' || u || '%' or s.reference like '%' || x.h || '%' or s.storage_key like '%' || u || '%' or s.storage_key like '%' || x.h || '%' or coalesce(s.legacy_key,'') like '%' || u || '%' or coalesce(s.legacy_key,'') like '%' || x.h || '%' or coalesce(s.mirror_key,'') like '%' || u || '%' or coalesce(s.mirror_key,'') like '%' || x.h || '%')")"
  for cid in ${C//,/ }; do jobs+=" or payload::text like '%\"companyId\":$cid%'"; done
  echo "res_jobs_pending=$(q "select count(*) from job_queue where status in ('pending','running') and (payload::text like '%$DOC%' or payload::text like '%$LOGO%'$jobs)")"
  echo "res_inflight_sessions=$(q "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle' and query ilike '%storage_objects%'")"
  echo "res_inv_outside=$(q "select count(*) from storage_objects where id <> '$B25PHYS_UUID' and id not in ($Q)")"
  echo "res_inv_outside_exception=$(q "select count(*) from storage_objects where id <> '$B25PHYS_UUID'")"
}
# Capture the key blobs of the named rows (base64 JSON, in-session only; never printed) for the physical proofs —
# taken BEFORE any removal so the post-settlement proof re-reads the very same locations.
stage2a_residue2_blobs() {
  S2AR2_FROWS_B64="$(q "select json_build_object('companies', array[$S2AR2_COMPANIES], 'rows', coalesce(json_agg(json_build_object('id', id, 'k', storage_key)), '[]'::json)) from storage_objects where id in ($S2AR2_UUIDS_Q)" | base64 -w0)"
  S2AR2_LOC_B64="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 'm', mirror_key)), '[]'::json) from storage_objects where id in ($S2AR2_UUIDS_Q)" | base64 -w0)"
}
# ---- stage2a_residue2_eligibility_run: READ-ONLY; gathers every fact; returns 0 only on B25_STAGE2A_RESIDUE2_ELIGIBLE=TRUE ----
stage2a_residue2_eligibility_run() {
  declare -f stage2a_residue2_eligibility >/dev/null && declare -f logo_key_rule_sql >/dev/null || fail "libraries not loaded (stream b25-stage1-purge-lib.sh and b25-stage1-apply-lib.sh before this script)"
  s2ar2_constants_ok || fail "residue constants collide with the Stage 1 exception or are malformed — STOP"
  local facts="" cid rf rfacts ff pf verdict; cid="$(compose ps -q api || true)"
  section "0. read-only guard"; stage2a_readonly_guard
  section "1. host / containers / readiness / storage configuration (names, counts, digests and booleans only)"
  facts+="$(stage2a_residue_host_facts "$cid")"$'\n'
  printf '%s\n' "$facts" | grep -E '^(head_sha|current_deploy_sha|dirty|lock_absent|api_running|api_health|readyz_status|readyz_database|readyz_storage|init_record_found|init_driver|init_fallback|init_mirror|init_legacy_delete|env_names_set|env_mode|key_line_count|env_core_identity_ok|env_record_present|env_file_managed_ok|dead_jobs_total|storage_jobs_active|schema_fingerprint)=' | sed 's/^/  /'
  section "2. the named volume (no write test)"
  rf="$(stage2a_root_facts "$cid")"; facts+="$rf"$'\n'; printf '%s\n' "$rf" | grep -E '^(mount_type|mount_name|root_tenant_files|root_regular_files|root_symlinks|root_other_entries)=' | sed 's/^/  /'
  section "3. Stage 1 exception, inventory, census, originals (read-only)"
  facts+="$(stage2a_exception_facts)"$'\n'
  printf '%s\n' "$facts" | grep -E '^(exc_|inv_|census_|unmarked_|refs_count|originals_)' | sed 's/^/  /'
  section "4. the residue rows, the disposable identities and every possible reference (ids, counts, booleans only)"
  rfacts="$(stage2a_residue2_row_facts)"; facts+="$rfacts"$'\n'; printf '%s\n' "$rfacts" | sed 's/^/  /'
  section "5. physical absence (read-only): fs primary by stored key + tenant directory walk; every persisted provider location by HEAD"
  stage2a_residue2_blobs
  ff="$(stage2a_residue_fs_facts "$S2AR2_FROWS_B64")"; pf="$(stage2a_residue_provider_facts "$S2AR2_LOC_B64")"
  facts+="$ff"$'\n'; facts+="$pf"$'\n'; printf '%s\n%s\n' "$ff" "$pf" | sed 's/^/  /'
  section "6. settlement prerequisites (read-only decision; nothing is changed)"
  if verdict="$(printf '%s' "$facts" | stage2a_residue2_eligibility)"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "residue-2 eligibility evaluator failed — the lines above are the verdict (read-only; nothing changed)"; fi
  rm -f "$HOME"/.b25-s1-node.err
  printf '%s\n' "$verdict" | grep -qx 'B25_STAGE2A_RESIDUE2_ELIGIBLE=TRUE'
}
phase_stage2a_residue2_eligibility() {
  [ -z "$ARG1$ARG2$ARG3" ] || fail "stage2a-residue2-eligibility takes no argument — the residue is bound by constants"
  section "manifest (readonly constants of the library; never an input; the branding uuid is a CANDIDATE the proof must confirm)"; echo "  $S2AR2_MANIFEST (run $S2AR2_RUN)"
  if stage2a_residue2_eligibility_run; then log "stage2a-residue2-eligibility complete (read-only; nothing changed; B25_STAGE2A_RESIDUE2_ELIGIBLE=TRUE)"
  else
    # auto-purge race: the product sweep purges reconciled tombstones of a deleted company on its own schedule;
    # when the rows are already gone this is reported explicitly — nothing is recreated and nothing can ever settle.
    local left; left="$(q "select count(*) from storage_objects where id in ($S2AR2_UUIDS_Q)" 2>/dev/null || echo "?")"
    if [ "$left" = "0" ]; then echo "B25_STAGE2A_RESIDUE2_ROWS_ALREADY_ABSENT=TRUE (the product sweep purged the company-$S2AR2_COMPANY tombstones; the reviewed settlement did NOT run and never will for this manifest; independent review decides)"; fi
    fail "stage2a-residue2-eligibility: prerequisites not met (read-only; nothing changed; B25_STAGE2A_RESIDUE2_ELIGIBLE=FALSE; rows_present=$left)"
  fi
}
# MUTATION — ONE session: A eligibility (TRUE or nothing happens) → B1/B2 absence re-proven per uuid → C the two rows
# removed in one row-locked, allow-listed transaction → D post-settlement proof over re-read facts.
phase_stage2a_residue2_settle() {
  [ -z "$ARG1$ARG2$ARG3" ] || fail "stage2a-residue2-settle takes no argument — the residue is bound by constants"
  declare -f purge_result_check >/dev/null || fail "purge library not loaded (stream b25-stage1-purge-lib.sh before this script)"
  section "manifest (readonly constants of the library; never an input)"; echo "  $S2AR2_MANIFEST (run $S2AR2_RUN)"
  section "A. eligibility — read-only proof in THIS session (no mutation unless B25_STAGE2A_RESIDUE2_ELIGIBLE=TRUE)"
  stage2a_residue2_eligibility_run || fail "settlement refused: B25_STAGE2A_RESIDUE2_ELIGIBLE is not TRUE in this session — nothing changed"
  stage2a_lock
  local frows="$S2AR2_FROWS_B64" loc="$S2AR2_LOC_B64" u k1 fj pj triple
  [ -n "$frows" ] && [ -n "$loc" ] || fail "the key blobs of the residue rows were not captured — STOP (nothing changed)"
  section "B1. fs primary absence re-proven PER UUID immediately before the removal (lstat of the stored key; nothing is deleted to make this true)"
  for u in "$S2AR2_UUID_DOC" "$S2AR2_UUID_LOGO"; do
    k1="$(q "select json_build_object('companies', array[$S2AR2_COMPANIES], 'rows', coalesce(json_agg(json_build_object('id', id, 'k', storage_key)), '[]'::json)) from storage_objects where id = '$u'" | base64 -w0)"
    fj="$(api_node "$STAGE2A_FS_ABSENT_JS" "$k1")"; echo "  $u ($(s2ar2_kind "$u")): fs $fj"
    [ "$(census_field "$fj" checked count 2>/dev/null || echo x)" = "1" ] && [ "$(census_field "$fj" absent count 2>/dev/null || echo x)" = "1" ] && [ "$(census_field "$fj" tenant_files count 2>/dev/null || echo x)" = "0" ] || fail "the fs primary of $u still exists or could not be checked — STOP: no row is removed, nothing is deleted"
  done
  section "B2. mirror absence re-proven PER UUID (every persisted provider location by HEAD; a read failure is NOT absence)"
  for u in "$S2AR2_UUID_DOC" "$S2AR2_UUID_LOGO"; do
    k1="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 'm', mirror_key)), '[]'::json) from storage_objects where id = '$u'" | base64 -w0)"
    pj="$(api_node "$PROVIDER_RULES_JS"$'\n'"$STAGE2A_PROVIDER_ABSENT_JS" "$k1")"; echo "  $u ($(s2ar2_kind "$u")): provider $pj"
    if printf '%s' "$pj" | grep -q '"error"'; then fail "the provider state of $u could not be read — STOP: no row is removed, no provider call is issued"; fi
    [ "$(census_field "$pj" checked count 2>/dev/null || echo x)" = "1" ] && [ "$(census_field "$pj" absent count 2>/dev/null || echo x)" = "1" ] || fail "a persisted provider location of $u still answers — STOP: no row is removed, no provider delete is issued (never unconditioned)"
  done
  section "C. remove EXACTLY the two tombstone rows (Stage 2A allow-list; ONE row-locked transaction; locked = allowed = deleted = $S2AR2_ROWS or nothing is deleted)"
  triple="$(qw "$(stage2a_purge_rows_sql "$S2AR2_UUIDS_Q" "$S2AR2_COMPANY" "$S2AR2_ROWS")")"
  purge_result_check "$triple" "$S2AR2_ROWS" || fail "the allow-listed delete did not remove exactly the two rows (the statement deletes nothing unless locked = allowed = expected = $S2AR2_ROWS): $triple — STOP"
  [ "$(q "select count(*) from storage_objects where id in ($S2AR2_UUIDS_Q)")" = "0" ] || fail "a residue row remains after the transaction — STOP"
  echo "  rows removed: $S2AR2_ROWS ($S2AR2_UUID_DOC, $S2AR2_UUID_LOGO)"
  rm -f "$STAGE2A_LOCK_FILE"   # the mutation is complete; the proof below is read-only and must find no lock
  section "D. post-settlement proof (read-only; fs / provider absence re-read with the key blobs captured BEFORE the removal; census re-read)"
  local facts="" cid verdict; cid="$(compose ps -q api || true)"
  facts+="$(stage2a_residue_host_facts "$cid")"$'\n'
  facts+="$(stage2a_root_facts "$cid")"$'\n'
  facts+="$(stage2a_exception_facts)"$'\n'
  facts+="$(stage2a_residue2_row_facts)"$'\n'
  facts+="$(stage2a_residue_fs_facts "$frows")"$'\n'; facts+="$(stage2a_residue_provider_facts "$loc")"$'\n'
  printf '%s\n' "$facts" | grep -E '^(res_|exc_|inv_|census_|unmarked_|originals_|root_tenant_files|leak_|web_leak_|readyz_|api_health|lock_absent|head_sha|current_deploy_sha|dirty|init_driver|init_fallback|init_mirror|init_legacy_delete|env_record_present|env_file_managed_ok|key_line_count|env_mode)=' | sed 's/^/  /'
  if verdict="$(printf '%s' "$facts" | stage2a_residue2_settled)"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "residue-2 post-settlement evaluator failed — the lines above are the verdict; the rows are removed; no further change is made; independent review required"; fi
  rm -f "$HOME"/.b25-s1-node.err
  printf '%s\n' "$verdict" | grep -qx 'B25_STAGE2A_RESIDUE2_SETTLED=TRUE' || fail "post-settlement proof FAILED — the two rows are removed; no further change is made; independent review required"
  log "stage2a-residue2-settle complete (B25_STAGE2A_RESIDUE2_SETTLED=TRUE)"
}

# =============================================================================
# B25 STAGE 2A — CORRECTION 4: settlement of the EXACT residue of the Correction-3 smoke run
# 38958264416 (tag ec7ceda89a58): the two plain `deleted` fs tombstones of deleted company 58
# (document ac3c33c3…, branding_logo c097cd52…; both uuids read unmasked from the run log; mirror
# recorded; nothing retained). Same structure as the reviewed and executed Correction 1 / 2 phases
# above, bound to the readonly S2AR3_* constants (no ARG is read; one is refused); the shared probe
# readers stage2a_residue_fs_facts / _provider_facts / _host_facts are reused. Two additions:
#   • the read-only run reports the temporary stderr file of the in-container reader (present /
#     size / mtime only; never its contents; a pre-existing file is left for review);
#   • section 7 runs the retrospective Correction 3 proof over the incident window of that run
#     (stage2a_tenant_incident_proof with the recorded pre-smoke snapshot) and prints
#     B25_STAGE2A_RESIDUE3_TENANT_PROOF=PASS|FAIL — eligibility TRUE requires both verdicts.
#   stage2a-residue3-eligibility  READ-ONLY: 26 prerequisites (B25_STAGE2A_RESIDUE3_ELIGIBLE) + the
#                                 tenant proof; reports explicitly when the product sweep already
#                                 purged the rows (B25_STAGE2A_RESIDUE3_ROWS_ALREADY_ABSENT=TRUE)
#   stage2a-residue3-settle       MUTATION, one session: the same eligibility proof → fs + mirror
#                                 absence re-proven PER UUID → exactly the two rows removed by the
#                                 Stage 2A allow-list in one row-locked transaction → post proof
#                                 (B25_STAGE2A_RESIDUE3_SETTLED)
# No provider delete and no file delete exist in these phases either. The Stage 1 exception
# (f048b5d4…, company 53) is denied by constant in the library, in the allow-list and in every predicate.
# =============================================================================
S2AR3_TENANT_PROOF=""; S2AR3_TMP_PRE=""
S2AR3_FROWS_B64=""; S2AR3_LOC_B64=""   # key blobs of the two rows, captured by the eligibility read (in-session; never printed)
# Read-only facts about the two named rows, the disposable identities and everything that could reference them.
stage2a_residue3_row_facts() {
  local C="$S2AR3_COMPANIES" U="$S2AR3_USERS" DOM="$SMOKE_DOMAIN" TAG="$S2AR3_TAG" Q="$S2AR3_UUIDS_Q" DOC="$S2AR3_UUID_DOC" LOGO="$S2AR3_UUID_LOGO" BR="${S2AR3_COMPANIES//,/|}" cid jobs=""
  echo "res_constants_ok=$(s2ar3_constants_ok && echo true || echo false)"
  echo "res_companies_present=$(q "select count(*) from companies where id in ($C) or name like 'B25 SMOKE $TAG%'")"
  echo "res_users_present=$(q "select count(*) from users where id in ($U) or email like 'b25-smoke-$TAG-%@$DOM'")"
  echo "res_sessions=$(q "select count(*) from sessions where user_id in ($U) or user_id in (select id from users where company_id in ($C))")"
  echo "res_feature_rows=$(q "select (select count(*) from subscriptions where company_id in ($C)) + (select count(*) from documents where company_id in ($C)) + (select count(*) from document_versions where company_id in ($C)) + (select count(*) from export_runs where company_id in ($C)) + (select count(*) from executive_reports where company_id in ($C)) + (select count(*) from scans where company_id in ($C)) + (select count(*) from contacts where company_id in ($C)) + (select count(*) from leads where company_id in ($C)) + (select count(*) from audit_logs where company_id in ($C) or user_id in ($U)) + (select count(*) from activity_logs where company_id in ($C) or user_id in ($U)) + (select count(*) from login_attempts where email like 'b25-smoke-$TAG%@$DOM')")"
  # the two named rows: one read-only statement, one fact per line (counts over the rows whose id is in the constant list)
  q "select 'res_rows_named='||count(*)||E'\n'||'res_rows_deleted='||count(*) filter (where state = 'deleted')||E'\n'||'res_rows_fs='||count(*) filter (where driver = 'fs')||E'\n'||'res_rows_legacy_null='||count(*) filter (where legacy_key is null)||E'\n'||'res_rows_mirror_canonical='||count(*) filter (where mirror_key is not null and mirror_key = 'gs://' || split_part(split_part(mirror_key, '://', 2), '/', 1) || '/' || storage_key)||E'\n'||'res_rows_mirror_ok='||count(*) filter (where mirror_state = 'ok')||E'\n'||'res_rows_error_null='||count(*) filter (where last_error is null)||E'\n'||'res_rows_not_uncertain='||count(*) filter (where publication_uncertain_at is null)||E'\n'||'res_rows_no_lease='||count(*) filter (where lease_token is null and lease_expires_at is null)||E'\n'||'res_rows_deleted_at_set='||count(*) filter (where deleted_at is not null)||E'\n'||'res_rows_deleted_in_window='||count(*) filter (where deleted_at >= '$S2AR3_DELETED_FROM' and deleted_at < '$S2AR3_DELETED_TO')||E'\n'||'res_rows_created_in_window='||count(*) filter (where created_at >= '$S2AR3_CREATED_FROM' and created_at < '$S2AR3_CREATED_TO')||E'\n'||'res_rows_wrong_company='||count(*) filter (where company_id <> $S2AR3_COMPANY)||E'\n'||'res_rows_exception='||count(*) filter (where id = '$B25PHYS_UUID')||E'\n'||'res_rows_company53='||count(*) filter (where company_id = $B25PHYS_COMPANY)||E'\n'||'res_rows_identity_ok='||count(*) filter (where company_id = $S2AR3_COMPANY and sha256 ~ '^[0-9a-f]{64}\$' and coalesce(content_type, '') <> '' and ((id = '$DOC' and kind = 'document' and size_bytes = $S2AR3_DOC_SIZE and reference = '/objects/' || id::text and storage_key = 'tenants/' || company_id || '/documents/' || id::text) or (id = '$LOGO' and kind = 'branding_logo' and size_bytes = $S2AR3_LOGO_SIZE and reference ~ ('^branding/' || company_id || '/' || replace(id::text, '-', '') || '\\.(png|jpg|webp)\$') and $(logo_key_rule_sql)))) from storage_objects where id in ($Q)"
  echo "res_rows_other=$(q "select count(*) from storage_objects where company_id in ($C) and id not in ($Q)")"
  echo "res_doc_size=$(q "select coalesce((select size_bytes::text from storage_objects where id = '$DOC'), '<absent>')")"
  echo "res_logo_size=$(q "select coalesce((select size_bytes::text from storage_objects where id = '$LOGO'), '<absent>')")"
  echo "res_live_refs=$(q "select count(*) from storage_objects l where l.id in ($Q) and (exists (select 1 from document_versions dv where dv.object_path = l.reference) or exists (select 1 from export_runs e where e.object_path = l.reference) or exists (select 1 from executive_reports r where r.object_path = l.reference) or exists (select 1 from scans sc where sc.image_url = l.reference) or exists (select 1 from companies co where co.brand_logo_key = l.reference))")"
  echo "res_docs_company=$(q "select count(*) from documents where company_id in ($C)")"
  echo "res_brand_refs=$(q "select count(*) from companies co where co.brand_logo_key ~ '^branding/($BR)/'")"
  echo "res_foreign_mentions=$(q "select count(*) from storage_objects s where s.id not in ($Q) and exists (select 1 from unnest(array[$Q]) u, lateral (select replace(u, '-', '') as h) x where s.reference like '%' || u || '%' or s.reference like '%' || x.h || '%' or s.storage_key like '%' || u || '%' or s.storage_key like '%' || x.h || '%' or coalesce(s.legacy_key,'') like '%' || u || '%' or coalesce(s.legacy_key,'') like '%' || x.h || '%' or coalesce(s.mirror_key,'') like '%' || u || '%' or coalesce(s.mirror_key,'') like '%' || x.h || '%')")"
  for cid in ${C//,/ }; do jobs+=" or payload::text like '%\"companyId\":$cid%'"; done
  echo "res_jobs_pending=$(q "select count(*) from job_queue where status in ('pending','running') and (payload::text like '%$DOC%' or payload::text like '%$LOGO%'$jobs)")"
  echo "res_inflight_sessions=$(q "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle' and query ilike '%storage_objects%'")"
  echo "res_inv_outside=$(q "select count(*) from storage_objects where id <> '$B25PHYS_UUID' and id not in ($Q)")"
  echo "res_inv_outside_exception=$(q "select count(*) from storage_objects where id <> '$B25PHYS_UUID'")"
}
# Capture the key blobs of the named rows (base64 JSON, in-session only; never printed) for the physical proofs —
# taken BEFORE any removal so the post-settlement proof re-reads the very same locations.
stage2a_residue3_blobs() {
  S2AR3_FROWS_B64="$(q "select json_build_object('companies', array[$S2AR3_COMPANIES], 'rows', coalesce(json_agg(json_build_object('id', id, 'k', storage_key)), '[]'::json)) from storage_objects where id in ($S2AR3_UUIDS_Q)" | base64 -w0)"
  S2AR3_LOC_B64="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 'm', mirror_key)), '[]'::json) from storage_objects where id in ($S2AR3_UUIDS_Q)" | base64 -w0)"
}
# ---- stage2a_residue3_eligibility_run: READ-ONLY; gathers every fact; returns 0 only on B25_STAGE2A_RESIDUE3_ELIGIBLE=TRUE ----
stage2a_residue3_eligibility_run() {
  declare -f stage2a_residue3_eligibility >/dev/null && declare -f logo_key_rule_sql >/dev/null || fail "libraries not loaded (stream b25-stage1-purge-lib.sh and b25-stage1-apply-lib.sh before this script)"
  s2ar3_constants_ok || fail "residue constants collide with the Stage 1 exception or are malformed — STOP"
  local facts="" cid rf rfacts ff pf verdict; cid="$(compose ps -q api || true)"
  section "temporary stderr file of the in-container reader (metadata only: present / size / mtime; never read; a pre-existing file is reported for review, never removed)"
  S2AR3_TMP_PRE="$(stage2a_tmp_stderr_facts)"; printf '%s\n' "$S2AR3_TMP_PRE" | sed 's/^/  /'
  section "0. read-only guard"; stage2a_readonly_guard
  section "1. host / containers / readiness / storage configuration (names, counts, digests and booleans only)"
  facts+="$(stage2a_residue_host_facts "$cid")"$'\n'
  printf '%s\n' "$facts" | grep -E '^(head_sha|current_deploy_sha|dirty|lock_absent|api_running|api_health|readyz_status|readyz_database|readyz_storage|init_record_found|init_driver|init_fallback|init_mirror|init_legacy_delete|env_names_set|env_mode|key_line_count|env_core_identity_ok|env_record_present|env_file_managed_ok|dead_jobs_total|storage_jobs_active|schema_fingerprint)=' | sed 's/^/  /'
  section "2. the named volume (no write test)"
  rf="$(stage2a_root_facts "$cid")"; facts+="$rf"$'\n'; printf '%s\n' "$rf" | grep -E '^(mount_type|mount_name|root_tenant_files|root_regular_files|root_symlinks|root_other_entries)=' | sed 's/^/  /'
  section "3. Stage 1 exception, inventory, census, originals (read-only)"
  facts+="$(stage2a_exception_facts)"$'\n'
  printf '%s\n' "$facts" | grep -E '^(exc_|inv_|census_|unmarked_|refs_count|originals_)' | sed 's/^/  /'
  section "4. the residue rows, the disposable identities and every possible reference (ids, counts, booleans only)"
  rfacts="$(stage2a_residue3_row_facts)"; facts+="$rfacts"$'\n'; printf '%s\n' "$rfacts" | sed 's/^/  /'
  section "5. physical absence (read-only): fs primary by stored key + tenant directory walk; every persisted provider location by HEAD"
  stage2a_residue3_blobs
  ff="$(stage2a_residue_fs_facts "$S2AR3_FROWS_B64")"; pf="$(stage2a_residue_provider_facts "$S2AR3_LOC_B64")"
  facts+="$ff"$'\n'; facts+="$pf"$'\n'; printf '%s\n%s\n' "$ff" "$pf" | sed 's/^/  /'
  section "6. settlement prerequisites (read-only decision; nothing is changed)"
  if verdict="$(printf '%s' "$facts" | stage2a_residue3_eligibility)"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "residue-3 eligibility evaluator failed — the lines above are the verdict (read-only; nothing changed)"; fi
  section "7. existing tenant (company $S2A_TENANT_ID) — retrospective Correction 3 proof over the incident window of run $S2AR3_RUN (its cleanup never reached the post gate; snapshot = the recorded constant; disposables = companies $S2AR3_COMPANIES, user $S2AR3_USERS; read-only)"
  S2AR3_TENANT_PROOF=FAIL
  if stage2a_tenant_incident_proof "$S2AR3_TENANT_SNAPSHOT_B64" "$S2AR3_INCIDENT_END" "$S2AR3_COMPANIES" "$S2AR3_USERS"; then S2AR3_TENANT_PROOF=PASS; fi
  echo "B25_STAGE2A_RESIDUE3_TENANT_PROOF=$S2AR3_TENANT_PROOF"
  printf '%s\n' "$S2AR3_TMP_PRE" | grep -qx 'tmp_stderr_present=true' || rm -f "$HOME"/.b25-s1-node.err
  printf '%s\n' "$verdict" | grep -qx 'B25_STAGE2A_RESIDUE3_ELIGIBLE=TRUE' && [ "$S2AR3_TENANT_PROOF" = "PASS" ]
}
phase_stage2a_residue3_eligibility() {
  [ -z "$ARG1$ARG2$ARG3" ] || fail "stage2a-residue3-eligibility takes no argument — the residue is bound by constants"
  section "manifest (readonly constants of the library; never an input; both uuids recorded unmasked from the run log)"; echo "  $S2AR3_MANIFEST (run $S2AR3_RUN)"
  if stage2a_residue3_eligibility_run; then log "stage2a-residue3-eligibility complete (read-only; nothing changed; B25_STAGE2A_RESIDUE3_ELIGIBLE=TRUE)"
  else
    # auto-purge race: the product sweep purges reconciled tombstones of a deleted company on its own schedule;
    # when the rows are already gone this is reported explicitly — nothing is recreated and nothing can ever settle.
    local left; left="$(q "select count(*) from storage_objects where id in ($S2AR3_UUIDS_Q)" 2>/dev/null || echo "?")"
    if [ "$left" = "0" ]; then echo "B25_STAGE2A_RESIDUE3_ROWS_ALREADY_ABSENT=TRUE (the product sweep purged the company-$S2AR3_COMPANY tombstones; the reviewed settlement did NOT run and never will for this manifest; independent review decides)"; fi
    fail "stage2a-residue3-eligibility: prerequisites not met (read-only; nothing changed; B25_STAGE2A_RESIDUE3_ELIGIBLE=FALSE; rows_present=$left)"
  fi
}
# MUTATION — ONE session: A eligibility (TRUE or nothing happens) → B1/B2 absence re-proven per uuid → C the two rows
# removed in one row-locked, allow-listed transaction → D post-settlement proof over re-read facts.
phase_stage2a_residue3_settle() {
  [ -z "$ARG1$ARG2$ARG3" ] || fail "stage2a-residue3-settle takes no argument — the residue is bound by constants"
  declare -f purge_result_check >/dev/null || fail "purge library not loaded (stream b25-stage1-purge-lib.sh before this script)"
  section "manifest (readonly constants of the library; never an input)"; echo "  $S2AR3_MANIFEST (run $S2AR3_RUN)"
  section "A. eligibility — read-only proof in THIS session (no mutation unless B25_STAGE2A_RESIDUE3_ELIGIBLE=TRUE)"
  stage2a_residue3_eligibility_run || fail "settlement refused: B25_STAGE2A_RESIDUE3_ELIGIBLE is not TRUE in this session — nothing changed"
  stage2a_lock
  local frows="$S2AR3_FROWS_B64" loc="$S2AR3_LOC_B64" u k1 fj pj triple
  [ -n "$frows" ] && [ -n "$loc" ] || fail "the key blobs of the residue rows were not captured — STOP (nothing changed)"
  section "B1. fs primary absence re-proven PER UUID immediately before the removal (lstat of the stored key; nothing is deleted to make this true)"
  for u in "$S2AR3_UUID_DOC" "$S2AR3_UUID_LOGO"; do
    k1="$(q "select json_build_object('companies', array[$S2AR3_COMPANIES], 'rows', coalesce(json_agg(json_build_object('id', id, 'k', storage_key)), '[]'::json)) from storage_objects where id = '$u'" | base64 -w0)"
    fj="$(api_node "$STAGE2A_FS_ABSENT_JS" "$k1")"; echo "  $u ($(s2ar3_kind "$u")): fs $fj"
    [ "$(census_field "$fj" checked count 2>/dev/null || echo x)" = "1" ] && [ "$(census_field "$fj" absent count 2>/dev/null || echo x)" = "1" ] && [ "$(census_field "$fj" tenant_files count 2>/dev/null || echo x)" = "0" ] || fail "the fs primary of $u still exists or could not be checked — STOP: no row is removed, nothing is deleted"
  done
  section "B2. mirror absence re-proven PER UUID (every persisted provider location by HEAD; a read failure is NOT absence)"
  for u in "$S2AR3_UUID_DOC" "$S2AR3_UUID_LOGO"; do
    k1="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 'm', mirror_key)), '[]'::json) from storage_objects where id = '$u'" | base64 -w0)"
    pj="$(api_node "$PROVIDER_RULES_JS"$'\n'"$STAGE2A_PROVIDER_ABSENT_JS" "$k1")"; echo "  $u ($(s2ar3_kind "$u")): provider $pj"
    if printf '%s' "$pj" | grep -q '"error"'; then fail "the provider state of $u could not be read — STOP: no row is removed, no provider call is issued"; fi
    [ "$(census_field "$pj" checked count 2>/dev/null || echo x)" = "1" ] && [ "$(census_field "$pj" absent count 2>/dev/null || echo x)" = "1" ] || fail "a persisted provider location of $u still answers — STOP: no row is removed, no provider delete is issued (never unconditioned)"
  done
  section "C. remove EXACTLY the two tombstone rows (Stage 2A allow-list; ONE row-locked transaction; locked = allowed = deleted = $S2AR3_ROWS or nothing is deleted)"
  triple="$(qw "$(stage2a_purge_rows_sql "$S2AR3_UUIDS_Q" "$S2AR3_COMPANY" "$S2AR3_ROWS")")"
  purge_result_check "$triple" "$S2AR3_ROWS" || fail "the allow-listed delete did not remove exactly the two rows (the statement deletes nothing unless locked = allowed = expected = $S2AR3_ROWS): $triple — STOP"
  [ "$(q "select count(*) from storage_objects where id in ($S2AR3_UUIDS_Q)")" = "0" ] || fail "a residue row remains after the transaction — STOP"
  echo "  rows removed: $S2AR3_ROWS ($S2AR3_UUID_DOC, $S2AR3_UUID_LOGO)"
  rm -f "$STAGE2A_LOCK_FILE"   # the mutation is complete; the proof below is read-only and must find no lock
  section "D. post-settlement proof (read-only; fs / provider absence re-read with the key blobs captured BEFORE the removal; census re-read)"
  local facts="" cid verdict; cid="$(compose ps -q api || true)"
  facts+="$(stage2a_residue_host_facts "$cid")"$'\n'
  facts+="$(stage2a_root_facts "$cid")"$'\n'
  facts+="$(stage2a_exception_facts)"$'\n'
  facts+="$(stage2a_residue3_row_facts)"$'\n'
  facts+="$(stage2a_residue_fs_facts "$frows")"$'\n'; facts+="$(stage2a_residue_provider_facts "$loc")"$'\n'
  printf '%s\n' "$facts" | grep -E '^(res_|exc_|inv_|census_|unmarked_|originals_|root_tenant_files|leak_|web_leak_|readyz_|api_health|lock_absent|head_sha|current_deploy_sha|dirty|init_driver|init_fallback|init_mirror|init_legacy_delete|env_record_present|env_file_managed_ok|key_line_count|env_mode)=' | sed 's/^/  /'
  if verdict="$(printf '%s' "$facts" | stage2a_residue3_settled)"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "residue-3 post-settlement evaluator failed — the lines above are the verdict; the rows are removed; no further change is made; independent review required"; fi
  printf '%s\n' "${S2AR3_TMP_PRE:-}" | grep -qx 'tmp_stderr_present=true' || rm -f "$HOME"/.b25-s1-node.err
  printf '%s\n' "$verdict" | grep -qx 'B25_STAGE2A_RESIDUE3_SETTLED=TRUE' || fail "post-settlement proof FAILED — the two rows are removed; no further change is made; independent review required"
  log "stage2a-residue3-settle complete (B25_STAGE2A_RESIDUE3_SETTLED=TRUE)"
}

# =============================================================================
# B25 STAGE 2A — CORRECTION 7: settlement of the EXACT residue of the Correction-6 final smoke run
# 39880703889 (job 120177129536, tag 2c4bfb197fd4): the two `deleted` fs tombstones of deleted company 60
# (document 04769ee1…, branding_logo 6f2594d8…; both uuids read unmasked from the run log; mirror keys
# recorded; last_error NULL at the last read). Same structure as the reviewed Correction 1 / 2 / 4 phases
# above, bound to the readonly S2AR4_* constants (no ARG is read; one is refused); the shared probe readers
# stage2a_residue_fs_facts / _provider_facts / _host_facts are reused. Differences required by the facts:
#   • the inventory is judged under the PROTECTED model (Correction 5): the exception + the real tenant's
#     protected set P + the residue rows; P is compared with the pre-smoke record that run's setup printed
#     (rec_* constants of the library) — "the exception row only" is never assumed;
#   • the CURRENT physical state is unknown (the product's own purge may have run since 00:55:08Z): the
#     read-only inspection proves fs + provider absence at the rows' own locations when the rows are present
#     (ROWS_PRESENT → B25_STAGE2A_RESIDUE4_ELIGIBLE) or at the manifest's canonical locations — the document
#     key + every logo extension candidate — when the rows are already gone (ROWS_ABSENT →
#     B25_STAGE2A_RESIDUE4_ALREADY_ABSENT); a file or mirror object that still exists is reported as the
#     product purge still pending (B25_STAGE2A_RESIDUE4_PURGE_PENDING=TRUE) and nothing is eligible;
#   • every verdict is printed before any decision (Correction 7 reporting rule).
#   stage2a-residue4-eligibility  READ-ONLY: 16 prerequisites (B25_STAGE2A_RESIDUE4_ELIGIBLE /
#                                 B25_STAGE2A_RESIDUE4_ALREADY_ABSENT); changes nothing
#   stage2a-residue4-settle       MUTATION, one session: the same eligibility proof (ELIGIBLE required; an
#                                 ALREADY_ABSENT state SKIPS the settlement without any write) → fs + mirror
#                                 absence re-proven PER UUID → exactly the two rows removed by the Stage 2A
#                                 allow-list in one row-locked transaction → post proof (B25_STAGE2A_RESIDUE4_SETTLED)
# No provider delete and no file delete exist in these phases. Filesystem object deletion: ZERO. Provider object
# deletion: ZERO. Customer-object mutation: ZERO. The Stage 1 exception (f048b5d4…, company 53) is denied by
# constant in the library, in the allow-list and in every predicate.
# =============================================================================
S2AR4_TMP_PRE=""; S2AR4_FORM=""; S2AR4_PROTECTED_FACTS=""
S2AR4_FROWS_B64=""; S2AR4_LOC_B64=""   # key blobs of the physical proof, captured by the eligibility read (in-session; never printed)
# Read-only facts about the two named rows, the disposable identities and everything that could reference them.
stage2a_residue4_row_facts() {
  local C="$S2AR4_COMPANIES" U="$S2AR4_USERS" DOM="$SMOKE_DOMAIN" TAG="$S2AR4_TAG" Q="$S2AR4_UUIDS_Q" DOC="$S2AR4_UUID_DOC" LOGO="$S2AR4_UUID_LOGO" BR="${S2AR4_COMPANIES//,/|}" cid jobs="" named
  echo "res_constants_ok=$(s2ar4_constants_ok && echo true || echo false)"
  echo "res_companies_present=$(q "select count(*) from companies where id in ($C) or name like 'B25 SMOKE $TAG%'")"
  echo "res_users_present=$(q "select count(*) from users where id in ($U) or email like 'b25-smoke-$TAG-%@$DOM'")"
  echo "res_sessions=$(q "select count(*) from sessions where user_id in ($U) or user_id in (select id from users where company_id in ($C))")"
  echo "res_feature_rows=$(q "select (select count(*) from subscriptions where company_id in ($C)) + (select count(*) from documents where company_id in ($C)) + (select count(*) from document_versions where company_id in ($C)) + (select count(*) from export_runs where company_id in ($C)) + (select count(*) from executive_reports where company_id in ($C)) + (select count(*) from scans where company_id in ($C)) + (select count(*) from contacts where company_id in ($C)) + (select count(*) from leads where company_id in ($C)) + (select count(*) from audit_logs where company_id in ($C) or user_id in ($U)) + (select count(*) from activity_logs where company_id in ($C) or user_id in ($U)) + (select count(*) from login_attempts where email like 'b25-smoke-$TAG%@$DOM')")"
  # the two named rows: one read-only statement, one fact per line (counts over the rows whose id is in the constant list)
  q "select 'res_rows_named='||count(*)||E'\n'||'res_rows_deleted='||count(*) filter (where state = 'deleted')||E'\n'||'res_rows_fs='||count(*) filter (where driver = 'fs')||E'\n'||'res_rows_legacy_null='||count(*) filter (where legacy_key is null)||E'\n'||'res_rows_mirror_canonical='||count(*) filter (where mirror_key is not null and mirror_key = 'gs://' || split_part(split_part(mirror_key, '://', 2), '/', 1) || '/' || storage_key)||E'\n'||'res_rows_mirror_ok='||count(*) filter (where mirror_state = 'ok')||E'\n'||'res_rows_error_null='||count(*) filter (where last_error is null)||E'\n'||'res_rows_not_uncertain='||count(*) filter (where publication_uncertain_at is null)||E'\n'||'res_rows_no_lease='||count(*) filter (where lease_token is null and lease_expires_at is null)||E'\n'||'res_rows_deleted_at_set='||count(*) filter (where deleted_at is not null)||E'\n'||'res_rows_deleted_in_window='||count(*) filter (where deleted_at >= '$S2AR4_DELETED_FROM' and deleted_at < '$S2AR4_DELETED_TO')||E'\n'||'res_rows_created_in_window='||count(*) filter (where created_at >= '$S2AR4_CREATED_FROM' and created_at < '$S2AR4_CREATED_TO')||E'\n'||'res_rows_wrong_company='||count(*) filter (where company_id <> $S2AR4_COMPANY)||E'\n'||'res_rows_exception='||count(*) filter (where id = '$B25PHYS_UUID')||E'\n'||'res_rows_company53='||count(*) filter (where company_id = $B25PHYS_COMPANY)||E'\n'||'res_rows_identity_ok='||count(*) filter (where company_id = $S2AR4_COMPANY and sha256 ~ '^[0-9a-f]{64}\$' and coalesce(content_type, '') <> '' and ((id = '$DOC' and kind = 'document' and size_bytes = $S2AR4_DOC_SIZE and reference = '/objects/' || id::text and storage_key = 'tenants/' || company_id || '/documents/' || id::text) or (id = '$LOGO' and kind = 'branding_logo' and size_bytes = $S2AR4_LOGO_SIZE and reference ~ ('^branding/' || company_id || '/' || replace(id::text, '-', '') || '\\.(png|jpg|webp)\$') and $(logo_key_rule_sql)))) from storage_objects where id in ($Q)"
  echo "res_rows_key_canonical=$(q "select count(*) from storage_objects where (id = '$DOC' and storage_key = '$S2AR4_KEY_DOC') or (id = '$LOGO' and storage_key in ($S2AR4_LOGO_KEYS_Q))")"
  echo "res_rows_reference_canonical=$(q "select count(*) from storage_objects where (id = '$DOC' and reference = '/objects/$DOC') or (id = '$LOGO' and reference ~ '^branding/$S2AR4_COMPANY/$S2AR4_LOGO_HEX\\.(png|jpg|webp)\$')")"
  echo "res_rows_other=$(q "select count(*) from storage_objects where company_id in ($C) and id not in ($Q)")"
  echo "res_doc_size=$(q "select coalesce((select size_bytes::text from storage_objects where id = '$DOC'), '<absent>')")"
  echo "res_logo_size=$(q "select coalesce((select size_bytes::text from storage_objects where id = '$LOGO'), '<absent>')")"
  echo "res_live_refs=$(q "select count(*) from storage_objects l where l.id in ($Q) and (exists (select 1 from document_versions dv where dv.object_path = l.reference) or exists (select 1 from export_runs e where e.object_path = l.reference) or exists (select 1 from executive_reports r where r.object_path = l.reference) or exists (select 1 from scans sc where sc.image_url = l.reference) or exists (select 1 from companies co where co.brand_logo_key = l.reference))")"
  echo "res_docs_company=$(q "select count(*) from documents where company_id in ($C)")"
  echo "res_brand_refs=$(q "select count(*) from companies co where co.brand_logo_key ~ '^branding/($BR)/'")"
  echo "res_foreign_mentions=$(q "select count(*) from storage_objects s where s.id not in ($Q) and exists (select 1 from unnest(array[$Q]) u, lateral (select replace(u, '-', '') as h) x where s.reference like '%' || u || '%' or s.reference like '%' || x.h || '%' or s.storage_key like '%' || u || '%' or s.storage_key like '%' || x.h || '%' or coalesce(s.legacy_key,'') like '%' || u || '%' or coalesce(s.legacy_key,'') like '%' || x.h || '%' or coalesce(s.mirror_key,'') like '%' || u || '%' or coalesce(s.mirror_key,'') like '%' || x.h || '%')")"
  for cid in ${C//,/ }; do jobs+=" or payload::text like '%\"companyId\":$cid%'"; done
  echo "res_jobs_pending=$(q "select count(*) from job_queue where status in ('pending','running') and (payload::text like '%$DOC%' or payload::text like '%$LOGO%'$jobs)")"
  echo "res_inflight_sessions=$(q "select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle' and query ilike '%storage_objects%'")"
  echo "res_inv_outside=$(q "select count(*) from storage_objects where id <> '$B25PHYS_UUID' and id not in ($Q)")"
  echo "res_inv_outside_exception=$(q "select count(*) from storage_objects where id <> '$B25PHYS_UUID'")"
  named="$(q "select count(*) from storage_objects where id in ($Q)")"
  case "$named" in
    2) echo "res_form=ROWS_PRESENT"; echo "res_phys_expected=$S2AR4_ROWS" ;;
    0) echo "res_form=ROWS_ABSENT"; echo "res_phys_expected=$S2AR4_LOC_COUNT" ;;
    *) echo "res_form=UNEXPECTED"; echo "res_phys_expected=0" ;;
  esac
}
# Capture the key blobs for the physical proofs (base64 JSON, in-session only; never printed) — taken BEFORE any removal so
# the post-settlement proof re-reads the very same locations. Rows present → the rows' own stored locations; rows absent →
# the manifest's canonical locations (the document key + every logo extension candidate; no legacy location ever existed).
stage2a_residue4_blobs() {
  local named; named="$(q "select count(*) from storage_objects where id in ($S2AR4_UUIDS_Q)")"
  if [ "$named" = "0" ]; then
    S2AR4_FROWS_B64="$(printf '{"companies":[%s],"rows":[%s]}' "$S2AR4_COMPANIES" "$(s2ar4_manifest_rows_json)" | base64 -w0)"
    S2AR4_LOC_B64="$(printf '[%s]' "$(s2ar4_manifest_loc_json)" | base64 -w0)"
  else
    S2AR4_FROWS_B64="$(q "select json_build_object('companies', array[$S2AR4_COMPANIES], 'rows', coalesce(json_agg(json_build_object('id', id, 'k', storage_key)), '[]'::json)) from storage_objects where id in ($S2AR4_UUIDS_Q)" | base64 -w0)"
    S2AR4_LOC_B64="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 'm', mirror_key)), '[]'::json) from storage_objects where id in ($S2AR4_UUIDS_Q)" | base64 -w0)"
  fi
}
# The protected live inventory (Correction 5) in the form of the residue, compared with the pre-smoke record of run
# 39880703889: the two tombstones are excluded from P while they exist (tombstone form, R = 2), nothing is excluded once
# they are gone (pre-smoke form). Prints the facts and the protected verdict; emits res_protected_gate / res_protected_failed.
stage2a_residue4_protected_facts() {   # <ROWS_PRESENT|ROWS_ABSENT|UNEXPECTED> → facts (stdout); the verdict lines go to stdout too, prefixed for the log
  local form="$1" csv="" R=0 pform=live pfacts pverdict
  if [ "$form" = ROWS_PRESENT ]; then csv="$S2AR4_CSV"; R=2; pform=tombstone; fi
  pfacts="$(stage2a_protected_facts "$csv")" || { echo "res_protected_gate=UNREADABLE"; echo "res_protected_failed=?"; return 0; }
  pfacts+=$'\n'"$(s2ar4_record_facts)"
  printf '%s\n' "$pfacts"
  if pverdict="$(printf '%s\n' "$pfacts" | stage2a_protected_eval "$R" 0 require "$pform")"; then :; fi
  printf '%s\n' "$pverdict" | sed 's/^/  /' >&2
  echo "res_protected_gate=$(printf '%s\n' "$pverdict" | sed -nE 's/^B25_STAGE2A_PROTECTED_GATE=([A-Z]+)$/\1/p' | head -1 | sed 's/^$/UNREADABLE/')"
  echo "res_protected_failed=$(printf '%s\n' "$pverdict" | sed -nE 's/^B25_STAGE2A_PROTECTED_CONDITIONS_FAILED=([0-9]+)$/\1/p' | head -1 | sed 's/^$/?/')"
  S2AR4_PROTECTED_FACTS="$pfacts"
}
# ---- stage2a_residue4_eligibility_run: READ-ONLY; gathers every fact; returns 0 on ELIGIBLE=TRUE or ALREADY_ABSENT=TRUE ----
stage2a_residue4_eligibility_run() {
  declare -f stage2a_residue4_eligibility >/dev/null && declare -f logo_key_rule_sql >/dev/null || fail "libraries not loaded (stream b25-stage1-purge-lib.sh and b25-stage1-apply-lib.sh before this script)"
  s2ar4_constants_ok || fail "residue-4 constants collide with the Stage 1 exception or an earlier manifest, or are malformed — STOP"
  local facts="" cid rf rfacts pf4 ff pf verdict; cid="$(compose ps -q api || true)"
  section "temporary stderr file of the in-container reader (metadata only: present / size / mtime; never read; a pre-existing file is reported for review, never removed)"
  S2AR4_TMP_PRE="$(stage2a_tmp_stderr_facts)"; printf '%s\n' "$S2AR4_TMP_PRE" | sed 's/^/  /'
  section "0. read-only guard"; stage2a_readonly_guard
  section "1. host / containers / readiness / storage configuration (names, counts, digests and booleans only)"
  facts+="$(stage2a_residue_host_facts "$cid")"$'\n'
  printf '%s\n' "$facts" | grep -E '^(head_sha|current_deploy_sha|dirty|lock_absent|api_running|api_health|readyz_status|readyz_database|readyz_storage|init_record_found|init_driver|init_fallback|init_mirror|init_legacy_delete|env_names_set|env_mode|key_line_count|env_core_identity_ok|env_record_present|env_file_managed_ok|dead_jobs_total|storage_jobs_active|schema_fingerprint|env_driver_is_fs|env_root_is_locked|env_fallback_is_true|env_mirror_is_gcs|env_legacy_delete_off|env_key_set|leak_|web_leak_)' | sed 's/^/  /'
  section "2. the named volume (no write test)"
  rf="$(stage2a_root_facts "$cid")"; facts+="$rf"$'\n'; printf '%s\n' "$rf" | grep -E '^(mount_type|mount_name|root_tenant_files|root_regular_files|root_symlinks|root_other_entries)=' | sed 's/^/  /'
  section "3. the residue rows, the disposable identities and every possible reference (ids, counts, booleans only)"
  rfacts="$(stage2a_residue4_row_facts)"; facts+="$rfacts"$'\n'; printf '%s\n' "$rfacts" | sed 's/^/  /'
  S2AR4_FORM="$(s2a_fv "$rfacts" res_form)"
  section "4. protected live inventory (Correction 5) in the form of the residue ($S2AR4_FORM) compared with the pre-smoke record of run $S2AR4_RUN; the Stage 1 exception, census and originals (read-only)"
  pf4="$(stage2a_residue4_protected_facts "$S2AR4_FORM")"; facts+="$pf4"$'\n'
  printf '%s\n' "$pf4" | grep -E '^(protected_|tenant_keys_md5|tenant_live_keys_md5|pf_|pm_|rec_|res_protected_|inv_|exc_(row_count|state|last_error|driver|company|size|provider_present|generation_digest)|census_|unmarked_|originals_|refs_)' | sed 's/^/  /'
  section "5. physical state (read-only): fs primary by key + tenant directory walk; every persisted provider location by HEAD ($S2AR4_FORM: the rows' own locations, or the manifest's canonical locations incl. every logo extension candidate)"
  stage2a_residue4_blobs
  ff="$(stage2a_residue_fs_facts "$S2AR4_FROWS_B64")"; pf="$(stage2a_residue_provider_facts "$S2AR4_LOC_B64")"
  facts+="$ff"$'\n'; facts+="$pf"$'\n'; printf '%s\n%s\n' "$ff" "$pf" | sed 's/^/  /'
  section "6. residue-4 prerequisites (read-only decision; nothing is changed)"
  if verdict="$(printf '%s' "$facts" | stage2a_residue4_eligibility)"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "residue-4 evaluator failed — the lines above are the verdict (read-only; nothing changed)"; fi
  if [ "$S2AR4_FORM" = ROWS_PRESENT ] && { [ "$(s2a_fv "$ff" res_fs_absent)" != "$(s2a_fv "$ff" res_fs_checked)" ] || [ "$(s2a_fv "$pf" res_prov_absent)" != "$(s2a_fv "$pf" res_prov_checked)" ]; }; then
    echo "B25_STAGE2A_RESIDUE4_PURGE_PENDING=TRUE (a file or a mirror object of the tombstones still exists: the product's own purge has not completed — nothing is eligible; this tooling never deletes a file or a provider object; re-inspect later)"
  else echo "B25_STAGE2A_RESIDUE4_PURGE_PENDING=FALSE"; fi
  printf '%s\n' "${S2AR4_TMP_PRE:-}" | grep -qx 'tmp_stderr_present=true' || rm -f "$HOME"/.b25-s1-node.err
  printf '%s\n' "$verdict" | grep -qxE 'B25_STAGE2A_RESIDUE4_(ELIGIBLE|ALREADY_ABSENT)=TRUE'
}
phase_stage2a_residue4_eligibility() {
  [ -z "$ARG1$ARG2$ARG3" ] || fail "stage2a-residue4-eligibility takes no argument — the residue is bound by constants"
  section "manifest (readonly constants of the library; never an input; both uuids recorded unmasked from the run log)"; echo "  $S2AR4_MANIFEST (run $S2AR4_RUN, job $S2AR4_JOB)"
  if stage2a_residue4_eligibility_run; then log "stage2a-residue4-eligibility complete (read-only; nothing changed; form $S2AR4_FORM)"
  else fail "stage2a-residue4-eligibility: prerequisites not met (read-only; nothing changed; form ${S2AR4_FORM:-UNKNOWN}; B25_STAGE2A_RESIDUE4_ELIGIBLE=FALSE; B25_STAGE2A_RESIDUE4_ALREADY_ABSENT=FALSE)"; fi
}
# MUTATION — ONE session: A eligibility (ELIGIBLE=TRUE or nothing happens; ALREADY_ABSENT skips without any write) →
# B1/B2 absence re-proven per uuid → C the two rows removed in one row-locked, allow-listed transaction → D post proof.
phase_stage2a_residue4_settle() {
  [ -z "$ARG1$ARG2$ARG3" ] || fail "stage2a-residue4-settle takes no argument — the residue is bound by constants"
  declare -f purge_result_check >/dev/null || fail "purge library not loaded (stream b25-stage1-purge-lib.sh before this script)"
  section "manifest (readonly constants of the library; never an input)"; echo "  $S2AR4_MANIFEST (run $S2AR4_RUN, job $S2AR4_JOB)"
  section "A. eligibility — read-only proof in THIS session (no mutation unless B25_STAGE2A_RESIDUE4_ELIGIBLE=TRUE)"
  stage2a_residue4_eligibility_run || fail "settlement refused: neither B25_STAGE2A_RESIDUE4_ELIGIBLE nor B25_STAGE2A_RESIDUE4_ALREADY_ABSENT is TRUE in this session — nothing changed"
  if [ "$S2AR4_FORM" = ROWS_ABSENT ]; then
    echo "B25_STAGE2A_RESIDUE4_SETTLEMENT_SKIPPED_ALREADY_ABSENT=TRUE (both rows are already gone and their locations are proven empty: nothing is created, nothing is deleted; no lock, no transaction)"
    log "stage2a-residue4-settle complete (skipped: already absent; nothing changed)"; return 0
  fi
  [ "$S2AR4_FORM" = ROWS_PRESENT ] || fail "settlement refused: unexpected residue form ${S2AR4_FORM:-UNKNOWN} — nothing changed"
  stage2a_lock
  local frows="$S2AR4_FROWS_B64" loc="$S2AR4_LOC_B64" u k1 fj pj triple
  [ -n "$frows" ] && [ -n "$loc" ] || fail "the key blobs of the residue rows were not captured — STOP (nothing changed)"
  section "B1. fs primary absence re-proven PER UUID immediately before the removal (lstat of the stored key; nothing is deleted to make this true)"
  for u in "$S2AR4_UUID_DOC" "$S2AR4_UUID_LOGO"; do
    k1="$(q "select json_build_object('companies', array[$S2AR4_COMPANIES], 'rows', coalesce(json_agg(json_build_object('id', id, 'k', storage_key)), '[]'::json)) from storage_objects where id = '$u'" | base64 -w0)"
    fj="$(api_node "$STAGE2A_FS_ABSENT_JS" "$k1")"; echo "  $u ($(s2ar4_kind "$u")): fs $fj"
    [ "$(census_field "$fj" checked count 2>/dev/null || echo x)" = "1" ] && [ "$(census_field "$fj" absent count 2>/dev/null || echo x)" = "1" ] && [ "$(census_field "$fj" tenant_files count 2>/dev/null || echo x)" = "0" ] || fail "the fs primary of $u still exists or could not be checked — STOP: no row is removed, nothing is deleted"
  done
  section "B2. mirror absence re-proven PER UUID (every persisted provider location by HEAD; a read failure is NOT absence)"
  for u in "$S2AR4_UUID_DOC" "$S2AR4_UUID_LOGO"; do
    k1="$(q "select coalesce(json_agg(json_build_object('id', id, 'k', storage_key, 'l', legacy_key, 'm', mirror_key)), '[]'::json) from storage_objects where id = '$u'" | base64 -w0)"
    pj="$(api_node "$PROVIDER_RULES_JS"$'\n'"$STAGE2A_PROVIDER_ABSENT_JS" "$k1")"; echo "  $u ($(s2ar4_kind "$u")): provider $pj"
    if printf '%s' "$pj" | grep -q '"error"'; then fail "the provider state of $u could not be read — STOP: no row is removed, no provider call is issued"; fi
    [ "$(census_field "$pj" checked count 2>/dev/null || echo x)" = "1" ] && [ "$(census_field "$pj" absent count 2>/dev/null || echo x)" = "1" ] || fail "a persisted provider location of $u still answers — STOP: no row is removed, no provider delete is issued (never unconditioned)"
  done
  section "C. remove EXACTLY the two tombstone rows (Stage 2A allow-list; ONE row-locked transaction; locked = allowed = deleted = $S2AR4_ROWS or nothing is deleted)"
  triple="$(qw "$(stage2a_purge_rows_sql "$S2AR4_UUIDS_Q" "$S2AR4_COMPANY" "$S2AR4_ROWS")")"
  purge_result_check "$triple" "$S2AR4_ROWS" || fail "the allow-listed delete did not remove exactly the two rows (the statement deletes nothing unless locked = allowed = expected = $S2AR4_ROWS): $triple — STOP"
  [ "$(q "select count(*) from storage_objects where id in ($S2AR4_UUIDS_Q)")" = "0" ] || fail "a residue row remains after the transaction — STOP"
  echo "  rows removed: $S2AR4_ROWS ($S2AR4_UUID_DOC, $S2AR4_UUID_LOGO); filesystem objects deleted: 0; provider objects deleted: 0; customer objects changed: 0"
  rm -f "$STAGE2A_LOCK_FILE"   # the mutation is complete; the proof below is read-only and must find no lock
  section "D. post-settlement proof (read-only; fs / provider absence re-read with the key blobs captured BEFORE the removal; the protected set re-proven in the pre-smoke form against the record; census re-read)"
  local facts="" cid verdict pf4; cid="$(compose ps -q api || true)"
  facts+="$(stage2a_residue_host_facts "$cid")"$'\n'
  facts+="$(stage2a_root_facts "$cid")"$'\n'
  facts+="$(stage2a_residue4_row_facts)"$'\n'
  pf4="$(stage2a_residue4_protected_facts ROWS_ABSENT)"; facts+="$pf4"$'\n'
  facts+="$(stage2a_residue_fs_facts "$frows")"$'\n'; facts+="$(stage2a_residue_provider_facts "$loc")"$'\n'
  printf '%s\n' "$facts" | grep -E '^(res_|protected_|tenant_keys_md5|tenant_live_keys_md5|pf_|pm_|rec_|exc_|inv_|census_|unmarked_|originals_|refs_|root_tenant_files|leak_|web_leak_|readyz_|api_health|lock_absent|head_sha|current_deploy_sha|dirty|init_driver|init_fallback|init_mirror|init_legacy_delete|env_record_present|env_file_managed_ok|key_line_count|env_mode)=' | sed 's/^/  /'
  if verdict="$(printf '%s' "$facts" | stage2a_residue4_settled)"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "post-settlement evaluator failed — the two rows are removed; no further change is made; independent review required"; fi
  section "housekeeping (tooling files only; never a storage object): the in-container reader's temporary stderr file"
  if printf '%s\n' "${S2AR4_TMP_PRE:-}" | grep -qx 'tmp_stderr_present=true'; then echo "  pre-existing temporary stderr file left in place for review"; else rm -f "$HOME"/.b25-s1-node.err; echo "  temporary stderr file of this session removed"; fi
  printf '%s\n' "$verdict" | grep -qx 'B25_STAGE2A_RESIDUE4_SETTLED=TRUE' || fail "post-settlement proof FAILED — the two rows are removed; no further change is made; independent review required"
  log "stage2a-residue4-settle complete (B25_STAGE2A_RESIDUE4_SETTLED=TRUE)"
}

# =============================================================================
# Stage 2A — existing-tenant baseline DRIFT LOCALIZATION (READ-ONLY; no input used; constants only).
# The corrected smoke run 38934705535 stopped inside guards_stage2a_switched — before the disposable owner
# insert and before any other write — because tenant_md5 (ONE digest over the composition of the existing
# tenant, company 1) no longer equals the accepted TENANT_BASELINE_MD5. A digest cannot say WHICH component
# moved. This phase localizes the movement without printing the composition: the digest verdict, the kept-row
# counts in the cleanup's accepted format, and per table of the digest the number of company rows created /
# modified / soft-deleted at or after the instant the guard LAST matched (run 38922592504, step "Stage 2A
# smoke — setup", started 2026-10-16T15:17:33Z, passed) — the guard FIRST differed in run 38934705535 (same
# step, started 2026-10-16T16:48:22Z). Only counts, booleans, digests, fixed action / task identifiers and the
# tooling's own step timestamps are printed: no status, plan, name digest, subscription field, permission or
# any other tenant value. Nothing is written. TENANT_BASELINE_MD5 is NOT changed here: re-acceptance of a
# moved baseline is an owner decision taken on this report, never a tooling constant edited to make a guard pass.
# =============================================================================
S2A_TENANT_COMPANY=1
S2A_TENANT_LAST_MATCH="2026-10-16 15:17:33"      # UTC wall clock as stored (timestamp without time zone, like the S2AR2 windows)
S2A_TENANT_FIRST_DIFFERS="2026-10-16 16:48:22"   # run 38934705535 — the first guards_stage2a_switched that failed
S2A_COUNTS_RE='^[a-z0-9_]+=[0-9]+( [a-z0-9_]+=[0-9]+)*$'
s2a_counts_line() {   # <label> <sql returning ONE "k=n k=n" line> → "  <label>: <line>" after shape validation; fails closed, never prints an unexpected shape
  local v; v="$(q "$2")" || fail "tenant drift: could not read $1"
  [[ "$v" =~ $S2A_COUNTS_RE ]] || fail "tenant drift: $1 returned an unexpected shape (not printed)"
  echo "  $1: $v"
}
s2a_bool() { case "$1" in t) echo true ;; f) echo false ;; *) echo unknown ;; esac; }
stage2a_tenant_drift_table_facts() {   # <table with company_id> <has updated_at 0|1> <has deleted_at 0|1> — counts only
  local t="$1" T="$S2A_TENANT_LAST_MATCH" sel
  sel="select 'total='||count(*)||' created_since='||count(*) filter (where created_at >= '$T')"
  [ "$2" = 1 ] && sel+="||' modified_since='||count(*) filter (where created_at < '$T' and updated_at >= '$T')"
  [ "$3" = 1 ] && sel+="||' soft_deleted_since='||count(*) filter (where deleted_at >= '$T')"
  sel+=" from $t where company_id = $S2A_TENANT_COMPANY"
  s2a_counts_line "$t" "$sel"
}
phase_stage2a_tenant_drift() {
  local T="$S2A_TENANT_LAST_MATCH"
  section "0. read-only guard"; stage2a_readonly_guard
  section "1. the digest that stopped the smoke (guards_stage2a_switched; compared here, never re-accepted here)"
  local tb verdict; tb="$(tenant_md5)" || fail "could not compute the existing-tenant baseline digest"
  if [ "$tb" = "$TENANT_BASELINE_MD5" ]; then verdict=MATCH; else verdict=DIFFERS; fi
  echo "tenant_baseline_md5=$tb accepted=$TENANT_BASELINE_MD5 verdict=$verdict last_match_utc=${T/ /T}Z first_differs_utc=${S2A_TENANT_FIRST_DIFFERS/ /T}Z now_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  section "2. kept-row counts (the cleanup's accepted format; whole database; the Stage 1 exception is the one storage row)"
  s2a_counts_line "rows" "select 'companies='||(select count(*) from companies)||' users='||(select count(*) from users)||' subscriptions='||(select count(*) from subscriptions)||' contacts='||(select count(*) from contacts)||' leads='||(select count(*) from leads)||' events='||(select count(*) from events)||' scans='||(select count(*) from scans)||' documents='||(select count(*) from documents)||' export_runs='||(select count(*) from export_runs)||' audit='||(select count(*) from audit_logs)||' activity='||(select count(*) from activity_logs)||' login_attempts='||(select count(*) from login_attempts)||' storage_objects='||(select count(*) from storage_objects)"
  section "3. company $S2A_TENANT_COMPANY rows created / modified / soft-deleted at or after the last matching guard (every table of the digest; counts only)"
  stage2a_tenant_drift_table_facts users 1 1
  stage2a_tenant_drift_table_facts roles 1 0
  s2a_counts_line "user_roles" "select 'total='||count(*)||' created_since='||count(*) filter (where ur.created_at >= '$T') from user_roles ur join users u on u.id = ur.user_id where u.company_id = $S2A_TENANT_COMPANY"
  stage2a_tenant_drift_table_facts contacts 1 1
  stage2a_tenant_drift_table_facts leads 1 1
  stage2a_tenant_drift_table_facts events 1 1
  stage2a_tenant_drift_table_facts tasks 1 0
  stage2a_tenant_drift_table_facts tags 1 1
  stage2a_tenant_drift_table_facts lead_tags 0 0
  stage2a_tenant_drift_table_facts documents 1 1
  stage2a_tenant_drift_table_facts workflow_definitions 1 0
  stage2a_tenant_drift_table_facts workflow_runs 1 0
  stage2a_tenant_drift_table_facts billing_checkout_sessions 1 0
  stage2a_tenant_drift_table_facts subscription_usage_reservations 0 0
  stage2a_tenant_drift_table_facts scans 0 1
  section "4. the company and subscription rows (movement booleans only; no field value)"
  local cu su sc sn
  cu="$(q "select (updated_at >= '$T') from companies where id = $S2A_TENANT_COMPANY")" || fail "tenant drift: could not read the company row"
  su="$(q "select (updated_at >= '$T') from subscriptions where company_id = $S2A_TENANT_COMPANY")" || fail "tenant drift: could not read the subscription row"
  sc="$(q "select (status_changed_at >= '$T') from subscriptions where company_id = $S2A_TENANT_COMPANY")" || fail "tenant drift: could not read the subscription row"
  sn="$(q "select count(*) from subscriptions where company_id = $S2A_TENANT_COMPANY")" || fail "tenant drift: could not count the subscription rows"
  [[ "$sn" =~ ^[0-9]+$ ]] || fail "tenant drift: subscription count has an unexpected shape"
  echo "  company_modified_since=$(s2a_bool "$cu") subscription_rows=$sn subscription_modified_since=$(s2a_bool "$su") subscription_status_changed_since=$(s2a_bool "$sc")"
  section "5. audit trail since the last matching guard (fixed action identifiers and counts only; no entity, user or metadata)"
  s2a_counts_line "audit_rows_since" "select 'company='||count(*) filter (where company_id = $S2A_TENANT_COMPANY)||' other_company='||count(*) filter (where company_id is not null and company_id <> $S2A_TENANT_COMPANY)||' no_company='||count(*) filter (where company_id is null) from audit_logs where created_at >= '$T'"
  local acts line
  acts="$(q "select action||' n='||count(*) from audit_logs where company_id = $S2A_TENANT_COMPANY and created_at >= '$T' group by action order by action limit 40")" || fail "tenant drift: could not read the audit actions"
  if [ -z "$acts" ]; then echo "  (no audit row of company $S2A_TENANT_COMPANY since the last matching guard)"; else
    while IFS= read -r line; do
      if [[ "$line" =~ ^[A-Za-z0-9._:-]{1,80}\ n=[0-9]+$ ]]; then echo "  $line"; else echo "  <action with an unexpected shape — not printed> n=?"; fi
    done <<<"$acts"
  fi
  section "6. automatic processes since the last matching guard (recurring sweeps by task and status; subscription lifecycle log counters of company $S2A_TENANT_COMPANY)"
  local sweeps
  # Payloads are encrypted at rest (JOBS_PAYLOAD_ENCRYPTION_KEY); the task name is read from the plaintext cadence dedupe key.
  sweeps="$(q "select t||' '||s||' n='||n from (select coalesce(nullif(split_part(dedupe_key, ':', 2), ''), '?') as t, status as s, count(*) as n from job_queue where name = 'recurring.sweep' and enqueued_at >= '$T' group by 1, 2) x order by 1")" || fail "tenant drift: could not read the recurring sweeps"
  if [ -z "$sweeps" ]; then echo "  (no recurring sweep enqueued since the last matching guard)"; else
    while IFS= read -r line; do
      if [[ "$line" =~ ^[A-Za-z?]{1,40}\ [a-z_]{1,20}\ n=[0-9]+$ ]]; then echo "  $line"; else echo "  <sweep line with an unexpected shape — not printed>"; fi
    done <<<"$sweeps"
  fi
  if [ -z "$API_CID" ]; then echo "  api container not running — log counters unavailable"; else
    local alog
    if ! alog="$(docker logs --since "${T/ /T}Z" "$API_CID" 2>&1)"; then echo "  api log read FAILED (counters unavailable)"; else
      echo "  api_log_trial_expired_by_sweep_company=$(printf '%s\n' "$alog" | grep -F '"Manual trial expired by lifecycle sweep"' | grep -cF "\"companyId\":$S2A_TENANT_COMPANY," || true) api_log_subscription_lifecycle_change_company=$(printf '%s\n' "$alog" | grep -F '"Subscription lifecycle change"' | grep -cF "\"companyId\":$S2A_TENANT_COMPANY," || true) api_log_sweeps_finished=$(printf '%s\n' "$alog" | grep -cF '"Subscription lifecycle sweep finished"' || true)"
    fi
  fi
  section "7. the two guard checks that follow the digest in guards_stage2a_switched (so the review knows whether they would pass)"
  local scans refs
  scans="$(q "select count(*) from scans where company_id = $S2A_TENANT_COMPANY")" || fail "tenant drift: could not count the owner scan rows"
  refs="$(references)" || fail "tenant drift: could not count the legacy references"
  [[ "$scans" =~ ^[0-9]+$ ]] && [[ "$refs" =~ ^[0-9]+$ ]] || fail "tenant drift: guard counts have an unexpected shape"
  echo "  owner_scan_rows=$scans (guard expects 4) legacy_references=$refs (guard expects $REFERENCES)"
  echo "B25_STAGE2A_TENANT_DIGEST=$verdict"
  echo "B25_STAGE2A_TENANT_DRIFT_REPORTED=TRUE"
  log "stage2a-tenant-drift complete (read-only; nothing changed; B25_STAGE2A_TENANT_DIGEST=$verdict)"
}

# =============================================================================================================
# B25 MOBILE R1/R2 DEPLOYMENT — read-only storage regression across the product deployment (library evaluator
# stage2a_deploy_eligibility; constants S2A_DEPLOY_*). Two READ-ONLY phases, no argument, nothing written:
#   stage2a-predeploy-snapshot  (product must still be the previous commit; the live state must equal the locked baseline)
#   stage2a-postdeploy-verify   (product must be the next commit; the same baseline; a fresh api process; no error record)
# =============================================================================================================
stage2a_deploy_residue_facts() {   # disposable smoke residue counters (names never printed)
  echo "smoke_companies=$(q "select count(*) from companies where name like 'B25 SMOKE %'")"
  echo "smoke_storage_rows=$(q "select count(*) from storage_objects o where exists (select 1 from companies c where c.id = o.company_id and c.name like 'B25 SMOKE %')")"
  echo "smoke_users=$(q "select count(*) from users where email like 'b25-smoke-%'")"
}
stage2a_deploy_run() {   # <pre|post>
  local FORM="$1"
  declare -f stage2a_deploy_eligibility >/dev/null || fail "apply library not loaded (stream b25-stage1-apply-lib.sh before this script)"
  case "$FORM" in pre|post) ;; *) fail "deploy verifier: unknown form" ;; esac
  local facts="" rf cid; cid="$(compose ps -q api || true)"
  section "0. read-only guard"; stage2a_readonly_guard
  section "1. host / deployment / containers / readiness (the $FORM form expects product $([ "$FORM" = pre ] && echo "$S2A_DEPLOY_PREV_SHA" || echo "$S2A_DEPLOY_NEXT_SHA"))"
  facts+="$(stage2a_host_facts)"$'\n'; facts+="$(stage2a_container_facts "$cid")"$'\n'; facts+="$(stage2a_readyz_facts)"$'\n'
  printf '%s\n' "$facts" | grep -E '^(head_sha|current_deploy_sha|previous_deploy_sha|dirty|lock_absent|schema_fingerprint|storage_jobs_active|dead_jobs_total|api_running|api_health|web_health|pg_health|readyz_status|readyz_database|readyz_storage|readyz_inside|env_mode|key_line_count|env_core_identity_ok)=' | sed 's/^/  /'
  section "2. storage runtime configuration (startup record, banner, container environment, the api log classification; values never printed)"
  facts+="$(stage2a_init_facts "$cid")"$'\n'; facts+="$(stage2a_container_env_facts)"$'\n'; facts+="$(stage2a_web_leak_facts)"$'\n'
  local mg; mg="$(stage2a_env_managed_of activate < "$ENV_FILE" | sha256sum | cut -c1-64)"
  facts+="env_file_managed_ok=$([ "$mg" = "$(stage2a_env_lines activate | sha256sum | cut -c1-64)" ] && echo true || echo false)"$'\n'
  facts+="env_file_key_lines=$(stage2a_key_lines)"$'\n'
  printf '%s\n' "$facts" | grep -E '^(init_|banner_|env_|log_|leak_|web_leak_)' | sed 's/^/  /'
  section "3. the named volume"
  rf="$(stage2a_root_facts "$cid")"; facts+="$rf"$'\n'; facts+="root_entries_allowed=$(stage2a_root_entries_allowed "$rf")"$'\n'
  printf '%s\n' "$rf" | sed 's/^/  /'
  section "4. Stage 1 exception, protected live inventory, census, originals, smoke residue (Correction 5 model; compared with the locked pre-deploy baseline)"
  facts+="$(stage2a_protected_facts)"$'\n'; facts+="$(stage2a_deploy_residue_facts)"$'\n'
  printf '%s\n' "$facts" | grep -E '^(protected_|tenant_keys_md5|pf_|pm_|exc_|inv_|census_|unmarked_|refs_count|refs_legacy_count|refs_ambiguous|originals_|smoke_)' | sed 's/^/  /'
  section "5. $FORM-deploy prerequisites (read-only decision; nothing is changed)"
  local verdict; if verdict="$(printf '%s' "$facts" | stage2a_deploy_eligibility "$FORM")"; then printf '%s\n' "$verdict"; else printf '%s\n' "$verdict"; fail "deploy verifier ($FORM form) failed — the lines above are the verdict (read-only; nothing changed)"; fi
  rm -f "$HOME"/.b25-s1-node.err
  if [ "$FORM" = pre ]; then printf '%s\n' "$verdict" | grep -qx 'B25_DEPLOY_PREDEPLOY_BASELINE=TRUE'; else printf '%s\n' "$verdict" | grep -qx 'B25_DEPLOY_POSTDEPLOY_STORAGE_READY=TRUE'; fi
}
phase_stage2a_predeploy_snapshot() {   # no argument is read
  if stage2a_deploy_run pre; then log "stage2a-predeploy-snapshot complete (read-only; nothing changed; B25_DEPLOY_PREDEPLOY_BASELINE=TRUE)"
  else fail "stage2a-predeploy-snapshot: the live state does not equal the locked baseline (read-only; nothing changed; B25_DEPLOY_PREDEPLOY_BASELINE=FALSE)"; fi
}
phase_stage2a_postdeploy_verify() {   # no argument is read
  if stage2a_deploy_run post; then log "stage2a-postdeploy-verify complete (read-only; nothing changed; B25_DEPLOY_POSTDEPLOY_STORAGE_READY=TRUE)"
  else fail "stage2a-postdeploy-verify: prerequisites not met (read-only; nothing changed; B25_DEPLOY_POSTDEPLOY_STORAGE_READY=FALSE)"; fi
}

case "$PHASE" in
  preflight) phase_preflight ;;
  schema-apply) phase_schema_apply ;;
  recover) phase_recover ;;
  postdeploy-verify) phase_postdeploy_verify ;;
  smoke-setup) phase_smoke_setup ;;
  smoke-verify) phase_smoke_verify ;;
  recreate-api) phase_recreate_api ;;
  smoke-settle) phase_smoke_settle ;;
  cleanup) phase_cleanup ;;
  diagnose) phase_diagnose ;;
  residue-eligibility) phase_residue_eligibility ;;
  residue-settle) phase_residue_settle ;;
  residue-verify) phase_residue_verify ;;
  residue2-eligibility) phase_residue2_eligibility ;;
  residue2-settle) phase_residue2_settle ;;
  residue2-verify) phase_residue2_verify ;;
  b25phys-inspect) phase_b25phys_inspect ;;
  b25phys-postdelete-verify) phase_b25phys_postdelete_verify ;;
  stage2a-precheck) phase_stage2a_precheck ;;
  stage2a-postswitch-verify) phase_stage2a_postswitch_verify ;;
  stage2a-state) phase_stage2a_state ;;
  stage2a-activate) phase_stage2a_activate ;;
  stage2a-rollback) phase_stage2a_rollback ;;
  stage2a-smoke-setup) phase_stage2a_smoke_setup ;;
  stage2a-smoke-verify) phase_stage2a_smoke_verify ;;
  stage2a-recreate-api) phase_stage2a_recreate_api ;;
  stage2a-smoke-settle) phase_stage2a_smoke_settle ;;
  stage2a-cleanup) phase_stage2a_cleanup ;;
  stage2a-residue-eligibility) phase_stage2a_residue_eligibility ;;
  stage2a-residue-settle) phase_stage2a_residue_settle ;;
  stage2a-residue2-eligibility) phase_stage2a_residue2_eligibility ;;
  stage2a-residue2-settle) phase_stage2a_residue2_settle ;;
  stage2a-residue3-eligibility) phase_stage2a_residue3_eligibility ;;
  stage2a-residue3-settle) phase_stage2a_residue3_settle ;;
  stage2a-tenant-drift) phase_stage2a_tenant_drift ;;
  stage2a-residue4-eligibility) phase_stage2a_residue4_eligibility ;;
  stage2a-residue4-settle) phase_stage2a_residue4_settle ;;
  stage2a-protected-inventory-inspect) phase_stage2a_protected_inventory_inspect ;;
  stage2a-company-change-inspect) phase_stage2a_company_change_inspect ;;
  stage2a-predeploy-snapshot) phase_stage2a_predeploy_snapshot ;;
  stage2a-postdeploy-verify) phase_stage2a_postdeploy_verify ;;
  stage2b-*) stage2b_dispatch "$PHASE" ;;
  *) fail "phase '$PHASE' is not implemented" ;;
esac
exit 0
} </dev/null
