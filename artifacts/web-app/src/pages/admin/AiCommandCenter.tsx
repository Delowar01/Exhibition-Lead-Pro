import React, { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  useListAiAssistantConversations,
  getListAiAssistantConversationsQueryKey,
  useCreateAiAssistantConversation,
  useGetAiAssistantConversation,
  getGetAiAssistantConversationQueryKey,
  useDeleteAiAssistantConversation,
  useSendAiAssistantMessage,
  useGetAiAssistantSuggestions,
  getGetAiAssistantSuggestionsQueryKey,
  type AssistantMessage,
  type AssistantConversation,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bot, Plus, Trash2, Send, ShieldCheck, Cpu, User, Sparkles, ChevronRight, Loader2 } from "lucide-react";
import { AiWorkspaceLayout } from "@/components/layouts/AiWorkspaceLayout";
import { EmptyState } from "@/components/ds";
import { useToast } from "@/hooks/use-toast";

function formatTs(ts?: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

const EVIDENCE_PATH: Record<string, string> = {
  lead: "/admin/leads",
  contact: "/admin/contacts",
  organization: "/admin/companies",
  event: "/admin/events",
  business_card: "/admin/scan",
};

interface EvidenceRef {
  type?: string;
  id?: number;
  label?: string;
}

interface SuggestedAction {
  label?: string;
  type?: string; // navigate | prompt
  target?: string;
}

function ProvenanceBadges({ m }: { m: AssistantMessage }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2">
      {m.source && (
        <Badge variant="outline" className="text-[10px] gap-1">
          {m.source === "ai" ? <Cpu className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
          {m.source === "ai" ? `AI${m.model ? ` · ${m.model}` : ""}` : "Deterministic (real CRM data)"}
        </Badge>
      )}
      {typeof m.confidence === "number" && (
        <Badge variant="outline" className="text-[10px]">Confidence {m.confidence}</Badge>
      )}
      {m.intent && <Badge variant="secondary" className="text-[10px]">{m.intent.replace(/_/g, " ")}</Badge>}
      <span className="text-[10px] text-muted-foreground">{formatTs(m.createdAt)}</span>
    </div>
  );
}

function MessageBubble({ m, onPrompt, onNavigate }: { m: AssistantMessage; onPrompt: (p: string) => void; onNavigate: (path: string) => void }) {
  const isUser = m.role === "user";
  const evidence = (Array.isArray(m.evidence) ? m.evidence : []) as EvidenceRef[];
  const actions = (Array.isArray(m.suggestedActions) ? m.suggestedActions : []) as SuggestedAction[];
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`} data-testid={`message-${m.role}-${m.id}`}>
      <div className={`max-w-[85%] rounded-lg px-4 py-3 ${isUser ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
        <div className="flex items-center gap-2 mb-1">
          {isUser ? <User className="h-3.5 w-3.5 opacity-70" /> : <Bot className="h-3.5 w-3.5 opacity-70" />}
          <span className="text-[10px] uppercase tracking-wider opacity-70">{isUser ? "You" : "AI Assistant"}</span>
        </div>
        <div className="text-sm whitespace-pre-wrap break-words">{m.content}</div>
        {!isUser && evidence.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {evidence.slice(0, 8).map((e, i) => (
              <button
                key={i}
                onClick={() => e.type && EVIDENCE_PATH[e.type] && onNavigate(EVIDENCE_PATH[e.type])}
                className="text-[11px] px-2 py-0.5 rounded-full border bg-background hover:bg-accent transition-colors"
                data-testid={`evidence-${e.type}-${e.id}`}
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
                onClick={() => (a.type === "navigate" && a.target ? onNavigate(a.target) : a.target ? onPrompt(a.target) : undefined)}
                data-testid={`action-${i}`}
              >
                {a.label ?? a.target}
                <ChevronRight className="h-3 w-3 ml-1" />
              </Button>
            ))}
          </div>
        )}
        {!isUser && <ProvenanceBadges m={m} />}
      </div>
    </div>
  );
}

