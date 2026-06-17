---
name: Expo Android runtime fonts not applied (Expo Go)
description: Why custom fonts/icons render on iOS+web but fall back to system font + blank icons on physical Android in Expo Go, and the fix.
---

# Android fonts fall back in Expo Go despite useFonts loaded:true

Symptom: physical Android in **Expo Go** (SDK 54 / RN 0.81 / new architecture) shows
device system font for text and **blank Feather icons**, while iOS and the web preview
render correctly. `useFonts()` reports `loaded: true, error: null` — fonts download and
register, but the native renderer does not apply runtime-registered typefaces on Android.

**Why:** Expo Go is a prebuilt sandbox; `newArchEnabled:false` has no effect there and
runtime font registration is unreliable on Android. Not a font-format issue
(@expo-google-fonts/inter ships static per-weight TTFs, names match), not React Compiler.

**How to apply / fix:** Embed fonts at build time via the `expo-font` config plugin
(`["expo-font", { "fonts": ["./assets/fonts/<File>.ttf", ...] }]`) and ship a
**development build** (expo-dev-client + eas.json) instead of Expo Go. Name the embedded
files exactly like the JS `fontFamily` (e.g. `Inter_400Regular.ttf` -> family
`Inter_400Regular`, `Feather.ttf` -> `Feather`) so runtime useFonts names stay valid.
A dev build is also required for this app's push notifications (removed from Expo Go SDK 53+).
