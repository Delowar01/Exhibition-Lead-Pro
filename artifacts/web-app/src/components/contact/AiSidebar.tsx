import React, { useEffect, useState } from "react";
import {
  useUpdateContact,
  useEnrichContact,
  getGetContactQueryKey,
  ContactStatus,
  type Contact,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  AlertCircle,
  Bot,
  Building2,
  CalendarClock,
  FileText,
  Flame,
  Mail,
  MessageSquareText,
  PhoneCall,
  Snowflake,
  Sparkles,
  Thermometer,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format, parseISO } from "date-fns";

const ORG_NONE = "__none__";

const TEMP_BADGE: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
  hot: { label: "Hot", cls: "bg-destructive-soft text-destructive border-destructive/25", icon: <Flame className="h-3.5 w-3.5" aria-hidden /> },
  warm: { label: "Warm", cls: "bg-warning-soft text-warning border-warning/25", icon: <Thermometer className="h-3.5 w-3.5" aria-hidden /> },
  cold: { label: "Cold", cls: "bg-info-soft text-info border-info/25", icon: <Snowflake className="h-3.5 w-3.5" aria-hidden /> },
};

// All "Generate" shortcuts open the AI Assistant workspace, which drafts from
// real CRM data. Labels describe what the AI workspace can help produce.
const GENERATE_SHORTCUTS: { label: string; icon: React.ReactNode; testId: string }[] = [
  { label: "Email Draft", icon: <Mail className="h-4 w-4" aria-hidden />, testId: "button-generate-email" },
  { label: "Call Script", icon: <PhoneCall className="h-4 w-4" aria-hidden />, testId: "button-generate-call" },
  { label: "Follow-up Msg", icon: <MessageSquareText className="h-4 w-4" aria-hidden />, testId: "button-generate-followup" },
  { label: "Summary", icon: <FileText className="h-4 w-4" aria-hidden />, testId: "button-generate-summary" },
];

