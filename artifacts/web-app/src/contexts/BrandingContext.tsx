import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from "react";
import { useGetTenantBranding, getGetTenantBrandingQueryKey, type TenantBranding } from "@workspace/api-client-react";
import { useAuth } from "./AuthContext";
import { useTheme } from "./ThemeContext";
import { buildBrandingCss, paletteFromBranding } from "@/lib/branding-tokens";

// =============================================================================
// Batch 18 — resolved tenant branding for the authenticated customer portal.
//   • fetched once per (user, company) — the query key carries both ids, so a
//     different tenant on the same browser never hits a cached sheet;
//   • applied as ONE <style> element (light + dark rules) — only customized
//     surfaces are overridden, an unbranded tenant renders the platform defaults;
//   • removed synchronously (layout effect) whenever the user logs out, changes,
//     or is a platform operator — the shared login page and the platform portal
//     always keep the platform look;
//   • the tenant default theme is handed to the theme provider, where an explicit
//     user preference (scoped per user + company) always wins.
// =============================================================================

const STYLE_ID = "tenant-branding";

interface BrandingContextValue {
  branding: TenantBranding | null;
  /** True for an authenticated tenant member (never for platform operators or logged-out visitors). */
  isTenant: boolean;
  isLoading: boolean;
  refetch: () => void;
}

const BrandingContext = createContext<BrandingContextValue>({ branding: null, isTenant: false, isLoading: false, refetch: () => undefined });

function removeSheet() {
  document.getElementById(STYLE_ID)?.remove();
  document.documentElement.removeAttribute("data-tenant-branded");
}

function applySheet(b: TenantBranding) {
  const css = buildBrandingCss(paletteFromBranding(b), { primary: b.overrides.primaryColor != null, sidebar: b.overrides.sidebarColor != null });
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
    removeSheet();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
  document.documentElement.setAttribute("data-tenant-branded", "true");
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { configureScope } = useTheme();
  const isTenant = !!user && user.role !== "platform_owner";
  const scope = user ? (user.companyId != null ? `u${user.id}c${user.companyId}` : `u${user.id}`) : null;

  const query = useGetTenantBranding({
    query: {
      enabled: isTenant,
      queryKey: [...getGetTenantBrandingQueryKey(), { userId: user?.id ?? null, companyId: user?.companyId ?? null }],
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  });
  const branding = isTenant && query.data ? query.data : null;

  // Apply / clear before paint so another tenant's colors never flash.
  useLayoutEffect(() => {
    if (!isTenant || !branding) {
      removeSheet();
      return;
    }
    applySheet(branding);
  }, [isTenant, branding]);
  useLayoutEffect(() => () => removeSheet(), []);

  // Theme precedence: explicit user preference (scoped per user + company) → the tenant's own default (only when
  // one was set — an unbranded tenant simply follows the platform default) → system.
  useLayoutEffect(() => {
    configureScope(scope, isTenant ? (branding?.overrides.defaultTheme ?? null) : null);
  }, [scope, isTenant, branding?.overrides.defaultTheme, configureScope]);

  const value = useMemo<BrandingContextValue>(
    () => ({ branding, isTenant, isLoading: isTenant && query.isLoading, refetch: () => void query.refetch() }),
    [branding, isTenant, query.isLoading, query.refetch],
  );
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): BrandingContextValue {
  return useContext(BrandingContext);
}
