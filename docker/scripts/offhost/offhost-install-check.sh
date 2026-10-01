#!/bin/bash
# =============================================================================
# Lead Capture Pro — backup VPS installation-integrity check (B23 G-6D C2)
# =============================================================================
# Runs as root ON THE BACKUP VPS before activation and at any later review.
# STRICTLY READ-ONLY: it inspects ownership, modes, sudoers, forced-command
# keys, group membership, the effective sshd configuration and records script
# hashes. It changes nothing and prints no secret (key material is never
# read beyond the option prefix of each authorized_keys line).
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
#                  passes, exactly one rule and it names the publisher path only
#   authorized-keys  receive and audit accounts: ~/.ssh 0700 and
#                  authorized_keys 0600, both owned by the account, at least one
#                  key, every key line restricted to the right forced command
#   vault-no-ssh   the vault account has no authorized key and a nologin shell
#   groups         receive and audit are not members of the vault group;
#                  receive and vault are not members of the audit group
#   sshd           `sshd -T` effective configuration: passwordauthentication no,
#                  kbdinteractiveauthentication no (or
#                  challengeresponseauthentication no), pubkeyauthentication
#                  yes, permitrootlogin no
#   hashes         sha256 prefix of every bin file, for the activation record
#                  (record the full `sha256sum` output separately)
#
# Summary: `OFFHOST_INSTALL=PASS checks=<n>` (exit 0) or
#          `OFFHOST_INSTALL=FAIL reasons=<code,…>` (exit 1).
# Inputs: OFFHOST_INSTALL_ROOT (/opt/lcp-offhost), OFFHOST_BIN_DIR
# (<root>/bin), OFFHOST_CONFIG (/etc/lcp-offhost/offhost.env), OFFHOST_SUDOERS
# (/etc/sudoers.d/lcp-offhost), OFFHOST_RECEIVE_USER, OFFHOST_AUDIT_USER,
# OFFHOST_VAULT_USER, OFFHOST_SSHD_BIN (sshd). Environment-only test hook:
# OFFHOST_HOME_BASE (home directories under <base>/<user> instead of passwd).
#
# This script proves the INSTALLED SHAPE only. Real forced-command semantics
# (restrict, SSH_ORIGINAL_COMMAND) must be exercised on the real server with
# the real keys before activation; nothing here claims that.
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
HOME_BASE="${OFFHOST_HOME_BASE:-}"
FAILS=(); CHECKS=0
ok()   { CHECKS=$((CHECKS + 1)); echo "install: $1=ok"; }
bad()  { FAILS+=("$1"); echo "install: $1=FAIL${2:+ ($2)}"; }
finish() {
  if [ "${#FAILS[@]}" = 0 ]; then echo "OFFHOST_INSTALL=PASS checks=$CHECKS"; exit 0; fi
  echo "OFFHOST_INSTALL=FAIL reasons=$(IFS=,; echo "${FAILS[*]}")"; exit 1
}
[ "$(id -u)" = 0 ] || { bad install-check-not-root; finish; }
for v in INSTALL_ROOT BIN_DIR CONFIG SUDOERS; do [[ "${!v}" =~ $LCP_PATH_RE ]] || { bad "invalid-${v,,}"; finish; }; done
for v in RECEIVE_USER AUDIT_USER VAULT_USER; do [[ "${!v}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { bad "invalid-${v,,}"; finish; }; done
mode_ok() { local m; m="$(stat -c %a "$1" 2>/dev/null)" || return 1; [ $(( 8#$m & 8#022 )) = 0 ]; }   # no group/world write
root_owned() { [ "$(stat -c %u:%g "$1" 2>/dev/null)" = "0:0" ]; }
home_of() {
  if [ -n "$HOME_BASE" ]; then echo "$HOME_BASE/$1"; else getent passwd "$1" | cut -d: -f6; fi
}
shell_of() { getent passwd "$1" | cut -d: -f7; }

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

# ── sudoers drop-in ──────────────────────────────────────────────────────────
if { [ -f "$SUDOERS" ] && [ ! -L "$SUDOERS" ]; }; then
  if ! root_owned "$SUDOERS"; then bad sudoers-owner
  elif [ "$(stat -c %a "$SUDOERS")" != 440 ]; then bad sudoers-mode
  elif ! command -v visudo >/dev/null 2>&1; then bad sudoers-visudo-unavailable
  elif ! visudo -cf "$SUDOERS" >/dev/null 2>&1; then bad sudoers-syntax
  else
    rules="$(grep -vE '^[[:space:]]*(#|Defaults|$)' "$SUDOERS" || true)"
    if [ "$(printf '%s\n' "$rules" | grep -c .)" != 1 ]; then bad sudoers-rule-count
    elif ! printf '%s\n' "$rules" | grep -qxE "$RECEIVE_USER ALL=\(root\) NOPASSWD: $BIN_DIR/offhost-publish\.sh"; then bad sudoers-rule
    else ok sudoers; fi
  fi
else bad sudoers-missing; fi

# ── forced-command authorized_keys ───────────────────────────────────────────
check_keys() {   # USER FORCED-SCRIPT LABEL
  local u="$1" script="$2" label="$3" h d f n line
  h="$(home_of "$u")"; [ -n "$h" ] && [ -d "$h" ] || { bad "authorized-keys-$label-home"; return; }
  d="$h/.ssh"; f="$d/authorized_keys"
  { [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -c %U "$d")" = "$u" ] && [ "$(stat -c %a "$d")" = 700 ]; } || { bad "authorized-keys-$label-dir"; return; }
  { [ -f "$f" ] && [ ! -L "$f" ] && [ "$(stat -c %U "$f")" = "$u" ] && [ "$(stat -c %a "$f")" = 600 ]; } || { bad "authorized-keys-$label-file"; return; }
  n=0
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    n=$((n + 1))
    [[ "$line" =~ ^restrict,command=\"$script\"\ (ssh-ed25519|sk-ssh-ed25519@openssh\.com)\  ]] || { bad "authorized-keys-$label-unrestricted"; return; }
  done <"$f"
  [ "$n" -ge 1 ] || { bad "authorized-keys-$label-empty"; return; }
  ok "authorized-keys-$label"
}
check_keys "$RECEIVE_USER" "$BIN_DIR/offhost-receive.sh" receive
check_keys "$AUDIT_USER" "$BIN_DIR/offhost-audit.sh" audit

# ── vault account: no SSH key, no login shell ────────────────────────────────
vh="$(home_of "$VAULT_USER")"
if [ -n "$vh" ] && [ -s "$vh/.ssh/authorized_keys" ]; then bad vault-ssh-key-present
else
  case "$(shell_of "$VAULT_USER")" in */nologin|*/false) ok vault-no-ssh ;; *) bad vault-shell ;; esac
fi

# ── group separation ─────────────────────────────────────────────────────────
vg="$(id -gn "$VAULT_USER" 2>/dev/null)"; ag="$(id -gn "$AUDIT_USER" 2>/dev/null)"
if [ -z "$vg" ] || [ -z "$ag" ]; then bad groups-account-missing
elif id -Gn "$RECEIVE_USER" 2>/dev/null | grep -qw "$vg" || id -Gn "$AUDIT_USER" 2>/dev/null | grep -qw "$vg"; then bad groups-vault-member
elif id -Gn "$RECEIVE_USER" 2>/dev/null | grep -qw "$ag" || id -Gn "$VAULT_USER" 2>/dev/null | grep -qw "$ag"; then bad groups-audit-member
else ok groups; fi

# ── effective sshd configuration ─────────────────────────────────────────────
if ! command -v "$SSHD_BIN" >/dev/null 2>&1 || ! eff="$("$SSHD_BIN" -T 2>/dev/null)"; then bad sshd-unavailable
else
  v() { printf '%s\n' "$eff" | awk -v k="$1" 'tolower($1) == k { print tolower($2); exit }'; }
  if [ "$(v passwordauthentication)" != no ]; then bad sshd-password-auth
  elif [ "$(v pubkeyauthentication)" != yes ]; then bad sshd-pubkey-auth
  elif [ "$(v permitrootlogin)" != no ]; then bad sshd-root-login
  elif [ "$(v kbdinteractiveauthentication)" != no ] && [ "$(v challengeresponseauthentication)" != no ]; then bad sshd-interactive-auth
  else ok sshd; fi
fi

# ── hashes for the activation record (prefixes only here) ────────────────────
for f in offhost-publish.sh offhost-lib.sh offhost-receive.sh offhost-audit.sh offhost-retain.sh; do
  [ -f "$BIN_DIR/$f" ] && echo "install: hash $f=$(lcp_prefix "$(lcp_sha256 "$BIN_DIR/$f")")"
done
finish
