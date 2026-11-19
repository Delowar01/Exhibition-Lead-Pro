import { config } from "../config.js";
import * as repo from "../repositories/platform-analytics.repository.js";
import * as platformRepo from "../repositories/platform.repository.js";
import * as subsRepo from "../repositories/subscriptions.repository.js";
import * as aiRepo from "../repositories/ai.repository.js";
import { formatAgg } from "./ai.service.js";
import { subscriptionMetrics, revenueSnapshot, isLiveProviderSubscription, monthlyRecurringMinorOf } from "./platform-billing.service.js";
import { resolveWindow, describeWindow, fillBuckets, bucketStart, dayKey, type AnalyticsWindow } from "../lib/analytics-window.js";

// G-7 — Platform Owner Analytics.
//
// Every figure is computed from rows this system really holds, for the reporting window the
// caller asked for. Three rules keep the page truthful:
//   * a metric is either measured or reported as unavailable with a reason — never estimated
//     silently and never simulated;
//   * recurring revenue is an ESTIMATE (verified provider prices × active provider-managed
//     subscriptions) and is kept apart from ACTUAL payment notifications, whose amounts are
//     not stored and are therefore never shown as money;
//   * only aggregates leave this module — counts, sums, plan ids, company ids and names.

export type WindowQuery = { from?: unknown; to?: unknown; granularity?: unknown };

function spans(w: AnalyticsWindow) {
  return {
    current: { start: w.start, endExclusive: w.endExclusive },
    previous: { start: w.previousStart, endExclusive: w.previousEndExclusive },
  };
}
const pair = (current: number, previous: number) => ({ current, previous });

function activeCompaniesIn(byCompany: Map<number, { scans: number; contacts: number; leads: number }>): number {
  let c = 0;
  for (const v of byCompany.values()) if (v.scans > 0 || v.contacts > 0) c += 1;
  return c;
}

// The AI ledger's shared aggregates filter with an INCLUSIVE upper bound, while the window's
// end is exclusive, so the bound is the window's last millisecond. A JS Date cannot express
// the database's microseconds: a ledger row stamped in the final 999 µs of the window's last
// day falls between two windows (about one row in 86 million). That is preferred to an
// inclusive bound at the next midnight, which would count round-timestamp rows twice.
function aiBounds(s: repo.Span): { from: Date; to: Date } {
  return { from: s.start, to: new Date(s.endExclusive.getTime() - 1) };
}

// ── overview ─────────────────────────────────────────────────────────────────
export async function getOverview(query: WindowQuery, now: Date = new Date()) {
  const w = resolveWindow(query, now);
  const { current, previous } = spans(w);
  const aiC = aiBounds(current);
  const aiP = aiBounds(previous);
  const [
    totalCompanies,
    totalUsers,
    newCompanies,
    prevCompanies,
    newUsers,
    prevUsers,
    scans,
    prevScans,
    contacts,
    prevContacts,
    leads,
    prevLeads,
    signIns,
    prevSignIns,
    byCompany,
    prevByCompany,
    ai,
    prevAi,
    metrics,
    revenue,
  ] = await Promise.all([
    platformRepo.countCompanies(),
    platformRepo.countUsers(),
    repo.countCompaniesCreated(current),
    repo.countCompaniesCreated(previous),
    repo.countUsersCreated(current),
    repo.countUsersCreated(previous),
    repo.countScans(current),
    repo.countScans(previous),
    repo.countContacts(current),
    repo.countContacts(previous),
    repo.countLeads(current),
    repo.countLeads(previous),
    repo.signInCounts(current),
    repo.signInCounts(previous),
    repo.activityByCompany(current),
    repo.activityByCompany(previous),
    aiRepo.usageTotals(undefined, aiC.from, aiC.to, true),
    aiRepo.usageTotals(undefined, aiP.from, aiP.to, true),
    subscriptionMetrics(now),
    revenueSnapshot(),
  ]);
  const statusCount = new Map(metrics.byStatus.map((s) => [s.status, s.count]));
  const total = metrics.byStatus.reduce((a, s) => a + s.count, 0);
  const aiNow = formatAgg(ai);
  const aiPrev = formatAgg(prevAi);
  return {
    range: describeWindow(w),
    generatedAt: now.toISOString(),
    totals: { companies: totalCompanies, users: totalUsers },
    period: {
      newCompanies: pair(newCompanies, prevCompanies),
      newUsers: pair(newUsers, prevUsers),
      activeCompanies: pair(activeCompaniesIn(byCompany), activeCompaniesIn(prevByCompany)),
      activeUsers: pair(signIns.activeUsers, prevSignIns.activeUsers),
      scans: pair(scans, prevScans),
      contacts: pair(contacts, prevContacts),
      leads: pair(leads, prevLeads),
      aiRequests: pair(aiNow.requests, aiPrev.requests),
    },
    subscriptions: {
      total,
      fullAccess: (statusCount.get("active") ?? 0) + (statusCount.get("trialing") ?? 0),
      byStatus: metrics.byStatus,
      trialsExpiringWithin7Days: metrics.trialsExpiringWithin7Days,
    },
    revenue,
    ai: { costUsd: pair(aiNow.costUsd, aiPrev.costUsd) },
  };
}

