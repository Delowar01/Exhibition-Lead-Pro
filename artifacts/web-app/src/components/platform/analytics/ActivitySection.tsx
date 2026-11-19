import { Link } from "wouter";
import { useGetPlatformAnalyticsActivity, getGetPlatformAnalyticsActivityQueryKey } from "@workspace/api-client-react";
import { Building2, Camera, Contact, Target } from "lucide-react";
import { BreakdownList, ChartCard, DataTable, TrendChart } from "@/components/ds";
import { SERIES, formatCount, humanize, plural } from "@/lib/platform-analytics";
import {
  EmptyNote,
  Kpi,
  KpiGrid,
  Note,
  PageLink,
  QueryBoundary,
  SectionSkeleton,
  bucketColumnLabel,
  bucketFormatters,
  sectionQuery,
  type SectionProps,
} from "./shared";

const MEASURES = [
  { key: "scans", title: "Card scans", empty: "No cards were scanned in this period." },
  { key: "contacts", title: "New contacts", empty: "No contacts were created in this period." },
  { key: "leads", title: "New leads", empty: "No leads were created in this period." },
] as const;

// Activity — capture volumes across all companies. Volumes only: no tenant record is shown.
export function ActivitySection({ params }: SectionProps) {
  const query = useGetPlatformAnalyticsActivity(params, { query: sectionQuery(getGetPlatformAnalyticsActivityQueryKey(params)) });
  return (
    <QueryBoundary query={query} skeleton={<SectionSkeleton cards={4} charts={3} />}>
      {(data) => {
        const f = bucketFormatters(data.range.granularity);
        const table = {
          caption: "Card scans, new contacts and new leads per period",
          columns: [
            { key: "bucket", label: bucketColumnLabel(data.range.granularity) },
            { key: "scans", label: "Card scans", align: "right" as const },
            { key: "contacts", label: "New contacts", align: "right" as const },
            { key: "leads", label: "New leads", align: "right" as const },
          ],
          rows: data.series.map((p) => ({
            bucket: f.xLabel(p.bucket),
            scans: formatCount(p.scans),
            contacts: formatCount(p.contacts),
            leads: formatCount(p.leads),
          })),
        };
        return (
          <div className="space-y-6" data-testid="analytics-activity">
            <KpiGrid>
              <Kpi label="Card scans" count={data.totals.scans} icon={Camera} testId="activity-kpi-scans" />
              <Kpi label="New contacts" count={data.totals.contacts} icon={Contact} testId="activity-kpi-contacts" />
              <Kpi label="New leads" count={data.totals.leads} icon={Target} testId="activity-kpi-leads" />
              <Kpi label="Active companies" count={data.totals.activeCompanies} icon={Building2} testId="activity-kpi-companies" />
            </KpiGrid>

            <div className="grid gap-6 lg:grid-cols-3" data-testid="activity-trends">
              {MEASURES.map((m) => (
                <ChartCard key={m.key} title={m.title} table={table} testId={`activity-chart-${m.key}`}>
                  <TrendChart
                    ariaLabel={`${m.title} over time`}
                    data={data.series}
                    series={[{ key: m.key, label: m.title, color: SERIES.primary }]}
                    height={200}
                    empty={<EmptyNote>{m.empty}</EmptyNote>}
                    {...f}
                  />
                </ChartCard>
              ))}
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <ChartCard
                title="Scans by capture method"
                description="How cards were captured"
                testId="activity-by-method"
                footer={
                  <span data-testid="activity-manual-entries">
                    {plural(data.manualEntries, "manual entry", "manual entries")} in this period — typed by hand, so not counted as scans.
                  </span>
                }
              >
                <BreakdownList
                  items={data.scansByMethod.map((m) => ({ key: m.method, label: humanize(m.method), value: m.count }))}
                  label="Card scans by capture method"
                  empty="No cards were scanned in this period."
                  testId="activity-method-list"
                />
              </ChartCard>
              <ChartCard title="Scans by processing status" description="Where the scans of this period stand now" testId="activity-by-status">
                <BreakdownList
                  items={data.scansByStatus.map((s) => ({ key: s.status, label: humanize(s.status), value: s.count }))}
                  label="Card scans by processing status"
                  empty="No cards were scanned in this period."
                  testId="activity-status-list"
                />
              </ChartCard>
            </div>

            <ChartCard
              title="Most active companies"
              description="Ranked by cards scanned and contacts created in this period"
              action={<PageLink href="/platform/companies" testId="link-companies">View all companies</PageLink>}
              testId="activity-top-companies"
            >
              {data.topCompanies.length === 0 ? (
                <EmptyNote>No company captured a card or a contact in this period.</EmptyNote>
              ) : (
                <DataTable
                  testId="activity-top-table"
                  table={{
                    caption: "Most active companies in this period",
                    columns: [
                      { key: "company", label: "Company" },
                      { key: "scans", label: "Card scans", align: "right" },
                      { key: "contacts", label: "New contacts", align: "right" },
                      { key: "leads", label: "New leads", align: "right" },
                    ],
                    rows: data.topCompanies.map((c) => ({
                      company: (
                        <Link
                          href={`/platform/companies/${c.companyId}`}
                          className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
                        >
                          {c.companyName}
                        </Link>
                      ),
                      scans: formatCount(c.scans),
                      contacts: formatCount(c.contacts),
                      leads: formatCount(c.leads),
                    })),
                  }}
                />
              )}
            </ChartCard>

            <Note testId="activity-note">
              These are volumes per company. Contact, lead and scan records belong to each company and are never shown here.
            </Note>
          </div>
        );
      }}
    </QueryBoundary>
  );
}
