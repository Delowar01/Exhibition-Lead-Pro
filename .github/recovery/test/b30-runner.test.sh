#!/bin/bash
# =============================================================================
# B30 RECOVERY RUNNER — LOCAL TEST SUITE (self-contained; NO docker daemon, NO network, NO host, NO secrets).
# Exercises the REAL runner library, the REAL host bootstrap, the REAL toolkit v1.1 backup script and the repository's
# REAL dump script (docker/scripts/backup-postgres.sh at the product commit) under a recording `docker` stub, against a
# synthetic encrypted-object volume (envelope headers only), a fake pg_dump stream, a throwaway backup tree and a
# detached worktree of the product commit as the "app directory", and the REAL registry / shared-id step of the workflow
# under a recording `gh` stub (GET only, synthetic registry JSON). Docker integration and hosted dispatch are NOT verified here.
# Usage: bash .github/recovery/test/b30-runner.test.sh   (from any directory inside the repository checkout)
# =============================================================================
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"; REC="$ROOT/.github/recovery"; KIT="$REC/toolkit"; STUB="$REC/test/stub"
PRODUCT_SHA="6a8dad1fe161dc1b31041794e5e3532e9f13327c"
T="$(mktemp -d)"; chmod 700 "$T"
pass=0; fail=0
t()  { local n="$1"; shift; if "$@" >/dev/null 2>&1; then pass=$((pass+1)); echo "ok   - $n"; else fail=$((fail+1)); echo "FAIL - $n"; fi; }
tv() { local n="$1" want="$2" got="$3"; if [ "$want" = "$got" ]; then pass=$((pass+1)); echo "ok   - $n ($got)"; else fail=$((fail+1)); echo "FAIL - $n (want '$want' got '$got')"; fi; }
has() { grep -qx -- "$2" <<<"$1"; }
cleanup() { cd "$ROOT" 2>/dev/null; [ -d "$T/app" ] && git worktree remove --force "$T/app" >/dev/null 2>&1; rm -rf "$T"; }
trap cleanup EXIT
umask 077

echo "== A. statics"
for f in "$REC/b30-runner-lib.sh" "$REC/b30-host-bootstrap.sh" "$KIT/b30-backup-set.sh" "$KIT/b30-restore-rehearsal.sh" "$KIT/b30-keyid-owner.sh" "$STUB/docker" "$0"; do t "bash -n $(basename "$f")" bash -n "$f"; done
W="$ROOT/.github/workflows/b25-stage1-inspection.yml"   # the REGISTERED path (workflow id 376505024), served by this branch
WOLD="$ROOT/.github/workflows/b30-recovery-runner.yml"   # the first, unregistered path — must be absent
REGP=".github/workflows/b25-stage1-inspection.yml"; OLDP=".github/workflows/b30-recovery-runner.yml"
t "workflow file present" test -f "$W"
if python3 -c 'import yaml' 2>/dev/null; then
  t "workflow YAML parses with 8 steps" python3 -c "import yaml,sys; d=yaml.safe_load(open('$W')); j=d['jobs']['recovery']; assert len(j['steps'])==8; assert j['if']==\"github.ref == 'refs/heads/ops/b30-recovery-runner' && github.event_name == 'workflow_dispatch'\"; on=d.get('on', d.get(True)); assert list(on['workflow_dispatch']['inputs'])==['mode','confirm_product_sha','confirm_recovery','confirm_quiet_period','confirm_paused','quiet_start','quiet_end']; assert d['concurrency']=={'group':'deploy-dev-vps','cancel-in-progress':False}; assert d['permissions']=={'contents':'read','actions':'read'}; assert on['workflow_dispatch']['inputs']['mode']['options']==['b30_recovery_check','b30_recovery_set']; n=[x.get('name','') for x in j['steps']]; assert n[1].startswith('Guard') and n[2].startswith('Validate inputs') and n[3].startswith('Validate secrets') and n[4].startswith('No other coordination run') and n[5].startswith('Install SSH key') and n[6].startswith('Recovery runner') and n[7].startswith('Remove runner-side files'), n"
