#!/bin/bash
# =============================================================================
# Lead Capture Pro — independent off-host backup audit (list-only, keyless)
# =============================================================================
# Runs in GitHub Actions (workflow backup-offhost-alert) and validates, from
# provider LIST metadata only, that the dedicated Cloud Storage bucket holds
# exactly one completed canonical three-object set (dump, sidecar, manifest
# schema lcp-offhost-manifest/2) for the expected UTC slot (03:15 → next
# 03:15) and for the two previous slots, and that every referenced value
# (keys, sizes, md5Hash, custom sha256 metadata, generations when observed,
# manifest not earlier than its objects, one live generation per key) matches.
#
# Authority: `storage.objects.list` ONLY. This script never calls objects.get,
# never downloads (`alt=media`), never creates, updates or deletes anything,
# never touches bucket configuration, IAM, lifecycle or retention, and never
# connects to the VPS. Credentials are short-lived: the GitHub OIDC token is
# exchanged at the STS endpoint (Workload Identity Federation); no key file,
# no stored token, nothing secret is ever printed.
#
# The remote manifest is authoritative: a set that validates here resolves a
# local `pending-audit` receipt without any write-back to the VPS.
#
# Result: exactly one line
#   OFFHOST_HEALTH=PASS slot=<YYYYMMDD-HHMM> set=<name> result=<category> …
#   OFFHOST_HEALTH=FAIL reason=<code> …
# Categories: uploaded-local-and-remote-verified, remote-resolved,
# partial-remote-set, remote-metadata-mismatch, canonical-slot-backup-missing,
# remote-audit-unavailable. Older unresolved sets are reported as
# historical_unresolved=N and never block; a missing monthly copy from day 8
# is a warning (monthly=missing), never a failure.
#
# Environment: OFFHOST_BUCKET, OFFHOST_WIF_AUDIENCE (required); OFFHOST_PREFIX
# (dev/postgres), OFFHOST_STORAGE_ENDPOINT, OFFHOST_STS_ENDPOINT, OFFHOST_SCOPE
# (devstorage.read_only), OFFHOST_IMPERSONATE_SA (optional fallback),
# OFFHOST_BLOCKING_SLOTS (2), OFFHOST_MONTHLY_WARN_DAY (8), OFFHOST_NOW (tests),
# OFFHOST_LOCAL_RECEIPT_STATUS (informational only), ACTIONS_ID_TOKEN_REQUEST_URL
# and ACTIONS_ID_TOKEN_REQUEST_TOKEN (provided by GitHub Actions).
# =============================================================================
set -Eeuo pipefail
umask 077

readonly MANIFEST_SCHEMA="lcp-offhost-manifest/2"
STEP=init
trap 'rc=$?; echo "OFFHOST_HEALTH=FAIL reason=unexpected-error step=$STEP exit=$rc"; exit 1' ERR
fail() { echo "OFFHOST_HEALTH=FAIL reason=$1${2:+ $2}"; exit 1; }
note() { echo "audit: $*"; }

