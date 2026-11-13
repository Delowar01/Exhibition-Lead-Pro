# Plan Builder (Batches 37–43 + release corrections) — Production Release Procedure

Status: **PROCEDURE ONLY.** No step of §1 has been executed for this release. The only
hosted run of record is the read-only recovery check of 2026-10-28 (§1a). Every step below that touches the VPS, the production database, the
object storage, Stripe, EAS or a physical device requires its **own separate, explicit
owner authorization** that names the exact commit SHAs, the operator and the window.
Reading this document authorizes nothing.

Revision 2026-11-13 (owner release decisions): the sequence of §1 is now the **owner's
decided order — deploy the corrected candidate BEFORE the version-1 backfill**; the cutover
freeze (§1b), the A2 authorization package and its read-only preflight (§3), the
reproducible production schema procedure (§4) and backfill procedure (§5) and the two
rollback procedures (§6) were added; the release-review constraints of the previous
revision were replaced by the corrections that removed them (§8). A2 is **NOT YET
AUTHORIZED**; no window is approved.

## 0. What is being released

| Item | Value |
| --- | --- |
| Deployed product (baseline) | `develop` = `6a8dad1fe161dc1b31041794e5e3532e9f13327c` (Mobile R1 / R2; deploy-dev-vps run 39979375833) |
| Release candidate | one linear chain on top of the baseline: Batch 37 `9036b188` → 38 `c9d7f52b` → 39 `e275e2f6` → 40 `50990ac7` → 41 `8d1b2673` → 42 `8305c116` → 43 `8baaa003` → release-review documentation `18682b75` → **release corrections (this revision)**. The exact head SHA is named in the pull request and in every authorization |
| Schema change | **additive only** (Batch 40): `plans.status`, `plan_versions`, `subscriptions.plan_version_id`, `plan_prices.plan_version_id`; reviewed SQL `lib/db/migrations/0040_plan_builder_versions.sql` (one transaction, idempotent, fail-fast lock timeout; no drop / rename / retype). The release corrections add **no** schema change. The deploy script never runs a schema command |
| Data backfill | `artifacts/api-server/scripts/backfill-plan-versions.ts` (dry run first, one verified transaction, idempotent; `docs/PLAN_VERSION_BACKFILL_RUNBOOK.md`) |
| Provider | the fake provider in tests only; **no Stripe price registration** is part of the release |
| Mobile | APK NOT BUILT; physical acceptance PENDING (`docs/reports/ANDROID_RELEASE_READINESS_BATCH38.md` on the documentation branch, pull request #6). Installed app builds keep working against the corrected API; the corrected mobile behaviour (§8) reaches users only with a new build |

Compatibility facts the sequence relies on (each one proven on local disposable systems;
the evidence is listed in the pull request):

* **Baseline on the extended schema.** `6a8dad1` ignores the new columns and tables: it
  boots, signs users in and serves tenant reads on the schema after `0040`.
* **Candidate on the extended schema before the backfill.** A `NULL` `plan_version_id` is
  the legacy reference to the plan row: the tenant signs in, keeps every feature
  (`legacy` enforcement), keeps the plan row's limits and is refused nothing by any plan
  gate. This is the condition the owner's order depends on.
* **Backfill parity.** Version 1 is built from the plan row and carries no feature
  enforcement and no AI allowance: pinning changes the version reference and nothing else
  (features, limits, overrides, trial policy, AI budgets, access mode — identical).
* **Candidate on the un-migrated schema is NOT compatible.** `healthz` / `readyz` answer ok
  while every sign-in fails with HTTP 500. The candidate is therefore never deployed
  before step 5.
* **Baseline after the backfill is conditionally compatible.** `6a8dad1` changes
  `subscriptions.plan` without touching `plan_version_id`; a pinned tenant changed by the
  old code is then an integrity fault for the candidate (plan-gated features 403,
  capacity checks 409) until repaired (§6 R2). The freeze of §1b exists to keep this
  window closed.

## 1. Sequence of record (owner decision 2026-11-13; strict order; stop at the first failed gate)

| # | Step | Owner authorization | Evidence required before the next step |
| --- | --- | --- | --- |
| 1 | **Code corrections and independent review** — the corrected candidate (E1, E2, E3, M1, M2, M4, M5 and the narrow minors of §8), full local validation, independent review, draft pull request | development only (given) | exact head SHA; test totals of record; reviewer findings closed or listed; pull request still draft |
| 2 | **A2 — recovery backup set** (PostgreSQL dump + object-volume archive + manifest) through the hosted recovery runner, set mode | **NOT YET AUTHORIZED.** Complete A2 authorization per §3 after a fresh read-only preflight; exactly one dispatch | job success **and** `B30_RUNNER_RESULT=SET_VERIFIED` with `B30_SET_MARKER=VERIFIED` (§1a); manifest + SHA256SUMS recorded off-host |
| 3 | **A3 — isolated disposable restore** of that set, **and the approved off-host copy** (encrypted pack, pull-only, owner-controlled locations) | separate A3 authorization; separate off-host approval | `RESTORE VERIFIED`, read-back PASS, residue and cleanup proof; off-host digest recorded through a separate channel and a retrieval test |
| 4 | **Rehearsal on a disposable restored copy** — restore the A2 set into a throwaway database; apply `0040` exactly as in §4; confirm the fingerprint; start the **baseline** image against it (sign-in works); start a **candidate** image against it with every pin still `NULL` (sign-in works; capture each test tenant's effective entitlements); run the backfill with the invocation of §5 (dry run, apply, second apply writes nothing; capture again). **Isolation is part of the gate:** the rehearsal stack runs on an internal network with no outbound access and carries no mail, push, AI, billing or object-storage provider configuration (an API process starts its job workers and schedulers at boot — queued and scheduled work inside the restored copy must not be able to reach anyone); its object storage is a separate throwaway root; the candidate images are built from the candidate commit under their own image names (never over the names the production stack runs); the rehearsal's database setting points at the throwaway database and the backfill's identity block proves it | A3-class authorization (throwaway only; no production connection) | fingerprint `c36a8a2d…`; both images authenticate; `DRY_RUN_OK` then `APPLIED`; identical effective entitlements before and after (comparison rule in §5); identity-guard output naming the throwaway target; the container invocations of §4 / §5 confirmed to work as written (or corrected); destruction of the throwaway database, volume and images with residue proof |
| 5 | **Production additive schema** through the reviewed execution path of §4, while `6a8dad1` is deployed | separate production-schema authorization naming the SQL digest, the operator and the window; freeze of §1b declared | pre-fingerprint `30c4ecbd…`, post-fingerprint `c36a8a2d…`; row counts unchanged; `plan_versions` empty; every `plan_version_id` `NULL` |
| 6 | **Baseline still works on the extended schema** — `healthz` / `readyz`; one Platform Owner sign-in; one tenant sign-in; one tenant read; error-level log count unchanged | within the step-5 authorization | the five checks recorded; no 5xx; no restart loop |
| 7 | **Merge and deploy the approved corrected candidate** — the approved pull request is integrated into `develop` (never a force push); the push is the deployment (`deploy-dev-vps`: verify job → deploy job → health checks → automatic container rollback on a health failure only). The authorization names the integration method: with a fast-forward of `develop` to the reviewed head the deployed SHA **is** the reviewed head; a merge commit or a squash produces a **new** SHA, which is recorded immediately after the merge and is the SHA every later check and pin uses. The Stage 2A deploy verifier is re-pinned by a reviewed ops change first (§1a) or explicitly waived by the owner | separate deployment authorization naming the reviewed head SHA and the method | deploy run success, no rollback; the deployed SHA recorded |
| 8 | **Legacy subscribers before the backfill** (read-only) — every subscription still `NULL`-pinned (`select count(*) from subscriptions where plan_version_id is not null` = 0); Platform Owner sign-in; `/platform/subscriptions` lists every tenant with the plan, status and access mode recorded at step 6; a tenant sign-in confirmed with a designated test tenant account — never with a customer's credentials — whose `GET /auth/me` shows `featureEnforcement: legacy`, every feature true and `planVersionId: null`, whose usage limits equal the plan row (or its override) and whose documents list answers 200; no `SUBSCRIPTION_PLAN_VERSION_INVALID`, no `plan catalog seed failed`, no `does not exist` in the API log | within the step-7 authorization | the checks recorded against the step-6 record; unpinned count = subscription count. **A failed sign-in with green health checks is a rollback trigger (§6 R1) — the automatic rollback does not see it** |
| 9 | **Production version-1 backfill** exactly as in §5: backup gate, image build, snapshot, dry run, supervised apply | **new, separate** backfill authorization naming the database identity, the operator and the window; it covers the enumerated actions of §5, each executed once; freeze still active | a healthy database backup taken after step 7 (§5); `DRY_RUN_OK` with the expected counts, then `APPLIED` |
| 10 | **Verification** — the backfill verdict `APPLIED` (its in-transaction comparison is the authoritative proof of zero entitlement differences; rule in §5); pin integrity queries of §5 B5 all 0; unpinned = 0; `healthz` / `readyz`; Platform Owner sign-in and the test tenant sign-in of step 8 with unchanged features and limits; `/platform/plans` shows every fixed plan with `v1` published; error-level log count unchanged. Only then is the freeze lifted | within the step-9 authorization | the queries, the snapshots and the sign-ins recorded; freeze release recorded |

After the sequence, as separate owner decisions: the Android `preview` build and physical
acceptance (`docs/reports/ANDROID_RELEASE_READINESS_BATCH38.md` on the documentation branch; last recorded device pass:
Honor Magic V5, Android 16, Batch 8) and the re-pin of the recovery and Stage 2B tooling to
the newly deployed commit and schema (§1a).

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
| Runner product and schema pin | the runner and its toolkit are pinned to product `6a8dad1` (`B30_PRODUCT_SHA`; the host run refuses unless the checkout **and** the deployed-commit record equal it and the migrate image carries that label) with `B30_EXPECTED_UNREGISTERED=4` (phase `pre-copy`), and they verify the schema fingerprint. **A2 (step 2) and A3 (step 3) must therefore run before step 5** — while `6a8dad1` is deployed **and** the schema is still the baseline schema. After step 5 or step 7 the runner must be re-pinned by a reviewed ops change before it can run again |
| A3 verdict | `b30-restore-rehearsal.sh` is an operator action on the host (not a runner mode). PASS = final line `RESTORE VERIFIED` (exit 0); anything else is `NOT VERIFIED` (exit 2). For a pre-copy set the offline product verify is expected to classify as `EXPECTED_INCOMPLETE` (unregistered = 4) — that is not a failure; read-back line `B30_READBACK … result=PASS`; cleanup line "no residue" |
| Backfill verdicts | `DRY_RUN_OK` (dry run) and `APPLIED` are the only complete verdicts; `INCOMPLETE`, `INTEGRITY_ERROR`, `VERIFICATION_FAILED` and every guard refusal stop the sequence (`docs/PLAN_VERSION_BACKFILL_RUNBOOK.md`) |
| Deploy verifier | `stage2a_predeploy_snapshot` and `stage2a_postdeploy_verify` on ops `66807b5b` are pinned to the previous deployment (`S2A_DEPLOY_PREV_SHA` = `e559b002`, `S2A_DEPLOY_NEXT_SHA` = `6a8dad1`, schema fingerprint `30c4ecbd…`) and fail closed against today's host. For step 7 both must be re-pinned by a reviewed ops change (previous = `6a8dad1`, next = the exact SHA `develop` will carry, schema fingerprint `c36a8a2d…`). Markers after the re-pin: `B25_DEPLOY_PREDEPLOY_BASELINE=TRUE`, `B25_DEPLOY_POSTDEPLOY_STORAGE_READY=TRUE`, 21 / 21 conditions each |
| Schema fingerprint | hosted tooling's fingerprint of the deployed schema: `30c4ecbd867cd2cd59abcb58581ecb04`; a local push of `6a8dad1` reproduces exactly that value, and that schema plus `0040_plan_builder_versions.sql` (or a `push` of this candidate) yields `c36a8a2d9c7e502a2ce31ff5f3f412d9` (local disposable databases; re-verified for the corrected SQL file). The Stage 2B tooling pins the old value and the product `6a8dad1`: after step 5 it fails closed until re-pinned |

## 1b. Cutover freeze — plan administration and subscription changes

From the start of **step 5** until the verification of **step 10** is recorded, the
following are frozen. The application has no maintenance switch: the freeze is an
operator rule attested by the owner, backed by the guards listed below.

| Frozen | Why |
| --- | --- |
| Plan Builder writes: create a plan or a draft, edit, validate-and-publish, retire, archive, delete a draft | a draft on a fixed plan before the backfill stops the backfill (`INCOMPLETE`); publish and retire are refused anyway (`UNPINNED_SUBSCRIBERS`) until every subscriber is pinned |
| Price registration, activation / deactivation | no provider price is part of this release |
| Per-tenant subscription operations by the Platform Owner: set plan, limit overrides, trial / status transitions, tenant migrations | under the **baseline** code (steps 5–6, and after any rollback) a plan change does not maintain the pin; under the candidate before the backfill it would change the reviewed snapshot |
| New tenant creation and self-service checkout | each creates or changes a subscription; neither is needed during the window |

How the freeze is verified at each gate (read-only): audit rows later than the declared
freeze start whose action starts with `plan.`, `plan_version.`, `billing.price_mapping.` or
`subscription.` are listed before steps 6, 7, 9 and 10. Expected: none — except, after step
9, exactly the backfill's own `plan_version.backfill` / `subscription.pin_version` rows.
Two kinds of rows are not operator actions and are judged, not assumed away:
`subscription.trial_expired` is written by the lifecycle sweep when a tenant's trial ends
(it legitimately changes that tenant's access mode — note it, it explains a difference in
the snapshots of §5); `subscription.checkout_started` / `subscription.checkout_expired`
would mean self-service checkout is in use — it must be confirmed off for the window at the
freeze start (the platform billing status reports whether self-service checkout is enabled
and whether a provider is available; the hosted values are not verified by this document).
Any other row stops the sequence for review. Do not run a tenant migration while the
backfill runs: the two lock plans and subscriptions in opposite order.

Tenants are not blocked from ordinary work during the freeze (contacts, scans, documents,
follow-ups): none of it touches plans or subscriptions.

## 2. Preconditions checked at every gate

* refs unchanged since the authorization (full SHAs compared immediately before acting);
* no GitHub Actions run queued / in progress on the shared concurrency group;
* backup-health run ≤ 36 h old and green;
* a declared quiet period for every data-changing step (the application does not enforce
  a maintenance window — coordination is an attestation);
* one authorization covers exactly the enumerated actions of its step, each performed
  once; **no retry** on failure: stop, preserve the evidence, report;
* **merging into `develop` is the deployment (step 7)** — a push to `develop` starts
  `deploy-dev-vps` and no schema command runs. A documentation-only merge deploys too.

## 3. A2 — authorization package and read-only preflight

**A2 is not authorized.** The window discussed earlier (31 October 2026) expired unused and
cannot be reused. The following is what a complete authorization must contain and what must
be re-verified, read-only, immediately before the owner signs it and again immediately
before the single dispatch. Tenant notifications, paused operations and a clear maintenance
window are **never assumed** — they are current statements of the owner.

### 3.1 Authorization text (the owner completes the fields marked OWNER)

| Field | Value |
| --- | --- |
| Operation | A2 — pre-copy recovery set, set mode; exactly one dispatch; no retry; stop and report on any result other than `SET_VERIFIED` |
| Repository / workflow / ref | `Delowar01/Exhibition-Lead-Pro`; workflow id `376505024`; ref `ops/b30-recovery-runner` at `62f3dea50206eedb8ad1ca82a1e1dc91d93ec0f3`; mode `b30_recovery_set` |
| `confirm_product_sha` | `6a8dad1fe161dc1b31041794e5e3532e9f13327c` |
| `confirm_recovery` | `CREATE_B30_PRE_COPY_RECOVERY_SET` |
| `confirm_quiet_period` | `B30 QUIET PERIOD ACTIVE` |
| `confirm_paused` | `UPLOADS BRANDING EXPORTS DELETIONS PAUSED` |
| `quiet_start` / `quiet_end` | **OWNER** — one UTC day, `YYYY-MM-DDTHH:MMZ`, ≤ 240 minutes, outside 03:00–04:00 and 04:15–10:45 UTC, with the dispatch at least 10 minutes before the end. The scheduled backup-health workflow has recently started between about 10:30 and 13:15 UTC: choose a window that does not overlap it and confirm in the preflight that no run is queued or in progress |
| Named operator | **OWNER** — who dispatches and who watches the run |
| Tenant notification statement | **OWNER** — which tenants were informed, by which channel, when; or an explicit statement that no notification is required for a backup-only window. Not verifiable by tooling |
| Paused-operations statement | **OWNER** — uploads, branding changes, exports and deletions are paused for the window, and how that was arranged. The application does not enforce it |
| No-conflict statement | **OWNER** — no other maintenance, deployment or data operation overlaps the window |
| Custody | **OWNER** — where the manifest and SHA256SUMS are recorded off-host after success, and by whom |
| On failure | preserve the run and any incomplete set; no second dispatch under this authorization; report the `B30_RUNNER_RESULT` and `B30_FAILURE_CLASS` lines |

### 3.2 Read-only preflight (no dispatch, no host access)

| # | Check | Expected |
| --- | --- | --- |
| P1 | `develop`, `ops/b30-recovery-runner`, the release pull-request head | `6a8dad1…`, `62f3dea5…`, the reviewed head — unchanged |
| P2 | the recovery workflow is registered on the recovery ref and still offers `b30_recovery_set` | workflow id `376505024`, state active |
| P3 | GitHub Actions runs queued or in progress, repository-wide | 0 |
| P4 | latest `deploy-dev-vps` run | run 39979375833, success, head `6a8dad1…` — the deployed product has not changed |
| P5 | latest backup-health run | success, ≤ 36 h old; note its start time against the proposed window |
| P6 | runs on the recovery ref | exactly the check of record (run 40704707916, `CHECK_OK`, 2026-10-28); no set was ever dispatched |
| P7 | toolkit integrity on the recovery ref (its checksum file verifies; its own test suite passes locally) | all files match |
| P8 | window arithmetic against the runner rules of §1a | valid |
| P9 | owner statements of §3.1 present, dated and current | complete |

What the preflight **cannot** verify without a hosted run: the host's deployed-commit
record, the migrate image label, free disk space, the object-volume state and whether the
check of 2026-10-28 would still pass today. The set mode re-checks them itself
(`B30_PRECONDITIONS=ok`) and refuses otherwise. Because the last hosted check is more than
two weeks old, a fresh **check-mode** dispatch shortly before the set is recommended; it is
a hosted dispatch and needs its own authorization.

### 3.3 Preflight result of 2026-11-13 (read-only; a snapshot — repeat it before signing and before dispatch)

| # | Result |
| --- | --- |
| P1 | `develop` = `6a8dad1fe161dc1b31041794e5e3532e9f13327c`; `ops/b30-recovery-runner` = `62f3dea50206eedb8ad1ca82a1e1dc91d93ec0f3` — unchanged |
| P2 | the run of record on the recovery ref carries workflow id `376505024` at the registered path — consistent. The live registry state is re-read by the runner itself at dispatch |
| P3 | 0 runs queued, 0 in progress |
| P4 | latest `develop` run: `deploy-dev-vps` 39979375833, success, head `6a8dad1…` (2026-10-23) |
| P5 | latest backup-health run: 43223378901, success, started 2026-11-12 13:01 UTC (about 14 hours old at the time of the check) |
| P6 | exactly one run on the recovery ref: 40704707916, check mode, success, 2026-10-28 |
| P7 | toolkit checksum file on the recovery ref: 5 / 5 files match; the runner's local test suite: 200 passed, 0 failed (stubbed; no Docker, no hosted action) |
| P8, P9 | **open** — no window is proposed and no owner statement exists yet |

## 4. Production schema — execution procedure prepared for review (step 5; NOT executed)

**Path of record: the reviewed SQL file**, applied with `psql` inside the database
container in the file's own single transaction. It is preferred over the `migrate`
one-shot (`drizzle-kit push`) because every statement is reviewed in advance, the result is
deterministic, it needs no image built from a commit that is not deployed yet, and it fails
fast: with `lock_timeout = 5s` a conflicting long-running transaction makes the whole file
roll back untouched instead of queueing an exclusive lock in front of every request.

No reviewed hosted workflow exists for this step. The owner authorizes one of: (a) a
supervised operator session on the host that runs exactly the commands below, or (b) a new
runner mode on an ops branch that wraps exactly these commands — a reviewed change of its
own, not part of this release candidate.

Preconditions: steps 2–4 evidence recorded; `6a8dad1` deployed; freeze declared (§1b);
no Actions run queued or in progress; the authorization names the file's SHA-256 digest.

| # | Action | Must show |
| --- | --- | --- |
| S1 | take `lib/db/migrations/0040_plan_builder_versions.sql` from the **exact authorized commit**; compute its SHA-256 | equals the digest in the authorization |
| S2 | pre-state, read-only: the hosted tooling's schema-fingerprint query; row counts of `plans`, `subscriptions`, `plan_prices`; existence of `subscriptions.plan_version_id` | fingerprint `30c4ecbd867cd2cd59abcb58581ecb04`; counts recorded; the column does not exist |
| S3 | apply the file once: `docker compose -f docker/docker-compose.yml -f docker/compose.vps.yml exec -T postgres psql -U <database user> -d <database name> -v ON_ERROR_STOP=1 -f - < 0040_plan_builder_versions.sql` | `COMMIT` as the last statement result; exit 0. A lock timeout or any error = nothing applied: stop and report, no second attempt under the same authorization |
| S4 | post-state, read-only | fingerprint `c36a8a2d9c7e502a2ce31ff5f3f412d9`; the three row counts unchanged; `select count(*) from plan_versions` = 0; `select count(*) from subscriptions where plan_version_id is not null` = 0; `select count(*) from plans where status <> 'published'` = 0 |
| S5 | step 6 of §1 (baseline health and sign-ins) | recorded |

Rules that hold from S3 onwards: **never run the `migrate` one-shot or any `db push` from a
checkout older than the candidate** — it removes the new objects (with empty new tables it
drops them without a prompt; with data it stops only because it cannot prompt; exit 0 in
both cases). The additive objects are never dropped as a "rollback" (§6).

## 5. Production version-1 backfill — execution procedure prepared for review (step 9; NOT executed)

The runtime API image carries no TypeScript runner, so the backfill CLI runs from the
`migrate` image target. **The deployment does not build that image** (the deploy script
builds only the API and web images): after step 7 the `migrate` image on the host is still
the one built from the baseline, which has no backfill command. It is therefore built
first, from the deployed checkout, and its default entrypoint — the schema `push` — is
**always overridden**. The CLI parses its flags strictly and is invoked **without** a `--`
separator:

```
docker compose -f docker/docker-compose.yml -f docker/compose.vps.yml --profile migrate build migrate
docker compose -f docker/docker-compose.yml -f docker/compose.vps.yml --profile migrate \
  run --rm --entrypoint pnpm migrate \
  --filter @workspace/api-server run backfill-plan-versions <flags>
```

Neither command has been run in Docker during development (no Docker in the development
environment). Step 4 of §1 must prove both on the disposable copy — there with the
rehearsal's own image names and its database setting pointing at the throwaway database —
before step 9 is authorized. As for §4, the execution path is a supervised operator session
or a reviewed runner mode of its own. Never start the `migrate` service without the
entrypoint override: from the candidate checkout its default `push` is a no-op after step 5,
from an older checkout it is destructive (§4).

Preconditions: step 7 deployed and healthy; step 8 recorded; freeze still active (§1b); the
authorization names the database name, the expected host and the environment marker if the
database carries one.

| # | Action | Must show |
| --- | --- | --- |
| B0 | **backup gate** — the hosted daily database backup (`docs/BACKUP_AND_RECOVERY.md`; a plain `pg_dump`, not tied to a schema fingerprint or product commit) has run **after step 7** and the backup-health check reports it healthy; or the same backup script is run on demand under this authorization and checked the same way | a healthy backup newer than the step-7 deployment. This backup — not the A2 set, which predates the schema — is the database rollback anchor of §6 R2 |
| B0a | build the `migrate` image from the deployed checkout (first command above) | build succeeds; the host checkout is the deployed SHA of step 7 |
| B1 | snapshot BEFORE: flags `--snapshot --expect-database <name> --expect-host <host>` (plus `--expect-environment production --confirm-production` when the database is marked) | the identity block names the intended database; the snapshot is stored off-host |
| B2 | dry run: the same expectation flags, **without** `--apply` | `DRY_RUN_OK`; planned versions = number of published plans; planned pins = number of subscriptions; unpinnable = 0; integrity errors = 0 |
| B3 | supervised apply: `--apply --confirm-production` plus the same expectation flags | `APPLIED`. Any other verdict or refusal: stop, nothing is retried |
| B4 | snapshot AFTER, same flags as B1 | supporting evidence for the comparison rule below |
| B5 | verification queries, read-only | `select count(*) from subscriptions where plan_version_id is null` = 0; `select count(*) from subscriptions s join plan_versions v on v.id = s.plan_version_id where v.plan_id <> s.plan` = 0; `select count(*) from subscriptions s join plan_versions v on v.id = s.plan_version_id where v.published_at is null` = 0; one `plan_version.backfill` audit row per plan and one `subscription.pin_version` row per subscription |

**Comparison rule ("zero entitlement differences").** The authoritative comparison is the
CLI's own: inside the apply transaction it evaluates every tenant's effective limits,
overrides, status, access mode, billing source, trial and period dates, provider price,
feature entitlements and trial policy before and after the pin, and it commits — verdict
`APPLIED` — only when all of them are equal. The printed snapshots B1 / B4 are supporting
evidence: compare them after removing the fields that differ by construction (the
evaluation instant and the version reference itself). An access mode that changed between
the two snapshots is explained from that tenant's trial end date (§1b) or it stops the
sequence.

A second apply is safe (it writes nothing) but is still a new execution: it needs its own
authorization.

## 6. Rollback procedures

**The automatic container rollback covers exactly one failure class: the health checks of a
fresh deployment.** It does not see a sign-in failure behind green health checks, an
entitlement difference or a backfill integrity problem. Those are detected by the explicit
checks of steps 6, 8 and 10 and are rolled back manually, under their own authorization.

### R1 — before the backfill (after step 5, 6, 7 or 8; every pin is `NULL`)

| Trigger | Action |
| --- | --- |
| Step 5 fails (lock timeout, error) | nothing was applied (single transaction). Stop; report; a new attempt needs a new authorization |
| Step 6: baseline unhealthy or sign-in fails on the extended schema | not expected (proven locally). Stop; do **not** drop the new objects; investigate with the A2 / A3 evidence. Restoring the production database from the recovery set is an owner decision of last resort; no reviewed production-restore procedure is part of this release — it would need its own review and authorization |
| Step 7: deployment health check fails | automatic rollback to the previous known-good commit; the deploy run fails. Record, stop |
| Step 7 / 8: health green but a sign-in fails, 5xx appear, or an API log shows `does not exist`, `plan catalog seed failed` or `SUBSCRIPTION_PLAN_VERSION_INVALID` | **manual** rollback: redeploy exactly `6a8dad1` with the deploy script's documented "deploy the previous known-good SHA" form, run by the operator on the host under its own authorization. A revert commit on `develop` is **not** equivalent — it deploys a new SHA with the baseline's content, which tooling pinned to `6a8dad1` does not recognise; use it only afterwards, to bring `develop` back in line. The re-pinned Stage 2A verifier checks the forward direction only: a rollback is verified by the health checks and the sign-ins of step 6 |
| After any R1 rollback | the additive schema stays and is ignored by `6a8dad1`; **no data repair is needed** because no subscription is pinned; the freeze stays in force until the owner releases it; verify baseline sign-ins and that every `plan_version_id` is still `NULL` |

### R2 — after the backfill (step 9 has written pins)

| Trigger | Action |
| --- | --- |
| Step 9 verdict other than `APPLIED` | the transaction did not commit: nothing was written. Stop; report |
| Step 9 ends with **no verdict** (connection lost, process killed) | do not assume either outcome: run the B5 queries first. Every subscription pinned with the audit rows present = the transaction committed (continue with step 10); nothing pinned = it did not (stop; report). Anything in between cannot occur (single transaction) and stops the sequence |
| Step 10 finds a difference, a mismatched pin or an unpinned subscriber | stop; keep the freeze; **fix forward under the candidate** is the default (a same-plan set-plan by the Platform Owner repairs a single tenant's reference — the change kind `repair`). Reverting pins in bulk is a reviewed SQL statement under its own authorization: set `plan_version_id` to `NULL` for exactly the subscription ids named by this run's `subscription.pin_version` audit rows; the version-1 rows stay (unreferenced, inert). A `NULL`-pinned tenant has identical effective entitlements under the candidate |
| Candidate must be taken out of service after the backfill | redeploy `6a8dad1` as in R1 **and keep the freeze**: under the baseline code no plan or subscription change may be made, because it would move `subscriptions.plan` without the pin |
| Before the candidate is deployed again after such a rollback | `select count(*) from subscriptions s join plan_versions v on v.id = s.plan_version_id where v.plan_id <> s.plan` must be 0; every divergent tenant is repaired by a same-plan set-plan under the candidate. Until repaired, such a tenant signs in and reads normally but plan-gated features answer 403 and capacity checks 409 |
| Database-level recovery | the backup of §5 B0 (not the A2 set) holds the pre-backfill state; restoring it discards every write made since, has no reviewed production-restore procedure in this release and is an owner decision of last resort |

## 7. Explicitly out of scope of this document

Stripe live price registration, period-end plan scheduling / proration / invoicing (D1:
immediate only), Stage 2B object-storage copy, customer-data edits, any hosted dispatch,
any production schema or backfill **execution**, any APK build.

## 8. Release corrections in this candidate (2026-11-13)

The constraints listed in the previous revision of this section are **closed in code**.
Every server-side correction has an API regression test, and the tests of the gaps were
run against the uncorrected candidate as a control (they fail there). The client parts are
covered less: the entitlement refresh by unit tests of its decision module (mobile suite)
and one Playwright spec (web); the mobile NFC declaration, the mobile assistant gate and
the web AI-settings form by typecheck only — no automated UI test, and no physical-device
pass (pending).

| Finding | Correction |
| --- | --- |
| E1 documents | `GET /organizations/:id/documents` and the private byte routes (`GET /files/:id`, `PUT /files/uploads/:id`) apply the `documents` feature; executive report bytes apply `executive.intelligence`. RBAC and tenant isolation (404) keep precedence |
| E2 NFC | a contact declared as an NFC capture (`source: "nfc"`) needs `nfc.capture` on create and on re-labelling — for a signed-in user and for a workflow automation alike; the corrected mobile NFC flow declares it. Manual creation and every other source are untouched. The capture mode is what the client declares: the server cannot tell a typed contact from a tapped one, and **an already-installed mobile build does not declare it** (it only hides the NFC screen from its cached entitlements) — the server-side check takes effect with the corrected mobile build |
| E3 assistant | Workflow and Executive Intelligence are checked inside the AI Assistant (intents, suggestions, capability flags, help), in the recurring workflow alert sweep, and on answers already stored in a conversation (redacted on read while the feature is denied; the stored rows are untouched) |
| M1 AI allowance | the plan allowance is a cap: a tenant may set a lower budget, never a higher one (refused on write, capped on read), and a real provider accepts only a model the platform can price, so the cost cap cannot be emptied through the model setting. No allowance (every legacy tenant) = unchanged budgets. There is no per-tenant Platform Owner AI override in this release; a higher allowance is a plan-version assignment |
| M2 archival | a plan with a live checkout (not past its expiry) cannot be archived — an abandoned checkout stops counting when it expires; a provider event for a registered price of an archived plan reconciles on the plan's published version, recorded with `planArchived: true` and a warning log; a never-published plan's price stays unmapped. Such a tenant is provider-managed: it is moved by changing the provider subscription to a price of a current plan, not by the platform set-plan or a migration |
| M3 | unchanged by decision: a same-plan subscriber stays on its pinned version (grandfathering) |
| M4 assistant features | the assistant routes still require both `ai.assistant` and `ai.command_center`; the mobile client and the web contact workspace now check both, and validation warns (`ASSISTANT_FEATURES_COUPLED`) when a version enables exactly one. Decoupling the two is a product decision, not taken here |
| M5 client refresh | the signed-in user's entitlements are re-read — web: on session restore, after a token refresh, on resume / focus and on a `FEATURE_NOT_ENTITLED` answer; mobile: on session restore, after every sign-in and profile edit, on return to the foreground and on a `FEATURE_NOT_ENTITLED` answer (the mobile client has no token-refresh flow). The server keeps deciding per request |
| Minors | retire carries the same `UNPINNED_SUBSCRIBERS` guard as publish; a tenant migration re-proves its target under the plan lock in every tenant transaction; the platform subscription list filters by Plan Builder slugs; an AI budget beyond the stored integer range is a 400; `0040` fails fast on a lock conflict and scopes its constraint checks by table |

Documented behaviour that is unchanged: the free-text reason of a plan change or migration
is stored in the tenant's audit trail and is readable by tenant users who may view security
audit entries (do not put internal notes in it); a provider event on a price bound to a
retired version still pins that version (the purchase is honoured); the trial sweep
processes at most one batch of tenants in read-only grace per round (status only — access
is decided per request); entitlements are resolved for a user's own company.
