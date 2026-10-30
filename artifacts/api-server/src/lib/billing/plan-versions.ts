import {
  FEATURE_ENFORCEMENT_MODES,
  MANUAL_PRICE_INTERVALS,
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KEYS,
  TRIAL_END_OUTCOMES,
  type FeatureEnforcementMode,
  type ManualPriceInterval,
  type PlanFeatureKey,
  type PlanFeatureMatrix,
  type PlanLimitKey,
  type PlanTrialPolicy,
  type PlanVersionAllowances,
  type PlanVersionLimits,
  type PlanVersionManualPrice,
  type PlanVersionPriceSummary,
  type PlanVersionSnapshot,
} from "@workspace/db";
import { PLAN_IDS, type PlanLimitDefaults } from "./lifecycle.js";

// Batch 40 — PURE plan-version rules (no database access; unit-tested directly).
// Batch 41 (PB-3) adds the feature-enforcement mode, the AI allowances, the
// feature-entitlement resolution and the read-only trial grace rules.
//
//   • the fixed feature catalog (U2) — every snapshot carries all eight keys;
//   • limits (null = unlimited; integers 0..MAX_LIMIT);
//   • the structured trial policy (U5 default: blocked at the end, no grace);
//   • the version-1 snapshot built from a plan row's ACTUAL values (backfill);
//   • publication validation (what "valid" means before a draft can become an
//     immutable published version);
//   • version comparison rows for the owner UI.
//
// Nothing here decides entitlement: the single resolver (`resolveEffectiveLimits`
// in lifecycle.ts) keeps that role; `limitsAsPlanDefaults` only adapts a snapshot
// to the resolver's input shape.

export { FEATURE_ENFORCEMENT_MODES, MANUAL_PRICE_INTERVALS, PLAN_FEATURE_KEYS, PLAN_LIMIT_KEYS, TRIAL_END_OUTCOMES };
export type { FeatureEnforcementMode, ManualPriceInterval, PlanFeatureKey, PlanFeatureMatrix, PlanLimitKey, PlanTrialPolicy, PlanVersionAllowances, PlanVersionLimits, PlanVersionManualPrice, PlanVersionPriceSummary, PlanVersionSnapshot };

// New plan identities: lowercase slug, never one of the five fixed ids.
export const PLAN_SLUG_RE = /^[a-z][a-z0-9-]{1,39}$/;
export const FIXED_PLAN_IDS: ReadonlySet<string> = new Set<string>(PLAN_IDS);
export function isFixedPlanId(id: string): boolean {
  return FIXED_PLAN_IDS.has(id);
}
export function isPlanSlug(v: unknown): v is string {
  return typeof v === "string" && PLAN_SLUG_RE.test(v);
}

export const MAX_LIMIT = 1_000_000_000;
export const MAX_TRIAL_DAYS = 365;
export const MAX_GRACE_DAYS = 90;
export const MAX_NAME = 80;
export const MAX_DESCRIPTION = 500;
export const MAX_SORT_ORDER = 1000;

export const FEATURE_LABEL: Record<PlanFeatureKey, string> = {
  "ai.assistant": "AI Assistant",
  "ai.command_center": "AI Command Center",
  "workflow.intelligence": "Workflow Intelligence",
  "executive.intelligence": "Executive Intelligence",
  "exports.scheduled": "Scheduled exports",
  "nfc.capture": "NFC capture",
  documents: "Documents",
  "api.access": "API access",
};

export interface FieldIssue {
  code: string;
  field: string;
  message: string;
}
export interface ParseResult<T> {
  value: T;
  issues: FieldIssue[];
}

export function emptyFeatureMatrix(): PlanFeatureMatrix {
  return Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, false])) as PlanFeatureMatrix;
}
export function unlimitedLimits(): PlanVersionLimits {
  return Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, null])) as PlanVersionLimits;
}
export function defaultTrialPolicy(trialDays: number): PlanTrialPolicy {
  return { trialDays, eligible: true, oncePerCompany: true, endOutcome: "blocked", readOnlyGraceDays: 0 };
}
export function noAllowances(): PlanVersionAllowances {
  return { aiTokensPerMonth: null, aiCostMicroUsdPerMonth: null };
}
export const MAX_AI_TOKENS_PER_MONTH = 1_000_000_000_000;
export const MAX_AI_COST_MICRO_USD_PER_MONTH = 1_000_000 * 1_000_000; // 1,000,000 USD

// ── Batch 42 (PB-4.1 / D2): platform-managed price summaries ─────────────────
// A version may record up to MAX_MANUAL_PRICES manual prices (display + audit
// only; never billed by the product, never a provider identity). The same
// (currency, interval, intervalCount) period may appear once.
export const MAX_MANUAL_PRICES = 8;
export const MAX_PRICE_INTERVAL_COUNT = 12;
export const MAX_PRICE_MINOR = 1_000_000_000;
export const MAX_PRICE_LABEL = 60;
export const CURRENCY_RE = /^[a-z]{3}$/;

// Canonical period key of any price (provider or manual): currency/interval×count.
export function priceKey(p: { currency: string; interval: string; intervalCount: number }): string {
  return `${p.currency}/${p.interval}x${p.intervalCount}`;
}

