import { pgTable, serial, text, integer, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Persisted AI intelligence per CRM entity (Stage 5A — Enterprise AI Intelligence).
// One row per (tenant, entity, insightType). Additive only — no existing table or
// column is changed. The raw provider usage/cost/latency ledger stays in
// ai_invocations; THIS table stores the structured, reviewable RESULT plus the full
// provenance every recommendation must carry: confidence, reasoning, model + prompt
// version, when it was generated, when it was last (re)analyzed, and a review status.
//
// SAFETY CONTRACT: insights are SUGGESTIONS. They never overwrite CRM fields. A user
// action ("accept") is recorded here (status + acceptedById + acceptedAt) and audited
// separately; accepting does not itself mutate the source record. `source` records
// whether the insight came from an LLM ("ai") or a deterministic, rule-based engine
// ("deterministic") such as missing-info or duplicate detection — both are grounded in
// CRM data already present in the tenant.
export const aiInsightsTable = pgTable("ai_insights", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // tenant boundary
  entityType: text("entity_type").notNull(), // lead | contact | organization
  entityId: integer("entity_id").notNull(), // id within entityType's table (same tenant)
  insightType: text("insight_type").notNull(), // lead_intelligence | company_intelligence | contact_intelligence | smart_classification | opportunity_potential | missing_info | duplicate_intelligence
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}), // structured, feature-specific output
  confidence: integer("confidence"), // 0-100 (null when unknown)
  reasoning: text("reasoning"), // human-readable explanation; "Not enough information" when insufficient
  source: text("source").notNull().default("ai"), // ai | deterministic
  provider: text("provider"), // e.g. gemini (null for deterministic)
  model: text("model"), // e.g. gemini-2.5-flash (null for deterministic)
  promptKey: text("prompt_key"), // versioned prompt key (null for deterministic)
  promptVersion: integer("prompt_version"),
  status: text("status").notNull().default("suggested"), // suggested | accepted | dismissed
  generatedAt: timestamp("generated_at").notNull().defaultNow(), // first time this insight was produced
  lastAnalysisAt: timestamp("last_analysis_at").notNull().defaultNow(), // most recent (re)analysis
  acceptedById: integer("accepted_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ai_insights_entity_type_uidx").on(t.companyId, t.entityType, t.entityId, t.insightType),
  index("ai_insights_company_id_idx").on(t.companyId),
  index("ai_insights_entity_idx").on(t.companyId, t.entityType, t.entityId),
  index("ai_insights_status_idx").on(t.status),
]);

export const insertAiInsightSchema = createInsertSchema(aiInsightsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAiInsight = z.infer<typeof insertAiInsightSchema>;
export type AiInsight = typeof aiInsightsTable.$inferSelect;
