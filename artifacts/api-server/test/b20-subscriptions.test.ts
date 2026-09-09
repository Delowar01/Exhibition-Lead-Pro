import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, and, inArray, like, gt } from "drizzle-orm";
import { db, companiesTable, usersTable, subscriptionsTable, auditLogsTable, contactsTable, plansTable } from "@workspace/db";
import { runSubscriptionSweep } from "../src/lib/jobs/subscription-sweep.js";

// Batch 20 — canonical subscription lifecycle against the LIVE API (localhost:80),
// like the other integration suites. Covers: transactional creation, tenant +
// platform authorization/isolation, GET-never-writes, the retired upgrade
// tombstone, every manual lifecycle transition with its access effect, audit
// rows, limit overrides, the lifecycle sweep (in-process, same database) and the
// repair command (dry-run + apply, scoped to disposable companies).
// No AI, no email, no Stripe calls, no hosted access. Everything is torn down.

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b20sub-${SUFFIX}.test`;
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let platformToken = "";
let tokenA = "";
let tokenB = "";
let tokenRoleAdmin = "";
let tokenEmpView = "";
let tokenEmpManage = "";
let companyA = 0;
let companyB = 0;
let subA = 0;
const companyIds: number[] = [];
const userIds: number[] = [];

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}
async function login(email: string, password = PW): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  return (await res.json()).token;
}
async function api(method: string, path: string, token: string | null, body?: unknown) {
  return fetch(`${BASE}${path}`, { method, headers: token ? headers(token) : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json(res: Response) {
  return res.json() as Promise<Record<string, any>>;
}
async function createCompany(name: string, plan = "professional") {
  const res = await api("POST", "/companies", platformToken, { name, plan });
  expect(res.status, await res.clone().text()).toBe(201);
  const c = await json(res);
  companyIds.push(c.id);
  return c;
}
async function createUser(body: Record<string, unknown>) {
  const res = await api("POST", "/users", platformToken, { password: PW, ...body });
  expect(res.status, await res.clone().text()).toBe(201);
  const u = await json(res);
  userIds.push(u.id);
  return u;
}
async function subRow(companyId: number) {
  const [row] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyId));
  return row;
}
async function companyRow(companyId: number) {
  const [row] = await db.select().from(companiesTable).where(eq(companiesTable.id, companyId));
  return row;
}
async function auditRows(companyId: number) {
  return db.select().from(auditLogsTable).where(and(eq(auditLogsTable.companyId, companyId), eq(auditLogsTable.entityType, "subscription")));
}
const op = (companyId: number, action: string, body?: unknown, method = "POST") => api(method, `/platform/subscriptions/${companyId}/${action}`, platformToken, body);
const detail = async (companyId: number) => json(await api("GET", `/platform/subscriptions/${companyId}`, platformToken));
const current = async (token: string) => json(await api("GET", "/subscriptions/current", token));

beforeAll(async () => {
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  const a = await createCompany(`QA B20 Sub A ${SUFFIX}`);
  companyA = a.id;
  const b = await createCompany(`QA B20 Sub B ${SUFFIX}`, "starter");
  companyB = b.id;
  const adminA = await createUser({ email: `admin-a@${DOMAIN}`, name: "Admin A", role: "primary_admin", companyId: companyA });
  void adminA;
  await createUser({ email: `admin-b@${DOMAIN}`, name: "Admin B", role: "primary_admin", companyId: companyB });
  const roleAdmin = await createUser({ email: `role-admin@${DOMAIN}`, name: "Role Admin", role: "admin", companyId: companyA });
  const empView = await createUser({ email: `emp-view@${DOMAIN}`, name: "Emp View", role: "employee", companyId: companyA });
  const empManage = await createUser({ email: `emp-manage@${DOMAIN}`, name: "Emp Manage", role: "employee", companyId: companyA });
  // Permission matrix is assigned the same way the other suites do it (deny-by-default `{}` for the admin).
  await db.update(usersTable).set({ permissions: {} }).where(eq(usersTable.id, roleAdmin.id));
  await db.update(usersTable).set({ permissions: { subscriptions: ["view"] } }).where(eq(usersTable.id, empView.id));
  await db.update(usersTable).set({ permissions: { subscriptions: ["manage"] } }).where(eq(usersTable.id, empManage.id));
  tokenA = await login(`admin-a@${DOMAIN}`);
  tokenB = await login(`admin-b@${DOMAIN}`);
  tokenRoleAdmin = await login(`role-admin@${DOMAIN}`);
  tokenEmpView = await login(`emp-view@${DOMAIN}`);
  tokenEmpManage = await login(`emp-manage@${DOMAIN}`);
  subA = (await subRow(companyA)).id;
});

afterAll(async () => {
  if (companyIds.length) {
    await db.delete(contactsTable).where(inArray(contactsTable.companyId, companyIds));
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds));
    await db.delete(usersTable).where(inArray(usersTable.companyId, companyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds)); // cascades subscriptions
  }
  await db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`));
});

