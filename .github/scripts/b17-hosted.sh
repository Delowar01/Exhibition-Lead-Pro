#!/bin/bash
# =============================================================================
# Batch 17 — hosted activation on the dev VPS (ONE-OFF operations script, not
# application code). Executed on the VPS as the deploy user by the TEMPORARY
# workflow .github/workflows/b17-hosted-activation.yml.
#
#   b17-hosted.sh preflight   read-only, BEFORE the merge: deployed SHA, clean
#                             checkout, accepted commit reachable + ancestry,
#                             env layout, containers, pgdata identity, durable
#                             queue health, schema fingerprint, health endpoints.
#   b17-hosted.sh verify      read-only, AFTER the develop deploy: checkout HEAD
#                             and current-deploy.sha equal the accepted commit,
#                             containers healthy, durable queue on postgres, no
#                             queue/worker/app errors, schema fingerprint
#                             unchanged, health bodies. Writes a state file for
#                             the later steps (container ids, counters).
#   b17-hosted.sh seed        creates ONE isolated disposable tenant (company +
#                             primary_admin) for the browser smoke. The password
#                             is read from STDIN (first line) and hashed inside
#                             the api container; nothing secret is printed.
#   b17-hosted.sh postcheck   after the browser smoke: the smoke run and its
#                             action rows, exactly-once evidence, no AI / no
#                             email, error-level log delta.
#   b17-hosted.sh cleanup     removes exactly the disposable tenant rows, then
#                             proves postgres/volume/api/web/env/checkout are
#                             unchanged since `verify`.
#
# B17 has NO schema change: this script never runs drizzle-kit, never takes a
# backup, never runs the migrate profile, never touches env, volumes, compose
# lifecycle, or anything outside the card-scanner-pro compose project. It never
# prints secrets (env values, passwords, tokens, job payloads are never read
# into the log).
# =============================================================================
set -euo pipefail
set +x

CMD="${1:?usage: b17-hosted.sh preflight|verify|seed|postcheck|cleanup}"
DEPLOYED_SHA="${DEPLOYED_SHA:?DEPLOYED_SHA is required}"       # commit deployed BEFORE the merge
ACTIVATION_SHA="${ACTIVATION_SHA:?ACTIVATION_SHA is required}" # accepted Batch 17 commit
APP_DIR="${DEPLOY_PATH:-/opt/lead-capture-pro/app}"
STATE_DIR="${STATE_DIR:-/opt/lead-capture-pro/env}"
ENV_FILE="$STATE_DIR/.env"
HEALTH_URL="http://127.0.0.1:18080"
API_URL="$HEALTH_URL/api"
SRC_BRANCH="claude/b17-workflow-ui"
SMOKE_STATE="$HOME/b17-smoke.state"
SMOKE_STAMP="${SMOKE_STAMP:-}"

log()  { echo "[b17] $*" >&2; }
fail() { echo "[b17] ERROR: $*" >&2; exit 1; }

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
# constraint definition, hashed — B17 must leave it byte-identical.
SCHEMA_FP_SQL="select md5(string_agg(t, '|' order by t)) from (select table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') as t from information_schema.columns where table_schema='public' union all select 'idx:'||indexname||':'||indexdef from pg_indexes where schemaname='public' union all select 'con:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace) s"
SCHEMA_COUNTS_SQL="select (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')||' tables, '||(select count(*) from information_schema.columns where table_schema='public')||' columns, '||(select count(*) from pg_indexes where schemaname='public')||' indexes, '||(select count(*) from pg_constraint where connamespace='public'::regnamespace)||' constraints'"
exists_of() { psql_q "select coalesce(to_regclass('public.$1')::text,'absent')"; }

umask 077