function manualPriceOf(raw: unknown): PlanVersionManualPrice | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const interval = typeof o.interval === "string" && (MANUAL_PRICE_INTERVALS as readonly string[]).includes(o.interval) ? (o.interval as ManualPriceInterval) : null;
  const intervalCount = o.intervalCount === undefined ? 1 : o.intervalCount;
  const currency = typeof o.currency === "string" ? o.currency.trim().toLowerCase() : "";
  const label = o.label === undefined || o.label === null ? null : typeof o.label === "string" ? o.label.replace(/\s+/g, " ").trim() || null : undefined;
  if (!interval || !isIntInRange(intervalCount, 1, MAX_PRICE_INTERVAL_COUNT) || !CURRENCY_RE.test(currency) || !isIntInRange(o.unitAmountMinor, 0, MAX_PRICE_MINOR) || label === undefined || (label !== null && label.length > MAX_PRICE_LABEL)) return null;
  return { interval, intervalCount, currency, unitAmountMinor: o.unitAmountMinor, label };
}

// Stored snapshot → the valid manual prices (an absent / malformed field = none).
export function manualPricesOf(snapshot: Pick<PlanVersionSnapshot, "manualPrices"> | null | undefined): PlanVersionManualPrice[] {
  const raw = snapshot?.manualPrices;
  if (!Array.isArray(raw)) return [];
  const out: PlanVersionManualPrice[] = [];
  for (const r of raw) {
    const m = manualPriceOf(r);
    if (m) out.push(m);
  }
  return out;
}

// Draft editor input: the whole list is replaced; every rejected entry is reported.
export function parseManualPricesInput(input: unknown, base: PlanVersionManualPrice[]): ParseResult<PlanVersionManualPrice[]> {
  if (input === undefined) return { value: base, issues: [] };
  if (!Array.isArray(input)) return { value: base, issues: [{ code: "MANUAL_PRICES_INVALID", field: "manualPrices", message: "manualPrices must be an array" }] };
  const issues: FieldIssue[] = [];
  if (input.length > MAX_MANUAL_PRICES) issues.push({ code: "MANUAL_PRICES_TOO_MANY", field: "manualPrices", message: `at most ${MAX_MANUAL_PRICES} manual prices` });
  const value: PlanVersionManualPrice[] = [];
  const seen = new Set<string>();
  input.slice(0, MAX_MANUAL_PRICES).forEach((raw, i) => {
    const m = manualPriceOf(raw);
    if (!m) {
      issues.push({ code: "MANUAL_PRICE_INVALID", field: `manualPrices.${i}`, message: `manual price ${i} needs interval (${MANUAL_PRICE_INTERVALS.join("|")}), intervalCount 1–${MAX_PRICE_INTERVAL_COUNT}, a lowercase ISO-4217 currency, unitAmountMinor 0–${MAX_PRICE_MINOR} and an optional label (≤ ${MAX_PRICE_LABEL} chars)` });
      return;
    }
    const key = priceKey(m);
    if (seen.has(key)) {
      issues.push({ code: "MANUAL_PRICE_DUPLICATE", field: `manualPrices.${i}`, message: `manual price ${i} repeats the period ${key}` });
      return;
    }
    seen.add(key);
    value.push(m);
  });
  return { value: issues.length ? base : value, issues };
}

// ── Batch 41: feature enforcement (legacy / grandfathered vs explicitly enforced) ──
//
// THE legacy-compatibility rule (PB-3 / U2 "none gated until a version says so"):
//   • a snapshot WITHOUT `featureEnforcement` (every version-1 backfill snapshot
//     and every version published before Batch 41) is "legacy": its recorded
//     matrix — whose flags were normalized to false from the free-form plan row —
//     is NEVER interpreted as a denial. Every catalog feature stays allowed;
//   • a snapshot with `featureEnforcement: "enforced"` denies exactly the
//     features set to false in its matrix;
//   • a NULL version reference (pre-backfill subscription) is "legacy" too;
//   • the service layer maps an INVALID reference to `enforcement: "invalid"`
//     with every feature denied (fail closed, never widened) — see
//     lib/company-access.ts.
// A published snapshot is never rewritten to add the field: absence is meaning.

export type FeatureEnforcement = FeatureEnforcementMode | "invalid";

export interface FeatureEntitlements {
  enforcement: FeatureEnforcement;
  allowed: PlanFeatureMatrix;
  // The features the matrix would deny if (or because) it is enforced — the
  // owner UI shows these as "recorded only" for a legacy version.
  recordedDenials: PlanFeatureKey[];
}

export function featureEnforcementOf(snapshot: Pick<PlanVersionSnapshot, "featureEnforcement"> | null | undefined): FeatureEnforcementMode {
  return snapshot?.featureEnforcement === "enforced" ? "enforced" : "legacy";
}

export function allAllowedFeatures(): PlanFeatureMatrix {
  return Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, true])) as PlanFeatureMatrix;
}
export function allDeniedFeatures(): PlanFeatureMatrix {
  return emptyFeatureMatrix();
}

