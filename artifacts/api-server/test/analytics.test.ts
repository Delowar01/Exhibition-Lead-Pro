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

// Stage 3 Phase 2 — Executive Dashboards & Analytics. Exercises the five
// /analytics endpoints against the LIVE API (localhost:80): aggregation
// correctness, cross-currency totals, org-scope authorization (manager any,
// employee own-only, team lead team, dept head dept, no company overview),
// cross-tenant 404, the reports:view permission gate, validation, and
// write-epoch cache invalidation. All fixtures live under throwaway tenants
// torn down in afterAll so demo accounts are untouched.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const DOMAIN = `analyticsqa-${SUFFIX}.test`;
const DOMAIN_B = `analyticsqab-${SUFFIX}.test`;
const ADMIN_EMAIL = `qa-admin@${DOMAIN}`;
const LEAD_EMAIL = `qa-lead@${DOMAIN}`; // team leader + dept head
const MEMBER_EMAIL = `qa-member@${DOMAIN}`; // team member (no lead role)
const OUTSIDER_EMAIL = `qa-outsider@${DOMAIN}`; // no reports:view
const ADMIN_B_EMAIL = `qa-admin@${DOMAIN_B}`;

let companyId = 0;
let companyBId = 0;
let platformToken = "";
let adminToken = "";
let leadToken = "";
let memberToken = "";
let outsiderToken = "";
let adminBToken = "";

let adminId = 0;
let leadId = 0;
let memberId = 0;
let outsiderId = 0;
let deptId = 0;
let teamId = 0;
let deptBId = 0;
let teamBId = 0;
let memberBId = 0;

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

