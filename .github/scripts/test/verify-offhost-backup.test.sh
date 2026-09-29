#!/bin/bash
# =============================================================================
# Deterministic harness for the off-host backup workflow (B23 G-6D, Correction 1):
#   .github/workflows/backup-offhost.yml            upload → audit → alert
#   .github/scripts/offhost-upload-runner.sh        runner side of the keyless upload
#   .github/scripts/offhost-upload-remote.sh        VPS side (token file in /dev/shm)
#   .github/scripts/verify-offhost-backup.sh        list-only auditor
#   .github/scripts/offhost-alert-decision.sh       issue truth table
#   .github/scripts/offhost-wif-policy.py           WIF trust contract evaluator
# =============================================================================
# Local and fake only: a Python fake of Cloud Storage JSON API + STS + the GitHub
# OIDC endpoint (fake-gcs.py) with fault injection, seeded three-object sets
# (seed-offhost-set.py), a controlled clock, a stub `ssh` that executes the
# remote command locally against a fake VPS checkout with a fake /dev/shm, and
# a stub deployed uploader that records how it was invoked. No provider, no
# credential, no network beyond 127.0.0.1. The fake OIDC/STS tokens carry a
# distinctive marker that must never appear in any output or artifact.
#
# Run:  bash .github/scripts/test/verify-offhost-backup.test.sh
# Requirements: bash, python3 (PyYAML for the workflow parse), curl, git, timeout.
# =============================================================================
set -uo pipefail
export PYTHONDONTWRITEBYTECODE=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUD="${OFFHOST_TEST_AUDITOR:-$HERE/../verify-offhost-backup.sh}"
RUNNER="$HERE/../offhost-upload-runner.sh"; REMOTE="$HERE/../offhost-upload-remote.sh"
DECIDE="$HERE/../offhost-alert-decision.sh"; POLICY="$HERE/../offhost-wif-policy.py"
WF="${OFFHOST_TEST_WORKFLOW:-$HERE/../../workflows/backup-offhost.yml}"
CONTRACT="$HERE/../../wif/offhost-trust-contract.md"
FAKE="$HERE/fake-gcs.py"; SEED="$HERE/seed-offhost-set.py"
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*" >&2; }
check() { local d="$1"; shift; if "$@"; then pass; else fail "$d"; fi; }
eq() { [ "$1" = "$2" ]; }
has() { [[ "$1" == *"$2"* ]]; }
nothas() { [[ "$1" != *"$2"* ]]; }
section() { echo "--- $*"; }
unset AWS_SECRET_ACCESS_KEY AWS_ACCESS_KEY_ID GOOGLE_APPLICATION_CREDENTIALS CLOUDSDK_CONFIG GITHUB_OUTPUT GITHUB_ACTIONS 2>/dev/null || true
T="$(mktemp -d)"; FAKE_PID=
cleanup() { [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
ALLLOG="$T/all.log"; : >"$ALLLOG"
WARNLOG="$T/warnings.log"; : >"$WARNLOG"

# ── 1. syntax and workflow statics ───────────────────────────────────────────
section "1. syntax and workflow statics"
for f in "$AUD" "$RUNNER" "$DECIDE"; do check "$(basename "$f") parses" bash -n "$f"; done
check "remote script parses (as bash -c text)" bash -n "$REMOTE"
for f in "$FAKE" "$SEED" "$POLICY"; do check "$(basename "$f") parses" python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$f"; done
check "old single-purpose workflow removed" eq "$( [ -e "$HERE/../../workflows/backup-offhost-alert.yml" ] && echo present || echo absent)" absent
WFJ="$T/wf.json"
if python3 -c 'import yaml' 2>/dev/null; then
  python3 -c 'import yaml, json, sys; json.dump(yaml.safe_load(open(sys.argv[1])), open(sys.argv[2], "w"))' "$WF" "$WFJ"
  check "workflow YAML parses" eq "$?" 0
  wf() { python3 -c "import json,sys; d=json.load(open(sys.argv[1]))
v=d
for p in sys.argv[2].split('.'):
    v = v[int(p)] if isinstance(v, list) else v.get(p)
print(json.dumps(v) if isinstance(v,(dict,list)) else v)" "$WFJ" "$1" 2>/dev/null; }
  check "workflow name backup-offhost" eq "$(wf name)" backup-offhost
  check "one schedule 0 5 * * *" eq "$(wf 'true.schedule.0.cron')/$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["true"]["schedule"]))' "$WFJ")" "0 5 * * */1"
  check "dispatchable with simulate_failure" eq "$(wf 'true.workflow_dispatch.inputs.simulate_failure.type')" boolean
  check "top-level permissions contents read only" eq "$(wf permissions)" '{"contents": "read"}'
  check "concurrency group backup-offhost, no cancel" eq "$(wf concurrency.group)/$(wf concurrency.cancel-in-progress)" "backup-offhost/False"
  check "exactly three jobs upload, audit, alert" eq "$(python3 -c 'import json,sys; print(list(json.load(open(sys.argv[1]))["jobs"]))' "$WFJ")" "['upload', 'audit', 'alert']"
  check "upload: environment offhost-upload" eq "$(wf jobs.upload.environment)" offhost-upload
  check "upload: permissions contents read + id-token write" eq "$(wf jobs.upload.permissions)" '{"contents": "read", "id-token": "write"}'
  check "audit: environment offhost-audit" eq "$(wf jobs.audit.environment)" offhost-audit
  check "audit: permissions contents read + id-token write" eq "$(wf jobs.audit.permissions)" '{"contents": "read", "id-token": "write"}'
  check "audit: needs upload, always()" eq "$(wf jobs.audit.needs)/$(wf jobs.audit.if)" "upload/always()"
  check "alert: needs upload+audit, always()" eq "$(wf jobs.alert.needs)/$(wf jobs.alert.if)" '["upload", "audit"]/always()'
  check "alert: permissions issues write only" eq "$(wf jobs.alert.permissions)" '{"issues": "write"}'
  check "alert: no environment (no OIDC needed)" eq "$(wf jobs.alert.environment)" None
  audit_steps="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("\n".join(str(s) for s in d["jobs"]["audit"]["steps"]))' "$WFJ")"
  check "audit job has no SSH" eq "$(printf '%s' "$audit_steps" | grep -cE '\bssh\b')" 0
  upload_steps="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("\n".join(str(s) for s in d["jobs"]["upload"]["steps"]))' "$WFJ")"
  check "upload job pins the host key (StrictHostKeyChecking yes, IdentitiesOnly yes, BatchMode yes)" eq "$(printf '%s' "$upload_steps" | grep -c 'StrictHostKeyChecking yes')/$(printf '%s' "$upload_steps" | grep -c 'IdentitiesOnly yes')/$(printf '%s' "$upload_steps" | grep -c 'BatchMode yes')" 1/1/1
  check "upload job never uses ssh-keyscan" eq "$(printf '%s' "$upload_steps" | grep -c 'ssh-keyscan ')" 0
  check "upload job checks out only the two upload scripts" eq "$(printf '%s' "$upload_steps" | grep -o 'offhost-upload-[a-z]*\.sh' | sort -u | tr '\n' ' ')" "offhost-upload-remote.sh offhost-upload-runner.sh "
  check "upload job bounds SSH to 240 s" eq "$(printf '%s' "$upload_steps" | grep -c "OFFHOST_SSH_TIMEOUT': '240'")" 1
else
  echo "note: PyYAML absent — structural YAML checks skipped"
fi
check "workflow issue title" eq "$(grep -c 'ALERT_TITLE: "\[Backup Alert\] Off-host backup copy unhealthy"' "$WF")" 1
check "workflow secrets ⊆ VPS_* + OFFHOST_BUCKET + audiences" eq "$(grep -oE 'secrets\.[A-Z_]+' "$WF" | sort -u | tr '\n' ' ')" "secrets.OFFHOST_BUCKET secrets.OFFHOST_WIF_AUDIENCE_AUDIT secrets.OFFHOST_WIF_AUDIENCE_UPLOAD secrets.VPS_DEPLOY_PATH secrets.VPS_HOST secrets.VPS_KNOWN_HOSTS secrets.VPS_PORT secrets.VPS_SSH_KEY secrets.VPS_USER "
check "workflow has no deploy, backup, restore, database or cron command" eq "$(grep -cE '\b(scp|rsync|sftp|pg_dump|pg_restore|psql|dropdb|createdb|deploy-vps|backup-postgres|crontab)\b' "$WF")" 0
check "workflow stores no key or token" eq "$(grep -ciE 'GOOGLE_APPLICATION_CREDENTIALS|service_account_key|credentials_json|private_key|access_token' "$WF")" 0
check "every checkout has persist-credentials false" eq "$(grep -c 'persist-credentials: false' "$WF")/$(grep -c 'uses: actions/checkout@v4' "$WF")" 3/3
SUMMARY_RE="$(grep -oE "\^OFFHOST_HEALTH=[^']+" "$WF" | head -n 1 | sed "s/'.*//")"
check "workflow summary regex extracted" has "$SUMMARY_RE" 'OFFHOST_HEALTH=(PASS|FAIL)'

# ── fake provider ────────────────────────────────────────────────────────────
mkdir -p "$T/state"; python3 -W error::DeprecationWarning "$FAKE" 0 "$T/state" 2>>"$WARNLOG" & FAKE_PID=$!
for _ in $(seq 1 50); do [ -s "$T/state/port" ] && break; sleep 0.1; done
[ -s "$T/state/port" ] || { echo "fake provider did not start" >&2; exit 1; }
EP="http://127.0.0.1:$(cat "$T/state/port")"
ctl() { curl -sS -X POST "$EP/__control/$1" -H 'Content-Type: application/json' --data-binary "${2:-{\}}"; }
ctl_reset() { ctl reset >/dev/null; }
fault() { ctl fault "$(python3 -c 'import json,sys
a=sys.argv[1:]; m={}
if a[0]: m["method"]=a[0]
if a[1]: m["path_contains"]=a[1]
print(json.dumps({"match":m,"action":a[2],"times":int(a[3])}))' "$@")" >/dev/null; }
reqlog() { curl -sS "$EP/__control/reqlog"; }
clear_reqlog() { ctl clear_reqlog >/dev/null; }
kinds() { reqlog | python3 -c 'import json,sys; print(" ".join(sorted(set(r.get("kind","?") for r in json.load(sys.stdin)))))'; }
listcalls() { reqlog | python3 -c 'import json,sys; rs=[r for r in json.load(sys.stdin) if r.get("kind")=="list"]; print(len(rs), sum(1 for r in rs if r.get("prefix")=="dev/postgres/"), sum(1 for r in rs if r.get("fields")), sum(1 for r in rs if r.get("versions")))'; }
forbidden() { reqlog | python3 -c 'import json,sys; print(sum(1 for r in json.load(sys.stdin) if r.get("kind")=="forbidden"))'; }
seedset() { python3 -W error::DeprecationWarning "$SEED" "$EP" "$@" >/dev/null 2>>"$WARNLOG"; }
seedraw() {   # KEY CONTENT [METADATA_JSON]
  python3 - "$EP" "$1" "$2" "${3:-{\}}" <<'PY'
import base64, json, sys, urllib.request
ep, key, content, meta = sys.argv[1:]
body = json.dumps({"key": key, "content_b64": base64.b64encode(content.encode()).decode(), "metadata": json.loads(meta)}).encode()
urllib.request.urlopen(urllib.request.Request(ep + "/__control/seed", data=body, headers={"Content-Type": "application/json"})).read()
PY
}
export OFFHOST_TEST_ALLOW_INSECURE_LOOPBACK=1
export OFFHOST_BUCKET=lcp-test-audit-bucket OFFHOST_WIF_AUDIENCE=//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/lcp-github/providers/github-oidc
export OFFHOST_STORAGE_ENDPOINT="$EP" OFFHOST_STS_ENDPOINT="$EP/v1/token" OFFHOST_IAMCREDENTIALS_ENDPOINT="$EP"
export ACTIONS_ID_TOKEN_REQUEST_URL="$EP/__control/oidc?x=1" ACTIONS_ID_TOKEN_REQUEST_TOKEN=dummy-oidc-request-bearer OFFHOST_RETRY_BASE_SECONDS=0
export OFFHOST_NOW="$(date -u -d '2026-09-28 05:10:00' +%s)"
OUT=""; RCODE=0; SUM=""
run_audit() { OUT="$(bash "$AUD" 2>&1)"; RCODE=$?; printf '%s\n' "$OUT" >>"$ALLLOG"; SUM="$(printf '%s\n' "$OUT" | grep -m1 '^OFFHOST_HEALTH=' || true)"; }
sumv() { printf '%s\n' "$SUM" | awk -v k="$1" '{ for (i = 1; i <= NF; i++) if (split($i, a, "=") == 2 && a[1] == k) print a[2] }'; }
regex_ok() { [[ "$SUM" =~ $SUMMARY_RE ]]; }
S28=leadcapture-20260928-031501.sql.gz; S27=leadcapture-20260927-031501.sql.gz; S26=leadcapture-20260926-031501.sql.gz; S25=leadcapture-20260925-031501.sql.gz
seed_window() { seedset "$S28"; seedset "$S27" gen=1700000000090000 t0=2026-09-27T03:30:10.000Z; seedset "$S26" gen=1700000000080000 t0=2026-09-26T03:30:10.000Z; }

# ── 2. auditor verdicts ──────────────────────────────────────────────────────
section "2. auditor verdicts"
ctl_reset; run_audit
check "empty bucket: FAIL canonical-slot-backup-missing" eq "$RCODE/$(sumv reason)" 1/canonical-slot-backup-missing
check "empty bucket: expected slot named" eq "$(sumv slot)" 20260928-0315
check "empty bucket: summary matches the workflow regex" regex_ok
ctl_reset; seed_window; run_audit
check "fully observed window: PASS" eq "$RCODE" 0
check "fully observed: result category" eq "$(sumv result)" uploaded-local-and-remote-verified
check "fully observed: window 3/3, no historical" eq "$(sumv window_ok)/$(sumv historical_unresolved)" 3/3/0
check "fully observed: hash prefix length 12" eq "$(sumv sha256_prefix | awk '{print length($0)}')" 12
check "fully observed: summary matches regex" regex_ok
check "list-only: request kinds are oidc, sts and list only" eq "$(kinds)" "list oidc sts"
check "list-only: two lists (plain + versions), explicit prefix and fields" eq "$(listcalls)" "2 2 2 1"
check "list-only: no get/download/create/update/delete" eq "$(forbidden)" 0
check "output never contains a token" nothas "$OUT" SECRETTOKEN
check "output never contains the OIDC request bearer" nothas "$OUT" dummy-oidc-request-bearer
check "output never contains the bucket name" nothas "$OUT" lcp-test-audit-bucket
check "output never contains the audience" nothas "$OUT" workloadIdentityPools
clear_reqlog; run_audit
check "re-validation is stateless and repeatable" eq "$RCODE/$(sumv result)" 0/uploaded-local-and-remote-verified
OFFHOST_LOCAL_RECEIPT_STATUS=pending-audit run_audit
check "remote-valid set resolves a local pending-audit receipt (informational only)" eq "$RCODE/$(sumv local_receipt)" 0/pending-audit
ctl_reset; seedset "$S28" observation=remote-audit-required null_generations=1; seedset "$S27" gen=1700000000090000 t0=2026-09-27T03:30:10.000Z; seedset "$S26" gen=1700000000080000 t0=2026-09-26T03:30:10.000Z; run_audit
check "audit-required set with null generations → remote-resolved" eq "$RCODE/$(sumv result)" 0/remote-resolved
mismatch_case() {   # DESC EXPECTED_DETAIL seeder-options…
  local d="$1" want="$2"; shift 2
  ctl_reset; seedset "$S28" "$@"; seedset "$S27" gen=1700000000090000 t0=2026-09-27T03:30:10.000Z; seedset "$S26" gen=1700000000080000 t0=2026-09-26T03:30:10.000Z; run_audit
  check "$d: FAIL remote-metadata-mismatch" eq "$RCODE/$(sumv reason)" 1/remote-metadata-mismatch
  check "$d: detail=$want" eq "$(sumv detail)" "$want"
}
mismatch_case "size mismatch" size bad_size=1
mismatch_case "md5 mismatch" md5 bad_md5=1
mismatch_case "sha256 mismatch" sha256 bad_sha256=1
mismatch_case "missing sha256 metadata" sha256 missing_sha256=1
mismatch_case "generation mismatch" dump-generation bad_generation=1
mismatch_case "key mismatch" key bad_key=1
mismatch_case "manifest schema mismatch" manifest-schema bad_schema=1
mismatch_case "foreign manifest" manifest-schema foreign_manifest=1
mismatch_case "manifest earlier than its objects" manifest-before-object manifest_earlier=1
mismatch_case "duplicate live generation" duplicate-live-generation duplicate_live=1
ctl_reset; seedset "$S28" dt_sidecar=0 dt_manifest=0; seedset "$S27" gen=1700000000090000 t0=2026-09-27T03:30:10.000Z; seedset "$S26" gen=1700000000080000 t0=2026-09-26T03:30:10.000Z; run_audit
check "equal timestamps are valid" eq "$RCODE/$(sumv result)" 0/uploaded-local-and-remote-verified
ctl_reset; seed_window; seedset leadcapture-20260928-100000.sql.gz gen=1700000000200000 t0=2026-09-28T10:30:10.000Z; run_audit
check "duplicate completed canonical sets in one slot fail" eq "$RCODE/$(sumv detail)" 1/duplicate-canonical-set
ctl_reset; seedset "$S28" no_manifest=1; seedset "$S27" gen=1700000000090000 t0=2026-09-27T03:30:10.000Z; seedset "$S26" gen=1700000000080000 t0=2026-09-26T03:30:10.000Z; run_audit
check "current slot without manifest: partial-remote-set" eq "$RCODE/$(sumv reason)/$(sumv detail)" 1/partial-remote-set/missing-manifest
ctl_reset; seedset "$S28"; seedset "$S27" gen=1700000000090000 t0=2026-09-27T03:30:10.000Z no_manifest=1; seedset "$S26" gen=1700000000080000 t0=2026-09-26T03:30:10.000Z; run_audit
check "partial set in a previous window slot blocks" eq "$RCODE/$(sumv reason)/$(sumv slot)" 1/partial-remote-set/20260927-0315
ctl_reset; seed_window; seedset "$S25" gen=1700000000070000 t0=2026-09-25T03:30:10.000Z no_manifest=1; run_audit
check "historical unresolved set (outside window) does not block" eq "$RCODE/$(sumv historical_unresolved)" 0/1
ctl_reset; seed_window; seedraw dev/postgres/daily/notes.txt "x"; run_audit
check "unexpected object under daily/ fails" eq "$RCODE/$(sumv detail)" 1/unexpected-object
ctl_reset; seed_window; seedraw dev/postgres/manual/20260928/leadcapture-20260928-120000.sql.gz "x"; run_audit
check "objects under manual/ are ignored" eq "$RCODE" 0
ctl_reset; seed_window; run_audit
check "day 28 without monthly: warning only, still PASS" eq "$RCODE/$(sumv monthly)" 0/missing
seedset "$S26" kind=monthly derived_from="$S26" gen=1700000000300000 t0=2026-09-27T03:31:00.000Z; run_audit
check "valid monthly set → monthly=ok" eq "$RCODE/$(sumv monthly)" 0/ok
ctl_reset; seedset leadcapture-20260903-031501.sql.gz t0=2026-09-03T03:30:10.000Z; seedset leadcapture-20260902-031501.sql.gz gen=1700000000090000 t0=2026-09-02T03:30:10.000Z; seedset leadcapture-20260901-031501.sql.gz gen=1700000000080000 t0=2026-09-01T03:30:10.000Z
OFFHOST_NOW="$(date -u -d '2026-09-03 05:10:00' +%s)" run_audit
check "before day 8 the monthly copy is not due" eq "$RCODE/$(sumv monthly)" 0/not-due

# ── 3. auditor unavailability and HTTPS enforcement ──────────────────────────
section "3. unavailability / HTTPS"
ctl_reset; seed_window; fault POST /v1/token status:500 10; run_audit
check "STS failure → remote-audit-unavailable" eq "$RCODE/$(sumv reason)/$(sumv detail)" 1/remote-audit-unavailable/sts-http-500
ctl_reset; seed_window; fault POST /v1/token status:400 10; run_audit
check "STS rejection (WIF condition) → remote-audit-unavailable" eq "$RCODE/$(sumv detail)" 1/sts-http-400
ctl_reset; seed_window; fault GET /storage/v1/b status:500 10; run_audit
check "list failure → remote-audit-unavailable" eq "$RCODE/$(sumv detail)" 1/list-http-500
ctl_reset; seed_window; fault GET /storage/v1/b status:503 1; clear_reqlog; run_audit
check "transient list failure is retried" eq "$RCODE/$(listcalls | cut -d' ' -f1)" 0/3
ctl_reset; seed_window; ACTIONS_ID_TOKEN_REQUEST_URL="$EP/__control/nope?x=1" run_audit
check "OIDC endpoint failure → remote-audit-unavailable" eq "$RCODE/$(sumv detail)" 1/oidc-http-404
ACTIONS_ID_TOKEN_REQUEST_URL= run_audit
check "missing OIDC context → remote-audit-unavailable" eq "$RCODE/$(sumv detail)" 1/no-oidc-request-context
OFFHOST_IMPERSONATE_SA=lcp-backup-auditor@lcp-test.iam.gserviceaccount.com run_audit
check "impersonation fallback works" eq "$RCODE" 0
OFFHOST_BUCKET="Bad Bucket" run_audit; check "bad bucket format refused" eq "$RCODE/$(sumv reason)" 1/configuration
clear_reqlog; OFFHOST_TEST_ALLOW_INSECURE_LOOPBACK=0 run_audit
check "[https] without the flag the http:// fake is refused before any request" eq "$RCODE/$(sumv detail)/$(kinds)" "1/storage-endpoint-must-use-https/"
OFFHOST_STORAGE_ENDPOINT="http://storage.example.invalid" run_audit
check "[https] non-loopback http:// storage endpoint refused even with the flag" eq "$RCODE/$(sumv detail)" 1/storage-endpoint-http-only-loopback
OFFHOST_STS_ENDPOINT="http://sts.example.invalid/v1/token" run_audit
check "[https] non-loopback http:// STS endpoint refused" eq "$RCODE/$(sumv detail)" 1/sts-endpoint-http-only-loopback
ACTIONS_ID_TOKEN_REQUEST_URL="http://oidc.example.invalid/token" run_audit
check "[https] non-loopback http:// OIDC request URL refused" eq "$RCODE/$(sumv detail)" 1/oidc-request-url-http-only-loopback
check "[https] no token was requested during the refusals" eq "$(kinds)" ""
ctl_reset; seed_window; clear_reqlog; run_audit; check "[https] loopback accepted under the flag" eq "$RCODE" 0

# ── 4. OIDC delivery: runner + remote against a fake VPS ─────────────────────
section "4. OIDC delivery (runner → stub ssh → remote script → stub uploader)"
VPS="$T/vps"; APP="$VPS/app"; SHM="$T/shm"; STUB="$T/stub"; REC="$T/record"; MODE_FILE="$T/mode"
mkdir -p "$APP/docker/scripts" "$VPS/env" "$SHM" "$STUB"; chmod 700 "$SHM"
cat >"$APP/docker/scripts/backup-offhost.sh" <<'EOF'
#!/bin/bash
# stub deployed uploader (tests): records how it was invoked, never uploads
rec="${STUB_RECORD:?}"
{
  echo "token_file=$OFFHOST_SUBJECT_TOKEN_FILE"
  echo "token_dir=$(dirname "$OFFHOST_SUBJECT_TOKEN_FILE")"
  echo "token_mode=$(stat -c %a "$OFFHOST_SUBJECT_TOKEN_FILE" 2>/dev/null || echo missing)"
  echo "token_sha256=$(sha256sum "$OFFHOST_SUBJECT_TOKEN_FILE" 2>/dev/null | cut -c1-64)"
  echo "token_symlink=$( [ -L "$OFFHOST_SUBJECT_TOKEN_FILE" ] && echo yes || echo no)"
  echo "config=$OFFHOST_CONFIG"
  echo "max_time=$OFFHOST_MAX_TIME"
  echo "argv=$*"
} >"$rec"
echo "DUMP-BYTES-MARKER-must-never-reach-the-runner" >/dev/null
case "$(cat "${STUB_MODE_FILE:-/dev/null}" 2>/dev/null)" in
  fail)      echo "OFFHOST_UPLOAD=FAIL uploaded=0 failed=1"; exit 1 ;;
  ambiguous) echo "OFFHOST_UPLOAD=AMBIGUOUS uploaded=0 pending_audit=1 failed=0"; exit 3 ;;
  hang)      sleep 30; exit 1 ;;
  *)         echo "OFFHOST_UPLOAD=PASS uploaded=1 pending_audit=0 failed=0"; exit 0 ;;
esac
EOF
chmod +x "$APP/docker/scripts/backup-offhost.sh"
( cd "$APP" && git init -q && git add . && git -c user.name=t -c user.email=t@t commit -q -m stub && git rev-parse HEAD >"$VPS/env/current-deploy.sha" )
printf 'OFFHOST_BUCKET=lcp-test-bucket\n' >"$VPS/env/offhost.env"; chmod 600 "$VPS/env/offhost.env"
cat >"$STUB/ssh" <<'EOF'
#!/bin/bash
# stub ssh (tests): `ssh <target> "<command>"` → runs the command locally with the same stdin; records argv
printf '%s\n' "$@" >>"${STUB_SSH_ARGV:?}"
date +%s.%N >>"${STUB_SSH_TIMES:?}"
case "${STUB_SSH_MODE:-ok}" in
  refuse) echo "ssh: connect to host stub port 22: Connection timed out" >&2; exit 255 ;;
