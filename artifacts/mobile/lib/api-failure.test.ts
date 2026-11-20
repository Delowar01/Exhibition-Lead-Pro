// Phase 2 Batch 1 — one classification of a failed API call for camera capture,
// batch scanning, scan review / reprocess, the AI Assistant and the offline sync.
import { describe, expect, it } from "vitest";

import {
  assistantCanRetry,
  assistantFailureKey,
  classifyApiFailure,
  classifyHttpFailure,
  isAiWideFailure,
  isTransportError,
  lostConnectionOrSession,
  mayShowServerMessage,
  scanFailureKey,
  worthKeepingForLater,
  type ApiFailureKind,
} from "./api-failure";
import { canRetrySend, classifySendError, sendErrorMessageKey } from "./assistant-error";
import ar from "./i18n/locales/ar.json";
import en from "./i18n/locales/en.json";
import { describeScanError, describeScanFailure, scanActionFailureKey } from "./scan-error";

const lookup = (obj: unknown, path: string) => path.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), obj);
const text = (key: string) => ({ en: lookup(en, key) as string, ar: lookup(ar, key) as string });

const ALL_KINDS: ApiFailureKind[] = [
  "network", "session_expired", "not_entitled", "permission", "ai_disabled", "ai_not_configured", "ai_unavailable", "ai_platform_limit",
  "ai_budget", "rate_limited", "no_card", "image_too_large", "image_heic", "invalid", "duplicate", "limit", "not_found", "upstream", "server", "unknown",
];

describe("the six AI situations the user must be able to tell apart", () => {
  const cases: Array<{ name: string; status: number; code: string; kind: ApiFailureKind }> = [
    { name: "provider temporarily unavailable", status: 503, code: "AI_PROVIDER_UNAVAILABLE", kind: "ai_unavailable" },
    { name: "Claude / Gemini fallback failed too (same answer from the server)", status: 503, code: "AI_PROVIDER_UNAVAILABLE", kind: "ai_unavailable" },
    { name: "missing API configuration", status: 503, code: "AI_NOT_CONFIGURED", kind: "ai_not_configured" },
    { name: "company AI budget exceeded", status: 429, code: "AI_BUDGET_EXCEEDED", kind: "ai_budget" },
    { name: "platform spending limit reached", status: 503, code: "AI_PLATFORM_LIMIT_REACHED", kind: "ai_platform_limit" },
    { name: "AI switched off for the company", status: 403, code: "AI_DISABLED", kind: "ai_disabled" },
  ];
  for (const c of cases) {
    it(`${c.name} → ${c.kind}, the same on every screen, with a sentence in both languages`, () => {
      const body = { code: c.code, error: "raw: anthropic 529 overloaded_error req_011CSx key sk-ant-REDACTED model claude-opus-5-5" };
      const err = { status: c.status, data: body };
      expect(classifyHttpFailure(c.status, body).kind).toBe(c.kind);
      expect(classifyApiFailure(err).kind).toBe(c.kind);
      // camera / batch / scan review
      const scan = describeScanFailure(err);
      expect(scan.kind).toBe(c.kind);
      expect(scan.serverMessage).toBeNull(); // the server's text is never passed through for an AI failure
      expect(scan.key).toBe(describeScanError(c.status, body).key);
      expect(scanActionFailureKey(err, "scanReview.reprocessErrorBody")).toBe(scan.key);
      // assistant
      const assistantKey = sendErrorMessageKey(classifySendError(err));
      expect(assistantKey).toBe(assistantFailureKey(c.kind));
      for (const key of [scan.key, assistantKey]) {
        const t = text(key);
        expect(typeof t.en, key).toBe("string");
        expect(typeof t.ar, key).toBe("string");
        // nothing internal can reach the user: the sentences are fixed and name no provider, model, key or request id
        for (const s of [t.en, t.ar]) expect(s).not.toMatch(/anthropic|claude|gemini|google|opus|sk-|req_|api key|overloaded|\b5\d\d\b|\b4\d\d\b/i);
      }
      expect(isAiWideFailure(c.kind)).toBe(true);
    });
  }

  it("a provider outage and a reached platform limit read the same to a customer (the platform's limits are not theirs to manage)", () => {
    expect(scanFailureKey("ai_platform_limit")).toBe(scanFailureKey("ai_unavailable"));
    expect(assistantFailureKey("ai_platform_limit")).toBe(assistantFailureKey("ai_unavailable"));
    const t = text(scanFailureKey("ai_unavailable"));
    expect(t.en).toMatch(/manually/);
    expect(t.en).toMatch(/QR/);
    expect(t.ar).toMatch(/QR/);
  });

  it("not configured and budget exceeded point to the administrator; unavailable asks to try again", () => {
    expect(text("capture.errAiNotConfigured").en).toMatch(/administrator/i);
    expect(text("capture.errBudget").en).toMatch(/admin/i);
    expect(text("capture.errAiUnavailable").en).toMatch(/try again/i);
    expect(text("assistant.sendFailedNotConfigured").en).toMatch(/administrator/i);
    expect(text("assistant.sendFailedUnavailable").en).toMatch(/try again/i);
  });
});

