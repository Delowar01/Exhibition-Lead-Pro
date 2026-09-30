#!/bin/bash
# =============================================================================
# Deterministic tests for the Hostinger-only off-host backup scripts
# (B23 G-6D Correction 1) — docker/scripts/offhost/*.sh
# =============================================================================
# Touches no VPS, no network, no GitHub Issue and no secret. Everything runs in
# a temporary directory with a fixed clock (OFFHOST_NOW), a stub `ssh` that
# executes the forced-command scripts locally with SSH_ORIGINAL_COMMAND (the
# sandbox has no OpenSSH client), real `age` encryption with a throw-away key
# pair generated here, and fixture machine-id / host-key files for the
# "primary" and the "vault" sides.
#
# Identity separation: when run as root with the three local test accounts
# lcpt-receive / lcpt-audit / lcpt-vault (group lcpt-audit) present and sudo
# usable, the receiver and the auditor run as those users and the publisher
# is reached through a temporary sudoers drop-in (removed at exit) — exactly
# the production shape — and the file-system permission assertions are real.
# Otherwise everything runs as the current user and those assertions are
# reported as SKIP (counted separately, never as passes).
#
#     bash docker/scripts/offhost/test/offhost.test.sh
# =============================================================================
set -uo pipefail
export PYTHONDONTWRITEBYTECODE=1 LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OH="$(cd "$HERE/.." && pwd)"
PASSED=0; FAILED=0; SKIPPED=0
ok()   { PASSED=$((PASSED + 1)); echo "ok   $1"; }
bad()  { FAILED=$((FAILED + 1)); echo "FAIL $1${2:+ — $2}"; }
skip() { SKIPPED=$((SKIPPED + 1)); echo "skip $1${2:+ — $2}"; }
expect_eq()    { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got '$2' want '$3'"; fi; }
expect_true()  { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
expect_match() { if [[ "$2" =~ $3 ]]; then ok "$1"; else bad "$1" "got '$2'"; fi; }
expect_false() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$d" "unexpectedly succeeded"; else ok "$d"; fi; }
has()    { if grep -qE -- "$2" "$1"; then ok "$3"; else bad "$3" "pattern '$2' absent"; fi; }
nothas() { if grep -qE -- "$2" "$1"; then bad "$3" "pattern '$2' present"; else ok "$3"; fi; }
ts() { date -u -d "$1" +%s; }

echo "== 0. syntax =="
for f in offhost-lib.sh offhost-send.sh offhost-receive.sh offhost-publish.sh offhost-audit.sh offhost-retain.sh; do
  expect_true "bash -n $f" bash -n "$OH/$f"
done
expect_true "bash -n this test" bash -n "${BASH_SOURCE[0]}"
for t in age age-keygen sha256sum gzip flock python3 openssl base64 realpath; do
  command -v "$t" >/dev/null 2>&1 || { echo "required tool missing: $t"; exit 1; }
done

# ── workspace ────────────────────────────────────────────────────────────────
T="$(mktemp -d "${TMPDIR:-/tmp}/lcp-offhost-test.XXXXXXXX")"; chmod 755 "$T"
SUDOERS_FILE=""
cleanup() { [ -n "$SUDOERS_FILE" ] && rm -f -- "$SUDOERS_FILE"; if [ "${OFFHOST_TEST_KEEP:-0}" = 1 ]; then echo "kept: $T"; else rm -rf "${T:?}"; fi; }
trap cleanup EXIT
mkdir -p "$T/bin" "$T/out" "$T/primary/backups/postgres" "$T/primary/state" "$T/primary/env" "$T/pk" "$T/vk" "$T/vault"
NOW="$(ts '2026-09-30 05:00:00')"; echo "$NOW" >"$T/now"; chmod 644 "$T/now"
CUR_LABEL=20260930-0315
printf '%s\n' "$(printf 'a%.0s' $(seq 32))" >"$T/primary.mid"
printf '%s\n' "$(printf 'b%.0s' $(seq 32))" >"$T/vault.mid"
chmod 644 "$T/primary.mid" "$T/vault.mid"
mkkey() { printf 'ssh-ed25519 %s fixture\n' "$(head -c 51 /dev/urandom | base64 -w0)" >"$1"; chmod 644 "$1"; }
mkkey "$T/pk/ssh_host_ed25519_key.pub"; mkkey "$T/pk/ssh_host_rsa_key.pub"; mkkey "$T/vk/ssh_host_ed25519_key.pub"
chmod 755 "$T/pk" "$T/vk"
age-keygen -o "$T/age.key" 2>/dev/null; chmod 600 "$T/age.key"
RECIPIENT="$(grep -oE 'age1[0-9a-z]{58}' "$T/age.key" | head -n 1)"
SECRET_KEY="$(grep -oE 'AGE-SECRET-KEY-1[0-9A-Z]+' "$T/age.key" | head -n 1)"
CANARY="CANARY-ROW-$(head -c 12 /dev/urandom | base64 -w0 | tr -dc 'A-Za-z0-9')"

# ── identity mode ────────────────────────────────────────────────────────────
ROOT_MODE=0
if [ "${OFFHOST_TEST_SINGLE_USER:-0}" = 1 ]; then :   # forced single-user mode (exercises the fallback path)
elif [ "$(id -u)" = 0 ] && id -u lcpt-receive >/dev/null 2>&1 && id -u lcpt-audit >/dev/null 2>&1 && id -u lcpt-vault >/dev/null 2>&1 \
   && getent group lcpt-audit >/dev/null 2>&1 && command -v runuser >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1 && command -v visudo >/dev/null 2>&1 \
   && [ -d /etc/sudoers.d ] && runuser -u lcpt-receive -- test -r "$OH/offhost-lib.sh" 2>/dev/null && runuser -u lcpt-receive -- test -r "$T/now" 2>/dev/null \
   && ! id -Gn lcpt-receive | grep -qw lcpt-audit && ! id -Gn lcpt-vault | grep -qw lcpt-audit; then   # the receive/vault users must NOT be in the audit group
  ROOT_MODE=1
fi
VAULT_USER=lcpt-vault; AUDIT_GROUP=lcpt-audit; RECEIVE_USER=lcpt-receive
as_receive() { if [ "$ROOT_MODE" = 1 ]; then runuser -u lcpt-receive -- "$@"; else "$@"; fi; }
as_audit()   { if [ "$ROOT_MODE" = 1 ]; then runuser -u lcpt-audit -- "$@"; else "$@"; fi; }
as_vault()   { if [ "$ROOT_MODE" = 1 ]; then runuser -u lcpt-vault -- "$@"; else "$@"; fi; }

# vault layout (activation shape)
ROOT="$T/vault/root"
mk_vault() {   # (re)creates an empty vault root with the activation layout
  rm -rf "${ROOT:?}"; mkdir -p "$ROOT/incoming" "$ROOT/published" "$ROOT/quarantine"
  touch "$ROOT/.lcp-offhost-root"; chmod 755 "$T/vault" "$ROOT"; chmod 644 "$ROOT/.lcp-offhost-root"
  if [ "$ROOT_MODE" = 1 ]; then
    chown "$RECEIVE_USER:$AUDIT_GROUP" "$ROOT/incoming"; chmod 0750 "$ROOT/incoming"
    chown "$VAULT_USER:$AUDIT_GROUP" "$ROOT/published"; chmod 0750 "$ROOT/published"
    chown "$VAULT_USER:$AUDIT_GROUP" "$ROOT/quarantine"; chmod 0700 "$ROOT/quarantine"
  else
    chmod 0750 "$ROOT/incoming" "$ROOT/published"; chmod 0700 "$ROOT/quarantine"
  fi
}
mk_vault
# non-secret vault configuration (root-owned in production)
PUBLISH_WRAPPER="$T/bin/publish-wrapper.sh"
cat >"$PUBLISH_WRAPPER" <<EOF
#!/bin/bash
# stands in for the sudoers-limited publisher entry (env is reset by sudo: the clock and config come from root-owned files)
export OFFHOST_CONFIG="$T/offhost.env" OFFHOST_NOW="\$(cat "$T/now")"
exec bash "$OH/offhost-publish.sh" "\$@"
EOF
chmod 755 "$PUBLISH_WRAPPER"
write_vault_config() {
  cat >"$T/offhost.env" <<EOF
OFFHOST_ROOT=$ROOT
OFFHOST_PUBLISH_CMD=$PUBLISH_CMD
OFFHOST_VAULT_USER=$VAULT_USER
OFFHOST_AUDIT_GROUP=$AUDIT_GROUP
OFFHOST_RECEIVE_USER=$RECEIVE_USER
OFFHOST_SLOT_WINDOW=2
OFFHOST_STALE_SECONDS=21600
OFFHOST_RETAIN_DAYS=35
OFFHOST_PROTECT_NEWEST=7
OFFHOST_QUARANTINE_AFTER_DAYS=2
EOF
  chmod 644 "$T/offhost.env"
}
PUBLISH_CMD="sudo -n $PUBLISH_WRAPPER"; write_vault_config
if [ "$ROOT_MODE" = 1 ]; then
  SUDOERS_FILE="/etc/sudoers.d/lcpt-offhost-test"
  printf 'Defaults:lcpt-receive env_reset, !requiretty\nlcpt-receive ALL=(root) NOPASSWD: %s\n' "$PUBLISH_WRAPPER" >"$SUDOERS_FILE"; chmod 0440 "$SUDOERS_FILE"
  # the probe must reach the publisher as root (its verdict proves sudo works; a sudo failure prints no verdict)
  probe="$(runuser -u lcpt-receive -- sudo -n "$PUBLISH_WRAPPER" probe 1 2 2>/dev/null || true)"
  if ! visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1 || [ "$probe" != "REJECTED reason=invalid-name" ]; then
    echo "note: sudo path not usable for the test identities; falling back to single-user mode"
    rm -f "$SUDOERS_FILE"; SUDOERS_FILE=""; ROOT_MODE=0; mk_vault
  fi
fi
if [ "$ROOT_MODE" = 0 ]; then PUBLISH_CMD="$PUBLISH_WRAPPER"; RECEIVE_USER=""; VAULT_USER="$(id -un)"; AUDIT_GROUP="$(id -gn)"; write_vault_config; fi
echo "identity mode: $([ "$ROOT_MODE" = 1 ] && echo 'separate users (lcpt-receive / lcpt-audit / lcpt-vault, sudo publisher)' || echo 'single user (permission assertions skipped)')"

# ── stub ssh: dispatches by target alias, logs every call, injects faults ────
cat >"$T/bin/ssh" <<EOF
#!/bin/bash
# stub OpenSSH client for the harness: the two last arguments are <target> <command>
target="\${@: -2:1}"; cmd="\${@: -1}"
printf '%s\t%s\n' "\$target" "\$cmd" >>"$T/ssh.calls"
NOWV="\$(cat "$T/now")"
recv() {   # MACHINE_ID_FILE HOSTKEY_DIR
  $( [ "$ROOT_MODE" = 1 ] && echo 'runuser -u lcpt-receive --' ) env SSH_ORIGINAL_COMMAND="\$cmd" OFFHOST_CONFIG="$T/offhost.env" OFFHOST_NOW="\$NOWV" LCP_MACHINE_ID_FILE="\$1" LCP_HOSTKEY_DIR="\$2" bash "$OH/offhost-receive.sh"
}
audit() {
  $( [ "$ROOT_MODE" = 1 ] && echo 'runuser -u lcpt-audit --' ) env SSH_ORIGINAL_COMMAND="\$cmd" OFFHOST_CONFIG="$T/offhost.env" OFFHOST_NOW="\$NOWV" LCP_MACHINE_ID_FILE="$T/vault.mid" LCP_HOSTKEY_DIR="$T/vk" bash "$OH/offhost-audit.sh"
}
case "\$target" in
  vault-upload)          recv "$T/vault.mid" "$T/vk" ;;
  vault-audit)           audit ;;
  same-machine-upload)   recv "$T/primary.mid" "$T/vk" ;;
  same-hostkey-upload)   recv "$T/vault.mid" "$T/pk" ;;
  unknown-machine-upload) recv "$T/nonexistent.mid" "$T/vk" ;;
  cut-upload)            case "\$cmd" in PUT*) head -c 700 | recv "$T/vault.mid" "$T/vk"; exit 255 ;; *) recv "$T/vault.mid" "$T/vk" ;; esac ;;
  drop-manifest-upload)  case "\$cmd" in PUT*manifest*) cat >/dev/null; exit 255 ;; *) recv "$T/vault.mid" "$T/vk" ;; esac ;;
  lost-reply-upload)     case "\$cmd" in PUT*manifest*) recv "$T/vault.mid" "$T/vk" >/dev/null; exit 255 ;; *) recv "$T/vault.mid" "$T/vk" ;; esac ;;
  dead-audit)            exit 255 ;;
  *) echo "stub ssh: unknown target" >&2; exit 255 ;;