export function resolveFeatureEntitlements(snapshot: PlanVersionSnapshot | null | undefined): FeatureEntitlements {
  const matrix = featureMatrixFromRecord(snapshot?.features);
  const recordedDenials = PLAN_FEATURE_KEYS.filter((k) => matrix[k] === false);
  if (featureEnforcementOf(snapshot) === "enforced") return { enforcement: "enforced", allowed: matrix, recordedDenials };
  return { enforcement: "legacy", allowed: allAllowedFeatures(), recordedDenials };
}

export function invalidFeatureEntitlements(): FeatureEntitlements {
  return { enforcement: "invalid", allowed: allDeniedFeatures(), recordedDenials: [...PLAN_FEATURE_KEYS] };
}

// What a NEW draft seeded from `source` should carry so that switching the draft
// to "enforced" never silently denies what the source actually grants: a legacy
// source's EFFECTIVE matrix is all-true; an enforced source keeps its matrix.
export function effectiveFeatureMatrix(snapshot: PlanVersionSnapshot | null | undefined): PlanFeatureMatrix {
  return resolveFeatureEntitlements(snapshot).allowed;
}

export function allowancesOf(snapshot: Pick<PlanVersionSnapshot, "allowances"> | null | undefined): PlanVersionAllowances {
  const a = snapshot?.allowances;
  const int = (v: unknown, max: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : null);
  return { aiTokensPerMonth: int(a?.aiTokensPerMonth, MAX_AI_TOKENS_PER_MONTH), aiCostMicroUsdPerMonth: int(a?.aiCostMicroUsdPerMonth, MAX_AI_COST_MICRO_USD_PER_MONTH) };
}

// ── Batch 41: trial grace (U5) ───────────────────────────────────────────────
// A published version may configure `endOutcome: "read_only"` with a grace of
// 1..90 days: after the trial end the tenant is READ-ONLY until end + grace, then
// BLOCKED. The default (and every legacy / pre-Batch-41 policy) is blocked at the
// trial end with no grace. The entitlement decision itself lives in lifecycle.ts
// (`resolveEntitlement` takes the policy); this adapter is the only translation.
export function trialEndPolicyOf(policy: Pick<PlanTrialPolicy, "endOutcome" | "readOnlyGraceDays"> | null | undefined): { endOutcome: "blocked" | "read_only"; readOnlyGraceDays: number } {
  if (!policy || policy.endOutcome !== "read_only") return { endOutcome: "blocked", readOnlyGraceDays: 0 };
  const days = typeof policy.readOnlyGraceDays === "number" && Number.isInteger(policy.readOnlyGraceDays) && policy.readOnlyGraceDays >= 1 && policy.readOnlyGraceDays <= MAX_GRACE_DAYS ? policy.readOnlyGraceDays : 0;
  // read_only without a positive grace is meaningless → blocked (fail closed).
  return days > 0 ? { endOutcome: "read_only", readOnlyGraceDays: days } : { endOutcome: "blocked", readOnlyGraceDays: 0 };
}

// Tolerant conversion of the legacy `plans.features` jsonb (free-form flags; `{}`
// today) into the fixed matrix: known keys are kept, unknown keys are ignored.
export function featureMatrixFromRecord(input: unknown): PlanFeatureMatrix {
  const out = emptyFeatureMatrix();
  if (input && typeof input === "object") {
    for (const k of PLAN_FEATURE_KEYS) {
      const v = (input as Record<string, unknown>)[k];
      if (typeof v === "boolean") out[k] = v;
    }
  }
  return out;
}

function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

// ── Input parsing (draft editor). Every parser MERGES over a base value so a PATCH
//    can carry only the fields it changes; every rejected field is reported. ──

export function parseLimitsInput(input: unknown, base: PlanVersionLimits): ParseResult<PlanVersionLimits> {
  const value: PlanVersionLimits = { ...base };
  const issues: FieldIssue[] = [];
  if (input === undefined) return { value, issues };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { value, issues: [{ code: "LIMITS_INVALID", field: "limits", message: "limits must be an object" }] };
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(PLAN_LIMIT_KEYS as readonly string[]).includes(k)) {
      issues.push({ code: "LIMIT_UNKNOWN", field: `limits.${k}`, message: `unknown limit "${k}"` });
      continue;
    }
    if (v === null) value[k as PlanLimitKey] = null;
    else if (isIntInRange(v, 0, MAX_LIMIT)) value[k as PlanLimitKey] = v;
    else issues.push({ code: "LIMIT_INVALID", field: `limits.${k}`, message: `limit "${k}" must be null (unlimited) or an integer between 0 and ${MAX_LIMIT}` });
  }
  return { value, issues };
}

export function parseFeaturesInput(input: unknown, base: PlanFeatureMatrix): ParseResult<PlanFeatureMatrix> {
  const value: PlanFeatureMatrix = { ...base };
  const issues: FieldIssue[] = [];
  if (input === undefined) return { value, issues };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { value, issues: [{ code: "FEATURES_INVALID", field: "features", message: "features must be an object" }] };
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(PLAN_FEATURE_KEYS as readonly string[]).includes(k)) {
      issues.push({ code: "FEATURE_UNKNOWN", field: `features.${k}`, message: `"${k}" is not in the fixed feature catalog` });
      continue;
    }
    if (typeof v === "boolean") value[k as PlanFeatureKey] = v;
    else issues.push({ code: "FEATURE_INVALID", field: `features.${k}`, message: `feature "${k}" must be true or false` });
  }
  return { value, issues };
}

