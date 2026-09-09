import { pgTable, serial, text, integer, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companiesTable } from "./companies";
import { subscriptionsTable } from "./subscriptions";
import { planPricesTable } from "./plan_prices";
import { plansTable } from "./plans";

// Local record of every hosted Checkout session this server created (Batch 20).
// Stores exactly what is needed to reconcile a provider callback safely: the
// company + canonical subscription it was created for, the internal price
// mapping, the opaque idempotency key, the provider session id and the outcome.
// A completed session binds the provider subscription id here as well, so a
// `checkout.session.completed` event can be matched to the request that caused
// it. The hosted Checkout URL is NEVER stored.
//
// B20 Correction 1 — durable Checkout INTENT. The row is committed BEFORE any
// provider call; the provider idempotency key is derived from the row id, so a
// retry after a crash resolves to the same provider session. States:
//   creating  → intent committed, provider session not yet linked
//   open      → provider session linked (hosted page can be completed)
//   completed → provider reported completion (subscription bound by webhook)
//   expired   → expired locally AND at the provider (or never created remotely)
//   failed    → provider refused the session
// At most ONE non-terminal intent (creating | open) per company (partial unique index).
export const billingCheckoutSessionsTable = pgTable(
  "billing_checkout_sessions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
    subscriptionId: integer("subscription_id").notNull().references(() => subscriptionsTable.id, { onDelete: "cascade" }),
    planPriceId: integer("plan_price_id").references(() => planPricesTable.id),
    planId: text("plan_id").notNull().references(() => plansTable.id),
    provider: text("provider").notNull().default("stripe"),
    providerMode: text("provider_mode").notNull().default("test"), // test | live (mode the session was created in)
    idempotencyKey: text("idempotency_key").notNull().unique(),
    providerSessionId: text("provider_session_id").unique(),
    providerCustomerId: text("provider_customer_id"),
    providerSubscriptionId: text("provider_subscription_id"),
    status: text("status").notNull().default("creating"),
    createdByUserId: integer("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at"),
    completedAt: timestamp("completed_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("billing_checkout_sessions_company_idx").on(t.companyId, t.status),
    uniqueIndex("billing_checkout_sessions_current_ux").on(t.companyId).where(sql`status in ('creating','open')`),
    check("billing_checkout_sessions_provider_chk", sql`provider in ('stripe')`),
    check("billing_checkout_sessions_status_chk", sql`status in ('creating','open','completed','expired','failed')`),
    check("billing_checkout_sessions_provider_mode_chk", sql`provider_mode in ('test','live')`),
  ],
);

export type BillingCheckoutSession = typeof billingCheckoutSessionsTable.$inferSelect;
