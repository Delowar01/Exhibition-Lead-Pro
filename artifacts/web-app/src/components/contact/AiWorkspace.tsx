import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  useListAiAssistantConversations,
  getListAiAssistantConversationsQueryKey,
  useCreateAiAssistantConversation,
  useGetAiAssistantConversation,
  getGetAiAssistantConversationQueryKey,
  useDeleteAiAssistantConversation,
  useSendAiAssistantMessage,
  type AssistantMessage,
  type AssistantConversation,
  type Contact,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertCircle,
  Bot,
  CalendarClock,
  ChevronRight,
  Cpu,
  FileText,
  Loader2,
  Mail,
  MessageCircle,
  Phone,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  User,
  Users,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { differenceInCalendarDays, format } from "date-fns";
import { cn } from "@/lib/utils";
import { SalesCopilotPanel } from "@/components/SalesCopilotPanel";
import { WorkflowIntelligencePanel } from "@/components/WorkflowIntelligencePanel";
import { AiInsightsPanel } from "@/components/AiInsightsPanel";
import { EmptyState } from "./shared";

// ── Suggested actions (spec §172) — one-click prompt cards ──────────────────

const SUGGESTED_ACTIONS: { label: string; prompt: string; icon: React.ReactNode }[] = [
  {
    label: "Summarize Contact",
    prompt: "Summarize this contact: who they are, our relationship so far, and current status.",
    icon: <User className="h-4 w-4" aria-hidden />,
  },
  {
    label: "Prepare Meeting",
    prompt: "Prepare a meeting brief for this contact based on our CRM history.",
    icon: <CalendarClock className="h-4 w-4" aria-hidden />,
  },
  {
    label: "Draft Follow-up Email",
    prompt: "Draft a follow-up email to this contact based on our recent interactions.",
    icon: <Mail className="h-4 w-4" aria-hidden />,
  },
  {
    label: "Generate WhatsApp Message",
    prompt: "Draft a short, friendly WhatsApp message to this contact to keep the relationship warm.",
    icon: <MessageCircle className="h-4 w-4" aria-hidden />,
  },
  {
    label: "Analyze Relationship",
    prompt: "Analyze the health of our relationship with this contact and explain your reasoning.",
    icon: <Users className="h-4 w-4" aria-hidden />,
  },
  {
    label: "Identify Risks",
    prompt: "Identify risks in our relationship with this contact and how to mitigate them.",
    icon: <AlertCircle className="h-4 w-4" aria-hidden />,
  },
  {
    label: "Recommend Next Action",
    prompt: "What should I do next with this contact? Recommend the next best action.",
    icon: <ChevronRight className="h-4 w-4" aria-hidden />,
  },
  {
    label: "Prepare Call Notes",
    prompt: "Prepare call notes for my next phone call with this contact.",
    icon: <Phone className="h-4 w-4" aria-hidden />,
  },
];

// ── Provenance / message bubble (mirrors AI Command Center behavior) ────────

interface EvidenceRef {
  type?: string;
  id?: number;
  label?: string;
}

interface SuggestedAction {
  label?: string;
  type?: string;
  target?: string;
}

const EVIDENCE_PATH: Record<string, string> = {
  lead: "/admin/leads",
  contact: "/admin/contacts",
  organization: "/admin/companies",
  event: "/admin/events",
  business_card: "/admin/scan",
};

function formatTs(ts?: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : format(d, "MMM d, h:mm a");
}

function confidenceLabel(confidence?: number | null): { label: string; cls: string } | null {
  if (typeof confidence !== "number") return null;
  if (confidence >= 80) return { label: "High confidence", cls: "text-success" };
  if (confidence >= 50) return { label: "Medium confidence", cls: "text-warning" };
  return { label: "Low confidence — review recommended", cls: "text-destructive" };
}

