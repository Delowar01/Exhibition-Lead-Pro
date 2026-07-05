import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  useGetUnifiedDashboard,
  getGetUnifiedDashboardQueryKey,
  useGetAnalyticsScopeOptions,
  useGetLeadIntelligence,
  getGetLeadIntelligenceQueryKey,
  useGetLeadsByEvent,
  getGetLeadsByEventQueryKey,
  useListSavedSearches,
  useCreateSavedSearch,
  useDeleteSavedSearch,
  type UnifiedDashboard,
  type GetUnifiedDashboardScopeType,
  type LeadIntelligence,
  type LeadsByEventItem,
} from "@workspace/api-client-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  ComposedChart,
  Pie,
  PieChart,
  Legend,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { format, parseISO, subDays } from "date-fns";
import { Link } from "wouter";
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
  Flame,
  Thermometer,
  Snowflake,
  Sparkles,
  AlertCircle,
  Download,
  BookmarkPlus,
  Bookmark,
  Trash2,
  Layers,
  CheckCircle2,
  Copy,
  CalendarCheck,
  ArrowRight,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

type ScopeKind = "company" | "department" | "team" | "employee";

const DATE_PRESETS: { label: string; days: number }[] = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const formatUsd = (n: number) => USD.format(n);

const CHART_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
  "hsl(var(--muted-foreground))",
];

