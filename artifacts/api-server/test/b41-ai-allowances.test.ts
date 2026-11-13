import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import { db, companiesTable, usersTable, contactsTable, auditLogsTable, plansTable, planVersionsTable } from "@workspace/db";
import { runVersionBackfill } from "../src/lib/billing/version-backfill.js";

// Batch 41 (U4) — per-version AI allowances through the EXISTING Enterprise AI
// Layer (stub provider only; no live Gemini call).
//
// A published version may carry an AI token / cost allowance per month. It SEEDS
// the tenant's monthly budget inside the one existing budget gate: an explicit
// tenant override in ai_settings keeps precedence, a plan allowance applies when
// the tenant has none, and a legacy / version-1 tenant keeps "no budget" exactly
// as before. The same reservation-based admission, dedup, ledger and usage
// accounting run unchanged — there is no second budget system.

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b41ai-${SUFFIX}.test`;
const ALLOW = `b41-ai-${SUFFIX}`;

let platformToken = "";
let adminToken = ""; // company A (allowance plan)
let legacyToken = ""; // company L (free v1)
let companyA = 0;
let companyL = 0;
const companyIds: number[] = [];
let allowV1 = 0;
let contactId = 0;

function headers(token: string | null) {
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
async function login(email: string, password = PW): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: headers(null), body: JSON.stringify({ email, password }) });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}
async function api(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: headers(token), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed as Record<string, any>, text };
}
const settings = async (token: string) => (await api("GET", "/ai/settings", token)).body;
async function patchSettings(token: string, patch: Record<string, unknown>) {
  const res = await api("PATCH", "/ai/settings", token, patch);
  expect(res.status, `PATCH /ai/settings ${JSON.stringify(patch)}: ${res.text}`).toBe(200);
  return res.body;
}
const generate = (token: string, tag: string) => api("POST", `/ai/copilot/contact/${contactId}/email`, token, { language: "en", instructions: tag, regenerate: true });
async function createCompany(name: string, plan: string) {
  const res = await api("POST", "/companies", platformToken, { name, plan });
  expect(res.status, res.text).toBe(201);
  companyIds.push(res.body.id);
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, res.body.id));
  return res.body.id as number;
}

beforeAll(async () => {
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  expect((await runVersionBackfill({ apply: true })).verdict).toBe("APPLIED");
  const created = await api("POST", "/platform/plans", platformToken, {
    id: ALLOW,
    name: `AI Allowance ${SUFFIX}`,
    limits: {},
    features: {},
    allowances: { aiTokensPerMonth: 100, aiCostMicroUsdPerMonth: 2_500_000 },
  });
  expect(created.status, created.text).toBe(201);
  allowV1 = created.body.draft.id;
  expect(created.body.draft.allowances).toEqual({ aiTokensPerMonth: 100, aiCostMicroUsdPerMonth: 2_500_000 });
  const published = await api("POST", `/platform/plans/${ALLOW}/versions/${allowV1}/publish`, platformToken);
  expect(published.status, published.text).toBe(200);

  companyA = await createCompany(`QA B41 AI ${SUFFIX}`, ALLOW);
  companyL = await createCompany(`QA B41 AI Legacy ${SUFFIX}`, "free");
  for (const [email, cid] of [
    [`admin@${DOMAIN}`, companyA],
    [`legacy@${DOMAIN}`, companyL],
  ] as const) {
    const res = await api("POST", "/users", platformToken, { email, name: email.split("@")[0], role: "primary_admin", companyId: cid, password: PW });
    expect(res.status, res.text).toBe(201);
  }
  adminToken = await login(`admin@${DOMAIN}`);
  legacyToken = await login(`legacy@${DOMAIN}`);
  // Deterministic stub provider for both tenants (never live Gemini).
  await patchSettings(adminToken, { provider: "stub", model: "stub-model" });
  await patchSettings(legacyToken, { provider: "stub", model: "stub-model" });
  const c = await api("POST", "/contacts", adminToken, { firstName: "Allowance", lastName: "Target", email: `allow-${SUFFIX}@example.com`, jobTitle: "CFO", contactCompany: "Allowance Corp", status: "new" });
  expect(c.status, c.text).toBe(201);
  contactId = c.body.id;
});

afterAll(async () => {
  if (companyIds.length) {
    await db.delete(contactsTable).where(inArray(contactsTable.companyId, companyIds));
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds));
    await db.delete(usersTable).where(inArray(usersTable.companyId, companyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds));
  }
  await db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`));
  await db.delete(planVersionsTable).where(eq(planVersionsTable.planId, ALLOW));
  await db.delete(plansTable).where(eq(plansTable.id, ALLOW));
});

