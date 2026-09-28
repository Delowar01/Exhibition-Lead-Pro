#!/bin/bash
# =============================================================================
# Lead Capture Pro — off-host copy of the daily PostgreSQL backup (B23 G-6D)
# =============================================================================
# Copies the CANONICAL local backup of each UTC slot (03:15:00 → next day
# 03:14:59) to a dedicated Google Cloud Storage bucket (region me-central2) as
# an atomic three-object set under <prefix>/daily/:
#
#   <set>                    the dump, byte-identical to the local file
#   <set>.sha256             the local checksum sidecar, byte-identical
#   <set>.manifest.json      the manifest (schema lcp-offhost-manifest/2),
#                            ALWAYS created last — a dump alone, or a dump plus
#                            sidecar without manifest, is not a completed backup
#
# Transport: the Cloud Storage JSON API called directly with curl — resumable
# upload for the dump, single-request multipart uploads for sidecar and
# manifest, and ifGenerationMatch=0 on EVERY create. Nothing is ever read,
# listed, overwritten or deleted remotely. Credentials are short-lived only:
# an external subject token (file or URL) is exchanged at the STS endpoint
# (Workload Identity Federation); no service-account key is ever read,
# embedded or written, and no token is ever logged.
#
# Local operational state (receipts, lock, log, cron snapshots) lives in
# $OFFHOST_RECEIPT_DIR — NEVER in the PostgreSQL backup directory, which this
# script only reads. Receipts are not the source of truth: the independent
# GitHub auditor validates the remote sets from provider list metadata.
#
# Usage (deploy user):
#   OFFHOST_CONFIG=/opt/lead-capture-pro/env/offhost.env bash docker/scripts/backup-offhost.sh      # upload run
#   OFFHOST_CONFIG=… bash docker/scripts/backup-offhost.sh plan   # read-only slot plan: no network, no writes
#
# Exit codes: 0 every processed set uploaded; 3 at least one set ambiguous
# (pending-audit / exists-unverified) and no hard failure; 1 hard failure or
# current-slot backup missing; 75 another run holds the lock.
#
# Output names only files, keys, sizes, counts, generations, hash prefixes and
# status codes — never tokens, key material, hostnames or dump contents.
# Design of record: docs/BACKUP_AND_RECOVERY.md §5.
# =============================================================================
set -Eeuo pipefail
umask 077

readonly SCRIPT_ID="lcp-offhost-uploader/1"
readonly MANIFEST_SCHEMA="lcp-offhost-manifest/2"
readonly RECEIPT_SCHEMA="lcp-offhost-receipt/1"
readonly OBJECT_SCHEMA="lcp-offhost-object/1"
readonly SLOT_OFFSET=$(( 3 * 3600 + 15 * 60 ))   # 03:15:00 UTC
readonly DAY=86400
readonly NAME_RE='^leadcapture-([0-9]{8})-([0-9]{6})\.sql\.gz$'
readonly STS_GRANT='urn:ietf:params:oauth:grant-type:token-exchange'
readonly STS_REQUESTED='urn:ietf:params:oauth:token-type:access_token'

MODE="${1:-run}"
case "$MODE" in run|plan) ;; *) echo "usage: backup-offhost.sh [run|plan]" >&2; exit 2 ;; esac

log()  { echo "[offhost] $(date -u +%FT%TZ) $*"; }
warn() { echo "[offhost] $(date -u +%FT%TZ) WARN: $*" >&2; }
die()  { echo "[offhost] $(date -u +%FT%TZ) ERROR: $*" >&2; exit 1; }

# ── configuration (environment wins over the config file; plain values only) ─
readonly CONFIG_KEYS=" OFFHOST_BUCKET OFFHOST_PREFIX OFFHOST_ENV_LABEL OFFHOST_REGION OFFHOST_BACKFILL_SLOTS OFFHOST_STORAGE_ENDPOINT OFFHOST_STS_ENDPOINT OFFHOST_WIF_AUDIENCE OFFHOST_SCOPE OFFHOST_SUBJECT_TOKEN_FILE OFFHOST_SUBJECT_TOKEN_URL OFFHOST_SUBJECT_TOKEN_TYPE OFFHOST_IMPERSONATE_SA OFFHOST_IAMCREDENTIALS_ENDPOINT OFFHOST_RECEIPT_DIR BACKUP_DIR OFFHOST_RETRY_MAX OFFHOST_RETRY_BASE_SECONDS OFFHOST_CONNECT_TIMEOUT OFFHOST_MAX_TIME OFFHOST_RECEIPT_KEEP_DAYS "
load_config() {
  local f="${OFFHOST_CONFIG:-}" line key val mode
  [ -n "$f" ] || return 0
  { [ -f "$f" ] && [ ! -L "$f" ]; } || die "OFFHOST_CONFIG $f is not a regular file"
  mode="$(stat -c %a "$f")"
  [ "$mode" = "600" ] || [ "$mode" = "400" ] || die "OFFHOST_CONFIG must be mode 600 or 400 (is $mode)"
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^([A-Z_]+)=([A-Za-z0-9_./:@+=-]*)$ ]] || die "OFFHOST_CONFIG: unsupported line (only KEY=value with plain characters)"
    key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
    case "$CONFIG_KEYS" in *" $key "*) ;; *) die "OFFHOST_CONFIG: unknown key $key" ;; esac
    if [ -z "${!key:-}" ]; then export "$key=$val"; fi
  done <"$f"
}
load_config

BACKUP_DIR="${BACKUP_DIR:-/opt/lead-capture-pro/backups/postgres}"
RECEIPT_DIR="${OFFHOST_RECEIPT_DIR:-/opt/lead-capture-pro/backups/offhost-receipts}"
PREFIX="${OFFHOST_PREFIX:-dev/postgres}"
ENV_LABEL="${OFFHOST_ENV_LABEL:-hosted-dev}"
REGION="${OFFHOST_REGION:-me-central2}"
BACKFILL="${OFFHOST_BACKFILL_SLOTS:-7}"
STORAGE_EP="${OFFHOST_STORAGE_ENDPOINT:-https://storage.googleapis.com}"
STS_EP="${OFFHOST_STS_ENDPOINT:-https://sts.googleapis.com/v1/token}"
IAMCRED_EP="${OFFHOST_IAMCREDENTIALS_ENDPOINT:-https://iamcredentials.googleapis.com}"
SCOPE="${OFFHOST_SCOPE:-https://www.googleapis.com/auth/devstorage.read_write}"
SUBJ_FILE="${OFFHOST_SUBJECT_TOKEN_FILE:-}"
SUBJ_URL="${OFFHOST_SUBJECT_TOKEN_URL:-}"
SUBJ_TYPE="${OFFHOST_SUBJECT_TOKEN_TYPE:-urn:ietf:params:oauth:token-type:jwt}"
IMPERSONATE="${OFFHOST_IMPERSONATE_SA:-}"
RETRY_MAX="${OFFHOST_RETRY_MAX:-3}"
RETRY_BASE="${OFFHOST_RETRY_BASE_SECONDS:-2}"
CONNECT_TIMEOUT="${OFFHOST_CONNECT_TIMEOUT:-20}"
MAX_TIME="${OFFHOST_MAX_TIME:-600}"
KEEP_DAYS="${OFFHOST_RECEIPT_KEEP_DAYS:-60}"
NOW="${OFFHOST_NOW:-$(date -u +%s)}"
BUCKET="${OFFHOST_BUCKET:-}"
AUDIENCE="${OFFHOST_WIF_AUDIENCE:-}"

