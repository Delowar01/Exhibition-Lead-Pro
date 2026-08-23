// Batch 10 — Unified Dashboard (/analytics/dashboard) + saved dashboard views.
// Complements analytics.test.ts (which covers the scoped /analytics/* endpoints,
// permission gates, currency sums, and cross-tenant 404s) with the pieces the
// Dashboard command center actually consumes: default scope resolution, the
// leadKpis/funnel/monthlyTrend/distribution composition, conversion-rate
// denominators, currency-normalized pipeline values, date-range filtering,
// empty-window behavior, unauthorized scope access through the unified
// endpoint, and the saved-views persistence used by the UI.
//
// All fixtures live in throwaway tenants torn down in afterAll.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, like } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  departmentsTable,
  teamsTable,
  contactsTable,
  leadsTable,
  scansTable,
  loginAttemptsTable,
} from "@workspace/db";

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const DOMAIN = `b10qa-${SUFFIX}.test`;
const DOMAIN_B = `b10qab-${SUFFIX}.test`;

let companyId = 0;
let companyBId = 0;
let platformToken = "";
let adminToken = "";
let leadToken = "";
let memberToken = "";
let outsiderToken = "";

let leadId = 0;
let memberId = 0;
let deptId = 0;
let teamId = 0;
let memberBId = 0;
let deptBId = 0;

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

async function dashboard(token: string, qs = ""): Promise<{ status: number; body: any }> {
  const res = await api("GET", `/analytics/dashboard${qs}`, token);
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.json().catch(() => null) };
}

async function createUser(token: string, email: string, name: string, role: string, companyForPlatform?: number): Promise<number> {
  const payload: Record<string, unknown> = { email, name, role, password: PW };
  if (companyForPlatform != null) payload.companyId = companyForPlatform;
  const res = await api("POST", "/users", token, payload);
  expect(res.status, `create user ${email}`).toBe(201);
  return (await res.json()).id;
}

