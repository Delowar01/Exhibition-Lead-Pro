#!/bin/bash
# =============================================================================
# Deterministic harness for docker/scripts/backup-offhost.sh and offhost-cron.sh
# =============================================================================
# Everything is local and fake: a Python fake of the Cloud Storage JSON API +
# STS (docker/scripts/test/fake-gcs.py) with fault injection, a controlled
# clock (OFFHOST_NOW), synthetic backups with controlled stamps/mtimes, and a
# stub `crontab`. No network beyond 127.0.0.1, no provider, no credential:
# the subject token is a random string and the fake STS answers with a
# distinctive value that must never appear in any output, receipt or object.
#
# Run:  bash docker/scripts/test/backup-offhost.test.sh
# Requirements: bash, python3, curl, gzip, sha256sum, openssl, flock, timeout.
# Exit status is non-zero when any check fails.
# =============================================================================
set -uo pipefail
export PYTHONDONTWRITEBYTECODE=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UP="${BACKUP_TEST_UPLOADER:-$HERE/../backup-offhost.sh}"
CRONMGR="${BACKUP_TEST_CRONMGR:-$HERE/../offhost-cron.sh}"
FAKE="$HERE/fake-gcs.py"
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*" >&2; }
check() { local d="$1"; shift; if "$@"; then pass; else fail "$d"; fi; }
eq() { [ "$1" = "$2" ]; }
has() { [[ "$1" == *"$2"* ]]; }
nothas() { [[ "$1" != *"$2"* ]]; }
section() { echo "--- $*"; }

