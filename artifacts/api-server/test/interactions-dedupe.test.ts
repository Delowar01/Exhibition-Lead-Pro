import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db, contactsTable, scansTable } from "@workspace/db";
import { MATCH_WEIGHTS, DUPLICATE_PROMPT_THRESHOLD } from "../src/services/contacts.service.js";

// Task: Contact vs Interaction model + weighted duplicate detection.
// Runs against the LIVE API at localhost:80 with seeded demo tenants.

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

const createdContactIds: number[] = [];

async function createContact(s: Session, payload: Record<string, unknown>): Promise<Response> {
  const res = await fetch(`${BASE}/contacts`, { method: "POST", headers: authHeaders(s), body: JSON.stringify(payload) });
  if (res.status === 201) {
    const clone = res.clone();
    const body = await clone.json();
    if (body?.id) createdContactIds.push(body.id);
  }
  return res;
}

let tech: Session;
let nexus: Session;
const uniq = Date.now().toString(36);

beforeAll(async () => {
  const health = await fetch(`${BASE}/healthz`);
  expect(health.ok, `API not healthy at ${BASE}/healthz`).toBe(true);
  tech = await login(TECHCORP);
  nexus = await login(NEXUS);
});

afterAll(async () => {
  if (createdContactIds.length) {
    await db.delete(scansTable).where(inArray(scansTable.contactId, createdContactIds));
    await db.delete(contactsTable).where(inArray(contactsTable.id, createdContactIds));
  }
});

describe("weighted match model constants", () => {
  it("tiers are ordered highest→low and the prompt threshold sits at HIGH tier", () => {
    expect(MATCH_WEIGHTS.email).toBe(100);
    expect(MATCH_WEIGHTS.mobile).toBeLessThan(MATCH_WEIGHTS.email);
    expect(MATCH_WEIGHTS.linkedin).toBeLessThan(MATCH_WEIGHTS.mobile);
    expect(MATCH_WEIGHTS.officePhone).toBeLessThanOrEqual(MATCH_WEIGHTS.linkedin);
    expect(MATCH_WEIGHTS.nameCompany).toBeLessThan(MATCH_WEIGHTS.officePhone);
    expect(MATCH_WEIGHTS.nameOnly).toBeLessThan(MATCH_WEIGHTS.nameCompany);
    expect(MATCH_WEIGHTS.companyOnly).toBeLessThan(MATCH_WEIGHTS.nameOnly);
    expect(MATCH_WEIGHTS.website).toBeLessThan(MATCH_WEIGHTS.companyOnly);
    expect(MATCH_WEIGHTS.address).toBeLessThan(MATCH_WEIGHTS.website);
    // Suggestive signals must NEVER reach the human-in-the-loop prompt on their own.
    expect(MATCH_WEIGHTS.nameCompany).toBeLessThan(DUPLICATE_PROMPT_THRESHOLD);
    expect(MATCH_WEIGHTS.nameOnly).toBeLessThan(DUPLICATE_PROMPT_THRESHOLD);
    expect(MATCH_WEIGHTS.fuzzyNameSameCompany).toBeLessThan(DUPLICATE_PROMPT_THRESHOLD);
    // Unique identifiers must always trigger the prompt.
    expect(MATCH_WEIGHTS.email).toBeGreaterThanOrEqual(DUPLICATE_PROMPT_THRESHOLD);
    expect(MATCH_WEIGHTS.mobile).toBeGreaterThanOrEqual(DUPLICATE_PROMPT_THRESHOLD);
    expect(MATCH_WEIGHTS.officePhone).toBeGreaterThanOrEqual(DUPLICATE_PROMPT_THRESHOLD);
  });
});

