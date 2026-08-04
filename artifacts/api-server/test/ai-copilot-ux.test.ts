import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  contactsTable,
  leadsTable,
  leadActivitiesTable,
  aiCopilotOutputsTable,
  aiSettingsTable,
} from "@workspace/db";

// Batch 5 — AI Copilot UX completion. Exercises the new "Save as Note" endpoint
// (POST /contacts/:id/notes) and the regeneration-failure retention contract on
// POST /ai/copilot/... against the LIVE API (localhost:80).
//
// No live Gemini is ever exercised: tenant A has AI DISABLED via PATCH /ai/settings,
// so every LLM-only generation deterministically fails inside the provider gate
// (403 "AI features are disabled") and takes the soft-degrade path, while
// deterministic cores (followup/coaching) still succeed. This makes the failure
// contracts fully testable offline:
//   - a failed re-generation must KEEP a previously usable draft (generationFailed: true)
//   - a fresh failure still stores the { unavailable: true } placeholder (HTTP 200)
//   - generate/use never write communications (nothing is auto-sent)
// All fixtures live under throwaway tenants torn down in afterAll.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const DOMAIN = `copilotux-${SUFFIX}.test`;
const DOMAIN_B = `copilotuxb-${SUFFIX}.test`;
const ADMIN_EMAIL = `qa-admin@${DOMAIN}`;
const EMP_EMAIL = `qa-emp@${DOMAIN}`;
const ADMIN_B_EMAIL = `qa-admin@${DOMAIN_B}`;

let companyId = 0;
let companyBId = 0;
let platformToken = "";
let adminToken = "";
let empToken = "";
let adminBToken = "";

let contactId = 0;
let leadId = 0;
let adminUserId = 0;

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

async function createUser(token: string, email: string, name: string, role: string, companyForPlatform?: number): Promise<number> {
  const payload: Record<string, unknown> = { email, name, role, password: PW };
  if (companyForPlatform != null) payload.companyId = companyForPlatform;
  const res = await api("POST", "/users", token, payload);
  expect(res.status, `create user ${email}`).toBe(201);
  return (await res.json()).id;
}

