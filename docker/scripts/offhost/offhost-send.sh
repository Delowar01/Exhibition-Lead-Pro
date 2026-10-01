#!/bin/bash
# =============================================================================
# Lead Capture Pro — off-host backup sender (PRIMARY VPS side, B23 G-6D C1/C2)
# =============================================================================
# Runs on the primary Hostinger VPS as the deploy user, after the 03:15 UTC
# logical backup and the 03:45 UTC local check (documented cron: 03:50 UTC —
# NOT activated by this branch). For the CURRENT 03:15 UTC slot it
#
#   1. selects the newest locally verified backup of that slot and re-runs the
#      local integrity checks (sidecar, sha256sum -c --strict, gzip -t, dump
#      header, completion marker);
#   2. asks the backup VPS for its identity (HELLO) over the pinned SSH channel
#      and REFUSES to continue when the destination is this same machine
#      (machine-id hash or host-key fingerprint match) or is not the expected
#      machine — hostnames are never trusted for this;
#   3. asks the separate audit identity (AUDIT, list-only) what the vault
#      already holds for this set. The listing is accepted ONLY when it
#      provably comes from the same machine and file system as the upload
#      HELLO (machine hash, file-system id and host keys bound; exactly one
#      header, capacity line and footer; clock within the configured skew;
#      root=ok; no duplicate or malformed records) — otherwise the run fails
#      closed BEFORE encryption and before any PUT. A complete generation is
#      never uploaded twice; an archive without manifest is completed from
#      the local stage of the interrupted run when the stage still matches;
#   4. encrypts the dump with age (authenticated encryption) to the approved
#      public recipient — the private key never exists on either VPS — into a
#      persistent per-set stage (mode 700, own user, ciphertext only) so an
#      interrupted run can resume without producing a second ciphertext;
#   5. writes a sanitized manifest (names, sizes, checksums, slot, labels; no
#      dump contents, no credentials, no paths);
#   6. streams the archive and then the manifest to the forced-command receiver
#      (upload identity: PUT only; the receiver chooses and validates the
#      destination, publishes exclusively, never overwrites);
#   7. verifies the published generation through the same bound audit identity
#      again — the receiver's reply alone is never trusted — records a local
#      receipt (operational state, never the source of truth) and prints
#      exactly one final summary line:
#        OFFHOST_UPLOAD=PASS set=<set> slot=<label> archive_size=<n> sha256_prefix=<12> destination=<machine-prefix> upload=<published|already-published|resumed|ambiguous> audit=complete
#        OFFHOST_UPLOAD=FAIL reason=<stable-code>[ detail=<safe values>]
#
# Overall deadline (B23 G-6D C2): OFFHOST_MAX_TIME is a single monotonic
# budget for the whole run (Bash SECONDS). Before every potentially blocking
# operation — age encryption, HELLO, pre-upload AUDIT, archive PUT, manifest
# PUT, post-upload AUDIT — the REMAINING allowance is computed and applied with
# `timeout --foreground -k 5`; the budget is never reset per operation. When
# it is exhausted the run ends with exactly one summary
#        OFFHOST_UPLOAD=FAIL reason=operation-timeout detail=step=<step>
# temporary work files are removed, and the persistent ciphertext stage is
# kept only when it is complete and valid (a cut-off encryption is discarded).
#
# Exit 0 only with PASS. 1 on FAIL. 75 when another run holds the lock.
# `plan` mode (bash offhost-send.sh plan) is read-only: no network, no
# encryption, no writes — it prints which local backup would be sent.
#
# Configuration (OFFHOST_SEND_CONFIG, mode 600/400, KEY=value; the environment
# wins): BACKUP_DIR, OFFHOST_STATE_DIR (receipts/lock/stage; must not be inside
# BACKUP_DIR), OFFHOST_SSH_CONFIG (pinned ssh_config: IdentitiesOnly,
# StrictHostKeyChecking yes, UserKnownHostsFile), OFFHOST_UPLOAD_TARGET and
# OFFHOST_AUDIT_TARGET (Host aliases of that ssh_config using the upload key
# and the PRIMARY audit key — GitHub uses a third, separately revocable audit
# key), OFFHOST_RECIPIENT (age public recipient), optional
# OFFHOST_EXPECTED_MACHINE (sha256 of the backup VPS machine-id) and
# OFFHOST_EXPECTED_HOSTKEYS (comma-separated SHA256: fingerprints),
# OFFHOST_ENV_LABEL, OFFHOST_CONNECT_TIMEOUT, OFFHOST_MAX_TIME (overall
# budget, seconds), OFFHOST_MAX_CLOCK_SKEW_SECONDS (audit clock tolerance,
# default 900), OFFHOST_RECEIPT_KEEP_DAYS. Environment-only test hooks (never
# config keys): OFFHOST_NOW (epoch), OFFHOST_SSH_BIN, OFFHOST_AGE_BIN.
#
# Never printed: dump contents, private keys, credentials, connection strings,
# complete checksums, hostnames or unrestricted paths. Nothing in the
# PostgreSQL backup directory is ever written, renamed or deleted.
# Design of record: docs/BACKUP_OFFHOST_HOSTINGER.md
# =============================================================================
set -Eeuo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=offhost-lib.sh
source "$HERE/offhost-lib.sh"

