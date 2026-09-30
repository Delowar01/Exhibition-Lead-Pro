#!/bin/bash
# =============================================================================
# Lead Capture Pro — off-host backup retention (BACKUP VPS, vault identity)
# =============================================================================
# Runs ON the backup VPS only, as the vault identity that owns published/
# (never over SSH, never by the upload or audit identity; documented cron —
# NOT activated by this branch). DRY-RUN by default: it prints the plan and
# changes nothing. Only `--apply` performs the actions.
#
# Rules (age is measured from the generation's SLOT, never from mtimes):
#   * a COMPLETE generation (archive + manifest + both receipts consistent) is
#     KEPT while younger than OFFHOST_RETAIN_DAYS;
#   * the newest OFFHOST_PROTECT_NEWEST complete generations are ALWAYS kept,
#     whatever their age — retention can never empty the vault;
#   * an INCOMPLETE generation older than OFFHOST_QUARANTINE_AFTER_DAYS is
#     moved to quarantine/<slot>/ (never deleted directly; a human decides);
#   * quarantined files are deleted OFFHOST_RETAIN_DAYS after they were
#     quarantined (their mtime is reset at quarantine time).
#
# Safety: the root must carry the activation marker and resolve to itself
# (lcp_root_ok); every path is built from validated slot labels and object
# names — no unvalidated glob is ever passed to rm or mv; nothing outside
# <root>/published and <root>/quarantine is touched. Output:
#   retain: slot=<label> set=<set> action=keep|delete|quarantine reason=<code>
#   OFFHOST_RETAIN=DRY_RUN|APPLIED generations=<n> kept=<n> protected=<n> deleted=<n> quarantined=<n> purged=<n>
# Non-secret configuration (OFFHOST_CONFIG): OFFHOST_ROOT, OFFHOST_RETAIN_DAYS
# (35), OFFHOST_PROTECT_NEWEST (7), OFFHOST_QUARANTINE_AFTER_DAYS (2).
# Environment-only test hook: OFFHOST_NOW.
# =============================================================================
set -Eeuo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=offhost-lib.sh
source "$HERE/offhost-lib.sh"

die() { echo "OFFHOST_RETAIN=FAIL reason=$1"; exit 1; }
trap 'echo "OFFHOST_RETAIN=FAIL reason=unexpected-error"; exit 1' ERR
APPLY=0
case "${1:-}" in "") ;; --apply) APPLY=1 ;; --dry-run) ;; *) die usage ;; esac

lcp_load_config "${OFFHOST_CONFIG:-/etc/lcp-offhost/offhost.env}" "$LCP_VAULT_CONFIG_KEYS" 2>/dev/null || die config-invalid
ROOT="${OFFHOST_ROOT:-/srv/lcp-offhost}"
RETAIN_DAYS="${OFFHOST_RETAIN_DAYS:-35}"
PROTECT="${OFFHOST_PROTECT_NEWEST:-7}"
QUAR_AFTER="${OFFHOST_QUARANTINE_AFTER_DAYS:-2}"
NOW="${OFFHOST_NOW:-$(date -u +%s)}"
[[ "$ROOT" =~ $LCP_PATH_RE ]] || die config-invalid
[[ "$RETAIN_DAYS" =~ ^[0-9]{1,4}$ ]] && [ "$RETAIN_DAYS" -ge 1 ] || die config-invalid
[[ "$PROTECT" =~ ^[0-9]{1,3}$ ]] && [ "$PROTECT" -ge 1 ] || die config-invalid
[[ "$QUAR_AFTER" =~ ^[0-9]{1,4}$ ]] && [[ "$NOW" =~ ^[0-9]+$ ]] || die config-invalid
lcp_root_ok "$ROOT" || die root-unavailable
PUB="$ROOT/published"; QUAR="$ROOT/quarantine"
{ [ -d "$PUB" ] && [ ! -L "$PUB" ]; } || die root-layout
[ -d "$QUAR" ] || [ "$APPLY" = 0 ] || mkdir -m 0700 -- "$QUAR"
[ ! -L "$QUAR" ] || die quarantine-symlink
MODE_LABEL=DRY_RUN; [ "$APPLY" = 1 ] && MODE_LABEL=APPLIED

