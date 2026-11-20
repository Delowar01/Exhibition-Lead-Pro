import { describe, expect, it } from "vitest";
import { describeScanError } from "./scan-error";
import en from "./i18n/locales/en.json";
import ar from "./i18n/locales/ar.json";

// Batch 7 — scan/OCR error mapping used by capture-camera and batch-review.

describe("describeScanError", () => {
  it("maps AI budget exhaustion (429 + code) to the budget message", () => {
    const d = describeScanError(429, { error: "Monthly AI budget exceeded", code: "AI_BUDGET_EXCEEDED" });
    expect(d.key).toBe("capture.errBudget");
    expect(d.serverMessage).toBeNull(); // localized key preferred over server text
  });

  it("maps AI rate limiting (429) to the rate-limit message, with or without code", () => {
    expect(describeScanError(429, { code: "AI_RATE_LIMITED" }).key).toBe("capture.errRateLimit");
    expect(describeScanError(429, {}).key).toBe("capture.errRateLimit");
  });

  it("maps the controlled no-card result (422 SCAN_NO_CARD)", () => {
    expect(describeScanError(422, { code: "SCAN_NO_CARD", error: "No readable business card" }).key).toBe(
      "capture.errNoCard",
    );
    expect(describeScanError(422, {}).key).toBe("capture.errNoCard");
  });

  it("maps AI-disabled (403 + code) distinctly from generic auth failures", () => {
    expect(describeScanError(403, { code: "AI_DISABLED" }).key).toBe("capture.errAiDisabled");
    // Phase 2 Batch 1: a 403 is a refusal, not an expired session — it no longer
    // tells the user to sign in again. Only a 401 does.
    expect(describeScanError(403, {}).key).toBe("capture.errPermission");
    expect(describeScanError(403, { code: "FEATURE_NOT_ENTITLED" }).key).toBe("capture.errNotEntitled");
    expect(describeScanError(401, {}).key).toBe("capture.errAuth");
  });

  it("MOBILE-R1: maps the server readiness gate (503 AI_NOT_CONFIGURED) to the localized not-configured message, never to the retake-the-photo OCR text", () => {
    const d = describeScanError(503, {
      code: "AI_NOT_CONFIGURED",
      error: "AI features are not configured for this environment. Please contact your administrator.",
    });
    expect(d.key).toBe("capture.errAiNotConfigured");
    expect(d.serverMessage).toBeNull(); // localized key preferred (Arabic users get Arabic; batch review shows the key alone)
    // A 503 WITHOUT the machine code keeps the previous contract (server text when present).
    const plain = describeScanError(503, { error: "Upstream unavailable" });
    expect(plain.key).toBe("capture.errOcr");
    expect(plain.serverMessage).toBe("Upstream unavailable");
  });

  it("maps a provider outage (503 AI_PROVIDER_UNAVAILABLE) and a reached platform limit (503 AI_PLATFORM_LIMIT_REACHED) to the localized AI-unavailable message — never to retake-the-photo", () => {
    for (const code of ["AI_PROVIDER_UNAVAILABLE", "AI_PLATFORM_LIMIT_REACHED"]) {
      const d = describeScanError(503, { code, error: "AI card reading is temporarily unavailable. You can still add the contact manually, or capture it by QR code or NFC." });
      expect(d.key, code).toBe("capture.errAiUnavailable");
      expect(d.serverMessage, code).toBeNull(); // localized key preferred (Arabic users get Arabic)
      expect(d.key).not.toBe("capture.errOcr");
    }
    // The message tells the user what still works, in both languages.
    const lookup = (obj: Record<string, unknown>) => (obj.capture as Record<string, string>).errAiUnavailable;
    expect(lookup(en as Record<string, unknown>)).toMatch(/manually/);
    expect(lookup(en as Record<string, unknown>)).toMatch(/QR/);
    expect(lookup(en as Record<string, unknown>)).toMatch(/NFC/);
    expect(lookup(ar as Record<string, unknown>)).toMatch(/QR/);
    expect(lookup(ar as Record<string, unknown>)).toMatch(/NFC/);
    // A client that predates this mapping sees a 503 without a known code: the server's own sentence is shown.
    const legacy = describeScanError(503, { error: "AI card reading is temporarily unavailable." });
    expect(legacy.key).toBe("capture.errOcr");
    expect(legacy.serverMessage).toBe("AI card reading is temporarily unavailable.");
  });

  it("maps size rejections from both transport (413) and validation (400 + code)", () => {
    expect(describeScanError(413, {}).key).toBe("capture.errTooLarge");
    expect(describeScanError(400, { code: "SCAN_IMAGE_TOO_LARGE" }).key).toBe("capture.errTooLarge");
  });

  it("maps HEIC rejection (400 SCAN_IMAGE_HEIC_UNSUPPORTED) to the convert-to-JPEG message", () => {
    const d = describeScanError(400, {
      code: "SCAN_IMAGE_HEIC_UNSUPPORTED",
      error: "This HEIC image cannot be processed. Please use or convert it to JPEG.",
    });
    expect(d.key).toBe("capture.errHeic");
    expect(d.serverMessage).toBeNull(); // localized key preferred over server text
  });

  it("keeps server-localized messages for 400 validation and 502 OCR failures", () => {
    const bad = describeScanError(400, { error: "The uploaded image file is empty." });
    expect(bad.key).toBe("capture.errInvalid");
    expect(bad.serverMessage).toBe("The uploaded image file is empty.");
    const ocr = describeScanError(502, { error: "Could not read the card." });
    expect(ocr.key).toBe("capture.errOcr");
    expect(ocr.serverMessage).toBe("Could not read the card.");
  });

  it("maps 5xx to server error and unknown statuses to the generic key", () => {
    expect(describeScanError(500, {}).key).toBe("capture.errServer");
    expect(describeScanError(418, {}).key).toBe("capture.captureFailed");
  });

  it("every key it can return exists in BOTH English and Arabic locales", () => {
    const keys = [
      "capture.errBudget",
      "capture.errRateLimit",
      "capture.errNoCard",
      "capture.errAiDisabled",
      "capture.errAiNotConfigured",
      "capture.errAiUnavailable",
      "capture.errTooLarge",
      "capture.errInvalid",
      "capture.errHeic",
      "capture.errOcr",
      "capture.errAuth",
      "capture.errPermission",
      "capture.errNotEntitled",
      "capture.errLimit",
      "capture.errNetwork",
      "capture.errServer",
      "capture.captureFailed",
      "capture.keptForLater",
      "capture.duplicateKept",
      "batch.keepForLater",
      "batch.retryOcr",
      "batch.readError",
    ];
    const lookup = (obj: Record<string, unknown>, path: string) =>
      path.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), obj);
    for (const key of keys) {
      expect(typeof lookup(en as Record<string, unknown>, key), `en ${key}`).toBe("string");
      expect(typeof lookup(ar as Record<string, unknown>, key), `ar ${key}`).toBe("string");
    }
  });
});
