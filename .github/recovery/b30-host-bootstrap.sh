#!/bin/bash
# =============================================================================
# B30 RECOVERY RUNNER — HOST BOOTSTRAP (streamed over the pinned SSH session as the deploy user; never stored).
# Stream layout, built on the runner: regex-validated variables as `NAME=value` assignments (printf %q), then this
# file. MODE is a fixed choice; the window strings are re-validated here; the toolkit arrives as a base64 tar whose
# SHA256SUMS must hash to the pin streamed from the workflow constants (never from an input). Everything the toolkit
# prints is written to a 600 file under the backup tree (host-side evidence, kept on success and on failure). The
# ONLY stdout of this bootstrap is the allow-listed B30_<KEY>=<token> summary; stderr goes to a private temp file.
# Modes: b30_recovery_check = the toolkit's B30_CHECK_ONLY=1 exactly once (product-data read-only: no backup, no
#                             pruning, no product / database / object write; the host gets only this 700 temp dir,
#                             removed at exit, and the 600 evidence log);
#        b30_recovery_set   = CHECK_ONLY once, then b30-backup-set.sh exactly once (KEEP=1000,
#                             B30_EXPECTED_UNREGISTERED=4), one set per approved window, no retry.
# =============================================================================
set -uo pipefail
umask 077
BACKUP_DIR="${BACKUP_DIR:-/opt/lead-capture-pro/backups/postgres}"   # default identical to the repository's backup script
if [ -n "${DEPLOY_PATH:-}" ]; then export DEPLOY_PATH; else unset DEPLOY_PATH; fi
STAMP="$(date -u +%Y%m%d-%H%M%S)"
TMP=""; RAW=""
out() { printf '%s\n' "$*"; }
finish() {
  out "B30_RUNNER_RESULT=$1"
  [ -n "$TMP" ] && rm -rf "$TMP"
  case "$1" in CHECK_OK|SET_VERIFIED) exit 0;; REFUSED_*) exit 1;; *) exit 2;; esac
}
TMP="$(mktemp -d 2>/dev/null)" || { out "B30_MODE=unknown"; TMP=""; finish REFUSED_no_tempdir; }
chmod 700 "$TMP"
exec 2>"$TMP/bootstrap.stderr"