# State file lines are shell-quoted (%q) so sourcing them is safe for any value.
save_state() { printf '%s=%q\n' "$1" "$2" >> "$SMOKE_STATE"; }

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
  [ "$DRIVER" = "postgres" ] || fail "JOBS_DRIVER is '${DRIVER:-<unset>}', expected postgres"
  [ "$KEY_LINES" = "1" ] || fail "expected exactly one non-empty JOBS_PAYLOAD_ENCRYPTION_KEY line (found $KEY_LINES)"
  log "env file: mode $ENV_MODE (read-only here); JOBS_DRIVER=postgres; JOBS_PAYLOAD_ENCRYPTION_KEY present (value never read); SMTP_HOST set: $SMTP_LINES; GEMINI_API_KEY set: $GEMINI_LINES"
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
  log "postgres: $PG_CID healthy, started $PG_STARTED, $PG_VERSION, db size $DB_SIZE"
  log "pgdata volume: $PG_VOL (created $PG_VOL_CREATED)"
  log "api:      $API_CID healthy, started $API_STARTED, image $API_IMAGE, host ports: '$(docker port "$API_CID" | tr '\n' ' ')'"
  log "web:      $WEB_CID healthy, started $WEB_STARTED, image $WEB_IMAGE, ports: $(docker port "$WEB_CID" | tr '\n' ' ')"
  grep -q '127.0.0.1:18080' <<< "$(docker port "$WEB_CID")" || fail "web is not bound to 127.0.0.1:18080"
  [ -z "$(docker port "$API_CID")" ] || fail "api publishes a host port"
}

queue_checks() {
  API_LOG="$(docker logs "$API_CID" 2>&1)"
  log "queue selection / scheduler / recovery lines:"
  printf '%s\n' "$API_LOG" | grep -E 'Durable job queue selected|Durable job queue started|Recurring task scheduler started|Background job queue started|Unknown JOBS_DRIVER|requires JOBS_PAYLOAD_ENCRYPTION_KEY|Server listening|recovery at startup|Orphaned workflow run' | cut -c1-400 >&2 || true
  grep -q 'Durable job queue selected' <<< "$API_LOG" || fail "durable queue NOT selected in the running api"
  grep -q 'Durable job queue started' <<< "$API_LOG"  || fail "durable queue NOT started in the running api"
  grep -qE 'Background job queue started|Unknown JOBS_DRIVER|requires JOBS_PAYLOAD_ENCRYPTION_KEY|"driver":"in-process"' <<< "$API_LOG" && fail "api is NOT on the durable driver"
  grep -q '"driver":"postgres"' <<< "$API_LOG" || fail "durable queue driver line does not say postgres"
  grep -q 'Recurring task scheduler started' <<< "$API_LOG" || fail "scheduler not started"
  Q_LINE="$(printf '%s\n' "$API_LOG" | grep 'Durable job queue started' | head -1)"
  Q_WORKER="$(printf '%s' "$Q_LINE" | grep -oE '"workerId":"[^"]+"' | cut -d'"' -f4 || true)"
  Q_CONC="$(printf '%s' "$Q_LINE" | grep -oE '"concurrency":[0-9]+' | grep -oE '[0-9]+' || true)"
  C_RECOV_FAIL="$(count_in "$API_LOG" 'workflow run recovery at startup failed')"
  C_REL="$(printf '%s\n' "$API_LOG" | grep -c 'relation "workflow_' || true)"
  C_ORPHAN_FAIL="$(count_in "$API_LOG" 'Orphaned workflow run re-enqueue failed')"
  C_POLL="$(count_in "$API_LOG" 'Job queue poll failed')"; C_HEART="$(count_in "$API_LOG" 'Job lease heartbeat failed')"; C_STATE="$(count_in "$API_LOG" 'Job state update failed')"
  C_ERRLVL="$(count_in "$API_LOG" '"level":50')"; C_FATAL="$(count_in "$API_LOG" '"level":60')"
  log "api log counters: recovery_failed=$C_RECOV_FAIL relation_missing=$C_REL orphan_reenqueue_failed=$C_ORPHAN_FAIL poll_failed=$C_POLL heartbeat_failed=$C_HEART state_update_failed=$C_STATE error_level=$C_ERRLVL fatal_level=$C_FATAL"
  if [ "$C_ERRLVL" != "0" ]; then log "error-level messages (first 10):"; printf '%s\n' "$API_LOG" | grep -- '"level":50' | grep -oE '"msg":"[^"]*"' | head -10 >&2 || true; fi
  [ "$C_RECOV_FAIL" = "0" ] && [ "$C_REL" = "0" ] && [ "$C_ORPHAN_FAIL" = "0" ] || fail "workflow startup recovery reported database errors"
  [ "$C_POLL" = "0" ] && [ "$C_HEART" = "0" ] && [ "$C_STATE" = "0" ] || fail "durable queue errors present"
  [ "$C_FATAL" = "0" ] || fail "fatal-level api log lines present"
  WEB_LOG="$(docker logs "$WEB_CID" 2>&1)"
  C_WEB5XX="$(printf '%s\n' "$WEB_LOG" | grep -cE '" 5[0-9]{2} ' || true)"
  C_WEBERR="$(printf '%s\n' "$WEB_LOG" | grep -c '\[error\]' || true)"
  log "web (nginx) log counters since container start: 5xx responses=$C_WEB5XX, [error] lines=$C_WEBERR"
  JQ_STATS="$(psql_q "select status||'='||count(*) from job_queue group by status order by 1" | tr '\n' ' ')"
  JQ_DEAD="$(psql_q "select count(*) from job_queue where status='dead'")"
  JQ_RECENT="$(psql_q "select count(*) from job_queue where status='completed' and completed_at > now() - interval '15 minutes'")"
  RUNS_TOTAL="$(psql_q "select count(*) from workflow_runs")"; RUNS_STUCK="$(psql_q "select count(*) from workflow_runs where status in ('queued','running')")"
  WD_TOTAL="$(psql_q "select count(*) from workflow_definitions")"
  log "durable queue: worker=${Q_WORKER:-?} concurrency=${Q_CONC:-?}; job_queue by status: ${JQ_STATS:-none}; dead=$JQ_DEAD; completed last 15 min=$JQ_RECENT; workflow_definitions=$WD_TOTAL; workflow_runs total=$RUNS_TOTAL queued/running=$RUNS_STUCK"
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
  WF_PROBE="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$API_URL/workflows/runs")"
  [ "$WF_PROBE" = "401" ] || fail "GET /api/workflows/runs (unauthenticated) answered $WF_PROBE, expected 401"
  SPA_CODE="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$HEALTH_URL/admin/automations")"
  [ "$SPA_CODE" = "200" ] || fail "GET /admin/automations (SPA shell) answered $SPA_CODE"
  log "GET /api/workflows/runs (unauthenticated) -> 401; GET /admin/automations (SPA shell) -> $SPA_CODE"
}

