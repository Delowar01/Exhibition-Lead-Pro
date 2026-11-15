import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, companiesTable, usersTable, contactsTable, subscriptionsTable, auditLogsTable, plansTable, planVersionsTable } from "@workspace/db";
import { runVersionBackfill } from "../src/lib/billing/version-backfill.js";
import { setPlan } from "../src/services/subscription-lifecycle.service.js";
import { __setBillingFaultsForTests } from "../src/lib/billing/test-faults.js";
import { AppError } from "../src/middlewares/errorHandler.js";

// Batch 42 (PB-4.4) — the platform owner's plan / version change against the
// LIVE API: eligible published versions only, immediate manual change, the
// current-vs-target limit comparison with tenant override precedence, the U6
// downgrade guard (measurable usage over the target limit BLOCKS; unmeasurable
// is reported, never "verified"), the feature-only confirmation (D3), atomic
// update with post-change verification (rollback proven in-process), audit
// completeness, grandfathering of pinned / legacy tenants, concurrency and the
// manual / provider separation.

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b42chg-${SUFFIX}.test`;
const PLAN = `b42r-${SUFFIX}`;
const FEATURES = ["ai.assistant", "ai.command_center", "workflow.intelligence", "executive.intelligence", "exports.scheduled", "nfc.capture", "documents", "api.access"] as const;

let platformToken = "";
let adminId = 0;
let c1Token = "";
let c1 = 0; // on PLAN v1 with 3 contacts
let c2 = 0; // provider-managed (billingSource stripe)
let c3 = 0; // on PLAN v1 for concurrency / rollback
let c4 = 0; // legacy NULL reference on free
let v1 = 0;
let v2 = 0;
let v3 = 0; // draft, never published
let freeV1 = 0;
const companyIds: number[] = [];

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
const setPlanOf = (cid: number, body: unknown, token = platformToken) => api("POST", `/platform/subscriptions/${cid}/plan`, token, body);
const previewOf = (cid: number, body: unknown, token = platformToken) => api("POST", `/platform/subscriptions/${cid}/plan/preview`, token, body);
async function subRow(cid: number) {
  const [row] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, cid));
  return row;
}
async function setPlanAudit(cid: number) {
  return db.select().from(auditLogsTable).where(and(eq(auditLogsTable.companyId, cid), eq(auditLogsTable.action, "subscription.set_plan"))).orderBy(auditLogsTable.id);
}
async function createCompany(name: string) {
  const res = await api("POST", "/companies", platformToken, { name, plan: "free" });
  expect(res.status, res.text).toBe(201);
  companyIds.push(res.body.id);
  return res.body.id as number;
}

beforeAll(async () => {
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  const me = await fetch(`${BASE}/auth/login`, { method: "POST", headers: headers(null), body: JSON.stringify(PLATFORM) }).then((r) => r.json());
  adminId = me.user.id;
  expect((await runVersionBackfill({ apply: true })).verdict).toBe("APPLIED");
  freeV1 = (await api("GET", "/platform/plans/free", platformToken)).body.currentVersion.id;
  // v1: legacy, unlimited. v2: enforced, documents off, contacts 2. v3: draft (never published).
  const created = await api("POST", "/platform/plans", platformToken, { id: PLAN, name: `Change ${SUFFIX}`, limits: {}, features: {} });
  expect(created.status, created.text).toBe(201);
  v1 = created.body.draft.id;
  expect((await api("POST", `/platform/plans/${PLAN}/versions/${v1}/publish`, platformToken)).status).toBe(200);
  const d2 = await api("POST", `/platform/plans/${PLAN}/versions`, platformToken, { sourceVersionId: v1 });
  expect(d2.status, d2.text).toBe(201);
  v2 = d2.body.id;
  const matrix = Object.fromEntries(FEATURES.map((k) => [k, k !== "documents"]));
  const patched = await api("PATCH", `/platform/plans/${PLAN}/versions/${v2}`, platformToken, { limits: { contacts: 2 }, features: matrix, featureEnforcement: "enforced" });
  expect(patched.status, patched.text).toBe(200);
  expect((await api("POST", `/platform/plans/${PLAN}/versions/${v2}/publish`, platformToken)).status).toBe(200);
  const d3 = await api("POST", `/platform/plans/${PLAN}/versions`, platformToken, { sourceVersionId: v2 });
  expect(d3.status, d3.text).toBe(201);
  v3 = d3.body.id;

  c1 = await createCompany(`QA B42 Change 1 ${SUFFIX}`);
  c2 = await createCompany(`QA B42 Change 2 ${SUFFIX}`);
  c3 = await createCompany(`QA B42 Change 3 ${SUFFIX}`);
  c4 = await createCompany(`QA B42 Change 4 ${SUFFIX}`);
  for (const cid of [c1, c3]) {
    const res = await setPlanOf(cid, { plan: PLAN, planVersionId: v1 });
    expect(res.status, res.text).toBe(200);
    expect(res.body.planVersionId).toBe(v1);
  }
  const user = await api("POST", "/users", platformToken, { email: `admin@${DOMAIN}`, name: "admin", role: "primary_admin", companyId: c1, password: PW });
  expect(user.status, user.text).toBe(201);
  c1Token = await login(`admin@${DOMAIN}`);
  for (let i = 0; i < 3; i++) {
    const res = await api("POST", "/contacts", c1Token, { firstName: `Lead${i}`, lastName: `B42-${SUFFIX}`, email: `lead${i}-${SUFFIX}@example.test` });
    expect(res.status, res.text).toBe(201);
  }
  await db.update(subscriptionsTable).set({ billingSource: "stripe", stripeSubscriptionId: `sub_fake_b42chg_${SUFFIX}` }).where(eq(subscriptionsTable.companyId, c2));
  await db.update(subscriptionsTable).set({ planVersionId: null }).where(eq(subscriptionsTable.companyId, c4));
});

afterAll(async () => {
  __setBillingFaultsForTests({});
  if (companyIds.length) {
    await db.delete(contactsTable).where(inArray(contactsTable.companyId, companyIds));
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds));
    await db.delete(usersTable).where(inArray(usersTable.companyId, companyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds));
  }
  await db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`));
  await db.delete(planVersionsTable).where(eq(planVersionsTable.planId, PLAN));
  await db.delete(plansTable).where(eq(plansTable.id, PLAN));
});

