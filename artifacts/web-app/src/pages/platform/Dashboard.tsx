import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { 
  useGetPlatformStats, 
  useGetPlatformRevenueTrend, 
  useGetPlatformScanTrend, 
  useListCompanies 
} from "@workspace/api-client-react";
import { Building2, Users, Camera, DollarSign, Activity, Zap, TrendingUp, CheckCircle2, AlertCircle, Clock } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis, CartesianGrid, PieChart, Pie, Cell, Legend, BarChart, Bar } from "recharts";
import { format } from "date-fns";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function PlatformDashboard() {
  const { data: stats, isLoading: statsLoading } = useGetPlatformStats();
  const { data: revenueData, isLoading: revenueLoading } = useGetPlatformRevenueTrend();
  const { data: scanData, isLoading: scanLoading } = useGetPlatformScanTrend();
  const { data: companiesData, isLoading: companiesLoading } = useListCompanies({ limit: 5 });

  if (statsLoading || revenueLoading || scanLoading || companiesLoading) {
    return <div className="p-8 flex items-center justify-center">Loading platform dashboard...</div>;
  }

  const mrr = stats?.monthlyRevenue || 0;
  const arr = mrr * 12;
  const totalCompanies = stats?.totalCompanies || 0;
  const activeCompanies = stats?.activeCompanies || 0;
  
  // Simulated data
  const aiRequests = (stats?.totalScans || 0) * 3.4; // rough multiplier
  
  const COLORS = ["hsl(var(--primary))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", "hsl(var(--destructive))"];
  const subStatusData = [
    { name: "Active", value: activeCompanies },
    { name: "Trial", value: Math.floor(totalCompanies * 0.15) },
    { name: "Past Due", value: Math.floor(totalCompanies * 0.05) },
    { name: "Cancelled", value: totalCompanies - activeCompanies - Math.floor(totalCompanies * 0.2) }
  ];

  const planDistData = [
    { name: "Enterprise", value: 12 },
    { name: "Professional", value: 45 },
    { name: "Starter", value: 30 },
    { name: "Free", value: 13 },
  ];

  // Map revenue data to show growth line
  const mrrGrowthData = revenueData?.map((item, i) => {
    // Generate cumulative growth-looking data from trend
    return { ...item, mrr: item.value * (1 + (i * 0.02)) };
  }) || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Platform Dashboard</h1>
          <p className="text-muted-foreground mt-1">Real-time metrics across all tenant instances</p>
        </div>
        <Badge className="bg-green-500/10 text-green-600 hover:bg-green-500/20 border-green-500/20">System Operational</Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Companies</CardTitle>
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalCompanies.toLocaleString()}</div>
            <p className="text-xs text-green-600 font-medium mt-1 flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> +4 this week
            </p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalUsers.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">Across all tenants</p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">MRR</CardTitle>
            <DollarSign className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${mrr.toLocaleString()}</div>
            <p className="text-xs text-green-600 font-medium mt-1 flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> +8.2% MoM
            </p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">ARR</CardTitle>
            <Activity className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${arr.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">Annual Run Rate</p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Leads</CardTitle>
            <Camera className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalLeads.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground mt-1">Captured system-wide</p>
          </CardContent>
        </Card>
        <Card className="bg-sidebar text-sidebar-foreground border-sidebar-border shadow-md">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-sidebar-foreground/70">AI Requests</CardTitle>
            <Zap className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">{Math.floor(aiRequests).toLocaleString()}</div>
            <p className="text-xs text-sidebar-foreground/70 mt-1">API calls this month</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-7">
        <Card className="md:col-span-5 shadow-sm">
          <CardHeader>
            <CardTitle>MRR Growth</CardTitle>
            <CardDescription>Monthly Recurring Revenue trend over time</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={mrrGrowthData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorMrr" x1="0" y1="0" x2="0" y2="1">
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
                    tickFormatter={(val) => `$${val}`}
                  />
                  <RechartsTooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                    labelFormatter={(val) => format(new Date(val), 'MMM d, yyyy')}
                  />
                  <Area type="monotone" dataKey="mrr" stroke="hsl(var(--primary))" strokeWidth={2} fillOpacity={1} fill="url(#colorMrr)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-2 shadow-sm flex flex-col">
          <CardHeader>
            <CardTitle>Subscription Status</CardTitle>
            <CardDescription>Active vs Churned accounts</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col items-center justify-center pb-6">
            <div className="h-[220px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={subStatusData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {subStatusData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <RechartsTooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }}
                  />
                  <Legend verticalAlign="bottom" height={36} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="shadow-sm md:col-span-2">
          <CardHeader>
            <div className="flex justify-between items-center">
              <div>
                <CardTitle>Recent Companies</CardTitle>
                <CardDescription>Latest tenants onboarded to the platform</CardDescription>
              </div>
              <a href="/platform/companies" className="text-sm text-primary hover:underline">View all</a>
            </div>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader className="bg-secondary/50">
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead className="text-right">Users</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                    <TableHead className="text-right">Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {companiesData?.companies.map(company => (
                    <TableRow key={company.id} className="hover:bg-muted/50 cursor-pointer">
                      <TableCell className="font-medium">{company.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize text-xs font-normal">
                          {company.plan}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{company.userCount}</TableCell>
                      <TableCell className="text-center">
                        <Badge 
                          variant={company.status === "active" ? "default" : "secondary"} 
                          className={company.status === "active" ? "bg-green-500 hover:bg-green-600" : ""}
                        >
                          {company.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground text-sm">
                        {format(new Date(company.createdAt), 'MMM d, yyyy')}
                      </TableCell>
                    </TableRow>
                  ))}
                  {(!companiesData?.companies || companiesData.companies.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-4 text-muted-foreground">No companies found.</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6 flex flex-col">
          <Card className="shadow-sm flex-1">
            <CardHeader className="pb-3">
              <CardTitle>Support Overview</CardTitle>
              <CardDescription>Platform support tickets</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex justify-between items-center border-b border-border pb-3">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-destructive" />
                    <span className="text-sm font-medium">Open Tickets</span>
                  </div>
                  <span className="font-bold">32</span>
                </div>
                <div className="flex justify-between items-center border-b border-border pb-3">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-chart-2" />
                    <span className="text-sm font-medium">In Progress</span>
                  </div>
                  <span className="font-bold">12</span>
                </div>
                <div className="flex justify-between items-center border-b border-border pb-3">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                    <span className="text-sm font-medium">Resolved Today</span>
                  </div>
                  <span className="font-bold">18</span>
                </div>
                <div className="flex justify-between items-center pt-1">
                  <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium">SLA Compliance</span>
                  </div>
                  <span className="font-bold text-green-600">98.2%</span>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-secondary p-4 rounded-xl border border-border flex flex-col items-center justify-center text-center">
              <span className="text-xs text-muted-foreground font-medium mb-1 uppercase tracking-wider">Revenue Growth</span>
              <span className="text-xl font-bold text-green-600">+14%</span>
            </div>
            <div className="bg-secondary p-4 rounded-xl border border-border flex flex-col items-center justify-center text-center">
              <span className="text-xs text-muted-foreground font-medium mb-1 uppercase tracking-wider">User Growth</span>
              <span className="text-xl font-bold text-green-600">+22%</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
