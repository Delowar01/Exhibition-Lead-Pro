import React from "react";
import { format, parseISO, isToday, isYesterday, isThisWeek } from "date-fns";
import {
  useGetLeadTimeline,
  getGetLeadTimelineQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Calendar as CalendarIcon,
  CheckCircle2,
  Clock,
  MessageSquare,
  FileText,
} from "lucide-react";

function fmtDateTime(s?: string | null): string {
  if (!s) return "";
  try {
    return format(parseISO(s), "MMM d, yyyy h:mm a");
  } catch {
    return s;
  }
}

function timelineIconFor(kind: string) {
  switch (kind) {
    case "activity":
    case "meeting":
      return <MessageSquare className="h-3 w-3 text-primary-foreground" />;
    case "note":
      return <FileText className="h-3 w-3 text-primary-foreground" />;
    case "scan":
      return <CalendarIcon className="h-3 w-3 text-primary-foreground" />;
    case "lead_history":
    case "contact_status":
      return <CheckCircle2 className="h-3 w-3 text-primary-foreground" />;
    default:
      return <Clock className="h-3 w-3 text-primary-foreground" />;
  }
}

export function LeadTimelineCard({ leadId }: { leadId: number }) {
  const { data, isLoading } = useGetLeadTimeline(leadId, {
    query: { enabled: !!leadId, queryKey: getGetLeadTimelineQueryKey(leadId) },
  });

  if (isLoading) {
    return (
      <Card className="shadow-sm">
        <CardContent className="p-8 text-center text-muted-foreground">
          Loading timeline...
        </CardContent>
      </Card>
    );
  }

  const events = data?.entries ?? [];

  if (events.length === 0) {
    return (
      <Card className="shadow-sm">
        <CardContent className="p-8 text-center text-muted-foreground text-sm">
          No interaction history found.
        </CardContent>
      </Card>
    );
  }

  // Group events by day/week
  const grouped = events.reduce((acc, event) => {
    const d = parseISO(event.occurredAt);
    let group = "Older";
    if (isToday(d)) group = "Today";
    else if (isYesterday(d)) group = "Yesterday";
    else if (isThisWeek(d)) group = "This Week";
    else group = format(d, "MMMM yyyy");

    if (!acc[group]) acc[group] = [];
    acc[group].push(event);
    return acc;
  }, {} as Record<string, typeof events>);

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3 border-b border-border mb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" /> Interaction Timeline
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative pl-6 border-l-2 border-muted space-y-8 py-2">
          {Object.entries(grouped).map(([groupName, groupEvents]) => (
            <div key={groupName} className="relative">
              <div className="absolute -left-[35px] bg-background text-muted-foreground text-xs font-medium px-2 py-1 rounded-full border border-muted z-10 whitespace-nowrap -top-3">
                {groupName}
              </div>
              <div className="space-y-6 pt-4">
                {groupEvents.map((event, idx) => (
                  <div key={idx} className="relative">
                    <div className="absolute -left-[33px] top-1 h-6 w-6 rounded-full bg-primary flex items-center justify-center ring-4 ring-background z-10">
                      {timelineIconFor(event.kind)}
                    </div>
                    <div className="bg-muted/30 rounded-lg p-3 border border-border/50 hover:bg-muted/50 transition-colors">
                      <div className="flex justify-between items-start mb-1">
                        <span className="font-semibold text-sm">{event.title}</span>
                        <span className="text-[11px] text-muted-foreground flex-shrink-0">
                          {fmtDateTime(event.occurredAt)}
                        </span>
                      </div>
                      {event.body && (
                        <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                          {event.body}
                        </p>
                      )}
                      {event.actorName && (
                        <p className="text-[11px] text-muted-foreground mt-2 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-primary/50" />
                          {event.actorName}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
