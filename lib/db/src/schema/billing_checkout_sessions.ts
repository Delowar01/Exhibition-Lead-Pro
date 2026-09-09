import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { subscriptionsTable } from "./subscriptions";
import { planPricesTable } from "./plan_prices";

// Local record of every hosted Checkout session this server created (Batch 20).
// Stores exactly what is needed to reconcile a provider callback safely: the
// company + canonical subscription it was created for, the internal price
// mapping, the opaque idempotency key, the provider session id and the outcome.
// A completed session binds the provider subscription id here as well, so a
// `checkout.session.completed` event can be matched to the request that caused
// it. The hosted Checkout URL is NEVER stored.
//
// status: created | completed | expired | failed
export const billingCheckoutSessionsTable = pgTable(
  "billing_checkout_sessions",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
    subscriptionId: integer("subscription_id").notNull().references(() => subscriptionsTable.id, { onDelete: "cascade" }),
    planPriceId: integer("plan_price_id").references(() => planPricesTable.id),
    planId: text("plan_id").notNull(),
    provider: text("provider").notNull().default("stripe"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    providerSessionId: text("provider_session_id").unique(),
    providerCustomerId: text("provider_customer_id"),
    providerSubscriptionId: text("provider_subscription_id"),
    status: text("status").notNull().default("created"),
    createdByUserId: integer("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at"),
    completedAt: timestamp("completed_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("billing_checkout_sessions_company_idx").on(t.companyId, t.status)],
);

export type BillingCheckoutSession = typeof billingCheckoutSessionsTable.$inferSelect;
