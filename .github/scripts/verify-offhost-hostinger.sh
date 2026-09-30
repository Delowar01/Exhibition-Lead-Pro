#!/bin/bash
# =============================================================================
# Lead Capture Pro — off-host (Hostinger backup VPS) health verifier
# (runs ON THE GITHUB RUNNER; strictly read-only; B23 G-6D C1)
# =============================================================================
# The workflow backup-offhost-hostinger.yml connects to the BACKUP VPS with
# the audit identity (forced command offhost-audit.sh, list-only) and saves
# its AUDIT output to a file. This script evaluates that file on the runner:
# nothing is piped to the backup VPS, no backup is initiated, no dump byte
# ever reaches the runner (the audit identity cannot read archives at all).
#
# Inputs (environment):
#   AUDIT_LOG               file holding the AUDIT output           (required)
#   BACKUP_KNOWN_HOSTS      pinned known_hosts of the backup VPS    (required)
#   PRIMARY_KNOWN_HOSTS     pinned known_hosts of the primary VPS   (required)
#   EXPECTED_MACHINE        optional sha256 of the backup VPS machine-id
#   NOW                     epoch seconds (default: runner clock, UTC)
#   TRANSFER_GRACE_MINUTES  minutes after 03:15 UTC before the current slot
#                           is REQUIRED off-host (default 90: the primary
#                           transfer runs at 03:50 UTC); before that the
#                           previous slot is the expected one — a run that
#                           starts early or late therefore never produces a
#                           false stale verdict
#   MIN_ARCHIVE_BYTES       default 1024
#   OFFHOST_LIB             path of docker/scripts/offhost/offhost-lib.sh
#
# Assertions: protocol header present, root=ok, remote clock within 15 min of
# the runner, backup VPS is NOT the primary VPS (its pinned and self-reported
# host-key fingerprints share nothing with the primary's pinned fingerprints;
# hostnames are never used for this), the self-reported fingerprints include a
# pinned one, optional machine pin, no stale incoming files, no orphans, and a
# COMPLETE generation for the expected slot whose archive is large enough.
#
# Exit 0 and print exactly one line
#   OFFHOST_HEALTH=PASS slot=<label> set=<set> archive_size=<n> generations=<n> complete=<n> expected=<current|previous>
# only when everything holds; otherwise print
#   OFFHOST_HEALTH=FAIL reason=<code>[ detail=<safe values>]
# and exit 1. Output never contains paths, contents or complete checksums.
# Library mode: VERIFY_OFFHOST_LIB=1 source … loads the pure function only.
# =============================================================================
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OFFHOST_LIB="${OFFHOST_LIB:-$HERE/../../docker/scripts/offhost/offhost-lib.sh}"
# shellcheck source=../../docker/scripts/offhost/offhost-lib.sh
source "$OFFHOST_LIB"

