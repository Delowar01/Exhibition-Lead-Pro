# B30 recovery runner (ops/b30-recovery-runner)

Hosted, owner-authorized execution of the reviewed recovery toolkit **v1.1** through a dedicated GitHub Actions
workflow (`.github/workflows/b30-recovery-runner.yml`). This branch = the locked product commit
`6a8dad1fe161dc1b31041794e5e3532e9f13327c` + exactly the files listed in `ALLOWED_FILES`. Nothing here changes the
product, the database, the Stage 2B tooling, the deployment or the production backup script.

## Modes
| mode | effect on the VPS | inputs | success marker |
|---|---|---|---|
| `b30_recovery_check` | read-only: the toolkit's `B30_CHECK_ONLY=1` exactly once; nothing created, no pruning, no product write | every other input EMPTY | `B30_RUNNER_RESULT=CHECK_OK` |
| `b30_recovery_set` | ONE pre-copy recovery set (`KEEP=1000`, `B30_EXPECTED_UNREGISTERED=4`): CHECK_ONLY once, then `b30-backup-set.sh` once; one set per approved window; no retry; an incomplete set is preserved | `confirm_product_sha` = the product commit, `confirm_recovery` = `CREATE_B30_PRE_COPY_RECOVERY_SET`, `confirm_quiet_period` = `B30 QUIET PERIOD ACTIVE`, `confirm_paused` = `UPLOADS BRANDING EXPORTS DELETIONS PAUSED`, `quiet_start` / `quiet_end` = the owner-approved UTC window `YYYY-MM-DDTHH:MMZ` | `B30_RUNNER_RESULT=SET_VERIFIED` |

Every dispatch of either mode requires its own explicit owner authorization. The application does **not** enforce the
quiet period; the typed confirmations are the owner's attestation. Window rules (runner side): same UTC day, start <
end, ≤ 240 minutes, active at dispatch with ≥ 10 minutes left, and no overlap with 03:00–04:00 UTC (nightly dump +
check) or 04:15–10:45 UTC (backup-health probe).

## Guards (in order, all before any SSH session)
1. Pins: `b30-runner-lib.sh`, `b30-host-bootstrap.sh` and `toolkit/SHA256SUMS` must hash to the workflow constants;
   the toolkit's SHA256SUMS must verify.
2. Identity: `github.ref` = this branch, checkout HEAD = `github.sha`, `github.workflow_ref` = this file on this branch.
3. Scope: HEAD descends from the product commit and the files differing from it are exactly `ALLOWED_FILES`.
4. Inputs: exact typed comparison on the runner; the check mode refuses any non-empty confirmation or window.
5. Secrets shape (names only; values never printed). 6. No other coordination workflow run queued / in progress
   (registry verified by id, path and state; this runner recognised by its path). 7. Strict pinned host-key SSH.

## Host session
The runner streams `MODE`, the pins, the window and the base64 toolkit tar as `printf %q` assignments followed by
`b30-host-bootstrap.sh` into `ssh vps 'bash -s'` (a constant command; no input text is ever executed). On the host the
bootstrap decodes the toolkit into a 700 temp dir, verifies the pinned SHA256SUMS and refuses extra entries, writes
every toolkit line to a 600 log under `<backup dir>/recovery-sets/runner-logs/` (kept on success and failure), refuses a
second set inside the same approved window, runs CHECK_ONLY once and (set mode) the set run once, then prints ONLY an
allow-listed `B30_<KEY>=<token>` summary (mode, approved commit, toolkit verification, exit codes, preconditions,
inventory counts, set name, fingerprint / sums / tenant-file / header / symlink / archive / key-id statuses as fixed
words, a fixed failure class). The runner filters the summary again and refuses any other line without printing it.
Never reported: host paths, host identity, bucket names, object keys, tenant identifiers, key values or key ids, dump or
archive contents, credentials.

## Toolkit v1.1
`toolkit/` = the Batch 31 reviewed scripts; `b30-backup-set.sh` additionally refuses (also in CHECK_ONLY) when a stale
temporary dump, an orphan sidecar, a retention-pruning candidate (existing dumps + 1 > KEEP) or a pending INCOMPLETE set
exists, so the repository's dump script is never invoked in a state where it would remove anything. The restore
rehearsal, the read-back helper and the owner key-id script are byte-identical to v1 and are not run by this workflow.

## Interaction with the Stage 2B workflow
The Stage 2B workflow's no-other-run guard fails closed on any active registered workflow it has not classified. While
this runner is registered and active, Stage 2B modes cannot be dispatched until a separately authorized one-line
classification of this runner's id on the Stage 2B branch (or the owner disables this workflow in the Actions UI).

## Local tests
`bash .github/recovery/test/b30-runner.test.sh` — real library, bootstrap, toolkit and repository dump script under a
recording `docker` stub with synthetic envelope files; Docker integration itself is NOT verified locally.
