/**
 * Design tokens for the mobile app (Stage 5.9 Phase 1).
 *
 * Non-color tokens: spacing, typography scale, radii, icon sizes, motion.
 * Color tokens live in constants/colors.ts (via useColors()).
 * New screens must use these instead of magic numbers.
 */

/** 4pt spacing grid — matches the web spacing system. */
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

/** Typography scale (fontSize / lineHeight). Pair with FONT from components/ui. */
export const TYPE = {
  display: { fontSize: 28, lineHeight: 34 },
  title: { fontSize: 22, lineHeight: 28 },
  heading: { fontSize: 17, lineHeight: 22 },
  body: { fontSize: 15, lineHeight: 21 },
  caption: { fontSize: 13, lineHeight: 18 },
  micro: { fontSize: 11, lineHeight: 14 },
} as const;

/** Border radii. `md` matches web --radius (8). */
export const RADIUS = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  full: 999,
} as const;

/** Icon sizes. */
export const ICON = {
  sm: 16,
  md: 20,
  lg: 24,
  xl: 32,
} as const;

/** Motion durations (ms) — matches web motion tokens. */
export const MOTION = {
  fast: 120,
  base: 180,
  slow: 280,
} as const;

/** Minimum touch target (a11y). */
export const TOUCH_TARGET = 44;
