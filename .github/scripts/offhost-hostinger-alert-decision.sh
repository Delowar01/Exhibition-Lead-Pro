#!/bin/bash
# =============================================================================
# Lead Capture Pro — Hostinger off-host alert decision (deterministic truth table)
# =============================================================================
# Decides the GitHub Issue action of the `alert` job in
# backup-offhost-hostinger.yml from the read-only audit verdict. Health is
#   healthy ⇔ VERIFY_RESULT == success and SIMULATED != true
# Actions:
#   healthy   + open issue  → close   (recovery comment, then close)
#   healthy   + no issue    → noop
#   unhealthy + open issue  → comment (deduplicated)
#   unhealthy + no issue    → create
# The remote audit is authoritative: the primary-side sender's own result is
# never an input here. This alert is separate from the local backup alert
# ("[Backup Alert] Hosted PostgreSQL backup unhealthy"), which is never touched.
#
# Environment: VERIFY_RESULT, SUMMARY (verifier summary line), SIMULATED
# (true|""), OPEN_ISSUE (number|""), TRIGGER, RUN_URL, NOW (RFC3339, optional).
# Output: stdout `action=<create|comment|close|noop>`, `health=<PASS|FAIL>`,
# then a line `---BODY---` followed by the sanitized issue body (may be empty).
# =============================================================================
set -Eeuo pipefail

VERIFY_RESULT="${VERIFY_RESULT:-}"; SUMMARY="${SUMMARY:-}"; SIMULATED="${SIMULATED:-}"
OPEN_ISSUE="${OPEN_ISSUE:-}"; TRIGGER="${TRIGGER:-unknown}"; RUN_URL="${RUN_URL:-}"
NOW="${NOW:-$(date -u +%FT%TZ)}"

sanitize() {   # keep only the sanitized summary alphabet, then mask long tokens; cap length
  printf '%s' "$1" | tr -c 'A-Za-z0-9_.,:=/ ()-' '-' | sed -E 's/[A-Za-z0-9+\/=_-]{40,}/<masked>/g' | cut -c1-300
}
[[ "$OPEN_ISSUE" =~ ^[0-9]*$ ]] || OPEN_ISSUE=""
[[ "$RUN_URL" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]+(/attempts/[0-9]+)?$ ]] || RUN_URL="(run url unavailable)"
[[ "$TRIGGER" =~ ^[a-z_]+$ ]] || TRIGGER=unknown
[[ "$SIMULATED" =~ ^(true|)$ ]] || SIMULATED=""
summary="$(sanitize "${SUMMARY:-OFFHOST_HEALTH=FAIL reason=no-summary}")"
[[ "$summary" =~ ^OFFHOST_HEALTH=(PASS|FAIL) ]] || summary="OFFHOST_HEALTH=FAIL reason=no-summary"
result_s="$(sanitize "${VERIFY_RESULT:-unknown}")"

if [ "$VERIFY_RESULT" = success ] && [ "$SIMULATED" != true ]; then health=PASS; else health=FAIL; fi
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
      note="**SIMULATED FAILURE (test).** The read-only audit completed; the failure was injected in the workflow control flow. No backup, VPS or vault state was touched."$'\n\n'
    fi
    intro=""
    if [ "$action" = create ]; then
      intro="The daily read-only audit of the off-host copy of the hosted PostgreSQL backup on the separate Hostinger backup VPS did not pass. This issue is deduplicated: repeated failures are added as comments and it is closed automatically by the next healthy audit. The remote audit — not the primary-side sender — is the source of truth. The local backup alert is a separate issue. Runbook: docs/BACKUP_OFFHOST_HOSTINGER.md."$'\n\n'
    fi
    body="$(printf '%s%s- **Time (UTC):** %s\n- **Audit job result:** %s (trigger: %s)\n- **Sanitized summary:** `%s`\n- **Workflow run:** %s\n' \
      "$intro" "$note" "$NOW" "$result_s" "$TRIGGER" "$summary" "$RUN_URL")" ;;
  close)
    body="$(printf -- '- **Recovered (UTC):** %s\n- **Sanitized summary:** `%s`\n- **Workflow run:** %s\n\nClosing this alert; a later failure opens a new issue.' \
      "$NOW" "$summary" "$RUN_URL")" ;;
esac
echo "action=$action"
echo "health=$health"
echo "---BODY---"
printf '%s\n' "$body"