describe("creation — one canonical subscription per company, in the same transaction", () => {
  it("POST /companies returns the canonical summary: manual 14-day trial, full access, no provider identity", async () => {
    const res = await api("GET", `/companies/${companyA}`, platformToken);
    const c = await json(res);
    expect(c.subscription).toMatchObject({ status: "trialing", billingSource: "manual", accessMode: "full", plan: "professional", cancelAtPeriodEnd: false });
    const expires = new Date(c.subscription.trialExpiresAt).getTime();
    expect(Math.abs(expires - (Date.now() + 14 * 24 * 60 * 60 * 1000))).toBeLessThan(5 * 60 * 1000);
    const rows = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, companyA));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "trialing", billingSource: "manual", plan: "professional", stripeCustomerId: null, stripeSubscriptionId: null, limitOverrides: {} });
    expect(rows[0].trialStartedAt).not.toBeNull();
    expect(rows[0].usageAnchorAt).not.toBeNull();
    // Legacy mirror written in the same transaction (compatibility only).
    const co = await companyRow(companyA);
    expect(co.status).toBe("trial");
    expect(co.plan).toBe("professional");
    expect(co.trialEndsAt?.getTime()).toBe(rows[0].trialExpiresAt?.getTime());
    const audit = await auditRows(companyA);
    expect(audit.some((r) => r.action === "subscription.create" && (r.metadata as any)?.after?.status === "trialing")).toBe(true);
  });
  it("an invalid plan rolls the whole creation back (no company row without a subscription)", async () => {
    const name = `QA B20 Rollback ${SUFFIX}`;
    const res = await api("POST", "/companies", platformToken, { name, plan: "platinum" });
    expect(res.status).toBe(400);
    const rows = await db.select().from(companiesTable).where(eq(companiesTable.name, name));
    expect(rows).toHaveLength(0);
  });
  it("the plan catalog holds exactly the five stable plans with no invented prices", async () => {
    const plans = await db.select().from(plansTable).where(inArray(plansTable.id, ["free", "starter", "professional", "business", "enterprise"]));
    expect(plans).toHaveLength(5);
    const listed = await json(await api("GET", "/subscriptions/plans", tokenA));
    expect(Array.isArray(listed)).toBe(true);
    for (const p of listed) {
      expect(Array.isArray(p.prices)).toBe(true);
      for (const pr of p.prices) expect(pr.unitAmountMinor).toBeTypeOf("number");
    }
  });
});

