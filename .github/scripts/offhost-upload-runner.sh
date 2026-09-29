#!/bin/bash
# =============================================================================
# Lead Capture Pro — off-host upload, RUNNER side (GitHub Actions job `upload`)
# =============================================================================
# Requests the GitHub OIDC token for the uploader's Workload Identity audience
# IMMEDIATELY before opening the pinned SSH channel, streams it as the only line
# on the remote command's standard input (offhost-upload-remote.sh runs as
# `bash -c` on the VPS), and captures a sanitized OFFHOST_UPLOAD= summary.
#
# The token is masked in the job log, kept only in this process's memory, and
# never placed in a command-line argument, in the environment passed to ssh,
# in a workflow output, in a log line or in a workspace file. The SSH session
# is bounded by OFFHOST_SSH_TIMEOUT (default 240 s, hard maximum 280 s) so it
# ends inside the conservative five-minute credential window; the remote trap
# deletes the token file on any exit and a best-effort sweep removes stale
# token files afterwards. The runner never receives backup bytes: only the
# uploader's summary lines come back.
#
# Environment (Actions provides the OIDC pair; the workflow provides the rest):
#   ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN
#   OFFHOST_WIF_AUDIENCE   uploader provider resource name
#   VPS_DEPLOY_PATH        hosted checkout (offhost.env = <parent>/env/offhost.env)
#   OFFHOST_UPLOAD_LOG     capture file outside the workspace (default $RUNNER_TEMP)
#   OFFHOST_SSH_BIN/OFFHOST_SSH_TARGET/OFFHOST_REMOTE_SCRIPT/OFFHOST_SHM_DIR/OFFHOST_SWEEP  (tests)
# Exit: 0 when the uploader reported PASS or AMBIGUOUS (the independent audit
# decides health); non-zero otherwise. Summary → $GITHUB_OUTPUT (summary, exit).
# =============================================================================
set -Eeuo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_SCRIPT="${OFFHOST_REMOTE_SCRIPT:-$HERE/offhost-upload-remote.sh}"
SSH_BIN="${OFFHOST_SSH_BIN:-ssh}"; SSH_TARGET="${OFFHOST_SSH_TARGET:-vps}"
TIMEOUT="${OFFHOST_SSH_TIMEOUT:-240}"
AUD="${OFFHOST_WIF_AUDIENCE:-}"; DEPLOY="${VPS_DEPLOY_PATH:-}"
OIDC_URL="${ACTIONS_ID_TOKEN_REQUEST_URL:-}"; OIDC_BEARER="${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}"
OUT_FILE="${OFFHOST_UPLOAD_LOG:-${RUNNER_TEMP:-/tmp}/offhost-upload.log}"
SHM_DIR="${OFFHOST_SHM_DIR:-/dev/shm}"
SWEEP="${OFFHOST_SWEEP:-1}"
INSECURE_LOOPBACK="${OFFHOST_TEST_ALLOW_INSECURE_LOOPBACK:-0}"

summary_out() {   # LINE — print and export the sanitized summary, never anything else
  echo "$1"
  [ -z "${GITHUB_OUTPUT:-}" ] || echo "summary=$1" >>"$GITHUB_OUTPUT"
}
fail() { summary_out "OFFHOST_UPLOAD=FAIL reason=$1"; [ -z "${GITHUB_OUTPUT:-}" ] || echo "exit=1" >>"$GITHUB_OUTPUT"; exit 1; }

[ -f "$REMOTE_SCRIPT" ] || fail remote-script-missing
[[ "$DEPLOY" =~ ^/[A-Za-z0-9._/-]{1,200}$ ]] || fail deploy-path-format
[[ "$AUD" =~ ^//iam\.googleapis\.com/projects/[0-9]+/locations/global/workloadIdentityPools/[A-Za-z0-9_-]+/providers/[A-Za-z0-9_-]+$ ]] || fail audience-format
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] && [ "$TIMEOUT" -ge 30 ] && [ "$TIMEOUT" -le 280 ] || fail ssh-timeout-range
[[ "$SHM_DIR" =~ ^/[A-Za-z0-9._/-]{1,200}$ ]] || fail shm-dir-format
[ -n "$OIDC_URL" ] && [ -n "$OIDC_BEARER" ] || fail no-oidc-request-context
case "$OIDC_URL" in
  https://*) ;;
  http://*) [ "$INSECURE_LOOPBACK" = 1 ] && [[ "$OIDC_URL" =~ ^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?/ ]] || fail oidc-url-not-https ;;
  *) fail oidc-url-scheme ;;
esac

