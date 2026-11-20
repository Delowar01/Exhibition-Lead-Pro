// Platform AI provider management — the pure policy engine (src/ai/policy.ts), the
// fallback-eligibility rule (src/ai/runner.ts) and the price table (src/ai/pricing.ts).
// No server, no database, no network.
import { describe, it, expect } from "vitest";
import {
  availabilityImpact,
  defaultPolicy,
  parseStoredPolicy,
  resolveChain,
  validatePolicy,
  MAX_MONTHLY_LIMIT_MICRO_USD,
  MAX_TENANT_OVERRIDES,
  type PlatformAiPolicy,
  type PolicyCatalog,
  type PolicyProvider,
} from "../src/ai/policy.js";
import { categorizeError, fallbackTimeoutMs, isFallbackEligible, isProviderDown, isRetryable, runAi } from "../src/ai/runner.js";
import { ceilingCostMicroUsd, estimateCostMicroUsd, hasPricing } from "../src/ai/pricing.js";
import { AiProviderError, type AiProvider, type AiRequest } from "../src/ai/types.js";
import { AppError } from "../src/middlewares/errorHandler.js";
import { config } from "../src/config.js";

const catalog: PolicyCatalog = {
  modelsFor: (p) => (p === "anthropic" ? ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] : ["gemini-2.5-flash"]),
  defaultPrimary: "anthropic",
};

const both = () => true;
const only = (p: PolicyProvider) => (x: PolicyProvider) => x === p;
const none = () => false;

function policy(over: Partial<PlatformAiPolicy> = {}): PlatformAiPolicy {
  return { ...defaultPolicy(catalog), ...over };
}
function resolve(p: PlatformAiPolicy, usable: (x: PolicyProvider, model: string) => boolean, extra: Partial<Parameters<typeof resolveChain>[1]> = {}) {
  return resolveChain(p, { stubAvailable: false, usable, legacyDefault: "gemini", ...extra });
}
const chainOf = (r: ReturnType<typeof resolve>) => r.candidates.map((c) => `${c.provider}:${c.model}:${c.role}`);

describe("default policy — the owner's stated preference", () => {
  it("is Claude enabled, Gemini enabled, Claude primary, automatic fallback on, no limits, no overrides", () => {
    expect(defaultPolicy(catalog)).toEqual({
      providers: {
        anthropic: { enabled: true, model: "claude-opus-5-5", monthlyLimitMicroUsd: null },
        gemini: { enabled: true, model: "gemini-2.5-flash", monthlyLimitMicroUsd: null },
      },
      primary: "anthropic",
      fallbackEnabled: true,
      alertThresholdPct: 80,
      tenantOverrides: [],
    });
  });
});

