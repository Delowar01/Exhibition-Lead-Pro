import { pgTable, serial, text, integer, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Persisted, reviewable AI Sales Copilot outputs (Stage 5B — Enterprise AI Sales
// Copilot). One row per (tenant, entity, outputType). Additive only — no existing
// table or column is changed. The raw provider usage/cost/latency ledger stays in
// ai_invocations; THIS table stores the structured, reviewable RESULT (a draft email,
// WhatsApp message, call/meeting prep brief, proposal outline, follow-up suggestion,
// coaching, or conversation summary) plus the full provenance every AI output must
// carry: confidence, reasoning, model + prompt version, when it was generated, when it
// was last (re)generated, and a review status.
//
// SAFETY CONTRACT: copilot outputs are DRAFTS/SUGGESTIONS. They never auto-send a
// message and never auto-write CRM fields. `content` holds the AI/deterministic draft
// exactly as produced; `editedContent` holds the human-edited version once a user saves
// an edit. A user action ("use"/"dismiss") is recorded here (status + usedById + usedAt)
// and audited separately in audit_logs. `source` records whether the output came from an
// LLM ("ai") or a deterministic, rule-based engine ("deterministic") such as the coaching
// / follow-up timing engines — both are grounded ONLY in CRM data present in the tenant.
export const aiCopilotOutputsTable = pgTable("ai_copilot_outputs", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // tenant boundary
  entityType: text("entity_type").notNull(), // lead | contact | organization | business_card
  entityId: integer("entity_id").notNull(), // id within entityType's table (same tenant)
  outputType: text("output_type").notNull(), // email | whatsapp | call_prep | meeting_prep | proposal | followup | coaching | summary
  content: jsonb("content").$type<Record<string, unknown>>().notNull().default({}), // structured, output-type-specific draft
  editedContent: jsonb("edited_content").$type<Record<string, unknown>>(), // human-edited version (null until edited)
  confidence: integer("confidence"), // 0-100 (null when unknown)
  reasoning: text("reasoning"), // human-readable explanation; "Not enough information" when insufficient
  source: text("source").notNull().default("ai"), // ai | deterministic
  provider: text("provider"), // e.g. gemini (null for deterministic)
  model: text("model"), // e.g. gemini-2.5-flash (null for deterministic)
  promptKey: text("prompt_key"), // versioned prompt key (null for deterministic)
  promptVersion: integer("prompt_version"),
  language: text("language").notNull().default("en"), // en | ar (capture-time app language)
  status: text("status").notNull().default("generated"), // generated | edited | used | dismissed
  generatedAt: timestamp("generated_at").notNull().defaultNow(), // first time this output was produced
  lastGeneratedAt: timestamp("last_generated_at").notNull().defaultNow(), // most recent (re)generation
  usedById: integer("used_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ai_copilot_outputs_entity_type_uidx").on(t.companyId, t.entityType, t.entityId, t.outputType),
  index("ai_copilot_outputs_company_id_idx").on(t.companyId),
  index("ai_copilot_outputs_entity_idx").on(t.companyId, t.entityType, t.entityId),
  index("ai_copilot_outputs_status_idx").on(t.status),
]);

export const insertAiCopilotOutputSchema = createInsertSchema(aiCopilotOutputsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAiCopilotOutput = z.infer<typeof insertAiCopilotOutputSchema>;
export type AiCopilotOutput = typeof aiCopilotOutputsTable.$inferSelect;