# ─────────────────────────────────────────────────────────────────────────────
preflight() {
  log "── preflight (read-only, before the merge) ──"
  log "running as $(id -un) on $(hostname) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
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
  N_SCHEMA="$(git diff --name-only "$DEPLOYED_SHA" "$ACTIVATION_SHA" -- lib/db/src/schema | wc -l | tr -d ' ')"
  [ "$N_SCHEMA" = "0" ] || fail "accepted commit changes $N_SCHEMA schema files — B17 must not change the schema"
  log "accepted commit $ACTIVATION_SHA present ($(git log -1 --format='%s' "$ACTIVATION_SHA")); descends from $DEPLOYED_SHA: yes; lib/db/src/schema files changed: 0"
  env_checks
  container_checks
  queue_checks
  SCHEMA_FP="$(psql_q "$SCHEMA_FP_SQL")"; SCHEMA_COUNTS="$(psql_q "$SCHEMA_COUNTS_SQL")"
  log "schema: $SCHEMA_COUNTS; workflow_definitions=$(exists_of workflow_definitions) workflow_runs=$(exists_of workflow_runs) workflow_action_runs=$(exists_of workflow_action_runs) job_queue=$(exists_of job_queue)"
  log "SCHEMA_FP=$SCHEMA_FP"
  health_check
  log "preflight OK"
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
  SCHEMA_FP="$(psql_q "$SCHEMA_FP_SQL")"; SCHEMA_COUNTS="$(psql_q "$SCHEMA_COUNTS_SQL")"
  log "schema: $SCHEMA_COUNTS"
  log "SCHEMA_FP=$SCHEMA_FP (before merge: ${SCHEMA_FP_BEFORE:-<not provided>})"
  if [ -n "${SCHEMA_FP_BEFORE:-}" ]; then [ "$SCHEMA_FP" = "$SCHEMA_FP_BEFORE" ] || fail "schema fingerprint changed across the deploy"; log "schema fingerprint unchanged across the deploy"; fi
  health_check
  AI_TOTAL="$(psql_q "select count(*) from ai_invocations")"
  MAIL_SENT="$(count_in "$API_LOG" 'Email sent')"; MAIL_SKIP="$(count_in "$API_LOG" 'Email not sent')"
  JOBQ_WF="$(psql_q "select count(*) from job_queue where name='workflow.run'")"
  : > "$SMOKE_STATE"
  for kv in PG_CID API_CID WEB_CID PG_STARTED API_STARTED WEB_STARTED PG_VOL PG_VOL_CREATED ENV_HASH SCHEMA_FP AI_TOTAL MAIL_SENT MAIL_SKIP C_ERRLVL C_WEB5XX JOBQ_WF RUNS_TOTAL WD_TOTAL; do
    save_state "$kv" "${!kv}"
  done
  log "verify OK — deployed $ACTIVATION_SHA, driver postgres, readyz '$READYZ_PARSED'"
}

