/**
 * Semantic design tokens for the mobile app.
 *
 * Derived from the sibling web artifact (artifacts/web-app/src/index.css) so
 * both artifacts share one visual identity. Brand primary is #FF6B00 orange.
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

  // Border radius (px). Synced from web --radius: 0.5rem.
  radius: 8,
};

export default colors;
