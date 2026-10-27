#!/bin/bash
# =============================================================================
# B30 RECOVERY RUNNER — RUNNER-SIDE LIBRARY (pure functions; no network, no secrets, no host access).
# Sourced by .github/workflows/b30-recovery-runner.yml (after its own hash was verified against the pin in the
# workflow) and by .github/recovery/test/b30-runner.test.sh. Every function prints fixed tokens / integers only and
# returns 0 (accept) or 1 (refuse, with b30_input_error=<token>). Nothing here executes text taken from an input.
# =============================================================================
B30_MODE_CHECK="b30_recovery_check"
B30_MODE_SET="b30_recovery_set"
B30_REQ_RECOVERY="CREATE_B30_PRE_COPY_RECOVERY_SET"
B30_REQ_QUIET="B30 QUIET PERIOD ACTIVE"
B30_REQ_PAUSED="UPLOADS BRANDING EXPORTS DELETIONS PAUSED"
B30_TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$'
B30_MAX_WINDOW_MIN=240          # an approved quiet period is short; the set run takes minutes
B30_MIN_REMAINING_MIN=10        # the host session must start with at least this much window left
# UTC exclusion windows as minutes of day [from:to): nightly dump 03:15 + backup-check 03:45 -> 03:00-04:00;
# backup-health-alert scheduled 04:30 UTC, observed running until ~10:30 -> 04:15-10:45. The application does not
# enforce any quiet period; these rules only keep the hosted session away from the known scheduled jobs.
B30_EXCLUSIONS="180:240 255:645"

b30_refuse() { printf 'b30_input_error=%s\n' "$1"; return 1; }

# <YYYY-MM-DDTHH:MMZ> -> epoch seconds (the string is shape-checked by the caller)
b30_epoch() { date -u -d "${1:0:10} ${1:11:5}:00 UTC" +%s 2>/dev/null; }

# b30_window_check <start> <end> <now_epoch>: shape, same UTC day, order, length, active now, remaining, exclusions
b30_window_check() {
  local s="$1" e="$2" now="$3" se ee sm em x a b
  [[ "$s" =~ $B30_TS_RE ]] && [[ "$e" =~ $B30_TS_RE ]] || { b30_refuse timestamp_malformed; return 1; }
  [[ "$now" =~ ^[0-9]+$ ]] || { b30_refuse clock_invalid; return 1; }
  se="$(b30_epoch "$s")"; ee="$(b30_epoch "$e")"
  [ -n "$se" ] && [ -n "$ee" ] || { b30_refuse timestamp_invalid; return 1; }
  [ "${s:0:10}" = "${e:0:10}" ] || { b30_refuse window_spans_days; return 1; }
  [ "$se" -lt "$ee" ] || { b30_refuse window_order; return 1; }
  [ $(( (ee - se) / 60 )) -le "$B30_MAX_WINDOW_MIN" ] || { b30_refuse window_too_long; return 1; }
  [ "$now" -ge "$se" ] || { b30_refuse window_not_started; return 1; }
  [ "$now" -lt "$ee" ] || { b30_refuse window_expired; return 1; }
  [ $(( (ee - now) / 60 )) -ge "$B30_MIN_REMAINING_MIN" ] || { b30_refuse window_remaining_too_short; return 1; }
  sm=$(( (se % 86400) / 60 )); em=$(( (ee % 86400) / 60 )); [ "$em" = 0 ] && em=1440
  for x in $B30_EXCLUSIONS; do
    a="${x%%:*}"; b="${x##*:}"
    if [ "$sm" -lt "$b" ] && [ "$a" -lt "$em" ]; then b30_refuse window_overlaps_exclusion; return 1; fi
  done
  printf 'b30_window=ok b30_window_minutes=%s b30_window_remaining_minutes=%s\n' $(( (ee - se) / 60 )) $(( (ee - now) / 60 ))
}

