import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, like, sql } from "drizzle-orm";
import { db, companiesTable, usersTable, contactsTable, scansTable, auditLogsTable, plansTable, planVersionsTable, subscriptionsTable, loginAttemptsTable } from "@workspace/db";
import { runVersionBackfill } from "../src/lib/billing/version-backfill.js";

// Release sequence proof (owner decision 2): the corrected application is
// deployed BEFORE the version-1 backfill, so for a while every existing
// subscriber carries a NULL plan_version_id — the legacy reference to the plan
// row. This file proves, against the LIVE API:
//
//   • a tenant on a plan WITHOUT any version (exactly the production state
//     between the schema step and the backfill) signs in, keeps every feature
//     and its plan-row limits, and is refused nothing by the new gates;
//   • the version-1 backfill then pins it WITHOUT changing a single effective
//     entitlement (features, enforcement, limits, trial policy, AI budgets,
//     access mode) — the only difference is the version reference itself;
//   • running the backfill again changes nothing;
//   • while a subscriber is unpinned, neither publish NOR retire may re-mirror
//     the plan row underneath it (release correction: retire guard).

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b44leg-${SUFFIX}.test`;
const LEGACY = `b44-legacy-${SUFFIX}`; // a published plan row with NO version (pre-backfill shape)
const TWOVER = `b44-twover-${SUFFIX}`; // builder plan with two published versions (retire guard)
const FEATURES = ["ai.assistant", "ai.command_center", "workflow.intelligence", "executive.intelligence", "exports.scheduled", "nfc.capture", "documents", "api.access"] as const;
const PLAN_LIMITS = { adminsLimit: 2, employeesLimit: 5, contactsLimit: 25, eventsLimit: 3, scansLimit: 40, storageLimitMb: null };

let platformToken = "";
let token = "";
let companyX = 0;
let companyY = 0;
const companyIds: number[] = [];
let before: Record<string, unknown> = {};
let twoV1 = 0;
let twoV2 = 0;

function headers(t: string | null) {
  return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}
async function loginFull(email: string, password = PW) {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: headers(null), body: JSON.stringify({ email, password }) });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, any>, text };
}
async function api(method: string, path: string, t: string | null, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: headers(t), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed as Record<string, any>, text };
}
const subRow = async (cid: number) => (await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, cid)))[0];
async function createCompany(name: string, plan: string) {
  const res = await api("POST", "/companies", platformToken, { name, plan });
  expect(res.status, res.text).toBe(201);
  companyIds.push(res.body.id);
  await db.update(companiesTable).set({ status: "active" }).where(eq(companiesTable.id, res.body.id));
  return res.body.id as number;
}

// Everything that decides what the tenant may do, WITHOUT the version reference itself.
async function effectiveEntitlements(t: string) {
  const me = (await api("GET", "/auth/me", t)).body;
  const current = (await api("GET", "/subscriptions/current", t)).body;
  const usage = (await api("GET", "/subscriptions/usage", t)).body;
  const ai = (await api("GET", "/ai/settings", t)).body;
  const suggestions = (await api("GET", "/ai/assistant/suggestions", t)).body;
  return {
    role: me.role,
    permissions: me.permissions,
    featureEnforcement: me.entitlements.featureEnforcement,
    features: me.entitlements.features,
    trialPolicy: me.entitlements.trialPolicy,
    plan: current.plan,
    status: current.status,
    accessMode: current.accessMode,
    accessReasonCode: current.accessReasonCode,
    billingSource: current.billingSource,
    limits: current.limits,
    subscriptionEntitlements: { featureEnforcement: current.entitlements?.featureEnforcement, features: current.entitlements?.features },
    usageLimits: (usage.resources as Array<Record<string, unknown>>).map((r) => ({ resource: r.resource, limit: r.limit, source: r.source, enforced: r.enforced })),
    ai: { monthlyTokenBudget: ai.monthlyTokenBudget, monthlyCostBudgetUsd: ai.monthlyCostBudgetUsd, budgetSource: ai.budgetSource, allowance: { aiTokensPerMonth: ai.planAllowance.aiTokensPerMonth, aiCostBudgetUsd: ai.planAllowance.aiCostBudgetUsd } },
    assistantModules: suggestions.modules,
  };
}

beforeAll(async () => {
  platformToken = (await loginFull(PLATFORM.email, PLATFORM.password)).body.token;
  expect((await runVersionBackfill({ apply: true })).verdict).toBe("APPLIED");
  // A published plan row with NO version: the shape every catalog plan has in
  // production after the additive schema step and before the backfill.
  await db.insert(plansTable).values({ id: LEGACY, name: `Legacy ${SUFFIX}`, sortOrder: 900, trialDays: 14, isActive: true, status: "published", ...PLAN_LIMITS });
  companyX = await createCompany(`QA B44 Legacy ${SUFFIX}`, LEGACY);
  const user = await api("POST", "/users", platformToken, { email: `x-admin@${DOMAIN}`, name: "x-admin", role: "primary_admin", companyId: companyX, password: PW });
  expect(user.status, user.text).toBe(201);
});

afterAll(async () => {
  const quiet = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      /* best-effort teardown on a disposable database */
    }
  };
  if (companyIds.length) {
    await quiet(() => db.delete(scansTable).where(inArray(scansTable.companyId, companyIds)));
    await quiet(() => db.delete(contactsTable).where(inArray(contactsTable.companyId, companyIds)));
    await quiet(() => db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds)));
    await quiet(() => db.delete(usersTable).where(inArray(usersTable.companyId, companyIds)));
    await quiet(() => db.delete(companiesTable).where(inArray(companiesTable.id, companyIds)));
  }
  await quiet(() => db.delete(loginAttemptsTable).where(like(loginAttemptsTable.email, `%@${DOMAIN}`)));
  await quiet(() => db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`)));
  await quiet(() => db.delete(planVersionsTable).where(inArray(planVersionsTable.planId, [LEGACY, TWOVER])));
  await quiet(() => db.delete(plansTable).where(inArray(plansTable.id, [LEGACY, TWOVER])));
});

