import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, companiesTable, usersTable, contactsTable, eventsTable, auditLogsTable, plansTable, planVersionsTable, subscriptionsTable } from "@workspace/db";
import { runVersionBackfill } from "../src/lib/billing/version-backfill.js";

// Batch 41 (PB-3) — feature entitlements against the LIVE API.
//
// Proves, with real tenants on real plan versions:
//   • a legacy version (every version-1 backfill snapshot) grandfathers EVERY
//     catalog feature although its recorded flags are false;
//   • a published version with featureEnforcement "enforced" denies exactly the
//     features switched off (403 FEATURE_NOT_ENTITLED, machine-readable context)
//     and permits the rest — RBAC still applies on top of a permitted feature;
//   • camera capture is never feature-gated (only NFC is);
//   • platform operators stay behind the tenant firewall (never widened);
//   • an invalid version reference fails closed (every feature denied) without
//     blocking authentication, the billing projection or platform recovery;
//   • publishing a new version never changes a pinned tenant's entitlements;
//   • per-tenant limit overrides survive a plan assignment;
//   • concurrent checks are consistent;
//   • the platform preview shows what a new subscriber gets vs. what the
//     current subscriber keeps.

const BASE = "http://localhost:80/api";
const PLATFORM = { email: "admin@cardscannerpro.com", password: "Admin123!" };
const PW = "Admin123!";
const SUFFIX = Date.now();
const DOMAIN = `b41feat-${SUFFIX}.test`;
const ENFORCED = `b41-enforced-${SUFFIX}`;
const SCRATCH = `b41-scratch-${SUFFIX}`; // never published: provides a draft version id for the invalid-reference case
const FEATURES = ["ai.assistant", "ai.command_center", "workflow.intelligence", "executive.intelligence", "exports.scheduled", "nfc.capture", "documents", "api.access"] as const;
const DENIED = ["documents", "exports.scheduled", "nfc.capture", "workflow.intelligence"] as const;
const enforcedMatrix = Object.fromEntries(FEATURES.map((k) => [k, !(DENIED as readonly string[]).includes(k)]));

let platformToken = "";
let legacyAdminToken = ""; // company L (free, version 1 = legacy)
let enforcedAdminToken = ""; // company E primary_admin
let enforcedRoleToken = ""; // company E admin with explicit module permissions
let enforcedEmployeeToken = ""; // company E employee without AI permissions
let companyL = 0;
let companyE = 0;
let companyN = 0; // assigned after v2 is published
const companyIds: number[] = [];
let enforcedV1 = 0;
let enforcedV2 = 0;
let scratchDraftId = 0;

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
async function createCompany(name: string, plan: string) {
  const res = await api("POST", "/companies", platformToken, { name, plan });
  expect(res.status, res.text).toBe(201);
  companyIds.push(res.body.id);
  return res.body.id as number;
}
async function createUser(email: string, role: string, companyId: number) {
  const res = await api("POST", "/users", platformToken, { email, name: email.split("@")[0], role, companyId, password: PW });
  expect(res.status, res.text).toBe(201);
  return res.body.id as number;
}
const expectDenied = (res: { status: number; body: any; text: string }, feature: string, enforcement: string, planVersionId: number | null) => {
  expect(res.status, res.text).toBe(403);
  expect(res.body.code).toBe("FEATURE_NOT_ENTITLED");
  expect(res.body.context).toEqual({ feature, planVersionId, enforcement });
  expect(typeof res.body.error).toBe("string");
};

