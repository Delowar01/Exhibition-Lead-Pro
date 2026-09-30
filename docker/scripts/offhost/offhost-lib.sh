#!/bin/bash
# =============================================================================
# Lead Capture Pro — off-host backup shared library (B23 G-6D, Hostinger-only)
# =============================================================================
# Pure helpers shared by the primary-side sender, the backup-VPS receiver,
# publisher, auditor and retention job, and by the deterministic test harness.
# Sourced only; it runs nothing, opens no network connection and writes nothing.
#
#     source "$(dirname "$0")/offhost-lib.sh"
#
# Everything here is provider-neutral: the off-host destination is a separate
# Hostinger VPS reached over a pinned SSH channel. No cloud storage API, no
# cloud identity federation and no cloud credential is used or referenced.
#
# Conventions
#   set        the local backup file name  leadcapture-YYYYMMDD-HHMMSS.sql.gz
#   archive    <set>.age            the age-encrypted copy of the dump
#   manifest   <set>.manifest.json  sanitized metadata, ALWAYS published last
#   receipt    <name>.receipt       written by the privileged publisher only
#   slot       the daily 03:15 UTC backup slot; slot label YYYYMMDD-HHMM
#   generation published/<slot>/{archive,manifest,receipts} for one set
#
# Never print: dump contents, private keys, credentials, connection strings,
# complete checksums (12-character prefixes only) or unrestricted paths.
# =============================================================================

readonly LCP_PROTOCOL="LCP-OFFHOST/1"
readonly LCP_MANIFEST_SCHEMA="lcp-offhost-manifest/3"
readonly LCP_RECEIPT_SCHEMA="lcp-offhost-receipt/2"
readonly LCP_SLOT_OFFSET=$(( 3 * 3600 + 15 * 60 ))   # 03:15:00 UTC
readonly LCP_DAY=86400
readonly LCP_SET_RE='^leadcapture-([0-9]{8})-([0-9]{6})\.sql\.gz$'
readonly LCP_OBJECT_RE='^(leadcapture-[0-9]{8}-[0-9]{6}\.sql\.gz)\.(age|manifest\.json)$'
readonly LCP_SLOT_LABEL_RE='^[0-9]{8}-[0-9]{4}$'
readonly LCP_SHA256_RE='^[0-9a-f]{64}$'
readonly LCP_SIZE_RE='^[1-9][0-9]{0,11}$'
readonly LCP_PATH_RE='^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+$'   # absolute, plain, >= 2 components
readonly LCP_AGE_HEADER='age-encryption.org/v1'
readonly LCP_ROOT_MARKER='.lcp-offhost-root'
# keys of the ONE shared non-secret backup-VPS configuration file
# (/etc/lcp-offhost/offhost.env) read by receiver, publisher, auditor and retention
readonly LCP_VAULT_CONFIG_KEYS=" OFFHOST_ROOT OFFHOST_PUBLISH_CMD OFFHOST_VAULT_USER OFFHOST_AUDIT_GROUP OFFHOST_RECEIVE_USER OFFHOST_SLOT_WINDOW OFFHOST_MAX_ARCHIVE_BYTES OFFHOST_MAX_MANIFEST_BYTES OFFHOST_STALE_SECONDS OFFHOST_RETAIN_DAYS OFFHOST_PROTECT_NEWEST OFFHOST_QUARANTINE_AFTER_DAYS "

