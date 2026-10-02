// Batch 25 — canonical storage-key grammar. Pure functions, no server, no DB.
// A key is built server-side from validated components; nothing a client sends
// can ever become a path component, and every traversal / separator / encoding
// trick below must be refused.
import { describe, it, expect } from "vitest";
import {
  InvalidStorageKeyError,
  healthKey,
  isValidKeyComponent,
  isValidStorageKey,
  keyBelongsToTenant,
  parseTenantKey,
  tenantKey,
} from "../src/storage/keys.js";

describe("storage keys — components", () => {
  it("accepts plain ASCII names with dots, dashes and underscores", () => {
    for (const ok of ["a", "abc-123", "file_name.txt", "0f3c9a", "x".repeat(128)]) expect(isValidKeyComponent(ok)).toBe(true);
  });

  it("refuses traversal, hidden names, separators, encodings and control bytes", () => {
    for (const bad of ["", ".", "..", ".hidden", "a..b", "a/b", "a\\b", "%2e%2e", "a%2fb", "a\u0000b", "a b", "ünïcode", "x".repeat(129), "-leading", "_leading"]) {
      expect(isValidKeyComponent(bad), bad).toBe(false);
    }
  });
});

describe("storage keys — canonical shapes", () => {
  it("accepts tenant keys for every kind and the health namespace", () => {
    for (const k of [
      "tenants/1/documents/0f3c9a",
      "tenants/42/exports/abc",
      "tenants/42/reports/abc",
      "tenants/42/scans/abc",
      "tenants/42/branding/deadbeef.png",
      "health/probe-1",
    ]) {
      expect(isValidStorageKey(k), k).toBe(true);
    }
  });

  it("refuses absolute paths, traversal, encoded traversal, backslashes, NUL, unknown roots and bad tenants", () => {
    for (const bad of [
      "/tenants/1/documents/x",
      "tenants/1/documents/x/",
      "../x",
      "tenants/1/documents/../../../etc/passwd",
      "tenants/1/documents/..",
      "tenants/1/documents/%2e%2e/%2e%2e/x",
      "tenants\\1\\documents\\x",
      "tenants/1/documents/a\u0000b",
      "tenants/1/documents/.ssh",
      "tenants/0/documents/x",
      "tenants/01/documents/x",
      "tenants/-1/documents/x",
      "tenants/abc/documents/x",
      "tenants/1/unknown/x",
      "tenants/1/documents",
      "tenants/1",
      "health",
      "health/a/b",
      "other/1/documents/x",
      "tenants/1/documents/a/b/c/d",
      "C:/tenants/1/documents/x",
      "",
    ]) {
      expect(isValidStorageKey(bad), bad).toBe(false);
    }
  });
});

describe("storage keys — builders and ownership", () => {
  it("builds tenant-prefixed keys and parses them back", () => {
    const key = tenantKey("document", 7, "0f3c9a-1");
    expect(key).toBe("tenants/7/documents/0f3c9a-1");
    expect(parseTenantKey(key)).toEqual({ companyId: 7, kind: "document", file: "0f3c9a-1" });
    expect(tenantKey("branding_logo", 7, "a".repeat(32), "png")).toBe(`tenants/7/branding/${"a".repeat(32)}.png`);
    expect(healthKey("probe-x")).toBe("health/probe-x");
    expect(parseTenantKey("health/probe-x")).toBeNull();
  });

  it("refuses client-controlled components when building", () => {
    expect(() => tenantKey("document", 7, "../x")).toThrow(InvalidStorageKeyError);
    expect(() => tenantKey("document", 7, "a/b")).toThrow(InvalidStorageKeyError);
    expect(() => tenantKey("document", 0, "abc")).toThrow(InvalidStorageKeyError);
    expect(() => tenantKey("document", 1.5, "abc")).toThrow(InvalidStorageKeyError);
    expect(() => tenantKey("branding_logo", 7, "abc", "p/ng")).toThrow(InvalidStorageKeyError);
    expect(() => tenantKey("branding_logo", 7, "abc", "PNG")).toThrow(InvalidStorageKeyError);
    expect(() => healthKey("../x")).toThrow(InvalidStorageKeyError);
  });

  it("binds a key to exactly one tenant", () => {
    const key = tenantKey("scan_image", 12, "img1");
    expect(keyBelongsToTenant(key, 12)).toBe(true);
    expect(keyBelongsToTenant(key, 13)).toBe(false);
    expect(keyBelongsToTenant("tenants/12/scans/../13/scans/img1", 12)).toBe(false);
    expect(keyBelongsToTenant("health/x", 12)).toBe(false);
  });
});
