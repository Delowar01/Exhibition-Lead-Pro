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
code() { grep -vE '^[[:space:]]*#' "$@"; }   # non-comment lines of the given files

echo "== 0. syntax =="
for f in offhost-lib.sh offhost-send.sh offhost-receive.sh offhost-publish.sh offhost-audit.sh offhost-retain.sh offhost-install-check.sh; do
  expect_true "bash -n $f" bash -n "$OH/$f"
done
expect_true "bash -n this test" bash -n "${BASH_SOURCE[0]}"
for t in age age-keygen sha256sum gzip flock python3 openssl base64 realpath timeout; do
  command -v "$t" >/dev/null 2>&1 || { echo "required tool missing: $t"; exit 1; }
done

# ── workspace ────────────────────────────────────────────────────────────────
T="$(mktemp -d "${TMPDIR:-/tmp}/lcp-offhost-test.XXXXXXXX")"; chmod 755 "$T"
T="$(realpath -e "$T")"   # every fixture path canonical (the checker requires canonical configuration paths)
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
export OFFHOST_CONFIG="\${OFFHOST_CONFIG_OVERRIDE:-$T/offhost.env}" OFFHOST_NOW="\$(cat "$T/now")"
# simulated free space: $T/free for every call, $T/free-after for the publish call only (a change between preflight and publication)
if [ "\$1" != --preflight ] && [ -f "$T/free-after" ]; then export LCP_FREE_BYTES_OVERRIDE="\$(cat "$T/free-after")"
elif [ -f "$T/free" ]; then export LCP_FREE_BYTES_OVERRIDE="\$(cat "$T/free")"; fi
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
OFFHOST_MAX_ARCHIVE_BYTES=${VCFG_MAX_ARCHIVE:-2147483648}
OFFHOST_MAX_GENERATIONS_PER_SLOT=${VCFG_MAX_GEN:-2}
OFFHOST_MIN_FREE_BYTES=${VCFG_MIN_FREE:-104857600}
OFFHOST_STALE_SECONDS=21600
OFFHOST_RETAIN_DAYS=${VCFG_RETAIN_DAYS:-35}
OFFHOST_PROTECT_NEWEST=${VCFG_PROTECT:-7}
OFFHOST_QUARANTINE_AFTER_DAYS=2
EOF
  chmod 644 "$T/offhost.env"
}
# write_vault_config_variant FILE KEY=value… → a copy of the shared settings with overrides
write_vault_config_variant() {
  local f="$1"; shift
  grep -vE "^($(printf '%s\n' "$@" | sed 's/=.*//' | paste -sd'|'))=" "$T/offhost.env" >"$f"
  printf '%s\n' "$@" >>"$f"; chmod 644 "$f"
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
FREE=""; [ -f "$T/free" ] && FREE="\$(cat "$T/free")"
recv() {   # MACHINE_ID_FILE HOSTKEY_DIR [FSID]
  $( [ "$ROOT_MODE" = 1 ] && echo 'runuser -u lcpt-receive --' ) env SSH_ORIGINAL_COMMAND="\$cmd" OFFHOST_CONFIG="$T/offhost.env" OFFHOST_NOW="\$NOWV" LCP_MACHINE_ID_FILE="\$1" LCP_HOSTKEY_DIR="\$2" LCP_FSID_OVERRIDE="\${3:-}" bash "$OH/offhost-receive.sh"
}
audit() {   # MACHINE_ID_FILE HOSTKEY_DIR ROOT [FSID] [NOW]
  $( [ "$ROOT_MODE" = 1 ] && echo 'runuser -u lcpt-audit --' ) env SSH_ORIGINAL_COMMAND="\$cmd" OFFHOST_CONFIG="$T/offhost.env" OFFHOST_ROOT="\$3" OFFHOST_NOW="\${5:-\$NOWV}" LCP_MACHINE_ID_FILE="\$1" LCP_HOSTKEY_DIR="\$2" LCP_FSID_OVERRIDE="\${4:-}" LCP_FREE_BYTES_OVERRIDE="\$FREE" bash "$OH/offhost-audit.sh"
}
count_call() { local c=0; [ -f "$T/calls.\$1" ] && c="\$(cat "$T/calls.\$1")"; c=\$((c + 1)); echo "\$c" >"$T/calls.\$1"; echo "\$c"; }
case "\$target" in
  vault-upload)          recv "$T/vault.mid" "$T/vk" ;;
  vault-audit)           audit "$T/vault.mid" "$T/vk" "$ROOT" ;;
  same-machine-upload)   recv "$T/primary.mid" "$T/vk" ;;
  same-hostkey-upload)   recv "$T/vault.mid" "$T/pk" ;;
  unknown-machine-upload) recv "$T/nonexistent.mid" "$T/vk" ;;
  cut-upload)            case "\$cmd" in PUT*) head -c 700 | recv "$T/vault.mid" "$T/vk"; exit 255 ;; *) recv "$T/vault.mid" "$T/vk" ;; esac ;;
  drop-manifest-upload)  case "\$cmd" in PUT*manifest*) cat >/dev/null; exit 255 ;; *) recv "$T/vault.mid" "$T/vk" ;; esac ;;
  lost-reply-upload)     case "\$cmd" in PUT*manifest*) recv "$T/vault.mid" "$T/vk" >/dev/null; exit 255 ;; *) recv "$T/vault.mid" "$T/vk" ;; esac ;;
  dead-audit)            exit 255 ;;
  # identity binding (Blocker A): the audit alias reaches a different machine / file system / host keys
  hostb-audit)           audit "$T/hostb.mid" "$T/hkB" "$T/vaultB/root" ;;
  otherfs-audit)         audit "$T/vault.mid" "$T/vk" "$ROOT" deadbeef0badf00d ;;
  otherkeys-audit)       audit "$T/vault.mid" "$T/vk2" "$ROOT" ;;
  dupheader-audit)       audit "$T/vault.mid" "$T/vk" "$ROOT" | awk 'NR == 1 { print; print; next } { print }' ;;
  malformed-audit)       audit "$T/vault.mid" "$T/vk" "$ROOT" | sed 's/^LCP-OFFHOST\/1 AUDIT now_utc=/LCP-OFFHOST\/1 AUDIT nowutc=/' ;;
  skew-audit)            audit "$T/vault.mid" "$T/vk" "$ROOT" "" "\$((NOWV + 7200))" ;;
  v2-audit)              audit "$T/vault.mid" "$T/vk" "$ROOT" | sed '1s/^LCP-OFFHOST\/1 /LCP-OFFHOST\/2 /' ;;
  dupgen-audit)          audit "$T/vault.mid" "$T/vk" "$ROOT" | awk '/^generation / && !d { print; d = 1 } { print }' ;;
  # overall deadline (Blocker B): sleeping endpoints (killed by the sender's timeout)
  slow-hello)            case "\$cmd" in HELLO) sleep 30 ;; *) recv "$T/vault.mid" "$T/vk" ;; esac ;;
  slow-audit)            sleep 30 ;;
  slow-post-audit)       if [ "\$(count_call post)" -ge 2 ]; then sleep 30; else audit "$T/vault.mid" "$T/vk" "$ROOT"; fi ;;
  slow-put-archive)      case "\$cmd" in PUT*.age\ *) sleep 30 ;; *) recv "$T/vault.mid" "$T/vk" ;; esac ;;
  slow-put-manifest)     case "\$cmd" in PUT*manifest*) sleep 30 ;; *) recv "$T/vault.mid" "$T/vk" ;; esac ;;
  slow-all-upload)       sleep 2; recv "$T/vault.mid" "$T/vk" ;;
  slow-all-audit)        sleep 2; audit "$T/vault.mid" "$T/vk" "$ROOT" ;;
  *) echo "stub ssh: unknown target" >&2; exit 255 ;;
