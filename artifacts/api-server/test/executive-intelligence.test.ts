import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  contactsTable,
  leadsTable,
  scansTable,
  executiveSummariesTable,
  executiveAlertsTable,
  executiveForecastsTable,
  executiveReportsTable,
} from "@workspace/db";

// Stage 5C — Enterprise AI Executive Intelligence Center. Exercises the
// /ai/executive endpoints against the LIVE API (localhost:80): read-only
// dashboard rollup, reviewable executive summaries (generate/accept/dismiss),
// deterministic forecasts, executive alerts, and async AI report export.
// Assertions focus on the DETERMINISTIC grounded cores which always run
// regardless of LLM availability, so the suite is not flaky when the model is
// slow/unconfigured. It also pins the load-bearing invariants for this surface:
//   - platform_owner is fenced out of tenant CRM (403, requireTenantUser),
//   - deny-by-default writes for constrained roles (empty perms => 403),
//   - honest provenance (a deterministic row never carries AI provider/prompt),
//   - AI phrasing soft-degrades to 200 (never 500),
//   - strict tenant isolation (cross-tenant reads are 404, not 403).
// All fixtures live under throwaway tenants torn down in afterAll so the demo
// accounts are untouched.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";

const SUFFIX = Date.now();
const DOMAIN = `execintel-${SUFFIX}.test`;
const DOMAIN_B = `execintelb-${SUFFIX}.test`;
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

let summaryId = 0;
let reportId = 0;

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
  const createCo = await api("POST", "/companies", platformToken, { name: `QA Exec Intel ${SUFFIX}`, plan: "enterprise" });
  expect(createCo.status).toBe(201);
  companyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyId));

  await createUser(platformToken, ADMIN_EMAIL, "QA Exec Admin", "primary_admin", companyId);
  adminToken = await loginToken({ email: ADMIN_EMAIL, password: PW });
  empUserId = await createUser(adminToken, EMP_EMAIL, "QA Exec Emp", "employee");
  empToken = await loginToken({ email: EMP_EMAIL, password: PW });

  // Seed a little real CRM data so signals/forecast are non-trivial.
  const c1 = await api("POST", "/contacts", adminToken, {
    firstName: "Nora",
    lastName: "Vale",
    email: `nora.vale-${SUFFIX}@example.com`,
    jobTitle: "VP Sales",
  });
  expect(c1.status).toBe(201);
  const contactId = (await c1.json()).id;

  const c2 = await api("POST", "/contacts", adminToken, {
    firstName: "Ivo",
    lastName: "Reed",
    email: `ivo.reed-${SUFFIX}@example.com`,
  });
  expect(c2.status).toBe(201);
  const contact2Id = (await c2.json()).id;

  // One lead per contact — the pipeline enforces a single active lead per contact (409 otherwise).
  const l1 = await api("POST", "/leads", adminToken, { contactId, stage: "won", title: "Won deal", value: 12000, currency: "USD" });
  expect(l1.status).toBe(201);
  const l2 = await api("POST", "/leads", adminToken, { contactId: contact2Id, stage: "new", title: "Open deal", value: 8000, currency: "USD" });
  expect(l2.status).toBe(201);

  // --- Tenant B (cross-tenant isolation) ---
  const createCoB = await api("POST", "/companies", platformToken, { name: `QA Exec Intel B ${SUFFIX}`, plan: "enterprise" });
  expect(createCoB.status).toBe(201);
  companyBId = (await createCoB.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, companyBId));
  await createUser(platformToken, ADMIN_B_EMAIL, "QA Exec Admin B", "primary_admin", companyBId);
  adminBToken = await loginToken({ email: ADMIN_B_EMAIL, password: PW });
}, 60_000);

