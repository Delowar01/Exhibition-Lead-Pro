import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  contactsTable,
  leadsTable,
  eventsTable,
  scansTable,
  tasksTable,
  meetingsTable,
  followUpsTable,
  contactStatusHistoryTable,
  leadHistoryTable,
} from "@workspace/db";
import { updateScoreIfOriginal } from "../src/repositories/contacts.repository.js";

const BASE = "http://localhost:80/api";

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

function authHeaders(s: Session) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${s.token}` };
}

// Track every row we create so afterAll can hard-delete it regardless of outcome.
const createdContactIds: number[] = [];
const createdLeadIds: number[] = [];
const createdEventIds: number[] = [];
const createdScanIds: number[] = [];

async function makeContact(companyId: number, overrides: Partial<typeof contactsTable.$inferInsert> = {}) {
  const [c] = await db.insert(contactsTable).values({
    companyId, firstName: "Soft", lastName: "Delete", fullName: "Soft Delete",
    tags: JSON.stringify([]), status: "new", ...overrides,
  }).returning();
  createdContactIds.push(c.id);
  return c;
}

async function makeEvent(companyId: number, overrides: Partial<typeof eventsTable.$inferInsert> = {}) {
  const [e] = await db.insert(eventsTable).values({ companyId, name: `SD Event ${Date.now()}`, ...overrides }).returning();
  createdEventIds.push(e.id);
  return e;
}

async function makeLead(companyId: number, overrides: Partial<typeof leadsTable.$inferInsert> = {}) {
  const [l] = await db.insert(leadsTable).values({ companyId, stage: "prospect", ...overrides }).returning();
  createdLeadIds.push(l.id);
  return l;
}

let tech: Session;
let nexus: Session;

beforeAll(async () => {
  let health: Response;
  try {
    health = await fetch(`${BASE}/healthz`);
  } catch (err) {
    throw new Error(`API not reachable at ${BASE} — is the api-server workflow running? (${String(err)})`);
  }
  expect(health.ok, `API health check failed at ${BASE}/healthz (status ${health.status})`).toBe(true);
  tech = await login(TECHCORP);
  nexus = await login(NEXUS);
  expect(tech.companyId).not.toBe(nexus.companyId);
});

afterAll(async () => {
  if (createdScanIds.length) await db.delete(scansTable).where(inArray(scansTable.id, createdScanIds));
  if (createdLeadIds.length) await db.delete(leadsTable).where(inArray(leadsTable.id, createdLeadIds));
  if (createdContactIds.length) await db.delete(contactsTable).where(inArray(contactsTable.id, createdContactIds));
  if (createdEventIds.length) await db.delete(eventsTable).where(inArray(eventsTable.id, createdEventIds));
});

describe("DELETE /contacts/:id — soft-delete + read exclusion + cascade parity", () => {
  it("stamps deletedAt (row survives), hides from reads, and replicates the FK cascade", async () => {
    const contact = await makeContact(tech.companyId, { email: `sd-contact-${Date.now()}@x.example`, status: "won" });

    // Child rows that the prior onDelete cascade would have removed (cascade) or nulled (set null).
    await db.insert(meetingsTable).values({ companyId: tech.companyId, contactId: contact.id, status: "scheduled" });
    await db.insert(followUpsTable).values({ companyId: tech.companyId, contactId: contact.id, notes: "F" });
    await db.insert(contactStatusHistoryTable).values({ companyId: tech.companyId, contactId: contact.id, fromStatus: null, toStatus: "new", changedById: tech.userId });
    const lead = await makeLead(tech.companyId, { contactId: contact.id });
    const [scan] = await db.insert(scansTable).values({ companyId: tech.companyId, contactId: contact.id, status: "completed" }).returning();
    createdScanIds.push(scan.id);
    const [task] = await db.insert(tasksTable).values({ companyId: tech.companyId, contactId: contact.id, title: "T", status: "pending" }).returning();

    const res = await fetch(`${BASE}/contacts/${contact.id}`, { method: "DELETE", headers: authHeaders(tech) });
    expect(res.status).toBe(200);

    // Row SURVIVES with a deletedAt stamp (soft-delete, not a hard delete).
    const [row] = await db.select().from(contactsTable).where(eq(contactsTable.id, contact.id));
    expect(row).toBeDefined();
    expect(row.deletedAt).not.toBeNull();

    // Excluded from all reads by default.
    const getRes = await fetch(`${BASE}/contacts/${contact.id}`, { headers: authHeaders(tech) });
    expect(getRes.status).toBe(404);
    const listRes = await fetch(`${BASE}/contacts?limit=200`, { headers: authHeaders(tech) });
    const list = await listRes.json();
    expect(list.contacts.some((c: { id: number }) => c.id === contact.id)).toBe(false);

    // Cascade replication: cascade-delete children removed...
    const meetings = await db.select().from(meetingsTable).where(eq(meetingsTable.contactId, contact.id));
    const followUps = await db.select().from(followUpsTable).where(eq(followUpsTable.contactId, contact.id));
    const history = await db.select().from(contactStatusHistoryTable).where(eq(contactStatusHistoryTable.contactId, contact.id));
    expect(meetings.length).toBe(0);
    expect(followUps.length).toBe(0);
    expect(history.length).toBe(0);

    // ...set-null children nulled (not deleted)...
    const [movedLead] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id));
    const [movedTask] = await db.select().from(tasksTable).where(eq(tasksTable.id, task.id));
    expect(movedLead.contactId).toBeNull();
    expect(movedTask.contactId).toBeNull();

    // ...but scans are INTERACTIONS now: they keep the contact link and are
    // soft-deleted alongside the contact (history preserved, hidden from reads).
    const [movedScan] = await db.select().from(scansTable).where(eq(scansTable.id, scan.id));
    expect(movedScan.contactId).toBe(contact.id);
    expect(movedScan.deletedAt).not.toBeNull();

    await db.delete(tasksTable).where(eq(tasksTable.id, task.id));
  });
});

describe("DELETE /leads/:id — soft-delete + lead_history cascade", () => {
  it("stamps deletedAt, hides from list/pipeline, and cascade-deletes lead_history", async () => {
    const lead = await makeLead(tech.companyId, { stage: "qualified" });
    await db.insert(leadHistoryTable).values({ leadId: lead.id, changedBy: tech.userId, fieldName: "stage", oldValue: "prospect", newValue: "qualified" });

    const res = await fetch(`${BASE}/leads/${lead.id}`, { method: "DELETE", headers: authHeaders(tech) });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id));
    expect(row.deletedAt).not.toBeNull();

    const getRes = await fetch(`${BASE}/leads/${lead.id}`, { headers: authHeaders(tech) });
    expect(getRes.status).toBe(404);

    const histo = await db.select().from(leadHistoryTable).where(eq(leadHistoryTable.leadId, lead.id));
    expect(histo.length).toBe(0);
  });
});

describe("DELETE /events/:id — soft-delete + set-null on contacts/leads", () => {
  it("stamps deletedAt, hides from list, and nulls referencing contacts/leads eventId", async () => {
    const event = await makeEvent(tech.companyId);
    const contact = await makeContact(tech.companyId, { eventId: event.id });
    const lead = await makeLead(tech.companyId, { eventId: event.id });

    const res = await fetch(`${BASE}/events/${event.id}`, { method: "DELETE", headers: authHeaders(tech) });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(eventsTable).where(eq(eventsTable.id, event.id));
    expect(row.deletedAt).not.toBeNull();

    const listRes = await fetch(`${BASE}/events`, { headers: authHeaders(tech) });
    const list = await listRes.json();
    const events = Array.isArray(list) ? list : (list.events ?? []);
    expect(events.some((e: { id: number }) => e.id === event.id)).toBe(false);

    const [movedContact] = await db.select().from(contactsTable).where(eq(contactsTable.id, contact.id));
    const [movedLead] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead.id));
    expect(movedContact.eventId).toBeNull();
    expect(movedLead.eventId).toBeNull();
  });
});

describe("refAccessible — soft-deleted + cross-tenant FK targets are rejected", () => {
  it("rejects (400) creating a contact that references a soft-deleted event", async () => {
    const event = await makeEvent(tech.companyId);
    // Soft-delete the event directly.
    await db.update(eventsTable).set({ deletedAt: new Date() }).where(eq(eventsTable.id, event.id));

    const res = await fetch(`${BASE}/contacts`, {
      method: "POST",
      headers: authHeaders(tech),
      body: JSON.stringify({ firstName: "Ref", lastName: "Check", eventId: event.id }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects (400) creating a contact that references another tenant's event", async () => {
    const foreignEvent = await makeEvent(nexus.companyId);
    const res = await fetch(`${BASE}/contacts`, {
      method: "POST",
      headers: authHeaders(tech),
      body: JSON.stringify({ firstName: "Ref", lastName: "Cross", eventId: foreignEvent.id }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a contact referencing a live, in-tenant event (control)", async () => {
    const event = await makeEvent(tech.companyId);
    const res = await fetch(`${BASE}/contacts`, {
      method: "POST",
      headers: authHeaders(tech),
      body: JSON.stringify({ firstName: "Ref", lastName: "Ok", eventId: event.id }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    if (body?.id) createdContactIds.push(body.id);
    expect(body.eventId).toBe(event.id);
  });
});

describe("background AI scoring — no write to a soft-deleted contact", () => {
  it("updateScoreIfOriginal matches no row once the contact is soft-deleted (parity with the old hard delete)", async () => {
    const contact = await makeContact(tech.companyId, { email: `score-race-${Date.now()}@x.example` });
    // Simulate the contact being deleted while the async scorer is still running.
    await db.update(contactsTable).set({ deletedAt: new Date() }).where(eq(contactsTable.id, contact.id));

    const updated = await updateScoreIfOriginal(contact.id, { leadScore: 99, leadTemperature: "hot", aiReasoning: "x", hotNotifiedAt: new Date(), updatedAt: new Date() });
    expect(updated).toBeUndefined();

    // The deleted row must NOT have received the score (no stale write / hot notify).
    const [row] = await db.select().from(contactsTable).where(eq(contactsTable.id, contact.id));
    expect(row.leadScore).toBeNull();
    expect(row.hotNotifiedAt).toBeNull();
  });
});
