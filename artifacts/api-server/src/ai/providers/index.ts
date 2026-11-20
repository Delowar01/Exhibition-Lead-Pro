import type { AiProvider } from "../types.js";
import { geminiProvider } from "./gemini.js";
import { anthropicProvider } from "./anthropic.js";
import { stubProvider, simulatedProvider, isSimulatedModel } from "./stub.js";
import { config } from "../../config.js";

// Provider registry. Two real providers — Anthropic (Claude) and Google (Gemini) — are
// always registered; which of them serves a request is decided by the Platform Owner's
// AI provider policy (src/ai/policy.ts), never here. Adding a provider is a registration
// here plus an adapter implementing AiProvider.
//
// Batch 6: a deterministic "stub" provider is registered OUTSIDE production only, so
// automated tests can exercise usage accounting / budgets / rate limits / dedup
// without live provider calls (a tenant opts in via PATCH /ai/settings).
const PROVIDERS: Record<string, AiProvider> = {
  gemini: geminiProvider,
  anthropic: anthropicProvider,
  ...(config.ai.enableStubProvider ? { stub: stubProvider } : {}),
};

/** The providers a Platform Owner manages. */
export const REAL_PROVIDERS = ["anthropic", "gemini"] as const;
export type RealProvider = (typeof REAL_PROVIDERS)[number];

export function isRealProvider(name: unknown): name is RealProvider {
  return name === "anthropic" || name === "gemini";
}

export function getProvider(name: string): AiProvider {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(
      `AI provider "${name}" is not available. Active providers: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  return provider;
}

// The adapter that will actually run `model` for `name`. Outside production a stub
// model on a real provider is served by the deterministic engine under that provider's
// name (no network, no key); everywhere else it is the registered adapter.
export function providerFor(name: string, model: string): AiProvider {
  if (name !== "stub" && isSimulatedModel(model)) return simulatedProvider(name);
  return getProvider(name);
}

export function availableProviders(): string[] {
  return Object.keys(PROVIDERS);
}

export function stubRegistered(): boolean {
  return "stub" in PROVIDERS;
}
