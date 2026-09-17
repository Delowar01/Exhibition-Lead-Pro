import { AppError } from "../middlewares/errorHandler.js";
import { logger } from "../lib/logger.js";
import type { AiFeature, AiProvider } from "./types.js";

// B22 Correction 1 — provider readiness gate.
//
// A provider without credentials is a DEPLOYMENT-CONFIGURATION state, not a model,
// network or image failure. Before this gate an unconfigured Gemini surfaced from
// deep inside the adapter as a generic provider error, which the scan pipeline
// truthfully-but-misleadingly reported as 502 "Could not read the card. Please
// retake the photo." — a user would keep retaking photos for a missing key.
//
// The gate runs in the single execution seam (lib/ai.ts callJsonWithMeta) right
// after provider/model resolution and BEFORE dedup, budget reservation and any
// provider work, so:
//   • nothing is reserved and nothing is called — no ledger row is written, exactly
//     like the AI_DISABLED / AI_FEATURE_DISABLED policy gate;
//   • the client receives a stable, provider-agnostic 503 `AI_NOT_CONFIGURED`
//     (never a provider name, env variable or key detail);
//   • the operator gets a WARN with safe metadata only (provider name, feature).
// `isConfigured()` is a cheap credential-presence check that never makes a paid
// call (see AiProvider); an adapter that throws here is treated as unconfigured.
export const AI_NOT_CONFIGURED_CODE = "AI_NOT_CONFIGURED";
export const AI_NOT_CONFIGURED_MESSAGE =
  "AI features are not configured for this environment. Please contact your administrator.";

export function assertProviderConfigured(
  provider: Pick<AiProvider, "name" | "isConfigured">,
  feature: AiFeature,
): void {
  let configured = false;
  try {
    configured = provider.isConfigured();
  } catch {
    configured = false;
  }
  if (configured) return;
  logger.warn({ provider: provider.name, feature }, "AI request refused: provider is not configured (no credential present)");
  throw new AppError(503, AI_NOT_CONFIGURED_MESSAGE, { code: AI_NOT_CONFIGURED_CODE });
}
