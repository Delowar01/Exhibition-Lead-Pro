#!/bin/bash
# =============================================================================
# TEMPORARY — B19/B20 gated hosted activation phases (dev VPS). Run over SSH by
# .github/workflows/b20-hosted-activation.yml as the deploy user.
#   preflight  : STRICTLY READ-ONLY (psql sessions pinned to
#                default_transaction_read_only=on; pg_dump -s; docker inspect).
#                Never reads secret values (only key presence / non-secret values),
#                never prints names, emails (except the operator-supplied lookup
#                key), password hashes, tokens or provider identifier values.
#   migrate    : the controlled apply — preconditions (deployed commit, clean
#                checkout, billing disabled, schema fingerprint = rehearsed F0,
#                data state = preflight) → build the two migrate images from
#                isolated worktrees (artifacts before any downtime) → fresh
#                standard backup + integrity checks → STOP the API writers →
#                stage-1 schema (statements classified against the rehearsal) →
#                repair dry-run gated against the company authority → apply →
#                zero-change verify → stage-2 schema → constraint verification →
#                repeat push "No changes detected". Every gate aborts the run and
#                leaves the API STOPPED (the old API is incompatible with the final
#                schema; nothing is restored automatically).
#   postdeploy : read-only verification after the deploy workflow.
# Expected values come from the local rehearsal on the schema-only hosted dump:
#   F0 e839d03d928fa46c20797329d2779e3e  (hosted schema before)
#   F1 4f5776f7421880daf2d453b7466b6ffb  (after stage 1, 39 statements)
#   F2 ce55dfa2959cc89c2baad2923217842a  (after stage 2, 27 statements)
# =============================================================================
set -euo pipefail
set +x

APP_DIR="${DEPLOY_PATH:-/opt/lead-capture-pro/app}"
STATE_DIR="${STATE_DIR:-/opt/lead-capture-pro/env}"
ENV_FILE="$STATE_DIR/.env"
PHASE="${PHASE:?PHASE is required}"
ARG1="${ARG1:-}"; ARG2="${ARG2:-}"; ARG3="${ARG3:-}"

log()  { echo "[b20:$PHASE] $*" >&2; }
fail() { echo "[b20:$PHASE] ERROR: $*" >&2; exit 1; }
section() { echo; echo "== $* =="; }
compose() { docker compose -f docker-compose.yml -f compose.vps.yml "$@"; }
# Read-only SQL (session pinned read-only) — used by every inspection.
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

cd "$APP_DIR/docker"
PG_CID="$(compose ps -q postgres)"; [ -n "$PG_CID" ] || fail "postgres container not found"
API_CID="$(compose ps -q api || true)"

