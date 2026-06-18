---
name: Mobile Android icon "tofu" — Feather icon font not registering
description: Root cause + fix for @expo/vector-icons Feather icons showing as boxes on Android (iOS/web fine) in the Card Scanner Pro mobile app.
---

# Android Feather icons render as tofu/empty — real root cause & fix

Symptom: every `@expo/vector-icons` Feather icon shows as a box/tofu (or empty) on
**Android** (both Expo Go and the renamed-font dev build); iOS and the Expo **web**
build render icons correctly, and Inter text always renders. The platform split
(web+iOS fine, Android broken) is the key tell.

## Root cause (two compounding Android-specific factors)

`@expo/vector-icons` defines Feather as `createIconSet(glyphMap, 'feather', font)`
— it registers its font under the family **`feather`** and loads that font **at
runtime**. On Android this breaks two ways that iOS/web do not:

1. **Family-name collision in Expo Go.** Expo Go ships its OWN baked-in copy of
   `@expo/vector-icons`, which also registers the family `feather`. The app's
   runtime registration of the same name collides/skews with it, so glyphs fall
   back to tofu. iOS matches font families case-insensitively and tolerates this;
   Android does not.
2. **No re-layout on late font load.** Android does NOT re-render/re-measure Text
   when a font finishes loading AFTER the Text has already mounted. iOS does. So if
   the icon font is loaded in a non-gating effect (app renders first, font arrives
   later), Android keeps showing tofu forever.

## Fix (the one that actually works — JS only, works in Expo Go too)

Define a **custom-named** Feather icon set and load it **before render**:

- `components/icons.ts`: `export const Feather = createIconSet(ExpoFeather.glyphMap,
  "cspfeather", require("../assets/fonts/feather.ttf"))`. A unique family name
  (`cspfeather`) cannot collide with Expo Go's baked-in `feather`. Reuses the
  library's own glyph map + the app's bundled font file (byte-identical copy).
- All ~31 screens/components import `{ Feather }` from `@/components/icons` instead
  of `@expo/vector-icons`. The component API is identical.
- `app/_layout.tsx`: put `...Feather.font` (i.e. `{ cspfeather: <asset> }`) in the
  **gating** `useFonts({...Inter, ...Feather.font})` batch so no icon renders until
  the font is ready (fixes the Android late-load case). `fontError` still lets the
  app through (degraded icons) rather than hanging on splash.

This is a pure-JS fix — it works on web, iOS, Android dev builds, AND Android Expo
Go (no rebuild required, unlike a native-embed change).

## Theories that were WRONG (do not repeat)

- "Just rebuild the APK / it's only Expo Go, no code change needed" — false. The
  problem reproduces in any Android runtime; the family name + late-load are the
  cause, not the build channel.
- "Native-embed filename case mismatch — rename `Feather.ttf`→`feather.ttf` in the
  `expo-font` plugin." This was a real Android case-sensitivity detail but did NOT
  fix it: icons use a runtime-registered family, and the embed registers an UNUSED
  `feather` family. The rename is harmless but irrelevant; the file itself is still
  needed because `components/icons.ts` `require`s it.
- "Load Feather in a separate crash-proof `Font.loadAsync` effect (non-gating)."
  That regressed Android specifically — non-gating load + Android's no-re-layout
  rule = permanent tofu.

## Verify

The Expo **web** build (Metro, screenshot-able in Replit) confirms the wrapper /
glyph map / font asset are wired correctly, but does NOT reproduce Android-native
font resolution. Android device/Expo-Go rendering cannot be verified inside Replit
(no SDK/emulator) — only the user can confirm on-device.

## General lesson

For a vendored icon font that misbehaves on Android (tofu in Expo Go, or icons
that never appear), prefer a **custom-named `createIconSet` + gating `useFonts`**
over fighting the native embed: it removes both the Expo-Go family collision and
the Android late-load race, and needs no native rebuild.
