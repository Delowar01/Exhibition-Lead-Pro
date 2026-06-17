import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { 
  useGetAdminDashboard, 
  useGetScanActivity, 
  useListContacts, 
  useGetTeamPerformance, 
  useListEvents 
} from "@workspace/api-client-react";
import { 
  Contact, 
  BarChart2, 
  TrendingUp, 
  Calendar, 
  DollarSign, 
  Target,
  ArrowRight,
  Clock,
  Trophy,
  Activity
} from "lucide-react";
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
  const { data: contactsData, isLoading: contactsLoading } = useListContacts({ limit: 5 });
  const { data: teamData, isLoading: teamLoading } = useGetTeamPerformance();
  const { data: eventsData, isLoading: eventsLoading } = useListEvents({ limit: 5 });

  if (statsLoading || scanLoading || contactsLoading || teamLoading || eventsLoading) {
    return <div className="p-8 flex items-center justify-center">Loading dashboard...</div>;
  }

  // Simulated data based on stats
  const qualifiedLeads = Math.floor((stats?.totalLeads || 0) * 0.4);
  const opportunities = Math.floor(qualifiedLeads * 0.6);
  const simulatedRevenue = opportunities * 4500; // Simulated avg deal size

  const funnelData = [
    { name: "Total Leads", value: stats?.totalLeads || 0 },
    { name: "Qualified", value: qualifiedLeads },
    { name: "Opportunities", value: opportunities },
    { name: "Won", value: Math.floor(opportunities * ((stats?.conversionRate || 0)/100)) }
  ];

  const sourceData = [
    { name: "Business Card", value: 65 },
    { name: "QR Code", value: 15 },
    { name: "LinkedIn", value: 10 },
    { name: "Manual", value: 10 },
  ];
  const COLORS = ["hsl(var(--primary))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", "hsl(var(--chart-4))"];

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
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Leads</CardTitle>
            <Contact className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalLeads.toLocaleString()}</div>
            <p className="text-xs text-green-600 font-medium mt-1 flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> +12% from last month
            </p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Qualified Leads</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{qualifiedLeads.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">40% qualification rate</p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Opportunities</CardTitle>
            <BarChart2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{opportunities.toLocaleString()}</div>
            <p className="text-xs text-green-600 font-medium mt-1 flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> +8% from last month
            </p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pipeline Value</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${simulatedRevenue.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">Expected this quarter</p>
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
            <CardTitle>Lead Source Breakdown</CardTitle>
            <CardDescription>Where your leads are coming from</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col items-center justify-center pb-8">
            <div className="h-[250px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={sourceData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {sourceData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <RechartsTooltip 
                    formatter={(value) => [`${value}%`, 'Share']}
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }}
                  />
                  <Legend verticalAlign="bottom" height={36} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Upcoming Follow-ups</CardTitle>
            <CardDescription>Contacts requiring action soon</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {contactsData?.contacts.map(contact => (
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
                    <Badge variant="outline" className="text-xs font-normal">Tomorrow</Badge>
                    <a href={`/admin/contacts/${contact.id}`} className="text-xs text-primary hover:underline">View →</a>
                  </div>
                </div>
              ))}
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
            <CardTitle className="text-lg">Recent Activities</CardTitle>
            <CardDescription>Latest actions in the portal</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex gap-3">
                <div className="mt-0.5"><div className="w-2 h-2 rounded-full bg-primary mt-1.5" /></div>
                <div>
                  <p className="text-sm"><span className="font-medium">John Doe</span> scanned a new card at <span className="font-medium">Tech Expo 2023</span></p>
                  <p className="text-xs text-muted-foreground mt-0.5">10 minutes ago</p>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="mt-0.5"><div className="w-2 h-2 rounded-full bg-chart-3 mt-1.5" /></div>
                <div>
                  <p className="text-sm"><span className="font-medium">Sarah Smith</span> moved <span className="font-medium">Acme Corp</span> to Closed Won</p>
                  <p className="text-xs text-muted-foreground mt-0.5">1 hour ago</p>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="mt-0.5"><div className="w-2 h-2 rounded-full bg-chart-2 mt-1.5" /></div>
                <div>
                  <p className="text-sm">Added 45 new contacts via CSV import</p>
                  <p className="text-xs text-muted-foreground mt-0.5">3 hours ago</p>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="mt-0.5"><div className="w-2 h-2 rounded-full bg-primary mt-1.5" /></div>
                <div>
                  <p className="text-sm"><span className="font-medium">Mike Johnson</span> created a new event <span className="font-medium">SaaS SaaStr</span></p>
                  <p className="text-xs text-muted-foreground mt-0.5">Yesterday</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <div className="flex justify-between items-center">
            <div>
              <CardTitle>Recent Events Performance</CardTitle>
              <CardDescription>ROI metrics for latest events</CardDescription>
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
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Scans</TableHead>
                  <TableHead className="text-right">Qualified</TableHead>
                  <TableHead className="text-right">Est. ROI</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {eventsData?.events.slice(0, 5).map(event => (
                  <TableRow key={event.id}>
                    <TableCell className="font-medium">{event.name}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {event.startDate ? format(new Date(event.startDate), 'MMM d, yyyy') : '-'}
                    </TableCell>
                    <TableCell className="text-right">{event.contactCount || 0}</TableCell>
                    <TableCell className="text-right">{Math.floor((event.contactCount || 0) * 0.4)}</TableCell>
                    <TableCell className="text-right text-green-600 font-medium">+{Math.floor(Math.random() * 200 + 50)}%</TableCell>
                  </TableRow>
                ))}
                {(!eventsData?.events || eventsData.events.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-4 text-muted-foreground">No events found.</TableCell>
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
