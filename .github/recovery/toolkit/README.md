# Lead Capture Pro — Recovery Toolkit v1.1 (Batch 31 reviewed; Route B prechecks added)

**What this is.** Four operator artefacts for the owner-controlled recovery baseline that must exist
before the Stage 2B production copy: a recovery backup set (database dump + encrypted object-volume
archive + manifest), an isolated disposable restore rehearsal, a read-only read-back helper, and an
owner-side key-id check. They are **operator tooling, not product code**. They live only in this
package until the owner separately authorizes anything else.

**What this is not.** Nothing here copies, deletes, migrates, deploys, rotates a key or changes
production configuration. Nothing here was executed on the VPS. Docker integration was **NOT
VERIFIED** locally (the review sandbox has no docker daemon): every docker call was exercised through
a recording stub, database facts and the product's verify summary were canned, and the real
read-back helper ran against a throwaway database. Treat the first VPS run of each script as the
first integration test and read its output in full.

## 1. Contents and SHA-256

| file | role | sha256 |
|---|---|---|
| `b30-backup-set.sh` | A2 recovery backup set (VPS) | `34200d80b1e4db11c828e3ecaaaa49c0c2f1486981f50b38ac2aaf7a2e3b9829` |
| `b30-restore-rehearsal.sh` | A3 isolated disposable restore rehearsal (VPS) | `f9aad8d3efee23eefdbaa6f5bdaabced786182abd732329e0d2f7899068f9efc` |
| `b30-readback.ts` | read-only decrypt / read-back helper (runs inside the rehearsal) | `b50acc0695c0ef8811a4c3fea7a7ee7216fcd63705261f8d72357e40d074a27c` |
| `b30-keyid-owner.sh` | A1 owner-side key-id check (owner's machine only) | `91e647ef84ca454dcd20e4d3939bb2bdf247601582002e1eff21e2f024d462d0` |

`SHA256SUMS` in this directory covers the four scripts and this README. Verify before use:
`sha256sum -c SHA256SUMS`.

## 2. Prerequisites

VPS side (deploy user, inside the product's docker compose project):

- Product checkout = the locked product commit `6a8dad1fe161dc1b31041794e5e3532e9f13327c`, clean
  (`git status --porcelain` empty); `current-deploy.sha` in the state directory = the same commit.
- The Stage 2B migrate image `cardscanner/migrate:b25-stage2b-6a8dad1fe161` present and labelled
  `b25.stage2b.commit=<product commit>` (built by an owner-authorized hosted dry-run; the scripts
  never build it). The image's GNU tar is probed before use.
- `postgres` and `api` services running; the named object volume `card-scanner-pro_objectdata`
  present; at least 512 MiB free on the backup filesystem.
- No Stage 2B copy lock (`.b25-stage2b-copy.lock` in the deploy user's HOME); no
  `cardscanner/migrate` container running (quiet period).
- A declared quiet period for the set run: no uploads, branding changes, exports or deletions.
- Optional environment variable NAMES: `DEPLOY_PATH`, `BACKUP_DIR`, `STATE_DIR` (defaults mirror the
  repository's own backup script), `KEEP` (default 1000 in the set run = never prunes),
  `B30_SCRIPT_DIR` (where `b30-readback.ts` sits; default = next to the script),
  `B30_EXPECTED_UNREGISTERED` (4 = pre-copy set, default; 0 = post-copy set).
- For the rehearsal only: the owner's key env file on tmpfs (for example `/dev/shm/b30.env`),
  created with `umask 077`, mode 600, containing exactly one line
  `OBJECT_STORAGE_ENCRYPTION_KEY=<64 hex or base64 of 32 bytes>` and nothing else;
  optional `B30_PG_IMAGE` (otherwise the running stack's postgres image is resolved read-only),
  `B30_KEEP_KEY_FILE=1` (do not delete the key file at the end), `B30_DRY_RUN=1`.

Owner side (the owner's own machine, never the VPS, never chat): `bash`, `sha256sum`, `base64`,
and one of `xxd` / `python3` / `perl` for `b30-keyid-owner.sh`.

## 3. Authorization boundaries (exact)

| gate | what it permits | what it never permits |
|---|---|---|
| A1 (confirmation) | `B30_KEYID_ONLY=1` read-only header scan on the VPS; `b30-keyid-owner.sh` on the owner's offline key copy; the owner reports **MATCH** or **MISMATCH** only | retrieving, printing, pasting, logging or transmitting the key or the key id through chat / Git |
| A2 (authorization + quiet period) | one `b30-backup-set.sh` run → one new set directory | pruning, deleting or rewriting any existing backup; any product write; any copy |
| A3 (authorization) | one `b30-restore-rehearsal.sh` run on one verified set, throwaway containers only | touching the live database, the live volume, the bucket, or repairing production data |
| none of the above | — | Stage 2B copy, postverify, deployment, legacy deletion, configuration change, key rotation, Git commit/push of this toolkit, off-host transfer (separate approval) |

Each authorization is independent, names the script and the set, is used **once**, and on any
failure the operator **STOPS** (no automatic retry, no second attempt without a new authorization).

## 4. Operator execution order

0. Unpack on the VPS as the deploy user into a 700 directory; `sha256sum -c SHA256SUMS`.
1. **A1 — key custody.** On the VPS: `B30_KEYID_ONLY=1 bash b30-backup-set.sh` (creates nothing;
   reads only the first bytes of each ciphertext file and prints `envelope_key_id=<16 hex>`).
   On the owner's machine: write the offline key value into a 600 file, run
   `bash b30-keyid-owner.sh <that file>`, compare the 16 hex characters with the VPS output, then
   delete the file. Report only MATCH / MISMATCH. MISMATCH or no offline copy → STOP (A2/A3 blocked).
2. **A2 — recovery set.** `B30_CHECK_ONLY=1 bash b30-backup-set.sh` (preconditions, creates nothing),
   then inside the quiet period `bash b30-backup-set.sh`. Expect `RECOVERY SET VERIFIED: b30-<stamp>`
   and exit 0. Keep the set directory; keep the console output as evidence.
3. **A3 — disposable restore.** `B30_DRY_RUN=1 bash b30-restore-rehearsal.sh <set dir>` (plan only),
   then `B30_KEY_ENV_FILE=/dev/shm/b30.env bash b30-restore-rehearsal.sh <set dir>`.
   Expect `VERDICT: RESTORE VERIFIED` and exit 0. The key env file is shredded at the end.
4. **Later, after a verified copy and still inside the maintenance window:** the POST-COPY set with
   `B30_EXPECTED_UNREGISTERED=0 bash b30-backup-set.sh`, then its own A3 rehearsal (expected
   classification `COMPLETE`).
5. **Off-host durability** (separate approval): an encrypted, owner-controlled copy of the set off the
   VPS. A set that exists only on the VPS does not establish recovery from total VPS loss.

## 5. Approved command templates

```bash
# VPS, deploy user, from the toolkit directory
B30_CHECK_ONLY=1 bash b30-backup-set.sh                 # preconditions only, creates nothing
B30_KEYID_ONLY=1 bash b30-backup-set.sh                 # A1: envelope key id from ciphertext headers, creates nothing
bash b30-backup-set.sh                                   # A2: pre-copy recovery set (expected unregistered 4)
B30_EXPECTED_UNREGISTERED=0 bash b30-backup-set.sh       # post-copy recovery set (after a verified copy)
B30_DRY_RUN=1 bash b30-restore-rehearsal.sh <set dir>    # plan only, nothing executed
( umask 077; printf 'OBJECT_STORAGE_ENCRYPTION_KEY=%s\n' "$(cat <offline key file>)" > /dev/shm/b30.env )
B30_KEY_ENV_FILE=/dev/shm/b30.env bash b30-restore-rehearsal.sh <set dir>   # A3

# owner's machine only
bash b30-keyid-owner.sh <file whose single line is the key value>   # prints 16 hex, nothing else
```

Never pass the key on a command line, in chat, in Git or in the backup tree. The scripts never print
environment values; they print counts, names, digests of files and the non-secret key id only.

## 6. Expected sanitized result markers

| command | success marker | exit |
|---|---|---|
| `B30_CHECK_ONLY=1` | `preconditions OK (free_kb=… keep=1000 set_phase=pre-copy expected_unregistered=4 existing_dumps=<n> stale_tmp=0 orphan_sidecars=0 retention_candidates=0 incomplete_sets=0)` then `B30_CHECK_ONLY=1 — nothing created` | 0 |
| `B30_KEYID_ONLY=1` | `volume_tenant_files=<N> volume_health_files=<H> volume_magic_ok=<N> volume_header_bad=0 volume_symlinks=0 volume_key_ids=1 envelope_key_id=<16 hex>` | 0 |
| set run | `sha256sums: OK`, `fingerprint: MATCH`, `volume tenant files = inventory active fs rows (<N>): MATCH`, `envelope headers: all tenant files valid`, `symlinks: none`, `archive regular files = tenant + health files (…): MATCH`, `envelope key id: single`, `RECOVERY SET VERIFIED: b30-<stamp>` | 0 |
| set run, mismatch | `RECOVERY SET NOT VERIFIED (kept as evidence): b30-<stamp>` | 2 |
| set run, abort | `ERROR: …` and `INCOMPLETE SET left for review (contains .start; unusable): b30-<stamp>` | 1 |
| restore dry run | `inputs OK: set=… active_fs=… migrated=… expected_unregistered=… archive_regular_files=…` then the 8-step plan | 0 |
| restore (pre-copy set) | `restore: psql exit 0`, `tables=<T> fingerprint_match=true counts_match=true`, `archive: regular=<R> not_999=0 files_not_600=0 dirs_not_700=0 symlinks=0`, `B30_READBACK rows=<N> … read_ok=<N> size_match=<N> sha_match=<N> … expect_rows=ok expect_key_id=match result=PASS`, `verify classification: EXPECTED_INCOMPLETE (unregistered=4 before the copy — not a restore failure)`, `cleanup: no residue`, `VERDICT: RESTORE VERIFIED` | 0 |
| restore (post-copy set) | as above with `verify classification: COMPLETE` | 0 |
| restore, any failed check | `CHECK FAIL: <name>` lines and `VERDICT: RESTORE NOT VERIFIED (failed checks: n)` | 2 |
| restore, refused input | `ERROR: …` before any container is created | 1 |
| key-id (owner) | exactly 16 hex characters | 0 |

Today's expected values: `volume_tenant_files=2`, `inventory_active_fs=2`, `inventory_active_fs_migrated=0`,
`expected_unregistered_before_copy=4` (pre-copy). After the approved copy: `inventory_active_fs=6`,
`inventory_active_fs_migrated=4`, expected unregistered 0.

## 7. Retention behaviour (verified by review and by test)

v1.1 adds fail-closed prechecks (also active in `B30_CHECK_ONLY=1`): the set run refuses to start when a stale temporary
dump (`.leadcapture-*.tmp`), an orphan sidecar or a retention-pruning candidate (existing dumps + 1 > KEEP) exists in the
backup directory, or when an INCOMPLETE set of an earlier run is pending — so the existing dump script is never invoked in
a state where it would remove anything.

The set run calls the repository's existing hardened dump script. That script, **after** it has
published and re-verified the new dump, prunes dumps beyond `KEEP` (oldest first by mtime) together
with their sidecars, removes orphan sidecars and stale temporary files. The nightly crontab runs it
with `KEEP=14`. The set run passes `KEEP=1000` by default so that **it never prunes anything**; the
set's copy of the dump is a hard link, so a later nightly prune of the published copy does not affect
the set. Nothing in this toolkit deletes any backup, set or volume content.

## 8. Mounts, users and networks

| container (image = the labelled migrate image unless stated) | user | network | mounts |
|---|---|---|---|
| tar version probe (both scripts) | image default | none | — |
| header scan (set run / `B30_KEYID_ONLY`) | 999:999 | none | live volume `:ro` |
| archive writer (set run) | 0:0 (needed to read 0600 files owned by 999 and preserve ownership) | none | live volume `:ro`, new set directory `/out` (rw) |
| throwaway postgres (rehearsal; the stack's postgres image) | image default | `b30-restore` (internal, no egress) | throwaway volume `b30-restore-pgdata` |
| extraction (rehearsal) | 0:0 | none | set directory `:ro`, throwaway volume `b30-restore-objectdata` (rw, the only rw use) |
| ownership check (rehearsal) | 0:0 | none | throwaway object volume `:ro` |
| read-back helper (rehearsal) | 999:999 | `b30-restore` | throwaway object volume `:ro`, the set's `b30-readback.ts` `:ro`, key via `--env-file` only |
| product `migrate-storage --verify` (rehearsal; invoked as `tsx ./scripts/migrate-storage.ts`, the package script's own command, so no package manager needs network) | 999:999 | `b30-restore` | throwaway object volume `:ro`, key via `--env-file` only; no bucket variable → legacy driver null, fully offline |

The live volume name appears only in the set script and only with `:ro`; the restore script never
references it, never touches the live database or the bucket, and the key env file is checked to
contain exactly the one key line so no database or bucket variable can be injected.

## 9. Failure procedures

- **Precondition failure (exit 1, nothing created):** fix the named precondition (lock present, migrate
  container running, dirty checkout, wrong `current-deploy.sha`, image missing/unlabelled, low space)
  outside this toolkit; rerun only under the same authorization if it explicitly allows it, else STOP.
- **Set run aborted after the set directory exists (exit 1):** the directory keeps `.start` and is
  unusable; the restore script refuses it. Keep it for review; remove it manually only after the
  owner has seen the console output. No backup was deleted.
- **Set run NOT VERIFIED (exit 2):** the set is kept as evidence. Do not reuse it for a rehearsal.
  Typical causes: concurrent uploads (tenant files ≠ inventory rows), a foreign file or symlink in the
  volume, more than one key id, an unexpected schema fingerprint. Investigate read-only; STOP.
- **Rehearsal refused before execution (exit 1):** bad SHA256SUMS (set not trustworthy), missing
  manifest, malformed key env file (not exactly one key line / wrong mode), lock present, residue from an
  earlier rehearsal (remove `b30-restore-pg`, `b30-restore-pgdata`, `b30-restore-objectdata`,
  `b30-restore` manually), unresolved postgres image. The key file is not deleted by a refusal —
  shred it yourself.
- **Rehearsal NOT VERIFIED (exit 2):** every `CHECK FAIL:` line names the failed check; the cleanup
  trap still removes the throwaway container, volumes, network, temp dir and the key file and prints
  `cleanup: no residue` (or `RESIDUE REMAINS — remove manually`). `readback` with
  `read_errors=STORAGE_WRONG_KEY:n` means the supplied key does not decrypt the archive → STOP, never
  rotate or re-encrypt; `STORAGE_CORRUPT` means damaged ciphertext → retake the set; `verify_counts`
  / `verify_expected_incomplete` / `verify_complete` mean the product's offline verify disagrees with
  the manifest → report the sanitized `verify:` line, STOP.
- **A failed or partial rehearsal is NOT a pass.** Production data is never "repaired" from here.

## 10. Known limitations

- Docker integration NOT VERIFIED locally; first VPS execution = first integration run.
- The set proves consistency between a dump and a volume archive taken in the same quiet period; the
  application does not enforce the quiet period.
- A set held only on the VPS does not protect against total VPS loss (see §4 step 5).
- The rehearsal's throwaway database password is passed to two one-off containers as an environment
  value (visible to root on the VPS for seconds); it protects nothing beyond the throwaway database.
- A Stage 2B copy that stops with legacy-source rows registered cannot be resumed through the
  unchanged hosted workflow; recovery of that state is a separate owner decision (Batch 29/30 reports).
