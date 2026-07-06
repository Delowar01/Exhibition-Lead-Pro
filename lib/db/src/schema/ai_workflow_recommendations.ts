import { pgTable, serial, text, integer, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Persisted AI workflow recommendations per CRM entity (Stage 5F — Enterprise AI
// Workflow Intelligence). One row per (tenant, entity, recommendationType). Additive
// only — no existing table or column is changed, and it deliberately mirrors the
// ai_insights table (Stage 5A) so the review/provenance/lifecycle contract is identical.
//
// SAFETY CONTRACT: recommendations are ADVISORY SUGGESTIONS. AI recommends, the user
// decides. A row NEVER auto-assigns an owner, auto-routes a lead, auto-changes a pipeline
// stage, auto-creates a task/reminder, or auto-sends anything. A user action ("accept")
// is recorded here (status + acceptedById + acceptedAt) and audited separately; accepting
// does NOT itself mutate the source CRM record — any resulting write still goes through the
// existing manual CRM endpoints. `source` records whether the recommendation came from an
// LLM ("ai") or a deterministic, rule-based engine ("deterministic") such as SLA-risk or
// workload routing — both grounded strictly in CRM data already present in the tenant.
// Deterministic rows must NEVER carry AI provenance (provider/model/promptKey/version).
//
// COMPUTED-ONLY siblings (SLA-risk lists, bottleneck reports, the workflow-health
// dashboard, and what-if simulation) are NOT persisted here — they are derived read-only
// from live CRM data (served through the analytics micro-cache) so they stay fresh and
// never accumulate stale rows.
export const aiWorkflowRecommendationsTable = pgTable("ai_workflow_recommendations", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // tenant boundary
  entityType: text("entity_type").notNull(), // lead | contact | organization
  entityId: integer("entity_id").notNull(), // id within entityType's table (same tenant)
  // next_action | follow_up | owner | department | team | priority | due_date |
  // routing | progression | reminder | task
  recommendationType: text("recommendation_type").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}), // structured, feature-specific output
  confidence: integer("confidence"), // 0-100 (null when unknown)
  reasoning: text("reasoning"), // human-readable explanation; "Not enough information" when insufficient
  source: text("source").notNull().default("deterministic"), // ai | deterministic
  provider: text("provider"), // e.g. gemini (null for deterministic)
  model: text("model"), // e.g. gemini-2.5-flash (null for deterministic)
  promptKey: text("prompt_key"), // versioned prompt key (null for deterministic)
  promptVersion: integer("prompt_version"),
  status: text("status").notNull().default("suggested"), // suggested | accepted | dismissed
  generatedAt: timestamp("generated_at").notNull().defaultNow(), // first time this recommendation was produced
  lastAnalysisAt: timestamp("last_analysis_at").notNull().defaultNow(), // most recent (re)analysis
  acceptedById: integer("accepted_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ai_workflow_recs_entity_type_uidx").on(t.companyId, t.entityType, t.entityId, t.recommendationType),
  index("ai_workflow_recs_company_id_idx").on(t.companyId),
  index("ai_workflow_recs_entity_idx").on(t.companyId, t.entityType, t.entityId),
  index("ai_workflow_recs_status_idx").on(t.status),
]);

export const insertAiWorkflowRecommendationSchema = createInsertSchema(aiWorkflowRecommendationsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAiWorkflowRecommendation = z.infer<typeof insertAiWorkflowRecommendationSchema>;
export type AiWorkflowRecommendation = typeof aiWorkflowRecommendationsTable.$inferSelect;