describe("authorization and isolation", () => {
  it("unauthenticated → 401; platform owner → 403 on tenant billing (firewall), tenant users → 403 on platform billing", async () => {
    expect((await api("GET", "/subscriptions/current", null)).status).toBe(401);
    expect((await api("GET", "/subscriptions/current", platformToken)).status).toBe(403);
    expect((await api("GET", "/subscriptions/usage", platformToken)).status).toBe(403);
    expect((await api("POST", "/subscriptions/upgrade", platformToken, { plan: "enterprise" })).status).toBe(403);
    expect((await api("GET", "/platform/subscriptions", tokenA)).status).toBe(403);
    expect((await api("GET", `/platform/subscriptions/${companyA}`, tokenA)).status).toBe(403);
    expect((await api("POST", `/platform/subscriptions/${companyA}/activate`, tokenA)).status).toBe(403);
    expect((await api("GET", "/platform/billing/status", tokenA)).status).toBe(403);
    expect((await subRow(companyA)).status).toBe("trialing");
  });
  it("subscriptions:view / manage gate tenant reads and self-service; admin/employee with empty permissions are denied", async () => {
    expect((await api("GET", "/subscriptions/current", tokenRoleAdmin)).status).toBe(403);
    expect((await api("GET", "/subscriptions/usage", tokenRoleAdmin)).status).toBe(403);
    expect((await api("POST", "/subscriptions/checkout", tokenRoleAdmin, { planPriceId: 1 })).status).toBe(403);
    expect((await api("GET", "/subscriptions/current", tokenEmpView)).status).toBe(200);
    expect((await api("GET", "/subscriptions/plans", tokenEmpView)).status).toBe(200);
    expect((await api("POST", "/subscriptions/checkout", tokenEmpView, { planPriceId: 1 })).status).toBe(403);
    expect((await api("POST", "/subscriptions/portal", tokenEmpView)).status).toBe(403);
    // The server matrix is exact (same as the B17 workflows precedent): manage alone does not grant reads,
    // but it does pass the self-service gate (the request then fails validation, not authorization).
    expect((await api("GET", "/subscriptions/current", tokenEmpManage)).status).toBe(403);
    expect((await api("POST", "/subscriptions/checkout", tokenEmpManage, { planPriceId: 999999999 })).status).toBe(400);
    expect((await api("GET", "/subscriptions/current", tokenA)).status).toBe(200);
  });
  it("the company is derived from the authenticated context only", async () => {
    const a = await current(tokenA);
    const b = await json(await api("GET", `/subscriptions/current?companyId=${companyA}`, tokenB));
    expect(a.companyId).toBe(companyA);
    expect(b.companyId).toBe(companyB);
    expect(b.plan).toBe("starter");
    expect(a.id).not.toBe(b.id);
  });
  it("platform detail 404s for unknown companies and 400s for malformed ids", async () => {
    expect((await api("GET", "/platform/subscriptions/999999999", platformToken)).status).toBe(404);
    expect((await api("GET", "/platform/subscriptions/abc", platformToken)).status).toBe(400);
  });
});