describe("resolveChain — which provider serves a request", () => {
  it("both configured: the primary serves and the other is the single fallback", () => {
    expect(chainOf(resolve(policy(), both))).toEqual(["anthropic:claude-opus-5-5:primary", "gemini:gemini-2.5-flash:fallback"]);
    expect(chainOf(resolve(policy({ primary: "gemini" }), both))).toEqual(["gemini:gemini-2.5-flash:primary", "anthropic:claude-opus-5-5:fallback"]);
  });

  it("never yields more than two candidates and never the same provider twice", () => {
    for (const primary of ["anthropic", "gemini"] as const) {
      const r = resolve(policy({ primary, tenantOverrides: [{ companyId: 7, provider: primary, model: null }] }), both, { companyId: 7 });
      expect(r.candidates.length).toBeLessThanOrEqual(2);
      expect(new Set(r.candidates.map((c) => c.provider)).size).toBe(r.candidates.length);
    }
  });

  it("Claude is the primary but has NO credentials: Gemini keeps serving, with nothing to fall back to", () => {
    const r = resolve(policy(), only("gemini"));
    expect(chainOf(r)).toEqual(["gemini:gemini-2.5-flash:primary"]);
    expect(r.display).toEqual({ provider: "gemini", model: "gemini-2.5-flash" });
    expect(r.skipped).toEqual([{ provider: "anthropic", why: "not_configured" }]);
    expect(r.unavailable).toBeNull();
  });

  it("an unconfigured provider is skipped whether or not automatic fallback is on", () => {
    expect(chainOf(resolve(policy({ fallbackEnabled: false }), only("gemini")))).toEqual(["gemini:gemini-2.5-flash:primary"]);
  });

  it("automatic fallback off: one candidate only, even with both configured", () => {
    expect(chainOf(resolve(policy({ fallbackEnabled: false }), both))).toEqual(["anthropic:claude-opus-5-5:primary"]);
  });

  it("a disabled provider serves nothing — not as primary, not as fallback", () => {
    const claudeOff = policy({ providers: { ...defaultPolicy(catalog).providers, anthropic: { enabled: false, model: "claude-opus-5-5", monthlyLimitMicroUsd: null } } });
    const r = resolve(claudeOff, both);
    expect(chainOf(r)).toEqual(["gemini:gemini-2.5-flash:primary"]);
    expect(r.skipped).toContainEqual({ provider: "anthropic", why: "disabled" });

    const geminiOff = policy({ providers: { ...defaultPolicy(catalog).providers, gemini: { enabled: false, model: "gemini-2.5-flash", monthlyLimitMicroUsd: null } } });
    expect(chainOf(resolve(geminiOff, both))).toEqual(["anthropic:claude-opus-5-5:primary"]);
  });

  it("both disabled: nothing serves and the reason is none_enabled", () => {
    const off = policy({
      providers: { anthropic: { enabled: false, model: "claude-opus-5-5", monthlyLimitMicroUsd: null }, gemini: { enabled: false, model: "gemini-2.5-flash", monthlyLimitMicroUsd: null } },
    });
    const r = resolve(off, both);
    expect(r.candidates).toEqual([]);
    expect(r.unavailable).toBe("none_enabled");
  });

  it("both enabled, neither configured: nothing serves, the reason is none_configured, and the provider reported is the pre-policy default", () => {
    const r = resolve(policy(), none);
    expect(r.candidates).toEqual([]);
    expect(r.unavailable).toBe("none_configured");
    expect(r.display).toEqual({ provider: "gemini", model: "gemini-2.5-flash" });
  });

  it("a tenant's own stored provider NEVER selects a real provider", () => {
    for (const stored of ["gemini", "anthropic", "openai", ""]) {
      const r = resolve(policy(), both, { tenant: { provider: stored, model: "anything" }, companyId: 5 });
      expect(chainOf(r)).toEqual(["anthropic:claude-opus-5-5:primary", "gemini:gemini-2.5-flash:fallback"]);
      expect(r.source).toBe("platform");
    }
  });

  it("changing the platform primary moves every tenant without an override", () => {
    const tenant = { provider: "gemini", model: "gemini-2.5-flash" };
    expect(resolve(policy({ primary: "anthropic" }), both, { tenant, companyId: 5 }).candidates[0].provider).toBe("anthropic");
    expect(resolve(policy({ primary: "gemini" }), both, { tenant, companyId: 5 }).candidates[0].provider).toBe("gemini");
  });

  it("a tenant on the test provider uses it alone — only where it is registered", () => {
    const tenant = { provider: "stub", model: "stub-model" };
    const dev = resolve(policy(), both, { tenant, stubAvailable: true });
    expect(chainOf(dev)).toEqual(["stub:stub-model:primary"]);
    expect(dev.source).toBe("tenant_stub");
    // In production the test provider does not exist: the platform policy applies.
    const prod = resolve(policy(), both, { tenant, stubAvailable: false });
    expect(chainOf(prod)).toEqual(["anthropic:claude-opus-5-5:primary", "gemini:gemini-2.5-flash:fallback"]);
  });

  it("a Platform Owner override pins a company to a provider (and optionally a model); other companies are unaffected", () => {
    const p = policy({ tenantOverrides: [{ companyId: 42, provider: "gemini", model: null }, { companyId: 43, provider: "anthropic", model: "claude-haiku-5-5" }] });
    const pinned = resolve(p, both, { companyId: 42 });
    expect(chainOf(pinned)).toEqual(["gemini:gemini-2.5-flash:primary", "anthropic:claude-opus-5-5:fallback"]);
    expect(pinned.source).toBe("tenant_override");
    expect(chainOf(resolve(p, both, { companyId: 43 }))).toEqual(["anthropic:claude-haiku-5-5:primary", "gemini:gemini-2.5-flash:fallback"]);
    expect(chainOf(resolve(p, both, { companyId: 44 }))).toEqual(["anthropic:claude-opus-5-5:primary", "gemini:gemini-2.5-flash:fallback"]);
  });

  it("an override cannot bring back a disabled provider: the platform policy applies instead", () => {
    const p = policy({
      providers: { ...defaultPolicy(catalog).providers, gemini: { enabled: false, model: "gemini-2.5-flash", monthlyLimitMicroUsd: null } },
      tenantOverrides: [{ companyId: 42, provider: "gemini", model: null }],
    });
    const r = resolve(p, both, { companyId: 42 });
    expect(chainOf(r)).toEqual(["anthropic:claude-opus-5-5:primary"]);
    expect(r.source).toBe("platform");
  });
});

