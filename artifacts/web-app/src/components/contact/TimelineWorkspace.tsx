import React, { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetContactTimeline,
  useListTasks,
  useListFollowUps,
  useUpdateTask,
  useDeleteTask,
  useUpdateFollowUp,
  useDeleteFollowUp,
  useLogContactCommunication,
  useCreateContactCalendarInvite,
  useListContactInteractions,
  getListContactCommunicationsQueryKey,
  getGetContactTimelineQueryKey,
  getListContactInteractionsQueryKey,
  type Contact,
  type TimelineEntry,
  type Task,
  type FollowUp,
  type Interaction,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Activity as ActivityIcon,
  Calendar,
  CalendarClock,
  CalendarPlus,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  CreditCard,
  FileInput,
  History,
  ListTodo,
  Mail,
  MapPin,
  MessageCircle,
  MessagesSquare,
  Nfc,
  PenLine,
  Pencil,
  Phone,
  Plus,
  QrCode,
  RefreshCw,
  ScanLine,
  Search,
  Sparkles,
  StickyNote,
  Trash2,
  User,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import {
  CardSkeleton,
  EmptyState,
  ErrorState,
  formatTimestamp,
  relativeAge,
  StatTile,
  TASK_STATUS_META,
  TIMELINE_GROUPS,
  timelineGroupFor,
  WorkspaceToolbar,
  type TimelineGroup,
} from "./shared";

/* ── Unified timeline item model (Timeline entries + Tasks + Follow-ups) ──── */

type UnifiedKind =
  | "call"
  | "email"
  | "whatsapp"
  | "meeting"
  | "note"
  | "task"
  | "follow_up"
  | "capture"
  | "system";

interface UnifiedItem {
  key: string;
  kind: UnifiedKind;
  title: string;
  body: string | null;
  occurredAt: string;
  actorName: string | null;
  entry?: TimelineEntry;
  task?: Task;
  followUp?: FollowUp;
  capture?: Interaction;
}

const KIND_META: Record<UnifiedKind, { label: string; icon: React.ReactNode }> = {
  call: { label: "Call", icon: <Phone className="h-4 w-4" aria-hidden /> },
  email: { label: "Email", icon: <Mail className="h-4 w-4" aria-hidden /> },
  whatsapp: { label: "WhatsApp", icon: <MessageCircle className="h-4 w-4" aria-hidden /> },
  meeting: { label: "Meeting", icon: <MessagesSquare className="h-4 w-4" aria-hidden /> },
  note: { label: "Note", icon: <StickyNote className="h-4 w-4" aria-hidden /> },
  task: { label: "Task", icon: <ListTodo className="h-4 w-4" aria-hidden /> },
  follow_up: { label: "Follow-up", icon: <CalendarClock className="h-4 w-4" aria-hidden /> },
  capture: { label: "Capture", icon: <ScanLine className="h-4 w-4" aria-hidden /> },
  system: { label: "System", icon: <History className="h-4 w-4" aria-hidden /> },
};

const CAPTURE_SOURCE_META: Record<string, { label: string; icon: React.ReactNode }> = {
  camera: { label: "Card Scan", icon: <Camera className="h-4 w-4" aria-hidden /> },
  qr: { label: "QR Code", icon: <QrCode className="h-4 w-4" aria-hidden /> },
  vcard: { label: "vCard", icon: <CreditCard className="h-4 w-4" aria-hidden /> },
  digital_card: { label: "Digital Card", icon: <CreditCard className="h-4 w-4" aria-hidden /> },
  email_signature: { label: "Email Signature", icon: <Mail className="h-4 w-4" aria-hidden /> },
  nfc: { label: "NFC", icon: <Nfc className="h-4 w-4" aria-hidden /> },
  manual: { label: "Manual Entry", icon: <PenLine className="h-4 w-4" aria-hidden /> },
  import: { label: "Import", icon: <FileInput className="h-4 w-4" aria-hidden /> },
};

const FILTER_CHIPS: { key: "all" | UnifiedKind; label: string }[] = [
  { key: "all", label: "All Events" },
  { key: "call", label: "Calls" },
  { key: "email", label: "Emails" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "meeting", label: "Meetings" },
  { key: "task", label: "Tasks" },
  { key: "follow_up", label: "Follow-ups" },
  { key: "note", label: "Notes" },
  { key: "capture", label: "Captures" },
  { key: "system", label: "System" },
];

function entryToUnifiedKind(e: TimelineEntry): UnifiedKind {
  if (e.type === "call") return "call";
  if (e.type === "email") return "email";
  if (e.type === "message" || e.type === "whatsapp") return "whatsapp";
  if (e.kind === "meeting" || e.type === "meeting") return "meeting";
  if (e.kind === "note") return "note";
  if (e.kind === "scan") return "capture";
  return "system"; // lead_history / contact_status
}

function entryIcon(kind: UnifiedKind, captureSource?: string | null): React.ReactNode {
  if (kind === "capture" && captureSource && CAPTURE_SOURCE_META[captureSource]) {
    return CAPTURE_SOURCE_META[captureSource].icon;
  }
  return KIND_META[kind]?.icon ?? <ActivityIcon className="h-4 w-4" aria-hidden />;
}

function normalizePhone(p: string): string {
  return p.replace(/[^\d+]/g, "");
}

function parseOcr(raw: unknown): Record<string, string> | null {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val != null && (typeof val === "string" || typeof val === "number")) {
      const s = String(val).trim();
      if (s) out[k] = s;
    }
  }
  return Object.keys(out).length ? out : null;
}

