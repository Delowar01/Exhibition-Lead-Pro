// Batch 20 — Correction 4: the auth USER PROJECTION (login, MFA-completed login,
// /auth/me) must carry the EFFECTIVE permission matrix — legacy users.permissions
// ∪ grants of the assigned RBAC roles — exactly what requireAuth enforces with.
//
// Red against 054b207 (the projection returned the raw legacy column only, so an
// employee whose subscriptions:view came from a role was 200 on the API and
// "No access" in the browser). Green once auth and requireAuth share
// lib/effective-permissions.ts.
//
// Real local API + real RBAC operations only. Legacy grants are written straight
// to the column (there is deliberately no API that sets it) and the column is
// re-read at the end to prove nothing copied role grants into it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import { db, usersTable, companiesTable, auditLogsTable, loginAttemptsTable } from "@workspace/db";
import { generate } from "otplib";

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const TAG = `c4${Date.now().toString(36)}`;
const PW = "EffPerm#2026!";
const DOMAIN = "c4perm.test";
const mail = (who: string) => `${TAG}-${who}@${DOMAIN}`;

type Matrix = Record<string, string[]>;
async function api(method: string, path: string, token?: string | null, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}
async function login(email: string, password = PW) {
  const res = await api("POST", "/auth/login", null, { email, password });
  expect(res.status, res.text).toBe(200);
  return res.json as { token: string; user: { id: number; permissions: Matrix; role: string; companyId: number | null } };
}
const sorted = (m: Matrix): Matrix => Object.fromEntries(Object.keys(m).sort().map((k) => [k, [...m[k]].sort()]));
const noDuplicates = (m: Matrix) => Object.values(m).every((a) => new Set(a).size === a.length);
async function legacyColumn(userId: number): Promise<Matrix> {
  const [row] = await db.select({ permissions: usersTable.permissions }).from(usersTable).where(eq(usersTable.id, userId));
  return (row?.permissions ?? {}) as Matrix;
}
async function setLegacy(userId: number, permissions: Matrix) {
  await db.update(usersTable).set({ permissions }).where(eq(usersTable.id, userId));
}
const isPermissionDenial = (r: { status: number; json: any }) => r.status === 403 && /Missing permission/.test(r.json?.error ?? "");

let platformToken = "";
let companyId = 0;
let adminId = 0;
let adminToken = "";
const emp: Record<string, number> = {};
const roles: Record<string, number> = {};
const legacyBefore: Record<string, Matrix> = {};
const LEGACY_ONLY: Matrix = { leads: ["view"], subscriptions: ["view"] };
const LEGACY_MIXED: Matrix = { leads: ["view", "create"], subscriptions: ["view"] };

beforeAll(async () => {
  platformToken = (await login(PLATFORM.email, PLATFORM.password)).token;
  const company = await api("POST", "/companies", platformToken, { name: `B20C4 ${TAG}`, plan: "free", industry: "QA" });
  expect(company.status, company.text).toBe(201);
  companyId = company.json.id;
  const admin = await api("POST", "/users", platformToken, { email: mail("admin"), name: "C4 Admin", role: "primary_admin", companyId, password: PW });
  expect(admin.status, admin.text).toBe(201);
  adminId = admin.json.id;
  adminToken = (await login(mail("admin"))).token;
  for (const who of ["viewer", "manager", "legacy", "mixed", "none"]) {
    const res = await api("POST", "/users", adminToken, { email: mail(who), name: `C4 ${who}`, role: "employee", companyId, password: PW });
    expect(res.status, res.text).toBe(201);
    emp[who] = res.json.id;
  }
  const mkRole = async (name: string, grants: Array<{ module: string; action: string }>) => {
    const res = await api("POST", "/rbac/roles", adminToken, { name: `${TAG} ${name}`, permissions: grants });
    expect(res.status, res.text).toBe(201);
    return res.json.id as number;
  };
  roles.view = await mkRole("viewer", [{ module: "subscriptions", action: "view" }]);
  roles.manage = await mkRole("manager", [{ module: "subscriptions", action: "view" }, { module: "subscriptions", action: "manage" }]);
  // departments:view is a permission-GATED read (GET /departments), so revocation is observable.
  roles.mixed = await mkRole("mixed", [{ module: "subscriptions", action: "manage" }, { module: "departments", action: "view" }, { module: "leads", action: "view" }]);
  for (const [who, roleId] of [["viewer", roles.view], ["manager", roles.manage], ["mixed", roles.mixed]] as const) {
    const res = await api("PUT", `/users/${emp[who]}/roles`, adminToken, { roleIds: [roleId] });
    expect(res.status, res.text).toBe(200);
  }
  await setLegacy(emp.legacy, LEGACY_ONLY);
  await setLegacy(emp.mixed, LEGACY_MIXED);
  for (const who of Object.keys(emp)) legacyBefore[who] = await legacyColumn(emp[who]);
}, 60000);

