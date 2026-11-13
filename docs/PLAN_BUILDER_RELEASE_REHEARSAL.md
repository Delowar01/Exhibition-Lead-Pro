# Plan Builder (Batches 37–43) — Production Rehearsal and Release Procedure

Status: **PROCEDURE ONLY.** Nothing in this document has been executed against the
hosted environment. Every step below that touches the VPS, the production database, the
object storage, Stripe, EAS or a physical device requires its **own separate, explicit
owner authorization** that names the exact commit SHAs, the operator and the window.
Reading this document authorizes nothing.

Revision 2026-11-13 (release review, documentation only): the recovery-runner markers in
step 1 and the deploy-verifier statement in step 8 were corrected against the actual ops
branches (§1a); the A2 window status was updated (no window is approved — **a new A2
window is PENDING OWNER APPROVAL**); the rollback statement in §0 and step 10 was
corrected; the production schema sync became an explicit step (5a); the open sequence
decision and the release-review constraints were recorded (§1b, §4).

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

**Limit of that last statement (verified on local disposable databases, 2026-11-13).** It
holds without reservation only while no subscription is pinned. `6a8dad1` changes
`subscriptions.plan` (platform set-plan, provider sync) without touching
`plan_version_id`. Once the backfill has pinned a subscription, such a change leaves the
pin on the previous plan's version, and the candidate code then treats that tenant as an
integrity fault: sign-in and plain reads keep working, plan-gated features answer 403
`FEATURE_NOT_ENTITLED` and capacity checks raise 409 `SUBSCRIPTION_PLAN_VERSION_INVALID`
until a platform operator repairs the tenant with a same-plan set-plan under the candidate
code. Step 10 carries the check.

## 1. Sequence (strict order; stop at the first failed gate)