MODE="${1:-run}"
case "$MODE" in run|plan) ;; *) echo "usage: offhost-send.sh [run|plan]" >&2; exit 2 ;; esac
# Log lines and the single summary line always go to the script's ORIGINAL
# stdout (descriptor 3), never into a per-operation output file: helper
# functions run with their stdout redirected into the work directory, and a
# summary written there would vanish with the cleanup.
exec 3>&1
log()  { echo "[offhost-send] $(date -u +%FT%TZ) $*" >&3; }
fail() { echo "OFFHOST_UPLOAD=FAIL reason=$1${2:+ detail=$2}" >&3; exit 1; }
trap 'rc=$?; echo "OFFHOST_UPLOAD=FAIL reason=unexpected-error detail=step=${STEP:-init},exit=$rc" >&3; exit 1' ERR
STEP=config
START_SECONDS=$SECONDS   # monotonic origin of the single overall budget
# environment-only harness hook: "<step>=<seconds>" charges the budget once,
# right before that step's blocking call, to exercise the exhausted-before-
# operation path deterministically (never a configuration key). It is
# validated BEFORE any arithmetic: exactly one known step and a positive
# integer of at most six digits; anything else (empty value, negative, too
# large, variables, arrays, substitutions, unknown steps) fails closed with
# one sanitized summary, and the value is never echoed. Unset = no effect.
BUDGET_CHARGE="${OFFHOST_TEST_BUDGET_CHARGE:-}"
if [ -n "$BUDGET_CHARGE" ] && ! [[ "$BUDGET_CHARGE" =~ ^(hello|pre-audit|encrypt|put-archive|put-manifest|post-audit)=[1-9][0-9]{0,5}$ ]]; then
  fail invalid-test-hook
fi

readonly CONFIG_KEYS=" BACKUP_DIR OFFHOST_STATE_DIR OFFHOST_SSH_CONFIG OFFHOST_UPLOAD_TARGET OFFHOST_AUDIT_TARGET OFFHOST_RECIPIENT OFFHOST_EXPECTED_MACHINE OFFHOST_EXPECTED_HOSTKEYS OFFHOST_ENV_LABEL OFFHOST_CONNECT_TIMEOUT OFFHOST_MAX_TIME OFFHOST_MAX_CLOCK_SKEW_SECONDS OFFHOST_RECEIPT_KEEP_DAYS "
if [ -n "${OFFHOST_SEND_CONFIG:-}" ]; then
  { [ -f "$OFFHOST_SEND_CONFIG" ] && [ ! -L "$OFFHOST_SEND_CONFIG" ]; } || fail config-not-regular-file
  m="$(stat -c %a "$OFFHOST_SEND_CONFIG")"; [ "$m" = 600 ] || [ "$m" = 400 ] || fail config-mode "mode=$m"
  lcp_load_config "$OFFHOST_SEND_CONFIG" "$CONFIG_KEYS" 2>/dev/null || fail config-invalid
fi
BACKUP_DIR="${BACKUP_DIR:-/opt/lead-capture-pro/backups/postgres}"
STATE_DIR="${OFFHOST_STATE_DIR:-/opt/lead-capture-pro/backups/offhost-state}"
SSH_CONFIG="${OFFHOST_SSH_CONFIG:-/opt/lead-capture-pro/env/offhost-ssh.config}"
UPLOAD_TARGET="${OFFHOST_UPLOAD_TARGET:-lcp-vault-upload}"
AUDIT_TARGET="${OFFHOST_AUDIT_TARGET:-lcp-vault-audit}"
RECIPIENT="${OFFHOST_RECIPIENT:-}"
EXPECTED_MACHINE="${OFFHOST_EXPECTED_MACHINE:-}"
EXPECTED_HOSTKEYS="${OFFHOST_EXPECTED_HOSTKEYS:-}"
ENV_LABEL="${OFFHOST_ENV_LABEL:-hosted-dev}"
CONNECT_TIMEOUT="${OFFHOST_CONNECT_TIMEOUT:-20}"
MAX_TIME="${OFFHOST_MAX_TIME:-1800}"
MAX_SKEW="${OFFHOST_MAX_CLOCK_SKEW_SECONDS:-900}"
KEEP_DAYS="${OFFHOST_RECEIPT_KEEP_DAYS:-60}"
NOW="${OFFHOST_NOW:-$(date -u +%s)}"
SSH_BIN="${OFFHOST_SSH_BIN:-ssh}"
AGE_BIN="${OFFHOST_AGE_BIN:-age}"