describe("validatePolicy — input from a client is checked strictly", () => {
  const valid = () => JSON.parse(JSON.stringify(defaultPolicy(catalog)));

  it("accepts a complete document", () => {
    const r = validatePolicy({ ...valid(), tenantOverrides: [{ companyId: 9, provider: "gemini", model: null }] }, catalog);
    expect(r.ok).toBe(true);
  });

  const bad: Array<[string, (p: any) => void, string]> = [
    ["an unknown top-level key", (p) => (p.apiKey = "x"), "POLICY_UNKNOWN_FIELD"],
    ["an unknown provider", (p) => (p.providers.openai = { enabled: true, model: "x", monthlyLimitMicroUsd: null }), "POLICY_PROVIDER_UNKNOWN"],
    ["a missing provider", (p) => delete p.providers.gemini, "POLICY_PROVIDER_MISSING"],
    ["an unknown key inside a provider", (p) => (p.providers.anthropic.apiKey = "x"), "POLICY_UNKNOWN_FIELD"],
    ["a non-boolean enabled", (p) => (p.providers.anthropic.enabled = "yes"), "POLICY_ENABLED_INVALID"],
    ["a model that is not selectable", (p) => (p.providers.anthropic.model = "claude-unlisted-model"), "POLICY_MODEL_NOT_SUPPORTED"],
    ["another provider's model", (p) => (p.providers.gemini.model = "claude-opus-5-5"), "POLICY_MODEL_NOT_SUPPORTED"],
    ["a negative limit", (p) => (p.providers.gemini.monthlyLimitMicroUsd = -1), "POLICY_LIMIT_INVALID"],
    ["a fractional limit", (p) => (p.providers.gemini.monthlyLimitMicroUsd = 1.5), "POLICY_LIMIT_INVALID"],
    ["a limit above the ceiling", (p) => (p.providers.gemini.monthlyLimitMicroUsd = MAX_MONTHLY_LIMIT_MICRO_USD + 1), "POLICY_LIMIT_INVALID"],
    ["a limit given as text", (p) => (p.providers.gemini.monthlyLimitMicroUsd = "100"), "POLICY_LIMIT_INVALID"],
    ["an unknown primary", (p) => (p.primary = "stub"), "POLICY_PRIMARY_INVALID"],
    ["a non-boolean fallback", (p) => (p.fallbackEnabled = 1), "POLICY_FALLBACK_INVALID"],
    ["an alert threshold of 0", (p) => (p.alertThresholdPct = 0), "POLICY_ALERT_INVALID"],
    ["an alert threshold above 100", (p) => (p.alertThresholdPct = 101), "POLICY_ALERT_INVALID"],
    ["overrides that are not a list", (p) => (p.tenantOverrides = {}), "POLICY_OVERRIDES_INVALID"],
    ["too many overrides", (p) => (p.tenantOverrides = Array.from({ length: MAX_TENANT_OVERRIDES + 1 }, (_, i) => ({ companyId: i + 1, provider: "gemini", model: null }))), "POLICY_OVERRIDES_TOO_MANY"],
    ["a duplicate company", (p) => (p.tenantOverrides = [{ companyId: 3, provider: "gemini", model: null }, { companyId: 3, provider: "anthropic", model: null }]), "POLICY_OVERRIDE_DUPLICATE"],
    ["an override for the test provider", (p) => (p.tenantOverrides = [{ companyId: 3, provider: "stub", model: null }]), "POLICY_PROVIDER_UNKNOWN"],
    ["an override with a model of the other provider", (p) => (p.tenantOverrides = [{ companyId: 3, provider: "gemini", model: "claude-opus-5-5" }]), "POLICY_MODEL_NOT_SUPPORTED"],
    ["an override with a bad company id", (p) => (p.tenantOverrides = [{ companyId: 0, provider: "gemini", model: null }]), "POLICY_OVERRIDE_COMPANY_INVALID"],
  ];
  for (const [name, mutate, code] of bad) {
    it(`refuses ${name} (${code})`, () => {
      const p = valid();
      mutate(p);
      const r = validatePolicy(p, catalog);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.map((i) => i.code)).toContain(code);
    });
  }

  it("refuses anything that is not an object", () => {
    for (const v of [null, undefined, "policy", 3, []]) expect(validatePolicy(v, catalog).ok).toBe(false);
  });
});

