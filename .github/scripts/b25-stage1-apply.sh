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
tenant_md5() { existing_core | md5sum | cut -c1-32; }
# Owner scan rows created during the Gate A device test: existing tenant data, never touched.
scan_rows_md5() { q "select md5(coalesce(string_agg(id||':'||company_id||':'||coalesce(status,'')||':'||coalesce(image_url,'<null>')||':'||created_at::text, ',' order by id),'')) from scans where company_id=1"; }
LEGACY_HANDLE='^/objects/uploads/[0-9a-f-]{36}$'
references() { q "select count(*) from (select object_path r from document_versions where object_path ~ '$LEGACY_HANDLE' union all select object_path from export_runs where object_path ~ '$LEGACY_HANDLE' union all select object_path from executive_reports where object_path ~ '$LEGACY_HANDLE' union all select image_url from scans where image_url ~ '^scans/[0-9]+/[0-9]+\.jpg$' union all select brand_logo_key from companies where brand_logo_key ~ '^branding/[0-9]+/[0-9a-f]{32}\.(png|jpg|webp)$') r"; }
health() { curl -fsS --max-time 5 http://127.0.0.1:18080/healthz >/dev/null && curl -fsS --max-time 5 http://127.0.0.1:18080/api/healthz >/dev/null && curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz | grep -q '"database":"ok","storage":"ok"'; }
wait_healthy() { local waited=0; until health; do waited=$((waited + 5)); [ "$waited" -ge "${1:-150}" ] && return 1; sleep 5; done; return 0; }
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
census_field() { printf '%s' "$1" | grep -oE "\"$2\":\"?[0-9a-z]+\"?" | head -1 | sed -E 's/^"[a-z_]+"://; s/"//g'; }

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
  [ "$(q "select coalesce(to_regclass('public.storage_objects')::text,'absent')")" = "absent" ] || fail "DRIFT: storage_objects already exists"
  q "select 'companies='||(select count(*) from companies)||' users='||(select count(*) from users)||' scans='||(select count(*) from scans)||' export_runs='||(select count(*) from export_runs)||' documents='||(select count(*) from documents)"
  local t; t="$(tenant_md5)"; echo "tenant_baseline_md5=$t"; [ "$t" = "$TENANT_BASELINE_MD5" ] || fail "DRIFT: existing-tenant baseline differs from the accepted activation baseline"
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
  local cj o b; cj="$(census)"; echo "$cj"
  o="$(census_field "$cj" objects)"; b="$(census_field "$cj" bytes)"
  [ "$o" = "$CENSUS_OBJECTS" ] && [ "$b" = "$CENSUS_BYTES" ] || fail "DRIFT: bucket census is not $CENSUS_OBJECTS objects / $CENSUS_BYTES bytes"
  [ "$(census_field "$cj" generationless)" = "0" ] || fail "DRIFT: generation-less object present"
  [ "$(census_field "$cj" with_marker)" = "0" ] || fail "DRIFT: an object already carries the B25 ownership marker"
  INVENTORY_MD5="$(census_field "$cj" inventory_md5)"; echo "gcs_inventory_md5=$INVENTORY_MD5 (sorted name|generation|size digest; names never printed)"
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
  local rj; rj="$(api_node "$RECON_JS" "$refs_b64")"; echo "$rj"
  [ "$(census_field "$rj" present)" = "$REFERENCES" ] && [ "$(census_field "$rj" missing)" = "0" ] && [ "$(census_field "$rj" size_match)" = "$REFERENCES" ] || fail "DRIFT: a referenced legacy object is missing or its size changed"

  section "6. logs / capacity"
  echo "api error-level lines: $(docker logs "$API_CID" 2>&1 | grep -c '"level":50' || true); unhandled: $(docker logs "$API_CID" 2>&1 | grep '"level":50' | grep -vc '"type":"_AppError"' || true); storage/sweep warnings: $(docker logs "$API_CID" 2>&1 | grep -E '"level":(40|50)' | grep -ciE 'storage|sweep' || true)"
  [ "$(docker logs "$API_CID" 2>&1 | grep -E '"level":(40|50)' | grep -ciE 'storage|sweep' || true)" = "0" ] || fail "unexpected storage / sweep warnings in the api log"
  local avail ifree; avail="$(df -B1 --output=avail / | tail -1 | tr -d ' ')"; ifree="$(df -i --output=iavail / | tail -1 | tr -d ' ')"
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
  echo "schema_fingerprint=$(fingerprint) env_sha256_prefix=$(sha256sum "$ENV_FILE" | cut -c1-16) api_container=$API_CID postgres_container=$PG_CID web_container=$WEB_CID pg_volume=card-scanner-pro_pgdata tenant_baseline_md5=$(tenant_md5) gcs_inventory_md5=$INVENTORY_MD5"
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
  [ "$(q "select coalesce(to_regclass('public.storage_objects')::text,'absent')")" = "public.storage_objects" ] || fail "storage_objects not created"
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
  [ "$(tenant_md5)" = "$TENANT_BASELINE_MD5" ] || fail "tenant baseline changed"
  [ "$(q "select count(*) from scans where company_id=1")" = "4" ] || fail "owner scan rows changed"
  local cj; cj="$(census)"; echo "$cj"
  [ "$(census_field "$cj" inventory_md5)" = "$INVENTORY_MD5" ] || fail "GCS inventory changed"
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
  echo "storage init: $(docker logs "$API_CID" 2>&1 | grep -oE '"driver":"[a-z]+","legacyFallback":(true|false),"mirror":(true|false),"legacyDelete":(true|false)' | head -1)"
  docker logs "$API_CID" 2>&1 | grep -q '"driver":"gcs","legacyFallback":false,"mirror":false,"legacyDelete":false' || fail "storage initialization is not driver=gcs / fallback off / mirror off / legacy delete off"
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
  [ "$(tenant_md5)" = "$TENANT_BASELINE_MD5" ] || fail "tenant baseline changed"
  [ "$(q "select count(*) from scans where company_id=1")" = "4" ] || fail "owner scan rows changed"
  [ "$(references)" = "$REFERENCES" ] || fail "legacy references changed"
  [ "$(q "select count(*) from job_queue where status='dead'")" = "0" ] || fail "dead-letter jobs present"
}