[[ "$BACKUP_DIR" =~ $LCP_PATH_RE ]] || fail invalid-backup-dir
[[ "$STATE_DIR" =~ $LCP_PATH_RE ]] || fail invalid-state-dir
[[ "$SSH_CONFIG" =~ $LCP_PATH_RE ]] || fail invalid-ssh-config-path
[[ "$UPLOAD_TARGET" =~ ^[a-z][a-z0-9-]{1,40}$ ]] || fail invalid-upload-target
[[ "$AUDIT_TARGET" =~ ^[a-z][a-z0-9-]{1,40}$ ]] || fail invalid-audit-target
[ "$UPLOAD_TARGET" != "$AUDIT_TARGET" ] || fail upload-and-audit-target-identical
[[ "$ENV_LABEL" =~ ^[a-z0-9-]{1,32}$ ]] || fail invalid-env-label
[[ "$CONNECT_TIMEOUT" =~ ^[0-9]{1,4}$ ]] && [ "$CONNECT_TIMEOUT" -ge 1 ] || fail invalid-timeouts
[[ "$MAX_TIME" =~ ^[0-9]{1,6}$ ]] && [ "$MAX_TIME" -ge 1 ] || fail invalid-timeouts
[[ "$MAX_SKEW" =~ ^[0-9]{1,4}$ ]] && [ "$MAX_SKEW" -ge 1 ] || fail invalid-clock-skew
[[ "$KEEP_DAYS" =~ ^[0-9]{1,4}$ ]] && [ "$KEEP_DAYS" -ge 1 ] || fail invalid-receipt-keep-days
[[ "$NOW" =~ ^[0-9]+$ ]] || fail invalid-now
[ -z "$EXPECTED_MACHINE" ] || [[ "$EXPECTED_MACHINE" =~ $LCP_SHA256_RE ]] || fail invalid-expected-machine
[ -z "$EXPECTED_HOSTKEYS" ] || [[ "$EXPECTED_HOSTKEYS" =~ ^SHA256:[A-Za-z0-9+/]{43}(,SHA256:[A-Za-z0-9+/]{43})*$ ]] || fail invalid-expected-hostkeys
{ [ -d "$BACKUP_DIR" ] && [ ! -L "$BACKUP_DIR" ]; } || fail backup-dir-missing
case "$STATE_DIR" in "$BACKUP_DIR"|"$BACKUP_DIR"/*) fail state-dir-inside-backup-dir ;; esac
case "$BACKUP_DIR" in "$STATE_DIR"|"$STATE_DIR"/*) fail backup-dir-inside-state-dir ;; esac

# ── slot and candidate selection (read-only) ─────────────────────────────────
STEP=select
CUR_IDX="$(lcp_slot_index "$NOW")"; SLOT_LABEL="$(lcp_slot_label "$CUR_IDX")"
SET=""; SET_STAMP=0; INELIGIBLE=0
shopt -s nullglob
for f in "$BACKUP_DIR"/leadcapture-*.sql.gz; do
  n="${f##*/}"
  e="$(lcp_stamp_epoch "$n")" || { INELIGIBLE=$((INELIGIBLE + 1)); continue; }
  [ "$(lcp_slot_index "$e")" = "$CUR_IDX" ] || continue
  st="$(lcp_backup_eligibility "$BACKUP_DIR" "$n" "$CUR_IDX")"
  if [ "$st" != ok ]; then log "ineligible: file=$n reason=$st"; INELIGIBLE=$((INELIGIBLE + 1)); continue; fi
  if [ "$e" -gt "$SET_STAMP" ] || { [ "$e" -eq "$SET_STAMP" ] && [[ "$n" > "$SET" ]]; }; then SET="$n"; SET_STAMP="$e"; fi
