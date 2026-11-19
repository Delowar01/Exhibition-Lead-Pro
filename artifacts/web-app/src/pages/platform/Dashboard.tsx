import React from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  useGetPlatformStats,
  useGetPlatformRevenueTrend,
  useGetPlatformScanTrend,
  useListCompanies,
} from "@workspace/api-client-react";
import { Building2, Users, Camera, DollarSign, Activity, Zap, Info } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis, CartesianGrid, PieChart, Pie, Cell } from "recharts";
import { format } from "date-fns";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { PageHeader, MetricCard, StatusBadge, CardGridSkeleton, TableSkeleton, EmptyState } from "@/components/ds";
import { formatMinor } from "@/lib/money";

// Batch 20 — truthful platform dashboard. Revenue is shown only when the API
// can compute it from verified provider prices; otherwise the cards say
// "Unavailable" with the reason. Subscription status comes from canonical
// subscription rows (no percentage-derived states, no synthetic trends).
//
// G-7 — the figures use the same definitions as Platform Owner Analytics: users are
// company users that exist today, a capture is any saved capture, a card scan is a
// capture sent for OCR, and money is formatted in the currency's own minor unit.

const STATUS_LABEL: Record<string, string> = {
  trialing: "Trialing",
  active: "Active",
  past_due: "Past due",
  cancelled: "Cancelled",
  expired: "Expired",
  suspended: "Suspended",
};

const REVENUE_REASON: Record<string, string> = {
  NO_VERIFIED_PRICES: "No verified provider prices are registered.",
  NO_ACTIVE_PROVIDER_SUBSCRIPTIONS: "No active provider-managed subscriptions.",
  UNPRICED_SUBSCRIPTIONS: "Active provider subscriptions are not bound to verified prices.",
  MIXED_CURRENCIES: "Subscriptions are billed in more than one currency.",
  PARTIAL_UNPRICED: "Some provider subscriptions have no verified price.",
  NO_REVENUE_HISTORY: "Revenue history is not recorded by this system.",
};

// Past due wears the warning token, as its status badge does. (It used to share the exact red
// of Suspended, so the two could not be told apart in the ring or its legend.)
const STATUS_COLORS: Record<string, string> = {
  active: "hsl(var(--primary))",
  trialing: "hsl(var(--chart-2))",
  past_due: "hsl(var(--warning))",
  cancelled: "hsl(var(--chart-3))",
  expired: "hsl(var(--muted-foreground))",
  suspended: "hsl(var(--destructive))",
};

function statusTone(status: string | undefined): "success" | "warning" | "destructive" | "neutral" {
  if (status === "active" || status === "trialing") return "success";
  if (status === "past_due" || status === "cancelled") return "warning";
  if (status === "expired" || status === "suspended") return "destructive";
  return "neutral";
}