afterAll(async () => {
  for (const cid of [companyId, companyBId]) {
    if (!cid) continue;
    await db.delete(executiveReportsTable).where(eq(executiveReportsTable.companyId, cid));
    await db.delete(executiveForecastsTable).where(eq(executiveForecastsTable.companyId, cid));
    await db.delete(executiveAlertsTable).where(eq(executiveAlertsTable.companyId, cid));
    await db.delete(executiveSummariesTable).where(eq(executiveSummariesTable.companyId, cid));
    await db.delete(scansTable).where(eq(scansTable.companyId, cid));
    await db.delete(leadsTable).where(eq(leadsTable.companyId, cid));
    await db.delete(contactsTable).where(eq(contactsTable.companyId, cid));
    await db.delete(usersTable).where(eq(usersTable.companyId, cid));
    await db.delete(companiesTable).where(eq(companiesTable.id, cid));
  }
});

describe("GET /ai/executive/dashboard — read-only rollup", () => {
  it("401s without a token", async () => {
    const res = await fetch(`${BASE}/ai/executive/dashboard`);
    expect(res.status).toBe(401);
  });

  it("fences out platform_owner (403 — tenant CRM only)", async () => {
    const res = await api("GET", "/ai/executive/dashboard", platformToken);
    expect(res.status).toBe(403);
  });

  it("fences platform_owner out of write endpoints too (403 on summary + report generation)", async () => {
    const gen = await api("POST", "/ai/executive/summaries", platformToken, { periodType: "weekly" });
    expect(gen.status).toBe(403);
    const rep = await api("POST", "/ai/executive/reports", platformToken, { reportType: "executive_summary", format: "pdf" });
    expect(rep.status).toBe(403);
  });

  it("returns a grounded dashboard for a tenant admin", async () => {
    const res = await api("GET", "/ai/executive/dashboard", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.scope.name).toBe("string");
    for (const key of ["business", "sales", "pipeline"] as const) {
      expect(typeof body.health[key].score).toBe("number");
      expect(["excellent", "good", "fair", "at_risk"]).toContain(body.health[key].rating);
    }
    expect(body.kpis).toBeDefined();
    expect(typeof body.forecast.expected).toBe("number");
    expect(body.forecast.low).toBeLessThanOrEqual(body.forecast.high);
    expect(Array.isArray(body.teamPerformance)).toBe(true);
    expect(Array.isArray(body.alerts)).toBe(true);
    expect(Array.isArray(body.revenueSeries)).toBe(true);
  });
});

describe("Executive summaries — generate + review lifecycle", () => {
  it("400s an invalid periodType", async () => {
    const res = await api("POST", "/ai/executive/summaries", adminToken, { periodType: "hourly" });
    expect(res.status).toBe(400);
  });

  it("generates a summary with an honest deterministic core (soft-degrade, never 500)", async () => {
    const res = await api("POST", "/ai/executive/summaries", adminToken, { periodType: "weekly" });
    expect(res.status).toBe(200);
    const s = await res.json();
    summaryId = s.id;
    expect(s.companyId).toBe(companyId);
    expect(s.periodType).toBe("weekly");
    expect(s.status).toBe("suggested");
    expect(["ai", "deterministic"]).toContain(s.source);
    expect(typeof s.data.headline).toBe("string");
    expect(s.data.headline.length).toBeGreaterThan(0);
    // Honest provenance: a deterministic row never masquerades as AI.
    if (s.source === "deterministic") {
      expect(s.provider ?? null).toBeNull();
      expect(s.promptKey ?? null).toBeNull();
    }
  });

  it("lists the generated summary", async () => {
    const res = await api("GET", "/ai/executive/summaries", adminToken);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summaries.some((s: { id: number }) => s.id === summaryId)).toBe(true);
  });

  it("accepts then dismisses the summary (auditable lifecycle)", async () => {
    const accept = await api("POST", `/ai/executive/summaries/${summaryId}/accept`, adminToken);
    expect(accept.status).toBe(200);
    expect((await accept.json()).status).toBe("accepted");

    const dismiss = await api("POST", `/ai/executive/summaries/${summaryId}/dismiss`, adminToken);
    expect(dismiss.status).toBe(200);
    expect((await dismiss.json()).status).toBe("dismissed");
  });

  it("isolates summaries across tenants (404, not 403)", async () => {
    const res = await api("GET", `/ai/executive/summaries/${summaryId}`, adminBToken);
    expect(res.status).toBe(404);
  });
});

