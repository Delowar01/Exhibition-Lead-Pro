#!/bin/bash
# =============================================================================
# Lead Capture Pro — hosted PostgreSQL backup health verifier (STRICTLY READ-ONLY)
# =============================================================================
# Runs ON the dev VPS as the deploy user. .github/workflows/backup-health-alert.yml
# pipes it over SSH standard input, so nothing is copied to the host:
#
#     ssh vps "DEPLOY_PATH='<checkout>' BACKUP_MAX_AGE_HOURS=4 bash -s" \
#         < .github/scripts/verify-hosted-backup.sh
#
# What it never does: create a backup, edit cron, restore, connect to the
# database, run retention, write under the backup directory or the checkout
# (git is invoked with --no-optional-locks), read or print the hosted .env.
# What it prints: file names, sizes, counts, ages, status codes and a short
# checksum prefix — never credentials, connection strings, dump contents or
# complete checksums.
#
# Inputs (environment, validated before use):
#   DEPLOY_PATH           hosted checkout, absolute path                (required)
#   STATE_DIR             deploy markers          default: <parent of DEPLOY_PATH>/env
#   BACKUP_DIR            backup directory        default: /opt/lead-capture-pro/backups/postgres
#   EXPECTED_KEEP         KEEP in the documented backup crontab line, default: 14
#
# Freshness (B23 G-6 Correction 3B — slot-aware, not wall-clock): the daily
# backup runs at 03:15 UTC. From the VPS's current UTC time the most recent
# EXPECTED SLOT is derived (today 03:15 UTC once that time has passed, otherwise
# yesterday 03:15 UTC); the newest backup must belong to that slot — BOTH its
# filename stamp and its mtime must satisfy slot <= t < slot + 24 h and t <= now.
# A GitHub-scheduled run that starts hours late therefore still passes as long as
# the expected backup exists, while yesterday's backup never passes once the next
# slot has begun. The VPS-local 03:45 UTC check keeps its own strict 4 h limit;
# only the limit handed to the deployed checker by THIS external run is computed
# from the slot age (ceil(hours)+1, min 4, max 25) so it can repeat its integrity
# checks after a late start. Nothing here depends on the GitHub run start time.
#
# Library mode: `VERIFY_HOSTED_BACKUP_LIB=1 source verify-hosted-backup.sh` loads
# only the pure slot functions (for the deterministic test harness) and runs nothing.
#
# Exit 0 and print exactly one summary line
#     BACKUP_HEALTH=PASS file=<name> age_minutes=<n> size_bytes=<n>
# only when EVERY assertion below holds. Otherwise print
#     BACKUP_HEALTH=FAIL reason=<code>[ detail=<safe values>]
# and exit 1. Any unexpected error fails closed through the ERR trap.
#
# Assertions:
#   checkout   hosted worktree clean; HEAD equals <STATE_DIR>/current-deploy.sha
#   cron       cron service active; the documented 03:15 backup line (KEEP) and
#              03:45 check line (BACKUP_MAX_AGE_HOURS=4) each occur exactly once
#              and nothing else references the two scripts
#   scripts    deployed backup-postgres.sh / backup-check.sh exist, are regular
#              executable files and are identical to the committed HEAD blobs
#   dir        backup directory exists, mode 700, owned by the deploy user, and
#              holds no temporary/partial files
#   newest     newest leadcapture-YYYYMMDD-HHMMSS.sql.gz (by mtime = by name):
#              regular file, filename stamp AND mtime inside the expected slot
#              (not in the future, not malformed), size >= 1024, mode 600, owned
#              by the deploy user; .sha256 sidecar present (mode 600), single line that
#              names this file; sha256sum -c passes; gzip -t passes; the stream
#              starts as a PostgreSQL dump, ends with the completion marker and
#              contains at least one CREATE TABLE and one COPY block (the table
#              count is deliberately NOT pinned — additive migrations change it)
#   check      finally the deployed backup-check.sh itself passes with a limit
#              computed from the expected slot's age (run last so a failure reports the specific
#              reason found by the independent checks above)
# =============================================================================
# ── pure slot functions (UTC epoch arithmetic only; deterministic; no side effects) ──
SLOT_HOUR=3    # the documented daily backup slot: 03:15 UTC
SLOT_MINUTE=15
SLOT_SECONDS=86400
CHECKER_LIMIT_MIN_HOURS=4   # never below the VPS-local strict limit
CHECKER_LIMIT_MAX_HOURS=25  # ceil(<24 h)+1: the largest age a current slot can have

