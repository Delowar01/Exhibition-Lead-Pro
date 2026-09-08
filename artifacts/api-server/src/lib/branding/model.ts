// =============================================================================
// Batch 18 — tenant branding: platform defaults, validation and the resolved
// contract returned to every client. Pure; the service layer handles I/O.
// =============================================================================
import { AppError } from "../../middlewares/errorHandler.js";
import { WHITE, adjustForContrast, contrastRatio, foregroundFor, hexToHslTriplet, mix, normalizeHexColor, shade } from "./colors.js";

export const BRAND_THEMES = ["light", "dark", "system"] as const;
export type BrandTheme = (typeof BRAND_THEMES)[number];

/**
 * Platform defaults = the web design tokens (index.css :root): primary #FF6B00
 * (24 100% 50%), sidebar/header 233 28% 14% (#1A1C2E), default theme "system".
 * Clients apply overrides ONLY for custom values, so an unbranded tenant renders
 * byte-identically to today.
 */
export const PLATFORM_DEFAULTS = Object.freeze({
  primaryColor: "#FF6B00",
  sidebarColor: "#1A1C2E",
  defaultTheme: "system" as BrandTheme,
});

/** Minimum WCAG contrast for text on a solid brand surface (buttons, header). */
export const MIN_SURFACE_CONTRAST = 4.5;
/** Minimum contrast for link text / focus rings against page backgrounds. */
export const MIN_LINK_CONTRAST = 4.5;
const LIGHT_BG = "#F8F9FB"; // --background (light)
const DARK_BG = "#1A1A1A"; // --background (dark)

export interface BrandingInput {
  primaryColor?: string | null;
  sidebarColor?: string | null;
  defaultTheme?: BrandTheme | null;
}

export interface BrandingIssue {
  field: "primaryColor" | "sidebarColor" | "defaultTheme";
  message: string;
  code: string;
}

/** Contrast-safe derived colors (all #RRGGBB) computed once server-side. */
export interface DerivedColors {
  primaryForeground: string;
  primaryContrast: number;
  /** Link/focus variant of the primary that passes 4.5:1 on the light page background. */
  primaryLinkLight: string;
  /** Same for the dark page background. */
  primaryLinkDark: string;
  primarySoftLight: string;
  primarySoftDark: string;
  sidebarForeground: string;
  sidebarContrast: number;
  sidebarAccent: string;
  sidebarBorder: string;
  /** "H S% L%" triplets for the web tokens (derived from the same values). */
  tokens: Record<string, string>;
}

export interface ResolvedBranding {
  companyId: number;
  logoUrl: string | null;
  logoSource: "managed" | "legacy" | "none";
  primaryColor: string;
  sidebarColor: string;
  defaultTheme: BrandTheme;
  overrides: { primaryColor: string | null; sidebarColor: string | null; defaultTheme: BrandTheme | null; logo: boolean };
  defaults: { primaryColor: string; sidebarColor: string; defaultTheme: BrandTheme };
  derived: DerivedColors;
  isCustomized: boolean;
}

export interface PublicBranding {
  logoUrl: string | null;
  primaryColor: string;
  primaryForeground: string;
  sidebarColor: string;
  sidebarForeground: string;
  defaultTheme: BrandTheme;
}

function issue(field: BrandingIssue["field"], code: string, message: string): BrandingIssue {
  return { field, code, message };
}

/**
 * Validate a color for a brand surface. Returns the normalized "#RRGGBB" or an
 * issue: not-a-hex-color (CSS functions, gradients, names, URLs, scripts, 3-digit
 * shorthands are all rejected) or an unsafe mid-tone that cannot carry readable
 * text with either white or near-black.
 */
export function validateBrandColor(field: "primaryColor" | "sidebarColor", raw: unknown): { value: string } | { issue: BrandingIssue } {
  const normalized = normalizeHexColor(raw);
  if (!normalized) {
    return { issue: issue(field, "BRANDING_COLOR_INVALID", "Use a 6-digit hex color such as #1E3A8A.") };
  }
  const fg = foregroundFor(normalized);
  if (fg.ratio < MIN_SURFACE_CONTRAST) {
    return {
      issue: issue(
        field,
        "BRANDING_COLOR_CONTRAST",
        `This color cannot carry readable text (best contrast ${fg.ratio.toFixed(2)}:1, minimum 4.5:1). Choose a darker or lighter shade.`,
      ),
    };
  }
  return { value: normalized };
}