function Delta({ value }: { value: number | null }) {
  if (value === null || value === undefined) return <span className="text-xs text-muted-foreground">—</span>;
  const positive = value > 0;
  const negative = value < 0;
  const Icon = positive ? TrendingUp : negative ? TrendingDown : Minus;
  const color = positive ? "text-emerald-600" : negative ? "text-rose-600" : "text-muted-foreground";
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${color}`}>
      <Icon className="h-3 w-3" />
      {value > 0 ? "+" : ""}
      {value}%
    </span>
  );
}

function KpiCard({
  title,
  value,
  delta,
  icon: Icon,
  hint,
  accent,
}: {
  title: string;
  value: string;
  delta?: number | null;
  icon: React.ElementType;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <Card className={accent ? "bg-primary text-primary-foreground border-primary shadow-md" : "shadow-sm"}>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <span className={`text-sm ${accent ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{title}</span>
          <Icon className={`h-4 w-4 ${accent ? "text-primary-foreground" : "text-muted-foreground"}`} />
        </div>
        <div className="mt-2 text-2xl font-bold tracking-tight">{value}</div>
        <div className="mt-1 flex items-center gap-2">
          {delta !== undefined && <Delta value={delta ?? null} />}
          {hint && <span className={`text-xs ${accent ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{hint}</span>}
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

// Neutralize CSV formula injection: prefix risky leading chars with a single quote.
function csvCell(value: string | number): string {
  const s = String(value ?? "");
  const risky = /^[=+\-@\t\r]/.test(s);
  const escaped = (risky ? "'" + s : s).replace(/"/g, '""');
  return `"${escaped}"`;
}

function buildDashboardCsv(d: UnifiedDashboard): string {
  const rows: string[][] = [];
  rows.push(["Card Scanner Pro — Dashboard Summary"]);
  rows.push(["Scope", d.scope.name]);
  rows.push(["Date range", `${d.dateRange.from} to ${d.dateRange.to}`]);
  rows.push(["Headcount", String(d.headcount)]);
  rows.push([]);
  rows.push(["Lead KPIs", "Value"]);
  const k = d.leadKpis;
  rows.push(["Total leads", String(k.total)]);
  rows.push(["New today", String(k.today)]);
  rows.push(["New this week", String(k.thisWeek)]);
  rows.push(["New this month", String(k.thisMonth)]);
  rows.push(["New (range)", String(k.new)]);
  rows.push(["Qualified", String(k.qualified)]);
  rows.push(["Converted", String(k.converted)]);
  rows.push(["Lost", String(k.lost)]);
  rows.push(["Duplicates", String(k.duplicate)]);
  rows.push(["AI queue", String(k.aiQueue)]);
  rows.push(["Meetings scheduled", String(k.meetingsScheduled)]);
  rows.push(["Follow-ups due", String(k.followUpsDue)]);
  rows.push(["Conversion rate %", String(k.conversionRate)]);
  rows.push([]);
  rows.push(["Pipeline KPIs", "Value"]);
  rows.push(["Scans", String(d.kpis.scans)]);
  rows.push(["New contacts", String(d.kpis.newContacts)]);
  rows.push(["Open pipeline (USD)", String(d.kpis.pipelineValue)]);
  rows.push(["Won value (USD)", String(d.kpis.wonValue)]);
  rows.push(["Lost value (USD)", String(d.kpis.lostValue)]);
  rows.push([]);
  rows.push(["Industry", "Contacts"]);
  d.industryDistribution.forEach((i) => rows.push([i.label, String(i.count)]));
  rows.push([]);
  rows.push(["Country", "Contacts"]);
  d.countryDistribution.forEach((i) => rows.push([i.label, String(i.count)]));
  rows.push([]);
  rows.push(["Month", "Leads", "Won", "Contacts", "Scans"]);
  d.monthlyTrend.forEach((m) => rows.push([m.label, String(m.leads), String(m.won), String(m.contacts), String(m.scans)]));
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

function DistributionCard({
  title,
  description,
  items,
  emptyText,
}: {
  title: string;
  description: string;
  items: { label: string; count: number }[];
  emptyText: string;
}) {
  const total = items.reduce((s, x) => s + x.count, 0);
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">{emptyText}</div>
        ) : (
          <div className="space-y-3 py-1">
            {items.map((x, i) => {
              const pct = total === 0 ? 0 : Math.round((x.count / total) * 100);
              return (
                <div key={x.label}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium truncate pr-2">{x.label}</span>
                    <span className="text-muted-foreground whitespace-nowrap">
                      {x.count} ({pct}%)
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface ViewPayload {
  scopeKind?: ScopeKind;
  scopeId?: number | null;
  rangeDays?: number;
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const isManager = user?.role === "primary_admin" || user?.role === "admin";

  const [scopeKind, setScopeKind] = React.useState<ScopeKind>(isManager ? "company" : "employee");
  const [scopeId, setScopeId] = React.useState<number | null>(isManager ? null : (user?.id ?? null));
  const [rangeDays, setRangeDays] = React.useState<number>(30);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [viewName, setViewName] = React.useState("");

  const dateTo = format(new Date(), "yyyy-MM-dd");
  const dateFrom = format(subDays(new Date(), rangeDays - 1), "yyyy-MM-dd");

  const { data: scopeOptions } = useGetAnalyticsScopeOptions();

  // Non-managers default to their own employee scope once options load.
  React.useEffect(() => {
    if (!isManager && scopeOptions && scopeId === null && scopeOptions.employees.length > 0) {
      setScopeId(scopeOptions.employees[0].id);
    }
  }, [isManager, scopeOptions, scopeId]);

  const params = {
    scopeType: scopeKind as GetUnifiedDashboardScopeType,
    ...(scopeKind === "company" ? {} : { id: scopeId ?? 0 }),
    dateFrom,
    dateTo,
  };
  const dashboardQuery = useGetUnifiedDashboard(params, {
    query: {
      enabled: scopeKind === "company" || scopeId != null,
      queryKey: getGetUnifiedDashboardQueryKey(params),
    },
  });
  const data = dashboardQuery.data;

  // AI intelligence + event performance are company-wide; show only on company scope.
  const showCompanyWide = scopeKind === "company";
  const { data: intel } = useGetLeadIntelligence({
    query: { enabled: showCompanyWide, queryKey: getGetLeadIntelligenceQueryKey() },
  });
  const { data: leadsByEvent } = useGetLeadsByEvent({
    query: { enabled: showCompanyWide, queryKey: getGetLeadsByEventQueryKey() },
  });

  // Saved dashboard views (reuse saved_searches: entityType "dashboard", kind "view").
  const { data: savedViewsData } = useListSavedSearches({ entityType: "dashboard", kind: "view" });
  const savedViews = savedViewsData?.savedSearches;
  const createView = useCreateSavedSearch();
  const deleteView = useDeleteSavedSearch();

  const applyView = (payload: unknown) => {
    const p = (payload ?? {}) as ViewPayload;
    if (p.scopeKind) setScopeKind(p.scopeKind);
    setScopeId(p.scopeId ?? null);
    if (p.rangeDays) setRangeDays(p.rangeDays);
  };

  const saveView = () => {
    const name = viewName.trim();
    if (!name) return;
    createView.mutate(
      { data: { name, kind: "view", entityType: "dashboard", payload: { scopeKind, scopeId, rangeDays } } },
      {
        onSuccess: () => {
          setSaveOpen(false);
          setViewName("");
        },
      },
    );
  };

  const exportCsv = () => {
    if (!data) return;
    const csv = buildDashboardCsv(data);
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dashboard-${data.scope.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${dateTo}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

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
      {/* Header + controls */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Lead Dashboard</h1>
          {data && (
            <p className="mt-1 text-sm text-muted-foreground">
              {data.scope.name} · {data.headcount} {data.headcount === 1 ? "person" : "people"} ·{" "}
              {format(parseISO(data.dateRange.from), "MMM d")} – {format(parseISO(data.dateRange.to), "MMM d, yyyy")}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={currentScopeValue} onValueChange={handleScopeChange}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Select scope" />
            </SelectTrigger>
            <SelectContent>
              {scopeOptions?.canViewCompany && <SelectItem value="company">Company (All)</SelectItem>}
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
            <SelectTrigger className="w-[140px]">
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

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5">
                <Bookmark className="h-4 w-4" />
                Views
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Saved views</DropdownMenuLabel>
              {(!savedViews || savedViews.length === 0) && (
                <div className="px-2 py-3 text-xs text-muted-foreground">No saved views yet.</div>
              )}
              {savedViews?.map((v) => (
                <div key={v.id} className="flex items-center justify-between gap-1 px-1">
                  <DropdownMenuItem className="flex-1" onSelect={() => applyView(v.payload)}>
                    {v.name}
                  </DropdownMenuItem>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.preventDefault();
                      deleteView.mutate({ id: v.id });
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setSaveOpen(true)}>
                <BookmarkPlus className="mr-2 h-4 w-4" />
                Save current view
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button variant="outline" size="sm" className="gap-1.5" onClick={exportCsv} disabled={!data}>
            <Download className="h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      {dashboardQuery.isError ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-10 text-sm text-muted-foreground">
            <Users className="h-5 w-5" />
            You do not have access to this view, or it could not be loaded.
          </CardContent>
        </Card>
      ) : dashboardQuery.isLoading || !data ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
          <Skeleton className="h-[320px] w-full" />
        </div>
      ) : (
        <DashboardBody
          data={data}
          intel={showCompanyWide ? intel : undefined}
          leadsByEvent={showCompanyWide ? leadsByEvent : undefined}
        />
      )}

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save dashboard view</DialogTitle>
            <DialogDescription>Saves the current scope and date range as a reusable view.</DialogDescription>
          </DialogHeader>
          <Input
            placeholder="View name (e.g. Sales — last 30 days)"
            value={viewName}
            onChange={(e) => setViewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveView()}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveView} disabled={!viewName.trim() || createView.isPending}>
              Save view
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DashboardBody({
  data,
  intel,
  leadsByEvent,
}: {
  data: UnifiedDashboard;
  intel?: LeadIntelligence;
  leadsByEvent?: LeadsByEventItem[];
}) {
  const k = data.leadKpis;
  const breakdown = intel?.temperatureBreakdown ?? { hot: 0, warm: 0, cold: 0 };
  const tempData = [
    { name: "Hot", value: breakdown.hot, color: "#ef4444" },
    { name: "Warm", value: breakdown.warm, color: "#f59e0b" },
    { name: "Cold", value: breakdown.cold, color: "#3b82f6" },
  ];
  const hasTempData = breakdown.hot + breakdown.warm + breakdown.cold > 0;
  const hotLeads = intel?.hotLeads ?? [];
  const followUpsDue = intel?.followUpsDue ?? [];

  const tempBadge = (t?: string | null) => {
    switch (t) {
      case "hot":
        return { cls: "bg-red-100 text-red-700 border-red-200", icon: <Flame className="h-3 w-3" />, label: "Hot" };
      case "warm":
        return { cls: "bg-amber-100 text-amber-700 border-amber-200", icon: <Thermometer className="h-3 w-3" />, label: "Warm" };
      case "cold":
        return { cls: "bg-blue-100 text-blue-700 border-blue-200", icon: <Snowflake className="h-3 w-3" />, label: "Cold" };
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Lead KPI grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard title="Total Leads" value={k.total.toLocaleString()} icon={Target} hint={`${k.new} new in range`} />
        <KpiCard title="New Today" value={k.today.toLocaleString()} icon={CalendarClock} hint={`${k.thisWeek} this week`} />
        <KpiCard title="Qualified" value={k.qualified.toLocaleString()} icon={CheckCircle2} hint={`${k.thisMonth} new this month`} />
        <KpiCard title="Conversion Rate" value={`${k.conversionRate}%`} delta={data.deltas.conversionRate} icon={Trophy} accent hint={`${k.converted} won`} />
        <KpiCard title="Scans" value={data.kpis.scans.toLocaleString()} delta={data.deltas.scans} icon={ScanLine} />
        <KpiCard title="New Contacts" value={data.kpis.newContacts.toLocaleString()} delta={data.deltas.newContacts} icon={ContactIcon} />
        <KpiCard title="Open Pipeline" value={formatUsd(data.kpis.pipelineValue)} icon={DollarSign} hint="point-in-time" />
        <KpiCard title="Won Value" value={formatUsd(data.kpis.wonValue)} icon={DollarSign} hint={`${formatUsd(data.kpis.lostValue)} lost`} />
      </div>

      {/* Secondary KPI strip */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <MiniStat label="AI Queue" value={k.aiQueue} icon={Sparkles} />
        <MiniStat label="Duplicates" value={k.duplicate} icon={Copy} />
        <MiniStat label="Meetings" value={k.meetingsScheduled} icon={CalendarCheck} />
        <MiniStat label="Follow-ups Due" value={k.followUpsDue} icon={CalendarClock} />
        <MiniStat label="Lost" value={k.lost} icon={TrendingDown} />
        <MiniStat label="Headcount" value={data.headcount} icon={Users} />
      </div>

      {/* Activity trend */}
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Activity Trend</CardTitle>
          <CardDescription>Scans vs leads over the selected period</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.trend} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="dScan" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="dLead" x1="0" y1="0" x2="0" y2="1">
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
                <RechartsTooltip
                  contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))" }}
                  labelFormatter={(val) => format(parseISO(String(val)), "MMM d, yyyy")}
                />
                <Legend />
                <Area type="monotone" dataKey="scans" name="Scans" stroke="hsl(var(--chart-1))" strokeWidth={2} fillOpacity={1} fill="url(#dScan)" />
                <Area type="monotone" dataKey="leads" name="Leads" stroke="hsl(var(--chart-2))" strokeWidth={2} fillOpacity={1} fill="url(#dLead)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Funnel + monthly trend */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Pipeline Funnel</CardTitle>
            <CardDescription>Leads by stage (point-in-time)</CardDescription>
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
                    <RechartsTooltip contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))" }} cursor={{ fill: "hsl(var(--muted))", opacity: 0.3 }} />
                    <Bar dataKey="count" name="Leads" radius={[0, 4, 4, 0]}>
                      {data.funnel.map((_, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Monthly Growth</CardTitle>
            <CardDescription>Leads, contacts &amp; scans over 12 months</CardDescription>
          </CardHeader>
          <CardContent>
            {data.monthlyTrend.every((m) => m.leads + m.contacts + m.scans === 0) ? (
              <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">No monthly data</div>
            ) : (
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={data.monthlyTrend} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} minTickGap={12} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
                    <RechartsTooltip contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))" }} />
                    <Legend />
                    <Bar dataKey="contacts" name="Contacts" fill="hsl(var(--chart-3))" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="leads" name="Leads" fill="hsl(var(--chart-2))" radius={[3, 3, 0, 0]} />
                    <Line type="monotone" dataKey="won" name="Won" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Distributions + source */}
      <div className="grid gap-6 lg:grid-cols-3">
        <DistributionCard title="By Industry" description="Contacts grouped by industry" items={data.industryDistribution} emptyText="No contacts in range" />
        <DistributionCard title="By Country" description="Contacts grouped by country" items={data.countryDistribution} emptyText="No contacts in range" />
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Capture Source</CardTitle>
            <CardDescription>How contacts were captured</CardDescription>
          </CardHeader>
          <CardContent>
            {data.sourceMix.length === 0 ? (
              <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">No contacts in range</div>
            ) : (
              <div className="space-y-3 py-1">
                {(() => {
                  const total = data.sourceMix.reduce((s, x) => s + x.count, 0);
                  return data.sourceMix.map((x, i) => {
                    const pct = total === 0 ? 0 : Math.round((x.count / total) * 100);
                    return (
                      <div key={x.source}>
                        <div className="mb-1 flex items-center justify-between text-sm">
                          <span className="font-medium capitalize">{x.source}</span>
                          <span className="text-muted-foreground">
                            {x.count} ({pct}%)
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
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

      {/* Top performers + recent activity */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Top Performers</CardTitle>
            <CardDescription>By pipeline contribution</CardDescription>
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

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Recent Activity</CardTitle>
            <CardDescription>Latest events in this scope</CardDescription>
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

      {/* AI Lead Intelligence (company-wide) */}
      {intel && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="shadow-sm flex flex-col">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Thermometer className="h-4 w-4 text-primary" />
                <CardTitle className="text-lg">Lead Temperature</CardTitle>
              </div>
              <CardDescription>AI-scored intent (company-wide)</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col items-center justify-center pb-6">
              {hasTempData ? (
                <div className="h-[220px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={tempData} cx="50%" cy="50%" innerRadius={55} outerRadius={78} paddingAngle={5} dataKey="value">
                        {tempData.map((entry) => (
                          <Cell key={`cell-${entry.name}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <RechartsTooltip formatter={(value, name) => [`${value} contacts`, name]} contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))" }} />
                      <Legend verticalAlign="bottom" height={36} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-[220px] w-full flex flex-col items-center justify-center text-center text-muted-foreground gap-2">
                  <Sparkles className="h-8 w-8 opacity-40" />
                  <p className="text-sm">No AI-scored leads yet.</p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader>
              <div className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-primary" />
                <CardTitle className="text-lg">Follow-ups Due</CardTitle>
              </div>
              <CardDescription>Due today or overdue</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {followUpsDue.length === 0 && <div className="text-sm text-muted-foreground text-center py-6">You're all caught up.</div>}
                {followUpsDue.map((contact) => {
                  const overdue = contact.followUpDate ? contact.followUpDate < format(new Date(), "yyyy-MM-dd") : false;
                  return (
                    <div key={contact.id} className="flex items-center justify-between border-b border-border pb-3 last:border-0 last:pb-0">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold text-xs shrink-0">
                          {contact.firstName?.charAt(0)}
                          {contact.lastName?.charAt(0)}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">
                            {contact.firstName} {contact.lastName}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">{contact.contactCompany || "No company"}</p>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <span className={`inline-flex items-center gap-1 text-xs ${overdue ? "text-red-600" : "text-muted-foreground"}`}>
                          {overdue && <AlertCircle className="h-3 w-3" />}
                          {contact.followUpDate ? format(parseISO(contact.followUpDate), "MMM d") : "—"}
                        </span>
                        <Link href={`/admin/contacts/${contact.id}`} className="text-xs text-primary hover:underline">
                          View →
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Flame className="h-4 w-4 text-red-500" />
                <CardTitle className="text-lg">Hot Leads</CardTitle>
              </div>
              <CardDescription>Highest AI scores</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {hotLeads.length === 0 && <div className="text-sm text-muted-foreground text-center py-6">No scored leads yet.</div>}
                {hotLeads.map((lead) => {
                  const badge = tempBadge(lead.leadTemperature);
                  return (
                    <Link key={lead.id} href={`/admin/contacts/${lead.id}`} className="flex gap-3 items-start group">
                      <div className="flex flex-col items-center justify-center w-10 h-10 rounded-lg bg-primary/10 text-primary shrink-0">
                        <span className="text-sm font-bold leading-none">{lead.leadScore ?? "—"}</span>
                        <span className="text-[9px] uppercase tracking-wide opacity-70">score</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium truncate group-hover:text-primary">
                            {lead.firstName} {lead.lastName}
                          </p>
                          {badge && (
                            <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0 text-[10px] font-normal ${badge.cls}`}>
                              {badge.icon}
                              {badge.label}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {[lead.jobTitle, lead.contactCompany].filter(Boolean).join(" · ") || "No company"}
                        </p>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Event performance (company-wide) */}
      {leadsByEvent && (
        <Card className="shadow-sm">
          <CardHeader>
            <div className="flex justify-between items-center">
              <div>
                <CardTitle>Event Performance</CardTitle>
                <CardDescription>Lead conversion by event (company-wide)</CardDescription>
              </div>
              <Link href="/admin/events" className="text-sm text-primary hover:underline flex items-center gap-1">
                View all <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-secondary/50">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Event</th>
                    <th className="px-4 py-2 text-right font-medium">Leads</th>
                    <th className="px-4 py-2 text-right font-medium">Won</th>
                    <th className="px-4 py-2 text-right font-medium">Conversion</th>
                  </tr>
                </thead>
                <tbody>
                  {leadsByEvent.slice(0, 5).map((event) => (
                    <tr key={event.eventId} className="border-t">
                      <td className="px-4 py-2 font-medium">{event.eventName}</td>
                      <td className="px-4 py-2 text-right">{event.leadCount}</td>
                      <td className="px-4 py-2 text-right">{event.wonCount ?? 0}</td>
                      <td className="px-4 py-2 text-right font-medium">{event.conversionRate ?? 0}%</td>
                    </tr>
                  ))}
                  {leadsByEvent.length === 0 && (
                    <tr>
                      <td colSpan={4} className="text-center py-4 text-muted-foreground">
                        No events found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function MiniStat({ label, value, icon: Icon }: { label: string; value: number; icon: React.ElementType }) {
  return (
    <Card className="shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className="h-4 w-4" />
          <span className="text-xs">{label}</span>
        </div>
        <div className="mt-1 text-xl font-bold">{value.toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}
