---
name: Email delivery-status honesty
description: Invitation/reset email tracking — honest statuses, worker outcome rules, token-in-path log redaction, and e2e token seeding traps.
---

## Rules
- Enqueueing is NOT delivery: producer returns `{sent:false, queued:true}`; the email worker records the persistent outcome (`sent`/`failed`/`skipped`) on the invitation row via `EmailMessage.meta.invitationId` (meta never goes to SMTP).
- Worker outcome classification: `skippedReason === "not_configured"` → `skipped`; any other non-thrown `sent:false` must be **thrown** so the queue retries and the final attempt records `failed`. Never map a non-delivery to `sent`.
- `failed` is recorded only on the final attempt (`job.attempts >= job.maxAttempts`), then rethrow for dead-letter. Outcome recording itself must never throw.

## Token hygiene
- Query-string stripping in the request logger is NOT enough: routes with secrets in the **path** (e.g. `GET /invitations/token/:token`) leak into logs. The pino-http `req` serializer must redact path segments (`/token/<x>` → `/token/[REDACTED]`).
- **Why:** raw invite/reset tokens in logs = replay risk for anyone with log access; found by code review after tests passed.

## Test seeding pattern
- App stores only SHA-256 hashes of tokens → tests generate raw tokens and insert/overwrite the hash directly in DB; no SMTP/email capture needed (API tests + Playwright).
- **Trap:** a real forgot-password request invalidates the target user's outstanding reset tokens (correct behavior) — e2e specs must not exercise forgot-password for the same user whose seeded token a later test consumes.
- Forgot-password rate limiter is keyed IP+normalized email (per-email) so shared-IP suites don't false-positive; the broad per-IP auth limiter still applies.
