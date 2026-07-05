import React, { useState } from "react";
import {
  useListContactCommunications,
  useLogContactCommunication,
  useCreateContactCalendarInvite,
  getListContactCommunicationsQueryKey,
  useListLeadCommunications,
  useLogLeadCommunication,
  getListLeadCommunicationsQueryKey,
  type LeadActivity,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Mail,
  Phone,
  MessageCircle,
  CalendarPlus,
  MessageSquare,
  Radio,
  Send,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

type Channel = "email" | "phone" | "whatsapp" | "calendar";

interface Props {
  entity: "contact" | "lead";
  id: number;
  email?: string | null;
  phone?: string | null;
  displayName?: string | null;
}

const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  call: "Phone call",
  message: "WhatsApp",
  meeting: "Meeting",
};

const CHANNEL_ICON: Record<string, React.ReactNode> = {
  email: <Mail className="h-4 w-4" />,
  call: <Phone className="h-4 w-4" />,
  message: <MessageCircle className="h-4 w-4" />,
  meeting: <CalendarPlus className="h-4 w-4" />,
};

/** Digits only + leading + for wa.me / tel links. */
function normalizePhone(p: string): string {
  const cleaned = p.replace(/[^\d+]/g, "");
  return cleaned.startsWith("+") ? cleaned : cleaned;
}

function toIcsLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}00`
  );
}

export function CommunicationHub({ entity, id, email, phone, displayName }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const isContact = entity === "contact";
  const listKey = isContact
    ? getListContactCommunicationsQueryKey(id)
    : getListLeadCommunicationsQueryKey(id);

  const contactList = useListContactCommunications(id, {
    query: { enabled: isContact && !!id, queryKey: getListContactCommunicationsQueryKey(id) },
  });
  const leadList = useListLeadCommunications(id, {
    query: { enabled: !isContact && !!id, queryKey: getListLeadCommunicationsQueryKey(id) },
  });
  const list = isContact ? contactList : leadList;
  const communications: LeadActivity[] = list.data?.communications ?? [];

  const logContact = useLogContactCommunication();
  const logLead = useLogLeadCommunication();
  const calendarInvite = useCreateContactCalendarInvite();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: listKey });

  const logComm = (channel: Channel, subject: string | null) => {
    const body = { channel, subject } as { channel: Channel; subject: string | null };
    if (isContact) {
      logContact.mutate(
        { id, data: body },
        { onSuccess: invalidate, onError: () => toast({ variant: "destructive", title: "Could not log activity" }) }
      );
    } else {
      logLead.mutate(
        { id, data: body },
        { onSuccess: invalidate, onError: () => toast({ variant: "destructive", title: "Could not log activity" }) }
      );
    }
  };

  const handleEmail = () => {
    if (!email) return;
    window.location.href = `mailto:${email}`;
    logComm("email", `Email to ${email}`);
    toast({ title: "Opening mail app", description: "Logged to the timeline." });
  };

  const handlePhone = () => {
    if (!phone) return;
    window.location.href = `tel:${normalizePhone(phone)}`;
    logComm("phone", `Called ${phone}`);
    toast({ title: "Starting call", description: "Logged to the timeline." });
  };

  const handleWhatsApp = () => {
    if (!phone) return;
    const num = normalizePhone(phone).replace(/^\+/, "");
    window.open(`https://wa.me/${num}`, "_blank", "noopener,noreferrer");
    logComm("whatsapp", `WhatsApp to ${phone}`);
    toast({ title: "Opening WhatsApp", description: "Logged to the timeline." });
  };

  // ── Calendar ────────────────────────────────────────────────────────────
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
    const startIso = new Date(calStart).toISOString();
    const duration = parseInt(calDuration, 10) || 30;

    if (isContact) {
      calendarInvite.mutate(
        {
          id,
          data: {
            title: calTitle.trim(),
            startAt: startIso,
            durationMinutes: duration,
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
            toast({ title: "Calendar invite created", description: "Downloaded .ics and logged to the timeline." });
          },
          onError: () => toast({ variant: "destructive", title: "Could not create invite" }),
        }
      );
    } else {
      // Leads: log the calendar communication + offer a client-side .ics download.
      const start = new Date(calStart);
      const end = new Date(start.getTime() + duration * 60000);
      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Card Scanner Pro//Communication Hub//EN",
        "BEGIN:VEVENT",
        `UID:csp-lead-${id}-${Date.now()}@cardscannerpro`,
        `DTSTAMP:${toIcsLocal(new Date())}`,
        `DTSTART:${toIcsLocal(start)}`,
        `DTEND:${toIcsLocal(end)}`,
        `SUMMARY:${calTitle.trim().replace(/,/g, "\\,")}`,
        calLocation.trim() ? `LOCATION:${calLocation.trim().replace(/,/g, "\\,")}` : "",
        "END:VEVENT",
        "END:VCALENDAR",
      ]
        .filter(Boolean)
        .join("\r\n");
      logLead.mutate(
        { id, data: { channel: "calendar", subject: calTitle.trim() } },
        {
          onSuccess: () => {
            const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `invite-lead-${id}.ics`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            invalidate();
            setCalOpen(false);
            toast({ title: "Meeting logged", description: "Downloaded .ics and logged to the timeline." });
          },
          onError: () => toast({ variant: "destructive", title: "Could not log meeting" }),
        }
      );
    }
  };

  const pending =
    logContact.isPending || logLead.isPending || calendarInvite.isPending;

  return (
    <Card>
      <CardHeader className="pb-3 bg-secondary/20">
        <CardTitle className="flex items-center gap-2">
          <Send className="h-4 w-4 text-primary" /> Communication Hub
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" size="sm" onClick={handleEmail} disabled={!email || pending}>
            <Mail className="h-4 w-4 mr-2" /> Email
          </Button>
          <Button variant="outline" size="sm" onClick={handlePhone} disabled={!phone || pending}>
            <Phone className="h-4 w-4 mr-2" /> Call
          </Button>
          <Button variant="outline" size="sm" onClick={handleWhatsApp} disabled={!phone || pending}>
            <MessageCircle className="h-4 w-4 mr-2" /> WhatsApp
          </Button>
          <Button variant="outline" size="sm" onClick={openCalendar} disabled={pending}>
            <CalendarPlus className="h-4 w-4 mr-2" /> Calendar
          </Button>
        </div>

        {/* SMS — scaffolded but not yet active */}
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-center text-muted-foreground"
          disabled
          title="SMS sending is not yet available"
        >
          <Radio className="h-4 w-4 mr-2" /> SMS (coming soon)
        </Button>

        {(!email && !phone) && (
          <p className="text-xs text-muted-foreground italic">
            No email or phone on file — add contact details to enable Email, Call, and WhatsApp.
          </p>
        )}

        <div className="space-y-2 pt-2 border-t border-border">
          <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <MessageSquare className="h-4 w-4" /> Recent communications
          </div>
          {list.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : communications.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No communications logged yet.</p>
          ) : (
            <ul className="space-y-2">
              {communications.slice(0, 6).map((c) => (
                <li key={c.id} className="flex items-start gap-2 text-sm">
                  <span className="text-primary mt-0.5 shrink-0">{CHANNEL_ICON[c.type] ?? <MessageSquare className="h-4 w-4" />}</span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{CHANNEL_LABEL[c.type] ?? c.type}</Badge>
                      <span className="text-xs text-muted-foreground">{format(new Date(c.occurredAt), "PPp")}</span>
                    </div>
                    {c.subject && <div className="text-xs truncate">{c.subject}</div>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>

      <Dialog open={calOpen} onOpenChange={setCalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Schedule a meeting</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input value={calTitle} onChange={(e) => setCalTitle(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Start</Label>
              <Input type="datetime-local" value={calStart} onChange={(e) => setCalStart(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Duration (min)</Label>
                <Input type="number" min={5} step={5} value={calDuration} onChange={(e) => setCalDuration(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Location</Label>
                <Input value={calLocation} onChange={(e) => setCalLocation(e.target.value)} placeholder="Optional" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCalOpen(false)}>Cancel</Button>
            <Button onClick={submitCalendar} disabled={pending}>
              <CalendarPlus className="h-4 w-4 mr-2" /> Create invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