| # | Step | Owner authorization | Evidence required before the next step |
| --- | --- | --- | --- |
| 1 | **A2 — recovery backup set** (PostgreSQL dump + object-volume archive + manifest) via the hosted recovery runner `ops/b30-recovery-runner` `62f3dea5` (check mode PASS run 40704707916; **set mode never dispatched**) | complete A2 authorization: named operator, declared quiet period (UTC start / end), informed / paused / no-conflict confirmations. **Window status: none approved — a new A2 window is PENDING OWNER APPROVAL (§1a)** | job conclusion success **and** `B30_RUNNER_RESULT=SET_VERIFIED` with `B30_SET_MARKER=VERIFIED` (the workflow accepts no other result for the set mode; full marker contract in §1a); manifest + SHA256SUMS recorded off-host (custody record) |
| 2 | **A3 — isolated disposable restore rehearsal** of that set (throwaway DB + volume on an internal network; read-back + offline verify) | separate A3 authorization | `RESTORE VERIFIED` with the expected counts; residue proof; cleanup proof |
| 3 | **Off-host copy** of the set (encrypted pack to a new owner-held secret, pull-only, two owner-controlled locations) | separate approval | blob digest recorded through a separate channel; retrieval test |
| 4 | **Schema compatibility review** — read `0040_plan_builder_versions.sql` statement by statement; confirm on a **restored copy** (step 5) that `push` reports no further change after applying it; confirm no column is dropped / renamed / re-typed; confirm `6a8dad1` boots against the extended schema (rollback compatibility) | review sign-off (no host action) | written review note with the SQL digest |
| 5 | **Disposable restore + schema + backfill rehearsal** — restore the A2 set into a throwaway database, apply the schema sync there, run `backfill-plan-versions --snapshot` (BEFORE), `--apply` (dry run then apply), `--snapshot` (AFTER); compare BEFORE / AFTER (0 diffs expected), confirm idempotency (second apply writes nothing), run the API suite's Plan Builder files against the throwaway stack if desired | A3-class authorization (throwaway only) | `DRY_RUN_OK` then `APPLIED`, 0 snapshot diffs, 0 pins on the second run, no production connection (identity guard output) |
| 5a | **Production additive schema sync** — the compose `migrate` one-shot (`drizzle-kit push`) from an image built at **this candidate's commit**, or the reviewed `0040_plan_builder_versions.sql`; both yield the same schema (§1a). No hosted workflow exists for this step: its execution path must be reviewed before it is authorized | separate production-migration authorization; after steps 1–2; inside a declared quiet period | schema fingerprint `c36a8a2d9c7e502a2ce31ff5f3f412d9`; a second `push` from the candidate changes nothing; existing rows unchanged; `6a8dad1` still healthy (`healthz` / `readyz`, a sign-in, a tenant read) |
| 6 | **Production backfill dry run + comparison** — on the production database **only after** the step 5a schema sync is authorized and applied: `--snapshot` + dry run with `--expect-database`, `--expect-host`, `--expect-environment` (if the database carries a marker), never `--apply` | separate authorization naming the database identity and the window | `DRY_RUN_OK`; the planned pin count equals the tenant count of step 5's rehearsal shape; snapshot stored |
| 7 | **Supervised backfill** (`--apply --confirm-production` …) | separate explicit authorization; operator present; inside a declared quiet period | `APPLIED`, AFTER snapshot = BEFORE snapshot (0 diffs), audit rows `plan_version.backfill` / `subscription.pin_version` present |
| 8 | **Deployment** — the ordinary integration of the release branch into `develop` (merge / PR under its own approval; never a force push); the push auto-deploys through `deploy-dev-vps` (verify job → deploy job → health checks → automatic container rollback on health failure). Pre- and post-deploy storage verification: **both** `stage2a_predeploy_snapshot` and `stage2a_postdeploy_verify` on ops `66807b5b` are pinned to the previous deployment (`S2A_DEPLOY_PREV_SHA` = `e559b002`, `S2A_DEPLOY_NEXT_SHA` = `6a8dad1`, schema fingerprint `30c4ecbd…`) and fail closed against today's host; both must be **re-pinned** by a reviewed change on the ops branch (previous = `6a8dad1`, next = the exact SHA `develop` will carry, schema fingerprint after the sync — §1a) before either is dispatched | separate deployment authorization (as in Batch 15) | deploy run SUCCESS, no rollback, post-deploy storage verification 21/21 |
| 9 | **Post-deploy verification** — `/api/healthz`, `/api/readyz`; platform login; `/platform/plans` shows the five fixed plans with `v1` published and every subscription pinned (`unpinned` = 0 on the Plans metrics card); a read-only dry-run migration on a disposable plan (no execute); tenant login unaffected; error-level log count 0 | within the deployment authorization | screenshots / API reads recorded; no 5xx |
| 10 | **Rollback criteria** — any health-check failure (automatic container rollback to the previous SHA), any backfill verdict other than `APPLIED`, any snapshot diff, an `UNPINNED_SUBSCRIBERS` surprise after the backfill, a `SUBSCRIPTION_PLAN_VERSION_INVALID` log record, or a tenant-visible entitlement change that was not reviewed. Rollback of the **code** = redeploy the previous SHA (the additive schema stays; it is ignored by `6a8dad1`). Rollback of the **backfill** is not automatic: pins are reverted only by a reviewed SQL statement under its own authorization (the audit rows identify every pinned subscription). **After any rollback and before the candidate is deployed again:** `select count(*) from subscriptions s join plan_versions v on v.id = s.plan_version_id where v.plan_id <> s.plan` must return 0; every divergent tenant is repaired through the platform set-plan (same plan) under the candidate code. **After step 5a never run the `migrate` one-shot or any `db push` from a checkout older than this candidate:** it removes the new objects — with empty new tables it drops them without a prompt, with data it stops only because it cannot prompt, and it exits 0 in both cases. | separate authorization for any manual revert | incident record |
| 11 | **Android build + physical acceptance** — EAS `preview` APK from the released product commit, physical pass per `reports/ANDROID_RELEASE_READINESS_BATCH38.md` §4–§5 (last recorded device pass: Honor Magic V5, Android 16, Batch 8) | separate build authorization (EAS credentials are an owner action) | signed build id, device matrix results |

## 1a. Recovery and verifier markers of record (audited 2026-11-13 against the ops branches)

