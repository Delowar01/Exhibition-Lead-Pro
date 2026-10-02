#!/bin/bash
# =============================================================================
# TEMPORARY — B25 Phase 2A hosted READ-ONLY inspection of the dev VPS (ONE-OFF
# ops script, not application code). Executed on the VPS as the deploy user by
# .github/workflows/b25-hosted-inspection.yml, then removed by the workflow.
#
# STRICTLY READ-ONLY:
#   • every SQL statement runs in a psql session pinned to
#     default_transaction_read_only=on (PostgreSQL itself refuses writes);
#   • no env VALUE is ever printed (allow-listed non-secret keys only; presence
#     for everything else), no credential, bucket name, object name, key, path
#     of an object, database URL, token or tenant content;
#   • no container is started, stopped, restarted or exec'd with a mutating
#     command; the checkout, env file, volumes, cron, nginx and CloudPanel are
#     never touched; nothing is created on the filesystem;
#   • the only provider operation is a bounded LIST (counts and bytes) through
#     the api container's existing credential — no copy, upload, delete or
#     metadata rewrite.
# Phases: inspect (everything below, to stdout) | schema-dump (pg_dump -s to
# stdout ONLY, logs to stderr; the runner restores it into a throw-away
# PostgreSQL and rehearses drizzle-kit push there — never here).
# =============================================================================
set -euo pipefail
set +x

APP_DIR="${DEPLOY_PATH:-/opt/lead-capture-pro/app}"
STATE_DIR="${STATE_DIR:-/opt/lead-capture-pro/env}"
ENV_FILE="$STATE_DIR/.env"
PHASE="${PHASE:-inspect}"
EXPECTED_HEAD="${EXPECTED_HEAD:-5a072fdc50e3448bd548574698f81076191cd9bc}"

log()  { echo "[b25:$PHASE] $*" >&2; }
fail() { echo "[b25:$PHASE] ERROR: $*" >&2; exit 1; }
section() { echo; echo "== $* =="; }
compose() { docker compose -f docker-compose.yml -f compose.vps.yml "$@"; }
# Read-only SQL: psql session pinned read-only; the role / password are the
# container's own POSTGRES_USER over the local socket — nothing is read or printed.
q() { compose exec -T postgres sh -c 'exec psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tA -F "|" -c "set default_transaction_read_only = on" -c "$1"' sh "$1"; }
# Non-secret env key report: value for allow-listed keys, presence only for the rest.
envkey() {
  local key="$1" allow="${2:-no}" line val
  line="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 || true)"
  if [ -z "$line" ]; then echo "$key: unset"; return; fi
  val="${line#*=}"; val="${val%\"}"; val="${val#\"}"
  if [ "$allow" = "yes" ]; then echo "$key: '${val}'"; elif [ -z "$val" ]; then echo "$key: set-but-empty"; else echo "$key: set"; fi
}
fingerprint() { q "select md5(string_agg(t, '|' order by t)) from (select table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') as t from information_schema.columns where table_schema='public' union all select 'idx:'||indexname||':'||indexdef from pg_indexes where schemaname='public' union all select 'con:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace) s"; }
# Existing-tenant preservation fingerprint (company 1 — the established core projection).
existing_core() {
  q "select 'company1: status='||c.status||' plan='||c.plan||' name_md5='||md5(c.name)||' | sub: status='||s.status||' plan='||s.plan||' source='||s.billing_source||' overrides='||s.limit_overrides::text||' trial_expires='||coalesce(s.trial_expires_at::text,'null')||' status_changed='||s.status_changed_at::text||' stripe='||(s.stripe_customer_id is not null or s.stripe_subscription_id is not null)||' | users='||(select count(*) from users where company_id=1)||' users_active='||(select count(*) from users where company_id=1 and deleted_at is null and is_active)||' roles='||(select count(*) from roles where company_id=1)||' user_roles='||(select count(*) from user_roles ur join users u on u.id=ur.user_id where u.company_id=1)||' perms_md5='||md5(coalesce((select string_agg(u.id||':'||u.role||':'||u.permissions::text, ',' order by u.id) from users u where u.company_id=1),''))||' contacts='||(select count(*) from contacts where company_id=1)||' leads='||(select count(*) from leads where company_id=1)||' events='||(select count(*) from events where company_id=1)||' tasks='||(select count(*) from tasks where company_id=1)||' tags='||(select count(*) from tags where company_id=1)||' lead_tags='||(select count(*) from lead_tags where company_id=1)||' documents='||(select count(*) from documents where company_id=1)||' wf_defs='||(select count(*) from workflow_definitions where company_id=1)||' wf_runs='||(select count(*) from workflow_runs where company_id=1)||' intents='||(select count(*) from billing_checkout_sessions where company_id=1)||' reservations='||(select count(*) from subscription_usage_reservations where company_id=1) from companies c join subscriptions s on s.company_id=c.id where c.id=1"
}