// ── growth ───────────────────────────────────────────────────────────────────
function growthSeries(w: AnalyticsWindow, startingTotal: number, added: number, previousAdded: number, rows: Array<{ bucket: string; value: number }>) {
  let running = startingTotal;
  const series = fillBuckets(w, rows, { value: 0 }).map((p) => {
    running += p.value;
    return { bucket: p.bucket, added: p.value, cumulative: running };
  });
  return { startingTotal, endingTotal: startingTotal + added, added: pair(added, previousAdded), series };
}

export async function getGrowth(query: WindowQuery, now: Date = new Date()) {
  const w = resolveWindow(query, now);
  const { current, previous } = spans(w);
  const [cBefore, cAdded, cPrev, cSeries, uBefore, uAdded, uPrev, uSeries] = await Promise.all([
    repo.countCompaniesCreatedBefore(w.start),
    repo.countCompaniesCreated(current),
    repo.countCompaniesCreated(previous),
    repo.companiesCreatedSeries(current, w.granularity),
    repo.countUsersCreatedBefore(w.start),
    repo.countUsersCreated(current),
    repo.countUsersCreated(previous),
    repo.usersCreatedSeries(current, w.granularity),
  ]);
  return {
    range: describeWindow(w),
    companies: growthSeries(w, cBefore, cAdded, cPrev, cSeries),
    users: growthSeries(w, uBefore, uAdded, uPrev, uSeries),
  };
}

// ── subscriptions ────────────────────────────────────────────────────────────
export async function getSubscriptions(query: WindowQuery, now: Date = new Date()) {
  const w = resolveWindow(query, now);
  const { current, previous } = spans(w);
  const [metrics, byPlanStatus, plans, totals, previousTotals, series, moves] = await Promise.all([
    subscriptionMetrics(now),
    subsRepo.countSubscriptionsByPlanAndStatus(),
    subsRepo.listPlans(false),
    repo.lifecycleTotals(current),
    repo.lifecycleTotals(previous),
    repo.lifecycleSeries(current, w.granularity),
    repo.planMoves(current, 10),
  ]);
  const planById = new Map(plans.map((p) => [p.id, p]));
  const grouped = new Map<string, Array<{ status: string; count: number }>>();
  for (const r of byPlanStatus) {
    const list = grouped.get(r.plan) ?? [];
    list.push({ status: r.status, count: r.count });
    grouped.set(r.plan, list);
  }
  const byPlan = [...grouped.entries()]
    .map(([planId, byStatus]) => {
      const plan = planById.get(planId);
      return {
        planId,
        planName: plan?.name ?? null,
        planStatus: plan?.status ?? null,
        total: byStatus.reduce((a, s) => a + s.count, 0),
        byStatus: byStatus.sort((a, b) => a.status.localeCompare(b.status)),
      };
    })
    .sort((a, b) => b.total - a.total || a.planId.localeCompare(b.planId));
  const statusCount = new Map(metrics.byStatus.map((s) => [s.status, s.count]));
  return {
    range: describeWindow(w),
    snapshot: {
      total: metrics.byStatus.reduce((a, s) => a + s.count, 0),
      fullAccess: (statusCount.get("active") ?? 0) + (statusCount.get("trialing") ?? 0),
      byStatus: metrics.byStatus,
      byPlan,
      byBillingSource: metrics.byBillingSource,
      trialsExpiringWithin7Days: metrics.trialsExpiringWithin7Days,
    },
    lifecycle: {
      source: "audit_log" as const,
      totals,
      previousTotals,
      series: fillBuckets(w, series, repo.ZERO_LIFECYCLE),
      planMoves: moves,
    },
  };
}

