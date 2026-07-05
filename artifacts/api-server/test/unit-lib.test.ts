import { describe, it, expect } from "vitest";
import { parseListQuery } from "../src/lib/list-query.js";
import { mergePermissions, findInvalidPermission, PERMISSION_CATALOG } from "../src/lib/rbac.js";
import { sha256, randomToken, safeEqual, encryptSecret, decryptSecret } from "../src/lib/crypto.js";
import {
  generateBackupCodes,
  normalizeBackupCode,
  hashBackupCode,
  verifyTotp,
} from "../src/lib/mfa.js";
import { neutralizeCell } from "../src/lib/export-generate.js";

// Pure-function unit coverage (no DB, no live API). These lock the input-normalization
// and crypto/MFA seams that the integration suites exercise only indirectly.

describe("parseListQuery — pagination is opt-in and hardened", () => {
  it("returns full-set defaults (paginated=false) when no paging params are present", () => {
    const lq = parseListQuery({});
    expect(lq.paginated).toBe(false);
    expect(lq.page).toBe(1);
    expect(lq.offset).toBe(0);
    expect(lq.pageSize).toBeGreaterThan(0);
    expect(lq.order).toBe("desc");
  });

  it("flags paginated=true when page, pageSize, or limit is supplied", () => {
    expect(parseListQuery({ page: "2" }).paginated).toBe(true);
    expect(parseListQuery({ pageSize: "10" }).paginated).toBe(true);
    expect(parseListQuery({ limit: "10" }).paginated).toBe(true);
  });

  it("computes a 1-based offset from page and pageSize", () => {
    const lq = parseListQuery({ page: "3", pageSize: "20" });
    expect(lq.page).toBe(3);
    expect(lq.pageSize).toBe(20);
    expect(lq.limit).toBe(20);
    expect(lq.offset).toBe(40);
  });

  it("clamps an over-cap pageSize to maxPageSize and a sub-1 page to 1", () => {
    const lq = parseListQuery({ page: "-5", limit: "99999" }, { maxPageSize: 200 });
    expect(lq.pageSize).toBe(200);
    expect(lq.page).toBe(1);
  });

  it("falls back to the default size on a non-numeric limit (and treats it as unpaginated)", () => {
    const lq = parseListQuery({ limit: "abc" }, { defaultPageSize: 25 });
    expect(lq.pageSize).toBe(25);
    // A junk limit parses to undefined → no real paging param was supplied.
    expect(lq.paginated).toBe(false);
  });

  it("honors the sort allowlist and ignores a disallowed sort key", () => {
    const opts = { allowedSort: ["createdAt", "name"], defaultSort: "createdAt" };
    expect(parseListQuery({ sort: "name" }, opts).sort).toBe("name");
    expect(parseListQuery({ sort: "dropTable" }, opts).sort).toBe("createdAt");
  });

  it("defaults order to desc but accepts asc", () => {
    expect(parseListQuery({ order: "asc" }).order).toBe("asc");
    expect(parseListQuery({ order: "ASC" }).order).toBe("asc");
    expect(parseListQuery({ order: "whatever" }).order).toBe("desc");
  });

  it("accepts both q and search aliases for the search term", () => {
    expect(parseListQuery({ q: "alice" }).search).toBe("alice");
    expect(parseListQuery({ search: "bob" }).search).toBe("bob");
    expect(parseListQuery({ q: "  " }).search).toBeUndefined();
  });

  it("takes the first value when a param is repeated (array)", () => {
    const lq = parseListQuery({ page: ["2", "9"] });
    expect(lq.page).toBe(2);
  });
});