export default function AiCommandCenter() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [pendingUserText, setPendingUserText] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isFullAccess = user?.role === "primary_admin";
  const assistantPerms = ((user?.permissions as Record<string, string[]> | undefined)?.ai_assistant ?? []) as string[];
  const canUse = isFullAccess || assistantPerms.includes("use");

  const { data: convData, isLoading: convsLoading } = useListAiAssistantConversations(undefined, {
    query: { queryKey: getListAiAssistantConversationsQueryKey(undefined) },
  });
  const conversations = convData?.conversations ?? [];

  const { data: detail, isFetching: detailFetching } = useGetAiAssistantConversation(selectedId ?? 0, {
    query: { queryKey: getGetAiAssistantConversationQueryKey(selectedId ?? 0), enabled: selectedId != null },
  });

  const { data: suggestions } = useGetAiAssistantSuggestions(undefined, {
    query: { queryKey: getGetAiAssistantSuggestionsQueryKey(undefined) },
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
    if (selectedId != null) queryClient.invalidateQueries({ queryKey: getGetAiAssistantConversationQueryKey(selectedId) });
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
          toast({ title: "Message failed", description: err instanceof Error ? err.message : "Please try again", variant: "destructive" });
        },
      },
    );
  };

  const handleSend = (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || sendMutation.isPending) return;
    setInput("");
    if (selectedId != null) {
      sendTo(selectedId, content);
      return;
    }
    createMutation.mutate(
      { data: {} },
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
      },
    );
  };

  return (
    <AiWorkspaceLayout activeTab="command">
      <div className="flex justify-end mb-4">
        {suggestions?.provider && (
          <Badge variant="outline" className="gap-1">
            <Cpu className="h-3 w-3" />
            {String((suggestions.provider as Record<string, unknown>).provider ?? "")} · {String((suggestions.provider as Record<string, unknown>).model ?? "")}
          </Badge>
        )}
      </div>

      <div className="flex gap-4 flex-1 min-h-0 h-[calc(100vh-180px)]">
        {/* Conversation list */}
        <Card className="w-64 shrink-0 flex flex-col">
          <CardContent className="p-3 flex flex-col flex-1 min-h-0">
            <Button
              size="sm"
              className="w-full mb-3"
              onClick={() => setSelectedId(null)}
              disabled={!canUse}
              data-testid="button-new-conversation"
            >
              <Plus className="h-4 w-4 mr-1" /> New conversation
            </Button>
            <ScrollArea className="flex-1 -mx-1 px-1">
              {convsLoading && <div className="text-xs text-muted-foreground p-2">Loading…</div>}
              {!convsLoading && conversations.length === 0 && (
                <EmptyState
                  icon={Bot}
                  title="No conversations yet"
                  description="Start a new conversation to begin."
                  className="px-3 py-8"
                />
              )}
              <div className="space-y-1">
                {conversations.map((c) => (
                  <div
                    key={c.id}
                    className={`group flex items-center gap-1 rounded-md px-2 py-1.5 cursor-pointer text-sm ${selectedId === c.id ? "bg-accent" : "hover:bg-accent/50"}`}
                    onClick={() => setSelectedId(c.id)}
                    data-testid={`conversation-${c.id}`}
                  >
                    <span className="flex-1 truncate">{c.title}</span>
                    <button
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(c.id);
                      }}
                      data-testid={`delete-conversation-${c.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Chat area */}
        <Card className="flex-1 flex flex-col min-w-0">
          <CardContent className="p-4 flex flex-col flex-1 min-h-0">
            <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-4 pr-1">
              {selectedId == null && messages.length === 0 && !pendingUserText && (
                <div className="h-full flex flex-col items-center justify-center text-center px-6">
                  <Sparkles className="h-8 w-8 text-muted-foreground mb-3" />
                  <div className="font-medium mb-1">What would you like to know?</div>
                  <div className="text-sm text-muted-foreground mb-4">
                    Grounded in your real CRM data, with full provenance on every answer.
                  </div>
                  <div className="flex flex-wrap justify-center gap-2 max-w-xl">
                    {(suggestions?.prompts ?? []).map((p, i) => (
                      <Button
                        key={i}
                        variant="outline"
                        size="sm"
                        onClick={() => handleSend(p.prompt)}
                        disabled={!canUse}
                        data-testid={`prompt-${i}`}
                      >
                        {p.label}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((m) => (
                <MessageBubble key={m.id} m={m} onPrompt={(p) => handleSend(p)} onNavigate={(path) => navigate(path)} />
              ))}
              {pendingUserText && (
                <>
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-lg px-4 py-3 bg-primary text-primary-foreground">
                      <div className="text-sm whitespace-pre-wrap">{pendingUserText}</div>
                    </div>
                  </div>
                  <div className="flex justify-start">
                    <div className="rounded-lg px-4 py-3 bg-muted flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
                    </div>
                  </div>
                </>
              )}
              {detailFetching && !pendingUserText && messages.length === 0 && selectedId != null && (
                <div className="text-sm text-muted-foreground">Loading conversation…</div>
              )}
            </div>

            <div className="mt-3 flex gap-2 items-end">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={canUse ? "Ask about priorities, risks, forecasts, drafts, or search your CRM…" : "You have read-only access to the AI assistant"}
                className="min-h-[44px] max-h-32 resize-none"
                disabled={!canUse || sendMutation.isPending || createMutation.isPending}
                data-testid="input-message"
              />
              <Button
                onClick={() => handleSend()}
                disabled={!canUse || !input.trim() || sendMutation.isPending || createMutation.isPending}
                data-testid="button-send"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
            <div className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
              <ShieldCheck className="h-3 w-3" />
              Advisory only — answers are grounded in your CRM; the assistant never executes actions, writes data, or sends messages.
            </div>
          </CardContent>
        </Card>
      </div>
    </AiWorkspaceLayout>
  );
}
