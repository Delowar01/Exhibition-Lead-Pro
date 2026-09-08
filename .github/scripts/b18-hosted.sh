#!/bin/bash
# =============================================================================
# Batch 18 — hosted activation on the dev VPS (ONE-OFF operations script, not
# application code). Executed on the VPS as the deploy user by the TEMPORARY
# workflow .github/workflows/b18-hosted-activation.yml.
#
#   preflight        read-only, BEFORE any mutation: deployed SHA, clean checkout,
#                    accepted commit reachable + ancestry + exactly two commits ahead,
#                    env layout, containers, pgdata identity, durable queue health,
#                    schema fingerprint, brand_* columns ABSENT, health endpoints.
#   dump             schema-only pg_dump to STDOUT (no data) for the runner inspection.
#   apply            preflight → fresh backup (verified) → migrate profile with the
#                    ACCEPTED commit checked out and the api container PAUSED for the
#                    seconds of the non-transactional drizzle-kit push (trap-guarded
#                    unpause) → checkout restored to the deployed commit → proof that
#                    exactly the five nullable text columns were added, every company
#                    row is NULL in them, all other company data (incl. logo_url) and
#                    every table row count are unchanged → health/preservation.
#   verify           read-only, AFTER the develop deploy: HEAD/current-deploy.sha equal
#                    the accepted commit, containers healthy, durable queue on postgres,
#                    schema fingerprint unchanged since apply, health bodies; writes the
#                    state file for the smoke steps.
#   seed             creates the disposable smoke principals: tenant A (company +
#                    primary_admin + view-only employee), tenant B (company +
#                    primary_admin) and one disposable platform_owner. ONE password is
#                    read from STDIN and hashed inside the api container; never printed.
#   tenant-status    active|cancelled for tenant A (cancelled-tenant check; restored
#                    by the smoke before cleanup).
#   gcs-list <cid>   lists the managed-logo objects under branding/<cid>/ in the REAL
#                    configured bucket via the api container's own client/credential.
#                    Prints object keys/sizes only — never the bucket name/credential.
#   db-logo <cid>    prints the stored brand_logo_key shape + content type for <cid>.
#   postcheck        audit rows, no AI / no email, error-level log delta (4xx expected),
#                    web 5xx delta, queue health.
#   cleanup          removes exactly the disposable rows + every disposable GCS object,
#                    proves zero remain, then proves postgres/volume/api/web/env/
#                    checkout/schema unchanged since verify and existing tenants intact.
#
# Never: env changes, compose down, -v, prune, postgres recreate/restart, manual SQL
# DDL, anything outside the card-scanner-pro compose project. Never prints secrets.
# =============================================================================
set -euo pipefail
set +x

CMD="${1:?usage: b18-hosted.sh preflight|dump|apply|verify|seed|tenant-status|gcs-list|db-logo|postcheck|cleanup}"
DEPLOYED_SHA="${DEPLOYED_SHA:?DEPLOYED_SHA is required}"       # commit deployed BEFORE the merge
ACTIVATION_SHA="${ACTIVATION_SHA:?ACTIVATION_SHA is required}" # accepted Batch 18 commit (incl. correction 1)
APP_DIR="${DEPLOY_PATH:-/opt/lead-capture-pro/app}"
STATE_DIR="${STATE_DIR:-/opt/lead-capture-pro/env}"
ENV_FILE="$STATE_DIR/.env"
BACKUP_DIR="${BACKUP_DIR:-/opt/lead-capture-pro/backups/postgres}"
HEALTH_URL="http://127.0.0.1:18080"
API_URL="$HEALTH_URL/api"
SRC_BRANCH="claude/b18-tenant-branding"
SMOKE_STATE="$HOME/b18-smoke.state"
SMOKE_STAMP="${SMOKE_STAMP:-}"
BRAND_COLS="brand_primary_color brand_sidebar_color brand_default_theme brand_logo_key brand_logo_content_type"

log()  { echo "[b18] $*" >&2; }
fail() { echo "[b18] ERROR: $*" >&2; exit 1; }

compose() { docker compose -f docker-compose.yml -f compose.vps.yml "$@"; }
# One SQL statement inside the postgres container as its own POSTGRES_USER over the
# local socket — no password is read, passed, or printed.
psql_q() {
  compose exec -T postgres sh -c 'exec psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tA -c "$1"' sh "$1"
}
cid()        { compose ps -q "$1"; }
health_of()  { docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || echo unknown; }
started_of() { docker inspect -f '{{.State.StartedAt}}' "$1"; }
pgvol_of()   { docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$1"; }
count_in()   { printf '%s\n' "$1" | grep -c -- "$2" || true; }
json_get() {
  docker exec -i "$API_CID" node -e '
    let s = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let o; try { o = JSON.parse(s); } catch { process.stdout.write(""); return; }
      const v = process.argv[1].split(".").reduce((a, k) => (a == null ? a : a[k]), o);
      process.stdout.write(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
    });' "$1"
}
# Schema fingerprint: every public column (type/nullability/default), index and
# constraint definition, hashed. The *_EXCL variant ignores the five brand_* columns so
# "after apply minus the five columns" can be compared with "before".
SCHEMA_FP_SQL="select md5(string_agg(t, '|' order by t)) from (select table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') as t from information_schema.columns where table_schema='public' union all select 'idx:'||indexname||':'||indexdef from pg_indexes where schemaname='public' union all select 'con:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace) s"
SCHEMA_FP_EXCL_SQL="select md5(string_agg(t, '|' order by t)) from (select table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') as t from information_schema.columns where table_schema='public' and not (table_name='companies' and column_name like 'brand\\_%') union all select 'idx:'||indexname||':'||indexdef from pg_indexes where schemaname='public' union all select 'con:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace) s"
SCHEMA_COUNTS_SQL="select (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')||' tables, '||(select count(*) from information_schema.columns where table_schema='public')||' columns, '||(select count(*) from pg_indexes where schemaname='public')||' indexes, '||(select count(*) from pg_constraint where connamespace='public'::regnamespace)||' constraints'"
# Exact row count of every public base table (name=count, sorted).
ROWCOUNTS_SQL="select string_agg(table_name||'='||(xpath('/row/c/text()', query_to_xml('select count(*) as c from public.'||quote_ident(table_name), false, true, '')))[1]::text, ',' order by table_name) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'"
BRAND_COLS_SQL="select coalesce(string_agg(column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'<none>'), ' ' order by column_name),'<absent>') from information_schema.columns where table_schema='public' and table_name='companies' and column_name like 'brand\\_%'"
EXPECTED_BRAND_COLS="brand_default_theme:text:YES:<none> brand_logo_content_type:text:YES:<none> brand_logo_key:text:YES:<none> brand_primary_color:text:YES:<none> brand_sidebar_color:text:YES:<none>"
# Company data fingerprint (every column except the five new ones), plus logo_url evidence.
CO_FP_BEFORE_SQL="select coalesce(md5(string_agg(to_jsonb(c)::text, '|' order by id)),'empty') from companies c"
CO_FP_AFTER_SQL="select coalesce(md5(string_agg((to_jsonb(c) - 'brand_primary_color' - 'brand_sidebar_color' - 'brand_default_theme' - 'brand_logo_key' - 'brand_logo_content_type')::text, '|' order by id)),'empty') from companies c"
LOGO_URL_SQL="select count(*)||' companies, '||count(logo_url)||' with logo_url, md5(logo_urls)='||coalesce(md5(string_agg(coalesce(logo_url,'<null>'), '|' order by id)),'empty') from companies"
exists_of() { psql_q "select coalesce(to_regclass('public.$1')::text,'absent')"; }

umask 077
save_state() { printf '%s=%q\n' "$1" "$2" >> "$SMOKE_STATE"; }
load_state() { [ -f "$SMOKE_STATE" ] || fail "state file missing — run verify first"; set -a; . "$SMOKE_STATE"; set +a; cd "$APP_DIR/docker"; }

