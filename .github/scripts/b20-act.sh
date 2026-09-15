#!/bin/bash
# =============================================================================
# TEMPORARY — B19/B20 gated hosted activation phases (dev VPS). Run over SSH by
# .github/workflows/b20-hosted-activation.yml as the deploy user.
#   preflight  : STRICTLY READ-ONLY (psql sessions pinned to
#                default_transaction_read_only=on; pg_dump -s; docker inspect).
#                Never reads secret values (only key presence / non-secret values),
#                never prints names, emails (except the operator-supplied lookup
#                key), password hashes, tokens or provider identifier values.
# Other phases are added in later commits of the ops branch and are documented
# in their own headers.
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

  section "schema-only dump (pg_dump -s, gzip, base64 — no data rows)"
  DUMP="$(compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" --schema-only --no-owner --no-privileges "$POSTGRES_DB"' | gzip -9 | base64 -w0)"
  echo "dump_b64_chars=${#DUMP}"
  [ "${#DUMP}" -le 400000 ] || fail "schema dump unexpectedly large; not printing"
  echo "-----BEGIN B20 SCHEMA DUMP-----"
  echo "$DUMP" | fold -w 76
  echo "-----END B20 SCHEMA DUMP-----"
  log "preflight complete (read-only)"
}

case "$PHASE" in
  preflight) phase_preflight ;;
  *) fail "phase '$PHASE' is not implemented in this revision of the ops script" ;;
esac
