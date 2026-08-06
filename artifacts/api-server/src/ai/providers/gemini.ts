import { ai, isGeminiConfigured } from "@workspace/integrations-gemini-ai";
import type { AiProvider, AiRequest, AiResult, AiUsage } from "../types.js";
import { withTimeout } from "../runner.js";

// Gemini adapter — wraps @workspace/integrations-gemini-ai (Google GenAI SDK routed
// through the Replit AI integration proxy). This is the sole active provider in Stage
// 5.0; it maps the provider-agnostic AiRequest onto the Gemini `generateContent` shape
// and normalizes token usage back out.

interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

function readUsage(meta: UsageMetadata | undefined): AiUsage {
  const inputTokens = meta?.promptTokenCount ?? 0;
  const outputTokens = meta?.candidatesTokenCount ?? 0;
  const totalTokens = meta?.totalTokenCount ?? inputTokens + outputTokens;
  // Actual provider metadata is used whenever present; when Gemini returns none at
  // all, flag the row so the ledger can mark usage as estimated (Batch 6).
  const missingMetadata =
    meta?.promptTokenCount == null && meta?.candidatesTokenCount == null && meta?.totalTokenCount == null;
  return { inputTokens, outputTokens, totalTokens, missingMetadata };
}

export const geminiProvider: AiProvider = {
  name: "gemini",

  isConfigured(): boolean {
    // Accepts either the Replit AI integration proxy pair or a direct
    // GEMINI_API_KEY (portable). Resolution lives in the integrations package.
    return isGeminiConfigured();
  },

  async generate(req: AiRequest): Promise<AiResult> {
    const response = await withTimeout(
      ai.models.generateContent({
        model: req.model,
        contents: [{ role: "user", parts: req.parts }],
        config: {
          ...(req.responseFormat === "json" ? { responseMimeType: "application/json" } : {}),
          ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
          ...(req.thinkingBudget !== undefined
            ? { thinkingConfig: { thinkingBudget: req.thinkingBudget } }
            : {}),
        },
      }),
      req.timeoutMs,
      `gemini ${req.model}`,
    );

    return {
      text: response.text ?? "",
      usage: readUsage(response.usageMetadata as UsageMetadata | undefined),
      model: req.model,
    };
  },
};
