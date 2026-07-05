---
name: Mobile PIN fallback pattern
description: How the mobile app-lock PIN entry, reset signaling, and secure storage behave, and the hook that keeps the lock overlay reactive.
---

## PinPad reset uses a signal, not an error boolean
The PIN entry component clears/resets via an incrementing `resetSignal` prop (parent bumps it), NOT a boolean `error` flag. A boolean latches and won't re-trigger a second failed attempt; an incrementing signal always fires a fresh reset.

## PIN is stored in SecureStore as plaintext — that is acceptable
The PIN is persisted in Expo SecureStore as plaintext. SecureStore is TEE/Keystore-encrypted at rest, so this is equivalent in protection to a hashed value on device. Do not add an app-level hash and assume it adds meaningful security here.

## Overlay must be told availability changed
After saving or clearing the PIN you MUST call `refreshPinAvailability()` so the lock overlay re-evaluates and shows/hides without an app restart. Skipping it leaves the overlay stale until relaunch.
