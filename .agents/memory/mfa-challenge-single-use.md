---
name: MFA login challenge single-use pattern
description: password-verified MFA challenge tokens are jti-backed, server-consumed, single-use; consumption order matters
---

**Rule:** The MFA login challenge (mfaToken issued after password success) is not a bare signed JWT — it carries a `jti` whose sha256 is stored server-side (verification_tokens, type `mfa_challenge`, short TTL) and is consumed exactly once.

**Why:** A signed-JWT-only challenge is replayable for its whole TTL: anyone holding it can retry codes or reuse it after a successful login. Server-side consumption closes replay.

**How to apply:**
- Consume the row only AFTER the code verifies — a wrong code must NOT burn the challenge (user typo would force a re-login), but a replay after success must 401 and record a login_attempts reason (`mfa_challenge_replayed`).
- Reject challenges with unknown/missing jti even if the JWT signature and code are valid (forged/legacy format).
- The challenge token must be useless as an access token AND as a refresh token — assert both in tests.
- Company-required MFA for unenrolled users: return enrollment-required with NO operational token, and ensure the challenge cannot be verified into a session (no TOTP secret exists).
