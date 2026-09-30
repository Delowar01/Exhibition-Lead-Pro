#!/bin/bash
# =============================================================================
# Lead Capture Pro — off-host backup auditor (BACKUP VPS, forced command)
# =============================================================================
# The ONLY program the audit identity can run (bound in
# ~lcp-audit/.ssh/authorized_keys with restrict,command="…/offhost-audit.sh").
# It is strictly LIST-ONLY: it answers
#
#   HELLO → the same sanitized identity line as the receiver
#   AUDIT → one header line, one line per published generation, one footer
#
# and never uploads, reads an archive, renames, overwrites, deletes or runs
# anything else. The audit user has traverse+list rights on published/ and
# read rights on receipts and manifests (0440 vault:audit) — the encrypted
# archives themselves are 0400 vault and cannot be opened by it; their sizes
# come from stat and their checksum prefixes from the publisher's receipts.
#
# Output (sanitized: names, sizes, timestamps, states, counts — never paths,
# contents or complete checksums):
#   LCP-OFFHOST/1 AUDIT now_utc=… machine=… hostkeys=… fsid=… root=ok current_slot=<label> window=<n>
#   generation slot=<label> set=<set> archive=present|missing archive_size=<n> archive_mtime_utc=<ts|none> archive_sha256_prefix=<12|none> archive_receipt=ok|missing|invalid manifest=present|missing manifest_receipt=ok|missing|invalid manifest_valid=yes|no complete=yes|no
#   LCP-OFFHOST/1 AUDIT_END generations=<n> complete=<n> incomplete=<n> pending=<n> pending_stale=<n> partial=<n> partial_stale=<n> orphans=<n> quarantine=<n> current_slot_complete=yes|no
#
# Consumers: the primary-side sender (post-upload verification) and the
# GitHub workflow backup-offhost-hostinger.yml (daily read-only health check).
# Non-secret configuration (OFFHOST_CONFIG): OFFHOST_ROOT, OFFHOST_SLOT_WINDOW,
# OFFHOST_STALE_SECONDS. Environment-only test hooks: OFFHOST_NOW,
# LCP_MACHINE_ID_FILE, LCP_HOSTKEY_DIR.
# =============================================================================
set -Eeuo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=offhost-lib.sh
source "$HERE/offhost-lib.sh"

reply()  { echo "$LCP_PROTOCOL $*"; }
reject() { reply "REJECTED reason=$1"; exit 2; }
trap 'reply "REJECTED reason=unexpected-error"; exit 2' ERR

lcp_load_config "${OFFHOST_CONFIG:-/etc/lcp-offhost/offhost.env}" "$LCP_VAULT_CONFIG_KEYS" 2>/dev/null || reject config-invalid
ROOT="${OFFHOST_ROOT:-/srv/lcp-offhost}"
WINDOW="${OFFHOST_SLOT_WINDOW:-2}"
STALE="${OFFHOST_STALE_SECONDS:-21600}"
NOW="${OFFHOST_NOW:-$(date -u +%s)}"
[[ "$ROOT" =~ $LCP_PATH_RE ]] && [[ "$WINDOW" =~ ^[0-9]{1,2}$ ]] && [[ "$STALE" =~ ^[0-9]{1,8}$ ]] && [[ "$NOW" =~ ^[0-9]+$ ]] || reject config-invalid

CMD="${SSH_ORIGINAL_COMMAND:-}"
[ -n "$CMD" ] || reject no-command
case "$CMD" in
  HELLO) lcp_hello_line "$ROOT"; exit 0 ;;
  AUDIT) ;;
  *) reject unsupported-command ;;
esac
lcp_root_ok "$ROOT" || reject root-unavailable
PUB="$ROOT/published"; INCOMING="$ROOT/incoming"; QUAR="$ROOT/quarantine"
CUR="$(lcp_slot_index "$NOW")"; CUR_LABEL="$(lcp_slot_label "$CUR")"
echo "$LCP_PROTOCOL AUDIT now_utc=$(lcp_utc "$NOW") machine=$(lcp_machine_hash) hostkeys=$(lcp_local_hostkey_fingerprints) fsid=$(lcp_fs_id "$ROOT") root=ok current_slot=$CUR_LABEL window=$WINDOW"

generations=0; complete=0; incomplete=0; orphans=0; cur_complete=no
if [ -d "$PUB" ]; then
  for d in "$PUB"/*; do
    [ -e "$d" ] || continue
    label="${d##*/}"
    if [ ! -d "$d" ] || [ -L "$d" ] || ! [[ "$label" =~ $LCP_SLOT_LABEL_RE ]]; then orphans=$((orphans + 1)); continue; fi
    # entries that are not a validated archive/manifest/receipt of a set are orphans (incl. leftover .publish temporaries)
    for f in "$d"/* "$d"/.[!.]*; do
      [ -e "$f" ] || continue
      n="${f##*/}"; base="${n%.receipt}"
      if [ -L "$f" ] || [ ! -f "$f" ] || ! lcp_object_kind "$base"; then orphans=$((orphans + 1)); fi
    done
    while IFS= read -r set; do
      [ -n "$set" ] || continue
      state="$(lcp_generation_state "$d" "$set")"
      echo "generation slot=$label set=$set $state"
      generations=$((generations + 1))
      case "$state" in
        *" complete=yes") complete=$((complete + 1)); [ "$label" = "$CUR_LABEL" ] && cur_complete=yes ;;
        *) incomplete=$((incomplete + 1)) ;;
      esac
    done < <(lcp_slot_sets "$d")
  done
fi
pending=0; pending_stale=0; partial=0; partial_stale=0
if [ -d "$INCOMING" ]; then
  for f in "$INCOMING"/*.pending "$INCOMING"/.*.partial; do
    [ -e "$f" ] || continue
    age=$(( NOW - $(stat -c %Y "$f") ))
    case "$f" in
      *.pending) pending=$((pending + 1)); [ "$age" -gt "$STALE" ] && pending_stale=$((pending_stale + 1)) ;;
      *.partial) partial=$((partial + 1)); [ "$age" -gt "$STALE" ] && partial_stale=$((partial_stale + 1)) ;;
    esac
  done
fi
quarantine=0
if [ -d "$QUAR" ]; then for d in "$QUAR"/*; do [ -e "$d" ] && quarantine=$((quarantine + 1)); done; fi
echo "$LCP_PROTOCOL AUDIT_END generations=$generations complete=$complete incomplete=$incomplete pending=$pending pending_stale=$pending_stale partial=$partial partial_stale=$partial_stale orphans=$orphans quarantine=$quarantine current_slot_complete=$cur_complete"
exit 0
