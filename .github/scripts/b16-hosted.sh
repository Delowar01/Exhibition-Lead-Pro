#!/bin/bash
# =============================================================================
# Batch 16 — hosted activation on the dev.kaptnow.com VPS (ONE-OFF operations
# script, not application code). Executed on the VPS as the deploy user by the
# TEMPORARY workflow .github/workflows/b16-hosted-activation.yml.
#
#   b16-hosted.sh preflight   read-only: deployed SHA, env layout, containers,
#                             pgdata identity, schema state, durable queue health,
#                             health endpoints. Mutates nothing.
#   b16-hosted.sh dump        schema-only pg_dump of the hosted database to STDOUT
#                             (no data, no owners/privileges) for the runner-side
#                             drizzle-kit inspection. Mutates nothing.
#   b16-hosted.sh apply       preflight → fresh backup → migrate profile with the
#                             ACCEPTED commit checked out (the api container is PAUSED
#                             for the seconds the non-atomic drizzle-kit push runs, so
#                             no write can hit custom_field_values while its FK is
#                             being renamed) → verify that exactly the B16 tables/
#                             indexes/constraints were added and the FK was renamed
#                             with an identical, validated definition → restore the
#                             checkout to the deployed commit → health/preservation.
#                             postgres/web are never touched; api is never restarted.
#   b16-hosted.sh smoke       after the develop deploy of ACTIVATION_SHA: durable
#                             queue selection, startup recovery, health, one isolated
#                             workflow smoke through the real API + PostgreSQL queue,
#                             exact cleanup, preservation.
#
# Never: env changes, compose down, -v, prune, postgres recreate/restart, anything
# outside the card-scanner-pro compose project. Never prints secrets (env values,
# passwords, tokens, job payloads are never read into the log).
# =============================================================================
set -euo pipefail
set +x

CMD="${1:?usage: b16-hosted.sh preflight|dump|apply|smoke}"
DEPLOYED_SHA="${DEPLOYED_SHA:?DEPLOYED_SHA is required}"       # commit that must currently be deployed
ACTIVATION_SHA="${ACTIVATION_SHA:?ACTIVATION_SHA is required}" # accepted Batch 16 commit
APP_DIR="${DEPLOY_PATH:-/opt/lead-capture-pro/app}"
STATE_DIR="${STATE_DIR:-/opt/lead-capture-pro/env}"
ENV_FILE="$STATE_DIR/.env"
BACKUP_DIR="${BACKUP_DIR:-/opt/lead-capture-pro/backups/postgres}"
HEALTH_URL="http://127.0.0.1:18080"
API_URL="$HEALTH_URL/api"
SRC_BRANCH="claude/b16-workflow-engine"

log()  { echo "[b16] $*" >&2; }
fail() { echo "[b16] ERROR: $*" >&2; exit 1; }

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
# JSON field extraction with the api container's node (no jq dependency on the VPS).
# Reads the JSON document from stdin; prints the dotted path value (objects as JSON).
json_get() {
  docker exec -i "$API_CID" node -e '
    let s = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let o; try { o = JSON.parse(s); } catch { process.stdout.write(""); return; }
      const v = process.argv[1].split(".").reduce((a, k) => (a == null ? a : a[k]), o);
      process.stdout.write(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
    });' "$1"
}

SCHEMA_SQL="select table_name||'('||(select count(*) from information_schema.columns c where c.table_schema=t.table_schema and c.table_name=t.table_name)||')' from information_schema.tables t where table_schema='public' and table_type='BASE TABLE' order by 1"
EXPECTED_RUN_COLS="id,company_id,workflow_definition_id,definition_revision,definition_snapshot,trigger_type,entity_type,entity_id,actor_user_id,event_key,status,error,enqueue_generation,lock_expires_at,queued_at,started_at,completed_at,created_at,updated_at"
EXPECTED_ACT_COLS="id,run_id,company_id,action_index,action_type,status,attempts,error,result,started_at,completed_at,created_at,updated_at"
EXPECTED_RUN_IDX="workflow_runs_company_created_idx workflow_runs_company_definition_idx workflow_runs_company_entity_idx workflow_runs_company_status_idx workflow_runs_definition_event_ux workflow_runs_pkey workflow_runs_status_updated_idx"
EXPECTED_ACT_IDX="workflow_action_runs_company_idx workflow_action_runs_pkey workflow_action_runs_run_index_ux"
EXPECTED_RUN_FK="workflow_runs_actor_user_id_users_id_fk workflow_runs_company_id_companies_id_fk workflow_runs_workflow_definition_id_workflow_definitions_id_fk"
EXPECTED_ACT_FK="workflow_action_runs_company_id_companies_id_fk workflow_action_runs_run_id_workflow_runs_id_fk"
# custom_field_values.definition_id FK (Batch 16 correction 2): truncated auto name → explicit name, identical definition.
CFV_OLD_FK="custom_field_values_definition_id_custom_field_definitions_id_f"
CFV_NEW_FK="custom_field_values_definition_id_fk"
CFV_FK_DEF="FOREIGN KEY (definition_id) REFERENCES custom_field_definitions(id) ON DELETE CASCADE"
CFV_EXPECTED_BEFORE="custom_field_values_company_id_companies_id_fk(46) ${CFV_OLD_FK}(63)"
CFV_EXPECTED_AFTER="custom_field_values_company_id_companies_id_fk(46) ${CFV_NEW_FK}(36)"
cfv_fk_state() { psql_q "select coalesce(string_agg(conname||' | '||pg_get_constraintdef(oid)||' | validated='||convalidated::text||' | on_delete='||confdeltype::text||' on_update='||confupdtype::text, ' ;; ' order by conname),'') from pg_constraint where contype='f' and conrelid='public.custom_field_values'::regclass"; }
# pg_dump spells the same definition schema-qualified (regex form for the DDL diff).
CFV_FK_DEF_DUMP_RE='FOREIGN KEY \(definition_id\) REFERENCES public\.custom_field_definitions\(id\) ON DELETE CASCADE;'
cfv_orphans()  { psql_q "select count(*) from custom_field_values v left join custom_field_definitions d on d.id=v.definition_id where d.id is null"; }

cols_of() { psql_q "select coalesce(string_agg(column_name, ',' order by ordinal_position),'') from information_schema.columns where table_schema='public' and table_name='$1'"; }
idx_of()  { psql_q "select coalesce(string_agg(indexname, ' ' order by indexname),'') from pg_indexes where schemaname='public' and tablename='$1'"; }
fk_of()   { psql_q "select coalesce(string_agg(conname, ' ' order by conname),'') from pg_constraint where contype='f' and conrelid='public.$1'::regclass"; }
exists_of() { psql_q "select coalesce(to_regclass('public.$1')::text,'absent')"; }

umask 077