load_state() { [ -f "$SMOKE_STATE" ] || fail "state file missing — run verify first"; set -a; . "$SMOKE_STATE"; set +a; cd "$APP_DIR/docker"; }

# ─────────────────────────────────────────────────────────────────────────────
seed() {
  load_state
  [ -n "$SMOKE_STAMP" ] || fail "SMOKE_STAMP is required"
  grep -qE '^[0-9]{14}$' <<< "$SMOKE_STAMP" || fail "SMOKE_STAMP must be a 14-digit UTC stamp"
  IFS= read -r PW || true
  [ "${#PW}" -ge 24 ] || fail "no disposable password received on stdin"
  STALE="$(psql_q "select coalesce(string_agg(id||':'||name||':users='||(select count(*) from users u where u.company_id=c.id), ', ' order by id),'none') from companies c where name ~ '^B17 SMOKE [0-9]{14}$'")"
  log "stale disposable smoke companies from earlier attempts: $STALE"
  if [ "$STALE" != "none" ]; then
    psql_q "begin; delete from audit_logs where company_id in (select id from companies where name ~ '^B17 SMOKE [0-9]{14}$'); delete from login_attempts where email ~ '^b17-smoke-[0-9]{14}@smoke\\.invalid$'; delete from companies where name ~ '^B17 SMOKE [0-9]{14}$'; commit;" >&2
    log "stale disposable smoke companies removed; remaining: $(psql_q "select count(*) from companies where name ~ '^B17 SMOKE [0-9]{14}$'")"
  fi
  CO_NAME="B17 SMOKE $SMOKE_STAMP"; EMAIL="b17-smoke-$SMOKE_STAMP@smoke.invalid"
  HASH="$(docker exec -i -e PW="$PW" "$API_CID" node -e 'import("bcryptjs").then((m) => process.stdout.write((m.default || m).hashSync(process.env.PW, 10)))' < /dev/null)"
  unset PW
  [ -n "$HASH" ] || fail "could not hash the disposable password inside the api container"
  CO_ID="$(psql_q "insert into companies (name, status) values ('$CO_NAME', 'active') returning id")"
  [ -n "$CO_ID" ] && [ "$CO_ID" -gt 0 ] 2>/dev/null || fail "could not create the disposable company (got '$CO_ID')"
  U_ID="$(psql_q "insert into users (email, password_hash, name, role, company_id, permissions) values ('$EMAIL', '$HASH', 'B17 Smoke Admin', 'primary_admin', $CO_ID, '{}'::jsonb) returning id")"
  [ -n "$U_ID" ] && [ "$U_ID" -gt 0 ] 2>/dev/null || fail "could not create the disposable user (got '$U_ID')"
  unset HASH
  save_state CO_ID "$CO_ID"; save_state U_ID "$U_ID"; save_state EMAIL "$EMAIL"; save_state CO_NAME "$CO_NAME"
  log "disposable tenant: company id=$CO_ID '$CO_NAME', user id=$U_ID ($EMAIL, primary_admin) — password hashed inside the api container, never printed"
  echo "SMOKE_COMPANY_ID=$CO_ID"; echo "SMOKE_USER_ID=$U_ID"; echo "SMOKE_EMAIL=$EMAIL"
}

