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
    expect(describeScanError(403, {}).key).toBe("capture.errAuth");
    expect(describeScanError(401, {}).key).toBe("capture.errAuth");
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
      "capture.errTooLarge",
      "capture.errInvalid",
      "capture.errHeic",
      "capture.errOcr",
      "capture.errAuth",
      "capture.errServer",
      "capture.captureFailed",
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