async function createUser(
  token: string,
  email: string,
  name: string,
  role: string,
  companyForPlatform?: number,
): Promise<number> {
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
  const createCo = await api("POST", "/companies", platformToken, { name: `QA Analytics ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  adminId = await createUser(platformToken, ADMIN_EMAIL, "QA Admin", "primary_admin", companyId);
  adminToken = await loginToken({ email: ADMIN_EMAIL, password: PW });

  leadId = await createUser(adminToken, LEAD_EMAIL, "QA Lead", "employee");
  memberId = await createUser(adminToken, MEMBER_EMAIL, "QA Member", "employee");
  outsiderId = await createUser(adminToken, OUTSIDER_EMAIL, "QA Outsider", "employee");

  // Department headed by the lead; team led by the lead, member is a team member.
  const dept = await api("POST", "/departments", adminToken, { name: "Sales", headId: leadId });
  expect(dept.status).toBe(201);
  deptId = (await dept.json()).id;

  const team = await api("POST", "/teams", adminToken, { name: "Field Sales", departmentId: deptId, leaderId: leadId });
  expect(team.status).toBe(201);
  teamId = (await team.json()).id;

  // Position lead + member into the dept/team (org membership drives scope).
  await db.update(usersTable).set({ departmentId: deptId, teamId }).where(eq(usersTable.id, leadId));
  await db.update(usersTable).set({ departmentId: deptId, teamId }).where(eq(usersTable.id, memberId));

  // Grant reports:view to lead + member so we test SCOPE authorization (not the
  // permission gate). Outsider intentionally left WITHOUT reports:view.
  await db.update(usersTable).set({ permissions: { reports: ["view"] } }).where(eq(usersTable.id, leadId));
  await db.update(usersTable).set({ permissions: { reports: ["view"] } }).where(eq(usersTable.id, memberId));

  leadToken = await loginToken({ email: LEAD_EMAIL, password: PW });
  memberToken = await loginToken({ email: MEMBER_EMAIL, password: PW });
  outsiderToken = await loginToken({ email: OUTSIDER_EMAIL, password: PW });

  // --- Fixtures (direct DB insert for determinism). Dates default to now() so
  // they fall inside the default 30-day window. ---
  const now = new Date();
  // Scans: 2 by lead, 1 by member.
  await db.insert(scansTable).values([
    { companyId, userId: leadId, status: "completed", createdAt: now },
    { companyId, userId: leadId, status: "completed", createdAt: now },
    { companyId, userId: memberId, status: "completed", createdAt: now },
  ]);
  // Contacts: 1 assigned to lead, 1 to member.
  const contacts = await db
    .insert(contactsTable)
    .values([
      { companyId, fullName: "Alpha Contact", contactCompany: "Acme", assignedToId: leadId, createdAt: now },
      { companyId, fullName: "Beta Contact", contactCompany: "Globex", assignedToId: memberId, createdAt: now },
    ])
    .returning({ id: contactsTable.id });
  // Leads: cross-currency won. lead → 1000 USD won; member → 3750 SAR won (=1000 USD).
  // Plus an open-pipeline lead (qualified) for lead → 2000 USD.
  await db.insert(leadsTable).values([
    { companyId, contactId: contacts[0].id, assignedToId: leadId, stage: "won", value: "1000", currency: "USD", createdAt: now },
    { companyId, contactId: contacts[1].id, assignedToId: memberId, stage: "won", value: "3750", currency: "SAR", createdAt: now },
    { companyId, contactId: contacts[0].id, assignedToId: leadId, stage: "qualified", value: "2000", currency: "USD", createdAt: now },
  ]);

  // --- Tenant B (for cross-tenant isolation) ---
  const createCoB = await api("POST", "/companies", platformToken, { name: `QA Analytics B ${SUFFIX}`, plan: "professional" });
  expect(createCoB.status).toBe(201);
  companyBId = (await createCoB.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyBId));

  await createUser(platformToken, ADMIN_B_EMAIL, "QA Admin B", "primary_admin", companyBId);
  adminBToken = await loginToken({ email: ADMIN_B_EMAIL, password: PW });
  memberBId = await createUser(adminBToken, `qa-member@${DOMAIN_B}`, "QA Member B", "employee");
  const deptB = await api("POST", "/departments", adminBToken, { name: "Sales B" });
  deptBId = (await deptB.json()).id;
  const teamB = await api("POST", "/teams", adminBToken, { name: "Team B" });
  teamBId = (await teamB.json()).id;
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

describe("Permission gate (reports:view)", () => {
  it("403s an employee without reports:view on any analytics endpoint", async () => {
    const res = await api("GET", `/analytics/employee?id=${outsiderId}`, outsiderToken);
    expect(res.status).toBe(403);
  });

  it("blocks platform_owner from tenant business analytics", async () => {
    const res = await api("GET", "/analytics/overview", platformToken);
    expect(res.status).toBe(403);
  });
});

describe("Manager (primary_admin) aggregation correctness", () => {
  it("returns company overview with the expected KPIs", async () => {
    const res = await api("GET", "/analytics/overview", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope.type).toBe("company");
    expect(body.kpis.scans).toBe(3);
    expect(body.kpis.newContacts).toBe(2);
    expect(body.kpis.newLeads).toBe(3);
    expect(body.kpis.wonCount).toBe(2);
    // conversionRate = won / (won + lost) = 2/2 = 100
    expect(body.kpis.conversionRate).toBe(100);
    // headcount = all non-deleted tenant users (admin + 3 employees).
    expect(body.headcount).toBeGreaterThanOrEqual(4);
    expect(Array.isArray(body.trend)).toBe(true);
    expect(body.funnel.length).toBeGreaterThan(0);
  });

  it("sums won value across currencies (1000 USD + 3750 SAR ≈ 2000 USD)", async () => {
    const res = await api("GET", "/analytics/overview", adminToken);
    const body = await res.json();
    // 3750 SAR / 3.75 = 1000 USD → total ≈ 2000 USD. Allow rounding slack.
    expect(body.kpis.wonValue).toBeGreaterThanOrEqual(1980);
    expect(body.kpis.wonValue).toBeLessThanOrEqual(2020);
    // Open pipeline = the single qualified lead at 2000 USD.
    expect(body.kpis.pipelineValue).toBeGreaterThanOrEqual(1980);
    expect(body.kpis.pipelineValue).toBeLessThanOrEqual(2020);
  });

  it("scopes department analytics to dept members only", async () => {
    const res = await api("GET", `/analytics/department?id=${deptId}`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope.type).toBe("department");
    expect(body.scope.id).toBe(deptId);
    // dept members = lead + member → all 3 scans, 2 contacts.
    expect(body.kpis.scans).toBe(3);
    expect(body.headcount).toBe(2);
  });

  it("scopes team analytics to team members only", async () => {
    const res = await api("GET", `/analytics/team?id=${teamId}`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope.type).toBe("team");
    expect(body.headcount).toBe(2);
    expect(body.topPerformers.length).toBeGreaterThan(0);
    // topPerformers[].leads must reflect LEAD counts (not contact counts):
    // lead owns 2 leads (won + qualified), member owns 1 (won).
    const perfLead = body.topPerformers.find((p: { userId: number }) => p.userId === leadId);
    const perfMember = body.topPerformers.find((p: { userId: number }) => p.userId === memberId);
    expect(perfLead.leads).toBe(2);
    expect(perfLead.won).toBe(1);
    expect(perfMember.leads).toBe(1);
    // Ranked by leads desc → the lead (2) outranks the member (1).
    expect(body.topPerformers[0].userId).toBe(leadId);
  });

  it("scopes employee analytics to a single user", async () => {
    const res = await api("GET", `/analytics/employee?id=${leadId}`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope.type).toBe("employee");
    expect(body.scope.id).toBe(leadId);
    expect(body.kpis.scans).toBe(2); // only the lead's scans
    expect(body.headcount).toBe(1);
  });

  it("returns scope-options with canViewCompany true and populated lists", async () => {
    const res = await api("GET", "/analytics/scope-options", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canViewCompany).toBe(true);
    expect(body.departments.some((d: { id: number }) => d.id === deptId)).toBe(true);
    expect(body.teams.some((t: { id: number }) => t.id === teamId)).toBe(true);
    expect(body.employees.length).toBeGreaterThanOrEqual(3);
  });

  it("400s a scoped endpoint without the id query param", async () => {
    const res = await api("GET", "/analytics/department", adminToken);
    expect(res.status).toBe(400);
  });
});

describe("Employee scope authorization", () => {
  it("lets an employee view their own performance", async () => {
    const res = await api("GET", `/analytics/employee?id=${leadId}`, leadToken);
    expect(res.status).toBe(200);
  });

  it("403s an employee viewing another employee", async () => {
    const res = await api("GET", `/analytics/employee?id=${memberId}`, leadToken);
    expect(res.status).toBe(403);
  });

  it("403s an employee on the company overview", async () => {
    const res = await api("GET", "/analytics/overview", leadToken);
    expect(res.status).toBe(403);
  });

  it("lets a team lead view their team but blocks a non-lead member", async () => {
    const leadRes = await api("GET", `/analytics/team?id=${teamId}`, leadToken);
    expect(leadRes.status).toBe(200);
    const memberRes = await api("GET", `/analytics/team?id=${teamId}`, memberToken);
    expect(memberRes.status).toBe(403);
  });

  it("lets a dept head view their dept but blocks a non-head member", async () => {
    const leadRes = await api("GET", `/analytics/department?id=${deptId}`, leadToken);
    expect(leadRes.status).toBe(200);
    const memberRes = await api("GET", `/analytics/department?id=${deptId}`, memberToken);
    expect(memberRes.status).toBe(403);
  });

  it("returns a scoped scope-options for the team lead (no company, own team/dept)", async () => {
    const res = await api("GET", "/analytics/scope-options", leadToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canViewCompany).toBe(false);
    expect(body.teams).toEqual([expect.objectContaining({ id: teamId })]);
    expect(body.departments).toEqual([expect.objectContaining({ id: deptId })]);
    expect(body.employees).toEqual([expect.objectContaining({ id: leadId })]);
  });
});

describe("Cross-tenant isolation (404)", () => {
  it("404s a manager requesting another tenant's department", async () => {
    const res = await api("GET", `/analytics/department?id=${deptBId}`, adminToken);
    expect(res.status).toBe(404);
  });

  it("404s a manager requesting another tenant's team", async () => {
    const res = await api("GET", `/analytics/team?id=${teamBId}`, adminToken);
    expect(res.status).toBe(404);
  });

  it("404s a manager requesting another tenant's employee", async () => {
    const res = await api("GET", `/analytics/employee?id=${memberBId}`, adminToken);
    expect(res.status).toBe(404);
  });
});

describe("Cache invalidation (write epoch)", () => {
  it("reflects a fresh API write after the micro-cache is busted", async () => {
    const before = await (await api("GET", "/analytics/overview", adminToken)).json();
    const baseContacts = before.kpis.newContacts;

    // Create a contact through the API → bumps the global write epoch, busting
    // the analytics micro-cache for the next read.
    const create = await api("POST", "/contacts", adminToken, {
      fullName: "Cache Buster",
      contactCompany: "CacheCo",
      assignedToId: adminId,
    });
    expect(create.status).toBe(201);

    const after = await (await api("GET", "/analytics/overview", adminToken)).json();
    expect(after.kpis.newContacts).toBe(baseContacts + 1);
  });
});
