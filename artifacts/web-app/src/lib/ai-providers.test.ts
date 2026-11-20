import { describe, expect, it } from "vitest";
import { ApiError, type PlatformAiProviders, type PlatformAiProviderStatus } from "@workspace/api-client-react";
import {
  MAX_LIMIT_MICRO_USD,
  credentialSummary,
  describeSaveFailure,
  draftFromStatus,
  draftToPolicy,
  isDirty,
  limitSummary,
  limitToText,
  modelPriceLabel,
  parseAlertThreshold,
  parseLimit,
  providerLabel,
  providerRole,
  serverDate,
  servingSummary,
} from "./ai-providers";

// Platform Owner → Settings → AI Providers: what the page works out on its own. The
// figures and decisions come from the API; these tests cover the exact conversion of what
// is typed, the "has anything changed" rule, and the wording of every state.

function provider(over: Partial<PlatformAiProviderStatus> & { provider: "anthropic" | "gemini" }): PlatformAiProviderStatus {
  const claude = over.provider === "anthropic";
  return {
    label: claude ? "Claude" : "Gemini",
    enabled: true,
    model: claude ? "claude-opus-5-5" : "gemini-2.5-flash",
    credentials: { configured: false, state: "missing", checkedAt: null, envVar: claude ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY" },
    models: claude
      ? [
          { id: "claude-opus-5-5", simulated: false, priced: true, inputMicroUsdPerMTok: 4_000_000, outputMicroUsdPerMTok: 20_000_000, longContext: null },
          { id: "claude-haiku-5-5", simulated: false, priced: true, inputMicroUsdPerMTok: 100_000, outputMicroUsdPerMTok: 500_000, longContext: { aboveInputTokens: 100_000, inputMicroUsdPerMTok: 500_000, outputMicroUsdPerMTok: 2_500_000 } },
          { id: "stub-model", simulated: true, priced: true, inputMicroUsdPerMTok: 300_000, outputMicroUsdPerMTok: 2_500_000, longContext: null },
        ]
      : [{ id: "gemini-2.5-flash", simulated: false, priced: true, inputMicroUsdPerMTok: 300_000, outputMicroUsdPerMTok: 2_500_000, longContext: null }],
    month: { providerCalls: 0, succeeded: 0, failed: 0, servedAsFallback: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0, byModel: [] },
    limit: { monthlyLimitMicroUsd: null, usedPct: null, state: "none" },
    ...over,
  };
}

function status(over: Partial<PlatformAiProviders> = {}): PlatformAiProviders {
  return {
    policy: {
      primary: "anthropic",
      fallbackEnabled: true,
      alertThresholdPct: 80,
      providers: {
        anthropic: { enabled: true, model: "claude-opus-5-5", monthlyLimitMicroUsd: null },
        gemini: { enabled: true, model: "gemini-2.5-flash", monthlyLimitMicroUsd: null },
      },
      tenantOverrides: [],
    },
    version: 3,
    persisted: true,
    storage: "ok",
    updatedAt: "2026-11-20T10:00:00.000Z",
    updatedByName: "Platform Owner",
    simulationAvailable: false,
    providers: [provider({ provider: "anthropic" }), provider({ provider: "gemini" })],
    effective: { provider: "anthropic", model: "claude-opus-5-5", fallbackProvider: "gemini", fallbackModel: "gemini-2.5-flash", unavailable: null, notes: [] },
    period: { from: "2026-11-01T00:00:00.000Z", resetAt: "2026-12-01T00:00:00.000Z" },
    pricingVersion: "v2-2026-11-claude-gemini",
    ...over,
  };
}

describe("a monthly spending limit is converted exactly", () => {
  it("empty means no limit", () => {
    expect(parseLimit("")).toEqual({ ok: true, value: null });
    expect(parseLimit("   ")).toEqual({ ok: true, value: null });
  });

  it("dollars become millionths of a dollar on their digits — never through a floating-point number", () => {
    const cases: Array<[string, number]> = [
      ["250", 250_000_000],
      ["250.50", 250_500_000],
      ["0.1", 100_000],
      ["0.000001", 1],
      ["19.99", 19_990_000],
      ["1000000", MAX_LIMIT_MICRO_USD],
      ["0", 0],
      [".5", 500_000],
    ];
    for (const [text, micro] of cases) expect(parseLimit(text), text).toEqual({ ok: true, value: micro });
  });

  it("refuses what cannot be converted exactly instead of rounding or guessing", () => {
    for (const text of ["abc", "-5", "1e3", "1,000", "$50", "12.5.1", "5 0", "0.0000001", "1000000.000001", "1000001"]) {
      expect(parseLimit(text).ok, text).toBe(false);
    }
    expect(parseLimit("1000001")).toEqual({ ok: false, message: "The limit cannot be more than $1,000,000." });
    expect(parseLimit("0.0000001")).toEqual({ ok: false, message: "Use at most six decimals." });
  });

  it("a stored limit comes back as the text that produces it", () => {
    for (const micro of [0, 1, 100_000, 19_990_000, 250_000_000, 250_500_000, MAX_LIMIT_MICRO_USD]) {
      const text = limitToText(micro);
      expect(parseLimit(text), String(micro)).toEqual({ ok: true, value: micro });
    }
    expect(limitToText(null)).toBe("");
    expect(limitToText(250_000_000)).toBe("250");
    expect(limitToText(250_500_000)).toBe("250.5");
  });
});

describe("the alert threshold", () => {
  it("is a whole number from 1 to 100", () => {
    expect(parseAlertThreshold("80")).toEqual({ ok: true, value: 80 });
    expect(parseAlertThreshold(" 1 ")).toEqual({ ok: true, value: 1 });
    expect(parseAlertThreshold("100")).toEqual({ ok: true, value: 100 });
    for (const text of ["", "0", "101", "80.5", "-1", "abc", "8e1", "1000"]) expect(parseAlertThreshold(text).ok, text).toBe(false);
  });
});

describe("the form and the policy document", () => {
  it("a form filled from the server produces the same policy, and counts as unchanged", () => {
    const s = status({
      policy: {
        primary: "gemini",
        fallbackEnabled: false,
        alertThresholdPct: 65,
        providers: {
          anthropic: { enabled: false, model: "claude-haiku-5-5", monthlyLimitMicroUsd: 250_500_000 },
          gemini: { enabled: true, model: "gemini-2.5-flash", monthlyLimitMicroUsd: null },
        },
        tenantOverrides: [{ companyId: 7, companyName: "Acme", provider: "anthropic", model: null }],
      },
    });
    const draft = draftFromStatus(s);
    expect(draft.providers.anthropic.limitText).toBe("250.5");
    const next = draftToPolicy(draft);
    expect(next).toEqual({
      ok: true,
      policy: {
        primary: "gemini",
        fallbackEnabled: false,
        alertThresholdPct: 65,
        providers: {
          anthropic: { enabled: false, model: "claude-haiku-5-5", monthlyLimitMicroUsd: 250_500_000 },
          gemini: { enabled: true, model: "gemini-2.5-flash", monthlyLimitMicroUsd: null },
        },
        // The company's name is for reading; only its id, provider and model are sent.
        tenantOverrides: [{ companyId: 7, provider: "anthropic", model: null }],
      },
    });
    expect(isDirty(draft, s)).toBe(false);
  });

  it("the document never carries anything but the policy — no key field exists to send", () => {
    const next = draftToPolicy(draftFromStatus(status()));
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(Object.keys(next.policy).sort()).toEqual(["alertThresholdPct", "fallbackEnabled", "primary", "providers", "tenantOverrides"]);
      expect(Object.keys(next.policy.providers.anthropic).sort()).toEqual(["enabled", "model", "monthlyLimitMicroUsd"]);
    }
  });

  it("every kind of edit is a change; typing the same value in another spelling is not", () => {
    const s = status();
    const base = draftFromStatus(s);
    expect(isDirty({ ...base, primary: "gemini" }, s)).toBe(true);
    expect(isDirty({ ...base, fallbackEnabled: false }, s)).toBe(true);
    expect(isDirty({ ...base, alertText: "81" }, s)).toBe(true);
    expect(isDirty({ ...base, providers: { ...base.providers, gemini: { ...base.providers.gemini, enabled: false } } }, s)).toBe(true);
    expect(isDirty({ ...base, providers: { ...base.providers, anthropic: { ...base.providers.anthropic, model: "claude-haiku-5-5" } } }, s)).toBe(true);
    expect(isDirty({ ...base, providers: { ...base.providers, anthropic: { ...base.providers.anthropic, limitText: "10" } } }, s)).toBe(true);
    expect(isDirty({ ...base, overrides: [{ companyId: 3, companyName: "X", provider: "gemini", model: null }] }, s)).toBe(true);
    // "080" is 80 and " " is no limit: nothing to save.
    expect(isDirty({ ...base, alertText: " 80 " }, s)).toBe(false);
    expect(isDirty({ ...base, providers: { ...base.providers, anthropic: { ...base.providers.anthropic, limitText: "  " } } }, s)).toBe(false);
    const limited = status({ policy: { ...s.policy, providers: { ...s.policy.providers, gemini: { ...s.policy.providers.gemini, monthlyLimitMicroUsd: 5_000_000 } } } });
    const d = draftFromStatus(limited);
    expect(isDirty({ ...d, providers: { ...d.providers, gemini: { ...d.providers.gemini, limitText: "5.00" } } }, limited)).toBe(false);
  });

  it("a mistyped limit or threshold is reported per field, nothing is sent, and the form still counts as changed", () => {
    const s = status();
    const base = draftFromStatus(s);
    const draft = { ...base, alertText: "0", providers: { ...base.providers, anthropic: { ...base.providers.anthropic, limitText: "12,50" } } };
    const next = draftToPolicy(draft);
    expect(next.ok).toBe(false);
    if (!next.ok) {
      expect(next.errors.limit.anthropic).toMatch(/US dollars/);
      expect(next.errors.limit.gemini).toBeUndefined();
      expect(next.errors.alert).toMatch(/1 to 100/);
    }
    expect(isDirty(draft, s)).toBe(true);
  });
});