beforeAll(async () => {
  platformToken = await login(PLATFORM.email, PLATFORM.password);
  // The fixed catalog carries version 1 exactly the way the operator procedure creates it.
  const report = await runVersionBackfill({ apply: true });
  expect(report.verdict, JSON.stringify({ reason: report.reason, unpinnable: report.subscriptions.unpinnable, integrity: report.integrityErrors })).toBe("APPLIED");

  // An ENFORCED plan: four features off, published.
  const created = await api("POST", "/platform/plans", platformToken, {
    id: ENFORCED,
    name: `Enforced ${SUFFIX}`,
    limits: { contacts: null, events: null, admins: null, employees: null, scans: null, storageMb: null },
    features: enforcedMatrix,
    featureEnforcement: "enforced",
    trialPolicy: { trialDays: 14, eligible: true, oncePerCompany: true, endOutcome: "blocked", readOnlyGraceDays: 0 },
  });
  expect(created.status, created.text).toBe(201);
  enforcedV1 = created.body.draft.id;
  const published = await api("POST", `/platform/plans/${ENFORCED}/versions/${enforcedV1}/publish`, platformToken);
  expect(published.status, published.text).toBe(200);

  // A scratch plan that is never published (its draft id is a valid row that is NOT a published version).
  const scratch = await api("POST", "/platform/plans", platformToken, { id: SCRATCH, name: `Scratch ${SUFFIX}`, limits: {}, features: {} });
  expect(scratch.status, scratch.text).toBe(201);
  scratchDraftId = scratch.body.draft.id;

  companyL = await createCompany(`QA B41 Legacy ${SUFFIX}`, "free");
  companyE = await createCompany(`QA B41 Enforced ${SUFFIX}`, "free");
  // A per-tenant override BEFORE the assignment (must survive it).
  const override = await api("PUT", `/platform/subscriptions/${companyE}/limits`, platformToken, { limits: { contacts: 7 } });
  expect(override.status, override.text).toBe(200);
  // Batch 42 (D3): the enforced version removes four features the legacy tenant currently has → the owner confirms the feature-only downgrade explicitly.
  const unconfirmed = await api("POST", `/platform/subscriptions/${companyE}/plan`, platformToken, { plan: ENFORCED });
  expect(unconfirmed.status, unconfirmed.text).toBe(409);
  expect(unconfirmed.body.code).toBe("FEATURE_DOWNGRADE_CONFIRMATION_REQUIRED");
  const assign = await api("POST", `/platform/subscriptions/${companyE}/plan`, platformToken, { plan: ENFORCED, confirmFeatureDowngrade: true });
  expect(assign.status, assign.text).toBe(200);
  expect(assign.body.planVersionId).toBe(enforcedV1);

  await createUser(`admin@${DOMAIN}`, "primary_admin", companyL);
  await createUser(`eadmin@${DOMAIN}`, "primary_admin", companyE);
  const roleId = await createUser(`erole@${DOMAIN}`, "admin", companyE);
  await createUser(`eemployee@${DOMAIN}`, "employee", companyE);
  await db
    .update(usersTable)
    .set({ permissions: { ai_assistant: ["view", "use"], ai_executive: ["view"], documents: ["view"], reports: ["view"], scans: ["view", "create"] } })
    .where(eq(usersTable.id, roleId));
  legacyAdminToken = await login(`admin@${DOMAIN}`);
  enforcedAdminToken = await login(`eadmin@${DOMAIN}`);
  enforcedRoleToken = await login(`erole@${DOMAIN}`);
  enforcedEmployeeToken = await login(`eemployee@${DOMAIN}`);
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
  await db.delete(planVersionsTable).where(inArray(planVersionsTable.planId, [ENFORCED, SCRATCH]));
  await db.delete(plansTable).where(inArray(plansTable.id, [ENFORCED, SCRATCH]));
});

describe("legacy (grandfathered) version", () => {
  it("version 1 of a fixed plan records flags normalized to false but grandfathers every feature; the login payload carries the same entitlements", async () => {
    const freeV1 = (await api("GET", "/platform/plans/free", platformToken)).body.currentVersion;
    const v = (await api("GET", `/platform/plans/free/versions/${freeV1.id}`, platformToken)).body;
    expect(v.featureEnforcement).toBe("legacy");
    expect(v.snapshot.featureEnforcement ?? "legacy").toBe("legacy"); // absent in the stored snapshot = legacy; never rewritten
    expect(Object.values(v.effectiveFeatures).every((x) => x === true)).toBe(true);
    const sub = await current(legacyAdminToken);
    expect(sub.planVersionId).toBe(freeV1.id);
    expect(sub.entitlements.featureEnforcement).toBe("legacy");
    expect(sub.entitlements.planVersionId).toBe(freeV1.id);
    for (const k of FEATURES) expect(sub.entitlements.features[k], k).toBe(true);
    expect(sub.entitlements.trialPolicy).toEqual({ endOutcome: "blocked", readOnlyGraceDays: 0, graceEndsAt: null });
    const me = await fetch(`${BASE}/auth/login`, { method: "POST", headers: headers(null), body: JSON.stringify({ email: `admin@${DOMAIN}`, password: PW }) }).then((r) => r.json());
    expect(me.user.entitlements).toEqual(sub.entitlements);
  });

  it("every gated route stays reachable for the legacy tenant (unchanged effective access)", async () => {
    for (const path of ["/documents", "/exports/schedules", "/ai/workflow/health", "/ai/assistant/conversations", "/ai/executive/alerts"]) {
      const res = await api("GET", path, legacyAdminToken);
      expect(res.status, `${path}: ${res.text}`).toBe(200);
    }
  });
});

