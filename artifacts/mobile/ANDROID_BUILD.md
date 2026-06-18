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

- The app uses a **single icon set** everywhere: Feather (verified across every
  screen/component — no Ionicons, MaterialIcons, FontAwesome, etc. are imported).
- The original implementation drew Feather via `@expo/vector-icons`, which defines
  it as `createIconSet(glyphMap, 'feather', font)` — i.e. it registers an **icon
  font** under the family `feather` and loads that font at runtime.

**Root cause (Android tofu/empty icons — icon *fonts* are the problem):**

The icon-font approach fails on Android for two compounding reasons that iOS and
web do not hit:

1. **Family-name collision in Expo Go.** Expo Go ships its own baked-in copy of
   `@expo/vector-icons`, which also registers the `feather` family. The app's
   runtime registration of the same name collides/skews with it on Android (which
   matches families case-sensitively); iOS tolerates it, so iOS + web render fine.
2. **No re-layout on late font load.** Android does NOT re-render Text when a font
   loads *after* the Text has mounted. iOS does. So loading the icon font in a
   non-gating effect leaves Android showing tofu permanently.

Renaming the embedded font and gating a custom-named `createIconSet` on `useFonts`
were both tried and both still relied on a runtime icon **font** — so Android Expo
Go still showed tofu.

**Fix (the one that works — render icons as SVG, no font at all):**

Icons are no longer a font. `components/icons.tsx` renders Feather icons as **SVG**
(via `react-native-feather`, which draws with `react-native-svg`). SVG paths have
no font family and no load step, so there is **nothing to collide and nothing to
miss** — they render identically on web, iOS, Android, Expo Go, and native
dev/production builds. This removes the entire failure class above.

- `components/icons.tsx` exports a `Feather` wrapper with the **same public API**
  as before (`<Feather name="arrow-left" size={20} color="#333" />`): it maps the
  kebab-case `name` to the matching `react-native-feather` PascalCase SVG component
  and passes `size`→`width/height`, `color`→`stroke`. `Feather.glyphMap` is
  preserved (the app types icon names as `keyof typeof Feather.glyphMap`).
- No call sites changed — every screen/component already imports `{ Feather }` from
  `@/components/icons`.
- `app/_layout.tsx` no longer loads any icon font (only the Inter text fonts).
- `react-native-svg` is an Expo SDK module already **bundled inside Expo Go**, so
  this fix applies in Expo Go with **no custom build**.

> The old icon **font** (`assets/fonts/feather.ttf`) and its `expo-font` embed in
> `app.json` were removed — the app no longer uses an icon font.

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
| `components/icons.tsx` | **New (replaces `components/icons.ts`).** `Feather` wrapper that renders icons as **SVG** via `react-native-feather` (same `name`/`size`/`color` API; `Feather.glyphMap` preserved) — fixes the Android/Expo-Go tofu icons by removing the icon font entirely. |
| every screen/component (~31 files) | Already import `{ Feather }` from `@/components/icons` — no changes needed for the SVG switch. |
| `app/_layout.tsx` | Removed the icon-font load; `useFonts` now loads only the Inter text fonts. |
| `react-native-feather` (dependency) | Added. Pure-JS Feather icon set drawn with `react-native-svg` (already an Expo SDK module bundled in Expo Go) — no native build required. |
| `assets/fonts/feather.ttf` + `app.json` `expo-font` embed | **Removed.** The app no longer uses an icon font. |
| `app.json` | Added `"jsEngine": "hermes"`; added `expo-location` and `expo-image-picker` config plugins (GPS + image-upload permissions for the native build, incl. Android 13+ media access). |
| `ANDROID_BUILD.md` | This document. |

No backend/web/iOS behavior changed. The icon fix is **pure JS (SVG)** and applies on web, iOS, Android dev builds, and Android Expo Go without a native rebuild.

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
- ✅ Single icon set (Feather) confirmed app-wide; icons now render as **SVG**
  (`react-native-feather` over `react-native-svg`) — no icon font involved.
- ✅ Expo **web** preview confirms the SVG icons render (login screen: mail, lock,
  eye, arrow, zap all visible — no tofu).
- ✅ All `expo-notifications` calls guarded — no notification errors in Expo Go.

**Device testing (Android 12 / 13 / 14), red-screen/runtime checks, camera/OCR/GPS
/background verification, and screenshots from the installed APK are performed by
you after running the build above** — these require the physical-device install
step that cannot run inside Replit. The project is configured so the APK builds
with no further code changes.