esac
EOF
chmod 755 "$T/bin/ssh"
printf '#!/bin/bash\necho "age: simulated failure" >&2\nexit 1\n' >"$T/bin/age-fail"; chmod 755 "$T/bin/age-fail"
: >"$T/primary/env/ssh.config"

# ── primary fixtures: valid dumps with a canary row ───────────────────────────
mk_dump() {   # NAME MTIME_EPOCH [rows]
  local f="$T/primary/backups/postgres/$1" rows="${3:-400}" i
  { echo "-- PostgreSQL database dump"; echo "--"; echo "CREATE TABLE public.t (id int, v text);"; echo "COPY public.t (id, v) FROM stdin;"
    for i in $(seq "$rows"); do echo "$i	$CANARY-$i-$(head -c 24 /dev/urandom | base64 -w0)"; done
    echo '\.'; echo "-- PostgreSQL database dump complete"; echo '\unrestrict k3y'; } | gzip -9 >"$f"
  ( cd "$T/primary/backups/postgres" && sha256sum "$1" >"$1.sha256" )
  touch -d "@$2" "$f" "$f.sha256"; chmod 600 "$f" "$f.sha256"
}
SET=leadcapture-20260930-031501.sql.gz
mk_dump "$SET" "$(ts '2026-09-30 03:15:03')"
mk_dump leadcapture-20260928-031501.sql.gz "$(ts '2026-09-28 03:15:03')"
SRC_SHA="$(sha256sum "$T/primary/backups/postgres/$SET" | cut -c1-64)"

