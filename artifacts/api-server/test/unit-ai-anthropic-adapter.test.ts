// Platform AI provider management — focused unit tests for the Anthropic (Claude)
// adapter (src/ai/providers/anthropic.ts). No live server, no database, NO NETWORK: the
// adapter is given a fake client, so what it SENDS and how it reads every kind of answer
// and failure is asserted without a single request leaving the process. SDK error objects
// are constructed locally (the SDK's own classes), never produced by a call.
import { describe, it, expect, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicProvider, anthropicProvider, type AnthropicMessagesClient } from "../src/ai/providers/anthropic.js";
import { AiProviderError, type AiRequest } from "../src/ai/types.js";
import { categorizeError, isFallbackEligible, isProviderDown } from "../src/ai/runner.js";
import { config } from "../src/config.js";

type Params = Anthropic.MessageCreateParamsNonStreaming;

function message(over: Partial<Anthropic.Message> & { usage?: Partial<Anthropic.Usage> } = {}): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5-20261101",
    content: [{ type: "text", text: '{"ok":true}', citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    ...over,
    usage: { input_tokens: 120, output_tokens: 45, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...(over.usage ?? {}) },
  } as unknown as Anthropic.Message;
}

function harness(answer: () => Promise<Anthropic.Message> | Anthropic.Message, key: string | null = "test-key-not-real") {
  const create = vi.fn(async (_params: Params, _options?: { timeout?: number; maxRetries?: number }) => answer());
  const createClient = vi.fn((_apiKey: string): AnthropicMessagesClient => ({ messages: { create } }));
  const provider = createAnthropicProvider({ apiKey: () => key, createClient });
  return { provider, create, createClient };
}

const TEXT_REQ: AiRequest = { model: "claude-opus-5-5", parts: [{ text: "Return a JSON object." }], responseFormat: "json", maxOutputTokens: 1024, thinkingBudget: 0, timeoutMs: 20_000 };
const IMAGE = "A".repeat(400);

async function failure(p: Promise<unknown>): Promise<AiProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AiProviderError);
    return err as AiProviderError;
  }
  throw new Error("expected the adapter to throw");
}

const apiError = (status: number, type: string, details?: Record<string, unknown>) =>
  Anthropic.APIError.generate(status, { type: "error", error: { type, message: "simulated", ...(details ? { details } : {}) } }, undefined, new Headers({ "request-id": "req_test" }));

