#!/bin/bash
# =============================================================================
# Lead Capture Pro — off-host backup publisher (BACKUP VPS, privileged)
# =============================================================================
# The only privileged step of the receiving side. The receiver (unprivileged
# upload identity) invokes it through a sudoers rule limited to this exact
# path (see sudoers.example); it takes exactly three plain arguments
#
#     offhost-publish.sh <name> <size> <sha256>
#
# and publishes <root>/incoming/<name>.pending into <root>/published/<slot>/
# as a NEW inode that the upload identity never owned or could write:
#
#   1. re-validate name (slot window, no future stamp), size and checksum;
#   2. the pending file must be a regular, single-link, non-symlink file that
#      resolves inside incoming/ and — when a receive user is configured — is
#      owned by it; its size and sha256 are recomputed here, never trusted;
#   3. archive: must carry the age header. manifest: schema-validated, and its
#      archive_size / archive_sha256 must equal the values the publisher itself
#      recorded in the archive's receipt (the manifest can only be published
#      after its archive, so a generation is complete only when both agree);
#   4. copy into a private temporary file in the destination directory, verify
#      the copy's checksum, set owner/mode (archive 0400 vault; manifest 0440
#      vault:audit), then link it to its final name with an EXCLUSIVE create —
#      an existing object is never replaced (reply EXISTS);
#   5. write the receipt (0440 vault:audit) the auditor and the retention job
#      rely on, remove the pending file, reply PUBLISHED.
#
# Exactly one reply line on stdout:
#   PUBLISHED name=<name> size=<n> sha256_prefix=<12> | EXISTS name=<name> | REJECTED reason=<code>
#
# Non-secret configuration (OFFHOST_CONFIG, default /etc/lcp-offhost/offhost.env):
# OFFHOST_ROOT, OFFHOST_VAULT_USER, OFFHOST_AUDIT_GROUP, OFFHOST_RECEIVE_USER,
# OFFHOST_SLOT_WINDOW. Ownership changes are applied only when running as root
# (production: via sudo); the deterministic harness runs it unprivileged.
# Environment-only test hook: OFFHOST_NOW. Never deletes anything under
# published/ except an object it created in this very invocation whose
# receipt could not be written. Never prints paths or full checksums.
# =============================================================================
set -Eeuo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=offhost-lib.sh
source "$HERE/offhost-lib.sh"

reject() { echo "REJECTED reason=$1"; exit 2; }
trap 'echo "REJECTED reason=unexpected-error"; exit 2' ERR
PTMP=""; RTMP=""
cleanup() { [ -n "$PTMP" ] && rm -f -- "${PTMP:?}"; [ -n "$RTMP" ] && rm -f -- "${RTMP:?}"; return 0; }
trap cleanup EXIT

