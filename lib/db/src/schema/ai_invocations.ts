import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
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
  status: text("status").notNull(), // success | error | timeout
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  estimatedCostMicroUsd: integer("estimated_cost_micro_usd").notNull().default(0),
  confidence: integer("confidence"), // 0-100, feature-provided when available (null otherwise)
  latencyMs: integer("latency_ms").notNull().default(0),
  errorMessage: text("error_message"), // redacted + truncated on failure
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("ai_invocations_company_id_idx").on(t.companyId),
  index("ai_invocations_company_created_idx").on(t.companyId, t.createdAt),
  index("ai_invocations_feature_idx").on(t.feature),
  index("ai_invocations_status_idx").on(t.status),
]);

export type AiInvocation = typeof aiInvocationsTable.$inferSelect;
export type InsertAiInvocation = typeof aiInvocationsTable.$inferInsert;