export function parseFeatureEnforcementInput(input: unknown, base: FeatureEnforcementMode): ParseResult<FeatureEnforcementMode> {
  if (input === undefined) return { value: base, issues: [] };
  if (typeof input === "string" && (FEATURE_ENFORCEMENT_MODES as readonly string[]).includes(input)) return { value: input as FeatureEnforcementMode, issues: [] };
  return { value: base, issues: [{ code: "FEATURE_ENFORCEMENT_INVALID", field: "featureEnforcement", message: `featureEnforcement must be one of ${FEATURE_ENFORCEMENT_MODES.join(", ")}` }] };
}

export function parseAllowancesInput(input: unknown, base: PlanVersionAllowances): ParseResult<PlanVersionAllowances> {
  const value: PlanVersionAllowances = { ...base };
  const issues: FieldIssue[] = [];
  if (input === undefined) return { value, issues };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { value, issues: [{ code: "ALLOWANCES_INVALID", field: "allowances", message: "allowances must be an object" }] };
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k !== "aiTokensPerMonth" && k !== "aiCostMicroUsdPerMonth") issues.push({ code: "ALLOWANCE_UNKNOWN", field: `allowances.${k}`, message: `unknown allowance "${k}"` });
  }
  if (o.aiTokensPerMonth !== undefined) {
    if (o.aiTokensPerMonth === null || isIntInRange(o.aiTokensPerMonth, 0, MAX_AI_TOKENS_PER_MONTH)) value.aiTokensPerMonth = o.aiTokensPerMonth as number | null;
    else issues.push({ code: "ALLOWANCE_INVALID", field: "allowances.aiTokensPerMonth", message: `aiTokensPerMonth must be null (no allowance) or an integer between 0 and ${MAX_AI_TOKENS_PER_MONTH}` });
  }
  if (o.aiCostMicroUsdPerMonth !== undefined) {
    if (o.aiCostMicroUsdPerMonth === null || isIntInRange(o.aiCostMicroUsdPerMonth, 0, MAX_AI_COST_MICRO_USD_PER_MONTH)) value.aiCostMicroUsdPerMonth = o.aiCostMicroUsdPerMonth as number | null;
    else issues.push({ code: "ALLOWANCE_INVALID", field: "allowances.aiCostMicroUsdPerMonth", message: `aiCostMicroUsdPerMonth must be null (no allowance) or an integer between 0 and ${MAX_AI_COST_MICRO_USD_PER_MONTH}` });
  }
  return { value, issues };
}

export function parseTrialPolicyInput(input: unknown, base: PlanTrialPolicy): ParseResult<PlanTrialPolicy> {
  const value: PlanTrialPolicy = { ...base };
  const issues: FieldIssue[] = [];
  if (input === undefined) return { value, issues };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { value, issues: [{ code: "TRIAL_POLICY_INVALID", field: "trialPolicy", message: "trialPolicy must be an object" }] };
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!["trialDays", "eligible", "oncePerCompany", "endOutcome", "readOnlyGraceDays"].includes(k)) issues.push({ code: "TRIAL_POLICY_UNKNOWN", field: `trialPolicy.${k}`, message: `unknown trial policy field "${k}"` });
  }
  if (o.trialDays !== undefined) {
    if (isIntInRange(o.trialDays, 0, MAX_TRIAL_DAYS)) value.trialDays = o.trialDays;
    else issues.push({ code: "TRIAL_DAYS_INVALID", field: "trialPolicy.trialDays", message: `trialDays must be an integer between 0 and ${MAX_TRIAL_DAYS}` });
  }
  if (o.eligible !== undefined) {
    if (typeof o.eligible === "boolean") value.eligible = o.eligible;
    else issues.push({ code: "TRIAL_ELIGIBLE_INVALID", field: "trialPolicy.eligible", message: "eligible must be true or false" });
  }
  if (o.oncePerCompany !== undefined) {
    if (typeof o.oncePerCompany === "boolean") value.oncePerCompany = o.oncePerCompany;
    else issues.push({ code: "TRIAL_ONCE_INVALID", field: "trialPolicy.oncePerCompany", message: "oncePerCompany must be true or false" });
  }
  if (o.endOutcome !== undefined) {
    if (typeof o.endOutcome === "string" && (TRIAL_END_OUTCOMES as readonly string[]).includes(o.endOutcome)) value.endOutcome = o.endOutcome as PlanTrialPolicy["endOutcome"];
    else issues.push({ code: "TRIAL_END_OUTCOME_INVALID", field: "trialPolicy.endOutcome", message: `endOutcome must be one of ${TRIAL_END_OUTCOMES.join(", ")}` });
  }
  if (o.readOnlyGraceDays !== undefined) {
    if (isIntInRange(o.readOnlyGraceDays, 0, MAX_GRACE_DAYS)) value.readOnlyGraceDays = o.readOnlyGraceDays;
    else issues.push({ code: "TRIAL_GRACE_INVALID", field: "trialPolicy.readOnlyGraceDays", message: `readOnlyGraceDays must be an integer between 0 and ${MAX_GRACE_DAYS}` });
  }
  return { value, issues };
}

