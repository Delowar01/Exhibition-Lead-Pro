import type { AiProvider } from "../types.js";
import { geminiProvider } from "./gemini.js";

// Provider registry. Gemini is the only active provider in Stage 5.0 — multi-provider
// switching is intentionally out of scope for the foundation. Adding a provider is a
// one-line registration here plus an adapter implementing AiProvider.
const PROVIDERS: Record<string, AiProvider> = {
  gemini: geminiProvider,
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
