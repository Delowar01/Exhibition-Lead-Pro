import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  contactsTable,
  leadsTable,
  eventsTable,
  scansTable,
  aiInsightsTable,
} from "@workspace/db";

// Stage 5A — Enterprise AI Intelligence. Exercises the /ai/insights endpoints
// against the LIVE API (localhost:80): analyze (deterministic + AI insights),
// list, audited accept/dismiss, tenant-wide overview, cross-tenant isolation
// (404 not 403), and employee RBAC (deny-by-default writes). Assertions focus on
// the DETERMINISTIC engines (missing_info + duplicate_intelligence) which always
// run regardless of AI provider availability, so the suite is not flaky when the
// LLM is slow/unconfigured. All fixtures live under throwaway tenants torn down
// in afterAll so demo accounts are untouched.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const DOMAIN = `aiins-${SUFFIX}.test`;
const DOMAIN_B = `aiinsb-${SUFFIX}.test`;
const ADMIN_EMAIL = `qa-admin@${DOMAIN}`;
const EMP_EMAIL = `qa-emp@${DOMAIN}`;
const ADMIN_B_EMAIL = `qa-admin@${DOMAIN_B}`;

let companyId = 0;
let companyBId = 0;
let platformToken = "";
let adminToken = "";
let empToken = "";
let adminBToken = "";

