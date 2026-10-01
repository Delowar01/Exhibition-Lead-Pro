#!/bin/bash
# =============================================================================
# Lead Capture Pro — off-host backup receiver (BACKUP VPS, forced command)
# =============================================================================
# The ONLY program the upload identity can run. It is bound in
# ~lcp-receive/.ssh/authorized_keys with
#   restrict,command="/opt/lcp-offhost/bin/offhost-receive.sh" ssh-ed25519 …
# (restrict = no PTY, no agent/X11/port forwarding, no user-rc). The client's
# requested command arrives in SSH_ORIGINAL_COMMAND and is parsed as a
# two-verb protocol — nothing else is ever executed:
#
#   HELLO                      → identity line (machine-id hash, host-key
#                                fingerprints, file-system id, root state)
#   PUT <name> <size> <sha256> → capacity preflight through the privileged
#                                publisher (read-only), then receive exactly
#                                <size> bytes on stdin into a private temporary
#                                file, validate (exact size, sha256, format,
#                                slot window, no future stamp), hand the file
#                                to the privileged publisher and relay its
#                                single-line verdict
#
# Storage exhaustion (B23 G-6D C2): before a single byte of a PUT is read, the
# publisher's read-only preflight confirms — as root, because this user can
# neither list nor read published/ — that the declared object fits above the
# configured free-space reserve, is below the per-archive maximum, and that
# the slot has not reached its generation cap. The publisher repeats the same
# checks immediately before publication. The uploader only ever sees a stable
# reason code, never a path, mount or free-space figure.
#
# The receiver chooses and validates every destination itself; the client can
# name an object but never a path. It writes only under <root>/incoming/
# (temporary and pending files it created), never lists, reads, renames,
# overwrites or deletes anything under <root>/published/ — that tree is owned
# by the vault identity and is unreadable for this user. A failed or
# interrupted upload leaves no partial file behind (own temporaries only).
#
# Replies (always exactly one final line on stdout):
#   LCP-OFFHOST/1 HELLO machine=… hostkeys=… fsid=… root=ok|missing
#   LCP-OFFHOST/1 PUBLISHED name=<name> size=<n> sha256_prefix=<12>
#   LCP-OFFHOST/1 EXISTS name=<name>            (never overwritten)
#   LCP-OFFHOST/1 REJECTED reason=<stable-code>
#
# Non-secret configuration: OFFHOST_CONFIG (default /etc/lcp-offhost/offhost.env,
# root-owned): OFFHOST_ROOT, OFFHOST_PUBLISH_CMD, OFFHOST_MAX_ARCHIVE_BYTES,
# OFFHOST_MAX_MANIFEST_BYTES, OFFHOST_MAX_GENERATIONS_PER_SLOT,
# OFFHOST_MIN_FREE_BYTES, OFFHOST_SLOT_WINDOW. Environment-only test hooks:
# OFFHOST_NOW, LCP_MACHINE_ID_FILE, LCP_HOSTKEY_DIR, LCP_FSID_OVERRIDE.
# Never printed: paths, file contents, checksums beyond a 12-character prefix.
# =============================================================================
set -Eeuo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin   # fixed before any external tool (B23 G-6D C5)
HERE="$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)"
# shellcheck source=offhost-lib.sh
source "$HERE/offhost-lib.sh"

reply()  { echo "$LCP_PROTOCOL $*"; }
reject() { reply "REJECTED reason=$1"; exit 2; }
trap 'reply "REJECTED reason=unexpected-error"; exit 2' ERR
TMP=""
cleanup() { [ -n "$TMP" ] && rm -f -- "${TMP:?}"; return 0; }
trap cleanup EXIT

lcp_load_config "${OFFHOST_CONFIG:-/etc/lcp-offhost/offhost.env}" "$LCP_VAULT_CONFIG_KEYS" 2>/dev/null || reject config-invalid
ROOT="${OFFHOST_ROOT:-/srv/lcp-offhost}"
PUBLISH_CMD="${OFFHOST_PUBLISH_CMD:-sudo -n /opt/lcp-offhost/bin/offhost-publish.sh}"
MAX_ARCHIVE="${OFFHOST_MAX_ARCHIVE_BYTES:-$LCP_DEFAULT_MAX_ARCHIVE_BYTES}"
MAX_MANIFEST="${OFFHOST_MAX_MANIFEST_BYTES:-65536}"
MAX_GEN="${OFFHOST_MAX_GENERATIONS_PER_SLOT:-$LCP_DEFAULT_MAX_GENERATIONS_PER_SLOT}"
MIN_FREE="${OFFHOST_MIN_FREE_BYTES:-$LCP_DEFAULT_MIN_FREE_BYTES}"
WINDOW="${OFFHOST_SLOT_WINDOW:-2}"
NOW="${OFFHOST_NOW:-$(date -u +%s)}"
[[ "$ROOT" =~ $LCP_PATH_RE ]] || reject config-invalid
[[ "$PUBLISH_CMD" =~ ^[A-Za-z0-9_./-]+( [A-Za-z0-9_./-]+)*$ ]] || reject config-invalid
[[ "$MAX_MANIFEST" =~ $LCP_SIZE_RE ]] && [ "$MAX_MANIFEST" -le 1048576 ] || reject config-invalid
lcp_capacity_settings_ok "$MAX_GEN" "$MIN_FREE" "$MAX_ARCHIVE" || reject config-invalid
[[ "$WINDOW" =~ ^[0-9]{1,2}$ ]] || reject config-invalid
[[ "$NOW" =~ ^[0-9]+$ ]] || reject config-invalid

