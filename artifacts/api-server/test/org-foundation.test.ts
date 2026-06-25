import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, like } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  departmentsTable,
  teamsTable,
  loginAttemptsTable,
} from "@workspace/db";

// Stage 3 Phase 1 — Organizational Foundation: departments + teams CRUD,
// archive/restore, member assignment, FK validation, tenant isolation (cross-tenant
// 404), employee org-profile assignment, directory filtering, and the reporting
// hierarchy tree. Runs against the LIVE API (localhost:80) like the other integration
// suites; all fixtures live under a throwaway tenant and are torn down in afterAll so
// demo accounts are untouched.
const BASE = "http://localhost:80/api";

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const ORG_DOMAIN = `orgfoundationqa-${SUFFIX}.test`;
const ORG_ADMIN_EMAIL = `qa-admin@${ORG_DOMAIN}`;
const EMP1_EMAIL = `qa-emp1@${ORG_DOMAIN}`;
const EMP2_EMAIL = `qa-emp2@${ORG_DOMAIN}`;

let companyId = 0;
let platformToken = "";
let orgToken = "";
let orgAdminId = 0;
let emp1Id = 0;
let emp2Id = 0;

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

beforeAll(async () => {
  let health: Response;
  try {
    health = await fetch(`${BASE}/healthz`);
  } catch (err) {
    throw new Error(`API not reachable at ${BASE} — is the api-server workflow running? (${String(err)})`);
  }
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);

  platformToken = await loginToken(PLATFORM);

  const createCo = await api("POST", "/companies", platformToken, { name: `QA OrgFoundation ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  const createAdmin = await api("POST", "/users", platformToken, {
    email: ORG_ADMIN_EMAIL,
    name: "QA Org Admin",
    role: "primary_admin",
    companyId,
    password: PW,
  });
  expect(createAdmin.status).toBe(201);
  orgAdminId = (await createAdmin.json()).id;

  orgToken = await loginToken({ email: ORG_ADMIN_EMAIL, password: PW });

  const e1 = await api("POST", "/users", orgToken, { email: EMP1_EMAIL, name: "QA Employee One", role: "employee", password: PW });
  expect(e1.status).toBe(201);
  emp1Id = (await e1.json()).id;

  const e2 = await api("POST", "/users", orgToken, { email: EMP2_EMAIL, name: "QA Employee Two", role: "employee", password: PW });
  expect(e2.status).toBe(201);
  emp2Id = (await e2.json()).id;
});

afterAll(async () => {
  await db.delete(teamsTable).where(eq(teamsTable.companyId, companyId));
  await db.delete(departmentsTable).where(eq(departmentsTable.companyId, companyId));
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${ORG_DOMAIN}`));
  await db.delete(usersTable).where(eq(usersTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
});

describe("Departments CRUD + lifecycle", () => {
  let deptId = 0;
  let childDeptId = 0;

  it("creates a department (201) with head + enriched fields", async () => {
    const res = await api("POST", "/departments", orgToken, {
      name: "Engineering",
      description: "Builds the product",
      headId: orgAdminId,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Engineering");
    expect(body.companyId).toBe(companyId);
    expect(body.headId).toBe(orgAdminId);
    expect(body.headName).toBe("QA Org Admin");
    expect(body.status).toBe("active");
    deptId = body.id;
  });

  it("lists departments scoped to the tenant", async () => {
    const res = await api("GET", "/departments", orgToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.departments.some((d: { id: number }) => d.id === deptId)).toBe(true);
    expect(body.departments.every((d: { companyId: number }) => d.companyId === companyId)).toBe(true);
  });

  it("creates a child department under a parent", async () => {
    const res = await api("POST", "/departments", orgToken, { name: "Platform", parentDepartmentId: deptId });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.parentDepartmentId).toBe(deptId);
    expect(body.parentDepartmentName).toBe("Engineering");
    childDeptId = body.id;
  });

  it("rejects a non-existent parent department FK (400)", async () => {
    const res = await api("POST", "/departments", orgToken, { name: "Bad", parentDepartmentId: 999999 });
    expect(res.status).toBe(400);
  });

  it("rejects an empty PATCH (400, not 500)", async () => {
    const res = await api("PATCH", `/departments/${deptId}`, orgToken, {});
    expect(res.status).toBe(400);
  });

  it("updates a department (200)", async () => {
    const res = await api("PATCH", `/departments/${deptId}`, orgToken, { description: "R&D" });
    expect(res.status).toBe(200);
    expect((await res.json()).description).toBe("R&D");
  });

  it("archives then restores a department", async () => {
    const archived = await api("POST", `/departments/${deptId}/archive`, orgToken);
    expect(archived.status).toBe(200);
    expect((await archived.json()).status).toBe("archived");

    const restored = await api("POST", `/departments/${deptId}/restore`, orgToken);
    expect(restored.status).toBe(200);
    expect((await restored.json()).status).toBe("active");
  });

  it("deletes a department (200)", async () => {
    const res = await api("DELETE", `/departments/${childDeptId}`, orgToken);
    expect(res.status).toBe(200);
    const gone = await api("GET", `/departments/${childDeptId}`, orgToken);
    expect(gone.status).toBe(404);
  });
});

describe("Teams CRUD + member assignment", () => {
  let deptId = 0;
  let teamId = 0;

  beforeAll(async () => {
    const res = await api("POST", "/departments", orgToken, { name: `Sales ${SUFFIX}` });
    deptId = (await res.json()).id;
  });

  it("creates a team under a department with a leader (201)", async () => {
    const res = await api("POST", "/teams", orgToken, {
      name: "Field Sales",
      departmentId: deptId,
      leaderId: emp1Id,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Field Sales");
    expect(body.departmentId).toBe(deptId);
    expect(body.departmentName).toBe(`Sales ${SUFFIX}`);
    expect(body.leaderId).toBe(emp1Id);
    expect(body.leaderName).toBe("QA Employee One");
    teamId = body.id;
  });

  it("rejects a non-existent department FK on create (400)", async () => {
    const res = await api("POST", "/teams", orgToken, { name: "Bad", departmentId: 999999 });
    expect(res.status).toBe(400);
  });

  it("assigns members and reflects the member count", async () => {
    const assign = await api("POST", `/teams/${teamId}/members`, orgToken, { userIds: [emp1Id, emp2Id] });
    expect(assign.status).toBe(200);
    expect((await assign.json()).assigned).toBe(2);

    const members = await api("GET", `/teams/${teamId}/members`, orgToken);
    expect(members.status).toBe(200);
    const body = await members.json();
    expect(body.total).toBe(2);
    expect(body.users.map((u: { id: number }) => u.id).sort()).toEqual([emp1Id, emp2Id].sort());

    const detail = await api("GET", `/teams/${teamId}`, orgToken);
    expect((await detail.json()).memberCount).toBe(2);
  });

  it("rejects assigning a member from another tenant (400)", async () => {
    // user id 1 is the platform owner seed — not in this tenant.
    const res = await api("POST", `/teams/${teamId}/members`, orgToken, { userIds: [1] });
    expect(res.status).toBe(400);
  });

  it("archives then restores a team", async () => {
    const archived = await api("POST", `/teams/${teamId}/archive`, orgToken);
    expect(archived.status).toBe(200);
    expect((await archived.json()).status).toBe("archived");

    const restored = await api("POST", `/teams/${teamId}/restore`, orgToken);
    expect(restored.status).toBe(200);
    expect((await restored.json()).status).toBe("active");
  });
});

describe("Tenant isolation (cross-tenant 404)", () => {
  it("does not leak another tenant's department or team", async () => {
    // Seed a department + team under a foreign tenant (companyId 2 = TechCorp seed).
    const [foreignDept] = await db
      .insert(departmentsTable)
      .values({ companyId: 2, name: `QA Foreign Dept ${SUFFIX}` })
      .returning();
    const [foreignTeam] = await db
      .insert(teamsTable)
      .values({ companyId: 2, name: `QA Foreign Team ${SUFFIX}` })
      .returning();
    try {
      expect((await api("GET", `/departments/${foreignDept.id}`, orgToken)).status).toBe(404);
      expect((await api("PATCH", `/departments/${foreignDept.id}`, orgToken, { name: "x" })).status).toBe(404);
      expect((await api("DELETE", `/departments/${foreignDept.id}`, orgToken)).status).toBe(404);
      expect((await api("GET", `/teams/${foreignTeam.id}`, orgToken)).status).toBe(404);
      expect((await api("POST", `/teams/${foreignTeam.id}/members`, orgToken, { userIds: [emp1Id] })).status).toBe(404);
    } finally {
      await db.delete(teamsTable).where(eq(teamsTable.id, foreignTeam.id));
      await db.delete(departmentsTable).where(eq(departmentsTable.id, foreignDept.id));
    }
  });
});

describe("Permission enforcement", () => {
  it("blocks an employee without departments.create from creating one (403)", async () => {
    const empToken = await loginToken({ email: EMP2_EMAIL, password: PW });
    const res = await api("POST", "/departments", empToken, { name: "Sneaky" });
    expect(res.status).toBe(403);
  });

  it("gates department reads behind departments.view (org data is not open, mirrors the users module) (403)", async () => {
    const empToken = await loginToken({ email: EMP2_EMAIL, password: PW });
    const res = await api("GET", "/departments", empToken);
    expect(res.status).toBe(403);
  });

  it("grants departments.create via a custom role, then allows creation", async () => {
    const role = await api("POST", "/rbac/roles", orgToken, {
      name: `QA Dept Manager ${SUFFIX}`,
      permissions: [
        { module: "departments", action: "view" },
        { module: "departments", action: "create" },
      ],
    });
    expect(role.status).toBe(201);
    const roleId = (await role.json()).id;
    expect((await api("PUT", `/users/${emp1Id}/roles`, orgToken, { roleIds: [roleId] })).status).toBe(200);

    const empToken = await loginToken({ email: EMP1_EMAIL, password: PW });
    const res = await api("POST", "/departments", empToken, { name: `Granted ${SUFFIX}` });
    expect(res.status).toBe(201);

    // revoke so later teardown is clean and other tests are unaffected
    await api("PUT", `/users/${emp1Id}/roles`, orgToken, { roleIds: [] });
  });
});

describe("Employee org profile + directory + hierarchy", () => {
  let deptId = 0;
  let teamId = 0;

  beforeAll(async () => {
    const d = await api("POST", "/departments", orgToken, { name: `Marketing ${SUFFIX}` });
    deptId = (await d.json()).id;
    const t = await api("POST", "/teams", orgToken, { name: `Growth ${SUFFIX}`, departmentId: deptId });
    teamId = (await t.json()).id;
  });

  it("assigns an org profile via PATCH /users/:id", async () => {
    const res = await api("PATCH", `/users/${emp1Id}`, orgToken, {
      employeeId: `E-${SUFFIX}`,
      jobTitle: "Account Executive",
      employmentStatus: "probation",
      joiningDate: "2026-01-15",
      managerId: orgAdminId,
      departmentId: deptId,
      teamId,
    });
    expect(res.status).toBe(200);

    const detail = await api("GET", `/users/${emp1Id}`, orgToken);
    const body = await detail.json();
    expect(body.employeeId).toBe(`E-${SUFFIX}`);
    expect(body.jobTitle).toBe("Account Executive");
    expect(body.employmentStatus).toBe("probation");
    expect(body.joiningDate).toBe("2026-01-15");
    expect(body.managerId).toBe(orgAdminId);
    expect(body.departmentId).toBe(deptId);
    expect(body.teamId).toBe(teamId);
  });

  it("rejects a cross-tenant manager FK on org profile (400)", async () => {
    // user id 1 = platform owner seed, not in this tenant
    const res = await api("PATCH", `/users/${emp2Id}`, orgToken, { managerId: 1 });
    expect(res.status).toBe(400);
  });

  it("blocks a PLATFORM OWNER from binding this tenant's user to another tenant's department/team (400)", async () => {
    // The platform owner can access every tenant, so a caller-scoped FK check would
    // wrongly permit pointing this company's user at a foreign company's org records.
    // Seed a department + team under a foreign tenant (companyId 2 = TechCorp seed)
    // and confirm the company-scoped guard rejects assigning them to emp2.
    const [foreignDept] = await db
      .insert(departmentsTable)
      .values({ companyId: 2, name: `QA XTenant Dept ${SUFFIX}` })
      .returning();
    const [foreignTeam] = await db
      .insert(teamsTable)
      .values({ companyId: 2, name: `QA XTenant Team ${SUFFIX}` })
      .returning();
    try {
      const dept = await api("PATCH", `/users/${emp2Id}`, platformToken, { departmentId: foreignDept.id });
      expect(dept.status).toBe(400);
      const team = await api("PATCH", `/users/${emp2Id}`, platformToken, { teamId: foreignTeam.id });
      expect(team.status).toBe(400);
    } finally {
      await db.delete(teamsTable).where(eq(teamsTable.id, foreignTeam.id));
      await db.delete(departmentsTable).where(eq(departmentsTable.id, foreignDept.id));
    }
  });

  it("filters the employee directory by department + enriches names", async () => {
    const res = await api("GET", `/users/directory?departmentId=${deptId}`, orgToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    const emp1 = body.users.find((u: { id: number }) => u.id === emp1Id);
    expect(emp1).toBeTruthy();
    expect(emp1.departmentName).toBe(`Marketing ${SUFFIX}`);
    expect(emp1.teamName).toBe(`Growth ${SUFFIX}`);
    expect(emp1.managerName).toBe("QA Org Admin");
    // emp2 is not in this department
    expect(body.users.some((u: { id: number }) => u.id === emp2Id)).toBe(false);
  });

  it("builds the reporting hierarchy with the admin at the root and emp1 nested", async () => {
    const res = await api("GET", "/users/hierarchy", orgToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    const root = body.roots.find((n: { id: number }) => n.id === orgAdminId);
    expect(root).toBeTruthy();
    expect(root.reports.some((r: { id: number }) => r.id === emp1Id)).toBe(true);
  });
});