STEP=inputs
BUCKET="${OFFHOST_BUCKET:-}"; AUDIENCE="${OFFHOST_WIF_AUDIENCE:-}"
PREFIX="${OFFHOST_PREFIX:-dev/postgres}"
STORAGE_EP="${OFFHOST_STORAGE_ENDPOINT:-https://storage.googleapis.com}"
STS_EP="${OFFHOST_STS_ENDPOINT:-https://sts.googleapis.com/v1/token}"
IAMCRED_EP="${OFFHOST_IAMCREDENTIALS_ENDPOINT:-https://iamcredentials.googleapis.com}"
SCOPE="${OFFHOST_SCOPE:-https://www.googleapis.com/auth/devstorage.read_only}"
IMPERSONATE="${OFFHOST_IMPERSONATE_SA:-}"
BLOCKING="${OFFHOST_BLOCKING_SLOTS:-2}"
WARN_DAY="${OFFHOST_MONTHLY_WARN_DAY:-8}"
NOW="${OFFHOST_NOW:-$(date -u +%s)}"
LOCAL_RECEIPT="${OFFHOST_LOCAL_RECEIPT_STATUS:-}"
RETRY_MAX="${OFFHOST_RETRY_MAX:-3}"; RETRY_BASE="${OFFHOST_RETRY_BASE_SECONDS:-2}"
OIDC_URL="${ACTIONS_ID_TOKEN_REQUEST_URL:-}"; OIDC_BEARER="${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}"
[[ "$BUCKET" =~ ^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$ ]] || fail configuration detail=bucket-format
[[ "$AUDIENCE" =~ ^//iam\.googleapis\.com/projects/[0-9]+/locations/global/workloadIdentityPools/[A-Za-z0-9_-]+/providers/[A-Za-z0-9_-]+$ ]] || fail configuration detail=audience-format
[[ "$PREFIX" =~ ^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$ ]] || fail configuration detail=prefix-format
[[ "$STORAGE_EP" =~ ^https?://[A-Za-z0-9.:-]+$ ]] || fail configuration detail=storage-endpoint
[[ "$STS_EP" =~ ^https?://[A-Za-z0-9.:/-]+$ ]] || fail configuration detail=sts-endpoint
[[ "$SCOPE" =~ ^https://www\.googleapis\.com/auth/[a-z_.-]+$ ]] || fail configuration detail=scope
[[ "$BLOCKING" =~ ^[0-9]+$ ]] && [[ "$WARN_DAY" =~ ^[0-9]+$ ]] && [[ "$NOW" =~ ^[0-9]+$ ]] && [[ "$RETRY_MAX" =~ ^[0-9]+$ ]] && [[ "$RETRY_BASE" =~ ^[0-9]+$ ]] || fail configuration detail=numeric
[ -z "$IMPERSONATE" ] || [[ "$IMPERSONATE" =~ ^[a-z][a-z0-9-]{4,29}@[a-z0-9-]+\.iam\.gserviceaccount\.com$ ]] || fail configuration detail=impersonate-format
[ -z "$LOCAL_RECEIPT" ] || [[ "$LOCAL_RECEIPT" =~ ^[a-z-]{1,32}$ ]] || LOCAL_RECEIPT=invalid
[ -n "$OIDC_URL" ] && [ -n "$OIDC_BEARER" ] || fail remote-audit-unavailable detail=no-oidc-request-context
for t in curl python3; do command -v "$t" >/dev/null 2>&1 || fail configuration "detail=missing-$t"; done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/offhost-audit.XXXXXXXX")"
chmod 700 "$WORK"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

HTTP_CODE=000; CURL_RC=0
http() {   # METHOD URL [curl args…] — response body → $WORK/resp.body
  local m="$1" u="$2"; shift 2
  HTTP_CODE=000; CURL_RC=0; : >"$WORK/resp.body"
  HTTP_CODE="$(curl -sS -X "$m" "$u" -o "$WORK/resp.body" -w '%{http_code}' --connect-timeout 20 --max-time 120 "$@" 2>"$WORK/curl.err")" || CURL_RC=$?
  [[ "$HTTP_CODE" =~ ^[0-9]{3}$ ]] || HTTP_CODE=000
}
transient() { [ "$CURL_RC" -ne 0 ] || case "$HTTP_CODE" in 429|500|502|503|504) return 0 ;; *) return 1 ;; esac; }
backoff() { [ "$RETRY_BASE" -gt 0 ] || return 0; sleep $(( RETRY_BASE * (1 << ($1 - 1)) )); }
jget() {   # FILE PATH
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    cur = json.load(open(sys.argv[1], "rb"))
except Exception:
    sys.exit(2)
for p in sys.argv[2].split("."):
    if isinstance(cur, dict) and p in cur:
        cur = cur[p]
    else:
        sys.exit(1)
print(cur if not isinstance(cur, (dict, list)) else json.dumps(cur))
PY
}

# ── short-lived credential: GitHub OIDC token → STS exchange (→ optional impersonation) ─
STEP=credential
AUTH_HDR="$WORK/auth.hdr"
printf 'Authorization: Bearer %s\n' "$OIDC_BEARER" >"$WORK/oidc.hdr"; chmod 600 "$WORK/oidc.hdr"; OIDC_BEARER=
sep='?'; [[ "$OIDC_URL" == *\?* ]] && sep='&'
attempt=0
while :; do
  http GET "${OIDC_URL}${sep}audience=$(printf '%s' "$AUDIENCE" | sed 's#/#%2F#g')" -H "@$WORK/oidc.hdr" -H 'Accept: application/json'
  if [ "$CURL_RC" -eq 0 ] && [ "$HTTP_CODE" = 200 ]; then break; fi
  attempt=$((attempt + 1)); [ "$attempt" -le "$RETRY_MAX" ] && transient || fail remote-audit-unavailable "detail=oidc-http-$HTTP_CODE"
  backoff "$attempt"
done
oidc="$(jget "$WORK/resp.body" value)" || fail remote-audit-unavailable detail=oidc-response
[[ "$oidc" =~ ^[A-Za-z0-9._-]{20,}$ ]] || fail remote-audit-unavailable detail=oidc-format
printf '{"grantType":"urn:ietf:params:oauth:grant-type:token-exchange","audience":"%s","scope":"%s","requestedTokenType":"urn:ietf:params:oauth:token-type:access_token","subjectToken":"%s","subjectTokenType":"urn:ietf:params:oauth:token-type:jwt"}' \
  "$AUDIENCE" "$SCOPE" "$oidc" >"$WORK/sts.req"; chmod 600 "$WORK/sts.req"; oidc=
attempt=0
while :; do
  http POST "$STS_EP" -H 'Content-Type: application/json; charset=UTF-8' --data-binary "@$WORK/sts.req"
  if [ "$CURL_RC" -eq 0 ] && [ "$HTTP_CODE" = 200 ]; then break; fi
  attempt=$((attempt + 1)); [ "$attempt" -le "$RETRY_MAX" ] && transient || { rm -f "$WORK/sts.req"; fail remote-audit-unavailable "detail=sts-http-$HTTP_CODE"; }
  backoff "$attempt"
done
rm -f "$WORK/sts.req"
tok="$(jget "$WORK/resp.body" access_token)" || fail remote-audit-unavailable detail=sts-response
: >"$WORK/resp.body"
[[ "$tok" =~ ^[A-Za-z0-9._-]{20,}$ ]] || fail remote-audit-unavailable detail=sts-token-format
if [ -n "$IMPERSONATE" ]; then
  printf 'Authorization: Bearer %s\n' "$tok" >"$AUTH_HDR"; chmod 600 "$AUTH_HDR"; tok=
  printf '{"scope":["%s"],"lifetime":"600s"}' "$SCOPE" >"$WORK/imp.req"
  http POST "$IAMCRED_EP/v1/projects/-/serviceAccounts/$IMPERSONATE:generateAccessToken" -H "@$AUTH_HDR" -H 'Content-Type: application/json; charset=UTF-8' --data-binary "@$WORK/imp.req"
  [ "$CURL_RC" -eq 0 ] && [ "$HTTP_CODE" = 200 ] || fail remote-audit-unavailable "detail=impersonation-http-$HTTP_CODE"
  tok="$(jget "$WORK/resp.body" accessToken)" || fail remote-audit-unavailable detail=impersonation-response
  : >"$WORK/resp.body"
  [[ "$tok" =~ ^[A-Za-z0-9._-]{20,}$ ]] || fail remote-audit-unavailable detail=impersonation-token-format
fi
printf 'Authorization: Bearer %s\n' "$tok" >"$AUTH_HDR"; chmod 600 "$AUTH_HDR"; tok=
note "credential: short-lived token obtained (oidc → sts${IMPERSONATE:+ → impersonation}); scope=$(basename "$SCOPE"); never logged"

# ── objects.list only (explicit prefix, selected fields, paginated; once plain, once versions=true) ─
STEP=list
list_all() {   # VERSIONS(true|false) OUT — concatenates all pages into a JSON array
  local versions="$1" out="$2" token="" page=0 attempt
  echo '[' >"$out"
  while :; do
    attempt=0
    while :; do
      http GET "$STORAGE_EP/storage/v1/b/$BUCKET/o?prefix=$(printf '%s/' "$PREFIX" | sed 's#/#%2F#g')&versions=$versions&maxResults=1000&fields=items(name,generation,size,md5Hash,crc32c,metadata,timeCreated,timeDeleted),nextPageToken${token:+&pageToken=$token}" -H "@$AUTH_HDR" -H 'Accept: application/json'
      if [ "$CURL_RC" -eq 0 ] && [ "$HTTP_CODE" = 200 ]; then break; fi
      attempt=$((attempt + 1)); [ "$attempt" -le "$RETRY_MAX" ] && transient || fail remote-audit-unavailable "detail=list-http-$HTTP_CODE"
      backoff "$attempt"
    done
    page=$((page + 1))
    [ "$page" -gt 1 ] && echo ',' >>"$out"
    python3 - "$WORK/resp.body" >>"$out" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], "rb"))
items = d.get("items", [])
print(json.dumps(items)[1:-1])
PY
    token="$(jget "$WORK/resp.body" nextPageToken 2>/dev/null || true)"
    [[ "$token" =~ ^[A-Za-z0-9_=-]{1,512}$ ]] || break
    [ "$page" -lt 50 ] || fail remote-audit-unavailable detail=too-many-pages
  done
  echo ']' >>"$out"
}
list_all false "$WORK/live.json"
list_all true "$WORK/versions.json"

# ── evaluation from metadata only ────────────────────────────────────────────
STEP=evaluate
A_LIVE="$WORK/live.json" A_VERSIONS="$WORK/versions.json" A_PREFIX="$PREFIX" A_NOW="$NOW" A_BLOCKING="$BLOCKING" A_WARN_DAY="$WARN_DAY" A_SCHEMA="$MANIFEST_SCHEMA" \
python3 - >"$WORK/verdict" <<'PY'
import json, os, re, datetime, calendar
e = os.environ
live = json.load(open(e["A_LIVE"], "rb")); versions = json.load(open(e["A_VERSIONS"], "rb"))
prefix = e["A_PREFIX"]; now = int(e["A_NOW"]); blocking = int(e["A_BLOCKING"]); warn_day = int(e["A_WARN_DAY"]); schema = e["A_SCHEMA"]
SLOT_OFFSET = 3 * 3600 + 15 * 60; DAY = 86400
NAME_RE = re.compile(r"^leadcapture-(\d{8})-(\d{6})\.sql\.gz$")
out = []
def emit(**kw):
    out.append(" ".join("%s=%s" % (k, v) for k, v in kw.items()))
def clean(v):
    return re.sub(r"[^A-Za-z0-9_.,:-]", "-", str(v))[:120]
def stamp_epoch(name):
    m = NAME_RE.match(name)
    if not m:
        return None
    try:
        dt = datetime.datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S")
    except ValueError:
        return None
    return calendar.timegm(dt.timetuple())
def slot_index(t):
    return (t - SLOT_OFFSET) // DAY
def slot_label(i):
    return datetime.datetime.utcfromtimestamp(i * DAY + SLOT_OFFSET).strftime("%Y%m%d-%H%M")
def parse_ts(s):
    m = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z$", s or "")
    if not m:
        return None
    base = calendar.timegm(datetime.datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S").timetuple())
    return base + (float(m.group(2)) if m.group(2) else 0.0)
# live generations per key (from the versions listing: entries without timeDeleted are live)
live_count = {}
for it in versions:
    if "timeDeleted" not in it:
        live_count[it["name"]] = live_count.get(it["name"], 0) + 1
# group by kind / set / role
sets = {}          # (kind, set) -> {"dump": it, "sidecar": it, "manifest": it}
unexpected = []
for it in live:
    name = it.get("name", "")
    if not name.startswith(prefix + "/"):
        unexpected.append(name); continue
    rest = name[len(prefix) + 1:]
    if "/" not in rest:
        unexpected.append(name); continue
    kind, obj = rest.split("/", 1)
    if kind == "manual":
        continue
    if kind not in ("daily", "monthly") or "/" in obj:
        unexpected.append(name); continue
    if obj.endswith(".manifest.json"):
        s, role = obj[:-len(".manifest.json")], "manifest"
    elif obj.endswith(".sha256"):
        s, role = obj[:-len(".sha256")], "sidecar"
    else:
        s, role = obj, "dump"
    if stamp_epoch(s) is None:
        unexpected.append(name); continue
    sets.setdefault((kind, s), {})[role] = it
def validate(kind, s, parts):
    """Returns (category, detail) — category is a PASS category or a FAIL reason."""
    missing = [r for r in ("dump", "sidecar", "manifest") if r not in parts]
    if missing:
        return "partial-remote-set", "missing-" + ",".join(missing)
    d, sc, mf = parts["dump"], parts["sidecar"], parts["manifest"]
    m = mf.get("metadata") or {}
    for k, want in (("schema", schema), ("status", "complete"), ("set", s), ("kind", kind), ("slot", slot_label(slot_index(stamp_epoch(s))))):
        if m.get(k) != want:
            return "remote-metadata-mismatch", "manifest-" + k
    if m.get("observation") not in ("create-responses-validated", "remote-audit-required"):
        return "remote-metadata-mismatch", "manifest-observation"
    if m.get("dump_key") != d["name"] or m.get("sidecar_key") != sc["name"]:
        return "remote-metadata-mismatch", "key"
    if str(m.get("dump_size")) != str(d.get("size")) or str(m.get("sidecar_size")) != str(sc.get("size")):
        return "remote-metadata-mismatch", "size"
    if m.get("dump_md5_expected") != d.get("md5Hash") or m.get("sidecar_md5_expected") != sc.get("md5Hash"):
        return "remote-metadata-mismatch", "md5"
    dsha = (d.get("metadata") or {}).get("sha256")
    if not dsha or not re.match(r"^[0-9a-f]{64}$", m.get("dump_sha256", "")) or dsha != m.get("dump_sha256"):
        return "remote-metadata-mismatch", "sha256"
    ssha = (sc.get("metadata") or {}).get("sha256")
    if not ssha or ssha != m.get("dump_sha256"):
        return "remote-metadata-mismatch", "sidecar-sha256"
    validated = m.get("observation") == "create-responses-validated"
    for role, it in (("dump", d), ("sidecar", sc)):
        g = m.get(role + "_generation")
        if validated and (not g or g == "null"):
            return "remote-metadata-mismatch", role + "-generation-unobserved"
        if g and g != "null" and g != str(it.get("generation")):
            return "remote-metadata-mismatch", role + "-generation"
    tm, td, ts = parse_ts(mf.get("timeCreated")), parse_ts(d.get("timeCreated")), parse_ts(sc.get("timeCreated"))
    if None in (tm, td, ts):
        return "remote-metadata-mismatch", "timestamp-format"
    if tm < td or tm < ts:
        return "remote-metadata-mismatch", "manifest-before-object"
    for it in (d, sc, mf):
        if live_count.get(it["name"], 1) > 1:
            return "remote-metadata-mismatch", "duplicate-live-generation"
    return ("uploaded-local-and-remote-verified" if validated else "remote-resolved"), "ok"
cur = slot_index(now)
verdict_fail = None
window_ok = 0; window_total = blocking + 1; historical_unresolved = 0
slot_sets = {}
for (kind, s), parts in sets.items():
    if kind != "daily":
        continue
    slot_sets.setdefault(slot_index(stamp_epoch(s)), []).append((s, parts))
def eval_slot(i):
    entries = slot_sets.get(i, [])
    completed = [(s, p) for s, p in entries if "manifest" in p and ((p["manifest"].get("metadata") or {}).get("status") == "complete")]
    if len(completed) > 1:
        return "remote-metadata-mismatch", "duplicate-canonical-set", ",".join(sorted(s for s, _ in completed))
    if not completed:
        if entries:
            s, p = sorted(entries)[0]
            return "partial-remote-set", validate("daily", s, p)[1], s
        return "canonical-slot-backup-missing", "no-set", "-"
    s, p = completed[0]
    others = [o for o, _ in entries if o != s]
    if others:
        return "remote-metadata-mismatch", "unexpected-object-in-slot", s
    cat, detail = validate("daily", s, p)
    return cat, detail, s
main_cat, main_set = "-", "-"
for i in range(cur - blocking, cur + 1):
    cat, detail, s = eval_slot(i)
    ok = cat in ("uploaded-local-and-remote-verified", "remote-resolved")
    emit(slot=slot_label(i), set=s, result=cat, detail=clean(detail))
    if ok:
        window_ok += 1
    elif verdict_fail is None or i == cur:
        verdict_fail = {"reason": cat, "slot": slot_label(i), "set": s, "detail": clean(detail)}
    if i == cur:
        main_cat, main_set = cat, s
for i, entries in slot_sets.items():
    if i < cur - blocking:
        cat, detail, s = eval_slot(i)
        if cat not in ("uploaded-local-and-remote-verified", "remote-resolved"):
            historical_unresolved += 1
if unexpected and verdict_fail is None:
    verdict_fail = {"reason": "remote-metadata-mismatch", "slot": slot_label(cur), "set": clean(unexpected[0].split("/")[-1]), "detail": "unexpected-object"}
# monthly: warning only
slot_date = datetime.datetime.utcfromtimestamp(cur * DAY + SLOT_OFFSET)
month = slot_date.strftime("%Y%m")
monthly = "not-due"
if slot_date.day >= warn_day:
    monthly = "missing"
    for (kind, s), parts in sets.items():
        if kind == "monthly" and s.startswith("leadcapture-" + month):
            cat, detail = validate("monthly", s, parts)
            monthly = "ok" if cat in ("uploaded-local-and-remote-verified", "remote-resolved") else "mismatch"
            emit(monthly_set=s, monthly_result=cat, detail=clean(detail))
            if monthly == "ok":
                break
for line in out:
    print("DETAIL " + line)
tail = "window_ok=%d/%d historical_unresolved=%d monthly=%s unexpected=%d" % (window_ok, window_total, historical_unresolved, monthly, len(unexpected))
if verdict_fail:
    print("VERDICT status=FAIL " + " ".join("%s=%s" % (k, clean(v)) for k, v in verdict_fail.items()) + " " + tail)
else:
    p = sets[("daily", main_set)]; mm = p["manifest"].get("metadata") or {}
    print("VERDICT status=PASS slot=%s set=%s result=%s observation=%s dump_size=%s dump_generation=%s sha256_prefix=%s %s" % (
        slot_label(cur), main_set, main_cat, clean(mm.get("observation")), clean(p["dump"].get("size")), clean(p["dump"].get("generation")),
        clean((p["dump"].get("metadata") or {}).get("sha256", "")[:12]), tail))
PY
grep '^DETAIL ' "$WORK/verdict" | sed 's/^DETAIL /audit: /'
v="$(grep '^VERDICT ' "$WORK/verdict" | sed 's/^VERDICT //')"
[ -n "$v" ] || fail unexpected-error detail=no-verdict
[ -z "$LOCAL_RECEIPT" ] || note "local receipt status (informational only, never authoritative): $LOCAL_RECEIPT"
STEP=result
status="$(printf '%s\n' "$v" | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^status=/) { sub(/^status=/, "", $i); print $i } }')"
rest="${v#status=* }"
if [ "$status" = PASS ]; then
  echo "OFFHOST_HEALTH=PASS $rest${LOCAL_RECEIPT:+ local_receipt=$LOCAL_RECEIPT}"
  exit 0
fi
echo "OFFHOST_HEALTH=FAIL $rest${LOCAL_RECEIPT:+ local_receipt=$LOCAL_RECEIPT}"
exit 1