// ── revenue and billing ──────────────────────────────────────────────────────
// The per-plan split of the SAME estimate revenueSnapshot() reports: identical
// subscription filter and identical price normalization, grouped by plan. It is produced
// only when the snapshot itself is available, so the two can never disagree.
async function revenueByPlan(available: boolean) {
  if (!available) return [];
  const [stripeSubs, prices, plans] = await Promise.all([subsRepo.listStripeManaged(10_000), subsRepo.listPlanPrices({}), subsRepo.listPlans(false)]);
  const byProviderPrice = new Map(prices.map((p) => [p.providerPriceId, p]));
  const planName = new Map(plans.map((p) => [p.id, p.name]));
  const acc = new Map<string, { subscriptions: number; monthly: number }>();
  for (const s of stripeSubs.filter(isLiveProviderSubscription)) {
    const price = s.stripePriceId ? byProviderPrice.get(s.stripePriceId) : undefined;
    if (!price) continue;
    const row = acc.get(s.plan) ?? { subscriptions: 0, monthly: 0 };
    row.subscriptions += 1;
    row.monthly += monthlyRecurringMinorOf(price);
    acc.set(s.plan, row);
  }
  return [...acc.entries()]
    .map(([planId, v]) => ({ planId, planName: planName.get(planId) ?? null, subscriptions: v.subscriptions, monthlyRecurringMinor: Math.round(v.monthly) }))
    .sort((a, b) => b.monthlyRecurringMinor - a.monthlyRecurringMinor || a.planId.localeCompare(b.planId));
}

export async function getRevenue(query: WindowQuery, now: Date = new Date()) {
  const w = resolveWindow(query, now);
  const { current, previous } = spans(w);
  const [snapshot, events, prevEvents, paymentSeries, byType, byOutcome, checkouts, prevCheckouts, billingSources] = await Promise.all([
    revenueSnapshot(),
    repo.providerEventCounts(current),
    repo.providerEventCounts(previous),
    repo.paymentEventSeries(current, w.granularity),
    repo.providerEventsByType(current, 20),
    repo.providerEventsByOutcome(current),
    repo.checkoutCounts(current),
    repo.checkoutCounts(previous),
    repo.subscriptionsByBillingSource(),
  ]);
  return {
    range: describeWindow(w),
    estimate: {
      basis: "verified_provider_prices" as const,
      snapshot,
      byPlan: await revenueByPlan(snapshot.available),
    },
    // No invoice or payment amount is stored anywhere in this system.
    collected: { available: false, reason: "PAYMENT_AMOUNTS_NOT_RECORDED" },
    paymentEvents: {
      paid: pair(events.paid, prevEvents.paid),
      failed: pair(events.paymentFailed, prevEvents.paymentFailed),
      series: fillBuckets(w, paymentSeries, { paid: 0, failed: 0 }),
    },
    checkouts: {
      started: pair(checkouts.started, prevCheckouts.started),
      completed: checkouts.completed,
      expired: checkouts.expired,
      failed: checkouts.failed,
      open: checkouts.open,
    },
    providerEvents: {
      total: pair(events.total, prevEvents.total),
      failed: events.failed,
      byType,
      byOutcome,
    },
    billingSources,
  };
}

