import { Link } from "wouter";
import { useGetPlatformAnalyticsAi, getGetPlatformAnalyticsAiQueryKey } from "@workspace/api-client-react";
import { Ban, Coins, Database, Gauge, Hash, Sparkles, Timer, TriangleAlert } from "lucide-react";
import { BreakdownList, ChartCard, DataTable, StatusBadge, TrendChart } from "@/components/ds";
import { SERIES, formatCompact, formatCount, formatPercent, formatUsd, humanize } from "@/lib/platform-analytics";
import {
  EmptyNote,
  Kpi,
  KpiGrid,
  Note,
  PageLink,
  QueryBoundary,
  SectionSkeleton,
  Stat,
  bucketColumnLabel,
  bucketFormatters,
  sectionQuery,
  type SectionProps,
} from "./shared";

const estimateBadge = (
  <StatusBadge tone="warning" showDot={false}>
    Estimate
  </StatusBadge>
);

// AI usage — provider calls, failures and ESTIMATED cost from the AI usage ledger.
export function AiSection({ params }: SectionProps) {
  const query = useGetPlatformAnalyticsAi(params, { query: sectionQuery(getGetPlatformAnalyticsAiQueryKey(params)) });
  return (
    <QueryBoundary query={query} skeleton={<SectionSkeleton cards={8} charts={2} />}>
      {(data) => {
        const { totals, previous } = data;
        const f = bucketFormatters(data.range.granularity);
        const pair = (key: "requests" | "costUsd" | "totalTokens" | "cacheHits" | "budgetDenied" | "rateLimited") => ({
          current: totals[key],
          previous: previous[key],
        });
        return (
          <div className="space-y-6" data-testid="analytics-ai">
            <KpiGrid>
              <Kpi label="AI requests" count={pair("requests")} icon={Sparkles} intent="neutral" testId="ai-kpi-requests" />
              <Kpi label="Estimated cost" count={pair("costUsd")} icon={Coins} format={formatUsd} intent="neutral" testId="ai-kpi-cost" />
              {/* A rate or an average over zero requests does not exist: show a dash, never "0%" or "0 ms". */}
              <Stat
                label="Failure rate"
                value={totals.requests > 0 ? formatPercent(totals.failureRate) : "—"}
                note={
                  totals.requests > 0
                    ? `${formatCount(totals.errors)} failed · ${previous.requests > 0 ? `${formatPercent(previous.failureRate)} in the previous period` : "no requests in the previous period"}`
                    : "No requests in this period"
                }
                icon={TriangleAlert}
                testId="ai-kpi-failure-rate"
              />
              <Stat
                label="Average response time"
                value={totals.requests > 0 ? `${formatCount(totals.avgLatencyMs)} ms` : "—"}
                note={
                  totals.requests > 0
                    ? previous.requests > 0
                      ? `${formatCount(previous.avgLatencyMs)} ms in the previous period`
                      : "No requests in the previous period"
                    : "No requests in this period"
                }
                icon={Timer}
                testId="ai-kpi-latency"
              />
              <Kpi label="Tokens used" count={pair("totalTokens")} icon={Hash} format={formatCompact} intent="neutral" testId="ai-kpi-tokens" />
              <Kpi label="Served from cache" count={pair("cacheHits")} icon={Database} testId="ai-kpi-cache" />
              <Kpi label="Stopped by budget" count={pair("budgetDenied")} icon={Ban} intent="lower-better" testId="ai-kpi-budget" />
              <Kpi label="Rate limited" count={pair("rateLimited")} icon={Gauge} intent="lower-better" testId="ai-kpi-rate-limited" />
            </KpiGrid>

            <div className="grid gap-6 lg:grid-cols-2">
              <ChartCard
                title="AI requests"
                description="Provider calls that succeeded and failed"
                action={<PageLink href="/platform/ai" testId="link-ai">Open AI Intelligence</PageLink>}
                testId="ai-requests-chart"
                table={{
                  caption: "AI requests per period",
                  columns: [
                    { key: "bucket", label: bucketColumnLabel(data.range.granularity) },
                    { key: "success", label: "Succeeded", align: "right" },
                    { key: "errors", label: "Failed", align: "right" },
                    { key: "tokens", label: "Tokens", align: "right" },
                  ],
                  rows: data.series.map((p) => ({
                    bucket: f.xLabel(p.bucket),
                    success: formatCount(p.success),
                    errors: formatCount(p.errors),
                    tokens: formatCount(p.totalTokens),
                  })),
                }}
              >
                <TrendChart
                  ariaLabel="Succeeded and failed AI requests over time"
                  kind="bar"
                  stacked
                  data={data.series}
                  series={[
                    { key: "success", label: "Succeeded", color: SERIES.secondary },
                    { key: "errors", label: "Failed", color: SERIES.failure },
                  ]}
                  empty={<EmptyNote>No AI requests were made in this period.</EmptyNote>}
                  {...f}
                />
              </ChartCard>

              <ChartCard
                title="AI cost"
                description="Estimated from token usage and the platform price table"
                badge={estimateBadge}
                testId="ai-cost-chart"
                table={{
                  caption: "Estimated AI cost per period",
                  columns: [
                    { key: "bucket", label: bucketColumnLabel(data.range.granularity) },
                    { key: "cost", label: "Estimated cost", align: "right" },
                    { key: "requests", label: "Requests", align: "right" },
                  ],
                  rows: data.series.map((p) => ({ bucket: f.xLabel(p.bucket), cost: formatUsd(p.costUsd), requests: formatCount(p.requests) })),
                }}
              >
                <TrendChart
                  ariaLabel="Estimated AI cost over time"
                  data={data.series}
                  series={[{ key: "costUsd", label: "Estimated cost", color: SERIES.primary }]}
                  valueFormat={formatUsd}
                  tickFormat={formatUsd}
                  allowDecimals
                  empty={<EmptyNote>No AI cost was recorded in this period.</EmptyNote>}
                  {...f}
                />
              </ChartCard>
            </div>

            <ChartCard title="Usage by feature" description="Which AI features were used in this period" testId="ai-by-feature">
              {data.byFeature.length === 0 ? (
                <EmptyNote>No AI requests were made in this period.</EmptyNote>
              ) : (
                <DataTable
                  testId="ai-feature-table"
                  table={{
                    caption: "AI usage by feature",
                    columns: [
                      { key: "feature", label: "Feature" },
                      { key: "requests", label: "Requests", align: "right" },
                      { key: "failureRate", label: "Failure rate", align: "right" },
                      { key: "tokens", label: "Tokens", align: "right" },
                      { key: "latency", label: "Avg response", align: "right" },
                      { key: "cost", label: "Estimated cost", align: "right" },
                    ],
                    rows: data.byFeature.map((r) => ({
                      feature: humanize(r.feature),
                      requests: formatCount(r.requests),
                      failureRate: formatPercent(r.failureRate),
                      tokens: formatCount(r.totalTokens),
                      latency: `${formatCount(r.avgLatencyMs)} ms`,
                      cost: formatUsd(r.costUsd),
                    })),
                  }}
                />
              )}
            </ChartCard>

            <div className="grid gap-6 lg:grid-cols-2">
              <ChartCard
                title="Companies using AI the most"
                description="Ranked by estimated cost in this period"
                badge={estimateBadge}
                testId="ai-top-companies"
              >
                {data.topCompanies.length === 0 ? (
                  <EmptyNote>No company used AI in this period.</EmptyNote>
                ) : (
                  <DataTable
                    testId="ai-company-table"
                    table={{
                      caption: "AI usage by company",
                      columns: [
                        { key: "company", label: "Company" },
                        { key: "requests", label: "Requests", align: "right" },
                        { key: "tokens", label: "Tokens", align: "right" },
                        { key: "cost", label: "Estimated cost", align: "right" },
                      ],
                      rows: data.topCompanies.map((c) => ({
                        company:
                          c.companyId != null ? (
                            <Link
                              href={`/platform/companies/${c.companyId}`}
                              className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
                            >
                              {c.companyName ?? `Company ${c.companyId}`}
                            </Link>
                          ) : (
                            "Platform (no company)"
                          ),
                        requests: formatCount(c.requests),
                        tokens: formatCount(c.totalTokens),
                        cost: formatUsd(c.costUsd),
                      })),
                    }}
                  />
                )}
              </ChartCard>

              <ChartCard title="Why requests failed" description="Failed provider calls by cause" testId="ai-failures">
                <BreakdownList
                  items={data.failureCategories.map((c) => ({ key: c.category, label: humanize(c.category), value: c.count }))}
                  label="Failed AI requests by cause"
                  empty="No AI request failed in this period."
                  testId="ai-failure-list"
                />
              </ChartCard>
            </div>

            <Note testId="ai-note">
              AI cost is an estimate computed from token usage and the platform price table. It is not the provider's invoice.
              Prompts and responses are never stored in these figures.
            </Note>
          </div>
        );
      }}
    </QueryBoundary>
  );
}
