import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, like, asc } from "drizzle-orm";
import { db, companiesTable, usersTable, contactsTable, eventsTable, auditLogsTable, plansTable, planPricesTable, subscriptionsTable } from "@workspace/db";

// Batch 39 — Plan Builder foundation (PB-1, READ-ONLY) against the LIVE API.
//
// Proves, for the platform-owner plan catalog / detail / effective-limit preview:
//   • shape and counts are derived from the existing entities and agree with the
//     subscription metrics the Subscriptions screen already shows;
//   • the platform firewall holds (tenant roles 403, unauthenticated 401) and a
//     tenant cannot preview its own or another tenant's limits through it;
//   • the preview is the SAME resolver + usage counter the product enforces with
//     (preview == tenant projection == platform detail; override precedence;
//     usage above a lowered limit is reported, never "repaired");
//   • none of the new endpoints writes anything (table snapshots before / after);
//   • entitlement compatibility: a change to a plan row a tenant is NOT on never
//     changes that tenant's effective limits, a tenant override shields the tenant
//     from any plan-default change, and a change to the tenant's OWN plan row flows
//     through ONLY while the tenant still carries the legacy NULL version reference
//     (pre-backfill); a tenant pinned to a published version (Batch 40) is immune.
// Batch 40 correction: the plan-row mutation below captures the EXACT original
// value and restores it (never a hard-coded NULL), and only ever runs against the
// isolated local database the suite is pointed at.
// No Gemini, no email, no object storage.

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b39plans-${SUFFIX}.test`;
const PLAN_IDS = ["free", "starter", "professional", "business", "enterprise"] as const;
const RESOURCES = ["contacts", "events", "admins", "employees", "scans", "storageMb"] as const;
const STATUSES = ["trialing", "active", "past_due", "cancelled", "expired", "suspended"] as const;

let platformToken = "";
let adminToken = ""; // company A primary_admin
let roleAdminToken = ""; // company A admin (non-primary)
let employeeToken = ""; // company A employee
let adminBToken = ""; // company B primary_admin (plan starter)
let companyA = 0;
let companyB = 0;
const companyIds: number[] = [];
// Batch 40 — the EXACT original value of the plan row the isolation test mutates
// (captured before any test runs; restored verbatim afterwards).
let starterEventsLimitOriginal: number | null | undefined;
let starterRowCaptured = false;

// The fixture mutation below must only ever touch an isolated disposable database.
function assertIsolatedDatabase() {
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  if (!["localhost", "127.0.0.1", "::1", "postgres", "db"].includes(host)) throw new Error("refusing to mutate plan rows: DATABASE_URL does not point at a local/isolated database");
}

function headers(token: string | null) {
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
async function login(email: string, password = PW): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: headers(null), body: JSON.stringify({ email, password }) });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}
async function api(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: headers(token), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed as Record<string, any>, text };
}
const setLimits = async (cid: number, limits: Record<string, number | null>) => {
  const res = await api("PUT", `/platform/subscriptions/${cid}/limits`, platformToken, { limits });
  expect(res.status, res.text).toBe(200);
  return res.body;
};
const preview = (planId: string, cid: number | string, token = platformToken) => api("GET", `/platform/plans/${planId}/effective-limits/${cid}`, token);
const limitsOf = (rows: Array<{ resource: string; limit: number | null; source: string }>) => Object.fromEntries(rows.map((l) => [l.resource, { limit: l.limit, source: l.source }]));

async function snapshot() {
  const [plans, prices, subs, audits] = await Promise.all([
    db.select().from(plansTable).orderBy(asc(plansTable.id)),
    db.select().from(planPricesTable).orderBy(asc(planPricesTable.id)),
    db.select().from(subscriptionsTable).orderBy(asc(subscriptionsTable.id)),
    db.select({ id: auditLogsTable.id }).from(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds)),
  ]);
  return JSON.stringify({ plans, prices, subs, audits: audits.length });
}

beforeAll(async () => {
  assertIsolatedDatabase();
  const [starterRow] = await db.select({ eventsLimit: plansTable.eventsLimit }).from(plansTable).where(eq(plansTable.id, "starter"));
  starterEventsLimitOriginal = starterRow?.eventsLimit;
  starterRowCaptured = starterRow !== undefined;
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  for (const [name, plan, setter] of [
    [`QA B39 Plans A ${SUFFIX}`, "free", (id: number) => (companyA = id)],
    [`QA B39 Plans B ${SUFFIX}`, "starter", (id: number) => (companyB = id)],
  ] as const) {
    const res = await api("POST", "/companies", platformToken, { name, plan });
    expect(res.status, res.text).toBe(201);
    setter(res.body.id);
    companyIds.push(res.body.id);
  }
  for (const [email, role, cid] of [
    [`admin@${DOMAIN}`, "primary_admin", companyA],
    [`roleadmin@${DOMAIN}`, "admin", companyA],
    [`employee@${DOMAIN}`, "employee", companyA],
    [`adminb@${DOMAIN}`, "primary_admin", companyB],
  ] as const) {
    const res = await api("POST", "/users", platformToken, { email, name: `B39 ${role}`, role, companyId: cid, password: PW });
    expect(res.status, res.text).toBe(201);
  }
  adminToken = await login(`admin@${DOMAIN}`);
  roleAdminToken = await login(`roleadmin@${DOMAIN}`);
  employeeToken = await login(`employee@${DOMAIN}`);
  adminBToken = await login(`adminb@${DOMAIN}`);
});

afterAll(async () => {
  // Defensive: the isolation test restores the plan row itself; make sure the
  // EXACT captured original is back even if that test aborted half-way.
  if (starterRowCaptured) await db.update(plansTable).set({ eventsLimit: starterEventsLimitOriginal ?? null }).where(eq(plansTable.id, "starter"));
  if (companyIds.length) {
    await db.delete(contactsTable).where(inArray(contactsTable.companyId, companyIds));
    await db.delete(eventsTable).where(inArray(eventsTable.companyId, companyIds));
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds));
    await db.delete(usersTable).where(inArray(usersTable.companyId, companyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds));
  }
  await db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`));
});

