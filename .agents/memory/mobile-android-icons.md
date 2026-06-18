---
name: Mobile Android icon "tofu" — config is correct, it's a build-context issue
description: Why @expo/vector-icons icons appear missing on Android in the Card Scanner Pro mobile app, and why repeated code patches don't fix it.
---

# Android icon tofu is NOT a code/config defect

Repeated tickets claim "icons missing on Android (iOS fine)". An evidence-based
audit (re-runnable any time) shows the mobile code/config is already correct:

- Single icon family app-wide: `Feather` from `@expo/vector-icons` (no mixed families).
- Bundled `assets/fonts/Feather.ttf` is **byte-identical** (md5 `ca4b48e0…`) to the
  installed `@expo/vector-icons` package font → no glyphMap/version drift.
- Every `<Feather name="…">` literal AND every dynamic icon-map value
  (`CONTACT_STATUS_ICONS`, `MEETING_TYPE_ICONS`, `TASK_TYPE_ICONS`, theme options)
  is a valid key in the package's `Feather.json` glyph map → no renamed/removed icons.
- `app.json` embeds the icon font natively via the `expo-font` config plugin AND
  `_layout.tsx` preloads it via `useFonts({ ...Feather.font })` with splash gating.
  This is exactly the documented-correct setup for Android release builds.

**Why:** The `expo-font` native embed only exists in a **prebuilt native binary**
(dev-build / APK from `expo prebuild`). It is **never present in Expo Go**. On
Android (esp. New Architecture / release), runtime-only vector-icon font loading is
flaky — which is why the embed is needed — but the embed is absent in Expo Go, so
icons tofu there while iOS Expo Go tolerates the runtime load. A stale APK built
before the embed config, or a non-`--clean` prebuild, shows the same symptom.

**How to apply:** Do NOT keep patching icon code for this. First confirm the *test
context*: tofu in Expo Go (or a stale APK) is expected and is fixed by building a
fresh APK (`eas build -p android --profile preview`, or `expo prebuild --clean` +
`gradlew assembleRelease`) and testing THAT. Android device/APK verification cannot
run inside Replit (no SDK/emulator) — screenshots require the user's device. Only if
a freshly clean-built APK STILL shows tofu is there a real native-registration bug to
investigate.
