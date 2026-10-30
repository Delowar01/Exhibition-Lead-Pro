import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { db, companiesTable, usersTable, contactsTable, eventsTable, auditLogsTable, plansTable, planVersionsTable, subscriptionsTable } from "@workspace/db";
import { runVersionBackfill } from "../src/lib/billing/version-backfill.js";

// Batch 40 — PB-2 versioned Plan Builder against the LIVE API.
//
// Proves: platform-owner authorization on EVERY new route; draft creation /
// editing / validation; atomic + concurrency-safe publication; published-version
// immutability; tenant pinning on assignment; grandfathering (a new publication
// never moves an existing subscriber); retirement that keeps subscribers and
// refuses the last published version; delete protection; duplicate / archive;
// effective-limit parity between the version preview and the tenant projection;
// audit history for every action; no-write guarantee of the read endpoints.
// Runs in the isolated local stack only (fixed plans get version 1 through the
// same backfill the operator would run).

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b40plans-${SUFFIX}.test`;
const SLUG = `b40-growth-${SUFFIX}`;
const DUP = `b40-copy-${SUFFIX}`;
const RESOURCES = ["contacts", "events", "admins", "employees", "scans", "storageMb"] as const;
const FEATURE_KEYS = ["ai.assistant", "ai.command_center", "workflow.intelligence", "executive.intelligence", "exports.scheduled", "nfc.capture", "documents", "api.access"];

let platformToken = "";
let adminToken = ""; // company A primary_admin
let roleAdminToken = ""; // company A admin
let employeeToken = ""; // company A employee
let companyA = 0;
let companyB = 0;
const companyIds: number[] = [];
let v1 = 0;
let v2 = 0;
let v3 = 0;

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
const detail = async (cid: number) => (await api("GET", `/platform/subscriptions/${cid}`, platformToken)).body;
const current = async (token: string) => (await api("GET", "/subscriptions/current", token)).body;
const limitsOf = (rows: Array<{ resource: string; limit: number | null; source: string }>) => Object.fromEntries(rows.map((l) => [l.resource, { limit: l.limit, source: l.source }]));
const planAudit = async (planId: string) =>
  db
    .select({ action: auditLogsTable.action, entityType: auditLogsTable.entityType, entityId: auditLogsTable.entityId, metadata: auditLogsTable.metadata })
    .from(auditLogsTable)
    .where(like(auditLogsTable.action, "plan%"))
    .then((rows) => rows.filter((r) => (r.metadata as any)?.planId === planId));
async function createCompany(name: string, plan: string) {
  const res = await api("POST", "/companies", platformToken, { name, plan });
  expect(res.status, res.text).toBe(201);
  companyIds.push(res.body.id);
  return res.body.id as number;
}

beforeAll(async () => {
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  companyA = await createCompany(`QA B40 Versions A ${SUFFIX}`, "free");
  companyB = await createCompany(`QA B40 Versions B ${SUFFIX}`, "starter");
  for (const [email, role, cid] of [
    [`admin@${DOMAIN}`, "primary_admin", companyA],
    [`roleadmin@${DOMAIN}`, "admin", companyA],
    [`employee@${DOMAIN}`, "employee", companyA],
  ] as const) {
    const res = await api("POST", "/users", platformToken, { email, name: email.split("@")[0], role, companyId: cid, password: PW });
    expect(res.status, res.text).toBe(201);
  }
  adminToken = await login(`admin@${DOMAIN}`);
  roleAdminToken = await login(`roleadmin@${DOMAIN}`);
  employeeToken = await login(`employee@${DOMAIN}`);
  // The fixed catalog becomes version 1 exactly the way the operator procedure does it.
  // Another test file may already have run that procedure (the suite order is not
  // fixed), in which case A and B were pinned at creation; they must start as the
  // legacy NULL references this file reasons about, so the pin proofs below are
  // order-independent.
  await db.update(subscriptionsTable).set({ planVersionId: null }).where(inArray(subscriptionsTable.companyId, [companyA, companyB]));
  const report = await runVersionBackfill({ apply: true });
  expect(report.applied, JSON.stringify(report.verification.mismatches)).toBe(true);
  expect(report.verification.mismatches).toEqual([]);
});

afterAll(async () => {
  if (companyIds.length) {
    await db.delete(contactsTable).where(inArray(contactsTable.companyId, companyIds));
    await db.delete(eventsTable).where(inArray(eventsTable.companyId, companyIds));
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds));
    await db.delete(usersTable).where(inArray(usersTable.companyId, companyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds));
  }
  await db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`));
  await db.delete(planVersionsTable).where(inArray(planVersionsTable.planId, [SLUG, DUP]));
  await db.delete(plansTable).where(inArray(plansTable.id, [SLUG, DUP]));
});

