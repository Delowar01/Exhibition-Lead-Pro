// Portal-host resolution for the split-subdomain deployment:
//
//   admin.kaptnow.com → customer portal (tenant roles only)
//   elite.kaptnow.com → Platform Owner portal (platform_owner only)
//   anything else     → mixed (dev.kaptnow.com staging, localhost, tests)
//
// This is a UX/access convenience layered ON TOP of the real authorization —
// requireRole / requireTenantUser / tenantScope remain the security boundary.
// The hostname must never be treated as one.

export type PortalHost = "customer" | "platform" | "mixed";

export const CUSTOMER_PORTAL_HOST = "admin.kaptnow.com";
export const PLATFORM_PORTAL_HOST = "elite.kaptnow.com";

export function resolvePortalHost(hostname: string | undefined): PortalHost {
  const host = (hostname ?? "").toLowerCase();
  if (host === CUSTOMER_PORTAL_HOST) return "customer";
  if (host === PLATFORM_PORTAL_HOST) return "platform";
  return "mixed";
}

// Human-facing refusal for a role/portal mismatch at login, or null when the
// combination is allowed. Mixed hosts accept every role.
export function portalLoginRefusal(portal: PortalHost, isPlatformOwner: boolean): string | null {
  if (portal === "customer" && isPlatformOwner) {
    return `Platform Owner access is available at ${PLATFORM_PORTAL_HOST}`;
  }
  if (portal === "platform" && !isPlatformOwner) {
    return `Customer access is available at ${CUSTOMER_PORTAL_HOST}`;
  }
  return null;
}
