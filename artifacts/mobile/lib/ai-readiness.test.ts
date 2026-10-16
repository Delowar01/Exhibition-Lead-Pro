import { describe, expect, it } from "vitest";
import { aiReadinessFromHealth, aiReadinessNoticeKey } from "./ai-readiness";
import en from "./i18n/locales/en.json";
import ar from "./i18n/locales/ar.json";

// MOBILE-R1 — pre-scan readiness classification of GET /ai/health.

describe("aiReadinessFromHealth", () => {
  it("a configured provider is ready", () => {
    expect(aiReadinessFromHealth({ provider: "gemini", configured: true, status: "ok" })).toBe("ready");
  });

  it("a provider without a credential is unconfigured (configured=false wins over any status text)", () => {
    expect(aiReadinessFromHealth({ provider: "gemini", configured: false, status: "unconfigured" })).toBe("unconfigured");
    expect(aiReadinessFromHealth({ configured: false, status: "ok" })).toBe("unconfigured");
    expect(aiReadinessFromHealth({ status: "unconfigured" })).toBe("unconfigured");
  });

  it("no answer, a transport failure (undefined data), a 401/403 body or a malformed body is unknown — never a block", () => {
    expect(aiReadinessFromHealth(undefined)).toBe("unknown");
    expect(aiReadinessFromHealth(null)).toBe("unknown");
    expect(aiReadinessFromHealth("configured")).toBe("unknown");
    expect(aiReadinessFromHealth({ error: "Forbidden", code: "PLATFORM_OWNER_FIREWALL" })).toBe("unknown");
    expect(aiReadinessFromHealth({ configured: "false" })).toBe("unknown");
  });

  it("the server answer never carries a credential: the classifier reads only `configured` and `status`", () => {
    // A hostile or buggy body with extra fields changes nothing.
    expect(aiReadinessFromHealth({ configured: true, apiKey: "AIza-never-sent", status: "ok" })).toBe("ready");
  });
});

describe("aiReadinessNoticeKey", () => {
  it("shows the notice only for the unconfigured state and the key exists in both locales", () => {
    expect(aiReadinessNoticeKey("ready")).toBeNull();
    expect(aiReadinessNoticeKey("unknown")).toBeNull();
    const key = aiReadinessNoticeKey("unconfigured");
    expect(key).toBe("capture.aiNotConfiguredBody");
    for (const k of ["capture.aiNotConfiguredTitle", "capture.aiNotConfiguredBody", "capture.aiReadinessRetry", "capture.errAiNotConfigured"]) {
      const [ns, name] = k.split(".");
      expect(typeof (en as Record<string, Record<string, unknown>>)[ns][name], `en ${k}`).toBe("string");
      expect(typeof (ar as Record<string, Record<string, unknown>>)[ns][name], `ar ${k}`).toBe("string");
    }
  });
});