# send [plan] → runs the sender; output in $T/out/$CASE.log; echoes rc
send() {
  local case="$1"; shift
  env OFFHOST_NOW="$(cat "$T/now")" OFFHOST_SSH_BIN="${SSH_BIN_OVERRIDE:-$T/bin/ssh}" OFFHOST_AGE_BIN="${AGE_BIN_OVERRIDE:-age}" \
    LCP_MACHINE_ID_FILE="$T/primary.mid" LCP_HOSTKEY_DIR="$T/pk" \
    BACKUP_DIR="$T/primary/backups/postgres" OFFHOST_STATE_DIR="$T/primary/state" OFFHOST_SSH_CONFIG="$T/primary/env/ssh.config" \
    OFFHOST_UPLOAD_TARGET="${UPLOAD_TARGET:-vault-upload}" OFFHOST_AUDIT_TARGET="${AUDIT_TARGET:-vault-audit}" \
    OFFHOST_RECIPIENT="${RECIPIENT_OVERRIDE:-$RECIPIENT}" OFFHOST_EXPECTED_MACHINE="${EXPECTED_MACHINE:-}" \
    bash "$OH/offhost-send.sh" "$@" >"$T/out/$case.log" 2>&1
  echo $?
}
summary() { grep -m1 -E '^OFFHOST_UPLOAD=' "$T/out/$1.log" || true; }
# receiver_put CASE NAME SIZE SHA FILE [MID HK] → runs the receiver directly (as the upload identity)
receiver_put() {
  local case="$1" name="$2" size="$3" sha="$4" file="$5"
  as_receive env SSH_ORIGINAL_COMMAND="PUT $name $size $sha" OFFHOST_CONFIG="$T/offhost.env" OFFHOST_NOW="$(cat "$T/now")" LCP_MACHINE_ID_FILE="$T/vault.mid" LCP_HOSTKEY_DIR="$T/vk" \
    bash "$OH/offhost-receive.sh" <"$file" >"$T/out/$case.log" 2>&1
  echo $?
}
receiver_cmd() {   # CASE COMMAND
  as_receive env SSH_ORIGINAL_COMMAND="$2" OFFHOST_CONFIG="$T/offhost.env" OFFHOST_NOW="$(cat "$T/now")" LCP_MACHINE_ID_FILE="$T/vault.mid" LCP_HOSTKEY_DIR="$T/vk" \
    bash "$OH/offhost-receive.sh" </dev/null >"$T/out/$1.log" 2>&1
  echo $?
}
audit_cmd() {   # CASE COMMAND
  as_audit env SSH_ORIGINAL_COMMAND="$2" OFFHOST_CONFIG="$T/offhost.env" OFFHOST_NOW="$(cat "$T/now")" LCP_MACHINE_ID_FILE="$T/vault.mid" LCP_HOSTKEY_DIR="$T/vk" \
    bash "$OH/offhost-audit.sh" </dev/null >"$T/out/$1.log" 2>&1
  echo $?
}
publish_direct() {   # CASE NAME [SIZE SHA] → runs the publisher the way sudo would
  local case="$1"; shift
  "$PUBLISH_WRAPPER" "$@" >"$T/out/$case.log" 2>&1; echo $?
}
retain() {   # CASE [--apply] (as the vault identity)
  local case="$1"; shift
  as_vault env OFFHOST_CONFIG="$T/offhost.env" OFFHOST_NOW="$(cat "$T/now")" bash "$OH/offhost-retain.sh" "$@" >"$T/out/$case.log" 2>&1; echo $?
}
mk_age() {   # FILE BYTES → a syntactically valid-looking age file of that size
  { printf 'age-encryption.org/v1\n'; head -c $(( $2 - 22 )) /dev/urandom; } >"$1"
}
inc_count() { find "$ROOT/incoming" -maxdepth 1 \( -name '*.pending' -o -name '.*.partial' \) | wc -l; }
pub_ls() { find "$ROOT/published" -mindepth 1 -printf '%P\n' 2>/dev/null | sort; }

echo "== 1. library: slot arithmetic, names, identity helpers =="
# shellcheck disable=SC1090
source "$OH/offhost-lib.sh"
expect_eq "slot index of 03:14:59 is the previous day" "$(lcp_slot_label "$(lcp_slot_index "$(ts '2026-09-30 03:14:59')")")" "20260929-0315"
expect_eq "slot index of 03:15:00 is today"            "$(lcp_slot_label "$(lcp_slot_index "$(ts '2026-09-30 03:15:00')")")" "20260930-0315"
expect_eq "slot index of 05:00 (harness clock) is today" "$(lcp_slot_label "$(lcp_slot_index "$NOW")")" "$CUR_LABEL"
expect_eq "stamp epoch round-trips" "$(lcp_stamp_epoch "$SET")" "$(ts '2026-09-30 03:15:01')"
for n in leadcapture-20260931-031501.sql.gz leadcapture-20260930-251501.sql.gz leadcapture-2026930-031501.sql.gz .leadcapture-20260930-031501.sql.gz "leadcapture-20260930-031501.sql.gz;id"; do
  expect_false "malformed set name rejected: $n" lcp_stamp_epoch "$n"
done
expect_true  "archive object name recognised"  lcp_object_kind "$SET.age";           expect_eq "…kind archive" "$LCP_KIND" archive
expect_true  "manifest object name recognised" lcp_object_kind "$SET.manifest.json"; expect_eq "…kind manifest, set kept" "$LCP_KIND/$LCP_SET" "manifest/$SET"
for n in "$SET" "$SET.age.receipt" "../$SET.age" "$SET.tar" "leadcapture-20260931-031501.sql.gz.age" "x/$SET.age"; do
  expect_false "non-object name rejected: $n" lcp_object_kind "$n"
done
FP="$(lcp_hostkey_fingerprint "$T/vk/ssh_host_ed25519_key.pub")"
expect_match "fingerprint has the OpenSSH SHA256 shape" "$FP" '^SHA256:[A-Za-z0-9+/]{43}$'
awk '{print "backup.example " $1 " " $2}' "$T/vk/ssh_host_ed25519_key.pub" >"$T/vault.known_hosts"
awk '{print "primary.example " $1 " " $2}' "$T/pk/ssh_host_ed25519_key.pub" "$T/pk/ssh_host_rsa_key.pub" >"$T/primary.known_hosts"
expect_eq "known_hosts fingerprint equals the host-key file fingerprint" "$(lcp_known_hosts_fingerprints "$T/vault.known_hosts")" "$FP"
expect_eq "local host-key fingerprints (vault dir)" "$(LCP_HOSTKEY_DIR="$T/vk" lcp_local_hostkey_fingerprints)" "$FP"
expect_true  "fingerprint lists intersect"        lcp_lists_intersect "$(lcp_known_hosts_fingerprints "$T/primary.known_hosts")" "$(LCP_HOSTKEY_DIR="$T/pk" lcp_local_hostkey_fingerprints)"
expect_false "disjoint fingerprint lists"          lcp_lists_intersect "$(lcp_known_hosts_fingerprints "$T/primary.known_hosts")" "$FP"
expect_false "unknown never intersects"            lcp_lists_intersect unknown unknown
expect_eq "machine hash is a sha256, never the id" "$(LCP_MACHINE_ID_FILE="$T/vault.mid" lcp_machine_hash | wc -c)" "65"
expect_eq "unreadable machine-id → unknown" "$(LCP_MACHINE_ID_FILE="$T/none" lcp_machine_hash)" "unknown"
expect_true  "root marker accepted"  lcp_root_ok "$ROOT"
expect_false "root without marker refused" lcp_root_ok "$T/vault"
expect_false "top-level root refused" lcp_root_ok "/tmp"
ln -s "$ROOT" "$T/rootlink"; expect_false "symlinked root refused" lcp_root_ok "$T/rootlink"
expect_eq "eligibility of the current-slot fixture" "$(lcp_backup_eligibility "$T/primary/backups/postgres" "$SET" "$(lcp_slot_index "$NOW")")" ok

echo "== 2. plan mode is read-only =="
: >"$T/ssh.calls"
expect_eq "plan exits 0" "$(send plan plan)" 0
has "$T/out/plan.log" "^plan: set=$SET slot=$CUR_LABEL " "plan names the current-slot candidate"
expect_eq "plan makes no ssh call" "$(wc -l <"$T/ssh.calls")" 0
expect_eq "plan writes nothing to the state dir" "$(find "$T/primary/state" -mindepth 1 | wc -l)" 0