async function communicationsCount(token: string, cid: number): Promise<number> {
  const res = await api("GET", `/contacts/${cid}/communications`, token);
  expect(res.status).toBe(200);
  const data = await res.json();
  return (data.communications ?? []).length;
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

  // --- Tenant A ---
  const createCo = await api("POST", "/companies", platformToken, { name: `QA CopilotUX ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  adminUserId = await createUser(platformToken, ADMIN_EMAIL, "QA CopilotUX Admin", "primary_admin", companyId);
  adminToken = await loginToken({ email: ADMIN_EMAIL, password: PW });
  // Employee with default (empty) permissions — deny-by-default on contacts.edit.
  await createUser(adminToken, EMP_EMAIL, "QA CopilotUX Emp", "employee");
  empToken = await loginToken({ email: EMP_EMAIL, password: PW });

  // Disable AI for tenant A so LLM-only generations fail deterministically (no live Gemini).
  const patch = await api("PATCH", "/ai/settings", adminToken, { enabled: false });
  expect(patch.status).toBe(200);

  const c1 = await api("POST", "/contacts", adminToken, {
    firstName: "Nora",
    lastName: "Quinn",
    email: `nora.quinn-${SUFFIX}@example.com`,
    mobile: "+1 (555) 010-3000",
    jobTitle: "Head of Ops",
    contactCompany: "Initech",
    status: "new",
  });
  expect(c1.status).toBe(201);
  contactId = (await c1.json()).id;

  const l1 = await api("POST", "/leads", adminToken, { contactId, stage: "new", title: "QA UX opportunity", value: 900, currency: "USD" });
  expect(l1.status).toBe(201);
  leadId = (await l1.json()).id;

  // --- Tenant B (cross-tenant isolation) ---
  const createCoB = await api("POST", "/companies", platformToken, { name: `QA CopilotUX B ${SUFFIX}`, plan: "professional" });
  expect(createCoB.status).toBe(201);
  companyBId = (await createCoB.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyBId));
  await createUser(platformToken, ADMIN_B_EMAIL, "QA CopilotUX Admin B", "primary_admin", companyBId);
  adminBToken = await loginToken({ email: ADMIN_B_EMAIL, password: PW });
});

afterAll(async () => {
  for (const cid of [companyId, companyBId]) {
    if (!cid) continue;
    await db.delete(aiCopilotOutputsTable).where(eq(aiCopilotOutputsTable.companyId, cid));
    await db.delete(aiSettingsTable).where(eq(aiSettingsTable.companyId, cid));
    await db.delete(leadActivitiesTable).where(eq(leadActivitiesTable.companyId, cid));
    await db.delete(leadsTable).where(eq(leadsTable.companyId, cid));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, cid));
    await db.delete(usersTable).where(eq(usersTable.companyId, cid));
    await db.delete(companiesTable).where(eq(companiesTable.id, cid));
  }
});

describe("POST /contacts/:id/notes — Save as Note", () => {
  it("creates a timeline note with AI provenance metadata and shows it on the contact timeline", async () => {
    const body = `Follow up with Nora about the Initech rollout. (${SUFFIX})`;
    const res = await api("POST", `/contacts/${contactId}/notes`, adminToken, {
      body,
      subject: "AI draft — Email",
      aiGenerated: true,
      aiOutputType: "email",
    });
    expect(res.status).toBe(201);
    const note = await res.json();
    expect(note.type).toBe("note");
    expect(note.source).toBe("manual");
    expect(note.contactId).toBe(contactId);
    expect(note.leadId).toBeNull();
    expect(note.body).toBe(body);
    expect(note.subject).toBe("AI draft — Email");
    expect(note.metadata).toMatchObject({ aiGenerated: true, aiOutputType: "email" });

    const tl = await api("GET", `/contacts/${contactId}/timeline`, adminToken);
    expect(tl.status).toBe(200);
    const entries = (await tl.json()).entries ?? [];
    const found = entries.find((e: { body?: string | null }) => e.body === body);
    expect(found, "note must appear on the contact timeline").toBeTruthy();
  });

  it("is idempotent for rapid duplicate submissions (same author + body)", async () => {
    const body = `Duplicate-guard note ${SUFFIX}`;
    const first = await api("POST", `/contacts/${contactId}/notes`, adminToken, { body });
    expect(first.status).toBe(201);
    const firstNote = await first.json();

    const second = await api("POST", `/contacts/${contactId}/notes`, adminToken, { body });
    expect(second.status).toBe(200); // duplicate → existing row, not a new one
    const secondNote = await second.json();
    expect(secondNote.id).toBe(firstNote.id);

    const rows = await db
      .select()
      .from(leadActivitiesTable)
      .where(and(eq(leadActivitiesTable.companyId, companyId), eq(leadActivitiesTable.contactId, contactId), eq(leadActivitiesTable.body, body)));
    expect(rows.length).toBe(1);
  });

  it("concurrent identical submissions produce exactly one row (atomic duplicate window)", async () => {
    const body = `Concurrent-guard note ${SUFFIX}`;
    const [a, b] = await Promise.all([
      api("POST", `/contacts/${contactId}/notes`, adminToken, { body }),
      api("POST", `/contacts/${contactId}/notes`, adminToken, { body }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 201]); // one fresh insert, one duplicate reuse
    const [noteA, noteB] = await Promise.all([a.json(), b.json()]);
    expect(noteA.id).toBe(noteB.id);

    const rows = await db
      .select()
      .from(leadActivitiesTable)
      .where(and(eq(leadActivitiesTable.companyId, companyId), eq(leadActivitiesTable.contactId, contactId), eq(leadActivitiesTable.body, body)));
    expect(rows.length).toBe(1);
  });

  it("a different body is a new note (guard does not over-dedupe)", async () => {
    const res = await api("POST", `/contacts/${contactId}/notes`, adminToken, { body: `Another note ${SUFFIX}-2` });
    expect(res.status).toBe(201);
  });

  it("plain note without AI flags stores null metadata", async () => {
    const res = await api("POST", `/contacts/${contactId}/notes`, adminToken, { body: `Plain note ${SUFFIX}` });
    expect(res.status).toBe(201);
    const note = await res.json();
    expect(note.metadata).toBeNull();
  });

  it("rejects an empty body (400)", async () => {
    const res = await api("POST", `/contacts/${contactId}/notes`, adminToken, { body: "" });
    expect(res.status).toBe(400);
  });

  it("requires contacts.edit — employee with default permissions gets 403", async () => {
    const res = await api("POST", `/contacts/${contactId}/notes`, empToken, { body: "should be denied" });
    expect(res.status).toBe(403);
  });

  it("is tenant-scoped — tenant B admin gets 404 on tenant A's contact", async () => {
    const res = await api("POST", `/contacts/${contactId}/notes`, adminBToken, { body: "cross-tenant attempt" });
    expect(res.status).toBe(404);
  });
});

describe("Copilot regeneration failure retention (AI disabled → deterministic failure path)", () => {
  it("keeps a previously usable draft when re-generation fails, flagging generationFailed", async () => {
    // Seed a known-good stored draft for (contact, email) directly (the API cannot
    // produce one here because AI is disabled for the tenant — which is the point).
    const goodContent = { subject: "Hello Nora", body: "Original good draft", tone: "professional" };
    await db.delete(aiCopilotOutputsTable).where(
      and(
        eq(aiCopilotOutputsTable.companyId, companyId),
        eq(aiCopilotOutputsTable.entityType, "contact"),
        eq(aiCopilotOutputsTable.entityId, contactId),
        eq(aiCopilotOutputsTable.outputType, "email"),
      ),
    );
    const [seeded] = await db
      .insert(aiCopilotOutputsTable)
      .values({
        companyId,
        entityType: "contact",
        entityId: contactId,
        outputType: "email",
        content: goodContent,
        source: "ai",
        provider: "gemini",
        model: "gemini-2.5-flash",
        language: "en",
        status: "generated",
      })
      .returning();

    const res = await api("POST", `/ai/copilot/contact/${contactId}/email`, adminToken, {});
    expect(res.status).toBe(200); // soft-degrade contract: never 500
    const out = await res.json();
    expect(out.generationFailed).toBe(true);
    expect(out.content).toMatchObject(goodContent);
    expect(out.id).toBe(seeded.id);

    // The stored row must be untouched (no placeholder overwrite).
    const [row] = await db.select().from(aiCopilotOutputsTable).where(eq(aiCopilotOutputsTable.id, seeded.id));
    expect(row.content).toMatchObject(goodContent);
    expect((row.content as Record<string, unknown>).unavailable).toBeUndefined();
  });

  it("also preserves a human-edited draft on failed re-generation", async () => {
    const edited = { message: "Edited by a human, must survive" };
    await db.delete(aiCopilotOutputsTable).where(
      and(
        eq(aiCopilotOutputsTable.companyId, companyId),
        eq(aiCopilotOutputsTable.entityType, "contact"),
        eq(aiCopilotOutputsTable.entityId, contactId),
        eq(aiCopilotOutputsTable.outputType, "whatsapp"),
      ),
    );
    const [seeded] = await db
      .insert(aiCopilotOutputsTable)
      .values({
        companyId,
        entityType: "contact",
        entityId: contactId,
        outputType: "whatsapp",
        content: { unavailable: true, note: "placeholder from an earlier failure" },
        editedContent: edited,
        source: "ai",
        language: "en",
        status: "edited",
      })
      .returning();

    const res = await api("POST", `/ai/copilot/contact/${contactId}/whatsapp`, adminToken, {});
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.generationFailed).toBe(true);
    expect(out.editedContent).toMatchObject(edited);

    const [row] = await db.select().from(aiCopilotOutputsTable).where(eq(aiCopilotOutputsTable.id, seeded.id));
    expect(row.editedContent).toMatchObject(edited);
    expect(row.status).toBe("edited");
  });

  it("a FRESH failure (no previous draft) still stores the unavailable placeholder at HTTP 200", async () => {
    await db.delete(aiCopilotOutputsTable).where(
      and(
        eq(aiCopilotOutputsTable.companyId, companyId),
        eq(aiCopilotOutputsTable.entityType, "lead"),
        eq(aiCopilotOutputsTable.entityId, leadId),
        eq(aiCopilotOutputsTable.outputType, "proposal"),
      ),
    );
    const res = await api("POST", `/ai/copilot/lead/${leadId}/proposal`, adminToken, {});
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.content.unavailable).toBe(true);
    expect(typeof out.content.note).toBe("string");
    expect(out.generationFailed).toBeUndefined();
  });

  it("a failed re-generation over an existing placeholder just refreshes the placeholder (no false retention)", async () => {
    // Same (lead, proposal) slot as above — currently holds a placeholder, no edit.
    const res = await api("POST", `/ai/copilot/lead/${leadId}/proposal`, adminToken, {});
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.content.unavailable).toBe(true);
    expect(out.generationFailed).toBeUndefined();
  });

  it("deterministic followup still generates with AI disabled (core never fails)", async () => {
    const res = await api("POST", `/ai/copilot/contact/${contactId}/followup`, adminToken, {});
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.status).toBe("generated");
    expect(typeof out.content.channel).toBe("string");
    expect(out.source).toBe("deterministic"); // AI phrasing unavailable → deterministic-only
    expect(out.provider ?? null).toBeNull();
    expect(out.generationFailed).toBeUndefined();
  });
});

describe("No auto-send: generate/use never write communications", () => {
  it("generating and marking a draft as used leaves the contact's communications untouched", async () => {
    const before = await communicationsCount(adminToken, contactId);

    const gen = await api("POST", `/ai/copilot/contact/${contactId}/followup`, adminToken, {});
    expect(gen.status).toBe(200);
    const out = await gen.json();

    const use = await api("POST", `/ai/copilot/outputs/${out.id}/use`, adminToken, {});
    expect(use.status).toBe(200);
    expect((await use.json()).status).toBe("used");

    const after = await communicationsCount(adminToken, contactId);
    expect(after).toBe(before);
  });
});
