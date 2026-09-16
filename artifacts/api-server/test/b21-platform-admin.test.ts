import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, like, and } from "drizzle-orm";
import { db, companiesTable, usersTable, auditLogsTable, loginAttemptsTable, contactsTable } from "@workspace/db";

// Batch 21 — Platform Owner admin panel, against the LIVE API (localhost:80) like
// the other integration suites. Proves: platform-owner access to the tenant list
// (server pagination, search, canonical filters), the tenant record with its
// extended profile and canonical subscription summary, the administrative audit
// trail (allow-listed entity types, sanitized metadata, platform-owner requests
// attributed to the tenant), cross-tenant user administration (company filter,
// name-or-e-mail search, creation of a tenant's primary admin with attribution),
// the management actions the panel exposes (profile update, suspend / reactivate,
// lifecycle through the existing platform routes, delete with cascade), denial
// for tenant users and tenant boundaries. No AI, no e-mail, no Stripe, no hosted
// access. Everything created here is torn down.

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "B21Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b21admin-${SUFFIX}.test`;

let platformToken = "";
let tokenA = "";
let tokenB = "";
let tokenEmpA = "";
let companyA = 0;
let companyB = 0;
let adminAId = 0;
let empAId = 0;
const companyIds: number[] = [];

function headers(token: string | null) {
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
async function api(method: string, path: string, token: string | null, body?: unknown) {
  return fetch(`${BASE}${path}`, { method, headers: headers(token), body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json(res: Response) {
  return res.json() as Promise<Record<string, any>>;
}
async function login(email: string, password = PW): Promise<{ token: string; user: Record<string, any> }> {
  const res = await api("POST", "/auth/login", null, { email, password });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  return json(res) as Promise<{ token: string; user: Record<string, any> }>;
}
async function createCompany(body: Record<string, unknown>) {
  const res = await api("POST", "/companies", platformToken, body);
  expect(res.status, await res.clone().text()).toBe(201);
  const c = await json(res);
  companyIds.push(c.id);
  return c;
}
async function createUser(token: string, body: Record<string, unknown>) {
  const res = await api("POST", "/users", token, { password: PW, ...body });
  expect(res.status, await res.clone().text()).toBe(201);
  return json(res);
}
const detail = async (id: number) => json(await api("GET", `/companies/${id}`, platformToken));
const audit = async (id: number) => json(await api("GET", `/companies/${id}/audit`, platformToken));

beforeAll(async () => {
  platformToken = (await login(PLATFORM.email, PLATFORM.password)).token;
  const a = await createCompany({
    name: `QA B21 Admin A ${SUFFIX}`,
    plan: "starter",
    industry: "Exhibitions",
    country: "AE",
    legalName: `QA B21 Admin A ${SUFFIX} LLC`,
    registrationNumber: `REG-${SUFFIX}`,
    timezone: "Asia/Dubai",
    currency: "AED",
    primaryContactName: "Ada Owner",
    primaryContactEmail: `ada@${DOMAIN}`,
  });
  companyA = a.id;
  const b = await createCompany({ name: `QA B21 Admin B ${SUFFIX}`, plan: "free" });
  companyB = b.id;
  const adminA = await createUser(platformToken, { email: `admin-a@${DOMAIN}`, name: "Admin A", role: "primary_admin", companyId: companyA });
  adminAId = adminA.id;
  await createUser(platformToken, { email: `admin-b@${DOMAIN}`, name: "Admin B", role: "primary_admin", companyId: companyB });
  tokenA = (await login(`admin-a@${DOMAIN}`)).token;
  tokenB = (await login(`admin-b@${DOMAIN}`)).token;
  const empA = await createUser(tokenA, { email: `employee-a@${DOMAIN}`, name: "Employee Alpha", role: "employee", companyId: companyA });
  empAId = empA.id;
  tokenEmpA = (await login(`employee-a@${DOMAIN}`)).token;
});

afterAll(async () => {
  if (companyIds.length) {
    await db.delete(contactsTable).where(inArray(contactsTable.companyId, companyIds));
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds));
    await db.delete(auditLogsTable).where(and(eq(auditLogsTable.entityType, "company"), inArray(auditLogsTable.entityId, companyIds.map(String))));
    await db.delete(usersTable).where(inArray(usersTable.companyId, companyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds)); // cascades subscriptions
  }
  await db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`));
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${DOMAIN}`));
});