export interface DisplayFields {
  name: string;
  description: string | null;
  sortOrder: number;
}

export function parseDisplayInput(input: Record<string, unknown>, base: DisplayFields): ParseResult<DisplayFields> {
  const value: DisplayFields = { ...base };
  const issues: FieldIssue[] = [];
  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
    if (name.length >= 1 && name.length <= MAX_NAME) value.name = name;
    else issues.push({ code: "NAME_INVALID", field: "name", message: `name must be 1–${MAX_NAME} characters` });
  }
  if (input.description !== undefined) {
    if (input.description === null) value.description = null;
    else if (typeof input.description === "string" && input.description.trim().length <= MAX_DESCRIPTION) value.description = input.description.trim() || null;
    else issues.push({ code: "DESCRIPTION_INVALID", field: "description", message: `description must be at most ${MAX_DESCRIPTION} characters` });
  }
  if (input.sortOrder !== undefined) {
    if (isIntInRange(input.sortOrder, 0, MAX_SORT_ORDER)) value.sortOrder = input.sortOrder;
    else issues.push({ code: "SORT_ORDER_INVALID", field: "sortOrder", message: `sortOrder must be an integer between 0 and ${MAX_SORT_ORDER}` });
  }
  return { value, issues };
}

// ── Snapshots ────────────────────────────────────────────────────────────────

export interface PlanRowLike {
  name: string;
  description: string | null;
  sortOrder: number;
  trialDays: number;
  features: unknown;
  contactsLimit: number | null;
  eventsLimit: number | null;
  adminsLimit: number | null;
  employeesLimit: number | null;
  scansLimit: number | null;
  storageLimitMb: number | null;
}

export interface PriceLike {
  id: number;
  interval: string;
  intervalCount: number;
  currency: string;
  unitAmountMinor: number;
  providerMode: string;
  nickname: string | null;
  active: boolean;
  verifiedAt: Date | null;
  // Batch 42: null / absent = plan-wide mapping; a value = bound to that version.
  planVersionId?: number | null;
}

export function limitsFromPlanRow(p: PlanRowLike): PlanVersionLimits {
  return { contacts: p.contactsLimit, events: p.eventsLimit, admins: p.adminsLimit, employees: p.employeesLimit, scans: p.scansLimit, storageMb: p.storageLimitMb };
}

export function priceSummary(p: PriceLike): PlanVersionPriceSummary {
  return { id: p.id, interval: p.interval, intervalCount: p.intervalCount, currency: p.currency, unitAmountMinor: p.unitAmountMinor, providerMode: p.providerMode, nickname: p.nickname, active: p.active, planVersionId: p.planVersionId ?? null };
}

// Version 1 = the plan row's ACTUAL current values (never the seed, never a default).
/**
 * Re-keys a stored snapshot in catalog order. Postgres jsonb returns object keys
 * in its own canonical order (by length, then bytes), so every read of a stored
 * snapshot goes through this to keep limits in PLAN_LIMIT_KEYS order and the
 * feature matrix in PLAN_FEATURE_KEYS order (stable API output and UI order).
 * Unknown feature keys are dropped (the catalog is fixed); missing ones are false.
 */
export function normalizeSnapshot(snapshot: PlanVersionSnapshot): PlanVersionSnapshot {
  const limits = {} as PlanVersionLimits;
  for (const k of PLAN_LIMIT_KEYS) limits[k] = snapshot.limits?.[k] ?? null;
  const out: PlanVersionSnapshot = {
    name: snapshot.name,
    description: snapshot.description ?? null,
    sortOrder: snapshot.sortOrder,
    limits,
    features: featureMatrixFromRecord(snapshot.features),
    prices: Array.isArray(snapshot.prices) ? snapshot.prices : [],
  };
  // Batch 41: the optional fields are carried ONLY when present and valid; an
  // absent field stays absent (legacy meaning preserved, nothing invented).
  if (snapshot.featureEnforcement === "enforced" || snapshot.featureEnforcement === "legacy") out.featureEnforcement = snapshot.featureEnforcement;
  if (snapshot.allowances && typeof snapshot.allowances === "object") out.allowances = allowancesOf(snapshot);
  // Batch 42: manual price summaries are carried ONLY when present (valid entries only).
  if (Array.isArray(snapshot.manualPrices)) out.manualPrices = manualPricesOf(snapshot);
  return out;
}

export function snapshotFromPlanRow(p: PlanRowLike, prices: PriceLike[]): PlanVersionSnapshot {
  return {
    name: p.name,
    description: p.description,
    sortOrder: p.sortOrder,
    limits: limitsFromPlanRow(p),
    features: featureMatrixFromRecord(p.features),
    prices: prices.map(priceSummary),
  };
}

