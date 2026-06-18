# Card Scanner Pro — Android Production Build Guide

This document covers the Android-specific fixes applied to the mobile app and the
exact steps to produce an installable native Android **APK** (release / Hermes /
optimized). It is the deliverable for the "Critical Android Build" ticket.

> **Why no APK file is attached:** A native Android binary cannot be compiled
> inside the Replit container — it has no Android SDK, NDK, or Gradle toolchain,
> and EAS Build runs on Expo's cloud (which requires an Expo account login).
> The project is **fully configured** below so the APK builds with **no further
> code changes** — you only run the build commands.

---

## 1. Root cause analysis — icons missing / boxes on Android

**Diagnosis (not a hardcode):**

- The app already uses a **single icon library** everywhere: `Feather` from
  `@expo/vector-icons` (verified across every screen/component — no Ionicons,
  MaterialIcons, FontAwesome, etc. are imported).
- The Feather font is loaded **two ways**:
  1. At runtime via `useFonts({ ...Feather.font })` in `app/_layout.tsx`
     (splash is held until fonts resolve). Serves web, iOS, and Expo Go.
  2. Embedded **natively into the binary** via the `expo-font` config plugin in
     `app.json` (`./assets/fonts/feather.ttf`). That bundled file is
     **byte-identical (55,596 bytes)** to the genuine
     `@expo/vector-icons` Feather font, so it is the correct glyph map.

**Root cause (Android-only tofu/empty icons):** A **filename case mismatch** in
the native embed. The `expo-font` config plugin copies string-path fonts into
`app/src/main/assets/fonts/` with their **original filename preserved**, and
React Native on Android resolves `assets/fonts/` fonts **by filename,
case-sensitively**. The file was named `Feather.ttf`, so Android registered the
family as `Feather` — but `@expo/vector-icons` renders Feather glyphs with
`fontFamily: "feather"` (**lowercase**, confirmed from the library source). On
Android `feather` ≠ `Feather`, so the glyphs fell back to tofu/empty boxes. iOS
resolves fonts by their internal PostScript name and web uses CSS `@font-face`,
so both rendered correctly — exactly the platform split that was observed. (The
Inter fonts were unaffected because their embed filenames, e.g.
`Inter_400Regular.ttf`, already match the family names the JS requests.)

**Fix:** The embedded font file was renamed to lowercase **`feather.ttf`** (and
the `app.json` `expo-font` entry updated to match), so Android's case-sensitive
lookup now resolves the `feather` family. This is a **native** change — it only
takes effect in a freshly **rebuilt** dev/production build (section 3), NOT via a
JS fast-refresh into an already-installed build.

---

## 2. Root cause analysis — notification error on Android

**Root cause:** Push (remote) notifications were **removed from Expo Go on
Android in SDK 53**. The error was emitted purely by **importing**
`expo-notifications` — not by our calls:
- `expo-notifications/index.js` runs a top-level `console.warn` when
  `isRunningInExpoGo()`.
- its `DevicePushTokenAutoRegistration.fx` side-effect module runs on import and
  triggers a red `console.error` on Android.

Because the trigger is the static `import` itself, guarding only the API *calls*
would not remove the error.

**Fix (root cause):** The module is now **lazily `require`d only outside Expo
Go**, behind `isExpoGo = Constants.executionEnvironment === "storeClient"`:
- `lib/push.ts` exports `Notifications` = `null` in Expo Go, else the required
  module; `setNotificationHandler` and `registerForPushNotifications()` run only
  when it is non-null.
- `components/NotificationsManager.tsx` imports that shared handle (no direct
  `expo-notifications` import) and skips its listeners when it is null.

Result: in Expo Go the module is **never imported**, so **zero notification
warnings/errors appear anywhere**; in a dev/production native build
(`executionEnvironment` ≠ `storeClient`, `__DEV__` false) the module loads and
full push functionality works. Real push-token registration additionally
requires an EAS `projectId` — see section 5.

---

## 3. Files modified