describe("plan catalog — read-only overview over the existing entities", () => {
  it("lists exactly the five fixed plans in catalog order with limits, prices, counts, trial policy and provider state", async () => {
    const res = await api("GET", "/platform/plans", platformToken);
    expect(res.status, res.text).toBe(200);
    const c = res.body;
    expect(c.readOnly).toBe(false); // Batch 40: plans change through drafts and immutable published versions
    expect(c.limitResources).toEqual([...RESOURCES]);
    expect(typeof c.generatedAt).toBe("string");
    // The five fixed ids are always present, in catalog order (builder-created plans may follow).
    const fixedInOrder = c.plans.map((p: any) => p.id).filter((id: string) => (PLAN_IDS as readonly string[]).includes(id));
    expect(fixedInOrder).toEqual([...PLAN_IDS]);
    const orders = c.plans.map((p: any) => p.sortOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    for (const p of c.plans.filter((x: any) => (PLAN_IDS as readonly string[]).includes(x.id))) {
      expect(p.seeded).toBe(true);
      expect(["not_versioned", "versioned"]).toContain(p.versioning);
      expect(["draft", "published", "archived"]).toContain(p.status);
      expect(typeof p.name).toBe("string");
      expect(typeof p.isActive).toBe("boolean");
      expect(typeof p.trialDays).toBe("number");
      expect(Object.keys(p.limits).sort()).toEqual([...RESOURCES].sort());
      for (const r of RESOURCES) expect(p.limits[r] === null || Number.isInteger(p.limits[r])).toBe(true);
      expect(p.features && typeof p.features === "object" && !Array.isArray(p.features)).toBe(true);
      expect(Array.isArray(p.prices)).toBe(true);
      expect(p.activePriceCount).toBe(p.prices.filter((x: any) => x.active).length);
      for (const pr of p.prices) {
        expect(pr.planId).toBe(p.id);
        // Masked provider refs only — never a raw provider identifier.
        expect(pr.providerPriceId).toBeUndefined();
        expect(Object.keys(pr)).not.toContain("stripePriceId");
      }
      expect(Object.keys(p.subscriptions.byStatus).sort()).toEqual([...STATUSES].sort());
      expect(Object.keys(p.subscriptions.byBillingSource).sort()).toEqual(["manual", "stripe"]);
      expect(p.subscriptions.total).toBe(Object.values(p.subscriptions.byStatus).reduce((a: number, b: any) => a + b, 0));
      expect(p.subscriptions.total).toBe(Object.values(p.subscriptions.byBillingSource).reduce((a: number, b: any) => a + b, 0));
      expect(p.subscriptions.withOverrides).toBeLessThanOrEqual(p.subscriptions.total);
      expect(typeof p.createdAt).toBe("string");
      expect(typeof p.updatedAt).toBe("string");
    }
    expect(c.trialPolicy).toMatchObject({ defaultTrialDays: 14, endOfTrialOutcome: "blocked", readOnlyGraceDays: 0, manualTrialExpirySweep: true });
    expect(typeof c.trialPolicy.configuredTrialDays).toBe("number");
    expect(typeof c.trialPolicy.rule).toBe("string");
    expect(c.provider).toMatchObject({ kind: expect.any(String), available: expect.any(Boolean) });
    expect("stripeMode" in c.provider).toBe(true);
  });

  it("subscription counts agree with /platform/subscriptions/metrics (same canonical rows, no second counter)", async () => {
    const [catalog, metrics] = await Promise.all([api("GET", "/platform/plans", platformToken), api("GET", "/platform/subscriptions/metrics", platformToken)]);
    expect(catalog.status).toBe(200);
    expect(metrics.status).toBe(200);
    const byPlan = Object.fromEntries(metrics.body.byPlan.map((r: any) => [r.plan, r.count]));
    for (const p of catalog.body.plans) expect(p.subscriptions.total, p.id).toBe(byPlan[p.id] ?? 0);
    const totalCatalog = catalog.body.plans.reduce((a: number, p: any) => a + p.subscriptions.total, 0);
    const totalMetrics = metrics.body.byPlan.reduce((a: number, r: any) => a + r.count, 0);
    expect(totalCatalog).toBe(totalMetrics);
    for (const s of STATUSES) {
      const fromCatalog = catalog.body.plans.reduce((a: number, p: any) => a + p.subscriptions.byStatus[s], 0);
      const fromMetrics = metrics.body.byStatus.find((r: any) => r.status === s)?.count ?? 0;
      expect(fromCatalog, s).toBe(fromMetrics);
    }
    for (const src of ["manual", "stripe"]) {
      const fromCatalog = catalog.body.plans.reduce((a: number, p: any) => a + p.subscriptions.byBillingSource[src], 0);
      const fromMetrics = metrics.body.byBillingSource.find((r: any) => r.billingSource === src)?.count ?? 0;
      expect(fromCatalog, src).toBe(fromMetrics);
    }
    // The two tenants created by this suite are counted on their plans.
    expect(byPlan.free).toBeGreaterThanOrEqual(1);
    expect(byPlan.starter).toBeGreaterThanOrEqual(1);
  });

  it("plan detail adds override counts; unknown or malformed plan ids are 404 without leaking anything", async () => {
    const res = await api("GET", "/platform/plans/free", platformToken);
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ id: "free", seeded: true });
    expect(["not_versioned", "versioned"]).toContain(res.body.versioning); // legacy row or backfilled v1
    expect(Object.keys(res.body.overrides.byResource).sort()).toEqual([...RESOURCES].sort());
    expect(res.body.overrides.tenantsWithAnyOverride).toBeLessThanOrEqual(res.body.subscriptions.total);
    for (const bad of ["platinum", "FREE", "free%20", "1"]) {
      const r = await api("GET", `/platform/plans/${bad}`, platformToken);
      expect(r.status, bad).toBe(404);
      if (r.body) expect(r.body.code).toBe("PLAN_NOT_FOUND");
    }
  });
});

