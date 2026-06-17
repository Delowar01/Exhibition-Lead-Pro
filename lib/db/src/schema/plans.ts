import { pgTable, text, integer, boolean, numeric, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Plan feature flags (gate functionality across portals + mobile).
export type PlanFeatures = Record<string, boolean>;

// Plans are keyed by slug (free, starter, professional, business, enterprise).
// `companies.plan` and `subscriptions.plan` reference this id logically.
// A null limit means "unlimited".
export const plansTable = pgTable("plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  priceMonthly: numeric("price_monthly", { precision: 12, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull().default("USD"),
  adminsLimit: integer("admins_limit"),
  employeesLimit: integer("employees_limit"),
  contactsLimit: integer("contacts_limit"),
  eventsLimit: integer("events_limit"),
  storageLimitMb: integer("storage_limit_mb"),
  apiLimit: integer("api_limit"),
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
