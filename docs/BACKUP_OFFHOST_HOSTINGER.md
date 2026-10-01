# Off-Host Backup — Hostinger-Only Architecture (B23 G-6D Corrections 1–5)

**Status: design and code under review. Nothing in this document is activated,
deployed, or verified against a real backup VPS.** The deterministic harnesses
described in §16 prove the behaviour in a sandbox; provider, production and
device verification have not been performed.

## 1. Decision and scope

The owner's binding decision for B23 G-6D:

- Production application hosting stays on the existing Hostinger VPS.
- The **PostgreSQL off-host backup** uses Hostinger only: a separate Hostinger
  backup VPS, plus Hostinger-managed VPS backups as a provider layer. Google
  Cloud is **not** used for this backup design. No GCP project, bucket,
  service account, Workload Identity pool, IAM binding, credential, secret or
  billing is created or configured for backups.
- The previously pending GCP-based off-host design is **superseded** by this
  architecture. It is kept only as history on the review branches
  `claude/b23-g6d-offhost-uploader` and `claude/b23-g6d-offhost-alert`
  (not merged, not deleted, not to be activated).
- This branch (`claude/b23-g6d-hostinger-only`) is review material only: no
  activation, no merge, no deployment, no VPS modification.

Everything already deployed for the local backup (03:15 UTC logical backup,
03:45 UTC local check, `KEEP=14`, the deployed `backup-postgres.sh` /
`backup-check.sh`, and the external monitor `backup-health-alert.yml` with
its issue title `[Backup Alert] Hosted PostgreSQL backup unhealthy`) stays
**unchanged**.

### 1.1 Google Cloud scope — what this does and does not change

This correction removes Google Cloud **only from the PostgreSQL off-host
backup design**. It must not be read as "the product is Google-free":

- The Lead Capture Pro product still contains its **active Google Cloud
  Storage integration** for product object storage — scanned card images,
  documents, export files and tenant branding logos. That integration is
  **unchanged in this batch**; no file of the application was modified.
- Production application hosting remains on the Hostinger VPS.
- Replacing the product's GCS object storage would require a separate batch
  with its own inventory of buckets/objects/code paths, a storage
  architecture decision, a migration plan with verification, and a rollback
  plan. **No product-storage migration is authorized by this correction.**

**Pending roadmap entry (not started, not approved):** *Read-only product
object-storage migration assessment* — if the owner requires zero Google
Cloud usage, a read-only batch inventories every GCS dependency (card images,
documents, exports, branding logos, signed-URL flows, lifecycle rules),
estimates volumes, and proposes a target (for example Hostinger object
storage or VPS-local storage with the same backup discipline as §2), with
migration and rollback steps. It produces a decision document only; it
changes no code and moves no data.

## 2. Topology

```
 PRIMARY HOSTINGER VPS (unchanged)                 SEPARATE HOSTINGER BACKUP VPS
 ┌──────────────────────────────────┐              ┌──────────────────────────────────────┐
 │ 03:15 backup-postgres.sh KEEP=14 │              │ sshd: key-only, forced commands      │
 │ 03:45 backup-check.sh (4 h)      │   pinned     │  lcp-receive  → offhost-receive.sh   │
 │ 03:50 offhost-send.sh (planned)  │═════ssh═════▶│  lcp-audit    → offhost-audit.sh     │
 │   age-encrypt → PUT → AUDIT      │  (key 1, 2)  │  lcp-vault    (no login) owns        │
 │   single monotonic time budget   │              │    /srv/lcp-offhost/published/       │
 │   state: backups/offhost-state/  │              │  root (sudo, publisher only)         │
 └──────────────────────────────────┘              │  retention: offhost-retain.sh (vault)│
                                                   │  dedicated backup file system / quota│
 HOSTINGER-MANAGED VPS BACKUPS (provider layer)    └──────────────────────────────────────┘
   documented in §11 — not activated by this branch            ▲ pinned ssh, key 3
                                                                │ AUDIT (list-only)
 GITHUB ACTIONS  backup-offhost-hostinger.yml ──────────────────┘
   monitoring / verification / alert only; never a destination; never sees a dump byte
   external actions pinned to immutable commit SHAs
```

Three independent layers plus monitoring:

1. **Primary VPS local backup** — unchanged (already device-verified).
2. **Hostinger-managed daily VPS backups** — provider-managed snapshot of the
   whole primary VPS (§11). Documented; not activated or purchased here.
3. **Separate backup VPS** — receives an age-encrypted copy of the newest
   locally verified backup of each 03:15 UTC slot. It does **not** host the
   application, does **not** share the production PostgreSQL volume, and
   should be in a **different Hostinger data center** than the primary. Its
   vault lives on a **dedicated file system or an enforced quota** (§10).
4. **GitHub Actions** — daily read-only audit of the backup VPS and a
   deduplicated alert issue. GitHub is never a durable destination.

## 3. Trust boundaries and threat model