# expected_slot_index NOW_EPOCH GRACE_MINUTES → the slot whose generation must
# be off-host: the current slot once the transfer grace has elapsed, else the
# previous one. Pure; used by the deterministic harness.
expected_slot_index() {
  local now="$1" grace="$2" cur
  [[ "$now" =~ ^[0-9]+$ ]] && [[ "$grace" =~ ^[0-9]+$ ]] || return 1
  cur="$(lcp_slot_index "$now")"
  if [ "$now" -ge $(( $(lcp_slot_start "$cur") + grace * 60 )) ]; then echo "$cur"; else echo $(( cur - 1 )); fi
}
if [ "${VERIFY_OFFHOST_LIB:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

set -Eeuo pipefail
STEP=init
trap 'rc=$?; echo "OFFHOST_HEALTH=FAIL reason=unexpected-error detail=step=$STEP,exit=$rc"; exit 1' ERR
fail() { echo "OFFHOST_HEALTH=FAIL reason=$1${2:+ detail=$2}"; exit 1; }

STEP=inputs
LOG="${AUDIT_LOG:-}"; BKH="${BACKUP_KNOWN_HOSTS:-}"; PKH="${PRIMARY_KNOWN_HOSTS:-}"
NOW="${NOW:-$(date -u +%s)}"; GRACE="${TRANSFER_GRACE_MINUTES:-90}"; MIN_BYTES="${MIN_ARCHIVE_BYTES:-1024}"
EXPECTED_MACHINE="${EXPECTED_MACHINE:-}"
[ -n "$LOG" ] && [ -f "$LOG" ] || fail audit-log-missing
[ -n "$BKH" ] && [ -f "$BKH" ] || fail backup-known-hosts-missing
[ -n "$PKH" ] && [ -f "$PKH" ] || fail primary-known-hosts-missing
[[ "$NOW" =~ ^[0-9]+$ ]] && [[ "$GRACE" =~ ^[0-9]{1,4}$ ]] && [[ "$MIN_BYTES" =~ ^[0-9]{1,12}$ ]] || fail invalid-inputs
[ -z "$EXPECTED_MACHINE" ] || [[ "$EXPECTED_MACHINE" =~ $LCP_SHA256_RE ]] || fail invalid-expected-machine

STEP=header
header="$(grep -m1 -E "^$LCP_PROTOCOL AUDIT " "$LOG" || true)"
[ -n "$header" ] || { grep -qE "^$LCP_PROTOCOL REJECTED " "$LOG" && fail audit-rejected "$(grep -m1 -oE 'reason=[a-z0-9-]+' "$LOG")"; fail audit-header-missing; }
[[ "$header" =~ ^$LCP_PROTOCOL\ AUDIT\ now_utc=([0-9T:Z-]+)\ machine=([0-9a-f]{64}|unknown)\ hostkeys=([A-Za-z0-9+/:,]+|unknown)\ fsid=([0-9a-fx]+|unknown)\ root=(ok|missing)\ current_slot=([0-9]{8}-[0-9]{4})\ window=([0-9]+)$ ]] || fail audit-header-invalid
R_NOW="${BASH_REMATCH[1]}"; R_MACHINE="${BASH_REMATCH[2]}"; R_HOSTKEYS="${BASH_REMATCH[3]}"; R_ROOT="${BASH_REMATCH[5]}"; R_SLOT="${BASH_REMATCH[6]}"
footer="$(grep -m1 -E "^$LCP_PROTOCOL AUDIT_END " "$LOG" || true)"
[ -n "$footer" ] || fail audit-footer-missing
[[ "$footer" =~ \ generations=([0-9]+)\ complete=([0-9]+)\ incomplete=([0-9]+)\ pending=([0-9]+)\ pending_stale=([0-9]+)\ partial=([0-9]+)\ partial_stale=([0-9]+)\ orphans=([0-9]+)\ quarantine=([0-9]+)\ current_slot_complete=(yes|no)$ ]] || fail audit-footer-invalid
GENS="${BASH_REMATCH[1]}"; COMPLETE="${BASH_REMATCH[2]}"; PENDING_STALE="${BASH_REMATCH[5]}"; PARTIAL_STALE="${BASH_REMATCH[7]}"; ORPHANS="${BASH_REMATCH[8]}"; QUAR="${BASH_REMATCH[9]}"
[ "$R_ROOT" = ok ] || fail vault-root-missing
r_epoch="$(date -u -d "$R_NOW" +%s 2>/dev/null)" || fail audit-clock-invalid
skew=$(( NOW - r_epoch )); [ "${skew#-}" -le 900 ] || fail clock-skew "seconds=${skew#-}"
echo "verifier: runner_utc=$(lcp_utc "$NOW") backup_vps_utc=$R_NOW skew_seconds=${skew#-} remote_current_slot=$R_SLOT"

STEP=identity
B_PINNED="$(lcp_known_hosts_fingerprints "$BKH")"; P_PINNED="$(lcp_known_hosts_fingerprints "$PKH")"
[ "$B_PINNED" != unknown ] || fail backup-known-hosts-unparsable
[ "$P_PINNED" != unknown ] || fail primary-known-hosts-unparsable
! lcp_lists_intersect "$B_PINNED" "$P_PINNED" || fail same-host-destination "pinned-hostkeys"
[ "$R_HOSTKEYS" != unknown ] || fail destination-hostkeys-unreported
! lcp_lists_intersect "$R_HOSTKEYS" "$P_PINNED" || fail same-host-destination "reported-hostkeys"
lcp_lists_intersect "$R_HOSTKEYS" "$B_PINNED" || fail hostkey-mismatch
[ "$R_MACHINE" != unknown ] || fail destination-machine-unreported
[ -z "$EXPECTED_MACHINE" ] || [ "$R_MACHINE" = "$EXPECTED_MACHINE" ] || fail machine-mismatch
echo "identity: backup_vps_machine=$(lcp_prefix "$R_MACHINE") same_host=no pinned_hostkey=reported"

STEP=hygiene
[ "$PARTIAL_STALE" = 0 ] && [ "$PENDING_STALE" = 0 ] || fail stale-incoming-files "partial_stale=$PARTIAL_STALE,pending_stale=$PENDING_STALE"
[ "$ORPHANS" = 0 ] || fail orphan-files "orphans=$ORPHANS"
echo "hygiene: stale_incoming=0 orphans=0 quarantine=$QUAR"

STEP=generation
EXP_IDX="$(expected_slot_index "$NOW" "$GRACE")"; EXP_LABEL="$(lcp_slot_label "$EXP_IDX")"
which=current; [ "$EXP_IDX" = "$(lcp_slot_index "$NOW")" ] || which=previous
echo "slot: expected=$EXP_LABEL ($which; grace_minutes=$GRACE)"
best_set=""; best_size=0; seen=0; incomplete_seen=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  seen=$((seen + 1))
  [[ "$line" =~ ^generation\ slot=$EXP_LABEL\ set=(leadcapture-[0-9]{8}-[0-9]{6}\.sql\.gz)\ archive=(present|missing)\ archive_size=([0-9]+)\ .*\ complete=(yes|no)$ ]] || fail audit-generation-line-invalid
  if [ "${BASH_REMATCH[4]}" = yes ]; then
    if [ "${BASH_REMATCH[3]}" -ge "$MIN_BYTES" ] && [[ "${BASH_REMATCH[1]}" > "$best_set" ]]; then best_set="${BASH_REMATCH[1]}"; best_size="${BASH_REMATCH[3]}"; fi
  else incomplete_seen=$((incomplete_seen + 1)); fi
done < <(grep -E "^generation slot=$EXP_LABEL " "$LOG" || true)
[ "$seen" -gt 0 ] || fail expected-generation-missing "slot=$EXP_LABEL"
[ -n "$best_set" ] || { [ "$incomplete_seen" -gt 0 ] && fail expected-generation-incomplete "slot=$EXP_LABEL"; fail archive-too-small "slot=$EXP_LABEL"; }
STEP=done
echo "OFFHOST_HEALTH=PASS slot=$EXP_LABEL set=$best_set archive_size=$best_size generations=$GENS complete=$COMPLETE expected=$which"
exit 0
