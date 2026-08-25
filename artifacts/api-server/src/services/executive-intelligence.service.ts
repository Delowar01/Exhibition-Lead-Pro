import { loadAuthUserById, type AuthUser } from "../middlewares/requireAuth.js";
import { AppError } from "../middlewares/errorHandler.js";
import { convertCurrency } from "../lib/currency.js";
import * as analytics from "./analytics.service.js";
import * as repo from "../repositories/analytics.repository.js";
import * as execRepo from "../repositories/executive.repository.js";
import * as core from "../lib/executive-intelligence.js";
import * as ai from "../lib/ai.js";
import { resolveSettings } from "./ai.service.js";
import { PROMPTS } from "../ai/prompts.js";
import type { AppLanguage } from "../lib/ai.js";
import { getQueue } from "../lib/jobs/queue.js";
import { generateFile, type ExportFormat } from "../lib/export-generate.js";
import { uploadExportBuffer, exportDownloadURL } from "../lib/exportStorage.js";

// Stage 5C — Enterprise AI Executive Intelligence orchestration.
//
// Composes REAL, tenant-scoped CRM aggregates (via the analytics repository, reusing the
// dashboard's scope-privacy resolution) with the deterministic executive-intelligence core
// (health scores, trends, forecasts, team performance, alerts). The read-only dashboard is
// served fresh through the analytics micro-cache; the "generate" paths additionally persist
// reviewable artifacts (summaries/forecasts/alerts) and optionally phrase them with the LLM.
//
// SAFETY CONTRACT (shared with every AI surface):
// - Deterministic grounded cores are confidence-100 computations; AI phrasing is best-effort.
// - AI phrasing SOFT-DEGRADES: on any LLM failure the deterministic core survives and the
//   persisted row's source stays "deterministic" (never a 500). Only a successful phrase flips
//   source to "ai" and stamps the REAL runtime provider/model/promptVersion.
// - Deterministic rows NEVER carry AI provenance.
// - Nothing here auto-executes a recommendation or writes the source CRM.

const ANALYSIS_MONTHS = 12;
const HIGH_VALUE_THRESHOLD_USD = 25000;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// scopeId column is NOT NULL (0 = company-wide); map the resolved scope id accordingly.
function scopeIdOf(id: number | null): number {
  return id ?? 0;
}

function isManager(role: string): boolean {
  return role === "primary_admin" || role === "admin";
}

// Compute the scope-privacy entitlement for READING persisted executive artifacts. Managers
// (primary_admin/admin) see every scope in the tenant. A non-manager sees ONLY their own
// employee scope plus the teams they lead and departments they head — mirroring the
// read-only dashboard's scope privacy so persisted rows can never leak wider than the live
// dashboard would. Never company scope for non-managers.
async function computeReadScope(user: AuthUser): Promise<execRepo.ReadScope> {
  if (isManager(user.role)) return { isManager: true, userId: user.id, teamIds: [], deptIds: [] };
  const [depts, teams] = await Promise.all([repo.listTenantDepartments(user), repo.listTenantTeams(user)]);
  return {
    isManager: false,
    userId: user.id,
    teamIds: teams.filter((t) => t.leaderId === user.id).map((t) => t.id),
    deptIds: depts.filter((d) => d.headId === user.id).map((d) => d.id),
  };
}

// Chronological USD-converted won-value series from the per-month, per-currency rows.
// Cross-currency correctness: convert EACH currency bucket to USD BEFORE summing per month.
function revenueSeries(rows: repo.MonthCurrencyValueRow[]): { months: string[]; values: number[] } {
  const byMonth = new Map<string, number>();
  for (const r of rows) {
    const usd = convertCurrency(Number(r.wonValue ?? 0), r.currency ?? "USD", "USD");
    byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + usd);
  }
  const months = [...byMonth.keys()].sort();
  return { months, values: months.map((m) => Math.round(byMonth.get(m) ?? 0)) };
}

function leadSeries(rows: repo.MonthLeadRow[]): { months: string[]; leads: number[]; won: number[] } {
  const sorted = [...rows].sort((a, b) => a.month.localeCompare(b.month));
  return { months: sorted.map((r) => r.month), leads: sorted.map((r) => r.leads), won: sorted.map((r) => r.won) };
}

export interface ExecScopeOpts {
  scopeType?: string;
  id?: number;
  dateFrom?: string;
  dateTo?: string;
}

// Read-only executive dashboard: a deterministic rollup of health, trends, forecast, team
// performance, and advisory alerts. Never persists; safe to serve from the micro-cache.
export async function getExecutiveDashboard(user: AuthUser, opts: ExecScopeOpts = {}) {
  const resolved = await analytics.resolveScope(user, opts.scopeType, opts.id);
  const s = resolved.analyticsScope;
  const signals = await computeSignals(user, resolved, s);

  return {
    scope: resolved.scope,
    generatedAt: new Date().toISOString(),
    health: {
      business: signals.businessHealth,
      sales: signals.salesHealth,
      pipeline: signals.pipelineHealth,
    },
    kpis: signals.kpis,
    trends: signals.trends,
    forecast: signals.forecast,
    teamPerformance: signals.team,
    alerts: signals.alerts,
    revenueSeries: signals.revenue.months.map((m, i) => ({ month: m, value: signals.revenue.values[i] })),
  };
}

