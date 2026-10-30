import { describe, it, expect } from "vitest";
import {
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KEYS,
  PLAN_SLUG_RE,
  compareVersions,
  defaultTrialPolicy,
  emptyFeatureMatrix,
  featureMatrixFromRecord,
  isFixedPlanId,
  isPlanSlug,
  limitTightens,
  limitsAsPlanDefaults,
  parseDisplayInput,
  parseFeaturesInput,
  parseLimitsInput,
  parseTrialPolicyInput,
  planRowMirrorFromSnapshot,
  snapshotFromPlanRow,
  unlimitedLimits,
  validateVersionForPublish,
  type PlanVersionSnapshot,
  type PriceLike,
} from "../src/lib/billing/plan-versions.js";
import { resolveEffectiveLimits, LIMIT_RESOURCES } from "../src/lib/billing/lifecycle.js";
import { compareSnapshots, type EntitlementSnapshotRow } from "../src/lib/billing/version-backfill.js";

// Batch 40 — PURE plan-version rules (no database, no HTTP).

const planRow = {
  name: "Starter",
  description: "Starter plan.",
  sortOrder: 1,
  trialDays: 14,
  features: { "ai.assistant": true, legacyFlag: true },
  contactsLimit: 500,
  eventsLimit: null,
  adminsLimit: 2,
  employeesLimit: 10,
  scansLimit: 100,
  storageLimitMb: null,
};
const price = (over: Partial<PriceLike> = {}): PriceLike => ({ id: 1, interval: "month", intervalCount: 1, currency: "usd", unitAmountMinor: 1900, providerMode: "test", nickname: null, active: true, verifiedAt: new Date("2026-10-01T00:00:00Z"), ...over });
const okSnapshot = (): PlanVersionSnapshot => ({ name: "Growth", description: null, sortOrder: 10, limits: { ...unlimitedLimits(), contacts: 1000, admins: 3 }, features: emptyFeatureMatrix(), prices: [] });
const ctx = { configuredProviderMode: "test" as const, prices: [] as PriceLike[] };

describe("plan identities", () => {
  it("new slugs are lowercase 2–40 chars starting with a letter; the five fixed ids are reserved", () => {
    for (const ok of ["growth", "team-plus", "a1", "x".repeat(40)]) expect(isPlanSlug(ok), ok).toBe(true);
    for (const bad of ["", "A", "1abc", "Growth", "team_plus", "x".repeat(41), "../free", "free plan"]) expect(isPlanSlug(bad), bad).toBe(false);
    for (const fixed of ["free", "starter", "professional", "business", "enterprise"]) {
      expect(PLAN_SLUG_RE.test(fixed)).toBe(true);
      expect(isFixedPlanId(fixed)).toBe(true);
    }
    expect(isFixedPlanId("growth")).toBe(false);
  });
});