# ─────────────────────────────────────────────────────────────────────────────
postcheck() {
  load_state
  [ -n "${CO_ID:-}" ] || fail "no disposable company in the state file"
  log "── post-smoke evidence (company $CO_ID) ──"
  RUNS="$(psql_q "select id||'|'||status||'|'||trigger_type||'|'||entity_type||'|'||entity_id||'|'||definition_revision||'|'||enqueue_generation||'|'||coalesce(error::text,'<null>')||'|'||(started_at is not null)||'|'||(completed_at is not null)||'|'||(lock_expires_at is null)||'|'||(definition_snapshot->>'name') from workflow_runs where company_id=$CO_ID order by id")"
  log "workflow_runs for the smoke company (id|status|trigger|entity|entity_id|rev|gen|error|started|completed|lock_released|snapshot_name): ${RUNS:-none}"
  [ "$(printf '%s\n' "$RUNS" | grep -c .)" = "1" ] || fail "expected exactly one smoke run"
  RUN_ID="${RUNS%%|*}"
  grep -q "^$RUN_ID|completed|lead.created|lead|" <<< "$RUNS" || fail "smoke run is not a completed lead.created run"
  grep -q "|<null>|true|true|true|B17 smoke ${SMOKE_STAMP}$" <<< "$RUNS" || fail "smoke run row is not in the expected terminal state"
  ACTS="$(psql_q "select action_index||'|'||action_type||'|'||status||'|'||attempts||'|'||coalesce(error::text,'<null>') from workflow_action_runs where run_id=$RUN_ID order by action_index")"
  log "workflow_action_runs (index|type|status|attempts|error): $(printf '%s' "$ACTS" | tr '\n' ' ')"
  [ "$(printf '%s\n' "$ACTS" | grep -c .)" = "2" ] || fail "expected two action rows"
  grep -q '^0|task.create|completed|1|<null>$' <<< "$ACTS" || fail "action 0 (task.create) not completed exactly once"
  grep -q '^1|lead.add_tag|completed|1|<null>$' <<< "$ACTS" || fail "action 1 (lead.add_tag) not completed exactly once"
  LEAD_ID="$(psql_q "select entity_id from workflow_runs where id=$RUN_ID")"
  TAGS_ON_LEAD="$(psql_q "select count(*) from lead_tags where lead_id=$LEAD_ID")"
  TASKS="$(psql_q "select count(*) from tasks where company_id=$CO_ID")"
  log "exactly-once: lead $LEAD_ID has $TAGS_ON_LEAD tag row(s); tasks created for the company: $TASKS"
  [ "$TAGS_ON_LEAD" = "1" ] && [ "$TASKS" = "1" ] || fail "action side effects are not exactly once"
  JOBROW="$(psql_q "select id||'|'||status||'|'||attempts||'|'||max_attempts||'|'||coalesce(worker_id,'<null>')||'|'||coalesce(last_error,'<null>')||'|'||left(payload,5)||'|'||(position('workflow' in payload)=0)::text from job_queue where name='workflow.run' and dedupe_key='workflow.run:$RUN_ID:1'")"
  log "durable job (id|status|attempts|max|worker|last_error|payload_prefix|no_plaintext) = $JOBROW"
  J_STATUS="$(printf '%s' "$JOBROW" | cut -d'|' -f2)"; J_ATT="$(printf '%s' "$JOBROW" | cut -d'|' -f3)"; J_ERR="$(printf '%s' "$JOBROW" | cut -d'|' -f6)"; J_PREFIX="$(printf '%s' "$JOBROW" | cut -d'|' -f7)"; J_NOPLAIN="$(printf '%s' "$JOBROW" | cut -d'|' -f8)"
  [ "$J_STATUS" = "completed" ] && [ "$J_ATT" = "1" ] && [ "$J_ERR" = "<null>" ] || fail "job row not completed exactly once"
  [ "$J_PREFIX" = "gcm1." ] && [ "$J_NOPLAIN" = "true" ] || fail "job payload is not an encrypted envelope"
  JOBQ_WF_AFTER="$(psql_q "select count(*) from job_queue where name='workflow.run'")"
  [ "$JOBQ_WF_AFTER" = "$((JOBQ_WF + 1))" ] || fail "workflow.run job rows went $JOBQ_WF -> $JOBQ_WF_AFTER (expected +1)"
  API_LOG2="$(docker logs "$API_CID" 2>&1)"
  AI_AFTER="$(psql_q "select count(*) from ai_invocations")"; AI_CO="$(psql_q "select count(*) from ai_invocations where company_id=$CO_ID")"
  MAIL_SENT_AFTER="$(count_in "$API_LOG2" 'Email sent')"; MAIL_SKIP_AFTER="$(count_in "$API_LOG2" 'Email not sent')"
  C_ERRLVL2="$(count_in "$API_LOG2" '"level":50')"; C_WEB5XX2="$(printf '%s\n' "$(docker logs "$WEB_CID" 2>&1)" | grep -cE '" 5[0-9]{2} ' || true)"
  DEFS="$(psql_q "select coalesce(string_agg(id||':'||status, ',' order by id),'none') from workflow_definitions where company_id=$CO_ID")"
  log "definitions left by the UI lifecycle (id:status): $DEFS"
  log "no AI / no email: ai_invocations total $AI_TOTAL -> $AI_AFTER (company $CO_ID: $AI_CO); 'Email sent' $MAIL_SENT -> $MAIL_SENT_AFTER; 'Email not sent' $MAIL_SKIP -> $MAIL_SKIP_AFTER"
  log "error-level api log lines $C_ERRLVL -> $C_ERRLVL2; web 5xx responses $C_WEB5XX -> $C_WEB5XX2"
  [ "$AI_AFTER" = "$AI_TOTAL" ] && [ "$AI_CO" = "0" ] || fail "an AI invocation was recorded during the smoke"
  [ "$MAIL_SENT_AFTER" = "$MAIL_SENT" ] && [ "$MAIL_SKIP_AFTER" = "$MAIL_SKIP" ] || fail "an email send was attempted during the smoke"
  # The global error handler logs EVERY error that reaches it at level 50, including
  # 4xx AppErrors (e.g. the smoke's own deliberate GET of the deleted definition -> 404).
  # Only lines without a 4xx status are unexpected (true unhandled/5xx errors).
  BAD_ERR=0
  if [ "$C_ERRLVL2" != "$C_ERRLVL" ]; then
    log "new error-level api log lines during the smoke (sanitized fields only):"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      fields="$(printf '%s\n' "$line" | grep -oE '"(msg|method|url|statusCode|type|code|message|requestId)":("[^"]*"|[0-9]+)' | tr '\n' ' ')"
      sc="$(printf '%s\n' "$line" | grep -oE '"statusCode":[0-9]+' | head -1 | grep -oE '[0-9]+' || true)"
      if [ -n "$sc" ] && [ "$sc" -ge 400 ] && [ "$sc" -lt 500 ]; then
        log "  client error HTTP $sc (expected 4xx, e.g. the smoke's own 404 probe): $fields"
      else
        log "  UNEXPECTED: $fields"; BAD_ERR=$((BAD_ERR + 1))
      fi
    done <<< "$(printf '%s\n' "$API_LOG2" | grep -- '"level":50' | tail -n "$((C_ERRLVL2 - C_ERRLVL))")"
  fi
  [ "$BAD_ERR" = "0" ] || fail "$BAD_ERR unexpected error-level api log line(s) during the smoke"
  [ "$C_WEB5XX2" = "$C_WEB5XX" ] || fail "new web 5xx responses during the smoke"
  save_state RUN_ID "$RUN_ID"
  log "postcheck OK: run_id=$RUN_ID actions=2/2 completed attempts=1 job=$J_STATUS ai_delta=$((AI_AFTER - AI_TOTAL)) email_delta=$((MAIL_SENT_AFTER - MAIL_SENT)) errlvl_delta=$((C_ERRLVL2 - C_ERRLVL)) (unexpected: $BAD_ERR) web5xx_delta=$((C_WEB5XX2 - C_WEB5XX))"
}

