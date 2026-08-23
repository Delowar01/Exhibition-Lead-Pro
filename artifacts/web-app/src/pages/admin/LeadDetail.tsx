import React from "react";
import { useParams, useLocation } from "wouter";
import {
  useGetLead,
  useUpdateLead,
  useGetContact,
  useListPipelineStages,
  useListCrmOrganizations,
  useCreateLeadActivity,
  getGetLeadQueryKey,
  getGetContactQueryKey,
  getGetLeadPipelineQueryKey,
  getGetLeadTimelineQueryKey,
  getListLeadsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";

import {
  WorkspaceShell,
  WorkspaceHeader,
  WorkspaceContent,
  WorkspaceMain,
  WorkspaceSidebar,
} from "@/components/ds/workspace";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";

import {
  Building2,
  MapPin,
  Globe,
  Linkedin,
  CheckCircle2,
  Sparkles,
  Contact as ContactIcon,
} from "lucide-react";

import { CommunicationHub } from "@/components/CommunicationHub";
import DocumentsPanel from "@/components/DocumentsPanel";
import { AiInsightsPanel } from "@/components/AiInsightsPanel";
import { SalesCopilotPanel } from "@/components/SalesCopilotPanel";
import { WorkflowIntelligencePanel } from "@/components/WorkflowIntelligencePanel";

import { LeadTimelineCard } from "@/components/lead-detail/LeadTimelineCard";
import { LeadNotesTab } from "@/components/lead-detail/LeadNotesTab";
import { LeadActivitiesTab } from "@/components/lead-detail/LeadActivitiesTab";
import { TagsCard, AssignmentCard } from "@/components/lead-detail/LeadCards";

const ORG_NONE = "__none__";

function fmtDate(s?: string | null): string {
  if (!s) return "";
  try {
    return format(parseISO(s), "MMM d, yyyy");
  } catch {
    return s;
  }
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-sm font-medium text-muted-foreground mb-1">{label}</p>
      <div className="text-sm font-medium">{children}</div>
    </div>
  );
}

