import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config.js";
import { AiProviderError, type AiProvider, type AiRequest, type AiResult, type AiUsage } from "../types.js";

// Anthropic (Claude) adapter — the official SDK behind the provider-agnostic AiProvider
// interface. It maps an AiRequest onto the Messages API and normalises the answer, the
// token usage and every failure back out; no SDK type leaves this file.
//
// What is relied on, with its source (Anthropic documentation, platform.claude.com/docs,
// read 2026-11-20):
//   • Images ("Vision"): JPEG, PNG, GIF and WebP as base64 image blocks, at most 10 MB
//     each on the Claude API. Images go before the text of the same turn.
//   • JSON: the features' prompts already ask for a single JSON object; a system line
//     repeats it and the layer's tolerant parser reads the answer. Schema-constrained
//     output (`output_config.format`, "Structured outputs") is NOT used: its limits (at
//     most 16 nullable or union-typed fields per schema) are below what the card
//     extraction shape needs, so adopting it means reshaping that contract first.
//   • Reasoning: Claude Opus 5.5 always reasons, and reasoning is billed as output on
//     every model; `output_config.effort` sets its depth. The adapter sends no
//     `thinking` field (Sonnet 5.5 and Haiku 5.5 have reduced-thinking modes that are
//     not used here), no sampling parameter (the current models reject them) and no
//     assistant prefill.
//   • Usage ("Create a Message"): total input is input_tokens + cache_creation_input_tokens
//     + cache_read_input_tokens; output_tokens is the billed output, reasoning included.
//   • Refusals: HTTP 200 with stop_reason "refusal". It is reported as a refusal and is
//     never retried here or on another provider. The API's own model-to-model refusal
//     fallback is deliberately not enabled.
//   • Errors ("Errors"): 429 / 5xx / 529 and connection failures are transient; 401 and
//     403 are credential faults; a 429 whose error code is one of the spend caps
//     (…_spend_limit_reached), a billing error and 402 mean the provider account itself
//     is stopped; other 4xx reject the request.
//
// The key is read from the server configuration only (config.ai.anthropic). The client
// is created on first use, so a server without the key starts normally and the provider
// simply reports itself as not configured. The base URL is fixed by configuration, no
// auth token of the host's environment is used, the SDK's log level is pinned (its debug
// level prints request bodies) and SDK-level retries are off: the layer's own runner and
// fallback own retrying.

const NAME = "anthropic";

/** Image types the Messages API accepts. */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
/** 10 MB of base64 text per image on the Claude API. */
const MAX_IMAGE_BASE64_CHARS = 10 * 1024 * 1024;

const JSON_ONLY =
  "Reply with exactly one JSON object and nothing else: no text before or after it and no Markdown code fence.";

/** The part of the SDK client this adapter uses — small enough to fake in a test. */
export interface AnthropicMessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { timeout?: number; maxRetries?: number },
    ): PromiseLike<Anthropic.Message>;
  };
}

export interface AnthropicAdapterDeps {
  /** The configured key, or null. Never logged, never returned. */
  apiKey(): string | null;
  /** Builds the client for a key (the real SDK in production, a fake in tests). */
  createClient(apiKey: string): AnthropicMessagesClient;
}

function normaliseMediaType(raw: string): string {
  const t = raw.trim().toLowerCase();
  return t === "image/jpg" ? "image/jpeg" : t;
}

