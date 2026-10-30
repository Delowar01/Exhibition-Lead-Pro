import { describe, it, expect } from "vitest";
import {
  PLAN_FEATURE_KEYS,
  allowancesOf,
  compareVersions,
  defaultTrialPolicy,
  effectiveFeatureMatrix,
  emptyFeatureMatrix,
  featureEnforcementOf,
  invalidFeatureEntitlements,
  noAllowances,
  parseAllowancesInput,
  parseFeatureEnforcementInput,
  resolveFeatureEntitlements,
  trialEndPolicyOf,
  unlimitedLimits,
  validateVersionForPublish,
  normalizeSnapshot,
  MAX_AI_TOKENS_PER_MONTH,
  type PlanVersionSnapshot,
  type PriceLike,
} from "../src/lib/billing/plan-versions.js";
import { resolveEntitlement, trialGraceEndsAt, DEFAULT_TRIAL_END_POLICY } from "../src/lib/billing/lifecycle.js";
import { applyPlanAllowance } from "../src/services/ai.service.js";
import { snapshotHasIntegrityError, compareSnapshots, type EntitlementSnapshotRow } from "../src/lib/billing/version-backfill.js";

// Batch 41 — PURE rules (no database, no HTTP): the legacy / enforced
// distinction, the invalid-reference fail-closed matrix, AI allowance
// precedence, the trial end policy with its exact time boundaries, publication
// validation and the backfill parity rules.

const okSnapshot = (over: Partial<PlanVersionSnapshot> = {}): PlanVersionSnapshot => ({ name: "Growth", description: null, sortOrder: 10, limits: { ...unlimitedLimits(), contacts: 1000, admins: 3 }, features: emptyFeatureMatrix(), prices: [], ...over });
const ctx = { configuredProviderMode: "test" as const, prices: [] as PriceLike[] };
const allOn = () => Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, true])) as Record<(typeof PLAN_FEATURE_KEYS)[number], boolean>;

