// MOBILE-R2 — later event assignment: POST /contacts/bulk-assign-event (single or
// many contacts; No Event → Event, Event A → Event B, Event → No Event), tenant
// isolation, the write-permission matrix, bounds, validation and the audit trail.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db, contactsTable, eventsTable, usersTable, sessionsTable, auditLogsTable } from "@workspace/db";

const BASE = "http://localhost:80/api";
const TECHCORP = { email: "admin@techcorp.com", password: "Admin123!" };
const NEXUS = { email: "admin@nexussys.io", password: "Admin123!" };

type Session = { token: string; companyId: number; userId: number };

async function login(creds: { email: string; password: string }): Promise<Session> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(creds) });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  const body = await res.json();
  return { token: body.token, companyId: body.user.companyId, userId: body.user.id };
}
function headers(s: Session) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${s.token}` };
}
async function assign(s: Session, body: unknown) {
  const res = await fetch(`${BASE}/contacts/bulk-assign-event`, { method: "POST", headers: headers(s), body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function getContact(s: Session, id: number) {
  const res = await fetch(`${BASE}/contacts/${id}`, { headers: headers(s) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const stamp = Date.now();
const createdContactIds: number[] = [];
const createdEventIds: number[] = [];
const createdUserIds: number[] = [];

async function makeContact(companyId: number, name: string, eventId: number | null = null) {
  const [c] = await db.insert(contactsTable).values({ companyId, firstName: name, lastName: `R2-${stamp}`, fullName: `${name} R2-${stamp}`, tags: JSON.stringify([]), status: "new", eventId }).returning();
  createdContactIds.push(c.id);
  return c;
}
async function makeEvent(companyId: number, name: string) {
  const [e] = await db.insert(eventsTable).values({ companyId, name, status: "active" }).returning();
  createdEventIds.push(e.id);
  return e;
}
async function makeUser(email: string, companyId: number, permissions: Record<string, string[]>, hash: string): Promise<Session> {
  const [u] = await db.insert(usersTable).values({ email, passwordHash: hash, name: "R2 employee", role: "employee", companyId, permissions, isActive: true }).returning();
  createdUserIds.push(u.id);
  return login({ email, password: TECHCORP.password });
}

let tech: Session;
let nexus: Session;
let leap: { id: number; name: string };
let gitex: { id: number; name: string };
let foreign: { id: number; name: string };

beforeAll(async () => {
  const health = await fetch(`${BASE}/healthz`).catch((err) => { throw new Error(`API not reachable at ${BASE}: ${String(err)}`); });
  expect(health.ok).toBe(true);
  tech = await login(TECHCORP);
  nexus = await login(NEXUS);
  expect(tech.companyId).not.toBe(nexus.companyId);
  leap = await makeEvent(tech.companyId, `LEAP 2026 ${stamp}`);
  gitex = await makeEvent(tech.companyId, `GITEX 2026 ${stamp}`);
  foreign = await makeEvent(nexus.companyId, `Nexus Expo ${stamp}`);
});

afterAll(async () => {
  if (createdContactIds.length) {
    await db.delete(auditLogsTable).where(and(eq(auditLogsTable.action, "contacts.event_assign"), inArray(auditLogsTable.entityId, createdContactIds.map(String))));
    await db.delete(contactsTable).where(inArray(contactsTable.id, createdContactIds));
  }
  if (createdEventIds.length) await db.delete(eventsTable).where(inArray(eventsTable.id, createdEventIds));
  if (createdUserIds.length) {
    await db.delete(sessionsTable).where(inArray(sessionsTable.userId, createdUserIds));
    await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
  }
});

describe("POST /contacts/bulk-assign-event — the three moves", () => {
  it("No Event → Event (single and many), with an audit entry per changed contact", async () => {
    const c1 = await makeContact(tech.companyId, "Alpha");
    const c2 = await makeContact(tech.companyId, "Beta");
    const r = await assign(tech, { contactIds: [c1.id, c2.id, c1.id], eventId: leap.id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ updated: 2, unchanged: 0, skipped: 0, eventId: leap.id, eventName: leap.name });
    expect([...r.body.contactIds].sort()).toEqual([c1.id, c2.id].sort());
    const g = await getContact(tech, c1.id);
    expect(g.status).toBe(200);
    expect(g.body.eventId).toBe(leap.id);
    expect(g.body.eventName).toBe(leap.name);
    const audits = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.action, "contacts.event_assign"), inArray(auditLogsTable.entityId, [String(c1.id), String(c2.id)])));
    expect(audits).toHaveLength(2);
    for (const a of audits) {
      expect(a.companyId).toBe(tech.companyId);
      expect(a.userId).toBe(tech.userId);
      expect(a.entityType).toBe("contact");
      expect((a.metadata as Record<string, unknown>).summary).toBe(`No Event → ${leap.name}`);
      expect((a.metadata as Record<string, unknown>).toEventId).toBe(leap.id);
      expect((a.metadata as Record<string, unknown>).fromEventId).toBeNull();
    }
    // Single contact through the same contract (the mobile detail screen path).
    const c3 = await makeContact(tech.companyId, "Gamma");
    const single = await assign(tech, { contactIds: [c3.id], eventId: leap.id });
    expect(single.status).toBe(200);
    expect(single.body.updated).toBe(1);
    expect((await getContact(tech, c3.id)).body.eventName).toBe(leap.name);
  });

  it("Event A → Event B records 'A → B'; an already-assigned contact is reported unchanged", async () => {
    const c = await makeContact(tech.companyId, "Delta", leap.id);
    const r = await assign(tech, { contactIds: [c.id], eventId: gitex.id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ updated: 1, unchanged: 0, skipped: 0, eventId: gitex.id, eventName: gitex.name });
    expect((await getContact(tech, c.id)).body.eventId).toBe(gitex.id);
    const [a] = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.action, "contacts.event_assign"), eq(auditLogsTable.entityId, String(c.id))));
    expect((a.metadata as Record<string, unknown>).summary).toBe(`${leap.name} → ${gitex.name}`);
    const again = await assign(tech, { contactIds: [c.id], eventId: gitex.id });
    expect(again.body).toMatchObject({ updated: 0, unchanged: 1, skipped: 0, contactIds: [] });
  });

  it("Event → No Event clears the event and records 'A → No Event'", async () => {
    const c = await makeContact(tech.companyId, "Epsilon", leap.id);
    const r = await assign(tech, { contactIds: [c.id], eventId: null });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ updated: 1, eventId: null, eventName: null });
    const g = await getContact(tech, c.id);
    expect(g.body.eventId).toBeNull();
    expect(g.body.eventName ?? null).toBeNull();
    const [a] = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.action, "contacts.event_assign"), eq(auditLogsTable.entityId, String(c.id))));
    expect((a.metadata as Record<string, unknown>).summary).toBe(`${leap.name} → No Event`);
  });
});

describe("POST /contacts/bulk-assign-event — tenant isolation", () => {
  it("another tenant's contacts are skipped, never updated (ids are not disclosed as existing)", async () => {
    const n1 = await makeContact(nexus.companyId, "NexusOne");
    const r = await assign(tech, { contactIds: [n1.id], eventId: leap.id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ updated: 0, unchanged: 0, skipped: 1, contactIds: [] });
    const [row] = await db.select().from(contactsTable).where(eq(contactsTable.id, n1.id));
    expect(row.eventId).toBeNull();
  });

  it("another tenant's event answers 404 and changes nothing (not 403: existence is not revealed)", async () => {
    const c = await makeContact(tech.companyId, "Zeta");
    const r = await assign(tech, { contactIds: [c.id], eventId: foreign.id });
    expect(r.status).toBe(404);
    const [row] = await db.select().from(contactsTable).where(eq(contactsTable.id, c.id));
    expect(row.eventId).toBeNull();
    // The foreign tenant with its own event cannot reach TechCorp's contact either.
    const r2 = await assign(nexus, { contactIds: [c.id], eventId: foreign.id });
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ updated: 0, skipped: 1 });
  });

  it("a soft-deleted contact is skipped", async () => {
    const c = await makeContact(tech.companyId, "Deleted");
    await db.update(contactsTable).set({ deletedAt: new Date() }).where(eq(contactsTable.id, c.id));
    const r = await assign(tech, { contactIds: [c.id], eventId: leap.id });
    expect(r.body).toMatchObject({ updated: 0, skipped: 1 });
  });
});

describe("POST /contacts/bulk-assign-event — permissions, bounds, validation", () => {
  it("an employee without the contacts edit permission is refused (403); with it the assignment succeeds", async () => {
    const [adminRow] = await db.select({ hash: usersTable.passwordHash }).from(usersTable).where(eq(usersTable.email, TECHCORP.email));
    const viewer = await makeUser(`r2-viewer-${stamp}@example.com`, tech.companyId, { contacts: ["view"] }, adminRow.hash);
    const editor = await makeUser(`r2-editor-${stamp}@example.com`, tech.companyId, { contacts: ["view", "edit"] }, adminRow.hash);
    const c = await makeContact(tech.companyId, "Perm");
    expect((await assign(viewer, { contactIds: [c.id], eventId: leap.id })).status).toBe(403);
    const ok = await assign(editor, { contactIds: [c.id], eventId: leap.id });
    expect(ok.status).toBe(200);
    expect(ok.body.updated).toBe(1);
  });

  it("unauthenticated requests are refused", async () => {
    const res = await fetch(`${BASE}/contacts/bulk-assign-event`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contactIds: [1], eventId: null }) });
    expect(res.status).toBe(401);
  });

  it("is bounded to 200 ids and validates the body", async () => {
    const many = Array.from({ length: 201 }, (_, i) => 1_000_000 + i);
    expect((await assign(tech, { contactIds: many, eventId: null })).status).toBe(400);
    expect((await assign(tech, { contactIds: [], eventId: null })).status).toBe(400);
    expect((await assign(tech, { contactIds: ["x"], eventId: null })).status).toBe(400);
    expect((await assign(tech, { contactIds: [1], eventId: "LEAP" })).status).toBe(400);
    expect((await assign(tech, { contactIds: [1] })).status).toBe(400); // eventId is required (null = clear)
    expect((await assign(tech, { eventId: null })).status).toBe(400);
  });
});