done
shopt -u nullglob
log "slot: now_utc=$(lcp_utc "$NOW") current_slot=$SLOT_LABEL candidate=${SET:-none} ineligible=$INELIGIBLE"
[ -n "$SET" ] || fail current-slot-backup-missing "slot=$SLOT_LABEL"
SRC="$BACKUP_DIR/$SET"
SRC_SIZE="$(stat -c %s "$SRC")"; SRC_SHA="$(lcp_sha256 "$SRC")"
ARCHIVE="$(lcp_archive_of "$SET")"; MANIFEST="$(lcp_manifest_of "$SET")"
if [ "$MODE" = plan ]; then
  echo "plan: set=$SET slot=$SLOT_LABEL source_size=$SRC_SIZE source_sha256_prefix=$(lcp_prefix "$SRC_SHA") archive=$ARCHIVE manifest=$MANIFEST upload_target=$UPLOAD_TARGET audit_target=$AUDIT_TARGET max_time=$MAX_TIME"
  exit 0
fi

# ── run mode prerequisites ───────────────────────────────────────────────────
STEP=prerequisites
[[ "$RECIPIENT" =~ ^age1[02-9ac-hj-np-z]{58}$ ]] || fail invalid-recipient
{ [ -f "$SSH_CONFIG" ] && [ ! -L "$SSH_CONFIG" ]; } || fail ssh-config-missing
for t in "$AGE_BIN" "$SSH_BIN" timeout sha256sum gzip flock; do command -v "$t" >/dev/null 2>&1 || fail tool-missing "$(basename "$t")"; done
LOCAL_MACHINE="$(lcp_machine_hash)"; LOCAL_HOSTKEYS="$(lcp_local_hostkey_fingerprints)"
[ "$LOCAL_MACHINE" != unknown ] || fail local-identity-unverifiable

if [ ! -d "$STATE_DIR" ]; then mkdir -p "$STATE_DIR"; fi
[ ! -L "$STATE_DIR" ] || fail state-dir-symlink
chmod 700 "$STATE_DIR"
[ "$(stat -c %u "$STATE_DIR")" = "$(id -u)" ] || fail state-dir-owner
exec 9>"$STATE_DIR/.send.lock"
flock -n 9 || { echo "OFFHOST_UPLOAD=FAIL reason=locked"; exit 75; }
WORK="$(mktemp -d "$STATE_DIR/.work.XXXXXXXX")"
cleanup() { rm -rf "${WORK:?}"; }
trap cleanup EXIT
STAGE="$STATE_DIR/stage/$SET"   # persistent per-set stage (ciphertext + manifest only)
discard_stage() { rm -rf "${STAGE:?}"; }