| Threat | Control |
|---|---|
| Primary VPS compromised → attacker deletes or overwrites off-host copies | The upload identity can only run the forced receiver (`PUT`/`HELLO`); it cannot list, read, rename, overwrite or delete anything under `published/` (owned by `lcp-vault`, archives 0400). A name that already exists is answered `EXISTS`, never replaced. |
| Primary VPS compromised → attacker **fills the backup VPS** with large or many archives | Per-archive maximum (`OFFHOST_MAX_ARCHIVE_BYTES`), per-slot generation cap (`OFFHOST_MAX_GENERATIONS_PER_SLOT`, an archive counts even without manifest) and a free-space reserve (`OFFHOST_MIN_FREE_BYTES`) are checked by the privileged publisher **before a byte is read** (read-only preflight) and **again immediately before publication**; the vault sits on a dedicated file system or quota so nothing else on the host can be starved. Retention is housekeeping, not the storage boundary (§10). |
| Primary VPS compromised → attacker reads old off-host copies | Archives are unreadable for the upload identity; even if read, they are age-encrypted to a key that exists on no VPS. |
| Primary VPS compromised → attacker points the audit alias at a **different host** that answers "everything is fine" | Every AUDIT listing is **bound to the upload HELLO identity**: same machine-id hash, same file-system id, intersecting host keys, `root=ok`, clock within `OFFHOST_MAX_CLOCK_SKEW_SECONDS`, exactly one header/capacity/footer line, protocol version 1, no duplicate or malformed generation records — otherwise the sender fails closed **before encryption and before any PUT** (`audit-destination-mismatch detail=machine|filesystem|hostkey`, `audit-header-invalid`, `audit-header-duplicate`, `audit-clock-skew`, …). |
| Backup VPS compromised | It holds only ciphertext and sanitized metadata. The age identity (private key) is in owner custody, offline. |
| "Off-host" that is actually the same machine | The sender refuses when the destination's machine-id hash or any host-key fingerprint equals its own; hostnames are never used. The GitHub verifier refuses when the backup VPS's pinned or self-reported host keys intersect the primary's pinned host key. |
| A hung endpoint or a stuck encryption keeps the sender alive forever | One monotonic budget (`OFFHOST_MAX_TIME`) covers the whole run; the remaining allowance is applied to every blocking step with `timeout --foreground -k 5`; the run ends with exactly one `operation-timeout` summary, temporary work is removed, and only a complete, valid ciphertext stage is kept for resumption. |
| Partial or corrupted transfer published as a backup | The receiver reads exactly the declared size into a private temporary file, checks sha256 and format, and hands over to the publisher, which recomputes everything and publishes as a **new inode** with an exclusive create. Interrupted transfers leave no published object; the receiver removes its own temporaries. |
| Manifest without archive, or manifest describing another archive | The manifest can only be published after its archive; the publisher compares the manifest's `archive_size`/`archive_sha256` with the values it recorded itself in the archive's receipt. A generation is complete only when both agree. |
| Stale or future timestamps replayed | Only the current slot and `OFFHOST_SLOT_WINDOW` (2) previous slots are accepted; any stamp in the future of the receiver clock is rejected. |
| Command injection / path traversal through the SSH command | `SSH_ORIGINAL_COMMAND` is validated as at most four plain tokens; object names must match `leadcapture-YYYYMMDD-HHMMSS.sql.gz.(age|manifest.json)` with a date round-trip; paths are never accepted from the client. |
| Symlink / hard-link tricks in `incoming/` | The publisher requires a regular, single-link, non-symlink pending file that resolves inside `incoming/` and (when privileged) is owned by the receive user; it copies into a fresh root-created inode and verifies the copy. |
| Retention wiping the vault by misconfiguration | Dry-run by default; root must carry the activation marker and resolve to itself; the newest `OFFHOST_PROTECT_NEWEST` (7) complete generations are always kept whatever the retention window; incomplete generations are quarantined, never deleted directly; every path is built from validated labels. |
| A mutable GitHub Action tag is re-pointed upstream | Every `uses:` in the workflow is pinned to a full 40-character commit SHA resolved from the official upstream repository; the harness refuses any mutable tag or branch reference. |
| One leaked audit key disables both the primary's and GitHub's audits | Three separate key pairs; the two audit keys are bound to the same forced command but are separately revocable and attributable (§4). |
| Tampered installation on the backup VPS | `offhost-install-check.sh` verifies ownership, modes, the sudoers drop-in **and** the effective sudo authority of the receive account, the exact three-key forced-command inventory with distinct fingerprints, locked service-account passwords, group separation and the effective sshd configuration **of the inspected file, per restricted account** (`sshd -T -f /etc/ssh/sshd_config -C user=…`), and records script hashes before activation (§13). |
| A `Match User` block or a second sudoers file silently widens one account | Per-account `sshd -T -f … -C` evaluation plus a Match-criteria/Include scan; `sudo -n -l -U lcp-receive` effective listing must show exactly the publisher (§13). |
| A second authorized-key source bypasses the audited key inventory (`authorized_keys2`, an absolute or tokenized `AuthorizedKeysFile`, `AuthorizedKeysCommand`, `TrustedUserCAKeys` certificates, principals files/commands) or a `ForceCommand` replaces the key-line command | Per account, the effective `AuthorizedKeysFile` must be exactly `.ssh/authorized_keys` — the one file the inventory check reads — and every other key source and `ForceCommand` must be effectively `none`; `AuthenticationMethods` must be exactly `publickey` with host-based, GSSAPI, Kerberos and empty-password authentication off (§13). |
| `AllowUsers` pattern admits an unlisted account (`*`, `?`, `!negation`, `user@host`, glob/comma/bracket lists) | Literal-user profile: every effective `AllowUsers` token must be a plain user name, each service account exactly once, never the vault, every other name explicitly approved through `OFFHOST_SSHD_OPERATOR_USERS` (§13). |
| The client or a server-side `SetEnv` injects `OFFHOST_*`, `LCP_*`, `PATH`, `BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS` or `LD_*` into the forced scripts | `PermitUserEnvironment no`, no effective `SetEnv`, `AcceptEnv` restricted to locale names (`LANG`, `LANGUAGE`, `LC_*`); every script fixes `PATH` as its first statement and the shared library forces `LC_ALL=C` and unsets `BASH_ENV`/`ENV`/`CDPATH`/`GLOBIGNORE`/`IFS` before any parsing (§13). |
| Secrets in logs or issues | Every line printed by any script is names, sizes, counts, timestamps, states, status codes and 12-character checksum prefixes. The uploader receives reason codes only — never a path, mount or free-space figure. The workflow masks long tokens defensively. The harnesses scan every output for keys, dump rows, complete checksums and paths. |
| GitHub runner as an exfiltration path | The runner only receives the audit listing (metadata). The audit identity cannot open archives. No script is piped to the backup VPS. |

## 4. Identities and credential separation (three key pairs)

| Identity | Where the private key lives | Can | Cannot |
|---|---|---|---|
| **Key 1 — upload** (`lcp-receive` login on the backup VPS; ed25519) | primary VPS deploy user `~/.ssh/lcp_offhost_upload_ed25519` (0600) | `HELLO`, `PUT <name> <size> <sha256>` through the forced receiver; write its own temporaries in `incoming/` | shell, PTY, forwarding, any other command; list/read/rename/overwrite/delete anything published |
| **Key 2 — primary audit** (`lcp-audit` login; ed25519) | primary VPS deploy user `~/.ssh/lcp_offhost_audit_ed25519` (0600) | `HELLO`, `AUDIT` through the forced auditor: list published generations, read receipts and manifests, stat archives, report capacity | upload, read archives (0400 vault), rename, delete, write anywhere |
| **Key 3 — GitHub audit** (`lcp-audit` login; ed25519) | **only** the GitHub Actions secret `BACKUP_VPS_AUDIT_SSH_KEY`; never installed on either VPS | the same forced auditor as key 2 | the same as key 2 |
| **Vault** (`lcp-vault`, no SSH login, own primary group) | none (local account) | own `published/` and `quarantine/`; run retention from its crontab | log in remotely |
| **Publisher** (root through a one-line sudoers rule) | none | run exactly `/opt/lcp-offhost/bin/offhost-publish.sh` (`--preflight` and publish modes) from `lcp-receive` | anything else as root |
| **age recipient** (`age1…` public string) | in `offhost-send.env` on the primary (public material only) | encrypt | decrypt |
| **age identity** (`AGE-SECRET-KEY-1…`) | **owner custody, offline** (two copies in separate locations); never on either VPS, never in the repository, never in GitHub secrets | decrypt during a recovery drill or restore | — |