describe("tenant record — extended profile + canonical subscription summary", () => {
  it("POST /companies stores the profile fields the panel collects and returns the canonical trial summary", async () => {
    const c = await detail(companyA);
    expect(c).toMatchObject({
      name: `QA B21 Admin A ${SUFFIX}`,
      industry: "Exhibitions",
      country: "AE",
      legalName: `QA B21 Admin A ${SUFFIX} LLC`,
      registrationNumber: `REG-${SUFFIX}`,
      timezone: "Asia/Dubai",
      currency: "AED",
      primaryContactName: "Ada Owner",
      primaryContactEmail: `ada@${DOMAIN}`,
    });
    expect(c.subscription).toMatchObject({ plan: "starter", status: "trialing", billingSource: "manual", accessMode: "full" });
    expect(c.userCount).toBe(2);
    expect(c.contactCount).toBe(0);
    expect(c.scanCount).toBe(0);
  });

  it("PATCH /companies/:id updates the extended profile (never plan / status) and the change is on the tenant's trail", async () => {
    const res = await api("PATCH", `/companies/${companyA}`, platformToken, { legalName: `QA B21 Renamed ${SUFFIX} Ltd`, timezone: "Europe/London", website: "https://b21.example.test", plan: "enterprise", status: "active" });
    expect(res.status, await res.clone().text()).toBe(200);
    const c = await json(res);
    expect(c.legalName).toBe(`QA B21 Renamed ${SUFFIX} Ltd`);
    expect(c.timezone).toBe("Europe/London");
    expect(c.website).toBe("https://b21.example.test");
    // The canonical subscription is untouched by a profile update.
    expect(c.subscription).toMatchObject({ plan: "starter", status: "trialing" });
    const a = await audit(companyA);
    const row = a.items.find((r: any) => r.action === "company.patch");
    expect(row, JSON.stringify(a.items)).toBeTruthy();
    expect(row.entityType).toBe("company");
    expect(row.entityId).toBe(String(companyA));
    expect(row.userName).toBe(PLATFORM.email);
    expect(row.metadata).toMatchObject({ method: "PATCH" });
    expect(row).not.toHaveProperty("ipAddress");
  });
});

describe("tenant list — server pagination, search and canonical filters", () => {
  it("paginates with a real total and honours limit/page", async () => {
    const p1 = await json(await api("GET", `/companies?limit=1&page=1&search=QA%20B21%20Admin`, platformToken));
    expect(p1.companies).toHaveLength(1);
    expect(p1.total).toBe(2);
    expect(p1.page).toBe(1);
    expect(p1.limit).toBe(1);
    const p2 = await json(await api("GET", `/companies?limit=1&page=2&search=QA%20B21%20Admin`, platformToken));
    expect(p2.companies).toHaveLength(1);
    expect(p2.companies[0].id).not.toBe(p1.companies[0].id);
    const p3 = await json(await api("GET", `/companies?limit=1&page=3&search=QA%20B21%20Admin`, platformToken));
    expect(p3.companies).toHaveLength(0);
  });
  it("search narrows by name; status/plan filters resolve against the canonical subscription", async () => {
    const byName = await json(await api("GET", `/companies?search=${encodeURIComponent(`QA B21 Admin A ${SUFFIX}`)}`, platformToken));
    expect(byName.companies.map((c: any) => c.id)).toEqual([companyA]);
    const starter = await json(await api("GET", `/companies?plan=starter&search=QA%20B21%20Admin`, platformToken));
    expect(starter.companies.map((c: any) => c.id)).toEqual([companyA]);
    const trialing = await json(await api("GET", `/companies?status=trialing&search=QA%20B21%20Admin`, platformToken));
    expect(trialing.companies.map((c: any) => c.id).sort()).toEqual([companyA, companyB].sort());
    const suspended = await json(await api("GET", `/companies?status=suspended&search=QA%20B21%20Admin`, platformToken));
    expect(suspended.companies).toHaveLength(0);
  });
});