afterAll(async () => {
  if (companyId) {
    await db.delete(auditLogsTable).where(eq(auditLogsTable.companyId, companyId));
    await db.delete(usersTable).where(eq(usersTable.companyId, companyId)); // roles / user_roles / sessions cascade
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  }
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `${TAG}-%@${DOMAIN}`));
});

describe("B20 C4 — auth projection carries the effective permission matrix", () => {
  it("1. role-only view: login and /auth/me expose subscriptions:view granted by the role; the API read succeeds", async () => {
    const auth = await login(mail("viewer"));
    expect(auth.user.permissions.subscriptions ?? []).toContain("view");
    const me = await api("GET", "/auth/me", auth.token);
    expect(me.status).toBe(200);
    expect(sorted(me.json.permissions)).toEqual(sorted(auth.user.permissions));
    expect((await api("GET", "/subscriptions/current", auth.token)).status).toBe(200);
    expect((await api("GET", "/subscriptions/usage", auth.token)).status).toBe(200);
  });

  it("2. role-based management: view + manage appear and the manage-gated endpoints pass the permission check", async () => {
    const auth = await login(mail("manager"));
    expect(sorted(auth.user.permissions).subscriptions).toEqual(["manage", "view"]);
    const portal = await api("POST", "/subscriptions/portal", auth.token, {});
    expect(isPermissionDenial(portal), portal.text).toBe(false);
    const checkout = await api("POST", "/subscriptions/checkout", auth.token, { planPriceId: 987654321 });
    expect(isPermissionDenial(checkout), checkout.text).toBe(false);
    expect((await api("GET", "/subscriptions/current", auth.token)).status).toBe(200);
  });

  it("3. legacy-only grants: unchanged behaviour (projection = legacy column)", async () => {
    const auth = await login(mail("legacy"));
    expect(sorted(auth.user.permissions)).toEqual(sorted(LEGACY_ONLY));
    const me = await api("GET", "/auth/me", auth.token);
    expect(sorted(me.json.permissions)).toEqual(sorted(LEGACY_ONLY));
    expect((await api("GET", "/subscriptions/current", auth.token)).status).toBe(200);
    expect(isPermissionDenial(await api("POST", "/leads", auth.token, { title: "denied" }))).toBe(true);
  });

  it("4. mixed grants: legacy ∪ role grants across modules, no duplicates, nothing lost", async () => {
    const auth = await login(mail("mixed"));
    const expected: Matrix = { leads: ["create", "view"], subscriptions: ["manage", "view"], departments: ["view"] };
    expect(sorted(auth.user.permissions)).toEqual(sorted(expected));
    expect(noDuplicates(auth.user.permissions)).toBe(true);
    const me = await api("GET", "/auth/me", auth.token);
    expect(sorted(me.json.permissions)).toEqual(sorted(expected));
    expect((await api("GET", "/departments", auth.token)).status).toBe(200); // departments.view from the role
    expect((await api("POST", "/leads", auth.token, { title: `${TAG} mixed lead` })).status).toBe(201);
    expect(await legacyColumn(emp.mixed)).toEqual(LEGACY_MIXED);
  });

  it("5. no grants: nothing is invented; protected endpoints stay denied", async () => {
    const auth = await login(mail("none"));
    expect(auth.user.permissions).toEqual({});
    const me = await api("GET", "/auth/me", auth.token);
    expect(me.json.permissions).toEqual({});
    expect(isPermissionDenial(await api("GET", "/subscriptions/current", auth.token))).toBe(true);
    expect(isPermissionDenial(await api("GET", "/subscriptions/usage", auth.token))).toBe(true);
    expect(isPermissionDenial(await api("POST", "/subscriptions/portal", auth.token, {}))).toBe(true);
  });

  it("6. revocation: removing the role grant drops it from fresh login and /auth/me unless a legacy grant remains", async () => {
    expect((await api("PUT", `/users/${emp.viewer}/roles`, adminToken, { roleIds: [] })).status).toBe(200);
    const viewer = await login(mail("viewer"));
    expect(viewer.user.permissions.subscriptions ?? []).not.toContain("view");
    expect(((await api("GET", "/auth/me", viewer.token)).json.permissions.subscriptions ?? [])).not.toContain("view");
    expect(isPermissionDenial(await api("GET", "/subscriptions/current", viewer.token))).toBe(true);

    expect((await api("PUT", `/users/${emp.mixed}/roles`, adminToken, { roleIds: [] })).status).toBe(200);
    const mixed = await login(mail("mixed"));
    expect(sorted(mixed.user.permissions)).toEqual(sorted(LEGACY_MIXED)); // the legacy grants survive on their own
    expect(sorted((await api("GET", "/auth/me", mixed.token)).json.permissions)).toEqual(sorted(LEGACY_MIXED));
    expect((await api("GET", "/subscriptions/current", mixed.token)).status).toBe(200);
    expect(isPermissionDenial(await api("GET", "/departments", mixed.token))).toBe(true); // departments:view came only from the role

    // restore the viewer's role for the later tests
    expect((await api("PUT", `/users/${emp.viewer}/roles`, adminToken, { roleIds: [roles.view] })).status).toBe(200);
  });

  it("7. primary admin bypass and the platform tenant-data firewall are unchanged", async () => {
    const admin = await login(mail("admin"));
    expect(admin.user.permissions).toEqual(await legacyColumn(adminId)); // no role join for bypass roles
    expect((await api("GET", "/subscriptions/current", admin.token)).status).toBe(200);
    expect(isPermissionDenial(await api("POST", "/subscriptions/portal", admin.token, {}))).toBe(false);
    expect((await api("POST", "/rbac/roles", admin.token, { name: `${TAG} tmp`, permissions: [] })).status).toBe(201);
    const platform = await login(PLATFORM.email, PLATFORM.password);
    const [platformRow] = await db.select({ permissions: usersTable.permissions }).from(usersTable).where(eq(usersTable.id, platform.user.id));
    expect(platform.user.permissions).toEqual(platformRow?.permissions ?? {});
    const contacts = await api("GET", "/contacts", platform.token);
    expect(contacts.status).toBe(403);
    expect(contacts.json.error).toMatch(/Platform operators cannot access customer business data/);
    expect((await api("GET", `/platform/subscriptions/${companyId}`, platform.token)).status).toBe(200);
  });

  it("8. MFA-completed login returns the same effective matrix as /auth/me", async () => {
    const first = await login(mail("manager"));
    const setup = await api("POST", "/auth/mfa/setup", first.token, {});
    expect(setup.status, setup.text).toBe(200);
    const secret = setup.json.secret as string;
    const enable = await api("POST", "/auth/mfa/enable", first.token, { code: await generate({ secret, strategy: "totp" }) });
    expect(enable.status, enable.text).toBe(200);
    const challenge = await api("POST", "/auth/login", null, { email: mail("manager"), password: PW });
    expect(challenge.status).toBe(200);
    expect(challenge.json.mfaRequired).toBe(true);
    expect(challenge.json.user).toBeUndefined();
    const done = await api("POST", "/auth/mfa/verify-login", null, { mfaToken: challenge.json.mfaToken, code: await generate({ secret, strategy: "totp" }) });
    expect(done.status, done.text).toBe(200);
    expect(sorted(done.json.user.permissions).subscriptions).toEqual(["manage", "view"]);
    const me = await api("GET", "/auth/me", done.json.token);
    expect(sorted(me.json.permissions)).toEqual(sorted(done.json.user.permissions));
  });

  it("9. the stored legacy permission column is untouched for every fixture", async () => {
    for (const who of Object.keys(emp)) expect(await legacyColumn(emp[who]), who).toEqual(legacyBefore[who]);
    expect(await legacyColumn(emp.viewer)).toEqual({}); // role grants were never copied into the column
    expect(await legacyColumn(emp.manager)).toEqual({});
  });
});
