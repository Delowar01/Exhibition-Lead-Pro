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
  TrendingDown,
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
  CheckCircle2,
  Copy,
  CalendarCheck,
  ArrowRight,
  Briefcase,
  MapPin,
  Clock,
  ChevronRight,
  ArrowUpRight,
  Activity,
  Layers,
  TrendingUp
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader, MetricCard, StatusBadge, CardGridSkeleton, TableSkeleton, ErrorState, EmptyState } from "@/components/ds";

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
    <Card className="shadow-sm flex flex-col">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        {items.length === 0 ? (
          <EmptyState icon={Layers} title="No Data" description={emptyText} className="h-full border-0 py-8" />
        ) : (
          <div className="space-y-4 py-1">
            {items.map((x, i) => {
              const pct = total === 0 ? 0 : Math.round((x.count / total) * 100);
              return (
                <div key={x.label}>
                  <div className="mb-1.5 flex items-center justify-between text-sm">
                    <span className="font-medium truncate pr-2">{x.label}</span>
                    <span className="text-muted-foreground whitespace-nowrap">
                      {x.count} <span className="text-[10px] text-muted-foreground/70">({pct}%)</span>
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
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

  const renderContent = () => {
    if (dashboardQuery.isError) {
      return (
        <ErrorState
          title="Access Denied"
          description="You do not have access to this view, or it could not be loaded."
        />
      );
    }
    
    if (dashboardQuery.isLoading || !data) {
      return (
        <div className="space-y-6">
          <CardGridSkeleton cards={4} />
          <CardGridSkeleton cards={4} />
          <TableSkeleton />
        </div>
      );
    }

    return (
      <DashboardBody
        data={data}
        intel={showCompanyWide ? intel : undefined}
        leadsByEvent={showCompanyWide ? leadsByEvent : undefined}
        isManager={isManager}
        scopeKind={scopeKind}
      />
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader 
        title={isManager && scopeKind === 'company' ? "Command Center" : "My Dashboard"}
        description={
          data 
            ? `${data.scope.name} · ${data.headcount} ${data.headcount === 1 ? "person" : "people"} · ${format(parseISO(data.dateRange.from), "MMM d")} – ${format(parseISO(data.dateRange.to), "MMM d, yyyy")}`
            : "Loading scope data..."
        }
        actions={
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
                      aria-label={`Delete saved view ${v.name}`}
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
        }
      />

      {renderContent()}

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
  isManager,
  scopeKind,
}: {
  data: UnifiedDashboard;
  intel?: LeadIntelligence;
  leadsByEvent?: LeadsByEventItem[];
  isManager: boolean;
  scopeKind: ScopeKind;
}) {
  const isCommandCenter = isManager && scopeKind === 'company';
  
  const k = data.leadKpis;
  const breakdown = intel?.temperatureBreakdown ?? { hot: 0, warm: 0, cold: 0 };
  const tempData = [
    { name: "Hot", value: breakdown.hot, color: "hsl(var(--destructive))" },
    { name: "Warm", value: breakdown.warm, color: "hsl(var(--warning))" },
    { name: "Cold", value: breakdown.cold, color: "hsl(var(--info))" },
  ];
  const hasTempData = breakdown.hot + breakdown.warm + breakdown.cold > 0;
  const hotLeads = intel?.hotLeads ?? [];
  const followUpsDue = intel?.followUpsDue ?? [];

  const tempBadge = (t?: string | null) => {
    switch (t) {
      case "hot":
        return { cls: "bg-destructive-soft text-destructive border-destructive/25", icon: <Flame className="h-3 w-3" />, label: "Hot" };
      case "warm":
        return { cls: "bg-warning-soft text-warning border-warning/25", icon: <Thermometer className="h-3 w-3" />, label: "Warm" };
      case "cold":
        return { cls: "bg-info-soft text-info border-info/25", icon: <Snowflake className="h-3 w-3" />, label: "Cold" };
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Primary KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isCommandCenter ? (
          <>
            <MetricCard 
              label="Pipeline Value" 
              value={formatUsd(data.kpis.pipelineValue)} 
              icon={DollarSign} 
              delta={data.deltas.pipelineValue ?? undefined} 
              deltaLabel="vs prior period" 
            />
            <MetricCard 
              label="Won Revenue" 
              value={formatUsd(data.kpis.wonValue)} 
              icon={Trophy} 
              footer={
                <span className="text-muted-foreground flex items-center gap-1"><ArrowDownRight className="h-3 w-3 text-destructive" /> {formatUsd(data.kpis.lostValue)} lost</span>
              } 
            />
            <MetricCard 
              label="Total Leads" 
              value={k.total.toLocaleString()} 
              icon={Target} 
              footer={`${k.new} new in range`} 
            />
            <MetricCard 
              label="Conversion Rate" 
              value={`${k.conversionRate}%`} 
              delta={data.deltas.conversionRate ?? undefined} 
              icon={TrendingUp} 
              className="bg-primary/5 border-primary/20"
            />
          </>
        ) : (
          <>
            <MetricCard 
              label="My Leads" 
              value={k.total.toLocaleString()} 
              icon={Target} 
              footer={`${k.today} new today`} 
            />
            <MetricCard 
              label="Follow-ups Due" 
              value={k.followUpsDue.toLocaleString()} 
              icon={CalendarClock} 
              className={k.followUpsDue > 0 ? "bg-warning-soft border-warning/25" : ""}
            />
            <MetricCard 
              label="Meetings" 
              value={k.meetingsScheduled.toLocaleString()} 
              icon={CalendarCheck} 
            />
            <MetricCard 
              label="Scans" 
              value={data.kpis.scans.toLocaleString()} 
              delta={data.deltas.scans ?? undefined} 
              icon={ScanLine} 
            />
          </>
        )}
      </div>

      {/* Secondary KPI strip */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <MiniStat label="AI Queue" value={k.aiQueue} icon={Sparkles} />
        <MiniStat label="Duplicates" value={k.duplicate} icon={Copy} />
        {!isCommandCenter && <MiniStat label="New Contacts" value={data.kpis.newContacts} icon={ContactIcon} />}
        {isCommandCenter && <MiniStat label="Meetings" value={k.meetingsScheduled} icon={CalendarCheck} />}
        {isCommandCenter && <MiniStat label="Follow-ups Due" value={k.followUpsDue} icon={CalendarClock} />}
        <MiniStat label="Lost" value={k.lost} icon={TrendingDown} />
        {isCommandCenter && <MiniStat label="Headcount" value={data.headcount} icon={Users} />}
        {!isCommandCenter && <MiniStat label="Qualified" value={k.qualified} icon={CheckCircle2} />}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main Chart Area */}
        <Card className="shadow-sm lg:col-span-2 flex flex-col">
          <CardHeader>
            <CardTitle>Activity Trend</CardTitle>
            <CardDescription>Scans vs leads over the selected period</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 min-h-[300px]">
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
                  contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", color: "hsl(var(--foreground))" }}
                  labelFormatter={(val) => format(parseISO(String(val)), "MMM d, yyyy")}
                />
                <Legend />
                <Area type="monotone" dataKey="scans" name="Scans" stroke="hsl(var(--chart-1))" strokeWidth={2} fillOpacity={1} fill="url(#dScan)" />
                <Area type="monotone" dataKey="leads" name="Leads" stroke="hsl(var(--chart-2))" strokeWidth={2} fillOpacity={1} fill="url(#dLead)" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Action / Priority Panel */}
        {followUpsDue.length > 0 || hotLeads.length > 0 ? (
          <div className="space-y-6 flex flex-col">
            {followUpsDue.length > 0 && (
              <Card className="shadow-sm flex-1 flex flex-col border-warning/30 bg-warning-soft/20">
                <CardHeader className="pb-3 border-b border-warning/10">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-warning" />
                      <CardTitle className="text-base font-semibold">Priority Action</CardTitle>
                    </div>
                    <Badge variant="outline" className="bg-warning/10 text-warning border-warning/20">{followUpsDue.length} Due</Badge>
                  </div>
                </CardHeader>
                <CardContent className="pt-4 flex-1 overflow-auto max-h-[300px]">
                  <div className="space-y-4">
                    {followUpsDue.slice(0, 4).map((contact) => {
                      const overdue = contact.followUpDate ? contact.followUpDate < format(new Date(), "yyyy-MM-dd") : false;
                      return (
                        <div key={contact.id} className="flex gap-3 items-start group">
                          <Avatar className="h-9 w-9 border border-border mt-0.5">
                            <AvatarFallback className="bg-background text-foreground text-xs">{contact.firstName?.charAt(0)}{contact.lastName?.charAt(0)}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium group-hover:underline">
                              {contact.firstName} {contact.lastName}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">{contact.contactCompany || "No company"}</p>
                            <span className={`mt-1 inline-flex items-center gap-1 text-[10px] uppercase font-semibold ${overdue ? "text-destructive" : "text-muted-foreground"}`}>
                              {overdue && <AlertCircle className="h-3 w-3" />}
                              {overdue ? "Overdue" : "Due Today"}
                            </span>
                          </div>
                          <Button variant="ghost" size="icon" asChild className="h-8 w-8 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Link href={`/admin/contacts/${contact.id}`} aria-label="Open contact"><ArrowUpRight className="h-4 w-4" /></Link>
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
                {followUpsDue.length > 4 && (
                  <div className="px-4 pb-4 pt-2 text-center border-t border-warning/10 mt-auto">
                    <Link href="/admin/contacts" className="text-xs font-medium text-warning hover:underline">View all {followUpsDue.length} follow-ups</Link>
                  </div>
                )}
              </Card>
            )}

            {hotLeads.length > 0 && followUpsDue.length <= 4 && (
               <Card className="shadow-sm flex-1 flex flex-col">
                 <CardHeader className="pb-3 border-b border-border/50">
                    <div className="flex items-center gap-2">
                      <Flame className="h-4 w-4 text-destructive" />
                      <CardTitle className="text-base font-semibold">Hot Leads</CardTitle>
                    </div>
                 </CardHeader>
                 <CardContent className="pt-4 flex-1">
                    <div className="space-y-4">
                      {hotLeads.slice(0, 3).map((lead) => {
                        return (
                          <Link key={lead.id} href={`/admin/contacts/${lead.id}`} className="flex gap-3 items-center group">
                            <div className="flex flex-col items-center justify-center w-9 h-9 rounded bg-destructive-soft text-destructive shrink-0">
                              <span className="text-sm font-bold leading-none">{lead.leadScore ?? "—"}</span>
                            </div>
                            <div className="min-w-0 flex-1">
                               <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                                 {lead.firstName} {lead.lastName}
                               </p>
                               <p className="text-xs text-muted-foreground truncate">
                                 {lead.jobTitle}
                               </p>
                            </div>
                            <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                          </Link>
                        );
                      })}
                    </div>
                 </CardContent>
               </Card>
            )}
          </div>
        ) : (
          <Card className="shadow-sm flex flex-col justify-center items-center text-center p-6 lg:h-auto">
             <div className="w-12 h-12 bg-success-soft text-success rounded-full flex items-center justify-center mb-4">
               <CheckCircle2 className="h-6 w-6" />
             </div>
             <CardTitle className="mb-2">You're all caught up</CardTitle>
             <CardDescription>No urgent follow-ups or hot leads at the moment.</CardDescription>
             <Button variant="outline" className="mt-6" asChild>
               <Link href="/admin/contacts/new">Add New Contact</Link>
             </Button>
          </Card>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="shadow-sm flex flex-col">
          <CardHeader>
            <CardTitle>Pipeline Funnel</CardTitle>
            <CardDescription>Leads by stage (point-in-time)</CardDescription>
          </CardHeader>
          <CardContent className="flex-1">
            {data.funnel.every((f) => f.count === 0) ? (
              <EmptyState icon={Layers} title="No Pipeline Data" className="h-full border-0" />
            ) : (
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.funnel} layout="vertical" margin={{ top: 0, right: 16, left: 16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                    <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
                    <YAxis type="category" dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} width={90} />
                    <RechartsTooltip contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", color: "hsl(var(--foreground))" }} cursor={{ fill: "hsl(var(--muted))", opacity: 0.3 }} />
                    <Bar dataKey="count" name="Leads" radius={[0, 4, 4, 0]} maxBarSize={30}>
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

        <Card className="shadow-sm flex flex-col">
          <CardHeader>
            <CardTitle>Monthly Growth</CardTitle>
            <CardDescription>Leads, contacts &amp; scans over 12 months</CardDescription>
          </CardHeader>
          <CardContent className="flex-1">
            {data.monthlyTrend.every((m) => m.leads + m.contacts + m.scans === 0) ? (
              <EmptyState icon={Activity} title="No Monthly Data" className="h-full border-0" />
            ) : (
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={data.monthlyTrend} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} minTickGap={12} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
                    <RechartsTooltip contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", color: "hsl(var(--foreground))" }} />
                    <Legend />
                    <Bar dataKey="contacts" name="Contacts" fill="hsl(var(--chart-3))" radius={[3, 3, 0, 0]} maxBarSize={40} stackId="a" />
                    <Bar dataKey="leads" name="Leads" fill="hsl(var(--chart-2))" radius={[3, 3, 0, 0]} maxBarSize={40} stackId="a" />
                    <Line type="monotone" dataKey="won" name="Won" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <DistributionCard title="By Industry" description="Contacts grouped by industry" items={data.industryDistribution} emptyText="No contacts in range" />
        <DistributionCard title="By Country" description="Contacts grouped by country" items={data.countryDistribution} emptyText="No contacts in range" />
        <Card className="shadow-sm flex flex-col">
          <CardHeader>
            <CardTitle>Capture Source</CardTitle>
            <CardDescription>How contacts were captured</CardDescription>
          </CardHeader>
          <CardContent className="flex-1">
            {data.sourceMix.length === 0 ? (
              <EmptyState icon={Layers} title="No Data" description="No contacts in range" className="h-full border-0 py-8" />
            ) : (
              <div className="space-y-4 py-1">
                {(() => {
                  const total = data.sourceMix.reduce((s, x) => s + x.count, 0);
                  return data.sourceMix.map((x, i) => {
                    const pct = total === 0 ? 0 : Math.round((x.count / total) * 100);
                    return (
                      <div key={x.source}>
                        <div className="mb-1.5 flex items-center justify-between text-sm">
                          <span className="font-medium capitalize flex items-center gap-2">
                            {x.source === 'scan' && <ScanLine className="h-3.5 w-3.5 text-muted-foreground" />}
                            {x.source === 'manual' && <ContactIcon className="h-3.5 w-3.5 text-muted-foreground" />}
                            {x.source === 'import' && <Download className="h-3.5 w-3.5 text-muted-foreground" />}
                            {x.source}
                          </span>
                          <span className="text-muted-foreground">
                            {x.count} <span className="text-[10px] text-muted-foreground/70">({pct}%)</span>
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
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

      <div className="grid gap-6 lg:grid-cols-2">
        {isCommandCenter && (
          <Card className="shadow-sm flex flex-col">
            <CardHeader>
              <CardTitle>Top Performers</CardTitle>
              <CardDescription>By pipeline contribution</CardDescription>
            </CardHeader>
            <CardContent className="flex-1">
              {data.topPerformers.length === 0 ? (
                <EmptyState icon={Trophy} title="No Activity" description="No performance data in range" className="h-full border-0 py-8" />
              ) : (
                <div className="space-y-4">
                  {data.topPerformers.map((p, i) => (
                    <div key={p.userId} className="flex items-center gap-3 bg-secondary/30 p-3 rounded-lg border border-border/50">
                      <div className="flex items-center justify-center w-6 h-6 rounded-full bg-muted text-muted-foreground text-xs font-semibold">
                        {i + 1}
                      </div>
                      <Avatar className="h-10 w-10 border border-border">
                        {p.avatarUrl ? <AvatarImage src={p.avatarUrl} alt={p.userName} /> : null}
                        <AvatarFallback className="bg-background">{initials(p.userName)}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{p.userName}</div>
                        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
                          <span>{p.leads} leads</span>
                          <span>•</span>
                          <span>{p.won} won</span>
                        </div>
                      </div>
                      <div className="text-right">
                         <span className="block text-sm font-bold">{formatUsd(p.pipelineValue)}</span>
                         <span className="block text-[10px] text-muted-foreground uppercase tracking-wider">Pipeline</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card className={`shadow-sm flex flex-col ${!isCommandCenter ? "lg:col-span-2" : ""}`}>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest events in this scope</CardDescription>
          </CardHeader>
          <CardContent className="flex-1">
            {data.recentActivity.length === 0 ? (
              <EmptyState icon={Activity} title="No Activity" description="No recent activity found" className="h-full border-0 py-8" />
            ) : (
              <div className="relative space-y-0 pl-6 border-l-2 border-muted ml-2 pb-4">
                {data.recentActivity.map((a, i) => (
                  <div key={a.id} className="relative pb-6 last:pb-0">
                    <span className="absolute -left-[31px] top-1 h-4 w-4 rounded-full bg-background border-2 border-primary" />
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 min-w-0">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground">{a.title}</div>
                        {a.subtitle && <div className="mt-0.5 text-xs text-muted-foreground">{a.subtitle}</div>}
                      </div>
                      <span className="whitespace-nowrap text-xs font-medium text-muted-foreground bg-secondary px-2 py-0.5 rounded-full shrink-0">
                        {format(parseISO(a.at), "MMM d, h:mm a")}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {isCommandCenter && leadsByEvent && (
        <Card className="shadow-sm">
          <CardHeader>
            <div className="flex justify-between items-center">
              <div>
                <CardTitle>Event Performance</CardTitle>
                <CardDescription>Lead conversion by event (company-wide)</CardDescription>
              </div>
              <Button variant="ghost" size="sm" asChild className="hidden sm:flex text-primary hover:text-primary">
                <Link href="/admin/events">View all events <ArrowRight className="ml-1 h-3 w-3" /></Link>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {leadsByEvent.length === 0 ? (
               <EmptyState icon={MapPin} title="No Event Data" description="No event conversions found" className="border-0 py-8" />
            ) : (
              <div className="rounded-md border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-secondary/50">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground text-xs uppercase tracking-wider">Event</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground text-xs uppercase tracking-wider">Leads</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground text-xs uppercase tracking-wider">Won</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground text-xs uppercase tracking-wider">Conversion</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {leadsByEvent.slice(0, 5).map((event) => (
                      <tr key={event.eventId} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-3 font-medium flex items-center gap-2">
                           <div className="h-8 w-8 rounded bg-primary/10 flex items-center justify-center text-primary shrink-0">
                              <MapPin className="h-4 w-4" />
                           </div>
                           <span className="truncate">{event.eventName}</span>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">{event.leadCount}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{event.wonCount ?? 0}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                           <StatusBadge tone={(event.conversionRate ?? 0) > 10 ? "success" : "neutral"} showDot={false}>
                              {event.conversionRate ?? 0}%
                           </StatusBadge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isCommandCenter && intel && (
        <div className="grid gap-6 lg:grid-cols-2">
           <Card className="shadow-sm flex flex-col">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Thermometer className="h-4 w-4 text-primary" />
                <CardTitle>Lead Temperature</CardTitle>
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
                      <RechartsTooltip formatter={(value, name) => [`${value} contacts`, name]} contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", color: "hsl(var(--foreground))" }} />
                      <Legend verticalAlign="bottom" height={36} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <EmptyState icon={Sparkles} title="No Intelligence Data" description="No AI-scored leads yet." className="h-full border-0 py-8" />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, icon: Icon }: { label: string; value: number; icon: React.ElementType }) {
  return (
    <Card className="shadow-sm">
      <CardContent className="p-4 flex flex-col justify-center">
        <div className="flex items-center gap-2 text-muted-foreground mb-1">
          <Icon className="h-4 w-4" />
          <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
        </div>
        <div className="text-2xl font-bold tracking-tight">{value.toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}
function ArrowDownRight(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m7 7 10 10" />
      <path d="M17 7v10H7" />
    </svg>
  )
}
