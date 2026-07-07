import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { 
  useGetPlatformStats, 
  useGetPlatformRevenueTrend, 
  useGetPlatformScanTrend, 
  useListCompanies 
} from "@workspace/api-client-react";
import { Building2, Users, Camera, DollarSign, Activity, Zap } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis, CartesianGrid, PieChart, Pie, Cell, Legend } from "recharts";
import { format } from "date-fns";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { PageHeader, MetricCard, StatusBadge, CardGridSkeleton, TableSkeleton } from "@/components/ds";

export default function PlatformDashboard() {
  const { data: stats, isLoading: statsLoading } = useGetPlatformStats();
  const { data: revenueData, isLoading: revenueLoading } = useGetPlatformRevenueTrend();
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

  const mrr = stats?.monthlyRevenue || 0;
  const arr = mrr * 12;
  const totalCompanies = stats?.totalCompanies || 0;
  const activeCompanies = stats?.activeCompanies || 0;
  
  const COLORS = ["hsl(var(--primary))", "hsl(var(--chart-3))"];
  const subStatusData = [
    { name: "Active", value: activeCompanies },
    { name: "Inactive", value: Math.max(totalCompanies - activeCompanies, 0) },
  ];

  const mrrGrowthData = revenueData?.map((item) => ({ ...item, mrr: item.value })) || [];

  return (
    <div className="space-y-6">
      <PageHeader 
        title="Platform Dashboard" 
        description="Real-time metrics across all tenant instances"
        actions={
          <StatusBadge tone="success">System Operational</StatusBadge>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <MetricCard
          label="Total Companies"
          value={totalCompanies.toLocaleString()}
          icon={Building2}
          footer={`${activeCompanies.toLocaleString()} active`}
        />
        <MetricCard
          label="Total Users"
          value={(stats?.totalUsers || 0).toLocaleString()}
          icon={Users}
          footer="Across all tenants"
        />
        <MetricCard
          label="MRR"
          value={`$${mrr.toLocaleString()}`}
          icon={DollarSign}
          footer="Monthly Recurring Revenue"
        />
        <MetricCard
          label="ARR"
          value={`$${arr.toLocaleString()}`}
          icon={Activity}
          footer="Annual Run Rate"
        />
        <MetricCard
          label="Total Leads"
          value={(stats?.totalLeads || 0).toLocaleString()}
          icon={Camera}
          footer="Captured system-wide"
        />
        <MetricCard
          label="Total Scans"
          value={(stats?.totalScans || 0).toLocaleString()}
          icon={Zap}
          className="bg-sidebar text-sidebar-foreground border-sidebar-border"
          footer={<span className="text-sidebar-foreground/70">Cards captured system-wide</span>}
        />
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

      <div className="grid gap-6">
        <Card className="shadow-sm">
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
                        <StatusBadge tone={company.status === "active" ? "success" : "neutral"} showDot>
                          {company.status}
                        </StatusBadge>
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
      </div>
    </div>
  );
}