[[ "$BACKFILL" =~ ^[0-9]+$ ]] && [ "$BACKFILL" -le 60 ] || die "OFFHOST_BACKFILL_SLOTS must be 0..60"
[[ "$RETRY_MAX" =~ ^[0-9]+$ ]] || die "OFFHOST_RETRY_MAX must be an integer"
[[ "$RETRY_BASE" =~ ^[0-9]+$ ]] || die "OFFHOST_RETRY_BASE_SECONDS must be an integer"
[[ "$CONNECT_TIMEOUT" =~ ^[0-9]+$ ]] && [[ "$MAX_TIME" =~ ^[0-9]+$ ]] || die "timeouts must be integers"
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] && [ "$KEEP_DAYS" -ge 1 ] || die "OFFHOST_RECEIPT_KEEP_DAYS must be >= 1"
[[ "$NOW" =~ ^[0-9]+$ ]] || die "OFFHOST_NOW must be epoch seconds"
[[ "$PREFIX" =~ ^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$ ]] || die "OFFHOST_PREFIX has an unexpected format"
[[ "$ENV_LABEL" =~ ^[a-z0-9-]{1,32}$ ]] || die "OFFHOST_ENV_LABEL has an unexpected format"
[ "$REGION" = "me-central2" ] || die "OFFHOST_REGION must be me-central2 (accepted configuration)"
{ [ -d "$BACKUP_DIR" ] && [ ! -L "$BACKUP_DIR" ]; } || die "backup directory $BACKUP_DIR is absent"
case "$RECEIPT_DIR" in "$BACKUP_DIR"|"$BACKUP_DIR"/*) die "OFFHOST_RECEIPT_DIR must not be the backup directory or inside it" ;; esac
case "$BACKUP_DIR" in "$RECEIPT_DIR"|"$RECEIPT_DIR"/*) die "the backup directory must not be inside OFFHOST_RECEIPT_DIR" ;; esac
if [ "$MODE" = run ]; then
  [[ "$BUCKET" =~ ^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$ ]] || die "OFFHOST_BUCKET is missing or has an unexpected format"
  [[ "$AUDIENCE" =~ ^//iam\.googleapis\.com/projects/[0-9]+/locations/global/workloadIdentityPools/[A-Za-z0-9_-]+/providers/[A-Za-z0-9_-]+$ ]] || die "OFFHOST_WIF_AUDIENCE is missing or has an unexpected format"
  [[ "$STORAGE_EP" =~ ^https?://[A-Za-z0-9.:-]+$ ]] || die "OFFHOST_STORAGE_ENDPOINT has an unexpected format"
  [[ "$STS_EP" =~ ^https?://[A-Za-z0-9.:/-]+$ ]] || die "OFFHOST_STS_ENDPOINT has an unexpected format"
  [[ "$IAMCRED_EP" =~ ^https?://[A-Za-z0-9.:-]+$ ]] || die "OFFHOST_IAMCREDENTIALS_ENDPOINT has an unexpected format"
  [[ "$SCOPE" =~ ^https://www\.googleapis\.com/auth/[a-z_.-]+$ ]] || die "OFFHOST_SCOPE has an unexpected format"
  [ -z "$IMPERSONATE" ] || [[ "$IMPERSONATE" =~ ^[a-z][a-z0-9-]{4,29}@[a-z0-9-]+\.iam\.gserviceaccount\.com$ ]] || die "OFFHOST_IMPERSONATE_SA has an unexpected format"
  if [ -n "$SUBJ_FILE" ] && [ -n "$SUBJ_URL" ]; then die "set only one of OFFHOST_SUBJECT_TOKEN_FILE / OFFHOST_SUBJECT_TOKEN_URL"; fi
  [ -n "$SUBJ_FILE" ] || [ -n "$SUBJ_URL" ] || die "OFFHOST_SUBJECT_TOKEN_FILE or OFFHOST_SUBJECT_TOKEN_URL is required"
  for t in curl python3 openssl base64 gzip sha256sum flock; do command -v "$t" >/dev/null 2>&1 || die "required tool missing: $t"; done
fi

# ── slot arithmetic ──────────────────────────────────────────────────────────
slot_index() { echo $(( ($1 - SLOT_OFFSET) / DAY )); }
slot_start() { echo $(( $1 * DAY + SLOT_OFFSET )); }
slot_label() { date -u -d "@$(slot_start "$1")" +%Y%m%d-%H%M; }
# stamp_epoch NAME → epoch of the filename stamp, validated by a date round-trip
stamp_epoch() {
  local n="$1" d t e
  [[ "$n" =~ $NAME_RE ]] || return 1
  d="${BASH_REMATCH[1]}"; t="${BASH_REMATCH[2]}"
  e="$(date -u -d "${d:0:4}-${d:4:2}-${d:6:2} ${t:0:2}:${t:2:2}:${t:4:2}" +%s 2>/dev/null)" || return 1
  [ "$(date -u -d "@$e" +%Y%m%d-%H%M%S)" = "$d-$t" ] || return 1
  echo "$e"
}

# ── eligibility of a local backup for its slot (read-only checks) ────────────
dump_header_ok() { zcat "$1" 2>/dev/null | awk 'NR <= 3 && $0 == "-- PostgreSQL database dump" { f = 1 } END { exit(f ? 0 : 1) }'; }
dump_marker_ok() { zcat "$1" 2>/dev/null | tail -c 4096 | awk '$0 == "-- PostgreSQL database dump complete" { f = 1 } END { exit(f ? 0 : 1) }'; }
# eligibility NAME SLOTIDX → "ok" or a reason code
eligibility() {
  local name="$1" idx="$2" f="$BACKUP_DIR/$1" sc mt line
  { [ -f "$f" ] && [ ! -L "$f" ]; } || { echo not-regular-file; return; }
  stamp_epoch "$name" >/dev/null || { echo stamp-invalid; return; }
  mt="$(stat -c %Y "$f")"
  [ "$(slot_index "$mt")" = "$idx" ] || { echo mtime-outside-stamp-slot; return; }
  sc="$f.sha256"
  { [ -f "$sc" ] && [ ! -L "$sc" ]; } || { echo sidecar-missing; return; }
  [ "$(grep -c . "$sc" || true)" = "1" ] || { echo sidecar-format; return; }
  line="$(awk 'NR == 1' "$sc")"
  { [[ "$line" =~ ^[0-9a-f]{64}[[:space:]]+\*?([^[:space:]]+)$ ]] && [ "${BASH_REMATCH[1]}" = "$name" ]; } || { echo sidecar-names-other-file; return; }
  ( cd "$BACKUP_DIR" && sha256sum -c --strict --quiet "$name.sha256" >/dev/null 2>&1 ) || { echo checksum-mismatch; return; }
  gzip -t "$f" 2>/dev/null || { echo gzip-invalid; return; }
  dump_header_ok "$f" || { echo header-missing; return; }
  dump_marker_ok "$f" || { echo completion-marker-missing; return; }
  echo ok
}

WORK="$(mktemp -d "${TMPDIR:-/tmp}/offhost.XXXXXXXX")"
chmod 700 "$WORK"
cleanup_work() { rm -rf "$WORK"; }
trap cleanup_work EXIT

# scan_backups → $WORK/scan.tsv: slotidx<TAB>stamp<TAB>name<TAB>status
scan_backups() {
  local f name e idx st
  : >"$WORK/scan.tsv"
  for f in "$BACKUP_DIR"/leadcapture-*.sql.gz; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    if ! e="$(stamp_epoch "$name")"; then printf 'x\t0\t%s\tstamp-invalid\n' "$name" >>"$WORK/scan.tsv"; continue; fi
    idx="$(slot_index "$e")"
    st="$(eligibility "$name" "$idx")"
    printf '%s\t%s\t%s\t%s\n' "$idx" "$e" "$name" "$st" >>"$WORK/scan.tsv"
  done
}
# canonical_for SLOTIDX → name of the eligible backup with the earliest stamp (tie: filename, LC_ALL=C)
canonical_for() {
  awk -F'\t' -v i="$1" '$1 == i && $4 == "ok" { print $2 "\t" $3 }' "$WORK/scan.tsv" \
    | LC_ALL=C sort -t "$(printf '\t')" -k1,1n -k2,2 | awk -F'\t' 'NR == 1 { print $2 }'
}
count_rows() { awk -F'\t' -v i="$1" -v c="$2" -v want="$3" '$1 == i && (want == "ok" ? ($4 == "ok" && $3 != c) : ($4 != "ok"))' "$WORK/scan.tsv" | wc -l; }

CUR_IDX="$(slot_index "$NOW")"
FIRST_IDX=$(( CUR_IDX - BACKFILL ))

# ── plan mode: read-only, no network, no writes ──────────────────────────────
if [ "$MODE" = plan ]; then
  scan_backups
  echo "plan: now_utc=$(date -u -d "@$NOW" +%FT%TZ) current_slot=$(slot_label "$CUR_IDX") backfill_slots=$BACKFILL prefix=$PREFIX region=$REGION"
  for (( idx = FIRST_IDX; idx <= CUR_IDX; idx++ )); do
    canon="$(canonical_for "$idx")"
    echo "slot=$(slot_label "$idx") canonical=${canon:-none} noncanonical=$(count_rows "$idx" "$canon" ok) ineligible=$(count_rows "$idx" "$canon" bad)"
  done
  awk -F'\t' '$4 != "ok" { print "ineligible: file=" $3 " reason=" $4 }' "$WORK/scan.tsv"
  exit 0
fi

# ── receipts (operational state only; atomic writes; own directory only) ─────
if [ ! -d "$RECEIPT_DIR" ]; then mkdir -p "$RECEIPT_DIR"; fi
[ ! -L "$RECEIPT_DIR" ] || die "receipt directory must not be a symlink"
chmod 700 "$RECEIPT_DIR"
[ "$(stat -c %u "$RECEIPT_DIR")" = "$(id -u)" ] || die "receipt directory is not owned by the running user"

exec 9>"$RECEIPT_DIR/.offhost.lock"
if ! flock -n 9; then
  echo "[offhost] $(date -u +%FT%TZ) ERROR: another off-host run holds the lock — exiting without touching anything" >&2
  exit 75
fi

declare -A R
receipt_load() {   # ID → R[...] ; returns 1 when no receipt exists
  local f="$RECEIPT_DIR/$1.receipt" k v
  R=(); R[status]=absent; R[dump]=none; R[sidecar]=none; R[manifest]=none; R[attempts]=0; R[observation]=; R[last_reason]=
  [ -f "$f" ] || return 1
  while IFS='=' read -r k v || [ -n "$k" ]; do
    [[ "$k" =~ ^[a-z_]+$ ]] || continue
    R[$k]="$v"
  done <"$f"
  return 0
}
receipt_save() {   # ID (writes R atomically: temporary file + rename, mode 600)
  local f="$RECEIPT_DIR/$1.receipt" tmp k
  tmp="$(mktemp "$RECEIPT_DIR/.$1.XXXXXX.tmp")"
  {
    echo "schema=$RECEIPT_SCHEMA"
    for k in $(printf '%s\n' "${!R[@]}" | LC_ALL=C sort); do echo "$k=${R[$k]}"; done
  } >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$f"
}

# ── HTTP helpers (curl; the bearer token only ever lives in a 600 header file) ─
AUTH_HDR="$WORK/auth.hdr"; TOKEN_READY=0; TOKEN_FAIL_REASON=
HTTP_CODE=000; CURL_RC=0
http() {   # METHOD URL [curl args…] — authenticated; body → $WORK/resp.body, headers → $WORK/resp.hdr
  local m="$1" u="$2"; shift 2
  HTTP_CODE=000; CURL_RC=0
  : >"$WORK/resp.body"; : >"$WORK/resp.hdr"
  HTTP_CODE="$(curl -sS -X "$m" "$u" -H "@$AUTH_HDR" -D "$WORK/resp.hdr" -o "$WORK/resp.body" -w '%{http_code}' \
    --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" "$@" 2>"$WORK/curl.err")" || CURL_RC=$?
  [[ "$HTTP_CODE" =~ ^[0-9]{3}$ ]] || HTTP_CODE=000
}
http_noauth() {   # METHOD URL [curl args…]
  local m="$1" u="$2"; shift 2
  HTTP_CODE=000; CURL_RC=0
  : >"$WORK/resp.body"; : >"$WORK/resp.hdr"
  HTTP_CODE="$(curl -sS -X "$m" "$u" -D "$WORK/resp.hdr" -o "$WORK/resp.body" -w '%{http_code}' \
    --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" "$@" 2>"$WORK/curl.err")" || CURL_RC=$?
  [[ "$HTTP_CODE" =~ ^[0-9]{3}$ ]] || HTTP_CODE=000
}
# classify → ok | exists | incomplete | transient | permanent | conn | ambiguous
classify() {
  local code="$1" rc="$2"
  if [ "$rc" -ne 0 ]; then
    case "$rc" in 6|7|35) echo conn ;; *) echo ambiguous ;; esac
    return
  fi
  case "$code" in
    200|201) echo ok ;; 412) echo exists ;; 308) echo incomplete ;;
    429|500|502|503|504) echo transient ;; *) echo permanent ;;
  esac
}
backoff() { local n="$1"; [ "$RETRY_BASE" -gt 0 ] || return 0; sleep $(( RETRY_BASE * (1 << (n - 1)) )); }
jget() {   # FILE PATH → value (scalars printed raw, null → "null"); exit 1 when absent
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    cur = json.load(open(sys.argv[1], "rb"))
except Exception:
    sys.exit(2)
for p in sys.argv[2].split("."):
    if p == "":
        continue
    if isinstance(cur, dict) and p in cur:
        cur = cur[p]
    else:
        sys.exit(1)
if isinstance(cur, (dict, list)):
    print(json.dumps(cur, separators=(",", ":"), sort_keys=True))
elif cur is None:
    print("null")
elif cur is True:
    print("true")
elif cur is False:
    print("false")
else:
    print(cur)
PY
}
header_value() { awk -v h="$1" 'BEGIN { IGNORECASE = 1 } tolower($1) == tolower(h) ":" { sub(/\r$/, ""); print $2 }' "$WORK/resp.hdr" | awk 'NR == 1'; }
urlenc_key() { printf '%s' "$1" | sed 's#/#%2F#g'; }
md5_b64() { openssl dgst -md5 -binary "$1" | base64 -w0; }
sha256_hex() { sha256sum "$1" | cut -c1-64; }

acquire_token() {
  [ "$TOKEN_READY" = 1 ] && return 0
  local subj mode attempt=0 cls tok
  if [ -n "$SUBJ_FILE" ]; then
    { [ -f "$SUBJ_FILE" ] && [ ! -L "$SUBJ_FILE" ]; } || { TOKEN_FAIL_REASON=subject-token-missing; return 1; }
    mode="$(stat -c %a "$SUBJ_FILE")"
    [ "$mode" = "600" ] || [ "$mode" = "400" ] || { TOKEN_FAIL_REASON=subject-token-mode; return 1; }
    subj="$(tr -d '\r\n' <"$SUBJ_FILE")"
  else
    subj="$(curl -sS --fail --connect-timeout "$CONNECT_TIMEOUT" --max-time 30 "$SUBJ_URL" 2>/dev/null | tr -d '\r\n')" || { TOKEN_FAIL_REASON=subject-token-fetch-failed; return 1; }
  fi
  [[ "$subj" =~ ^[A-Za-z0-9._-]{20,}$ ]] || { TOKEN_FAIL_REASON=subject-token-format; return 1; }
  printf '{"grantType":"%s","audience":"%s","scope":"%s","requestedTokenType":"%s","subjectToken":"%s","subjectTokenType":"%s"}' \
    "$STS_GRANT" "$AUDIENCE" "$SCOPE" "$STS_REQUESTED" "$subj" "$SUBJ_TYPE" >"$WORK/sts.req"
  subj=
  while :; do
    http_noauth POST "$STS_EP" -H 'Content-Type: application/json; charset=UTF-8' --data-binary "@$WORK/sts.req"
    cls="$(classify "$HTTP_CODE" "$CURL_RC")"
    case "$cls" in
      ok) break ;;
      transient|conn|ambiguous)
        attempt=$((attempt + 1))
        if [ "$attempt" -gt "$RETRY_MAX" ]; then rm -f "$WORK/sts.req"; TOKEN_FAIL_REASON="token-failed:sts-unavailable"; return 1; fi
        backoff "$attempt"; continue ;;
      *) rm -f "$WORK/sts.req"; TOKEN_FAIL_REASON="token-failed:sts-http-$HTTP_CODE"; return 1 ;;
    esac
  done
  rm -f "$WORK/sts.req"
  tok="$(jget "$WORK/resp.body" access_token)" || { TOKEN_FAIL_REASON=token-failed:sts-response; return 1; }
  : >"$WORK/resp.body"
  [[ "$tok" =~ ^[A-Za-z0-9._-]{20,}$ ]] || { TOKEN_FAIL_REASON=token-failed:sts-token-format; return 1; }
  if [ -n "$IMPERSONATE" ]; then
    printf 'Authorization: Bearer %s\n' "$tok" >"$AUTH_HDR"; chmod 600 "$AUTH_HDR"; tok=
    printf '{"scope":["%s"],"lifetime":"600s"}' "$SCOPE" >"$WORK/imp.req"
    attempt=0
    while :; do
      http POST "$IAMCRED_EP/v1/projects/-/serviceAccounts/$IMPERSONATE:generateAccessToken" -H 'Content-Type: application/json; charset=UTF-8' --data-binary "@$WORK/imp.req"
      cls="$(classify "$HTTP_CODE" "$CURL_RC")"
      case "$cls" in
        ok) break ;;
        transient|conn|ambiguous)
          attempt=$((attempt + 1))
          if [ "$attempt" -gt "$RETRY_MAX" ]; then TOKEN_FAIL_REASON="token-failed:impersonation-unavailable"; return 1; fi
          backoff "$attempt"; continue ;;
        *) TOKEN_FAIL_REASON="token-failed:impersonation-http-$HTTP_CODE"; return 1 ;;
      esac
    done
    tok="$(jget "$WORK/resp.body" accessToken)" || { TOKEN_FAIL_REASON=token-failed:impersonation-response; return 1; }
    : >"$WORK/resp.body"
    [[ "$tok" =~ ^[A-Za-z0-9._-]{20,}$ ]] || { TOKEN_FAIL_REASON=token-failed:impersonation-token-format; return 1; }
  fi
  printf 'Authorization: Bearer %s\n' "$tok" >"$AUTH_HDR"; chmod 600 "$AUTH_HDR"; tok=
  TOKEN_READY=1
  log "credential: short-lived access token acquired (sts exchange${IMPERSONATE:+ + impersonation}); never logged"
}

# ── object creation (never overwrite: ifGenerationMatch=0 on every create) ───
OBJ_STATE=; OBJ_REASON=; OBJ_GEN=; OBJ_SIZE=; OBJ_MD5=; OBJ_CRC=
# validate_resource KEY EXP_SIZE EXP_MD5 EXP_SHA — the create response must describe exactly what was sent
validate_resource() {
  local key="$1" size="$2" md5="$3" sha="$4" v
  v="$(jget "$WORK/resp.body" name)" || return 1;      [ "$v" = "$key" ] || return 1
  v="$(jget "$WORK/resp.body" size)" || return 1;      [ "$v" = "$size" ] || return 1
  v="$(jget "$WORK/resp.body" md5Hash)" || return 1;   [ "$v" = "$md5" ] || return 1
  OBJ_GEN="$(jget "$WORK/resp.body" generation)" || return 1
  [[ "$OBJ_GEN" =~ ^[0-9]+$ ]] || return 1
  if [ -n "$sha" ]; then v="$(jget "$WORK/resp.body" metadata.sha256)" || return 1; [ "$v" = "$sha" ] || return 1; fi
  OBJ_CRC="$(jget "$WORK/resp.body" crc32c 2>/dev/null || echo "")"
  OBJ_SIZE="$size"; OBJ_MD5="$md5"
  return 0
}
insert_metadata_json() {   # KEY CONTENT_TYPE MD5 SHA SLOT SET KIND [EXTRA_JSON_MEMBERS]
  printf '{"name":"%s","contentType":"%s","md5Hash":"%s","metadata":{"schema":"%s","sha256":"%s","slot":"%s","set":"%s","kind":"%s","env":"%s"%s}}' \
    "$1" "$2" "$3" "$OBJECT_SCHEMA" "$4" "$5" "$6" "$7" "$ENV_LABEL" "${8:-}"
}
# create_multipart KEY FILE CONTENT_TYPE METAFILE EXP_SHA → OBJ_STATE created|exists|unknown|failed (+OBJ_REASON)
create_multipart() {
  local key="$1" file="$2" ctype="$3" meta="$4" sha="$5" size md5 bnd body attempt=0 ambiguous_retry=0 cls
  size="$(stat -c %s "$file")"; md5="$(md5_b64 "$file")"
  bnd="lcp$(openssl rand -hex 12)"
  body="$WORK/multipart.body"
  {
    printf -- '--%s\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' "$bnd"
    cat "$meta"
    printf -- '\r\n--%s\r\nContent-Type: %s\r\n\r\n' "$bnd" "$ctype"
    cat "$file"
    printf -- '\r\n--%s--\r\n' "$bnd"
  } >"$body"
  OBJ_STATE=; OBJ_REASON=; OBJ_GEN=; OBJ_CRC=
  while :; do
    http POST "$STORAGE_EP/upload/storage/v1/b/$BUCKET/o?uploadType=multipart&ifGenerationMatch=0" \
      -H "Content-Type: multipart/related; boundary=$bnd" --data-binary "@$body"
    cls="$(classify "$HTTP_CODE" "$CURL_RC")"
    case "$cls" in
      ok)
        if validate_resource "$key" "$size" "$md5" "$sha"; then OBJ_STATE=created; else OBJ_STATE=exists; OBJ_REASON=resource-validation-failed; fi
        break ;;
      exists) OBJ_STATE=exists; OBJ_REASON=http-412; break ;;
      transient|conn)
        attempt=$((attempt + 1))
        if [ "$attempt" -gt "$RETRY_MAX" ]; then
          OBJ_STATE=failed
          if [ "$HTTP_CODE" = 429 ]; then OBJ_REASON=rate-limited; elif [ "$cls" = conn ]; then OBJ_REASON=connection-failed; else OBJ_REASON="provider-5xx"; fi
          break
        fi
        backoff "$attempt"; continue ;;
      ambiguous)
        # The request may or may not have reached the provider: one immediate re-attempt
        # settles it (201 → created and observed, 412 → exists but unobserved).
        if [ "$ambiguous_retry" = 0 ]; then ambiguous_retry=1; continue; fi
        OBJ_STATE=unknown; OBJ_REASON=response-lost; break ;;
      *) OBJ_STATE=failed; OBJ_REASON="permanent-4xx code=$HTTP_CODE"; break ;;
    esac
  done
  rm -f "$body"
}
# create_resumable KEY FILE CONTENT_TYPE METAFILE EXP_SHA → OBJ_STATE (resumable session URI stays in memory only)
create_resumable() {
  local key="$1" file="$2" ctype="$3" meta="$4" sha="$5" size md5 session attempt=0 cls range off
  size="$(stat -c %s "$file")"; md5="$(md5_b64 "$file")"
  OBJ_STATE=; OBJ_REASON=; OBJ_GEN=; OBJ_CRC=
  # 1. initiate (no side effect on objects; safe to retry, also after an ambiguous result)
  while :; do
    http POST "$STORAGE_EP/upload/storage/v1/b/$BUCKET/o?uploadType=resumable&ifGenerationMatch=0&name=$(urlenc_key "$key")" \
      -H 'Content-Type: application/json; charset=UTF-8' -H "X-Upload-Content-Type: $ctype" -H "X-Upload-Content-Length: $size" \
      --data-binary "@$meta"
    cls="$(classify "$HTTP_CODE" "$CURL_RC")"
    case "$cls" in
      ok) session="$(header_value Location)"; [ -n "$session" ] || { OBJ_STATE=failed; OBJ_REASON=no-session-uri; return; }; break ;;
      exists) OBJ_STATE=exists; OBJ_REASON=http-412; return ;;
      transient|conn|ambiguous)
        attempt=$((attempt + 1))
        if [ "$attempt" -gt "$RETRY_MAX" ]; then OBJ_STATE=failed; OBJ_REASON="$([ "$HTTP_CODE" = 429 ] && echo rate-limited || echo provider-unavailable)"; return; fi
        backoff "$attempt"; continue ;;
      *) OBJ_STATE=failed; OBJ_REASON="permanent-4xx code=$HTTP_CODE"; return ;;
    esac
  done
  [[ "$session" =~ ^https?://[^[:space:]]+$ ]] || { OBJ_STATE=failed; OBJ_REASON=session-uri-format; return; }
  # 2. send the bytes; on ambiguity ask the session for its status (Content-Range: bytes */SIZE)
  attempt=0
  http PUT "$session" -H "Content-Type: $ctype" --data-binary "@$file"
  while :; do
    cls="$(classify "$HTTP_CODE" "$CURL_RC")"
    case "$cls" in
      ok)
        if validate_resource "$key" "$size" "$md5" "$sha"; then OBJ_STATE=created; else OBJ_STATE=exists; OBJ_REASON=resource-validation-failed; fi
        return ;;
      exists) OBJ_STATE=exists; OBJ_REASON=http-412; return ;;
      permanent) OBJ_STATE=failed; OBJ_REASON="permanent-4xx code=$HTTP_CODE"; return ;;
      transient|conn|ambiguous|incomplete)
        attempt=$((attempt + 1))
        if [ "$attempt" -gt "$RETRY_MAX" ]; then
          if [ "$cls" = ambiguous ]; then OBJ_STATE=unknown; OBJ_REASON=response-lost; else OBJ_STATE=failed; OBJ_REASON="$([ "$HTTP_CODE" = 429 ] && echo rate-limited || echo provider-5xx)"; fi
          return
        fi
        backoff "$attempt"
        # status query: 200/201 = complete (resource returned), 308 = resume from Range, anything else = give up this run
        http PUT "$session" -H 'Content-Length: 0' -H "Content-Range: bytes */$size"
        cls="$(classify "$HTTP_CODE" "$CURL_RC")"
        case "$cls" in
          ok) continue ;;
          incomplete)
            range="$(header_value Range)"
            if [[ "$range" =~ ^bytes=0-([0-9]+)$ ]]; then off=$(( BASH_REMATCH[1] + 1 )); else off=0; fi
            if [ "$off" -ge "$size" ]; then OBJ_STATE=unknown; OBJ_REASON=response-lost; return; fi
            tail -c +"$((off + 1))" "$file" >"$WORK/resume.part"
            http PUT "$session" -H "Content-Type: $ctype" -H "Content-Range: bytes $off-$((size - 1))/$size" --data-binary "@$WORK/resume.part"
            rm -f "$WORK/resume.part"
            continue ;;
          exists) OBJ_STATE=exists; OBJ_REASON=http-412; return ;;
          *) OBJ_STATE=unknown; OBJ_REASON=response-lost; return ;;
        esac ;;
    esac
  done
}