Nothing in this section has been executed for this release. The values are read from
`ops/b30-recovery-runner` `62f3dea50206eedb8ad1ca82a1e1dc91d93ec0f3`,
`ops/b25-stage2a-fs-activation-tooling` `66807b5b` and `ops/b25-stage2b-migration-tooling`
`443fa164`; when an ops branch changes, its files win over this table.

| Gate | Exact contract |
| --- | --- |
| A2 dispatch | workflow id `376505024` (path `.github/workflows/b25-stage1-inspection.yml` as served on the recovery branch), ref `ops/b30-recovery-runner`, mode `b30_recovery_set` |
| A2 typed inputs | `confirm_product_sha` = `6a8dad1fe161dc1b31041794e5e3532e9f13327c`; `confirm_recovery` = `CREATE_B30_PRE_COPY_RECOVERY_SET`; `confirm_quiet_period` = `B30 QUIET PERIOD ACTIVE`; `confirm_paused` = `UPLOADS BRANDING EXPORTS DELETIONS PAUSED`; `quiet_start` / `quiet_end` = `YYYY-MM-DDTHH:MMZ` (UTC) |
| A2 window rules (runner side) | same UTC day; start < end; ≤ 240 minutes; active at dispatch with ≥ 10 minutes remaining; no overlap with 03:00–04:00 UTC or 04:15–10:45 UTC; one set per approved window (`REFUSED_window_already_used` otherwise). The application does not enforce the quiet period — the confirmations are the owner's attestation |
| A2 success | the job requires exactly `B30_RUNNER_RESULT=SET_VERIFIED` and host exit 0. Expected companion lines: `B30_PRECONDITIONS=ok`, `B30_WINDOW_SETS_EXISTING=0`, `B30_SET_EXIT=0`, `B30_SET_MARKER=VERIFIED`, `B30_SET_NAME=b30-<stamp>`, `B30_FINGERPRINT=MATCH`, `B30_SHA256SUMS=OK`, `B30_TENANT_FILES=MATCH`, `B30_HEADERS=valid`, `B30_SYMLINKS=none`, `B30_ARCHIVE_FILES=MATCH`, `B30_KEY_ID=single` |
| A2 failure (never a pass, never retried) | `CHECK_FAILED`, `SET_INCOMPLETE` (the incomplete set is preserved for review), `SET_NOT_VERIFIED`, `SET_FAILED`, any `REFUSED_*`; `B30_FAILURE_CLASS` names the class. `SET_OK` is **not** a token of this workflow |
| Check mode (already run once) | mode `b30_recovery_check`, every other input empty → `B30_RUNNER_RESULT=CHECK_OK` (PASS run 40704707916, 2026-10-28). A check PASS is not a recovery set |
| Runner product pin | the runner and its toolkit are pinned to product `6a8dad1` (`B30_PRODUCT_SHA`; the host run refuses unless the checkout **and** `current-deploy.sha` equal it and the migrate image carries that label) with `B30_EXPECTED_UNREGISTERED=4` (phase `pre-copy`). A2 must therefore run **while `6a8dad1` is the deployed product** (before step 8); after any later deployment the runner must be re-pinned by a reviewed change first |
| A3 verdict | `b30-restore-rehearsal.sh` is an operator action on the host (not a runner mode). PASS = final line `RESTORE VERIFIED` (exit 0); anything else is `NOT VERIFIED` (exit 2). For a pre-copy set the offline product verify is expected to classify as `EXPECTED_INCOMPLETE` (unregistered = 4) — that is not a failure; read-back line `B30_READBACK … result=PASS`; cleanup line "no residue" |
| Backfill verdicts | `DRY_RUN_OK` (dry run) and `APPLIED` are the only complete verdicts; `INCOMPLETE`, `INTEGRITY_ERROR`, `VERIFICATION_FAILED` and every guard refusal stop the sequence (`docs/PLAN_VERSION_BACKFILL_RUNBOOK.md`) |
| Deploy verifier markers | `B25_DEPLOY_PREDEPLOY_BASELINE=TRUE` (pre form) and `B25_DEPLOY_POSTDEPLOY_STORAGE_READY=TRUE` (post form), 21 / 21 conditions each — only after the re-pin described in step 8 |
| Schema fingerprint | the hosted tooling's fingerprint of the deployed schema is `30c4ecbd867cd2cd59abcb58581ecb04`; a local push of `6a8dad1` reproduces exactly that value, and that schema plus `0040_plan_builder_versions.sql` (or a `push` of this candidate) yields `c36a8a2d9c7e502a2ce31ff5f3f412d9` (local disposable databases, 2026-11-13). The Stage 2A deploy verifier and the Stage 2B tooling pin the old value and the product `6a8dad1`: after the schema sync they fail closed until re-pinned |