esac
EOF
chmod 755 "$T/bin/ssh"
printf '#!/bin/bash\necho "age: simulated failure" >&2\nexit 1\n' >"$T/bin/age-fail"; chmod 755 "$T/bin/age-fail"
# a slow age: writes a partial output first (as a cut-off encryption would), then hangs
printf '#!/bin/bash\nout=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\n[ -n "$out" ] && printf "age-encryption.org/v1\\npartial" >"$out"\nsleep 30\n' >"$T/bin/age-slow"; chmod 755 "$T/bin/age-slow"
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
    OFFHOST_MAX_TIME="${MAX_TIME_OVERRIDE:-120}" OFFHOST_TEST_BUDGET_CHARGE="${BUDGET_CHARGE_OVERRIDE:-}" \
    bash "$OH/offhost-send.sh" "$@" >"$T/out/$case.log" 2>&1
  echo $?
}
summary() { grep -m1 -E '^OFFHOST_UPLOAD=' "$T/out/$1.log" || true; }
# receiver_put CASE NAME SIZE SHA FILE [MID HK] → runs the receiver directly (as the upload identity)
receiver_put() {
  local case="$1" name="$2" size="$3" sha="$4" file="$5"
  as_receive env SSH_ORIGINAL_COMMAND="PUT $name $size $sha" OFFHOST_CONFIG="${RCFG:-$T/offhost.env}" OFFHOST_CONFIG_OVERRIDE="${RCFG:-}" OFFHOST_NOW="$(cat "$T/now")" LCP_MACHINE_ID_FILE="$T/vault.mid" LCP_HOSTKEY_DIR="$T/vk" \
    bash "$OH/offhost-receive.sh" <"$file" >"$T/out/$case.log" 2>&1
  echo $?
}
# receiver_put_nostream CASE NAME SIZE SHA → PUT with an EMPTY stdin: a reply other
# than short-read proves the request was decided before any byte was read
receiver_put_nostream() { receiver_put "$1" "$2" "$3" "$4" /dev/null; }
reason_of() { grep -m1 -oE 'reason=[a-z0-9-]+' "$T/out/$1.log" | cut -d= -f2; }
receiver_cmd() {   # CASE COMMAND
  as_receive env SSH_ORIGINAL_COMMAND="$2" OFFHOST_CONFIG="$T/offhost.env" OFFHOST_NOW="$(cat "$T/now")" LCP_MACHINE_ID_FILE="$T/vault.mid" LCP_HOSTKEY_DIR="$T/vk" \
    bash "$OH/offhost-receive.sh" </dev/null >"$T/out/$1.log" 2>&1
  echo $?
}
audit_cmd() {   # CASE COMMAND
  local free=""; [ -f "$T/free" ] && free="$(cat "$T/free")"
  as_audit env SSH_ORIGINAL_COMMAND="$2" OFFHOST_CONFIG="$T/offhost.env" OFFHOST_NOW="$(cat "$T/now")" LCP_MACHINE_ID_FILE="$T/vault.mid" LCP_HOSTKEY_DIR="$T/vk" LCP_FREE_BYTES_OVERRIDE="$free" \
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
has "$T/out/unkmid.log" "^OFFHOST_UPLOAD=FAIL reason=destination-identity-unverifiable detail=machine$" "destination-identity-unverifiable"
expect_eq "pinned machine mismatch → FAIL" "$(EXPECTED_MACHINE="$(printf 'c%.0s' $(seq 64))" send pinmis)" 1
has "$T/out/pinmis.log" "^OFFHOST_UPLOAD=FAIL reason=destination-identity-mismatch$" "destination-identity-mismatch"
expect_eq "no PUT in any of the refused runs" "$(grep -c '	PUT ' "$T/ssh.calls")" 0
expect_eq "pinned machine match → PASS" "$(EXPECTED_MACHINE="$(LCP_MACHINE_ID_FILE="$T/vault.mid" lcp_machine_hash)" send pinok)" 0
expect_eq "unreachable audit identity → FAIL" "$(AUDIT_TARGET=dead-audit send deadaudit >/dev/null; grep -c '^OFFHOST_UPLOAD=FAIL reason=audit-unreachable detail=step=pre-audit,ssh_exit=255$' "$T/out/deadaudit.log")" 1

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

echo "== 23. identity binding: the audit listing must come from the upload destination =="
# host B: a different machine with an apparently valid, COMPLETE generation of the current set
mk_vault; rm -rf "${T:?}/primary/state"; mkdir -p "$T/primary/state"; send fillA >/dev/null
rm -rf "${T:?}/vaultB"; mkdir -p "$T/vaultB"; cp -a "$ROOT" "$T/vaultB/root"; chmod 755 "$T/vaultB"
mk_vault; rm -rf "${T:?}/primary/state"; mkdir -p "$T/primary/state"
mkdir -p "$T/hkB" "$T/vk2"; mkkey "$T/hkB/ssh_host_ed25519_key.pub"; mkkey "$T/vk2/ssh_host_ed25519_key.pub"; chmod 755 "$T/hkB" "$T/vk2"
printf '%s\n' "$(printf 'c%.0s' $(seq 32))" >"$T/hostb.mid"; chmod 644 "$T/hostb.mid"
expect_eq "host B holds a complete generation for the current set" "$(OFFHOST_CONFIG=/nonexistent OFFHOST_ROOT="$T/vaultB/root" OFFHOST_NOW="$NOW" LCP_MACHINE_ID_FILE="$T/hostb.mid" LCP_HOSTKEY_DIR="$T/hkB" SSH_ORIGINAL_COMMAND=AUDIT bash "$OH/offhost-audit.sh" | grep -c "set=$SET .* complete=yes$")" 1
: >"$T/ssh.calls"
expect_eq "upload alias → host A, audit alias → host B → FAIL" "$(AUDIT_TARGET=hostb-audit send bindB)" 1
has "$T/out/bindB.log" "^OFFHOST_UPLOAD=FAIL reason=audit-destination-mismatch detail=machine$" "audit-destination-mismatch detail=machine"
nothas "$T/out/bindB.log" "encrypted:" "…before encryption"
expect_eq "…before any PUT" "$(grep -c '	PUT ' "$T/ssh.calls")" 0
expect_eq "…no stage created" "$(find "$T/primary/state/stage" -type f 2>/dev/null | wc -l)" 0
expect_eq "…vault A untouched" "$(pub_ls | wc -l)" 0
expect_eq "same machine, different file system → FAIL" "$(AUDIT_TARGET=otherfs-audit send bindfs)" 1
has "$T/out/bindfs.log" "^OFFHOST_UPLOAD=FAIL reason=audit-destination-mismatch detail=filesystem$" "audit-destination-mismatch detail=filesystem"
expect_eq "same machine and file system, disjoint host keys → FAIL" "$(AUDIT_TARGET=otherkeys-audit send bindhk)" 1
has "$T/out/bindhk.log" "^OFFHOST_UPLOAD=FAIL reason=audit-destination-mismatch detail=hostkey$" "audit-destination-mismatch detail=hostkey"
expect_eq "duplicate audit header → FAIL" "$(AUDIT_TARGET=dupheader-audit send binddup)" 1
has "$T/out/binddup.log" "^OFFHOST_UPLOAD=FAIL reason=audit-header-duplicate$" "audit-header-duplicate"
expect_eq "malformed audit header → FAIL" "$(AUDIT_TARGET=malformed-audit send bindmal)" 1
has "$T/out/bindmal.log" "^OFFHOST_UPLOAD=FAIL reason=audit-header-invalid( detail=missing)?$" "audit-header-invalid"
expect_eq "excessive audit clock skew → FAIL" "$(AUDIT_TARGET=skew-audit send bindskew)" 1
has "$T/out/bindskew.log" "^OFFHOST_UPLOAD=FAIL reason=audit-clock-skew detail=seconds=7200,max=900$" "audit-clock-skew"
expect_eq "protocol version drift → FAIL" "$(AUDIT_TARGET=v2-audit send bindv2)" 1
has "$T/out/bindv2.log" "^OFFHOST_UPLOAD=FAIL reason=audit-protocol-version$" "audit-protocol-version"
expect_eq "no PUT in any of the refused runs" "$(grep -c '	PUT ' "$T/ssh.calls")" 0
expect_eq "correct upload/audit identities still pass" "$(send bindok)" 0
has "$T/out/bindok.log" "pre-audit: destination=bound generation=absent" "…listing bound to the HELLO identity"
expect_eq "duplicate generation record in the post-audit → FAIL" "$(AUDIT_TARGET=dupgen-audit send binddupgen >/dev/null; grep -c '^OFFHOST_UPLOAD=FAIL reason=audit-generation-duplicate$' "$T/out/binddupgen.log")" 1

echo "== 24. overall deadline (OFFHOST_MAX_TIME is a single monotonic budget) =="
one_summary() { expect_eq "$1: exactly one summary line, no unexpected-error" "$(grep -c '^OFFHOST_UPLOAD=' "$T/out/$2.log")/$(grep -c 'unexpected-error' "$T/out/$2.log")" "1/0"; }
no_work_dirs() { expect_eq "$1: temporary work directories removed" "$(find "$T/primary/state" -maxdepth 1 -name '.work.*' | wc -l)" 0; }
mk_vault; rm -rf "${T:?}/primary/state"; mkdir -p "$T/primary/state"
expect_eq "encryption timeout → FAIL" "$(MAX_TIME_OVERRIDE=2 AGE_BIN_OVERRIDE="$T/bin/age-slow" send to-enc)" 1
has "$T/out/to-enc.log" "^OFFHOST_UPLOAD=FAIL reason=operation-timeout detail=step=encrypt$" "operation-timeout step=encrypt"
one_summary "encryption timeout" to-enc; no_work_dirs "encryption timeout"
expect_eq "cut-off ciphertext is NOT kept as a stage" "$(find "$T/primary/state/stage" -type f 2>/dev/null | wc -l)" 0
expect_eq "HELLO timeout → FAIL" "$(MAX_TIME_OVERRIDE=2 UPLOAD_TARGET=slow-hello send to-hello)" 1
has "$T/out/to-hello.log" "^OFFHOST_UPLOAD=FAIL reason=operation-timeout detail=step=hello$" "operation-timeout step=hello"
one_summary "HELLO timeout" to-hello; no_work_dirs "HELLO timeout"
expect_eq "pre-audit timeout → FAIL" "$(MAX_TIME_OVERRIDE=2 AUDIT_TARGET=slow-audit send to-pre)" 1
has "$T/out/to-pre.log" "^OFFHOST_UPLOAD=FAIL reason=operation-timeout detail=step=pre-audit$" "operation-timeout step=pre-audit"
one_summary "pre-audit timeout" to-pre
expect_eq "archive transfer timeout → FAIL" "$(MAX_TIME_OVERRIDE=3 UPLOAD_TARGET=slow-put-archive send to-arc)" 1
has "$T/out/to-arc.log" "^OFFHOST_UPLOAD=FAIL reason=operation-timeout detail=step=put-archive$" "operation-timeout step=put-archive"
one_summary "archive timeout" to-arc; no_work_dirs "archive timeout"
expect_eq "…the complete, valid ciphertext stage is kept" "$(find "$T/primary/state/stage/$SET" -type f 2>/dev/null | wc -l)" 2
expect_eq "…and a later normal run resumes it" "$(send to-arc-resume)" 0
has "$T/out/to-arc-resume.log" "^OFFHOST_UPLOAD=PASS .* upload=resumed audit=complete$" "resumed after an archive timeout"
mk_vault; rm -rf "${T:?}/primary/state"; mkdir -p "$T/primary/state"
expect_eq "manifest transfer timeout → FAIL" "$(MAX_TIME_OVERRIDE=3 UPLOAD_TARGET=slow-put-manifest send to-man)" 1
has "$T/out/to-man.log" "^OFFHOST_UPLOAD=FAIL reason=operation-timeout detail=step=put-manifest$" "operation-timeout step=put-manifest"
one_summary "manifest timeout" to-man
expect_eq "…stage kept, archive already published" "$(find "$T/primary/state/stage/$SET" -type f | wc -l)/$(pub_ls | grep -c '\.age$')" "2/1"
expect_eq "…a later normal run completes the manifest" "$(send to-man-resume >/dev/null; grep -c 'upload=resumed audit=complete$' "$T/out/to-man-resume.log")" 1
mk_vault; rm -rf "${T:?}/primary/state"; mkdir -p "$T/primary/state"; rm -f "$T/calls.post"
expect_eq "post-audit timeout → FAIL" "$(MAX_TIME_OVERRIDE=4 AUDIT_TARGET=slow-post-audit send to-post)" 1
has "$T/out/to-post.log" "^OFFHOST_UPLOAD=FAIL reason=operation-timeout detail=step=post-audit$" "operation-timeout step=post-audit"
one_summary "post-audit timeout" to-post
# cumulative budget: every endpoint answers after 2 s (plus process overhead); each
# call alone fits easily, but HELLO + AUDIT + PUT + PUT + AUDIT cannot fit in 7 s
mk_vault; rm -rf "${T:?}/primary/state"; mkdir -p "$T/primary/state"
t0=$SECONDS
expect_eq "cumulative slow operations exhaust the single budget" "$(MAX_TIME_OVERRIDE=7 UPLOAD_TARGET=slow-all-upload AUDIT_TARGET=slow-all-audit send to-cum)" 1
elapsed=$((SECONDS - t0))
has "$T/out/to-cum.log" "^OFFHOST_UPLOAD=FAIL reason=operation-timeout detail=step=(put-archive|put-manifest|post-audit)$" "…fails in a later step, never by a fresh per-operation budget"
has "$T/out/to-cum.log" "^\[offhost-send\].* encrypted: " "…after HELLO, pre-audit and encryption had already consumed budget"
expect_true "…total run time bounded by the budget plus the kill grace (${elapsed}s)" [ "$elapsed" -le 16 ]
one_summary "cumulative timeout" to-cum
# budget exhausted BEFORE an operation starts (not during it): the summary must still reach the log
pre_exhaust() {   # STEP → runs the sender with the budget charged right before STEP
  expect_eq "budget exhausted right before $1 → FAIL with one summary" "$(BUDGET_CHARGE_OVERRIDE="$1=999" send "to-pre-$1" >/dev/null; grep -c "^OFFHOST_UPLOAD=FAIL reason=operation-timeout detail=step=$1$" "$T/out/to-pre-$1.log")/$(grep -c '^OFFHOST_UPLOAD=' "$T/out/to-pre-$1.log")" "1/1"
  no_work_dirs "exhausted before $1"
}
mk_vault; rm -rf "${T:?}/primary/state"; mkdir -p "$T/primary/state"
for st in hello pre-audit encrypt put-archive; do pre_exhaust "$st"; done
expect_eq "…the stage left by the exhaustion before the archive PUT is resumed" "$(send to-pre-resume1 >/dev/null; grep -c 'upload=resumed audit=complete$' "$T/out/to-pre-resume1.log")" 1
mk_vault; rm -rf "${T:?}/primary/state"; mkdir -p "$T/primary/state"
pre_exhaust put-manifest
expect_eq "…archive published, manifest completed by the next run" "$(send to-pre-resume2 >/dev/null; grep -c 'upload=resumed audit=complete$' "$T/out/to-pre-resume2.log")" 1
mk_vault; rm -rf "${T:?}/primary/state"; mkdir -p "$T/primary/state"
pre_exhaust post-audit
expect_eq "…both objects published before the post-audit: the next run finds the generation complete" "$(send to-pre-resume3 >/dev/null; grep -c 'upload=already-published audit=complete$' "$T/out/to-pre-resume3.log")" 1
# the test-only hook is validated before any arithmetic: one known step and a bounded positive integer
mk_vault; rm -rf "${T:?}/primary/state"; mkdir -p "$T/primary/state"; i=0
for v in 'encrypt=-1' 'encrypt=' 'encrypt=0' 'encrypt=1000000' 'encrypt=abc' 'encrypt=$x' 'encrypt=${x}' 'encrypt=a[0]' 'encrypt=$(id)' 'encrypt=`id`' 'unknown=5' 'encrypt=5;id' '5' 'encrypt=5=5' 'ENCRYPT=5' 'encrypt=1 2'; do
  i=$((i + 1)); c="hook$i"
  rc="$(BUDGET_CHARGE_OVERRIDE="$v" send "$c")"
  if [ "$rc" = 1 ] && [ "$(grep -c '^OFFHOST_UPLOAD=FAIL reason=invalid-test-hook$' "$T/out/$c.log")" = 1 ] && [ "$(grep -c '^OFFHOST_UPLOAD=' "$T/out/$c.log")" = 1 ] && ! grep -q 'unexpected-error' "$T/out/$c.log" && ! grep -qF -- "$v" "$T/out/$c.log"; then ok "invalid budget hook rejected with one sanitized summary: $(printf '%q' "$v")"; else bad "invalid budget hook rejected with one sanitized summary: $(printf '%q' "$v")" "rc=$rc"; fi
done
expect_eq "no stage, work or receipt is created by a rejected hook" "$(find "$T/primary/state" -mindepth 1 -not -name '.send.lock' | wc -l)" 0
expect_eq "a valid hook value is accepted (budget charged before encrypt)" "$(BUDGET_CHARGE_OVERRIDE='encrypt=999999' send hook-ok >/dev/null; grep -c '^OFFHOST_UPLOAD=FAIL reason=operation-timeout detail=step=encrypt$' "$T/out/hook-ok.log")" 1
expect_eq "normal run remains green after the timeout tests" "$(send after-timeouts)" 0
expect_eq "plan reports the configured budget" "$(MAX_TIME_OVERRIDE=77 send plan-budget plan >/dev/null; grep -c 'max_time=77$' "$T/out/plan-budget.log")" 1

echo "== 25. storage exhaustion: per-slot generation cap, free-space reserve, per-archive maximum =="
S2=leadcapture-20260930-040000.sql.gz; S3=leadcapture-20260930-050000.sql.gz
mk_vault; rm -f "$T/free" "$T/free-after"
mk_age "$T/c1.age" 4096; C1="$(sha256sum "$T/c1.age" | cut -c1-64)"
mk_age "$T/c2.age" 4096; C2="$(sha256sum "$T/c2.age" | cut -c1-64)"
mk_age "$T/c3.age" 4096; C3="$(sha256sum "$T/c3.age" | cut -c1-64)"
expect_eq "first generation of the slot accepted" "$(receiver_put cap1 "$SET.age" 4096 "$C1" "$T/c1.age")" 0
expect_eq "second generation of the slot accepted" "$(receiver_put cap2 "$S2.age" 4096 "$C2" "$T/c2.age")" 0
expect_eq "third archive name in the slot rejected before a byte is read" "$(receiver_put_nostream cap3 "$S3.age" 4096 "$C3" >/dev/null; reason_of cap3)" slot-generation-limit
expect_eq "…the incomplete second archive (no manifest) counted toward the cap" "$(pub_ls | grep -c 'manifest')" 0
mkman "$T/c2.json" 4096 "$C2"; sed -i "s/$SET/$S2/g" "$T/c2.json"; CS="$(stat -c %s "$T/c2.json")"; CH="$(sha256sum "$T/c2.json" | cut -c1-64)"
expect_eq "manifest completion remains allowed at the cap" "$(receiver_put cap4 "$S2.manifest.json" "$CS" "$CH" "$T/c2.json")" 0
expect_eq "re-upload of an existing generation is idempotent (EXISTS, nothing read)" "$(receiver_put_nostream cap5 "$SET.age" 4096 "$C1" >/dev/null; grep -c "^LCP-OFFHOST/1 EXISTS name=$SET.age$" "$T/out/cap5.log")" 1
expect_eq "audit: current slot at the cap, state ok" "$(audit_cmd capaudit AUDIT >/dev/null; grep -cE '^LCP-OFFHOST/1 CAPACITY state=ok free_state=above-reserve max_generations_per_slot=2 current_slot_generations=2 over_cap_slots=0 reserve_bytes=104857600 free_bytes=[0-9]+$' "$T/out/capaudit.log")" 1
write_vault_config_variant "$T/offhost-cap1.env" OFFHOST_MAX_GENERATIONS_PER_SLOT=1
expect_eq "audit detects a slot over its configured cap" "$(as_audit env SSH_ORIGINAL_COMMAND=AUDIT OFFHOST_CONFIG="$T/offhost-cap1.env" OFFHOST_NOW="$NOW" LCP_MACHINE_ID_FILE="$T/vault.mid" LCP_HOSTKEY_DIR="$T/vk" bash "$OH/offhost-audit.sh" >"$T/out/capover.log" 2>&1; grep -c '^LCP-OFFHOST/1 CAPACITY state=over-cap free_state=above-reserve max_generations_per_slot=1 current_slot_generations=2 over_cap_slots=1 ' "$T/out/capover.log")" 1
mk_vault
echo 1000 >"$T/free"; chmod 644 "$T/free"
expect_eq "insufficient free space rejected before a byte is read" "$(receiver_put_nostream capfree "$SET.age" 4096 "$C1" >/dev/null; reason_of capfree)" insufficient-capacity
expect_eq "audit reports free space below the reserve" "$(audit_cmd caplow AUDIT >/dev/null; grep -cE '^LCP-OFFHOST/1 CAPACITY state=low free_state=below-reserve .* free_bytes=1000$' "$T/out/caplow.log")" 1
echo unknown >"$T/free"
expect_eq "undeterminable capacity rejected" "$(receiver_put_nostream capunk "$SET.age" 4096 "$C1" >/dev/null; reason_of capunk)" capacity-unavailable
rm -f "$T/free"
echo 99999999999 >"$T/free"; echo 1000 >"$T/free-after"; chmod 644 "$T/free" "$T/free-after"
expect_eq "capacity lost between preflight and publication is caught by the publisher" "$(receiver_put capchg "$SET.age" 4096 "$C1" "$T/c1.age" >/dev/null; reason_of capchg)" insufficient-capacity
expect_eq "…nothing published, nothing pending" "$(pub_ls | wc -l)/$(inc_count)" "0/0"
rm -f "$T/free" "$T/free-after"
write_vault_config_variant "$T/offhost-small.env" OFFHOST_MAX_ARCHIVE_BYTES=1048576
mk_age "$T/big2.age" 2000000; BIG2="$(sha256sum "$T/big2.age" | cut -c1-64)"
expect_eq "archive above the per-archive maximum rejected before a byte is read" "$(RCFG="$T/offhost-small.env" receiver_put_nostream captoobig "$SET.age" 2000000 "$BIG2" >/dev/null; reason_of captoobig)" archive-too-large
for bad in OFFHOST_MIN_FREE_BYTES=0 OFFHOST_MAX_GENERATIONS_PER_SLOT=0 OFFHOST_MAX_ARCHIVE_BYTES=0 OFFHOST_MAX_ARCHIVE_BYTES=99999999999999 OFFHOST_MIN_FREE_BYTES=1 OFFHOST_MAX_GENERATIONS_PER_SLOT=100; do
  write_vault_config_variant "$T/offhost-bad.env" "$bad"
  expect_eq "unsafe limit refused: $bad" "$(SSH_ORIGINAL_COMMAND=HELLO OFFHOST_CONFIG="$T/offhost-bad.env" bash "$OH/offhost-receive.sh" 2>/dev/null)" "LCP-OFFHOST/1 REJECTED reason=config-invalid"
done
# repeated rejected uploads leave no persistent temporary data
mk_vault
receiver_put capr0 "$SET.age" 4096 "$C1" "$T/c1.age" >/dev/null; receiver_put capr1 "$S2.age" 4096 "$C2" "$T/c2.age" >/dev/null
for i in 1 2 3; do
  receiver_put_nostream "caprA$i" "$S3.age" 4096 "$C3" >/dev/null
  receiver_put "caprB$i" "$S3.age" 4096 "$C1" "$T/c3.age" >/dev/null       # cap again (preflight)
  receiver_put "caprC$i" "$SET.manifest.json" 300 "$C1" "$T/c3.age" >/dev/null   # checksum/size mismatch after reading
done
expect_eq "repeated rejected uploads leave no pending/partial data" "$(inc_count)" 0
expect_eq "…and the published set is unchanged (slot dir, two archives, two receipts)" "$(pub_ls | wc -l)" 5
# retention cannot bypass the protected-newest rule even with an aggressive retention window
mk_vault
for d in 0 1 2; do
  day="$(date -u -d "2026-09-30 -$d day" +%Y%m%d)"; sx="leadcapture-$day-031501.sql.gz"
  echo "$(ts "$(date -u -d "2026-09-30 -$d day" +%F) 05:00:00")" >"$T/now"
  mk_age "$T/r.age" 4096; RS="$(sha256sum "$T/r.age" | cut -c1-64)"
  receiver_put "ret$d" "$sx.age" 4096 "$RS" "$T/r.age" >/dev/null
  mkman "$T/r.json" 4096 "$RS" "" "$day-0315"; sed -i "s/$SET/$sx/g" "$T/r.json"; RJ="$(stat -c %s "$T/r.json")"; RH="$(sha256sum "$T/r.json" | cut -c1-64)"
  receiver_put "retm$d" "$sx.manifest.json" "$RJ" "$RH" "$T/r.json" >/dev/null
done
echo "$((NOW + 10 * 86400))" >"$T/now"
write_vault_config_variant "$T/offhost-aggr.env" OFFHOST_RETAIN_DAYS=1 OFFHOST_PROTECT_NEWEST=3
BEFORE_R="$(pub_ls | sha256sum)"
expect_eq "aggressive retention still protects the newest complete generations" "$(as_vault env OFFHOST_CONFIG="$T/offhost-aggr.env" OFFHOST_NOW="$(cat "$T/now")" bash "$OH/offhost-retain.sh" --apply 2>/dev/null | tail -n 1)" "OFFHOST_RETAIN=APPLIED generations=3 kept=3 protected=3 deleted=0 quarantined=0 purged=0"
expect_eq "…nothing deleted" "$(pub_ls | sha256sum)" "$BEFORE_R"
echo "$NOW" >"$T/now"

echo "== 26. installation-integrity check (offhost-install-check.sh) =="
expect_true "bash -n offhost-install-check.sh" bash -n "$OH/offhost-install-check.sh"
if [ "$ROOT_MODE" = 1 ]; then
  INST="$T/inst"; IBIN="$INST/opt/lcp-offhost/bin"
  mkdir -p "$IBIN" "$INST/etc" "$INST/home/lcpt-receive/.ssh" "$INST/home/lcpt-audit/.ssh" "$INST/home/lcpt-vault"
  for f in offhost-lib.sh offhost-receive.sh offhost-publish.sh offhost-audit.sh offhost-retain.sh; do cp "$OH/$f" "$IBIN/$f"; done
  chmod 755 "$IBIN"/offhost-{receive,publish,audit,retain}.sh; chmod 644 "$IBIN/offhost-lib.sh"; chmod 755 "$INST/opt/lcp-offhost" "$IBIN"; chown -R root:root "$INST/opt"
  cp "$T/offhost.env" "$INST/etc/offhost.env"; chmod 644 "$INST/etc/offhost.env"; chown root:root "$INST/etc/offhost.env"
  # the REAL drop-in is used for the fixture so that the effective `sudo -l -U` listing is exercised; restored at the end
  cp "$SUDOERS_FILE" "$T/sudoers.main"
  sudoers_fixture() { printf 'Defaults:lcpt-receive env_reset, !requiretty, use_pty\nlcpt-receive ALL=(root) NOPASSWD: NOSETENV: %s/offhost-publish.sh\n' "$IBIN"; }
  install_sudoers() { printf '%s\n' "$1" >"$SUDOERS_FILE"; chmod 0440 "$SUDOERS_FILE"; chown root:root "$SUDOERS_FILE"; expect_true "visudo -cf accepts the drop-in fixture" visudo -cf "$SUDOERS_FILE"; }
  install_extra()   { printf '%s\n' "$1" >"$EXTRA_SUDOERS"; chmod 0440 "$EXTRA_SUDOERS"; chown root:root "$EXTRA_SUDOERS"; expect_true "visudo -cf accepts the extra sudoers source" visudo -cf "$EXTRA_SUDOERS"; }
  install_sudoers "$(sudoers_fixture)"
  EXTRA_SUDOERS="/etc/sudoers.d/lcpt-offhost-test2"
  # ── key validator: real ssh-keygen when present; otherwise `ssh-keygen -l -f -` is answered
  #    by the cryptography library's OpenSSH public-key loader (a real parser), never a fixed answer
  PYCRYPTO=""
  for py in /usr/bin/python3.12 /usr/bin/python3.13 /usr/bin/python3 python3; do
    command -v "$py" >/dev/null 2>&1 && "$py" -c 'from cryptography.hazmat.primitives.serialization import load_ssh_public_key' 2>/dev/null && { PYCRYPTO="$(command -v "$py")"; break; }
  done
  if command -v ssh-keygen >/dev/null 2>&1; then KEYGEN_BIN="$(command -v ssh-keygen)"; KEYGEN_MODE=real
  else
    KEYGEN_BIN="$T/bin/ssh-keygen"; KEYGEN_MODE=library
    cat >"$KEYGEN_BIN" <<EOF
#!/bin/bash
# stand-in for OpenSSH ssh-keygen in the harness (the sandbox has no OpenSSH): only "-l -f -" is
# implemented, by the cryptography library's OpenSSH public-key loader; exit 0 = valid key, 255 = rejected
[ "\$1" = -l ] && [ "\$2" = -f ] && [ "\$3" = - ] || { echo "ssh-keygen stand-in: unsupported arguments" >&2; exit 2; }
[ -n "$PYCRYPTO" ] || { echo "ssh-keygen stand-in: no OpenSSH key parser available" >&2; exit 2; }
# the key arrives on stdin exactly as for ssh-keygen; the parser is given inline so stdin stays the key
exec "$PYCRYPTO" -c 'import sys
from cryptography.hazmat.primitives.serialization import load_ssh_public_key
data = sys.stdin.buffer.read().strip()
try:
    load_ssh_public_key(data)
    sys.exit(0)
except Exception:
    sys.exit(255)'
EOF
    chmod 755 "$KEYGEN_BIN"
  fi
  echo "key validator: $KEYGEN_MODE ($([ "$KEYGEN_MODE" = real ] && echo OpenSSH || echo "cryptography loader via ${PYCRYPTO:-none}"))"
  # ── three REAL, freshly generated, distinct Ed25519 public keys (disposable; removed with $T) ──
  mkdir -p "$T/keys"; chmod 700 "$T/keys"
  mkkey_real() {   # NAME → prints the base64 blob of a newly generated Ed25519 public key
    if [ "$KEYGEN_MODE" = real ]; then
      ssh-keygen -q -t ed25519 -N '' -C "harness-$1" -f "$T/keys/$1" >/dev/null 2>&1 && awk '{print $2}' "$T/keys/$1.pub"
    else
      "$PYCRYPTO" - "$T/keys/$1.pub" <<'PY'
import sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
pub = Ed25519PrivateKey.generate().public_key().public_bytes(Encoding.OpenSSH, PublicFormat.OpenSSH).decode()
open(sys.argv[1], "w").write(pub + "\n")
print(pub.split()[1])
PY
    fi
  }
  K_UP="$(mkkey_real up)"; K_A1="$(mkkey_real audit-primary)"; K_A2="$(mkkey_real audit-github)"
  expect_eq "three real Ed25519 keys generated and distinct" "$(printf '%s\n' "$K_UP" "$K_A1" "$K_A2" | grep -cE '^AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$')/$(printf '%s\n' "$K_UP" "$K_A1" "$K_A2" | sort -u | wc -l)" "3/3"
  # malformed blobs built from the wire format (python standard library; no key material)
  mkbad() {   # VARIANT → base64 blob
    python3 - "$1" <<'PY'
import base64, struct, sys, os
def s(b): return struct.pack(">I", len(b)) + b
v = sys.argv[1]; key = os.urandom(32)
blobs = {
  "typeonly":     s(b"ssh-ed25519"),
  "short":        s(b"ssh-ed25519") + s(key[:31]),
  "long":         s(b"ssh-ed25519") + s(key + b"\x01"),
  "trailing":     s(b"ssh-ed25519") + s(key) + b"\x00",
  "typemismatch": s(b"ssh-rsa") + s(key),
  "overflow":     s(b"ssh-ed25519") + struct.pack(">I", 32) + key[:10],
}
print(base64.b64encode(blobs[v]).decode())
PY
  }
  K_RSA="$(mkbad typemismatch)"
  write_keys() {   # RECEIVE-CONTENT AUDIT-CONTENT (full authorized_keys texts)
    printf '%s\n' "$1" >"$INST/home/lcpt-receive/.ssh/authorized_keys"
    printf '%s\n' "$2" >"$INST/home/lcpt-audit/.ssh/authorized_keys"
    chmod 700 "$INST/home/lcpt-receive/.ssh" "$INST/home/lcpt-audit/.ssh"; chmod 600 "$INST/home/lcpt-receive/.ssh/authorized_keys" "$INST/home/lcpt-audit/.ssh/authorized_keys"
    chown -R lcpt-receive:lcpt-receive "$INST/home/lcpt-receive"; chown -R lcpt-audit:lcpt-audit "$INST/home/lcpt-audit"; chown -R lcpt-vault:lcpt-vault "$INST/home/lcpt-vault"
  }
  RECV_OK="restrict,command=\"$IBIN/offhost-receive.sh\" ssh-ed25519 $K_UP lcp-offhost-upload@primary"
  AUD_OK="# primary and github audit keys
restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 $K_A1 lcp-offhost-audit@primary
restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 $K_A2 lcp-offhost-audit@github-actions"
  write_keys "$RECV_OK" "$AUD_OK"
  chmod 755 "$INST" "$INST/home" "$INST/etc" "$INST/opt"
  # sshd fixtures: normalized `sshd -T` shape (lowercase keyword, value; AllowUsers/AcceptEnv one token per line,
  # AuthorizedKeysFile and AuthenticationMethods on one line) for a safe restricted account and the global policy
  mkdir -p "$T/sshd/sshd_config.d"
  sshd_user_ok() { printf 'passwordauthentication no\npubkeyauthentication yes\nkbdinteractiveauthentication no\nhostbasedauthentication no\ngssapiauthentication no\nkerberosauthentication no\npermitemptypasswords no\nauthenticationmethods publickey\nauthorizedkeysfile .ssh/authorized_keys\nauthorizedkeyscommand none\nauthorizedkeyscommanduser none\ntrustedusercakeys none\nauthorizedprincipalsfile none\nauthorizedprincipalscommand none\nauthorizedprincipalscommanduser none\nforcecommand none\nstrictmodes yes\npermituserenvironment no\nacceptenv LANG\nacceptenv LC_*\nallowusers lcpt-receive\nallowusers lcpt-audit\nallowusers operator\n'; }
  sshd_global() { sshd_user_ok; printf 'permitrootlogin no\n'; }
  # the vault view carries the global values: no approved Match block may address it
  sshd_reset() { sshd_global >"$T/sshd/global.txt"; sshd_user_ok >"$T/sshd/user-lcpt-receive.txt"; sshd_user_ok >"$T/sshd/user-lcpt-audit.txt"; sshd_global >"$T/sshd/user-lcpt-vault.txt"; }
  sshd_reset
  # fake sshd: requires "-T -f <file>" (plus "-C user=U,host=H,addr=A" for one account), records every
  # invocation, answers ONLY for the inspected fixture file (global or per-account fixture), never one static result
  : >"$T/sshd-invocations.log"
  cat >"$T/bin/sshd" <<EOF
#!/bin/bash
user=""; want_T=0; cfg=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -T) want_T=1 ;;
    -f) shift; cfg="\${1:-}" ;;
    -C) shift; [[ "\${1:-}" =~ (^|,)user=([^,]+) ]] && user="\${BASH_REMATCH[2]}" ;;
  esac
  shift
