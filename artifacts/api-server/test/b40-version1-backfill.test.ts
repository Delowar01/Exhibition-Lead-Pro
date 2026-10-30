import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db, companiesTable, usersTable, auditLogsTable, plansTable, planVersionsTable, subscriptionsTable } from "@workspace/db";
import { runVersionBackfill, entitlementSnapshot, compareSnapshots } from "../src/lib/billing/version-backfill.js";

// Batch 40 — version-1 compatibility backfill (dry-run first, idempotent, verified,
// rolled back on any difference) against the LIVE API + the isolated local DB.
//
// Legacy state is reproduced deliberately: synthetic PUBLISHED plan rows WITHOUT
// versions (what the fixed catalog looks like before the backfill) and tenants
// created on them through the real API, so their subscriptions carry the legacy
// NULL version reference. The test proves BEFORE == AFTER for effective limits,
// overrides, status, access mode, billing source and provider price, that the dry
// run writes nothing, that a second apply writes nothing, that a mid-transaction
// failure rolls EVERYTHING back, that an unresolved reference never changes access,
// and that publication stays refused until the references are resolved.

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const SUFFIX = Date.now();
const LEGACY = `b40-legacy-${SUFFIX}`;
const LEGACY2 = `b40-legacyb-${SUFFIX}`;
const LEGACY3 = `b40-legacyc-${SUFFIX}`;
const TRIGGER = `b40_fail_pin_${SUFFIX}`;

let platformToken = "";
let companyE = 0;
let companyF = 0;
let companyG = 0;
let companyH = 0;
const companyIds: number[] = [];

function headers(token: string | null) {
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: headers(null), body: JSON.stringify({ email, password }) });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
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
// What must not change: everything the tenant experiences.
const observable = (d: any) => ({ plan: d.plan, status: d.status, accessMode: d.accessMode, billingSource: d.billingSource, limits: d.limits, limitOverrides: d.limitOverrides, trialExpiresAt: d.trialExpiresAt, currentPeriodEndsAt: d.currentPeriodEndsAt, usage: d.usage });
async function createCompany(name: string, plan: string) {
  const res = await api("POST", "/companies", platformToken, { name, plan });
  expect(res.status, res.text).toBe(201);
  companyIds.push(res.body.id);
  return res.body.id as number;
}
async function insertLegacyPlan(id: string, limits: { contacts?: number | null; events?: number | null; admins?: number | null }) {
  await db.insert(plansTable).values({
    id,
    name: `Legacy ${id}`,
    description: "legacy row without versions",
    sortOrder: 50,
    trialDays: 21,
    isActive: true,
    status: "published",
    features: { "ai.assistant": true, oldFlag: true },
    contactsLimit: limits.contacts ?? null,
    eventsLimit: limits.events ?? null,
    adminsLimit: limits.admins ?? null,
    employeesLimit: null,
    scansLimit: null,
    storageLimitMb: null,
    apiLimit: null,
  });
}
const auditCount = async (action: string) => (await db.select({ id: auditLogsTable.id }).from(auditLogsTable).where(eq(auditLogsTable.action, action))).length;

beforeAll(async () => {
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  await insertLegacyPlan(LEGACY, { contacts: 5, events: 3, admins: 2 });
  await insertLegacyPlan(LEGACY2, { contacts: 8 });
  await insertLegacyPlan(LEGACY3, { events: 1 });
  companyE = await createCompany(`QA B40 Backfill E ${SUFFIX}`, LEGACY);
  companyF = await createCompany(`QA B40 Backfill F ${SUFFIX}`, LEGACY);
  companyG = await createCompany(`QA B40 Backfill G ${SUFFIX}`, LEGACY2);
  companyH = await createCompany(`QA B40 Backfill H ${SUFFIX}`, LEGACY3);
  // Vary the lifecycle state so the comparison covers status / access mode / overrides.
  expect((await api("POST", `/platform/subscriptions/${companyE}/expire`, platformToken)).status).toBe(200);
  expect((await api("POST", `/platform/subscriptions/${companyF}/activate`, platformToken)).status).toBe(200);
  expect((await api("PUT", `/platform/subscriptions/${companyF}/limits`, platformToken, { limits: { events: 9 } })).status).toBe(200);
});

