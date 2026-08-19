// Portal-host resolution for the split-subdomain deployment:
//
//   admin.kaptnow.com → customer portal (tenant roles only)
//   elite.kaptnow.com → Platform Owner portal (platform_owner only)
//   dev.kaptnow.com   → retired (redirect-only host; every login is refused)
//   anything else     → mixed (localhost development and tests)
//
// This is a UX/access convenience layered ON TOP of the real authorization —
// requireRole / requireTenantUser / tenantScope remain the security boundary.
// The hostname must never be treated as one.

export type PortalHost = "customer" | "platform" | "retired" | "mixed";

export const CUSTOMER_PORTAL_HOST = "admin.kaptnow.com";
export const PLATFORM_PORTAL_HOST = "elite.kaptnow.com";
export const RETIRED_DEV_HOST = "dev.kaptnow.com";

export function resolvePortalHost(hostname: string | undefined): PortalHost {
  const host = (hostname ?? "").toLowerCase();
  if (host === CUSTOMER_PORTAL_HOST) return "customer";
  if (host === PLATFORM_PORTAL_HOST) return "platform";
  if (host === RETIRED_DEV_HOST) return "retired";
  return "mixed";
}

// Human-facing refusal for a host that must not complete this login, or null
// when the combination is allowed. The retired dev host refuses every role;
// mixed hosts accept every role.
export function portalLoginRefusal(portal: PortalHost, isPlatformOwner: boolean): string | null {
  if (portal === "retired") {
    return `Please sign in at ${CUSTOMER_PORTAL_HOST} or ${PLATFORM_PORTAL_HOST}`;
  }
  if (portal === "customer" && isPlatformOwner) {
    return `Platform Owner access is available at ${PLATFORM_PORTAL_HOST}`;
  }
  if (portal === "platform" && !isPlatformOwner) {
    return `Customer access is available at ${CUSTOMER_PORTAL_HOST}`;
  }
  return null;
}