describe("legacy vs enforced feature entitlements", () => {
  it("a snapshot without featureEnforcement (every version published before Batch 41, flags normalized to false in Batch 40) is LEGACY: every feature allowed", () => {
    const legacy = resolveFeatureEntitlements(okSnapshot()); // all flags false, no mode
    expect(featureEnforcementOf(okSnapshot())).toBe("legacy");
    expect(legacy.enforcement).toBe("legacy");
    for (const k of PLAN_FEATURE_KEYS) expect(legacy.allowed[k], k).toBe(true);
    expect(legacy.recordedDenials).toEqual([...PLAN_FEATURE_KEYS]);
    expect(resolveFeatureEntitlements(null).enforcement).toBe("legacy");
    expect(resolveFeatureEntitlements(undefined).allowed["documents"]).toBe(true);
  });

  it("an explicit legacy mode behaves exactly like absence; an enforced mode applies the recorded matrix verbatim", () => {
    const flags = { ...allOn(), documents: false, "nfc.capture": false };
    const legacy = resolveFeatureEntitlements(okSnapshot({ features: flags, featureEnforcement: "legacy" }));
    expect(legacy.enforcement).toBe("legacy");
    expect(legacy.allowed.documents).toBe(true);
    expect(legacy.recordedDenials).toEqual(["nfc.capture", "documents"]);
    const enforced = resolveFeatureEntitlements(okSnapshot({ features: flags, featureEnforcement: "enforced" }));
    expect(enforced.enforcement).toBe("enforced");
    expect(enforced.allowed.documents).toBe(false);
    expect(enforced.allowed["nfc.capture"]).toBe(false);
    expect(enforced.allowed["ai.assistant"]).toBe(true);
    expect(enforced.recordedDenials).toEqual(["nfc.capture", "documents"]);
  });

  it("an invalid version reference denies EVERY feature (fail closed, never widened)", () => {
    const invalid = invalidFeatureEntitlements();
    expect(invalid.enforcement).toBe("invalid");
    for (const k of PLAN_FEATURE_KEYS) expect(invalid.allowed[k], k).toBe(false);
    expect(invalid.recordedDenials).toEqual([...PLAN_FEATURE_KEYS]);
  });

  it("a draft seeded from a legacy source carries the EFFECTIVE (all-true) matrix so that switching it to enforced never silently denies what the source grants", () => {
    expect(effectiveFeatureMatrix(okSnapshot())).toEqual(allOn());
    const enforcedSource = okSnapshot({ features: { ...allOn(), documents: false }, featureEnforcement: "enforced" });
    expect(effectiveFeatureMatrix(enforcedSource).documents).toBe(false);
  });

  it("the enforcement input accepts only the two modes; absence keeps the base; the normalized snapshot carries the mode only when valid", () => {
    expect(parseFeatureEnforcementInput(undefined, "legacy")).toEqual({ value: "legacy", issues: [] });
    expect(parseFeatureEnforcementInput("enforced", "legacy").value).toBe("enforced");
    const bad = parseFeatureEnforcementInput("strict", "legacy");
    expect(bad.value).toBe("legacy");
    expect(bad.issues.map((i) => i.code)).toEqual(["FEATURE_ENFORCEMENT_INVALID"]);
    expect(normalizeSnapshot(okSnapshot()).featureEnforcement).toBeUndefined();
    expect(normalizeSnapshot(okSnapshot({ featureEnforcement: "enforced" })).featureEnforcement).toBe("enforced");
    expect(normalizeSnapshot(okSnapshot({ featureEnforcement: "bogus" as never })).featureEnforcement).toBeUndefined();
  });

  it("publication validation: an enforced version with denials warns FEATURES_ENFORCED_DENIALS; a legacy one warns FEATURES_NOT_ENFORCED; an invalid mode is an error", () => {
    const flags = { ...allOn(), documents: false };
    const enforced = validateVersionForPublish(okSnapshot({ features: flags, featureEnforcement: "enforced" }), defaultTrialPolicy(14), ctx);
    expect(enforced.ok).toBe(true);
    expect(enforced.warnings.map((w) => w.code)).toContain("FEATURES_ENFORCED_DENIALS");
    expect(enforced.warnings.map((w) => w.code)).not.toContain("FEATURES_NOT_ENFORCED");
    const legacy = validateVersionForPublish(okSnapshot({ features: flags }), defaultTrialPolicy(14), ctx);
    expect(legacy.warnings.map((w) => w.code)).toContain("FEATURES_NOT_ENFORCED");
    const clean = validateVersionForPublish(okSnapshot({ features: allOn(), featureEnforcement: "enforced" }), defaultTrialPolicy(14), ctx);
    expect(clean.warnings.map((w) => w.code)).not.toContain("FEATURES_ENFORCED_DENIALS");
    const invalid = validateVersionForPublish(okSnapshot({ featureEnforcement: "strict" as never }), defaultTrialPolicy(14), ctx);
    expect(invalid.errors.map((e) => e.code)).toContain("FEATURE_ENFORCEMENT_INVALID");
  });

  it("comparison reports enforcement and allowance differences as their own groups", () => {
    const a = { snapshot: okSnapshot(), trialPolicy: defaultTrialPolicy(14) };
    const b = { snapshot: okSnapshot({ featureEnforcement: "enforced", allowances: { aiTokensPerMonth: 5000, aiCostMicroUsdPerMonth: null } }), trialPolicy: defaultTrialPolicy(14) };
    const rows = compareVersions(a, b);
    const enf = rows.find((r) => r.group === "enforcement" && r.field === "featureEnforcement")!;
    expect(enf).toMatchObject({ left: "legacy", right: "enforced", changed: true });
    const tokens = rows.find((r) => r.group === "allowances" && r.field === "aiTokensPerMonth")!;
    expect(tokens).toMatchObject({ left: null, right: 5000, changed: true });
    const cost = rows.find((r) => r.group === "allowances" && r.field === "aiCostMicroUsdPerMonth")!;
    expect(cost).toMatchObject({ left: null, right: null, changed: false });
  });
});

