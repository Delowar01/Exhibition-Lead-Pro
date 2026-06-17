---
name: Expo vector-icon blank glyphs on device
description: Why @expo/vector-icons render as empty boxes/blank on physical Expo Go devices and the reliable fix
---

When `@expo/vector-icons` icons (Feather, Ionicons, etc.) render as blank/empty
glyphs on a physical device (Expo Go, Android) while custom text fonts render
fine, the icon glyph font was not loaded before first render.

**Rule:** Explicitly preload every icon family's font in the root `useFonts(...)`
call that already gates render, e.g. `...Feather.font` alongside the app fonts.
The render gate (`if (!fontsLoaded) return null`) then guarantees glyphs exist
before any screen mounts.

**Why:** `@expo/vector-icons` normally lazy-loads its font and re-renders, but
with splash gating + the new architecture the lazy path can leave the first
render without the font, showing empty icon containers. Web preview hides this —
fonts load differently there, so icons look fine on web but blank on device.

**How to apply:** Scan the app for which icon families are actually imported
(only preload those — e.g. this app uses only `Feather`). iOS NativeTabs
(`expo-router/unstable-native-tabs`) uses SF Symbols, not glyph fonts, so it is
unaffected and needs no preload. After the change, restart Metro with a clean
cache and verify on a real device.
