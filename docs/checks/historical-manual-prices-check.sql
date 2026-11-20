-- Lead Capture Pro — historical manual-price check (READ-ONLY)
--
-- Purpose: find manual prices that may have been typed through the plan-version editor that
-- existed BEFORE the currency correction (it stored "typed x 100" for every currency).
--   zero-decimal currency  : such a value now reads 100 times too large
--   three-decimal currency : such a value now reads 10 times too small
--   whole-unit currency    : the factor is the same; only a typed fraction is wrong
--   two-decimal currency   : unaffected (not listed)
--
-- What it reads: the plan catalogue only (plan_versions.snapshot -> manualPrices and the currency
-- codes of plan_prices) plus ONE COUNT of subscribers per listed version. It prints no company,
-- user, contact or subscription record and no identifier of a tenant.
-- What it writes: nothing. It creates no object (no table, view or temporary object), runs in one
-- READ ONLY transaction and rolls it back. SELECT on plan_versions, plan_prices and subscriptions
-- is the only privilege it needs.
-- It repairs nothing: a manual price is display-only and never billed. A suspect one is re-entered
-- by the Platform Owner in the corrected editor (a published version is immutable: new version, publish).
--
-- Usage (psql):
--   psql -v ON_ERROR_STOP=1 -v cutoff="'<UTC instant the corrected editor was deployed>'" -f historical-manual-prices-check.sql
--   Without -v cutoff every listed price is treated as "may have been typed in the old form".
\set ON_ERROR_STOP on
\pset pager off
\if :{?cutoff}
\else
  \set cutoff '''infinity'''
\endif

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';

\echo '== 0. schema'
SELECT (to_regclass('public.plan_versions') IS NOT NULL) AS plan_builder_schema_present \gset
SELECT :'plan_builder_schema_present' AS plan_builder_schema_present, current_setting('transaction_read_only') AS transaction_read_only;

\if :plan_builder_schema_present

\echo '== 1. manual prices by currency class (counts only)'
WITH m AS (
  SELECT v.id AS version_id, v.plan_id, v.version,
         CASE WHEN v.retired_at IS NOT NULL THEN 'retired' WHEN v.published_at IS NOT NULL THEN 'published' ELSE 'draft' END AS state,
         lower(e->>'currency') AS currency, e->>'interval' AS "interval", (e->>'intervalCount')::int AS interval_count,
         (e->>'unitAmountMinor')::bigint AS stored_minor,
         CASE WHEN lower(e->>'currency') = ANY (ARRAY['bif','clp','djf','gnf','jpy','kmf','krw','mga','pyg','rwf','vnd','vuv','xaf','xof','xpf']) THEN 'zero-decimal'
              WHEN lower(e->>'currency') = ANY (ARRAY['isk','ugx']) THEN 'whole-units'
              WHEN lower(e->>'currency') = ANY (ARRAY['bhd','jod','kwd','omr','tnd']) THEN 'three-decimal'
              WHEN lower(e->>'currency') = ANY (ARRAY['aed','afn','all','amd','ang','aoa','ars','aud','awg','azn','bam','bbd','bdt','bhd','bif','bmd','bnd','bob','brl','bsd','bwp','byn','bzd','cad','cdf','chf','clp','cny','cop','crc','cve','czk','djf','dkk','dop','dzd','egp','etb','eur','fjd','fkp','gbp','gel','gip','gmd','gnf','gtq','gyd','hkd','hnl','htg','huf','idr','ils','inr','isk','jmd','jod','jpy','kes','kgs','khr','kmf','krw','kwd','kyd','kzt','lak','lbp','lkr','lrd','lsl','mad','mdl','mga','mkd','mmk','mnt','mop','mur','mvr','mwk','mxn','myr','mzn','nad','ngn','nio','nok','npr','nzd','omr','pab','pen','pgk','php','pkr','pln','pyg','qar','ron','rsd','rub','rwf','sar','sbd','scr','sek','sgd','shp','sle','sos','srd','std','szl','thb','tjs','tnd','top','try','ttd','twd','tzs','uah','ugx','usd','uyu','uzs','vnd','vuv','wst','xaf','xcd','xcg','xof','xpf','yer','zar','zmw']) THEN 'two-decimal'
              ELSE 'unsupported' END AS kind,
         GREATEST(v.updated_at, v.created_at) AS last_written,
         (GREATEST(v.updated_at, v.created_at) < (:cutoff)::timestamp) AS written_before_cutoff
  FROM plan_versions v
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.snapshot->'manualPrices') = 'array' THEN v.snapshot->'manualPrices' ELSE '[]'::jsonb END) AS e
)
SELECT kind, count(*) AS manual_prices, count(DISTINCT version_id) AS plan_versions,
       count(*) FILTER (WHERE written_before_cutoff) AS written_before_cutoff
