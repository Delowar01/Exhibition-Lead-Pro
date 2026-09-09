#!/bin/bash
# =============================================================================
# Batch 20 — hosted READ-ONLY inspection of the dev VPS database (ONE-OFF ops
# script, not application code). Executed on the VPS as the deploy user by the
# TEMPORARY workflow .github/workflows/b20-hosted-inspection.yml.
#
# Strictly read-only: every query runs in a psql session with
# default_transaction_read_only=on, so any accidental write is refused by
# PostgreSQL itself. No env file is read, no container is touched, no dump, no
# checkout change, no DDL, no Stripe call. Only aggregate counts, distinct
# plan/status values, constraint/index definitions and row IDs are printed —
# never names, emails, tokens or provider identifier values.
# =============================================================================
set -euo pipefail
set +x

APP_DIR="${DEPLOY_PATH:-/opt/lead-capture-pro/app}"
cd "$APP_DIR/docker"

log()  { echo "[b20] $*" >&2; }
fail() { echo "[b20] ERROR: $*" >&2; exit 1; }

compose() { docker compose -f docker-compose.yml -f compose.vps.yml "$@"; }
# One read-only SQL statement inside the postgres container as its own POSTGRES_USER
# over the local socket — no password is read, passed, or printed.
q() {
  compose exec -T postgres sh -c 'exec psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tA -F "|" -c "set default_transaction_read_only = on" -c "$1"' sh "$1"
}
section() { echo; echo "== $* =="; }

PG_CID="$(compose ps -q postgres)"
[ -n "$PG_CID" ] || fail "postgres container not found"
API_CID="$(compose ps -q api || true)"
log "postgres container present; api container $( [ -n "$API_CID" ] && echo present || echo absent ); deployed checkout: $(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"

section "read-only guard"
if q "create temp table b20_should_fail (x int)" >/dev/null 2>&1; then fail "read-only guard did not hold"; else echo "session refuses writes (default_transaction_read_only=on): OK"; fi

section "row counts"
q "select 'plans='||(select count(*) from plans)||' subscriptions='||(select count(*) from subscriptions)||' companies='||(select count(*) from companies)||' users='||(select count(*) from users)||' users_not_deleted='||(select count(*) from users where deleted_at is null)"

section "plans rows (id | name | price_monthly | currency | admins | employees | contacts | events | storage_mb | api | trial_days | features | sort | active)"
q "select id||' | '||name||' | '||price_monthly||' | '||currency||' | '||coalesce(admins_limit::text,'null')||' | '||coalesce(employees_limit::text,'null')||' | '||coalesce(contacts_limit::text,'null')||' | '||coalesce(events_limit::text,'null')||' | '||coalesce(storage_limit_mb::text,'null')||' | '||coalesce(api_limit::text,'null')||' | '||trial_days||' | '||features::text||' | '||sort_order||' | '||is_active from plans order by sort_order, id"

section "companies.plan distribution"
q "select coalesce(plan,'<null>')||'='||count(*) from companies group by plan order by 1"
section "companies.status distribution"
q "select coalesce(status,'<null>')||'='||count(*) from companies group by status order by 1"
section "subscriptions.plan distribution"
q "select coalesce(plan,'<null>')||'='||count(*) from subscriptions group by plan order by 1"
section "subscriptions.status distribution"
q "select coalesce(status,'<null>')||'='||count(*) from subscriptions group by status order by 1"
section "companies.plan x status matrix"
q "select plan||'/'||status||'='||count(*) from companies group by plan, status order by 1"

section "companies without a subscription (count, ids)"
q "select count(*)||' ids='||coalesce(string_agg(c.id::text, ',' order by c.id),'none') from companies c left join subscriptions s on s.company_id=c.id where s.id is null"
section "companies without a subscription by companies.status / plan"
q "select c.status||'/'||c.plan||'='||count(*) from companies c left join subscriptions s on s.company_id=c.id where s.id is null group by c.status, c.plan order by 1"
section "duplicate subscriptions per company"
q "select coalesce(string_agg(company_id||'x'||n, ','),'none') from (select company_id, count(*) n from subscriptions group by company_id having count(*)>1) d"
section "orphan subscriptions (no company)"
q "select count(*) from subscriptions s left join companies c on c.id=s.company_id where c.id is null"