describe("what the page says", () => {
  it("names each provider by its product, and the test provider as such", () => {
    expect([providerLabel("anthropic"), providerLabel("gemini"), providerLabel("stub"), providerLabel(null)]).toEqual(["Claude", "Gemini", "Test provider", "—"]);
  });

  it("describes a key by presence and by what the provider said — and tells the owner where a key goes, never asks for one", () => {
    const missing = credentialSummary(provider({ provider: "anthropic" }));
    expect(missing.tone).toBe("warning");
    expect(missing.label).toBe("No key on the server");
    expect(missing.detail).toMatch(/ANTHROPIC_API_KEY is set in the server environment/);
    expect(missing.detail).toMatch(/Keys are never entered here/);

    const present = credentialSummary(provider({ provider: "gemini", credentials: { configured: true, state: "present_unverified", checkedAt: null, envVar: "GEMINI_API_KEY" } }));
    expect([present.tone, present.label]).toEqual(["info", "Key present"]);
    expect(present.detail).toMatch(/no test call is made from this page/);

    const verified = credentialSummary(provider({ provider: "anthropic", credentials: { configured: true, state: "verified", checkedAt: "2026-11-20T09:00:00.000Z", envVar: "ANTHROPIC_API_KEY" } }));
    expect([verified.tone, verified.label]).toEqual(["success", "Key verified"]);

    const rejected = credentialSummary(provider({ provider: "anthropic", credentials: { configured: true, state: "rejected", checkedAt: "2026-11-20T09:00:00.000Z", envVar: "ANTHROPIC_API_KEY" } }));
    expect([rejected.tone, rejected.label]).toEqual(["destructive", "Key rejected"]);
    expect(rejected.detail).toMatch(/Replace ANTHROPIC_API_KEY on the server/);

    // Outside production a provider may run on a test model: the panel says so instead of "no key".
    const test = credentialSummary(provider({ provider: "anthropic", model: "stub-model" }));
    expect([test.tone, test.label]).toEqual(["info", "Test model — no key used"]);
    expect(test.detail).toMatch(/no provider is called/);
    expect(test.detail).toMatch(/do not exist in production/);
    // With a real model selected, a missing key is still reported as missing.
    expect(credentialSummary(provider({ provider: "anthropic", model: "claude-opus-5-5" })).label).toBe("No key on the server");

    // A billing problem or an account spend cap at the provider is not a healthy key.
    const stopped = credentialSummary(provider({ provider: "anthropic", credentials: { configured: true, state: "account_stopped", checkedAt: "2026-11-20T09:00:00.000Z", envVar: "ANTHROPIC_API_KEY" } }));
    expect([stopped.tone, stopped.label]).toEqual(["destructive", "Account stopped by provider"]);
    expect(stopped.detail).toMatch(/billing problem or that its account spend limit is reached/);
    expect(stopped.detail).toMatch(/not moved to the other provider/);
  });

  it("shows a date the server names as that same date, wherever the page is opened", () => {
    // The first of the month at the server (UTC) is not "the 31st" for a viewer west of it.
    expect(serverDate("2026-11-01T00:00:00.000Z")).toBe("Nov 1, 2026");
    expect(serverDate("2026-12-01T00:00:00.000Z")).toBe("Dec 1, 2026");
    expect(serverDate("not a date")).toBe("—");
  });

  it("prints a model's price per million tokens, with the dearer tier where it has one", () => {
    const models = provider({ provider: "anthropic" }).models;
    expect(modelPriceLabel(models[0])).toBe("$4.00 in · $20.00 out per 1M tokens");
    expect(modelPriceLabel(models[1])).toBe("$0.10 in · $0.50 out per 1M tokens; $0.50 in · $2.50 out when a request's input exceeds 100,000 tokens");
    expect(modelPriceLabel(models[2])).toBe("Test model — no provider is called");
    expect(modelPriceLabel({ id: "x", simulated: false, priced: false, inputMicroUsdPerMTok: null, outputMicroUsdPerMTok: null, longContext: null })).toBe("No price configured");
    expect(modelPriceLabel(undefined)).toBe("");
  });

  it("summarises spending against a limit with exact amounts", () => {
    const at = (state: "ok" | "approaching" | "reached", cost: number, usedPct: number) =>
      limitSummary(provider({ provider: "anthropic", month: { ...provider({ provider: "anthropic" }).month, costMicroUsd: cost }, limit: { monthlyLimitMicroUsd: 100_000_000, usedPct, state } }));
    expect(limitSummary(provider({ provider: "anthropic" }))).toBeNull();
    expect(at("ok", 12_500_000, 12)).toEqual({ tone: "success", label: "12% used — $12.50 of $100.00" });
    expect(at("approaching", 85_000_000, 85)).toEqual({ tone: "warning", label: "85% used — $85.00 of $100.00" });
    expect(at("reached", 100_000_125, 100)).toEqual({ tone: "destructive", label: "Limit reached — $100.000125 of $100.00" });
  });

  it("says in one sentence what serves requests — including when nothing can", () => {
    expect(servingSummary(status())).toEqual({
      tone: "success",
      title: "Claude serves AI requests",
      detail: "Claude (claude-opus-5-5) serves requests; Gemini (gemini-2.5-flash) is tried once when it cannot.",
    });
    const single = servingSummary(status({ effective: { provider: "gemini", model: "gemini-2.5-flash", fallbackProvider: null, fallbackModel: null, unavailable: null, notes: [] } }));
    expect(single.detail).toBe("Gemini (gemini-2.5-flash) serves requests. No fallback is in place.");
    const noKey = servingSummary(status({ effective: { provider: null, model: null, fallbackProvider: null, fallbackModel: null, unavailable: "none_configured", notes: [] } }));
    expect([noKey.tone, noKey.title]).toEqual(["warning", "AI is not available yet"]);
    expect(noKey.detail).toMatch(/Manual, QR and NFC capture keep working/);
    const off = servingSummary(status({ effective: { provider: null, model: null, fallbackProvider: null, fallbackModel: null, unavailable: "none_enabled", notes: [] } }));
    expect([off.tone, off.title]).toEqual(["destructive", "AI is off"]);
    expect(off.detail).toMatch(/Manual, QR and NFC capture keep working/);
  });

  it("gives each provider its role as the saved policy applies now", () => {
    const s = status();
    expect(providerRole(s, "anthropic")).toEqual({ tone: "primary", label: "Serving requests" });
    expect(providerRole(s, "gemini")).toEqual({ tone: "info", label: "Fallback" });
    // Claude is the primary but only Gemini has a key: Gemini serves, and Claude says why it is not.
    const geminiOnly = status({ effective: { provider: "gemini", model: "gemini-2.5-flash", fallbackProvider: null, fallbackModel: null, unavailable: null, notes: [] } });
    expect(providerRole(geminiOnly, "gemini")).toEqual({ tone: "primary", label: "Serving requests" });
    expect(providerRole(geminiOnly, "anthropic")).toEqual({ tone: "neutral", label: "Primary — not serving" });
    const disabled = status({ providers: [provider({ provider: "anthropic", enabled: false }), provider({ provider: "gemini" })] });
    expect(providerRole(disabled, "anthropic")).toEqual({ tone: "neutral", label: "Disabled" });
  });
});

