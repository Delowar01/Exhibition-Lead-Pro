/**
 * Semantic design tokens for the mobile app.
 *
 * Derived from the sibling web artifact (artifacts/web-app/src/index.css) so
 * both artifacts share one visual identity. Brand primary is #FF6B00 orange.
 *
 * Both the `light` and `dark` palettes expose an identical set of keys so the
 * `useColors()` hook can switch between them based on the user's theme
 * preference (light / dark / system).
 */

const colors = {
  light: {
    // Legacy aliases
    text: "#212121",
    tint: "#FF6B00",

    // Core surfaces
    background: "#F8F9FB",
    foreground: "#212121",

    // Cards / elevated surfaces
    card: "#FFFFFF",
    cardForeground: "#212121",

    // Primary action color
    primary: "#FF6B00",
    primaryForeground: "#FFFFFF",

    // Secondary / less-emphasis interactive surfaces
    secondary: "#F0F2F5",
    secondaryForeground: "#212121",

    // Muted / subdued elements
    muted: "#F0F2F5",
    mutedForeground: "#67707D",

    // Accent highlights
    accent: "#FFF1E8",
    accentForeground: "#FF6B00",

    // Destructive actions
    destructive: "#EF4444",
    destructiveForeground: "#FFFFFF",

    // Positive / success
    success: "#22C55E",
    successForeground: "#FFFFFF",

    // Warning
    warning: "#F59E0B",

    // Borders and input outlines
    border: "#DDE2E8",
    input: "#DDE2E8",

    // Dark surface (camera overlay, deep accents)
    dark: "#191D2E",
    darkForeground: "#F8F9FB",
  },

  dark: {
    // Legacy aliases
    text: "#F8F9FB",
    tint: "#FF6B00",

    // Core surfaces
    background: "#0F1117",
    foreground: "#F8F9FB",

    // Cards / elevated surfaces
    card: "#171A21",
    cardForeground: "#F8F9FB",

    // Primary action color
    primary: "#FF6B00",
    primaryForeground: "#FFFFFF",

    // Secondary / less-emphasis interactive surfaces
    secondary: "#1E222B",
    secondaryForeground: "#F8F9FB",

    // Muted / subdued elements
    muted: "#1E222B",
    mutedForeground: "#9AA3B0",

    // Accent highlights
    accent: "#2A1B10",
    accentForeground: "#FF8A33",

    // Destructive actions
    destructive: "#F87171",
    destructiveForeground: "#FFFFFF",

    // Positive / success
    success: "#34D399",
    successForeground: "#06281B",

    // Warning
    warning: "#FBBF24",

    // Borders and input outlines
    border: "#262B36",
    input: "#262B36",

    // Dark surface (camera overlay, deep accents)
    dark: "#0B0D12",
    darkForeground: "#F8F9FB",
  },

  // Border radius (px). Synced from web --radius: 0.5rem.
  radius: 8,
};

export default colors;