section "drift: plan disagreement (count + ids)"
q "select count(*)||' ids='||coalesce(string_agg(c.id::text, ',' order by c.id),'none') from companies c join subscriptions s on s.company_id=c.id where c.plan is distinct from s.plan"
section "drift: plan disagreement pairs (companies.plan -> subscriptions.plan = count)"
q "select c.plan||' -> '||s.plan||'='||count(*) from companies c join subscriptions s on s.company_id=c.id where c.plan is distinct from s.plan group by c.plan, s.plan order by 1"
section "drift: status disagreement pairs (companies.status -> subscriptions.status = count)"
q "select c.status||' -> '||s.status||'='||count(*) from companies c join subscriptions s on s.company_id=c.id where c.status is distinct from s.status group by c.status, s.status order by 1"
section "drift: trial end disagreement"
q "select 'both_null='||count(*) filter (where c.trial_ends_at is null and s.trial_ends_at is null)||' only_company='||count(*) filter (where c.trial_ends_at is not null and s.trial_ends_at is null)||' only_sub='||count(*) filter (where c.trial_ends_at is null and s.trial_ends_at is not null)||' both_set_equal_date='||count(*) filter (where c.trial_ends_at is not null and s.trial_ends_at is not null and c.trial_ends_at::date = s.trial_ends_at)||' both_set_different='||count(*) filter (where c.trial_ends_at is not null and s.trial_ends_at is not null and c.trial_ends_at::date <> s.trial_ends_at) from companies c join subscriptions s on s.company_id=c.id"
section "companies in status trial: trial end null vs set vs lapsed (as of now)"
q "select 'trial_total='||count(*)||' trial_end_null='||count(*) filter (where trial_ends_at is null)||' trial_end_future='||count(*) filter (where trial_ends_at > now())||' trial_end_lapsed='||count(*) filter (where trial_ends_at <= now()) from companies where status='trial'"
section "subscriptions: renewal_date / trial_ends_at population"
q "select 'renewal_set='||count(renewal_date)||' renewal_null='||count(*)-count(renewal_date)||' trial_set='||count(trial_ends_at)||' trial_null='||count(*)-count(trial_ends_at) from subscriptions"

section "provider identifiers (presence only — values never printed)"
q "select 'stripe_customer_id_set='||count(stripe_customer_id)||' stripe_subscription_id_set='||count(stripe_subscription_id)||' both_null='||count(*) filter (where stripe_customer_id is null and stripe_subscription_id is null)||' total='||count(*) from subscriptions"
section "any table/column mentioning stripe/billing/invoice/payment/checkout (historical integration evidence)"
q "select coalesce(string_agg(table_name||'.'||column_name, ', ' order by table_name, column_name),'none') from information_schema.columns where table_schema='public' and (column_name ~* 'stripe|invoice|payment|checkout|billing' or table_name ~* 'stripe|invoice|payment|checkout|billing')"

section "limits + usage counters on subscriptions (non-null counts and distinct values)"
for col in scans_limit users_limit admins_limit employees_limit contacts_limit events_limit storage_limit_mb api_limit; do
  q "select '$col: non_null='||count($col)||' distinct='||coalesce((select string_agg(v::text, ',' order by v) from (select distinct $col v from subscriptions where $col is not null) d),'none') from subscriptions"
done
q "select 'subscriptions.scans_used: sum='||coalesce(sum(scans_used),0)||' max='||coalesce(max(scans_used),0)||' nonzero_rows='||count(*) filter (where scans_used>0) from subscriptions"
q "select 'companies.scans_used: sum='||coalesce(sum(scans_used),0)||' max='||coalesce(max(scans_used),0)||' nonzero_rows='||count(*) filter (where scans_used>0) from companies"
q "select 'scans rows total='||count(*)||' manual_interaction_rows='||count(*) filter (where extraction_method='manual')||' completed='||count(*) filter (where status='completed') from scans"

section "platform owners with a tenant company_id (count only)"
q "select 'platform_owner_total='||count(*)||' with_company_id='||count(company_id)||' active_with_company_id='||count(*) filter (where company_id is not null and is_active and deleted_at is null) from users where role='platform_owner'"
section "platform owner company ids (ids only)"
q "select coalesce(string_agg(distinct company_id::text, ',' order by company_id::text),'none') from users where role='platform_owner' and company_id is not null"

section "users per role (not deleted)"
q "select role||'='||count(*) from users where deleted_at is null group by role order by 1"
section "invitations by status"
q "select status||'='||count(*) from invitations group by status order by 1"

section "constraints on plans / subscriptions / companies"
q "select conrelid::regclass||' | '||conname||' | '||contype||' | '||pg_get_constraintdef(oid) from pg_constraint where conrelid in ('companies'::regclass,'subscriptions'::regclass,'plans'::regclass) order by conrelid::regclass::text, conname"
section "indexes on plans / subscriptions / companies"
q "select tablename||' | '||indexname||' | '||indexdef from pg_indexes where schemaname='public' and tablename in ('companies','subscriptions','plans') order by tablename, indexname"
section "columns of subscriptions / plans / companies (name:type:nullable:default)"
for t in subscriptions plans companies; do
  q "select '$t: '||string_agg(column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'<none>'), ' ' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='$t'"
done

section "audit / activity evidence (counts only)"
q "select 'audit subscription.*='||count(*) filter (where action like 'subscription.%')||' company.*='||count(*) filter (where action like 'company.%')||' company.register='||count(*) filter (where action='company.register') from audit_logs"
q "select type||'='||count(*) from activity_logs where type in ('company_created','company_suspended','company_activated') group by type order by 1"

section "schema fingerprint (same formula as the B18 activation)"
q "select md5(string_agg(t, '|' order by t)) from (select table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'') as t from information_schema.columns where table_schema='public' union all select 'idx:'||indexname||':'||indexdef from pg_indexes where schemaname='public' union all select 'con:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace) s"

log "inspection complete (read-only)"