describe("AI / OCR allowances (U4)", () => {
  it("allowances are bounded non-negative integers or null; anything else reads as no allowance", () => {
    expect(allowancesOf(null)).toEqual(noAllowances());
    expect(allowancesOf({ allowances: { aiTokensPerMonth: 1000, aiCostMicroUsdPerMonth: 2_500_000 } })).toEqual({ aiTokensPerMonth: 1000, aiCostMicroUsdPerMonth: 2_500_000 });
    expect(allowancesOf({ allowances: { aiTokensPerMonth: -1, aiCostMicroUsdPerMonth: 1.5 } as never })).toEqual(noAllowances());
    expect(allowancesOf({ allowances: { aiTokensPerMonth: MAX_AI_TOKENS_PER_MONTH + 1, aiCostMicroUsdPerMonth: "x" } as never })).toEqual(noAllowances());
  });

  it("allowance input: partial merge, null clears, unknown keys and out-of-range values are issues", () => {
    const base = { aiTokensPerMonth: 10, aiCostMicroUsdPerMonth: 20 };
    expect(parseAllowancesInput(undefined, base)).toEqual({ value: base, issues: [] });
    expect(parseAllowancesInput({ aiTokensPerMonth: null }, base).value).toEqual({ aiTokensPerMonth: null, aiCostMicroUsdPerMonth: 20 });
    expect(parseAllowancesInput({ aiCostMicroUsdPerMonth: 30 }, base).value).toEqual({ aiTokensPerMonth: 10, aiCostMicroUsdPerMonth: 30 });
    expect(parseAllowancesInput({ ocr: 5 }, base).issues.map((i) => i.code)).toEqual(["ALLOWANCE_UNKNOWN"]);
    expect(parseAllowancesInput({ aiTokensPerMonth: -5 }, base).issues.map((i) => i.code)).toEqual(["ALLOWANCE_INVALID"]);
    expect(parseAllowancesInput("nope", base).issues.map((i) => i.code)).toEqual(["ALLOWANCES_INVALID"]);
    const v = validateVersionForPublish(okSnapshot({ allowances: { aiTokensPerMonth: 2.5, aiCostMicroUsdPerMonth: null } as never }), defaultTrialPolicy(14), ctx);
    expect(v.errors.map((e) => e.code)).toContain("ALLOWANCE_INVALID");
  });

  it("precedence: a tenant's own (non-null) budget wins, else the plan allowance, else none — per budget independently", () => {
    const plan = { planVersionId: 9, aiTokensPerMonth: 5000, aiCostMicroUsdPerMonth: 1_000_000 };
    const tenantWins = applyPlanAllowance({ monthlyTokenBudget: 100, monthlyCostBudgetMicroUsd: 200 }, plan);
    expect(tenantWins).toMatchObject({ monthlyTokenBudget: 100, monthlyCostBudgetMicroUsd: 200, budgetSource: { tokens: "tenant", cost: "tenant" } });
    const planWins = applyPlanAllowance({ monthlyTokenBudget: null, monthlyCostBudgetMicroUsd: null }, plan);
    expect(planWins).toMatchObject({ monthlyTokenBudget: 5000, monthlyCostBudgetMicroUsd: 1_000_000, budgetSource: { tokens: "plan", cost: "plan" }, planAllowance: plan });
    const mixed = applyPlanAllowance({ monthlyTokenBudget: 100, monthlyCostBudgetMicroUsd: null }, plan);
    expect(mixed).toMatchObject({ monthlyTokenBudget: 100, monthlyCostBudgetMicroUsd: 1_000_000, budgetSource: { tokens: "tenant", cost: "plan" } });
    const none = applyPlanAllowance({ monthlyTokenBudget: null, monthlyCostBudgetMicroUsd: null }, { planVersionId: null, aiTokensPerMonth: null, aiCostMicroUsdPerMonth: null });
    expect(none).toMatchObject({ monthlyTokenBudget: null, monthlyCostBudgetMicroUsd: null, budgetSource: { tokens: "none", cost: "none" } });
    // A legacy version (no allowance) changes nothing for a tenant without its own budget.
    const legacy = applyPlanAllowance({ monthlyTokenBudget: null, monthlyCostBudgetMicroUsd: null }, { planVersionId: 3, ...noAllowances() });
    expect(legacy.monthlyTokenBudget).toBeNull();
    expect(legacy.budgetSource).toEqual({ tokens: "none", cost: "none" });
  });
});