function itemDate(a: UnifiedItem): string {
  return a.occurredAt;
}
function isDone(a: UnifiedItem): boolean {
  if (a.task) return a.task.status === "completed";
  if (a.followUp) return a.followUp.status === "completed" || a.followUp.status === "cancelled";
  return true;
}
function isOverdue(a: UnifiedItem, todayStr: string): boolean {
  if (isDone(a)) return false;
  if (a.task) {
    if (a.task.status === "overdue") return true;
    return !!a.task.dueDate && a.task.dueDate < todayStr;
  }
  if (a.followUp) {
    return !!a.followUp.scheduledDate && a.followUp.scheduledDate < todayStr;
  }
  return false;
}
function itemStatusMeta(a: UnifiedItem) {
  const status = a.task?.status ?? a.followUp?.status;
  if (!status) return null;
  return TASK_STATUS_META[status] ?? TASK_STATUS_META.pending;
}

function UnifiedDetails({
  item,
  contact,
  todayStr,
  onComplete,
  onDelete,
  onEdit,
  pending,
  rescheduleDraft,
  setRescheduleDraft,
  onSaveReschedule,
}: {
  item: UnifiedItem;
  contact: Contact;
  todayStr: string;
  onComplete: () => void;
  onDelete: () => void;
  onEdit: () => void;
  pending: boolean;
  rescheduleDraft: { key: string; date: string; time: string } | null;
  setRescheduleDraft: React.Dispatch<
    React.SetStateAction<{ key: string; date: string; time: string } | null>
  >;
  onSaveReschedule: () => void;
}) {
  const meta = KIND_META[item.kind];
  const overdue = isOverdue(item, todayStr);
  const statusMeta = itemStatusMeta(item);
  const isActionable = !!item.task || !!item.followUp;
  const metadata =
    item.entry?.metadata && typeof item.entry.metadata === "object"
      ? (item.entry.metadata as Record<string, unknown>)
      : null;

  // ── Rich capture/scan rendering (business card scans, QR, vCard, etc.) ────
  if (item.kind === "capture" && item.capture) {
    const cap = item.capture;
    const src = CAPTURE_SOURCE_META[cap.captureSource ?? ""] ?? {
      label: cap.captureSource ?? "Capture",
      icon: <ScanLine className="h-4 w-4" aria-hidden />,
    };
    const ocr = parseOcr(cap.ocrData);
    const hasGps = cap.latitude != null && cap.longitude != null;
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2.5">
          <span className="h-9 w-9 rounded-full bg-primary-soft text-primary flex items-center justify-center shrink-0">
            {src.icon}
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-sm break-words">{src.label}</p>
            <p className="text-xs text-muted-foreground">{formatTimestamp(cap.occurredAt)}</p>
          </div>
        </div>

        <dl className="space-y-2.5 text-sm">
          {cap.userName && (
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Captured By</dt>
              <dd className="font-medium flex items-center gap-1.5">
                <User className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> {cap.userName}
              </dd>
            </div>
          )}
          {cap.eventName && (
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Event</dt>
              <dd className="font-medium flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> {cap.eventName}
              </dd>
            </div>
          )}
          {hasGps && (
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Location</dt>
              <dd className="font-medium flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                {Number(cap.latitude).toFixed(5)}, {Number(cap.longitude).toFixed(5)}
              </dd>
            </div>
          )}
          {cap.notes && (
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Notes</dt>
              <dd className="whitespace-pre-wrap break-words">{cap.notes}</dd>
            </div>
          )}
        </dl>

        {cap.aiSummary && (
          <div className="rounded-xl border border-primary/20 bg-primary-soft/50 p-3">
            <p className="text-[11px] uppercase tracking-wider text-primary font-semibold flex items-center gap-1.5 mb-1">
              <Sparkles className="h-3.5 w-3.5" aria-hidden /> AI Summary
            </p>
            <p className="text-sm">{cap.aiSummary}</p>
          </div>
        )}

        {cap.imageUrl && (
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Captured Card</p>
            <img
              src={cap.imageUrl}
              alt="Captured business card"
              className="rounded-lg border border-border/60 max-h-56 w-auto"
              loading="lazy"
            />
          </div>
        )}

        {ocr && (
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Extracted Data</p>
            <dl className="rounded-xl border border-border/60 divide-y divide-border/60 text-sm">
              {Object.entries(ocr).map(([k, v]) => (
                <div key={k} className="flex items-start gap-3 px-3 py-1.5">
                  <dt className="w-28 shrink-0 text-xs text-muted-foreground capitalize pt-0.5">
                    {k.replace(/([A-Z])/g, " $1").replace(/_/g, " ")}
                  </dt>
                  <dd className="min-w-0 break-words font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5">
        <span className="h-9 w-9 rounded-full bg-primary-soft text-primary flex items-center justify-center shrink-0">
          {entryIcon(item.kind)}
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-sm break-words">{item.title}</p>
          <p className="text-xs text-muted-foreground">{meta.label}</p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {statusMeta && (
          <Badge variant="outline" className={cn(overdue ? TASK_STATUS_META.overdue.cls : statusMeta.cls)}>
            {overdue ? "Overdue" : statusMeta.label}
          </Badge>
        )}
        <Badge variant="outline" className="bg-background">
          {formatTimestamp(item.occurredAt)}
        </Badge>
      </div>

      {item.body && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
            {isActionable ? "Notes" : "Description"}
          </p>
          <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{item.body}</p>
        </div>
      )}

      <dl className="space-y-2 text-sm">
        {item.actorName && (
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
              {isActionable ? "Assigned To" : "By"}
            </dt>
            <dd className="font-medium flex items-center gap-1.5">
              <User className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> {item.actorName}
            </dd>
          </div>
        )}
        {contact.contactCompany && (
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Related Company</dt>
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

      {isActionable && (
        <div className="flex flex-wrap gap-2 pt-1">
          {!isDone(item) && (
            <Button size="sm" onClick={onComplete} disabled={pending} data-testid="button-timeline-complete">
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
            data-testid="button-timeline-delete"
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete
          </Button>
        </div>
      )}

      {isActionable && rescheduleDraft?.key === item.key && (
        <div className="rounded-xl border border-border/60 p-3 space-y-2">
          <p className="text-xs font-semibold">Reschedule</p>
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="date"
              value={rescheduleDraft.date}
              onChange={(e) => setRescheduleDraft((d) => (d ? { ...d, date: e.target.value } : d))}
              aria-label="New date"
              data-testid="input-timeline-reschedule-date"
            />
            <Input
              type="time"
              value={rescheduleDraft.time}
              onChange={(e) => setRescheduleDraft((d) => (d ? { ...d, time: e.target.value } : d))}
              aria-label="New time"
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={onSaveReschedule} disabled={pending} data-testid="button-timeline-save-reschedule">
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRescheduleDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!isActionable && (
        <div className="rounded-lg border border-border/60 bg-secondary/20 px-3 py-2 text-[11px] text-muted-foreground">
          Recorded {formatTimestamp(item.occurredAt)}
          {item.actorName ? ` by ${item.actorName}` : ""}
        </div>
      )}
    </div>
  );
}

export interface TimelineWorkspaceProps {
  contact: Contact;
  onCreateTask: () => void;
  onScheduleFollowUp: () => void;
}

export default function TimelineWorkspace({
  contact,
  onCreateTask,
  onScheduleFollowUp,
}: TimelineWorkspaceProps) {
  const contactId = contact.id;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const timelineQ = useGetContactTimeline(contactId);
  const tasksQ = useListTasks({ contactId });
  const followUpsQ = useListFollowUps({ contactId });
  const interactionsQ = useListContactInteractions(contactId, {
    query: { enabled: !!contactId, queryKey: getListContactInteractionsQueryKey(contactId) },
  });

  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const updateFollowUp = useUpdateFollowUp();
  const deleteFollowUp = useDeleteFollowUp();
  const logComm = useLogContactCommunication();
  const calendarInvite = useCreateContactCalendarInvite();

  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | UnifiedKind>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [rescheduleDraft, setRescheduleDraft] = useState<{ key: string; date: string; time: string } | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<TimelineGroup>>(() => {
    try {
      const raw = localStorage.getItem("csp_timeline_collapsed");
      return raw ? new Set(JSON.parse(raw) as TimelineGroup[]) : new Set();
    } catch {
      return new Set();
    }
  });

  const todayStr = format(new Date(), "yyyy-MM-dd");

  const items = useMemo<UnifiedItem[]>(() => {
    const entries: UnifiedItem[] = (timelineQ.data?.entries ?? []).map((e) => ({
      key: `entry-${e.id}`,
      kind: entryToUnifiedKind(e),
      title: e.title ?? (e.type ?? e.kind).replace(/_/g, " "),
      body: e.body ?? null,
      occurredAt: e.occurredAt,
      actorName: e.actorName ?? null,
      entry: e,
    }));
    const tasks: UnifiedItem[] = (tasksQ.data?.tasks ?? []).map((t) => ({
      key: `task-${t.id}`,
      kind: "task" as const,
      title: t.title,
      body: t.notes ?? null,
      occurredAt: t.dueDate ? `${t.dueDate}T${t.dueTime ?? "00:00"}:00` : t.createdAt,
      actorName: t.assignedToName ?? null,
      task: t,
    }));
    const followUps: UnifiedItem[] = (followUpsQ.data?.followUps ?? []).map((f) => ({
      key: `followup-${f.id}`,
      kind: "follow_up" as const,
      title: f.notes?.trim() ? f.notes.split("\n")[0] : "Scheduled follow-up",
      body: f.notes ?? null,
      occurredAt: f.scheduledDate ? `${f.scheduledDate}T${f.scheduledTime ?? "00:00"}:00` : f.createdAt,
      actorName: f.assignedToName ?? null,
      followUp: f,
    }));
    const captures: UnifiedItem[] = (interactionsQ.data?.interactions ?? []).map((i) => {
      const src = CAPTURE_SOURCE_META[i.captureSource ?? ""];
      return {
        key: `capture-${i.id}`,
        kind: "capture" as const,
        title: src?.label ?? "Capture",
        body: i.notes ?? null,
        occurredAt: i.occurredAt,
        actorName: i.userName ?? null,
        capture: i,
      };
    });
    return [...entries, ...tasks, ...followUps, ...captures].sort((a, b) =>
      b.occurredAt.localeCompare(a.occurredAt),
    );
  }, [timelineQ.data, tasksQ.data, followUpsQ.data, interactionsQ.data]);

  const chipCounts = useMemo(() => {
    const counts: Record<string, number> = { all: items.length };
    for (const it of items) counts[it.kind] = (counts[it.kind] ?? 0) + 1;
    return counts;
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (kindFilter !== "all" && it.kind !== kindFilter) return false;
      if (q) {
        const hay = `${it.title} ${it.body ?? ""} ${it.actorName ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, search, kindFilter]);

  const groups = useMemo(() => {
    const map = new Map<TimelineGroup, UnifiedItem[]>();
    for (const it of filtered) {
      const g = timelineGroupFor(itemDate(it));
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(it);
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

  const selected = filtered.find((it) => it.key === selectedKey) ?? null;

  const stats = useMemo(() => {
    const count = (k: UnifiedKind) => items.filter((it) => it.kind === k).length;
    const last = items[0]?.occurredAt ?? null;
    return {
      calls: count("call"),
      emails: count("email"),
      whatsapp: count("whatsapp"),
      meetings: count("meeting"),
      tasks: count("task"),
      captures: count("capture"),
      lastTouch: last,
    };
  }, [items]);

  const refetchAll = () => {
    timelineQ.refetch();
    tasksQ.refetch();
    followUpsQ.refetch();
    interactionsQ.refetch();
  };

  const mutationPending =
    updateTask.isPending || deleteTask.isPending || updateFollowUp.isPending || deleteFollowUp.isPending;

  const completeItem = (it: UnifiedItem) => {
    const opts = {
      onSuccess: () => {
        toast({ title: "Marked complete" });
        refetchAll();
      },
      onError: () => toast({ title: "Could not update", variant: "destructive" as const }),
    };
    if (it.task) updateTask.mutate({ id: it.task.id, data: { status: "completed" } }, opts);
    else if (it.followUp) updateFollowUp.mutate({ id: it.followUp.id, data: { status: "completed" } }, opts);
  };

  const deleteItem = (it: UnifiedItem) => {
    const opts = {
      onSuccess: () => {
        toast({ title: "Deleted" });
        setSelectedKey(null);
        setMobileDetailOpen(false);
        refetchAll();
      },
      onError: () => toast({ title: "Could not delete", variant: "destructive" as const }),
    };
    if (it.task) deleteTask.mutate({ id: it.task.id }, opts);
    else if (it.followUp) deleteFollowUp.mutate({ id: it.followUp.id }, opts);
  };

  const startReschedule = (it: UnifiedItem) => {
    const date = it.task?.dueDate ?? it.followUp?.scheduledDate ?? "";
    const time = it.task?.dueTime ?? it.followUp?.scheduledTime ?? "";
    setRescheduleDraft({ key: it.key, date, time });
  };

  const saveReschedule = (it: UnifiedItem) => {
    if (!rescheduleDraft) return;
    const opts = {
      onSuccess: () => {
        toast({ title: "Rescheduled" });
        setRescheduleDraft(null);
        refetchAll();
      },
      onError: () => toast({ title: "Could not reschedule", variant: "destructive" as const }),
    };
    if (it.task)
      updateTask.mutate(
        { id: it.task.id, data: { dueDate: rescheduleDraft.date || null, dueTime: rescheduleDraft.time || null } },
        opts,
      );
    else if (it.followUp)
      updateFollowUp.mutate(
        {
          id: it.followUp.id,
          data: {
            scheduledDate: rescheduleDraft.date || null,
            scheduledTime: rescheduleDraft.time || null,
            status: "rescheduled",
          },
        },
        opts,
      );
  };

  const selectItem = (it: UnifiedItem) => {
    setSelectedKey(it.key);
    setRescheduleDraft(null);
    if (window.innerWidth < 1024) setMobileDetailOpen(true);
  };

  // ── Quick actions (Communication Hub) ──────────────────────────────────
  const invalidateComms = () => {
    queryClient.invalidateQueries({ queryKey: getListContactCommunicationsQueryKey(contactId) });
    queryClient.invalidateQueries({ queryKey: getGetContactTimelineQueryKey(contactId) });
  };
  const doLog = (channel: "email" | "phone" | "whatsapp", subject: string) => {
    logComm.mutate(
      { id: contactId, data: { channel, subject } },
      {
        onSuccess: invalidateComms,
        onError: () => toast({ variant: "destructive", title: "Could not log activity" }),
      },
    );
  };
  const handleEmail = () => {
    if (!contact.email) return;
    window.location.href = `mailto:${contact.email}`;
    doLog("email", `Email to ${contact.email}`);
    toast({ title: "Opening mail app", description: "Logged to the timeline." });
  };
  const handleCall = () => {
    if (!contact.mobile) return;
    window.location.href = `tel:${normalizePhone(contact.mobile)}`;
    doLog("phone", `Called ${contact.mobile}`);
    toast({ title: "Starting call", description: "Logged to the timeline." });
  };
  const handleWhatsApp = () => {
    if (!contact.mobile) return;
    const num = normalizePhone(contact.mobile).replace(/^\+/, "");
    window.open(`https://wa.me/${num}`, "_blank", "noopener,noreferrer");
    doLog("whatsapp", `WhatsApp to ${contact.mobile}`);
    toast({ title: "Opening WhatsApp", description: "Logged to the timeline." });
  };

  // Calendar invite dialog
  const displayName = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim();
  const [calOpen, setCalOpen] = useState(false);
  const [calTitle, setCalTitle] = useState("");
  const [calStart, setCalStart] = useState("");
  const [calDuration, setCalDuration] = useState("30");
  const [calLocation, setCalLocation] = useState("");

  const openCalendar = () => {
    setCalTitle(displayName ? `Meeting with ${displayName}` : "Meeting");
    setCalStart("");
    setCalDuration("30");
    setCalLocation("");
    setCalOpen(true);
  };

  const submitCalendar = () => {
    if (!calTitle.trim() || !calStart) {
      toast({ variant: "destructive", title: "Title and start time are required" });
      return;
    }
    calendarInvite.mutate(
      {
        id: contactId,
        data: {
          title: calTitle.trim(),
          startAt: new Date(calStart).toISOString(),
          durationMinutes: parseInt(calDuration, 10) || 30,
          location: calLocation.trim() || null,
        },
      },
      {
        onSuccess: (res) => {
          const blob = new Blob([res.ics], { type: "text/calendar;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = res.filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          invalidateComms();
          setCalOpen(false);
          toast({ title: "Calendar invite created", description: "Downloaded .ics and logged to the timeline." });
        },
        onError: () => toast({ variant: "destructive", title: "Could not create invite" }),
      },
    );
  };

  const commPending = logComm.isPending || calendarInvite.isPending;
  const isLoading = timelineQ.isLoading || tasksQ.isLoading || followUpsQ.isLoading || interactionsQ.isLoading;
  const isError = timelineQ.isError && tasksQ.isError && followUpsQ.isError && interactionsQ.isError;
  const isFetching =
    timelineQ.isFetching || tasksQ.isFetching || followUpsQ.isFetching || interactionsQ.isFetching;

  return (
    <div className="space-y-4">
      {/* Quick actions */}
      <div className="rounded-2xl border border-border/60 bg-card shadow-sm p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold me-2">Reach out:</p>
          <Button size="sm" variant="outline" onClick={handleEmail} disabled={!contact.email || commPending} data-testid="button-comm-email">
            <Mail className="h-4 w-4 mr-1.5" /> Email
          </Button>
          <Button size="sm" variant="outline" onClick={handleCall} disabled={!contact.mobile || commPending} data-testid="button-comm-call">
            <Phone className="h-4 w-4 mr-1.5" /> Call
          </Button>
          <Button size="sm" variant="outline" onClick={handleWhatsApp} disabled={!contact.mobile || commPending} data-testid="button-comm-whatsapp">
            <MessageCircle className="h-4 w-4 mr-1.5" /> WhatsApp
          </Button>
          <Button size="sm" variant="outline" onClick={openCalendar} disabled={commPending} data-testid="button-comm-calendar">
            <CalendarPlus className="h-4 w-4 mr-1.5" /> Schedule Meeting
          </Button>
          <Button size="sm" variant="outline" onClick={onCreateTask} className="ms-auto" data-testid="button-timeline-create-task">
            <Plus className="h-4 w-4 mr-1.5" /> Create Task
          </Button>
          <Button size="sm" onClick={onScheduleFollowUp} data-testid="button-timeline-schedule-followup">
            <CalendarClock className="h-4 w-4 mr-1.5" /> Schedule Follow-up
          </Button>
        </div>
        {!contact.email && !contact.mobile && (
          <p className="text-xs text-muted-foreground italic mt-2">
            No email or phone on file — add contact details to enable Email, Call, and WhatsApp.
          </p>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2.5">
        <StatTile label="Calls" value={String(stats.calls)} icon={<Phone className="h-3 w-3" aria-hidden />} />
        <StatTile label="Emails" value={String(stats.emails)} icon={<Mail className="h-3 w-3" aria-hidden />} />
        <StatTile label="WhatsApp" value={String(stats.whatsapp)} icon={<MessageCircle className="h-3 w-3" aria-hidden />} />
        <StatTile label="Meetings" value={String(stats.meetings)} icon={<MessagesSquare className="h-3 w-3" aria-hidden />} />
        <StatTile label="Tasks" value={String(stats.tasks)} icon={<ListTodo className="h-3 w-3" aria-hidden />} />
        <StatTile label="Captures" value={String(stats.captures)} icon={<ScanLine className="h-3 w-3" aria-hidden />} />
        <StatTile
          label="Last Touch"
          value={stats.lastTouch ? `${relativeAge(stats.lastTouch)} ago` : "—"}
          icon={<History className="h-3 w-3" aria-hidden />}
        />
      </div>

      {/* Filter chips + search */}
      <WorkspaceToolbar className="flex-wrap h-auto py-2.5">
        <div className="flex items-center gap-1.5 flex-wrap flex-1">
          {FILTER_CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setKindFilter(c.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors shrink-0",
                kindFilter === c.key
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border/60 bg-background text-muted-foreground hover:text-foreground hover:bg-secondary/50",
              )}
              data-testid={`chip-timeline-${c.key}`}
            >
              {c.label}
              <span className="opacity-70">({chipCounts[c.key] ?? 0})</span>
            </button>
          ))}
        </div>
        <div className="relative min-w-[160px]">
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
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={refetchAll}
          aria-label="Refresh timeline"
          data-testid="button-timeline-refresh"
        >
          <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
        </Button>
      </WorkspaceToolbar>

      <div className="grid grid-cols-1 lg:grid-cols-[7fr_3fr] gap-5 items-start">
        {/* Feed */}
        <div>
          {isLoading ? (
            <CardSkeleton rows={6} />
          ) : isError ? (
            <ErrorState message="Timeline could not be loaded." onRetry={refetchAll} />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<History className="h-5 w-5" aria-hidden />}
              headline="No timeline events found."
              description={
                search || kindFilter !== "all"
                  ? "Try adjusting your search or filters."
                  : "Calls, emails, meetings, notes, tasks, and card captures will build the relationship record here."
              }
              actions={
                !search && kindFilter === "all" ? (
                  <>
                    <Button size="sm" onClick={onCreateTask}>
                      <ListTodo className="h-4 w-4 mr-2" /> Create Task
                    </Button>
                    <Button size="sm" variant="outline" onClick={onScheduleFollowUp}>
                      <CalendarClock className="h-4 w-4 mr-2" /> Schedule Follow-up
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
                        {g.items.map((it) => {
                          const isSelected = it.key === selectedKey;
                          const overdue = isOverdue(it, todayStr);
                          const statusMeta = itemStatusMeta(it);
                          return (
                            <li key={it.key}>
                              <button
                                type="button"
                                onClick={() => selectItem(it)}
                                aria-pressed={isSelected}
                                className={cn(
                                  "w-full max-h-24 overflow-hidden text-start rounded-xl border px-3.5 py-2.5 transition-colors flex items-start gap-3",
                                  isSelected
                                    ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
                                    : "border-border/60 bg-card hover:bg-secondary/40",
                                )}
                                data-testid={`timeline-event-${it.key}`}
                              >
                                <span className="h-8 w-8 rounded-full bg-primary-soft text-primary flex items-center justify-center shrink-0 mt-0.5">
                                  {entryIcon(it.kind, it.capture?.captureSource)}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="flex items-center gap-2 min-w-0">
                                    <span
                                      className={cn(
                                        "text-sm font-medium truncate",
                                        isDone(it) && "line-through text-muted-foreground",
                                      )}
                                    >
                                      {it.title}
                                    </span>
                                    <Badge variant="outline" className="text-[10px] capitalize shrink-0 hidden sm:inline-flex">
                                      {KIND_META[it.kind].label}
                                    </Badge>
                                    {statusMeta && (
                                      <Badge
                                        variant="outline"
                                        className={cn("text-[10px] shrink-0", overdue ? TASK_STATUS_META.overdue.cls : statusMeta.cls)}
                                      >
                                        {overdue ? "Overdue" : statusMeta.label}
                                      </Badge>
                                    )}
                                  </span>
                                  {it.body && (
                                    <span className="block text-xs text-muted-foreground truncate mt-0.5">{it.body}</span>
                                  )}
                                  <span className="block text-[11px] text-muted-foreground mt-0.5 truncate">
                                    {formatTimestamp(it.occurredAt)}
                                    {it.actorName ? ` · ${it.actorName}` : ""}
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
            <UnifiedDetails
              item={selected}
              contact={contact}
              todayStr={todayStr}
              pending={mutationPending}
              onComplete={() => completeItem(selected)}
              onDelete={() => deleteItem(selected)}
              onEdit={() => startReschedule(selected)}
              rescheduleDraft={rescheduleDraft}
              setRescheduleDraft={setRescheduleDraft}
              onSaveReschedule={() => saveReschedule(selected)}
            />
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
            {selected && (
              <UnifiedDetails
                item={selected}
                contact={contact}
                todayStr={todayStr}
                pending={mutationPending}
                onComplete={() => completeItem(selected)}
                onDelete={() => deleteItem(selected)}
                onEdit={() => startReschedule(selected)}
                rescheduleDraft={rescheduleDraft}
                setRescheduleDraft={setRescheduleDraft}
                onSaveReschedule={() => saveReschedule(selected)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Calendar dialog */}
      <Dialog open={calOpen} onOpenChange={setCalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Schedule a meeting</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="ws-cal-title">Title</Label>
              <Input id="ws-cal-title" value={calTitle} onChange={(e) => setCalTitle(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ws-cal-start">Start</Label>
              <Input
                id="ws-cal-start"
                type="datetime-local"
                value={calStart}
                onChange={(e) => setCalStart(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="ws-cal-duration">Duration (min)</Label>
                <Input
                  id="ws-cal-duration"
                  type="number"
                  min={5}
                  step={5}
                  value={calDuration}
                  onChange={(e) => setCalDuration(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ws-cal-location">Location</Label>
                <Input
                  id="ws-cal-location"
                  value={calLocation}
                  onChange={(e) => setCalLocation(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitCalendar} disabled={commPending} data-testid="button-cal-submit">
              <CalendarPlus className="h-4 w-4 mr-2" /> Create invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