describe("a tenant with a NULL version reference (deployed before the backfill)", () => {
  it("is assigned to the versionless plan as a legacy reference (no version is invented)", async () => {
    expect(await subRow(companyX)).toMatchObject({ plan: LEGACY, planVersionId: null });
    expect(await db.select().from(planVersionsTable).where(eq(planVersionsTable.planId, LEGACY))).toHaveLength(0);
  });

  it("signs in: the login answers 200 with a token and legacy entitlements — every feature allowed", async () => {
    const res = await loginFull(`x-admin@${DOMAIN}`);
    expect(res.status, res.text).toBe(200);
    expect(typeof res.body.token).toBe("string");
    token = res.body.token;
    expect(res.body.user.entitlements).toMatchObject({ planVersionId: null, featureEnforcement: "legacy" });
    for (const k of FEATURES) expect(res.body.user.entitlements.features[k], k).toBe(true);
    const me = await api("GET", "/auth/me", token);
    expect(me.status).toBe(200);
    expect(me.body.entitlements).toEqual(res.body.user.entitlements);
  });

  it("keeps the plan row's limits and full access", async () => {
    const current = (await api("GET", "/subscriptions/current", token)).body;
    expect(current).toMatchObject({ plan: LEGACY, planVersionId: null, accessMode: "full" });
    const usage = (await api("GET", "/subscriptions/usage", token)).body;
    const limitOf = (r: string) => (usage.resources as Array<Record<string, any>>).find((x) => x.resource === r)!;
    expect(limitOf("contacts")).toMatchObject({ limit: 25, source: "plan" });
    expect(limitOf("events")).toMatchObject({ limit: 3, source: "plan" });
    expect(limitOf("admins")).toMatchObject({ limit: 2, source: "plan" });
    expect(limitOf("employees")).toMatchObject({ limit: 5, source: "plan" });
    expect(limitOf("scans")).toMatchObject({ limit: 40, source: "plan" });
  });

  it("is refused nothing by the plan-feature gates, old or new (documents, organization documents, NFC contact, assistant intents, AI budget)", async () => {
    for (const path of ["/documents", "/ai/workflow/overview", "/ai/executive/dashboard", "/ai/assistant/conversations", "/ai/assistant/suggestions", "/exports/schedules"]) {
      const res = await api("GET", path, token);
      expect(res.status, `${path}: ${res.text}`).toBe(200);
    }
    const org = await api("POST", "/organizations", token, { name: `Legacy Org ${SUFFIX}` });
    expect(org.status, org.text).toBe(201);
    expect((await api("GET", `/organizations/${org.body.id}/documents`, token)).status).toBe(200);
    const nfc = await api("POST", "/contacts", token, { firstName: "Legacy", lastName: `Nfc ${SUFFIX}`, source: "nfc" });
    expect(nfc.status, nfc.text).toBe(201);
    const scan = await api("POST", "/scans", token, { imageData: "not-an-image", captureSource: "nfc" });
    expect(scan.status).toBe(400); // payload validation, not an entitlement denial
    expect(scan.body.code).not.toBe("FEATURE_NOT_ENTITLED");
    const conv = await api("POST", "/ai/assistant/conversations", token, {});
    const msg = await api("POST", `/ai/assistant/conversations/${conv.body.id}/messages`, token, { content: "What are my priorities today?" });
    expect(msg.status, msg.text).toBe(200);
    expect(msg.body.assistantMessage.data.featureDenied).toBeUndefined();
    const ai = (await api("GET", "/ai/settings", token)).body;
    expect(ai.budgetSource).toEqual({ tokens: "none", cost: "none" });
    expect(ai.planAllowance).toEqual({ planVersionId: null, aiTokensPerMonth: null, aiCostBudgetUsd: null });
    const own = await api("PATCH", "/ai/settings", token, { monthlyTokenBudget: 1_000_000_000 });
    expect(own.status, own.text).toBe(200); // no allowance → no cap
    expect((await api("PATCH", "/ai/settings", token, { monthlyTokenBudget: null })).status).toBe(200);
  });

  it("the Platform Owner reads and manages the unpinned tenant (detail, limit override) exactly as before", async () => {
    const detail = await api("GET", `/platform/subscriptions/${companyX}`, platformToken);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.body.planVersionId ?? null).toBeNull();
    const override = await api("PUT", `/platform/subscriptions/${companyX}/limits`, platformToken, { limits: { contacts: 30 } });
    expect(override.status, override.text).toBe(200);
    const usage = (await api("GET", "/subscriptions/usage", token)).body;
    expect((usage.resources as Array<Record<string, any>>).find((x) => x.resource === "contacts")).toMatchObject({ limit: 30, source: "override" });
  });
});

