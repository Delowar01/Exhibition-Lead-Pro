import {
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KEYS,
  TRIAL_END_OUTCOMES,
  type PlanFeatureKey,
  type PlanFeatureMatrix,
  type PlanLimitKey,
  type PlanTrialPolicy,
  type PlanVersionLimits,
  type PlanVersionPriceSummary,
  type PlanVersionSnapshot,
} from "@workspace/db";
import { PLAN_IDS, type PlanLimitDefaults } from "./lifecycle.js";

// Batch 40 — PURE plan-version rules (no database access; unit-tested directly).
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

export { PLAN_FEATURE_KEYS, PLAN_LIMIT_KEYS, TRIAL_END_OUTCOMES };
export type { PlanFeatureKey, PlanFeatureMatrix, PlanLimitKey, PlanTrialPolicy, PlanVersionLimits, PlanVersionPriceSummary, PlanVersionSnapshot };

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
}

export function limitsFromPlanRow(p: PlanRowLike): PlanVersionLimits {
  return { contacts: p.contactsLimit, events: p.eventsLimit, admins: p.adminsLimit, employees: p.employeesLimit, scans: p.scansLimit, storageMb: p.storageLimitMb };
}

export function priceSummary(p: PriceLike): PlanVersionPriceSummary {
  return { id: p.id, interval: p.interval, intervalCount: p.intervalCount, currency: p.currency, unitAmountMinor: p.unitAmountMinor, providerMode: p.providerMode, nickname: p.nickname, active: p.active };
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
  return {
    name: snapshot.name,
    description: snapshot.description ?? null,
    sortOrder: snapshot.sortOrder,
    limits,
    features: featureMatrixFromRecord(snapshot.features),
    prices: Array.isArray(snapshot.prices) ? snapshot.prices : [],
  };
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
  if (PLAN_FEATURE_KEYS.some((k) => snapshot.features?.[k] === false)) warnings.push({ code: "FEATURES_NOT_ENFORCED", field: "features", message: "feature gating (PB-3) is not enabled; disabled features are recorded but not enforced against tenants" });
  // Trial policy: complete and consistent with the approved end-of-trial rule.
  if (!isIntInRange(trial?.trialDays, 0, MAX_TRIAL_DAYS)) errors.push({ code: "TRIAL_DAYS_INVALID", field: "trialPolicy.trialDays", message: "trialDays must be an integer between 0 and 365" });
  if (typeof trial?.eligible !== "boolean") errors.push({ code: "TRIAL_ELIGIBLE_INVALID", field: "trialPolicy.eligible", message: "eligible must be set" });
  if (typeof trial?.oncePerCompany !== "boolean") errors.push({ code: "TRIAL_ONCE_INVALID", field: "trialPolicy.oncePerCompany", message: "oncePerCompany must be set" });
  if (!(TRIAL_END_OUTCOMES as readonly string[]).includes(trial?.endOutcome)) errors.push({ code: "TRIAL_END_OUTCOME_INVALID", field: "trialPolicy.endOutcome", message: "endOutcome must be set" });
  if (!isIntInRange(trial?.readOnlyGraceDays, 0, MAX_GRACE_DAYS)) errors.push({ code: "TRIAL_GRACE_INVALID", field: "trialPolicy.readOnlyGraceDays", message: "readOnlyGraceDays must be an integer between 0 and 90" });
  if (trial?.endOutcome === "blocked" && trial?.readOnlyGraceDays > 0) errors.push({ code: "TRIAL_GRACE_INCONSISTENT", field: "trialPolicy.readOnlyGraceDays", message: "a blocked end-of-trial outcome cannot carry a read-only grace period" });
  if (trial?.endOutcome === "read_only") errors.push({ code: "TRIAL_END_OUTCOME_UNSUPPORTED", field: "trialPolicy.endOutcome", message: "only the approved end-of-trial outcome 'blocked' (U5) can be published today; read-only grace is not enforceable yet" });
  if (trial?.eligible && trial?.trialDays === 0) warnings.push({ code: "TRIAL_ZERO_DAYS", field: "trialPolicy.trialDays", message: "trials are eligible but 0 days long" });
  // Prices: every ACTIVE price applying to this version must be verified in the
  // provider mode the platform is configured for.
  for (const p of ctx.prices) {
    if (!p.active) continue;
    if (!p.verifiedAt) errors.push({ code: "PRICE_UNVERIFIED", field: `prices.${p.id}`, message: `price ${p.id} is not provider-verified` });
    if (p.providerMode !== ctx.configuredProviderMode) errors.push({ code: "PRICE_MODE_MISMATCH", field: `prices.${p.id}`, message: `price ${p.id} was verified in ${p.providerMode} mode; the platform runs in ${ctx.configuredProviderMode} mode` });
  }
  if (!ctx.prices.some((p) => p.active)) warnings.push({ code: "NO_PROVIDER_PRICE", field: "prices", message: "no active provider price applies to this version; it can only be assigned by the platform owner (manual billing) and is not offered through checkout" });
  return { ok: errors.length === 0, errors, warnings };
}

// ── Comparison ───────────────────────────────────────────────────────────────

export type CompareValue = string | number | boolean | null;
export interface CompareRow {
  group: "display" | "limits" | "features" | "trialPolicy";
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
  push("trialPolicy", "trialDays", a.trialPolicy.trialDays, b.trialPolicy.trialDays);
  push("trialPolicy", "eligible", a.trialPolicy.eligible, b.trialPolicy.eligible);
  push("trialPolicy", "oncePerCompany", a.trialPolicy.oncePerCompany, b.trialPolicy.oncePerCompany);
  push("trialPolicy", "endOutcome", a.trialPolicy.endOutcome, b.trialPolicy.endOutcome);
  push("trialPolicy", "readOnlyGraceDays", a.trialPolicy.readOnlyGraceDays, b.trialPolicy.readOnlyGraceDays);
  return rows;
}

// A limit "tightens" when the right side is lower than the left (unlimited = +∞).
export function limitTightens(left: number | null, right: number | null): boolean {
  if (right == null) return false;
  if (left == null) return true;
  return right < left;
}
