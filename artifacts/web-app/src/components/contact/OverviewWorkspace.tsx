import React, { useMemo } from "react";
import { useLocation } from "wouter";
import {
  useGetContactTimeline,
  useListFollowUps,
  useListTasks,
  useListDocuments,
  useGetAiInsights,
  useGetContactStatusHistory,
  useListContactInteractions,
  useUpdateFollowUp,
  type Contact,
  type TimelineEntry,
  type FollowUp,
  type Task,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import {
  Activity as ActivityIcon,
  AlertCircle,
  Bot,
  Building2,
  CalendarClock,
  Check,
  FileText,
  Flag,
  HeartPulse,
  History,
  ListTodo,
  Mail,
  MapPin,
  MessageCircle,
  MessagesSquare,
  Milestone,
  Phone,
  Plus,
  ScanLine,
  StickyNote,
  Upload,
  User,
  UserCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  activityGroupFor,
  CardSkeleton,
  EmptyState,
  ErrorState,
  formatDay,
  formatTimestamp,
  initialsOf,
  relativeAge,
  StatTile,
  TASK_STATUS_META,
  WorkspaceCard,
} from "./shared";
import { format } from "date-fns";

const DOC_READINESS_CATEGORIES = [
  { key: "business_card", label: "Business Card" },
  { key: "proposal", label: "Proposal" },
  { key: "quotation", label: "Quotation" },
  { key: "contract", label: "Contract" },
  { key: "meeting_notes", label: "Meeting Notes" },
];

const TIMELINE_KIND_ICON: Record<string, React.ReactNode> = {
  activity: <ActivityIcon className="h-3.5 w-3.5" aria-hidden />,
  note: <StickyNote className="h-3.5 w-3.5" aria-hidden />,
  lead_history: <History className="h-3.5 w-3.5" aria-hidden />,
  contact_status: <Flag className="h-3.5 w-3.5" aria-hidden />,
  follow_up: <CalendarClock className="h-3.5 w-3.5" aria-hidden />,
  meeting: <MessagesSquare className="h-3.5 w-3.5" aria-hidden />,
  task: <ListTodo className="h-3.5 w-3.5" aria-hidden />,
  scan: <ScanLine className="h-3.5 w-3.5" aria-hidden />,
};

export interface OverviewWorkspaceProps {
  contact: Contact;
  onCall: () => void;
  onEmail: () => void;
  onWhatsApp: () => void;
  onEdit: () => void;
  onScheduleFollowUp: () => void;
  onCreateTask: () => void;
  onGoToWorkspace: (id: "timeline" | "documents" | "ai") => void;
}

export default function OverviewWorkspace({
  contact,
  onCall,
  onEmail,
  onWhatsApp,
  onEdit,
  onScheduleFollowUp,
  onCreateTask,
  onGoToWorkspace,
}: OverviewWorkspaceProps) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const contactId = contact.id;

  const timelineQ = useGetContactTimeline(contactId);
  const followUpsQ = useListFollowUps({ contactId });
  const tasksQ = useListTasks({ contactId });
  const documentsQ = useListDocuments({ entityType: "contact", entityId: contactId, limit: 100 });
  const insightsQ = useGetAiInsights("contact", contactId);
  const historyQ = useGetContactStatusHistory(contactId);
  const interactionsQ = useListContactInteractions(contactId);
  const updateFollowUp = useUpdateFollowUp();

  const interactions = interactionsQ.data?.interactions ?? [];
  const eventsMet = useMemo(
    () => new Set(interactions.map((i) => i.eventName).filter(Boolean)).size,
    [interactions],
  );

  const entries: TimelineEntry[] = timelineQ.data?.entries ?? [];
  const followUps: FollowUp[] = followUpsQ.data?.followUps ?? [];
  const tasks: Task[] = tasksQ.data?.tasks ?? [];
  const documents = documentsQ.data?.documents ?? [];
  const insights = (insightsQ.data?.insights ?? []).filter((i) => i.status !== "dismissed");
  const history = historyQ.data?.history ?? [];

  const lastInteractionAt = entries.length > 0 ? entries[0].occurredAt : null;

  const todayStr = format(new Date(), "yyyy-MM-dd");
  const pendingFollowUps = followUps
    .filter((f) => f.status === "pending")
    .sort((a, b) => (a.scheduledDate ?? "").localeCompare(b.scheduledDate ?? ""));
  const primaryFollowUp = pendingFollowUps[0] ?? null;
  const openTasks = tasks.filter((t) => t.status === "pending" || t.status === "in_progress" || t.status === "overdue");
  const overdueTasks = openTasks.filter(
    (t) => t.status === "overdue" || (!!t.dueDate && t.dueDate < todayStr && t.status !== "completed"),
  );
  const followUpOverdue =
    !!primaryFollowUp?.scheduledDate && primaryFollowUp.scheduledDate < todayStr;

  /* Deterministic health signal from real CRM data (no fabricated metrics). */
  const health = useMemo(() => {
    if (timelineQ.isLoading) return null;
    const daysSince = lastInteractionAt
      ? Math.floor((Date.now() - new Date(lastInteractionAt).getTime()) / 86400000)
      : null;
    if (followUpOverdue || overdueTasks.length > 0 || daysSince === null || daysSince > 30) {
      return {
        label: daysSince === null ? "No activity yet" : "Needs attention",
        tone: "critical" as const,
        detail:
          followUpOverdue
            ? "A follow-up is overdue."
            : overdueTasks.length > 0
              ? `${overdueTasks.length} task${overdueTasks.length > 1 ? "s" : ""} overdue.`
              : daysSince === null
                ? "No interactions recorded for this contact."
                : `No interaction in ${daysSince} days.`,
      };
    }
    if (daysSince > 14) {
      return { label: "Warning", tone: "warning" as const, detail: `Last interaction ${daysSince} days ago.` };
    }
    return { label: "Healthy", tone: "healthy" as const, detail: "Recent activity and no overdue work." };
  }, [timelineQ.isLoading, lastInteractionAt, followUpOverdue, overdueTasks.length]);

  const recentActivities = entries.slice(0, 5);
  const groupedActivities = useMemo(() => {
    const groups: { label: string; items: TimelineEntry[] }[] = [];
    for (const e of recentActivities) {
      const label = activityGroupFor(e.occurredAt);
      const g = groups.find((x) => x.label === label);
      if (g) g.items.push(e);
      else groups.push({ label, items: [e] });
    }
    return groups;
  }, [recentActivities]);

  /* Document readiness by category */
  const docReadiness = useMemo(() => {
    const present = new Set(documents.map((d) => d.category));
    const rows = DOC_READINESS_CATEGORIES.map((c) => ({ ...c, ready: present.has(c.key) }));
    const readyCount = rows.filter((r) => r.ready).length;
    return { rows, readyCount };
  }, [documents]);

  /* Relationship journey milestones (max 6) from real data */
  const milestones = useMemo(() => {
    const list: { label: string; date: string; icon: React.ReactNode }[] = [
      {
        label: "First Contact",
        date: contact.createdAt,
        icon: <UserCircle className="h-3.5 w-3.5" aria-hidden />,
      },
    ];
    const firstMeeting = [...entries]
      .filter((e) => e.kind === "meeting" || e.type === "meeting")
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))[0];
    if (firstMeeting) {
      list.push({
        label: "First Meeting",
        date: firstMeeting.occurredAt,
        icon: <MessagesSquare className="h-3.5 w-3.5" aria-hidden />,
      });
    }
    const firstProposalDoc = [...documents]
      .filter((d) => d.category === "proposal")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (firstProposalDoc) {
      list.push({
        label: "First Proposal",
        date: firstProposalDoc.createdAt,
        icon: <FileText className="h-3.5 w-3.5" aria-hidden />,
      });
    }
    for (const h of [...history].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (list.length >= 5) break;
      list.push({
        label: `Stage → ${h.toStatus.replace(/_/g, " ")}`,
        date: h.createdAt,
        icon: <Flag className="h-3.5 w-3.5" aria-hidden />,
      });
    }
    if (entries.length > 0) {
      list.push({
        label: "Latest Activity",
        date: entries[0].occurredAt,
        icon: <ActivityIcon className="h-3.5 w-3.5" aria-hidden />,
      });
    }
    return list
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 6);
  }, [contact.createdAt, entries, documents, history]);

  const completeFollowUp = (fu: FollowUp) => {
    updateFollowUp.mutate(
      { id: fu.id, data: { status: "completed" } },
      {
        onSuccess: () => {
          toast({ title: "Follow-up completed" });
          followUpsQ.refetch();
        },
        onError: () => toast({ title: "Could not complete follow-up", variant: "destructive" }),
      },
    );
  };

  const fullName = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "Unnamed Contact";

  const noActivityAtAll =
    !timelineQ.isLoading &&
    !followUpsQ.isLoading &&
    entries.length === 0 &&
    followUps.length === 0 &&
    tasks.length === 0 &&
    documents.length === 0;

  return (
    <div className="space-y-5">
      {noActivityAtAll && (
        <EmptyState
          icon={<ActivityIcon className="h-5 w-5" aria-hidden />}
          headline="This contact has very little activity."
          description="Start building the relationship — schedule a follow-up, create a task, or upload a document."
          actions={
            <>
              <Button size="sm" onClick={onScheduleFollowUp} data-testid="button-empty-schedule">
                <CalendarClock className="h-4 w-4 mr-2" /> Schedule Follow-up
              </Button>
              <Button size="sm" variant="outline" onClick={onCreateTask}>
                <ListTodo className="h-4 w-4 mr-2" /> Create Task
              </Button>
              <Button size="sm" variant="outline" onClick={() => onGoToWorkspace("documents")}>
                <Upload className="h-4 w-4 mr-2" /> Upload Document
              </Button>
            </>
          }
        />
      )}

      {/* Snapshot stat strip (real CRM data only) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5" data-testid="overview-stat-strip">
        <StatTile
          label="AI Lead Score"
          value={
            contact.leadScore != null ? (
              <span className="text-primary">{contact.leadScore}/100</span>
            ) : (
              "Not scored"
            )
          }
          icon={<Bot className="h-3 w-3" aria-hidden />}
        />
        <StatTile
          label="Interactions"
          value={interactionsQ.isLoading ? "…" : interactionsQ.data?.total ?? 0}
          icon={<MessagesSquare className="h-3 w-3" aria-hidden />}
        />
        <StatTile
          label="Events Met"
          value={interactionsQ.isLoading ? "…" : eventsMet}
          icon={<Milestone className="h-3 w-3" aria-hidden />}
        />
        <StatTile
          label="Last Activity"
          value={lastInteractionAt ? `${relativeAge(lastInteractionAt)} ago` : "None yet"}
          icon={<ActivityIcon className="h-3 w-3" aria-hidden />}
          tone={lastInteractionAt ? "default" : "warning"}
        />
        <StatTile
          label="Next Follow-up"
          value={
            primaryFollowUp?.scheduledDate
              ? formatDay(primaryFollowUp.scheduledDate)
              : "Not scheduled"
          }
          icon={<CalendarClock className="h-3 w-3" aria-hidden />}
          tone={followUpOverdue ? "destructive" : "default"}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        {/* 1 — Contact Summary */}
        <WorkspaceCard
          icon={<UserCircle className="h-4 w-4" aria-hidden />}
          title="Contact Summary"
          subtitle="Who this customer is"
          testId="card-contact-summary"
          className="min-h-[220px]"
          footer={
            <Button size="sm" variant="outline" onClick={onEdit} data-testid="button-overview-edit">
              Edit Contact
            </Button>
          }
        >
          {contact.enrichmentSummary && (
            <div className="mb-4 rounded-xl border border-primary/15 bg-primary/5 px-3.5 py-3" data-testid="text-enrichment-summary">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5 mb-1">
                <Bot className="h-3.5 w-3.5" aria-hidden /> AI Enrichment Summary
              </p>
              <p className="text-sm text-foreground/90 leading-relaxed line-clamp-4">
                {contact.enrichmentSummary}
              </p>
            </div>
          )}
          <div className="flex items-start gap-4">
            <Avatar className="h-14 w-14 border border-border shrink-0">
              {contact.cardImageUrl && <AvatarImage src={contact.cardImageUrl} alt="" className="object-cover" />}
              <AvatarFallback className="bg-primary-soft text-primary font-semibold">
                {initialsOf(contact.firstName, contact.lastName)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-semibold truncate">{fullName}</p>
              {contact.jobTitle && (
                <p className="text-sm text-muted-foreground truncate">{contact.jobTitle}</p>
              )}
              {contact.contactCompany && (
                <p className="text-sm flex items-center gap-1.5 min-w-0">
                  <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
                  {contact.organizationId ? (
                    <button
                      type="button"
                      className="truncate hover:text-primary hover:underline text-start"
                      onClick={() => setLocation(`/admin/companies/${contact.organizationId}`)}
                      data-testid="link-overview-company"
                    >
                      {contact.contactCompany}
                    </button>
                  ) : (
                    <span className="truncate">{contact.contactCompany}</span>
                  )}
                </p>
              )}
            </div>
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            {contact.email && (
              <div className="flex items-center gap-2 min-w-0">
                <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
                <a href={`mailto:${contact.email}`} className="truncate hover:text-primary hover:underline" data-testid="text-overview-email">
                  {contact.email}
                </a>
              </div>
            )}
            {contact.mobile && (
              <div className="flex items-center gap-2 min-w-0">
                <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
                <a href={`tel:${contact.mobile}`} className="truncate hover:text-primary hover:underline">
                  {contact.mobile}
                </a>
              </div>
            )}
            {contact.address && (
              <div className="flex items-center gap-2 min-w-0">
                <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
                <span className="truncate">{contact.address}</span>
              </div>
            )}
            <div className="flex items-center gap-2 min-w-0">
              <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
              <span className="truncate">
                Owner: <span className="font-medium">{contact.assignedToName ?? "Unassigned"}</span>
              </span>
            </div>
          </dl>
          {(contact.tags?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-1 mt-3">
              {contact.tags!.map((t) => (
                <Badge key={t} variant="secondary" className="text-[10px]">
                  {t}
                </Badge>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 mt-4">
            <Button size="sm" variant="outline" onClick={onCall} disabled={!contact.mobile} data-testid="button-overview-call">
              <Phone className="h-3.5 w-3.5 mr-1.5" /> Call
            </Button>
            <Button size="sm" variant="outline" onClick={onEmail} disabled={!contact.email}>
              <Mail className="h-3.5 w-3.5 mr-1.5" /> Email
            </Button>
            <Button size="sm" variant="outline" onClick={onWhatsApp} disabled={!contact.mobile}>
              <MessageCircle className="h-3.5 w-3.5 mr-1.5" /> WhatsApp
            </Button>
          </div>
        </WorkspaceCard>

        {/* 2 — Relationship Health */}
        <WorkspaceCard
          icon={<HeartPulse className="h-4 w-4" aria-hidden />}
          title="Relationship Health"
          subtitle="How healthy this relationship is"
          testId="card-relationship-health"
          footer={
            <Button size="sm" variant="outline" onClick={() => onGoToWorkspace("timeline")} data-testid="button-view-timeline">
              View Timeline
            </Button>
          }
        >
          {timelineQ.isLoading || followUpsQ.isLoading ? (
            <CardSkeleton rows={4} />
          ) : timelineQ.isError ? (
            <ErrorState message="Couldn't load relationship health." onRetry={() => timelineQ.refetch()} />
          ) : (
            <div className="space-y-4">
              {health && (
                <div
                  className={cn(
                    "rounded-xl border p-3 flex items-start gap-3",
                    health.tone === "healthy" && "border-success/25 bg-success-soft",
                    health.tone === "warning" && "border-warning/25 bg-warning-soft",
                    health.tone === "critical" && "border-destructive/25 bg-destructive-soft",
                  )}
                  data-testid="health-indicator"
                >
                  <HeartPulse
                    className={cn(
                      "h-5 w-5 shrink-0 mt-0.5",
                      health.tone === "healthy" && "text-success",
                      health.tone === "warning" && "text-warning",
                      health.tone === "critical" && "text-destructive",
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <p
                      className={cn(
                        "text-sm font-semibold",
                        health.tone === "healthy" && "text-success",
                        health.tone === "warning" && "text-warning",
                        health.tone === "critical" && "text-destructive",
                      )}
                    >
                      {health.label}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">{health.detail}</p>
                  </div>
                </div>
              )}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Relationship Age</dt>
                  <dd className="font-medium">{relativeAge(contact.createdAt)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Last Interaction</dt>
                  <dd className="font-medium">
                    {lastInteractionAt ? `${relativeAge(lastInteractionAt)} ago` : "None yet"}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Follow-up Status</dt>
                  <dd className="font-medium">
                    {primaryFollowUp
                      ? followUpOverdue
                        ? "Overdue"
                        : `Scheduled ${primaryFollowUp.scheduledDate ? formatDay(primaryFollowUp.scheduledDate) : ""}`
                      : "None scheduled"}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Relationship Stage</dt>
                  <dd className="font-medium capitalize">{contact.status.replace(/_/g, " ")}</dd>
                </div>
              </dl>

              {/* Compact AI insight blocks (max 3, spec §78) */}
              {insights.length > 0 && (
                <div className="space-y-2 pt-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Bot className="h-3.5 w-3.5 text-primary" aria-hidden /> AI Insights
                  </p>
                  {insights.slice(0, 3).map((ins) => (
                    <button
                      key={ins.id}
                      type="button"
                      onClick={() => onGoToWorkspace("ai")}
                      className="w-full text-start rounded-lg border border-primary/15 bg-primary/5 px-3 py-2 hover:bg-primary/10 transition-colors"
                      data-testid={`insight-block-${ins.id}`}
                    >
                      <p className="text-xs font-medium capitalize">
                        {ins.insightType.replace(/_/g, " ")}
                      </p>
                      {ins.reasoning && (
                        <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{ins.reasoning}</p>
                      )}
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {ins.source === "deterministic" ? "Computed from CRM data" : "AI-generated"}
                        {ins.confidence != null && ` · ${ins.confidence}% confidence`}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </WorkspaceCard>

        {/* 3 — Follow-ups */}
        <WorkspaceCard
          icon={<CalendarClock className="h-4 w-4" aria-hidden />}
          title="Follow-ups"
          subtitle="What requires action"
          testId="card-followups"
          footer={
            <>
              <Button size="sm" variant="outline" onClick={onCreateTask} data-testid="button-overview-create-task">
                <Plus className="h-3.5 w-3.5 mr-1.5" /> Create Task
              </Button>
              <Button size="sm" onClick={onScheduleFollowUp} data-testid="button-overview-schedule">
                <CalendarClock className="h-3.5 w-3.5 mr-1.5" /> Schedule Follow-up
              </Button>
            </>
          }
        >
          {followUpsQ.isLoading || tasksQ.isLoading ? (
            <CardSkeleton rows={3} />
          ) : followUpsQ.isError ? (
            <ErrorState message="Couldn't load follow-ups." onRetry={() => followUpsQ.refetch()} />
          ) : (
            <div className="space-y-3">
              {primaryFollowUp ? (
                <div
                  className={cn(
                    "rounded-xl border p-3",
                    followUpOverdue ? "border-destructive/25 bg-destructive-soft" : "border-border bg-secondary/20",
                  )}
                  data-testid="primary-followup"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold flex items-center gap-1.5">
                      {followUpOverdue && <AlertCircle className="h-4 w-4 text-destructive" aria-hidden />}
                      {primaryFollowUp.scheduledDate ? formatDay(primaryFollowUp.scheduledDate) : "No date"}
                      {primaryFollowUp.scheduledTime && (
                        <span className="text-muted-foreground font-normal">{primaryFollowUp.scheduledTime}</span>
                      )}
                    </p>
                    <Badge variant="outline" className={followUpOverdue ? "bg-destructive-soft text-destructive border-destructive/25" : "bg-info-soft text-info border-info/25"}>
                      {followUpOverdue ? "Overdue" : "Next follow-up"}
                    </Badge>
                  </div>
                  {primaryFollowUp.notes && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{primaryFollowUp.notes}</p>
                  )}
                  <div className="flex items-center gap-2 mt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => completeFollowUp(primaryFollowUp)}
                      disabled={updateFollowUp.isPending}
                      data-testid="button-complete-followup"
                    >
                      <Check className="h-3.5 w-3.5 mr-1.5" /> Complete
                    </Button>
                    <Button size="sm" variant="ghost" onClick={onScheduleFollowUp}>
                      Reschedule
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">No follow-up scheduled.</p>
              )}

              {openTasks.length > 0 ? (
                <ul className="space-y-1.5">
                  {openTasks.slice(0, 4).map((t) => {
                    const meta = TASK_STATUS_META[t.status] ?? TASK_STATUS_META.pending;
                    const isOverdue =
                      t.status === "overdue" || (!!t.dueDate && t.dueDate < todayStr && t.status !== "completed");
                    return (
                      <li
                        key={t.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2"
                        data-testid={`overview-task-${t.id}`}
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{t.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {t.dueDate ? formatDay(t.dueDate) : "No due date"}
                            {t.dueTime ? ` · ${t.dueTime}` : ""}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={cn("shrink-0", isOverdue ? TASK_STATUS_META.overdue.cls : meta.cls)}
                        >
                          {isOverdue ? "Overdue" : meta.label}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground italic">No open tasks.</p>
              )}
            </div>
          )}
        </WorkspaceCard>

        {/* 3b — Interaction History (every capture is a permanent interaction) */}
        <WorkspaceCard
          icon={<ScanLine className="h-4 w-4" aria-hidden />}
          title="Interaction History"
          subtitle="Where and how you met this contact"
          testId="card-interaction-history"
          footer={
            <Button size="sm" variant="outline" onClick={() => onGoToWorkspace("timeline")} data-testid="button-view-interactions">
              View All Interactions
            </Button>
          }
        >
          {interactionsQ.isLoading ? (
            <CardSkeleton rows={3} />
          ) : interactionsQ.isError ? (
            <ErrorState message="Couldn't load interactions." onRetry={() => interactionsQ.refetch()} />
          ) : interactions.length === 0 ? (
            <EmptyState
              icon={<ScanLine className="h-5 w-5" aria-hidden />}
              headline="No captures recorded"
              description="Card scans and other captures will appear here."
            />
          ) : (
            <ul className="space-y-1.5">
              {interactions.slice(0, 4).map((it) => (
                <li
                  key={it.id}
                  className="flex items-center gap-2.5 rounded-lg border border-border/60 px-3 py-2 min-w-0"
                  data-testid={`overview-interaction-${it.id}`}
                >
                  <span className="h-7 w-7 rounded-full bg-primary-soft text-primary flex items-center justify-center shrink-0">
                    <ScanLine className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium truncate capitalize">
                      {(it.captureSource ?? "capture").replace(/_/g, " ")}
                      {it.userName ? ` · ${it.userName}` : ""}
                    </span>
                    <span className="block text-xs text-muted-foreground truncate">
                      {formatTimestamp(it.occurredAt)}
                    </span>
                  </span>
                  {it.eventName && (
                    <Badge variant="secondary" className="shrink-0 text-[10px] max-w-[140px] truncate">
                      {it.eventName}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </WorkspaceCard>

        {/* 4 — Recent Activity */}
        <WorkspaceCard
          icon={<ActivityIcon className="h-4 w-4" aria-hidden />}
          title="Recent Activity"
          subtitle="Latest relationship changes"
          testId="card-recent-activity"
          footer={
            <Button size="sm" variant="outline" onClick={() => onGoToWorkspace("timeline")}>
              View All Activity
            </Button>
          }
        >
          {timelineQ.isLoading ? (
            <CardSkeleton rows={4} />
          ) : timelineQ.isError ? (
            <ErrorState message="Couldn't load recent activity." onRetry={() => timelineQ.refetch()} />
          ) : recentActivities.length === 0 ? (
            <EmptyState
              icon={<ActivityIcon className="h-5 w-5" aria-hidden />}
              headline="No activity yet"
              description="Interactions, notes, and status changes will appear here."
            />
          ) : (
            <div className="space-y-3">
              {groupedActivities.map((g) => (
                <div key={g.label}>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                    {g.label}
                  </p>
                  <ul className="space-y-1.5">
                    {g.items.map((e) => (
                      <li key={e.id}>
                        <button
                          type="button"
                          className="w-full flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-secondary/50 text-start transition-colors"
                          onClick={() => onGoToWorkspace("timeline")}
                          data-testid={`recent-activity-${e.id}`}
                        >
                          <span className="h-7 w-7 rounded-full bg-primary-soft text-primary flex items-center justify-center shrink-0 mt-0.5">
                            {TIMELINE_KIND_ICON[e.kind] ?? <ActivityIcon className="h-3.5 w-3.5" aria-hidden />}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-medium truncate">
                              {e.title ?? e.kind.replace(/_/g, " ")}
                            </span>
                            <span className="block text-xs text-muted-foreground truncate">
                              {formatTimestamp(e.occurredAt)}
                              {e.actorName ? ` · ${e.actorName}` : ""}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </WorkspaceCard>

        {/* 5 — Documents */}
        <WorkspaceCard
          icon={<FileText className="h-4 w-4" aria-hidden />}
          title="Documents"
          subtitle="Relationship readiness"
          testId="card-documents"
          footer={
            <>
              <Button size="sm" variant="outline" onClick={() => onGoToWorkspace("documents")}>
                View All
              </Button>
              <Button size="sm" onClick={() => onGoToWorkspace("documents")} data-testid="button-overview-upload">
                <Upload className="h-3.5 w-3.5 mr-1.5" /> Upload
              </Button>
            </>
          }
        >
          {documentsQ.isLoading ? (
            <CardSkeleton rows={3} />
          ) : documentsQ.isError ? (
            <ErrorState message="Couldn't load documents." onRetry={() => documentsQ.refetch()} />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {documents.length} document{documents.length === 1 ? "" : "s"} on file
                </p>
                <Badge
                  variant="outline"
                  className={cn(
                    docReadiness.readyCount === DOC_READINESS_CATEGORIES.length
                      ? "bg-success-soft text-success border-success/25"
                      : docReadiness.readyCount > 0
                        ? "bg-warning-soft text-warning border-warning/25"
                        : "bg-secondary text-muted-foreground border-border",
                  )}
                >
                  {docReadiness.readyCount === DOC_READINESS_CATEGORIES.length
                    ? "Ready"
                    : docReadiness.readyCount > 0
                      ? "Partial"
                      : "Missing Documents"}
                </Badge>
              </div>
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {docReadiness.rows.map((r) => (
                  <li
                    key={r.key}
                    className="flex items-center gap-2 text-sm rounded-lg border border-border/60 px-2.5 py-1.5"
                  >
                    {r.ready ? (
                      <Check className="h-3.5 w-3.5 text-success shrink-0" aria-hidden />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
                    )}
                    <span className={cn("truncate", !r.ready && "text-muted-foreground")}>{r.label}</span>
                  </li>
                ))}
              </ul>
              {documents.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                    Recent
                  </p>
                  <ul className="space-y-1">
                    {documents.slice(0, 3).map((d) => (
                      <li key={d.id} className="flex items-center gap-2 text-sm min-w-0">
                        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden />
                        <span className="truncate">{d.name}</span>
                        <span className="text-xs text-muted-foreground shrink-0 ml-auto">
                          {formatDay(d.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </WorkspaceCard>

        {/* 6 — Relationship Journey */}
        <WorkspaceCard
          icon={<Milestone className="h-4 w-4" aria-hidden />}
          title="Relationship Journey"
          subtitle="The relationship story"
          testId="card-journey"
        >
          {timelineQ.isLoading || historyQ.isLoading ? (
            <CardSkeleton rows={4} />
          ) : (
            <div className="space-y-4">
              <ol className="relative border-s border-border ms-2 space-y-4">
                {milestones.map((m, i) => (
                  <li key={`${m.label}-${i}`} className="ms-5">
                    <span className="absolute -start-[13px] h-6 w-6 rounded-full bg-primary-soft text-primary border border-primary/20 flex items-center justify-center">
                      {m.icon}
                    </span>
                    <p className="text-sm font-medium">{m.label}</p>
                    <p className="text-xs text-muted-foreground">{formatDay(m.date)}</p>
                  </li>
                ))}
              </ol>
              <div>
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
                  <span>
                    Current stage: <span className="font-medium capitalize text-foreground">{contact.status.replace(/_/g, " ")}</span>
                  </span>
                  <span>{relativeAge(contact.createdAt)} relationship</span>
                </div>
                <Progress
                  value={
                    ({
                      new: 10,
                      contacted: 25,
                      qualified: 40,
                      interested: 55,
                      quotation_sent: 65,
                      proposal_sent: 75,
                      negotiation: 85,
                      won: 100,
                      lost: 100,
                      archived: 100,
                    } as Record<string, number>)[contact.status] ?? 10
                  }
                  className="h-1.5"
                />
              </div>
            </div>
          )}
        </WorkspaceCard>
      </div>
    </div>
  );
}
