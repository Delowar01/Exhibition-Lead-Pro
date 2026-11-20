# Phase 1 integrated release — rehearsal results and execution plan

Prepared 2026-11-20 on `claude/phase1-release-rehearsal`, created from the head of the
AI provider management branch (`9ba7ebb6b8a80afb892bee88cc411584aa8ca9e7`).

**This is a local preparation record. Nothing was merged, deployed, dispatched or applied
to any hosted system; no provider was called; no mobile build was triggered.** The exact
operator commands, the operator kit and the host-side details are kept outside the
repository, in the owner's custody.

It extends `docs/PLAN_BUILDER_RELEASE_REHEARSAL.md` (the Plan Builder sequence of record,
unchanged) to the whole Phase 1 stack. Where the two differ, §2.5 says so.

## 1. What is integrated

| Order | Pull request | Head | Content | Schema |
| --- | --- | --- | --- | --- |
| baseline | — | `6a8dad1` (`develop`, deployed) | — | deployed schema |
| 1 | #5 | `d1e884b` | Batches 37–43: mobile hardening, Plan Builder PB-1…PB-5 | `0040` |
| 2 | #8 | `be7bb6d` | Platform Owner Analytics, dashboard alignment | none (index proposal `0041` not created) |
| 3 | #9 | `740f581` | Currency policy for prices, dashboard corrections | none |
| 4 | #10 | `9ba7ebb` | Claude next to Gemini, Platform Owner AI provider controls | `0042` |
| separate | #6 | `b59be41` | Documentation only (roadmap, requirements, an Android report) | none |

- The history from the baseline to #10 is linear — 29 commits, no merge commit. Every
  head is an ancestor of the next, so each can become `develop` by a fast-forward and the
  deployed commit is exactly the reviewed and tested one.
- #6 is seven documentation files on an older base. A trial merge into `develop` and into
  the integrated head is conflict-free. It is not part of the product stack; its place in
  the sequence is in §4.4 and its stale statements are listed in §8.
- Deployment-relevant files changed by the stack: `docker/docker-compose.yml` (passes an
  optional `ANTHROPIC_API_KEY` through, empty by default) and the two environment
  examples. No workflow, deploy script or backup script changed.

## 2. Database upgrade rehearsal (local, disposable PostgreSQL, synthetic data)

One disposable database was walked through every schema state of the release, and each
application version that can be running at that moment was started against it. The data:
13 synthetic companies — the four fixture tenants and nine created **through the deployed
baseline's own API** in every subscription state (trialing, active, past due, suspended,
cancelled, expired, a limits override, a changed plan) on all five plans.

"Sign-ins compared" means: for 13 accounts, the sign-in result, role, plan, status, access
mode, limits, usage limits, AI budgets and the status of eight plan-gated routes, compared
field by field with the reference capture. Two of the synthetic tenants (a suspended
company and an expired subscription) are refused at sign-in by every version, identically.

### 2.1 Results

