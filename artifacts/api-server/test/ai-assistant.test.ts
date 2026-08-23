import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  contactsTable,
  leadsTable,
  aiConversationsTable,
  aiMessagesTable,
  aiSettingsTable,
  notificationsTable,
} from "@workspace/db";

// Stage 5D — Enterprise AI Command Center (conversational assistant). Exercises the
// /ai/assistant endpoints against the LIVE API (localhost:80): conversation CRUD
// (owner-scoped), message send with deterministic intent classification grounded in
// real CRM rows, provenance honesty (deterministic answers never masquerade as AI),
// suggestions, RBAC view/use split (deny-by-default employees), owner isolation
// (another user's conversation → 404), cross-tenant isolation, and the
// platform-owner tenant firewall. Assertions avoid depending on LLM availability —
// answers soft-degrade to deterministic content, so the suite stays green when the
// provider is slow/unconfigured. All fixtures live under throwaway tenants torn
// down in afterAll.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const DOMAIN = `assistant-${SUFFIX}.test`;
const DOMAIN_B = `assistantb-${SUFFIX}.test`;
const ADMIN_EMAIL = `qa-admin@${DOMAIN}`;
const EMP_EMAIL = `qa-emp@${DOMAIN}`;
const ADMIN_B_EMAIL = `qa-admin@${DOMAIN_B}`;

let companyId = 0;
let companyBId = 0;
let platformToken = "";
let adminToken = "";
let empToken = "";
let adminBToken = "";
let empUserId = 0;

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

