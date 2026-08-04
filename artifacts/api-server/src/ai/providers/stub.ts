import { createHash } from "node:crypto";
import type { AiProvider, AiRequest, AiResult, AiUsage } from "../types.js";

// Batch 6 — deterministic stub provider for automated tests. NEVER registered in
// production (see providers/index.ts + config.ai.enableStubProvider). It performs no
// network I/O and returns a fixed JSON body with deterministic usage metadata so
// usage-accounting, budget, rate-limit, dedup, and cache behavior can be tested
// end-to-end without live Gemini calls.
//
// Behavior is selected by MODEL NAME (tenant-configurable via PATCH /ai/settings):
//   stub-model     → success, real usage metadata (input from prompt size, output 80)
//   stub-nousage   → success, NO usage metadata (exercises the estimated fallback)
//   stub-fail      → throws a generic provider error
//   stub-fail-once → fails the FIRST attempt for a given prompt, succeeds on the
//                    retry of that same prompt (keyed by prompt hash, so behavior
//                    is deterministic per request regardless of process history)
//   stub-timeout   → throws a timeout-shaped error
//   stub-slow      → resolves after 1500ms (for concurrency/dedup-in-flight tests)

function promptChars(req: AiRequest): number {
  let chars = 0;
  for (const part of req.parts) {
    if ("text" in part) chars += part.text.length;
    else chars += Math.ceil(part.inlineData.data.length / 100); // images: tiny fixed weight
  }
  return chars;
}

function usageFor(req: AiRequest): AiUsage {
  const inputTokens = Math.max(1, Math.ceil(promptChars(req) / 4));
  const outputTokens = 80;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

// Generic JSON body that satisfies every feature parser's "optional fields" reading.
// Confidence/score fields are included so score-shaped features parse cleanly.
const STUB_BODY = JSON.stringify({
  confidence: 90,
  score: 75,
  temperature: "warm",
  reasoning: "stub deterministic response",
  summary: "stub deterministic response",
  recommendations: ["stub recommendation"],
  answer: "stub deterministic response",
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Per-prompt "seen" set: the first attempt for a prompt fails, the retry of the
// SAME prompt succeeds. A process-global counter would break determinism as soon
// as any unrelated call shifted its parity.
const failOnceSeen = new Set<string>();

function failOnceKey(req: AiRequest): string {
  const h = createHash("sha1");
  for (const part of req.parts) {
    h.update("text" in part ? part.text : part.inlineData.data.slice(0, 64));
  }
  return h.digest("hex");
}

export const stubProvider: AiProvider = {
  name: "stub",

  isConfigured(): boolean {
    return true;
  },

  async generate(req: AiRequest): Promise<AiResult> {
    if (req.model === "stub-fail") {
      throw new Error("stub provider simulated failure");
    }
    if (req.model === "stub-timeout") {
      throw new Error(`stub ${req.model} timed out after ${req.timeoutMs}ms`);
    }
    if (req.model === "stub-fail-once") {
      const key = failOnceKey(req);
      if (!failOnceSeen.has(key)) {
        if (failOnceSeen.size > 500) failOnceSeen.clear(); // bound memory (test-only path)
        failOnceSeen.add(key);
        throw new Error("stub provider transient failure");
      }
      failOnceSeen.delete(key);
    }
    if (req.model === "stub-slow") {
      await sleep(1_500);
    }
    const hasUsage = req.model !== "stub-nousage";
    return {
      text: STUB_BODY,
      usage: hasUsage
        ? usageFor(req)
        : { inputTokens: 0, outputTokens: 0, totalTokens: 0, missingMetadata: true },
      model: req.model,
    };
  },
};
