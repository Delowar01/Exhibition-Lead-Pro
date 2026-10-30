import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, companiesTable, usersTable, subscriptionsTable, auditLogsTable, plansTable, planVersionsTable } from "@workspace/db";
import { runVersionBackfill } from "../src/lib/billing/version-backfill.js";

// Batch 42 (PB-4.6) — a tenant's plan / version history projected from the
// append-only audit trail against the LIVE API: original and current plan +
// version, every change with its timestamp, actor, reason, limit comparison,
// entitlement changes, billing source and migration / direct-change reference;
// platform_owner only; never another tenant's rows.

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b42hist-${SUFFIX}.test`;
const PLAN = `b42h-${SUFFIX}`;

let platformToken = "";
let xToken = "";
let adminId = 0;
let X = 0;
let Y = 0;
let Z = 0;
let v1 = 0;
let v2 = 0;
let freeV1 = 0;
let migrationId = "";
let digest = "";
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
const history = (cid: number | string, token: string | null = platformToken) => api("GET", `/platform/subscriptions/${cid}/plan-history`, token);
async function createCompany(name: string) {
  const res = await api("POST", "/companies", platformToken, { name, plan: "free" });
  expect(res.status, res.text).toBe(201);
  companyIds.push(res.body.id);
  return res.body.id as number;
}

beforeAll(async () => {
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  adminId = (await fetch(`${BASE}/auth/login`, { method: "POST", headers: headers(null), body: JSON.stringify(PLATFORM) }).then((r) => r.json())).user.id;
  expect((await runVersionBackfill({ apply: true })).verdict).toBe("APPLIED");
  freeV1 = (await api("GET", "/platform/plans/free", platformToken)).body.currentVersion.id;
  const created = await api("POST", "/platform/plans", platformToken, { id: PLAN, name: `History ${SUFFIX}`, limits: { contacts: 50 }, features: {} });
  expect(created.status, created.text).toBe(201);
  v1 = created.body.draft.id;
  expect((await api("POST", `/platform/plans/${PLAN}/versions/${v1}/publish`, platformToken)).status).toBe(200);
  const d2 = await api("POST", `/platform/plans/${PLAN}/versions`, platformToken, { sourceVersionId: v1 });
  v2 = d2.body.id;
  expect((await api("PATCH", `/platform/plans/${PLAN}/versions/${v2}`, platformToken, { limits: { contacts: 100 } })).status).toBe(200);
  expect((await api("POST", `/platform/plans/${PLAN}/versions/${v2}/publish`, platformToken)).status).toBe(200);
  X = await createCompany(`QA B42 Hist X ${SUFFIX}`);
  Y = await createCompany(`QA B42 Hist Y ${SUFFIX}`);
  Z = await createCompany(`QA B42 Hist Z ${SUFFIX}`);
  const user = await api("POST", "/users", platformToken, { email: `xadmin@${DOMAIN}`, name: "xadmin", role: "primary_admin", companyId: X, password: PW });
  expect(user.status, user.text).toBe(201);
  xToken = await login(`xadmin@${DOMAIN}`);
  // X: free → H v1 (reason) → H v2 → migrated back to v1.
  expect((await api("POST", `/platform/subscriptions/${X}/plan`, platformToken, { plan: PLAN, planVersionId: v1, reason: "Onboarding" })).status).toBe(200);
  expect((await api("POST", `/platform/subscriptions/${X}/plan`, platformToken, { plan: PLAN, planVersionId: v2 })).status).toBe(200);
  const review = await api("POST", `/platform/plans/${PLAN}/versions/${v1}/migrate`, platformToken, { dryRun: true, companyIds: [X], reason: "Rollback wave" });
  expect(review.status, review.text).toBe(200);
  digest = review.body.digest;
  const done = await api("POST", `/platform/plans/${PLAN}/versions/${v1}/migrate`, platformToken, { dryRun: false, companyIds: [X], confirmDigest: digest, reason: "Rollback wave" });
  expect(done.status, done.text).toBe(200);
  expect(done.body.summary.migrated).toBe(1);
  migrationId = done.body.migrationId;
  // Y: free → H v2 (another tenant).
  expect((await api("POST", `/platform/subscriptions/${Y}/plan`, platformToken, { plan: PLAN, planVersionId: v2 })).status).toBe(200);
  // Z: a legacy NULL reference pinned by the version-1 backfill.
  await db.update(subscriptionsTable).set({ planVersionId: null }).where(eq(subscriptionsTable.companyId, Z));
  expect((await runVersionBackfill({ apply: true })).verdict).toBe("APPLIED");
});

afterAll(async () => {
  if (companyIds.length) {
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds));
    await db.delete(usersTable).where(inArray(usersTable.companyId, companyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds));
  }
  await db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`));
  await db.delete(auditLogsTable).where(and(eq(auditLogsTable.entityType, "plan_version"), inArray(auditLogsTable.entityId, [String(v1), String(v2)])));
  await db.delete(planVersionsTable).where(eq(planVersionsTable.planId, PLAN));
  await db.delete(plansTable).where(eq(plansTable.id, PLAN));
});