describe("parseStoredPolicy — a stored document can never take AI down or re-enable what it does not mention", () => {
  it("falls back to the defaults field by field", () => {
    expect(parseStoredPolicy(null, catalog)).toEqual(defaultPolicy(catalog));
    expect(parseStoredPolicy("garbage", catalog)).toEqual(defaultPolicy(catalog));
    const partial = parseStoredPolicy({ primary: "gemini", providers: { anthropic: { enabled: false } } }, catalog);
    expect(partial.primary).toBe("gemini");
    expect(partial.providers.anthropic).toEqual({ enabled: false, model: "claude-opus-5-5", monthlyLimitMicroUsd: null });
    expect(partial.providers.gemini).toEqual({ enabled: true, model: "gemini-2.5-flash", monthlyLimitMicroUsd: null });
    expect(partial.fallbackEnabled).toBe(true);
  });

  it("a stored model that is no longer selectable falls back to the provider's default; a disabled provider stays disabled", () => {
    const p = parseStoredPolicy({ providers: { anthropic: { enabled: false, model: "claude-retired-1" } } }, catalog);
    expect(p.providers.anthropic).toEqual({ enabled: false, model: "claude-opus-5-5", monthlyLimitMicroUsd: null });
  });

  it("drops malformed and duplicate overrides and keeps the valid ones", () => {
    const p = parseStoredPolicy(
      { tenantOverrides: [{ companyId: 4, provider: "gemini", model: null }, { companyId: 4, provider: "anthropic", model: null }, { companyId: "x", provider: "gemini" }, { companyId: 5, provider: "nope" }, { companyId: 6, provider: "anthropic", model: "gone" }] },
      catalog,
    );
    expect(p.tenantOverrides).toEqual([{ companyId: 4, provider: "gemini", model: null }, { companyId: 6, provider: "anthropic", model: null }]);
  });

  it("round-trips a validated policy unchanged", () => {
    const original = policy({ primary: "gemini", fallbackEnabled: false, alertThresholdPct: 65, tenantOverrides: [{ companyId: 8, provider: "anthropic", model: "claude-sonnet-5-5" }] });
    original.providers.anthropic.monthlyLimitMicroUsd = 250_000_000;
    expect(parseStoredPolicy(JSON.parse(JSON.stringify(original)), catalog)).toEqual(original);
  });
});

