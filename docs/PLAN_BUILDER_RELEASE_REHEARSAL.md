# Plan Builder (Batches 37–43) — Production Rehearsal and Release Procedure

Status: **PROCEDURE ONLY.** Nothing in this document has been executed against the
hosted environment. Every step below that touches the VPS, the production database, the
object storage, Stripe, EAS or a physical device requires its **own separate, explicit
owner authorization** that names the exact commit SHAs, the operator and the window.
Reading this document authorizes nothing.

## 0. What is being released

| Item | Value |
| --- | --- |
| Deployed product | `develop` = `6a8dad1fe161dc1b31041794e5e3532e9f13327c` (Mobile R1 / R2; deploy-dev-vps run 39979375833) |
| Release candidate chain (linear, each branch descends from the previous one) | `claude/lead-capture-pro-onboarding-dlwfd4` (Batch 37 `9036b188`, Batch 38 `c9d7f52b`) → `claude/batch-39-plan-builder-foundation` (`e275e2f6`) → `claude/batch-40-versioned-plan-builder` (`50990ac7`) → `claude/batch-41-pb3-entitlements` (`8d1b2673`) → `claude/batch-42-pb4-billing` (`8305c116`) → `claude/batch-43-pb5-release-hardening` (this batch) |
| Schema change | **additive only** (Batch 40): `plans.status`, `plan_versions`, `subscriptions.plan_version_id`, `plan_prices.plan_version_id`; reviewed SQL equivalent `lib/db/migrations/0040_plan_builder_versions.sql` (idempotent; no drop / rename / retype). The repository's schema mechanism stays `pnpm --filter @workspace/db run push` (the compose `migrate` one-shot). The deploy script never runs a schema command. |
| Data backfill | `artifacts/api-server/scripts/backfill-plan-versions.ts` (dry run first, one verified transaction, idempotent; `docs/PLAN_VERSION_BACKFILL_RUNBOOK.md`) |
| Provider | the fake provider in tests only; **no Stripe price registration** is part of the release |
| Mobile | APK NOT BUILT; physical acceptance PENDING (`reports/ANDROID_RELEASE_READINESS_BATCH38.md`) |

Compatibility facts that make the sequence safe: a `NULL` `plan_version_id` keeps resolving
from the plan row (legacy path) until the backfill pins it; features are grandfathered
(`legacy` enforcement) for every version-1 snapshot; publishing never moves a subscriber;
the deployed `6a8dad1` code ignores the new columns, so a rollback of the containers after
the additive schema change leaves a working system.

## 1. Sequence (strict order; stop at the first failed gate)