export default function AdminLeadDetail() {
  const params = useParams();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const id = params.id ? parseInt(params.id, 10) : 0;

  const { data: lead, isLoading } = useGetLead(id, {
    query: { enabled: !!id, queryKey: getGetLeadQueryKey(id) },
  });
  const contactId = lead?.contactId ?? 0;
  const { data: contact } = useGetContact(contactId, {
    query: { enabled: !!contactId, queryKey: getGetContactQueryKey(contactId) },
  });
  const { data: stagesData } = useListPipelineStages();
  const updateLead = useUpdateLead();
  const { data: orgData } = useListCrmOrganizations({ status: "active", limit: 200 });
  const organizations = orgData?.organizations ?? [];

  const handleOrgChange = (val: string) => {
    const organizationId = val === ORG_NONE ? null : Number(val);
    updateLead.mutate(
      { id, data: { organizationId } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(id) });
          toast({ title: organizationId ? "Company linked" : "Company unlinked" });
        },
        onError: () => toast({ title: "Could not update company", variant: "destructive" }),
      }
    );
  };

  // ── Closure lifecycle (Batch 11) ─────────────────────────────────────────
  // Won/Lost/Reopen go through ONE confirmation dialog; ordinary open→open
  // stage moves stay immediate. All paths use the existing stage mutation.
  type PendingChange = { kind: "won" | "lost" | "reopen" | "move"; stageKey: string; stageName: string };
  const [pendingChange, setPendingChange] = React.useState<PendingChange | null>(null);
  const [closeNote, setCloseNote] = React.useState("");
  const createActivity = useCreateLeadActivity();

  const invalidateLifecycle = () => {
    queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: getGetLeadPipelineQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetLeadTimelineQueryKey(id) });
    queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
  };

  const applyStageChange = (change: PendingChange, note: string) => {
    if (updateLead.isPending) return; // no duplicate requests
    updateLead.mutate(
      { id, data: { stage: change.stageKey as any } },
      {
        onSuccess: () => {
          // Optional close note rides on the EXISTING lead-activity architecture
          // (no schema change): a user-authored note tied to this lead.
          const trimmed = note.trim();
          if ((change.kind === "won" || change.kind === "lost") && trimmed) {
            createActivity.mutate(
              {
                id,
                data: {
                  type: "note",
                  subject: change.kind === "won" ? "Closed Won — note" : "Closed Lost — note",
                  body: trimmed,
                },
              },
              { onSettled: invalidateLifecycle },
            );
          } else {
            invalidateLifecycle();
          }
          toast({
            title:
              change.kind === "won"
                ? "Opportunity marked as Won"
                : change.kind === "lost"
                  ? "Opportunity marked as Lost"
                  : change.kind === "reopen"
                    ? "Opportunity reopened"
                    : "Lead stage updated",
            description:
              change.kind === "reopen" ? `Back in the ${change.stageName} stage and open pipeline.` : undefined,
          });
          setPendingChange(null);
          setCloseNote("");
        },
        onError: () => {
          toast({ title: "Update failed", description: "The stage was not changed.", variant: "destructive" });
        },
      },
    );
  };

  // Route a requested stage move: closures + reopens confirm first.
  const handleStageChange = (stageKey: string, stageList?: Array<{ key: string; name: string; isWon: boolean; isLost: boolean }>) => {
    const all = stageList ?? [];
    const currentKey = lead?.stageKey ?? lead?.stage ?? null;
    if (!lead || stageKey === currentKey || updateLead.isPending) return;
    const target = all.find((s) => s.key === stageKey);
    const targetName = target?.name ?? stageKey;
    const targetClosed = target ? target.isWon || target.isLost : stageKey === "won" || stageKey === "lost";
    const cur = all.find((s) => s.key === currentKey);
    const currentClosed = cur ? cur.isWon || cur.isLost : currentKey === "won" || currentKey === "lost";

    if (target?.isWon || (!target && stageKey === "won")) {
      setPendingChange({ kind: "won", stageKey, stageName: targetName });
    } else if (target?.isLost || (!target && stageKey === "lost")) {
      setPendingChange({ kind: "lost", stageKey, stageName: targetName });
    } else if (currentClosed && !targetClosed) {
      setPendingChange({ kind: "reopen", stageKey, stageName: targetName });
    } else {
      applyStageChange({ kind: "move", stageKey, stageName: targetName }, "");
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4 p-6" aria-busy="true" aria-label="Loading lead details">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-48 md:col-span-2" />
          <Skeleton className="h-48" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!lead) {
    return <div className="p-8 flex justify-center">Lead not found</div>;
  }

  const stages = [...(stagesData?.stages ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const currentIndex = stages.findIndex(
    (s) => (lead.stageKey ? s.key === lead.stageKey : s.key === lead.stage)
  );
  const wonStage = stages.find((s) => s.isWon);
  const lostStage = stages.find((s) => s.isLost);
  const firstOpenStage = stages.find((s) => !s.isWon && !s.isLost);
  const currentStage = currentIndex >= 0 ? stages[currentIndex] : undefined;
  const isClosed = currentStage
    ? currentStage.isWon || currentStage.isLost
    : lead.stage === "won" || lead.stage === "lost";

  const email = (lead.contactEmail ?? contact?.email) || null;
  const phone = (contact?.mobile ?? contact?.officePhone) || null;
  const jobTitle = contact?.jobTitle || null;
  const company = lead.organizationName || (lead.contactCompany ?? lead.companyName) || contact?.contactCompany || null;
  const industry = contact?.industry || null;
  const website = contact?.website || null;
  const linkedin = contact?.linkedin || null;
  const location = contact?.country || contact?.address || null;

  const hasAiData =
    (contact?.leadScore ?? null) !== null ||
    !!contact?.leadTemperature ||
    !!contact?.aiReasoning ||
    !!contact?.enrichmentSummary ||
    (contact?.talkingPoints && contact.talkingPoints.length > 0);

  const priorityBadge = () => {
    if (lead.priority === "high")
      return (
        <Badge variant="outline" className="text-destructive border-destructive/25 bg-destructive-soft">
          High Priority
        </Badge>
      );
    if (lead.priority === "medium")
      return (
        <Badge variant="outline" className="text-warning border-warning/25 bg-warning-soft">
          Medium Priority
        </Badge>
      );
    if (lead.priority === "low")
      return (
        <Badge variant="outline" className="text-success border-success/25 bg-success-soft">
          Low Priority
        </Badge>
      );
    return null;
  };

  const headerBadges = (
    <>
      {lead.stageName && (
        <Badge className="bg-primary/20 text-primary hover:bg-primary/30 border-none px-2.5 py-0.5 text-sm font-medium">
          {lead.stageName}
        </Badge>
      )}
      {priorityBadge()}
    </>
  );

  const headerSubtitle = (
    <>
      {company && (
        <>
          <Building2 className="h-4 w-4" />
          <span>{company}</span>
          <span className="text-border">•</span>
        </>
      )}
      <span>Created {fmtDate(lead.createdAt)}</span>
    </>
  );

  const headerActions = (
    <div className="flex items-center gap-2">
      {!isClosed && wonStage && (
        <Button
          onClick={() => setPendingChange({ kind: "won", stageKey: wonStage.key, stageName: wonStage.name })}
          disabled={updateLead.isPending}
          className="bg-success hover:bg-success/90 text-success-foreground"
          data-testid="lead-mark-won"
        >
          Mark as Won
        </Button>
      )}
      {!isClosed && lostStage && (
        <Button
          variant="outline"
          onClick={() => setPendingChange({ kind: "lost", stageKey: lostStage.key, stageName: lostStage.name })}
          disabled={updateLead.isPending}
          className="border-destructive/40 text-destructive hover:bg-destructive-soft hover:text-destructive"
          data-testid="lead-mark-lost"
        >
          Mark as Lost
        </Button>
      )}
      {isClosed && firstOpenStage && (
        <Button
          variant="outline"
          onClick={() =>
            setPendingChange({ kind: "reopen", stageKey: firstOpenStage.key, stageName: firstOpenStage.name })
          }
          disabled={updateLead.isPending}
          data-testid="lead-reopen"
        >
          Reopen Opportunity
        </Button>
      )}
    </div>
  );

  return (
    <WorkspaceShell>
      <WorkspaceHeader
        title={lead.contactName || lead.title || "Unnamed Lead"}
        subtitle={headerSubtitle}
        badges={headerBadges}
        actions={headerActions}
        onBack={() => setLocation("/admin/leads")}
      />

      <WorkspaceContent>
        <WorkspaceMain>
          {stages.length > 0 && (
            <Card className="shadow-sm">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg">Pipeline Status</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between relative overflow-x-auto">
                  <div className="absolute left-0 top-[14px] w-full h-1 bg-secondary rounded-full -z-10"></div>
                  {stages.map((stage, index) => {
                    const isPast = currentIndex >= 0 && index <= currentIndex;
                    const isCurrent = index === currentIndex;
                    return (
                      <div
                        key={stage.id}
                        className="flex flex-col items-center gap-2 bg-card px-2 min-w-[70px]"
                      >
                        <button
                          onClick={() => handleStageChange(stage.key, stages)}
                          className={`w-7 h-7 rounded-full flex items-center justify-center border-2 transition-colors ${
                            isCurrent
                              ? "border-primary bg-primary text-primary-foreground"
                              : isPast
                              ? "border-primary bg-primary/20 text-primary"
                              : "border-border bg-background text-muted-foreground"
                          }`}
                        >
                          {isPast && !isCurrent ? (
                            <CheckCircle2 className="h-4 w-4" />
                          ) : (
                            <div className="w-2 h-2 rounded-full bg-current" />
                          )}
                        </button>
                        <span
                          className={`text-[10px] font-medium uppercase tracking-wider text-center ${
                            isCurrent ? "text-primary" : "text-muted-foreground"
                          }`}
                        >
                          {stage.name}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          <Tabs defaultValue="overview" className="w-full">
            <TabsList className="w-full justify-start border-b border-border rounded-none h-auto p-0 bg-transparent mb-6 overflow-x-auto flex-nowrap shrink-0">
              <TabsTrigger
                value="overview"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3 shrink-0"
              >
                Overview
              </TabsTrigger>
              <TabsTrigger
                value="notes"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3 shrink-0"
              >
                Notes
              </TabsTrigger>
              <TabsTrigger
                value="activities"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3 shrink-0"
              >
                Activities
              </TabsTrigger>
              <TabsTrigger
                value="tasks"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3 shrink-0"
              >
                Tasks
              </TabsTrigger>
              <TabsTrigger
                value="documents"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3 shrink-0"
              >
                Documents
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
                    {!email && !phone && !jobTitle && !linkedin && (
                      <p className="text-sm text-muted-foreground">No contact details available.</p>
                    )}
                    {email && (
                      <InfoRow label="Email">
                        <a href={`mailto:${email}`} className="text-primary hover:underline">
                          {email}
                        </a>
                      </InfoRow>
                    )}
                    {phone && (
                      <InfoRow label="Phone">
                        <a href={`tel:${phone}`} className="hover:underline">
                          {phone}
                        </a>
                      </InfoRow>
                    )}
                    {jobTitle && <InfoRow label="Job Title">{jobTitle}</InfoRow>}
                    {linkedin && (
                      <InfoRow label="LinkedIn">
                        <a
                          href={linkedin}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline flex items-center gap-1"
                        >
                          <Linkedin className="h-3 w-3" /> {linkedin}
                        </a>
                      </InfoRow>
                    )}
                  </CardContent>
                </Card>

                <Card className="shadow-sm border-border/50">
                  <CardHeader className="pb-3 bg-secondary/30">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-primary" /> Company Information
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4 space-y-4">
                    {!company && !industry && !website && !location && (
                      <p className="text-sm text-muted-foreground">No company details available.</p>
                    )}
                    {company && <InfoRow label="Company">{company}</InfoRow>}
                    {industry && <InfoRow label="Industry">{industry}</InfoRow>}
                    {website && (
                      <InfoRow label="Website">
                        <a
                          href={website}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline flex items-center gap-1"
                        >
                          <Globe className="h-3 w-3" /> {website}
                        </a>
                      </InfoRow>
                    )}
                    {location && (
                      <InfoRow label="Location">
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3 text-muted-foreground" /> {location}
                        </span>
                      </InfoRow>
                    )}
                  </CardContent>
                </Card>
              </div>

              <LeadTimelineCard leadId={id} />
            </TabsContent>

            <TabsContent value="notes">
              <LeadNotesTab leadId={id} />
            </TabsContent>
            <TabsContent value="activities">
              <LeadActivitiesTab leadId={id} />
            </TabsContent>
            <TabsContent value="tasks">
              <Card>
                <CardContent className="p-10 text-center text-muted-foreground text-sm">
                  No tasks. Task management is not available for leads yet.
                </CardContent>
              </Card>
            </TabsContent>
            <TabsContent value="documents">
              <DocumentsPanel entityType="lead" entityId={id} />
            </TabsContent>
          </Tabs>
        </WorkspaceMain>

        <WorkspaceSidebar>
          <CommunicationHub
            entity="lead"
            id={id}
            email={email}
            phone={phone}
            displayName={lead.contactName || lead.title || null}
          />

          {hasAiData && (
            <Card className="shadow-sm border-primary/20 bg-gradient-to-b from-primary/5 to-background">
              <CardHeader className="pb-3 border-b border-primary/10">
                <CardTitle className="text-base flex items-center gap-2 text-primary">
                  <Sparkles className="h-4 w-4" /> Lead Intelligence
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-4 space-y-5">
                {(contact?.leadScore ?? null) !== null && (
                  <div className="flex items-center gap-4">
                    <div className="flex flex-col">
                      <span className="text-4xl font-bold">{contact?.leadScore}</span>
                      <span className="text-xs text-muted-foreground uppercase tracking-widest">
                        Lead Score
                      </span>
                    </div>
                    {contact?.leadTemperature && (
                      <Badge variant="secondary" className="capitalize">
                        {contact.leadTemperature}
                      </Badge>
                    )}
                  </div>
                )}
                {contact?.enrichmentSummary && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      Summary
                    </p>
                    <p className="text-sm leading-relaxed">{contact.enrichmentSummary}</p>
                  </div>
                )}
                {contact?.aiReasoning && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      Reasoning
                    </p>
                    <p className="text-sm leading-relaxed">{contact.aiReasoning}</p>
                  </div>
                )}
                {contact?.talkingPoints && contact.talkingPoints.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      Talking Points
                    </p>
                    <ul className="text-sm space-y-1">
                      {contact.talkingPoints.map((point, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <div className="w-1 h-1 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                          <span>{point}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <SalesCopilotPanel entityType="lead" id={id} />
          <WorkflowIntelligencePanel entityType="lead" id={id} />
          <AiInsightsPanel entityType="lead" id={id} />
          
          <AssignmentCard lead={lead as any} leadId={id} />
          <TagsCard leadId={id} />

          <Card className="shadow-sm">
            <CardHeader className="pb-3 border-b border-border mb-3">
              <CardTitle className="text-base">Deal Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium text-muted-foreground">Company (CRM record)</Label>
                <Select value={lead.organizationId ? String(lead.organizationId) : ORG_NONE} onValueChange={handleOrgChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Link to a company" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ORG_NONE}>None</SelectItem>
                    {organizations.map((o) => (
                      <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {(lead.value ?? null) !== null && (
                <InfoRow label="Value">
                  {(lead.currency ?? "") + " "}
                  {(lead.value ?? 0).toLocaleString()}
                </InfoRow>
              )}
              {(lead.probability ?? null) !== null && (
                <InfoRow label="Probability">{lead.probability}%</InfoRow>
              )}
              {lead.closingDate && (
                <InfoRow label="Closing Date">{fmtDate(lead.closingDate)}</InfoRow>
              )}
              {lead.eventName && <InfoRow label="Source Event">{lead.eventName}</InfoRow>}
              {(lead.value ?? null) === null &&
                (lead.probability ?? null) === null &&
                !lead.closingDate &&
                !lead.eventName && (
                  <p className="text-sm text-muted-foreground">No deal details recorded.</p>
                )}
            </CardContent>
          </Card>
        </WorkspaceSidebar>
      </WorkspaceContent>

      {/* Won / Lost / Reopen confirmation — cancel performs no mutation. */}
      <AlertDialog
        open={pendingChange !== null}
        onOpenChange={(open) => {
          if (!open && !updateLead.isPending) {
            setPendingChange(null);
            setCloseNote("");
          }
        }}
      >
        <AlertDialogContent data-testid="lead-close-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingChange?.kind === "won" && "Mark this opportunity as Won?"}
              {pendingChange?.kind === "lost" && "Mark this opportunity as Lost?"}
              {pendingChange?.kind === "reopen" && "Reopen this opportunity?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingChange?.kind === "won" &&
                `The lead moves to the ${pendingChange.stageName} stage and is recorded as Closed Won. Its contact, documents, notes and full history stay intact, and you can reopen it later.`}
              {pendingChange?.kind === "lost" &&
                `The lead moves to the ${pendingChange.stageName} stage and is recorded as Closed Lost. It leaves the open pipeline total but remains fully available, and this contact can get a new opportunity afterwards.`}
              {pendingChange?.kind === "reopen" &&
                `The lead returns to the ${pendingChange.stageName} stage and counts toward the open pipeline again. All previous win/loss history is preserved.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {(pendingChange?.kind === "won" || pendingChange?.kind === "lost") && (
            <div className="space-y-1.5">
              <Label htmlFor="close-note" className="text-xs text-muted-foreground">
                Closing note (optional)
              </Label>
              <Textarea
                id="close-note"
                data-testid="lead-close-note"
                placeholder={
                  pendingChange.kind === "won" ? "e.g. Signed a 12-month contract…" : "e.g. Went with a competitor…"
                }
                value={closeNote}
                onChange={(e) => setCloseNote(e.target.value)}
                rows={3}
              />
              <p className="text-[11px] text-muted-foreground">Saved to this lead's activity timeline.</p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={updateLead.isPending} data-testid="lead-close-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={updateLead.isPending}
              data-testid="lead-close-confirm"
              onClick={(e) => {
                e.preventDefault(); // keep the dialog open until the request settles
                if (pendingChange) applyStageChange(pendingChange, closeNote);
              }}
              className={
                pendingChange?.kind === "lost"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
            >
              {updateLead.isPending
                ? "Saving…"
                : pendingChange?.kind === "won"
                  ? "Mark as Won"
                  : pendingChange?.kind === "lost"
                    ? "Mark as Lost"
                    : "Reopen"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </WorkspaceShell>
  );
}
