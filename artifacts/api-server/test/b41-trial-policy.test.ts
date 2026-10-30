import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, companiesTable, usersTable, contactsTable, auditLogsTable, plansTable, planVersionsTable, subscriptionsTable } from "@workspace/db";
import { runVersionBackfill } from "../src/lib/billing/version-backfill.js";
import { runSubscriptionSweep } from "../src/lib/jobs/subscription-sweep.js";

// Batch 41 (U5) — trial policy against the LIVE API.
//
// Default (and every legacy / version-1 snapshot): a trial that has ended is
// BLOCKED immediately (TRIAL_ENDED), grace 0 days. A published version may
// configure endOutcome read_only with a 1–90 day grace: subscribers are READ-ONLY
// (TRIAL_ENDED_GRACE) until trial end + grace, then blocked; the expiry sweep
// transitions a manual trial to `expired` only after the grace. The same single
// decision path feeds the per-request gate, the tenant projection, the platform
// detail and the sweep. Trial dates, statuses, manual vs provider billing, audit
// rows and existing tenants' resolved access are unchanged.

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b41trial-${SUFFIX}.test`;
const GRACE = `b41-grace-${SUFFIX}`;
const DAY = 86_400_000;

let platformToken = "";
let graceAdminToken = "";
let legacyAdminToken = "";
let companyG = 0; // on the grace plan (read_only, 3 days)
let companyL = 0; // on free v1 (legacy: blocked immediately)
const companyIds: number[] = [];
let graceV1 = 0;

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
const current = async (token: string) => (await api("GET", "/subscriptions/current", token)).body;
const detail = async (cid: number) => (await api("GET", `/platform/subscriptions/${cid}`, platformToken)).body;
const subRow = async (cid: number) => (await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.companyId, cid)))[0];
const setTrialEnd = (cid: number, at: Date) => db.update(subscriptionsTable).set({ trialExpiresAt: at }).where(eq(subscriptionsTable.companyId, cid));
const expiryAudit = async (cid: number) =>
  db
    .select({ action: auditLogsTable.action, metadata: auditLogsTable.metadata, userName: auditLogsTable.userName })
    .from(auditLogsTable)
    .where(and(eq(auditLogsTable.companyId, cid), eq(auditLogsTable.action, "subscription.trial_expired")));
async function createCompany(name: string, plan: string) {
  const res = await api("POST", "/companies", platformToken, { name, plan });
  expect(res.status, res.text).toBe(201);
  companyIds.push(res.body.id);
  return res.body.id as number;
}
async function createUser(email: string, role: string, companyId: number) {
  const res = await api("POST", "/users", platformToken, { email, name: email.split("@")[0], role, companyId, password: PW });
  expect(res.status, res.text).toBe(201);
}

beforeAll(async () => {
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  const report = await runVersionBackfill({ apply: true });
  expect(report.verdict, report.reason).toBe("APPLIED");

  const created = await api("POST", "/platform/plans", platformToken, {
    id: GRACE,
    name: `Grace ${SUFFIX}`,
    limits: {},
    features: {},
    trialPolicy: { trialDays: 14, eligible: true, oncePerCompany: true, endOutcome: "read_only", readOnlyGraceDays: 3 },
  });
  expect(created.status, created.text).toBe(201);
  graceV1 = created.body.draft.id;
  const validation = await api("POST", `/platform/plans/${GRACE}/versions/${graceV1}/validate`, platformToken);
  expect(validation.body.errors).toEqual([]);
  expect(validation.body.warnings.map((w: any) => w.code)).toContain("TRIAL_READ_ONLY_GRACE");
  const published = await api("POST", `/platform/plans/${GRACE}/versions/${graceV1}/publish`, platformToken);
  expect(published.status, published.text).toBe(200);

  companyG = await createCompany(`QA B41 Grace ${SUFFIX}`, GRACE);
  companyL = await createCompany(`QA B41 Trial Legacy ${SUFFIX}`, "free");
  await createUser(`gadmin@${DOMAIN}`, "primary_admin", companyG);
  await createUser(`ladmin@${DOMAIN}`, "primary_admin", companyL);
  graceAdminToken = await login(`gadmin@${DOMAIN}`);
  legacyAdminToken = await login(`ladmin@${DOMAIN}`);
});

afterAll(async () => {
  if (companyIds.length) {
    await db.delete(contactsTable).where(inArray(contactsTable.companyId, companyIds));
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds));
    await db.delete(usersTable).where(inArray(usersTable.companyId, companyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds));
  }
  await db.delete(usersTable).where(like(usersTable.email, `%@${DOMAIN}`));
  await db.delete(planVersionsTable).where(eq(planVersionsTable.planId, GRACE));
  await db.delete(plansTable).where(eq(plansTable.id, GRACE));
});

describe("publication validation", () => {
  it("read_only without a grace is refused; blocked is the platform default; the catalog states the rule", async () => {
    const draft = await api("POST", `/platform/plans/${GRACE}/versions`, platformToken, {});
    expect(draft.status, draft.text).toBe(201);
    try {
      expect(draft.body.trialPolicy).toMatchObject({ endOutcome: "read_only", readOnlyGraceDays: 3 }); // pre-filled from v1
      const bad = await api("PATCH", `/platform/plans/${GRACE}/versions/${draft.body.id}`, platformToken, { trialPolicy: { endOutcome: "read_only", readOnlyGraceDays: 0 } });
      expect(bad.status, bad.text).toBe(200);
      const v = await api("POST", `/platform/plans/${GRACE}/versions/${draft.body.id}/validate`, platformToken);
      expect(v.body.publishable).toBe(false);
      expect(v.body.errors.map((e: any) => e.code)).toContain("TRIAL_GRACE_REQUIRED");
      const tooLong = await api("PATCH", `/platform/plans/${GRACE}/versions/${draft.body.id}`, platformToken, { trialPolicy: { endOutcome: "read_only", readOnlyGraceDays: 91 } });
      expect(tooLong.status).toBe(400);
      const catalog = (await api("GET", "/platform/plans", platformToken)).body;
      expect(catalog.trialPolicy.endOfTrialOutcome).toBe("blocked");
      expect(catalog.trialPolicy.readOnlyGraceDays).toBe(0);
    } finally {
      await api("DELETE", `/platform/plans/${GRACE}/versions/${draft.body.id}`, platformToken);
    }
  });
});

describe("read-only grace on a published version", () => {
  it("inside the trial: full access; the projection names the policy and the grace end", async () => {
    const sub = await current(graceAdminToken);
    expect(sub).toMatchObject({ status: "trialing", billingSource: "manual", accessMode: "full", accessReasonCode: null, planVersionId: graceV1 });
    const trialEnd = new Date(sub.trialExpiresAt).getTime();
    expect(trialEnd).toBeGreaterThan(Date.now() + 13 * DAY);
    expect(sub.entitlements.trialPolicy).toEqual({ endOutcome: "read_only", readOnlyGraceDays: 3, graceEndsAt: new Date(trialEnd + 3 * DAY).toISOString() });
    expect((await api("POST", "/contacts", graceAdminToken, { firstName: "Inside", lastName: "Trial", email: `inside-${SUFFIX}@example.com` })).status).toBe(201);
  });

  it("one minute before the trial end: still full", async () => {
    await setTrialEnd(companyG, new Date(Date.now() + 60_000));
    expect((await current(graceAdminToken)).accessMode).toBe("full");
  });

  it("after the trial end, inside the grace: read-only (TRIAL_ENDED_GRACE) — reads work, writes are refused, the sweep does NOT expire", async () => {
    await setTrialEnd(companyG, new Date(Date.now() - DAY));
    const sub = await current(graceAdminToken);
    expect(sub).toMatchObject({ status: "trialing", accessMode: "read_only", accessReasonCode: "TRIAL_ENDED_GRACE" });
    expect(new Date(sub.entitlements.trialPolicy.graceEndsAt).getTime()).toBeGreaterThan(Date.now());
    expect((await api("GET", "/contacts", graceAdminToken)).status).toBe(200);
    const write = await api("POST", "/contacts", graceAdminToken, { firstName: "Grace", lastName: "Write", email: `grace-${SUFFIX}@example.com` });
    expect(write.status).toBe(403);
    expect(write.body.code).not.toBe("FEATURE_NOT_ENTITLED");
    expect((await detail(companyG)).accessMode).toBe("read_only");
    const summary = await runSubscriptionSweep(new Date());
    expect(summary.examined).toBeGreaterThanOrEqual(1); // the row is selected (trial end passed) …
    expect((await subRow(companyG)).status).toBe("trialing"); // … but kept alive inside the grace
    expect(await expiryAudit(companyG)).toHaveLength(0);
  });

  it("at the grace boundary: one second before = read-only, at the boundary = blocked", async () => {
    const now = Date.now();
    await setTrialEnd(companyG, new Date(now - 3 * DAY + 2_000));
    expect((await current(graceAdminToken)).accessMode).toBe("read_only");
    await setTrialEnd(companyG, new Date(now - 3 * DAY));
    const blocked = await api("GET", "/subscriptions/current", graceAdminToken);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("TRIAL_ENDED");
  });

  it("after the grace: blocked; the sweep expires the manual trial once with audit evidence of the grace end; a second sweep is a no-op", async () => {
    await setTrialEnd(companyG, new Date(Date.now() - 4 * DAY));
    expect((await api("GET", "/contacts", graceAdminToken)).status).toBe(403);
    expect((await detail(companyG))).toMatchObject({ status: "trialing", accessMode: "blocked" });
    await runSubscriptionSweep(new Date());
    const row = await subRow(companyG);
    expect(row.status).toBe("expired");
    expect(row.endedAt).not.toBeNull();
    const audit = await expiryAudit(companyG);
    expect(audit).toHaveLength(1);
    expect(audit[0].userName).toBe("system:subscription-sweep");
    expect((audit[0].metadata as any).graceEndedAt).toBe(new Date(row.trialExpiresAt!.getTime() + 3 * DAY).toISOString());
    await runSubscriptionSweep(new Date());
    expect(await expiryAudit(companyG)).toHaveLength(1);
    expect((await detail(companyG))).toMatchObject({ status: "expired", accessMode: "blocked", accessReasonCode: "SUBSCRIPTION_EXPIRED" });
  });

  it("renewal: activating the expired subscription restores full access; the trial dates are preserved as history", async () => {
    const before = await subRow(companyG);
    const activate = await api("POST", `/platform/subscriptions/${companyG}/activate`, platformToken);
    expect(activate.status, activate.text).toBe(200);
    expect(activate.body).toMatchObject({ status: "active", accessMode: "full", accessReasonCode: null });
    const after = await subRow(companyG);
    expect(after.trialStartedAt?.toISOString()).toBe(before.trialStartedAt?.toISOString());
    expect(after.trialExpiresAt?.toISOString()).toBe(before.trialExpiresAt?.toISOString());
    expect(after.planVersionId).toBe(graceV1);
    expect((await api("POST", "/contacts", graceAdminToken, { firstName: "Renewed", lastName: "Tenant", email: `renewed-${SUFFIX}@example.com` })).status).toBe(201);
  });
});

describe("legacy (version 1) and provider-managed subscriptions", () => {
  it("a legacy version-1 tenant is blocked the moment its trial ends (no grace) and the sweep expires it immediately", async () => {
    const sub = await current(legacyAdminToken);
    expect(sub.entitlements.trialPolicy).toEqual({ endOutcome: "blocked", readOnlyGraceDays: 0, graceEndsAt: null });
    await setTrialEnd(companyL, new Date(Date.now() - 60_000));
    const blocked = await api("GET", "/subscriptions/current", legacyAdminToken);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("TRIAL_ENDED");
    expect((await detail(companyL))).toMatchObject({ status: "trialing", accessMode: "blocked", accessReasonCode: "TRIAL_ENDED" });
    await runSubscriptionSweep(new Date());
    expect((await subRow(companyL)).status).toBe("expired");
    expect(await expiryAudit(companyL)).toHaveLength(1);
  });

  it("the sweep never touches a provider-managed trial, grace or not", async () => {
    const companyP = await createCompany(`QA B41 Provider Trial ${SUFFIX}`, GRACE);
    await db.update(subscriptionsTable).set({ billingSource: "stripe", trialExpiresAt: new Date(Date.now() - 10 * DAY) }).where(eq(subscriptionsTable.companyId, companyP));
    await runSubscriptionSweep(new Date());
    expect((await subRow(companyP)).status).toBe("trialing");
    expect(await expiryAudit(companyP)).toHaveLength(0);
  });
});
