import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, contactsTable, scansTable, leadsTable } from "@workspace/db";

const BASE = "http://localhost:80/api";

const TECHCORP = { email: "admin@techcorp.com", password: "Admin123!" };
const NEXUS = { email: "admin@nexussys.io", password: "Admin123!" };

type Session = { token: string; companyId: number };

async function login(creds: { email: string; password: string }): Promise<Session> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  const body = await res.json();
  return { token: body.token, companyId: body.user.companyId };
}

function authHeaders(s: Session) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${s.token}` };
}

// Track every row we create so afterAll can clean up regardless of test outcome.
const createdContactIds: number[] = [];
const createdScanIds: number[] = [];
const createdLeadIds: number[] = [];

async function makeContact(companyId: number, overrides: Partial<typeof contactsTable.$inferInsert> = {}) {
  const [c] = await db
    .insert(contactsTable)
    .values({
      companyId,
      firstName: "Test",
      lastName: "Contact",
      fullName: "Test Contact",
      tags: JSON.stringify([]),
      status: "new",
      ...overrides,
    })
    .returning();
  createdContactIds.push(c.id);
  return c;
}

let tech: Session;
let nexus: Session;

beforeAll(async () => {
  // Preflight: the suite runs against the live API + seeded demo tenants. Fail
  // loudly with actionable context if either assumption is not met.
  let health: Response;
  try {
    health = await fetch(`${BASE}/healthz`);
  } catch (err) {
    throw new Error(`API not reachable at ${BASE} — is the api-server workflow running? (${String(err)})`);
  }
  expect(health.ok, `API health check failed at ${BASE}/healthz (status ${health.status})`).toBe(true);

  try {
    tech = await login(TECHCORP);
    nexus = await login(NEXUS);
  } catch (err) {
    throw new Error(`Demo tenant login failed — are TechCorp/Nexus seeded? (${String(err)})`);
  }
  expect(tech.companyId).toBeTypeOf("number");
  expect(nexus.companyId).toBeTypeOf("number");
  expect(tech.companyId).not.toBe(nexus.companyId);
});

afterAll(async () => {
  if (createdScanIds.length) await db.delete(scansTable).where(inArray(scansTable.id, createdScanIds));
  if (createdLeadIds.length) await db.delete(leadsTable).where(inArray(leadsTable.id, createdLeadIds));
  if (createdContactIds.length) await db.delete(contactsTable).where(inArray(contactsTable.id, createdContactIds));
});

describe("GET /contacts/duplicates — tenant isolation", () => {
  it("only surfaces duplicates within the caller's own tenant", async () => {
    const tag = `dupe-${Date.now()}@iso-test.example`;
    // Two matching contacts in TechCorp and two matching in Nexus, all sharing an email.
    const t1 = await makeContact(tech.companyId, { email: tag });
    const t2 = await makeContact(tech.companyId, { email: tag });
    const n1 = await makeContact(nexus.companyId, { email: tag });
    const n2 = await makeContact(nexus.companyId, { email: tag });

    const res = await fetch(`${BASE}/contacts/duplicates`, { headers: authHeaders(tech) });
    expect(res.status).toBe(200);
    const body = await res.json();

    const returned: { id: number; companyId: number }[] = body.groups.flatMap(
      (g: { contacts: { id: number; companyId: number }[] }) => g.contacts,
    );
    const allIds = new Set<number>(returned.map((c) => c.id));

    // TechCorp's pair is grouped...
    expect(allIds.has(t1.id)).toBe(true);
    expect(allIds.has(t2.id)).toBe(true);
    // ...the specific Nexus contacts never appear...
    expect(allIds.has(n1.id)).toBe(false);
    expect(allIds.has(n2.id)).toBe(false);
    // ...and crucially, EVERY returned contact belongs to the caller's tenant.
    for (const c of returned) {
      expect(c.companyId).toBe(tech.companyId);
    }
  });
});

describe("POST /contacts/:id/enrich — cross-tenant access", () => {
  it("returns 404 when enriching another tenant's contact (no AI work performed)", async () => {
    const nexusContact = await makeContact(nexus.companyId, { email: `enrich-${Date.now()}@x.example` });
    const res = await fetch(`${BASE}/contacts/${nexusContact.id}/enrich`, {
      method: "POST",
      headers: authHeaders(tech),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /contacts/merge — cross-tenant rejection", () => {
  it("rejects (400) merging a duplicate that belongs to a different company", async () => {
    const primary = await makeContact(tech.companyId, { email: `merge-primary-${Date.now()}@x.example` });
    const foreignDup = await makeContact(nexus.companyId, { email: `merge-foreign-${Date.now()}@x.example` });

    const res = await fetch(`${BASE}/contacts/merge`, {
      method: "POST",
      headers: authHeaders(tech),
      body: JSON.stringify({ primaryId: primary.id, duplicateIds: [foreignDup.id] }),
    });
    expect(res.status).toBe(400);

    // Foreign contact must remain untouched.
    const [stillThere] = await db.select().from(contactsTable).where(eq(contactsTable.id, foreignDup.id));
    expect(stillThere).toBeDefined();
  });
});

describe("POST /contacts/merge — FK reassignment + backfill", () => {
  it("reassigns scans/leads to the primary, backfills empty fields, and deletes the duplicate", async () => {
    const primary = await makeContact(tech.companyId, {
      email: `fk-primary-${Date.now()}@x.example`,
      jobTitle: null,
    });
    const dup = await makeContact(tech.companyId, {
      email: `fk-dup-${Date.now()}@x.example`,
      jobTitle: "Sales Director",
    });

    // A scan and a lead that point at the duplicate.
    const [scan] = await db
      .insert(scansTable)
      .values({ companyId: tech.companyId, contactId: dup.id, status: "completed" })
      .returning();
    createdScanIds.push(scan.id);
    const [lead] = await db
      .insert(leadsTable)
      .values({ companyId: tech.companyId, contactId: dup.id, stage: "new" })
      .returning();
    createdLeadIds.push(lead.id);

    const res = await fetch(`${BASE}/contacts/merge`, {
      method: "POST",
      headers: authHeaders(tech),
      body: JSON.stringify({ primaryId: primary.id, duplicateIds: [dup.id] }),
    });
    expect(res.status).toBe(200);

    // Duplicate is gone.
    const remaining = await db.select().from(contactsTable).where(eq(contactsTable.id, dup.id));
    expect(remaining.length).toBe(0);

    // FK rows now reference the primary.
    const [movedScan] = await db.select().from(scansTable).where(eq(scansTable.id, scan.id));
    const [movedLead] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id));
    expect(movedScan.contactId).toBe(primary.id);
    expect(movedLead.contactId).toBe(primary.id);

    // Empty primary field was backfilled from the duplicate.
    const [mergedPrimary] = await db.select().from(contactsTable).where(eq(contactsTable.id, primary.id));
    expect(mergedPrimary.jobTitle).toBe("Sales Director");
  });
});
