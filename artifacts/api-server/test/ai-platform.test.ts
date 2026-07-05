import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  aiSettingsTable,
  aiInvocationsTable,
} from "@workspace/db";

// Stage 5.0 — AI Platform Foundation. Exercises the /ai endpoints against the
// LIVE API (localhost:80): effective-settings defaults, primary_admin-only
// PATCH (RBAC), per-feature flag persistence, usage aggregation + cost, provider
// health, cross-tenant isolation of the invocation ledger, and the platform-owner
// tenant firewall (platform_owner blocked from tenant AI reads, allowed on the
// platform aggregate). All fixtures live under throwaway tenants torn down in
// afterAll so demo accounts are untouched.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const DOMAIN = `aiqa-${SUFFIX}.test`;
const DOMAIN_B = `aiqab-${SUFFIX}.test`;
const ADMIN_EMAIL = `qa-admin@${DOMAIN}`;
const EMP_EMAIL = `qa-emp@${DOMAIN}`;
const ADMIN_B_EMAIL = `qa-admin@${DOMAIN_B}`;

let companyId = 0;
let companyBId = 0;
let platformToken = "";
let adminToken = "";
let empToken = "";
let adminBToken = "";

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function loginToken(creds: { email: string; password: string }): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (await res.json()).token;
}