Keys 2 and 3 map to the same read-only forced command but are distinct key
pairs: each appears as its own `authorized_keys` line with its own comment
(`lcp-offhost-audit@primary`, `lcp-offhost-audit@github-actions`), sshd logs
the fingerprint used, and either can be revoked without touching the other.
The installation check enforces the inventory **exactly**: one receive key,
two audit keys (three in total), every line `restrict,command="…"` with no
other option, and three **distinct fingerprints** — a reused upload key, a
duplicated audit key, a missing or extra key, or a comment-only difference
all fail (`authorized-keys-*-count`, `-unrestricted`,
`authorized-keys-duplicate`). Every key must be a **complete OpenSSH-valid
public key**: the checker parses the entire wire structure (strict base64,
type string equal to the declared `ssh-ed25519` /
`sk-ssh-ed25519@openssh.com`, a key field of exactly 32 bytes, the
application string for sk keys, every length inside the data, no trailing
bytes) **and** runs the OpenSSH tooling itself (`ssh-keygen -l -f -`, output
suppressed); a type-only, short, long, trailing-garbage, overflowing,
type-mismatched or badly padded blob is `authorized-keys-*-malformed`, and a
backup VPS without `ssh-keygen` fails closed with
`authorized-keys-validator-unavailable`. Neither the blob nor a fingerprint
is ever printed. All three service accounts must have **locked
passwords** (`account-*-password-unlocked`). The receive and vault accounts
must **not** be members of the `lcp-audit` group and no account other than
`lcp-vault` may be in the vault group (the harness and the install check
verify this). No real key is generated by this repository.

## 5. Data flow (per 03:15 UTC slot)

`docker/scripts/offhost/offhost-send.sh` on the primary VPS (documented cron
03:50 UTC, not activated). The whole run shares one monotonic budget
`OFFHOST_MAX_TIME` (default 1800 s): before each blocking step the remaining
allowance is computed and the step runs under `timeout --foreground -k 5`.

1. Select the newest backup whose filename stamp is inside the current slot
   and re-run the local checks (regular file, mtime in slot, ≥ 1 KiB, one-line
   sidecar naming the file, `sha256sum -c --strict`, `gzip -t`, dump header,
   completion marker in the final 4096 bytes).
2. `HELLO` to the upload target (budgeted); refuse if the destination is this
   machine (machine-id hash or host-key fingerprint match), is not the pinned
   machine (`OFFHOST_EXPECTED_MACHINE` / `OFFHOST_EXPECTED_HOSTKEYS`), reports
   an unknown machine, file-system id or host keys, or `root=missing`.
3. `AUDIT` through the audit target (budgeted) and **bind** the listing to the
   HELLO identity (§7). A complete generation for this set is never uploaded
   again (`upload=already-published`); an archive without a manifest is
   completed from the local stage of the interrupted run when the stage still
   matches (`upload=resumed`), otherwise the run fails with
   `remote-generation-incomplete` for the operator (retention quarantines the
   incomplete generation after two days).
4. Encrypt with `age -r <recipient>` (budgeted) into
   `offhost-state/stage/<set>/` (mode 700, ciphertext only; kept until the
   generation is verified so an interrupted run never produces a second,
   different ciphertext; a cut-off encryption is discarded).
5. Write the sanitized manifest (`lcp-offhost-manifest/3`: set, slot,
   environment label, sizes, checksums, archive name, encryption format,
   recipient fingerprint, sender/destination machine prefixes — no contents,
   no credentials, no paths).
6. `PUT` the archive, then `PUT` the manifest (each budgeted; the receiver
   runs the capacity preflight, publishes each exclusively; the manifest is
   always last).
7. `AUDIT` again (budgeted, bound again) and require `complete=yes` with
   matching size and checksum prefix — the receiver's reply alone is never
   trusted.
8. Record a local receipt (operational state only) and print exactly one line:
   `OFFHOST_UPLOAD=PASS set=… slot=… archive_size=… sha256_prefix=… destination=… upload=published|already-published|resumed|ambiguous audit=complete`
   or `OFFHOST_UPLOAD=FAIL reason=<stable-code>[ detail=…]`. An exhausted
   budget yields exactly `OFFHOST_UPLOAD=FAIL reason=operation-timeout
   detail=step=<encrypt|hello|pre-audit|put-archive|put-manifest|post-audit>`
   and never a second `unexpected-error` summary.

Nothing in the PostgreSQL backup directory is ever written, renamed or
deleted by the sender.

## 6. Protocol `LCP-OFFHOST/1` (forced commands on the backup VPS)

| Verb | Identity | Reply |
|---|---|---|
| `HELLO` | upload, audit | `LCP-OFFHOST/1 HELLO machine=<sha256 of machine-id> hostkeys=<SHA256:…,…> fsid=<hex> root=ok|missing` |
| `PUT <name> <size> <sha256>` (+ body on stdin) | upload | `PUBLISHED name= size= sha256_prefix=` · `EXISTS name=` · `REJECTED reason=<code>` |
| `AUDIT` | audit | header, one `CAPACITY` line, one `generation …` line per generation, footer `AUDIT_END …` |

Audit lines:

```
LCP-OFFHOST/1 AUDIT now_utc= machine= hostkeys= fsid= root= current_slot= window=
LCP-OFFHOST/1 CAPACITY state=ok|low|over-cap|unavailable free_state=above-reserve|below-reserve|unknown max_generations_per_slot= current_slot_generations= over_cap_slots= reserve_bytes= free_bytes=
generation slot= set= archive= archive_size= archive_mtime_utc= archive_sha256_prefix= archive_receipt= manifest= manifest_receipt= manifest_valid= complete=
LCP-OFFHOST/1 AUDIT_END generations= complete= incomplete= pending= pending_stale= partial= partial_stale= orphans= quarantine= current_slot_complete=
```

Receiver/publisher reason codes: `no-command`, `invalid-command`,
`unsupported-command`, `invalid-name`, `future-stamp`, `slot-out-of-window`,
`invalid-size`, `invalid-checksum`, `size-out-of-range`, `archive-too-large`,
`slot-generation-limit`, `insufficient-capacity`, `capacity-unavailable`,
`root-unavailable`, `incoming-unavailable`, `concurrent-upload`, `short-read`,
`size-mismatch`, `checksum-mismatch`, `archive-format`, `manifest-*` (invalid,
schema, set / slot / archive-name / archive-size / archive-sha256 /
source-sha256 / encryption mismatch, too-large), `pending-exists`,
`publish-failed`, `pending-not-regular`, `pending-outside-incoming`,
`pending-linked`, `pending-owner`, `pending-size`, `archive-not-published`,
`archive-receipt-invalid`, `manifest-archive-mismatch`, `copy-verify-failed`,
`receipt-exists`, `vault-identity-missing`, `config-invalid`,
`unexpected-error`.

Vault layout (`OFFHOST_ROOT`, default `/srv/lcp-offhost`, on a dedicated file
system or quota):

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

## 7. Audit binding and same-host rejection

Hostnames are never used for either check.

**Same-host rejection (sender, HELLO):** `machine=` is the sha256 of
`/etc/machine-id` (the id itself is never sent); equal to the sender's own →
`same-host-destination detail=machine`; `unknown` machine, file-system id or
host keys → `destination-identity-unverifiable` (fail closed). `hostkeys=`
are SHA256 fingerprints of the destination's host public keys; any overlap
with the sender's own → `same-host-destination detail=hostkey`. Optional pins
`OFFHOST_EXPECTED_MACHINE` / `OFFHOST_EXPECTED_HOSTKEYS`.