# ---- streamed variables: shape only, values never printed ---------------------------------------------------------
case "${MODE:-}" in b30_recovery_check|b30_recovery_set) ;; *) out "B30_MODE=unknown"; finish REFUSED_bad_mode;; esac
out "B30_MODE=$MODE"
[[ "${B30_PRODUCT_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || finish REFUSED_bad_product_pin
[[ "${B30_SUMS_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || finish REFUSED_bad_toolkit_pin
out "B30_PRODUCT_COMMIT=$B30_PRODUCT_SHA"
TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$'
if [ "$MODE" = b30_recovery_set ]; then
  [[ "${QUIET_START:-}" =~ $TS_RE ]] && [[ "${QUIET_END:-}" =~ $TS_RE ]] || finish REFUSED_bad_window
  [[ "${QUIET_START}" < "${QUIET_END}" ]] || finish REFUSED_bad_window
else
  [ -z "${QUIET_START:-}${QUIET_END:-}" ] || finish REFUSED_window_in_check_mode
fi
[ -n "${B30_PAYLOAD_B64:-}" ] || finish REFUSED_no_payload
[ -d "$BACKUP_DIR" ] && [ -w "$BACKUP_DIR" ] || finish REFUSED_backup_dir

# ---- payload: decode, verify the pinned SHA256SUMS and every file, refuse extras ------------------------------------
KIT="$TMP/toolkit"; mkdir -p "$KIT"; chmod 700 "$KIT"
printf '%s' "$B30_PAYLOAD_B64" | base64 -d > "$TMP/payload.tar" 2>/dev/null || finish REFUSED_payload_decode
unset B30_PAYLOAD_B64
tar -xf "$TMP/payload.tar" -C "$KIT" --no-same-owner --no-same-permissions 2>/dev/null || finish REFUSED_payload_extract
[ -f "$KIT/SHA256SUMS" ] || finish REFUSED_toolkit_sums_missing
[ "$(sha256sum "$KIT/SHA256SUMS" | cut -c1-64)" = "$B30_SUMS_SHA256" ] || finish REFUSED_toolkit_pin_mismatch
( cd "$KIT" && LC_ALL=C sha256sum -c --quiet --strict SHA256SUMS >/dev/null 2>&1 ) || finish REFUSED_toolkit_hash_mismatch
expected_n=$(( $(grep -c . "$KIT/SHA256SUMS") + 1 ))
actual_n="$(find "$KIT" -mindepth 1 | wc -l | tr -d ' ')"
[ "$actual_n" = "$expected_n" ] || finish REFUSED_toolkit_extra_entries
[ -f "$KIT/b30-backup-set.sh" ] && [ -f "$KIT/b30-readback.ts" ] || finish REFUSED_toolkit_incomplete
chmod 600 "$KIT"/*
out "B30_TOOLKIT=verified"
out "B30_TOOLKIT_FILES=$actual_n"

# ---- host-side evidence log (600) ------------------------------------------------------------------------------------
LOGDIR="$BACKUP_DIR/recovery-sets/runner-logs"
{ mkdir -p "$LOGDIR" && chmod 700 "$LOGDIR"; } || finish REFUSED_logdir
RAW="$LOGDIR/b30-$MODE-$STAMP.log"; : > "$RAW"; chmod 600 "$RAW"
echo "mode=$MODE stamp=$STAMP product_pin=$B30_PRODUCT_SHA" >> "$RAW"

# ---- set mode: exactly one set per approved window --------------------------------------------------------------------
if [ "$MODE" = b30_recovery_set ]; then
  used=0; ws="${QUIET_START%Z}:00Z"; we="${QUIET_END%Z}:00Z"
  for m in "$BACKUP_DIR"/recovery-sets/b30-*/recovery-*.txt; do
    [ -f "$m" ] || continue
    c="$(grep -E '^created_utc=' "$m" | head -1 | cut -d= -f2)"
    [[ "$c" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || continue
    if [[ ! "$c" < "$ws" ]] && [[ "$c" < "$we" ]]; then used=$((used + 1)); fi
  done
  out "B30_WINDOW_SETS_EXISTING=$used"
  [ "$used" = 0 ] || finish REFUSED_window_already_used
fi

# ---- allow-listed summarizer (fixed tokens and integers only; raw text is never echoed) ------------------------------
classify_error() {
  local l; l="$(grep -m1 -E 'ERROR:' "$1" || true)"
  [ -n "$l" ] || { echo none; return; }
  case "$l" in
    *"copy lock is present"*) echo lock;;                       *"migrate container is running"*) echo migrate_container;;
    *"current-deploy.sha"*) echo current_deploy;;               *"app checkout is not the locked"*) echo checkout;;
    *"not clean"*) echo checkout_dirty;;                        *"migrate image"*) echo image;;
    *"GNU tar"*) echo tar;;                                     *"free on the backup filesystem"*) echo space;;
    *"stale temporary dump"*) echo stale_artifacts;;            *"orphan sidecar"*) echo orphan_sidecar;;
    *"retention-pruning candidate"*) echo retention_candidates;; *"INCOMPLETE recovery set"*) echo incomplete_set;;
    *"service is not running"*) echo services;;                 *"named volume"*) echo volume;;
    *"app directory"*) echo app_dir;;                           *"backup directory"*) echo backup_dir;;
    *"b30-readback.ts not found"*) echo helper;;                *"KEEP must be"*|*"B30_EXPECTED_UNREGISTERED"*) echo arguments;;
    *"another backup is already running"*) echo backup_running;; *"pg_dump or gzip failed"*|*"backup-postgres.sh failed"*) echo dump_failed;;
    *"no new dump"*|*"no sidecar"*|*"gzip"*|*"completion marker"*|*"sidecar mismatch"*|*"suspiciously small"*|*"unexpected dump header"*|*"checksum"*) echo dump_invalid;;
    *"fingerprint unreadable"*|*"inventory counts unreadable"*) echo db_facts;;
    *"archive failed"*|*"archive missing"*) echo archive;;      *"header scan failed"*) echo header_scan;;
    *"set directory already exists"*) echo set_exists;;         *) echo other;;
  esac
}
num_first() { grep -oE "$2=[0-9]+" "$1" | head -1 | cut -d= -f2; }
summarize_set() {
  local r="$1" n k
  n="$(grep -oE 'RECOVERY SET (NOT )?VERIFIED[^:]*: b30-[0-9]{8}-[0-9]{6}' "$r" | grep -oE 'b30-[0-9]{8}-[0-9]{6}' | head -1)"
  [ -n "$n" ] || n="$(grep -oE 'INCOMPLETE SET left for review[^:]*: b30-[0-9]{8}-[0-9]{6}' "$r" | grep -oE 'b30-[0-9]{8}-[0-9]{6}' | head -1)"
  [ -n "$n" ] && out "B30_SET_NAME=$n"
  for k in total active active_fs active_fs_migrated active_gcs deleted other_states; do
    n="$(num_first "$r" "inventory_$k")"; [ -n "$n" ] && out "B30_INV_$(printf '%s' "$k" | tr '[:lower:]' '[:upper:]')=$n"
  done
  if grep -q 'fingerprint: MATCH' "$r"; then out "B30_FINGERPRINT=MATCH"; elif grep -q 'fingerprint: MISMATCH' "$r"; then out "B30_FINGERPRINT=MISMATCH"; fi
  if grep -q 'sha256sums: OK' "$r"; then out "B30_SHA256SUMS=OK"; elif grep -q 'sha256sums: FAIL' "$r"; then out "B30_SHA256SUMS=FAIL"; fi
  if grep -qE 'volume tenant files = inventory active fs rows \([0-9]+\): MATCH' "$r"; then out "B30_TENANT_FILES=MATCH"; elif grep -q 'inventory active fs rows' "$r"; then out "B30_TENANT_FILES=MISMATCH"; fi
  if grep -q 'envelope headers: all tenant files valid' "$r"; then out "B30_HEADERS=valid"; elif grep -q 'envelope headers:' "$r"; then out "B30_HEADERS=invalid"; fi
  if grep -q 'symlinks: none' "$r"; then out "B30_SYMLINKS=none"; elif grep -q 'symlinks present' "$r"; then out "B30_SYMLINKS=present"; fi
  if grep -qE 'archive regular files = tenant \+ health files \([0-9]+\): MATCH' "$r"; then out "B30_ARCHIVE_FILES=MATCH"; elif grep -q 'archive regular files' "$r"; then out "B30_ARCHIVE_FILES=MISMATCH"; fi
  n="$(num_first "$r" regular_files)"; [ -n "$n" ] && out "B30_ARCHIVE_REGULAR=$n"
  n="$(num_first "$r" volume_tenant_files)"; [ -n "$n" ] && out "B30_VOLUME_TENANT_FILES=$n"
  n="$(num_first "$r" volume_health_files)"; [ -n "$n" ] && out "B30_VOLUME_HEALTH_FILES=$n"
  n="$(num_first "$r" volume_symlinks)"; [ -n "$n" ] && out "B30_VOLUME_SYMLINKS=$n"
  if grep -q 'envelope key id: single' "$r"; then out "B30_KEY_ID=single"; elif grep -q 'envelope key id: not single' "$r"; then out "B30_KEY_ID=not_single"; fi
  n="$(num_first "$r" dump_bytes)"; [ -n "$n" ] || n="$(grep -oE 'bytes=[0-9]+ sidecar verified' "$r" | grep -oE '[0-9]+' | head -1)"; [ -n "$n" ] && out "B30_DUMP_BYTES=$n"
  n="$(grep -oE 'archive: objectdata-[0-9-]+\.tar bytes=[0-9]+' "$r" | grep -oE 'bytes=[0-9]+' | cut -d= -f2 | head -1)"; [ -n "$n" ] && out "B30_ARCHIVE_BYTES=$n"
  return 0
}

