import { useGetPlatformAnalyticsOperations, getGetPlatformAnalyticsOperationsQueryKey } from "@workspace/api-client-react";
import { BellRing, ClipboardList, KeyRound, LogIn, ShieldAlert, UserCheck } from "lucide-react";
import { BreakdownList, ChartCard, StatusBadge, TrendChart } from "@/components/ds";
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

// Operations — sign-ins, the audit trail, security events and the background job queue.
export function OperationsSection({ params }: SectionProps) {
  const query = useGetPlatformAnalyticsOperations(params, { query: sectionQuery(getGetPlatformAnalyticsOperationsQueryKey(params)) });
  return (
    <QueryBoundary query={query} skeleton={<SectionSkeleton cards={6} charts={2} />}>
      {(data) => {
        const f = bucketFormatters(data.range.granularity);
        const { signIns, auditEvents, securityEvents, billingEvents, jobs } = data;
        return (
          <div className="space-y-6" data-testid="analytics-operations">
            <KpiGrid columns={3}>
              <Kpi label="Successful sign-ins" count={signIns.successful} icon={LogIn} testId="ops-kpi-signins" />
              <Kpi label="Failed sign-ins" count={signIns.failed} icon={KeyRound} intent="lower-better" testId="ops-kpi-failed-signins" />
              <Kpi label="Users who signed in" count={signIns.activeUsers} icon={UserCheck} testId="ops-kpi-active-users" />
              <Kpi label="Audit events" count={auditEvents.total} icon={ClipboardList} intent="neutral" testId="ops-kpi-audit" />
              <Kpi label="Security events" count={securityEvents.total} icon={ShieldAlert} intent="lower-better" testId="ops-kpi-security" />
              <Kpi label="Billing notifications" count={billingEvents.received} icon={BellRing} intent="neutral" testId="ops-kpi-billing" />
            </KpiGrid>

            <div className="grid gap-6 lg:grid-cols-2">
              <ChartCard
                title="Sign-ins"
                description="Successful and failed sign-in attempts across all companies"
                testId="ops-signins-chart"
                table={{
                  caption: "Sign-in attempts per period",
                  columns: [
                    { key: "bucket", label: bucketColumnLabel(data.range.granularity) },
                    { key: "successful", label: "Successful", align: "right" },
                    { key: "failed", label: "Failed", align: "right" },
                  ],
                  rows: signIns.series.map((p) => ({ bucket: f.xLabel(p.bucket), successful: formatCount(p.successful), failed: formatCount(p.failed) })),
                }}
              >
                <TrendChart
                  ariaLabel="Successful and failed sign-ins over time"
                  kind="bar"
                  stacked
                  data={signIns.series}
                  series={[
                    { key: "successful", label: "Successful", color: SERIES.secondary },
                    { key: "failed", label: "Failed", color: SERIES.failure },
                  ]}
                  empty={<EmptyNote>No sign-in attempts were recorded in this period.</EmptyNote>}
                  {...f}
                />
              </ChartCard>

              <ChartCard
                title="Audit events"
                description="Recorded changes across the platform"
                action={<PageLink href="/platform/activity" testId="link-activity">Open activity log</PageLink>}
                testId="ops-audit-chart"
                table={{
                  caption: "Audit events per period",
                  columns: [
                    { key: "bucket", label: bucketColumnLabel(data.range.granularity) },
                    { key: "value", label: "Audit events", align: "right" },
                  ],
                  rows: auditEvents.series.map((p) => ({ bucket: f.xLabel(p.bucket), value: formatCount(p.value) })),
                }}
              >
                <TrendChart
                  ariaLabel="Audit events over time"
                  data={auditEvents.series}
                  series={[{ key: "value", label: "Audit events", color: SERIES.primary }]}
                  empty={<EmptyNote>No audit events were recorded in this period.</EmptyNote>}
                  {...f}
                />
              </ChartCard>

              <ChartCard title="Audit events by area" description="Which parts of the product recorded changes" testId="ops-audit-areas">
                <BreakdownList
                  items={auditEvents.byCategory.map((c) => ({ key: c.category, label: humanize(c.category), value: c.count }))}
                  label="Audit events by area"
                  empty="No audit events were recorded in this period."
                  testId="ops-audit-list"
                />
              </ChartCard>

              <ChartCard title="Security events by type" description="Sign-in protection and account security signals" testId="ops-security">
                <BreakdownList
                  items={securityEvents.byType.map((t) => ({ key: t.type, label: humanize(t.type), value: t.count }))}
                  label="Security events by type"
                  empty="No security events were recorded in this period."
                  testId="ops-security-list"
                />
              </ChartCard>
            </div>

            <ChartCard
              title="Background jobs"
              description="The job queue right now — not tied to the selected period"
              badge={
                <StatusBadge tone="info" showDot={false}>
                  As of now
                </StatusBadge>
              }
              testId="ops-jobs"
            >
              {jobs.durable ? (
                <dl className="grid gap-4 sm:grid-cols-3" data-testid="ops-jobs-figures">
                  {[
                    { label: "Waiting", value: jobs.pending, note: "Queued to run" },
                    { label: "Running", value: jobs.running, note: "In progress" },
                    { label: "Failed permanently", value: jobs.dead, note: "Kept for diagnosis" },
                  ].map((j) => (
                    <div key={j.label} className="rounded-lg border border-border p-4">
                      <dt className="text-sm font-medium text-muted-foreground">{j.label}</dt>
                      <dd className="mt-1 text-2xl font-bold tracking-tight text-foreground">{formatCount(j.value)}</dd>
                      <dd className="text-xs text-muted-foreground">{j.note}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <EmptyNote>
                  This environment runs jobs in memory, so no queue figures are kept. They are available where the durable job
                  queue is enabled.
                </EmptyNote>
              )}
            </ChartCard>

            <Note testId="ops-note">
              {plural(billingEvents.failed.current, "billing notification")} could not be processed in this period (
              {formatCount(billingEvents.failed.previous)} in the previous period). Completed jobs are removed from the queue
              after a few days, so the job figures are a current snapshot rather than a history.
            </Note>
          </div>
        );
      }}
    </QueryBoundary>
  );
}