**Audit binding (sender, pre- and post-upload AUDIT):** the listing from the
audit alias is accepted only when, in this order, every protocol-tagged line
carries version 1 (`audit-protocol-version`); exactly one header, one
`CAPACITY` line and one footer exist (`audit-header-duplicate`,
`audit-header-invalid`, `audit-capacity-duplicate`, `audit-capacity-invalid`,
`audit-footer-duplicate`, `audit-footer-invalid`); the header's machine hash
equals the HELLO machine hash (`audit-destination-mismatch detail=machine`);
its file-system id equals the HELLO file-system id
(`… detail=filesystem`); its host-key list intersects the HELLO host-key list
(`… detail=hostkey`); the configured pins hold (`audit-machine-mismatch`,
`audit-hostkey-mismatch`); `root=ok` (`audit-root-missing`); the audit clock
is within `OFFHOST_MAX_CLOCK_SKEW_SECONDS` (default 900) of the sender's
(`audit-clock-skew`); every generation record is well-formed
(`audit-line-invalid`) and this set's record occurs at most once
(`audit-generation-duplicate`). A mismatch in the pre-upload audit stops the
run before encryption and before any `PUT`.

**GitHub verifier:** the backup VPS's pinned host key (`BACKUP_VPS_KNOWN_HOSTS`)
and its self-reported fingerprints must share nothing with the primary's
pinned host key (`VPS_KNOWN_HOSTS`), the self-reported fingerprints must
include a pinned one, and the same structural checks (single header,
capacity line and footer; protocol version; well-formed, non-duplicate
generation records) apply.

## 8. Encryption and key custody

- Tool: **age** (v1.x; authenticated encryption, X25519 recipient). Installing
  `age` on the primary VPS is an activation prerequisite — it is not on the
  VPS today.
- The repository and the VPS configuration hold **public material only**
  (`OFFHOST_RECIPIENT=age1…`; `<PLACEHOLDER>` in the example).
- The owner generates the key pair offline (`age-keygen`), stores the
  identity in two separate offline locations, and records the recipient in
  `offhost-send.env`. The identity is never placed on either VPS, in the
  repository, or in GitHub secrets.
- A recovery drill (§14) is the only routine use of the identity.
- age produces a different ciphertext on every run; that is why the sender
  stages the ciphertext until the generation is verified and never tries to
  "re-upload" an archive that already exists remotely.

## 9. Overall time budget

`OFFHOST_MAX_TIME` (default 1800 s) is a single monotonic deadline measured
with Bash's `SECONDS` from the start of the run. Before `age` encryption, the
upload `HELLO`, the pre-upload `AUDIT`, the archive `PUT`, the manifest `PUT`
and the post-upload `AUDIT`, the sender computes the remaining allowance and
runs the step under `timeout --foreground -k 5 <remaining>`; the budget is
never reset per step. `timeout` is a required tool. The lock descriptor is
closed for every child so a stuck process cannot keep the sender's lock. On
exhaustion the run prints exactly one `OFFHOST_UPLOAD=FAIL
reason=operation-timeout detail=step=<step>` line, removes its temporary
work directory, and keeps the persistent ciphertext stage only when it is
complete and valid (a cut-off encryption is discarded; a complete stage whose
transfer timed out is resumed by the next run).

## 10. Storage exhaustion controls

A compromised upload key must not be able to fill the backup VPS. Three
validated limits live in the shared backup-VPS settings
(`docker/scripts/offhost/offhost.env.example`); zero or unbounded values are
refused by every script that reads them (`config-invalid`):

| Setting | Example value | Allowed range | Rationale |
|---|---|---|---|
| `OFFHOST_MAX_ARCHIVE_BYTES` | 2147483648 (2 GiB) | 1 MiB – 64 GiB | the daily plain-SQL gzip dump of the dev database is well below 100 MiB; 2 GiB leaves > 20× growth headroom and replaces the former unrestricted 20 GiB default |
| `OFFHOST_MAX_GENERATIONS_PER_SLOT` | 2 | 1 – 99 | one scheduled plus one controlled recovery backup per slot; an archive counts even without its manifest |
| `OFFHOST_MIN_FREE_BYTES` | 5368709120 (5 GiB) | 100 MiB – 10 TB | free space no upload may consume |

Enforcement: the receiver validates the declared size against the per-archive
maximum, then asks the privileged publisher for a **read-only preflight**
(`offhost-publish.sh --preflight`) — because the upload identity cannot list
`published/` — which answers `EXISTS` for a known name, `archive-not-published`
for a manifest without archive, `archive-too-large`, `insufficient-capacity`
(the object held twice transiently — incoming plus published copy — must fit
above the reserve), `capacity-unavailable` (free space undeterminable) or
`slot-generation-limit`. Only then is the stream read. The publisher
**repeats** the checks immediately before publication, so a change between
preflight and publication is caught. Completing the manifest of an already
accepted archive is always allowed; re-uploading an existing generation is
answered `EXISTS` without reading. The uploader sees reason codes only. The
auditor reports a sanitized `CAPACITY` line (state, free-space state, cap,
current-slot count, over-cap slots, reserve and free bytes — never paths),
and the GitHub verifier fails on `capacity-unhealthy`,
`free-space-below-reserve`, `slot-over-cap`, `capacity-missing`,
`capacity-duplicate` or `capacity-invalid`.

**Activation requirement:** the vault (`OFFHOST_ROOT`) must sit on a
**dedicated backup file system** (separate block device or partition) or
under a **file-system quota** that bounds everything below it, so that even
a misconfiguration of the limits cannot starve the operating system of the
backup VPS. Retention (§12) is housekeeping only and is **not** a
disk-exhaustion control.

## 11. Hostinger-managed VPS backups (provider layer)

- Hostinger offers daily/weekly automatic VPS backups (plan-dependent; daily
  backups are a paid add-on on some plans) and manual snapshots, managed from
  hPanel → VPS → Backups. They capture the whole VPS disk at the provider
  level and restore by rolling the VPS back.
- **Not activated, purchased or claimed enabled by this branch.** Whether it
  is enabled on the primary VPS is unknown here; the only acceptable evidence
  is the owner's screenshot/export of the VPS backup settings and a listed
  backup with a date (recorded in the activation record, §13).
- What it gives: fast whole-VPS restore after disk or OS failure; independent
  of anything in this repository.
- What it does **not** give: protection against provider-account compromise,
  provider-side loss, or a deliberate deletion by someone with hPanel access;
  point-in-time selection of a specific PostgreSQL slot; encryption under a
  key the owner controls; verifiability from outside. It is therefore a
  complement, not a substitute, for the encrypted logical copies of §5.

## 12. Retention (backup VPS, vault identity, not activated)

