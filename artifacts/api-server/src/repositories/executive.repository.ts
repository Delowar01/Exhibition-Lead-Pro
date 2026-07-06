import {
  db,
  executiveSummariesTable,
  executiveAlertsTable,
  executiveForecastsTable,
  executiveReportsTable,
} from "@workspace/db";
import type {
  ExecutiveSummary,
  ExecutiveAlert,
  ExecutiveForecast,
  ExecutiveReport,
} from "@workspace/db";
import { and, eq, desc, sql } from "drizzle-orm";
import { tenantScope, type AuthUser } from "../middlewares/requireAuth.js";
import { combine } from "./base.js";

// Data access for the persisted, reviewable Stage 5C executive-intelligence artifacts
// (summaries, alerts, forecasts, reports). Every artifact is keyed uniquely per tenant +
// scope so a re-generation UPSERTS the latest result while preserving the first
// generatedAt. ALL reads are tenant-scoped via tenantScope (never by companyId alone).
// This mirrors the ai_insights / ai_workflow repositories so the review/provenance/
// lifecycle contract is identical across every AI surface. Deterministic rows must NEVER
// carry AI provenance (provider/model/promptKey/promptVersion stay null).

export type ScopeType = "company" | "department" | "team" | "employee";

interface Provenance {
  data: Record<string, unknown>;
  confidence: number | null;
  reasoning: string | null;
  source: "ai" | "deterministic";
  provider?: string | null;
  model?: string | null;
  promptKey?: string | null;
  promptVersion?: number | null;
}

// ---- Summaries ---------------------------------------------------------------

export interface UpsertSummaryInput extends Provenance {
  companyId: number;
  scopeType: ScopeType;
  scopeId: number;
  periodType: string;
  periodKey: string;
}

