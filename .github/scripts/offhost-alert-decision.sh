#!/bin/bash
# =============================================================================
# Lead Capture Pro — off-host alert decision (deterministic truth table)
# =============================================================================
# Decides the GitHub Issue action for the `alert` job from the INDEPENDENT AUDIT
# verdict; the uploader result is context only. Health is:
#   healthy   ⇔ AUDIT_RESULT == success and SIMULATED != true
# Actions:
#   healthy   + open issue  → close   (recovery comment, then close)
#   healthy   + no issue    → noop
#   unhealthy + open issue  → comment (deduplicated)
#   unhealthy + no issue    → create
# An upload failure with a remotely valid canonical set therefore never opens
# an issue (the recovery point exists); it is kept as sanitized context.
#
# Environment: AUDIT_RESULT, UPLOAD_RESULT, SUMMARY (audit summary line),
# UPLOAD_SUMMARY (uploader summary line), SIMULATED (true|""), OPEN_ISSUE
# (number|""), TRIGGER, RUN_URL, NOW (RFC3339, optional).
# Output: stdout `action=<create|comment|close|noop>`, `health=<PASS|FAIL>`,
# then a line `---BODY---` followed by the sanitized issue body (may be empty).
# =============================================================================
set -Eeuo pipefail

AUDIT_RESULT="${AUDIT_RESULT:-}"; UPLOAD_RESULT="${UPLOAD_RESULT:-}"
SUMMARY="${SUMMARY:-}"; UPLOAD_SUMMARY="${UPLOAD_SUMMARY:-}"
SIMULATED="${SIMULATED:-}"; OPEN_ISSUE="${OPEN_ISSUE:-}"
TRIGGER="${TRIGGER:-unknown}"; RUN_URL="${RUN_URL:-}"
NOW="${NOW:-$(date -u +%FT%TZ)}"

sanitize() {   # keep only the sanitized summary alphabet, then mask long tokens; cap length
  printf '%s' "$1" | tr -c 'A-Za-z0-9_.,:=/ ()-' '-' | sed -E 's/[A-Za-z0-9+\/=_-]{40,}/<masked>/g' | cut -c1-300
}
[[ "$OPEN_ISSUE" =~ ^[0-9]*$ ]] || OPEN_ISSUE=""
[[ "$RUN_URL" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]+(/attempts/[0-9]+)?$ ]] || RUN_URL="(run url unavailable)"
[[ "$TRIGGER" =~ ^[a-z_]+$ ]] || TRIGGER=unknown
[[ "$SIMULATED" =~ ^(true|)$ ]] || SIMULATED=""
audit_summary="$(sanitize "${SUMMARY:-OFFHOST_HEALTH=FAIL reason=no-summary}")"
upload_summary="$(sanitize "${UPLOAD_SUMMARY:-OFFHOST_UPLOAD=FAIL reason=no-summary}")"
[[ "$audit_summary" =~ ^OFFHOST_HEALTH=(PASS|FAIL) ]] || audit_summary="OFFHOST_HEALTH=FAIL reason=no-summary"
[[ "$upload_summary" =~ ^OFFHOST_UPLOAD=(PASS|AMBIGUOUS|FAIL) ]] || upload_summary="OFFHOST_UPLOAD=FAIL reason=no-summary"
audit_result_s="$(sanitize "$AUDIT_RESULT")"; upload_result_s="$(sanitize "${UPLOAD_RESULT:-unknown}")"

if [ "$AUDIT_RESULT" = success ] && [ "$SIMULATED" != true ]; then health=PASS; else health=FAIL; fi
if [ "$health" = PASS ]; then
  if [ -n "$OPEN_ISSUE" ]; then action=close; else action=noop; fi
else
  if [ -n "$OPEN_ISSUE" ]; then action=comment; else action=create; fi
fi

body=""
case "$action" in
  create|comment)
    note=""
    if [ "$SIMULATED" = true ]; then
      note="**SIMULATED FAILURE (test).** The list-only audit completed; the failure was injected in the workflow control flow. No bucket, backup or VPS state was touched."$'\n\n'
    fi
    intro=""
    if [ "$action" = create ]; then
      intro="The daily independent audit of the off-host copy of the hosted dev PostgreSQL backup did not pass. This issue is deduplicated: repeated failures are added as comments and it is closed automatically by the next healthy audit. The independent audit — not the uploader — is the source of truth; the upload line below is context. The local backup alert is a separate issue. Runbook: docs/BACKUP_AND_RECOVERY.md §5 (develop branch)."$'\n\n'
    fi
    body="$(printf '%s%s- **Time (UTC):** %s\n- **Audit job result:** %s (trigger: %s)\n- **Audit summary:** `%s`\n- **Upload job result (context only):** %s\n- **Upload summary (context only):** `%s`\n- **Workflow run:** %s\n' \
      "$intro" "$note" "$NOW" "$audit_result_s" "$TRIGGER" "$audit_summary" "$upload_result_s" "$upload_summary" "$RUN_URL")" ;;
  close)
    body="$(printf -- '- **Recovered (UTC):** %s\n- **Audit summary:** `%s`\n- **Upload summary (context only):** `%s`\n- **Workflow run:** %s\n\nClosing this alert; a later failure opens a new issue.' \
      "$NOW" "$audit_summary" "$upload_summary" "$RUN_URL")" ;;
esac
echo "action=$action"
echo "health=$health"
echo "---BODY---"
printf '%s\n' "$body"