export function validateBrandTheme(raw: unknown): { value: BrandTheme } | { issue: BrandingIssue } {
  if (typeof raw === "string" && (BRAND_THEMES as readonly string[]).includes(raw)) return { value: raw as BrandTheme };
  return { issue: issue("defaultTheme", "BRANDING_THEME_INVALID", "Default theme must be light, dark or system.") };
}

export interface ValidatedBrandingPatch {
  brandPrimaryColor?: string | null;
  brandSidebarColor?: string | null;
  brandDefaultTheme?: BrandTheme | null;
}

/**
 * Validate a PUT body. `null` resets a field to the platform default; omitted
 * fields are left untouched; anything else must validate. Throws AppError(400,
 * BRANDING_INVALID) with `details` listing every issue.
 */
export function validateBrandingInput(input: unknown): ValidatedBrandingPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError(400, "Branding payload must be an object", { code: "BRANDING_INVALID" });
  }
  const body = input as Record<string, unknown>;
  const allowed = new Set(["primaryColor", "sidebarColor", "defaultTheme"]);
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new AppError(400, `Unknown branding field(s): ${unknown.join(", ")}`, { code: "BRANDING_INVALID" });
  }
  const patch: ValidatedBrandingPatch = {};
  const issues: BrandingIssue[] = [];
  if ("primaryColor" in body) {
    if (body.primaryColor === null) patch.brandPrimaryColor = null;
    else {
      const r = validateBrandColor("primaryColor", body.primaryColor);
      if ("issue" in r) issues.push(r.issue);
      else patch.brandPrimaryColor = r.value;
    }
  }
  if ("sidebarColor" in body) {
    if (body.sidebarColor === null) patch.brandSidebarColor = null;
    else {
      const r = validateBrandColor("sidebarColor", body.sidebarColor);
      if ("issue" in r) issues.push(r.issue);
      else patch.brandSidebarColor = r.value;
    }
  }
  if ("defaultTheme" in body) {
    if (body.defaultTheme === null) patch.brandDefaultTheme = null;
    else {
      const r = validateBrandTheme(body.defaultTheme);
      if ("issue" in r) issues.push(r.issue);
      else patch.brandDefaultTheme = r.value;
    }
  }
  if (issues.length > 0) {
    throw new AppError(400, "Branding is invalid", { code: "BRANDING_INVALID", details: { issues } });
  }
  if (Object.keys(patch).length === 0) {
    throw new AppError(400, "Nothing to update", { code: "BRANDING_INVALID" });
  }
  return patch;
}

export function deriveColors(primary: string, sidebar: string): DerivedColors {
  // The platform's own primary keeps the platform's white foreground (that is what
  // the unbranded portal renders); every CUSTOM color gets the contrast-derived one.
  const pFg = primary === PLATFORM_DEFAULTS.primaryColor ? { color: WHITE, ratio: contrastRatio(primary, WHITE) } : foregroundFor(primary);
  const sFg = foregroundFor(sidebar);
  const linkLight = adjustForContrast(primary, LIGHT_BG, MIN_LINK_CONTRAST);
  const linkDark = adjustForContrast(primary, DARK_BG, MIN_LINK_CONTRAST);
  const softLight = mix(primary, WHITE, 0.9);
  const softDark = mix(primary, DARK_BG, 0.8);
  const sidebarIsDark = sFg.color === WHITE;
  const accent = shade(sidebar, sidebarIsDark ? 0.07 : -0.07);
  const border = shade(sidebar, sidebarIsDark ? -0.04 : -0.1);
  return {
    primaryForeground: pFg.color,
    primaryContrast: Number(pFg.ratio.toFixed(2)),
    primaryLinkLight: linkLight,
    primaryLinkDark: linkDark,
    primarySoftLight: softLight,
    primarySoftDark: softDark,
    sidebarForeground: sFg.color,
    sidebarContrast: Number(sFg.ratio.toFixed(2)),
    sidebarAccent: accent,
    sidebarBorder: border,
    tokens: {
      primary: hexToHslTriplet(primary),
      primaryForeground: hexToHslTriplet(pFg.color),
      primaryLinkLight: hexToHslTriplet(linkLight),
      primaryLinkDark: hexToHslTriplet(linkDark),
      primarySoftLight: hexToHslTriplet(softLight),
      primarySoftDark: hexToHslTriplet(softDark),
      sidebar: hexToHslTriplet(sidebar),
      sidebarForeground: hexToHslTriplet(sFg.color),
      sidebarAccent: hexToHslTriplet(accent),
      sidebarAccentForeground: hexToHslTriplet(sFg.color),
      sidebarBorder: hexToHslTriplet(border),
    },
  };
}

