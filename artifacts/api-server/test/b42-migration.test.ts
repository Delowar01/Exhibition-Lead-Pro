import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, companiesTable, usersTable, contactsTable, subscriptionsTable, auditLogsTable, plansTable, planVersionsTable } from "@workspace/db";
import { runVersionBackfill } from "../src/lib/billing/version-backfill.js";
import { migrateTenants } from "../src/services/plan-migration.service.js";
import { __setBillingFaultsForTests } from "../src/lib/billing/test-faults.js";
import { AppError } from "../src/middlewares/errorHandler.js";

// Batch 42 (PB-4.5) — safe tenant migration between PUBLISHED versions against
// the LIVE API: scoped selection (source version and / or explicit companies),
// the read-only dry run with per-tenant reasons and a verifiable digest,
// execution bound to the reviewed dry run (stale → 409, duplicate → no second
// migration), per-tenant transactions with recheck + verification (rollback
// proven in-process), accurate migrated / skipped / failed / rolled-back
// reporting, per-tenant + summary audit rows, provider-managed exclusion (D4).

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b42mig-${SUFFIX}.test`;
const PLAN = `b42m-${SUFFIX}`;
const FEATURES = ["ai.assistant", "ai.command_center", "workflow.intelligence", "executive.intelligence", "exports.scheduled", "nfc.capture", "documents", "api.access"] as const;

let platformToken = "";
let cToken = "";
let adminId = 0;
let A = 0; // v1 manual
let B = 0; // v1 manual
let C = 0; // v1 manual, 3 contacts (blocked by v2's contacts limit until an override lifts it)
let D = 0; // v1 provider-managed
let E = 0; // free (not on the source)
let F = 0; // already on v2
let v1 = 0;
let v2 = 0;
let v3 = 0; // draft
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
const migrate = (versionId: number, body: unknown, token: string | null = platformToken, plan = PLAN) => api("POST", `/platform/plans/${plan}/versions/${versionId}/migrate`, token, body);
const setPlanOf = (cid: number, body: unknown) => api("POST", `/platform/subscriptions/${cid}/plan`, platformToken, body);
async function subRow(cid: number) {
  const [row] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, cid));
  return row;
}
async function migrationAudit(cid: number) {
  return db.select().from(auditLogsTable).where(and(eq(auditLogsTable.companyId, cid), eq(auditLogsTable.action, "subscription.migrate_version"))).orderBy(auditLogsTable.id);
}
async function summaryAudit() {
  return db.select().from(auditLogsTable).where(and(eq(auditLogsTable.action, "plan_version.migrate"), eq(auditLogsTable.entityId, String(v2))));
}
async function createCompany(name: string) {
  const res = await api("POST", "/companies", platformToken, { name, plan: "free" });
  expect(res.status, res.text).toBe(201);
  companyIds.push(res.body.id);
  return res.body.id as number;
}
const rowOf = (res: { body: any }, cid: number) => res.body.rows.find((r: any) => r.companyId === cid);

beforeAll(async () => {
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  adminId = (await fetch(`${BASE}/auth/login`, { method: "POST", headers: headers(null), body: JSON.stringify(PLATFORM) }).then((r) => r.json())).user.id;
  expect((await runVersionBackfill({ apply: true })).verdict).toBe("APPLIED");
  freeV1 = (await api("GET", "/platform/plans/free", platformToken)).body.currentVersion.id;
  const created = await api("POST", "/platform/plans", platformToken, { id: PLAN, name: `Migrate ${SUFFIX}`, limits: {}, features: {} });
  expect(created.status, created.text).toBe(201);
  v1 = created.body.draft.id;
  expect((await api("POST", `/platform/plans/${PLAN}/versions/${v1}/publish`, platformToken)).status).toBe(200);
  const d2 = await api("POST", `/platform/plans/${PLAN}/versions`, platformToken, { sourceVersionId: v1 });
  v2 = d2.body.id;
  const matrix = Object.fromEntries(FEATURES.map((k) => [k, k !== "documents"]));
  expect((await api("PATCH", `/platform/plans/${PLAN}/versions/${v2}`, platformToken, { limits: { contacts: 2 }, features: matrix, featureEnforcement: "enforced" })).status).toBe(200);
  expect((await api("POST", `/platform/plans/${PLAN}/versions/${v2}/publish`, platformToken)).status).toBe(200);
  v3 = (await api("POST", `/platform/plans/${PLAN}/versions`, platformToken, { sourceVersionId: v2 })).body.id;
  A = await createCompany(`QA B42 Mig A ${SUFFIX}`);
  B = await createCompany(`QA B42 Mig B ${SUFFIX}`);
  C = await createCompany(`QA B42 Mig C ${SUFFIX}`);
  D = await createCompany(`QA B42 Mig D ${SUFFIX}`);
  E = await createCompany(`QA B42 Mig E ${SUFFIX}`);
  F = await createCompany(`QA B42 Mig F ${SUFFIX}`);
  for (const cid of [A, B, C, D]) expect((await setPlanOf(cid, { plan: PLAN, planVersionId: v1 })).status).toBe(200);
  expect((await setPlanOf(F, { plan: PLAN, planVersionId: v2, confirmFeatureDowngrade: true })).status).toBe(200);
  const user = await api("POST", "/users", platformToken, { email: `cadmin@${DOMAIN}`, name: "cadmin", role: "primary_admin", companyId: C, password: PW });
  expect(user.status, user.text).toBe(201);
  cToken = await login(`cadmin@${DOMAIN}`);
  for (let i = 0; i < 3; i++) expect((await api("POST", "/contacts", cToken, { firstName: `Lead${i}`, lastName: `B42M-${SUFFIX}`, email: `mlead${i}-${SUFFIX}@example.test` })).status).toBe(201);
  await db.update(subscriptionsTable).set({ billingSource: "stripe", stripeSubscriptionId: `sub_fake_b42mig_${SUFFIX}` }).where(eq(subscriptionsTable.companyId, D));
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
  const versionIds = [v1, v2, v3].filter(Boolean).map(String);
  if (versionIds.length) await db.delete(auditLogsTable).where(and(eq(auditLogsTable.entityType, "plan_version"), inArray(auditLogsTable.entityId, versionIds)));
  await db.delete(planVersionsTable).where(eq(planVersionsTable.planId, PLAN));
  await db.delete(plansTable).where(eq(plansTable.id, PLAN));
});

describe("input, target and source validation", () => {
  it("every malformed or unsafe request is refused before anything is evaluated", async () => {
    expect((await migrate(v2, { sourceVersionId: v1 })).status).toBe(400); // dryRun missing
    const scope = await migrate(v2, { dryRun: true });
    expect(scope.status).toBe(400);
    expect(scope.body.code).toBe("MIGRATION_SCOPE_REQUIRED");
    const noDigest = await migrate(v2, { dryRun: false, sourceVersionId: v1 });
    expect(noDigest.status).toBe(400);
    expect(noDigest.body.code).toBe("DRY_RUN_DIGEST_REQUIRED");
    expect((await migrate(v2, { dryRun: false, sourceVersionId: v1, confirmDigest: "abc" })).status).toBe(400);
    const badDigest = await migrate(v2, { dryRun: false, sourceVersionId: v1, confirmDigest: "g".repeat(64) });
    expect(badDigest.status).toBe(400);
    expect(badDigest.body.code).toBe("INVALID_DIGEST");
    expect((await migrate(v2, { dryRun: true, companyIds: [] })).status).toBe(400);
    expect((await migrate(v2, { dryRun: true, companyIds: Array.from({ length: 201 }, (_, i) => i + 1) })).status).toBe(400);
    const draftTarget = await migrate(v3, { dryRun: true, sourceVersionId: v1 });
    expect(draftTarget.status).toBe(409);
    expect(draftTarget.body.code).toBe("TARGET_NOT_PUBLISHED");
    const unknownVersion = await migrate(999999999, { dryRun: true, sourceVersionId: v1 });
    expect(unknownVersion.status).toBe(404);
    expect(unknownVersion.body.code).toBe("VERSION_NOT_FOUND");
    const foreignVersion = await migrate(freeV1, { dryRun: true, sourceVersionId: v1 });
    expect(foreignVersion.status).toBe(404);
    expect(foreignVersion.body.code).toBe("VERSION_NOT_FOUND");
    const unknownPlan = await migrate(v2, { dryRun: true, sourceVersionId: v1 }, platformToken, `nope-${SUFFIX}`);
    expect(unknownPlan.status).toBe(404);
    expect(unknownPlan.body.code).toBe("PLAN_NOT_FOUND");
    const draftSource = await migrate(v2, { dryRun: true, sourceVersionId: v3 });
    expect(draftSource.status).toBe(409);
    expect(draftSource.body.code).toBe("SOURCE_NOT_PUBLISHED");
    const same = await migrate(v2, { dryRun: true, sourceVersionId: v2 });
    expect(same.status).toBe(409);
    expect(same.body.code).toBe("SOURCE_EQUALS_TARGET");
    const noSource = await migrate(v2, { dryRun: true, sourceVersionId: 999999999 });
    expect(noSource.status).toBe(404);
    expect(noSource.body.code).toBe("SOURCE_VERSION_NOT_FOUND");
    // Nothing moved.
    for (const cid of [A, B, C, D]) expect((await subRow(cid)).planVersionId).toBe(v1);
  });

  it("only the platform owner can migrate", async () => {
    expect((await migrate(v2, { dryRun: true, sourceVersionId: v1 }, cToken)).status).toBe(403);
    expect((await migrate(v2, { dryRun: true, sourceVersionId: v1 }, null)).status).toBe(401);
  });
});

describe("dry run (read-only, deterministic digest)", () => {
  it("evaluates every tenant on the source version with its reason; provider-managed and blocked tenants are reported, never migrated", async () => {
    const res = await migrate(v2, { dryRun: true, sourceVersionId: v1 });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ planId: PLAN, dryRun: true, migrationId: null, complete: null, scope: "source_version", confirmFeatureDowngrade: false, target: { versionId: v2, version: 2 }, source: { versionId: v1, version: 1, planId: PLAN } });
    expect(res.body.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.rows.map((r: any) => r.companyId)).toEqual([A, B, C, D].sort((a, b) => a - b));
    expect(rowOf(res, A)).toMatchObject({ reason: "FEATURE_DOWNGRADE_CONFIRMATION_REQUIRED", lostFeatures: ["documents"], blocking: [], billingSource: "manual", currentPlan: PLAN, currentPlanVersionId: v1, currentVersion: 1, currentReferenceValid: true, outcome: "not_attempted", outcomeReason: null });
    expect(rowOf(res, C)).toMatchObject({ reason: "DOWNGRADE_BLOCKED", blocking: [{ resource: "contacts", used: 3, limit: 2 }], tightenedLimits: expect.arrayContaining(["contacts"]) });
    expect(rowOf(res, D)).toMatchObject({ reason: "PROVIDER_MANAGED", billingSource: "stripe" });
    expect(res.body.summary).toMatchObject({ total: 4, eligible: 0, migrated: 0, skipped: 0, failed: 0, rolledBack: 0, notAttempted: 4 });
    expect(res.body.summary.byReason).toMatchObject({ FEATURE_DOWNGRADE_CONFIRMATION_REQUIRED: 2, DOWNGRADE_BLOCKED: 1, PROVIDER_MANAGED: 1 });
    // Deterministic and write-free.
    const again = await migrate(v2, { dryRun: true, sourceVersionId: v1 });
    expect(again.body.digest).toBe(res.body.digest);
    for (const cid of [A, B, C, D]) expect((await subRow(cid)).planVersionId).toBe(v1);
    expect(await migrationAudit(A)).toHaveLength(0);
    expect(await summaryAudit()).toHaveLength(0);
    // With the D3 confirmation A and B become eligible (a different review = a different digest); C stays blocked.
    const confirmed = await migrate(v2, { dryRun: true, sourceVersionId: v1, confirmFeatureDowngrade: true });
    expect(confirmed.body.digest).not.toBe(res.body.digest);
    expect(rowOf(confirmed, A).reason).toBe("ELIGIBLE");
    expect(rowOf(confirmed, B).reason).toBe("ELIGIBLE");
    expect(rowOf(confirmed, C).reason).toBe("DOWNGRADE_BLOCKED");
    expect(rowOf(confirmed, D).reason).toBe("PROVIDER_MANAGED");
    expect(confirmed.body.summary.eligible).toBe(2);
  });

  it("an explicit company scope reports not-on-source, already-on-target and missing tenants exactly", async () => {
    const res = await migrate(v2, { dryRun: true, sourceVersionId: v1, companyIds: [A, E, F, 999999999, A], confirmFeatureDowngrade: true });
    expect(res.status, res.text).toBe(200);
    expect(res.body.scope).toBe("companies");
    expect(res.body.rows.map((r: any) => r.companyId)).toEqual([A, E, F, 999999999].sort((a, b) => a - b));
    expect(rowOf(res, A).reason).toBe("ELIGIBLE");
    expect(rowOf(res, E)).toMatchObject({ reason: "NOT_ON_SOURCE_VERSION", currentPlan: "free" });
    expect(rowOf(res, F)).toMatchObject({ reason: "ALREADY_ON_VERSION", currentPlanVersionId: v2 });
    expect(rowOf(res, 999999999)).toMatchObject({ reason: "SUBSCRIPTION_MISSING", currentPlan: null, billingSource: null });
    expect(res.body.summary.total).toBe(4);
  });
});

describe("execution bound to the reviewed dry run", () => {
  it("a stale digest (data changed since the review) is refused with the fresh review; nothing is migrated", async () => {
    const review = await migrate(v2, { dryRun: true, companyIds: [A, B], confirmFeatureDowngrade: true });
    expect(review.body.summary.eligible).toBe(2);
    // A changes under the owner's feet (direct change to v2).
    expect((await setPlanOf(A, { plan: PLAN, planVersionId: v2, confirmFeatureDowngrade: true })).status).toBe(200);
    const stale = await migrate(v2, { dryRun: false, companyIds: [A, B], confirmFeatureDowngrade: true, confirmDigest: review.body.digest });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("DRY_RUN_STALE");
    const ctx = stale.body.context ?? stale.body.details;
    expect(ctx.expectedDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(ctx.expectedDigest).not.toBe(review.body.digest);
    expect(ctx.rows.find((r: any) => r.companyId === A).reason).toBe("ALREADY_ON_VERSION");
    expect((await subRow(B)).planVersionId).toBe(v1);
    expect(await migrationAudit(B)).toHaveLength(0);
    // Put A back on v1 for the next steps.
    expect((await setPlanOf(A, { plan: PLAN, planVersionId: v1 })).status).toBe(200);
  });

  it("a confirmation that matches the current dry run migrates each tenant in its own transaction; a duplicate execution never migrates twice", async () => {
    const review = await migrate(v2, { dryRun: true, companyIds: [A, B], confirmFeatureDowngrade: true, reason: "Batch upgrade" });
    expect(review.body.summary.eligible).toBe(2);
    const body = { dryRun: false, companyIds: [A, B], confirmFeatureDowngrade: true, confirmDigest: review.body.digest, reason: "Batch upgrade" };
    const [r1, r2] = await Promise.all([migrate(v2, body), migrate(v2, body)]);
    const ok = [r1, r2].filter((r) => r.status === 200);
    const refused = [r1, r2].filter((r) => r.status === 409);
    expect(ok.length, `${r1.text}\n${r2.text}`).toBeGreaterThanOrEqual(1);
    for (const r of refused) expect(r.body.code).toBe("DRY_RUN_STALE");
    const migrated = ok.reduce((n, r) => n + r.body.summary.migrated, 0);
    expect(migrated).toBe(2);
    for (const r of ok) {
      expect(r.body.dryRun).toBe(false);
      expect(r.body.migrationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.body.digest).toBe(review.body.digest);
      expect(r.body.summary.failed + r.body.summary.rolledBack).toBe(0);
      expect(r.body.complete).toBe(true);
      for (const row of r.body.rows) {
        expect(["migrated", "skipped"]).toContain(row.outcome);
        if (row.outcome === "skipped") expect(row.outcomeReason).toBe("CHANGED_SINCE_DRY_RUN");
      }
    }
    for (const cid of [A, B]) {
      expect((await subRow(cid)).planVersionId).toBe(v2);
      const rows = await migrationAudit(cid);
      expect(rows).toHaveLength(1);
      const m = rows[0].metadata as Record<string, any>;
      expect(rows[0].userId).toBe(adminId);
      expect(m).toMatchObject({ planChangeSource: "migration", sourceVersionId: null, dryRunDigest: review.body.digest, reason: "Batch upgrade", confirmFeatureDowngrade: true, changeKind: "version_change", previousPlanVersionId: v1, planVersionId: v2, lostFeatures: ["documents"], featureEnforcementAfter: "enforced" });
      expect(m.migrationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(m.before.planVersionId).toBe(v1);
      expect(m.after.planVersionId).toBe(v2);
      expect(m.changed).toContain("planVersionId");
    }
    const summaries = await summaryAudit();
    expect(summaries).toHaveLength(ok.length);
    const s = summaries.find((x) => (x.metadata as any).summary.migrated > 0)!.metadata as Record<string, any>;
    expect(s).toMatchObject({ planId: PLAN, targetVersionId: v2, dryRunDigest: review.body.digest, scope: "companies", reason: "Batch upgrade", confirmFeatureDowngrade: true, complete: true });
    expect(s.companies.map((c: any) => c.companyId).sort()).toEqual([A, B].sort());
    // A later execution with the consumed digest is stale (the migrated rows changed the review).
    const replay = await migrate(v2, body);
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("DRY_RUN_STALE");
    expect(await migrationAudit(A)).toHaveLength(1);
  });

  it("a scope without an eligible tenant cannot be executed (NOTHING_TO_MIGRATE)", async () => {
    const review = await migrate(v2, { dryRun: true, companyIds: [D, F] });
    expect(review.body.summary.eligible).toBe(0);
    const res = await migrate(v2, { dryRun: false, companyIds: [D, F], confirmDigest: review.body.digest });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOTHING_TO_MIGRATE");
    expect((await subRow(D))).toMatchObject({ planVersionId: v1, billingSource: "stripe" });
  });

  it("a failed post-change verification rolls that tenant back and is reported as rolled_back (never a silent partial success)", async () => {
    expect((await api("PUT", `/platform/subscriptions/${C}/limits`, platformToken, { limits: { contacts: 10 } })).status).toBe(200);
    const review = await migrate(v2, { dryRun: true, companyIds: [C], confirmFeatureDowngrade: true });
    expect(rowOf(review, C).reason).toBe("ELIGIBLE");
    const summariesBefore = (await summaryAudit()).length;
    __setBillingFaultsForTests({
      "planChange.beforeVerify": async () => {
        throw new AppError(500, "Plan change verification failed; the change was rolled back", { code: "PLAN_CHANGE_VERIFICATION_FAILED", details: { reason: "test-fault" } });
      },
    });
    let result: any;
    try {
      result = await migrateTenants({ userId: adminId, userName: "test:b42", ipAddress: null }, PLAN, v2, { dryRun: false, companyIds: [C], confirmFeatureDowngrade: true, confirmDigest: review.body.digest });
    } finally {
      __setBillingFaultsForTests({});
    }
    expect(result.rows[0]).toMatchObject({ companyId: C, outcome: "rolled_back", outcomeReason: "PLAN_CHANGE_VERIFICATION_FAILED" });
    expect(result.summary).toMatchObject({ migrated: 0, rolledBack: 1, failed: 0, skipped: 0 });
    expect(result.complete).toBe(false);
    expect((await subRow(C)).planVersionId).toBe(v1);
    expect(await migrationAudit(C)).toHaveLength(0);
    const summaries = await summaryAudit();
    expect(summaries).toHaveLength(summariesBefore + 1);
    expect((summaries[summaries.length - 1].metadata as any)).toMatchObject({ complete: false, companies: [{ companyId: C, reason: "ELIGIBLE", outcome: "rolled_back", outcomeReason: "PLAN_CHANGE_VERIFICATION_FAILED" }] });
    // Without the fault the same reviewed migration succeeds.
    const fresh = await migrate(v2, { dryRun: true, companyIds: [C], confirmFeatureDowngrade: true });
    const done = await migrate(v2, { dryRun: false, companyIds: [C], confirmFeatureDowngrade: true, confirmDigest: fresh.body.digest });
    expect(done.status, done.text).toBe(200);
    expect(done.body.summary.migrated).toBe(1);
    expect((await subRow(C))).toMatchObject({ planVersionId: v2, limitOverrides: { contacts: 10 } });
    expect((await api("GET", "/subscriptions/current", cToken)).body.entitlements.features.documents).toBe(false);
  });

  it("a retired version is never a migration target (the per-tenant change stays the explicit path)", async () => {
    expect((await api("POST", `/platform/plans/${PLAN}/versions/${v1}/retire`, platformToken)).status).toBe(200);
    const res = await migrate(v1, { dryRun: true, sourceVersionId: v2 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TARGET_RETIRED");
  });
});