export default function PlatformDashboard() {
  const { data: stats, isLoading: statsLoading } = useGetPlatformStats();
  const { data: revenueTrend, isLoading: revenueLoading } = useGetPlatformRevenueTrend();
  const { data: scanData, isLoading: scanLoading } = useGetPlatformScanTrend();
  const { data: companiesData, isLoading: companiesLoading } = useListCompanies({ limit: 5 });

  if (statsLoading || revenueLoading || scanLoading || companiesLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Platform Dashboard" description="Real-time metrics across all tenant instances" />
        <CardGridSkeleton cards={6} />
        <CardGridSkeleton cards={2} />
        <TableSkeleton rows={5} />
      </div>
    );
  }

  const totalCompanies = stats?.totalCompanies || 0;
  const activeCompanies = stats?.activeCompanies || 0;
  const revenue = stats?.revenue;
  const revenueAvailable = !!revenue?.available && revenue.monthlyRecurringMinor != null && !!revenue.currency;
  const unavailable = <span className="text-xl font-semibold text-muted-foreground">Unavailable</span>;
  const mrrValue = revenueAvailable ? formatMinor(revenue!.monthlyRecurringMinor!, revenue!.currency!) : unavailable;
  const arrValue = revenueAvailable ? formatMinor(revenue!.monthlyRecurringMinor! * 12, revenue!.currency!) : unavailable;
  const totalCaptures = stats?.totalCaptures || 0;
  const cardScans = stats?.totalScans || 0;
  const revenueReason = revenueAvailable
    ? `${revenue!.countedSubscriptions} priced subscription${revenue!.countedSubscriptions === 1 ? "" : "s"}`
    : REVENUE_REASON[revenue?.reason ?? ""] ?? "Not configured";

  const subStatusData = (stats?.subscriptions?.byStatus ?? [])
    .filter((s) => s.count > 0)
    .map((s) => ({ name: STATUS_LABEL[s.status] ?? s.status, value: s.count, status: s.status }));

  const trendPoints = revenueTrend?.available ? revenueTrend.points : [];
  const scanPoints = scanData ?? [];

  return (
    <div className="space-y-6" data-testid="platform-dashboard">
      <PageHeader
        title="Platform Dashboard"
        description="Real-time metrics across all tenant instances"
        actions={<StatusBadge tone="success">System Operational</StatusBadge>}
      />

      {/* Two, then three cards to a row — the layout of the Analytics figures. Six to a row left
          each card too narrow for its label and for a currency amount. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="dashboard-metrics">
        <MetricCard
          label="Total Companies"
          value={totalCompanies.toLocaleString()}
          icon={Building2}
          footer={`${activeCompanies.toLocaleString()} with full access`}
        />
        <div data-testid="dashboard-total-users">
          <MetricCard
            label="Total Users"
            value={(stats?.totalUsers || 0).toLocaleString()}
            icon={Users}
            footer="Company users across all tenants"
            className="h-full"
          />
        </div>
        <div data-testid="dashboard-mrr">
          <MetricCard label="MRR" value={mrrValue} icon={DollarSign} footer={revenueReason} className="h-full" />
        </div>
        <div data-testid="dashboard-arr">
          <MetricCard label="ARR" value={arrValue} icon={Activity} footer={revenueAvailable ? "MRR × 12" : revenueReason} className="h-full" />
        </div>
        <MetricCard
          label="Total Leads"
          value={(stats?.totalLeads || 0).toLocaleString()}
          icon={Camera}
          footer="Captured system-wide"
        />
        {/* Every capture, with the OCR card scans among them named separately: a QR code, an
            NFC tap or a contact typed in is a capture, but not a card scan. */}
        <div data-testid="dashboard-total-captures">
          <MetricCard
            label="Total Captures"
            value={totalCaptures.toLocaleString()}
            icon={Zap}
            tone="inverse"
            className="h-full bg-sidebar border-sidebar-border"
            footer={
              <span data-testid="dashboard-card-scans">
                {cardScans.toLocaleString()} card {cardScans === 1 ? "scan" : "scans"} sent for OCR
              </span>
            }
          />
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-7">
        <Card className="md:col-span-5 shadow-sm" data-testid="dashboard-revenue-trend">
          <CardHeader>
            <CardTitle>Recurring Revenue</CardTitle>
            <CardDescription>Monthly recurring revenue over time</CardDescription>
          </CardHeader>
          <CardContent>
            {revenueTrend?.available && trendPoints.length > 0 ? (
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trendPoints} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorMrr" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" tickFormatter={(val) => format(new Date(val), "MMM d")} stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                    <RechartsTooltip
                      contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", color: "hsl(var(--foreground))" }}
                      labelFormatter={(val) => format(new Date(val), "MMM d, yyyy")}
                    />
                    <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} fillOpacity={1} fill="url(#colorMrr)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-[300px]">
                <EmptyState
                  icon={Info}
                  title="Revenue history unavailable"
                  description={REVENUE_REASON[revenueTrend?.reason ?? ""] ?? "Revenue history is not recorded by this system."}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="md:col-span-2 shadow-sm flex flex-col" data-testid="dashboard-subscription-status">
          <CardHeader>
            <CardTitle>Subscription Status</CardTitle>
            <CardDescription>Canonical subscription state per company</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col items-center justify-center pb-6">
            {subStatusData.length === 0 ? (
              <EmptyState icon={Building2} title="No subscriptions" description="Subscriptions appear once companies are onboarded." />
            ) : (
              <>
                <div className="h-[220px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={subStatusData} cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={4} dataKey="value">
                        {subStatusData.map((entry) => (
                          <Cell key={entry.status} fill={STATUS_COLORS[entry.status] ?? "hsl(var(--muted-foreground))"} />
                        ))}
                      </Pie>
                      <RechartsTooltip contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", color: "hsl(var(--foreground))" }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                {/* The list is the legend: each status carries the colour of its ring segment, its
                    name and its count. (A separate chart legend used to wrap over these rows.) */}
                <ul className="mt-2 w-full space-y-1 text-sm" data-testid="dashboard-status-legend">
                  {subStatusData.map((s) => (
                    <li key={s.status} className="flex items-center justify-between gap-3" data-testid={`status-count-${s.status}`}>
                      <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: STATUS_COLORS[s.status] ?? "hsl(var(--muted-foreground))" }} aria-hidden="true" />
                        <span className="truncate">{s.name}</span>
                      </span>
                      <span className="font-medium tabular-nums">{s.value}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm" data-testid="dashboard-scan-trend">
        <CardHeader>
          <CardTitle>Card Scan Volume</CardTitle>
          <CardDescription>Card scans sent for OCR per day across all tenants (last 30 days). Captures saved without OCR are not included.</CardDescription>
        </CardHeader>
        <CardContent>
          {scanPoints.length === 0 ? (
            <EmptyState icon={Zap} title="No card scans yet" description="Daily counts appear once tenants start scanning cards." />
          ) : (
            <div className="h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={scanPoints} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tickFormatter={(val) => format(new Date(val), "MMM d")} stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
                  <RechartsTooltip
                    contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", color: "hsl(var(--foreground))" }}
                    labelFormatter={(val) => format(new Date(val), "MMM d, yyyy")}
                  />
                  <Area type="monotone" dataKey="value" stroke="hsl(var(--chart-2))" strokeWidth={2} fillOpacity={0.15} fill="hsl(var(--chart-2))" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6">
        {/* min-w-0: the wide table scrolls inside the card instead of widening the page on phones. */}
        <Card className="shadow-sm min-w-0">
          <CardHeader>
            <div className="flex justify-between items-center gap-3">
              <div className="min-w-0">
                <CardTitle>Recent Companies</CardTitle>
                <CardDescription>The five tenants onboarded most recently</CardDescription>
              </div>
              <Link href="/platform/companies" className="shrink-0 whitespace-nowrap text-sm text-primary hover:underline">View all</Link>
            </div>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader className="bg-secondary/50">
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead className="text-right">Users</TableHead>
                    <TableHead className="text-center">Subscription</TableHead>
                    <TableHead className="text-right">Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {companiesData?.companies.map((company) => {
                    const status = company.subscription?.status;
                    return (
                      <TableRow key={company.id} className="hover:bg-muted/50">
                        <TableCell className="font-medium">{company.name}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="capitalize text-xs font-normal">
                            {company.subscription?.plan ?? "—"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">{company.userCount ?? 0}</TableCell>
                        <TableCell className="text-center">
                          <StatusBadge tone={statusTone(status)} showDot>
                            {status ? STATUS_LABEL[status] ?? status : "No subscription"}
                          </StatusBadge>
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground text-sm">
                          {format(new Date(company.createdAt), "MMM d, yyyy")}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {(!companiesData?.companies || companiesData.companies.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={5} className="p-4">
                        <EmptyState icon={Building2} title="No companies found" description="Companies will appear here once they are onboarded." />
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