# ── the per-set state machine ────────────────────────────────────────────────
N_UPLOADED=0; N_PENDING=0; N_EXISTS_UNVERIFIED=0; N_FAILED=0; N_SKIPPED=0
RUN_STARTED="$NOW"
# process_set RECEIPT_ID KIND SET SLOT_LABEL FILE DERIVED_FROM(or "")
process_set() {
  local id="$1" kind="$2" set="$3" slot="$4" file="$5" derived="$6"
  local base="$PREFIX/$kind" dkey skey mkey sha size step_reason= existed=0
  dkey="$base/$set"; skey="$base/$set.sha256"; mkey="$base/$set.manifest.json"
  receipt_load "$id" && existed=1 || true
  case "${R[status]}" in
    uploaded) N_SKIPPED=$((N_SKIPPED + 1)); return 0 ;;
    pending-audit)
      if [ "${R[dump]}" != unknown ] && [ "${R[sidecar]}" != unknown ] && [ "${R[manifest]}" != unknown ]; then N_SKIPPED=$((N_SKIPPED + 1)); return 0; fi ;;
  esac
  if [ -e "$RECEIPT_DIR/$id.inprogress" ]; then step_reason=interrupted; log "set=$set: an earlier run was interrupted (resuming from the receipt)"; fi
  : >"$RECEIPT_DIR/$id.inprogress"; chmod 600 "$RECEIPT_DIR/$id.inprogress"
  R[uploader]="$SCRIPT_ID"; R[kind]="$kind"; R[set]="$set"; R[slot]="$slot"; R[canonical]=yes
  R[dump_key]="$dkey"; R[sidecar_key]="$skey"; R[manifest_key]="$mkey"; R[derived_from]="${derived:-}"
  R[attempts]=$(( ${R[attempts]:-0} + 1 )); R[run_started]="$RUN_STARTED"
  [ -n "${R[first_utc]:-}" ] || R[first_utc]="$(date -u +%FT%TZ)"
  R[last_utc]="$(date -u +%FT%TZ)"
  sha="$(cut -c1-64 "$file.sha256")"; size="$(stat -c %s "$file")"
  R[dump_size]="$size"; R[dump_sha256]="$sha"; R[dump_md5_expected]="$(md5_b64 "$file")"
  R[sidecar_size]="$(stat -c %s "$file.sha256")"; R[sidecar_md5_expected]="$(md5_b64 "$file.sha256")"

  finish() {   # STATUS REASON EXITCLASS
    R[status]="$1"; R[last_reason]="$2"; R[last_utc]="$(date -u +%FT%TZ)"
    receipt_save "$id"; rm -f "$RECEIPT_DIR/$id.inprogress"
    log "set=$set kind=$kind slot=$slot status=$1 reason=$2 dump=${R[dump]} sidecar=${R[sidecar]} manifest=${R[manifest]}"
    case "$3" in ok) N_UPLOADED=$((N_UPLOADED + 1)) ;; pending) N_PENDING=$((N_PENDING + 1)) ;; exists) N_EXISTS_UNVERIFIED=$((N_EXISTS_UNVERIFIED + 1)) ;; *) N_FAILED=$((N_FAILED + 1)) ;; esac
  }

  if ! acquire_token; then finish failed "$TOKEN_FAIL_REASON" failed; return 0; fi

  # 1. dump (resumable) — skipped when already created (resource recorded) or known to exist
  if [ "${R[dump]}" != created ] && [ "${R[dump]}" != exists ]; then
    insert_metadata_json "$dkey" application/gzip "${R[dump_md5_expected]}" "$sha" "$slot" "$set" "$kind" >"$WORK/dump.meta"
    create_resumable "$dkey" "$file" application/gzip "$WORK/dump.meta" "$sha"
    case "$OBJ_STATE" in
      created) R[dump]=created; R[dump_generation]="$OBJ_GEN"; R[dump_md5_observed]="$OBJ_MD5"; R[dump_crc32c_observed]="$OBJ_CRC"; receipt_save "$id" ;;
      exists)  R[dump]=exists; R[dump_generation]=; receipt_save "$id"; log "set=$set: dump already exists remotely ($OBJ_REASON) — unobserved, the auditor reconciles it" ;;
      unknown) R[dump]=unknown; finish failed "response-lost" failed; return 0 ;;
      *)       finish failed "dump-upload-failed:$OBJ_REASON" failed; return 0 ;;
    esac
  fi
  # 2. sidecar (multipart)
  if [ "${R[sidecar]}" != created ] && [ "${R[sidecar]}" != exists ]; then
    insert_metadata_json "$skey" text/plain "${R[sidecar_md5_expected]}" "$sha" "$slot" "$set" "$kind" >"$WORK/sidecar.meta"
    create_multipart "$skey" "$file.sha256" text/plain "$WORK/sidecar.meta" "$sha"
    case "$OBJ_STATE" in
      created) R[sidecar]=created; R[sidecar_generation]="$OBJ_GEN"; R[sidecar_md5_observed]="$OBJ_MD5"; R[sidecar_crc32c_observed]="$OBJ_CRC"; receipt_save "$id" ;;
      exists)  R[sidecar]=exists; R[sidecar_generation]=; receipt_save "$id"; log "set=$set: sidecar already exists remotely ($OBJ_REASON) — unobserved, the auditor reconciles it" ;;
      unknown) R[sidecar]=unknown; finish exists-unverified "sidecar-response-lost" exists; return 0 ;;
      *)
        if [ "${R[dump]}" = exists ]; then finish exists-unverified "sidecar-upload-failed:$OBJ_REASON" exists; else finish failed "sidecar-upload-failed:$OBJ_REASON" failed; fi
        return 0 ;;
    esac
  fi
  # 3. manifest (multipart, ALWAYS last)
  if [ "${R[manifest]}" != created ] && [ "${R[manifest]}" != exists ]; then
    local observation=remote-audit-required
    if [ "${R[dump]}" = created ] && [ "${R[sidecar]}" = created ]; then observation=create-responses-validated; fi
    R[observation]="$observation"
    build_manifest "$WORK/manifest.json" "$kind" "$set" "$slot" "$observation" "$derived"
    local msha mmd5
    msha="$(sha256_hex "$WORK/manifest.json")"; mmd5="$(md5_b64 "$WORK/manifest.json")"
    printf '{"name":"%s","contentType":"application/json","md5Hash":"%s","metadata":{"schema":"%s","status":"complete","kind":"%s","slot":"%s","set":"%s","env":"%s","observation":"%s","dump_key":"%s","dump_size":"%s","dump_sha256":"%s","dump_md5_expected":"%s","dump_generation":"%s","sidecar_key":"%s","sidecar_size":"%s","sidecar_md5_expected":"%s","sidecar_generation":"%s","manifest_sha256":"%s","derived_from":"%s"}}' \
      "$mkey" "$mmd5" "$MANIFEST_SCHEMA" "$kind" "$slot" "$set" "$ENV_LABEL" "$observation" \
      "$dkey" "${R[dump_size]}" "${R[dump_sha256]}" "${R[dump_md5_expected]}" "${R[dump_generation]:-null}" \
      "$skey" "${R[sidecar_size]}" "${R[sidecar_md5_expected]}" "${R[sidecar_generation]:-null}" "$msha" "${derived:-}" >"$WORK/manifest.meta"
    create_multipart "$mkey" "$WORK/manifest.json" application/json "$WORK/manifest.meta" ""
    case "$OBJ_STATE" in
      created) R[manifest]=created; R[manifest_generation]="$OBJ_GEN"; R[manifest_sha256]="$msha" ;;
      exists)  R[manifest]=exists; R[manifest_generation]=; finish pending-audit "manifest-exists" pending; return 0 ;;
      unknown) R[manifest]=unknown; finish pending-audit "manifest-response-lost" pending; return 0 ;;
      *)
        if [ "${R[dump]}" = created ] && [ "${R[sidecar]}" = created ]; then finish failed "manifest-upload-failed:$OBJ_REASON" failed; else finish exists-unverified "manifest-upload-failed:$OBJ_REASON" exists; fi
        return 0 ;;
    esac
  fi
  if [ "${R[dump]}" = created ] && [ "${R[sidecar]}" = created ] && [ "${R[manifest]}" = created ] && [ "${R[observation]}" = create-responses-validated ]; then
    finish uploaded "PASS${step_reason:+:$step_reason}" ok
  else
    finish pending-audit "remote-audit-required${step_reason:+:$step_reason}" pending
  fi
}