afterAll(async () => {
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${TRIGGER} ON subscriptions`));
  await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${TRIGGER}()`));
  if (companyIds.length) {
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds));
    await db.delete(usersTable).where(inArray(usersTable.companyId, companyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds));
  }
  await db.delete(planVersionsTable).where(inArray(planVersionsTable.planId, [LEGACY, LEGACY2, LEGACY3]));
  await db.delete(plansTable).where(inArray(plansTable.id, [LEGACY, LEGACY2, LEGACY3]));
});

describe("legacy references resolve exactly as before versioning", () => {
  it("tenants on a plan without versions carry a NULL reference, read the plan row, and publication for that plan is refused", async () => {
    const e = await detail(companyE);
    expect(e).toMatchObject({ plan: LEGACY, planVersionId: null, planVersion: null, status: "expired", accessMode: "blocked" });
    expect(e.limits.find((l: any) => l.resource === "contacts")).toMatchObject({ limit: 5, source: "plan" });
    const f = await detail(companyF);
    expect(f).toMatchObject({ planVersionId: null, status: "active", accessMode: "full" });
    expect(f.limits.find((l: any) => l.resource === "events")).toMatchObject({ limit: 9, source: "override" });
    const overview = (await api("GET", `/platform/plans/${LEGACY}`, platformToken)).body;
    expect(overview).toMatchObject({ status: "published", versioning: "not_versioned", currentVersion: null, unpinnedSubscriptions: 2, pinnedSubscriptions: 0 });
    // A draft can exist, but publishing it is refused while unresolved references exist.
    const draft = await api("POST", `/platform/plans/${LEGACY}/versions`, platformToken, {});
    expect(draft.status, draft.text).toBe(201);
    expect(draft.body.snapshot.limits).toEqual({ contacts: 5, events: 3, admins: 2, employees: null, scans: null, storageMb: null }); // pre-filled from the row
    const validation = (await api("POST", `/platform/plans/${LEGACY}/versions/${draft.body.id}/validate`, platformToken)).body;
    expect(validation.ok).toBe(true);
    expect(validation.publishable).toBe(false);
    expect(validation.blockers).toEqual([{ code: "UNPINNED_SUBSCRIBERS", message: expect.any(String), count: 2 }]);
    const publish = await api("POST", `/platform/plans/${LEGACY}/versions/${draft.body.id}/publish`, platformToken);
    expect(publish.status).toBe(409);
    expect(publish.body.code).toBe("UNPINNED_SUBSCRIBERS");
    expect((await api("DELETE", `/platform/plans/${LEGACY}/versions/${draft.body.id}`, platformToken)).status).toBe(200);
  });
});

describe("dry run first", () => {
  it("reports exactly what an apply would do and writes NOTHING (no version, no pin, no audit row)", async () => {
    const versionsBefore = await db.select().from(planVersionsTable);
    const subsBefore = await db.select().from(subscriptionsTable);
    const audits = { backfill: await auditCount("plan_version.backfill"), pins: await auditCount("subscription.pin_version") };
    const report = await runVersionBackfill({ apply: false });
    expect(report).toMatchObject({ mode: "dry-run", applied: false, rolledBack: true });
    expect(report.reason).toContain("dry run");
    const legacyEntry = report.plans.find((p) => p.planId === LEGACY)!;
    expect(legacyEntry.action).toBe("version_created");
    expect(legacyEntry.version).toBe(1);
    expect(report.subscriptions.pinned.map((p) => p.companyId)).toEqual(expect.arrayContaining([companyE, companyF, companyG, companyH]));
    expect(report.verification.mismatches).toEqual([]);
    expect(report.verification.compared).toBe(report.subscriptions.total);
    expect(await db.select().from(planVersionsTable)).toEqual(versionsBefore);
    expect(await db.select().from(subscriptionsTable)).toEqual(subsBefore);
    expect(await auditCount("plan_version.backfill")).toBe(audits.backfill);
    expect(await auditCount("subscription.pin_version")).toBe(audits.pins);
  });
});