describe("fixed catalog after the version-1 backfill", () => {
  it("every fixed plan carries version 1 built from its row and every tenant is pinned; nothing moved", async () => {
    const catalog = (await api("GET", "/platform/plans", platformToken)).body;
    expect(catalog.readOnly).toBe(false);
    expect(catalog.featureCatalog).toEqual(FEATURE_KEYS);
    for (const id of ["free", "starter", "professional", "business", "enterprise"]) {
      const p = catalog.plans.find((x: any) => x.id === id);
      expect(p, id).toBeTruthy();
      expect(p.status).toBe("published");
      expect(p.versioning).toBe("versioned");
      expect(p.currentVersion.version).toBe(1);
      expect(p.unpinnedSubscriptions).toBe(0);
      const v = (await api("GET", `/platform/plans/${id}/versions/${p.currentVersion.id}`, platformToken)).body;
      expect(v.state).toBe("published");
      expect(v.snapshot.limits).toEqual(p.limits);
      expect(Object.keys(v.snapshot.features)).toEqual(FEATURE_KEYS);
    }
    const a = await detail(companyA);
    expect(a.plan).toBe("free");
    expect(a.planVersion).toBe(1);
    expect(typeof a.planVersionId).toBe("number");
    const b = await detail(companyB);
    expect(b.plan).toBe("starter");
    expect(b.planVersion).toBe(1);
  });
});

describe("platform firewall on every Plan Builder route", () => {
  it("tenant roles are refused (403) and anonymous callers are refused (401); nothing is written", async () => {
    const freeV1 = (await api("GET", "/platform/plans/free/versions", platformToken)).body.currentVersionId as number;
    const before = JSON.stringify(await db.select().from(planVersionsTable).orderBy(asc(planVersionsTable.id)));
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/platform/plans", { id: `b40-x-${SUFFIX}`, name: "x" }],
      ["POST", "/platform/plans/free/duplicate", { id: `b40-y-${SUFFIX}` }],
      ["POST", "/platform/plans/free/archive"],
      ["GET", "/platform/plans/free/versions"],
      ["POST", "/platform/plans/free/versions", {}],
      ["GET", `/platform/plans/free/versions/${freeV1}`],
      ["PATCH", `/platform/plans/free/versions/${freeV1}`, { name: "x" }],
      ["DELETE", `/platform/plans/free/versions/${freeV1}`],
      ["POST", `/platform/plans/free/versions/${freeV1}/validate`],
      ["POST", `/platform/plans/free/versions/${freeV1}/publish`],
      ["POST", `/platform/plans/free/versions/${freeV1}/retire`],
      ["GET", `/platform/plans/free/versions/${freeV1}/impact`],
      ["GET", `/platform/plans/free/versions/${freeV1}/compare/${freeV1}`],
      ["GET", `/platform/plans/free/versions/${freeV1}/effective-limits/${companyA}`],
    ];
    for (const [method, path, body] of routes) {
      for (const [label, token] of [["primary_admin", adminToken], ["admin", roleAdminToken], ["employee", employeeToken]] as const) {
        const r = await api(method, path, token, body);
        expect(r.status, `${label} ${method} ${path}`).toBe(403);
      }
      const anon = await api(method, path, null, body);
      expect(anon.status, `anon ${method} ${path}`).toBe(401);
    }
    expect(JSON.stringify(await db.select().from(planVersionsTable).orderBy(asc(planVersionsTable.id)))).toBe(before);
    expect((await db.select().from(plansTable).where(like(plansTable.id, `b40-%-${SUFFIX}`))).length).toBe(0);
  });
});

