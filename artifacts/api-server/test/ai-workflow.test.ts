import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, desc, eq, gt } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  contactsTable,
  leadsTable,
  organizationsTable,
  aiWorkflowRecommendationsTable,
  auditLogsTable,
  notificationsTable,
  aiSettingsTable,
} from "@workspace/db";
import { backfillAiWorkflowPermissions } from "../src/lib/permission-backfill";

// Stage 5F — Enterprise AI Workflow & Automation Intelligence. Exercises the
// /ai/workflow endpoints against the LIVE API (localhost:80): per-entity analyze
// (deterministic cores conf/provenance-correct + AI recs that soft-degrade), the
// accept/dismiss review lifecycle, tenant-wide overview, org-scoped read-only
// rollups (health/sla-risks/bottlenecks), what-if simulation (writes NOTHING),
// batch (re)analysis, cross-tenant isolation (404 not 403), RBAC (employee lacks
// ai_workflow.generate/accept), platform-owner tenant firewall, the RBAC backfill
// upgrade path, and the cancelled-tenant read-only contract. Assertions focus on the
// SAFETY invariants (advisory-only, never auto-writes; deterministic rows never carry
// AI provenance; accepting only records approval) so the suite is not flaky when the
// LLM is slow/unconfigured. All fixtures live under throwaway tenants torn down in
// afterAll so demo accounts are untouched.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const DOMAIN = `workflow-${SUFFIX}.test`;
const DOMAIN_B = `workflowb-${SUFFIX}.test`;
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
let foreignLeadId = 0;
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