// Adapter to the single resolver's plan-default input shape.
export function limitsAsPlanDefaults(l: PlanVersionLimits): PlanLimitDefaults {
  return { contactsLimit: l.contacts, eventsLimit: l.events, adminsLimit: l.admins, employeesLimit: l.employees, scansLimit: l.scans, storageLimitMb: l.storageMb };
}

// The plan-row columns that MIRROR a version (written only at publish / retire).
export function planRowMirrorFromSnapshot(s: PlanVersionSnapshot, t: PlanTrialPolicy) {
  return {
    name: s.name,
    description: s.description,
    sortOrder: s.sortOrder,
    trialDays: t.trialDays,
    features: { ...s.features },
    contactsLimit: s.limits.contacts,
    eventsLimit: s.limits.events,
    adminsLimit: s.limits.admins,
    employeesLimit: s.limits.employees,
    scansLimit: s.limits.scans,
    storageLimitMb: s.limits.storageMb,
  };
}

// ── Publication validation ───────────────────────────────────────────────────

export interface PublishValidationContext {
  configuredProviderMode: "test" | "live";
  // Active provider prices that apply to the candidate version (plan-wide or
  // bound to it). A version without any price is valid: platform-managed
  // (manual) billing needs no provider price.
  prices: PriceLike[];
}

export interface VersionValidation {
  ok: boolean;
  errors: FieldIssue[];
  warnings: FieldIssue[];
}