# ── the single overall budget: remaining allowance before every blocking call ─
# remaining → sets REM to the seconds left of OFFHOST_MAX_TIME; 1 when exhausted
remaining() { REM=$(( MAX_TIME - (SECONDS - START_SECONDS) )); [ "$REM" -gt 0 ]; }
# run_limited CMD… → runs CMD under the remaining allowance (never a fresh full
# budget); RUN_RC holds its exit code, TIMED_OUT=1 when the deadline cut it off
run_limited() {
  if [ -n "$BUDGET_CHARGE" ] && [ "${BUDGET_CHARGE%%=*}" = "$STEP" ]; then SECONDS=$(( SECONDS + ${BUDGET_CHARGE#*=} )); BUDGET_CHARGE=""; fi
  remaining || fail operation-timeout "step=$STEP"
  RUN_RC=0; TIMED_OUT=0
  # the lock descriptor (9) and the summary descriptor (3) are closed for the
  # child so that a stuck or orphaned process can neither keep the sender's
  # lock alive nor write into the sender's output after this run has ended
  timeout --foreground -k 5 "$REM" "$@" 9>&- 3>&- || RUN_RC=$?
  case "$RUN_RC" in 124|137) TIMED_OUT=1 ;; esac
}
timed_out_fail() { [ "$TIMED_OUT" = 0 ] || fail operation-timeout "step=$STEP"; }

# ── SSH channel: pinned config, no interactive fallbacks, budgeted ───────────
ssh_cmd() {   # TARGET COMMAND  (stdin/stdout are the caller's); RUN_RC/TIMED_OUT afterwards
  run_limited "$SSH_BIN" -F "$SSH_CONFIG" -o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes \
    -o "ConnectTimeout=$CONNECT_TIMEOUT" -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o LogLevel=ERROR \
    -- "$1" "$2"
}
# reply_line FILE → the protocol reply line (last line starting with the protocol tag)
reply_line() { grep -E "^$LCP_PROTOCOL " "$1" 2>/dev/null | tail -n 1 || true; }
# count_lines FILE REGEX → number of matching lines (0 when none)
count_lines() { grep -cE -- "$2" "$1" 2>/dev/null || true; }

# ── destination identity: refuse a same-host or unexpected destination ───────
STEP=hello
ssh_cmd "$UPLOAD_TARGET" HELLO <"/dev/null" >"$WORK/hello.out" 2>"$WORK/hello.err"
timed_out_fail
[ "$RUN_RC" = 0 ] || fail destination-unreachable "ssh_exit=$RUN_RC"
hello="$(reply_line "$WORK/hello.out")"
[[ "$hello" =~ ^$LCP_PROTOCOL\ HELLO\ machine=([0-9a-f]{64}|unknown)\ hostkeys=([A-Za-z0-9+/:,]+|unknown)\ fsid=([0-9a-fx]+|unknown)\ root=(ok|missing)$ ]] || fail hello-invalid
R_MACHINE="${BASH_REMATCH[1]}"; R_HOSTKEYS="${BASH_REMATCH[2]}"; R_FSID="${BASH_REMATCH[3]}"; R_ROOT="${BASH_REMATCH[4]}"
[ "$R_MACHINE" != unknown ] || fail destination-identity-unverifiable "machine"
[ "$R_FSID" != unknown ] || fail destination-identity-unverifiable "filesystem"
[ "$R_HOSTKEYS" != unknown ] || fail destination-identity-unverifiable "hostkey"
[ "$R_MACHINE" != "$LOCAL_MACHINE" ] || fail same-host-destination "machine"
! lcp_lists_intersect "$LOCAL_HOSTKEYS" "$R_HOSTKEYS" || fail same-host-destination "hostkey"
[ -z "$EXPECTED_MACHINE" ] || [ "$R_MACHINE" = "$EXPECTED_MACHINE" ] || fail destination-identity-mismatch
[ -z "$EXPECTED_HOSTKEYS" ] || lcp_lists_intersect "$EXPECTED_HOSTKEYS" "$R_HOSTKEYS" || fail destination-hostkey-mismatch
[ "$R_ROOT" = ok ] || fail destination-root-missing
log "destination: machine=$(lcp_prefix "$R_MACHINE") identity=verified same_host=no"

# ── audit listing bound to the upload destination (fail closed) ──────────────
# audit_fetch OUTFILE → runs AUDIT through the audit identity, validates the
# listing as a whole and binds it to the HELLO identity; sets A_STATE
# (absent|complete|incomplete), A_ARCHIVE, A_SIZE, A_PFX for this set.
GEN_RE='^generation slot=[0-9]{8}-[0-9]{4} set=leadcapture-[0-9]{8}-[0-9]{6}\.sql\.gz archive=(present|missing) archive_size=[0-9]+ archive_mtime_utc=([0-9T:Z-]+|none) archive_sha256_prefix=([0-9a-f]{12}|none) archive_receipt=(ok|missing|invalid) manifest=(present|missing) manifest_receipt=(ok|missing|invalid) manifest_valid=(yes|no) complete=(yes|no)$'
audit_fetch() {
  local f="$1" n hdr cap ftr a_now a_machine a_hostkeys a_fsid a_root a_epoch skew gen
  A_STATE=absent; A_ARCHIVE=missing; A_SIZE=0; A_PFX=none
  ssh_cmd "$AUDIT_TARGET" AUDIT <"/dev/null" >"$f" 2>"$f.err"
  timed_out_fail
  [ "$RUN_RC" = 0 ] || fail audit-unreachable "step=$STEP,ssh_exit=$RUN_RC"
  # protocol version: every protocol-tagged line must carry version 1
  [ "$(count_lines "$f" '^LCP-OFFHOST/[0-9]+ ')" = "$(count_lines "$f" "^$LCP_PROTOCOL ")" ] || fail audit-protocol-version
  # exactly one header, one capacity line, one footer
  n="$(count_lines "$f" "^$LCP_PROTOCOL AUDIT ")"; [ "$n" -le 1 ] || fail audit-header-duplicate; [ "$n" = 1 ] || fail audit-header-invalid "missing"
  n="$(count_lines "$f" "^$LCP_PROTOCOL CAPACITY ")"; [ "$n" -le 1 ] || fail audit-capacity-duplicate; [ "$n" = 1 ] || fail audit-capacity-invalid "missing"
  n="$(count_lines "$f" "^$LCP_PROTOCOL AUDIT_END ")"; [ "$n" -le 1 ] || fail audit-footer-duplicate; [ "$n" = 1 ] || fail audit-footer-invalid "missing"
  hdr="$(grep -m1 -E "^$LCP_PROTOCOL AUDIT " "$f")"
  [[ "$hdr" =~ ^$LCP_PROTOCOL\ AUDIT\ now_utc=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)\ machine=([0-9a-f]{64}|unknown)\ hostkeys=([A-Za-z0-9+/:,]+|unknown)\ fsid=([0-9a-fx]+|unknown)\ root=(ok|missing)\ current_slot=([0-9]{8}-[0-9]{4})\ window=([0-9]{1,2})$ ]] || fail audit-header-invalid
  a_now="${BASH_REMATCH[1]}"; a_machine="${BASH_REMATCH[2]}"; a_hostkeys="${BASH_REMATCH[3]}"; a_fsid="${BASH_REMATCH[4]}"; a_root="${BASH_REMATCH[5]}"
  cap="$(grep -m1 -E "^$LCP_PROTOCOL CAPACITY " "$f")"
  [[ "$cap" =~ ^$LCP_PROTOCOL\ CAPACITY\ state=(ok|low|over-cap|unavailable)\ free_state=(above-reserve|below-reserve|unknown)\ max_generations_per_slot=[0-9]+\ current_slot_generations=[0-9]+\ over_cap_slots=[0-9]+\ reserve_bytes=[0-9]+\ free_bytes=([0-9]+|unknown)$ ]] || fail audit-capacity-invalid
  ftr="$(grep -m1 -E "^$LCP_PROTOCOL AUDIT_END " "$f")"
  [[ "$ftr" =~ ^$LCP_PROTOCOL\ AUDIT_END\ generations=[0-9]+\ complete=[0-9]+\ incomplete=[0-9]+\ pending=[0-9]+\ pending_stale=[0-9]+\ partial=[0-9]+\ partial_stale=[0-9]+\ orphans=[0-9]+\ quarantine=[0-9]+\ current_slot_complete=(yes|no)$ ]] || fail audit-footer-invalid
  # binding to the upload destination: same machine, same file system, shared host key
  [ "$a_machine" = "$R_MACHINE" ] || fail audit-destination-mismatch "machine"
  [ "$a_fsid" = "$R_FSID" ] || fail audit-destination-mismatch "filesystem"
  lcp_lists_intersect "$a_hostkeys" "$R_HOSTKEYS" || fail audit-destination-mismatch "hostkey"
  [ -z "$EXPECTED_MACHINE" ] || [ "$a_machine" = "$EXPECTED_MACHINE" ] || fail audit-machine-mismatch
  [ -z "$EXPECTED_HOSTKEYS" ] || lcp_lists_intersect "$EXPECTED_HOSTKEYS" "$a_hostkeys" || fail audit-hostkey-mismatch
  [ "$a_root" = ok ] || fail audit-root-missing
  a_epoch="$(date -u -d "$a_now" +%s 2>/dev/null)" || fail audit-header-invalid "clock"
  skew=$(( NOW - a_epoch )); skew="${skew#-}"
  [ "$skew" -le "$MAX_SKEW" ] || fail audit-clock-skew "seconds=$skew,max=$MAX_SKEW"
  # every generation record must be well-formed; ours must occur at most once
  while IFS= read -r gen; do
    [[ "$gen" =~ $GEN_RE ]] || fail audit-line-invalid
  done < <(grep -E '^generation ' "$f" || true)
  n="$(count_lines "$f" "^generation slot=$SLOT_LABEL set=$SET ")"
  [ "$n" -le 1 ] || fail audit-generation-duplicate
  [ "$n" = 1 ] || return 0
  gen="$(grep -m1 -E "^generation slot=$SLOT_LABEL set=$SET " "$f")"
  [[ "$gen" =~ \ archive=(present|missing)\  ]] && A_ARCHIVE="${BASH_REMATCH[1]}"
  [[ "$gen" =~ \ archive_size=([0-9]+)\  ]] && A_SIZE="${BASH_REMATCH[1]}"
  [[ "$gen" =~ \ archive_sha256_prefix=([0-9a-f]{12}|none)\  ]] && A_PFX="${BASH_REMATCH[1]}"
  if [[ "$gen" =~ \ complete=yes$ ]]; then A_STATE=complete; else A_STATE=incomplete; fi
  return 0
}

# ── what does the vault already hold for this set? (bound audit identity) ────
STEP=pre-audit
audit_fetch "$WORK/audit-before.out"
log "pre-audit: destination=bound generation=$A_STATE"
STAGE_VALID=no
if [ -f "$STAGE/$ARCHIVE" ] && [ ! -L "$STAGE/$ARCHIVE" ] && [ -f "$STAGE/$MANIFEST" ] && [ ! -L "$STAGE/$MANIFEST" ] \
   && [ "$(lcp_manifest_check "$STAGE/$MANIFEST" "$SET" "$SLOT_LABEL")" = ok ] \
   && [ "$(lcp_manifest_field "$STAGE/$MANIFEST" source_sha256)" = "$SRC_SHA" ] \
   && [ "$(lcp_manifest_field "$STAGE/$MANIFEST" archive_size)" = "$(stat -c %s "$STAGE/$ARCHIVE")" ] \
   && [ "$(lcp_manifest_field "$STAGE/$MANIFEST" archive_sha256)" = "$(lcp_sha256 "$STAGE/$ARCHIVE")" ]; then STAGE_VALID=yes; fi
UPLOAD=published
case "$A_STATE" in
  complete)
    log "pre-audit: action=skip-upload"
    UPLOAD=already-published; ARC_SIZE="$A_SIZE"; ARC_SHA_PREFIX="$A_PFX" ;;
  incomplete)
    if [ "$A_ARCHIVE" = present ] && [ "$STAGE_VALID" = yes ] && [ "$A_SIZE" = "$(stat -c %s "$STAGE/$ARCHIVE")" ] && [ "$A_PFX" = "$(lcp_prefix "$(lcp_sha256 "$STAGE/$ARCHIVE")")" ]; then
      log "pre-audit: stage=matches action=resume-manifest"; UPLOAD=resumed
    else
      fail remote-generation-incomplete "archive=$A_ARCHIVE,stage=$STAGE_VALID,remote_size=$A_SIZE"
    fi ;;
  absent)
    if [ "$STAGE_VALID" = yes ]; then log "pre-audit: stage=matches action=resume-upload"; UPLOAD=resumed
    else log "pre-audit: action=encrypt-and-upload"; fi ;;