else echo "note - PyYAML unavailable: YAML structure check skipped"; fi
pin() { grep -E "^  $1: " "$W" | awk '{print $2}'; }
tv "workflow pin = lib sha256" "$(sha256sum "$REC/b30-runner-lib.sh" | cut -c1-64)" "$(pin B30_LIB_SHA256)"
tv "workflow pin = bootstrap sha256" "$(sha256sum "$REC/b30-host-bootstrap.sh" | cut -c1-64)" "$(pin B30_BOOTSTRAP_SHA256)"
tv "workflow pin = toolkit SHA256SUMS sha256" "$(sha256sum "$KIT/SHA256SUMS" | cut -c1-64)" "$(pin B30_SUMS_SHA256)"
tv "workflow product pin" "$PRODUCT_SHA" "$(pin B30_PRODUCT_SHA)"
tv "registered workflow id constant" "376505024" "$(pin B30_REGISTERED_WORKFLOW_ID | tr -d '"')"
tv "workflow path constant = the registered path" "$REGP" "$(pin B30_WORKFLOW_PATH)"
t "old (unregistered) workflow path absent from the tree and the index" bash -c "! test -e '$WOLD' && cd '$ROOT' && [ -z \"\$(git ls-files '$OLDP')\" ]"
tv "ALLOWED_FILES lists the registered path and not the old one" "1 0" "$(grep -c '^\.github/workflows/b25-stage1-inspection\.yml$' "$REC/ALLOWED_FILES") $(grep -c 'b30-recovery-runner\.yml' "$REC/ALLOWED_FILES")"
t "scope guard regex names the registered path only" bash -c "grep -qF 'workflows/b25-stage1-inspection\\.yml' '$REC/b30-runner-lib.sh' && ! grep -q 'b30-recovery-runner' '$REC/b30-runner-lib.sh'"
t "no Stage 2B / migration / deployment mode or command reachable from the runner files" bash -c "! grep -qE 'stage2b_|migrate-storage|--copy|--verify|postverify|deploy-vps|compose up|compose down|drizzle' '$W' '$REC/b30-host-bootstrap.sh' '$REC/b30-runner-lib.sh'"
t "workflow never dispatches: GET-only API use, no POST / dispatches / gh workflow run, actions permission read" bash -c "! grep -qE 'method POST|/dispatches|gh workflow run|gh run (rerun|cancel)|actions: write|contents: write' '$W' && grep -q 'gh api --method GET' '$W' && grep -q '^  actions: read$' '$W'"
t "shared id 376505024 is SELF, never an allow-list entry (no duplicate)" bash -c "! grep -qE '^\s*\"376505024=' '$W' && grep -q 'SELF_ID=\"\$B30_REGISTERED_WORKFLOW_ID\"' '$W' && grep -q 'duplicate self entry' '$W'"
t "backup-health-alert is in the blocking (busy) loop" bash -c "grep -qF 'for e in \"\${ALLOW[@]}\" \"\${KNOWN_OTHER[@]}\" \"\$SELF_ID=\$SELF_PATH\"' '$W'"
t "no claim that pushing registers a dispatch-only workflow; check mode = product-data read-only; confirmations = attestation, not technical upload prevention (step order: guard, inputs, secrets, registry, SSH, host, cleanup asserted in the YAML check)" bash -c "! grep -qi 'Registered by pushing' '$W' '$REC/README.md' && grep -q 'PRODUCT-DATA READ-ONLY' '$W' && grep -q 'PRODUCT-DATA READ-ONLY' '$REC/README.md' && grep -qi 'NOT a technical upload' '$W' && grep -qi 'not.* a technical upload prevention' '$REC/README.md'"
t "bootstrap runs only the toolkit backup script (CHECK_ONLY + set), never the restore or key-id script" bash -c "[ \"\$(grep -cE 'bash \./b30-backup-set\.sh' '$REC/b30-host-bootstrap.sh')\" = 2 ] && ! grep -qE 'bash \./b30-(restore|keyid)' '$REC/b30-host-bootstrap.sh'"
t "toolkit SHA256SUMS verifies" bash -c "cd '$KIT' && LC_ALL=C sha256sum -c --quiet --strict SHA256SUMS"
tv "toolkit = 5 listed files + SHA256SUMS" "6" "$(ls -1 "$KIT" | wc -l | tr -d ' ')"
tv "no \${{ inputs }} inside run blocks (inputs reach shells via env only)" "0" "$(awk '/^        run: \|/{r=1;next} /^      - name:/{r=0} r && /\$\{\{ *inputs\./' "$W" | wc -l | tr -d ' ')"
tv "no \${{ secrets }} inside run blocks" "0" "$(awk '/^        run: \|/{r=1;next} /^      - name:/{r=0} r && /\$\{\{ *secrets\./' "$W" | wc -l | tr -d ' ')"
t "strict host key checking, no ssh-keyscan command" bash -c "grep -q 'StrictHostKeyChecking yes' '$W' && ! grep -qE '^\s*ssh-keyscan' '$W'"
t "ssh command is a constant (bash -s), stream built from %q assignments" bash -c "grep -q \"ssh vps 'bash -s' <\" '$W' && grep -q \"printf 'MODE=%q\" '$W' && grep -q \"printf 'B30_PAYLOAD_B64=%q\" '$W'"
t "host stdout captured to a file and filtered; stderr discarded" bash -c "grep -q 'b30-summary.raw\" 2>/dev/null' '$W' && grep -q 'b30_filter_summary <' '$W'"
t "runner removes its files always" bash -c "grep -q 'if: always()' '$W' && grep -q 'b30-stream.sh' '$W'"
tv "bootstrap invokes the set run exactly once (no loop, no retry)" "1" "$(grep -cE '&& B30_SCRIPT_DIR="\$KIT" KEEP=1000 B30_EXPECTED_UNREGISTERED=4 bash \./b30-backup-set\.sh \)' "$REC/b30-host-bootstrap.sh")"
tv "bootstrap invokes CHECK_ONLY exactly once" "1" "$(grep -c 'B30_CHECK_ONLY=1 B30_SCRIPT_DIR' "$REC/b30-host-bootstrap.sh")"
t "bootstrap never prints raw log lines (only out of fixed tokens)" bash -c "! grep -qE 'cat \"\\\$RAW\"|tail .*\"\\\$RAW\"' '$REC/b30-host-bootstrap.sh'"
t "toolkit files + lib + bootstrap are 0644 in git terms (no executable bit required; invoked with bash)" bash -c "cd '$ROOT' && [ -z \"\$(find .github/recovery -type f -name '*.sh' -perm /111 ! -path '*/test/stub/*')\" ]"
for f in $(grep -v '^#' "$REC/ALLOWED_FILES" | grep .); do t "allowed file exists: $f" test -f "$ROOT/$f"; done
t "production backup script untouched vs the product commit" bash -c "cd '$ROOT' && git diff --quiet $PRODUCT_SHA HEAD -- docker/scripts/backup-postgres.sh && [ -z \"\$(git status --porcelain -- docker/scripts/backup-postgres.sh)\" ]"
IDPAT="$(printf 'BEGIN (RSA|OPENSSH) PRIVATE|cl%saude|an%sthropic|session_01[0-9A-Za-z]{6,}' '' '')"
t "no secret / identifier strings in the recovery files" bash -c "! grep -rniE '$IDPAT' '$REC' '$W'"
t "toolkit v1.1 prechecks present (stale tmp, orphan sidecar, retention candidate, incomplete set)" bash -c "grep -q 'stale temporary dump' '$KIT/b30-backup-set.sh' && grep -q 'orphan sidecar' '$KIT/b30-backup-set.sh' && grep -q 'retention-pruning candidate' '$KIT/b30-backup-set.sh' && grep -q 'INCOMPLETE recovery set' '$KIT/b30-backup-set.sh'"

echo "== B. runner library — input validation and windows"
# shellcheck source=/dev/null
. "$REC/b30-runner-lib.sh"
export -f b30_filter_summary b30_refuse
NOW=$(( $(date -u -d '2026-11-02 12:30:00 UTC' +%s) ))   # fixed clock for the window tests (12:30 UTC)
vi() { # <mode> <sha> <rec> <quiet> <paused> <start> <end> → prints result token
  local o; o="$(MODE="$1" IN_PRODUCT_SHA="$2" IN_RECOVERY="$3" IN_QUIET="$4" IN_PAUSED="$5" IN_START="$6" IN_END="$7" B30_PRODUCT_SHA="$PRODUCT_SHA" NOW_EPOCH="$NOW" b30_validate_inputs 2>&1)"; local rc=$?
  if [ "$rc" = 0 ]; then echo "ok"; else printf '%s' "$o" | grep -oE 'b30_input_error=[a-z_]+' | cut -d= -f2; fi; }
