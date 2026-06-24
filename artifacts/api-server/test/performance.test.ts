import { describe, it, expect, beforeAll } from "vitest";
import { convertCurrency, FX_RATES_TO_USD } from "../src/lib/currency.js";

// Phase 2.9 — performance optimization. Pure-function coverage for the new
// server-side currency normalization, plus LIVE-API checks (against localhost:80,
// api-server workflow + seeded demo tenants) for the N+1 grouped-query response
// shapes, the analytics micro-cache (HIT/MISS + bust-on-write), and compression.

const ROOT = "http://localhost:80";
const BASE = `${ROOT}/api`;
const TECHCORP = { email: "admin@techcorp.com", password: "Admin123!" };

async function login(creds = TECHCORP): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return (await res.json()).token;
}

describe("currency conversion (USD base) — convert-before-sum primitive", () => {
  it("is a no-op for same currency (case-insensitive)", () => {
    expect(convertCurrency(100, "USD", "USD")).toBe(100);
    expect(convertCurrency(100, "usd", "USD")).toBe(100);
    expect(convertCurrency(250.5, "SAR", "sar")).toBe(250.5);
  });

  it("converts a pegged currency to USD via its rate", () => {
    // 375 SAR / 3.75 = 100 USD
    expect(convertCurrency(375, "SAR", "USD")).toBeCloseTo(100, 6);
    // 367.25 AED / 3.6725 = 100 USD
    expect(convertCurrency(367.25, "AED", "USD")).toBeCloseTo(100, 6);
  });

  it("round-trips USD -> currency -> USD", () => {
    for (const cur of Object.keys(FX_RATES_TO_USD)) {
      const inCur = convertCurrency(100, "USD", cur);
      expect(convertCurrency(inCur, cur, "USD")).toBeCloseTo(100, 6);
    }
  });

  it("treats unknown currencies as 1:1 with USD (no throw)", () => {
    expect(convertCurrency(100, "ZZZ", "USD")).toBe(100);
    expect(convertCurrency(100, "USD", "ZZZ")).toBe(100);
  });

  it("coerces non-finite values to 0 so one bad row can't poison a total", () => {
    expect(convertCurrency(NaN, "SAR", "USD")).toBe(0);
    expect(convertCurrency(Infinity, "EUR", "USD")).toBe(0);
  });

  it("a mixed-currency basket sums correctly only after per-row conversion", () => {
    // 100 USD + 375 SAR(=100 USD) + 92 EUR(=100 USD) = 300 USD; naive raw sum
    // would be 567 and is wrong.
    const rows = [
      { value: 100, currency: "USD" },
      { value: 375, currency: "SAR" },
      { value: 92, currency: "EUR" },
    ];
    const total = rows.reduce((s, r) => s + convertCurrency(r.value, r.currency, "USD"), 0);
    expect(total).toBeCloseTo(300, 6);
    const rawSum = rows.reduce((s, r) => s + r.value, 0);
    expect(rawSum).not.toBeCloseTo(300, 6);
  });
});

describe("live API — grouped report shapes, micro-cache, compression", () => {
  let token: string;
  beforeAll(async () => {
    token = await login();
  });
  const auth = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

  it("leads-by-event returns the unchanged array shape with numeric counts", async () => {
    const res = await fetch(`${BASE}/reports/leads-by-event`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const row of body) {
      expect(row).toHaveProperty("eventId");
      expect(row).toHaveProperty("eventName");
      expect(typeof row.leadCount).toBe("number");
      expect(typeof row.wonCount).toBe("number");
      expect(typeof row.conversionRate).toBe("number");
      expect(typeof row.createdAt).toBe("string");
    }
  });

  it("team-performance returns the unchanged array shape with numeric counts", async () => {
    const res = await fetch(`${BASE}/reports/team-performance`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const row of body) {
      expect(row).toHaveProperty("userId");
      expect(row).toHaveProperty("userName");
      expect(typeof row.scanCount).toBe("number");
      expect(typeof row.leadCount).toBe("number");
      expect(typeof row.wonCount).toBe("number");
    }
  });

  it("pipeline returns finite USD-normalized totals (totalValue >= displayed open buckets)", async () => {
    const res = await fetch(`${BASE}/leads/pipeline`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.stages)).toBe(true);
    expect(Number.isFinite(body.totalValue)).toBe(true);
    for (const s of body.stages) expect(Number.isFinite(s.value)).toBe(true);
    // totalValue sums ALL open leads; the displayed buckets only cover the named
    // pipeline stages, so the bucket sum is a subset (<=) of totalValue.
    const openBucketSum = body.stages
      .filter((s: { stage: string }) => s.stage !== "won" && s.stage !== "lost")
      .reduce((sum: number, s: { value: number }) => sum + s.value, 0);
    expect(body.totalValue).toBeGreaterThanOrEqual(openBucketSum - 1e-6);
  });

  it("mobile-dashboard returns numeric USD-normalized totals", async () => {
    const res = await fetch(`${BASE}/reports/mobile-dashboard`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.pipelineValue).toBe("number");
    expect(typeof body.wonValue).toBe("number");
    expect(typeof body.lostValue).toBe("number");
    expect(Number.isFinite(body.pipelineValue)).toBe(true);
  });

  it("analytics GETs are micro-cached and busted by a successful write", async () => {
    // A write first to guarantee a fresh cache epoch for the assertions below.
    const seed = await fetch(`${BASE}/contacts`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ firstName: "Perf", lastName: "Seed", fullName: "Perf Seed" }),
    });
    expect(seed.status).toBe(201);
    const seedId = (await seed.json())?.id;

    const first = await fetch(`${BASE}/reports/scan-activity`, { headers: auth() });
    expect(first.status).toBe(200);
    expect(first.headers.get("x-cache")).toBe("MISS");

    const second = await fetch(`${BASE}/reports/scan-activity`, { headers: auth() });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBe("HIT");

    // A successful write bumps the global write epoch → next read misses again.
    const seed2 = await fetch(`${BASE}/contacts`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ firstName: "Perf", lastName: "Bust", fullName: "Perf Bust" }),
    });
    expect(seed2.status).toBe(201);
    const seed2Id = (await seed2.json())?.id;

    const third = await fetch(`${BASE}/reports/scan-activity`, { headers: auth() });
    expect(third.status).toBe(200);
    expect(third.headers.get("x-cache")).toBe("MISS");

    // cleanup
    if (seedId) await fetch(`${BASE}/contacts/${seedId}`, { method: "DELETE", headers: auth() });
    if (seed2Id) await fetch(`${BASE}/contacts/${seed2Id}`, { method: "DELETE", headers: auth() });
  });

  it("compresses compressible JSON responses (Vary: Accept-Encoding negotiated)", async () => {
    const res = await fetch(`${BASE}/contacts`, {
      headers: { ...auth(), "Accept-Encoding": "gzip, deflate, br" },
    });
    expect(res.status).toBe(200);
    const vary = res.headers.get("vary") ?? "";
    expect(vary.toLowerCase()).toContain("accept-encoding");
  });
});