FROM m GROUP BY kind ORDER BY kind;

\echo '== 2. every manual price that is NOT in a two-decimal currency'
WITH m AS (
  SELECT v.id AS version_id, v.plan_id, v.version,
         CASE WHEN v.retired_at IS NOT NULL THEN 'retired' WHEN v.published_at IS NOT NULL THEN 'published' ELSE 'draft' END AS state,
         lower(e->>'currency') AS currency, e->>'interval' AS "interval", (e->>'intervalCount')::int AS interval_count,
         (e->>'unitAmountMinor')::bigint AS stored_minor,
         CASE WHEN lower(e->>'currency') = ANY (ARRAY['bif','clp','djf','gnf','jpy','kmf','krw','mga','pyg','rwf','vnd','vuv','xaf','xof','xpf']) THEN 'zero-decimal'
              WHEN lower(e->>'currency') = ANY (ARRAY['isk','ugx']) THEN 'whole-units'
              WHEN lower(e->>'currency') = ANY (ARRAY['bhd','jod','kwd','omr','tnd']) THEN 'three-decimal'
              WHEN lower(e->>'currency') = ANY (ARRAY['aed','afn','all','amd','ang','aoa','ars','aud','awg','azn','bam','bbd','bdt','bhd','bif','bmd','bnd','bob','brl','bsd','bwp','byn','bzd','cad','cdf','chf','clp','cny','cop','crc','cve','czk','djf','dkk','dop','dzd','egp','etb','eur','fjd','fkp','gbp','gel','gip','gmd','gnf','gtq','gyd','hkd','hnl','htg','huf','idr','ils','inr','isk','jmd','jod','jpy','kes','kgs','khr','kmf','krw','kwd','kyd','kzt','lak','lbp','lkr','lrd','lsl','mad','mdl','mga','mkd','mmk','mnt','mop','mur','mvr','mwk','mxn','myr','mzn','nad','ngn','nio','nok','npr','nzd','omr','pab','pen','pgk','php','pkr','pln','pyg','qar','ron','rsd','rub','rwf','sar','sbd','scr','sek','sgd','shp','sle','sos','srd','std','szl','thb','tjs','tnd','top','try','ttd','twd','tzs','uah','ugx','usd','uyu','uzs','vnd','vuv','wst','xaf','xcd','xcg','xof','xpf','yer','zar','zmw']) THEN 'two-decimal'
              ELSE 'unsupported' END AS kind,
         GREATEST(v.updated_at, v.created_at) AS last_written,
         (GREATEST(v.updated_at, v.created_at) < (:cutoff)::timestamp) AS written_before_cutoff
  FROM plan_versions v
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.snapshot->'manualPrices') = 'array' THEN v.snapshot->'manualPrices' ELSE '[]'::jsonb END) AS e
)
SELECT plan_id, version, state, upper(currency) AS currency, "interval" || ' x' || interval_count AS period, stored_minor,
       CASE kind WHEN 'zero-decimal'  THEN stored_minor::text
                 WHEN 'whole-units'   THEN (stored_minor / 100)::text || CASE WHEN stored_minor % 100 <> 0 THEN ' (+fraction)' ELSE '' END
                 WHEN 'three-decimal' THEN to_char(stored_minor / 1000.0, 'FM999999999990.000')
                 ELSE stored_minor::text || ' minor units' END AS reads_now_as,
       CASE WHEN kind = 'unsupported' THEN 'n/a' ELSE to_char(stored_minor / 100.0, 'FM999999999990.00') END AS if_typed_in_old_form,
       to_char(last_written, 'YYYY-MM-DD"T"HH24:MI"Z"') AS last_written_utc,
       CASE
         WHEN kind = 'unsupported' THEN 'UNSUPPORTED CURRENCY - owner decides'
         WHEN kind = 'whole-units' AND stored_minor % 100 = 0 THEN 'consistent (same factor in both forms)'
         WHEN kind = 'whole-units' THEN 'SUSPECT - a fraction was typed'
         WHEN NOT written_before_cutoff THEN 'written by the corrected editor'
         WHEN kind = 'zero-decimal' AND stored_minor % 100 = 0 THEN 'SUSPECT - reads 100x too large if typed in the old form'
         WHEN kind = 'zero-decimal' THEN 'CHECK - old form with a typed fraction, or already correct'
         WHEN kind = 'three-decimal' THEN 'SUSPECT - reads 10x too small if typed in the old form'
       END AS verdict,
       (SELECT count(*) FROM subscriptions s WHERE s.plan_version_id = m.version_id) AS subscribers_on_version
