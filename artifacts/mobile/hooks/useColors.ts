import { useMemo } from "react";
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

  // Memoize so consumers receive a STABLE object reference across renders while
  // the scheme is unchanged. useColors is called in almost every component, so a
  // fresh object every render defeats React.memo and forces avoidable re-renders.
  return useMemo(() => {
    const palette = effective === "dark" ? colors.dark : colors.light;
    return { ...palette, radius: colors.radius };
  }, [effective]);
}
