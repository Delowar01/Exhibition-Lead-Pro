---
name: Mobile secure session storage
description: Where the Expo app must persist the JWT/session and why plaintext AsyncStorage is forbidden on native
---

# Mobile session/token persistence

Native (iOS/Android) must NEVER persist the bearer JWT or user object in plaintext
AsyncStorage. Route session storage through the `secure-prefs` wrapper
(`artifacts/mobile/lib/secure-prefs.ts`), which uses SecureStore on native and
falls back to AsyncStorage on web (where SecureStore is unavailable).

**Why:** A live JWT in AsyncStorage is recoverable via device compromise, backup
extraction, or local malware with no biometric gating — it also negates the
biometric vault hardening, since the same token sits in weaker storage.

**How to apply:**
- `auth-storage.ts` `saveSession`/`loadSession`/`clearSession` go through
  `setSecureItem`/`getSecureItem`/`deleteSecureItem`, not raw AsyncStorage.
- When migrating an existing build, read any legacy plaintext AsyncStorage keys
  once, re-persist via secure-prefs, then delete the old keys (skip on web).
- SecureStore values have a ~2KB size limit — keep the stored user object small.
