import { pgTable, serial, text, integer, timestamp, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

export const subscriptionsTable = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }).unique(),
  plan: text("plan").notNull().default("free"), // references plans.id
  status: text("status").notNull().default("trial"), // trial, active, suspended, expired, cancelled
  scansUsed: integer("scans_used").notNull().default(0),
  scansLimit: integer("scans_limit").default(50),
  usersLimit: integer("users_limit").default(1),
  // Per-company limits (seeded from plan defaults, platform-owner overridable). null = unlimited.
  adminsLimit: integer("admins_limit"),
  employeesLimit: integer("employees_limit"),
  contactsLimit: integer("contacts_limit"),
  eventsLimit: integer("events_limit"),
  storageLimitMb: integer("storage_limit_mb"),
  apiLimit: integer("api_limit"),
  trialEndsAt: date("trial_ends_at"),
  renewalDate: date("renewal_date"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSubscriptionSchema = createInsertSchema(subscriptionsTable).omit({ id: true, createdAt: true });
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptionsTable.$inferSelect;
