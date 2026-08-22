import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useGetLeadsByEvent, useGetTeamPerformance, useGetScanActivity } from "@workspace/api-client-react";
import { Bar, BarChart, Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from "recharts";
import { format } from "date-fns";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EventReportSection } from "@/components/reports/EventReportSection";
import { TeamMemberReportSection } from "@/components/reports/TeamMemberReportSection";
import { ExportCenterPanel } from "@/components/reports/ExportCenterPanel";
import { ExportHistoryPanel } from "@/components/reports/ExportHistoryPanel";
import { ExportSchedulesPanel } from "@/components/reports/ExportSchedulesPanel";

// Reports & Export Center workspace (Batch 9). One page, four areas:
//   Reports        — overview charts + Event Report + Team Member Report
//   Export Center  — on-demand filtered exports (CSV/Excel/PDF/JSON)
//   Schedules      — recurring export schedules (CRUD, run now)
//   Export History — every generated file with signed downloads
// All data comes from the existing tenant-scoped, permission-gated APIs.

function OverviewPanel() {
  const { data: scanActivity, isLoading: isLoadingScan } = useGetScanActivity();
  const { data: leadsByEvent, isLoading: isLoadingLeads } = useGetLeadsByEvent();
  const { data: teamPerf, isLoading: isLoadingTeam } = useGetTeamPerformance();

  if (isLoadingScan || isLoadingLeads || isLoadingTeam) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-[340px] rounded-lg" />
        <div className="grid md:grid-cols-2 gap-6">
          <Skeleton className="h-[340px] rounded-lg" />
          <Skeleton className="h-[340px] rounded-lg" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Scan Activity Trend (Last 30 Days)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={scanActivity || []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorScan" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(val) => format(new Date(val), "MMM d")}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))" }}
                  labelFormatter={(val) => format(new Date(val), "MMM d, yyyy")}
                />
                <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} fillOpacity={1} fill="url(#colorScan)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Leads by Event</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={leadsByEvent || []} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="eventName" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))" }} />
                  <Bar dataKey="leadCount" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} name="Leads" />
                  <Bar dataKey="wonCount" fill="hsl(var(--chart-3))" radius={[4, 4, 0, 0]} name="Won" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Team Performance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <Table>
                <TableHeader className="bg-secondary/50">
                  <TableRow>
                    <TableHead>Team Member</TableHead>
                    <TableHead className="text-right">Scans</TableHead>
                    <TableHead className="text-right">Leads</TableHead>
                    <TableHead className="text-right">Won</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {teamPerf?.map((member) => (
                    <TableRow key={member.userId}>
                      <TableCell className="font-medium">{member.userName}</TableCell>
                      <TableCell className="text-right">{member.scanCount}</TableCell>
                      <TableCell className="text-right">{member.leadCount}</TableCell>
                      <TableCell className="text-right font-medium text-primary">{member.wonCount || 0}</TableCell>
                    </TableRow>
                  ))}
                  {(!teamPerf || teamPerf.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-4 text-muted-foreground">
                        No performance data.
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

export default function AdminReports() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Reports &amp; Analytics</h1>
      </div>

      <Tabs defaultValue="reports">
        <TabsList data-testid="reports-workspace-tabs">
          <TabsTrigger value="reports" data-testid="tab-reports">Reports</TabsTrigger>
          <TabsTrigger value="export" data-testid="tab-export">Export Center</TabsTrigger>
          <TabsTrigger value="schedules" data-testid="tab-schedules">Schedules</TabsTrigger>
          <TabsTrigger value="history" data-testid="tab-history">Export History</TabsTrigger>
        </TabsList>

        <TabsContent value="reports" className="mt-4">
          <Tabs defaultValue="overview">
            <TabsList className="h-8">
              <TabsTrigger value="overview" className="text-xs px-3" data-testid="subtab-overview">Overview</TabsTrigger>
              <TabsTrigger value="event" className="text-xs px-3" data-testid="subtab-event">Event Report</TabsTrigger>
              <TabsTrigger value="member" className="text-xs px-3" data-testid="subtab-member">Team Member</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="mt-4">
              <OverviewPanel />
            </TabsContent>
            <TabsContent value="event" className="mt-4">
              <EventReportSection />
            </TabsContent>
            <TabsContent value="member" className="mt-4">
              <TeamMemberReportSection />
            </TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="export" className="mt-4">
          <ExportCenterPanel />
        </TabsContent>

        <TabsContent value="schedules" className="mt-4">
          <ExportSchedulesPanel />
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <ExportHistoryPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