phase_postdeploy_verify() {
  guards_deployed
  section "storage_objects after deployment (must be 0 rows before any smoke)"
  local n; n="$(q "select count(*) from storage_objects")"; echo "storage_objects_rows=$n"
  if [ "$n" != "0" ]; then q "select 'row '||id||' company='||company_id||' kind='||kind||' state='||state||' driver='||driver||' created='||created_at from storage_objects order by created_at limit 20"; fail "unexpected storage_objects rows exist — STOP: determine whether a B25-native object was created before any rollback decision"; fi
  local cj; cj="$(census)"; echo "$cj"
  [ "$(census_field "$cj" objects)" = "$CENSUS_OBJECTS" ] && [ "$(census_field "$cj" bytes)" = "$CENSUS_BYTES" ] || fail "bucket census changed"
  [ "$(census_field "$cj" with_marker)" = "0" ] || fail "an object carries a marker before the smoke"
  echo "gcs_inventory_md5=$(census_field "$cj" inventory_md5)"
  [ "$ARG1" = "" ] || { [ "$(census_field "$cj" inventory_md5)" = "$ARG1" ] || fail "GCS inventory digest differs from the preflight baseline"; }
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
  local dj; dj="$(api_node "$PROVIDER_RULES_JS"$'\n'"$DELETE_JS" "$rows_b64")"; echo "$dj"
  echo "$dj" | grep -q '"deleted"' || fail "provider cleanup did not run"
  [ "$(census_field "$dj" refused_no_marker_or_generation)" = "0" ] || fail "an object was refused (marker / generation) — left in place; investigate (no row will be purged)"

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
  local aj; aj="$(api_node "$PROVIDER_RULES_JS"$'\n'"$ABSENT_JS" "$loc_b64")"; echo "$aj"
  echo "$aj" | grep -q '"checked"' || fail "absence verification did not run"
  local present_rows; present_rows="$(q "select count(*) from storage_objects where id in ($UUIDS_Q)")"
  [ "$(census_field "$aj" checked)" = "$present_rows" ] && [ "$(census_field "$aj" absent)" = "$present_rows" ] || fail "a persisted provider location of a recorded tombstone still exists — its row is NOT removed; investigate"
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
  local cj; cj="$(census)"; echo "$cj"
  [ "$(census_field "$cj" objects)" = "$CENSUS_OBJECTS" ] && [ "$(census_field "$cj" bytes)" = "$CENSUS_BYTES" ] || fail "bucket census is not back to $CENSUS_OBJECTS / $CENSUS_BYTES"
  [ "$(census_field "$cj" inventory_md5)" = "$ARG2" ] || fail "the original objects' names/generations/sizes changed"
  [ "$(census_field "$cj" with_marker)" = "0" ] || fail "a marked object remains"
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
  [ "$(tenant_md5)" = "$TENANT_BASELINE_MD5" ] || fail "tenant baseline changed"
  [ "$(q "select count(*) from scans where company_id=1")" = "4" ] || fail "owner scan rows changed"
  echo "owner_scan_rows_md5=$(scan_rows_md5)"
  [ "$(q "select count(*) from storage_objects where publication_uncertain_at is not null or last_error in ('OWNERSHIP_UNPROVEN','CLEANUP_PENDING')")" = "0" ] || fail "uncertain / unproven residue in the inventory"
  echo "storage_objects total=$(q "select count(*) from storage_objects") legacy_retained=$(q "select count(*) from storage_objects where last_error='LEGACY_RETAINED'") (pre-smoke baseline 0 / 0)"
  [ "$(q "select count(*) from storage_objects")" = "0" ] || fail "storage_objects is not back to the pre-smoke baseline"
  local cj; cj="$(census)"; echo "$cj"
  [ "$(census_field "$cj" objects)" = "$CENSUS_OBJECTS" ] && [ "$(census_field "$cj" bytes)" = "$CENSUS_BYTES" ] && [ "$(census_field "$cj" with_marker)" = "0" ] || fail "bucket census / markers not back to the baseline"
  echo "objectdata entries: $(compose exec -T api sh -c 'ls -A /data/objects | wc -l' 2>/dev/null || echo unavailable)"
  [ "$(compose exec -T api sh -c 'ls -A /data/objects | wc -l' 2>/dev/null || echo 1)" = "0" ] || fail "objectdata is not empty"
  rm -f "$HOME"/.b25-s1-node.err
  echo "leftover_files=$(ls "$HOME" | grep -c '^b25-' || true) readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE) schema_fingerprint=$(fingerprint)"
  log "cleanup complete"
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
  *) fail "phase '$PHASE' is not implemented" ;;
esac
exit 0
} </dev/null
