import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, like } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  contactsTable,
  leadsTable,
  organizationsTable,
  eventsTable,
  loginAttemptsTable,
} from "@workspace/db";

// Stage 5A — Company Entity Foundation (Task #105). Exercises the first-class CRM
// `organizations` table (UI-labeled "Company", DISTINCT from the tenant `companies`
// table): CRUD + dedup, archive/restore, soft-delete, tenant isolation (cross-tenant
// 404), permission gating (org data is view-gated, not open), the nullable
// organizationId FK on contacts + leads with tenant-scoped FK validation (incl. the
// platform-owner cross-tenant path), organizationName enrichment, and the
// per-organization contacts/leads listing endpoints. Runs against the LIVE API
// (localhost:80) like the other integration suites; all fixtures live under throwaway
// tenants and are torn down in afterAll so demo accounts are untouched.
const BASE = "http://localhost:80/api";

const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const ORG_DOMAIN = `crmorgqa-${SUFFIX}.test`;
const ADMIN_EMAIL = `qa-admin@${ORG_DOMAIN}`;
const EMP_EMAIL = `qa-emp@${ORG_DOMAIN}`;

let companyId = 0;
let foreignCompanyId = 0;
let platformToken = "";
let orgToken = "";
let empId = 0;

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

  const createCo = await api("POST", "/companies", platformToken, { name: `QA CrmOrg ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  const createForeign = await api("POST", "/companies", platformToken, { name: `QA CrmOrg Foreign ${SUFFIX}`, plan: "professional" });
  expect(createForeign.status).toBe(201);
  foreignCompanyId = (await createForeign.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, foreignCompanyId));

  const createAdmin = await api("POST", "/users", platformToken, {
    email: ADMIN_EMAIL,
    name: "QA CrmOrg Admin",
    role: "primary_admin",
    companyId,
    password: PW,
  });
  expect(createAdmin.status).toBe(201);

  orgToken = await loginToken({ email: ADMIN_EMAIL, password: PW });

  const emp = await api("POST", "/users", orgToken, { email: EMP_EMAIL, name: "QA CrmOrg Employee", role: "employee", password: PW });
  expect(emp.status).toBe(201);
  empId = (await emp.json()).id;
});

afterAll(async () => {
  for (const cid of [companyId, foreignCompanyId]) {
    if (!cid) continue;
    await db.delete(leadsTable).where(eq(leadsTable.companyId, cid));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, cid));
    await db.delete(eventsTable).where(eq(eventsTable.companyId, cid));
    await db.delete(organizationsTable).where(eq(organizationsTable.companyId, cid));
    await db.delete(usersTable).where(eq(usersTable.companyId, cid));
  }
  await db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${ORG_DOMAIN}`));
  for (const cid of [companyId, foreignCompanyId]) {
    if (cid) await db.delete(companiesTable).where(eq(companiesTable.id, cid));
  }
});