| # | Step | Owner authorization | Evidence required before the next step |
| --- | --- | --- | --- |
| 1 | **A2 — recovery backup set** (PostgreSQL dump + object-volume archive + manifest) via the hosted recovery runner `ops/b30-recovery-runner` `62f3dea5` (check mode PASS run 40704707916; **set mode never dispatched**) | complete A2 authorization: named operator, declared quiet period (UTC start / end), informed / paused / no-conflict confirmations | `B30_RUNNER_RESULT=SET_OK`, manifest + SHA256SUMS recorded off-host (custody record) |
| 2 | **A3 — isolated disposable restore rehearsal** of that set (throwaway DB + volume on an internal network; read-back + offline verify) | separate A3 authorization | `RESTORE VERIFIED` with the expected counts; residue proof; cleanup proof |
| 3 | **Off-host copy** of the set (encrypted pack to a new owner-held secret, pull-only, two owner-controlled locations) | separate approval | blob digest recorded through a separate channel; retrieval test |
| 4 | **Schema compatibility review** — read `0040_plan_builder_versions.sql` statement by statement; confirm on a **restored copy** (step 5) that `push` reports no further change after applying it; confirm no column is dropped / renamed / re-typed; confirm `6a8dad1` boots against the extended schema (rollback compatibility) | review sign-off (no host action) | written review note with the SQL digest |
| 5 | **Disposable restore + schema + backfill rehearsal** — restore the A2 set into a throwaway database, apply the schema sync there, run `backfill-plan-versions --snapshot` (BEFORE), `--apply` (dry run then apply), `--snapshot` (AFTER); compare BEFORE / AFTER (0 diffs expected), confirm idempotency (second apply writes nothing), run the API suite's Plan Builder files against the throwaway stack if desired | A3-class authorization (throwaway only) | `DRY_RUN_OK` then `APPLIED`, 0 snapshot diffs, 0 pins on the second run, no production connection (identity guard output) |
| 6 | **Production backfill dry run + comparison** — on the production database **only after** step 4 schema sync is authorized and applied: `--snapshot` + dry run with `--expect-database`, `--expect-host`, `--expect-environment` (if the database carries a marker), never `--apply` | separate authorization naming the database identity and the window | `DRY_RUN_OK`; the planned pin count equals the tenant count of step 5's rehearsal shape; snapshot stored |
| 7 | **Supervised backfill** (`--apply --confirm-production` …) | separate explicit authorization; operator present; inside a declared quiet period | `APPLIED`, AFTER snapshot = BEFORE snapshot (0 diffs), audit rows `plan_version.backfill` / `subscription.pin_version` present |
| 8 | **Deployment** — the ordinary integration of the release branch into `develop` (merge / PR under its own approval; never a force push); the push auto-deploys through `deploy-dev-vps` (verify job → deploy job → health checks → automatic container rollback on health failure). Pre-deploy: `stage2a_predeploy_snapshot` (ops `66807b5b`); post-deploy: `stage2a_postdeploy_verify` **re-pinned** to the new product SHA (code change on the ops branch required first) | separate deployment authorization (as in Batch 15) | deploy run SUCCESS, no rollback, post-deploy storage verification 21/21 |
| 9 | **Post-deploy verification** — `/api/healthz`, `/api/readyz`; platform login; `/platform/plans` shows the five fixed plans with `v1` published and every subscription pinned (`unpinned` = 0 on the Plans metrics card); a read-only dry-run migration on a disposable plan (no execute); tenant login unaffected; error-level log count 0 | within the deployment authorization | screenshots / API reads recorded; no 5xx |
| 10 | **Rollback criteria** — any health-check failure (automatic container rollback to the previous SHA), any backfill verdict other than `APPLIED`, any snapshot diff, an `UNPINNED_SUBSCRIBERS` surprise after the backfill, a `SUBSCRIPTION_PLAN_VERSION_INVALID` log record, or a tenant-visible entitlement change that was not reviewed. Rollback of the **code** = redeploy the previous SHA (the additive schema stays; it is ignored by `6a8dad1`). Rollback of the **backfill** is not automatic: pins are reverted only by a reviewed SQL statement under its own authorization (the audit rows identify every pinned subscription). | separate authorization for any manual revert | incident record |
| 11 | **Android build + physical acceptance** — EAS `preview` APK from the released product commit, physical pass per `reports/ANDROID_RELEASE_READINESS_BATCH38.md` §4–§5 (last recorded device pass: Honor Magic V5, Android 16, Batch 8) | separate build authorization (EAS credentials are an owner action) | signed build id, device matrix results |

## 2. Preconditions checked at every gate

* refs unchanged since the authorization (full SHAs compared immediately before acting);
* no GitHub Actions run queued / in progress on the shared concurrency group;
* backup-health run ≤ 36 h old and green;
* a declared quiet period for every data-changing step (the application does not enforce
  a maintenance window — coordination is an attestation);
* exactly one dispatch per authorization, **no retry** on failure: stop, preserve the
  evidence, report.

## 3. Explicitly out of scope of this document

Stripe live price registration, period-end plan scheduling / proration / invoicing (D1:
immediate only), Stage 2B object-storage copy, customer-data edits, any production
schema or backfill execution, any hosted dispatch, any APK build.