describe("preview = the exact evaluation of the change (read-only)", () => {
  it("compares current vs target limits with measured usage, reports unmeasurable resources and the lost features; writes nothing", async () => {
    const before = await subRow(c1);
    const auditBefore = (await setPlanAudit(c1)).length;
    const res = await previewOf(c1, { plan: PLAN, planVersionId: v2 });
    expect(res.status, res.text).toBe(200);
    const p = res.body;
    expect(p).toMatchObject({ companyId: c1, readOnly: true, wouldChange: true, implicitLegacyKept: false, sameTarget: false, changeKind: "version_change", eligible: false, requiresFeatureConfirmation: true });
    expect(p.current).toMatchObject({ plan: PLAN, planVersionId: v1, version: 1, valid: true, legacyReference: false, billingSource: "manual" });
    expect(p.target).toMatchObject({ plan: PLAN, planVersionId: v2, version: 2, state: "published", explicit: true });
    expect(p.transition).toEqual({ ok: true, code: null });
    expect(p.blocking).toEqual([{ resource: "contacts", used: 3, limit: 2 }]);
    const contacts = p.limits.find((l: any) => l.resource === "contacts");
    expect(contacts).toMatchObject({ currentLimit: null, targetLimit: 2, targetSource: "plan", override: null, used: 3, measurable: true, exceeds: true, tightens: true, loosens: false });
    expect(p.tightenedLimits).toContain("contacts");
    expect(p.unmeasurable).not.toContain("contacts");
    for (const r of p.unmeasurable) expect(p.limits.find((l: any) => l.resource === r).measurable).toBe(false);
    expect(p.features).toMatchObject({ enforcement: { current: "legacy", target: "enforced" }, lost: ["documents"], gained: [] });
    expect(p.features.current.documents).toBe(true);
    expect(p.features.target.documents).toBe(false);
    expect((await subRow(c1)).planVersionId).toBe(before.planVersionId);
    expect((await setPlanAudit(c1)).length).toBe(auditBefore);
  });
});