describe("enforced version", () => {
  it("the tenant's entitlements name the version, the mode and exactly the denied features", async () => {
    const sub = await current(enforcedAdminToken);
    expect(sub.planVersionId).toBe(enforcedV1);
    expect(sub.entitlements.featureEnforcement).toBe("enforced");
    expect(sub.entitlements.features).toEqual(enforcedMatrix);
    const d = await detail(companyE);
    expect(d.entitlements).toEqual(sub.entitlements);
    // The override set before the assignment is intact (precedence unchanged).
    expect(d.limitOverrides).toEqual({ contacts: 7 });
    expect(sub.limits.find((l: any) => l.resource === "contacts")).toMatchObject({ limit: 7, source: "override" });
  });

  it("disabled features are refused with a consistent machine-readable 403; enabled ones are permitted", async () => {
    expectDenied(await api("GET", "/documents", enforcedAdminToken), "documents", "enforced", enforcedV1);
    expectDenied(await api("GET", "/exports/schedules", enforcedAdminToken), "exports.scheduled", "enforced", enforcedV1);
    expectDenied(await api("GET", "/ai/workflow/health", enforcedAdminToken), "workflow.intelligence", "enforced", enforcedV1);
    expectDenied(await api("POST", "/documents", enforcedAdminToken, { name: "x" }), "documents", "enforced", enforcedV1);
    // No document, schedule or workflow side effect can exist for the tenant.
    for (const path of ["/ai/assistant/conversations", "/ai/executive/alerts"]) {
      const res = await api("GET", path, enforcedAdminToken);
      expect(res.status, `${path}: ${res.text}`).toBe(200);
    }
  });

  it("NFC capture is refused before the payload is even validated; camera capture is not feature-gated", async () => {
    const nfc = await api("POST", "/scans", enforcedAdminToken, { imageData: "not-an-image", captureSource: "nfc" });
    expectDenied(nfc, "nfc.capture", "enforced", enforcedV1);
    const camera = await api("POST", "/scans", enforcedAdminToken, { imageData: "not-an-image", captureSource: "camera" });
    expect(camera.status, camera.text).toBe(400); // image validation, not an entitlement denial
    expect(camera.body.code).not.toBe("FEATURE_NOT_ENTITLED");
    // The legacy tenant's NFC capture reaches the payload validation (grandfathered).
    const legacyNfc = await api("POST", "/scans", legacyAdminToken, { imageData: "not-an-image", captureSource: "nfc" });
    expect(legacyNfc.status, legacyNfc.text).toBe(400);
    expect(legacyNfc.body.code).not.toBe("FEATURE_NOT_ENTITLED");
  });

  it("RBAC is preserved on top of the feature gate: a permitted feature still needs the module permission; a denied feature is denied for every role", async () => {
    // employee: no ai_assistant permission → permission denial (not an entitlement denial) on an ALLOWED feature
    const emp = await api("GET", "/ai/assistant/conversations", enforcedEmployeeToken);
    expect(emp.status).toBe(403);
    expect(emp.body.code).not.toBe("FEATURE_NOT_ENTITLED");
    // admin with explicit permissions: allowed feature → 200; denied feature → entitlement denial
    const roleOk = await api("GET", "/ai/assistant/conversations", enforcedRoleToken);
    expect(roleOk.status, roleOk.text).toBe(200);
    expectDenied(await api("GET", "/documents", enforcedRoleToken), "documents", "enforced", enforcedV1);
    expectDenied(await api("GET", "/documents", enforcedEmployeeToken), "documents", "enforced", enforcedV1);
  });

  it("the platform operator firewall is unchanged (no widening through entitlements)", async () => {
    const res = await api("GET", "/documents", platformToken);
    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe("FEATURE_NOT_ENTITLED");
    const me = (await api("GET", "/auth/me", platformToken)).body;
    expect(me.role).toBe("platform_owner"); // the operator's own company context never reaches tenant CRM routes
  });

  it("cross-tenant: the legacy tenant is not affected by the enforced tenant's version and cannot read its subscription", async () => {
    const l = await current(legacyAdminToken);
    expect(l.entitlements.featureEnforcement).toBe("legacy");
    expect(l.entitlements.features.documents).toBe(true);
    expect((await api("GET", "/documents", legacyAdminToken)).status).toBe(200);
    const foreign = await api("GET", `/platform/subscriptions/${companyE}`, legacyAdminToken);
    expect(foreign.status).toBe(403);
  });

  it("concurrent entitlement checks are consistent", async () => {
    const [denied, allowed] = await Promise.all([
      Promise.all(Array.from({ length: 12 }, () => api("GET", "/documents", enforcedAdminToken))),
      Promise.all(Array.from({ length: 12 }, () => api("GET", "/documents", legacyAdminToken))),
    ]);
    for (const r of denied) expectDenied(r, "documents", "enforced", enforcedV1);
    for (const r of allowed) expect(r.status).toBe(200);
  });
});