build_manifest() {   # OUT KIND SET SLOT OBSERVATION DERIVED_FROM (values come from R; unobserved fields are null)
  M_OUT="$1" M_KIND="$2" M_SET="$3" M_SLOT="$4" M_OBS="$5" M_DERIVED="$6" \
  M_SCHEMA="$MANIFEST_SCHEMA" M_ENV="$ENV_LABEL" M_REGION="$REGION" M_UPLOADER="$SCRIPT_ID" \
  M_DKEY="${R[dump_key]}" M_DSIZE="${R[dump_size]}" M_DSHA="${R[dump_sha256]}" M_DMD5E="${R[dump_md5_expected]}" \
  M_DGEN="${R[dump_generation]:-}" M_DMD5O="${R[dump_md5_observed]:-}" M_DCRC="${R[dump_crc32c_observed]:-}" \
  M_SKEY="${R[sidecar_key]}" M_SSIZE="${R[sidecar_size]}" M_SMD5E="${R[sidecar_md5_expected]}" \
  M_SGEN="${R[sidecar_generation]:-}" M_SMD5O="${R[sidecar_md5_observed]:-}" M_SCRC="${R[sidecar_crc32c_observed]:-}" \
  M_DSTATE="${R[dump]}" M_SSTATE="${R[sidecar]}" \
  python3 - <<'PY'
import json, os, time
e = os.environ
def obs(state, value):
    return value if (state == "created" and value) else None
m = {
    "manifest_schema": e["M_SCHEMA"],
    "environment": e["M_ENV"],
    "region": e["M_REGION"],
    "set": e["M_SET"],
    "slot": e["M_SLOT"],
    "kind": e["M_KIND"],
    "derived_from": e["M_DERIVED"] or None,
    "observation": e["M_OBS"],
    "dump": {
        "key": e["M_DKEY"], "size": int(e["M_DSIZE"]), "sha256": e["M_DSHA"], "md5_expected": e["M_DMD5E"],
        "generation": obs(e["M_DSTATE"], e["M_DGEN"]), "md5_observed": obs(e["M_DSTATE"], e["M_DMD5O"]),
        "crc32c_observed": obs(e["M_DSTATE"], e["M_DCRC"]),
    },
    "sidecar": {
        "key": e["M_SKEY"], "size": int(e["M_SSIZE"]), "md5_expected": e["M_SMD5E"],
        "generation": obs(e["M_SSTATE"], e["M_SGEN"]), "md5_observed": obs(e["M_SSTATE"], e["M_SMD5O"]),
        "crc32c_observed": obs(e["M_SSTATE"], e["M_SCRC"]),
    },
    "uncompressed_sensitive_data": "none",
    "uploaded_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "uploader": e["M_UPLOADER"],
    "status": "complete",
}
with open(e["M_OUT"], "w") as fh:
    json.dump(m, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
}

# ── main run ─────────────────────────────────────────────────────────────────
scan_backups
log "run: now_utc=$(date -u -d "@$NOW" +%FT%TZ) current_slot=$(slot_label "$CUR_IDX") backfill_slots=$BACKFILL prefix=$PREFIX region=$REGION storage=$([ "$STORAGE_EP" = https://storage.googleapis.com ] && echo google || echo custom-endpoint)"
awk -F'\t' '$4 != "ok" { print "[offhost] ineligible: file=" $3 " reason=" $4 }' "$WORK/scan.tsv"
SLOTS_MISSING=0; CURRENT_MISSING=0; NONCANONICAL=0
declare -A DAILY_CANON=()
for (( idx = FIRST_IDX; idx <= CUR_IDX; idx++ )); do
  label="$(slot_label "$idx")"
  canon="$(canonical_for "$idx")"
  nonc="$(count_rows "$idx" "$canon" ok)"; NONCANONICAL=$((NONCANONICAL + nonc))
  if [ -z "$canon" ]; then
    SLOTS_MISSING=$((SLOTS_MISSING + 1))
    if [ "$idx" = "$CUR_IDX" ]; then CURRENT_MISSING=1; fi
    log "slot=$label canonical-slot-backup-missing"
    continue
  fi
  [ "$nonc" = 0 ] || log "slot=$label noncanonical=$nonc (later backups of the slot are not replicated to daily/)"
  DAILY_CANON["$idx"]="$canon"
  process_set "${canon%.sql.gz}" daily "$canon" "$label" "$BACKUP_DIR/$canon" ""
done

# ── monthly copy: derived from the first daily set of the month whose receipt reached
#    `uploaded` in an EARLIER run (never from pending-audit), same three-object protocol ─
MONTHLY_RESULT=none
declare -A MONTHS=()
for (( idx = FIRST_IDX; idx <= CUR_IDX; idx++ )); do MONTHS["$(date -u -d "@$(slot_start "$idx")" +%Y%m)"]=1; done
for month in $(printf '%s\n' "${!MONTHS[@]}" | LC_ALL=C sort); do
  mid="monthly-$month"
  if receipt_load "$mid"; then
    case "${R[status]}" in uploaded|pending-audit) if [ "${R[dump]}" != unknown ] && [ "${R[sidecar]}" != unknown ] && [ "${R[manifest]}" != unknown ]; then continue; fi ;; esac
  fi
  best=""; best_stamp=""
  for rf in "$RECEIPT_DIR"/leadcapture-"$month"??-??????.receipt; do
    [ -e "$rf" ] || continue
    rid="$(basename "$rf" .receipt)"
    receipt_load "$rid" || continue
    [ "${R[status]}" = uploaded ] && [ "${R[kind]:-}" = daily ] || continue
    [[ "${R[run_started]:-x}" =~ ^[0-9]+$ ]] && [ "${R[run_started]}" -lt "$RUN_STARTED" ] || continue
    st="$(stamp_epoch "${R[set]}")" || continue
    [ -f "$BACKUP_DIR/${R[set]}" ] && [ -f "$BACKUP_DIR/${R[set]}.sha256" ] || continue
    if [ -z "$best" ] || [ "$st" -lt "$best_stamp" ] || { [ "$st" = "$best_stamp" ] && [[ "${R[set]}" < "$best" ]]; }; then best="${R[set]}"; best_stamp="$st"; fi
  done
  [ -n "$best" ] || continue
  before=$((N_UPLOADED + N_PENDING + N_EXISTS_UNVERIFIED + N_FAILED))
  process_set "$mid" monthly "$best" "$(slot_label "$(slot_index "$best_stamp")")" "$BACKUP_DIR/$best" "$best"
  if [ $((N_UPLOADED + N_PENDING + N_EXISTS_UNVERIFIED + N_FAILED)) -gt "$before" ]; then
    receipt_load "$mid" || true; MONTHLY_RESULT="${R[status]}"
  fi
