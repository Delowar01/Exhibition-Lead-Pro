import { pgTable, serial, text, integer, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { companiesTable } from "./companies";
import { usersTable } from "./users";

// Persisted executive-intelligence artifacts (Stage 5C — Enterprise AI Executive
// Intelligence Center). Additive only — no existing table or column is changed. These
// tables deliberately mirror the ai_insights / ai_workflow_recommendations provenance
// contract (Stage 5A/5F) so review/provenance/lifecycle is identical across every AI
// surface.
//
// SAFETY CONTRACT: every artifact here is ADVISORY. AI recommends, executives decide.
// Nothing in this layer auto-executes a recommendation or writes the source CRM. A user
// action ("accept"/"dismiss") is recorded (status + acceptedById + acceptedAt) and audited
// separately; accepting does NOT itself mutate any CRM record. `source` records whether the
// artifact's phrasing came from an LLM ("ai") or a deterministic grounded core
// ("deterministic"); both are grounded strictly in CRM data already present in the tenant.
// Deterministic rows must NEVER carry AI provenance (provider/model/promptKey/version).
//
// COMPUTED-ONLY siblings (the executive dashboard rollups, health scores, trend series)
// are NOT persisted here — they are derived read-only from live CRM data and served through
// the analytics micro-cache so they stay fresh and never accumulate stale rows.
//
// SCOPE: scopeType + scopeId identify the org slice the artifact covers. scopeId is NOT
// NULL and defaults to 0 (0 = company-wide) so the unique indexes below are reliable
// (Postgres treats NULLs as distinct, which would allow duplicate company-scope rows).

// ---- Executive summaries (daily/weekly/monthly/quarterly narratives) ----------
export const executiveSummariesTable = pgTable("executive_summaries", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }), // tenant boundary
  scopeType: text("scope_type").notNull().default("company"), // company | department | team | employee
  scopeId: integer("scope_id").notNull().default(0), // 0 = company-wide; else department/team/user id
  periodType: text("period_type").notNull(), // daily | weekly | monthly | quarterly
  periodKey: text("period_key").notNull(), // e.g. 2026-07-06 | 2026-W27 | 2026-07 | 2026-Q3
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}), // headline, narrative, highlights, kpiSnapshot
  confidence: integer("confidence"), // 0-100 (null when unknown)
  reasoning: text("reasoning"), // human-readable explanation
  source: text("source").notNull().default("deterministic"), // ai | deterministic
  provider: text("provider"), // null for deterministic
  model: text("model"), // null for deterministic
  promptKey: text("prompt_key"), // null for deterministic
  promptVersion: integer("prompt_version"),
  status: text("status").notNull().default("suggested"), // suggested | accepted | dismissed
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
  lastAnalysisAt: timestamp("last_analysis_at").notNull().defaultNow(),
  acceptedById: integer("accepted_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("exec_summaries_scope_period_uidx").on(t.companyId, t.scopeType, t.scopeId, t.periodType, t.periodKey),
  index("exec_summaries_company_id_idx").on(t.companyId),
  index("exec_summaries_status_idx").on(t.status),
]);

// ---- Executive alerts (advisory anomaly/risk/opportunity signals) --------------
export const executiveAlertsTable = pgTable("executive_alerts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  scopeType: text("scope_type").notNull().default("company"),
  scopeId: integer("scope_id").notNull().default(0),
  // pipeline_slowing | conversion_dropping | sla_risk | team_overload |
  // event_underperforming | revenue_below_target | high_value_opportunity
  alertType: text("alert_type").notNull(),
  severity: text("severity").notNull().default("info"), // info | warning | critical
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}), // title, detail, metric, recommendation
  confidence: integer("confidence"),
  reasoning: text("reasoning"),
  source: text("source").notNull().default("deterministic"),
  provider: text("provider"),
  model: text("model"),
  promptKey: text("prompt_key"),
  promptVersion: integer("prompt_version"),
  status: text("status").notNull().default("suggested"), // suggested | accepted | dismissed
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
  lastAnalysisAt: timestamp("last_analysis_at").notNull().defaultNow(),
  acceptedById: integer("accepted_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("exec_alerts_scope_type_uidx").on(t.companyId, t.scopeType, t.scopeId, t.alertType),
  index("exec_alerts_company_id_idx").on(t.companyId),
  index("exec_alerts_status_idx").on(t.status),
]);