esac
exec bash -c "$2"
EOF
chmod +x "$STUB/ssh"
export STUB_RECORD="$REC" STUB_MODE_FILE="$MODE_FILE" STUB_SSH_ARGV="$T/ssh.argv" STUB_SSH_TIMES="$T/ssh.times"
run_runner() {   # [env overrides via caller]
  rm -f "$REC" "$T/ssh.argv" "$T/ssh.times"; : >"$T/upload.log"
  OUT="$(OFFHOST_SSH_BIN="$STUB/ssh" OFFHOST_SSH_TARGET=vps OFFHOST_REMOTE_SCRIPT="$REMOTE" OFFHOST_SHM_DIR="$SHM" VPS_DEPLOY_PATH="$APP" OFFHOST_UPLOAD_LOG="$T/upload.log" OFFHOST_SSH_TIMEOUT="${SSH_TO:-60}" bash "$RUNNER" 2>&1)"; RCODE=$?
  printf '%s\n' "$OUT" >>"$ALLLOG"; SUM="$(printf '%s\n' "$OUT" | grep -m1 '^OFFHOST_UPLOAD=' || true)"
}
rec() { awk -F'=' -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); print }' "$REC" 2>/dev/null; }
shm_files() { find "$SHM" -maxdepth 1 -name '.lcp-offhost.*' | wc -l; }
issued_sha() { reqlog | python3 -c 'import json,sys; rs=[r for r in json.load(sys.stdin) if r.get("kind")=="oidc"]; print(rs[-1]["token_sha256"] if rs else "")'; }
issued_aud() { reqlog | python3 -c 'import json,sys; rs=[r for r in json.load(sys.stdin) if r.get("kind")=="oidc"]; print(rs[-1]["audience"] if rs else "")'; }
oidc_time() { reqlog | python3 -c 'import json,sys; rs=[r for r in json.load(sys.stdin) if r.get("kind")=="oidc"]; print(rs[-1]["t"] if rs else 0)'; }
: >"$MODE_FILE"; clear_reqlog; run_runner
check "success: runner exit 0 and PASS summary" eq "$RCODE/$SUM" "0/OFFHOST_UPLOAD=PASS uploaded=1 pending_audit=0 failed=0"
check "success: OIDC requested with the uploader audience" eq "$(issued_aud)" "$OFFHOST_WIF_AUDIENCE"
check "success: the VPS received exactly the issued token (sha256)" eq "$(rec token_sha256)" "$(issued_sha)"
check "success: token file under the shm directory" eq "$(rec token_dir)" "$SHM"
check "success: token file name pattern .lcp-offhost.*" has "$(rec token_file)" "/.lcp-offhost."
check "success: token file mode 600, regular file" eq "$(rec token_mode)/$(rec token_symlink)" 600/no
check "success: token file removed after the run" eq "$(shm_files)" 0
check "success: config path derived from the deploy path" eq "$(rec config)" "$VPS/env/offhost.env"
check "success: uploader capped inside the credential window (max_time 120)" eq "$(rec max_time)" 120
check "success: token never in ssh arguments" eq "$(grep -c -- "$(issued_sha)" "$T/ssh.argv"; grep -cE 'FAKEGITHUBOIDC' "$T/ssh.argv")" "0
0"
check "success: no token-like argument passed to ssh" eq "$(grep -cE '[A-Za-z0-9_-]{60,}' "$T/ssh.argv")" 0
check "success: remote command carries only non-secret parameters (no token path value)" eq "$(grep -c 'DEPLOY_PATH=' "$T/ssh.argv")/$(grep -c 'OFFHOST_SUBJECT_TOKEN_FILE=/' "$T/ssh.argv")" 1/0
check "success: OIDC requested immediately before SSH (< 5 s)" eq "$(python3 -c "import sys; t=float(open('$T/ssh.times').readline()); print('ok' if 0 <= t - $(oidc_time) < 5 else 'late')")" ok
check "success: elapsed reported and within the SSH bound" eq "$(printf '%s\n' "$OUT" | grep -oE 'elapsed_seconds=[0-9]+' | cut -d= -f2 | awk '{print ($1 <= 60) ? "ok" : "slow"}')" ok
check "success: runner never receives dump bytes" eq "$(grep -c 'DUMP-BYTES-MARKER' "$T/upload.log" "$ALLLOG" | awk -F: '{s+=$2} END{print s+0}')" 0
check "success: remote preflight line present" has "$OUT" "OFFHOST_REMOTE=OK checkout=deployed uploader=tracked token_file=shm mode=600"
check "success: no token in runner output" nothas "$OUT" SECRETTOKEN
check "success: sweep executed via the same channel (second ssh call)" eq "$(grep -c '^vps$' "$T/ssh.argv")" 2
printf 'fail' >"$MODE_FILE"; clear_reqlog; run_runner
check "uploader failure: runner exit 1, FAIL summary" eq "$RCODE/$SUM" "1/OFFHOST_UPLOAD=FAIL uploaded=0 failed=1"
check "uploader failure: token file removed" eq "$(shm_files)" 0
printf 'ambiguous' >"$MODE_FILE"; clear_reqlog; run_runner
check "uploader ambiguous: runner exit 0 (audit decides), AMBIGUOUS summary" eq "$RCODE/$(printf '%s' "$SUM" | cut -d' ' -f1)" 0/OFFHOST_UPLOAD=AMBIGUOUS
check "uploader ambiguous: token file removed" eq "$(shm_files)" 0
printf 'hang' >"$MODE_FILE"; clear_reqlog; SSH_TO=30 run_runner
check "timeout: runner reports ssh-timeout (exit 124)" eq "$RCODE/$(printf '%s' "$SUM" | cut -d' ' -f1-2)" "124/OFFHOST_UPLOAD=FAIL reason=ssh-timeout"
check "timeout: token file removed by the remote trap" eq "$(shm_files)" 0
: >"$MODE_FILE"; STUB_SSH_MODE=refuse clear_reqlog; STUB_SSH_MODE=refuse run_runner
check "ssh refused: exit 255, ssh-connection-failed" eq "$RCODE/$(printf '%s' "$SUM" | cut -d' ' -f1-2)" "255/OFFHOST_UPLOAD=FAIL reason=ssh-connection-failed"
check "ssh refused: no token file left" eq "$(shm_files)" 0
: >"$MODE_FILE"; printf 'dirty' >"$APP/dirty.txt"; clear_reqlog; run_runner; rm -f "$APP/dirty.txt"
check "dirty hosted checkout: remote preflight fails (71), uploader not run" eq "$RCODE/$( [ -e "$REC" ] && echo ran || echo not-run)" 71/not-run
check "dirty hosted checkout: reason reported" has "$SUM" "reason=remote-preflight-failed"
check "dirty hosted checkout: token file still removed" eq "$(shm_files)" 0
printf 'deadbeef' >"$VPS/env/current-deploy.sha"; clear_reqlog; run_runner; ( cd "$APP" && git rev-parse HEAD >"$VPS/env/current-deploy.sha" )
check "checkout not at deployed revision: preflight fails" eq "$RCODE" 71
: >"$MODE_FILE"; clear_reqlog; ACTIONS_ID_TOKEN_REQUEST_URL="$EP/__control/nope?x=1" run_runner
check "OIDC failure: no SSH attempted" eq "$RCODE/$SUM/$( [ -e "$T/ssh.argv" ] && echo ssh || echo no-ssh)" "1/OFFHOST_UPLOAD=FAIL reason=oidc-request-failed/no-ssh"
ACTIONS_ID_TOKEN_REQUEST_URL="http://oidc.example.invalid/token" run_runner
check "OIDC URL must be https (non-loopback http refused)" eq "$SUM" "OFFHOST_UPLOAD=FAIL reason=oidc-url-not-https"
SSH_TO=600 run_runner
check "SSH bound above 280 s refused (five-minute window)" eq "$SUM" "OFFHOST_UPLOAD=FAIL reason=ssh-timeout-range"
clear_reqlog; ( sleep 1; pkill -TERM -f "$STUB/ssh vps" >/dev/null 2>&1 ) & printf 'hang' >"$MODE_FILE"; SSH_TO=60 run_runner; : >"$MODE_FILE"
check "interrupted session (TERM to ssh): token file removed" eq "$(shm_files)" 0
check "interrupted session: reported as a failure" has "$SUM" "OFFHOST_UPLOAD=FAIL"

