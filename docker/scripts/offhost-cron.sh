#!/bin/bash
# =============================================================================
# Lead Capture Pro — managed crontab block for the off-host backup copy (B23 G-6D)
# =============================================================================
# Installs, removes or reports the ONE managed block that runs
# docker/scripts/backup-offhost.sh at 03:30 UTC (after the 03:15 backup and
# before the 03:45 local freshness check):
#
#   # BEGIN LCP OFFHOST BACKUP
#   30 3 * * * OFFHOST_CONFIG=… bash …/docker/scripts/backup-offhost.sh >> …/offhost-receipts/offhost.log 2>&1
#   # END LCP OFFHOST BACKUP
#
# Everything is done with files, never with the crontab held in a shell
# variable: every unrelated byte of the existing crontab (tabs, trailing
# spaces, blank lines, comments, lines that merely mention "backup") is
# preserved, the candidate is validated before `crontab FILE`, the installed
# crontab is re-read and must be byte-identical to the candidate, and any
# post-install failure restores the saved copy and verifies it byte-for-byte.
# A rollback snapshot of the crontab as found is kept in the receipt
# directory (mode 600) and pruned by the uploader's receipt retention.
#
# The markers are matched as whole lines with fixed strings only; a corrupted
# or duplicated block aborts before anything is written. If the existing
# crontab lacks a final newline (cron itself never produces such a listing),
# a newline is added so the block can follow it; this is reported explicitly.
#
#   bash docker/scripts/offhost-cron.sh status    # read-only
#   bash docker/scripts/offhost-cron.sh install
#   bash docker/scripts/offhost-cron.sh remove
#
# Environment (optional): DEPLOY_PATH, OFFHOST_CONFIG, OFFHOST_RECEIPT_DIR,
# OFFHOST_CRON_LINE (override the exact entry — tests only).
# =============================================================================
set -Eeuo pipefail
umask 077

readonly MARK_B='# BEGIN LCP OFFHOST BACKUP'
readonly MARK_E='# END LCP OFFHOST BACKUP'
DEPLOY_PATH="${DEPLOY_PATH:-/opt/lead-capture-pro/app}"
OFFHOST_CONFIG="${OFFHOST_CONFIG:-/opt/lead-capture-pro/env/offhost.env}"
RECEIPT_DIR="${OFFHOST_RECEIPT_DIR:-/opt/lead-capture-pro/backups/offhost-receipts}"
CRON_LINE="${OFFHOST_CRON_LINE:-30 3 * * * OFFHOST_CONFIG=$OFFHOST_CONFIG bash $DEPLOY_PATH/docker/scripts/backup-offhost.sh >> $RECEIPT_DIR/offhost.log 2>&1}"

ACTION="${1:-}"
case "$ACTION" in install|remove|status) ;; *) echo "usage: offhost-cron.sh install|remove|status" >&2; exit 2 ;; esac
[[ "$CRON_LINE" =~ ^30\ 3\ \*\ \*\ \*\  ]] || { echo "[offhost-cron] ERROR: the managed entry must run at 03:30 UTC" >&2; exit 1; }

