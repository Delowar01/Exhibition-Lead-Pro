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
  echo "backup structure: header=$(zcat "$out" | head -1 | cut -c1-40) complete_marker=$(zcat "$out" | tail -3 | grep -c 'PostgreSQL database dump complete') CREATE_TABLE=$(zcat "$out" | grep -c '^CREATE TABLE') COPY=$(zcat "$out" | grep -c '^COPY ') companies_copy=$(zcat "$out" | grep -c '^COPY public.companies') subscriptions_copy=$(zcat "$out" | grep -c '^COPY public.subscriptions')"
  [ "$(zcat "$out" | tail -3 | grep -c 'PostgreSQL database dump complete')" = "1" ] || fail "backup is not a complete dump"
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
  echo "statements=$(grep -cE '^(ALTER|CREATE)' "$HOME/b20-stage1.log") destructive=$(destructive_count "$HOME/b20-stage1.log") result=$(tail -1 "$HOME/b20-stage1.log")"
  classify "$HOME/b20-stage1.log"
  [ "$(grep -cE '^(ALTER|CREATE)' "$HOME/b20-stage1.log")" = "39" ] || fail "stage-1 statement count is not the rehearsed 39"
  [ "$(destructive_count "$HOME/b20-stage1.log")" = "0" ] || fail "stage-1 produced a destructive/unexpected statement"
  grep -q "Changes applied" "$HOME/b20-stage1.log" || fail "stage-1 push did not report 'Changes applied'"
  local f1; f1="$(fingerprint)"; echo "schema_fingerprint=$f1 (expected F1=$EXPECT_F1)"; [ "$f1" = "$EXPECT_F1" ] || fail "post-stage-1 fingerprint differs from the rehearsal"

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
  [ "$rules" = '"update:legacy_active": 1 ' ] || fail "repair rule set [$rules] differs from the expected legacy_active for the single active company"
  for cid in $(q "select id from companies order by id"); do
    local ls; ls="$(q "select status from companies where id=$cid")"
    case "$ls" in
      active) grep -q '"status": "active"' "$HOME/b20-repair-dry.json" || fail "company $cid is active but the planned canonical status is not active" ;;
      *) fail "company $cid has legacy status '$ls' — outside the accepted expectation (active only); stopping" ;;
    esac
  done
  echo "gate passed: the only planned change keeps company 1 active (full access), plan preserved"

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
  echo "statements=$(grep -cE '^(ALTER|CREATE)' "$HOME/b20-stage2.log") destructive=$(destructive_count "$HOME/b20-stage2.log") result=$(tail -1 "$HOME/b20-stage2.log")"
  classify "$HOME/b20-stage2.log"
  [ "$(grep -cE '^(ALTER|CREATE)' "$HOME/b20-stage2.log")" = "27" ] || fail "stage-2 statement count is not the rehearsed 27"
  [ "$(destructive_count "$HOME/b20-stage2.log")" = "0" ] || fail "stage-2 produced a destructive/unexpected statement"
  grep -q "Changes applied" "$HOME/b20-stage2.log" || fail "stage-2 push did not report 'Changes applied'"
  local f2; f2="$(fingerprint)"; echo "schema_fingerprint=$f2 (expected F2=$EXPECT_F2)"; [ "$f2" = "$EXPECT_F2" ] || fail "post-stage-2 fingerprint differs from the rehearsal"
  echo "check+fk constraints on the five tables: $(q "select count(*) from pg_constraint where conrelid in ('subscriptions'::regclass,'plan_prices'::regclass,'billing_checkout_sessions'::regclass,'billing_provider_events'::regclass,'subscription_usage_reservations'::regclass) and contype in ('c','f')") (expected 28)"
  echo "partial unique indexes: $(q "select string_agg(indexname, ' ' order by indexname) from pg_indexes where tablename in ('subscriptions','billing_checkout_sessions') and indexdef ilike '%where%'")"
  run_in_image cardscanner/migrate:b20-stage2 'cd lib/db && npx drizzle-kit push --config ./drizzle.config.ts' 2>&1 | tail -1 | tee "$HOME/b20-stage2-repeat.log"
  grep -q "No changes detected" "$HOME/b20-stage2-repeat.log" || fail "repeat push did not report 'No changes detected'"
  section "final state (API remains STOPPED — the old code is incompatible with the final schema; the deploy brings the new API up)"
  snapshot_rows
  q "select 'tables='||(select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE')||' size='||pg_size_pretty(pg_database_size(current_database()))"
  echo "downtime_start=$T_STOP now=$(date -u +%FT%TZ)"

  STAGE="cleanup-worktrees"
  git -C "$APP_DIR" worktree remove --force "$WT_ROOT/stage1"; git -C "$APP_DIR" worktree remove --force "$WT_ROOT/stage2"; git -C "$APP_DIR" worktree prune; rm -rf "$WT_ROOT"
  rm -f "$HOME"/b20-stage1.log "$HOME"/b20-stage2.log "$HOME"/b20-stage2-repeat.log "$HOME"/b20-repair-dry.json "$HOME"/b20-repair-apply.json "$HOME"/b20-repair-verify.json
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
  [[ "$ARG1" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "ARG1 must be a csv of company ids"
  [[ "$ARG2" =~ ^[0-9]+(,[0-9]+)*$ ]] || fail "ARG2 must be a csv of user ids"
  [ "$ARG3" = "b20smoke.invalid" ] || fail "ARG3 must be the disposable domain"
  section "guard: every target is a disposable smoke row"
  q "select 'company '||id||': '||case when name like 'B20 SMOKE %' then 'disposable' else 'NOT DISPOSABLE' end from companies where id in ($ARG1) order by id"
  [ "$(q "select count(*) from companies where id in ($ARG1) and name not like 'B20 SMOKE %'")" = "0" ] || fail "a target company is not a smoke tenant"
  [ "$(q "select count(*) from users where id in ($ARG2) and email not like '%@$ARG3'")" = "0" ] || fail "a target user is not a smoke user"
  [ "$(q "select count(*) from users where company_id in ($ARG1) and email not like '%@$ARG3'")" = "0" ] || fail "a smoke tenant holds a non-smoke user"
  section "existing rows BEFORE cleanup (must be untouched afterwards)"
  local before; before="$(q "select 'companies='||(select count(*) from companies where id not in ($ARG1))||' users='||(select count(*) from users where id not in ($ARG2) and company_id is distinct from all(array[$ARG1]))||' subscriptions='||(select count(*) from subscriptions where company_id not in ($ARG1))||' audit='||(select count(*) from audit_logs where (company_id is null or company_id not in ($ARG1)) and (user_id is null or user_id not in ($ARG2)))")"; echo "$before"
  section "delete disposable rows"
  echo "sessions=$(qw "with d as (delete from sessions where user_id in ($ARG2) or user_id in (select id from users where company_id in ($ARG1)) returning 1) select count(*) from d")"
  echo "audit_logs=$(qw "with d as (delete from audit_logs where company_id in ($ARG1) or user_id in ($ARG2) returning 1) select count(*) from d")"
  echo "tenant_users=$(qw "with d as (delete from users where company_id in ($ARG1) returning 1) select count(*) from d")"
  echo "owner_users=$(qw "with d as (delete from users where id in ($ARG2) returning 1) select count(*) from d")"
  echo "companies=$(qw "with d as (delete from companies where id in ($ARG1) returning 1) select count(*) from d")"
  section "verify zero disposable rows remain"
  q "select 'companies='||(select count(*) from companies where id in ($ARG1) or name like 'B20 SMOKE %')||' users='||(select count(*) from users where id in ($ARG2) or email like '%@$ARG3')||' subscriptions='||(select count(*) from subscriptions where company_id in ($ARG1))||' intents='||(select count(*) from billing_checkout_sessions where company_id in ($ARG1))||' reservations='||(select count(*) from subscription_usage_reservations where company_id in ($ARG1))||' audit='||(select count(*) from audit_logs where company_id in ($ARG1) or user_id in ($ARG2))||' sessions='||(select count(*) from sessions where user_id in ($ARG2))"
  [ "$(q "select (select count(*) from companies where id in ($ARG1) or name like 'B20 SMOKE %')+(select count(*) from users where id in ($ARG2) or email like '%@$ARG3')+(select count(*) from audit_logs where company_id in ($ARG1) or user_id in ($ARG2))")" = "0" ] || fail "disposable rows remain"
  section "existing rows AFTER cleanup"
  local after; after="$(q "select 'companies='||(select count(*) from companies)||' users='||(select count(*) from users)||' subscriptions='||(select count(*) from subscriptions)||' audit='||(select count(*) from audit_logs)")"; echo "$after"
  snapshot_rows
  section "remove stage images and temporary files"
  docker rmi cardscanner/migrate:b20-stage1 cardscanner/migrate:b20-stage2 >/dev/null 2>&1 && echo "stage images removed" || echo "stage images already absent"
  rm -f "$HOME"/b20-*.log "$HOME"/b20-*.json "$HOME"/b20-baseline-*.txt; rm -rf "$HOME/b20-worktrees"; git -C "$APP_DIR" worktree prune
  echo "leftover temp files: $(ls "$HOME" | grep -c '^b20-' || true); worktrees=$(git -C "$APP_DIR" worktree list | wc -l); app checkout=$(git -C "$APP_DIR" rev-parse HEAD) dirty=$(git -C "$APP_DIR" status --porcelain | wc -l)"
  echo "schema_fingerprint=$(fingerprint)"
  echo "readyz=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/readyz || echo UNAVAILABLE)"
  log "cleanup complete"
}

# Writable SQL — used ONLY by smoke-setup / cleanup (explicit ids) and never by preflight/postdeploy.
qw() { compose exec -T postgres sh -c 'exec psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tA -F "|" -c "$1"' sh "$1"; }

case "$PHASE" in
  preflight) phase_preflight ;;
  migrate) phase_migrate ;;
  postdeploy) phase_postdeploy ;;
  smoke-setup) phase_smoke_setup ;;
  cleanup) phase_cleanup ;;
  *) fail "phase '$PHASE' is not implemented in this revision of the ops script" ;;
esac