`offhost-retain.sh` is **dry-run by default**; only `--apply` changes anything.
Age is measured from the slot label, never from mtimes. Complete generations
older than `OFFHOST_RETAIN_DAYS` (35) are deleted **except** the newest
`OFFHOST_PROTECT_NEWEST` (7) complete generations, which are always kept —
even with an aggressive retention window (verified by the harness).
Incomplete generations older than `OFFHOST_QUARANTINE_AFTER_DAYS` (2) are
moved to `quarantine/<slot>/`; quarantined files are purged
`OFFHOST_RETAIN_DAYS` after quarantine. The root must carry the marker and
resolve to itself; top-level or symlinked roots are refused. Documented cron
(vault user's crontab): `20 4 * * * … offhost-retain.sh --apply`. Retention
never bounds disk usage; the limits of §10 do.

## 13. Installation integrity (backup VPS)

`docker/scripts/offhost/offhost-install-check.sh` (root, read-only) verifies
the installed shape and prints `OFFHOST_INSTALL=PASS checks=<n>` or
`OFFHOST_INSTALL=FAIL reasons=<codes>`. Activation requires every check to
pass on the real backup VPS **and** the following to be recorded in the
activation record:

- `/opt/lcp-offhost` and `/opt/lcp-offhost/bin` and every executable/library
  file there owned `root:root`, directories and files not group- or
  world-writable, scripts executable, no symlinks or foreign files
  (`install-root-*`, `bin-file-*`).
- `/etc/lcp-offhost/offhost.env` owned by root, not group/world-writable,
  parsing against the whitelist with bounded limits (`config-*`).
- `/etc/sudoers.d/lcp-offhost` owned `root:root`, mode 0440, `visudo -cf`
  clean, `Defaults:lcp-receive` including `env_reset`, `!requiretty` and
  `use_pty`, exactly one rule and it is
  `lcp-receive ALL=(root) NOPASSWD: NOSETENV: /opt/lcp-offhost/bin/offhost-publish.sh`
  (`sudoers-defaults`, `sudoers-setenv`, `sudoers-rule-count`, `sudoers-rule`).
- **Effective sudo authority**, not merely the drop-in: the read-only listing
  `sudo -n -l -U lcp-receive` under `LC_ALL=C` (nothing is executed; wrapped
  lines are rebuilt) must show the required effective Defaults **and none of
  their inverses** — `env_reset` without `!env_reset`, `!requiretty` without
  `requiretty`, `use_pty` without `!use_pty`, because a later entry from
  another sudoers source wins for sudo (`sudo-effective-env-reset`,
  `sudo-effective-requiretty`, `sudo-effective-use-pty`) — and exactly one
  command — the publisher, as root, with `NOPASSWD` and `NOSETENV`; any
  further command, shell, wildcard, `ALL`, `SETENV` or grant from another
  sudoers source fails (`sudo-effective-setenv`,
  `sudo-effective-extra-command`, `sudo-effective-tags`,
  `sudo-effective-runas`, `sudo-effective-no-grant`,
  `sudo-effective-unparseable`).
- `~lcp-receive/.ssh` 0700 / `authorized_keys` 0600 owned by the account with
  **exactly one** key line `restrict,command="…/offhost-receive.sh"`; the
  same for `lcp-audit` with `offhost-audit.sh` and **exactly two** keys
  (primary audit, GitHub audit); every key a complete OpenSSH-valid public
  key (full wire-structure parse plus `ssh-keygen -l -f -`; `ssh-keygen`
  must be installed, otherwise the check fails closed); three distinct
  fingerprints (`authorized-keys-*`, `authorized-keys-validator-unavailable`).
- `lcp-vault` has **no** authorized key and a nologin shell (`vault-*`).
- `lcp-receive`, `lcp-audit` and `lcp-vault` have **no usable password**
  (shadow field locked with `!`/`*`; the receive and audit accounts keep the
  shell the forced commands need) (`account-*-password-unlocked`).
- `lcp-receive` and `lcp-audit` not in the vault group; `lcp-receive` and
  `lcp-vault` not in the audit group (`groups-*`).
- sshd configuration — **strict installation profile**, so the set of files
  sshd reads is completely accounted for: the inspected path must be
  canonical — `realpath -e` resolves it to itself, so no symlinked
  component — inside a real, root-owned, non-group/world-writable directory
  (`sshd-config-noncanonical`, `sshd-config-dir`; nothing below is evaluated
  while the path is untrusted); the main `sshd_config` is a
  regular, root-owned, non-writable file (`sshd-config-missing|symlink|
  owner|writable`); it may carry at most one `Include` and that Include must
  be exactly `/etc/ssh/sshd_config.d/*.conf` (`sshd-include-unsupported`
  for any other path, pattern, extra argument, non-`.conf` file or second
  Include); when present, `sshd_config.d` must exist as a root-owned,
  non-writable directory (`sshd-include-missing|owner|writable`) and every
  file the pattern matches is scanned and must be a regular, non-symlink,
  root-owned, non-group/world-writable, readable file
  (`sshd-include-symlink|not-regular|owner|writable|unreadable`); a fragment
  may not `Include` anything (`sshd-include-nested`, so nested or secondary
  includes are refused rather than trusted); every `Match` block, in the
  main file or a fragment, may use only `User …` pairs and/or `All`
  (`sshd-match-criteria` for Address, Group, LocalAddress, LocalPort,
  RDomain, LocalNetwork, Exec, combined or unknown criteria). Only then is
  the per-account evaluation below authoritative.
- Effective sshd configuration **of the inspected file**: both evaluations
  name the file explicitly — `sshd -T -f /etc/ssh/sshd_config` globally and
  `sshd -T -f /etc/ssh/sshd_config -C user=lcp-receive,host=…,addr=…` (and
  the same for `lcp-audit`) per restricted account — so the daemon's
  compiled-in default can never stand in for the installed file, and what
  sshd resolves is exactly what the Include/Match scan covered. Values are
  read from the normalized `sshd -T` dump (lowercase keyword, then the
  value; `AllowUsers`, `AcceptEnv` and `SetEnv` one token per line;
  `AuthorizedKeysFile` and `AuthenticationMethods` on one line); a required
  directive that is **absent** from the dump fails — absence is never read
  as `none` or `no`. **Globally**: `permitrootlogin no`,
  `passwordauthentication no`, `pubkeyauthentication yes`, interactive
  authentication off, `forcecommand none`, `permituserenvironment no`
  (`sshd-root-login`, `sshd-password-auth`, `sshd-pubkey-auth`,
  `sshd-interactive-auth`, `sshd-force-command`, `sshd-user-environment`).
- `AllowUsers` **literal-user profile** (global dump): every token must match
  `^[a-z_][a-z0-9_-]{0,31}$` — no `*`, `?`, `!negation`, `user@host`, comma,
  bracket or backslash pattern (`sshd-allowusers-pattern`); `lcp-receive` and
  `lcp-audit` each exactly once (`sshd-allowusers-receive`,
  `sshd-allowusers-audit`, `sshd-allowusers-duplicate`); never `lcp-vault`
  (`sshd-allowusers-vault`); the directive must be present
  (`sshd-allowusers-missing`); every other name must be listed in
  `OFFHOST_SSHD_OPERATOR_USERS` — a comma-separated list of literal operator
  accounts validated with the same grammar (`invalid-operator-users`) —
  otherwise `sshd-allowusers-unexpected`. The operator account is therefore
  an explicit input of the check, never inferred from the host.
- **Per restricted account** (`-C user=lcp-receive,…` / `user=lcp-audit,…`),
  the authorization boundary: `passwordauthentication no`,
  `kbdinteractiveauthentication no` (or `challengeresponseauthentication
  no`), `pubkeyauthentication yes`, `authenticationmethods` exactly
  `publickey` (the default `any` fails), `hostbasedauthentication no`,
  `gssapiauthentication no`, `kerberosauthentication no`,
  `permitemptypasswords no`; `authorizedkeysfile` exactly
  `.ssh/authorized_keys` — the one file the key-inventory check reads
  (Ubuntu's default `.ssh/authorized_keys .ssh/authorized_keys2`, any other
  relative, absolute or `%h`/`%u`-tokenized path fails);
  `authorizedkeyscommand none` and `authorizedkeyscommanduser none`;
  `trustedusercakeys none`; `authorizedprincipalsfile none`,
  `authorizedprincipalscommand none`, `authorizedprincipalscommanduser
  none`; `forcecommand none` (the key-line command stays controlling; a
  global or `Match User` `ForceCommand` fails); `strictmodes yes`;
  `permituserenvironment no`; no `setenv` line; every `acceptenv` token
  limited to `LANG`, `LANGUAGE`, `LC_*` or a literal `LC_<NAME>` (a token
  able to match `OFFHOST_*`, `LCP_*`, `PATH`, `BASH_ENV`, `ENV`,
  `SHELLOPTS`, `BASHOPTS`, `LD_*`, a broad `*`/`L*`/`?ATH` pattern or a
  token with a space fails). Codes:
  `sshd-<receive|audit>-password-auth|interactive-auth|pubkey-auth|
  authentication-methods|alternate-auth|authorized-keys-file|
  authorized-keys-command|trusted-user-ca|authorized-principals|
  force-command|strict-modes|user-environment|setenv|acceptenv` and
  `sshd-<receive|audit>-unavailable` when the per-account dump cannot be
  produced. A safe global policy with a `Match User` block re-enabling
  passwords, adding a key command or overriding the forced command for one
  account therefore fails.
- **Environment-injection policy** on the script side (defence in depth,
  independent of sshd): every off-host script sets
  `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` as its
  first statement, before any external tool runs; the shared library forces
  `LC_ALL=C LANG=C LANGUAGE=C` and unsets `BASH_ENV`, `ENV`, `CDPATH`,
  `GLOBIGNORE` and `IFS` before any locale-sensitive parsing, so the only
  variables sshd may still accept (`LANG`/`LC_*`) cannot alter
  configuration, paths, identity hooks or command resolution; test hooks
  (`OFFHOST_NOW`, `LCP_*`, `OFFHOST_TEST_*`) are environment-only and are
  rejected as configuration keys. The harness proves a hostile `PATH`,
  `BASH_ENV` and locale in the forced command's environment leave `HELLO`
  and `AUDIT` output byte-identical.
- Full `sha256sum` of `offhost-publish.sh` and `offhost-lib.sh` (and the
  other bin files) recorded before activation; the check prints 12-character
  prefixes for comparison.
- **Real forced-command semantics and password-login refusal tested on the
  future backup VPS before activation — still mandatory**: with the real
  keys, `ssh lcp-receive@… 'ls'` must answer `REJECTED
  reason=unsupported-command`, a PTY request must be refused, a password
  login attempt for each of the three service accounts must be refused, and
  `HELLO`/`AUDIT` must answer as documented. The sandbox harness cannot prove
  this (no OpenSSH: the fake `sshd` answers `-T -f <file>` and `-T -f <file>
  -C user=…` from fixtures — it refuses any invocation without `-f` or
  naming another file — and `ssh-keygen -l -f -` is answered by the
  cryptography library's OpenSSH key loader when the real tool is absent),
  and nothing here claims it. The `sshd -T` directive spellings above follow
  the OpenSSH 9.6 (Ubuntu 24.04) dump format and must be confirmed against
  the real daemon's output on the backup VPS before activation (§15).

Scope reminder for this check (and this whole design): it hardens the
**PostgreSQL off-host backup**, which is Hostinger-only. The product's object
storage (scanned card images, documents, export files, tenant branding
logos) still uses Google Cloud Storage; a separate assessment, migration and
rollback batch is required before any claim that the product has zero Google
Cloud dependency (§1.1).

## 14. Monitoring workflow `backup-offhost-hostinger.yml`

- Schedule `0 5 * * *` (70 min after the documented 03:50 transfer) plus
  `workflow_dispatch` with the `simulate_failure` test input. Permissions:
  `contents: read`; `issues: write` only in the alert job. Concurrency group
  without cancellation.
- Every external action is pinned to a full 40-character commit SHA resolved
  from the official upstream repository (`actions/checkout@11d5960a…` =
  tag `v4.4.0`, also the current `v4` major tag; node20); the release tag is a
  comment only. The harness refuses mutable tags or branches.
- Connects **only** to the backup VPS with the GitHub audit identity (key 3)
  over a pinned channel (`StrictHostKeyChecking yes`, `IdentitiesOnly yes`,
  `BatchMode yes`, no `ssh-keyscan`), runs the single verb `AUDIT`, and
  evaluates the listing on the runner with
  `.github/scripts/verify-offhost-hostinger.sh`. It never initiates a backup,
  never uploads, never receives a dump byte, and is never a durable
  destination.
- Slot-aware freshness with a transfer grace (`TRANSFER_GRACE_MINUTES=90`):
  before 04:45 UTC the previous slot is the expected one; from 04:45 the
  current slot is required. A run that GitHub starts hours late still
  evaluates the current slot, so a delay never produces a false stale alert.
- Verdict line `OFFHOST_HEALTH=PASS|FAIL …`; failure reasons include
  `expected-generation-missing`, `expected-generation-incomplete`,
  `archive-too-small`, `same-host-destination`, `hostkey-mismatch`,
  `machine-mismatch`, `capacity-unhealthy`, `free-space-below-reserve`,
  `slot-over-cap`, `capacity-missing`, `capacity-invalid`,
  `stale-incoming-files`, `orphan-files`, `clock-skew`,
  `audit-header-duplicate`, `audit-protocol-version`,
  `audit-generation-duplicate`, `vault-root-missing`, `audit-rejected`,
  `ssh-connection-failed`.
- Alert: one deduplicated issue titled exactly
  `[Backup Alert] Hostinger off-host backup unhealthy` (create / comment /
  close with recovery comment; decision table in
  `.github/scripts/offhost-hostinger-alert-decision.sh`). The primary-side
  sender's own result is **not** an input: the remote audit is authoritative.
  The local backup alert (`[Backup Alert] Hosted PostgreSQL backup unhealthy`,
  issue #3 and successors) is a different title handled by a different
  workflow and is never touched.
- Secrets required at activation (values never printed): `BACKUP_VPS_HOST`,
  `BACKUP_VPS_PORT`, `BACKUP_VPS_AUDIT_USER`, `BACKUP_VPS_AUDIT_SSH_KEY`
  (key 3), `BACKUP_VPS_KNOWN_HOSTS`, the existing `VPS_KNOWN_HOSTS`, and
  optionally `BACKUP_VPS_MACHINE_HASH`.
- The schedule becomes active only once this file is on the repository
  default branch **and** the secrets exist — an owner decision.

## 15. Activation prerequisites (exact owner actions; none performed here)

1. Provision a second Hostinger VPS (different data center), Ubuntu 24.04,
   SSH key-only, `PermitRootLogin no`, `PasswordAuthentication no`, and the
   full sshd profile of `authorized_keys.example`: one authorized-key file
   (`AuthorizedKeysFile .ssh/authorized_keys`, no `authorized_keys2`), no
   `AuthorizedKeysCommand`, no `TrustedUserCAKeys` or principals
   file/command, no `ForceCommand` override, `AuthenticationMethods
   publickey` with host-based/GSSAPI/Kerberos/empty-password authentication
   off, `StrictModes yes`, `PermitUserEnvironment no`, no `SetEnv`,
   `AcceptEnv LANG LC_*` at most, and a literal `AllowUsers lcp-receive
   lcp-audit <operator-account>`; firewall
   allowing SSH from the primary VPS and GitHub only where possible, with a
   **dedicated backup file system or quota** for `/srv/lcp-offhost` (§10).
2. Create accounts `lcp-receive`, `lcp-audit`, `lcp-vault` (each with its own
   primary group; receive and vault **not** in `lcp-audit`; nobody but the
   vault in the vault group); `lcp-vault` has no SSH login.
3. Install the scripts to `/opt/lcp-offhost/bin/` (root-owned, 0755), the
   shared non-secret settings to `/etc/lcp-offhost/offhost.env`
   (`offhost.env.example`, limits reviewed and recorded), the sudoers drop-in
   (`sudoers.example`, validated with `visudo -cf`), and the vault layout of
   §6 including the marker file.
4. Generate **three** ed25519 key pairs: upload and primary-audit on the
   primary VPS; GitHub-audit on an operator machine whose private key goes
   only into the GitHub secret. Install the public keys with the forced
   commands (`authorized_keys.example`). Generate the age key pair offline;
   record the recipient in `offhost-send.env` (`offhost-send.env.example`,
   mode 0600); store the identity offline in two places.
5. Install `age` on the primary VPS; create the pinned ssh_config
   (`offhost-ssh.config.example`) and `offhost-known_hosts` from the backup
   VPS host key obtained out-of-band (never `ssh-keyscan` blindly); pin
   `OFFHOST_EXPECTED_MACHINE` / `OFFHOST_EXPECTED_HOSTKEYS` from a first
   `HELLO` compared with the `AUDIT` header.
6. Run `OFFHOST_SSHD_OPERATOR_USERS=<operator-account> offhost-install-check.sh`
   on the backup VPS until it passes (effective sudo listing, exact
   three-key inventory, locked passwords, canonical config path, per-account
   authorization boundary and environment policy of the inspected file);
   record as evidence the real daemon's `sshd -T -f /etc/ssh/sshd_config`
   lines for `permitrootlogin`, `passwordauthentication`,
   `pubkeyauthentication`, `kbdinteractiveauthentication`, `forcecommand`,
   `permituserenvironment` and `allowusers`, and the `sshd -T -f
   /etc/ssh/sshd_config -C user=lcp-receive,host=<host>,addr=<addr>` and
   `user=lcp-audit,…` lines for `authenticationmethods`,
   `authorizedkeysfile`, `authorizedkeyscommand`,
   `authorizedkeyscommanduser`, `trustedusercakeys`,
   `authorizedprincipalsfile`, `authorizedprincipalscommand`,
   `authorizedprincipalscommanduser`, `forcecommand`, `strictmodes`,
   `permituserenvironment`, `acceptenv`, `setenv`, `hostbasedauthentication`,
   `gssapiauthentication`, `kerberosauthentication` and
   `permitemptypasswords` (names and values only, never the file); test the
   real forced-command semantics (§13); record the script hashes.
7. Dry runs: `offhost-send.sh plan`, then one supervised `offhost-send.sh`
   run, then `offhost-retain.sh` (dry-run) on the backup VPS.
8. A **recovery drill** (§16) with the offline age identity before the cron
   lines are added.
9. Add the 03:50 crontab line on the primary and the 04:20 retention line on
   the backup VPS; add the GitHub secrets; merge the workflow to the default
   branch; dispatch it once with `simulate_failure=false`, then once with
   `simulate_failure=true` and confirm the new issue opens and is closed by
   the next healthy run.
10. Record in the activation record: hPanel backup setting evidence (§11),
    the backup VPS data center, the machine hash and host-key fingerprints,
    the storage boundary used and the three key fingerprints.

## 16. Recovery sequence (from the off-host copy)

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

## 17. Same-provider limitation (stated honestly)

The copy is **off-host but not off-provider**. Both VPSs are Hostinger
resources under the same account. A provider-wide outage, a billing or
account-level event, or a compromise of the hPanel account could affect both
machines at once. Mitigations available within the decision: different data
centers, separate SSH identities with forced commands, ciphertext only on the
backup VPS with the key in owner custody, and Hostinger-managed backups as an
additional provider-level layer. A copy outside the provider would remove this
limitation but is explicitly out of scope by the owner's decision.

## 18. Tests and what they prove

- `docker/scripts/offhost/test/offhost.test.sh` — deterministic; fixed clock,
  stub `ssh` executing the forced commands with `SSH_ORIGINAL_COMMAND`, real
  `age` round trip, fixture machine-ids and host keys, simulated free space.
  When run as root with the `lcpt-receive`/`lcpt-audit`/`lcpt-vault` test
  accounts, the receiver and auditor run as those users and the publisher
  through a temporary sudoers drop-in — the production shape — and the
  file-system permission assertions are real; otherwise they are reported as
  `skip`. Covers: successful current-slot upload; interrupted transfer (short
  read and a SIGKILLed receiver); duplicate cannot overwrite; old-slot,
  future-stamp, malformed names, injection, traversal; missing/invalid
  manifest and ordering; checksum/size/format mismatches; encryption failure;
  same-host rejection (machine-id, host key, pin, unverifiable); **audit
  binding** (upload alias on host A and audit alias on host B holding a
  matching complete generation; different file-system id; disjoint host keys;
  duplicate, malformed and version-drifted headers; clock skew; duplicate
  generation records — all failing before encryption and any PUT);
  **overall budget** (encryption, HELLO, pre-audit, archive PUT, manifest
  PUT and post-audit timeouts; cumulative exhaustion; one summary line;
  temporaries removed; valid stages resumable); **storage limits** (first and
  second generation accepted, third rejected before reading, incomplete
  archive counted, manifest completion at the cap, idempotent `EXISTS`,
  insufficient free space and undeterminable capacity rejected before
  reading, capacity lost between preflight and publication caught, audit
  over-cap and low states, per-archive maximum, unsafe settings refused,
  repeated rejections leave no temporary data, aggressive retention still
  protects the newest generations); identity restrictions of both SSH
  identities; symlink/hard-link/owner attacks on the publisher; temp and
  orphan detection; retention dry-run/apply/protect/quarantine/purge and root
  validation; **installation-integrity fixture** with mutations — including a
  fake `sshd` that answers `-T -f <inspected file>` and `-T -f <inspected
  file> -C user=…` from separate global and per-account fixtures and refuses
  any invocation without `-f` or naming another file (the invocation log
  proves exactly one global and one per-account evaluation of the inspected
  file; a safe global policy with a `Match User` password override for the
  receive or audit account fails; an unsafe inspected file is caught even
  when the daemon default would be safe), **effective authorization
  boundary** cases (Ubuntu's default `authorized_keys2` second file,
  another relative, an absolute and a `%h`-tokenized key file, an absent
  `AuthorizedKeysFile`, an `AuthorizedKeysCommand` or command user, a
  `TrustedUserCAKeys`, a principals file or command, a global and a `Match
  User` `ForceCommand`, `StrictModes no`, `AuthenticationMethods any` /
  `publickey,password` / absent, host-based, GSSAPI and empty-password
  authentication all fail; the documented profile passes), **literal
  `AllowUsers`** cases (`*`, `?`, `!lcp-vault`, `user@host`, `lcp-*`, a
  comma list, a bracket and a backslash pattern, a duplicated service
  account, an unlisted account, an empty and a malformed operator list all
  fail; the explicitly listed operator passes), **environment-injection**
  cases (`PermitUserEnvironment yes`, `SetEnv` of `LCP_MACHINE_ID_FILE` /
  `PATH`, and every dangerous `AcceptEnv` token — `OFFHOST_*`,
  `OFFHOST_NOW`, `LCP_*`, `LCP_MACHINE_ID_FILE`, `PATH`, `BASH_ENV`, `ENV`,
  `SHELLOPTS`, `BASHOPTS`, `LD_*`, `LD_PRELOAD`, `*`, `L*`, `?ATH`,
  `LC_*ALL`, `LC_ALL *` — fail; locale-only `AcceptEnv` passes; a hostile
  `PATH`, `BASH_ENV` and locale in the forced command's environment leave
  `HELLO` and `AUDIT` output byte-identical), **config-path** cases (a
  symlinked parent directory, a writable or non-root parent and another
  canonical file all fail with their own reason), a shadow-format fixture
  (unlocked receive, audit or vault password fails), the exact three-key
  inventory (one audit key, duplicated audit keys, the upload key reused as
  an audit key, a malformed blob, an extra key, a wrong forced command, a
  missing `restrict` all fail) and real `sudo -n -l -U` effective listings
  (missing Defaults, `SETENV`, an extra grant from a second sudoers file, an
  effective `ALL` or shell grant, and inverse Defaults — `!env_reset`,
  `requiretty`, `!use_pty`, alone or together — appended by another sudoers
  source all fail; the checker is proven read-only), complete key-structure
  validation (three freshly generated real Ed25519 keys pass; type-only,
  short, long, trailing-garbage, overflowing, type-mismatched and badly
  padded blobs fail; a missing validator fails closed), the strict Include
  profile (non-`.conf` include, nested include, symlinked / foreign-owned /
  writable / non-regular / missing fragments, escaping or duplicate Includes
  and foreign Match criteria all fail; the documented layout with `Match All`
  passes), and the sender's test-only budget hook (sixteen malformed values
  each produce one sanitized `invalid-test-hook` summary); every documented
  configuration key exercised; configuration hygiene; static provider scan;
  leak scan.
- `.github/scripts/test/verify-offhost-hostinger.test.sh` — expected-slot
  function, verifier against canned listings (healthy, early, 18 h late,
  missing, incomplete, too small, same-host pinned/reported, host-key
  mismatch, stale/orphan files, clock skew, rejected/empty listing, machine
  pin, capacity missing/duplicate/malformed/low/inconsistent/over-cap/
  unavailable, duplicate header/footer, protocol version, duplicate and
  malformed generation records), summary-regex compatibility, alert decision
  truth table incl. simulated failure and sanitising, workflow statics,
  immutable action pins, provider scan, leak scan.
- `.github/scripts/test/verify-hosted-backup.test.sh` — the existing local
  backup verification tests (unchanged, must stay green).

Not proven here: real OpenSSH forced-command behaviour end to end, PTY
rejection and password-login rejection (the sandbox has no OpenSSH client,
server or `ssh-keygen`; the `sshd -T` directive spellings are implemented
from the OpenSSH 9.6 dump format and have not been run against a real
daemon), real Hostinger hosts, a real dedicated file system or quota
(storage boundary), the Hostinger-managed backup setting, cron activation,
GitHub secrets, a real encrypted upload, retention on a real vault, and a
recovery from a real backup VPS.

## 19. File map

| File | Runs on | Purpose |
|---|---|---|
| `docker/scripts/offhost/offhost-lib.sh` | both | shared pure helpers (slot math, names, fingerprints, machine hash, free space, capacity, eligibility, manifest/receipt checks, config loader) |
| `docker/scripts/offhost/offhost-send.sh` | primary | sender with audit binding and the overall budget (§5, §7, §9) |
| `docker/scripts/offhost/offhost-receive.sh` | backup (forced, `lcp-receive`) | receiver with capacity preflight (§6, §10) |
| `docker/scripts/offhost/offhost-publish.sh` | backup (root via sudo) | read-only preflight, exclusive publisher and receipts |
| `docker/scripts/offhost/offhost-audit.sh` | backup (forced, `lcp-audit`) | list-only auditor incl. the `CAPACITY` line |
| `docker/scripts/offhost/offhost-retain.sh` | backup (`lcp-vault`) | retention, dry-run by default |
| `docker/scripts/offhost/offhost-install-check.sh` | backup (root) | installation-integrity check: ownership/modes, drop-in + effective sudo (inverse Defaults rejected), exact three-key inventory with complete OpenSSH-valid keys, account locks, groups, canonical config path, strict sshd Include profile, effective authorization boundary of the inspected file per account (`sshd -T -f … -C`), literal `AllowUsers`, environment policy (§13) |
| `docker/scripts/offhost/*.example` | — | authorized_keys (three keys), sudoers, shared settings with limits, sender settings, pinned ssh_config |
| `docker/scripts/offhost/test/offhost.test.sh` | sandbox | deterministic ops harness |
| `.github/workflows/backup-offhost-hostinger.yml` | GitHub | daily read-only audit + alert, SHA-pinned actions |
| `.github/scripts/verify-offhost-hostinger.sh` | runner | evaluates the AUDIT listing incl. capacity |
| `.github/scripts/offhost-hostinger-alert-decision.sh` | runner | alert truth table |
| `.github/scripts/test/verify-offhost-hostinger.test.sh` | sandbox | deterministic GitHub-side harness |