OK_S="2026-11-02T12:00Z"; OK_E="2026-11-02T13:30Z"
tv "check mode, all empty" ok "$(vi b30_recovery_check '' '' '' '' '' '')"
tv "check mode refuses a confirmation" must_be_empty_in_check_mode "$(vi b30_recovery_check "$PRODUCT_SHA" '' '' '' '' '')"
tv "check mode refuses a window" must_be_empty_in_check_mode "$(vi b30_recovery_check '' '' '' '' "$OK_S" "$OK_E")"
tv "set mode positive" ok "$(vi b30_recovery_set "$PRODUCT_SHA" "$B30_REQ_RECOVERY" "$B30_REQ_QUIET" "$B30_REQ_PAUSED" "$OK_S" "$OK_E")"
tv "set mode missing product sha" confirmation_mismatch_product_sha "$(vi b30_recovery_set '' "$B30_REQ_RECOVERY" "$B30_REQ_QUIET" "$B30_REQ_PAUSED" "$OK_S" "$OK_E")"
tv "set mode wrong product sha" confirmation_mismatch_product_sha "$(vi b30_recovery_set "${PRODUCT_SHA/6a8/7a8}" "$B30_REQ_RECOVERY" "$B30_REQ_QUIET" "$B30_REQ_PAUSED" "$OK_S" "$OK_E")"
tv "set mode wrong recovery string" confirmation_mismatch_recovery "$(vi b30_recovery_set "$PRODUCT_SHA" "CREATE_B30_RECOVERY_SET" "$B30_REQ_QUIET" "$B30_REQ_PAUSED" "$OK_S" "$OK_E")"
tv "set mode missing quiet-period confirmation" confirmation_mismatch_quiet_period "$(vi b30_recovery_set "$PRODUCT_SHA" "$B30_REQ_RECOVERY" "" "$B30_REQ_PAUSED" "$OK_S" "$OK_E")"
tv "set mode missing paused assertion" confirmation_mismatch_paused "$(vi b30_recovery_set "$PRODUCT_SHA" "$B30_REQ_RECOVERY" "$B30_REQ_QUIET" "paused" "$OK_S" "$OK_E")"
tv "set mode extra text in a confirmation" confirmation_mismatch_recovery "$(vi b30_recovery_set "$PRODUCT_SHA" "$B30_REQ_RECOVERY " "$B30_REQ_QUIET" "$B30_REQ_PAUSED" "$OK_S" "$OK_E")"
tv "unknown mode" unknown_mode "$(vi b30_recovery_copy "$PRODUCT_SHA" "$B30_REQ_RECOVERY" "$B30_REQ_QUIET" "$B30_REQ_PAUSED" "$OK_S" "$OK_E")"
wc_() { local o; o="$(b30_window_check "$1" "$2" "$3" 2>&1)"; local rc=$?; if [ "$rc" = 0 ]; then echo ok; else printf '%s' "$o" | grep -oE 'b30_input_error=[a-z_]+' | cut -d= -f2; fi; }
tv "window malformed (no Z)" timestamp_malformed "$(wc_ 2026-11-02T12:00 "$OK_E" "$NOW")"
tv "window malformed (seconds)" timestamp_malformed "$(wc_ 2026-11-02T12:00:00Z "$OK_E" "$NOW")"
tv "window invalid date" timestamp_invalid "$(wc_ 2026-13-40T12:00Z "$OK_E" "$NOW")"
tv "window spans days" window_spans_days "$(wc_ 2026-11-02T23:30Z 2026-11-03T00:30Z "$(date -u -d '2026-11-02 23:45:00 UTC' +%s)")"
tv "window order" window_order "$(wc_ "$OK_E" "$OK_S" "$NOW")"
tv "window too long" window_too_long "$(wc_ 2026-11-02T12:00Z 2026-11-02T16:30Z "$NOW")"
tv "window not started" window_not_started "$(wc_ 2026-11-02T13:00Z 2026-11-02T14:00Z "$NOW")"
tv "window expired" window_expired "$(wc_ 2026-11-02T11:00Z 2026-11-02T12:00Z "$NOW")"
tv "window remaining too short" window_remaining_too_short "$(wc_ 2026-11-02T12:00Z 2026-11-02T12:35Z "$NOW")"
tv "window overlaps nightly backup exclusion" window_overlaps_exclusion "$(wc_ 2026-11-02T02:30Z 2026-11-02T03:30Z "$(date -u -d '2026-11-02 02:40:00 UTC' +%s)")"
tv "window overlaps backup-health exclusion" window_overlaps_exclusion "$(wc_ 2026-11-02T10:30Z 2026-11-02T11:30Z "$(date -u -d '2026-11-02 10:40:00 UTC' +%s)")"
tv "window just after the health exclusion" ok "$(wc_ 2026-11-02T10:45Z 2026-11-02T11:45Z "$(date -u -d '2026-11-02 10:50:00 UTC' +%s)")"
tv "window written as ending at 00:00Z of the same day is refused (same-day rule; use 23:59Z)" window_order "$(wc_ 2026-11-02T22:30Z 2026-11-02T00:00Z "$(date -u -d '2026-11-02 23:00:00 UTC' +%s)")"

echo "== C. runner library — identity, scope, pins, filter"
export GH_REPOSITORY="owner/repo"
gi() { GH_REF="$1" GH_SHA="$2" GH_WORKFLOW_REF="$3" EXPECTED_REF="refs/heads/ops/b30-recovery-runner" EXPECTED_WORKFLOW_PATH="$REGP" b30_guard_identity 2>&1 | grep -oE '(b30_identity=ok|b30_input_error=[a-z_]+)' | head -1; }
HEADSHA="$(git -C "$ROOT" rev-parse HEAD)"
( cd "$ROOT" && tv "identity ok (registered path on this branch at HEAD)" "b30_identity=ok" "$(gi refs/heads/ops/b30-recovery-runner "$HEADSHA" "owner/repo/$REGP@refs/heads/ops/b30-recovery-runner")" )
( cd "$ROOT" && tv "identity refuses the OLD unregistered path" "b30_input_error=workflow_ref_mismatch" "$(gi refs/heads/ops/b30-recovery-runner "$HEADSHA" "owner/repo/$OLDP@refs/heads/ops/b30-recovery-runner")" )
( cd "$ROOT" && tv "identity refuses the registered path on the Stage 2B branch ref" "b30_input_error=wrong_branch" "$(gi refs/heads/ops/b25-stage2b-migration-tooling "$HEADSHA" "owner/repo/$REGP@refs/heads/ops/b25-stage2b-migration-tooling")" )
( cd "$ROOT" && tv "identity refuses a workflow_ref that names the registered path at another ref" "b30_input_error=workflow_ref_mismatch" "$(gi refs/heads/ops/b30-recovery-runner "$HEADSHA" "owner/repo/$REGP@refs/heads/ops/b25-stage2b-migration-tooling")" )
( cd "$ROOT" && tv "identity wrong branch" "b30_input_error=wrong_branch" "$(gi refs/heads/develop "$HEADSHA" "owner/repo/$REGP@refs/heads/ops/b30-recovery-runner")" )
( cd "$ROOT" && tv "identity head mismatch" "b30_input_error=head_mismatch" "$(gi refs/heads/ops/b30-recovery-runner 1111111111111111111111111111111111111111 "owner/repo/$REGP@refs/heads/ops/b30-recovery-runner")" )
( cd "$ROOT" && tv "identity workflow ref mismatch" "b30_input_error=workflow_ref_mismatch" "$(gi refs/heads/ops/b30-recovery-runner "$HEADSHA" "owner/repo/.github/workflows/other.yml@refs/heads/ops/b30-recovery-runner")" )
# scope: throwaway repository with a base commit and recovery files
G="$T/g"; mkdir -p "$G"; ( cd "$G" && git init -q && git config user.email t@example.invalid && git config user.name t && mkdir -p src .github/recovery/toolkit .github/workflows && echo p > src/product.ts && git add -A && git commit -qm base )
BASE="$(git -C "$G" rev-parse HEAD)"
( cd "$G" && printf '.github/recovery/ALLOWED_FILES\n.github/recovery/b30-runner-lib.sh\n.github/workflows/b25-stage1-inspection.yml\n' > .github/recovery/ALLOWED_FILES && echo l > .github/recovery/b30-runner-lib.sh && echo w > .github/workflows/b25-stage1-inspection.yml && git add -A && git commit -qm recovery )
gs() { ( cd "$G" && b30_guard_scope "$1" .github/recovery/ALLOWED_FILES 2>&1 | grep -oE '(b30_scope=ok|b30_input_error=[a-z_]+)' | head -1 ); }
tv "scope ok" "b30_scope=ok" "$(gs "$BASE")"
tv "scope base not ancestor" "b30_input_error=base_not_ancestor" "$(gs 0000000000000000000000000000000000000001)"
( cd "$G" && echo x > .github/recovery/extra.sh && git add -A && git commit -qm extra ); tv "scope extra file" "b30_input_error=scope_mismatch" "$(gs "$BASE")"
( cd "$G" && git reset -q --hard HEAD~1 && echo changed > src/product.ts && git add -A && git commit -qm prod ); tv "scope product file modified" "b30_input_error=scope_mismatch" "$(gs "$BASE")"
( cd "$G" && git reset -q --hard HEAD~1 && echo dirty > .github/recovery/b30-runner-lib.sh ); tv "scope dirty worktree" "b30_input_error=worktree_dirty" "$(gs "$BASE")"; ( cd "$G" && git checkout -q -- . )
( cd "$G" && printf '.github/recovery/ALLOWED_FILES\n.github/recovery/b30-runner-lib.sh\n.github/workflows/b25-stage1-inspection.yml\n.github/workflows/b30-recovery-runner.yml\n' > .github/recovery/ALLOWED_FILES && echo o > .github/workflows/b30-recovery-runner.yml && git add -A && git commit -qm oldpath )
tv "scope refuses the old workflow path even when it is listed (only the registered path may differ)" "b30_input_error=scope_outside_recovery" "$(gs "$BASE")"; ( cd "$G" && git reset -q --hard HEAD~1 )
P="$T/pins.txt"; printf '%s  %s\n' "$(sha256sum "$REC/b30-runner-lib.sh" | cut -c1-64)" "$REC/b30-runner-lib.sh" > "$P"
tv "pins ok" "b30_pins=ok b30_pinned_files=1" "$(b30_guard_pins "$P")"
printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "$REC/b30-runner-lib.sh" > "$P"; tv "pins mismatch" "b30_input_error=pin_mismatch" "$(b30_guard_pins "$P")"
fs() { printf '%s' "$1" | b30_filter_summary >/dev/null 2>&1; echo $?; }
tv "filter accepts summary lines" "0" "$(fs $'B30_MODE=b30_recovery_check\nB30_RUNNER_RESULT=CHECK_OK\nB30_PRODUCT_COMMIT='"$PRODUCT_SHA"$'\nB30_SET_NAME=b30-20261102-120000\n')"
tv "filter rejects a free-text line" "1" "$(fs $'B30_MODE=b30_recovery_check\n[b30-backup] ERROR: something /opt/x\n')"
tv "filter rejects a 16-hex value (key id) in a non-commit key" "1" "$(fs $'B30_KEY_ID=0123456789abcdef\n')"
tv "filter rejects a 64-hex value" "1" "$(fs $'B30_DUMP=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n')"
tv "filter rejects an e-mail / path shaped value" "1" "$(fs $'B30_X=a@b.c\nB30_Y=/opt/thing\n')"
tv "filter rejects an env-assignment line" "1" "$(fs $'OBJECT_STORAGE_ENCRYPTION_KEY=abc\n')"

