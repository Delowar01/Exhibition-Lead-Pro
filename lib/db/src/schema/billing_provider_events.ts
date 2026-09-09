import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";

// Provider webhook event ledger (Batch 20). One row per provider event id
// (unique) — the durable idempotency record for Stripe deliveries. Only
// SANITIZED metadata is stored: the event id, type, provider timestamp, which
// company/subscription it bound to, the processing outcome and a short failure
// code. The event payload itself is NEVER persisted.
//
// status: received (row inserted, processing in flight) | processed | ignored
//         (validly signed but unsupported / stale / unbound) | failed (retry
//         expected — Stripe redelivers because we answered non-2xx)
export const billingProviderEventsTable = pgTable(
  "billing_provider_events",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull().default("stripe"),
    eventId: text("event_id").notNull().unique(),
    eventType: text("event_type").notNull(),
    providerCreatedAt: timestamp("provider_created_at"),
    receivedAt: timestamp("received_at").notNull().defaultNow(),
    processedAt: timestamp("processed_at"),
    status: text("status").notNull().default("received"), // received | processed | ignored | failed
    outcome: text("outcome"), // applied | duplicate | stale | unbound | unsupported | mismatch | no_change
    failureCode: text("failure_code"), // sanitized code only — never a message, stack or payload
    attempts: integer("attempts").notNull().default(1),
    companyId: integer("company_id"),
    subscriptionId: integer("subscription_id"),
  },
  (t) => [index("billing_provider_events_status_idx").on(t.status), index("billing_provider_events_company_idx").on(t.companyId)],
);

export type BillingProviderEvent = typeof billingProviderEventsTable.$inferSelect;