echo "== 3. successful current-slot upload =="
: >"$T/ssh.calls"
expect_eq "sender exits 0" "$(send ok)" 0
has "$T/out/ok.log" "^OFFHOST_UPLOAD=PASS set=$SET slot=$CUR_LABEL archive_size=[0-9]+ sha256_prefix=[0-9a-f]{12} destination=[0-9a-f]{12} upload=published audit=complete$" "exactly the documented PASS line"
expect_eq "exactly one summary line" "$(grep -c '^OFFHOST_UPLOAD=' "$T/out/ok.log")" 1
expect_eq "call order: HELLO, AUDIT, PUT archive, PUT manifest, AUDIT" "$(cut -f2 "$T/ssh.calls" | awk '{print $1}' | tr '\n' ' ')" "HELLO AUDIT PUT PUT AUDIT "
has "$T/ssh.calls" "	PUT $SET.age [0-9]+ [0-9a-f]{64}$" "archive PUT carries name, size and checksum only"
expect_eq "published set" "$(pub_ls | tr '\n' ' ')" "$CUR_LABEL $CUR_LABEL/$SET.age $CUR_LABEL/$SET.age.receipt $CUR_LABEL/$SET.manifest.json $CUR_LABEL/$SET.manifest.json.receipt "
expect_eq "archive mode 0400" "$(stat -c %a "$ROOT/published/$CUR_LABEL/$SET.age")" 400
expect_eq "manifest mode 0440" "$(stat -c %a "$ROOT/published/$CUR_LABEL/$SET.manifest.json")" 440
expect_eq "receipt mode 0440" "$(stat -c %a "$ROOT/published/$CUR_LABEL/$SET.age.receipt")" 440
expect_eq "incoming left clean" "$(inc_count)" 0
expect_eq "sender stage cleared" "$(find "$T/primary/state/stage" -type f 2>/dev/null | wc -l)" 0
expect_true "local receipt written" test -f "$T/primary/state/$SET.receipt"
ARC_SHA_PUB="$(sha256sum "$ROOT/published/$CUR_LABEL/$SET.age" | cut -c1-64)"
expect_eq "receipt checksum equals the published archive" "$(lcp_receipt_field "$ROOT/published/$CUR_LABEL/$SET.age.receipt" sha256)" "$ARC_SHA_PUB"
expect_eq "manifest records the plaintext checksum" "$(lcp_manifest_field "$ROOT/published/$CUR_LABEL/$SET.manifest.json" source_sha256)" "$SRC_SHA"
expect_eq "decrypt round trip equals the local dump" "$(age -d -i "$T/age.key" "$ROOT/published/$CUR_LABEL/$SET.age" 2>/dev/null | sha256sum | cut -c1-64)" "$SRC_SHA"
if [ "$ROOT_MODE" = 1 ]; then
  expect_eq "published archive owned by the vault identity" "$(stat -c %U "$ROOT/published/$CUR_LABEL/$SET.age")" "$VAULT_USER"
  expect_eq "receipt group is the audit group" "$(stat -c %G "$ROOT/published/$CUR_LABEL/$SET.age.receipt")" "$AUDIT_GROUP"
else skip "ownership assertions (single-user mode)"; fi
expect_eq "audit reports the generation complete" "$(audit_cmd audit1 AUDIT >/dev/null; grep -c "^generation slot=$CUR_LABEL set=$SET .* complete=yes$" "$T/out/audit1.log")" 1
has "$T/out/audit1.log" "^LCP-OFFHOST/1 AUDIT_END generations=1 complete=1 incomplete=0 pending=0 pending_stale=0 partial=0 partial_stale=0 orphans=0 quarantine=0 current_slot_complete=yes$" "audit footer"

echo "== 4. re-run: already published, nothing re-uploaded =="
: >"$T/ssh.calls"
expect_eq "sender exits 0 again" "$(send again)" 0
has "$T/out/again.log" "^OFFHOST_UPLOAD=PASS .* upload=already-published audit=complete$" "PASS with upload=already-published"
expect_eq "no PUT issued on the re-run" "$(grep -c '	PUT ' "$T/ssh.calls")" 0
expect_eq "published archive unchanged" "$(sha256sum "$ROOT/published/$CUR_LABEL/$SET.age" | cut -c1-64)" "$ARC_SHA_PUB"

echo "== 5. duplicate cannot overwrite (receiver level) =="
mk_age "$T/dup.age" 4096; DUP_SHA="$(sha256sum "$T/dup.age" | cut -c1-64)"
expect_eq "duplicate PUT exits 0 with EXISTS" "$(receiver_put dup "$SET.age" 4096 "$DUP_SHA" "$T/dup.age")" 0
has "$T/out/dup.log" "^LCP-OFFHOST/1 EXISTS name=$SET.age$" "EXISTS reply"
expect_eq "original archive untouched" "$(sha256sum "$ROOT/published/$CUR_LABEL/$SET.age" | cut -c1-64)" "$ARC_SHA_PUB"
expect_eq "no pending left after EXISTS" "$(inc_count)" 0

