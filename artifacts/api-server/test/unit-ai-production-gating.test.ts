// Platform AI provider management — the deterministic test engine does not exist in
// production. Outside production a provider may be given a "stub-…" model, which the
// engine serves under that provider's name; this file loads the AI layer the way a
// production server does (the test engine disabled) and asserts that none of it is
// reachable: no test provider, no test model in any catalog, a stored test model ignored,
// and a "stub-…" model name on a real provider going to the REAL adapter — which has no
// key here and therefore refuses, without any request.
import { describe, it, expect, vi } from "vitest";

// The real configuration with ONE value changed. (A view, not a copy: the configuration
// has lazy getters that must not be evaluated here.)
vi.mock("../src/config.js", async (original) => {
  const actual = await original<typeof import("../src/config.js")>();
  const ai = new Proxy(actual.config.ai, { get: (target, key, receiver) => (key === "enableStubProvider" ? false : Reflect.get(target, key, receiver)) });
  const config = new Proxy(actual.config, { get: (target, key, receiver) => (key === "ai" ? ai : Reflect.get(target, key, receiver)) });
  return { ...actual, config };
});

import { availableProviders, getProvider, providerFor, stubRegistered } from "../src/ai/providers/index.js";
import { isSimulatedModel } from "../src/ai/providers/stub.js";
import { anthropicProvider } from "../src/ai/providers/anthropic.js";
import { geminiProvider } from "../src/ai/providers/gemini.js";
import { parseStoredPolicy, resolveChain, validatePolicy, defaultPolicy } from "../src/ai/policy.js";
import { catalog } from "../src/services/platform-ai.service.js";
import { config } from "../src/config.js";

describe("with the test engine disabled (as in production)", () => {
  it("the test provider is not registered", () => {
    expect(config.ai.enableStubProvider).toBe(false);
    expect(stubRegistered()).toBe(false);
    expect(availableProviders().sort()).toEqual(["anthropic", "gemini"]);
    expect(() => getProvider("stub")).toThrow(/not available/);
  });

  it("no model name is ever served by the test engine: a 'stub-…' model on a real provider goes to the real adapter", () => {
    for (const model of ["stub-model", "stub-unavailable", "stub-refusal", "stub-null"]) {
      expect(isSimulatedModel(model), model).toBe(false);
      expect(providerFor("anthropic", model)).toBe(anthropicProvider);
      expect(providerFor("gemini", model)).toBe(geminiProvider);
    }
    // …and the real adapters have no key in this environment, so nothing could be served.
    expect(anthropicProvider.isConfigured()).toBe(false);
    expect(geminiProvider.isConfigured()).toBe(false);
  });

  it("the selectable models are the documented ones only", () => {
    expect(catalog.modelsFor("anthropic")).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(catalog.modelsFor("gemini")).toEqual(["gemini-2.5-flash"]);
  });

  it("a policy naming a test model is refused, and a STORED one falls back to the provider's default model", () => {
    const withStub = { ...defaultPolicy(catalog), providers: { ...defaultPolicy(catalog).providers, anthropic: { enabled: true, model: "stub-model", monthlyLimitMicroUsd: null } } };
    const checked = validatePolicy(JSON.parse(JSON.stringify(withStub)), catalog);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues.map((i) => i.code)).toContain("POLICY_MODEL_NOT_SUPPORTED");
    // e.g. a database copied from a development environment.
    const parsed = parseStoredPolicy(JSON.parse(JSON.stringify(withStub)), catalog);
    expect(parsed.providers.anthropic.model).toBe("claude-opus-5-5");
  });

  it("a tenant whose stored provider is the test provider is served by the platform policy", () => {
    const chain = resolveChain(defaultPolicy(catalog), {
      tenant: { provider: "stub", model: "stub-model" },
      companyId: 1,
      stubAvailable: stubRegistered(),
      usable: () => true,
      legacyDefault: "gemini",
    });
    expect(chain.source).toBe("platform");
    expect(chain.candidates.map((c) => `${c.provider}:${c.model}`)).toEqual(["anthropic:claude-opus-5-5", "gemini:gemini-2.5-flash"]);
  });
});