describe("PB-2.1 create a draft plan", () => {
  it("validates the slug, reserves the fixed ids, creates a DRAFT that tenants cannot see or be assigned to, and audits it", async () => {
    expect((await api("POST", "/platform/plans", platformToken, { id: "Bad Slug", name: "x" })).status).toBe(400);
    const reserved = await api("POST", "/platform/plans", platformToken, { id: "free", name: "x" });
    expect(reserved.status).toBe(409);
    expect(reserved.body.code).toBe("PLAN_ID_RESERVED");
    expect((await api("POST", "/platform/plans", platformToken, { id: SLUG })).status).toBe(400);

    const created = await api("POST", "/platform/plans", platformToken, {
      id: SLUG,
      name: "Growth",
      description: "Growth plan (test)",
      limits: { contacts: 1000, admins: 3 },
      features: { "ai.assistant": true },
      trialPolicy: { trialDays: 7 },
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body.plan).toMatchObject({ id: SLUG, status: "draft", isActive: false, versioning: "not_versioned", seeded: false });
    expect(created.body.plan.draft.version).toBe(1);
    expect(created.body.draft).toMatchObject({ planId: SLUG, version: 1, state: "draft", isCurrent: false, subscribers: 0, publishedAt: null });
    expect(created.body.draft.snapshot.limits).toEqual({ contacts: 1000, events: null, admins: 3, employees: null, scans: null, storageMb: null });
    expect(Object.keys(created.body.draft.snapshot.features)).toEqual(FEATURE_KEYS);
    expect(created.body.draft.snapshot.features["ai.assistant"]).toBe(true);
    expect(created.body.draft.trialPolicy).toEqual({ trialDays: 7, eligible: true, oncePerCompany: true, endOutcome: "blocked", readOnlyGraceDays: 0 });
    v1 = created.body.draft.id;

    const again = await api("POST", "/platform/plans", platformToken, { id: SLUG, name: "Growth" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("PLAN_EXISTS");

    // Not visible to tenants, not assignable.
    const tenantPlans = (await api("GET", "/subscriptions/plans", adminToken)).body as Array<{ id: string }>;
    expect(tenantPlans.map((p) => p.id)).not.toContain(SLUG);
    const assign = await api("POST", `/platform/subscriptions/${companyA}/plan`, platformToken, { plan: SLUG });
    expect(assign.status).toBe(400);
    expect(assign.body.code).toBe("INVALID_PLAN");
    expect((await api("POST", "/companies", platformToken, { name: `QA B40 draft-assign ${SUFFIX}`, plan: SLUG })).status).toBe(400);
    expect((await detail(companyA)).plan).toBe("free");

    const audit = await planAudit(SLUG);
    expect(audit.map((a) => a.action)).toContain("plan.create");
  });
});

describe("PB-2.2 / PB-2.4 edit a draft, validate and publish an immutable version", () => {
  it("edits merge field by field, invalid input is refused with issues, validation gates publication, published versions are immutable", async () => {
    const edited = await api("PATCH", `/platform/plans/${SLUG}/versions/${v1}`, platformToken, {
      limits: { events: 5 },
      features: { "nfc.capture": true },
      trialPolicy: { endOutcome: "read_only", readOnlyGraceDays: 0 },
    });
    expect(edited.status, edited.text).toBe(200);
    expect(edited.body.snapshot.limits).toMatchObject({ contacts: 1000, events: 5, admins: 3 });
    expect(edited.body.snapshot.features["nfc.capture"]).toBe(true);
    expect(edited.body.trialPolicy).toMatchObject({ endOutcome: "read_only", readOnlyGraceDays: 0 });

    expect((await api("PATCH", `/platform/plans/${SLUG}/versions/${v1}`, platformToken, { limits: { contacts: -5 } })).status).toBe(400);
    const tooBig = await api("PATCH", `/platform/plans/${SLUG}/versions/${v1}`, platformToken, { limits: { contacts: 1e12 } });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.code).toBe("VERSION_INPUT_INVALID");
    expect(tooBig.body.context.issues.map((i: any) => i.code)).toEqual(["LIMIT_INVALID"]);
    const unknownFeature = await api("PATCH", `/platform/plans/${SLUG}/versions/${v1}`, platformToken, { features: { beta: true } });
    expect(unknownFeature.status).toBe(400);
    expect(unknownFeature.body.context.issues.map((i: any) => i.code)).toEqual(["FEATURE_UNKNOWN"]);

    const invalid = (await api("POST", `/platform/plans/${SLUG}/versions/${v1}/validate`, platformToken)).body;
    expect(invalid.ok).toBe(false);
    expect(invalid.publishable).toBe(false);
    expect(invalid.errors.map((e: any) => e.code)).toContain("TRIAL_GRACE_REQUIRED");
    const refused = await api("POST", `/platform/plans/${SLUG}/versions/${v1}/publish`, platformToken);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("VERSION_INVALID");
    expect(refused.body.context.errors.map((e: any) => e.code)).toContain("TRIAL_GRACE_REQUIRED");

    expect((await api("PATCH", `/platform/plans/${SLUG}/versions/${v1}`, platformToken, { trialPolicy: { endOutcome: "blocked", readOnlyGraceDays: 0 } })).status).toBe(200);
    const valid = (await api("POST", `/platform/plans/${SLUG}/versions/${v1}/validate`, platformToken)).body;
    expect(valid).toMatchObject({ ok: true, publishable: true, blockers: [] });
    expect(valid.warnings.map((w: any) => w.code)).toContain("NO_PROVIDER_PRICE");
    const versionDetail = (await api("GET", `/platform/plans/${SLUG}/versions/${v1}`, platformToken)).body;
    expect(versionDetail.validation.publishable).toBe(true);

    const published = await api("POST", `/platform/plans/${SLUG}/versions/${v1}/publish`, platformToken);
    expect(published.status, published.text).toBe(200);
    expect(published.body).toMatchObject({ id: v1, version: 1, state: "published", isCurrent: true });
    expect(typeof published.body.publishedAt).toBe("string");
    const plan = (await api("GET", `/platform/plans/${SLUG}`, platformToken)).body;
    expect(plan).toMatchObject({ status: "published", isActive: true, versioning: "versioned" });
    expect(plan.currentVersion.version).toBe(1);
    expect(plan.draft).toBeNull();
    expect(plan.limits).toEqual({ contacts: 1000, events: 5, admins: 3, employees: null, scans: null, storageMb: null });
    expect(plan.trialDays).toBe(7);

    // Immutable from now on.
    const patch = await api("PATCH", `/platform/plans/${SLUG}/versions/${v1}`, platformToken, { limits: { events: 99 } });
    expect(patch.status).toBe(409);
    expect(patch.body.code).toBe("VERSION_IMMUTABLE");
    const del = await api("DELETE", `/platform/plans/${SLUG}/versions/${v1}`, platformToken);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe("VERSION_PUBLISHED");
    const row = (await db.select().from(planVersionsTable).where(eq(planVersionsTable.id, v1)))[0];
    expect(row.snapshot.limits.events).toBe(5);
    const republish = await api("POST", `/platform/plans/${SLUG}/versions/${v1}/publish`, platformToken);
    expect(republish.status).toBe(409);
    expect(republish.body.code).toBe("VERSION_IMMUTABLE");

    // Visible to tenants now (with the published limits), audit trail written.
    const tenantPlans = (await api("GET", "/subscriptions/plans", adminToken)).body as Array<{ id: string; limits: Record<string, number | null> }>;
    const mine = tenantPlans.find((p) => p.id === SLUG);
    expect(mine?.limits.events).toBe(5);
    const actions = (await planAudit(SLUG)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["plan.create", "plan_version.update", "plan.publish"]));
    const publishRow = (await planAudit(SLUG)).find((a) => a.action === "plan.publish")!;
    expect((publishRow.metadata as any).subscribersMoved).toBe(0);
  });
});

describe("tenant pinning and grandfathering", () => {
  it("assignment pins the tenant to the current version; a new publication never moves existing subscribers; new tenants get the new version", async () => {
    const moved = await api("POST", `/platform/subscriptions/${companyA}/plan`, platformToken, { plan: SLUG });
    expect(moved.status, moved.text).toBe(200);
    expect(moved.body).toMatchObject({ plan: SLUG, planVersionId: v1, planVersion: 1 });
    const limitsA = limitsOf((await current(adminToken)).limits);
    expect(limitsA.contacts).toEqual({ limit: 1000, source: "plan" });
    expect(limitsA.events).toEqual({ limit: 5, source: "plan" });
    const setPlanAudit = await db.select().from(auditLogsTable).where(and(eq(auditLogsTable.companyId, companyA), eq(auditLogsTable.action, "subscription.set_plan")));
    expect((setPlanAudit.at(-1)!.metadata as any).planVersionId).toBe(v1);

    // Draft v2 pre-filled from v1; one draft per plan.
    const draft = await api("POST", `/platform/plans/${SLUG}/versions`, platformToken, {});
    expect(draft.status, draft.text).toBe(201);
    expect(draft.body).toMatchObject({ version: 2, state: "draft" });
    expect(draft.body.snapshot.limits).toEqual({ contacts: 1000, events: 5, admins: 3, employees: null, scans: null, storageMb: null });
    v2 = draft.body.id;
    const second = await api("POST", `/platform/plans/${SLUG}/versions`, platformToken, {});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("DRAFT_EXISTS");

    // Tighten v2 below A's real usage (4 contacts) so the impact preview has something to say.
    for (let i = 0; i < 4; i++) {
      const c = await api("POST", "/contacts", adminToken, { firstName: "Growth", lastName: `Impact${i}`, email: `impact${i}-${SUFFIX}@${DOMAIN}` });
      expect(c.status, c.text).toBe(201);
    }
    expect((await api("PATCH", `/platform/plans/${SLUG}/versions/${v2}`, platformToken, { limits: { contacts: 3, events: 2 } })).status).toBe(200);

    const impact = (await api("GET", `/platform/plans/${SLUG}/versions/${v2}/impact`, platformToken)).body;
    expect(impact).toMatchObject({ state: "draft", planSubscribers: 1, unpinnedSubscribers: 0, subscribersOnVersion: 0, retire: null });
    expect(impact.currentVersion.version).toBe(1);
    expect(impact.publish.subscribersMoved).toBe(0);
    expect(impact.publish.diffVsCurrent.map((r: any) => `${r.group}.${r.field}`).sort()).toEqual(["limits.contacts", "limits.events"]);
    expect(impact.publish.tightenedLimits.sort()).toEqual(["contacts", "events"]);
    expect(impact.publish.tenantsExceedingNewLimits.tenants.map((t: any) => t.companyId)).toEqual([companyA]);
    expect(impact.publish.tenantsExceedingNewLimits.tenants[0].resources).toEqual([{ resource: "contacts", limit: 3, used: 4 }]);
    expect(impact.publish.blockers).toEqual([]);

    const cmp = (await api("GET", `/platform/plans/${SLUG}/versions/${v1}/compare/${v2}`, platformToken)).body;
    expect(cmp.changedFields.sort()).toEqual(["limits.contacts", "limits.events"]);
    expect(cmp.tightenedLimits.sort()).toEqual(["contacts", "events"]);
    expect(cmp.loosenedLimits).toEqual([]);
    expect(cmp.left).toMatchObject({ version: 1, state: "published", subscribers: 1 });
    expect(cmp.right).toMatchObject({ version: 2, state: "draft", subscribers: 0 });

    // Version preview = the single resolver over the draft's limits with A's real usage.
    const pv = (await api("GET", `/platform/plans/${SLUG}/versions/${v2}/effective-limits/${companyA}`, platformToken)).body;
    expect(pv).toMatchObject({ previewVersionId: v2, previewVersion: 2, previewVersionState: "draft", currentPlanVersionId: v1, isCurrentPlan: true, readOnly: true });
    expect(pv.rows.find((r: any) => r.resource === "contacts")).toMatchObject({ planDefault: 3, effective: 3, currentEffective: 1000, used: 4, exceeds: true, changes: true });
    expect(pv.blockingResources).toEqual(["contacts"]);
    // And the current-plan preview (no version given) reads the current published version.
    const pvCurrent = (await api("GET", `/platform/plans/${SLUG}/effective-limits/${companyA}`, platformToken)).body;
    expect(pvCurrent).toMatchObject({ previewVersionId: v1, previewVersion: 1, previewVersionState: "published" });
    expect(pvCurrent.changedResources).toEqual([]);

    const subsBefore = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.plan, SLUG));
    const published = await api("POST", `/platform/plans/${SLUG}/versions/${v2}/publish`, platformToken);
    expect(published.status, published.text).toBe(200);
    // Existing subscriber A: untouched (row, pin, effective limits).
    const subsAfter = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.plan, SLUG));
    expect(subsAfter).toEqual(subsBefore);
    expect(await detail(companyA)).toMatchObject({ planVersionId: v1, planVersion: 1 });
    expect(limitsOf((await current(adminToken)).limits).contacts).toEqual({ limit: 1000, source: "plan" });
    // Catalog / row mirror follow the new current version; new tenants pin to v2.
    const plan = (await api("GET", `/platform/plans/${SLUG}`, platformToken)).body;
    expect(plan.currentVersion.version).toBe(2);
    expect(plan.limits.contacts).toBe(3);
    expect(plan.pinnedSubscriptions).toBe(1);
    const companyC = await createCompany(`QA B40 Versions C ${SUFFIX}`, SLUG);
    expect(await detail(companyC)).toMatchObject({ plan: SLUG, planVersionId: v2, planVersion: 2 });
    expect(limitsOf((await detail(companyC)).limits).contacts).toEqual({ limit: 3, source: "plan" });
    const list = (await api("GET", `/platform/plans/${SLUG}/versions`, platformToken)).body;
    expect(list.currentVersionId).toBe(v2);
    expect(list.versions.map((v: any) => [v.version, v.state, v.subscribers])).toEqual([[1, "published", 1], [2, "published", 1]]);
    // Contact enforcement for A still follows its pinned v1 (1000), not the new v2 (3).
    const extra = await api("POST", "/contacts", adminToken, { firstName: "Growth", lastName: "StillV1", email: `stillv1-${SUFFIX}@${DOMAIN}` });
    expect(extra.status, extra.text).toBe(201);
  });
});

