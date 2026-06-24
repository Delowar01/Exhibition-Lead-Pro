import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://localhost:80/api";

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const TECHCORP = { email: "admin@techcorp.com", password: "Admin123!" };
const INNOVATECH = { email: "admin@innovatech.es", password: "Admin123!" };

async function loginJson(creds: { email: string; password: string }) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return res.json();
}

function authHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

let platformToken: string;
let techcorpToken: string;
let innovatechToken: string;

beforeAll(async () => {
  let health: Response;
  try {
    health = await fetch(`${BASE}/healthz`);
  } catch (err) {
    throw new Error(`API not reachable at ${BASE} — is the api-server workflow running? (${String(err)})`);
  }
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);
  platformToken = (await loginJson(PLATFORM)).token;
  techcorpToken = (await loginJson(TECHCORP)).token;
  innovatechToken = (await loginJson(INNOVATECH)).token;
});

describe("GET /readyz — real dependency probes", () => {
  it("reports a string storage check (real reachability probe, not a stub)", async () => {
    const res = await fetch(`${BASE}/readyz`);
    expect([200, 503]).toContain(res.status);
    const body = await res.json();
    expect(["ok", "error", "not_configured"]).toContain(body.checks?.storage);
    expect(["ok", "error"]).toContain(body.checks?.database);
    // DB is the only hard gate: a 200 means the DB is reachable.
    if (res.status === 200) expect(body.checks.database).toBe("ok");
  });
});

describe("GET /metrics — operational snapshot, platform-owner only", () => {
  it("requires authentication", async () => {
    const res = await fetch(`${BASE}/metrics`);
    expect(res.status).toBe(401);
  });

  it("forbids non-platform roles", async () => {
    const res = await fetch(`${BASE}/metrics`, { headers: authHeaders(techcorpToken) });
    expect(res.status).toBe(403);
  });

  it("returns request + job metrics for platform_owner", async () => {
    const res = await fetch(`${BASE}/metrics`, { headers: authHeaders(platformToken) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(typeof body.timestamp).toBe("string");
    expect(typeof body.requests?.total).toBe("number");
    expect(typeof body.requests?.errorRate).toBe("number");
    expect(body.requests?.byStatusClass).toBeTypeOf("object");
    expect(body.jobs).toBeTypeOf("object");
    expect(typeof body.jobs?.completed).toBe("number");
  });
});

describe("GET /security/audit — searchable, tenant-scoped audit trail", () => {
  it("requires authentication", async () => {
    const res = await fetch(`${BASE}/security/audit`);
    expect(res.status).toBe(401);
  });

  it("returns a paginated envelope", async () => {
    const res = await fetch(`${BASE}/security/audit?pageSize=5`, { headers: authHeaders(techcorpToken) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(5);
    expect(body.items.length).toBeLessThanOrEqual(5);
  });

  it("scopes a company admin to their own tenant only", async () => {
    const res = await fetch(`${BASE}/security/audit?pageSize=100`, { headers: authHeaders(techcorpToken) });
    const body = await res.json();
    const myCompanyIds = new Set(body.items.map((e: { companyId: number | null }) => e.companyId));
    // A company admin must never see a row from another tenant; every row is their company.
    expect(myCompanyIds.has(null)).toBe(false);
    expect(myCompanyIds.size).toBeLessThanOrEqual(1);
  });

  it("honors the action filter", async () => {
    const res = await fetch(`${BASE}/security/audit?action=login&pageSize=20`, { headers: authHeaders(platformToken) });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const entry of body.items) {
      expect(entry.action).toBe("login");
    }
  });

  it("does not let one tenant's view leak into another's", async () => {
    const [tech, innov] = await Promise.all([
      fetch(`${BASE}/security/audit?pageSize=100`, { headers: authHeaders(techcorpToken) }).then((r) => r.json()),
      fetch(`${BASE}/security/audit?pageSize=100`, { headers: authHeaders(innovatechToken) }).then((r) => r.json()),
    ]);
    const techCompanies = new Set(tech.items.map((e: { companyId: number | null }) => e.companyId));
    const innovCompanies = new Set(innov.items.map((e: { companyId: number | null }) => e.companyId));
    for (const c of techCompanies) expect(innovCompanies.has(c)).toBe(false);
  });
});

describe("GET /security/alerts — aggregated suspicious activity", () => {
  it("requires authentication", async () => {
    const res = await fetch(`${BASE}/security/alerts`);
    expect(res.status).toBe(401);
  });

  it("returns aggregate counts for the requested window", async () => {
    const res = await fetch(`${BASE}/security/alerts?windowHours=24`, { headers: authHeaders(platformToken) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.windowHours).toBe(24);
    expect(typeof body.failedLogins).toBe("number");
    expect(typeof body.lockouts).toBe("number");
    expect(typeof body.policyBlocks).toBe("number");
    expect(typeof body.distinctFailedIps).toBe("number");
    expect(typeof body.generatedAt).toBe("string");
    expect(body.failedLogins).toBeGreaterThanOrEqual(0);
  });

  it("clamps the window to a sane range", async () => {
    const res = await fetch(`${BASE}/security/alerts?windowHours=99999`, { headers: authHeaders(platformToken) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.windowHours).toBeLessThanOrEqual(720);
  });

  it("does not widen a company admin's scope via an out-of-scope companyId", async () => {
    // A non-platform admin passing a companyId they cannot access must be folded back to
    // their own accessible scope — i.e. identical to the unparameterized request.
    const [own, spoofed] = await Promise.all([
      fetch(`${BASE}/security/alerts?windowHours=24`, { headers: authHeaders(techcorpToken) }).then((r) => r.json()),
      fetch(`${BASE}/security/alerts?windowHours=24&companyId=999999`, { headers: authHeaders(techcorpToken) }).then((r) => r.json()),
    ]);
    expect(spoofed.failedLogins).toBe(own.failedLogins);
    expect(spoofed.lockouts).toBe(own.lockouts);
    expect(spoofed.policyBlocks).toBe(own.policyBlocks);
    expect(spoofed.distinctFailedIps).toBe(own.distinctFailedIps);
  });
});