# Run a small read-only node script INSIDE the api container. The script travels
# in an environment variable of the exec'd process (never on disk, never via
# stdin); stderr is reduced to one masked line (no path, url or bucket).
api_node() {
  local js="$1" errf="$HOME/.b25-node.err" out b64
  b64="$(printf '%s' "$js" | base64 -w0)"
  # `timeout` cannot run a shell function, so the compose command is spelled out.
  if out="$(timeout 120 docker compose -f docker-compose.yml -f compose.vps.yml exec -T -e B25_JS_B64="$b64" api sh -c 'exec node -e "$(printf "%s" "$B25_JS_B64" | base64 -d)"' 2>"$errf")"; then
    printf '%s\n' "$out"
  else
    echo "unavailable (reason: $(head -1 "$errf" | sed -E 's#gs://[^[:space:]]*#<gs>#g; s#https?://[^[:space:]]*#<url>#g; s#/[^[:space:]]+#<path>#g' | cut -c1-160))"
  fi
  rm -f "$errf"
}

cd "$APP_DIR/docker"
PG_CID="$(compose ps -q postgres)"; [ -n "$PG_CID" ] || fail "postgres container not found"
API_CID="$(compose ps -q api || true)"; [ -n "$API_CID" ] || fail "api container not found"
WEB_CID="$(compose ps -q web || true)"; [ -n "$WEB_CID" ] || fail "web container not found"

# Reference-shape rules, mirrored from src/storage/legacy.ts (B25 accepted code):
#   native handle   ^/objects/<uuid>$                    (B25 inventory-backed; none expected before B25)
#   legacy handle   ^/objects/uploads/<36 chars>$        (documents / exports / reports)
#   legacy scan     ^scans/<company id>/<digits>.jpg$    (tenant id must equal the row's company)
#   legacy logo     ^branding/<company id>/<32 hex>.(png|jpg|webp)$ (tenant id must equal the row's company)
NATIVE='^/objects/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
LEGACY_HANDLE='^/objects/uploads/[0-9a-f-]{36}$'