lcp_load_config "${OFFHOST_CONFIG:-/etc/lcp-offhost/offhost.env}" "$LCP_VAULT_CONFIG_KEYS" 2>/dev/null || reject config-invalid
ROOT="${OFFHOST_ROOT:-/srv/lcp-offhost}"
VAULT_USER="${OFFHOST_VAULT_USER:-lcp-vault}"
AUDIT_GROUP="${OFFHOST_AUDIT_GROUP:-lcp-audit}"
RECEIVE_USER="${OFFHOST_RECEIVE_USER:-}"
WINDOW="${OFFHOST_SLOT_WINDOW:-2}"
NOW="${OFFHOST_NOW:-$(date -u +%s)}"
[[ "$ROOT" =~ $LCP_PATH_RE ]] || reject config-invalid
[[ "$VAULT_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && [[ "$AUDIT_GROUP" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || reject config-invalid
[ -z "$RECEIVE_USER" ] || [[ "$RECEIVE_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || reject config-invalid
[[ "$WINDOW" =~ ^[0-9]{1,2}$ ]] && [[ "$NOW" =~ ^[0-9]+$ ]] || reject config-invalid
# ownership is enforced only when privileged (production via sudo); then the
# vault identity and the audit group must exist — fail closed otherwise
PRIV=0; [ "$(id -u)" != 0 ] || PRIV=1
if [ "$PRIV" = 1 ]; then
  id -u -- "$VAULT_USER" >/dev/null 2>&1 && getent group -- "$AUDIT_GROUP" >/dev/null 2>&1 || reject vault-identity-missing
fi

[ "$#" -eq 3 ] || reject invalid-arguments
NAME="$1"; SIZE="$2"; SHA="$3"
lcp_object_kind "$NAME" || reject invalid-name
KIND="$LCP_KIND"; SET="$LCP_SET"
STAMP="$(lcp_stamp_epoch "$SET")"; IDX="$(lcp_slot_index "$STAMP")"; CUR="$(lcp_slot_index "$NOW")"
[ "$STAMP" -le "$NOW" ] && [ "$IDX" -le "$CUR" ] || reject future-stamp
[ "$IDX" -ge $(( CUR - WINDOW )) ] || reject slot-out-of-window
[[ "$SIZE" =~ $LCP_SIZE_RE ]] || reject invalid-size
[[ "$SHA" =~ $LCP_SHA256_RE ]] || reject invalid-checksum
SLOT="$(lcp_slot_label "$IDX")"
lcp_root_ok "$ROOT" || reject root-unavailable
INCOMING="$ROOT/incoming"; PUB="$ROOT/published"
{ [ -d "$INCOMING" ] && [ ! -L "$INCOMING" ] && [ -d "$PUB" ] && [ ! -L "$PUB" ]; } || reject root-layout

# ── the pending file: regular, unlinked elsewhere, inside incoming, right owner ─
PENDING="$INCOMING/$NAME.pending"
{ [ -f "$PENDING" ] && [ ! -L "$PENDING" ]; } || reject pending-not-regular
lcp_under "$INCOMING" "$PENDING" || reject pending-outside-incoming
[ "$(stat -c %h "$PENDING")" = 1 ] || reject pending-linked
if [ -n "$RECEIVE_USER" ] && [ "$PRIV" = 1 ]; then [ "$(stat -c %U "$PENDING")" = "$RECEIVE_USER" ] || reject pending-owner; fi
[ "$(stat -c %s "$PENDING")" = "$SIZE" ] || reject pending-size
[ "$(lcp_sha256 "$PENDING")" = "$SHA" ] || reject checksum-mismatch
DEST="$PUB/$SLOT"
case "$KIND" in
  archive) lcp_age_header_ok "$PENDING" || reject archive-format ;;
  manifest)
    mc="$(lcp_manifest_check "$PENDING" "$SET" "$SLOT")"; [ "$mc" = ok ] || reject "$mc"
    ARC="$DEST/$(lcp_archive_of "$SET")"
    { [ -f "$ARC" ] && [ ! -L "$ARC" ]; } || reject archive-not-published
    [ "$(lcp_receipt_check "$ARC.receipt" "${ARC##*/}" archive "$SET" "$SLOT" "$(stat -c %s "$ARC")")" = ok ] || reject archive-receipt-invalid
    [ "$(lcp_receipt_field "$ARC.receipt" size)" = "$(lcp_manifest_field "$PENDING" archive_size)" ] \
      && [ "$(lcp_receipt_field "$ARC.receipt" sha256)" = "$(lcp_manifest_field "$PENDING" archive_sha256)" ] || reject manifest-archive-mismatch ;;
esac

# ── destination directory (vault-owned, audit may traverse and list) ─────────
if [ ! -d "$DEST" ]; then mkdir -m 0750 -- "$DEST"; fi
[ ! -L "$DEST" ] || reject destination-symlink
if [ "$PRIV" = 1 ]; then chown -- "$VAULT_USER:$AUDIT_GROUP" "$DEST"; chmod 0750 -- "$DEST"; fi
FINAL="$DEST/$NAME"
if [ -e "$FINAL" ] || [ -L "$FINAL" ]; then rm -f -- "${PENDING:?}"; echo "EXISTS name=$NAME"; exit 0; fi

# ── copy into a private new inode, verify, then EXCLUSIVE link to the final name ─
PTMP="$(mktemp "$DEST/.$NAME.XXXXXXXX.publish")"
cat -- "$PENDING" >"$PTMP"
[ "$(lcp_sha256 "$PTMP")" = "$SHA" ] || reject copy-verify-failed
case "$KIND" in
  archive)  chmod 0400 -- "$PTMP"; [ "$PRIV" = 0 ] || chown -- "$VAULT_USER:$AUDIT_GROUP" "$PTMP" ;;
  manifest) chmod 0440 -- "$PTMP"; [ "$PRIV" = 0 ] || chown -- "$VAULT_USER:$AUDIT_GROUP" "$PTMP" ;;
esac
if ! ln -- "$PTMP" "$FINAL" 2>/dev/null; then rm -f -- "${PENDING:?}"; echo "EXISTS name=$NAME"; exit 0; fi
rm -f -- "${PTMP:?}"; PTMP=""

# ── receipt: the auditor's and the retention job's source of truth ───────────
RTMP="$(mktemp "$DEST/.$NAME.XXXXXXXX.receipt")"
{
  echo "schema=$LCP_RECEIPT_SCHEMA"; echo "name=$NAME"; echo "kind=$KIND"; echo "set=$SET"; echo "slot=$SLOT"
  echo "size=$SIZE"; echo "sha256=$SHA"; echo "published_utc=$(lcp_utc "$NOW")"; echo "publisher=lcp-offhost-publish/1"
} >"$RTMP"
chmod 0440 -- "$RTMP"; [ "$PRIV" = 0 ] || chown -- "$VAULT_USER:$AUDIT_GROUP" "$RTMP"
if ! ln -- "$RTMP" "$FINAL.receipt" 2>/dev/null; then
  # a receipt for an object that did not exist a moment ago: roll back the
  # object created in THIS invocation and fail closed (nothing else is touched)
  rm -f -- "${FINAL:?}"; reject receipt-exists
fi
rm -f -- "${RTMP:?}"; RTMP=""
rm -f -- "${PENDING:?}"
echo "PUBLISHED name=$NAME size=$SIZE sha256_prefix=$(lcp_prefix "$SHA")"
exit 0
