import * as platformRepo from "../repositories/platform.repository.js";
import * as subsRepo from "../repositories/subscriptions.repository.js";
import { subscriptionMetrics, revenueSnapshot } from "./platform-billing.service.js";

// Batch 20 — truthful platform metrics. No simulated revenue, no random trends,
// no percentage-derived states. Revenue is reported only when it can be computed
// from verified provider prices and live provider subscriptions; otherwise the
// response says so explicitly ("available: false" + reason).

export async function getStats() {
  const [totalCompanies, totalUsers, totalScans, totalLeads, metrics, revenue] = await Promise.all([
    platformRepo.countCompanies(),
    platformRepo.countUsers(),
    platformRepo.countScans(),
    platformRepo.countLeads(),
    subscriptionMetrics(),
    revenueSnapshot(),
  ]);
  const byStatus = new Map(metrics.byStatus.map((s) => [s.status, s.count]));
  const activeCompanies = (byStatus.get("active") ?? 0) + (byStatus.get("trialing") ?? 0);
  return {
    totalCompanies,
    // Companies with FULL access today (active or trialing).
    activeCompanies,
    totalUsers,
    totalScans,
    totalLeads,
    revenue,
    subscriptions: metrics,
    // Compatibility fields (kept for existing clients): counts by canonical status.
    subscriptionDistribution: metrics.byStatus.map((s) => ({ status: s.status, count: s.count, label: s.status })),
  };
}

// Revenue history requires stored invoice/period data that this system does not
// hold; the trend is therefore reported as unavailable rather than simulated.
export async function getRevenueTrend() {
  return { available: false as const, reason: "NO_REVENUE_HISTORY", points: [] as Array<{ date: string; value: number }> };
}

// Real daily OCR scan counts for the last 30 days (synthetic manual interaction
// rows excluded).
export async function getScanTrend() {
  const points = await subsRepo.dailyScanCounts(30);
  return points.map((p) => ({ date: p.date, value: p.value, label: p.date }));
}

export async function getActivity() {
  const activity = await platformRepo.recentActivity(50);
  return activity;
}