# ── command parsing: plain tokens only, at most four ─────────────────────────
CMD="${SSH_ORIGINAL_COMMAND:-}"
[ -n "$CMD" ] || reject no-command
[[ "$CMD" =~ ^[A-Za-z0-9._-]+( [A-Za-z0-9._-]+){0,3}$ ]] || reject invalid-command
read -r VERB A1 A2 A3 <<<"$CMD"
case "$VERB" in
  HELLO)
    [ -z "$A1" ] || reject invalid-command
    lcp_hello_line "$ROOT"; exit 0 ;;
  PUT) [ -n "$A3" ] || reject invalid-command ;;
  *) reject unsupported-command ;;
esac
NAME="$A1"; SIZE="$A2"; SHA="$A3"

# ── object validation before a single byte is read ───────────────────────────
lcp_object_kind "$NAME" || reject invalid-name
KIND="$LCP_KIND"; SET="$LCP_SET"
STAMP="$(lcp_stamp_epoch "$SET")"; IDX="$(lcp_slot_index "$STAMP")"; CUR="$(lcp_slot_index "$NOW")"
[ "$STAMP" -le "$NOW" ] && [ "$IDX" -le "$CUR" ] || reject future-stamp
[ "$IDX" -ge $(( CUR - WINDOW )) ] || reject slot-out-of-window
[[ "$SIZE" =~ $LCP_SIZE_RE ]] || reject invalid-size
[[ "$SHA" =~ $LCP_SHA256_RE ]] || reject invalid-checksum
case "$KIND" in
  archive)  [ "$SIZE" -ge 64 ] || reject size-out-of-range; [ "$SIZE" -le "$MAX_ARCHIVE" ] || reject archive-too-large ;;
  manifest) [ "$SIZE" -le "$MAX_MANIFEST" ] || reject size-out-of-range ;;
esac
SLOT="$(lcp_slot_label "$IDX")"
lcp_root_ok "$ROOT" || reject root-unavailable
INCOMING="$ROOT/incoming"
{ [ -d "$INCOMING" ] && [ ! -L "$INCOMING" ] && [ -w "$INCOMING" ]; } || reject incoming-unavailable

# ── one upload at a time; a stale pending file of this name is OUR OWN staging
#    leftover of a failed publish (never published) and is replaced ──────────
exec 8>"$INCOMING/.receive.lock"
flock -n 8 || reject concurrent-upload
PENDING="$INCOMING/$NAME.pending"
if [ -e "$PENDING" ] || [ -L "$PENDING" ]; then rm -f -- "${PENDING:?}"; fi

# ── privileged, read-only capacity preflight BEFORE reading the stream ───────
# (this user cannot see published/; the publisher answers with a sanitized code)
# shellcheck disable=SC2086
PF="$($PUBLISH_CMD --preflight "$NAME" "$SIZE" "$SHA" 2>/dev/null </dev/null)" || true
PFL="$(printf '%s\n' "$PF" | grep -E '^(PREFLIGHT ok|EXISTS |REJECTED )' | tail -n 1 || true)"
if [[ "$PFL" =~ ^EXISTS\ name=([^ ]+)$ ]] && [ "${BASH_REMATCH[1]}" = "$NAME" ]; then reply "EXISTS name=$NAME"; exit 0; fi
if [[ "$PFL" =~ ^REJECTED\ reason=([a-z0-9-]+)$ ]]; then reject "${BASH_REMATCH[1]}"; fi
[ "$PFL" = "PREFLIGHT ok" ] || reject capacity-unavailable

# ── receive exactly SIZE bytes into a private temporary file ─────────────────
TMP="$(mktemp "$INCOMING/.$NAME.XXXXXXXX.partial")"
head -c $(( SIZE + 1 )) >"$TMP"
ACTUAL="$(stat -c %s "$TMP")"
[ "$ACTUAL" -ge "$SIZE" ] || reject short-read
[ "$ACTUAL" -eq "$SIZE" ] || reject size-mismatch
[ "$(lcp_sha256 "$TMP")" = "$SHA" ] || reject checksum-mismatch
case "$KIND" in
  archive)  lcp_age_header_ok "$TMP" || reject archive-format ;;
  manifest) mc="$(lcp_manifest_check "$TMP" "$SET" "$SLOT")"; [ "$mc" = ok ] || reject "$mc" ;;
esac
ln -- "$TMP" "$PENDING" 2>/dev/null || reject pending-exists
rm -f -- "${TMP:?}"; TMP=""

# ── hand over to the privileged publisher; relay its verdict ─────────────────
# shellcheck disable=SC2086
OUT="$($PUBLISH_CMD "$NAME" "$SIZE" "$SHA" 2>/dev/null </dev/null)" || true
LINE="$(printf '%s\n' "$OUT" | grep -E '^(PUBLISHED|EXISTS|REJECTED) ' | tail -n 1 || true)"
if [[ "$LINE" =~ ^PUBLISHED\ name=([^ ]+)\ size=([0-9]+)\ sha256_prefix=([0-9a-f]{12})$ ]] \
   && [ "${BASH_REMATCH[1]}" = "$NAME" ] && [ "${BASH_REMATCH[2]}" = "$SIZE" ] && [ "${BASH_REMATCH[3]}" = "$(lcp_prefix "$SHA")" ]; then
  reply "PUBLISHED name=$NAME size=$SIZE sha256_prefix=$(lcp_prefix "$SHA")"; exit 0
fi
rm -f -- "${PENDING:?}"
if [[ "$LINE" =~ ^EXISTS\ name=([^ ]+)$ ]] && [ "${BASH_REMATCH[1]}" = "$NAME" ]; then reply "EXISTS name=$NAME"; exit 0; fi
if [[ "$LINE" =~ ^REJECTED\ reason=([a-z0-9-]+)$ ]]; then reject "${BASH_REMATCH[1]}"; fi
reject publish-failed