function MessageBubble({
  m,
  onPrompt,
  onNavigate,
}: {
  m: AssistantMessage;
  onPrompt: (p: string) => void;
  onNavigate: (path: string) => void;
}) {
  const isUser = m.role === "user";
  const evidence = (Array.isArray(m.evidence) ? m.evidence : []) as EvidenceRef[];
  const actions = (Array.isArray(m.suggestedActions) ? m.suggestedActions : []) as SuggestedAction[];
  const conf = confidenceLabel(m.confidence);
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")} data-testid={`ai-message-${m.role}-${m.id}`}>
      <div
        className={cn(
          "max-w-[88%] rounded-2xl px-4 py-3",
          isUser ? "bg-primary text-primary-foreground" : "bg-secondary/60 border border-border/60",
        )}
      >
        <div className="flex items-center gap-2 mb-1">
          {isUser ? (
            <User className="h-3.5 w-3.5 opacity-70" aria-hidden />
          ) : (
            <Bot className="h-3.5 w-3.5 opacity-70" aria-hidden />
          )}
          <span className="text-[10px] uppercase tracking-wider opacity-70">
            {isUser ? "You" : "AI Assistant"}
          </span>
        </div>
        <div className="text-sm whitespace-pre-wrap break-words">{m.content}</div>
        {!isUser && evidence.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {evidence.slice(0, 8).map((e, i) => (
              <button
                key={i}
                onClick={() => e.type && EVIDENCE_PATH[e.type] && onNavigate(EVIDENCE_PATH[e.type])}
                className="text-[11px] px-2 py-0.5 rounded-full border bg-background hover:bg-accent transition-colors"
              >
                {e.label ?? `${e.type} #${e.id}`}
              </button>
            ))}
          </div>
        )}
        {!isUser && actions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {actions.map((a, i) => (
              <Button
                key={i}
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() =>
                  a.type === "navigate" && a.target
                    ? onNavigate(a.target)
                    : a.target
                      ? onPrompt(a.target)
                      : undefined
                }
              >
                {a.label ?? a.target}
                <ChevronRight className="h-3 w-3 ml-1" aria-hidden />
              </Button>
            ))}
          </div>
        )}
        {!isUser && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {m.source && (
              <Badge variant="outline" className="text-[10px] gap-1">
                {m.source === "ai" ? (
                  <Cpu className="h-3 w-3" aria-hidden />
                ) : (
                  <ShieldCheck className="h-3 w-3" aria-hidden />
                )}
                {m.source === "ai" ? `AI${m.model ? ` · ${m.model}` : ""}` : "Deterministic (real CRM data)"}
              </Badge>
            )}
            {conf && <span className={cn("text-[10px] font-medium", conf.cls)}>{conf.label}</span>}
            <span className="text-[10px] text-muted-foreground">{formatTs(m.createdAt)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Smart recommendations (spec §180 — deterministic, no AI call) ───────────

function smartRecommendations(contact: Contact): { text: string; prompt: string }[] {
  const recs: { text: string; prompt: string }[] = [];
  const today = new Date();
  if (contact.followUpDate) {
    const due = new Date(`${contact.followUpDate}T00:00:00`);
    const overdueDays = differenceInCalendarDays(today, due);
    if (overdueDays > 0) {
      recs.push({
        text: `Follow-up overdue by ${overdueDays} day${overdueDays === 1 ? "" : "s"}.`,
        prompt: "My follow-up with this contact is overdue. Draft a re-engagement message.",
      });
    } else if (overdueDays === 0) {
      recs.push({
        text: "Follow-up is due today.",
        prompt: "My follow-up with this contact is due today. Help me prepare.",
      });
    }
  }
  if (contact.leadTemperature === "hot" && contact.status !== "won") {
    recs.push({
      text: "Hot lead — act while interest is high.",
      prompt: "This is a hot lead. Recommend the fastest path to move the deal forward.",
    });
  }
  if (!contact.enrichedAt) {
    recs.push({
      text: "Contact has not been enriched yet.",
      prompt: "What do we know about this contact so far, and what information is missing?",
    });
  }
  return recs.slice(0, 3);
}

// ── AI Workspace ─────────────────────────────────────────────────────────────

export interface AiWorkspaceProps {
  contact: Contact;
}

export default function AiWorkspace({ contact }: AiWorkspaceProps) {
  const contactId = contact.id;
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isFullAccess = user?.role === "primary_admin" || user?.role === "platform_owner";
  const assistantPerms = ((user?.permissions as Record<string, string[]> | undefined)?.ai_assistant ?? []) as string[];
  const canUse = isFullAccess || assistantPerms.includes("use");

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [pendingUserText, setPendingUserText] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: convData, isLoading: convsLoading } = useListAiAssistantConversations(undefined, {
    query: { queryKey: getListAiAssistantConversationsQueryKey(undefined), enabled: canUse },
  });

  // Sessions remain linked to this contact (spec §178).
  const conversations = useMemo(
    () =>
      (convData?.conversations ?? []).filter(
        (c) => c.contextType === "contact" && c.contextId === contactId,
      ),
    [convData, contactId],
  );

  const { data: detail } = useGetAiAssistantConversation(selectedId ?? 0, {
    query: {
      queryKey: getGetAiAssistantConversationQueryKey(selectedId ?? 0),
      enabled: canUse && selectedId != null,
    },
  });

  const createMutation = useCreateAiAssistantConversation();
  const deleteMutation = useDeleteAiAssistantConversation();
  const sendMutation = useSendAiAssistantMessage();

  const messages = (detail?.messages ?? []) as AssistantMessage[];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, pendingUserText]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListAiAssistantConversationsQueryKey(undefined) });
    if (selectedId != null)
      queryClient.invalidateQueries({ queryKey: getGetAiAssistantConversationQueryKey(selectedId) });
  };

  const sendTo = (conversationId: number, content: string) => {
    setPendingUserText(content);
    sendMutation.mutate(
      { id: conversationId, data: { content, language: "en" } },
      {
        onSuccess: () => {
          setPendingUserText(null);
          queryClient.invalidateQueries({ queryKey: getGetAiAssistantConversationQueryKey(conversationId) });
          queryClient.invalidateQueries({ queryKey: getListAiAssistantConversationsQueryKey(undefined) });
        },
        onError: (err: unknown) => {
          setPendingUserText(null);
          toast({
            title: "AI could not generate a response.",
            description: err instanceof Error ? err.message : "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const displayName = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "this contact";

  const handleSend = (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || sendMutation.isPending || createMutation.isPending) return;
    setInput("");
    if (selectedId != null) {
      sendTo(selectedId, content);
      return;
    }
    createMutation.mutate(
      { data: { title: `AI · ${displayName}`, contextType: "contact", contextId: contactId } },
      {
        onSuccess: (conv: AssistantConversation) => {
          setSelectedId(conv.id);
          invalidate();
          sendTo(conv.id, content);
        },
        onError: () => toast({ title: "Could not start conversation", variant: "destructive" }),
      },
    );
  };

  const handleDelete = (id: number) => {
    deleteMutation.mutate(
      { id },
      {
        onSuccess: () => {
          if (selectedId === id) setSelectedId(null);
          invalidate();
        },
        onError: () => toast({ title: "Could not delete conversation", variant: "destructive" }),
      },
    );
  };

  const recommendations = useMemo(() => smartRecommendations(contact), [contact]);
  const busy = sendMutation.isPending || createMutation.isPending;

  if (!canUse) {
    return (
      <div className="space-y-5">
        <EmptyState
          icon={<Bot className="h-5 w-5" aria-hidden />}
          headline="AI Assistant is not enabled for your account."
          description="Ask your administrator for the AI Assistant permission to chat about this customer. AI modules below remain available where permitted."
        />
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
          <SalesCopilotPanel entityType="contact" id={contactId} />
          <div className="space-y-5">
            <WorkflowIntelligencePanel entityType="contact" id={contactId} />
            <AiInsightsPanel entityType="contact" id={contactId} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-[7fr_13fr] gap-5 items-start">
        {/* Left panel (35%): suggested actions + smart recommendations + sessions */}
        <div className="space-y-4">
          <section
            className="rounded-2xl border border-border/60 bg-card shadow-sm p-4"
            aria-label="Suggested AI actions"
          >
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden /> Suggested Actions
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 gap-2">
              {SUGGESTED_ACTIONS.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={() => handleSend(a.prompt)}
                  disabled={busy}
                  className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-background px-3 py-2.5 text-start text-sm font-medium hover:border-primary/40 hover:bg-primary/5 transition-colors disabled:opacity-50 min-h-[44px]"
                  data-testid={`ai-action-${a.label.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  <span className="text-primary shrink-0">{a.icon}</span>
                  <span className="min-w-0 truncate">{a.label}</span>
                </button>
              ))}
            </div>
          </section>

          {recommendations.length > 0 && (
            <section
              className="rounded-2xl border border-warning/25 bg-warning-soft/40 shadow-sm p-4"
              aria-label="Smart recommendations"
            >
              <h3 className="text-sm font-semibold flex items-center gap-2 mb-2.5">
                <AlertCircle className="h-4 w-4 text-warning" aria-hidden /> Smart Recommendations
              </h3>
              <ul className="space-y-2">
                {recommendations.map((r, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => handleSend(r.prompt)}
                      disabled={busy}
                      className="w-full text-start text-sm rounded-lg border border-border/60 bg-background px-3 py-2 hover:border-primary/40 hover:bg-primary/5 transition-colors disabled:opacity-50"
                    >
                      {r.text}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section
            className="rounded-2xl border border-border/60 bg-card shadow-sm p-4"
            aria-label="Previous AI sessions"
          >
            <div className="flex items-center justify-between mb-2.5">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Bot className="h-4 w-4 text-primary" aria-hidden /> AI Sessions
              </h3>
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={() => setSelectedId(null)}
                data-testid="button-new-ai-session"
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> New
              </Button>
            </div>
            {convsLoading ? (
              <p className="text-xs text-muted-foreground py-2">Loading sessions…</p>
            ) : conversations.length === 0 ? (
              <p className="text-xs text-muted-foreground italic py-1">
                No AI sessions for this contact yet.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {conversations.map((c) => (
                  <li key={c.id} className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      aria-pressed={selectedId === c.id}
                      className={cn(
                        "flex-1 min-w-0 text-start rounded-lg px-2.5 py-2 text-sm transition-colors",
                        selectedId === c.id
                          ? "bg-primary/10 text-primary font-medium"
                          : "hover:bg-secondary/60",
                      )}
                      data-testid={`ai-session-${c.id}`}
                    >
                      <span className="block truncate">{c.title}</span>
                      <span className="block text-[11px] text-muted-foreground truncate">
                        {formatTs(c.lastMessageAt)}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDelete(c.id)}
                      aria-label={`Delete session ${c.title}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Right panel (65%): conversation */}
        <div className="rounded-2xl border border-border/60 bg-card shadow-sm flex flex-col min-h-[480px]">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
            <p className="text-sm font-semibold flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary" aria-hidden />
              {selectedId != null && detail ? detail.title : "New conversation"}
            </p>
            <Badge variant="outline" className="text-[10px] gap-1">
              <ShieldCheck className="h-3 w-3" aria-hidden /> Grounded in CRM data
            </Badge>
          </div>

          <ScrollArea className="flex-1 max-h-[540px]" aria-label="AI conversation">
            <div ref={scrollRef} className="p-4 space-y-4 overflow-y-auto max-h-[540px]">
              {selectedId == null && messages.length === 0 && !pendingUserText ? (
                <div className="text-center py-10">
                  <span className="inline-flex h-12 w-12 rounded-full bg-primary-soft text-primary items-center justify-center mb-3">
                    <Sparkles className="h-5 w-5" aria-hidden />
                  </span>
                  <p className="text-base font-semibold">Ask AI about this customer.</p>
                  <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
                    Context loads automatically — the assistant already knows {displayName}'s CRM
                    history. Pick a suggested action or type a question below.
                  </p>
                </div>
              ) : (
                <>
                  {messages.map((m) => (
                    <MessageBubble
                      key={m.id}
                      m={m}
                      onPrompt={(p) => handleSend(p)}
                      onNavigate={(path) => navigate(path)}
                    />
                  ))}
                  {pendingUserText && (
                    <>
                      <div className="flex justify-end">
                        <div className="max-w-[88%] rounded-2xl px-4 py-3 bg-primary text-primary-foreground">
                          <div className="text-sm whitespace-pre-wrap break-words">{pendingUserText}</div>
                        </div>
                      </div>
                      <div className="flex justify-start">
                        <div className="rounded-2xl px-4 py-3 bg-secondary/60 border border-border/60 flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Thinking…
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </ScrollArea>

          <div className="border-t border-border/60 p-3">
            <div className="flex items-end gap-2">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={`Ask about ${displayName}…`}
                className="min-h-[44px] max-h-32 resize-none"
                aria-label="Ask the AI assistant"
                data-testid="input-ai-message"
              />
              <Button
                onClick={() => handleSend()}
                disabled={!input.trim() || busy}
                className="h-11 w-11 p-0 shrink-0"
                aria-label="Send message"
                data-testid="button-ai-send"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Send className="h-4 w-4" aria-hidden />
                )}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              The assistant recommends and drafts only — it never modifies CRM records or sends
              messages automatically.
            </p>
          </div>
        </div>
      </div>

      {/* AI modules (Stage 5B/5F/5A) — preserved functionality */}
      <section aria-label="AI modules" className="space-y-4">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <FileText className="h-4 w-4 text-primary" aria-hidden /> AI Modules
        </h3>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
          <SalesCopilotPanel entityType="contact" id={contactId} />
          <div className="space-y-5">
            <WorkflowIntelligencePanel entityType="contact" id={contactId} />
            <AiInsightsPanel entityType="contact" id={contactId} />
          </div>
        </div>
      </section>
    </div>
  );
}
