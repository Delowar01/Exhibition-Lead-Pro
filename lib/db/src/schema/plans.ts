import { pgTable, text, integer, boolean, numeric, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Plan feature flags (gate functionality across portals + mobile).
export type PlanFeatures = Record<string, boolean>;

// Plan catalog. Plans are keyed by stable slug (free, starter, professional,
// business, enterprise) and seeded idempotently (Batch 20: lib/plan-catalog.ts —
// insert-if-missing, never overwriting an operator's edits).
//
// Limit columns are PLAN DEFAULTS: a null limit means "unlimited". The effective
// limit of a company is `subscriptions.limit_overrides[resource] ?? plans.<limit>
// ?? unlimited`. Seeded defaults are all null (non-blocking) until commercial
// limits are approved.
//
// Prices are NOT represented here: paid plans map to provider prices in
// `plan_prices` (verified against the provider, one plan can carry several
// recurring prices). `price_monthly` / `currency` are DEPRECATED placeholders kept
// only for compatibility (never displayed as a price). `api_limit` is DEPRECATED
// (Public Developer Platform is removed scope).
export const plansTable = pgTable("plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  priceMonthly: numeric("price_monthly", { precision: 12, scale: 2 }).notNull().default("0"), // deprecated
  currency: text("currency").notNull().default("USD"), // deprecated
  adminsLimit: integer("admins_limit"),
  employeesLimit: integer("employees_limit"),
  contactsLimit: integer("contacts_limit"),
  eventsLimit: integer("events_limit"),
  scansLimit: integer("scans_limit"), // Batch 20: scans per usage window (null = unlimited)
  storageLimitMb: integer("storage_limit_mb"),
  apiLimit: integer("api_limit"), // deprecated
  trialDays: integer("trial_days").notNull().default(14),
  features: jsonb("features").$type<PlanFeatures>().notNull().default({}),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertPlanSchema = createInsertSchema(plansTable).omit({ createdAt: true, updatedAt: true });
export type InsertPlan = z.infer<typeof insertPlanSchema>;
export type Plan = typeof plansTable.$inferSelect;
