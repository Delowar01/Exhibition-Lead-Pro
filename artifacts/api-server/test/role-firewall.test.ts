// Server-side role firewall — the direction NOT previously covered:
// a tenant (customer) user calling /platform/* must get 403 regardless of
// what the SPA renders. (The reverse direction — platform_owner fenced off
// tenant CRM with 403 — is already covered by tenant-isolation-matrix.)
import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://localhost:80/api";
const TECHCORP = { email: "admin@techcorp.com", password: "Admin123!" };
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };

async function login(creds: { email: string; password: string }): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (await res.json()).token;
}

let tenantToken: string;
let platformToken: string;

beforeAll(async () => {
  [tenantToken, platformToken] = await Promise.all([login(TECHCORP), login(PLATFORM)]);
});

describe("customer users cannot reach /platform/* APIs (403)", () => {
  const PLATFORM_SURFACES = ["/platform/stats", "/platform/revenue-trend", "/platform/activity"];

  it.each(PLATFORM_SURFACES)("tenant primary_admin GET %s → 403", async (path) => {
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${tenantToken}` } });
    expect(res.status).toBe(403);
  });

  it("sanity: platform_owner GET /platform/stats → 200", async () => {
    const res = await fetch(`${BASE}/platform/stats`, { headers: { Authorization: `Bearer ${platformToken}` } });
    expect(res.status).toBe(200);
  });
});