describe("availabilityImpact — which changes must be confirmed", () => {
  const off = (p: PlatformAiPolicy, name: PolicyProvider): PlatformAiPolicy => ({ ...p, providers: { ...p.providers, [name]: { ...p.providers[name], enabled: false } } });

  it("a change that does not reduce availability needs no confirmation", () => {
    const before = policy();
    expect(availabilityImpact(before, { ...before, alertThresholdPct: 50 }, both).warnings).toEqual([]);
    expect(availabilityImpact(before, { ...before, providers: { ...before.providers, anthropic: { ...before.providers.anthropic, model: "claude-sonnet-5-5" } } }, both).warnings).toEqual([]);
    expect(availabilityImpact(before, { ...before, tenantOverrides: [{ companyId: 3, provider: "gemini", model: null }] }, both).warnings).toEqual([]);
    const limited = { ...before, providers: { ...before.providers, gemini: { ...before.providers.gemini, monthlyLimitMicroUsd: 5_000_000 } } };
    // Raising or removing a limit only widens what may be spent.
    expect(availabilityImpact(limited, before, both).warnings).toEqual([]);
    expect(availabilityImpact(limited, { ...limited, providers: { ...limited.providers, gemini: { ...limited.providers.gemini, monthlyLimitMicroUsd: 9_000_000 } } }, both).warnings).toEqual([]);
  });

  it("disabling one provider warns that it serves nothing and that nothing is left to fall back to", () => {
    const before = policy();
    const r = availabilityImpact(before, off(before, "gemini"), both);
    expect(r.disablesAllAi).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/Gemini will be disabled/);
    expect(r.warnings.join(" ")).toMatch(/Only Claude will be able to serve requests/);
  });

  it("disabling the only provider that can serve is announced as turning AI off", () => {
    const before = policy();
    const r = availabilityImpact(before, off(before, "gemini"), only("gemini"));
    expect(r.disablesAllAi).toBe(true);
    expect(r.warnings[0]).toMatch(/every AI feature stops/);
    expect(r.warnings[0]).toMatch(/Manual, QR and NFC capture keep working/);
  });

  it("disabling both is announced as turning AI off", () => {
    const before = policy();
    const r = availabilityImpact(before, off(off(before, "gemini"), "anthropic"), both);
    expect(r.disablesAllAi).toBe(true);
    expect(r.warnings[0]).toMatch(/Both providers will be disabled/);
  });

  it("where nothing could serve before (no key yet) a change is not announced as turning AI off, but a disable is still confirmed", () => {
    const before = policy();
    expect(availabilityImpact(before, { ...before, alertThresholdPct: 50 }, none).warnings).toEqual([]);
    const r = availabilityImpact(before, off(before, "anthropic"), none);
    expect(r.disablesAllAi).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/Claude will be disabled/);
  });

  it("turning automatic fallback off, switching the primary and adding or lowering a limit are confirmed", () => {
    const before = policy();
    expect(availabilityImpact(before, { ...before, fallbackEnabled: false }, both).warnings.join(" ")).toMatch(/Automatic fallback will be off/);
    expect(availabilityImpact(before, { ...before, primary: "gemini" }, both).warnings.join(" ")).toMatch(/will go to Gemini/);
    expect(availabilityImpact({ ...before, primary: "gemini" }, before, only("gemini")).warnings.join(" ")).toMatch(/Claude is set as primary but has no credentials yet: Gemini keeps serving/);
    const limited = { ...before, providers: { ...before.providers, anthropic: { ...before.providers.anthropic, monthlyLimitMicroUsd: 5_000_000 } } };
    expect(availabilityImpact(before, limited, both).warnings.join(" ")).toMatch(/Claude gets a monthly spending limit/);
    const lower = { ...limited, providers: { ...limited.providers, anthropic: { ...limited.providers.anthropic, monthlyLimitMicroUsd: 1_000_000 } } };
    expect(availabilityImpact(limited, lower, both).warnings.join(" ")).toMatch(/Claude gets a lower monthly spending limit/);
  });
});