describe("security — platform firewall and tenant isolation", () => {
  it("every tenant role is refused (403) and unauthenticated callers are refused (401)", async () => {
    const paths = ["/platform/plans", "/platform/plans/free", `/platform/plans/free/effective-limits/${companyA}`];
    for (const [who, token] of [
      ["primary_admin", adminToken],
      ["admin", roleAdminToken],
      ["employee", employeeToken],
    ] as const) {
      for (const p of paths) {
        const r = await api("GET", p, token);
        expect(r.status, `${who} ${p}`).toBe(403);
        expect(r.text).not.toContain("limits");
      }
    }
    for (const p of paths) {
      const r = await api("GET", p, null);
      expect(r.status, p).toBe(401);
    }
  });

  it("a tenant admin cannot preview another tenant's limits either (no cross-tenant read through the platform surface)", async () => {
    const r = await preview("free", companyB, adminToken);
    expect(r.status).toBe(403);
    const r2 = await preview("free", companyA, adminBToken);
    expect(r2.status).toBe(403);
  });

  it("validates the company path parameter and reports an unknown tenant as 404", async () => {
    for (const bad of ["abc", "0", "-1", "1.5", "1e3", "99999999999999"]) {
      const r = await preview("free", bad);
      expect(r.status, bad).toBe(400);
      expect(r.body.code).toBe("INVALID_COMPANY_ID");
    }
    const unknown = await preview("free", 2_000_000_000);
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("SUBSCRIPTION_NOT_FOUND");
    const unknownPlan = await preview("platinum", companyA);
    expect(unknownPlan.status).toBe(404);
    expect(unknownPlan.body.code).toBe("PLAN_NOT_FOUND");
  });
});