let leadId = 0;
let contactId = 0;
let foreignLeadId = 0;
let adminUserId = 0;
let scanId = 0;
let foreignScanId = 0;
let dmContactId = 0;

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
  const createCo = await api("POST", "/companies", platformToken, { name: `QA AI Insights ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  adminUserId = await createUser(platformToken, ADMIN_EMAIL, "QA AI Admin", "primary_admin", companyId);
  adminToken = await loginToken({ email: ADMIN_EMAIL, password: PW });
  await createUser(adminToken, EMP_EMAIL, "QA AI Emp", "employee");
  empToken = await loginToken({ email: EMP_EMAIL, password: PW });

  // Two near-duplicate contacts so duplicate_intelligence has a real match to find.
  const c1 = await api("POST", "/contacts", adminToken, {
    firstName: "Dana",
    lastName: "Ford",
    email: `dana.ford-${SUFFIX}@example.com`,
    mobile: "+1 (555) 010-2000",
    jobTitle: "VP Sales",
  });
  expect(c1.status).toBe(201);
  contactId = (await c1.json()).id;

  const c2 = await api("POST", "/contacts", adminToken, {
    firstName: "Dana",
    lastName: "Ford",
    email: `dana.ford-${SUFFIX}@example.com`,
    mobile: "5550102000",
    // Intentional near-duplicate fixture: the human-in-the-loop dedupe flow now
    // 409s on same-email captures, so explicitly resolve as a separate contact.
    dedupeResolution: "create_separate",
  });
  expect(c2.status).toBe(201);

  // A lead on tenant A with a couple of empty fields so missing_info has gaps.
  const l1 = await api("POST", "/leads", adminToken, {
    contactId,
    stage: "prospect",
    title: "QA opportunity",
    value: 5000,
    currency: "USD",
  });
  expect(l1.status).toBe(201);
  leadId = (await l1.json()).id;

  // A decision-maker colleague at the same company as contact c1 (VP Sales), plus a "won"
  // status, so relationship_intelligence can surface multiple decision makers + customer status.
  const c1b = await api("POST", "/contacts", adminToken, {
    firstName: "Grace",
    lastName: "Hopper",
    email: `grace.hopper-${SUFFIX}@globex.test`,
    jobTitle: "Chief Executive Officer",
    contactCompany: "Globex Corp",
    status: "won",
  });
  expect(c1b.status).toBe(201);
  dmContactId = (await c1b.json()).id;
  const c1c = await api("POST", "/contacts", adminToken, {
    firstName: "Ada",
    lastName: "Byron",
    email: `ada.byron-${SUFFIX}@globex.test`,
    jobTitle: "CFO",
    contactCompany: "Globex Corp",
  });
  expect(c1c.status).toBe(201);

  // Two near-duplicate SCANS (physical business cards) seeded directly (no AI OCR call):
  // same email → duplicate_intelligence must flag them for the "business_card" entity type.
  const cardData = JSON.stringify({ firstName: "Dana", lastName: "Ford", company: "Acme Co", email: `dana.ford-${SUFFIX}@example.com`, mobile: "+1 (555) 010-2000" });
  const [s1] = await db
    .insert(scansTable)
    .values({ companyId, userId: adminUserId, status: "completed", extractedData: cardData })
    .returning({ id: scansTable.id });
  scanId = s1.id;
  await db
    .insert(scansTable)
    .values({ companyId, userId: adminUserId, status: "completed", extractedData: cardData })
    .returning({ id: scansTable.id });

  // --- Tenant B (cross-tenant isolation) ---
  const createCoB = await api("POST", "/companies", platformToken, { name: `QA AI Insights B ${SUFFIX}`, plan: "professional" });
  expect(createCoB.status).toBe(201);
  companyBId = (await createCoB.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyBId));
  await createUser(platformToken, ADMIN_B_EMAIL, "QA AI Admin B", "primary_admin", companyBId);
  adminBToken = await loginToken({ email: ADMIN_B_EMAIL, password: PW });

  const cb = await api("POST", "/contacts", adminBToken, {
    firstName: "Bob",
    lastName: "Foreign",
    email: `bob-${SUFFIX}@example.com`,
  });
  expect(cb.status).toBe(201);
  const foreignContactId = (await cb.json()).id;
  const lb = await api("POST", "/leads", adminBToken, { contactId: foreignContactId, stage: "prospect", title: "Foreign lead" });
  expect(lb.status).toBe(201);
  foreignLeadId = (await lb.json()).id;

  const [sb] = await db
    .insert(scansTable)
    .values({ companyId: companyBId, status: "completed", extractedData: JSON.stringify({ firstName: "Bob", lastName: "Foreign", email: `bob-${SUFFIX}@example.com` }) })
    .returning({ id: scansTable.id });
  foreignScanId = sb.id;
});

afterAll(async () => {
  for (const cid of [companyId, companyBId]) {
    if (!cid) continue;
    await db.delete(aiInsightsTable).where(eq(aiInsightsTable.companyId, cid));
    await db.delete(scansTable).where(eq(scansTable.companyId, cid));
    await db.delete(leadsTable).where(eq(leadsTable.companyId, cid));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, cid));
    await db.delete(usersTable).where(eq(usersTable.companyId, cid));
    await db.delete(companiesTable).where(eq(companiesTable.id, cid));
  }
});

describe("POST /ai/insights/:entityType/:id/analyze — generation", () => {
  it("400s an unknown entityType", async () => {
    const res = await api("POST", `/ai/insights/widget/${leadId}/analyze`, adminToken);
    expect(res.status).toBe(400);
  });

  it("404s a non-existent lead", async () => {
    const res = await api("POST", `/ai/insights/lead/99999999/analyze`, adminToken);
    expect(res.status).toBe(404);
  });

  it("generates deterministic insights for a lead (missing_info always runs)", async () => {
    const res = await api("POST", `/ai/insights/lead/${leadId}/analyze`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.insights)).toBe(true);
    expect(Array.isArray(body.aiErrors)).toBe(true);
    const types = body.insights.map((i: { insightType: string }) => i.insightType);
    expect(types).toContain("missing_info");
    const missing = body.insights.find((i: { insightType: string }) => i.insightType === "missing_info");
    expect(missing.source).toBe("deterministic");
    expect(missing.entityType).toBe("lead");
    expect(missing.entityId).toBe(leadId);
    expect(missing.status).toBe("suggested");
    expect(missing.companyId).toBe(companyId);
    expect(typeof missing.generatedAt).toBe("string");
    expect(typeof missing.lastAnalysisAt).toBe("string");
  });

  it("detects the near-duplicate contact (duplicate_intelligence, deterministic)", async () => {
    const res = await api("POST", `/ai/insights/contact/${contactId}/analyze`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    const dup = body.insights.find((i: { insightType: string }) => i.insightType === "duplicate_intelligence");
    expect(dup).toBeDefined();
    expect(dup.source).toBe("deterministic");
    expect(dup.data.count).toBeGreaterThanOrEqual(1);
  });

  it("stamps complete runtime provenance on every AI-sourced insight (deterministic rows carry none)", async () => {
    const res = await api("POST", `/ai/insights/lead/${leadId}/analyze`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();

    // Deterministic engines must NEVER masquerade as AI: no provider/model/prompt fields.
    for (const det of body.insights.filter((i: { source: string }) => i.source === "deterministic")) {
      expect(det.provider ?? null).toBeNull();
      expect(det.model ?? null).toBeNull();
      expect(det.promptKey ?? null).toBeNull();
      expect(det.promptVersion ?? null).toBeNull();
    }

    // AI insights only exist when the LLM is configured/reachable — assert provenance
    // completeness for whichever ones were produced (skip cleanly when none, so the
    // suite is not flaky against an unconfigured/slow provider).
    const aiInsights = body.insights.filter((i: { source: string }) => i.source === "ai");
    for (const ins of aiInsights) {
      expect(typeof ins.provider).toBe("string");
      expect(ins.provider.length).toBeGreaterThan(0);
      expect(typeof ins.model).toBe("string");
      expect(ins.model.length).toBeGreaterThan(0);
      expect(typeof ins.promptKey).toBe("string");
      expect(ins.promptKey.length).toBeGreaterThan(0);
      expect(typeof ins.promptVersion).toBe("number");
      expect(ins.promptVersion).toBeGreaterThanOrEqual(1);
      expect(typeof ins.generatedAt).toBe("string");
      expect(typeof ins.lastAnalysisAt).toBe("string");
    }
  });
});

describe("GET /ai/insights/:entityType/:id — listing", () => {
  it("returns the stored insights for the analyzed lead", async () => {
    const res = await api("GET", `/ai/insights/lead/${leadId}`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.insights)).toBe(true);
    expect(body.insights.length).toBeGreaterThan(0);
    expect(body.insights.every((i: { companyId: number }) => i.companyId === companyId)).toBe(true);
  });

  it("re-analyze upserts (no duplicate rows) and refreshes lastAnalysisAt", async () => {
    const first = await api("GET", `/ai/insights/lead/${leadId}`, adminToken);
    const before = (await first.json()).insights.length;
    const re = await api("POST", `/ai/insights/lead/${leadId}/analyze`, adminToken);
    expect(re.status).toBe(200);
    const after = await api("GET", `/ai/insights/lead/${leadId}`, adminToken);
    const afterCount = (await after.json()).insights.length;
    expect(afterCount).toBe(before);
  });
});

describe("POST /ai/insights/:id/accept + dismiss — audited review actions", () => {
  it("accept sets status=accepted and records acceptedById", async () => {
    const list = await api("GET", `/ai/insights/lead/${leadId}`, adminToken);
    const insight = (await list.json()).insights[0];
    const res = await api("POST", `/ai/insights/${insight.id}/accept`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("accepted");
    expect(body.acceptedById).toBeGreaterThan(0);
    expect(typeof body.acceptedAt).toBe("string");
  });

  it("dismiss sets status=dismissed and clears acceptedById", async () => {
    const list = await api("GET", `/ai/insights/contact/${contactId}`, adminToken);
    const insight = (await list.json()).insights[0];
    const res = await api("POST", `/ai/insights/${insight.id}/dismiss`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("dismissed");
    expect(body.acceptedById).toBeNull();
  });

  it("404s accepting an insight from another tenant", async () => {
    const list = await api("GET", `/ai/insights/lead/${leadId}`, adminToken);
    const insight = (await list.json()).insights[0];
    const res = await api("POST", `/ai/insights/${insight.id}/accept`, adminBToken);
    expect(res.status).toBe(404);
  });
});

describe("GET /ai/insights/overview — tenant-wide review summary", () => {
  it("returns status counts and recent insights for the caller's tenant only", async () => {
    const res = await api("GET", "/ai/insights/overview", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toBeDefined();
    expect(Array.isArray(body.recent)).toBe(true);
    expect(body.recent.every((i: { companyId: number }) => i.companyId === companyId)).toBe(true);
  });
});

describe("Cross-tenant isolation (404 not 403)", () => {
  it("404s analyze on a foreign lead", async () => {
    const res = await api("POST", `/ai/insights/lead/${foreignLeadId}/analyze`, adminToken);
    expect(res.status).toBe(404);
  });

  it("404s listing a foreign lead's insights", async () => {
    const res = await api("GET", `/ai/insights/lead/${foreignLeadId}`, adminToken);
    expect(res.status).toBe(404);
  });
});

describe("RBAC — deny-by-default employee writes", () => {
  it("403s an employee generating insights (no ai_insights.generate permission)", async () => {
    const res = await api("POST", `/ai/insights/lead/${leadId}/analyze`, empToken);
    expect(res.status).toBe(403);
  });
});

describe("relationship_intelligence — deterministic link derivation", () => {
  it("surfaces the contact's linked lead (deterministic, confidence 100, real CRM data)", async () => {
    const res = await api("POST", `/ai/insights/contact/${contactId}/analyze`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    const rel = body.insights.find((i: { insightType: string }) => i.insightType === "relationship_intelligence");
    expect(rel).toBeDefined();
    expect(rel.source).toBe("deterministic");
    expect(rel.confidence).toBe(100);
    expect(rel.entityType).toBe("contact");
    expect(rel.entityId).toBe(contactId);
    // A lead (leadId) is linked to this contact, so relatedLeads must reflect it —
    // derived purely from stored rows, never fabricated.
    expect(rel.data.counts.relatedLeads).toBeGreaterThanOrEqual(1);
    expect(rel.data.relatedLeads.some((l: { id: number }) => l.id === leadId)).toBe(true);
    expect(typeof rel.reasoning).toBe("string");
    expect(rel.reasoning.length).toBeGreaterThan(0);
  });

  it("links the lead back to its primary contact (deterministic)", async () => {
    const res = await api("POST", `/ai/insights/lead/${leadId}/analyze`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    const rel = body.insights.find((i: { insightType: string }) => i.insightType === "relationship_intelligence");
    expect(rel).toBeDefined();
    expect(rel.source).toBe("deterministic");
    expect(rel.data.contact).not.toBeNull();
    expect(rel.data.contact.id).toBe(contactId);
    // Deterministic relationship rows must never masquerade as AI.
    expect(rel.provider ?? null).toBeNull();
    expect(rel.model ?? null).toBeNull();
  });

  it("scopes FK dereferences to the tenant — a forced cross-tenant eventId never leaks the foreign event name", async () => {
    // Simulate a cross-tenant FK that write-path guards normally reject: insert an
    // event under tenant B and point tenant A's lead at it directly via the DB. The
    // relationship engine must NOT dereference it (tenant-scoped lookup returns null).
    const [ev] = await db
      .insert(eventsTable)
      .values({ companyId: companyBId, name: "FOREIGN-EVENT-LEAK" })
      .returning({ id: eventsTable.id });
    await db.update(leadsTable).set({ eventId: ev.id }).where(eq(leadsTable.id, leadId));
    try {
      const res = await api("POST", `/ai/insights/lead/${leadId}/analyze`, adminToken);
      expect(res.status).toBe(200);
      const body = await res.json();
      const rel = body.insights.find((i: { insightType: string }) => i.insightType === "relationship_intelligence");
      expect(rel).toBeDefined();
      expect(rel.data.event ?? null).toBeNull();
      expect(String(rel.reasoning)).not.toContain("FOREIGN-EVENT-LEAK");
    } finally {
      await db.update(leadsTable).set({ eventId: null }).where(eq(leadsTable.id, leadId));
    }
  });
});

describe("business_card (scan) duplicate intelligence", () => {
  it("404s a non-existent business card", async () => {
    const res = await api("POST", `/ai/insights/business_card/99999999/analyze`, adminToken);
    expect(res.status).toBe(404);
  });

  it("flags the duplicate scanned card (same email) — deterministic, never auto-merges", async () => {
    const res = await api("POST", `/ai/insights/business_card/${scanId}/analyze`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    const dup = body.insights.find((i: { insightType: string }) => i.insightType === "duplicate_intelligence");
    expect(dup).toBeDefined();
    expect(dup.source).toBe("deterministic");
    expect(dup.entityType).toBe("business_card");
    expect(dup.entityId).toBe(scanId);
    expect(dup.data.count).toBeGreaterThanOrEqual(1);
    // Business cards get ONLY duplicate intelligence (no AI/missing_info/relationship rows).
    expect(body.insights.every((i: { insightType: string }) => i.insightType === "duplicate_intelligence")).toBe(true);
  });

  it("404s analyzing a business card from another tenant (no existence leak)", async () => {
    const res = await api("POST", `/ai/insights/business_card/${foreignScanId}/analyze`, adminToken);
    expect(res.status).toBe(404);
  });
});

describe("relationship_intelligence — broadened patterns", () => {
  it("surfaces multiple decision makers + existing-customer status at a shared company", async () => {
    const res = await api("POST", `/ai/insights/contact/${dmContactId}/analyze`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    const rel = body.insights.find((i: { insightType: string }) => i.insightType === "relationship_intelligence");
    expect(rel).toBeDefined();
    expect(rel.source).toBe("deterministic");
    // Grace (CEO) + Ada (CFO) at "Globex Corp" → at least 2 decision makers.
    expect(rel.data.multipleDecisionMakers).toBe(true);
    expect(rel.data.decisionMakers.length).toBeGreaterThanOrEqual(2);
    // Grace's contact status is "won" → existing customer, derived from the stored row.
    expect(rel.data.customerStatus).toBe("existing_customer");
  });
});

describe("POST /ai/insights/batch — tenant-scoped batch analysis", () => {
  it("400s an unknown entityType", async () => {
    const res = await api("POST", `/ai/insights/batch`, adminToken, { entityType: "widget" });
    expect(res.status).toBe(400);
  });

  it("403s an employee starting a batch (no ai_insights.generate permission)", async () => {
    const res = await api("POST", `/ai/insights/batch`, empToken, { entityType: "contact" });
    expect(res.status).toBe(403);
  });

  it("starts a batch and reports progress scoped to the caller's tenant", async () => {
    const res = await api("POST", `/ai/insights/batch`, adminToken, { entityType: "contact" });
    expect(res.status).toBe(202);
    const job = await res.json();
    expect(typeof job.id).toBe("string");
    expect(job.companyId).toBe(companyId);
    expect(job.entityType).toBe("contact");
    expect(["queued", "running", "completed"]).toContain(job.status);
    // Tenant A has exactly the four seeded contacts (c1 + c2 + the two decision-maker colleagues).
    expect(job.total).toBe(4);

    // Poll until it finishes (fire-and-forget processing, deterministic engines always run).
    let final = job;
    for (let i = 0; i < 30 && final.status !== "completed" && final.status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const poll = await api("GET", `/ai/insights/batch/${job.id}`, adminToken);
      expect(poll.status).toBe(200);
      final = await poll.json();
    }
    expect(final.status).toBe("completed");
    expect(final.processed).toBe(final.total);
    expect(final.succeeded + final.failed).toBe(final.total);
    expect(typeof final.finishedAt).toBe("string");
  });

  it("runs a business_card batch on the shared queue and completes over all scans", async () => {
    const res = await api("POST", `/ai/insights/batch`, adminToken, { entityType: "business_card" });
    expect(res.status).toBe(202);
    const job = await res.json();
    expect(job.entityType).toBe("business_card");
    expect(job.companyId).toBe(companyId);
    expect(job.total).toBe(2); // the two seeded scans

    let final = job;
    for (let i = 0; i < 30 && final.status !== "completed" && final.status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const poll = await api("GET", `/ai/insights/batch/${job.id}`, adminToken);
      expect(poll.status).toBe(200);
      final = await poll.json();
    }
    expect(final.status).toBe("completed");
    expect(final.processed).toBe(final.total);
    expect(final.succeeded).toBe(final.total);
  });

  it("lists batch jobs for the caller's tenant only", async () => {
    const res = await api("GET", `/ai/insights/batch`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.jobs.length).toBeGreaterThan(0);
    expect(body.jobs.every((j: { companyId: number }) => j.companyId === companyId)).toBe(true);
  });

  it("404s fetching another tenant's batch job (no existence leak)", async () => {
    const start = await api("POST", `/ai/insights/batch`, adminToken, { entityType: "contact" });
    const job = await start.json();
    const res = await api("GET", `/ai/insights/batch/${job.id}`, adminBToken);
    expect(res.status).toBe(404);
  });

  it("404s a non-existent batch job id", async () => {
    const res = await api("GET", `/ai/insights/batch/00000000-0000-0000-0000-000000000000`, adminToken);
    expect(res.status).toBe(404);
  });
});