# ── slot arithmetic (UTC epoch integers only; deterministic) ─────────────────
lcp_slot_index() { [[ "$1" =~ ^[0-9]+$ ]] || return 1; echo $(( ($1 - LCP_SLOT_OFFSET) / LCP_DAY )); }
lcp_slot_start() { [[ "$1" =~ ^-?[0-9]+$ ]] || return 1; echo $(( $1 * LCP_DAY + LCP_SLOT_OFFSET )); }
lcp_slot_label() { date -u -d "@$(lcp_slot_start "$1")" +%Y%m%d-%H%M; }
# lcp_stamp_epoch SET → epoch of the filename stamp, validated by a date round-trip
lcp_stamp_epoch() {
  local n="$1" d t e
  [[ "$n" =~ $LCP_SET_RE ]] || return 1
  d="${BASH_REMATCH[1]}"; t="${BASH_REMATCH[2]}"
  e="$(date -u -d "${d:0:4}-${d:4:2}-${d:6:2} ${t:0:2}:${t:2:2}:${t:4:2}" +%s 2>/dev/null)" || return 1
  [ "$(date -u -d "@$e" +%Y%m%d-%H%M%S)" = "$d-$t" ] || return 1
  echo "$e"
}
# lcp_object_kind NAME → 0 and sets LCP_KIND (archive|manifest) and LCP_SET;
# 1 when the name is malformed (prints nothing, so callers keep the variables)
lcp_object_kind() {
  local suffix
  LCP_KIND=""; LCP_SET=""
  [[ "$1" =~ $LCP_OBJECT_RE ]] || return 1
  LCP_SET="${BASH_REMATCH[1]}"; suffix="${BASH_REMATCH[2]}"
  lcp_stamp_epoch "$LCP_SET" >/dev/null || { LCP_SET=""; return 1; }
  case "$suffix" in age) LCP_KIND=archive ;; manifest.json) LCP_KIND=manifest ;; *) LCP_SET=""; return 1 ;; esac
}
lcp_archive_of()  { echo "$1.age"; }
lcp_manifest_of() { echo "$1.manifest.json"; }
lcp_sha256()      { sha256sum "$1" | cut -c1-64; }
lcp_prefix()      { printf '%s' "${1:0:12}"; }
lcp_utc()         { date -u -d "@$1" +%FT%TZ; }

# ── machine identity (used to refuse a same-host "off-host" destination) ─────
# lcp_machine_hash → sha256 of /etc/machine-id (never the id itself); "unknown"
# when unreadable. LCP_MACHINE_ID_FILE overrides the path (test fixtures).
lcp_machine_hash() {
  local f="${LCP_MACHINE_ID_FILE:-/etc/machine-id}" id
  { [ -f "$f" ] && [ -r "$f" ]; } || { echo unknown; return 0; }
  id="$(tr -d '[:space:]' <"$f")"
  [[ "$id" =~ ^[0-9a-f]{32}$ ]] || { echo unknown; return 0; }
  printf '%s' "$id" | sha256sum | cut -c1-64
}
# lcp_hostkey_fingerprint PUBKEY_FILE → SHA256:<base64 without padding>
# (the OpenSSH fingerprint format, computed without ssh-keygen so it works on
# minimal hosts and in the deterministic harness)
lcp_blob_fingerprint() {   # BASE64-BLOB → SHA256:… (1 when the blob is not base64)
  local raw
  [[ "$1" =~ ^[A-Za-z0-9+/]+=*$ ]] || return 1
  raw="$(printf '%s' "$1" | base64 -d 2>/dev/null | openssl dgst -sha256 -binary | base64 -w0)" || return 1
  [ -n "$raw" ] || return 1
  printf 'SHA256:%s\n' "${raw%%=*}"
}
lcp_hostkey_fingerprint() {
  local f="$1" blob
  blob="$(awk 'NF >= 2 && $1 ~ /^(ssh-|ecdsa-|sk-)/ { print $2; exit }' "$f" 2>/dev/null)"
  [ -n "$blob" ] || return 1
  lcp_blob_fingerprint "$blob"
}
# lcp_local_hostkey_fingerprints → comma-separated fingerprints of the host's
# public host keys (LCP_HOSTKEY_DIR overrides /etc/ssh); "unknown" when none.
lcp_local_hostkey_fingerprints() {
  local d="${LCP_HOSTKEY_DIR:-/etc/ssh}" f fp out=""
  for f in "$d"/ssh_host_*_key.pub; do
    [ -f "$f" ] || continue
    fp="$(lcp_hostkey_fingerprint "$f")" || continue
    out="${out:+$out,}$fp"
  done
  echo "${out:-unknown}"
}
# lcp_known_hosts_fingerprints FILE → comma-separated fingerprints of every
# key in a known_hosts file (hashed or plain host names; the names are ignored)
lcp_known_hosts_fingerprints() {
  local f="$1" line fp out=""
  [ -f "$f" ] || { echo unknown; return 0; }
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    fp="$(lcp_blob_fingerprint "$(printf '%s\n' "$line" | awk 'NF >= 3 { sub(/^@[a-z-]+ /, ""); if ($2 ~ /^(ssh-|ecdsa-|sk-)/) print $3 }')" 2>/dev/null)" || continue
    [ -n "$fp" ] || continue
    out="${out:+$out,}$fp"
  done <"$f"
  echo "${out:-unknown}"
}
# lcp_lists_intersect A B → 0 iff the comma-separated lists share an element (never "unknown")
lcp_lists_intersect() {
  local a b x y
  IFS=',' read -r -a a <<<"$1"; IFS=',' read -r -a b <<<"$2"
  for x in "${a[@]}"; do
    [ -n "$x" ] && [ "$x" != unknown ] || continue
    for y in "${b[@]}"; do [ "$x" = "$y" ] && return 0; done
  done
  return 1
}
# lcp_fs_id PATH → hexadecimal file-system id of the path's file system
lcp_fs_id() { stat -f -c %i "$1" 2>/dev/null || echo unknown; }