// ---- Executive forecasts (deterministic projections + optional AI phrasing) ----
export const executiveForecastsTable = pgTable("executive_forecasts", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  scopeType: text("scope_type").notNull().default("company"),
  scopeId: integer("scope_id").notNull().default(0),
  forecastType: text("forecast_type").notNull(), // revenue | pipeline | conversion | workload | risk
  horizon: text("horizon").notNull().default("90d"), // 30d | 90d | next_quarter
  method: text("method"), // moving_average | linear_trend | ratio (transparent, deterministic)
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}), // expected, low, high, points, assumptions
  confidence: integer("confidence"),
  reasoning: text("reasoning"),
  source: text("source").notNull().default("deterministic"),
  provider: text("provider"),
  model: text("model"),
  promptKey: text("prompt_key"),
  promptVersion: integer("prompt_version"),
  status: text("status").notNull().default("suggested"),
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
  lastAnalysisAt: timestamp("last_analysis_at").notNull().defaultNow(),
  acceptedById: integer("accepted_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("exec_forecasts_scope_type_uidx").on(t.companyId, t.scopeType, t.scopeId, t.forecastType, t.horizon),
  index("exec_forecasts_company_id_idx").on(t.companyId),
]);

// ---- Executive reports (generated PDF/Excel export records) --------------------
export const executiveReportsTable = pgTable("executive_reports", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  scopeType: text("scope_type").notNull().default("company"),
  scopeId: integer("scope_id").notNull().default(0),
  reportType: text("report_type").notNull(), // executive_summary | performance | forecast | full
  periodType: text("period_type").notNull().default("monthly"), // daily | weekly | monthly | quarterly
  periodKey: text("period_key").notNull(),
  format: text("format").notNull().default("pdf"), // pdf | xlsx
  status: text("status").notNull().default("pending"), // pending | generating | ready | failed
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}), // PPT-ready structured sections
  confidence: integer("confidence"),
  source: text("source").notNull().default("deterministic"),
  provider: text("provider"),
  model: text("model"),
  promptKey: text("prompt_key"),
  promptVersion: integer("prompt_version"),
  objectPath: text("object_path"), // download key/path once ready
  fileName: text("file_name"),
  error: text("error"), // failure reason when status = failed
  requestedById: integer("requested_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("exec_reports_company_id_idx").on(t.companyId),
  index("exec_reports_status_idx").on(t.status),
  index("exec_reports_company_created_idx").on(t.companyId, t.createdAt),
]);

export const insertExecutiveSummarySchema = createInsertSchema(executiveSummariesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertExecutiveSummary = z.infer<typeof insertExecutiveSummarySchema>;
export type ExecutiveSummary = typeof executiveSummariesTable.$inferSelect;

export const insertExecutiveAlertSchema = createInsertSchema(executiveAlertsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertExecutiveAlert = z.infer<typeof insertExecutiveAlertSchema>;
export type ExecutiveAlert = typeof executiveAlertsTable.$inferSelect;

export const insertExecutiveForecastSchema = createInsertSchema(executiveForecastsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertExecutiveForecast = z.infer<typeof insertExecutiveForecastSchema>;
export type ExecutiveForecast = typeof executiveForecastsTable.$inferSelect;

export const insertExecutiveReportSchema = createInsertSchema(executiveReportsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertExecutiveReport = z.infer<typeof insertExecutiveReportSchema>;
export type ExecutiveReport = typeof executiveReportsTable.$inferSelect;
