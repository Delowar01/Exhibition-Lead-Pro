import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  useGetAiExecutiveDashboard,
  getGetAiExecutiveDashboardQueryKey,
  useListAiExecutiveSummaries,
  getListAiExecutiveSummariesQueryKey,
  useGenerateAiExecutiveSummary,
  useAcceptAiExecutiveSummary,
  useDismissAiExecutiveSummary,
  useListAiExecutiveAlerts,
  getListAiExecutiveAlertsQueryKey,
  useGenerateAiExecutiveAlerts,
  useAcceptAiExecutiveAlert,
  useDismissAiExecutiveAlert,
  useListAiExecutiveForecasts,
  getListAiExecutiveForecastsQueryKey,
  useGenerateAiExecutiveForecast,
  useListAiExecutiveReports,
  getListAiExecutiveReportsQueryKey,
  useGenerateAiExecutiveReport,
  type ExecutiveTeamMember,
  type ExecutiveAlertItem,
  type ExecutiveSummary,
  type ExecutiveReport,
} from "@workspace/api-client-react";
import {
  LineChart as LineChartIcon,
  Activity,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  Users,
  Gauge,
  FileText,
  Download,
  Sparkles,
  RefreshCw,
  Check,
  X,
} from "lucide-react";

// Stage 5C — Enterprise AI Executive Intelligence Center (manager-gated).
// A read-only executive rollup (health, KPIs, revenue trend, forecast, alerts, team
// performance) plus reviewable AI artifacts (summaries, alerts, forecasts) and
// deterministic exportable reports. Nothing here auto-executes or writes the CRM.

const RATING_TONE: Record<string, string> = {
  excellent: "text-emerald-600",
  good: "text-sky-600",
  fair: "text-amber-600",
  at_risk: "text-rose-600",
};

const SEVERITY_TONE: Record<string, string> = {
  critical: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 border-rose-300/50",
  high: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-amber-300/50",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-amber-300/50",
  medium: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300 border-sky-300/50",
  low: "bg-muted text-muted-foreground",
  info: "bg-muted text-muted-foreground",
};

const STATUS_TONE: Record<string, string> = {
  ready: "bg-emerald-100 text-emerald-800 border-emerald-300/50",
  pending: "bg-sky-100 text-sky-800 border-sky-300/50",
  processing: "bg-sky-100 text-sky-800 border-sky-300/50",
  generating: "bg-sky-100 text-sky-800 border-sky-300/50",
  failed: "bg-rose-100 text-rose-800 border-rose-300/50",
};

