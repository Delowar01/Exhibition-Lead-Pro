import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { count, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  companiesTable,
  usersTable,
  scansTable,
  contactsTable,
  leadsTable,
  loginAttemptsTable,
  auditLogsTable,
  securityEventsTable,
  billingProviderEventsTable,
  billingCheckoutSessionsTable,
  subscriptionsTable,
  aiInvocationsTable,
  planPricesTable,
  plansTable,
} from "@workspace/db";

// G-7 — Platform Owner Analytics, exercised against the LIVE API (localhost:80).
//
// Every synthetic row is dated inside January 2001 (or December 2000, the "previous"
// window) — a period no other suite writes to — so each aggregate below is EXACT, not
// "at least". Proves: the figures of all seven endpoints, the UTC window semantics and
// their refusals, that only the Platform Owner can read them (tenant roles 403, anonymous
// 401), and that no tenant CRM record content crosses the Platform Owner firewall — only
// counts, sums and company ids/names. Fixtures are throwaway and removed in afterAll.
const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const WINDOW = "from=2001-01-01&to=2001-01-31";
const ENDPOINTS = ["overview", "growth", "subscriptions", "revenue", "activity", "ai", "operations"] as const;

// Text placed in tenant-owned columns that must never appear in a platform analytics response.
const SECRET = `G7SECRET${SUFFIX}`;

const at = (iso: string) => new Date(`${iso}Z`);

let platformToken = "";
let primaryToken = "";
let adminToken = "";
let employeeToken = "";
let roleCompanyId = 0; // API-created tenant used for the role checks
let pId = 0; // synthetic company created in the previous window
let aId = 0; // synthetic company "Alpha" (current window)
let bId = 0; // synthetic company "Beta" (current window)
let subA = 0;
let planA = "professional";
let planB = "business";
const userIds: number[] = [];
const priceId = `price_g7_${SUFFIX}`;

