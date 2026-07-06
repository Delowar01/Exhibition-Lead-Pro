import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  contactsTable,
  leadsTable,
  organizationsTable,
  scansTable,
  aiCopilotOutputsTable,
} from "@workspace/db";

// Stage 5B — Enterprise AI Sales Copilot. Exercises the /ai/copilot endpoints
// against the LIVE API (localhost:80): generate (deterministic-core followup/coaching
// + LLM-only types that SOFT-DEGRADE, never 500), listing, audited edit/use/dismiss,
// tenant-wide overview, batch generation, cross-tenant isolation (404 not 403),
// RBAC (employee lacks ai_copilot.generate), applicability matrix, and provenance
// completeness. Assertions focus on the DETERMINISTIC cores (followup/coaching always
// produce grounded content regardless of provider) and on soft-degrade contracts, so
// the suite is not flaky when the LLM is slow/unconfigured. All fixtures live under
// throwaway tenants torn down in afterAll so demo accounts are untouched.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const DOMAIN = `copilot-${SUFFIX}.test`;
const DOMAIN_B = `copilotb-${SUFFIX}.test`;
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
let orgId = 0;
let scanId = 0;
let foreignLeadId = 0;
let foreignContactId = 0;
let adminUserId = 0;
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

// Generate an output and return the parsed row. Deterministic cores never fail; LLM-only
// types soft-degrade to HTTP 200. Always expects 200.
async function generate(token: string, entityType: string, id: number, outputType: string, extra?: Record<string, unknown>) {
  const res = await api("POST", `/ai/copilot/${entityType}/${id}/generate`, token, { outputType, ...(extra ?? {}) });
  expect(res.status, `generate ${outputType} on ${entityType}/${id}`).toBe(200);
  return res.json();
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
  const createCo = await api("POST", "/companies", platformToken, { name: `QA Copilot ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  adminUserId = await createUser(platformToken, ADMIN_EMAIL, "QA Copilot Admin", "primary_admin", companyId);
  adminToken = await loginToken({ email: ADMIN_EMAIL, password: PW });
  // Employee: created with default (empty) permissions — deny-by-default on ai_copilot.
  empUserId = await createUser(adminToken, EMP_EMAIL, "QA Copilot Emp", "employee");
  empToken = await loginToken({ email: EMP_EMAIL, password: PW });

  // A contact with a follow-up context so the deterministic followup/coaching engines
  // have real signals to derive from (no fabricated data).
  const c1 = await api("POST", "/contacts", adminToken, {
    firstName: "Dana",
    lastName: "Ford",
    email: `dana.ford-${SUFFIX}@example.com`,
    mobile: "+1 (555) 010-2000",
    jobTitle: "VP Sales",
    contactCompany: "Globex Corp",
    status: "new",
  });
  expect(c1.status).toBe(201);
  contactId = (await c1.json()).id;

  // A lead on tenant A.
  const l1 = await api("POST", "/leads", adminToken, {
    contactId,
    stage: "new",
    title: "QA opportunity",
    value: 5000,
    currency: "USD",
  });
  expect(l1.status).toBe(201);
  leadId = (await l1.json()).id;

  // An organization (for organization-scoped copilot outputs) — created via the API so
  // the app derives normalizedName (a NOT NULL column) and other invariants.
  const orgRes = await api("POST", "/organizations", adminToken, { name: `Globex Corp ${SUFFIX}`, industry: "Manufacturing" });
  expect(orgRes.status).toBe(201);
  orgId = (await orgRes.json()).id;

  // A completed scan (business card) — only reachable via batch on the web/mobile UI,
  // but the generate route accepts it directly too.
  const [s1] = await db
    .insert(scansTable)
    .values({
      companyId,
      userId: adminUserId,
      status: "completed",
      extractedData: JSON.stringify({ firstName: "Dana", lastName: "Ford", company: "Globex Corp", email: `dana.ford-${SUFFIX}@example.com`, mobile: "+1 (555) 010-2000" }),
    })
    .returning({ id: scansTable.id });
  scanId = s1.id;

  // --- Tenant B (cross-tenant isolation) ---
  const createCoB = await api("POST", "/companies", platformToken, { name: `QA Copilot B ${SUFFIX}`, plan: "professional" });
  expect(createCoB.status).toBe(201);
  companyBId = (await createCoB.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyBId));
  await createUser(platformToken, ADMIN_B_EMAIL, "QA Copilot Admin B", "primary_admin", companyBId);
  adminBToken = await loginToken({ email: ADMIN_B_EMAIL, password: PW });

  const cb = await api("POST", "/contacts", adminBToken, {
    firstName: "Bob",
    lastName: "Foreign",
    email: `bob-${SUFFIX}@example.com`,
  });
  expect(cb.status).toBe(201);
  foreignContactId = (await cb.json()).id;
  const lb = await api("POST", "/leads", adminBToken, { contactId: foreignContactId, stage: "new", title: "Foreign lead" });
  expect(lb.status).toBe(201);
  foreignLeadId = (await lb.json()).id;
});

afterAll(async () => {
  for (const cid of [companyId, companyBId]) {
    if (!cid) continue;
    await db.delete(aiCopilotOutputsTable).where(eq(aiCopilotOutputsTable.companyId, cid));
    await db.delete(scansTable).where(eq(scansTable.companyId, cid));
    await db.delete(leadsTable).where(eq(leadsTable.companyId, cid));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, cid));
    await db.delete(organizationsTable).where(eq(organizationsTable.companyId, cid));
    await db.delete(usersTable).where(eq(usersTable.companyId, cid));
    await db.delete(companiesTable).where(eq(companiesTable.id, cid));
  }
});

describe("POST /ai/copilot/:entityType/:id/generate — validation", () => {
  it("400s an unknown entityType", async () => {
    const res = await api("POST", `/ai/copilot/widget/${leadId}/generate`, adminToken, { outputType: "followup" });
    expect(res.status).toBe(400);
  });

  it("400s an unknown outputType", async () => {
    const res = await api("POST", `/ai/copilot/lead/${leadId}/generate`, adminToken, { outputType: "bogus" });
    expect(res.status).toBe(400);
  });

  it("400s an outputType that is not applicable to the entity (followup on organization)", async () => {
    const res = await api("POST", `/ai/copilot/organization/${orgId}/generate`, adminToken, { outputType: "followup" });
    expect(res.status).toBe(400);
  });

  it("404s a non-existent lead", async () => {
    const res = await api("POST", `/ai/copilot/lead/99999999/generate`, adminToken, { outputType: "followup" });
    expect(res.status).toBe(404);
  });
});

describe("Deterministic-core outputs (followup / coaching) — grounded, provenance-correct", () => {
  it("generates a follow-up plan for a lead with a grounded deterministic core", async () => {
    const out = await generate(adminToken, "lead", leadId, "followup");
    expect(out.entityType).toBe("lead");
    expect(out.entityId).toBe(leadId);
    expect(out.outputType).toBe("followup");
    expect(out.companyId).toBe(companyId);
    expect(out.status).toBe("generated");
    // Deterministic core is ALWAYS present regardless of whether AI phrasing succeeded.
    expect(out.content).toBeTruthy();
    expect(typeof out.content.channel).toBe("string");
    expect(typeof out.content.suggestedDate).toBe("string");
    expect(["ai", "deterministic"]).toContain(out.source);
    // Provenance: a deterministic-only row must NOT masquerade as AI.
    if (out.source === "deterministic") {
      expect(out.provider ?? null).toBeNull();
      expect(out.model ?? null).toBeNull();
      expect(out.promptKey ?? null).toBeNull();
    } else {
      expect(typeof out.model).toBe("string");
      expect(String(out.model).length).toBeGreaterThan(0);
    }
  });

  it("generates coaching signals for a contact (deterministic core: signals/summary/recommendations)", async () => {
    const out = await generate(adminToken, "contact", contactId, "coaching");
    expect(out.outputType).toBe("coaching");
    expect(Array.isArray(out.content.signals)).toBe(true);
    expect(typeof out.content.summary).toBe("string");
    expect(Array.isArray(out.content.recommendations)).toBe(true);
    expect(["ai", "deterministic"]).toContain(out.source);
  });

  it("re-generating upserts (no duplicate rows) for the same entity+outputType", async () => {
    await generate(adminToken, "lead", leadId, "followup");
    const res = await api("GET", `/ai/copilot/lead/${leadId}`, adminToken);
    expect(res.status).toBe(200);
    const { outputs } = await res.json();
    const followups = outputs.filter((o: { outputType: string }) => o.outputType === "followup");
    expect(followups.length).toBe(1);
  });
});

describe("LLM-only outputs — soft-degrade to 200 (never 500)", () => {
  it("email generation returns 200 even if the provider is unavailable", async () => {
    const res = await api("POST", `/ai/copilot/contact/${contactId}/generate`, adminToken, { outputType: "email" });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.outputType).toBe("email");
    expect(out.status).toBe("generated");
    // Either a real draft or a soft-degrade placeholder — never an error status.
    expect(out.content).toBeTruthy();
  });

  it("summary generation returns 200 for a business card (LLM-only, applicable)", async () => {
    const res = await api("POST", `/ai/copilot/business_card/${scanId}/generate`, adminToken, { outputType: "summary" });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.entityType).toBe("business_card");
    expect(out.outputType).toBe("summary");
  });
});

describe("GET /ai/copilot/:entityType/:id — listing", () => {
  it("returns stored outputs for the caller's tenant only", async () => {
    const res = await api("GET", `/ai/copilot/lead/${leadId}`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.outputs)).toBe(true);
    expect(body.outputs.length).toBeGreaterThan(0);
    expect(body.outputs.every((o: { companyId: number }) => o.companyId === companyId)).toBe(true);
  });
});

describe("Review actions (edit / use / dismiss) — audited, tenant-scoped", () => {
  let outputId = 0;

  it("edit stores editedContent and flips status to edited", async () => {
    const list = await api("GET", `/ai/copilot/lead/${leadId}`, adminToken);
    outputId = (await list.json()).outputs[0].id;
    const res = await api("PATCH", `/ai/copilot/outputs/${outputId}`, adminToken, {
      editedContent: { draftMessage: "Reviewed and edited by a human." },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("edited");
    expect(body.editedContent).toBeTruthy();
    expect(body.editedContent.draftMessage).toBe("Reviewed and edited by a human.");
  });

  it("use records usedById + status used (does not auto-send)", async () => {
    const res = await api("POST", `/ai/copilot/outputs/${outputId}/use`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("used");
    expect(body.usedById).toBe(adminUserId);
    expect(typeof body.usedAt).toBe("string");
  });

  it("dismiss sets status dismissed", async () => {
    const gen = await generate(adminToken, "contact", contactId, "followup");
    const res = await api("POST", `/ai/copilot/outputs/${gen.id}/dismiss`, adminToken);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("dismissed");
  });

  it("404s editing an output from another tenant (no existence leak)", async () => {
    const res = await api("PATCH", `/ai/copilot/outputs/${outputId}`, adminBToken, { editedContent: { x: 1 } });
    expect(res.status).toBe(404);
  });

  it("404s using an output from another tenant", async () => {
    const res = await api("POST", `/ai/copilot/outputs/${outputId}/use`, adminBToken);
    expect(res.status).toBe(404);
  });

  it("404s a non-existent output id", async () => {
    const res = await api("POST", `/ai/copilot/outputs/99999999/use`, adminToken);
    expect(res.status).toBe(404);
  });
});

describe("GET /ai/copilot/overview — tenant-wide review summary", () => {
  it("returns status counts and recent outputs for the caller's tenant only", async () => {
    const res = await api("GET", `/ai/copilot/overview`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toBeDefined();
    expect(Array.isArray(body.recent)).toBe(true);
    expect(body.recent.every((o: { companyId: number }) => o.companyId === companyId)).toBe(true);
  });
});

describe("Cross-tenant isolation (404 not 403)", () => {
  it("404s generating on a foreign lead", async () => {
    const res = await api("POST", `/ai/copilot/lead/${foreignLeadId}/generate`, adminToken, { outputType: "followup" });
    expect(res.status).toBe(404);
  });

  it("404s listing a foreign lead's outputs", async () => {
    const res = await api("GET", `/ai/copilot/lead/${foreignLeadId}`, adminToken);
    expect(res.status).toBe(404);
  });
});

describe("RBAC — deny-by-default employee writes", () => {
  it("403s an employee generating (no ai_copilot.generate permission)", async () => {
    const res = await api("POST", `/ai/copilot/lead/${leadId}/generate`, empToken, { outputType: "followup" });
    expect(res.status).toBe(403);
  });

  it("403s an employee reading outputs without ai_copilot.view (deny-by-default)", async () => {
    const res = await api("GET", `/ai/copilot/lead/${leadId}`, empToken);
    expect(res.status).toBe(403);
  });
});

describe("Platform-owner tenant firewall (requireTenantUser)", () => {
  it("403s a platform_owner on the copilot overview (customer CRM is fenced off)", async () => {
    const res = await api("GET", `/ai/copilot/overview`, platformToken);
    expect(res.status).toBe(403);
  });

  it("403s a platform_owner generating a copilot output", async () => {
    const res = await api("POST", `/ai/copilot/lead/${leadId}/generate`, platformToken, { outputType: "followup" });
    expect(res.status).toBe(403);
  });
});

describe("Positive RBAC — granting ai_copilot view+use unlocks reads/actions but NOT generate", () => {
  it("an employee granted view+use can read + use, but generate stays 403", async () => {
    // Grant the employee explicit ai_copilot view+use (requireAuth loads the fresh row each request).
    await db.update(usersTable).set({ permissions: { ai_copilot: ["view", "use"] } }).where(eq(usersTable.id, empUserId));
    try {
      const read = await api("GET", `/ai/copilot/lead/${leadId}`, empToken);
      expect(read.status).toBe(200);

      // Use an existing tenant-A output (does not auto-send).
      const outputId = (await read.json()).outputs[0].id;
      const use = await api("POST", `/ai/copilot/outputs/${outputId}/use`, empToken);
      expect(use.status).toBe(200);
      expect((await use.json()).usedById).toBe(empUserId);

      // Generate still requires the separate ai_copilot.generate permission.
      const gen = await api("POST", `/ai/copilot/lead/${leadId}/generate`, empToken, { outputType: "followup" });
      expect(gen.status).toBe(403);
    } finally {
      await db.update(usersTable).set({ permissions: {} }).where(eq(usersTable.id, empUserId));
    }
  });
});

describe("POST /ai/copilot/batch — tenant-scoped batch generation", () => {
  it("400s an unknown entityType", async () => {
    const res = await api("POST", `/ai/copilot/batch`, adminToken, { entityType: "widget", outputType: "summary" });
    expect(res.status).toBe(400);
  });

  it("400s an outputType not applicable to the entity (followup on organization)", async () => {
    const res = await api("POST", `/ai/copilot/batch`, adminToken, { entityType: "organization", outputType: "followup" });
    expect(res.status).toBe(400);
  });

  it("403s an employee starting a batch (no ai_copilot.generate permission)", async () => {
    const res = await api("POST", `/ai/copilot/batch`, empToken, { entityType: "contact", outputType: "followup" });
    expect(res.status).toBe(403);
  });

  it("starts a contact/followup batch scoped to the caller's tenant and completes", async () => {
    const res = await api("POST", `/ai/copilot/batch`, adminToken, { entityType: "contact", outputType: "followup" });
    expect(res.status).toBe(202);
    const job = await res.json();
    expect(typeof job.id).toBe("string");
    expect(job.companyId).toBe(companyId);
    expect(job.entityType).toBe("contact");
    expect(job.outputType).toBe("followup");
    expect(["queued", "running", "completed"]).toContain(job.status);
    expect(job.total).toBe(1); // the one seeded contact

    let final = job;
    for (let i = 0; i < 40 && final.status !== "completed" && final.status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const poll = await api("GET", `/ai/copilot/batch/${job.id}`, adminToken);
      expect(poll.status).toBe(200);
      final = await poll.json();
    }
    expect(final.status).toBe("completed");
    expect(final.processed).toBe(final.total);
    expect(final.succeeded + final.failed).toBe(final.total);
    expect(typeof final.finishedAt).toBe("string");
  });

  it("lists batch jobs for the caller's tenant only", async () => {
    const res = await api("GET", `/ai/copilot/batch`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.jobs.length).toBeGreaterThan(0);
    expect(body.jobs.every((j: { companyId: number }) => j.companyId === companyId)).toBe(true);
  });

  it("404s fetching another tenant's batch job (no existence leak)", async () => {
    const start = await api("POST", `/ai/copilot/batch`, adminToken, { entityType: "contact", outputType: "summary" });
    const job = await start.json();
    const res = await api("GET", `/ai/copilot/batch/${job.id}`, adminBToken);
    expect(res.status).toBe(404);
  });

  it("404s a non-existent batch job id", async () => {
    const res = await api("GET", `/ai/copilot/batch/00000000-0000-0000-0000-000000000000`, adminToken);
    expect(res.status).toBe(404);
  });
});

// MUST run last: it flips tenant B to a read-only (cancelled) status.
describe("Read-only tenant (cancelled) — mutations blocked, reads allowed", () => {
  it("403s a copilot generate for a cancelled tenant but still allows reads", async () => {
    await db.update(companiesTable).set({ status: "cancelled" }).where(eq(companiesTable.id, companyBId));
    try {
      const gen = await api("POST", `/ai/copilot/lead/${foreignLeadId}/generate`, adminBToken, { outputType: "followup" });
      expect(gen.status).toBe(403); // blockReadOnlyMutations
      const read = await api("GET", `/ai/copilot/lead/${foreignLeadId}`, adminBToken);
      expect(read.status).toBe(200); // reads stay open in read-only mode
    } finally {
      await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyBId));
    }
  });
});
