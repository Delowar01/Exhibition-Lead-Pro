# Off-Host Backup — Hostinger-Only Architecture (B23 G-6D Correction 1)

**Status: design and code under review. Nothing in this document is activated,
deployed, or verified against a real backup VPS.** The deterministic harnesses
described in §15 prove the behaviour in a sandbox; provider, production and
device verification have not been performed.

## 1. Decision and scope

The owner's binding decision for B23 G-6D:

- Production stays on the existing Hostinger VPS.
- Google Cloud is **not** used for hosting or for backup storage. No GCP
  project, bucket, service account, Workload Identity pool, IAM binding,
  credential, secret or billing is created or configured.
- The previously pending GCP-based off-host design is **superseded** by this
  Hostinger-only architecture. It is kept only as history on the review
  branches `claude/b23-g6d-offhost-uploader` and `claude/b23-g6d-offhost-alert`
  (not merged, not deleted, not to be activated).
- This branch (`claude/b23-g6d-hostinger-only`) is review material only: no
  activation, no merge, no deployment, no VPS modification.

Everything already deployed for the local backup (03:15 UTC logical backup,
03:45 UTC local check, `KEEP=14`, the deployed `backup-postgres.sh` /
`backup-check.sh`, and the external monitor `backup-health-alert.yml` with
its issue title `[Backup Alert] Hosted PostgreSQL backup unhealthy`) stays
**unchanged**.

## 2. Topology

```
 PRIMARY HOSTINGER VPS (unchanged)                 SEPARATE HOSTINGER BACKUP VPS
 ┌──────────────────────────────────┐              ┌──────────────────────────────────────┐
 │ 03:15 backup-postgres.sh KEEP=14 │              │ sshd: key-only, forced commands      │
 │ 03:45 backup-check.sh (4 h)      │   pinned     │  lcp-receive  → offhost-receive.sh   │
 │ 03:50 offhost-send.sh (planned)  │═════ssh═════▶│  lcp-audit    → offhost-audit.sh     │
 │   age-encrypt → PUT → AUDIT      │              │  lcp-vault    (no login) owns        │
 │   state: backups/offhost-state/  │              │    /srv/lcp-offhost/published/       │
 └──────────────────────────────────┘              │  root (sudo, publisher only)         │
                                                   │  retention: offhost-retain.sh (vault)│
 HOSTINGER-MANAGED VPS BACKUPS (provider layer)    └──────────────────────────────────────┘
   documented in §10 — not activated by this branch            ▲ pinned ssh, audit key
                                                                │ AUDIT (list-only)
 GITHUB ACTIONS  backup-offhost-hostinger.yml ──────────────────┘
   monitoring / verification / alert only; never a destination; never sees a dump byte
```

Three independent layers plus monitoring:

1. **Primary VPS local backup** — unchanged (already device-verified).
2. **Hostinger-managed daily VPS backups** — provider-managed snapshot of the
   whole primary VPS (§10). Documented; not activated or purchased here.
3. **Separate backup VPS** — receives an age-encrypted copy of the newest
   locally verified backup of each 03:15 UTC slot. It does **not** host the
   application, does **not** share the production PostgreSQL volume, and
   should be in a **different Hostinger data center** than the primary.
4. **GitHub Actions** — daily read-only audit of the backup VPS and a
   deduplicated alert issue. GitHub is never a durable destination.

## 3. Trust boundaries and threat model