describe("U6 downgrade guard and D3 feature confirmation", () => {
  it("blocks a change whose target limit is below the measured usage (409 DOWNGRADE_BLOCKED) and deletes nothing", async () => {
    const res = await setPlanOf(c1, { plan: PLAN, planVersionId: v2 });
    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe("DOWNGRADE_BLOCKED");
    expect(res.body.context ?? res.body.details).toMatchObject({ blocking: [{ resource: "contacts", used: 3, limit: 2 }], targetPlan: PLAN, targetPlanVersionId: v2 });
    expect((await subRow(c1)).planVersionId).toBe(v1);
    expect(await setPlanAudit(c1)).toHaveLength(1); // only the initial assignment
    const contacts = await db.select().from(contactsTable).where(eq(contactsTable.companyId, c1));
    expect(contacts).toHaveLength(3);
  });

  it("a tenant override takes precedence over the target version's limit; a feature-only downgrade then needs explicit confirmation", async () => {
    const override = await api("PUT", `/platform/subscriptions/${c1}/limits`, platformToken, { limits: { contacts: 10 } });
    expect(override.status, override.text).toBe(200);
    const preview = (await previewOf(c1, { plan: PLAN, planVersionId: v2 })).body;
    expect(preview.blocking).toEqual([]);
    expect(preview.limits.find((l: any) => l.resource === "contacts")).toMatchObject({ targetLimit: 10, targetSource: "override", override: 10, exceeds: false });
    expect(preview.eligible).toBe(true);
    expect(preview.requiresFeatureConfirmation).toBe(true);
    const unconfirmed = await setPlanOf(c1, { plan: PLAN, planVersionId: v2 });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.code).toBe("FEATURE_DOWNGRADE_CONFIRMATION_REQUIRED");
    expect(unconfirmed.body.context ?? unconfirmed.body.details).toMatchObject({ lostFeatures: ["documents"], targetPlanVersionId: v2 });
    expect((await subRow(c1)).planVersionId).toBe(v1);
    expect((await setPlanOf(c1, { plan: PLAN, planVersionId: v2, confirmFeatureDowngrade: "yes" })).status).toBe(400);
    expect((await api("GET", "/documents", c1Token)).status).toBe(200); // still entitled

    const confirmed = await setPlanOf(c1, { plan: PLAN, planVersionId: v2, confirmFeatureDowngrade: true, reason: "Quarterly review" });
    expect(confirmed.status, confirmed.text).toBe(200);
    expect(confirmed.body).toMatchObject({ plan: PLAN, planVersionId: v2 });
    expect((await subRow(c1))).toMatchObject({ plan: PLAN, planVersionId: v2, limitOverrides: { contacts: 10 } });
    // Entitlements changed immediately and verifiably.
    const current = (await api("GET", "/subscriptions/current", c1Token)).body;
    expect(current.planVersionId).toBe(v2);
    expect(current.entitlements.features.documents).toBe(false);
    expect(current.entitlements.featureEnforcement).toBe("enforced");
    const denied = await api("GET", "/documents", c1Token);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("FEATURE_NOT_ENTITLED");
    // Audit completeness.
    const rows = await setPlanAudit(c1);
    expect(rows).toHaveLength(2);
    const m = rows[1].metadata as Record<string, any>;
    expect(rows[1].userId).toBe(adminId);
    expect(m.before).toMatchObject({ plan: PLAN, planVersionId: v1 });
    expect(m.after).toMatchObject({ plan: PLAN, planVersionId: v2 });
    expect(m.changed).toContain("planVersionId");
    expect(m).toMatchObject({ changeKind: "version_change", previousPlan: PLAN, previousPlanVersionId: v1, previousVersion: 1, previousReferenceValid: true, planVersionId: v2, targetVersion: 2, targetVersionState: "published", lostFeatures: ["documents"], gainedFeatures: [], featureEnforcementBefore: "legacy", featureEnforcementAfter: "enforced", confirmFeatureDowngrade: true, explicitVersion: true, reason: "Quarterly review" });
    expect(m.limitsBefore.contacts).toBe(10);
    expect(m.limitsAfter.contacts).toBe(10);
    expect(m.unmeasurable).toEqual(expect.arrayContaining([]));
  });

  it("refuses a draft target, a foreign version and malformed input; an upgrade back gains the features", async () => {
    const draft = await setPlanOf(c1, { plan: PLAN, planVersionId: v3 });
    expect(draft.status).toBe(409);
    expect(draft.body.code).toBe("VERSION_NOT_PUBLISHED");
    const foreign = await setPlanOf(c1, { plan: PLAN, planVersionId: freeV1 });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe("VERSION_NOT_FOUND");
    expect((await setPlanOf(c1, { plan: PLAN, planVersionId: 0 })).status).toBe(400);
    expect((await setPlanOf(c1, { plan: "no such plan", planVersionId: v1 })).status).toBe(400);
    expect((await subRow(c1)).planVersionId).toBe(v2);
    const back = await setPlanOf(c1, { plan: PLAN, planVersionId: v1 });
    expect(back.status, back.text).toBe(200);
    expect(back.body.planVersionId).toBe(v1);
    const m = (await setPlanAudit(c1)).pop()!.metadata as Record<string, any>;
    expect(m).toMatchObject({ gainedFeatures: ["documents"], lostFeatures: [], featureEnforcementAfter: "legacy" });
    expect((await api("GET", "/documents", c1Token)).status).toBe(200);
    // Same target again = no change, no audit row.
    const n = (await setPlanAudit(c1)).length;
    const same = await setPlanOf(c1, { plan: PLAN, planVersionId: v1 });
    expect(same.status).toBe(200);
    expect((await setPlanAudit(c1)).length).toBe(n);
    expect((await previewOf(c1, { plan: PLAN, planVersionId: v1 })).body).toMatchObject({ sameTarget: true, changeKind: "none", wouldChange: false });
  });
});

