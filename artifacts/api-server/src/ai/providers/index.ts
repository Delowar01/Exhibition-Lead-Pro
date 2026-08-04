import type { AiProvider } from "../types.js";
import { geminiProvider } from "./gemini.js";
import { stubProvider } from "./stub.js";
import { config } from "../../config.js";

// Provider registry. Gemini is the only active provider in Stage 5.0 — multi-provider
// switching is intentionally out of scope for the foundation. Adding a provider is a
// one-line registration here plus an adapter implementing AiProvider.
//
// Batch 6: a deterministic "stub" provider is registered OUTSIDE production only, so
// automated tests can exercise usage accounting / budgets / rate limits / dedup
// without live Gemini calls (a tenant opts in via PATCH /ai/settings).
const PROVIDERS: Record<string, AiProvider> = {
  gemini: geminiProvider,
  ...(config.ai.enableStubProvider ? { stub: stubProvider } : {}),
};

export function getProvider(name: string): AiProvider {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(
      `AI provider "${name}" is not available. Active providers: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  return provider;
}

export function availableProviders(): string[] {
  return Object.keys(PROVIDERS);
}