// Shared deterministic computation used by BOTH the read-only dashboard and the persisting
// generate paths — so a persisted artifact is always consistent with what the dashboard shows.
async function computeSignals(
  user: AuthUser,
  resolved: analytics.ResolvedScope,
  s: repo.AnalyticsScope,
) {
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 86_400_000);
  const prevFrom = new Date(now.getTime() - 60 * 86_400_000);
  const monthsAgo = new Date(now.getFullYear(), now.getMonth() - (ANALYSIS_MONTHS - 1), 1);
  const today = todayStr();

  const [
    outcomeCounts,
    outcomeValues,
    prevOutcomeCounts,
    pipelineRows,
    followUp,
    stageRows,
    newLeads,
    newLeadsPrev,
    wonValueMonths,
    leadMonths,
    scanByUser,
    leadByUser,
    wonByUser,
    pipelineByUser,
    followUpByUser,
    scopeUsers,
  ] = await Promise.all([
    repo.leadOutcomeCounts(s, from, now),
    repo.leadOutcomeValues(s, from, now),
    repo.leadOutcomeCounts(s, prevFrom, from),
    repo.openPipelineValues(s),
    repo.followUpStats(s, today),
    repo.leadCountsByStage(s),
    repo.countNewLeads(s, from, now),
    repo.countNewLeads(s, prevFrom, from),
    repo.wonValueByMonth(s, monthsAgo, now),
    repo.leadsByMonth(s, monthsAgo, now),
    repo.scanCountsByUser(s, from, now),
    repo.leadCountsByUser(s, from, now),
    repo.wonCountsByUser(s, from, now),
    repo.openPipelineByUser(s),
    repo.followUpStatsByUser(s, today),
    repo.usersInScope(s),
  ]);

  const wonCount = outcomeCounts.wonCount;
  const lostCount = outcomeCounts.lostCount;
  const decided = wonCount + lostCount;
  const conversionRate = decided === 0 ? 0 : Math.round((wonCount / decided) * 100);
  const prevDecided = prevOutcomeCounts.wonCount + prevOutcomeCounts.lostCount;
  const conversionRatePrev = prevDecided === 0 ? 0 : Math.round((prevOutcomeCounts.wonCount / prevDecided) * 100);

  const openPipelineValue = Math.round(sumUsd(pipelineRows, "pipelineValue"));
  const wonValue = Math.round(sumUsd(outcomeValues, "wonValue"));
  const followUpAdherence =
    followUp.scheduled === 0 ? 100 : Math.round(((followUp.scheduled - followUp.overdue) / followUp.scheduled) * 100);

  const stageCounts: Record<string, number> = {};
  for (const r of stageRows) stageCounts[r.stage] = r.count;

  const revenue = revenueSeries(wonValueMonths);
  const leads = leadSeries(leadMonths);
  const wonValueThisMonth = revenue.values[revenue.values.length - 1] ?? 0;
  const wonValuePrevMonth = revenue.values[revenue.values.length - 2] ?? 0;

  // Health scores (deterministic, transparent).
  const salesHealth = core.computeSalesHealth({
    conversionRate,
    wonCount,
    lostCount,
    newLeads,
    newLeadsPrev,
    followUpAdherence,
  });
  const pipelineHealth = core.computePipelineHealth({
    openPipelineValue,
    wonValue,
    stageCounts,
    followUpsOverdue: followUp.overdue,
    followUpsScheduled: followUp.scheduled,
  });
  const revenueTrend = core.analyzeTrend(revenue.values);
  const businessHealth = core.computeBusinessHealth(salesHealth, pipelineHealth, revenueTrend.changePct);

  // Trends (real monthly series).
  const trends = {
    revenue: revenueTrend,
    leads: core.analyzeTrend(leads.leads),
    won: core.analyzeTrend(leads.won),
  };

  // Forecast next period revenue (deterministic; carries its own confidence).
  const forecast = core.forecastNextPeriod(revenue.values);

  // Team performance (fairness-aware) — merge per-user metrics.
  const userInfo = new Map(scopeUsers.map((u) => [u.id, u]));
  const scanM = mapByUser(scanByUser);
  const leadM = mapByUser(leadByUser);
  const wonM = mapByUser(wonByUser);
  const pipeM = new Map<number, number>();
  for (const r of pipelineByUser) {
    if (r.userId == null) continue;
    pipeM.set(r.userId, (pipeM.get(r.userId) ?? 0) + convertCurrency(Number(r.pipelineValue ?? 0), r.currency ?? "USD", "USD"));
  }
  const overdueM = new Map<number, number>();
  const scheduledM = new Map<number, number>();
  for (const r of followUpByUser) {
    if (r.userId == null) continue;
    overdueM.set(r.userId, r.overdue);
    scheduledM.set(r.userId, r.scheduled);
  }
  const memberIds = new Set<number>([...scanM.keys(), ...leadM.keys(), ...wonM.keys(), ...pipeM.keys(), ...scheduledM.keys()]);
  const members: core.MemberMetrics[] = [...memberIds].map((uid) => ({
    userId: uid,
    name: userInfo.get(uid)?.name ?? "Unknown",
    scans: scanM.get(uid) ?? 0,
    leads: leadM.get(uid) ?? 0,
    won: wonM.get(uid) ?? 0,
    pipelineValue: Math.round(pipeM.get(uid) ?? 0),
    overdue: overdueM.get(uid) ?? 0,
    scheduled: scheduledM.get(uid) ?? 0,
  }));
  const team = core.computeTeamPerformance(members);

  // Team workload imbalance (deterministic): flag members carrying an outsized
  // overdue follow-up load relative to the team average. Grounded in real
  // per-user overdue counts; advisory only.
  const teamAvgOverdue = members.length
    ? members.reduce((acc, m) => acc + m.overdue, 0) / members.length
    : 0;
  const overloaded = members
    .filter((m) => m.overdue >= 5 && m.overdue >= 2 * Math.max(1, teamAvgOverdue))
    .sort((a, b) => b.overdue - a.overdue);
  const topOverloaded = overloaded[0];

  // Deterministic advisory alerts.
  const alerts = core.computeAlerts({
    newLeads,
    newLeadsPrev,
    conversionRate,
    conversionRatePrev,
    followUpsOverdue: followUp.overdue,
    followUpsScheduled: followUp.scheduled,
    openPipelineValue,
    wonValue,
    wonValuePrev: wonValuePrevMonth,
    highValueOpenCount: pipelineRows.filter((r) => convertCurrency(Number(r.pipelineValue ?? 0), r.currency ?? "USD", "USD") >= HIGH_VALUE_THRESHOLD_USD).length,
    topEventUnderperformingName: null,
    teamOverloadCount: overloaded.length,
    teamOverloadName: topOverloaded?.name ?? null,
    teamOverloadOverdue: topOverloaded?.overdue ?? 0,
  });

  const kpis = {
    conversionRate,
    conversionRatePrev,
    wonCount,
    lostCount,
    newLeads,
    newLeadsPrev,
    openPipelineValue,
    wonValue,
    wonValueThisMonth,
    wonValuePrevMonth,
    followUpsScheduled: followUp.scheduled,
    followUpsOverdue: followUp.overdue,
    followUpAdherence,
    headcount: scopeUsers.length,
  };

  return { kpis, salesHealth, pipelineHealth, businessHealth, trends, forecast, team, alerts, revenue, leads };
}