env_checks() {
  [ -f "$ENV_FILE" ] || fail "runtime env file missing: $ENV_FILE"
  ENV_MODE="$(stat -c '%a' "$ENV_FILE")"
  [ "$ENV_MODE" = "600" ] || fail "$ENV_FILE must be chmod 600 (is $ENV_MODE)"
  [ "$(readlink -f "$APP_DIR/docker/.env")" = "$(readlink -f "$ENV_FILE")" ] || fail "docker/.env does not resolve to $ENV_FILE"
  ENV_HASH="$(sha256sum "$ENV_FILE" | cut -c1-64)"
  DRIVER="$(grep -E '^JOBS_DRIVER=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  KEY_LINES="$(grep -cE '^JOBS_PAYLOAD_ENCRYPTION_KEY=.+' "$ENV_FILE" || true)"
  SMTP_LINES="$(grep -cE '^SMTP_HOST=.+' "$ENV_FILE" || true)"
  GEMINI_LINES="$(grep -cE '^GEMINI_API_KEY=.+' "$ENV_FILE" || true)"
  BUCKET_LINES="$(grep -cE '^DEFAULT_OBJECT_STORAGE_BUCKET_ID=.+' "$ENV_FILE" || true)"
  GAUTH_LINES="$(grep -cE '^OBJECT_STORAGE_AUTH=google$' "$ENV_FILE" || true)"
  GCRED_LINES="$(grep -cE '^GOOGLE_APPLICATION_CREDENTIALS=.+' "$ENV_FILE" || true)"
  STUB_LINES="$(grep -cE '^BRANDING_STORAGE_STUB=' "$ENV_FILE" || true)"
  [ "$DRIVER" = "postgres" ] || fail "JOBS_DRIVER is '${DRIVER:-<unset>}', expected postgres"
  [ "$KEY_LINES" = "1" ] || fail "expected exactly one non-empty JOBS_PAYLOAD_ENCRYPTION_KEY line (found $KEY_LINES)"
  [ "$BUCKET_LINES" = "1" ] || fail "expected exactly one DEFAULT_OBJECT_STORAGE_BUCKET_ID line (found $BUCKET_LINES)"
  log "env file: sha256=$ENV_HASH mode $ENV_MODE (read-only here); JOBS_DRIVER=postgres; JOBS_PAYLOAD_ENCRYPTION_KEY present (value never read); SMTP_HOST set: $SMTP_LINES; GEMINI_API_KEY set: $GEMINI_LINES; DEFAULT_OBJECT_STORAGE_BUCKET_ID set: $BUCKET_LINES (value never read); OBJECT_STORAGE_AUTH=google: $GAUTH_LINES; GOOGLE_APPLICATION_CREDENTIALS set: $GCRED_LINES; BRANDING_STORAGE_STUB lines: $STUB_LINES (must be 0 — the real bucket is used)"
  [ "$STUB_LINES" = "0" ] || fail "BRANDING_STORAGE_STUB must not be set on the hosted environment"
}

container_checks() {
  cd "$APP_DIR/docker"
  SERVICES="$(compose config --services | sort | tr '\n' ' ' | sed 's/ $//')"
  [ "$SERVICES" = "api postgres web" ] || fail "unexpected compose services: '$SERVICES'"
  compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}' >&2
  PG_CID="$(cid postgres)"; API_CID="$(cid api)"; WEB_CID="$(cid web)"
  [ -n "$PG_CID" ] && [ -n "$API_CID" ] && [ -n "$WEB_CID" ] || fail "postgres/api/web containers must all exist"
  [ "$(health_of "$PG_CID")" = "healthy" ]  || fail "postgres is not healthy: $(health_of "$PG_CID")"
  [ "$(health_of "$API_CID")" = "healthy" ] || fail "api is not healthy: $(health_of "$API_CID")"
  [ "$(health_of "$WEB_CID")" = "healthy" ] || fail "web is not healthy: $(health_of "$WEB_CID")"
  PG_STARTED="$(started_of "$PG_CID")"; API_STARTED="$(started_of "$API_CID")"; WEB_STARTED="$(started_of "$WEB_CID")"
  PG_VOL="$(pgvol_of "$PG_CID")"
  [ -n "$PG_VOL" ] || fail "cannot determine the pgdata volume of postgres"
  PG_VOL_CREATED="$(docker volume inspect -f '{{.CreatedAt}}' "$PG_VOL")"
  API_IMAGE="$(docker inspect -f '{{.Image}}' "$API_CID")"; WEB_IMAGE="$(docker inspect -f '{{.Image}}' "$WEB_CID")"
  compose exec -T postgres sh -c 'exec pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >&2 || fail "pg_isready failed"
  PG_VERSION="$(psql_q "select version()" | cut -d' ' -f1-2)"
  DB_SIZE="$(psql_q "select pg_size_pretty(pg_database_size(current_database()))")"
  DB_SIZE_BYTES="$(psql_q "select pg_database_size(current_database())")"
  log "postgres: $PG_CID healthy, started $PG_STARTED, $PG_VERSION, db size $DB_SIZE ($DB_SIZE_BYTES bytes)"
  log "pgdata volume: $PG_VOL (created $PG_VOL_CREATED)"
  log "api:      $API_CID healthy, started $API_STARTED, image $API_IMAGE, host ports: '$(docker port "$API_CID" | tr '\n' ' ')'"
  log "web:      $WEB_CID healthy, started $WEB_STARTED, image $WEB_IMAGE, ports: $(docker port "$WEB_CID" | tr '\n' ' ')"
  grep -q '127.0.0.1:18080' <<< "$(docker port "$WEB_CID")" || fail "web is not bound to 127.0.0.1:18080"
  [ -z "$(docker port "$API_CID")" ] || fail "api publishes a host port"
}