describe("failure rollback", () => {
  it("a failure while pinning rolls back every version and every pin of the run; a later apply succeeds", async () => {
    await db.execute(
      sql.raw(
        `CREATE OR REPLACE FUNCTION ${TRIGGER}() RETURNS trigger AS $$ BEGIN IF NEW.plan_version_id IS NOT NULL AND NEW.company_id = ${companyG} THEN RAISE EXCEPTION 'b40 injected pin failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;`,
      ),
    );
    await db.execute(sql.raw(`CREATE TRIGGER ${TRIGGER} BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION ${TRIGGER}()`));
    try {
      const failure = await runVersionBackfill({ apply: true }).then(() => null, (e: unknown) => e);
      expect(failure).toBeTruthy();
      // drizzle wraps the Postgres error ("Failed query: …") and keeps the original as `cause`.
      const chain = [failure, (failure as { cause?: unknown })?.cause].filter(Boolean).map((e) => String((e as { message?: string })?.message ?? e)).join(" | ");
      expect(chain).toMatch(/injected pin failure/);
      expect((await db.select().from(planVersionsTable).where(inArray(planVersionsTable.planId, [LEGACY, LEGACY2, LEGACY3]))).length).toBe(0);
      const refs = await db.select({ companyId: subscriptionsTable.companyId, v: subscriptionsTable.planVersionId }).from(subscriptionsTable).where(inArray(subscriptionsTable.companyId, [companyE, companyF, companyG, companyH]));
      expect(refs.every((r) => r.v === null)).toBe(true);
      // Still resolvable while unresolved: the row keeps serving (nothing changed silently).
      expect((await detail(companyE)).limits.find((l: any) => l.resource === "contacts").limit).toBe(5);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${TRIGGER} ON subscriptions`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${TRIGGER}()`));
    }
  });
});