# ── dump checks (read-only; identical rules to the local G-6 checker) ────────
lcp_dump_header_ok() { zcat "$1" 2>/dev/null | awk 'NR <= 3 && $0 == "-- PostgreSQL database dump" { f = 1 } END { exit(f ? 0 : 1) }'; }
lcp_dump_marker_ok() { zcat "$1" 2>/dev/null | tail -c 4096 | awk '$0 == "-- PostgreSQL database dump complete" { f = 1 } END { exit(f ? 0 : 1) }'; }
# lcp_backup_eligibility DIR SET SLOTIDX → "ok" or a stable reason code
lcp_backup_eligibility() {
  local dir="$1" name="$2" idx="$3" f="$1/$2" sc mt line
  { [ -f "$f" ] && [ ! -L "$f" ]; } || { echo not-regular-file; return; }
  lcp_stamp_epoch "$name" >/dev/null || { echo stamp-invalid; return; }
  mt="$(stat -c %Y "$f")"
  [ "$(lcp_slot_index "$mt")" = "$idx" ] || { echo mtime-outside-stamp-slot; return; }
  [ "$(stat -c %s "$f")" -ge 1024 ] || { echo too-small; return; }
  sc="$f.sha256"
  { [ -f "$sc" ] && [ ! -L "$sc" ]; } || { echo sidecar-missing; return; }
  [ "$(grep -c . "$sc" || true)" = "1" ] || { echo sidecar-format; return; }
  line="$(awk 'NR == 1' "$sc")"
  { [[ "$line" =~ ^[0-9a-f]{64}[[:space:]]+\*?([^[:space:]]+)$ ]] && [ "${BASH_REMATCH[1]}" = "$name" ]; } || { echo sidecar-names-other-file; return; }
  ( cd "$dir" && sha256sum -c --strict --quiet "$name.sha256" >/dev/null 2>&1 ) || { echo checksum-mismatch; return; }
  gzip -t "$f" 2>/dev/null || { echo gzip-invalid; return; }
  lcp_dump_header_ok "$f" || { echo header-missing; return; }
  lcp_dump_marker_ok "$f" || { echo completion-marker-missing; return; }
  echo ok
}