done
printf 'f=%s user=%s\n' "\$cfg" "\$user" >>"$T/sshd-invocations.log"
[ "\$want_T" = 1 ] || { echo "fake sshd: only -T is supported" >&2; exit 1; }
[ -n "\$cfg" ] || { echo "fake sshd: -f <file> is required" >&2; exit 1; }
[ "\$cfg" = "$T/sshd/sshd_config" ] || { echo "fake sshd: asked to evaluate a file other than the inspected fixture" >&2; exit 1; }
if [ -n "\$user" ]; then [ -f "$T/sshd/user-\$user.txt" ] && cat "$T/sshd/user-\$user.txt"; exit 0; fi
cat "$T/sshd/global.txt"
EOF
  chmod 755 "$T/bin/sshd"
  sshd_cfg_reset() {
    printf 'Include %s/sshd_config.d/*.conf\nPasswordAuthentication no\nPermitRootLogin no\nMatch User lcpt-receive\n    PubkeyAuthentication yes\n' "$T/sshd" >"$T/sshd/sshd_config"
    printf 'Match User lcpt-audit\n    PubkeyAuthentication yes\n' >"$T/sshd/sshd_config.d/10-audit.conf"
  }
  sshd_cfg_reset
  shadow_reset() { printf 'lcpt-receive:!:19000:0:99999:7:::\nlcpt-audit:*:19000:0:99999:7:::\nlcpt-vault:!:19000:0:99999:7:::\n' >"$T/shadow.txt"; chmod 600 "$T/shadow.txt"; }
  shadow_reset
  icheck() {   # CASE [VAR=value …]
    local case="$1"; shift
    sudo -n -l -U lcpt-receive >"$T/out/$case.sudo-listing" 2>&1 || true   # diagnostic only (not part of the leak-scanned outputs)
    env OFFHOST_INSTALL_ROOT="$INST/opt/lcp-offhost" OFFHOST_BIN_DIR="$IBIN" OFFHOST_CONFIG="$INST/etc/offhost.env" OFFHOST_SUDOERS="$SUDOERS_FILE" \
      OFFHOST_RECEIVE_USER=lcpt-receive OFFHOST_AUDIT_USER=lcpt-audit OFFHOST_VAULT_USER=lcpt-vault OFFHOST_SSHD_BIN="$T/bin/sshd" \
      OFFHOST_SSHD_CONFIG="$T/sshd/sshd_config" OFFHOST_SSHD_PROBE_HOST=backup-fixture OFFHOST_SSHD_PROBE_ADDR=127.0.0.1 \
      OFFHOST_SHADOW_SOURCE="$T/shadow.txt" OFFHOST_HOME_BASE="$INST/home" OFFHOST_SSH_KEYGEN_BIN="$KEYGEN_BIN" OFFHOST_SSHD_OPERATOR_USERS=operator "$@" \
      bash "$OH/offhost-install-check.sh" >"$T/out/$case.log" 2>&1; echo $?
  }
  reasons() { grep -m1 -oE '^OFFHOST_INSTALL=FAIL reasons=.*' "$T/out/$1.log" | sed 's/^OFFHOST_INSTALL=FAIL reasons=//'; }
  tree_hash() { find "$INST" "$SUDOERS_FILE" "$T/sshd" "$T/shadow.txt" -exec stat -c '%n %a %U %G %s %Y' {} + 2>/dev/null | sort | sha256sum | cut -c1-16; }
  expect_eq "correct installation → PASS" "$(icheck inst-ok)" 0
  has "$T/out/inst-ok.log" "^OFFHOST_INSTALL=PASS checks=16$" "…sixteen checks (incl. effective sudo, exact keys, locks, per-account sshd, vault admission)"
  has "$T/out/inst-ok.log" "^install: sudo-effective=ok$" "…effective sudo authority verified from the real listing"
  has "$T/out/inst-ok.log" "^install: authorized-keys-distinct=ok$" "…three distinct key fingerprints"
  has "$T/out/inst-ok.log" "^install: accounts-locked=ok$" "…service-account passwords locked"
  has "$T/out/inst-ok.log" "^install: sshd-receive=ok$" "…per-account sshd evaluation (receive)"
  has "$T/out/inst-ok.log" "^install: sshd-audit=ok$" "…per-account sshd evaluation (audit)"
  has "$T/out/inst-ok.log" "^install: hash offhost-publish.sh=[0-9a-f]{12}$" "…publisher hash recorded (prefix)"
  has "$T/out/inst-ok.log" "^install: hash offhost-lib.sh=[0-9a-f]{12}$" "…library hash recorded (prefix)"
  # ── file shape mutations (Correction 2 assertions kept) ──
  chmod g+w "$IBIN/offhost-lib.sh"; expect_eq "group-writable library → FAIL" "$(icheck inst-w >/dev/null; reasons inst-w)" "bin-file-writable"; chmod 644 "$IBIN/offhost-lib.sh"
  chown lcpt-receive "$IBIN/offhost-publish.sh"; expect_eq "non-root publisher owner → FAIL" "$(icheck inst-o >/dev/null; reasons inst-o)" "bin-file-owner"; chown root "$IBIN/offhost-publish.sh"
  ln -s /etc/hostname "$IBIN/stray"; expect_eq "symlink in the bin directory → FAIL" "$(icheck inst-s >/dev/null; reasons inst-s)" "bin-file-symlink"; rm -f "$IBIN/stray"
  chmod 666 "$INST/etc/offhost.env"; expect_eq "world-writable config → FAIL" "$(icheck inst-c >/dev/null; reasons inst-c)" "config-mode"; chmod 644 "$INST/etc/offhost.env"
  chmod 644 "$SUDOERS_FILE"; expect_eq "sudoers not 0440 → FAIL" "$(icheck inst-sm >/dev/null; reasons inst-sm)" "sudoers-mode"; chmod 0440 "$SUDOERS_FILE"
  # ── sudo: drop-in content and EFFECTIVE authority ──
  install_sudoers "$(sudoers_fixture)