echo "== 6. interrupted upload leaves no valid backup and no partial =="
mk_vault; rm -rf "${T:?}/primary/state"; mkdir -p "$T/primary/state"; : >"$T/ssh.calls"
expect_eq "cut transfer fails" "$(UPLOAD_TARGET=cut-upload send cut)" 1
has "$T/out/cut.log" "^OFFHOST_UPLOAD=FAIL reason=receiver-rejected detail=short-read,object=archive$" "short read rejected by the receiver"
expect_eq "nothing published" "$(pub_ls | wc -l)" 0
expect_eq "no partial/pending left" "$(inc_count)" 0
# receiver killed mid-transfer (no trap): the partial stays and the auditor reports it
mk_age "$T/big.age" 200000; BIG_SHA="$(sha256sum "$T/big.age" | cut -c1-64)"
mkfifo "$T/feed"; chmod 666 "$T/feed"
( as_receive env SSH_ORIGINAL_COMMAND="PUT $SET.age 200000 $BIG_SHA" OFFHOST_CONFIG="$T/offhost.env" OFFHOST_NOW="$NOW" LCP_MACHINE_ID_FILE="$T/vault.mid" LCP_HOSTKEY_DIR="$T/vk" bash "$OH/offhost-receive.sh" <"$T/feed" >/dev/null 2>&1 ) &
KP=$!
exec 7>"$T/feed"; head -c 100000 "$T/big.age" >&7
for _ in $(seq 40); do [ "$(find "$ROOT/incoming" -name '.*.partial' 2>/dev/null | wc -l)" = 1 ] && break; sleep 0.25; done
# SIGKILL the whole receiver process chain BY PID (subshell → runuser → bash → head): no EXIT trap can run
chain=(); pid="$KP"
while child="$(pgrep -P "$pid" 2>/dev/null | head -n 1)" && [ -n "$child" ]; do chain+=("$child"); pid="$child"; done
for ((i = ${#chain[@]} - 1; i >= 0; i--)); do kill -KILL "${chain[$i]}" 2>/dev/null; done
kill -KILL "$KP" 2>/dev/null; wait "$KP" 2>/dev/null; exec 7>&-; rm -f "$T/feed"
expect_eq "killed receiver leaves exactly one partial" "$(find "$ROOT/incoming" -name '.*.partial' | wc -l)" 1
audit_cmd audit-partial AUDIT >/dev/null
has "$T/out/audit-partial.log" " partial=1 partial_stale=0 " "auditor counts the fresh partial"
find "$ROOT/incoming" -name '.*.partial' -exec touch -d "@$((NOW - 30000))" {} \;
audit_cmd audit-stale AUDIT >/dev/null
has "$T/out/audit-stale.log" " partial=1 partial_stale=1 " "auditor flags it stale after OFFHOST_STALE_SECONDS"
find "$ROOT/incoming" -name '.*.partial' -delete
for _ in $(seq 40); do flock -n "$ROOT/incoming/.receive.lock" true 2>/dev/null && break; sleep 0.25; done   # the orphaned reader releases the lock when its pipe closes
expect_eq "a fresh upload still succeeds afterwards" "$(send after-cut)" 0

echo "== 7. lost manifest transfer → resume from the local stage =="
mk_vault; rm -rf "${T:?}/primary/state"; mkdir -p "$T/primary/state"
expect_eq "manifest transfer dropped → FAIL" "$(UPLOAD_TARGET=drop-manifest-upload send drop)" 1
has "$T/out/drop.log" "^OFFHOST_UPLOAD=FAIL reason=audit-generation-incomplete detail=upload=ambiguous$" "audit says incomplete, upload ambiguous"
expect_eq "stage kept for resume" "$(find "$T/primary/state/stage/$SET" -type f | wc -l)" 2
expect_eq "archive published, manifest missing" "$(pub_ls | grep -c manifest)" 0
expect_eq "resume run passes" "$(send resume)" 0
has "$T/out/resume.log" "^OFFHOST_UPLOAD=PASS .* upload=resumed audit=complete$" "PASS with upload=resumed"
expect_eq "resume issued exactly one PUT (the manifest)" "$(grep -c '	PUT ' "$T/ssh.calls")" "$(( $(grep -c '	PUT ' "$T/ssh.calls") ))"
expect_eq "published set complete after resume" "$(pub_ls | wc -l)" 5
expect_eq "stage cleared after resume" "$(find "$T/primary/state/stage" -type f 2>/dev/null | wc -l)" 0
# resume is impossible when the stage is gone: the remote archive cannot be reproduced (age is non-deterministic)
mk_vault; rm -rf "${T:?}/primary/state"; mkdir -p "$T/primary/state"
UPLOAD_TARGET=drop-manifest-upload send drop2 >/dev/null; rm -rf "${T:?}/primary/state/stage"
expect_eq "no stage → FAIL remote-generation-incomplete" "$(send nostage)" 1
has "$T/out/nostage.log" "^OFFHOST_UPLOAD=FAIL reason=remote-generation-incomplete detail=archive=present,stage=no,remote_size=[0-9]+$" "reported for the operator (retention quarantines it later)"

echo "== 8. remote audit PASS despite an ambiguous upload =="
mk_vault; rm -rf "${T:?}/primary/state"; mkdir -p "$T/primary/state"
expect_eq "manifest published but reply lost → still PASS" "$(UPLOAD_TARGET=lost-reply-upload send lost)" 0
has "$T/out/lost.log" "^OFFHOST_UPLOAD=PASS .* upload=ambiguous audit=complete$" "PASS with upload=ambiguous (audit authoritative)"
has "$T/out/lost.log" "audit verdict is authoritative" "explains the verdict"

echo "== 9. slot window and timestamps =="
mk_vault
mk_age "$T/old.age" 4096; OLD_SHA="$(sha256sum "$T/old.age" | cut -c1-64)"
expect_eq "3-slots-old object rejected" "$(receiver_put old leadcapture-20260927-031501.sql.gz.age 4096 "$OLD_SHA" "$T/old.age")" 2
has "$T/out/old.log" "^LCP-OFFHOST/1 REJECTED reason=slot-out-of-window$" "slot-out-of-window"
expect_eq "2-slots-old object accepted by the window" "$(receiver_put old2 leadcapture-20260928-031501.sql.gz.age 4096 "$OLD_SHA" "$T/old.age")" 0
expect_eq "future stamp rejected" "$(receiver_put fut leadcapture-20261001-031501.sql.gz.age 4096 "$OLD_SHA" "$T/old.age")" 2
has "$T/out/fut.log" "^LCP-OFFHOST/1 REJECTED reason=future-stamp$" "future-stamp"
expect_eq "future stamp inside the current slot (05:00:01 > now) rejected" "$(receiver_put fut2 leadcapture-20260930-050001.sql.gz.age 4096 "$OLD_SHA" "$T/old.age")" 2
has "$T/out/fut2.log" "reason=future-stamp$" "future-stamp (same slot)"
expect_eq "nothing published from the rejected objects" "$(pub_ls | grep -c 'leadcapture-2026(0927|1001|0930-050001)')" 0
mkdir -p "$T/oldonly"; cp "$T/primary/backups/postgres/leadcapture-20260928-031501.sql.gz"* "$T/oldonly/"
expect_eq "sender with only an old-slot backup fails" "$(BACKUP_DIR="$T/oldonly" env OFFHOST_NOW="$NOW" OFFHOST_SSH_BIN="$T/bin/ssh" LCP_MACHINE_ID_FILE="$T/primary.mid" LCP_HOSTKEY_DIR="$T/pk" BACKUP_DIR="$T/oldonly" OFFHOST_STATE_DIR="$T/primary/state" OFFHOST_SSH_CONFIG="$T/primary/env/ssh.config" OFFHOST_RECIPIENT="$RECIPIENT" bash "$OH/offhost-send.sh" >"$T/out/oldonly.log" 2>&1; echo $?)" 1
has "$T/out/oldonly.log" "^OFFHOST_UPLOAD=FAIL reason=current-slot-backup-missing detail=slot=$CUR_LABEL$" "current-slot-backup-missing"
mk_dump leadcapture-20261001-031501.sql.gz "$(ts '2026-10-01 03:15:03')"
send futsel >/dev/null
nothas "$T/out/futsel.log" "candidate=leadcapture-20261001" "a future-stamped local backup is never selected"
rm -f "$T/primary/backups/postgres/leadcapture-20261001-031501.sql.gz"*

echo "== 10. malformed names, injection and traversal =="
PUB_BEFORE="$(pub_ls | sha256sum)"
for c in "PUT ../x 10 $OLD_SHA" "PUT $SET.age 10 $OLD_SHA extra" "PUT $SET.age;id 10 $OLD_SHA" "PUT \$(id) 10 $OLD_SHA" "PUT $SET.age 10 $OLD_SHA
id" "ls -la" "bash" "PUT" "HELLO now"; do
  rc="$(receiver_cmd inj "$c")"
  if [ "$rc" = 2 ] && grep -qE '^LCP-OFFHOST/1 REJECTED reason=(invalid-command|invalid-name|unsupported-command)$' "$T/out/inj.log"; then ok "receiver rejects: $(printf '%q' "$c" | cut -c1-60)"; else bad "receiver rejects: $(printf '%q' "$c" | cut -c1-60)" "rc=$rc $(cat "$T/out/inj.log" | head -n 1)"; fi
done
for n in "$SET" "$SET.tar" "leadcapture-20260930-031501.sql.gz.age.receipt" "../$SET.age" "-$SET.age"; do
  rc="$(receiver_put badname "$n" 4096 "$OLD_SHA" "$T/old.age")"
  if [ "$rc" = 2 ] && grep -qE 'reason=(invalid-name|invalid-command)$' "$T/out/badname.log"; then ok "malformed object name rejected: $n"; else bad "malformed object name rejected: $n"; fi
done
expect_eq "invalid size rejected"     "$(receiver_put badsize "$SET.age" 0x10 "$OLD_SHA" "$T/old.age" >/dev/null; grep -c 'reason=invalid-size$' "$T/out/badsize.log")" 1
expect_eq "invalid checksum rejected" "$(receiver_put badsha "$SET.age" 4096 deadbeef "$T/old.age" >/dev/null; grep -c 'reason=invalid-checksum$' "$T/out/badsha.log")" 1
expect_eq "empty command rejected"    "$(receiver_cmd nocmd "" >/dev/null; grep -c 'reason=no-command$' "$T/out/nocmd.log")" 1
expect_eq "publisher: traversal name rejected" "$(publish_direct pubtrav "../$SET.age" 4096 "$OLD_SHA" >/dev/null; grep -c '^REJECTED reason=invalid-name$' "$T/out/pubtrav.log")" 1
expect_eq "publisher: wrong argument count rejected" "$(publish_direct pubargs "$SET.age" 4096 >/dev/null; grep -c '^REJECTED reason=invalid-arguments$' "$T/out/pubargs.log")" 1
expect_eq "nothing was published or left pending by the rejected requests" "$(pub_ls | sha256sum)/$(inc_count)" "$PUB_BEFORE/0"

echo "== 11. checksum, size and format validation =="
mk_vault
mk_age "$T/a.age" 4096; A_SHA="$(sha256sum "$T/a.age" | cut -c1-64)"
expect_eq "checksum mismatch rejected" "$(receiver_put csum "$SET.age" 4096 "$OLD_SHA" "$T/a.age")" 2
has "$T/out/csum.log" "reason=checksum-mismatch$" "checksum-mismatch"
expect_eq "declared size larger than the stream → short-read" "$(receiver_put short "$SET.age" 5000 "$A_SHA" "$T/a.age" >/dev/null; grep -c 'reason=short-read$' "$T/out/short.log")" 1
expect_eq "declared size smaller than the stream → size-mismatch" "$(receiver_put long "$SET.age" 4000 "$A_SHA" "$T/a.age" >/dev/null; grep -c 'reason=size-mismatch$' "$T/out/long.log")" 1
head -c 4096 /dev/urandom >"$T/notage.bin"; N_SHA="$(sha256sum "$T/notage.bin" | cut -c1-64)"
expect_eq "archive without the age header rejected" "$(receiver_put fmt "$SET.age" 4096 "$N_SHA" "$T/notage.bin" >/dev/null; grep -c 'reason=archive-format$' "$T/out/fmt.log")" 1
expect_eq "archive below the minimum size rejected" "$(receiver_put tiny "$SET.age" 10 "$A_SHA" "$T/a.age" >/dev/null; grep -c 'reason=size-out-of-range$' "$T/out/tiny.log")" 1
expect_eq "nothing published, incoming clean" "$(pub_ls | wc -l)$(inc_count)" "00"

echo "== 12. manifest validation and ordering =="
mk_vault
expect_eq "archive published for the manifest tests" "$(receiver_put m0 "$SET.age" 4096 "$A_SHA" "$T/a.age")" 0
mkman() {   # FILE ARCHIVE_SIZE ARCHIVE_SHA [SCHEMA] [SLOT]
  printf '{"schema":"%s","protocol":"LCP-OFFHOST/1","environment":"test","set":"%s","slot":"%s","slot_index":1,"created_utc":"2026-09-30T05:00:00Z","source_name":"%s","source_size":12000,"source_sha256":"%s","archive_name":"%s.age","archive_size":%s,"archive_sha256":"%s","encryption":"age/age-encryption.org/v1","recipient_fingerprint":"abcdefabcdef","sender_machine":"000000000000","destination_machine":"111111111111"}\n' \
    "${4:-lcp-offhost-manifest/3}" "$SET" "${5:-$CUR_LABEL}" "$SET" "$SRC_SHA" "$SET" "$2" "$3" >"$1"
}
mkman "$T/m-bad-schema.json" 4096 "$A_SHA" "lcp-offhost-manifest/2"; S1="$(stat -c %s "$T/m-bad-schema.json")"; H1="$(sha256sum "$T/m-bad-schema.json" | cut -c1-64)"
expect_eq "wrong manifest schema rejected" "$(receiver_put m1 "$SET.manifest.json" "$S1" "$H1" "$T/m-bad-schema.json" >/dev/null; grep -c 'reason=manifest-schema$' "$T/out/m1.log")" 1
mkman "$T/m-bad-sha.json" 4096 "$OLD_SHA"; S2="$(stat -c %s "$T/m-bad-sha.json")"; H2="$(sha256sum "$T/m-bad-sha.json" | cut -c1-64)"
expect_eq "manifest naming another archive checksum rejected" "$(receiver_put m2 "$SET.manifest.json" "$S2" "$H2" "$T/m-bad-sha.json" >/dev/null; grep -c 'reason=manifest-archive-mismatch$' "$T/out/m2.log")" 1
mkman "$T/m-bad-slot.json" 4096 "$A_SHA" "" 20260929-0315; S3="$(stat -c %s "$T/m-bad-slot.json")"; H3="$(sha256sum "$T/m-bad-slot.json" | cut -c1-64)"
expect_eq "manifest for another slot rejected" "$(receiver_put m3 "$SET.manifest.json" "$S3" "$H3" "$T/m-bad-slot.json" >/dev/null; grep -c 'reason=manifest-slot-mismatch$' "$T/out/m3.log")" 1
printf 'not json' >"$T/m-notjson"; S4=8; H4="$(sha256sum "$T/m-notjson" | cut -c1-64)"
expect_eq "non-JSON manifest rejected" "$(receiver_put m4 "$SET.manifest.json" "$S4" "$H4" "$T/m-notjson" >/dev/null; grep -c 'reason=manifest-invalid$' "$T/out/m4.log")" 1
audit_cmd m-audit AUDIT >/dev/null
has "$T/out/m-audit.log" "^generation slot=$CUR_LABEL set=$SET archive=present archive_size=4096 .* manifest=missing manifest_receipt=missing manifest_valid=no complete=no$" "archive without manifest is NOT a completed backup"
mkman "$T/m-good.json" 4096 "$A_SHA"; S5="$(stat -c %s "$T/m-good.json")"; H5="$(sha256sum "$T/m-good.json" | cut -c1-64)"
expect_eq "consistent manifest published" "$(receiver_put m5 "$SET.manifest.json" "$S5" "$H5" "$T/m-good.json")" 0
audit_cmd m-audit2 AUDIT >/dev/null
has "$T/out/m-audit2.log" "set=$SET .* complete=yes$" "generation complete once the manifest agrees with the receipt"
mk_vault
mkman "$T/m-first.json" 4096 "$A_SHA"; S6="$(stat -c %s "$T/m-first.json")"; H6="$(sha256sum "$T/m-first.json" | cut -c1-64)"
expect_eq "manifest before its archive rejected" "$(receiver_put m6 "$SET.manifest.json" "$S6" "$H6" "$T/m-first.json" >/dev/null; grep -c 'reason=archive-not-published$' "$T/out/m6.log")" 1
expect_eq "incoming clean after the manifest tests" "$(inc_count)" 0

echo "== 13. encryption failure sends nothing =="
mk_vault; rm -rf "${T:?}/primary/state"; mkdir -p "$T/primary/state"; : >"$T/ssh.calls"
expect_eq "age failure → FAIL" "$(AGE_BIN_OVERRIDE="$T/bin/age-fail" send encfail)" 1
has "$T/out/encfail.log" "^OFFHOST_UPLOAD=FAIL reason=encryption-failed$" "encryption-failed"
expect_eq "no PUT after an encryption failure" "$(grep -c '	PUT ' "$T/ssh.calls")" 0
expect_eq "no stage left behind" "$(find "$T/primary/state/stage" -type f 2>/dev/null | wc -l)" 0
expect_eq "malformed recipient refused before any network call" "$(RECIPIENT_OVERRIDE=age1notavalidrecipient send badrec >/dev/null; grep -c '^OFFHOST_UPLOAD=FAIL reason=invalid-recipient$' "$T/out/badrec.log")" 1

echo "== 14. same-host destination is refused before any byte is sent =="
: >"$T/ssh.calls"
expect_eq "same machine-id → FAIL" "$(UPLOAD_TARGET=same-machine-upload send samemid)" 1
has "$T/out/samemid.log" "^OFFHOST_UPLOAD=FAIL reason=same-host-destination detail=machine$" "same-host-destination (machine)"
expect_eq "same host key → FAIL" "$(UPLOAD_TARGET=same-hostkey-upload send samehk)" 1
has "$T/out/samehk.log" "^OFFHOST_UPLOAD=FAIL reason=same-host-destination detail=hostkey$" "same-host-destination (hostkey)"
expect_eq "unverifiable destination identity → FAIL" "$(UPLOAD_TARGET=unknown-machine-upload send unkmid)" 1
has "$T/out/unkmid.log" "^OFFHOST_UPLOAD=FAIL reason=destination-identity-unverifiable$" "destination-identity-unverifiable"
expect_eq "pinned machine mismatch → FAIL" "$(EXPECTED_MACHINE="$(printf 'c%.0s' $(seq 64))" send pinmis)" 1
has "$T/out/pinmis.log" "^OFFHOST_UPLOAD=FAIL reason=destination-identity-mismatch$" "destination-identity-mismatch"
expect_eq "no PUT in any of the refused runs" "$(grep -c '	PUT ' "$T/ssh.calls")" 0
expect_eq "pinned machine match → PASS" "$(EXPECTED_MACHINE="$(LCP_MACHINE_ID_FILE="$T/vault.mid" lcp_machine_hash)" send pinok)" 0
expect_eq "unreachable audit identity → FAIL" "$(AUDIT_TARGET=dead-audit send deadaudit >/dev/null; grep -c '^OFFHOST_UPLOAD=FAIL reason=audit-unreachable detail=phase=before$' "$T/out/deadaudit.log")" 1

echo "== 15. upload identity: forced command only, no listing/reading/deleting =="
for c in AUDIT "ls" "cat $SET.age" "rm $SET.age" "scp -f x" "sftp"; do
  rc="$(receiver_cmd up "$c")"
  if [ "$rc" = 2 ] && grep -qE 'reason=(unsupported-command|invalid-command)$' "$T/out/up.log"; then ok "upload identity cannot run: $c"; else bad "upload identity cannot run: $c"; fi
done
if [ "$ROOT_MODE" = 1 ]; then
  expect_false "upload identity cannot list published/<slot>" runuser -u lcpt-receive -- ls "$ROOT/published/$CUR_LABEL"
  expect_false "upload identity cannot read a published archive" runuser -u lcpt-receive -- cat "$ROOT/published/$CUR_LABEL/$SET.age"
  expect_false "upload identity cannot read a receipt" runuser -u lcpt-receive -- cat "$ROOT/published/$CUR_LABEL/$SET.age.receipt"
  expect_false "upload identity cannot delete a published archive" runuser -u lcpt-receive -- rm -f "$ROOT/published/$CUR_LABEL/$SET.age"
  expect_false "upload identity cannot rename a published archive" runuser -u lcpt-receive -- mv "$ROOT/published/$CUR_LABEL/$SET.age" "$ROOT/published/$CUR_LABEL/x"
  expect_false "upload identity cannot run the publisher outside sudo as root" runuser -u lcpt-receive -- test -w "$ROOT/published"
  expect_true  "…the published archive still exists" test -f "$ROOT/published/$CUR_LABEL/$SET.age"
else
  skip "file-system assertions for the upload identity (single-user mode)"
fi

echo "== 16. audit identity: list-only =="
for c in "PUT $SET.age 4096 $A_SHA" "ls" "rm x" "bash" ""; do
  rc="$(audit_cmd au "$c")"
  if [ "$rc" = 2 ] && grep -qE 'reason=(unsupported-command|no-command)$' "$T/out/au.log"; then ok "audit identity cannot run: ${c:-<empty>}"; else bad "audit identity cannot run: ${c:-<empty>}"; fi
done
expect_eq "audit HELLO answers the identity line" "$(audit_cmd auh HELLO >/dev/null; grep -cE '^LCP-OFFHOST/1 HELLO machine=[0-9a-f]{64} hostkeys=SHA256:[A-Za-z0-9+/]{43} fsid=[0-9a-f]+ root=ok$' "$T/out/auh.log")" 1
if [ "$ROOT_MODE" = 1 ]; then
  expect_true  "audit identity can list published/<slot>" runuser -u lcpt-audit -- ls "$ROOT/published/$CUR_LABEL"
  expect_true  "audit identity can read a receipt" runuser -u lcpt-audit -- cat "$ROOT/published/$CUR_LABEL/$SET.age.receipt"
  expect_false "audit identity cannot read an archive" runuser -u lcpt-audit -- cat "$ROOT/published/$CUR_LABEL/$SET.age"
  expect_false "audit identity cannot delete" runuser -u lcpt-audit -- rm -f "$ROOT/published/$CUR_LABEL/$SET.age"
  expect_false "audit identity cannot rename" runuser -u lcpt-audit -- mv "$ROOT/published/$CUR_LABEL/$SET.age" "$ROOT/published/$CUR_LABEL/y"
  expect_false "audit identity cannot write into published/<slot>" runuser -u lcpt-audit -- touch "$ROOT/published/$CUR_LABEL/z"
  expect_false "audit identity cannot write into incoming" runuser -u lcpt-audit -- touch "$ROOT/incoming/z"
else
  skip "file-system assertions for the audit identity (single-user mode)"
fi

echo "== 17. symlink and hard-link attacks against the publisher =="
mk_vault
mk_age "$T/l.age" 4096; L_SHA="$(sha256sum "$T/l.age" | cut -c1-64)"
ln -s "$T/l.age" "$ROOT/incoming/$SET.age.pending"
expect_eq "symlinked pending file rejected" "$(publish_direct sym "$SET.age" 4096 "$L_SHA" >/dev/null; grep -c '^REJECTED reason=pending-not-regular$' "$T/out/sym.log")" 1
rm -f "$ROOT/incoming/$SET.age.pending"
cp "$T/l.age" "$T/outside.age"; ln "$T/outside.age" "$ROOT/incoming/$SET.age.pending"
expect_eq "hard-linked pending file rejected" "$(publish_direct hl "$SET.age" 4096 "$L_SHA" >/dev/null; grep -c '^REJECTED reason=pending-linked$' "$T/out/hl.log")" 1
rm -f "$ROOT/incoming/$SET.age.pending" "$T/outside.age"
if [ "$ROOT_MODE" = 1 ]; then
  cp "$T/l.age" "$ROOT/incoming/$SET.age.pending"; chown root:root "$ROOT/incoming/$SET.age.pending"
  expect_eq "pending file not owned by the receive user rejected" "$(publish_direct own "$SET.age" 4096 "$L_SHA" >/dev/null; grep -c '^REJECTED reason=pending-owner$' "$T/out/own.log")" 1
  rm -f "$ROOT/incoming/$SET.age.pending"
else skip "pending-owner assertion (single-user mode)"; fi
expect_eq "nothing published by the attacks" "$(pub_ls | wc -l)" 0
mkdir -p "$T/fakeroot/incoming" "$T/fakeroot/published"
expect_eq "publisher refuses a root without the marker" "$(env OFFHOST_CONFIG=/nonexistent OFFHOST_ROOT="$T/fakeroot" OFFHOST_VAULT_USER="$VAULT_USER" OFFHOST_AUDIT_GROUP="$AUDIT_GROUP" OFFHOST_NOW="$NOW" bash "$OH/offhost-publish.sh" "$SET.age" 4096 "$L_SHA" 2>/dev/null)" "REJECTED reason=root-unavailable"

echo "== 18. temp/orphan detection =="
mk_vault; send fill >/dev/null
touch "$ROOT/incoming/leadcapture-20260929-031501.sql.gz.age.pending"; touch -d "@$((NOW - 30000))" "$ROOT/incoming/leadcapture-20260929-031501.sql.gz.age.pending"
touch "$ROOT/incoming/.x.partial"
audit_cmd orph1 AUDIT >/dev/null
has "$T/out/orph1.log" " pending=1 pending_stale=1 partial=1 partial_stale=0 orphans=0 " "stale pending and fresh partial counted"
if [ "$ROOT_MODE" = 1 ]; then runuser -u lcpt-vault -- touch "$ROOT/published/$CUR_LABEL/stray.txt" "$ROOT/published/$CUR_LABEL/.leadcapture-x.publish"; else touch "$ROOT/published/$CUR_LABEL/stray.txt" "$ROOT/published/$CUR_LABEL/.leadcapture-x.publish"; fi
mkdir "$ROOT/published/not-a-slot" 2>/dev/null || as_vault mkdir "$ROOT/published/not-a-slot"
audit_cmd orph2 AUDIT >/dev/null
has "$T/out/orph2.log" " orphans=3 " "stray file, leftover publish temp and foreign directory are orphans"
rm -f "$ROOT/incoming/"*.pending "$ROOT/incoming/.x.partial"

echo "== 19. retention: dry-run by default, protected newest, quarantine =="
mk_vault
# generations for 12 slots, published with the clock of their own slot (the window forbids old uploads otherwise)
for d in $(seq 0 11); do
  day="$(date -u -d "2026-09-30 -$d day" +%Y%m%d)"; s="leadcapture-$day-031501.sql.gz"
  echo "$(ts "$(date -u -d "2026-09-30 -$d day" +%F) 05:00:00")" >"$T/now"
  mk_age "$T/g.age" 4096; G_SHA="$(sha256sum "$T/g.age" | cut -c1-64)"
  receiver_put "gen$d" "$s.age" 4096 "$G_SHA" "$T/g.age" >/dev/null
  if [ "$d" != 9 ]; then   # slot 9 stays incomplete (no manifest)
    mkman "$T/g.json" 4096 "$G_SHA" "" "$day-0315"; sed -i "s/$SET/$s/g" "$T/g.json"; GS="$(stat -c %s "$T/g.json")"; GH="$(sha256sum "$T/g.json" | cut -c1-64)"
    receiver_put "genm$d" "$s.manifest.json" "$GS" "$GH" "$T/g.json" >/dev/null
  fi
done
echo "$NOW" >"$T/now"
expect_eq "12 generations, 11 complete" "$(audit_cmd rgen AUDIT >/dev/null; grep -oE 'generations=[0-9]+ complete=[0-9]+' "$T/out/rgen.log")" "generations=12 complete=11"
BEFORE="$(pub_ls | sha256sum)"
echo "$((NOW + 40 * 86400))" >"$T/now"   # 40 days later: everything is older than 35 days
expect_eq "dry-run exits 0" "$(retain dry)" 0
has "$T/out/dry.log" "^OFFHOST_RETAIN=DRY_RUN generations=12 kept=7 protected=7 deleted=4 quarantined=1 purged=0$" "plan: 7 newest protected, 4 old deleted, 1 incomplete quarantined"
expect_eq "dry-run changed nothing" "$(pub_ls | sha256sum)" "$BEFORE"
expect_eq "apply exits 0" "$(retain apply --apply)" 0
has "$T/out/apply.log" "^OFFHOST_RETAIN=APPLIED generations=12 kept=7 protected=7 deleted=4 quarantined=1 purged=0$" "applied the same plan"
expect_eq "7 complete generations remain" "$(audit_cmd rgen2 AUDIT >/dev/null; grep -oE 'generations=[0-9]+ complete=[0-9]+' "$T/out/rgen2.log")" "generations=7 complete=7"
expect_eq "the incomplete generation is in quarantine" "$(find "$ROOT/quarantine" -type f | wc -l)" 2
expect_eq "newest generation kept" "$(pub_ls | grep -c "^$CUR_LABEL/")" 4
echo "$((NOW + 80 * 86400))" >"$T/now"
retain purge --apply >/dev/null
has "$T/out/purge.log" " purged=2$" "quarantined files purged after the retention window"
expect_eq "still 7 protected generations after 80 days" "$(grep -oE 'protected=[0-9]+' "$T/out/purge.log")" "protected=7"
echo "$NOW" >"$T/now"
expect_eq "retention refuses a root without the marker" "$(OFFHOST_CONFIG=/nonexistent OFFHOST_ROOT="$T/fakeroot" OFFHOST_NOW="$NOW" bash "$OH/offhost-retain.sh" --apply 2>/dev/null)" "OFFHOST_RETAIN=FAIL reason=root-unavailable"
expect_eq "retention refuses a symlinked root" "$(OFFHOST_CONFIG=/nonexistent OFFHOST_ROOT="$T/rootlink" OFFHOST_NOW="$NOW" bash "$OH/offhost-retain.sh" --apply 2>/dev/null)" "OFFHOST_RETAIN=FAIL reason=root-unavailable"
expect_eq "retention refuses a top-level root" "$(OFFHOST_CONFIG=/nonexistent OFFHOST_ROOT=/tmp OFFHOST_NOW="$NOW" bash "$OH/offhost-retain.sh" --apply 2>/dev/null)" "OFFHOST_RETAIN=FAIL reason=config-invalid"
expect_eq "retention refuses unknown flags" "$(OFFHOST_CONFIG=/nonexistent OFFHOST_ROOT="$ROOT" OFFHOST_NOW="$NOW" bash "$OH/offhost-retain.sh" --force 2>/dev/null)" "OFFHOST_RETAIN=FAIL reason=usage"
expect_eq "fake root untouched" "$(find "$T/fakeroot" | wc -l)" 3

echo "== 20. configuration hygiene =="
printf 'OFFHOST_ROOT=%s\nOFFHOST_STORAGE_ENDPOINT=https://x\n' "$ROOT" >"$T/bad.env"
expect_eq "unknown config key refused" "$(OFFHOST_CONFIG="$T/bad.env" SSH_ORIGINAL_COMMAND=HELLO bash "$OH/offhost-audit.sh" 2>/dev/null)" "LCP-OFFHOST/1 REJECTED reason=config-invalid"
printf 'OFFHOST_ROOT=%s\n' "$ROOT" >"$T/send.env"; chmod 644 "$T/send.env"
expect_eq "sender config must be mode 600/400" "$(OFFHOST_SEND_CONFIG="$T/send.env" bash "$OH/offhost-send.sh" plan 2>/dev/null)" "OFFHOST_UPLOAD=FAIL reason=config-mode detail=mode=644"
printf 'OFFHOST_NOW=1\n' >"$T/send2.env"; chmod 600 "$T/send2.env"
expect_eq "test hooks are not config keys" "$(OFFHOST_SEND_CONFIG="$T/send2.env" bash "$OH/offhost-send.sh" plan 2>/dev/null)" "OFFHOST_UPLOAD=FAIL reason=config-invalid"
expect_eq "state dir inside the backup dir refused" "$(OFFHOST_STATE_DIR="$T/primary/backups/postgres/state" env OFFHOST_STATE_DIR="$T/primary/backups/postgres/state" BACKUP_DIR="$T/primary/backups/postgres" bash "$OH/offhost-send.sh" plan 2>/dev/null)" "OFFHOST_UPLOAD=FAIL reason=state-dir-inside-backup-dir"
expect_eq "upload and audit targets must differ" "$(env BACKUP_DIR="$T/primary/backups/postgres" OFFHOST_STATE_DIR="$T/primary/state" OFFHOST_UPLOAD_TARGET=same OFFHOST_AUDIT_TARGET=same bash "$OH/offhost-send.sh" plan 2>/dev/null)" "OFFHOST_UPLOAD=FAIL reason=upload-and-audit-target-identical"

echo "== 21. static: no cloud-storage provider assumptions in the scripts =="
code() { grep -vE '^[[:space:]]*#' "$@"; }
for term in 'storage\.googleapis' 'gserviceaccount' 'workloadIdentity' 'sts\.googleapis' 'iamcredentials' 'gcloud' 'GOOGLE_' 'ifGenerationMatch' 'me-central2' 'CNTXT' 'gsutil' 'OFFHOST_BUCKET' 'x-goog'; do
  if code "$OH"/*.sh "$OH"/*.example | grep -qiE -- "$term"; then bad "no reference to '$term' in the off-host scripts"; else ok "no reference to '$term' in the off-host scripts"; fi
done
expect_eq "sender pins the ssh channel (BatchMode, StrictHostKeyChecking, IdentitiesOnly)" "$(code "$OH/offhost-send.sh" | grep -c 'BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes')" 1
expect_eq "no ssh-keyscan anywhere" "$(code "$OH"/*.sh "$OH"/*.example | grep -c 'ssh-keyscan')" 0
expect_eq "authorized_keys example uses restrict + forced command for both identities" "$(grep -cE '^restrict,command="/opt/lcp-offhost/bin/offhost-(receive|audit)\.sh" ssh-ed25519 <' "$OH/authorized_keys.example")" 2
expect_eq "no private key material in the examples" "$(cat "$OH"/*.example | grep -cE 'AGE-SECRET-KEY|PRIVATE KEY')" 0

echo "== 22. leak scan over every captured output =="
cat "$T/out"/*.log >"$T/all-output.txt"
nothas "$T/all-output.txt" "AGE-SECRET-KEY" "no age private key in any output"
nothas "$T/all-output.txt" "$SECRET_KEY" "the generated secret key never appears"
nothas "$T/all-output.txt" "$CANARY" "no dump row in any output"
nothas "$T/all-output.txt" "PostgreSQL database dump" "no dump text in any output"
sed -E 's/machine=[0-9a-f]{64}/machine=<hash>/g' "$T/all-output.txt" >"$T/all-output-nomachine.txt"   # the machine hash is a sha256 of the machine-id, not a data checksum
nothas "$T/all-output-nomachine.txt" "[0-9a-f]{64}" "no complete checksum in any output (machine-id hash excluded)"
nothas "$T/all-output.txt" "$T" "no unrestricted path in any output"
nothas "$T/all-output.txt" "$(tr -d '\n' <"$T/vault.mid")" "no raw machine-id in any output"
expect_eq "PUT commands carry the checksum only over the ssh channel, never in output" "$(grep -c "PUT $SET.age [0-9]* [0-9a-f]\{64\}" "$T/all-output.txt")" 0

echo
echo "identity mode: $([ "$ROOT_MODE" = 1 ] && echo 'separate users' || echo 'single user')"
echo "passed=$PASSED failed=$FAILED skipped=$SKIPPED"
[ "$FAILED" = 0 ]