queue_checks() {
  API_LOG="$(docker logs "$API_CID" 2>&1)"
  log "queue selection / scheduler / recovery lines:"
  printf '%s\n' "$API_LOG" | grep -E 'Durable job queue selected|Durable job queue started|Recurring task scheduler started|Background job queue started|Unknown JOBS_DRIVER|requires JOBS_PAYLOAD_ENCRYPTION_KEY|Server listening|recovery at startup|Orphaned workflow run|Branding logo storage' | cut -c1-400 >&2 || true
  grep -q 'Durable job queue selected' <<< "$API_LOG" || fail "durable queue NOT selected in the running api"
  grep -q 'Durable job queue started' <<< "$API_LOG"  || fail "durable queue NOT started in the running api"
  grep -qE 'Background job queue started|Unknown JOBS_DRIVER|requires JOBS_PAYLOAD_ENCRYPTION_KEY|"driver":"in-process"' <<< "$API_LOG" && fail "api is NOT on the durable driver"
  grep -q '"driver":"postgres"' <<< "$API_LOG" || fail "durable queue driver line does not say postgres"
  grep -q 'Recurring task scheduler started' <<< "$API_LOG" || fail "scheduler not started"
  Q_LINE="$(printf '%s\n' "$API_LOG" | grep 'Durable job queue started' | head -1)"
  Q_WORKER="$(printf '%s' "$Q_LINE" | grep -oE '"workerId":"[^"]+"' | cut -d'"' -f4 || true)"
  Q_CONC="$(printf '%s' "$Q_LINE" | grep -oE '"concurrency":[0-9]+' | grep -oE '[0-9]+' || true)"
  C_RECOV_FAIL="$(count_in "$API_LOG" 'workflow run recovery at startup failed')"
  C_REL="$(printf '%s\n' "$API_LOG" | grep -c 'relation "' || true)"
  C_ORPHAN_FAIL="$(count_in "$API_LOG" 'Orphaned workflow run re-enqueue failed')"
  C_POLL="$(count_in "$API_LOG" 'Job queue poll failed')"; C_HEART="$(count_in "$API_LOG" 'Job lease heartbeat failed')"; C_STATE="$(count_in "$API_LOG" 'Job state update failed')"
  C_ERRLVL="$(count_in "$API_LOG" '"level":50')"; C_FATAL="$(count_in "$API_LOG" '"level":60')"
  C_STUB="$(count_in "$API_LOG" 'memory stub')"
  log "api log counters: recovery_failed=$C_RECOV_FAIL relation_errors=$C_REL orphan_reenqueue_failed=$C_ORPHAN_FAIL poll_failed=$C_POLL heartbeat_failed=$C_HEART state_update_failed=$C_STATE error_level=$C_ERRLVL fatal_level=$C_FATAL branding_memory_stub_lines=$C_STUB"
  if [ "$C_ERRLVL" != "0" ]; then log "error-level messages (first 10):"; printf '%s\n' "$API_LOG" | grep -- '"level":50' | grep -oE '"msg":"[^"]*"' | head -10 >&2 || true; fi
  [ "$C_RECOV_FAIL" = "0" ] && [ "$C_REL" = "0" ] && [ "$C_ORPHAN_FAIL" = "0" ] || fail "workflow startup recovery / relation errors present"
  [ "$C_POLL" = "0" ] && [ "$C_HEART" = "0" ] && [ "$C_STATE" = "0" ] || fail "durable queue errors present"
  [ "$C_FATAL" = "0" ] || fail "fatal-level api log lines present"
  [ "$C_STUB" = "0" ] || fail "the api selected the branding memory stub instead of the real bucket"
  WEB_LOG="$(docker logs "$WEB_CID" 2>&1)"
  C_WEB5XX="$(printf '%s\n' "$WEB_LOG" | grep -cE '" 5[0-9]{2} ' || true)"
  C_WEBERR="$(printf '%s\n' "$WEB_LOG" | grep -c '\[error\]' || true)"
  log "web (nginx) log counters since container start: 5xx responses=$C_WEB5XX, [error] lines=$C_WEBERR"
  JQ_STATS="$(psql_q "select status||'='||count(*) from job_queue group by status order by 1" | tr '\n' ' ')"
  JQ_DEAD="$(psql_q "select count(*) from job_queue where status='dead'")"
  JQ_RECENT="$(psql_q "select count(*) from job_queue where status='completed' and completed_at > now() - interval '15 minutes'")"
  RUNS_STUCK="$(psql_q "select count(*) from workflow_runs where status in ('queued','running')")"
  log "durable queue: worker=${Q_WORKER:-?} concurrency=${Q_CONC:-?}; job_queue by status: ${JQ_STATS:-none}; dead=$JQ_DEAD; completed last 15 min=$JQ_RECENT; workflow_runs queued/running=$RUNS_STUCK"
  [ "$JQ_DEAD" = "0" ] || fail "dead jobs present in job_queue"
}

health_check() {
  log "── health via $HEALTH_URL ──"
  H1="$(curl -fsS --max-time 5 "$HEALTH_URL/healthz")"     || fail "GET /healthz failed"
  H2="$(curl -fsS --max-time 5 "$HEALTH_URL/api/healthz")" || fail "GET /api/healthz failed"
  READYZ_RAW="$(curl -sS --max-time 10 -w '\n%{http_code}' "$HEALTH_URL/api/readyz")" || fail "GET /api/readyz failed"
  READYZ_CODE="${READYZ_RAW##*$'\n'}"
  READYZ_BODY="${READYZ_RAW%$'\n'*}"
  log "GET /healthz     -> $(printf '%s' "$H1" | tr -d '\n')"
  log "GET /api/healthz -> $(printf '%s' "$H2" | tr -d '\n')"
  log "GET /api/readyz  -> HTTP $READYZ_CODE $(printf '%s' "$READYZ_BODY" | tr -d '\n')"
  READYZ_PARSED="$(printf '%s' "$READYZ_BODY" | json_get status) $(printf '%s' "$READYZ_BODY" | json_get checks.database) $(printf '%s' "$READYZ_BODY" | json_get checks.storage)"
  log "readyz literal values: status/checks.database/checks.storage = $READYZ_PARSED"
  [ "$READYZ_CODE" = "200" ] || fail "readyz HTTP $READYZ_CODE"
  [ "$READYZ_PARSED" = "ok ok ok" ] || fail "readyz is not fully ok ($READYZ_PARSED)"
}

git_checks() {
  [ -d "$APP_DIR/.git" ] || fail "$APP_DIR is not a git checkout"
  cd "$APP_DIR"
  HEAD_SHA="$(git rev-parse HEAD)"
  [ -f "$STATE_DIR/current-deploy.sha" ] || fail "no current-deploy.sha recorded in $STATE_DIR"
  CUR_DEPLOY="$(cat "$STATE_DIR/current-deploy.sha")"; PREV_DEPLOY="$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null || echo none)"
  log "hosted checkout HEAD = $HEAD_SHA; current-deploy.sha = $CUR_DEPLOY; previous-deploy.sha = $PREV_DEPLOY"
  [ "$HEAD_SHA" = "$DEPLOYED_SHA" ]   || fail "checkout is at $HEAD_SHA, expected deployed $DEPLOYED_SHA"
  [ "$CUR_DEPLOY" = "$DEPLOYED_SHA" ] || fail "current-deploy.sha is $CUR_DEPLOY, expected $DEPLOYED_SHA"
  [ -z "$(git status --porcelain)" ]  || fail "working tree is unexpectedly dirty"
  git fetch --quiet origin "refs/heads/$SRC_BRANCH:refs/remotes/origin/$SRC_BRANCH"
  git cat-file -e "${ACTIVATION_SHA}^{commit}" 2>/dev/null || fail "accepted commit $ACTIVATION_SHA not found after fetching $SRC_BRANCH"
  git merge-base --is-ancestor "$DEPLOYED_SHA" "$ACTIVATION_SHA" || fail "$ACTIVATION_SHA does not descend from deployed $DEPLOYED_SHA"
  AHEAD="$(git rev-list --count "$DEPLOYED_SHA..$ACTIVATION_SHA")"
  [ "$AHEAD" = "2" ] || fail "accepted commit is $AHEAD commits ahead of the deployed commit, expected exactly 2 (B18 + correction 1)"
  N_SCHEMA="$(git diff --name-only "$DEPLOYED_SHA" "$ACTIVATION_SHA" -- lib/db/src/schema | tr '\n' ' ')"
  [ "$N_SCHEMA" = "lib/db/src/schema/companies.ts " ] || fail "schema files changed: '$N_SCHEMA' (expected only lib/db/src/schema/companies.ts)"
  log "accepted commit $ACTIVATION_SHA present; descends from $DEPLOYED_SHA: yes; commits ahead: $AHEAD ($(git log --format='%h %s' "$DEPLOYED_SHA..$ACTIVATION_SHA" | tr '\n' ';')); schema files changed: lib/db/src/schema/companies.ts only"
}

schema_state() {
  SCHEMA_FP="$(psql_q "$SCHEMA_FP_SQL")"; SCHEMA_COUNTS="$(psql_q "$SCHEMA_COUNTS_SQL")"
  BRAND_STATE="$(psql_q "$BRAND_COLS_SQL")"
  CO_ROWS="$(psql_q "select count(*) from companies")"
  LOGO_EVIDENCE="$(psql_q "$LOGO_URL_SQL")"
  log "schema: $SCHEMA_COUNTS; companies rows=$CO_ROWS; brand_* columns: $BRAND_STATE"
  log "logo_url evidence: $LOGO_EVIDENCE"
  log "SCHEMA_FP=$SCHEMA_FP"
}

# ─────────────────────────────────────────────────────────────────────────────
preflight() {
  log "── preflight (read-only, before any mutation) ──"
  log "running as $(id -un) on $(hostname) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git_checks
  env_checks
  container_checks
  queue_checks
  schema_state
  [ "$BRAND_STATE" = "<absent>" ] || fail "brand_* columns already present on companies: $BRAND_STATE — refusing to migrate"
  ROWCOUNTS="$(psql_q "$ROWCOUNTS_SQL")"
  log "row counts: $ROWCOUNTS"
  health_check
  log "preflight OK"
}

do_dump() {
  cd "$APP_DIR/docker"
  compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --schema-only --no-owner --no-privileges --no-comments'
}

restore_checkout() {
  cd "$APP_DIR"
  if [ "$(git rev-parse HEAD)" != "$DEPLOYED_SHA" ]; then
    log "restoring checkout to deployed $DEPLOYED_SHA"
    git -c advice.detachedHead=false checkout --quiet --detach "$DEPLOYED_SHA"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
do_apply() {
  preflight
  cd "$APP_DIR/docker"
  SCHEMA_FP_BEFORE="$SCHEMA_FP"; ENV_HASH_BEFORE="$ENV_HASH"; C_ERRLVL_BEFORE="$C_ERRLVL"
  CO_FP_BEFORE="$(psql_q "$CO_FP_BEFORE_SQL")"
  log "companies data fingerprint before: $CO_FP_BEFORE"

  # ── backup (nothing has changed yet) ──
  log "── backup ──"
  START_MARK="$(mktemp)"
  DEPLOY_PATH="$APP_DIR" bash "$APP_DIR/docker/scripts/backup-postgres.sh" >&2 || fail "backup failed — aborting before any change"
  BACKUP_FILE="$(find "$BACKUP_DIR" -maxdepth 1 -name 'leadcapture-*.sql.gz' -newer "$START_MARK" -printf '%f\n' | sort | tail -1)"
  rm -f "$START_MARK"
  [ -n "$BACKUP_FILE" ] || fail "backup script succeeded but no new backup file was found"
  BACKUP_SIZE="$(stat -c '%s' "$BACKUP_DIR/$BACKUP_FILE")"
  [ "$BACKUP_SIZE" -gt 1024 ] || fail "backup file is too small ($BACKUP_SIZE bytes)"
  BACKUP_LIST="$(ls -1 "$BACKUP_DIR"/leadcapture-*.sql.gz | xargs -n1 basename | tr '\n' ' ')"
  log "backup: $BACKUP_FILE ($BACKUP_SIZE bytes); retained backups: $BACKUP_LIST"
  # ── verify the backup BEFORE touching the schema ──
  gunzip -t "$BACKUP_DIR/$BACKUP_FILE" || fail "backup is not a valid gzip stream"
  N_TABLES_EXPECTED="$(psql_q "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")"
  N_CREATE="$(gunzip -c "$BACKUP_DIR/$BACKUP_FILE" | grep -c '^CREATE TABLE public\.' || true)"
  N_COPY="$(gunzip -c "$BACKUP_DIR/$BACKUP_FILE" | grep -c '^COPY public\.' || true)"
  CO_COPY_ROWS="$(gunzip -c "$BACKUP_DIR/$BACKUP_FILE" | awk '/^COPY public\.companies /{f=1;next} f&&/^\\\.$/{exit} f{n++} END{print n+0}')"
  gunzip -c "$BACKUP_DIR/$BACKUP_FILE" | grep -q '^CREATE TABLE public\.companies (' || fail "backup does not contain the companies table"
  gunzip -c "$BACKUP_DIR/$BACKUP_FILE" | tail -c 2000 | grep -q 'PostgreSQL database dump complete' || fail "backup is not a complete pg_dump"
  [ "$N_CREATE" = "$N_TABLES_EXPECTED" ] && [ "$N_COPY" = "$N_TABLES_EXPECTED" ] || fail "backup covers $N_CREATE CREATE TABLE / $N_COPY COPY blocks, expected $N_TABLES_EXPECTED each"
  [ "$CO_COPY_ROWS" = "$CO_ROWS" ] || fail "backup holds $CO_COPY_ROWS companies rows, database has $CO_ROWS"
  log "backup verified: gzip OK, complete dump, $N_CREATE tables (CREATE TABLE) / $N_COPY tables (COPY data) = $N_TABLES_EXPECTED public tables, companies rows in backup $CO_COPY_ROWS = live $CO_ROWS"

  DDL_BEFORE="$(mktemp)"; DDL_AFTER="$(mktemp)"
  trap 'rm -f "$DDL_BEFORE" "$DDL_AFTER"; restore_checkout' EXIT
  do_dump > "$DDL_BEFORE"
  log "schema-only DDL before: $(wc -l < "$DDL_BEFORE") lines"

  # ── migrate profile at the ACCEPTED commit ──
  log "── schema (migrate profile, drizzle-kit push) at $ACTIVATION_SHA ──"
  cd "$APP_DIR"
  git -c advice.detachedHead=false checkout --quiet --detach "$ACTIVATION_SHA"
  [ "$(git rev-parse HEAD)" = "$ACTIVATION_SHA" ] || fail "could not check out $ACTIVATION_SHA"
  [ -z "$(git status --porcelain)" ] || fail "working tree dirty after checkout"
  cd docker
  export COMPOSE_PARALLEL_LIMIT=1
  compose --profile migrate build migrate >&2
  MIGRATE_LOG="$(mktemp)"
  # drizzle-kit push is non-transactional: the api container is PAUSED (SIGSTOP
  # semantics; not stopped, not recreated) for exactly the seconds the push runs, so no
  # application write can interleave with the ALTER TABLE statements. The trap
  # guarantees the unpause on any failure. Row counts are taken INSIDE the pause window
  # (before and after the push) so they are an exact, deterministic comparison.
  API_PAUSED=0
  unpause_api() { if [ "$API_PAUSED" = "1" ]; then docker unpause "$API_CID" >/dev/null 2>&1 && log "api container unpaused"; API_PAUSED=0; fi; }
  trap 'unpause_api; rm -f "$DDL_BEFORE" "$DDL_AFTER" "$MIGRATE_LOG"; restore_checkout' EXIT
  ACTIVE_BEFORE="$(psql_q "select count(*) from pg_stat_activity where datname=current_database() and state='active' and pid<>pg_backend_pid()")"
  docker pause "$API_CID" >/dev/null && API_PAUSED=1
  PAUSE_START="$(date +%s.%N)"
  log "api container paused ($API_CID) — active application queries just before the pause: $ACTIVE_BEFORE"
  ROWCOUNTS_IN="$(psql_q "$ROWCOUNTS_SQL")"
  CO_FP_IN="$(psql_q "$CO_FP_BEFORE_SQL")"
  if ! compose --profile migrate run -T --rm --no-deps migrate 2>&1 | tee "$MIGRATE_LOG" >&2; then
    unpause_api; fail "drizzle-kit push failed (see output above)"
  fi
  ROWCOUNTS_OUT="$(psql_q "$ROWCOUNTS_SQL")"
  CO_FP_OUT="$(psql_q "$CO_FP_AFTER_SQL")"
  unpause_api
  PAUSE_SECS="$(awk "BEGIN{printf \"%.1f\", $(date +%s.%N) - $PAUSE_START}")"
  log "api write pause lasted ${PAUSE_SECS}s (container not restarted: StartedAt unchanged)"
  trap 'rm -f "$DDL_BEFORE" "$DDL_AFTER" "$MIGRATE_LOG"; restore_checkout' EXIT
  if grep -Eiq 'drop table|drop column|truncate|drop index|drop constraint|data.loss|data loss|not null|default ' "$MIGRATE_LOG"; then
    fail "drizzle-kit output mentions a destructive/non-additive change — STOP and inspect"
  fi
  grep -q 'Changes applied' "$MIGRATE_LOG" && MIGRATE_RESULT="Changes applied" || MIGRATE_RESULT="$(grep -oE 'No changes detected|\[✓\].*' "$MIGRATE_LOG" | tail -1 || echo 'marker not seen')"
  log "migrate result: $MIGRATE_RESULT"
  [ "$MIGRATE_RESULT" = "Changes applied" ] || fail "migrate did not report 'Changes applied' ($MIGRATE_RESULT)"
  restore_checkout
  cd "$APP_DIR"; [ "$(git rev-parse HEAD)" = "$DEPLOYED_SHA" ] || fail "checkout not restored"; [ -z "$(git status --porcelain)" ] || fail "working tree dirty after restore"
  cd docker

  # ── verify: exactly the five nullable text columns, nothing else ──
  log "── verify ──"
  BRAND_AFTER="$(psql_q "$BRAND_COLS_SQL")"
  log "brand_* columns after: $BRAND_AFTER"
  [ "$BRAND_AFTER" = "$EXPECTED_BRAND_COLS" ] || fail "brand_* columns are not exactly the five nullable text columns without defaults"
  NONNULL="$(psql_q "select count(*) from companies where brand_primary_color is not null or brand_sidebar_color is not null or brand_default_theme is not null or brand_logo_key is not null or brand_logo_content_type is not null")"
  [ "$NONNULL" = "0" ] || fail "$NONNULL company rows have a non-NULL brand_* value after the migrate"
  log "every company row is NULL in all five new columns (rows: $(psql_q "select count(*) from companies"), non-null: $NONNULL)"
  log "row counts inside the pause window — before push: $ROWCOUNTS_IN"
  log "row counts inside the pause window — after push:  $ROWCOUNTS_OUT"
  [ "$ROWCOUNTS_IN" = "$ROWCOUNTS_OUT" ] || fail "row counts changed during the push"
  log "companies data fingerprint (all columns except the five new ones): before=$CO_FP_IN after=$CO_FP_OUT"
  [ "$CO_FP_IN" = "$CO_FP_OUT" ] || fail "company data changed during the migrate"
  [ "$CO_FP_IN" = "$CO_FP_BEFORE" ] || log "note: companies changed between preflight and the pause (live activity) — the in-window comparison above is the authoritative one"
  LOGO_AFTER="$(psql_q "$LOGO_URL_SQL")"
  log "logo_url evidence after: $LOGO_AFTER"
  [ "$LOGO_AFTER" = "$LOGO_EVIDENCE" ] || fail "logo_url values changed"
  do_dump > "$DDL_AFTER"
  log "schema-only DDL after: $(wc -l < "$DDL_AFTER") lines"
  # pg_dump's per-run \restrict/\unrestrict guard tokens are random — ignore them. The
  # column that used to be last in companies gains a trailing comma; normalize commas.
  DDL_DIFF="$(diff <(grep -vE '^\\(un)?restrict ' "$DDL_BEFORE" | sed 's/,$//') <(grep -vE '^\\(un)?restrict ' "$DDL_AFTER" | sed 's/,$//') || true)"
  log "DDL diff (before -> after, trailing commas normalized):"
  printf '%s\n' "${DDL_DIFF:-<no difference>}" >&2
  REMOVED="$(printf '%s\n' "$DDL_DIFF" | grep -E '^<' || true)"
  [ -z "$REMOVED" ] || { printf '%s\n' "$REMOVED" >&2; fail "lines were REMOVED from the schema DDL — STOP"; }
  ADDED="$(printf '%s\n' "$DDL_DIFF" | grep -E '^>' || true)"
  N_ADDED="$(printf '%s\n' "$ADDED" | grep -c . || true)"
  BAD="$(printf '%s\n' "$ADDED" | grep -vE '^>     brand_(primary_color|sidebar_color|default_theme|logo_key|logo_content_type) text$' || true)"
  [ -z "$BAD" ] || { printf '%s\n' "$BAD" >&2; fail "the DDL gained lines other than the five brand_* columns — STOP"; }
  [ "$N_ADDED" = "5" ] || fail "the DDL diff shows $N_ADDED added lines, expected exactly 5"
  log "DDL diff OK: exactly 5 added column lines inside CREATE TABLE public.companies, nothing removed, no index/constraint/other-table change"
  SCHEMA_FP_AFTER="$(psql_q "$SCHEMA_FP_SQL")"; SCHEMA_FP_AFTER_EXCL="$(psql_q "$SCHEMA_FP_EXCL_SQL")"; SCHEMA_COUNTS_AFTER="$(psql_q "$SCHEMA_COUNTS_SQL")"
  log "schema fingerprint: before=$SCHEMA_FP_BEFORE after=$SCHEMA_FP_AFTER after-excluding-brand-columns=$SCHEMA_FP_AFTER_EXCL"
  [ "$SCHEMA_FP_AFTER_EXCL" = "$SCHEMA_FP_BEFORE" ] || fail "the schema fingerprint differs by more than the five brand_* columns"
  [ "$SCHEMA_FP_AFTER" != "$SCHEMA_FP_BEFORE" ] || fail "schema fingerprint did not change at all"
  log "schema counts: before '$SCHEMA_COUNTS' -> after '$SCHEMA_COUNTS_AFTER' (columns +5, tables/indexes/constraints unchanged)"
  N_IDX_B="$(printf '%s' "$SCHEMA_COUNTS" | grep -oE '[0-9]+ indexes')"; N_IDX_A="$(printf '%s' "$SCHEMA_COUNTS_AFTER" | grep -oE '[0-9]+ indexes')"
  N_CON_B="$(printf '%s' "$SCHEMA_COUNTS" | grep -oE '[0-9]+ constraints')"; N_CON_A="$(printf '%s' "$SCHEMA_COUNTS_AFTER" | grep -oE '[0-9]+ constraints')"
  N_TAB_B="$(printf '%s' "$SCHEMA_COUNTS" | grep -oE '^[0-9]+ tables')"; N_TAB_A="$(printf '%s' "$SCHEMA_COUNTS_AFTER" | grep -oE '^[0-9]+ tables')"
  [ "$N_IDX_B" = "$N_IDX_A" ] && [ "$N_CON_B" = "$N_CON_A" ] && [ "$N_TAB_B" = "$N_TAB_A" ] || fail "table/index/constraint counts changed"
  echo "SCHEMA_FP_AFTER=$SCHEMA_FP_AFTER"

  health_check
  API_LOG2="$(docker logs "$API_CID" 2>&1)"
  C_ERR2="$(count_in "$API_LOG2" '"level":50')"
  log "api (still $DEPLOYED_SHA, untouched): error-level lines before/after = $C_ERRLVL_BEFORE/$C_ERR2"

  log "── preservation ──"
  [ "$(cid postgres)" = "$PG_CID" ]               || fail "postgres container changed"
  [ "$(started_of "$PG_CID")" = "$PG_STARTED" ]   || fail "postgres was restarted"
  [ "$(health_of "$PG_CID")" = "healthy" ]        || fail "postgres is no longer healthy"
  [ "$(pgvol_of "$PG_CID")" = "$PG_VOL" ]         || fail "pgdata volume name changed"
  [ "$(docker volume inspect -f '{{.CreatedAt}}' "$PG_VOL")" = "$PG_VOL_CREATED" ] || fail "pgdata volume was recreated"
  [ "$(cid web)" = "$WEB_CID" ]                   || fail "web container changed"
  [ "$(started_of "$WEB_CID")" = "$WEB_STARTED" ] || fail "web was restarted"
  [ "$(cid api)" = "$API_CID" ]                   || fail "api container changed"
  [ "$(started_of "$API_CID")" = "$API_STARTED" ] || fail "api was restarted"
  [ "$(docker inspect -f '{{.State.Status}}' "$API_CID")" = "running" ] || fail "api is not running after unpause"
  waited=0; until [ "$(health_of "$API_CID")" = "healthy" ]; do waited=$((waited+5)); [ "$waited" -ge 120 ] && fail "api not healthy 120s after unpause"; sleep 5; done
  log "api healthy again ${waited}s after unpause (same container, same StartedAt)"
  [ "$(sha256sum "$ENV_FILE" | cut -c1-64)" = "$ENV_HASH_BEFORE" ] || fail "env file changed"
  [ "$(stat -c '%a' "$ENV_FILE")" = "600" ]       || fail "env file mode changed"
  cd "$APP_DIR"
  [ "$(git rev-parse HEAD)" = "$DEPLOYED_SHA" ]   || fail "checkout not at deployed commit"
  [ -z "$(git status --porcelain)" ]              || fail "working tree dirty"
  [ "$(cat "$STATE_DIR/current-deploy.sha")" = "$DEPLOYED_SHA" ] || fail "current-deploy.sha changed"
  trap - EXIT; rm -f "$DDL_BEFORE" "$DDL_AFTER" "$MIGRATE_LOG"
  log "SUMMARY apply: backup=$BACKUP_FILE backup_bytes=$BACKUP_SIZE migrate='$MIGRATE_RESULT' brand_columns=5(nullable text, no default) null_rows_violations=0 rowcounts_changed=no company_data_changed=no logo_url_changed=no ddl_added_lines=5 ddl_removed_lines=0 schema_fp_before=$SCHEMA_FP_BEFORE schema_fp_after=$SCHEMA_FP_AFTER fp_after_excl_brand=$SCHEMA_FP_AFTER_EXCL api_paused_secs=$PAUSE_SECS readyz='$READYZ_PARSED' api_restarted=no postgres_restarted=no env_changed=no checkout=$DEPLOYED_SHA"
  log "hosted B18 schema activation COMPLETED"
}

# ─────────────────────────────────────────────────────────────────────────────
verify() {
  log "── post-deploy verification (read-only) ──"
  log "running as $(id -un) on $(hostname) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cd "$APP_DIR"
  HEAD_SHA="$(git rev-parse HEAD)"; CUR_DEPLOY="$(cat "$STATE_DIR/current-deploy.sha")"; PREV_DEPLOY="$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null || echo none)"
  log "hosted checkout HEAD = $HEAD_SHA; current-deploy.sha = $CUR_DEPLOY; previous-deploy.sha = $PREV_DEPLOY"
  [ "$HEAD_SHA" = "$ACTIVATION_SHA" ] || fail "checkout is at $HEAD_SHA, expected $ACTIVATION_SHA"
  [ "$CUR_DEPLOY" = "$ACTIVATION_SHA" ] || fail "current-deploy.sha is $CUR_DEPLOY, expected $ACTIVATION_SHA"
  [ "$PREV_DEPLOY" = "$DEPLOYED_SHA" ] || fail "previous-deploy.sha is $PREV_DEPLOY, expected $DEPLOYED_SHA"
  [ -z "$(git status --porcelain)" ] || fail "working tree dirty"
  env_checks
  container_checks
  queue_checks
  schema_state
  [ "$BRAND_STATE" = "$EXPECTED_BRAND_COLS" ] || fail "brand_* columns are not the expected five after the deploy: $BRAND_STATE"
  log "SCHEMA_FP=$SCHEMA_FP (after apply: ${SCHEMA_FP_AFTER:-<not provided>})"
  if [ -n "${SCHEMA_FP_AFTER:-}" ]; then [ "$SCHEMA_FP" = "$SCHEMA_FP_AFTER" ] || fail "schema fingerprint changed across the deploy"; log "schema fingerprint unchanged across the deploy"; fi
  health_check
  PROBE="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$API_URL/organization/branding")"
  [ "$PROBE" = "401" ] || fail "GET /api/organization/branding (unauthenticated) answered $PROBE, expected 401"
  PROBE2="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$API_URL/branding/logos/0/00000000000000000000000000000000")"
  [ "$PROBE2" = "404" ] || fail "GET /api/branding/logos/0/<zero id> answered $PROBE2, expected 404"
  SPA_CODE="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$HEALTH_URL/admin/organization")"
  [ "$SPA_CODE" = "200" ] || fail "GET /admin/organization (SPA shell) answered $SPA_CODE"
  log "GET /api/organization/branding (unauthenticated) -> 401; GET /api/branding/logos/0/<zero id> -> 404; GET /admin/organization (SPA shell) -> 200"
  AI_TOTAL="$(psql_q "select count(*) from ai_invocations")"
  MAIL_SENT="$(count_in "$API_LOG" 'Email sent')"; MAIL_SKIP="$(count_in "$API_LOG" 'Email not sent')"
  ROWCOUNTS="$(psql_q "$ROWCOUNTS_SQL")"
  CO_FP="$(psql_q "$CO_FP_BEFORE_SQL")"
  : > "$SMOKE_STATE"
  for kv in PG_CID API_CID WEB_CID PG_STARTED API_STARTED WEB_STARTED PG_VOL PG_VOL_CREATED ENV_HASH SCHEMA_FP AI_TOTAL MAIL_SENT MAIL_SKIP C_ERRLVL C_WEB5XX CO_ROWS CO_FP ROWCOUNTS; do
    save_state "$kv" "${!kv}"
  done
  log "verify OK — deployed $ACTIVATION_SHA, driver postgres, readyz '$READYZ_PARSED', existing companies=$CO_ROWS (data fingerprint $CO_FP)"
}

