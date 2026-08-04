// Batch 4 — Table-driven tenant-isolation matrix.
// Tenant A (TechCorp, company 2) vs Tenant B (Nexus, company 3) vs platform_owner.
// Convention under test (existing): cross-tenant record access answers 404 (no
// existence leak, never 500); platform_owner is fenced off tenant CRM with 403.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  contactsTable,
  leadsTable,
  eventsTable,
  tasksTable,
  followUpsTable,
  documentsTable,
  scansTable,
  teamsTable,
  departmentsTable,
  organizationsTable,
  rolesTable,
  usersTable,
} from "@workspace/db";

const BASE = "http://localhost:80/api";

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const TECHCORP = { email: "admin@techcorp.com", password: "Admin123!" }; // tenant A
const NEXUS = { email: "admin@nexussys.io", password: "Admin123!" }; // tenant B

type Session = { token: string; companyId: number; userId: number };

async function login(creds: { email: string; password: string }): Promise<Session> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  const body = await res.json();
  return { token: body.token, companyId: body.user.companyId, userId: body.user.id };
}

const headers = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
const get = (path: string, token: string) => fetch(`${BASE}${path}`, { headers: headers(token) });
const post = (path: string, token: string, body: unknown = {}) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
const patch = (path: string, token: string, body: unknown = {}) =>
  fetch(`${BASE}${path}`, { method: "PATCH", headers: headers(token), body: JSON.stringify(body) });
const del = (path: string, token: string) => fetch(`${BASE}${path}`, { method: "DELETE", headers: headers(token) });

let A: Session; // TechCorp admin
let B: Session; // Nexus admin
let P: Session; // platform_owner

// Seeded tenant-A record ids per resource, discovered from the DB (soft-deleted
// rows excluded so a 404 can only mean tenant isolation, not deletion).
const seeded: Record<string, number | undefined> = {};
// Throwaway rows created by tenant A for mutation tests.
let probeContactId = 0;
let probeTaskId = 0;
let probeRoleId = 0;
const A_CID = 2;

async function firstId(table: any, opts: { softDelete?: boolean } = { softDelete: true }): Promise<number | undefined> {
  const where = opts.softDelete
    ? and(eq(table.companyId, A_CID), isNull(table.deletedAt))
    : eq(table.companyId, A_CID);
  const [row] = await db.select({ id: table.id }).from(table).where(where).limit(1);
  return row?.id;
}

beforeAll(async () => {
  [A, B, P] = await Promise.all([login(TECHCORP), login(NEXUS), login(PLATFORM)]);

  // Throwaway mutation targets in tenant A (via the API, as tenant A).
  const cRes = await post("/contacts", A.token, { firstName: "IsoMatrix", lastName: "Probe" });
  expect(cRes.status).toBeLessThan(300);
  probeContactId = (await cRes.json()).id;
  const tRes = await post("/tasks", A.token, { title: "IsoMatrix Probe Task" });
  expect(tRes.status).toBeLessThan(300);
  probeTaskId = (await tRes.json()).id;
  // TechCorp has no seeded custom role; create one directly (DB) for read checks.
  const [role] = await db.insert(rolesTable).values({ companyId: A_CID, name: `IsoMatrixRole-${Date.now()}` }).returning();
  probeRoleId = role.id;

  seeded.contacts = probeContactId;
  seeded.leads = await firstId(leadsTable);
  seeded.events = await firstId(eventsTable);
  seeded.tasks = probeTaskId;
  seeded.followUps = await firstId(followUpsTable, { softDelete: false });
  seeded.documents = await firstId(documentsTable);
  seeded.scans = await firstId(scansTable);
  seeded.teams = await firstId(teamsTable, { softDelete: false });
  seeded.departments = await firstId(departmentsTable, { softDelete: false });
  seeded.organizations = await firstId(organizationsTable);
  seeded.roles = probeRoleId;
  const [aUser] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.companyId, A_CID), isNull(usersTable.deletedAt)))
    .limit(1);
  seeded.users = aUser?.id;
}, 30000);

afterAll(async () => {
  if (probeContactId) await del(`/contacts/${probeContactId}`, A.token);
  if (probeTaskId) await del(`/tasks/${probeTaskId}`, A.token);
  if (probeRoleId) await db.delete(rolesTable).where(eq(rolesTable.id, probeRoleId));
});