# ── 5. WIF trust contract (static + fake-token evaluation) ───────────────────
section "5. WIF trust contract"
contract="$(python3 "$POLICY" print-contract)"
check "contract: repository ids and names" eq "$(printf '%s' "$contract" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["repository_id"],d["repository_owner_id"],d["repository"],d["ref"])')" "1275185839 64171170 Delowar01/Exhibition-Lead-Pro refs/heads/export-ready"
check "contract: exact workflow_ref" eq "$(printf '%s' "$contract" | python3 -c 'import json,sys; print(json.load(sys.stdin)["workflow_ref"])')" "Delowar01/Exhibition-Lead-Pro/.github/workflows/backup-offhost.yml@refs/heads/export-ready"
check "contract: required attribute mapping, in order" eq "$(printf '%s' "$contract" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["attribute_mapping"]))')" "google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref,attribute.event_name=assertion.event_name,attribute.environment=assertion.environment"
cond="$(printf '%s' "$contract" | python3 -c 'import json,sys; print(json.load(sys.stdin)["attribute_condition"])')"
for want in 'assertion.repository_id == "1275185839"' 'assertion.repository_owner_id == "64171170"' 'assertion.repository == "Delowar01/Exhibition-Lead-Pro"' 'assertion.ref == "refs/heads/export-ready"' 'assertion.workflow_ref == "Delowar01/Exhibition-Lead-Pro/.github/workflows/backup-offhost.yml@refs/heads/export-ready"' 'assertion.event_name in ["schedule", "workflow_dispatch"]' 'assertion.environment in ["offhost-upload", "offhost-audit"]'; do
  check "contract condition requires: $want" has "$cond" "$want"
