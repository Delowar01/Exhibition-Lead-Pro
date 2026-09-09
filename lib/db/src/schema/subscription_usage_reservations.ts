import { pgTable, serial, text, integer, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companiesTable } from "./companies";

// Usage reservations for consumable resources (Batch 20) — today: scans.
// A reservation is taken under the tenant+resource advisory lock BEFORE any
// provider work, keyed by an opaque idempotency key so a retried request never
// consumes twice:
//   pending  → counted against the limit; released if the operation fails
//   consumed → the operation succeeded (a single scan links its scan row;
//              batch-analysis items keep scan_id null and stay counted)
//   released → the operation failed / was denied; no longer counted
// Pending rows older than `expires_at` are treated as released by the usage
// query so a crash can never pin capacity permanently.
export const subscriptionUsageReservationsTable = pgTable(
  "subscription_usage_reservations",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(), // scans
    quantity: integer("quantity").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").notNull().default("pending"), // pending | consumed | released
    scanId: integer("scan_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    releasedAt: timestamp("released_at"),
  },
  (t) => [
    index("subscription_usage_reservations_lookup_idx").on(t.companyId, t.resource, t.status),
    check("subscription_usage_reservations_resource_chk", sql`resource in ('scans')`),
    check("subscription_usage_reservations_status_chk", sql`status in ('pending','consumed','released')`),
    check("subscription_usage_reservations_quantity_chk", sql`quantity > 0`),
  ],
);

export type SubscriptionUsageReservation = typeof subscriptionUsageReservationsTable.$inferSelect;