describe("concurrency safety", () => {
  it("two concurrent publishes of the same draft: exactly one succeeds; two concurrent draft creations: exactly one draft exists", async () => {
    const draft = await api("POST", `/platform/plans/${SLUG}/versions`, platformToken, {});
    expect(draft.status, draft.text).toBe(201);
    v3 = draft.body.id;
    expect((await api("PATCH", `/platform/plans/${SLUG}/versions/${v3}`, platformToken, { limits: { scans: 77 } })).status).toBe(200);
    const results = await Promise.all([api("POST", `/platform/plans/${SLUG}/versions/${v3}/publish`, platformToken), api("POST", `/platform/plans/${SLUG}/versions/${v3}/publish`, platformToken)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe("VERSION_IMMUTABLE");
    const publishRows = (await planAudit(SLUG)).filter((a) => a.action === "plan.publish" && (a.metadata as any).versionId === v3);
    expect(publishRows.length).toBe(1);
    const row = (await db.select().from(planVersionsTable).where(eq(planVersionsTable.id, v3)))[0];
    expect(row.publishedAt).not.toBeNull();

    const drafts = await Promise.all([api("POST", `/platform/plans/${SLUG}/versions`, platformToken, {}), api("POST", `/platform/plans/${SLUG}/versions`, platformToken, {})]);
    expect(drafts.map((r) => r.status).sort()).toEqual([201, 409]);
    const draftRows = await db.select().from(planVersionsTable).where(and(eq(planVersionsTable.planId, SLUG), eq(planVersionsTable.version, 4)));
    expect(draftRows.length).toBe(1);
    const deleted = await api("DELETE", `/platform/plans/${SLUG}/versions/${draftRows[0].id}`, platformToken);
    expect(deleted.status, deleted.text).toBe(200);
    expect(deleted.body).toEqual({ deleted: true, versionId: draftRows[0].id, planDeleted: false });
    expect((await api("GET", `/platform/plans/${SLUG}/versions/${draftRows[0].id}`, platformToken)).status).toBe(404);
  });
});

describe("PB-2.5 retire safely", () => {
  it("retiring keeps subscribers on their version, re-points new tenants and the row mirror, and never removes the last published version", async () => {
    expect((await api("GET", `/platform/plans/${SLUG}`, platformToken)).body.limits.scans).toBe(77); // v3 is current
    const retireV1 = await api("POST", `/platform/plans/${SLUG}/versions/${v1}/retire`, platformToken);
    expect(retireV1.status, retireV1.text).toBe(200);
    expect(retireV1.body).toMatchObject({ version: 1, state: "retired", subscribers: 1 });
    expect(await detail(companyA)).toMatchObject({ planVersionId: v1, planVersion: 1 });
    expect(limitsOf((await current(adminToken)).limits).contacts).toEqual({ limit: 1000, source: "plan" });
    const again = await api("POST", `/platform/plans/${SLUG}/versions/${v1}/retire`, platformToken);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("VERSION_RETIRED");

    // Retire the CURRENT version (v3): v2 becomes current again, the row mirror follows, new tenants pin to v2.
    const impactV3 = (await api("GET", `/platform/plans/${SLUG}/versions/${v3}/impact`, platformToken)).body;
    expect(impactV3.retire).toMatchObject({ isCurrent: true, isLastPublished: false, alreadyRetired: false, subscribersKept: 0 });
    expect(impactV3.retire.newCurrentVersion.version).toBe(2);
    const retireV3 = await api("POST", `/platform/plans/${SLUG}/versions/${v3}/retire`, platformToken);
    expect(retireV3.status, retireV3.text).toBe(200);
    const plan = (await api("GET", `/platform/plans/${SLUG}`, platformToken)).body;
    expect(plan.currentVersion.version).toBe(2);
    expect(plan.limits.scans).toBeNull();
    expect(plan.retiredVersionCount).toBe(2);
    const companyD = await createCompany(`QA B40 Versions D ${SUFFIX}`, SLUG);
    expect(await detail(companyD)).toMatchObject({ planVersionId: v2, planVersion: 2 });

    const last = await api("POST", `/platform/plans/${SLUG}/versions/${v2}/retire`, platformToken);
    expect(last.status).toBe(409);
    expect(last.body.code).toBe("LAST_PUBLISHED_VERSION");
    const impactV2 = (await api("GET", `/platform/plans/${SLUG}/versions/${v2}/impact`, platformToken)).body;
    expect(impactV2.retire).toMatchObject({ isCurrent: true, isLastPublished: true, subscribersKept: 2 });

    const draft = await api("POST", `/platform/plans/${SLUG}/versions`, platformToken, {});
    expect(draft.status).toBe(201);
    const retireDraft = await api("POST", `/platform/plans/${SLUG}/versions/${draft.body.id}/retire`, platformToken);
    expect(retireDraft.status).toBe(409);
    expect(retireDraft.body.code).toBe("VERSION_NOT_PUBLISHED");
    expect((await api("DELETE", `/platform/plans/${SLUG}/versions/${draft.body.id}`, platformToken)).status).toBe(200);
    expect((await planAudit(SLUG)).filter((a) => a.action === "plan_version.retire").length).toBe(2);
  });
});

describe("PB-2.3 duplicate and PB-2.5 archive", () => {
  it("duplicating copies limits / features / trial policy into a new draft plan without prices; archiving needs zero subscribers and never touches the fixed ids", async () => {
    const dup = await api("POST", `/platform/plans/${SLUG}/duplicate`, platformToken, { id: DUP, name: "Growth Copy" });
    expect(dup.status, dup.text).toBe(201);
    expect(dup.body.plan).toMatchObject({ id: DUP, status: "draft" });
    expect(dup.body.draft.snapshot.name).toBe("Growth Copy");
    expect(dup.body.draft.snapshot.limits).toEqual({ contacts: 3, events: 2, admins: 3, employees: null, scans: null, storageMb: null }); // = current v2
    expect(dup.body.draft.snapshot.prices).toEqual([]);
    expect(dup.body.draft.trialPolicy.trialDays).toBe(7);
    const dupAudit = (await planAudit(DUP)).find((a) => a.action === "plan.duplicate")!;
    expect(dupAudit.metadata).toMatchObject({ sourcePlanId: SLUG, sourceVersionId: v2, pricesCopied: 0 });

    const notPublished = await api("POST", `/platform/plans/${DUP}/archive`, platformToken);
    expect(notPublished.status).toBe(409);
    expect(notPublished.body.code).toBe("PLAN_NOT_PUBLISHED");
    expect((await api("POST", `/platform/plans/${DUP}/versions/${dup.body.draft.id}/publish`, platformToken)).status).toBe(200);
    const archived = await api("POST", `/platform/plans/${DUP}/archive`, platformToken);
    expect(archived.status, archived.text).toBe(200);
    expect(archived.body).toMatchObject({ status: "archived", isActive: false });
    const assign = await api("POST", `/platform/subscriptions/${companyB}/plan`, platformToken, { plan: DUP });
    expect(assign.status).toBe(400);
    expect((await api("GET", "/subscriptions/plans", adminToken)).body.map((p: any) => p.id)).not.toContain(DUP);
    expect((await api("POST", `/platform/plans/${DUP}/archive`, platformToken)).body.code).toBe("PLAN_ARCHIVED");
    expect((await api("POST", `/platform/plans/${DUP}/versions`, platformToken, {})).body.code).toBe("PLAN_ARCHIVED");

    const fixed = await api("POST", "/platform/plans/free/archive", platformToken);
    expect(fixed.status).toBe(409);
    expect(fixed.body.code).toBe("ARCHIVE_REQUIRES_MIGRATION_TARGET");
    const withSubs = await api("POST", `/platform/plans/${SLUG}/archive`, platformToken);
    expect(withSubs.status).toBe(409);
    expect(withSubs.body.code).toBe("PLAN_HAS_SUBSCRIBERS");
    expect((await planAudit(DUP)).map((a) => a.action)).toEqual(expect.arrayContaining(["plan.duplicate", "plan.publish", "plan.archive"]));
  });
});

describe("read endpoints never write; complete audit history", () => {
  it("list / detail / validate / impact / compare / previews leave plans, versions, subscriptions and audit rows unchanged", async () => {
    const snap = async () =>
      JSON.stringify({
        plans: await db.select().from(plansTable).orderBy(asc(plansTable.id)),
        versions: await db.select().from(planVersionsTable).orderBy(asc(planVersionsTable.id)),
        subs: await db.select().from(subscriptionsTable).orderBy(asc(subscriptionsTable.id)),
        audits: (await db.select({ id: auditLogsTable.id }).from(auditLogsTable)).length,
      });
    const before = await snap();
    const calls = [
      api("GET", "/platform/plans", platformToken),
      api("GET", `/platform/plans/${SLUG}`, platformToken),
      api("GET", `/platform/plans/${SLUG}/versions`, platformToken),
      api("GET", `/platform/plans/${SLUG}/versions/${v2}`, platformToken),
      api("POST", `/platform/plans/${SLUG}/versions/${v2}/validate`, platformToken),
      api("GET", `/platform/plans/${SLUG}/versions/${v2}/impact`, platformToken),
      api("GET", `/platform/plans/${SLUG}/versions/${v1}/compare/${v2}`, platformToken),
      api("GET", `/platform/plans/${SLUG}/versions/${v2}/effective-limits/${companyA}`, platformToken),
      api("GET", `/platform/plans/${SLUG}/effective-limits/${companyA}`, platformToken),
      api("GET", `/platform/plans/${SLUG}/versions/999999999`, platformToken),
      api("GET", `/platform/plans/nope-${SUFFIX}/versions`, platformToken),
    ];
    const results = await Promise.all(calls);
    expect(results.slice(0, 9).map((r) => r.status)).toEqual(Array(9).fill(200));
    expect(results[9].status).toBe(404);
    expect(results[10].status).toBe(404);
    expect(await snap()).toBe(before);
  });

  it("every lifecycle action left an audit row with the plan / version identity", async () => {
    const actions = (await planAudit(SLUG)).map((a) => a.action);
    for (const a of ["plan.create", "plan_version.update", "plan.publish", "plan_version.create", "plan_version.retire", "plan_version.delete"]) expect(actions, a).toContain(a);
    const rows = await planAudit(SLUG);
    for (const r of rows) {
      expect(["plan", "plan_version"]).toContain(r.entityType);
      expect(typeof r.entityId).toBe("string");
    }
    const pins = await db.select().from(auditLogsTable).where(and(inArray(auditLogsTable.companyId, companyIds), eq(auditLogsTable.action, "subscription.pin_version")));
    expect(pins.length).toBeGreaterThanOrEqual(2); // A and B were pinned by the backfill
  });
});