# ---- 1. the reviewed CHECK_ONLY function, exactly once ---------------------------------------------------------------
( cd "$KIT" && B30_CHECK_ONLY=1 B30_SCRIPT_DIR="$KIT" KEEP=1000 B30_EXPECTED_UNREGISTERED=4 bash ./b30-backup-set.sh ) >>"$RAW" 2>&1; check_rc=$?
out "B30_CHECK_EXIT=$check_rc"
if [ "$check_rc" = 0 ] && grep -q 'B30_CHECK_ONLY=1 — nothing created' "$RAW" && grep -q 'preconditions OK (' "$RAW"; then
  out "B30_PRECONDITIONS=ok"
  n="$(num_first "$RAW" existing_dumps)"; [ -n "$n" ] && out "B30_EXISTING_DUMPS=$n"
  out "B30_KEEP=1000"; out "B30_EXPECTED_UNREGISTERED=4"; out "B30_SET_PHASE=pre-copy"
else
  out "B30_PRECONDITIONS=failed"; out "B30_FAILURE_CLASS=$(classify_error "$RAW")"; out "B30_RAW_LOG=retained"
  finish CHECK_FAILED
fi
if [ "$MODE" = b30_recovery_check ]; then out "B30_RAW_LOG=retained"; finish CHECK_OK; fi

# ---- 2. the set run, exactly once, no retry -------------------------------------------------------------------------
( cd "$KIT" && B30_SCRIPT_DIR="$KIT" KEEP=1000 B30_EXPECTED_UNREGISTERED=4 bash ./b30-backup-set.sh ) >>"$RAW" 2>&1; set_rc=$?
out "B30_SET_EXIT=$set_rc"
summarize_set "$RAW"
out "B30_RAW_LOG=retained"
if grep -q 'INCOMPLETE SET left for review' "$RAW"; then out "B30_SET_MARKER=INCOMPLETE"; out "B30_FAILURE_CLASS=$(classify_error "$RAW")"; finish SET_INCOMPLETE; fi
if [ "$set_rc" = 0 ] && grep -qE 'RECOVERY SET VERIFIED: b30-' "$RAW"; then out "B30_SET_MARKER=VERIFIED"; finish SET_VERIFIED; fi
if grep -q 'RECOVERY SET NOT VERIFIED' "$RAW"; then out "B30_SET_MARKER=NOT_VERIFIED"; out "B30_FAILURE_CLASS=$(classify_error "$RAW")"; finish SET_NOT_VERIFIED; fi
out "B30_SET_MARKER=none"; out "B30_FAILURE_CLASS=$(classify_error "$RAW")"; finish SET_FAILED
