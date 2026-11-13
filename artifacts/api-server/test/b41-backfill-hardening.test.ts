import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, companiesTable, usersTable, auditLogsTable, plansTable, planVersionsTable, subscriptionsTable } from "@workspace/db";
import { runVersionBackfill } from "../src/lib/billing/version-backfill.js";

// Batch 41 — version-1 backfill SAFETY HARDENING against the LIVE API + the
// isolated local DB.
//
//   • an unpinnable subscription (its plan missing, not published or without a
//     published version) can never produce a COMPLETE / APPLIED verdict: the
//     whole run is rolled back (nothing partial), verdict INCOMPLETE, every
//     diagnostic kept;
//   • an integrity error in the BEFORE or AFTER snapshot (a subscription whose
//     entitlement cannot be resolved) never counts as parity: verdict
//     INTEGRITY_ERROR, rolled back, nothing written;
//   • dry-run first, idempotent apply, the actual evaluation instant;
//   • two concurrent applies converge on exactly one version 1 per plan;
//   • the operator CLI refuses an unexpected / unconfirmed database target
//     BEFORE connecting, never trusts NODE_ENV alone, and carries no hard-coded
//     snapshot date.

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const SUFFIX = Date.now();
const LEGACY_A = `b41-legacy-a-${SUFFIX}`;
const LEGACY_B = `b41-legacy-b-${SUFFIX}`;
const SCRATCH = `b41-scratch-bf-${SUFFIX}`;