done

# ── receipt retention (own directory only; never the backup directory) ───────
pruned=0
for f in "$RECEIPT_DIR"/leadcapture-*.receipt "$RECEIPT_DIR"/leadcapture-*.inprogress; do
  [ -e "$f" ] || continue
  n="$(basename "$f")"; n="${n%.receipt}"; n="${n%.inprogress}.sql.gz"
  e="$(stamp_epoch "$n")" || continue
  if [ $(( NOW - e )) -gt $(( KEEP_DAYS * DAY )) ]; then rm -f "$f"; pruned=$((pruned + 1)); fi
done
for f in "$RECEIPT_DIR"/monthly-*.receipt "$RECEIPT_DIR"/crontab.before.*; do
  [ -e "$f" ] || continue
  if [ $(( NOW - $(stat -c %Y "$f") )) -gt $(( KEEP_DAYS * DAY )) ]; then rm -f "$f"; pruned=$((pruned + 1)); fi
done
[ "$pruned" = 0 ] || log "receipt retention: removed $pruned file(s) older than $KEEP_DAYS days from the receipt directory"

# ── summary and exit code ────────────────────────────────────────────────────
if [ "$N_FAILED" -gt 0 ] || [ "$CURRENT_MISSING" = 1 ]; then RESULT=FAIL; RC=1
elif [ "$N_PENDING" -gt 0 ] || [ "$N_EXISTS_UNVERIFIED" -gt 0 ]; then RESULT=AMBIGUOUS; RC=3
else RESULT=PASS; RC=0; fi
echo "OFFHOST_UPLOAD=$RESULT uploaded=$N_UPLOADED pending_audit=$N_PENDING exists_unverified=$N_EXISTS_UNVERIFIED failed=$N_FAILED skipped=$N_SKIPPED slots_missing=$SLOTS_MISSING current_slot_missing=$CURRENT_MISSING noncanonical=$NONCANONICAL monthly=$MONTHLY_RESULT"
exit "$RC"