export function validateVersionForPublish(snapshot: PlanVersionSnapshot, trial: PlanTrialPolicy, ctx: PublishValidationContext): VersionValidation {
  const errors: FieldIssue[] = [];
  const warnings: FieldIssue[] = [];
  // Display
  if (!snapshot.name || snapshot.name.trim().length === 0 || snapshot.name.length > MAX_NAME) errors.push({ code: "NAME_INVALID", field: "name", message: "a published version needs a name" });
  if (snapshot.description != null && snapshot.description.length > MAX_DESCRIPTION) errors.push({ code: "DESCRIPTION_INVALID", field: "description", message: "description too long" });
  if (!isIntInRange(snapshot.sortOrder, 0, MAX_SORT_ORDER)) errors.push({ code: "SORT_ORDER_INVALID", field: "sortOrder", message: "sortOrder out of range" });
  // Limits: every key present, null or a bounded integer; a tenant must be able to
  // keep its primary admin (admins >= 1 when limited).
  for (const k of PLAN_LIMIT_KEYS) {
    const v = snapshot.limits?.[k];
    if (!(v === null || isIntInRange(v, 0, MAX_LIMIT))) errors.push({ code: "LIMIT_INVALID", field: `limits.${k}`, message: `limit "${k}" must be null or an integer between 0 and ${MAX_LIMIT}` });
  }
  if (snapshot.limits?.admins != null && snapshot.limits.admins < 1) errors.push({ code: "LIMIT_ADMINS_ZERO", field: "limits.admins", message: "an admins limit must allow at least the primary admin (>= 1)" });
  if (snapshot.limits?.storageMb != null) warnings.push({ code: "STORAGE_INFORMATIONAL", field: "limits.storageMb", message: "storage is informational until storage metering is approved (U3); it is not enforced" });
  // Features: exactly the fixed catalog.
  const featureKeys = Object.keys(snapshot.features ?? {});
  for (const k of PLAN_FEATURE_KEYS) {
    if (typeof snapshot.features?.[k] !== "boolean") errors.push({ code: "FEATURE_MISSING", field: `features.${k}`, message: `feature "${k}" must be set to true or false` });
  }
  for (const k of featureKeys) if (!(PLAN_FEATURE_KEYS as readonly string[]).includes(k)) errors.push({ code: "FEATURE_UNKNOWN", field: `features.${k}`, message: `"${k}" is not in the fixed feature catalog` });
  // Batch 41: enforcement mode + what it means for the recorded denials.
  if (snapshot.featureEnforcement !== undefined && !(FEATURE_ENFORCEMENT_MODES as readonly string[]).includes(snapshot.featureEnforcement)) errors.push({ code: "FEATURE_ENFORCEMENT_INVALID", field: "featureEnforcement", message: "featureEnforcement must be legacy or enforced" });
  const denied = PLAN_FEATURE_KEYS.filter((k) => snapshot.features?.[k] === false);
  if (denied.length > 0) {
    if (featureEnforcementOf(snapshot) === "enforced") warnings.push({ code: "FEATURES_ENFORCED_DENIALS", field: "features", message: `subscribers of this version will be DENIED: ${denied.join(", ")}` });
    else warnings.push({ code: "FEATURES_NOT_ENFORCED", field: "features", message: "feature enforcement is legacy (grandfathered): the disabled features are recorded only and every subscriber keeps access; set featureEnforcement to enforced to gate them" });
  }
  // Batch 41: AI allowances (null = none; integers within bounds).
  if (snapshot.allowances !== undefined) {
    const a = snapshot.allowances as unknown as Record<string, unknown> | null;
    if (!a || typeof a !== "object") errors.push({ code: "ALLOWANCES_INVALID", field: "allowances", message: "allowances must be an object" });
    else {
      if (!(a.aiTokensPerMonth === null || isIntInRange(a.aiTokensPerMonth, 0, MAX_AI_TOKENS_PER_MONTH))) errors.push({ code: "ALLOWANCE_INVALID", field: "allowances.aiTokensPerMonth", message: "aiTokensPerMonth must be null or a bounded non-negative integer" });
      if (!(a.aiCostMicroUsdPerMonth === null || isIntInRange(a.aiCostMicroUsdPerMonth, 0, MAX_AI_COST_MICRO_USD_PER_MONTH))) errors.push({ code: "ALLOWANCE_INVALID", field: "allowances.aiCostMicroUsdPerMonth", message: "aiCostMicroUsdPerMonth must be null or a bounded non-negative integer" });
    }
  }
  // Trial policy: complete and consistent with the approved end-of-trial rule.
  if (!isIntInRange(trial?.trialDays, 0, MAX_TRIAL_DAYS)) errors.push({ code: "TRIAL_DAYS_INVALID", field: "trialPolicy.trialDays", message: "trialDays must be an integer between 0 and 365" });
  if (typeof trial?.eligible !== "boolean") errors.push({ code: "TRIAL_ELIGIBLE_INVALID", field: "trialPolicy.eligible", message: "eligible must be set" });
  if (typeof trial?.oncePerCompany !== "boolean") errors.push({ code: "TRIAL_ONCE_INVALID", field: "trialPolicy.oncePerCompany", message: "oncePerCompany must be set" });
  if (!(TRIAL_END_OUTCOMES as readonly string[]).includes(trial?.endOutcome)) errors.push({ code: "TRIAL_END_OUTCOME_INVALID", field: "trialPolicy.endOutcome", message: "endOutcome must be set" });
  if (!isIntInRange(trial?.readOnlyGraceDays, 0, MAX_GRACE_DAYS)) errors.push({ code: "TRIAL_GRACE_INVALID", field: "trialPolicy.readOnlyGraceDays", message: "readOnlyGraceDays must be an integer between 0 and 90" });
  if (trial?.endOutcome === "blocked" && trial?.readOnlyGraceDays > 0) errors.push({ code: "TRIAL_GRACE_INCONSISTENT", field: "trialPolicy.readOnlyGraceDays", message: "a blocked end-of-trial outcome cannot carry a read-only grace period" });
  // Batch 41 (U5): a read-only outcome needs a positive grace (1..90 days); the
  // default stays blocked with 0 days.
  if (trial?.endOutcome === "read_only" && !(isIntInRange(trial?.readOnlyGraceDays, 1, MAX_GRACE_DAYS))) errors.push({ code: "TRIAL_GRACE_REQUIRED", field: "trialPolicy.readOnlyGraceDays", message: "a read-only end-of-trial outcome needs a grace period of 1 to 90 days" });
  if (trial?.endOutcome === "read_only" && isIntInRange(trial?.readOnlyGraceDays, 1, MAX_GRACE_DAYS)) warnings.push({ code: "TRIAL_READ_ONLY_GRACE", field: "trialPolicy.endOutcome", message: `subscribers of this version get ${trial.readOnlyGraceDays} read-only day(s) after the trial ends before they are blocked` });
  if (trial?.eligible && trial?.trialDays === 0) warnings.push({ code: "TRIAL_ZERO_DAYS", field: "trialPolicy.trialDays", message: "trials are eligible but 0 days long" });
  // Prices: every ACTIVE price applying to this version must be verified in the
  // provider mode the platform is configured for. Batch 42: the applicable set
  // (plan-wide + bound to this version) must also be CONSISTENT — one active
  // provider price per (currency, interval, count) period; an inconsistent set
  // would make the checkout offer ambiguous.
  const activePeriods = new Map<string, number>();
  for (const p of ctx.prices) {
    if (!p.active) continue;
    if (!p.verifiedAt) errors.push({ code: "PRICE_UNVERIFIED", field: `prices.${p.id}`, message: `price ${p.id} is not provider-verified` });
    if (p.providerMode !== ctx.configuredProviderMode) errors.push({ code: "PRICE_MODE_MISMATCH", field: `prices.${p.id}`, message: `price ${p.id} was verified in ${p.providerMode} mode; the platform runs in ${ctx.configuredProviderMode} mode` });
    if (!(MANUAL_PRICE_INTERVALS as readonly string[]).includes(p.interval) || !isIntInRange(p.intervalCount, 1, MAX_PRICE_INTERVAL_COUNT) || !CURRENCY_RE.test(p.currency) || !isIntInRange(p.unitAmountMinor, 0, MAX_PRICE_MINOR)) {
      errors.push({ code: "PRICE_INCONSISTENT", field: `prices.${p.id}`, message: `price ${p.id} carries an interval / currency / amount outside the supported range` });
      continue;
    }
    const key = priceKey(p);
    const other = activePeriods.get(key);
    if (other != null) errors.push({ code: "PRICE_DUPLICATE_PERIOD", field: `prices.${p.id}`, message: `price ${p.id} and price ${other} both offer ${key}; deactivate one of them` });
    else activePeriods.set(key, p.id);
  }
  // Batch 42 (D2): manual price summaries must be well formed and unique per period;
  // a manual price on a period that an active provider price also offers is allowed
  // (the provider price is the online offer, the manual one the operator's) but reported.
  if (snapshot.manualPrices !== undefined) {
    if (!Array.isArray(snapshot.manualPrices)) errors.push({ code: "MANUAL_PRICES_INVALID", field: "manualPrices", message: "manualPrices must be an array" });
    else {
      if (snapshot.manualPrices.length > MAX_MANUAL_PRICES) errors.push({ code: "MANUAL_PRICES_TOO_MANY", field: "manualPrices", message: `at most ${MAX_MANUAL_PRICES} manual prices` });
      const seen = new Set<string>();
      snapshot.manualPrices.forEach((raw, i) => {
        const m = manualPriceOf(raw);
        if (!m) {
          errors.push({ code: "MANUAL_PRICE_INVALID", field: `manualPrices.${i}`, message: `manual price ${i} is malformed` });
          return;
        }
        const key = priceKey(m);
        if (seen.has(key)) errors.push({ code: "MANUAL_PRICE_DUPLICATE", field: `manualPrices.${i}`, message: `manual price ${i} repeats the period ${key}` });
        seen.add(key);
        if (activePeriods.has(key)) warnings.push({ code: "MANUAL_PRICE_SHADOWED", field: `manualPrices.${i}`, message: `manual price ${i} (${key}) has an active provider price for the same period; online checkout uses the provider price` });
      });
    }
  }
  if (!ctx.prices.some((p) => p.active)) warnings.push({ code: "NO_PROVIDER_PRICE", field: "prices", message: "no active provider price applies to this version; it can only be assigned by the platform owner (manual billing) and is not offered through checkout" });
  return { ok: errors.length === 0, errors, warnings };
}