describe("feature catalog and limits", () => {
  it("the fixed feature catalog has exactly the eight approved keys and every matrix carries all of them", () => {
    expect([...PLAN_FEATURE_KEYS]).toEqual(["ai.assistant", "ai.command_center", "workflow.intelligence", "executive.intelligence", "exports.scheduled", "nfc.capture", "documents", "api.access"]);
    expect(Object.keys(emptyFeatureMatrix())).toEqual([...PLAN_FEATURE_KEYS]);
    expect(Object.values(emptyFeatureMatrix()).every((v) => v === false)).toBe(true);
    // Legacy jsonb flags: known keys kept, unknown keys dropped (never invented).
    const m = featureMatrixFromRecord({ "ai.assistant": true, legacyFlag: true, "nfc.capture": "yes" });
    expect(m["ai.assistant"]).toBe(true);
    expect(m["nfc.capture"]).toBe(false);
    expect((m as Record<string, unknown>).legacyFlag).toBeUndefined();
  });

  it("limit input merges over the base, accepts null = unlimited and bounded integers, and reports every bad field", () => {
    const base = { ...unlimitedLimits(), contacts: 10 };
    expect(parseLimitsInput(undefined, base).value).toEqual(base);
    const merged = parseLimitsInput({ events: 5, contacts: null }, base);
    expect(merged.issues).toEqual([]);
    expect(merged.value).toEqual({ ...base, events: 5, contacts: null });
    const bad = parseLimitsInput({ contacts: -1, events: 1.5, scans: "9", bogus: 1 }, base);
    expect(bad.issues.map((i) => i.code).sort()).toEqual(["LIMIT_INVALID", "LIMIT_INVALID", "LIMIT_INVALID", "LIMIT_UNKNOWN"]);
    expect(parseLimitsInput([], base).issues[0].code).toBe("LIMITS_INVALID");
    expect(PLAN_LIMIT_KEYS).toEqual(LIMIT_RESOURCES);
  });

  it("feature input rejects keys outside the catalog and non-boolean values", () => {
    const r = parseFeaturesInput({ "ai.assistant": true, "api.access": "on", unknown: true }, emptyFeatureMatrix());
    expect(r.value["ai.assistant"]).toBe(true);
    expect(r.issues.map((i) => i.code).sort()).toEqual(["FEATURE_INVALID", "FEATURE_UNKNOWN"]);
  });

  it("trial policy input is bounded and typed", () => {
    const base = defaultTrialPolicy(14);
    expect(base).toEqual({ trialDays: 14, eligible: true, oncePerCompany: true, endOutcome: "blocked", readOnlyGraceDays: 0 });
    const ok = parseTrialPolicyInput({ trialDays: 30, eligible: false }, base);
    expect(ok.issues).toEqual([]);
    expect(ok.value).toEqual({ ...base, trialDays: 30, eligible: false });
    const bad = parseTrialPolicyInput({ trialDays: 400, endOutcome: "forever", readOnlyGraceDays: -1, extra: 1 }, base);
    expect(bad.issues.map((i) => i.code).sort()).toEqual(["TRIAL_DAYS_INVALID", "TRIAL_END_OUTCOME_INVALID", "TRIAL_GRACE_INVALID", "TRIAL_POLICY_UNKNOWN"]);
  });

  it("display input normalizes whitespace and bounds length / sort order", () => {
    const base = { name: "Old", description: null, sortOrder: 0 };
    expect(parseDisplayInput({ name: "  New   Plan ", description: "  ", sortOrder: 5 }, base).value).toEqual({ name: "New Plan", description: null, sortOrder: 5 });
    expect(parseDisplayInput({ name: "", sortOrder: 5000 }, base).issues.map((i) => i.code).sort()).toEqual(["NAME_INVALID", "SORT_ORDER_INVALID"]);
  });
});

describe("version-1 snapshot and resolver parity", () => {
  it("version 1 is built from the plan row's ACTUAL values (limits, display, trial days, known feature flags, active prices)", () => {
    const snap = snapshotFromPlanRow(planRow, [price(), price({ id: 2, active: false })]);
    expect(snap.name).toBe("Starter");
    expect(snap.limits).toEqual({ contacts: 500, events: null, admins: 2, employees: 10, scans: 100, storageMb: null });
    expect(snap.features["ai.assistant"]).toBe(true);
    expect(snap.prices.map((p) => p.id)).toEqual([1, 2]);
    expect(defaultTrialPolicy(planRow.trialDays).trialDays).toBe(14);
  });

  it("effective-limit parity: the resolver answers identically from the plan row and from the version snapshot, with and without overrides", () => {
    const snap = snapshotFromPlanRow(planRow, []);
    for (const overrides of [{}, { contacts: 50 }, { events: 0, scans: null }, { admins: 1, employees: 99, storageMb: 10 }]) {
      const fromRow = resolveEffectiveLimits(planRow, overrides);
      const fromVersion = resolveEffectiveLimits(limitsAsPlanDefaults(snap.limits), overrides);
      expect(fromVersion).toEqual(fromRow);
    }
  });

  it("the plan-row mirror written at publish carries exactly the version's display fields, limits, features and trial days", () => {
    const snap = okSnapshot();
    const mirror = planRowMirrorFromSnapshot(snap, defaultTrialPolicy(7));
    expect(mirror).toEqual({ name: "Growth", description: null, sortOrder: 10, trialDays: 7, features: emptyFeatureMatrix(), contactsLimit: 1000, eventsLimit: null, adminsLimit: 3, employeesLimit: null, scansLimit: null, storageLimitMb: null });
  });
});

