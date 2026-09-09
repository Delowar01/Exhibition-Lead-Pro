import { describe, it, expect } from "vitest";
import { resolveBillingStripeMode, stripeKeyMode, resolveBillingProviderSelection, validateBillingReturnUrl } from "../src/config.js";

// Batch 20 Correction 1 — pure configuration rules: explicit Stripe mode, key/mode
// agreement, fake-provider = test mode only, and the central return-URL validator
// (production requires explicit HTTPS without credentials / query / fragment and
// never falls back to localhost; development may use explicit localhost HTTP).

describe("resolveBillingStripeMode", () => {
  it("defaults to live in production and test elsewhere; accepts only test|live", () => {
    expect(resolveBillingStripeMode("production", undefined)).toBe("live");
    expect(resolveBillingStripeMode("production", "")).toBe("live");
    expect(resolveBillingStripeMode("development", undefined)).toBe("test");
    expect(resolveBillingStripeMode("test", "  LIVE ")).toBe("live");
    expect(resolveBillingStripeMode("production", "test")).toBe("test"); // explicit opt-in only
    expect(resolveBillingStripeMode("production", "sandbox")).toBeNull();
    expect(resolveBillingStripeMode("development", "prod")).toBeNull();
  });
});

describe("stripeKeyMode", () => {
  it("derives the mode from sk_/rk_ prefixes only", () => {
    expect(stripeKeyMode(undefined)).toBeNull();
    expect(stripeKeyMode("")).toBeNull();
    expect(stripeKeyMode("sk_test_abc")).toBe("test");
    expect(stripeKeyMode("sk_live_abc")).toBe("live");
    expect(stripeKeyMode("rk_live_abc")).toBe("live");
    expect(stripeKeyMode("pk_live_abc")).toBe("unknown");
    expect(stripeKeyMode("whatever")).toBe("unknown");
  });
});

describe("resolveBillingProviderSelection (mode enforcement)", () => {
  it("stripe: mode must be valid and agree with the key", () => {
    expect(resolveBillingProviderSelection("production", "stripe", true, true, { stripeMode: "live", keyMode: "live" })).toEqual({ kind: "stripe", reason: null });
    expect(resolveBillingProviderSelection("production", "stripe", true, true, { stripeMode: "test", keyMode: "test" })).toEqual({ kind: "stripe", reason: null });
    expect(resolveBillingProviderSelection("production", "stripe", true, true, { stripeMode: null, keyMode: "live" })).toEqual({ kind: "unavailable", reason: "STRIPE_MODE_INVALID" });
    expect(resolveBillingProviderSelection("production", "stripe", true, true, { stripeMode: "live", keyMode: "test" })).toEqual({ kind: "unavailable", reason: "STRIPE_MODE_KEY_MISMATCH" });
    expect(resolveBillingProviderSelection("development", "stripe", true, true, { stripeMode: "test", keyMode: "live" })).toEqual({ kind: "unavailable", reason: "STRIPE_MODE_KEY_MISMATCH" });
    expect(resolveBillingProviderSelection("development", "stripe", true, true, { stripeMode: "test", keyMode: "unknown" })).toEqual({ kind: "stripe", reason: null }); // restricted keys without a recognizable prefix
    expect(resolveBillingProviderSelection("production", "stripe", false, true, { stripeMode: "live" })).toEqual({ kind: "unavailable", reason: "STRIPE_SECRET_KEY_MISSING" });
    expect(resolveBillingProviderSelection("production", "stripe", true, false, { stripeMode: "live" })).toEqual({ kind: "unavailable", reason: "STRIPE_WEBHOOK_SECRET_MISSING" });
  });
  it("fake: never in production, test mode only", () => {
    expect(resolveBillingProviderSelection("development", "fake", false, true, { stripeMode: "test" })).toEqual({ kind: "fake", reason: null });
    expect(resolveBillingProviderSelection("development", "fake", false, true, { stripeMode: "live" })).toEqual({ kind: "unavailable", reason: "FAKE_PROVIDER_TEST_MODE_ONLY" });
    expect(resolveBillingProviderSelection("development", "fake", false, true, { stripeMode: null })).toEqual({ kind: "unavailable", reason: "STRIPE_MODE_INVALID" });
    expect(resolveBillingProviderSelection("production", "fake", false, true, { stripeMode: "test" })).toEqual({ kind: "unavailable", reason: "FAKE_PROVIDER_FORBIDDEN" });
    expect(resolveBillingProviderSelection("development", "fake", false, false, { stripeMode: "test" })).toEqual({ kind: "unavailable", reason: "STRIPE_WEBHOOK_SECRET_MISSING" });
  });
  it("none / unknown", () => {
    expect(resolveBillingProviderSelection("production", undefined, false, false)).toEqual({ kind: "unavailable", reason: "NOT_CONFIGURED" });
    expect(resolveBillingProviderSelection("production", "none", true, true)).toEqual({ kind: "unavailable", reason: "NOT_CONFIGURED" });
    expect(resolveBillingProviderSelection("production", "paddle", true, true)).toEqual({ kind: "unavailable", reason: "UNKNOWN_PROVIDER" });
  });
});

describe("validateBillingReturnUrl", () => {
  const cases: Array<[string, string | undefined, string | null, string | null]> = [
    // env, raw, expected url, expected reason
    ["production", undefined, null, "RETURN_URL_MISSING"],
    ["production", "   ", null, "RETURN_URL_MISSING"],
    ["production", "https://app.example.com", "https://app.example.com", null],
    ["production", "https://app.example.com/", "https://app.example.com", null],
    ["production", "https://app.example.com/base/", "https://app.example.com/base", null],
    ["production", "http://app.example.com", null, "RETURN_URL_INSECURE"],
    ["production", "https://localhost", null, "RETURN_URL_LOCALHOST"],
    ["production", "https://127.0.0.1", null, "RETURN_URL_LOCALHOST"],
    ["production", "https://[::1]", null, "RETURN_URL_LOCALHOST"],
    ["production", "https://app.localhost", null, "RETURN_URL_LOCALHOST"],
    ["production", "https://user:pw@app.example.com", null, "RETURN_URL_INVALID"],
    ["production", "https://app.example.com/?next=x", null, "RETURN_URL_INVALID"],
    ["production", "https://app.example.com/#frag", null, "RETURN_URL_INVALID"],
    ["production", "https://app.example.com?", null, "RETURN_URL_INVALID"],
    ["production", "ftp://app.example.com", null, "RETURN_URL_INVALID"],
    ["production", "app.example.com", null, "RETURN_URL_INVALID"],
    ["production", "not a url", null, "RETURN_URL_INVALID"],
    ["development", "http://localhost:80", "http://localhost", null], // default port folds into the origin
    ["development", "http://127.0.0.1:3000/", "http://127.0.0.1:3000", null],
    ["development", "http://app.example.com", "http://app.example.com", null],
    ["development", undefined, null, "RETURN_URL_MISSING"], // no implicit localhost fallback anywhere
    ["development", "http://localhost:80/?x=1", null, "RETURN_URL_INVALID"],
    ["test", "https://user@host.test", null, "RETURN_URL_INVALID"],
  ];
  for (const [env, raw, url, reason] of cases) {
    it(`${env} ${JSON.stringify(raw)} → ${url ?? reason}`, () => {
      expect(validateBillingReturnUrl(env, raw)).toEqual({ url, reason });
    });
  }
});
