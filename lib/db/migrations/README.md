# Reviewed schema change artifacts

The schema mechanism of this repository is `pnpm --filter @workspace/db run push`
(drizzle-kit push against the Drizzle schema in `lib/db/src/schema`; there is no
migration journal). The SQL files in this folder are the **reviewed equivalents**
of specific additive changes, written so a change can be read statement by
statement, applied to a disposable local database, and compared against `push`.

| File | Change | Status |
| --- | --- | --- |
| `0040_plan_builder_versions.sql` | Batch 40 — `plans.status`, `plan_versions`, `subscriptions.plan_version_id`, `plan_prices.plan_version_id` | Local / disposable databases only. **Production application is not authorized.** After a future production application the version-1 backfill (`artifacts/api-server/scripts/backfill-plan-versions.ts`, dry-run first) must follow. |

Each file is idempotent and additive. drizzle-kit does not read this folder.