// Analyze an entity and return the recommendations array. Deterministic cores never
// fail; AI recs soft-degrade. Always expects 200 + an array.
async function analyze(token: string, entityType: string, id: number, extra?: Record<string, unknown>) {
  const res = await api("POST", `/ai/workflow/${entityType}/${id}/analyze`, token, extra ?? {});
  expect(res.status, `analyze ${entityType}/${id}`).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.recommendations)).toBe(true);
  return body.recommendations as Array<Record<string, unknown>>;
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
  const createCo = await api("POST", "/companies", platformToken, { name: `QA Workflow ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  adminUserId = await createUser(platformToken, ADMIN_EMAIL, "QA Workflow Admin", "primary_admin", companyId);
  adminToken = await loginToken({ email: ADMIN_EMAIL, password: PW });
  // Employee: created with default (empty) permissions — deny-by-default on ai_workflow.
  empUserId = await createUser(adminToken, EMP_EMAIL, "QA Workflow Emp", "employee");
  empToken = await loginToken({ email: EMP_EMAIL, password: PW });

  // A contact with real fields so the deterministic engines have signals to derive from.
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

  // A lead on tenant A, assigned to the admin so routing/workload engines have an owner.
  const l1 = await api("POST", "/leads", adminToken, {
    contactId,
    stage: "new",
    title: "QA opportunity",
    value: 5000,
    currency: "USD",
    assignedToId: adminUserId,
  });
  expect(l1.status).toBe(201);
  leadId = (await l1.json()).id;

  // An organization — created via the API so the app derives normalizedName (NOT NULL).
  const orgRes = await api("POST", "/organizations", adminToken, { name: `Globex Corp ${SUFFIX}`, industry: "Manufacturing" });
  expect(orgRes.status).toBe(201);
  orgId = (await orgRes.json()).id;

  // --- Tenant B (cross-tenant isolation) ---
  const createCoB = await api("POST", "/companies", platformToken, { name: `QA Workflow B ${SUFFIX}`, plan: "professional" });
  expect(createCoB.status).toBe(201);
  companyBId = (await createCoB.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyBId));
  await createUser(platformToken, ADMIN_B_EMAIL, "QA Workflow Admin B", "primary_admin", companyBId);
  adminBToken = await loginToken({ email: ADMIN_B_EMAIL, password: PW });

  const cb = await api("POST", "/contacts", adminBToken, { firstName: "Bob", lastName: "Foreign", email: `bob-${SUFFIX}@example.com` });
  expect(cb.status).toBe(201);
  const foreignContactId = (await cb.json()).id;
  const lb = await api("POST", "/leads", adminBToken, { contactId: foreignContactId, stage: "new", title: "Foreign lead" });
  expect(lb.status).toBe(201);
  foreignLeadId = (await lb.json()).id;
});

afterAll(async () => {
  for (const cid of [companyId, companyBId]) {
    if (!cid) continue;
    await db.delete(aiWorkflowRecommendationsTable).where(eq(aiWorkflowRecommendationsTable.companyId, cid));
    await db.delete(notificationsTable).where(eq(notificationsTable.companyId, cid));
    await db.delete(aiSettingsTable).where(eq(aiSettingsTable.companyId, cid));
    await db.delete(leadsTable).where(eq(leadsTable.companyId, cid));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, cid));
    await db.delete(organizationsTable).where(eq(organizationsTable.companyId, cid));
    await db.delete(usersTable).where(eq(usersTable.companyId, cid));
    await db.delete(companiesTable).where(eq(companiesTable.id, cid));
  }
});

describe("POST /ai/workflow/:entityType/:id/analyze — validation", () => {
  it("400s an unknown entityType", async () => {
    const res = await api("POST", `/ai/workflow/widget/${leadId}/analyze`, adminToken, {});
    expect(res.status).toBe(400);
  });

  it("404s a non-existent lead", async () => {
    const res = await api("POST", `/ai/workflow/lead/99999999/analyze`, adminToken, {});
    expect(res.status).toBe(404);
  });
});

describe("Analyze — grounded recommendations, provenance-correct", () => {
  it("generates recommendations for a lead with grounded, honest provenance", async () => {
    const recs = await analyze(adminToken, "lead", leadId);
    expect(recs.length).toBeGreaterThan(0);
    for (const rec of recs) {
      expect(rec.entityType).toBe("lead");
      expect(rec.entityId).toBe(leadId);
      expect(rec.companyId).toBe(companyId);
      expect(typeof rec.recommendationType).toBe("string");
      expect(["ai", "deterministic"]).toContain(rec.source);
      expect(["suggested", "accepted", "dismissed"]).toContain(rec.status);
      // Provenance honesty: a deterministic row must NOT masquerade as AI.
      if (rec.source === "deterministic") {
        expect(rec.provider ?? null).toBeNull();
        expect(rec.model ?? null).toBeNull();
        expect(rec.promptKey ?? null).toBeNull();
      } else {
        expect(typeof rec.model).toBe("string");
        expect(String(rec.model).length).toBeGreaterThan(0);
      }
    }
  });

  it("accepts an ar language option without failing", async () => {
    const res = await api("POST", `/ai/workflow/lead/${leadId}/analyze`, adminToken, { language: "ar" });
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).recommendations)).toBe(true);
  });

  it("generates recommendations for a contact and an organization", async () => {
    expect((await analyze(adminToken, "contact", contactId)).length).toBeGreaterThanOrEqual(0);
    expect((await analyze(adminToken, "organization", orgId)).length).toBeGreaterThanOrEqual(0);
  });

  it("re-analyzing upserts (no duplicate rows) for the same entity", async () => {
    await analyze(adminToken, "lead", leadId);
    await analyze(adminToken, "lead", leadId);
    const res = await api("GET", `/ai/workflow/lead/${leadId}`, adminToken);
    expect(res.status).toBe(200);
    const { recommendations } = await res.json();
    const types = recommendations.map((r: { recommendationType: string }) => r.recommendationType);
    expect(new Set(types).size).toBe(types.length); // one row per recommendationType
  });

  it("writes an audit_logs row for an analyze action (ai_workflow.post)", async () => {
    const [before] = await db.select({ id: auditLogsTable.id }).from(auditLogsTable).orderBy(desc(auditLogsTable.id)).limit(1);
    const sinceId = before?.id ?? 0;
    await analyze(adminToken, "lead", leadId);
    let hit: { id: number } | undefined;
    for (let i = 0; i < 20 && !hit; i++) {
      [hit] = await db
        .select({ id: auditLogsTable.id })
        .from(auditLogsTable)
        .where(and(eq(auditLogsTable.action, "ai_workflow.post"), eq(auditLogsTable.userId, adminUserId), gt(auditLogsTable.id, sinceId)))
        .orderBy(desc(auditLogsTable.id))
        .limit(1);
      if (!hit) await new Promise((r) => setTimeout(r, 100));
    }
    expect(hit).toBeTruthy();
  });
});

describe("GET /ai/workflow/:entityType/:id — listing (tenant-scoped)", () => {
  it("returns stored recommendations for the caller's tenant only", async () => {
    await analyze(adminToken, "lead", leadId);
    const res = await api("GET", `/ai/workflow/lead/${leadId}`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.recommendations)).toBe(true);
    expect(body.recommendations.every((r: { companyId: number }) => r.companyId === companyId)).toBe(true);
  });
});

describe("Review lifecycle (accept / dismiss) — records approval, never auto-writes", () => {
  it("accept sets status accepted + acceptedById, and does not mutate the source lead", async () => {
    const recs = await analyze(adminToken, "lead", leadId);
    const recId = recs[0].id as number;
    const leadBefore = await (await api("GET", `/leads/${leadId}`, adminToken)).json();

    const res = await api("POST", `/ai/workflow/recommendations/${recId}/accept`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("accepted");
    expect(body.acceptedById).toBe(adminUserId);
    expect(typeof body.acceptedAt).toBe("string");

    // Advisory-only: accepting a recommendation must NOT change the CRM record itself.
    const leadAfter = await (await api("GET", `/leads/${leadId}`, adminToken)).json();
    expect(leadAfter.assignedToId).toBe(leadBefore.assignedToId);
    expect(leadAfter.stage).toBe(leadBefore.stage);
  });

  it("dismiss sets status dismissed", async () => {
    const recs = await analyze(adminToken, "contact", contactId);
    if (recs.length === 0) return; // nothing to dismiss for this fixture
    const recId = recs[0].id as number;
    const res = await api("POST", `/ai/workflow/recommendations/${recId}/dismiss`, adminToken);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("dismissed");
  });

  it("404s accepting a recommendation from another tenant (no existence leak)", async () => {
    const recs = await analyze(adminToken, "lead", leadId);
    const recId = recs[0].id as number;
    const res = await api("POST", `/ai/workflow/recommendations/${recId}/accept`, adminBToken);
    expect(res.status).toBe(404);
  });

  it("404s a non-existent recommendation id", async () => {
    const res = await api("POST", `/ai/workflow/recommendations/99999999/accept`, adminToken);
    expect(res.status).toBe(404);
  });
});

// The web/mobile "Apply" button does NOT introduce a new write path. It routes the
// recommended value through the EXISTING manual CRM endpoint (PATCH /leads|/contacts).
// This proves the handoff contract: accepting a recommendation writes nothing, and the
// only way the recommended field lands on the record is an explicit manual update.
describe("Apply handoff — Accept never writes; the recommended value only lands via manual PATCH", () => {
  it("accept leaves the lead's assignedToId + stage untouched, then a manual PATCH is the write path", async () => {
    const recs = await analyze(adminToken, "lead", leadId);
    const recId = recs[0].id as number;
    const before = await (await api("GET", `/leads/${leadId}`, adminToken)).json();

    // 1) Accepting records approval only — the CRM record is NOT mutated.
    const acc = await api("POST", `/ai/workflow/recommendations/${recId}/accept`, adminToken);
    expect(acc.status).toBe(200);
    const afterAccept = await (await api("GET", `/leads/${leadId}`, adminToken)).json();
    expect(afterAccept.assignedToId).toBe(before.assignedToId);
    expect(afterAccept.stage).toBe(before.stage);

    // 2) The user-initiated Apply writes through the normal manual endpoint (leads
    //    accept assignedToId — not followUpDate, which is a contacts-only column).
    const patch = await api("PATCH", `/leads/${leadId}`, adminToken, { assignedToId: adminUserId });
    expect(patch.status).toBe(200);
    const afterApply = await (await api("GET", `/leads/${leadId}`, adminToken)).json();
    expect(afterApply.assignedToId).toBe(adminUserId);

    // restore
    await api("PATCH", `/leads/${leadId}`, adminToken, { assignedToId: before.assignedToId ?? null });
  });
});

describe("GET /ai/workflow/overview — tenant-wide review summary", () => {
  it("returns status counts and recent recommendations for the caller's tenant only", async () => {
    await analyze(adminToken, "lead", leadId);
    const res = await api("GET", `/ai/workflow/overview`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toBeDefined();
    expect(Array.isArray(body.recent)).toBe(true);
    expect(body.recent.every((r: { companyId: number }) => r.companyId === companyId)).toBe(true);
  });
});

describe("Org-scoped read-only rollups (health / sla-risks / bottlenecks)", () => {
  it("health returns a scope + health payload", async () => {
    const res = await api("GET", `/ai/workflow/health`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBeDefined();
    expect(body.scope.type).toBe("company");
  });

  it("sla-risks returns scope, total, counts and a risks array", async () => {
    const res = await api("GET", `/ai/workflow/sla-risks`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.total).toBe("number");
    expect(body.counts).toBeDefined();
    expect(Array.isArray(body.risks)).toBe(true);
  });

  it("bottlenecks returns scope, bottlenecks and a riskCount", async () => {
    const res = await api("GET", `/ai/workflow/bottlenecks`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.bottlenecks)).toBe(true);
    expect(typeof body.riskCount).toBe("number");
  });

  it("every SLA risk item carries a deterministic confidence (100)", async () => {
    // A fresh contact — leads are one-open-lead-per-contact (409 otherwise).
    const cRes = await api("POST", "/contacts", adminToken, {
      firstName: "Otto",
      lastName: "Overdue",
      email: `otto.overdue-${SUFFIX}@example.com`,
    });
    expect(cRes.status).toBe(201);
    const overdueContactId = (await cRes.json()).id;
    // Seed a guaranteed risk: a lead whose closing date is already in the past.
    const overdue = await api("POST", "/leads", adminToken, {
      contactId: overdueContactId,
      stage: "new",
      title: `Overdue QA lead ${SUFFIX}`,
      value: 1000,
      currency: "USD",
      assignedToId: adminUserId,
      closingDate: "2020-01-01",
    });
    expect(overdue.status).toBe(201);
    const overdueId = (await overdue.json()).id;
    try {
      const res = await api("GET", `/ai/workflow/sla-risks`, adminToken);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.risks)).toBe(true);
      expect(body.risks.length).toBeGreaterThan(0);
      for (const r of body.risks) {
        expect(typeof r.confidence).toBe("number");
        expect(r.confidence).toBe(100);
      }
    } finally {
      await api("DELETE", `/leads/${overdueId}`, adminToken);
    }
  });
});

describe("Progression — uses the tenant's configured pipeline stages, not canonical fallbacks", () => {
  it("suggests the company's real next stage for a non-canonical pipeline", async () => {
    // Creating the first stage lazily seeds the six DEFAULT_STAGES (which happen to
    // mirror the canonical fallback). To prove progression reads the TENANT pipeline
    // and not the canonical fallback, we build a non-canonical pipeline and then drop
    // the seeded defaults so only our custom stages remain at analyze time.
    const created: number[] = [];
    const mkStage = async (name: string, sortOrder: number, extra?: Record<string, unknown>) => {
      const res = await api("POST", "/pipeline/stages", adminToken, { name, sortOrder, ...extra });
      expect(res.status, `create stage ${name}`).toBe(201);
      created.push((await res.json()).id);
    };
    // Non-canonical ordering: "contacted" then "meeting_scheduled". Both are valid
    // lead-stage enum values but are NOT in the canonical progression set — so the
    // canonical fallback would return no next stage for a lead in "contacted".
    await mkStage("Contacted", 0);
    await mkStage("Meeting Scheduled", 1);
    await mkStage("Closing", 2, { isWon: true });

    // Drop the auto-seeded defaults so the live pipeline is purely non-canonical.
    // (No further createStage calls follow, so ensureStages won't re-seed.)
    const listRes = await api("GET", "/pipeline/stages", adminToken);
    expect(listRes.status).toBe(200);
    const { stages } = (await listRes.json()) as { stages: Array<{ id: number; isDefault: boolean }> };
    for (const s of stages) {
      if (s.isDefault) await api("DELETE", `/pipeline/stages/${s.id}`, adminToken);
    }

    // A fresh contact — leads are one-open-lead-per-contact (409 otherwise).
    const cRes = await api("POST", "/contacts", adminToken, {
      firstName: "Iris",
      lastName: "Intake",
      email: `iris.intake-${SUFFIX}@example.com`,
    });
    expect(cRes.status).toBe(201);
    const customContactId = (await cRes.json()).id;
    // A lead sitting in the first custom stage.
    const leadRes = await api("POST", "/leads", adminToken, {
      contactId: customContactId,
      stage: "contacted",
      title: `Custom-pipeline lead ${SUFFIX}`,
      value: 2000,
      currency: "USD",
      assignedToId: adminUserId,
    });
    expect(leadRes.status).toBe(201);
    const customLeadId = (await leadRes.json()).id;

    try {
      const recs = await analyze(adminToken, "lead", customLeadId);
      const prog = recs.find((r) => r.recommendationType === "progression");
      expect(prog, "progression recommendation present").toBeDefined();
      const data = prog!.data as { suggestedStageName?: string | null; suggestedStageKey?: string | null };
      // The next stage must be the tenant's "Meeting Scheduled" — the canonical
      // fallback has no "contacted" stage, so it would never produce this.
      expect(data.suggestedStageName).toBe("Meeting Scheduled");
    } finally {
      await api("DELETE", `/leads/${customLeadId}`, adminToken);
      for (const id of created) await api("DELETE", `/pipeline/stages/${id}`, adminToken);
    }
  });
});

describe("POST /ai/workflow/simulate — what-if prediction (writes NOTHING)", () => {
  it("400s an invalid scenario", async () => {
    const res = await api("POST", `/ai/workflow/simulate`, adminToken, { leadId, scenario: "bogus" });
    expect(res.status).toBe(400);
  });

  it("400s reassign without a candidateUserId", async () => {
    const res = await api("POST", `/ai/workflow/simulate`, adminToken, { leadId, scenario: "reassign" });
    expect(res.status).toBe(400);
  });

  it("predicts a follow_up scenario with baseline/predicted/deltas and does not change the lead", async () => {
    const leadBefore = await (await api("GET", `/leads/${leadId}`, adminToken)).json();
    const res = await api("POST", `/ai/workflow/simulate`, adminToken, { leadId, scenario: "follow_up" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.leadId).toBe(leadId);
    expect(typeof body.baseline.winProbability).toBe("number");
    expect(typeof body.predicted.winProbability).toBe("number");
    expect(typeof body.deltas.winProbability).toBe("number");
    expect(typeof body.explanation).toBe("string");
    expect(Array.isArray(body.assumptions)).toBe(true);
    expect(typeof body.confidence).toBe("number");

    const leadAfter = await (await api("GET", `/leads/${leadId}`, adminToken)).json();
    expect(leadAfter.stage).toBe(leadBefore.stage);
    expect(leadAfter.assignedToId).toBe(leadBefore.assignedToId);
  });

  it("404s simulating a foreign lead", async () => {
    const res = await api("POST", `/ai/workflow/simulate`, adminToken, { leadId: foreignLeadId, scenario: "follow_up" });
    expect(res.status).toBe(404);
  });
});

describe("Cross-tenant isolation (404 not 403)", () => {
  it("404s analyzing a foreign lead", async () => {
    const res = await api("POST", `/ai/workflow/lead/${foreignLeadId}/analyze`, adminToken, {});
    expect(res.status).toBe(404);
  });

  it("404s listing a foreign lead's recommendations", async () => {
    const res = await api("GET", `/ai/workflow/lead/${foreignLeadId}`, adminToken);
    expect(res.status).toBe(404);
  });
});

describe("RBAC — deny-by-default employee", () => {
  it("403s an employee analyzing (no ai_workflow.generate)", async () => {
    const res = await api("POST", `/ai/workflow/lead/${leadId}/analyze`, empToken, {});
    expect(res.status).toBe(403);
  });

  it("403s an employee reading recommendations without ai_workflow.view", async () => {
    const res = await api("GET", `/ai/workflow/lead/${leadId}`, empToken);
    expect(res.status).toBe(403);
  });

  it("granting view unlocks reads but accept/generate stay 403", async () => {
    await db.update(usersTable).set({ permissions: { ai_workflow: ["view"] } }).where(eq(usersTable.id, empUserId));
    try {
      expect((await api("GET", `/ai/workflow/lead/${leadId}`, empToken)).status).toBe(200);
      // The COMPANY-WIDE overview is manager-only — an employee with view still can't
      // see every colleague's recommendations (scope-privacy contract, not a perm gap).
      expect((await api("GET", `/ai/workflow/overview`, empToken)).status).toBe(403);
      // generate (analyze) still requires the separate ai_workflow.generate permission.
      expect((await api("POST", `/ai/workflow/lead/${leadId}/analyze`, empToken, {})).status).toBe(403);
      // accept requires the separate ai_workflow.accept permission.
      const recs = await analyze(adminToken, "lead", leadId);
      const recId = recs[0].id as number;
      expect((await api("POST", `/ai/workflow/recommendations/${recId}/accept`, empToken)).status).toBe(403);
    } finally {
      await db.update(usersTable).set({ permissions: {} }).where(eq(usersTable.id, empUserId));
    }
  });
});

describe("Platform-owner tenant firewall (requireTenantUser)", () => {
  it("403s a platform_owner on the workflow overview (customer CRM is fenced off)", async () => {
    const res = await api("GET", `/ai/workflow/overview`, platformToken);
    expect(res.status).toBe(403);
  });

  it("403s a platform_owner analyzing an entity", async () => {
    const res = await api("POST", `/ai/workflow/lead/${leadId}/analyze`, platformToken, {});
    expect(res.status).toBe(403);
  });
});

describe("POST /ai/workflow/batch — tenant-scoped batch (re)analysis", () => {
  it("400s an unknown entityType", async () => {
    const res = await api("POST", `/ai/workflow/batch`, adminToken, { entityType: "widget" });
    expect(res.status).toBe(400);
  });

  it("403s an employee starting a batch (no ai_workflow.generate)", async () => {
    const res = await api("POST", `/ai/workflow/batch`, empToken, { entityType: "contact" });
    expect(res.status).toBe(403);
  });

  it("starts a lead batch scoped to the caller's tenant and completes", async () => {
    const res = await api("POST", `/ai/workflow/batch`, adminToken, { entityType: "lead" });
    expect(res.status).toBe(202);
    const job = await res.json();
    expect(typeof job.id).toBe("string");
    expect(job.companyId).toBe(companyId);
    expect(job.entityType).toBe("lead");
    expect(["queued", "running", "completed"]).toContain(job.status);
    expect(job.total).toBeGreaterThanOrEqual(1);

    let final = job;
    for (let i = 0; i < 60 && final.status !== "completed" && final.status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const poll = await api("GET", `/ai/workflow/batch/${job.id}`, adminToken);
      expect(poll.status).toBe(200);
      final = await poll.json();
    }
    expect(final.status).toBe("completed");
    expect(final.processed).toBe(final.total);
    expect(final.succeeded + final.failed).toBe(final.total);
  });

  it("lists batch jobs for the caller's tenant only", async () => {
    const res = await api("GET", `/ai/workflow/batch`, adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.jobs.every((j: { companyId: number }) => j.companyId === companyId)).toBe(true);
  });

  it("404s fetching another tenant's batch job (no existence leak)", async () => {
    const start = await api("POST", `/ai/workflow/batch`, adminToken, { entityType: "contact" });
    const job = await start.json();
    const res = await api("GET", `/ai/workflow/batch/${job.id}`, adminBToken);
    expect(res.status).toBe(404);
  });

  it("404s a non-existent batch job id", async () => {
    const res = await api("GET", `/ai/workflow/batch/00000000-0000-0000-0000-000000000000`, adminToken);
    expect(res.status).toBe(404);
  });
});

// Stage 5F rollout: the workflow routes are requirePermission("ai_workflow", ...)-gated,
// so shipping them would 403-lock every pre-existing admin/employee whose stored
// permissions predate the module. The startup backfill (backfillAiWorkflowPermissions)
// closes that gap without reseeding. Here we simulate PRE-upgrade rows and prove the
// backfill restores access per policy and is idempotent.
describe("Stage 5F upgrade path — ai_workflow RBAC backfill (no lockout for pre-existing users)", () => {
  let upAdminId = 0;
  let upEmpId = 0;
  let upAdminToken = "";
  let upEmpToken = "";

  beforeAll(async () => {
    const upAdminEmail = `qa-upadmin@${DOMAIN}`;
    const upEmpEmail = `qa-upemp@${DOMAIN}`;
    upAdminId = await createUser(adminToken, upAdminEmail, "Upgrade Admin", "admin");
    upEmpId = await createUser(adminToken, upEmpEmail, "Upgrade Emp", "employee");
    // Simulate rows created BEFORE the ai_workflow module existed: no ai_workflow key.
    await db.update(usersTable).set({ permissions: { contacts: ["view"] } }).where(eq(usersTable.id, upAdminId));
    await db.update(usersTable).set({ permissions: { contacts: ["view"] } }).where(eq(usersTable.id, upEmpId));
    upAdminToken = await loginToken({ email: upAdminEmail, password: PW });
    upEmpToken = await loginToken({ email: upEmpEmail, password: PW });
  });

  it("pre-upgrade admin/employee are locked out of the workflow before backfill (403)", async () => {
    expect((await api("GET", `/ai/workflow/lead/${leadId}`, upAdminToken)).status).toBe(403);
    expect((await api("GET", `/ai/workflow/lead/${leadId}`, upEmpToken)).status).toBe(403);
  });

  it("backfill restores admin (view/generate/accept) + employee (view only) without reseeding", async () => {
    const res = await backfillAiWorkflowPermissions();
    expect(res.admins + res.employees).toBeGreaterThanOrEqual(2);
    // admin: full access incl. generate.
    expect((await api("GET", `/ai/workflow/lead/${leadId}`, upAdminToken)).status).toBe(200);
    expect((await api("POST", `/ai/workflow/lead/${leadId}/analyze`, upAdminToken, {})).status).toBe(200);
    // employee: view (read) restored, but writes stay deny-by-default (opt-in).
    expect((await api("GET", `/ai/workflow/lead/${leadId}`, upEmpToken)).status).toBe(200);
    expect((await api("POST", `/ai/workflow/lead/${leadId}/analyze`, upEmpToken, {})).status).toBe(403);
  });

  it("is idempotent — re-running does not alter already-provisioned rows", async () => {
    await backfillAiWorkflowPermissions();
    const [adminRow] = await db.select({ p: usersTable.permissions }).from(usersTable).where(eq(usersTable.id, upAdminId));
    const [empRow] = await db.select({ p: usersTable.permissions }).from(usersTable).where(eq(usersTable.id, upEmpId));
    expect((adminRow.p as Record<string, string[]>).ai_workflow).toEqual(["view", "generate", "accept"]);
    expect((empRow.p as Record<string, string[]>).ai_workflow).toEqual(["view"]);
  });
});

describe("Workflow rules — tenant-configurable thresholds via /ai/settings", () => {
  it("GET /ai/settings exposes effective workflowRules (defaults when unset)", async () => {
    const res = await api("GET", "/ai/settings", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflowRules).toBeDefined();
    expect(body.workflowRules.stalledDays).toBe(14);
    expect(body.workflowRules.followupOverdueCriticalDays).toBe(7);
  });

  it("PATCH merges a partial override over effective rules; rest stay default", async () => {
    const res = await api("PATCH", "/ai/settings", adminToken, { workflowRules: { stalledDays: 3 } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workflowRules.stalledDays).toBe(3);
    expect(body.workflowRules.agingDays).toBe(30); // untouched key keeps default
  });

  it("400s an unknown rule key, out-of-bounds and non-integer values", async () => {
    expect((await api("PATCH", "/ai/settings", adminToken, { workflowRules: { nope: 5 } })).status).toBe(400);
    expect((await api("PATCH", "/ai/settings", adminToken, { workflowRules: { stalledDays: 0 } })).status).toBe(400);
    expect((await api("PATCH", "/ai/settings", adminToken, { workflowRules: { stalledDays: 400 } })).status).toBe(400);
    expect((await api("PATCH", "/ai/settings", adminToken, { workflowRules: { stalledDays: 2.5 } })).status).toBe(400);
  });

  it("custom rules change what the risk engine flags (stalled lead appears)", async () => {
    // Age the lead's updatedAt by 5 days: NOT stalled under stalledDays=14, stalled under 3.
    await db
      .update(leadsTable)
      .set({ updatedAt: new Date(Date.now() - 5 * 86_400_000) })
      .where(eq(leadsTable.id, leadId));
    const res = await api("GET", "/ai/workflow/sla-risks", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    const stalled = (body.risks as Array<Record<string, unknown>>).filter(
      (r) => r.entityType === "lead" && r.entityId === leadId && r.category === "stalled_stage",
    );
    expect(stalled.length).toBeGreaterThan(0);
  });

  it("workflowRules: null resets to platform defaults (stalled risk disappears)", async () => {
    const res = await api("PATCH", "/ai/settings", adminToken, { workflowRules: null });
    expect(res.status).toBe(200);
    expect((await res.json()).workflowRules.stalledDays).toBe(14);
    const risks = await api("GET", "/ai/workflow/sla-risks", adminToken);
    const body = await risks.json();
    const stalled = (body.risks as Array<Record<string, unknown>>).filter(
      (r) => r.entityType === "lead" && r.entityId === leadId && r.category === "stalled_stage",
    );
    expect(stalled.length).toBe(0);
  });

  it("employee cannot change workflow rules (RBAC on /ai/settings)", async () => {
    expect((await api("PATCH", "/ai/settings", empToken, { workflowRules: { stalledDays: 5 } })).status).toBe(403);
  });
});

describe("POST /ai/workflow/alerts/run — advisory risk notifications, deduped daily", () => {
  it("403s an employee without ai_workflow.generate", async () => {
    expect((await api("POST", "/ai/workflow/alerts/run", empToken)).status).toBe(403);
  });

  it("dispatches notifications for critical/high risks, then dedupes within the day", async () => {
    // Force a CRITICAL risk: contact follow-up 10 days overdue (> followupOverdueCriticalDays=7).
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    const dstr = `${tenDaysAgo.getFullYear()}-${String(tenDaysAgo.getMonth() + 1).padStart(2, "0")}-${String(tenDaysAgo.getDate()).padStart(2, "0")}`;
    const upd = await api("PATCH", `/contacts/${contactId}`, adminToken, { followUpDate: dstr });
    expect(upd.status).toBe(200);

    const first = await api("POST", "/ai/workflow/alerts/run", adminToken);
    expect(first.status).toBe(200);
    const r1 = await first.json();
    // At minimum the primary admin gets an executive rollup for the tenant.
    expect(r1.notified).toBeGreaterThan(0);

    // Same-day re-run: everyone already alerted → nothing new goes out.
    const second = await api("POST", "/ai/workflow/alerts/run", adminToken);
    expect(second.status).toBe(200);
    const r2 = await second.json();
    expect(r2.notified).toBe(0);
    expect(r2.skipped).toBeGreaterThan(0);

    // The dispatched notification is advisory metadata-tagged, never a CRM write.
    const [note] = await db
      .select({ metadata: notificationsTable.metadata, category: notificationsTable.category, link: notificationsTable.link })
      .from(notificationsTable)
      .where(eq(notificationsTable.companyId, companyId))
      .orderBy(desc(notificationsTable.id))
      .limit(1);
    expect(note).toBeDefined();
    expect((note.metadata as Record<string, unknown>).kind).toBe("workflow_alerts");
    expect(note.category).toBe("ai");
    expect(note.link).toBe("/admin/workflow");
  });
});

// MUST run last: it flips tenant B to a read-only (cancelled) status.
describe("Read-only tenant (cancelled) — mutations blocked, reads allowed", () => {
  it("403s a workflow analyze for a cancelled tenant but still allows reads", async () => {
    await db.update(companiesTable).set({ status: "cancelled" }).where(eq(companiesTable.id, companyBId));
    try {
      const gen = await api("POST", `/ai/workflow/lead/${foreignLeadId}/analyze`, adminBToken, {});
      expect(gen.status).toBe(403); // blockReadOnlyMutations
      const read = await api("GET", `/ai/workflow/lead/${foreignLeadId}`, adminBToken);
      expect(read.status).toBe(200); // reads stay open in read-only mode
    } finally {
      await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyBId));
    }
  });
});