describe("cross-tenant reads answer 404 (no existence leak)", () => {
  const READS: Array<[string, string, (id: number) => string]> = [
    ["contacts", "contacts", (id) => `/contacts/${id}`],
    ["leads", "leads", (id) => `/leads/${id}`],
    ["events", "events", (id) => `/events/${id}`],
    ["documents", "documents", (id) => `/documents/${id}`],
    ["scans", "scans", (id) => `/scans/${id}`],
    ["teams", "teams", (id) => `/teams/${id}`],
    ["departments", "departments", (id) => `/departments/${id}`],
    ["organizations (CRM companies)", "organizations", (id) => `/organizations/${id}`],
    ["custom roles", "roles", (id) => `/rbac/roles/${id}`],
    ["org users", "users", (id) => `/users/${id}`],
  ];

  it.each(READS)("tenant B cannot GET tenant A's %s", async (_label, key, path) => {
    const id = seeded[key];
    expect(id, `no seeded tenant-A row for ${key}`).toBeDefined();
    const res = await get(path(id!), B.token);
    expect(res.status).toBe(404);
    // Owner still sees it (i.e. the 404 above is isolation, not a bad id).
    const own = await get(path(id!), A.token);
    expect([200, 304]).toContain(own.status);
  });

  it("tenant B cannot read tenant A's security policy/settings via companyId override", async () => {
    const res = await get(`/security/policy?companyId=${A_CID}`, B.token);
    // resolveCompanyId answers 404 for a non-accessible company (no existence leak).
    expect(res.status).toBe(404);
  });

  it("tenant B cannot read tenant A's org settings via companyId override", async () => {
    const res = await get(`/org?companyId=${A_CID}`, B.token);
    expect(res.status).toBe(404);
  });

  it("tenant B's login-history does not accept tenant A member ids", async () => {
    const res = await get(`/users/${seeded.users}/login-history`, B.token);
    expect([403, 404]).toContain(res.status);
  });
});

describe("cross-tenant mutations answer 404 and change nothing", () => {
  it("tenant B cannot PATCH tenant A's contact", async () => {
    const res = await patch(`/contacts/${probeContactId}`, B.token, { firstName: "Hijacked" });
    expect(res.status).toBe(404);
    const own = await get(`/contacts/${probeContactId}`, A.token);
    const body = await own.json();
    expect(body.firstName ?? body.name).toContain("IsoMatrix");
  });

  it("tenant B cannot DELETE tenant A's contact", async () => {
    const res = await del(`/contacts/${probeContactId}`, B.token);
    expect(res.status).toBe(404);
    expect((await get(`/contacts/${probeContactId}`, A.token)).status).toBe(200);
  });

  it("tenant B cannot PATCH or DELETE tenant A's task", async () => {
    expect((await patch(`/tasks/${probeTaskId}`, B.token, { title: "Hijacked" })).status).toBe(404);
    expect((await del(`/tasks/${probeTaskId}`, B.token)).status).toBe(404);
    // Owner can still update it (tasks expose no GET-by-id route).
    const own = await patch(`/tasks/${probeTaskId}`, A.token, { title: "IsoMatrix Probe Task" });
    expect(own.status).toBe(200);
  });

  it("tenant B cannot PATCH tenant A's follow-up", async () => {
    expect(seeded.followUps, "no seeded tenant-A follow-up").toBeDefined();
    const res = await patch(`/follow-ups/${seeded.followUps}`, B.token, { notes: "Hijacked" });
    expect(res.status).toBe(404);
  });

  it("tenant B cannot bind its records to tenant A's contact (FK cross-bind)", async () => {
    const res = await post("/follow-ups", B.token, { contactId: probeContactId });
    expect([400, 404]).toContain(res.status);
  });

  it("tenant B cannot attach tenant A's role via invitations", async () => {
    const res = await post("/invitations", B.token, {
      email: `iso-matrix-${Date.now()}@nexussys.test`,
      role: "employee",
      roleIds: [probeRoleId],
    });
    expect([400, 403, 404]).toContain(res.status);
  });
});

describe("tenant B's lists never contain tenant A's records", () => {
  it("contacts search does not surface tenant A's contact", async () => {
    const resB = await get(`/contacts?search=IsoMatrix`, B.token);
    expect(resB.status).toBe(200);
    expect(await resB.text()).not.toContain("IsoMatrix");
    const resA = await get(`/contacts?search=IsoMatrix`, A.token);
    expect(await resA.text()).toContain("IsoMatrix");
  });

  it("tasks list does not surface tenant A's task", async () => {
    const resB = await get(`/tasks`, B.token);
    expect(resB.status).toBe(200);
    expect(await resB.text()).not.toContain("IsoMatrix Probe Task");
  });
});

describe("platform_owner is fenced off tenant CRM surfaces (403)", () => {
  const FENCED = [
    "/contacts",
    "/leads",
    "/leads/pipeline",
    "/events",
    "/tasks",
    "/follow-ups",
    "/meetings",
    "/documents",
    "/scans",
    "/organizations",
    "/teams",
    "/departments",
    "/territories",
    "/custom-fields",
    "/search?q=iso",
    "/imports/history",
    "/exports/runs",
  ];

  it.each(FENCED)("platform_owner GET %s → 403", async (path) => {
    const res = await get(path, P.token);
    expect(res.status).toBe(403);
  });

  it("platform_owner cannot read tenant records by id either", async () => {
    expect((await get(`/contacts/${probeContactId}`, P.token)).status).toBe(403);
    expect((await get(`/tasks/${probeTaskId}`, P.token)).status).toBe(403);
  });

  it("tenant admin cannot reach platform administration", async () => {
    expect((await get("/companies", A.token)).status).toBe(403);
    expect((await post(`/companies/${A_CID}/suspend`, A.token)).status).toBe(403);
  });
});
