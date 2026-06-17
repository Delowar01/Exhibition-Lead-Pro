---
name: Expo push notifications
description: Constraints and dispatch-gating rules for the Card Scanner Pro push-notification feature (due follow-ups + hot leads).
---

# Expo push notifications

## Testability constraint (surface to the user)
Remote Expo push requires ALL of: an EAS `projectId`, a development/standalone build (Expo Go on SDK 53+ cannot deliver remote push, esp. Android), and a physical device.
None of these are available inside Replit/Expo Go preview, so the end-to-end push path cannot be verified here.

**How to apply:** `getExpoPushTokenAsync({ projectId })` is gated on a projectId resolved from `Constants.expoConfig.extra.eas.projectId` → `Constants.easConfig.projectId` → `EXPO_PUBLIC_EAS_PROJECT_ID`. When absent, registration is an honest no-op (returns null, logs why) — never fake a token/projectId, which breaks `getExpoPushTokenAsync`.

## Server dispatch rule: only mark "notified" after confirmed dispatch
`notifyUser/notifyUsers` are best-effort (swallow errors) but return a boolean: true only when a device token existed AND the send dispatched without error.
The follow-up scheduler must set the `followUpNotifiedOn` dedup marker ONLY for contacts whose rep was actually pushed — otherwise reps silently miss reminders (e.g. rep hadn't registered a device yet) and it never retries.

**Why:** an unconditional "mark all selected as notified" suppresses future retries even when zero pushes went out.
**How to apply:** loop per-rep, collect contact ids only when `notifyUser(...)` returns true, then update markers for that subset; skip the update entirely when nothing was sent.

## Date comparison
The scheduler compares `contacts.followUpDate` (a date-only local-day string) against a LOCAL `YYYY-MM-DD` built from `Date` parts — never `toISOString().slice(0,10)` (UTC), which shifts the day across timezone boundaries.