describe("publication validation", () => {
  it("a consistent draft without prices is valid with the manual-billing warning", () => {
    const v = validateVersionForPublish(okSnapshot(), defaultTrialPolicy(14), ctx);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.warnings.map((w) => w.code)).toContain("NO_PROVIDER_PRICE");
  });

  it("limits must be consistent: an admins limit below 1 is refused, storage stays informational", () => {
    const s = okSnapshot();
    s.limits.admins = 0;
    s.limits.storageMb = 1024;
    const v = validateVersionForPublish(s, defaultTrialPolicy(14), ctx);
    expect(v.errors.map((e) => e.code)).toEqual(["LIMIT_ADMINS_ZERO"]);
    expect(v.warnings.map((w) => w.code)).toContain("STORAGE_INFORMATIONAL");
  });

  it("feature keys must come from the fixed catalog and every key must be set", () => {
    const s = okSnapshot();
    delete (s.features as Record<string, unknown>)["api.access"];
    (s.features as Record<string, unknown>)["beta.thing"] = true;
    const v = validateVersionForPublish(s, defaultTrialPolicy(14), ctx);
    expect(v.errors.map((e) => e.code).sort()).toEqual(["FEATURE_MISSING", "FEATURE_UNKNOWN"]);
    const off = okSnapshot();
    off.features["ai.command_center"] = false;
    expect(validateVersionForPublish(off, defaultTrialPolicy(14), ctx).warnings.map((w) => w.code)).toContain("FEATURES_NOT_ENFORCED");
  });

  it("trial policy must be complete and consistent: blocked carries no grace; read-only (Batch 41, U5) needs a 1–90 day grace", () => {
    const grace = validateVersionForPublish(okSnapshot(), { ...defaultTrialPolicy(14), readOnlyGraceDays: 3 }, ctx);
    expect(grace.errors.map((e) => e.code)).toEqual(["TRIAL_GRACE_INCONSISTENT"]);
    const readOnly = validateVersionForPublish(okSnapshot(), { ...defaultTrialPolicy(14), endOutcome: "read_only", readOnlyGraceDays: 7 }, ctx);
    expect(readOnly.errors).toEqual([]);
    expect(readOnly.warnings.map((w) => w.code)).toContain("TRIAL_READ_ONLY_GRACE");
    const readOnlyNoGrace = validateVersionForPublish(okSnapshot(), { ...defaultTrialPolicy(14), endOutcome: "read_only", readOnlyGraceDays: 0 }, ctx);
    expect(readOnlyNoGrace.errors.map((e) => e.code)).toEqual(["TRIAL_GRACE_REQUIRED"]);
    const incomplete = validateVersionForPublish(okSnapshot(), { trialDays: 14 } as never, ctx);
    expect(incomplete.ok).toBe(false);
    expect(incomplete.errors.map((e) => e.code)).toEqual(expect.arrayContaining(["TRIAL_ELIGIBLE_INVALID", "TRIAL_ONCE_INVALID", "TRIAL_END_OUTCOME_INVALID", "TRIAL_GRACE_INVALID"]));
  });

  it("every ACTIVE price applying to the version must be verified in the configured provider mode; inactive prices are ignored", () => {
    const mismatch = validateVersionForPublish(okSnapshot(), defaultTrialPolicy(14), { configuredProviderMode: "live", prices: [price({ providerMode: "test" })] });
    expect(mismatch.errors.map((e) => e.code)).toEqual(["PRICE_MODE_MISMATCH"]);
    const inactive = validateVersionForPublish(okSnapshot(), defaultTrialPolicy(14), { configuredProviderMode: "live", prices: [price({ providerMode: "test", active: false })] });
    expect(inactive.ok).toBe(true);
    const good = validateVersionForPublish(okSnapshot(), defaultTrialPolicy(14), { configuredProviderMode: "test", prices: [price()] });
    expect(good.ok).toBe(true);
    expect(good.warnings.map((w) => w.code)).not.toContain("NO_PROVIDER_PRICE");
  });
});