# ─────────────────────────────────────────────────────────────────────────────
seed() {
  load_state
  [ -n "$SMOKE_STAMP" ] || fail "SMOKE_STAMP is required"
  grep -qE '^[0-9]{14}$' <<< "$SMOKE_STAMP" || fail "SMOKE_STAMP must be a 14-digit UTC stamp"
  IFS= read -r PW || true
  [ "${#PW}" -ge 24 ] || fail "no disposable password received on stdin"
  STALE="$(psql_q "select coalesce(string_agg(id||':'||name, ', ' order by id),'none') from companies where name ~ '^B18 SMOKE [AB] [0-9]{14}$'")"
  STALE_U="$(psql_q "select coalesce(string_agg(id||':'||email, ', ' order by id),'none') from users where email ~ '^b18-smoke-[a-z0-9-]+-[0-9]{14}@smoke\\.invalid$'")"
  log "stale disposable rows from earlier attempts: companies=$STALE users=$STALE_U"
  if [ "$STALE" != "none" ] || [ "$STALE_U" != "none" ]; then
    psql_q "begin; delete from audit_logs where company_id in (select id from companies where name ~ '^B18 SMOKE [AB] [0-9]{14}$'); delete from login_attempts where email ~ '^b18-smoke-[a-z0-9-]+-[0-9]{14}@smoke\\.invalid$'; delete from users where email ~ '^b18-smoke-[a-z0-9-]+-[0-9]{14}@smoke\\.invalid$'; delete from companies where name ~ '^B18 SMOKE [AB] [0-9]{14}$'; commit;" >&2
    log "stale disposable rows removed"
  fi
  HASH="$(docker exec -i -e PW="$PW" "$API_CID" node -e 'import("bcryptjs").then((m) => process.stdout.write((m.default || m).hashSync(process.env.PW, 10)))' < /dev/null)"
  unset PW
  [ -n "$HASH" ] || fail "could not hash the disposable password inside the api container"
  CO_A_NAME="B18 SMOKE A $SMOKE_STAMP"; CO_B_NAME="B18 SMOKE B $SMOKE_STAMP"
  EMAIL_A="b18-smoke-admin-a-$SMOKE_STAMP@smoke.invalid"; EMAIL_V="b18-smoke-viewer-a-$SMOKE_STAMP@smoke.invalid"
  EMAIL_B="b18-smoke-admin-b-$SMOKE_STAMP@smoke.invalid"; EMAIL_P="b18-smoke-platform-$SMOKE_STAMP@smoke.invalid"
  CO_A="$(psql_q "insert into companies (name, status) values ('$CO_A_NAME', 'active') returning id")"
  CO_B="$(psql_q "insert into companies (name, status) values ('$CO_B_NAME', 'active') returning id")"
  [ "$CO_A" -gt 0 ] 2>/dev/null && [ "$CO_B" -gt 0 ] 2>/dev/null || fail "could not create the disposable companies"
  U_A="$(psql_q "insert into users (email, password_hash, name, role, company_id, permissions) values ('$EMAIL_A', '$HASH', 'B18 Smoke Admin A', 'primary_admin', $CO_A, '{}'::jsonb) returning id")"
  U_V="$(psql_q "insert into users (email, password_hash, name, role, company_id, permissions) values ('$EMAIL_V', '$HASH', 'B18 Smoke Viewer A', 'employee', $CO_A, '{\"organization\":[\"view\"]}'::jsonb) returning id")"
  U_B="$(psql_q "insert into users (email, password_hash, name, role, company_id, permissions) values ('$EMAIL_B', '$HASH', 'B18 Smoke Admin B', 'primary_admin', $CO_B, '{}'::jsonb) returning id")"
  U_P="$(psql_q "insert into users (email, password_hash, name, role, company_id, permissions) values ('$EMAIL_P', '$HASH', 'B18 Smoke Platform', 'platform_owner', NULL, '{}'::jsonb) returning id")"
  unset HASH
  for v in U_A U_V U_B U_P; do [ "${!v}" -gt 0 ] 2>/dev/null || fail "could not create disposable user $v"; done
  for kv in CO_A CO_B U_A U_V U_B U_P EMAIL_A EMAIL_V EMAIL_B EMAIL_P CO_A_NAME CO_B_NAME; do save_state "$kv" "${!kv}"; done
  log "disposable principals: tenant A company=$CO_A '$CO_A_NAME' (admin user $U_A $EMAIL_A, view-only employee $U_V $EMAIL_V); tenant B company=$CO_B '$CO_B_NAME' (admin user $U_B $EMAIL_B); platform_owner user $U_P $EMAIL_P — one password hashed inside the api container, never printed"
  echo "SMOKE_CO_A=$CO_A"; echo "SMOKE_CO_B=$CO_B"; echo "SMOKE_U_A=$U_A"; echo "SMOKE_U_V=$U_V"; echo "SMOKE_U_B=$U_B"; echo "SMOKE_U_P=$U_P"
  echo "SMOKE_EMAIL_A=$EMAIL_A"; echo "SMOKE_EMAIL_V=$EMAIL_V"; echo "SMOKE_EMAIL_B=$EMAIL_B"; echo "SMOKE_EMAIL_P=$EMAIL_P"
}

