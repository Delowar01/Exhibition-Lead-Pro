import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { 
  useGetAdminDashboard, 
  useGetScanActivity, 
  useGetTeamPerformance, 
  useGetLeadIntelligence,
  useGetLeadsByEvent
} from "@workspace/api-client-react";
import { 
  Contact, 
  ArrowRight,
  Trophy,
  Flame,
  Thermometer,
  Snowflake,
  Sparkles,
  CalendarClock,
  AlertCircle
} from "lucide-react";
import { Link } from "wouter";
import { 
  Area, AreaChart, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis, CartesianGrid, 
  PieChart, Pie, Cell, Legend
} from "recharts";
import { format } from "date-fns";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

export default function AdminDashboard() {
  const { data: stats, isLoading: statsLoading } = useGetAdminDashboard();
  const { data: scanData, isLoading: scanLoading } = useGetScanActivity();
  const { data: teamData, isLoading: teamLoading } = useGetTeamPerformance();
  const { data: leadsByEvent, isLoading: eventsLoading } = useGetLeadsByEvent();
  const { data: intel, isLoading: intelLoading } = useGetLeadIntelligence();

  if (statsLoading || scanLoading || teamLoading || eventsLoading || intelLoading) {
    return <div className="p-8 flex items-center justify-center">Loading dashboard...</div>;
  }

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
      case "hot": return { cls: "bg-red-100 text-red-700 border-red-200", icon: <Flame className="h-3 w-3" />, label: "Hot" };
      case "warm": return { cls: "bg-amber-100 text-amber-700 border-amber-200", icon: <Thermometer className="h-3 w-3" />, label: "Warm" };
      case "cold": return { cls: "bg-blue-100 text-blue-700 border-blue-200", icon: <Snowflake className="h-3 w-3" />, label: "Cold" };
      default: return null;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard Overview</h1>
        <div className="flex gap-2">
          <Badge variant="outline" className="text-muted-foreground bg-background px-3 py-1">Last 30 Days</Badge>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Contacts</CardTitle>
            <Contact className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalContacts.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">{stats?.newContactsToday ?? 0} added today</p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Hot Leads</CardTitle>
            <Flame className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{breakdown.hot.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">AI-qualified, high intent</p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Avg Lead Score</CardTitle>
            <Sparkles className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{intel?.averageScore != null ? `${intel.averageScore}/100` : "—"}</div>
            <p className="text-xs text-muted-foreground mt-1">{intel?.scoredCount ?? 0} scored by AI</p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Follow-ups Due</CardTitle>
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{(intel?.followUpsDueCount ?? 0).toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">Due today or overdue</p>
          </CardContent>
        </Card>
        <Card className="bg-primary text-primary-foreground border-primary-border shadow-md">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-primary-foreground/80">Win Rate</CardTitle>
            <Trophy className="h-4 w-4 text-primary-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{stats?.conversionRate}%</div>
            <p className="text-xs text-primary-foreground/80 mt-1">Across all events</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-7">
        <Card className="md:col-span-4 shadow-sm">
          <CardHeader>
            <CardTitle>Scan & Lead Activity Trend</CardTitle>
            <CardDescription>Daily scan volume over the last 30 days</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={scanData || []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorScanActivity" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis 
                    dataKey="date" 
                    tickFormatter={(val) => format(new Date(val), 'MMM d')} 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false} 
                  />
                  <YAxis 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false} 
                  />
                  <RechartsTooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }}
                    labelFormatter={(val) => format(new Date(val), 'MMM d, yyyy')}
                  />
                  <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} fillOpacity={1} fill="url(#colorScanActivity)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-3 shadow-sm flex flex-col">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Thermometer className="h-4 w-4 text-primary" />
              <CardTitle>Lead Temperature</CardTitle>
            </div>
            <CardDescription>AI-scored intent across your contacts</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col items-center justify-center pb-8">
            {hasTempData ? (
              <div className="h-[250px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={tempData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="value"
                    >
                      {tempData.map((entry) => (
                        <Cell key={`cell-${entry.name}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <RechartsTooltip 
                      formatter={(value, name) => [`${value} contacts`, name]}
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }}
                    />
                    <Legend verticalAlign="bottom" height={36} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-[250px] w-full flex flex-col items-center justify-center text-center text-muted-foreground gap-2">
                <Sparkles className="h-8 w-8 opacity-40" />
                <p className="text-sm">No AI-scored leads yet.</p>
                <p className="text-xs">Scan business cards to start scoring leads.</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <Card className="shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-primary" />
              <CardTitle className="text-lg">Follow-ups Due</CardTitle>
            </div>
            <CardDescription>Contacts due today or overdue</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {followUpsDue.length === 0 && (
                <div className="text-sm text-muted-foreground text-center py-6">No follow-ups due. You're all caught up.</div>
              )}
              {followUpsDue.map(contact => {
                const overdue = contact.followUpDate
                  ? new Date(contact.followUpDate) < new Date(new Date().toISOString().slice(0, 10))
                  : false;
                return (
                  <div key={contact.id} className="flex items-center justify-between border-b border-border pb-4 last:border-0 last:pb-0">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold text-sm">
                        {contact.firstName?.charAt(0)}{contact.lastName?.charAt(0)}
                      </div>
                      <div>
                        <p className="font-medium text-sm">{contact.firstName} {contact.lastName}</p>
                        <p className="text-xs text-muted-foreground">{contact.contactCompany || 'No company'}</p>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant="outline" className={`text-xs font-normal ${overdue ? "border-red-200 bg-red-50 text-red-700" : ""}`}>
                        {overdue && <AlertCircle className="h-3 w-3 mr-1" />}
                        {contact.followUpDate ? format(new Date(contact.followUpDate), "MMM d") : "—"}
                      </Badge>
                      <Link href={`/admin/contacts/${contact.id}`} className="text-xs text-primary hover:underline">View →</Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Top Performers</CardTitle>
            <CardDescription>Team members by won leads</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-5">
              {teamData?.slice(0, 5).map((member, i) => (
                <div key={member.userId} className="flex items-center gap-4">
                  <div className="font-bold text-muted-foreground w-4">{i + 1}</div>
                  <div className="flex-1">
                    <div className="flex justify-between items-center mb-1">
                      <span className="font-medium text-sm">{member.userName}</span>
                      <span className="text-xs font-semibold">{member.wonCount || 0} won</span>
                    </div>
                    <Progress value={Math.min(((member.wonCount || 0) / 20) * 100, 100)} className="h-1.5" />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm lg:col-span-1 md:col-span-2">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Flame className="h-4 w-4 text-red-500" />
              <CardTitle className="text-lg">Hot Leads to Action</CardTitle>
            </div>
            <CardDescription>Highest AI lead scores in your pipeline</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {hotLeads.length === 0 && (
                <div className="text-sm text-muted-foreground text-center py-6">No scored leads yet. Scan cards to generate AI scores.</div>
              )}
              {hotLeads.map(lead => {
                const badge = tempBadge(lead.leadTemperature);
                return (
                  <Link
                    key={lead.id}
                    href={`/admin/contacts/${lead.id}`}
                    className="flex gap-3 items-start group"
                  >
                    <div className="flex flex-col items-center justify-center w-11 h-11 rounded-lg bg-primary/10 text-primary shrink-0">
                      <span className="text-sm font-bold leading-none">{lead.leadScore ?? "—"}</span>
                      <span className="text-[9px] uppercase tracking-wide opacity-70">score</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate group-hover:text-primary">
                          {lead.firstName} {lead.lastName}
                        </p>
                        {badge && (
                          <Badge variant="outline" className={`text-[10px] font-normal gap-1 px-1.5 py-0 ${badge.cls}`}>
                            {badge.icon}{badge.label}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {[lead.jobTitle, lead.contactCompany].filter(Boolean).join(" · ") || "No company"}
                      </p>
                      {lead.aiReasoning && (
                        <p className="text-xs text-muted-foreground/80 mt-0.5 line-clamp-2">{lead.aiReasoning}</p>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <div className="flex justify-between items-center">
            <div>
              <CardTitle>Event Performance</CardTitle>
              <CardDescription>Lead conversion by event</CardDescription>
            </div>
            <a href="/admin/events" className="text-sm text-primary hover:underline flex items-center gap-1">
              View all <ArrowRight className="h-3 w-3" />
            </a>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader className="bg-secondary/50">
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">Won</TableHead>
                  <TableHead className="text-right">Conversion</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leadsByEvent?.slice(0, 5).map(event => (
                  <TableRow key={event.eventId}>
                    <TableCell className="font-medium">{event.eventName}</TableCell>
                    <TableCell className="text-right">{event.leadCount}</TableCell>
                    <TableCell className="text-right">{event.wonCount ?? 0}</TableCell>
                    <TableCell className="text-right font-medium">{event.conversionRate ?? 0}%</TableCell>
                  </TableRow>
                ))}
                {(!leadsByEvent || leadsByEvent.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-4 text-muted-foreground">No events found.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
