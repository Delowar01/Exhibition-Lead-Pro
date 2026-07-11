import React, { useMemo, useState } from "react";
import {
  useGetContactTimeline,
  type Contact,
  type TimelineEntry,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Activity as ActivityIcon,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Flag,
  History,
  ListTodo,
  Mail,
  MessagesSquare,
  Phone,
  RefreshCw,
  ScanLine,
  Search,
  StickyNote,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CardSkeleton,
  EmptyState,
  ErrorState,
  formatTimestamp,
  relativeAge,
  TIMELINE_GROUPS,
  timelineGroupFor,
  WorkspaceToolbar,
  type TimelineGroup,
} from "./shared";

const KIND_META: Record<string, { label: string; icon: React.ReactNode }> = {
  activity: { label: "Activity", icon: <ActivityIcon className="h-4 w-4" aria-hidden /> },
  note: { label: "Note", icon: <StickyNote className="h-4 w-4" aria-hidden /> },
  lead_history: { label: "Lead History", icon: <History className="h-4 w-4" aria-hidden /> },
  contact_status: { label: "Status Change", icon: <Flag className="h-4 w-4" aria-hidden /> },
  follow_up: { label: "Follow-up", icon: <CalendarClock className="h-4 w-4" aria-hidden /> },
  meeting: { label: "Meeting", icon: <MessagesSquare className="h-4 w-4" aria-hidden /> },
  task: { label: "Task", icon: <ListTodo className="h-4 w-4" aria-hidden /> },
  scan: { label: "Card Scan", icon: <ScanLine className="h-4 w-4" aria-hidden /> },
};

/* Sub-type icons for activity entries (call/email/whatsapp/…) */
const TYPE_ICON: Record<string, React.ReactNode> = {
  call: <Phone className="h-4 w-4" aria-hidden />,
  email: <Mail className="h-4 w-4" aria-hidden />,
  message: <MessagesSquare className="h-4 w-4" aria-hidden />,
  meeting: <MessagesSquare className="h-4 w-4" aria-hidden />,
};

function entryIcon(e: TimelineEntry): React.ReactNode {
  if (e.type && TYPE_ICON[e.type]) return TYPE_ICON[e.type];
  return KIND_META[e.kind]?.icon ?? <ActivityIcon className="h-4 w-4" aria-hidden />;
}

function entryTypeLabel(e: TimelineEntry): string {
  if (e.type) return e.type.replace(/_/g, " ");
  return KIND_META[e.kind]?.label ?? e.kind.replace(/_/g, " ");
}

function EventDetails({ entry, contact }: { entry: TimelineEntry; contact: Contact }) {
  const metadata =
    entry.metadata && typeof entry.metadata === "object"
      ? (entry.metadata as Record<string, unknown>)
      : null;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="h-9 w-9 rounded-full bg-primary-soft text-primary flex items-center justify-center shrink-0">
          {entryIcon(entry)}
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-sm truncate">{entry.title ?? entryTypeLabel(entry)}</p>
          <p className="text-xs text-muted-foreground capitalize">{entryTypeLabel(entry)}</p>
        </div>
      </div>
      {entry.body && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            Description
          </p>
          <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{entry.body}</p>
        </div>
      )}
      <dl className="space-y-2 text-sm">
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">When</dt>
          <dd className="font-medium">{formatTimestamp(entry.occurredAt)}</dd>
        </div>
        {entry.actorName && (
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">By</dt>
            <dd className="font-medium flex items-center gap-1.5">
              <User className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> {entry.actorName}
            </dd>
          </div>
        )}
        {contact.contactCompany && (
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Related Company
            </dt>
            <dd className="font-medium">{contact.contactCompany}</dd>
          </div>
        )}
      </dl>
      {metadata && Object.keys(metadata).length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
            Details
          </p>
          <dl className="space-y-1.5">
            {Object.entries(metadata)
              .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
              .slice(0, 8)
              .map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-3 text-xs">
                  <dt className="text-muted-foreground capitalize shrink-0">
                    {k.replace(/([A-Z])/g, " $1").replace(/_/g, " ")}
                  </dt>
                  <dd className="font-medium text-end break-words min-w-0">{String(v)}</dd>
                </div>
              ))}
          </dl>
        </div>
      )}
      <div className="rounded-lg border border-border/60 bg-secondary/20 px-3 py-2 text-[11px] text-muted-foreground">
        Recorded {formatTimestamp(entry.occurredAt)}
        {entry.actorName ? ` by ${entry.actorName}` : ""} · Event ID {entry.id}
      </div>
    </div>
  );
}

