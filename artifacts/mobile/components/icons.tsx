import { Feather as ExpoFeather } from "@expo/vector-icons";
import type { ComponentType } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import * as FeatherIcons from "react-native-feather";

// Feather icons rendered as SVG (react-native-feather) instead of an icon FONT.
//
// Why not a font? `@expo/vector-icons` draws Feather via a runtime-loaded font
// registered under the family "feather". On Android — and Expo Go especially —
// that font fails to apply: the family name collides with the copy of
// @expo/vector-icons baked into Expo Go, and Android does not re-layout text when
// a font finishes loading after the text has already mounted. The result was
// every icon rendering as an empty box ("tofu"). iOS and web use different paths
// so they were unaffected.
//
// SVG paths have no font family and no load step, so they render identically on
// web, iOS, Android, Expo Go, and native dev/production builds — there is simply
// nothing to miss. `react-native-svg` (which react-native-feather draws with) is
// already an Expo SDK module bundled inside Expo Go, so no custom build is needed.
//
// The public API is kept identical to the previous font component, e.g.
// `<Feather name="arrow-left" size={20} color="#333" />`, so no call site
// changes. `Feather.glyphMap` is preserved because the app types icon names as
// `keyof typeof Feather.glyphMap` in many places.

const icons = FeatherIcons as unknown as Record<string, ComponentType<{
  width?: number;
  height?: number;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  style?: StyleProp<ViewStyle>;
}>>;

function toPascalCase(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

type FeatherProps = {
  name: keyof typeof ExpoFeather.glyphMap;
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: StyleProp<ViewStyle>;
};

function FeatherBase({
  name,
  size = 24,
  color = "#000000",
  strokeWidth = 2,
  style,
}: FeatherProps) {
  const Icon = icons[toPascalCase(name)];
  if (!Icon) return null;
  return (
    <Icon
      width={size}
      height={size}
      stroke={color}
      strokeWidth={strokeWidth}
      fill="none"
      style={style}
    />
  );
}

export const Feather = Object.assign(FeatherBase, {
  glyphMap: ExpoFeather.glyphMap,
});