unset AWS_SECRET_ACCESS_KEY AWS_ACCESS_KEY_ID GOOGLE_APPLICATION_CREDENTIALS CLOUDSDK_CONFIG 2>/dev/null || true
T="$(mktemp -d)"
FAKE_PID=
cleanup() { [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
BK="$T/backups"; RC="$T/receipts"; ALLLOG="$T/all.log"; : >"$ALLLOG"

# ── 1. syntax ────────────────────────────────────────────────────────────────
section "1. syntax"
check "uploader parses" bash -n "$UP"
check "cron manager parses" bash -n "$CRONMGR"
check "fake provider parses" python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$FAKE"

# ── fake provider ────────────────────────────────────────────────────────────
mkdir -p "$T/state"
python3 "$FAKE" 0 "$T/state" & FAKE_PID=$!
for _ in $(seq 1 50); do [ -s "$T/state/port" ] && break; sleep 0.1; done
[ -s "$T/state/port" ] || { echo "fake provider did not start" >&2; exit 1; }
EP="http://127.0.0.1:$(cat "$T/state/port")"
ctl() { curl -sS -X POST "$EP/__control/$1" -H 'Content-Type: application/json' --data-binary "${2:-{\}}"; }
ctl_reset() { ctl reset >/dev/null; }
fault() {   # METHOD PATH_CONTAINS NAME_CONTAINS ACTION TIMES
  ctl fault "$(python3 -c 'import json,sys
a=sys.argv[1:]; m={}
if a[0]: m["method"]=a[0]
if a[1]: m["path_contains"]=a[1]
if a[2]: m["name_contains"]=a[2]
print(json.dumps({"match":m,"action":a[3],"times":int(a[4])}))' "$@")" >/dev/null
}
reqlog() { curl -sS "$EP/__control/reqlog"; }
clear_reqlog() { ctl clear_reqlog >/dev/null; }
reqseq() {   # kinds (except sts) with object basename, in order
  reqlog | python3 -c 'import json,sys
print(" ".join("%s:%s" % (r.get("kind"), r.get("name","").split("/")[-1]) for r in json.load(sys.stdin) if r.get("kind") not in ("sts",)))'
}
reqcount() { reqlog | python3 -c "import json,sys; print(sum(1 for r in json.load(sys.stdin) if r.get('kind')=='$1' and '$2' in r.get('name','')))"; }
creates_without_precondition() { reqlog | python3 -c 'import json,sys
print(sum(1 for r in json.load(sys.stdin) if r.get("kind") in ("resumable_init","multipart") and r.get("if_generation_match")!="0"))'; }
forbidden_calls() { reqlog | python3 -c 'import json,sys; print(sum(1 for r in json.load(sys.stdin) if r.get("kind")=="forbidden"))'; }
obj_code() { curl -sS -o /dev/null -w '%{http_code}' -X POST "$EP/__control/object" -H 'Content-Type: application/json' --data-binary "{\"key\":\"$1\"}"; }
obj_json() { curl -sS -X POST "$EP/__control/object" -H 'Content-Type: application/json' --data-binary "{\"key\":\"$1\"}"; }
obj_field() { obj_json "$1" | python3 -c "import json,sys; d=json.load(sys.stdin); v=d['resource']
for p in '$2'.split('.'): v=v[p]
print(v)"; }
obj_content_sha() { obj_json "$1" | python3 -c 'import json,sys,base64,hashlib; print(hashlib.sha256(base64.b64decode(json.load(sys.stdin)["content_b64"])).hexdigest())'; }
manifest_field() { obj_json "$1" | python3 -c "import json,sys,base64; m=json.loads(base64.b64decode(json.load(sys.stdin)['content_b64']))
v=m
for p in '$2'.split('.'): v=v[p]
print(json.dumps(v) if isinstance(v,(dict,list)) or v is None else v)"; }
seed() {   # KEY CONTENT_FILE [METADATA_JSON]
  python3 - "$EP" "$1" "$2" "${3:-{\}}" <<'PY'
import base64, json, sys, urllib.request
ep, key, path, meta = sys.argv[1:]
body = json.dumps({"key": key, "content_b64": base64.b64encode(open(path, "rb").read()).decode(), "metadata": json.loads(meta)}).encode()
urllib.request.urlopen(urllib.request.Request(ep + "/__control/seed", data=body, headers={"Content-Type": "application/json"})).read()
PY
}

# ── fixtures ─────────────────────────────────────────────────────────────────
reset_fs() { rm -rf "$BK" "$RC"; mkdir -p "$BK"; chmod 700 "$BK"; }
mkdump() {   # NAME MTIME_EPOCH [ROWS] [STYLE: ok|nomarker|noheader|badgz|nosidecar|badsidecar|othername]
  local name="$1" mtime="$2" rows="${3:-120}" style="${4:-ok}" f="$BK/$1" i
  {
    [ "$style" = noheader ] || { echo "--"; echo "-- PostgreSQL database dump"; echo "--"; echo; }
    echo '\restrict k3yk3y'
    echo "CREATE TABLE public.t (id integer, v text);"
    echo "COPY public.t (id, v) FROM stdin;"
    for (( i = 0; i < rows; i++ )); do printf '%d\trow-%s-%08d\n' "$i" "$name" "$i"; done
    echo '\.'; echo
    [ "$style" = nomarker ] || { echo "--"; echo "-- PostgreSQL database dump complete"; echo "--"; }
    echo; echo '\unrestrict k3yk3y'; echo
  } | gzip -c >"$f"
  [ "$style" != badgz ] || { head -c 200 "$f" >"$f.tmp"; mv "$f.tmp" "$f"; }
  if [ "$style" != nosidecar ]; then
    ( cd "$BK" && sha256sum "$name" >"$name.sha256" )
    [ "$style" != badsidecar ] || sed -i 's/^[0-9a-e]/f/; t; s/^f/0/' "$BK/$name.sha256"
    [ "$style" != othername ] || sed -i "s/$name/leadcapture-20200101-000000.sql.gz/" "$BK/$name.sha256"
    chmod 600 "$BK/$name.sha256"; touch -d "@$mtime" "$BK/$name.sha256"
  fi
  chmod 600 "$f"; touch -d "@$mtime" "$f"
}
ts() { date -u -d "$1" +%s; }
fp() { ( cd "$BK" && find . -printf '%P %s %T@ %m %y\n' | LC_ALL=C sort | sha256sum | cut -c1-16 ); }
printf 'eyJhbGciOiJSUzI1NiJ9.SUBJECTTOKEN-%s.sig' "$(openssl rand -hex 16)" >"$T/subject.jwt"; chmod 600 "$T/subject.jwt"
SUBJECT_MARK="$(tr -d '\r\n' <"$T/subject.jwt")"
export OFFHOST_BUCKET=lcp-test-bucket OFFHOST_WIF_AUDIENCE=//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/lcp-test/providers/vps-test
export OFFHOST_SUBJECT_TOKEN_FILE="$T/subject.jwt" OFFHOST_STORAGE_ENDPOINT="$EP" OFFHOST_STS_ENDPOINT="$EP/v1/token" OFFHOST_IAMCREDENTIALS_ENDPOINT="$EP"
export OFFHOST_RETRY_BASE_SECONDS=0 OFFHOST_CONNECT_TIMEOUT=5 OFFHOST_MAX_TIME=20 BACKUP_DIR="$BK" OFFHOST_RECEIPT_DIR="$RC"
NOW="$(ts '2026-09-28 12:00:00')"; export OFFHOST_NOW="$NOW" OFFHOST_BACKFILL_SLOTS=7
OUT=""; RCODE=0
run_up() { OUT="$(bash "$UP" "$@" 2>&1)"; RCODE=$?; printf '%s\n' "$OUT" >>"$ALLLOG"; }
run_up_killed() {   # SECONDS — run the uploader and SIGKILL it after SECONDS (crash simulation)
  OUT="$(timeout -s KILL "$1" bash "$UP" 2>&1)"; RCODE=$?; printf '%s\n' "$OUT" >>"$ALLLOG"
}
sumv() { printf '%s\n' "$OUT" | awk -v k="$1" '/^OFFHOST_UPLOAD=/ { for (i = 1; i <= NF; i++) if (split($i, a, "=") == 2 && a[1] == k) print a[2] }'; }
rget() { awk -F'=' -v k="$2" '$1 == k { sub(/^[^=]*=/, ""); print }' "$RC/$1.receipt" 2>/dev/null; }
receipt_invariant() {   # every receipt: uploaded ⇒ all three created and validated
  local f ok=1
  for f in "$RC"/*.receipt; do
    [ -e "$f" ] || continue
    if grep -qx 'status=uploaded' "$f"; then
      grep -qx 'dump=created' "$f" && grep -qx 'sidecar=created' "$f" && grep -qx 'manifest=created' "$f" && grep -qx 'observation=create-responses-validated' "$f" || ok=0
    fi
    [ "$(stat -c %a "$f")" = 600 ] || ok=0
  done
  [ "$ok" = 1 ]
}
D1=leadcapture-20260928-031501.sql.gz; K1="dev/postgres/daily/$D1"
D0=leadcapture-20260927-031501.sql.gz; K0="dev/postgres/daily/$D0"

# ── 2. canonical slot selection (plan mode: read-only, no network) ───────────
section "2. canonical slot selection"
export OFFHOST_BACKFILL_SLOTS=1
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; mkdump leadcapture-20260928-100000.sql.gz "$(ts '2026-09-28 10:00:01')" 40
run_up plan
check "plan exits 0" eq "$RCODE" 0
check "scheduled 03:15:01 chosen over manual 10:00" has "$OUT" "slot=20260928-0315 canonical=$D1 noncanonical=1 ineligible=0"
reset_fs; mkdump leadcapture-20260928-090000.sql.gz "$(ts '2026-09-28 09:00:03')"; mkdump leadcapture-20260928-150000.sql.gz "$(ts '2026-09-28 15:00:03')" 40
run_up plan
check "two manual backups: 09:00 chosen" has "$OUT" "canonical=leadcapture-20260928-090000.sql.gz noncanonical=1"
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')" 120 badsidecar; mkdump leadcapture-20260928-031540.sql.gz "$(ts '2026-09-28 03:15:41')"
run_up plan
check "ineligible earliest skipped, later valid chosen" has "$OUT" "canonical=leadcapture-20260928-031540.sql.gz noncanonical=0 ineligible=1"
check "ineligible reason reported" has "$OUT" "ineligible: file=$D1 reason=checksum-mismatch"
reset_fs; mkdump leadcapture-20260928-032000.sql.gz "$(ts '2026-09-28 03:41:00')"; mkdump leadcapture-20260928-034000.sql.gz "$(ts '2026-09-28 03:41:00')"
run_up plan
check "equal mtime, different stamps: earlier stamp chosen" has "$OUT" "canonical=leadcapture-20260928-032000.sql.gz noncanonical=1"
reset_fs; mkdump leadcapture-20260928-031459.sql.gz "$(ts '2026-09-28 03:14:59')"
run_up plan
check "03:14:59 belongs to the previous slot" has "$OUT" "slot=20260927-0315 canonical=leadcapture-20260928-031459.sql.gz"
check "03:14:59 is not the current slot's backup" has "$OUT" "slot=20260928-0315 canonical=none"
reset_fs; mkdump leadcapture-20260929-031500.sql.gz "$(ts '2026-09-29 03:15:00')"
OFFHOST_NOW="$(ts '2026-09-29 04:00:00')" run_up plan
check "next day 03:15:00 belongs to the next slot" has "$OUT" "slot=20260929-0315 canonical=leadcapture-20260929-031500.sql.gz"
run_up plan
check "next day 03:15:00 is not in today's slot" has "$OUT" "slot=20260928-0315 canonical=none"
reset_fs; mkdump leadcapture-20260928-034012.sql.gz "$(ts '2026-09-28 03:40:13')"
run_up plan
check "delayed 03:40 backup chosen when nothing earlier is eligible" has "$OUT" "slot=20260928-0315 canonical=leadcapture-20260928-034012.sql.gz noncanonical=0"
export OFFHOST_BACKFILL_SLOTS=7
reset_fs; for d in 02 05 09 15; do mkdump "leadcapture-202609${d}-120000.sql.gz" "$(ts "2026-09-$d 12:00:01")" 30 nosidecar; done; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"
run_up plan
check "historical pre-sidecar backups are ineligible" eq "$(printf '%s\n' "$OUT" | grep -c 'reason=sidecar-missing')" 4
check "historical slots are outside the window" nothas "$OUT" "slot=20260902"
check "window starts 7 slots back" has "$OUT" "slot=20260921-0315 canonical=none"
reset_fs; mkdump "$D1" "$(ts '2026-09-27 20:00:00')"
run_up plan; check "mtime outside the stamp's slot is ineligible" has "$OUT" "reason=mtime-outside-stamp-slot"
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')" 120 nomarker; run_up plan; check "missing completion marker is ineligible" has "$OUT" "reason=completion-marker-missing"
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')" 120 noheader; run_up plan; check "missing header is ineligible" has "$OUT" "reason=header-missing"
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')" 120 badgz; run_up plan; check "corrupt gzip is ineligible" has "$OUT" "reason=gzip-invalid"
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')" 120 othername; run_up plan; check "sidecar naming another file is ineligible" has "$OUT" "reason=sidecar-names-other-file"
reset_fs; mkdump leadcapture-20260928-040000.sql.gz "$(ts '2026-09-28 04:00:01')"; ln -s leadcapture-20260928-040000.sql.gz "$BK/$D1"; cp "$BK/leadcapture-20260928-040000.sql.gz.sha256" "$BK/$D1.sha256"
run_up plan; check "symlink is not a regular file" has "$OUT" "file=$D1 reason=not-regular-file"
check "symlink never becomes canonical" has "$OUT" "canonical=leadcapture-20260928-040000.sql.gz"
reset_fs; mkdump leadcapture-2026092x-031501.sql.gz "$(ts '2026-09-28 03:15:02')" 10 2>/dev/null || true
run_up plan; check "malformed stamp is reported as stamp-invalid" has "$OUT" "file=leadcapture-2026092x-031501.sql.gz reason=stamp-invalid"
reset_fs; mkdump leadcapture-20260931-031501.sql.gz "$(ts '2026-09-28 03:15:02')" 10
run_up plan; check "impossible date fails the round-trip" has "$OUT" "reason=stamp-invalid"
export OFFHOST_BACKFILL_SLOTS=1
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; mkdump leadcapture-20260928-100000.sql.gz "$(ts '2026-09-28 10:00:01')" 40
ctl_reset; run_up
check "run: only the canonical set is uploaded" eq "$(reqcount resumable_init leadcapture-20260928-)" 1
check "run: the manual backup is not replicated" eq "$(obj_code dev/postgres/daily/leadcapture-20260928-100000.sql.gz)" 404
check "run: summary counts the non-canonical backup" eq "$(sumv noncanonical)" 1
check "plan mode wrote no receipt directory" eq "$( [ -d "$RC" ] && echo yes || echo no)" yes   # created by run, not by plan
rm -rf "$RC"; reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; run_up plan
check "plan mode never creates the receipt directory" eq "$( [ -d "$RC" ] && echo yes || echo no)" no

# ── 3. three-object upload protocol ──────────────────────────────────────────
section "3. upload protocol"
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset
FP1="$(fp)"; run_up; FP2="$(fp)"
check "clean run exits 0" eq "$RCODE" 0
check "summary PASS" eq "$(sumv uploaded)" 1
check "request order: dump → sidecar → manifest" eq "$(reqseq)" "resumable_init:$D1 resumable_put:$D1 multipart:$D1.sha256 multipart:$D1.manifest.json"
check "every create carries ifGenerationMatch=0" eq "$(creates_without_precondition)" 0
check "no get/download/patch/delete was attempted" eq "$(forbidden_calls)" 0
check "receipt uploaded" eq "$(rget "${D1%.sql.gz}" status)" uploaded
check "receipt observation validated" eq "$(rget "${D1%.sql.gz}" observation)" create-responses-validated
check "receipt mode 600" eq "$(stat -c %a "$RC/${D1%.sql.gz}.receipt")" 600
check "receipt dir mode 700" eq "$(stat -c %a "$RC")" 700
check "no .inprogress marker left" eq "$(ls "$RC"/*.inprogress 2>/dev/null | wc -l)" 0
check "remote dump byte-identical to local" eq "$(obj_content_sha "$K1")" "$(cut -c1-64 "$BK/$D1.sha256")"
check "remote sidecar byte-identical to local" eq "$(obj_content_sha "$K1.sha256")" "$(sha256sum "$BK/$D1.sha256" | cut -c1-64)"
check "manifest schema v2" eq "$(manifest_field "$K1.manifest.json" manifest_schema)" lcp-offhost-manifest/2
check "manifest region me-central2" eq "$(manifest_field "$K1.manifest.json" region)" me-central2
check "manifest status complete" eq "$(manifest_field "$K1.manifest.json" status)" complete
check "manifest dump generation = live generation" eq "$(manifest_field "$K1.manifest.json" dump.generation)" "$(obj_field "$K1" generation)"
check "manifest sidecar generation = live generation" eq "$(manifest_field "$K1.manifest.json" sidecar.generation)" "$(obj_field "$K1.sha256" generation)"
check "manifest dump md5 observed = live md5Hash" eq "$(manifest_field "$K1.manifest.json" dump.md5_observed)" "$(obj_field "$K1" md5Hash)"
check "manifest dump sha256 = sidecar" eq "$(manifest_field "$K1.manifest.json" dump.sha256)" "$(cut -c1-64 "$BK/$D1.sha256")"
check "manifest created last (highest generation)" eq "$(python3 -c "print($(obj_field "$K1.manifest.json" generation) > $(obj_field "$K1.sha256" generation) > $(obj_field "$K1" generation))")" True
check "dump object carries sha256 metadata" eq "$(obj_field "$K1" metadata.sha256)" "$(cut -c1-64 "$BK/$D1.sha256")"
check "manifest metadata mirrors status" eq "$(obj_field "$K1.manifest.json" metadata.status)" complete
check "manifest metadata mirrors dump generation" eq "$(obj_field "$K1.manifest.json" metadata.dump_generation)" "$(obj_field "$K1" generation)"
check "manifest metadata mirrors schema" eq "$(obj_field "$K1.manifest.json" metadata.schema)" lcp-offhost-manifest/2
check "manifest declares no sensitive plaintext" eq "$(manifest_field "$K1.manifest.json" uncompressed_sensitive_data)" none
check "backup directory untouched by the run" eq "$FP1" "$FP2"
check "STS exchange requested the read_write scope" eq "$(reqlog | python3 -c 'import json,sys; print([r.get("sts_scope") for r in json.load(sys.stdin) if r.get("kind")=="sts"][0])')" https://www.googleapis.com/auth/devstorage.read_write
check "STS exchange used the configured audience" eq "$(reqlog | python3 -c 'import json,sys; print([r.get("sts_audience") for r in json.load(sys.stdin) if r.get("kind")=="sts"][0])')" "$OFFHOST_WIF_AUDIENCE"
check "all storage requests were authenticated" eq "$(reqlog | python3 -c 'import json,sys; print(sum(1 for r in json.load(sys.stdin) if r.get("kind")!="sts" and r.get("auth")!="bearer"))')" 0
check "output never contains the access token" nothas "$OUT" "SECRETTOKEN"
check "output never contains the subject token" nothas "$OUT" "$SUBJECT_MARK"
clear_reqlog; run_up
check "second run is idempotent (exit 0)" eq "$RCODE" 0
check "second run performs no storage request" eq "$(reqseq)" ""
check "second run skips the uploaded set" eq "$(sumv skipped)" 1
check "receipt invariant holds" receipt_invariant
# impersonation variant
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset
OFFHOST_IMPERSONATE_SA=lcp-backup-uploader@lcp-test-project.iam.gserviceaccount.com run_up
check "impersonation flow uploads" eq "$RCODE" 0
check "impersonation call made once" eq "$(reqlog | python3 -c 'import json,sys; print(sum(1 for r in json.load(sys.stdin) if r.get("kind")=="impersonate"))')" 1
check "impersonation output has no token" nothas "$OUT" "SECRETTOKEN"

# ── 4. 412, lost responses, crashes, retries ─────────────────────────────────
section "4. 412 / lost responses / crashes / retries"
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; seed "$K1" "$BK/$D1" '{"sha256":"seeded"}'
run_up
check "412 on dump: exit 3" eq "$RCODE" 3
check "412 on dump: receipt pending-audit" eq "$(rget "${D1%.sql.gz}" status)" pending-audit
check "412 on dump: dump recorded as exists" eq "$(rget "${D1%.sql.gz}" dump)" exists
check "412 on dump: sidecar still created" eq "$(rget "${D1%.sql.gz}" sidecar)" created
check "412 on dump: manifest audit-required" eq "$(manifest_field "$K1.manifest.json" observation)" remote-audit-required
check "412 on dump: dump generation null in manifest" eq "$(manifest_field "$K1.manifest.json" dump.generation)" null
check "412 on dump: metadata mirrors null generation" eq "$(obj_field "$K1.manifest.json" metadata.dump_generation)" null
check "412 on dump: expected values still mandatory" eq "$(manifest_field "$K1.manifest.json" dump.sha256)" "$(cut -c1-64 "$BK/$D1.sha256")"
check "412 on dump: existing object untouched" eq "$(obj_field "$K1" metadata.sha256)" seeded
check "412 on dump: no create without precondition" eq "$(creates_without_precondition)" 0
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; seed "$K1.sha256" "$BK/$D1.sha256"
run_up
check "412 on sidecar: pending-audit" eq "$(rget "${D1%.sql.gz}" status)" pending-audit
check "412 on sidecar: sidecar exists" eq "$(rget "${D1%.sql.gz}" sidecar)" exists
check "412 on sidecar: manifest sidecar generation null" eq "$(manifest_field "$K1.manifest.json" sidecar.generation)" null
check "412 on sidecar: dump generation observed" eq "$(manifest_field "$K1.manifest.json" dump.generation)" "$(obj_field "$K1" generation)"
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; printf '{}' >"$T/foreign.json"; seed "$K1.manifest.json" "$T/foreign.json"
run_up
check "412 on manifest: pending-audit" eq "$(rget "${D1%.sql.gz}" status)" pending-audit
check "412 on manifest: reason manifest-exists" eq "$(rget "${D1%.sql.gz}" last_reason)" manifest-exists
check "412 on manifest: dump and sidecar created" eq "$(rget "${D1%.sql.gz}" dump)/$(rget "${D1%.sql.gz}" sidecar)" created/created
check "412 on manifest: foreign manifest untouched" eq "$(obj_content_sha "$K1.manifest.json")" "$(sha256sum "$T/foreign.json" | cut -c1-64)"
clear_reqlog; run_up; check "412 on manifest: next run skips (nothing creatable)" eq "$(reqseq)" ""
# lost dump response, session status recovers
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; fault PUT "" "|data" store_then_drop 1
run_up
check "lost dump response recovered via session status: exit 0" eq "$RCODE" 0
check "lost dump response: status query was issued" eq "$(reqlog | python3 -c 'import json,sys; print(sum(1 for r in json.load(sys.stdin) if r.get("kind")=="resumable_put" and r.get("status_query")))')" 1
check "lost dump response: single dump created" eq "$(reqcount resumable_init "$D1")" 1
check "lost dump response: receipt uploaded" eq "$(rget "${D1%.sql.gz}" status)" uploaded
# lost dump response and status query also fails
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; fault PUT "" "|data" store_then_drop 1; fault PUT "" "|status" drop 1
run_up
check "lost dump + failed status: exit 1" eq "$RCODE" 1
check "lost dump + failed status: receipt failed response-lost" eq "$(rget "${D1%.sql.gz}" status)/$(rget "${D1%.sql.gz}" last_reason)" failed/response-lost
check "lost dump + failed status: dump unknown" eq "$(rget "${D1%.sql.gz}" dump)" unknown
check "lost dump + failed status: no sidecar uploaded yet" eq "$(obj_code "$K1.sha256")" 404
clear_reqlog; run_up
check "next run reconciles: 412 → exists → pending-audit" eq "$(rget "${D1%.sql.gz}" status)/$(rget "${D1%.sql.gz}" dump)" pending-audit/exists
check "next run: manifest audit-required" eq "$(manifest_field "$K1.manifest.json" observation)" remote-audit-required
check "next run: exit 3" eq "$RCODE" 3
# lost sidecar response
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; fault POST multipart .sha256 store_then_drop 1
run_up
check "lost sidecar response: re-attempt sees 412 → exists" eq "$(rget "${D1%.sql.gz}" sidecar)" exists
check "lost sidecar response: two sidecar requests" eq "$(reqcount multipart .sha256)" 2
check "lost sidecar response: pending-audit, exit 3" eq "$RCODE/$(rget "${D1%.sql.gz}" status)" 3/pending-audit
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; fault POST multipart .sha256 drop 1
run_up
check "lost sidecar request (never stored): re-attempt creates → uploaded" eq "$RCODE/$(rget "${D1%.sql.gz}" status)" 0/uploaded
# lost manifest response
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; fault POST multipart .manifest.json store_then_drop 1
run_up
check "lost manifest response: re-attempt sees 412 → manifest exists" eq "$(rget "${D1%.sql.gz}" manifest)/$(rget "${D1%.sql.gz}" status)" exists/pending-audit
check "lost manifest response: manifest exists remotely once" eq "$(obj_code "$K1.manifest.json")" 200
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; fault POST multipart .manifest.json store_then_drop 2
run_up
check "manifest lost twice: pending-audit with manifest unknown" eq "$(rget "${D1%.sql.gz}" status)/$(rget "${D1%.sql.gz}" manifest)" pending-audit/unknown
clear_reqlog; run_up
check "unknown manifest re-probed next run → exists" eq "$(rget "${D1%.sql.gz}" manifest)/$(rget "${D1%.sql.gz}" last_reason)" exists/manifest-exists
check "re-probe made exactly one manifest request" eq "$(reqcount multipart .manifest.json)" 1
# crashes
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; fault POST multipart .sha256 hang_drop:4 1
run_up_killed 2
check "crash after dump step: killed" eq "$RCODE" 137
check "crash after dump step: receipt has dump=created" eq "$(rget "${D1%.sql.gz}" dump)" created
check "crash after dump step: .inprogress marker present" eq "$(ls "$RC"/*.inprogress | wc -l)" 1
check "crash after dump step: not uploaded" nothas "$(rget "${D1%.sql.gz}" status)" uploaded
sleep 3; clear_reqlog; run_up
check "resume after crash: uploaded" eq "$RCODE/$(rget "${D1%.sql.gz}" status)" 0/uploaded
check "resume after crash: reason marks the interruption" eq "$(rget "${D1%.sql.gz}" last_reason)" PASS:interrupted
check "resume after crash: dump not re-uploaded" eq "$(reqcount resumable_init "$D1")" 0
check "resume after crash: observation still validated (dump resource recorded)" eq "$(manifest_field "$K1.manifest.json" observation)" create-responses-validated
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; fault POST multipart .manifest.json hang_drop:4 1
run_up_killed 2; sleep 3; clear_reqlog; run_up
check "crash after sidecar step → resume creates only the manifest" eq "$(reqseq)" "multipart:$D1.manifest.json"
check "crash after sidecar step → uploaded" eq "$(rget "${D1%.sql.gz}" status)" uploaded
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; fault PUT "" "|data" store_then_hang:4 1
run_up_killed 2
check "crash inside the dump window: no receipt yet, marker present" eq "$( [ -e "$RC/${D1%.sql.gz}.receipt" ] && echo receipt || echo none)/$(ls "$RC"/*.inprogress | wc -l)" none/1
sleep 3; clear_reqlog; run_up
check "crash inside the dump window → 412 → pending-audit" eq "$(rget "${D1%.sql.gz}" status)/$(rget "${D1%.sql.gz}" dump)" pending-audit/exists
check "crash inside the dump window → interrupted noted" eq "$(rget "${D1%.sql.gz}" last_reason)" remote-audit-required:interrupted
# retry from every receipt state
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; fault POST multipart .sha256 status:429 10
run_up
check "429 exhausted: failed rate-limited, exit 1" eq "$RCODE/$(rget "${D1%.sql.gz}" status)/$(rget "${D1%.sql.gz}" last_reason)" 1/failed/sidecar-upload-failed:rate-limited
check "429 exhausted: bounded attempts (RETRY_MAX+1)" eq "$(reqcount multipart .sha256)" 4
check "429 exhausted: no manifest attempted" eq "$(reqcount multipart .manifest.json)" 0
ctl clear_faults >/dev/null; clear_reqlog; run_up
check "retry from failed: resumes with sidecar + manifest only" eq "$(reqseq)" "multipart:$D1.sha256 multipart:$D1.manifest.json"
check "retry from failed: uploaded" eq "$(rget "${D1%.sql.gz}" status)" uploaded
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; seed "$K1" "$BK/$D1"; fault POST multipart .manifest.json status:503 10
run_up
check "412 dump + manifest 5xx exhausted: exists-unverified, exit 3" eq "$RCODE/$(rget "${D1%.sql.gz}" status)" 3/exists-unverified
check "exists-unverified reason" has "$(rget "${D1%.sql.gz}" last_reason)" manifest-upload-failed:provider-5xx
ctl clear_faults >/dev/null; clear_reqlog; run_up
check "retry from exists-unverified: manifest created → pending-audit" eq "$(reqseq)/$(rget "${D1%.sql.gz}" status)" "multipart:$D1.manifest.json/pending-audit"
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; fault POST multipart .sha256 status:429 2
run_up
check "429 bounded backoff then success" eq "$RCODE/$(reqcount multipart .sha256)" 0/3
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; fault POST resumable "" status:503 1
run_up
check "transient 5xx on init recovers" eq "$RCODE/$(reqcount resumable_init "$D1")" 0/2
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; fault POST resumable "" status:403 5
run_up
check "permanent 403: failed, no retry" eq "$RCODE/$(reqcount resumable_init "$D1")" 1/1
check "permanent 403 reason" has "$(rget "${D1%.sql.gz}" last_reason)" "permanent-4xx code=403"
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; fault POST /v1/token "" status:500 10
run_up
check "token failure: exit 1" eq "$RCODE" 1
check "token failure: reason" has "$OUT" "token-failed:sts-unavailable"
check "token failure: no storage request" eq "$(reqseq)" ""
check "token failure: nothing created" eq "$(obj_code "$K1")" 404
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; chmod 644 "$T/subject.jwt"; run_up; chmod 600 "$T/subject.jwt"
check "world-readable subject token is refused" has "$OUT" "subject-token-mode"
# poisoned key
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; printf 'poison' >"$T/poison"; seed "$K1" "$T/poison" '{"sha256":"0000"}'
G="$(obj_field "$K1" generation)"; run_up
check "poisoned key: never overwritten" eq "$(obj_field "$K1" generation)/$(obj_content_sha "$K1")" "$G/$(sha256sum "$T/poison" | cut -c1-64)"
check "poisoned key: locally indistinguishable → pending-audit for the auditor" eq "$(rget "${D1%.sql.gz}" status)" pending-audit
check "poisoned key: no create without precondition, no forbidden call" eq "$(creates_without_precondition)/$(forbidden_calls)" 0/0
# concurrency
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; mkdir -p "$RC"; chmod 700 "$RC"
( exec 9>"$RC/.offhost.lock"; flock 9; sleep 3 ) & LOCKER=$!; sleep 0.5
run_up; wait "$LOCKER"
check "second uploader exits 75 while the lock is held" eq "$RCODE" 75
check "lock holder: nothing uploaded" eq "$(reqseq)" ""
check "receipt invariant holds after all scenarios" receipt_invariant
# missing current slot
reset_fs; mkdump "$D0" "$(ts '2026-09-27 03:15:02')"; ctl_reset; run_up
check "current slot missing: exit 1 with canonical-slot-backup-missing" eq "$RCODE/$(sumv current_slot_missing)" 1/1
check "previous slot still uploaded" eq "$(rget "${D0%.sql.gz}" status)" uploaded
reset_fs; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; ctl_reset; run_up
check "previous slot missing is reported but not fatal" eq "$RCODE/$(sumv slots_missing)" 0/1

# ── 5. monthly derivation ────────────────────────────────────────────────────
section "5. monthly copy"
reset_fs; ctl_reset; export OFFHOST_BACKFILL_SLOTS=7
DM1=leadcapture-20261001-031501.sql.gz; DM2=leadcapture-20261002-031501.sql.gz; KM="dev/postgres/monthly"
mkdump "$DM1" "$(ts '2026-10-01 03:15:02')"
OFFHOST_NOW="$(ts '2026-10-01 12:00:00')" run_up
check "day 1: daily uploaded, no monthly in the same run" eq "$(rget "${DM1%.sql.gz}" status)/$(sumv monthly)" uploaded/none
mkdump "$DM2" "$(ts '2026-10-02 03:15:02')"; clear_reqlog
OFFHOST_NOW="$(ts '2026-10-02 12:00:00')" run_up
check "day 2: monthly derived from day-1 set" eq "$(sumv monthly)/$(rget monthly-202610 status)" uploaded/uploaded
check "day 2: monthly objects exist" eq "$(obj_code "$KM/$DM1")/$(obj_code "$KM/$DM1.sha256")/$(obj_code "$KM/$DM1.manifest.json")" 200/200/200
check "monthly manifest kind and derived_from" eq "$(manifest_field "$KM/$DM1.manifest.json" kind)/$(manifest_field "$KM/$DM1.manifest.json" derived_from)" "monthly/$DM1"
check "monthly manifest created last" eq "$(reqseq | sed 's/.*multipart:'"$DM2"'.manifest.json //')" "resumable_init:$DM1 resumable_put:$DM1 multipart:$DM1.sha256 multipart:$DM1.manifest.json"
clear_reqlog; OFFHOST_NOW="$(ts '2026-10-03 12:00:00')" run_up
check "day 3: monthly not repeated" eq "$(reqseq)" ""
reset_fs; ctl_reset; mkdump "$DM1" "$(ts '2026-10-01 03:15:02')"; seed "$KM/$DM1" "$BK/$DM1" >/dev/null 2>&1 || true
ctl_reset; mkdump "$DM1" "$(ts '2026-10-01 03:15:02')"; seed "dev/postgres/daily/$DM1" "$BK/$DM1"
OFFHOST_NOW="$(ts '2026-10-01 12:00:00')" run_up
check "pending-audit daily set" eq "$(rget "${DM1%.sql.gz}" status)" pending-audit
mkdump "$DM2" "$(ts '2026-10-02 03:15:02')"; OFFHOST_NOW="$(ts '2026-10-02 12:00:00')" run_up
check "day 2: no monthly from a pending-audit set" eq "$(sumv monthly)" none
OFFHOST_NOW="$(ts '2026-10-03 12:00:00')" run_up
check "day 3: monthly derived from the first uploaded set instead" eq "$(manifest_field "$KM/$DM2.manifest.json" derived_from)" "$DM2"
check "receipt invariant holds (monthly)" receipt_invariant

# ── 6. receipt retention ─────────────────────────────────────────────────────
section "6. receipt retention"
reset_fs; ctl_reset; mkdump "$D1" "$(ts '2026-09-28 03:15:02')"; mkdir -p "$RC"; chmod 700 "$RC"
printf 'status=failed\n' >"$RC/leadcapture-20260701-031501.receipt"; printf 'status=failed\n' >"$RC/leadcapture-20260920-031501.receipt"
: >"$RC/leadcapture-20260701-031501.inprogress"; : >"$RC/crontab.before.old"; touch -d '2026-06-01' "$RC/crontab.before.old"; : >"$RC/crontab.before.new"
FP1="$(fp)"; run_up; FP2="$(fp)"
check "old receipt pruned" eq "$( [ -e "$RC/leadcapture-20260701-031501.receipt" ] && echo kept || echo pruned)" pruned
check "old marker pruned" eq "$( [ -e "$RC/leadcapture-20260701-031501.inprogress" ] && echo kept || echo pruned)" pruned
check "recent receipt kept" eq "$( [ -e "$RC/leadcapture-20260920-031501.receipt" ] && echo kept || echo pruned)" kept
check "old cron snapshot pruned, recent kept" eq "$( [ -e "$RC/crontab.before.old" ] && echo kept || echo pruned)/$( [ -e "$RC/crontab.before.new" ] && echo kept || echo pruned)" pruned/kept
check "retention never touches the backup directory" eq "$FP1" "$FP2"
check "retention log line" has "$OUT" "receipt retention: removed 3 file(s)"
OFFHOST_RECEIPT_DIR="$BK/receipts" run_up; check "receipt dir inside backup dir is refused" has "$OUT" "must not be the backup directory or inside it"

# ── 7. cron manager (stub crontab, file-based) ──────────────────────────────
section "7. cron manager"
STUB="$T/stub"; mkdir -p "$STUB"
cat >"$STUB/crontab" <<'EOF'
#!/bin/bash
# stub crontab for tests: -l lists, FILE installs, -r removes. CRONTAB_STORE = spool; CRONTAB_STUB_MODE = ok|reject|alter
store="${CRONTAB_STORE:?}"
case "${1:-}" in
  -l) if [ -e "$store" ]; then cat "$store"; else echo "no crontab for $(id -un)" >&2; exit 1; fi ;;
  -r) rm -f "$store" ;;
  *)  [ -f "${1:-}" ] || { echo "usage" >&2; exit 1; }
      case "${CRONTAB_STUB_MODE:-ok}" in
        reject) echo "crontab: errors in crontab file, can't install." >&2; exit 1 ;;
        alter)  if [ -e "$store.altered-once" ]; then cp "$1" "$store"; else { cat "$1"; echo "# altered by stub"; } >"$store"; : >"$store.altered-once"; fi ;;
        *)      cp "$1" "$store" ;;
      esac ;;
esac
EOF
chmod +x "$STUB/crontab"
SPOOL="$T/spool"; CRC="$T/cron-receipts"
# the manager derives the entry from its defaults and the receipt directory it is given
LINE="30 3 * * * OFFHOST_CONFIG=/opt/lead-capture-pro/env/offhost.env bash /opt/lead-capture-pro/app/docker/scripts/backup-offhost.sh >> $CRC/offhost.log 2>&1"
cron() { OUT="$(PATH="$STUB:$PATH" CRONTAB_STORE="$SPOOL" OFFHOST_RECEIPT_DIR="$CRC" CRONTAB_STUB_MODE="${MODE:-ok}" bash "$CRONMGR" "$1" 2>&1)"; RCODE=$?; printf '%s\n' "$OUT" >>"$ALLLOG"; }
strip_py() { python3 -c 'import sys
b="# BEGIN LCP OFFHOST BACKUP"; e="# END LCP OFFHOST BACKUP"; out=[]; skip=False
data=open(sys.argv[1],"rb").read().decode()
for line in data.splitlines(True):
    s=line.rstrip("\n")
    if s==b: skip=True; continue
    if s==e: skip=False; continue
    if not skip: out.append(line)
sys.stdout.write("".join(out))' "$1"; }
cron_case() {   # NAME EXPECT_NORMALIZED — installs, verifies, re-installs, removes, verifies
  local name="$1" norm="$2" orig
  orig="$T/orig.$name"
  cp "$SPOOL" "$orig" 2>/dev/null || : >"$orig"
  rm -rf "$CRC"; cron install
  check "[$name] install exits 0" eq "$RCODE" 0
  check "[$name] exactly one BEGIN/END/entry" eq "$(grep -cxF -- '# BEGIN LCP OFFHOST BACKUP' "$SPOOL")/$(grep -cxF -- '# END LCP OFFHOST BACKUP' "$SPOOL")/$(grep -cxF -- "$LINE" "$SPOOL")" 1/1/1
  check "[$name] unrelated bytes preserved after install" eq "$(strip_py "$SPOOL" | sha256sum | cut -c1-16)" "$( { cat "$orig"; [ "$norm" = 1 ] && printf '\n'; } | sha256sum | cut -c1-16)"
  check "[$name] block appended at the end" eq "$(tail -n 1 "$SPOOL")" '# END LCP OFFHOST BACKUP'
  check "[$name] snapshot saved with mode 600" eq "$(find "$CRC" -name 'crontab.before.*' -perm 600 | wc -l)" 1
  check "[$name] snapshot equals the original bytes" eq "$(cat "$CRC"/crontab.before.* | sha256sum | cut -c1-16)" "$(sha256sum "$orig" | cut -c1-16)"
  local after1; after1="$(sha256sum "$SPOOL" | cut -c1-16)"; cron install
  check "[$name] repeated install is idempotent" eq "$RCODE/$(sha256sum "$SPOOL" | cut -c1-16)" "0/$after1"
  check "[$name] repeated install reports no change" has "$OUT" "already in the desired state"
  cron status; check "[$name] status reports the block" has "$OUT" "managed_block=present entry_present=1"
  cron remove
  check "[$name] remove exits 0" eq "$RCODE" 0
  check "[$name] remove restores every unrelated byte" eq "$(sha256sum "$SPOOL" | cut -c1-16)" "$( { cat "$orig"; [ "$norm" = 1 ] && printf '\n'; } | sha256sum | cut -c1-16)"
  check "[$name] no marker left" eq "$(grep -c 'LCP OFFHOST' "$SPOOL")" 0
}
printf 'MAILTO=ops\n1 2 * * * echo a' >"$SPOOL"; cron_case no-final-newline 1
check "[no-final-newline] normalization reported" eq "$(grep -c 'final_newline_normalized=1' "$ALLLOG")" 1
printf 'MAILTO=ops\n1 2 * * * echo a\n' >"$SPOOL"; cron_case one-final-newline 0
printf '\n\n1 2 * * * echo a\n\n\n\n' >"$SPOOL"; cron_case multiple-blank-lines 0
printf '1\t2 * * *\techo "a  b"   \n\t\n  # indented comment \t\n' >"$SPOOL"; cron_case tabs-and-trailing-spaces 0
printf '# backup related comment\n15 3 * * * DEPLOY_PATH=/opt/lead-capture-pro/app BACKUP_DIR=/opt/lead-capture-pro/backups/postgres KEEP=14 bash /opt/lead-capture-pro/app/docker/scripts/backup-postgres.sh >> /opt/lead-capture-pro/backups/postgres/backup.log 2>&1\n45 3 * * * BACKUP_DIR=/opt/lead-capture-pro/backups/postgres BACKUP_MAX_AGE_HOURS=4 bash /opt/lead-capture-pro/app/docker/scripts/backup-check.sh >> /opt/lead-capture-pro/backups/postgres/backup.log 2>&1\n0 4 * * * echo backup-something-else\n' >"$SPOOL"; cron_case comments-and-backup-lines 0
check "[comments-and-backup-lines] existing backup lines untouched" eq "$(grep -c 'backup-postgres.sh\|backup-check.sh' "$SPOOL")" 2
: >"$SPOOL"; cron_case empty-crontab 0
rm -f "$SPOOL"; rm -rf "$CRC"; cron status
check "[missing-crontab] status works without a crontab" has "$OUT" "had_crontab=0"
cron install; check "[missing-crontab] install creates the block only" eq "$RCODE/$(sha256sum "$SPOOL" | cut -c1-16)" "0/$(printf '%s\n%s\n%s\n' '# BEGIN LCP OFFHOST BACKUP' "$LINE" '# END LCP OFFHOST BACKUP' | sha256sum | cut -c1-16)"
cron remove; check "[missing-crontab] remove leaves an empty crontab" eq "$RCODE/$(wc -c <"$SPOOL")" 0/0
printf '1 2 * * * echo a\n# BEGIN LCP OFFHOST BACKUP\n%s\n' "$LINE" >"$SPOOL"; B="$(sha256sum "$SPOOL")"; cron install
check "[corrupted-block] install aborts" eq "$RCODE" 1
check "[corrupted-block] crontab untouched" eq "$(sha256sum "$SPOOL")" "$B"
check "[corrupted-block] message" has "$OUT" "corrupted or duplicated managed block"
cron remove; check "[corrupted-block] remove aborts too" eq "$RCODE/$(sha256sum "$SPOOL")" "1/$B"
printf '# BEGIN LCP OFFHOST BACKUP\n%s\n# END LCP OFFHOST BACKUP\n1 2 * * * echo a\n# BEGIN LCP OFFHOST BACKUP\n%s\n# END LCP OFFHOST BACKUP\n' "$LINE" "$LINE" >"$SPOOL"; B="$(sha256sum "$SPOOL")"; cron install
check "[duplicate-block] install aborts, crontab untouched" eq "$RCODE/$(sha256sum "$SPOOL")" "1/$B"
printf '1 2 * * * echo a\n' >"$SPOOL"; B="$(sha256sum "$SPOOL")"; MODE=reject cron install
check "[install-failure] crontab rejected → exit 1, crontab untouched" eq "$RCODE/$(sha256sum "$SPOOL")" "1/$B"
check "[install-failure] message" has "$OUT" "crontab rejected the candidate"
rm -f "$SPOOL.altered-once"; printf '1 2 * * * echo a\n' >"$SPOOL"; B="$(sha256sum "$SPOOL")"; MODE=alter cron install
check "[post-install-failure] exit 1" eq "$RCODE" 1
check "[post-install-failure] rollback restored the original byte-for-byte" eq "$(sha256sum "$SPOOL")" "$B"
check "[post-install-failure] rollback verified message" has "$OUT" "restored and verified byte-for-byte"
check "[post-install-failure] cause reported" has "$OUT" "installed crontab differs from the validated candidate"
OFFHOST_CRON_LINE='0 4 * * * bash x' cron status 2>/dev/null; cron() { OUT="$(PATH="$STUB:$PATH" CRONTAB_STORE="$SPOOL" OFFHOST_RECEIPT_DIR="$CRC" CRONTAB_STUB_MODE="${MODE:-ok}" bash "$CRONMGR" "$1" 2>&1)"; RCODE=$?; printf '%s\n' "$OUT" >>"$ALLLOG"; }
OUT="$(PATH="$STUB:$PATH" CRONTAB_STORE="$SPOOL" OFFHOST_RECEIPT_DIR="$CRC" OFFHOST_CRON_LINE='0 4 * * * bash x' bash "$CRONMGR" status 2>&1)"; RCODE=$?
check "[schedule-guard] an entry not at 03:30 UTC is refused" eq "$RCODE" 1
check "[static] cron manager never keeps the crontab in a shell variable" eq "$(grep -cE '\$\(crontab -l' "$CRONMGR")" 0
check "[static] cron manager compares with cmp -s" eq "$(grep -c 'cmp -s' "$CRONMGR" | awk '{print ($1 >= 3) ? "yes" : "no"}')" yes
check "[static] cron manager matches markers as whole fixed lines" eq "$(grep -c 'grep -cxF' "$CRONMGR" | awk '{print ($1 >= 1) ? "yes" : "no"}')" yes
check "[static] cron manager never matches the bare word backup" eq "$(grep -cE "grep[^|]*'backup'" "$CRONMGR")" 0

# ── 8. static security checks ────────────────────────────────────────────────
section "8. static security"
check "[static] no service-account key material" eq "$(grep -cE 'private_key|BEGIN (RSA |EC )?PRIVATE KEY|client_secret' "$UP" "$CRONMGR" "$HERE/../../offhost.env.example" | awk -F: '{s+=$2} END{print s+0}')" 0
check "[static] no objectListPrefix IAM design" eq "$(grep -c 'objectListPrefix' "$UP" "$CRONMGR" "$HERE/../../offhost.env.example" | awk -F: '{s+=$2} END{print s+0}')" 0
check "[static] uploader never downloads (alt=media)" eq "$(grep -c 'alt=media' "$UP")" 0
check "[static] uploader never deletes, patches or gets objects" eq "$(grep -cE '\-X (DELETE|PATCH|GET)' "$UP")" 0
check "[static] every upload URL carries ifGenerationMatch=0" eq "$(grep -c 'uploadType=' "$UP")" "$(grep -c 'uploadType=[a-z]*&ifGenerationMatch=0' "$UP")"
check "[static] no destructive command targets the backup directory" eq "$(grep -nE '(rm |mv |truncate|-delete|> *"?\$BACKUP_DIR)' "$UP" | grep -c 'BACKUP_DIR')" 0
check "[static] receipt writes are temporary file + mv" eq "$(grep -c 'mv -f "\$tmp" "\$f"' "$UP")" 1
check "[static] no set -x / token echo" eq "$(grep -cE 'set -x|echo .*\$tok' "$UP")" 0
check "[static] region fixed to me-central2" eq "$(grep -c 'OFFHOST_REGION must be me-central2' "$UP")/$(grep -c '^OFFHOST_REGION=me-central2' "$HERE/../../offhost.env.example")" 1/1
check "[static] manifest schema constant" eq "$(grep -c 'MANIFEST_SCHEMA="lcp-offhost-manifest/2"' "$UP")" 1
check "[static] read_write scope default (no write_only dependency)" eq "$(grep -c 'devstorage.read_write' "$UP")/$(grep -c 'write_only' "$UP")" 1/0
check "[static] no embedded credential in the example config" eq "$(grep -cE '^OFFHOST_[A-Z_]*(KEY|SECRET|TOKEN)=' "$HERE/../../offhost.env.example" | awk '{print $1+0}')" 0
check "[static] resumable session URI never persisted" eq "$(grep -cE 'session[^ ]*>' "$UP")" 0
if command -v git >/dev/null 2>&1 && git -C "$HERE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  check "[static] backup-postgres.sh unchanged (blob 2ba639bd…)" eq "$(git -C "$HERE" hash-object "$HERE/../backup-postgres.sh")" 2ba639bd59bcc3163b9c9776d1ee8ca2cdf80563
  check "[static] backup-check.sh unchanged (blob 2bd14bfd…)" eq "$(git -C "$HERE" hash-object "$HERE/../backup-check.sh")" 2bd14bfdfb35d4812195b2203a9c78c4300ec5aa
fi
check "[secrets] no access token in any captured output" eq "$(grep -c 'SECRETTOKEN' "$ALLLOG")" 0
check "[secrets] no subject token in any captured output" eq "$(grep -c -- "$SUBJECT_MARK" "$ALLLOG")" 0
check "[secrets] no token in receipts" eq "$(grep -rc 'SECRETTOKEN' "$RC" "$T/cron-receipts" 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')" 0
check "[secrets] no token in remote manifests" eq "$(curl -sS -X POST "$EP/__control/objects" -H 'Content-Type: application/json' --data-binary '{}' | grep -c 'SECRETTOKEN')" 0

echo "RESULT: pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