async function api(method: string, path: string, token: string, body?: unknown) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: headers(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createUser(token: string, email: string, name: string, role: string, companyForPlatform?: number): Promise<number> {
  const payload: Record<string, unknown> = { email, name, role, password: PW };
  if (companyForPlatform != null) payload.companyId = companyForPlatform;
  const res = await api("POST", "/users", token, payload);
  expect(res.status, `create user ${email}`).toBe(201);
  return (await res.json()).id;
}

beforeAll(async () => {
  let health: Response;
  try {
    health = await fetch(`${BASE}/healthz`);
  } catch (err) {
    throw new Error(`API not reachable at ${BASE} — is the api-server workflow running? (${String(err)})`);
  }
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);

  platformToken = await loginToken(PLATFORM);

  // --- Tenant A ---
  const createCo = await api("POST", "/companies", platformToken, { name: `QA AI ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  await createUser(platformToken, ADMIN_EMAIL, "QA AI Admin", "primary_admin", companyId);
  adminToken = await loginToken({ email: ADMIN_EMAIL, password: PW });
  await createUser(adminToken, EMP_EMAIL, "QA AI Emp", "employee");
  empToken = await loginToken({ email: EMP_EMAIL, password: PW });

  // --- Tenant B (cross-tenant isolation) ---
  const createCoB = await api("POST", "/companies", platformToken, { name: `QA AI B ${SUFFIX}`, plan: "professional" });
  expect(createCoB.status).toBe(201);
  companyBId = (await createCoB.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyBId));
  await createUser(platformToken, ADMIN_B_EMAIL, "QA AI Admin B", "primary_admin", companyBId);
  adminBToken = await loginToken({ email: ADMIN_B_EMAIL, password: PW });

  // Seed the invocation ledger directly for deterministic usage/cost math.
  // Tenant A: 2 card_extraction successes + 1 lead_scoring error.
  await db.insert(aiInvocationsTable).values([
    { companyId, feature: "card_extraction", provider: "gemini", model: "test", status: "success", inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCostMicroUsd: 2000, latencyMs: 400 },
    { companyId, feature: "card_extraction", provider: "gemini", model: "test", status: "success", inputTokens: 200, outputTokens: 60, totalTokens: 260, estimatedCostMicroUsd: 3000, latencyMs: 600 },
    { companyId, feature: "lead_scoring", provider: "gemini", model: "test", status: "error", inputTokens: 50, outputTokens: 0, totalTokens: 50, estimatedCostMicroUsd: 500, latencyMs: 200, errorMessage: "boom" },
  ]);
  // Tenant B: 1 contact_enrichment success (must NOT appear in tenant A reads).
  await db.insert(aiInvocationsTable).values([
    { companyId: companyBId, feature: "contact_enrichment", provider: "gemini", model: "test", status: "success", inputTokens: 10, outputTokens: 10, totalTokens: 20, estimatedCostMicroUsd: 999999, latencyMs: 100 },
  ]);
});

afterAll(async () => {
  for (const cid of [companyId, companyBId]) {
    if (!cid) continue;
    await db.delete(aiInvocationsTable).where(eq(aiInvocationsTable.companyId, cid));
    await db.delete(aiSettingsTable).where(eq(aiSettingsTable.companyId, cid));
    await db.delete(usersTable).where(eq(usersTable.companyId, cid));
    await db.delete(companiesTable).where(eq(companiesTable.id, cid));
  }
});

describe("GET /ai/settings — effective defaults", () => {
  it("returns enabled + all feature flags on for a fresh tenant (zero behavior change)", async () => {
    const res = await api("GET", "/ai/settings", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.companyId).toBe(companyId);
    expect(body.enabled).toBe(true);
    expect(body.hasCustomSettings).toBe(false);
    expect(body.featureFlags.card_extraction).toBe(true);
    expect(body.featureFlags.lead_scoring).toBe(true);
    expect(body.featureFlags.contact_enrichment).toBe(true);
    expect(body.featureFlags.assignee_recommendation).toBe(true);
    expect(Array.isArray(body.availableProviders)).toBe(true);
    expect(body.availableProviders).toContain("gemini");
  });

  it("is readable by a non-manager employee", async () => {
    const res = await api("GET", "/ai/settings", empToken);
    expect(res.status).toBe(200);
  });
});

describe("PATCH /ai/settings — RBAC + persistence", () => {
  it("403s an employee (primary_admin only)", async () => {
    const res = await api("PATCH", "/ai/settings", empToken, { enabled: false });
    expect(res.status).toBe(403);
  });

  it("lets a primary_admin toggle a feature flag and a budget", async () => {
    const res = await api("PATCH", "/ai/settings", adminToken, {
      featureFlags: { contact_enrichment: false },
      monthlyCostBudgetUsd: 25,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasCustomSettings).toBe(true);
    expect(body.featureFlags.contact_enrichment).toBe(false);
    expect(body.featureFlags.card_extraction).toBe(true); // unchanged flags preserved
    expect(body.monthlyCostBudgetUsd).toBe(25);
  });

  it("persists across a subsequent GET", async () => {
    const res = await api("GET", "/ai/settings", adminToken);
    const body = await res.json();
    expect(body.featureFlags.contact_enrichment).toBe(false);
    expect(body.monthlyCostBudgetUsd).toBe(25);
  });

  it("400s an unknown feature flag", async () => {
    const res = await api("PATCH", "/ai/settings", adminToken, { featureFlags: { nope: true } });
    expect(res.status).toBe(400);
  });

  it("400s a negative budget", async () => {
    const res = await api("PATCH", "/ai/settings", adminToken, { monthlyTokenBudget: -1 });
    expect(res.status).toBe(400);
  });
});

describe("GET /ai/usage — aggregation, cost & tenant isolation", () => {
  it("aggregates the tenant's own invocations only", async () => {
    const res = await api("GET", "/ai/usage", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totals.requests).toBe(3);
    expect(body.totals.success).toBe(2);
    expect(body.totals.errors).toBe(1);
    expect(body.totals.totalTokens).toBe(460);
    // 2000 + 3000 + 500 micro-USD = 5500 → 0.0055 USD
    expect(body.totals.costUsd).toBeCloseTo(0.0055, 6);
    const features = body.byFeature.map((f: { feature: string }) => f.feature).sort();
    expect(features).toEqual(["card_extraction", "lead_scoring"]);
    // Tenant B's contact_enrichment must not leak in.
    expect(features).not.toContain("contact_enrichment");
  });

  it("does not expose tenant A data to tenant B", async () => {
    const res = await api("GET", "/ai/usage", adminBToken);
    const body = await res.json();
    expect(body.totals.requests).toBe(1);
    expect(body.byFeature[0].feature).toBe("contact_enrichment");
  });
});

describe("GET /ai/health", () => {
  it("returns provider config + recent reliability for the tenant", async () => {
    const res = await api("GET", "/ai/health", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe("gemini");
    expect(typeof body.configured).toBe("boolean");
    expect(typeof body.status).toBe("string");
    expect(body.last24h).toBeDefined();
    expect(body.last24h.requests).toBeGreaterThanOrEqual(3);
  });
});

describe("Platform-owner tenant firewall", () => {
  it("blocks platform_owner from tenant AI settings/usage/health", async () => {
    expect((await api("GET", "/ai/settings", platformToken)).status).toBe(403);
    expect((await api("GET", "/ai/usage", platformToken)).status).toBe(403);
    expect((await api("GET", "/ai/health", platformToken)).status).toBe(403);
  });

  it("allows platform_owner on the platform-wide aggregate", async () => {
    const res = await api("GET", "/ai/platform/usage", platformToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totals.requests).toBeGreaterThanOrEqual(4);
    const names = body.byCompany.map((c: { companyName: string | null }) => c.companyName);
    expect(names).toContain(`QA AI ${SUFFIX}`);
    expect(names).toContain(`QA AI B ${SUFFIX}`);
  });

  it("403s a tenant admin on the platform aggregate", async () => {
    const res = await api("GET", "/ai/platform/usage", adminToken);
    expect(res.status).toBe(403);
  });
});