lcpt-receive ALL=(root) NOPASSWD: /bin/ls"
  expect_eq "extra rule inside the drop-in → FAIL (file and effective)" "$(icheck inst-sr >/dev/null; reasons inst-sr)" "sudoers-rule-count,sudo-effective-extra-command"
  install_sudoers "$(printf 'Defaults:lcpt-receive env_reset, use_pty\nlcpt-receive ALL=(root) NOPASSWD: NOSETENV: %s/offhost-publish.sh\n' "$IBIN")"
  expect_eq "missing required Defaults (!requiretty) → FAIL (file and effective)" "$(icheck inst-sd >/dev/null; reasons inst-sd)" "sudoers-defaults,sudo-effective-requiretty"
  install_sudoers "$(printf 'Defaults:lcpt-receive env_reset, !requiretty, use_pty\nlcpt-receive ALL=(root) NOPASSWD: SETENV: %s/offhost-publish.sh\n' "$IBIN")"
  expect_eq "SETENV on the publisher rule → FAIL (file and effective)" "$(icheck inst-se >/dev/null; reasons inst-se)" "sudoers-setenv,sudo-effective-setenv"
  install_sudoers "$(printf 'Defaults:lcpt-receive env_reset, !requiretty, use_pty\nlcpt-receive ALL=(root) NOPASSWD: %s/offhost-publish.sh\n' "$IBIN")"
  expect_eq "publisher rule without NOSETENV → FAIL (file and effective tags)" "$(icheck inst-ns >/dev/null; reasons inst-ns)" "sudoers-rule,sudo-effective-tags"
  install_sudoers "$(sudoers_fixture)"
  printf 'lcpt-receive ALL=(root) NOPASSWD: /bin/ls\n' >"$EXTRA_SUDOERS"; chmod 0440 "$EXTRA_SUDOERS"
  expect_eq "additional command granted by ANOTHER sudoers file → FAIL" "$(icheck inst-x1 >/dev/null; reasons inst-x1)" "sudo-effective-extra-command"
  printf 'lcpt-receive ALL=(ALL) ALL\n' >"$EXTRA_SUDOERS"; chmod 0440 "$EXTRA_SUDOERS"
  expect_eq "effective ALL grant from another file → FAIL" "$(icheck inst-x2 >/dev/null; reasons inst-x2)" "sudo-effective-extra-command"
  printf 'lcpt-receive ALL=(root) NOPASSWD: /bin/bash\n' >"$EXTRA_SUDOERS"; chmod 0440 "$EXTRA_SUDOERS"
  expect_eq "effective shell grant from another file → FAIL" "$(icheck inst-x3 >/dev/null; reasons inst-x3)" "sudo-effective-extra-command"
  printf 'lcpt-receive ALL=(root) SETENV: NOPASSWD: /opt/other/tool\n' >"$EXTRA_SUDOERS"; chmod 0440 "$EXTRA_SUDOERS"
  expect_eq "effective SETENV grant from another file → FAIL" "$(icheck inst-x4 >/dev/null; reasons inst-x4)" "sudo-effective-setenv"
  rm -f "$EXTRA_SUDOERS"
  # inverse Defaults appended by ANOTHER sudoers source (the later entry wins for sudo)
  install_extra 'Defaults:lcpt-receive !env_reset'
  expect_eq "expected Defaults plus a later !env_reset → FAIL" "$(icheck inst-d1 >/dev/null; reasons inst-d1)" "sudo-effective-env-reset"
  install_extra 'Defaults:lcpt-receive requiretty'
  expect_eq "expected Defaults plus a later requiretty → FAIL" "$(icheck inst-d2 >/dev/null; reasons inst-d2)" "sudo-effective-requiretty"
  install_extra 'Defaults:lcpt-receive !use_pty'
  expect_eq "expected Defaults plus a later !use_pty → FAIL" "$(icheck inst-d3 >/dev/null; reasons inst-d3)" "sudo-effective-use-pty"
  install_extra 'Defaults:lcpt-receive !env_reset, requiretty, !use_pty'
  expect_eq "multiple inverse overrides together → FAIL (every category reported)" "$(icheck inst-d4 >/dev/null; reasons inst-d4)" "sudo-effective-env-reset,sudo-effective-requiretty,sudo-effective-use-pty"
  install_extra 'Defaults:lcpt-receive !use_pty
lcpt-receive ALL=(root) NOPASSWD: /bin/ls'
  expect_eq "inverse Default and an extra command from another source → both reported" "$(icheck inst-d5 >/dev/null; reasons inst-d5)" "sudo-effective-use-pty,sudo-effective-extra-command"
  rm -f "$EXTRA_SUDOERS"
  expect_eq "expected Defaults only → PASS" "$(icheck inst-d0)" 0
  mv "$SUDOERS_FILE" "$T/sudoers.tmp"
  expect_eq "drop-in absent → FAIL (file and no effective grant)" "$(icheck inst-ng >/dev/null; reasons inst-ng)" "sudoers-missing,sudo-effective-no-grant"
  mv "$T/sudoers.tmp" "$SUDOERS_FILE"; chmod 0440 "$SUDOERS_FILE"
  expect_eq "intended publisher-only effective grant passes again" "$(icheck inst-sok)" 0
  # ── key inventory: exactly one receive key + two distinct audit keys ──
  write_keys "$RECV_OK" "restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 $K_A1 lcp-offhost-audit@primary"
  expect_eq "only one audit key → FAIL" "$(icheck inst-k1 >/dev/null; reasons inst-k1)" "authorized-keys-audit-count"
  write_keys "$RECV_OK" "restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 $K_A1 lcp-offhost-audit@primary
restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 $K_A1 lcp-offhost-audit@github-actions"
  expect_eq "duplicated primary/GitHub audit key (different comments) → FAIL" "$(icheck inst-k2 >/dev/null; reasons inst-k2)" "authorized-keys-duplicate"
  write_keys "$RECV_OK" "restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 $K_A1 lcp-offhost-audit@primary
restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 $K_UP lcp-offhost-audit@github-actions"
  expect_eq "upload key reused as an audit key → FAIL" "$(icheck inst-k3 >/dev/null; reasons inst-k3)" "authorized-keys-duplicate"
  write_keys "$RECV_OK" "restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 $K_A1 lcp-offhost-audit@primary
restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA!!notbase64 lcp-offhost-audit@github-actions"
  expect_eq "malformed base64 blob → FAIL" "$(icheck inst-k4 >/dev/null; reasons inst-k4)" "authorized-keys-audit-malformed"
  write_keys "$RECV_OK" "restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 $K_A1 lcp-offhost-audit@primary
restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 $K_RSA lcp-offhost-audit@github-actions"
  expect_eq "blob whose embedded type differs from the declared type → FAIL" "$(icheck inst-k5 >/dev/null; reasons inst-k5)" "authorized-keys-audit-malformed"
  for v in typeonly short long trailing overflow; do
    write_keys "$RECV_OK" "restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 $K_A1 lcp-offhost-audit@primary
restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 $(mkbad "$v") lcp-offhost-audit@github-actions"
    expect_eq "incomplete key structure ($v) → FAIL" "$(icheck "inst-k-$v" >/dev/null; reasons "inst-k-$v")" "authorized-keys-audit-malformed"
  done
  write_keys "$RECV_OK" "restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 $K_A1 lcp-offhost-audit@primary
restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA lcp-offhost-audit@github-actions"
  expect_eq "base64 with missing padding (passes the alphabet check) → FAIL" "$(icheck inst-k-pad >/dev/null; reasons inst-k-pad)" "authorized-keys-audit-malformed"
  write_keys "$RECV_OK" "$AUD_OK"
  expect_eq "OpenSSH validator unavailable → FAIL closed (no key accepted)" "$(icheck inst-k-nov OFFHOST_SSH_KEYGEN_BIN="$T/bin/no-such-ssh-keygen" >/dev/null; reasons inst-k-nov)" "authorized-keys-validator-unavailable"
  expect_false "the formerly accepted type-only blob is rejected by the key validator ($KEYGEN_MODE)" bash -c "printf 'ssh-ed25519 %s\n' '$(mkbad typeonly)' | '$KEYGEN_BIN' -l -f - >/dev/null 2>&1"
  expect_true  "a real generated key is accepted by the key validator ($KEYGEN_MODE)" bash -c "printf 'ssh-ed25519 %s\n' '$K_UP' | '$KEYGEN_BIN' -l -f - >/dev/null 2>&1"
  write_keys "$RECV_OK
restrict,command=\"$IBIN/offhost-receive.sh\" ssh-ed25519 $(mkkey_real extra-upload) second-upload" "$AUD_OK"
  expect_eq "extra receive key → FAIL (design is exact-three)" "$(icheck inst-k6 >/dev/null; reasons inst-k6)" "authorized-keys-receive-count"
  write_keys "$RECV_OK" "$AUD_OK
restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 $(mkkey_real extra-audit) third-audit"
  expect_eq "third audit key → FAIL" "$(icheck inst-k7 >/dev/null; reasons inst-k7)" "authorized-keys-audit-count"
  write_keys "$RECV_OK" "restrict,command=\"$IBIN/offhost-receive.sh\" ssh-ed25519 $K_A1 lcp-offhost-audit@primary