describe("retired direct upgrade and read-only reads", () => {
  it("POST /subscriptions/upgrade is a 410 tombstone that never mutates", async () => {
    const before = await subRow(companyA);
    const res = await api("POST", "/subscriptions/upgrade", tokenA, { plan: "enterprise" });
    expect(res.status).toBe(410);
    expect((await json(res)).code).toBe("BILLING_UPGRADE_RETIRED");
    const after = await subRow(companyA);
    expect(after.plan).toBe(before.plan);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
  it("GET current/usage/plans and platform reads never write", async () => {
    const before = await subRow(companyA);
    const auditBefore = (await auditRows(companyA)).length;
    for (let i = 0; i < 2; i++) {
      expect((await api("GET", "/subscriptions/current", tokenA)).status).toBe(200);
      expect((await api("GET", "/subscriptions/usage", tokenA)).status).toBe(200);
      expect((await api("GET", "/subscriptions/plans", tokenA)).status).toBe(200);
      expect((await api("GET", `/platform/subscriptions/${companyA}`, platformToken)).status).toBe(200);
      expect((await api("GET", `/platform/subscriptions/${companyA}/events`, platformToken)).status).toBe(200);
      expect((await api("GET", "/platform/subscriptions/metrics", platformToken)).status).toBe(200);
      expect((await api("GET", `/platform/subscriptions?search=${encodeURIComponent(`B20 Sub A ${SUFFIX}`)}`, platformToken)).status).toBe(200);
    }
    const after = await subRow(companyA);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.statusChangedAt.getTime()).toBe(before.statusChangedAt.getTime());
    expect((await auditRows(companyA)).length).toBe(auditBefore);
  });
  it("the tenant projection is truthful: limits unlimited by default, usage real, storage not measured", async () => {
    const c = await current(tokenA);
    expect(c).toMatchObject({ companyId: companyA, status: "trialing", billingSource: "manual", accessMode: "full", providerLinked: false, providerSubscriptionLinked: false });
    expect(c.billing.managedByPlatform).toBe(true);
    expect(c.billing.portalAvailable).toBe(false);
    expect(c.billing.portalUnavailableReason).toBe("NOT_PROVIDER_MANAGED");
    for (const l of c.limits) expect(l.limit).toBeNull();
    const storage = c.usage.resources.find((r: any) => r.resource === "storageMb");
    expect(storage).toMatchObject({ measurable: false, enforced: false });
    const contacts = c.usage.resources.find((r: any) => r.resource === "contacts");
    expect(contacts).toMatchObject({ used: 0, limit: null, remaining: null, enforced: false, measurable: true });
    expect(JSON.stringify(c)).not.toMatch(/whsec_|sk_test|sk_live|renewalDate|scansUsed/);
  });
});

describe("manual lifecycle (platform owner) with access effects", () => {
  it("set plan → same status, mirrored, audited with before/after", async () => {
    const res = await op(companyA, "plan", { plan: "business" });
    expect(res.status, await res.clone().text()).toBe(200);
    const d = await json(res);
    expect(d.plan).toBe("business");
    expect(d.status).toBe("trialing");
    expect((await companyRow(companyA)).plan).toBe("business");
    const row = (await auditRows(companyA)).find((r) => r.action === "subscription.set_plan");
    expect(row?.metadata).toMatchObject({ before: { plan: "professional" }, after: { plan: "business" } });
    expect((row?.metadata as any).changed).toContain("plan");
    expect((await op(companyA, "plan", { plan: "nope" })).status).toBe(400);
  });
  it("start trial (3 days) → trialing with the new end; activate → active (full)", async () => {
    const t = await json(await op(companyA, "trial", { trialDays: 3 }));
    expect(t.status).toBe("trialing");
    expect(Math.abs(new Date(t.trialExpiresAt).getTime() - (Date.now() + 3 * 24 * 60 * 60 * 1000))).toBeLessThan(60_000);
    const a = await json(await op(companyA, "activate"));
    expect(a.status).toBe("active");
    expect(a.accessMode).toBe("full");
    const created = await api("POST", "/contacts", tokenA, { firstName: "Full", lastName: "Access", email: `full-${SUFFIX}@${DOMAIN}` });
    expect(created.status, await created.clone().text()).toBe(201);
    expect((await companyRow(companyA)).status).toBe("active");
  });
  it("past due → read-only (reads allowed, mutations 403); activate restores full access", async () => {
    const p = await json(await op(companyA, "past-due"));
    expect(p).toMatchObject({ status: "past_due", accessMode: "read_only", accessReasonCode: "PAST_DUE" });
    expect((await api("GET", "/contacts", tokenA)).status).toBe(200);
    const denied = await api("POST", "/contacts", tokenA, { firstName: "Read", lastName: "Only" });
    expect(denied.status).toBe(403);
    expect((await current(tokenA)).accessMode).toBe("read_only");
    // Legacy mirror keeps "active" for past_due (compat vocabulary has no past_due state).
    expect((await companyRow(companyA)).status).toBe("active");
    expect((await json(await op(companyA, "activate"))).status).toBe("active");
    expect((await current(tokenA)).accessMode).toBe("full");
  });
  it("cancel → read-only; expire → blocked (403 with reason code, login refused); start trial → full again", async () => {
    expect((await json(await op(companyA, "cancel")))).toMatchObject({ status: "cancelled", accessMode: "read_only" });
    expect((await api("POST", "/contacts", tokenA, { firstName: "X", lastName: "Y" })).status).toBe(403);
    expect((await companyRow(companyA)).status).toBe("cancelled");
    expect((await json(await op(companyA, "expire")))).toMatchObject({ status: "expired", accessMode: "blocked" });
    const blocked = await api("GET", "/contacts", tokenA);
    expect(blocked.status).toBe(403);
    expect((await json(blocked)).code).toBe("SUBSCRIPTION_EXPIRED");
    const loginRes = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `admin-a@${DOMAIN}`, password: PW }) });
    expect(loginRes.status).toBe(403);
    expect((await json(await op(companyA, "trial", { trialDays: 7 })))).toMatchObject({ status: "trialing", accessMode: "full" });
    tokenA = await login(`admin-a@${DOMAIN}`);
    expect((await api("GET", "/contacts", tokenA)).status).toBe(200);
  });
  it("suspend (sanitized reason) → blocked; reactivate restores the pre-suspension state", async () => {
    const s = await json(await op(companyA, "suspend", { reason: "Unpaid invoice\nsecond line\t#12" }));
    expect(s).toMatchObject({ status: "suspended", accessMode: "blocked", suspendedReason: "Unpaid invoice second line #12", statusBeforeSuspension: "trialing" });
    const blocked = await api("GET", "/contacts", tokenA);
    expect(blocked.status).toBe(403);
    expect((await json(blocked)).code).toBe("SUBSCRIPTION_SUSPENDED");
    expect((await companyRow(companyA)).status).toBe("suspended");
    expect(s.allowedActions).toEqual(expect.arrayContaining(["reactivate", "set_limits", "set_plan"]));
    expect(s.allowedActions).not.toContain("activate");
    const r = await json(await op(companyA, "reactivate"));
    expect(r).toMatchObject({ status: "trialing", accessMode: "full", suspendedReason: null, statusBeforeSuspension: null });
    expect((await api("GET", "/contacts", tokenA)).status).toBe(200);
  });
  it("invalid transitions are refused with 409 and stable codes; nothing changes", async () => {
    const before = await subRow(companyA);
    for (const [action, code] of [
      ["past-due", "INVALID_TRANSITION"],
      ["reactivate", "INVALID_TRANSITION"],
      ["convert-to-manual", "NOT_PROVIDER_MANAGED"],
      ["sync", "NOT_PROVIDER_MANAGED"],
    ] as const) {
      const res = await op(companyA, action);
      expect(res.status, action).toBe(409);
      expect((await json(res)).code, action).toBe(code);
    }
    expect((await op(999999999, "activate")).status).toBe(404);
    expect((await subRow(companyA)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
  it("company suspend/activate routes drive the same canonical lifecycle", async () => {
    const s = await api("POST", `/companies/${companyA}/suspend`, platformToken);
    expect(s.status, await s.clone().text()).toBe(200);
    expect((await json(s)).subscription.status).toBe("suspended");
    const a = await api("POST", `/companies/${companyA}/activate`, platformToken);
    expect(a.status).toBe(200);
    expect((await json(a)).subscription.status).toBe("trialing");
    // PATCH /companies/:id no longer accepts plan/status changes.
    const patched = await api("PATCH", `/companies/${companyA}`, platformToken, { name: `QA B20 Sub A ${SUFFIX}`, plan: "enterprise", status: "active" });
    expect([200, 400]).toContain(patched.status);
    expect((await subRow(companyA)).plan).toBe("business");
    expect((await subRow(companyA)).status).toBe("trialing");
  });
  it("every lifecycle change is audited with before/after and without secrets or PII", async () => {
    const rows = await auditRows(companyA);
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["subscription.create", "subscription.set_plan", "subscription.start_trial", "subscription.activate", "subscription.mark_past_due", "subscription.cancel", "subscription.expire", "subscription.suspend", "subscription.reactivate"]) {
      expect(actions.has(a), a).toBe(true);
    }
    for (const r of rows) {
      const m = r.metadata as any;
      expect(m).toHaveProperty("after");
      expect(m).toHaveProperty("changed");
      expect(r.entityType).toBe("subscription");
      expect(r.entityId).toBe(String(subA));
      expect(JSON.stringify(m)).not.toMatch(/whsec_|sk_test|sk_live|@|password/i);
    }
  });
});

describe("limit overrides (platform owner) and truthful usage", () => {
  it("PUT limits replaces the override map; unknown resources and negatives are rejected", async () => {
    const res = await op(companyA, "limits", { limits: { contacts: 2, storageMb: 100 } }, "PUT");
    expect(res.status, await res.clone().text()).toBe(200);
    const d = await json(res);
    expect(d.limitOverrides).toEqual({ contacts: 2, storageMb: 100 });
    expect(d.limits.find((l: any) => l.resource === "contacts")).toMatchObject({ limit: 2, source: "override" });
    const c = await current(tokenA);
    expect(c.usage.resources.find((r: any) => r.resource === "contacts")).toMatchObject({ limit: 2, enforced: true });
    expect(c.usage.resources.find((r: any) => r.resource === "storageMb")).toMatchObject({ limit: 100, enforced: false, measurable: false });
    expect((await op(companyA, "limits", { limits: { bogus: 1 } }, "PUT")).status).toBe(400);
    expect((await op(companyA, "limits", { limits: { contacts: -1 } }, "PUT")).status).toBe(400);
    expect((await op(companyA, "limits", { limits: "nope" }, "PUT")).status).toBe(400);
    const cleared = await json(await op(companyA, "limits", { limits: {} }, "PUT"));
    expect(cleared.limitOverrides).toEqual({});
    expect(cleared.limits.every((l: any) => l.limit === null)).toBe(true);
  });
});

describe("platform list / metrics / stats are computed from canonical rows", () => {
  it("list filters by canonical status, plan, billing source and search", async () => {
    const byName = await json(await api("GET", `/platform/subscriptions?search=${encodeURIComponent(`B20 Sub A ${SUFFIX}`)}`, platformToken));
    expect(byName.subscriptions.map((s: any) => s.companyId)).toEqual([companyA]);
    expect(byName.subscriptions[0]).toMatchObject({ status: "trialing", billingSource: "manual", plan: "business", providerLinked: false });
    const byPlan = await json(await api("GET", `/platform/subscriptions?plan=starter&search=${encodeURIComponent(`B20 Sub B ${SUFFIX}`)}`, platformToken));
    expect(byPlan.subscriptions.map((s: any) => s.companyId)).toEqual([companyB]);
    const none = await json(await api("GET", `/platform/subscriptions?status=suspended&search=${encodeURIComponent(`B20 Sub ${SUFFIX}`)}`, platformToken));
    expect(none.total).toBe(0);
    // Company list filters resolve against the canonical subscription (legacy alias accepted).
    const trial = await json(await api("GET", `/companies?status=trialing&search=${encodeURIComponent(`B20 Sub A ${SUFFIX}`)}`, platformToken));
    expect(trial.companies.map((c: any) => c.id)).toEqual([companyA]);
    const alias = await json(await api("GET", `/companies?status=trial&search=${encodeURIComponent(`B20 Sub A ${SUFFIX}`)}`, platformToken));
    expect(alias.companies.map((c: any) => c.id)).toEqual([companyA]);
    const active = await json(await api("GET", `/companies?status=active&search=${encodeURIComponent(`B20 Sub A ${SUFFIX}`)}`, platformToken));
    expect(active.total).toBe(0);
  });
  it("metrics counts every canonical row exactly once; revenue is never invented", async () => {
    const m = await json(await api("GET", "/platform/subscriptions/metrics", platformToken));
    const total = m.byStatus.reduce((n: number, s: any) => n + s.count, 0);
    const [{ n }] = await db.select({ n: subscriptionsTable.id }).from(subscriptionsTable).limit(1).then(() => db.select({ n: subscriptionsTable.id }).from(subscriptionsTable)).then((rows) => [{ n: rows.length }]);
    expect(total).toBe(n);
    expect(m.byStatus.map((s: any) => s.status).sort()).toEqual(["active", "cancelled", "expired", "past_due", "suspended", "trialing"]);
    expect(m.revenue).toHaveProperty("available");
    if (!m.revenue.available) {
      expect(["NO_VERIFIED_PRICES", "NO_ACTIVE_PROVIDER_SUBSCRIPTIONS", "UNPRICED_SUBSCRIPTIONS", "MIXED_CURRENCIES"]).toContain(m.revenue.reason);
      expect(m.revenue.monthlyRecurringMinor).toBeNull();
    } else {
      expect(m.revenue.countedSubscriptions).toBeGreaterThan(0);
      expect(m.revenue.currency).toMatch(/^[a-z]{3}$/);
    }
  });
  it("platform stats / trends carry no simulated numbers", async () => {
    const stats = await json(await api("GET", "/platform/stats", platformToken));
    expect(stats).not.toHaveProperty("monthlyRevenue");
    expect(stats.revenue).toHaveProperty("available");
    expect(stats.subscriptions.byStatus.length).toBe(6);
    expect(stats.activeCompanies).toBeLessThanOrEqual(stats.totalCompanies);
    const trend = await json(await api("GET", "/platform/revenue-trend", platformToken));
    expect(trend).toEqual({ available: false, reason: "NO_REVENUE_HISTORY", points: [] });
    const scans = await json(await api("GET", "/platform/scan-trend", platformToken));
    expect(Array.isArray(scans)).toBe(true);
    for (const p of scans) {
      expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isInteger(p.value)).toBe(true);
    }
  });
});

