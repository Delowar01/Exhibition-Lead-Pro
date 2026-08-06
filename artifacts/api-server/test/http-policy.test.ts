import { describe, it, expect, afterAll } from "vitest";
import express from "express";
import cors from "cors";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  parseTrustProxy,
  parseCorsOrigins,
  resolveCorsOrigin,
  buildCorsOptions,
} from "../src/lib/httpPolicy.js";

// Export-readiness — portable HTTP edge policy. Unit-tests the CORS_ORIGINS /
// TRUST_PROXY parsing contract, then boots minimal express apps on ephemeral
// ports to verify the real middleware behavior: which origins receive
// Access-Control-Allow-Origin, and how `trust proxy` hop counts change req.ip
// attribution from X-Forwarded-For. No shared app state, no rate limiters, no
// DB — safe to run inside the full suite.

describe("parseTrustProxy", () => {
  it("defaults to exactly one trusted hop when unset or blank", () => {
    expect(parseTrustProxy(undefined)).toBe(1);
    expect(parseTrustProxy("")).toBe(1);
    expect(parseTrustProxy("   ")).toBe(1);
  });

  it("parses integer hop counts", () => {
    expect(parseTrustProxy("0")).toBe(0);
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy(" 3 ")).toBe(3);
  });

  it("parses booleans case-insensitively", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("TRUE")).toBe(true);
    expect(parseTrustProxy("false")).toBe(false);
  });

  it("accepts valid subnet / named-subnet lists (normalized)", () => {
    expect(parseTrustProxy("loopback")).toBe("loopback");
    expect(parseTrustProxy("10.0.0.0/8, 172.16.0.0/12")).toBe("10.0.0.0/8, 172.16.0.0/12");
    expect(parseTrustProxy("10.0.0.0/8,172.16.0.0/12")).toBe("10.0.0.0/8, 172.16.0.0/12");
    expect(parseTrustProxy("192.168.1.7")).toBe("192.168.1.7");
    expect(parseTrustProxy("::1")).toBe("::1");
    expect(parseTrustProxy("fd00::/8")).toBe("fd00::/8");
  });

  it("FAILS CLOSED on malformed values instead of handing them to express", () => {
    // Negative / fractional hop counts are not valid and must not be
    // reinterpreted as subnet strings.
    expect(() => parseTrustProxy("-1")).toThrow(/Invalid TRUST_PROXY/);
    expect(() => parseTrustProxy("1.5")).toThrow(/Invalid TRUST_PROXY/);
    // Garbage / typo'd subnets abort startup rather than producing a silent
    // mis-attributing trust policy.
    expect(() => parseTrustProxy("yes")).toThrow(/Invalid TRUST_PROXY/);
    expect(() => parseTrustProxy("loopbck")).toThrow(/Invalid TRUST_PROXY/);
    expect(() => parseTrustProxy("10.0.0.256/8")).toThrow(/Invalid TRUST_PROXY/);
    expect(() => parseTrustProxy("10.0.0.0/33")).toThrow(/Invalid TRUST_PROXY/);
    expect(() => parseTrustProxy("10.0.0.0/8, banana")).toThrow(/Invalid TRUST_PROXY/);
  });
});

describe("parseCorsOrigins", () => {
  it("returns null when unset or blank (environment default applies)", () => {
    expect(parseCorsOrigins(undefined)).toBeNull();
    expect(parseCorsOrigins("")).toBeNull();
    expect(parseCorsOrigins("  ")).toBeNull();
    expect(parseCorsOrigins(" , ,")).toBeNull();
  });

  it("recognizes the explicit wildcard", () => {
    expect(parseCorsOrigins("*")).toBe("*");
  });

  it("splits, trims, and normalizes trailing slashes on origin lists", () => {
    expect(parseCorsOrigins("https://app.example.com")).toEqual(["https://app.example.com"]);
    expect(
      parseCorsOrigins(" https://app.example.com/ , https://admin.example.com "),
    ).toEqual(["https://app.example.com", "https://admin.example.com"]);
  });
});

describe("resolveCorsOrigin", () => {
  it("explicit wildcard always wins", () => {
    expect(resolveCorsOrigin("*", true)).toBe("*");
    expect(resolveCorsOrigin("*", false)).toBe("*");
  });

  it("explicit allow-list always wins", () => {
    expect(resolveCorsOrigin(["https://a.example"], true)).toEqual(["https://a.example"]);
    expect(resolveCorsOrigin(["https://a.example"], false)).toEqual(["https://a.example"]);
  });

  it("unset: development stays open, production emits no CORS", () => {
    expect(resolveCorsOrigin(null, false)).toBe("*");
    expect(resolveCorsOrigin(null, true)).toBe(false);
  });
});

