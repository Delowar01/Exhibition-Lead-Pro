import React, { useState } from "react";
import { useParams, useLocation } from "wouter";
import {
  useGetLead,
  useUpdateLead,
  useGetContact,
  useListPipelineStages,
  useGetLeadTimeline,
  useListLeadNotes,
  useCreateLeadNote,
  useUpdateLeadNote,
  useDeleteLeadNote,
  useListLeadNoteComments,
  useCreateLeadNoteComment,
  useUpdateLeadNoteComment,
  useDeleteLeadNoteComment,
  useListLeadNoteHistory,
  getListLeadNoteCommentsQueryKey,
  getListLeadNoteHistoryQueryKey,
  getListUsersQueryKey,
  type LeadNoteComment,
  useListLeadActivities,
  useCreateLeadActivity,
  useUpdateLeadActivity,
  useDeleteLeadActivity,
  useListLeadTags,
  useAttachLeadTag,
  useDetachLeadTag,
  useListTags,
  useAssignLead,
  useAutoAssignLead,
  useRecommendLeadAssignee,
  useListUsers,
  useListTeams,
  AssignLeadInputStrategy,
  type AssigneeRecommendation,
  getGetLeadQueryKey,
  getGetContactQueryKey,
  getGetLeadPipelineQueryKey,
  getListLeadNotesQueryKey,
  getListLeadActivitiesQueryKey,
  getListLeadTagsQueryKey,
  getGetLeadTimelineQueryKey,
  LeadActivityInputType,
  type LeadNote,
  type LeadActivity,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { CommunicationHub } from "@/components/CommunicationHub";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import DocumentsPanel from "@/components/DocumentsPanel";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Building2,
  Mail,
  Phone,
  ArrowLeft,
  Calendar as CalendarIcon,
  MapPin,
  Globe,
  Linkedin,
  CheckCircle2,
  Clock,
  Sparkles,
  Pin,
  PinOff,
  Plus,
  Pencil,
  Trash2,
  X,
  User as UserIcon,
  MessageSquare,
  FileText,
  History as HistoryIcon,
  Contact as ContactIcon,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { MentionText } from "@/components/collaboration/MentionText";
import { MentionInput, type MentionUser } from "@/components/collaboration/MentionInput";

function fmtDate(s?: string | null): string {
  if (!s) return "";
  try {
    return format(parseISO(s), "MMM d, yyyy");
  } catch {
    return s;
  }
}

function fmtDateTime(s?: string | null): string {
  if (!s) return "";
  try {
    return format(parseISO(s), "MMM d, yyyy h:mm a");
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

  const handleStageChange = (stageKey: string) => {
    updateLead.mutate(
      { id, data: { stage: stageKey as any } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(id) });
          queryClient.invalidateQueries({ queryKey: getGetLeadPipelineQueryKey() });
          toast({ title: "Lead stage updated" });
        },
        onError: () => {
          toast({ title: "Update failed", variant: "destructive" });
        },
      }
    );
  };

  if (isLoading) {
    return <div className="p-8 flex justify-center">Loading lead details...</div>;
  }

  if (!lead) {
    return <div className="p-8 flex justify-center">Lead not found</div>;
  }

  const stages = [...(stagesData?.stages ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const currentIndex = stages.findIndex(
    (s) => (lead.stageKey ? s.key === lead.stageKey : s.key === lead.stage)
  );
  const wonStage = stages.find((s) => s.isWon);

  const email = (lead.contactEmail ?? contact?.email) || null;
  const phone = (contact?.mobile ?? contact?.officePhone) || null;
  const jobTitle = contact?.jobTitle || null;
  const company = (lead.contactCompany ?? lead.companyName) || contact?.contactCompany || null;
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
        <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50">
          High Priority
        </Badge>
      );
    if (lead.priority === "medium")
      return (
        <Badge variant="outline" className="text-yellow-700 border-yellow-200 bg-yellow-50">
          Medium Priority
        </Badge>
      );
    if (lead.priority === "low")
      return (
        <Badge variant="outline" className="text-green-700 border-green-200 bg-green-50">
          Low Priority
        </Badge>
      );
    return null;
  };

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setLocation("/admin/leads")}
          className="rounded-full"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-3xl font-bold tracking-tight">
              {lead.contactName || lead.title || "Unnamed Lead"}
            </h1>
            {lead.stageName && (
              <Badge className="bg-primary/20 text-primary hover:bg-primary/30 border-none px-2.5 py-0.5 text-sm font-medium">
                {lead.stageName}
              </Badge>
            )}
            {priorityBadge()}
          </div>
          <div className="text-muted-foreground mt-1 flex items-center gap-2 text-sm flex-wrap">
            {company && (
              <>
                <Building2 className="h-4 w-4" />
                <span>{company}</span>
                <span className="text-border">•</span>
              </>
            )}
            <span>Created {fmtDate(lead.createdAt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {wonStage && !stages[currentIndex]?.isWon && (
            <Button
              onClick={() => handleStageChange(wonStage.key)}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              Mark as Won
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
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
                          onClick={() => handleStageChange(stage.key)}
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
            <TabsList className="w-full justify-start border-b border-border rounded-none h-auto p-0 bg-transparent mb-6">
              <TabsTrigger
                value="overview"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3"
              >
                Overview
              </TabsTrigger>
              <TabsTrigger
                value="notes"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3"
              >
                Notes
              </TabsTrigger>
              <TabsTrigger
                value="activities"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3"
              >
                Activities
              </TabsTrigger>
              <TabsTrigger
                value="tasks"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3"
              >
                Tasks
              </TabsTrigger>
              <TabsTrigger
                value="documents"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3"
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
                          className="text-blue-600 hover:underline flex items-center gap-1"
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
                          className="text-blue-600 hover:underline flex items-center gap-1"
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

              <TimelineCard leadId={id} />
            </TabsContent>

            <TabsContent value="notes">
              <NotesTab leadId={id} />
            </TabsContent>
            <TabsContent value="activities">
              <ActivitiesTab leadId={id} />
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
        </div>

        <div className="space-y-6">
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

          <AssignmentCard lead={lead} leadId={id} />

          <TagsCard leadId={id} />

          <Card className="shadow-sm">
            <CardHeader className="pb-3 border-b border-border mb-3">
              <CardTitle className="text-base">Deal Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
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
        </div>
      </div>
    </div>
  );
}

function TimelineCard({ leadId }: { leadId: number }) {
  const { data, isLoading } = useGetLeadTimeline(leadId, {
    query: { enabled: !!leadId, queryKey: getGetLeadTimelineQueryKey(leadId) },
  });

  const entries = [...(data?.entries ?? [])].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
  );

  const iconFor = (kind: string) => {
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
  };

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-lg">Lead Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading timeline...</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No timeline activity yet.
          </p>
        ) : (
          <div className="relative pl-6 border-l border-border space-y-6">
            {entries.map((entry) => (
              <div key={entry.id} className="relative">
                <div className="absolute -left-[31px] bg-primary p-1 rounded-full border-4 border-card">
                  {iconFor(entry.kind)}
                </div>
                <div>
                  <p className="text-sm font-medium">
                    {entry.title || entry.type || entry.kind.replace("_", " ")}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {fmtDateTime(entry.occurredAt)}
                    {entry.actorName ? ` • ${entry.actorName}` : ""}
                  </p>
                  {entry.body && (
                    <div className="mt-2 text-sm bg-secondary/50 p-3 rounded-md border border-border">
                      {entry.body}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function NotesTab({ leadId }: { leadId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListLeadNotes(leadId, {
    query: { enabled: !!leadId, queryKey: getListLeadNotesQueryKey(leadId) },
  });
  const { data: usersData } = useListUsers(
    { limit: 200 },
    { query: { queryKey: getListUsersQueryKey({ limit: 200 }) } },
  );
  const mentionUsers: MentionUser[] = (usersData?.users ?? [])
    .filter((u) => u.isActive !== false)
    .map((u) => ({ id: u.id, name: u.name }));

  const createNote = useCreateLeadNote();
  const updateNote = useUpdateLeadNote();
  const deleteNote = useDeleteLeadNote();

  const [body, setBody] = useState("");
  const [editing, setEditing] = useState<LeadNote | null>(null);
  const [editBody, setEditBody] = useState("");
  const [historyFor, setHistoryFor] = useState<LeadNote | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListLeadNotesQueryKey(leadId) });

  const notes = [...(data?.notes ?? [])].sort((a, b) => {
    if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const handleAdd = () => {
    if (!body.trim()) return;
    createNote.mutate(
      { id: leadId, data: { body: body.trim() } },
      {
        onSuccess: () => {
          setBody("");
          invalidate();
          toast({ title: "Note added" });
        },
        onError: () => toast({ title: "Could not add note", variant: "destructive" }),
      }
    );
  };

  const handleTogglePin = (note: LeadNote) => {
    updateNote.mutate(
      { id: note.id, data: { isPinned: !note.isPinned } },
      {
        onSuccess: invalidate,
        onError: () => toast({ title: "Could not update note", variant: "destructive" }),
      }
    );
  };

  const handleSaveEdit = () => {
    if (!editing || !editBody.trim()) return;
    updateNote.mutate(
      { id: editing.id, data: { body: editBody.trim() } },
      {
        onSuccess: () => {
          setEditing(null);
          invalidate();
          toast({ title: "Note updated" });
        },
        onError: () => toast({ title: "Could not update note", variant: "destructive" }),
      }
    );
  };

  const handleDelete = (note: LeadNote) => {
    deleteNote.mutate(
      { id: note.id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Note deleted" });
        },
        onError: () => toast({ title: "Could not delete note", variant: "destructive" }),
      }
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-3">
          <MentionInput
            placeholder="Write a note... use @ to mention a teammate"
            value={body}
            onChange={setBody}
            users={mentionUsers}
            rows={3}
          />
          <div className="flex justify-end">
            <Button onClick={handleAdd} disabled={!body.trim() || createNote.isPending}>
              <Plus className="h-4 w-4 mr-1" /> Add Note
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading notes...</p>
      ) : notes.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground text-sm">
            No notes yet.
          </CardContent>
        </Card>
      ) : (
        notes.map((note) => (
          <NoteCard
            key={note.id}
            note={note}
            mentionUsers={mentionUsers}
            onTogglePin={() => handleTogglePin(note)}
            onEdit={() => {
              setEditing(note);
              setEditBody(note.body);
            }}
            onDelete={() => handleDelete(note)}
            onShowHistory={() => setHistoryFor(note)}
          />
        ))
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Note</DialogTitle>
          </DialogHeader>
          <MentionInput value={editBody} onChange={setEditBody} users={mentionUsers} rows={4} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={!editBody.trim()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <NoteHistoryDialog note={historyFor} onClose={() => setHistoryFor(null)} />
    </div>
  );
}

function NoteCard({
  note,
  mentionUsers,
  onTogglePin,
  onEdit,
  onDelete,
  onShowHistory,
}: {
  note: LeadNote;
  mentionUsers: MentionUser[];
  onTogglePin: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onShowHistory: () => void;
}) {
  const [showComments, setShowComments] = useState(false);
  const { data: commentsData } = useListLeadNoteComments(note.id, {
    query: { enabled: showComments, queryKey: getListLeadNoteCommentsQueryKey(note.id) },
  });
  const commentCount = commentsData?.comments?.length ?? 0;
  const edited = !!note.updatedAt && note.updatedAt !== note.createdAt;

  return (
    <Card className={note.isPinned ? "border-primary/40" : ""}>
      <CardContent className="p-4">
        <div className="flex justify-between items-start gap-2">
          <MentionText body={note.body} className="text-sm flex-1" />
          <div className="flex items-center gap-1 flex-shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onTogglePin}
              title={note.isPinned ? "Unpin" : "Pin"}
            >
              {note.isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            </Button>
            {edited && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onShowHistory}
                title="Edit history"
              >
                <HistoryIcon className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit} title="Edit">
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive"
              onClick={onDelete}
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between mt-2">
          <p className="text-xs text-muted-foreground">
            {note.userName ? `${note.userName} • ` : ""}
            {fmtDateTime(note.createdAt)}
            {note.isPinned ? " • Pinned" : ""}
            {edited ? " • Edited" : ""}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setShowComments((v) => !v)}
          >
            <MessageSquare className="h-3.5 w-3.5 mr-1" />
            {commentCount > 0 ? `${commentCount} ` : ""}
            {commentCount === 1 ? "Comment" : "Comments"}
          </Button>
        </div>
        {showComments && <NoteComments note={note} mentionUsers={mentionUsers} />}
      </CardContent>
    </Card>
  );
}

function NoteComments({ note, mentionUsers }: { note: LeadNote; mentionUsers: MentionUser[] }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const { data, isLoading } = useListLeadNoteComments(note.id, {
    query: { queryKey: getListLeadNoteCommentsQueryKey(note.id) },
  });
  const createComment = useCreateLeadNoteComment();
  const updateComment = useUpdateLeadNoteComment();
  const deleteComment = useDeleteLeadNoteComment();

  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editBody, setEditBody] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListLeadNoteCommentsQueryKey(note.id) });

  const comments = [...(data?.comments ?? [])].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  const handleAdd = () => {
    if (!body.trim()) return;
    createComment.mutate(
      { id: note.id, data: { body: body.trim() } },
      {
        onSuccess: () => {
          setBody("");
          invalidate();
        },
        onError: () => toast({ title: "Could not add comment", variant: "destructive" }),
      },
    );
  };

  const handleSaveEdit = (c: LeadNoteComment) => {
    if (!editBody.trim()) return;
    updateComment.mutate(
      { id: c.id, data: { body: editBody.trim() } },
      {
        onSuccess: () => {
          setEditingId(null);
          invalidate();
        },
        onError: () => toast({ title: "Could not update comment", variant: "destructive" }),
      },
    );
  };

  const handleDelete = (c: LeadNoteComment) => {
    deleteComment.mutate(
      { id: c.id },
      {
        onSuccess: invalidate,
        onError: () => toast({ title: "Could not delete comment", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="mt-3 border-t pt-3 space-y-3">
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading comments...</p>
      ) : comments.length === 0 ? (
        <p className="text-xs text-muted-foreground">No comments yet.</p>
      ) : (
        comments.map((c) => (
          <div key={c.id} className="flex gap-2">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
              {(c.userName ?? "?").charAt(0)}
            </span>
            <div className="flex-1 min-w-0">
              {editingId === c.id ? (
                <div className="space-y-2">
                  <MentionInput
                    value={editBody}
                    onChange={setEditBody}
                    users={mentionUsers}
                    rows={2}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" className="h-7 text-xs" onClick={() => handleSaveEdit(c)}>
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <MentionText body={c.body} className="text-sm" />
                    {user?.id === c.userId && (
                      <div className="flex flex-shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => {
                            setEditingId(c.id);
                            setEditBody(c.body);
                          }}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-destructive"
                          onClick={() => handleDelete(c)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {c.userName ? `${c.userName} • ` : ""}
                    {fmtDateTime(c.createdAt)}
                  </p>
                </>
              )}
            </div>
          </div>
        ))
      )}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <MentionInput
            value={body}
            onChange={setBody}
            users={mentionUsers}
            rows={2}
            placeholder="Reply... use @ to mention"
          />
        </div>
        <Button
          size="sm"
          onClick={handleAdd}
          disabled={!body.trim() || createComment.isPending}
        >
          Reply
        </Button>
      </div>
    </div>
  );
}

function NoteHistoryDialog({ note, onClose }: { note: LeadNote | null; onClose: () => void }) {
  const { data, isLoading } = useListLeadNoteHistory(note?.id ?? 0, {
    query: {
      enabled: !!note,
      queryKey: getListLeadNoteHistoryQueryKey(note?.id ?? 0),
    },
  });
  const history = [...(data?.history ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <Dialog open={!!note} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit History</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading history...</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No previous versions.</p>
          ) : (
            history.map((h) => (
              <div key={h.id} className="rounded-md border p-3">
                <MentionText body={h.body} className="text-sm" />
                <p className="text-xs text-muted-foreground mt-2">
                  {h.editedByName ? `${h.editedByName} • ` : ""}
                  {fmtDateTime(h.createdAt)}
                </p>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const ACTIVITY_TYPES = Object.values(LeadActivityInputType);

function ActivitiesTab({ leadId }: { leadId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListLeadActivities(leadId, {
    query: { enabled: !!leadId, queryKey: getListLeadActivitiesQueryKey(leadId) },
  });
  const createActivity = useCreateLeadActivity();
  const updateActivity = useUpdateLeadActivity();
  const deleteActivity = useDeleteLeadActivity();

  const emptyForm = {
    type: "call" as (typeof ACTIVITY_TYPES)[number],
    subject: "",
    body: "",
    outcome: "",
    occurredAt: "",
  };
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<LeadActivity | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListLeadActivitiesQueryKey(leadId) });

  const activities = [...(data?.activities ?? [])].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
  );

  const buildPayload = (f: typeof emptyForm) => ({
    type: f.type,
    subject: f.subject.trim() || null,
    body: f.body.trim() || null,
    outcome: f.outcome.trim() || null,
    occurredAt: f.occurredAt ? new Date(f.occurredAt).toISOString() : null,
  });

  const handleCreate = () => {
    createActivity.mutate(
      { id: leadId, data: buildPayload(form) },
      {
        onSuccess: () => {
          setForm(emptyForm);
          invalidate();
          toast({ title: "Activity logged" });
        },
        onError: () => toast({ title: "Could not log activity", variant: "destructive" }),
      }
    );
  };

  const handleSaveEdit = () => {
    if (!editing) return;
    updateActivity.mutate(
      { id: editing.id, data: buildPayload(form) },
      {
        onSuccess: () => {
          setEditing(null);
          setForm(emptyForm);
          invalidate();
          toast({ title: "Activity updated" });
        },
        onError: () => toast({ title: "Could not update activity", variant: "destructive" }),
      }
    );
  };

  const handleDelete = (activity: LeadActivity) => {
    deleteActivity.mutate(
      { id: activity.id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Activity deleted" });
        },
        onError: () => toast({ title: "Could not delete activity", variant: "destructive" }),
      }
    );
  };

  const openEdit = (activity: LeadActivity) => {
    setEditing(activity);
    setForm({
      type: (ACTIVITY_TYPES.includes(activity.type as any)
        ? (activity.type as (typeof ACTIVITY_TYPES)[number])
        : "other"),
      subject: activity.subject ?? "",
      body: activity.body ?? "",
      outcome: activity.outcome ?? "",
      occurredAt: activity.occurredAt
        ? format(parseISO(activity.occurredAt), "yyyy-MM-dd'T'HH:mm")
        : "",
    });
  };

  const FormFields = (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">Type</Label>
          <Select
            value={form.type}
            onValueChange={(v) => setForm({ ...form, type: v as (typeof ACTIVITY_TYPES)[number] })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTIVITY_TYPES.map((t) => (
                <SelectItem key={t} value={t} className="capitalize">
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Date &amp; Time</Label>
          <Input
            type="datetime-local"
            value={form.occurredAt}
            onChange={(e) => setForm({ ...form, occurredAt: e.target.value })}
          />
        </div>
      </div>
      <div>
        <Label className="text-xs">Subject</Label>
        <Input
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
          placeholder="Subject"
        />
      </div>
      <div>
        <Label className="text-xs">Details</Label>
        <Textarea
          value={form.body}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          rows={2}
          placeholder="Details"
        />
      </div>
      <div>
        <Label className="text-xs">Outcome</Label>
        <Input
          value={form.outcome}
          onChange={(e) => setForm({ ...form, outcome: e.target.value })}
          placeholder="Outcome"
        />
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Log Activity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {FormFields}
          <div className="flex justify-end">
            <Button onClick={handleCreate} disabled={createActivity.isPending}>
              <Plus className="h-4 w-4 mr-1" /> Log Activity
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading activities...</p>
      ) : activities.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground text-sm">
            No activities logged yet.
          </CardContent>
        </Card>
      ) : (
        activities.map((activity) => (
          <Card key={activity.id}>
            <CardContent className="p-4">
              <div className="flex justify-between items-start gap-2">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="capitalize text-xs">
                      {activity.type}
                    </Badge>
                    {activity.subject && (
                      <span className="text-sm font-medium">{activity.subject}</span>
                    )}
                  </div>
                  {activity.body && (
                    <p className="text-sm mt-2 whitespace-pre-wrap">{activity.body}</p>
                  )}
                  {activity.outcome && (
                    <p className="text-xs mt-2">
                      <span className="text-muted-foreground">Outcome: </span>
                      {activity.outcome}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground mt-2">
                    {activity.userName ? `${activity.userName} • ` : ""}
                    {fmtDateTime(activity.occurredAt)}
                  </p>
                </div>
                {activity.source !== "system" && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => openEdit(activity)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => handleDelete(activity)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))
      )}

      <Dialog
        open={!!editing}
        onOpenChange={(o) => {
          if (!o) {
            setEditing(null);
            setForm(emptyForm);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Activity</DialogTitle>
          </DialogHeader>
          {FormFields}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditing(null);
                setForm(emptyForm);
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleSaveEdit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TagsCard({ leadId }: { leadId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: leadTags } = useListLeadTags(leadId, {
    query: { enabled: !!leadId, queryKey: getListLeadTagsQueryKey(leadId) },
  });
  const { data: allTags } = useListTags();
  const attachTag = useAttachLeadTag();
  const detachTag = useDetachLeadTag();
  const [selectedTag, setSelectedTag] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListLeadTagsQueryKey(leadId) });

  const attached = leadTags?.tags ?? [];
  const attachedIds = new Set(attached.map((t) => t.id));
  const available = (allTags?.tags ?? []).filter((t) => !attachedIds.has(t.id));

  const handleAttach = () => {
    const tagId = parseInt(selectedTag, 10);
    if (!tagId) return;
    attachTag.mutate(
      { id: leadId, data: { tagId } },
      {
        onSuccess: () => {
          setSelectedTag("");
          invalidate();
        },
        onError: () => toast({ title: "Could not attach tag", variant: "destructive" }),
      }
    );
  };

  const handleDetach = (tagId: number) => {
    detachTag.mutate(
      { id: leadId, tagId },
      {
        onSuccess: invalidate,
        onError: () => toast({ title: "Could not remove tag", variant: "destructive" }),
      }
    );
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3 border-b border-border mb-3">
        <CardTitle className="text-base">Tags</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {attached.length === 0 && (
            <p className="text-sm text-muted-foreground">No tags attached.</p>
          )}
          {attached.map((tag) => (
            <Badge
              key={tag.id}
              variant="secondary"
              className="font-normal text-xs flex items-center gap-1"
              style={
                tag.color
                  ? { backgroundColor: `${tag.color}20`, color: tag.color }
                  : undefined
              }
            >
              {tag.name}
              <button onClick={() => handleDetach(tag.id)} className="hover:opacity-70">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
        {available.length > 0 && (
          <div className="flex items-center gap-2">
            <Select value={selectedTag} onValueChange={setSelectedTag}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Add tag..." />
              </SelectTrigger>
              <SelectContent>
                {available.map((tag) => (
                  <SelectItem key={tag.id} value={tag.id.toString()}>
                    {tag.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={handleAttach} disabled={!selectedTag}>
              Add
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AssignmentCard({
  lead,
  leadId,
}: {
  lead: { assignedToId?: number | null; assignedToName?: string | null; teamId?: number | null; teamName?: string | null };
  leadId: number;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: usersData } = useListUsers({ limit: 200 });
  const { data: teamsData } = useListTeams();
  const assignLead = useAssignLead();
  const recommend = useRecommendLeadAssignee();
  const [owner, setOwner] = useState<string>(lead.assignedToId ? lead.assignedToId.toString() : "");
  const [strategy, setStrategy] = useState<AssignLeadInputStrategy>(AssignLeadInputStrategy.manual);
  const [teamId, setTeamId] = useState<string>(lead.teamId ? lead.teamId.toString() : "");
  const [rec, setRec] = useState<AssigneeRecommendation | null>(null);

  const users = usersData?.users ?? [];
  const teams = teamsData?.teams ?? [];
  const teamRequired = strategy === "load_balanced" || strategy === "availability";

  const STRATEGY_LABELS: Record<AssignLeadInputStrategy, string> = {
    manual: "Manual (pick owner)",
    round_robin: "Round-robin",
    load_balanced: "Load-balanced",
    availability: "Availability",
    territory: "Territory",
    ai: "AI recommendation",
  };

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });

  const handleAssign = (val: string) => {
    setOwner(val);
    const assignedToId = val ? parseInt(val, 10) : null;
    assignLead.mutate(
      { id: leadId, data: { assignedToId, teamId: lead.teamId ?? null, strategy: "manual" } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Lead reassigned" });
        },
        onError: () => toast({ title: "Could not reassign", variant: "destructive" }),
      }
    );
  };

  const handleStrategyAssign = () => {
    const parsedTeam = teamId ? parseInt(teamId, 10) : (lead.teamId ?? null);
    assignLead.mutate(
      { id: leadId, data: { strategy, teamId: parsedTeam } },
      {
        onSuccess: () => {
          invalidate();
          setRec(null);
          toast({ title: `Assigned via ${STRATEGY_LABELS[strategy].toLowerCase()}` });
        },
        onError: (e: any) =>
          toast({
            title: "Could not assign",
            description: e?.message || "Check the strategy requirements (a team may be required).",
            variant: "destructive",
          }),
      }
    );
  };

  const handleRecommend = () => {
    const parsedTeam = teamId ? parseInt(teamId, 10) : (lead.teamId ?? null);
    recommend.mutate(
      { id: leadId, data: { teamId: parsedTeam } },
      {
        onSuccess: (data) => setRec(data),
        onError: (e: any) =>
          toast({
            title: "No recommendation",
            description: e?.message || "Could not compute a recommendation.",
            variant: "destructive",
          }),
      }
    );
  };

  const applyRecommendation = () => {
    if (!rec) return;
    setOwner(rec.assignedToId.toString());
    assignLead.mutate(
      { id: leadId, data: { assignedToId: rec.assignedToId, teamId: teamId ? parseInt(teamId, 10) : (lead.teamId ?? null), strategy: "manual" } },
      {
        onSuccess: () => {
          invalidate();
          setRec(null);
          toast({ title: "Recommendation applied" });
        },
        onError: () => toast({ title: "Could not assign", variant: "destructive" }),
      }
    );
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3 border-b border-border mb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <UserIcon className="h-4 w-4 text-primary" /> Assignment
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground mb-1">Owner</p>
          <Select value={owner} onValueChange={handleAssign}>
            <SelectTrigger>
              <SelectValue placeholder="Unassigned" />
            </SelectTrigger>
            <SelectContent>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id.toString()}>
                  {u.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
          <p className="text-sm font-semibold flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-primary" /> Auto-assign by rule
          </p>
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Strategy</p>
            <Select value={strategy} onValueChange={(v) => { setStrategy(v as AssignLeadInputStrategy); setRec(null); }}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(AssignLeadInputStrategy).map((s) => (
                  <SelectItem key={s} value={s}>
                    {STRATEGY_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {strategy !== "manual" && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">
                Team {teamRequired && <span className="text-destructive">*</span>}
              </p>
              <Select value={teamId} onValueChange={setTeamId}>
                <SelectTrigger>
                  <SelectValue placeholder={lead.teamName || "Lead's current team"} />
                </SelectTrigger>
                <SelectContent>
                  {teams.map((t) => (
                    <SelectItem key={t.id} value={t.id.toString()}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex gap-2">
            {strategy === "ai" ? (
              <Button variant="outline" className="flex-1" onClick={handleRecommend} disabled={recommend.isPending}>
                {recommend.isPending ? "Analyzing..." : "Preview recommendation"}
              </Button>
            ) : (
              <Button className="flex-1" onClick={handleStrategyAssign} disabled={assignLead.isPending || (teamRequired && !teamId && !lead.teamId)}>
                {assignLead.isPending ? "Assigning..." : "Apply strategy"}
              </Button>
            )}
          </div>
          {strategy === "ai" && rec && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
              <p className="text-sm font-semibold">Recommended: {rec.assignedToName || `User #${rec.assignedToId}`}</p>
              <p className="text-xs text-muted-foreground">{rec.reasoning}</p>
              {rec.candidates.length > 0 && (
                <div className="text-xs text-muted-foreground space-y-0.5">
                  {rec.candidates.map((c) => (
                    <div key={c.id} className="flex justify-between">
                      <span>{c.name}</span>
                      <span>{c.openLeads} open</span>
                    </div>
                  ))}
                </div>
              )}
              <Button size="sm" className="w-full" onClick={applyRecommendation} disabled={assignLead.isPending}>
                Assign to {rec.assignedToName || "recommended owner"}
              </Button>
            </div>
          )}
        </div>

        <div>
          <p className="text-sm font-medium text-muted-foreground mb-1">Team</p>
          <p className="text-sm font-medium">{lead.teamName || "No team"}</p>
        </div>
      </CardContent>
    </Card>
  );
}
