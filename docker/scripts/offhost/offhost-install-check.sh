#!/bin/bash
# =============================================================================
# Lead Capture Pro — backup VPS installation-integrity check (B23 G-6D C2–C5)
# =============================================================================
# Runs as root ON THE BACKUP VPS before activation and at any later review.
# STRICTLY READ-ONLY: it inspects ownership, modes, sudoers and the EFFECTIVE
# sudo authority, the forced-command key inventory, account locks, group
# membership, the effective sshd configuration PER RESTRICTED ACCOUNT and
# records script hashes. It changes nothing, executes no privileged command
# and prints no secret: no key material, no fingerprint, no password hash or
# shadow data, no host name or address, no user name beyond the documented
# service-account labels.
#
#   sudo OFFHOST_CONFIG=/etc/lcp-offhost/offhost.env bash /opt/lcp-offhost/bin/offhost-install-check.sh
#
# Checks (each prints `install: <check>=ok`; failures are collected):
#   install-root   OFFHOST_INSTALL_ROOT and OFFHOST_BIN_DIR are directories owned
#                  root:root and not group/world-writable
#   bin-files      offhost-lib.sh, offhost-receive.sh, offhost-publish.sh,
#                  offhost-audit.sh, offhost-retain.sh present, regular, root:root,
#                  not group/world-writable, executables executable; every other
#                  entry of the bin directory root-owned and not writable by others
#   config         OFFHOST_CONFIG regular, root:root, not group/world-writable,
#                  parses against the whitelist, capacity limits bounded
#   sudoers        OFFHOST_SUDOERS regular, root:root, mode 0440, `visudo -cf`
#                  passes, Defaults for the receive user include env_reset,
#                  !requiretty and use_pty, exactly one rule and it is
#                  `<receive> ALL=(root) NOPASSWD: NOSETENV: <bin>/offhost-publish.sh`
#   sudo-effective read-only `sudo -n -l -U <receive>`: the EFFECTIVE privileges
#                  from every sudoers source are exactly one command — the
#                  publisher — as root with NOPASSWD and NOSETENV, and the
#                  effective Defaults include env_reset, !requiretty, use_pty
#                  (no shell, wildcard, ALL, SETENV or grant from another file)
#   authorized-keys  exactly ONE key for the receive account forced to
#                  offhost-receive.sh and exactly TWO keys for the audit account
#                  forced to offhost-audit.sh (primary audit + GitHub audit); every
#                  line is `restrict,command="<script>" <type> <base64>` with a
#                  supported type and a structurally valid blob whose embedded
#                  type matches; all three fingerprints distinct
#   vault-no-ssh   the vault account has no authorized key and a nologin shell
#   accounts-locked receive, audit and vault have no usable password
#   groups         receive and audit are not members of the vault group;
#                  receive and vault are not members of the audit group
#   sshd-config    every `Match` block in sshd_config (+ sshd_config.d) matches on
#                  User (or All) only, and every Include stays inside sshd_config.d,
#                  so the per-user evaluation below is authoritative
#   sshd           `sshd -T -f <inspected file>` (global): permitrootlogin no,
#                  passwordauthentication no, pubkeyauthentication yes, interactive
#                  auth off, forcecommand none, permituserenvironment no;
#                  AllowUsers literal user names only (no wildcard, negation,
#                  pattern, bracket, backslash or user@host), the receive and
#                  audit accounts exactly once, never the vault, other names only
#                  from OFFHOST_SSHD_OPERATOR_USERS;
#                  per account `sshd -T -f <inspected file> -C user=<account>,…`:
#                  passwordauthentication no, interactive auth off,
#                  pubkeyauthentication yes, authenticationmethods publickey,
#                  hostbased/gssapi/kerberos/empty-password auth off,
#                  authorizedkeysfile exactly .ssh/authorized_keys,
#                  authorizedkeyscommand none, trustedusercakeys none,
#                  authorizedprincipalsfile/-command none, forcecommand none,
#                  strictmodes yes, permituserenvironment no, no setenv, and
#                  acceptenv limited to LANG/LANGUAGE/LC_* (a token able to
#                  match OFFHOST_*, LCP_*, PATH, BASH_ENV, ENV, SHELLOPTS,
#                  BASHOPTS or LD_* is refused). The inspected path must be
#                  canonical inside a real root-owned directory.
#   hashes         sha256 prefix of every bin file, for the activation record
#                  (record the full `sha256sum` output separately)
#
# Summary: `OFFHOST_INSTALL=PASS checks=<n>` (exit 0) or
#          `OFFHOST_INSTALL=FAIL reasons=<code,…>` (exit 1).
# Inputs: OFFHOST_INSTALL_ROOT (/opt/lcp-offhost), OFFHOST_BIN_DIR
# (<root>/bin), OFFHOST_CONFIG (/etc/lcp-offhost/offhost.env), OFFHOST_SUDOERS
# (/etc/sudoers.d/lcp-offhost), OFFHOST_RECEIVE_USER, OFFHOST_AUDIT_USER,
# OFFHOST_VAULT_USER, OFFHOST_SSHD_BIN (sshd), OFFHOST_SSHD_CONFIG
# (/etc/ssh/sshd_config), OFFHOST_SSHD_PROBE_HOST (hostname),
# OFFHOST_SSHD_PROBE_ADDR (127.0.0.1), OFFHOST_SSHD_OPERATOR_USERS (comma-
# separated literal operator accounts permitted in AllowUsers), OFFHOST_SUDO_BIN (sudo).
# Environment-only test hooks: OFFHOST_HOME_BASE (home directories under
# <base>/<user> instead of passwd), OFFHOST_SHADOW_SOURCE (a shadow-format file
# instead of `getent shadow`).
#
# This script proves the INSTALLED SHAPE only. Real forced-command semantics
# (restrict, SSH_ORIGINAL_COMMAND) must be exercised on the real server with
# the real keys before activation; nothing here claims that.
# =============================================================================
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin   # fixed before any external tool (B23 G-6D C5)
HERE="$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)"
# shellcheck source=offhost-lib.sh
source "$HERE/offhost-lib.sh"