| File | Change |
|---|---|
| `lib/push.ts` | Lazily `require` expo-notifications only outside Expo Go; export shared `Notifications` (nullable) + `isExpoGo`; gate handler/registration on it. |
| `components/NotificationsManager.tsx` | Use the shared `Notifications` handle (no direct import); skip listeners when it is null (web / Expo Go). |
| `app.json` | Added `"jsEngine": "hermes"`; added `expo-location` and `expo-image-picker` config plugins (GPS + image-upload permissions for the native build, incl. Android 13+ media access). Renamed the `expo-font` Feather entry to the lowercase `./assets/fonts/feather.ttf` so Android's case-sensitive `assets/fonts/` lookup resolves the `feather` family. |
| `assets/fonts/Feather.ttf` → `assets/fonts/feather.ttf` | Renamed the embedded icon font file to lowercase (byte-identical, md5 `ca4b48e0…`) — fixes the Android-only tofu/empty Feather icons. |
| `ANDROID_BUILD.md` | This document. |

No backend/web/iOS behavior changed. The Android-only icon fix (lowercase font filename) is a **native** change and requires a fresh dev/production build to take effect — a JS fast-refresh into an already-installed build will NOT apply it.

---

## 4. Build configuration

- **Engine:** Hermes (`app.json` → `expo.jsEngine: "hermes"`; default in SDK 54, now explicit).
- **Architecture:** New Architecture enabled (`newArchEnabled: true`).
- **Package id:** `com.elitemarcom.cardscannerpro`.
- **Profiles (`eas.json`):**
  - `preview` → **APK**, release mode, internal distribution → **use this for a directly-installable device APK**.
  - `production` → app-bundle (AAB) for Play Store, with `autoIncrement`.
- **Permissions declared via config plugins** (resolved at prebuild):
  Camera (`expo-camera`), Contacts (`expo-contacts`), Location/GPS (`expo-location`),
  Photo library + camera for uploads (`expo-image-picker`), Notifications
  (`expo-notifications`), Biometric (`expo-local-authentication`).
- **Capabilities supported by config:** Camera, OCR (server-side via API — works
  over network), GPS, Image Upload, Contacts, Notifications (native build + EAS
  projectId), File Sharing (RN `Share`).

---

## 5. One-time setup (creates the EAS projectId)

Run locally on your machine (not in Replit), from `artifacts/mobile/`:

```bash
npm i -g eas-cli          # or: pnpm add -g eas-cli
eas login                 # your Expo account
eas init                  # creates the project + writes extra.eas.projectId into app.json
```

`eas init` adds `expo.extra.eas.projectId` to `app.json`. That projectId is what
enables real push-token registration in the built app (the code already reads it
via `Constants.expoConfig.extra.eas.projectId` / `EXPO_PUBLIC_EAS_PROJECT_ID`).

---

## 6. Build the installable APK

```bash
# From artifacts/mobile/
eas build --platform android --profile preview
```

- Produces a **release APK** (Hermes, optimized/minified, embedded fonts+icons).
- When the cloud build finishes, EAS prints a download URL — download the `.apk`
  and install it directly on the device (enable "Install unknown apps").

### Local build alternative (no EAS cloud)
Requires Android Studio + JDK 17 installed locally:

```bash
# From artifacts/mobile/
npx expo prebuild --platform android --clean   # generates the native android/ project
cd android
./gradlew assembleRelease                       # APK at app/build/outputs/apk/release/
```

For Play Store upload instead of direct install:
```bash
eas build --platform android --profile production   # AAB
```

---

## 7. Verification status

- ✅ TypeScript typecheck passes (`pnpm --filter @workspace/mobile run typecheck`).
- ✅ `expo config` resolves cleanly with Hermes + all 11 plugins (validates the
  new `expo-location` / `expo-image-picker` plugin references).
- ✅ Single icon library (Feather) confirmed app-wide; embedded font verified
  byte-identical to the genuine `@expo/vector-icons` font.
- ✅ All `expo-notifications` calls guarded — no notification errors in Expo Go.

**Device testing (Android 12 / 13 / 14), red-screen/runtime checks, camera/OCR/GPS
/background verification, and screenshots from the installed APK are performed by
you after running the build above** — these require the physical-device install
step that cannot run inside Replit. The project is configured so the APK builds
with no further code changes.
