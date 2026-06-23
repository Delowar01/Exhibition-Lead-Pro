---
name: MFA company-required policy hook
description: Why computing an MFA "needed" flag is not the same as enforcing it at login.
---

# Company-required MFA must gate token issuance, not just enrolled users

When login computes a combined `mfaNeeded = user.mfaEnabled || company.mfaRequired`
but then only branches into the second-factor path on `user.mfaEnabled`, a user at a
company that mandates MFA but who has **not** enrolled falls through and receives a
full operational session. That silently bypasses the company policy.

**Why:** the "required" flag and the "enrolled" flag are independent. Enforcement has
two distinct outcomes: (a) enrolled → challenge for a code; (b) not-enrolled-but-
required → block the session and force enrollment. Collapsing them into one
`&& user.mfaEnabled` condition only handles (a).

**How to apply:** in `artifacts/api-server/src/routes/auth.ts` the login gate is
`if (mfaNeeded && !trusted)`, then split on `user.mfaEnabled`: enrolled returns
`{ mfaRequired, mfaToken }`; not-enrolled returns
`{ mfaRequired, mfaEnrollmentRequired, mfaToken }` with NO `token`/`refreshToken`.
Neither branch issues an operational token until the factor is satisfied, and neither
records a failed login attempt (password was correct — recording one would lock out a
legitimate unenrolled user via brute-force lockout). The self-service enrollment-on-
login UI is deferred to the Security Center phase; today the hook is dormant (no
company has the flag set, no admin UI toggles it yet) so it only needs to be correct.
Always test the not-enrolled-but-required path explicitly — it is the bypass.