INSTALL_ROOT="${OFFHOST_INSTALL_ROOT:-/opt/lcp-offhost}"
BIN_DIR="${OFFHOST_BIN_DIR:-$INSTALL_ROOT/bin}"
CONFIG="${OFFHOST_CONFIG:-/etc/lcp-offhost/offhost.env}"
SUDOERS="${OFFHOST_SUDOERS:-/etc/sudoers.d/lcp-offhost}"
RECEIVE_USER="${OFFHOST_RECEIVE_USER:-lcp-receive}"
AUDIT_USER="${OFFHOST_AUDIT_USER:-lcp-audit}"
VAULT_USER="${OFFHOST_VAULT_USER:-lcp-vault}"
SSHD_BIN="${OFFHOST_SSHD_BIN:-sshd}"
SSHD_CONFIG="${OFFHOST_SSHD_CONFIG:-/etc/ssh/sshd_config}"
PROBE_HOST="${OFFHOST_SSHD_PROBE_HOST:-$(hostname 2>/dev/null || echo localhost)}"
PROBE_ADDR="${OFFHOST_SSHD_PROBE_ADDR:-127.0.0.1}"
SUDO_BIN="${OFFHOST_SUDO_BIN:-sudo}"
OPERATOR_USERS="${OFFHOST_SSHD_OPERATOR_USERS:-}"   # comma-separated literal operator accounts allowed in AllowUsers
HOME_BASE="${OFFHOST_HOME_BASE:-}"
SHADOW_SOURCE="${OFFHOST_SHADOW_SOURCE:-}"
FAILS=(); CHECKS=0
ok()   { CHECKS=$((CHECKS + 1)); echo "install: $1=ok"; }
bad()  { FAILS+=("$1"); echo "install: $1=FAIL${2:+ ($2)}"; }
finish() {
  if [ "${#FAILS[@]}" = 0 ]; then echo "OFFHOST_INSTALL=PASS checks=$CHECKS"; exit 0; fi
  echo "OFFHOST_INSTALL=FAIL reasons=$(IFS=,; echo "${FAILS[*]}")"; exit 1
}
[ "$(id -u)" = 0 ] || { bad install-check-not-root; finish; }
for v in INSTALL_ROOT BIN_DIR CONFIG SUDOERS SSHD_CONFIG; do [[ "${!v}" =~ $LCP_PATH_RE ]] || { bad "invalid-${v,,}"; finish; }; done
for v in RECEIVE_USER AUDIT_USER VAULT_USER; do [[ "${!v}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { bad "invalid-${v,,}"; finish; }; done
[[ "$PROBE_HOST" =~ ^[A-Za-z0-9.-]{1,253}$ ]] && [[ "$PROBE_ADDR" =~ ^[0-9A-Fa-f.:]{1,45}$ ]] || { bad invalid-probe; finish; }
USERNAME_RE='^[a-z_][a-z0-9_-]{0,31}$'
[ -z "$OPERATOR_USERS" ] || [[ "$OPERATOR_USERS" =~ ^[a-z_][a-z0-9_-]{0,31}(,[a-z_][a-z0-9_-]{0,31})*$ ]] || { bad invalid-operator-users; finish; }
PUBLISHER="$BIN_DIR/offhost-publish.sh"
mode_ok() { local m; m="$(stat -c %a "$1" 2>/dev/null)" || return 1; [ $(( 8#$m & 8#022 )) = 0 ]; }   # no group/world write
root_owned() { [ "$(stat -c %u:%g "$1" 2>/dev/null)" = "0:0" ]; }
home_of() {
  if [ -n "$HOME_BASE" ]; then echo "$HOME_BASE/$1"; else getent passwd "$1" | cut -d: -f6; fi
}
shell_of() { getent passwd "$1" | cut -d: -f7; }
# shadow_field USER → the password field of the account (never printed)
shadow_field() {
  if [ -n "$SHADOW_SOURCE" ]; then awk -F: -v u="$1" '$1 == u { print $2; exit }' "$SHADOW_SOURCE" 2>/dev/null
  else getent shadow "$1" 2>/dev/null | cut -d: -f2; fi
}

# ── install root and bin directory ───────────────────────────────────────────
r=ok
for d in "$INSTALL_ROOT" "$BIN_DIR"; do
  { [ -d "$d" ] && [ ! -L "$d" ]; } || { r=missing; break; }
  root_owned "$d" || { r=owner; break; }
  mode_ok "$d" || { r=writable; break; }
done
[ "$r" = ok ] && ok install-root || bad "install-root-$r"

# ── bin files ────────────────────────────────────────────────────────────────
r=ok
for f in offhost-lib.sh offhost-receive.sh offhost-publish.sh offhost-audit.sh offhost-retain.sh; do
  p="$BIN_DIR/$f"
  { [ -f "$p" ] && [ ! -L "$p" ]; } || { r="missing:$f"; break; }
  root_owned "$p" || { r="owner:$f"; break; }
  mode_ok "$p" || { r="writable:$f"; break; }
  [ "$f" = offhost-lib.sh ] || [ -x "$p" ] || { r="not-executable:$f"; break; }
done
if [ "$r" = ok ] && [ -d "$BIN_DIR" ]; then
  for p in "$BIN_DIR"/* "$BIN_DIR"/.[!.]*; do
    [ -e "$p" ] || continue
    [ -L "$p" ] && { r="symlink:${p##*/}"; break; }
    root_owned "$p" && mode_ok "$p" || { r="foreign:${p##*/}"; break; }
  done
fi
case "$r" in ok) ok bin-files ;; *) bad "bin-file-${r%%:*}" "${r#*:}" ;; esac

# ── configuration ────────────────────────────────────────────────────────────
if { [ -f "$CONFIG" ] && [ ! -L "$CONFIG" ]; }; then
  if ! root_owned "$CONFIG"; then bad config-owner
  elif ! mode_ok "$CONFIG"; then bad config-mode
  elif ! ( lcp_load_config "$CONFIG" "$LCP_VAULT_CONFIG_KEYS" 2>/dev/null ); then bad config-invalid
  else
    ( lcp_load_config "$CONFIG" "$LCP_VAULT_CONFIG_KEYS" 2>/dev/null
      lcp_capacity_settings_ok "${OFFHOST_MAX_GENERATIONS_PER_SLOT:-$LCP_DEFAULT_MAX_GENERATIONS_PER_SLOT}" \
        "${OFFHOST_MIN_FREE_BYTES:-$LCP_DEFAULT_MIN_FREE_BYTES}" "${OFFHOST_MAX_ARCHIVE_BYTES:-$LCP_DEFAULT_MAX_ARCHIVE_BYTES}" ) \
      && ok config || bad config-limits
  fi
else bad config-missing; fi

# ── sudoers drop-in: file shape, intended Defaults, exactly one NOSETENV rule ──
if { [ -f "$SUDOERS" ] && [ ! -L "$SUDOERS" ]; }; then
  if ! root_owned "$SUDOERS"; then bad sudoers-owner
  elif [ "$(stat -c %a "$SUDOERS")" != 440 ]; then bad sudoers-mode
  elif ! command -v visudo >/dev/null 2>&1; then bad sudoers-visudo-unavailable
  elif ! visudo -cf "$SUDOERS" >/dev/null 2>&1; then bad sudoers-syntax
  else
    defaults_opts="$(grep -E "^[[:space:]]*Defaults:$RECEIVE_USER[[:space:]]" "$SUDOERS" | sed -E "s/^[[:space:]]*Defaults:$RECEIVE_USER[[:space:]]+//" | tr ',' '\n' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
    rules="$(grep -vE '^[[:space:]]*(#|Defaults|$)' "$SUDOERS" || true)"
    if ! printf '%s\n' "$defaults_opts" | grep -qx 'env_reset' || ! printf '%s\n' "$defaults_opts" | grep -qx '!requiretty' || ! printf '%s\n' "$defaults_opts" | grep -qx 'use_pty'; then bad sudoers-defaults
    elif printf '%s\n' "$rules" | grep -qE '(^|[[:space:]])SETENV:'; then bad sudoers-setenv
    elif [ "$(printf '%s\n' "$rules" | grep -c .)" != 1 ]; then bad sudoers-rule-count
    elif ! printf '%s\n' "$rules" | grep -qxE "$RECEIVE_USER ALL=\(root\) (NOPASSWD: NOSETENV: |NOSETENV: NOPASSWD: )$PUBLISHER"; then bad sudoers-rule
    else ok sudoers; fi
  fi
else bad sudoers-missing; fi

# ── effective sudo authority of the receive account (read-only listing) ──────
# `sudo -l -U` lists what every sudoers source grants; nothing is executed.
SUDO_CMD_RE='^\(([^)]*)\) ((([A-Z]+:) )*)(.*)$'   # "(runas) TAG: TAG: command"
# the listing and its parsing run under a deterministic locale
if ! command -v "$SUDO_BIN" >/dev/null 2>&1 || ! listing="$(LC_ALL=C "$SUDO_BIN" -n -l -U "$RECEIVE_USER" 2>/dev/null)"; then bad sudo-effective-unparseable
elif printf '%s\n' "$listing" | grep -q 'is not allowed to run sudo'; then bad sudo-effective-no-grant
elif ! printf '%s\n' "$listing" | grep -q 'may run the following commands'; then bad sudo-effective-unparseable
else
  # sudo wraps long lines at a default width even when writing to a file:
  # rebuild the logical entries first (continuation lines are indented and do
  # not start with "("), then evaluate them.
  sect=""; eff_defaults_joined=""; cmds=()
  while IFS= read -r line; do
    stripped="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      "Matching Defaults entries"*) sect=defaults; continue ;;
      "User "*" may run the following commands"*) sect=cmds; continue ;;
    esac
    if [ -z "$stripped" ]; then sect=""; continue; fi
    case "$sect" in
      defaults) eff_defaults_joined="$eff_defaults_joined $stripped" ;;
      cmds) if [[ "$stripped" == \(* ]]; then cmds+=("$stripped"); elif [ "${#cmds[@]}" -gt 0 ]; then cmds[${#cmds[@]}-1]="${cmds[${#cmds[@]}-1]} $stripped"; fi ;;
    esac
  done <<<"$listing"
  eff_defaults="$(printf '%s\n' "$eff_defaults_joined" | LC_ALL=C tr ',' '\n' | LC_ALL=C sed -E 's/^[[:space:]]+|[[:space:]]+$//g' | grep -v '^$')"
  ncmd="${#cmds[@]}"
  all_cmds="$(printf '%s\n' "${cmds[@]+"${cmds[@]}"}")"
  # every safe token must be present AND its inverse absent: another sudoers
  # source may append "!env_reset", "requiretty" or "!use_pty" after ours and
  # the later entry wins for sudo, so presence of the safe token alone proves nothing
  has_tok() { printf '%s\n' "$eff_defaults" | grep -qx -- "$1"; }
  d_ok=1
  { has_tok env_reset && ! has_tok '!env_reset'; } || { bad sudo-effective-env-reset; d_ok=0; }
  { has_tok '!requiretty' && ! has_tok requiretty; } || { bad sudo-effective-requiretty; d_ok=0; }
  { has_tok use_pty && ! has_tok '!use_pty'; } || { bad sudo-effective-use-pty; d_ok=0; }
  # the command set is evaluated independently of the Defaults verdict
  if printf '%s\n' "$all_cmds" | grep -qE '(^|[[:space:]])SETENV:'; then bad sudo-effective-setenv
  elif [ "$ncmd" != 1 ]; then bad sudo-effective-extra-command "commands=$ncmd"
  elif ! [[ "${cmds[0]}" =~ $SUDO_CMD_RE ]]; then bad sudo-effective-unparseable
  else
    runas="${BASH_REMATCH[1]}"; tags="${BASH_REMATCH[2]}"; command="${BASH_REMATCH[5]}"
    command="$(printf '%s' "$command" | sed -E 's/[[:space:]]+$//')"
    if [ "$command" != "$PUBLISHER" ]; then bad sudo-effective-extra-command "not-publisher"
    elif [ "$runas" != root ]; then bad sudo-effective-runas
    elif ! [[ " $tags" =~ \ NOPASSWD:\  ]] || ! [[ " $tags" =~ \ NOSETENV:\  ]]; then bad sudo-effective-tags
    elif [ "$d_ok" = 1 ]; then ok sudo-effective; fi
  fi
fi

# ── forced-command key inventory: exactly 1 receive key + 2 audit keys, distinct ─
# Every key must be a COMPLETE OpenSSH public key (B23 G-6D C4): two
# independent validations, both mandatory, neither prints the key.
#   1. complete wire-structure parse (python3, standard library only): strict
#      base64, "string type" equal to the declared type, for ssh-ed25519 a
#      "string key" of exactly 32 bytes, for sk-ssh-ed25519@openssh.com the
#      32-byte key plus a non-empty "string application", every length field
#      inside the data, and NO trailing bytes;
#   2. the OpenSSH tooling itself: `ssh-keygen -l -f -` with "<type> <blob>" on
#      stdin, output suppressed (OFFHOST_SSH_KEYGEN_BIN, default ssh-keygen);
#      an unavailable validator fails closed (authorized-keys-validator-unavailable).
SSH_KEYGEN_BIN="${OFFHOST_SSH_KEYGEN_BIN:-ssh-keygen}"
blob_structure_ok() {   # TYPE BLOB → 0 iff the blob is a complete key of that type
  python3 - "$1" "$2" <<'PY'
import base64, binascii, struct, sys
declared, b64 = sys.argv[1], sys.argv[2]
try:
    raw = base64.b64decode(b64, validate=True)
except (binascii.Error, ValueError):
    sys.exit(1)
def rd(buf, off):
    if off + 4 > len(buf):
        raise ValueError("length field outside data")
    n = struct.unpack(">I", buf[off:off + 4])[0]
    if off + 4 + n > len(buf):
        raise ValueError("field outside data")
    return buf[off + 4:off + 4 + n], off + 4 + n
try:
    t, off = rd(raw, 0)
    if t != declared.encode("ascii"):
        sys.exit(1)
    key, off = rd(raw, off)
    if len(key) != 32:
        sys.exit(1)
    if declared == "sk-ssh-ed25519@openssh.com":
        app, off = rd(raw, off)
        if not (1 <= len(app) <= 1024):
            sys.exit(1)
    elif declared != "ssh-ed25519":
        sys.exit(1)
    if off != len(raw):
        sys.exit(1)          # trailing bytes
except ValueError:
    sys.exit(1)
sys.exit(0)
PY
}
key_tool_ok() {   # TYPE BLOB → 0 iff OpenSSH tooling accepts the public key (nothing printed)
  printf '%s %s\n' "$1" "$2" | "$SSH_KEYGEN_BIN" -l -f - >/dev/null 2>&1
}
KEY_VALIDATOR=ok
command -v "$SSH_KEYGEN_BIN" >/dev/null 2>&1 || KEY_VALIDATOR=missing
command -v python3 >/dev/null 2>&1 || KEY_VALIDATOR=missing
KEY_FPS=()
check_keys() {   # USER FORCED-SCRIPT LABEL EXPECTED-COUNT
  local u="$1" script="$2" label="$3" want="$4" h d f n=0 line opts type blob fp
  h="$(home_of "$u")"; [ -n "$h" ] && [ -d "$h" ] || { bad "authorized-keys-$label-home"; return; }
  d="$h/.ssh"; f="$d/authorized_keys"
  { [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -c %U "$d")" = "$u" ] && [ "$(stat -c %a "$d")" = 700 ]; } || { bad "authorized-keys-$label-dir"; return; }
  { [ -f "$f" ] && [ ! -L "$f" ] && [ "$(stat -c %U "$f")" = "$u" ] && [ "$(stat -c %a "$f")" = 600 ]; } || { bad "authorized-keys-$label-file"; return; }
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    n=$((n + 1))
    # options must be exactly restrict + the forced command; nothing else, nothing missing
    [[ "$line" =~ ^restrict,command=\"([^\"]*)\"\ (ssh-ed25519|sk-ssh-ed25519@openssh\.com)\ ([^[:space:]]+)([[:space:]].*)?$ ]] || { bad "authorized-keys-$label-unrestricted"; return; }
    opts="${BASH_REMATCH[1]}"; type="${BASH_REMATCH[2]}"; blob="${BASH_REMATCH[3]}"
    [ "$opts" = "$script" ] || { bad "authorized-keys-$label-unrestricted"; return; }
    [[ "$blob" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || { bad "authorized-keys-$label-malformed"; return; }
    blob_structure_ok "$type" "$blob" || { bad "authorized-keys-$label-malformed" "structure"; return; }
    key_tool_ok "$type" "$blob" || { bad "authorized-keys-$label-malformed" "tooling"; return; }
    fp="$(lcp_blob_fingerprint "$blob")" || { bad "authorized-keys-$label-malformed"; return; }
    KEY_FPS+=("$fp")
  done <"$f"
  [ "$n" = "$want" ] || { bad "authorized-keys-$label-count" "keys=$n"; return; }
  ok "authorized-keys-$label"
}
if [ "$KEY_VALIDATOR" = ok ]; then
  check_keys "$RECEIVE_USER" "$BIN_DIR/offhost-receive.sh" receive 1
  check_keys "$AUDIT_USER" "$BIN_DIR/offhost-audit.sh" audit 2
else
  bad authorized-keys-validator-unavailable   # fail closed: no key is accepted without the OpenSSH validator
fi
if [ "${#KEY_FPS[@]}" -ge 2 ]; then
  if [ "$(printf '%s\n' "${KEY_FPS[@]}" | sort | uniq -d | wc -l)" = 0 ]; then ok authorized-keys-distinct; else bad authorized-keys-duplicate; fi
fi

# ── vault account: no SSH key, no login shell ────────────────────────────────
vh="$(home_of "$VAULT_USER")"
if [ -n "$vh" ] && [ -s "$vh/.ssh/authorized_keys" ]; then bad vault-ssh-key-present
else
  case "$(shell_of "$VAULT_USER")" in */nologin|*/false) ok vault-no-ssh ;; *) bad vault-shell ;; esac
fi

# ── service accounts: no usable password (shadow field locked: '!' or '*') ──
r=ok
for pair in "$RECEIVE_USER:receive" "$AUDIT_USER:audit" "$VAULT_USER:vault"; do
  u="${pair%%:*}"; label="${pair##*:}"
  if [ -n "$SHADOW_SOURCE" ]; then readable=0; grep -qE "^$u:" "$SHADOW_SOURCE" 2>/dev/null && readable=1
  else readable=0; getent shadow "$u" >/dev/null 2>&1 && readable=1; fi
  if [ "$readable" != 1 ]; then bad "account-$label-shadow-unreadable"; r=bad; continue; fi
  field="$(shadow_field "$u")"
  case "$field" in '!'*|'*'*) ;; *) bad "account-$label-password-unlocked"; r=bad ;; esac
  field=""
done
[ "$r" = ok ] && ok accounts-locked

# ── group separation ─────────────────────────────────────────────────────────
vg="$(id -gn "$VAULT_USER" 2>/dev/null)"; ag="$(id -gn "$AUDIT_USER" 2>/dev/null)"
if [ -z "$vg" ] || [ -z "$ag" ]; then bad groups-account-missing
elif id -Gn "$RECEIVE_USER" 2>/dev/null | grep -qw "$vg" || id -Gn "$AUDIT_USER" 2>/dev/null | grep -qw "$vg"; then bad groups-vault-member
elif id -Gn "$RECEIVE_USER" 2>/dev/null | grep -qw "$ag" || id -Gn "$VAULT_USER" 2>/dev/null | grep -qw "$ag"; then bad groups-audit-member
else ok groups; fi

# ── sshd configuration files: Match criteria and Includes must keep the
#    per-user evaluation authoritative ─────────────────────────────────────────
# Strict installation profile (B23 G-6D C4, "Option A"): the main file may carry
# at most one Include and it must be exactly "<dir>/sshd_config.d/*.conf"; the
# scanned set is then every file that pattern matches; a fragment may not
# Include anything; every scanned file must be a regular, non-symlink,
# root-owned file that nobody else can write; Match blocks may use only the
# User (or All) criterion. Anything else fails closed, so the per-account
# `sshd -T -C` evaluation below covers the complete configuration sshd reads.
sshd_file_ok() {   # FILE → ok | not-regular | symlink | owner | writable | unreadable
  [ ! -L "$1" ] || { echo symlink; return; }
  [ -f "$1" ] || { echo not-regular; return; }
  root_owned "$1" || { echo owner; return; }
  mode_ok "$1" || { echo writable; return; }
  cat -- "$1" >/dev/null 2>&1 || { echo unreadable; return; }
  echo ok
}
# match_criteria_ok "<criteria tokens>" → 0 iff only "User <value>" pairs and/or "All"
match_criteria_ok() {
  set -f; set -- $1; set +f          # word-split only; never glob-expand configuration text
  [ "$#" -ge 1 ] || return 1
  while [ "$#" -ge 1 ]; do
    case "${1,,}" in
      all) shift ;;
      user) [ "$#" -ge 2 ] || return 1; shift 2 ;;
      *) return 1 ;;
    esac
  done
  return 0
}
cfg_dir="$(dirname "$SSHD_CONFIG")"
SSHD_PATH_OK=1
# the inspected path must resolve canonically to itself (no symlinked component) and
# live in a real, root-owned, non-group/world-writable directory
if [ "$(realpath -e "$SSHD_CONFIG" 2>/dev/null)" != "$SSHD_CONFIG" ]; then bad sshd-config-noncanonical; SSHD_PATH_OK=0
elif ! { [ -d "$cfg_dir" ] && [ ! -L "$cfg_dir" ] && [ "$(realpath -e "$cfg_dir" 2>/dev/null)" = "$cfg_dir" ] && root_owned "$cfg_dir" && mode_ok "$cfg_dir"; }; then bad sshd-config-dir; SSHD_PATH_OK=0; fi
cfg_r="$(sshd_file_ok "$SSHD_CONFIG")"
if [ "$SSHD_PATH_OK" != 1 ]; then :
elif [ "$cfg_r" != ok ]; then
  SSHD_PATH_OK=0
  case "$cfg_r" in not-regular|unreadable) bad sshd-config-missing ;; *) bad "sshd-config-$cfg_r" ;; esac