describe("invalid version reference (fail closed)", () => {
  it("every feature is denied, enforcement reads invalid, while login keeps working and the platform operator can repair it", async () => {
    await db.update(subscriptionsTable).set({ planVersionId: scratchDraftId }).where(eq(subscriptionsTable.companyId, companyE));
    try {
      // Authentication is never blocked; the session carries the fail-closed entitlements.
      const token = await login(`eadmin@${DOMAIN}`);
      const me = (await api("GET", "/auth/me", token)).body;
      expect(me.entitlements.featureEnforcement).toBe("invalid");
      expect(me.entitlements.planVersionId).toBe(scratchDraftId);
      for (const k of FEATURES) expect(me.entitlements.features[k], k).toBe(false);
      expect(me.entitlements.trialPolicy).toMatchObject({ endOutcome: "blocked", readOnlyGraceDays: 0 });
      // Limits are never guessed either (Batch 40 integrity fault, unchanged).
      const sub = await api("GET", "/subscriptions/current", token);
      expect(sub.status).toBe(409);
      expect(sub.body.code).toBe("SUBSCRIPTION_PLAN_VERSION_INVALID");
      // Features that the enforced version ALLOWED are denied too (no widening, no guess).
      expectDenied(await api("GET", "/ai/assistant/conversations", token), "ai.assistant", "invalid", scratchDraftId);
      expectDenied(await api("GET", "/documents", token), "documents", "invalid", scratchDraftId);
      expectDenied(await api("POST", "/scans", token, { imageData: "x", captureSource: "nfc" }), "nfc.capture", "invalid", scratchDraftId);
      // Ordinary CRM reads keep working (the version gate is about features, not the subscription's access mode).
      expect((await api("GET", "/contacts", token)).status).toBe(200);
      // The platform operator sees the integrity fault and can repair it through the ordinary assignment.
      const broken = await api("GET", `/platform/subscriptions/${companyE}`, platformToken);
      expect(broken.status).toBe(409);
      expect(broken.body.code).toBe("SUBSCRIPTION_PLAN_VERSION_INVALID");
      // Re-assigning the SAME plan is normally a no-op (grandfathering); an invalid reference is the one case it repairs (audited).
      const repaired = await api("POST", `/platform/subscriptions/${companyE}/plan`, platformToken, { plan: ENFORCED });
      expect(repaired.status, repaired.text).toBe(200);
      expect(repaired.body.planVersionId).toBe(enforcedV1);
      const repairAudit = await db.select({ metadata: auditLogsTable.metadata }).from(auditLogsTable).where(and(eq(auditLogsTable.companyId, companyE), eq(auditLogsTable.action, "subscription.set_plan")));
      expect(repairAudit.some((r) => (r.metadata as any)?.repairedInvalidReference === true && (r.metadata as any)?.previousPlanVersionId === scratchDraftId)).toBe(true);
      // A valid same-plan re-assignment stays a no-op: the pin does not move.
      const noop = await api("POST", `/platform/subscriptions/${companyE}/plan`, platformToken, { plan: ENFORCED });
      expect(noop.status).toBe(200);
      expect(noop.body.planVersionId).toBe(enforcedV1);
      expect((await current(token)).entitlements.featureEnforcement).toBe("enforced");
      expect((await api("GET", "/ai/assistant/conversations", token)).status).toBe(200);
    } finally {
      await db.update(subscriptionsTable).set({ planVersionId: enforcedV1 }).where(eq(subscriptionsTable.companyId, companyE));
    }
  });
});

