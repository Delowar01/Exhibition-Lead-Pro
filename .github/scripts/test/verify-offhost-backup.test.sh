#!/bin/bash
# =============================================================================
# Deterministic harness for .github/scripts/verify-offhost-backup.sh and
# .github/workflows/backup-offhost-alert.yml
# =============================================================================
# Local and fake only: a Python fake of the Cloud Storage JSON API + STS
# (fake-gcs.py, list-only for the auditor) with fault injection, a fake GitHub
# OIDC endpoint, seeded three-object sets with controllable defects
# (seed-offhost-set.py) and a controlled clock (OFFHOST_NOW). No provider,
# no credential, no network beyond 127.0.0.1. The fake STS answers with a
# distinctive token that must never appear in any output.
#
# Run:  bash .github/scripts/test/verify-offhost-backup.test.sh
# Requirements: bash, python3 (PyYAML for the workflow parse), curl.
# =============================================================================
set -uo pipefail
export PYTHONDONTWRITEBYTECODE=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUD="${OFFHOST_TEST_AUDITOR:-$HERE/../verify-offhost-backup.sh}"
WF="${OFFHOST_TEST_WORKFLOW:-$HERE/../../workflows/backup-offhost-alert.yml}"
FAKE="$HERE/fake-gcs.py"; SEED="$HERE/seed-offhost-set.py"
PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*" >&2; }
check() { local d="$1"; shift; if "$@"; then pass; else fail "$d"; fi; }
eq() { [ "$1" = "$2" ]; }
has() { [[ "$1" == *"$2"* ]]; }
nothas() { [[ "$1" != *"$2"* ]]; }
section() { echo "--- $*"; }
unset AWS_SECRET_ACCESS_KEY AWS_ACCESS_KEY_ID GOOGLE_APPLICATION_CREDENTIALS CLOUDSDK_CONFIG 2>/dev/null || true
T="$(mktemp -d)"; FAKE_PID=
cleanup() { [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT
ALLLOG="$T/all.log"; : >"$ALLLOG"

# ── 1. syntax and workflow statics ───────────────────────────────────────────
section "1. syntax and workflow statics"
check "auditor parses" bash -n "$AUD"
check "fake provider parses" python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$FAKE"
check "seeder parses" python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$SEED"
WFJ="$T/wf.json"
if python3 -c 'import yaml' 2>/dev/null; then
  python3 -c 'import yaml, json, sys; json.dump(yaml.safe_load(open(sys.argv[1])), open(sys.argv[2], "w"))' "$WF" "$WFJ"
  check "workflow YAML parses" eq "$?" 0
  wf() { python3 -c "import json,sys; d=json.load(open(sys.argv[1]))
v=d
for p in sys.argv[2].split('.'):
    v = v[int(p)] if isinstance(v, list) else v.get(p)
print(json.dumps(v) if isinstance(v,(dict,list)) else v)" "$WFJ" "$1" 2>/dev/null; }
  check "workflow name" eq "$(wf name)" backup-offhost-alert
  check "workflow schedule present" eq "$(wf 'true.schedule.0.cron' 2>/dev/null || wf 'on.schedule.0.cron')" "0 5 * * *"
  check "workflow dispatchable with simulate_failure" eq "$(wf 'true.workflow_dispatch.inputs.simulate_failure.type' 2>/dev/null || wf 'on.workflow_dispatch.inputs.simulate_failure.type')" boolean
  check "top-level permissions: contents read only" eq "$(wf permissions)" '{"contents": "read"}'
  check "audit job permissions: contents read + id-token write" eq "$(wf jobs.audit.permissions)" '{"contents": "read", "id-token": "write"}'
  check "alert job permissions: issues write only" eq "$(wf jobs.alert.permissions)" '{"issues": "write"}'
  check "concurrency does not cancel in progress" eq "$(wf concurrency.cancel-in-progress)" False
  check "exactly two jobs" eq "$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["jobs"]))' "$WFJ")" 2
  check "alert job always runs after audit" eq "$(wf jobs.alert.needs)/$(wf jobs.alert.if)" "audit/always()"
else
  echo "note: PyYAML absent — structural YAML checks skipped"
fi
check "workflow issue title" eq "$(grep -c 'ALERT_TITLE: "\[Backup Alert\] Off-host backup copy unhealthy"' "$WF")" 1
check "workflow uses only the two configuration secrets" eq "$(grep -oE 'secrets\.[A-Z_]+' "$WF" | sort -u | tr '\n' ' ')" "secrets.OFFHOST_BUCKET secrets.OFFHOST_WIF_AUDIENCE "
check "workflow has no SSH, deploy, backup, restore or database command" eq "$(grep -cE '\b(ssh|scp|rsync|sftp|pg_dump|pg_restore|psql|dropdb|createdb|deploy-vps|backup-postgres|crontab)\b' "$WF")" 0
check "workflow stores no key or token" eq "$(grep -ciE 'GOOGLE_APPLICATION_CREDENTIALS|service_account_key|credentials_json|private_key|access_token' "$WF")" 0
check "workflow checkout does not persist credentials" eq "$(grep -c 'persist-credentials: false' "$WF")" 1
check "workflow only checks out the auditor script" eq "$(grep -A2 'sparse-checkout: |' "$WF" | grep -c 'verify-offhost-backup.sh')" 1
SUMMARY_RE="$(grep -oE "\^OFFHOST_HEALTH=[^']+" "$WF" | head -n 1 | sed "s/'.*//")"
check "workflow summary regex extracted" has "$SUMMARY_RE" 'OFFHOST_HEALTH=(PASS|FAIL)'

# ── fake provider ────────────────────────────────────────────────────────────
mkdir -p "$T/state"; python3 "$FAKE" 0 "$T/state" & FAKE_PID=$!
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
seedset() { python3 "$SEED" "$EP" "$@" >/dev/null; }
seedraw() {   # KEY CONTENT [METADATA_JSON]
  python3 - "$EP" "$1" "$2" "${3:-{\}}" <<'PY'
import base64, json, sys, urllib.request
ep, key, content, meta = sys.argv[1:]
body = json.dumps({"key": key, "content_b64": base64.b64encode(content.encode()).decode(), "metadata": json.loads(meta)}).encode()
urllib.request.urlopen(urllib.request.Request(ep + "/__control/seed", data=body, headers={"Content-Type": "application/json"})).read()
PY
}
export OFFHOST_BUCKET=lcp-test-audit-bucket OFFHOST_WIF_AUDIENCE=//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/lcp-github/providers/github
export OFFHOST_STORAGE_ENDPOINT="$EP" OFFHOST_STS_ENDPOINT="$EP/v1/token" OFFHOST_IAMCREDENTIALS_ENDPOINT="$EP"
export ACTIONS_ID_TOKEN_REQUEST_URL="$EP/__control/oidc?x=1" ACTIONS_ID_TOKEN_REQUEST_TOKEN=dummy-oidc-request-bearer OFFHOST_RETRY_BASE_SECONDS=0
export OFFHOST_NOW="$(date -u -d '2026-09-28 05:10:00' +%s)"
OUT=""; RCODE=0; SUM=""
run_audit() { OUT="$(bash "$AUD" 2>&1)"; RCODE=$?; printf '%s\n' "$OUT" >>"$ALLLOG"; SUM="$(printf '%s\n' "$OUT" | grep -m1 '^OFFHOST_HEALTH=' || true)"; }
sumv() { printf '%s\n' "$SUM" | awk -v k="$1" '{ for (i = 1; i <= NF; i++) if (split($i, a, "=") == 2 && a[1] == k) print a[2] }'; }
regex_ok() { [[ "$SUM" =~ $SUMMARY_RE ]]; }
S28=leadcapture-20260928-031501.sql.gz; S27=leadcapture-20260927-031501.sql.gz; S26=leadcapture-20260926-031501.sql.gz; S25=leadcapture-20260925-031501.sql.gz
seed_window() { seedset "$S28"; seedset "$S27" gen=1700000000090000 t0=2026-09-27T03:30:10.000Z; seedset "$S26" gen=1700000000080000 t0=2026-09-26T03:30:10.000Z; }

# ── 2. verdicts ──────────────────────────────────────────────────────────────
section "2. verdicts"
ctl_reset; run_audit
check "empty bucket: FAIL canonical-slot-backup-missing" eq "$RCODE/$(sumv reason)" 1/canonical-slot-backup-missing
check "empty bucket: expected slot named" eq "$(sumv slot)" 20260928-0315
check "empty bucket: summary matches the workflow regex" regex_ok
ctl_reset; seed_window; run_audit
check "fully observed window: PASS" eq "$RCODE" 0
check "fully observed: result category" eq "$(sumv result)" uploaded-local-and-remote-verified
check "fully observed: observation echoed" eq "$(sumv observation)" create-responses-validated
check "fully observed: window 3/3, no historical" eq "$(sumv window_ok)/$(sumv historical_unresolved)" 3/3/0
check "fully observed: sha256 prefix only (12 chars)" eq "${#SUM}" "${#SUM}"
check "fully observed: hash prefix length" eq "$(sumv sha256_prefix | awk '{print length($0)}')" 12
check "fully observed: summary matches regex" regex_ok
check "list-only: request kinds are sts and list only" eq "$(kinds)" "list sts"
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
OFFHOST_LOCAL_RECEIPT_STATUS=exists-unverified run_audit
check "remote-valid set resolves a local exists-unverified receipt" eq "$RCODE/$(sumv result)" 0/uploaded-local-and-remote-verified
ctl_reset; seedset "$S28" observation=remote-audit-required null_generations=1; seedset "$S27" gen=1700000000090000 t0=2026-09-27T03:30:10.000Z; seedset "$S26" gen=1700000000080000 t0=2026-09-26T03:30:10.000Z; run_audit
check "audit-required set with null generations → remote-resolved" eq "$RCODE/$(sumv result)" 0/remote-resolved
ctl_reset; seedset "$S28" observation=remote-audit-required; seedset "$S27" gen=1700000000090000 t0=2026-09-27T03:30:10.000Z; seedset "$S26" gen=1700000000080000 t0=2026-09-26T03:30:10.000Z; run_audit
check "audit-required set with observed generations → remote-resolved" eq "$RCODE/$(sumv result)" 0/remote-resolved
mismatch_case() {   # DESC EXPECTED_DETAIL seeder-options…
  local d="$1" want="$2"; shift 2
  ctl_reset; seedset "$S28" "$@"; seedset "$S27" gen=1700000000090000 t0=2026-09-27T03:30:10.000Z; seedset "$S26" gen=1700000000080000 t0=2026-09-26T03:30:10.000Z; run_audit
  check "$d: FAIL remote-metadata-mismatch" eq "$RCODE/$(sumv reason)" 1/remote-metadata-mismatch
  check "$d: detail=$want" eq "$(sumv detail)" "$want"
  check "$d: summary matches regex" regex_ok
}
mismatch_case "size mismatch" size bad_size=1
mismatch_case "md5 mismatch" md5 bad_md5=1
mismatch_case "sha256 mismatch" sha256 bad_sha256=1
mismatch_case "missing sha256 metadata" sha256 missing_sha256=1
mismatch_case "generation mismatch" dump-generation bad_generation=1
mismatch_case "key mismatch" key bad_key=1
mismatch_case "manifest schema mismatch" manifest-schema bad_schema=1
mismatch_case "wrong slot in manifest" manifest-slot wrong_slot=1
mismatch_case "foreign manifest" manifest-schema foreign_manifest=1
mismatch_case "validated observation without generations" dump-generation-unobserved null_generations=1
mismatch_case "manifest earlier than its objects" manifest-before-object manifest_earlier=1
mismatch_case "duplicate live generation" duplicate-live-generation duplicate_live=1
ctl_reset; seedset "$S28" dt_sidecar=0 dt_manifest=0; seedset "$S27" gen=1700000000090000 t0=2026-09-27T03:30:10.000Z; seedset "$S26" gen=1700000000080000 t0=2026-09-26T03:30:10.000Z; run_audit
check "equal timestamps are valid" eq "$RCODE/$(sumv result)" 0/uploaded-local-and-remote-verified
ctl_reset; seed_window; seedset leadcapture-20260928-100000.sql.gz gen=1700000000200000 t0=2026-09-28T10:30:10.000Z; run_audit
check "duplicate completed canonical sets in one slot fail" eq "$RCODE/$(sumv reason)/$(sumv detail)" 1/remote-metadata-mismatch/duplicate-canonical-set
ctl_reset; seed_window; seedset leadcapture-20260928-100000.sql.gz gen=1700000000200000 t0=2026-09-28T10:30:10.000Z no_manifest=1; run_audit
check "a second (partial) set in the slot is unexpected" eq "$RCODE/$(sumv detail)" 1/unexpected-object-in-slot
ctl_reset; seedset "$S28" no_manifest=1; seedset "$S27" gen=1700000000090000 t0=2026-09-27T03:30:10.000Z; seedset "$S26" gen=1700000000080000 t0=2026-09-26T03:30:10.000Z; run_audit
check "current slot without manifest: partial-remote-set" eq "$RCODE/$(sumv reason)/$(sumv detail)" 1/partial-remote-set/missing-manifest
ctl_reset; seedset "$S28" no_manifest=1 no_sidecar=1; seedset "$S27" gen=1700000000090000 t0=2026-09-27T03:30:10.000Z; seedset "$S26" gen=1700000000080000 t0=2026-09-26T03:30:10.000Z; run_audit
check "dump alone is not a completed backup" eq "$RCODE/$(sumv reason)/$(sumv detail)" "1/partial-remote-set/missing-sidecar,manifest"
ctl_reset; seedset "$S28" incomplete=1; seedset "$S27" gen=1700000000090000 t0=2026-09-27T03:30:10.000Z; seedset "$S26" gen=1700000000080000 t0=2026-09-26T03:30:10.000Z; run_audit
check "manifest without status=complete is not completed" eq "$RCODE/$(sumv reason)" 1/partial-remote-set
ctl_reset; seedset "$S28"; seedset "$S27" gen=1700000000090000 t0=2026-09-27T03:30:10.000Z no_manifest=1; seedset "$S26" gen=1700000000080000 t0=2026-09-26T03:30:10.000Z; run_audit
check "partial set in a previous window slot blocks" eq "$RCODE/$(sumv reason)/$(sumv slot)" 1/partial-remote-set/20260927-0315
check "current slot still reported healthy in the detail lines" has "$OUT" "slot=20260928-0315 set=$S28 result=uploaded-local-and-remote-verified"
ctl_reset; seed_window; seedset "$S25" gen=1700000000070000 t0=2026-09-25T03:30:10.000Z no_manifest=1; run_audit
check "historical unresolved set (outside window) does not block" eq "$RCODE/$(sumv historical_unresolved)" 0/1
ctl_reset; seed_window; seedset "$S25" gen=1700000000070000 t0=2026-09-25T03:30:10.000Z; run_audit
check "historical valid set counts as resolved" eq "$RCODE/$(sumv historical_unresolved)" 0/0
ctl_reset; seed_window; seedraw dev/postgres/daily/notes.txt "x"; run_audit
check "unexpected object under daily/ fails" eq "$RCODE/$(sumv detail)" 1/unexpected-object
ctl_reset; seed_window; seedraw dev/postgres/manual/20260928/leadcapture-20260928-120000.sql.gz "x"; run_audit
check "objects under manual/ are ignored" eq "$RCODE" 0
ctl_reset; seed_window; seedraw other/prefix/file "x"; run_audit
check "objects outside the prefix are never listed" eq "$RCODE/$(sumv unexpected)" 0/0

# ── 3. monthly (warning only) ────────────────────────────────────────────────
section "3. monthly"
ctl_reset; seed_window; run_audit
check "day 28 without monthly: warning only, still PASS" eq "$RCODE/$(sumv monthly)" 0/missing
seedset "$S26" kind=monthly derived_from="$S26" gen=1700000000300000 t0=2026-09-27T03:31:00.000Z; run_audit
check "valid monthly set → monthly=ok" eq "$RCODE/$(sumv monthly)" 0/ok
ctl_reset; seed_window; seedset "$S26" kind=monthly derived_from="$S26" gen=1700000000300000 t0=2026-09-27T03:31:00.000Z bad_md5=1; run_audit
check "inconsistent monthly set → monthly=mismatch, not blocking" eq "$RCODE/$(sumv monthly)" 0/mismatch
ctl_reset; seedset leadcapture-20260903-031501.sql.gz t0=2026-09-03T03:30:10.000Z; seedset leadcapture-20260902-031501.sql.gz gen=1700000000090000 t0=2026-09-02T03:30:10.000Z; seedset leadcapture-20260901-031501.sql.gz gen=1700000000080000 t0=2026-09-01T03:30:10.000Z
OFFHOST_NOW="$(date -u -d '2026-09-03 05:10:00' +%s)" run_audit
check "before day 8 the monthly copy is not due" eq "$RCODE/$(sumv monthly)" 0/not-due

# ── 4. audit unavailability ──────────────────────────────────────────────────
section "4. unavailability"
ctl_reset; seed_window; fault POST /v1/token status:500 10; run_audit
check "STS failure → remote-audit-unavailable" eq "$RCODE/$(sumv reason)/$(sumv detail)" 1/remote-audit-unavailable/sts-http-500
check "STS failure: summary matches regex" regex_ok
ctl_reset; seed_window; fault POST /v1/token status:400 10; run_audit
check "STS rejection (WIF condition) → remote-audit-unavailable" eq "$RCODE/$(sumv detail)" 1/sts-http-400
ctl_reset; seed_window; fault GET /storage/v1/b status:500 10; run_audit
check "list failure → remote-audit-unavailable" eq "$RCODE/$(sumv detail)" 1/list-http-500
ctl_reset; seed_window; fault GET /storage/v1/b status:503 1; clear_reqlog; run_audit
check "transient list failure is retried" eq "$RCODE/$(listcalls | cut -d' ' -f1)" 0/3
ctl_reset; seed_window; ACTIONS_ID_TOKEN_REQUEST_URL="$EP/__control/nope?x=1" run_audit
check "OIDC endpoint failure → remote-audit-unavailable" eq "$RCODE/$(sumv detail)" 1/oidc-http-404
ctl_reset; seed_window; ACTIONS_ID_TOKEN_REQUEST_URL= run_audit
check "missing OIDC context → remote-audit-unavailable" eq "$RCODE/$(sumv detail)" 1/no-oidc-request-context
ctl_reset; seed_window; OFFHOST_IMPERSONATE_SA=lcp-backup-auditor@lcp-test.iam.gserviceaccount.com run_audit
check "impersonation fallback works" eq "$RCODE" 0
check "impersonation fallback leaks no token" nothas "$OUT" SECRETTOKEN
OFFHOST_BUCKET="Bad Bucket" run_audit; check "bad bucket format refused" eq "$RCODE/$(sumv reason)" 1/configuration

# ── 5. static security ───────────────────────────────────────────────────────
section "5. static security"
code() { grep -vE '^[[:space:]]*#' "$AUD"; }   # non-comment lines of the auditor
check "[static] auditor never downloads (alt=media)" eq "$(code | grep -c 'alt=media')" 0
check "[static] auditor never calls objects.get (no /o/<name> path)" eq "$(grep -cE '/o/\$|/o/"' "$AUD")" 0
check "[static] auditor uses no DELETE/PATCH/PUT" eq "$(grep -cE '\-X (DELETE|PATCH|PUT)' "$AUD")" 0
check "[static] auditor POSTs only to the token endpoints" eq "$(grep -c 'http POST' "$AUD")" "$(grep -cE 'http POST "\$(STS_EP|IAMCRED_EP)' "$AUD")"
check "[static] auditor requires storage.objects.list only (documented)" eq "$(grep -c 'storage.objects.list' "$AUD")" 1
check "[static] no objectListPrefix IAM design" eq "$(grep -c 'objectListPrefix' "$AUD" "$WF" | awk -F: '{s+=$2} END{print s+0}')" 0
check "[static] no SSH or VPS access in the auditor" eq "$(grep -cE '\b(ssh|scp|sftp)\b' "$AUD")" 0
check "[static] no key material" eq "$(grep -cE 'private_key|BEGIN (RSA |EC )?PRIVATE KEY|client_secret' "$AUD")" 0
check "[static] read_only scope default" eq "$(code | grep -c 'devstorage.read_only')" 1
check "[static] manifest schema constant" eq "$(grep -c 'MANIFEST_SCHEMA="lcp-offhost-manifest/2"' "$AUD")" 1
check "[static] explicit prefix and selected fields on every list" eq "$(grep -c 'o?prefix=' "$AUD")/$(grep -c 'fields=items(name,generation,size,md5Hash,crc32c,metadata,timeCreated,timeDeleted),nextPageToken' "$AUD")" 1/1
if command -v git >/dev/null 2>&1 && git -C "$HERE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  check "[static] backup-health-alert.yml unchanged (blob 44c40f57…)" eq "$(git -C "$HERE" hash-object "$HERE/../../workflows/backup-health-alert.yml")" 44c40f57cf68ac11808f919d9425872669ca2f1f
  check "[static] verify-hosted-backup.sh unchanged (blob f7fc4b65…)" eq "$(git -C "$HERE" hash-object "$HERE/../verify-hosted-backup.sh")" f7fc4b6589040a86edc2b6ea3fa631c56ceef0a9
fi
check "[secrets] no token in any captured output" eq "$(grep -c 'SECRETTOKEN' "$ALLLOG")" 0
check "[secrets] no bucket name in any captured output" eq "$(grep -c 'lcp-test-audit-bucket' "$ALLLOG")" 0
check "[secrets] every summary line matched the workflow regex" eq "$(grep '^OFFHOST_HEALTH=' "$ALLLOG" | grep -vcE "$SUMMARY_RE")" 0

echo "RESULT: pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
