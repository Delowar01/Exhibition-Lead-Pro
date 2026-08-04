import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  contactsTable,
  scansTable,
  aiCopilotOutputsTable,
  aiSettingsTable,
  aiInvocationsTable,
  aiUsageReservationsTable,
  notificationsTable,
} from "@workspace/db";

// Batch 6 — AI budget alerts through the EXISTING notification system, with
// anti-spam (one alert per kind per tenant per day, advisory-locked). Uses the stub
// provider (no live Gemini). Seeds month usage at 85% of a token budget, performs a
// real (stubbed) provider call — the fire-and-forget threshold check must create ONE
// "approaching" notification for tenant admins with a link to /admin/ai — then calls
// again and proves no duplicate is sent.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const DOMAIN = `aialert-${SUFFIX}.test`;
const ADMIN_EMAIL = `qa-admin@${DOMAIN}`;

let companyId = 0;
let platformToken = "";
let adminToken = "";
let contactId = 0;

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

type Notif = { id: number; category: string; title: string; link?: string | null; metadata?: Record<string, unknown> | null };

async function aiNotifications(): Promise<Notif[]> {
  const res = await api("GET", "/notifications?limit=100", adminToken);
  expect(res.status).toBe(200);
  const body = await res.json();
  return (body.notifications as Notif[]).filter((n) => n.category === "ai");
}

async function waitFor(predicate: () => Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

beforeAll(async () => {
  const health = await fetch(`${BASE}/healthz`);
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);

  platformToken = await loginToken(PLATFORM);
  const createCo = await api("POST", "/companies", platformToken, { name: `QA AIAlert ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  const cu = await api("POST", "/users", platformToken, {
    email: ADMIN_EMAIL,
    name: "QA Alert Admin",
    role: "primary_admin",
    password: PW,
    companyId,
  });
  expect(cu.status).toBe(201);
  adminToken = await loginToken({ email: ADMIN_EMAIL, password: PW });

  // Stub provider BEFORE creating entities (background auto-score also stubbed).
  const ps = await api("PATCH", "/ai/settings", adminToken, { provider: "stub", model: "stub-model" });
  expect(ps.status).toBe(200);

  const c1 = await api("POST", "/contacts", adminToken, {
    firstName: "Alert",
    lastName: "Target",
    email: `alert-${SUFFIX}@example.com`,
    mobile: "+1 (555) 010-7511",
    jobTitle: "COO",
    contactCompany: "Alert Corp",
    status: "new",
  });
  expect(c1.status).toBe(201);
  contactId = (await c1.json()).id;
});

afterAll(async () => {
  if (companyId) {
    await db.delete(notificationsTable).where(eq(notificationsTable.companyId, companyId));
    await db.delete(aiCopilotOutputsTable).where(eq(aiCopilotOutputsTable.companyId, companyId));
    await db.delete(aiInvocationsTable).where(eq(aiInvocationsTable.companyId, companyId));
    await db.delete(aiUsageReservationsTable).where(eq(aiUsageReservationsTable.companyId, companyId));
    await db.delete(aiSettingsTable).where(eq(aiSettingsTable.companyId, companyId));
    await db.delete(scansTable).where(eq(scansTable.companyId, companyId));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, companyId));
    await db.delete(usersTable).where(eq(usersTable.companyId, companyId));
    await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  }
});

describe("AI budget alerts — approaching threshold + anti-spam", () => {
  it("sends ONE 'approaching' notification to tenant admins when usage crosses 80%", async () => {
    // Budget 100k, seeded month usage 85k (85%) — a single stubbed call adds well
    // under 1k tokens, so we stay firmly between 80% and 100%.
    const pb = await api("PATCH", "/ai/settings", adminToken, { monthlyTokenBudget: 100000 });
    expect(pb.status).toBe(200);
    await db.insert(aiInvocationsTable).values({
      companyId,
      feature: "card_extraction",
      provider: "stub",
      model: "stub-model",
      status: "success",
      inputTokens: 84920,
      outputTokens: 80,
      totalTokens: 85000,
      estimatedCostMicroUsd: 0,
      latencyMs: 5,
    });

    const res = await api("POST", `/ai/copilot/contact/${contactId}/email`, adminToken, {
      language: "en",
      instructions: "alert-trigger-1",
      regenerate: true,
    });
    expect(res.status).toBe(200);

    await waitFor(async () => (await aiNotifications()).length >= 1, "approaching-budget notification");
    const notifs = await aiNotifications();
    expect(notifs.length).toBe(1);
    expect(notifs[0].title).toContain("AI budget");
    expect(notifs[0].link).toBe("/admin/ai");
    expect(notifs[0].metadata?.subkind).toBe("ai_budget_approaching");
  });

  it("does NOT send a duplicate for the same kind on the same day (anti-spam)", async () => {
    const res = await api("POST", `/ai/copilot/contact/${contactId}/email`, adminToken, {
      language: "en",
      instructions: "alert-trigger-2",
      regenerate: true,
    });
    expect(res.status).toBe(200);
    // Give the fire-and-forget threshold check ample time to (wrongly) double-send.
    await new Promise((r) => setTimeout(r, 1500));
    const notifs = await aiNotifications();
    expect(notifs.filter((n) => n.metadata?.subkind === "ai_budget_approaching").length).toBe(1);
  });
});