| # | Stage | Result |
| --- | --- | --- |
| 1 | Deployed schema and application (`6a8dad1`) | fingerprint `30c4ecbd867cd2cd59abcb58581ecb04`; reference capture taken |
| 2 | `0040` (SHA-256 `8f931afc…149d89`, identical in every tree of the stack) | `COMMIT`; fingerprint `c36a8a2d9c7e502a2ce31ff5f3f412d9`; second application changes nothing; row counts and row contents of plans, subscriptions and prices unchanged; no version, nothing pinned |
| 3 | Deployed application on the `0040` schema | healthy; 0 differences; 0 error-level log lines |
| 4 | Plan Builder candidate (`d1e884b`), every reference still empty | `push` reports no change; healthy; 0 differences in the fields the baseline also reports; every tenant on `legacy` enforcement; none of the release failure markers in the log |
| 5 | Version-1 backfill | dry run `DRY_RUN_OK`, nothing written; apply `APPLIED` — 5 versions, 13 of 13 subscriptions pinned; entitlements before and after: 0 differences; second apply writes nothing; integrity queries 0; fingerprint unchanged |
| 5r | Deployed baseline on that data (rollback after the backfill) | healthy; 0 differences from stage 1 |
| W2 | Analytics + pricing (`740f581`) on the pinned data | `push` reports no change; healthy; 0 differences; analytics, plans and subscriptions endpoints answer 200 |
| 6 | `0042` (SHA-256 `7daee629…fe032e`), applied while `740f581` is connected | `COMMIT`; fingerprint `fae275efc409c5020a792a7fb0d59689`; second application changes nothing; counts, row contents and pins unchanged; table empty; the running application unaffected (0 differences) |
| 7 | Integrated application (`9ba7ebb`) on the final schema | `push` reports no change; healthy; 0 differences; AI policy readable with the shipped defaults; a save answers 200 with one audit row; a stale save answers 409; a tenant is refused on the platform route (403); the saved policy survives a restart |
| 8 | Rollback shapes from the final state | `740f581`, `d1e884b` and the deployed baseline each run on the final schema and data with 0 differences; the saved AI policy is intact when the integrated application returns |
| alt | Integrated application **before** `0042` | healthy; policy served read-only with defaults; a save answers `503 AI_POLICY_STORAGE_UNAVAILABLE`; 0 differences; after `0042` is applied the running process accepts saves without a restart |

### 2.2 Failure conditions that were provoked

| Probe | Outcome |
| --- | --- |
| `0040` while another session holds a conflicting lock | fails after 5 seconds with a lock timeout; nothing applied (fingerprint still the deployed one) |
| `0042` while another session holds exclusive locks on `users`, `subscriptions`, `companies` | completes at once — it touches no existing relation |
| `0042` applied before `0040` | succeeds, but the fingerprint (`39fdeea0…`) equals none of the three values of record, so the fingerprint gate stops the release |
| Backfill pointed at another database name | refused before any read (`EXPECT_DATABASE_MISMATCH`, exit 2); nothing written |
| **Integrated application on the deployed schema without `0040`** | health checks green, **every sign-in answers 500** — a deployment must never precede its schema step |
| `0042` rollback (`DROP TABLE`, on a copy) | fingerprint returns to `c36a8a2d…` |
| Schema `push` from `740f581` on a database holding a saved AI policy | refuses to proceed (data-loss prompt, no terminal): table and row intact — but exit code 0 |
| The same with the table still empty | **the table is dropped silently, exit code 0** |
| Schema `push` from the deployed baseline on the final database | refuses to proceed: every new object intact |

### 2.3 Fingerprints of record

| Schema | Fingerprint |
| --- | --- |
| deployed | `30c4ecbd867cd2cd59abcb58581ecb04` |
| + `0040` | `c36a8a2d9c7e502a2ce31ff5f3f412d9` |
| + `0040` + `0042` | `fae275efc409c5020a792a7fb0d59689` |

The SQL files and a `push` from the matching commit produce the same schema at each step.
The index proposal (`0041`) was not created or applied; its documented fingerprints assume
a schema without `platform_settings` and must be recomputed if it is ever approved after
`0042`.

### 2.4 Release guards that need a separately approved update

No guard was changed in this batch.

| Guard | Pinned to | Needs |
| --- | --- | --- |
| Operator kit (values of record, checksums) | baseline → `d1e884b`, `30c4ecbd…` → `c36a8a2d…`, the `0040` digest | valid for the Plan Builder wave only. A new kit revision for the two later waves: their commits, the `0042` file and digest, `c36a8a2d…` → `fae275ef…`, and stage steps for the `0042` post-state |
| Recovery runner (`ops/b30-recovery-runner`) | product `6a8dad1`, `30c4ecbd…` | A2 and A3 must run before `0040`. Re-pin before any recovery set taken later, and again after `0042` |
| Stage 2A deploy verifier | previous deployment → `6a8dad1`, `30c4ecbd…` | fails closed today. Per deployment wave: re-pin, or an explicit owner waiver in that wave's authorization |
| Stage 2B migration tooling | `6a8dad1`, `30c4ecbd…` | re-pin after the release to the final commit and `fae275ef…` |
| Backup-health verifier, backfill tool | no commit or fingerprint pin | none |