phase_preflight() {
  section "read-only guard"
  if q "create temp table b20_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard did not hold"; else echo "session refuses writes (default_transaction_read_only=on): OK"; fi

  section "hosted checkout / deploy state"
  echo "HEAD=$(git -C "$APP_DIR" rev-parse HEAD)"
  echo "HEAD_committed=$(git -C "$APP_DIR" log -1 --format=%cI)"
  echo "dirty_entries=$(git -C "$APP_DIR" status --porcelain | wc -l)"
  echo "current-deploy.sha=$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null || echo none)"
  echo "previous-deploy.sha=$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null || echo none)"
  echo "worktrees=$(git -C "$APP_DIR" worktree list | wc -l)"

  section "env file (mode / owner / size / sha256 prefix — values never printed)"
  echo "$(stat -c 'mode=%a owner=%U:%G size=%s mtime=%y' "$ENV_FILE")"
  echo "sha256_prefix=$(sha256sum "$ENV_FILE" | cut -c1-16)"
  for k in COMPOSE_PROFILES JOBS_DRIVER NODE_ENV BILLING_PROVIDER BILLING_SELF_SERVICE_CHECKOUT BILLING_STRIPE_MODE; do envkey "$k" yes; done
  for k in BILLING_RETURN_URL APP_BASE_URL STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_BILLING_PORTAL_CONFIGURATION_ID DATABASE_URL SESSION_SECRET GOOGLE_APPLICATION_CREDENTIALS SMTP_HOST GEMINI_API_KEY; do envkey "$k"; done

  section "containers (postgres / api / web)"
  for svc in postgres api web; do
    cid="$(compose ps -q "$svc" || true)"
    if [ -z "$cid" ]; then echo "$svc: absent"; continue; fi
    docker inspect -f "$svc: id={{.Id}} image={{.Config.Image}} created={{.Created}} started={{.State.StartedAt}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}" "$cid"
  done
  echo "postgres mounts: $(docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Name}}->{{.Destination}} {{end}}' "$PG_CID")"
  for v in $(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$PG_CID"); do docker volume inspect -f "volume $v: created={{.CreatedAt}} driver={{.Driver}}" "$v"; done
  echo "readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE)"
  echo "healthz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/healthz || echo UNAVAILABLE)"

  section "database (counts / size / fingerprint)"
  q "select 'server='||version()"
  q "select 'tables='||(select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')||' indexes='||(select count(*) from pg_indexes where schemaname='public')||' constraints='||(select count(*) from pg_constraint where connamespace='public'::regnamespace)||' size='||pg_size_pretty(pg_database_size(current_database()))"
  echo "schema_fingerprint=$(fingerprint)"
  q "select 'plans='||(select count(*) from plans)||' subscriptions='||(select count(*) from subscriptions)||' companies='||(select count(*) from companies)||' users='||(select count(*) from users)||' users_active='||(select count(*) from users where deleted_at is null and is_active)"

  section "durable queue"
  JOBS_TABLE="$(q "select coalesce(string_agg(table_name, ','), 'none') from information_schema.tables where table_schema='public' and table_name ~ 'job'")"
  echo "job tables: $JOBS_TABLE"
  for t in $(echo "$JOBS_TABLE" | tr ',' ' '); do
    [ "$t" = "none" ] && continue
    q "select '$t: '||coalesce(string_agg(status||'='||n, ' '), 'empty') from (select status, count(*) n from $t group by status order by status) s" || true
    q "select '$t dead_last_7d='||count(*) from $t where status='dead' and dead_at > now() - interval '7 days'" 2>/dev/null || true
  done
  if [ -n "$API_CID" ]; then
    echo "api log (last 48h) — queue/scheduler/recovery lines:"
    docker logs --since 48h "$API_CID" 2>&1 | grep -iE '"driver"|durable|recovery|sweep|dead|worker' | grep -viE 'authorization|token|secret|password' | tail -25 | cut -c1-220 || true
    echo "api log error-level lines (last 48h): $(docker logs --since 48h "$API_CID" 2>&1 | grep -c '"level":50' || true)"
    docker logs --since 48h "$API_CID" 2>&1 | grep '"level":50' | tail -5 | cut -c1-220 || true
  fi

  section "plans (id | name | price_monthly | currency | limits… | trial_days | sort | active)"
  q "select id||' | '||name||' | '||coalesce(price_monthly::text,'null')||' | '||coalesce(currency,'null')||' | '||coalesce(admins_limit::text,'null')||'/'||coalesce(employees_limit::text,'null')||'/'||coalesce(contacts_limit::text,'null')||'/'||coalesce(events_limit::text,'null')||'/'||coalesce(storage_limit_mb::text,'null')||' | '||trial_days||' | '||sort_order||' | '||is_active from plans order by sort_order, id" || echo "(no plans rows)"

  section "companies / subscriptions (ids and states only — no names)"
  q "select 'company '||c.id||': status='||coalesce(c.status,'<null>')||' plan='||coalesce(c.plan,'<null>')||' trial_ends_at='||coalesce(c.trial_ends_at::text,'null')||' created='||c.created_at::date||' users='||(select count(*) from users u where u.company_id=c.id and u.deleted_at is null)||' | subscription: '||coalesce((select 'id='||s.id||' status='||s.status||' plan='||s.plan||' trial_ends_at='||coalesce(s.trial_ends_at::text,'null')||' renewal='||coalesce(s.renewal_date::text,'null')||' stripe_customer='||(s.stripe_customer_id is not null)||' stripe_sub='||(s.stripe_subscription_id is not null)||' updated='||s.updated_at::date from subscriptions s where s.company_id=c.id limit 1),'NONE') from companies c order by c.id"
  q "select 'companies_without_subscription='||count(*) from companies c left join subscriptions s on s.company_id=c.id where s.id is null"
  q "select 'duplicate_subscriptions='||count(*) from (select company_id from subscriptions group by company_id having count(*)>1) d"
  q "select 'orphan_subscriptions='||count(*) from subscriptions s left join companies c on c.id=s.company_id where c.id is null"
  q "select 'subscriptions_with_provider_ids='||count(*) from subscriptions where stripe_customer_id is not null or stripe_subscription_id is not null"
  q "select 'unknown_company_plans='||count(*) from companies where plan not in ('free','starter','professional','business','enterprise')"
  q "select 'unknown_subscription_plans='||count(*) from subscriptions where plan not in ('free','starter','professional','business','enterprise')"
  q "select 'unknown_company_statuses='||count(*) from companies where status not in ('trial','active','suspended','expired','cancelled','trialing','past_due')"
  q "select 'unknown_subscription_statuses='||count(*) from subscriptions where status not in ('trial','active','suspended','expired','cancelled','trialing','past_due')"
  q "select 'status_drift(company!=subscription)='||count(*) from companies c join subscriptions s on s.company_id=c.id where c.status is distinct from s.status"
  q "select 'plan_drift(company!=subscription)='||count(*) from companies c join subscriptions s on s.company_id=c.id where c.plan is distinct from s.plan"
  q "select 'trial_end_drift='||count(*) from companies c join subscriptions s on s.company_id=c.id where c.trial_ends_at::date is distinct from s.trial_ends_at::date"

  section "access baseline (company authority: companies.status decides access before B20)"
  q "select 'company '||id||': legacy_status='||status||' -> pre-B20 access='||case when status='active' then 'full' when status='trial' and (trial_ends_at is null or trial_ends_at > now()) then 'full(trial)' when status='trial' then 'blocked(trial lapsed)' when status='suspended' then 'blocked' else status end from companies order by id"

  if [ -n "$ARG1" ]; then
    section "operator-supplied account lookup (ids / role / flags only)"
    q "select 'user_id='||u.id||' role='||u.role||' active='||u.is_active||' deleted='||(u.deleted_at is not null)||' company_id='||coalesce(u.company_id::text,'null')||' company_status='||coalesce(c.status,'?')||' company_plan='||coalesce(c.plan,'?')||' company_trial_ends_at='||coalesce(c.trial_ends_at::text,'null')||' subscription_status='||coalesce(s.status,'NONE')||' subscription_plan='||coalesce(s.plan,'NONE') from users u left join companies c on c.id=u.company_id left join subscriptions s on s.company_id=c.id where lower(u.email)=lower('$ARG1')" || echo "lookup failed"
  fi

  section "schema-only dump (pg_dump -s, gzip, hex re-mapped to letters g-v — no data rows)"
  # Letters-only encoding: the Actions log masker rewrites any substring equal to a
  # secret value (e.g. the numeric SSH port), which corrupts base64. Decode with:
  #   tr 'g-v' '0-9a-f' | xxd -r -p | gunzip
  DUMP="$(compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" --schema-only --no-owner --no-privileges "$POSTGRES_DB"' | gzip -9 | od -An -v -tx1 | tr -d ' \n' | tr '0-9a-f' 'g-v')"
  echo "dump_chars=${#DUMP}"
  [ "${#DUMP}" -le 600000 ] || fail "schema dump unexpectedly large; not printing"
  echo "-----BEGIN B20 SCHEMA DUMP-----"
  echo "$DUMP" | fold -w 76
  echo "-----END B20 SCHEMA DUMP-----"
  log "preflight complete (read-only)"
}

STAGE1_SHA=4f42931d1d5270d0731b9e7461ca1685c5f74cf7
STAGE2_SHA=054b207a3e5bd92d822549e8bcbe61098c26acc5
BASE_SHA=c2cd4674977ce517e9ffd8ec7f50688613864dad
EXPECT_F0="${ARG1:-e839d03d928fa46c20797329d2779e3e}"
EXPECT_F1="${ARG2:-4f5776f7421880daf2d453b7466b6ffb}"
EXPECT_F2="${ARG3:-ce55dfa2959cc89c2baad2923217842a}"
# Literal accepted fingerprint for phases whose ARG1..3 carry other arguments (supp-*).
F2_CONST=ce55dfa2959cc89c2baad2923217842a
WT_ROOT="$HOME/b20-worktrees"
STAGE="init"
classify() { grep -E "^(ALTER|CREATE|DROP|TRUNCATE|DELETE|UPDATE|INSERT)" "$1" | sed -E 's/^(ALTER TABLE "[a-z_]+" (ADD COLUMN|ALTER COLUMN|ADD CONSTRAINT "[a-z_]+" (CHECK|FOREIGN KEY|UNIQUE|PRIMARY KEY)|DROP [A-Z]+|RENAME)|CREATE (TABLE|INDEX|UNIQUE INDEX)|DROP [A-Z ]+|[A-Z]+).*/\1/' | sort | uniq -c; }
destructive_count() { grep -ciE '^(drop|.*rename|truncate|delete|update |insert|alter table "[a-z_]+" alter column "[a-z_]+" (set data type|drop not null|set not null|drop default))' "$1" || true; }
on_abort() { local rc=$?; [ $rc -eq 0 ] && return; echo; echo "!!!! MIGRATE ABORTED at stage '$STAGE' (exit $rc). API writers: $(compose ps --status running api --format '{{.Name}}' 2>/dev/null | grep -q . && echo RUNNING || echo STOPPED). Nothing was restored automatically. Schema fingerprint now: $(fingerprint 2>/dev/null || echo unknown)" >&2; }
# run_in_image <image> <shell command> — env from the runtime env file (never printed),
# attached to the postgres network so DATABASE_URL resolves exactly as for the app.
run_in_image() { local img="$1"; shift; docker run --rm --network "$PG_NET" --env-file "$ENV_FILE" --entrypoint sh "$img" -c "$*" </dev/null; }
snapshot_rows() {
  q "select 'company '||c.id||': status='||coalesce(c.status,'<null>')||' plan='||coalesce(c.plan,'<null>')||' trial_ends_at='||coalesce(c.trial_ends_at::text,'null')||' | sub: '||coalesce((select 'id='||s.id||' status='||s.status||' plan='||s.plan||' trial_ends_at='||coalesce(s.trial_ends_at::text,'null')||' stripe='||(s.stripe_customer_id is not null or s.stripe_subscription_id is not null) from subscriptions s where s.company_id=c.id limit 1),'NONE') from companies c order by c.id"
}
jsonnum() { grep -oE "\"$2\": [0-9]+" "$1" | head -1 | grep -oE '[0-9]+'; }

phase_migrate() {
  trap on_abort EXIT
  STAGE="preconditions"
  section "preconditions"
  local head cur
  head="$(git -C "$APP_DIR" rev-parse HEAD)"; cur="$(cat "$STATE_DIR/current-deploy.sha")"
  echo "HEAD=$head current-deploy.sha=$cur"
  [ "$head" = "$BASE_SHA" ] && [ "$cur" = "$BASE_SHA" ] || fail "hosted checkout / current-deploy.sha is not the expected base commit"
  [ -z "$(git -C "$APP_DIR" status --porcelain)" ] || fail "hosted checkout is dirty"
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$PG_CID")" = "healthy" ] || fail "postgres is not healthy"
  # RESUME: a previous run applied stage 1 (schema already at F1) and stopped the API
  # before the repair; continue from the repair with the images it already built.
  RESUME=0
  local fp_now; fp_now="$(fingerprint)"
  if [ "$fp_now" = "$EXPECT_F2" ] || [ "$fp_now" = "$EXPECT_F1" ]; then
    if [ "$fp_now" = "$EXPECT_F2" ]; then
      RESUME=2
      echo "RESUME: schema fingerprint already equals F2 — stage 1, the repair and stage 2 were applied by the previous runs; continuing with the final verification only"
    else
      RESUME=1
      echo "RESUME: schema fingerprint already equals F1 — stage 1 was applied by the previous run; continuing from the repair"
    fi
    compose ps --status running api --format '{{.Name}}' | grep -q . && fail "resume requires the api to be STOPPED (it is running)"
    docker image inspect cardscanner/migrate:b20-stage1 cardscanner/migrate:b20-stage2 >/dev/null 2>&1 || fail "resume requires the stage images from the previous run"
    [ "$(q "select count(*) from subscriptions where status not in ('trial','active','suspended','expired','cancelled','trialing','past_due')")" = "0" ] || fail "unknown subscription status"
    PG_NET="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$PG_CID" | head -c 200)"
    T_STOP="(previous run)"
  else
  [ -n "$API_CID" ] || fail "api container not running (unexpected starting state)"
  local bp bs bk
  bp="$(grep -E '^BILLING_PROVIDER=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  bs="$(grep -E '^BILLING_SELF_SERVICE_CHECKOUT=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  bk="$(grep -cE '^STRIPE_SECRET_KEY=.+' "$ENV_FILE" || true)"
  echo "billing: BILLING_PROVIDER='${bp:-<unset>}' BILLING_SELF_SERVICE_CHECKOUT='${bs:-<unset>}' STRIPE_SECRET_KEY_present=$bk"
  { [ -z "$bp" ] || [ "$bp" = "none" ]; } || fail "a billing provider is configured on the hosted stack ('$bp') — stopping without changes"
  [ "${bs:-false}" != "true" ] || fail "self-service checkout is enabled on the hosted stack — stopping without changes"
  [ "$bk" = "0" ] || fail "a Stripe secret key is present on the hosted stack — stopping without changes"
  local f0; f0="$(fingerprint)"; echo "schema_fingerprint=$f0 (expected F0=$EXPECT_F0)"
  [ "$f0" = "$EXPECT_F0" ] || fail "hosted schema fingerprint differs from the rehearsed F0"
  q "select 'plans='||(select count(*) from plans)||' subscriptions='||(select count(*) from subscriptions)||' companies='||(select count(*) from companies)"
  [ "$(q "select count(*) from plans")" = "0" ] || fail "plans table is not empty (preflight expected 0)"
  [ "$(q "select count(*) from subscriptions where stripe_customer_id is not null or stripe_subscription_id is not null")" = "0" ] || fail "provider ids present — manual reconciliation required"
  [ "$(q "select count(*) from companies where status not in ('trial','active','suspended','expired','cancelled')")" = "0" ] || fail "unknown legacy company status present"
  section "data baseline BEFORE (ids/states only)"
  snapshot_rows
  PG_NET="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$PG_CID" | head -c 200)"; echo "postgres network: $PG_NET"

  STAGE="artifacts"
  section "artifacts (before any downtime): isolated worktrees + migrate images"
  git -C "$APP_DIR" fetch --quiet origin "refs/heads/claude/b20-subscription-lifecycle:refs/remotes/origin/claude/b20-subscription-lifecycle"
  for sha in "$STAGE1_SHA" "$STAGE2_SHA"; do git -C "$APP_DIR" cat-file -e "$sha^{commit}" || fail "commit $sha not present after fetch"; done
  git -C "$APP_DIR" merge-base --is-ancestor "$BASE_SHA" "$STAGE2_SHA" || fail "accepted commit does not descend from the deployed base"
  git -C "$APP_DIR" merge-base --is-ancestor "$STAGE1_SHA" "$STAGE2_SHA" || fail "stage-1 commit is not an ancestor of the accepted commit"
  rm -rf "$WT_ROOT"; mkdir -p "$WT_ROOT"; git -C "$APP_DIR" worktree prune
  git -C "$APP_DIR" worktree add --quiet --detach "$WT_ROOT/stage1" "$STAGE1_SHA"
  git -C "$APP_DIR" worktree add --quiet --detach "$WT_ROOT/stage2" "$STAGE2_SHA"
  echo "worktrees: stage1=$(git -C "$WT_ROOT/stage1" rev-parse HEAD) stage2=$(git -C "$WT_ROOT/stage2" rev-parse HEAD); app checkout still $(git -C "$APP_DIR" rev-parse HEAD), dirty_entries=$(git -C "$APP_DIR" status --porcelain | wc -l)"
  export DOCKER_BUILDKIT=1
  for st in stage1 stage2; do
    echo "building cardscanner/migrate:b20-$st from $WT_ROOT/$st ($(date -u +%T), sequential, quiet)"
    docker build --quiet -f "$WT_ROOT/$st/docker/Dockerfile.api" --target migrate -t "cardscanner/migrate:b20-$st" "$WT_ROOT/$st" >/dev/null || fail "image build failed for $st"
  done
  docker image inspect cardscanner/migrate:b20-stage1 cardscanner/migrate:b20-stage2 -f '{{.RepoTags}} size={{.Size}}' | sed 's/^/image: /'
  echo "stage-1 image drizzle-kit: $(run_in_image cardscanner/migrate:b20-stage1 'cd lib/db && npx drizzle-kit --version' 2>/dev/null | tail -1)"

  STAGE="backup"
  section "fresh standard backup + integrity"
  local out size
  out="$(cd "$APP_DIR" && DEPLOY_PATH="$APP_DIR" bash docker/scripts/backup-postgres.sh 2>&1 | tee /dev/stderr | grep -oE '/opt/[^ ]+\.sql\.gz' | head -1)"
  [ -n "$out" ] && [ -f "$out" ] || fail "backup file not found"
  gzip -t "$out" || fail "backup gzip integrity check failed"
  size="$(stat -c '%s' "$out")"
  echo "backup=$out size=$size mtime=$(stat -c '%y' "$out") retained=$(ls -1 "$(dirname "$out")"/leadcapture-*.sql.gz | wc -l)"
  # pg_dump ≥ 16.10 appends a \unrestrict trailer AFTER the completion marker, so the
  # marker is searched in the whole dump; the last lines are printed as evidence.
  echo "backup structure: header=$(zcat "$out" | head -1 | cut -c1-40) complete_marker=$(zcat "$out" | grep -c '^-- PostgreSQL database dump complete') CREATE_TABLE=$(zcat "$out" | grep -c '^CREATE TABLE') COPY=$(zcat "$out" | grep -c '^COPY ') companies_copy=$(zcat "$out" | grep -c '^COPY public.companies') subscriptions_copy=$(zcat "$out" | grep -c '^COPY public.subscriptions') users_copy=$(zcat "$out" | grep -c '^COPY public.users')"
  echo "backup tail: $(zcat "$out" | tail -5 | tr '\n' '|' | cut -c1-160)"
  [ "$(zcat "$out" | grep -c '^-- PostgreSQL database dump complete')" = "1" ] || fail "backup is not a complete dump"
  [ "$(zcat "$out" | grep -c '^CREATE TABLE')" = "68" ] || fail "backup CREATE TABLE count is not 68"

  STAGE="stop-writers"
  section "stop API writers (queue + schedulers live in the api container)"
  T_STOP="$(date -u +%FT%TZ)"; echo "downtime_start=$T_STOP"
  compose stop api >/dev/null 2>&1 || fail "could not stop api"
  compose ps --status running api --format '{{.Name}}' | grep -q . && fail "api still running"
  echo "api container: $(docker inspect -f '{{.State.Status}}' "$API_CID")"
  local active; active="$(q "select count(*) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state is not null and state<>'idle'")"
  echo "non-idle database backends (excluding this session): $active"
  [ "$active" = "0" ] || fail "database still has active mutations"
  [ "$(fingerprint)" = "$EXPECT_F0" ] || fail "fingerprint changed before stage 1"

  STAGE="stage1"
  section "STAGE 1 — schema $STAGE1_SHA (statements)"
  run_in_image cardscanner/migrate:b20-stage1 'cd lib/db && npx drizzle-kit push --verbose --config ./drizzle.config.ts' 2>&1 | grep -v "Pulling schema" > "$HOME/b20-stage1.log" || true
  grep -E "^(ALTER|CREATE|DROP|TRUNCATE|DELETE|UPDATE|INSERT)" "$HOME/b20-stage1.log" | sed 's/^/  /'
  echo "statements=$(grep -cE '^(ALTER|CREATE)' "$HOME/b20-stage1.log") destructive=$(destructive_count "$HOME/b20-stage1.log") result=$(grep -oE 'Changes applied|No changes detected' "$HOME/b20-stage1.log" | tail -1)"
  classify "$HOME/b20-stage1.log"
  [ "$(grep -cE '^(ALTER|CREATE)' "$HOME/b20-stage1.log")" = "39" ] || fail "stage-1 statement count is not the rehearsed 39"
  [ "$(destructive_count "$HOME/b20-stage1.log")" = "0" ] || fail "stage-1 produced a destructive/unexpected statement"
  grep -q "Changes applied" "$HOME/b20-stage1.log" || fail "stage-1 push did not report 'Changes applied'"
  local f1; f1="$(fingerprint)"; echo "schema_fingerprint=$f1 (expected F1=$EXPECT_F1)"; [ "$f1" = "$EXPECT_F1" ] || fail "post-stage-1 fingerprint differs from the rehearsal"
  fi # end of the non-resume path (preconditions → artifacts → backup → stop → stage 1)

  if [ "$RESUME" != "2" ]; then # repair + stage 2 (skipped when the schema is already at F2)
  STAGE="repair-dry-run"
  section "REPAIR — dry-run (stage-1 image code) gated against the company authority"
  run_in_image cardscanner/migrate:b20-stage1 'cd artifacts/api-server && npx tsx scripts/repair-subscriptions.ts' > "$HOME/b20-repair-dry.json" 2>&1 || fail "repair dry-run failed: $(tail -3 "$HOME/b20-repair-dry.json")"
  grep -E '"mode"|"companies"|"subscriptions"|"companiesWithoutSubscription"|"plannedCreates"|"plannedUpdates"|"alreadyCanonical"|"conflicts"|"update:|"create:|"status"|"companyId"|"changed"' "$HOME/b20-repair-dry.json" | sed 's/^/  /'
  local pc pu cf rules
  pc="$(jsonnum "$HOME/b20-repair-dry.json" plannedCreates)"; pu="$(jsonnum "$HOME/b20-repair-dry.json" plannedUpdates)"; cf="$(jsonnum "$HOME/b20-repair-dry.json" conflicts)"
  rules="$(grep -oE '"(update|create):[a-z_]+": [0-9]+' "$HOME/b20-repair-dry.json" | tr '\n' ' ')"
  echo "gate: plannedCreates=$pc plannedUpdates=$pu conflicts=$cf rules=[$rules]"
  [ "$cf" = "0" ] || fail "repair reports conflicts"
  [ "$pc" = "0" ] || fail "repair would CREATE subscription rows (preflight showed none missing)"
  [ "$pu" = "1" ] || fail "repair plans $pu updates; the baseline expects exactly 1 (company 1: legacy active → canonical active)"
  # The planned rule must be exactly the company-authority mapping of every company's
  # OWN legacy status (repair-rules: legacy_<status> → the same canonical status), and
  # every company must be `active` (the only expectation accepted for this activation).
  local expected_rules=""
  for cid in $(q "select id from companies order by id"); do
    local ls; ls="$(q "select status from companies where id=$cid")"
    [ "$ls" = "active" ] || fail "company $cid has legacy status '$ls' — outside the accepted expectation (active only); stopping"
    expected_rules='"update:legacy_active": 1 '
  done
  [ "$rules" = "$expected_rules" ] || fail "repair rule set [$rules] differs from the company-authority expectation [$expected_rules]"
  echo "gate passed: the only planned change maps company 1's legacy 'active' to canonical 'active' (full access preserved); plan untouched"

  STAGE="repair-apply"
  section "REPAIR — apply + verify"
  run_in_image cardscanner/migrate:b20-stage1 'cd artifacts/api-server && npx tsx scripts/repair-subscriptions.ts --apply' > "$HOME/b20-repair-apply.json" 2>&1 || fail "repair apply failed: $(tail -3 "$HOME/b20-repair-apply.json")"
  grep -E '"mode"|"plannedCreates"|"plannedUpdates"|"alreadyCanonical"|"conflicts"|verify' "$HOME/b20-repair-apply.json" | sed 's/^/  /'
  run_in_image cardscanner/migrate:b20-stage1 'cd artifacts/api-server && npx tsx scripts/repair-subscriptions.ts' > "$HOME/b20-repair-verify.json" 2>&1 || fail "repair verify failed"
  grep -E '"plannedCreates"|"plannedUpdates"|"alreadyCanonical"|"conflicts"' "$HOME/b20-repair-verify.json" | sed 's/^/  verify: /'
  [ "$(jsonnum "$HOME/b20-repair-verify.json" plannedUpdates)" = "0" ] || fail "repair verify still plans updates"
  [ "$(jsonnum "$HOME/b20-repair-verify.json" plannedCreates)" = "0" ] || fail "repair verify still plans creates"
  [ "$(jsonnum "$HOME/b20-repair-verify.json" conflicts)" = "0" ] || fail "repair verify reports conflicts"
  q "select 'plans='||count(*)||' ids='||string_agg(id, ',' order by sort_order)||' non_null_limits='||count(*) filter (where admins_limit is not null or employees_limit is not null or contacts_limit is not null or events_limit is not null or storage_limit_mb is not null or scans_limit is not null)||' price_monthly(legacy column default)='||string_agg(coalesce(price_monthly::text,'null'), ',' order by sort_order) from plans"
  [ "$(q "select count(*) from plans")" = "5" ] || fail "plan catalog is not exactly 5 rows"
  q "select 'subscription '||id||': company='||company_id||' plan='||plan||' status='||status||' billing_source='||billing_source||' trial_expires_at='||coalesce(trial_expires_at::text,'null')||' usage_anchor_at='||coalesce(usage_anchor_at::text,'null')||' stripe='||(stripe_customer_id is not null or stripe_subscription_id is not null)||' overrides='||limit_overrides::text from subscriptions order by id"
  section "data AFTER repair (ids/states only)"
  snapshot_rows
  echo "repair audit rows: $(q "select count(*)||' actions='||coalesce(string_agg(distinct action, ','),'none') from audit_logs where entity_type='subscription' and action like 'subscription.repair_%'")"
  [ "$(q "select status from subscriptions where company_id=1")" = "active" ] || fail "company 1 subscription is not active after repair"
  [ "$(q "select status||'/'||plan from companies where id=1")" = "active/free" ] || fail "company 1 mirror changed unexpectedly"
  [ "$(fingerprint)" = "$EXPECT_F1" ] || fail "repair changed the schema fingerprint"

  STAGE="stage2"
  section "STAGE 2 — accepted schema $STAGE2_SHA (statements)"
  run_in_image cardscanner/migrate:b20-stage2 'cd lib/db && npx drizzle-kit push --verbose --config ./drizzle.config.ts' 2>&1 | grep -v "Pulling schema" > "$HOME/b20-stage2.log" || true
  grep -E "^(ALTER|CREATE|DROP|TRUNCATE|DELETE|UPDATE|INSERT)" "$HOME/b20-stage2.log" | sed 's/^/  /'
  echo "statements=$(grep -cE '^(ALTER|CREATE)' "$HOME/b20-stage2.log") destructive=$(destructive_count "$HOME/b20-stage2.log") result=$(grep -oE 'Changes applied|No changes detected' "$HOME/b20-stage2.log" | tail -1)"
  classify "$HOME/b20-stage2.log"
  [ "$(grep -cE '^(ALTER|CREATE)' "$HOME/b20-stage2.log")" = "27" ] || fail "stage-2 statement count is not the rehearsed 27"
  [ "$(destructive_count "$HOME/b20-stage2.log")" = "0" ] || fail "stage-2 produced a destructive/unexpected statement"
  grep -q "Changes applied" "$HOME/b20-stage2.log" || fail "stage-2 push did not report 'Changes applied'"
  fi # end of repair + stage 2

  STAGE="stage2-verify"
  section "STAGE 2 — verification (schema at the accepted commit, repair canonical, repeat push is a no-op)"
  local f2; f2="$(fingerprint)"; echo "schema_fingerprint=$f2 (expected F2=$EXPECT_F2)"; [ "$f2" = "$EXPECT_F2" ] || fail "post-stage-2 fingerprint differs from the rehearsal"
  echo "check+fk constraints on the five tables: $(q "select count(*) from pg_constraint where conrelid in ('subscriptions'::regclass,'plan_prices'::regclass,'billing_checkout_sessions'::regclass,'billing_provider_events'::regclass,'subscription_usage_reservations'::regclass) and contype in ('c','f')") (expected 28)"
  [ "$(q "select count(*) from pg_constraint where conrelid in ('subscriptions'::regclass,'plan_prices'::regclass,'billing_checkout_sessions'::regclass,'billing_provider_events'::regclass,'subscription_usage_reservations'::regclass) and contype in ('c','f')")" = "28" ] || fail "constraint count is not 28"
  echo "partial unique indexes: $(q "select string_agg(indexname, ' ' order by indexname) from pg_indexes where tablename in ('subscriptions','billing_checkout_sessions') and indexdef ilike '%where%'")"
  # Repair verify with the accepted-commit image (repair script identical in both commits): must plan nothing.
  run_in_image cardscanner/migrate:b20-stage2 'cd artifacts/api-server && npx tsx scripts/repair-subscriptions.ts' > "$HOME/b20-repair-final.json" 2>&1 || fail "final repair verify failed"
  grep -E '"companies"|"subscriptions"|"plannedCreates"|"plannedUpdates"|"alreadyCanonical"|"conflicts"' "$HOME/b20-repair-final.json" | sed 's/^/  final verify: /'
  [ "$(jsonnum "$HOME/b20-repair-final.json" plannedUpdates)" = "0" ] || fail "final repair verify still plans updates"
  [ "$(jsonnum "$HOME/b20-repair-final.json" plannedCreates)" = "0" ] || fail "final repair verify still plans creates"
  [ "$(jsonnum "$HOME/b20-repair-final.json" conflicts)" = "0" ] || fail "final repair verify reports conflicts"
  [ "$(q "select count(*) from plans")" = "5" ] || fail "plan catalog is not exactly 5 rows"
  [ "$(q "select status||'/'||plan||'/'||billing_source from subscriptions where company_id=1")" = "active/free/manual" ] || fail "company 1 subscription is not active/free/manual"
  [ "$(q "select status||'/'||plan from companies where id=1")" = "active/free" ] || fail "company 1 mirror changed unexpectedly"
  echo "repair audit rows: $(q "select count(*)||' actions='||coalesce(string_agg(distinct action, ','),'none') from audit_logs where entity_type='subscription' and action like 'subscription.repair_%'")"
  # The push output ends with npm notices, so the marker is searched in the whole output.
  run_in_image cardscanner/migrate:b20-stage2 'cd lib/db && npx drizzle-kit push --config ./drizzle.config.ts' 2>&1 | grep -v "Pulling schema" > "$HOME/b20-stage2-repeat.log" || true
  echo "repeat push: $(grep -oE 'Changes applied|No changes detected' "$HOME/b20-stage2-repeat.log" | tail -1) (statements=$(grep -cE '^(ALTER|CREATE|DROP)' "$HOME/b20-stage2-repeat.log"))"
  grep -q "No changes detected" "$HOME/b20-stage2-repeat.log" || fail "repeat push did not report 'No changes detected': $(tail -3 "$HOME/b20-stage2-repeat.log" | tr '\n' '|')"
  [ "$(fingerprint)" = "$EXPECT_F2" ] || fail "repeat push changed the schema fingerprint"
  section "final state (API remains STOPPED — the old code is incompatible with the final schema; the deploy brings the new API up)"
  snapshot_rows
  q "select 'tables='||(select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')||' size='||pg_size_pretty(pg_database_size(current_database()))"
  echo "downtime_start=$T_STOP now=$(date -u +%FT%TZ)"

  STAGE="cleanup-worktrees"
  git -C "$APP_DIR" worktree remove --force "$WT_ROOT/stage1"; git -C "$APP_DIR" worktree remove --force "$WT_ROOT/stage2"; git -C "$APP_DIR" worktree prune; rm -rf "$WT_ROOT"
  rm -f "$HOME"/b20-stage1.log "$HOME"/b20-stage2.log "$HOME"/b20-stage2-repeat.log "$HOME"/b20-repair-dry.json "$HOME"/b20-repair-apply.json "$HOME"/b20-repair-verify.json "$HOME"/b20-repair-final.json
  echo "app checkout: $(git -C "$APP_DIR" rev-parse HEAD) dirty_entries=$(git -C "$APP_DIR" status --porcelain | wc -l) worktrees=$(git -C "$APP_DIR" worktree list | wc -l)"
  STAGE="done"
  log "migrate complete — proceed with the fast-forward of develop and the deploy workflow"
}

