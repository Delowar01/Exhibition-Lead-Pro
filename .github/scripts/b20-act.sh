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
#   c4-verify / c4-perm-column (read-only) and c4-legacy-grant (one disposable row):
#                Correction 4 hosted activation support (see the section near the end).
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
  local want="${ARG3:-$STAGE2_SHA}"; [[ "$want" =~ ^[0-9a-f]{40}$ ]] || fail "ARG3 must be empty or a commit sha"
  [ "$(git -C "$APP_DIR" rev-parse HEAD)" = "$want" ] || fail "hosted checkout is not the expected commit $want"
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
  echo "user_roles=$(qw "with d as (delete from user_roles where user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
  echo "roles=$(qw "with d as (delete from roles where company_id in ($C) returning 1) select count(*) from d")"
  echo "mfa_backup_codes=$(qw "with d as (delete from mfa_backup_codes where user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
  echo "verification_tokens=$(qw "with d as (delete from verification_tokens where user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
  echo "trusted_devices=$(qw "with d as (delete from trusted_devices where user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
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
  echo "ai_usage_reservations=$(qw "with d as (delete from ai_usage_reservations where company_id in ($C) returning 1) select count(*) from d")"
  echo "ai_invocations=$(qw "with d as (delete from ai_invocations where company_id in ($C) or user_id in ($U) or user_id in (select id from users where company_id in ($C)) returning 1) select count(*) from d")"
  echo "ai_settings=$(qw "with d as (delete from ai_settings where company_id in ($C) returning 1) select count(*) from d")"
  echo "document_versions=$(qw "with d as (delete from document_versions where company_id in ($C) returning 1) select count(*) from d")"
  echo "documents=$(qw "with d as (delete from documents where company_id in ($C) returning 1) select count(*) from d")"
  echo "scans=$(qw "with d as (delete from scans where company_id in ($C) returning 1) select count(*) from d")"
  echo "tenant_users=$(qw "with d as (delete from users where company_id in ($C) returning 1) select count(*) from d")"
  echo "owner_users=$(qw "with d as (delete from users where id in ($U) returning 1) select count(*) from d")"
  echo "subscriptions=$(qw "with d as (delete from subscriptions where company_id in ($C) returning 1) select count(*) from d")"
  echo "companies=$(qw "with d as (delete from companies where id in ($C) returning 1) select count(*) from d")"
  section "verify zero disposable rows remain"
  local z; z="$(q "select 'companies='||(select count(*) from companies where id in ($C) or name like 'B20 SMOKE %')||' users='||(select count(*) from users where id in ($U) or email like '%@$DOM')||' subscriptions='||(select count(*) from subscriptions where company_id in ($C))||' contacts='||(select count(*) from contacts where company_id in ($C))||' leads='||(select count(*) from leads where company_id in ($C))||' events='||(select count(*) from events where company_id in ($C))||' tasks='||(select count(*) from tasks where company_id in ($C))||' tags='||(select count(*) from tags where company_id in ($C))||' lead_tags='||(select count(*) from lead_tags where company_id in ($C))||' wf_defs='||(select count(*) from workflow_definitions where company_id in ($C))||' wf_runs='||(select count(*) from workflow_runs where company_id in ($C))||' wf_action_runs='||(select count(*) from workflow_action_runs where company_id in ($C))||' intents='||(select count(*) from billing_checkout_sessions where company_id in ($C))||' reservations='||(select count(*) from subscription_usage_reservations where company_id in ($C))||' audit='||(select count(*) from audit_logs where company_id in ($C) or user_id in ($U))||' activity='||(select count(*) from activity_logs where company_id in ($C) or user_id in ($U))||' sessions='||(select count(*) from sessions where user_id in ($U))||' notifications='||(select count(*) from notifications where user_id in ($U))||' roles='||(select count(*) from roles where company_id in ($C) or name like 'B20 SMOKE %')||' user_roles='||(select count(*) from user_roles where user_id in ($U))||' mfa_backup_codes='||(select count(*) from mfa_backup_codes where user_id in ($U))||' verification_tokens='||(select count(*) from verification_tokens where user_id in ($U))||' trusted_devices='||(select count(*) from trusted_devices where user_id in ($U))||' login_attempts='||(select count(*) from login_attempts where email like 'b20-smoke-${TAG:-zzzz}%@$DOM')||' documents='||(select count(*) from documents where company_id in ($C))||' document_versions='||(select count(*) from document_versions where company_id in ($C))||' scans='||(select count(*) from scans where company_id in ($C))||' ai_invocations='||(select count(*) from ai_invocations where company_id in ($C) or user_id in ($U))||' ai_settings='||(select count(*) from ai_settings where company_id in ($C))||' invitations='||(select count(*) from invitations where company_id in ($C) or email like '%@$DOM')")"; echo "$z"
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
  q "select 'companies='||(select count(*) from companies where name like 'B20 SMOKE %')||' users='||(select count(*) from users where email like '%@b20smoke.invalid')||' login_attempts='||(select count(*) from login_attempts where email like 'b20-smoke-$tag%@b20smoke.invalid')||' subscriptions='||(select count(*) from subscriptions where company_id in (select id from companies where name like 'B20 SMOKE %'))||' wf_defs='||(select count(*) from workflow_definitions where name like 'B20 SMOKE %')||' wf_runs='||(select count(*) from workflow_runs where event_key like '%b20smoke-%' or company_id in (select id from companies where name like 'B20 SMOKE %'))||' leads='||(select count(*) from leads where company_id in (select id from companies where name like 'B20 SMOKE %'))||' events='||(select count(*) from events where company_id in (select id from companies where name like 'B20 SMOKE %'))||' tasks='||(select count(*) from tasks where company_id in (select id from companies where name like 'B20 SMOKE %'))||' tags='||(select count(*) from tags where company_id in (select id from companies where name like 'B20 SMOKE %'))||' contacts='||(select count(*) from contacts where company_id in (select id from companies where name like 'B20 SMOKE %'))||' audit='||(select count(*) from audit_logs where company_id in (select id from companies where name like 'B20 SMOKE %') or user_id in (select id from users where email like '%@b20smoke.invalid'))||' activity='||(select count(*) from activity_logs where company_id in (select id from companies where name like 'B20 SMOKE %') or user_id in (select id from users where email like '%@b20smoke.invalid'))||' sessions='||(select count(*) from sessions where user_id in (select id from users where email like '%@b20smoke.invalid'))||' roles='||(select count(*) from roles where name like 'B20 SMOKE %')||' documents='||(select count(*) from documents where company_id in (select id from companies where name like 'B20 SMOKE %'))||' scans='||(select count(*) from scans where company_id in (select id from companies where name like 'B20 SMOKE %'))||' ai_invocations='||(select count(*) from ai_invocations where company_id in (select id from companies where name like 'B20 SMOKE %') or user_id in (select id from users where email like '%@b20smoke.invalid'))||' invitations='||(select count(*) from invitations where company_id in (select id from companies where name like 'B20 SMOKE %') or email like '%@b20smoke.invalid')"
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
  { docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep '"level":50' | grep -v '"type":"_AppError"' | grep -viE 'authorization|token|secret|password' | cut -c1-260 | head -10; } || true
  echo "  workflow log lines: $({ docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep -E '"msg":"(Workflow run (persisted|started|completed|failed)|Orphaned workflow run re-enqueued|Workflow orphan recovery sweep complete)"' | grep -oE '"msg":"[^"]+"' | sort | uniq -c | tr '\n' ' ' | tr -s ' '; } || true)"
  log "supp-postcheck complete (read-only)"
}

# ── Correction 4 (auth projection carries the effective RBAC permissions) ─────
# The accepted commit is an API auth-projection change with NO schema change: no
# push, repair, migration or billing step exists in this revision on purpose.
C4_SHA=d9e1449f4fe551dc4e3090444fe696a11624013c
existing_core() {
  q "select 'company1: status='||c.status||' plan='||c.plan||' name_md5='||md5(c.name)||' | sub: status='||s.status||' plan='||s.plan||' source='||s.billing_source||' overrides='||s.limit_overrides::text||' trial_expires='||coalesce(s.trial_expires_at::text,'null')||' status_changed='||s.status_changed_at::text||' stripe='||(s.stripe_customer_id is not null or s.stripe_subscription_id is not null)||' | users='||(select count(*) from users where company_id=1)||' users_active='||(select count(*) from users where company_id=1 and deleted_at is null and is_active)||' roles='||(select count(*) from roles where company_id=1)||' user_roles='||(select count(*) from user_roles ur join users u on u.id=ur.user_id where u.company_id=1)||' perms_md5='||md5(coalesce((select string_agg(u.id||':'||u.role||':'||u.permissions::text, ',' order by u.id) from users u where u.company_id=1),''))||' contacts='||(select count(*) from contacts where company_id=1)||' leads='||(select count(*) from leads where company_id=1)||' events='||(select count(*) from events where company_id=1)||' tasks='||(select count(*) from tasks where company_id=1)||' tags='||(select count(*) from tags where company_id=1)||' lead_tags='||(select count(*) from lead_tags where company_id=1)||' documents='||(select count(*) from documents where company_id=1)||' wf_defs='||(select count(*) from workflow_definitions where company_id=1)||' wf_runs='||(select count(*) from workflow_runs where company_id=1)||' intents='||(select count(*) from billing_checkout_sessions where company_id=1)||' reservations='||(select count(*) from subscription_usage_reservations where company_id=1) from companies c join subscriptions s on s.company_id=c.id where c.id=1"
}
# Legitimate customer activity (logins / notifications / audit) is reported, never gated.
existing_activity() {
  q "select 'company1 activity: audit='||(select count(*) from audit_logs where company_id=1)||' activity='||(select count(*) from activity_logs where company_id=1)||' sessions='||(select count(*) from sessions s join users u on u.id=s.user_id where u.company_id=1)||' notifications='||(select count(*) from notifications n join users u on u.id=n.user_id where u.company_id=1)||' login_attempts='||(select count(*) from login_attempts la join users u on lower(u.email)=lower(la.email) where u.company_id=1)"
}

# c4-verify: STRICTLY READ-ONLY deploy / schema / env / container / queue / existing-customer
# verification, used (a) before the merge against the current deploy, (b) after the deploy,
# (c) before the smoke and (d) after the smoke cleanup.
# ARG1 = expected HEAD and current-deploy.sha, ARG2 = expected previous-deploy.sha or '-',
# ARG3 = "<tag>|<expected core baseline md5 or none>|<smoke start epoch ms or 0>".
phase_c4_verify() {
  [[ "$ARG1" =~ ^[0-9a-f]{40}$ ]] || fail "ARG1 must be a commit sha"
  [[ "$ARG2" =~ ^([0-9a-f]{40}|-)$ ]] || fail "ARG2 must be a commit sha or '-'"
  local tag md5 start; tag="$(echo "$ARG3" | cut -d'|' -f1)"; md5="$(echo "$ARG3" | cut -d'|' -f2)"; start="$(echo "$ARG3" | cut -d'|' -f3)"
  [[ "$tag" =~ ^[a-z0-9]+$ ]] || fail "ARG3 tag must be alphanumeric"; [ -n "$md5" ] || md5=none; [[ "$start" =~ ^[0-9]+$ ]] || start=0
  section "read-only guard"
  if q "create temp table b20_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard did not hold"; else echo "session refuses writes (default_transaction_read_only=on): OK"; fi
  section "deploy state (expected HEAD = current-deploy.sha = $ARG1; previous-deploy.sha = $ARG2)"
  local head cur prev; head="$(git -C "$APP_DIR" rev-parse HEAD)"; cur="$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null || echo none)"; prev="$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null || echo none)"
  echo "HEAD=$head HEAD_committed=$(git -C "$APP_DIR" log -1 --format=%cI) subject=$(git -C "$APP_DIR" log -1 --format=%s | cut -c1-90)"
  echo "current-deploy.sha=$cur previous-deploy.sha=$prev dirty_entries=$(git -C "$APP_DIR" status --porcelain | wc -l) worktrees=$(git -C "$APP_DIR" worktree list | wc -l)"
  [ "$head" = "$ARG1" ] && [ "$cur" = "$ARG1" ] || fail "hosted checkout / current-deploy.sha is not $ARG1"
  [ "$ARG2" = "-" ] || [ "$prev" = "$ARG2" ] || fail "previous-deploy.sha is not $ARG2"
  [ -z "$(git -C "$APP_DIR" status --porcelain)" ] || fail "hosted checkout is dirty"
  section "schema (expected F2 $F2_CONST — Correction 4 has no schema change)"
  local fp; fp="$(fingerprint)"; echo "schema_fingerprint=$fp"; [ "$fp" = "$F2_CONST" ] || fail "schema fingerprint is not the accepted F2"
  q "select 'tables='||(select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')||' indexes='||(select count(*) from pg_indexes where schemaname='public')||' constraints='||(select count(*) from pg_constraint where connamespace='public'::regnamespace)||' plans='||(select count(*) from plans)||' plan_prices='||(select count(*) from plan_prices)||' subscriptions='||(select count(*) from subscriptions)||' companies='||(select count(*) from companies)||' users_active='||(select count(*) from users where deleted_at is null and is_active)"
  section "containers / volume / health"
  for svc in postgres api web; do cid="$(compose ps -q "$svc" || true)"; [ -n "$cid" ] || fail "$svc container absent"; docker inspect -f "$svc: id={{.Id}} image={{.Config.Image}} created={{.Created}} started={{.State.StartedAt}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}" "$cid"; [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}healthy{{end}}' "$cid")" = "healthy" ] || fail "$svc is not healthy"; done
  echo "postgres mounts: $(docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Name}}->{{.Destination}} {{end}}' "$PG_CID")"
  for v in $(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$PG_CID"); do docker volume inspect -f "volume $v: created={{.CreatedAt}} driver={{.Driver}}" "$v"; done
  local rz; rz="$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE)"; echo "readyz=$rz"; echo "$rz" | grep -q '"status":"ok"' || fail "api not ready"
  echo "healthz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/healthz || echo UNAVAILABLE)"
  section "env (non-secret keys) / billing disabled"
  echo "$(stat -c 'mode=%a owner=%U:%G size=%s mtime=%y' "$ENV_FILE")"
  echo "env sha256_prefix=$(sha256sum "$ENV_FILE" | cut -c1-16)"
  for k in COMPOSE_PROFILES JOBS_DRIVER NODE_ENV BILLING_PROVIDER BILLING_SELF_SERVICE_CHECKOUT BILLING_STRIPE_MODE; do envkey "$k" yes; done
  for k in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_BILLING_PORTAL_CONFIGURATION_ID BILLING_RETURN_URL APP_BASE_URL SMTP_HOST GEMINI_API_KEY GOOGLE_APPLICATION_CREDENTIALS; do envkey "$k"; done
  local bp; bp="$(grep -E '^BILLING_PROVIDER=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  { [ -z "$bp" ] || [ "$bp" = "none" ]; } || fail "a billing provider is configured ('$bp')"
  [ "$(grep -cE '^BILLING_SELF_SERVICE_CHECKOUT=true' "$ENV_FILE" || true)" = "0" ] || fail "self-service checkout enabled"
  [ "$(grep -cE '^STRIPE_SECRET_KEY=.+' "$ENV_FILE" || true)" = "0" ] || fail "Stripe key present"
  [ "$(q "select count(*) from plan_prices")" = "0" ] || fail "provider prices registered"
  section "durable queue"
  docker logs "$API_CID" 2>&1 | grep -E '"msg":"Durable job queue (selected|started)"' | cut -c1-200 | head -2
  [ "$(docker logs "$API_CID" 2>&1 | grep -cE '"driver":"postgres".*"Durable job queue started"')" -ge 1 ] || fail "postgres durable queue not started"
  q "select 'job_queue: '||coalesce(string_agg(status||'='||n, ' '), 'empty') from (select status, count(*) n from job_queue group by status order by status) s"
  q "select 'job_queue dead_last_24h='||count(*) from job_queue where status='dead' and dead_at > now() - interval '24 hours'"
  [ "$(q "select count(*) from job_queue where status='dead' and dead_at > now() - interval '24 hours'")" = "0" ] || fail "dead jobs in the last 24h"
  q "select 'recurring jobs (last 6h): '||coalesce(string_agg(k||'='||n||'/'||st, ' ' order by k, st), 'none') from (select split_part(coalesce(dedupe_key,''), ':', 2) k, status st, count(*) n from job_queue where name='recurring.sweep' and enqueued_at > now() - interval '6 hours' group by 1,2) s"
  section "existing customer baseline (company 1 — core state is gated, activity is reported)"
  local b m; b="$(existing_core)"; echo "$b"; m="$(printf '%s' "$b" | md5sum | cut -c1-32)"; echo "baseline_md5=$m expected=$md5"
  echo "$b" | grep -q "company1: status=active plan=free" || fail "company 1 mirror is not active/free"
  echo "$b" | grep -q "sub: status=active plan=free source=manual overrides={}" || fail "company 1 subscription is not active/free/manual without overrides"
  echo "$b" | grep -q "stripe=false" || fail "company 1 subscription carries provider ids"
  echo "company1 access (entitlement policy on the canonical status; the smoke reads accessMode from the API): $(q "select case when status='active' then 'full' when status='trialing' and (trial_expires_at is null or trial_expires_at > now()) then 'full' when status in ('past_due','cancelled') then 'read_only' else 'blocked' end from subscriptions where company_id=1")"
  [ "$md5" = "none" ] || [ "$m" = "$md5" ] || fail "existing customer core baseline changed"
  existing_activity
  section "disposable rows (must be zero)"
  local d; d="$(disposable_counts "$tag")"; echo "$d"; echo "$d" | grep -vqE '=[1-9]' || fail "disposable rows remain: $d"
  if [ "$start" != "0" ]; then
    section "queue / workers since the smoke started"
    q "select 'jobs enqueued during the smoke: '||coalesce(string_agg(name||'='||n, ' ' order by name), 'none') from (select name, count(*) n from job_queue where enqueued_at > to_timestamp($start/1000.0) group by name) s"
    [ "$(q "select count(*) from job_queue where status='dead' and dead_at > to_timestamp($start/1000.0)")" = "0" ] || fail "dead jobs appeared during the smoke"
    echo "api error-level lines since start: $(docker logs --since "$(date -u -d @$((start/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep -c '"level":50' || true)"
    echo "  by error type / status: $(docker logs --since "$(date -u -d @$((start/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep '"level":50' | grep -oE '"type":"[A-Za-z_]+"|"statusCode":[0-9]+' | sort | uniq -c | tr '\n' ' ' | tr -s ' ')"
    echo "  non-AppError error lines: $(docker logs --since "$(date -u -d @$((start/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep '"level":50' | grep -vc '"type":"_AppError"' || true)"
    { docker logs --since "$(date -u -d @$((start/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep '"level":50' | grep -v '"type":"_AppError"' | grep -viE 'authorization|token|secret|password' | cut -c1-260 | head -10; } || true
    echo "  4xx by status (all levels, since start): $(docker logs --since "$(date -u -d @$((start/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep -oE '"statusCode":4[0-9]{2}' | sort | uniq -c | tr '\n' ' ' | tr -s ' ')"
  else
    section "api log since container start (error-level lines)"
    echo "api error-level lines: $(docker logs "$API_CID" 2>&1 | grep -c '"level":50' || true)"
    echo "  non-AppError error lines: $(docker logs "$API_CID" 2>&1 | grep '"level":50' | grep -vc '"type":"_AppError"' || true)"
    { docker logs "$API_CID" 2>&1 | grep '"level":50' | grep -v '"type":"_AppError"' | grep -viE 'authorization|token|secret|password' | cut -c1-260 | tail -5; } || true
  fi
  echo "now_epoch_ms=$(date +%s%3N)"
  log "c4-verify complete (read-only)"
}

# c4-perm-column: STRICTLY READ-ONLY. Prints the RAW legacy users.permissions column,
# MFA flag and role assignments of DISPOSABLE users only (evidence that the effective
# resolver never writes the column). ARG1 = csv of user ids (all must be smoke users).
phase_c4_perm_column() {
  [[ "$ARG1" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "ARG1 must be a csv of user ids"
  [ "$(q "select count(*) from users where id in ($ARG1) and email not like '%@b20smoke.invalid'")" = "0" ] || fail "a target user is not a disposable smoke user"
  q "select 'user '||u.id||': role='||u.role||' company_id='||coalesce(u.company_id::text,'null')||' legacy_permissions='||coalesce(u.permissions::text,'null')||' mfa_enabled='||u.mfa_enabled||' roles=['||coalesce((select string_agg(r.id::text, ',' order by r.id) from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=u.id),'')||']' from users u where u.id in ($ARG1) order by u.id"
}

# c4-legacy-grant: the ONLY direct write of the Correction 4 smoke — sets the RAW legacy
# users.permissions column of ONE disposable employee to {"subscriptions":["view"]} (the
# user API deliberately ignores `permissions`, so a legacy-grant fixture cannot be created
# through the API). Guarded to a '@b20smoke.invalid' employee of a 'B20 SMOKE <tag> …'
# tenant; the whole fixture is removed by cleanup. ARG1 = user id, ARG2 = company id, ARG3 = tag.
phase_c4_legacy_grant() {
  [[ "$ARG1" =~ ^[0-9]+$ ]] && [[ "$ARG2" =~ ^[0-9]+$ ]] || fail "ARG1/ARG2 must be ids"
  [[ "$ARG3" =~ ^[a-z0-9]+$ ]] || fail "ARG3 must be the smoke tag"
  [ "$(q "select count(*) from companies where id=$ARG2 and name like 'B20 SMOKE $ARG3 %'")" = "1" ] || fail "company $ARG2 is not the smoke tenant of tag $ARG3"
  [ "$(q "select count(*) from users where id=$ARG1 and company_id=$ARG2 and role='employee' and email like 'b20-smoke-$ARG3-%@b20smoke.invalid'")" = "1" ] || fail "user $ARG1 is not a disposable employee of company $ARG2"
  echo "before: $(q "select 'user '||id||': legacy_permissions='||coalesce(permissions::text,'null') from users where id=$ARG1")"
  echo "updated=$(qw "with u as (update users set permissions='{\"subscriptions\":[\"view\"]}'::jsonb where id=$ARG1 and company_id=$ARG2 and role='employee' and email like 'b20-smoke-$ARG3-%@b20smoke.invalid' returning 1) select count(*) from u")"
  echo "after: $(q "select 'user '||id||': legacy_permissions='||coalesce(permissions::text,'null') from users where id=$ARG1")"
  log "c4-legacy-grant complete (one disposable row)"
}


# ── Batch 22 — production & provider verification support (dev VPS) ───────────
# b22-infra   READ-ONLY infrastructure evidence: published ports / host listeners,
#             env key presence (values never printed unless allow-listed and
#             non-secret), the api container's effective environment (presence
#             only), the GCS credential mount (readability only), durable queue
#             selection + payload encryption at rest, gateway readiness, provider /
#             storage / queue log messages (message text only), table counts.
# b22-objects ARG1 = check|delete, ARG2 = csv of object labels recorded by the smoke
#             (doc:<uuid> | scan:<companyId>:<scanId> | logo:<companyId>:<id>.<ext>),
#             ARG3 = tag. Runs a one-off node script INSIDE the api container with
#             the application's own storage SDK + credential: existence check, and
#             with `delete` the removal of exactly those objects (guards: every
#             label must belong to a disposable smoke tenant of this tag). Never
#             prints bucket names, object URLs or credentials.
# b22-cleanup ARG1 = smoke start epoch ms, ARG2 = tag, ARG3 = expected number of
#             email.send jobs the smoke produced. Removes the smoke's queue rows
#             (exact-count guard; encrypted payloads are never printed) and reports
#             the queue evidence before deleting.
# b22-verify  READ-ONLY. ARG1 = smoke start epoch ms, ARG2 = tag, ARG3 = pre|post.
#             Queue rows / log messages since the smoke started and the disposable
#             rows in the B22 tables (post: must be zero).
b22_guard_company() { [ "$(q "select count(*) from companies where id=$1 and name like 'B20 SMOKE $2 %'")" = "1" ] || fail "company $1 is not the disposable smoke tenant of tag $2"; }
b22_email_jobs() { q "select coalesce(string_agg('email.send job '||id||': status='||status||' attempts='||attempts||'/'||max_attempts||' envelope='||case when payload like 'gcm1.%' then 'gcm1(aes-256-gcm)' else 'OTHER' end||' last_error='||coalesce(last_error,'null')||' enqueued='||to_char(enqueued_at,'HH24:MI:SS')||' completed='||coalesce(to_char(completed_at,'HH24:MI:SS'),'null'), E'\n' order by id), 'none') from job_queue where name='email.send' and enqueued_at > to_timestamp($1/1000.0)"; }
b22_disposable() {
  q "select 'documents='||(select count(*) from documents where company_id in (select id from companies where name like 'B20 SMOKE $1 %'))||' document_versions='||(select count(*) from document_versions where company_id in (select id from companies where name like 'B20 SMOKE $1 %'))||' scans='||(select count(*) from scans where company_id in (select id from companies where name like 'B20 SMOKE $1 %'))||' ai_invocations='||(select count(*) from ai_invocations where company_id in (select id from companies where name like 'B20 SMOKE $1 %') or user_id in (select id from users where email like 'b20-smoke-$1%@b20smoke.invalid'))||' ai_settings='||(select count(*) from ai_settings where company_id in (select id from companies where name like 'B20 SMOKE $1 %'))||' ai_usage_reservations='||(select count(*) from ai_usage_reservations where company_id in (select id from companies where name like 'B20 SMOKE $1 %'))||' usage_reservations='||(select count(*) from subscription_usage_reservations where company_id in (select id from companies where name like 'B20 SMOKE $1 %'))||' invitations='||(select count(*) from invitations where company_id in (select id from companies where name like 'B20 SMOKE $1 %') or email like 'b20-smoke-$1%@b20smoke.invalid')||' email_jobs_since_start='||(select count(*) from job_queue where name='email.send' and enqueued_at > to_timestamp($2/1000.0))"
}
b22_log_msgs() { # $1 = docker logs --since value or empty; message text only, provider/storage/queue related
  local since=(); [ -n "${1:-}" ] && since=(--since "$1")
  { docker logs "${since[@]}" "$API_CID" 2>&1 | grep -iE '"msg":"[^"]*(e-?mail|smtp|storage|bucket|branding|gemini|provider|ai |ocr|scan|durable|queue|worker|scheduler|sweep|recovery)[^"]*"' | grep -oE '"level":[0-9]+|"msg":"[^"]+"' | paste -d' ' - - | sort | uniq -c | sort -rn | head -30; } || echo "(no matching log lines)"
}

phase_b22_infra() {
  local tag="${ARG1:-none}"
  section "read-only guard"
  if q "create temp table b22_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard did not hold"; else echo "session refuses writes (default_transaction_read_only=on): OK"; fi
  section "published ports (compose HostConfig.PortBindings — only web on 127.0.0.1:18080 may be published)"
  for svc in api web postgres; do cid="$(compose ps -q "$svc" || true)"; [ -n "$cid" ] || fail "$svc container absent"; echo "$svc: bindings=$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$cid") exposed=$(docker inspect -f '{{json .Config.ExposedPorts}}' "$cid")"; done
  [ "$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$(compose ps -q api)")" = "{}" ] || [ "$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$(compose ps -q api)")" = "null" ] || fail "api publishes a host port"
  [ "$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$PG_CID")" = "{}" ] || [ "$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$PG_CID")" = "null" ] || fail "postgres publishes a host port"
  docker inspect -f '{{json .HostConfig.PortBindings}}' "$(compose ps -q web)" | grep -q '"127.0.0.1"' || fail "web is not bound to loopback"
  section "host listeners on the stack's ports (ss; 80/443/8443 belong to the CloudPanel edge)"
  if command -v ss >/dev/null 2>&1; then ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E ':(18080|8080|5000|5432|80|443|8443)$' | sort -u | sed 's/^/listen /' || echo "(no matching listener)"; else echo "ss unavailable"; fi
  section "env file keys (allow-listed non-secret values; presence only for everything else)"
  echo "$(stat -c 'mode=%a owner=%U:%G size=%s mtime=%y' "$ENV_FILE") sha256_prefix=$(sha256sum "$ENV_FILE" | cut -c1-16)"
  for k in COMPOSE_PROFILES NODE_ENV LOG_LEVEL TRUST_PROXY JOBS_DRIVER JOBS_ASYNC_EMAIL OBJECT_STORAGE_AUTH EMAIL_PROVIDER AI_PROVIDER AI_ENABLE_STUB BILLING_PROVIDER BILLING_SELF_SERVICE_CHECKOUT BILLING_STRIPE_MODE; do envkey "$k" yes; done
  for k in DEFAULT_OBJECT_STORAGE_BUCKET_ID PUBLIC_OBJECT_SEARCH_PATHS PRIVATE_OBJECT_DIR GOOGLE_APPLICATION_CREDENTIALS GCS_CREDENTIAL_GID GEMINI_API_KEY AI_INTEGRATIONS_GEMINI_API_KEY AI_INTEGRATIONS_GEMINI_BASE_URL SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASS EMAIL_FROM EMAIL_FROM_NAME EMAIL_BRAND_NAME APP_BASE_URL BILLING_RETURN_URL JOBS_PAYLOAD_ENCRYPTION_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET EXPO_ACCESS_TOKEN REPL_ID REPLIT_DOMAINS; do envkey "$k"; done
  section "api container effective environment (presence only; values printed for allow-listed non-secret keys)"
  compose exec -T -e B22_KEYS="NODE_ENV,PORT,LOG_LEVEL,TRUST_PROXY,JOBS_DRIVER,JOBS_ASYNC_EMAIL,JOBS_PAYLOAD_ENCRYPTION_KEY,OBJECT_STORAGE_AUTH,DEFAULT_OBJECT_STORAGE_BUCKET_ID,PUBLIC_OBJECT_SEARCH_PATHS,PRIVATE_OBJECT_DIR,GOOGLE_APPLICATION_CREDENTIALS,REPL_ID,AI_PROVIDER,AI_ENABLE_STUB,GEMINI_API_KEY,AI_INTEGRATIONS_GEMINI_API_KEY,AI_INTEGRATIONS_GEMINI_BASE_URL,EMAIL_PROVIDER,SMTP_HOST,SMTP_PORT,SMTP_SECURE,SMTP_USER,SMTP_PASS,EMAIL_FROM,APP_BASE_URL,BILLING_PROVIDER,BILLING_SELF_SERVICE_CHECKOUT,STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET" api node -e 'const allow=new Set(["NODE_ENV","PORT","LOG_LEVEL","TRUST_PROXY","JOBS_DRIVER","JOBS_ASYNC_EMAIL","OBJECT_STORAGE_AUTH","AI_PROVIDER","AI_ENABLE_STUB","EMAIL_PROVIDER","BILLING_PROVIDER","BILLING_SELF_SERVICE_CHECKOUT"]); for (const k of process.env.B22_KEYS.split(",")) { const v = process.env[k]; console.log(k + ": " + (v === undefined ? "unset" : v === "" ? "set-but-empty" : allow.has(k) ? "\x27" + v + "\x27" : "set")); }'
  section "GCS credential mount (readability only — nothing about the credential is printed)"
  compose exec -T api sh -c 'p="${GOOGLE_APPLICATION_CREDENTIALS:-}"; if [ -z "$p" ]; then echo "GOOGLE_APPLICATION_CREDENTIALS: unset"; elif [ -r "$p" ]; then echo "credential file: present and readable by the api process (uid $(id -u), groups $(id -G | wc -w))"; else echo "credential file: NOT readable by the api process"; fi'
  local gcsf=/opt/lead-capture-pro/env/gcs-service-account.json; if [ -f "$gcsf" ]; then echo "host key file: $(stat -c 'mode=%a owner=%U:%G size=%s' "$gcsf")"; else echo "host key file: absent at the documented path"; fi
  echo "api container supplemental groups: $(docker inspect -f '{{json .HostConfig.GroupAdd}}' "$(compose ps -q api)" | sed -E 's/[0-9]+/<gid>/g')"
  echo "api container mounts: $(docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Destination}}:{{if .RW}}rw{{else}}ro{{end}} {{end}}' "$(compose ps -q api)")"
  section "durable queue selection + payload encryption at rest"
  { docker logs "$API_CID" 2>&1 | grep -E '"msg":"Durable job queue (selected|started)"' | grep -oE '"driver":"[a-z]+"|"concurrency":[0-9]+|"leaseMs":[0-9]+|"msg":"[^"]+"' | tr '\n' ' '; } || true; echo
  [ "$(docker logs "$API_CID" 2>&1 | grep -cE '"driver":"postgres".*"Durable job queue started"')" -ge 1 ] || fail "postgres durable queue not started"
  q "select 'job_queue rows='||count(*)||' encrypted_envelope(gcm1.)='||count(*) filter (where payload like 'gcm1.%')||' four_part_envelopes='||count(*) filter (where array_length(string_to_array(payload,'.'),1)=4)||' plaintext_or_other='||count(*) filter (where payload not like 'gcm1.%')||' with_last_error='||count(*) filter (where last_error is not null)||' min_payload_len='||coalesce(min(length(payload))::text,'-')||' max_payload_len='||coalesce(max(length(payload))::text,'-') from job_queue"
  [ "$(q "select count(*) from job_queue where payload not like 'gcm1.%'")" = "0" ] || fail "job_queue holds a payload outside the encrypted envelope format"
  q "select 'job_queue by name: '||coalesce(string_agg(name||'='||n, ' ' order by name),'empty') from (select name, count(*) n from job_queue group by name) s"
  q "select 'job_queue by status: '||coalesce(string_agg(status||'='||n, ' ' order by status),'empty') from (select status, count(*) n from job_queue group by status) s"
  q "select 'job_queue dead_last_7d='||count(*) from job_queue where status='dead' and dead_at > now() - interval '7 days'"
  section "readiness / liveness through the stack gateway (loopback)"
  echo "web healthz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/healthz | tr -d '\n' || echo UNAVAILABLE)"
  echo "api healthz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/healthz || echo UNAVAILABLE)"
  local rz; rz="$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE)"; echo "api readyz=$rz"; echo "$rz" | grep -q '"storage":"ok"' || fail "readyz storage probe is not ok"
  section "api log since container start — provider / storage / queue messages (message text only)"
  b22_log_msgs ""
  echo "api error-level lines since container start: $(docker logs "$API_CID" 2>&1 | grep -c '"level":50' || true); non-AppError: $(docker logs "$API_CID" 2>&1 | grep '"level":50' | grep -vc '"type":"_AppError"' || true)"
  section "web container (nginx) log since container start — error-level lines (message text only)"
  local WEB_CID; WEB_CID="$(compose ps -q web || true)"
  echo "web nginx error/crit/emerg lines: $(docker logs "$WEB_CID" 2>&1 | grep -ciE '\[(error|crit|emerg|alert)\]' || true); web 5xx access lines: $(docker logs "$WEB_CID" 2>&1 | grep -cE '" 5[0-9]{2} ' || true); web 503 access lines: $(docker logs "$WEB_CID" 2>&1 | grep -cE '" 503 ' || true)"
  { docker logs "$WEB_CID" 2>&1 | grep -iE '\[(error|crit|emerg|alert)\]' | sed -E 's/[0-9]{1,3}(\.[0-9]{1,3}){3}/<ip>/g' | cut -c1-200 | tail -3; } || true
  section "table counts (global, no content)"
  q "select 'documents='||(select count(*) from documents)||' document_versions='||(select count(*) from document_versions)||' scans='||(select count(*) from scans)||' ai_invocations='||(select count(*) from ai_invocations)||' ai_settings='||(select count(*) from ai_settings)||' ai_usage_reservations='||(select count(*) from ai_usage_reservations)||' usage_reservations='||(select count(*) from subscription_usage_reservations)||' invitations='||(select count(*) from invitations)||' companies='||(select count(*) from companies)||' users_active='||(select count(*) from users where deleted_at is null and is_active)"
  section "disposable rows in the B22 tables (must be zero before the smoke)"
  local d; d="$(b22_disposable "$tag" 0 | sed 's/ email_jobs_since_start=.*//')"; echo "$d"; echo "$d" | grep -vqE '=[1-9]' || fail "disposable rows remain: $d"
  echo "now_epoch_ms=$(date +%s%3N)"
  log "b22-infra complete (read-only)"
}

phase_b22_objects() {
  [[ "$ARG1" =~ ^(check|delete)$ ]] || fail "ARG1 must be check|delete"
  [[ "$ARG2" =~ ^(none|[a-z]+:[A-Za-z0-9.:-]+(,[a-z]+:[A-Za-z0-9.:-]+)*)$ ]] || fail "ARG2 must be a csv of object labels or 'none'"
  [[ "$ARG3" =~ ^[a-z0-9]+$ ]] || fail "ARG3 must be the smoke tag"
  if [ "$ARG2" = "none" ]; then echo "no object labels recorded"; return; fi
  section "guards ($ARG1): every label must belong to a disposable smoke tenant of tag $ARG3"
  local lbl rest cid sid file uuid
  for lbl in ${ARG2//,/ }; do
    case "$lbl" in
      doc:*) uuid="${lbl#doc:}"; [[ "$uuid" =~ ^[0-9a-f-]{36}$ ]] || fail "bad doc label"
        if [ "$ARG1" = "delete" ]; then [ "$(q "select count(*) from document_versions v join companies c on c.id=v.company_id where v.object_path='/objects/uploads/$uuid' and c.name like 'B20 SMOKE $ARG3 %'")" = "1" ] || fail "document object $uuid is not referenced by a disposable smoke tenant of tag $ARG3"; fi
        echo "$lbl: guard ok" ;;
      scan:*) rest="${lbl#scan:}"; cid="${rest%%:*}"; sid="${rest##*:}"; [[ "$cid" =~ ^[0-9]+$ && "$sid" =~ ^[0-9]+$ ]] || fail "bad scan label"
        if [ "$ARG1" = "delete" ]; then b22_guard_company "$cid" "$ARG3"; [ "$(q "select count(*) from scans where id=$sid and company_id=$cid")" = "1" ] || fail "scan $sid is not a row of disposable company $cid"; fi
        echo "$lbl: guard ok" ;;
      logo:*) rest="${lbl#logo:}"; cid="${rest%%:*}"; file="${rest#*:}"; [[ "$cid" =~ ^[0-9]+$ && "$file" =~ ^[0-9a-f]{32}\.(png|jpg)$ ]] || fail "bad logo label"
        if [ "$ARG1" = "delete" ]; then
          # The tenant must be a disposable smoke tenant of this tag — or already removed by the cleanup
          # (an orphaned logo object of a deleted disposable tenant); a logo of any EXISTING non-smoke tenant is refused.
          if [ "$(q "select count(*) from companies where id=$cid")" = "0" ]; then echo "$lbl: company $cid no longer exists (orphaned object of a removed disposable tenant)"; else b22_guard_company "$cid" "$ARG3"; fi
        fi
        echo "$lbl: guard ok" ;;
      exp:*) uuid="${lbl#exp:}"; [[ "$uuid" =~ ^[0-9a-f-]{36}$ ]] || fail "bad export label"
        # G-3: an export object is deletable only while an export_runs row of a disposable smoke tenant of this tag references it.
        if [ "$ARG1" = "delete" ]; then [ "$(q "select count(*) from export_runs r join companies c on c.id=r.company_id where r.object_path='/objects/uploads/$uuid' and c.name like 'B20 SMOKE $ARG3 %'")" = "1" ] || fail "export object $uuid is not referenced by a disposable smoke tenant of tag $ARG3"; fi
        echo "$lbl: guard ok" ;;
      *) fail "unknown label kind: $lbl" ;;
    esac
  done
  section "object storage ($ARG1) — inside the api container with the application's own SDK + credential"
  compose exec -T -e B22_ACTION="$ARG1" -e B22_LABELS="$ARG2" api node -e '
const { Storage } = require("@google-cloud/storage");
const s = new Storage();
const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID || "";
const priv = (process.env.PRIVATE_OBJECT_DIR || "").split("/").filter(Boolean).slice(1).join("/");
if (!bucket || !priv) { console.log("object storage is not configured in this container"); process.exit(2); }
const action = process.env.B22_ACTION, labels = process.env.B22_LABELS.split(",");
const nameOf = (l) => { const [k, ...r] = l.split(":"); if (k === "doc" || k === "exp") return priv + "/uploads/" + r[0]; if (k === "scan") return "scans/" + r[0] + "/" + r[1] + ".jpg"; if (k === "logo") return "branding/" + r[0] + "/" + r[1]; throw new Error("bad label"); };
(async () => {
  let rc = 0;
  for (const l of labels) {
    try {
      const f = s.bucket(bucket).file(nameOf(l));
      const [ex] = await f.exists();
      let out = l + " exists=" + ex;
      if (ex) { const [md] = await f.getMetadata(); out += " size=" + (md.size ?? "?") + " contentType=" + (md.contentType ?? "?") + " md5=" + (md.md5Hash ? Buffer.from(md.md5Hash, "base64").toString("hex") : "?"); }
      if (action === "delete") { if (ex) { await f.delete(); const [ex2] = await f.exists(); out += " deleted=true exists_after=" + ex2; if (ex2) rc = 1; } else { out += " deleted=false(already-absent)"; } }
      console.log(out);
    } catch (e) { console.log(l + " error=" + (e && e.constructor ? e.constructor.name : "Error") + " code=" + (e && e.code != null ? e.code : "-")); rc = 1; }
  }
  process.exit(rc);
})();'
  log "b22-objects ($ARG1) complete"
}

phase_b22_cleanup() {
  [[ "$ARG1" =~ ^[0-9]+$ ]] || fail "ARG1 must be the smoke start epoch ms"
  [[ "$ARG2" =~ ^[a-z0-9]+$ ]] || fail "ARG2 must be the smoke tag"
  [[ "$ARG3" =~ ^[0-9]+$ ]] || fail "ARG3 must be the expected email.send job count"
  section "disposable tenants of tag $ARG2 (ids only)"
  echo "companies: $(q "select coalesce(string_agg(id::text, ','),'none') from companies where name like 'B20 SMOKE $ARG2 %'")"
  section "B22 rows before (documents / scans / AI ledger / invitations / queue)"
  b22_disposable "$ARG2" "$ARG1"
  section "queued e-mail jobs produced by the smoke (exact-count guard; encrypted envelopes are never printed)"
  local n; n="$(q "select count(*) from job_queue where name='email.send' and enqueued_at > to_timestamp($ARG1/1000.0)")"
  echo "email.send jobs since smoke start: $n (expected $ARG3)"
  b22_email_jobs "$ARG1"
  [ "$n" = "$ARG3" ] || fail "email.send job count since start ($n) differs from the smoke's expectation ($ARG3) — no queue row deleted"
  [ "$(q "select count(*) from job_queue where name='email.send' and enqueued_at > to_timestamp($ARG1/1000.0) and status <> 'completed'")" = "0" ] || fail "an email.send job of the smoke is not completed — no queue row deleted"
  echo "email_jobs_deleted=$(qw "with d as (delete from job_queue where name='email.send' and enqueued_at > to_timestamp($ARG1/1000.0) returning 1) select count(*) from d")"
  echo "email_jobs_remaining_since_start=$(q "select count(*) from job_queue where name='email.send' and enqueued_at > to_timestamp($ARG1/1000.0)")"
  log "b22-cleanup complete (tenant rows are removed by the generic cleanup phase)"
}

phase_b22_verify() {
  [[ "$ARG1" =~ ^[0-9]+$ ]] || fail "ARG1 must be the smoke start epoch ms"
  [[ "$ARG2" =~ ^[a-z0-9]+$ ]] || fail "ARG2 must be the smoke tag"
  [[ "$ARG3" =~ ^(pre|post)$ ]] || fail "ARG3 must be pre|post"
  section "read-only guard"
  if q "create temp table b22_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard did not hold"; else echo "session refuses writes (default_transaction_read_only=on): OK"; fi
  section "queue rows since the smoke started"
  q "select 'jobs enqueued since start: '||coalesce(string_agg(name||'='||n||'('||st||')', ' ' order by name, st), 'none') from (select name, status st, count(*) n from job_queue where enqueued_at > to_timestamp($ARG1/1000.0) group by 1,2) s"
  b22_email_jobs "$ARG1"
  [ "$(q "select count(*) from job_queue where status='dead' and dead_at > to_timestamp($ARG1/1000.0)")" = "0" ] || fail "dead jobs appeared during the smoke"
  section "api log since the smoke started — provider / storage / queue messages (message text only)"
  b22_log_msgs "$(date -u -d @$((ARG1/1000)) +%FT%TZ)"
  echo "email-skip lines (provider not configured): $(docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep -c '"msg":"Email skipped: provider not configured' || true)"
  echo "email-sent lines: $(docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep -c '"msg":"Email delivered"' || true)"
  echo "api error-level lines since start: $(docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep -c '"level":50' || true)"
  echo "  by error type / status: $(docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep '"level":50' | grep -oE '"type":"[A-Za-z_]+"|"statusCode":[0-9]+' | sort | uniq -c | tr '\n' ' ' | tr -s ' ')"
  echo "  non-AppError error lines: $(docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep '"level":50' | grep -vc '"type":"_AppError"' || true)"
  { docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep '"level":50' | grep -v '"type":"_AppError"' | grep -oE '"msg":"[^"]+"|"type":"[A-Za-z_]+"|"name":"[A-Za-z_]+"' | paste -d' ' - - - | sort | uniq -c | head -10; } || true
  section "scan rows / scan reservations / AI ledger of the disposable tenants (status breakdown)"
  local CIDS="(select id from companies where name like 'B20 SMOKE $ARG2 %')"
  q "select 'scans: '||coalesce(string_agg(status||'='||n, ' ' order by status),'none')||' with_stored_image='||(select count(*) from scans where company_id in $CIDS and image_url is not null) from (select status, count(*) n from scans where company_id in $CIDS group by status) s"
  q "select 'scan_reservations: '||coalesce(string_agg(status||'='||n, ' ' order by status),'none') from (select status, count(*) n from subscription_usage_reservations where company_id in $CIDS group by status) s"
  q "select 'ai_invocations: '||coalesce(string_agg(feature||'/'||status||'='||n, ' ' order by feature, status),'none') from (select feature, status, count(*) n from ai_invocations where company_id in $CIDS group by feature, status) s"
  section "api log since the smoke started — AI readiness signals"
  echo "503 responses logged: $(docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep -c '"statusCode":503' || true)"
  echo "'AI request refused: provider is not configured' warnings (the correction's expected entry): $(docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep -c '"msg":"AI request refused: provider is not configured' || true)"
  echo "'AI request failed' errors (the PRE-correction path; must be 0): $(docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep -c '"msg":"AI request failed"' || true)"
  echo "'Gemini is not configured' adapter errors (must be 0): $(docker logs --since "$(date -u -d @$((ARG1/1000)) +%FT%TZ)" "$API_CID" 2>&1 | grep -c 'Gemini is not configured' || true)"
  section "disposable rows in the B22 tables ($ARG3)"
  local d; d="$(b22_disposable "$ARG2" "$ARG1")"; echo "$d"
  if [ "$ARG3" = "post" ]; then echo "$d" | grep -vqE '=[1-9]' || fail "disposable B22 rows remain: $d"; fi
  echo "readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE)"
  log "b22-verify ($ARG3) complete (read-only)"
}


# b22-listener  READ-ONLY: identify what listens on the host's loopback port 5432
#               (owner / service / binding / stack membership). Inspection only —
#               never stops, restarts or reconfigures anything; prints no secrets.
# ── Batch 23 G-3: hosted protected-export verification support ───────────────
# g3-count : READ-ONLY object-storage baseline — object COUNTS per application
#            prefix (private uploads / scans / branding) and in total, through the
#            api container's own SDK + credential. No object name, size or content
#            is printed. Used before and after the smoke: the difference must be
#            exactly the objects the smoke recorded (and zero after cleanup).
phase_g3_count() {
  section "object-storage counts (read-only listing inside the api container)"
  compose exec -T api node -e '
const { Storage } = require("@google-cloud/storage");
const s = new Storage();
const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID || "";
const priv = (process.env.PRIVATE_OBJECT_DIR || "").split("/").filter(Boolean).slice(1).join("/");
if (!bucket || !priv) { console.log("object storage is not configured in this container"); process.exit(2); }
(async () => {
  const count = async (prefix) => { const [files] = await s.bucket(bucket).getFiles(prefix ? { prefix, autoPaginate: true } : { autoPaginate: true }); return files.length; };
  const uploads = await count(priv + "/uploads/"), scans = await count("scans/"), branding = await count("branding/"), total = await count("");
  console.log("objects uploads=" + uploads + " scans=" + scans + " branding=" + branding + " total=" + total + " other=" + (total - uploads - scans - branding));
})().catch((e) => { console.log("count error=" + (e && e.constructor ? e.constructor.name : "Error") + " code=" + (e && e.code != null ? e.code : "-")); process.exit(1); });'
  echo "now_epoch_ms=$(date +%s%3N)"
  log "g3-count complete (read-only)"
}

# g3-verify : READ-ONLY evidence for the export smoke. ARG1 = smoke start epoch ms,
#             ARG2 = smoke tag, ARG3 = pre|post. Prints export_runs rows of the
#             disposable tenants (metadata columns only — never the object path),
#             proves the table has no password column, shows the exports audit rows
#             (action + metadata keys), the queue rows since the start, and api-log
#             counters (lines mentioning "password" must be 0). `post` fails if any
#             disposable export_runs row remains.
phase_g3_verify() {
  [[ "$ARG1" =~ ^[0-9]+$ ]] || fail "ARG1 must be the smoke start epoch ms"
  [[ "$ARG2" =~ ^[a-z0-9]+$ ]] || fail "ARG2 must be the smoke tag"
  [[ "$ARG3" =~ ^(pre|post)$ ]] || fail "ARG3 must be pre|post"
  section "read-only guard"
  if q "create temp table g3_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard did not hold"; else echo "session refuses writes (default_transaction_read_only=on): OK"; fi
  local CIDS="(select id from companies where name like 'B20 SMOKE $ARG2 %')"
  section "export_runs schema (column names only — proves no password / secret column exists)"
  q "select 'export_runs columns: '||string_agg(column_name, ', ' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='export_runs'"
  [ "$(q "select count(*) from information_schema.columns where table_schema='public' and table_name='export_runs' and column_name ~* 'pass(word)?$|secret|key$|url'")" = "0" ] || fail "export_runs has a password/secret/url-shaped column"
  section "export_runs rows of the disposable tenants ($ARG3) — metadata only, object path never printed"
  q "select coalesce(string_agg('run '||id||': company='||company_id||' entity='||entity_type||' format='||format||' status='||status||' file_size='||file_size||' row_count='||row_count||' password_protected='||coalesce(password_protected,'null')||' has_object_path='||(object_path is not null)||' object_path_shape='||case when object_path ~ '^/objects/uploads/[0-9a-f-]{36}$' then 'normalized-uuid' when object_path is null then 'null' else 'OTHER' end||' file_name_ext='||regexp_replace(file_name,'^.*\.','')||' error='||coalesce(error,'null')||' schedule='||coalesce(schedule_id::text,'null'), E'\n' order by id), 'none') from export_runs where company_id in $CIDS"
  echo "disposable_export_runs=$(q "select count(*) from export_runs where company_id in $CIDS")"
  echo "export_runs rows of OTHER tenants created since the smoke started (must be 0): $(q "select count(*) from export_runs where company_id not in $CIDS and created_at > to_timestamp($ARG1/1000.0)")"
  section "audit rows of the disposable tenants for the exports module (action + metadata keys only)"
  q "select coalesce(string_agg(action||' keys='||coalesce((select string_agg(k, ',' order by k) from jsonb_object_keys(coalesce(metadata,'{}'::jsonb)) k),'-')||' n='||n, E'\n' order by action), 'none') from (select action, metadata, count(*) n from audit_logs where company_id in $CIDS and action like 'exports.%' group by action, metadata) s"
  [ "$(q "select count(*) from audit_logs where company_id in $CIDS and action like 'exports.%' and (metadata::text ~* 'password|X-Goog|storage.googleapis' )")" = "0" ] || fail "an exports audit row carries password/URL material"
  section "queue rows since the smoke started (exports are produced synchronously; no export job is expected)"
  q "select 'jobs enqueued since start: '||coalesce(string_agg(name||'='||n||'('||st||')', ' ' order by name, st), 'none') from (select name, status st, count(*) n from job_queue where enqueued_at > to_timestamp($ARG1/1000.0) group by 1,2) s"
  [ "$(q "select count(*) from job_queue where status='dead' and dead_at > to_timestamp($ARG1/1000.0)")" = "0" ] || fail "dead jobs appeared during the smoke"
  [ "$(q "select count(*) from job_queue where enqueued_at > to_timestamp($ARG1/1000.0) and payload not like 'gcm1.%'")" = "0" ] || fail "a queue row outside the encrypted envelope format appeared"
  section "api log since the smoke started (counters only)"
  local since; since="$(date -u -d @$((ARG1/1000)) +%FT%TZ)"
  echo "lines mentioning 'password' (must be 0 — request bodies are never logged): $(docker logs --since "$since" "$API_CID" 2>&1 | grep -ci 'password' || true)"
  echo "lines mentioning a signed-URL signature or the bucket host (must be 0): $(docker logs --since "$since" "$API_CID" 2>&1 | grep -cE 'X-Goog-Signature|storage\.googleapis\.com' || true)"
  echo "POST /exports responses logged (201): $(docker logs --since "$since" "$API_CID" 2>&1 | grep -cE '"url":"/api(/v1)?/exports"[^}]*"statusCode":201|"statusCode":201[^}]*"url":"/api(/v1)?/exports"' || true)"
  echo "export download-endpoint responses (200): $(docker logs --since "$since" "$API_CID" 2>&1 | grep -cE '/exports/runs/[0-9]+/download' || true)"
  echo "api error-level lines since start: $(docker logs --since "$since" "$API_CID" 2>&1 | grep -c '"level":50' || true); non-AppError: $(docker logs --since "$since" "$API_CID" 2>&1 | grep '"level":50' | grep -vc '"type":"_AppError"' || true)"
  echo "  error lines by type / status: $(docker logs --since "$since" "$API_CID" 2>&1 | grep '"level":50' | grep -oE '"type":"[A-Za-z_]+"|"statusCode":[0-9]+' | sort | uniq -c | tr '\n' ' ' | tr -s ' ')"
  [ "$(docker logs --since "$since" "$API_CID" 2>&1 | grep -ci 'password' || true)" = "0" ] || fail "the api log mentions 'password' since the smoke started"
  if [ "$ARG3" = "post" ]; then [ "$(q "select count(*) from export_runs where company_id in $CIDS")" = "0" ] || fail "disposable export_runs rows remain"; fi
  echo "readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE)"
  log "g3-verify ($ARG3) complete (read-only)"
}

phase_b22_listener() {
  section "listeners on port 5432 (ss, read-only; process names need root — shown when permitted)"
  { ss -ltnpH 'sport = :5432' 2>/dev/null || ss -ltnH 2>/dev/null | grep ':5432'; } | sed -E 's/users:\(\(([^)]*)\)\)/users:(\1)/' || echo "(none)"
  if sudo -n true 2>/dev/null; then echo "passwordless sudo: available — read-only ss/lsof with process names:"; sudo -n ss -ltnpH 'sport = :5432' 2>/dev/null || true; command -v lsof >/dev/null 2>&1 && sudo -n lsof -nP -iTCP:5432 -sTCP:LISTEN 2>/dev/null || true; else echo "passwordless sudo: not available (process names of other users are not visible; uid resolved from /proc below)"; fi
  section "/proc/net/tcp: local 5432 listeners with owning uid → user name"
  for t in /proc/net/tcp /proc/net/tcp6; do awk -v f="$t" 'NR>1 && $4=="0A" { split($2,a,":"); if (a[2]=="1538") print f ": local=" $2 " uid=" $8 " inode=" $10 }' "$t" 2>/dev/null; done
  for u in $(for t in /proc/net/tcp /proc/net/tcp6; do awk 'NR>1 && $4=="0A" { split($2,a,":"); if (a[2]=="1538") print $8 }' "$t" 2>/dev/null; done | sort -u); do echo "uid $u = $(getent passwd "$u" | cut -d: -f1,7)"; done
  section "process candidates (ps, read-only; command line truncated)"
  ps -eo pid,ppid,user,etimes,comm,args --no-headers 2>/dev/null | grep -iE 'postgres|pgbouncer|docker-proxy.*5432' | grep -v grep | cut -c1-180 || echo "(no postgres-like process visible)"
  section "systemd units / packages (read-only)"
  systemctl list-units --type=service --all --no-pager --no-legend 2>/dev/null | grep -iE 'postgres|pgbouncer|clp|cloudpanel' | cut -c1-140 || echo "(no matching unit)"
  for unit in postgresql postgresql@16-main postgresql@15-main postgresql@14-main pgbouncer; do echo "$unit: enabled=$(systemctl is-enabled "$unit" 2>/dev/null || echo n/a) active=$(systemctl is-active "$unit" 2>/dev/null || echo n/a)"; done
  dpkg -l 2>/dev/null | awk '/^ii/ && /postgres|pgbouncer/ {print "package " $2 " " $3}' || true
  command -v pg_lsclusters >/dev/null 2>&1 && pg_lsclusters 2>/dev/null || echo "pg_lsclusters: unavailable"
  section "postgres configuration listen/port (read-only, only if readable)"
  found=0; for f in /etc/postgresql/*/*/postgresql.conf; do [ -e "$f" ] || continue; found=1; if [ -r "$f" ]; then echo "$f: $(grep -E '^(listen_addresses|port)[[:space:]]*=' "$f" | tr '\n' ' ')"; else echo "$f: not readable by this user"; fi; done; [ "$found" = "1" ] || echo "(no /etc/postgresql/*/*/postgresql.conf)"
  section "docker: containers publishing 5432 (read-only) — this stack's postgres must show {}"
  docker ps -a --format '{{.Names}} image={{.Image}} status={{.Status}} ports={{.Ports}}' 2>/dev/null | grep -E '5432' || echo "(no container publishes 5432)"
  for n in $(docker ps --format '{{.Names}}' 2>/dev/null); do echo "$n: bindings=$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$n" 2>/dev/null)"; done
  echo "this stack's postgres container: $(docker inspect -f '{{.Name}} bindings={{json .HostConfig.PortBindings}} network_mode={{.HostConfig.NetworkMode}}' "$PG_CID" 2>/dev/null)"
  section "is the loopback 5432 this stack's database? (read-only probe from the host: server identity only)"
  if command -v psql >/dev/null 2>&1; then echo "host psql client: present"; else echo "host psql client: absent (no host-side connection attempted)"; fi
  echo "stack db server_version (inside the container): $(q "select version()" 2>/dev/null | cut -c1-60)"
  log "b22-listener complete (read-only)"
}

# =============================================================================
# B23 G-6 — backup inventory + ISOLATED restore rehearsal (dev VPS).
#   g6-inventory : STRICTLY READ-ONLY. UTC baseline, deploy/containers/volumes/
#                  images, live schema + size, the effective backup script, what
#                  actually schedules it (cron / systemd timers, as the deploy
#                  user), the local backup files (size, mode, gzip integrity,
#                  sha256, dump structure, COPY data-row totals), independent
#                  off-host evidence (tools/configs presence; the app's own dev
#                  bucket listed inside the api container — counts only), and the
#                  capacity gate for the rehearsal. Never prints SQL rows, names,
#                  credentials or bucket/object names.
#   g6-restore   : ONE disposable postgres container from the SAME image id the live
#                  container runs, --network none (no published port, no compose
#                  network), its own private named volume, memory/cpu capped, the
#                  chosen backup bind-mounted READ-ONLY, restore with ON_ERROR_STOP
#                  in a single transaction, verification, then cleanup by trap +
#                  absence proof. Never touches the live container / volume / env
#                  and never reads the live credentials (roles referenced by the
#                  dump are re-created in the disposable instance, names unprinted).
#   g6-verify    : READ-ONLY post-check — no g6 resource remains, backup files
#                  unchanged (sha256/mtime), live stack unchanged.
# =============================================================================
G6_BACKUP_DIR="${BACKUP_DIR:-/opt/lead-capture-pro/backups/postgres}"
g6_utc() { date -u +%FT%TZ; }
g6_mask() { sed -E 's#(postgres(ql)?://)[^[:space:]]+#\1<masked>#g; s/user "[^"]*"/user "<masked>"/g; s/[A-Za-z0-9+\/=_-]{32,}/<masked>/g'; }
g6_backup_lines() {
  # One line per backup file (sorted newest first) — metadata + dump structure only.
  local now f m age gz hdr dfrom dby ct cp done_ rows ext bu
  now="$(date +%s)"
  for f in $(ls -1t "$G6_BACKUP_DIR"/leadcapture-*.sql.gz 2>/dev/null); do
    m="$(stat -c %Y "$f")"; age=$(( (now - m) / 3600 ))
    if gzip -t "$f" 2>/dev/null; then gz=ok; else gz=CORRUPT; fi
    hdr="?"; dfrom="?"; dby="?"; ct=0; cp=0; done_=0; rows=0; ext=0; bu=0
    if [ "$gz" = ok ]; then
      hdr="$(zcat "$f" 2>/dev/null | sed -n 2p | cut -c1-40 || true)"
      dfrom="$(zcat "$f" 2>/dev/null | grep -m1 -oE 'Dumped from database version [0-9.]+' | awk '{print $NF}' || true)"
      dby="$(zcat "$f" 2>/dev/null | grep -m1 -oE 'Dumped by pg_dump version [0-9.]+' | awk '{print $NF}' || true)"
      ct="$(zcat "$f" | grep -c '^CREATE TABLE ' || true)"; cp="$(zcat "$f" | grep -c '^COPY ' || true)"
      done_="$(zcat "$f" | grep -c '^-- PostgreSQL database dump complete' || true)"
      rows="$(zcat "$f" | awk '/^COPY /{c=1;next} c&&/^\\\.$/{c=0;next} c{n++} END{print n+0}')"
      ext="$(zcat "$f" | grep -c '^CREATE EXTENSION' || true)"; bu="$(zcat "$f" | wc -c)"
    fi
    echo "backup $(basename "$f"): size=$(stat -c %s "$f") mode=$(stat -c %a "$f") owner=$(stat -c %U:%G "$f") mtime_utc=$(date -u -d @"$m" +%FT%TZ) age_h=$age gzip=$gz sha256=$(sha256sum "$f" | cut -c1-64) header='$hdr' dumped_from=$dfrom pg_dump=$dby create_table=$ct copy_blocks=$cp data_rows=$rows extensions=$ext complete_marker=$done_ uncompressed_bytes=$bu"
  done
}
g6_ctr_exists() { docker ps -a --format '{{.Names}}' | grep -qx "$1"; }
g6_vol_exists() { docker volume ls -q | grep -qx "$1"; }
g6_resources() {
  echo "g6 containers (label): $(docker ps -a -q --filter label=b23.g6 | wc -l) (name prefix): $(docker ps -a --format '{{.Names}}' | grep -c '^g6-restore-' || true) g6 volumes (label): $(docker volume ls -q --filter label=b23.g6 | wc -l) (name prefix): $(docker volume ls -q | grep -c '^g6-restore-' || true) work dirs: $(ls -d "$HOME"/g6-*.?????? 2>/dev/null | wc -l)"
}
g6_stack_state() {
  section "live stack state (read-only)"
  echo "utc_now=$(g6_utc)"
  echo "HEAD=$(git -C "$APP_DIR" rev-parse HEAD) current-deploy.sha=$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null || echo none) previous-deploy.sha=$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null || echo none) dirty_entries=$(git -C "$APP_DIR" status --porcelain | wc -l)"
  for svc in postgres api web; do local cid; cid="$(compose ps -q "$svc" || true)"; [ -n "$cid" ] || fail "$svc container absent"; docker inspect -f "$svc: id={{.Id}} image={{.Config.Image}} image_id={{.Image}} created={{.Created}} started={{.State.StartedAt}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}" "$cid"; done
  echo "postgres mounts: $(docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Name}}->{{.Destination}} {{end}}' "$PG_CID")"
  for v in $(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$PG_CID"); do docker volume inspect -f "volume $v: created={{.CreatedAt}} driver={{.Driver}}" "$v"; done
  echo "all containers: $(docker ps -a --format '{{.Names}}={{.State}}' | sort | tr '\n' ' ')"
  echo "all volumes: $(docker volume ls --format '{{.Name}}' | sort | tr '\n' ' ')"
  echo "images: $(docker images --format '{{.Repository}}:{{.Tag}}@{{.ID}}' | sort | tr '\n' ' ') dangling=$(docker images -q -f dangling=true | wc -l)"
  echo "env: $(stat -c 'mode=%a size=%s mtime=%y' "$ENV_FILE") sha256_prefix=$(sha256sum "$ENV_FILE" | cut -c1-16)"
  echo "readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE) healthz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/healthz || echo UNAVAILABLE)"
  echo "schema_fingerprint=$(fingerprint) (F2 expected $F2_CONST)"
  q "select 'live: tables='||(select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')||' indexes='||(select count(*) from pg_indexes where schemaname='public')||' fks='||(select count(*) from pg_constraint where connamespace='public'::regnamespace and contype='f')||' extensions='||(select string_agg(extname||':'||extversion, ',' order by extname) from pg_extension)||' db_size_bytes='||pg_database_size(current_database())||' server_version='||current_setting('server_version')"
  q "select 'live rows: companies='||(select count(*) from companies)||' users='||(select count(*) from users)||' job_queue='||(select count(*) from job_queue)||' workflow_runs='||(select count(*) from workflow_runs)||' billing_checkout_sessions='||(select count(*) from billing_checkout_sessions)||' export_runs='||(select count(*) from export_runs)||' export_schedules='||(select count(*) from export_schedules)||' audit_logs='||(select count(*) from audit_logs)"
  g6_resources
}

phase_g6_inventory() {
  section "read-only guard"
  if q "create temp table b20_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard did not hold"; else echo "session refuses writes (default_transaction_read_only=on): OK"; fi
  g6_stack_state
  section "UTC baseline / host"
  echo "utc_now=$(g6_utc) host_tz=$(date +%Z) uptime_s=$(cut -d. -f1 /proc/uptime) nproc=$(nproc) load=$(cut -d' ' -f1-3 /proc/loadavg) docker=$(docker version -f '{{.Server.Version}}' 2>/dev/null || echo ?) compose=$(docker compose version --short 2>/dev/null || echo ?)"
  local prev; prev="$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null || true)"
  if [ -n "$prev" ]; then echo "previous-deploy.sha commit in hosted checkout: present=$(git -C "$APP_DIR" cat-file -e "$prev^{commit}" 2>/dev/null && echo yes || echo no) committed=$(git -C "$APP_DIR" log -1 --format=%cI "$prev" 2>/dev/null || echo n/a) on_origin_develop=$(git -C "$APP_DIR" merge-base --is-ancestor "$prev" origin/develop 2>/dev/null && echo yes || echo unknown)"; fi
  echo "state files: $(ls -la --time-style=+%FT%TZ "$STATE_DIR"/current-deploy.sha "$STATE_DIR"/previous-deploy.sha 2>&1 | awk '{print $1, $6, $7}' | tr '\n' ';')"
  section "effective backup script (hosted checkout)"
  local bs="$APP_DIR/docker/scripts/backup-postgres.sh"
  [ -f "$bs" ] || fail "backup script absent in the hosted checkout"
  echo "script: $(stat -c 'mode=%a owner=%U:%G size=%s mtime=%y' "$bs") blob=$(git -C "$APP_DIR" hash-object "$bs") tracked_blob=$(git -C "$APP_DIR" rev-parse HEAD:docker/scripts/backup-postgres.sh) identical=$([ "$(git -C "$APP_DIR" hash-object "$bs")" = "$(git -C "$APP_DIR" rev-parse HEAD:docker/scripts/backup-postgres.sh)" ] && echo yes || echo no)"
  echo "script defaults: $(grep -oE '^BACKUP_DIR=.*' "$bs") $(grep -oE '^KEEP=.*' "$bs") size_floor_check=$(grep -c 'ge 1024' "$bs" || true) gzip_test=$(grep -c 'gzip -t' "$bs" || true) tmp_then_rename=$(grep -cE '\.tmp|\.part|mv ' "$bs" || true) lock=$(grep -cE 'flock|lockfile' "$bs" || true) checksum_file=$(grep -cE 'sha256sum|md5sum' "$bs" || true) offhost_cmd=$(grep -cE 'rclone|gsutil|gcloud storage|rsync|scp |aws s3|restic|borg' "$bs" || true) alerting=$(grep -cE 'mail|curl|webhook' "$bs" || true)"
  section "what schedules the backup (as the deploy user; root-only files reported as unknown)"
  echo "cron daemon: $(systemctl is-active cron 2>/dev/null || systemctl is-active crond 2>/dev/null || echo unknown) enabled=$(systemctl is-enabled cron 2>/dev/null || echo unknown)"
  local uc; uc="$(crontab -l 2>/dev/null || true)"
  echo "user crontab: $(printf '%s\n' "$uc" | grep -vE '^\s*(#|$)' | grep -c . || true) active line(s); backup-postgres references=$(printf '%s\n' "$uc" | grep -vE '^\s*#' | grep -c 'backup-postgres' || true)"
  printf '%s\n' "$uc" | grep -vE '^\s*(#|$)' | g6_mask | cut -c1-220 | sed 's/^/  cron: /' || true
  echo "/etc/crontab: $( [ -r /etc/crontab ] && echo "readable backup-postgres=$(grep -c backup-postgres /etc/crontab || true)" || echo unreadable)"
  echo "/etc/cron.d: $( [ -r /etc/cron.d ] && echo "entries=$(ls -1 /etc/cron.d | wc -l) backup-postgres_files=$(grep -rl backup-postgres /etc/cron.d 2>/dev/null | wc -l)" || echo unreadable)"
  echo "/etc/cron.{hourly,daily,weekly,monthly}: backup-postgres_files=$(grep -rl backup-postgres /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly 2>/dev/null | wc -l) unreadable_dirs=$(for d in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do [ -r "$d" ] || echo "$d"; done | wc -l)"
  echo "root crontab: $( [ -r /var/spool/cron/crontabs/root ] && echo readable || echo 'not readable as this user (unknown)')"
  echo "other users' crontabs dir: $( [ -r /var/spool/cron/crontabs ] && echo "readable entries=$(ls -1 /var/spool/cron/crontabs | wc -l)" || echo 'not readable (unknown)')"
  echo "system timers: total=$(systemctl list-timers --all --no-pager --no-legend 2>/dev/null | wc -l) matching(backup|postgres|pg|lead)=$(systemctl list-timers --all --no-pager --no-legend 2>/dev/null | grep -ciE 'backup|postgres|pg|lead' || true)"
  systemctl list-timers --all --no-pager --no-legend 2>/dev/null | grep -iE 'backup|postgres|pg|lead' | cut -c1-200 | sed 's/^/  timer: /' || true
  # What do the matching system timers actually run? (unit text is not secret; values masked anyway)
  for u in $(systemctl list-timers --all --no-pager --no-legend 2>/dev/null | grep -iE 'backup|postgres|pg|lead' | awk '{print $NF}' | sort -u); do
    echo "  unit $u: $(systemctl cat "$u" 2>/dev/null | grep -E '^(Description|ExecStart|User|WorkingDirectory)=' | g6_mask | cut -c1-200 | tr '\n' ';' || echo 'not readable')"
    echo "  unit $u: mentions backup-postgres=$(systemctl cat "$u" 2>/dev/null | grep -c 'backup-postgres' || true) mentions lead-capture-pro=$(systemctl cat "$u" 2>/dev/null | grep -c 'lead-capture-pro' || true) mentions card-scanner=$(systemctl cat "$u" 2>/dev/null | grep -ci 'card-scanner\|cardscanner' || true) last=$(systemctl show -p LastTriggerUSec --value "${u%.service}.timer" 2>/dev/null || echo ?) result=$(systemctl show -p Result --value "$u" 2>/dev/null || echo ?)"
  done
  echo "user timers: $(systemctl --user list-timers --all --no-pager --no-legend 2>/dev/null | wc -l || echo 0) (user manager: $(systemctl --user is-system-running 2>/dev/null || echo unavailable))"
  systemctl --user list-timers --all --no-pager --no-legend 2>/dev/null | cut -c1-200 | sed 's/^/  user timer: /' || true
  echo "cron journal (last 14 days): $(journalctl -u cron --since '-14 days' --no-pager -q 2>/dev/null | wc -l) lines readable; backup-postgres mentions=$(journalctl -u cron --since '-14 days' --no-pager -q 2>/dev/null | grep -c backup-postgres || true); journal access=$(journalctl -u cron -n 1 --no-pager -q >/dev/null 2>&1 && echo ok || echo denied)"
  echo "syslog (grep, if readable): backup-postgres mentions=$(grep -h backup-postgres /var/log/syslog /var/log/syslog.1 2>/dev/null | wc -l) readable=$([ -r /var/log/syslog ] && echo yes || echo no)"
  echo "repo workflows with a schedule trigger: $(grep -l '^\s*schedule:' "$APP_DIR"/.github/workflows/*.yml 2>/dev/null | wc -l)"
  local bl="$G6_BACKUP_DIR/backup.log"
  if [ -f "$bl" ]; then echo "backup.log: $(stat -c 'size=%s mode=%a mtime=%y' "$bl") lines=$(wc -l <"$bl") ok_lines=$(grep -c '\[backup\] OK' "$bl" || true) error_lines=$(grep -c 'ERROR' "$bl" || true) first_ok=$(grep -m1 -oE 'leadcapture-[0-9]{8}-[0-9]{6}' "$bl" || echo none) last_ok=$(grep '\[backup\] OK' "$bl" | tail -1 | grep -oE 'leadcapture-[0-9]{8}-[0-9]{6}' || echo none)"; tail -12 "$bl" | g6_mask | cut -c1-200 | sed 's/^/  log: /'; else echo "backup.log: absent (no evidence of cron-driven runs writing the documented log)"; fi
  section "local backup inventory ($G6_BACKUP_DIR)"
  if [ ! -d "$G6_BACKUP_DIR" ]; then echo "backup directory ABSENT"; else
    echo "dir: $(stat -c 'mode=%a owner=%U:%G mtime=%y' "$G6_BACKUP_DIR") filesystem=$(df --output=source,target "$G6_BACKUP_DIR" | tail -1 | tr -s ' ') du_k=$(du -sk "$G6_BACKUP_DIR" | cut -f1) inside_docker_volume=$(case "$G6_BACKUP_DIR" in /var/lib/docker/*) echo yes;; *) echo no;; esac)"
    echo "entries: total=$(ls -1A "$G6_BACKUP_DIR" | wc -l) backups=$(ls -1 "$G6_BACKUP_DIR"/leadcapture-*.sql.gz 2>/dev/null | wc -l) other=[$(ls -1A "$G6_BACKUP_DIR" | grep -vE '^leadcapture-[0-9]{8}-[0-9]{6}\.sql\.gz$' | tr '\n' ' ')] partial_or_tmp=$(ls -1A "$G6_BACKUP_DIR" | grep -cE '\.(tmp|part|partial)$' || true)"
    g6_backup_lines
  fi
  section "selection (newest complete, gzip-valid backup)"
  local sel="" sel_sum="" sel_age="" sel_u=0 sel_m=""
  while read -r line; do
    [ -n "$line" ] || continue
    if echo "$line" | grep -q ' gzip=ok ' && echo "$line" | grep -q ' complete_marker=1 '; then
      sel="$(echo "$line" | sed -E 's/^backup ([^:]+):.*/\1/')"; sel_sum="$(echo "$line" | grep -oE 'sha256=[0-9a-f]{64}' | cut -d= -f2 || true)"; sel_age="$(echo "$line" | grep -oE 'age_h=[0-9]+' | cut -d= -f2 || true)"; sel_u="$(echo "$line" | grep -oE 'uncompressed_bytes=[0-9]+' | cut -d= -f2 || echo 0)"; sel_m="$(echo "$line" | grep -oE 'mtime_utc=[^ ]+' | cut -d= -f2 || true)"; break
    fi
  done < <(g6_backup_lines)
  local newest; newest="$(ls -1t "$G6_BACKUP_DIR"/leadcapture-*.sql.gz 2>/dev/null | head -1 | xargs -r basename || true)"
  echo "newest_file=${newest:-none} selected_backup=${sel:-none} selected_sha256=${sel_sum:-none} selected_mtime_utc=${sel_m:-none} selected_age_h=${sel_age:-none} selected_uncompressed_bytes=$sel_u newest_is_selected=$([ -n "$sel" ] && [ "$sel" = "$newest" ] && echo yes || echo no)"
  section "off-host copy evidence (independent, read-only; presence only)"
  local t; for t in rclone gsutil gcloud aws restic borg rsync duplicity s3cmd; do printf '%s=%s ' "$t" "$(command -v "$t" >/dev/null 2>&1 && echo present || echo absent)"; done; echo
  for c in "$HOME/.config/rclone/rclone.conf" "$HOME/.aws/credentials" "$HOME/.config/gcloud" "$HOME/.boto" "$HOME/.s3cfg" "$HOME/.ssh/config" "$HOME/.restic" "$HOME/.config/borg"; do printf '%s=%s ' "$(basename "$c")" "$([ -e "$c" ] && echo present || echo absent)"; done; echo
  echo "user crontab off-host commands (rclone|gsutil|gcloud|rsync|scp|aws|restic|borg|curl): $(printf '%s\n' "$uc" | grep -vE '^\s*#' | grep -cE 'rclone|gsutil|gcloud|rsync|scp|aws |restic|borg|curl' || true)"
  echo "app dev bucket (listed inside the api container with the app's own credential; counts only):"
  compose exec -T api node -e '
const { Storage } = require("@google-cloud/storage");
const s = new Storage();
const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID || "";
if (!bucket) { console.log("  object storage is not configured in this container"); process.exit(2); }
(async () => {
  const [files] = await s.bucket(bucket).getFiles({ autoPaginate: true });
  const byPrefix = {}; let backupLike = 0; let newestBackupLike = null;
  for (const f of files) {
    const p = f.name.split("/")[0] || "(root)"; byPrefix[p] = (byPrefix[p] || 0) + 1;
    if (/\.sql(\.gz)?$|\.dump$|backup|pgdump|pg_dump/i.test(f.name)) { backupLike++; const u = f.metadata && f.metadata.updated; if (u && (!newestBackupLike || u > newestBackupLike)) newestBackupLike = u; }
  }
  console.log("  objects total=" + files.length + " top-level prefixes=" + Object.keys(byPrefix).length + " backup-like objects=" + backupLike + " newest backup-like updated=" + (newestBackupLike || "none"));
  console.log("  per-prefix counts: " + Object.keys(byPrefix).sort().map((k) => (k.startsWith(".") ? k : "<prefix>") + "=" + byPrefix[k]).join(" "));
})().catch((e) => { console.log("  list error=" + (e && e.constructor ? e.constructor.name : "Error") + " code=" + (e && e.code != null ? e.code : "-")); process.exit(1); });' || echo "  bucket listing failed (see above)"
  echo "hosting-provider snapshots/backups (Hostinger panel): not verifiable from inside the VPS — unknown"
  section "capacity headroom (before creating anything)"
  local droot; droot="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  echo "docker_root=$droot"
  { df -B1 --output=target,size,avail,pcent / "$droot" "$HOME" "$G6_BACKUP_DIR" 2>/dev/null || true; } | awk 'NR>1{print "  disk " $1 " size=" $2 " avail=" $3 " used=" $4}' | sort -u || true
  awk '/MemTotal|MemAvailable|SwapTotal|SwapFree/{printf "  mem %s %d MiB\n", $1, $2/1024}' /proc/meminfo
  echo "  postgres image for the rehearsal: id=$(docker inspect -f '{{.Image}}' "$PG_CID") present=$(docker image inspect -f '{{.Id}}' "$(docker inspect -f '{{.Image}}' "$PG_CID")" >/dev/null 2>&1 && echo yes || echo no) size=$(docker image inspect -f '{{.Size}}' "$(docker inspect -f '{{.Image}}' "$PG_CID")" 2>/dev/null || echo ?)"
  g6_resources
  local avail_docker avail_home memavail need reasons=""
  avail_docker="$(df -B1 --output=avail "$droot" 2>/dev/null | tail -1 | tr -d ' ' || true)"; avail_home="$(df -B1 --output=avail "$HOME" 2>/dev/null | tail -1 | tr -d ' ' || true)"
  memavail="$(awk '/MemAvailable/{print $2*1024}' /proc/meminfo)"
  need=$(( 1073741824 + sel_u * 30 ))
  [ -n "$sel" ] || reasons="$reasons no-complete-gzip-valid-backup;"
  [ "${avail_docker:-0}" -ge "$need" ] || reasons="$reasons docker-root-avail<${need};"
  [ "${avail_home:-0}" -ge 268435456 ] || reasons="$reasons home-avail<256MiB;"
  [ "${memavail:-0}" -ge 805306368 ] || reasons="$reasons mem-available<768MiB;"
  [ "$(docker ps -a -q --filter label=b23.g6 | wc -l)" = "0" ] && [ "$(docker volume ls -q --filter label=b23.g6 | wc -l)" = "0" ] || reasons="$reasons leftover-g6-resources;"
  docker image inspect "$(docker inspect -f '{{.Image}}' "$PG_CID")" >/dev/null 2>&1 || reasons="$reasons postgres-image-missing;"
  echo "gate_inputs: docker_root_avail=$avail_docker need=$need home_avail=$avail_home mem_available=$memavail"
  if [ -z "$reasons" ]; then echo "gate=PASS"; else echo "gate=FAIL reasons=[$reasons]"; fi
  echo "now_epoch_ms=$(date +%s%3N)"
  log "g6-inventory complete (read-only)"
}

phase_g6_restore() {
  local name="$ARG1" sum="$ARG2" tag="$ARG3"
  [[ "$name" =~ ^leadcapture-[0-9]{8}-[0-9]{6}\.sql\.gz$ ]] || fail "ARG1 must be a backup file name"
  [[ "$sum" =~ ^[0-9a-f]{64}$ ]] || fail "ARG2 must be the sha256 of the backup"
  [[ "$tag" =~ ^[a-z0-9]{4,16}$ ]] || fail "ARG3 must be the run tag"
  local f="$G6_BACKUP_DIR/$name"
  section "backup selection guard"
  [ -f "$f" ] || fail "backup $name not found"
  [ "$(sha256sum "$f" | cut -c1-64)" = "$sum" ] || fail "sha256 of $name does not match the inventory"
  gzip -t "$f" || fail "gzip integrity check failed"
  [ "$(zcat "$f" | grep -c '^-- PostgreSQL database dump complete')" = "1" ] || fail "not a complete dump"
  echo "backup=$name size=$(stat -c %s "$f") mtime_utc=$(date -u -d @"$(stat -c %Y "$f")" +%FT%TZ) sha256=$sum gzip=ok complete_marker=1"
  local img
  img="$(docker inspect -f '{{.Image}}' "$PG_CID")"
  # Globals on purpose: the EXIT trap runs after this function has returned.
  G6_CNAME="g6-restore-$tag"; G6_VNAME="g6-restore-$tag-pgdata"; G6_WORK="$(mktemp -d "$HOME/g6-$tag.XXXXXX")"; chmod 700 "$G6_WORK"
  local cname="$G6_CNAME" vname="$G6_VNAME" work="$G6_WORK"
  ! g6_ctr_exists "$cname" || fail "a container named $cname already exists"
  ! g6_vol_exists "$vname" || fail "a volume named $vname already exists"
  g6_cleanup() {
    local rc=$?
    set +e
    section "cleanup (trap; always)"
    if g6_ctr_exists "$G6_CNAME"; then docker rm -f "$G6_CNAME" >/dev/null 2>&1 && echo "container $G6_CNAME removed" || echo "container $G6_CNAME REMOVAL FAILED"; else echo "container $G6_CNAME absent"; fi
    if g6_vol_exists "$G6_VNAME"; then docker volume rm -f "$G6_VNAME" >/dev/null 2>&1 && echo "volume $G6_VNAME removed" || echo "volume $G6_VNAME REMOVAL FAILED"; else echo "volume $G6_VNAME absent"; fi
    rm -rf "$G6_WORK"; echo "work dir removed: $([ -e "$G6_WORK" ] && echo NO || echo yes)"
    echo "remaining: container_exists=$(g6_ctr_exists "$G6_CNAME" && echo yes || echo no) volume_exists=$(g6_vol_exists "$G6_VNAME" && echo yes || echo no) workdir_exists=$([ -e "$G6_WORK" ] && echo yes || echo no)"
    g6_resources
    echo "cleanup_utc=$(g6_utc) phase_exit=$rc"
    exit "$rc"
  }
  trap g6_cleanup EXIT
  section "disposable isolated postgres (same image id as the live container; --network none; private volume; capped)"
  local pw; pw="$(openssl rand -hex 24)"
  docker volume create --label "b23.g6=$tag" "$vname" >/dev/null
  docker run -d --name "$cname" --label "b23.g6=$tag" --network none --memory 640m --memory-swap 640m --cpus 1 --pids-limit 256 \
    -e POSTGRES_USER=g6 -e POSTGRES_DB=g6restore -e POSTGRES_PASSWORD="$pw" -e POSTGRES_INITDB_ARGS="--data-checksums" \
    -v "$vname:/var/lib/postgresql/data" -v "$f:/backup/$name:ro" "$img" >/dev/null
  unset pw
  local i; for i in $(seq 1 90); do docker exec "$cname" pg_isready -q -U g6 -d g6restore 2>/dev/null && break; sleep 1; done
  docker exec "$cname" pg_isready -U g6 -d g6restore >/dev/null || { docker logs --tail 20 "$cname" 2>&1 | g6_mask | cut -c1-160; fail "disposable postgres did not become ready"; }
  docker inspect -f "isolation: network_mode={{.HostConfig.NetworkMode}} networks=[{{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}} {{end}}] published_ports=[{{range \$p,\$b := .NetworkSettings.Ports}}{{\$p}}->{{\$b}} {{end}}] mounts=[{{range .Mounts}}{{.Type}}:{{if eq .Type \"volume\"}}{{.Name}}{{else}}<backup-file>{{end}}->{{.Destination}}:{{if .RW}}rw{{else}}ro{{end}} {{end}}] image_id={{.Image}} memory={{.HostConfig.Memory}} nanocpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}}" "$cname"
  [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$cname")" = "none" ] || fail "disposable instance is not network-isolated"
  [ -z "$(docker inspect -f '{{range $p,$b := .NetworkSettings.Ports}}{{if $b}}{{$p}} {{end}}{{end}}' "$cname")" ] || fail "disposable instance publishes ports"
  if docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$cname" | grep -q 'card-scanner-pro_pgdata'; then fail "live volume mounted"; fi
  [ "$(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.RW}}{{end}}{{end}}' "$cname")" = "false" ] || fail "backup bind mount is not read-only"
  [ "$(docker inspect -f '{{.Image}}' "$cname")" = "$img" ] || fail "image id differs from the live container"
  echo "server: $(docker exec "$cname" postgres --version) psql: $(docker exec "$cname" psql --version)"
  echo "live container network(s) (for contrast): $(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$PG_CID")"
  section "roles referenced by the dump → created in the disposable instance (names never printed)"
  local roles n=0 r
  roles="$(zcat "$f" | grep -oE '(OWNER TO|GRANT [A-Z, ]+ ON [^;]+ TO) [^;]+' | sed -E 's/.* TO //' | tr -d '"' | grep -vE '^(PUBLIC|pg_[a-z_]+|g6)$' | sort -u || true)"
  while read -r r; do
    [ -n "$r" ] || continue
    [[ "$r" =~ ^[A-Za-z0-9_]+$ ]] || fail "unexpected role token in the dump"
    docker exec "$cname" psql -q -v ON_ERROR_STOP=1 -U g6 -d g6restore -c "create role \"$r\" login" >/dev/null 2>"$work/role.err" || { g6_mask <"$work/role.err" | cut -c1-120; fail "could not create a referenced role"; }
    n=$((n + 1))
  done <<< "$roles"
  echo "roles_created=$n"
  section "restore (gunzip → psql, ON_ERROR_STOP=1, --single-transaction, exit status checked)"
  local t0 t1 t2 rc
  echo "restore_start_utc=$(g6_utc)"; t0="$(date +%s%3N)"
  set +e
  # Decompress inside the disposable container (its own writable layer, removed with
  # it), then run psql on the file: no pipeline status to reason about.
  timeout 300 docker exec "$cname" sh -c 'gunzip -c "$0" > /tmp/g6-restore.sql' "/backup/$name" 2>"$work/gunzip.err" || { g6_mask <"$work/gunzip.err" | head -2 | cut -c1-160; fail "gunzip inside the disposable container failed"; }
  timeout 900 docker exec "$cname" psql -q -X -v ON_ERROR_STOP=1 --single-transaction -U g6 -d g6restore -f /tmp/g6-restore.sql >"$work/restore.out" 2>"$work/restore.err"
  rc=$?
  docker exec "$cname" rm -f /tmp/g6-restore.sql || true
  set -e
  t1="$(date +%s%3N)"
  echo "restore_end_utc=$(g6_utc) restore_exit=$rc restore_ms=$((t1 - t0)) stdout_lines=$(wc -l <"$work/restore.out") stderr_lines=$(wc -l <"$work/restore.err") error_lines=$(grep -cE 'ERROR|FATAL|PANIC' "$work/restore.err" || true) warning_lines=$(grep -c 'WARNING' "$work/restore.err" || true)"
  if [ "$rc" != "0" ] || grep -qE 'ERROR|FATAL|PANIC' "$work/restore.err"; then
    echo "first stderr lines (truncated; data lines omitted):"; grep -vE '^\s*$' "$work/restore.err" | head -3 | sed -E 's/(COPY|INSERT|VALUES).*/\1 <omitted>/' | g6_mask | cut -c1-160 | sed 's/^/  /'
    fail "restore FAILED (exit=$rc)"
  fi
  [ -s "$work/restore.err" ] && { echo "stderr (non-error) lines:"; head -5 "$work/restore.err" | g6_mask | cut -c1-160 | sed 's/^/  /'; }
  section "verification (disposable instance; read-only session)"
  Q() { docker exec "$cname" psql -q -X -v ON_ERROR_STOP=1 -tA -F '|' -U g6 -d g6restore -c "set default_transaction_read_only = on" -c "$1"; }
  if Q "create temp table g6_should_fail (x int)" >/dev/null 2>&1; then fail "read-only verification session did not hold"; else echo "verification session refuses writes: OK"; fi
  local cat_; cat_="$(Q "select 'tables='||(select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')||' indexes='||(select count(*) from pg_indexes where schemaname='public')||' fks='||(select count(*) from pg_constraint where connamespace='public'::regnamespace and contype='f')||' pk_unique='||(select count(*) from pg_constraint where connamespace='public'::regnamespace and contype in ('p','u'))||' sequences='||(select count(*) from information_schema.sequences where sequence_schema='public')||' extensions='||(select string_agg(extname||':'||extversion, ',' order by extname) from pg_extension)||' db_size_bytes='||pg_database_size(current_database())")"
  echo "restored catalog: $cat_"
  local d_ct d_ci d_fk d_pk d_ext
  d_ct="$(zcat "$f" | grep -c '^CREATE TABLE ' || true)"; d_ci="$(zcat "$f" | grep -cE '^CREATE (UNIQUE )?INDEX ' || true)"; d_fk="$(zcat "$f" | grep -c 'FOREIGN KEY' || true)"; d_pk="$(zcat "$f" | grep -cE 'ADD CONSTRAINT .* (PRIMARY KEY|UNIQUE) ' || true)"
  d_ext="$(zcat "$f" | grep -oE '^CREATE EXTENSION IF NOT EXISTS [A-Za-z0-9_"-]+' | awk '{print $NF}' | tr -d '"' | sort | tr '\n' ',' | sed 's/,$//' || true)"
  echo "dump structure: create_table=$d_ct create_index=$d_ci foreign_key=$d_fk pk_unique=$d_pk extensions=[${d_ext:-none}]"
  local r_ct r_ci r_fk r_pk
  r_ct="$(echo "$cat_" | grep -oE 'tables=[0-9]+' | cut -d= -f2)"; r_ci="$(echo "$cat_" | grep -oE 'indexes=[0-9]+' | cut -d= -f2)"; r_fk="$(echo "$cat_" | grep -oE 'fks=[0-9]+' | cut -d= -f2)"; r_pk="$(echo "$cat_" | grep -oE 'pk_unique=[0-9]+' | cut -d= -f2)"
  echo "structure check: tables $r_ct/$d_ct $([ "$r_ct" = "$d_ct" ] && echo MATCH || echo MISMATCH); foreign keys $r_fk/$d_fk $([ "$r_fk" = "$d_fk" ] && echo MATCH || echo MISMATCH); indexes $r_ci vs create_index+pk_unique=$((d_ci + d_pk)) $([ "$r_ci" = "$((d_ci + d_pk))" ] && echo MATCH || echo MISMATCH)"
  local ext_missing=0 e; for e in $(echo "$d_ext" | tr ',' ' '); do echo "$cat_" | grep -q "extensions=.*\b$e:" || ext_missing=$((ext_missing + 1)); done; echo "extensions from the dump present: $([ "$ext_missing" = 0 ] && echo ALL || echo "MISSING $ext_missing")"
  [ "$r_ct" = "$d_ct" ] && [ "$r_fk" = "$d_fk" ] && [ "$ext_missing" = 0 ] || fail "restored structure does not match the dump"
  local rfp; rfp="$(Q "select md5(string_agg(t, '|' order by t)) from (select table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') as t from information_schema.columns where table_schema='public' union all select 'idx:'||indexname||':'||indexdef from pg_indexes where schemaname='public' union all select 'con:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace) s")"
  echo "restored schema_fingerprint=$rfp (F0 e839d03d928fa46c20797329d2779e3e / F1 4f5776f7421880daf2d453b7466b6ffb / F2 $F2_CONST) known=$(case "$rfp" in e839d03d928fa46c20797329d2779e3e) echo F0;; 4f5776f7421880daf2d453b7466b6ffb) echo F1;; "$F2_CONST") echo F2;; *) echo other;; esac)"
  section "row counts: every restored table vs the dump's COPY blocks (aggregate counts only)"
  local list; list="$(Q "select string_agg(format('select %L||''=''||(select count(*) from %I)', table_name, table_name), ' union all ' order by table_name) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")"
  Q "$list" | sort > "$work/restored_counts.txt"
  zcat "$f" | awk '/^COPY public\./{t=$2; sub(/^public\./,"",t); gsub(/"/,"",t); n=0; c=1; next} c&&/^\\\.$/{print t"="n; c=0; next} c{n++}' | sort > "$work/dump_counts.txt"
  echo "restored tables=$(wc -l <"$work/restored_counts.txt") total_rows=$(awk -F= '{s+=$2} END{print s+0}' "$work/restored_counts.txt") | dump copy_blocks=$(wc -l <"$work/dump_counts.txt") total_rows=$(awk -F= '{s+=$2} END{print s+0}' "$work/dump_counts.txt")"
  if diff -q "$work/restored_counts.txt" "$work/dump_counts.txt" >/dev/null; then echo "copy_vs_restored=IDENTICAL (every table, every count)"; else echo "copy_vs_restored=DIFFERENT"; diff "$work/restored_counts.txt" "$work/dump_counts.txt" | head -20; fail "restored row counts differ from the dump"; fi
  echo "key tables: $(grep -E '^(companies|users|job_queue|workflow_runs|billing_checkout_sessions|export_runs|export_schedules|subscriptions|contacts|audit_logs|sessions)=' "$work/restored_counts.txt" | tr '\n' ' ')"
  echo "all tables: $(tr '\n' ' ' <"$work/restored_counts.txt")"
  section "read-only catalog / aggregate queries on the restored database"
  echo "newest timestamps in the restored data (aggregates): $(Q "select 'companies.max_created='||coalesce((select max(created_at)::text from companies),'-')||' users.max_created='||coalesce((select max(created_at)::text from users),'-')||' audit_logs.max_created='||coalesce((select max(created_at)::text from audit_logs),'-')||' job_queue.max_enqueued='||coalesce((select max(enqueued_at)::text from job_queue),'-')" 2>/dev/null || echo 'n/a (column set differs in this backup)')"
  echo "aggregates: $(Q "select 'companies='||(select count(*) from companies)||' users='||(select count(*) from users)||' users_with_company='||(select count(distinct company_id) from users where company_id is not null)||' subscriptions='||(select count(*) from subscriptions)")"
  echo "integrity spot-check (orphans must be 0): $(Q "select 'users_without_company='||(select count(*) from users u where u.company_id is not null and not exists (select 1 from companies c where c.id=u.company_id))||' subscriptions_without_company='||(select count(*) from subscriptions s where not exists (select 1 from companies c where c.id=s.company_id))")"
  t2="$(date +%s%3N)"
  local bm; bm="$(stat -c %Y "$f")"
  echo "measured: restore_ms=$((t1 - t0)) verify_ms=$((t2 - t1)) total_ms=$((t2 - t0)) backup_mtime_utc=$(date -u -d @"$bm" +%FT%TZ) recovery_point_age_at_rehearsal_h=$(( ($(date +%s) - bm) / 3600 )) verification_end_utc=$(g6_utc)"
  echo "RESTORE_REHEARSAL=PASS backup=$name"
  log "g6-restore complete"
}

phase_g6_verify() {
  section "read-only guard"
  if q "create temp table b20_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard did not hold"; else echo "session refuses writes (default_transaction_read_only=on): OK"; fi
  g6_stack_state
  section "backup files after the rehearsal (must be identical to the inventory)"
  g6_backup_lines
  section "no g6 resource may remain"
  local r; r="$(g6_resources)"; echo "$r"
  echo "$r" | grep -qE '\(label\): 0 \(name prefix\): 0 g6 volumes \(label\): 0 \(name prefix\): 0 work dirs: 0' || fail "g6 resources remain: $r"
  { df -B1 --output=target,avail / "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)" "$HOME" 2>/dev/null || true; } | awk 'NR>1{print "  disk " $1 " avail=" $2}' | sort -u || true
  awk '/MemAvailable/{printf "  mem %s %d MiB\n", $1, $2/1024}' /proc/meminfo
  echo "now_epoch_ms=$(date +%s%3N)"
  log "g6-verify complete (read-only)"
}

# =============================================================================
# B23 G-6 Correction 1 — fresh current-schema backup.
#   g6c1-preflight : STRICTLY READ-ONLY. Live state + fingerprint, complete backup
#                    list with sha256, backups created since the G-6 rehearsal,
#                    root crontab / unreadable unit through EXISTING privileges only
#                    (sudo -n, systemctl show — no new mechanism), "no backup running"
#                    checks, capacity gate. Prints PREFLIGHT=PASS|FAIL.
#   g6c1-backup    : runs the DEPLOYED backup script exactly once with KEEP=8 (the 7
#                    existing files must remain), identifies the one new file by
#                    before/after diff, verifies it (gzip -t, header, versions, marker,
#                    table/COPY counts, size, mtime, sha256), proves the 7 old files are
#                    byte-identical, and on failure removes ONLY the exact new partial
#                    file. Never prints credentials or rows.
# =============================================================================
G6_REHEARSAL_NEWEST="${G6_SINCE:-2026-09-15 15:45:11 UTC}"   # G-6: the rehearsal's newest file has mtime 15:45:10.58; anything from :11 on is genuinely newer. g6c2 overrides with the C1 capture time.
g6c1_no_backup_running() {
  local host_procs ctr_procs act
  host_procs="$(pgrep -fa 'backup-postgres\.sh|pg_dump' 2>/dev/null | grep -v "$$" | grep -vE 'b20-act\.sh|pgrep' | wc -l || true)"
  ctr_procs="$(compose exec -T postgres sh -c 'ps -o comm= 2>/dev/null | grep -c "^pg_dump" || true' 2>/dev/null | tr -d '[:space:]')"; [ -n "$ctr_procs" ] || ctr_procs="?"
  act="$(q "select count(*) from pg_stat_activity where application_name = 'pg_dump'" 2>/dev/null || echo "?")"
  echo "backup processes: host=$host_procs container_pg_dump=$ctr_procs pg_stat_activity_pg_dump=$act lock_file=$([ -e "$G6_BACKUP_DIR/.backup.lock" ] && echo present || echo absent) tmp_files=$(ls -1A "$G6_BACKUP_DIR" 2>/dev/null | grep -cE '\.(tmp|part)$' || true)"
  [ "$host_procs" = "0" ] && [ "$ctr_procs" = "0" ] && [ "$act" = "0" ]
}
phase_g6c1_preflight() {
  section "read-only guard"
  if q "create temp table b20_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard did not hold"; else echo "session refuses writes (default_transaction_read_only=on): OK"; fi
  g6_stack_state
  section "live schema fingerprint (expected F2 $F2_CONST)"
  local fp; fp="$(fingerprint)"; echo "live_fingerprint=$fp known=$([ "$fp" = "$F2_CONST" ] && echo F2 || echo other)"
  q "select 'live: tables='||(select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')||' db_size_bytes='||pg_database_size(current_database())||' server_version='||current_setting('server_version')"
  section "complete backup inventory with sha256 ($G6_BACKUP_DIR)"
  [ -d "$G6_BACKUP_DIR" ] || fail "backup directory absent"
  echo "dir: $(stat -c 'mode=%a owner=%U:%G' "$G6_BACKUP_DIR") entries=$(ls -1A "$G6_BACKUP_DIR" | wc -l) backups=$(ls -1 "$G6_BACKUP_DIR"/leadcapture-*.sql.gz 2>/dev/null | wc -l) other=[$(ls -1A "$G6_BACKUP_DIR" | grep -vE '^leadcapture-[0-9]{8}-[0-9]{6}\.sql\.gz$' | tr '\n' ' ')]"
  g6_backup_lines
  section "backups created since the G-6 rehearsal's newest file ($G6_REHEARSAL_NEWEST)"
  local since; since="$(find "$G6_BACKUP_DIR" -maxdepth 1 -name 'leadcapture-*.sql.gz' -newermt "$G6_REHEARSAL_NEWEST" -printf '%f\n' 2>/dev/null | sort || true)"
  echo "backups_since_g6=$(printf '%s\n' "$since" | grep -c . || true) [$(printf '%s' "$since" | tr '\n' ' ')]"
  section "root crontab / unreadable unit — existing read-only privileges only (no new mechanism)"
  if sudo -n true >/dev/null 2>&1; then
    echo "passwordless sudo: available to the deploy user (existing configuration)"
    echo "root crontab (sudo -n crontab -l -u root): $(sudo -n crontab -l -u root 2>/dev/null | grep -vE '^\s*(#|$)' | grep -c . || true) active line(s); backup-postgres references=$(sudo -n crontab -l -u root 2>/dev/null | grep -c backup-postgres || true)"
    sudo -n crontab -l -u root 2>/dev/null | grep -vE '^\s*(#|$)' | g6_mask | cut -c1-200 | sed 's/^/  root cron: /' || true
    echo "crontabs dir (sudo -n ls): $(sudo -n ls -1 /var/spool/cron/crontabs 2>/dev/null | wc -l) user crontab file(s): $(sudo -n ls -1 /var/spool/cron/crontabs 2>/dev/null | tr '\n' ' ')"
  else
    echo "passwordless sudo: NOT available to the deploy user — root crontab and other users' crontabs remain UNKNOWN (no privilege escalation attempted)"
  fi
  local u="elite-one-desk-backup.service"
  echo "unit $u via systemctl show (manager properties, no file read):"
  systemctl show "$u" -p Id,Description,FragmentPath,ExecStart,User,WorkingDirectory,ActiveState,Result,NRestarts 2>/dev/null | g6_mask | cut -c1-260 | sed 's/^/  /' || echo "  systemctl show failed"
  systemctl show "${u%.service}.timer" -p Id,TimersCalendar,Persistent,LastTriggerUSec,NextElapseUSecRealtime,Unit 2>/dev/null | cut -c1-200 | sed 's/^/  /' || true
  local frag; frag="$(systemctl show "$u" -p FragmentPath --value 2>/dev/null || true)"
  if [ -n "$frag" ]; then echo "  fragment: $(ls -l "$frag" 2>&1 | awk '{print $1, $3":"$4, $NF}') readable_by_deploy_user=$([ -r "$frag" ] && echo yes || echo no)"; if [ -r "$frag" ]; then grep -E '^(ExecStart|User|WorkingDirectory)=' "$frag" | g6_mask | cut -c1-200 | sed 's/^/  file: /'; fi; fi
  echo "  ExecStart executable (basename only; the unit belongs to another site): $(systemctl show "$u" -p ExecStart --value 2>/dev/null | grep -oE 'path=[^ ;]+' | head -1 | sed 's#.*/##' || echo n/a) argv_count=$(systemctl show "$u" -p ExecStart --value 2>/dev/null | grep -oE 'argv\[\]=[^;]*' | head -1 | wc -w)"
  echo "  references from the shown ExecStart: backup-postgres=$(systemctl show "$u" -p ExecStart --value 2>/dev/null | grep -c 'backup-postgres' || true) lead-capture-pro=$(systemctl show "$u" -p ExecStart --value 2>/dev/null | grep -c 'lead-capture-pro' || true) card-scanner=$(systemctl show "$u" -p ExecStart --value 2>/dev/null | grep -ci 'card-scanner\|cardscanner' || true) postgres/docker=$(systemctl show "$u" -p ExecStart --value 2>/dev/null | grep -ciE 'postgres|docker|pg_dump' || true)"
  section "no backup running"
  if g6c1_no_backup_running; then echo "no backup process detected"; else echo "a backup-related process is active"; fi
  section "capacity (backup destination filesystem and docker root)"
  local droot dest_avail droot_avail memavail dbsize need reasons=""
  droot="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  dest_avail="$(df -B1 --output=avail "$G6_BACKUP_DIR" 2>/dev/null | tail -1 | tr -d ' ' || true)"; droot_avail="$(df -B1 --output=avail "$droot" 2>/dev/null | tail -1 | tr -d ' ' || true)"
  memavail="$(awk '/MemAvailable/{print $2*1024}' /proc/meminfo)"; dbsize="$(q "select pg_database_size(current_database())")"
  need=$(( 536870912 + dbsize * 5 ))
  echo "dest_avail=$dest_avail docker_root_avail=$droot_avail mem_available=$memavail db_size=$dbsize need_dest=$need"
  [ "${dest_avail:-0}" -ge "$need" ] || reasons="$reasons dest-avail<$need;"
  [ "${droot_avail:-0}" -ge 1073741824 ] || reasons="$reasons docker-root-avail<1GiB;"
  [ "${memavail:-0}" -ge 805306368 ] || reasons="$reasons mem-available<768MiB;"
  g6c1_no_backup_running >/dev/null || reasons="$reasons backup-process-active;"
  [ "$fp" = "$F2_CONST" ] || reasons="$reasons live-schema-not-F2;"
  g6_resources; [ "$(docker ps -a -q --filter label=b23.g6 | wc -l)" = "0" ] && [ "$(docker volume ls -q --filter label=b23.g6 | wc -l)" = "0" ] || reasons="$reasons leftover-g6-resources;"
  if [ -z "$reasons" ]; then echo "PREFLIGHT=PASS"; else echo "PREFLIGHT=FAIL reasons=[$reasons]"; fi
  echo "now_epoch_ms=$(date +%s%3N)"
  log "g6c1-preflight complete (read-only)"
}

phase_g6c1_backup() {
  local tag="$ARG1" expect_fp="$ARG2"
  [[ "$tag" =~ ^[a-z0-9]{4,16}$ ]] || fail "ARG1 must be the run tag"
  [[ "$expect_fp" =~ ^[0-9a-f]{32}$ ]] || fail "ARG2 must be the live schema fingerprint observed at preflight"
  local bs="$APP_DIR/docker/scripts/backup-postgres.sh"; [ -f "$bs" ] || fail "deployed backup script absent"
  section "guards before writing anything"
  echo "deployed script blob=$(git -C "$APP_DIR" hash-object "$bs") tracked=$(git -C "$APP_DIR" rev-parse HEAD:docker/scripts/backup-postgres.sh)"
  [ "$(git -C "$APP_DIR" hash-object "$bs")" = "$(git -C "$APP_DIR" rev-parse HEAD:docker/scripts/backup-postgres.sh)" ] || fail "deployed backup script differs from the tracked blob"
  local fp; fp="$(fingerprint)"; echo "live_fingerprint=$fp expected=$expect_fp"; [ "$fp" = "$expect_fp" ] || fail "live schema changed since preflight — stopping"
  g6c1_no_backup_running || fail "a backup-related process is active — stopping"
  local before after n_before; before="$(cd "$G6_BACKUP_DIR" && for f in leadcapture-*.sql.gz; do [ -f "$f" ] && echo "$f $(stat -c %s "$f") $(sha256sum "$f" | cut -c1-64) $(stat -c %Y "$f")"; done | sort)"
  n_before="$(printf '%s\n' "$before" | grep -c . || true)"
  echo "before: $n_before backup(s)"; printf '%s\n' "$before" | sed 's/^/  before: /'
  local expect_n="${ARG3:-7}"; [[ "$expect_n" =~ ^[0-9]+$ ]] || fail "ARG3 must be the expected number of pre-existing backups"
  [ "$n_before" = "$expect_n" ] || fail "expected exactly $expect_n pre-existing backups (found $n_before) — stopping before creating anything"
  local keep=$((n_before + 1)); echo "KEEP for this run = $keep (existing $n_before + 1: nothing may be pruned)"
  local dbsize dest_avail; dbsize="$(q "select pg_database_size(current_database())")"; dest_avail="$(df -B1 --output=avail "$G6_BACKUP_DIR" | tail -1 | tr -d ' ')"
  [ "$dest_avail" -ge $(( 536870912 + dbsize * 5 )) ] || fail "insufficient space on the backup filesystem"
  section "run the DEPLOYED backup script once with KEEP=$keep (pg_dump inside the live container over the socket; no restart, no schema/data change)"
  local work; work="$(mktemp -d "$HOME/g6c1-$tag.XXXXXX")"; chmod 700 "$work"
  local t0 t1 rc; t0="$(date +%s%3N)"; echo "backup_start_utc=$(g6_utc)"
  set +e
  (cd "$APP_DIR" && DEPLOY_PATH="$APP_DIR" KEEP="$keep" timeout 600 bash docker/scripts/backup-postgres.sh) >"$work/backup.out" 2>&1
  rc=$?
  set -e
  t1="$(date +%s%3N)"; echo "backup_end_utc=$(g6_utc) script_exit=$rc script_ms=$((t1 - t0))"
  echo "script output (masked):"; g6_mask <"$work/backup.out" | cut -c1-200 | sed 's/^/  /'
  after="$(cd "$G6_BACKUP_DIR" && for f in leadcapture-*.sql.gz; do [ -f "$f" ] && echo "$f $(stat -c %s "$f") $(sha256sum "$f" | cut -c1-64) $(stat -c %Y "$f")"; done | sort)"
  local new; new="$(comm -13 <(printf '%s\n' "$before" | awk '{print $1}') <(printf '%s\n' "$after" | awk '{print $1}'))"
  local n_new; n_new="$(printf '%s\n' "$new" | grep -c . || true)"
  echo "after: $(printf '%s\n' "$after" | grep -c . || true) backup(s); new file(s): $n_new [$(printf '%s' "$new" | tr '\n' ' ')]"
  local old_ok; old_ok="$(comm -12 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | wc -l)"
  echo "pre-existing backups byte-identical (name, size, sha256, mtime): $old_ok/$n_before"
  if [ "$rc" != "0" ]; then
    echo "BACKUP SCRIPT FAILED (exit $rc)"
    if [ "$n_new" = "1" ]; then
      local nf="$new"; [[ "$nf" =~ ^leadcapture-[0-9]{8}-[0-9]{6}\.sql\.gz$ ]] || fail "unexpected new file name after a failed run — left untouched"
      printf '%s\n' "$before" | awk '{print $1}' | grep -qx "$nf" && fail "the 'new' file already existed — left untouched"
      echo "removing ONLY the failed run's partial file: $nf ($(stat -c %s "$G6_BACKUP_DIR/$nf") bytes)"; rm -f "$G6_BACKUP_DIR/$nf"; echo "removed=$([ -e "$G6_BACKUP_DIR/$nf" ] && echo NO || echo yes)"
    else
      echo "no single new file to remove (new=$n_new)"
    fi
    rm -rf "$work"; fail "backup capture failed; pre-existing backups intact: $old_ok/$n_before"
  fi
  [ "$n_new" = "1" ] || { rm -rf "$work"; fail "expected exactly one new backup file, found $n_new"; }
  [ "$old_ok" = "$n_before" ] || { rm -rf "$work"; fail "a pre-existing backup changed or was pruned"; }
  section "verify the new file"
  local nf="$new" f; f="$G6_BACKUP_DIR/$nf"
  gzip -t "$f" || { rm -rf "$work"; fail "gzip integrity check failed on $nf"; }
  local size mt sum hdr dfrom dby ct cp rows done_
  size="$(stat -c %s "$f")"; mt="$(stat -c %Y "$f")"; sum="$(sha256sum "$f" | cut -c1-64)"
  hdr="$(zcat "$f" 2>/dev/null | sed -n 2p | cut -c1-40 || true)"; dfrom="$(zcat "$f" 2>/dev/null | grep -m1 -oE 'Dumped from database version [0-9.]+' | awk '{print $NF}' || true)"; dby="$(zcat "$f" 2>/dev/null | grep -m1 -oE 'Dumped by pg_dump version [0-9.]+' | awk '{print $NF}' || true)"
  ct="$(zcat "$f" | grep -c '^CREATE TABLE ' || true)"; cp="$(zcat "$f" | grep -c '^COPY ' || true)"; done_="$(zcat "$f" | grep -c '^-- PostgreSQL database dump complete' || true)"
  rows="$(zcat "$f" | awk '/^COPY /{c=1;next} c&&/^\\\.$/{c=0;next} c{n++} END{print n+0}')"
  echo "new_backup=$nf size=$size mode=$(stat -c %a "$f") mtime_utc=$(date -u -d @"$mt" +%FT%TZ) sha256=$sum header='$hdr' dumped_from=$dfrom pg_dump=$dby create_table=$ct copy_blocks=$cp data_rows=$rows complete_marker=$done_ uncompressed_bytes=$(zcat "$f" | wc -c)"
  [ "$hdr" = "-- PostgreSQL database dump" ] || { rm -rf "$work"; fail "unexpected dump header"; }
  [ "$done_" = "1" ] || { rm -rf "$work"; fail "completion marker missing"; }
  [ "$size" -ge 1024 ] || { rm -rf "$work"; fail "new backup suspiciously small"; }
  [ "$(stat -c %a "$f")" = "600" ] || { rm -rf "$work"; fail "new backup is not mode 600"; }
  local live_tables; live_tables="$(q "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")"
  echo "live tables=$live_tables dump CREATE TABLE=$ct $([ "$live_tables" = "$ct" ] && echo MATCH || echo MISMATCH)"
  [ "$live_tables" = "$ct" ] || { rm -rf "$work"; fail "table count of the new dump differs from the live database"; }
  local fp2; fp2="$(fingerprint)"; echo "live_fingerprint_after=$fp2 $([ "$fp2" = "$expect_fp" ] && echo unchanged || echo CHANGED)"
  echo "retention: $(ls -1 "$G6_BACKUP_DIR"/leadcapture-*.sql.gz | wc -l) file(s) present; oldest still present=$(printf '%s\n' "$before" | awk '{print $1}' | sort | head -1 | xargs -I{} sh -c '[ -f "'"$G6_BACKUP_DIR"'/{}" ] && echo yes || echo no')"
  rm -rf "$work"
  echo "BACKUP_CAPTURE=PASS new_backup=$nf new_sha256=$sum"
  log "g6c1-backup complete"
}


# g6c2-preflight : STRICTLY READ-ONLY. g6c1-preflight with the C1 capture as the
#                  "since" reference, plus the bridging-backup decision: the newest
#                  complete, gzip-valid backup is "suitable" when it is ≤ 26 h old and
#                  its CREATE TABLE count equals the live table count (the restore proof
#                  then re-checks the fingerprint). Prints bridge_needed=yes|no.
phase_g6c2_preflight() {
  G6_REHEARSAL_NEWEST="2026-09-18 23:40:37 UTC"   # the C1 capture (leadcapture-20260918-234035.sql.gz) has mtime 23:40:36.x
  phase_g6c1_preflight
  section "bridging-backup decision (newest complete backup ≤ 26 h old AND CREATE TABLE = live tables → no bridge)"
  local line sel="" age="" ct="" sum="" n live_tables reason
  while read -r line; do
    [ -n "$line" ] || continue
    if echo "$line" | grep -q ' gzip=ok ' && echo "$line" | grep -q ' complete_marker=1 '; then
      sel="$(echo "$line" | sed -E 's/^backup ([^:]+):.*/\1/')"; age="$(echo "$line" | grep -oE 'age_h=[0-9]+' | cut -d= -f2 || true)"; ct="$(echo "$line" | grep -oE 'create_table=[0-9]+' | cut -d= -f2 || true)"; sum="$(echo "$line" | grep -oE 'sha256=[0-9a-f]{64}' | cut -d= -f2 || true)"; break
    fi
  done < <(g6_backup_lines)
  n="$(ls -1 "$G6_BACKUP_DIR"/leadcapture-*.sql.gz 2>/dev/null | wc -l)"
  live_tables="$(q "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")"
  echo "newest_complete=${sel:-none} age_h=${age:-?} create_table=${ct:-?} live_tables=$live_tables sha256=${sum:-?}"
  if [ -n "$sel" ] && [ "${age:-999}" -le 26 ] && [ "$ct" = "$live_tables" ]; then
    reason="newest complete backup $sel is ${age} h old and its table count matches the live schema"; echo "bridge_needed=no existing_backups=$n keep_for_bridge=$((n + 1)) reason=[$reason]"
  else
    if [ -z "$sel" ]; then reason="no complete backup"; elif [ "${age:-999}" -gt 26 ]; then reason="newest complete backup $sel is ${age} h old (> 26 h)"; else reason="newest complete backup $sel has $ct tables, live has $live_tables"; fi
    echo "bridge_needed=yes existing_backups=$n keep_for_bridge=$((n + 1)) reason=[$reason]"
  fi
  log "g6c2-preflight complete (read-only)"
}


# =============================================================================
# B23 G-6 ACTIVATION — hardened backup script deployed; daily crontab for the deploy user.
#   g6act-postdeploy : READ-ONLY. HEAD / current / previous markers, script blob hashes vs the
#                      accepted commit, health, queue, clock/timezone, cron daemon, crontab entries.
#   g6act-backup     : ONE run of the DEPLOYED hardened script with KEEP = max(14, existing+1);
#                      exactly one new .sql.gz + matching .sha256, modes, earlier files untouched,
#                      backup-check.sh with BACKUP_MAX_AGE_HOURS=4 must pass, then the missed-run
#                      SIMULATION in a disposable directory with the checker's test clock.
#   g6act-cron       : ARG1=install|verify|rollback. Preserves the current crontab (secure copy
#                      in $HOME), adds exactly the two documented lines idempotently, verifies.
# =============================================================================
G6ACT_DOC_APP_DIR="/opt/lead-capture-pro/app"
G6ACT_BACKUP_DIR="/opt/lead-capture-pro/backups/postgres"
g6act_cron_lines() {
  cat <<'EOC'
# Lead Capture Pro — daily PostgreSQL backup (UTC) and freshness check
15 3 * * * DEPLOY_PATH=/opt/lead-capture-pro/app BACKUP_DIR=/opt/lead-capture-pro/backups/postgres KEEP=14 bash /opt/lead-capture-pro/app/docker/scripts/backup-postgres.sh >> /opt/lead-capture-pro/backups/postgres/backup.log 2>&1
45 3 * * * BACKUP_DIR=/opt/lead-capture-pro/backups/postgres BACKUP_MAX_AGE_HOURS=4 bash /opt/lead-capture-pro/app/docker/scripts/backup-check.sh >> /opt/lead-capture-pro/backups/postgres/backup.log 2>&1
EOC
}
g6act_doc_lines_match() {
  # The two crontab lines must be byte-identical to the reviewed document in the hosted checkout.
  local doc="$APP_DIR/docs/BACKUP_AND_RECOVERY.md" want got
  [ -f "$doc" ] || return 1
  want="$(g6act_cron_lines | grep -E '^(15|45) 3 \* \* \* ')"
  got="$(grep -E '^(15|45) 3 \* \* \* ' "$doc" | head -2)"
  [ "$want" = "$got" ]
}
g6act_env_checks() {
  echo "app dir equals the documented path (/opt/lead-capture-pro/app): $([ "$APP_DIR" = "$G6ACT_DOC_APP_DIR" ] && echo yes || echo NO)"
  echo "backup dir equals the documented path: $([ "$G6_BACKUP_DIR" = "$G6ACT_BACKUP_DIR" ] && echo yes || echo NO)"
  echo "clock: utc_now=$(date -u +%FT%TZ) local=$(date +'%FT%T %Z') timezone=$(timedatectl show -p Timezone --value 2>/dev/null || echo unknown) ntp_synced=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)"
  echo "cron daemon: active=$(systemctl is-active cron 2>/dev/null || echo unknown) enabled=$(systemctl is-enabled cron 2>/dev/null || echo unknown)"
  echo "crontab lines from the reviewed document match the lines this phase installs: $(g6act_doc_lines_match && echo yes || echo NO)"
}
phase_g6act_postdeploy() {
  [[ "$ARG1" =~ ^[0-9a-f]{40}$ ]] || fail "ARG1 must be the deployed commit sha"
  [[ "$ARG2" =~ ^[0-9a-f]{40}$ ]] || fail "ARG2 must be the previous commit sha"
  [[ "$ARG3" =~ ^bp=[0-9a-f]{40}\|bc=[0-9a-f]{40}$ ]] || fail "ARG3 must be bp=<blob>|bc=<blob>"
  local bp bc; bp="${ARG3#bp=}"; bp="${bp%%|*}"; bc="${ARG3##*bc=}"
  section "read-only guard"
  if q "create temp table b20_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard did not hold"; else echo "session refuses writes (default_transaction_read_only=on): OK"; fi
  section "deploy markers (expected HEAD = current-deploy.sha = $ARG1; previous-deploy.sha = $ARG2)"
  local head cur prev; head="$(git -C "$APP_DIR" rev-parse HEAD)"; cur="$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null || echo none)"; prev="$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null || echo none)"
  echo "HEAD=$head current-deploy.sha=$cur previous-deploy.sha=$prev dirty_entries=$(git -C "$APP_DIR" status --porcelain | wc -l) worktrees=$(git -C "$APP_DIR" worktree list | wc -l) state_files_mtime=$(stat -c %y "$STATE_DIR/current-deploy.sha" | cut -c1-19)"
  [ "$head" = "$ARG1" ] && [ "$cur" = "$ARG1" ] || fail "hosted checkout / current-deploy.sha is not $ARG1"
  [ "$prev" = "$ARG2" ] || fail "previous-deploy.sha is not $ARG2"
  [ -z "$(git -C "$APP_DIR" status --porcelain)" ] || fail "hosted checkout is dirty"
  section "deployed backup scripts vs the accepted commit"
  local hbp hbc; hbp="$(git -C "$APP_DIR" hash-object docker/scripts/backup-postgres.sh)"; hbc="$(git -C "$APP_DIR" hash-object docker/scripts/backup-check.sh)"
  echo "backup-postgres.sh blob=$hbp expected=$bp $([ "$hbp" = "$bp" ] && echo MATCH || echo MISMATCH) mode=$(stat -c %a "$APP_DIR/docker/scripts/backup-postgres.sh")"
  echo "backup-check.sh    blob=$hbc expected=$bc $([ "$hbc" = "$bc" ] && echo MATCH || echo MISMATCH) mode=$(stat -c %a "$APP_DIR/docker/scripts/backup-check.sh")"
  [ "$hbp" = "$bp" ] && [ "$hbc" = "$bc" ] || fail "deployed backup scripts differ from the accepted commit"
  bash -n "$APP_DIR/docker/scripts/backup-postgres.sh" && bash -n "$APP_DIR/docker/scripts/backup-check.sh" && echo "both scripts parse"
  echo "hardened-script markers: flock=$(grep -c 'flock -n' "$APP_DIR/docker/scripts/backup-postgres.sh") ln_publish=$(grep -c '^if ! ln ' "$APP_DIR/docker/scripts/backup-postgres.sh") sha256_before_publish=$(grep -c 'checksum first' "$APP_DIR/docker/scripts/backup-postgres.sh") check_now_override=$(grep -c 'BACKUP_CHECK_NOW' "$APP_DIR/docker/scripts/backup-check.sh")"
  g6_stack_state
  section "durable queue in the (re)created api container"
  docker logs "$API_CID" 2>&1 | grep -E '"msg":"Durable job queue (selected|started)"' | cut -c1-200 | head -2
  [ "$(docker logs "$API_CID" 2>&1 | grep -cE '"driver":"postgres".*"Durable job queue started"')" -ge 1 ] || fail "postgres durable queue not started in the new api container"
  q "select 'job_queue: '||coalesce(string_agg(status||'='||n, ' '), 'empty') from (select status, count(*) n from job_queue group by status order by status) s"
  [ "$(q "select count(*) from job_queue where status='dead' and dead_at > now() - interval '24 hours'")" = "0" ] || fail "dead jobs in the last 24h"
  section "environment for the activation"
  g6act_env_checks
  local uc; uc="$(crontab -l 2>/dev/null || true)"
  echo "deploy user crontab: $(printf '%s\n' "$uc" | grep -c . || true) line(s) ($(printf '%s\n' "$uc" | grep -vE '^\s*(#|$)' | grep -c . || true) active); backup-postgres.sh entries=$(printf '%s\n' "$uc" | grep -c 'backup-postgres\.sh' || true) backup-check.sh entries=$(printf '%s\n' "$uc" | grep -c 'backup-check\.sh' || true)"
  printf '%s\n' "$uc" | grep -vE '^\s*(#|$)' | g6_mask | cut -c1-200 | sed 's/^/  cron: /' || true
  echo "backup dir: $(stat -c 'mode=%a owner=%U' "$G6_BACKUP_DIR") files=$(ls -1 "$G6_BACKUP_DIR"/leadcapture-*.sql.gz 2>/dev/null | wc -l) sidecars=$(ls -1 "$G6_BACKUP_DIR"/leadcapture-*.sql.gz.sha256 2>/dev/null | wc -l) lock=$([ -e "$G6_BACKUP_DIR/.backup.lock" ] && echo present || echo absent) log=$([ -e "$G6_BACKUP_DIR/backup.log" ] && stat -c 'mode=%a size=%s' "$G6_BACKUP_DIR/backup.log" || echo absent)"
  echo "now_epoch_ms=$(date +%s%3N)"
  log "g6act-postdeploy complete (read-only)"
}

phase_g6act_backup() {
  local tag="$ARG1" expect_fp="$ARG2"
  [[ "$tag" =~ ^[a-z0-9]{4,16}$ ]] || fail "ARG1 must be the run tag"
  [[ "$expect_fp" =~ ^[0-9a-f]{32}$ ]] || fail "ARG2 must be the live schema fingerprint"
  local bs="$APP_DIR/docker/scripts/backup-postgres.sh" ck="$APP_DIR/docker/scripts/backup-check.sh"
  section "guards before writing anything"
  [ "$(git -C "$APP_DIR" hash-object "$bs")" = "$(git -C "$APP_DIR" rev-parse HEAD:docker/scripts/backup-postgres.sh)" ] || fail "deployed backup script differs from the hosted HEAD"
  grep -q 'flock -n' "$bs" && grep -q '^if ! ln ' "$bs" || fail "the deployed script is not the hardened revision"
  local fp; fp="$(fingerprint)"; echo "live_fingerprint=$fp expected=$expect_fp"; [ "$fp" = "$expect_fp" ] || fail "live schema changed — stopping"
  g6c1_no_backup_running || fail "a backup-related process is active — stopping"
  local before after n keep
  before="$(cd "$G6_BACKUP_DIR" && for f in leadcapture-*; do [ -f "$f" ] && echo "$f $(stat -c %s "$f") $(sha256sum "$f" | cut -c1-64) $(stat -c %Y "$f") $(stat -c %a "$f")"; done | sort)"
  n="$(printf '%s\n' "$before" | grep -c '\.sql\.gz [0-9]' || true)"
  echo "before: $n backup(s), $(printf '%s\n' "$before" | grep -c '\.sha256 ' || true) sidecar(s)"; printf '%s\n' "$before" | sed 's/^/  before: /'
  keep=14; [ $((n + 1)) -gt "$keep" ] && keep=$((n + 1))
  echo "KEEP for this first run = $keep (existing $n; nothing may be pruned)"
  section "run the DEPLOYED hardened script once as the deploy user (KEEP=$keep)"
  local work; work="$(mktemp -d "$HOME/g6act-$tag.XXXXXX")"; chmod 700 "$work"
  local t0 t1 rc; t0="$(date +%s%3N)"; echo "backup_start_utc=$(g6_utc)"
  set +e
  (cd "$APP_DIR" && DEPLOY_PATH="$APP_DIR" BACKUP_DIR="$G6_BACKUP_DIR" KEEP="$keep" timeout 600 bash docker/scripts/backup-postgres.sh) >"$work/backup.out" 2>&1
  rc=$?
  set -e
  t1="$(date +%s%3N)"; echo "backup_end_utc=$(g6_utc) script_exit=$rc script_ms=$((t1 - t0))"
  echo "script output (masked):"; g6_mask <"$work/backup.out" | cut -c1-220 | sed 's/^/  /'
  after="$(cd "$G6_BACKUP_DIR" && for f in leadcapture-*; do [ -f "$f" ] && echo "$f $(stat -c %s "$f") $(sha256sum "$f" | cut -c1-64) $(stat -c %Y "$f") $(stat -c %a "$f")"; done | sort)"
  local newgz newsc old_ok
  newgz="$(comm -13 <(printf '%s\n' "$before" | awk '{print $1}') <(printf '%s\n' "$after" | awk '{print $1}') | grep '\.sql\.gz$' || true)"
  newsc="$(comm -13 <(printf '%s\n' "$before" | awk '{print $1}') <(printf '%s\n' "$after" | awk '{print $1}') | grep '\.sha256$' || true)"
  old_ok="$(comm -12 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | wc -l)"
  echo "after: $(printf '%s\n' "$after" | grep -c '\.sql\.gz [0-9]' || true) backup(s); new backup file(s): [$(printf '%s' "$newgz" | tr '\n' ' ')] new sidecar(s): [$(printf '%s' "$newsc" | tr '\n' ' ')]; pre-existing entries identical (name, size, sha256, mtime, mode): $old_ok/$(printf '%s\n' "$before" | grep -c . || true)"
  [ "$rc" = "0" ] || { rm -rf "$work"; fail "the hardened backup script FAILED (exit $rc); pre-existing entries intact: $old_ok"; }
  [ "$(printf '%s\n' "$newgz" | grep -c . || true)" = "1" ] && [ "$(printf '%s\n' "$newsc" | grep -c . || true)" = "1" ] || { rm -rf "$work"; fail "expected exactly one new backup and one new sidecar"; }
  [ "$newsc" = "$newgz.sha256" ] || { rm -rf "$work"; fail "the new sidecar does not belong to the new backup"; }
  [ "$old_ok" = "$(printf '%s\n' "$before" | grep -c . || true)" ] || { rm -rf "$work"; fail "a pre-existing file changed or was pruned"; }
  section "verify the new pair"
  local f="$G6_BACKUP_DIR/$newgz" size mt sum sc_sum ct rows
  gzip -t "$f" || { rm -rf "$work"; fail "gzip integrity check failed"; }
  size="$(stat -c %s "$f")"; mt="$(stat -c %Y "$f")"; sum="$(sha256sum "$f" | cut -c1-64)"; sc_sum="$(cut -c1-64 "$f.sha256")"
  ct="$(zcat "$f" | grep -c '^CREATE TABLE ' || true)"; rows="$(zcat "$f" | awk '/^COPY /{c=1;next} c&&/^\\\.$/{c=0;next} c{n++} END{print n+0}')"
  echo "new_backup=$newgz size=$size mode=$(stat -c %a "$f") sidecar_mode=$(stat -c %a "$f.sha256") mtime_utc=$(date -u -d @"$mt" +%FT%TZ) sha256=$sum sidecar_sha256=$sc_sum sidecar_names_file=$(awk '{print $2}' "$f.sha256") header='$(zcat "$f" | sed -n 2p | cut -c1-40)' complete_marker=$(zcat "$f" | grep -c '^-- PostgreSQL database dump complete' || true) create_table=$ct data_rows=$rows uncompressed_bytes=$(zcat "$f" | wc -c) dir_mode=$(stat -c %a "$G6_BACKUP_DIR") lock_mode=$(stat -c %a "$G6_BACKUP_DIR/.backup.lock" 2>/dev/null || echo none) tmp_files=$(ls -1A "$G6_BACKUP_DIR" | grep -c '\.tmp$' || true)"
  [ "$sum" = "$sc_sum" ] && ( cd "$G6_BACKUP_DIR" && sha256sum -c --quiet "$newgz.sha256" >/dev/null 2>&1 ) || { rm -rf "$work"; fail "sidecar does not match the new backup"; }
  [ "$(stat -c %a "$f")" = "600" ] && [ "$(stat -c %a "$f.sha256")" = "600" ] && [ "$(stat -c %a "$G6_BACKUP_DIR")" = "700" ] || { rm -rf "$work"; fail "restrictive modes not met"; }
  [ "$ct" = "$(q "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")" ] || { rm -rf "$work"; fail "CREATE TABLE count differs from the live table count"; }
  section "backup-check.sh on the LIVE directory with BACKUP_MAX_AGE_HOURS=4 (must pass)"
  set +e; (cd "$APP_DIR" && BACKUP_DIR="$G6_BACKUP_DIR" BACKUP_MAX_AGE_HOURS=4 bash "$ck") >"$work/check.out" 2>&1; local crc=$?; set -e
  cut -c1-240 "$work/check.out" | sed 's/^/  /'; echo "check_exit=$crc"
  [ "$crc" = "0" ] && grep -q "OK: $newgz " "$work/check.out" || { rm -rf "$work"; fail "backup-check.sh did not pass on the new backup"; }
  section "SIMULATION — missed 03:15 UTC run, check at 03:45 UTC with the 4 h limit (disposable directory + test clock; no live backup touched)"
  local sim y t nowsim; sim="$(mktemp -d "$HOME/g6act-sim-$tag.XXXXXX")"; chmod 700 "$sim"
  y="$(date -u -d 'yesterday' +%Y%m%d)"; t="$(date -u +%Y%m%d)"; nowsim="$(date -u -d "$(date -u +%F) 03:45:00" +%s)"
  mk_sim() { local n="$sim/leadcapture-$1-031530.sql.gz"; printf -- '--\n-- PostgreSQL database dump\n--\nCREATE TABLE public.t (id int);\n--\n-- PostgreSQL database dump complete\n--\n' | gzip -c > "$n"; chmod 600 "$n"; touch -d "${1:0:4}-${1:4:2}-${1:6:2} 03:15:30 UTC" "$n"; ( cd "$sim" && sha256sum "$(basename "$n")" > "$(basename "$n").sha256" ); chmod 600 "$n.sha256"; touch -r "$n" "$n.sha256"; }
  mk_sim "$y"
  set +e; (cd "$APP_DIR" && BACKUP_DIR="$sim" BACKUP_CHECK_NOW="$nowsim" BACKUP_MAX_AGE_HOURS=4 bash "$ck") >"$work/sim1.out" 2>&1; local s1=$?; set -e
  echo "  missed run (only yesterday's 03:15 file; clock = today 03:45 UTC; limit 4 h): exit=$s1 → $(cut -c1-200 "$work/sim1.out")"
  [ "$s1" != "0" ] && grep -q 'minutes old (limit 4 h)' "$work/sim1.out" || { rm -rf "$sim" "$work"; fail "SIMULATION: the missed run was NOT detected"; }
  set +e; (cd "$APP_DIR" && BACKUP_DIR="$sim" BACKUP_CHECK_NOW="$nowsim" BACKUP_MAX_AGE_HOURS=26 bash "$ck") >"$work/sim2.out" 2>&1; local s2=$?; set -e
  echo "  same missed run with the general-purpose 26 h limit: exit=$s2 (would have passed — why the schedule uses 4 h)"
  mk_sim "$t"
  set +e; (cd "$APP_DIR" && BACKUP_DIR="$sim" BACKUP_CHECK_NOW="$nowsim" BACKUP_MAX_AGE_HOURS=4 bash "$ck") >"$work/sim3.out" 2>&1; local s3=$?; set -e
  echo "  successful run (today's 03:15 file present; same clock; limit 4 h): exit=$s3 → $(cut -c1-200 "$work/sim3.out")"
  [ "$s3" = "0" ] || { rm -rf "$sim" "$work"; fail "SIMULATION: the successful run did not pass"; }
  rm -rf "$sim"; echo "  simulation directory removed: $([ -e "$sim" ] && echo NO || echo yes) (this is a simulation, not a scheduled-run result)"
  rm -rf "$work"
  echo "ACTIVATION_BACKUP=PASS new_backup=$newgz new_sha256=$sum keep=$keep"
  log "g6act-backup complete"
}

phase_g6act_cron() {
  local mode="$ARG1" tag="$ARG2"
  [[ "$mode" =~ ^(install|verify|rollback)$ ]] || fail "ARG1 must be install|verify|rollback"
  [[ "$tag" =~ ^[a-z0-9]{4,16}$ ]] || fail "ARG2 must be the run tag"
  local copy="$HOME/.crontab.before-g6-activation-$tag.txt"
  section "environment"
  g6act_env_checks
  [ "$APP_DIR" = "$G6ACT_DOC_APP_DIR" ] && [ "$G6_BACKUP_DIR" = "$G6ACT_BACKUP_DIR" ] || fail "paths differ from the reviewed document — the documented crontab lines would not be correct here"
  g6act_doc_lines_match || fail "the crontab lines differ from docs/BACKUP_AND_RECOVERY.md in the hosted checkout"
  [ "$(systemctl is-active cron 2>/dev/null)" = "active" ] || fail "cron daemon is not active"
  [ "$(date +%Z)" = "UTC" ] || fail "host timezone is not UTC — the 03:15/03:45 entries assume UTC"
  [ -x "$APP_DIR/docker/scripts/backup-postgres.sh" ] && [ -x "$APP_DIR/docker/scripts/backup-check.sh" ] || fail "scripts are not executable"
  local cur; cur="$(crontab -l 2>/dev/null || true)"
  local have_bp have_bc; have_bp="$(printf '%s\n' "$cur" | grep -c 'docker/scripts/backup-postgres\.sh' || true)"; have_bc="$(printf '%s\n' "$cur" | grep -c 'docker/scripts/backup-check\.sh' || true)"
  echo "current crontab: $(printf '%s\n' "$cur" | grep -c . || true) line(s); backup-postgres entries=$have_bp backup-check entries=$have_bc"
  case "$mode" in
    install)
      section "install (idempotent; prior crontab preserved as a 600 copy in the deploy user's home)"
      umask 077; printf '%s\n' "$cur" > "$copy"; chmod 600 "$copy"; echo "prior crontab saved: $(basename "$copy") lines=$(grep -c . "$copy" || true) mode=$(stat -c %a "$copy")"
      if [ "$have_bp" = "1" ] && [ "$have_bc" = "1" ]; then echo "both entries already present — nothing added (idempotent)";
      elif [ "$have_bp" != "0" ] || [ "$have_bc" != "0" ]; then fail "partial installation found (bp=$have_bp bc=$have_bc) — not touching it";
      else
        local new; if [ -n "$cur" ]; then new="$(printf '%s\n\n%s\n' "$cur" "$(g6act_cron_lines)")"; else new="$(g6act_cron_lines)"; fi
        printf '%s\n' "$new" | crontab - || fail "crontab installation failed"
        echo "two entries added"
      fi
      [ -e "$G6_BACKUP_DIR/backup.log" ] || { : > "$G6_BACKUP_DIR/backup.log"; }
      chmod 600 "$G6_BACKUP_DIR/backup.log"; echo "log file: $(stat -c 'mode=%a size=%s' "$G6_BACKUP_DIR/backup.log")"
      ;;
    rollback)
      section "rollback — remove only the two entries added by this activation"
      [ -f "$copy" ] || fail "no saved crontab copy for tag $tag"
      printf '%s\n' "$cur" | grep -vE 'docker/scripts/backup-(postgres|check)\.sh|^# Lead Capture Pro — daily PostgreSQL backup' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' > "$HOME/.crontab.rollback-$tag.txt" 2>/dev/null || true
      if [ -s "$HOME/.crontab.rollback-$tag.txt" ]; then crontab "$HOME/.crontab.rollback-$tag.txt"; else crontab -r 2>/dev/null || true; fi
      rm -f "$HOME/.crontab.rollback-$tag.txt"
      echo "entries removed; remaining lines=$(crontab -l 2>/dev/null | grep -c . || true) (saved copy had $(grep -c . "$copy" || true))"
      ;;
  esac
  section "verification (read-only)"
  local now_ct; now_ct="$(crontab -l 2>/dev/null || true)"
  local n_bp n_bc; n_bp="$(printf '%s\n' "$now_ct" | grep -c '^15 3 \* \* \* DEPLOY_PATH=/opt/lead-capture-pro/app BACKUP_DIR=/opt/lead-capture-pro/backups/postgres KEEP=14 bash /opt/lead-capture-pro/app/docker/scripts/backup-postgres\.sh >> /opt/lead-capture-pro/backups/postgres/backup\.log 2>&1$' || true)"
  n_bc="$(printf '%s\n' "$now_ct" | grep -c '^45 3 \* \* \* BACKUP_DIR=/opt/lead-capture-pro/backups/postgres BACKUP_MAX_AGE_HOURS=4 bash /opt/lead-capture-pro/app/docker/scripts/backup-check\.sh >> /opt/lead-capture-pro/backups/postgres/backup\.log 2>&1$' || true)"
  echo "installed crontab: $(printf '%s\n' "$now_ct" | grep -c . || true) line(s); exact backup entry count=$n_bp exact check entry count=$n_bc any other backup-postgres/backup-check mention=$(printf '%s\n' "$now_ct" | grep -cE 'backup-(postgres|check)\.sh' || true)"
  printf '%s\n' "$now_ct" | grep -vE '^\s*$' | g6_mask | cut -c1-230 | sed 's/^/  crontab: /' || true
  if [ -f "$copy" ]; then
    local others; others="$(printf '%s\n' "$now_ct" | grep -vE 'docker/scripts/backup-(postgres|check)\.sh|^# Lead Capture Pro — daily PostgreSQL backup|^\s*$' || true)"
    local saved; saved="$(grep -vE '^\s*$' "$copy" || true)"
    echo "other scheduled jobs unchanged vs the saved copy: $([ "$others" = "$saved" ] && echo yes || echo NO)"
    [ "$others" = "$saved" ] || fail "other crontab lines changed"
  fi
  if [ "$mode" != "rollback" ]; then
    [ "$n_bp" = "1" ] && [ "$n_bc" = "1" ] || fail "the two entries are not installed exactly once"
    [ "$(printf '%s\n' "$now_ct" | grep -cE 'backup-(postgres|check)\.sh' || true)" = "2" ] || fail "duplicate or foreign backup entries present"
    echo "next scheduled runs (UTC): backup $(date -u -d "$( [ "$(date -u +%H%M)" \< "0315" ] && date -u +%F || date -u -d tomorrow +%F ) 03:15" +%FT%TZ) check $(date -u -d "$( [ "$(date -u +%H%M)" \< "0345" ] && date -u +%F || date -u -d tomorrow +%F ) 03:45" +%FT%TZ)"
    echo "CRON_INSTALLED=yes"
  else
    [ "$n_bp" = "0" ] && [ "$n_bc" = "0" ] || fail "entries still present after rollback"
    echo "CRON_INSTALLED=no"
  fi
  echo "permissions: script=$(stat -c %a "$APP_DIR/docker/scripts/backup-postgres.sh") check=$(stat -c %a "$APP_DIR/docker/scripts/backup-check.sh") backup_dir=$(stat -c %a "$G6_BACKUP_DIR") log=$(stat -c %a "$G6_BACKUP_DIR/backup.log" 2>/dev/null || echo absent) saved_copy=$(stat -c %a "$copy" 2>/dev/null || echo absent)"
  log "g6act-cron ($mode) complete"
}

# =============================================================================
# B23 G-6 — first scheduled backup cycle verification (STRICTLY READ-ONLY).
#   g6fc-verify : ARG1 = expected deployed sha, ARG2 = UTC day of the cycle (YYYYMMDD),
#                 ARG3 = "<tag>|<expected company-1 core baseline md5 or none>|<api id prefix>|<postgres id prefix>|<web id prefix>"
#                 (the three container prefixes are optional; use none). Stops on drift
#                 (HEAD / current-deploy.sha / F2); then reads the crontab, the cron
#                 journal where readable, the protected backup.log, the newest backup +
#                 sidecar, the directory hygiene and the ordinary scheduler activity.
#                 Prints FIRST_CYCLE=PASS|FAIL with every reason; never runs a backup,
#                 never edits cron, never prints rows or credentials.
#   g6fc-queue  : ARG1 = epoch seconds of the "before" completed-count observation,
#                 ARG2 = epoch seconds of the "after" observation, ARG3 = "<before>|<after>".
#                 Reads the maintenance-sweep evidence (api log summary lines, the
#                 recurring.sweep rows, retention cut-off) and reconciles the counts.
#                 Prints QUEUE_DELTA=PROVEN|UNEXPLAINED.
# =============================================================================
g6fc_mask() {
  # Like g6_mask but keeps 40/64-hex words (git shas and backup checksums are evidence, not
  # secrets) and never masks file paths; connection strings and quoted role/user/database
  # names are masked, and any other long token is masked as well.
  if command -v perl >/dev/null 2>&1; then
    perl -pe 's#(postgres(ql)?://)\S+#$1<masked>#g; s/(role|user|database|password) "[^"]*"/$1 "<masked>"/g; my @k; s/\b([0-9a-f]{40}|[0-9a-f]{64})\b/push @k,$1; "\x01".$#k."\x01"/ge; s/[A-Za-z0-9+=_-]{32,}/<masked>/g; s/\x01(\d+)\x01/$k[$1]/g'
  else
    g6_mask
  fi
}
g6fc_iso_ms() { date -u -d @"$(( ${1:-0} / 1000 ))" +%FT%TZ 2>/dev/null || echo "?"; }
g6fc_stamp_ok() { # $1 = day (YYYYMMDD) — the cron entry fires at 03:15 UTC; the stamp is taken at script start
  [[ "$2" =~ ^leadcapture-${1}-031[5-9][0-9]{2}\.sql\.gz$ ]]
}

phase_g6fc_verify() {
  local sha="$ARG1" day="$ARG2"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "ARG1 must be the expected deployed commit sha"
  [[ "$day" =~ ^20[0-9]{6}$ ]] || fail "ARG2 must be the UTC day of the cycle (YYYYMMDD)"
  local tag md5 exp_api exp_pg exp_web
  tag="$(echo "$ARG3" | cut -d'|' -f1)"; md5="$(echo "$ARG3" | cut -d'|' -f2)"; exp_api="$(echo "$ARG3" | cut -d'|' -f3)"; exp_pg="$(echo "$ARG3" | cut -d'|' -f4)"; exp_web="$(echo "$ARG3" | cut -d'|' -f5)"
  [[ "$tag" =~ ^[a-z0-9]{4,16}$ ]] || fail "ARG3 tag must be alphanumeric"; [ -n "$md5" ] || md5=none
  [ -n "$exp_api" ] || exp_api=none; [ -n "$exp_pg" ] || exp_pg=none; [ -n "$exp_web" ] || exp_web=none
  local day_iso="${day:0:4}-${day:4:2}-${day:6:2}" reasons="" bl="$G6_BACKUP_DIR/backup.log"
  section "read-only guard"
  if q "create temp table b20_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard did not hold"; else echo "session refuses writes (default_transaction_read_only=on): OK"; fi
  section "expected deployed state (stop on drift: HEAD = current-deploy.sha = $sha, schema F2)"
  local head cur prev; head="$(git -C "$APP_DIR" rev-parse HEAD)"; cur="$(cat "$STATE_DIR/current-deploy.sha" 2>/dev/null || echo none)"; prev="$(cat "$STATE_DIR/previous-deploy.sha" 2>/dev/null || echo none)"
  echo "HEAD=$head current-deploy.sha=$cur previous-deploy.sha=$prev dirty_entries=$(git -C "$APP_DIR" status --porcelain | wc -l) state_files_mtime=$(stat -c %y "$STATE_DIR/current-deploy.sha" | cut -c1-19)"
  [ "$head" = "$sha" ] && [ "$cur" = "$sha" ] || fail "DRIFT: hosted checkout / current-deploy.sha is not $sha — stopping"
  [ -z "$(git -C "$APP_DIR" status --porcelain)" ] || fail "DRIFT: hosted checkout is dirty — stopping"
  local fp; fp="$(fingerprint)"; echo "schema_fingerprint=$fp (F2 expected $F2_CONST)"; [ "$fp" = "$F2_CONST" ] || fail "DRIFT: schema fingerprint is not F2 — stopping"
  g6_stack_state
  local api_id pg_id web_id; api_id="$(docker inspect -f '{{.Id}}' "$API_CID")"; pg_id="$(docker inspect -f '{{.Id}}' "$PG_CID")"; web_id="$(docker inspect -f '{{.Id}}' "$(compose ps -q web)")"
  local stack_same=yes
  for pair in "api:$exp_api:$api_id" "postgres:$exp_pg:$pg_id" "web:$exp_web:$web_id"; do
    local n e a; n="${pair%%:*}"; e="$(echo "$pair" | cut -d: -f2)"; a="${pair##*:}"
    [ "$e" != "none" ] || continue
    if [ "${a:0:${#e}}" = "$e" ]; then echo "$n container unchanged since activation: yes (${a:0:12})"; else echo "$n container unchanged since activation: NO (now ${a:0:12}, expected prefix $e)"; stack_same=no; fi
  done
  echo "STACK_UNCHANGED=$stack_same"
  section "existing customer baseline (company 1 core state; activity reported)"
  local b m; b="$(existing_core)"; echo "$b"; m="$(printf '%s' "$b" | md5sum | cut -c1-32)"; echo "baseline_md5=$m expected=$md5"
  if [ "$md5" != "none" ]; then echo "BASELINE_UNCHANGED=$([ "$m" = "$md5" ] && echo yes || echo NO)"; fi
  existing_activity
  section "schedule as installed (deploy user)"
  g6act_env_checks
  [ "$(date +%Z)" = "UTC" ] || reasons="$reasons host-not-UTC;"
  [ "$(systemctl is-active cron 2>/dev/null)" = "active" ] || reasons="$reasons cron-not-active;"
  local ct n_bp n_bc n_any; ct="$(crontab -l 2>/dev/null || true)"
  n_bp="$(printf '%s\n' "$ct" | grep -c '^15 3 \* \* \* DEPLOY_PATH=/opt/lead-capture-pro/app BACKUP_DIR=/opt/lead-capture-pro/backups/postgres KEEP=14 bash /opt/lead-capture-pro/app/docker/scripts/backup-postgres\.sh >> /opt/lead-capture-pro/backups/postgres/backup\.log 2>&1$' || true)"
  n_bc="$(printf '%s\n' "$ct" | grep -c '^45 3 \* \* \* BACKUP_DIR=/opt/lead-capture-pro/backups/postgres BACKUP_MAX_AGE_HOURS=4 bash /opt/lead-capture-pro/app/docker/scripts/backup-check\.sh >> /opt/lead-capture-pro/backups/postgres/backup\.log 2>&1$' || true)"
  n_any="$(printf '%s\n' "$ct" | grep -cE 'backup-(postgres|check)\.sh' || true)"
  echo "crontab: $(printf '%s\n' "$ct" | grep -c . || true) line(s); exact 03:15 backup entry (KEEP=14)=$n_bp exact 03:45 check entry (BACKUP_MAX_AGE_HOURS=4)=$n_bc any backup-postgres/backup-check mention=$n_any"
  printf '%s\n' "$ct" | grep -vE '^\s*$' | g6fc_mask | cut -c1-230 | sed 's/^/  crontab: /' || true
  [ "$n_bp" = "1" ] && [ "$n_bc" = "1" ] && [ "$n_any" = "2" ] || reasons="$reasons crontab-entries-not-exactly-two;"
  local s; for s in backup-postgres.sh backup-check.sh; do
    local p="/opt/lead-capture-pro/app/docker/scripts/$s"
    echo "$s: path_in_crontab_exists=$([ -f "$p" ] && echo yes || echo NO) executable=$([ -x "$p" ] && echo yes || echo NO) mode=$(stat -c %a "$p" 2>/dev/null || echo ?) blob=$(git -C "$APP_DIR" hash-object "$p" 2>/dev/null || echo ?) HEAD_blob=$(git -C "$APP_DIR" rev-parse "HEAD:docker/scripts/$s") identical_to_HEAD=$([ "$(git -C "$APP_DIR" hash-object "$p" 2>/dev/null)" = "$(git -C "$APP_DIR" rev-parse "HEAD:docker/scripts/$s")" ] && echo yes || echo NO) same_file_as_app_dir=$([ "$p" -ef "$APP_DIR/docker/scripts/$s" ] && echo yes || echo NO)"
    [ "$(git -C "$APP_DIR" hash-object "$p" 2>/dev/null)" = "$(git -C "$APP_DIR" rev-parse "HEAD:docker/scripts/$s")" ] || reasons="$reasons $s-differs-from-deployed;"
  done
  section "cron execution evidence for $day_iso 03:00–04:00 UTC (journal / syslog, if readable as this user)"
  if journalctl -u cron -n 1 --no-pager -q >/dev/null 2>&1; then
    echo "journal: readable; CMD lines mentioning the two scripts in the window: $(journalctl -u cron --since "$day_iso 03:00:00" --until "$day_iso 04:00:00" --no-pager -q 2>/dev/null | grep -cE 'backup-(postgres|check)\.sh' || true)"
    journalctl -u cron -o short-iso --since "$day_iso 03:00:00" --until "$day_iso 04:00:00" --no-pager -q 2>/dev/null | grep -E 'backup-(postgres|check)\.sh|CRON' | g6fc_mask | cut -c1-260 | sed 's/^/  journal(cron unit): /' | head -12 || true
    echo "journal (any unit) lines mentioning the two scripts in the window: $(journalctl --since "$day_iso 03:00:00" --until "$day_iso 04:00:00" --no-pager -q 2>/dev/null | grep -cE 'backup-(postgres|check)\.sh' || true)"
    journalctl -o short-iso --since "$day_iso 03:00:00" --until "$day_iso 04:00:00" --no-pager -q 2>/dev/null | grep -E 'backup-(postgres|check)\.sh' | g6fc_mask | cut -c1-260 | sed 's/^/  journal(any): /' | head -8 || true
  else echo "journal: not readable as this user (unknown)"; fi
  if [ -r /var/log/syslog ]; then echo "syslog: readable; matching lines=$(grep -h "$day_iso" /var/log/syslog 2>/dev/null | grep -cE 'backup-(postgres|check)\.sh' || true)"; grep -h "${day_iso}T03" /var/log/syslog 2>/dev/null | grep -E 'backup-(postgres|check)\.sh' | g6fc_mask | cut -c1-260 | sed 's/^/  syslog: /' | head -6 || true; else echo "syslog: not readable (unknown)"; fi
  section "protected backup.log (only the two scripts write it, via the crontab redirection; masked, names/sizes/counts only)"
  local bk_dump bk_ok bk_ret ck_ok n_fail n_err n_day
  if [ ! -f "$bl" ]; then echo "backup.log: ABSENT"; reasons="$reasons backup.log-absent;"; bk_dump=""; bk_ok=""; bk_ret=""; ck_ok=""; n_fail=0; n_err=0; n_day=0; else
    echo "backup.log: $(stat -c 'mode=%a owner=%U size=%s mtime=%y' "$bl") lines=$(wc -l <"$bl")"
    [ "$(stat -c %a "$bl")" = "600" ] || reasons="$reasons backup.log-mode-not-600;"
    n_day="$(grep -c "^\[backup\(-check\)\?\] ${day_iso}T" "$bl" || true)"
    bk_dump="$(grep -E "^\[backup\] ${day_iso}T03:[0-9]{2}:[0-9]{2}Z dumping to a temporary file" "$bl" || true)"
    bk_ok="$(grep -E "^\[backup\] ${day_iso}T03:[0-9]{2}:[0-9]{2}Z OK " "$bl" || true)"
    bk_ret="$(grep -E "^\[backup\] ${day_iso}T03:[0-9]{2}:[0-9]{2}Z [0-9]+ backup\(s\) retained \(KEEP=14\)" "$bl" || true)"
    ck_ok="$(grep -E "^\[backup-check\] ${day_iso}T03:4[5-9]:[0-9]{2}Z OK: " "$bl" || true)"
    n_fail="$(grep -c 'FAIL:' "$bl" || true)"; n_err="$(grep -c 'ERROR' "$bl" || true)"
    echo "lines dated $day_iso=$n_day backup_start_lines=$(printf '%s' "$bk_dump" | grep -c . || true) backup_ok_lines=$(printf '%s' "$bk_ok" | grep -c . || true) retained_lines=$(printf '%s' "$bk_ret" | grep -c . || true) check_ok_lines_0345=$(printf '%s' "$ck_ok" | grep -c . || true) FAIL_lines_total=$n_fail ERROR_lines_total=$n_err"
    echo "-- full log (last 40 lines, masked) --"; tail -n 40 "$bl" | g6fc_mask | cut -c1-300 | sed 's/^/  log: /'
    [ "$(printf '%s' "$bk_dump" | grep -c . || true)" = "1" ] || reasons="$reasons no-single-0315-backup-start-line;"
    [ "$(printf '%s' "$bk_ok" | grep -c . || true)" = "1" ] || reasons="$reasons no-single-0315-backup-OK-line;"
    [ "$(printf '%s' "$bk_ret" | grep -c . || true)" = "1" ] || reasons="$reasons no-single-retained-KEEP14-line;"
    [ "$(printf '%s' "$ck_ok" | grep -c . || true)" = "1" ] || reasons="$reasons no-single-0345-check-OK-line;"
    [ "$n_fail" = "0" ] && [ "$n_err" = "0" ] || reasons="$reasons FAIL-or-ERROR-lines-in-log;"
  fi
  local bk_file bk_sha bk_bytes bk_t0 bk_t1 ck_t ck_age ck_limit ck_gen ck_legacy ck_ver
  bk_file="$(printf '%s\n' "$bk_ok" | grep -oE 'leadcapture-[0-9]{8}-[0-9]{6}\.sql\.gz' | head -1 || true)"
  bk_sha="$(printf '%s\n' "$bk_ok" | grep -oE 'sha256=[0-9a-f]{64}' | head -1 | cut -d= -f2 || true)"
  bk_bytes="$(printf '%s\n' "$bk_ok" | grep -oE '\([0-9]+ bytes\)' | head -1 | grep -oE '[0-9]+' || true)"
  bk_t0="$(printf '%s\n' "$bk_dump" | grep -oE "${day_iso}T[0-9:]{8}Z" | head -1 || true)"; bk_t1="$(printf '%s\n' "$bk_ok" | grep -oE "${day_iso}T[0-9:]{8}Z" | head -1 || true)"
  ck_t="$(printf '%s\n' "$ck_ok" | grep -oE "${day_iso}T[0-9:]{8}Z" | head -1 || true)"
  ck_age="$(printf '%s\n' "$ck_ok" | grep -oE 'age=[0-9]+min' | head -1 || true)"; ck_limit="$(printf '%s\n' "$ck_ok" | grep -oE 'limit [0-9]+h' | head -1 || true)"
  ck_ver="$(printf '%s\n' "$ck_ok" | grep -oE 'sidecars verified=[0-9]+' | head -1 || true)"; ck_gen="$(printf '%s\n' "$ck_ok" | grep -oE 'generation from leadcapture-[0-9]{8}-[0-9]{6}\.sql\.gz' | head -1 || true)"; ck_legacy="$(printf '%s\n' "$ck_ok" | grep -oE 'pre-sidecar backups=[0-9]+' | head -1 || true)"
  echo "parsed: backup_started=${bk_t0:-none} backup_published=${bk_t1:-none} file=${bk_file:-none} bytes=${bk_bytes:-none} sha256=${bk_sha:-none}"
  echo "parsed: check_at=${ck_t:-none} ${ck_age:-age=none} ${ck_limit:-limit=none} ${ck_ver:-sidecars=none} ${ck_gen:-generation=none} ${ck_legacy:-legacy=none} check_names_the_new_file=$([ -n "$bk_file" ] && printf '%s\n' "$ck_ok" | grep -q "OK: $bk_file " && echo yes || echo NO)"
  [ "$ck_limit" = "limit 4h" ] || reasons="$reasons check-limit-not-4h;"
  [ -n "$bk_file" ] && printf '%s\n' "$ck_ok" | grep -q "OK: $bk_file " || reasons="$reasons check-does-not-name-the-new-file;"
  echo "exit evidence: the backup script prints its 'OK' and 'retained' lines only on the success path (set -e; retention runs after publication); the check prints exactly one 'OK:' line on exit 0 and one 'FAIL:' line on exit 1 — no other exit information is recorded by the documented crontab lines"
  section "newest backup file (must be the scheduled $day_iso 03:15 UTC run)"
  local newest_m newest_n
  newest_m="$(ls -1t "$G6_BACKUP_DIR"/leadcapture-*.sql.gz 2>/dev/null | head -1 | xargs -r basename || true)"
  newest_n="$(ls -1 "$G6_BACKUP_DIR"/leadcapture-*.sql.gz 2>/dev/null | xargs -r -n1 basename | sort | tail -1 || true)"
  echo "newest_by_mtime=${newest_m:-none} newest_by_name=${newest_n:-none} log_file=${bk_file:-none} stamp_matches_${day}-0315xx=$(g6fc_stamp_ok "$day" "${newest_n:-x}" && echo yes || echo NO)"
  [ -n "$newest_n" ] && [ "$newest_m" = "$newest_n" ] || reasons="$reasons newest-by-mtime-and-by-name-differ;"
  g6fc_stamp_ok "$day" "${newest_n:-x}" || reasons="$reasons newest-file-is-not-a-${day}-0315-stamp;"
  [ -n "$bk_file" ] && [ "$bk_file" = "$newest_n" ] || reasons="$reasons log-file-is-not-the-newest-file;"
  if [ -n "$newest_n" ] && [ -f "$G6_BACKUP_DIR/$newest_n" ]; then
    local f="$G6_BACKUP_DIR/$newest_n" fm fsz fsha fmode smode sc_sha sc_name gz hdr done_ ct cp rows bu live_tables now
    now="$(date +%s)"; fm="$(stat -c %Y "$f")"; fsz="$(stat -c %s "$f")"; fmode="$(stat -c %a "$f")"; fsha="$(sha256sum "$f" | cut -c1-64)"
    echo "file: $newest_n size=$fsz mode=$fmode owner=$(stat -c %U "$f") owner_is_deploy_user=$([ "$(stat -c %U "$f")" = "$(id -un)" ] && echo yes || echo NO) mtime_utc=$(date -u -d @"$fm" +%FT%TZ) age_min=$(( (now - fm) / 60 )) mtime_in_0315_window=$([ "$fm" -ge "$(date -u -d "$day_iso 03:15:00" +%s)" ] && [ "$fm" -lt "$(date -u -d "$day_iso 03:20:00" +%s)" ] && echo yes || echo NO)"
    echo "file: sha256=$fsha equals_log_sha256=$([ -n "$bk_sha" ] && [ "$fsha" = "$bk_sha" ] && echo yes || echo NO) size_equals_log_bytes=$([ -n "$bk_bytes" ] && [ "$fsz" = "$bk_bytes" ] && echo yes || echo NO)"
    [ "$fmode" = "600" ] || reasons="$reasons backup-mode-not-600;"
    [ -n "$bk_sha" ] && [ "$fsha" = "$bk_sha" ] || reasons="$reasons file-sha256-differs-from-log;"
    [ "$fm" -ge "$(date -u -d "$day_iso 03:15:00" +%s)" ] && [ "$fm" -lt "$(date -u -d "$day_iso 03:20:00" +%s)" ] || reasons="$reasons mtime-outside-0315-window;"
    if [ -f "$f.sha256" ]; then
      smode="$(stat -c %a "$f.sha256")"; sc_sha="$(cut -c1-64 "$f.sha256")"; sc_name="$(awk '{print $2}' "$f.sha256")"
      echo "sidecar: $newest_n.sha256 mode=$smode size=$(stat -c %s "$f.sha256") mtime_utc=$(date -u -d @"$(stat -c %Y "$f.sha256")" +%FT%TZ) names_the_file=$([ "$sc_name" = "$newest_n" ] && echo yes || echo NO) sha256_equals_file=$([ "$sc_sha" = "$fsha" ] && echo yes || echo NO) sha256sum_-c=$( (cd "$G6_BACKUP_DIR" && sha256sum -c --quiet "$newest_n.sha256" >/dev/null 2>&1) && echo OK || echo FAIL)"
      [ "$smode" = "600" ] || reasons="$reasons sidecar-mode-not-600;"
      ( cd "$G6_BACKUP_DIR" && sha256sum -c --quiet "$newest_n.sha256" >/dev/null 2>&1 ) || reasons="$reasons sha256sum-c-failed;"
      [ "$sc_name" = "$newest_n" ] || reasons="$reasons sidecar-names-another-file;"
    else echo "sidecar: ABSENT"; reasons="$reasons sidecar-absent;"; fi
    if gzip -t "$f" 2>/dev/null; then gz=ok; else gz=CORRUPT; reasons="$reasons gzip-t-failed;"; fi
    hdr="$(zcat "$f" 2>/dev/null | sed -n 2p | cut -c1-40 || true)"; done_="$(zcat "$f" 2>/dev/null | tail -c 4096 | grep -c '^-- PostgreSQL database dump complete$' || true)"
    ct="$(zcat "$f" 2>/dev/null | grep -c '^CREATE TABLE ' || true)"; cp="$(zcat "$f" 2>/dev/null | grep -c '^COPY ' || true)"; rows="$(zcat "$f" 2>/dev/null | awk '/^COPY /{c=1;next} c&&/^\\\.$/{c=0;next} c{n++} END{print n+0}')"; bu="$(zcat "$f" 2>/dev/null | wc -c)"
    live_tables="$(q "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")"
    echo "dump: gzip=$gz header='$hdr' dumped_from=$(zcat "$f" 2>/dev/null | grep -m1 -oE 'Dumped from database version [0-9.]+' | awk '{print $NF}') pg_dump=$(zcat "$f" 2>/dev/null | grep -m1 -oE 'Dumped by pg_dump version [0-9.]+' | awk '{print $NF}') complete_marker=$done_ create_table=$ct live_tables=$live_tables copy_blocks=$cp data_rows=$rows uncompressed_bytes=$bu size_floor_1024=$([ "$fsz" -ge 1024 ] && echo yes || echo NO)"
    [ "$hdr" = "-- PostgreSQL database dump" ] || reasons="$reasons dump-header-missing;"
    [ "$done_" = "1" ] || reasons="$reasons completion-marker-missing;"
    [ "$ct" = "$live_tables" ] && [ "$ct" = "72" ] || reasons="$reasons create-table-count-$ct-vs-live-$live_tables;"
    [ "$fsz" -ge 1024 ] || reasons="$reasons size-below-floor;"
    local prevf; prevf="$(ls -1 "$G6_BACKUP_DIR"/leadcapture-*.sql.gz 2>/dev/null | xargs -r -n1 basename | sort | tail -2 | head -1 || true)"
    if [ -n "$prevf" ] && [ "$prevf" != "$newest_n" ]; then echo "previous newest: $prevf size=$(stat -c %s "$G6_BACKUP_DIR/$prevf") new_vs_previous_size_pct=$(( fsz * 100 / $(stat -c %s "$G6_BACKUP_DIR/$prevf") ))"; fi
  else echo "newest file: none found"; reasons="$reasons no-backup-file;"; fi
  section "retention and hygiene (KEEP=14)"
  local nb ns ntmp norph
  nb="$(ls -1 "$G6_BACKUP_DIR"/leadcapture-*.sql.gz 2>/dev/null | wc -l)"; ns="$(ls -1 "$G6_BACKUP_DIR"/leadcapture-*.sql.gz.sha256 2>/dev/null | wc -l)"
  ntmp="$(ls -1A "$G6_BACKUP_DIR" 2>/dev/null | grep -cE '\.(tmp|part|partial)$' || true)"
  norph=0; for sc in "$G6_BACKUP_DIR"/leadcapture-*.sql.gz.sha256; do [ -e "$sc" ] || continue; [ -e "${sc%.sha256}" ] || norph=$((norph + 1)); done
  echo "dir: $(stat -c 'mode=%a owner=%U' "$G6_BACKUP_DIR") backups=$nb (limit 14) sidecars=$ns temporary_files=$ntmp orphan_sidecars=$norph other_entries=[$(ls -1A "$G6_BACKUP_DIR" | grep -vE '^leadcapture-[0-9]{8}-[0-9]{6}\.sql\.gz(\.sha256)?$' | tr '\n' ' ')] lock_file=$([ -e "$G6_BACKUP_DIR/.backup.lock" ] && echo "present (created by the script's flock; expected)" || echo absent)"
  [ "$nb" -le 14 ] || reasons="$reasons more-than-14-backups;"
  [ "$ntmp" = "0" ] && [ "$norph" = "0" ] || reasons="$reasons temporary-or-orphan-files;"
  [ "$(stat -c %a "$G6_BACKUP_DIR")" = "700" ] || reasons="$reasons dir-mode-not-700;"
  g6c1_no_backup_running || reasons="$reasons backup-process-running;"
  echo "-- complete inventory (newest first; compare with the activation after-list) --"; g6_backup_lines
  section "ordinary scheduler activity since the activation (reported separately; not caused by this verification)"
  q "select 'job_queue now: '||coalesce(string_agg(status||'='||n, ' '), 'empty') from (select status, count(*) n from job_queue group by status order by status) s"
  q "select 'recurring sweeps since 2026-09-22T15:35:10Z: '||coalesce(string_agg(k||'='||n||'/'||st, ' ' order by k, st), 'none') from (select split_part(coalesce(dedupe_key,''), ':', 2) k, status st, count(*) n from job_queue where name='recurring.sweep' and enqueued_at > to_timestamp(1790091310) group by 1,2) s"
  q "select 'maintenance sweeps since activation: '||coalesce(string_agg('id='||id||' status='||status||' completed='||coalesce(to_char(completed_at,'YYYY-MM-DD HH24:MI:SS'),'null'), '; ' order by id), 'none') from job_queue where name='recurring.sweep' and dedupe_key like 'recurring:maintenance:%' and enqueued_at > to_timestamp(1790091310)"
  q "select 'non-recurring jobs since activation: '||coalesce(string_agg(name||'='||n, ' ' order by name), 'none') from (select name, count(*) n from job_queue where name<>'recurring.sweep' and enqueued_at > to_timestamp(1790091310) group by name) s"
  q "select 'job_queue dead_last_24h='||count(*) from job_queue where status='dead' and dead_at > now() - interval '24 hours'"
  [ "$(q "select count(*) from job_queue where status='dead' and dead_at > now() - interval '24 hours'")" = "0" ] || echo "NOTE: dead jobs in the last 24h"
  echo "maintenance sweep summaries logged by the api since activation (numbers only):"
  { docker logs --since 2026-09-22T15:35:10Z "$API_CID" 2>&1 | grep -E '"msg":"Maintenance sweep complete"' || true; } | while read -r l; do [ -n "$l" ] || continue; echo "  $(g6fc_iso_ms "$(echo "$l" | grep -oE '"time":[0-9]+' | grep -oE '[0-9]+')") $(echo "$l" | grep -oE '"summary":\{[^}]*\}')"; done
  echo "  (none = no sweep has run since activation; the cadence is 6 h from the api start at 15:26:44Z, next 21:27 / 03:27 UTC)"
  echo "api error-level lines since $day_iso 03:00 UTC: $(docker logs --since "${day_iso}T03:00:00Z" "$API_CID" 2>&1 | grep -c '"level":50' || true) (non-AppError: $(docker logs --since "${day_iso}T03:00:00Z" "$API_CID" 2>&1 | grep '"level":50' | grep -vc '"type":"_AppError"' || true))"
  echo "postgres log lines mentioning pg_dump/backup since $day_iso 03:00 UTC: $(docker logs --since "${day_iso}T03:00:00Z" "$PG_CID" 2>&1 | grep -ciE 'pg_dump|backup' || true)"
  section "verdict"
  echo "now_epoch_ms=$(date +%s%3N)"
  if [ -z "$reasons" ]; then echo "FIRST_CYCLE=PASS file=${newest_n:-none} sha256=${bk_sha:-none}"; else echo "FIRST_CYCLE=FAIL reasons=[$reasons]"; fail "first scheduled cycle verification failed: $reasons"; fi
  log "g6fc-verify complete (read-only)"
}

phase_g6fc_queue() {
  local t1="$ARG1" t2="$ARG2" before after
  [[ "$t1" =~ ^[0-9]{10}$ ]] && [[ "$t2" =~ ^[0-9]{10}$ ]] && [ "$t2" -gt "$t1" ] || fail "ARG1/ARG2 must be epoch seconds (before < after)"
  before="$(echo "$ARG3" | cut -d'|' -f1)"; after="$(echo "$ARG3" | cut -d'|' -f2)"
  [[ "$before" =~ ^[0-9]+$ ]] && [[ "$after" =~ ^[0-9]+$ ]] || fail "ARG3 must be <before>|<after> counts"
  section "read-only guard"
  if q "create temp table b20_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard did not hold"; else echo "session refuses writes (default_transaction_read_only=on): OK"; fi
  section "window: before=$before at $(date -u -d @"$t1" +%FT%TZ)  after=$after at $(date -u -d @"$t2" +%FT%TZ)"
  docker inspect -f "api: id={{.Id}} created={{.Created}} started={{.State.StartedAt}}" "$API_CID"
  echo "api log covers from: $(docker logs --timestamps "$API_CID" 2>&1 | head -1 | cut -c1-30) (container logs start at container creation; the previous container's log is gone with it)"
  section "retention configuration in effect (non-secret numeric keys; unset = code default)"
  for k in JOBS_DRIVER JOBS_QUEUE_COMPLETED_RETENTION_DAYS JOBS_QUEUE_DEAD_RETENTION_DAYS JOBS_MAINTENANCE_DELAY_MS JOBS_MAINTENANCE_INTERVAL_MS; do envkey "$k" yes; done
  echo "code defaults (artifacts/api-server/src/config.ts at HEAD): $(grep -oE 'queueCompletedDays: numEnv\("JOBS_QUEUE_COMPLETED_RETENTION_DAYS", [0-9]+' "$APP_DIR/artifacts/api-server/src/config.ts" | grep -oE '[0-9]+$') days completed / $(grep -oE 'queueDeadDays: numEnv\("JOBS_QUEUE_DEAD_RETENTION_DAYS", [0-9]+' "$APP_DIR/artifacts/api-server/src/config.ts" | grep -oE '[0-9]+$') days dead; maintenance first delay $(grep -oE 'maintenanceFirstDelayMs: numEnv\("JOBS_MAINTENANCE_DELAY_MS", [0-9_]+' "$APP_DIR/artifacts/api-server/src/config.ts" | grep -oE '[0-9_]+$') ms, interval $(grep -oE 'maintenanceIntervalMs: numEnv\("JOBS_MAINTENANCE_INTERVAL_MS", [^,]+' "$APP_DIR/artifacts/api-server/src/config.ts" | sed 's/.*, //')"
  section "maintenance evidence in the api log (JSON lines; the summary carries counts only)"
  { docker logs "$API_CID" 2>&1 | grep -E '"msg":"Recurring task scheduler started' || true; } | head -1 | while read -r l; do [ -n "$l" ] || continue; echo "scheduler started $(g6fc_iso_ms "$(echo "$l" | grep -oE '"time":[0-9]+' | grep -oE '[0-9]+')") $(echo "$l" | grep -oE '"maintenanceIntervalMs":[0-9]+')"; done
  local reported="" n_sweeps=0
  while read -r l; do
    [ -n "$l" ] || continue
    local ts summ; ts="$(echo "$l" | grep -oE '"time":[0-9]+' | grep -oE '[0-9]+')"; summ="$(echo "$l" | grep -oE '"summary":\{[^}]*\}')"
    echo "maintenance sweep complete at $(g6fc_iso_ms "$ts") $summ"
    if [ $((ts / 1000)) -gt "$t1" ] && [ $((ts / 1000)) -le "$t2" ]; then n_sweeps=$((n_sweeps + 1)); reported="$(echo "$summ" | grep -oE '"queueJobs":[0-9]+' | grep -oE '[0-9]+$')"; fi
  done < <(docker logs "$API_CID" 2>&1 | grep -E '"msg":"Maintenance sweep complete"')
  echo "maintenance task failures logged: $(docker logs "$API_CID" 2>&1 | grep -cE '"msg":"(Maintenance task failed|Scheduled task dispatch failed)"' || true)"
  echo "sweeps inside the window: $n_sweeps reported_queueJobs_deleted=${reported:-none}"
  section "maintenance sweep rows in job_queue (metadata only, no payload)"
  q "select 'sweep id='||id||' status='||status||' attempts='||attempts||' key='||coalesce(dedupe_key,'')||' enqueued='||to_char(enqueued_at,'YYYY-MM-DD HH24:MI:SS.MS')||' started='||coalesce(to_char(started_at,'HH24:MI:SS.MS'),'null')||' completed='||coalesce(to_char(completed_at,'YYYY-MM-DD HH24:MI:SS.MS'),'null')||' worker='||coalesce(worker_id,'null')||' last_error='||coalesce(last_error,'null') from job_queue where name='recurring.sweep' and dedupe_key like 'recurring:maintenance:%' order by id desc limit 8"
  local sweep_in_window; sweep_in_window="$(q "select count(*) from job_queue where name='recurring.sweep' and dedupe_key like 'recurring:maintenance:%' and completed_at > to_timestamp($t1) and completed_at <= to_timestamp($t2)")"
  echo "maintenance sweep rows completed inside the window: $sweep_in_window"
  section "completed-row age profile vs the 7-day retention cut-off"
  q "select 'completed rows now='||count(*)||' min_completed_at='||coalesce(min(completed_at)::text,'null')||' max_completed_at='||coalesce(max(completed_at)::text,'null') from job_queue where status='completed'"
  q "select 'sweep '||to_char(completed_at,'YYYY-MM-DD HH24:MI:SS')||': cutoff='||to_char(completed_at - interval '7 days','YYYY-MM-DD HH24:MI:SS')||' completed rows older than that cutoff still present='||(select count(*) from job_queue j where j.status='completed' and j.completed_at < s.completed_at - interval '7 days') from job_queue s where s.name='recurring.sweep' and s.dedupe_key like 'recurring:maintenance:%' and s.completed_at > to_timestamp($t1) and s.completed_at <= to_timestamp($t2) order by s.id"
  q "select 'rows completed in the 7 days before the window start (would survive a sweep at window start)='||count(*) from job_queue where status='completed' and completed_at >= to_timestamp($t1) - interval '7 days' and completed_at <= to_timestamp($t1)"
  section "reconciliation"
  local added; added="$(q "select count(*) from job_queue where enqueued_at > to_timestamp($t1) and enqueued_at <= to_timestamp($t2)")"
  q "select 'rows enqueued inside the window by task: '||coalesce(string_agg(k||'='||n, ' ' order by k), 'none') from (select coalesce(nullif(split_part(coalesce(dedupe_key,''), ':', 2),''), name) k, count(*) n from job_queue where enqueued_at > to_timestamp($t1) and enqueued_at <= to_timestamp($t2) group by 1) s"
  q "select 'rows enqueued inside the window (metadata only): '||coalesce(string_agg('id='||id||' task='||coalesce(nullif(split_part(coalesce(dedupe_key,''), ':', 2),''), name)||' status='||status||' enqueued='||to_char(enqueued_at,'HH24:MI:SS.MS')||' completed='||coalesce(to_char(completed_at,'HH24:MI:SS.MS'),'null'), '; ' order by id), 'none') from job_queue where enqueued_at > to_timestamp($t1) and enqueued_at <= to_timestamp($t2)"
  q "select 'rows enqueued within 3 s of either window edge (boundary check): '||coalesce(string_agg('id='||id||' enqueued='||to_char(enqueued_at,'HH24:MI:SS.MS'), '; ' order by id), 'none') from job_queue where (enqueued_at between to_timestamp($t1) - interval '3 seconds' and to_timestamp($t1) + interval '3 seconds') or (enqueued_at between to_timestamp($t2) - interval '3 seconds' and to_timestamp($t2) + interval '3 seconds')"
  local surviving; surviving="$(q "select count(*) from job_queue where enqueued_at <= to_timestamp($t1)")"
  local implied=$(( before + added - after ))
  echo "before=$before + enqueued_in_window=$added - after=$after => implied_deleted=$implied ; rows enqueued before the window and still present=$surviving (before - implied_deleted = $(( before - implied )))"
  echo "reported by the maintenance summary inside the window: queueJobs=${reported:-none} (sweeps in window: $n_sweeps; sweep rows completed in window: $sweep_in_window)"
  echo "now_epoch_ms=$(date +%s%3N)"
  if [ "$n_sweeps" = "1" ] && [ "$sweep_in_window" = "1" ] && [ -n "$reported" ] && [ "$reported" = "$implied" ]; then echo "QUEUE_DELTA=PROVEN cause=maintenance-sweep(cleanupQueueJobs) deleted=$reported"; else echo "QUEUE_DELTA=UNEXPLAINED implied=$implied reported=${reported:-none} sweeps=$n_sweeps"; fi
  log "g6fc-queue complete (read-only)"
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
  c4-verify) phase_c4_verify ;;
  c4-perm-column) phase_c4_perm_column ;;
  c4-legacy-grant) phase_c4_legacy_grant ;;
  b22-infra) phase_b22_infra ;;
  b22-objects) phase_b22_objects ;;
  b22-cleanup) phase_b22_cleanup ;;
  b22-verify) phase_b22_verify ;;
  b22-listener) phase_b22_listener ;;
  g3-count) phase_g3_count ;;
  g3-verify) phase_g3_verify ;;
  g6-inventory) phase_g6_inventory ;;
  g6-restore) phase_g6_restore ;;
  g6-verify) phase_g6_verify ;;
  g6c1-preflight) phase_g6c1_preflight ;;
  g6c1-backup) phase_g6c1_backup ;;
  g6c2-preflight) phase_g6c2_preflight ;;
  g6act-postdeploy) phase_g6act_postdeploy ;;
  g6act-backup) phase_g6act_backup ;;
  g6act-cron) phase_g6act_cron ;;
  g6fc-verify) phase_g6fc_verify ;;
  g6fc-queue) phase_g6fc_queue ;;
  *) fail "phase '$PHASE' is not implemented in this revision of the ops script" ;;
esac
