---
name: Mobile Android icon "tofu" — Feather icon font not registering
description: Root cause + fix for @expo/vector-icons Feather icons showing as boxes on Android (iOS/web fine) in the Card Scanner Pro mobile app.
---

# Android-only Feather icons render as tofu/empty — real root cause

Symptom: every `@expo/vector-icons` Feather icon shows as a box/tofu (or empty) on
**Android only**; iOS and the Expo **web** build render icons correctly, and Inter
text always renders. The platform split (web+iOS fine, Android broken) is the key tell.

**Root cause — native-embed filename CASE MISMATCH.** `@expo/vector-icons` renders
Feather glyphs with `fontFamily: "feather"` (**lowercase** — from its source:
`createIconSet(glyphMap, 'feather', font)`). The `expo-font` config plugin embeds
string-path fonts by copying them into `app/src/main/assets/fonts/` with their
**original filename preserved** (the `assetFontPaths` copy in `withFontsAndroid.js`
uses an identity filename processor — only XML/object fonts get name-normalized).
React Native on Android resolves `assets/fonts/` fonts **by filename,
case-sensitively**. The file was `Feather.ttf` → Android registered family
`Feather` → `feather` ≠ `Feather` → fallback → tofu. iOS resolves by internal
PostScript name and web uses CSS `@font-face`, so neither hit the mismatch.
Inter was fine because its embed filenames (`Inter_400Regular.ttf`) already match
the family names the JS requests.

**Fix:** rename the embedded font to lowercase **`assets/fonts/feather.ttf`** and
update the `app.json` `expo-font` entry to match. Android's lookup then resolves
`feather`. Keep `...Feather.font` in the `useFonts` batch — it serves web, iOS,
and Expo Go at runtime and is harmless on Android.

**Why two earlier theories were WRONG (do not repeat):**
- "It's just Expo Go / rebuild the APK, no code change needed" — false; web+iOS work
  via different mechanisms, the embed itself was registering the wrong family name.
- "Metro fails to bundle the deeply pnpm-symlinked package asset, so load it from a
  local `require(...)`" — that change (`feather: require("../assets/fonts/Feather.ttf")`)
  REGRESSED everything: the whole `useFonts` batch failed at runtime so Inter ALSO
  fell back to a system font and icons went fully empty. A single failing entry kills
  the entire `useFonts` batch. Reverted.

**How to apply / verify:** This is a **native** change — it only takes effect in a
freshly **rebuilt** dev/production build (EAS `preview` APK), NOT via a JS
fast-refresh into an already-installed build. That reload-vs-rebuild gap is why the
bug kept appearing "still broken" after edits. Android device/APK rendering cannot
be verified inside Replit (no SDK/emulator); only the user can confirm on-device.
The Expo **web** build (served by Metro, screenshot-able in Replit) is a useful
proxy for "do icons/fonts load at all" but does NOT reproduce Android-native
font-resolution bugs.

**General lesson:** when embedding a custom/vendored icon font via the `expo-font`
plugin for Android, the embedded **filename (lowercased) must equal the
`fontFamily` string the component requests** (RN Android assets/fonts lookup is
filename- and case-based). Check the icon library's `createIconSet(..., 'name', ...)`
for the exact (usually lowercase) family name.
