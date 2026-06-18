---
name: Mobile Android icon "tofu" — render Feather as SVG, not a font
description: Why @expo/vector-icons Feather icons show as boxes on Android (iOS/web fine) and the fix that actually works — render icons as SVG instead of an icon font.
---

# Android Feather icons render as tofu/empty — real fix is SVG, not a font

Symptom: every `@expo/vector-icons` Feather icon shows as a box/tofu (or empty) on
**Android** (Expo Go especially); iOS and the Expo **web** build render icons fine,
and Inter text always renders. The platform split (web+iOS fine, Android broken) is
the key tell that an icon **font** is the culprit.

## Root cause — icon FONTS are unreliable on Android

`@expo/vector-icons` draws Feather via `createIconSet(glyphMap, 'feather', font)` —
a runtime-loaded icon **font** under the family `feather`. On Android this fails two
ways iOS/web tolerate:

1. **Family-name collision in Expo Go.** Expo Go bundles its own `@expo/vector-icons`,
   which also registers `feather`. The app's runtime registration collides/skews on
   Android (case-sensitive family matching). iOS tolerates it.
2. **No re-layout on late font load.** Android does NOT re-measure Text when a font
   loads AFTER the Text mounted. So a non-gating font load = permanent tofu.

## Fix that works — render icons as SVG (no font at all)

`components/icons.tsx` renders Feather icons as **SVG** via `react-native-feather`
(which draws with `react-native-svg`). No font family, no load step → nothing to
collide and nothing to miss. Renders identically on web, iOS, Android, Expo Go, and
native builds.

Key points:
- Keep the SAME public API so no call site changes: a `Feather` wrapper takes
  `{ name, size, color }`, maps kebab `name` → PascalCase `react-native-feather`
  component (`arrow-left`→`ArrowLeft`, `bar-chart-2`→`BarChart2`), passes
  `size`→`width/height`, `color`→`stroke`.
- **Preserve `Feather.glyphMap`** — the app types icon names as
  `keyof typeof Feather.glyphMap` in ~25 files. Attach it via
  `Object.assign(FeatherBase, { glyphMap: ExpoFeather.glyphMap })` (still importing
  `@expo/vector-icons` only for the glyph-map type/keys).
- `react-native-svg` is an **Expo SDK module already bundled in Expo Go**, so SVG
  icons work in Expo Go with **no custom dev build**.
- Remove the icon font load from `_layout.tsx`; delete the `feather.ttf` asset + its
  `app.json` `expo-font` embed.

## Theories that were WRONG (do not repeat)

- "Just rebuild the APK / it's only Expo Go" — false; reproduces in any Android runtime.
- "Rename embedded `Feather.ttf`→`feather.ttf` in the `expo-font` plugin" — a real
  case-sensitivity detail but irrelevant: icons used a runtime-registered family.
- "Load Feather in a non-gating `Font.loadAsync` effect" — regressed Android (late
  load + no re-layout = permanent tofu).
- "Custom-named `createIconSet('cspfeather', …)` + gating `useFonts`" — passed web
  + architect review but STILL tofu on Android Expo Go, because it is STILL an icon
  font. This is what finally proved: **stop using an icon font on Android; use SVG.**

## General lesson

If an icon **font** misbehaves on Android (tofu in Expo Go, icons that never appear),
do not keep tuning the font (rename, gate, custom family). Switch the icon set to
**SVG** (`react-native-svg` + a Feather-as-SVG package). It eliminates the whole
font-family/load-timing failure class and needs no native rebuild in Expo Go.

## Verify

Expo **web** (screenshot-able in Replit) confirms the SVG wrapper + name mapping are
wired correctly. Android device/Expo-Go rendering still can't be run inside Replit
(no SDK/emulator) — only the user can confirm on-device, but SVG removes the
Android-specific font failure mode, so web success is a much stronger signal than it
was for the font attempts.