log()  { echo "[offhost-cron] $(date -u +%FT%TZ) $*"; }
die()  { echo "[offhost-cron] $(date -u +%FT%TZ) ERROR: $*" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/offhost-cron.XXXXXXXX")"
chmod 700 "$WORK"
INSTALLED=0; HAD_CRONTAB=1
cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$INSTALLED" = 1 ]; then
    # something failed AFTER `crontab FILE`: restore the saved copy from the file and verify it
    if [ "$HAD_CRONTAB" = 1 ]; then crontab "$WORK/current" || true; else crontab -r >/dev/null 2>&1 || true; fi
    if capture_crontab "$WORK/restored" && cmp -s "$WORK/current" "$WORK/restored"; then
      log "rollback: the crontab found before this run was restored and verified byte-for-byte"
    else
      echo "[offhost-cron] $(date -u +%FT%TZ) ERROR: rollback verification failed — inspect the snapshot in $RECEIPT_DIR" >&2
    fi
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# capture_crontab OUT — `crontab -l` into a file; "no crontab" becomes an empty file
capture_crontab() {
  local out="$1" rc=0
  : >"$out"
  crontab -l >"$out" 2>"$WORK/err" || rc=$?
  if [ "$rc" -ne 0 ]; then
    if grep -qiE 'no crontab for' "$WORK/err"; then : >"$out"; HAD_CRONTAB=0; return 0; fi
    return 1
  fi
  return 0
}
count_line() { grep -cxF -- "$1" "$2" || true; }   # whole-line, fixed-string
# strip_block IN OUT — copies every line outside the managed block byte-for-byte
strip_block() {
  awk -v b="$MARK_B" -v e="$MARK_E" 'BEGIN { skip = 0 } $0 == b { skip = 1; next } $0 == e { skip = 0; next } !skip { print }' "$1" >"$2"
}
# validate_structure FILE → 0 when the markers are absent or form exactly one well-formed block
validate_structure() {
  awk -v b="$MARK_B" -v e="$MARK_E" '
    BEGIN { inb = 0; blocks = 0; bad = 0 }
    $0 == b { if (inb) bad = 1; inb = 1; blocks++; next }
    $0 == e { if (!inb) bad = 1; inb = 0; next }
    END { if (inb) bad = 1; if (blocks > 1) bad = 1; exit(bad ? 1 : 0) }' "$1"
}
ends_with_newline() { [ ! -s "$1" ] || [ "$(tail -c 1 "$1" | od -An -c | tr -d ' ')" = '\n' ]; }

capture_crontab "$WORK/current" || die "crontab -l failed (not the 'no crontab' case) — nothing changed"
nb="$(count_line "$MARK_B" "$WORK/current")"; ne="$(count_line "$MARK_E" "$WORK/current")"
validate_structure "$WORK/current" || die "existing crontab has a corrupted or duplicated managed block (begin=$nb end=$ne) — nothing changed"
strip_block "$WORK/current" "$WORK/current.stripped"
normalized=0
if ! ends_with_newline "$WORK/current"; then normalized=1; fi

if [ "$ACTION" = status ]; then
  echo "status: managed_block=$([ "$nb" = 1 ] && echo present || echo absent) entry_present=$(count_line "$CRON_LINE" "$WORK/current") other_lines=$(grep -c . "$WORK/current.stripped" || true) had_crontab=$HAD_CRONTAB final_newline=$([ "$normalized" = 1 ] && echo missing || echo ok) unmanaged_sha256_prefix=$(sha256sum "$WORK/current.stripped" | cut -c1-12)"
  exit 0
fi

# rollback snapshot (mode 600, in the receipt directory) before any change
mkdir -p "$RECEIPT_DIR"; chmod 700 "$RECEIPT_DIR"
[ ! -L "$RECEIPT_DIR" ] || die "receipt directory must not be a symlink"
snap="$RECEIPT_DIR/crontab.before.$(date -u +%Y%m%dT%H%M%SZ).$$"
cp "$WORK/current" "$snap"; chmod 600 "$snap"

# candidate: unrelated lines verbatim (+ a final newline when it was missing), then the block once
cp "$WORK/current.stripped" "$WORK/new"
if [ "$ACTION" = install ]; then
  printf '%s\n%s\n%s\n' "$MARK_B" "$CRON_LINE" "$MARK_E" >>"$WORK/new"
fi
strip_block "$WORK/new" "$WORK/new.stripped"
cmp -s "$WORK/current.stripped" "$WORK/new.stripped" || die "candidate would alter unrelated crontab content — aborting before install"
validate_structure "$WORK/new" || die "candidate has an invalid managed block — aborting before install"
if [ "$ACTION" = install ]; then
  [ "$(count_line "$MARK_B" "$WORK/new")" = 1 ] && [ "$(count_line "$MARK_E" "$WORK/new")" = 1 ] && [ "$(count_line "$CRON_LINE" "$WORK/new")" = 1 ] || die "candidate must contain exactly one managed block — aborting"
  [ "$(grep -cE 'backup-offhost\.sh' "$WORK/new" || true)" = 1 ] || die "candidate mentions backup-offhost.sh more than once — aborting"
else
  [ "$(count_line "$MARK_B" "$WORK/new")" = 0 ] && [ "$(count_line "$MARK_E" "$WORK/new")" = 0 ] && [ "$(grep -cE 'backup-offhost\.sh' "$WORK/new" || true)" = 0 ] || die "candidate still contains the managed block — aborting"
fi
if cmp -s "$WORK/current" "$WORK/new"; then
  log "$ACTION: crontab already in the desired state (no change; snapshot $(basename "$snap") kept)"
  exit 0
fi

crontab "$WORK/new" || die "crontab rejected the candidate — the existing crontab is unchanged (snapshot $(basename "$snap"))"
INSTALLED=1
capture_crontab "$WORK/installed" || die "could not re-read the installed crontab"
cmp -s "$WORK/new" "$WORK/installed" || die "installed crontab differs from the validated candidate"
strip_block "$WORK/installed" "$WORK/installed.stripped"
cmp -s "$WORK/current.stripped" "$WORK/installed.stripped" || die "unrelated crontab content changed after install"
validate_structure "$WORK/installed" || die "installed crontab has an invalid managed block"
if [ "$ACTION" = install ]; then
  [ "$(count_line "$CRON_LINE" "$WORK/installed")" = 1 ] || die "installed crontab does not contain the managed entry exactly once"
else
  [ "$(count_line "$MARK_B" "$WORK/installed")" = 0 ] || die "installed crontab still contains the managed block"
fi
INSTALLED=0
log "$ACTION: done (unrelated lines preserved byte-for-byte; final_newline_normalized=$normalized; snapshot $(basename "$snap"))"