# ─────────────────────────────────────────────────────────────────────────────
# preflight (read-only)
# ─────────────────────────────────────────────────────────────────────────────
preflight() {
  log "── preflight (read-only) ──"
  log "running as $(id -un) on $(hostname) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [ -d "$APP_DIR/.git" ] || fail "$APP_DIR is not a git checkout"
  cd "$APP_DIR"
  HEAD_SHA="$(git rev-parse HEAD)"
  [ -f "$STATE_DIR/current-deploy.sha" ] || fail "no current-deploy.sha recorded in $STATE_DIR"
  CUR_DEPLOY="$(cat "$STATE_DIR/current-deploy.sha")"
  PREV_DEPLOY="$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null || echo none)"
  log "hosted checkout HEAD      = $HEAD_SHA"
  log "current-deploy.sha        = $CUR_DEPLOY (previous-deploy.sha = $PREV_DEPLOY)"
  [ "$HEAD_SHA" = "$DEPLOYED_SHA" ]   || fail "checkout is at $HEAD_SHA, expected deployed $DEPLOYED_SHA — refusing to touch anything"
  [ "$CUR_DEPLOY" = "$DEPLOYED_SHA" ] || fail "current-deploy.sha is $CUR_DEPLOY, expected $DEPLOYED_SHA"
  [ -z "$(git status --porcelain)" ]  || fail "working tree is unexpectedly dirty"
  # The accepted commit must be reachable (read-only fetch of its branch) and
  # must descend from the deployed commit.
  git fetch --quiet origin "refs/heads/$SRC_BRANCH:refs/remotes/origin/$SRC_BRANCH"
  git cat-file -e "${ACTIVATION_SHA}^{commit}" 2>/dev/null || fail "accepted commit $ACTIVATION_SHA not found after fetching $SRC_BRANCH"
  git merge-base --is-ancestor "$DEPLOYED_SHA" "$ACTIVATION_SHA" || fail "$ACTIVATION_SHA does not descend from deployed $DEPLOYED_SHA"
  log "accepted commit $ACTIVATION_SHA present ($(git log -1 --format='%s' "$ACTIVATION_SHA")); descends from $DEPLOYED_SHA: yes"

  [ -f "$ENV_FILE" ] || fail "runtime env file missing: $ENV_FILE"
  ENV_MODE="$(stat -c '%a' "$ENV_FILE")"
  [ "$ENV_MODE" = "600" ] || fail "$ENV_FILE must be chmod 600 (is $ENV_MODE)"
  [ "$(readlink -f docker/.env)" = "$(readlink -f "$ENV_FILE")" ] || fail "docker/.env does not resolve to $ENV_FILE"
  ENV_HASH_BEFORE="$(sha256sum "$ENV_FILE" | cut -c1-64)"
  DRIVER="$(grep -E '^JOBS_DRIVER=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  KEY_LINES="$(grep -cE '^JOBS_PAYLOAD_ENCRYPTION_KEY=.+' "$ENV_FILE" || true)"
  SMTP_LINES="$(grep -cE '^SMTP_HOST=.+' "$ENV_FILE" || true)"
  GEMINI_LINES="$(grep -cE '^GEMINI_API_KEY=.+' "$ENV_FILE" || true)"
  [ "$DRIVER" = "postgres" ] || fail "JOBS_DRIVER is '${DRIVER:-<unset>}', expected postgres"
  [ "$KEY_LINES" = "1" ] || fail "expected exactly one non-empty JOBS_PAYLOAD_ENCRYPTION_KEY line (found $KEY_LINES)"
  log "env file: mode $ENV_MODE (read-only here); JOBS_DRIVER=postgres; JOBS_PAYLOAD_ENCRYPTION_KEY present (value never read); SMTP_HOST set: $SMTP_LINES; GEMINI_API_KEY set: $GEMINI_LINES"

  cd docker
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
  PG_VOL_MOUNT="$(docker volume inspect -f '{{.Mountpoint}}' "$PG_VOL")"
  compose exec -T postgres sh -c 'exec pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >&2 || fail "pg_isready failed"
  PG_VERSION="$(psql_q "select version()" | cut -d' ' -f1-2)"
  DB_SIZE="$(psql_q "select pg_size_pretty(pg_database_size(current_database()))")"
  log "postgres: $PG_CID healthy, started $PG_STARTED, $PG_VERSION, db size $DB_SIZE"
  log "pgdata volume: $PG_VOL (created $PG_VOL_CREATED, mountpoint $PG_VOL_MOUNT)"
  log "api:      $API_CID healthy, started $API_STARTED, host ports: '$(docker port "$API_CID" | tr '\n' ' ')'"
  log "web:      $WEB_CID healthy, started $WEB_STARTED, ports: $(docker port "$WEB_CID" | tr '\n' ' ')"

  # Schema state
  RUNS_BEFORE="$(exists_of workflow_runs)"; ACTS_BEFORE="$(exists_of workflow_action_runs)"
  SCHEMA_BEFORE="$(psql_q "$SCHEMA_SQL")"
  TABLES_BEFORE="$(printf '%s\n' "$SCHEMA_BEFORE" | grep -c . || true)"
  WD_STATE="$(exists_of workflow_definitions)"
  WD_ROWS="$(psql_q "select count(*) from workflow_definitions" 2>/dev/null || echo n/a)"
  JQ_BEFORE="$(exists_of job_queue)"
  JQ_IDX_BEFORE="$(psql_q "select count(*) from pg_indexes where schemaname='public' and tablename='job_queue'")"
  CFV_FK="$(psql_q "select coalesce(string_agg(conname||'('||length(conname)||')', ' ' order by conname),'') from pg_constraint where contype='f' and conrelid='public.custom_field_values'::regclass")"
  log "db before: public base tables=$TABLES_BEFORE, workflow_definitions=$WD_STATE ($WD_ROWS rows), workflow_runs=$RUNS_BEFORE, workflow_action_runs=$ACTS_BEFORE, job_queue=$JQ_BEFORE ($JQ_IDX_BEFORE indexes)"
  log "custom_field_values FK constraints as stored (name(length)): $CFV_FK"
  CFV_STATE_BEFORE="$(cfv_fk_state)"; CFV_ORPHANS_BEFORE="$(cfv_orphans)"
  CFV_ROWS="$(psql_q "select count(*) from custom_field_values")"; CFD_ROWS="$(psql_q "select count(*) from custom_field_definitions")"
  log "custom_field_values FK state: $CFV_STATE_BEFORE"
  log "custom_field_values rows=$CFV_ROWS, custom_field_definitions rows=$CFD_ROWS, orphaned definition references=$CFV_ORPHANS_BEFORE"
  if [ "$CFV_FK" = "$CFV_EXPECTED_BEFORE" ]; then
    grep -q "$CFV_OLD_FK | $CFV_FK_DEF | validated=true | on_delete=c on_update=a" <<< "$CFV_STATE_BEFORE" || fail "existing truncated FK is not the expected validated definition"
    log "existing FK $CFV_OLD_FK: definition identical to the target, validated=true"
  elif [ "$CFV_FK" = "$CFV_EXPECTED_AFTER" ]; then
    log "custom_field_values FK already renamed to $CFV_NEW_FK (a prior apply completed)"
  else
    fail "custom_field_values FK set is neither the pre- nor the post-correction shape: $CFV_FK"
  fi
  [ "$CFV_ORPHANS_BEFORE" = "0" ] || fail "custom_field_values has $CFV_ORPHANS_BEFORE orphaned definition references — refusing to touch the FK"

  # Durable queue health (from the running api's log + the job_queue table)
  API_LOG="$(docker logs "$API_CID" 2>&1)"
  printf '%s\n' "$API_LOG" | grep -E 'Durable job queue selected|Durable job queue started|Recurring task scheduler started|Background job queue started|Unknown JOBS_DRIVER|requires JOBS_PAYLOAD_ENCRYPTION_KEY|Server listening' >&2 || true
  grep -q 'Durable job queue selected' <<< "$API_LOG" || fail "durable queue NOT selected in the running api"
  grep -q 'Durable job queue started' <<< "$API_LOG"  || fail "durable queue NOT started in the running api"
  grep -qE 'Background job queue started|Unknown JOBS_DRIVER|requires JOBS_PAYLOAD_ENCRYPTION_KEY' <<< "$API_LOG" && fail "api is NOT on the durable driver"
  C_POLL="$(count_in "$API_LOG" 'Job queue poll failed')"; C_HEART="$(count_in "$API_LOG" 'Job lease heartbeat failed')"; C_STATE="$(count_in "$API_LOG" 'Job state update failed')"
  C_ERRLVL="$(count_in "$API_LOG" '"level":50')"
  [ "$C_POLL" = "0" ] && [ "$C_HEART" = "0" ] && [ "$C_STATE" = "0" ] || fail "durable queue errors present (poll=$C_POLL heartbeat=$C_HEART state=$C_STATE)"
  JQ_STATS="$(psql_q "select status||'='||count(*) from job_queue group by status order by 1" | tr '\n' ' ')"
  JQ_LAST="$(psql_q "select coalesce(max(completed_at)::text,'none') from job_queue where status='completed'")"
  JQ_RECENT="$(psql_q "select count(*) from job_queue where status='completed' and completed_at > now() - interval '15 minutes'")"
  JQ_DEAD="$(psql_q "select count(*) from job_queue where status='dead'")"
  log "durable queue: job_queue rows by status: ${JQ_STATS:-none}; last completed: $JQ_LAST; completed in last 15 min: $JQ_RECENT; dead: $JQ_DEAD; api log poll/heartbeat/state errors: $C_POLL/$C_HEART/$C_STATE; error-level lines: $C_ERRLVL"

  health_check
  log "preflight OK"
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

# ─────────────────────────────────────────────────────────────────────────────
# dump: schema-only DDL of the hosted database to stdout (no data)
# ─────────────────────────────────────────────────────────────────────────────
do_dump() {
  cd "$APP_DIR/docker"
  compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --schema-only --no-owner --no-privileges --no-comments'
}

# ─────────────────────────────────────────────────────────────────────────────
# apply: backup → migrate profile at the accepted commit → verify → restore checkout
# ─────────────────────────────────────────────────────────────────────────────
restore_checkout() {
  cd "$APP_DIR"
  if [ "$(git rev-parse HEAD)" != "$DEPLOYED_SHA" ]; then
    log "restoring checkout to deployed $DEPLOYED_SHA"
    git -c advice.detachedHead=false checkout --quiet --detach "$DEPLOYED_SHA"
  fi
}

do_apply() {
  preflight
  cd "$APP_DIR/docker"
  if [ "$RUNS_BEFORE" != "absent" ] || [ "$ACTS_BEFORE" != "absent" ]; then
    log "workflow_runs=$RUNS_BEFORE workflow_action_runs=$ACTS_BEFORE already present — proceeding only if they are EXACTLY the B16 shape (migrate must then be a no-op)"
    [ "$(cols_of workflow_runs)" = "$EXPECTED_RUN_COLS" ] && [ "$(cols_of workflow_action_runs)" = "$EXPECTED_ACT_COLS" ] || fail "pre-existing B16 tables do not match the accepted schema — refusing to guess"
    [ "$(idx_of workflow_runs)" = "$EXPECTED_RUN_IDX" ] && [ "$(idx_of workflow_action_runs)" = "$EXPECTED_ACT_IDX" ] || fail "pre-existing B16 indexes do not match — refusing to guess"
    [ "$(fk_of workflow_runs)" = "$EXPECTED_RUN_FK" ] && [ "$(fk_of workflow_action_runs)" = "$EXPECTED_ACT_FK" ] || fail "pre-existing B16 FK constraints do not match — refusing to guess"
  fi

  # ── backup (first mutation-adjacent step; nothing changed yet) ──
  log "── backup ──"
  START_MARK="$(mktemp)"
  DEPLOY_PATH="$APP_DIR" bash "$APP_DIR/docker/scripts/backup-postgres.sh" >&2 || fail "backup failed — aborting before any change"
  BACKUP_FILE="$(find "$BACKUP_DIR" -maxdepth 1 -name 'leadcapture-*.sql.gz' -newer "$START_MARK" -printf '%f\n' | sort | tail -1)"
  rm -f "$START_MARK"
  [ -n "$BACKUP_FILE" ] || fail "backup script succeeded but no new backup file was found"
  BACKUP_SIZE="$(stat -c '%s' "$BACKUP_DIR/$BACKUP_FILE")"
  [ "$BACKUP_SIZE" -gt 0 ] || fail "backup file is empty"
  BACKUP_LIST="$(ls -1 "$BACKUP_DIR"/leadcapture-*.sql.gz | xargs -n1 basename | tr '\n' ' ')"
  log "backup: $BACKUP_FILE ($BACKUP_SIZE bytes); retained backups: $BACKUP_LIST"

  # ── schema snapshot before ──
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
  # drizzle-kit push executes its statements one by one (no transaction), so the
  # custom_field_values FK is absent between its DROP and the final ADD. The api
  # container is PAUSED (SIGSTOP semantics; not stopped, not recreated) for exactly
  # the seconds the push runs, so no application write can reach the table in that
  # window. The trap guarantees the unpause on any failure.
  API_PAUSED=0
  unpause_api() { if [ "$API_PAUSED" = "1" ]; then docker unpause "$API_CID" >/dev/null 2>&1 && log "api container unpaused"; API_PAUSED=0; fi; }
  trap 'unpause_api; rm -f "$DDL_BEFORE" "$DDL_AFTER"; restore_checkout' EXIT
  ACTIVE_BEFORE="$(psql_q "select count(*) from pg_stat_activity where datname=current_database() and state='active' and pid<>pg_backend_pid()")"
  docker pause "$API_CID" >/dev/null && API_PAUSED=1
  PAUSE_START="$(date +%s.%N)"
  log "api container paused ($API_CID) — active application queries just before the pause: $ACTIVE_BEFORE"
  # -T: no TTY — drizzle-kit cannot prompt, so any data-loss statement it would want
  # confirmation for aborts BEFORE applying. --no-deps: postgres is already running and
  # healthy (verified); a one-off run must never start/recreate it.
  if ! compose --profile migrate run -T --rm --no-deps migrate 2>&1 | tee "$MIGRATE_LOG" >&2; then
    unpause_api; rm -f "$MIGRATE_LOG"; fail "drizzle-kit push failed (see output above)"
  fi
  unpause_api
  PAUSE_SECS="$(awk "BEGIN{printf \"%.1f\", $(date +%s.%N) - $PAUSE_START}")"
  log "api write pause lasted ${PAUSE_SECS}s (container not restarted: StartedAt unchanged)"
  trap 'rm -f "$DDL_BEFORE" "$DDL_AFTER"; restore_checkout' EXIT
  if grep -Eiq 'drop table|drop column|truncate|drop index|data.loss|data loss' "$MIGRATE_LOG"; then
    rm -f "$MIGRATE_LOG"; fail "drizzle-kit output mentions a destructive change — STOP and inspect"
  fi
  grep -q 'Changes applied' "$MIGRATE_LOG" && MIGRATE_RESULT="Changes applied" || MIGRATE_RESULT="$(grep -oE 'No changes detected|\[✓\].*' "$MIGRATE_LOG" | tail -1 || echo 'marker not seen')"
  rm -f "$MIGRATE_LOG"
  log "migrate result: $MIGRATE_RESULT"
  restore_checkout
  cd "$APP_DIR"; [ "$(git rev-parse HEAD)" = "$DEPLOYED_SHA" ] || fail "checkout not restored"; [ -z "$(git status --porcelain)" ] || fail "working tree dirty after restore"
  cd docker

  # ── verify: exactly the B16 objects were added ──
  log "── verify ──"
  do_dump > "$DDL_AFTER"
  log "schema-only DDL after: $(wc -l < "$DDL_AFTER") lines"
  # pg_dump's per-run \restrict/\unrestrict guard tokens are random — ignore them.
  DDL_DIFF="$(diff <(grep -vE '^\\(un)?restrict ' "$DDL_BEFORE") <(grep -vE '^\\(un)?restrict ' "$DDL_AFTER") || true)"
  log "DDL diff (before -> after):"
  printf '%s\n' "${DDL_DIFF:-<no difference>}" >&2
  # Every changed line must belong to the two new tables (their columns, sequences,
  # constraints, indexes). Anything else = unrelated change. Allowed anonymous lines
  # are the column definitions and sequence bodies that pg_dump emits inside the
  # CREATE TABLE / CREATE SEQUENCE blocks of those tables, plus separators.
  # The only permitted non-B16 change is the custom_field_values FK rename: its
  # `-- Name:` header line and its ADD CONSTRAINT line (old name removed, new name
  # added) plus the unchanged `ALTER TABLE ONLY public.custom_field_values` line
  # that pg_dump may re-emit when the block moves.
  BAD="$(printf '%s\n' "$DDL_DIFF" | grep -E '^[<>]' | grep -vE 'workflow_runs|workflow_action_runs' | grep -vE '^[<>]\s*$' | grep -vE "$CFV_OLD_FK|$CFV_NEW_FK" | grep -vE '^[<>] ALTER TABLE ONLY public\.custom_field_values$' | grep -vE '^[<>] (\);|--|    [a-z_]+ (integer|text|jsonb|timestamp)|    (AS integer|START WITH 1|INCREMENT BY 1|NO MINVALUE|NO MAXVALUE|CACHE 1;))' || true)"
  if [ -n "$BAD" ]; then
    log "unrelated DDL changes detected:"; printf '%s\n' "$BAD" >&2
    fail "the migrate changed something other than workflow_runs / workflow_action_runs / the custom_field_values FK rename — STOP"
  fi
  REMOVED="$(printf '%s\n' "$DDL_DIFF" | grep -E '^<' | grep -vE '^<\s*$' | grep -vE "$CFV_OLD_FK" | grep -vE '^< ALTER TABLE ONLY public\.custom_field_values$|^< --$' || true)"
  [ -z "$REMOVED" ] || { printf '%s\n' "$REMOVED" >&2; fail "lines other than the old custom_field_values FK name were REMOVED from the schema DDL — STOP"; }
  OLD_FK_LINES="$(printf '%s\n' "$DDL_DIFF" | grep -cE "^<.*ADD CONSTRAINT $CFV_OLD_FK $CFV_FK_DEF_DUMP_RE" || true)"
  NEW_FK_LINES="$(printf '%s\n' "$DDL_DIFF" | grep -cE "^>.*ADD CONSTRAINT $CFV_NEW_FK $CFV_FK_DEF_DUMP_RE" || true)"
  OTHER_FK_LINES="$(printf '%s\n' "$DDL_DIFF" | grep -E '^[<>].*ADD CONSTRAINT' | grep -vE 'workflow_runs|workflow_action_runs' | grep -vcE "ADD CONSTRAINT ($CFV_OLD_FK|$CFV_NEW_FK) $CFV_FK_DEF_DUMP_RE" || true)"
  log "DDL diff FK rename evidence: old-name ADD CONSTRAINT line removed=$OLD_FK_LINES, new-name ADD CONSTRAINT line added=$NEW_FK_LINES (identical definition text), other constraint lines changed=$OTHER_FK_LINES"
  if [ "$RUNS_BEFORE" = "absent" ]; then
    [ "$OLD_FK_LINES" = "1" ] && [ "$NEW_FK_LINES" = "1" ] && [ "$OTHER_FK_LINES" = "0" ] || fail "the DDL diff does not show exactly the expected FK rename"
  fi

  [ "$(exists_of workflow_runs)" = "workflow_runs" ] || fail "workflow_runs missing after migrate"
  [ "$(exists_of workflow_action_runs)" = "workflow_action_runs" ] || fail "workflow_action_runs missing after migrate"
  RUN_COLS="$(cols_of workflow_runs)"; ACT_COLS="$(cols_of workflow_action_runs)"
  [ "$RUN_COLS" = "$EXPECTED_RUN_COLS" ] || fail "workflow_runs columns differ: $RUN_COLS"
  [ "$ACT_COLS" = "$EXPECTED_ACT_COLS" ] || fail "workflow_action_runs columns differ: $ACT_COLS"
  log "workflow_runs columns OK (19): $RUN_COLS"
  log "workflow_action_runs columns OK (13): $ACT_COLS"
  RUN_IDX="$(idx_of workflow_runs)"; ACT_IDX="$(idx_of workflow_action_runs)"
  [ "$RUN_IDX" = "$EXPECTED_RUN_IDX" ] || fail "workflow_runs indexes differ: $RUN_IDX"
  [ "$ACT_IDX" = "$EXPECTED_ACT_IDX" ] || fail "workflow_action_runs indexes differ: $ACT_IDX"
  psql_q "select tablename||'.'||indexname||' => '||indexdef from pg_indexes where schemaname='public' and tablename in ('workflow_runs','workflow_action_runs') order by 1" >&2
  log "indexes OK: workflow_runs (7 incl. pkey): $RUN_IDX"
  log "indexes OK: workflow_action_runs (3 incl. pkey): $ACT_IDX"
  RUN_FK="$(fk_of workflow_runs)"; ACT_FK="$(fk_of workflow_action_runs)"
  [ "$RUN_FK" = "$EXPECTED_RUN_FK" ] || fail "workflow_runs FK constraints differ: $RUN_FK"
  [ "$ACT_FK" = "$EXPECTED_ACT_FK" ] || fail "workflow_action_runs FK constraints differ: $ACT_FK"
  psql_q "select conrelid::regclass||'.'||conname||' => '||pg_get_constraintdef(oid) from pg_constraint where contype in ('f','p') and conrelid in ('public.workflow_runs'::regclass,'public.workflow_action_runs'::regclass) order by 1" >&2
  log "FK constraints OK: workflow_runs (3): $RUN_FK"
  log "FK constraints OK: workflow_action_runs (2): $ACT_FK"
  SCHEMA_AFTER="$(psql_q "$SCHEMA_SQL")"
  TABLES_AFTER="$(printf '%s\n' "$SCHEMA_AFTER" | grep -c . || true)"
  ADDED=0; [ "$RUNS_BEFORE" = "absent" ] && ADDED=$((ADDED+1)); [ "$ACTS_BEFORE" = "absent" ] && ADDED=$((ADDED+1))
  [ "$TABLES_AFTER" -eq $((TABLES_BEFORE + ADDED)) ] || fail "public table count is $TABLES_AFTER, expected $((TABLES_BEFORE + ADDED))"
  TDIFF="$(diff <(printf '%s\n' "$SCHEMA_BEFORE") <(printf '%s\n' "$SCHEMA_AFTER") || true)"
  log "table(column_count) diff:"; printf '%s\n' "${TDIFF:-<no difference>}" >&2
  [ "$(grep -cE '^<' <<< "$TDIFF" || true)" = "0" ] || fail "a table disappeared or lost columns"
  [ "$(grep -E '^>' <<< "$TDIFF" | grep -vcE '^> workflow_runs\(19\)$|^> workflow_action_runs\(13\)$' || true)" = "0" ] || fail "unrelated table change detected"
  [ "$(exists_of job_queue)" = "job_queue" ] && [ "$(psql_q "select count(*) from pg_indexes where schemaname='public' and tablename='job_queue'")" = "$JQ_IDX_BEFORE" ] || fail "job_queue changed"
  [ "$(psql_q "select count(*) from workflow_definitions")" = "$WD_ROWS" ] || fail "workflow_definitions row count changed"
  CFV_FK_AFTER="$(psql_q "select coalesce(string_agg(conname||'('||length(conname)||')', ' ' order by conname),'') from pg_constraint where contype='f' and conrelid='public.custom_field_values'::regclass")"
  [ "$CFV_FK_AFTER" = "$CFV_EXPECTED_AFTER" ] || fail "custom_field_values FK constraint set after migrate is [$CFV_FK_AFTER], expected [$CFV_EXPECTED_AFTER]"
  CFV_STATE_AFTER="$(cfv_fk_state)"; CFV_ORPHANS_AFTER="$(cfv_orphans)"
  log "custom_field_values FK state after: $CFV_STATE_AFTER"
  grep -q "$CFV_NEW_FK | $CFV_FK_DEF | validated=true | on_delete=c on_update=a" <<< "$CFV_STATE_AFTER" || fail "renamed FK $CFV_NEW_FK is not the identical validated definition"
  grep -q "custom_field_values_company_id_companies_id_fk | FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE | validated=true" <<< "$CFV_STATE_AFTER" || fail "the other custom_field_values FK changed"
  [ "$CFV_ORPHANS_AFTER" = "0" ] || fail "orphaned definition references after migrate: $CFV_ORPHANS_AFTER"
  [ "$(psql_q "select count(*) from custom_field_values")" = "$CFV_ROWS" ] && [ "$(psql_q "select count(*) from custom_field_definitions")" = "$CFD_ROWS" ] || fail "custom field row counts changed"
  LONG_NAMES="$(psql_q "select coalesce(string_agg(conrelid::regclass||'.'||conname||'('||length(conname)||')', ' '),'none') from pg_constraint where length(conname)>=63")"
  [ "$LONG_NAMES" = "workflow_runs.workflow_runs_workflow_definition_id_workflow_definitions_id_fk(63)" ] || fail "unexpected >=63-char constraint names: $LONG_NAMES"
  log "renamed FK OK: $CFV_OLD_FK -> $CFV_NEW_FK, definition '$CFV_FK_DEF', validated, on_delete=cascade on_update=no action, orphans=0, rows unchanged ($CFV_ROWS values / $CFD_ROWS definitions); >=63-char names: $LONG_NAMES (exactly 63, not truncated)"
  RUN_ROWS="$(psql_q "select count(*) from workflow_runs")"; ACT_ROWS="$(psql_q "select count(*) from workflow_action_runs")"
  log "db after: public base tables=$TABLES_AFTER (before $TABLES_BEFORE), workflow_runs rows=$RUN_ROWS, workflow_action_runs rows=$ACT_ROWS, job_queue intact, workflow_definitions rows=$WD_ROWS"

  health_check
  API_LOG2="$(docker logs "$API_CID" 2>&1)"
  C_ERR2="$(count_in "$API_LOG2" '"level":50')"
  log "api (still $DEPLOYED_SHA, untouched): error-level lines before/after = $C_ERRLVL/$C_ERR2"

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
  grep -q '127.0.0.1:18080' <<< "$(docker port "$WEB_CID")" || fail "web is no longer bound to 127.0.0.1:18080"
  [ -z "$(docker port "$API_CID")" ]              || fail "api must not publish any host port"
  [ "$(sha256sum "$ENV_FILE" | cut -c1-64)" = "$ENV_HASH_BEFORE" ] || fail "env file changed"
  [ "$(stat -c '%a' "$ENV_FILE")" = "600" ]       || fail "env file mode changed"
  cd "$APP_DIR"
  [ "$(git rev-parse HEAD)" = "$DEPLOYED_SHA" ]   || fail "checkout not at deployed commit"
  [ -z "$(git status --porcelain)" ]              || fail "working tree dirty"
  [ "$(cat "$STATE_DIR/current-deploy.sha")" = "$DEPLOYED_SHA" ] || fail "current-deploy.sha changed"
  log "postgres unchanged: $PG_CID started $PG_STARTED healthy; volume $PG_VOL created $PG_VOL_CREATED"
  log "api unchanged: $API_CID ($DEPLOYED_SHA) started $API_STARTED healthy — the B16 api starts only through the develop deploy"
  log "web unchanged: $WEB_CID started $WEB_STARTED healthy; env file unchanged (hash + mode 600); checkout back at $DEPLOYED_SHA"
  trap - EXIT; rm -f "$DDL_BEFORE" "$DDL_AFTER"
  log "SUMMARY apply: backup=$BACKUP_FILE backup_bytes=$BACKUP_SIZE migrate='$MIGRATE_RESULT' tables_before=$TABLES_BEFORE tables_after=$TABLES_AFTER workflow_runs=cols19/idx7/fk3 workflow_action_runs=cols13/idx3/fk2 cfv_fk=$CFV_OLD_FK->$CFV_NEW_FK(identical,validated,orphans=0) api_paused_secs=$PAUSE_SECS unrelated_ddl_changes=no readyz='$READYZ_PARSED' api_restarted=no postgres_restarted=no env_changed=no checkout=$DEPLOYED_SHA"
  log "hosted B16 schema activation COMPLETED"
}

# ─────────────────────────────────────────────────────────────────────────────
# smoke: after the develop deploy of ACTIVATION_SHA
# ─────────────────────────────────────────────────────────────────────────────
do_smoke() {
  log "── post-deploy verification ──"
  log "running as $(id -un) on $(hostname) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cd "$APP_DIR"
  HEAD_SHA="$(git rev-parse HEAD)"; CUR_DEPLOY="$(cat "$STATE_DIR/current-deploy.sha")"; PREV_DEPLOY="$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null || echo none)"
  log "hosted checkout HEAD = $HEAD_SHA; current-deploy.sha = $CUR_DEPLOY; previous-deploy.sha = $PREV_DEPLOY"
  [ "$HEAD_SHA" = "$ACTIVATION_SHA" ] && [ "$CUR_DEPLOY" = "$ACTIVATION_SHA" ] || fail "deployed commit is not $ACTIVATION_SHA"
  [ -z "$(git status --porcelain)" ] || fail "working tree dirty"
  [ -f "$ENV_FILE" ] || fail "runtime env file missing"
  ENV_HASH_BEFORE="$(sha256sum "$ENV_FILE" | cut -c1-64)"
  DRIVER="$(grep -E '^JOBS_DRIVER=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  KEY_LINES="$(grep -cE '^JOBS_PAYLOAD_ENCRYPTION_KEY=.+' "$ENV_FILE" || true)"
  SMTP_LINES="$(grep -cE '^SMTP_HOST=.+' "$ENV_FILE" || true)"
  GEMINI_LINES="$(grep -cE '^GEMINI_API_KEY=.+' "$ENV_FILE" || true)"
  [ "$DRIVER" = "postgres" ] || fail "JOBS_DRIVER is '${DRIVER:-<unset>}', expected postgres"
  [ "$KEY_LINES" = "1" ] || fail "JOBS_PAYLOAD_ENCRYPTION_KEY line count $KEY_LINES"
  log "env: JOBS_DRIVER=postgres; encryption key present (value never read); SMTP_HOST set: $SMTP_LINES; GEMINI_API_KEY set: $GEMINI_LINES"
  cd docker
  compose ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}' >&2
  PG_CID="$(cid postgres)"; API_CID="$(cid api)"; WEB_CID="$(cid web)"
  [ "$(health_of "$PG_CID")" = "healthy" ] && [ "$(health_of "$API_CID")" = "healthy" ] && [ "$(health_of "$WEB_CID")" = "healthy" ] || fail "containers not all healthy"
  PG_STARTED="$(started_of "$PG_CID")"; API_STARTED="$(started_of "$API_CID")"; WEB_STARTED="$(started_of "$WEB_CID")"
  PG_VOL="$(pgvol_of "$PG_CID")"; PG_VOL_CREATED="$(docker volume inspect -f '{{.CreatedAt}}' "$PG_VOL")"
  API_IMAGE_SHA="$(docker inspect -f '{{.Image}}' "$API_CID")"
  log "postgres $PG_CID started $PG_STARTED (volume $PG_VOL created $PG_VOL_CREATED); api $API_CID started $API_STARTED image $API_IMAGE_SHA; web $WEB_CID started $WEB_STARTED"

  # ── queue selection + startup recovery evidence (api log since the deploy) ──
  API_LOG="$(docker logs "$API_CID" 2>&1)"
  log "queue selection / scheduler / recovery lines:"
  printf '%s\n' "$API_LOG" | grep -E 'Durable job queue selected|Durable job queue started|Recurring task scheduler started|Background job queue started|Unknown JOBS_DRIVER|requires JOBS_PAYLOAD_ENCRYPTION_KEY|Server listening|recovery|Orphaned workflow run|Email provider is not configured' >&2 || true
  grep -q 'Durable job queue selected' <<< "$API_LOG" || fail "durable queue NOT selected"
  grep -q 'Durable job queue started' <<< "$API_LOG"  || fail "durable queue NOT started"
  grep -qE 'Background job queue started|Unknown JOBS_DRIVER|requires JOBS_PAYLOAD_ENCRYPTION_KEY|"driver":"in-process"' <<< "$API_LOG" && fail "in-process fallback detected"
  grep -q '"driver":"postgres"' <<< "$API_LOG" || fail "durable queue driver line does not say postgres"
  grep -q 'Recurring task scheduler started' <<< "$API_LOG" || fail "scheduler not started"
  C_RECOV_FAIL="$(count_in "$API_LOG" 'workflow run recovery at startup failed')"
  C_REL="$(printf '%s\n' "$API_LOG" | grep -c 'relation "workflow_' || true)"
  C_ORPHAN_FAIL="$(count_in "$API_LOG" 'Orphaned workflow run re-enqueue failed')"
  C_POLL="$(count_in "$API_LOG" 'Job queue poll failed')"; C_HEART="$(count_in "$API_LOG" 'Job lease heartbeat failed')"; C_STATE="$(count_in "$API_LOG" 'Job state update failed')"
  C_ERRLVL="$(count_in "$API_LOG" '"level":50')"
  log "log counters: recovery_failed=$C_RECOV_FAIL relation_missing=$C_REL orphan_reenqueue_failed=$C_ORPHAN_FAIL poll_failed=$C_POLL heartbeat_failed=$C_HEART state_update_failed=$C_STATE error_level_lines=$C_ERRLVL"
  if [ "$C_ERRLVL" != "0" ]; then
    log "error-level messages (first 10):"; printf '%s\n' "$API_LOG" | grep -- '"level":50' | grep -oE '"msg":"[^"]*"' | head -10 >&2 || true
  fi
  [ "$C_RECOV_FAIL" = "0" ] && [ "$C_REL" = "0" ] && [ "$C_ORPHAN_FAIL" = "0" ] || fail "workflow startup recovery reported database errors"
  [ "$C_POLL" = "0" ] && [ "$C_HEART" = "0" ] && [ "$C_STATE" = "0" ] || fail "durable queue errors present"
  Q_LINE="$(printf '%s\n' "$API_LOG" | grep 'Durable job queue started' | head -1)"
  Q_WORKER="$(printf '%s' "$Q_LINE" | grep -oE '"workerId":"[^"]+"' | cut -d'"' -f4 || true)"
  Q_CONC="$(printf '%s' "$Q_LINE" | grep -oE '"concurrency":[0-9]+' | grep -oE '[0-9]+' || true)"
  # Startup recovery ran (and found nothing, or re-enqueued) — the table exists and is readable.
  RUNS_TOTAL="$(psql_q "select count(*) from workflow_runs")"; RUNS_STUCK="$(psql_q "select count(*) from workflow_runs where status in ('queued','running')")"
  log "durable worker: workerId=${Q_WORKER:-?} concurrency=${Q_CONC:-?}; workflow_runs total=$RUNS_TOTAL queued/running=$RUNS_STUCK"
  # The recurring workflowRecovery sweep (first run ~45s after boot, then every 5 min)
  # is dispatched through the durable queue: at least one completed sweep since this
  # api container started, none dead, none with an error.
  RECOV_SQL="select count(*)||'|'||coalesce(max(completed_at)::text,'none')||'|'||coalesce(sum((last_error is not null)::int),0) from job_queue where dedupe_key like 'recurring:workflowRecovery:%' and status='completed' and enqueued_at >= '$(date -u -d "$API_STARTED" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo 1970-01-01T00:00:00Z)'::timestamp - interval '5 seconds'"
  RECOV=""
  for _ in $(seq 1 20); do RECOV="$(psql_q "$RECOV_SQL")"; [ "${RECOV%%|*}" != "0" ] && break; sleep 5; done
  RECOV_DEAD="$(psql_q "select count(*) from job_queue where dedupe_key like 'recurring:workflowRecovery:%' and status='dead'")"
  log "workflowRecovery sweeps through the durable queue since api start (count|last_completed|with_error): $RECOV; dead: $RECOV_DEAD"
  [ "${RECOV%%|*}" != "0" ] || fail "no completed workflowRecovery sweep since the api started"
  [ "${RECOV##*|}" = "0" ] && [ "$RECOV_DEAD" = "0" ] || fail "workflowRecovery sweep reported errors"
  health_check
  WF_PROBE="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$API_URL/workflows/runs")"
  [ "$WF_PROBE" = "401" ] || fail "GET /api/workflows/runs (unauthenticated) answered $WF_PROBE, expected 401"
  log "GET /api/workflows/runs (unauthenticated) -> 401 (run-history route mounted, auth-gated)"

  # ── smoke: isolated disposable tenant through the real API + PostgreSQL queue ──
  log "── smoke ──"
  # Leftovers of an earlier smoke attempt that failed before its cleanup trap was
  # armed (the disposable naming pattern is exact: company 'B16 SMOKE <utc stamp>',
  # user b16-smoke-<stamp>@smoke.invalid). Report and remove them first.
  STALE="$(psql_q "select coalesce(string_agg(id||':'||name||':users='||(select count(*) from users u where u.company_id=c.id), ', ' order by id),'none') from companies c where name ~ '^B16 SMOKE [0-9]{14}$'")"
  log "stale disposable smoke companies from earlier attempts: $STALE"
  if [ "$STALE" != "none" ]; then
    psql_q "begin; delete from audit_logs where company_id in (select id from companies where name ~ '^B16 SMOKE [0-9]{14}$'); delete from login_attempts where email ~ '^b16-smoke-[0-9]{14}@smoke\\.invalid$'; delete from companies where name ~ '^B16 SMOKE [0-9]{14}$'; commit;" >&2
    log "stale disposable smoke companies removed; remaining: $(psql_q "select count(*) from companies where name ~ '^B16 SMOKE [0-9]{14}$'")"
  fi
  STAMP="$(date -u +%Y%m%d%H%M%S)"
  CO_NAME="B16 SMOKE $STAMP"; EMAIL="b16-smoke-$STAMP@smoke.invalid"; TAG_NAME="b16-smoke-$STAMP"; WF_NAME="B16 smoke $STAMP"; LEAD_TITLE="B16 smoke lead $STAMP"
  CID=""; UID_=""; RUN_ID=""; CLEANUP="not-run"
  cleanup_smoke() {
    [ -n "$CID" ] || { log "cleanup: no disposable company was created"; CLEANUP="nothing-created"; return 0; }
    log "── cleanup (exact disposable rows only) ──"
    psql_q "begin; delete from audit_logs where company_id=$CID; delete from login_attempts where email='$EMAIL'; delete from companies where id=$CID; commit;" >&2 || log "cleanup transaction failed"
    LEFT=""
    for spec in "companies:id=$CID" "users:email='$EMAIL'" "users:company_id=$CID" "leads:company_id=$CID" "workflow_runs:company_id=$CID" "workflow_action_runs:company_id=$CID" "workflow_definitions:company_id=$CID" "tags:company_id=$CID" "lead_tags:company_id=$CID" "pipeline_stages:company_id=$CID" "lead_activities:company_id=$CID" "audit_logs:company_id=$CID" "notifications:company_id=$CID" "sessions:user_id=${UID_:-0}" "login_attempts:email='$EMAIL'"; do
      t="${spec%%:*}"; w="${spec#*:}"
      n="$(psql_q "select count(*) from $t where $w")"
      [ "$n" = "0" ] || LEFT="$LEFT $t($n)"
    done
    if [ -n "$LEFT" ]; then log "rows still present after cleanup:$LEFT"; CLEANUP="incomplete:$LEFT"; else log "cleanup verified: 0 rows left for company $CID / user $UID_ / $EMAIL"; CLEANUP="complete"; fi
    JOBROW_LEFT="$(psql_q "select coalesce(string_agg(id||':'||status, ','),'none') from job_queue where dedupe_key like 'workflow.run:${RUN_ID:-0}:%'")"
    log "job_queue row(s) of the smoke run left in place (completed, inert; queue table not modified): $JOBROW_LEFT"
  }
  trap 'cleanup_smoke' EXIT
  PW="$(openssl rand -hex 24)"
  HASH="$(docker exec -e PW="$PW" "$API_CID" node -e 'import("bcryptjs").then((m) => process.stdout.write((m.default || m).hashSync(process.env.PW, 10)))')"
  [ -n "$HASH" ] || fail "could not hash the disposable password inside the api container"
  CID="$(psql_q "insert into companies (name, status) values ('$CO_NAME', 'active') returning id")"
  [ -n "$CID" ] && [ "$CID" -gt 0 ] 2>/dev/null || fail "could not create the disposable company (got '$CID')"
  UID_="$(psql_q "insert into users (email, password_hash, name, role, company_id, permissions) values ('$EMAIL', '$HASH', 'B16 Smoke Admin', 'primary_admin', $CID, '{}'::jsonb) returning id")"
  [ -n "$UID_" ] && [ "$UID_" -gt 0 ] 2>/dev/null || fail "could not create the disposable user (got '$UID_')"
  unset HASH
  log "disposable tenant: company id=$CID '$CO_NAME', user id=$UID_ ($EMAIL, primary_admin) — password generated on the VPS, never printed"

  LOGIN_RAW="$(curl -sS --max-time 20 -w '\n%{http_code}' -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" "$API_URL/auth/login")"
  unset PW
  LOGIN_CODE="${LOGIN_RAW##*$'\n'}"; LOGIN_BODY="${LOGIN_RAW%$'\n'*}"
  [ "$LOGIN_CODE" = "200" ] || fail "login HTTP $LOGIN_CODE"
  TOKEN="$(printf '%s' "$LOGIN_BODY" | json_get token)"
  [ -n "$TOKEN" ] || fail "login did not return a token (mfaRequired=$(printf '%s' "$LOGIN_BODY" | json_get mfaRequired))"
  unset LOGIN_BODY LOGIN_RAW
  log "login -> HTTP 200, session token obtained (never printed)"
  api() { # method path [json-body] -> sets API_CODE, API_BODY
    local raw
    if [ -n "${3:-}" ]; then
      raw="$(curl -sS --max-time 30 -w '\n%{http_code}' -X "$1" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$3" "$API_URL$2")"
    else
      raw="$(curl -sS --max-time 30 -w '\n%{http_code}' -X "$1" -H "Authorization: Bearer $TOKEN" "$API_URL$2")"
    fi
    API_CODE="${raw##*$'\n'}"; API_BODY="${raw%$'\n'*}"
  }
  api POST /tags "{\"name\":\"$TAG_NAME\"}"; [ "$API_CODE" = "201" ] || fail "POST /tags -> $API_CODE $API_BODY"
  TAG_ID="$(printf '%s' "$API_BODY" | json_get id)"
  api POST /workflows "{\"name\":\"$WF_NAME\",\"trigger\":{\"type\":\"lead.created\"},\"conditions\":[],\"actions\":[{\"type\":\"lead.add_tag\",\"config\":{\"tagId\":$TAG_ID}}]}"
  [ "$API_CODE" = "201" ] || fail "POST /workflows -> $API_CODE $API_BODY"
  DEF_ID="$(printf '%s' "$API_BODY" | json_get id)"; DEF_REV="$(printf '%s' "$API_BODY" | json_get revision)"
  api POST "/workflows/$DEF_ID/publish" "{\"revision\":$DEF_REV}"; [ "$API_CODE" = "200" ] || fail "publish -> $API_CODE $API_BODY"
  PUB_REV="$(printf '%s' "$API_BODY" | json_get revision)"; PUB_STATUS="$(printf '%s' "$API_BODY" | json_get status)"
  [ "$PUB_STATUS" = "published" ] || fail "definition status is $PUB_STATUS"
  log "definition id=$DEF_ID '$WF_NAME' published (revision $PUB_REV): trigger lead.created -> action lead.add_tag(tagId=$TAG_ID)"

  AI_BEFORE="$(psql_q "select count(*) from ai_invocations")"
  MAIL_SENT_BEFORE="$(count_in "$(docker logs "$API_CID" 2>&1)" 'Email sent')"
  MAIL_SKIP_BEFORE="$(count_in "$(docker logs "$API_CID" 2>&1)" 'Email not sent')"
  JOBQ_WF_BEFORE="$(psql_q "select count(*) from job_queue where name='workflow.run'")"

  api POST /leads "{\"title\":\"$LEAD_TITLE\",\"value\":1}"; [ "$API_CODE" = "201" ] || fail "POST /leads -> $API_CODE $API_BODY"
  LEAD_ID="$(printf '%s' "$API_BODY" | json_get id)"
  # Durable rows must exist the moment the response returned (persisted inside the lead's transaction).
  RUN_ROW="$(psql_q "select id||'|'||status||'|'||definition_revision||'|'||enqueue_generation||'|'||event_key from workflow_runs where company_id=$CID and workflow_definition_id=$DEF_ID")"
  [ -n "$RUN_ROW" ] || fail "no workflow_runs row for the lead immediately after POST /leads"
  RUN_ID="${RUN_ROW%%|*}"
  ACT_ROW="$(psql_q "select action_index||'|'||action_type||'|'||status||'|'||attempts from workflow_action_runs where run_id=$RUN_ID order by action_index")"
  log "POST /leads -> 201 lead id=$LEAD_ID; immediately: workflow_runs (id|status|revision|generation|event_key) = $RUN_ROW; workflow_action_runs (index|type|status|attempts) = $ACT_ROW"
  [ "$(printf '%s\n' "$ACT_ROW" | grep -c .)" = "1" ] || fail "expected exactly one action row"

  FINAL=""
  for _ in $(seq 1 45); do
    api GET "/workflows/runs/$RUN_ID"; [ "$API_CODE" = "200" ] || fail "GET /workflows/runs/$RUN_ID -> $API_CODE"
    FINAL="$(printf '%s' "$API_BODY" | json_get status)"
    case "$FINAL" in completed|failed) break;; esac
    sleep 2
  done
  [ "$FINAL" = "completed" ] || fail "run $RUN_ID ended as '$FINAL' ($(printf '%s' "$API_BODY" | json_get error))"
  RUN_DETAIL="$API_BODY"
  R_NAME="$(printf '%s' "$RUN_DETAIL" | json_get workflowName)"; R_REV="$(printf '%s' "$RUN_DETAIL" | json_get definitionRevision)"
  R_SUM="$(printf '%s' "$RUN_DETAIL" | json_get actionSummary)"; R_GEN="$(printf '%s' "$RUN_DETAIL" | json_get enqueueGeneration)"
  R_A_STATUS="$(printf '%s' "$RUN_DETAIL" | json_get actions.0.status)"; R_A_ATT="$(printf '%s' "$RUN_DETAIL" | json_get actions.0.attempts)"; R_A_RES="$(printf '%s' "$RUN_DETAIL" | json_get actions.0.result)"
  log "run history (GET /workflows/runs/$RUN_ID): status=$FINAL workflowName='$R_NAME' definitionRevision=$R_REV enqueueGeneration=$R_GEN actionSummary=$R_SUM action[0]={status:$R_A_STATUS,attempts:$R_A_ATT,result:$R_A_RES}"
  [ "$R_NAME" = "$WF_NAME" ] || fail "workflowName mismatch"
  [ "$R_REV" = "$PUB_REV" ] || fail "definitionRevision $R_REV != published $PUB_REV"
  [ "$R_SUM" = '{"total":1,"completed":1,"skipped":0,"failed":0}' ] || fail "actionSummary $R_SUM"
  [ "$R_A_STATUS" = "completed" ] && [ "$R_A_ATT" = "1" ] || fail "action not completed exactly once"
  grep -qE "\"tagId\":$TAG_ID([,}])" <<< "$R_A_RES" || fail "action result does not reference tag $TAG_ID"
  SNAP="$(psql_q "select (definition_snapshot->>'name')||' | trigger='||(definition_snapshot->'trigger'->>'type')||' | actions='||jsonb_array_length(definition_snapshot->'actions')||' | action0='||(definition_snapshot->'actions'->0->>'type')||' | conditions='||jsonb_array_length(coalesce(definition_snapshot->'conditions','[]'::jsonb)) from workflow_runs where id=$RUN_ID")"
  log "definition_snapshot: $SNAP"
  [ "$SNAP" = "$WF_NAME | trigger=lead.created | actions=1 | action0=lead.add_tag | conditions=0" ] || fail "definition snapshot mismatch"
  DBRUN="$(psql_q "select status||'|'||coalesce(error::text,'<null>')||'|'||(started_at is not null)||'|'||(completed_at is not null)||'|'||(lock_expires_at is null) from workflow_runs where id=$RUN_ID")"
  log "workflow_runs row: status|error|started|completed|lock_released = $DBRUN"
  [ "$DBRUN" = "completed|<null>|true|true|true" ] || fail "workflow_runs row not in the expected terminal state"
  TAG_COUNT="$(psql_q "select count(*) from lead_tags where lead_id=$LEAD_ID and tag_id=$TAG_ID")"; TAG_ALL="$(psql_q "select count(*) from lead_tags where lead_id=$LEAD_ID")"
  RUNS_FOR_DEF="$(psql_q "select count(*) from workflow_runs where workflow_definition_id=$DEF_ID")"
  log "exactly-once: lead_tags(lead=$LEAD_ID,tag=$TAG_ID)=$TAG_COUNT (all tags on lead: $TAG_ALL); workflow_runs for definition=$RUNS_FOR_DEF"
  [ "$TAG_COUNT" = "1" ] && [ "$TAG_ALL" = "1" ] && [ "$RUNS_FOR_DEF" = "1" ] || fail "action did not execute exactly once"
  JOBROW="$(psql_q "select id||'|'||status||'|'||attempts||'|'||max_attempts||'|'||coalesce(worker_id,'<null>')||'|'||coalesce(last_error,'<null>')||'|'||left(payload,5)||'|'||(position('workflow' in payload)=0)::text||'|'||coalesce(dedupe_key,'<null>') from job_queue where name='workflow.run' and dedupe_key='workflow.run:$RUN_ID:1'")"
  log "durable job (job_queue: id|status|attempts|max|worker|last_error|payload_prefix|no_plaintext|dedupe_key) = $JOBROW"
  [ -n "$JOBROW" ] || fail "no workflow.run job row for run $RUN_ID"
  J_STATUS="$(printf '%s' "$JOBROW" | cut -d'|' -f2)"; J_ATT="$(printf '%s' "$JOBROW" | cut -d'|' -f3)"; J_WORKER="$(printf '%s' "$JOBROW" | cut -d'|' -f5)"; J_ERR="$(printf '%s' "$JOBROW" | cut -d'|' -f6)"; J_PREFIX="$(printf '%s' "$JOBROW" | cut -d'|' -f7)"; J_NOPLAIN="$(printf '%s' "$JOBROW" | cut -d'|' -f8)"
  [ "$J_STATUS" = "completed" ] && [ "$J_ATT" = "1" ] && [ "$J_WORKER" != "<null>" ] && [ "$J_ERR" = "<null>" ] || fail "job row not completed exactly once by a worker"
  [ "$J_PREFIX" = "gcm1." ] && [ "$J_NOPLAIN" = "true" ] || fail "job payload is not an encrypted envelope"
  JOBQ_WF_AFTER="$(psql_q "select count(*) from job_queue where name='workflow.run'")"
  [ "$JOBQ_WF_AFTER" = "$((JOBQ_WF_BEFORE + 1))" ] || fail "workflow.run job rows went $JOBQ_WF_BEFORE -> $JOBQ_WF_AFTER (expected +1)"
  API_LOG2="$(docker logs "$API_CID" 2>&1)"
  L_PERSIST="$(printf '%s\n' "$API_LOG2" | grep "\"runId\":$RUN_ID," | grep -c 'Workflow run persisted' || true)"
  L_QUEUED="$(printf '%s\n' "$API_LOG2" | grep "\"runId\":$RUN_ID," | grep -c '"Workflow run queued"' || true)"
  L_STARTED="$(printf '%s\n' "$API_LOG2" | grep "\"runId\":$RUN_ID," | grep -c '"Workflow run started"' || true)"
  L_DONE="$(printf '%s\n' "$API_LOG2" | grep "\"runId\":$RUN_ID," | grep -c '"Workflow run completed"' || true)"
  log "api log for runId=$RUN_ID: persisted=$L_PERSIST queued=$L_QUEUED started=$L_STARTED completed=$L_DONE (job worker: ${J_WORKER})"
  [ "$L_PERSIST" = "1" ] && [ "$L_QUEUED" = "1" ] && [ "$L_STARTED" = "1" ] && [ "$L_DONE" = "1" ] || fail "run log lines are not exactly once each"
  AI_AFTER="$(psql_q "select count(*) from ai_invocations")"; AI_CO="$(psql_q "select count(*) from ai_invocations where company_id=$CID")"
  MAIL_SENT_AFTER="$(count_in "$API_LOG2" 'Email sent')"; MAIL_SKIP_AFTER="$(count_in "$API_LOG2" 'Email not sent')"
  NOTIF="$(psql_q "select count(*) from notifications where company_id=$CID")"
  log "no AI / no email: ai_invocations total $AI_BEFORE -> $AI_AFTER (company $CID: $AI_CO); 'Email sent' log lines $MAIL_SENT_BEFORE -> $MAIL_SENT_AFTER; 'Email not sent' $MAIL_SKIP_BEFORE -> $MAIL_SKIP_AFTER; notifications for company: $NOTIF"
  [ "$AI_AFTER" = "$AI_BEFORE" ] && [ "$AI_CO" = "0" ] || fail "an AI invocation was recorded during the smoke"
  [ "$MAIL_SENT_AFTER" = "$MAIL_SENT_BEFORE" ] && [ "$MAIL_SKIP_AFTER" = "$MAIL_SKIP_BEFORE" ] || fail "an email send was attempted during the smoke"
  C_ERRLVL2="$(count_in "$API_LOG2" '"level":50')"
  log "api error-level lines before/after smoke: $C_ERRLVL/$C_ERRLVL2"
  api POST /auth/logout ""; log "logout -> HTTP $API_CODE"
  unset TOKEN
  trap - EXIT
  cleanup_smoke

  log "── preservation ──"
  [ "$(cid postgres)" = "$PG_CID" ] && [ "$(started_of "$PG_CID")" = "$PG_STARTED" ] && [ "$(health_of "$PG_CID")" = "healthy" ] || fail "postgres changed/restarted"
  [ "$(pgvol_of "$PG_CID")" = "$PG_VOL" ] && [ "$(docker volume inspect -f '{{.CreatedAt}}' "$PG_VOL")" = "$PG_VOL_CREATED" ] || fail "pgdata volume changed"
  [ "$(cid api)" = "$API_CID" ] && [ "$(started_of "$API_CID")" = "$API_STARTED" ] && [ "$(health_of "$API_CID")" = "healthy" ] || fail "api changed/restarted"
  [ "$(cid web)" = "$WEB_CID" ] && [ "$(started_of "$WEB_CID")" = "$WEB_STARTED" ] && [ "$(health_of "$WEB_CID")" = "healthy" ] || fail "web changed/restarted"
  grep -q '127.0.0.1:18080' <<< "$(docker port "$WEB_CID")" || fail "web binding changed"
  [ -z "$(docker port "$API_CID")" ] || fail "api publishes a host port"
  [ "$(sha256sum "$ENV_FILE" | cut -c1-64)" = "$ENV_HASH_BEFORE" ] && [ "$(stat -c '%a' "$ENV_FILE")" = "600" ] || fail "env file changed"
  cd "$APP_DIR"; [ "$(git rev-parse HEAD)" = "$ACTIVATION_SHA" ] && [ -z "$(git status --porcelain)" ] && [ "$(cat "$STATE_DIR/current-deploy.sha")" = "$ACTIVATION_SHA" ] || fail "checkout/deploy state changed"
  log "postgres unchanged ($PG_CID, volume $PG_VOL created $PG_VOL_CREATED); api/web unchanged; env file unchanged; deployed $ACTIVATION_SHA"
  log "SUMMARY smoke: deployed=$ACTIVATION_SHA driver=postgres worker=${Q_WORKER:-?} concurrency=${Q_CONC:-?} recovery_errors=0 readyz='$READYZ_PARSED' run_id=$RUN_ID run_status=$FINAL action_attempts=$R_A_ATT tag_rows=$TAG_COUNT job_status=$J_STATUS job_attempts=$J_ATT ai_delta=$((AI_AFTER - AI_BEFORE)) email_delta=$((MAIL_SENT_AFTER - MAIL_SENT_BEFORE)) cleanup=$CLEANUP"
  log "hosted B16 smoke COMPLETED"
}

case "$CMD" in
  preflight) preflight ;;
  dump)      do_dump ;;
  apply)     do_apply ;;
  smoke)     do_smoke ;;
  *) fail "unknown command $CMD" ;;
esac
