// Portal-host resolution for the split-subdomain deployment. Single source of
// truth for hostname behavior — never scatter window.location.hostname checks.
//
//   admin.kaptnow.com → "customer"  (tenant portal only; /platform never renders)
//   elite.kaptnow.com → "platform"  (Platform Owner portal only; /admin never renders)
//   dev.kaptnow.com   → "retired"   (redirect-only; nothing renders, no login)
//   anything else     → "mixed"     (localhost development/tests, previews)
//
// The two portal hosts are separate browser origins with separate localStorage
// by design — tokens are never shared across them. This module is UX/access
// separation on top of the server's real authorization, never a replacement.

export type PortalHost = "customer" | "platform" | "retired" | "mixed";

export const CUSTOMER_PORTAL_ORIGIN = "https://admin.kaptnow.com";
export const PLATFORM_PORTAL_ORIGIN = "https://elite.kaptnow.com";
export const CUSTOMER_PORTAL_URL = `${CUSTOMER_PORTAL_ORIGIN}/`;
export const PLATFORM_PORTAL_URL = `${PLATFORM_PORTAL_ORIGIN}/`;

export function resolvePortalHost(
  hostname: string = window.location.hostname,
): PortalHost {
  const host = hostname.toLowerCase();
  if (host === "admin.kaptnow.com") return "customer";
  if (host === "elite.kaptnow.com") return "platform";
  if (host === "dev.kaptnow.com") return "retired";
  return "mixed";
}

// Where a browser request to the retired host belongs: /platform routes go to
// the Platform Owner portal, everything else (/, /login, /admin/*, public
// flows) to the customer portal — always keeping the same path/query/hash.
export function retiredHostRedirectUrl(
  pathname: string = window.location.pathname,
  search: string = window.location.search,
  hash: string = window.location.hash,
): string {
  const origin =
    pathname === "/platform" || pathname.startsWith("/platform/")
      ? PLATFORM_PORTAL_ORIGIN
      : CUSTOMER_PORTAL_ORIGIN;
  return `${origin}${pathname}${search}${hash}`;
}
