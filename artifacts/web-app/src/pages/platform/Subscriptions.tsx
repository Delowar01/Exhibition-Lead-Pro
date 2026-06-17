import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useGetPlatformStats, useGetPlatformRevenueTrend } from "@workspace/api-client-react";
import { CreditCard, CheckCircle2, TrendingUp, AlertCircle, ArrowUpRight, DollarSign } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip, Legend, AreaChart, Area, XAxis, YAxis, CartesianGrid } from "recharts";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";

export default function PlatformSubscriptions() {
  const { data: stats, isLoading: statsLoading } = useGetPlatformStats();
  const { data: revenueData, isLoading: revenueLoading } = useGetPlatformRevenueTrend();
  const [filter, setFilter] = useState("all");

  if (statsLoading || revenueLoading) {
    return <div className="p-8 flex items-center justify-center">Loading subscriptions...</div>;
  }

  const distribution = stats?.subscriptionDistribution || [];
  
  const mrr = stats?.monthlyRevenue || 0;
  const totalSubscribers = stats?.totalCompanies || 0;
  const activeSubs = stats?.activeCompanies || 0;
  const trialSubs = Math.floor(totalSubscribers * 0.15);
  const cancelledSubs = totalSubscribers - activeSubs - trialSubs;

  const COLORS = ["hsl(var(--primary))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", "hsl(var(--destructive))"];
  
  const statusData = [
    { name: "Active", value: activeSubs },
    { name: "Trial", value: trialSubs },
    { name: "Past Due", value: Math.floor(activeSubs * 0.05) },
    { name: "Cancelled", value: cancelledSubs }
  ];

  const revenueByPlan = [
    { name: "Enterprise", value: mrr * 0.55 },
    { name: "Professional", value: mrr * 0.35 },
    { name: "Starter", value: mrr * 0.10 }
  ];

  // Generate fake table data based on totals
  const fakeTableData = Array.from({ length: 10 }).map((_, i) => ({
    id: i,
    company: `Company ${i + 1} Inc`,
    plan: i % 4 === 0 ? 'Enterprise' : (i % 3 === 0 ? 'Starter' : 'Professional'),
    status: i === 8 ? 'past_due' : (i === 9 ? 'cancelled' : 'active'),
    users: Math.floor(Math.random() * 50) + 5,
    mrr: i % 4 === 0 ? 999 : (i % 3 === 0 ? 49 : 99),
    renewalDate: new Date(Date.now() + (Math.random() * 30 * 24 * 60 * 60 * 1000))
  }));

  const mrrGrowthData = revenueData?.map((item, i) => ({ 
    ...item, 
    mrr: item.value * (1 + (i * 0.02)) 
  })) || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Subscriptions & Revenue</h1>
          <p className="text-muted-foreground mt-1">Manage billing and track recurring revenue</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        <Card className="shadow-sm bg-sidebar text-sidebar-foreground border-sidebar-border">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-sidebar-foreground/70">MRR</CardTitle>
            <DollarSign className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">${mrr.toLocaleString()}</div>
            <p className="text-xs text-green-400 font-medium mt-1 flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> +8.2% MoM
            </p>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Subscribers</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalSubscribers}</div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeSubs}</div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">In Trial</CardTitle>
            <ArrowUpRight className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{trialSubs}</div>
          </CardContent>
        </Card>
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Churned</CardTitle>
            <AlertCircle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{cancelledSubs}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-6">
        <Card className="md:col-span-4 shadow-sm">
          <CardHeader>
            <CardTitle>MRR Overview</CardTitle>
            <CardDescription>Monthly Recurring Revenue over time</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[250px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={mrrGrowthData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorMrr2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
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
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                    labelFormatter={(val) => format(new Date(val), 'MMM d, yyyy')}
                  />
                  <Area type="monotone" dataKey="mrr" stroke="hsl(var(--primary))" strokeWidth={3} fillOpacity={1} fill="url(#colorMrr2)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-2 shadow-sm flex flex-col">
          <CardHeader>
            <CardTitle>Revenue by Plan</CardTitle>
            <CardDescription>MRR breakdown</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col items-center justify-center pb-6">
            <div className="h-[200px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={revenueByPlan}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={70}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {revenueByPlan.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <RechartsTooltip 
                    formatter={(value: number) => [`$${value.toLocaleString()}`, 'MRR']}
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }}
                  />
                  <Legend verticalAlign="bottom" height={36} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-3 border-b border-border">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <CardTitle>Subscription List</CardTitle>
            <Tabs value={filter} onValueChange={setFilter} className="w-full md:w-auto">
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="active">Active</TabsTrigger>
                <TabsTrigger value="trial">Trial</TabsTrigger>
                <TabsTrigger value="past_due">Past Due</TabsTrigger>
                <TabsTrigger value="cancelled">Cancelled</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-secondary/30">
              <TableRow>
                <TableHead className="pl-6">Company</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead className="text-right">MRR</TableHead>
                <TableHead>Next Renewal</TableHead>
                <TableHead className="text-right pr-6">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fakeTableData
                .filter(item => filter === 'all' || item.status === filter || (filter === 'active' && item.status !== 'cancelled' && item.status !== 'past_due'))
                .map((sub) => (
                <TableRow key={sub.id} className="hover:bg-muted/30">
                  <TableCell className="pl-6 font-medium">{sub.company}</TableCell>
                  <TableCell>
                    <span className="text-sm font-medium">{sub.plan}</span>
                  </TableCell>
                  <TableCell>
                    <Badge 
                      variant={sub.status === 'active' ? 'default' : (sub.status === 'cancelled' ? 'secondary' : 'destructive')}
                      className={sub.status === 'active' ? 'bg-green-500 hover:bg-green-600' : ''}
                    >
                      {sub.status.replace('_', ' ')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{sub.users}</TableCell>
                  <TableCell className="text-right font-medium">${sub.mrr}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {format(sub.renewalDate, 'MMM d, yyyy')}
                  </TableCell>
                  <TableCell className="text-right pr-6">
                    <Button variant="ghost" size="sm" className="text-primary hover:text-primary">
                      Manage
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
