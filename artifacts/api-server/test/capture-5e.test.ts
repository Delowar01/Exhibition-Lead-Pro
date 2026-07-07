import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db, contactsTable, leadsTable } from "@workspace/db";

// Stage 5E Enterprise Intelligent Capture — integration coverage against the
// live API + seeded demo tenants. Verifies the advisory-only analyze endpoint:
// recognition enrichment flags, similar-record warnings, honest "insufficient"
// reporting, and city/postalCode field round-trips. Read-only by contract —
// analyze must never create/link/merge CRM rows.

const BASE = "http://localhost:80/api";
const TECHCORP = { email: "admin@techcorp.com", password: "Admin123!" };

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

const createdContactIds: number[] = [];
const createdLeadIds: number[] = [];

async function makeContact(companyId: number, overrides: Partial<typeof contactsTable.$inferInsert> = {}) {
  const [c] = await db
    .insert(contactsTable)
    .values({
      companyId,
      firstName: "Cap",
      lastName: "Five",
      fullName: "Cap Five",
      tags: JSON.stringify([]),
      status: "new",
      ...overrides,
    })
    .returning();
  createdContactIds.push(c.id);
  return c;
}

async function analyze(s: Session, fields: Record<string, string>) {
  const res = await fetch(`${BASE}/scans/analyze`, {
    method: "POST",
    headers: authHeaders(s),
    body: JSON.stringify({ fields, includeAi: false }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

let tech: Session;

beforeAll(async () => {
  const health = await fetch(`${BASE}/healthz`).catch((err) => {
    throw new Error(`API not reachable at ${BASE} — is the api-server workflow running? (${String(err)})`);
  });
  expect(health.ok, `API health check failed (status ${health.status})`).toBe(true);
  tech = await login(TECHCORP);
});

afterAll(async () => {
  if (createdLeadIds.length) await db.delete(leadsTable).where(inArray(leadsTable.id, createdLeadIds));
  if (createdContactIds.length) await db.delete(contactsTable).where(inArray(contactsTable.id, createdContactIds));
});

describe("POST /scans/analyze — recognition enrichment (Stage 5E)", () => {
  it("flags an exact contact match as an active lead with leadCount", async () => {
    const email = `enrich5e-${Date.now()}@cap5e.example`;
    const c = await makeContact(tech.companyId, { email, contactCompany: "Cap5E Corp" });
    const [lead] = await db
      .insert(leadsTable)
      .values({
        companyId: tech.companyId,
        contactId: c.id,
        title: "5E enrichment lead",
        stage: "qualified",
      })
      .returning();
    createdLeadIds.push(lead.id);

    const body = await analyze(tech, { email });
    const match = body.contactMatches.find((m: { contactId: number }) => m.contactId === c.id);
    expect(match, "exact email match should surface the contact").toBeTruthy();
    expect(match.isLead).toBe(true);
    expect(match.leadCount).toBeGreaterThanOrEqual(1);
    expect(match.isCustomer).toBe(false);
  });
});

describe("POST /scans/analyze — similar-record warnings (Stage 5E)", () => {
  it("warns on a same-mailbox different-domain email without auto-linking", async () => {
    const stamp = Date.now();
    const local = `mailbox5e${stamp}`;
    const c = await makeContact(tech.companyId, { email: `${local}@domain-a.example` });

    const body = await analyze(tech, { email: `${local}@domain-b.example` });
    const warn = body.similarWarnings.find(
      (w: { kind: string; contactId?: number }) => w.kind === "similar_email" && w.contactId === c.id,
    );
    expect(warn, "similar_email warning expected for same mailbox at a different domain").toBeTruthy();
    expect(warn.confidence).toBeGreaterThan(0);
    expect(typeof warn.message).toBe("string");
    // The exact-match list must NOT contain the similar (non-identical) contact.
    const ids = body.contactMatches.map((m: { contactId: number }) => m.contactId);
    expect(ids).not.toContain(c.id);
  });

  it("analyze is read-only: no contact rows are created by analysis", async () => {
    const email = `readonly5e-${Date.now()}@nowhere.example`;
    await analyze(tech, { email, firstName: "Ghost", lastName: "Card" });
    const rows = await db.select().from(contactsTable).where(inArray(contactsTable.email, [email]));
    expect(rows.length).toBe(0);
  });
});

describe("POST /scans/analyze — honest insufficiency (Stage 5E)", () => {
  it("reports gap fields as insufficient instead of guessing", async () => {
    // Only a personal-looking name + free email — no company/website/country signal.
    const body = await analyze(tech, { firstName: "Nn", lastName: "Oo" });
    expect(Array.isArray(body.insufficient)).toBe(true);
    for (const f of body.insufficient) {
      expect(["website", "country", "industry"]).toContain(f);
    }
    // A field listed as insufficient must not also carry a suggestion.
    const suggested = new Set(body.suggestions.map((s: { field: string }) => s.field));
    for (const f of body.insufficient) expect(suggested.has(f)).toBe(false);
  });
});

describe("Contacts — city/postalCode field coverage (Stage 5E)", () => {
  it("round-trips city and postalCode through create and get", async () => {
    const res = await fetch(`${BASE}/contacts`, {
      method: "POST",
      headers: authHeaders(tech),
      body: JSON.stringify({
        firstName: "City",
        lastName: "Postal",
        email: `citypostal-${Date.now()}@cap5e.example`,
        city: "Riyadh",
        postalCode: "11564",
        country: "Saudi Arabia",
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    createdContactIds.push(created.id);
    expect(created.city).toBe("Riyadh");
    expect(created.postalCode).toBe("11564");

    const getRes = await fetch(`${BASE}/contacts/${created.id}`, { headers: authHeaders(tech) });
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.city).toBe("Riyadh");
    expect(fetched.postalCode).toBe("11564");

    const patch = await fetch(`${BASE}/contacts/${created.id}`, {
      method: "PATCH",
      headers: authHeaders(tech),
      body: JSON.stringify({ city: "Jeddah", postalCode: "21577" }),
    });
    expect(patch.status).toBe(200);
    const updated = await patch.json();
    expect(updated.city).toBe("Jeddah");
    expect(updated.postalCode).toBe("21577");
  });
});