phase_postdeploy() {
  section "hosted checkout / deploy state"
  echo "HEAD=$(git -C "$APP_DIR" rev-parse HEAD) dirty_entries=$(git -C "$APP_DIR" status --porcelain | wc -l) current-deploy.sha=$(cat "$STATE_DIR/current-deploy.sha") previous-deploy.sha=$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null || echo none) worktrees=$(git -C "$APP_DIR" worktree list | wc -l)"
  section "containers / volume"
  for svc in postgres api web; do cid="$(compose ps -q "$svc" || true)"; if [ -n "$cid" ]; then docker inspect -f "$svc: id={{.Id}} created={{.Created}} started={{.State.StartedAt}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}" "$cid"; else echo "$svc: absent"; fi; done
  for v in $(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$PG_CID"); do docker volume inspect -f "volume $v: created={{.CreatedAt}}" "$v"; done
  echo "readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE)"; echo "healthz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/healthz || echo UNAVAILABLE)"
  section "schema / data"
  echo "schema_fingerprint=$(fingerprint)"
  q "select 'tables='||(select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')||' plans='||(select count(*) from plans)||' subscriptions='||(select count(*) from subscriptions)||' companies='||(select count(*) from companies)||' users_active='||(select count(*) from users where deleted_at is null and is_active)"
  snapshot_rows
  section "env (non-secret keys) / billing disabled"
  for k in JOBS_DRIVER BILLING_PROVIDER BILLING_SELF_SERVICE_CHECKOUT BILLING_STRIPE_MODE; do envkey "$k" yes; done
  for k in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET BILLING_RETURN_URL APP_BASE_URL; do envkey "$k"; done
  echo "env sha256_prefix=$(sha256sum "$ENV_FILE" | cut -c1-16) mode=$(stat -c '%a' "$ENV_FILE")"
  section "durable queue / sweep / recovery (api log since container start)"
  if [ -n "$API_CID" ]; then
    docker logs "$API_CID" 2>&1 | grep -iE '"driver"|durable|queue|recovery|sweep|scheduler|billing|provider|workers' | grep -viE 'authorization|token|secret|password' | head -30 | cut -c1-240 || true
    echo "api log error-level lines: $(docker logs "$API_CID" 2>&1 | grep -c '"level":50' || true)"
    docker logs "$API_CID" 2>&1 | grep '"level":50' | tail -5 | cut -c1-240 || true
  fi
  q "select 'job_queue: '||coalesce(string_agg(status||'='||n, ' '), 'empty') from (select status, count(*) n from job_queue group by status order by status) s"
  q "select 'job_queue dead_last_24h='||count(*) from job_queue where status='dead' and dead_at > now() - interval '24 hours'"
  # Recurring scheduler jobs since the deploy (task name is the 2nd segment of the dedupe key; no payload is read).
  q "select 'recurring jobs (last 6h): '||coalesce(string_agg(k||'='||n||'/'||st, ' ' order by k, st), 'none') from (select split_part(coalesce(dedupe_key,''), ':', 2) k, status st, count(*) n from job_queue where name='recurring.sweep' and enqueued_at > now() - interval '6 hours' group by 1,2) s"
  q "select 'subscriptionSweep last completed: '||coalesce(max(completed_at)::text, 'never') from job_queue where name='recurring.sweep' and dedupe_key like 'recurring:subscriptionSweep:%' and status='completed'"
  echo "sweep log lines (api container): $(docker logs "$API_CID" 2>&1 | grep -c '"sweep":"subscription"' || true)"
  q "select 'disposable rows remaining: companies='||(select count(*) from companies where name like 'B20 SMOKE %')||' users='||(select count(*) from users where email like '%@b20smoke.invalid')"
  log "postdeploy complete (read-only)"
}

# ── smoke-setup: ONE disposable platform-owner login for the browser smoke ─────
# ARG1 = bcrypt hash generated OFF-host (the password never reaches the VPS or any
# log), ARG2 = disposable e-mail (unique, throwaway domain). Prints ids only.
phase_smoke_setup() {
  [ "$(git -C "$APP_DIR" rev-parse HEAD)" = "$STAGE2_SHA" ] || fail "hosted checkout is not the accepted commit"
  curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz >/dev/null || fail "api not ready"
  [[ "$ARG1" =~ ^\$2[aby]\$10\$.{53}$ ]] || fail "ARG1 is not a bcrypt hash"
  [[ "$ARG2" =~ ^b20-smoke-[a-z0-9]+@b20smoke\.invalid$ ]] || fail "ARG2 is not a disposable smoke address"
  section "existing users (ids / roles / company only)"
  q "select 'user '||id||': role='||role||' company_id='||coalesce(company_id::text,'null')||' active='||is_active||' deleted='||(deleted_at is not null) from users order by id"
  local pco; pco="$(q "select coalesce(min(company_id)::text,'null') from users where role='platform_owner' and deleted_at is null")"
  echo "platform company id: $pco"
  local cid_sql; if [ "$pco" = "null" ]; then cid_sql="null"; else cid_sql="$pco"; fi
  section "insert disposable platform owner"
  local uid; uid="$(qw "insert into users (email, name, role, company_id, password_hash, is_active, contact_visibility, company_visibility, permissions) values ('$ARG2', 'B20 smoke operator (disposable)', 'platform_owner', $cid_sql, '$ARG1', true, 'all', 'own', '{}'::jsonb) returning id")"
  echo "disposable_owner_user_id=$uid"
  log "smoke-setup complete"
}

# ── cleanup: remove ONLY the disposable smoke rows, by explicit ids ─────────────
# ARG1 = disposable company ids (csv), ARG2 = disposable user ids (csv, the owner),
# ARG3 = disposable e-mail domain. Verifies names/e-mails before deleting, verifies
# zero remain and that the existing customer rows are intact. Removes the stage
# images and temporary files. Completed queue history is left intact.
phase_cleanup() {
  [[ "$ARG1" =~ ^([0-9]+(,[0-9]+)*|none)$ ]] || fail "ARG1 must be a csv of company ids or 'none'"
  [[ "$ARG2" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "ARG2 must be a csv of user ids"
  [[ "$ARG3" =~ ^b20smoke\.invalid(:[a-z0-9]+)?$ ]] || fail "ARG3 must be the disposable domain, optionally ':<tag>'"
  local DOM="b20smoke.invalid" TAG=""; [[ "$ARG3" == *:* ]] && TAG="${ARG3##*:}"
  local C U; C="$ARG1"; [ "$C" = "none" ] && C="-1"; U="$ARG2"   # -1 never matches a real id
  section "guard: every target is a disposable smoke row (explicit ids; names/e-mails verified)"
  q "select 'company '||id||': '||case when name like 'B20 SMOKE %' then 'disposable' else 'NOT DISPOSABLE' end from companies where id in ($C) order by id"
  q "select 'user '||id||': role='||role||' company_id='||coalesce(company_id::text,'null')||' '||case when email like '%@$DOM' then 'disposable' else 'NOT DISPOSABLE' end from users where id in ($U) or company_id in ($C) order by id"
  [ "$(q "select count(*) from companies where id in ($C) and name not like 'B20 SMOKE %'")" = "0" ] || fail "a target company is not a smoke tenant"
  [ "$(q "select count(*) from users where id in ($U) and email not like '%@$DOM'")" = "0" ] || fail "a target user is not a smoke user"
  [ "$(q "select count(*) from users where company_id in ($C) and email not like '%@$DOM'")" = "0" ] || fail "a smoke tenant holds a non-smoke user"
  [ "$(q "select count(*) from users where id in ($U) and company_id is not null and company_id not in ($C)")" = "0" ] || fail "a target user belongs to a non-target company"
  section "existing rows BEFORE cleanup (everything outside the explicit targets; must be identical afterwards)"
  local kept_sql="select 'companies='||(select count(*) from companies where id not in ($C))||' users='||(select count(*) from users where id not in ($U) and (company_id is null or company_id not in ($C)))||' subscriptions='||(select count(*) from subscriptions where company_id not in ($C))||' contacts='||(select count(*) from contacts where company_id not in ($C))||' leads='||(select count(*) from leads where company_id not in ($C))||' events='||(select count(*) from events where company_id not in ($C))||' tasks='||(select count(*) from tasks where company_id not in ($C))||' tags='||(select count(*) from tags where company_id not in ($C))||' wf_defs='||(select count(*) from workflow_definitions where company_id not in ($C))||' wf_runs='||(select count(*) from workflow_runs where company_id not in ($C))||' audit='||(select count(*) from audit_logs where (company_id is null or company_id not in ($C)) and (user_id is null or user_id not in ($U)))||' activity='||(select count(*) from activity_logs where (company_id is null or company_id not in ($C)) and (user_id is null or user_id not in ($U)))||' login_attempts='||(select count(*) from login_attempts where email not like 'b20-smoke-${TAG}%@$DOM')"
  local before; before="$(q "$kept_sql")"; echo "$before"
  section "delete disposable rows (explicit ids; child tables first, counted)"
  echo "sessions=$(qw "with d as (delete from sessions where user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
  echo "notifications=$(qw "with d as (delete from notifications where user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
  echo "workflow_action_runs=$(qw "with d as (delete from workflow_action_runs where company_id in ($C) returning 1) select count(*) from d")"
  echo "workflow_runs=$(qw "with d as (delete from workflow_runs where company_id in ($C) returning 1) select count(*) from d")"
  echo "workflow_definitions=$(qw "with d as (delete from workflow_definitions where company_id in ($C) returning 1) select count(*) from d")"
  echo "lead_tags=$(qw "with d as (delete from lead_tags where company_id in ($C) returning 1) select count(*) from d")"
  echo "tasks=$(qw "with d as (delete from tasks where company_id in ($C) returning 1) select count(*) from d")"
  echo "leads=$(qw "with d as (delete from leads where company_id in ($C) returning 1) select count(*) from d")"
  echo "contacts=$(qw "with d as (delete from contacts where company_id in ($C) returning 1) select count(*) from d")"
  echo "events=$(qw "with d as (delete from events where company_id in ($C) returning 1) select count(*) from d")"
  echo "tags=$(qw "with d as (delete from tags where company_id in ($C) returning 1) select count(*) from d")"
  echo "reservations=$(qw "with d as (delete from subscription_usage_reservations where company_id in ($C) returning 1) select count(*) from d")"
  echo "checkout_intents=$(qw "with d as (delete from billing_checkout_sessions where company_id in ($C) returning 1) select count(*) from d")"
  echo "invitations=$(qw "with d as (delete from invitations where company_id in ($C) returning 1) select count(*) from d")"
  echo "audit_logs=$(qw "with d as (delete from audit_logs where company_id in ($C) or user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
  echo "activity_logs=$(qw "with d as (delete from activity_logs where company_id in ($C) or user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
  if [ -n "$TAG" ]; then echo "login_attempts=$(qw "with d as (delete from login_attempts where email like 'b20-smoke-${TAG}%@$DOM' returning 1) select count(*) from d")"; fi
  echo "tenant_users=$(qw "with d as (delete from users where company_id in ($C) returning 1) select count(*) from d")"
  echo "owner_users=$(qw "with d as (delete from users where id in ($U) returning 1) select count(*) from d")"
  echo "subscriptions=$(qw "with d as (delete from subscriptions where company_id in ($C) returning 1) select count(*) from d")"
  echo "companies=$(qw "with d as (delete from companies where id in ($C) returning 1) select count(*) from d")"
  section "verify zero disposable rows remain"
  local z; z="$(q "select 'companies='||(select count(*) from companies where id in ($C) or name like 'B20 SMOKE %')||' users='||(select count(*) from users where id in ($U) or email like '%@$DOM')||' subscriptions='||(select count(*) from subscriptions where company_id in ($C))||' contacts='||(select count(*) from contacts where company_id in ($C))||' leads='||(select count(*) from leads where company_id in ($C))||' events='||(select count(*) from events where company_id in ($C))||' tasks='||(select count(*) from tasks where company_id in ($C))||' tags='||(select count(*) from tags where company_id in ($C))||' lead_tags='||(select count(*) from lead_tags where company_id in ($C))||' wf_defs='||(select count(*) from workflow_definitions where company_id in ($C))||' wf_runs='||(select count(*) from workflow_runs where company_id in ($C))||' wf_action_runs='||(select count(*) from workflow_action_runs where company_id in ($C))||' intents='||(select count(*) from billing_checkout_sessions where company_id in ($C))||' reservations='||(select count(*) from subscription_usage_reservations where company_id in ($C))||' audit='||(select count(*) from audit_logs where company_id in ($C) or user_id in ($U))||' activity='||(select count(*) from activity_logs where company_id in ($C) or user_id in ($U))||' sessions='||(select count(*) from sessions where user_id in ($U))||' notifications='||(select count(*) from notifications where user_id in ($U))||' login_attempts='||(select count(*) from login_attempts where email like 'b20-smoke-${TAG:-zzzz}%@$DOM')")"; echo "$z"
  echo "$z" | grep -vqE '=[1-9]' || fail "disposable rows remain: $z"
  section "existing rows AFTER cleanup"
  local after; after="$(q "$kept_sql")"; echo "$after"
  [ "$after" = "$before" ] || fail "existing rows changed during cleanup: before[$before] after[$after]"
  snapshot_rows
  section "remove stage images and temporary files"
  docker rmi cardscanner/migrate:b20-stage1 cardscanner/migrate:b20-stage2 >/dev/null 2>&1 && echo "stage images removed" || echo "stage images already absent"
  rm -f "$HOME"/b20-*.log "$HOME"/b20-*.json "$HOME"/b20-baseline-*.txt; rm -rf "$HOME/b20-worktrees"; git -C "$APP_DIR" worktree prune
  echo "leftover temp files (the running phase script counts as 1): $(ls "$HOME" | grep -c '^b20-' || true); worktrees=$(git -C "$APP_DIR" worktree list | wc -l); app checkout=$(git -C "$APP_DIR" rev-parse HEAD) dirty=$(git -C "$APP_DIR" status --porcelain | wc -l)"
  echo "schema_fingerprint=$(fingerprint)"
  echo "readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE)"
  log "cleanup complete"
}

# Writable SQL — used ONLY by smoke-setup / orphan-run / cleanup (explicit ids) and never by preflight/postdeploy/supp-*.
qw() { compose exec -T postgres sh -c 'exec psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tA -F "|" -c "$1"' sh "$1"; }

# ── Supplemental smoke support ────────────────────────────────────────────────
# Existing-customer baseline (company 1 = the only pre-existing tenant): per-table
# counts + the canonical subscription projection. Sessions/notifications of the
# existing users are excluded on purpose (legitimate login / scheduler activity).
existing_baseline() {
  q "select 'company1: status='||c.status||' plan='||c.plan||' name_md5='||md5(c.name)||' | sub: status='||s.status||' plan='||s.plan||' source='||s.billing_source||' overrides='||s.limit_overrides::text||' trial_expires='||coalesce(s.trial_expires_at::text,'null')||' status_changed='||s.status_changed_at::text||' | users='||(select count(*) from users where company_id=1)||' contacts='||(select count(*) from contacts where company_id=1)||' leads='||(select count(*) from leads where company_id=1)||' events='||(select count(*) from events where company_id=1)||' tasks='||(select count(*) from tasks where company_id=1)||' tags='||(select count(*) from tags where company_id=1)||' lead_tags='||(select count(*) from lead_tags where company_id=1)||' documents='||(select count(*) from documents where company_id=1)||' wf_defs='||(select count(*) from workflow_definitions where company_id=1)||' wf_runs='||(select count(*) from workflow_runs where company_id=1)||' audit='||(select count(*) from audit_logs where company_id=1)||' activity='||(select count(*) from activity_logs where company_id=1)||' intents='||(select count(*) from billing_checkout_sessions where company_id=1)||' reservations='||(select count(*) from subscription_usage_reservations where company_id=1) from companies c join subscriptions s on s.company_id=c.id where c.id=1"
}
disposable_counts() {
  local tag="$1"
  q "select 'companies='||(select count(*) from companies where name like 'B20 SMOKE %')||' users='||(select count(*) from users where email like '%@b20smoke.invalid')||' login_attempts='||(select count(*) from login_attempts where email like 'b20-smoke-$tag%@b20smoke.invalid')||' subscriptions='||(select count(*) from subscriptions where company_id in (select id from companies where name like 'B20 SMOKE %'))||' wf_defs='||(select count(*) from workflow_definitions where name like 'B20 SMOKE %')||' wf_runs='||(select count(*) from workflow_runs where event_key like '%b20smoke-%' or company_id in (select id from companies where name like 'B20 SMOKE %'))||' leads='||(select count(*) from leads where company_id in (select id from companies where name like 'B20 SMOKE %'))||' events='||(select count(*) from events where company_id in (select id from companies where name like 'B20 SMOKE %'))||' tasks='||(select count(*) from tasks where company_id in (select id from companies where name like 'B20 SMOKE %'))||' tags='||(select count(*) from tags where company_id in (select id from companies where name like 'B20 SMOKE %'))||' contacts='||(select count(*) from contacts where company_id in (select id from companies where name like 'B20 SMOKE %'))||' audit='||(select count(*) from audit_logs where company_id in (select id from companies where name like 'B20 SMOKE %') or user_id in (select id from users where email like '%@b20smoke.invalid'))||' activity='||(select count(*) from activity_logs where company_id in (select id from companies where name like 'B20 SMOKE %') or user_id in (select id from users where email like '%@b20smoke.invalid'))||' sessions='||(select count(*) from sessions where user_id in (select id from users where email like '%@b20smoke.invalid'))"
}

# supp-preflight: READ-ONLY preservation + readiness checks before any fixture is created.
# ARG1 = smoke tag (only used to scope the login_attempts count).
phase_supp_preflight() {
  section "deploy state"
  local head cur; head="$(git -C "$APP_DIR" rev-parse HEAD)"; cur="$(cat "$STATE_DIR/current-deploy.sha")"
  echo "HEAD=$head current-deploy.sha=$cur dirty_entries=$(git -C "$APP_DIR" status --porcelain | wc -l) worktrees=$(git -C "$APP_DIR" worktree list | wc -l)"
  [ "$head" = "$STAGE2_SHA" ] && [ "$cur" = "$STAGE2_SHA" ] || fail "hosted checkout / current-deploy.sha is not the accepted commit"
  [ -z "$(git -C "$APP_DIR" status --porcelain)" ] || fail "hosted checkout is dirty"
  section "schema"
  local fp; fp="$(fingerprint)"; echo "schema_fingerprint=$fp"; [ "$fp" = "$F2_CONST" ] || fail "schema fingerprint is not the accepted F2"
  section "containers / volume / health"
  for svc in postgres api web; do cid="$(compose ps -q "$svc" || true)"; [ -n "$cid" ] || fail "$svc container absent"; docker inspect -f "$svc: id={{.Id}} created={{.Created}} started={{.State.StartedAt}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}" "$cid"; [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}healthy{{end}}' "$cid")" = "healthy" ] || fail "$svc is not healthy"; done
  for v in $(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$PG_CID"); do docker volume inspect -f "volume $v: created={{.CreatedAt}}" "$v"; done
  local rz; rz="$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE)"; echo "readyz=$rz"; echo "$rz" | grep -q '"status":"ok"' || fail "api not ready"
  section "env (non-secret keys) / billing disabled"
  for k in JOBS_DRIVER BILLING_PROVIDER BILLING_SELF_SERVICE_CHECKOUT BILLING_STRIPE_MODE; do envkey "$k" yes; done
  for k in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET BILLING_RETURN_URL SMTP_HOST; do envkey "$k"; done
  echo "env sha256_prefix=$(sha256sum "$ENV_FILE" | cut -c1-16) mode=$(stat -c '%a' "$ENV_FILE")"
  local bp; bp="$(grep -E '^BILLING_PROVIDER=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  { [ -z "$bp" ] || [ "$bp" = "none" ]; } || fail "a billing provider is configured ('$bp')"
  [ "$(grep -cE '^BILLING_SELF_SERVICE_CHECKOUT=true' "$ENV_FILE" || true)" = "0" ] || fail "self-service checkout enabled"
  [ "$(grep -cE '^STRIPE_SECRET_KEY=.+' "$ENV_FILE" || true)" = "0" ] || fail "Stripe key present"
  echo "plan_prices=$(q "select count(*) from plan_prices")"; [ "$(q "select count(*) from plan_prices")" = "0" ] || fail "provider prices registered"
  section "durable queue"
  docker logs "$API_CID" 2>&1 | grep -E '"msg":"Durable job queue (selected|started)"' | cut -c1-200 | head -2
  [ "$(docker logs "$API_CID" 2>&1 | grep -cE '"driver":"postgres".*"Durable job queue started"')" -ge 1 ] || fail "postgres durable queue not started"
  q "select 'job_queue: '||coalesce(string_agg(status||'='||n, ' '), 'empty') from (select status, count(*) n from job_queue group by status order by status) s"
  [ "$(q "select count(*) from job_queue where status='dead' and dead_at > now() - interval '24 hours'")" = "0" ] || fail "dead jobs in the last 24h"
  section "existing customer baseline (company 1)"
  local b; b="$(existing_baseline)"; echo "$b"; echo "baseline_md5=$(printf '%s' "$b" | md5sum | cut -c1-32)"
  echo "$b" | grep -q "company1: status=active plan=free" || fail "company 1 mirror is not active/free"
  echo "$b" | grep -q "sub: status=active plan=free source=manual overrides={}" || fail "company 1 subscription is not active/free/manual without overrides"
  section "disposable rows from earlier smokes (must be zero)"
  local d; d="$(disposable_counts "${ARG1:-none}")"; echo "$d"
  echo "$d" | grep -vqE '=[1-9]' || fail "disposable rows remain from a previous smoke: $d"
  echo "now_epoch_ms=$(date +%s%3N)"
  log "supp-preflight complete (read-only)"
}

# orphan-run: persist ONE queued workflow run for a DISPOSABLE tenant exactly as
# dispatch.persistWorkflowRuns would (run row + pending action rows, snapshot copied
# from the tenant's own definition), back-dated past the recovery grace so the
# accepted orphan-recovery sweep re-enqueues it. No job is enqueued here — the
# executor only ever runs it through the recovery integration.
# ARG1 = company id, ARG2 = workflow definition id, ARG3 = "<leadId>,<actorUserId>,<tag>"
phase_orphan_run() {
  [[ "$ARG1" =~ ^[0-9]+$ ]] || fail "ARG1 must be a company id"
  [[ "$ARG2" =~ ^[0-9]+$ ]] || fail "ARG2 must be a workflow definition id"
  [[ "$ARG3" =~ ^[0-9]+,[0-9]+,[a-z0-9]+$ ]] || fail "ARG3 must be leadId,actorUserId,tag"
  local lead actor tag; lead="${ARG3%%,*}"; actor="$(echo "$ARG3" | cut -d, -f2)"; tag="${ARG3##*,}"
  section "guards (disposable tenant only)"
  [ "$(q "select count(*) from companies where id=$ARG1 and name like 'B20 SMOKE %'")" = "1" ] || fail "company $ARG1 is not a smoke tenant"
  [ "$(q "select count(*) from workflow_definitions where id=$ARG2 and company_id=$ARG1 and name like 'B20 SMOKE %'")" = "1" ] || fail "definition $ARG2 is not a smoke definition of company $ARG1"
  [ "$(q "select count(*) from leads where id=$lead and company_id=$ARG1")" = "1" ] || fail "lead $lead is not in company $ARG1"
  [ "$(q "select count(*) from users where id=$actor and company_id=$ARG1 and email like '%@b20smoke.invalid'")" = "1" ] || fail "actor $actor is not a smoke user of company $ARG1"
  echo "definition: $(q "select 'status='||status||' revision='||revision||' actions='||jsonb_array_length(actions) from workflow_definitions where id=$ARG2")"
  echo "tenant access now: $(q "select status||'/'||billing_source from subscriptions where company_id=$ARG1")"
  section "insert queued run (back-dated 3 minutes) + pending action rows"
  local key="lead.created:lead:$lead:b20smoke-$tag-orphan"
  local rid; rid="$(qw "insert into workflow_runs (company_id, workflow_definition_id, definition_revision, definition_snapshot, trigger_type, entity_type, entity_id, actor_user_id, event_key, status, enqueue_generation, queued_at, created_at, updated_at) select company_id, id, revision, jsonb_build_object('name', name, 'trigger', \"trigger\", 'conditions', conditions, 'actions', actions), 'lead.created', 'lead', $lead, $actor, '$key', 'queued', 1, now() - interval '3 minutes', now(), now() - interval '3 minutes' from workflow_definitions where id=$ARG2 and company_id=$ARG1 returning id")"
  [[ "$rid" =~ ^[0-9]+$ ]] || fail "run insert failed"
  echo "action_rows=$(qw "with a as (insert into workflow_action_runs (run_id, company_id, action_index, action_type, status) select $rid, $ARG1, (ord-1)::int, elem->>'type', 'pending' from workflow_definitions d, jsonb_array_elements(d.actions) with ordinality as t(elem, ord) where d.id=$ARG2 returning 1) select count(*) from a")"
  q "select 'run '||id||': status='||status||' generation='||enqueue_generation||' queued_at='||queued_at||' updated_at='||updated_at||' event_key='||event_key from workflow_runs where id=$rid"
  q "select 'action '||action_index||': '||action_type||' '||status from workflow_action_runs where run_id=$rid order by action_index"
  echo "orphan_run_id=$rid"
  log "orphan-run complete"
}

# supp-postcheck: READ-ONLY. ARG1 = smoke start epoch ms, ARG2 = expected baseline md5,
# ARG3 = "<tag>|<csv of run ids>" (queue evidence for the workflow runs).
phase_supp_postcheck() {
  local tag="${ARG3%%|*}" runs="${ARG3##*|}"
  section "deploy / schema / env / containers"
  echo "HEAD=$(git -C "$APP_DIR" rev-parse HEAD) current-deploy.sha=$(cat "$STATE_DIR/current-deploy.sha") dirty_entries=$(git -C "$APP_DIR" status --porcelain | wc -l)"
  [ "$(git -C "$APP_DIR" rev-parse HEAD)" = "$STAGE2_SHA" ] && [ "$(cat "$STATE_DIR/current-deploy.sha")" = "$STAGE2_SHA" ] || fail "deploy sha changed"
  echo "schema_fingerprint=$(fingerprint)"; [ "$(fingerprint)" = "$F2_CONST" ] || fail "schema fingerprint changed"
  echo "env sha256_prefix=$(sha256sum "$ENV_FILE" | cut -c1-16) mode=$(stat -c '%a' "$ENV_FILE")"
  for svc in postgres api web; do cid="$(compose ps -q "$svc" || true)"; docker inspect -f "$svc: id={{.Id}} created={{.Created}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}" "$cid"; done
  for v in $(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$PG_CID"); do docker volume inspect -f "volume $v: created={{.CreatedAt}}" "$v"; done
  echo "readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE)"
  section "disposable rows (must be zero)"
  local d; d="$(disposable_counts "$tag")"; echo "$d"; echo "$d" | grep -vqE '=[1-9]' || fail "disposable rows remain: $d"
  section "existing customer baseline (company 1) — must equal the preflight baseline"
  local b; b="$(existing_baseline)"; echo "$b"; local m; m="$(printf '%s' "$b" | md5sum | cut -c1-32)"; echo "baseline_md5=$m expected=$ARG2"
  [ "$m" = "$ARG2" ] || fail "existing customer baseline changed"
  section "queue / workers since the smoke started"
  q "select 'job_queue: '||coalesce(string_agg(status||'='||n, ' '), 'empty') from (select status, count(*) n from job_queue group by status order by status) s"
  q "select 'jobs enqueued during the smoke: '||coalesce(string_agg(name||'='||n, ' ' order by name), 'none') from (select name, count(*) n from job_queue where enqueued_at > to_timestamp($ARG1/1000.0) group by name) s"
  q "select 'dead jobs during the smoke='||count(*) from job_queue where status='dead' and dead_at > to_timestamp($ARG1/1000.0)"
  [ "$(q "select count(*) from job_queue where status='dead' and dead_at > to_timestamp($ARG1/1000.0)")" = "0" ] || fail "dead jobs appeared during the smoke"
  if [ -n "$runs" ] && [ "$runs" != "$ARG3" ]; then
    for r in $(echo "$runs" | tr ',' ' '); do q "select 'workflow.run job(s) for run $r: '||coalesce(string_agg(dedupe_key||'='||status||'/attempts:'||attempts, ' '), 'none') from job_queue where name='workflow.run' and dedupe_key like 'workflow.run:$r:%'"; done
  fi
  echo "api error-level lines since start: $(docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep -c '"level":50' || true)"
  echo "  by error type / status: $(docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep '"level":50' | grep -oE '"type":"[A-Za-z_]+"|"statusCode":[0-9]+' | sort | uniq -c | tr '\n' ' ' | tr -s ' ')"
  echo "  non-AppError error lines: $(docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep '"level":50' | grep -vc '"type":"_AppError"' || true)"
  docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep '"level":50' | grep -v '"type":"_AppError"' | grep -viE 'authorization|token|secret|password' | cut -c1-260 | head -10
  echo "  workflow log lines: $(docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep -E '"msg":"(Workflow run (persisted|started|completed|failed)|Orphaned workflow run re-enqueued|Workflow orphan recovery sweep complete)"' | grep -oE '"msg":"[^"]+"' | sort | uniq -c | tr '\n' ' ' | tr -s ' ')"
  log "supp-postcheck complete (read-only)"
}

case "$PHASE" in
  preflight) phase_preflight ;;
  migrate) phase_migrate ;;
  postdeploy) phase_postdeploy ;;
  smoke-setup) phase_smoke_setup ;;
  cleanup) phase_cleanup ;;
  supp-preflight) phase_supp_preflight ;;
  orphan-run) phase_orphan_run ;;
  supp-postcheck) phase_supp_postcheck ;;
  *) fail "phase '$PHASE' is not implemented in this revision of the ops script" ;;
esac