// ── capture activity ─────────────────────────────────────────────────────────
export async function getActivity(query: WindowQuery, now: Date = new Date()) {
  const w = resolveWindow(query, now);
  const { current, previous } = spans(w);
  const [scans, prevScans, contacts, prevContacts, leads, prevLeads, sSeries, cSeries, lSeries, byMethod, byStatus, manualEntries, byCompany, prevByCompany] = await Promise.all([
    repo.countScans(current),
    repo.countScans(previous),
    repo.countContacts(current),
    repo.countContacts(previous),
    repo.countLeads(current),
    repo.countLeads(previous),
    repo.scansSeries(current, w.granularity),
    repo.contactsSeries(current, w.granularity),
    repo.leadsSeries(current, w.granularity),
    repo.scansByMethod(current),
    repo.scansByStatus(current),
    repo.countManualEntries(current),
    repo.activityByCompany(current),
    repo.activityByCompany(previous),
  ]);
  const merged = new Map<string, { scans: number; contacts: number; leads: number }>();
  const at = (bucket: string) => {
    let v = merged.get(bucket);
    if (!v) {
      v = { scans: 0, contacts: 0, leads: 0 };
      merged.set(bucket, v);
    }
    return v;
  };
  for (const p of sSeries) at(p.bucket).scans = p.value;
  for (const p of cSeries) at(p.bucket).contacts = p.value;
  for (const p of lSeries) at(p.bucket).leads = p.value;
  const series = fillBuckets(
    w,
    [...merged.entries()].map(([bucket, v]) => ({ bucket, ...v })),
    { scans: 0, contacts: 0, leads: 0 },
  );

  const top = [...byCompany.entries()]
    .sort((a, b) => b[1].scans + b[1].contacts - (a[1].scans + a[1].contacts) || b[1].leads - a[1].leads || a[0] - b[0])
    .slice(0, 10);
  const names = await repo.companyNames(top.map(([id]) => id));
  return {
    range: describeWindow(w),
    totals: {
      scans: pair(scans, prevScans),
      contacts: pair(contacts, prevContacts),
      leads: pair(leads, prevLeads),
      activeCompanies: pair(activeCompaniesIn(byCompany), activeCompaniesIn(prevByCompany)),
    },
    series,
    scansByMethod: byMethod,
    scansByStatus: byStatus,
    manualEntries,
    topCompanies: top.map(([companyId, v]) => ({ companyId, companyName: names.get(companyId) ?? `Company ${companyId}`, ...v })),
  };
}

// ── AI usage ─────────────────────────────────────────────────────────────────
type RawAgg = aiRepo.RawAgg;
const ZERO_AGG: RawAgg = { requests: 0, success: 0, errors: 0, cacheHits: 0, dedupReused: 0, budgetDenied: 0, rateLimited: 0, estimatedRows: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicroUsd: 0, avgLatencyMs: 0 };