describe("rbac permission helpers", () => {
  it("merges two matrices into a deduped union", () => {
    const merged = mergePermissions(
      { contacts: ["view", "create"] },
      { contacts: ["create", "edit"], leads: ["view"] },
    );
    expect(new Set(merged.contacts)).toEqual(new Set(["view", "create", "edit"]));
    expect(merged.leads).toEqual(["view"]);
  });

  it("tolerates undefined/empty inputs", () => {
    // @ts-expect-error — exercising the runtime null-guard
    expect(mergePermissions(undefined, { leads: ["view"] })).toEqual({ leads: ["view"] });
    expect(mergePermissions({}, {})).toEqual({});
  });

  it("findInvalidPermission returns the offending pair and null when all are valid", () => {
    expect(findInvalidPermission([{ module: "contacts", action: "view" }])).toBeNull();
    expect(findInvalidPermission([{ module: "contacts", action: "fly" }])).toEqual({ module: "contacts", action: "fly" });
    expect(findInvalidPermission([{ module: "nope", action: "view" }])).toEqual({ module: "nope", action: "view" });
  });

  it("every catalog action is internally consistent (non-empty actions)", () => {
    for (const [, def] of Object.entries(PERMISSION_CATALOG)) {
      expect(def.actions.length).toBeGreaterThan(0);
      expect(def.label).toBeTruthy();
    }
  });
});

describe("crypto primitives", () => {
  it("sha256 is deterministic and hex-encoded", () => {
    expect(sha256("hello")).toBe(sha256("hello"));
    expect(sha256("hello")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256("hello")).not.toBe(sha256("world"));
  });

  it("randomToken yields unique base64url values of the requested length", () => {
    const a = randomToken(16);
    const b = randomToken(16);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("safeEqual is true for equal strings, false for differing or length-mismatched", () => {
    expect(safeEqual("abc123", "abc123")).toBe(true);
    expect(safeEqual("abc123", "abc124")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });

  it("encryptSecret/decryptSecret round-trips and a tampered payload throws", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const enc = encryptSecret(secret);
    expect(enc).not.toContain(secret);
    expect(decryptSecret(enc)).toBe(secret);
    const [iv, tag, data] = enc.split(".");
    const tampered = [iv, tag, data.slice(0, -2) + "AA"].join(".");
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

describe("mfa backup codes + TOTP guard", () => {
  it("generates the requested count of XXXXX-XXXXX codes", () => {
    const codes = generateBackupCodes(8);
    expect(codes).toHaveLength(8);
    for (const c of codes) expect(c).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  });

  it("normalizes (strips hyphens/space, uppercases) and hashes consistently", () => {
    expect(normalizeBackupCode(" abcde-12345 ")).toBe("ABCDE12345");
    expect(hashBackupCode("abcde-12345")).toBe(hashBackupCode("ABCDE12345"));
    expect(hashBackupCode("abcde-12345")).toBe(sha256("ABCDE12345"));
  });

  it("verifyTotp rejects non 6-digit input without throwing", async () => {
    const secret = "JBSWY3DPEHPK3PXP";
    expect(await verifyTotp(secret, "12")).toBe(false);
    expect(await verifyTotp(secret, "abcdef")).toBe(false);
    expect(await verifyTotp(secret, "1234567")).toBe(false);
    // A well-formed but (almost certainly) wrong code still resolves to a boolean.
    expect(typeof (await verifyTotp(secret, "000000"))).toBe("boolean");
  });
});

describe("neutralizeCell — CSV/Excel formula injection defense", () => {
  it("prefixes a single quote to cells that begin with a formula trigger", () => {
    expect(neutralizeCell("=1+1")).toBe("'=1+1");
    expect(neutralizeCell("+cmd")).toBe("'+cmd");
    expect(neutralizeCell("-2")).toBe("'-2");
    expect(neutralizeCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(neutralizeCell("\t=1")).toBe("'\t=1");
    expect(neutralizeCell("\r=1")).toBe("'\r=1");
    // The classic exfiltration payload must be neutralized, not executed.
    expect(neutralizeCell('=HYPERLINK("http://evil","x")')).toBe('\'=HYPERLINK("http://evil","x")');
  });

  it("leaves ordinary values untouched", () => {
    expect(neutralizeCell("John Doe")).toBe("John Doe");
    expect(neutralizeCell("john@example.com")).toBe("john@example.com");
    expect(neutralizeCell("Acme, Inc. (2 + 2)")).toBe("Acme, Inc. (2 + 2)");
    expect(neutralizeCell("")).toBe("");
    expect(neutralizeCell("123")).toBe("123");
  });
});