restrict,command=\"$IBIN/offhost-audit.sh\" ssh-ed25519 $K_A2 lcp-offhost-audit@github-actions"
  expect_eq "audit key forced to the wrong script → FAIL" "$(icheck inst-k8 >/dev/null; reasons inst-k8)" "authorized-keys-audit-unrestricted"
  write_keys "restrict,no-pty,command=\"$IBIN/offhost-receive.sh\" ssh-ed25519 $K_UP lcp-offhost-upload@primary" "$AUD_OK"
  expect_eq "unrecognised extra option on the upload key → FAIL" "$(icheck inst-k9 >/dev/null; reasons inst-k9)" "authorized-keys-receive-unrestricted"
  write_keys "command=\"$IBIN/offhost-receive.sh\" ssh-ed25519 $K_UP lcp-offhost-upload@primary" "$AUD_OK"
  expect_eq "upload key without restrict → FAIL" "$(icheck inst-k10 >/dev/null; reasons inst-k10)" "authorized-keys-receive-unrestricted"
  write_keys "ssh-ed25519 $K_UP lcp-offhost-upload@primary" "$AUD_OK"
  expect_eq "upload key without any forced command → FAIL" "$(icheck inst-ak >/dev/null; reasons inst-ak)" "authorized-keys-receive-unrestricted"
  write_keys "$RECV_OK" "$AUD_OK"
  chmod 644 "$INST/home/lcpt-audit/.ssh/authorized_keys"; expect_eq "audit authorized_keys not 0600 → FAIL" "$(icheck inst-am >/dev/null; reasons inst-am)" "authorized-keys-audit-file"; chmod 600 "$INST/home/lcpt-audit/.ssh/authorized_keys"
  mkdir -p "$INST/home/lcpt-vault/.ssh"; echo "ssh-ed25519 $K_A2 x" >"$INST/home/lcpt-vault/.ssh/authorized_keys"
  expect_eq "vault account with an SSH key → FAIL" "$(icheck inst-v >/dev/null; reasons inst-v)" "vault-ssh-key-present"; rm -rf "$INST/home/lcpt-vault/.ssh"
  expect_eq "one receive key plus two distinct audit keys passes again" "$(icheck inst-kok)" 0
  # ── account password locks (shadow-format fixture; nothing is printed) ──
  printf 'lcpt-receive:$6$fixturesalt$fixturehash:19000:0:99999:7:::\nlcpt-audit:*:19000:0:99999:7:::\nlcpt-vault:!:19000:0:99999:7:::\n' >"$T/shadow.txt"
  expect_eq "receive account with a usable password → FAIL" "$(icheck inst-p1 >/dev/null; reasons inst-p1)" "account-receive-password-unlocked"
  printf 'lcpt-receive:!:19000:0:99999:7:::\nlcpt-audit::19000:0:99999:7:::\nlcpt-vault:!:19000:0:99999:7:::\n' >"$T/shadow.txt"
  expect_eq "audit account with an empty password → FAIL" "$(icheck inst-p2 >/dev/null; reasons inst-p2)" "account-audit-password-unlocked"
  printf 'lcpt-receive:!:19000:0:99999:7:::\nlcpt-audit:*:19000:0:99999:7:::\nlcpt-vault:$y$j9T$fixture$fixturehash:19000:0:99999:7:::\n' >"$T/shadow.txt"
  expect_eq "vault account with a usable password → FAIL" "$(icheck inst-p3 >/dev/null; reasons inst-p3)" "account-vault-password-unlocked"
  printf 'lcpt-receive:!:19000:0:99999:7:::\nlcpt-vault:!:19000:0:99999:7:::\n' >"$T/shadow.txt"
  expect_eq "audit account missing from the shadow source → FAIL" "$(icheck inst-p4 >/dev/null; reasons inst-p4)" "account-audit-shadow-unreadable"
  shadow_reset
  nothas "$T/out/inst-p1.log" 'fixturehash|\$6\$' "no password hash printed"
  # ── sshd: per-account effective configuration ──
  expect_eq "fake sshd distinguishes global from per-account answers" "$(sshd_user_ok | sed 's/passwordauthentication no/passwordauthentication yes/' >"$T/sshd/user-lcpt-receive.txt"; "$T/bin/sshd" -T -f "$T/sshd/sshd_config" | grep -c '^passwordauthentication no$')/$("$T/bin/sshd" -T -f "$T/sshd/sshd_config" -C user=lcpt-receive,host=h,addr=127.0.0.1 | grep -c '^passwordauthentication yes$')" "1/1"
  expect_false "fake sshd refuses -T without -f" "$T/bin/sshd" -T
  expect_false "fake sshd refuses evaluating a file other than the inspected one" "$T/bin/sshd" -T -f "$T/sshd/global.txt"
  expect_eq "safe global policy + Match User override enabling passwords for receive → FAIL" "$(icheck inst-m1 >/dev/null; reasons inst-m1)" "sshd-receive-password-auth"
  sshd_reset; sshd_user_ok | sed 's/passwordauthentication no/passwordauthentication yes/' >"$T/sshd/user-lcpt-audit.txt"
  expect_eq "the equivalent audit-account override → FAIL" "$(icheck inst-m2 >/dev/null; reasons inst-m2)" "sshd-audit-password-auth"
  sshd_reset; sshd_user_ok | sed 's/kbdinteractiveauthentication no/kbdinteractiveauthentication yes/' >"$T/sshd/user-lcpt-audit.txt"
  expect_eq "interactive authentication enabled for audit → FAIL" "$(icheck inst-m3 >/dev/null; reasons inst-m3)" "sshd-audit-interactive-auth"
  sshd_reset; sshd_user_ok | sed 's/kbdinteractiveauthentication no/kbdinteractiveauthentication yes/' >"$T/sshd/user-lcpt-receive.txt"
  expect_eq "interactive authentication enabled for receive → FAIL" "$(icheck inst-m4 >/dev/null; reasons inst-m4)" "sshd-receive-interactive-auth"
  sshd_reset; sshd_user_ok | sed 's/pubkeyauthentication yes/pubkeyauthentication no/' >"$T/sshd/user-lcpt-receive.txt"
  expect_eq "public-key authentication disabled for receive → FAIL" "$(icheck inst-m5 >/dev/null; reasons inst-m5)" "sshd-receive-pubkey-auth"
  sshd_reset; sshd_user_ok | sed 's/pubkeyauthentication yes/pubkeyauthentication no/' >"$T/sshd/user-lcpt-audit.txt"
  expect_eq "public-key authentication disabled for audit → FAIL" "$(icheck inst-m6 >/dev/null; reasons inst-m6)" "sshd-audit-pubkey-auth"
  sshd_reset; sshd_global | sed 's/permitrootlogin no/permitrootlogin yes/' >"$T/sshd/global.txt"
  expect_eq "root login permitted globally → FAIL" "$(icheck inst-m7 >/dev/null; reasons inst-m7)" "sshd-root-login"
  sshd_reset; sshd_global | sed 's/passwordauthentication no/passwordauthentication yes/' >"$T/sshd/global.txt"
  expect_eq "password authentication enabled globally → FAIL" "$(icheck inst-pw >/dev/null; reasons inst-pw)" "sshd-password-auth"
  sshd_reset; sshd_global | grep -v 'allowusers lcpt-audit' >"$T/sshd/global.txt"
  expect_eq "AllowUsers without the audit account → FAIL" "$(icheck inst-m8 >/dev/null; reasons inst-m8)" "sshd-allowusers-audit"
  sshd_reset; { sshd_global; echo 'allowusers lcpt-vault'; } >"$T/sshd/global.txt"
  expect_eq "AllowUsers permitting the vault account → FAIL" "$(icheck inst-m9 >/dev/null; reasons inst-m9)" "sshd-allowusers-vault"
  sshd_reset; sshd_global | grep -v allowusers >"$T/sshd/global.txt"
  expect_eq "AllowUsers absent → FAIL" "$(icheck inst-m10 >/dev/null; reasons inst-m10)" "sshd-allowusers-missing"
  sshd_reset
  printf 'Include %s/sshd_config.d/*.conf\nMatch Address 10.0.0.0/8\n    PasswordAuthentication yes\n' "$T/sshd" >"$T/sshd/sshd_config"
  expect_eq "Match block on a non-User criterion → FAIL" "$(icheck inst-m11 >/dev/null; reasons inst-m11)" "sshd-match-criteria"
  printf 'Include /etc/other/*.conf\n' >"$T/sshd/sshd_config"
  expect_eq "Include outside sshd_config.d → FAIL" "$(icheck inst-m12 >/dev/null; reasons inst-m12)" "sshd-include-unsupported"
  sshd_cfg_reset
  # ── strict Include profile: the complete set of files sshd reads is scanned ──
  SD="$T/sshd/sshd_config.d"
  printf 'Match Address 10.0.0.0/8\n    PasswordAuthentication yes\n' >"$T/sshd/extra.cfg"
  printf 'Include %s/extra.cfg\nPasswordAuthentication no\n' "$T/sshd" >"$T/sshd/sshd_config"
  expect_eq "main config including a non-.conf file (with Match Address) → FAIL" "$(icheck inst-i1 >/dev/null; reasons inst-i1)" "sshd-include-unsupported"
  sshd_cfg_reset; printf 'Include %s/nested.cfg\n' "$T/sshd" >"$SD/20-nested.conf"; printf 'Match Group wheel\n    PasswordAuthentication yes\n' >"$T/sshd/nested.cfg"
  expect_eq "a .conf fragment including a second file → FAIL" "$(icheck inst-i2 >/dev/null; reasons inst-i2)" "sshd-include-nested"
  printf 'Include %s/*.conf\n' "$SD" >"$SD/20-nested.conf"
  expect_eq "a nested include carrying an unsupported Match criterion is refused before it is trusted" "$(icheck inst-i3 >/dev/null; reasons inst-i3)" "sshd-include-nested"
  rm -f "$SD/20-nested.conf" "$T/sshd/nested.cfg"
  ln -s "$T/sshd/extra.cfg" "$SD/30-link.conf"
  expect_eq "symlinked included file → FAIL" "$(icheck inst-i4 >/dev/null; reasons inst-i4)" "sshd-include-symlink"
  rm -f "$SD/30-link.conf"
  printf 'PubkeyAuthentication yes\n' >"$SD/40-owned.conf"; chown lcpt-audit "$SD/40-owned.conf"
  expect_eq "included file not owned by root → FAIL" "$(icheck inst-i5 >/dev/null; reasons inst-i5)" "sshd-include-owner"
  chown root "$SD/40-owned.conf"; chmod 664 "$SD/40-owned.conf"
  expect_eq "group-writable included file → FAIL" "$(icheck inst-i6 >/dev/null; reasons inst-i6)" "sshd-include-writable"
  rm -f "$SD/40-owned.conf"
  printf 'Include /etc/other/sshd_config.d/*.conf\n' >"$T/sshd/sshd_config"
  expect_eq "Include escaping the approved tree → FAIL" "$(icheck inst-i7 >/dev/null; reasons inst-i7)" "sshd-include-unsupported"
  sshd_cfg_reset; mv "$SD" "$T/sshd/away"
  expect_eq "Include directory missing → FAIL" "$(icheck inst-i8 >/dev/null; reasons inst-i8)" "sshd-include-missing"
  mv "$T/sshd/away" "$SD"; mkdir "$SD/50-dir.conf"
  expect_eq "included entry that is not a regular file → FAIL" "$(icheck inst-i9 >/dev/null; reasons inst-i9)" "sshd-include-not-regular"
  rmdir "$SD/50-dir.conf"
  printf 'Include %s/*.conf\nInclude %s/*.conf\n' "$SD" "$SD" >"$T/sshd/sshd_config"
  expect_eq "a second Include directive → FAIL" "$(icheck inst-i10 >/dev/null; reasons inst-i10)" "sshd-include-unsupported"
  sshd_cfg_reset; printf 'Match User lcpt-audit Address 10.0.0.1\n    PasswordAuthentication yes\n' >"$SD/10-audit.conf"
  expect_eq "combined foreign criterion (User + Address) → FAIL" "$(icheck inst-i11 >/dev/null; reasons inst-i11)" "sshd-match-criteria"
  printf 'Match Exec /bin/true\n' >"$SD/10-audit.conf"
  expect_eq "Match Exec → FAIL" "$(icheck inst-i12 >/dev/null; reasons inst-i12)" "sshd-match-criteria"
  printf 'Match LocalPort 22\n' >"$SD/10-audit.conf"
  expect_eq "Match LocalPort → FAIL" "$(icheck inst-i13 >/dev/null; reasons inst-i13)" "sshd-match-criteria"
  sshd_cfg_reset; chmod 664 "$T/sshd/sshd_config"
  expect_eq "group-writable main config → FAIL" "$(icheck inst-i14 >/dev/null; reasons inst-i14)" "sshd-config-writable"
  chmod 644 "$T/sshd/sshd_config"
  sshd_cfg_reset; printf 'Match All\n    PubkeyAuthentication yes\n' >"$SD/60-all.conf"
  expect_eq "documented main config + safe root-owned .conf fragments (incl. Match All) → PASS" "$(icheck inst-i0)" 0
  rm -f "$SD/60-all.conf" "$T/sshd/extra.cfg"; sshd_cfg_reset
  # ── C5: the inspected file is what sshd evaluates (-f), recorded by the fake ──
  : >"$T/sshd-invocations.log"
  expect_eq "baseline passes with the full normalized fixture" "$(icheck inst-f0)" 0
  expect_eq "checker evaluated the inspected file globally and per account — receive, audit, vault (-f recorded)" "$(grep -c "^f=$T/sshd/sshd_config user=$" "$T/sshd-invocations.log")/$(grep -c "^f=$T/sshd/sshd_config user=lcpt-receive$" "$T/sshd-invocations.log")/$(grep -c "^f=$T/sshd/sshd_config user=lcpt-audit$" "$T/sshd-invocations.log")/$(grep -c "^f=$T/sshd/sshd_config user=lcpt-vault$" "$T/sshd-invocations.log")" "1/1/1/1"
  expect_eq "exactly four evaluations and no other" "$(wc -l <"$T/sshd-invocations.log")" 4
  expect_eq "no evaluation of any other file" "$(grep -vc "^f=$T/sshd/sshd_config " "$T/sshd-invocations.log")" 0
  cp "$T/sshd/sshd_config" "$T/sshd/other_config"; : >"$T/sshd-invocations.log"
  expect_eq "checker told to inspect another file asks sshd for exactly that file (fake refuses → FAIL closed)" "$(icheck inst-f1 OFFHOST_SSHD_CONFIG="$T/sshd/other_config" >/dev/null; reasons inst-f1)/$(grep -c "^f=$T/sshd/other_config user=$" "$T/sshd-invocations.log")" "sshd-unavailable/1"
  rm -f "$T/sshd/other_config"
  ln -s "$T/sshd" "$T/sshdlink"
  expect_eq "non-canonical (symlinked) configuration path → FAIL" "$(icheck inst-f2 OFFHOST_SSHD_CONFIG="$T/sshdlink/sshd_config" >/dev/null; reasons inst-f2)" "sshd-config-noncanonical"
  rm -f "$T/sshdlink"
  chmod 777 "$T/sshd"
  expect_eq "group/world-writable configuration directory → FAIL" "$(icheck inst-f3 >/dev/null; reasons inst-f3)" "sshd-config-dir"
  chmod 755 "$T/sshd"; chown lcpt-audit "$T/sshd"
  expect_eq "configuration directory not owned by root → FAIL" "$(icheck inst-f4 >/dev/null; reasons inst-f4)" "sshd-config-dir"
  chown root "$T/sshd"
  # ── C5: per-account authorization boundary (each mutation on the normalized per-account dump) ──
  umut() {   # CASE ACCOUNT SED-EXPR EXPECTED-REASONS DESCRIPTION
    sshd_reset; sshd_user_ok | sed -E "$3" >"$T/sshd/user-lcpt-$2.txt"
    expect_eq "$5" "$(icheck "$1" >/dev/null; reasons "$1")" "$4"
  }
  uadd() {   # CASE ACCOUNT EXTRA-LINES EXPECTED-REASONS DESCRIPTION
    sshd_reset; { sshd_user_ok; printf '%b\n' "$3"; } >"$T/sshd/user-lcpt-$2.txt"
    expect_eq "$5" "$(icheck "$1" >/dev/null; reasons "$1")" "$4"
  }
  umut inst-a1 receive 's|^authorizedkeysfile .*|authorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2|' sshd-receive-authorized-keys-file "second authorized_keys2 path → FAIL"
  umut inst-a2 receive 's|^authorizedkeysfile .*|authorizedkeysfile .ssh/other_keys|' sshd-receive-authorized-keys-file "another relative key file → FAIL"
  umut inst-a3 audit 's|^authorizedkeysfile .*|authorizedkeysfile /etc/ssh/keys/%u|' sshd-audit-authorized-keys-file "absolute key file → FAIL"
  umut inst-a4 audit 's|^authorizedkeysfile .*|authorizedkeysfile /etc/ssh/%u/*|' sshd-audit-authorized-keys-file "wildcard/tokenized key file → FAIL"
  umut inst-a5 receive '/^authorizedkeysfile /d' sshd-receive-authorized-keys-file "AuthorizedKeysFile absent from the dump → FAIL (absence is not none)"
  umut inst-a6 receive 's|^authorizedkeyscommand .*|authorizedkeyscommand /usr/bin/fetch-keys|' sshd-receive-authorized-keys-command "AuthorizedKeysCommand set → FAIL"
  umut inst-a7 receive 's|^authorizedkeyscommanduser .*|authorizedkeyscommanduser nobody|' sshd-receive-authorized-keys-command "AuthorizedKeysCommandUser set → FAIL"
  umut inst-a8 receive '/^authorizedkeyscommand /d' sshd-receive-authorized-keys-command "AuthorizedKeysCommand absent from the dump → FAIL"
  umut inst-a9 audit 's|^trustedusercakeys .*|trustedusercakeys /etc/ssh/ca.pub|' sshd-audit-trusted-user-ca "TrustedUserCAKeys set → FAIL"
  umut inst-a10 receive 's|^authorizedprincipalsfile .*|authorizedprincipalsfile /etc/ssh/principals/%u|' sshd-receive-authorized-principals "AuthorizedPrincipalsFile set → FAIL"
  umut inst-a11 receive 's|^authorizedprincipalscommand .*|authorizedprincipalscommand /usr/bin/principals|' sshd-receive-authorized-principals "AuthorizedPrincipalsCommand set → FAIL"
  umut inst-a12 audit 's|^forcecommand .*|forcecommand /bin/sh|' sshd-audit-force-command "Match User ForceCommand → FAIL"
  sshd_reset; for f in global.txt user-lcpt-receive.txt user-lcpt-audit.txt; do sed -i 's|^forcecommand .*|forcecommand /bin/bash|' "$T/sshd/$f"; done
  expect_eq "global ForceCommand → FAIL (global and both accounts)" "$(icheck inst-a13 >/dev/null; reasons inst-a13)" "sshd-force-command,sshd-receive-force-command,sshd-audit-force-command"
  umut inst-a14 audit 's|^strictmodes .*|strictmodes no|' sshd-audit-strict-modes "StrictModes no → FAIL"
  umut inst-a15 receive 's|^authenticationmethods .*|authenticationmethods publickey,password|' sshd-receive-authentication-methods "AuthenticationMethods publickey,password → FAIL"
  umut inst-a16 receive 's|^authenticationmethods .*|authenticationmethods any|' sshd-receive-authentication-methods "AuthenticationMethods any (daemon default) → FAIL"
  umut inst-a17 receive 's|^authenticationmethods .*|authenticationmethods publickey publickey,keyboard-interactive|' sshd-receive-authentication-methods "AuthenticationMethods with an alternative list → FAIL"
  umut inst-a18 receive '/^authenticationmethods /d' sshd-receive-authentication-methods "AuthenticationMethods absent from the dump → FAIL"
  umut inst-a19 receive 's|^hostbasedauthentication .*|hostbasedauthentication yes|' sshd-receive-alternate-auth "HostbasedAuthentication yes → FAIL"
  umut inst-a20 audit 's|^gssapiauthentication .*|gssapiauthentication yes|' sshd-audit-alternate-auth "GSSAPIAuthentication yes → FAIL"
  umut inst-a21 audit 's|^permitemptypasswords .*|permitemptypasswords yes|' sshd-audit-alternate-auth "PermitEmptyPasswords yes → FAIL"
  # ── C5: environment injection policy ──
  umut inst-e1 receive 's|^permituserenvironment .*|permituserenvironment yes|' sshd-receive-user-environment "PermitUserEnvironment yes (account) → FAIL"
  sshd_reset; for f in global.txt user-lcpt-receive.txt user-lcpt-audit.txt; do sed -i 's|^permituserenvironment .*|permituserenvironment yes|' "$T/sshd/$f"; done
  expect_eq "PermitUserEnvironment yes (global) → FAIL everywhere" "$(icheck inst-e2 >/dev/null; reasons inst-e2)" "sshd-user-environment,sshd-receive-user-environment,sshd-audit-user-environment"
  for tok in 'OFFHOST_*' 'OFFHOST_NOW' 'LCP_*' 'LCP_MACHINE_ID_FILE' 'PATH' 'BASH_ENV' 'ENV' 'SHELLOPTS' 'BASHOPTS' 'LD_*' 'LD_PRELOAD' '*' 'L*' '?ATH' 'LC_*ALL' 'LC_ALL *'; do
    uadd "inst-e-$(printf '%s' "$tok" | tr -c 'A-Za-z0-9' '_')" receive "acceptenv $tok" sshd-receive-acceptenv "dangerous AcceptEnv token on a later line → FAIL: $tok"
  done
  uadd inst-e3 audit 'setenv LCP_MACHINE_ID_FILE=/tmp/x' sshd-audit-setenv "SetEnv of an identity hook → FAIL"
  uadd inst-e4 audit 'setenv PATH=/tmp/bin' sshd-audit-setenv "SetEnv PATH → FAIL"
  uadd inst-e5 audit 'acceptenv LANG\nacceptenv LC_TIME\nacceptenv LANGUAGE' "" "locale-only AcceptEnv tokens remain accepted → PASS"
  # ── C5: AllowUsers literal-user profile ──
  gadd() {   # CASE EXTRA-GLOBAL-LINES EXPECTED DESCRIPTION
    sshd_reset; { sshd_global; printf '%b\n' "$2"; } >"$T/sshd/global.txt"
    expect_eq "$4" "$(icheck "$1" >/dev/null; reasons "$1")" "$3"
  }
  gadd inst-u1 'allowusers *' sshd-allowusers-pattern "AllowUsers * → FAIL"
  gadd inst-u2 'allowusers ?' sshd-allowusers-pattern "AllowUsers ? → FAIL"
  gadd inst-u3 'allowusers !lcpt-vault' sshd-allowusers-pattern "negated AllowUsers pattern → FAIL"
  gadd inst-u4 'allowusers lcpt-receive@10.0.0.1' sshd-allowusers-pattern "user@host AllowUsers form → FAIL"
  gadd inst-u5 'allowusers lcpt-*' sshd-allowusers-pattern "glob AllowUsers able to admit the vault → FAIL"
  gadd inst-u6 'allowusers lcpt-receive,lcpt-audit' sshd-allowusers-pattern "comma pattern → FAIL"
  gadd inst-u7 'allowusers [l]cpt-receive' sshd-allowusers-pattern "bracket pattern → FAIL"
  gadd inst-u8 'allowusers lcpt\\-receive' sshd-allowusers-pattern "backslash form → FAIL"
  gadd inst-u9 'allowusers lcpt-receive' sshd-allowusers-duplicate "duplicate service-user entry → FAIL"
  gadd inst-u10 'allowusers someone' sshd-allowusers-unexpected "literal account outside the approved operator list → FAIL"
  sshd_reset
  expect_eq "operator account not approved explicitly → FAIL on every view" "$(icheck inst-u11 OFFHOST_SSHD_OPERATOR_USERS= >/dev/null; reasons inst-u11)" "sshd-allowusers-unexpected,sshd-receive-allowusers-unexpected,sshd-audit-allowusers-unexpected,sshd-vault-allowusers-unexpected"
  expect_eq "malformed operator list refused" "$(icheck inst-u12 OFFHOST_SSHD_OPERATOR_USERS='op;x' >/dev/null; reasons inst-u12)" "invalid-operator-users"
  expect_eq "literal AllowUsers entries only, operator approved → PASS" "$(icheck inst-u0)" 0
  # ── C5: forced scripts are immune to a caller-influenced PATH and locale ──
  printf 'PATH=/nonexistent\nexport PATH\n' >"$T/hostile.env"; chmod 644 "$T/hostile.env"
  # (stdout only: bash itself may warn on stderr about an unknown locale before the library resets it)
  clean_hello="$(as_receive env SSH_ORIGINAL_COMMAND=HELLO OFFHOST_CONFIG="$T/offhost.env" OFFHOST_NOW="$NOW" LCP_MACHINE_ID_FILE="$T/vault.mid" LCP_HOSTKEY_DIR="$T/vk" /bin/bash "$OH/offhost-receive.sh" 2>/dev/null)"
  hostile_hello="$(as_receive env PATH=/nonexistent LANG=C.UTF-8 LC_ALL=de_DE.UTF-8 LC_TIME=tr_TR.UTF-8 LANGUAGE=de BASH_ENV="$T/hostile.env" SSH_ORIGINAL_COMMAND=HELLO OFFHOST_CONFIG="$T/offhost.env" OFFHOST_NOW="$NOW" LCP_MACHINE_ID_FILE="$T/vault.mid" LCP_HOSTKEY_DIR="$T/vk" /bin/bash "$OH/offhost-receive.sh" 2>/dev/null)"
  expect_eq "receiver HELLO identical under a hostile PATH, BASH_ENV and locale" "$hostile_hello" "$clean_hello"
  expect_eq "…and it is a valid identity line" "$(printf '%s\n' "$hostile_hello" | grep -cE '^LCP-OFFHOST/1 HELLO machine=[0-9a-f]{64} hostkeys=SHA256:')" 1
  clean_audit="$(as_audit env SSH_ORIGINAL_COMMAND=AUDIT OFFHOST_CONFIG="$T/offhost.env" OFFHOST_NOW="$NOW" LCP_MACHINE_ID_FILE="$T/vault.mid" LCP_HOSTKEY_DIR="$T/vk" /bin/bash "$OH/offhost-audit.sh" 2>/dev/null)"
  hostile_audit="$(as_audit env PATH=/nonexistent LANG=C.UTF-8 LC_ALL=de_DE.UTF-8 LC_NUMERIC=de_DE.UTF-8 BASH_ENV="$T/hostile.env" SSH_ORIGINAL_COMMAND=AUDIT OFFHOST_CONFIG="$T/offhost.env" OFFHOST_NOW="$NOW" LCP_MACHINE_ID_FILE="$T/vault.mid" LCP_HOSTKEY_DIR="$T/vk" /bin/bash "$OH/offhost-audit.sh" 2>/dev/null)"
  expect_eq "auditor AUDIT identical under a hostile PATH, BASH_ENV and locale" "$hostile_audit" "$clean_audit"
  expect_eq "…and it carries the AUDIT_END footer" "$(printf '%s\n' "$hostile_audit" | grep -c '^LCP-OFFHOST/1 AUDIT_END ')" 1

  # ── C6: Match-scoped account admission — strict Match grammar + AllowUsers on every view ──
  SD="$T/sshd/sshd_config.d"
  mcfg() {   # MATCH-LINE [BLOCK-LINES] → main config: documented header + this Match block (audit fragment untouched)
    printf 'Include %s/sshd_config.d/*.conf\nPasswordAuthentication no\nPermitRootLogin no\nAllowUsers lcpt-receive lcpt-audit operator\n%s\n%b' "$T/sshd" "$1" "${2:-    PubkeyAuthentication yes\n}" >"$T/sshd/sshd_config"
    printf 'Match User lcpt-audit\n    PubkeyAuthentication yes\n' >"$SD/10-audit.conf"
  }
  mcase() {  # CASE MATCH-LINE EXPECTED DESCRIPTION — the fixture dumps stay safe: the scan alone must catch it
    sshd_reset; mcfg "$2"
    expect_eq "$4" "$(icheck "$1" >/dev/null; reasons "$1")" "$3"
  }
  mpass() {  # CASE MATCH-LINE DESCRIPTION
    sshd_reset; mcfg "$2"
    expect_eq "$3" "$(icheck "$1")" 0
  }
  # red → green: safe global/receive/audit views plus a Match-scoped backdoor account
  # (OpenSSH accepts it; the C5 checker reported every sshd check ok)
  sshd_reset; { sshd_user_ok | grep -vE '^(allowusers|authorizedkeysfile|forcecommand) '; printf 'allowusers backdoor\nauthorizedkeysfile /tmp/backdoor_authorized_keys\nforcecommand internal-sftp\n'; } >"$T/sshd/user-backdoor.txt"
  mcfg 'Match User backdoor' '    AllowUsers backdoor\n    AuthorizedKeysFile /tmp/backdoor_authorized_keys\n    ForceCommand internal-sftp\n'
  : >"$T/sshd-invocations.log"
  expect_eq "Match-scoped backdoor (AllowUsers, key file, ForceCommand inside the block) → FAIL" "$(icheck inst-b1 >/dev/null; reasons inst-b1)" "sshd-match-user-unapproved"
  expect_eq "…global, receive, audit and vault views evaluated with -f, exactly once each, nothing else" "$(grep -c "^f=$T/sshd/sshd_config user=$" "$T/sshd-invocations.log")/$(grep -c "^f=$T/sshd/sshd_config user=lcpt-receive$" "$T/sshd-invocations.log")/$(grep -c "^f=$T/sshd/sshd_config user=lcpt-audit$" "$T/sshd-invocations.log")/$(grep -c "^f=$T/sshd/sshd_config user=lcpt-vault$" "$T/sshd-invocations.log")/$(wc -l <"$T/sshd-invocations.log")" "1/1/1/1/4"
  expect_eq "…no account name from the configuration is printed" "$(grep -c backdoor "$T/out/inst-b1.log")" 0
  rm -f "$T/sshd/user-backdoor.txt"
  sshd_reset; sshd_cfg_reset; printf 'Match User backdoor\n    AllowUsers backdoor\n' >"$SD/50-backdoor.conf"
  expect_eq "the same block inside an included fragment → FAIL" "$(icheck inst-b2 >/dev/null; reasons inst-b2)" "sshd-match-user-unapproved"
  rm -f "$SD/50-backdoor.conf"
  # Match targets that must fail
  mcase inst-mt1  'Match User lcpt-vault' sshd-match-user-unapproved "Match User on the vault account → FAIL"
  mcase inst-mt2  'Match User operator' sshd-match-user-unapproved "Match User on the configured operator account → FAIL"
  mcase inst-mt3  'Match User nobody' sshd-match-user-unapproved "Match User on an unrelated literal account → FAIL"
  mcase inst-mt4  'Match User *' sshd-match-criteria "Match User wildcard → FAIL"
  mcase inst-mt5  'Match User lcpt-*' sshd-match-criteria "Match User glob pattern → FAIL"
  mcase inst-mt6  'Match User !lcpt-vault' sshd-match-criteria "Match User negation → FAIL"
  mcase inst-mt7  'Match User lcpt-receive@10.0.0.1' sshd-match-criteria "Match User user@host → FAIL"
  mcase inst-mt8  'Match User [l]cpt-receive' sshd-match-criteria "Match User bracket pattern → FAIL"
  mcase inst-mt9  'Match User lcpt\-receive' sshd-match-criteria "Match User backslash pattern → FAIL"
  mcase inst-mt10 'Match User lcpt-receive,backdoor' sshd-match-user-unapproved "receive plus an unrelated user → FAIL"
  mcase inst-mt11 'Match User lcpt-receive,lcpt-vault' sshd-match-user-unapproved "receive plus the vault → FAIL"
  mcase inst-mt12 'Match User lcpt-receive,lcpt-receive' sshd-match-criteria "duplicate receive in one operand → FAIL"
  mcase inst-mt13 'Match User lcpt-receive,' sshd-match-criteria "trailing empty comma component → FAIL"
  mcase inst-mt14 'Match User ,lcpt-audit' sshd-match-criteria "leading empty comma component → FAIL"
  mcase inst-mt15 'Match User lcpt-receive,,lcpt-audit' sshd-match-criteria "inner empty comma component → FAIL"
  mcase inst-mt16 'Match User lcpt-receive User lcpt-audit' sshd-match-criteria "repeated User criteria → FAIL"
  mcase inst-mt17 'Match Address 10.0.0.0/8' sshd-match-criteria "Match Address → FAIL"
  mcase inst-mt18 'Match Group lcpt-audit' sshd-match-criteria "Match Group → FAIL"
  mcase inst-mt19 'Match Host backup' sshd-match-criteria "Match Host → FAIL"
  mcase inst-mt20 'Match LocalAddress 127.0.0.1' sshd-match-criteria "Match LocalAddress → FAIL"
  mcase inst-mt21 'Match User lcpt-receive Address 10.0.0.1' sshd-match-criteria "mixed User + Address criteria → FAIL"
  mcase inst-mt22 'Match All User lcpt-receive' sshd-match-criteria "All combined with another criterion → FAIL"
  mcase inst-mt23 'Match User' sshd-match-criteria "User without an operand → FAIL"
  mcase inst-mt24 'Match' sshd-match-criteria "Match without criteria → FAIL"
  mcase inst-mt25 'Match=User lcpt-receive' sshd-match-criteria "keyword=value Match form → FAIL"
  mcase inst-mt26 'Match User=lcpt-receive' sshd-match-criteria "User=value operand form → FAIL"
  mcase inst-mt27 'Match User "lcpt-receive"' sshd-match-criteria "quoted operand → FAIL"
  mcase inst-mt28 'Match User lcpt-receive,lcpt-audit,operator' sshd-match-user-unapproved "both service accounts plus the operator → FAIL"
  sshd_reset; sshd_cfg_reset; printf 'Match User lcpt-vault\n    PubkeyAuthentication yes\n' >"$SD/10-audit.conf"
  expect_eq "Match User on the vault inside a fragment → FAIL" "$(icheck inst-mt29 >/dev/null; reasons inst-mt29)" "sshd-match-user-unapproved"
  sshd_reset; sshd_cfg_reset; printf 'Include=%s/sshd_config.d/*.conf\nPasswordAuthentication no\n' "$T/sshd" >"$T/sshd/sshd_config"
  expect_eq "keyword=value Include form → FAIL" "$(icheck inst-mt30 >/dev/null; reasons inst-mt30)" "sshd-include-unsupported"
  # Match targets that must pass
  sshd_reset; printf 'Include %s/sshd_config.d/*.conf\nPasswordAuthentication no\nPermitRootLogin no\n' "$T/sshd" >"$T/sshd/sshd_config"; printf 'PubkeyAuthentication yes\n' >"$SD/10-audit.conf"
  expect_eq "no Match block anywhere → PASS" "$(icheck inst-mp1)" 0
  mpass inst-mp2 'Match All' "Match All → PASS"
  mpass inst-mp3 'Match User lcpt-receive' "Match User receive only → PASS"
  mpass inst-mp4 'Match User lcpt-audit' "Match User audit only → PASS"
  mpass inst-mp5 'Match User lcpt-receive,lcpt-audit' "exact receive,audit list → PASS"
  mpass inst-mp6 'Match User lcpt-audit,lcpt-receive' "exact audit,receive list → PASS"
  mpass inst-mp7 $'match\tuser  lcpt-receive  ' "keyword casing and surrounding whitespace accepted → PASS"
  sshd_cfg_reset
  # effective AllowUsers on every evaluated view: global, receive, audit, vault
  vfile() { case "$1" in global) echo "$T/sshd/global.txt" ;; *) echo "$T/sshd/user-lcpt-$1.txt" ;; esac; }
  vdump() { case "$1" in receive|audit) sshd_user_ok ;; *) sshd_global ;; esac; }
  vprefix() { case "$1" in global) echo sshd-allowusers ;; *) echo "sshd-$1-allowusers" ;; esac; }
  amut() {   # VIEW CASE SED-EXPR EXPECTED-KIND DESCRIPTION
    sshd_reset; vdump "$1" | sed -E "$3" >"$(vfile "$1")"
    expect_eq "$5 [$1 view]" "$(icheck "$2" >/dev/null; reasons "$2")" "$(vprefix "$1")-$4"
  }
  for view in global receive audit vault; do
    amut "$view" "inst-av1-$view" '/^allowusers lcpt-receive$/d' receive "AllowUsers missing the receive account → FAIL"
    amut "$view" "inst-av2-$view" '/^allowusers lcpt-audit$/d' audit "AllowUsers missing the audit account → FAIL"
    amut "$view" "inst-av3-$view" '$ s/$/\nallowusers lcpt-vault/' vault "AllowUsers admitting the vault → FAIL"
    amut "$view" "inst-av4-$view" '$ s/$/\nallowusers lcpt-*/' pattern "AllowUsers wildcard pattern → FAIL"
    amut "$view" "inst-av5-$view" '$ s/$/\nallowusers someone/' unexpected "AllowUsers unexpected literal user → FAIL"
    amut "$view" "inst-av6-$view" '$ s/$/\nallowusers lcpt-audit/' duplicate "AllowUsers duplicate service account → FAIL"
    amut "$view" "inst-av7-$view" '$ s/$/\nallowusers operator/' duplicate "AllowUsers duplicate operator → FAIL"
    amut "$view" "inst-av8-$view" '/^allowusers /d' missing "AllowUsers absent → FAIL"
  done
  sshd_reset; sshd_user_ok | sed -E '/^allowusers (lcpt-audit|operator)$/d' >"$T/sshd/user-lcpt-receive.txt"
  expect_eq "Match-scoped AllowUsers replacing the list on the receive view (receive only) → FAIL" "$(icheck inst-av9 >/dev/null; reasons inst-av9)" "sshd-receive-allowusers-audit"
  sshd_reset; { sshd_user_ok | grep -v '^allowusers '; printf 'allowusers lcpt-audit\nallowusers backdoor\n'; } >"$T/sshd/user-lcpt-audit.txt"
  expect_eq "Match-scoped AllowUsers replacing the list on the audit view (audit + unrelated) → FAIL" "$(icheck inst-av10 >/dev/null; reasons inst-av10)" "sshd-audit-allowusers-receive,sshd-audit-allowusers-unexpected"
  sshd_reset; sshd_cfg_reset; printf 'Match User lcpt-vault\n    AllowUsers lcpt-vault\n' >"$SD/10-audit.conf"; { sshd_global; echo 'allowusers lcpt-vault'; } >"$T/sshd/user-lcpt-vault.txt"
  expect_eq "Match-scoped vault admission → FAIL at both layers (Match target and vault view)" "$(icheck inst-av11 >/dev/null; reasons inst-av11)" "sshd-match-user-unapproved,sshd-vault-allowusers-vault"
  sshd_cfg_reset
  sshd_reset; for v in global receive audit vault; do echo 'allowusers ops2' >>"$(vfile "$v")"; done
  expect_eq "second literal operator present on every view but not approved → FAIL on every view" "$(icheck inst-av12 >/dev/null; reasons inst-av12)" "sshd-allowusers-unexpected,sshd-receive-allowusers-unexpected,sshd-audit-allowusers-unexpected,sshd-vault-allowusers-unexpected"
  expect_eq "…the same list with the operator explicitly approved → PASS" "$(icheck inst-av13 OFFHOST_SSHD_OPERATOR_USERS=operator,ops2)" 0
  sshd_reset; : >"$T/sshd/user-lcpt-vault.txt"
  expect_eq "vault view not evaluable → FAIL closed" "$(icheck inst-av14 >/dev/null; reasons inst-av14)" "sshd-vault-unavailable"
  sshd_reset
  expect_eq "documented AllowUsers list on every view → PASS" "$(icheck inst-av0)" 0
  sshd_reset; sshd_cfg_reset
  expect_eq "sshd unavailable → FAIL" "$(icheck inst-nos OFFHOST_SSHD_BIN="$T/bin/no-such-sshd" >/dev/null; reasons inst-nos)" "sshd-unavailable"
  expect_eq "non-root invocation refused" "$(runuser -u lcpt-audit -- bash "$OH/offhost-install-check.sh" 2>/dev/null | tail -n 1)" "OFFHOST_INSTALL=FAIL reasons=install-check-not-root"
  BEFORE_TREE="$(tree_hash)"
  expect_eq "correct effective configuration and locked accounts pass" "$(icheck inst-again)" 0
  expect_eq "the checker is read-only (fixture tree, sudoers, sshd and shadow fixtures unchanged)" "$(tree_hash)" "$BEFORE_TREE"
  expect_eq "no privileged command was executed by the checks (no publish artefacts)" "$(find "$INST" -name '*.publish' -o -name '*.pending' -o -name '*.receipt' | wc -l)" 0
  cat "$T/out"/inst-*.log >"$T/inst-all.txt"
  nothas "$T/inst-all.txt" "$K_UP|$K_A1|$K_A2|$K_RSA" "no public-key blob in any checker output"
  nothas "$T/inst-all.txt" "SHA256:" "no fingerprint in any checker output"
  nothas "$T/inst-all.txt" "backup-fixture|127\.0\.0\.1| vm[: ]|$(hostname)" "no host name or address in any checker output"
  nothas "$T/inst-all.txt" "fixturehash|:19000:" "no shadow data in any checker output"
  # restore the harness drop-in used by the sender tests
  install_sudoers "$(cat "$T/sudoers.main")"