describe("comparison", () => {
  it("compare rows flag exactly the changed fields; tightening is 'lower than before' with unlimited as +∞", () => {
    const a = { snapshot: okSnapshot(), trialPolicy: defaultTrialPolicy(14) };
    const b = { snapshot: { ...okSnapshot(), limits: { ...okSnapshot().limits, contacts: 500, events: 10 } }, trialPolicy: { ...defaultTrialPolicy(14), trialDays: 7 } };
    const rows = compareVersions(a, b);
    expect(rows.filter((r) => r.changed).map((r) => `${r.group}.${r.field}`).sort()).toEqual(["limits.contacts", "limits.events", "trialPolicy.trialDays"]);
    expect(rows.length).toBe(3 + PLAN_LIMIT_KEYS.length + PLAN_FEATURE_KEYS.length + 5 + 3);
    expect(limitTightens(null, 10)).toBe(true);
    expect(limitTightens(10, null)).toBe(false);
    expect(limitTightens(10, 5)).toBe(true);
    expect(limitTightens(5, 10)).toBe(false);
    expect(limitTightens(null, null)).toBe(false);
  });
});

describe("backfill verification", () => {
  const row = (over: Partial<EntitlementSnapshotRow> = {}): EntitlementSnapshotRow => ({
    companyId: 1,
    subscriptionId: 1,
    plan: "free",
    planVersionId: null,
    status: "trialing",
    billingSource: "manual",
    trialStartedAt: "2026-10-01T00:00:00.000Z",
    trialExpiresAt: "2026-10-15T00:00:00.000Z",
    currentPeriodStartsAt: null,
    currentPeriodEndsAt: null,
    cancelAtPeriodEnd: false,
    accessMode: "full",
    reasonCode: null,
    limitOverrides: { contacts: 3 },
    effective: LIMIT_RESOURCES.map((r) => ({ resource: r, limit: r === "contacts" ? 3 : null, source: r === "contacts" ? "override" : "unlimited" })),
    stripePriceId: null,
    stripeSubscriptionBound: false,
    ...over,
  });

  it("BEFORE/AFTER comparison ignores only the version reference and reports every other difference per tenant and field", () => {
    expect(compareSnapshots([row()], [row({ planVersionId: 7 })])).toEqual([]);
    const diffs = compareSnapshots([row(), row({ companyId: 2, subscriptionId: 2 })], [row({ planVersionId: 7, accessMode: "blocked", reasonCode: "TRIAL_ENDED" }), row({ companyId: 2, subscriptionId: 2, effective: LIMIT_RESOURCES.map((r) => ({ resource: r, limit: null, source: "unlimited" })) })]);
    expect(diffs.map((d) => `${d.companyId}:${d.field}`).sort()).toEqual(["1:accessMode", "1:reasonCode", "2:effective"]);
    expect(compareSnapshots([row()], [])).toEqual([{ companyId: 1, field: "row", before: "present", after: "missing" }]);
    expect(compareSnapshots([], [row()])).toEqual([{ companyId: 1, field: "row", before: "missing", after: "present" }]);
  });
});