describe("publishing a new version", () => {
  it("validation warns about the enforced denials (and about recorded-only flags under legacy)", async () => {
    const draft = await api("POST", `/platform/plans/${ENFORCED}/versions`, platformToken, {});
    expect(draft.status, draft.text).toBe(201);
    enforcedV2 = draft.body.id;
    expect(draft.body.featureEnforcement).toBe("enforced"); // pre-filled from v1
    const v = await api("POST", `/platform/plans/${ENFORCED}/versions/${enforcedV2}/validate`, platformToken);
    expect(v.status).toBe(200);
    expect(v.body.errors).toEqual([]);
    expect(v.body.warnings.map((w: any) => w.code)).toContain("FEATURES_ENFORCED_DENIALS");
    const legacy = await api("PATCH", `/platform/plans/${ENFORCED}/versions/${enforcedV2}`, platformToken, { featureEnforcement: "legacy" });
    expect(legacy.status, legacy.text).toBe(200);
    const v2 = await api("POST", `/platform/plans/${ENFORCED}/versions/${enforcedV2}/validate`, platformToken);
    expect(v2.body.warnings.map((w: any) => w.code)).toContain("FEATURES_NOT_ENFORCED");
    expect(v2.body.warnings.map((w: any) => w.code)).not.toContain("FEATURES_ENFORCED_DENIALS");
    const bad = await api("PATCH", `/platform/plans/${ENFORCED}/versions/${enforcedV2}`, platformToken, { featureEnforcement: "strict" });
    expect(bad.status).toBe(400);
  });

  it("v2 (documents allowed) never changes the pinned tenant; a new subscriber gets v2; the preview shows both", async () => {
    const patched = await api("PATCH", `/platform/plans/${ENFORCED}/versions/${enforcedV2}`, platformToken, { featureEnforcement: "enforced", features: { ...enforcedMatrix, documents: true } });
    expect(patched.status, patched.text).toBe(200);
    const before = await current(enforcedAdminToken);
    const published = await api("POST", `/platform/plans/${ENFORCED}/versions/${enforcedV2}/publish`, platformToken);
    expect(published.status, published.text).toBe(200);
    expect(published.body.state).toBe("published");
    const after = await current(enforcedAdminToken);
    expect(after.entitlements).toEqual(before.entitlements);
    expect(after.planVersionId).toBe(enforcedV1);
    expectDenied(await api("GET", "/documents", enforcedAdminToken), "documents", "enforced", enforcedV1);
    // The platform-side preview: what a NEW subscriber gets (v2) vs what the current pin keeps (v1).
    const preview = (await api("GET", `/platform/plans/${ENFORCED}/versions/${enforcedV2}/effective-limits/${companyE}`, platformToken)).body;
    expect(preview.featureEnforcement).toEqual({ preview: "enforced", current: "enforced" });
    expect(preview.changedFeatures).toEqual(["documents"]);
    expect(preview.features.find((f: any) => f.feature === "documents")).toMatchObject({ recorded: true, previewAllowed: true, currentAllowed: false, changes: true });
    expect(preview.features.find((f: any) => f.feature === "nfc.capture")).toMatchObject({ previewAllowed: false, currentAllowed: false, changes: false });
    expect(preview.trialPolicy.current).toMatchObject({ endOutcome: "blocked", readOnlyGraceDays: 0 });
    expect(preview.aiAllowances.preview.source).toEqual({ tokens: "none", cost: "none" });
    // A fresh company is pinned to v2 and may use documents.
    companyN = await createCompany(`QA B41 New ${SUFFIX}`, ENFORCED);
    expect((await detail(companyN)).planVersionId).toBe(enforcedV2);
    await createUser(`nadmin@${DOMAIN}`, "primary_admin", companyN);
    const nToken = await login(`nadmin@${DOMAIN}`);
    expect((await api("GET", "/documents", nToken)).status).toBe(200);
    expectDenied(await api("GET", "/exports/schedules", nToken), "exports.scheduled", "enforced", enforcedV2);
    // Published snapshots stay immutable.
    const edit = await api("PATCH", `/platform/plans/${ENFORCED}/versions/${enforcedV1}`, platformToken, { featureEnforcement: "legacy" });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("VERSION_IMMUTABLE");
  });
});