echo "== D. host bootstrap under the docker stub (REAL toolkit v1.1 + REAL repository dump script)"
APP="$T/app"; ( cd "$ROOT" && git worktree add -q --detach "$APP" "$PRODUCT_SHA" ) || { echo "FAIL - cannot create the product worktree"; exit 1; }
tv "app worktree = product commit, clean" "$PRODUCT_SHA 0" "$(git -C "$APP" rev-parse HEAD) $(git -C "$APP" status --porcelain | wc -l | tr -d ' ')"
VOL="$T/vol"; mkdir -p "$VOL"; chmod 700 "$VOL"
python3 -I - "$VOL" <<'PY'
import os,sys,json,uuid,secrets,struct
root=sys.argv[1]; kid=secrets.token_hex(8)
os.makedirs(os.path.join(root,"documents","1"),mode=0o700,exist_ok=True); os.makedirs(os.path.join(root,"documents"),mode=0o700,exist_ok=True)
os.chmod(os.path.join(root,"documents"),0o700)
for i in range(2):
    key=f"documents/1/{uuid.uuid4()}.bin"; hdr=json.dumps({"v":1,"k":kid,"n":secrets.token_hex(12),"c":"application/octet-stream","o":key}).encode()
    p=os.path.join(root,*key.split("/"))
    with open(p,"wb") as f: f.write(b"LCPO"+bytes([1])+struct.pack(">H",len(hdr))+hdr+secrets.token_bytes(64))
    os.chmod(p,0o600)
