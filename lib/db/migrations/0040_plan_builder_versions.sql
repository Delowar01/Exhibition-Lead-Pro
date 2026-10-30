-- Batch 40 — versioned Plan Builder: the REVIEWED SQL equivalent of the Drizzle
-- schema additions in lib/db/src/schema/{plans,plan_versions,subscriptions,plan_prices}.ts.
--
-- The repository's schema mechanism remains `pnpm --filter @workspace/db run push`
-- (drizzle-kit push, no migration journal). This file exists so the additive change
-- can be reviewed statement by statement and applied to DISPOSABLE LOCAL databases;
-- it is idempotent (safe to re-run) and purely additive (no column is dropped,
-- renamed or re-typed; no row is modified). Parity with `push` is verified locally by
-- applying this file to a copy of the dev database and confirming that `push`
-- afterwards reports no change.
--
-- NOT AUTHORIZED for the production database in this batch. Applying it there
-- requires the owner's separate production-migration authorization, a fresh
-- verified backup set, and must be followed by the dry-run-first version-1 backfill
-- (artifacts/api-server/scripts/backfill-plan-versions.ts).
BEGIN;

-- plans.status: draft | published | archived (the seeded catalog rows become published).
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'published';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plans_status_chk') THEN
    ALTER TABLE "plans" ADD CONSTRAINT "plans_status_chk" CHECK (status in ('draft','published','archived'));
  END IF;
END $$;

-- plan_versions: immutable published snapshots + one draft per plan.
CREATE TABLE IF NOT EXISTS "plan_versions" (
  "id" serial PRIMARY KEY NOT NULL,
  "plan_id" text NOT NULL,
  "version" integer NOT NULL,
  "snapshot" jsonb NOT NULL,
  "trial_policy" jsonb NOT NULL,
  "published_at" timestamp,
  "published_by" integer,
  "retired_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "plan_versions_version_chk" CHECK (version > 0),
  CONSTRAINT "plan_versions_retired_chk" CHECK (retired_at is null or published_at is not null)
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_versions_plan_id_plans_id_fk') THEN
    ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_plans_id_fk"
      FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "plan_versions_plan_version_ux" ON "plan_versions" USING btree ("plan_id","version");
CREATE UNIQUE INDEX IF NOT EXISTS "plan_versions_one_draft_ux" ON "plan_versions" USING btree ("plan_id") WHERE published_at is null;
CREATE INDEX IF NOT EXISTS "plan_versions_plan_published_idx" ON "plan_versions" USING btree ("plan_id","published_at");

-- subscriptions.plan_version_id: nullable pin (NULL = legacy reference to the plan row).
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "plan_version_id" integer;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_plan_version_id_plan_versions_id_fk') THEN
    ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_version_id_plan_versions_id_fk"
      FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "subscriptions_plan_version_idx" ON "subscriptions" USING btree ("plan_version_id");

-- plan_prices.plan_version_id: nullable (NULL = applies to every version).
ALTER TABLE "plan_prices" ADD COLUMN IF NOT EXISTS "plan_version_id" integer;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_prices_plan_version_id_plan_versions_id_fk') THEN
    ALTER TABLE "plan_prices" ADD CONSTRAINT "plan_prices_plan_version_id_plan_versions_id_fk"
      FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

COMMIT;
