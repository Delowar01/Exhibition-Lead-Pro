// Stage 2.11A — Enterprise Privacy Enforcement (GAP-01/02/03).
// Proves the platform operator (platform_owner / Elite Marcom) is blocked at the API
// layer (HTTP 403) from every customer CRM/business-data endpoint, while company users
// (admin + employee) retain their existing access and tenant isolation is preserved.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, usersTable, contactsTable, sessionsTable } from "@workspace/db";

const BASE = "http://localhost:80/api";

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const TECHCORP = { email: "admin@techcorp.com", password: "Admin123!" };
const NEXUS = { email: "admin@nexussys.io", password: "Admin123!" };

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
let nexus: Session;

// Throwaway company employee (techcorp), created by cloning the techcorp admin's
// password hash so its password is the shared demo password.
const EMP_EMAIL = `priv-emp-${Date.now()}@techcorp.test`;
let employeeToken = "";
let employeeUserId = 0;
const createdContactIds: number[] = [];

// Read-only customer-data endpoints that must reject platform_owner.
const PROTECTED_GET = [
  "/contacts",
  "/contacts/stats",
  "/contacts/duplicates",
  "/leads",
  "/leads/pipeline",
  "/scans",
  "/scans/1",
  "/scans/1/image",
  "/events",
  "/reports/admin-dashboard",
  "/reports/mobile-dashboard",
  "/reports/lead-intelligence",
  "/reports/team-performance",
  "/reports/scan-activity",
  "/reports/leads-by-event",
  "/follow-ups",
  "/meetings",
  "/tasks",
];

// Mutating customer-data endpoints that must reject platform_owner.
const PROTECTED_POST = ["/contacts", "/leads", "/events", "/scans"];

// Endpoints that always return 200 for an authenticated company user regardless of
// whether the tenant has any data (used for the no-regression checks).
const COMPANY_GET_200 = [
  "/contacts",
  "/contacts/stats",
  "/leads",
  "/leads/pipeline",
  "/scans",
  "/events",
  "/reports/admin-dashboard",
  "/reports/mobile-dashboard",
  "/reports/lead-intelligence",
  "/reports/team-performance",
  "/reports/scan-activity",
  "/reports/leads-by-event",
  "/follow-ups",
  "/meetings",
  "/tasks",
];

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
  nexus = await login(NEXUS);

  // Create a techcorp employee by cloning the admin's password hash.
  const [admin] = await db.select().from(usersTable).where(eq(usersTable.email, TECHCORP.email));
  if (!admin) throw new Error("techcorp admin not found in DB");
  const [emp] = await db
    .insert(usersTable)
    .values({
      email: EMP_EMAIL,
      passwordHash: admin.passwordHash,
      name: "Privacy Test Employee",
      role: "employee",
      companyId: admin.companyId,
      permissions: { contacts: ["view"] },
      isActive: true,
    })
    .returning();
  employeeUserId = emp.id;
  const empSession = await login({ email: EMP_EMAIL, password: TECHCORP.password });
  employeeToken = empSession.token;
});

afterAll(async () => {
  if (createdContactIds.length) {
    await db.delete(contactsTable).where(inArray(contactsTable.id, createdContactIds));
  }
  if (employeeUserId) {
    await db.delete(sessionsTable).where(eq(sessionsTable.userId, employeeUserId));
    await db.delete(usersTable).where(eq(usersTable.id, employeeUserId));
  }
});

describe("Stage 2.11A — platform_owner is blocked from customer business data", () => {
  it.each(PROTECTED_GET)("GET %s returns 403 for platform_owner", async (path) => {
    const res = await get(path, platform.token);
    expect(res.status).toBe(403);
  });

  it.each(PROTECTED_POST)("POST %s returns 403 for platform_owner", async (path) => {
    const res = await post(path, platform.token, {});
    expect(res.status).toBe(403);
  });

  it("business card image download is blocked for platform_owner", async () => {
    const res = await get("/scans/1/image", platform.token);
    expect(res.status).toBe(403);
  });

  it("AI enrichment is blocked for platform_owner", async () => {
    const res = await post("/contacts/1/enrich", platform.token, {});
    expect(res.status).toBe(403);
  });
});

describe("Stage 2.11A — company admin retains full access (no regression)", () => {
  it.each(COMPANY_GET_200)("GET %s returns 200 for company admin", async (path) => {
    const res = await get(path, tech.token);
    expect(res.status).toBe(200);
  });
});

describe("Stage 2.11A — company employee retains read access (open tenant-scoped reads)", () => {
  // Reports are intentionally excluded here: Stage 2.11B gates /reports behind the
  // reports.view permission (GAP-05), which this employee does not hold. The remaining
  // reads stay open + tenant-scoped, so the privacy firewall did not regress them.
  it.each(["/contacts", "/follow-ups", "/meetings", "/tasks"])(
    "GET %s returns 200 for company employee",
    async (path) => {
      const res = await get(path, employeeToken);
      expect(res.status).toBe(200);
    },
  );
});

describe("Stage 2.11A — tenant isolation remains intact", () => {
  it("a company admin cannot read another tenant's contact (404, not 403)", async () => {
    const [c] = await db
      .insert(contactsTable)
      .values({
        companyId: nexus.companyId,
        firstName: "Iso",
        lastName: "Lation",
        fullName: "Iso Lation",
        tags: JSON.stringify([]),
      })
      .returning();
    createdContactIds.push(c.id);

    const res = await get(`/contacts/${c.id}`, tech.token);
    expect(res.status).toBe(404);
  });
});