function sumUsd<T extends { currency: string | null }>(rows: T[], key: keyof T): number {
  let total = 0;
  for (const r of rows) total += convertCurrency(Number(r[key] ?? 0), r.currency ?? "USD", "USD");
  return total;
}

function mapByUser(rows: repo.UserCountRow[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of rows) if (r.userId != null) m.set(r.userId, r.value);
  return m;
}

// The tenant's effective provider/model at phrasing time, stamped onto AI-sourced rows only.
// Best-effort: resolveSettings shares lib/ai.ts's in-process cache (no extra DB read); on any
// failure we stamp nulls rather than fabricate provenance.
async function resolveRuntime(companyId: number | null | undefined): Promise<{ provider?: string; model?: string }> {
  if (companyId == null) return {};
  try {
    const s = await resolveSettings(companyId);
    return { provider: s.provider, model: s.model };
  } catch {
    return {};
  }
}

// ---- Period keys -------------------------------------------------------------

function periodKeyFor(periodType: string, d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  if (periodType === "daily") return `${y}-${m}-${String(d.getDate()).padStart(2, "0")}`;
  if (periodType === "monthly") return `${y}-${m}`;
  if (periodType === "quarterly") return `${y}-Q${Math.floor(d.getMonth() / 3) + 1}`;
  // weekly (ISO week)
  const tmp = new Date(Date.UTC(y, d.getMonth(), d.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ---- Generate + persist ------------------------------------------------------

const VALID_PERIODS = ["daily", "weekly", "monthly", "quarterly"];

// Render the computed signals into a compact, numbers-only context block for the LLM.
// The model PHRASES from these figures and must not invent new ones.
function summaryContext(signals: Awaited<ReturnType<typeof computeSignals>>, scopeName: string): string {
  const k = signals.kpis;
  const line = (n: number | null) => (n == null ? "n/a" : String(n));
  return [
    `Scope: ${scopeName}`,
    `Business health: ${signals.businessHealth.score}/100 (${signals.businessHealth.rating})`,
    `Sales health: ${signals.salesHealth.score}/100; Pipeline health: ${signals.pipelineHealth.score}/100`,
    `Conversion rate: ${k.conversionRate}% (prev ${k.conversionRatePrev}%)`,
    `New leads: ${k.newLeads} (prev ${k.newLeadsPrev}); Won: ${k.wonCount}; Lost: ${k.lostCount}`,
    `Open pipeline (USD): ${k.openPipelineValue}; Won value (USD): ${k.wonValue}`,
    `Won value this month (USD): ${k.wonValueThisMonth} (prev month ${k.wonValuePrevMonth})`,
    `Follow-ups: ${k.followUpsScheduled} scheduled, ${k.followUpsOverdue} overdue, adherence ${k.followUpAdherence}%`,
    `Revenue trend: ${signals.trends.revenue.direction} (${line(signals.trends.revenue.changePct)}% change)`,
    `Lead trend: ${signals.trends.leads.direction}; Won trend: ${signals.trends.won.direction}`,
    `Next-period revenue forecast (USD): expected ${signals.forecast.expected}, range ${signals.forecast.low}-${signals.forecast.high}, method ${signals.forecast.method}, confidence ${signals.forecast.confidence}`,
    `Active alerts: ${signals.alerts.length ? signals.alerts.map((a) => `${a.title} [${a.severity}]`).join("; ") : "none"}`,
    `Headcount: ${k.headcount}`,
  ].join("\n");
}

export interface GenerateSummaryOpts extends ExecScopeOpts {
  periodType?: string;
  appLanguage?: AppLanguage;
}

export async function generateSummary(user: AuthUser, opts: GenerateSummaryOpts = {}) {
  const periodType = opts.periodType ?? "weekly";
  if (!VALID_PERIODS.includes(periodType)) throw new AppError(400, "Invalid periodType");
  const resolved = await analytics.resolveScope(user, opts.scopeType, opts.id);
  const s = resolved.analyticsScope;
  const signals = await computeSignals(user, resolved, s);

  // Deterministic grounded core — always present, always honest.
  const deterministic = {
    headline: `${resolved.scope.name}: business health ${signals.businessHealth.score}/100 (${signals.businessHealth.rating}).`,
    narrative: `Conversion ${signals.kpis.conversionRate}% with ${signals.kpis.newLeads} new leads and ${signals.kpis.wonCount} wins over the last 30 days. Revenue trend is ${signals.trends.revenue.direction}.`,
    highlights: buildHighlights(signals),
    risks: signals.alerts.map((a) => a.title),
    recommendations: signals.alerts.map((a) => a.recommendation),
    healthScores: { business: signals.businessHealth, sales: signals.salesHealth, pipeline: signals.pipelineHealth },
    kpiSnapshot: signals.kpis,
    forecast: signals.forecast,
    trends: signals.trends,
  };

  let data: Record<string, unknown> = { ...deterministic };
  let confidence = 100;
  let reasoning = "Deterministic executive summary grounded in the last 30 days of CRM data.";
  let source: "ai" | "deterministic" = "deterministic";
  let provider: string | null = null;
  let model: string | null = null;
  let promptKey: string | null = null;
  let promptVersion: number | null = null;

  // Best-effort AI phrasing (soft-degrade: the deterministic core survives any failure).
  const runtime = await resolveRuntime(user.companyId);
  try {
    const phrased = await ai.phraseExecutiveSummary(summaryContext(signals, resolved.scope.name), opts.appLanguage ?? "en", {
      companyId: user.companyId ?? null,
      userId: user.id,
    });
    data = {
      ...deterministic,
      headline: phrased.headline ?? deterministic.headline,
      narrative: phrased.narrative ?? deterministic.narrative,
      highlights: phrased.highlights.length ? phrased.highlights : deterministic.highlights,
      risks: phrased.risks.length ? phrased.risks : deterministic.risks,
      recommendations: phrased.recommendations.length ? phrased.recommendations : deterministic.recommendations,
    };
    confidence = phrased.confidence || 100;
    reasoning = phrased.reasoning || reasoning;
    source = "ai";
    provider = runtime.provider ?? null;
    model = runtime.model ?? null;
    promptKey = PROMPTS.executive_summary.key;
    promptVersion = PROMPTS.executive_summary.version;
  } catch (err) {
    ai.logAiError("executive_summary", err);
  }

  return execRepo.upsertSummary({
    companyId: user.companyId!,
    scopeType: resolved.scope.type,
    scopeId: scopeIdOf(resolved.scope.id),
    periodType,
    periodKey: periodKeyFor(periodType),
    data,
    confidence,
    reasoning,
    source,
    provider,
    model,
    promptKey,
    promptVersion,
  });
}

function buildHighlights(signals: Awaited<ReturnType<typeof computeSignals>>): string[] {
  const h: string[] = [];
  const k = signals.kpis;
  if (k.wonCount > 0) h.push(`${k.wonCount} deals won (USD ${k.wonValue.toLocaleString()})`);
  if (signals.trends.revenue.direction === "growth") h.push(`Revenue trending up (${signals.trends.revenue.changePct ?? 0}%)`);
  if (k.followUpAdherence >= 80) h.push(`Strong follow-up adherence (${k.followUpAdherence}%)`);
  if (signals.team[0]) h.push(`Top performer: ${signals.team[0].name}`);
  return h.slice(0, 4);
}

export interface GenerateForecastOpts extends ExecScopeOpts {
  forecastType?: string;
  horizon?: string;
  appLanguage?: AppLanguage;
}

// Each forecast type projects a DISTINCT real series (not always revenue): revenue → USD
// won value; pipeline → count of won deals; leads → count of new leads. The deterministic
// core (forecastNextPeriod) runs over the selected series so the persisted expected/low/high
// and confidence actually reflect the requested dimension.
const FORECAST_TYPES = new Set([
  "revenue",
  "pipeline",
  "leads",
  "lead_conversion",
  "workload",
  "risk",
]);
const FORECAST_TYPES_LABEL = "revenue | pipeline | leads | lead_conversion | workload | risk";

function forecastSeriesFor(forecastType: string, signals: Awaited<ReturnType<typeof computeSignals>>): {
  months: string[];
  values: number[];
  unit: string;
  label: string;
  isCurrency: boolean;
  extraAssumptions?: string[];
} {
  switch (forecastType) {
    case "pipeline":
      return { months: signals.leads.months, values: signals.leads.won, unit: "deals", label: "won deals", isCurrency: false };
    case "leads":
      return { months: signals.leads.months, values: signals.leads.leads, unit: "leads", label: "new leads", isCurrency: false };
    case "lead_conversion": {
      // Per-month conversion rate = won / new leads. Grounded in the real
      // monthly won/leads series; guards divide-by-zero months.
      const values = signals.leads.leads.map((l, i) =>
        l > 0 ? Math.round(((signals.leads.won[i] ?? 0) / l) * 100) : 0,
      );
      return {
        months: signals.leads.months,
        values,
        unit: "%",
        label: "lead conversion rate",
        isCurrency: false,
        extraAssumptions: ["Conversion = won ÷ new leads per month (real series)"],
      };
    }
    case "workload": {
      // Resource-needs proxy: incoming lead volume is the demand driver a team
      // must service next period. Uses the real monthly new-leads series.
      return {
        months: signals.leads.months,
        values: signals.leads.leads,
        unit: "leads",
        label: "team workload (incoming leads to service)",
        isCurrency: false,
        extraAssumptions: ["Workload proxied by incoming lead volume (resource-needs driver)"],
      };
    }
    case "risk": {
      // Upcoming risk exposure: leads not (yet) won per month — the unconverted
      // backlog carrying churn/slippage risk. Derived from the real series.
      const values = signals.leads.leads.map((l, i) => Math.max(0, l - (signals.leads.won[i] ?? 0)));
      return {
        months: signals.leads.months,
        values,
        unit: "leads",
        label: "at-risk unconverted leads",
        isCurrency: false,
        extraAssumptions: ["Risk = new leads − won per month (unconverted exposure)"],
      };
    }
    default:
      return { months: signals.revenue.months, values: signals.revenue.values, unit: "USD", label: "revenue", isCurrency: true };
  }
}

export async function generateForecast(user: AuthUser, opts: GenerateForecastOpts = {}) {
  const forecastType = opts.forecastType ?? "revenue";
  if (!FORECAST_TYPES.has(forecastType)) throw new AppError(400, `Invalid forecastType (${FORECAST_TYPES_LABEL})`);
  const horizon = opts.horizon ?? "next_period";
  const resolved = await analytics.resolveScope(user, opts.scopeType, opts.id);
  const s = resolved.analyticsScope;
  const signals = await computeSignals(user, resolved, s);
  const series = forecastSeriesFor(forecastType, signals);
  const f = core.forecastNextPeriod(series.values);
  const assumptions = [...(series.extraAssumptions ?? []), ...f.assumptions];

  const fmt = (n: number) => (series.isCurrency ? `USD ${n.toLocaleString()}` : `${n.toLocaleString()} ${series.unit}`);
  const deterministic = {
    expected: f.expected,
    low: f.low,
    high: f.high,
    unit: series.unit,
    label: series.label,
    method: f.method,
    historyPoints: f.historyPoints,
    assumptions,
    series: series.months.map((m, i) => ({ month: m, value: series.values[i] })),
    narrative: `Projected next-period ${series.label} of ${fmt(f.expected)} (range ${fmt(f.low)}–${fmt(f.high)}), ${f.method.replace("_", " ")}.`,
    watchouts: assumptions,
  };

  let data: Record<string, unknown> = { ...deterministic };
  let confidence = f.confidence;
  let reasoning = `Deterministic ${f.method} forecast from ${f.historyPoints} periods of real ${series.label} history.`;
  let source: "ai" | "deterministic" = "deterministic";
  let provider: string | null = null;
  let model: string | null = null;
  let promptKey: string | null = null;
  let promptVersion: number | null = null;

  try {
    const ctx = [
      `Forecast type: ${forecastType} (${series.label}); horizon: ${horizon}`,
      `Expected (${series.unit}): ${f.expected}; range ${f.low}-${f.high}`,
      `Method: ${f.method}; history points: ${f.historyPoints}; computed confidence: ${f.confidence}`,
      `Assumptions: ${f.assumptions.join("; ")}`,
      `Recent ${series.label} series (${series.unit}): ${series.values.join(", ")}`,
    ].join("\n");
    const runtime = await resolveRuntime(user.companyId);
    const phrased = await ai.phraseExecutiveForecast(ctx, opts.appLanguage ?? "en", { companyId: user.companyId ?? null, userId: user.id });
    data = {
      ...deterministic,
      narrative: phrased.narrative ?? deterministic.narrative,
      watchouts: phrased.watchouts.length ? phrased.watchouts : deterministic.watchouts,
    };
    reasoning = phrased.reasoning || reasoning;
    source = "ai";
    provider = runtime.provider ?? null;
    model = runtime.model ?? null;
    promptKey = PROMPTS.executive_forecast.key;
    promptVersion = PROMPTS.executive_forecast.version;
  } catch (err) {
    ai.logAiError("executive_forecast", err);
  }

  return execRepo.upsertForecast({
    companyId: user.companyId!,
    scopeType: resolved.scope.type,
    scopeId: scopeIdOf(resolved.scope.id),
    forecastType,
    horizon,
    method: f.method,
    data,
    confidence,
    reasoning,
    source,
    provider,
    model,
    promptKey,
    promptVersion,
  });
}

// Recompute + persist the deterministic advisory alerts for a scope. Alerts are purely
// deterministic (source stays "deterministic", no AI provenance). Alert types no longer
// firing are marked dismissed so the persisted set matches current reality.
export async function generateAlerts(user: AuthUser, opts: ExecScopeOpts = {}) {
  const resolved = await analytics.resolveScope(user, opts.scopeType, opts.id);
  const s = resolved.analyticsScope;
  const signals = await computeSignals(user, resolved, s);
  const scopeId = scopeIdOf(resolved.scope.id);

  for (const a of signals.alerts) {
    await execRepo.upsertAlert({
      companyId: user.companyId!,
      scopeType: resolved.scope.type,
      scopeId,
      alertType: a.alertType,
      severity: a.severity,
      data: { title: a.title, detail: a.detail, recommendation: a.recommendation, metric: a.metric },
      confidence: a.confidence,
      reasoning: a.detail,
      source: "deterministic",
    });
  }
  const scope = await computeReadScope(user);
  return execRepo.listAlerts(user, scope, null, 50);
}

// ---- Read + lifecycle (delegate to repo with tenant scope + scope privacy) ---
// Every read/lifecycle path re-constrains to the caller's scope entitlement (see
// computeReadScope) so a view-only employee can never read/mutate company-wide artifacts
// straight from the persisted tables — the persisted layer matches the live dashboard's
// scope privacy.

export async function listSummaries(user: AuthUser, periodType: string | null, limit = 20) {
  const scope = await computeReadScope(user);
  return execRepo.listSummaries(user, scope, periodType, limit);
}
export async function getSummary(user: AuthUser, id: number) {
  const scope = await computeReadScope(user);
  const row = await execRepo.getSummaryById(user, scope, id);
  if (!row) throw new AppError(404, "Summary not found");
  return row;
}
export async function setSummaryStatus(user: AuthUser, id: number, status: "accepted" | "dismissed" | "suggested") {
  const scope = await computeReadScope(user);
  const row = await execRepo.setSummaryStatus(user, scope, id, status, status === "accepted" ? user.id : null);
  if (!row) throw new AppError(404, "Summary not found");
  return row;
}

export async function listAlerts(user: AuthUser, status: string | null, limit = 50) {
  const scope = await computeReadScope(user);
  return execRepo.listAlerts(user, scope, status, limit);
}
export async function setAlertStatus(user: AuthUser, id: number, status: "accepted" | "dismissed" | "suggested") {
  const scope = await computeReadScope(user);
  const row = await execRepo.setAlertStatus(user, scope, id, status, status === "accepted" ? user.id : null);
  if (!row) throw new AppError(404, "Alert not found");
  return row;
}

export async function listForecasts(user: AuthUser, forecastType: string | null, limit = 20) {
  const scope = await computeReadScope(user);
  return execRepo.listForecasts(user, scope, forecastType, limit);
}

export async function alertStatusCounts(user: AuthUser) {
  const scope = await computeReadScope(user);
  return execRepo.statusCounts(user, scope);
}

// ---------------------------------------------------------------------------
// Executive AI Reports (export). A report is generated ASYNC: the request
// persists a "pending" row and enqueues a background job, then returns 202 with
// a pollable id. The worker composes REAL dashboard data into a PDF/Excel file,
// uploads it to object storage, and flips the row to "ready" with a download
// key. Reports are deterministic compositions of grounded data — they NEVER
// carry AI provenance and NEVER write the source CRM.
// ---------------------------------------------------------------------------

export const EXECUTIVE_REPORT_JOB = "executive_report_generate";

export interface ExecutiveReportJobPayload {
  companyId: number;
  reportId: number;
  scopeType: string;
  scopeId: number;
  reportType: string;
  periodType: string;
  format: string;
  userId: number;
}

const REPORT_TYPES = new Set(["executive_summary", "performance", "forecast", "full"]);
const REPORT_FORMATS = new Set(["pdf", "xlsx"]);

// Map the persisted row to the API response shape. `downloadUrl` is minted fresh
// (short-lived signed URL) only when the file is ready — it is never persisted.
async function toReportResponse(row: import("@workspace/db").ExecutiveReport) {
  let downloadUrl: string | null = null;
  if (row.status === "ready" && row.objectPath) {
    try {
      downloadUrl = await exportDownloadURL(row.objectPath, 300);
    } catch {
      downloadUrl = null; // storage hiccup — surface the row without a URL rather than 500
    }
  }
  return {
    id: row.id,
    companyId: row.companyId,
    reportType: row.reportType,
    periodType: row.periodType,
    periodKey: row.periodKey,
    format: row.format,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    status: row.status,
    downloadUrl,
    error: row.error,
    data: row.data,
    confidence: row.confidence,
    source: row.source,
    provider: row.provider,
    model: row.model,
    promptKey: row.promptKey,
    promptVersion: row.promptVersion,
    generatedAt: (row.completedAt ?? row.generatedAt).toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface GenerateReportOpts {
  scopeType?: string;
  id?: number;
  reportType?: string;
  periodType?: string;
  format?: string;
  language?: AppLanguage;
}

export async function generateReport(user: AuthUser, opts: GenerateReportOpts) {
  const reportType = String(opts.reportType ?? "");
  const format = String(opts.format ?? "");
  const periodType = opts.periodType ?? "monthly";
  if (!REPORT_TYPES.has(reportType)) throw new AppError(400, "Invalid reportType");
  if (!REPORT_FORMATS.has(format)) throw new AppError(400, "Invalid format (pdf | xlsx)");
  if (!VALID_PERIODS.includes(periodType)) throw new AppError(400, "Invalid periodType");

  const resolved = await analytics.resolveScope(user, opts.scopeType, opts.id);
  const scopeId = scopeIdOf(resolved.scope.id);
  const row = await execRepo.createReport({
    companyId: user.companyId!,
    scopeType: resolved.scope.type,
    scopeId,
    reportType,
    periodType,
    periodKey: periodKeyFor(periodType),
    format,
    requestedById: user.id,
  });

  await getQueue().enqueue<ExecutiveReportJobPayload>(
    EXECUTIVE_REPORT_JOB,
    { companyId: user.companyId!, reportId: row.id, scopeType: resolved.scope.type, scopeId, reportType, periodType, format, userId: user.id },
    { maxAttempts: 1, dedupeKey: `exec-report:${row.id}` },
  );
  return toReportResponse(row);
}

export async function listReports(user: AuthUser, limit = 20) {
  const scope = await computeReadScope(user);
  const rows = await execRepo.listReports(user, scope, limit);
  return Promise.all(rows.map(toReportResponse));
}

export async function getReport(user: AuthUser, id: number) {
  const scope = await computeReadScope(user);
  const row = await execRepo.getReportById(user, scope, id);
  if (!row) throw new AppError(404, "Report not found");
  return toReportResponse(row);
}

// Compose a title + column/row matrix for a report type from the real dashboard.
function composeReportTable(reportType: string, periodType: string, dash: Awaited<ReturnType<typeof getExecutiveDashboard>>): {
  title: string;
  columns: string[];
  rows: string[][];
  sections: Record<string, unknown>;
} {
  const scopeName = dash.scope.name;
  const period = periodType.charAt(0).toUpperCase() + periodType.slice(1); // Daily | Weekly | Monthly | Quarterly
  if (reportType === "performance") {
    const columns = ["Rank", "Name", "Overall", "Activity", "Conversion", "Hygiene", "Scans", "Leads", "Won", "Pipeline (USD)", "Note"];
    const rows = dash.teamPerformance.map((m, i) => [
      String(i + 1),
      m.name,
      String(m.overall),
      String(m.activityScore),
      String(m.conversionScore),
      String(m.hygieneScore),
      String(m.scans),
      String(m.leads),
      String(m.won),
      String(m.pipelineValue),
      m.smallSample ? "small sample" : "",
    ]);
    return { title: `${period} Team Performance — ${scopeName}`, columns, rows, sections: { teamPerformance: dash.teamPerformance } };
  }
  if (reportType === "forecast") {
    const f = dash.forecast;
    const columns = ["Metric", "Value"];
    const rows: string[][] = [
      ["Expected (next period, USD)", String(f.expected)],
      ["Low", String(f.low)],
      ["High", String(f.high)],
      ["Method", f.method],
      ["Confidence", `${f.confidence}%`],
      ["History points", String(f.historyPoints)],
      ...f.assumptions.map((a) => ["Assumption", a]),
      ...dash.revenueSeries.map((p) => [`Revenue ${p.month}`, String(p.value)]),
    ];
    return { title: `${period} Forecast — ${scopeName}`, columns, rows, sections: { forecast: f, revenueSeries: dash.revenueSeries } };
  }
  // executive_summary and full share a Section/Metric/Value layout.
  const columns = ["Section", "Metric", "Value"];
  const k = dash.kpis as Record<string, unknown>;
  const rows: string[][] = [
    ["Health", "Business", `${dash.health.business.score} (${dash.health.business.rating})`],
    ["Health", "Sales", `${dash.health.sales.score} (${dash.health.sales.rating})`],
    ["Health", "Pipeline", `${dash.health.pipeline.score} (${dash.health.pipeline.rating})`],
    ["KPI", "Conversion rate", `${k.conversionRate ?? 0}%`],
    ["KPI", "New leads (30d)", String(k.newLeads ?? 0)],
    ["KPI", "Won count", String(k.wonCount ?? 0)],
    ["KPI", "Won value (USD)", String(k.wonValue ?? 0)],
    ["KPI", "Open pipeline (USD)", String(k.openPipelineValue ?? 0)],
    ["KPI", "Follow-ups scheduled", String(k.followUpsScheduled ?? 0)],
    ["KPI", "Follow-ups overdue", String(k.followUpsOverdue ?? 0)],
    ["KPI", "Headcount", String(k.headcount ?? 0)],
    ["Trend", "Revenue", `${dash.trends.revenue.direction} (${dash.trends.revenue.changePct ?? 0}%)`],
    ["Trend", "Leads", dash.trends.leads.direction],
    ["Trend", "Won", dash.trends.won.direction],
    ["Forecast", "Expected (USD)", `${dash.forecast.expected} (conf ${dash.forecast.confidence}%)`],
  ];
  for (const a of dash.alerts) rows.push(["Alert", `${a.severity}: ${a.title}`, a.recommendation]);
  if (reportType === "full") {
    for (const m of dash.teamPerformance) rows.push(["Team", m.name, `overall ${m.overall}, won ${m.won}, pipeline ${m.pipelineValue}`]);
  }
  return {
    title: `${period} Executive Summary — ${scopeName}`,
    columns,
    rows,
    sections: { scope: dash.scope, health: dash.health, kpis: dash.kpis, trends: dash.trends, forecast: dash.forecast, alerts: dash.alerts, ...(reportType === "full" ? { teamPerformance: dash.teamPerformance } : {}) },
  };
}

// Background worker: builds the file from REAL dashboard data and stores it.
// Any failure marks the row failed (never crashes the process); maxAttempts is 1.
export async function runExecutiveReportJob(payload: ExecutiveReportJobPayload): Promise<void> {
  const { companyId, reportId } = payload;
  try {
    await execRepo.updateReportResult(companyId, reportId, { status: "generating" });
    // Rebuild the requester's full AuthUser so the tenant-scoped dashboard read is
    // isolated exactly as it was at request time (accessibleCompanies/role/perms).
    const worker = await loadAuthUserById(payload.userId);
    if (!worker || worker.companyId !== companyId) throw new AppError(403, "Report requester is no longer authorized");
    const dash = await getExecutiveDashboard(worker, {
      scopeType: payload.scopeType,
      id: payload.scopeId === 0 ? undefined : payload.scopeId,
    });
    const periodType = payload.periodType ?? "monthly";
    const { title, columns, rows, sections } = composeReportTable(payload.reportType, periodType, dash);
    const exportFormat: ExportFormat = payload.format === "xlsx" ? "excel" : "pdf";
    const buffer = await generateFile({ format: exportFormat, title, columns, rows });
    const contentType = payload.format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf";
    const { objectPath } = await uploadExportBuffer(buffer, contentType);
    const fileName = `${payload.reportType}-${periodType}-${dash.scope.type}-${todayStr()}.${payload.format}`;
    await execRepo.updateReportResult(companyId, reportId, {
      status: "ready",
      objectPath,
      fileName,
      // Reports are deterministic compositions of grounded data: full confidence,
      // and NO AI provenance (provider/model/promptVersion stay null — honest).
      confidence: 100,
      source: "deterministic",
      provider: null,
      model: null,
      promptKey: null,
      promptVersion: null,
      data: { title, generatedAt: dash.generatedAt, sections },
    });
  } catch (err) {
    await execRepo.updateReportResult(companyId, reportId, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
