// B22 Correction 1 — focused unit tests for the provider readiness gate
// (src/ai/readiness.ts). No live server, no database writes, no network: the gate
// must refuse an unconfigured provider with a truthful 503 AI_NOT_CONFIGURED
// BEFORE any provider work, and the real Gemini adapter must report "unconfigured"
// (and therefore be refused) without a single fetch when no credential is present.
import { describe, it, expect, vi, afterEach } from "vitest";
import { assertProviderConfigured, AI_NOT_CONFIGURED_CODE, AI_NOT_CONFIGURED_MESSAGE } from "../src/ai/readiness.js";
import { geminiProvider } from "../src/ai/providers/gemini.js";
import { AppError } from "../src/middlewares/errorHandler.js";
import type { AiProvider } from "../src/ai/types.js";

function caught(fn: () => void): AppError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error("expected the gate to throw");
}

describe("B22 Correction 1 — assertProviderConfigured", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses an unconfigured provider with 503 AI_NOT_CONFIGURED and never reaches generate()", () => {
    const generate = vi.fn<AiProvider["generate"]>();
    const provider: AiProvider = { name: "gemini", isConfigured: () => false, generate };
    const err = caught(() => assertProviderConfigured(provider, "card_extraction"));
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe(AI_NOT_CONFIGURED_CODE);
    expect(err.message).toBe(AI_NOT_CONFIGURED_MESSAGE);
    expect(generate).not.toHaveBeenCalled();
  });

  it("the client-facing message carries no provider, environment-variable or key details", () => {
    const err = caught(() => assertProviderConfigured({ name: "gemini", isConfigured: () => false }, "lead_scoring"));
    expect(err.message).not.toMatch(/gemini|google|api[_ -]?key|GEMINI|AI_INTEGRATIONS|token|secret/i);
    expect(err.details).toBeUndefined();
  });

  it("lets a configured provider through untouched (no call is made by the gate itself)", () => {
    const generate = vi.fn<AiProvider["generate"]>();
    const provider: AiProvider = { name: "stub", isConfigured: () => true, generate };
    expect(() => assertProviderConfigured(provider, "card_extraction")).not.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });

  it("treats an adapter whose readiness check throws as unconfigured (never as an OCR failure)", () => {
    const provider: AiProvider = {
      name: "gemini",
      isConfigured: () => {
        throw new Error("boom");
      },
      generate: vi.fn<AiProvider["generate"]>(),
    };
    const err = caught(() => assertProviderConfigured(provider, "card_extraction"));
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe(AI_NOT_CONFIGURED_CODE);
  });
});

describe("B22 Correction 1 — the real Gemini adapter behind the gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("with no credential (unset) the adapter is unconfigured and the gate refuses it without any network call", () => {
    vi.stubEnv("GEMINI_API_KEY", undefined);
    vi.stubEnv("AI_INTEGRATIONS_GEMINI_API_KEY", undefined);
    vi.stubEnv("AI_INTEGRATIONS_GEMINI_BASE_URL", undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(geminiProvider.isConfigured()).toBe(false);
    const err = caught(() => assertProviderConfigured(geminiProvider, "card_extraction"));
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe(AI_NOT_CONFIGURED_CODE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an EMPTY GEMINI_API_KEY placeholder (the hosted-dev state) also counts as unconfigured", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("AI_INTEGRATIONS_GEMINI_API_KEY", undefined);
    vi.stubEnv("AI_INTEGRATIONS_GEMINI_BASE_URL", undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(geminiProvider.isConfigured()).toBe(false);
    expect(() => assertProviderConfigured(geminiProvider, "card_extraction")).toThrow(AppError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with a credential present the adapter reports configured and the gate passes (still no call)", () => {
    vi.stubEnv("GEMINI_API_KEY", "unit-test-placeholder-not-a-real-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(geminiProvider.isConfigured()).toBe(true);
    expect(() => assertProviderConfigured(geminiProvider, "card_extraction")).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