describe("Anthropic adapter — what is sent", () => {
  it("sends a text request as one user turn with the JSON-only system line, the model id as given and no sampling parameters", async () => {
    const { provider, create } = harness(() => message());
    await provider.generate(TEXT_REQ);
    expect(create).toHaveBeenCalledTimes(1);
    const [params, options] = create.mock.calls[0];
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Return a JSON object." }] }]);
    expect(typeof params.system).toBe("string");
    expect(String(params.system)).toMatch(/exactly one JSON object/i);
    // The current models reject sampling parameters, and no assistant prefill is used.
    for (const k of ["temperature", "top_p", "top_k", "thinking", "tools", "tool_choice", "stream"]) expect(params).not.toHaveProperty(k);
    expect(params.messages).toHaveLength(1);
    // Retrying belongs to the layer's own runner and fallback — never to the SDK.
    expect(options).toEqual({ timeout: 20_000, maxRetries: 0 });
  });

  it("raises a small per-feature output cap to the configured floor (reasoning counts toward max_tokens) and never lowers a larger one", async () => {
    const floor = config.ai.anthropic.minMaxTokens;
    const { provider, create } = harness(() => message());
    await provider.generate({ ...TEXT_REQ, maxOutputTokens: 256 });
    await provider.generate({ ...TEXT_REQ, maxOutputTokens: floor + 5000 });
    await provider.generate({ ...TEXT_REQ, maxOutputTokens: undefined });
    expect(create.mock.calls.map((c) => c[0].max_tokens)).toEqual([floor, floor + 5000, floor]);
  });

  it("sets the reasoning depth through output_config.effort and uses no schema-constrained output", async () => {
    const { provider, create } = harness(() => message());
    await provider.generate(TEXT_REQ);
    const params = create.mock.calls[0][0];
    expect(params.output_config).toEqual({ effort: config.ai.anthropic.effort });
    expect(params.output_config).not.toHaveProperty("format");
  });

  it("does not add the JSON system line to a text-format request", async () => {
    const { provider, create } = harness(() => message());
    await provider.generate({ ...TEXT_REQ, responseFormat: "text" });
    expect(create.mock.calls[0][0]).not.toHaveProperty("system");
  });

  it("sends a business-card image as a base64 image block BEFORE the text of the same turn", async () => {
    const { provider, create } = harness(() => message());
    await provider.generate({ ...TEXT_REQ, parts: [{ text: "Extract the card." }, { inlineData: { mimeType: "image/jpeg", data: IMAGE } }] });
    expect(create.mock.calls[0][0].messages[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: IMAGE } },
      { type: "text", text: "Extract the card." },
    ]);
  });

  it("accepts JPEG, PNG, GIF and WebP (and the image/jpg spelling); any other type is 'this provider cannot take this input' — no request is made, and the other provider may be tried", async () => {
    for (const [given, sent] of [["image/jpeg", "image/jpeg"], ["image/jpg", "image/jpeg"], ["IMAGE/PNG", "image/png"], ["image/gif", "image/gif"], ["image/webp", "image/webp"]] as const) {
      const { provider, create } = harness(() => message());
      await provider.generate({ ...TEXT_REQ, parts: [{ inlineData: { mimeType: given, data: IMAGE } }] });
      const block = (create.mock.calls[0][0].messages[0].content as Anthropic.ImageBlockParam[])[0];
      expect((block.source as { media_type: string }).media_type).toBe(sent);
    }
    for (const bad of ["image/heic", "image/tiff", "application/pdf", "image/svg+xml"]) {
      const { provider, create } = harness(() => message());
      const err = await failure(provider.generate({ ...TEXT_REQ, parts: [{ inlineData: { mimeType: bad, data: IMAGE } }] }));
      expect(err.kind).toBe("unsupported_input");
      expect(categorizeError(err)).toBe("provider_unsupported_input");
      expect(isFallbackEligible(err)).toBe(true);
      expect(isProviderDown(err)).toBe(false); // …but it is not an outage: no "AI is unavailable" message for it
      expect(create).not.toHaveBeenCalled();
    }
  });

  it("removes line breaks from base64 image data before sending it", async () => {
    const { provider, create } = harness(() => message());
    const wrapped = `${IMAGE.slice(0, 76)}\r\n${IMAGE.slice(76, 152)}\n${IMAGE.slice(152)}`;
    await provider.generate({ ...TEXT_REQ, parts: [{ inlineData: { mimeType: "image/png", data: wrapped } }] });
    const block = (create.mock.calls[0][0].messages[0].content as Anthropic.ImageBlockParam[])[0];
    expect((block.source as { data: string }).data).toBe(IMAGE);
  });

  it("an image above 10 MB of base64 is input this provider cannot take (the other provider may be tried); an empty request is refused — neither calls the provider", async () => {
    const big = harness(() => message());
    const tooLarge = await failure(big.provider.generate({ ...TEXT_REQ, parts: [{ inlineData: { mimeType: "image/png", data: "A".repeat(10 * 1024 * 1024 + 1) } }] }));
    expect(tooLarge.kind).toBe("unsupported_input");
    expect(isFallbackEligible(tooLarge)).toBe(true);
    expect(big.create).not.toHaveBeenCalled();
    // Exactly at the documented limit it is sent.
    const atLimit = harness(() => message());
    await atLimit.provider.generate({ ...TEXT_REQ, parts: [{ inlineData: { mimeType: "image/png", data: "A".repeat(10 * 1024 * 1024) } }] });
    expect(atLimit.create).toHaveBeenCalledTimes(1);

    const empty = harness(() => message());
    expect((await failure(empty.provider.generate({ ...TEXT_REQ, parts: [{ text: "" }] }))).kind).toBe("invalid_request");
    expect(empty.create).not.toHaveBeenCalled();
  });
});