// Folds the ledger's UTC-day rows into the window's buckets. Latency is re-weighted by the
// number of provider calls so a weekly or monthly bucket reports a true average.
function bucketAi(w: AnalyticsWindow, days: Array<RawAgg & { day: string }>) {
  const acc = new Map<string, RawAgg & { latencyWeight: number }>();
  for (const d of days) {
    const key = dayKey(bucketStart(new Date(`${d.day}T00:00:00.000Z`), w.granularity));
    const a = acc.get(key) ?? { ...ZERO_AGG, latencyWeight: 0 };
    a.requests += d.requests;
    a.success += d.success;
    a.errors += d.errors;
    a.cacheHits += d.cacheHits;
    a.dedupReused += d.dedupReused;
    a.budgetDenied += d.budgetDenied;
    a.rateLimited += d.rateLimited;
    a.estimatedRows += d.estimatedRows;
    a.inputTokens += d.inputTokens;
    a.outputTokens += d.outputTokens;
    a.totalTokens += d.totalTokens;
    a.costMicroUsd += d.costMicroUsd;
    a.latencyWeight += d.avgLatencyMs * d.requests;
    acc.set(key, a);
  }
  const rows = [...acc.entries()].map(([bucket, a]) => {
    const { latencyWeight, ...agg } = a;
    return { bucket, ...formatAgg({ ...agg, avgLatencyMs: a.requests > 0 ? Math.round(latencyWeight / a.requests) : 0 }) };
  });
  return fillBuckets(w, rows, formatAgg(ZERO_AGG));
}

export async function getAi(query: WindowQuery, now: Date = new Date()) {
  const w = resolveWindow(query, now);
  const { current, previous } = spans(w);
  const c = aiBounds(current);
  const p = aiBounds(previous);
  const [totals, prev, byFeature, byDay, byCompany, failures] = await Promise.all([
    aiRepo.usageTotals(undefined, c.from, c.to, true),
    aiRepo.usageTotals(undefined, p.from, p.to, true),
    aiRepo.usageByFeature(undefined, c.from, c.to, true),
    aiRepo.usageByDay(undefined, c.from, c.to, true),
    aiRepo.usageByCompany(c.from, c.to, undefined, 10, 0),
    aiRepo.failureCategories(undefined, c.from, c.to, true),
  ]);
  return {
    range: describeWindow(w),
    costBasis: "estimated" as const,
    totals: formatAgg(totals),
    previous: formatAgg(prev),
    series: bucketAi(w, byDay),
    byFeature: byFeature.map((f) => ({ feature: f.feature, ...formatAgg(f) })).sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests || a.feature.localeCompare(b.feature)),
    topCompanies: byCompany.items.map((x) => ({ companyId: x.companyId, companyName: x.companyName, ...formatAgg(x) })),
    failureCategories: failures,
  };
}

// ── operations ───────────────────────────────────────────────────────────────
export async function getOperations(query: WindowQuery, now: Date = new Date()) {
  const w = resolveWindow(query, now);
  const { current, previous } = spans(w);
  const durable = config.jobs.driver === "postgres";
  const [signIns, prevSignIns, signInSeries, audit, prevAudit, auditCats, auditSeries, security, prevSecurity, securityTypes, billing, prevBilling, jobs] = await Promise.all([
    repo.signInCounts(current),
    repo.signInCounts(previous),
    repo.signInSeries(current, w.granularity),
    repo.countAuditEvents(current),
    repo.countAuditEvents(previous),
    repo.auditByCategory(current, 12),
    repo.auditSeries(current, w.granularity),
    repo.countSecurityEvents(current),
    repo.countSecurityEvents(previous),
    repo.securityByType(current, 12),
    repo.providerEventCounts(current),
    repo.providerEventCounts(previous),
    durable ? repo.jobQueueSnapshot() : Promise.resolve({ pending: 0, running: 0, dead: 0 }),
  ]);
  return {
    range: describeWindow(w),
    signIns: {
      successful: pair(signIns.successful, prevSignIns.successful),
      failed: pair(signIns.failed, prevSignIns.failed),
      activeUsers: pair(signIns.activeUsers, prevSignIns.activeUsers),
      series: fillBuckets(w, signInSeries, { successful: 0, failed: 0 }),
    },
    auditEvents: {
      total: pair(audit, prevAudit),
      byCategory: auditCats,
      series: fillBuckets(w, auditSeries, { value: 0 }),
    },
    securityEvents: { total: pair(security, prevSecurity), byType: securityTypes },
    billingEvents: { received: pair(billing.total, prevBilling.total), failed: pair(billing.failed, prevBilling.failed) },
    jobs: { durable, ...jobs },
  };
}