describe("apply, verify, idempotency", () => {
  it("BEFORE == AFTER for every tenant; version 1 = the row's actual values; a second apply changes nothing", async () => {
    const before = { E: observable(await detail(companyE)), F: observable(await detail(companyF)), G: observable(await detail(companyG)), H: observable(await detail(companyH)) };
    const snapBefore = await entitlementSnapshot(new Date("2026-10-30T00:00:00Z"));
    const audits = { backfill: await auditCount("plan_version.backfill"), pins: await auditCount("subscription.pin_version") };

    const report = await runVersionBackfill({ apply: true });
    expect(report.applied, JSON.stringify(report)).toBe(true);
    expect(report.rolledBack).toBe(false);
    expect(report.verification.mismatches).toEqual([]);
    for (const id of [LEGACY, LEGACY2, LEGACY3]) expect(report.plans.find((p) => p.planId === id)!.action).toBe("version_created");
    expect(report.subscriptions.pinned.map((p) => p.companyId)).toEqual(expect.arrayContaining([companyE, companyF, companyG, companyH]));
    expect(report.subscriptions.unpinnable).toEqual([]);

    const snapAfter = await entitlementSnapshot(new Date("2026-10-30T00:00:00Z"));
    expect(compareSnapshots(snapBefore, snapAfter)).toEqual([]);
    const after = { E: await detail(companyE), F: await detail(companyF), G: await detail(companyG), H: await detail(companyH) };
    expect(observable(after.E)).toEqual(before.E);
    expect(observable(after.F)).toEqual(before.F);
    expect(observable(after.G)).toEqual(before.G);
    expect(observable(after.H)).toEqual(before.H);
    expect(after.E.planVersion).toBe(1);
    expect(after.F.planVersionId).toBe(after.E.planVersionId);

    const v1 = (await db.select().from(planVersionsTable).where(and(eq(planVersionsTable.planId, LEGACY), eq(planVersionsTable.version, 1))))[0];
    expect(v1.publishedAt).not.toBeNull();
    expect(v1.publishedBy).toBeNull();
    expect(v1.snapshot).toMatchObject({ name: `Legacy ${LEGACY}`, sortOrder: 50, limits: { contacts: 5, events: 3, admins: 2, employees: null, scans: null, storageMb: null }, prices: [] });
    expect(v1.snapshot.features["ai.assistant"]).toBe(true);
    expect((v1.snapshot.features as Record<string, unknown>).oldFlag).toBeUndefined();
    expect(v1.trialPolicy).toEqual({ trialDays: 21, eligible: true, oncePerCompany: true, endOutcome: "blocked", readOnlyGraceDays: 0 });
    expect(await auditCount("plan_version.backfill")).toBe(audits.backfill + 3);
    expect(await auditCount("subscription.pin_version")).toBeGreaterThanOrEqual(audits.pins + 4);
    const overview = (await api("GET", `/platform/plans/${LEGACY}`, platformToken)).body;
    expect(overview).toMatchObject({ versioning: "versioned", unpinnedSubscriptions: 0, pinnedSubscriptions: 2 });
    expect(overview.currentVersion.version).toBe(1);

    // Idempotent: nothing to do, nothing written.
    const auditsAfter = { backfill: await auditCount("plan_version.backfill"), pins: await auditCount("subscription.pin_version") };
    const again = await runVersionBackfill({ apply: true });
    expect(again.applied).toBe(true);
    expect(again.plans.every((p) => p.action === "version_exists" || p.action === "skipped_not_published")).toBe(true);
    expect(again.subscriptions.pinned).toEqual([]);
    expect(again.subscriptions.alreadyPinned).toBe(again.subscriptions.total);
    expect(await auditCount("plan_version.backfill")).toBe(auditsAfter.backfill);
    expect(await auditCount("subscription.pin_version")).toBe(auditsAfter.pins);

    // Publication is possible once every reference is resolved — and it does not move the pinned tenants.
    const draft = await api("POST", `/platform/plans/${LEGACY}/versions`, platformToken, {});
    expect(draft.status).toBe(201);
    expect((await api("PATCH", `/platform/plans/${LEGACY}/versions/${draft.body.id}`, platformToken, { limits: { contacts: 1 } })).status).toBe(200);
    const publish = await api("POST", `/platform/plans/${LEGACY}/versions/${draft.body.id}/publish`, platformToken);
    expect(publish.status, publish.text).toBe(200);
    expect(observable(await detail(companyE))).toEqual(before.E);
    expect(observable(await detail(companyF))).toEqual(before.F);
    expect((await detail(companyE)).planVersion).toBe(1);
  });

  it("a plan whose only version is a draft is reported, never guessed, and its tenants keep the legacy reference without any access change", async () => {
    const LEGACY4 = `b40-legacyd-${SUFFIX}`;
    await insertLegacyPlan(LEGACY4, { contacts: 2 });
    const companyI = await createCompany(`QA B40 Backfill I ${SUFFIX}`, LEGACY4);
    const draft = await api("POST", `/platform/plans/${LEGACY4}/versions`, platformToken, {});
    expect(draft.status).toBe(201);
    try {
      const beforeI = observable(await detail(companyI));
      const report = await runVersionBackfill({ apply: true });
      expect(report.plans.find((p) => p.planId === LEGACY4)!.action).toBe("blocked_draft_only");
      expect(report.subscriptions.unpinnable).toEqual([{ companyId: companyI, subscriptionId: expect.any(Number), planId: LEGACY4, reason: "plan_has_no_published_version" }]);
      expect(report.verification.mismatches).toEqual([]);
      const afterI = await detail(companyI);
      expect(afterI.planVersionId).toBeNull();
      expect(observable(afterI)).toEqual(beforeI);
      expect(afterI.limits.find((l: any) => l.resource === "contacts").limit).toBe(2);
    } finally {
      await db.delete(auditLogsTable).where(eq(auditLogsTable.companyId, companyI));
      await db.delete(usersTable).where(eq(usersTable.companyId, companyI));
      await db.delete(companiesTable).where(eq(companiesTable.id, companyI));
      await db.delete(planVersionsTable).where(eq(planVersionsTable.planId, LEGACY4));
      await db.delete(plansTable).where(eq(plansTable.id, LEGACY4));
    }
  });
});