# object_paths SLOTDIR SET → the (validated) files that make up one generation
object_paths() {
  local d="$1" set="$2" a m
  a="$(lcp_archive_of "$set")"; m="$(lcp_manifest_of "$set")"
  printf '%s\n' "$d/$a" "$d/$a.receipt" "$d/$m" "$d/$m.receipt"
}
remove_generation() {   # SLOTDIR SET (apply only)
  local p
  while IFS= read -r p; do [ -e "$p" ] && [ ! -L "$p" ] && rm -f -- "${p:?}"; done < <(object_paths "$1" "$2")
  rmdir -- "$1" 2>/dev/null || true
}
quarantine_generation() {   # SLOTDIR SET LABEL (apply only)
  local p q n i
  q="$QUAR/$3"; [ -d "$q" ] || mkdir -m 0700 -- "$q"
  while IFS= read -r p; do
    [ -e "$p" ] && [ ! -L "$p" ] || continue
    n="${p##*/}"; i=0
    while [ -e "$q/$n" ]; do i=$((i + 1)); n="${p##*/}.dup$i"; done
    mv -n -- "$p" "$q/$n"
    touch -d "@$NOW" -- "$q/$n"   # the quarantine clock starts now: a human gets OFFHOST_RETAIN_DAYS to look
  done < <(object_paths "$1" "$2")
  rmdir -- "$1" 2>/dev/null || true
}

# ── inventory: label<TAB>set<TAB>complete (newest slot first; no temp file) ──
inventory() {
  local d label set state c
  for d in "$PUB"/*; do
    [ -d "$d" ] && [ ! -L "$d" ] || continue
    label="${d##*/}"; [[ "$label" =~ $LCP_SLOT_LABEL_RE ]] || continue
    while IFS= read -r set; do
      [ -n "$set" ] || continue
      state="$(lcp_generation_state "$d" "$set")"
      case "$state" in *" complete=yes") c=yes ;; *) c=no ;; esac
      printf '%s\t%s\t%s\n' "$label" "$set" "$c"
    done < <(lcp_slot_sets "$d")
  done
}

generations=0; kept=0; protected=0; deleted=0; quarantined=0; purged=0; seen_complete=0
retain_cutoff=$(( NOW - RETAIN_DAYS * LCP_DAY )); quar_cutoff=$(( NOW - QUAR_AFTER * LCP_DAY ))
while IFS=$'\t' read -r label set c; do
  [ -n "$label" ] || continue
  generations=$((generations + 1))
  d="$PUB/$label"
  slot_epoch="$(date -u -d "${label:0:4}-${label:4:2}-${label:6:2} ${label:9:2}:${label:11:2}:00" +%s)"
  if [ "$c" = yes ]; then
    seen_complete=$((seen_complete + 1))
    if [ "$seen_complete" -le "$PROTECT" ]; then
      echo "retain: slot=$label set=$set action=keep reason=protected-newest"; kept=$((kept + 1)); protected=$((protected + 1))
    elif [ "$slot_epoch" -lt "$retain_cutoff" ]; then
      echo "retain: slot=$label set=$set action=delete reason=older-than-${RETAIN_DAYS}d"; deleted=$((deleted + 1))
      [ "$APPLY" = 0 ] || remove_generation "$d" "$set"
    else
      echo "retain: slot=$label set=$set action=keep reason=within-retention"; kept=$((kept + 1))
    fi
  else
    if [ "$slot_epoch" -lt "$quar_cutoff" ]; then
      echo "retain: slot=$label set=$set action=quarantine reason=incomplete-older-than-${QUAR_AFTER}d"; quarantined=$((quarantined + 1))
      [ "$APPLY" = 0 ] || quarantine_generation "$d" "$set" "$label"
    else
      echo "retain: slot=$label set=$set action=keep reason=incomplete-recent"; kept=$((kept + 1))
    fi
  fi
done < <(inventory | LC_ALL=C sort -r)

# ── quarantine purge: files older than the retention window, by mtime ─────────
if [ -d "$QUAR" ]; then
  for d in "$QUAR"/*; do
    [ -d "$d" ] && [ ! -L "$d" ] || continue
    label="${d##*/}"; [[ "$label" =~ $LCP_SLOT_LABEL_RE ]] || continue
    for f in "$d"/*; do
      [ -f "$f" ] && [ ! -L "$f" ] || continue
      n="${f##*/}"; [[ "$n" =~ ^leadcapture-[0-9]{8}-[0-9]{6}\.sql\.gz\.(age|manifest\.json)(\.receipt)?(\.dup[0-9]+)?$ ]] || continue
      if [ "$(stat -c %Y "$f")" -lt "$retain_cutoff" ]; then
        echo "retain: quarantine=$label file=$n action=purge reason=older-than-${RETAIN_DAYS}d"; purged=$((purged + 1))
        [ "$APPLY" = 0 ] || rm -f -- "${f:?}"
      fi
    done
    [ "$APPLY" = 0 ] || rmdir -- "$d" 2>/dev/null || true
  done
fi
echo "OFFHOST_RETAIN=$MODE_LABEL generations=$generations kept=$kept protected=$protected deleted=$deleted quarantined=$quarantined purged=$purged"
exit 0
