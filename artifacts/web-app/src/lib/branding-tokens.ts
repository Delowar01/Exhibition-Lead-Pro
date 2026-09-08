// =============================================================================
// Batch 18 — tenant branding on the web. Turns the resolved branding contract
// (colors already validated + derived server-side) into the design-token CSS
// the portal already consumes (`hsl(var(--x))`). The same helpers also power
// the editor's live preview of an UNSAVED draft (the server derives the final
// values on save; the preview mirrors its algorithm).
// =============================================================================
import type { TenantBranding } from "@workspace/api-client-react";

export type BrandTheme = "light" | "dark" | "system";

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

export function normalizeHex(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = HEX_RE.exec(input.trim());
  return m ? `#${m[1].toUpperCase()}` : null;
}

function rgb(hex: string): [number, number, number] {
  const n = normalizeHex(hex) ?? "#000000";
  return [parseInt(n.slice(1, 3), 16), parseInt(n.slice(3, 5), 16), parseInt(n.slice(5, 7), 16)];
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

export function luminance(hex: string): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

export function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0, gp = 0, bp = 0;
  if (hh < 60) [rp, gp, bp] = [c, x, 0];
  else if (hh < 120) [rp, gp, bp] = [x, c, 0];
  else if (hh < 180) [rp, gp, bp] = [0, c, x];
  else if (hh < 240) [rp, gp, bp] = [0, x, c];
  else if (hh < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return toHex((rp + m) * 255, (gp + m) * 255, (bp + m) * 255);
}

/** "H S% L%" triplet (the form the tokens use). */
export function triplet(hex: string): string {
  const { h, s, l } = hexToHsl(hex);
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export function mix(a: string, b: string, amount: number): string {
  const ca = rgb(a);
  const cb = rgb(b);
  const t = Math.max(0, Math.min(1, amount));
  return toHex(ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t);
}

export const WHITE = "#FFFFFF";
export const INK = "#111827";
const LIGHT_BG = "#F8F9FB";
const DARK_BG = "#1A1A1A";

export function foregroundFor(surface: string): { color: string; ratio: number } {
  const w = contrastRatio(surface, WHITE);
  const k = contrastRatio(surface, INK);
  return w >= k ? { color: WHITE, ratio: w } : { color: INK, ratio: k };
}

export function adjustForContrast(color: string, background: string, minRatio: number): string {
  if (contrastRatio(color, background) >= minRatio) return color;
  const { h, s, l } = hexToHsl(color);
  const darken = luminance(background) > 0.18;
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

export function shade(color: string, deltaL: number): string {
  const { h, s, l } = hexToHsl(color);
  return hslToHex(h, s, Math.max(0, Math.min(1, l + deltaL)));
}

/** Everything the CSS needs for one primary + one sidebar color (mirrors the server's deriveColors). */
export interface BrandPalette {
  primary: string;
  primaryForeground: string;
  primaryContrast: number;
  primaryLinkLight: string;
  primaryLinkDark: string;
  primarySoftLight: string;
  primarySoftDark: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarContrast: number;
  sidebarAccent: string;
  sidebarBorder: string;
}

export function derivePalette(primary: string, sidebar: string, platformPrimary?: string): BrandPalette {
  const pFg = platformPrimary && primary === platformPrimary ? { color: WHITE, ratio: contrastRatio(primary, WHITE) } : foregroundFor(primary);
  const sFg = foregroundFor(sidebar);
  const sidebarIsDark = sFg.color === WHITE;
  return {
    primary,
    primaryForeground: pFg.color,
    primaryContrast: pFg.ratio,
    primaryLinkLight: adjustForContrast(primary, LIGHT_BG, 4.5),
    primaryLinkDark: adjustForContrast(primary, DARK_BG, 4.5),
    primarySoftLight: mix(primary, WHITE, 0.9),
    primarySoftDark: mix(primary, DARK_BG, 0.8),
    sidebar,
    sidebarForeground: sFg.color,
    sidebarContrast: sFg.ratio,
    sidebarAccent: shade(sidebar, sidebarIsDark ? 0.07 : -0.07),
    sidebarBorder: shade(sidebar, sidebarIsDark ? -0.04 : -0.1),
  };
}

export function paletteFromBranding(b: TenantBranding): BrandPalette {
  const d = b.derived;
  return {
    primary: b.primaryColor,
    primaryForeground: d.primaryForeground,
    primaryContrast: d.primaryContrast,
    primaryLinkLight: d.primaryLinkLight,
    primaryLinkDark: d.primaryLinkDark,
    primarySoftLight: d.primarySoftLight,
    primarySoftDark: d.primarySoftDark,
    sidebar: b.sidebarColor,
    sidebarForeground: d.sidebarForeground,
    sidebarContrast: d.sidebarContrast,
    sidebarAccent: d.sidebarAccent,
    sidebarBorder: d.sidebarBorder,
  };
}

/**
 * The stylesheet applied to the authenticated tenant portal. Only the surfaces
 * a tenant customized are overridden (an unbranded tenant gets an empty sheet,
 * i.e. the platform defaults exactly as shipped). Both color schemes are covered:
 * `:root` (light) and `:root.dark`.
 */
export function buildBrandingCss(p: BrandPalette, custom: { primary: boolean; sidebar: boolean }): string {
  const rules: string[] = [];
  if (custom.primary) {
    const fg = triplet(p.primaryForeground);
    rules.push(
      `:root, :root.dark { --primary: ${triplet(p.primary)}; --primary-foreground: ${fg}; --sidebar-primary: ${triplet(p.primary)}; --sidebar-primary-foreground: ${fg}; --chart-1: ${triplet(p.primary)}; }`,
      `:root { --ring: ${triplet(p.primaryLinkLight)}; --sidebar-ring: ${triplet(p.primaryLinkLight)}; --primary-soft: ${triplet(p.primarySoftLight)}; --brand-link: ${triplet(p.primaryLinkLight)}; }`,
      `:root.dark { --ring: ${triplet(p.primaryLinkDark)}; --sidebar-ring: ${triplet(p.primaryLinkDark)}; --primary-soft: ${triplet(p.primarySoftDark)}; --brand-link: ${triplet(p.primaryLinkDark)}; }`,
      // Text links / accents in the brand color use the contrast-safe link variant.
      `.text-primary { color: hsl(var(--brand-link)); }`,
    );
  }
  if (custom.sidebar) {
    const fg = triplet(p.sidebarForeground);
    const muted = triplet(mix(p.sidebarForeground, p.sidebar, 0.3));
    rules.push(
      `:root, :root.dark { --sidebar: ${triplet(p.sidebar)}; --sidebar-foreground: ${fg}; --sidebar-border: ${triplet(p.sidebarBorder)}; --sidebar-accent: ${triplet(p.sidebarAccent)}; --sidebar-accent-foreground: ${fg}; }`,
      // The desktop sidebar / mobile drawer re-map their surface tokens to the brand sidebar color.
      `.tenant-sidebar { --card: ${triplet(p.sidebar)}; --card-foreground: ${fg}; --foreground: ${fg}; --muted-foreground: ${muted}; --secondary: ${triplet(p.sidebarAccent)}; --secondary-foreground: ${fg}; --accent: ${triplet(p.sidebarAccent)}; --accent-foreground: ${fg}; --border: ${triplet(p.sidebarBorder)}; --background: ${triplet(p.sidebar)}; --primary-soft: ${triplet(p.sidebarAccent)}; background-color: hsl(var(--sidebar)); color: hsl(var(--sidebar-foreground)); }`,
      `.tenant-sidebar .text-primary { color: hsl(var(--sidebar-foreground)); }`,
    );
  }
  return rules.join("\n");
}