describe("lifecycle sweep (in-process, same database)", () => {
  let lapsedManual = 0;
  let lapsedStripe = 0;
  it("expires elapsed MANUAL trials only, once, without deleting anything", async () => {
    lapsedManual = (await createCompany(`QA B20 Sweep Manual ${SUFFIX}`, "free")).id;
    lapsedStripe = (await createCompany(`QA B20 Sweep Stripe ${SUFFIX}`, "free")).id;
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await db.update(subscriptionsTable).set({ trialExpiresAt: past }).where(eq(subscriptionsTable.companyId, lapsedManual));
    await db.update(subscriptionsTable).set({ trialExpiresAt: past, billingSource: "stripe", stripeCustomerId: `cus_b20sweep_${SUFFIX}`, stripeSubscriptionId: `sub_b20sweep_${SUFFIX}` }).where(eq(subscriptionsTable.companyId, lapsedStripe));
    // Before the sweep the lapsed manual trial is already BLOCKED by the resolver.
    const d = await detail(lapsedManual);
    expect(d).toMatchObject({ status: "trialing", accessMode: "blocked", accessReasonCode: "TRIAL_ENDED" });

    const first = await runSubscriptionSweep();
    expect(first.expired).toBeGreaterThanOrEqual(1);
    const m = await subRow(lapsedManual);
    expect(m.status).toBe("expired");
    expect(m.endedAt).not.toBeNull();
    expect((await companyRow(lapsedManual)).status).toBe("expired");
    const s = await subRow(lapsedStripe);
    expect(s.status).toBe("trialing");
    const audit = (await auditRows(lapsedManual)).filter((r) => r.action === "subscription.trial_expired");
    expect(audit).toHaveLength(1);
    expect(audit[0].userName).toBe("system:subscription-sweep");

    const second = await runSubscriptionSweep();
    expect(second.expired).toBe(0);
    expect((await auditRows(lapsedManual)).filter((r) => r.action === "subscription.trial_expired")).toHaveLength(1);
    expect(await companyRow(lapsedManual)).toBeDefined();
    expect(await companyRow(lapsedStripe)).toBeDefined();
    // An expired manual trial can be given a new trial or activated by the platform owner.
    expect((await json(await op(lapsedManual, "trial", { trialDays: 1 }))).status).toBe("trialing");
  });
});