done
check "contract does not depend on job_workflow_ref" eq "$(printf '%s' "$contract" | grep -c job_workflow_ref)/$(grep -c 'job_workflow_ref=assertion' "$CONTRACT")" 0/0
check "contract document carries the same condition verbatim" eq "$(grep -cF -- "$cond" "$CONTRACT")" 1
check "contract document restricts environments to export-ready without reviewers" eq "$(grep -c 'restricted to the\|restricted to the branch' "$CONTRACT" | awk '{print ($1 >= 1) ? "yes" : "no"}')/$(grep -c 'No required human reviewers' "$CONTRACT")" yes/1
check "contract document names the two principal sets" eq "$(grep -c 'attribute.environment/offhost-upload' "$CONTRACT")/$(grep -c 'attribute.environment/offhost-audit' "$CONTRACT")" 1/1
base='{"iss":"https://token.actions.githubusercontent.com","repository_id":"1275185839","repository_owner_id":"64171170","repository":"Delowar01/Exhibition-Lead-Pro","ref":"refs/heads/export-ready","workflow_ref":"Delowar01/Exhibition-Lead-Pro/.github/workflows/backup-offhost.yml@refs/heads/export-ready","event_name":"schedule","environment":"offhost-upload","sub":"repo:Delowar01/Exhibition-Lead-Pro:environment:offhost-upload"}'
claims() { python3 -c 'import json,sys
c=json.loads(sys.argv[1])
for kv in sys.argv[2:]:
    k,v=kv.split("=",1)
    if v=="<absent>": c.pop(k,None)
    else: c[k]=v
if "environment" in c and c.get("sub","").startswith("repo:") and "sub" not in [kv.split("=",1)[0] for kv in sys.argv[2:]]:
    c["sub"]="repo:%s:environment:%s"%(c["repository"],c["environment"])
print(json.dumps(c))' "$base" "$@"; }
wif() { python3 "$POLICY" evaluate "$1" "$2" 2>/dev/null; }
check "accept: scheduled offhost-upload" has "$(wif "$(claims)" upload)" "ADMIT"
check "accept: dispatched offhost-upload" has "$(wif "$(claims event_name=workflow_dispatch)" upload)" "ADMIT"
check "accept: scheduled offhost-audit" has "$(wif "$(claims environment=offhost-audit)" audit)" "ADMIT"
check "accept: dispatched offhost-audit" has "$(wif "$(claims environment=offhost-audit event_name=workflow_dispatch)" audit)" "ADMIT"
check "reject: foreign repository id" eq "$(wif "$(claims repository_id=999)" upload)" "DENY provider-repository_id"
check "reject: foreign owner id" eq "$(wif "$(claims repository_owner_id=999)" upload)" "DENY provider-repository_owner_id"
check "reject: wrong repository name" eq "$(wif "$(claims repository=Delowar01/Other)" upload)" "DENY provider-repository"
check "reject: wrong branch" eq "$(wif "$(claims ref=refs/heads/develop)" upload)" "DENY provider-ref"
check "reject: wrong workflow path" eq "$(wif "$(claims workflow_ref=Delowar01/Exhibition-Lead-Pro/.github/workflows/deploy-dev-vps.yml@refs/heads/export-ready)" upload)" "DENY provider-workflow_ref"
check "reject: pull_request event" eq "$(wif "$(claims event_name=pull_request)" upload)" "DENY provider-event_name"
check "reject: push event" eq "$(wif "$(claims event_name=push)" upload)" "DENY provider-event_name"
check "reject: wrong environment" eq "$(wif "$(claims environment=production)" upload)" "DENY provider-environment"
check "reject: missing environment" eq "$(wif "$(claims 'environment=<absent>' 'sub=repo:Delowar01/Exhibition-Lead-Pro:ref:refs/heads/export-ready')" upload)" "DENY provider-environment"
check "reject: branch-form subject with an environment claim" eq "$(wif "$(claims 'sub=repo:Delowar01/Exhibition-Lead-Pro:ref:refs/heads/export-ready')" upload)" "DENY provider-sub"
check "reject: cross-environment (upload token for the auditor role)" eq "$(wif "$(claims)" audit)" "DENY cross-environment"
check "reject: cross-environment (audit token for the uploader role)" eq "$(wif "$(claims environment=offhost-audit)" upload)" "DENY cross-environment"
check "reject: foreign issuer" eq "$(wif "$(claims iss=https://evil.example)" upload)" "DENY provider-issuer"

# ── 6. alert decision truth table ────────────────────────────────────────────
section "6. alert truth table"
decide() { OUT="$(env -i PATH="$PATH" AUDIT_RESULT="$1" UPLOAD_RESULT="$2" SUMMARY="$3" UPLOAD_SUMMARY="$4" SIMULATED="$5" OPEN_ISSUE="$6" TRIGGER=schedule RUN_URL="https://github.com/Delowar01/Exhibition-Lead-Pro/actions/runs/1/attempts/1" NOW=2026-09-29T05:00:00Z bash "$DECIDE" 2>&1)"; printf '%s\n' "$OUT" >>"$ALLLOG"; }
act() { printf '%s\n' "$OUT" | grep -m1 '^action=' | cut -d= -f2; }
health() { printf '%s\n' "$OUT" | grep -m1 '^health=' | cut -d= -f2; }
body() { printf '%s\n' "$OUT" | sed -n '/^---BODY---$/,$p' | tail -n +2; }
PASSLINE='OFFHOST_HEALTH=PASS slot=20260928-0315 set=leadcapture-20260928-031501.sql.gz result=remote-resolved window_ok=3/3 historical_unresolved=0 monthly=ok unexpected=0'
FAILLINE='OFFHOST_HEALTH=FAIL reason=canonical-slot-backup-missing slot=20260928-0315 set=- detail=no-set window_ok=2/3 historical_unresolved=0 monthly=ok unexpected=0'
UNAVAIL='OFFHOST_HEALTH=FAIL reason=remote-audit-unavailable detail=sts-http-500'
decide success failure "$PASSLINE" 'OFFHOST_UPLOAD=FAIL reason=ssh-timeout exit=124' "" ""
check "upload failed + remote set valid → PASS, no issue" eq "$(health)/$(act)" PASS/noop
decide success failure "$PASSLINE" 'OFFHOST_UPLOAD=FAIL reason=ssh-timeout exit=124' "" 7
check "upload failed + remote valid + open issue → recovery close" eq "$(health)/$(act)" PASS/close
check "recovery body keeps the upload context" has "$(body)" "Upload summary (context only)"
decide failure failure "$FAILLINE" 'OFFHOST_UPLOAD=FAIL reason=ssh-timeout exit=124' "" ""
check "upload failed + current set missing → FAIL, create" eq "$(health)/$(act)" FAIL/create
check "create body names the audit as source of truth" has "$(body)" "source of truth"
decide success success "$PASSLINE" 'OFFHOST_UPLOAD=AMBIGUOUS uploaded=0 pending_audit=1 failed=0' "" ""
check "upload ambiguous + remotely valid → PASS (remote-resolved)" eq "$(health)/$(act)" PASS/noop
decide failure success "$UNAVAIL" 'OFFHOST_UPLOAD=PASS uploaded=1' "" ""
check "audit unavailable → FAIL, create" eq "$(health)/$(act)" FAIL/create
decide failure success "$PASSLINE" 'OFFHOST_UPLOAD=PASS uploaded=1' true ""
check "simulated failure → control-flow only: FAIL, create with note" eq "$(health)/$(act)/$(body | grep -c 'SIMULATED FAILURE')" FAIL/create/1
decide failure success "$FAILLINE" 'OFFHOST_UPLOAD=PASS uploaded=1' "" 9
check "repeated unhealthy → comment (deduplicated)" eq "$(act)" comment
decide success success "$PASSLINE" 'OFFHOST_UPLOAD=PASS uploaded=1' "" 9
check "recovery → close" eq "$(act)/$(body | grep -c 'Closing this alert')" close/1
decide cancelled success "" "" "" ""
check "cancelled audit is unhealthy" eq "$(health)/$(act)" FAIL/create
decide success success "$PASSLINE" 'OFFHOST_UPLOAD=PASS host=1.2.3.4 user=leadpro 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' "" ""
check "body sanitizes long hashes/tokens" eq "$(decide failure success "$FAILLINE" 'OFFHOST_UPLOAD=FAIL 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' "" ""; body | grep -c '<masked>')" 1
decide failure success "$FAILLINE" 'OFFHOST_UPLOAD=FAIL reason=x' "" "abc"
check "non-numeric open-issue input is ignored (create, not comment)" eq "$(act)" create
decide failure success "$FAILLINE" 'OFFHOST_UPLOAD=FAIL reason=x' "" ""
check "issue text never contains host, user, port, bucket, audience or key words" eq "$(body | grep -ciE 'VPS_HOST|VPS_USER|VPS_PORT|lcp-test|workloadIdentityPools|PRIVATE KEY|SECRETTOKEN')" 0

# ── 7. static security ───────────────────────────────────────────────────────
section "7. static security"
code() { grep -vE '^[[:space:]]*#' "$1"; }
check "[static] auditor never downloads (alt=media)" eq "$(code "$AUD" | grep -c 'alt=media')" 0
check "[static] auditor never calls objects.get (no /o/<name> path)" eq "$(grep -cE '/o/\$|/o/"' "$AUD")" 0
check "[static] auditor uses no DELETE/PATCH/PUT" eq "$(grep -cE '\-X (DELETE|PATCH|PUT)' "$AUD")" 0
check "[static] auditor POSTs only to the token endpoints" eq "$(grep -c 'http POST' "$AUD")" "$(grep -cE 'http POST "\$(STS_EP|IAMCRED_EP)' "$AUD")"
check "[static] auditor requires storage.objects.list only (documented)" eq "$(grep -c 'storage.objects.list' "$AUD")" 1
check "[static] auditor has no SSH" eq "$(grep -cE '\b(ssh|scp|sftp)\b' "$AUD")" 0
check "[static] auditor read_only scope default" eq "$(code "$AUD" | grep -c 'devstorage.read_only')" 1
check "[static] auditor HTTPS guard on storage, STS, IAM Credentials and OIDC URL" eq "$(grep -c '^endpoint_ok \|endpoint_ok oidc-request-url' "$AUD")" 4
check "[static] no objectListPrefix IAM design" eq "$(grep -c 'objectListPrefix' "$AUD" "$WF" "$CONTRACT" "$POLICY" | awk -F: '{s+=$2} END{print s+0}')" 0
check "[static] no key material anywhere" eq "$(grep -cE 'private_key|BEGIN (RSA |EC )?PRIVATE KEY|client_secret' "$AUD" "$RUNNER" "$REMOTE" "$DECIDE" "$WF" | awk -F: '{s+=$2} END{print s+0}')" 0
check "[static] no utcfromtimestamp (Python 3.12 deprecation)" eq "$(grep -c 'utcfromtimestamp' "$AUD" "$SEED" "$FAKE" | awk -F: '{s+=$2} END{print s+0}')" 0
check "[static] runner: token travels on stdin only" eq "$(grep -c "printf '%s\\\\n' \"\$token\" | timeout" "$RUNNER")" 1
check "[static] runner: token masked in Actions logs" eq "$(grep -c '::add-mask::\$token' "$RUNNER")" 1
check "[static] runner: token never exported or passed as an argument" eq "$(grep -cE 'export token|--token|token=\$token|"\$token" "\$' "$RUNNER")" 0
check "[static] runner: no scp/sftp/download of backups" eq "$(grep -cE '\b(scp|sftp|rsync)\b|leadcapture-' "$RUNNER" "$REMOTE" | awk -F: '{s+=$2} END{print s+0}')" 0
check "[static] runner: SSH bounded (30..280 s)" eq "$(grep -c 'le 280' "$RUNNER")" 1
trap_line="$(grep -n 'trap cleanup EXIT HUP INT TERM' "$REMOTE" | cut -d: -f1)"; write_line="$(grep -n 'printf .%s. "\$line" >"\$tok"' "$REMOTE" | cut -d: -f1)"
check "[static] remote: umask 077, /dev/shm default, mode 600" eq "$(code "$REMOTE" | grep -c '^umask 077')/$(code "$REMOTE" | grep -c ':-/dev/shm}')/$(code "$REMOTE" | grep -c 'chmod 600 "\$tok"')" 1/1/1
check "[static] remote: cleanup trap installed before the token is written" eq "$( [ -n "$trap_line" ] && [ -n "$write_line" ] && [ "$trap_line" -lt "$write_line" ] && echo ok || echo bad)" ok
check "[static] remote: trap covers EXIT HUP INT TERM" eq "$(grep -c 'trap cleanup EXIT HUP INT TERM' "$REMOTE")" 1
check "[static] remote: never echoes the token" eq "$(grep -cE 'echo .*\$line|echo .*\$tok\b|cat "\$tok"' "$REMOTE")" 0
check "[static] remote: verifies checkout, marker and uploader before running" eq "$(grep -c 'checkout-not-deployed-revision' "$REMOTE")/$(grep -c 'checkout-dirty' "$REMOTE")/$(grep -c 'uploader-differs-from-head' "$REMOTE")" 1/1/1
check "[static] decision: health depends on the audit result only" eq "$(grep -c 'AUDIT_RESULT" = success' "$DECIDE")/$(grep -cE 'UPLOAD_RESULT"? = (success|failure)' "$DECIDE")" 1/0
if command -v git >/dev/null 2>&1 && git -C "$HERE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  check "[static] backup-health-alert.yml unchanged (blob 44c40f57…)" eq "$(git -C "$HERE" hash-object "$HERE/../../workflows/backup-health-alert.yml")" 44c40f57cf68ac11808f919d9425872669ca2f1f
  check "[static] verify-hosted-backup.sh unchanged (blob f7fc4b65…)" eq "$(git -C "$HERE" hash-object "$HERE/../verify-hosted-backup.sh")" f7fc4b6589040a86edc2b6ea3fa631c56ceef0a9
fi
check "[secrets] no token in any captured output" eq "$(grep -c 'SECRETTOKEN' "$ALLLOG")" 0
check "[secrets] no bucket name in any captured output" eq "$(grep -c 'lcp-test-audit-bucket' "$ALLLOG")" 0
check "[secrets] no dump bytes in any captured output" eq "$(grep -c 'DUMP-BYTES-MARKER' "$ALLLOG")" 0
check "[secrets] every audit summary line matched the workflow regex" eq "$(grep '^OFFHOST_HEALTH=' "$ALLLOG" | grep -vcE "$SUMMARY_RE")" 0
check "[warnings] no Python deprecation warnings from the fake or the seeder" eq "$(grep -ci 'DeprecationWarning' "$WARNLOG")" 0
check "[warnings] no Python deprecation warnings from the auditor" eq "$(grep -ci 'DeprecationWarning' "$ALLLOG")" 0

echo "RESULT: pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
