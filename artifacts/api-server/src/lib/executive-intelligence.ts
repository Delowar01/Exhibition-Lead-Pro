// Stage 5C — Executive Intelligence deterministic core.
//
// Pure, dependency-free computation of executive-grade intelligence from already-fetched,
// tenant-scoped CRM aggregates. NO database access and NO LLM calls happen here — the
// service layer fetches real rows (via the analytics repository) and passes plain numbers
// in. Every function is deterministic and transparent: the same inputs always yield the
// same output, and each score/forecast documents exactly which factors drive it.
//
// SAFETY: nothing here fabricates data. When inputs are too sparse to judge, functions
// return honest low confidence and "insufficient" signals rather than inventing a result.
// These grounded cores are confidence-100 as COMPUTATIONS (they are exact); forecasts
// additionally carry their own data-driven confidence reflecting how well the history
// supports the projection.

// ---------------------------------------------------------------------------
// Health scores (0-100). Each is a transparent weighted blend of normalized,
// real signals. Factors are returned alongside the score so the UI/report can
// explain WHY — never a black box.
// ---------------------------------------------------------------------------

export interface HealthFactor {
  key: string;
  label: string;
  value: number; // normalized 0-100 contribution input
  weight: number; // 0-1
}

export interface HealthScore {
  score: number; // 0-100
  rating: "excellent" | "good" | "fair" | "at_risk";
  factors: HealthFactor[];
}

function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

function ratingFor(score: number): HealthScore["rating"] {
  if (score >= 80) return "excellent";
  if (score >= 60) return "good";
  if (score >= 40) return "fair";
  return "at_risk";
}

function blend(factors: HealthFactor[]): HealthScore {
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0) || 1;
  const score = Math.round(clamp(factors.reduce((s, f) => s + clamp(f.value) * f.weight, 0) / totalWeight));
  return { score, rating: ratingFor(score), factors };
}

export interface SalesHealthInput {
  conversionRate: number; // 0-100 (won / decided)
  wonCount: number;
  lostCount: number;
  newLeads: number;
  newLeadsPrev: number;
  followUpAdherence: number; // 0-100
}

// Sales health = how effectively leads are being won + kept moving. Blends
// conversion rate, win share, lead-generation momentum, and follow-up discipline.
export function computeSalesHealth(i: SalesHealthInput): HealthScore {
  const decided = i.wonCount + i.lostCount;
  const winShare = decided === 0 ? 50 : (i.wonCount / decided) * 100; // neutral 50 when nothing decided
  // Momentum: growth in new leads vs previous period, mapped so flat = 50, +100% => 100.
  const momentum =
    i.newLeadsPrev === 0 ? (i.newLeads > 0 ? 65 : 50) : clamp(50 + ((i.newLeads - i.newLeadsPrev) / i.newLeadsPrev) * 50);
  return blend([
    { key: "conversion", label: "Conversion rate", value: clamp(i.conversionRate), weight: 0.35 },
    { key: "win_share", label: "Win share", value: clamp(winShare), weight: 0.25 },
    { key: "momentum", label: "Lead momentum", value: momentum, weight: 0.2 },
    { key: "follow_up", label: "Follow-up adherence", value: clamp(i.followUpAdherence), weight: 0.2 },
  ]);
}

export interface PipelineHealthInput {
  openPipelineValue: number;
  wonValue: number;
  stageCounts: Record<string, number>; // stage -> count (open stages)
  followUpsOverdue: number;
  followUpsScheduled: number;
  agingRatio?: number; // 0-1 share of open leads considered stale (optional)
}

// Pipeline health = coverage + balance + hygiene. Coverage compares open pipeline
// to recent won value; balance rewards leads distributed across stages (not all
// stuck early); hygiene penalizes overdue follow-ups and aging.
export function computePipelineHealth(i: PipelineHealthInput): HealthScore {
  const coverage = i.wonValue <= 0 ? (i.openPipelineValue > 0 ? 70 : 40) : clamp((i.openPipelineValue / i.wonValue) * 33);
  const stages = Object.values(i.stageCounts);
  const totalOpen = stages.reduce((s, n) => s + n, 0);
  // Balance via normalized entropy across non-empty stages (spread => healthier).
  let balance = 50;
  if (totalOpen > 0 && stages.length > 1) {
    const probs = stages.map((n) => n / totalOpen).filter((p) => p > 0);
    const entropy = -probs.reduce((s, p) => s + p * Math.log(p), 0);
    balance = clamp((entropy / Math.log(stages.length)) * 100);
  }
  const hygiene = i.followUpsScheduled === 0 ? 80 : clamp(100 - (i.followUpsOverdue / i.followUpsScheduled) * 100);
  const freshness = i.agingRatio == null ? 60 : clamp(100 - i.agingRatio * 100);
  return blend([
    { key: "coverage", label: "Pipeline coverage", value: coverage, weight: 0.3 },
    { key: "balance", label: "Stage balance", value: balance, weight: 0.25 },
    { key: "hygiene", label: "Follow-up hygiene", value: hygiene, weight: 0.25 },
    { key: "freshness", label: "Pipeline freshness", value: freshness, weight: 0.2 },
  ]);
}

