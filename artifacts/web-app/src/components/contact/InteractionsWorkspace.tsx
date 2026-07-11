import React, { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListContactCommunications,
  getListContactCommunicationsQueryKey,
  getGetContactTimelineQueryKey,
  useLogContactCommunication,
  useCreateContactCalendarInvite,
  useListContactInteractions,
  getListContactInteractionsQueryKey,
  type Contact,
  type Interaction,
  type LeadActivity,
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
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Calendar,
  CalendarPlus,
  Camera,
  CreditCard,
  FileInput,
  Mail,
  MapPin,
  MessageCircle,
  MessageSquare,
  Nfc,
  PenLine,
  Phone,
  QrCode,
  RefreshCw,
  ScanLine,
  Search,
  Sparkles,
  User,
} from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  CardSkeleton,
  EmptyState,
  ErrorState,
  StatTile,
  WorkspaceToolbar,
  formatTimestamp,
  relativeAge,
} from "./shared";

// ── Unified item model ───────────────────────────────────────────────────────

type UnifiedKind = "email" | "call" | "whatsapp" | "meeting" | "capture";

interface UnifiedItem {
  key: string;
  kind: UnifiedKind;
  title: string;
  occurredAt: string;
  byName?: string | null;
  comm?: LeadActivity;
  capture?: Interaction;
}

