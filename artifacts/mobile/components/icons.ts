import { createIconSet, Feather as ExpoFeather } from "@expo/vector-icons";

// Feather icons, bound to a UNIQUELY named font family ("cspfeather") backed by
// the app's own bundled font file plus the library's glyph map.
//
// Why not import { Feather } from "@expo/vector-icons" directly?
// The stock Feather registers its font under the family "feather". That exact
// name is ALSO registered by the copy of @expo/vector-icons baked into the Expo
// Go sandbox app (and by the native build's embedded font). On Android — which
// resolves font families case-sensitively and does NOT re-layout text when a
// font finishes loading after the text has already mounted — that collision /
// race makes Feather glyphs fall back to empty boxes ("tofu"). iOS re-renders
// late-loaded fonts and matches case-insensitively, so it is unaffected.
//
// By registering under our own family name and loading the asset up front (see
// `app/_layout.tsx`, where `Feather.font` is part of the gating `useFonts`
// batch), the glyphs resolve consistently on web, iOS, Android dev builds, and
// Android Expo Go.
export const Feather = createIconSet(
  ExpoFeather.glyphMap,
  "cspfeather",
  require("../assets/fonts/feather.ttf"),
);