tenant_status() {
  load_state
  WANT="${2:?usage: tenant-status active|cancelled}"
  case "$WANT" in active|cancelled) ;; *) fail "unsupported status $WANT";; esac
  psql_q "update companies set status='$WANT' where id=$CO_A and name='$CO_A_NAME'" >&2
  NOW="$(psql_q "select status from companies where id=$CO_A")"
  [ "$NOW" = "$WANT" ] || fail "tenant A status is $NOW, expected $WANT"
  log "tenant A (company $CO_A) status -> $NOW"
  echo "STATUS=$NOW"
}

# Real-bucket listing through the api container's own client + credential. Prints keys
# and sizes only; the bucket name and the credential are never printed.
gcs_list() {
  load_state
  TARGET="${2:?usage: gcs-list <companyId>}"
  [ "$TARGET" = "$CO_A" ] || [ "$TARGET" = "$CO_B" ] || fail "gcs-list is restricted to the disposable companies"
  docker exec -i "$API_CID" node -e '
    import("@google-cloud/storage").then(async ({ Storage }) => {
      const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
      if (!bucketId) { console.log(JSON.stringify({ error: "no bucket configured" })); process.exit(2); }
      const [files] = await new Storage().bucket(bucketId).getFiles({ prefix: process.argv[1], autoPaginate: true });
      console.log(JSON.stringify({ prefix: process.argv[1], count: files.length, objects: files.map((f) => ({ key: f.name, size: Number(f.metadata.size), contentType: f.metadata.contentType || null })) }));
    }).catch((e) => { console.log(JSON.stringify({ error: String(e && e.message || e).slice(0, 200) })); process.exit(3); });' "branding/$TARGET/" < /dev/null
}