describe("isFallbackEligible — fallback works around an outage, never around a decision", () => {
  const err = (kind: AiProviderError["kind"]) => new AiProviderError("anthropic", kind, `anthropic ${kind}`);

  it("allows the other provider for an outage, overload, rate limit, network failure, timeout, rejected credentials — or input this provider cannot take", () => {
    for (const kind of ["unavailable", "rate_limited", "network", "timeout", "auth", "unsupported_input"] as const) expect(isFallbackEligible(err(kind)), kind).toBe(true);
  });

  it("what the user is told: 'AI is unavailable' for an outage and for a stopped provider account — never for a refusal, a rejected request or unsupported input", () => {
    for (const kind of ["unavailable", "rate_limited", "network", "timeout", "auth", "quota"] as const) expect(isProviderDown(err(kind)), kind).toBe(true);
    for (const kind of ["refusal", "invalid_request", "unsupported_input", "invalid_response"] as const) expect(isProviderDown(err(kind)), kind).toBe(false);
    expect(isProviderDown(new AppError(503, "platform limit reached — unavailable", { code: "AI_PLATFORM_LIMIT_REACHED" }))).toBe(false);
    // A stopped account is announced as unavailable, yet never rerouted.
    expect(isFallbackEligible(err("quota"))).toBe(false);
  });

  it("is final for a refusal, a provider-side spend cap, a rejected request and an unusable answer", () => {
    for (const kind of ["refusal", "quota", "invalid_request", "invalid_response"] as const) expect(isFallbackEligible(err(kind)), kind).toBe(false);
  });

  it("is final for every rejection of this application, whatever its text says", () => {
    const decisions = [
      new AppError(429, "Monthly AI token budget exceeded", { code: "AI_BUDGET_EXCEEDED" }),
      new AppError(403, "AI features are disabled", { code: "AI_DISABLED" }),
      new AppError(403, "This AI feature is disabled", { code: "AI_FEATURE_DISABLED" }),
      new AppError(429, "Too many AI requests", { code: "AI_RATE_LIMITED" }),
      new AppError(503, "platform limit reached — service unavailable 503", { code: "AI_PLATFORM_LIMIT_REACHED" }),
      new AppError(503, "AI is not available right now", { code: "AI_MODEL_UNPRICED" }),
      new AppError(403, "Forbidden"),
      new AppError(402, "Subscription required — network timeout 503"),
    ];
    for (const e of decisions) expect(isFallbackEligible(e), e.message).toBe(false);
  });

  it("classifies an untyped provider error from its message, as before", () => {
    expect(categorizeError(new Error("got status: 503 UNAVAILABLE. The model is overloaded"))).toBe("provider_unavailable");
    expect(categorizeError(new Error("429 RESOURCE_EXHAUSTED"))).toBe("provider_rate_limited");
    expect(categorizeError(new Error("API key not valid. Please pass a valid API key."))).toBe("provider_auth");
    expect(categorizeError(new Error("fetch failed"))).toBe("network");
    expect(categorizeError(new Error("gemini gemini-2.5-flash timed out after 30000ms"))).toBe("timeout");
    expect(categorizeError(new Error("Unexpected token < in JSON"))).toBe("invalid_response");
    expect(categorizeError(new Error("stub provider simulated failure"))).toBe("other");
    expect(isFallbackEligible(new Error("stub provider simulated failure"))).toBe(false);
    expect(isFallbackEligible(new Error("Unexpected token < in JSON"))).toBe(false);
  });
});

describe("the runner's own retries never repeat a failure that repeating cannot change", () => {
  const REQ: AiRequest = { model: "m", parts: [{ text: "x" }], timeoutMs: 1000 };
  function failing(error: () => unknown) {
    let calls = 0;
    const provider: AiProvider = {
      name: "anthropic",
      isConfigured: () => true,
      generate: async () => {
        calls += 1;
        throw error();
      },
    };
    return { provider, calls: () => calls };
  }

  it("a refusal, a rejected or unsupported request, rejected credentials and a provider spend stop are sent ONCE even when retries are configured", async () => {
    for (const kind of ["refusal", "invalid_request", "unsupported_input", "auth", "quota"] as const) {
      const f = failing(() => new AiProviderError("anthropic", kind, kind));
      expect(isRetryable(new AiProviderError("anthropic", kind, kind)), kind).toBe(false);
      await expect(runAi(f.provider, REQ, { retries: 3, backoffMs: 0 })).rejects.toBeInstanceOf(AiProviderError);
      expect(f.calls(), kind).toBe(1);
    }
  });

  it("a transient failure is still retried as configured, and an untyped error as before", async () => {
    for (const kind of ["unavailable", "rate_limited", "network", "timeout"] as const) {
      const f = failing(() => new AiProviderError("anthropic", kind, kind));
      await expect(runAi(f.provider, REQ, { retries: 2, backoffMs: 0 })).rejects.toBeInstanceOf(AiProviderError);
      expect(f.calls(), kind).toBe(3);
    }
    const untyped = failing(() => new Error("stub provider transient failure"));
    await expect(runAi(untyped.provider, REQ, { retries: 1, backoffMs: 0 })).rejects.toThrow();
    expect(untyped.calls()).toBe(2);
    const single = failing(() => new AiProviderError("anthropic", "unavailable", "down"));
    await expect(runAi(single.provider, REQ)).rejects.toBeInstanceOf(AiProviderError);
    expect(single.calls()).toBe(1); // the default: one attempt
  });
});

