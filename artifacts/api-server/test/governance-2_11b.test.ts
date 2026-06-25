// Stage 2.11B — Enterprise Governance Hardening (GAP-04/05/06/07).
// GAP-04: platform_owner is blocked from user login/IP/device forensics while retaining
//         operational user management.
// GAP-05: every /reports endpoint is gated by the reports.view permission; company users
//         without it are blocked, intended users (primary_admin / granted) keep access.
// GAP-07: platform_owner cannot trigger any AI path (enrichment / scan OCR / lead scoring).
// (GAP-06 scheduler tenant boundary is a structural change covered by typecheck + the
//  existing jobs suite; it has no externally reachable endpoint to assert here.)
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, usersTable, sessionsTable } from "@workspace/db";

const BASE = "http://localhost:80/api";

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const TECHCORP = { email: "admin@techcorp.com", password: "Admin123!" };

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

function authHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}
async function get(path: string, token: string) {
  return fetch(`${BASE}${path}`, { headers: authHeaders(token) });
}
async function post(path: string, token: string, body: unknown = {}) {
  return fetch(`${BASE}${path}`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) });
}

let platform: Session;
let tech: Session;

// Throwaway techcorp users exercising the four-role reports policy (Stage 2.11B / GAP-05):
//   admin (default reports:view) → access; employee (default, no reports) → blocked;
//   employee explicitly granted reports:view → access. Created by cloning the techcorp
//   admin's password hash so the shared demo password works.
const NO_REPORTS_EMAIL = `gov-noreports-${Date.now()}@techcorp.test`;
const WITH_REPORTS_EMAIL = `gov-withreports-${Date.now()}@techcorp.test`;
const ADMIN_EMAIL = `gov-admin-${Date.now()}@techcorp.test`;
let noReportsToken = "";
let withReportsToken = "";
let adminToken = "";
const createdUserIds: number[] = [];

// Report endpoints that return 200 without query params (used for positive checks).
const REPORTS_NOPARAM = [
  "/reports/admin-dashboard",
  "/reports/mobile-dashboard",
  "/reports/lead-intelligence",
  "/reports/leads-by-event",
  "/reports/team-performance",
  "/reports/scan-activity",
];
// All report endpoints (permission gate fires before the handler, so params are irrelevant).
const REPORTS_ALL = [...REPORTS_NOPARAM, "/reports/event", "/reports/team-member"];

async function makeUser(
  email: string,
  role: "admin" | "employee",
  companyId: number,
  permissions: Record<string, string[]>,
  hash: string,
) {
  const [u] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash: hash,
      name: `Governance Test ${role}`,
      role,
      companyId,
      permissions,
      isActive: true,
    })
    .returning();
  createdUserIds.push(u.id);
  const s = await login({ email, password: TECHCORP.password });
  return s.token;
}

beforeAll(async () => {
  let health: Response;
  try {
    health = await fetch(`${BASE}/healthz`);
  } catch (err) {
    throw new Error(`API not reachable at ${BASE} — is the api-server workflow running? (${String(err)})`);
  }
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);

  platform = await login(PLATFORM);
  tech = await login(TECHCORP);

  const [admin] = await db.select().from(usersTable).where(eq(usersTable.email, TECHCORP.email));
  if (!admin) throw new Error("techcorp admin not found in DB");

  noReportsToken = await makeUser(NO_REPORTS_EMAIL, "employee", admin.companyId!, { contacts: ["view"] }, admin.passwordHash);
  withReportsToken = await makeUser(WITH_REPORTS_EMAIL, "employee", admin.companyId!, { reports: ["view"] }, admin.passwordHash);
  // Mid-tier admin with the default policy grant (reports:view) — must retain report access.
  adminToken = await makeUser(ADMIN_EMAIL, "admin", admin.companyId!, { contacts: ["view"], reports: ["view"] }, admin.passwordHash);
});

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(sessionsTable).where(inArray(sessionsTable.userId, createdUserIds));
    await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
  }
});

describe("GAP-04 — platform_owner blocked from login/IP/device forensics", () => {
  it("platform_owner GET /users/:id/login-history returns 403", async () => {
    const res = await get("/users/1/login-history", platform.token);
    expect(res.status).toBe(403);
  });

  it("platform_owner retains operational user management — GET /users returns 200", async () => {
    const res = await get("/users", platform.token);
    expect(res.status).toBe(200);
  });

  it("company admin retains tenant-scoped login-history access (200)", async () => {
    const res = await get(`/users/${tech.userId}/login-history`, tech.token);
    expect(res.status).toBe(200);
  });
});

describe("GAP-05 — reports gated by reports.view permission", () => {
  it.each(REPORTS_ALL)("employee WITHOUT reports permission gets 403 on GET %s", async (path) => {
    const res = await get(path, noReportsToken);
    expect(res.status).toBe(403);
  });

  it.each(REPORTS_NOPARAM)("employee WITH reports:view gets 200 on GET %s", async (path) => {
    const res = await get(path, withReportsToken);
    expect(res.status).toBe(200);
  });

  it.each(REPORTS_NOPARAM)("mid-tier admin (default reports:view) gets 200 on GET %s", async (path) => {
    const res = await get(path, adminToken);
    expect(res.status).toBe(200);
  });

  it.each(REPORTS_NOPARAM)("primary_admin bypasses and gets 200 on GET %s", async (path) => {
    const res = await get(path, tech.token);
    expect(res.status).toBe(200);
  });

  it("platform_owner is rejected before the permission gate (403)", async () => {
    const res = await get("/reports/admin-dashboard", platform.token);
    expect(res.status).toBe(403);
  });
});

describe("GAP-07 — platform_owner cannot trigger AI on customer data", () => {
  it("AI enrichment (POST /contacts/:id/enrich) returns 403", async () => {
    const res = await post("/contacts/1/enrich", platform.token, {});
    expect(res.status).toBe(403);
  });

  it("scan OCR (POST /scans) returns 403", async () => {
    const res = await post("/scans", platform.token, {});
    expect(res.status).toBe(403);
  });

  it("lead scoring via contact creation (POST /contacts) returns 403", async () => {
    const res = await post("/contacts", platform.token, {});
    expect(res.status).toBe(403);
  });
});
