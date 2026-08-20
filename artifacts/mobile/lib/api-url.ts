// Resolves the API base URL that gets baked into the bundle at build time.
// Single source of truth for the mobile API host — applied once in
// app/_layout.tsx via setBaseUrl().
//
// The value must be the server ORIGIN only (e.g. "https://admin.kaptnow.com").
// Every generated endpoint path already starts with "/api/...", so a base that
// itself ends in "/api" would produce broken "/api/api/..." requests. Mobile
// always talks HTTPS to the API — it never connects to the database directly.

export type ApiUrlEnv = {
  EXPO_PUBLIC_API_URL?: string;
  EXPO_PUBLIC_DOMAIN?: string;
};

export function resolveApiUrl(env: ApiUrlEnv): string | null {
  // 1. Explicit URL (eas.json env / build environment) wins, verbatim.
  if (env.EXPO_PUBLIC_API_URL) return env.EXPO_PUBLIC_API_URL;
  // 2. Bare domain injected by the local dev/build workflow (no protocol).
  if (env.EXPO_PUBLIC_DOMAIN) return `https://${env.EXPO_PUBLIC_DOMAIN}`;
  return null;
}
