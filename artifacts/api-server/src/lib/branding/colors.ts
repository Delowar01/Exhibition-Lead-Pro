// =============================================================================
// Batch 18 — tenant branding color model. Pure functions, no I/O, shared by the
// validator, the resolver and the tests. Colors travel ONLY as normalized
// "#RRGGBB" strings; every derived value (foregrounds, link variants, soft
// tints, HSL triplets for the web tokens) is computed here so no client has to
// duplicate the fallback or contrast logic.
// =============================================================================

export type Rgb = { r: number; g: number; b: number };

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

/** Accepts "#RRGGBB" or "RRGGBB" (any case); returns uppercase "#RRGGBB" or null. */
export function normalizeHexColor(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const m = HEX_RE.exec(input.trim());
  if (!m) return null;
  return `#${m[1].toUpperCase()}`;
}

export function hexToRgb(hex: string): Rgb {
  const n = normalizeHexColor(hex);
  if (!n) throw new Error(`not a #RRGGBB color: ${hex}`);
  return { r: parseInt(n.slice(1, 3), 16), g: parseInt(n.slice(3, 5), 16), b: parseInt(n.slice(5, 7), 16) };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** WCAG relative luminance (sRGB). */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colors (>= 1). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

export function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hh < 60) [rp, gp, bp] = [c, x, 0];
  else if (hh < 120) [rp, gp, bp] = [x, c, 0];
  else if (hh < 180) [rp, gp, bp] = [0, c, x];
  else if (hh < 240) [rp, gp, bp] = [0, x, c];
  else if (hh < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return rgbToHex({ r: (rp + m) * 255, g: (gp + m) * 255, b: (bp + m) * 255 });
}

/** "H S% L%" triplet — the exact form the web design tokens use (`hsl(var(--x))`). */
export function hexToHslTriplet(hex: string): string {
  const { h, s, l } = hexToHsl(hex);
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/** Linear mix of two colors; `amount` = weight of `b` (0..1). */
export function mix(a: string, b: string, amount: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const t = Math.max(0, Math.min(1, amount));
  return rgbToHex({ r: ca.r + (cb.r - ca.r) * t, g: ca.g + (cb.g - ca.g) * t, b: ca.b + (cb.b - ca.b) * t });
}

export const WHITE = "#FFFFFF";
export const INK = "#111827"; // near-black used for text on light brand colors

/** Foreground (text) color for a solid surface: white or ink, whichever contrasts more. */
export function foregroundFor(surface: string): { color: string; ratio: number } {
  const white = contrastRatio(surface, WHITE);
  const ink = contrastRatio(surface, INK);
  return white >= ink ? { color: WHITE, ratio: white } : { color: INK, ratio: ink };
}

/**
 * Walk a color's lightness towards the opposite of `background` until it reaches
 * the requested contrast ratio (used for links / focus rings on page surfaces).
 * Returns the original color when it already passes; a saturated but reachable
 * variant otherwise (falls back to the best value found).
 */
export function adjustForContrast(color: string, background: string, minRatio: number): string {
  if (contrastRatio(color, background) >= minRatio) return color;
  const { h, s, l } = hexToHsl(color);
  const darken = luminance(background) > 0.18; // light background → go darker, else lighter
  let best = color;
  let bestRatio = contrastRatio(color, background);
  for (let step = 1; step <= 50; step++) {
    const nl = darken ? l - step * 0.02 : l + step * 0.02;
    if (nl < 0 || nl > 1) break;
    const candidate = hslToHex(h, s, nl);
    const ratio = contrastRatio(candidate, background);
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
    if (ratio >= minRatio) return candidate;
  }
  return best;
}

/** Slightly lighter/darker sibling of a surface for hover/accent states. */
export function shade(color: string, deltaL: number): string {
  const { h, s, l } = hexToHsl(color);
  return hslToHex(h, s, Math.max(0, Math.min(1, l + deltaL)));
}
