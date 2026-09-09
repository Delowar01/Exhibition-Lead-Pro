import { pgTable, serial, text, integer, boolean, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { plansTable } from "./plans";

// Provider price mappings (Batch 20). One internal plan can carry several
// recurring provider prices (e.g. monthly + yearly, several currencies). A row is
// registered by a platform owner with ONLY the provider price id; every other
// value (interval, currency, amount, product) is retrieved from the provider and
// persisted server-side — never trusted from a browser. No paid plan is offered
// through Checkout until it has an ACTIVE mapping here. Amounts are in the
// currency's minor unit (cents/fils) exactly as the provider reports them.
export const planPricesTable = pgTable(
  "plan_prices",
  {
    id: serial("id").primaryKey(),
    planId: text("plan_id").notNull().references(() => plansTable.id),
    provider: text("provider").notNull().default("stripe"),
    providerPriceId: text("provider_price_id").notNull().unique(),
    providerProductId: text("provider_product_id"),
    interval: text("interval").notNull(), // month | year | week | day (provider recurring interval)
    intervalCount: integer("interval_count").notNull().default(1),
    currency: text("currency").notNull(), // lowercase ISO-4217 as reported by the provider
    unitAmountMinor: integer("unit_amount_minor").notNull(),
    nickname: text("nickname"),
    // B20 Correction 1: the provider mode the price was verified in (test | live).
    // A price can only be registered in the mode the server is configured for.
    providerMode: text("provider_mode").notNull().default("test"),
    active: boolean("active").notNull().default(true),
    verifiedAt: timestamp("verified_at").notNull(),
    createdByUserId: integer("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("plan_prices_plan_idx").on(t.planId, t.active),
    check("plan_prices_provider_chk", sql`provider in ('stripe')`),
    check("plan_prices_interval_chk", sql`interval in ('day','week','month','year')`),
    check("plan_prices_interval_count_chk", sql`interval_count > 0`),
    check("plan_prices_amount_chk", sql`unit_amount_minor >= 0`),
    check("plan_prices_currency_chk", sql`currency ~ '^[a-z]{3}$'`),
    check("plan_prices_provider_mode_chk", sql`provider_mode in ('test','live')`),
  ],
);

export type PlanPrice = typeof planPricesTable.$inferSelect;
