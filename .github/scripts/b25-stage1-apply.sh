#!/bin/bash
# =============================================================================
# TEMPORARY — B25 Stage 1 hosted activation tooling (ONE-OFF ops script, not
# application code). Streamed over SSH stdin by
# .github/workflows/b25-stage1-apply.yml (`bash -s`); never written to the VPS
# filesystem. The whole script is one brace group whose stdin is /dev/null, so
# bash reads it completely before the first command runs.
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
#                     audit metadata, census)
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
ACCEPTED_SHA="eb2edb0ad84d859b66efbc24ea9b895f76c2ed02"
EXPECTED_HOSTED_SHA="5a072fdc50e3448bd548574698f81076191cd9bc"
EXPECTED_PREVIOUS_SHA="6dd8d7e728b83424039cd56749b573988c2da2ea"
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

# ARG1 = csv of disposable company ids, ARG2 = csv of disposable user ids, ARG3 = capability prefix (16 chars) for leak checks
phase_smoke_verify() {
  [[ "$ARG1" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "ARG1 must be a csv of company ids"
  [[ "$ARG2" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "ARG2 must be a csv of user ids"
  [[ "$ARG3" =~ ^[A-Za-z0-9_-]{16}$ ]] || fail "ARG3 must be the 16-character capability prefix"
  local C="$ARG1" U="$ARG2" P="$ARG3"
  section "disposable targets (names verified)"
  [ "$(q "select count(*) from companies where id in ($C) and name not like 'B25 SMOKE %'")" = "0" ] || fail "a target company is not a smoke tenant"
  [ "$(q "select count(*) from users where id in ($U) and email not like '%@$SMOKE_DOMAIN'")" = "0" ] || fail "a target user is not a smoke user"
  section "inventory rows of the smoke tenants"
  q "select 'row '||id||' company='||company_id||' kind='||kind||' state='||state||' driver='||driver||' legacy_key_set='||(legacy_key is not null)||' mirror_key_set='||(mirror_key is not null)||' lease_cleared='||(lease_token is null)||' size='||coalesce(size_bytes::text,'null')||' sha_set='||(sha256 is not null)||' last_error='||coalesce(last_error,'<null>')||' uncertain='||(publication_uncertain_at is not null) from storage_objects where company_id in ($C) order by created_at"
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
  section "no capability / secret leak (prefix search only)"
  echo "api log lines with the capability prefix: $(docker logs "$API_CID" 2>&1 | grep -c -- "$P" || true)"
  [ "$(docker logs "$API_CID" 2>&1 | grep -c -- "$P" || true)" = "0" ] || fail "capability prefix found in the api log"
  echo "web log lines with the capability prefix: $(docker logs "$WEB_CID" 2>&1 | grep -c -- "$P" || true)"
  [ "$(docker logs "$WEB_CID" 2>&1 | grep -c -- "$P" || true)" = "0" ] || fail "capability prefix found in the web log"
  [ "$(q "select count(*) from audit_logs where metadata::text like '%$P%'")" = "0" ] || fail "capability prefix found in audit metadata"
  [ "$(q "select count(*) from storage_objects where coalesce(last_error,'') like '%$P%'")" = "0" ] || fail "capability prefix found in storage last_error"
  [ "$(q "select count(*) from audit_logs where metadata::text ~ 'gs://|/var/lib/docker|/data/objects|X-Goog-Signature'")" = "0" ] || fail "bucket / path / signature text found in audit metadata"
  echo "api error-level lines: $(docker logs "$API_CID" 2>&1 | grep -c '"level":50' || true); unhandled: $(docker logs "$API_CID" 2>&1 | grep '"level":50' | grep -vc '"type":"_AppError"' || true)"
  [ "$(docker logs "$API_CID" 2>&1 | grep '"level":50' | grep -vc '"type":"_AppError"' || true)" = "0" ] || fail "unhandled error in the api log"
  section "census during the smoke"
  local cj; cj="$(census)"; echo "$cj"
  echo "storage driver: $(docker logs "$API_CID" 2>&1 | grep -oE '"driver":"[a-z]+","legacyFallback"' | tail -1)"
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
  q "select 'tombstone '||id||' kind='||kind||' state='||state||' last_error='||coalesce(last_error,'<null>')||' legacy_key_set='||(legacy_key is not null)||' mirror_key_set='||(mirror_key is not null)||' uncertain='||(publication_uncertain_at is not null)||' reconciled='||(reconciled_at is not null) from storage_objects where company_id in ($C) order by created_at"
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
  q "select 'row '||id||' company='||company_id||' kind='||kind||' state='||state||' last_error='||coalesce(last_error,'<null>')||' uncertain='||(publication_uncertain_at is not null) from storage_objects where company_id in ($C) order by created_at" || true
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
  awk -v dre="$EDGE_DOMAIN_RE" -v prefix="$1" '
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
  q "select 'row '||id||' company='||company_id||' kind='||kind||' state='||state||' driver='||driver||' legacy_key_set='||(legacy_key is not null)||' mirror_key_set='||(mirror_key is not null)||' lease_set='||(lease_token is not null)||' size='||coalesce(size_bytes::text,'null')||' sha_set='||(sha256 is not null)||' last_error='||coalesce(last_error,'<null>')||' uncertain='||(publication_uncertain_at is not null)||' deleted_at='||coalesce(deleted_at::text,'<null>')||' reconciled_at='||coalesce(reconciled_at::text,'<null>')||' created='||created_at||' updated='||updated_at from storage_objects where id = '$UUID' or company_id in ($C) order by created_at" 2>/dev/null | sed 's/^/  /' || echo "  unavailable"
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
    conf_path="$("$nginx_bin" -V 2>&1 | grep -oE -- '--conf-path=[^ ]+' | cut -d= -f2 || true)"; prefix="$("$nginx_bin" -V 2>&1 | grep -oE -- '--prefix=[^ ]+' | cut -d= -f2 || true)"
    conf_path="${conf_path:-/etc/nginx/nginx.conf}"; prefix="${prefix:-/etc/nginx}"
    echo "   conf-path: $(printf '%s' "$conf_path" | edge_san) prefix: $(printf '%s' "$prefix" | edge_san) master-process config: $(ps -eo comm=,args= 2>/dev/null | awk '$1 == "nginx" && $2 == "nginx:" && $3 == "master" { $1 = ""; $2 = ""; $3 = ""; $4 = ""; print; exit }' | edge_san || true)"
    if dump="$("$nginx_bin" -T 2>/dev/null)" && [ -n "$dump" ]; then dump_src="nginx -T (this user)"
    elif [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1 && dump="$(sudo -n "$nginx_bin" -T 2>/dev/null)" && [ -n "$dump" ]; then dump_src="sudo -n nginx -T"
    else dump=""; fi
    if [ -n "$dump" ]; then echo "-- effective configuration: $dump_src ($(printf '%s\n' "$dump" | grep -c '^# configuration file ' || true) files; test: $("$nginx_bin" -t 2>&1 | grep -oE 'syntax is ok|test is successful|test failed' | sort -u | tr '\n' ' ' || echo n/a))"
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
  *) fail "phase '$PHASE' is not implemented" ;;
esac
exit 0
} </dev/null