# b30_validate_inputs: env MODE IN_PRODUCT_SHA IN_RECOVERY IN_QUIET IN_PAUSED IN_START IN_END B30_PRODUCT_SHA [NOW_EPOCH]
#   check mode: every confirmation and both timestamps must be EMPTY (read-only session, nothing created)
#   set mode:   exact typed confirmations + an ACTIVE approved quiet-period window
b30_validate_inputs() {
  local v
  case "${MODE:-}" in "$B30_MODE_CHECK"|"$B30_MODE_SET") ;; *) b30_refuse unknown_mode; return 1;; esac
  for v in IN_PRODUCT_SHA IN_RECOVERY IN_QUIET IN_PAUSED IN_START IN_END B30_PRODUCT_SHA; do
    [ "${!v+x}" = x ] || { b30_refuse missing_input_variable; return 1; }
  done
  if [ "$MODE" = "$B30_MODE_CHECK" ]; then
    [ -z "$IN_PRODUCT_SHA$IN_RECOVERY$IN_QUIET$IN_PAUSED$IN_START$IN_END" ] || { b30_refuse must_be_empty_in_check_mode; return 1; }
    printf 'b30_inputs=ok b30_mode=%s\n' "$MODE"; return 0
  fi
  [[ "$B30_PRODUCT_SHA" =~ ^[0-9a-f]{40}$ ]] || { b30_refuse product_pin_malformed; return 1; }
  [ "$IN_PRODUCT_SHA" = "$B30_PRODUCT_SHA" ] || { b30_refuse confirmation_mismatch_product_sha; return 1; }
  [ "$IN_RECOVERY" = "$B30_REQ_RECOVERY" ] || { b30_refuse confirmation_mismatch_recovery; return 1; }
  [ "$IN_QUIET" = "$B30_REQ_QUIET" ] || { b30_refuse confirmation_mismatch_quiet_period; return 1; }
  [ "$IN_PAUSED" = "$B30_REQ_PAUSED" ] || { b30_refuse confirmation_mismatch_paused; return 1; }
  b30_window_check "$IN_START" "$IN_END" "${NOW_EPOCH:-$(date -u +%s)}" || return 1
  printf 'b30_inputs=ok b30_mode=%s\n' "$MODE"
}

# b30_guard_identity: env GH_REF GH_SHA GH_WORKFLOW_REF GH_REPOSITORY EXPECTED_REF EXPECTED_WORKFLOW_PATH (HEAD from git)
b30_guard_identity() {
  local head
  [ "${GH_REF:-}" = "${EXPECTED_REF:?}" ] || { b30_refuse wrong_branch; return 1; }
  head="$(git rev-parse HEAD 2>/dev/null || true)"
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] && [ "$head" = "${GH_SHA:-}" ] || { b30_refuse head_mismatch; return 1; }
  [ "${GH_WORKFLOW_REF:-}" = "${GH_REPOSITORY:-}/${EXPECTED_WORKFLOW_PATH:?}@${EXPECTED_REF}" ] || { b30_refuse workflow_ref_mismatch; return 1; }
  printf 'b30_identity=ok\n'
}

# b30_guard_scope <base_sha> <allowed-list-file>: HEAD descends from the product commit; the files that differ from it are
# EXACTLY the listed recovery files (no product, schema, docker, deploy or Stage 2B file); worktree clean
b30_guard_scope() {
  local base="$1" list="$2" diffl
  [[ "$base" =~ ^[0-9a-f]{40}$ ]] || { b30_refuse base_malformed; return 1; }
  git merge-base --is-ancestor "$base" HEAD 2>/dev/null || { b30_refuse base_not_ancestor; return 1; }
  diffl="$(git diff --name-only "$base" HEAD | LC_ALL=C sort)"
  [ -n "$diffl" ] || { b30_refuse scope_empty; return 1; }
  [ "$diffl" = "$(grep -v '^#' "$list" | grep . | LC_ALL=C sort)" ] || { b30_refuse scope_mismatch; return 1; }
  printf '%s\n' "$diffl" | grep -qvE '^\.github/(recovery/|workflows/b30-recovery-runner\.yml$)' && { b30_refuse scope_outside_recovery; return 1; }
  [ -z "$(git status --porcelain)" ] || { b30_refuse worktree_dirty; return 1; }
  printf 'b30_scope=ok b30_changed_files=%s\n' "$(printf '%s\n' "$diffl" | grep -c .)"
}

# b30_guard_pins <pins-file in sha256sum format>
b30_guard_pins() {
  ( LC_ALL=C sha256sum -c --quiet --strict "$1" >/dev/null 2>&1 ) || { b30_refuse pin_mismatch; return 1; }
  printf 'b30_pins=ok b30_pinned_files=%s\n' "$(grep -c . "$1")"
}

# b30_filter_summary: stdin = everything the host session wrote to stdout. Only B30_<KEY>=<token> lines pass; any other
# non-empty line is counted and the function fails. No value may carry a hex run of 16+ characters (key ids, digests,
# tokens) except the approved commit identity.
b30_filter_summary() {
  local line bad=0 key val
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    if [[ "$line" =~ ^(B30_[A-Z0-9_]+)=([A-Za-z0-9_.:+-]+)$ ]]; then
      key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
      if [ "$key" != "B30_PRODUCT_COMMIT" ] && [[ "$val" =~ [0-9a-fA-F]{16,} ]]; then bad=$((bad + 1)); continue; fi
      printf '%s\n' "$line"
    else
      bad=$((bad + 1))
    fi
  done
  [ "$bad" = 0 ] || { printf 'B30_RUNNER_FILTER=rejected_lines:%s\n' "$bad"; return 1; }
}
