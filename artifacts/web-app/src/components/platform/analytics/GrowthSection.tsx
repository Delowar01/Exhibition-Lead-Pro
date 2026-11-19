import { useGetPlatformAnalyticsGrowth, getGetPlatformAnalyticsGrowthQueryKey } from "@workspace/api-client-react";
import type { PlatformAnalyticsGrowthSeries } from "@workspace/api-client-react";
import { Building2, UserPlus, Users, Building } from "lucide-react";
import { ChartCard, TrendChart } from "@/components/ds";
import { SERIES, formatCount, type Granularity } from "@/lib/platform-analytics";
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

function GrowthCharts({
  nounPlural,
  growth,
  granularity,
  href,
  linkLabel,
  testId,
}: {
  nounPlural: string;
  growth: PlatformAnalyticsGrowthSeries;
  granularity: Granularity;
  href: string;
  linkLabel: string;
  testId: string;
}) {
  const f = bucketFormatters(granularity);
  const table = {
    caption: `${nounPlural} created per period and running total`,
    columns: [
      { key: "bucket", label: bucketColumnLabel(granularity) },
      { key: "added", label: `New ${nounPlural.toLowerCase()}`, align: "right" as const },
      { key: "cumulative", label: `Total ${nounPlural.toLowerCase()}`, align: "right" as const },
    ],
    rows: growth.series.map((p) => ({ bucket: f.xLabel(p.bucket), added: formatCount(p.added), cumulative: formatCount(p.cumulative) })),
  };
  return (
    <div className="grid gap-6 lg:grid-cols-2" data-testid={testId}>
      <ChartCard
        title={`New ${nounPlural.toLowerCase()}`}
        description={`${nounPlural} created in each period`}
        action={<PageLink href={href}>{linkLabel}</PageLink>}
        table={table}
        testId={`${testId}-added`}
      >
        <TrendChart
          ariaLabel={`New ${nounPlural.toLowerCase()} over time`}
          kind="bar"
          data={growth.series}
          series={[{ key: "added", label: `New ${nounPlural.toLowerCase()}`, color: SERIES.primary }]}
          empty={<EmptyNote>No {nounPlural.toLowerCase()} were created in this period.</EmptyNote>}
          {...f}
        />
      </ChartCard>
      <ChartCard
        title={`Total ${nounPlural.toLowerCase()}`}
        description={`Running total at the end of each period — from ${formatCount(growth.startingTotal)} to ${formatCount(growth.endingTotal)}`}
        table={table}
        testId={`${testId}-total`}
      >
        <TrendChart
          ariaLabel={`Total ${nounPlural.toLowerCase()} over time`}
          data={growth.series}
          series={[{ key: "cumulative", label: `Total ${nounPlural.toLowerCase()}`, color: SERIES.secondary }]}
          empty={<EmptyNote>There are no {nounPlural.toLowerCase()} yet.</EmptyNote>}
          {...f}
        />
      </ChartCard>
    </div>
  );
}

// Growth — companies and users by creation date.
export function GrowthSection({ params }: SectionProps) {
  const query = useGetPlatformAnalyticsGrowth(params, { query: sectionQuery(getGetPlatformAnalyticsGrowthQueryKey(params)) });
  return (
    <QueryBoundary query={query} skeleton={<SectionSkeleton cards={4} charts={4} />}>
      {(data) => (
        <div className="space-y-6" data-testid="analytics-growth">
          <KpiGrid>
            <Kpi label="New companies" count={data.companies.added} icon={Building2} testId="growth-new-companies" />
            <Stat
              label="Total companies"
              value={formatCount(data.companies.endingTotal)}
              note={`${formatCount(data.companies.startingTotal)} before this period`}
              icon={Building}
              testId="growth-total-companies"
            />
            <Kpi label="New users" count={data.users.added} icon={UserPlus} testId="growth-new-users" />
            <Stat
              label="Total users"
              value={formatCount(data.users.endingTotal)}
              note={`${formatCount(data.users.startingTotal)} before this period`}
              icon={Users}
              testId="growth-total-users"
            />
          </KpiGrid>

          <GrowthCharts
            nounPlural="Companies"
            growth={data.companies}
            granularity={data.range.granularity}
            href="/platform/companies"
            linkLabel="View companies"
            testId="growth-companies"
          />
          <GrowthCharts
            nounPlural="Users"
            growth={data.users}
            granularity={data.range.granularity}
            href="/platform/users"
            linkLabel="View users"
            testId="growth-users"
          />

          <Note testId="growth-note">
            Growth is counted from the creation date of the companies and users that exist today. A company that has been
            permanently deleted is no longer counted in any period.
          </Note>
        </div>
      )}
    </QueryBoundary>
  );
}