export default function AiSidebar({
  contact,
  organizations,
  onAskAi,
}: {
  contact: Contact;
  organizations: { id: number; name: string }[];
  onAskAi: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateContact = useUpdateContact();
  const enrich = useEnrichContact();
  const contactId = contact.id;

  const invalidateContact = () =>
    queryClient.invalidateQueries({ queryKey: getGetContactQueryKey(contactId) });

  const handleEnrich = () => {
    enrich.mutate(
      { id: contactId },
      {
        onSuccess: () => {
          toast({ title: "Contact enriched" });
          invalidateContact();
        },
        onError: () => {
          toast({
            title: "Enrichment failed",
            description: "The AI service is temporarily unavailable. Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleOrgChange = (val: string) => {
    const organizationId = val === ORG_NONE ? null : Number(val);
    updateContact.mutate(
      { id: contactId, data: { organizationId } },
      {
        onSuccess: () => {
          toast({ title: organizationId ? "Company linked" : "Company unlinked" });
          invalidateContact();
        },
        onError: () => toast({ title: "Could not update company", variant: "destructive" }),
      },
    );
  };

  const handleStatusChange = (newStatus: ContactStatus) => {
    updateContact.mutate(
      { id: contactId, data: { status: newStatus } },
      {
        onSuccess: () => {
          toast({ title: "Status updated" });
          invalidateContact();
        },
        onError: () => toast({ title: "Could not update status", variant: "destructive" }),
      },
    );
  };

  const [followUpDate, setFollowUpDate] = useState<string>("");
  useEffect(() => {
    setFollowUpDate(contact.followUpDate ?? "");
  }, [contact.followUpDate]);

  const saveFollowUp = (value: string | null) => {
    updateContact.mutate(
      { id: contactId, data: { followUpDate: value } },
      {
        onSuccess: () => {
          toast({ title: value ? "Follow-up reminder saved" : "Follow-up reminder cleared" });
          invalidateContact();
        },
        onError: () => {
          toast({ title: "Could not update follow-up", variant: "destructive" });
          setFollowUpDate(contact.followUpDate ?? "");
        },
      },
    );
  };

  const todayStr = format(new Date(), "yyyy-MM-dd");
  const followUpOverdue = !!contact.followUpDate && contact.followUpDate < todayStr;
  const followUpChanged = followUpDate !== (contact.followUpDate ?? "");
  const temp = contact.leadTemperature ? TEMP_BADGE[contact.leadTemperature] : null;
  const hasIntelligence = (contact.leadScore ?? null) !== null || !!contact.aiReasoning;

  return (
    <div className="space-y-5">
      {/* AI Assistant */}
      <Card className="rounded-2xl border-primary/20 bg-gradient-to-b from-primary/5 to-background shadow-sm">
        <CardHeader className="p-5 pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2 text-primary">
            <Bot className="h-4 w-4" aria-hidden /> AI Assistant
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5 pt-0 space-y-3">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Ask questions about this customer, draft follow-ups, or get next-step recommendations —
            grounded in real CRM data.
          </p>
          <Button size="sm" className="w-full" onClick={onAskAi} data-testid="button-sidebar-ask-ai">
            <Sparkles className="h-4 w-4 mr-2" /> Ask AI about this customer
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={handleEnrich}
            disabled={enrich.isPending}
            data-testid="button-sidebar-enrich"
          >
            <Bot className="h-4 w-4 mr-2" />
            {enrich.isPending ? "Enriching…" : "Enrich with AI"}
          </Button>

          <div className="pt-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Generate with AI
            </p>
            <div className="grid grid-cols-2 gap-2">
              {GENERATE_SHORTCUTS.map((g) => (
                <button
                  key={g.testId}
                  type="button"
                  onClick={onAskAi}
                  data-testid={g.testId}
                  className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-border/70 bg-card px-2 py-3 text-xs font-medium text-muted-foreground hover:text-primary hover:border-primary/40 hover:bg-primary/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="text-primary">{g.icon}</span>
                  {g.label}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* AI Insights (score + reasoning from the real scorer) */}
      {hasIntelligence && (
        <Card className="rounded-2xl border-border/60 shadow-sm">
          <CardHeader className="p-5 pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden /> AI Insights
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5 pt-0 space-y-4">
            {(contact.leadScore ?? null) !== null && (
              <div className="flex items-center gap-4">
                <div className="flex flex-col">
                  <span className="text-3xl font-bold text-primary" data-testid="text-lead-score">
                    {contact.leadScore}
                  </span>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-widest">
                    Lead Score
                  </span>
                </div>
                {temp && (
                  <Badge variant="outline" className={`gap-1 ${temp.cls}`}>
                    {temp.icon} {temp.label}
                  </Badge>
                )}
              </div>
            )}
            {contact.aiReasoning && (
              <Accordion type="single" collapsible className="w-full">
                <AccordionItem value="reasoning" className="border-none">
                  <AccordionTrigger className="py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:no-underline">
                    Why this score?
                  </AccordionTrigger>
                  <AccordionContent className="pb-0">
                    <p className="text-xs leading-relaxed">{contact.aiReasoning}</p>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            )}
          </CardContent>
        </Card>
      )}

      {/* CRM Context */}
      <Card className="rounded-2xl border-border/60 shadow-sm">
        <CardHeader className="p-5 pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Building2 className="h-4 w-4 text-primary" aria-hidden /> CRM Context
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5 pt-0 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Company</label>
            <Select
              value={contact.organizationId ? String(contact.organizationId) : ORG_NONE}
              onValueChange={handleOrgChange}
            >
              <SelectTrigger className="w-full" data-testid="select-sidebar-organization">
                <SelectValue placeholder="Link to a company" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ORG_NONE}>None</SelectItem>
                {organizations.map((o) => (
                  <SelectItem key={o.id} value={String(o.id)}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Pipeline Status</label>
            <Select
              value={contact.status}
              onValueChange={(val) => handleStatusChange(val as ContactStatus)}
            >
              <SelectTrigger className="w-full" data-testid="select-sidebar-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(ContactStatus).map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {s.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Follow-up reminder */}
      <Card className="rounded-2xl border-border/60 shadow-sm">
        <CardHeader className="p-5 pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-primary" aria-hidden /> Follow-up Reminder
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5 pt-0 space-y-3">
          {contact.followUpDate ? (
            <div
              className={`flex items-center justify-between rounded-lg border p-2.5 text-sm ${
                followUpOverdue
                  ? "border-destructive/25 bg-destructive-soft text-destructive"
                  : "border-border bg-secondary/30"
              }`}
            >
              <span className="flex items-center gap-2 font-medium text-xs">
                {followUpOverdue && <AlertCircle className="h-4 w-4" aria-hidden />}
                {format(parseISO(contact.followUpDate), "PPP")}
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider">
                {followUpOverdue ? "Overdue" : "Scheduled"}
              </span>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">No reminder set.</p>
          )}
          <div className="space-y-2">
            <Input
              type="date"
              value={followUpDate}
              onChange={(e) => setFollowUpDate(e.target.value)}
              aria-label="Follow-up reminder date"
              data-testid="input-sidebar-followup-date"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                className="flex-1"
                onClick={() => saveFollowUp(followUpDate || null)}
                disabled={updateContact.isPending || !followUpChanged}
                data-testid="button-sidebar-save-followup"
              >
                Save
              </Button>
              {contact.followUpDate && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setFollowUpDate("");
                    saveFollowUp(null);
                  }}
                  disabled={updateContact.isPending}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
