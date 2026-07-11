import React, { useMemo, useState } from "react";
import { useParams, useLocation } from "wouter";
import {
  useGetContact,
  useDeleteContact,
  useListCrmOrganizations,
  useLogContactCommunication,
  useGetContactTimeline,
  getGetContactTimelineQueryKey,
  getListContactCommunicationsQueryKey,
  getGetContactQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Bot } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

import ContactHero from "@/components/contact/ContactHero";
import WorkspaceTabs, { type WorkspaceId } from "@/components/contact/WorkspaceTabs";
import AiSidebar from "@/components/contact/AiSidebar";
import OverviewWorkspace from "@/components/contact/OverviewWorkspace";
import TimelineWorkspace from "@/components/contact/TimelineWorkspace";
import ActivitiesWorkspace from "@/components/contact/ActivitiesWorkspace";
import DocumentsWorkspace from "@/components/contact/DocumentsWorkspace";
import InteractionsWorkspace from "@/components/contact/InteractionsWorkspace";
import AiWorkspace from "@/components/contact/AiWorkspace";
import {
  EditContactSheet,
  ScheduleFollowUpDialog,
  CreateTaskDialog,
  DeleteContactDialog,
} from "@/components/contact/dialogs";

function normalizePhone(p: string): string {
  return p.replace(/[^\d+]/g, "");
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

  const { data: orgData } = useListCrmOrganizations({ status: "active", limit: 200 });
  const organizations = orgData?.organizations ?? [];

  const timelineQ = useGetContactTimeline(contactId, {
    query: { enabled: !!contactId, queryKey: getGetContactTimelineQueryKey(contactId) },
  });
  const lastInteractionAt = timelineQ.data?.entries?.[0]?.occurredAt ?? null;

  const deleteContact = useDeleteContact();
  const logComm = useLogContactCommunication();

  // ── Workspace tab state (mount-on-first-visit; never unmount → no reloads) ─
  const [active, setActive] = useState<WorkspaceId>("overview");
  const [mounted, setMounted] = useState<Record<WorkspaceId, boolean>>({
    overview: true,
    timeline: false,
    activities: false,
    documents: false,
    interactions: false,
    ai: false,
  });

  const goTo = (ws: WorkspaceId) => {
    setActive(ws);
    setMounted((m) => (m[ws] ? m : { ...m, [ws]: true }));
  };

  // ── Dialog state ───────────────────────────────────────────────────────────
  const [editOpen, setEditOpen] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [aiSheetOpen, setAiSheetOpen] = useState(false);

  // ── Quick actions (hero) — preserved Communication Hub behavior ───────────
  const doLog = (channel: "email" | "phone" | "whatsapp", subject: string) => {
    logComm.mutate(
      { id: contactId, data: { channel, subject } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListContactCommunicationsQueryKey(contactId) });
          queryClient.invalidateQueries({ queryKey: getGetContactTimelineQueryKey(contactId) });
        },
        onError: () => toast({ variant: "destructive", title: "Could not log activity" }),
      },
    );
  };

  const handleEmail = () => {
    if (!contact?.email) {
      toast({ title: "No email on file", variant: "destructive" });
      return;
    }
    window.location.href = `mailto:${contact.email}`;
    doLog("email", `Email to ${contact.email}`);
    toast({ title: "Opening mail app", description: "Logged to the timeline." });
  };

  const handleCall = () => {
    if (!contact?.mobile) {
      toast({ title: "No phone number on file", variant: "destructive" });
      return;
    }
    window.location.href = `tel:${normalizePhone(contact.mobile)}`;
    doLog("phone", `Called ${contact.mobile}`);
    toast({ title: "Starting call", description: "Logged to the timeline." });
  };

  const handleWhatsApp = () => {
    if (!contact?.mobile) {
      toast({ title: "No phone number on file", variant: "destructive" });
      return;
    }
    const num = normalizePhone(contact.mobile).replace(/^\+/, "");
    window.open(`https://wa.me/${num}`, "_blank", "noopener,noreferrer");
    doLog("whatsapp", `WhatsApp to ${contact.mobile}`);
    toast({ title: "Opening WhatsApp", description: "Logged to the timeline." });
  };

  const handleDeleteConfirm = () => {
    deleteContact.mutate(
      { id: contactId },
      {
        onSuccess: () => {
          toast({ title: "Contact deleted" });
          setLocation("/admin/contacts");
        },
        onError: () => toast({ title: "Could not delete contact", variant: "destructive" }),
      },
    );
  };

  const fullName = useMemo(
    () => `${contact?.firstName ?? ""} ${contact?.lastName ?? ""}`.trim() || "Unnamed Contact",
    [contact?.firstName, contact?.lastName],
  );

  if (isLoading)
    return (
      <div className="space-y-5 p-6" aria-busy="true" aria-label="Loading contact workspace">
        <Skeleton className="h-36 w-full rounded-2xl" />
        <Skeleton className="h-11 w-full max-w-xl rounded-xl" />
        <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
          <Skeleton className="h-96 rounded-2xl" />
          <Skeleton className="h-96 rounded-2xl hidden xl:block" />
        </div>
      </div>
    );

  if (!contact)
    return (
      <div className="p-8 flex justify-center text-muted-foreground">Contact not found</div>
    );

  const sidebar = (
    <AiSidebar
      contact={contact}
      organizations={organizations}
      onAskAi={() => {
        setAiSheetOpen(false);
        goTo("ai");
      }}
    />
  );

  return (
    <div className="p-4 md:p-6 space-y-5">
      <ContactHero
        contact={contact}
        lastInteractionAt={lastInteractionAt}
        onBack={() => setLocation("/admin/contacts")}
        onCall={handleCall}
        onEmail={handleEmail}
        onWhatsApp={handleWhatsApp}
        onScheduleFollowUp={() => setFollowUpOpen(true)}
        onEdit={() => setEditOpen(true)}
        onDelete={() => setDeleteOpen(true)}
        onOpenCompany={
          contact.organizationId
            ? () => setLocation(`/admin/companies/${contact.organizationId}`)
            : undefined
        }
      />

      <WorkspaceTabs active={active} onChange={goTo} />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px] items-start">
        {/* Workspace content — panels mount on first visit and stay mounted */}
        <div className="min-w-0">
          <div id="workspace-panel-overview" role="tabpanel" aria-labelledby="workspace-tab-overview" hidden={active !== "overview"}>
            {mounted.overview && (
              <OverviewWorkspace
                contact={contact}
                onCall={handleCall}
                onEmail={handleEmail}
                onWhatsApp={handleWhatsApp}
                onEdit={() => setEditOpen(true)}
                onScheduleFollowUp={() => setFollowUpOpen(true)}
                onCreateTask={() => setTaskOpen(true)}
                onGoToWorkspace={goTo}
              />
            )}
          </div>
          <div id="workspace-panel-timeline" role="tabpanel" aria-labelledby="workspace-tab-timeline" hidden={active !== "timeline"}>
            {mounted.timeline && (
              <TimelineWorkspace
                contact={contact}
                onAddNote={() => setEditOpen(true)}
                onScheduleFollowUp={() => setFollowUpOpen(true)}
              />
            )}
          </div>
          <div id="workspace-panel-activities" role="tabpanel" aria-labelledby="workspace-tab-activities" hidden={active !== "activities"}>
            {mounted.activities && (
              <ActivitiesWorkspace
                contact={contact}
                onCreateTask={() => setTaskOpen(true)}
                onScheduleFollowUp={() => setFollowUpOpen(true)}
              />
            )}
          </div>
          <div id="workspace-panel-documents" role="tabpanel" aria-labelledby="workspace-tab-documents" hidden={active !== "documents"}>
            {mounted.documents && <DocumentsWorkspace contact={contact} />}
          </div>
          <div id="workspace-panel-interactions" role="tabpanel" aria-labelledby="workspace-tab-interactions" hidden={active !== "interactions"}>
            {mounted.interactions && <InteractionsWorkspace contact={contact} />}
          </div>
          <div id="workspace-panel-ai" role="tabpanel" aria-labelledby="workspace-tab-ai" hidden={active !== "ai"}>
            {mounted.ai && <AiWorkspace contact={contact} />}
          </div>
        </div>

        {/* AI Sidebar — persistent on desktop, below content on tablet */}
        <aside className="hidden md:block min-w-0" aria-label="AI sidebar">
          {sidebar}
        </aside>
      </div>

      {/* Mobile: AI sidebar as expandable bottom sheet */}
      <div className="md:hidden fixed bottom-4 end-4 z-40">
        <Sheet open={aiSheetOpen} onOpenChange={setAiSheetOpen}>
          <SheetTrigger asChild>
            <Button
              size="lg"
              className="rounded-full h-12 shadow-lg"
              aria-label="Open AI sidebar"
              data-testid="button-mobile-ai-sidebar"
            >
              <Bot className="h-5 w-5 mr-2" aria-hidden /> AI
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl">
            <SheetHeader className="mb-4">
              <SheetTitle>AI &amp; CRM Record</SheetTitle>
            </SheetHeader>
            {sidebar}
          </SheetContent>
        </Sheet>
      </div>

      {/* Dialogs */}
      <EditContactSheet
        contact={contact}
        organizations={organizations}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <ScheduleFollowUpDialog
        contactId={contactId}
        open={followUpOpen}
        onOpenChange={setFollowUpOpen}
      />
      <CreateTaskDialog contactId={contactId} open={taskOpen} onOpenChange={setTaskOpen} />
      <DeleteContactDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={handleDeleteConfirm}
        pending={deleteContact.isPending}
        contactName={fullName}
      />
    </div>
  );
}
