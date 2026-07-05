import { config } from "../config.js";

// Cost ESTIMATION for the ai_invocations ledger. Prices live in config.ai.pricing
// (micro-USD per 1,000 tokens) and are estimates for visibility, not billing. An
// unknown model resolves to 0 (reported as "estimate unavailable" by the UI).
export function estimateCostMicroUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = config.ai.pricing[model];
  if (!price) return 0;
  const cost =
    (inputTokens / 1000) * price.inputPer1kMicroUsd + (outputTokens / 1000) * price.outputPer1kMicroUsd;
  return Math.max(0, Math.round(cost));
}

// True when we have a published price for the model (so a non-null cost estimate).
export function hasPricing(model: string): boolean {
  return Boolean(config.ai.pricing[model]);
}