let platformToken = "";
let companyA = 0;
let companyB = 0;
let companyW = 0;
const companyIds: number[] = [];
let scratchDraftId = 0;

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
async function createCompany(name: string, plan: string) {
  const res = await api("POST", "/companies", platformToken, { name, plan });
  expect(res.status, res.text).toBe(201);
  companyIds.push(res.body.id);
  return res.body.id as number;
}
async function insertLegacyPlan(id: string, contacts: number) {
  await db.insert(plansTable).values({
    id,
    name: `Legacy ${id}`,
    description: "legacy row without versions",
    sortOrder: 50,
    trialDays: 21,
    isActive: true,
    status: "published",
    features: { "ai.assistant": true },
    contactsLimit: contacts,
    eventsLimit: null,
    adminsLimit: null,
    employeesLimit: null,
    scansLimit: null,
    storageLimitMb: null,
    apiLimit: null,
  });
}
const versionsOf = (planId: string) => db.select({ id: planVersionsTable.id, version: planVersionsTable.version }).from(planVersionsTable).where(eq(planVersionsTable.planId, planId));
const refOf = async (cid: number) => (await db.select({ v: subscriptionsTable.planVersionId }).from(subscriptionsTable).where(eq(subscriptionsTable.companyId, cid)))[0]?.v ?? null;
const auditCount = async (action: string) => (await db.select({ id: auditLogsTable.id }).from(auditLogsTable).where(eq(auditLogsTable.action, action))).length;
const cliDir = process.cwd();
function cli(args: string[], env: Record<string, string | undefined>) {
  try {
    const out = execFileSync("pnpm", ["exec", "tsx", "scripts/backfill-plan-versions.ts", ...args], { cwd: cliDir, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    return { code: 0, out };
  } catch (err: any) {
    return { code: typeof err.status === "number" ? err.status : -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

beforeAll(async () => {
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  // Start from a fully pinned catalog (fixed plans at version 1).
  expect((await runVersionBackfill({ apply: true })).verdict).toBe("APPLIED");
  await insertLegacyPlan(LEGACY_A, 5);
  await insertLegacyPlan(LEGACY_B, 6);
  companyA = await createCompany(`QA B41 Backfill A ${SUFFIX}`, LEGACY_A);
  companyB = await createCompany(`QA B41 Backfill B ${SUFFIX}`, LEGACY_B);
  companyW = await createCompany(`QA B41 Backfill W ${SUFFIX}`, "free");
  const scratch = await api("POST", "/platform/plans", platformToken, { id: SCRATCH, name: `Scratch ${SUFFIX}`, limits: {}, features: {} });
  expect(scratch.status, scratch.text).toBe(201);
  scratchDraftId = scratch.body.draft.id;
  expect(await refOf(companyA)).toBeNull();
  expect(await refOf(companyB)).toBeNull();
  expect(await refOf(companyW)).not.toBeNull();
});

afterAll(async () => {
  if (companyIds.length) {
    await db.delete(auditLogsTable).where(inArray(auditLogsTable.companyId, companyIds));
    await db.delete(usersTable).where(inArray(usersTable.companyId, companyIds));
    await db.delete(companiesTable).where(inArray(companiesTable.id, companyIds));
  }
  await db.delete(planVersionsTable).where(inArray(planVersionsTable.planId, [LEGACY_A, LEGACY_B, SCRATCH]));
  await db.delete(plansTable).where(inArray(plansTable.id, [LEGACY_A, LEGACY_B, SCRATCH]));
});

describe("unpinnable subscriptions", () => {
  it("one unpinnable subscription makes the WHOLE run INCOMPLETE and rolled back — no version, no pin, no audit row for the other legacy plan either", async () => {
    // Plan B is archived behind its subscriber's back: its subscription cannot be pinned.
    await db.update(plansTable).set({ status: "archived" }).where(eq(plansTable.id, LEGACY_B));
    const backfills = await auditCount("plan_version.backfill");
    const pins = await auditCount("subscription.pin_version");
    try {
      const report = await runVersionBackfill({ apply: true });
      expect(report).toMatchObject({ verdict: "INCOMPLETE", complete: false, applied: false, rolledBack: true });
      expect(report.reason).toMatch(/cannot be pinned/);
      expect(report.subscriptions.unpinnable).toEqual([{ companyId: companyB, subscriptionId: expect.any(Number), planId: LEGACY_B, reason: "plan_not_published" }]);
      expect(report.plans.find((p) => p.planId === LEGACY_A)?.action).toBe("version_created"); // what WOULD have happened — kept as a diagnostic
      expect(report.verification.mismatches).toEqual([]);
      expect(report.integrityErrors).toEqual([]);
      // Nothing partial survived.
      expect(await versionsOf(LEGACY_A)).toEqual([]);
      expect(await versionsOf(LEGACY_B)).toEqual([]);
      expect(await refOf(companyA)).toBeNull();
      expect(await refOf(companyB)).toBeNull();
      expect(await auditCount("plan_version.backfill")).toBe(backfills);
      expect(await auditCount("subscription.pin_version")).toBe(pins);
      // The dry run says the same thing (dry-run first is honoured: it is never "OK").
      const dry = await runVersionBackfill({ apply: false });
      expect(dry).toMatchObject({ verdict: "INCOMPLETE", complete: false, applied: false, rolledBack: true, mode: "dry-run" });
    } finally {
      await db.update(plansTable).set({ status: "published" }).where(eq(plansTable.id, LEGACY_B));
    }
  });

  it("a legacy reference to a plan id that no longer exists cannot be created through the schema (FK) — the plan_missing diagnostic is defence in depth only", async () => {
    await expect(db.update(subscriptionsTable).set({ plan: `${LEGACY_B}-gone` }).where(eq(subscriptionsTable.companyId, companyB))).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23503" }) });
    expect(await refOf(companyB)).toBeNull();
  });
});

describe("snapshot integrity", () => {
  it("an entitlement that cannot be resolved BEFORE the run is an integrity error, never parity: INTEGRITY_ERROR, rolled back, nothing written", async () => {
    // Company W points at a DRAFT of another plan: its effective limits cannot be resolved.
    const original = await refOf(companyW);
    await db.update(subscriptionsTable).set({ planVersionId: scratchDraftId }).where(eq(subscriptionsTable.companyId, companyW));
    const backfills = await auditCount("plan_version.backfill");
    try {
      const report = await runVersionBackfill({ apply: true });
      expect(report).toMatchObject({ verdict: "INTEGRITY_ERROR", complete: false, applied: false, rolledBack: true });
      expect(report.integrityErrors).toEqual([{ phase: "before", companyId: companyW, subscriptionId: expect.any(Number), code: "SUBSCRIPTION_PLAN_VERSION_INVALID" }]);
      expect(report.reason).toMatch(/before the backfill/);
      // The legacy plans were not even touched (the run stops at the BEFORE snapshot).
      expect(report.plans).toEqual([]);
      expect(await versionsOf(LEGACY_A)).toEqual([]);
      expect(await refOf(companyA)).toBeNull();
      expect(await auditCount("plan_version.backfill")).toBe(backfills);
      // The snapshot itself reports the fault explicitly (a "features" / "limits" difference is never derived from an error).
      const dry = await runVersionBackfill({ apply: false });
      expect(dry.verdict).toBe("INTEGRITY_ERROR");
      expect(dry.verification.mismatches).toEqual([]);
    } finally {
      await db.update(subscriptionsTable).set({ planVersionId: original }).where(eq(subscriptionsTable.companyId, companyW));
    }
  });
});

describe("dry run, apply, idempotency, concurrency", () => {
  it("dry-run reports the actual evaluation instant and writes nothing; two concurrent applies converge on exactly one version 1 per plan", async () => {
    const instant = new Date(Date.now() - 1234);
    const dry = await runVersionBackfill({ apply: false, now: instant });
    expect(dry).toMatchObject({ verdict: "DRY_RUN_OK", complete: true, applied: false, rolledBack: true, mode: "dry-run" });
    expect(dry.evaluationInstant).toBe(instant.toISOString());
    expect(dry.plans.filter((p) => p.action === "version_created").map((p) => p.planId).sort()).toEqual([LEGACY_A, LEGACY_B].sort());
    expect(await versionsOf(LEGACY_A)).toEqual([]);
    expect(await refOf(companyA)).toBeNull();

    const [r1, r2] = await Promise.all([runVersionBackfill({ apply: true }), runVersionBackfill({ apply: true })]);
    for (const r of [r1, r2]) {
      expect(r.verdict, JSON.stringify({ reason: r.reason, mismatches: r.verification.mismatches, integrity: r.integrityErrors })).toBe("APPLIED");
      expect(r.complete).toBe(true);
      expect(r.applied).toBe(true);
      expect(typeof r.evaluationInstant).toBe("string");
      expect(Math.abs(Date.now() - new Date(r.evaluationInstant).getTime())).toBeLessThan(60_000);
    }
    const created = [r1, r2].map((r) => r.plans.filter((p) => p.action === "version_created").length);
    expect(created.sort()).toEqual([0, 2]); // exactly one run created them, the other found them
    const vA = await versionsOf(LEGACY_A);
    const vB = await versionsOf(LEGACY_B);
    expect(vA).toHaveLength(1);
    expect(vB).toHaveLength(1);
    expect(vA[0].version).toBe(1);
    expect(await refOf(companyA)).toBe(vA[0].id);
    expect(await refOf(companyB)).toBe(vB[0].id);
    // A third apply changes nothing.
    const again = await runVersionBackfill({ apply: true });
    expect(again.verdict).toBe("APPLIED");
    expect(again.subscriptions.pinned).toEqual([]);
    expect(again.plans.every((p) => p.action !== "version_created")).toBe(true);
    expect(await versionsOf(LEGACY_A)).toHaveLength(1);
    // Every created version-1 snapshot is legacy (grandfathered) and records the row's flags.
    const [row] = await db.select().from(planVersionsTable).where(eq(planVersionsTable.id, vA[0].id));
    expect((row.snapshot as any).featureEnforcement).toBeUndefined();
    expect((row.snapshot as any).features["ai.assistant"]).toBe(true);
    expect((row.snapshot as any).features.documents).toBe(false);
  });
});

describe("operator CLI target guards (no connection is attempted on refusal)", () => {
  const base = { NODE_ENV: "development" };
  it("refuses a non-loopback host without --expect-host, and a mismatching --expect-host", () => {
    const remote = cli([], { ...base, DATABASE_URL: "postgres://user:secret@db.internal.example:5432/app" });
    expect(remote.code).toBe(2);
    expect(remote.out).toMatch(/EXPECT_HOST_REQUIRED/);
    expect(remote.out).not.toMatch(/secret/); // the URL is never echoed
    const mismatch = cli(["--expect-host", "other.example"], { ...base, DATABASE_URL: "postgres://user:secret@db.internal.example:5432/app" });
    expect(mismatch.code).toBe(2);
    expect(mismatch.out).toMatch(/EXPECT_HOST_MISMATCH/);
    const local = cli(["--expect-host", "wrong.example"], base);
    expect(local.code).toBe(2);
    expect(local.out).toMatch(/EXPECT_HOST_MISMATCH/);
  });

  it("never trusts NODE_ENV alone: production needs an explicit confirmation; an invalid URL is refused; --apply to a remote host needs --confirm-production", () => {
    const prod = cli([], { NODE_ENV: "production" });
    expect(prod.code).toBe(2);
    expect(prod.out).toMatch(/PRODUCTION_CONFIRMATION_REQUIRED/);
    const invalid = cli([], { ...base, DATABASE_URL: "not-a-url" });
    expect(invalid.code).toBe(2);
    expect(invalid.out).toMatch(/DATABASE_URL_INVALID/);
    const remoteApply = cli(["--apply", "--expect-host", "db.internal.example"], { ...base, DATABASE_URL: "postgres://user:secret@db.internal.example:5432/app" });
    expect(remoteApply.code).toBe(2);
    expect(remoteApply.out).toMatch(/PRODUCTION_CONFIRMATION_REQUIRED/);
  });

  it("a local dry run prints the ACTUAL evaluation instant and the verdict (no hard-coded snapshot date)", () => {
    const before = Date.now();
    const run = cli([], base);
    expect(run.code, run.out).toBe(0);
    expect(run.out).toMatch(/database target: .* \(local\)/);
    expect(run.out).toMatch(/mode=dry-run verdict=DRY_RUN_OK complete=true applied=false rolledBack=true/);
    const m = run.out.match(/evaluationInstant=(\S+)/);
    expect(m).toBeTruthy();
    const t = new Date(m![1]).getTime();
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(Date.now() + 1000);
    expect(run.out).not.toMatch(/2026-10-2[0-9]T/); // no literal snapshot date in the CLI output
  });
});
