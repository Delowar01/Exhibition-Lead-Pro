/**
 * Portable HTTP edge policy: CORS origin allow-list and trusted-proxy hops.
 *
 * Both knobs are driven by standard environment variables so the API can run
 * behind any proxy topology outside Replit without code changes:
 *
 *   CORS_ORIGINS  — comma-separated list of exact origins allowed to make
 *                   cross-origin browser requests (e.g.
 *                   "https://app.example.com,https://admin.example.com"),
 *                   or "*" to explicitly allow every origin.
 *                   Unset: development allows all (preserves the historical
 *                   open-CORS dev behavior behind the Replit proxy);
 *                   production allows NONE (same-origin web clients and
 *                   native mobile apps are unaffected — they don't need CORS).
 *
 *   TRUST_PROXY   — Express `trust proxy` setting: an integer hop count
 *                   ("1", "2"), "true"/"false", or an address/subnet list
 *                   ("loopback", "10.0.0.0/8, 172.16.0.0/12").
 *                   Unset: defaults to 1 hop — exactly the historical Replit
 *                   behavior (one trusted reverse proxy appends the real
 *                   client IP as the last X-Forwarded-For entry).
 *
 * SECURITY: `req.ip` feeds IP allow-lists, login lockouts, and rate limiting
 * (see lib/security.ts). Trusting more hops than actually exist lets clients
 * spoof their IP via a forged X-Forwarded-For prefix; keep TRUST_PROXY equal
 * to the real number of trusted proxies in front of the API.
 */

const NAMED_SUBNETS = new Set(["loopback", "linklocal", "uniquelocal"]);

function isValidTrustEntry(entry: string): boolean {
  if (NAMED_SUBNETS.has(entry)) return true;
  const [addr, prefix, extra] = entry.split("/");
  if (extra !== undefined || !addr) return false;
  const isIpv6 = addr.includes(":");
  if (isIpv6) {
    // Loose IPv6 shape check: hex groups/compression, optional IPv4 tail.
    if (!/^[0-9a-fA-F:.]+$/.test(addr) || !addr.includes(":")) return false;
    if (prefix !== undefined && !(/^\d{1,3}$/.test(prefix) && Number(prefix) <= 128)) return false;
    return true;
  }
  const octets = addr.split(".");
  if (octets.length !== 4) return false;
  if (!octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return false;
  if (prefix !== undefined && !(/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32)) return false;
  return true;
}

/**
 * Parse TRUST_PROXY into a value accepted by `app.set("trust proxy", ...)`.
 *
 * FAILS CLOSED: any value that is not `true`/`false`, a non-negative
 * digit-only hop count, or a comma-separated list of valid IPv4/IPv6
 * addresses, CIDR subnets, or named subnets (loopback/linklocal/uniquelocal)
 * throws — aborting startup — rather than being handed to Express, where a
 * malformed trust policy could silently mis-attribute client IPs and
 * undermine the IP-based lockout/rate-limit/allow-list controls.
 */
export function parseTrustProxy(raw: string | undefined): number | boolean | string {
  const trimmed = raw?.trim();
  if (!trimmed) return 1; // historical default: exactly one trusted hop
  const lower = trimmed.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const entries = trimmed.split(",").map((e) => e.trim()).filter((e) => e.length > 0);
  if (entries.length > 0 && entries.every((e) => isValidTrustEntry(e.toLowerCase()))) {
    return entries.join(", ");
  }
  throw new Error(
    `Invalid TRUST_PROXY value "${trimmed}". Use true/false, a non-negative hop count ` +
      `(e.g. 1), or a comma-separated list of IPs/CIDR subnets/named subnets ` +
      `(loopback, linklocal, uniquelocal).`,
  );
}

/**
 * Parse CORS_ORIGINS. Returns:
 *  - null   when unset/empty (caller applies the environment default)
 *  - "*"    when explicitly configured to allow every origin
 *  - array  of normalized exact origins (trailing slashes stripped)
 */
export function parseCorsOrigins(raw: string | undefined): "*" | string[] | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (trimmed === "*") return "*";
  const origins = trimmed
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/, ""))
    .filter((entry) => entry.length > 0);
  return origins.length > 0 ? origins : null;
}

/**
 * Resolve the `origin` option for the cors() middleware.
 *  - explicit "*"        → allow all (wildcard header, no credentials)
 *  - explicit allow-list → exact-match list
 *  - unset + development → allow all (historical dev behavior)
 *  - unset + production  → false: no CORS headers are emitted, so browsers
 *    refuse cross-origin reads. Same-origin requests and non-browser clients
 *    (mobile apps, curl, server-to-server) are unaffected.
 */
export function resolveCorsOrigin(
  configured: "*" | string[] | null,
  isProduction: boolean,
): "*" | string[] | false {
  if (configured === "*") return "*";
  if (configured) return configured;
  return isProduction ? false : "*";
}

/**
 * Full cors() middleware options for a resolved origin setting. Credentials
 * (cookies) are only enabled for an explicit allow-list — the CORS spec
 * forbids `Access-Control-Allow-Credentials` with a wildcard origin, and the
 * cookie-based refresh flow is only relevant when a browser client is served
 * from a configured foreign origin.
 */
export function buildCorsOptions(origin: "*" | string[] | false): {
  origin: "*" | string[] | false;
  credentials?: boolean;
} {
  return Array.isArray(origin) ? { origin, credentials: true } : { origin };
}