| Threat | Control |
|---|---|
| Primary VPS compromised → attacker deletes or overwrites off-host copies | The upload identity can only run the forced receiver (`PUT`/`HELLO`); it cannot list, read, rename, overwrite or delete anything under `published/` (owned by `lcp-vault`, archives 0400). A name that already exists is answered `EXISTS`, never replaced. |
| Primary VPS compromised → attacker reads old off-host copies | Archives are unreadable for the upload identity; even if read, they are age-encrypted to a key that exists on no VPS. |
| Backup VPS compromised | It holds only ciphertext and sanitized metadata. The age identity (private key) is in owner custody, offline. |
| "Off-host" that is actually the same machine | The sender refuses when the destination's machine-id hash or any host-key fingerprint equals its own; hostnames are never used. The GitHub verifier refuses when the backup VPS's pinned or self-reported host keys intersect the primary's pinned host key. |
| Partial or corrupted transfer published as a backup | The receiver reads exactly the declared size into a private temporary file, checks sha256 and format, and hands over to the publisher, which recomputes everything and publishes as a **new inode** with an exclusive create. Interrupted transfers leave no published object; the receiver removes its own temporaries. |
| Manifest without archive, or manifest describing another archive | The manifest can only be published after its archive; the publisher compares the manifest's `archive_size`/`archive_sha256` with the values it recorded itself in the archive's receipt. A generation is complete only when both agree. |
| Stale or future timestamps replayed | Only the current slot and `OFFHOST_SLOT_WINDOW` (2) previous slots are accepted; any stamp in the future of the receiver clock is rejected. |
| Command injection / path traversal through the SSH command | `SSH_ORIGINAL_COMMAND` is validated as at most four plain tokens; object names must match `leadcapture-YYYYMMDD-HHMMSS.sql.gz.(age|manifest.json)` with a date round-trip; paths are never accepted from the client. |
| Symlink / hard-link tricks in `incoming/` | The publisher requires a regular, single-link, non-symlink pending file that resolves inside `incoming/` and (when privileged) is owned by the receive user; it copies into a fresh root-created inode and verifies the copy. |
| Retention wiping the vault by misconfiguration | Dry-run by default; root must carry the activation marker and resolve to itself; the newest `OFFHOST_PROTECT_NEWEST` (7) complete generations are always kept; incomplete generations are quarantined, never deleted directly; every path is built from validated labels. |
| Secrets in logs or issues | Every line printed by any script is names, sizes, counts, timestamps, states, status codes and 12-character checksum prefixes. The workflow masks long tokens defensively. The harnesses scan every output for keys, dump rows, complete checksums and paths. |
| GitHub runner as an exfiltration path | The runner only receives the audit listing (metadata). The audit identity cannot open archives. No script is piped to the backup VPS. |

## 4. Identities and credential separation

| Identity | Where the private key lives | Can | Cannot |
|---|---|---|---|
| **Upload** (`lcp-receive` login on the backup VPS; ed25519 key) | primary VPS deploy user `~/.ssh/lcp_offhost_upload_ed25519` (0600) | `HELLO`, `PUT <name> <size> <sha256>` through the forced receiver; write its own temporaries in `incoming/` | shell, PTY, forwarding, any other command; list/read/rename/overwrite/delete anything published |
| **Audit** (`lcp-audit` login; ed25519 key) | primary VPS deploy user `~/.ssh/lcp_offhost_audit_ed25519` (0600) **and** GitHub secret `BACKUP_VPS_AUDIT_SSH_KEY` | `HELLO`, `AUDIT` through the forced auditor: list published generations, read receipts and manifests, stat archives | upload, read archives (0400 vault), rename, delete, write anywhere |
| **Vault** (`lcp-vault`, no SSH login) | none (local account) | own `published/` and `quarantine/`; run retention from its crontab | log in remotely |
| **Publisher** (root through a one-line sudoers rule) | none | run exactly `/opt/lcp-offhost/bin/offhost-publish.sh` from `lcp-receive` | anything else as root |
| **age recipient** (`age1…` public string) | in `offhost-send.env` on the primary (public material only) | encrypt | decrypt |
| **age identity** (`AGE-SECRET-KEY-1…`) | **owner custody, offline** (two copies in separate locations); never on either VPS, never in the repository, never in GitHub secrets | decrypt during a recovery drill or restore | — |

The receive and vault accounts must **not** be members of the `lcp-audit`
group (the harness verifies this before running its permission assertions).

## 5. Data flow (per 03:15 UTC slot)

`docker/scripts/offhost/offhost-send.sh` on the primary VPS (documented cron
03:50 UTC, not activated):

1. Select the newest backup whose filename stamp is inside the current slot
   and re-run the local checks (regular file, mtime in slot, ≥ 1 KiB, one-line
   sidecar naming the file, `sha256sum -c --strict`, `gzip -t`, dump header,
   completion marker in the final 4096 bytes).
2. `HELLO` to the upload target; refuse if the destination is this machine
   (machine-id hash or host-key fingerprint match), is not the pinned machine
   (`OFFHOST_EXPECTED_MACHINE` / `OFFHOST_EXPECTED_HOSTKEYS`), or reports
   `root=missing`.
