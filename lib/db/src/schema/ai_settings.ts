import { pgTable, serial, text, integer, boolean, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";

// Per-tenant AI configuration (Stage 5.0 — AI Platform Foundation). Exactly one row
// per company (unique companyId). An ABSENT row === platform defaults (AI enabled, all
// features on, unlimited budgets), so existing tenants keep working unchanged with no
// backfill. Budgets are null = unlimited; a set budget is enforced server-side over the
// current calendar month. Cost budget is stored in micro-USD (integer millionths of a
// dollar) to match the ai_invocations ledger and avoid floats.
export const aiSettingsTable = pgTable("ai_settings", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // tenant boundary
  provider: text("provider").notNull().default("gemini"),
  model: text("model").notNull().default("gemini-2.5-flash"),
  enabled: boolean("enabled").notNull().default(true), // master switch for all AI features
  featureFlags: jsonb("feature_flags").$type<Record<string, boolean>>().notNull().default({}), // { card_extraction:true, lead_scoring:true, contact_enrichment:true, assignee_recommendation:true }
  monthlyTokenBudget: integer("monthly_token_budget"), // null = unlimited
  monthlyCostBudgetMicroUsd: integer("monthly_cost_budget_micro_usd"), // null = unlimited; micro-USD (1e-6 USD)
  // Stage 5F: tenant-configurable workflow-intelligence thresholds (partial override;
  // null / missing keys = platform defaults). Normalized field-by-field on read.
  workflowRules: jsonb("workflow_rules").$type<Record<string, number>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ai_settings_company_id_uidx").on(t.companyId),
]);

export const insertAiSettingsSchema = createInsertSchema(aiSettingsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAiSettings = z.infer<typeof insertAiSettingsSchema>;
export type AiSettings = typeof aiSettingsTable.$inferSelect;