# ── archive / manifest format checks ─────────────────────────────────────────
lcp_age_header_ok() { [ "$(head -c "${#LCP_AGE_HEADER}" "$1" 2>/dev/null)" = "$LCP_AGE_HEADER" ]; }
# lcp_manifest_field FILE KEY → the string/integer value of a top-level key (exit 1 when absent/invalid JSON)
lcp_manifest_field() {
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    with open(sys.argv[1], "rb") as fh:
        doc = json.load(fh)
except Exception:
    sys.exit(2)
if not isinstance(doc, dict) or sys.argv[2] not in doc:
    sys.exit(1)
v = doc[sys.argv[2]]
if isinstance(v, bool) or not isinstance(v, (str, int)):
    sys.exit(1)
print(v)
PY
}
# lcp_manifest_check FILE SET SLOT_LABEL → "ok" or a reason; validates the sanitized schema
lcp_manifest_check() {
  local f="$1" set="$2" slot="$3" v
  [ "$(stat -c %s "$f")" -le 65536 ] || { echo manifest-too-large; return; }
  v="$(lcp_manifest_field "$f" schema)" || { echo manifest-invalid; return; }
  [ "$v" = "$LCP_MANIFEST_SCHEMA" ] || { echo manifest-schema; return; }
  v="$(lcp_manifest_field "$f" set)" || { echo manifest-invalid; return; }
  [ "$v" = "$set" ] || { echo manifest-set-mismatch; return; }
  v="$(lcp_manifest_field "$f" slot)" || { echo manifest-invalid; return; }
  [ "$v" = "$slot" ] || { echo manifest-slot-mismatch; return; }
  v="$(lcp_manifest_field "$f" archive_name)" || { echo manifest-invalid; return; }
  [ "$v" = "$(lcp_archive_of "$set")" ] || { echo manifest-archive-name; return; }
  v="$(lcp_manifest_field "$f" archive_size)" || { echo manifest-invalid; return; }
  [[ "$v" =~ $LCP_SIZE_RE ]] || { echo manifest-archive-size; return; }
  v="$(lcp_manifest_field "$f" archive_sha256)" || { echo manifest-invalid; return; }
  [[ "$v" =~ $LCP_SHA256_RE ]] || { echo manifest-archive-sha256; return; }
  v="$(lcp_manifest_field "$f" source_sha256)" || { echo manifest-invalid; return; }
  [[ "$v" =~ $LCP_SHA256_RE ]] || { echo manifest-source-sha256; return; }
  v="$(lcp_manifest_field "$f" encryption)" || { echo manifest-invalid; return; }
  [ "$v" = "age/$LCP_AGE_HEADER" ] || { echo manifest-encryption; return; }
  echo ok
}
# lcp_receipt_field FILE KEY → value from a receipt (key=value lines)
lcp_receipt_field() { awk -F= -v k="$2" '$1 == k { print substr($0, length(k) + 2); exit }' "$1" 2>/dev/null; }

# ── non-secret configuration files (KEY=value, plain values, whitelisted keys) ─
# lcp_load_config FILE " KEY1 KEY2 " — the environment wins over the file.
lcp_load_config() {
  local f="$1" allowed="$2" line key val
  [ -n "$f" ] || return 0
  [ -e "$f" ] || return 0
  { [ -f "$f" ] && [ ! -L "$f" ]; } || { echo "config $f is not a regular file" >&2; return 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^([A-Z_]+)=([A-Za-z0-9_./:@+=-]*( [A-Za-z0-9_./:@+=-]+)*)$ ]] || { echo "config: unsupported line (only KEY=value with plain characters)" >&2; return 1; }
    key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
    case "$allowed" in *" $key "*) ;; *) echo "config: unknown key $key" >&2; return 1 ;; esac
    if [ -z "${!key:-}" ]; then export "$key=$val"; fi
  done <"$f"
}
# lcp_root_ok ROOT → 0 iff ROOT is a plain absolute path with >= 2 components,
# a real directory (not a symlink), resolves to itself and carries the marker
# file created at activation. Refuses "/" and top-level directories.
lcp_root_ok() {
  local r="$1"
  [[ "$r" =~ $LCP_PATH_RE ]] || return 1
  { [ -d "$r" ] && [ ! -L "$r" ]; } || return 1
  [ "$(realpath -e "$r" 2>/dev/null)" = "$r" ] || return 1
  { [ -f "$r/$LCP_ROOT_MARKER" ] && [ ! -L "$r/$LCP_ROOT_MARKER" ]; } || return 1
}
# lcp_under ROOT PATH → 0 iff PATH (which must exist) resolves inside ROOT
lcp_under() {
  local root="$1" p
  p="$(realpath -e "$2" 2>/dev/null)" || return 1
  case "$p" in "$root"/*) return 0 ;; *) return 1 ;; esac
}

# ── protocol helpers shared by the backup-VPS forced commands ─────────────────
# lcp_hello_line ROOT → the sanitized identity line answered to HELLO
lcp_hello_line() {
  local root_state=missing
  lcp_root_ok "$1" && root_state=ok
  echo "$LCP_PROTOCOL HELLO machine=$(lcp_machine_hash) hostkeys=$(lcp_local_hostkey_fingerprints) fsid=$(lcp_fs_id "$1") root=$root_state"
}
# lcp_receipt_check FILE NAME KIND SET SLOT SIZE → "ok" or a reason (SIZE may be "-" to skip)
lcp_receipt_check() {
  local f="$1" name="$2" kind="$3" set="$4" slot="$5" size="$6" v
  { [ -f "$f" ] && [ ! -L "$f" ]; } || { echo missing; return; }
  [ "$(lcp_receipt_field "$f" schema)" = "$LCP_RECEIPT_SCHEMA" ] || { echo invalid; return; }
  [ "$(lcp_receipt_field "$f" name)" = "$name" ] || { echo invalid; return; }
  [ "$(lcp_receipt_field "$f" kind)" = "$kind" ] || { echo invalid; return; }
  [ "$(lcp_receipt_field "$f" set)" = "$set" ] || { echo invalid; return; }
  [ "$(lcp_receipt_field "$f" slot)" = "$slot" ] || { echo invalid; return; }
  v="$(lcp_receipt_field "$f" size)"; [[ "$v" =~ $LCP_SIZE_RE ]] || { echo invalid; return; }
  [ "$size" = "-" ] || [ "$v" = "$size" ] || { echo invalid; return; }
  v="$(lcp_receipt_field "$f" sha256)"; [[ "$v" =~ $LCP_SHA256_RE ]] || { echo invalid; return; }
  echo ok
}
# lcp_generation_state SLOTDIR SET → one sanitized state line for the generation;
# reads receipts and the manifest only (never the archive), sizes via stat.
lcp_generation_state() {
  local d="$1" set="$2" slot="${1##*/}" arc man arc_state=missing arc_size=0 arc_mtime=none arc_pfx=none
  local arc_rc=missing man_state=missing man_rc=missing man_valid=no complete=no r_size r_sha m_size m_sha
  arc="$d/$(lcp_archive_of "$set")"; man="$d/$(lcp_manifest_of "$set")"
  if [ -f "$arc" ] && [ ! -L "$arc" ]; then
    arc_state=present; arc_size="$(stat -c %s "$arc")"; arc_mtime="$(lcp_utc "$(stat -c %Y "$arc")")"
    arc_rc="$(lcp_receipt_check "$arc.receipt" "${arc##*/}" archive "$set" "$slot" "$arc_size")"
    [ "$arc_rc" = ok ] && arc_pfx="$(lcp_prefix "$(lcp_receipt_field "$arc.receipt" sha256)")"
  fi
  if [ -f "$man" ] && [ ! -L "$man" ]; then
    man_state=present
    man_rc="$(lcp_receipt_check "$man.receipt" "${man##*/}" manifest "$set" "$slot" "$(stat -c %s "$man")")"
    if [ "$(lcp_manifest_check "$man" "$set" "$slot" 2>/dev/null)" = ok ] && [ "$arc_rc" = ok ]; then
      r_size="$(lcp_receipt_field "$arc.receipt" size)"; r_sha="$(lcp_receipt_field "$arc.receipt" sha256)"
      m_size="$(lcp_manifest_field "$man" archive_size)"; m_sha="$(lcp_manifest_field "$man" archive_sha256)"
      [ "$r_size" = "$m_size" ] && [ "$r_sha" = "$m_sha" ] && man_valid=yes
    fi
  fi
  [ "$arc_state" = present ] && [ "$arc_rc" = ok ] && [ "$man_state" = present ] && [ "$man_rc" = ok ] && [ "$man_valid" = yes ] && complete=yes
  echo "archive=$arc_state archive_size=$arc_size archive_mtime_utc=$arc_mtime archive_sha256_prefix=$arc_pfx archive_receipt=$arc_rc manifest=$man_state manifest_receipt=$man_rc manifest_valid=$man_valid complete=$complete"
}
# lcp_slot_sets SLOTDIR → the set names found in a generation directory (archives
# and manifests, validated names only; unknown entries are ignored here and
# counted as orphans by the caller)
lcp_slot_sets() {
  local f n k
  for f in "$1"/leadcapture-*; do
    [ -e "$f" ] || continue
    n="${f##*/}"; n="${n%.receipt}"
    lcp_object_kind "$n" || continue
    echo "$LCP_SET"
  done | LC_ALL=C sort -u
}