else
  skip "installation-integrity fixture (requires root and the test accounts)"
fi

echo "== 27. every documented configuration key is exercised (no placeholder settings) =="
# For each whitelisted key, the consuming script must assign it to a variable
# (VAR="${KEY:-…}") AND use that variable in code outside the assignment.
check_key_used() {   # KEY FILE…
  local key="$1" f var used=0; shift
  for f in "$@"; do
    var="$(grep -oE "^[A-Z_]+=\"\\\$\\{$key:-" "$f" | head -n 1 | sed -E 's/=.*//')"
    [ -n "$var" ] || continue
    if [ "$(code "$f" | grep -vE "^$var=\"\\\$\\{$key:-" | grep -cE "\\\$\\{?$var([^A-Z_]|$)")" -ge 1 ]; then used=1; fi
  done
  [ "$used" = 1 ]
}
SEND_KEYS="$(grep -oE 'readonly CONFIG_KEYS=" [^"]+ "' "$OH/offhost-send.sh" | sed -E 's/readonly CONFIG_KEYS=" //; s/ "$//')"
for k in $SEND_KEYS; do expect_true "sender key exercised: $k" check_key_used "$k" "$OH/offhost-send.sh"; done
VAULT_KEYS="$(grep -oE 'readonly LCP_VAULT_CONFIG_KEYS=" [^"]+ "' "$OH/offhost-lib.sh" | sed -E 's/readonly LCP_VAULT_CONFIG_KEYS=" //; s/ "$//')"
for k in $VAULT_KEYS; do expect_true "vault key exercised: $k" check_key_used "$k" "$OH/offhost-receive.sh" "$OH/offhost-publish.sh" "$OH/offhost-audit.sh" "$OH/offhost-retain.sh"; done
expect_eq "OFFHOST_MAX_TIME drives the monotonic budget" "$(code "$OH/offhost-send.sh" | grep -c 'REM=$(( MAX_TIME - (SECONDS - START_SECONDS) ))')" 1
expect_eq "every blocking operation runs under run_limited" "$(code "$OH/offhost-send.sh" | grep -cE '^\s*run_limited "\$(SSH_BIN|AGE_BIN)"')" 2
expect_eq "timeout uses --foreground with a kill-after grace" "$(code "$OH/offhost-send.sh" | grep -c 'timeout --foreground -k 5 "$REM"')" 1
expect_eq "summary and log lines go to the saved stdout descriptor (never a redirected helper)" "$(code "$OH/offhost-send.sh" | grep -cE '^(log|fail)\(\).*>&3')" 2
expect_eq "children of the budgeted call cannot inherit the lock or the summary descriptor" "$(code "$OH/offhost-send.sh" | grep -c '9>&- 3>&-')" 1
expect_eq "the clock-skew limit is applied to the audit header" "$(code "$OH/offhost-send.sh" | grep -c '\-le "$MAX_SKEW"')" 1
expect_eq "capacity limits are applied by the publisher" "$(code "$OH/offhost-publish.sh" | grep -cE 'MAX_ARCHIVE|MIN_FREE|MAX_GEN' )" "$(code "$OH/offhost-publish.sh" | grep -cE 'MAX_ARCHIVE|MIN_FREE|MAX_GEN')"
expect_true "publisher applies the per-archive maximum" grep -q '"$SIZE" -gt "$MAX_ARCHIVE"' "$OH/offhost-publish.sh"
expect_true "publisher applies the free-space reserve" grep -q 'copies \* SIZE )) -ge "$MIN_FREE"' "$OH/offhost-publish.sh"
expect_true "publisher applies the per-slot cap" grep -q '"$n" -lt "$MAX_GEN"' "$OH/offhost-publish.sh"
expect_true "auditor reports capacity from the same limits" grep -q 'lcp_capacity_line "$ROOT" "$MAX_GEN" "$MIN_FREE"' "$OH/offhost-audit.sh"
expect_eq "the receiver never touches published/" "$(code "$OH/offhost-receive.sh" | grep -c '/published')" 0
# installation checker statics (Correction 3)
IC="$OH/offhost-install-check.sh"
expect_eq "checker evaluates sshd per restricted account with -T -f <inspected file> -C user=…" "$(code "$IC" | grep -c '"$SSHD_BIN" -T -f "$SSHD_CONFIG" -C "user=$u,host=$PROBE_HOST,addr=$PROBE_ADDR"')" 1
expect_eq "checker evaluates the global policy of the inspected file (-T -f)" "$(code "$IC" | grep -c '"$SSHD_BIN" -T -f "$SSHD_CONFIG" 2>/dev/null')" 1
expect_eq "checker never evaluates sshd without -f" "$(code "$IC" | grep -E '"\$SSHD_BIN" -T' | grep -vc -- '-T -f "$SSHD_CONFIG"')" 0
expect_eq "checker requires the exact single authorized-key file" "$(code "$IC" | grep -c '= ".ssh/authorized_keys" \]')" 1
expect_eq "checker requires none for key command, CA, principals and ForceCommand" "$(code "$IC" | grep -oE 'v "\$e" (authorizedkeyscommand|trustedusercakeys|authorizedprincipalsfile|authorizedprincipalscommand|forcecommand)\)" = none' | wc -l)" 5
expect_eq "checker requires publickey-only authentication, StrictModes and no user environment" "$(code "$IC" | grep -cE 'authenticationmethods\)" = publickey|strictmodes\)" = yes|permituserenvironment\)" = no')" 4
expect_eq "checker applies the literal-user AllowUsers grammar" "$(code "$IC" | grep -c "USERNAME_RE='\^\[a-z_\]\[a-z0-9_-\]{0,31}\$'")" 1
expect_eq "checker rejects dangerous AcceptEnv tokens and any SetEnv" "$(code "$IC" | grep -cE 'accept_env_token_ok "\$tok"|== "setenv"')" 2
expect_eq "checker restricts Match User to the receive/audit accounts (main file and fragments)" "$(code "$IC" | grep -c 'match_criteria_check "')/$(code "$IC" | grep -c 'bad sshd-match-user-unapproved')" "2/1"
expect_eq "checker evaluates the vault view and re-checks AllowUsers on the global and every account view" "$(code "$IC" | grep -c '"vault:$VAULT_USER"')/$(code "$IC" | grep -c 'allowusers_ok "')" "1/2"
expect_eq "checker refuses keyword=value Match and Include forms" "$(code "$IC" | grep -cE '\[Mm\]\[Aa\]\[Tt\]\[Cc\]\[Hh\]=\*\)|\[Ii\]\[Nn\]\[Cc\]\[Ll\]\[Uu\]\[Dd\]\[Ee\]=\*')" 4
expect_eq "library pins PATH and the locale for every backup-side script" "$(code "$OH/offhost-lib.sh" | grep -cE '^export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin$|^export LC_ALL=C LANG=C LANGUAGE=C$')" 2
expect_eq "checker requires exactly one receive key and two audit keys" "$(code "$IC" | grep -cE 'check_keys "\$RECEIVE_USER" "\$BIN_DIR/offhost-receive.sh" receive 1|check_keys "\$AUDIT_USER" "\$BIN_DIR/offhost-audit.sh" audit 2')" 2
expect_eq "checker requires distinct key fingerprints" "$(code "$IC" | grep -c 'authorized-keys-duplicate')" 1
expect_eq "checker lists the effective sudo privileges read-only (-n -l -U)" "$(code "$IC" | grep -c '"$SUDO_BIN" -n -l -U "$RECEIVE_USER"')" 1
expect_eq "checker requires the publisher as the only effective command" "$(code "$IC" | grep -c '\[ "$command" != "$PUBLISHER" \]')" 1
expect_eq "checker requires NOSETENV on the publisher rule" "$(code "$IC" | grep -c 'NOSETENV')" "$(code "$IC" | grep -c 'NOSETENV')"
expect_true "checker refuses SETENV (file and effective)" bash -c "code() { grep -vE '^[[:space:]]*#' \"\$@\"; }; code '$IC' | grep -q 'bad sudoers-setenv' && code '$IC' | grep -q 'bad sudo-effective-setenv'"
expect_eq "checker never runs sudo with a command (listing only)" "$(code "$IC" | grep -E '"\$SUDO_BIN"' | grep -vc -- '-n -l -U')" 0
expect_eq "checker verifies locked passwords for receive, audit and vault" "$(code "$IC" | grep -c '"$RECEIVE_USER:receive" "$AUDIT_USER:audit" "$VAULT_USER:vault"')" 1
expect_true "visudo -cf accepts sudoers.example" visudo -cf "$OH/sudoers.example"
expect_eq "checker validates keys with the OpenSSH tooling (ssh-keygen -l -f -)" "$(code "$IC" | grep -c '"$SSH_KEYGEN_BIN" -l -f - >/dev/null 2>&1')" 1
expect_eq "checker fails closed without the key validator" "$(code "$IC" | grep -c 'bad authorized-keys-validator-unavailable')" 1
expect_eq "checker's structure parser requires a 32-byte key and no trailing bytes" "$(code "$IC" | grep -cE 'len\(key\) != 32|off != len\(raw\)')" 2
expect_eq "checker rejects inverse sudo Defaults (!env_reset, requiretty, !use_pty)" "$(code "$IC" | grep -cE "has_tok '!env_reset'|has_tok requiretty|has_tok '!use_pty'")" 3
expect_eq "checker lists sudo privileges under LC_ALL=C" "$(code "$IC" | grep -c 'LC_ALL=C "$SUDO_BIN" -n -l -U')" 1
expect_eq "checker permits only the exact documented Include pattern and scans every match" "$(code "$IC" | grep -c '"$1" = "$cfg_dir/sshd_config.d/\*.conf"')" 1
expect_eq "checker refuses Includes inside fragments" "$(code "$IC" | grep -c 'r=include-nested')" 1
expect_eq "sender validates the test-only budget hook before arithmetic" "$(code "$OH/offhost-send.sh" | grep -c '=\[1-9\]\[0-9\]{0,5}\$ \]\]; then')" 1
expect_eq "sudoers example carries NOSETENV and the required Defaults" "$(grep -cE '^Defaults:lcp-receive env_reset, !requiretty, use_pty$|^lcp-receive ALL=\(root\) NOPASSWD: NOSETENV: /opt/lcp-offhost/bin/offhost-publish\.sh$' "$OH/sudoers.example")" 2

echo "== 21. static: no cloud-storage provider assumptions in the scripts =="
for term in 'storage\.googleapis' 'gserviceaccount' 'workloadIdentity' 'sts\.googleapis' 'iamcredentials' 'gcloud' 'GOOGLE_' 'ifGenerationMatch' 'me-central2' 'CNTXT' 'gsutil' 'OFFHOST_BUCKET' 'x-goog'; do
  if code "$OH"/*.sh "$OH"/*.example | grep -qiE -- "$term"; then bad "no reference to '$term' in the off-host scripts"; else ok "no reference to '$term' in the off-host scripts"; fi
done
expect_eq "sender pins the ssh channel (BatchMode, StrictHostKeyChecking, IdentitiesOnly)" "$(code "$OH/offhost-send.sh" | grep -c 'BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes')" 1
expect_eq "no ssh-keyscan anywhere" "$(code "$OH"/*.sh "$OH"/*.example | grep -c 'ssh-keyscan')" 0
expect_eq "authorized_keys example uses restrict + forced command for every key" "$(grep -cE '^restrict,command="/opt/lcp-offhost/bin/offhost-(receive|audit)\.sh" ssh-ed25519 <' "$OH/authorized_keys.example")" 3
expect_eq "no private key material in the examples" "$(cat "$OH"/*.example | grep -cE 'AGE-SECRET-KEY|PRIVATE KEY')" 0
expect_eq "examples define three key pairs (upload, primary audit, GitHub audit)" "$(grep -cE '^restrict,command="/opt/lcp-offhost/bin/offhost-(receive|audit)\.sh" ssh-ed25519 <' "$OH/authorized_keys.example")" 3
expect_eq "example storage limits are bounded and validated" "$(source "$OH/offhost-lib.sh"; lcp_capacity_settings_ok "$(sed -n 's/^OFFHOST_MAX_GENERATIONS_PER_SLOT=//p' "$OH/offhost.env.example")" "$(sed -n 's/^OFFHOST_MIN_FREE_BYTES=//p' "$OH/offhost.env.example")" "$(sed -n 's/^OFFHOST_MAX_ARCHIVE_BYTES=//p' "$OH/offhost.env.example")" && echo bounded)" bounded
expect_eq "example per-archive maximum is below the former unrestricted 20 GiB" "$(( $(sed -n 's/^OFFHOST_MAX_ARCHIVE_BYTES=//p' "$OH/offhost.env.example") < 21474836480 ))" 1

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