describe("allowance input", () => {
  it("is validated at the contract (integers ≥ 0 or null) and recorded on the immutable snapshot", async () => {
    const draft = await api("POST", `/platform/plans/${ALLOW}/versions`, platformToken, {});
    expect(draft.status, draft.text).toBe(201);
    try {
      expect(draft.body.allowances).toEqual({ aiTokensPerMonth: 100, aiCostMicroUsdPerMonth: 2_500_000 }); // pre-filled from v1
      expect((await api("PATCH", `/platform/plans/${ALLOW}/versions/${draft.body.id}`, platformToken, { allowances: { aiTokensPerMonth: -1 } })).status).toBe(400);
      expect((await api("PATCH", `/platform/plans/${ALLOW}/versions/${draft.body.id}`, platformToken, { allowances: { aiTokensPerMonth: 1.5 } })).status).toBe(400);
      const cleared = await api("PATCH", `/platform/plans/${ALLOW}/versions/${draft.body.id}`, platformToken, { allowances: { aiTokensPerMonth: null, aiCostMicroUsdPerMonth: null } });
      expect(cleared.status, cleared.text).toBe(200);
      expect(cleared.body.allowances).toEqual({ aiTokensPerMonth: null, aiCostMicroUsdPerMonth: null });
      const immutable = await api("PATCH", `/platform/plans/${ALLOW}/versions/${allowV1}`, platformToken, { allowances: { aiTokensPerMonth: 1 } });
      expect(immutable.status).toBe(409);
      const v1 = (await api("GET", `/platform/plans/${ALLOW}/versions/${allowV1}`, platformToken)).body;
      expect(v1.allowances).toEqual({ aiTokensPerMonth: 100, aiCostMicroUsdPerMonth: 2_500_000 });
      const cmp = (await api("GET", `/platform/plans/${ALLOW}/versions/${allowV1}/compare/${draft.body.id}`, platformToken)).body;
      const rows = cmp.rows.filter((r: any) => r.group === "allowances");
      expect(rows.map((r: any) => [r.field, r.changed])).toEqual([
        ["aiTokensPerMonth", true],
        ["aiCostMicroUsdPerMonth", true],
      ]);
    } finally {
      await api("DELETE", `/platform/plans/${ALLOW}/versions/${draft.body.id}`, platformToken);
    }
  });
});

describe("budget precedence inside the Enterprise AI Layer", () => {
  it("plan allowance applies when the tenant has no override: the effective budget is the allowance and the gate denies with AI_BUDGET_EXCEEDED", async () => {
    const s = await settings(adminToken);
    expect(s.monthlyTokenBudget).toBe(100);
    expect(s.monthlyCostBudgetUsd).toBe(2.5);
    expect(s.budgetSource).toEqual({ tokens: "plan", cost: "plan" });
    expect(s.planAllowance).toEqual({ planVersionId: allowV1, aiTokensPerMonth: 100, aiCostBudgetUsd: 2.5 });
    const res = await generate(adminToken, "allowance-deny-1"); // the reservation exceeds a 100-token budget
    expect(res.status, res.text).toBe(429);
    expect(res.body.code).toBe("AI_BUDGET_EXCEEDED");
    expect(res.body.context.kind).toBe("tokens");
    expect(typeof res.body.context.usedTokens).toBe("number");
  });

  it("an explicit tenant override keeps precedence over the plan allowance", async () => {
    const s = await patchSettings(adminToken, { monthlyTokenBudget: 50_000 });
    expect(s.monthlyTokenBudget).toBe(50_000);
    expect(s.budgetSource).toEqual({ tokens: "tenant", cost: "plan" });
    expect(s.planAllowance.aiTokensPerMonth).toBe(100); // still reported, not applied
    const ok = await generate(adminToken, "override-allows-1");
    expect(ok.status, ok.text).toBe(200);
  });

  it("clearing the override falls back to the plan allowance again (same gate, same counters)", async () => {
    const s = await patchSettings(adminToken, { monthlyTokenBudget: null });
    expect(s.monthlyTokenBudget).toBe(100);
    expect(s.budgetSource.tokens).toBe("plan");
    const res = await generate(adminToken, "allowance-deny-2");
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("AI_BUDGET_EXCEEDED");
    // The usage recorded under the override counts against the allowance (one ledger).
    expect(typeof res.body.context.usedTokens).toBe("number");
  });

  it("a legacy version-1 tenant keeps no budget (unlimited unless overridden) — behaviour unchanged", async () => {
    const s = await settings(legacyToken);
    expect(s.monthlyTokenBudget).toBeNull();
    expect(s.budgetSource).toEqual({ tokens: "none", cost: "none" });
    expect(s.planAllowance).toMatchObject({ aiTokensPerMonth: null, aiCostBudgetUsd: null });
    expect(typeof s.planAllowance.planVersionId).toBe("number");
    const own = await patchSettings(legacyToken, { monthlyTokenBudget: 100 });
    expect(own.budgetSource.tokens).toBe("tenant");
    await patchSettings(legacyToken, { monthlyTokenBudget: null });
    expect((await settings(legacyToken)).budgetSource.tokens).toBe("none");
  });

  it("re-assigning the tenant to a plan without allowances removes the seeded budget immediately (cache invalidated)", async () => {
    const assign = await api("POST", `/platform/subscriptions/${companyA}/plan`, platformToken, { plan: "free" });
    expect(assign.status, assign.text).toBe(200);
    const s = await settings(adminToken);
    expect(s.budgetSource).toEqual({ tokens: "none", cost: "none" });
    expect(s.planAllowance.aiTokensPerMonth).toBeNull();
    const back = await api("POST", `/platform/subscriptions/${companyA}/plan`, platformToken, { plan: ALLOW });
    expect(back.status, back.text).toBe(200);
    expect((await settings(adminToken)).budgetSource.tokens).toBe("plan");
    // The platform preview reports the precedence for an operator.
    const preview = (await api("GET", `/platform/plans/${ALLOW}/versions/${allowV1}/effective-limits/${companyA}`, platformToken)).body;
    expect(preview.aiAllowances.preview).toMatchObject({ effectiveTokenBudget: 100, source: { tokens: "plan", cost: "plan" } });
    expect(preview.aiAllowances.tenantOverride).toEqual({ monthlyTokenBudget: null, monthlyCostBudgetMicroUsd: null });
  });
});