describe("the version-1 backfill produces identical effective entitlements", () => {
  it("captures the tenant's effective entitlements while unpinned", async () => {
    before = await effectiveEntitlements(token);
    expect(before.featureEnforcement).toBe("legacy");
    expect(Object.values(before.features as Record<string, boolean>).every((v) => v === true)).toBe(true);
  });

  it("a dry run reports the pin without writing anything", async () => {
    const report = await runVersionBackfill({ apply: false });
    expect(report.verdict).toBe("DRY_RUN_OK");
    expect(await subRow(companyX)).toMatchObject({ plan: LEGACY, planVersionId: null });
    expect(await db.select().from(planVersionsTable).where(eq(planVersionsTable.planId, LEGACY))).toHaveLength(0);
  });

  it("applying it creates version 1 from the plan row and pins the subscriber", async () => {
    const report = await runVersionBackfill({ apply: true });
    expect(report.verdict, JSON.stringify({ reason: report.reason, integrity: report.integrityErrors })).toBe("APPLIED");
    const versions = await db.select().from(planVersionsTable).where(eq(planVersionsTable.planId, LEGACY));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, planId: LEGACY });
    expect(versions[0].publishedAt).not.toBeNull();
    expect(versions[0].snapshot.featureEnforcement).toBeUndefined(); // a version-1 snapshot is legacy by construction
    expect(await subRow(companyX)).toMatchObject({ plan: LEGACY, planVersionId: versions[0].id });
  });

  it("the tenant's effective entitlements are IDENTICAL — only the version reference changed", async () => {
    const after = await effectiveEntitlements(token);
    expect(after).toEqual(before);
    const me = (await api("GET", "/auth/me", token)).body;
    const [v] = await db.select().from(planVersionsTable).where(eq(planVersionsTable.planId, LEGACY));
    expect(me.entitlements.planVersionId).toBe(v.id);
    // The session issued BEFORE the backfill keeps working; a fresh login works too.
    expect((await loginFull(`x-admin@${DOMAIN}`)).status).toBe(200);
    // The per-tenant override set before the backfill survived it.
    const usage = (await api("GET", "/subscriptions/usage", token)).body;
    expect((usage.resources as Array<Record<string, any>>).find((x) => x.resource === "contacts")).toMatchObject({ limit: 30, source: "override" });
  });

  it("running the backfill again is a no-op for the tenant", async () => {
    const report = await runVersionBackfill({ apply: true });
    expect(report.verdict).toBe("APPLIED");
    expect(await db.select().from(planVersionsTable).where(eq(planVersionsTable.planId, LEGACY))).toHaveLength(1);
    expect(await effectiveEntitlements(token)).toEqual(before);
  });

  it("pin integrity: no subscription references a version of another plan, and none is left unpinned", async () => {
    const mismatched = await db.execute(sql`select count(*)::int as n from subscriptions s join plan_versions v on v.id = s.plan_version_id where v.plan_id <> s.plan`);
    expect(Number((mismatched.rows[0] as { n: number }).n)).toBe(0);
    const unpublished = await db.execute(sql`select count(*)::int as n from subscriptions s join plan_versions v on v.id = s.plan_version_id where v.published_at is null`);
    expect(Number((unpublished.rows[0] as { n: number }).n)).toBe(0);
    const unpinned = await db.execute(sql`select count(*)::int as n from subscriptions where plan_version_id is null`);
    expect(Number((unpinned.rows[0] as { n: number }).n)).toBe(0);
  });
});