cfg="$(dirname "$DEPLOY")/env/offhost.env"
remote_body="$(cat "$REMOTE_SCRIPT")"
# non-secret parameters travel as environment assignments inside the remote command; the token never does
remote_cmd="DEPLOY_PATH=$(printf '%q' "$DEPLOY") OFFHOST_CONFIG=$(printf '%q' "$cfg") OFFHOST_SHM_DIR=$(printf '%q' "$SHM_DIR") bash -c $(printf '%q' "$remote_body")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/offhost-runner.XXXXXXXX")"; chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
: >"$OUT_FILE"; chmod 600 "$OUT_FILE"

# ── 1. OIDC token — requested immediately before SSH; the five-minute window starts here ─
printf 'Authorization: Bearer %s\n' "$OIDC_BEARER" >"$WORK/oidc.hdr"; chmod 600 "$WORK/oidc.hdr"; OIDC_BEARER=
sep='?'; [[ "$OIDC_URL" == *\?* ]] && sep='&'
curl -sS --fail --connect-timeout 20 --max-time 30 -H "@$WORK/oidc.hdr" -H 'Accept: application/json' \
  "${OIDC_URL}${sep}audience=$(printf '%s' "$AUD" | sed 's#/#%2F#g')" -o "$WORK/oidc.json" 2>/dev/null || fail oidc-request-failed
token="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["value"])' "$WORK/oidc.json" 2>/dev/null)" || fail oidc-response
rm -f "$WORK/oidc.json" "$WORK/oidc.hdr"
[[ "$token" =~ ^[A-Za-z0-9._-]{20,}$ ]] || fail oidc-token-format
[ -z "${GITHUB_ACTIONS:-}" ] || echo "::add-mask::$token"
requested_at="$(date +%s)"

# ── 2. SSH — the token is the only line on stdin; the session is bounded ─────
rc=0
printf '%s\n' "$token" | timeout --kill-after=10 "$TIMEOUT" "$SSH_BIN" "$SSH_TARGET" "$remote_cmd" >>"$OUT_FILE" 2>&1 || rc=$?
token=
elapsed=$(( $(date +%s) - requested_at ))

# ── 3. best-effort sweep of stale token files (own user, older than 10 minutes) ─
if [ "$SWEEP" = 1 ]; then
  timeout --kill-after=5 30 "$SSH_BIN" "$SSH_TARGET" "find $(printf '%q' "$SHM_DIR") -maxdepth 1 -name '.lcp-offhost.*' -user \"\$(id -un)\" -mmin +10 -delete 2>/dev/null; true" >/dev/null 2>&1 || true
fi

# ── 4. sanitized diagnostics and the single summary line ─────────────────────
sed -E 's/[A-Za-z0-9+\/=_-]{40,}/<masked>/g' "$OUT_FILE" | awk 'NR <= 200 { print "  " substr($0, 1, 300) }'
summary="$(grep -m1 -E '^OFFHOST_UPLOAD=(PASS|AMBIGUOUS|FAIL)( [A-Za-z0-9_]+=[A-Za-z0-9_.,:-]+)*$' "$OUT_FILE" || true)"
remote="$(grep -m1 -E '^OFFHOST_REMOTE=(OK|FAIL)( [A-Za-z0-9_]+=[A-Za-z0-9_.,:-]+)*$' "$OUT_FILE" || true)"
if [ -z "$summary" ]; then
  case "$rc" in
    124|137) summary="OFFHOST_UPLOAD=FAIL reason=ssh-timeout exit=$rc" ;;
    255)     summary="OFFHOST_UPLOAD=FAIL reason=ssh-connection-failed exit=255" ;;
    70|71)   summary="OFFHOST_UPLOAD=FAIL reason=remote-preflight-failed exit=$rc${remote:+ remote=${remote#OFFHOST_REMOTE=}}" ;;
    75)      summary="OFFHOST_UPLOAD=FAIL reason=uploader-lock-held exit=75" ;;
    *)       summary="OFFHOST_UPLOAD=FAIL reason=no-summary exit=$rc" ;;
  esac
  summary="$(printf '%s' "$summary" | tr -c 'A-Za-z0-9_.,:= -' '-')"
fi
echo "upload_exit=$rc elapsed_seconds=$elapsed ssh_timeout=$TIMEOUT remote=${remote:-none}"
summary_out "$summary"
[ -z "${GITHUB_OUTPUT:-}" ] || echo "exit=$rc" >>"$GITHUB_OUTPUT"
case "$rc" in 0|3) exit 0 ;; *) exit "$rc" ;; esac