esac

if [ "$UPLOAD" != already-published ]; then
  # ── encrypt into the persistent stage unless a matching stage already exists ─
  STEP=encrypt
  if [ "$STAGE_VALID" != yes ]; then
    discard_stage; mkdir -p "$STAGE"; chmod 700 "$STAGE"
    run_limited "$AGE_BIN" -r "$RECIPIENT" -o "$STAGE/$ARCHIVE" "$SRC" 2>"$WORK/age.err"
    if [ "$TIMED_OUT" = 1 ]; then discard_stage; fail operation-timeout "step=$STEP"; fi
    if [ "$RUN_RC" != 0 ]; then discard_stage; fail encryption-failed; fi
    lcp_age_header_ok "$STAGE/$ARCHIVE" || { discard_stage; fail encryption-output-invalid; }
  fi
  ARC_SIZE="$(stat -c %s "$STAGE/$ARCHIVE")"; ARC_SHA="$(lcp_sha256 "$STAGE/$ARCHIVE")"; ARC_SHA_PREFIX="$(lcp_prefix "$ARC_SHA")"
  [[ "$ARC_SIZE" =~ $LCP_SIZE_RE ]] && [ "$ARC_SIZE" -ge 64 ] || { discard_stage; fail encryption-output-invalid; }
  log "encrypted: archive=$ARCHIVE size=$ARC_SIZE sha256_prefix=$ARC_SHA_PREFIX stage=$([ "$STAGE_VALID" = yes ] && echo reused || echo new)"

  # ── sanitized manifest (every value validated above; no free text) ─────────
  STEP=manifest
  if [ "$STAGE_VALID" != yes ]; then
    RECIPIENT_FP="$(printf '%s' "$RECIPIENT" | sha256sum | cut -c1-12)"
    printf '{"schema":"%s","protocol":"%s","environment":"%s","set":"%s","slot":"%s","slot_index":%s,"created_utc":"%s","source_name":"%s","source_size":%s,"source_sha256":"%s","archive_name":"%s","archive_size":%s,"archive_sha256":"%s","encryption":"age/%s","recipient_fingerprint":"%s","sender_machine":"%s","destination_machine":"%s"}\n' \
      "$LCP_MANIFEST_SCHEMA" "$LCP_PROTOCOL" "$ENV_LABEL" "$SET" "$SLOT_LABEL" "$CUR_IDX" "$(lcp_utc "$NOW")" \
      "$SET" "$SRC_SIZE" "$SRC_SHA" "$ARCHIVE" "$ARC_SIZE" "$ARC_SHA" "$LCP_AGE_HEADER" "$RECIPIENT_FP" \
      "$(lcp_prefix "$LOCAL_MACHINE")" "$(lcp_prefix "$R_MACHINE")" >"$STAGE/$MANIFEST"
    [ "$(lcp_manifest_check "$STAGE/$MANIFEST" "$SET" "$SLOT_LABEL")" = ok ] || { discard_stage; fail manifest-self-check; }
  fi
  MAN_SIZE="$(stat -c %s "$STAGE/$MANIFEST")"; MAN_SHA="$(lcp_sha256 "$STAGE/$MANIFEST")"

  # ── upload: archive first, manifest last; the receiver decides ─────────────
  # put NAME SIZE SHA FILE → sets PUT_STATUS to published|exists|rejected|ambiguous and PUT_DETAIL
  put() {
    local name="$1" size="$2" sha="$3" file="$4" line
    PUT_STATUS=ambiguous; PUT_DETAIL=""
    ssh_cmd "$UPLOAD_TARGET" "PUT $name $size $sha" <"$file" >"$WORK/put.out" 2>"$WORK/put.err"
    timed_out_fail
    line="$(reply_line "$WORK/put.out")"
    if [[ "$line" =~ ^$LCP_PROTOCOL\ PUBLISHED\ name=([^ ]+)\ size=([0-9]+)\ sha256_prefix=([0-9a-f]{12})$ ]]; then
      if [ "${BASH_REMATCH[1]}" = "$name" ] && [ "${BASH_REMATCH[2]}" = "$size" ] && [ "${BASH_REMATCH[3]}" = "$(lcp_prefix "$sha")" ]; then PUT_STATUS=published; else PUT_DETAIL=reply-mismatch; fi
    elif [[ "$line" =~ ^$LCP_PROTOCOL\ EXISTS\ name=([^ ]+)$ ]]; then
      if [ "${BASH_REMATCH[1]}" = "$name" ]; then PUT_STATUS=exists; else PUT_DETAIL=reply-mismatch; fi
    elif [[ "$line" =~ ^$LCP_PROTOCOL\ REJECTED\ reason=([a-z0-9-]+)$ ]]; then
      PUT_STATUS=rejected; PUT_DETAIL="${BASH_REMATCH[1]}"
    else
      PUT_DETAIL="ssh_exit=$RUN_RC"
    fi
    log "put: name=$name size=$size status=$PUT_STATUS${PUT_DETAIL:+ detail=$PUT_DETAIL}"
  }
  if [ "$A_ARCHIVE" != present ]; then
    STEP=put-archive
    put "$ARCHIVE" "$ARC_SIZE" "$ARC_SHA" "$STAGE/$ARCHIVE"
    case "$PUT_STATUS" in
      published|exists) ;;
      ambiguous) UPLOAD=ambiguous ;;
      rejected)  fail receiver-rejected "$PUT_DETAIL,object=archive" ;;
    esac
  fi
  if [ "$UPLOAD" != ambiguous ]; then
    STEP=put-manifest
    put "$MANIFEST" "$MAN_SIZE" "$MAN_SHA" "$STAGE/$MANIFEST"
    case "$PUT_STATUS" in
      published|exists) ;;
      ambiguous) UPLOAD=ambiguous ;;
      rejected)  fail receiver-rejected "$PUT_DETAIL,object=manifest" ;;
    esac
  fi
