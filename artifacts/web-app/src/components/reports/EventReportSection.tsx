import React, { useState } from "react";
import {
  useGetEventReport,
  getGetEventReportQueryKey,
  useListEvents,
  useListUsers,
  ContactStatus,
  type GetEventReportParams,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from "recharts";
import { format, parseISO } from "date-fns";
import { CalendarSearch, RotateCcw } from "lucide-react";
import { fmtUSD, formatStatusLabel } from "./export-shared";

// Event Report — a thin, faithful view over GET /reports/event. Every figure
// shown comes straight from the API response; nothing is derived or invented
// beyond percentage widths for the distribution bars.

function StatTile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

export function EventReportSection() {
  const { data: eventsData, isLoading: eventsLoading } = useListEvents({ limit: 100 });
  const { data: usersData } = useListUsers();
  const events = eventsData?.events ?? [];
  const users = usersData?.users ?? [];

  const [eventId, setEventId] = useState<string>("");
  const [assignedToId, setAssignedToId] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [temperature, setTemperature] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");

  const filtersDirty =
    assignedToId !== "all" || status !== "all" || temperature !== "all" || dateFrom !== "" || dateTo !== "";

  const resetFilters = () => {
    setAssignedToId("all");
    setStatus("all");
    setTemperature("all");
    setDateFrom("");
    setDateTo("");
  };

  const reportParams: GetEventReportParams = {
    eventId: Number(eventId),
    ...(assignedToId !== "all" ? { assignedToId: Number(assignedToId) } : {}),
    ...(status !== "all" ? { status } : {}),
    ...(temperature !== "all" ? { temperature } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
  };
  const report = useGetEventReport(reportParams, {
    query: { enabled: eventId !== "", queryKey: getGetEventReportQueryKey(reportParams) },
  });

  const data = report.data;
  const qual = data?.qualificationDistribution;
  const qualTotal = qual ? qual.hot + qual.warm + qual.cold : 0;

  return (
    <div className="space-y-4" data-testid="event-report-section">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Event Report</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Event</Label>
              <Select value={eventId} onValueChange={setEventId}>
                <SelectTrigger className="h-9" data-testid="event-report-event">
                  <SelectValue placeholder={eventsLoading ? "Loading events…" : "Select an event"} />
                </SelectTrigger>
                <SelectContent>
                  {events.map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Team member</Label>
              <Select value={assignedToId} onValueChange={setAssignedToId}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Everyone</SelectItem>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {Object.values(ContactStatus).map((s) => (
                    <SelectItem key={s} value={s}>
                      {formatStatusLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Lead temperature</Label>
              <Select value={temperature} onValueChange={setTemperature}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All temperatures</SelectItem>
                  <SelectItem value="hot">Hot</SelectItem>
                  <SelectItem value="warm">Warm</SelectItem>
                  <SelectItem value="cold">Cold</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Date from</Label>
              <Input className="h-9" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Date to</Label>
              <Input className="h-9" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
          </div>
          {filtersDirty && (
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={resetFilters}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset filters
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {eventId === "" ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center text-center gap-2">
            <CalendarSearch className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">Select an event to build its report</p>
            <p className="text-xs text-muted-foreground">
              Leads, pipeline, team performance and capture sources for one event.
            </p>
          </CardContent>
        </Card>
      ) : report.isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      ) : report.isError ? (
        <Card>
          <CardContent className="py-10 text-center space-y-3">
            <p className="text-sm text-muted-foreground">Could not load the event report.</p>
            <Button variant="outline" size="sm" onClick={() => report.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : data ? (
        <div className="space-y-4" data-testid="event-report-results">
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
            <StatTile label="Total Leads" value={data.totalLeads.toLocaleString()} />
            <StatTile label="Hot" value={data.hotLeads.toLocaleString()} tone="text-red-500" />
            <StatTile label="Warm" value={data.warmLeads.toLocaleString()} tone="text-amber-500" />
            <StatTile label="Cold" value={data.coldLeads.toLocaleString()} tone="text-sky-500" />
            <StatTile label="Meetings" value={data.meetings.toLocaleString()} />
            <StatTile label="Follow-ups" value={data.followUps.toLocaleString()} />
            <StatTile label="Won / Lost" value={`${data.wonDeals} / ${data.lostDeals}`} />
            <StatTile label="Pipeline Value" value={fmtUSD(data.pipelineValue)} />
          </div>

          {data.totalLeads === 0 ? (
            <Card>
              <CardContent className="py-10 text-center">
                <p className="text-sm font-medium">No leads match this selection</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Try a wider date range or clear the filters.
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid lg:grid-cols-2 gap-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Leads by Day</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[220px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={data.leadsByDay} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                          <XAxis
                            dataKey="date"
                            tickFormatter={(v) => format(parseISO(v), "MMM d")}
                            stroke="hsl(var(--muted-foreground))"
                            fontSize={11}
                            tickLine={false}
                            axisLine={false}
                          />
                          <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                          <Tooltip
                            contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))" }}
                            labelFormatter={(v) => format(parseISO(String(v)), "MMM d, yyyy")}
                          />
                          <Bar dataKey="count" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} name="Leads" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Qualification &amp; Status</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {qual && qualTotal > 0 && (
                      <div className="space-y-1.5">
                        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
                          <div className="bg-red-500" style={{ width: `${(qual.hot / qualTotal) * 100}%` }} />
                          <div className="bg-amber-500" style={{ width: `${(qual.warm / qualTotal) * 100}%` }} />
                          <div className="bg-sky-500" style={{ width: `${(qual.cold / qualTotal) * 100}%` }} />
                        </div>
                        <div className="flex gap-4 text-xs text-muted-foreground">
                          <span><span className="text-red-500 font-medium">{qual.hot}</span> hot</span>
                          <span><span className="text-amber-500 font-medium">{qual.warm}</span> warm</span>
                          <span><span className="text-sky-500 font-medium">{qual.cold}</span> cold</span>
                        </div>
                      </div>
                    )}
                    <div className="space-y-1">
                      {data.statusDistribution.map((s) => (
                        <div key={s.status} className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">{formatStatusLabel(s.status)}</span>
                          <span className="font-medium tabular-nums">{s.count}</span>
                        </div>
                      ))}
                    </div>
                    {data.leadSourceBreakdown.length > 0 && (
                      <div className="border-t pt-3 space-y-1">
                        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Lead source</div>
                        {data.leadSourceBreakdown.map((s) => (
                          <div key={s.source} className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">{s.source}</span>
                            <span className="font-medium tabular-nums">{s.count}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Team Performance — {data.eventName}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="rounded-md border overflow-x-auto">
                    <Table>
                      <TableHeader className="bg-secondary/50">
                        <TableRow>
                          <TableHead>Team member</TableHead>
                          <TableHead className="text-right">Leads</TableHead>
                          <TableHead className="text-right">Qualified</TableHead>
                          <TableHead className="text-right">Hot</TableHead>
                          <TableHead className="text-right">Won</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.teamPerformance.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={5} className="text-center py-6 text-muted-foreground">
                              No assigned team activity for this selection.
                            </TableCell>
                          </TableRow>
                        ) : (
                          data.teamPerformance.map((m) => (
                            <TableRow key={m.userId}>
                              <TableCell className="font-medium">{m.userName}</TableCell>
                              <TableCell className="text-right tabular-nums">{m.leads}</TableCell>
                              <TableCell className="text-right tabular-nums">{m.qualified}</TableCell>
                              <TableCell className="text-right tabular-nums">{m.hotLeads}</TableCell>
                              <TableCell className="text-right tabular-nums font-medium text-primary">{m.won}</TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