function usd(n: number | null | undefined): string {
  return `$${Math.round(Number(n ?? 0)).toLocaleString()}`;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function triggerDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function TrendPill({ direction, changePct }: { direction: string; changePct: number | null }) {
  const Icon = direction === "growth" ? TrendingUp : direction === "decline" ? TrendingDown : Minus;
  const tone = direction === "growth" ? "text-emerald-600" : direction === "decline" ? "text-rose-600" : "text-muted-foreground";
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${tone}`}>
      <Icon className="h-3.5 w-3.5" />
      {changePct === null || changePct === undefined ? direction : `${changePct >= 0 ? "+" : ""}${changePct}%`}
    </span>
  );
}

function HealthCard({ label, score, rating, factors }: { label: string; score: number; rating: string; factors: { label: string; value: number }[] }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-widest text-muted-foreground">{label}</span>
        <span className={`text-xs font-semibold capitalize ${RATING_TONE[rating] ?? ""}`}>{rating.replace("_", " ")}</span>
      </div>
      <div className={`text-3xl font-bold tracking-tight mt-1 ${RATING_TONE[rating] ?? ""}`}>{score}</div>
      <div className="mt-3 space-y-1.5">
        {factors.map((f) => (
          <div key={f.label} className="space-y-0.5">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{f.label}</span>
              <span>{Math.round(f.value)}</span>
            </div>
            <div className="h-1 rounded-full bg-secondary overflow-hidden">
              <div className="h-full bg-primary/60" style={{ width: `${Math.min(100, Math.max(0, f.value))}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const KPI_LABELS: [string, string, boolean][] = [
  ["conversionRate", "Conversion", false],
  ["newLeads", "New leads (30d)", false],
  ["wonCount", "Wins", false],
  ["wonValue", "Won value", true],
  ["openPipelineValue", "Open pipeline", true],
  ["followUpsScheduled", "Follow-ups", false],
  ["followUpsOverdue", "Overdue", false],
  ["headcount", "Headcount", false],
];

function summaryText(s: ExecutiveSummary): { headline: string; narrative: string; highlights: string[] } {
  const d = (s.data ?? {}) as Record<string, unknown>;
  return {
    headline: typeof d.headline === "string" ? d.headline : "Executive summary",
    narrative: typeof d.narrative === "string" ? d.narrative : "",
    highlights: Array.isArray(d.highlights) ? (d.highlights as unknown[]).map(String) : [],
  };
}

function TeamRow({ m }: { m: ExecutiveTeamMember }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="w-8 h-8 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-bold shrink-0">
        {m.name.substring(0, 2).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{m.name}</span>
          {m.smallSample && <Badge variant="outline" className="text-[9px]">small sample</Badge>}
        </div>
        <p className="text-xs text-muted-foreground truncate">
          {m.scans} scans · {m.leads} leads · {m.won} won · {usd(m.pipelineValue)} pipeline
        </p>
      </div>
      <div className="text-right shrink-0">
        <div className="text-lg font-bold">{m.overall}</div>
        <div className="text-[9px] uppercase tracking-wide text-muted-foreground">overall</div>
      </div>
    </div>
  );
}

export default function AdminExecutiveIntelligence() {
  const qc = useQueryClient();
  const [reportType, setReportType] = React.useState("executive_summary");
  const [reportPeriodType, setReportPeriodType] = React.useState("monthly");
  const [reportFormat, setReportFormat] = React.useState("pdf");
  const [forecastType, setForecastType] = React.useState("revenue");

  const dashQuery = useGetAiExecutiveDashboard(undefined, { query: { queryKey: getGetAiExecutiveDashboardQueryKey() } });
  const summariesQuery = useListAiExecutiveSummaries(undefined, { query: { queryKey: getListAiExecutiveSummariesQueryKey() } });
  const alertsQuery = useListAiExecutiveAlerts(undefined, { query: { queryKey: getListAiExecutiveAlertsQueryKey() } });
  const forecastsQuery = useListAiExecutiveForecasts(undefined, { query: { queryKey: getListAiExecutiveForecastsQueryKey() } });
  const reportsQuery = useListAiExecutiveReports(undefined, {
    query: { queryKey: getListAiExecutiveReportsQueryKey(), refetchInterval: 5000 },
  });

  const genSummary = useGenerateAiExecutiveSummary();
  const acceptSummary = useAcceptAiExecutiveSummary();
  const dismissSummary = useDismissAiExecutiveSummary();
  const genAlerts = useGenerateAiExecutiveAlerts();
  const acceptAlert = useAcceptAiExecutiveAlert();
  const dismissAlert = useDismissAiExecutiveAlert();
  const genForecast = useGenerateAiExecutiveForecast();
  const genReport = useGenerateAiExecutiveReport();

  const dash = dashQuery.data;

  const invalidate = (key: readonly unknown[]) => qc.invalidateQueries({ queryKey: key });

  const [periodType, setPeriodType] = React.useState("weekly");

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center gap-2">
        <LineChartIcon className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Executive Intelligence Center</h1>
          <p className="text-sm text-muted-foreground">
            AI-assisted executive rollup — health, trends, forecasts, alerts, and team performance. Advisory only; nothing is written to your CRM.
          </p>
        </div>
      </div>

      {/* Health */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Gauge className="h-4 w-4 text-primary" /> Business Health
            {dash && <span className="text-xs font-normal text-muted-foreground">· {dash.scope.name}</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {dashQuery.isLoading || !dash ? (
            <div className="grid gap-4 sm:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              <HealthCard label="Business" score={dash.health.business.score} rating={dash.health.business.rating} factors={dash.health.business.factors} />
              <HealthCard label="Sales" score={dash.health.sales.score} rating={dash.health.sales.rating} factors={dash.health.sales.factors} />
              <HealthCard label="Pipeline" score={dash.health.pipeline.score} rating={dash.health.pipeline.rating} factors={dash.health.pipeline.factors} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* KPIs */}
      {dash && (
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          {KPI_LABELS.map(([key, label, isMoney]) => {
            const raw = (dash.kpis as Record<string, unknown>)[key];
            return (
              <div key={key} className="rounded-lg border border-border bg-card p-3">
                <div className="text-xl font-bold tracking-tight">
                  {isMoney ? usd(num(raw)) : key === "conversionRate" ? `${num(raw)}%` : num(raw).toLocaleString()}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mt-0.5">{label}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Revenue trend + forecast */}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="shadow-sm lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" /> Revenue Trend
              {dash && (
                <span className="ml-2 flex items-center gap-3">
                  <TrendPill direction={dash.trends.revenue.direction} changePct={dash.trends.revenue.changePct} />
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dashQuery.isLoading || !dash ? (
              <Skeleton className="h-56 w-full" />
            ) : dash.revenueSeries.length === 0 ? (
              <p className="text-sm text-muted-foreground py-16 text-center">No revenue history yet.</p>
            ) : (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={dash.revenueSeries} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="execRev" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} />
                    <Tooltip formatter={(v: number) => usd(v)} />
                    <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#execRev)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" /> Revenue Forecast
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dashQuery.isLoading || !dash ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <div className="space-y-3">
                <div>
                  <div className="text-3xl font-bold tracking-tight">{usd(dash.forecast.expected)}</div>
                  <div className="text-xs text-muted-foreground">expected next period</div>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Range</span>
                  <span className="font-medium">{usd(dash.forecast.low)} – {usd(dash.forecast.high)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Confidence</span>
                  <span className="font-medium">{dash.forecast.confidence}%</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Method</span>
                  <span className="font-medium capitalize">{dash.forecast.method.replace(/_/g, " ")}</span>
                </div>
                {dash.forecast.assumptions.length > 0 && (
                  <ul className="pt-1 space-y-1 border-t border-border">
                    {dash.forecast.assumptions.map((a, i) => (
                      <li key={i} className="text-xs text-muted-foreground flex items-start gap-2">
                        <div className="w-1 h-1 rounded-full bg-muted-foreground mt-1.5 shrink-0" /> {a}
                      </li>
                    ))}
                  </ul>
                )}
                <Select value={forecastType} onValueChange={setForecastType}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="revenue">Revenue</SelectItem>
                    <SelectItem value="pipeline">Pipeline (won deals)</SelectItem>
                    <SelectItem value="leads">New leads</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full gap-1"
                  disabled={genForecast.isPending}
                  onClick={() =>
                    genForecast.mutate(
                      { data: { forecastType } },
                      { onSuccess: () => invalidate(getListAiExecutiveForecastsQueryKey()) },
                    )
                  }
                >
                  <Sparkles className="h-3.5 w-3.5" /> {genForecast.isPending ? "Generating…" : "Save AI forecast"}
                </Button>
                {forecastsQuery.data && forecastsQuery.data.forecasts.length > 0 && (
                  <p className="text-[11px] text-muted-foreground">{forecastsQuery.data.forecasts.length} saved forecast(s)</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Alerts + Team */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" /> Executive Alerts
            </CardTitle>
            <Button
              size="sm"
              variant="outline"
              className="gap-1"
              disabled={genAlerts.isPending}
              onClick={() => genAlerts.mutate({ data: {} }, { onSuccess: () => invalidate(getListAiExecutiveAlertsQueryKey()) })}
            >
              <RefreshCw className="h-3.5 w-3.5" /> {genAlerts.isPending ? "Scanning…" : "Generate"}
            </Button>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            {dashQuery.isLoading ? (
              <p className="text-sm text-muted-foreground py-4">Loading…</p>
            ) : !dash || dash.alerts.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No active alerts. 🎉</p>
            ) : (
              dash.alerts.map((a: ExecutiveAlertItem, i) => (
                <div key={`${a.alertType}-${i}`} className="flex items-start gap-3 py-3">
                  <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full border shrink-0 ${SEVERITY_TONE[a.severity] ?? SEVERITY_TONE.info}`}>
                    {a.severity}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{a.title}</div>
                    <p className="text-xs text-muted-foreground mt-0.5">{a.detail}</p>
                    {a.recommendation && <p className="text-xs text-primary mt-0.5">→ {a.recommendation}</p>}
                  </div>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">{a.confidence}%</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" /> Team Performance
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            {dashQuery.isLoading ? (
              <p className="text-sm text-muted-foreground py-4">Loading…</p>
            ) : !dash || dash.teamPerformance.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No team performance data.</p>
            ) : (
              dash.teamPerformance.slice(0, 12).map((m) => <TeamRow key={m.userId} m={m} />)
            )}
          </CardContent>
        </Card>
      </div>

      {/* Executive summaries */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Executive Summaries
          </CardTitle>
          <div className="flex items-center gap-2">
            <Select value={periodType} onValueChange={setPeriodType}>
              <SelectTrigger className="w-[130px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="quarterly">Quarterly</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              className="gap-1"
              disabled={genSummary.isPending}
              onClick={() =>
                genSummary.mutate(
                  { data: { periodType } },
                  { onSuccess: () => invalidate(getListAiExecutiveSummariesQueryKey()) },
                )
              }
            >
              <Sparkles className="h-3.5 w-3.5" /> {genSummary.isPending ? "Generating…" : "Generate summary"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {summariesQuery.isLoading ? (
            <p className="text-sm text-muted-foreground py-4">Loading…</p>
          ) : !summariesQuery.data || summariesQuery.data.summaries.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No summaries yet — generate one to get started.</p>
          ) : (
            summariesQuery.data.summaries.map((s) => {
              const t = summaryText(s);
              return (
                <div key={s.id} className="rounded-lg border border-border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold">{t.headline}</span>
                        <Badge variant="outline" className="text-[10px] capitalize">{s.periodType}</Badge>
                        <Badge variant="outline" className={`text-[10px] ${s.source === "ai" ? "text-primary" : "text-muted-foreground"}`}>
                          {s.source === "ai" ? "AI" : "deterministic"}
                        </Badge>
                        <Badge variant="outline" className="text-[10px] capitalize">{s.status}</Badge>
                      </div>
                      {t.narrative && <p className="text-xs text-muted-foreground mt-1">{t.narrative}</p>}
                      {t.highlights.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {t.highlights.slice(0, 5).map((h, i) => (
                            <li key={i} className="text-xs flex items-start gap-2">
                              <div className="w-1 h-1 rounded-full bg-primary mt-1.5 shrink-0" /> {h}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {s.status === "suggested" && (
                      <div className="flex gap-1 shrink-0">
                        <Button
                          size="icon"
                          variant="outline"
                          className="h-7 w-7"
                          onClick={() => acceptSummary.mutate({ id: s.id }, { onSuccess: () => invalidate(getListAiExecutiveSummariesQueryKey()) })}
                        >
                          <Check className="h-3.5 w-3.5 text-emerald-600" />
                        </Button>
                        <Button
                          size="icon"
                          variant="outline"
                          className="h-7 w-7"
                          onClick={() => dismissSummary.mutate({ id: s.id }, { onSuccess: () => invalidate(getListAiExecutiveSummariesQueryKey()) })}
                        >
                          <X className="h-3.5 w-3.5 text-rose-600" />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* Reports */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" /> AI Reports
          </CardTitle>
          <div className="flex items-center gap-2">
            <Select value={reportType} onValueChange={setReportType}>
              <SelectTrigger className="w-[170px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="executive_summary">Executive summary</SelectItem>
                <SelectItem value="performance">Team performance</SelectItem>
                <SelectItem value="forecast">Forecast</SelectItem>
                <SelectItem value="full">Full report</SelectItem>
              </SelectContent>
            </Select>
            <Select value={reportPeriodType} onValueChange={setReportPeriodType}>
              <SelectTrigger className="w-[120px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="quarterly">Quarterly</SelectItem>
              </SelectContent>
            </Select>
            <Select value={reportFormat} onValueChange={setReportFormat}>
              <SelectTrigger className="w-[90px] h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pdf">PDF</SelectItem>
                <SelectItem value="xlsx">Excel</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              className="gap-1"
              disabled={genReport.isPending}
              onClick={() =>
                genReport.mutate(
                  { data: { reportType, periodType: reportPeriodType, format: reportFormat } },
                  { onSuccess: () => invalidate(getListAiExecutiveReportsQueryKey()) },
                )
              }
            >
              <FileText className="h-3.5 w-3.5" /> {genReport.isPending ? "Queuing…" : "Generate"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          {reportsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground py-4">Loading…</p>
          ) : !reportsQuery.data || reportsQuery.data.reports.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No reports yet — generate one above.</p>
          ) : (
            reportsQuery.data.reports.map((r: ExecutiveReport) => (
              <div key={r.id} className="flex items-center gap-3 py-3">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium capitalize">{r.reportType.replace(/_/g, " ")}</span>
                    {r.periodType && <Badge variant="outline" className="text-[10px] capitalize">{r.periodType}</Badge>}
                    <Badge variant="outline" className="text-[10px] uppercase">{r.format}</Badge>
                    <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full border ${STATUS_TONE[r.status] ?? STATUS_TONE.pending}`}>
                      {r.status}
                    </span>
                  </div>
                  {r.error && <p className="text-xs text-rose-600 mt-0.5">{r.error}</p>}
                </div>
                {r.status === "ready" && r.downloadUrl ? (
                  <Button size="sm" variant="outline" className="gap-1 shrink-0" onClick={() => triggerDownload(r.downloadUrl!)}>
                    <Download className="h-3.5 w-3.5" /> Download
                  </Button>
                ) : r.status === "failed" ? null : (
                  <RefreshCw className="h-3.5 w-3.5 text-muted-foreground animate-spin shrink-0" />
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