const KIND_META: Record<UnifiedKind, { label: string; icon: React.ReactNode; tone: string }> = {
  email: { label: "Email", icon: <Mail className="h-4 w-4" aria-hidden />, tone: "text-info" },
  call: { label: "Call", icon: <Phone className="h-4 w-4" aria-hidden />, tone: "text-success" },
  whatsapp: {
    label: "WhatsApp",
    icon: <MessageCircle className="h-4 w-4" aria-hidden />,
    tone: "text-success",
  },
  meeting: {
    label: "Meeting",
    icon: <CalendarPlus className="h-4 w-4" aria-hidden />,
    tone: "text-warning",
  },
  capture: { label: "Capture", icon: <ScanLine className="h-4 w-4" aria-hidden />, tone: "text-primary" },
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

function commKind(type: string): UnifiedKind {
  if (type === "email") return "email";
  if (type === "call") return "call";
  if (type === "message") return "whatsapp";
  return "meeting"; // meeting | calendar
}

/** Digits only + optional leading + for wa.me / tel links. */
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

// ── Detail panel ─────────────────────────────────────────────────────────────

function InteractionDetails({ item }: { item: UnifiedItem }) {
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
          <span className="h-10 w-10 rounded-lg bg-primary-soft text-primary flex items-center justify-center shrink-0">
            {src.icon}
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-sm">{src.label}</p>
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
              <dd className="whitespace-pre-wrap">{cap.notes}</dd>
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
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">
              Extracted Data
            </p>
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

  const comm = item.comm!;
  const meta = KIND_META[item.kind];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5">
        <span className={cn("h-10 w-10 rounded-lg bg-secondary flex items-center justify-center shrink-0", meta.tone)}>
          {meta.icon}
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-sm">{meta.label}</p>
          <p className="text-xs text-muted-foreground">{formatTimestamp(comm.occurredAt)}</p>
        </div>
      </div>
      <dl className="space-y-2.5 text-sm">
        {comm.subject && (
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Subject</dt>
            <dd className="font-medium break-words">{comm.subject}</dd>
          </div>
        )}
        {comm.userName && (
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Logged By</dt>
            <dd className="font-medium flex items-center gap-1.5">
              <User className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> {comm.userName}
            </dd>
          </div>
        )}
        {comm.body && (
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Details</dt>
            <dd className="whitespace-pre-wrap">{comm.body}</dd>
          </div>
        )}
        {comm.outcome && (
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Outcome</dt>
            <dd className="font-medium capitalize">{comm.outcome.replace(/_/g, " ")}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

// ── Workspace ────────────────────────────────────────────────────────────────

export interface InteractionsWorkspaceProps {
  contact: Contact;
}

export default function InteractionsWorkspace({ contact }: InteractionsWorkspaceProps) {
  const contactId = contact.id;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const commsQ = useListContactCommunications(contactId, {
    query: { enabled: !!contactId, queryKey: getListContactCommunicationsQueryKey(contactId) },
  });
  const interactionsQ = useListContactInteractions(contactId, {
    query: { enabled: !!contactId, queryKey: getListContactInteractionsQueryKey(contactId) },
  });

  const logComm = useLogContactCommunication();
  const calendarInvite = useCreateContactCalendarInvite();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListContactCommunicationsQueryKey(contactId) });
    queryClient.invalidateQueries({ queryKey: getGetContactTimelineQueryKey(contactId) });
  };

  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const items = useMemo<UnifiedItem[]>(() => {
    const comms: UnifiedItem[] = (commsQ.data?.communications ?? []).map((c) => {
      const kind = commKind(c.type);
      return {
        key: `comm-${c.id}`,
        kind,
        title: c.subject || KIND_META[kind].label,
        occurredAt: c.occurredAt,
        byName: c.userName,
        comm: c,
      };
    });
    const caps: UnifiedItem[] = (interactionsQ.data?.interactions ?? []).map((i) => {
      const src = CAPTURE_SOURCE_META[i.captureSource ?? ""];
      return {
        key: `cap-${i.id}`,
        kind: "capture" as const,
        title: src?.label ?? "Capture",
        occurredAt: i.occurredAt,
        byName: i.userName,
        capture: i,
      };
    });
    let all = [...comms, ...caps].sort(
      (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );
    if (kindFilter !== "all") all = all.filter((it) => it.kind === kindFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      all = all.filter(
        (it) =>
          it.title.toLowerCase().includes(q) ||
          (it.byName ?? "").toLowerCase().includes(q) ||
          (it.comm?.body ?? "").toLowerCase().includes(q) ||
          (it.capture?.notes ?? "").toLowerCase().includes(q) ||
          (it.capture?.eventName ?? "").toLowerCase().includes(q),
      );
    }
    return all;
  }, [commsQ.data, interactionsQ.data, kindFilter, search]);

  const selected = items.find((it) => it.key === selectedKey) ?? null;

  const stats = useMemo(() => {
    const comms = commsQ.data?.communications ?? [];
    const captures = interactionsQ.data?.interactions ?? [];
    const count = (k: string) => comms.filter((c) => commKind(c.type) === k).length;
    const all = [...comms.map((c) => c.occurredAt), ...captures.map((c) => c.occurredAt)].sort();
    const lastTouch = all.length ? all[all.length - 1] : null;
    return {
      calls: count("call"),
      emails: count("email"),
      whatsapp: count("whatsapp"),
      meetings: count("meeting"),
      captures: captures.length,
      lastTouch,
    };
  }, [commsQ.data, interactionsQ.data]);

  // ── Quick actions (preserved Communication Hub behavior) ──────────────────
  const doLog = (channel: "email" | "phone" | "whatsapp", subject: string) => {
    logComm.mutate(
      { id: contactId, data: { channel, subject } },
      {
        onSuccess: invalidate,
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
          invalidate();
          setCalOpen(false);
          toast({
            title: "Calendar invite created",
            description: "Downloaded .ics and logged to the timeline.",
          });
        },
        onError: () => toast({ variant: "destructive", title: "Could not create invite" }),
      },
    );
  };

  const pending = logComm.isPending || calendarInvite.isPending;
  const isLoading = commsQ.isLoading || interactionsQ.isLoading;
  const isError = commsQ.isError && interactionsQ.isError;

  const selectItem = (it: UnifiedItem) => {
    setSelectedKey(it.key);
    if (window.innerWidth < 1024) setMobileDetailOpen(true);
  };

  return (
    <div className="space-y-4">
      {/* Quick actions */}
      <div className="rounded-2xl border border-border/60 bg-card shadow-sm p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold me-2">Reach out:</p>
          <Button size="sm" variant="outline" onClick={handleEmail} disabled={!contact.email || pending} data-testid="button-comm-email">
            <Mail className="h-4 w-4 mr-1.5" /> Email
          </Button>
          <Button size="sm" variant="outline" onClick={handleCall} disabled={!contact.mobile || pending} data-testid="button-comm-call">
            <Phone className="h-4 w-4 mr-1.5" /> Call
          </Button>
          <Button size="sm" variant="outline" onClick={handleWhatsApp} disabled={!contact.mobile || pending} data-testid="button-comm-whatsapp">
            <MessageCircle className="h-4 w-4 mr-1.5" /> WhatsApp
          </Button>
          <Button size="sm" variant="outline" onClick={openCalendar} disabled={pending} data-testid="button-comm-calendar">
            <CalendarPlus className="h-4 w-4 mr-1.5" /> Schedule Meeting
          </Button>
        </div>
        {!contact.email && !contact.mobile && (
          <p className="text-xs text-muted-foreground italic mt-2">
            No email or phone on file — add contact details to enable Email, Call, and WhatsApp.
          </p>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
        <StatTile label="Calls" value={String(stats.calls)} icon={<Phone className="h-4 w-4" aria-hidden />} />
        <StatTile label="Emails" value={String(stats.emails)} icon={<Mail className="h-4 w-4" aria-hidden />} />
        <StatTile label="WhatsApp" value={String(stats.whatsapp)} icon={<MessageCircle className="h-4 w-4" aria-hidden />} />
        <StatTile label="Meetings" value={String(stats.meetings)} icon={<CalendarPlus className="h-4 w-4" aria-hidden />} />
        <StatTile label="Captures" value={String(stats.captures)} icon={<ScanLine className="h-4 w-4" aria-hidden />} />
        <StatTile
          label="Last Touch"
          value={stats.lastTouch ? relativeAge(stats.lastTouch) : "—"}
          icon={<Calendar className="h-4 w-4" aria-hidden />}
        />
      </div>

      <WorkspaceToolbar>
        <div className="relative flex-1 min-w-[150px]">
          <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search interactions…"
            className="ps-8 h-9"
            aria-label="Search interactions"
            data-testid="input-interactions-search"
          />
        </div>
        <Select value={kindFilter} onValueChange={setKindFilter}>
          <SelectTrigger className="w-[150px] h-9 shrink-0" data-testid="select-interactions-kind">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="email">Emails</SelectItem>
            <SelectItem value="call">Calls</SelectItem>
            <SelectItem value="whatsapp">WhatsApp</SelectItem>
            <SelectItem value="meeting">Meetings</SelectItem>
            <SelectItem value="capture">Captures</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={() => {
            commsQ.refetch();
            interactionsQ.refetch();
          }}
          aria-label="Refresh interactions"
        >
          <RefreshCw
            className={cn("h-4 w-4", (commsQ.isFetching || interactionsQ.isFetching) && "animate-spin")}
          />
        </Button>
      </WorkspaceToolbar>

      <div className="grid grid-cols-1 lg:grid-cols-[7fr_13fr] gap-5 items-start">
        {/* List (35%) */}
        <div className="space-y-2">
          {isLoading ? (
            <CardSkeleton rows={5} />
          ) : isError ? (
            <ErrorState
              message="Unable to load interactions."
              onRetry={() => {
                commsQ.refetch();
                interactionsQ.refetch();
              }}
            />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<MessageSquare className="h-5 w-5" aria-hidden />}
              headline="No interactions yet."
              description="Captures and logged communications with this contact will appear here."
            />
          ) : (
            <ul className="space-y-2" aria-label="Interaction list">
              {items.map((it) => {
                const meta = KIND_META[it.kind];
                const isSelected = it.key === selectedKey;
                return (
                  <li key={it.key}>
                    <button
                      type="button"
                      onClick={() => selectItem(it)}
                      aria-pressed={isSelected}
                      className={cn(
                        "w-full text-start rounded-xl border px-3.5 py-2.5 transition-colors flex items-start gap-2.5",
                        isSelected
                          ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
                          : "border-border/60 bg-card hover:bg-secondary/40",
                      )}
                      data-testid={`interaction-${it.key}`}
                    >
                      <span
                        className={cn(
                          "h-8 w-8 rounded-lg bg-secondary flex items-center justify-center shrink-0 mt-0.5",
                          meta.tone,
                        )}
                      >
                        {it.kind === "capture" && it.capture
                          ? (CAPTURE_SOURCE_META[it.capture.captureSource ?? ""]?.icon ?? meta.icon)
                          : meta.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{it.title}</span>
                          <Badge variant="secondary" className="text-[10px] shrink-0">
                            {meta.label}
                          </Badge>
                        </span>
                        <span className="block text-xs text-muted-foreground truncate mt-0.5">
                          {formatTimestamp(it.occurredAt)}
                          {it.byName ? ` · ${it.byName}` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Detail (65%, desktop) */}
        <aside
          className="hidden lg:block sticky top-20 rounded-2xl border border-border/60 bg-card shadow-sm p-5 min-h-[220px]"
          aria-label="Interaction details"
        >
          {selected ? (
            <InteractionDetails item={selected} />
          ) : (
            <div className="text-center py-10">
              <MessageSquare className="h-8 w-8 text-muted-foreground mx-auto mb-2" aria-hidden />
              <p className="text-sm text-muted-foreground">Select an interaction to see its full details.</p>
            </div>
          )}
        </aside>
      </div>

      {/* Mobile / tablet detail sheet */}
      <Sheet open={mobileDetailOpen} onOpenChange={setMobileDetailOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto lg:hidden">
          <SheetHeader>
            <SheetTitle>Interaction details</SheetTitle>
          </SheetHeader>
          <div className="pt-4">{selected && <InteractionDetails item={selected} />}</div>
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
            <Button onClick={submitCalendar} disabled={pending} data-testid="button-cal-submit">
              <CalendarPlus className="h-4 w-4 mr-2" /> Create invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
