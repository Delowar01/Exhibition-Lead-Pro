import { useGetPlatformAnalyticsRevenue, getGetPlatformAnalyticsRevenueQueryKey } from "@workspace/api-client-react";
import { BellRing, CalendarRange, CircleDollarSign, CircleSlash, CreditCard, Receipt, ShoppingCart, TriangleAlert } from "lucide-react";
import { BreakdownList, ChartCard, DataTable, EmptyState, StatusBadge, TrendChart } from "@/components/ds";
import {
  BILLING_SOURCE_LABEL,
  REVENUE_REASON,
  SERIES,
  formatCount,
  formatMinor,
  formatPercent,
  humanize,
  plural,
  revenueEstimateView,
} from "@/lib/platform-analytics";
import {
  EmptyNote,
  Kpi,
  KpiGrid,
  Note,
  PageLink,
  QueryBoundary,
  SectionHeading,
  SectionSkeleton,
  Stat,
  Unavailable,
  bucketColumnLabel,
  bucketFormatters,
  sectionQuery,
  type SectionProps,
} from "./shared";

// Revenue & billing — three things that must never be confused:
//   1. an ESTIMATE of recurring revenue (verified provider prices × live provider subscriptions),
//   2. COLLECTED revenue, which this system cannot report (no payment amounts are stored),
//   3. ACTUAL billing events received from the provider, as counts only.
export function RevenueSection({ params }: SectionProps) {
  const query = useGetPlatformAnalyticsRevenue(params, { query: sectionQuery(getGetPlatformAnalyticsRevenueQueryKey(params)) });
  return (
    <QueryBoundary query={query} skeleton={<SectionSkeleton cards={4} charts={2} />}>
      {(data) => {
        const estimate = revenueEstimateView(data.estimate.snapshot);
        const snapshot = data.estimate.snapshot;
        const currency = snapshot.currency ?? "usd";
        const f = bucketFormatters(data.range.granularity);
        const { checkouts, paymentEvents, providerEvents } = data;
        const completion = checkouts.started.current > 0 ? formatPercent(checkouts.completed / checkouts.started.current) : "—";
        return (
          <div className="space-y-8" data-testid="analytics-revenue">
            <div className="space-y-4" data-testid="revenue-estimate">
              <SectionHeading
                title="Estimated recurring revenue"
                description="What active provider-billed subscriptions are worth per month at their verified prices, as of now. It is an estimate, not money received, and does not depend on the selected period."
                badge={
                  <StatusBadge tone="warning" showDot={false}>
                    Estimate
                  </StatusBadge>
                }
                action={<PageLink href="/platform/subscriptions">Manage subscriptions</PageLink>}
              />
              <KpiGrid>
                <Stat
                  label="Estimated MRR"
                  value={estimate.available ? estimate.mrr : <Unavailable />}
                  note={estimate.available ? "Monthly recurring revenue — an estimate" : estimate.reason}
                  icon={CircleDollarSign}
                  testId="revenue-mrr"
                />
                <Stat
                  label="Estimated ARR"
                  value={estimate.available ? estimate.arr : <Unavailable />}
                  note={estimate.available ? "Annual run rate — monthly estimate × 12" : "Needs the monthly estimate"}
                  icon={CalendarRange}
                  testId="revenue-arr"
                />
                <Stat
                  label="Priced subscriptions"
                  value={formatCount(snapshot.countedSubscriptions)}
                  note="Included in the estimate"
                  icon={CreditCard}
                  testId="revenue-priced"
                />
                <Stat
                  label="Unpriced subscriptions"
                  value={formatCount(snapshot.unpricedSubscriptions)}
                  note="Provider-billed, no verified price — excluded"
                  icon={CircleSlash}
                  testId="revenue-unpriced"
                />
              </KpiGrid>
              {estimate.available && estimate.reason && <Note testId="revenue-estimate-caveat">{estimate.reason}</Note>}

              <div className="grid gap-6 lg:grid-cols-2">
                <ChartCard
                  title="Estimate by plan"
                  description="Estimated monthly recurring revenue per plan"
                  badge={
                    <StatusBadge tone="warning" showDot={false}>
                      Estimate
                    </StatusBadge>
                  }
                  testId="revenue-by-plan"
                >
                  {!estimate.available || data.estimate.byPlan.length === 0 ? (
                    <EmptyNote>{estimate.available ? "No priced subscriptions." : estimate.reason}</EmptyNote>
                  ) : (
                    <BreakdownList
                      items={data.estimate.byPlan.map((p) => ({
                        key: p.planId,
                        label: p.planName ?? p.planId,
                        value: p.monthlyRecurringMinor,
                        hint: plural(p.subscriptions, "priced subscription"),
                      }))}
                      valueFormat={(n) => formatMinor(n, currency)}
                      label="Estimated monthly recurring revenue by plan"
                      testId="revenue-plan-list"
                    />
                  )}
                </ChartCard>

                <ChartCard title="How subscriptions are billed" description="Only provider-billed subscriptions can carry a verified price" testId="revenue-billing-sources">
                  {data.billingSources.length === 0 ? (
                    <EmptyNote>No subscriptions yet.</EmptyNote>
                  ) : (
                    <DataTable
                      testId="revenue-sources-table"
                      table={{
                        caption: "Subscriptions by billing method",
                        columns: [
                          { key: "source", label: "Billing method" },
                          { key: "total", label: "Subscriptions", align: "right" },
                          { key: "fullAccess", label: "With full access", align: "right" },
                        ],
                        rows: data.billingSources.map((s) => ({
                          source: BILLING_SOURCE_LABEL[s.billingSource] ?? humanize(s.billingSource),
                          total: formatCount(s.total),
                          fullAccess: formatCount(s.fullAccess),
                        })),
                      }}
                    />
                  )}
                  <p className="mt-3 text-xs text-muted-foreground">
                    Manually managed subscriptions have no recorded price and are never part of the estimate.
                  </p>
                </ChartCard>
              </div>
            </div>

            <div className="space-y-4" data-testid="revenue-collected">
              <SectionHeading
                title="Collected revenue"
                badge={
                  <StatusBadge tone="neutral" showDot={false}>
                    Not recorded
                  </StatusBadge>
                }
              />
              <EmptyState
                icon={Receipt}
                title="Collected revenue is not available"
                description={`${REVENUE_REASON[data.collected.reason ?? ""] ?? "Payment amounts are not available."} No amount is estimated in its place — see the billing provider for money received.`}
              />
            </div>

            <div className="space-y-4" data-testid="revenue-activity">
              <SectionHeading
                title="Billing activity in this period"
                description="Notifications actually received from the billing provider and checkouts started by customers. These are counts — the provider's amounts are not stored."
                badge={
                  <StatusBadge tone="success" showDot={false}>
                    Actual events · counts only
                  </StatusBadge>
                }
              />
              <KpiGrid>
                <Kpi label="Successful payments" count={paymentEvents.paid} icon={CircleDollarSign} testId="revenue-kpi-paid" />
                <Kpi label="Failed payments" count={paymentEvents.failed} icon={TriangleAlert} intent="lower-better" testId="revenue-kpi-failed" />
                <Kpi label="Checkouts started" count={checkouts.started} icon={ShoppingCart} testId="revenue-kpi-checkouts" />
                <Kpi label="Provider notifications" count={providerEvents.total} icon={BellRing} intent="neutral" testId="revenue-kpi-events" />
              </KpiGrid>

              <div className="grid gap-6 lg:grid-cols-2">
                <ChartCard
                  title="Payment notifications"
                  description="Successful and failed invoice payments reported by the provider"
                  testId="revenue-payments-chart"
                  table={{
                    caption: "Payment notifications per period",
                    columns: [
                      { key: "bucket", label: bucketColumnLabel(data.range.granularity) },
                      { key: "paid", label: "Successful", align: "right" },
                      { key: "failed", label: "Failed", align: "right" },
                    ],
                    rows: paymentEvents.series.map((p) => ({ bucket: f.xLabel(p.bucket), paid: formatCount(p.paid), failed: formatCount(p.failed) })),
                  }}
                >
                  <TrendChart
                    ariaLabel="Successful and failed payment notifications over time"
                    kind="bar"
                    stacked
                    data={paymentEvents.series}
                    series={[
                      { key: "paid", label: "Successful", color: SERIES.secondary },
                      { key: "failed", label: "Failed", color: SERIES.failure },
                    ]}
                    empty={<EmptyNote>No payment notifications were received in this period.</EmptyNote>}
                    {...f}
                  />
                </ChartCard>

                <ChartCard
                  title="Checkout outcomes"
                  description={`Where the ${plural(checkouts.started.current, "checkout")} started in this period stand now — ${completion} completed`}
                  testId="revenue-checkouts"
                >
                  <BreakdownList
                    items={[
                      { key: "completed", label: "Completed", value: checkouts.completed },
                      { key: "open", label: "Still open", value: checkouts.open },
                      { key: "expired", label: "Expired", value: checkouts.expired },
                      { key: "failed", label: "Failed", value: checkouts.failed },
                    ]}
                    label="Checkout outcomes"
                    empty="No checkouts were started in this period."
                    testId="revenue-checkout-list"
                  />
                </ChartCard>

                <ChartCard title="Notifications by type" description="Every billing notification received in this period" testId="revenue-events-type">
                  <BreakdownList
                    items={providerEvents.byType.map((t) => ({ key: t.eventType, label: humanize(t.eventType), value: t.count }))}
                    label="Billing notifications by type"
                    empty="No billing notifications were received in this period."
                    testId="revenue-type-list"
                  />
                </ChartCard>

                <ChartCard
                  title="Notifications by result"
                  description={`How each notification was handled — ${plural(providerEvents.failed, "notification")} could not be processed`}
                  testId="revenue-events-outcome"
                >
                  <BreakdownList
                    items={providerEvents.byOutcome.map((o) => ({ key: o.outcome, label: humanize(o.outcome), value: o.count }))}
                    label="Billing notifications by result"
                    empty="No billing notifications were received in this period."
                    testId="revenue-outcome-list"
                  />
                </ChartCard>
              </div>
            </div>
          </div>
        );
      }}
    </QueryBoundary>
  );
}
