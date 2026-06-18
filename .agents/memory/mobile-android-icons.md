---
name: Mobile Android icon "tofu" — Feather icon font not registering
description: Root cause + fix for @expo/vector-icons Feather icons showing as boxes on Android (iOS fine) in the Card Scanner Pro mobile app.
---

# Android Feather icons render as tofu — real root cause

Symptom: every Feather icon shows as a box/tofu on Android while iOS is fine, AND
text (Inter) fonts render correctly. The text-vs-icons split is the key tell.

**Root cause:** `@expo/vector-icons` builds the Feather set with
`createIconSet(glyphMap, 'feather', font)`, so the `<Feather>` component renders with
`fontFamily: 'feather'` (lowercase) on every platform, and `Feather.font` is
`{ feather: <asset> }`. That `<asset>` is imported from deep inside this monorepo's
**pnpm-symlinked** `node_modules/.pnpm/@expo+vector-icons@…/…/Fonts/Feather.ttf`.
Metro can fail to bundle that nested asset on Android, so `Font.loadAsync` silently
no-ops and the `feather` family is never registered → tofu. iOS tolerates it via Expo
Go's preloaded copy; Inter loads from a different package Metro resolves cleanly, so
text is unaffected.

**Why the earlier "it's just Expo Go / rebuild the APK" conclusion was wrong:** Inter
loading fine proves runtime `useFonts` works; the failure is specific to the Feather
*asset*, not the font mechanism or the build type.

**Fix (in `app/_layout.tsx`):** register the icon font from the **local**
byte-identical project asset under the exact lowercase family name the component uses:
```ts
useFonts({ /* Inter… */, feather: require("../assets/fonts/Feather.ttf") });
```
A local `assets/fonts/*.ttf` is a first-class project asset Metro always bundles.
Do NOT register it as `Feather` (capital) — the component looks up `feather`.

**How to apply / verify:** In Expo Go, fast-refresh/reload picks up the JS change
immediately — no APK rebuild needed to confirm icons now render. Keep the `expo-font`
plugin embed of `./assets/fonts/Feather.ttf` too (on Android it registers as the
lowercase resource `feather`, matching). Android device/APK verification still can't
run inside Replit (no SDK/emulator) — screenshots require the user's device.

**General lesson:** in a pnpm + Expo + Metro monorepo, prefer loading `@expo/vector-icons`
(and any vendored) fonts from a local copied asset over the package's `...Icon.font`
spread, to avoid flaky Metro resolution of deeply-symlinked node_modules assets.
