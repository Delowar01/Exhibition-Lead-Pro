#!/bin/bash
# =============================================================================
# Deterministic tests for .github/scripts/verify-hosted-backup.sh
# (B23 G-6 Correction 3B — slot-aware external backup freshness)
# =============================================================================
# Touches no VPS, no GitHub Issue and no secret. Three layers:
#   1. pure slot functions with fixed UTC epochs (the 2026-09-24 incident, the
#      03:15 boundaries, previous/next slots, malformed and future stamps, the
#      computed deployed-checker limit);
#   2. summary-line compatibility with the workflow's strict summary regex and
#      static checks of the workflow/verifier (simulated failure stays downstream,
#      no write/backup/restore/cron-edit/database command);
#   3. an end-to-end run of the verifier (fed on stdin like production) against a
#      synthetic hosted layout in a temporary directory with crontab/systemctl
#      shims. Set BACKUP_TEST_CHECKER / BACKUP_TEST_BACKUP_SCRIPT to the real
#      deployed scripts to exercise them; otherwise minimal stand-ins are used.
#
#     bash .github/scripts/test/verify-hosted-backup.test.sh
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFIER="$HERE/../verify-hosted-backup.sh"
WORKFLOW="$HERE/../../workflows/backup-health-alert.yml"
PASSED=0; FAILED=0
ok()  { PASSED=$((PASSED + 1)); echo "ok   $1"; }
bad() { FAILED=$((FAILED + 1)); echo "FAIL $1${2:+ — $2}"; }
expect_eq()    { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got '$2' want '$3'"; fi; }
expect_true()  { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
expect_false() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$d" "unexpectedly succeeded"; else ok "$d"; fi; }
ts() { date -u -d "$1" +%s; }

echo "== 0. syntax =="
expect_true "bash -n verifier" bash -n "$VERIFIER"
expect_true "bash -n this test" bash -n "${BASH_SOURCE[0]}"

# shellcheck disable=SC1090
VERIFY_HOSTED_BACKUP_LIB=1 source "$VERIFIER"
expect_false "library mode does not define main" declare -F main

echo "== 1. slot selection (UTC) =="
expect_eq "03:14:59 belongs to the previous day's slot" "$(slot_label "$(slot_expected_epoch "$(ts '2026-09-24 03:14:59')")")" "20260923-0315"
expect_eq "03:15:00 switches to today's slot"          "$(slot_label "$(slot_expected_epoch "$(ts '2026-09-24 03:15:00')")")" "20260924-0315"
expect_eq "09:25:32 (incident) uses today's slot"       "$(slot_label "$(slot_expected_epoch "$(ts '2026-09-24 09:25:32')")")" "20260924-0315"
expect_eq "13:53:00 (manual) uses today's slot"         "$(slot_label "$(slot_expected_epoch "$(ts '2026-09-24 13:53:00')")")" "20260924-0315"
expect_eq "next day 03:14:59 still uses the 09-24 slot" "$(slot_label "$(slot_expected_epoch "$(ts '2026-09-25 03:14:59')")")" "20260924-0315"
expect_eq "next day 03:15:00 requires the 09-25 slot"   "$(slot_label "$(slot_expected_epoch "$(ts '2026-09-25 03:15:00')")")" "20260925-0315"
expect_eq "00:00:00 belongs to the previous day's slot" "$(slot_label "$(slot_expected_epoch "$(ts '2026-09-24 00:00:00')")")" "20260923-0315"
expect_eq "23:59:59 belongs to today's slot"            "$(slot_label "$(slot_expected_epoch "$(ts '2026-09-24 23:59:59')")")" "20260924-0315"
expect_false "non-numeric now is rejected" slot_expected_epoch abc

echo "== 2. filename stamp parsing =="
expect_eq "stamp of leadcapture-20260924-031501.sql.gz" "$(backup_stamp_epoch leadcapture-20260924-031501.sql.gz)" "$(ts '2026-09-24 03:15:01')"
for bad_name in leadcapture-20260931-031501.sql.gz leadcapture-20260924-251501.sql.gz leadcapture-20260924-036001.sql.gz leadcapture-2026924-031501.sql.gz leadcapture-20260924-031501.sql.gz.tmp .leadcapture-20260924-031501.sql.gz leadcapture-20260229-031501.sql.gz; do
  expect_false "malformed/impossible stamp rejected: $bad_name" backup_stamp_epoch "$bad_name"
done
expect_true "leap day 20240229 accepted" backup_stamp_epoch leadcapture-20240229-031501.sql.gz

echo "== 3. freshness decision: the real incident and the boundaries =="
NOW=$(ts '2026-09-24 09:25:32'); SLOT=$(slot_expected_epoch "$NOW"); NEXT=$((SLOT + 86400))
STAMP=$(backup_stamp_epoch leadcapture-20260924-031501.sql.gz); MT=$(ts '2026-09-24 03:15:03')
expect_true  "T1 incident 09:25:32 — filename stamp 03:15:01 in slot" slot_contains "$NOW" "$SLOT" "$STAMP"
expect_true  "T1 incident 09:25:32 — mtime 03:15:03 in slot"          slot_contains "$NOW" "$SLOT" "$MT"
expect_eq    "T2 fixed-age rule would have seen 370 min (> 240 → old logic failed)" "$(( (NOW - MT) / 60 ))" "370"
NOW2=$(ts '2026-09-24 13:53:00')
expect_true  "T3 manual 13:53 — stamp in slot" slot_contains "$NOW2" "$(slot_expected_epoch "$NOW2")" "$STAMP"
expect_true  "T3 manual 13:53 — mtime in slot" slot_contains "$NOW2" "$(slot_expected_epoch "$NOW2")" "$MT"
PREV_STAMP=$(backup_stamp_epoch leadcapture-20260923-031501.sql.gz)
expect_false "T6 previous-day backup after today's slot started → not in slot" slot_contains "$NOW" "$SLOT" "$PREV_STAMP"
expect_false "T7 missing current-slot backup (newest candidate is previous slot) → fail" slot_contains "$NOW" "$SLOT" "$(ts '2026-09-23 03:15:03')"
expect_false "T8 previous-slot filename with refreshed mtime → stamp check fails" slot_contains "$NOW" "$SLOT" "$PREV_STAMP"
expect_true  "T8 (the refreshed mtime alone would pass — hence both are required)" slot_contains "$NOW" "$SLOT" "$((NOW - 60))"
expect_true  "T9 current filename stamp passes"                       slot_contains "$NOW" "$SLOT" "$STAMP"
expect_false "T9 ... but its previous-slot mtime fails"                slot_contains "$NOW" "$SLOT" "$(ts '2026-09-23 03:15:03')"
expect_false "T10 future filename stamp (2026-09-25 03:15:01) rejected" slot_contains "$NOW" "$SLOT" "$(backup_stamp_epoch leadcapture-20260925-031501.sql.gz)"
expect_false "T11 future mtime (now + 1 s) rejected"                    slot_contains "$NOW" "$SLOT" "$((NOW + 1))"
expect_true  "T13 controlled recovery backup later in the same slot (10:00:00) at 13:53" slot_contains "$NOW2" "$(slot_expected_epoch "$NOW2")" "$(backup_stamp_epoch leadcapture-20260924-100000.sql.gz)"
NOW3=$(ts '2026-09-25 03:14:59'); SLOT3=$(slot_expected_epoch "$NOW3")
expect_true  "T14 one second before the next slot: 09-24 backup still accepted" slot_contains "$NOW3" "$SLOT3" "$STAMP"
expect_true  "T14 ... and a 03:14:59 file of the current slot too"           slot_contains "$NOW3" "$SLOT3" "$NOW3"
NOW4=$(ts '2026-09-25 03:15:00'); SLOT4=$(slot_expected_epoch "$NOW4")
expect_false "T15 at the next slot boundary the 09-24 backup is rejected"      slot_contains "$NOW4" "$SLOT4" "$STAMP"
expect_true  "T15 ... and a backup stamped exactly 03:15:00 of the new slot passes" slot_contains "$NOW4" "$SLOT4" "$NOW4"
expect_false "slot_contains rejects a non-numeric candidate" slot_contains "$NOW" "$SLOT" "x"

echo "== 4. computed deployed-checker limit (from the slot age only) =="
expect_eq "incident 09:25:32 → ceil(6h10m)+1 = 8 h"        "$(checker_limit_hours "$NOW" "$SLOT")" "8"
expect_eq "manual 13:53:00 → ceil(10h38m)+1 = 12 h"        "$(checker_limit_hours "$NOW2" "$(slot_expected_epoch "$NOW2")")" "12"
expect_eq "on-time 04:30:00 → ceil(1h15m)+1 = 3 → min 4"   "$(checker_limit_hours "$(ts '2026-09-24 04:30:00')" "$SLOT")" "4"
expect_eq "exactly at the slot → 1 → min 4"                "$(checker_limit_hours "$SLOT" "$SLOT")" "4"
expect_eq "one second before the next slot → 25 (max)"      "$(checker_limit_hours "$NOW3" "$SLOT3")" "25"
expect_eq "negative age is clamped → min 4"                 "$(checker_limit_hours "$((SLOT - 100))" "$SLOT")" "4"
limits_ok=1
for off in $(seq 0 900 86399); do h=$(checker_limit_hours "$((SLOT + off))" "$SLOT"); [ "$h" -ge 4 ] && [ "$h" -le 25 ] || limits_ok=0; [ $(( off / 60 )) -le $(( h * 60 )) ] || limits_ok=0; done
expect_eq "sweep every 15 min across a slot: 4 <= limit <= 25 and the checker's age test always passes" "$limits_ok" "1"
expect_eq "incident: file age 370 min <= 8 h * 60"           "$(( 370 <= 8 * 60 ))" "1"
expect_eq "manual 13:53: file age 638 min <= 12 h * 60"      "$(( 638 <= 12 * 60 ))" "1"

echo "== 5. summary lines match the workflow's strict summary regex =="
REGEX="$(grep -oE "'\^BACKUP_HEALTH=[^']*'" "$WORKFLOW" | head -1 | tr -d "'")"
expect_true "regex extracted from the workflow" test -n "$REGEX"
for line in \
  "BACKUP_HEALTH=PASS file=leadcapture-20260924-031501.sql.gz slot=20260924-0315 age_minutes=370 size_bytes=404940" \
  "BACKUP_HEALTH=FAIL reason=expected-slot-backup-missing detail=expected_slot=20260924-0315,newest=leadcapture-20260923-031501.sql.gz,stamp_in_slot=no" \
  "BACKUP_HEALTH=FAIL reason=backup-mtime-outside-slot detail=expected_slot=20260924-0315,newest=leadcapture-20260924-031501.sql.gz,mtime_in_slot=no" \
  "BACKUP_HEALTH=FAIL reason=future-backup-timestamp detail=expected_slot=20260924-0315,newest=leadcapture-20260925-031501.sql.gz" \
  "BACKUP_HEALTH=FAIL reason=future-backup-mtime detail=expected_slot=20260924-0315,newest=leadcapture-20260924-031501.sql.gz" \
  "BACKUP_HEALTH=FAIL reason=malformed-backup-timestamp detail=expected_slot=20260924-0315,newest=leadcapture-20260931-031501.sql.gz" \
  "BACKUP_HEALTH=FAIL reason=unexpected-error step=newest-backup exit=1" \
  "BACKUP_HEALTH=FAIL reason=no-backup-file"; do
  if printf '%s\n' "$line" | grep -qE "$REGEX"; then ok "summary matches: ${line:0:70}"; else bad "summary does not match: $line"; fi
done
expect_false "a value with a space or path would NOT match (sanity)" bash -c "printf '%s\n' 'BACKUP_HEALTH=FAIL reason=x detail=/opt/some path' | grep -qE '$REGEX'"
for code in expected-slot-backup-missing backup-mtime-outside-slot future-backup-timestamp future-backup-mtime malformed-backup-timestamp; do
  expect_eq "verifier emits reason code $code exactly once" "$(grep -c "fail $code " "$VERIFIER")" "1"
done
expect_eq "fixed-age reason 'backup-too-old' no longer exists" "$(grep -c 'backup-too-old' "$VERIFIER")" "0"

echo "== 6. workflow: simulated failure stays downstream; no fixed limit passed over SSH =="
v_line="$(grep -n 'name: Run the read-only verifier over SSH' "$WORKFLOW" | cut -d: -f1)"
s_line="$(grep -n 'name: Simulated failure (TEST ONLY' "$WORKFLOW" | cut -d: -f1)"
expect_true "simulate step is defined after the verifier step" test -n "$v_line" -a -n "$s_line" -a "$v_line" -lt "$s_line"
expect_eq "simulate step gated on manual dispatch + input" "$(grep -c "if: github.event_name == 'workflow_dispatch' && inputs.simulate_failure == true" "$WORKFLOW")" "1"
expect_eq "no workflow input inside a run: script" "$(awk '/^ *run: \|/{r=1; next} /^ *- name:|^ *- uses:|^ *env:$|^ *if:|^ *id:|^ *with:/{r=0} r && /inputs\./' "$WORKFLOW" | wc -l)" "0"
expect_eq "no \${{ }} expression inside a run: script" "$(awk '/^ *run: \|/{r=1; next} /^ *- name:|^ *- uses:|^ *env:$|^ *if:|^ *id:|^ *with:/{r=0} r && /\$\{\{/' "$WORKFLOW" | wc -l)" "0"
expect_eq "ssh line no longer passes BACKUP_MAX_AGE_HOURS" "$(grep -c 'BACKUP_MAX_AGE_HOURS' "$WORKFLOW")" "0"
expect_eq "verifier is still piped on stdin (bash -s)" "$(grep -c 'bash -s" \\' "$WORKFLOW")" "1"
expect_eq "schedule unchanged" "$(grep -c 'cron: "30 4 \* \* \*"' "$WORKFLOW")" "1"
expect_eq "permissions unchanged (contents: read ×2, issues: write ×2)" "$(grep -c 'contents: read' "$WORKFLOW")/$(grep -c 'issues: write' "$WORKFLOW")" "2/2"
expect_eq "StrictHostKeyChecking yes / IdentitiesOnly yes / no ssh-keyscan" "$(grep -c 'StrictHostKeyChecking yes' "$WORKFLOW")/$(grep -c 'IdentitiesOnly yes' "$WORKFLOW")/$(grep -v '(no ssh-keyscan)' "$WORKFLOW" | grep -c 'ssh-keyscan')" "1/1/0"
expect_eq "concurrency cancel-in-progress: false" "$(grep -c 'cancel-in-progress: false' "$WORKFLOW")" "1"

echo "== 7. static scan of the verifier (non-comment lines) =="
# non-comment lines, minus the two string literals that spell out the EXPECTED crontab
# lines (they are compared with crontab -l, never executed)
NONC="$(grep -vE '^\s*#' "$VERIFIER" | grep -vE '^\s*exp_(backup|check)=')"
scan0() { local d="$1" pat="$2"; expect_eq "$d" "$(printf '%s\n' "$NONC" | grep -cE "$pat")" "0"; }
CMD='(^|[[:space:];&|(`])'
scan0 "no pg_dump/psql/pg_restore/docker/rclone/restic command" "${CMD}(pg_dump|psql|pg_restore|docker|rclone|restic)([[:space:]]|$)"
scan0 "no crontab other than crontab -l" 'crontab (-[^l]|[^ -])'
scan0 "no write commands (rm/mv/cp/tee/chmod/chown/touch/mkdir/ln/truncate/dd/sed -i)" "${CMD}(rm|mv|cp|tee|chmod|chown|touch|mkdir|ln|truncate|dd|sed -i)([[:space:]]|$)"
scan0 "no .env access" '\.env\b'
scan0 "backup-postgres.sh (backup + retention) is never executed" 'bash [^#]*backup-postgres\.sh'
# best-effort: any `>`/`>>` whose target is not /dev/null or a stream merge, ignoring the
# string comparison `[[ "$n" > "$newest_name" ]]` and the `<masked>` sed replacement text
expect_eq "no redirection into a file (only /dev/null and stderr merges)" "$(printf '%s\n' "$NONC" | grep -v '<masked>' | grep -v '\[\[ "\$n" > ' | grep -cE '(^|[^0-9&<])>{1,2} *"?[^&/ ]')" "0"
expect_eq "every git call uses --no-optional-locks" "$(printf '%s\n' "$NONC" | grep -c 'git -C')/$(printf '%s\n' "$NONC" | grep -c 'git -C "\$deploy_path" --no-optional-locks')" "$(printf '%s\n' "$NONC" | grep -c 'git -C')/$(printf '%s\n' "$NONC" | grep -c 'git -C')"
expect_eq "only the checker is executed under the deploy path" "$(printf '%s\n' "$NONC" | grep -cE 'bash "\$deploy_path')" "1"
expect_eq "no full 64-hex checksum printed (prefix only)" "$(printf '%s\n' "$NONC" | grep -cE 'echo .*\$(sc_sum|actual)\b[^:]')" "0"
expect_eq "fail-closed ERR trap present" "$(grep -c "trap 'rc=\$?; echo \"BACKUP_HEALTH=FAIL reason=unexpected-error" "$VERIFIER")" "1"
expect_eq "set -Eeuo pipefail present" "$(grep -c '^set -Eeuo pipefail$' "$VERIFIER")" "1"

echo "== 8. end-to-end against a synthetic hosted layout (verifier fed on stdin) =="
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/app/docker/scripts" "$T/env" "$T/backups" "$T/bin"; chmod 700 "$T/backups"
if [ -n "${BACKUP_TEST_CHECKER:-}" ]; then cp "$BACKUP_TEST_CHECKER" "$T/app/docker/scripts/backup-check.sh"; CHECKER_KIND="real ($BACKUP_TEST_CHECKER)"; else
  cat > "$T/app/docker/scripts/backup-check.sh" <<'EOC'
#!/bin/bash
# STAND-IN for docker/scripts/backup-check.sh (same age rule + gzip/marker; test only)
set -euo pipefail
BACKUP_DIR="${BACKUP_DIR:?}"; MAX="${BACKUP_MAX_AGE_HOURS:-26}"; cd "$BACKUP_DIR"
newest="$(ls -1t leadcapture-*.sql.gz | head -n 1)"; age=$(( ( $(date +%s) - $(stat -c %Y "$newest") ) / 60 ))
[ "$age" -le $(( MAX * 60 )) ] || { echo "[backup-check] FAIL: newest backup $newest is $age minutes old (limit ${MAX} h)" >&2; exit 1; }
gzip -t "$newest" && zcat "$newest" | tail -c 4096 | grep -q '^-- PostgreSQL database dump complete$' || { echo "[backup-check] FAIL: $newest" >&2; exit 1; }
echo "[backup-check] OK: $newest age=${age}min (limit ${MAX}h) stand-in"
EOC
  CHECKER_KIND="stand-in"; fi
if [ -n "${BACKUP_TEST_BACKUP_SCRIPT:-}" ]; then cp "$BACKUP_TEST_BACKUP_SCRIPT" "$T/app/docker/scripts/backup-postgres.sh"; else printf '#!/bin/bash\n# stand-in\nexit 0\n' > "$T/app/docker/scripts/backup-postgres.sh"; fi
chmod 775 "$T/app/docker/scripts/"*.sh
git -C "$T/app" init -q && git -C "$T/app" -c user.name=t -c user.email=t@t add -A && git -C "$T/app" -c user.name=t -c user.email=t@t commit -q -m init && git -C "$T/app" rev-parse HEAD > "$T/env/current-deploy.sha"
printf '#!/bin/bash\n[ "$1" = "-l" ] || exit 2\ncat "%s/crontab.txt"\n' "$T" > "$T/bin/crontab"
printf '#!/bin/bash\n[ "$1" = "is-active" ] && { echo active; exit 0; }\nexit 1\n' > "$T/bin/systemctl"; chmod 755 "$T/bin/"*
printf '15 3 * * * DEPLOY_PATH=%s BACKUP_DIR=%s KEEP=14 bash %s/docker/scripts/backup-postgres.sh >> %s/backup.log 2>&1\n45 3 * * * BACKUP_DIR=%s BACKUP_MAX_AGE_HOURS=4 bash %s/docker/scripts/backup-check.sh >> %s/backup.log 2>&1\n' "$T/app" "$T/backups" "$T/app" "$T/backups" "$T/backups" "$T/app" "$T/backups" > "$T/crontab.txt"
mkdump() { # $1 = name, $2 = mtime epoch
  { printf -- '--\n-- PostgreSQL database dump\n--\n'; printf 'CREATE TABLE public.a (x integer, y text);\nCOPY public.a (x, y) FROM stdin;\n'; for i in $(seq 1 40); do printf '%d\t%s\n' "$i" "$(head -c 60 /dev/urandom | base64 -w0)"; done; printf '\\.\n--\n-- PostgreSQL database dump complete\n--\n\n'; } | gzip -c > "$T/backups/$1"
  chmod 600 "$T/backups/$1"; ( cd "$T/backups" && sha256sum "$1" > "$1.sha256" && chmod 600 "$1.sha256" ); touch -d "@$2" "$T/backups/$1" "$T/backups/$1.sha256"
}
run() { PATH="$T/bin:$PATH" DEPLOY_PATH="$T/app" STATE_DIR="$T/env" BACKUP_DIR="$T/backups" bash -s < "$VERIFIER" > "$T/out.txt" 2>&1; echo $?; }
health() { grep -m1 '^BACKUP_HEALTH=' "$T/out.txt"; }
clean() { rm -f "$T/backups"/leadcapture-*; }
NOW_E=$(date -u +%s); SLOT_E=$(slot_expected_epoch "$NOW_E"); PREV_E=$((SLOT_E - 86400)); NEXT_E=$((SLOT_E + 86400))
CUR="leadcapture-$(date -u -d @"$((SLOT_E + 1))" +%Y%m%d-%H%M%S).sql.gz"; PREV="leadcapture-$(date -u -d @"$((PREV_E + 1))" +%Y%m%d-%H%M%S).sql.gz"; FUT="leadcapture-$(date -u -d @"$((NEXT_E + 1))" +%Y%m%d-%H%M%S).sql.gz"
echo "   deployed checker: $CHECKER_KIND; current slot $(slot_label "$SLOT_E"); wall-clock age of a 03:15 backup now: $(( (NOW_E - SLOT_E - 3) / 60 )) min (fixed 240-min rule would $( [ $(( (NOW_E - SLOT_E - 3) / 60 )) -gt 240 ] && echo FAIL || echo pass ))"
clean; mkdump "$CUR" "$((SLOT_E + 3))"
rc=$(run); expect_eq "E1 current-slot 03:15 backup → PASS (exit 0)" "$rc" "0"; expect_eq "E1 exactly one BACKUP_HEALTH line" "$(grep -c '^BACKUP_HEALTH=' "$T/out.txt")" "1"; expect_eq "E1 PASS summary names the file" "$(health | grep -c "^BACKUP_HEALTH=PASS file=$CUR slot=$(slot_label "$SLOT_E") ")" "1"
lim="$(grep -oE 'limit_hours=[0-9]+' "$T/out.txt" | cut -d= -f2)"; expect_eq "E1 checker limit printed equals the computed one" "$lim" "$(checker_limit_hours "$NOW_E" "$SLOT_E")"; expect_eq "E1 deployed checker received that limit" "$(grep -c "deployed-check: .*(limit ${lim}h)" "$T/out.txt")" "1"
expect_eq "E1 no ERR trap" "$(grep -c unexpected-error "$T/out.txt")" "0"
clean; mkdump "$PREV" "$((PREV_E + 3))"; rc=$(run); expect_eq "E2 only the previous-slot backup → expected-slot-backup-missing" "$(health)" "BACKUP_HEALTH=FAIL reason=expected-slot-backup-missing detail=expected_slot=$(slot_label "$SLOT_E"),newest=$PREV,stamp_in_slot=no"
clean; mkdump "$PREV" "$((NOW_E - 60))"; rc=$(run); expect_eq "E3 previous-slot filename with refreshed mtime → expected-slot-backup-missing" "$(health | cut -d' ' -f2)" "reason=expected-slot-backup-missing"
clean; mkdump "$CUR" "$((PREV_E + 3))"; rc=$(run); expect_eq "E4 current filename with previous-slot mtime → backup-mtime-outside-slot" "$(health | cut -d' ' -f2)" "reason=backup-mtime-outside-slot"
clean; mkdump "$FUT" "$((SLOT_E + 3))"; rc=$(run); expect_eq "E5 future filename stamp → future-backup-timestamp" "$(health | cut -d' ' -f2)" "reason=future-backup-timestamp"
clean; mkdump "$CUR" "$((NOW_E + 3600))"; rc=$(run); expect_eq "E6 future mtime → future-backup-mtime" "$(health | cut -d' ' -f2)" "reason=future-backup-mtime"
clean; rc=$(run); expect_eq "E7 no backup file → no-backup-file" "$(health)" "BACKUP_HEALTH=FAIL reason=no-backup-file"
clean; mkdump "$CUR" "$((SLOT_E + 3))"; mkdump "$PREV" "$((PREV_E + 3))"; rc=$(run); expect_eq "E8 current + previous files → PASS on the current one" "$(health | cut -d' ' -f1-2)" "BACKUP_HEALTH=PASS file=$CUR"
clean; LATE="leadcapture-$(date -u -d @"$((SLOT_E + 3600))" +%Y%m%d-%H%M%S).sql.gz"; if [ "$((SLOT_E + 3600))" -le "$NOW_E" ]; then mkdump "$LATE" "$((SLOT_E + 3602))"; rc=$(run); expect_eq "E9 controlled recovery backup one hour into the slot → PASS" "$(health | cut -d' ' -f1-2)" "BACKUP_HEALTH=PASS file=$LATE"; else echo "skip E9 (slot started less than an hour ago)"; fi
clean; mkdump "$CUR" "$((SLOT_E + 3))"; rm -f "$T/backups/$CUR.sha256"; rc=$(run); expect_eq "E10 integrity checks preserved: missing sidecar → sidecar-missing" "$(health)" "BACKUP_HEALTH=FAIL reason=sidecar-missing"
clean; mkdump "$CUR" "$((SLOT_E + 3))"; sed -i 's/^\(.\)/X/' "$T/backups/$CUR.sha256"; sed -i 's/^X/f/' "$T/backups/$CUR.sha256"; rc=$(run); expect_eq "E11 integrity checks preserved: checksum mismatch" "$(health)" "BACKUP_HEALTH=FAIL reason=checksum-mismatch"
clean; mkdump "$CUR" "$((SLOT_E + 3))"; echo 0000000000000000000000000000000000000000 > "$T/env/current-deploy.sha"; rc=$(run); expect_eq "E12 deployment drift still detected first" "$(health | cut -d' ' -f2)" "reason=deployment-drift"; git -C "$T/app" rev-parse HEAD > "$T/env/current-deploy.sha"
clean; mkdump "$CUR" "$((SLOT_E + 3))"; sed -i 's/^45 3/#45 3/' "$T/crontab.txt"; rc=$(run); expect_eq "E13 cron checks preserved: commented 03:45 entry" "$(health | cut -d' ' -f2)" "reason=check-cron-not-exactly-once"; sed -i 's/^#45 3/45 3/' "$T/crontab.txt"
rc=$(PATH="$T/bin:$PATH" DEPLOY_PATH="$T/app'; echo pwned; '" STATE_DIR="$T/env" BACKUP_DIR="$T/backups" bash -s < "$VERIFIER" > "$T/out.txt" 2>&1; echo $?); expect_eq "E14 invalid DEPLOY_PATH (injection attempt) rejected" "$(health)" "BACKUP_HEALTH=FAIL reason=invalid-deploy-path"

echo
echo "RESULT: passed=$PASSED failed=$FAILED"
[ "$FAILED" -eq 0 ]