# slot_expected_epoch NOW_EPOCH → epoch of the most recent expected slot
# (today 03:15 UTC once reached, otherwise yesterday 03:15 UTC). Epoch days are
# UTC-aligned and UTC has no DST, so integer arithmetic is exact.
slot_expected_epoch() {
  local now="$1" day_start today_slot
  [[ "$now" =~ ^[0-9]+$ ]] || return 1
  day_start=$(( now - (now % SLOT_SECONDS) ))
  today_slot=$(( day_start + SLOT_HOUR * 3600 + SLOT_MINUTE * 60 ))
  if [ "$now" -ge "$today_slot" ]; then echo "$today_slot"; else echo $(( today_slot - SLOT_SECONDS )); fi
}
# slot_label SLOT_EPOCH → YYYYMMDD-HHMM (safe for summary lines)
slot_label() { date -u -d @"$1" +%Y%m%d-%H%M; }
# backup_stamp_epoch NAME → epoch of the leadcapture-YYYYMMDD-HHMMSS stamp;
# returns 1 for a malformed name or an impossible calendar date/time.
backup_stamp_epoch() {
  local n="$1" d t e
  [[ "$n" =~ ^leadcapture-([0-9]{8})-([0-9]{6})\.sql\.gz$ ]] || return 1
  d="${BASH_REMATCH[1]}"; t="${BASH_REMATCH[2]}"
  e="$(date -u -d "${d:0:4}-${d:4:2}-${d:6:2} ${t:0:2}:${t:2:2}:${t:4:2}" +%s 2>/dev/null)" || return 1
  [ "$(date -u -d @"$e" +%Y%m%d-%H%M%S)" = "${d}-${t}" ] || return 1   # round-trip rejects e.g. 20260931
  echo "$e"
}
# slot_contains NOW_EPOCH SLOT_EPOCH T_EPOCH → 0 iff slot <= t < slot + 24 h and t <= now
slot_contains() {
  local now="$1" slot="$2" t="$3"
  [[ "$t" =~ ^[0-9]+$ ]] || return 1
  [ "$t" -ge "$slot" ] && [ "$t" -lt $(( slot + SLOT_SECONDS )) ] && [ "$t" -le "$now" ]
}
# checker_limit_hours NOW_EPOCH SLOT_EPOCH → ceil(slot age / 1 h) + 1, clamped to [4, 25];
# derived from the slot only (never from the file's mtime) and used solely for the
# external invocation of the deployed checker.
checker_limit_hours() {
  local age=$(( $1 - $2 )) h
  [ "$age" -ge 0 ] || age=0
  h=$(( (age + 3599) / 3600 + 1 ))
  [ "$h" -ge "$CHECKER_LIMIT_MIN_HOURS" ] || h="$CHECKER_LIMIT_MIN_HOURS"
  [ "$h" -le "$CHECKER_LIMIT_MAX_HOURS" ] || h="$CHECKER_LIMIT_MAX_HOURS"
  echo "$h"
}

