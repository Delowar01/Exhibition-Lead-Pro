import React, { useMemo, useState } from "react";
import {
  useListTasks,
  useListFollowUps,
  useUpdateTask,
  useDeleteTask,
  useUpdateFollowUp,
  useDeleteFollowUp,
  type Contact,
  type Task,
  type FollowUp,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import {
  CalendarClock,
  CalendarDays,
  Check,
  FileQuestion,
  LayoutList,
  ListTodo,
  MessagesSquare,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import {
  CardSkeleton,
  EmptyState,
  ErrorState,
  formatDay,
  TASK_STATUS_META,
  WorkspaceToolbar,
} from "./shared";

/* Unified activity row: tasks + follow-ups */
type ActivityItem =
  | { source: "task"; id: number; task: Task }
  | { source: "follow_up"; id: number; followUp: FollowUp };

const TASK_TYPE_META: Record<string, { label: string; icon: React.ReactNode }> = {
  call: { label: "Phone Call", icon: <Phone className="h-4 w-4" aria-hidden /> },
  follow_up: { label: "Follow-up", icon: <CalendarClock className="h-4 w-4" aria-hidden /> },
  meeting: { label: "Meeting", icon: <MessagesSquare className="h-4 w-4" aria-hidden /> },
  proposal: { label: "Proposal", icon: <FileQuestion className="h-4 w-4" aria-hidden /> },
  custom: { label: "Task", icon: <ListTodo className="h-4 w-4" aria-hidden /> },
};

function itemDate(a: ActivityItem): string | null {
  return a.source === "task" ? (a.task.dueDate ?? null) : (a.followUp.scheduledDate ?? null);
}
function itemTime(a: ActivityItem): string | null {
  return a.source === "task" ? (a.task.dueTime ?? null) : (a.followUp.scheduledTime ?? null);
}
function itemTitle(a: ActivityItem): string {
  return a.source === "task"
    ? a.task.title
    : a.followUp.notes?.trim()
      ? a.followUp.notes.split("\n")[0]
      : "Scheduled follow-up";
}
function itemStatus(a: ActivityItem): string {
  return a.source === "task" ? a.task.status : a.followUp.status;
}
function itemAssignee(a: ActivityItem): string | null {
  return a.source === "task" ? (a.task.assignedToName ?? null) : (a.followUp.assignedToName ?? null);
}
function itemIcon(a: ActivityItem): React.ReactNode {
  if (a.source === "follow_up") return TASK_TYPE_META.follow_up.icon;
  return TASK_TYPE_META[a.task.type]?.icon ?? TASK_TYPE_META.custom.icon;
}
function itemTypeLabel(a: ActivityItem): string {
  if (a.source === "follow_up") return "Follow-up";
  return TASK_TYPE_META[a.task.type]?.label ?? "Task";
}
function isDone(a: ActivityItem): boolean {
  const s = itemStatus(a);
  return s === "completed" || s === "cancelled";
}
function isOverdue(a: ActivityItem, todayStr: string): boolean {
  if (isDone(a)) return false;
  if (itemStatus(a) === "overdue") return true;
  const d = itemDate(a);
  return !!d && d < todayStr;
}

function ActivityDetails({
  item,
  contact,
  todayStr,
  onComplete,
  onDelete,
  onEdit,
  pending,
}: {
  item: ActivityItem;
  contact: Contact;
  todayStr: string;
  onComplete: () => void;
  onDelete: () => void;
  onEdit: () => void;
  pending: boolean;
}) {
  const status = itemStatus(item);
  const meta = TASK_STATUS_META[status] ?? TASK_STATUS_META.pending;
  const overdue = isOverdue(item, todayStr);
  const notes = item.source === "task" ? item.task.notes : item.followUp.notes;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5">
        <span className="h-9 w-9 rounded-full bg-primary-soft text-primary flex items-center justify-center shrink-0">
          {itemIcon(item)}
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-sm break-words">{itemTitle(item)}</p>
          <p className="text-xs text-muted-foreground">{itemTypeLabel(item)}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className={cn(overdue ? TASK_STATUS_META.overdue.cls : meta.cls)}>
          {overdue ? "Overdue" : meta.label}
        </Badge>
        {itemDate(item) && (
          <Badge variant="outline" className="bg-background">
            <CalendarDays className="h-3 w-3 mr-1" aria-hidden />
            {formatDay(itemDate(item)!)}
            {itemTime(item) ? ` · ${itemTime(item)}` : ""}
          </Badge>
        )}
      </div>
      <dl className="space-y-2 text-sm">
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Assigned To</dt>
          <dd className="font-medium flex items-center gap-1.5">
            <User className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            {itemAssignee(item) ?? "Unassigned"}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Related Contact</dt>
          <dd className="font-medium">
            {`${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "This contact"}
          </dd>
        </div>
        {contact.contactCompany && (
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Related Company</dt>
            <dd className="font-medium">{contact.contactCompany}</dd>
          </div>
        )}
      </dl>
      {notes && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Notes</p>
          <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{notes}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        {!isDone(item) && (
          <Button size="sm" onClick={onComplete} disabled={pending} data-testid="button-activity-complete">
            <Check className="h-3.5 w-3.5 mr-1.5" /> Mark Complete
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onEdit} disabled={pending}>
          <Pencil className="h-3.5 w-3.5 mr-1.5" /> Reschedule
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
          disabled={pending}
          data-testid="button-activity-delete"
        >
          <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete
        </Button>
      </div>
    </div>
  );
}

export interface ActivitiesWorkspaceProps {
  contact: Contact;
  onCreateTask: () => void;
  onScheduleFollowUp: () => void;
}

export default function ActivitiesWorkspace({
  contact,
  onCreateTask,
  onScheduleFollowUp,
}: ActivitiesWorkspaceProps) {
  const { toast } = useToast();
  const contactId = contact.id;
  const tasksQ = useListTasks({ contactId });
  const followUpsQ = useListFollowUps({ contactId });
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const updateFollowUp = useUpdateFollowUp();
  const deleteFollowUp = useDeleteFollowUp();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [view, setView] = useState<"list" | "calendar">("list");
  const [calendarDay, setCalendarDay] = useState<Date | undefined>(undefined);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [rescheduleDraft, setRescheduleDraft] = useState<{ key: string; date: string; time: string } | null>(null);

  const todayStr = format(new Date(), "yyyy-MM-dd");

  const items: ActivityItem[] = useMemo(() => {
    const list: ActivityItem[] = [
      ...(tasksQ.data?.tasks ?? []).map((t) => ({ source: "task" as const, id: t.id, task: t })),
      ...(followUpsQ.data?.followUps ?? []).map((f) => ({
        source: "follow_up" as const,
        id: f.id,
        followUp: f,
      })),
    ];
    return list.sort((a, b) => (itemDate(a) ?? "9999").localeCompare(itemDate(b) ?? "9999"));
  }, [tasksQ.data, followUpsQ.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((a) => {
      if (typeFilter === "follow_up" && !(a.source === "follow_up" || (a.source === "task" && a.task.type === "follow_up"))) return false;
      if (typeFilter !== "all" && typeFilter !== "follow_up" && !(a.source === "task" && a.task.type === typeFilter)) return false;
      if (statusFilter === "overdue" && !isOverdue(a, todayStr)) return false;
      if (statusFilter !== "all" && statusFilter !== "overdue" && itemStatus(a) !== statusFilter) return false;
      if (calendarDay && itemDate(a) !== format(calendarDay, "yyyy-MM-dd")) return false;
      if (q) {
        const hay = `${itemTitle(a)} ${itemAssignee(a) ?? ""} ${(a.source === "task" ? a.task.notes : a.followUp.notes) ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, search, statusFilter, typeFilter, todayStr, calendarDay]);

  const keyOf = (a: ActivityItem) => `${a.source}-${a.id}`;
  const selected = filtered.find((a) => keyOf(a) === selectedKey) ?? null;

  const sections = useMemo(() => {
    const todays = filtered.filter((a) => !isDone(a) && itemDate(a) === todayStr);
    const upcoming = filtered.filter(
      (a) => !isDone(a) && (itemDate(a) === null || itemDate(a)! > todayStr || isOverdue(a, todayStr)) && itemDate(a) !== todayStr,
    );
    const completed = filtered.filter((a) => isDone(a));
    return [
      { label: "Upcoming Activities", items: upcoming },
      { label: "Today's Schedule", items: todays },
      { label: "Completed Activities", items: completed },
    ].filter((s) => s.items.length > 0);
  }, [filtered, todayStr]);

  const activityDays = useMemo(() => {
    const set = new Set<string>();
    for (const a of items) {
      const d = itemDate(a);
      if (d) set.add(d);
    }
    return [...set].map((d) => new Date(`${d}T00:00:00`));
  }, [items]);

  const refetchAll = () => {
    tasksQ.refetch();
    followUpsQ.refetch();
  };

  const mutationPending =
    updateTask.isPending || deleteTask.isPending || updateFollowUp.isPending || deleteFollowUp.isPending;

  const completeItem = (a: ActivityItem) => {
    const opts = {
      onSuccess: () => {
        toast({ title: "Marked complete" });
        refetchAll();
      },
      onError: () => toast({ title: "Could not update", variant: "destructive" as const }),
    };
    if (a.source === "task") updateTask.mutate({ id: a.id, data: { status: "completed" } }, opts);
    else updateFollowUp.mutate({ id: a.id, data: { status: "completed" } }, opts);
  };

  const deleteItem = (a: ActivityItem) => {
    const opts = {
      onSuccess: () => {
        toast({ title: "Activity deleted" });
        setSelectedKey(null);
        setMobileDetailOpen(false);
        refetchAll();
      },
      onError: () => toast({ title: "Could not delete", variant: "destructive" as const }),
    };
    if (a.source === "task") deleteTask.mutate({ id: a.id }, opts);
    else deleteFollowUp.mutate({ id: a.id }, opts);
  };

  const saveReschedule = (a: ActivityItem) => {
    if (!rescheduleDraft) return;
    const opts = {
      onSuccess: () => {
        toast({ title: "Rescheduled" });
        setRescheduleDraft(null);
        refetchAll();
      },
      onError: () => toast({ title: "Could not reschedule", variant: "destructive" as const }),
    };
    if (a.source === "task")
      updateTask.mutate(
        { id: a.id, data: { dueDate: rescheduleDraft.date || null, dueTime: rescheduleDraft.time || null } },
        opts,
      );
    else
      updateFollowUp.mutate(
        {
          id: a.id,
          data: {
            scheduledDate: rescheduleDraft.date || null,
            scheduledTime: rescheduleDraft.time || null,
            status: "rescheduled",
          },
        },
        opts,
      );
  };

  const startReschedule = (a: ActivityItem) =>
    setRescheduleDraft({ key: keyOf(a), date: itemDate(a) ?? "", time: itemTime(a) ?? "" });

  const isLoading = tasksQ.isLoading || followUpsQ.isLoading;
  const isError = tasksQ.isError && followUpsQ.isError;

  const selectItem = (a: ActivityItem) => {
    setSelectedKey(keyOf(a));
    setRescheduleDraft(null);
    if (window.innerWidth < 1024) setMobileDetailOpen(true);
  };

  const detailsFor = (a: ActivityItem) => (
    <div className="space-y-4">
      <ActivityDetails
        item={a}
        contact={contact}
        todayStr={todayStr}
        pending={mutationPending}
        onComplete={() => completeItem(a)}
        onDelete={() => deleteItem(a)}
        onEdit={() => startReschedule(a)}
      />
      {rescheduleDraft?.key === keyOf(a) && (
        <div className="rounded-xl border border-border/60 p-3 space-y-2">
          <p className="text-xs font-semibold">Reschedule</p>
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="date"
              value={rescheduleDraft.date}
              onChange={(e) => setRescheduleDraft((d) => (d ? { ...d, date: e.target.value } : d))}
              aria-label="New date"
              data-testid="input-reschedule-date"
            />
            <Input
              type="time"
              value={rescheduleDraft.time}
              onChange={(e) => setRescheduleDraft((d) => (d ? { ...d, time: e.target.value } : d))}
              aria-label="New time"
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => saveReschedule(a)} disabled={mutationPending} data-testid="button-save-reschedule">
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRescheduleDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-4">
      <WorkspaceToolbar>
        <div className="relative flex-1 min-w-[150px]">
          <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search activities…"
            className="ps-8 h-9"
            aria-label="Search activities"
            data-testid="input-activities-search"
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[135px] h-9 shrink-0" data-testid="select-activities-type">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="call">Phone Call</SelectItem>
            <SelectItem value="follow_up">Follow-up</SelectItem>
            <SelectItem value="meeting">Meeting</SelectItem>
            <SelectItem value="proposal">Proposal</SelectItem>
            <SelectItem value="custom">Custom Task</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[130px] h-9 shrink-0" data-testid="select-activities-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="pending">Planned</SelectItem>
            <SelectItem value="in_progress">In Progress</SelectItem>
            <SelectItem value="overdue">Overdue</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center rounded-lg border border-border/60 p-0.5 shrink-0" role="group" aria-label="View mode">
          <Button
            variant={view === "list" ? "secondary" : "ghost"}
            size="sm"
            className="h-8 px-2.5"
            onClick={() => {
              setView("list");
              setCalendarDay(undefined);
            }}
            aria-pressed={view === "list"}
            data-testid="button-view-list"
          >
            <LayoutList className="h-4 w-4" />
            <span className="sr-only">List view</span>
          </Button>
          <Button
            variant={view === "calendar" ? "secondary" : "ghost"}
            size="sm"
            className="h-8 px-2.5"
            onClick={() => setView("calendar")}
            aria-pressed={view === "calendar"}
            data-testid="button-view-calendar"
          >
            <CalendarDays className="h-4 w-4" />
            <span className="sr-only">Calendar view</span>
          </Button>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={refetchAll}
          aria-label="Refresh activities"
        >
          <RefreshCw className={cn("h-4 w-4", (tasksQ.isFetching || followUpsQ.isFetching) && "animate-spin")} />
        </Button>
        <Button size="sm" className="shrink-0" onClick={onCreateTask} data-testid="button-create-activity">
          <Plus className="h-4 w-4 mr-1.5" /> Create Activity
        </Button>
      </WorkspaceToolbar>

      <div className="grid grid-cols-1 lg:grid-cols-[13fr_7fr] gap-5 items-start">
        <div className="space-y-5">
          {view === "calendar" && (
            <div className="rounded-2xl border border-border/60 bg-card shadow-sm p-4 flex flex-col sm:flex-row gap-4">
              <Calendar
                mode="single"
                selected={calendarDay}
                onSelect={setCalendarDay}
                modifiers={{ hasActivity: activityDays }}
                modifiersClassNames={{
                  hasActivity: "font-bold text-primary underline decoration-2 underline-offset-4",
                }}
                className="rounded-lg"
              />
              <div className="text-xs text-muted-foreground self-center">
                {calendarDay ? (
                  <>
                    Showing activities on <span className="font-medium text-foreground">{format(calendarDay, "PPP")}</span>.{" "}
                    <button type="button" className="text-primary hover:underline" onClick={() => setCalendarDay(undefined)}>
                      Clear
                    </button>
                  </>
                ) : (
                  "Days with scheduled activities are highlighted. Pick a day to filter the list."
                )}
              </div>
            </div>
          )}

          {isLoading ? (
            <CardSkeleton rows={5} />
          ) : isError ? (
            <ErrorState message="Unable to load activities." onRetry={refetchAll} />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<ListTodo className="h-5 w-5" aria-hidden />}
              headline="No activities scheduled."
              description="Plan the next step with this customer — create a task or schedule a follow-up."
              actions={
                <>
                  <Button size="sm" onClick={onCreateTask} data-testid="button-empty-create-activity">
                    <Plus className="h-4 w-4 mr-2" /> Create Activity
                  </Button>
                  <Button size="sm" variant="outline" onClick={onScheduleFollowUp}>
                    <CalendarClock className="h-4 w-4 mr-2" /> Schedule Follow-up
                  </Button>
                </>
              }
            />
          ) : (
            sections.map((s) => (
              <section key={s.label} aria-label={s.label}>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  {s.label}{" "}
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 ms-1">
                    {s.items.length}
                  </Badge>
                </p>
                <ul className="space-y-2">
                  {s.items.map((a) => {
                    const overdue = isOverdue(a, todayStr);
                    const status = itemStatus(a);
                    const meta = TASK_STATUS_META[status] ?? TASK_STATUS_META.pending;
                    const isSelected = keyOf(a) === selectedKey;
                    return (
                      <li key={keyOf(a)}>
                        <button
                          type="button"
                          onClick={() => selectItem(a)}
                          aria-pressed={isSelected}
                          className={cn(
                            "w-full max-h-24 text-start rounded-xl border px-3.5 py-2.5 transition-colors flex items-center gap-3",
                            isSelected
                              ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
                              : "border-border/60 bg-card hover:bg-secondary/40",
                          )}
                          data-testid={`activity-${keyOf(a)}`}
                        >
                          <span className="h-9 w-9 rounded-full bg-primary-soft text-primary flex items-center justify-center shrink-0">
                            {itemIcon(a)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={cn("block text-sm font-medium truncate", isDone(a) && "line-through text-muted-foreground")}>
                              {itemTitle(a)}
                            </span>
                            <span className="block text-xs text-muted-foreground truncate mt-0.5">
                              {itemTypeLabel(a)}
                              {itemDate(a) ? ` · ${formatDay(itemDate(a)!)}` : " · No due date"}
                              {itemTime(a) ? ` ${itemTime(a)}` : ""}
                              {itemAssignee(a) ? ` · ${itemAssignee(a)}` : ""}
                            </span>
                          </span>
                          <Badge
                            variant="outline"
                            className={cn("shrink-0", overdue ? TASK_STATUS_META.overdue.cls : meta.cls)}
                          >
                            {overdue ? "Overdue" : meta.label}
                          </Badge>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>

        {/* Details panel (desktop) */}
        <aside
          className="hidden lg:block sticky top-20 rounded-2xl border border-border/60 bg-card shadow-sm p-5 min-h-[220px]"
          aria-label="Activity details"
        >
          {selected ? (
            detailsFor(selected)
          ) : (
            <div className="text-center py-10">
              <ListTodo className="h-8 w-8 text-muted-foreground mx-auto mb-2" aria-hidden />
              <p className="text-sm text-muted-foreground">Select an activity to see its details.</p>
            </div>
          )}
        </aside>
      </div>

      {/* Mobile / tablet detail sheet */}
      <Sheet open={mobileDetailOpen} onOpenChange={setMobileDetailOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto lg:hidden">
          <SheetHeader>
            <SheetTitle>Activity details</SheetTitle>
          </SheetHeader>
          <div className="pt-4">{selected && detailsFor(selected)}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
