import {
  useGetPlatformAnalyticsOverview,
  useGetPlatformAnalyticsActivity,
  useGetPlatformAnalyticsGrowth,
  getGetPlatformAnalyticsOverviewQueryKey,
  getGetPlatformAnalyticsActivityQueryKey,
  getGetPlatformAnalyticsGrowthQueryKey,
} from "@workspace/api-client-react";
import { Building2, Camera, Contact, Sparkles, Target, UserCheck, UserPlus, Users } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { BreakdownList, ChartCard, SegmentedBar, StatusBadge, TrendChart } from "@/components/ds";
import {
  SERIES,
  formatCount,
  formatUsd,
  deltaOf,
  plural,
  revenueEstimateView,
  subscriptionStatusItems,
} from "@/lib/platform-analytics";
import {
  EmptyNote,
  Kpi,
  KpiGrid,
  Note,
  PageLink,
  QueryBoundary,
  SectionSkeleton,
  TabLink,
  Unavailable,
  bucketColumnLabel,
  bucketFormatters,
  sectionQuery,
  type SectionProps,
} from "./shared";

// Overview — the headline figures of the window, the two trends an owner reads first, and
// the state of subscriptions, estimated revenue and AI spend.
export function OverviewSection({ params, onOpenTab }: SectionProps) {
  const overview = useGetPlatformAnalyticsOverview(params, { query: sectionQuery(getGetPlatformAnalyticsOverviewQueryKey(params)) });
  const activity = useGetPlatformAnalyticsActivity(params, { query: sectionQuery(getGetPlatformAnalyticsActivityQueryKey(params)) });
  const growth = useGetPlatformAnalyticsGrowth(params, { query: sectionQuery(getGetPlatformAnalyticsGrowthQueryKey(params)) });
  const chartSkeleton = <Skeleton className="h-[340px] w-full rounded-xl" />;

  return (
    <QueryBoundary query={overview} skeleton={<SectionSkeleton cards={8} charts={2} />}>
      {(data) => {
        const statuses = subscriptionStatusItems(data.subscriptions.byStatus);
        const revenue = revenueEstimateView(data.revenue);
        const aiCost = deltaOf(data.ai.costUsd.current, data.ai.costUsd.previous);
        return (
          <div className="space-y-6" data-testid="analytics-overview">
            <KpiGrid>
              <Kpi label="New companies" count={data.period.newCompanies} icon={Building2} testId="kpi-new-companies" />
              <Kpi label="New users" count={data.period.newUsers} icon={UserPlus} testId="kpi-new-users" />
              <Kpi label="Active companies" count={data.period.activeCompanies} icon={UserCheck} testId="kpi-active-companies" />
              <Kpi label="Active users" count={data.period.activeUsers} icon={Users} testId="kpi-active-users" />
              <Kpi label="Card scans" count={data.period.scans} icon={Camera} testId="kpi-scans" />
              <Kpi label="New contacts" count={data.period.contacts} icon={Contact} testId="kpi-contacts" />
              <Kpi label="New leads" count={data.period.leads} icon={Target} testId="kpi-leads" />
              <Kpi label="AI requests" count={data.period.aiRequests} icon={Sparkles} intent="neutral" testId="kpi-ai-requests" />
            </KpiGrid>
            <Note>
              Active companies captured at least one card or contact in the period; active users signed in at least once.
              Platform totals today: {plural(data.totals.companies, "company", "companies")} and {plural(data.totals.users, "user")}.
            </Note>

            <div className="grid gap-6 lg:grid-cols-2">
              <QueryBoundary query={activity} skeleton={chartSkeleton}>
                {(a) => {
                  const f = bucketFormatters(a.range.granularity);
                  return (
                    <ChartCard
                      title="Card scans"
                      description="Cards captured across all companies"
                      action={<TabLink onClick={() => onOpenTab("activity")}>Activity details</TabLink>}
                      testId="overview-scans-chart"
                      table={{
                        caption: "Card scans per period",
                        columns: [
                          { key: "bucket", label: bucketColumnLabel(a.range.granularity) },
                          { key: "scans", label: "Card scans", align: "right" },
                        ],
                        rows: a.series.map((p) => ({ bucket: f.xLabel(p.bucket), scans: formatCount(p.scans) })),
                      }}
                    >
                      <TrendChart
                        ariaLabel="Card scans over time"
                        data={a.series}
                        series={[{ key: "scans", label: "Card scans", color: SERIES.primary }]}
                        empty={<EmptyNote>No cards were scanned in this period.</EmptyNote>}
                        {...f}
                      />
                    </ChartCard>
                  );
                }}
              </QueryBoundary>
              <QueryBoundary query={growth} skeleton={chartSkeleton}>
                {(g) => {
                  const f = bucketFormatters(g.range.granularity);
                  return (
                    <ChartCard
                      title="New companies"
                      description="Companies created in each period"
                      action={<TabLink onClick={() => onOpenTab("growth")}>Growth details</TabLink>}
                      testId="overview-companies-chart"
                      table={{
                        caption: "New companies per period",
                        columns: [
                          { key: "bucket", label: bucketColumnLabel(g.range.granularity) },
                          { key: "added", label: "New companies", align: "right" },
                          { key: "cumulative", label: "Total companies", align: "right" },
                        ],
                        rows: g.companies.series.map((p) => ({
                          bucket: f.xLabel(p.bucket),
                          added: formatCount(p.added),
                          cumulative: formatCount(p.cumulative),
                        })),
                      }}
                    >
                      <TrendChart
                        ariaLabel="New companies over time"
                        kind="bar"
                        data={g.companies.series}
                        series={[{ key: "added", label: "New companies", color: SERIES.secondary }]}
                        empty={<EmptyNote>No companies were created in this period.</EmptyNote>}
                        {...f}
                      />
                    </ChartCard>
                  );
                }}
              </QueryBoundary>
            </div>

            <div className="grid gap-6 lg:grid-cols-3">
              <ChartCard
                title="Subscriptions today"
                description="Current status of every company subscription"
                action={<PageLink href="/platform/subscriptions">Manage subscriptions</PageLink>}
                className="lg:col-span-2"
                testId="overview-subscriptions"
                footer={
                  <span data-testid="overview-subscription-facts">
                    {formatCount(data.subscriptions.fullAccess)} of {plural(data.subscriptions.total, "subscription")} grant full
                    access today · {plural(data.subscriptions.trialsExpiringWithin7Days, "trial")} ending within 7 days
                  </span>
                }
              >
                <SegmentedBar items={statuses} label="Subscriptions by status" className="mb-4" />
                <BreakdownList
                  items={statuses}
                  label="Subscriptions by status"
                  empty="No subscriptions yet. They appear once companies are onboarded."
                  testId="overview-status-list"
                />
              </ChartCard>

              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-1">
                <ChartCard
                  title="Recurring revenue"
                  badge={
                    <StatusBadge tone="warning" showDot={false}>
                      Estimate
                    </StatusBadge>
                  }
                  footer={<TabLink onClick={() => onOpenTab("revenue")}>Revenue details</TabLink>}
                  testId="overview-revenue"
                >
                  <p className="text-3xl font-bold tracking-tight text-foreground" data-testid="overview-mrr">
                    {revenue.available ? revenue.mrr : <Unavailable />}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {revenue.available
                      ? `Per month, from ${plural(data.revenue.countedSubscriptions, "priced subscription")}. An estimate — not money received.`
                      : revenue.reason}
                  </p>
                  {revenue.available && revenue.reason && <p className="mt-1 text-xs text-muted-foreground">{revenue.reason}</p>}
                </ChartCard>

                <ChartCard
                  title="AI cost"
                  badge={
                    <StatusBadge tone="warning" showDot={false}>
                      Estimate
                    </StatusBadge>
                  }
                  footer={<TabLink onClick={() => onOpenTab("ai")}>AI details</TabLink>}
                  testId="overview-ai-cost"
                >
                  <p className="text-3xl font-bold tracking-tight text-foreground">{formatUsd(data.ai.costUsd.current)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {aiCost.kind === "none"
                      ? "No AI usage in either period."
                      : `${formatUsd(data.ai.costUsd.previous)} in the previous period. Estimated from token usage.`}
                  </p>
                </ChartCard>
              </div>
            </div>
          </div>
        );
      }}
    </QueryBoundary>
  );
}