describe("Anthropic adapter — what comes back", () => {
  it("joins the text blocks, skips reasoning blocks, and reports the REQUESTED model id (the pricing key)", async () => {
    const { provider } = harness(() =>
      message({
        content: [
          { type: "thinking", thinking: "…", signature: "sig" },
          { type: "text", text: '{"firstName":"Sara",', citations: null },
          { type: "text", text: '"company":"Acme"}', citations: null },
        ] as unknown as Anthropic.ContentBlock[],
      }),
    );
    const result = await provider.generate(TEXT_REQ);
    expect(result.text).toBe('{"firstName":"Sara","company":"Acme"}');
    expect(JSON.parse(result.text)).toEqual({ firstName: "Sara", company: "Acme" });
    expect(result.model).toBe("claude-opus-5-5");
  });

  it("counts input as input_tokens + cache_creation_input_tokens + cache_read_input_tokens, and output as output_tokens", async () => {
    const { provider } = harness(() => message({ usage: { input_tokens: 100, cache_creation_input_tokens: 30, cache_read_input_tokens: 7, output_tokens: 50 } }));
    const { usage } = await provider.generate(TEXT_REQ);
    expect(usage).toEqual({ inputTokens: 137, outputTokens: 50, totalTokens: 187 });
  });

  it("flags usage as missing when the provider reports none (the ledger then marks the row as estimated)", async () => {
    const { provider } = harness(() => ({ ...message(), usage: undefined }) as unknown as Anthropic.Message);
    const { usage } = await provider.generate(TEXT_REQ);
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, missingMetadata: true });
  });

  it("reports a refusal (HTTP 200, stop_reason refusal) as a refusal WITH the tokens it consumed — never as text, never eligible for fallback", async () => {
    const { provider } = harness(() =>
      message({ stop_reason: "refusal", content: [], usage: { input_tokens: 90, output_tokens: 3 }, ...({ stop_details: { type: "refusal", category: "cyber", explanation: null } } as object) }),
    );
    const err = await failure(provider.generate(TEXT_REQ));
    expect(err.kind).toBe("refusal");
    expect(err.status).toBe(200);
    expect(err.usage).toEqual({ inputTokens: 90, outputTokens: 3, totalTokens: 93 });
    expect(categorizeError(err)).toBe("provider_refusal");
    expect(isFallbackEligible(err)).toBe(false);
  });
});