describe("cross-tenant user administration", () => {
  it("platform owner lists a tenant's users with companyId and searches by name OR e-mail", async () => {
    const list = await json(await api("GET", `/users?companyId=${companyA}&limit=50`, platformToken));
    expect(list.total).toBe(2);
    expect(list.users.every((u: any) => u.companyId === companyA)).toBe(true);
    const byEmail = await json(await api("GET", `/users?search=${encodeURIComponent(`employee-a@${DOMAIN}`)}`, platformToken));
    expect(byEmail.users.map((u: any) => u.id)).toEqual([empAId]);
    const byName = await json(await api("GET", `/users?search=Employee%20Alpha&companyId=${companyA}`, platformToken));
    expect(byName.users.map((u: any) => u.id)).toEqual([empAId]);
    const wrongCompany = await json(await api("GET", `/users?search=Employee%20Alpha&companyId=${companyB}`, platformToken));
    expect(wrongCompany.users).toHaveLength(0);
  });
  it("a tenant admin's user list ignores a foreign companyId and never shows other tenants or platform accounts", async () => {
    const asA = await json(await api("GET", `/users?companyId=${companyB}&limit=100`, tokenA));
    expect(asA.users.length).toBeGreaterThan(0);
    expect(asA.users.every((u: any) => u.companyId === companyA)).toBe(true);
    expect(asA.users.some((u: any) => u.role === "platform_owner")).toBe(false);
    const foreignUser = await api("GET", `/users/${adminAId}`, tokenB);
    expect(foreignUser.status).toBe(404);
  });
  it("the panel creates a tenant's primary administrator (attributed on the tenant's trail); the account can sign in", async () => {
    const created = await createUser(platformToken, { email: `second-admin-a@${DOMAIN}`, name: "Second Admin", role: "primary_admin", companyId: companyA });
    expect(created).toMatchObject({ role: "primary_admin", companyId: companyA, isActive: true });
    const session = await login(`second-admin-a@${DOMAIN}`);
    expect(session.user.companyId).toBe(companyA);
    expect(session.user.role).toBe("primary_admin");
    const me = await json(await api("GET", "/auth/me", session.token));
    expect(me.companyId).toBe(companyA);
    const a = await audit(companyA);
    const row = a.items.find((r: any) => r.action === "team.account_created" && r.entityId === String(created.id));
    expect(row, JSON.stringify(a.items.map((r: any) => r.action))).toBeTruthy();
    expect(row.metadata).toEqual({ role: "primary_admin", createdByPlatform: true });
    expect(JSON.stringify(row)).not.toContain(`second-admin-a@${DOMAIN}`);
    expect((await detail(companyA)).userCount).toBe(3);
  });
  it("a tenant admin cannot create an account in another company or a platform owner", async () => {
    const foreign = await api("POST", "/users", tokenA, { email: `sneak@${DOMAIN}`, name: "Sneak", role: "employee", companyId: companyB, password: PW });
    expect(foreign.status).toBe(403);
    const escalate = await api("POST", "/users", tokenA, { email: `owner@${DOMAIN}`, name: "Owner", role: "platform_owner", password: PW });
    expect([400, 403]).toContain(escalate.status);
  });
});

