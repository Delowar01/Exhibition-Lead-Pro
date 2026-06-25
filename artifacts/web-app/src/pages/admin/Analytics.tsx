import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useGetAnalyticsScopeOptions,
  useGetAnalyticsOverview,
  useGetDepartmentAnalytics,
  useGetTeamAnalytics,
  useGetEmployeeAnalytics,
  getGetAnalyticsOverviewQueryKey,
  getGetDepartmentAnalyticsQueryKey,
  getGetTeamAnalyticsQueryKey,
  getGetEmployeeAnalyticsQueryKey,
  type ScopedAnalytics,
} from "@workspace/api-client-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { format, parseISO, subDays } from "date-fns";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  ScanLine,
  Contact as ContactIcon,
  Target,
  DollarSign,
  Trophy,
  CalendarClock,
  Users,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

type ScopeKind = "company" | "department" | "team" | "employee";

const DATE_PRESETS: { label: string; days: number }[] = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function formatUsd(n: number): string {
  return USD.format(n);
}

function Delta({ value, unit = "%" }: { value: number | null; unit?: "%" | "pt" }) {
  if (value === null || value === undefined) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const positive = value > 0;
  const negative = value < 0;
  const Icon = positive ? TrendingUp : negative ? TrendingDown : Minus;
  const color = positive ? "text-emerald-600" : negative ? "text-rose-600" : "text-muted-foreground";
  const sign = value > 0 ? "+" : "";
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${color}`}>
      <Icon className="h-3 w-3" />
      {sign}
      {value}
      {unit === "%" ? "%" : " pts"}
    </span>
  );
}

function KpiCard({
  title,
  value,
  delta,
  icon: Icon,
  hint,
}: {
  title: string;
  value: string;
  delta?: number | null;
  deltaUnit?: "%" | "pt";
  icon: React.ElementType;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{title}</span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="mt-2 text-2xl font-bold tracking-tight">{value}</div>
        <div className="mt-1 flex items-center gap-2">
          {delta !== undefined && <Delta value={delta ?? null} />}
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const FUNNEL_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
  "hsl(var(--muted-foreground))",
];

function DashboardBody({ data }: { data: ScopedAnalytics }) {
  const { kpis, deltas } = data;
  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard title="Scans" value={String(kpis.scans)} delta={deltas.scans} icon={ScanLine} />
        <KpiCard title="New Contacts" value={String(kpis.newContacts)} delta={deltas.newContacts} icon={ContactIcon} />
        <KpiCard title="New Leads" value={String(kpis.newLeads)} delta={deltas.newLeads} icon={Target} />
        <KpiCard
          title="Conversion Rate"
          value={`${kpis.conversionRate}%`}
          delta={deltas.conversionRate}
          icon={Trophy}
          hint={`${kpis.wonCount}W / ${kpis.lostCount}L`}
        />
        <KpiCard title="Open Pipeline" value={formatUsd(kpis.pipelineValue)} icon={DollarSign} hint="point-in-time" />
        <KpiCard title="Won Value" value={formatUsd(kpis.wonValue)} icon={DollarSign} />
        <KpiCard title="Lost Value" value={formatUsd(kpis.lostValue)} icon={DollarSign} />
        <KpiCard
          title="Follow-up Adherence"
          value={`${kpis.followUpAdherence}%`}
          icon={CalendarClock}
          hint={`${kpis.followUpsOverdueCount} overdue / ${kpis.followUpsDueCount} due`}
        />
      </div>

      {/* Trend */}
      <Card>
        <CardHeader>
          <CardTitle>Activity Trend</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.trend} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="aScan" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="aLead" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--chart-2))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--chart-2))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(val) => format(parseISO(val), "MMM d")}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))" }}
                  labelFormatter={(val) => format(parseISO(String(val)), "MMM d, yyyy")}
                />
                <Area type="monotone" dataKey="scans" name="Scans" stroke="hsl(var(--chart-1))" strokeWidth={2} fillOpacity={1} fill="url(#aScan)" />
                <Area type="monotone" dataKey="leads" name="Leads" stroke="hsl(var(--chart-2))" strokeWidth={2} fillOpacity={1} fill="url(#aLead)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Funnel */}
        <Card>
          <CardHeader>
            <CardTitle>Pipeline Funnel</CardTitle>
          </CardHeader>
          <CardContent>
            {data.funnel.every((f) => f.count === 0) ? (
              <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">No pipeline data</div>
            ) : (
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.funnel} layout="vertical" margin={{ top: 0, right: 16, left: 16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                    <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
                    <YAxis type="category" dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} width={90} />
                    <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))" }} cursor={{ fill: "hsl(var(--muted))", opacity: 0.3 }} />
                    <Bar dataKey="count" name="Leads" radius={[0, 4, 4, 0]}>
                      {data.funnel.map((_, i) => (
                        <Cell key={i} fill={FUNNEL_COLORS[i % FUNNEL_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Source mix */}
        <Card>
          <CardHeader>
            <CardTitle>Capture Source</CardTitle>
          </CardHeader>
          <CardContent>
            {data.sourceMix.length === 0 ? (
              <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">No contacts in range</div>
            ) : (
              <div className="space-y-4 py-2">
                {(() => {
                  const total = data.sourceMix.reduce((s, x) => s + x.count, 0);
                  return data.sourceMix.map((x, i) => {
                    const pct = total === 0 ? 0 : Math.round((x.count / total) * 100);
                    return (
                      <div key={x.source}>
                        <div className="mb-1 flex items-center justify-between text-sm">
                          <span className="font-medium">{x.source}</span>
                          <span className="text-muted-foreground">
                            {x.count} ({pct}%)
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: FUNNEL_COLORS[i % FUNNEL_COLORS.length] }} />
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Top performers */}
        <Card>
          <CardHeader>
            <CardTitle>Top Performers</CardTitle>
          </CardHeader>
          <CardContent>
            {data.topPerformers.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">No activity yet</div>
            ) : (
              <div className="space-y-3">
                {data.topPerformers.map((p, i) => (
                  <div key={p.userId} className="flex items-center gap-3">
                    <span className="w-5 text-sm font-semibold text-muted-foreground">{i + 1}</span>
                    <Avatar className="h-8 w-8">
                      {p.avatarUrl ? <AvatarImage src={p.avatarUrl} alt={p.userName} /> : null}
                      <AvatarFallback className="text-xs">{initials(p.userName)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{p.userName}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.leads} leads · {p.won} won · {p.scans} scans
                      </div>
                    </div>
                    <span className="text-sm font-medium">{formatUsd(p.pipelineValue)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent activity */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {data.recentActivity.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">No recent activity</div>
            ) : (
              <div className="space-y-3">
                {data.recentActivity.map((a) => (
                  <div key={a.id} className="flex items-start gap-3">
                    <div className="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-primary" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{a.title}</div>
                      {a.subtitle && <div className="truncate text-xs text-muted-foreground">{a.subtitle}</div>}
                    </div>
                    <span className="whitespace-nowrap text-xs text-muted-foreground">{format(parseISO(a.at), "MMM d")}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function AdminAnalytics() {
  const { user } = useAuth();
  const isManager = user?.role === "primary_admin" || user?.role === "admin";

  const [scopeKind, setScopeKind] = React.useState<ScopeKind>(isManager ? "company" : "employee");
  const [scopeId, setScopeId] = React.useState<number | null>(isManager ? null : (user?.id ?? null));
  const [rangeDays, setRangeDays] = React.useState<number>(30);

  const dateTo = format(new Date(), "yyyy-MM-dd");
  const dateFrom = format(subDays(new Date(), rangeDays - 1), "yyyy-MM-dd");

  const { data: scopeOptions } = useGetAnalyticsScopeOptions();

  // Default an employee (non-manager) to their own scope.
  React.useEffect(() => {
    if (!isManager && scopeOptions && scopeId === null && scopeOptions.employees.length > 0) {
      setScopeId(scopeOptions.employees[0].id);
    }
  }, [isManager, scopeOptions, scopeId]);

  const overviewParams = { dateFrom, dateTo };
  const deptParams = { id: scopeId ?? 0, dateFrom, dateTo };
  const teamParams = { id: scopeId ?? 0, dateFrom, dateTo };
  const employeeParams = { id: scopeId ?? 0, dateFrom, dateTo };

  const overview = useGetAnalyticsOverview(overviewParams, {
    query: { enabled: scopeKind === "company", queryKey: getGetAnalyticsOverviewQueryKey(overviewParams) },
  });
  const department = useGetDepartmentAnalytics(deptParams, {
    query: {
      enabled: scopeKind === "department" && scopeId != null,
      queryKey: getGetDepartmentAnalyticsQueryKey(deptParams),
    },
  });
  const team = useGetTeamAnalytics(teamParams, {
    query: { enabled: scopeKind === "team" && scopeId != null, queryKey: getGetTeamAnalyticsQueryKey(teamParams) },
  });
  const employee = useGetEmployeeAnalytics(employeeParams, {
    query: {
      enabled: scopeKind === "employee" && scopeId != null,
      queryKey: getGetEmployeeAnalyticsQueryKey(employeeParams),
    },
  });

  const active =
    scopeKind === "company"
      ? overview
      : scopeKind === "department"
        ? department
        : scopeKind === "team"
          ? team
          : employee;

  const data = active.data as ScopedAnalytics | undefined;

  const handleScopeChange = (raw: string) => {
    if (raw === "company") {
      setScopeKind("company");
      setScopeId(null);
      return;
    }
    const [kind, idStr] = raw.split(":");
    setScopeKind(kind as ScopeKind);
    setScopeId(parseInt(idStr));
  };

  const currentScopeValue = scopeKind === "company" ? "company" : `${scopeKind}:${scopeId}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Executive Dashboard</h1>
          {data && <p className="mt-1 text-sm text-muted-foreground">{data.scope.name} · {data.headcount} {data.headcount === 1 ? "person" : "people"}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select value={currentScopeValue} onValueChange={handleScopeChange}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Select scope" />
            </SelectTrigger>
            <SelectContent>
              {scopeOptions?.canViewCompany && (
                <SelectItem value="company">Company (All)</SelectItem>
              )}
              {scopeOptions && scopeOptions.departments.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Departments</SelectLabel>
                  {scopeOptions.departments.map((d) => (
                    <SelectItem key={`dept-${d.id}`} value={`department:${d.id}`}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {scopeOptions && scopeOptions.teams.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Teams</SelectLabel>
                  {scopeOptions.teams.map((t) => (
                    <SelectItem key={`team-${t.id}`} value={`team:${t.id}`}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {scopeOptions && scopeOptions.employees.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Employees</SelectLabel>
                  {scopeOptions.employees.map((e) => (
                    <SelectItem key={`emp-${e.id}`} value={`employee:${e.id}`}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>

          <Select value={String(rangeDays)} onValueChange={(v) => setRangeDays(parseInt(v))}>
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_PRESETS.map((p) => (
                <SelectItem key={p.days} value={String(p.days)}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {active.isError ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-10 text-sm text-muted-foreground">
            <Users className="h-5 w-5" />
            You do not have access to this view, or it could not be loaded.
          </CardContent>
        </Card>
      ) : active.isLoading || !data ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
          <Skeleton className="h-[300px] w-full" />
        </div>
      ) : (
        <DashboardBody data={data} />
      )}
    </div>
  );
}