describe("Executive forecasts", () => {
  it("generates a deterministic revenue forecast with an honest range", async () => {
    const res = await api("POST", "/ai/executive/forecasts", adminToken, { forecastType: "revenue" });
    expect(res.status).toBe(200);
    const f = await res.json();
    expect(f.companyId).toBe(companyId);
    expect(f.forecastType).toBe("revenue");
    expect(["ai", "deterministic"]).toContain(f.source);
    const d = f.data as Record<string, number>;
    expect(typeof d.expected).toBe("number");
    expect(d.low).toBeLessThanOrEqual(d.high);
    if (f.source === "deterministic") expect(f.provider ?? null).toBeNull();
  });

  it("lists forecasts", async () => {
    const res = await api("GET", "/ai/executive/forecasts", adminToken);
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).forecasts)).toBe(true);
  });
});

describe("Executive alerts", () => {
  it("generates alerts (advisory, never auto-executed)", async () => {
    const res = await api("POST", "/ai/executive/alerts/generate", adminToken, {});
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).alerts)).toBe(true);
  });

  it("lists alerts", async () => {
    const res = await api("GET", "/ai/executive/alerts", adminToken);
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).alerts)).toBe(true);
  });
});

describe("AI reports — async export job", () => {
  it("400s an invalid reportType", async () => {
    const res = await api("POST", "/ai/executive/reports", adminToken, { reportType: "widget", format: "pdf" });
    expect(res.status).toBe(400);
  });

  it("400s an invalid format", async () => {
    const res = await api("POST", "/ai/executive/reports", adminToken, { reportType: "executive_summary", format: "docx" });
    expect(res.status).toBe(400);
  });

  it("queues a report (202, pending) and processes it to a downloadable artifact", async () => {
    const res = await api("POST", "/ai/executive/reports", adminToken, { reportType: "executive_summary", format: "pdf" });
    expect(res.status).toBe(202);
    const r = await res.json();
    reportId = r.id;
    expect(r.reportType).toBe("executive_summary");
    expect(r.format).toBe("pdf");
    expect(["pending", "processing", "ready"]).toContain(r.status);

    // Poll the async worker; the deterministic composition + export must reach a
    // terminal "ready" state with a real downloadable artifact (not merely "not failed").
    let status = r.status as string;
    let downloadUrl: string | null = r.downloadUrl ?? null;
    for (let i = 0; i < 40 && status !== "ready" && status !== "failed"; i++) {
      await new Promise((res2) => setTimeout(res2, 1000));
      const poll = await api("GET", `/ai/executive/reports/${reportId}`, adminToken);
      expect(poll.status).toBe(200);
      const pr = await poll.json();
      status = pr.status;
      downloadUrl = pr.downloadUrl ?? null;
    }
    expect(status, "report should reach ready (not fail/timeout)").toBe("ready");
    expect(typeof downloadUrl).toBe("string");
    expect((downloadUrl as string).length).toBeGreaterThan(0);
  }, 55_000);

  it("isolates reports across tenants (404, not 403)", async () => {
    const res = await api("GET", `/ai/executive/reports/${reportId}`, adminBToken);
    expect(res.status).toBe(404);
  });
});

describe("RBAC — deny-by-default writes for constrained roles", () => {
  it("denies an employee with no ai_executive permissions (403 on read and write)", async () => {
    await db.update(usersTable).set({ permissions: {} }).where(eq(usersTable.id, empUserId));

    const view = await api("GET", "/ai/executive/dashboard", empToken);
    expect(view.status).toBe(403);
    const gen = await api("POST", "/ai/executive/summaries", empToken, { periodType: "weekly" });
    expect(gen.status).toBe(403);
  });

  it("grants view-only: employee can read the dashboard but still cannot generate", async () => {
    await db.update(usersTable).set({ permissions: { ai_executive: ["view"] } }).where(eq(usersTable.id, empUserId));

    const view = await api("GET", "/ai/executive/dashboard", empToken);
    expect(view.status).toBe(200);
    const gen = await api("POST", "/ai/executive/summaries", empToken, { periodType: "weekly" });
    expect(gen.status).toBe(403);
  });
});