**A2 window status (2026-11-13).** No A2 quiet period is approved. The set mode has never
been dispatched; the only run on the recovery branch is the check above. Any window
discussed before this revision — including 31 October 2026 — has passed unused and cannot
be reused (the runner refuses a window that is not active at dispatch). A new window is
**PENDING OWNER APPROVAL** and must be named, with the operator, in a new complete A2
authorization.

## 1b. Sequence decision pending (release review 2026-11-13)

Steps 6–7 pin subscriptions while `6a8dad1` is still serving requests. That opens the
divergence window described in §0 and makes every later code rollback conditional on the
pin check of step 10. The alternative order — **5a schema sync → 8 deployment → 9
post-deploy verification → 6 dry run → 7 supervised backfill** — keeps every subscription
on the fully compatible `NULL` path until the new code is proven on the host, so a rollback
before the backfill needs no repair. Its constraints: no draft may be created on a fixed
plan before the backfill (the backfill then stops with `INCOMPLETE`), and publishing stays
refused (`UNPINNED_SUBSCRIBERS`) until it has run.

**The order is an owner decision.** Until it is taken the table order stands, with steps
6–8 inside one declared quiet period and no plan change in between.

## 2. Preconditions checked at every gate

* refs unchanged since the authorization (full SHAs compared immediately before acting);
* no GitHub Actions run queued / in progress on the shared concurrency group;
* backup-health run ≤ 36 h old and green;
* a declared quiet period for every data-changing step (the application does not enforce
  a maintenance window — coordination is an attestation);
* exactly one dispatch per authorization, **no retry** on failure: stop, preserve the
  evidence, report;
* **merging into `develop` is the deployment (step 8)** — a push to `develop` starts
  `deploy-dev-vps` and no schema command runs. This candidate must not be merged before the
  additive schema is in place: on the un-migrated schema the API still answers `healthz` /
  `readyz` with ok (so the automatic container rollback does not trigger) while every login
  fails with HTTP 500 (`column "plan_version_id" does not exist`; reproduced on a local
  disposable database, 2026-11-13).

## 3. Explicitly out of scope of this document

Stripe live price registration, period-end plan scheduling / proration / invoicing (D1:
immediate only), Stage 2B object-storage copy, customer-data edits, any production
schema or backfill execution, any hosted dispatch, any APK build.

## 4. Release-review constraints at this candidate (2026-11-13; valid until corrected in code)

None of these affects an existing tenant: every version-1 snapshot is `legacy` (all
features allowed) and carries no allowance.

* **Do not publish an `enforced` version that denies `documents`, `nfc.capture`,
  `workflow.intelligence` or `executive.intelligence`.** The server does not yet enforce
  those denials on every path: document lists stay readable through
  `GET /organizations/:id/documents` and document bytes through `GET /files/:id`; an NFC
  capture saved through `POST /contacts` is not checked (only `POST /scans` is); the AI
  Assistant still returns Workflow and Executive Intelligence results.
* The plan AI allowance is a default, not a cap: a tenant's primary admin can set a higher
  budget, and saving the tenant AI settings in the web portal stores the displayed
  allowance as a tenant value that later plan changes no longer move.
* Do not archive a plan that still has an active provider price mapping or an open
  checkout: provider events for that price are then refused (`PROVIDER_PRICE_UNMAPPED`).
  Deactivate the mapping first. No provider price is registered in this release.
* Web and mobile read entitlements at sign-in; a plan or version change shows in the
  client after the next sign-in (the server decides per request).
* The free-text reason of a plan change or migration is stored in the tenant's audit
  trail and is readable by tenant users who may view security audit entries.