gcs_delete_prefix() {
  TARGET="$1"
  docker exec -i "$API_CID" node -e '
    import("@google-cloud/storage").then(async ({ Storage }) => {
      const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
      const b = new Storage().bucket(bucketId);
      const [files] = await b.getFiles({ prefix: process.argv[1], autoPaginate: true });
      for (const f of files) await f.delete({ ignoreNotFound: true });
      const [left] = await b.getFiles({ prefix: process.argv[1], autoPaginate: true });
      console.log(JSON.stringify({ prefix: process.argv[1], deleted: files.length, remaining: left.length }));
    }).catch((e) => { console.log(JSON.stringify({ error: String(e && e.message || e).slice(0, 200) })); process.exit(3); });' "branding/$TARGET/" < /dev/null
}

db_logo() {
  load_state
  TARGET="${2:?usage: db-logo <companyId>}"
  [ "$TARGET" = "$CO_A" ] || [ "$TARGET" = "$CO_B" ] || fail "db-logo is restricted to the disposable companies"
  psql_q "select coalesce(brand_logo_key,'<null>')||'|'||coalesce(brand_logo_content_type,'<null>')||'|'||coalesce(logo_url,'<null>')||'|'||(brand_logo_key ~ ('^branding/'||id||'/[0-9a-f]{32}\\.(png|jpg|webp)$'))::text||'|'||coalesce(brand_primary_color,'<null>')||'|'||coalesce(brand_sidebar_color,'<null>')||'|'||coalesce(brand_default_theme,'<null>')||'|'||status from companies where id=$TARGET"
}