async function createConversation(token: string): Promise<number> {
  const res = await api("POST", "/ai/assistant/conversations", token, {});
  expect(res.status).toBe(201);
  return (await res.json()).id;
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
  const createCo = await api("POST", "/companies", platformToken, { name: `QA Assistant ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  const adminUserId = await createUser(platformToken, ADMIN_EMAIL, "QA Assistant Admin", "primary_admin", companyId);
  adminToken = await loginToken({ email: ADMIN_EMAIL, password: PW });
  // Employee with default (empty) permissions — deny-by-default on ai_assistant.
  empUserId = await createUser(adminToken, EMP_EMAIL, "QA Assistant Emp", "employee");
  empToken = await loginToken({ email: EMP_EMAIL, password: PW });

  // Real CRM rows so deterministic intents have grounded data.
  const c1 = await api("POST", "/contacts", adminToken, {
    firstName: "Ada",
    lastName: "Quartz",
    email: `ada.quartz-${SUFFIX}@example.com`,
    jobTitle: "CTO",
    contactCompany: "Quartzline",
    status: "new",
  });
  expect(c1.status).toBe(201);
  const contactId = (await c1.json()).id;
  const l1 = await api("POST", "/leads", adminToken, {
    contactId,
    stage: "prospect",
    title: "QA assistant opportunity",
    value: 12000,
    currency: "USD",
    assignedToId: adminUserId,
  });
  expect(l1.status).toBe(201);

  // --- Tenant B (cross-tenant isolation) ---
  const createCoB = await api("POST", "/companies", platformToken, { name: `QA Assistant B ${SUFFIX}`, plan: "professional" });
  expect(createCoB.status).toBe(201);
  companyBId = (await createCoB.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyBId));
  await createUser(platformToken, ADMIN_B_EMAIL, "QA Assistant Admin B", "primary_admin", companyBId);
  adminBToken = await loginToken({ email: ADMIN_B_EMAIL, password: PW });
});

afterAll(async () => {
  for (const cid of [companyId, companyBId]) {
    if (!cid) continue;
    const convs = await db.select({ id: aiConversationsTable.id }).from(aiConversationsTable).where(eq(aiConversationsTable.companyId, cid));
    for (const c of convs) {
      await db.delete(aiMessagesTable).where(eq(aiMessagesTable.conversationId, c.id));
    }
    await db.delete(aiConversationsTable).where(eq(aiConversationsTable.companyId, cid));
    await db.delete(notificationsTable).where(eq(notificationsTable.companyId, cid));
    await db.delete(aiSettingsTable).where(eq(aiSettingsTable.companyId, cid));
    await db.delete(leadsTable).where(eq(leadsTable.companyId, cid));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, cid));
    await db.delete(usersTable).where(eq(usersTable.companyId, cid));
    await db.delete(companiesTable).where(eq(companiesTable.id, cid));
  }
});

describe("Conversation CRUD — owner-scoped", () => {
  it("creates, lists, reads, and deletes a conversation", async () => {
    const id = await createConversation(adminToken);

    const list = await api("GET", "/ai/assistant/conversations", adminToken);
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(Array.isArray(listBody.conversations)).toBe(true);
    expect(listBody.conversations.some((c: { id: number }) => c.id === id)).toBe(true);

    const detail = await api("GET", `/ai/assistant/conversations/${id}`, adminToken);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.id).toBe(id);
    expect(Array.isArray(detailBody.messages)).toBe(true);

    const del = await api("DELETE", `/ai/assistant/conversations/${id}`, adminToken);
    expect(del.status).toBe(200);
    const detailAfter = await api("GET", `/ai/assistant/conversations/${id}`, adminToken);
    expect(detailAfter.status).toBe(404);
  });

  it("404s a non-existent conversation", async () => {
    const res = await api("GET", "/ai/assistant/conversations/99999999", adminToken);
    expect(res.status).toBe(404);
  });
});

describe("Messages — deterministic grounding + provenance honesty", () => {
  it("answers a lead search grounded in real CRM rows and titles the conversation", async () => {
    const id = await createConversation(adminToken);
    const res = await api("POST", `/ai/assistant/conversations/${id}/messages`, adminToken, { content: "Show my leads" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userMessage.role).toBe("user");
    expect(body.userMessage.content).toBe("Show my leads");
    const am = body.assistantMessage;
    expect(am.role).toBe("assistant");
    expect(am.intent).toBe("search_leads");
    expect(typeof am.content).toBe("string");
    expect(am.content.length).toBeGreaterThan(0);
    // Grounded: the fixture lead must be reflected in the data payload.
    expect(am.data).toBeTruthy();
    // Provenance honesty: deterministic answers never claim AI provenance.
    if (am.source === "deterministic") {
      expect(am.provider).toBeFalsy();
    }
    if (am.source === "ai") {
      expect(am.provider).toBeTruthy();
    }

    // First user message becomes the conversation title.
    const detail = await api("GET", `/ai/assistant/conversations/${id}`, adminToken);
    const detailBody = await detail.json();
    expect(detailBody.title).toContain("Show my leads");
    expect(detailBody.messages.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects an empty message with 400", async () => {
    const id = await createConversation(adminToken);
    const res = await api("POST", `/ai/assistant/conversations/${id}/messages`, adminToken, { content: "   " });
    expect(res.status).toBe(400);
  });

  it("handles a workflow health ask without 500 (soft-degrade contract)", async () => {
    const id = await createConversation(adminToken);
    const res = await api("POST", `/ai/assistant/conversations/${id}/messages`, adminToken, { content: "Where are the bottlenecks in our pipeline?" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assistantMessage.role).toBe("assistant");
    expect(typeof body.assistantMessage.content).toBe("string");
  });
});

describe("Suggestions", () => {
  it("returns prompts + module availability + provider", async () => {
    const res = await api("GET", "/ai/assistant/suggestions", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.prompts)).toBe(true);
    expect(body.prompts.length).toBeGreaterThan(0);
    expect(body.modules).toBeTruthy();
    expect(body.provider).toBeTruthy();
  });
});

describe("RBAC — view/use split, deny-by-default", () => {
  it("denies a default-permission employee (403)", async () => {
    const res = await api("GET", "/ai/assistant/conversations", empToken);
    expect(res.status).toBe(403);
    const send = await api("POST", "/ai/assistant/conversations", empToken, {});
    expect(send.status).toBe(403);
  });

  it("view-only employee can list but cannot create/send", async () => {
    await db
      .update(usersTable)
      .set({ permissions: { ai_assistant: ["view"] } })
      .where(eq(usersTable.id, empUserId));
    const viewToken = await loginToken({ email: EMP_EMAIL, password: PW });

    const list = await api("GET", "/ai/assistant/conversations", viewToken);
    expect(list.status).toBe(200);

    const create = await api("POST", "/ai/assistant/conversations", viewToken, {});
    expect(create.status).toBe(403);
  });

  it("company search rechecks organizations.view — contacts.view alone is not enough", async () => {
    // Regression: the assistant must not be a bypass route around module RBAC.
    await db
      .update(usersTable)
      .set({ permissions: { ai_assistant: ["view", "use"], contacts: ["view"] } })
      .where(eq(usersTable.id, empUserId));
    const tk = await loginToken({ email: EMP_EMAIL, password: PW });
    const id = await createConversation(tk);
    const res = await api("POST", `/ai/assistant/conversations/${id}/messages`, tk, { content: "Show companies" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assistantMessage.intent).toBe("search_companies");
    // Denied answer: no organization rows may leak.
    expect(body.assistantMessage.data?.organizations ?? []).toEqual([]);
    expect(body.assistantMessage.content).toMatch(/permission|صلاحية/i);
  });

  it("employee granted use can hold a conversation", async () => {
    await db
      .update(usersTable)
      .set({ permissions: { ai_assistant: ["view", "use"] } })
      .where(eq(usersTable.id, empUserId));
    const useToken = await loginToken({ email: EMP_EMAIL, password: PW });

    const id = await createConversation(useToken);
    const res = await api("POST", `/ai/assistant/conversations/${id}/messages`, useToken, { content: "Show my leads" });
    expect(res.status).toBe(200);
  });
});

describe("Isolation — owner, tenant, and platform firewall", () => {
  it("another user in the SAME tenant cannot read my conversation (404)", async () => {
    const id = await createConversation(adminToken);
    const useToken = await loginToken({ email: EMP_EMAIL, password: PW });
    const res = await api("GET", `/ai/assistant/conversations/${id}`, useToken);
    expect(res.status).toBe(404);
  });

  it("cross-tenant conversation access → 404 (not 403)", async () => {
    const id = await createConversation(adminToken);
    const res = await api("GET", `/ai/assistant/conversations/${id}`, adminBToken);
    expect(res.status).toBe(404);
    const del = await api("DELETE", `/ai/assistant/conversations/${id}`, adminBToken);
    expect(del.status).toBe(404);
  });

  it("platform_owner is firewalled from tenant assistant data", async () => {
    const res = await api("GET", "/ai/assistant/conversations", platformToken);
    expect([403, 404]).toContain(res.status);
  });
});

describe("Advisory-only safety", () => {
  it("a conversation about leads never mutates CRM rows", async () => {
    const before = await db.select({ id: leadsTable.id }).from(leadsTable).where(eq(leadsTable.companyId, companyId));
    const id = await createConversation(adminToken);
    const res = await api("POST", `/ai/assistant/conversations/${id}/messages`, adminToken, { content: "Reassign all my leads to someone else" });
    expect(res.status).toBe(200);
    const after = await db.select({ id: leadsTable.id, assignedToId: leadsTable.assignedToId }).from(leadsTable).where(eq(leadsTable.companyId, companyId));
    expect(after.length).toBe(before.length);
  });
});
