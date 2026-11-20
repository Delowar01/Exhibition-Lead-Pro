-- Platform AI provider management: the REVIEWED SQL equivalent of the Drizzle schema
-- addition in lib/db/src/schema/platform_settings.ts.
--
-- One new table, `platform_settings` (a key and a JSON document per platform-wide
-- setting). Nothing else: no existing table, column, index, constraint or row is
-- touched, and the table is created empty — the application treats an absent row as
-- the documented defaults.
--
-- The repository's schema mechanism remains `pnpm --filter @workspace/db run push`
-- (drizzle-kit push, no migration journal). This file exists so the additive change
-- can be reviewed statement by statement and applied to DISPOSABLE LOCAL databases;
-- it is idempotent (safe to re-run). Parity with `push` is verified locally by applying
-- this file to a database at the post-0040 schema and confirming that `push`
-- afterwards reports no change.
--
-- Independent of 0040 (it references no table of it) and of the proposed index change
-- (0041, not created). It must still be applied AFTER the 0040 release: the hosted
-- release guards are pinned to the post-0040 schema fingerprint, and a database with
-- this table has a different fingerprint. Re-pinning those guards is a separate,
-- owner-authorised operations change.
--
-- NOT AUTHORIZED for the hosted or production database in this batch. The application
-- is safe to run BEFORE this file is applied: without the table it serves the default
-- AI provider policy (read-only) and refuses changes with a clear error.
BEGIN;

-- CREATE TABLE takes no lock on any existing relation, but fail fast all the same.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS "platform_settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" jsonb NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_by" integer,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

COMMIT;

-- Rollback (only while no setting has been saved that must be kept):
--   DROP TABLE IF EXISTS "platform_settings";
-- The application then serves the default policy again. No other object depends on it.