describe("effective-limit preview — the single resolver and the single usage counter", () => {
  it("under the tenant's current plan the preview equals the tenant projection and the platform subscription detail", async () => {
    await setLimits(companyA, { contacts: 3, scans: 5 });
    const [pv, current, detail, usage] = await Promise.all([
      preview("free", companyA),
      api("GET", "/subscriptions/current", adminToken),
      api("GET", `/platform/subscriptions/${companyA}`, platformToken),
      api("GET", "/subscriptions/usage", adminToken),
    ]);
    expect(pv.status, pv.text).toBe(200);
    expect(current.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(usage.status).toBe(200);
    expect(pv.body).toMatchObject({ companyId: companyA, currentPlan: "free", previewPlan: "free", isCurrentPlan: true, readOnly: true, billingSource: "manual" });
    expect(pv.body.companyName).toBe(`QA B39 Plans A ${SUFFIX}`);
    expect(pv.body.rows.map((r: any) => r.resource)).toEqual([...RESOURCES]);
    const fromPreview = limitsOf(pv.body.rows.map((r: any) => ({ resource: r.resource, limit: r.effective, source: r.source })));
    expect(fromPreview).toEqual(limitsOf(current.body.limits));
    expect(fromPreview).toEqual(limitsOf(detail.body.limits));
    expect(pv.body.changedResources).toEqual([]);
    for (const r of pv.body.rows) {
      expect(r.currentEffective).toBe(r.effective);
      expect(r.changes).toBe(false);
      const u = usage.body.resources.find((x: any) => x.resource === r.resource);
      expect(r.used, r.resource).toBe(u.used);
      expect(r.measurable, r.resource).toBe(u.measurable);
    }
    const contacts = pv.body.rows.find((r: any) => r.resource === "contacts");
    expect(contacts).toMatchObject({ override: 3, effective: 3, source: "override", exceeds: false });
    expect(contacts.remaining).toBe(3 - contacts.used);
    const scans = pv.body.rows.find((r: any) => r.resource === "scans");
    expect(scans).toMatchObject({ override: 5, effective: 5, source: "override" });
    const events = pv.body.rows.find((r: any) => r.resource === "events");
    expect(events.override).toBeNull();
    // Access mode and status come from the same entitlement resolver as the tenant projection.
    expect(pv.body.status).toBe(current.body.status);
    expect(pv.body.accessMode).toBe(current.body.accessMode);
  });

  it("tenant overrides take precedence under EVERY previewed plan (overrides are the grandfathering mechanism that exists today)", async () => {
    for (const planId of PLAN_IDS) {
      const pv = await preview(planId, companyA);
      expect(pv.status, `${planId}: ${pv.text}`).toBe(200);
      expect(pv.body.isCurrentPlan).toBe(planId === "free");
      const contacts = pv.body.rows.find((r: any) => r.resource === "contacts");
      expect(contacts, planId).toMatchObject({ override: 3, effective: 3, source: "override", changes: false });
      const scans = pv.body.rows.find((r: any) => r.resource === "scans");
      expect(scans, planId).toMatchObject({ override: 5, effective: 5, source: "override", changes: false });
      // Resources without an override resolve to the previewed plan's default (or unlimited).
      const plan = (await api("GET", `/platform/plans/${planId}`, platformToken)).body;
      for (const r of pv.body.rows.filter((x: any) => x.override == null)) {
        expect(r.planDefault, `${planId}/${r.resource}`).toBe(plan.limits[r.resource]);
        expect(r.effective, `${planId}/${r.resource}`).toBe(plan.limits[r.resource]);
        expect(r.source).toBe(plan.limits[r.resource] == null ? "unlimited" : "plan");
      }
    }
  });

  it("usage above a lowered limit is reported (exceeds / blockingResources) and never repaired by the preview", async () => {
    await setLimits(companyA, { contacts: null, scans: 5 });
    for (let i = 0; i < 4; i++) {
      const r = await api("POST", "/contacts", adminToken, { firstName: "Plan", lastName: `Preview${i}`, email: `preview${i}-${SUFFIX}@${DOMAIN}` });
      expect(r.status, r.text).toBe(201);
    }
    await setLimits(companyA, { contacts: 3, scans: 5 }); // lowering below usage is allowed: data is never deleted
    const pv = await preview("free", companyA);
    expect(pv.status, pv.text).toBe(200);
    const contacts = pv.body.rows.find((r: any) => r.resource === "contacts");
    expect(contacts).toMatchObject({ override: 3, effective: 3, used: 4, remaining: 0, exceeds: true, measurable: true });
    expect(pv.body.blockingResources).toEqual(["contacts"]);
    const count = await db.select({ id: contactsTable.id }).from(contactsTable).where(eq(contactsTable.companyId, companyA));
    expect(count.length).toBe(4);
    // And the enforcement path agrees: one more contact is refused with the stable 409.
    const refused = await api("POST", "/contacts", adminToken, { firstName: "Plan", lastName: "Refused", email: `refused-${SUFFIX}@${DOMAIN}` });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("LIMIT_EXCEEDED");
  });
});

describe("no-write guarantee and entitlement compatibility", () => {
  it("catalog, detail and preview never write: plans, prices, subscriptions and the tenants' audit trail are byte-identical before and after", async () => {
    const before = await snapshot();
    const calls = [
      api("GET", "/platform/plans", platformToken),
      ...PLAN_IDS.map((id) => api("GET", `/platform/plans/${id}`, platformToken)),
      ...PLAN_IDS.map((id) => preview(id, companyA)),
      ...PLAN_IDS.map((id) => preview(id, companyB)),
      preview("platinum", companyA),
      preview("free", 2_000_000_000),
      preview("free", "abc"),
    ];
    const results = await Promise.all(calls);
    expect(results.slice(0, 1 + PLAN_IDS.length * 3).every((r) => r.status === 200)).toBe(true);
    const after = await snapshot();
    expect(after).toBe(before);
  });

  it("a published plan is never edited in place: there is no PUT / PATCH / DELETE on a plan id, and the Batch 40 mutation routes validate and refuse before touching a fixed plan row", async () => {
    for (const [method, path] of [
      ["PUT", "/platform/plans/free"],
      ["PATCH", "/platform/plans/free"],
      ["DELETE", "/platform/plans/free"],
      ["POST", `/platform/plans/free/effective-limits/${companyA}`],
    ] as const) {
      const r = await api(method, path, platformToken, { name: "x", limits: { contacts: 1 } });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    // POST /platform/plans exists since Batch 40 but validates its body and reserves the fixed ids.
    expect((await api("POST", "/platform/plans", platformToken, { name: "x", limits: { contacts: 1 } })).status).toBe(400);
    const reserved = await api("POST", "/platform/plans", platformToken, { id: "free", name: "x" });
    expect(reserved.status).toBe(409);
    expect(reserved.body.code).toBe("PLAN_ID_RESERVED");
    const plan = await db.select().from(plansTable).where(eq(plansTable.id, "free"));
    expect(plan[0].name).not.toBe("x");
  });

  it("resolver input isolation: a change to a plan row a tenant is NOT on never changes that tenant; an override shields a tenant on the changed plan; the tenant's own plan row flows through only for a legacy (unpinned) reference, never for a tenant pinned to a published version", async () => {
    assertIsolatedDatabase();
    // Company A is on `free` with overrides {contacts: 3, scans: 5}; company B is on `starter` with no override.
    const baselineA = (await api("GET", "/subscriptions/current", adminToken)).body;
    const baselineB = (await api("GET", "/subscriptions/current", adminBToken)).body;
    const starterBefore = (await api("GET", "/platform/plans/starter", platformToken)).body;
    const baselineStarterEvents = starterBefore.limits.events as number | null;
    expect(limitsOf(baselineB.limits).events).toEqual(baselineStarterEvents == null ? { limit: null, source: "unlimited" } : { limit: baselineStarterEvents, source: "plan" });
    const previewAUnderStarterBefore = (await preview("starter", companyA)).body;
    expect(previewAUnderStarterBefore.changedResources).toEqual(baselineStarterEvents == null ? [] : ["events"]);
    // Batch 40: is B pinned to a published version (post-backfill) or a legacy NULL reference (pre-backfill)?
    const bDetail = (await api("GET", `/platform/subscriptions/${companyB}`, platformToken)).body;
    const bPinned = bDetail.planVersionId != null;
    const [{ eventsLimit: exactOriginal }] = await db.select({ eventsLimit: plansTable.eventsLimit }).from(plansTable).where(eq(plansTable.id, "starter"));
    expect(exactOriginal).toBe(starterEventsLimitOriginal ?? null);
    try {
      // Simulate an in-place edit of the published `starter` plan directly in the ISOLATED local DB
      // (there is deliberately no API for this — the point of the test is what such an edit would do).
      await db.update(plansTable).set({ eventsLimit: 7 }).where(eq(plansTable.id, "starter"));

      // (1) Company A (plan free) — effective limits unchanged in every surface.
      const afterA = (await api("GET", "/subscriptions/current", adminToken)).body;
      expect(limitsOf(afterA.limits)).toEqual(limitsOf(baselineA.limits));
      const previewAFree = (await preview("free", companyA)).body;
      expect(previewAFree.changedResources).toEqual([]);
      expect(limitsOf(previewAFree.rows.map((r: any) => ({ resource: r.resource, limit: r.effective, source: r.source })))).toEqual(limitsOf(baselineA.limits));

      // (2) The preview makes the consequence of moving A onto the edited plan visible BEFORE anything changes.
      const previewAStarter = (await preview("starter", companyA)).body;
      expect(previewAStarter.changedResources).toEqual(["events"]);
      expect(previewAStarter.rows.find((r: any) => r.resource === "events")).toMatchObject({ planDefault: 7, override: null, effective: 7, source: "plan", currentEffective: null, changes: true });
      // A's overrides still win on the edited plan too.
      expect(previewAStarter.rows.find((r: any) => r.resource === "contacts")).toMatchObject({ effective: 3, source: "override", changes: false });

      // (3) Company B (plan starter, no override):
      //     • legacy NULL reference (pre-backfill): the in-place row edit flows through immediately —
      //       the documented hazard that the versioned Plan Builder removes;
      //     • pinned to a published version (post-backfill): the row edit changes NOTHING for B — the
      //       resolver reads B's immutable version snapshot (PB-1.3 / Batch 40).
      const afterB = (await api("GET", "/subscriptions/current", adminBToken)).body;
      if (bPinned) {
        expect(limitsOf(afterB.limits)).toEqual(limitsOf(baselineB.limits));
        const previewB = (await preview("starter", companyB)).body;
        expect(previewB.isCurrentPlan).toBe(true);
        // The plan-row preview differs from B's pinned entitlement — visible, never applied.
        expect(previewB.rows.find((r: any) => r.resource === "events")).toMatchObject({ planDefault: 7, effective: 7, currentEffective: limitsOf(baselineB.limits).events.limit, changes: limitsOf(baselineB.limits).events.limit !== 7 });
      } else {
        expect(limitsOf(afterB.limits).events).toEqual({ limit: 7, source: "plan" });
        const previewB = (await preview("starter", companyB)).body;
        expect(previewB.isCurrentPlan).toBe(true);
        expect(previewB.rows.find((r: any) => r.resource === "events")).toMatchObject({ effective: 7, source: "plan", currentEffective: 7, changes: false });
      }

      // (4) An override shields a tenant on the edited plan from the plan-default change.
      await setLimits(companyB, { events: 20 });
      const shieldedB = (await api("GET", "/subscriptions/current", adminBToken)).body;
      expect(limitsOf(shieldedB.limits).events).toEqual({ limit: 20, source: "override" });
      await db.update(plansTable).set({ eventsLimit: 2 }).where(eq(plansTable.id, "starter"));
      const stillShieldedB = (await api("GET", "/subscriptions/current", adminBToken)).body;
      expect(limitsOf(stillShieldedB.limits).events).toEqual({ limit: 20, source: "override" });
      const catalog = (await api("GET", "/platform/plans/starter", platformToken)).body;
      expect(catalog.limits.events).toBe(2);
      expect(catalog.overrides.byResource.events).toBeGreaterThanOrEqual(1);
    } finally {
      // Restore the EXACT captured original (not a hard-coded default).
      await db.update(plansTable).set({ eventsLimit: exactOriginal }).where(eq(plansTable.id, "starter"));
      await setLimits(companyB, { events: null });
    }
    // Restored: both tenants back to their baseline effective limits and the row back to its original value.
    const restoredA = (await api("GET", "/subscriptions/current", adminToken)).body;
    expect(limitsOf(restoredA.limits)).toEqual(limitsOf(baselineA.limits));
    const restoredB = (await api("GET", "/subscriptions/current", adminBToken)).body;
    expect(limitsOf(restoredB.limits)).toEqual(limitsOf(baselineB.limits));
    const starter = (await api("GET", "/platform/plans/starter", platformToken)).body;
    expect(starter.limits.events).toBe(exactOriginal);
    const [{ eventsLimit: rowAfter }] = await db.select({ eventsLimit: plansTable.eventsLimit }).from(plansTable).where(eq(plansTable.id, "starter"));
    expect(rowAfter).toBe(exactOriginal);
  });
});
