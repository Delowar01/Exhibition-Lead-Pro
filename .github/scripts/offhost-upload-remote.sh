# =============================================================================
# Lead Capture Pro — off-host upload, REMOTE side (runs on the VPS as the deploy user)
# =============================================================================
# Not executed as a file: the runner (offhost-upload-runner.sh) passes this text
# as the argument of `bash -c` over the pinned SSH channel, with the short-lived
# GitHub OIDC subject token as the ONLY line on standard input.
#
#   1. umask 077; create a random file under ${OFFHOST_SHM_DIR:-/dev/shm}, mode 600;
#   2. install the cleanup trap FIRST (EXIT, HUP, INT, TERM), then write the token
#      from stdin into the file — it is never echoed and never in an argument;
#   3. verify the hosted checkout (HEAD = current-deploy.sha, clean) and the
#      deployed uploader (tracked, identical to HEAD, executable);
#   4. run backup-offhost.sh with OFFHOST_SUBJECT_TOKEN_FILE=<that file>, capped
#      well inside the five-minute credential window;
#   5. the trap deletes the token file on success, failure, signal or SSH loss.
# The dump never leaves the VPS except to Cloud Storage; only the uploader's
# sanitized OFFHOST_UPLOAD= summary and one OFFHOST_REMOTE= line reach the runner.
# Exit: uploader's own status (0/1/3/75) or 70 (token/shm) / 71 (checkout/uploader).
# =============================================================================
set -Eeuo pipefail
umask 077
shm="${OFFHOST_SHM_DIR:-/dev/shm}"
deploy="${DEPLOY_PATH:?DEPLOY_PATH is required}"
cfg="${OFFHOST_CONFIG:?OFFHOST_CONFIG is required}"
[ -d "$shm" ] && [ -w "$shm" ] || { echo "OFFHOST_REMOTE=FAIL reason=shm-unavailable"; exit 70; }
tok="$(mktemp -p "$shm" .lcp-offhost.XXXXXXXXXX)" || { echo "OFFHOST_REMOTE=FAIL reason=mktemp-failed"; exit 70; }
chmod 600 "$tok"
cleanup() { rm -f "$tok"; }
trap cleanup EXIT HUP INT TERM
line=""
IFS= read -r line || true
printf '%s' "$line" >"$tok"
unset line
[ -s "$tok" ] || { echo "OFFHOST_REMOTE=FAIL reason=no-subject-token-on-stdin"; exit 70; }
state="$(dirname "$deploy")/env"
[ -f "$state/current-deploy.sha" ] || { echo "OFFHOST_REMOTE=FAIL reason=deploy-marker-missing"; exit 71; }
want="$(tr -d '[:space:]' <"$state/current-deploy.sha")"
head="$(git -C "$deploy" --no-optional-locks rev-parse HEAD 2>/dev/null || true)"
[ -n "$head" ] && [ "$head" = "$want" ] || { echo "OFFHOST_REMOTE=FAIL reason=checkout-not-deployed-revision"; exit 71; }
[ -z "$(git -C "$deploy" --no-optional-locks status --porcelain 2>/dev/null)" ] || { echo "OFFHOST_REMOTE=FAIL reason=checkout-dirty"; exit 71; }
up="$deploy/docker/scripts/backup-offhost.sh"
{ [ -f "$up" ] && [ -x "$up" ] && [ ! -L "$up" ]; } || { echo "OFFHOST_REMOTE=FAIL reason=uploader-missing"; exit 71; }
[ "$(git -C "$deploy" hash-object "$up")" = "$(git -C "$deploy" rev-parse HEAD:docker/scripts/backup-offhost.sh)" ] || { echo "OFFHOST_REMOTE=FAIL reason=uploader-differs-from-head"; exit 71; }
{ [ -f "$cfg" ] && [ ! -L "$cfg" ]; } || { echo "OFFHOST_REMOTE=FAIL reason=config-missing"; exit 71; }
echo "OFFHOST_REMOTE=OK checkout=deployed uploader=tracked token_file=shm mode=600"
rc=0
OFFHOST_SUBJECT_TOKEN_FILE="$tok" OFFHOST_CONFIG="$cfg" OFFHOST_MAX_TIME="${OFFHOST_MAX_TIME:-120}" OFFHOST_CONNECT_TIMEOUT="${OFFHOST_CONNECT_TIMEOUT:-15}" bash "$up" || rc=$?
exit "$rc"