else
  r=ok; includes=0; frag_files=()
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      [Ii][Nn][Cc][Ll][Uu][Dd][Ee]\ *|[Ii][Nn][Cc][Ll][Uu][Dd][Ee]$'\t'*)
        set -f; set -- $line; set +f; shift   # word-split only; the pattern must stay literal
        includes=$((includes + 1))
        { [ "$#" = 1 ] && [ "$1" = "$cfg_dir/sshd_config.d/*.conf" ] && [ "$includes" = 1 ]; } || { r=include-unsupported; break; } ;;
      [Mm][Aa][Tt][Cc][Hh]\ *|[Mm][Aa][Tt][Cc][Hh]$'\t'*|[Mm][Aa][Tt][Cc][Hh])
        match_criteria_ok "${line#*[Mm][Aa][Tt][Cc][Hh]}" || { r=match-criteria; break; } ;;
    esac
  done < <(grep -viE '^[[:space:]]*#' "$SSHD_CONFIG" 2>/dev/null)
  if [ "$r" = ok ] && [ "$includes" = 1 ]; then
    dir_r=ok
    { [ -d "$cfg_dir/sshd_config.d" ] && [ ! -L "$cfg_dir/sshd_config.d" ]; } || dir_r=missing
    [ "$dir_r" != ok ] || root_owned "$cfg_dir/sshd_config.d" || dir_r=owner
    [ "$dir_r" != ok ] || mode_ok "$cfg_dir/sshd_config.d" || dir_r=writable
    if [ "$dir_r" != ok ]; then r="include-$dir_r"
    else
      for f in "$cfg_dir"/sshd_config.d/*.conf; do
        [ -e "$f" ] || [ -L "$f" ] || continue       # the pattern matched nothing: nothing to scan
        fr="$(sshd_file_ok "$f")"
        [ "$fr" = ok ] || { r="include-$fr"; break; }
        frag_files+=("$f")
      done
      [ "$r" != ok ] || for f in "${frag_files[@]+"${frag_files[@]}"}"; do
        while IFS= read -r line; do
          line="${line#"${line%%[![:space:]]*}"}"
          case "$line" in
            [Ii][Nn][Cc][Ll][Uu][Dd][Ee]\ *|[Ii][Nn][Cc][Ll][Uu][Dd][Ee]$'\t'*|[Ii][Nn][Cc][Ll][Uu][Dd][Ee]) r=include-nested; break 2 ;;
            [Mm][Aa][Tt][Cc][Hh]\ *|[Mm][Aa][Tt][Cc][Hh]$'\t'*|[Mm][Aa][Tt][Cc][Hh])
              match_criteria_ok "${line#*[Mm][Aa][Tt][Cc][Hh]}" || { r=match-criteria; break 2; } ;;
          esac
        done < <(grep -viE '^[[:space:]]*#' "$f" 2>/dev/null)
      done
    fi
  fi
  case "$r" in
    ok) ok sshd-config ;;
    match-criteria) bad sshd-match-criteria ;;
    include-unsupported) bad sshd-include-unsupported ;;
    include-nested) bad sshd-include-nested ;;
    include-*) bad "sshd-$r" ;;
  esac
fi

# ── effective sshd configuration of the INSPECTED file, globally and per account ─
# Both evaluations name the inspected file explicitly (-f), so what sshd
# resolves is exactly what the Include/Match scan above covered. Directive
# spellings follow the normalized `sshd -T` dump: lowercase keyword then the
# value; AllowUsers, AcceptEnv and SetEnv one token per line; AuthorizedKeysFile
# and AuthenticationMethods on one line. A required directive that is absent
# from the dump fails — absence is never read as "none" or "no".
v()     { printf '%s\n' "$1" | awk -v k="$2" 'tolower($1) == k { print tolower($2); exit }'; }
vline() { printf '%s\n' "$1" | awk -v k="$2" 'tolower($1) == k { $1 = ""; sub(/^ +/, ""); print; exit }'; }   # whole value, original case
vall()  { printf '%s\n' "$1" | awk -v k="$2" 'tolower($1) == k { for (i = 2; i <= NF; i++) print $i }'; }     # every token of every line
# accept_env_token_ok TOKEN → 0 iff the AcceptEnv token can only name a locale variable
accept_env_token_ok() {
  case "$1" in
    LANG|LANGUAGE|'LC_*') return 0 ;;
    LC_*) [[ "$1" =~ ^LC_[A-Z_]+$ ]] && return 0 ;;
  esac
  return 1
}
# account_boundary EFF LABEL → the authorization and environment boundary of one restricted account
account_boundary() {
  local e="$1" label="$2" r=ok tok
  [ "$(v "$e" passwordauthentication)" = no ] || { bad "sshd-$label-password-auth"; r=bad; }
  [ "$(v "$e" kbdinteractiveauthentication)" = no ] || [ "$(v "$e" challengeresponseauthentication)" = no ] || { bad "sshd-$label-interactive-auth"; r=bad; }
  [ "$(v "$e" pubkeyauthentication)" = yes ] || { bad "sshd-$label-pubkey-auth"; r=bad; }
  # only the public-key flow: AuthenticationMethods exactly "publickey", every other method off
  [ "$(vline "$e" authenticationmethods)" = publickey ] || { bad "sshd-$label-authentication-methods"; r=bad; }
  { [ "$(v "$e" hostbasedauthentication)" = no ] && [ "$(v "$e" gssapiauthentication)" = no ] && [ "$(v "$e" kerberosauthentication)" = no ] && [ "$(v "$e" permitemptypasswords)" = no ]; } || { bad "sshd-$label-alternate-auth"; r=bad; }
  # exactly one authorized-key source — the file the inventory check reads — and nothing else
  [ "$(vline "$e" authorizedkeysfile)" = ".ssh/authorized_keys" ] || { bad "sshd-$label-authorized-keys-file"; r=bad; }
  { [ "$(v "$e" authorizedkeyscommand)" = none ] && [ "$(v "$e" authorizedkeyscommanduser)" = none ]; } || { bad "sshd-$label-authorized-keys-command"; r=bad; }
  [ "$(v "$e" trustedusercakeys)" = none ] || { bad "sshd-$label-trusted-user-ca"; r=bad; }
  { [ "$(v "$e" authorizedprincipalsfile)" = none ] && [ "$(v "$e" authorizedprincipalscommand)" = none ] && [ "$(v "$e" authorizedprincipalscommanduser)" = none ]; } || { bad "sshd-$label-authorized-principals"; r=bad; }
  # the forced command attached to each key line must stay controlling
  [ "$(v "$e" forcecommand)" = none ] || { bad "sshd-$label-force-command"; r=bad; }
  [ "$(v "$e" strictmodes)" = yes ] || { bad "sshd-$label-strict-modes"; r=bad; }
  # no remotely or server-side controllable environment for the forced scripts
  [ "$(v "$e" permituserenvironment)" = no ] || { bad "sshd-$label-user-environment"; r=bad; }
  [ "$(printf '%s\n' "$e" | awk 'tolower($1) == "setenv"' | wc -l)" = 0 ] || { bad "sshd-$label-setenv"; r=bad; }
  while IFS= read -r tok; do
    [ -n "$tok" ] || continue
    accept_env_token_ok "$tok" || { bad "sshd-$label-acceptenv"; r=bad; break; }
  done < <(vall "$e" acceptenv)
  [ "$r" = ok ]
}
if [ "$SSHD_PATH_OK" != 1 ]; then :   # already reported: the inspected path is not trustworthy
elif ! command -v "$SSHD_BIN" >/dev/null 2>&1 || ! eff="$("$SSHD_BIN" -T -f "$SSHD_CONFIG" 2>/dev/null)" || [ -z "$eff" ]; then bad sshd-unavailable
else
  r=ok
  [ "$(v "$eff" permitrootlogin)" = no ] || { bad sshd-root-login; r=bad; }
  [ "$(v "$eff" passwordauthentication)" = no ] || { bad sshd-password-auth; r=bad; }
  [ "$(v "$eff" pubkeyauthentication)" = yes ] || { bad sshd-pubkey-auth; r=bad; }
  [ "$(v "$eff" kbdinteractiveauthentication)" = no ] || [ "$(v "$eff" challengeresponseauthentication)" = no ] || { bad sshd-interactive-auth; r=bad; }
  [ "$(v "$eff" forcecommand)" = none ] || { bad sshd-force-command; r=bad; }
  [ "$(v "$eff" permituserenvironment)" = no ] || { bad sshd-user-environment; r=bad; }
  # AllowUsers: literal user names only — no wildcard, negation, pattern list,
  # bracket, backslash or user@host form; the two service accounts exactly once,
  # never the vault, and no account outside the approved operator list
  allow="$(vall "$eff" allowusers)"
  if [ -z "$allow" ]; then bad sshd-allowusers-missing; r=bad
  else
    pat=0; while IFS= read -r tok; do [[ "$tok" =~ $USERNAME_RE ]] || pat=1; done <<<"$allow"
    [ "$pat" = 0 ] || { bad sshd-allowusers-pattern; r=bad; }
    n="$(printf '%s\n' "$allow" | grep -cx -- "$RECEIVE_USER")"
    if [ "$n" = 0 ]; then bad sshd-allowusers-receive; r=bad; elif [ "$n" != 1 ]; then bad sshd-allowusers-duplicate; r=bad; fi
    n="$(printf '%s\n' "$allow" | grep -cx -- "$AUDIT_USER")"
    if [ "$n" = 0 ]; then bad sshd-allowusers-audit; r=bad; elif [ "$n" != 1 ]; then bad sshd-allowusers-duplicate; r=bad; fi
    ! printf '%s\n' "$allow" | grep -qx -- "$VAULT_USER" || { bad sshd-allowusers-vault; r=bad; }
    while IFS= read -r tok; do
      [[ "$tok" =~ $USERNAME_RE ]] || continue
      case "$tok" in "$RECEIVE_USER"|"$AUDIT_USER"|"$VAULT_USER") continue ;; esac
      printf '%s\n' "$OPERATOR_USERS" | tr ',' '\n' | grep -qx -- "$tok" || { bad sshd-allowusers-unexpected; r=bad; break; }
    done <<<"$allow"
  fi
  [ "$r" = ok ] && ok sshd-global
  for pair in "$RECEIVE_USER:receive" "$AUDIT_USER:audit"; do
    u="${pair%%:*}"; label="${pair##*:}"
    if ! ueff="$("$SSHD_BIN" -T -f "$SSHD_CONFIG" -C "user=$u,host=$PROBE_HOST,addr=$PROBE_ADDR" 2>/dev/null)" || [ -z "$ueff" ]; then bad "sshd-$label-unavailable"; continue; fi
    account_boundary "$ueff" "$label" && ok "sshd-$label"
  done
fi

# ── hashes for the activation record (prefixes only here) ────────────────────
for f in offhost-publish.sh offhost-lib.sh offhost-receive.sh offhost-audit.sh offhost-retain.sh; do
  [ -f "$BIN_DIR/$f" ] && echo "install: hash $f=$(lcp_prefix "$(lcp_sha256 "$BIN_DIR/$f")")"
done
finish
