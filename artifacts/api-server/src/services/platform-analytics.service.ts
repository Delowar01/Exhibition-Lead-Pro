import { config } from "../config.js";
import * as repo from "../repositories/platform-analytics.repository.js";
import * as platformRepo from "../repositories/platform.repository.js";
import * as subsRepo from "../repositories/subscriptions.repository.js";
import * as aiRepo from "../repositories/ai.repository.js";
import { formatAgg } from "./ai.service.js";
import { subscriptionMetrics, revenueSnapshot, isLiveProviderSubscription, monthlyRecurringMinorOf } from "./platform-billing.service.js";
import { resolveWindow, describeWindow, fillBuckets, bucketStart, dayKey, type AnalyticsWindow } from "../lib/analytics-window.js";
import { createReadGate } from "../lib/read-gate.js";

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

// One analytics request fans out into many aggregate queries, several of them over tables
// that grow without bound. They run through a process-wide gate, at most two at a time, so
// reporting can never occupy the connection pool that tenant requests share — however many
// analytics requests are in flight. (A gated unit may itself issue a few queries, e.g. the
// subscription metrics; the bound on pooled connections stays small either way.)
const gate = createReadGate(2);
const g = <T>(task: () => Promise<T>): Promise<T> => gate.run(task);

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
    scanTrend,
    companyTrend,
  ] = await Promise.all([
    g(() => platformRepo.countCompanies()),
    g(() => repo.countUsers()),
    g(() => repo.countCompaniesCreated(current)),
    g(() => repo.countCompaniesCreated(previous)),
    g(() => repo.countUsersCreated(current)),
    g(() => repo.countUsersCreated(previous)),
    g(() => repo.countScans(current)),
    g(() => repo.countScans(previous)),
    g(() => repo.countContacts(current)),
    g(() => repo.countContacts(previous)),
    g(() => repo.countLeads(current)),
    g(() => repo.countLeads(previous)),
    g(() => repo.signInCounts(current)),
    g(() => repo.signInCounts(previous)),
    g(() => repo.activityByCompany(current)),
    g(() => repo.activityByCompany(previous)),
    g(() => aiRepo.usageTotals(undefined, aiC.from, aiC.to, true)),
    g(() => aiRepo.usageTotals(undefined, aiP.from, aiP.to, true)),
    g(() => subscriptionMetrics(now)),
    g(() => revenueSnapshot()),
    g(() => repo.scansSeries(current, w.granularity)),
    g(() => repo.companiesCreatedSeries(current, w.granularity)),
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
    // The two series the overview charts, so the landing view is one request.
    trends: {
      scans: fillBuckets(w, scanTrend, { value: 0 }),
      newCompanies: fillBuckets(w, companyTrend, { value: 0 }),
    },
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
    g(() => repo.countCompaniesCreatedBefore(w.start)),
    g(() => repo.countCompaniesCreated(current)),
    g(() => repo.countCompaniesCreated(previous)),
    g(() => repo.companiesCreatedSeries(current, w.granularity)),
    g(() => repo.countUsersCreatedBefore(w.start)),
    g(() => repo.countUsersCreated(current)),
    g(() => repo.countUsersCreated(previous)),
    g(() => repo.usersCreatedSeries(current, w.granularity)),
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
    g(() => subscriptionMetrics(now)),
    g(() => subsRepo.countSubscriptionsByPlanAndStatus()),
    g(() => subsRepo.listPlans(false)),
    g(() => repo.lifecycleTotals(current)),
    g(() => repo.lifecycleTotals(previous)),
    g(() => repo.lifecycleSeries(current, w.granularity)),
    g(() => repo.planMoves(current, 10)),
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
// The per-plan split of the estimate revenueSnapshot() reports: the same subscription filter
// and the same price normalization, grouped by plan, and produced only when the snapshot
// itself is available. Each plan is rounded to a whole minor unit, so the split can differ
// from the headline by less than one minor unit per plan; and because the two are separate
// reads, a subscription that changes between them can make them differ until the next request.
async function revenueByPlan(available: boolean) {
  if (!available) return [];
  const [stripeSubs, prices, plans] = await Promise.all([g(() => subsRepo.listStripeManaged(10_000)), g(() => subsRepo.listPlanPrices({})), g(() => subsRepo.listPlans(false))]);
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
    g(() => revenueSnapshot()),
    g(() => repo.providerEventCounts(current)),
    g(() => repo.providerEventCounts(previous)),
    g(() => repo.paymentEventSeries(current, w.granularity)),
    g(() => repo.providerEventsByType(current, 20)),
    g(() => repo.providerEventsByOutcome(current)),
    g(() => repo.checkoutCounts(current)),
    g(() => repo.checkoutCounts(previous)),
    g(() => repo.subscriptionsByBillingSource()),
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
  const [scans, prevScans, contacts, prevContacts, leads, prevLeads, sSeries, cSeries, lSeries, bySource, byStatus, captures, prevCaptures, byCompany, prevByCompany] = await Promise.all([
    g(() => repo.countScans(current)),
    g(() => repo.countScans(previous)),
    g(() => repo.countContacts(current)),
    g(() => repo.countContacts(previous)),
    g(() => repo.countLeads(current)),
    g(() => repo.countLeads(previous)),
    g(() => repo.scansSeries(current, w.granularity)),
    g(() => repo.contactsSeries(current, w.granularity)),
    g(() => repo.leadsSeries(current, w.granularity)),
    g(() => repo.capturesBySource(current)),
    g(() => repo.scansByStatus(current)),
    g(() => repo.countCaptures(current)),
    g(() => repo.countCaptures(previous)),
    g(() => repo.activityByCompany(current)),
    g(() => repo.activityByCompany(previous)),
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
  const names = await g(() => repo.companyNames(top.map(([id]) => id)));
  return {
    range: describeWindow(w),
    totals: {
      captures: pair(captures, prevCaptures),
      scans: pair(scans, prevScans),
      contacts: pair(contacts, prevContacts),
      leads: pair(leads, prevLeads),
      activeCompanies: pair(activeCompaniesIn(byCompany), activeCompaniesIn(prevByCompany)),
    },
    series,
    capturesBySource: bySource,
    scansByStatus: byStatus,
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
    g(() => aiRepo.usageTotals(undefined, c.from, c.to, true)),
    g(() => aiRepo.usageTotals(undefined, p.from, p.to, true)),
    g(() => aiRepo.usageByFeature(undefined, c.from, c.to, true)),
    g(() => aiRepo.usageByDay(undefined, c.from, c.to, true)),
    g(() => aiRepo.usageByCompany(c.from, c.to, undefined, 10, 0)),
    g(() => aiRepo.failureCategories(undefined, c.from, c.to, true)),
  ]);
  return {
    range: describeWindow(w),
    costBasis: "estimated" as const,
    totals: formatAgg(totals),
    previous: formatAgg(prev),
    series: bucketAi(w, byDay),
    byFeature: byFeature.map((f) => ({ feature: f.feature, ...formatAgg(f) })).sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests || a.feature.localeCompare(b.feature)),
    // The ledger query ranks by cost only; ties are ordered here so the list is stable.
    topCompanies: byCompany.items
      .map((x) => ({ companyId: x.companyId, companyName: x.companyName, ...formatAgg(x) }))
      .sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests || (a.companyId ?? 0) - (b.companyId ?? 0)),
    failureCategories: failures,
  };
}

// ── operations ───────────────────────────────────────────────────────────────
export async function getOperations(query: WindowQuery, now: Date = new Date()) {
  const w = resolveWindow(query, now);
  const { current, previous } = spans(w);
  const durable = config.jobs.driver === "postgres";
  const [signIns, prevSignIns, signInSeries, audit, prevAudit, auditCats, auditSeries, security, prevSecurity, securityTypes, billing, prevBilling, jobs] = await Promise.all([
    g(() => repo.signInCounts(current)),
    g(() => repo.signInCounts(previous)),
    g(() => repo.signInSeries(current, w.granularity)),
    g(() => repo.countAuditEvents(current)),
    g(() => repo.countAuditEvents(previous)),
    g(() => repo.auditByCategory(current, 12)),
    g(() => repo.auditSeries(current, w.granularity)),
    g(() => repo.countSecurityEvents(current)),
    g(() => repo.countSecurityEvents(previous)),
    g(() => repo.securityByType(current, 12)),
    g(() => repo.providerEventCounts(current)),
    g(() => repo.providerEventCounts(previous)),
    durable ? g(() => repo.jobQueueSnapshot()) : Promise.resolve({ pending: 0, running: 0, dead: 0 }),
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
