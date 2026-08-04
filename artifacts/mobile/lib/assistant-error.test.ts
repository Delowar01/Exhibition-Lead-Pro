import { describe, expect, it } from "vitest";

import { classifySendError, sendErrorMessageKey } from "./assistant-error";

import ar from "./i18n/locales/ar.json";
import en from "./i18n/locales/en.json";

describe("classifySendError", () => {
  it("classifies connectivity failures as network", () => {
    expect(classifySendError(new TypeError("Network request failed"))).toBe("network");
    expect(classifySendError(new Error("Network request failed"))).toBe("network");
    expect(classifySendError(new Error("Failed to fetch"))).toBe("network");
    expect(classifySendError("network error")).toBe("network");
  });

  it("classifies 401/403 as permission", () => {
    expect(classifySendError({ status: 401, message: "Unauthorized" })).toBe("permission");
    expect(classifySendError({ status: 403, message: "Forbidden" })).toBe("permission");
  });

  it("classifies other HTTP errors as server", () => {
    expect(classifySendError({ status: 500, message: "Internal" })).toBe("server");
    expect(classifySendError({ status: 429, message: "Too many" })).toBe("server");
    expect(classifySendError({ status: 400, message: "Bad request" })).toBe("server");
  });

  it("falls back to server for unknown errors", () => {
    expect(classifySendError(new Error("something odd"))).toBe("server");
    expect(classifySendError(undefined)).toBe("server");
    expect(classifySendError(null)).toBe("server");
    // non-numeric status is not an HTTP error
    expect(classifySendError({ status: "weird" })).toBe("server");
  });

  it("maps every kind to an existing assistant i18n key in EN and AR", () => {
    const kinds = ["network", "permission", "server"] as const;
    for (const kind of kinds) {
      const key = sendErrorMessageKey(kind);
      const [section, leaf] = key.split(".");
      expect(section).toBe("assistant");
      expect((en as unknown as Record<string, Record<string, string>>)[section][leaf]).toBeTruthy();
      expect((ar as unknown as Record<string, Record<string, string>>)[section][leaf]).toBeTruthy();
    }
  });

  it("keeps EN/AR assistant sections in key parity (incl. retry)", () => {
    const enKeys = Object.keys((en as unknown as Record<string, object>).assistant).sort();
    const arKeys = Object.keys((ar as unknown as Record<string, object>).assistant).sort();
    expect(arKeys).toEqual(enKeys);
    expect(enKeys).toContain("retry");
    expect(enKeys).toContain("sendFailed");
    expect(enKeys).toContain("sendFailedNetwork");
    expect(enKeys).toContain("sendFailedPermission");
  });
});
