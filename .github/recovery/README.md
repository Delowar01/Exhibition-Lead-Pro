# B30 recovery runner (ops/b30-recovery-runner)

Hosted, owner-authorized execution of the reviewed recovery toolkit **v1.2** through a branch-specific GitHub Actions
workflow served at the repository's **registered** workflow path `.github/workflows/b25-stage1-inspection.yml`
(workflow id **376505024**). This branch = the locked product commit `6a8dad1fe161dc1b31041794e5e3532e9f13327c` +
exactly the files listed in `ALLOWED_FILES`. Nothing here changes the product, the database, the Stage 2B tooling, the
deployment or the production backup script.

## Why the registered path (registration facts)
GitHub registers a workflow — assigns the id that the dispatch API and the Actions UI resolve — only when the file
exists on the default branch or has produced a run. Pushing a `workflow_dispatch`-only file to a new non-default branch
does **not** register it: the first version of this runner, at `.github/workflows/b30-recovery-runner.yml`, was pushed
and stayed unregistered (GET of that path returned 404). Workflow 376505024 was registered on 2026-10-06 by a
push-triggered run of the Stage 1 inspection branch, and the Stage 2A / Stage 2B ops branches serve their own files at
that path (dispatched by id with their ref). This branch does the same: dispatch = workflow 376505024 with
`ref = ops/b30-recovery-runner`; GitHub runs the file of the dispatched ref, so the Stage 2B branch's file at the same
path is untouched. Registered path + matching branch file establish code-level dispatch readiness only — a hosted
dispatch is proven only by a separately authorized run.

## Modes
| mode | effect on the VPS | inputs | success marker |
|---|---|---|---|
| `b30_recovery_check` | PRODUCT-DATA READ-ONLY: the toolkit's `B30_CHECK_ONLY=1` exactly once; no backup, no pruning, no product / database / object write. Tooling artifacts only: a 700 temp dir holding the pinned toolkit (removed when the session ends) and a 600 host-side log under `<backup dir>/recovery-sets/runner-logs/` (retained as evidence) | every other input EMPTY | `B30_RUNNER_RESULT=CHECK_OK` |
| `b30_recovery_set` | ONE pre-copy recovery set (`KEEP=1000`, `B30_EXPECTED_UNREGISTERED=4`): CHECK_ONLY once, then `b30-backup-set.sh` once; one set per approved window; no retry; an incomplete set is preserved | `confirm_product_sha` = the product commit, `confirm_recovery` = `CREATE_B30_PRE_COPY_RECOVERY_SET`, `confirm_quiet_period` = `B30 QUIET PERIOD ACTIVE`, `confirm_paused` = `UPLOADS BRANDING EXPORTS DELETIONS PAUSED`, `quiet_start` / `quiet_end` = the owner-approved UTC window `YYYY-MM-DDTHH:MMZ` | `B30_RUNNER_RESULT=SET_VERIFIED` |

Every dispatch of either mode requires its own explicit owner authorization. The application does **not** enforce the
quiet period and the typed confirmations are **not** a technical upload prevention: they are the owner's attestation
that uploads, branding changes, exports and deletions are paused. Window rules (runner side): same UTC day, start <
end, ≤ 240 minutes, active at dispatch with ≥ 10 minutes left, and no overlap with 03:00–04:00 UTC (nightly dump +
check) or 04:15–10:45 UTC (backup-health probe).

## Guards (in order, all before any SSH session)
1. Pins: `b30-runner-lib.sh`, `b30-host-bootstrap.sh` and `toolkit/SHA256SUMS` must hash to the workflow constants;
   the toolkit's SHA256SUMS must verify.
2. Identity: `github.ref` = this branch, checkout HEAD = `github.sha`, `github.workflow_ref` =
   `<repository>/.github/workflows/b25-stage1-inspection.yml@refs/heads/ops/b30-recovery-runner` — any other branch,
   commit or workflow path fails (the old unregistered path included).
3. Scope: HEAD descends from the product commit and the files differing from it are exactly `ALLOWED_FILES`; only
   `.github/recovery/` and the registered workflow path may differ.
4. Inputs: exact typed comparison on the runner; the check mode refuses any non-empty confirmation or window.
5. Secrets shape (names only; values never printed).
6. Registry / shared id: every ACTIVE registered workflow must be classified — an allow-listed id at its expected
   path, `backup-health-alert`, or SELF = id 376505024 at the registered path (exactly once; the id or the path paired
   with anything else fails). Then queued / in_progress / waiting runs are counted for every allow-listed workflow, for
   `backup-health-alert` (its scheduled read-only SSH probe must never overlap a recovery session) AND for 376505024
   itself; this run is excluded at most once, by run id; any other run — a Stage 2A / 2B dispatch, a second recovery
   dispatch, a deployment, a backup-health probe — blocks; a failed, empty or malformed API answer stops the job
   (never treated as idle). The runner cannot dispatch anything: `actions: read`, GET-only API calls.
7. Strict pinned host-key SSH.

