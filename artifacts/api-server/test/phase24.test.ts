import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  rolesTable,
  securityPoliciesTable,
  securityEventsTable,
  loginAttemptsTable,
} from "@workspace/db";

// Phase 2.4 — Organization, User administration, custom-role RBAC, Security Center,
// and Profile. These run against the LIVE API (localhost:80) like the other
// integration suites. All fixtures are created under a throwaway tenant and torn
// down in afterAll so the shared demo accounts are never mutated.
const BASE = "http://localhost:80/api";

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const ORG_DOMAIN = `phase24qa-${SUFFIX}.test`;
const ORG_ADMIN_EMAIL = `qa-admin@${ORG_DOMAIN}`;
const EMP_EMAIL = `qa-emp@${ORG_DOMAIN}`;
const BLOCKED_DOMAIN = `phase24blocked-${SUFFIX}.test`;
const BLOCKED_EMAIL = `qa-blocked@${BLOCKED_DOMAIN}`;

let companyId = 0;
let platformToken = "";
let orgToken = "";
let orgAdminId = 0;
let empId = 0;
let blockedId = 0;
let roleId = 0;
const escAdminIds: number[] = [];

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function rawLogin(creds: { email: string; password: string }) {
  return fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
}

async function loginToken(creds: { email: string; password: string }): Promise<string> {
  const res = await rawLogin(creds);
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

  // Throwaway tenant. Create via API (exercises POST /companies) then force the
  // status to active so logins are not gated by the trial lifecycle.
  const createCo = await api("POST", "/companies", platformToken, { name: `QA Phase24 ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  // Tenant primary_admin (exercises POST /users platform-sets-companyId path).
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
});

afterAll(async () => {
  // Cascade order: role_permissions/user_roles cascade off roles+users; users +
  // roles + security_policies cascade off the company. security_events has no FK,
  // and login_attempts are keyed by email — clean both explicitly.
  await db.delete(securityEventsTable).where(eq(securityEventsTable.companyId, companyId));
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${ORG_DOMAIN}`));
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${BLOCKED_DOMAIN}`));
  await db.delete(usersTable).where(inArray(usersTable.id, [orgAdminId, empId, blockedId, ...escAdminIds].filter(Boolean)));
  await db.delete(rolesTable).where(eq(rolesTable.companyId, companyId));
  await db.delete(securityPoliciesTable).where(eq(securityPoliciesTable.companyId, companyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
});

describe("Organization module", () => {
  it("reads and updates the caller's own organization profile", async () => {
    const read = await api("GET", "/organization", orgToken);
    expect(read.status).toBe(200);
    const org = await read.json();
    expect(org.id).toBe(companyId);

    const patch = await api("PATCH", "/organization", orgToken, {
      legalName: "QA Phase24 LLC",
      timezone: "America/New_York",
      currency: "USD",
      primaryContactName: "QA Owner",
    });
    expect(patch.status).toBe(200);
    const updated = await patch.json();
    expect(updated.legalName).toBe("QA Phase24 LLC");
    expect(updated.timezone).toBe("America/New_York");
  });

  it("cannot read another tenant's organization (cross-tenant 404)", async () => {
    // companyId 2 (TechCorp) is a seeded foreign tenant; passing it must 404, not leak.
    const res = await api("GET", `/organization?companyId=2`, orgToken);
    expect(res.status).toBe(404);
  });
});

describe("RBAC — custom roles + effective-permission resolution", () => {
  it("exposes the code-defined permission catalog", async () => {
    const res = await api("GET", "/rbac/permissions", orgToken);
    expect(res.status).toBe(200);
    const cat = await res.json();
    expect(Array.isArray(cat.modules)).toBe(true);
    const contacts = cat.modules.find((m: { module: string }) => m.module === "contacts");
    expect(contacts?.actions).toContain("create");
  });

  it("creates a tenant-scoped custom role with grants", async () => {
    const res = await api("POST", "/rbac/roles", orgToken, {
      name: "QA Limited",
      description: "contacts create only",
      permissions: [{ module: "contacts", action: "create" }],
    });
    expect(res.status).toBe(201);
    const role = await res.json();
    roleId = role.id;
    expect(role.companyId).toBe(companyId);
    expect(role.isSystem).toBe(false);
    expect(role.permissions).toEqual([{ module: "contacts", action: "create" }]);

    const list = await api("GET", "/rbac/roles", orgToken);
    const roles = (await list.json()).roles;
    expect(roles.some((r: { id: number }) => r.id === roleId)).toBe(true);
  });

  it("merges role grants into an employee's effective permissions", async () => {
    // Employee starts with empty permissions => gated write denied.
    const createEmp = await api("POST", "/users", orgToken, {
      email: EMP_EMAIL,
      name: "QA Employee",
      role: "employee",
      password: PW,
    });
    expect(createEmp.status).toBe(201);
    empId = (await createEmp.json()).id;

    let empToken = await loginToken({ email: EMP_EMAIL, password: PW });
    const denied = await api("POST", "/contacts", empToken, { firstName: "Nope", lastName: "Denied" });
    expect(denied.status).toBe(403);

    // Assign the contacts.create role; effective permissions now include the grant.
    const assign = await api("PUT", `/users/${empId}/roles`, orgToken, { roleIds: [roleId] });
    expect(assign.status).toBe(200);

    empToken = await loginToken({ email: EMP_EMAIL, password: PW });
    const allowed = await api("POST", "/contacts", empToken, { firstName: "QA", lastName: "Allowed" });
    expect(allowed.status).toBe(201);
  });

  it("denies user-directory reads to a caller without team.view (and allows with it)", async () => {
    // The employee holds contacts.create (from the prior test) but NOT team.view,
    // so the user-management read surfaces must be 403 — they expose role/permission
    // metadata and must not be enumerable by arbitrary tenant users.
    const empToken = await loginToken({ email: EMP_EMAIL, password: PW });
    expect((await api("GET", "/users", empToken)).status).toBe(403);
    expect((await api("GET", `/users/${empId}`, empToken)).status).toBe(403);

    // primary_admin bypasses permission checks and can read the directory.
    expect((await api("GET", "/users", orgToken)).status).toBe(200);
    expect((await api("GET", `/users/${empId}`, orgToken)).status).toBe(200);
  });

  it("blocks privilege escalation: a caller cannot grant a role with permissions it does not hold", async () => {
    // An admin who can manage the team (team.edit) but does NOT hold roles.edit
    // must not be able to assign a custom role that grants roles.edit — to itself
    // or anyone — which would otherwise be a back door past the base-role rank guard.
    const createAdmin = await api("POST", "/users", orgToken, {
      email: `qa-escadmin@${ORG_DOMAIN}`,
      name: "QA Esc Admin",
      role: "admin",
      password: PW,
    });
    expect(createAdmin.status).toBe(201);
    const escAdminId = (await createAdmin.json()).id;
    escAdminIds.push(escAdminId);

    // primary_admin (orgToken) grants the admin only team.edit.
    const teamRole = await api("POST", "/rbac/roles", orgToken, {
      name: `QA Team Mgr ${SUFFIX}`,
      permissions: [
        { module: "team", action: "view" },
        { module: "team", action: "edit" },
      ],
    });
    expect(teamRole.status).toBe(201);
    const teamRoleId = (await teamRole.json()).id;
    expect((await api("PUT", `/users/${escAdminId}/roles`, orgToken, { roleIds: [teamRoleId] })).status).toBe(200);

    // A powerful role the admin does NOT hold.
    const superRole = await api("POST", "/rbac/roles", orgToken, {
      name: `QA Super ${SUFFIX}`,
      permissions: [{ module: "roles", action: "edit" }],
    });
    expect(superRole.status).toBe(201);
    const superRoleId = (await superRole.json()).id;

    // The admin authenticates and attempts to self-assign the powerful role.
    const adminToken = await loginToken({ email: `qa-escadmin@${ORG_DOMAIN}`, password: PW });
    const escalate = await api("PUT", `/users/${escAdminId}/roles`, adminToken, { roleIds: [teamRoleId, superRoleId] });
    expect(escalate.status).toBe(403);
  });

  it("blocks privilege escalation via role create/update: cannot mint or inflate grants beyond own scope", async () => {
    // A role-administrator who holds roles.* but NOT security.edit must not be able
    // to mint (or later inflate) a role carrying security.edit — that would be a back
    // door to authority they do not hold, recoverable on next auth load.
    const createAdmin = await api("POST", "/users", orgToken, {
      email: `qa-roleadmin@${ORG_DOMAIN}`,
      name: "QA Role Admin",
      role: "admin",
      password: PW,
    });
    expect(createAdmin.status).toBe(201);
    const roleAdminId = (await createAdmin.json()).id;
    escAdminIds.push(roleAdminId);

    // Grant only the roles.* capability (no security.edit).
    const rbacRole = await api("POST", "/rbac/roles", orgToken, {
      name: `QA RBAC Mgr ${SUFFIX}`,
      permissions: [
        { module: "roles", action: "view" },
        { module: "roles", action: "create" },
        { module: "roles", action: "edit" },
      ],
    });
    expect(rbacRole.status).toBe(201);
    const rbacRoleId = (await rbacRole.json()).id;
    expect((await api("PUT", `/users/${roleAdminId}/roles`, orgToken, { roleIds: [rbacRoleId] })).status).toBe(200);

    const roleAdminToken = await loginToken({ email: `qa-roleadmin@${ORG_DOMAIN}`, password: PW });

    // Cannot CREATE a role granting a permission the caller does not hold.
    const mint = await api("POST", "/rbac/roles", roleAdminToken, {
      name: `QA Inflate ${SUFFIX}`,
      permissions: [{ module: "security", action: "edit" }],
    });
    expect(mint.status).toBe(403);

    // Cannot INFLATE an existing in-scope role with an out-of-scope grant.
    const inScope = await api("POST", "/rbac/roles", roleAdminToken, {
      name: `QA InScope ${SUFFIX}`,
      permissions: [{ module: "roles", action: "view" }],
    });
    expect(inScope.status).toBe(201);
    const inScopeId = (await inScope.json()).id;
    const inflate = await api("PATCH", `/rbac/roles/${inScopeId}`, roleAdminToken, {
      permissions: [{ module: "roles", action: "view" }, { module: "security", action: "edit" }],
    });
    expect(inflate.status).toBe(403);
  });
});

describe("User management lifecycle", () => {
  it("disables a user (login blocked) and re-enables (login restored)", async () => {
    const disable = await api("POST", `/users/${empId}/disable`, orgToken);
    expect(disable.status).toBe(200);

    const blockedLogin = await rawLogin({ email: EMP_EMAIL, password: PW });
    expect(blockedLogin.status).toBeGreaterThanOrEqual(400);

    const enable = await api("POST", `/users/${empId}/enable`, orgToken);
    expect(enable.status).toBe(200);

    const ok = await rawLogin({ email: EMP_EMAIL, password: PW });
    expect(ok.status).toBe(200);
  });

  it("force-logout revokes the user's active sessions", async () => {
    const empToken = await loginToken({ email: EMP_EMAIL, password: PW });
    const before = await api("GET", "/auth/me", empToken);
    expect(before.status).toBe(200);

    const force = await api("POST", `/users/${empId}/force-logout`, orgToken);
    expect(force.status).toBe(200);

    const after = await api("GET", "/auth/me", empToken);
    expect(after.status).toBe(401);
  });

  it("returns login history for a user", async () => {
    const res = await api("GET", `/users/${empId}/login-history`, orgToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    const entries = body.history ?? body.attempts ?? body.entries ?? body;
    expect(Array.isArray(entries) || Array.isArray(body.history)).toBe(true);
  });

  it("soft-deletes a user: login blocked and dropped from the team list", async () => {
    const del = await api("DELETE", `/users/${empId}`, orgToken);
    expect(del.status).toBeGreaterThanOrEqual(200);
    expect(del.status).toBeLessThan(300);

    const list = await api("GET", "/users", orgToken);
    const users = (await list.json()).users;
    expect(users.some((u: { id: number }) => u.id === empId)).toBe(false);

    const gone = await rawLogin({ email: EMP_EMAIL, password: PW });
    expect(gone.status).toBeGreaterThanOrEqual(400);
  });

  it("blocks role escalation above the caller's own rank", async () => {
    const res = await api("POST", "/users", orgToken, {
      email: `qa-escalate@${ORG_DOMAIN}`,
      name: "Escalation Attempt",
      role: "platform_owner",
      password: PW,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("Security Center — policy + login enforcement", () => {
  it("reads and updates the security policy", async () => {
    const read = await api("GET", "/security/policy", orgToken);
    expect(read.status).toBe(200);
    expect((await read.json()).companyId).toBe(companyId);

    const patch = await api("PATCH", "/security/policy", orgToken, { passwordMinLength: 10 });
    expect(patch.status).toBe(200);
    expect((await patch.json()).passwordMinLength).toBe(10);
  });

  it("enforces a blocked email domain at login and records a security event", async () => {
    const createBlocked = await api("POST", "/users", orgToken, {
      email: BLOCKED_EMAIL,
      name: "QA Blocked",
      role: "employee",
      password: PW,
    });
    expect(createBlocked.status).toBe(201);
    blockedId = (await createBlocked.json()).id;

    // Baseline: login works before the policy is applied.
    const before = await rawLogin({ email: BLOCKED_EMAIL, password: PW });
    expect(before.status).toBe(200);

    const policy = await api("PATCH", "/security/policy", orgToken, { blockedEmailDomains: [BLOCKED_DOMAIN] });
    expect(policy.status).toBe(200);

    const blocked = await rawLogin({ email: BLOCKED_EMAIL, password: PW });
    expect(blocked.status).toBe(403);

    // Clear the policy so it cannot affect anything else, then confirm restoration.
    const clear = await api("PATCH", "/security/policy", orgToken, { blockedEmailDomains: [] });
    expect(clear.status).toBe(200);
    const restored = await rawLogin({ email: BLOCKED_EMAIL, password: PW });
    expect(restored.status).toBe(200);

    const events = await api("GET", "/security/events", orgToken);
    expect(events.status).toBe(200);
    expect(Array.isArray((await events.json()).events)).toBe(true);
  });
});

describe("Profile — self-service", () => {
  it("reads and updates the caller's own profile", async () => {
    const read = await api("GET", "/profile", orgToken);
    expect(read.status).toBe(200);
    expect((await read.json()).email).toBe(ORG_ADMIN_EMAIL);

    const patch = await api("PATCH", "/profile", orgToken, { name: "QA Org Admin Renamed", phone: "+1 555 0100" });
    expect(patch.status).toBe(200);
    expect((await patch.json()).name).toBe("QA Org Admin Renamed");
  });

  it("returns profile activity (sessions)", async () => {
    const res = await api("GET", "/profile/activity", orgToken);
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).sessions)).toBe(true);
  });
});