describe("POST /contacts — human-in-the-loop 409 dedupe flow", () => {
  it("returns 409 existing_contact_found on a same-email re-capture and NEVER auto-merges", async () => {
    const first = await createContact(tech, {
      firstName: "Dana", lastName: `Dupe${uniq}`, email: `dana.dupe.${uniq}@example.com`, contactCompany: "DupeCo",
    });
    expect(first.status).toBe(201);
    const original = await first.json();

    const second = await createContact(tech, {
      firstName: "Dana", lastName: `Dupe${uniq}`, email: `dana.dupe.${uniq}@example.com`,
    });
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.code).toBe("existing_contact_found");
    expect(body.contact.id).toBe(original.id);
    expect(body.interactionCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.previousEvents)).toBe(true);
    expect(body.matches[0].confidence).toBeGreaterThanOrEqual(DUPLICATE_PROMPT_THRESHOLD);
    expect(body.matches[0].reasons).toContain("Same email address");
  });

  it("does NOT prompt on a name-only match (below threshold)", async () => {
    const res = await createContact(tech, { firstName: "Dana", lastName: `Dupe${uniq}` });
    expect(res.status).toBe(201);
  });

  it("dedupeResolution=add_interaction returns the EXISTING contact and appends an interaction", async () => {
    const email = `iris.inter.${uniq}@example.com`;
    const first = await createContact(tech, { firstName: "Iris", lastName: `Inter${uniq}`, email });
    const original = await first.json();

    const before = await (await fetch(`${BASE}/contacts/${original.id}/interactions`, { headers: authHeaders(tech) })).json();

    const res = await createContact(tech, {
      firstName: "Iris", lastName: `Inter${uniq}`, email,
      dedupeResolution: "add_interaction", matchedContactId: original.id,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(original.id);

    const after = await (await fetch(`${BASE}/contacts/${original.id}/interactions`, { headers: authHeaders(tech) })).json();
    expect(after.total).toBe(before.total + 1);
    expect(after.interactions[0]).toMatchObject({ contactId: original.id });
    expect(after.interactions[0].captureSource).toBeTruthy();
  });

  it("add_interaction without matchedContactId is a 400", async () => {
    const res = await createContact(tech, {
      firstName: "No", lastName: `Target${uniq}`, dedupeResolution: "add_interaction",
    });
    expect(res.status).toBe(400);
  });

  it("add_interaction with a cross-tenant matchedContactId is rejected", async () => {
    const other = await createContact(nexus, { firstName: "Nex", lastName: `Own${uniq}`, email: `nex.own.${uniq}@example.com` });
    const otherContact = await other.json();
    const res = await createContact(tech, {
      firstName: "Nex", lastName: `Own${uniq}`,
      dedupeResolution: "add_interaction", matchedContactId: otherContact.id,
    });
    expect([400, 404]).toContain(res.status);
  });

  it("dedupeResolution=create_separate creates a distinct contact despite the match", async () => {
    const email = `sep.arate.${uniq}@example.com`;
    const first = await createContact(tech, { firstName: "Sep", lastName: `Arate${uniq}`, email });
    const original = await first.json();
    const res = await createContact(tech, {
      firstName: "Sep", lastName: `Arate${uniq}`, email, dedupeResolution: "create_separate",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).not.toBe(original.id);
  });
});

describe("GET /contacts/:id/interactions", () => {
  it("every created contact has at least one (synthetic manual) interaction", async () => {
    const res = await createContact(tech, { firstName: "Solo", lastName: `Capture${uniq}` });
    const c = await res.json();
    const list = await (await fetch(`${BASE}/contacts/${c.id}/interactions`, { headers: authHeaders(tech) })).json();
    expect(list.total).toBeGreaterThanOrEqual(1);
    const i = list.interactions[0];
    expect(i.captureSource).toBe("manual");
    expect(i.userName).toBeTruthy();
    expect(i.occurredAt).toBeTruthy();
  });

  it("is tenant-isolated (cross-tenant read → 404)", async () => {
    const res = await createContact(tech, { firstName: "Iso", lastName: `Lated${uniq}` });
    const c = await res.json();
    const cross = await fetch(`${BASE}/contacts/${c.id}/interactions`, { headers: authHeaders(nexus) });
    expect(cross.status).toBe(404);
  });

  it("interactions appear in the contact timeline", async () => {
    const res = await createContact(tech, { firstName: "Tim", lastName: `Eline${uniq}` });
    const c = await res.json();
    const tl = await (await fetch(`${BASE}/contacts/${c.id}/timeline`, { headers: authHeaders(tech) })).json();
    expect(tl.entries.some((e: { kind: string }) => e.kind === "interaction")).toBe(true);
  });
});

describe("soft-delete keeps interaction history recoverable", () => {
  it("deleting a contact soft-deletes its interaction scans (deletedAt set, rows kept)", async () => {
    const res = await createContact(tech, { firstName: "Gone", lastName: `SoftDel${uniq}` });
    const c = await res.json();
    const del = await fetch(`${BASE}/contacts/${c.id}`, { method: "DELETE", headers: authHeaders(tech) });
    expect(del.ok).toBe(true);
    const rows = await db.select({ id: scansTable.id, deletedAt: scansTable.deletedAt }).from(scansTable).where(eq(scansTable.contactId, c.id));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) expect(r.deletedAt).not.toBeNull();
  });
});