FROM m
WHERE kind <> 'two-decimal'
ORDER BY plan_id, version, currency, "interval";

\echo '== 3. provider prices in non-two-decimal currencies (stored as the provider reports them - informational)'
SELECT upper(currency) AS currency, count(*) AS provider_prices, count(*) FILTER (WHERE active) AS active
FROM plan_prices
WHERE lower(currency) IN ('bif','clp','djf','gnf','jpy','kmf','krw','mga','pyg','rwf','vnd','vuv','xaf','xof','xpf','isk','ugx','bhd','jod','kwd','omr','tnd')
GROUP BY 1 ORDER BY 1;

\echo '== 4. result'
WITH m AS (
  SELECT v.id AS version_id, v.plan_id, v.version,
         CASE WHEN v.retired_at IS NOT NULL THEN 'retired' WHEN v.published_at IS NOT NULL THEN 'published' ELSE 'draft' END AS state,
         lower(e->>'currency') AS currency, e->>'interval' AS "interval", (e->>'intervalCount')::int AS interval_count,
         (e->>'unitAmountMinor')::bigint AS stored_minor,
         CASE WHEN lower(e->>'currency') = ANY (ARRAY['bif','clp','djf','gnf','jpy','kmf','krw','mga','pyg','rwf','vnd','vuv','xaf','xof','xpf']) THEN 'zero-decimal'
              WHEN lower(e->>'currency') = ANY (ARRAY['isk','ugx']) THEN 'whole-units'
              WHEN lower(e->>'currency') = ANY (ARRAY['bhd','jod','kwd','omr','tnd']) THEN 'three-decimal'
              WHEN lower(e->>'currency') = ANY (ARRAY['aed','afn','all','amd','ang','aoa','ars','aud','awg','azn','bam','bbd','bdt','bhd','bif','bmd','bnd','bob','brl','bsd','bwp','byn','bzd','cad','cdf','chf','clp','cny','cop','crc','cve','czk','djf','dkk','dop','dzd','egp','etb','eur','fjd','fkp','gbp','gel','gip','gmd','gnf','gtq','gyd','hkd','hnl','htg','huf','idr','ils','inr','isk','jmd','jod','jpy','kes','kgs','khr','kmf','krw','kwd','kyd','kzt','lak','lbp','lkr','lrd','lsl','mad','mdl','mga','mkd','mmk','mnt','mop','mur','mvr','mwk','mxn','myr','mzn','nad','ngn','nio','nok','npr','nzd','omr','pab','pen','pgk','php','pkr','pln','pyg','qar','ron','rsd','rub','rwf','sar','sbd','scr','sek','sgd','shp','sle','sos','srd','std','szl','thb','tjs','tnd','top','try','ttd','twd','tzs','uah','ugx','usd','uyu','uzs','vnd','vuv','wst','xaf','xcd','xcg','xof','xpf','yer','zar','zmw']) THEN 'two-decimal'
              ELSE 'unsupported' END AS kind,
         GREATEST(v.updated_at, v.created_at) AS last_written,
         (GREATEST(v.updated_at, v.created_at) < (:cutoff)::timestamp) AS written_before_cutoff
  FROM plan_versions v
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.snapshot->'manualPrices') = 'array' THEN v.snapshot->'manualPrices' ELSE '[]'::jsonb END) AS e
)
SELECT count(*) FILTER (WHERE kind <> 'two-decimal') AS listed,
       count(*) FILTER (WHERE kind IN ('zero-decimal','three-decimal') AND written_before_cutoff)
         + count(*) FILTER (WHERE kind = 'whole-units' AND stored_minor % 100 <> 0) AS suspect_or_check,
       count(*) FILTER (WHERE kind = 'unsupported') AS unsupported
FROM m;

\else
  \echo 'plan_versions does not exist in this database: the plan-version editor was never deployed here,'
  \echo 'so no manual price can exist. Nothing to check.'
\endif

ROLLBACK;
