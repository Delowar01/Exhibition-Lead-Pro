import React, { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import {
  useGetContact,
  useUpdateContact,
  useDeleteContact,
  useEnrichContact,
  useListCrmOrganizations,
  useListContactInteractions,
  getGetContactQueryKey,
  ContactStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ChevronLeft,
  Mail,
  Phone,
  Building2,
  Briefcase,
  Calendar as CalendarIcon,
  CalendarClock,
  AlertCircle,
  Trash2,
  Sparkles,
  Flame,
  Snowflake,
  Thermometer,
  Globe,
  Linkedin,
  MapPin,
  MessageSquare,
  Factory,
  Award,
  Contact as ContactIcon,
  CheckCircle2,
  History,
  Clock,
  User,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format, parseISO } from "date-fns";

import {
  WorkspaceShell,
  WorkspaceHeader,
  WorkspaceContent,
  WorkspaceMain,
  WorkspaceSidebar,
} from "@/components/ds/workspace";

import { CommunicationHub } from "@/components/CommunicationHub";
import { AiInsightsPanel } from "@/components/AiInsightsPanel";
import { SalesCopilotPanel } from "@/components/SalesCopilotPanel";
import { WorkflowIntelligencePanel } from "@/components/WorkflowIntelligencePanel";

const ORG_NONE = "__none__";

const TEMPERATURE_STYLES: Record<string, { label: string; badge: string; bar: string; icon: React.ReactNode }> = {
  hot: {
    label: "Hot",
    badge: "bg-destructive-soft text-destructive border-destructive/25",
    bar: "bg-destructive",
    icon: <Flame className="h-4 w-4" />,
  },
  warm: {
    label: "Warm",
    badge: "bg-warning-soft text-warning border-warning/25",
    bar: "bg-warning",
    icon: <Thermometer className="h-4 w-4" />,
  },
  cold: {
    label: "Cold",
    badge: "bg-info-soft text-info border-info/25",
    bar: "bg-info",
    icon: <Snowflake className="h-4 w-4" />,
  },
};

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div>
      <p className="text-sm font-medium text-muted-foreground mb-1">{label}</p>
      <div className="text-sm font-medium">{children}</div>
    </div>
  );
}