### 2.5 What changes relative to the Plan Builder procedure

`docs/PLAN_BUILDER_RELEASE_REHEARSAL.md` says a `push` from "this candidate" is a no-op
after its schema step. That holds for `d1e884b` and `740f581`. It does **not** hold for the
integrated head: on the post-`0040` schema a `push` from it creates `platform_settings`,
which is `0042` without authorization. The rule for the whole release is therefore:
**no `migrate` one-shot and no `push` from any checkout on the hosted database; each
schema step is its reviewed SQL file.**

## 3. Cross-version compatibility — summary

| Application | deployed schema | + `0040` | + `0040`, pinned | + `0042` |
| --- | --- | --- | --- | --- |
| `6a8dad1` (deployed) | runs | runs | runs | runs |
| `d1e884b` (#5) | **sign-ins fail** | runs (legacy) | runs | runs |
| `740f581` (#8, #9) | **sign-ins fail** | runs (legacy) | runs | runs |
| `9ba7ebb` (#10) | **sign-ins fail** | runs (legacy); AI policy read-only | runs; AI policy read-only | runs |

An older application always runs on a newer schema; a newer application never runs on a
schema that lacks `0040`. `0042` is optional for every application version.

How each cell was established: the rehearsal of §2 for every "runs" on pinned data and on
`0042`, for the deployed baseline everywhere and for `d1e884b` on unpinned data; the
"sign-ins fail" cell was provoked for the integrated head in this batch and is documented
for `d1e884b` in the Plan Builder procedure — `740f581` contains the same code. The two
later heads on unpinned data are not a state of the planned sequence; they are exercised
by each head's own full regression, whose fixture tenants are unpinned.

One data hazard exists for a rollback **from** the integrated application: its tenant AI
settings endpoint can store a provider name that older code does not know, and older code
fails every AI call of such a tenant. The tenant page does not send it; an API caller
can. The rollback procedure therefore checks
`select count(*) from ai_settings where provider <> 'gemini'` (must be 0).

## 4. Release sequence

Three deployment waves, because the owner's rule is that the Plan Builder release is
verified before the AI policy schema change, and because each wave then has one cause
and one rollback target. Every hosted schema change, deployment, backfill, recovery
action and live-provider operation keeps its own owner authorization.

### 4.1 Before any wave

| Step | Authorization | Evidence before the next step |
| --- | --- | --- |
| Backup health confirmed recovered (§5) | read-only host inspection, if the owner allows it | cause recorded; scheduled check passes again; alert closed by the workflow |
| A2 — recovery set | A2 | `SET_VERIFIED` |
| A3 — isolated restore; off-host copy | A3; off-host | `RESTORE VERIFIED`; digest confirmed; retrieval test |
| Isolated rehearsal on the restored copy, all three waves | rehearsal | the results of §2.1 reproduced on restored data |
| Kit revision for waves 2 and 3 | review | validated, checksummed, in the owner's custody |

### 4.2 Waves

| Wave | Steps, in order | Authorizations | `develop` becomes |
| --- | --- | --- | --- |
| **1 — Plan Builder** | `0040` → baseline verified on it → deploy → legacy-subscriber check → backfill → verification, freeze released (the ten steps of the Plan Builder procedure) | schema; deployment; backfill | `d1e884b` |
| **2 — Analytics + pricing** | preconditions → deploy → verification → read-only manual-price check (§6) | deployment | `740f581` |
| **3 — AI providers** | `0042` → running application verified on it → deploy → verification (no AI call, no policy save) | schema `0042`; deployment | the approved final commit |
| after | documentation (#6 and the living documents) as one approved documentation deployment; tooling re-pinned to the final commit and `fae275ef…` | documentation deployment; ops changes | final |

Live provider keys, the first live calls and the Android build come after wave 3, each
under its own authorization (`docs/AI_PROVIDER_OPERATIONS.md`,
`docs/reports/ANDROID_RELEASE_READINESS_PHASE1.md`).

### 4.3 Merge and retarget order

Every push to `develop` deploys. Each wave is one fast-forward push of an existing commit;
nothing is squashed, rebased or force-pushed, so no new SHA appears.

1. Wave 1: `develop` is fast-forwarded to `d1e884b`. #5 shows as merged.
2. Before wave 2: #8 and #9 are retargeted to `develop` (their diffs then show only their
   own commits). Wave 2: `develop` is fast-forwarded to `740f581`. #8 and #9 show as merged.
3. Before wave 3: #10 is retargeted to `develop`; the final commit is decided — `9ba7ebb`,
   or the head of this rehearsal branch if its commits are approved (then #10's branch is
   fast-forwarded to it, or a follow-up pull request carries them).
4. After wave 3: #6, under its own authorization (§4.4).

A merge button that creates a merge commit, a squash or a rebase produces a new SHA that
no test or pin covers; if the owner prefers that method for a wave, the new SHA is
recorded and the local regression is repeated on it first.

### 4.4 Where the documentation pull request goes

Merging #6 into `develop` is itself a deployment under a new SHA (it cannot fast-forward).
Before the product waves it would move `develop` off the commit every recovery and
verifier pin names. It goes after wave 3, together with the living-document update, as one
documentation deployment.

### 4.5 Rollback

| Wave | Trigger | Action | Data |
| --- | --- | --- | --- |
| 1 | as in the Plan Builder procedure §6 (R1 before, R2 after the backfill) | redeploy `6a8dad1` under its own authorization; the freeze stays | additive objects stay; never dropped |
| 2 | failed health check → automatic; green health with a failed sign-in, 5xx or an entitlement difference → manual | redeploy `d1e884b` | none to repair. Manual prices entered in wave 2 in a non-two-decimal currency would be misread by the older editor |
| `0042` | any error | nothing was applied; stop; a new attempt needs a new authorization | — |
| 3 | as wave 2 | redeploy `740f581` | `platform_settings` and a saved policy stay, ignored, and are intact on return; run the `ai_settings` check of §3 |

### 4.6 Stop conditions

- An Actions run queued or in progress at the start of a stage.
- A fingerprint or deployed commit other than the expected one; an authorization that
  names another commit, digest or database.
- Backup health not passing on the day of a hosted change.
- A2 other than `SET_VERIFIED`; A3 other than `RESTORE VERIFIED`; residue of a rehearsal.
- A schema file ending in anything but `COMMIT` — nothing was applied, no second attempt.
- A deployment health failure (automatic rollback), or green health with a failed sign-in,
  5xx responses, or `does not exist`, `plan catalog seed failed` or
  `SUBSCRIPTION_PLAN_VERSION_INVALID` in the API log (manual rollback).
- A backfill verdict other than `DRY_RUN_OK` / `APPLIED`.
- Live providers: a rejected key, a stopped account, a call attributed to the wrong
  provider, a cost that does not match the price table.

## 5. Backup health — open blocker

Read-only evidence from the Actions logs and the alert issue, 2026-11-20 05:00 UTC:

- The scheduled check of 2026-11-19 13:40 UTC failed with `expected-slot-backup-missing`:
  no backup carried the 03:15 UTC stamp of that day; the newest was the 18 November file.
- At the time of the check the cron service was active, both crontab entries were
  present, both scripts were identical to the deployed commit, the backup directory was
  in order and no temporary file was left.
- The check of 2026-11-18 passed (that day's file, 409,357 bytes, 14 files with verified
  checksums). A read-only recovery-runner check, authorized by the owner, ran that
  afternoon and ended `CHECK_OK`; it takes no backup lock and does not touch the schedule.
  Nothing in its code links it to the missed slot.
- The alert issue is open with no recovery comment. No later scheduled run exists yet.

**The cause cannot be determined from GitHub.** The backup script ends without a file and
without a leftover in several different cases (the job did not start; a lock was held; the
database service was not running; the dump or its verification failed), and only the
host's own log and uptime tell them apart.

Before an A2 authorization: the cause identified by a read-only host inspection and
corrected where it can recur; a passing scheduled check for a later slot (two in a row
preferred); the alert closed by the workflow itself; a fresh read-only preflight. A
passing check alone shows the schedule works again — it does not explain the gap.

## 6. Historical manual prices — read-only check

Manual prices exist only inside plan versions (`plan_versions.snapshot → manualPrices`).
The version-1 backfill writes none. The table does not exist in the deployed schema, so
**no such price can exist on the hosted database today.** The only window in which a
wrongly scaled value can be written is between wave 1 (the editor that stores
"typed × 100" for every currency) and wave 2 (the corrected editor).

`docs/checks/historical-manual-prices-check.sql`:

- creates no object, runs in one `READ ONLY` transaction, needs `SELECT` on three tables;
- prints plan-catalogue rows and one subscriber count per row — no company, user or
  subscription record;
- classifies every manual price in a zero-decimal, whole-unit, three-decimal or
  unsupported currency, using the instant of the wave 2 deployment as the cutoff;
- repairs nothing. A suspect price is re-entered by the Platform Owner in the corrected
  editor (new version, publish).

Rehearsed locally on synthetic versions: 8 prices listed, 4 flagged with the cutoff (6
without), 1 unsupported currency; the database byte-identical before and after; it runs
under a role without the temporary-object privilege; on the deployed schema it reports
that there is nothing to check.

## 7. Outstanding decisions

1. Which public host serves the hosted stack. The code (already deployed) treats
   `dev.kaptnow.com` as retired and refuses every sign-in there; the Android profile
   targets `admin.kaptnow.com`; `CLAUDE.md` and the hosting guide still name the retired host.
2. Deploy-verifier re-pin or waiver, per wave.
3. Whether a fresh recovery set is taken before `0042`, or the nightly backup gate is
   enough for waves 2 and 3.
4. The final commit of wave 3 (`9ba7ebb`, or with this branch's commits).
5. The decisions already listed for the AI providers (`docs/AI_PROVIDER_MANAGEMENT.md`
   §13): model, spending limits, fallback from a stopped account, circuit breaker.
6. Two mobile behaviours that are already deployed: contacts created directly by rapid
   capture and offline scan sync; workflow recommendations on the lead and company
   screens.
7. Remote push on Android (no FCM configuration today).

## 8. Documents to update after integration (not changed here)

- `CLAUDE.md`: the "only approved AI provider" rule; the hosted host name; the branch and
  batch status; the test baseline.
- `docs/LOCALHOST_DEVELOPMENT.md` §7: the test totals of the integrated head.
- `docs/HOSTINGER_VPS_DEPLOYMENT.md`: the sign-in host.
- `docs/PLAN_BUILDER_RELEASE_REHEARSAL.md`: the `push` sentence of §2.5; the pins after
  each wave.
- `docs/README.md`: index rows for the analytics, pricing, AI provider and Phase 1
  documents.
- The documentation pull request (#6), as a dated addendum rather than a rewrite: the
  roadmap rows for analytics, settings, pricing and AI providers; "merged / deployed"
  wording; the sentence that a documentation merge does not deploy; Gemini-only wording;
  its requirements text where the implementation differs (storage limit not enforced, the
  AI allowance is a cap, prices are not copied on duplicate, archive rules); the test
  totals; its Android report, superseded by `docs/reports/ANDROID_RELEASE_READINESS_PHASE1.md`.
