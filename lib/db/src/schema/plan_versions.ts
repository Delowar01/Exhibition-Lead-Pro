import { pgTable, serial, text, integer, jsonb, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { plansTable } from "./plans";

// Batch 40 — versioned Plan Builder (owner-approved PB-1.4 additive model).
//
// A plan version is an IMMUTABLE snapshot of a plan's approved settings. A row
// with `published_at IS NULL` is the plan's single DRAFT (one draft per plan,
// enforced by the partial unique index); publishing stamps `published_at` /
// `published_by` and from then on the row is never edited in place — a change
// means a new draft → a new version. `retired_at` marks a published version that
// is no longer assignable to NEW tenants; its existing subscribers keep it
// (grandfathering by default). A version that any subscription references can
// never be deleted (FK, no cascade); the API never deletes a published version.
//
// `snapshot` holds what the single entitlement resolver reads for a pinned
// tenant (limits), plus the fixed feature matrix, the display fields and the
// price summary captured at publication. `trial_policy` is the structured trial
// representation (U5: blocked at the end of the trial by default; a published
// version may configure a read-only grace — Batch 41).

export const PLAN_FEATURE_KEYS = [
  "ai.assistant",
  "ai.command_center",
  "workflow.intelligence",
  "executive.intelligence",
  "exports.scheduled",
  "nfc.capture",
  "documents",
  "api.access",
] as const;
export type PlanFeatureKey = (typeof PLAN_FEATURE_KEYS)[number];
export type PlanFeatureMatrix = Record<PlanFeatureKey, boolean>;

export const PLAN_LIMIT_KEYS = ["contacts", "events", "admins", "employees", "scans", "storageMb"] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];
export type PlanVersionLimits = Record<PlanLimitKey, number | null>;

export interface PlanVersionPriceSummary {
  id: number;
  interval: string;
  intervalCount: number;
  currency: string;
  unitAmountMinor: number;
  providerMode: string;
  nickname: string | null;
  active: boolean;
  // Batch 42 (PB-4): the version the mapping is bound to (null = plan-wide).
  // Absent on snapshots published before Batch 42 (= plan-wide at the time).
  planVersionId?: number | null;
}

// Batch 42 (PB-4.1, owner decision D2) — a platform-managed (manual) price
// summary recorded in the immutable snapshot: display + audit only. The product
// never bills it, it is never a provider identity, and it lives in no separate
// table; manual-billing tenants are invoiced by the platform operator outside
// the product.
export const MANUAL_PRICE_INTERVALS = ["day", "week", "month", "year"] as const;
export type ManualPriceInterval = (typeof MANUAL_PRICE_INTERVALS)[number];
export interface PlanVersionManualPrice {
  interval: ManualPriceInterval;
  intervalCount: number;
  currency: string; // lowercase ISO-4217
  unitAmountMinor: number;
  label: string | null;
}

// Batch 41 (PB-3) — how a version's feature matrix is applied to its subscribers.
//   "legacy"   : the matrix is RECORDED ONLY. Every catalog feature stays
//                available (U2: "none gated until a version says so"). This is
//                the meaning of every version-1 backfill snapshot (whose flags
//                were normalized to false from the free-form plan row) and of
//                every snapshot published before feature enforcement existed —
//                an ABSENT field reads as "legacy", so stored snapshots are never
//                rewritten.
//   "enforced" : the matrix is ENFORCED server-side for subscribers pinned to
//                this version: a feature set to false is denied.
export const FEATURE_ENFORCEMENT_MODES = ["legacy", "enforced"] as const;
export type FeatureEnforcementMode = (typeof FEATURE_ENFORCEMENT_MODES)[number];

// Batch 41 (PB-3.3 / U4) — per-version AI allowances. They SEED the existing
// Enterprise AI Layer monthly budget of every subscriber pinned to the version;
// an explicit per-tenant budget in ai_settings keeps precedence. null = no
// allowance (unlimited unless the tenant has its own budget). An ABSENT object
// (every pre-Batch-41 snapshot) means "no allowances" — nothing changes.
export interface PlanVersionAllowances {
  aiTokensPerMonth: number | null;
  aiCostMicroUsdPerMonth: number | null;
}

export interface PlanVersionSnapshot {
  name: string;
  description: string | null;
  sortOrder: number;
  limits: PlanVersionLimits;
  features: PlanFeatureMatrix;
  // Verified provider prices that applied to the version when it was published
  // (informational; the price mappings themselves live in plan_prices).
  prices: PlanVersionPriceSummary[];
  // Optional (Batch 41): absent = "legacy" (grandfathered, nothing enforced).
  featureEnforcement?: FeatureEnforcementMode;
  // Optional (Batch 41): absent = no AI allowance seeded by the version.
  allowances?: PlanVersionAllowances;
  // Optional (Batch 42): platform-managed price summaries (absent = none).
  manualPrices?: PlanVersionManualPrice[];
}

export const TRIAL_END_OUTCOMES = ["blocked", "read_only"] as const;
export type TrialEndOutcome = (typeof TRIAL_END_OUTCOMES)[number];

export interface PlanTrialPolicy {
  trialDays: number;
  eligible: boolean;
  oncePerCompany: boolean;
  endOutcome: TrialEndOutcome;
  readOnlyGraceDays: number;
}

export const planVersionsTable = pgTable(
  "plan_versions",
  {
    id: serial("id").primaryKey(),
    planId: text("plan_id").notNull().references(() => plansTable.id),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").$type<PlanVersionSnapshot>().notNull(),
    trialPolicy: jsonb("trial_policy").$type<PlanTrialPolicy>().notNull(),
    publishedAt: timestamp("published_at"),
    publishedBy: integer("published_by"), // platform user id; null = system (version-1 backfill)
    retiredAt: timestamp("retired_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("plan_versions_plan_version_ux").on(t.planId, t.version),
    // At most ONE draft per plan.
    uniqueIndex("plan_versions_one_draft_ux").on(t.planId).where(sql`published_at is null`),
    index("plan_versions_plan_published_idx").on(t.planId, t.publishedAt),
    check("plan_versions_version_chk", sql`version > 0`),
    check("plan_versions_retired_chk", sql`retired_at is null or published_at is not null`),
  ],
);

export type PlanVersion = typeof planVersionsTable.$inferSelect;