describe("trial end policy (U5) — exact time boundaries", () => {
  const trialEnd = new Date("2026-11-01T12:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;
  const sub = { status: "trialing", trialExpiresAt: trialEnd };
  const readOnly3 = { endOutcome: "read_only" as const, readOnlyGraceDays: 3 };

  it("the default policy is blocked with 0 grace and the legacy / absent policy maps to it; read_only needs 1..90 days", () => {
    expect(DEFAULT_TRIAL_END_POLICY).toEqual({ endOutcome: "blocked", readOnlyGraceDays: 0 });
    expect(trialEndPolicyOf(null)).toEqual({ endOutcome: "blocked", readOnlyGraceDays: 0 });
    expect(trialEndPolicyOf({ endOutcome: "blocked", readOnlyGraceDays: 0 })).toEqual({ endOutcome: "blocked", readOnlyGraceDays: 0 });
    expect(trialEndPolicyOf({ endOutcome: "read_only", readOnlyGraceDays: 3 })).toEqual({ endOutcome: "read_only", readOnlyGraceDays: 3 });
    expect(trialEndPolicyOf({ endOutcome: "read_only", readOnlyGraceDays: 0 })).toEqual({ endOutcome: "blocked", readOnlyGraceDays: 0 });
    expect(trialEndPolicyOf({ endOutcome: "read_only", readOnlyGraceDays: 91 })).toEqual({ endOutcome: "blocked", readOnlyGraceDays: 0 });
    expect(trialGraceEndsAt(trialEnd).getTime()).toBe(trialEnd.getTime());
    expect(trialGraceEndsAt(trialEnd, readOnly3).getTime()).toBe(trialEnd.getTime() + 3 * DAY);
  });

  it("default (blocked): full until the trial end, blocked from the exact end instant onwards", () => {
    expect(resolveEntitlement(sub, new Date(trialEnd.getTime() - 1))).toMatchObject({ accessMode: "full", reasonCode: null });
    expect(resolveEntitlement(sub, trialEnd)).toMatchObject({ accessMode: "blocked", reasonCode: "TRIAL_ENDED" });
    expect(resolveEntitlement(sub, new Date(trialEnd.getTime() + 2 * DAY))).toMatchObject({ accessMode: "blocked", reasonCode: "TRIAL_ENDED" });
  });

  it("read-only grace: full before the end, read-only from the end until the grace end (exclusive), blocked from the grace end", () => {
    expect(resolveEntitlement(sub, new Date(trialEnd.getTime() - 1), readOnly3)).toMatchObject({ accessMode: "full" });
    expect(resolveEntitlement(sub, trialEnd, readOnly3)).toMatchObject({ accessMode: "read_only", reasonCode: "TRIAL_ENDED_GRACE" });
    expect(resolveEntitlement(sub, new Date(trialEnd.getTime() + 3 * DAY - 1), readOnly3)).toMatchObject({ accessMode: "read_only", reasonCode: "TRIAL_ENDED_GRACE" });
    expect(resolveEntitlement(sub, new Date(trialEnd.getTime() + 3 * DAY), readOnly3)).toMatchObject({ accessMode: "blocked", reasonCode: "TRIAL_ENDED" });
  });

  it("the policy only matters for a trialing subscription with a trial end; every other status keeps its existing resolution", () => {
    expect(resolveEntitlement({ status: "trialing", trialExpiresAt: null }, new Date(), readOnly3).accessMode).toBe("full");
    expect(resolveEntitlement({ status: "active", trialExpiresAt: new Date(0) }, new Date(), readOnly3).accessMode).toBe("full");
    expect(resolveEntitlement({ status: "past_due", trialExpiresAt: null }, new Date(), readOnly3)).toMatchObject({ accessMode: "read_only", reasonCode: "PAST_DUE" });
    expect(resolveEntitlement({ status: "expired", trialExpiresAt: new Date(0) }, new Date(), readOnly3)).toMatchObject({ accessMode: "blocked", reasonCode: "SUBSCRIPTION_EXPIRED" });
    expect(resolveEntitlement({ status: "suspended", trialExpiresAt: null }, new Date(), readOnly3).accessMode).toBe("blocked");
  });
});

describe("backfill parity rules (Batch 41 hardening)", () => {
  const row = (over: Partial<EntitlementSnapshotRow> = {}): EntitlementSnapshotRow => ({
    companyId: 1,
    subscriptionId: 10,
    plan: "free",
    planVersionId: null,
    status: "trialing",
    billingSource: "manual",
    trialStartedAt: null,
    trialExpiresAt: null,
    currentPeriodStartsAt: null,
    currentPeriodEndsAt: null,
    cancelAtPeriodEnd: false,
    accessMode: "full",
    reasonCode: null,
    limitOverrides: {},
    effective: [{ resource: "contacts", limit: 5, source: "plan" }],
    stripePriceId: null,
    stripeSubscriptionBound: false,
    featureEnforcement: "legacy",
    features: allOn(),
    trialPolicy: { endOutcome: "blocked", readOnlyGraceDays: 0 },
    ...over,
  });

  it("an integrity error in either snapshot is never parity: it is reported as a mismatch even when both sides carry the same error", () => {
    const broken = row({ effective: { error: "SUBSCRIPTION_PLAN_VERSION_INVALID" } });
    expect(snapshotHasIntegrityError(broken)).toBe(true);
    expect(snapshotHasIntegrityError(row())).toBe(false);
    const same = compareSnapshots([broken], [broken]);
    expect(same.map((m) => m.field)).toContain("effective.integrity");
    const afterBroken = compareSnapshots([row()], [broken]);
    expect(afterBroken.map((m) => m.field)).toContain("effective.integrity");
  });

  it("feature entitlements and the trial policy are part of the compared contract (a pin that changed access is a mismatch)", () => {
    const after = row({ planVersionId: 5, features: { ...allOn(), documents: false }, featureEnforcement: "enforced" });
    const fields = compareSnapshots([row()], [after]).map((m) => m.field);
    expect(fields).toContain("features");
    expect(fields).toContain("featureEnforcement");
    const grace = row({ planVersionId: 5, trialPolicy: { endOutcome: "read_only", readOnlyGraceDays: 3 } });
    expect(compareSnapshots([row()], [grace]).map((m) => m.field)).toContain("trialPolicy");
    // The version reference itself is allowed to change (that is the backfill); everything else must not.
    expect(compareSnapshots([row()], [row({ planVersionId: 5 })])).toEqual([]);
  });
});