describe("Organizations CRUD + dedup + lifecycle", () => {
  let orgId = 0;

  it("creates an organization (201) enriched with zero counts", async () => {
    const res = await api("POST", "/organizations", orgToken, {
      name: "Acme Corp",
      industry: "Manufacturing",
      website: "https://acme.example",
      size: "51-200",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Acme Corp");
    expect(body.companyId).toBe(companyId);
    expect(body.industry).toBe("Manufacturing");
    expect(body.status).toBe("active");
    expect(body.contactCount).toBe(0);
    expect(body.leadCount).toBe(0);
    orgId = body.id;
  });

  it("rejects a duplicate name in the same tenant (409)", async () => {
    const res = await api("POST", "/organizations", orgToken, { name: "  acme   corp " });
    expect(res.status).toBe(409);
  });

  it("rejects a blank name (400)", async () => {
    const res = await api("POST", "/organizations", orgToken, { name: "   " });
    expect(res.status).toBe(400);
  });

  it("lists organizations scoped to the tenant", async () => {
    const res = await api("GET", "/organizations", orgToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.organizations.some((o: { id: number }) => o.id === orgId)).toBe(true);
    expect(body.organizations.every((o: { companyId: number }) => o.companyId === companyId)).toBe(true);
  });

  it("gets a single organization (200)", async () => {
    const res = await api("GET", `/organizations/${orgId}`, orgToken);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(orgId);
  });

  it("rejects an empty PATCH (400, not 500)", async () => {
    const res = await api("PATCH", `/organizations/${orgId}`, orgToken, {});
    expect(res.status).toBe(400);
  });

  it("updates an organization (200)", async () => {
    const res = await api("PATCH", `/organizations/${orgId}`, orgToken, { industry: "Aerospace" });
    expect(res.status).toBe(200);
    expect((await res.json()).industry).toBe("Aerospace");
  });

  it("archives then restores an organization", async () => {
    const archived = await api("POST", `/organizations/${orgId}/archive`, orgToken);
    expect(archived.status).toBe(200);
    expect((await archived.json()).status).toBe("archived");

    const restored = await api("POST", `/organizations/${orgId}/restore`, orgToken);
    expect(restored.status).toBe(200);
    expect((await restored.json()).status).toBe("active");
  });

  it("soft-deletes an organization (GET → 404 afterwards)", async () => {
    const del = await api("DELETE", `/organizations/${orgId}`, orgToken);
    expect(del.status).toBe(200);
    const gone = await api("GET", `/organizations/${orgId}`, orgToken);
    expect(gone.status).toBe(404);
  });

  it("allows re-creating a name after the prior one was soft-deleted", async () => {
    // The dedup check must ignore soft-deleted rows or the name is permanently burned.
    const res = await api("POST", "/organizations", orgToken, { name: "Acme Corp" });
    expect(res.status).toBe(201);
  });
});

describe("Contact + lead linking (organizationId FK)", () => {
  let orgId = 0;
  let contactId = 0;
  let leadId = 0;

  beforeAll(async () => {
    const res = await api("POST", "/organizations", orgToken, { name: `Globex ${SUFFIX}`, industry: "Tech" });
    orgId = (await res.json()).id;
  });

  it("creates a contact linked to the organization (create response mirrors eventName: unenriched)", async () => {
    const res = await api("POST", "/contacts", orgToken, {
      firstName: "Jane",
      lastName: "Doe",
      email: `jane-${SUFFIX}@example.com`,
      organizationId: orgId,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.organizationId).toBe(orgId);
    contactId = body.id;
  });

  it("enriches organizationName on a subsequent GET of the contact", async () => {
    const res = await api("GET", `/contacts/${contactId}`, orgToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.organizationId).toBe(orgId);
    expect(body.organizationName).toBe(`Globex ${SUFFIX}`);
  });

  it("creates a lead linked to the organization and enriches organizationName", async () => {
    const res = await api("POST", "/leads", orgToken, {
      contactId,
      stage: "new",
      title: "Globex opportunity",
      value: 1000,
      currency: "USD",
      organizationId: orgId,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.organizationId).toBe(orgId);
    expect(body.organizationName).toBe(`Globex ${SUFFIX}`);
    leadId = body.id;
  });

  it("reflects the linked contact + lead counts on the organization", async () => {
    const res = await api("GET", `/organizations/${orgId}`, orgToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contactCount).toBe(1);
    expect(body.leadCount).toBe(1);
  });

  it("lists the organization's contacts", async () => {
    const res = await api("GET", `/organizations/${orgId}/contacts`, orgToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contacts.some((c: { id: number }) => c.id === contactId)).toBe(true);
  });

  it("lists the organization's leads", async () => {
    const res = await api("GET", `/organizations/${orgId}/leads`, orgToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.leads.some((l: { id: number }) => l.id === leadId)).toBe(true);
  });

  it("clears the link when organizationId is set to null on a contact update", async () => {
    const res = await api("PATCH", `/contacts/${contactId}`, orgToken, { organizationId: null });
    expect(res.status).toBe(200);
    expect((await res.json()).organizationId).toBeNull();
  });
});

describe("FK validation (tenant-scoped)", () => {
  let foreignOrgId = 0;

  beforeAll(async () => {
    // A CRM organization owned by ANOTHER tenant.
    const [foreignOrg] = await db
      .insert(organizationsTable)
      .values({ companyId: foreignCompanyId, name: `QA Foreign Org ${SUFFIX}`, normalizedName: `qa foreign org ${SUFFIX}` })
      .returning();
    foreignOrgId = foreignOrg.id;
  });

  it("rejects a non-existent organizationId on contact create (400)", async () => {
    const res = await api("POST", "/contacts", orgToken, { firstName: "Bad", lastName: "Ref", email: `badref-${SUFFIX}@example.com`, organizationId: 999999 });
    expect(res.status).toBe(400);
  });

  it("rejects a cross-tenant organizationId on contact create (400)", async () => {
    const res = await api("POST", "/contacts", orgToken, { firstName: "Bad", lastName: "Xtenant", email: `badxt-${SUFFIX}@example.com`, organizationId: foreignOrgId });
    expect(res.status).toBe(400);
  });

  it("rejects a cross-tenant organizationId on lead create (400)", async () => {
    // Seed an own-tenant contact to attach the lead to.
    const c = await api("POST", "/contacts", orgToken, { firstName: "Lead", lastName: "Owner", email: `lo-${SUFFIX}@example.com` });
    const cid = (await c.json()).id;
    const res = await api("POST", "/leads", orgToken, { contactId: cid, stage: "new", organizationId: foreignOrgId });
    expect(res.status).toBe(400);
  });

  it("rejects a cross-tenant organizationId on contact update (400)", async () => {
    const c = await api("POST", "/contacts", orgToken, { firstName: "Upd", lastName: "Bind", email: `upd-${SUFFIX}@example.com` });
    const cid = (await c.json()).id;
    const res = await api("PATCH", `/contacts/${cid}`, orgToken, { organizationId: foreignOrgId });
    expect(res.status).toBe(400);
  });
});

describe("Tenant isolation (cross-tenant 404)", () => {
  let foreignOrgId = 0;

  beforeAll(async () => {
    const [foreignOrg] = await db
      .insert(organizationsTable)
      .values({ companyId: foreignCompanyId, name: `QA Isolation Org ${SUFFIX}`, normalizedName: `qa isolation org ${SUFFIX}` })
      .returning();
    foreignOrgId = foreignOrg.id;
  });

  it("does not leak another tenant's organization", async () => {
    expect((await api("GET", `/organizations/${foreignOrgId}`, orgToken)).status).toBe(404);
    expect((await api("PATCH", `/organizations/${foreignOrgId}`, orgToken, { name: "x" })).status).toBe(404);
    expect((await api("DELETE", `/organizations/${foreignOrgId}`, orgToken)).status).toBe(404);
    expect((await api("POST", `/organizations/${foreignOrgId}/archive`, orgToken)).status).toBe(404);
    expect((await api("GET", `/organizations/${foreignOrgId}/contacts`, orgToken)).status).toBe(404);
    expect((await api("GET", `/organizations/${foreignOrgId}/leads`, orgToken)).status).toBe(404);
  });

  it("does not leak another tenant's company-detail aggregate", async () => {
    for (const sub of ["events", "notes", "documents", "timeline"]) {
      expect((await api("GET", `/organizations/${foreignOrgId}/${sub}`, orgToken)).status).toBe(404);
    }
  });
});

describe("Company Detail aggregate (events/notes/documents/timeline)", () => {
  let orgId = 0;
  let eventId = 0;
  let contactId = 0;
  let leadId = 0;

  beforeAll(async () => {
    const org = await api("POST", "/organizations", orgToken, { name: `Aggregate Co ${SUFFIX}` });
    expect(org.status).toBe(201);
    orgId = (await org.json()).id;

    // An event, then a contact linked to BOTH the org and the event — the org's
    // events are DERIVED transitively via contacts.eventId (events have no
    // organizationId of their own).
    const event = await api("POST", "/events", orgToken, { name: `Aggregate Expo ${SUFFIX}`, venue: "Hall A" });
    expect(event.status).toBe(201);
    eventId = (await event.json()).id;

    const contact = await api("POST", "/contacts", orgToken, {
      firstName: "Aggie",
      lastName: "Gate",
      email: `aggie-${SUFFIX}@example.com`,
      organizationId: orgId,
      eventId: String(eventId),
    });
    expect(contact.status).toBe(201);
    contactId = (await contact.json()).id;

    const lead = await api("POST", "/leads", orgToken, {
      contactId,
      stage: "new",
      title: `Aggregate Lead ${SUFFIX}`,
      organizationId: orgId,
    });
    expect(lead.status).toBe(201);
    leadId = (await lead.json()).id;

    const note = await api("POST", `/leads/${leadId}/notes`, orgToken, { body: `Aggregate note ${SUFFIX}` });
    expect(note.status).toBe(201);
  });

  it("derives the org's events from its linked contacts", async () => {
    const res = await api("GET", `/organizations/${orgId}/events`, orgToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.some((e: { id: number }) => e.id === eventId)).toBe(true);
  });

  it("returns notes from the org's linked leads", async () => {
    const res = await api("GET", `/organizations/${orgId}/notes`, orgToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notes.some((n: { body: string }) => n.body === `Aggregate note ${SUFFIX}`)).toBe(true);
  });

  it("returns a documents list (empty when none linked)", async () => {
    const res = await api("GET", `/organizations/${orgId}/documents`, orgToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.documents)).toBe(true);
  });

  it("returns a timeline aggregated from the org's linked records", async () => {
    const res = await api("GET", `/organizations/${orgId}/timeline`, orgToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
  });

  it("view-gates every aggregate endpoint (employee without organizations.view → 403)", async () => {
    const empToken = await loginToken({ email: EMP_EMAIL, password: PW });
    for (const sub of ["events", "notes", "documents", "timeline"]) {
      expect((await api("GET", `/organizations/${orgId}/${sub}`, empToken)).status).toBe(403);
    }
  });
});

describe("Permission enforcement (org data is view-gated, not open)", () => {
  it("blocks an employee without organizations.view from listing (403)", async () => {
    const empToken = await loginToken({ email: EMP_EMAIL, password: PW });
    const res = await api("GET", "/organizations", empToken);
    expect(res.status).toBe(403);
  });

  it("blocks an employee without organizations.create from creating (403)", async () => {
    const empToken = await loginToken({ email: EMP_EMAIL, password: PW });
    const res = await api("POST", "/organizations", empToken, { name: "Sneaky" });
    expect(res.status).toBe(403);
  });

  it("grants organizations.view + create via a custom role, then allows both", async () => {
    const role = await api("POST", "/rbac/roles", orgToken, {
      name: `QA Org Manager ${SUFFIX}`,
      permissions: [
        { module: "organizations", action: "view" },
        { module: "organizations", action: "create" },
      ],
    });
    expect(role.status).toBe(201);
    const roleId = (await role.json()).id;
    expect((await api("PUT", `/users/${empId}/roles`, orgToken, { roleIds: [roleId] })).status).toBe(200);

    const empToken = await loginToken({ email: EMP_EMAIL, password: PW });
    expect((await api("GET", "/organizations", empToken)).status).toBe(200);
    const created = await api("POST", "/organizations", empToken, { name: `Granted Org ${SUFFIX}` });
    expect(created.status).toBe(201);

    // revoke so teardown is clean and other tests are unaffected
    await api("PUT", `/users/${empId}/roles`, orgToken, { roleIds: [] });
  });
});
