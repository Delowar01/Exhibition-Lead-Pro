---
name: Native builds & native-only features (mobile)
description: How native device features must be validated and built for the Expo mobile app; why Expo Go is not sufficient.
---

# Native features require a dev-client / EAS build — not Expo Go

Native device features in the mobile app (NFC, background processing, contacts, notifications, location, etc.) must be validated on an **Expo Development Build** or a **native APK / TestFlight** build, NOT Expo Go.

**Why:** Expo Go cannot load custom native modules (e.g. `react-native-nfc-manager`), so it silently lacks the capability and gives false negatives. The product is production-bound, so testing must happen on the real native runtime.

**How to apply:**
- Code that touches a native module must **degrade gracefully on web / Expo Go** — use a guarded dynamic `import()` of the native module (return an "unsupported" state instead of crashing at module-eval). See `lib/nfc.ts` for the pattern.
- Build profiles already exist in `artifacts/mobile/eas.json`: `development` (dev-client APK), `preview` (internal APK), `production`. `expo-dev-client` is installed and native config plugins (e.g. `react-native-nfc-manager`) are registered in `app.json`.
- Running an actual EAS cloud build requires interactive Expo account auth / EAS credentials — the agent cannot trigger signed APK/TestFlight builds autonomously; the config is ready for the user to run `eas build`.