export interface TimelineWorkspaceProps {
  contact: Contact;
  onAddNote: () => void;
  onScheduleFollowUp: () => void;
}

export default function TimelineWorkspace({
  contact,
  onAddNote,
  onScheduleFollowUp,
}: TimelineWorkspaceProps) {
  const timelineQ = useGetContactTimeline(contact.id);
  const entries = timelineQ.data?.entries ?? [];

  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<TimelineGroup>>(() => {
    try {
      const raw = localStorage.getItem("csp_timeline_collapsed");
      return raw ? new Set(JSON.parse(raw) as TimelineGroup[]) : new Set();
    } catch {
      return new Set();
    }
  });
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const owners = useMemo(() => {
    const set = new Map<string, string>();
    for (const e of entries) if (e.actorName) set.set(e.actorName, e.actorName);
    return [...set.keys()].sort();
  }, [entries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (kindFilter !== "all" && e.kind !== kindFilter) return false;
      if (ownerFilter !== "all" && e.actorName !== ownerFilter) return false;
      if (q) {
        const hay = `${e.title ?? ""} ${e.body ?? ""} ${e.actorName ?? ""} ${e.type ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [entries, search, kindFilter, ownerFilter]);

  const groups = useMemo(() => {
    const map = new Map<TimelineGroup, TimelineEntry[]>();
    for (const e of filtered) {
      const g = timelineGroupFor(e.occurredAt);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(e);
    }
    return TIMELINE_GROUPS.filter((g) => map.has(g)).map((g) => ({ label: g, items: map.get(g)! }));
  }, [filtered]);

  const toggleGroup = (g: TimelineGroup) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      try {
        localStorage.setItem("csp_timeline_collapsed", JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const selected = filtered.find((e) => e.id === selectedId) ?? null;

  /* Deterministic timeline intelligence (spec §94) */
  const intel = useMemo(() => {
    const calls = entries.filter((e) => e.type === "call").length;
    const emails = entries.filter((e) => e.type === "email").length;
    const meetings = entries.filter((e) => e.kind === "meeting" || e.type === "meeting").length;
    return { calls, emails, meetings, total: entries.length };
  }, [entries]);

  const selectEntry = (id: string) => {
    setSelectedId(id);
    if (window.innerWidth < 1024) setMobileDetailOpen(true);
  };

  return (
    <div className="space-y-4">
      <WorkspaceToolbar>
        <div className="relative flex-1 min-w-[160px]">
          <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search timeline…"
            className="ps-8 h-9"
            aria-label="Search timeline events"
            data-testid="input-timeline-search"
          />
        </div>
        <Select value={kindFilter} onValueChange={setKindFilter}>
          <SelectTrigger className="w-[150px] h-9 shrink-0" data-testid="select-timeline-kind">
            <SelectValue placeholder="Event type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {Object.entries(KIND_META).map(([k, m]) => (
              <SelectItem key={k} value={k}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {owners.length > 0 && (
          <Select value={ownerFilter} onValueChange={setOwnerFilter}>
            <SelectTrigger className="w-[140px] h-9 shrink-0" data-testid="select-timeline-owner">
              <SelectValue placeholder="Owner" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All owners</SelectItem>
              {owners.map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={() => timelineQ.refetch()}
          aria-label="Refresh timeline"
          data-testid="button-timeline-refresh"
        >
          <RefreshCw className={cn("h-4 w-4", timelineQ.isFetching && "animate-spin")} />
        </Button>
      </WorkspaceToolbar>

      {/* Deterministic intelligence strip */}
      {entries.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground px-1">
          <span>
            Relationship age: <span className="font-medium text-foreground">{relativeAge(contact.createdAt)}</span>
          </span>
          <span>
            Last contact:{" "}
            <span className="font-medium text-foreground">{relativeAge(entries[0].occurredAt)} ago</span>
          </span>
          <span>
            Events: <span className="font-medium text-foreground">{intel.total}</span>
          </span>
          <span>
            Calls: <span className="font-medium text-foreground">{intel.calls}</span>
          </span>
          <span>
            Emails: <span className="font-medium text-foreground">{intel.emails}</span>
          </span>
          <span>
            Meetings: <span className="font-medium text-foreground">{intel.meetings}</span>
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[7fr_3fr] gap-5 items-start">
        {/* Feed */}
        <div>
          {timelineQ.isLoading ? (
            <CardSkeleton rows={6} />
          ) : timelineQ.isError ? (
            <ErrorState message="Timeline could not be loaded." onRetry={() => timelineQ.refetch()} />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<History className="h-5 w-5" aria-hidden />}
              headline="No timeline events found."
              description={
                search || kindFilter !== "all" || ownerFilter !== "all"
                  ? "Try adjusting your search or filters."
                  : "Interactions, notes, and status changes will build the relationship record here."
              }
              actions={
                !search && kindFilter === "all" ? (
                  <>
                    <Button size="sm" onClick={onAddNote}>
                      <StickyNote className="h-4 w-4 mr-2" /> Add Note
                    </Button>
                    <Button size="sm" variant="outline" onClick={onScheduleFollowUp}>
                      <CalendarClock className="h-4 w-4 mr-2" /> Schedule Activity
                    </Button>
                  </>
                ) : undefined
              }
            />
          ) : (
            <div className="space-y-4">
              {groups.map((g) => {
                const collapsed = collapsedGroups.has(g.label);
                return (
                  <section key={g.label} aria-label={g.label}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.label)}
                      className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground mb-2"
                      aria-expanded={!collapsed}
                      data-testid={`group-toggle-${g.label.replace(/\s/g, "-").toLowerCase()}`}
                    >
                      {collapsed ? (
                        <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                      )}
                      {g.label}
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                        {g.items.length}
                      </Badge>
                    </button>
                    {!collapsed && (
                      <ul className="space-y-2">
                        {g.items.map((e) => {
                          const isSelected = e.id === selectedId;
                          return (
                            <li key={e.id}>
                              <button
                                type="button"
                                onClick={() => selectEntry(e.id)}
                                aria-pressed={isSelected}
                                className={cn(
                                  "w-full max-h-24 overflow-hidden text-start rounded-xl border px-3.5 py-2.5 transition-colors flex items-start gap-3",
                                  isSelected
                                    ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
                                    : "border-border/60 bg-card hover:bg-secondary/40",
                                )}
                                data-testid={`timeline-event-${e.id}`}
                              >
                                <span className="h-8 w-8 rounded-full bg-primary-soft text-primary flex items-center justify-center shrink-0 mt-0.5">
                                  {entryIcon(e)}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center gap-2 min-w-0">
                                    <span className="text-sm font-medium truncate">
                                      {e.title ?? entryTypeLabel(e)}
                                    </span>
                                    <Badge variant="outline" className="text-[10px] capitalize shrink-0 hidden sm:inline-flex">
                                      {entryTypeLabel(e)}
                                    </Badge>
                                  </span>
                                  {e.body && (
                                    <span className="block text-xs text-muted-foreground truncate mt-0.5">
                                      {e.body}
                                    </span>
                                  )}
                                  <span className="block text-[11px] text-muted-foreground mt-0.5 truncate">
                                    {formatTimestamp(e.occurredAt)}
                                    {e.actorName ? ` · ${e.actorName}` : ""}
                                  </span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>

        {/* Preview panel (desktop) */}
        <aside className="hidden lg:block sticky top-20 rounded-2xl border border-border/60 bg-card shadow-sm p-5 min-h-[240px]" aria-label="Event preview">
          {selected ? (
            <EventDetails entry={selected} contact={contact} />
          ) : (
            <div className="text-center py-10">
              <History className="h-8 w-8 text-muted-foreground mx-auto mb-2" aria-hidden />
              <p className="text-sm text-muted-foreground">Select an event to preview its details.</p>
            </div>
          )}
        </aside>
      </div>

      {/* Mobile / tablet detail sheet */}
      <Sheet open={mobileDetailOpen} onOpenChange={setMobileDetailOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto lg:hidden">
          <SheetHeader>
            <SheetTitle>Event details</SheetTitle>
          </SheetHeader>
          <div className="pt-4">
            {selected && <EventDetails entry={selected} contact={contact} />}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