# ── library mode ends here (nothing below runs when sourced for tests) ──
if [ "${VERIFY_HOSTED_BACKUP_LIB:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

set -Eeuo pipefail
umask 077

STEP=init
trap 'rc=$?; echo "BACKUP_HEALTH=FAIL reason=unexpected-error step=$STEP exit=$rc"; exit 1' ERR

fail() { echo "BACKUP_HEALTH=FAIL reason=$1${2:+ $2}"; exit 1; }
# Output of the deployed checker is names/ages/sizes/counts only; mask defensively anyway.
# awk consumes the whole input (a `head` here would close the pipe early on long
# output and turn the upstream SIGPIPE into a false failure under pipefail):
# at most 12 lines are shown, each cut to 300 characters.
sanitize() {
  sed -E 's#(postgres(ql)?://)[^[:space:]]+#\1<masked>#g; s/[A-Za-z0-9+\/=_-]{40,}/<masked>/g' |
    awk 'NR <= 12 { print substr($0, 1, 300) }'
}

main() {
  STEP=inputs
  local deploy_path state_dir backup_dir keep
  deploy_path="${DEPLOY_PATH:-}"
  [[ "$deploy_path" =~ ^/[A-Za-z0-9._/-]{1,200}$ ]] || fail invalid-deploy-path
  state_dir="${STATE_DIR:-$(dirname "$deploy_path")/env}"
  [[ "$state_dir" =~ ^/[A-Za-z0-9._/-]{1,200}$ ]] || fail invalid-state-dir
  backup_dir="${BACKUP_DIR:-/opt/lead-capture-pro/backups/postgres}"
  [[ "$backup_dir" =~ ^/[A-Za-z0-9._/-]{1,200}$ ]] || fail invalid-backup-dir
  keep="${EXPECTED_KEEP:-14}"
  [[ "$keep" =~ ^[0-9]{1,3}$ ]] && [ "$keep" -ge 1 ] || fail invalid-expected-keep
  echo "verifier: host_utc=$(date -u +%FT%TZ) expected_keep=$keep freshness=slot-aware(03:15Z)"

  # ── checkout: clean worktree, HEAD = current-deploy.sha ─────────────────────
  STEP=checkout
  local head dirty marker
  [ -d "$deploy_path/.git" ] || fail checkout-missing
  head="$(git -C "$deploy_path" --no-optional-locks rev-parse HEAD 2>/dev/null)" || fail checkout-unreadable
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || fail checkout-head-invalid
  dirty="$(git -C "$deploy_path" --no-optional-locks status --porcelain 2>/dev/null | wc -l)" || fail checkout-status-failed
  [ "$dirty" = "0" ] || fail checkout-dirty "detail=entries=$dirty"
  [ -f "$state_dir/current-deploy.sha" ] || fail deploy-marker-missing
  marker="$(tr -d '[:space:]' < "$state_dir/current-deploy.sha")"
  [[ "$marker" =~ ^[0-9a-f]{40}$ ]] || fail deploy-marker-invalid
  [ "$marker" = "$head" ] || fail deployment-drift "detail=head=${head:0:12},marker=${marker:0:12}"
  echo "checkout: head=$head deploy_marker=match clean=yes"

  # ── cron: service active, the two documented lines exactly once ─────────────
  STEP=cron
  local active ct exp_backup exp_check n_backup n_check n_any
  active="$(systemctl is-active cron 2>/dev/null || true)"
  [ "$active" = "active" ] || active="$(systemctl is-active crond 2>/dev/null || true)"
  [ "$active" = "active" ] || fail cron-service-not-active
  ct="$(crontab -l 2>/dev/null)" || fail crontab-missing
  exp_backup="15 3 * * * DEPLOY_PATH=$deploy_path BACKUP_DIR=$backup_dir KEEP=$keep bash $deploy_path/docker/scripts/backup-postgres.sh >> $backup_dir/backup.log 2>&1"
  exp_check="45 3 * * * BACKUP_DIR=$backup_dir BACKUP_MAX_AGE_HOURS=4 bash $deploy_path/docker/scripts/backup-check.sh >> $backup_dir/backup.log 2>&1"
  n_backup="$(printf '%s\n' "$ct" | grep -cxF -- "$exp_backup" || true)"
  n_check="$(printf '%s\n' "$ct" | grep -cxF -- "$exp_check" || true)"
  n_any="$(printf '%s\n' "$ct" | grep -cE 'backup-(postgres|check)\.sh' || true)"
  [ "$n_backup" = "1" ] || fail backup-cron-not-exactly-once "detail=exact_matches=$n_backup"
  [ "$n_check" = "1" ] || fail check-cron-not-exactly-once "detail=exact_matches=$n_check"
  [ "$n_any" = "2" ] || fail unexpected-backup-cron-entries "detail=mentions=$n_any"
  echo "cron: service=active backup_0315=1 check_0345=1 other_mentions=0"

  # ── scripts: present, executable, identical to the committed HEAD blobs ─────
  STEP=scripts
  local s p blob tracked
  for s in backup-postgres.sh backup-check.sh; do
    p="$deploy_path/docker/scripts/$s"
    { [ -f "$p" ] && [ ! -L "$p" ]; } || fail script-missing "detail=$s"
    [ -x "$p" ] || fail script-not-executable "detail=$s"
    blob="$(git -C "$deploy_path" --no-optional-locks hash-object "$p")" || fail script-hash-failed "detail=$s"
    tracked="$(git -C "$deploy_path" --no-optional-locks rev-parse "HEAD:docker/scripts/$s" 2>/dev/null)" || fail script-not-tracked "detail=$s"
    [ "$blob" = "$tracked" ] || fail script-differs-from-head "detail=$s"
  done
  echo "scripts: backup-postgres.sh=ok backup-check.sh=ok (executable, identical to HEAD)"

  # ── backup directory ────────────────────────────────────────────────────────
  STEP=backup-dir
  local me ntmp
  me="$(id -un)"
  [ -d "$backup_dir" ] || fail backup-dir-missing
  [ "$(stat -c %a "$backup_dir")" = "700" ] || fail backup-dir-mode "detail=mode=$(stat -c %a "$backup_dir")"
  [ "$(stat -c %U "$backup_dir")" = "$me" ] || fail backup-dir-owner
  ntmp="$(find "$backup_dir" -maxdepth 1 -type f \( -name '.leadcapture-*' -o -name '*.tmp' -o -name '*.part' -o -name '*.partial' \) | wc -l)"
  [ "$ntmp" = "0" ] || fail temporary-files-present "detail=count=$ntmp"
  echo "backup-dir: mode=700 owner=ok temporary_files=0"

  # ── independent verification of the newest published backup ────────────────
  STEP=newest-backup
  local -a files=()
  local f n m newest="" newest_m=0 newest_name="" name mtime now age_min size mode sc sc_line sc_sum sc_name actual
  local expected_slot next_slot slot_lbl stamp_epoch
  shopt -s nullglob; files=( "$backup_dir"/leadcapture-*.sql.gz ); shopt -u nullglob
  [ "${#files[@]}" -gt 0 ] || fail no-backup-file
  for f in "${files[@]}"; do
    m="$(stat -c %Y "$f")"; n="${f##*/}"
    if [ "$m" -gt "$newest_m" ]; then newest_m="$m"; newest="$f"; fi
    if [[ "$n" > "$newest_name" ]]; then newest_name="$n"; fi
  done
  name="${newest##*/}"
  [ "$name" = "$newest_name" ] || fail newest-by-mtime-and-by-name-differ "detail=by_mtime=$name,by_name=$newest_name"
  [[ "$name" =~ ^leadcapture-[0-9]{8}-[0-9]{6}\.sql\.gz$ ]] || fail unexpected-backup-name
  { [ -f "$newest" ] && [ ! -L "$newest" ]; } || fail newest-not-a-regular-file
  # ── slot-aware freshness: the newest backup must belong to the expected slot ──
  mtime="$newest_m"; now="$(date -u +%s)"
  expected_slot="$(slot_expected_epoch "$now")"; next_slot=$(( expected_slot + SLOT_SECONDS )); slot_lbl="$(slot_label "$expected_slot")"
  echo "slot: now_utc=$(date -u -d @"$now" +%FT%TZ) expected_slot=$slot_lbl next_slot=$(slot_label "$next_slot") newest=$name"
  stamp_epoch="$(backup_stamp_epoch "$name")" || fail malformed-backup-timestamp "detail=expected_slot=$slot_lbl,newest=$name"
  [ "$stamp_epoch" -le "$now" ] || fail future-backup-timestamp "detail=expected_slot=$slot_lbl,newest=$name"
  [ "$mtime" -le "$now" ] || fail future-backup-mtime "detail=expected_slot=$slot_lbl,newest=$name"
  slot_contains "$now" "$expected_slot" "$stamp_epoch" || fail expected-slot-backup-missing "detail=expected_slot=$slot_lbl,newest=$name,stamp_in_slot=no"
  slot_contains "$now" "$expected_slot" "$mtime" || fail backup-mtime-outside-slot "detail=expected_slot=$slot_lbl,newest=$name,mtime_in_slot=no"
  age_min=$(( (now - mtime) / 60 ))
  size="$(stat -c %s "$newest")"
  [ "$size" -ge 1024 ] || fail backup-too-small "detail=size_bytes=$size"
  mode="$(stat -c %a "$newest")"
  [ "$mode" = "600" ] || fail backup-mode "detail=mode=$mode"
  [ "$(stat -c %U "$newest")" = "$me" ] || fail backup-owner
  sc="$newest.sha256"
  { [ -f "$sc" ] && [ ! -L "$sc" ]; } || fail sidecar-missing
  [ "$(stat -c %a "$sc")" = "600" ] || fail sidecar-mode "detail=mode=$(stat -c %a "$sc")"
  [ "$(grep -c . "$sc")" = "1" ] || fail sidecar-format "detail=lines=$(grep -c . "$sc")"
  sc_line="$(head -n 1 "$sc")"
  [[ "$sc_line" =~ ^([0-9a-f]{64})[[:space:]]+\*?([^[:space:]]+)$ ]] || fail sidecar-format
  sc_sum="${BASH_REMATCH[1]}"; sc_name="${BASH_REMATCH[2]}"
  [ "$sc_name" = "$name" ] || fail sidecar-names-other-file
  actual="$(sha256sum "$newest" | cut -c1-64)"
  [ "$actual" = "$sc_sum" ] || fail checksum-mismatch
  ( cd "$backup_dir" && sha256sum -c --quiet --strict "$name.sha256" >/dev/null 2>&1 ) || fail checksum-mismatch "detail=sha256sum-c"
  gzip -t "$newest" 2>/dev/null || fail gzip-invalid
  local stats hdr ct_n cp_n done_n last_n
  stats="$(zcat "$newest" 2>/dev/null | awk '
      NR<=3 && $0=="-- PostgreSQL database dump" {hdr=1}
      /^CREATE TABLE /{ct++}
      /^COPY /{cp++}
      $0=="-- PostgreSQL database dump complete" {done=NR}
      {last=NR}
      END{printf "%d|%d|%d|%d|%d\n", hdr+0, ct+0, cp+0, done+0, last+0}')" || fail dump-unreadable
  IFS='|' read -r hdr ct_n cp_n done_n last_n <<< "$stats"
  [ "$hdr" = "1" ] || fail dump-header-missing
  { [ "$done_n" -gt 0 ] && [ $(( last_n - done_n )) -le 3 ]; } || fail completion-marker-missing
  [ "$ct_n" -ge 1 ] || fail no-create-table
  [ "$cp_n" -ge 1 ] || fail no-copy-block
  echo "newest: file=$name stamp_utc=$(date -u -d @"$stamp_epoch" +%FT%TZ) mtime_utc=$(date -u -d @"$mtime" +%FT%TZ) slot=$slot_lbl age_minutes=$age_min size_bytes=$size mode=600 owner=ok sidecar=ok sha256_prefix=${sc_sum:0:12} sha256sum_c=ok gzip=ok header=ok completion_marker=ok create_table=$ct_n copy_blocks=$cp_n"

  # ── finally the deployed checker itself, with a limit derived from the slot age ──
  # (the VPS-local 03:45 cron keeps BACKUP_MAX_AGE_HOURS=4; this external run may
  # start hours late, so it hands the checker ceil(slot age)+1 h, min 4, max 25)
  STEP=deployed-check
  local check_out check_rc=0 check_limit
  check_limit="$(checker_limit_hours "$now" "$expected_slot")"
  echo "deployed-check: limit_hours=$check_limit (computed from the expected slot age; the VPS 03:45 check keeps its own 4 h)"
  check_out="$(BACKUP_DIR="$backup_dir" BACKUP_MAX_AGE_HOURS="$check_limit" bash "$deploy_path/docker/scripts/backup-check.sh" 2>&1)" || check_rc=$?
  printf '%s\n' "$check_out" | sanitize | sed 's/^/deployed-check: /'
  [ "$check_rc" = "0" ] || fail deployed-check-failed "detail=exit=$check_rc"

  STEP=done
  echo "BACKUP_HEALTH=PASS file=$name slot=$slot_lbl age_minutes=$age_min size_bytes=$size"
}

# The script arrives on standard input (bash -s): the function above is parsed
# completely before this line runs, and main gets /dev/null so no command can
# consume the rest of the script.
main "$@" </dev/null
exit 0