describe("Anthropic adapter — failures", () => {
  const cases: Array<{ name: string; thrown: () => unknown; kind: AiProviderError["kind"]; category: string; fallback: boolean; status: number | null }> = [
    { name: "401 authentication_error", thrown: () => apiError(401, "authentication_error"), kind: "auth", category: "provider_auth", fallback: true, status: 401 },
    { name: "403 permission_error", thrown: () => apiError(403, "permission_error"), kind: "auth", category: "provider_auth", fallback: true, status: 403 },
    { name: "429 rate_limit_error", thrown: () => apiError(429, "rate_limit_error"), kind: "rate_limited", category: "provider_rate_limited", fallback: true, status: 429 },
    { name: "429 with the account spend-cap code", thrown: () => apiError(429, "rate_limit_error", { error_code: "enforced_spend_limit_reached" }), kind: "quota", category: "provider_quota", fallback: false, status: 429 },
    { name: "429 with the contract spend-cap code", thrown: () => apiError(429, "rate_limit_error", { error_code: "contract_spend_limit_reached" }), kind: "quota", category: "provider_quota", fallback: false, status: 429 },
    { name: "429 with the linked-organization spend-cap code", thrown: () => apiError(429, "rate_limit_error", { error_code: "linked_organization_spend_limit_reached" }), kind: "quota", category: "provider_quota", fallback: false, status: 429 },
    { name: "402 billing_error", thrown: () => apiError(402, "billing_error"), kind: "quota", category: "provider_quota", fallback: false, status: 402 },
    { name: "a billing_error on another status", thrown: () => apiError(400, "billing_error"), kind: "quota", category: "provider_quota", fallback: false, status: 400 },
    { name: "400 'credit balance is too low'", thrown: () => Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the API." } }, undefined, new Headers()), kind: "quota", category: "provider_quota", fallback: false, status: 400 },
    { name: "400 invalid_request_error", thrown: () => apiError(400, "invalid_request_error"), kind: "invalid_request", category: "provider_rejected", fallback: false, status: 400 },
    { name: "404 not_found_error (unknown model)", thrown: () => apiError(404, "not_found_error"), kind: "invalid_request", category: "provider_rejected", fallback: false, status: 404 },
    { name: "413 request_too_large", thrown: () => apiError(413, "request_too_large"), kind: "invalid_request", category: "provider_rejected", fallback: false, status: 413 },
    { name: "408 timeout_error", thrown: () => apiError(408, "timeout_error"), kind: "timeout", category: "timeout", fallback: true, status: 408 },
    { name: "409 conflict_error", thrown: () => apiError(409, "conflict_error"), kind: "unavailable", category: "provider_unavailable", fallback: true, status: 409 },
    { name: "500 api_error", thrown: () => apiError(500, "api_error"), kind: "unavailable", category: "provider_unavailable", fallback: true, status: 500 },
    { name: "529 overloaded_error", thrown: () => apiError(529, "overloaded_error"), kind: "unavailable", category: "provider_unavailable", fallback: true, status: 529 },
    { name: "a client-side timeout", thrown: () => new Anthropic.APIConnectionTimeoutError(), kind: "timeout", category: "timeout", fallback: true, status: null },
    { name: "an aborted request", thrown: () => new Anthropic.APIUserAbortError(), kind: "timeout", category: "timeout", fallback: true, status: null },
    { name: "a connection failure", thrown: () => new Anthropic.APIConnectionError({ message: "fetch failed" }), kind: "network", category: "network", fallback: true, status: null },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.kind} (${c.fallback ? "fallback may be tried" : "final"})`, async () => {
      const { provider } = harness(() => {
        throw c.thrown();
      });
      const err = await failure(provider.generate(TEXT_REQ));
      expect(err.provider).toBe("anthropic");
      expect(err.kind).toBe(c.kind);
      expect(err.status).toBe(c.status);
      expect(categorizeError(err)).toBe(c.category);
      expect(isFallbackEligible(err)).toBe(c.fallback);
      // The user is told "AI is unavailable" exactly when the provider did not serve: an
      // outage class, or the provider account being stopped (final, but not a bad photo).
      expect(isProviderDown(err)).toBe(c.fallback || c.kind === "quota");
    });
  }

  it("a timeout is reported in the form the runner recognises as a timeout", async () => {
    const { provider } = harness(() => {
      throw new Anthropic.APIConnectionTimeoutError();
    });
    const err = await failure(provider.generate(TEXT_REQ));
    expect(err.message).toBe("anthropic claude-opus-5-5 timed out after 20000ms");
  });

  it("an error that is not the SDK's is passed through untouched (the runner classifies it)", async () => {
    const boom = new Error("unexpected");
    const { provider } = harness(() => {
      throw boom;
    });
    await expect(provider.generate(TEXT_REQ)).rejects.toBe(boom);
  });

  it("never puts the key, the prompt or the image into an error message", async () => {
    const SECRET = "test-key-not-real-0123456789";
    for (const c of cases) {
      const { provider } = harness(() => {
        throw c.thrown();
      }, SECRET);
      const err = await failure(provider.generate({ ...TEXT_REQ, parts: [{ text: "CONFIDENTIAL-PROMPT" }, { inlineData: { mimeType: "image/png", data: IMAGE } }] }));
      expect(err.message).not.toContain(SECRET);
      expect(err.message).not.toContain("CONFIDENTIAL-PROMPT");
      expect(err.message).not.toContain(IMAGE);
      expect(err.message.length).toBeLessThanOrEqual(320);
    }
  });
});

describe("Anthropic adapter — credentials", () => {
  it("without a key it reports itself as not configured, refuses to generate and never builds a client", async () => {
    const { provider, create, createClient } = harness(() => message(), null);
    expect(provider.isConfigured()).toBe(false);
    const err = await failure(provider.generate(TEXT_REQ));
    expect(err.kind).toBe("auth");
    expect(err.message).not.toMatch(/sk-|ANTHROPIC_API_KEY/);
    expect(createClient).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("builds the client once per key and again only when the key changes (a rotated key needs no code change)", async () => {
    let key = "key-one";
    const create = vi.fn(async () => message());
    const createClient = vi.fn((_k: string): AnthropicMessagesClient => ({ messages: { create } }));
    const provider = createAnthropicProvider({ apiKey: () => key, createClient });
    await provider.generate(TEXT_REQ);
    await provider.generate(TEXT_REQ);
    expect(createClient.mock.calls.map((c) => c[0])).toEqual(["key-one"]);
    key = "key-two";
    await provider.generate(TEXT_REQ);
    expect(createClient.mock.calls.map((c) => c[0])).toEqual(["key-one", "key-two"]);
  });

  it("the registered adapter is unconfigured in the test environment — no key is present, so no request can be billed", () => {
    expect(config.ai.anthropic.apiKey ?? "").toBe("");
    expect(anthropicProvider.name).toBe("anthropic");
    expect(anthropicProvider.isConfigured()).toBe(false);
  });

  it("the base URL comes from the server configuration, not from the ambient environment", () => {
    expect(config.ai.anthropic.baseUrl).toBe(process.env.AI_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com");
  });
});