3. `AUDIT` through the audit target: a complete generation for this set is
   never uploaded again (`upload=already-published`); an archive without a
   manifest is completed from the local stage of the interrupted run when the
   stage still matches (`upload=resumed`), otherwise the run fails with
   `remote-generation-incomplete` for the operator (retention quarantines the
   incomplete generation after two days).
4. Encrypt with `age -r <recipient>` into `offhost-state/stage/<set>/`
   (mode 700, ciphertext only; kept until the generation is verified so an
   interrupted run never produces a second, different ciphertext).
5. Write the sanitized manifest (`lcp-offhost-manifest/3`: set, slot,
   environment label, sizes, checksums, archive name, encryption format,
   recipient fingerprint, sender/destination machine prefixes — no contents,
   no credentials, no paths).
6. `PUT` the archive, then `PUT` the manifest (the receiver publishes each
   exclusively; the manifest is always last).
7. `AUDIT` again and require `complete=yes` with matching size and checksum
   prefix — the receiver's reply alone is never trusted.
8. Record a local receipt (operational state only) and print exactly one line:
   `OFFHOST_UPLOAD=PASS set=… slot=… archive_size=… sha256_prefix=… destination=… upload=published|already-published|resumed|ambiguous audit=complete`
   or `OFFHOST_UPLOAD=FAIL reason=<stable-code>[ detail=…]`.

Nothing in the PostgreSQL backup directory is ever written, renamed or
deleted by the sender.

## 6. Protocol `LCP-OFFHOST/1` (forced commands on the backup VPS)

| Verb | Identity | Reply |
|---|---|---|
| `HELLO` | upload, audit | `LCP-OFFHOST/1 HELLO machine=<sha256 of machine-id> hostkeys=<SHA256:…,…> fsid=<hex> root=ok|missing` |
| `PUT <name> <size> <sha256>` (+ body on stdin) | upload | `PUBLISHED name= size= sha256_prefix=` · `EXISTS name=` · `REJECTED reason=<code>` |
| `AUDIT` | audit | header, one `generation slot= set= archive= archive_size= archive_mtime_utc= archive_sha256_prefix= archive_receipt= manifest= manifest_receipt= manifest_valid= complete=` line per generation, footer `AUDIT_END generations= complete= incomplete= pending= pending_stale= partial= partial_stale= orphans= quarantine= current_slot_complete=` |

Receiver/publisher reason codes: `no-command`, `invalid-command`,
`unsupported-command`, `invalid-name`, `future-stamp`, `slot-out-of-window`,
`invalid-size`, `invalid-checksum`, `size-out-of-range`, `root-unavailable`,
`incoming-unavailable`, `concurrent-upload`, `short-read`, `size-mismatch`,
`checksum-mismatch`, `archive-format`, `manifest-*` (invalid, schema, set /
slot / archive-name / archive-size / archive-sha256 / source-sha256 /
encryption mismatch, too-large), `pending-exists`, `publish-failed`,
`pending-not-regular`, `pending-outside-incoming`, `pending-linked`,
`pending-owner`, `pending-size`, `archive-not-published`,
`archive-receipt-invalid`, `manifest-archive-mismatch`, `copy-verify-failed`,
`receipt-exists`, `vault-identity-missing`, `config-invalid`,
`unexpected-error`.

Vault layout (`OFFHOST_ROOT`, default `/srv/lcp-offhost`):

```
.lcp-offhost-root            marker (regular file, root) — required by every script
incoming/                    0750 lcp-receive:lcp-audit   temporaries and pending files
published/<slot>/            0750 lcp-vault:lcp-audit
  <set>.age                  0400 lcp-vault               ciphertext
  <set>.age.receipt          0440 lcp-vault:lcp-audit     written by the publisher (size, sha256, time)
  <set>.manifest.json        0440 lcp-vault:lcp-audit     sanitized manifest
  <set>.manifest.json.receipt 0440 lcp-vault:lcp-audit
quarantine/<slot>/           0700 lcp-vault               incomplete generations moved by retention
```

## 7. Encryption and key custody

- Tool: **age** (v1.x; authenticated encryption, X25519 recipient). Installing
  `age` on the primary VPS is an activation prerequisite — it is not on the
  VPS today.
