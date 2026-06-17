---
name: Expo vector-icon blank glyphs on device
description: Preloading icon fonts via useFonts is NOT enough on physical Android in Expo Go — see expo-android-fonts.md
---

When `@expo/vector-icons` icons (Feather, etc.) render as blank/empty glyphs on a
physical device, first preload every imported icon family's font in the root
`useFonts(...)` call that gates render, e.g. `...Feather.font`. This is the correct
baseline and is sufficient on iOS and in development builds.

**Correction (supersedes the original premise):** On physical **Android in Expo Go**
(SDK 54 / RN 0.81 / new architecture), preloading is NOT sufficient — `useFonts`
reports `loaded: true` but the native renderer still does not apply the font, so text
falls back to the system font and icons stay blank. Loading was never the real problem
there. The reliable fix is to embed fonts at build time via the `expo-font` config
plugin and ship a development build. See `expo-android-fonts.md`.

**How to apply:** Only preload icon families actually imported (this app uses only
`Feather`). iOS NativeTabs (`expo-router/unstable-native-tabs`) uses SF Symbols, not
glyph fonts, so it is unaffected. If icons/fonts are blank specifically on Android in
Expo Go despite `loaded:true`, stop chasing the loader — go to `expo-android-fonts.md`.
