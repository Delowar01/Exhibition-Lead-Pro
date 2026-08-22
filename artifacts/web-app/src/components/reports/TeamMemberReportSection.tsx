import React, { useState } from "react";
import {
  useGetTeamMemberReport,
  getGetTeamMemberReportQueryKey,
  useListEvents,
  useListUsers,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format, parseISO } from "date-fns";
import { UserSearch } from "lucide-react";
import { fmtUSD } from "./export-shared";

// Team Member Report — faithful view over GET /reports/team-member: one
// member's capture/qualification/pipeline numbers plus their recent activity
// for a single event. All values come from the API.

function StatTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function TeamMemberReportSection() {
  const { data: eventsData, isLoading: eventsLoading } = useListEvents({ limit: 100 });
  const { data: usersData, isLoading: usersLoading } = useListUsers();
  const events = eventsData?.events ?? [];
  const users = usersData?.users ?? [];

  const [eventId, setEventId] = useState<string>("");
  const [userId, setUserId] = useState<string>("");
  const ready = eventId !== "" && userId !== "";

  const reportParams = { eventId: Number(eventId), userId: Number(userId) };
  const report = useGetTeamMemberReport(reportParams, {
    query: { enabled: ready, queryKey: getGetTeamMemberReportQueryKey(reportParams) },
  });
  const data = report.data;

  return (
    <div className="space-y-4" data-testid="team-member-report-section">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Team Member Report</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Event</Label>
              <Select value={eventId} onValueChange={setEventId}>
                <SelectTrigger className="h-9" data-testid="member-report-event">
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
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger className="h-9" data-testid="member-report-user">
                  <SelectValue placeholder={usersLoading ? "Loading members…" : "Select a team member"} />
                </SelectTrigger>
                <SelectContent>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {!ready ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center text-center gap-2">
            <UserSearch className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm font-medium">Pick an event and a team member</p>
            <p className="text-xs text-muted-foreground">
              Their captures, qualification, pipeline results and recent activity for that event.
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
            <p className="text-sm text-muted-foreground">Could not load this member&apos;s report.</p>
            <Button variant="outline" size="sm" onClick={() => report.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : data ? (
        <div className="space-y-4" data-testid="member-report-results">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatTile label="Total Leads" value={data.totalLeads.toLocaleString()} />
            <StatTile label="Qualified" value={data.qualifiedLeads.toLocaleString()} />
            <StatTile label="Meetings" value={data.meetings.toLocaleString()} />
            <StatTile label="Follow-ups" value={data.followUps.toLocaleString()} />
            <StatTile label="Won" value={data.won.toLocaleString()} />
            <StatTile label="Lost" value={data.lost.toLocaleString()} />
            <StatTile label="Pipeline Value" value={fmtUSD(data.pipelineValue)} />
            <StatTile label="Conversion" value={`${data.conversionRate}%`} />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                Recent Activity — {data.userName} at {data.eventName}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.activity.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No recorded activity for this member at this event yet.
                </p>
              ) : (
                <ul className="divide-y">
                  {data.activity.map((a, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <div className="min-w-0 flex items-center gap-2">
                        <Badge variant={a.type === "captured" ? "secondary" : "outline"} className="shrink-0">
                          {a.type === "captured" ? "Captured" : "Status"}
                        </Badge>
                        <span className="truncate">
                          <span className="font-medium">{a.contactName}</span>
                          <span className="text-muted-foreground"> — {a.label}</span>
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {format(parseISO(a.timestamp), "MMM d, yyyy HH:mm")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
