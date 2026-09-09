import { pgTable, serial, text, integer, timestamp, date, boolean, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";
import { companiesTable } from "./companies";
import { plansTable } from "./plans";

// Canonical subscription record (Batch 20). Exactly ONE row per company
// (company_id is unique) and the ONLY source of truth for plan, billing source,
// lifecycle status, trial/period dates, cancellation state, provider identity,
// per-subscription limit overrides and the resolved entitlement. The legacy
// companies.plan / companies.status / companies.trial_ends_at columns are
// derived mirrors written transactionally by the subscription service and are
// never read for authorization or entitlement.
//
// Lifecycle states (lib/subscription-lifecycle.ts owns the transition table):
//   trialing | active | past_due | cancelled | expired | suspended
// Billing sources: manual (platform-owner managed) | stripe (provider managed).
//
// Per-subscription limit overrides live in `limit_overrides` (jsonb):
//   { contacts?: number|null, events?: number|null, admins?: number|null,
//     employees?: number|null, scans?: number|null, storageMb?: number|null }
// Effective limit = override ?? plan default ?? unlimited (null).

export type SubscriptionLimitOverrides = Partial<
  Record<"contacts" | "events" | "admins" | "employees" | "scans" | "storageMb", number | null>
>;

export const subscriptionsTable = pgTable(
  "subscriptions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }).unique(),
    // B20 Correction 1: enforced at the database boundary (FK → plans.id). The
    // plan catalog is seeded before this constraint is applied (staged activation:
    // additive schema → repair/seed → constrained schema).
    plan: text("plan").notNull().default("free").references(() => plansTable.id),
    status: text("status").notNull().default("trialing"), // trialing | active | past_due | cancelled | expired | suspended
    billingSource: text("billing_source").notNull().default("manual"), // manual | stripe

    // ── Canonical lifecycle timestamps (Batch 20) ──────────────────────────
    trialStartedAt: timestamp("trial_started_at"),
    trialExpiresAt: timestamp("trial_expires_at"),
    currentPeriodStartsAt: timestamp("current_period_starts_at"),
    currentPeriodEndsAt: timestamp("current_period_ends_at"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at"),
    endedAt: timestamp("ended_at"),
    pastDueSince: timestamp("past_due_since"),
    suspendedAt: timestamp("suspended_at"),
    suspendedReason: text("suspended_reason"),
    statusBeforeSuspension: text("status_before_suspension"),
    statusChangedAt: timestamp("status_changed_at").notNull().defaultNow(),
    // Anchor for the manual-subscription usage window (scan consumption). When
    // null the resolver falls back to trial_started_at, then created_at.
    usageAnchorAt: timestamp("usage_anchor_at"),

    // ── Limits (Batch 20) ──────────────────────────────────────────────────
    limitOverrides: jsonb("limit_overrides").$type<SubscriptionLimitOverrides>().notNull().default({}),

    // ── Provider identity (Stripe). Values are never exposed to tenants. ───
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripePriceId: text("stripe_price_id"),
    providerStatus: text("provider_status"), // raw provider status last applied (diagnostic)
    providerSyncedAt: timestamp("provider_synced_at"),
    // `created` of the newest provider event applied to this row: an older event
    // delivered later can never regress the state.
    providerEventCreatedAt: timestamp("provider_event_created_at"),

    // ── DEPRECATED legacy columns (pre-Batch 20). Retained for compatibility;
    //    never read for entitlement, limits or usage. Not dropped in Batch 20. ──
    scansUsed: integer("scans_used").notNull().default(0), // deprecated: usage is computed from scans + reservations
    scansLimit: integer("scans_limit").default(50), // deprecated: use limit_overrides.scans / plans.scans_limit
    usersLimit: integer("users_limit").default(1), // deprecated
    adminsLimit: integer("admins_limit"), // deprecated: use limit_overrides.admins
    employeesLimit: integer("employees_limit"), // deprecated: use limit_overrides.employees
    contactsLimit: integer("contacts_limit"), // deprecated: use limit_overrides.contacts
    eventsLimit: integer("events_limit"), // deprecated: use limit_overrides.events
    storageLimitMb: integer("storage_limit_mb"), // deprecated: use limit_overrides.storageMb
    apiLimit: integer("api_limit"), // deprecated: Public Developer Platform is removed scope
    trialEndsAt: date("trial_ends_at"), // deprecated mirror of trial_expires_at (date only)
    renewalDate: date("renewal_date"), // deprecated mirror of current_period_ends_at (date only)

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("subscriptions_status_idx").on(t.status),
    index("subscriptions_billing_source_idx").on(t.billingSource),
    // One Stripe customer / subscription can bind to at most one company.
    uniqueIndex("subscriptions_stripe_customer_ux").on(t.stripeCustomerId).where(sql`stripe_customer_id is not null`),
    uniqueIndex("subscriptions_stripe_subscription_ux").on(t.stripeSubscriptionId).where(sql`stripe_subscription_id is not null`),
    // B20 Correction 1 — canonical values are enforced by the database, not only by code.
    check("subscriptions_status_chk", sql`status in ('trialing','active','past_due','cancelled','expired','suspended')`),
    check("subscriptions_billing_source_chk", sql`billing_source in ('manual','stripe')`),
    check("subscriptions_status_before_suspension_chk", sql`status_before_suspension is null or status_before_suspension in ('trialing','active','past_due','cancelled','expired')`),
  ],
);

export const insertSubscriptionSchema = createInsertSchema(subscriptionsTable).omit({ id: true, createdAt: true });
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptionsTable.$inferSelect;
