import { pgTable, serial, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Append-only AI usage ledger (Stage 5.0 — AI Platform Foundation). One row per AI
// provider call recording token usage, estimated cost, latency, status, model +
// prompt version, and an optional confidence score. Cost is stored in micro-USD
// (integer millionths of a dollar) to stay precise without floats. companyId is the
// tenant boundary (nullable for non-tenant/system calls; such rows are invisible to
// tenant-scoped reads and only surface in platform-owner aggregates). Never updated or
// deleted — like audit_logs, there is no delete route and no cascade delete.
export const aiInvocationsTable = pgTable("ai_invocations", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").references(() => companiesTable.id, { onDelete: "set null" }), // tenant boundary (nullable)
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  feature: text("feature").notNull(), // card_extraction | lead_scoring | contact_enrichment | assignee_recommendation
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptKey: text("prompt_key"),
  promptVersion: integer("prompt_version"),
  // Provider outcomes: success | error | timeout. Non-provider outcomes (no Gemini
  // call, zero tokens, zero cost): cache_hit | dedup_reused | budget_denied |
  // rate_limited. Aggregations count only provider outcomes as "requests".
  status: text("status").notNull(),
  // Batch 6 — stable logical request id (UUID) for idempotent ledger persistence.
  // Nullable for pre-Batch-6 historical rows; unique when present.
  requestId: text("request_id"),
  // Batch 6 — optional safe entity linkage (type + numeric id only, never content).
  entityType: text("entity_type"),
  entityId: integer("entity_id"),
  // Batch 6 — provider attempts consumed by this logical request (1 = no retry).
  attempts: integer("attempts").notNull().default(1),
  // Batch 6 — true when provider token metadata was missing and usage is a fallback
  // estimate rather than actual provider-reported counts.
  estimatedUsage: boolean("estimated_usage").notNull().default(false),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  estimatedCostMicroUsd: integer("estimated_cost_micro_usd").notNull().default(0),
  // Batch 6 — pricing-config version used to compute estimatedCostMicroUsd at
  // invocation time (historical totals stay stable when pricing changes).
  pricingVersion: text("pricing_version"),
  // Batch 6 — safe, low-cardinality failure category (timeout | rate_limited |
  // provider_unavailable | invalid_response | network | other). Never raw content.
  errorCategory: text("error_category"),
  confidence: integer("confidence"), // 0-100, feature-provided when available (null otherwise)
  latencyMs: integer("latency_ms").notNull().default(0),
  errorMessage: text("error_message"), // redacted + truncated on failure
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("ai_invocations_company_id_idx").on(t.companyId),
  index("ai_invocations_company_created_idx").on(t.companyId, t.createdAt),
  index("ai_invocations_feature_idx").on(t.feature),
  index("ai_invocations_status_idx").on(t.status),
  // Batch 6: idempotent ledger writes (insert ... on conflict do nothing).
  uniqueIndex("ai_invocations_request_id_uq").on(t.requestId),
  // Batch 6: platform-wide date-range aggregations scan by created_at alone.
  index("ai_invocations_created_idx").on(t.createdAt),
]);

export type AiInvocation = typeof aiInvocationsTable.$inferSelect;
export type InsertAiInvocation = typeof aiInvocationsTable.$inferInsert;

// Batch 6 — short-lived budget reservations backing atomic tenant-budget enforcement.
// The ai_invocations ledger is append-only by design (never updated), so reservations
// — which must be created before a provider call and released/finalized afterwards —
// live in this small separate table instead of mutating ledger rows. A reservation
// counts toward the tenant's month budget while active (not expired); it is deleted on
// finalize, and abandoned rows (process crash) expire naturally via expiresAt so they
// can never block a tenant permanently.
export const aiUsageReservationsTable = pgTable("ai_usage_reservations", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  reservedTokens: integer("reserved_tokens").notNull().default(0),
  reservedCostMicroUsd: integer("reserved_cost_micro_usd").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
}, (t) => [
  index("ai_usage_reservations_company_expires_idx").on(t.companyId, t.expiresAt),
  uniqueIndex("ai_usage_reservations_request_id_uq").on(t.requestId),
]);

export type AiUsageReservation = typeof aiUsageReservationsTable.$inferSelect;
export type InsertAiUsageReservation = typeof aiUsageReservationsTable.$inferInsert;
