// API-base resolution + build-profile validation for the Hostinger cutover.
// Proves (a) the resolution precedence used by app/_layout.tsx, (b) that the
// EAS preview/production profiles bake in the hosted customer API origin and
// no Replit URL survives in active build config, and (c) that the origin
// composes with the generated "/api/..." paths without doubling the prefix.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import { setBaseUrl, getBaseUrl } from "@workspace/api-client-react";

import { resolveApiUrl } from "./api-url";

const HOSTED_API_ORIGIN = "https://admin.kaptnow.com";

describe("resolveApiUrl precedence", () => {
  it("explicit EXPO_PUBLIC_API_URL wins, verbatim", () => {
    expect(
      resolveApiUrl({
        EXPO_PUBLIC_API_URL: HOSTED_API_ORIGIN,
        EXPO_PUBLIC_DOMAIN: "something-else.example",
      }),
    ).toBe(HOSTED_API_ORIGIN);
  });

  it("falls back to https:// + EXPO_PUBLIC_DOMAIN", () => {
    expect(resolveApiUrl({ EXPO_PUBLIC_DOMAIN: "dev.example.com" })).toBe(
      "https://dev.example.com",
    );
  });

  it("resolves to null when nothing is configured", () => {
    expect(resolveApiUrl({})).toBeNull();
  });
});

describe("eas.json build profiles (active build config)", () => {
  // String(new URL(...)) keeps this compatible with the RN-typed global URL.
  const easRaw = readFileSync(
    fileURLToPath(String(new URL("../eas.json", import.meta.url))),
    "utf-8",
  );
  const eas = JSON.parse(easRaw);

  it("preview and production bake in the hosted customer API origin", () => {
    expect(eas.build.preview.env.EXPO_PUBLIC_API_URL).toBe(HOSTED_API_ORIGIN);
    expect(eas.build.production.env.EXPO_PUBLIC_API_URL).toBe(HOSTED_API_ORIGIN);
  });

  it("contains no Replit URL and no localhost", () => {
    expect(easRaw.toLowerCase()).not.toContain("replit");
    expect(easRaw.toLowerCase()).not.toContain("localhost");
  });

  it("bakes in an origin, never a path (guards against /api/api/...)", () => {
    for (const profile of ["preview", "production"] as const) {
      const url = new URL(eas.build[profile].env.EXPO_PUBLIC_API_URL);
      expect(url.protocol).toBe("https:");
      expect(url.pathname).toBe("/");
    }
  });
});

describe("origin + generated client path composition", () => {
  afterEach(() => setBaseUrl(null));

  it("forms exactly one /api prefix and tolerates a trailing slash", () => {
    setBaseUrl(HOSTED_API_ORIGIN);
    expect(`${getBaseUrl()}/api/auth/login`).toBe(
      "https://admin.kaptnow.com/api/auth/login",
    );

    setBaseUrl(`${HOSTED_API_ORIGIN}/`);
    expect(getBaseUrl()).toBe(HOSTED_API_ORIGIN);
  });
});