describe("grandfathering, provider separation, concurrency, rollback, authorization", () => {
  it("a pinned tenant is never moved by a publication; a legacy NULL reference is never moved implicitly", async () => {
    expect((await subRow(c3)).planVersionId).toBe(v1); // v2 was published after the pin
    const legacy = await previewOf(c4, { plan: "free" });
    expect(legacy.status, legacy.text).toBe(200);
    expect(legacy.body).toMatchObject({ implicitLegacyKept: true, wouldChange: false });
    expect(legacy.body.current).toMatchObject({ planVersionId: null, legacyReference: true });
    const n = (await setPlanAudit(c4)).length;
    const kept = await setPlanOf(c4, { plan: "free" });
    expect(kept.status, kept.text).toBe(200);
    expect((await subRow(c4)).planVersionId).toBeNull();
    expect((await setPlanAudit(c4)).length).toBe(n);
    // An explicit version pins it (owner decision), audited as a direct change from the legacy reference.
    const pinned = await setPlanOf(c4, { plan: "free", planVersionId: freeV1 });
    expect(pinned.status, pinned.text).toBe(200);
    expect((await subRow(c4)).planVersionId).toBe(freeV1);
    const m = (await setPlanAudit(c4)).pop()!.metadata as Record<string, any>;
    expect(m).toMatchObject({ previousPlanVersionId: null, planVersionId: freeV1, explicitVersion: true });
  });

  it("a provider-managed subscription is never changed by the manual operation", async () => {
    const res = await setPlanOf(c2, { plan: PLAN, planVersionId: v1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MANAGED_BY_PROVIDER");
    expect((await subRow(c2))).toMatchObject({ plan: "free", billingSource: "stripe" });
    const preview = (await previewOf(c2, { plan: PLAN, planVersionId: v1 })).body;
    expect(preview.transition).toEqual({ ok: false, code: "MANAGED_BY_PROVIDER" });
    expect(preview.eligible).toBe(false);
  });

  it("concurrent changes serialize on the row: both succeed and the final state matches the last audited change", async () => {
    const [a, b] = await Promise.all([setPlanOf(c3, { plan: PLAN, planVersionId: v2, confirmFeatureDowngrade: true }), setPlanOf(c3, { plan: PLAN, planVersionId: v1 })]);
    expect([a.status, b.status], `${a.text} ${b.text}`).toEqual([200, 200]);
    const row = await subRow(c3);
    expect([v1, v2]).toContain(row.planVersionId);
    const rows = await setPlanAudit(c3);
    const last = rows[rows.length - 1].metadata as Record<string, any>;
    expect(last.after.planVersionId).toBe(row.planVersionId);
    for (let i = 1; i < rows.length; i++) expect((rows[i].metadata as any).before.planVersionId).toBe((rows[i - 1].metadata as any).after.planVersionId);
  });

  it("a failed post-change verification rolls the whole change back (row unchanged, no audit row)", async () => {
    const before = await subRow(c3);
    const target = before.planVersionId === v1 ? v2 : v1;
    const n = (await setPlanAudit(c3)).length;
    __setBillingFaultsForTests({
      "planChange.beforeVerify": async () => {
        throw new AppError(500, "Plan change verification failed; the change was rolled back", { code: "PLAN_CHANGE_VERIFICATION_FAILED", details: { reason: "test-fault" } });
      },
    });
    try {
      await expect(setPlan(c3, { userId: adminId, userName: "test:b42", ipAddress: null }, { plan: PLAN, planVersionId: target, confirmFeatureDowngrade: true })).rejects.toMatchObject({ code: "PLAN_CHANGE_VERIFICATION_FAILED" });
    } finally {
      __setBillingFaultsForTests({});
    }
    const after = await subRow(c3);
    expect(after.planVersionId).toBe(before.planVersionId);
    expect(after.plan).toBe(before.plan);
    expect((await setPlanAudit(c3)).length).toBe(n);
    // Without the fault the same change applies and verifies.
    const ok = await setPlanOf(c3, { plan: PLAN, planVersionId: target, confirmFeatureDowngrade: true });
    expect(ok.status, ok.text).toBe(200);
    expect((await subRow(c3)).planVersionId).toBe(target);
  });

  it("a retired version stays assignable as the owner's explicit choice; the implicit target is the current published version", async () => {
    expect((await setPlanOf(c1, { plan: PLAN, planVersionId: v2, confirmFeatureDowngrade: true })).status).toBe(200);
    const retired = await api("POST", `/platform/plans/${PLAN}/versions/${v1}/retire`, platformToken);
    expect(retired.status, retired.text).toBe(200);
    const explicit = await setPlanOf(c1, { plan: PLAN, planVersionId: v1, reason: "revert" });
    expect(explicit.status, explicit.text).toBe(200);
    expect(explicit.body.planVersionId).toBe(v1);
    expect(((await setPlanAudit(c1)).pop()!.metadata as any).targetVersionState).toBe("retired");
    const implicit = await setPlanOf(c1, { plan: PLAN, confirmFeatureDowngrade: true });
    expect(implicit.status, implicit.text).toBe(200);
    expect(implicit.body.planVersionId).toBe(v2);
    expect(((await setPlanAudit(c1)).pop()!.metadata as any)).toMatchObject({ explicitVersion: false, targetVersionState: "published" });
  });

  it("only the platform owner can change or preview a plan", async () => {
    expect((await setPlanOf(c1, { plan: PLAN, planVersionId: v1 }, c1Token)).status).toBe(403);
    expect((await previewOf(c1, { plan: PLAN, planVersionId: v1 }, c1Token)).status).toBe(403);
    expect((await setPlanOf(c1, { plan: PLAN, planVersionId: v1 }, null)).status).toBe(401);
    expect((await previewOf(c1, { plan: PLAN, planVersionId: v1 }, null)).status).toBe(401);
    expect((await subRow(c1)).planVersionId).toBe(v2);
  });
});
