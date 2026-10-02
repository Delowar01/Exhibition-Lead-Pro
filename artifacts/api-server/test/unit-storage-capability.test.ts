// Batch 25 — upload / download capability tokens. The token is the ONLY
// credential on the /files routes, so it must be unforgeable, bound to one
// object + tenant + operation, and expire. No server, no DB (config only).
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mintCapability, verifyCapability } from "../src/storage/capability.js";

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const exp = Math.floor(NOW / 1000) + 300;

describe("capability tokens", () => {
  it("round-trips a put and a get capability with their bindings", () => {
    const o = randomUUID();
    const put = mintCapability({ op: "put", o, c: 7, u: 3, exp });
    const got = verifyCapability(put, "put", NOW);
    expect(got).toMatchObject({ v: 1, op: "put", o, c: 7, u: 3, exp });

    const get = mintCapability({ op: "get", o, c: 7, u: null, exp, fn: "report.pdf", d: "inline" });
    expect(verifyCapability(get, "get", NOW)).toMatchObject({ op: "get", o, c: 7, u: null, fn: "report.pdf", d: "inline" });
  });

  it("is bound to the operation", () => {
    const o = randomUUID();
    const put = mintCapability({ op: "put", o, c: 7, u: 3, exp });
    expect(verifyCapability(put, "get", NOW)).toBeNull();
  });

  it("expires", () => {
    const o = randomUUID();
    const t = mintCapability({ op: "get", o, c: 7, u: 3, exp });
    expect(verifyCapability(t, "get", exp * 1000 - 1)).not.toBeNull();
    expect(verifyCapability(t, "get", exp * 1000)).toBeNull();
    expect(verifyCapability(t, "get", exp * 1000 + 60_000)).toBeNull();
  });

  it("rejects a tampered payload (tenant / object swap) and a tampered signature", () => {
    const o = randomUUID();
    const t = mintCapability({ op: "get", o, c: 7, u: 3, exp });
    const [body, sig] = t.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const forged = Buffer.from(JSON.stringify({ ...payload, c: 8 }), "utf8").toString("base64url");
    expect(verifyCapability(`${forged}.${sig}`, "get", NOW)).toBeNull();
    const forgedObj = Buffer.from(JSON.stringify({ ...payload, o: randomUUID() }), "utf8").toString("base64url");
    expect(verifyCapability(`${forgedObj}.${sig}`, "get", NOW)).toBeNull();
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect(verifyCapability(`${body}.${flipped}`, "get", NOW)).toBeNull();
    expect(verifyCapability(`${body}.`, "get", NOW)).toBeNull();
  });

  it("rejects malformed tokens without throwing", () => {
    for (const bad of [undefined, "", "abc", "a.b", "x".repeat(3000), "not-base64!.sig", `${"a".repeat(30)}.${"b".repeat(43)}`]) {
      expect(verifyCapability(bad as string | undefined, "get", NOW)).toBeNull();
    }
  });

  it("rejects payloads with an invalid object id, tenant or disposition even when correctly signed", () => {
    // Mint with bad values the way an internal bug could, then prove verify refuses them.
    const badObj = mintCapability({ op: "get", o: "../../etc/passwd", c: 7, u: 3, exp });
    expect(verifyCapability(badObj, "get", NOW)).toBeNull();
    const badTenant = mintCapability({ op: "get", o: randomUUID(), c: 0, u: 3, exp });
    expect(verifyCapability(badTenant, "get", NOW)).toBeNull();
    const badDisp = mintCapability({ op: "get", o: randomUUID(), c: 1, u: 3, exp, d: "weird" as "inline" });
    expect(verifyCapability(badDisp, "get", NOW)).toBeNull();
  });

  it("never embeds the signing secret or a storage key in the token", () => {
    const o = randomUUID();
    const t = mintCapability({ op: "get", o, c: 7, u: 3, exp, fn: "x.txt" });
    const decoded = Buffer.from(t.split(".")[0], "base64url").toString("utf8");
    expect(decoded).not.toContain("tenants/");
    expect(decoded).not.toContain(process.env.SESSION_SECRET ?? "<unset>");
  });
});