describe("management actions — lifecycle through the existing routes, audited", () => {
  it("plan change and limit override from the panel are on the tenant's trail with before/after state", async () => {
    const setPlan = await api("POST", `/platform/subscriptions/${companyA}/plan`, platformToken, { plan: "professional" });
    expect(setPlan.status, await setPlan.clone().text()).toBe(200);
    const limits = await api("PUT", `/platform/subscriptions/${companyA}/limits`, platformToken, { limits: { events: 5 } });
    expect(limits.status, await limits.clone().text()).toBe(200);
    const c = await detail(companyA);
    expect(c.subscription.plan).toBe("professional");
    const a = await audit(companyA);
    const plan = a.items.find((r: any) => r.action === "subscription.set_plan");
    expect(plan?.metadata?.before?.plan).toBe("starter");
    expect(plan?.metadata?.after?.plan).toBe("professional");
    const lim = a.items.find((r: any) => r.action === "subscription.set_limits");
    expect(lim).toBeTruthy();
    expect(a.items[0].createdAt >= a.items[a.items.length - 1].createdAt).toBe(true); // newest first
  });
  it("suspend blocks the tenant (login refused), reactivate restores the previous state; both audited", async () => {
    const sus = await api("POST", `/companies/${companyA}/suspend`, platformToken);
    expect(sus.status, await sus.clone().text()).toBe(200);
    expect((await json(sus)).subscription).toMatchObject({ status: "suspended", accessMode: "blocked" });
    const refused = await api("POST", "/auth/login", null, { email: `admin-a@${DOMAIN}`, password: PW });
    expect(refused.status).toBe(403);
    const asAdmin = await api("GET", "/subscriptions/current", tokenA);
    expect(asAdmin.status).toBe(403);
    expect((await json(asAdmin)).code).toBe("SUBSCRIPTION_SUSPENDED");
    const listed = await json(await api("GET", `/companies?status=suspended&search=QA%20B21%20Admin`, platformToken));
    expect(listed.companies.map((c: any) => c.id)).toEqual([companyA]);
    const act = await api("POST", `/companies/${companyA}/activate`, platformToken);
    expect(act.status, await act.clone().text()).toBe(200);
    expect((await json(act)).subscription).toMatchObject({ status: "trialing", accessMode: "full", plan: "professional" });
    tokenA = (await login(`admin-a@${DOMAIN}`)).token;
    const a = await audit(companyA);
    const actions = a.items.map((r: any) => r.action);
    expect(actions).toContain("subscription.suspend");
    expect(actions).toContain("subscription.reactivate");
    const sRow = a.items.find((r: any) => r.action === "subscription.suspend");
    expect(sRow.metadata.before.status).toBe("trialing");
    expect(sRow.metadata.after.status).toBe("suspended");
    // The lifecycle audit records field NAMES (never the operator text) beside the status/plan/source pair.
    expect(sRow.metadata.changed).toContain("suspendedReason");
    expect(sRow.metadata.changed).toContain("statusBeforeSuspension");
    expect(JSON.stringify(sRow.metadata)).not.toContain("Suspended by platform operator");
  });
  it("the audit trail is administrative only: allow-listed entity types, no CRM activity, no IP addresses, capped at 50 newest", async () => {
    // A tenant contact mutation writes a router-level audit row for company A — it must never surface here.
    const contact = await api("POST", "/contacts", tokenA, { firstName: "Audit", lastName: "Probe", email: `probe-${SUFFIX}@${DOMAIN}` });
    expect([201, 200]).toContain(contact.status);
    const a = await audit(companyA);
    expect(a.limit).toBe(50);
    expect(a.items.length).toBeLessThanOrEqual(50);
    expect(a.total).toBeGreaterThanOrEqual(a.items.length);
    expect(a.items.every((r: any) => ["subscription", "company", "team"].includes(r.entityType))).toBe(true);
    expect(a.items.some((r: any) => r.action.startsWith("contacts."))).toBe(false);
    for (const r of a.items) {
      expect(r).not.toHaveProperty("ipAddress");
      expect(Object.keys(r).sort()).toEqual(["action", "createdAt", "entityId", "entityType", "id", "metadata", "userName"]);
      if (r.metadata) expect(Object.keys(r.metadata).every((k) => ["before", "after", "changed", "reason", "plan", "trialDays", "trialExpiresAt", "limits", "path", "method", "eventType", "outcome", "providerClosed", "rule", "role", "createdByPlatform"].includes(k))).toBe(true);
    }
    const dbRows = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.companyId, companyA), eq(auditLogsTable.entityType, "contacts")));
    expect(dbRows.length).toBeGreaterThan(0); // the CRM row exists in the append-only trail, it is simply not projected to the platform
    expect(a.items.some((r: any) => r.action === "subscription.create")).toBe(true);
  });
  it("unknown company → 404 (record, subscription and audit)", async () => {
    expect((await api("GET", "/companies/999999999", platformToken)).status).toBe(404);
    expect((await api("GET", "/companies/999999999/audit", platformToken)).status).toBe(404);
    expect((await api("GET", "/platform/subscriptions/999999999", platformToken)).status).toBe(404);
    expect((await api("PATCH", "/companies/999999999", platformToken, { name: "x" })).status).toBe(404);
  });
  it("delete removes the tenant, its subscription and accounts (cascade); nothing else is touched", async () => {
    const c = await createCompany({ name: `QA B21 Delete Me ${SUFFIX}`, plan: "free" });
    const u = await createUser(platformToken, { email: `doomed@${DOMAIN}`, name: "Doomed", role: "primary_admin", companyId: c.id });
    expect((await login(`doomed@${DOMAIN}`)).user.companyId).toBe(c.id);
    const before = await detail(companyA);
    const del = await api("DELETE", `/companies/${c.id}`, platformToken);
    expect(del.status, await del.clone().text()).toBe(200);
    expect((await api("GET", `/companies/${c.id}`, platformToken)).status).toBe(404);
    expect((await api("GET", `/platform/subscriptions/${c.id}`, platformToken)).status).toBe(404);
    expect((await api("POST", "/auth/login", null, { email: `doomed@${DOMAIN}`, password: PW })).status).toBe(401);
    const rows = await db.select().from(usersTable).where(eq(usersTable.id, u.id));
    expect(rows).toHaveLength(0);
    const delAudit = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.entityType, "company"), eq(auditLogsTable.entityId, String(c.id)), eq(auditLogsTable.action, "company.delete")));
    expect(delAudit.length).toBe(1);
    const after = await detail(companyA);
    expect(after.userCount).toBe(before.userCount);
    expect(after.subscription).toEqual(before.subscription);
  });
});

