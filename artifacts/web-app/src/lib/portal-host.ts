// Portal-host resolution for the split-subdomain deployment. Single source of
// truth for hostname behavior — never scatter window.location.hostname checks.
//
//   admin.kaptnow.com → "customer"  (tenant portal only; /platform never renders)
//   elite.kaptnow.com → "platform"  (Platform Owner portal only; /admin never renders)
//   anything else     → "mixed"     (dev.kaptnow.com staging, localhost, previews)
//
// The two portal hosts are separate browser origins with separate localStorage
// by design — tokens are never shared across them. This module is UX/access
// separation on top of the server's real authorization, never a replacement.

export type PortalHost = "customer" | "platform" | "mixed";

export const CUSTOMER_PORTAL_URL = "https://admin.kaptnow.com/";
export const PLATFORM_PORTAL_URL = "https://elite.kaptnow.com/";

export function resolvePortalHost(
  hostname: string = window.location.hostname,
): PortalHost {
  const host = hostname.toLowerCase();
  if (host === "admin.kaptnow.com") return "customer";
  if (host === "elite.kaptnow.com") return "platform";
  return "mixed";
}