// Overall business health = weighted blend of sales + pipeline health plus growth.
export function computeBusinessHealth(
  sales: HealthScore,
  pipeline: HealthScore,
  growthPct: number | null,
): HealthScore {
  const growth = growthPct == null ? 55 : clamp(50 + growthPct / 2); // +100% growth => 100
  return blend([
    { key: "sales", label: "Sales health", value: sales.score, weight: 0.4 },
    { key: "pipeline", label: "Pipeline health", value: pipeline.score, weight: 0.4 },
    { key: "growth", label: "Growth", value: growth, weight: 0.2 },
  ]);
}

// ---------------------------------------------------------------------------
// Trend analysis. Classify a real numeric series (daily/weekly/monthly/…) into
// a direction with a transparent slope + percentage change, and a simple,
// honest seasonality signal. No smoothing that would hide the real data.
// ---------------------------------------------------------------------------

export type TrendDirection = "growth" | "decline" | "flat";

export interface TrendAnalysis {
  direction: TrendDirection;
  changePct: number | null; // first vs last non-trivial change; null when no baseline
  slope: number; // least-squares slope (units per step)
  mean: number;
  seasonality: boolean;
  points: number;
}

function linearRegression(values: number[]): { slope: number; intercept: number; r2: number } {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, r2: 0 };
  const xs = values.map((_, i) => i);
  const meanX = xs.reduce((s, x) => s + x, 0) / n;
  const meanY = values.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - meanX) * (values[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
    syy += (values[i] - meanY) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}

export function analyzeTrend(values: number[]): TrendAnalysis {
  const points = values.length;
  const mean = points === 0 ? 0 : values.reduce((s, v) => s + v, 0) / points;
  const { slope } = linearRegression(values);
  const first = values[0] ?? 0;
  const last = values[points - 1] ?? 0;
  const changePct = first === 0 ? null : Math.round(((last - first) / first) * 1000) / 10;
  // Direction from slope relative to mean magnitude (avoid calling tiny drift a trend).
  const rel = mean === 0 ? 0 : slope / mean;
  let direction: TrendDirection = "flat";
  if (rel > 0.05) direction = "growth";
  else if (rel < -0.05) direction = "decline";
  // Seasonality (honest, coarse): high variability around the trendline with sign
  // changes in successive deltas. Only flagged with enough points.
  let seasonality = false;
  if (points >= 6 && mean > 0) {
    const cv = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / points) / mean;
    let signChanges = 0;
    for (let i = 2; i < points; i++) {
      const d1 = values[i - 1] - values[i - 2];
      const d2 = values[i] - values[i - 1];
      if (d1 !== 0 && d2 !== 0 && Math.sign(d1) !== Math.sign(d2)) signChanges++;
    }
    seasonality = cv > 0.35 && signChanges >= Math.floor((points - 2) / 2);
  }
  return { direction, changePct, slope: Math.round(slope * 100) / 100, mean: Math.round(mean * 100) / 100, seasonality, points };
}

// ---------------------------------------------------------------------------
// Forecast core. Transparent, deterministic projection of a real historical
// series via moving average and linear trend, blended. Confidence reflects how
// well the history supports the projection (length + fit + stability) — it is
// NEVER a fabricated certainty.
// ---------------------------------------------------------------------------

export interface ForecastResult {
  expected: number;
  low: number;
  high: number;
  method: "linear_trend" | "moving_average" | "insufficient";
  confidence: number; // 0-100
  assumptions: string[];
  historyPoints: number;
}