function headers(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}
async function loginToken(creds: { email: string; password: string }): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(creds) });
  if (!res.ok) throw new Error(`login failed for ${creds.email}: ${res.status}`);
  return (await res.json()).token;
}
async function api(method: string, path: string, token: string, body?: unknown) {
  return fetch(`${BASE}${path}`, { method, headers: headers(token), body: body === undefined ? undefined : JSON.stringify(body) });
}
async function analytics(section: string, query = WINDOW, token = platformToken) {
  const res = await api("GET", `/platform/analytics/${section}?${query}`, token);
  expect(res.status, `${section}?${query}`).toBe(200);
  return res.json();
}
async function createUser(token: string, email: string, name: string, role: string, companyForPlatform?: number): Promise<number> {
  const payload: Record<string, unknown> = { email, name, role, password: PW };
  if (companyForPlatform != null) payload.companyId = companyForPlatform;
  const res = await api("POST", "/users", token, payload);
  expect(res.status, `create user ${email}`).toBe(201);
  return (await res.json()).id;
}
const sum = <T>(rows: T[], pick: (r: T) => number) => rows.reduce((a, r) => a + pick(r), 0);
/** Every property name that occurs anywhere inside a JSON value. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}
const sorted = <T extends { count: number }>(rows: T[], key: keyof T) => [...rows].sort((x, y) => String(x[key]).localeCompare(String(y[key])));

beforeAll(async () => {
  const health = await fetch(`${BASE}/healthz`).catch((err) => {
    throw new Error(`API not reachable at ${BASE} (${String(err)})`);
  });
  if (!health.ok) throw new Error(`API health check failed: ${health.status}`);
  platformToken = await loginToken(PLATFORM);

  // ── a real tenant with one user per tenant role (for the access-control checks) ──
  const createCo = await api("POST", "/companies", platformToken, { name: `G7 Roles ${SUFFIX}`, plan: "professional" });
  expect(createCo.status).toBe(201);
  roleCompanyId = (await createCo.json()).id;
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, roleCompanyId));
  const domain = `g7-${SUFFIX}.test`;
  await createUser(platformToken, `primary@${domain}`, "G7 Primary", "primary_admin", roleCompanyId);
  primaryToken = await loginToken({ email: `primary@${domain}`, password: PW });
  await createUser(primaryToken, `admin@${domain}`, "G7 Admin", "admin");
  adminToken = await loginToken({ email: `admin@${domain}`, password: PW });
  await createUser(primaryToken, `employee@${domain}`, "G7 Employee", "employee");
  employeeToken = await loginToken({ email: `employee@${domain}`, password: PW });

  // ── synthetic companies and users, dated in the isolated windows ──
  const plans = await db.select({ id: plansTable.id }).from(plansTable).orderBy(plansTable.sortOrder);
  if (plans.length > 0) {
    planA = plans.find((p) => p.id === "professional")?.id ?? plans[0].id;
    planB = plans.find((p) => p.id === "business")?.id ?? plans[plans.length - 1].id;
  }
  const co = await db
    .insert(companiesTable)
    .values([
      { name: `G7 Prev ${SUFFIX}`, status: "active", plan: planA, createdAt: at("2000-12-10T08:00:00") },
      { name: `G7 Alpha ${SUFFIX}`, status: "active", plan: planA, createdAt: at("2001-01-05T09:00:00") },
      { name: `G7 Beta ${SUFFIX}`, status: "active", plan: planB, createdAt: at("2001-01-20T15:00:00") },
    ])
    .returning({ id: companiesTable.id });
  [pId, aId, bId] = co.map((c) => c.id);

  const users = await db
    .insert(usersTable)
    .values([
      { email: `p1-${SUFFIX}@g7-synthetic.test`, passwordHash: "synthetic-not-a-hash", name: `${SECRET} user P1`, role: "primary_admin", companyId: pId, createdAt: at("2000-12-11T08:00:00") },
      { email: `a1-${SUFFIX}@g7-synthetic.test`, passwordHash: "synthetic-not-a-hash", name: `${SECRET} user A1`, role: "primary_admin", companyId: aId, createdAt: at("2001-01-05T09:30:00") },
      { email: `a2-${SUFFIX}@g7-synthetic.test`, passwordHash: "synthetic-not-a-hash", name: `${SECRET} user A2`, role: "employee", companyId: aId, createdAt: at("2001-01-06T09:30:00") },
      { email: `b1-${SUFFIX}@g7-synthetic.test`, passwordHash: "synthetic-not-a-hash", name: `${SECRET} user B1`, role: "primary_admin", companyId: bId, createdAt: at("2001-01-20T16:00:00") },
    ])
    .returning({ id: usersTable.id });
  userIds.push(...users.map((u) => u.id));
  const [uP, uA1, uA2] = userIds;

  // ── scans: 6 real ones in the window (both edges included), plus rows that must NOT count ──
  await db.insert(scansTable).values([
    { companyId: aId, status: "completed", extractionMethod: "ai_vision", createdAt: at("2001-01-01T00:00:00.000"), notes: `${SECRET} scan note` },
    { companyId: aId, status: "completed", extractionMethod: "ai_vision", createdAt: at("2001-01-10T12:00:00") },
    { companyId: aId, status: "completed", extractionMethod: "qr", createdAt: at("2001-01-10T13:00:00") },
    { companyId: aId, status: "failed", extractionMethod: null, createdAt: at("2001-01-31T23:59:59.999") },
    { companyId: aId, status: "completed", extractionMethod: "manual", createdAt: at("2001-01-11T10:00:00") }, // manual entry — not a scan
    { companyId: aId, status: "completed", extractionMethod: "ai_vision", createdAt: at("2001-01-12T10:00:00"), deletedAt: at("2001-01-13T10:00:00") }, // deleted
    { companyId: aId, status: "completed", extractionMethod: "ai_vision", createdAt: at("2001-02-01T00:00:00.000") }, // first instant AFTER the window
    { companyId: bId, status: "completed", extractionMethod: "nfc", createdAt: at("2001-01-22T08:00:00") },
    { companyId: bId, status: "pending", extractionMethod: "ai_vision", createdAt: at("2001-01-22T09:00:00") },
    { companyId: pId, status: "completed", extractionMethod: "ai_vision", createdAt: at("2000-12-31T23:59:59") }, // previous window
  ]);

  await db.insert(contactsTable).values([
    { companyId: aId, fullName: `${SECRET} Contact One`, email: `${SECRET.toLowerCase()}-one@contact.test`, mobile: "+10000000001", createdAt: at("2001-01-10T12:05:00") },
    { companyId: aId, fullName: `${SECRET} Contact Two`, createdAt: at("2001-01-10T13:05:00") },
    { companyId: aId, fullName: `${SECRET} Contact Three`, createdAt: at("2001-01-15T09:00:00") },
    { companyId: aId, fullName: `${SECRET} Contact Deleted`, createdAt: at("2001-01-16T09:00:00"), deletedAt: at("2001-01-17T09:00:00") },
    { companyId: bId, fullName: `${SECRET} Contact Beta`, createdAt: at("2001-01-22T08:05:00") },
    { companyId: pId, fullName: `${SECRET} Contact Prev 1`, createdAt: at("2000-12-15T09:00:00") },
    { companyId: pId, fullName: `${SECRET} Contact Prev 2`, createdAt: at("2000-12-20T09:00:00") },
  ]);
  await db.insert(leadsTable).values([
    { companyId: aId, title: `${SECRET} Lead One`, createdAt: at("2001-01-11T09:00:00") },
    { companyId: aId, title: `${SECRET} Lead Two`, createdAt: at("2001-01-17T09:00:00") },
  ]);

  await db.insert(loginAttemptsTable).values([
    { email: `${SECRET.toLowerCase()}@login.test`, userId: uA1, success: true, ipAddress: "203.0.113.7", createdAt: at("2001-01-06T08:00:00") },
    { email: `${SECRET.toLowerCase()}@login.test`, userId: uA1, success: true, createdAt: at("2001-01-07T08:00:00") },
    { email: `${SECRET.toLowerCase()}@login.test`, userId: uA2, success: true, createdAt: at("2001-01-08T08:00:00") },
    { email: `${SECRET.toLowerCase()}@login.test`, userId: uA1, success: false, reason: "invalid_credentials", createdAt: at("2001-01-06T07:59:00") },
    { email: `${SECRET.toLowerCase()}@login.test`, userId: null, success: false, reason: "unknown_user", createdAt: at("2001-01-09T08:00:00") },
    { email: `${SECRET.toLowerCase()}@login.test`, userId: uP, success: true, createdAt: at("2000-12-12T08:00:00") },
  ]);

  const subMeta = (before: object | null, after: object) => ({ before, after, note: `${SECRET} audit metadata` });
  await db.insert(auditLogsTable).values([
    { companyId: aId, userName: `${SECRET} actor`, action: "subscription.create", entityType: "subscription", metadata: subMeta(null, { status: "trialing", plan: "starter" }), createdAt: at("2001-01-05T09:00:00") },
    // A data repair, not a business event: counted as an audit row, never as a lifecycle change.
    { companyId: aId, userName: "System", action: "subscription.repair_create", entityType: "subscription", metadata: subMeta(null, { status: "active", plan: "starter" }), createdAt: at("2001-01-06T09:00:00") },
    { companyId: aId, userName: "System", action: "subscription.activate", entityType: "subscription", metadata: subMeta({ status: "trialing", plan: "starter" }, { status: "active", plan: "starter" }), createdAt: at("2001-01-10T09:00:00") },
    { companyId: aId, userName: "System", action: "subscription.change_plan", entityType: "subscription", metadata: subMeta({ status: "active", plan: "starter" }, { status: "active", plan: "professional" }), createdAt: at("2001-01-12T09:00:00") },
    { companyId: bId, userName: "System", action: "subscription.cancel", entityType: "subscription", metadata: subMeta({ status: "active", plan: "business" }, { status: "cancelled", plan: "business" }), createdAt: at("2001-01-25T09:00:00") },
    // Same status and plan before and after: an audit row that is no transition at all.
    { companyId: aId, userName: "System", action: "subscription.update", entityType: "subscription", metadata: subMeta({ status: "active", plan: "professional" }, { status: "active", plan: "professional" }), createdAt: at("2001-01-26T09:00:00") },
    { companyId: aId, userName: `${SECRET} actor`, action: "user.create", entityType: "user", metadata: {}, createdAt: at("2001-01-07T09:00:00") },
    { companyId: aId, userName: `${SECRET} actor`, action: "user.create", entityType: "user", metadata: {}, createdAt: at("2001-01-07T10:00:00") },
    { companyId: null, userName: "Platform Owner", action: "plan_version.publish", entityType: "plan_version", metadata: {}, createdAt: at("2001-01-08T09:00:00") },
    { companyId: pId, userName: "System", action: "subscription.create", entityType: "subscription", metadata: subMeta(null, { status: "trialing", plan: "starter" }), createdAt: at("2000-12-10T08:00:00") },
  ]);

  await db.insert(securityEventsTable).values([
    { companyId: aId, type: "mfa_challenge", description: `${SECRET} security description`, createdAt: at("2001-01-09T09:00:00") },
    { companyId: aId, type: "mfa_challenge", description: `${SECRET} security description`, createdAt: at("2001-01-09T10:00:00") },
    { companyId: bId, type: "password_reset", description: `${SECRET} security description`, createdAt: at("2001-01-21T10:00:00") },
  ]);

  const subs = await db
    .insert(subscriptionsTable)
    .values([
      { companyId: aId, plan: planA, status: "active", billingSource: "manual" },
      { companyId: bId, plan: planB, status: "cancelled", billingSource: "manual" },
      { companyId: pId, plan: planA, status: "trialing", billingSource: "manual", trialExpiresAt: new Date(Date.now() + 3 * 86_400_000) },
    ])
    .returning({ id: subscriptionsTable.id });
  const [sA, sB, sP] = subs.map((s) => s.id);
  subA = sA;

  const evt = (n: number) => `evt_g7_${SUFFIX}_${n}`;
  await db.insert(billingProviderEventsTable).values([
    { eventId: evt(1), eventType: "invoice.paid", status: "processed", outcome: "applied", companyId: aId, subscriptionId: sA, receivedAt: at("2001-01-15T09:00:00") },
    { eventId: evt(2), eventType: "invoice.paid", status: "processed", outcome: "applied", companyId: aId, subscriptionId: sA, receivedAt: at("2001-01-16T09:00:00") },
    { eventId: evt(3), eventType: "invoice.payment_failed", status: "processed", outcome: "applied", companyId: aId, subscriptionId: sA, receivedAt: at("2001-01-17T09:00:00") },
    // A payment notification that matched no subscription is NOT an actual payment.
    { eventId: evt(4), eventType: "invoice.paid", status: "ignored", outcome: "unbound", companyId: null, receivedAt: at("2001-01-18T09:00:00") },
    { eventId: evt(5), eventType: "customer.subscription.updated", status: "failed", outcome: null, failureCode: "handler_error", companyId: aId, subscriptionId: sA, receivedAt: at("2001-01-19T09:00:00") },
    { eventId: evt(6), eventType: "invoice.paid", status: "processed", outcome: "applied", companyId: pId, subscriptionId: sP, receivedAt: at("2000-12-20T09:00:00") },
  ]);

  const idem = (n: number) => `idem_g7_${SUFFIX}_${n}`;
  await db.insert(billingCheckoutSessionsTable).values([
    { companyId: aId, subscriptionId: sA, planId: planA, idempotencyKey: idem(1), status: "completed", createdAt: at("2001-01-08T09:00:00") },
    { companyId: aId, subscriptionId: sA, planId: planA, idempotencyKey: idem(2), status: "expired", createdAt: at("2001-01-09T09:00:00") },
    { companyId: aId, subscriptionId: sA, planId: planA, idempotencyKey: idem(3), status: "open", createdAt: at("2001-01-28T09:00:00") },
    { companyId: bId, subscriptionId: sB, planId: planB, idempotencyKey: idem(4), status: "failed", createdAt: at("2001-01-23T09:00:00") },
    { companyId: pId, subscriptionId: sP, planId: planA, idempotencyKey: idem(5), status: "completed", createdAt: at("2000-12-18T09:00:00") },
  ]);

  const ai = { provider: "stub", model: "stub-model" };
  await db.insert(aiInvocationsTable).values([
    { ...ai, companyId: aId, feature: "card_extraction", status: "success", inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCostMicroUsd: 2000, latencyMs: 400, createdAt: at("2001-01-10T12:00:00") },
    { ...ai, companyId: aId, feature: "card_extraction", status: "success", inputTokens: 200, outputTokens: 60, totalTokens: 260, estimatedCostMicroUsd: 3000, latencyMs: 600, createdAt: at("2001-01-10T13:00:00") },
    { ...ai, companyId: aId, feature: "lead_scoring", status: "error", inputTokens: 50, outputTokens: 0, totalTokens: 50, estimatedCostMicroUsd: 500, latencyMs: 200, errorCategory: "provider_error", errorMessage: `${SECRET} provider message`, createdAt: at("2001-01-11T09:00:00") },
    { ...ai, companyId: aId, feature: "card_extraction", status: "cache_hit", inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostMicroUsd: 0, latencyMs: 0, createdAt: at("2001-01-11T09:05:00") },
    { ...ai, companyId: bId, feature: "contact_enrichment", status: "success", inputTokens: 10, outputTokens: 10, totalTokens: 20, estimatedCostMicroUsd: 1000, latencyMs: 100, createdAt: at("2001-01-22T08:10:00") },
    { ...ai, companyId: pId, feature: "card_extraction", status: "success", inputTokens: 40, outputTokens: 10, totalTokens: 50, estimatedCostMicroUsd: 700, latencyMs: 300, createdAt: at("2000-12-15T09:00:00") },
  ]);
});

afterAll(async () => {
  const synthetic = [pId, aId, bId].filter(Boolean);
  if (synthetic.length > 0) {
    await db.delete(aiInvocationsTable).where(inArray(aiInvocationsTable.companyId, synthetic));
    await db.delete(billingProviderEventsTable).where(sql`${billingProviderEventsTable.eventId} like ${`evt_g7_${SUFFIX}_%`}`);
    await db.delete(billingCheckoutSessionsTable).where(inArray(billingCheckoutSessionsTable.companyId, synthetic));
    await db.delete(securityEventsTable).where(inArray(securityEventsTable.companyId, synthetic));
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, synthetic));
    await db.delete(auditLogsTable).where(sql`${auditLogsTable.action} = 'plan_version.publish' and ${auditLogsTable.createdAt} = ${"2001-01-08 09:00:00"}`);
    await db.delete(loginAttemptsTable).where(eq(loginAttemptsTable.email, `${SECRET.toLowerCase()}@login.test`));
    await db.delete(leadsTable).where(inArray(leadsTable.companyId, synthetic));
    await db.delete(contactsTable).where(inArray(contactsTable.companyId, synthetic));
    await db.delete(scansTable).where(inArray(scansTable.companyId, synthetic));
    await db.delete(subscriptionsTable).where(inArray(subscriptionsTable.companyId, synthetic));
    await db.delete(usersTable).where(inArray(usersTable.companyId, synthetic));
    await db.delete(companiesTable).where(inArray(companiesTable.id, synthetic));
  }
  await db.delete(planPricesTable).where(eq(planPricesTable.providerPriceId, priceId));
  if (roleCompanyId) {
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.companyId, roleCompanyId));
    await db.delete(usersTable).where(eq(usersTable.companyId, roleCompanyId));
    await db.delete(companiesTable).where(eq(companiesTable.id, roleCompanyId));
  }
});

describe("access control — Platform Owner only", () => {
  for (const section of ENDPOINTS) {
    it(`/platform/analytics/${section}: 401 anonymous, 403 every tenant role, 200 platform owner`, async () => {
      const path = `/platform/analytics/${section}?${WINDOW}`;
      const anon = await fetch(`${BASE}${path}`);
      expect(anon.status).toBe(401);
      for (const [role, token] of [
        ["primary_admin", primaryToken],
        ["admin", adminToken],
        ["employee", employeeToken],
      ] as const) {
        const res = await api("GET", path, token);
        expect(res.status, `${role} on ${section}`).toBe(403);
        const body = await res.json();
        // A refusal carries no analytics payload at all.
        expect(body.range, `${role} on ${section}`).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain(`G7 Alpha ${SUFFIX}`);
      }
      const owner = await api("GET", path, platformToken);
      expect(owner.status).toBe(200);
    });
  }

  it("a forged token is refused", async () => {
    const res = await api("GET", `/platform/analytics/overview?${WINDOW}`, "not-a-token");
    expect(res.status).toBe(401);
  });

  it("is read-only: writes to the analytics paths do not exist", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await api(method, `/platform/analytics/overview?${WINDOW}`, platformToken, method === "DELETE" ? undefined : {});
      expect(res.status, method).toBe(404);
    }
  });

  it("does not open tenant CRM routes to the platform owner (firewall unchanged)", async () => {
    for (const path of ["/contacts", "/leads", "/scans"]) {
      const res = await api("GET", path, platformToken);
      expect(res.status, path).toBe(403);
    }
  });
});

describe("reporting window", () => {
  it("echoes the evaluated window and its equally long previous window", async () => {
    const body = await analytics("overview");
    expect(body.range).toEqual({ from: "2001-01-01", to: "2001-01-31", days: 31, granularity: "day", previousFrom: "2000-12-01", previousTo: "2000-12-31", timezone: "UTC" });
  });

  it("defaults to the last 30 UTC days ending today", async () => {
    const body = await analytics("overview", "");
    const today = new Date().toISOString().slice(0, 10);
    // A request that straddles UTC midnight may legitimately report the next day.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect([today, tomorrow]).toContain(body.range.to);
    expect(body.range.days).toBe(30);
    expect(body.range.granularity).toBe("day");
  });

  it("evaluates an ISO date-time as its UTC day", async () => {
    const body = await analytics("growth", "from=2001-01-01T23:30:00%2B05:00&to=2001-01-31T00:30:00-03:00");
    expect(body.range.from).toBe("2001-01-01");
    expect(body.range.to).toBe("2001-01-31");
  });

  it("picks day, week or month buckets from the length of the window", async () => {
    expect((await analytics("growth", "from=2001-01-01&to=2001-03-03")).range.granularity).toBe("day"); // 62 days
    expect((await analytics("growth", "from=2001-01-01&to=2001-03-04")).range.granularity).toBe("week"); // 63 days
    expect((await analytics("growth", "from=2001-01-01&to=2002-01-01")).range.granularity).toBe("week"); // 366 days
    expect((await analytics("growth", "from=2001-01-01&to=2002-01-02")).range.granularity).toBe("month"); // 367 days
  });

  it("accepts the longest window (731 days) and zero-fills every bucket", async () => {
    const body = await analytics("growth", "from=2001-01-01&to=2003-01-01");
    expect(body.range.days).toBe(731);
    expect(body.range.granularity).toBe("month");
    expect(body.companies.series).toHaveLength(25);
    expect(body.companies.series[0].bucket).toBe("2001-01-01");
    expect(body.companies.series[24].bucket).toBe("2003-01-01");
  });

  it("refuses invalid windows with 400 and a stable code, on every endpoint", async () => {
    const bad = [
      "from=2001-02-30&to=2001-03-01", // impossible calendar day
      "from=2001-02-01&to=2001-01-01", // from after to
      "from=2001-01-01&to=2003-01-02", // 732 days
      "from=2001-01-01&to=2001-01-31&granularity=hour",
      "from=2001-01-01&to=2002-01-02&granularity=day", // daily buckets beyond 366 days
      "from=yesterday&to=2001-01-31",
      "from=20010101&to=2001-01-31",
      "from=2001-01-01&from=2001-01-02&to=2001-01-31", // repeated parameter
      "from=2001-01-01&to=2001-01-31&granularity=day&granularity=week",
    ];
    for (const section of ENDPOINTS) {
      for (const query of section === "overview" ? bad : bad.slice(0, 3)) {
        const res = await api("GET", `/platform/analytics/${section}?${query}`, platformToken);
        expect(res.status, `${section}?${query}`).toBe(400);
        const body = await res.json();
        expect(body.code, `${section}?${query}`).toBe("INVALID_ANALYTICS_WINDOW");
        expect(body.range).toBeUndefined();
      }
    }
  });

  it("an empty window reports zeros, not errors", async () => {
    const q = "from=1999-06-01&to=1999-06-07";
    const overview = await analytics("overview", q);
    for (const key of ["newCompanies", "newUsers", "activeCompanies", "activeUsers", "scans", "contacts", "leads", "aiRequests"]) {
      expect(overview.period[key], key).toEqual({ current: 0, previous: 0 });
    }
    const activity = await analytics("activity", q);
    expect(activity.series).toHaveLength(7);
    expect(activity.series.every((p: any) => p.scans === 0 && p.contacts === 0 && p.leads === 0)).toBe(true);
    expect(activity.topCompanies).toEqual([]);
    expect(activity.scansByMethod).toEqual([]);
    const ai = await analytics("ai", q);
    expect(ai.totals.requests).toBe(0);
    expect(ai.totals.failureRate).toBe(0);
    expect(ai.byFeature).toEqual([]);
    const ops = await analytics("operations", q);
    expect(ops.signIns.successful).toEqual({ current: 0, previous: 0 });
    expect(ops.auditEvents.byCategory).toEqual([]);
  });
});

describe("overview", () => {
  it("reports the window and the previous window for every headline metric", async () => {
    const body = await analytics("overview");
    expect(body.period).toEqual({
      newCompanies: { current: 2, previous: 1 },
      newUsers: { current: 3, previous: 1 },
      activeCompanies: { current: 2, previous: 1 },
      activeUsers: { current: 2, previous: 1 },
      scans: { current: 6, previous: 1 },
      contacts: { current: 4, previous: 2 },
      leads: { current: 2, previous: 0 },
      aiRequests: { current: 4, previous: 1 },
    });
    expect(body.ai.costUsd.current).toBeCloseTo(0.0065, 6);
    expect(body.ai.costUsd.previous).toBeCloseTo(0.0007, 6);
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
  });

  it("all-time totals and the subscription state match the platform dashboard", async () => {
    const [body, statsRes] = await Promise.all([analytics("overview"), api("GET", "/platform/stats", platformToken)]);
    expect(statsRes.status).toBe(200);
    const stats = await statsRes.json();
    expect(body.totals).toEqual({ companies: stats.totalCompanies, users: stats.totalUsers });
    expect(body.revenue).toEqual(stats.revenue);
    expect(sorted(body.subscriptions.byStatus, "status")).toEqual(sorted(stats.subscriptions.byStatus, "status"));
    expect(body.subscriptions.trialsExpiringWithin7Days).toBe(stats.subscriptions.trialsExpiringWithin7Days);
    expect(body.subscriptions.total).toBe(sum(body.subscriptions.byStatus as Array<{ count: number }>, (s) => s.count));
  });
});

describe("growth", () => {
  it("counts companies and users by creation date, with a running total", async () => {
    const body = await analytics("growth");
    expect(body.companies.added).toEqual({ current: 2, previous: 1 });
    expect(body.companies.startingTotal).toBe(1);
    expect(body.companies.endingTotal).toBe(3);
    expect(body.users.added).toEqual({ current: 3, previous: 1 });
    expect(body.users.startingTotal).toBe(1);
    expect(body.users.endingTotal).toBe(4);

    const companies = body.companies.series as Array<{ bucket: string; added: number; cumulative: number }>;
    expect(companies).toHaveLength(31);
    expect(companies[0]).toEqual({ bucket: "2001-01-01", added: 0, cumulative: 1 });
    expect(companies.find((p) => p.bucket === "2001-01-05")).toEqual({ bucket: "2001-01-05", added: 1, cumulative: 2 });
    expect(companies.find((p) => p.bucket === "2001-01-19")).toEqual({ bucket: "2001-01-19", added: 0, cumulative: 2 });
    expect(companies.find((p) => p.bucket === "2001-01-20")).toEqual({ bucket: "2001-01-20", added: 1, cumulative: 3 });
    expect(companies[30]).toEqual({ bucket: "2001-01-31", added: 0, cumulative: 3 });
    expect(sum(companies, (p) => p.added)).toBe(2);

    const users = body.users.series as Array<{ bucket: string; added: number; cumulative: number }>;
    expect(sum(users, (p) => p.added)).toBe(3);
    expect(users[30].cumulative).toBe(4);
  });

  it("re-buckets by ISO week (Monday) and by month without losing a row", async () => {
    const week = await analytics("growth", `${WINDOW}&granularity=week`);
    expect(week.companies.series.map((p: any) => [p.bucket, p.added])).toEqual([
      ["2001-01-01", 1],
      ["2001-01-08", 0],
      ["2001-01-15", 1],
      ["2001-01-22", 0],
      ["2001-01-29", 0],
    ]);
    const month = await analytics("growth", `${WINDOW}&granularity=month`);
    expect(month.companies.series).toEqual([{ bucket: "2001-01-01", added: 2, cumulative: 3 }]);
    expect(month.users.series).toEqual([{ bucket: "2001-01-01", added: 3, cumulative: 4 }]);
  });
});

describe("subscriptions", () => {
  it("the snapshot equals the canonical subscription rows (as of now)", async () => {
    const body = await analytics("subscriptions");
    const [byStatus, byPlan, bySource, [{ total }]] = await Promise.all([
      db.select({ status: subscriptionsTable.status, c: count() }).from(subscriptionsTable).groupBy(subscriptionsTable.status),
      db.select({ plan: subscriptionsTable.plan, c: count() }).from(subscriptionsTable).groupBy(subscriptionsTable.plan),
      db.select({ source: subscriptionsTable.billingSource, c: count() }).from(subscriptionsTable).groupBy(subscriptionsTable.billingSource),
      db.select({ total: count() }).from(subscriptionsTable),
    ]);
    const { snapshot } = body;
    expect(snapshot.total).toBe(Number(total));
    const statusOf = (s: string) => Number(byStatus.find((r) => r.status === s)?.c ?? 0);
    for (const s of snapshot.byStatus as Array<{ status: string; count: number }>) expect(s.count, s.status).toBe(statusOf(s.status));
    expect(sum(snapshot.byStatus as Array<{ count: number }>, (s) => s.count)).toBe(Number(total));
    expect(snapshot.fullAccess).toBe(statusOf("active") + statusOf("trialing"));
    for (const p of snapshot.byPlan as Array<{ planId: string; total: number; byStatus: Array<{ count: number }> }>) {
      expect(p.total, p.planId).toBe(Number(byPlan.find((r) => r.plan === p.planId)?.c ?? -1));
      expect(sum(p.byStatus, (s) => s.count), p.planId).toBe(p.total);
    }
    expect(sum(snapshot.byPlan as Array<{ total: number }>, (p) => p.total)).toBe(Number(total));
    for (const s of snapshot.byBillingSource as Array<{ billingSource: string; count: number }>) {
      expect(s.count, s.billingSource).toBe(Number(bySource.find((r) => r.source === s.billingSource)?.c ?? -1));
    }
    // The synthetic trial that ends in three days is counted.
    expect(snapshot.trialsExpiringWithin7Days).toBeGreaterThanOrEqual(1);
    const planRow = (snapshot.byPlan as Array<{ planId: string; planName: string | null; planStatus: string | null }>).find((p) => p.planId === planA);
    expect(planRow?.planName).toBeTruthy();
  });

  it("derives lifecycle changes from the audit trail's before/after states", async () => {
    const { lifecycle } = await analytics("subscriptions");
    expect(lifecycle.source).toBe("audit_log");
    // repair_create and the no-op update are not transitions; cancel belongs to company Beta.
    expect(lifecycle.totals).toEqual({ created: 1, toTrialing: 1, toActive: 1, toPastDue: 0, toCancelled: 1, toExpired: 0, toSuspended: 0, planChanges: 1 });
    expect(lifecycle.previousTotals).toEqual({ created: 1, toTrialing: 1, toActive: 0, toPastDue: 0, toCancelled: 0, toExpired: 0, toSuspended: 0, planChanges: 0 });
    expect(lifecycle.planMoves).toEqual([{ fromPlan: "starter", toPlan: "professional", count: 1 }]);

    const series = lifecycle.series as Array<Record<string, number | string>>;
    expect(series).toHaveLength(31);
    const day = (b: string) => series.find((p) => p.bucket === b)!;
    expect(day("2001-01-05")).toMatchObject({ created: 1, toTrialing: 1, toActive: 0 });
    expect(day("2001-01-06")).toMatchObject({ created: 0, toActive: 0 }); // the repair row
    expect(day("2001-01-10")).toMatchObject({ toActive: 1, planChanges: 0 });
    expect(day("2001-01-12")).toMatchObject({ planChanges: 1, toActive: 0 });
    expect(day("2001-01-25")).toMatchObject({ toCancelled: 1 });
    expect(day("2001-01-26")).toMatchObject({ created: 0, toActive: 0, toCancelled: 0, planChanges: 0 });
    for (const key of Object.keys(lifecycle.totals)) {
      expect(sum(series, (p) => Number(p[key])), key).toBe(lifecycle.totals[key]);
    }
  });
});

describe("revenue and billing", () => {
  it("never reports collected revenue — amounts are not recorded", async () => {
    const body = await analytics("revenue");
    expect(body.collected).toEqual({ available: false, reason: "PAYMENT_AMOUNTS_NOT_RECORDED" });
    expect(body.estimate.basis).toBe("verified_provider_prices");
    // No money field exists outside the labelled estimate: everything else is a count.
    const { estimate, ...rest } = body;
    expect([...keysOf(rest)].filter((k) => /amount|minor|revenue|price|currency|mrr|arr$/i.test(k))).toEqual([]);
    expect(estimate.snapshot).toHaveProperty("available");
  });

  it("counts ACTUAL payment notifications only when processed for a known subscription", async () => {
    const body = await analytics("revenue");
    expect(body.paymentEvents.paid).toEqual({ current: 2, previous: 1 });
    expect(body.paymentEvents.failed).toEqual({ current: 1, previous: 0 });
    const series = body.paymentEvents.series as Array<{ bucket: string; paid: number; failed: number }>;
    expect(series).toHaveLength(31);
    expect(series.find((p) => p.bucket === "2001-01-15")).toEqual({ bucket: "2001-01-15", paid: 1, failed: 0 });
    expect(series.find((p) => p.bucket === "2001-01-17")).toEqual({ bucket: "2001-01-17", paid: 0, failed: 1 });
    // The unbound "invoice.paid" of Jan 18 is not a payment.
    expect(series.find((p) => p.bucket === "2001-01-18")).toEqual({ bucket: "2001-01-18", paid: 0, failed: 0 });
    expect(sum(series, (p) => p.paid)).toBe(2);
    expect(sum(series, (p) => p.failed)).toBe(1);

    expect(body.providerEvents.total).toEqual({ current: 5, previous: 1 });
    expect(body.providerEvents.failed).toBe(1);
    expect(sorted(body.providerEvents.byType, "eventType")).toEqual([
      { eventType: "customer.subscription.updated", count: 1 },
      { eventType: "invoice.paid", count: 3 },
      { eventType: "invoice.payment_failed", count: 1 },
    ]);
    expect(sorted(body.providerEvents.byOutcome, "outcome")).toEqual([
      { outcome: "applied", count: 3 },
      { outcome: "failed", count: 1 },
      { outcome: "unbound", count: 1 },
    ]);
  });

  it("reports checkouts started in the window by their current state", async () => {
    const body = await analytics("revenue");
    expect(body.checkouts).toEqual({ started: { current: 4, previous: 1 }, completed: 1, expired: 1, failed: 1, open: 1 });
  });

  it("the estimate is the dashboard's figure, split by plan, and moves only with verified prices", async () => {
    const before = await analytics("revenue");
    const stats = await (await api("GET", "/platform/stats", platformToken)).json();
    expect(before.estimate.snapshot).toEqual(stats.revenue);
    if (!before.estimate.snapshot.available) expect(before.estimate.byPlan).toEqual([]);
    // Precondition of the exact arithmetic below (holds on a clean test database).
    expect(before.estimate.snapshot.reason).not.toBe("MIXED_CURRENCIES");
    expect([null, "usd"]).toContain(before.estimate.snapshot.currency);

    // 1. A live provider subscription with NO verified price is excluded and counted as unpriced.
    await db
      .update(subscriptionsTable)
      .set({ billingSource: "stripe", stripeSubscriptionId: `sub_g7_${SUFFIX}`, stripeCustomerId: `cus_g7_${SUFFIX}`, stripePriceId: priceId, providerStatus: "active" })
      .where(eq(subscriptionsTable.id, subA));
    const unpriced = await analytics("revenue");
    expect(unpriced.estimate.snapshot.unpricedSubscriptions).toBe(before.estimate.snapshot.unpricedSubscriptions + 1);
    expect(unpriced.estimate.snapshot.countedSubscriptions).toBe(before.estimate.snapshot.countedSubscriptions);
    expect(unpriced.estimate.snapshot.monthlyRecurringMinor).toBe(before.estimate.snapshot.monthlyRecurringMinor);
    expect(unpriced.estimate.snapshot.available).toBe(before.estimate.snapshot.available);

    // 2. Registering the verified price adds exactly its monthly value: 60,000 per year = 5,000 per month.
    await db.insert(planPricesTable).values({ planId: planA, providerPriceId: priceId, interval: "year", intervalCount: 1, currency: "usd", unitAmountMinor: 60_000, verifiedAt: new Date() });
    const after = await analytics("revenue");
    const snap = after.estimate.snapshot;
    expect(snap.available).toBe(true);
    expect(snap.currency).toBe("usd");
    expect(snap.monthlyRecurringMinor).toBe((before.estimate.snapshot.monthlyRecurringMinor ?? 0) + 5_000);
    expect(snap.countedSubscriptions).toBe(before.estimate.snapshot.countedSubscriptions + 1);
    expect(snap.unpricedSubscriptions).toBe(before.estimate.snapshot.unpricedSubscriptions);
    const planBefore = (before.estimate.byPlan as Array<{ planId: string; subscriptions: number; monthlyRecurringMinor: number }>).find((p) => p.planId === planA);
    const planAfter = (after.estimate.byPlan as Array<{ planId: string; planName: string | null; subscriptions: number; monthlyRecurringMinor: number }>).find((p) => p.planId === planA);
    expect(planAfter?.subscriptions).toBe((planBefore?.subscriptions ?? 0) + 1);
    expect(planAfter?.monthlyRecurringMinor).toBe((planBefore?.monthlyRecurringMinor ?? 0) + 5_000);
    expect(planAfter?.planName).toBeTruthy();
    // The per-plan split adds up to the headline estimate (each plan is rounded to a whole minor unit).
    const split = sum(after.estimate.byPlan as Array<{ monthlyRecurringMinor: number }>, (p) => p.monthlyRecurringMinor);
    expect(Math.abs(split - snap.monthlyRecurringMinor)).toBeLessThanOrEqual(after.estimate.byPlan.length);
    expect(sum(after.estimate.byPlan as Array<{ subscriptions: number }>, (p) => p.subscriptions)).toBe(snap.countedSubscriptions);
    // Still the dashboard's own figure, and collected revenue is still not claimed.
    expect((await (await api("GET", "/platform/stats", platformToken)).json()).revenue).toEqual(snap);
    expect(after.collected.available).toBe(false);

    // 3. The estimate is "as of now": it does not depend on the reporting window.
    const otherWindow = await analytics("revenue", "from=1999-06-01&to=1999-06-07");
    expect(otherWindow.estimate).toEqual(after.estimate);
    expect(otherWindow.paymentEvents.paid).toEqual({ current: 0, previous: 0 });

    // 4. A subscription the provider no longer reports as live drops out again.
    await db.update(subscriptionsTable).set({ providerStatus: "canceled" }).where(eq(subscriptionsTable.id, subA));
    const dropped = await analytics("revenue");
    expect(dropped.estimate.snapshot.countedSubscriptions).toBe(before.estimate.snapshot.countedSubscriptions);
    expect(dropped.estimate.snapshot.monthlyRecurringMinor).toBe(before.estimate.snapshot.monthlyRecurringMinor);

    await db
      .update(subscriptionsTable)
      .set({ billingSource: "manual", stripeSubscriptionId: null, stripeCustomerId: null, stripePriceId: null, providerStatus: null })
      .where(eq(subscriptionsTable.id, subA));
    await db.delete(planPricesTable).where(eq(planPricesTable.providerPriceId, priceId));
  });

  it("splits subscriptions by billing method from the canonical rows", async () => {
    const body = await analytics("revenue");
    const rows = await db
      .select({ source: subscriptionsTable.billingSource, total: count(), full: sql<number>`count(*) filter (where ${subscriptionsTable.status} in ('active','trialing'))` })
      .from(subscriptionsTable)
      .groupBy(subscriptionsTable.billingSource);
    expect(body.billingSources).toHaveLength(rows.length);
    for (const s of body.billingSources as Array<{ billingSource: string; total: number; fullAccess: number }>) {
      const r = rows.find((x) => x.source === s.billingSource)!;
      expect(s.total, s.billingSource).toBe(Number(r.total));
      expect(s.fullAccess, s.billingSource).toBe(Number(r.full));
    }
  });
});

describe("activity", () => {
  it("counts real scans, live contacts and leads — both window edges inclusive", async () => {
    const body = await analytics("activity");
    expect(body.totals).toEqual({
      scans: { current: 6, previous: 1 },
      contacts: { current: 4, previous: 2 },
      leads: { current: 2, previous: 0 },
      activeCompanies: { current: 2, previous: 1 },
    });
    expect(body.manualEntries).toBe(1);
    expect(sorted(body.scansByMethod, "method")).toEqual([
      { method: "ai_vision", count: 3 },
      { method: "nfc", count: 1 },
      { method: "qr", count: 1 },
      { method: "unknown", count: 1 },
    ]);
    expect(sorted(body.scansByStatus, "status")).toEqual([
      { status: "completed", count: 4 },
      { status: "failed", count: 1 },
      { status: "pending", count: 1 },
    ]);

    const series = body.series as Array<{ bucket: string; scans: number; contacts: number; leads: number }>;
    expect(series).toHaveLength(31);
    expect(series[0]).toEqual({ bucket: "2001-01-01", scans: 1, contacts: 0, leads: 0 }); // first instant of the window
    expect(series.find((p) => p.bucket === "2001-01-10")).toEqual({ bucket: "2001-01-10", scans: 2, contacts: 2, leads: 0 });
    expect(series.find((p) => p.bucket === "2001-01-11")).toEqual({ bucket: "2001-01-11", scans: 0, contacts: 0, leads: 1 }); // the manual entry is not a scan
    expect(series.find((p) => p.bucket === "2001-01-12")).toEqual({ bucket: "2001-01-12", scans: 0, contacts: 0, leads: 0 }); // the deleted scan
    expect(series.find((p) => p.bucket === "2001-01-16")).toEqual({ bucket: "2001-01-16", scans: 0, contacts: 0, leads: 0 }); // the deleted contact
    expect(series[30]).toEqual({ bucket: "2001-01-31", scans: 1, contacts: 0, leads: 0 }); // last millisecond of the window
    expect(sum(series, (p) => p.scans)).toBe(6);
    expect(sum(series, (p) => p.contacts)).toBe(4);
    expect(sum(series, (p) => p.leads)).toBe(2);
  });

  it("re-buckets the same rows by week", async () => {
    const body = await analytics("activity", `${WINDOW}&granularity=week`);
    expect(body.series.map((p: any) => [p.bucket, p.scans, p.contacts, p.leads])).toEqual([
      ["2001-01-01", 1, 0, 0],
      ["2001-01-08", 2, 2, 1],
      ["2001-01-15", 0, 1, 1],
      ["2001-01-22", 2, 1, 0],
      ["2001-01-29", 1, 0, 0],
    ]);
  });

  it("a window that starts mid-week reports only the rows inside it", async () => {
    // Wed 10 Jan – Tue 16 Jan 2001: the week bucket of Jan 8 holds only Jan 10–14.
    const body = await analytics("activity", "from=2001-01-10&to=2001-01-16&granularity=week");
    expect(body.totals.scans.current).toBe(2);
    expect(body.series.map((p: any) => [p.bucket, p.scans, p.contacts])).toEqual([
      ["2001-01-08", 2, 2],
      ["2001-01-15", 0, 1],
    ]);
    // The preceding 7 days (Jan 3–9) hold no scan: the Jan 1 scan is outside them.
    expect(body.totals.scans.previous).toBe(0);
    expect(body.range.previousFrom).toBe("2001-01-03");
    expect(body.range.previousTo).toBe("2001-01-09");
  });

  it("ranks the most active companies with volumes only", async () => {
    const body = await analytics("activity");
    expect(body.topCompanies).toEqual([
      { companyId: aId, companyName: `G7 Alpha ${SUFFIX}`, scans: 4, contacts: 3, leads: 2 },
      { companyId: bId, companyName: `G7 Beta ${SUFFIX}`, scans: 2, contacts: 1, leads: 0 },
    ]);
  });
});

describe("AI usage", () => {
  it("aggregates the AI ledger: provider calls, failures, tokens and ESTIMATED cost", async () => {
    const body = await analytics("ai");
    expect(body.costBasis).toBe("estimated");
    expect(body.totals).toMatchObject({ requests: 4, success: 3, errors: 1, failureRate: 0.25, cacheHits: 1, dedupReused: 0, budgetDenied: 0, rateLimited: 0, inputTokens: 360, outputTokens: 120, totalTokens: 480 });
    expect(body.totals.costUsd).toBeCloseTo(0.0065, 6);
    expect(body.totals.avgLatencyMs).toBeCloseTo(325, 0);
    expect(body.previous).toMatchObject({ requests: 1, success: 1, errors: 0, totalTokens: 50 });
    expect(body.previous.costUsd).toBeCloseTo(0.0007, 6);

    expect(body.byFeature.map((f: any) => [f.feature, f.requests, f.cacheHits])).toEqual([
      ["card_extraction", 2, 1],
      ["contact_enrichment", 1, 0],
      ["lead_scoring", 1, 0],
    ]);
    expect(body.byFeature[2].failureRate).toBe(1);
    expect(body.topCompanies.map((c: any) => [c.companyId, c.companyName, c.requests])).toEqual([
      [aId, `G7 Alpha ${SUFFIX}`, 3],
      [bId, `G7 Beta ${SUFFIX}`, 1],
    ]);
    expect(body.topCompanies[0].costUsd).toBeCloseTo(0.0055, 6);
    expect(body.failureCategories).toEqual([{ category: "provider_error", count: 1 }]);

    const series = body.series as Array<{ bucket: string; requests: number; errors: number; costUsd: number; avgLatencyMs: number; cacheHits: number }>;
    expect(series).toHaveLength(31);
    const d10 = series.find((p) => p.bucket === "2001-01-10")!;
    expect(d10.requests).toBe(2);
    expect(d10.costUsd).toBeCloseTo(0.005, 6);
    expect(d10.avgLatencyMs).toBeCloseTo(500, 0);
    const d11 = series.find((p) => p.bucket === "2001-01-11")!;
    expect([d11.requests, d11.errors, d11.cacheHits]).toEqual([1, 1, 1]);
    expect(sum(series, (p) => p.requests)).toBe(4);
    expect(sum(series, (p) => p.costUsd)).toBeCloseTo(0.0065, 6);
  });

  it("weights latency by provider calls when days are folded into a week", async () => {
    const body = await analytics("ai", `${WINDOW}&granularity=week`);
    const week = (body.series as Array<{ bucket: string; requests: number; avgLatencyMs: number; costUsd: number }>).find((p) => p.bucket === "2001-01-08")!;
    expect(week.requests).toBe(3);
    expect(week.avgLatencyMs).toBe(400); // (400 + 600 + 200) / 3, not the mean of the two daily means
    expect(week.costUsd).toBeCloseTo(0.0055, 6);
    expect(body.series).toHaveLength(5);
  });
});

describe("operations", () => {
  it("reports sign-ins, the audit trail, security events and billing notifications", async () => {
    const body = await analytics("operations");
    expect(body.signIns.successful).toEqual({ current: 3, previous: 1 });
    expect(body.signIns.failed).toEqual({ current: 2, previous: 0 });
    expect(body.signIns.activeUsers).toEqual({ current: 2, previous: 1 });
    const signIns = body.signIns.series as Array<{ bucket: string; successful: number; failed: number }>;
    expect(signIns.find((p) => p.bucket === "2001-01-06")).toEqual({ bucket: "2001-01-06", successful: 1, failed: 1 });
    expect(signIns.find((p) => p.bucket === "2001-01-09")).toEqual({ bucket: "2001-01-09", successful: 0, failed: 1 });
    expect(sum(signIns, (p) => p.successful)).toBe(3);
    expect(sum(signIns, (p) => p.failed)).toBe(2);

    expect(body.auditEvents.total).toEqual({ current: 9, previous: 1 });
    expect(body.auditEvents.byCategory).toEqual([
      { category: "subscription", count: 6 },
      { category: "user", count: 2 },
      { category: "plan_version", count: 1 },
    ]);
    expect(sum(body.auditEvents.series as Array<{ value: number }>, (p) => p.value)).toBe(9);

    expect(body.securityEvents.total).toEqual({ current: 3, previous: 0 });
    expect(body.securityEvents.byType).toEqual([
      { type: "mfa_challenge", count: 2 },
      { type: "password_reset", count: 1 },
    ]);
    expect(body.billingEvents).toEqual({ received: { current: 5, previous: 1 }, failed: { current: 1, previous: 0 } });
  });

  it("reports the job queue as a snapshot, honest about the driver in use", async () => {
    const { jobs } = await analytics("operations");
    expect(typeof jobs.durable).toBe("boolean");
    for (const key of ["pending", "running", "dead"]) {
      expect(Number.isInteger(jobs[key]), key).toBe(true);
      expect(jobs[key], key).toBeGreaterThanOrEqual(0);
    }
    if (process.env.JOBS_DRIVER === "postgres") expect(jobs.durable).toBe(true);
    if (!jobs.durable) expect([jobs.pending, jobs.running, jobs.dead]).toEqual([0, 0, 0]);
  });
});

describe("Platform Owner firewall — aggregates only, never tenant records", () => {
  // Field names that would carry a tenant record or a personal detail.
  const FORBIDDEN_KEYS = new Set([
    "email", "fullName", "firstName", "lastName", "name", "mobile", "phone", "officePhone", "address", "notes", "title",
    "extractedData", "rawOcr", "imageUrl", "userName", "userId", "ipAddress", "userAgent", "metadata", "description",
    "errorMessage", "prompt", "response", "contactId", "leadId", "scanId", "entityId", "passwordHash",
  ]);
  it("no response carries record content or a personal-detail field", async () => {
    for (const section of ENDPOINTS) {
      for (const query of [WINDOW, `${WINDOW}&granularity=week`]) {
        const body = await analytics(section, query);
        const text = JSON.stringify(body);
        // Contact, lead, user and actor names, e-mails, notes, audit metadata, security
        // descriptions and AI error text of the synthetic tenants all carry this marker.
        expect(text.toUpperCase(), `${section}?${query}`).not.toContain(SECRET.toUpperCase());
        expect(text, section).not.toContain("203.0.113.7");
        expect(text, section).not.toContain("+10000000001");
        const leaked = [...keysOf(body)].filter((k) => FORBIDDEN_KEYS.has(k));
        expect(leaked, `${section}?${query}`).toEqual([]);
      }
    }
  });

  it("a company appears only as an id, a name and volumes", async () => {
    const activity = await analytics("activity");
    for (const row of activity.topCompanies) expect(Object.keys(row).sort()).toEqual(["companyId", "companyName", "contacts", "leads", "scans"]);
    const ai = await analytics("ai");
    const aggKeys = Object.keys(ai.totals).sort();
    for (const row of ai.topCompanies) expect(Object.keys(row).sort()).toEqual([...aggKeys, "companyId", "companyName"].sort());
  });

  it("every numeric figure is a finite, non-negative number", async () => {
    function check(value: unknown, path: string): void {
      if (typeof value === "number") {
        expect(Number.isFinite(value), path).toBe(true);
        expect(value, path).toBeGreaterThanOrEqual(0);
      } else if (Array.isArray(value)) value.forEach((v, i) => check(v, `${path}[${i}]`));
      else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) check(v, `${path}.${k}`);
    }
    for (const section of ENDPOINTS) check(await analytics(section), section);
  });
});