export default function AdminContactDetail() {
  const { id } = useParams();
  const contactId = parseInt(id || "0", 10);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: contact, isLoading } = useGetContact(contactId, {
    query: { enabled: !!contactId, queryKey: getGetContactQueryKey(contactId) },
  });

  const updateContact = useUpdateContact();
  const deleteContact = useDeleteContact();
  const enrich = useEnrichContact();
  const { data: orgData } = useListCrmOrganizations({ status: "active", limit: 200 });
  const organizations = orgData?.organizations ?? [];

  const { data: interactionsData } = useListContactInteractions(contactId);
  const interactions = interactionsData?.interactions ?? [];
  const interactionTotal = interactionsData?.total ?? 0;

  const handleOrgChange = (val: string) => {
    const organizationId = val === ORG_NONE ? null : Number(val);
    updateContact.mutate(
      { id: contactId, data: { organizationId } },
      {
        onSuccess: () => {
          toast({ title: organizationId ? "Company linked" : "Company unlinked" });
          queryClient.invalidateQueries({ queryKey: getGetContactQueryKey(contactId) });
        },
        onError: () => toast({ title: "Could not update company", variant: "destructive" }),
      }
    );
  };

  const handleEnrich = () => {
    enrich.mutate(
      { id: contactId },
      {
        onSuccess: () => {
          toast({ title: "Contact enriched" });
          queryClient.invalidateQueries({ queryKey: getGetContactQueryKey(contactId) });
        },
        onError: () => {
          toast({
            title: "Enrichment failed",
            description: "The AI service is temporarily unavailable. Please try again.",
            variant: "destructive",
          });
        },
      }
    );
  };

  const [followUpDate, setFollowUpDate] = useState<string>("");
  useEffect(() => {
    setFollowUpDate(contact?.followUpDate ?? "");
  }, [contact?.followUpDate]);

  const saveFollowUp = (value: string | null) => {
    updateContact.mutate(
      { id: contactId, data: { followUpDate: value } },
      {
        onSuccess: () => {
          toast({ title: value ? "Follow-up scheduled" : "Follow-up cleared" });
          queryClient.invalidateQueries({ queryKey: getGetContactQueryKey(contactId) });
        },
        onError: () => {
          toast({ title: "Could not update follow-up", variant: "destructive" });
          setFollowUpDate(contact?.followUpDate ?? "");
        },
      }
    );
  };

  const handleClearFollowUp = () => {
    setFollowUpDate("");
    saveFollowUp(null);
  };

  const handleStatusChange = (newStatus: ContactStatus) => {
    updateContact.mutate(
      { id: contactId, data: { status: newStatus } },
      {
        onSuccess: () => {
          toast({ title: "Status updated" });
          queryClient.invalidateQueries({ queryKey: getGetContactQueryKey(contactId) });
        },
      }
    );
  };

  const handleDelete = () => {
    if (confirm("Are you sure you want to delete this contact?")) {
      deleteContact.mutate(
        { id: contactId },
        {
          onSuccess: () => {
            toast({ title: "Contact deleted" });
            setLocation("/admin/contacts");
          },
        }
      );
    }
  };

  if (isLoading) return <div className="p-8 flex justify-center text-muted-foreground">Loading contact...</div>;
  if (!contact) return <div className="p-8 flex justify-center text-muted-foreground">Contact not found</div>;

  const temp = contact.leadTemperature ? TEMPERATURE_STYLES[contact.leadTemperature] : null;
  const todayStr = format(new Date(), "yyyy-MM-dd");
  const followUpOverdue = !!contact.followUpDate && contact.followUpDate < todayStr;
  const followUpChanged = followUpDate !== (contact.followUpDate ?? "");

  const hasAiData =
    (contact.leadScore ?? null) !== null ||
    !!contact.leadTemperature ||
    !!contact.aiReasoning ||
    !!contact.enrichmentSummary ||
    (contact.talkingPoints && contact.talkingPoints.length > 0);

  const headerBadges = (
    <>
      <Badge variant="outline" className="capitalize bg-background">
        {contact.status.replace("_", " ")}
      </Badge>
      {temp && (
        <Badge variant="outline" className={`gap-1 ${temp.badge}`}>
          {temp.icon} {temp.label}
        </Badge>
      )}
    </>
  );

  const headerSubtitle = (
    <>
      {contact.jobTitle && (
        <>
          <Briefcase className="h-4 w-4" />
          <span>{contact.jobTitle}</span>
          <span className="text-border">•</span>
        </>
      )}
      {contact.contactCompany && (
        <>
          <Building2 className="h-4 w-4" />
          <span>{contact.contactCompany}</span>
          <span className="text-border">•</span>
        </>
      )}
      <span>Added {format(new Date(contact.createdAt), "MMM d, yyyy")}</span>
    </>
  );

  const headerActions = (
    <Button variant="destructive" size="sm" onClick={handleDelete}>
      <Trash2 className="h-4 w-4 mr-2" /> Delete
    </Button>
  );

  const fullName = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "Unnamed Contact";

  return (
    <WorkspaceShell>
      <WorkspaceHeader
        title={fullName}
        subtitle={headerSubtitle}
        badges={headerBadges}
        actions={headerActions}
        onBack={() => setLocation("/admin/contacts")}
      />

      <WorkspaceContent>
        <WorkspaceMain>
          <Tabs defaultValue="overview" className="w-full">
            <TabsList className="w-full justify-start border-b border-border rounded-none h-auto p-0 bg-transparent mb-6 overflow-x-auto flex-nowrap shrink-0">
              <TabsTrigger
                value="overview"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3 shrink-0"
              >
                Overview
              </TabsTrigger>
              <TabsTrigger
                value="ai"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3 shrink-0 flex items-center gap-2"
              >
                <Sparkles className="h-3 w-3" /> AI Enrichment
              </TabsTrigger>
              <TabsTrigger
                value="notes"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3 shrink-0"
              >
                Notes
              </TabsTrigger>
              <TabsTrigger
                value="interactions"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3 shrink-0"
              >
                Interactions
              </TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-6 mt-0">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card className="shadow-sm border-border/50">
                  <CardHeader className="pb-3 bg-secondary/30">
                    <CardTitle className="text-base flex items-center gap-2">
                      <ContactIcon className="h-4 w-4 text-primary" /> Contact Information
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4 space-y-4">
                    {!contact.email && !contact.mobile && !contact.linkedin && (
                      <p className="text-sm text-muted-foreground">No contact details available.</p>
                    )}
                    {contact.email && (
                      <InfoRow label="Email">
                        <a href={`mailto:${contact.email}`} className="text-primary hover:underline">
                          {contact.email}
                        </a>
                      </InfoRow>
                    )}
                    {contact.mobile && (
                      <InfoRow label="Phone">
                        <a href={`tel:${contact.mobile}`} className="hover:underline">
                          {contact.mobile}
                        </a>
                      </InfoRow>
                    )}
                    {contact.linkedin && (
                      <InfoRow label="LinkedIn">
                        <a
                          href={contact.linkedin}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline flex items-center gap-1"
                        >
                          <Linkedin className="h-3 w-3" /> {contact.linkedin}
                        </a>
                      </InfoRow>
                    )}
                    {contact.website && (
                      <InfoRow label="Website">
                        <a
                          href={contact.website}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline flex items-center gap-1"
                        >
                          <Globe className="h-3 w-3" /> {contact.website}
                        </a>
                      </InfoRow>
                    )}
                    {contact.address && (
                      <InfoRow label="Address">
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3 text-muted-foreground" /> {contact.address}
                        </span>
                      </InfoRow>
                    )}
                  </CardContent>
                </Card>

                {contact.cardImageUrl && (
                  <Card className="shadow-sm border-border/50 overflow-hidden flex flex-col">
                    <CardHeader className="pb-3 bg-secondary/30">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-primary" /> Business Card
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-0 flex-1 bg-muted/20 flex items-center justify-center">
                      <img src={contact.cardImageUrl} alt="Scanned Business Card" className="object-contain w-full h-full max-h-[260px] p-2" />
                    </CardContent>
                  </Card>
                )}
              </div>
            </TabsContent>

            <TabsContent value="ai" className="mt-0">
              <Card className="shadow-sm border-primary/20">
                <CardHeader className="pb-3 bg-primary/5 border-b border-primary/10">
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2 text-primary">
                      <Sparkles className="h-4 w-4" /> AI Enrichment
                    </CardTitle>
                    <Button variant="outline" size="sm" onClick={handleEnrich} disabled={enrich.isPending}>
                      <Sparkles className="h-4 w-4 mr-2" />
                      {enrich.isPending ? "Enriching..." : contact.enrichedAt ? "Re-run" : "Enrich with AI"}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="pt-6">
                  {contact.enrichedAt ? (
                    <div className="space-y-6">
                      <div className="grid grid-cols-2 gap-6">
                        <div className="space-y-1">
                          <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                            <Factory className="h-4 w-4" /> Industry
                          </div>
                          <div className="font-medium text-base">{contact.industry || "—"}</div>
                        </div>
                        <div className="space-y-1">
                          <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                            <Award className="h-4 w-4" /> Seniority
                          </div>
                          <div className="font-medium text-base">{contact.seniority || "—"}</div>
                        </div>
                      </div>
                      {contact.enrichmentSummary && (
                        <div className="space-y-2">
                          <div className="text-sm font-medium text-muted-foreground">Summary</div>
                          <p className="text-sm bg-secondary/30 p-4 rounded-md border border-border leading-relaxed">
                            {contact.enrichmentSummary}
                          </p>
                        </div>
                      )}
                      {contact.talkingPoints && contact.talkingPoints.length > 0 && (
                        <div className="space-y-3">
                          <div className="text-sm font-medium text-muted-foreground">Suggested Talking Points</div>
                          <ul className="space-y-3">
                            {contact.talkingPoints.map((p, i) => (
                              <li key={i} className="flex items-start gap-3 text-sm bg-secondary/20 p-3 rounded-md border border-border/50">
                                <MessageSquare className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                                <span className="leading-relaxed">{p}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Enriched {format(new Date(contact.enrichedAt), "PPp")}
                      </p>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground italic py-8 text-center bg-secondary/20 rounded-md border border-dashed">
                      No enrichment yet. Run AI enrichment to infer this contact's industry, seniority, and personalized talking points.
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="notes" className="mt-0">
              <Card className="shadow-sm">
                <CardContent className="p-0">
                  <div className="bg-secondary/10 p-6 text-sm min-h-[200px]">
                    {contact.notes ? (
                      <div className="whitespace-pre-wrap">{contact.notes}</div>
                    ) : (
                      <div className="text-muted-foreground italic text-center py-12">No notes added.</div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="interactions" className="mt-0">
              <Card className="shadow-sm border-border/50">
                <CardHeader className="pb-3 bg-secondary/30">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <History className="h-4 w-4 text-primary" /> Interaction History
                    </CardTitle>
                    <Badge variant="secondary" className="font-mono">
                      {interactionTotal}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="pt-4">
                  {interactions.length === 0 ? (
                    <div className="text-sm text-muted-foreground italic py-8 text-center bg-secondary/10 rounded-md border border-dashed">
                      No interactions recorded for this contact yet.
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {interactions.map((it) => (
                        <div key={it.id} className="flex gap-4 p-3 rounded-lg border border-border/40 hover:bg-secondary/5 transition-colors">
                          <div className="mt-1 text-muted-foreground shrink-0">
                            <div className="p-2 bg-secondary/30 rounded-full">
                              <Clock className="h-4 w-4" />
                            </div>
                          </div>
                          <div className="flex-1 space-y-2">
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-2">
                                {it.captureSource && (
                                  <Badge variant="outline" className="capitalize text-[10px] h-5">
                                    {it.captureSource.replace(/_/g, " ")}
                                  </Badge>
                                )}
                                {it.eventName && (
                                  <span className="text-sm font-semibold">{it.eventName}</span>
                                )}
                              </div>
                              <span className="text-xs text-muted-foreground bg-secondary/20 px-2 py-0.5 rounded-full">
                                {format(new Date(it.occurredAt), "PPp")}
                              </span>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                              {it.userName && (
                                <span className="flex items-center gap-1.5">
                                  <User className="h-3.5 w-3.5" /> {it.userName}
                                </span>
                              )}
                              {it.latitude != null && it.longitude != null && (
                                <span className="flex items-center gap-1.5">
                                  <MapPin className="h-3.5 w-3.5" /> Captured Location
                                </span>
                              )}
                            </div>
                            {it.notes && (
                              <div className="text-sm bg-secondary/20 p-2 rounded border border-border/30 text-foreground/90">
                                {it.notes}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </WorkspaceMain>

        <WorkspaceSidebar>
          <CommunicationHub
            entity="contact"
            id={contactId}
            email={contact.email}
            phone={contact.mobile}
            displayName={fullName}
          />

          {hasAiData && (
            <Card className="shadow-sm border-primary/20 bg-gradient-to-b from-primary/5 to-background">
              <CardHeader className="pb-3 border-b border-primary/10">
                <CardTitle className="text-base flex items-center gap-2 text-primary">
                  <Sparkles className="h-4 w-4" /> Intelligence
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 space-y-5">
                {(contact.leadScore ?? null) !== null && (
                  <div className="flex items-center gap-4">
                    <div className="flex flex-col">
                      <span className="text-4xl font-bold">{contact.leadScore}</span>
                      <span className="text-xs text-muted-foreground uppercase tracking-widest">Lead Score</span>
                    </div>
                    {temp && (
                      <Badge variant="secondary" className={`gap-1 ${temp.badge}`}>
                        {temp.icon} {temp.label}
                      </Badge>
                    )}
                  </div>
                )}
                {contact.aiReasoning && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      Reasoning
                    </p>
                    <p className="text-sm leading-relaxed">{contact.aiReasoning}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <SalesCopilotPanel entityType="contact" id={contactId} />
          <WorkflowIntelligencePanel entityType="contact" id={contactId} />
          <AiInsightsPanel entityType="contact" id={contactId} />

          <Card className="shadow-sm">
            <CardHeader className="pb-3 border-b border-border mb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Building2 className="h-4 w-4 text-primary" /> CRM Record
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Company</label>
                <Select
                  value={contact.organizationId ? String(contact.organizationId) : ORG_NONE}
                  onValueChange={handleOrgChange}
                >
                  <SelectTrigger className="w-full">
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

              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Pipeline Status</label>
                <Select value={contact.status} onValueChange={(val) => handleStatusChange(val as ContactStatus)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(ContactStatus).map((s) => (
                      <SelectItem key={s} value={s} className="capitalize">
                        {s.replace("_", " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="pb-3 border-b border-border mb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-primary" /> Follow-up
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {contact.followUpDate ? (
                <div
                  className={`flex items-center justify-between rounded-md border p-3 text-sm ${
                    followUpOverdue
                      ? "border-destructive/25 bg-destructive-soft text-destructive"
                      : "border-border bg-secondary/30"
                  }`}
                >
                  <span className="flex items-center gap-2 font-medium">
                    {followUpOverdue && <AlertCircle className="h-4 w-4" />}
                    {format(parseISO(contact.followUpDate), "PPP")}
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-wider">
                    {followUpOverdue ? "Overdue" : "Scheduled"}
                  </span>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground italic">No follow-up scheduled.</p>
              )}
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">Set reminder date</label>
                <Input type="date" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    onClick={() => saveFollowUp(followUpDate || null)}
                    disabled={updateContact.isPending || !followUpChanged}
                  >
                    Save
                  </Button>
                  {contact.followUpDate && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleClearFollowUp}
                      disabled={updateContact.isPending}
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

        </WorkspaceSidebar>
      </WorkspaceContent>
    </WorkspaceShell>
  );
}
