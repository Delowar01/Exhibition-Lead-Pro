#!/bin/bash
# =============================================================================
# Deterministic tests for the GitHub side of the Hostinger-only off-host design
# (B23 G-6D Correction 1): .github/scripts/verify-offhost-hostinger.sh,
# .github/scripts/offhost-hostinger-alert-decision.sh and
# .github/workflows/backup-offhost-hostinger.yml
# =============================================================================
# Touches no VPS, no GitHub Issue and no secret. Four layers:
#   1. the pure expected-slot function with fixed UTC epochs (transfer grace,
#      late starts, the 03:15 boundaries);
#   2. the verifier against canned AUDIT listings (healthy, early, late,
#      missing, incomplete, same-host, host-key mismatch, stale/orphan files,
#      clock skew, rejected/absent header, machine pin) — the fixtures contain
#      no backup byte, exactly like the real listing;
#   3. the alert decision truth table incl. simulated failure and sanitising;
#   4. static checks of the workflow (permissions, concurrency, pinned SSH, no
#      ssh-keyscan, no upload/transfer/backup command, exact alert title, no
#      cloud-storage provider assumptions) and a leak scan of every output.
#
#     bash .github/scripts/test/verify-offhost-hostinger.test.sh
# =============================================================================
set -uo pipefail
export PYTHONDONTWRITEBYTECODE=1 LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFIER="$HERE/../verify-offhost-hostinger.sh"
DECISION="$HERE/../offhost-hostinger-alert-decision.sh"
WORKFLOW="$HERE/../../workflows/backup-offhost-hostinger.yml"
LIB="$HERE/../../../docker/scripts/offhost/offhost-lib.sh"
PASSED=0; FAILED=0
ok()  { PASSED=$((PASSED + 1)); echo "ok   $1"; }
bad() { FAILED=$((FAILED + 1)); echo "FAIL $1${2:+ — $2}"; }
expect_eq()    { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got '$2' want '$3'"; fi; }
expect_true()  { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
expect_false() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$d" "unexpectedly succeeded"; else ok "$d"; fi; }
has()    { if grep -qE -- "$2" "$1"; then ok "$3"; else bad "$3" "pattern '$2' absent"; fi; }
nothas() { if grep -qE -- "$2" "$1"; then bad "$3" "pattern '$2' present"; else ok "$3"; fi; }
ts() { date -u -d "$1" +%s; }
T="$(mktemp -d "${TMPDIR:-/tmp}/lcp-offhost-gh-test.XXXXXXXX")"; trap 'rm -rf "${T:?}"' EXIT
mkdir -p "$T/out"

echo "== 0. syntax =="
expect_true "bash -n verifier" bash -n "$VERIFIER"
expect_true "bash -n decision" bash -n "$DECISION"
expect_true "bash -n this test" bash -n "${BASH_SOURCE[0]}"
expect_true "library present" test -f "$LIB"
python3 - "$WORKFLOW" >"$T/workflow.json" <<'PY' && ok "workflow YAML parses" || bad "workflow YAML parses"
import json, sys, yaml
with open(sys.argv[1]) as fh:
    doc = yaml.safe_load(fh)
json.dump(doc, sys.stdout)
PY

echo "== 1. expected slot (transfer grace; no false staleness on early or late starts) =="
# shellcheck disable=SC1090
VERIFY_OFFHOST_LIB=1 source "$VERIFIER"
lbl() { lcp_slot_label "$1"; }
expect_eq "03:20 (5 min after the slot, grace 90) expects the PREVIOUS slot" "$(lbl "$(expected_slot_index "$(ts '2026-09-30 03:20:00')" 90)")" "20260929-0315"
expect_eq "04:44:59 still expects the previous slot"                          "$(lbl "$(expected_slot_index "$(ts '2026-09-30 04:44:59')" 90)")" "20260929-0315"
expect_eq "04:45:00 (grace elapsed) expects the current slot"                 "$(lbl "$(expected_slot_index "$(ts '2026-09-30 04:45:00')" 90)")" "20260930-0315"
expect_eq "05:00 (schedule) expects the current slot"                         "$(lbl "$(expected_slot_index "$(ts '2026-09-30 05:00:00')" 90)")" "20260930-0315"
expect_eq "23:00 (very late GitHub start) still expects the current slot"     "$(lbl "$(expected_slot_index "$(ts '2026-09-30 23:00:00')" 90)")" "20260930-0315"
expect_eq "next day 03:14:59 still expects the 09-30 slot"                    "$(lbl "$(expected_slot_index "$(ts '2026-10-01 03:14:59')" 90)")" "20260930-0315"
expect_eq "next day 03:16 (new slot, inside grace) expects the 09-30 slot"    "$(lbl "$(expected_slot_index "$(ts '2026-10-01 03:16:00')" 90)")" "20260930-0315"
expect_eq "grace 0 expects the new slot from 03:15:00"                        "$(lbl "$(expected_slot_index "$(ts '2026-10-01 03:15:00')" 0)")" "20261001-0315"
expect_false "non-numeric inputs rejected" expected_slot_index abc 90

echo "== 2. verifier against canned AUDIT listings =="
mkkey() { printf 'ssh-ed25519 %s fixture\n' "$(head -c 51 /dev/urandom | base64 -w0)"; }
BK="$(mkkey)"; PK1="$(mkkey)"; PK2="$(mkkey)"
printf '[backup.example]:2222 %s\n' "$BK" >"$T/backup.kh"
printf 'primary.example %s\nprimary.example %s\n' "$PK1" "$PK2" >"$T/primary.kh"
printf '%s\n' "$BK" >"$T/bk.pub"; printf '%s\n' "$PK1" >"$T/pk1.pub"
BFP="$(lcp_hostkey_fingerprint "$T/bk.pub")"; PFP="$(lcp_hostkey_fingerprint "$T/pk1.pub")"
MACHINE="$(printf 'vault' | sha256sum | cut -c1-64)"
NOWH="$(ts '2026-09-30 05:00:00')"
# mk_audit FILE NOW_UTC HOSTKEYS ROOT CUR_SLOT FOOTER_COUNTS GEN_LINE…
mk_audit() {
  local f="$1" now="$2" hk="$3" root="$4" cur="$5" footer="$6"; shift 6
  { echo "LCP-OFFHOST/1 AUDIT now_utc=$now machine=$MACHINE hostkeys=$hk fsid=65b3a49f09c069d5 root=$root current_slot=$cur window=2"
    for l in "$@"; do echo "$l"; done
    echo "LCP-OFFHOST/1 AUDIT_END $footer"; } >"$f"
}
gen() {   # SLOT SET COMPLETE [SIZE]
  echo "generation slot=$1 set=$2 archive=present archive_size=${4:-12345} archive_mtime_utc=2026-09-30T03:50:12Z archive_sha256_prefix=0123456789ab archive_receipt=ok manifest=present manifest_receipt=ok manifest_valid=$3 complete=$3"
}
CLEAN="generations=2 complete=2 incomplete=0 pending=0 pending_stale=0 partial=0 partial_stale=0 orphans=0 quarantine=0 current_slot_complete=yes"
CUR=20260930-0315; PREV=20260929-0315
CURSET=leadcapture-20260930-031501.sql.gz; PREVSET=leadcapture-20260929-031501.sql.gz
run_v() {   # CASE NOW [VAR=value …]
  local case="$1" now="$2"; shift 2
  env AUDIT_LOG="$T/$case.audit" BACKUP_KNOWN_HOSTS="$T/backup.kh" PRIMARY_KNOWN_HOSTS="$T/primary.kh" NOW="$now" OFFHOST_LIB="$LIB" "$@" \
    bash "$VERIFIER" >"$T/out/$case.log" 2>&1; echo $?
}
summary() { grep -m1 -E '^OFFHOST_HEALTH=' "$T/out/$1.log" || true; }

mk_audit "$T/healthy.audit" 2026-09-30T05:00:07Z "$BFP" ok "$CUR" "$CLEAN" "$(gen "$PREV" "$PREVSET" yes)" "$(gen "$CUR" "$CURSET" yes)"
expect_eq "healthy at 05:00 → PASS" "$(run_v healthy "$NOWH")" 0
expect_eq "…summary" "$(summary healthy)" "OFFHOST_HEALTH=PASS slot=$CUR set=$CURSET archive_size=12345 generations=2 complete=2 expected=current"
expect_eq "exactly one summary line" "$(grep -c '^OFFHOST_HEALTH=' "$T/out/healthy.log")" 1
has "$T/out/healthy.log" "^identity: backup_vps_machine=[0-9a-f]{12} same_host=no pinned_hostkey=reported$" "identity line is sanitized"

cp "$T/healthy.audit" "$T/late.audit"; sed -i 's/now_utc=2026-09-30T05:00:07Z/now_utc=2026-09-30T22:59:50Z/' "$T/late.audit"
expect_eq "GitHub start 18 h late → still PASS (slot-aware)" "$(run_v late "$(ts '2026-09-30 23:00:00')")" 0
has "$T/out/late.log" "expected=current$" "…expects the current slot"

mk_audit "$T/early.audit" 2026-09-30T03:20:01Z "$BFP" ok "$CUR" "generations=1 complete=1 incomplete=0 pending=0 pending_stale=0 partial=0 partial_stale=0 orphans=0 quarantine=0 current_slot_complete=no" "$(gen "$PREV" "$PREVSET" yes)"
expect_eq "run before the transfer grace with only yesterday's generation → PASS" "$(run_v early "$(ts '2026-09-30 03:20:00')")" 0
expect_eq "…expects the previous slot" "$(summary early)" "OFFHOST_HEALTH=PASS slot=$PREV set=$PREVSET archive_size=12345 generations=1 complete=1 expected=previous"

cp "$T/early.audit" "$T/missing.audit"; sed -i 's/now_utc=2026-09-30T03:20:01Z/now_utc=2026-09-30T05:00:01Z/' "$T/missing.audit"
expect_eq "after the grace with only yesterday's generation → FAIL" "$(run_v missing "$NOWH")" 1
expect_eq "…expected-generation-missing" "$(summary missing)" "OFFHOST_HEALTH=FAIL reason=expected-generation-missing detail=slot=$CUR"

mk_audit "$T/incomplete.audit" 2026-09-30T05:00:07Z "$BFP" ok "$CUR" "generations=2 complete=1 incomplete=1 pending=0 pending_stale=0 partial=0 partial_stale=0 orphans=0 quarantine=0 current_slot_complete=no" "$(gen "$PREV" "$PREVSET" yes)" "$(gen "$CUR" "$CURSET" no)"
expect_eq "current generation incomplete → FAIL" "$(run_v incomplete "$NOWH")" 1
expect_eq "…expected-generation-incomplete" "$(summary incomplete)" "OFFHOST_HEALTH=FAIL reason=expected-generation-incomplete detail=slot=$CUR"

mk_audit "$T/small.audit" 2026-09-30T05:00:07Z "$BFP" ok "$CUR" "$CLEAN" "$(gen "$CUR" "$CURSET" yes 512)"
expect_eq "archive below the minimum size → FAIL" "$(run_v small "$NOWH")" 1
has "$T/out/small.log" "^OFFHOST_HEALTH=FAIL reason=archive-too-small detail=slot=$CUR$" "archive-too-small"

mk_audit "$T/two.audit" 2026-09-30T05:00:07Z "$BFP" ok "$CUR" "$CLEAN" "$(gen "$CUR" leadcapture-20260930-031501.sql.gz no)" "$(gen "$CUR" leadcapture-20260930-100000.sql.gz yes 22222)"
expect_eq "two generations in the slot: the complete one counts" "$(run_v two "$NOWH")" 0
has "$T/out/two.log" "^OFFHOST_HEALTH=PASS slot=$CUR set=leadcapture-20260930-100000.sql.gz archive_size=22222 " "…picks the complete generation"

printf 'primary.example %s\nprimary.example %s\n' "$PK1" "$BK" >"$T/primary-same.kh"; cp "$T/healthy.audit" "$T/samepin.audit"
expect_eq "backup host key pinned for the primary too → FAIL" "$(run_v samepin "$NOWH" PRIMARY_KNOWN_HOSTS="$T/primary-same.kh")" 1
has "$T/out/samepin.log" "^OFFHOST_HEALTH=FAIL reason=same-host-destination detail=pinned-hostkeys$" "same-host-destination (pinned-hostkeys)"
cp "$T/healthy.audit" "$T/samereported.audit"; sed -i "s|hostkeys=$BFP|hostkeys=$BFP,$PFP|" "$T/samereported.audit"
expect_eq "audited machine reports the primary's host key → FAIL" "$(run_v samereported "$NOWH")" 1
has "$T/out/samereported.log" "^OFFHOST_HEALTH=FAIL reason=same-host-destination detail=reported-hostkeys$" "same-host-destination (reported-hostkeys)"
cp "$T/healthy.audit" "$T/hkmis.audit"; sed -i "s|hostkeys=$BFP|hostkeys=SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA|" "$T/hkmis.audit"
expect_eq "reported host keys do not include the pinned one → FAIL" "$(run_v hkmis "$NOWH")" 1
has "$T/out/hkmis.log" "^OFFHOST_HEALTH=FAIL reason=hostkey-mismatch$" "hostkey-mismatch"
cp "$T/healthy.audit" "$T/hkunk.audit"; sed -i "s|hostkeys=$BFP|hostkeys=unknown|" "$T/hkunk.audit"
expect_eq "unreported host keys → FAIL" "$(run_v hkunk "$NOWH")" 1
has "$T/out/hkunk.log" "reason=destination-hostkeys-unreported$" "destination-hostkeys-unreported"

expect_eq "machine pin matches → PASS" "$(run_v pinok "$NOWH" AUDIT_LOG="$T/healthy.audit" EXPECTED_MACHINE="$MACHINE")" 0
expect_eq "machine pin mismatch → FAIL" "$(cp "$T/healthy.audit" "$T/pinbad.audit"; run_v pinbad "$NOWH" EXPECTED_MACHINE="$(printf 'other' | sha256sum | cut -c1-64)")" 1
has "$T/out/pinbad.log" "^OFFHOST_HEALTH=FAIL reason=machine-mismatch$" "machine-mismatch"

mk_audit "$T/stale.audit" 2026-09-30T05:00:07Z "$BFP" ok "$CUR" "generations=2 complete=2 incomplete=0 pending=1 pending_stale=0 partial=2 partial_stale=1 orphans=0 quarantine=0 current_slot_complete=yes" "$(gen "$PREV" "$PREVSET" yes)" "$(gen "$CUR" "$CURSET" yes)"
expect_eq "stale partial upload → FAIL" "$(run_v stale "$NOWH")" 1
has "$T/out/stale.log" "^OFFHOST_HEALTH=FAIL reason=stale-incoming-files detail=partial_stale=1,pending_stale=0$" "stale-incoming-files"
mk_audit "$T/fresh.audit" 2026-09-30T05:00:07Z "$BFP" ok "$CUR" "generations=2 complete=2 incomplete=0 pending=1 pending_stale=0 partial=1 partial_stale=0 orphans=0 quarantine=1 current_slot_complete=yes" "$(gen "$PREV" "$PREVSET" yes)" "$(gen "$CUR" "$CURSET" yes)"
expect_eq "fresh incoming files and a quarantine entry are informational → PASS" "$(run_v fresh "$NOWH")" 0
mk_audit "$T/orphan.audit" 2026-09-30T05:00:07Z "$BFP" ok "$CUR" "generations=2 complete=2 incomplete=0 pending=0 pending_stale=0 partial=0 partial_stale=0 orphans=2 quarantine=0 current_slot_complete=yes" "$(gen "$PREV" "$PREVSET" yes)" "$(gen "$CUR" "$CURSET" yes)"
expect_eq "orphan files in the vault → FAIL" "$(run_v orphan "$NOWH")" 1
has "$T/out/orphan.log" "^OFFHOST_HEALTH=FAIL reason=orphan-files detail=orphans=2$" "orphan-files"

cp "$T/healthy.audit" "$T/skew.audit"; sed -i 's/now_utc=2026-09-30T05:00:07Z/now_utc=2026-09-30T06:30:00Z/' "$T/skew.audit"
expect_eq "remote clock 90 min off → FAIL" "$(run_v skew "$NOWH")" 1
has "$T/out/skew.log" "^OFFHOST_HEALTH=FAIL reason=clock-skew detail=seconds=5400$" "clock-skew"
cp "$T/healthy.audit" "$T/rootmissing.audit"; sed -i 's/ root=ok / root=missing /' "$T/rootmissing.audit"
expect_eq "vault root missing → FAIL" "$(run_v rootmissing "$NOWH")" 1
has "$T/out/rootmissing.log" "reason=vault-root-missing$" "vault-root-missing"
echo "LCP-OFFHOST/1 REJECTED reason=unsupported-command" >"$T/rejected.audit"
expect_eq "forced command rejected the request → FAIL" "$(run_v rejected "$NOWH")" 1
has "$T/out/rejected.log" "^OFFHOST_HEALTH=FAIL reason=audit-rejected detail=reason=unsupported-command$" "audit-rejected"
: >"$T/empty.audit"
expect_eq "empty listing → FAIL" "$(run_v empty "$NOWH")" 1
has "$T/out/empty.log" "reason=audit-header-missing$" "audit-header-missing"
head -n 2 "$T/healthy.audit" >"$T/nofooter.audit"
expect_eq "listing without footer → FAIL" "$(run_v nofooter "$NOWH")" 1
has "$T/out/nofooter.log" "reason=audit-footer-missing$" "audit-footer-missing"
expect_eq "missing known_hosts → FAIL" "$(run_v nokh "$NOWH" AUDIT_LOG="$T/healthy.audit" PRIMARY_KNOWN_HOSTS="$T/none")" 1
has "$T/out/nokh.log" "reason=primary-known-hosts-missing$" "primary-known-hosts-missing"

echo "== 3. summary line compatibility with the workflow extraction regex =="
WF_RE="$(grep -oE "grep -m1 -E '\^OFFHOST_HEALTH=[^']+'" "$WORKFLOW" | head -n 1 | sed -E "s/^grep -m1 -E '//; s/'$//")"
expect_true "workflow extraction regex found" test -n "$WF_RE"
for c in healthy early missing incomplete stale skew rejected; do
  line="$(summary "$c")"
  if printf '%s\n' "$line" | grep -qE "$WF_RE"; then ok "summary of '$c' matches the workflow regex"; else bad "summary of '$c' matches the workflow regex" "$line"; fi
done

echo "== 4. alert decision truth table =="
decide() {   # VERIFY_RESULT SIMULATED OPEN_ISSUE [SUMMARY]
  env VERIFY_RESULT="$1" SIMULATED="$2" OPEN_ISSUE="$3" SUMMARY="${4:-OFFHOST_HEALTH=PASS slot=$CUR set=$CURSET}" TRIGGER=schedule \
    RUN_URL="https://github.com/Delowar01/Exhibition-Lead-Pro/actions/runs/1/attempts/1" NOW=2026-09-30T05:10:00Z bash "$DECISION"
}
expect_eq "healthy + no issue → noop"        "$(decide success "" "" | sed -n 's/^action=//p')" noop
expect_eq "healthy + open issue → close"     "$(decide success "" 42 | sed -n 's/^action=//p')" close
expect_eq "unhealthy + no issue → create"    "$(decide failure "" "" "OFFHOST_HEALTH=FAIL reason=expected-generation-missing detail=slot=$CUR" | sed -n 's/^action=//p')" create
expect_eq "unhealthy + open issue → comment" "$(decide failure "" 42 "OFFHOST_HEALTH=FAIL reason=stale-incoming-files" | sed -n 's/^action=//p')" comment
expect_eq "simulated failure counts as unhealthy → create" "$(decide success true "" | sed -n 's/^action=//p')" create
expect_eq "simulated failure body says so" "$(decide success true "" | grep -c 'SIMULATED FAILURE (test)')" 1
expect_eq "cancelled job → create"           "$(decide cancelled "" "" | sed -n 's/^action=//p')" create
expect_eq "health=FAIL on cancelled"         "$(decide cancelled "" "" | sed -n 's/^health=//p')" FAIL
expect_eq "close body carries the recovery text" "$(decide success "" 42 | grep -c 'Closing this alert')" 1
expect_eq "create body names the runbook and the separate local alert" "$(decide failure "" "" | grep -c 'docs/BACKUP_OFFHOST_HOSTINGER.md')" 1
expect_eq "create body says the local alert is separate" "$(decide failure "" "" | grep -c 'local backup alert is a separate issue')" 1
expect_eq "non-numeric OPEN_ISSUE is ignored (create, not comment)" "$(decide failure "" '12;rm -rf' | sed -n 's/^action=//p')" create
expect_eq "invalid RUN_URL is replaced" "$(env VERIFY_RESULT=failure SUMMARY='OFFHOST_HEALTH=FAIL reason=x' RUN_URL='javascript:alert(1)' bash "$DECISION" | grep -c '(run url unavailable)')" 1
inj="$(decide failure "" "" "OFFHOST_HEALTH=FAIL reason=x \`id\` \$(id) $(printf 'A%.0s' $(seq 60))
newline")"
expect_eq "backticks and subshells are neutralised in the body" "$(printf '%s' "$inj" | grep -cE '`id`|\$\(id\)')" 0
expect_eq "long tokens are masked" "$(printf '%s' "$inj" | grep -c '<masked>')" 1
expect_eq "unparseable summary falls back to no-summary" "$(decide failure "" "" "garbage" | grep -c 'reason=no-summary')" 1

echo "== 5. workflow statics =="
wf() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {"d": d}))' "$T/workflow.json" "$1" 2>/dev/null; }
expect_eq "name" "$(wf 'd["name"]')" backup-offhost-hostinger
# PyYAML parses the `on` key as boolean true; json.dump renders that key as "true"
expect_eq "daily schedule after the transfer window" "$(wf 'd["true"]["schedule"][0]["cron"]')" "0 5 * * *"
expect_eq "dispatch input simulate_failure is a boolean defaulting to false" "$(wf 'd["true"]["workflow_dispatch"]["inputs"]["simulate_failure"]["type"]+"/"+str(d["true"]["workflow_dispatch"]["inputs"]["simulate_failure"]["default"])')" "boolean/False"
expect_eq "top-level permissions: contents read only" "$(wf 'd["permissions"]')" "{'contents': 'read'}"
expect_eq "audit job permissions: contents read only" "$(wf 'd["jobs"]["audit"]["permissions"]')" "{'contents': 'read'}"
expect_eq "alert job permissions: contents read + issues write" "$(wf 'd["jobs"]["alert"]["permissions"]')" "{'contents': 'read', 'issues': 'write'}"
expect_eq "issues: write appears in exactly one job" "$(grep -c '^      issues: write$' "$WORKFLOW")" 1
expect_eq "concurrency group without cancellation" "$(wf 'd["concurrency"]')" "{'group': 'backup-offhost-hostinger', 'cancel-in-progress': False}"
expect_eq "exact alert title" "$(wf 'd["env"]["ALERT_TITLE"]')" "[Backup Alert] Hostinger off-host backup unhealthy"
expect_eq "alert job runs always after the audit job" "$(wf 'd["jobs"]["alert"]["needs"]+"/"+d["jobs"]["alert"]["if"]')" "audit/always()"
expect_eq "audit job timeout" "$(wf 'd["jobs"]["audit"]["timeout-minutes"]')" 10
expect_eq "sparse checkout fetches only the verifier and the library" "$(wf 'd["jobs"]["audit"]["steps"][0]["with"]["sparse-checkout"].split()')" "['.github/scripts/verify-offhost-hostinger.sh', 'docker/scripts/offhost/offhost-lib.sh']"
expect_eq "checkout does not persist credentials" "$(wf 'all(s.get("with",{}).get("persist-credentials") is False for j in d["jobs"].values() for s in j["steps"] if "uses" in s)')" True
# every run script and env value of the workflow, one per line (comments and step names excluded)
wf 'chr(10).join((s.get("run") or "").replace(chr(10)," ") for j in d["jobs"].values() for s in j["steps"]) + chr(10) + chr(10).join(str(v) for j in d["jobs"].values() for v in (j.get("env") or {}).values()) + chr(10) + chr(10).join(str(v) for v in (d.get("env") or {}).values())' >"$T/wf-run.txt"
nothas "$T/wf-run.txt" "ssh-keyscan" "no ssh-keyscan in any run script"
has "$WORKFLOW" "StrictHostKeyChecking yes" "StrictHostKeyChecking yes"
has "$WORKFLOW" "IdentitiesOnly yes" "IdentitiesOnly yes"
has "$WORKFLOW" "BatchMode yes" "BatchMode yes"
expect_eq "exactly one ssh invocation and it is the list-only AUDIT verb" "$(grep -cE '^\s+ssh ' "$WORKFLOW")/$(grep -cE '^\s+ssh vault AUDIT ' "$WORKFLOW")" "1/1"
nothas "$T/wf-run.txt" "\b(scp|sftp|rsync|age|PUT|offhost-send|pg_dump|backup-postgres|restore)\b" "no transfer, upload, backup or restore command in any run script"
nothas "$T/wf-run.txt" "Hosted PostgreSQL backup unhealthy" "run scripts never reference the local backup alert title"
expect_eq "no secret expression inside a run script" "$(wf '[1 for j in d["jobs"].values() for s in j["steps"] if "secrets." in (s.get("run") or "")]')" "[]"
expect_eq "the simulated failure runs after the verifier, in the audit job" "$(wf '[s.get("id") for s in d["jobs"]["audit"]["steps"]][-3:]')" "['run', 'summary', 'simulate']"
expect_eq "simulate step gated on a manual dispatch with the input" "$(wf '[s for s in d["jobs"]["audit"]["steps"] if s.get("id")=="simulate"][0]["if"]')" "github.event_name == 'workflow_dispatch' && inputs.simulate_failure == true"
expect_eq "the alert job uses the decision script" "$(grep -c 'offhost-hostinger-alert-decision.sh' "$WORKFLOW")" 2
expect_eq "audit job has no issues permission" "$(wf '"issues" in d["jobs"]["audit"]["permissions"]')" False

echo "== 6. static: no cloud-storage provider assumptions; no dump bytes on the runner =="
code() { grep -vE '^[[:space:]]*#' "$@"; }
for term in 'storage\.googleapis' 'gserviceaccount' 'workloadIdentity' 'sts\.googleapis' 'iamcredentials' 'gcloud' 'GOOGLE_' 'ifGenerationMatch' 'me-central2' 'CNTXT' 'gsutil' 'OFFHOST_BUCKET' 'id-token' 'GCP' 'GCS'; do
  if code "$VERIFIER" "$DECISION" "$WORKFLOW" | grep -qiE -- "$term"; then bad "no reference to '$term' in the GitHub-side files"; else ok "no reference to '$term' in the GitHub-side files"; fi
done
expect_eq "the verifier reads only the listing file (no remote command)" "$(code "$VERIFIER" | grep -cE '\b(ssh|scp|curl|wget)\b')" 0
nothas "$T/healthy.audit" "PostgreSQL|COPY |CREATE TABLE" "the audit listing fixture carries no dump content (like the real listing)"

echo "== 7. leak scan over every verifier and decision output =="
cat "$T/out"/*.log >"$T/all.txt"
sed -E 's/machine=[0-9a-f]{64}/machine=<hash>/g' "$T/all.txt" >"$T/all-nomachine.txt"
nothas "$T/all-nomachine.txt" "[0-9a-f]{64}" "no complete checksum in any output (machine-id hash excluded)"
nothas "$T/all.txt" "$T" "no local path in any output"
nothas "$T/all.txt" "PRIVATE KEY|AGE-SECRET-KEY" "no key material in any output"
nothas "$T/all.txt" "$(printf '%s' "$BK" | awk '{print $2}')" "no host-key blob in any output (fingerprints only)"

echo
echo "RESULT: passed=$PASSED failed=$FAILED"
[ "$FAILED" = 0 ]
