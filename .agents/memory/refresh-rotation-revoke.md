---
name: Rotating refresh-token family revocation
description: How to revoke a refresh-token family safely without creating an unauthenticated forced-logout DoS.
---

# Refresh-token rotation: revoke the family only on PROVEN replay, and look up by an unguessable key

Two coupled rules for rotating refresh tokens with reuse detection:

1. **Look up the session by an unguessable key, never a serial id.** The refresh
   token prefix must be the family's random UUID (`<familyId>.<secret>`), not the
   serial session id. A serial-id prefix lets an attacker enumerate ids.
2. **Revoke the whole family only on a PROVEN replay** — i.e. the presented secret
   matches a *previously-valid* (rotated-out) hash. An arbitrary/unknown secret must
   be rejected (401) WITHOUT revoking.

**Why:** the first version revoked the family on ANY hash mismatch and keyed lookup
on the serial session id. Together that is an unauthenticated forced-logout DoS:
`POST /auth/refresh` with `<guessedSerialId>.<garbage>` mismatches → family revoked →
victim logged out, at enumeration scale. "Reuse detection" had been conflated with
"any invalid secret."

**How to apply:** store both the current secret hash and the immediately-prior
(`prevRefreshTokenHash`) one. On refresh: match current → rotate (and roll current
into prev); match prev → proven replay → revoke family; match neither → plain 401, no
revoke. Single-prev tracking catches the canonical theft case (attacker rotates the
stolen token, legit user replays the now-stale one); replaying an older-than-prev
token is just rejected, which is acceptable. Regression tests must assert BOTH: (a)
garbage secret for a valid family → 401 and the real token STILL works (no revoke),
and (b) true replay of the rotated-out token → family revoked.