// Project the NEXT period's value from a historical series (chronological order).
export function forecastNextPeriod(history: number[]): ForecastResult {
  const n = history.length;
  if (n === 0) {
    return { expected: 0, low: 0, high: 0, method: "insufficient", confidence: 0, assumptions: ["No historical data"], historyPoints: 0 };
  }
  if (n < 3) {
    const avg = history.reduce((s, v) => s + v, 0) / n;
    return {
      expected: Math.round(avg),
      low: Math.round(avg * 0.6),
      high: Math.round(avg * 1.4),
      method: "moving_average",
      confidence: 20,
      assumptions: ["Fewer than 3 periods of history — low confidence, average-based estimate"],
      historyPoints: n,
    };
  }
  const { slope, intercept, r2 } = linearRegression(history);
  const window = history.slice(-Math.min(3, n));
  const movingAvg = window.reduce((s, v) => s + v, 0) / window.length;
  const linearNext = slope * n + intercept;
  // Blend: weight linear trend by fit quality (r2), otherwise fall back to moving avg.
  const wLinear = clamp(r2 * 100) / 100;
  const expectedRaw = Math.max(0, wLinear * linearNext + (1 - wLinear) * movingAvg);
  const mean = history.reduce((s, v) => s + v, 0) / n;
  const std = Math.sqrt(history.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const cv = mean === 0 ? 1 : std / mean;
  // Confidence: more history + better fit + lower variability => higher.
  const lengthScore = clamp((Math.min(n, 12) / 12) * 100);
  const fitScore = clamp(r2 * 100);
  const stabilityScore = clamp(100 - cv * 60);
  const confidence = Math.round(clamp(lengthScore * 0.4 + fitScore * 0.3 + stabilityScore * 0.3));
  const band = std + expectedRaw * 0.15; // uncertainty band from real variability
  return {
    expected: Math.round(expectedRaw),
    low: Math.round(Math.max(0, expectedRaw - band)),
    high: Math.round(expectedRaw + band),
    method: wLinear >= 0.5 ? "linear_trend" : "moving_average",
    confidence,
    assumptions: [
      `Based on ${n} periods of real history`,
      wLinear >= 0.5 ? `Linear trend (fit R²=${Math.round(r2 * 100) / 100})` : "Recent moving average (weak linear fit)",
      `Historical variability CV=${Math.round(cv * 100) / 100}`,
    ],
    historyPoints: n,
  };
}

// ---------------------------------------------------------------------------
// Team & individual performance (deterministic, fairness-aware). Every member
// is scored on the SAME normalized dimensions and the explanation lists their
// factors — we never rank on a single opaque number, and low-volume members are
// flagged (small-sample) rather than punished.
// ---------------------------------------------------------------------------

export interface MemberMetrics {
  userId: number;
  name: string;
  scans: number;
  leads: number;
  won: number;
  pipelineValue: number;
  overdue: number;
  scheduled: number;
}

export interface MemberPerformance extends MemberMetrics {
  activityScore: number; // 0-100 normalized within the cohort
  conversionScore: number; // 0-100 (won / leads)
  hygieneScore: number; // 0-100 (follow-up adherence)
  overall: number; // 0-100 balanced blend
  smallSample: boolean; // fewer than a meaningful number of leads — interpret with care
  explanation: string;
}

// Normalize a value against the cohort max (0-100). Empty/zero cohort => 0.
function normalize(value: number, max: number): number {
  return max <= 0 ? 0 : clamp((value / max) * 100);
}

export function computeTeamPerformance(members: MemberMetrics[]): MemberPerformance[] {
  const maxActivity = Math.max(0, ...members.map((m) => m.scans + m.leads));
  return members
    .map((m) => {
      const activityScore = normalize(m.scans + m.leads, maxActivity);
      const conversionScore = m.leads === 0 ? 0 : clamp((m.won / m.leads) * 100);
      const hygieneScore = m.scheduled === 0 ? 100 : clamp(100 - (m.overdue / m.scheduled) * 100);
      const overall = Math.round(activityScore * 0.4 + conversionScore * 0.4 + hygieneScore * 0.2);
      const smallSample = m.leads < 5;
      const explanation = smallSample
        ? `Limited sample (${m.leads} leads): activity ${Math.round(activityScore)}, conversion ${Math.round(conversionScore)}%, follow-up ${Math.round(hygieneScore)}% — interpret with care.`
        : `Activity ${Math.round(activityScore)}/100, conversion ${Math.round(conversionScore)}%, follow-up adherence ${Math.round(hygieneScore)}%.`;
      return { ...m, activityScore: Math.round(activityScore), conversionScore: Math.round(conversionScore), hygieneScore: Math.round(hygieneScore), overall, smallSample, explanation };
    })
    .sort((a, b) => b.overall - a.overall);
}

// ---------------------------------------------------------------------------
// Executive alerts (deterministic, advisory). Each rule fires ONLY from real
// numbers and emits a severity, a plain-language message, and a grounded
// recommendation. Never auto-executed.
// ---------------------------------------------------------------------------

export type AlertType =
  | "pipeline_slowing"
  | "conversion_dropping"
  | "sla_risk"
  | "team_overload"
  | "event_underperforming"
  | "revenue_below_target"
  | "high_value_opportunity";

export interface ExecAlert {
  alertType: AlertType;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  recommendation: string;
  metric: number | null;
  confidence: number;
}

export interface AlertSignals {
  newLeads: number;
  newLeadsPrev: number;
  conversionRate: number;
  conversionRatePrev: number;
  followUpsOverdue: number;
  followUpsScheduled: number;
  openPipelineValue: number;
  wonValue: number;
  wonValuePrev: number;
  highValueOpenCount: number; // open leads above a value threshold with no recent activity
  topEventUnderperformingName?: string | null;
}

export function computeAlerts(s: AlertSignals): ExecAlert[] {
  const alerts: ExecAlert[] = [];

  if (s.newLeadsPrev > 0) {
    const drop = ((s.newLeadsPrev - s.newLeads) / s.newLeadsPrev) * 100;
    if (drop >= 25) {
      alerts.push({
        alertType: "pipeline_slowing",
        severity: drop >= 50 ? "critical" : "warning",
        title: "Pipeline intake slowing",
        detail: `New leads fell ${Math.round(drop)}% versus the previous period (${s.newLeads} vs ${s.newLeadsPrev}).`,
        recommendation: "Review lead sources and event activity; consider re-engaging dormant contacts.",
        metric: Math.round(drop),
        confidence: 100,
      });
    }
  }

  if (s.conversionRatePrev > 0) {
    const delta = s.conversionRatePrev - s.conversionRate;
    if (delta >= 10) {
      alerts.push({
        alertType: "conversion_dropping",
        severity: delta >= 20 ? "critical" : "warning",
        title: "Conversion rate dropping",
        detail: `Conversion rate is down ${Math.round(delta)} points (${Math.round(s.conversionRate)}% vs ${Math.round(s.conversionRatePrev)}%).`,
        recommendation: "Coach reps on late-stage deals and review qualification criteria.",
        metric: Math.round(delta),
        confidence: 100,
      });
    }
  }

  if (s.followUpsScheduled > 0) {
    const overduePct = (s.followUpsOverdue / s.followUpsScheduled) * 100;
    if (overduePct >= 20) {
      alerts.push({
        alertType: "sla_risk",
        severity: overduePct >= 40 ? "critical" : "warning",
        title: "Follow-up SLA risk rising",
        detail: `${s.followUpsOverdue} of ${s.followUpsScheduled} scheduled follow-ups are overdue (${Math.round(overduePct)}%).`,
        recommendation: "Prioritise overdue follow-ups today and rebalance workload where needed.",
        metric: Math.round(overduePct),
        confidence: 100,
      });
    }
  }

  if (s.wonValuePrev > 0) {
    const revDrop = ((s.wonValuePrev - s.wonValue) / s.wonValuePrev) * 100;
    if (revDrop >= 20) {
      alerts.push({
        alertType: "revenue_below_target",
        severity: revDrop >= 40 ? "critical" : "warning",
        title: "Revenue below prior period",
        detail: `Won value is down ${Math.round(revDrop)}% versus the previous period.`,
        recommendation: "Focus on high-probability late-stage deals and accelerate proposals in negotiation.",
        metric: Math.round(revDrop),
        confidence: 100,
      });
    }
  }

  if (s.highValueOpenCount > 0) {
    alerts.push({
      alertType: "high_value_opportunity",
      severity: "info",
      title: "High-value opportunities need attention",
      detail: `${s.highValueOpenCount} high-value open lead(s) have had no recent activity.`,
      recommendation: "Assign a senior rep and schedule an executive touchpoint this week.",
      metric: s.highValueOpenCount,
      confidence: 100,
    });
  }

  if (s.topEventUnderperformingName) {
    alerts.push({
      alertType: "event_underperforming",
      severity: "info",
      title: "Event underperforming",
      detail: `"${s.topEventUnderperformingName}" is converting below the tenant average.`,
      recommendation: "Review lead quality and follow-up cadence for this event's captures.",
      metric: null,
      confidence: 100,
    });
  }

  return alerts;
}
