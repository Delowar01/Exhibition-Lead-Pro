import { useGetPlatformAnalyticsSubscriptions, getGetPlatformAnalyticsSubscriptionsQueryKey } from "@workspace/api-client-react";
import { ArrowRightLeft, BadgeCheck, CreditCard, Hourglass, PackagePlus, ShieldCheck, XCircle } from "lucide-react";
import { BreakdownList, ChartCard, DataTable, SegmentedBar, StatusBadge, TrendChart } from "@/components/ds";
import {
  BILLING_SOURCE_LABEL,
  LIFECYCLE_FIELDS,
  SERIES,
  formatCount,
  formatPercent,
  humanize,
  subscriptionStatusItems,
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
  bucketColumnLabel,
  bucketFormatters,
  sectionQuery,
  type SectionProps,
} from "./shared";

function planStatusTone(status: string | null): "success" | "warning" | "neutral" {
  if (status === "published") return "success";
  if (status === "draft") return "warning";
  return "neutral";
}

// Subscriptions — the canonical state today, then what changed inside the window.
export function SubscriptionsSection({ params }: SectionProps) {
  const query = useGetPlatformAnalyticsSubscriptions(params, { query: sectionQuery(getGetPlatformAnalyticsSubscriptionsQueryKey(params)) });
  return (
    <QueryBoundary query={query} skeleton={<SectionSkeleton cards={4} charts={2} />}>
      {(data) => {
        const { snapshot, lifecycle } = data;
        const count = (status: string) => snapshot.byStatus.find((s) => s.status === status)?.count ?? 0;
        const statuses = subscriptionStatusItems(snapshot.byStatus);
        const f = bucketFormatters(data.range.granularity);
        const movement = lifecycle.series.map((p) => ({
          bucket: p.bucket,
          created: p.created,
          ended: p.toCancelled + p.toExpired + p.toSuspended,
        }));
        const noLifecycle = LIFECYCLE_FIELDS.every((fld) => lifecycle.totals[fld.key] === 0);
        const planNames = new Map(snapshot.byPlan.map((p) => [p.planId, p.planName ?? p.planId]));
        const planName = (id: string) => planNames.get(id) ?? humanize(id);
        const withoutAccess = Math.max(snapshot.total - snapshot.fullAccess, 0);
        return (
          <div className="space-y-8" data-testid="analytics-subscriptions">
            <div className="space-y-4">
              <SectionHeading
                title="Subscriptions today"
                description="The current state of every company subscription. These figures do not depend on the selected period."
                badge={
                  <StatusBadge tone="info" showDot={false}>
                    As of now
                  </StatusBadge>
                }
                action={<PageLink href="/platform/subscriptions" testId="link-manage-subscriptions">Manage subscriptions</PageLink>}
              />
              <KpiGrid>
                <Stat label="Subscriptions" value={formatCount(snapshot.total)} note="One per company" icon={CreditCard} testId="subs-total" />
                <Stat
                  label="With full access"
                  value={formatCount(snapshot.fullAccess)}
                  note={snapshot.total > 0 ? `${formatPercent(snapshot.fullAccess / snapshot.total)} of all subscriptions` : "Active or trialing"}
                  icon={ShieldCheck}
                  testId="subs-full-access"
                />
                <Stat label="Active" value={formatCount(count("active"))} note={`${formatCount(count("trialing"))} trialing`} icon={BadgeCheck} testId="subs-active" />
                <Stat
                  label="Trials ending soon"
                  value={formatCount(snapshot.trialsExpiringWithin7Days)}
                  note="Within the next 7 days"
                  icon={Hourglass}
                  testId="subs-trials-ending"
                />
              </KpiGrid>

              <div className="grid gap-6 lg:grid-cols-2">
                <ChartCard title="By status" description="Active, trialing, past due, cancelled, expired and suspended" testId="subs-by-status">
                  <SegmentedBar items={statuses} label="Subscriptions by status" className="mb-4" />
                  <BreakdownList
                    items={statuses}
                    label="Subscriptions by status"
                    empty="No subscriptions yet. They appear once companies are onboarded."
                    testId="subs-status-list"
                  />
                </ChartCard>
                <div className="grid content-start gap-6">
                  <ChartCard title="By billing method" description="How each subscription is billed" testId="subs-by-source">
                    <BreakdownList
                      items={snapshot.byBillingSource.map((s) => ({
                        key: s.billingSource,
                        label: BILLING_SOURCE_LABEL[s.billingSource] ?? humanize(s.billingSource),
                        value: s.count,
                      }))}
                      label="Subscriptions by billing method"
                      empty="No subscriptions yet."
                      testId="subs-source-list"
                    />
                  </ChartCard>
                  <ChartCard title="Access today" description="Active and trialing subscriptions grant full access" testId="subs-access">
                    <BreakdownList
                      items={[
                        { key: "full", label: "With full access", value: snapshot.fullAccess, color: "hsl(var(--success))" },
                        { key: "none", label: "Without full access", value: withoutAccess, color: "hsl(var(--muted-foreground))" },
                      ]}
                      label="Subscriptions by access"
                      empty="No subscriptions yet."
                      testId="subs-access-list"
                    />
                  </ChartCard>
                </div>
              </div>

              <ChartCard
                title="Plan distribution"
                description="Subscriptions on each plan, with their current status"
                action={<PageLink href="/platform/plans" testId="link-plans">Manage plans</PageLink>}
                testId="subs-by-plan"
              >
                {snapshot.byPlan.length === 0 ? (
                  <EmptyNote>No subscriptions are assigned to a plan yet.</EmptyNote>
                ) : (
                  <DataTable
                    testId="subs-plan-table"
                    table={{
                      caption: "Subscriptions by plan and status",
                      columns: [
                        { key: "plan", label: "Plan" },
                        { key: "state", label: "Plan state" },
                        { key: "mix", label: "Status mix" },
                        { key: "total", label: "Subscriptions", align: "right" },
                        { key: "active", label: "Active", align: "right" },
                        { key: "trialing", label: "Trialing", align: "right" },
                        { key: "pastDue", label: "Past due", align: "right" },
                        { key: "ended", label: "Cancelled / expired / suspended", align: "right" },
                      ],
                      rows: snapshot.byPlan.map((p) => {
                        const of = (s: string) => p.byStatus.find((x) => x.status === s)?.count ?? 0;
                        return {
                          plan: p.planName ?? p.planId,
                          state: p.planStatus ? (
                            <StatusBadge tone={planStatusTone(p.planStatus)}>{humanize(p.planStatus)}</StatusBadge>
                          ) : (
                            <StatusBadge tone="neutral">Removed</StatusBadge>
                          ),
                          mix: <SegmentedBar items={subscriptionStatusItems(p.byStatus)} label={`${p.planName ?? p.planId} by status`} className="w-28" />,
                          total: formatCount(p.total),
                          active: formatCount(of("active")),
                          trialing: formatCount(of("trialing")),
                          pastDue: formatCount(of("past_due")),
                          ended: formatCount(of("cancelled") + of("expired") + of("suspended")),
                        };
                      }),
                    }}
                  />
                )}
              </ChartCard>
            </div>

            <div className="space-y-4">
              <SectionHeading
                title="Changes in this period"
                description="New subscriptions, moves into each status and plan changes, as recorded in the audit trail."
                action={<PageLink href="/platform/activity">Open activity log</PageLink>}
              />
              <KpiGrid>
                <Kpi
                  label="New subscriptions"
                  count={{ current: lifecycle.totals.created, previous: lifecycle.previousTotals.created }}
                  icon={PackagePlus}
                  testId="subs-kpi-created"
                />
                <Kpi
                  label="Activated"
                  count={{ current: lifecycle.totals.toActive, previous: lifecycle.previousTotals.toActive }}
                  icon={BadgeCheck}
                  testId="subs-kpi-activated"
                />
                <Kpi
                  label="Cancelled"
                  count={{ current: lifecycle.totals.toCancelled, previous: lifecycle.previousTotals.toCancelled }}
                  icon={XCircle}
                  intent="lower-better"
                  testId="subs-kpi-cancelled"
                />
                <Kpi
                  label="Plan changes"
                  count={{ current: lifecycle.totals.planChanges, previous: lifecycle.previousTotals.planChanges }}
                  icon={ArrowRightLeft}
                  intent="neutral"
                  testId="subs-kpi-plan-changes"
                />
              </KpiGrid>

              <ChartCard
                title="Subscription trend"
                description="New subscriptions against those that were cancelled, expired or suspended"
                testId="subs-trend"
                table={{
                  caption: "Subscription changes per period",
                  columns: [
                    { key: "bucket", label: bucketColumnLabel(data.range.granularity) },
                    ...LIFECYCLE_FIELDS.map((fld) => ({ key: fld.key, label: fld.label, align: "right" as const })),
                  ],
                  rows: lifecycle.series.map((p) => ({
                    bucket: f.xLabel(p.bucket),
                    ...Object.fromEntries(LIFECYCLE_FIELDS.map((fld) => [fld.key, formatCount(p[fld.key])])),
                  })),
                }}
              >
                <TrendChart
                  ariaLabel="New subscriptions and ended subscriptions over time"
                  kind="bar"
                  data={movement}
                  series={[
                    { key: "created", label: "New subscriptions", color: SERIES.primary },
                    { key: "ended", label: "Cancelled, expired or suspended", color: SERIES.secondary },
                  ]}
                  empty={<EmptyNote>No subscription changes were recorded in this period.</EmptyNote>}
                  {...f}
                />
              </ChartCard>

              <div className="grid gap-6 lg:grid-cols-2">
                <ChartCard title="All recorded changes" description="Every kind of subscription change in this period" testId="subs-lifecycle">
                  {noLifecycle ? (
                    <EmptyNote>No subscription changes were recorded in this period.</EmptyNote>
                  ) : (
                    <BreakdownList
                      items={LIFECYCLE_FIELDS.map((fld) => ({
                        key: fld.key,
                        label: fld.label,
                        value: lifecycle.totals[fld.key],
                        hint: `${formatCount(lifecycle.previousTotals[fld.key])} in the previous period`,
                      }))}
                      showShare={false}
                      label="Subscription changes in this period"
                      testId="subs-lifecycle-list"
                    />
                  )}
                </ChartCard>

                <ChartCard
                  title="Plan changes"
                  description="The most frequent moves between plans in this period"
                  testId="subs-plan-moves"
                >
                  {lifecycle.planMoves.length === 0 ? (
                    <EmptyNote>No company changed plan in this period.</EmptyNote>
                  ) : (
                    <DataTable
                      testId="subs-plan-moves-table"
                      table={{
                        caption: "Plan changes in this period",
                        columns: [
                          { key: "from", label: "From plan" },
                          { key: "to", label: "To plan" },
                          { key: "count", label: "Changes", align: "right" },
                        ],
                        rows: lifecycle.planMoves.map((m) => ({ from: planName(m.fromPlan), to: planName(m.toPlan), count: formatCount(m.count) })),
                      }}
                    />
                  )}
                </ChartCard>
              </div>

              <Note testId="subs-note">
                Changes are derived from the audit trail of subscription updates. Changes made before auditing existed are
                not represented, and one subscription can appear in more than one row (for example trial started, then
                activated).
              </Note>
            </div>
          </div>
        );
      }}
    </QueryBoundary>
  );
}