describe("repair command (scripts/repair-subscriptions.ts) — dry-run then apply, scoped", () => {
  const tsx = path.join(apiDir, "node_modules", ".bin", "tsx");
  function repair(args: string[]): { code: number; out: string } {
    try {
      const out = execFileSync(tsx, ["scripts/repair-subscriptions.ts", ...args], { cwd: apiDir, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}` };
    }
  }
  const num = (out: string, key: string) => Number((out.match(new RegExp(`"${key}":\\s*(\\d+)`)) ?? [])[1]);

  it("creates the missing canonical row for a legacy company (trial with a future end) and is idempotent", async () => {
    const [legacy] = await db.insert(companiesTable).values({ name: `QA B20 Legacy Orphan ${SUFFIX}`, plan: "starter", status: "trial", trialEndsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) }).returning();
    companyIds.push(legacy.id);
    expect(await subRow(legacy.id)).toBeUndefined();

    const dry = repair([`--company=${legacy.id}`]);
    expect(dry.code, dry.out).toBe(0);
    expect(num(dry.out, "companiesWithoutSubscription")).toBe(1);
    expect(num(dry.out, "plannedCreates")).toBe(1);
    expect(dry.out).toContain("create:trial_future");
    expect(dry.out).toContain("dry-run: no rows were written");
    expect(await subRow(legacy.id)).toBeUndefined();

    const applied = repair([`--company=${legacy.id}`, "--apply"]);
    expect(applied.code, applied.out).toBe(0);
    const row = await subRow(legacy.id);
    expect(row).toMatchObject({ status: "trialing", billingSource: "manual", plan: "starter" });
    expect(row.trialExpiresAt?.getTime()).toBe(legacy.trialEndsAt?.getTime());
    expect(applied.out).toMatch(/"verify":\s*\{[^}]*"plannedCreates":\s*0/);
    const again = repair([`--company=${legacy.id}`]);
    expect(num(again.out, "plannedCreates")).toBe(0);
    expect(num(again.out, "plannedUpdates")).toBe(0);
    expect(num(again.out, "alreadyCanonical")).toBe(1);
    expect(dry.out + applied.out).not.toMatch(/@|whsec_|sk_/);
  });
  it("legacy statuses can no longer be written (constraint); the repair still completes a canonical row and aborts on provider ids", async () => {
    // B20 Correction 1: the final schema forbids legacy status vocabulary at the
    // database — legacy `trial` normalization happens in the pre-constraint stage
    // of the staged activation (rehearsed on a scratch database, see
    // docs/B20_SUBSCRIPTION_LIFECYCLE.md §12), never against a constrained database.
    const [legacy] = await db.insert(companiesTable).values({ name: `QA B20 Legacy Row ${SUFFIX}`, plan: "free", status: "active", trialEndsAt: null }).returning();
    companyIds.push(legacy.id);
    let sqlstate: string | null = null;
    try {
      await db.insert(subscriptionsTable).values({ companyId: legacy.id, plan: "free", status: "trial", billingSource: "manual" });
    } catch (e: any) {
      sqlstate = e?.code ?? e?.cause?.code ?? null;
    }
    expect(sqlstate).toBe("23514");
    // A canonical row missing its usage anchor is completed by the repair (idempotent).
    await db.insert(subscriptionsTable).values({ companyId: legacy.id, plan: "free", status: "active", billingSource: "manual", usageAnchorAt: null });
    const dry = repair([`--company=${legacy.id}`]);
    expect(dry.code, dry.out).toBe(0);
    expect(num(dry.out, "plannedUpdates")).toBe(1);
    expect(dry.out).toContain("update:legacy_active"); // rule of the company authority; the patch completes usageAnchorAt
    const applied = repair([`--company=${legacy.id}`, "--apply"]);
    expect(applied.code, applied.out).toBe(0);
    expect((await subRow(legacy.id)).status).toBe("active");
    expect((await subRow(legacy.id)).usageAnchorAt).not.toBeNull();

    const [conflict] = await db.insert(companiesTable).values({ name: `QA B20 Legacy Conflict ${SUFFIX}`, plan: "free", status: "active" }).returning();
    companyIds.push(conflict.id);
    await db.insert(subscriptionsTable).values({ companyId: conflict.id, plan: "free", status: "active", billingSource: "manual", stripeCustomerId: `cus_conflict_${SUFFIX}` });
    const aborted = repair([`--company=${conflict.id}`, "--apply"]);
    expect(aborted.code).toBe(2);
    expect(aborted.out).toContain("provider ids populated");
    expect(aborted.out).not.toContain(`cus_conflict_${SUFFIX}`);
  });
});

describe("self-registration (when enabled) creates the same canonical trial", () => {
  it("POST /auth/register → user.subscription trialing/manual/full", async () => {
    const email = `owner@reg-${DOMAIN}`;
    const res = await api("POST", "/auth/register", null, { email, password: PW, name: "Reg Owner", companyName: `QA B20 Registered ${SUFFIX}` });
    if (res.status === 403 || res.status === 404) return; // registration disabled in this environment
    expect(res.status, await res.clone().text()).toBe(201);
    const body = await json(res);
    const cid = body.user.companyId;
    companyIds.push(cid);
    userIds.push(body.user.id);
    expect(body.user.subscription).toMatchObject({ status: "trialing", billingSource: "manual", accessMode: "full" });
    const rows = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, cid));
    expect(rows).toHaveLength(1);
    expect(rows[0].trialExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 13 * 24 * 60 * 60 * 1000);
  });
});

void gt;