describe("authorization — tenant users are denied, the platform owner stays fenced from CRM", () => {
  it("every panel read and mutation is 403 for a tenant admin and an employee", async () => {
    for (const token of [tokenA, tokenEmpA]) {
      expect((await api("GET", "/companies", token)).status).toBe(403);
      expect((await api("GET", `/companies/${companyA}`, token)).status).toBe(403);
      expect((await api("GET", `/companies/${companyA}/audit`, token)).status).toBe(403);
      expect((await api("PATCH", `/companies/${companyA}`, token, { name: "Hijack" })).status).toBe(403);
      expect((await api("POST", `/companies/${companyA}/suspend`, token)).status).toBe(403);
      expect((await api("POST", `/companies/${companyB}/activate`, token)).status).toBe(403);
      expect((await api("DELETE", `/companies/${companyB}`, token)).status).toBe(403);
      expect((await api("POST", "/companies", token, { name: "Hijack Co" })).status).toBe(403);
      expect((await api("GET", "/platform/subscriptions", token)).status).toBe(403);
      expect((await api("GET", `/platform/subscriptions/${companyA}`, token)).status).toBe(403);
      expect((await api("GET", "/platform/stats", token)).status).toBe(403);
    }
    expect((await detail(companyA)).name).toBe(`QA B21 Admin A ${SUFFIX}`);
    expect((await detail(companyB)).subscription.status).toBe("trialing");
  });
  it("the platform owner never reaches tenant CRM data through the panel's neighbours", async () => {
    for (const path of ["/contacts", "/leads", "/events", "/subscriptions/current", `/contacts?companyId=${companyA}`]) {
      expect((await api("GET", path, platformToken)).status, path).toBe(403);
    }
  });
});
