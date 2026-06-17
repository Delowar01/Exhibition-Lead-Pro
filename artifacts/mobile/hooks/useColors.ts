import { useColorScheme } from "react-native";

import colors from "@/constants/colors";
import { useSettings } from "@/contexts/SettingsContext";

/**
 * Returns the design tokens for the active color scheme.
 *
 * The palette is chosen from the user's saved theme preference
 * (light / dark / system). "system" follows the device appearance setting.
 * The returned object contains all color tokens for the active palette plus
 * scheme-independent values like `radius`.
 */
export function useColors() {
  const deviceScheme = useColorScheme();
  const { theme } = useSettings();

  const effective = theme === "system" ? deviceScheme : theme;
  const palette = effective === "dark" ? colors.dark : colors.light;

  return { ...palette, radius: colors.radius };
}