describe("plan history projection", () => {
  it("lists the original and current plan + version and every change in order with actor, reason, limits, entitlements and references", async () => {
    const res = await history(X);
    expect(res.status, res.text).toBe(200);
    const h = res.body;
    expect(h).toMatchObject({ companyId: X, total: 4, truncated: false });
    expect(typeof h.companyName).toBe("string");
    expect(h.original).toMatchObject({ plan: "free", planVersionId: freeV1, version: 1 });
    expect(h.original.at).toBeTruthy();
    expect(h.current).toMatchObject({ plan: PLAN, planVersionId: v1, version: 1, versionState: "published", billingSource: "manual", status: "trialing" });
    const kinds = h.entries.map((e: any) => e.kind);
    expect(kinds).toEqual(["created", "direct_change", "version_change", "migration"]);
    const [created, direct, version, migration] = h.entries;
    expect(created).toMatchObject({ action: "subscription.create", toPlan: "free", toVersionId: freeV1, toVersion: 1, billingSource: "manual" });
    expect(direct).toMatchObject({ action: "subscription.set_plan", source: "direct_change", fromPlan: "free", fromVersionId: freeV1, toPlan: PLAN, toVersionId: v1, toVersion: 1, reason: "Onboarding", migrationId: null, dryRunDigest: null, confirmFeatureDowngrade: false, repairedInvalidReference: false });
    expect(direct.actor).toEqual({ userId: adminId, name: expect.any(String) });
    expect(direct.changedFields).toEqual(expect.arrayContaining(["plan", "planVersionId"]));
    expect(direct.limitsBefore).toHaveProperty("contacts");
    expect(direct.limitsAfter).toMatchObject({ contacts: 50 });
    expect(direct.changedLimits).toContain("contacts");
    expect(version).toMatchObject({ source: "direct_change", fromVersionId: v1, toVersionId: v2, toVersion: 2 });
    expect(version.limitsBefore.contacts).toBe(50);
    expect(version.limitsAfter.contacts).toBe(100);
    expect(version.loosenedLimits).toContain("contacts");
    expect(migration).toMatchObject({ action: "subscription.migrate_version", source: "migration", fromVersionId: v2, toVersionId: v1, migrationId, dryRunDigest: digest, reason: "Rollback wave", confirmFeatureDowngrade: false });
    expect(migration.tightenedLimits).toContain("contacts");
    for (const e of h.entries) {
      expect(typeof e.auditId).toBe("number");
      expect(new Date(e.at).toString()).not.toBe("Invalid Date");
      expect(e.lostFeatures).toEqual([]);
      expect(e.gainedFeatures).toEqual([]);
    }
    for (let i = 1; i < h.entries.length; i++) expect(new Date(h.entries[i].at).getTime()).toBeGreaterThanOrEqual(new Date(h.entries[i - 1].at).getTime());
  });

  it("never exposes another tenant's rows; the backfill pin appears as its own kind", async () => {
    const x = (await history(X)).body;
    const y = (await history(Y)).body;
    expect(y).toMatchObject({ companyId: Y, total: 2 });
    expect(y.entries.map((e: any) => e.kind)).toEqual(["created", "direct_change"]);
    const xIds = new Set(x.entries.map((e: any) => e.auditId));
    for (const e of y.entries) expect(xIds.has(e.auditId)).toBe(false);
    expect(x.entries.some((e: any) => e.migrationId === migrationId)).toBe(true);
    expect(y.entries.some((e: any) => e.migrationId === migrationId)).toBe(false);
    const z = (await history(Z)).body;
    expect(z.entries.map((e: any) => e.kind)).toEqual(["created", "backfill_pin"]);
    expect(z.entries[1]).toMatchObject({ action: "subscription.pin_version", toVersionId: freeV1, toVersion: 1 });
    expect(z.current).toMatchObject({ plan: "free", planVersionId: freeV1 });
  });

  it("is platform-owner only and fails closed on unknown tenants", async () => {
    expect((await history(X, xToken)).status).toBe(403);
    expect((await history(Y, xToken)).status).toBe(403);
    expect((await history(X, null)).status).toBe(401);
    const missing = await history(999999999);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("SUBSCRIPTION_NOT_FOUND");
    expect([400, 404]).toContain((await history("abc")).status);
  });
});