describe("retire guard — an unpinned subscriber's plan row is never re-mirrored underneath it", () => {
  beforeAll(async () => {
    const created = await api("POST", "/platform/plans", platformToken, { id: TWOVER, name: `Two ${SUFFIX}`, limits: { contacts: 10, events: null, admins: null, employees: null, scans: null, storageMb: null }, features: {} });
    expect(created.status, created.text).toBe(201);
    twoV1 = created.body.draft.id;
    expect((await api("POST", `/platform/plans/${TWOVER}/versions/${twoV1}/publish`, platformToken)).status).toBe(200);
    const draft = await api("POST", `/platform/plans/${TWOVER}/versions`, platformToken, { sourceVersionId: twoV1 });
    expect(draft.status, draft.text).toBe(201);
    twoV2 = draft.body.id;
    const edited = await api("PATCH", `/platform/plans/${TWOVER}/versions/${twoV2}`, platformToken, { limits: { contacts: 99, events: null, admins: null, employees: null, scans: null, storageMb: null } });
    expect(edited.status, edited.text).toBe(200);
    expect((await api("POST", `/platform/plans/${TWOVER}/versions/${twoV2}/publish`, platformToken)).status).toBe(200);
    companyY = await createCompany(`QA B44 Retire ${SUFFIX}`, TWOVER);
    expect((await subRow(companyY)).planVersionId).toBe(twoV2);
    // The legacy reference a subscriber carries before the backfill (or after an
    // older build re-assigned it): NULL → limits resolve from the plan row.
    await db.update(subscriptionsTable).set({ planVersionId: null }).where(eq(subscriptionsTable.companyId, companyY));
  });

  it("retiring a version is refused while a subscriber still references the plan row; the plan row is untouched", async () => {
    const [planBefore] = await db.select().from(plansTable).where(eq(plansTable.id, TWOVER));
    const res = await api("POST", `/platform/plans/${TWOVER}/versions/${twoV2}/retire`, platformToken);
    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe("UNPINNED_SUBSCRIBERS");
    expect(res.body.context).toEqual({ count: 1 });
    const [planAfter] = await db.select().from(plansTable).where(eq(plansTable.id, TWOVER));
    expect(planAfter.contactsLimit).toBe(planBefore.contactsLimit);
    expect(planAfter.contactsLimit).toBe(99);
    const [v2] = await db.select().from(planVersionsTable).where(eq(planVersionsTable.id, twoV2));
    expect(v2.retiredAt).toBeNull();
  });

  it("the platform subscription list filters by a Plan Builder slug (digits and hyphens are part of the slug)", async () => {
    const res = await api("GET", `/platform/subscriptions?plan=${TWOVER}&limit=100`, platformToken);
    expect(res.status, res.text).toBe(200);
    expect(res.body.total).toBe(1);
    expect((res.body.subscriptions as Array<{ companyId: number; plan: string }>).map((r) => [r.companyId, r.plan])).toEqual([[companyY, TWOVER]]);
    // a fixed catalog id keeps filtering as before
    const fixed = await api("GET", "/platform/subscriptions?plan=free&limit=100", platformToken);
    expect((fixed.body.subscriptions as Array<{ plan: string }>).every((r) => r.plan === "free")).toBe(true);
  });

  it("once the subscriber is pinned again the same retire succeeds and the subscriber keeps its version", async () => {
    await db.update(subscriptionsTable).set({ planVersionId: twoV2 }).where(eq(subscriptionsTable.companyId, companyY));
    const res = await api("POST", `/platform/plans/${TWOVER}/versions/${twoV2}/retire`, platformToken);
    expect(res.status, res.text).toBe(200);
    expect((await subRow(companyY)).planVersionId).toBe(twoV2);
  });
});