export async function upsertSummary(input: UpsertSummaryInput): Promise<ExecutiveSummary> {
  const now = new Date();
  const [row] = await db
    .insert(executiveSummariesTable)
    .values({
      companyId: input.companyId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      periodType: input.periodType,
      periodKey: input.periodKey,
      data: input.data,
      confidence: input.confidence,
      reasoning: input.reasoning,
      source: input.source,
      provider: input.provider ?? null,
      model: input.model ?? null,
      promptKey: input.promptKey ?? null,
      promptVersion: input.promptVersion ?? null,
      status: "suggested",
      generatedAt: now,
      lastAnalysisAt: now,
    })
    .onConflictDoUpdate({
      target: [
        executiveSummariesTable.companyId,
        executiveSummariesTable.scopeType,
        executiveSummariesTable.scopeId,
        executiveSummariesTable.periodType,
        executiveSummariesTable.periodKey,
      ],
      set: {
        data: input.data,
        confidence: input.confidence,
        reasoning: input.reasoning,
        source: input.source,
        provider: input.provider ?? null,
        model: input.model ?? null,
        promptKey: input.promptKey ?? null,
        promptVersion: input.promptVersion ?? null,
        status: "suggested",
        acceptedById: null,
        acceptedAt: null,
        lastAnalysisAt: now,
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

export async function listSummaries(user: AuthUser, periodType: string | null, limit: number): Promise<ExecutiveSummary[]> {
  return db
    .select()
    .from(executiveSummariesTable)
    .where(
      combine(
        tenantScope(user, executiveSummariesTable.companyId),
        periodType ? eq(executiveSummariesTable.periodType, periodType) : undefined,
      ),
    )
    .orderBy(desc(executiveSummariesTable.generatedAt))
    .limit(limit);
}

export async function getSummaryById(user: AuthUser, id: number): Promise<ExecutiveSummary | undefined> {
  const [row] = await db
    .select()
    .from(executiveSummariesTable)
    .where(combine(tenantScope(user, executiveSummariesTable.companyId), eq(executiveSummariesTable.id, id)))
    .limit(1);
  return row;
}

export async function setSummaryStatus(
  user: AuthUser,
  id: number,
  status: "accepted" | "dismissed" | "suggested",
  acceptedById: number | null,
): Promise<ExecutiveSummary | undefined> {
  const [row] = await db
    .update(executiveSummariesTable)
    .set({
      status,
      acceptedById: status === "accepted" ? acceptedById : null,
      acceptedAt: status === "accepted" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(combine(tenantScope(user, executiveSummariesTable.companyId), eq(executiveSummariesTable.id, id)))
    .returning();
  return row;
}

// ---- Alerts ------------------------------------------------------------------

export interface UpsertAlertInput extends Provenance {
  companyId: number;
  scopeType: ScopeType;
  scopeId: number;
  alertType: string;
  severity: "info" | "warning" | "critical";
}

export async function upsertAlert(input: UpsertAlertInput): Promise<ExecutiveAlert> {
  const now = new Date();
  const [row] = await db
    .insert(executiveAlertsTable)
    .values({
      companyId: input.companyId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      alertType: input.alertType,
      severity: input.severity,
      data: input.data,
      confidence: input.confidence,
      reasoning: input.reasoning,
      source: input.source,
      provider: input.provider ?? null,
      model: input.model ?? null,
      promptKey: input.promptKey ?? null,
      promptVersion: input.promptVersion ?? null,
      status: "suggested",
      generatedAt: now,
      lastAnalysisAt: now,
    })
    .onConflictDoUpdate({
      target: [
        executiveAlertsTable.companyId,
        executiveAlertsTable.scopeType,
        executiveAlertsTable.scopeId,
        executiveAlertsTable.alertType,
      ],
      set: {
        severity: input.severity,
        data: input.data,
        confidence: input.confidence,
        reasoning: input.reasoning,
        source: input.source,
        provider: input.provider ?? null,
        model: input.model ?? null,
        promptKey: input.promptKey ?? null,
        promptVersion: input.promptVersion ?? null,
        status: "suggested",
        acceptedById: null,
        acceptedAt: null,
        lastAnalysisAt: now,
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

export async function listAlerts(user: AuthUser, status: string | null, limit: number): Promise<ExecutiveAlert[]> {
  return db
    .select()
    .from(executiveAlertsTable)
    .where(
      combine(
        tenantScope(user, executiveAlertsTable.companyId),
        status ? eq(executiveAlertsTable.status, status) : undefined,
      ),
    )
    .orderBy(desc(executiveAlertsTable.lastAnalysisAt))
    .limit(limit);
}

export async function getAlertById(user: AuthUser, id: number): Promise<ExecutiveAlert | undefined> {
  const [row] = await db
    .select()
    .from(executiveAlertsTable)
    .where(combine(tenantScope(user, executiveAlertsTable.companyId), eq(executiveAlertsTable.id, id)))
    .limit(1);
  return row;
}

export async function setAlertStatus(
  user: AuthUser,
  id: number,
  status: "accepted" | "dismissed" | "suggested",
  acceptedById: number | null,
): Promise<ExecutiveAlert | undefined> {
  const [row] = await db
    .update(executiveAlertsTable)
    .set({
      status,
      acceptedById: status === "accepted" ? acceptedById : null,
      acceptedAt: status === "accepted" ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(combine(tenantScope(user, executiveAlertsTable.companyId), eq(executiveAlertsTable.id, id)))
    .returning();
  return row;
}

// ---- Forecasts ---------------------------------------------------------------

export interface UpsertForecastInput extends Provenance {
  companyId: number;
  scopeType: ScopeType;
  scopeId: number;
  forecastType: string;
  horizon: string;
  method: string | null;
}

export async function upsertForecast(input: UpsertForecastInput): Promise<ExecutiveForecast> {
  const now = new Date();
  const [row] = await db
    .insert(executiveForecastsTable)
    .values({
      companyId: input.companyId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      forecastType: input.forecastType,
      horizon: input.horizon,
      method: input.method,
      data: input.data,
      confidence: input.confidence,
      reasoning: input.reasoning,
      source: input.source,
      provider: input.provider ?? null,
      model: input.model ?? null,
      promptKey: input.promptKey ?? null,
      promptVersion: input.promptVersion ?? null,
      status: "suggested",
      generatedAt: now,
      lastAnalysisAt: now,
    })
    .onConflictDoUpdate({
      target: [
        executiveForecastsTable.companyId,
        executiveForecastsTable.scopeType,
        executiveForecastsTable.scopeId,
        executiveForecastsTable.forecastType,
        executiveForecastsTable.horizon,
      ],
      set: {
        method: input.method,
        data: input.data,
        confidence: input.confidence,
        reasoning: input.reasoning,
        source: input.source,
        provider: input.provider ?? null,
        model: input.model ?? null,
        promptKey: input.promptKey ?? null,
        promptVersion: input.promptVersion ?? null,
        status: "suggested",
        acceptedById: null,
        acceptedAt: null,
        lastAnalysisAt: now,
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

export async function listForecasts(user: AuthUser, forecastType: string | null, limit: number): Promise<ExecutiveForecast[]> {
  return db
    .select()
    .from(executiveForecastsTable)
    .where(
      combine(
        tenantScope(user, executiveForecastsTable.companyId),
        forecastType ? eq(executiveForecastsTable.forecastType, forecastType) : undefined,
      ),
    )
    .orderBy(desc(executiveForecastsTable.generatedAt))
    .limit(limit);
}

// ---- Reports -----------------------------------------------------------------

export interface CreateReportInput {
  companyId: number;
  scopeType: ScopeType;
  scopeId: number;
  reportType: string;
  periodKey: string;
  format: string;
  requestedById: number | null;
}

export async function createReport(input: CreateReportInput): Promise<ExecutiveReport> {
  const [row] = await db
    .insert(executiveReportsTable)
    .values({
      companyId: input.companyId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      reportType: input.reportType,
      periodKey: input.periodKey,
      format: input.format,
      status: "pending",
      requestedById: input.requestedById,
    })
    .returning();
  return row;
}

export async function getReportById(user: AuthUser, id: number): Promise<ExecutiveReport | undefined> {
  const [row] = await db
    .select()
    .from(executiveReportsTable)
    .where(combine(tenantScope(user, executiveReportsTable.companyId), eq(executiveReportsTable.id, id)))
    .limit(1);
  return row;
}

export async function listReports(user: AuthUser, limit: number): Promise<ExecutiveReport[]> {
  return db
    .select()
    .from(executiveReportsTable)
    .where(tenantScope(user, executiveReportsTable.companyId))
    .orderBy(desc(executiveReportsTable.createdAt))
    .limit(limit);
}

export interface ReportResultUpdate {
  status: "generating" | "ready" | "failed";
  data?: Record<string, unknown>;
  confidence?: number | null;
  source?: "ai" | "deterministic";
  provider?: string | null;
  model?: string | null;
  promptKey?: string | null;
  promptVersion?: number | null;
  objectPath?: string | null;
  fileName?: string | null;
  error?: string | null;
}

// Update a report's generation result by id + companyId (worker path — no AuthUser).
// Scoped by the owning companyId so a worker can never cross tenants.
export async function updateReportResult(companyId: number, id: number, update: ReportResultUpdate): Promise<void> {
  const now = new Date();
  await db
    .update(executiveReportsTable)
    .set({
      status: update.status,
      ...(update.data !== undefined ? { data: update.data } : {}),
      ...(update.confidence !== undefined ? { confidence: update.confidence } : {}),
      ...(update.source !== undefined ? { source: update.source } : {}),
      ...(update.provider !== undefined ? { provider: update.provider } : {}),
      ...(update.model !== undefined ? { model: update.model } : {}),
      ...(update.promptKey !== undefined ? { promptKey: update.promptKey } : {}),
      ...(update.promptVersion !== undefined ? { promptVersion: update.promptVersion } : {}),
      ...(update.objectPath !== undefined ? { objectPath: update.objectPath } : {}),
      ...(update.fileName !== undefined ? { fileName: update.fileName } : {}),
      ...(update.error !== undefined ? { error: update.error } : {}),
      ...(update.status === "ready" || update.status === "failed" ? { completedAt: now } : {}),
      updatedAt: now,
    })
    .where(and(eq(executiveReportsTable.companyId, companyId), eq(executiveReportsTable.id, id)));
}

export async function statusCounts(user: AuthUser): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: executiveAlertsTable.status, n: sql<number>`count(*)` })
    .from(executiveAlertsTable)
    .where(tenantScope(user, executiveAlertsTable.companyId))
    .groupBy(executiveAlertsTable.status);
  const out: Record<string, number> = { suggested: 0, accepted: 0, dismissed: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}