## Host session
The runner streams `MODE`, the pins, the window and the base64 toolkit tar as `printf %q` assignments followed by
`b30-host-bootstrap.sh` into `ssh vps 'bash -s'` (a constant command; no input text is ever executed). On the host the
bootstrap decodes the toolkit into a 700 temp dir (removed at the end), verifies the pinned SHA256SUMS and refuses extra
entries, writes every toolkit line to a 600 log under `<backup dir>/recovery-sets/runner-logs/` (kept on success and
failure), refuses a second set inside the same approved window, runs CHECK_ONLY once and (set mode) the set run once,
then prints ONLY an allow-listed `B30_<KEY>=<token>` summary (mode, approved commit, toolkit verification, exit codes,
preconditions, inventory counts, set name, fingerprint / sums / tenant-file / header / symlink / archive / key-id
statuses as fixed words, a fixed failure class). The runner filters the summary again and refuses any other line
without printing it. Never reported: host paths, host identity, bucket names, object keys, tenant identifiers, key
values or key ids, dump or archive contents, credentials.

## Toolkit v1.2
`toolkit/` = the Batch 31 reviewed scripts; `b30-backup-set.sh` additionally refuses (also in CHECK_ONLY) when a stale
temporary dump, an orphan sidecar, a retention-pruning candidate (existing dumps + 1 > KEEP) or a pending INCOMPLETE set
exists, so the repository's dump script is never invoked in a state where it would remove anything (v1.1). The restore
rehearsal, the read-back helper and the owner key-id script are byte-identical to v1 and are not run by this workflow.

### v1.2 — the two corrections after the set run of 2026-11-22
That run (the first set-mode session on the host) ended without a result line and left an incomplete set. Two defects,
independent of each other, both invisible in check mode and under the first test stub:
1. **Standard input.** The host bootstrap is read by `bash -s` from the SSH session. `docker compose exec` keeps standard
   input attached (also with `-T`); the dump call of the repository's backup script therefore read the rest of the
   bootstrap, and the shell ended with exit 0 before its summary and result logic. Corrected in three layers: the
   bootstrap's body is one function that the shell has parsed completely before its single call (with `</dev/null`)
   runs — the construction `.github/scripts/verify-hosted-backup.sh` on the default branch already uses; with it a
   stream that arrives incomplete runs nothing. Both toolkit invocations start with `</dev/null`. `b30-backup-set.sh`
   detaches its own standard input. The repository's backup script is unchanged.
2. **Query output.** `pgq` ran psql with two `-c` statements without `-q`; psql printed the command tag of the first
   (`SET`) before the answer, so the fingerprint and the inventory were refused by their shape checks. Corrected with
   `-q`; the read-only transaction, `ON_ERROR_STOP` and the shape checks are unchanged.
Unchanged: one set per approved window, no retry, the incomplete-set refusal, the retained host log, every guard of the
workflow, the product commit. A session that ends without a result line is still a failed run.

Before the next session: the incomplete set of 2026-11-22 is still pending on the host. While it is, check mode and set
mode both end `CHECK_FAILED` / `incomplete_set` — the required behaviour. Resolving it is a separate owner decision.
That run also left its private temporary directory (mode 700: the toolkit copy and the bootstrap's error file) on the
host, because the bootstrap never reached the line that removes it.

## Interaction with the Stage 2A / 2B workflows (shared id 376505024)
- Their files on their branches are unchanged; this branch only serves a different file at the same path.
- Mutual exclusion is automatic: the Stage 2B no-other-run guard counts other runs of its own id (an active recovery
  run blocks a Stage 2B dispatch), this runner counts other runs of 376505024 (an active Stage 2A / 2B run blocks a
  recovery dispatch), and all of them share the concurrency group `deploy-dev-vps` (cancel-in-progress false). No
  classification change on the Stage 2B branch is needed.
- Cost: one shared run history for the id (runs are told apart by branch and job name; the registry label keeps the
  name of the first registered version).
- This runner never dispatches, modifies or references a Stage 2B mode or script; its host payload is the six toolkit
  files only, and the bootstrap runs only `b30-backup-set.sh`.

## Local tests
`bash .github/recovery/test/b30-runner.test.sh` — real library, bootstrap, toolkit and repository dump script under a
recording `docker` stub with synthetic envelope files, plus the REAL registry / shared-id step of the workflow under a
recording `gh` stub (GET only, synthetic registry JSON) and the REAL host-session step under an `ssh` stub. Since v1.2
the stub behaves like the real tools where it matters: `compose exec` reads standard input to its end, and psql command
tags are printed unless `-q` is given; the suite also runs the runner of 2026-11-22 as a negative control.

`b30-runner.integration.test.sh` (opt-in) — the same bootstrap, toolkit and dump script with the REAL Docker client,
`docker compose exec` and PostgreSQL in the stack's image, from the product commit's own compose files, with injected
failures and negative controls for both defects. Started by root with `B30_IT_RUN_AS`, it also runs the workflow's own
SSH-setup and host-session steps over a real SSH session — to a **local** sshd on 127.0.0.1 only. The compose project and
the object volume carry the stack's real names, so the test needs a **throwaway Docker daemon** and refuses unless all of
these hold: an explicit confirmation, a non-default socket, a daemon started with `--label b30.it.throwaway=true`, no
container / volume / user-defined network / `cardscanner/*` image in it, no stack directory on the machine. These are
checks against a mistake, not a security boundary: never run it on a machine that hosts the stack.

Not verified by either suite: the host's own sshd, network, Docker and Compose versions; the GitHub runner and its log
masking; the real API and migrate images; live application traffic during a set run (a readiness request that touches
the object volume between the archive and the header scan ends the run INCOMPLETE or NOT VERIFIED — fail closed);
disconnect and timeout behaviour; hosted dispatch. Steps 3–6 of the set script have never run on the host.