describe("OCR image processing errors", () => {
  it("no readable card, an oversized image, HEIC and a refused image each have their own advice", () => {
    expect(describeScanError(422, { code: "SCAN_NO_CARD" }).kind).toBe("no_card");
    expect(describeScanError(413, {}).kind).toBe("image_too_large");
    expect(describeScanError(400, { code: "SCAN_IMAGE_TOO_LARGE" }).kind).toBe("image_too_large");
    expect(describeScanError(400, { code: "SCAN_IMAGE_HEIC_UNSUPPORTED" }).kind).toBe("image_heic");
    expect(describeScanError(400, { error: "The uploaded image file is empty." })).toEqual({ key: "capture.errInvalid", serverMessage: "The uploaded image file is empty.", kind: "invalid" });
    expect(describeScanError(502, { error: "Could not read the card." })).toEqual({ key: "capture.errOcr", serverMessage: "Could not read the card.", kind: "upstream" });
    expect(new Set(["no_card", "image_too_large", "image_heic", "invalid"].map((k) => scanFailureKey(k as ApiFailureKind))).size).toBe(4);
  });

  it("the API's own sentence is passed on only for a refused or unreadable image", () => {
    for (const kind of ALL_KINDS) expect(mayShowServerMessage(kind), kind).toBe(kind === "invalid" || kind === "upstream");
  });

  it("a photo is kept for later only when nothing is wrong with the photo", () => {
    const keep = ALL_KINDS.filter(worthKeepingForLater).sort();
    expect(keep).toEqual(["ai_budget", "ai_not_configured", "ai_platform_limit", "ai_unavailable", "network", "rate_limited", "session_expired"]);
  });
});

describe("everything else", () => {
  it("401 is an ended session, 403 a refusal, and the plan cases are named", () => {
    expect(classifyHttpFailure(401, { error: "Session expired. Please sign in again." }).kind).toBe("session_expired");
    expect(classifyHttpFailure(403, {}).kind).toBe("permission");
    expect(classifyHttpFailure(403, { code: "FEATURE_NOT_ENTITLED" }).kind).toBe("not_entitled");
    expect(classifyHttpFailure(409, { code: "existing_contact_found" }).kind).toBe("duplicate");
    expect(classifyHttpFailure(409, { code: "LIMIT_EXCEEDED" }).kind).toBe("limit");
    expect(classifyHttpFailure(404, {}).kind).toBe("not_found");
    expect(classifyHttpFailure(500, {}).kind).toBe("server");
    expect(classifyHttpFailure(418, {}).kind).toBe("unknown");
    expect(classifyHttpFailure(429, {}).kind).toBe("rate_limited");
    expect(classifyHttpFailure(429, { code: "AI_RATE_LIMITED" }).kind).toBe("rate_limited");
  });

  it("no answer at all is 'network' — whatever the platform calls it", () => {
    for (const err of [new TypeError("Network request failed"), new Error("Failed to fetch"), new Error("The request timed out"), Object.assign(new Error("x"), { name: "AbortError" }), "network error"]) {
      expect(isTransportError(err), String(err)).toBe(true);
      expect(classifyApiFailure(err).kind).toBe("network");
    }
    expect(classifyApiFailure(new Error("something odd")).kind).toBe("unknown");
    expect(classifyApiFailure(undefined).kind).toBe("unknown");
  });

  it("an answer that could not be parsed (a Wi-Fi sign-in page) is a server problem, not a success and not the user's fault", () => {
    expect(classifyApiFailure(Object.assign(new Error("Failed to parse"), { name: "ResponseParseError", status: 200 }))).toEqual({ kind: "server", status: 200, code: null, serverMessage: null });
  });

  it("only a lost connection or an ended session makes a form's data be kept for later", () => {
    expect(lostConnectionOrSession(new TypeError("Network request failed"))).toBe(true);
    expect(lostConnectionOrSession({ status: 401 })).toBe(true);
    for (const status of [400, 403, 409, 422, 500]) expect(lostConnectionOrSession({ status }), String(status)).toBe(false);
  });

  it("every kind maps to an existing sentence for scanning and for the Assistant, in both languages", () => {
    for (const kind of ALL_KINDS) {
      for (const key of [scanFailureKey(kind), assistantFailureKey(kind)]) {
        expect(typeof text(key).en, `${kind} → ${key} (en)`).toBe("string");
        expect(typeof text(key).ar, `${kind} → ${key} (ar)`).toBe("string");
      }
    }
  });

  it("the Assistant offers Retry only where trying again can help", () => {
    const noRetry = ALL_KINDS.filter((k) => !assistantCanRetry(k)).sort();
    expect(noRetry).toEqual(["ai_budget", "ai_disabled", "ai_not_configured", "not_entitled", "permission", "session_expired"]);
    expect(canRetrySend("network")).toBe(true);
    expect(canRetrySend("ai_unavailable")).toBe(true);
    expect(canRetrySend("session_expired")).toBe(false);
    expect(canRetrySend("budget_exceeded")).toBe(false);
  });

  it("a failed action on an existing scan keeps that action's own wording unless the cause is one the user can act on", () => {
    const fallback = "scanReview.replaceErrorBody";
    for (const err of [{ status: 500 }, { status: 502, data: { error: "Image replaced, but the card could not be read. Try Reprocess OCR." } }, { status: 404 }, new Error("odd")]) {
      expect(scanActionFailureKey(err, fallback)).toBe(fallback);
    }
    expect(scanActionFailureKey(new TypeError("Network request failed"), fallback)).toBe("capture.errNetwork");
    expect(scanActionFailureKey({ status: 401 }, fallback)).toBe("capture.errAuth");
    expect(scanActionFailureKey({ status: 422, data: { code: "SCAN_NO_CARD" } }, fallback)).toBe("capture.errNoCard");
    expect(scanActionFailureKey({ status: 429, data: { code: "AI_BUDGET_EXCEEDED" } }, fallback)).toBe("capture.errBudget");
  });
});