# ─────────────────────────────────────────────────────────────────────────────
postcheck() {
  load_state
  [ -n "${CO_A:-}" ] || fail "no disposable tenant in the state file"
  log "── post-smoke evidence (tenant A $CO_A, tenant B $CO_B) ──"
  AUD="$(psql_q "select action||'|'||coalesce(user_id::text,'<null>')||'|'||coalesce(entity_type,'<null>')||'|'||coalesce(entity_id::text,'<null>') from audit_logs where company_id=$CO_A and action like 'branding.%' order by id")"
  log "branding audit rows for tenant A (action|user|entity|entity_id):"; printf '%s\n' "$AUD" >&2
  for a in branding.update branding.logo.replace branding.logo.remove branding.reset; do
    grep -q "^$a|" <<< "$AUD" || fail "no $a audit row for tenant A"
  done
  grep -q "^branding.update|$U_P|" <<< "$AUD" || fail "no branding.update row recorded under the platform user $U_P"
  N_AUD_B="$(psql_q "select count(*) from audit_logs where company_id=$CO_B and action like 'branding.%'")"
  log "branding audit rows: tenant A=$(printf '%s\n' "$AUD" | grep -c .) (incl. platform-user rows), tenant B=$N_AUD_B"
  ST="$(psql_q "select status from companies where id=$CO_A")"; [ "$ST" = "active" ] || fail "tenant A is still '$ST' — must be restored to active before cleanup"
  API_LOG2="$(docker logs "$API_CID" 2>&1)"
  AI_AFTER="$(psql_q "select count(*) from ai_invocations")"; AI_CO="$(psql_q "select count(*) from ai_invocations where company_id in ($CO_A,$CO_B)")"
  MAIL_SENT_AFTER="$(count_in "$API_LOG2" 'Email sent')"; MAIL_SKIP_AFTER="$(count_in "$API_LOG2" 'Email not sent')"
  C_ERRLVL2="$(count_in "$API_LOG2" '"level":50')"; C_WEB5XX2="$(printf '%s\n' "$(docker logs "$WEB_CID" 2>&1)" | grep -cE '" 5[0-9]{2} ' || true)"
  C_STUB2="$(count_in "$API_LOG2" 'memory stub')"; C_STORE_FAIL="$(count_in "$API_LOG2" 'storage write failed')"
  log "no AI / no email: ai_invocations total $AI_TOTAL -> $AI_AFTER (disposable tenants: $AI_CO); 'Email sent' $MAIL_SENT -> $MAIL_SENT_AFTER; 'Email not sent' $MAIL_SKIP -> $MAIL_SKIP_AFTER"
  log "error-level api log lines $C_ERRLVL -> $C_ERRLVL2; web 5xx responses $C_WEB5XX -> $C_WEB5XX2; branding memory-stub lines=$C_STUB2; storage write failures=$C_STORE_FAIL"
  [ "$AI_AFTER" = "$AI_TOTAL" ] && [ "$AI_CO" = "0" ] || fail "an AI invocation was recorded during the smoke"
  [ "$MAIL_SENT_AFTER" = "$MAIL_SENT" ] && [ "$MAIL_SKIP_AFTER" = "$MAIL_SKIP" ] || fail "an email send was attempted during the smoke"
  [ "$C_STUB2" = "0" ] && [ "$C_STORE_FAIL" = "0" ] || fail "branding storage did not use the real bucket cleanly"
  BAD_ERR=0
  if [ "$C_ERRLVL2" != "$C_ERRLVL" ]; then
    log "new error-level api log lines during the smoke (sanitized fields only):"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      fields="$(printf '%s\n' "$line" | grep -oE '"(msg|method|url|statusCode|type|code|message|requestId)":("[^"]*"|[0-9]+)' | tr '\n' ' ')"
      sc="$(printf '%s\n' "$line" | grep -oE '"statusCode":[0-9]+' | head -1 | grep -oE '[0-9]+' || true)"
      if [ -n "$sc" ] && [ "$sc" -ge 400 ] && [ "$sc" -lt 500 ]; then
        log "  client error HTTP $sc (expected 4xx from the smoke's own negative probes): $fields"
      else
        log "  UNEXPECTED: $fields"; BAD_ERR=$((BAD_ERR + 1))
      fi
    done <<< "$(printf '%s\n' "$API_LOG2" | grep -- '"level":50' | tail -n "$((C_ERRLVL2 - C_ERRLVL))")"
  fi
  [ "$BAD_ERR" = "0" ] || fail "$BAD_ERR unexpected error-level api log line(s) during the smoke"
  [ "$C_WEB5XX2" = "$C_WEB5XX" ] || fail "new web 5xx responses during the smoke"
  queue_checks
  health_check
  log "postcheck OK: audit rows verified, ai_delta=$((AI_AFTER - AI_TOTAL)) email_delta=$((MAIL_SENT_AFTER - MAIL_SENT)) errlvl_delta=$((C_ERRLVL2 - C_ERRLVL)) (unexpected: $BAD_ERR) web5xx_delta=$((C_WEB5XX2 - C_WEB5XX))"
}