- The repository and the VPS configuration hold **public material only**
  (`OFFHOST_RECIPIENT=age1…`; `<PLACEHOLDER>` in the example).
- The owner generates the key pair offline (`age-keygen`), stores the
  identity in two separate offline locations, and records the recipient in
  `offhost-send.env`. The identity is never placed on either VPS, in the
  repository, or in GitHub secrets.
- A recovery drill (§13) is the only routine use of the identity.
- age produces a different ciphertext on every run; that is why the sender
  stages the ciphertext until the generation is verified and never tries to
  "re-upload" an archive that already exists remotely.

## 8. Same-host rejection

Hostnames are never used for this. The sender compares the destination's
`HELLO` line with its own identity:

- `machine=` — sha256 of `/etc/machine-id` (the id itself is never sent);
  equal → `same-host-destination detail=machine`; `unknown` →
  `destination-identity-unverifiable` (fail closed).
- `hostkeys=` — SHA256 fingerprints of the destination's host public keys;
  any overlap with the sender's own host keys → `same-host-destination
  detail=hostkey`.
- optional pins: `OFFHOST_EXPECTED_MACHINE`, `OFFHOST_EXPECTED_HOSTKEYS`.

The GitHub verifier repeats the check from the outside: the backup VPS's
pinned host key (`BACKUP_VPS_KNOWN_HOSTS`) and its self-reported fingerprints
must share nothing with the primary's pinned host key (`VPS_KNOWN_HOSTS`),
and the self-reported fingerprints must include a pinned one.

## 9. Retention (backup VPS, vault identity, not activated)

`offhost-retain.sh` is **dry-run by default**; only `--apply` changes anything.
Age is measured from the slot label, never from mtimes. Complete generations
older than `OFFHOST_RETAIN_DAYS` (35) are deleted **except** the newest
`OFFHOST_PROTECT_NEWEST` (7) complete generations, which are always kept.
Incomplete generations older than `OFFHOST_QUARANTINE_AFTER_DAYS` (2) are
moved to `quarantine/<slot>/`; quarantined files are purged
`OFFHOST_RETAIN_DAYS` after quarantine. The root must carry the marker and
resolve to itself; top-level or symlinked roots are refused. Documented cron
(vault user's crontab): `20 4 * * * … offhost-retain.sh --apply`.

## 10. Hostinger-managed VPS backups (provider layer)

- Hostinger offers daily/weekly automatic VPS backups (plan-dependent; daily
  backups are a paid add-on on some plans) and manual snapshots, managed from
  hPanel → VPS → Backups. They capture the whole VPS disk at the provider
  level and restore by rolling the VPS back.
- **Not activated, purchased or claimed enabled by this branch.** Whether it
  is enabled on the primary VPS is unknown here; the only acceptable evidence
  is the owner's screenshot/export of the VPS backup settings and a listed
  backup with a date (recorded in the activation record, §12).
- What it gives: fast whole-VPS restore after disk or OS failure; independent
  of anything in this repository.
- What it does **not** give: protection against provider-account compromise,
  provider-side loss, or a deliberate deletion by someone with hPanel access;
  point-in-time selection of a specific PostgreSQL slot; encryption under a
  key the owner controls; verifiability from outside. It is therefore a
  complement, not a substitute, for the encrypted logical copies of §5.

## 11. Monitoring workflow `backup-offhost-hostinger.yml`

- Schedule `0 5 * * *` (70 min after the documented 03:50 transfer) plus
  `workflow_dispatch` with the `simulate_failure` test input. Permissions:
  `contents: read`; `issues: write` only in the alert job. Concurrency group
  without cancellation.
- Connects **only** to the backup VPS with the audit identity over a pinned
  channel (`StrictHostKeyChecking yes`, `IdentitiesOnly yes`, `BatchMode yes`,
  no `ssh-keyscan`), runs the single verb `AUDIT`, and evaluates the listing
  on the runner with `.github/scripts/verify-offhost-hostinger.sh`. It never
  initiates a backup, never uploads, never receives a dump byte, and is never
  a durable destination.
- Slot-aware freshness with a transfer grace (`TRANSFER_GRACE_MINUTES=90`):
  before 04:45 UTC the previous slot is the expected one; from 04:45 the
  current slot is required. A run that GitHub starts hours late still
  evaluates the current slot, so a delay never produces a false stale alert.
- Verdict line `OFFHOST_HEALTH=PASS|FAIL …`; failure reasons include
  `expected-generation-missing`, `expected-generation-incomplete`,
  `archive-too-small`, `same-host-destination`, `hostkey-mismatch`,
  `machine-mismatch`, `stale-incoming-files`, `orphan-files`, `clock-skew`,
  `vault-root-missing`, `audit-rejected`, `ssh-connection-failed`.
- Alert: one deduplicated issue titled exactly
  `[Backup Alert] Hostinger off-host backup unhealthy` (create / comment /
  close with recovery comment; decision table in
  `.github/scripts/offhost-hostinger-alert-decision.sh`). The primary-side
  sender's own result is **not** an input: the remote audit is authoritative.
  The local backup alert (`[Backup Alert] Hosted PostgreSQL backup unhealthy`,
  issue #3 and successors) is a different title handled by a different
  workflow and is never touched.
- Secrets required at activation (values never printed): `BACKUP_VPS_HOST`,
  `BACKUP_VPS_PORT`, `BACKUP_VPS_AUDIT_USER`, `BACKUP_VPS_AUDIT_SSH_KEY`,
  `BACKUP_VPS_KNOWN_HOSTS`, the existing `VPS_KNOWN_HOSTS`, and optionally
  `BACKUP_VPS_MACHINE_HASH`.
- The schedule becomes active only once this file is on the repository
  default branch **and** the secrets exist — an owner decision.

## 12. Activation prerequisites (exact owner actions; none performed here)

1. Provision a second Hostinger VPS (different data center), Ubuntu 24.04,
   SSH key-only, `PermitRootLogin no`, `PasswordAuthentication no`, firewall
   allowing SSH from the primary VPS and GitHub only where possible.
2. Create accounts `lcp-receive`, `lcp-audit`, `lcp-vault` (each with its own
   primary group; receive and vault **not** in `lcp-audit`); `lcp-vault` has
   no SSH login.
3. Install the scripts to `/opt/lcp-offhost/bin/` (root-owned, 0755), the
   shared non-secret settings to `/etc/lcp-offhost/offhost.env`
   (`offhost.env.example`), the sudoers drop-in (`sudoers.example`, validated
   with `visudo -cf`), and the vault layout of §6 including the marker file.
4. Generate two ed25519 key pairs on the primary VPS (upload, audit); install
   the public keys with the forced commands (`authorized_keys.example`).
   Generate the age key pair offline; record the recipient in
   `offhost-send.env` (`offhost-send.env.example`, mode 0600); store the
   identity offline in two places.
5. Install `age` on the primary VPS; create the pinned ssh_config
   (`offhost-ssh.config.example`) and `offhost-known_hosts` from the backup
   VPS host key obtained out-of-band (never `ssh-keyscan` blindly); optionally
   pin `OFFHOST_EXPECTED_MACHINE` / `OFFHOST_EXPECTED_HOSTKEYS` from a first
   `HELLO`.
6. Dry runs: `offhost-send.sh plan`, then one supervised `offhost-send.sh`
   run, then `offhost-retain.sh` (dry-run) on the backup VPS.
7. A **recovery drill** (§13) with the offline age identity before the cron
   lines are added.
8. Add the 03:50 crontab line on the primary and the 04:20 retention line on
   the backup VPS; add the GitHub secrets; merge the workflow to the default
   branch; dispatch it once with `simulate_failure=false`, then once with
   `simulate_failure=true` and confirm the new issue opens and is closed by
   the next healthy run.
9. Record in the activation record: hPanel backup setting evidence (§10),
   the backup VPS data center, the machine hash and host-key fingerprints.

## 13. Recovery sequence (from the off-host copy)

1. On a clean machine with the offline age identity: fetch
   `published/<slot>/<set>.age`, its receipt and the manifest through an
   operator account (not through the forced-command identities).
2. Verify `sha256sum` of the archive against the receipt and the manifest
   (`archive_sha256`); verify the manifest's `slot`/`set`.
3. `age -d -i <identity> -o <set> <set>.age`; verify `sha256sum <set>`
   equals `source_sha256` in the manifest.
4. `gzip -t <set>`; confirm the dump header and the completion marker.
5. Restore with the documented local procedure (`docs/deployment.md`,
   `backup-postgres.sh` counterpart), never onto the production database
   without an explicit owner decision.

## 14. Same-provider limitation (stated honestly)

The copy is **off-host but not off-provider**. Both VPSs are Hostinger
resources under the same account. A provider-wide outage, a billing or
account-level event, or a compromise of the hPanel account could affect both
machines at once. Mitigations available within the decision: different data
centers, separate SSH identities with forced commands, ciphertext only on the
backup VPS with the key in owner custody, and Hostinger-managed backups as an
additional provider-level layer. A copy outside the provider would remove this
limitation but is explicitly out of scope by the owner's decision.

## 15. Tests and what they prove

- `docker/scripts/offhost/test/offhost.test.sh` — deterministic; fixed clock,
  stub `ssh` executing the forced commands with `SSH_ORIGINAL_COMMAND`, real
  `age` round trip, fixture machine-ids and host keys. When run as root with
  the `lcpt-receive`/`lcpt-audit`/`lcpt-vault` test accounts, the receiver and
  auditor run as those users and the publisher through a temporary sudoers
  drop-in — the production shape — and the file-system permission assertions
  are real; otherwise they are reported as `skip`. Covers: successful
  current-slot upload; interrupted transfer (short read and a SIGKILLed
  receiver); duplicate cannot overwrite; old-slot, future-stamp, malformed
  names, injection, traversal; missing/invalid manifest and ordering;
  checksum/size/format mismatches; encryption failure; same-host rejection
  (machine-id, host key, pin, unverifiable); identity restrictions of both
  SSH identities; symlink/hard-link/owner attacks on the publisher; temp and
  orphan detection; retention dry-run/apply/protect/quarantine/purge and root
  validation; configuration hygiene; static provider scan; leak scan.
- `.github/scripts/test/verify-offhost-hostinger.test.sh` — expected-slot
  function, verifier against canned listings (healthy, early, 18 h late,
  missing, incomplete, too small, same-host pinned/reported, host-key
  mismatch, stale/orphan files, clock skew, rejected/empty listing, machine
  pin), summary-regex compatibility, alert decision truth table incl.
  simulated failure and sanitising, workflow statics, provider scan, leak scan.
- `.github/scripts/test/verify-hosted-backup.test.sh` — the existing local
  backup verification tests (unchanged, must stay green).

Not proven here: real OpenSSH forced-command behaviour end to end (the sandbox
has no OpenSSH client), real Hostinger hosts, the Hostinger-managed backup
setting, cron activation, GitHub secrets, and a recovery from a real backup
VPS.

## 16. File map

| File | Runs on | Purpose |
|---|---|---|
| `docker/scripts/offhost/offhost-lib.sh` | both | shared pure helpers (slot math, names, fingerprints, machine hash, eligibility, manifest/receipt checks, config loader) |
| `docker/scripts/offhost/offhost-send.sh` | primary | sender (§5) |
| `docker/scripts/offhost/offhost-receive.sh` | backup (forced, `lcp-receive`) | receiver (§6) |
| `docker/scripts/offhost/offhost-publish.sh` | backup (root via sudo) | exclusive publisher and receipts |
| `docker/scripts/offhost/offhost-audit.sh` | backup (forced, `lcp-audit`) | list-only auditor |
| `docker/scripts/offhost/offhost-retain.sh` | backup (`lcp-vault`) | retention, dry-run by default |
| `docker/scripts/offhost/*.example` | — | authorized_keys, sudoers, shared settings, sender settings, pinned ssh_config |
| `docker/scripts/offhost/test/offhost.test.sh` | sandbox | deterministic ops harness |
| `.github/workflows/backup-offhost-hostinger.yml` | GitHub | daily read-only audit + alert |
| `.github/scripts/verify-offhost-hostinger.sh` | runner | evaluates the AUDIT listing |
| `.github/scripts/offhost-hostinger-alert-decision.sh` | runner | alert truth table |
| `.github/scripts/test/verify-offhost-hostinger.test.sh` | sandbox | deterministic GitHub-side harness |