describe("the fallback attempt gets what is left of the shared time budget", () => {
  it("a primary that used its whole timeout leaves the fallback the rest, so both end before the reverse proxy gives up", () => {
    // Card extraction: 30 s timeout, 50 s budget. The primary hung for 30 s → the fallback gets 20 s.
    expect(fallbackTimeoutMs(30_000, 30_000, 50_000)).toBe(20_000);
    expect(30_000 + fallbackTimeoutMs(30_000, 30_000, 50_000)).toBeLessThan(60_000);
  });

  it("a primary that failed fast leaves the fallback its full timeout, and it is never given more than that", () => {
    expect(fallbackTimeoutMs(30_000, 400, 50_000)).toBe(30_000);
    expect(fallbackTimeoutMs(20_000, 0, 50_000)).toBe(20_000);
  });

  it("never drops below the floor, even when the budget is already spent", () => {
    expect(fallbackTimeoutMs(30_000, 49_000, 50_000)).toBe(5_000);
    expect(fallbackTimeoutMs(30_000, 80_000, 50_000)).toBe(5_000);
    expect(fallbackTimeoutMs(3_000, 80_000, 50_000)).toBe(3_000); // …and never above the request's own timeout
  });
});

describe("pricing — Claude and Gemini models, from the official price pages", () => {
  // micro-USD per 1,000 tokens: $4 / MTok = 4,000.
  it("prices every selectable model, so none can run unbudgeted", () => {
    for (const p of ["anthropic", "gemini"] as const) for (const m of config.ai.models[p]) expect(hasPricing(m), m).toBe(true);
  });

  it("Opus 5.5 is $4 in / $20 out and Sonnet 5.5 $2 in / $10 out per million tokens", () => {
    expect(estimateCostMicroUsd("claude-opus-5-5", 1_000_000, 1_000_000)).toBe(24_000_000);
    expect(estimateCostMicroUsd("claude-sonnet-5-5", 1_000_000, 1_000_000)).toBe(12_000_000);
    expect(estimateCostMicroUsd("claude-opus-5-5", 1_500, 300)).toBe(6_000 + 6_000);
  });

  it("Haiku 5.5 is $0.10 / $0.50 up to 100,000 input tokens and $0.50 / $2.50 for the whole request above that", () => {
    expect(estimateCostMicroUsd("claude-haiku-5-5", 100_000, 10_000)).toBe(10_000 + 5_000);
    expect(estimateCostMicroUsd("claude-haiku-5-5", 100_001, 10_000)).toBe(Math.round((100_001 / 1000) * 500 + (10_000 / 1000) * 2_500));
    expect(estimateCostMicroUsd("claude-haiku-5-5", 200_000, 10_000)).toBe(100_000 + 25_000);
  });

  it("a reservation is costed at the dearest tier, so it can never under-reserve", () => {
    expect(ceilingCostMicroUsd("claude-haiku-5-5", 1_000, 1_000)).toBe(500 + 2_500);
    expect(ceilingCostMicroUsd("claude-haiku-5-5", 1_000, 1_000)).toBeGreaterThan(estimateCostMicroUsd("claude-haiku-5-5", 1_000, 1_000));
    expect(ceilingCostMicroUsd("claude-opus-5-5", 1_000, 1_000)).toBe(estimateCostMicroUsd("claude-opus-5-5", 1_000, 1_000));
  });

  it("Gemini 2.5 Flash keeps its price, and an unknown model has none (cost 0 — which is why it is refused under a cost budget)", () => {
    expect(estimateCostMicroUsd("gemini-2.5-flash", 1_000_000, 1_000_000)).toBe(2_800_000);
    expect(hasPricing("claude-unlisted-model")).toBe(false);
    expect(hasPricing("some-unknown-model")).toBe(false);
    expect(estimateCostMicroUsd("some-unknown-model", 1_000_000, 1_000_000)).toBe(0);
  });
});