describe("a refused save", () => {
  const refused = (statusCode: number, data: unknown) => new ApiError(new Response(null, { status: statusCode, statusText: "x" }), data, { method: "PUT", url: "/api/platform/ai/providers" });

  it("a confirmation request carries the server's own reasons", () => {
    const f = describeSaveFailure(refused(409, { error: "This change affects AI availability and must be confirmed.", code: "AI_POLICY_CONFIRMATION_REQUIRED", context: { warnings: ["Gemini will be disabled: …", 7, "Only Claude will be able to serve requests: …"], disablesAllAi: false } }));
    expect(f).toEqual({ kind: "confirm", warnings: ["Gemini will be disabled: …", "Only Claude will be able to serve requests: …"], disablesAllAi: false });
    const all = describeSaveFailure(refused(409, { error: "Confirm", code: "AI_POLICY_CONFIRMATION_REQUIRED", context: { warnings: ["Both providers will be disabled"], disablesAllAi: true } }));
    expect(all).toMatchObject({ kind: "confirm", disablesAllAi: true });
    // Without reasons the server's message is shown rather than an empty dialog.
    expect(describeSaveFailure(refused(409, { error: "Confirm this", code: "AI_POLICY_CONFIRMATION_REQUIRED" }))).toEqual({ kind: "confirm", warnings: ["Confirm this"], disablesAllAi: false });
  });

  it("tells a version conflict, missing storage, an invalid policy and anything else apart", () => {
    expect(describeSaveFailure(refused(409, { error: "Changed by someone else", code: "AI_POLICY_VERSION_CONFLICT" })).kind).toBe("conflict");
    expect(describeSaveFailure(refused(503, { error: "Cannot be saved yet", code: "AI_POLICY_STORAGE_UNAVAILABLE" })).kind).toBe("storage");
    expect(describeSaveFailure(refused(400, { error: "The Claude model must be one of: …", code: "AI_POLICY_INVALID" }))).toEqual({ kind: "invalid", message: "The Claude model must be one of: …" });
    expect(describeSaveFailure(refused(500, { error: "Internal server error" })).kind).toBe("other");
    expect(describeSaveFailure(new TypeError("Failed to fetch"))).toEqual({ kind: "other", message: "Failed to fetch" });
    expect(describeSaveFailure("nope")).toEqual({ kind: "other", message: "The settings could not be saved." });
  });
});