describe("buildCorsOptions", () => {
  it("enables credentials only for an explicit allow-list", () => {
    expect(buildCorsOptions(["https://a.example"])).toEqual({
      origin: ["https://a.example"],
      credentials: true,
    });
    expect(buildCorsOptions("*")).toEqual({ origin: "*" });
    expect(buildCorsOptions(false)).toEqual({ origin: false });
  });
});

// ---------------------------------------------------------------------------
// Middleware-level behavior on live ephemeral servers
// ---------------------------------------------------------------------------

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function corsApp(rawOrigins: string | undefined, isProduction: boolean): express.Express {
  const app = express();
  app.use(cors(buildCorsOptions(resolveCorsOrigin(parseCorsOrigins(rawOrigins), isProduction))));
  app.get("/ping", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("CORS middleware behavior (live server)", () => {
  it("allow-list: configured origin is reflected with credentials", async () => {
    const base = await listen(corsApp("https://app.example.com", true));
    const res = await fetch(`${base}/ping`, {
      headers: { Origin: "https://app.example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("allow-list: unlisted origin gets NO allow-origin header (browser blocks)", async () => {
    const base = await listen(corsApp("https://app.example.com", true));
    const res = await fetch(`${base}/ping`, {
      headers: { Origin: "https://evil.example.com" },
    });
    // The request itself completes (CORS is a browser-side gate) but no
    // Access-Control-Allow-Origin is emitted, so a browser refuses the read.
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allow-list: preflight from an unlisted origin is not approved", async () => {
    const base = await listen(corsApp("https://app.example.com", true));
    const res = await fetch(`${base}/ping`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("unset + production: no origin is ever approved", async () => {
    const base = await listen(corsApp(undefined, true));
    const res = await fetch(`${base}/ping`, {
      headers: { Origin: "https://app.example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("unset + development: every origin is allowed via wildcard (historical behavior)", async () => {
    const base = await listen(corsApp(undefined, false));
    const res = await fetch(`${base}/ping`, {
      headers: { Origin: "https://anything.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("explicit wildcard in production restores the open behavior", async () => {
    const base = await listen(corsApp("*", true));
    const res = await fetch(`${base}/ping`, {
      headers: { Origin: "https://anything.example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("trust proxy behavior (live server)", () => {
  function ipApp(trustProxyRaw: string | undefined): express.Express {
    const app = express();
    app.set("trust proxy", parseTrustProxy(trustProxyRaw));
    app.get("/ip", (req, res) => res.json({ ip: req.ip }));
    return app;
  }

  it("default (1 hop): req.ip is the LAST X-Forwarded-For entry — forged prefixes are discarded", async () => {
    const base = await listen(ipApp(undefined));
    const res = await fetch(`${base}/ip`, {
      headers: { "X-Forwarded-For": "6.6.6.6, 203.0.113.9" },
    });
    const body = (await res.json()) as { ip: string };
    expect(body.ip).toBe("203.0.113.9");
  });

  it("TRUST_PROXY=2: req.ip is the second-to-last entry (real client behind 2 proxies)", async () => {
    const base = await listen(ipApp("2"));
    const res = await fetch(`${base}/ip`, {
      headers: { "X-Forwarded-For": "6.6.6.6, 198.51.100.7, 203.0.113.9" },
    });
    const body = (await res.json()) as { ip: string };
    expect(body.ip).toBe("198.51.100.7");
  });

  it("TRUST_PROXY=false: X-Forwarded-For is ignored entirely (direct exposure)", async () => {
    const base = await listen(ipApp("false"));
    const res = await fetch(`${base}/ip`, {
      headers: { "X-Forwarded-For": "6.6.6.6" },
    });
    const body = (await res.json()) as { ip: string };
    expect(body.ip).toContain("127.0.0.1");
  });

  it("subnet trust boundary: a trusted-subnet peer's XFF is honored up to the first untrusted hop", async () => {
    // Server peer is 127.0.0.1, which IS in `loopback`: the last XFF entry
    // (203.0.113.9) is untrusted, so it becomes req.ip; the forged prefix
    // (6.6.6.6) beyond the untrusted hop is discarded.
    const base = await listen(ipApp("loopback"));
    const res = await fetch(`${base}/ip`, {
      headers: { "X-Forwarded-For": "6.6.6.6, 203.0.113.9" },
    });
    const body = (await res.json()) as { ip: string };
    expect(body.ip).toBe("203.0.113.9");
  });

  it("subnet trust boundary: a peer OUTSIDE the trusted subnet cannot spoof via XFF", async () => {
    // Server peer is 127.0.0.1, which is NOT in 10.0.0.0/8: XFF is ignored
    // entirely and req.ip is the direct socket address — spoofing prevented.
    const base = await listen(ipApp("10.0.0.0/8"));
    const res = await fetch(`${base}/ip`, {
      headers: { "X-Forwarded-For": "6.6.6.6" },
    });
    const body = (await res.json()) as { ip: string };
    expect(body.ip).toContain("127.0.0.1");
  });
});