fi

# ── independent verification through the bound audit identity (authoritative) ─
STEP=post-audit
audit_fetch "$WORK/audit-after.out"
[ "$A_STATE" != absent ] || fail audit-generation-missing "upload=$UPLOAD"
[ "$A_STATE" = complete ] || fail audit-generation-incomplete "upload=$UPLOAD"
[ "$A_SIZE" = "$ARC_SIZE" ] && [ "$A_PFX" = "$ARC_SHA_PREFIX" ] || fail audit-generation-mismatch "upload=$UPLOAD,remote_size=$A_SIZE"
[ "$UPLOAD" != ambiguous ] || log "audit: the interrupted transfer was published after all; the audit verdict is authoritative"

# ── local receipt (operational state only; atomic; own directory only) ───────
STEP=receipt
discard_stage
tmp="$(mktemp "$STATE_DIR/.receipt.XXXXXXXX")"
{
  echo "schema=lcp-offhost-send-receipt/1"
  echo "set=$SET"; echo "slot=$SLOT_LABEL"; echo "status=verified"; echo "upload=$UPLOAD"
  echo "archive_size=$ARC_SIZE"; echo "archive_sha256_prefix=$ARC_SHA_PREFIX"
  echo "destination_machine=$(lcp_prefix "$R_MACHINE")"; echo "verified_utc=$(lcp_utc "$NOW")"
  echo "elapsed_seconds=$(( SECONDS - START_SECONDS ))"
} >"$tmp"
chmod 600 "$tmp"; mv -f "$tmp" "$STATE_DIR/$SET.receipt"
find "$STATE_DIR" -maxdepth 1 -type f -name 'leadcapture-*.sql.gz.receipt' -mtime "+$KEEP_DAYS" -delete 2>/dev/null || true

STEP=done
echo "OFFHOST_UPLOAD=PASS set=$SET slot=$SLOT_LABEL archive_size=$ARC_SIZE sha256_prefix=$ARC_SHA_PREFIX destination=$(lcp_prefix "$R_MACHINE") upload=$UPLOAD audit=complete"
exit 0