// ── Comparison ───────────────────────────────────────────────────────────────

export type CompareValue = string | number | boolean | null;
export interface CompareRow {
  group: "display" | "limits" | "features" | "trialPolicy" | "enforcement" | "allowances" | "pricing";
  field: string;
  left: CompareValue;
  right: CompareValue;
  changed: boolean;
}

export interface VersionContent {
  snapshot: PlanVersionSnapshot;
  trialPolicy: PlanTrialPolicy;
}

export function compareVersions(a: VersionContent, b: VersionContent): CompareRow[] {
  const rows: CompareRow[] = [];
  const push = (group: CompareRow["group"], field: string, left: CompareValue, right: CompareValue) => rows.push({ group, field, left, right, changed: left !== right });
  push("display", "name", a.snapshot.name, b.snapshot.name);
  push("display", "description", a.snapshot.description ?? null, b.snapshot.description ?? null);
  push("display", "sortOrder", a.snapshot.sortOrder, b.snapshot.sortOrder);
  for (const k of PLAN_LIMIT_KEYS) push("limits", k, a.snapshot.limits?.[k] ?? null, b.snapshot.limits?.[k] ?? null);
  for (const k of PLAN_FEATURE_KEYS) push("features", k, a.snapshot.features?.[k] ?? false, b.snapshot.features?.[k] ?? false);
  push("enforcement", "featureEnforcement", featureEnforcementOf(a.snapshot), featureEnforcementOf(b.snapshot));
  push("allowances", "aiTokensPerMonth", allowancesOf(a.snapshot).aiTokensPerMonth, allowancesOf(b.snapshot).aiTokensPerMonth);
  push("allowances", "aiCostMicroUsdPerMonth", allowancesOf(a.snapshot).aiCostMicroUsdPerMonth, allowancesOf(b.snapshot).aiCostMicroUsdPerMonth);
  push("trialPolicy", "trialDays", a.trialPolicy.trialDays, b.trialPolicy.trialDays);
  push("trialPolicy", "eligible", a.trialPolicy.eligible, b.trialPolicy.eligible);
  push("trialPolicy", "oncePerCompany", a.trialPolicy.oncePerCompany, b.trialPolicy.oncePerCompany);
  push("trialPolicy", "endOutcome", a.trialPolicy.endOutcome, b.trialPolicy.endOutcome);
  push("trialPolicy", "readOnlyGraceDays", a.trialPolicy.readOnlyGraceDays, b.trialPolicy.readOnlyGraceDays);
  // Batch 42: manual price summaries compare as a canonical, period-sorted text.
  push("pricing", "manualPrices", manualPricesText(a.snapshot), manualPricesText(b.snapshot));
  return rows;
}

export function manualPricesText(snapshot: Pick<PlanVersionSnapshot, "manualPrices"> | null | undefined): string {
  const rows = manualPricesOf(snapshot)
    .map((m) => `${priceKey(m)}=${m.unitAmountMinor}${m.label ? ` (${m.label})` : ""}`)
    .sort();
  return rows.length ? rows.join("; ") : "—";
}

// A limit "tightens" when the right side is lower than the left (unlimited = +∞).
export function limitTightens(left: number | null, right: number | null): boolean {
  if (right == null) return false;
  if (left == null) return true;
  return right < left;
}