export interface BrandingRow {
  id: number;
  logoUrl: string | null;
  brandPrimaryColor: string | null;
  brandSidebarColor: string | null;
  brandDefaultTheme: string | null;
  brandLogoKey: string | null;
  brandLogoContentType: string | null;
}

/** Only an https URL is ever surfaced as a legacy logo (anything else is ignored). */
export function legacyLogoUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Public path of a managed logo — an API route keyed by the object's random id, never a storage URL. */
export function managedLogoPath(companyId: number, logoKey: string): string | null {
  const id = logoIdFromKey(logoKey);
  return id ? `/api/branding/logos/${companyId}/${id}` : null;
}

export function logoIdFromKey(logoKey: string | null | undefined): string | null {
  if (!logoKey) return null;
  const m = /\/([0-9a-f]{32})\.(png|jpg|webp)$/.exec(logoKey);
  return m ? m[1] : null;
}

export function resolveBranding(row: BrandingRow): ResolvedBranding {
  const primary = normalizeHexColor(row.brandPrimaryColor);
  const sidebar = normalizeHexColor(row.brandSidebarColor);
  const theme = (BRAND_THEMES as readonly string[]).includes(row.brandDefaultTheme ?? "") ? (row.brandDefaultTheme as BrandTheme) : null;
  const managed = row.brandLogoKey ? managedLogoPath(row.id, row.brandLogoKey) : null;
  const legacy = managed ? null : legacyLogoUrl(row.logoUrl);
  const resolvedPrimary = primary ?? PLATFORM_DEFAULTS.primaryColor;
  const resolvedSidebar = sidebar ?? PLATFORM_DEFAULTS.sidebarColor;
  return {
    companyId: row.id,
    logoUrl: managed ?? legacy,
    logoSource: managed ? "managed" : legacy ? "legacy" : "none",
    primaryColor: resolvedPrimary,
    sidebarColor: resolvedSidebar,
    defaultTheme: theme ?? PLATFORM_DEFAULTS.defaultTheme,
    overrides: { primaryColor: primary, sidebarColor: sidebar, defaultTheme: theme, logo: managed != null },
    defaults: { ...PLATFORM_DEFAULTS },
    derived: deriveColors(resolvedPrimary, resolvedSidebar),
    isCustomized: primary != null || sidebar != null || theme != null || managed != null,
  };
}

/** The subset a public (unauthenticated) surface may see; null when nothing is customized. */
export function publicBranding(row: BrandingRow): PublicBranding | null {
  const r = resolveBranding(row);
  if (!r.isCustomized) return null;
  return {
    logoUrl: r.logoUrl,
    primaryColor: r.primaryColor,
    primaryForeground: r.derived.primaryForeground,
    sidebarColor: r.sidebarColor,
    sidebarForeground: r.derived.sidebarForeground,
    defaultTheme: r.defaultTheme,
  };
}

// Sanity: the platform defaults must themselves pass the rules they impose.
for (const c of [PLATFORM_DEFAULTS.primaryColor, PLATFORM_DEFAULTS.sidebarColor]) {
  if (foregroundFor(c).ratio < MIN_SURFACE_CONTRAST) throw new Error(`platform default ${c} fails its own contrast rule`);
}