beforeAll(async () => {
  platformToken = await loginToken(PLATFORM);

  // --- Tenant A with a fully controlled data set ---
  const createCo = await api("POST", "/companies", platformToken, { name: `B10 QA ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  await createUser(platformToken, `qa-admin@${DOMAIN}`, "B10 Admin", "primary_admin", companyId);
  adminToken = await loginToken({ email: `qa-admin@${DOMAIN}`, password: PW });

  leadId = await createUser(adminToken, `qa-lead@${DOMAIN}`, "B10 Lead", "employee");
  memberId = await createUser(adminToken, `qa-member@${DOMAIN}`, "B10 Member", "employee");
  await createUser(adminToken, `qa-outsider@${DOMAIN}`, "B10 Outsider", "employee");

  const dept = await api("POST", "/departments", adminToken, { name: "B10 Sales", headId: leadId });
  deptId = (await dept.json()).id;
  const team = await api("POST", "/teams", adminToken, { name: "B10 Field", departmentId: deptId, leaderId: leadId });
  teamId = (await team.json()).id;
  await db.update(usersTable).set({ departmentId: deptId, teamId }).where(eq(usersTable.id, leadId));
  await db.update(usersTable).set({ departmentId: deptId, teamId }).where(eq(usersTable.id, memberId));
  await db.update(usersTable).set({ permissions: { reports: ["view"] } }).where(eq(usersTable.id, leadId));
  await db.update(usersTable).set({ permissions: { reports: ["view"] } }).where(eq(usersTable.id, memberId));

  leadToken = await loginToken({ email: `qa-lead@${DOMAIN}`, password: PW });
  memberToken = await loginToken({ email: `qa-member@${DOMAIN}`, password: PW });
  outsiderToken = await loginToken({ email: `qa-outsider@${DOMAIN}`, password: PW });

  // Deterministic fixtures (created "now", inside every default window):
  //   scans: 2 by lead, 1 by member
  //   contacts: 1 lead (Software/Germany), 1 member (blank industry/country → Unknown)
  //   leads: won 1000 USD (lead) · won 3750 SAR (member, = 1000 USD)
  //          lost 500 USD (member)
  //          open: qualified 2000 USD (lead) · negotiation 7500 SAR (member, = 2000 USD)
  const now = new Date();
  await db.insert(scansTable).values([
    { companyId, userId: leadId, status: "completed", createdAt: now },
    { companyId, userId: leadId, status: "completed", createdAt: now },
    { companyId, userId: memberId, status: "completed", createdAt: now },
  ]);
  const contacts = await db
    .insert(contactsTable)
    .values([
      { companyId, fullName: "B10 Alpha", contactCompany: "Acme", industry: "Software", country: "Germany", assignedToId: leadId, createdAt: now },
      { companyId, fullName: "B10 Beta", contactCompany: "Globex", assignedToId: memberId, createdAt: now },
    ])
    .returning({ id: contactsTable.id });
  await db.insert(leadsTable).values([
    { companyId, contactId: contacts[0].id, assignedToId: leadId, stage: "won", value: "1000", currency: "USD", createdAt: now },
    { companyId, contactId: contacts[1].id, assignedToId: memberId, stage: "won", value: "3750", currency: "SAR", createdAt: now },
    { companyId, contactId: contacts[1].id, assignedToId: memberId, stage: "lost", value: "500", currency: "USD", createdAt: now },
    { companyId, contactId: contacts[0].id, assignedToId: leadId, stage: "qualified", value: "2000", currency: "USD", createdAt: now },
    { companyId, contactId: contacts[1].id, assignedToId: memberId, stage: "negotiation", value: "7500", currency: "SAR", createdAt: now },
  ]);

  // --- Tenant B (cross-tenant isolation) ---
  const createCoB = await api("POST", "/companies", platformToken, { name: `B10 QA B ${SUFFIX}`, plan: "professional" });
  companyBId = (await createCoB.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyBId));
  await createUser(platformToken, `qa-admin@${DOMAIN_B}`, "B10 Admin B", "primary_admin", companyBId);
  const adminBToken = await loginToken({ email: `qa-admin@${DOMAIN_B}`, password: PW });
  memberBId = await createUser(adminBToken, `qa-member@${DOMAIN_B}`, "B10 Member B", "employee");
  const deptB = await api("POST", "/departments", adminBToken, { name: "B10 Sales B" });
  deptBId = (await deptB.json()).id;
});

afterAll(async () => {
  for (const cid of [companyId, companyBId]) {
    if (!cid) continue;
    await db.delete(leadsTable).where(eq(leadsTable.companyId, cid));
    await db.delete(scansTable).where(eq(scansTable.companyId, cid));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, cid));
    await db.delete(teamsTable).where(eq(teamsTable.companyId, cid));
    await db.delete(departmentsTable).where(eq(departmentsTable.companyId, cid));
    await db.delete(usersTable).where(eq(usersTable.companyId, cid));
    await db.delete(companiesTable).where(eq(companiesTable.id, cid));
  }
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${DOMAIN}`));
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${DOMAIN_B}`));
});

// ── 1. Company scope: KPI accuracy, currency, denominators, composition ─────
describe("company scope (manager default)", () => {
  it("defaults a manager to the company scope with accurate KPIs", async () => {
    const { status, body } = await dashboard(adminToken);
    expect(status).toBe(200);
    expect(body.scope.type).toBe("company");

    expect(body.kpis.scans).toBe(3);
    expect(body.kpis.newContacts).toBe(2);
    expect(body.kpis.newLeads).toBe(5);
    expect(body.kpis.wonCount).toBe(2);
    expect(body.kpis.lostCount).toBe(1);
  });

  it("computes the conversion rate over DECIDED leads only (won+lost, not all)", async () => {
    const { body } = await dashboard(adminToken);
    // 2 won / (2 won + 1 lost) = 67% — open leads must not dilute the denominator
    // (2/5 would be 40%).
    expect(body.kpis.conversionRate).toBe(67);
    expect(body.leadKpis.conversionRate).toBe(67);
  });

  it("normalizes every monetary KPI to USD (no mixed-currency summing)", async () => {
    const { body } = await dashboard(adminToken);
    // Open pipeline: 2000 USD + 7500 SAR (=2000 USD) = 4000 — a naive sum would be 9500.
    expect(body.kpis.pipelineValue).toBe(4000);
    // Won: 1000 USD + 3750 SAR (=1000 USD) = 2000; lost: 500 USD.
    expect(body.kpis.wonValue).toBe(2000);
    expect(body.kpis.lostValue).toBe(500);
  });

  it("derives leadKpis from the live funnel (total = sum of stages)", async () => {
    const { body } = await dashboard(adminToken);
    const funnelTotal = body.funnel.reduce((s: number, f: { count: number }) => s + f.count, 0);
    expect(body.leadKpis.total).toBe(funnelTotal);
    expect(body.leadKpis.total).toBe(5);
    expect(body.leadKpis.qualified).toBe(1);
    expect(body.leadKpis.converted).toBe(2);
    expect(body.leadKpis.lost).toBe(1);
    const byStage = Object.fromEntries(body.funnel.map((f: { stage: string; count: number }) => [f.stage, f.count]));
    expect(byStage).toMatchObject({ prospect: 0, qualified: 1, proposal_sent: 0, negotiation: 1, won: 2, lost: 1 });
  });

  it("returns a 12-month gap-filled monthly trend with this month's real values", async () => {
    const { body } = await dashboard(adminToken);
    expect(body.monthlyTrend).toHaveLength(12);
    const current = body.monthlyTrend[body.monthlyTrend.length - 1];
    expect(current.leads).toBe(5);
    expect(current.won).toBe(2);
    expect(current.contacts).toBe(2);
    expect(current.scans).toBe(3);
  });

  it("groups distributions and collapses blank values to Unknown", async () => {
    const { body } = await dashboard(adminToken);
    const industries = Object.fromEntries(body.industryDistribution.map((r: { label: string; count: number }) => [r.label, r.count]));
    expect(industries).toMatchObject({ Software: 1, Unknown: 1 });
    const countries = Object.fromEntries(body.countryDistribution.map((r: { label: string; count: number }) => [r.label, r.count]));
    expect(countries).toMatchObject({ Germany: 1, Unknown: 1 });
  });
});

// ── 2. Org scopes through the unified endpoint ──────────────────────────────
describe("department / team / employee scoping", () => {
  it("scopes an employee drill-down to that user only", async () => {
    const { status, body } = await dashboard(adminToken, `?scopeType=employee&id=${memberId}`);
    expect(status).toBe(200);
    expect(body.scope).toMatchObject({ type: "employee", id: memberId });
    expect(body.kpis.scans).toBe(1);
    expect(body.kpis.newLeads).toBe(3); // won SAR + lost USD + open negotiation
    expect(body.kpis.wonValue).toBe(1000); // 3750 SAR
    expect(body.kpis.pipelineValue).toBe(2000); // 7500 SAR
    expect(body.kpis.conversionRate).toBe(50); // 1 won / (1 won + 1 lost)
  });

  it("scopes department and team to their members (both org members here)", async () => {
    for (const qs of [`?scopeType=department&id=${deptId}`, `?scopeType=team&id=${teamId}`]) {
      const { status, body } = await dashboard(adminToken, qs);
      expect(status, qs).toBe(200);
      expect(body.kpis.scans, qs).toBe(3);
      expect(body.kpis.newLeads, qs).toBe(5);
      expect(body.headcount, qs).toBe(2); // lead + member only
    }
  });
});

// ── 3. Date-range filtering + empty window ──────────────────────────────────
describe("date-range filtering", () => {
  it("gap-fills the daily trend to exactly the requested window", async () => {
    const { body } = await dashboard(adminToken, `?dateFrom=2024-01-01&dateTo=2024-01-07`);
    expect(body.dateRange).toEqual({ from: "2024-01-01", to: "2024-01-07" });
    expect(body.trend).toHaveLength(7);
  });

  it("an out-of-range window yields zero KPIs and empty distributions — never invented values", async () => {
    const { body } = await dashboard(adminToken, `?dateFrom=2024-01-01&dateTo=2024-01-07`);
    expect(body.kpis.scans).toBe(0);
    expect(body.kpis.newContacts).toBe(0);
    expect(body.kpis.newLeads).toBe(0);
    expect(body.kpis.wonCount).toBe(0);
    expect(body.kpis.lostCount).toBe(0);
    expect(body.kpis.conversionRate).toBe(0); // 0/0 decided → 0, not NaN
    expect(body.kpis.wonValue).toBe(0);
    expect(body.kpis.lostValue).toBe(0);
    expect(body.industryDistribution).toEqual([]);
    expect(body.countryDistribution).toEqual([]);
    expect(body.trend.every((t: { scans: number; leads: number; contacts: number }) => t.scans === 0 && t.leads === 0 && t.contacts === 0)).toBe(true);
    // Point-in-time KPIs (open pipeline, funnel) are date-independent by design.
    expect(body.kpis.pipelineValue).toBe(4000);
  });
});

// ── 4. Unauthorized scope access via the unified endpoint ───────────────────
describe("scope authorization", () => {
  it("defaults a non-manager to their OWN employee scope", async () => {
    const { status, body } = await dashboard(memberToken);
    expect(status).toBe(200);
    expect(body.scope).toMatchObject({ type: "employee", id: memberId });
    expect(body.kpis.scans).toBe(1);
  });

  it("refuses a non-manager the company overview (403)", async () => {
    expect((await dashboard(memberToken, "?scopeType=company")).status).toBe(403);
  });

  it("refuses a non-manager another employee's scope (403)", async () => {
    expect((await dashboard(memberToken, `?scopeType=employee&id=${leadId}`)).status).toBe(403);
  });

  it("team/department scopes require the org position (lead ok, member 403)", async () => {
    expect((await dashboard(leadToken, `?scopeType=team&id=${teamId}`)).status).toBe(200);
    expect((await dashboard(memberToken, `?scopeType=team&id=${teamId}`)).status).toBe(403);
    expect((await dashboard(leadToken, `?scopeType=department&id=${deptId}`)).status).toBe(200);
    expect((await dashboard(memberToken, `?scopeType=department&id=${deptId}`)).status).toBe(403);
  });

  it("gates the unified endpoint on reports:view and the platform firewall", async () => {
    expect((await dashboard(outsiderToken)).status).toBe(403);
    expect((await dashboard(platformToken)).status).toBe(403);
  });

  it("hides other tenants' scopes (404, not data)", async () => {
    expect((await dashboard(adminToken, `?scopeType=employee&id=${memberBId}`)).status).toBe(404);
    expect((await dashboard(adminToken, `?scopeType=department&id=${deptBId}`)).status).toBe(404);
  });
});

// ── 5. Saved dashboard views (persistence used by the UI) ───────────────────
describe("saved dashboard views", () => {
  let viewId = 0;

  it("creates and lists a dashboard view with its payload intact", async () => {
    const create = await api("POST", "/saved-searches", adminToken, {
      name: "B10 Sales 7d",
      kind: "view",
      entityType: "dashboard",
      payload: { scopeKind: "team", scopeId: teamId, rangeDays: 7 },
    });
    expect(create.status).toBe(201);
    viewId = (await create.json()).id;

    const list = await api("GET", "/saved-searches?entityType=dashboard&kind=view", adminToken).then((r) => r.json());
    const mine = list.savedSearches.find((v: { id: number }) => v.id === viewId);
    expect(mine).toBeTruthy();
    expect(mine.payload).toMatchObject({ scopeKind: "team", scopeId: teamId, rangeDays: 7 });
  });

  it("saved views are private to their owner", async () => {
    const list = await api("GET", "/saved-searches?entityType=dashboard&kind=view", memberToken).then((r) => r.json());
    expect(list.savedSearches.map((v: { id: number }) => v.id)).not.toContain(viewId);
  });

  it("deletes a view", async () => {
    expect((await api("DELETE", `/saved-searches/${viewId}`, adminToken)).status).toBe(200);
    const list = await api("GET", "/saved-searches?entityType=dashboard&kind=view", adminToken).then((r) => r.json());
    expect(list.savedSearches.map((v: { id: number }) => v.id)).not.toContain(viewId);
  });
});