function usageOf(u: Anthropic.Usage | null | undefined): AiUsage {
  if (!u) return { inputTokens: 0, outputTokens: 0, totalTokens: 0, missingMetadata: true };
  const inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const outputTokens = u.output_tokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/** The provider's own short error text, without anything from the request. */
function shortMessage(err: { message?: unknown; apiMessage?: unknown }): string {
  // The API's own message when there is one; the SDK's text (status + body) otherwise.
  const m = typeof err.apiMessage === "string" && err.apiMessage ? err.apiMessage : typeof err.message === "string" ? err.message : "";
  return m.replace(/\s+/g, " ").trim().slice(0, 200);
}

function toProviderError(err: unknown, req: AiRequest): unknown {
  if (err instanceof AiProviderError) return err;
  // Most specific first: the timeout class extends the connection class, and both extend APIError.
  if (err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.APIUserAbortError) {
    return new AiProviderError(NAME, "timeout", `anthropic ${req.model} timed out after ${req.timeoutMs}ms`, { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AiProviderError(NAME, "network", `anthropic network error: ${shortMessage(err)}`, { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : null;
    const where = `anthropic ${status ?? "error"}${err.type ? ` ${err.type}` : ""}`;
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return new AiProviderError(NAME, "auth", `${where}: the provider rejected the configured credentials`, { status, cause: err });
    }
    if (err instanceof Anthropic.RateLimitError) {
      // A 429 for a spend cap (the account's, a contract's or a linked organization's)
      // carries no retry-after and does not clear by waiting.
      const spendCap = typeof err.errorCode === "string" && err.errorCode.endsWith("spend_limit_reached");
      return new AiProviderError(NAME, spendCap ? "quota" : "rate_limited", `${where}: ${spendCap ? "the provider account's spend limit is reached" : "rate limited"}`, { status, cause: err });
    }
    if (status === 402 || err.type === "billing_error" || /credit balance/i.test(shortMessage(err))) {
      return new AiProviderError(NAME, "quota", `${where}: the provider account has a billing problem`, { status, cause: err });
    }
    if (status === 408) {
      return new AiProviderError(NAME, "timeout", `anthropic ${req.model} timed out after ${req.timeoutMs}ms`, { status, cause: err });
    }
    if (status === 409 || (status !== null && status >= 500)) {
      return new AiProviderError(NAME, "unavailable", `${where}: ${shortMessage(err) || "service unavailable"}`, { status, cause: err });
    }
    return new AiProviderError(NAME, "invalid_request", `${where}: ${shortMessage(err) || "request rejected"}`, { status, cause: err });
  }
  return err;
}

export function createAnthropicProvider(deps: AnthropicAdapterDeps): AiProvider {
  let client: AnthropicMessagesClient | null = null;
  let clientKey: string | null = null;

  function clientFor(key: string): AnthropicMessagesClient {
    if (!client || clientKey !== key) {
      client = deps.createClient(key);
      clientKey = key;
    }
    return client;
  }

  return {
    name: NAME,

    isConfigured(): boolean {
      return deps.apiKey() !== null;
    },

    async generate(req: AiRequest): Promise<AiResult> {
      const key = deps.apiKey();
      if (key === null) {
        throw new AiProviderError(NAME, "auth", "anthropic is not configured (no API key on the server)");
      }

      const images: Anthropic.ImageBlockParam[] = [];
      const texts: Anthropic.TextBlockParam[] = [];
      for (const part of req.parts) {
        if ("text" in part) {
          if (part.text.length > 0) texts.push({ type: "text", text: part.text });
          continue;
        }
        const mediaType = normaliseMediaType(part.inlineData.mimeType);
        if (!IMAGE_TYPES.has(mediaType)) {
          throw new AiProviderError(NAME, "unsupported_input", `anthropic does not accept images of type ${mediaType.slice(0, 40)} (JPEG, PNG, GIF or WebP)`);
        }
        // Line breaks inside base64 are legal for a decoder but not for the API.
        const data = /\s/.test(part.inlineData.data) ? part.inlineData.data.replace(/\s+/g, "") : part.inlineData.data;
        if (data.length > MAX_IMAGE_BASE64_CHARS) {
          throw new AiProviderError(NAME, "unsupported_input", "anthropic does not accept an image larger than 10 MB (base64-encoded)");
        }
        images.push({
          type: "image",
          source: { type: "base64", media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data },
        });
      }
      if (images.length === 0 && texts.length === 0) {
        throw new AiProviderError(NAME, "invalid_request", "anthropic request has no content");
      }

      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: req.model,
        // Reasoning counts toward max_tokens, so a small per-feature cap is raised.
        max_tokens: Math.max(req.maxOutputTokens ?? 0, config.ai.anthropic.minMaxTokens),
        ...(req.responseFormat === "json" ? { system: JSON_ONLY } : {}),
        messages: [{ role: "user", content: [...images, ...texts] }],
        output_config: { effort: config.ai.anthropic.effort },
      };

      let message: Anthropic.Message;
      try {
        message = await clientFor(key).messages.create(params, { timeout: req.timeoutMs, maxRetries: 0 });
      } catch (err) {
        throw toProviderError(err, req);
      }

      const usage = usageOf(message.usage);
      if (message.stop_reason === "refusal") {
        const category = message.stop_details?.category;
        throw new AiProviderError(NAME, "refusal", `anthropic declined the request${category ? ` (${String(category).slice(0, 40)})` : ""}`, { status: 200, usage });
      }

      let text = "";
      for (const block of message.content) {
        if (block.type === "text") text += block.text;
      }
      // The requested model id is the pricing key; the API may report a longer id.
      return { text, usage, model: req.model };
    },
  };
}

function configuredKey(): string | null {
  const key = config.ai.anthropic.apiKey?.trim();
  return key ? key : null;
}

export const anthropicProvider: AiProvider = createAnthropicProvider({
  apiKey: configuredKey,
  createClient: (apiKey) =>
    new Anthropic({
      apiKey,
      // No auth token and no base URL from the host's environment.
      authToken: null,
      baseURL: config.ai.anthropic.baseUrl,
      maxRetries: 0,
      // Pinned: at "debug" the SDK prints request bodies (the prompt and the card
      // image) to the console, outside the application's log redaction.
      logLevel: "warn",
    }),
});