# ─────────────────────────────────────────────────────────────────────────────
cleanup() {
  load_state
  CLEANUP="nothing-created"; GCS_LEFT="n/a"
  if [ -n "${CO_A:-}" ]; then
    log "── cleanup (exact disposable rows + objects only: companies $CO_A/$CO_B, users ${U_A:-?}/${U_V:-?}/${U_B:-?}/${U_P:-?}) ──"
    psql_q "update companies set status='active' where id in ($CO_A,$CO_B)" >&2 || true
    GA="$(gcs_delete_prefix "$CO_A")"; GB="$(gcs_delete_prefix "$CO_B")"
    log "gcs objects removed: A=$GA B=$GB"
    psql_q "begin; delete from audit_logs where company_id in ($CO_A,$CO_B) or user_id in (${U_A:-0},${U_V:-0},${U_B:-0},${U_P:-0}); delete from login_attempts where email in ('$EMAIL_A','$EMAIL_V','$EMAIL_B','$EMAIL_P'); delete from users where id=${U_P:-0} and email='$EMAIL_P'; delete from companies where id in ($CO_A,$CO_B); commit;" >&2 || log "cleanup transaction failed"
    LEFT=""
    for spec in "companies:id in ($CO_A,$CO_B)" "users:company_id in ($CO_A,$CO_B)" "users:email in ('$EMAIL_A','$EMAIL_V','$EMAIL_B','$EMAIL_P')" "sessions:user_id in (${U_A:-0},${U_V:-0},${U_B:-0},${U_P:-0})" "login_attempts:email in ('$EMAIL_A','$EMAIL_V','$EMAIL_B','$EMAIL_P')" "audit_logs:company_id in ($CO_A,$CO_B)" "audit_logs:user_id in (${U_A:-0},${U_V:-0},${U_B:-0},${U_P:-0})" "business_cards:company_id in ($CO_A,$CO_B)" "business_cards:user_id in (${U_A:-0},${U_V:-0},${U_B:-0},${U_P:-0})" "leads:company_id in ($CO_A,$CO_B)" "contacts:company_id in ($CO_A,$CO_B)" "tasks:company_id in ($CO_A,$CO_B)" "notifications:company_id in ($CO_A,$CO_B)" "ai_invocations:company_id in ($CO_A,$CO_B)" "user_roles:user_id in (${U_A:-0},${U_V:-0},${U_B:-0},${U_P:-0})" "trusted_devices:user_id in (${U_A:-0},${U_V:-0},${U_B:-0},${U_P:-0})" "verification_tokens:user_id in (${U_A:-0},${U_V:-0},${U_B:-0},${U_P:-0})"; do
      t="${spec%%:*}"; w="${spec#*:}"
      n="$(psql_q "select count(*) from $t where $w" 2>/dev/null || echo err)"
      [ "$n" = "0" ] || LEFT="$LEFT $t($n)"
    done
    if [ -n "$LEFT" ]; then log "rows still present after cleanup:$LEFT"; CLEANUP="incomplete:$LEFT"; else log "cleanup verified: 0 rows left for the disposable companies/users"; CLEANUP="complete"; fi
    GA2="$(gcs_list_raw "$CO_A")"; GB2="$(gcs_list_raw "$CO_B")"
    log "gcs objects remaining after cleanup: A=$GA2 B=$GB2"
    GCS_LEFT="A=$(printf '%s' "$GA2" | grep -oE '"count":[0-9]+' | grep -oE '[0-9]+'),B=$(printf '%s' "$GB2" | grep -oE '"count":[0-9]+' | grep -oE '[0-9]+')"
    [ "$GCS_LEFT" = "A=0,B=0" ] || fail "disposable GCS objects remain: $GCS_LEFT"
    REMAIN="$(psql_q "select count(*) from companies where name ~ '^B18 SMOKE [AB] [0-9]{14}$'")"
    log "disposable smoke companies remaining: $REMAIN"
  else
    log "cleanup: no disposable tenant was created"
  fi
  log "── preservation (since verify) ──"
  [ "$(cid postgres)" = "$PG_CID" ] && [ "$(started_of "$PG_CID")" = "$PG_STARTED" ] && [ "$(health_of "$PG_CID")" = "healthy" ] || fail "postgres changed/restarted"
  [ "$(pgvol_of "$PG_CID")" = "$PG_VOL" ] && [ "$(docker volume inspect -f '{{.CreatedAt}}' "$PG_VOL")" = "$PG_VOL_CREATED" ] || fail "pgdata volume changed"
  [ "$(cid api)" = "$API_CID" ] && [ "$(started_of "$API_CID")" = "$API_STARTED" ] && [ "$(health_of "$API_CID")" = "healthy" ] || fail "api changed/restarted"
  [ "$(cid web)" = "$WEB_CID" ] && [ "$(started_of "$WEB_CID")" = "$WEB_STARTED" ] && [ "$(health_of "$WEB_CID")" = "healthy" ] || fail "web changed/restarted"
  [ "$(sha256sum "$ENV_FILE" | cut -c1-64)" = "$ENV_HASH" ] && [ "$(stat -c '%a' "$ENV_FILE")" = "600" ] || fail "env file changed"
  SCHEMA_FP2="$(psql_q "$SCHEMA_FP_SQL")"
  [ "$SCHEMA_FP2" = "$SCHEMA_FP" ] || fail "schema fingerprint changed during the smoke"
  CO_ROWS2="$(psql_q "select count(*) from companies")"; CO_FP2="$(psql_q "$CO_FP_BEFORE_SQL")"
  [ "$CO_ROWS2" = "$CO_ROWS" ] && [ "$CO_FP2" = "$CO_FP" ] || fail "existing tenant companies changed (rows $CO_ROWS -> $CO_ROWS2, fingerprint $CO_FP -> $CO_FP2)"
  ROWCOUNTS2="$(psql_q "$ROWCOUNTS_SQL")"
  log "row counts at verify: $ROWCOUNTS"
  log "row counts now:       $ROWCOUNTS2"
  cd "$APP_DIR"; [ "$(git rev-parse HEAD)" = "$ACTIVATION_SHA" ] && [ -z "$(git status --porcelain)" ] && [ "$(cat "$STATE_DIR/current-deploy.sha")" = "$ACTIVATION_SHA" ] || fail "checkout/deploy state changed"
  cd docker; health_check
  log "postgres unchanged ($PG_CID, volume $PG_VOL created $PG_VOL_CREATED); api/web unchanged; env file unchanged (sha256 match, mode 600); schema fingerprint unchanged ($SCHEMA_FP); existing companies unchanged ($CO_ROWS rows, data fingerprint $CO_FP); deployed $ACTIVATION_SHA; readyz '$READYZ_PARSED'"
  rm -f "$SMOKE_STATE"
  log "SUMMARY cleanup=$CLEANUP gcs_objects_remaining=$GCS_LEFT"
}
gcs_list_raw() {
  docker exec -i "$API_CID" node -e '
    import("@google-cloud/storage").then(async ({ Storage }) => {
      const [files] = await new Storage().bucket(process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID).getFiles({ prefix: process.argv[1], autoPaginate: true });
      console.log(JSON.stringify({ prefix: process.argv[1], count: files.length, objects: files.map((f) => f.name) }));
    }).catch((e) => { console.log(JSON.stringify({ error: String(e && e.message || e).slice(0, 200) })); process.exit(3); });' "branding/$1/" < /dev/null
}

case "$CMD" in
  preflight)     preflight ;;
  dump)          do_dump ;;
  apply)         do_apply ;;
  verify)        verify ;;
  seed)          seed ;;
  tenant-status) tenant_status "$@" ;;
  gcs-list)      gcs_list "$@" ;;
  db-logo)       db_logo "$@" ;;
  postcheck)     postcheck ;;
  cleanup)       cleanup ;;
  *) fail "unknown command $CMD" ;;
esac
