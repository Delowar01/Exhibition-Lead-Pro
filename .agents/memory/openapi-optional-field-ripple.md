---
name: OpenAPI optional-field ripple to all codegen consumers
description: Making a shared response field optional breaks every generated client, including ones you didn't touch.
---

# Loosening a shared OpenAPI response type ripples to ALL generated consumers

Relaxing a field on a shared schema (e.g. making `AuthResponse.token` optional so the
MFA branch can omit it) regenerates the Orval/Zod types for every client. A consumer
that previously relied on the field being non-optional now fails typecheck — even an
artifact unrelated to the change.

**Why:** there is one `lib/api-spec/openapi.yaml` and one codegen output shared by
web AND mobile. The web work that needed the optional field had no compile error, but
the Expo app's `app/login.tsx` passed `res.token` straight into `login(token: string)`
and broke. The root `pnpm run typecheck` is what surfaces it (the per-artifact web
typecheck alone will not).

**How to apply:** after any change that loosens a shared response shape, run the FULL
`pnpm run typecheck` (not just the artifact you edited) and guard every call site that
consumed the now-optional field. For mobile, MFA challenge is out of scope, so the
guard is `if (!res.token || !res.user) { show auth.mfaWebOnly; return; }` — keep
EN/AR locale parity when adding the message key.