phase_inspect() {
  section "read-only guard"
  if q "create temp table b25_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard did not hold"; else echo "session refuses writes (default_transaction_read_only=on): OK"; fi

  section "4. hosted checkout / deploy state (expected HEAD = current-deploy.sha = $EXPECTED_HEAD)"
  local head cur prev dirty wts
  head="$(git -C "$APP_DIR" rev-parse HEAD)"; cur="$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null || echo none)"; prev="$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null || echo none)"
  dirty="$(git -C "$APP_DIR" status --porcelain | wc -l)"; wts="$(git -C "$APP_DIR" worktree list | wc -l)"
  echo "HEAD=$head HEAD_committed=$(git -C "$APP_DIR" log -1 --format=%cI) subject=$(git -C "$APP_DIR" log -1 --format=%s | cut -c1-90)"
  echo "branch=$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD) current-deploy.sha=$cur previous-deploy.sha=$prev dirty_entries=$dirty worktrees=$wts"
  echo "deploy-script requires a readable GCS credential: $(grep -q 'test -r "\$GOOGLE_APPLICATION_CREDENTIALS"' "$APP_DIR/docker/scripts/deploy-vps.sh" && echo yes || echo no)"
  [ "$head" = "$EXPECTED_HEAD" ] && [ "$cur" = "$EXPECTED_HEAD" ] || fail "DRIFT: hosted checkout / current-deploy.sha is not $EXPECTED_HEAD"
  [ "$dirty" = "0" ] || fail "DRIFT: hosted checkout is dirty"

  section "4. containers (postgres / api / web)"
  for svc in postgres api web; do
    cid="$(compose ps -q "$svc")"
    docker inspect -f "$svc: id={{.Id}} image={{.Config.Image}} created={{.Created}} started={{.State.StartedAt}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}} restarts={{.RestartCount}}" "$cid"
  done
  echo "postgres mounts: $(docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Name}}->{{.Destination}} {{end}}' "$PG_CID")"
  for v in $(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$PG_CID"); do docker volume inspect -f "volume $v: created={{.CreatedAt}} driver={{.Driver}} scope={{.Scope}}" "$v"; done
  echo "api mounts: $(docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Destination}}:{{if .RW}}rw{{else}}ro{{end}} {{end}}' "$API_CID")"
  echo "api supplemental groups (count only): $(docker inspect -f '{{json .HostConfig.GroupAdd}}' "$API_CID" | tr -cd ',' | wc -c | awk '{print $1+1}')"
  echo "api configured user: $(docker inspect -f '{{.Config.User}}' "$API_CID")"
  echo "api runtime identity: $(compose exec -T api id 2>/dev/null || echo unavailable)"
  echo "docker volumes named objectdata/pgdata: $(docker volume ls --format '{{.Name}}' | grep -E 'objectdata|pgdata' | tr '\n' ' ')"
  echo "healthz(web)=$(curl -fsS --max-time 5 http://127.0.0.1:18080/healthz | tr -d '\n' || echo UNAVAILABLE)"
  echo "api healthz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/healthz || echo UNAVAILABLE)"
  echo "api readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE)"

  section "4. database"
  q "select 'server='||version()"
  q "select 'database_size='||pg_size_pretty(pg_database_size(current_database()))||' ('||pg_database_size(current_database())||' bytes)'"
  q "select 'tables='||(select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')||' indexes='||(select count(*) from pg_indexes where schemaname='public')||' constraints='||(select count(*) from pg_constraint where connamespace='public'::regnamespace)"
  echo "schema_fingerprint=$(fingerprint)"
  q "select 'companies='||(select count(*) from companies)||' users='||(select count(*) from users)||' users_active='||(select count(*) from users where deleted_at is null and is_active)||' subscriptions='||(select count(*) from subscriptions)||' documents='||(select count(*) from documents)||' document_versions='||(select count(*) from document_versions)||' scans='||(select count(*) from scans)||' export_runs='||(select count(*) from export_runs)||' executive_reports='||(select count(*) from executive_reports)"
  echo "storage_objects_table=$(q "select coalesce(to_regclass('public.storage_objects')::text,'absent')")"
  if [ "$(q "select coalesce(to_regclass('public.storage_objects')::text,'absent')")" != "absent" ]; then
    echo "UNEXPECTED: storage_objects already exists on the hosted database"
    q "select 'storage_objects rows='||count(*)||' by_state: '||coalesce(string_agg(state||'='||n, ' '),'empty') from (select state, count(*) n from storage_objects group by state) s" || true
  fi

  section "4. env file (mode / owner / size / sha256 prefix — values never printed)"
  echo "$(stat -c 'mode=%a owner=%U:%G size=%s mtime=%y' "$ENV_FILE")"
  echo "sha256_prefix=$(sha256sum "$ENV_FILE" | cut -c1-16)"
  for k in COMPOSE_PROFILES NODE_ENV JOBS_DRIVER TRUST_PROXY OBJECT_STORAGE_AUTH OBJECT_STORAGE_DRIVER OBJECT_STORAGE_FS_ROOT OBJECT_STORAGE_LEGACY_FALLBACK OBJECT_STORAGE_MIRROR OBJECT_STORAGE_LEGACY_DELETE OBJECT_STORAGE_TEST_EPHEMERAL_KEY; do envkey "$k" yes; done
  for k in DATABASE_URL SESSION_SECRET JOBS_PAYLOAD_ENCRYPTION_KEY OBJECT_STORAGE_ENCRYPTION_KEY GOOGLE_APPLICATION_CREDENTIALS DEFAULT_OBJECT_STORAGE_BUCKET_ID PRIVATE_OBJECT_DIR PUBLIC_OBJECT_SEARCH_PATHS GCS_CREDENTIAL_GID GEMINI_API_KEY SMTP_HOST STRIPE_SECRET_KEY; do envkey "$k"; done
  echo "api container env (presence only): $(compose exec -T api sh -c 'for k in OBJECT_STORAGE_DRIVER OBJECT_STORAGE_FS_ROOT OBJECT_STORAGE_ENCRYPTION_KEY OBJECT_STORAGE_LEGACY_FALLBACK OBJECT_STORAGE_MIRROR OBJECT_STORAGE_LEGACY_DELETE GOOGLE_APPLICATION_CREDENTIALS DEFAULT_OBJECT_STORAGE_BUCKET_ID PRIVATE_OBJECT_DIR JOBS_DRIVER; do eval v=\"\${$k:-}\"; if [ -n "$v" ]; then printf "%s=set " "$k"; else printf "%s=unset " "$k"; fi; done' 2>/dev/null || echo unavailable)"

  section "4. durable queue / api log health"
  { docker logs "$API_CID" 2>&1 | grep -E '"msg":"Durable job queue (selected|started)"' | grep -oE '"driver":"[a-z]+"|"msg":"[^"]+"' | tr '\n' ' '; } || true; echo
  q "select 'job_queue: '||coalesce(string_agg(status||'='||n, ' '), 'empty') from (select status, count(*) n from job_queue group by status order by status) s"
  q "select 'job_queue dead_last_24h='||(select count(*) from job_queue where status='dead' and dead_at > now() - interval '24 hours')||' dead_last_7d='||(select count(*) from job_queue where status='dead' and dead_at > now() - interval '7 days')"
  q "select 'recurring sweeps (last 6h): '||coalesce(string_agg(k||'='||n||'/'||st, ' ' order by k, st), 'none') from (select split_part(coalesce(dedupe_key,''), ':', 2) k, status st, count(*) n from job_queue where name='recurring.sweep' and enqueued_at > now() - interval '6 hours' group by 1,2) s"
  echo "api error-level lines since container start: $(docker logs "$API_CID" 2>&1 | grep -c '"level":50' || true); non-AppError: $(docker logs "$API_CID" 2>&1 | grep '"level":50' | grep -vc '"type":"_AppError"' || true)"
  { docker logs "$API_CID" 2>&1 | grep '"level":50' | grep -v '"type":"_AppError"' | grep -viE 'authorization|token|secret|password|gs://|https?://' | grep -oE '"msg":"[^"]+"|"type":"[^"]+"|"statusCode":[0-9]+' | sort | uniq -c | sort -rn | head -8; } || true
  echo "web nginx error/crit lines since start: $(docker logs "$WEB_CID" 2>&1 | grep -ciE '\[(error|crit|emerg|alert)\]' || true); web 5xx access lines: $(docker logs "$WEB_CID" 2>&1 | grep -cE '" 5[0-9]{2} ' || true)"

  section "4. existing-tenant preservation fingerprint (company 1 core projection; md5 only)"
  local b; b="$(existing_core)"; echo "$b"; echo "baseline_md5=$(printf '%s' "$b" | md5sum | cut -c1-32)"

  section "6. legacy reference inventory (counts only; shapes mirrored from legacy.ts; no key, path or URL)"
  q "select 'document_versions: rows='||count(*)||' with_ref='||count(object_path)||' empty_ref='||count(*) filter (where object_path='')||' legacy_handle='||count(*) filter (where object_path ~ '$LEGACY_HANDLE')||' native_handle='||count(*) filter (where object_path ~ '$NATIVE')||' other_shape='||count(*) filter (where object_path is not null and object_path<>'' and object_path !~ '$LEGACY_HANDLE' and object_path !~ '$NATIVE')||' distinct_refs='||count(distinct object_path)||' known_bytes='||coalesce(sum(file_size) filter (where object_path is not null and object_path<>''),0)||' company_missing='||count(*) filter (where object_path is not null and object_path<>'' and not exists (select 1 from companies c where c.id=document_versions.company_id)) from document_versions"
  q "select 'scans: rows='||count(*)||' with_ref='||count(image_url)||' empty_ref='||count(*) filter (where image_url='')||' legacy_scan_own_tenant='||count(*) filter (where image_url ~ ('^scans/'||company_id||'/[0-9]+\.jpg$'))||' legacy_scan_other_tenant='||count(*) filter (where image_url ~ '^scans/[0-9]+/[0-9]+\.jpg$' and image_url !~ ('^scans/'||company_id||'/[0-9]+\.jpg$'))||' native_handle='||count(*) filter (where image_url ~ '$NATIVE')||' other_shape='||count(*) filter (where image_url is not null and image_url<>'' and image_url !~ '^scans/[0-9]+/[0-9]+\.jpg$' and image_url !~ '$NATIVE')||' distinct_refs='||count(distinct image_url)||' company_missing='||count(*) filter (where image_url is not null and image_url<>'' and not exists (select 1 from companies c where c.id=scans.company_id)) from scans"
  q "select 'export_runs: rows='||count(*)||' with_ref='||count(object_path)||' empty_ref='||count(*) filter (where object_path='')||' legacy_handle='||count(*) filter (where object_path ~ '$LEGACY_HANDLE')||' native_handle='||count(*) filter (where object_path ~ '$NATIVE')||' other_shape='||count(*) filter (where object_path is not null and object_path<>'' and object_path !~ '$LEGACY_HANDLE' and object_path !~ '$NATIVE')||' distinct_refs='||count(distinct object_path)||' known_bytes='||coalesce(sum(file_size) filter (where object_path is not null and object_path<>''),0)||' status: '||coalesce((select string_agg(status||'='||n, ' ') from (select status, count(*) n from export_runs group by status) s),'none')||' company_missing='||count(*) filter (where object_path is not null and object_path<>'' and not exists (select 1 from companies c where c.id=export_runs.company_id)) from export_runs"
  q "select 'executive_reports: rows='||count(*)||' with_ref='||count(object_path)||' empty_ref='||count(*) filter (where object_path='')||' legacy_handle='||count(*) filter (where object_path ~ '$LEGACY_HANDLE')||' native_handle='||count(*) filter (where object_path ~ '$NATIVE')||' other_shape='||count(*) filter (where object_path is not null and object_path<>'' and object_path !~ '$LEGACY_HANDLE' and object_path !~ '$NATIVE')||' distinct_refs='||count(distinct object_path)||' company_missing='||count(*) filter (where object_path is not null and object_path<>'' and not exists (select 1 from companies c where c.id=executive_reports.company_id)) from executive_reports"
  q "select 'companies: rows='||count(*)||' brand_logo_key_set='||count(brand_logo_key)||' legacy_logo_own_tenant='||count(*) filter (where brand_logo_key ~ ('^branding/'||id||'/[0-9a-f]{32}\.(png|jpg|webp)$'))||' logo_other_shape='||count(*) filter (where brand_logo_key is not null and brand_logo_key !~ ('^branding/'||id||'/[0-9a-f]{32}\.(png|jpg|webp)$'))||' legacy_logo_url_set='||count(logo_url)||' logo_url_http='||count(*) filter (where logo_url ~ '^https?://')||' logo_url_other='||count(*) filter (where logo_url is not null and logo_url !~ '^https?://') from companies"
  q "select 'totals: source_references='||count(*)||' unique_references='||count(distinct reference)||' unique_company_reference='||count(distinct (company_id, reference))||' companies_referencing='||count(distinct company_id)||' tenant_missing='||count(*) filter (where not exists (select 1 from companies c where c.id=r.company_id)) from (select company_id, 'document' kind, object_path reference from document_versions where object_path is not null and object_path<>'' union all select company_id, 'export', object_path from export_runs where object_path is not null and object_path<>'' union all select company_id, 'report', object_path from executive_reports where object_path is not null and object_path<>'' union all select company_id, 'scan_image', image_url from scans where image_url is not null and image_url<>'' union all select id, 'branding_logo', brand_logo_key from companies where brand_logo_key is not null) r"
  q "select 'duplicate_groups(company+reference, >1 feature rows)='||count(*)||' cross_feature_collisions(>1 kinds)='||count(*) filter (where kinds>1)||' cross_company_shared_references='||(select count(*) from (select reference from (select distinct company_id, object_path reference from document_versions where object_path is not null and object_path<>'' union select distinct company_id, object_path from export_runs where object_path is not null and object_path<>'' union select distinct company_id, object_path from executive_reports where object_path is not null and object_path<>'') x group by reference having count(*)>1) y) from (select company_id, reference, count(*) n, count(distinct kind) kinds from (select company_id, 'document' kind, object_path reference from document_versions where object_path is not null and object_path<>'' union all select company_id, 'export', object_path from export_runs where object_path is not null and object_path<>'' union all select company_id, 'report', object_path from executive_reports where object_path is not null and object_path<>'' union all select company_id, 'scan_image', image_url from scans where image_url is not null and image_url<>'' union all select id, 'branding_logo', brand_logo_key from companies where brand_logo_key is not null) r group by company_id, reference having count(*)>1) g"
  echo "duplicate groups (company id | reference md5 prefix | kinds | rows per kind) — first 25:"
  q "select 'company '||company_id||' | '||left(md5(reference),16)||' | '||string_agg(kind||'='||n, ',' order by kind) from (select company_id, reference, kind, count(*) n from (select company_id, 'document' kind, object_path reference from document_versions where object_path is not null and object_path<>'' union all select company_id, 'export', object_path from export_runs where object_path is not null and object_path<>'' union all select company_id, 'report', object_path from executive_reports where object_path is not null and object_path<>'' union all select company_id, 'scan_image', image_url from scans where image_url is not null and image_url<>'' union all select id, 'branding_logo', brand_logo_key from companies where brand_logo_key is not null) r group by company_id, reference, kind) k where (company_id, reference) in (select company_id, reference from (select company_id, 'document' kind, object_path reference from document_versions where object_path is not null and object_path<>'' union all select company_id, 'export', object_path from export_runs where object_path is not null and object_path<>'' union all select company_id, 'report', object_path from executive_reports where object_path is not null and object_path<>'' union all select company_id, 'scan_image', image_url from scans where image_url is not null and image_url<>'' union all select id, 'branding_logo', brand_logo_key from companies where brand_logo_key is not null) d group by company_id, reference having count(*)>1) group by company_id, reference order by company_id limit 25" || echo "(none)"
  echo "company-deletion blockers = other_shape / other-tenant references above (unattributable without an inventory row); native handles would also block until storage_objects exists"
  q "select 'per-company legacy references (company id = count): '||coalesce(string_agg(company_id||'='||n, ' ' order by company_id),'none') from (select company_id, count(*) n from (select company_id from document_versions where object_path is not null and object_path<>'' union all select company_id from export_runs where object_path is not null and object_path<>'' union all select company_id from executive_reports where object_path is not null and object_path<>'' union all select company_id from scans where image_url is not null and image_url<>'' union all select id from companies where brand_logo_key is not null) r group by company_id) s"

  section "7. current Google Cloud boundary (nothing mutated; nothing about the credential printed)"
  compose exec -T api sh -c 'p="${GOOGLE_APPLICATION_CREDENTIALS:-}"; if [ -z "$p" ]; then echo "GOOGLE_APPLICATION_CREDENTIALS: unset in the api container"; elif [ -r "$p" ]; then echo "credential file readable by the api process: yes (uid $(id -u), supplementary groups $(id -G | wc -w))"; else echo "credential file readable by the api process: NO"; fi; echo "bucket configured: $( [ -n "${DEFAULT_OBJECT_STORAGE_BUCKET_ID:-}" ] && echo yes || echo no ); private dir configured: $( [ -n "${PRIVATE_OBJECT_DIR:-}" ] && echo yes || echo no ); OBJECT_STORAGE_AUTH=${OBJECT_STORAGE_AUTH:-unset}"' 2>/dev/null || echo "api exec unavailable"
  local gcsf=/opt/lead-capture-pro/env/gcs-service-account.json; if [ -f "$gcsf" ]; then echo "host credential file: present, $(stat -c 'mode=%a owner=%U:%G size=%s' "$gcsf")"; else echo "host credential file: absent at the documented path"; fi
  echo "compose credential mount declared: $(grep -c 'gcs-service-account.json' "$APP_DIR/docker/compose.vps.yml") line(s); group_add declared: $(grep -c 'GCS_CREDENTIAL_GID' "$APP_DIR/docker/compose.vps.yml") line(s)"
  echo "readyz storage check: $(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz | grep -oE '"storage":"[a-z_]+"' || echo UNAVAILABLE)"
  echo "bucket object census (read-only LIST through the api container's credential; counts and bytes only; capped at 20000 objects):"
  CENSUS_JS=$(cat <<'JS'
const { Storage } = require("@google-cloud/storage");
(async () => {
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  const priv = (process.env.PRIVATE_OBJECT_DIR || "").replace(/^\/+/, "").split("/").slice(1).join("/");
  if (!bucket) { console.log(JSON.stringify({ census: "no bucket configured" })); return; }
  const storage = new Storage();
  const CAP = 20000;
  const classes = { private_uploads: priv ? `${priv}/uploads/` : null, scans: "scans/", branding: "branding/" };
  const out = {};
  for (const [name, prefix] of Object.entries(classes)) {
    if (!prefix) { out[name] = { skipped: "no private dir" }; continue; }
    let n = 0, bytes = 0, pageToken, capped = false;
    do {
      const [files, next] = await storage.bucket(bucket).getFiles({ prefix, maxResults: 1000, autoPaginate: false, pageToken });
      for (const f of files) { n += 1; bytes += Number(f.metadata.size || 0); }
      pageToken = next && next.pageToken;
      if (n >= CAP) { capped = true; break; }
    } while (pageToken);
    out[name] = { objects: n, bytes, capped };
  }
  let total = 0, totalBytes = 0, pageToken, capped = false;
  do {
    const [files, next] = await storage.bucket(bucket).getFiles({ maxResults: 1000, autoPaginate: false, pageToken });
    for (const f of files) { total += 1; totalBytes += Number(f.metadata.size || 0); }
    pageToken = next && next.pageToken;
    if (total >= CAP) { capped = true; break; }
  } while (pageToken);
  out.bucket_total = { objects: total, bytes: totalBytes, capped };
  console.log(JSON.stringify(out));
})().catch((e) => console.log(JSON.stringify({ census: "error", code: e.code || e.name || "unknown" })));
JS
)
  api_node "$CENSUS_JS"

  section "8. Hostinger filesystem readiness (read-only; nothing created)"
  echo "disk (df -h): "; df -h / /opt /var/lib/docker 2>/dev/null | sed 's/^/  /'
  echo "inodes (df -i): "; df -i / /opt /var/lib/docker 2>/dev/null | sed 's/^/  /'
  echo "docker disk usage:"; docker system df 2>/dev/null | sed 's/^/  /' || echo "  unavailable"
  echo "docker root dir: $(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo unknown)"
  echo "devices: app checkout=$(findmnt -no SOURCE,FSTYPE -T "$APP_DIR" 2>/dev/null | tr '\n' ' ') | /opt/lead-capture-pro=$(findmnt -no SOURCE,FSTYPE -T /opt/lead-capture-pro 2>/dev/null | tr '\n' ' ') | docker root=$(findmnt -no SOURCE,FSTYPE -T "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)" 2>/dev/null | tr '\n' ' ')"
  for v in $(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$PG_CID"); do mp="$(docker volume inspect -f '{{.Mountpoint}}' "$v")"; echo "postgres volume $v device: $(findmnt -no SOURCE,FSTYPE -T "$mp" 2>/dev/null | tr '\n' ' ')"; done
  echo "candidate host path /opt/lead-capture-pro/data/objects (outside Git checkout, /var/www, /etc, /proc, /sys, /dev by construction):"
  for p in /opt /opt/lead-capture-pro /opt/lead-capture-pro/data /opt/lead-capture-pro/data/objects; do
    if [ -L "$p" ]; then echo "  $p: SYMLINK (conflict)"; elif [ -e "$p" ]; then echo "  $p: exists $(stat -c 'type=%F mode=%a owner=%U:%G' "$p")"; else echo "  $p: absent"; fi
  done
  echo "  /data on host: $( [ -e /data ] && echo "exists ($(stat -c 'type=%F mode=%a owner=%U:%G' /data))" || echo absent )"
  echo "  api container /data/objects mount: $(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data/objects"}}{{.Type}}:{{.Name}}{{.Source}}{{end}}{{end}}' "$API_CID" | sed 's#/var/lib/docker/volumes/#volume:#' ); empty means not mounted (expected before B25)"
  echo "  api image /data/objects: $(compose exec -T api sh -c 'if [ -d /data/objects ]; then stat -c "present mode=%a owner=%u:%g" /data/objects; else echo absent; fi' 2>/dev/null || echo unavailable)"
  echo "Hostinger snapshots: not determinable from inside the VPS (owner confirms in hPanel)"

  section "9. request-size layers visible from the VPS (directive values only)"
  echo "stack nginx (web container): $(compose exec -T web sh -c 'grep -h client_max_body_size /etc/nginx/conf.d/*.conf /etc/nginx/nginx.conf 2>/dev/null | tr -s " " | sort | uniq -c | tr "\n" ";"' 2>/dev/null || echo unavailable)"
  if [ -r /etc/nginx/nginx.conf ]; then echo "host nginx.conf client_max_body_size: $(grep -h client_max_body_size /etc/nginx/nginx.conf 2>/dev/null | tr -s ' ' | tr '\n' ';' || echo none)"; else echo "host /etc/nginx/nginx.conf: not readable by the deploy user"; fi
  if ls /etc/nginx/sites-enabled/ >/dev/null 2>&1; then echo "host vhosts client_max_body_size (values only): $(grep -hs client_max_body_size /etc/nginx/sites-enabled/* 2>/dev/null | tr -s ' ' | sort | uniq -c | tr '\n' ';' || echo none)"; else echo "host /etc/nginx/sites-enabled: not readable by the deploy user"; fi
  echo "stack-only probe (api container -> web nginx -> api; Expect: 100-continue, no body sent; 100 = headers accepted by nginx, 413 = refused):"
  PROBE_JS=$(cat <<'JS'
const http = require("node:http");
const base = "http://web";
const sizes = [[1, 1 << 20], [25, 25 << 20], [30, 30 << 20], [30.0001, (30 << 20) + 1], [31, 31 << 20], [100, 100 << 20], [1024, 1024 << 20]];
const path = "/api/files/uploads/00000000-0000-4000-8000-000000000000";
function probe(bytes) {
  return new Promise((resolve) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port || 80, path, method: "PUT", headers: { "Content-Type": "application/octet-stream", "Content-Length": bytes, Expect: "100-continue", "User-Agent": "b25-edge-probe" }, timeout: 15000 }, (res) => { resolve(String(res.statusCode)); res.resume(); req.destroy(); });
    req.on("continue", () => { resolve("100"); req.destroy(); });
    req.on("timeout", () => { resolve("timeout"); req.destroy(); });
    req.on("error", (e) => resolve("error:" + (e.code || "x")));
  });
}
(async () => { for (const [label, bytes] of sizes) console.log(`  ${label} MiB -> ${await probe(bytes)}`); })();
JS
)
  api_node "$PROBE_JS"

  section "11. encryption-key owner gate (presence by variable name only)"
  envkey OBJECT_STORAGE_ENCRYPTION_KEY
  echo "api container OBJECT_STORAGE_ENCRYPTION_KEY: $(compose exec -T api sh -c '[ -n "${OBJECT_STORAGE_ENCRYPTION_KEY:-}" ] && echo set || echo unset' 2>/dev/null || echo unavailable)"

  section "12. backup position (inspection only; scripts not run, not edited)"
  echo "crontab entries (deploy user; script names only): $(crontab -l 2>/dev/null | grep -cE 'backup-postgres\.sh|backup-check\.sh' || echo 0)"
  echo "backup scripts in checkout: $(ls "$APP_DIR/docker/scripts/" | grep -E 'backup' | tr '\n' ' ')"
  echo "backup-postgres.sh backs up: $(grep -c 'pg_dump' "$APP_DIR/docker/scripts/backup-postgres.sh" || true) pg_dump call(s); mentions object volume / objectdata: $(grep -ciE 'objectdata|/data/objects' "$APP_DIR/docker/scripts/backup-postgres.sh" || true)"
  echo "backup files present: $(ls -1 /opt/lead-capture-pro/backups/postgres/*.sql.gz 2>/dev/null | wc -l) newest_age_hours=$(f=$(ls -1t /opt/lead-capture-pro/backups/postgres/*.sql.gz 2>/dev/null | head -1); if [ -n "$f" ]; then echo $(( ( $(date +%s) - $(stat -c %Y "$f") ) / 3600 )); else echo n/a; fi)"

  echo "now_utc=$(date -u +%FT%TZ)"
  log "inspect complete (read-only)"
}

phase_schema_dump() {
  log "schema-only dump to stdout (pg_dump --schema-only --no-owner --no-privileges; no data rows)"
  compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" --schema-only --no-owner --no-privileges "$POSTGRES_DB"'
  log "schema dump complete (read-only)"
}

case "$PHASE" in
  inspect) phase_inspect ;;
  schema-dump) phase_schema_dump ;;
  *) fail "phase '$PHASE' is not implemented" ;;
esac