os.makedirs(os.path.join(root,"health"),mode=0o700,exist_ok=True); os.chmod(os.path.join(root,"health"),0o700)
hp=os.path.join(root,"health",str(uuid.uuid4()))
open(hp,"wb").write(b"ok"); os.chmod(hp,0o600)
print("fixture ok")
PY
voldigest() { ( cd "$VOL" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16 ); }
VOL0="$(voldigest)"
DUMP="$T/fake-dump.sql"; { echo "--"; echo "-- PostgreSQL database dump"; echo "--"; echo "SET client_encoding = 'UTF8';"; echo "CREATE TABLE public.storage_objects (id uuid);"; echo "ALTER TABLE public.storage_objects OWNER TO lcp_dev;"; echo "COPY public.storage_objects (id) FROM stdin;"; for i in $(seq 1 60); do head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; echo; done; echo '\.'; echo "--"; echo "-- PostgreSQL database dump complete"; echo "--"; echo '\unrestrict abc123'; } > "$DUMP"
BK="$T/backups"; ST="$T/state"; HM="$T/home"; mkdir -p "$BK" "$ST" "$HM"; chmod 700 "$BK" "$ST" "$HM"; echo "$PRODUCT_SHA" > "$ST/current-deploy.sha"
INV="inventory_total=2 inventory_active=2 inventory_active_fs=2 inventory_active_fs_migrated=0 inventory_active_gcs=0 inventory_deleted=0 inventory_other_states=0"
SUMS_SHA="$(sha256sum "$KIT/SHA256SUMS" | cut -c1-64)"
mkpayload() { tar -cf "$T/payload.tar" --owner=0 --group=0 --numeric-owner -C "${1:-$KIT}" . && base64 -w0 "$T/payload.tar"; }
PAYLOAD="$(mkpayload)"
# run_host <mode> <start> <end> [NAME=value ...]  → OUT (filtered summary), RC, RAWOUT; mirrors the workflow's stream
run_host() {
  local mode="$1" qs="$2" qe="$3"; shift 3
  local pins="${PIN_OVERRIDE:-$SUMS_SHA}" payload="${PAYLOAD_OVERRIDE:-$PAYLOAD}"
  { printf 'MODE=%q\n' "$mode"; printf 'B30_PRODUCT_SHA=%q\n' "$PRODUCT_SHA"; printf 'B30_SUMS_SHA256=%q\n' "$pins"; printf 'QUIET_START=%q\n' "$qs"; printf 'QUIET_END=%q\n' "$qe"; printf 'DEPLOY_PATH=%q\n' "$APP"; printf 'B30_PAYLOAD_B64=%q\n' "$payload"; cat "$REC/b30-host-bootstrap.sh"; } > "$T/stream.sh"
  : > "$T/stub.log"
  env -i PATH="$STUB:$PATH" HOME="$HM" BACKUP_DIR="$BK" STATE_DIR="$ST" B31_STUB_LOG="$T/stub.log" B31_FAKE_VOLUME="$VOL" B31_FAKE_DUMP_SQL="$DUMP" B31_FP="30c4ecbd867cd2cd59abcb58581ecb04" B31_INV="$INV" B31_PRODUCT_SHA="$PRODUCT_SHA" "$@" bash -s < "$T/stream.sh" > "$T/host.out" 2>"$T/host.err"; RC=$?
  RAWOUT="$(cat "$T/host.out")"
  OUT="$(b30_filter_summary < "$T/host.out")"; FRC=$?
}
val() { printf '%s\n' "$OUT" | grep -E "^$1=" | head -1 | cut -d= -f2-; }
LOGS="$BK/recovery-sets/runner-logs"
echo "-- D1 check mode positive"
run_host b30_recovery_check "" ""
tv "D1 exit 0" 0 "$RC"; tv "D1 filter accepted every line" 0 "$FRC"; tv "D1 result" CHECK_OK "$(val B30_RUNNER_RESULT)"
tv "D1 preconditions" ok "$(val B30_PRECONDITIONS)"; tv "D1 existing dumps" 0 "$(val B30_EXISTING_DUMPS)"; tv "D1 toolkit verified" verified "$(val B30_TOOLKIT)"; tv "D1 toolkit files" 6 "$(val B30_TOOLKIT_FILES)"
tv "D1 product commit reported" "$PRODUCT_SHA" "$(val B30_PRODUCT_COMMIT)"; tv "D1 keep/expected/phase" "1000 4 pre-copy" "$(val B30_KEEP) $(val B30_EXPECTED_UNREGISTERED) $(val B30_SET_PHASE)"
tv "D1 host stderr empty" 0 "$(wc -c < "$T/host.err")"
tv "D1 raw log retained on the host, mode 600" "600" "$(stat -c %a "$LOGS"/b30-b30_recovery_check-*.log 2>/dev/null | head -1)"
tv "D1 nothing created in the backup dir besides runner-logs" "" "$(cd "$BK" && find . -mindepth 1 ! -path './recovery-sets' ! -path './recovery-sets/runner-logs*' | tr '\n' ' ')"
tv "D1 volume unchanged" "$VOL0" "$(voldigest)"
tv "D1 live volume mounted only read-only (inspect is a read)" 0 "$(grep 'card-scanner-pro_objectdata' "$T/stub.log" | grep -v '^volume inspect' | grep -vc ':/src:ro' )"
t "D1 no raw toolkit line in stdout" bash -c "! grep -q '\[b30-backup\]' '$T/host.out'"
echo "-- D2 set mode positive (window around the current time, as a real dispatch would be)"
WS="$(date -u -d '-30 min' +%Y-%m-%dT%H:%MZ)"; WE="$(date -u -d '+60 min' +%Y-%m-%dT%H:%MZ)"
run_host b30_recovery_set "$WS" "$WE"
tv "D2 exit 0" 0 "$RC"; tv "D2 filter accepted" 0 "$FRC"; tv "D2 result" SET_VERIFIED "$(val B30_RUNNER_RESULT)"; tv "D2 marker" VERIFIED "$(val B30_SET_MARKER)"
tv "D2 set exit" 0 "$(val B30_SET_EXIT)"; t "D2 set name shape" bash -c "[[ '$(val B30_SET_NAME)' =~ ^b30-[0-9]{8}-[0-9]{6}$ ]]"
tv "D2 inventory counts" "2 2 2 0 0 0 0" "$(val B30_INV_TOTAL) $(val B30_INV_ACTIVE) $(val B30_INV_ACTIVE_FS) $(val B30_INV_ACTIVE_FS_MIGRATED) $(val B30_INV_ACTIVE_GCS) $(val B30_INV_DELETED) $(val B30_INV_OTHER_STATES)"
tv "D2 checks" "MATCH OK MATCH valid none MATCH single" "$(val B30_FINGERPRINT) $(val B30_SHA256SUMS) $(val B30_TENANT_FILES) $(val B30_HEADERS) $(val B30_SYMLINKS) $(val B30_ARCHIVE_FILES) $(val B30_KEY_ID)"
tv "D2 archive regular = tenant + health" "3 2 1" "$(val B30_ARCHIVE_REGULAR) $(val B30_VOLUME_TENANT_FILES) $(val B30_VOLUME_HEALTH_FILES)"
tv "D2 window sets existing before" 0 "$(val B30_WINDOW_SETS_EXISTING)"
SET1="$(ls -d "$BK"/recovery-sets/b30-* | head -1)"; t "D2 set directory with SHA256SUMS" bash -c "cd '$SET1' && sha256sum -c --quiet SHA256SUMS"
tv "D2 manifest set_phase / expected" "pre-copy 4" "$(grep -E '^set_phase=' "$SET1"/recovery-*.txt | cut -d= -f2) $(grep -E '^expected_unregistered_before_copy=' "$SET1"/recovery-*.txt | cut -d= -f2)"
tv "D2 volume unchanged" "$VOL0" "$(voldigest)"
tv "D2 one published dump (KEEP=1000, nothing pruned)" 1 "$(ls "$BK"/leadcapture-*.sql.gz | wc -l | tr -d ' ')"
t "D2 no key id / 64-hex / path / e-mail in the summary" bash -c "! grep -qE '[0-9a-f]{16}' <(printf '%s\n' \"\$1\" | grep -v B30_PRODUCT_COMMIT) && ! grep -qE '/opt/|/home/|@' <<<\"\$1\"" _ "$OUT"
t "D2 raw log contains the envelope key id line but the summary does not" bash -c "grep -q 'envelope_key_id=' '$LOGS'/b30-b30_recovery_set-*.log && ! grep -q 'envelope_key_id' <<<'$OUT'"
echo "-- D3 second execution in the same window"
run_host b30_recovery_set "$WS" "$WE"
tv "D3 refused" REFUSED_window_already_used "$(val B30_RUNNER_RESULT)"; tv "D3 exit 1" 1 "$RC"; tv "D3 existing sets in window" 1 "$(val B30_WINDOW_SETS_EXISTING)"
tv "D3 no second set created" 1 "$(ls -d "$BK"/recovery-sets/b30-* | wc -l | tr -d ' ')"
echo "-- D4 tampered toolkit payload"
mkdir -p "$T/kit2" && cp "$KIT"/* "$T/kit2"/ && printf '\n# tampered\n' >> "$T/kit2/b30-backup-set.sh"
PAYLOAD_OVERRIDE="$(mkpayload "$T/kit2")" run_host b30_recovery_check "" ""; tv "D4 refused hash mismatch" REFUSED_toolkit_hash_mismatch "$(val B30_RUNNER_RESULT)"; unset PAYLOAD_OVERRIDE
echo "-- D5 wrong toolkit pin"
PIN_OVERRIDE="0000000000000000000000000000000000000000000000000000000000000000" run_host b30_recovery_check "" ""; tv "D5 refused pin mismatch" REFUSED_toolkit_pin_mismatch "$(val B30_RUNNER_RESULT)"; unset PIN_OVERRIDE
echo "-- D6 extra file in the payload"
rm -rf "$T/kit3" && mkdir -p "$T/kit3" && cp "$KIT"/* "$T/kit3"/ && echo x > "$T/kit3/extra.sh"
PAYLOAD_OVERRIDE="$(mkpayload "$T/kit3")" run_host b30_recovery_check "" ""; tv "D6 refused extra entries" REFUSED_toolkit_extra_entries "$(val B30_RUNNER_RESULT)"; unset PAYLOAD_OVERRIDE
echo "-- D7 stale temporary dump present"
: > "$BK/.leadcapture-20261101.XXXX.tmp"; run_host b30_recovery_check "" ""
tv "D7 check failed" CHECK_FAILED "$(val B30_RUNNER_RESULT)"; tv "D7 class" stale_artifacts "$(val B30_FAILURE_CLASS)"; t "D7 stale file NOT deleted" test -e "$BK/.leadcapture-20261101.XXXX.tmp"; rm -f "$BK/.leadcapture-20261101.XXXX.tmp"
echo "-- D8 orphan sidecar present"
echo "0000000000000000000000000000000000000000000000000000000000000000  leadcapture-20261101-030000.sql.gz" > "$BK/leadcapture-20261101-030000.sql.gz.sha256"; run_host b30_recovery_check "" ""
tv "D8 class" orphan_sidecar "$(val B30_FAILURE_CLASS)"; t "D8 orphan NOT deleted" test -e "$BK/leadcapture-20261101-030000.sql.gz.sha256"; rm -f "$BK/leadcapture-20261101-030000.sql.gz.sha256"
echo "-- D9 retention-pruning candidates (1000 existing dumps, KEEP=1000)"
mkdir -p "$T/many"; for i in $(seq 1 999); do d="$(printf '2025%02d%02d-%04d' $(( (i-1)/28%12+1 )) $(( (i-1)%28+1 )) $((i%2400)))"; printf 'x' | gzip -c > "$T/many/leadcapture-$d.sql.gz"; ( cd "$T/many" && sha256sum "leadcapture-$d.sql.gz" > "leadcapture-$d.sql.gz.sha256" ); done
mv "$T/many"/leadcapture-* "$BK"/; n0="$(ls "$BK"/leadcapture-*.sql.gz | wc -l | tr -d ' ')"
run_host b30_recovery_check "" ""; tv "D9 class" retention_candidates "$(val B30_FAILURE_CLASS)"; tv "D9 dump count unchanged" "$n0" "$(ls "$BK"/leadcapture-*.sql.gz | wc -l | tr -d ' ')"
rm -f "$BK"/leadcapture-2025*; tv "D9 cleanup leaves the real dump" 1 "$(ls "$BK"/leadcapture-*.sql.gz | wc -l | tr -d ' ')"
echo "-- D10 incomplete set pending"
mkdir -p "$BK/recovery-sets/b30-20261101-010101" && : > "$BK/recovery-sets/b30-20261101-010101/.start"; run_host b30_recovery_check "" ""
tv "D10 class" incomplete_set "$(val B30_FAILURE_CLASS)"; t "D10 incomplete set NOT deleted" test -e "$BK/recovery-sets/b30-20261101-010101/.start"; rm -rf "$BK/recovery-sets/b30-20261101-010101"
echo "-- D11 Stage 2B copy lock present"
: > "$HM/.b25-stage2b-copy.lock"; run_host b30_recovery_check "" ""; tv "D11 class" lock "$(val B30_FAILURE_CLASS)"; rm -f "$HM/.b25-stage2b-copy.lock"
echo "-- D12 migrate container running"
run_host b30_recovery_check "" "" B31_PS_IMAGES="cardscanner/migrate:b25-stage2b-6a8dad1fe161"; tv "D12 class" migrate_container "$(val B30_FAILURE_CLASS)"
echo "-- D13 docker missing on the host"
mkdir -p "$T/nodocker"; for b in bash sh git tar gzip gunzip zcat sha256sum find ls cat grep awk sed cut tr head tail wc stat date mktemp chmod mkdir rm cp ln df basename dirname od id base64 sort env printf true false flock touch seq; do p="$(command -v $b 2>/dev/null || true)"; [ -n "$p" ] && ln -s "$p" "$T/nodocker/$b" 2>/dev/null; done
run_host b30_recovery_check "" "" PATH="$T/nodocker"
tv "D13 check failed closed without docker" CHECK_FAILED "$(val B30_RUNNER_RESULT)"; t "D13 class services/other" bash -c "[[ '$(val B30_FAILURE_CLASS)' =~ ^(services|other|volume)$ ]]"
echo "-- D14 backup failure mid-set (dump stream missing) → incomplete set preserved"
rm -rf "$BK"/recovery-sets/b30-2*; run_host b30_recovery_set 2026-11-02T14:00Z 2026-11-02T15:00Z B31_FAKE_DUMP_SQL=/nonexistent
tv "D14 result" SET_INCOMPLETE "$(val B30_RUNNER_RESULT)"; tv "D14 marker" INCOMPLETE "$(val B30_SET_MARKER)"; t "D14 class dump" bash -c "[[ '$(val B30_FAILURE_CLASS)' =~ ^(dump_failed|dump_invalid)$ ]]"
t "D14 incomplete set kept with .start" bash -c "ls -d '$BK'/recovery-sets/b30-*/.start >/dev/null"; tv "D14 exit 2" 2 "$RC"
INC="$(ls -d "$BK"/recovery-sets/b30-*/.start | head -1)"; rm -rf "$(dirname "$INC")"
echo "-- D15 active backup lock (nightly cron running)"
( exec 9>"$BK/.backup.lock"; flock 9; sleep 20 ) & LOCKPID=$!; sleep 0.5
run_host b30_recovery_set 2026-11-02T15:00Z 2026-11-02T16:00Z
tv "D15 result" SET_INCOMPLETE "$(val B30_RUNNER_RESULT)"; tv "D15 class" backup_running "$(val B30_FAILURE_CLASS)"; kill $LOCKPID 2>/dev/null; wait $LOCKPID 2>/dev/null
INC="$(ls -d "$BK"/recovery-sets/b30-*/.start 2>/dev/null | head -1)"; [ -n "$INC" ] && rm -rf "$(dirname "$INC")"
echo "-- D16 bootstrap refusals on malformed streamed variables"
run_host b30_recovery_copy "" ""; tv "D16 bad mode" REFUSED_bad_mode "$(val B30_RUNNER_RESULT)"
run_host b30_recovery_check 2026-11-02T12:00Z 2026-11-02T13:00Z; tv "D16 window in check mode" REFUSED_window_in_check_mode "$(val B30_RUNNER_RESULT)"
run_host b30_recovery_set 2026-11-02T12:00 2026-11-02T13:00Z; tv "D16 malformed window" REFUSED_bad_window "$(val B30_RUNNER_RESULT)"
run_host b30_recovery_set 2026-11-02T13:00Z 2026-11-02T12:00Z; tv "D16 inverted window" REFUSED_bad_window "$(val B30_RUNNER_RESULT)"
echo "-- D17 summarizer never passes raw text"
eval "$(sed -n '/^# ---- allow-listed summarizer/,/^# ---- 1\. the reviewed CHECK_ONLY/p' "$REC/b30-host-bootstrap.sh" | sed '1d;$d' | sed 's/^out() .*//')"; out() { printf '%s\n' "$*"; }
RAWX="$T/raw.log"; { echo "[b30-backup] 2026-11-02T12:00:00Z ERROR: named volume card-scanner-pro_objectdata not found /opt/secret/path user@example.com gs://bucket/key"; echo "volume_tenant_files=2 volume_health_files=1 volume_magic_ok=2 volume_header_bad=0 volume_symlinks=0 volume_key_ids=1 envelope_key_id=0123456789abcdef"; echo "dump_sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; echo "[b30-backup] fingerprint: MATCH"; echo "[b30-backup] envelope key id: single (recorded in the manifest)"; echo "[b30-backup] RECOVERY SET VERIFIED: b30-20261102-120000"; } > "$RAWX"
SUMX="$(summarize_set "$RAWX"; echo "B30_FAILURE_CLASS=$(classify_error "$RAWX")")"
t "D17 summary lines all allow-listed" bash -c "printf '%s\n' \"\$1\" | b30_filter_summary >/dev/null" _ "$SUMX"
t "D17 no path / e-mail / bucket / key id / digest in the summary" bash -c "! grep -qE '/opt|@|gs://|0123456789abcdef' <<<\"\$1\"" _ "$SUMX"
tv "D17 error classified as a fixed token" volume "$(printf '%s\n' "$SUMX" | grep '^B30_FAILURE_CLASS=' | cut -d= -f2)"
tv "D17 key id reported as single, never the value" single "$(printf '%s\n' "$SUMX" | grep '^B30_KEY_ID=' | cut -d= -f2)"
echo "-- D18 no mutation of the fixture volume across all scenarios"
tv "D18 volume digest unchanged" "$VOL0" "$(voldigest)"
tv "D18 stub docker never asked to write the live volume (no rw mount)" 0 "$(grep -c -- '-v card-scanner-pro_objectdata:/src ' "$T/stub.log")"

echo "== E. registry / shared-id guard — the REAL workflow step under a recording gh stub (GET only; no network)"
RS="$T/registry.sh"
awk '/name: No other coordination run/{p=1} p&&/^        run: \|/{r=1;next} r&&/^      - name:/{exit} r{sub(/^          /,""); print}' "$W" > "$RS"
t "registry step extracted from the workflow (set -euo pipefail first line)" bash -c "head -1 '$RS' | grep -q 'set -euo pipefail' && grep -q 'SELF_ID=' '$RS'"
GHS="$T/ghstub"; mkdir -p "$GHS"
cat > "$GHS/gh" <<'EOS'
#!/bin/bash
# recording gh stub: `gh api --method GET <path>` -> fixture $GH_FIX/<path with / ? & = replaced by _>.json ; missing -> exit 1 (API failure)
printf '%s\n' "$*" >> "$GH_LOG"
[ "${1:-}" = api ] && [ "${2:-}" = --method ] && [ "${3:-}" = GET ] && [ -n "${4:-}" ] || exit 2
f="$GH_FIX/$(printf '%s' "$4" | tr '/?&=' '____').json"
[ -f "$f" ] || exit 1
cat "$f"
EOS
chmod 755 "$GHS/gh"
RUN_ID=987654321; REPO_T="owner/repo"; SELF=376505024; SELFP="$REGP"
REGS=( "338196147=.github/workflows/deploy-dev-vps.yml" "358860432=.github/workflows/b20-hosted-activation.yml" "373189055=.github/workflows/b25-hosted-inspection.yml" "348767584=.github/workflows/b14-hosted-activation.yml" "350570859=.github/workflows/b15-schema-activation.yml" "352288831=.github/workflows/b16-hosted-activation.yml" "353075182=.github/workflows/b17-hosted-activation.yml" "353427348=.github/workflows/b18-hosted-activation.yml" "354083606=.github/workflows/b20-hosted-inspection.yml" "365534673=.github/workflows/backup-health-alert.yml" "$SELF=$SELFP" )
fixfile() { printf '%s/%s.json' "$FIX" "$(printf '%s' "$1" | tr '/?&=' '____')"; }
runs_json() { local n="$1"; shift; local arr="" i; for i in "$@"; do arr="$arr{\"id\":$i},"; done; printf '{"total_count":%s,"workflow_runs":[%s]}' "$n" "${arr%,}"; }
reg_json() { # prints a registry listing from REGS, with the self entry replaced by "$1|$2" when given, plus extra "id|state|path" entries from $3..
  local wfs="" e id p st n=0 selfid="${1:-}" selfp="${2:-}"; [ $# -ge 2 ] && shift 2 || set --
  for e in "${REGS[@]}"; do id="${e%%=*}"; p="${e#*=}"; if [ "$id" = "$SELF" ] && [ -n "$selfid" ]; then [ "$selfid" = none ] && continue; id="$selfid"; p="$selfp"; fi; wfs="$wfs{\"id\":$id,\"state\":\"active\",\"path\":\"$p\",\"name\":\"n$id\"},"; n=$((n+1)); done
  for e in "$@"; do IFS='|' read -r id st p <<<"$e"; wfs="$wfs{\"id\":$id,\"state\":\"$st\",\"path\":\"$p\",\"name\":\"x\"},"; n=$((n+1)); done
  printf '{"total_count":%s,"workflows":[%s]}' "$n" "${wfs%,}"
}
mkfix() { # fresh fixture: every registered workflow active, no runs anywhere except THIS run in_progress under SELF
  FIX="$T/fix"; rm -rf "$FIX"; mkdir -p "$FIX"; local e id p st
  reg_json > "$(fixfile "repos/$REPO_T/actions/workflows?per_page=100")"
  for e in "${REGS[@]}"; do id="${e%%=*}"; p="${e#*=}"
    printf '{"id":%s,"state":"active","path":"%s"}' "$id" "$p" > "$(fixfile "repos/$REPO_T/actions/workflows/$id")"
    for st in queued in_progress waiting; do runs_json 0 > "$(fixfile "repos/$REPO_T/actions/workflows/$id/runs?status=$st&per_page=100")"; done
  done
  runs_json 1 "$RUN_ID" > "$(fixfile "repos/$REPO_T/actions/workflows/$SELF/runs?status=in_progress&per_page=100")"
}
set_runs() { local id="$1" st="$2"; shift 2; runs_json "$@" > "$(fixfile "repos/$REPO_T/actions/workflows/$id/runs?status=$st&per_page=100")"; }
set_registry() { printf '%s' "$1" > "$(fixfile "repos/$REPO_T/actions/workflows?per_page=100")"; }
run_reg() { : > "$T/gh.log"; ROUT="$(cd "$T" && env -i PATH="$GHS:/usr/bin:/bin" HOME="$T" GH_FIX="$FIX" GH_LOG="$T/gh.log" GH_TOKEN=x THIS_RUN="$RUN_ID" REPO="$REPO_T" B30_REGISTERED_WORKFLOW_ID="$SELF" B30_WORKFLOW_PATH="$SELFP" bash "$RS" 2>&1)"; RRC=$?; }
mkfix; run_reg
tv "E1 baseline: no conflicting run → step passes" 0 "$RRC"
t "E1 self recognised as the registered id at the registered path; own run excluded exactly once" bash -c "grep -q 'self=$SELF at $SELFP, own run excluded 1x' <<<\"\$1\"" _ "$ROUT"
t "E1 every stub call was a GET (no dispatch, no POST)" bash -c "[ -s '$T/gh.log' ] && [ \"\$(grep -vc '^api --method GET ' '$T/gh.log')\" = 0 ]"
tv "E1 self workflow resolved by id exactly once; registry listed once" "1 1" "$(grep -c "^api --method GET repos/$REPO_T/actions/workflows/$SELF\$" "$T/gh.log") $(grep -c "^api --method GET repos/$REPO_T/actions/workflows?per_page=100\$" "$T/gh.log")"
tv "E1 runs of all 11 registered workflows queried in the three states" "33" "$(grep -c '/runs?status=' "$T/gh.log")"
mkfix; set_runs "$SELF" queued 1 111; run_reg
tv "E2 another QUEUED run of the shared id (a Stage 2A / 2B dispatch) blocks" 1 "$RRC"; t "E2 reason names the shared path, 1 other run" bash -c "grep -q \"$SELFP has 1 other run(s) in state queued\" <<<\"\$1\"" _ "$ROUT"
mkfix; set_runs "$SELF" in_progress 2 "$RUN_ID" 222; run_reg
tv "E3 another IN-PROGRESS run of the shared id besides this one blocks (this run excluded, the other counted)" 1 "$RRC"; t "E3 exactly one other counted" bash -c "grep -q 'has 1 other run(s) in state in_progress' <<<\"\$1\"" _ "$ROUT"
mkfix; set_runs "$SELF" in_progress 1 "$RUN_ID"; set_runs "$SELF" queued 1 "$RUN_ID"; run_reg
tv "E4 this run listed under two states (inconsistent API) → fail closed, never excluded twice" 1 "$RRC"; t "E4 reason" bash -c "grep -q 'excluded 2 times' <<<\"\$1\"" _ "$ROUT"
mkfix; set_runs "$SELF" in_progress 2 "$RUN_ID" "$RUN_ID"; run_reg
tv "E5 this run id listed twice under one state → fail closed" 1 "$RRC"
mkfix; set_runs 338196147 in_progress 1 "$RUN_ID"; run_reg
tv "E6 this run id attributed to another workflow → fail closed" 1 "$RRC"; t "E6 reason" bash -c "grep -q 'attributed to a different workflow' <<<\"\$1\"" _ "$ROUT"
mkfix; set_runs "$SELF" waiting 1 333; run_reg
tv "E7 a WAITING run of the shared id (Stage 2A / 2B on its own ref) blocks" 1 "$RRC"
mkfix; set_runs 365534673 in_progress 1 444; run_reg
tv "E8 backup-health-alert IN PROGRESS blocks (its SSH probe must not overlap)" 1 "$RRC"; t "E8 reason" bash -c "grep -q 'backup-health-alert.yml has 1 other run(s) in state in_progress' <<<\"\$1\"" _ "$ROUT"
mkfix; set_runs 365534673 queued 1 445; run_reg
tv "E9 backup-health-alert QUEUED blocks" 1 "$RRC"
mkfix; set_runs 338196147 in_progress 1 555; run_reg
tv "E10 deploy-dev-vps in progress blocks" 1 "$RRC"
mkfix; set_runs 373189055 queued 1 556; run_reg
tv "E11 an allow-listed inspection workflow queued blocks" 1 "$RRC"
mkfix; set_registry "$(reg_json "" "" '999000111|active|.github/workflows/new-thing.yml')"; run_reg
tv "E12 unknown ACTIVE registered workflow → fail closed" 1 "$RRC"; t "E12 reason" bash -c "grep -q 'registered but not classified' <<<\"\$1\"" _ "$ROUT"
mkfix; set_registry "$(reg_json "" "" '999000112|disabled_manually|.github/workflows/old-thing.yml')"; run_reg
tv "E13 a DISABLED unknown workflow cannot run and is ignored (same rule as the Stage 2B guard)" 0 "$RRC"
mkfix; rm -f "$(fixfile "repos/$REPO_T/actions/workflows?per_page=100")"; run_reg
tv "E14 registry query fails (API error) → STOP" 1 "$RRC"; t "E14 reason" bash -c "grep -q 'GitHub API query failed' <<<\"\$1\"" _ "$ROUT"
mkfix; rm -f "$(fixfile "repos/$REPO_T/actions/workflows/365534673/runs?status=queued&per_page=100")"; run_reg
tv "E15 a runs query fails (API error) → STOP (never treated as idle)" 1 "$RRC"
mkfix; printf 'not json' > "$(fixfile "repos/$REPO_T/actions/workflows/$SELF/runs?status=queued&per_page=100")"; run_reg
tv "E16 invalid JSON from the API → STOP" 1 "$RRC"
mkfix; : > "$(fixfile "repos/$REPO_T/actions/workflows/$SELF")"; run_reg
tv "E17 empty API body → STOP" 1 "$RRC"
mkfix; set_registry "$(reg_json 111222333 "$SELFP")"; run_reg
tv "E18 the registered path resolving to a different id → fail closed" 1 "$RRC"; t "E18 reason" bash -c "grep -q 'do not agree' <<<\"\$1\"" _ "$ROUT"
mkfix; set_registry "$(reg_json "$SELF" .github/workflows/elsewhere.yml)"; run_reg
tv "E19 the registered id at a different path → fail closed" 1 "$RRC"
mkfix; set_registry "$(reg_json none "")"; run_reg
tv "E20 the recovery workflow absent from the registry (unregistered) → fail closed" 1 "$RRC"; t "E20 reason" bash -c "grep -q 'not active exactly once' <<<\"\$1\"" _ "$ROUT"
mkfix; set_registry "$(reg_json "" "" "$SELF|active|$SELFP")"; run_reg
tv "E21 the self entry duplicated in the registry → fail closed" 1 "$RRC"
mkfix; printf '{"id":%s,"state":"disabled_manually","path":"%s"}' "$SELF" "$SELFP" > "$(fixfile "repos/$REPO_T/actions/workflows/$SELF")"; run_reg
tv "E22 self resolved by id must be active → a disabled self fails closed" 1 "$RRC"
mkfix; set_registry "$(printf '{"total_count":12,"workflows":%s}' "$(jq -c '.workflows' "$(fixfile "repos/$REPO_T/actions/workflows?per_page=100")")")"; run_reg
tv "E23 registry total_count ≠ returned entries (pagination) → STOP" 1 "$RRC"
mkfix; set_runs "$SELF" in_progress 0; run_reg
tv "E24 own run not (yet) listed by the API → nothing excluded, still passes with 0 others" 0 "$RRC"; t "E24 excluded 0x" bash -c "grep -q 'own run excluded 0x' <<<\"\$1\"" _ "$ROUT"
mkfix; run_reg; t "E25 no self-dispatch and no Stage 2B mode in the extracted step" bash -c "! grep -qE 'dispatches|POST|stage2b|workflow run' '$RS'"

echo "== RESULT pass=$pass fail=$fail (docker integration NOT verified: stub only; hosted dispatch NOT verified)"
[ "$fail" = 0 ]