# ─────────────────────────────────────────────────────────────────────────────
cleanup() {
  load_state
  CLEANUP="nothing-created"
  if [ -n "${CO_ID:-}" ]; then
    log "── cleanup (exact disposable rows only: company $CO_ID, user ${U_ID:-?}, $EMAIL) ──"
    psql_q "begin; delete from audit_logs where company_id=$CO_ID; delete from login_attempts where email='$EMAIL'; delete from companies where id=$CO_ID; commit;" >&2 || log "cleanup transaction failed"
    LEFT=""
    for spec in "companies:id=$CO_ID" "users:email='$EMAIL'" "users:company_id=$CO_ID" "sessions:user_id=${U_ID:-0}" "login_attempts:email='$EMAIL'" "audit_logs:company_id=$CO_ID" "leads:company_id=$CO_ID" "contacts:company_id=$CO_ID" "tasks:company_id=$CO_ID" "follow_ups:company_id=$CO_ID" "notifications:company_id=$CO_ID" "tags:company_id=$CO_ID" "lead_tags:company_id=$CO_ID" "lead_activities:company_id=$CO_ID" "pipeline_stages:company_id=$CO_ID" "workflow_definitions:company_id=$CO_ID" "workflow_runs:company_id=$CO_ID" "workflow_action_runs:company_id=$CO_ID" "ai_invocations:company_id=$CO_ID"; do
      t="${spec%%:*}"; w="${spec#*:}"
      n="$(psql_q "select count(*) from $t where $w" 2>/dev/null || echo err)"
      [ "$n" = "0" ] || LEFT="$LEFT $t($n)"
    done
    if [ -n "$LEFT" ]; then log "rows still present after cleanup:$LEFT"; CLEANUP="incomplete:$LEFT"; else log "cleanup verified: 0 rows left for company $CO_ID / user ${U_ID:-?} / $EMAIL"; CLEANUP="complete"; fi
    JOBROW_LEFT="$(psql_q "select coalesce(string_agg(id||':'||status, ','),'none') from job_queue where dedupe_key like 'workflow.run:${RUN_ID:-0}:%'")"
    log "job_queue row(s) of the smoke run left in place (completed, inert; queue table not modified): $JOBROW_LEFT"
    REMAIN="$(psql_q "select count(*) from companies where name ~ '^B17 SMOKE [0-9]{14}$'")"
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
  WD_AFTER="$(psql_q "select count(*) from workflow_definitions")"; RUNS_AFTER="$(psql_q "select count(*) from workflow_runs")"
  cd "$APP_DIR"; [ "$(git rev-parse HEAD)" = "$ACTIVATION_SHA" ] && [ -z "$(git status --porcelain)" ] && [ "$(cat "$STATE_DIR/current-deploy.sha")" = "$ACTIVATION_SHA" ] || fail "checkout/deploy state changed"
  log "postgres unchanged ($PG_CID, volume $PG_VOL created $PG_VOL_CREATED); api/web unchanged; env file unchanged (sha256 match, mode 600); schema fingerprint unchanged ($SCHEMA_FP); workflow_definitions $WD_TOTAL -> $WD_AFTER; workflow_runs $RUNS_TOTAL -> $RUNS_AFTER; deployed $ACTIVATION_SHA"
  rm -f "$SMOKE_STATE"
  log "SUMMARY cleanup=$CLEANUP"
}

case "$CMD" in
  preflight) preflight ;;
  verify)    verify ;;
  seed)      seed ;;
  postcheck) postcheck ;;
  cleanup)   cleanup ;;
  *) fail "unknown command $CMD" ;;
esac
