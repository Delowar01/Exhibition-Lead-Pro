import React, { useState } from "react";
import {
  useGetAiCopilotPanel,
  useGenerateAiCopilotOutput,
  useEditAiCopilotOutput,
  useUseAiCopilotOutput,
  useDismissAiCopilotOutput,
  useCreateContactNote,
  useCreateLeadActivity,
  getGetAiCopilotPanelQueryKey,
  getGetAiCopilotOutputsQueryKey,
  getGetAiCopilotOverviewQueryKey,
  getGetContactTimelineQueryKey,
  getListLeadActivitiesQueryKey,
  type AiCopilotOutput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { copyTextToClipboard } from "@/lib/clipboard";
import { describeAiError } from "@/lib/ai-errors";
import { Bot, Sparkles, Check, X, ShieldCheck, Cpu, Copy, Pencil, Info, Mail, MessageCircle, Compass, AlertTriangle, Lightbulb, Languages, RefreshCw, StickyNote, AlertCircle } from "lucide-react";

type EntityType = "lead" | "contact" | "organization";

const OUTPUT_TYPES_BY_ENTITY: Record<EntityType, string[]> = {
  lead: ["email", "whatsapp", "call_prep", "meeting_prep", "proposal", "followup", "coaching", "summary"],
  contact: ["email", "whatsapp", "call_prep", "meeting_prep", "proposal", "followup", "coaching", "summary"],
  organization: ["email", "meeting_prep", "proposal", "summary"],
};

const OUTPUT_LABELS: Record<string, string> = {
  email: "Email draft",
  whatsapp: "WhatsApp message",
  call_prep: "Call prep",
  meeting_prep: "Meeting prep",
  proposal: "Proposal outline",
  followup: "Follow-up plan",
  coaching: "Deal coaching",
  summary: "Summary",
};

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatTs(ts?: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

function confidenceTone(confidence?: number | null): string {
  if (confidence === null || confidence === undefined) return "bg-muted text-muted-foreground";
  if (confidence >= 80) return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";
  if (confidence >= 60) return "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
  return "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300";
}

function ScalarValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === "boolean") {
    return <span>{value ? "Yes" : "No"}</span>;
  }
  return <span>{String(value)}</span>;
}

const MESSAGE_FIELDS = ["draftMessage", "body", "message", "subject", "emailBody", "whatsappMessage"];

function isMessageField(key: string) {
  return MESSAGE_FIELDS.includes(key);
}

// Readable plain-text rendering of a structured draft — used for Copy and
// Save as Note so the saved/copied text matches what the card displays instead
// of raw JSON. Skips internal flags (insufficientData / unavailable).
const HIDDEN_KEYS = new Set(["insufficientData", "unavailable"]);

function plainTextValue(value: unknown, indent = ""): string {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const rendered = plainTextValue(item, indent + "  ");
        return rendered ? `${indent}- ${rendered.trimStart()}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([k, v]) => !HIDDEN_KEYS.has(k) && v !== null && v !== undefined && v !== "")
      .map(([k, v]) => {
        const rendered = plainTextValue(v, indent + "  ");
        if (!rendered) return "";
        return rendered.includes("\n")
          ? `${indent}${humanizeKey(k)}:\n${rendered}`
          : `${indent}${humanizeKey(k)}: ${rendered}`;
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(value);
}

function plainTextFromContent(content: Record<string, unknown>, outputType: string): string {
  if (content.unavailable === true) return "";
  if (outputType === "email") {
    const subject = typeof content.subject === "string" ? content.subject : "";
    const body = typeof content.body === "string" ? content.body : "";
    if (subject || body) return [subject && `Subject: ${subject}`, body].filter(Boolean).join("\n\n");
  }
  if (outputType === "whatsapp" && typeof content.message === "string" && content.message) {
    return content.message;
  }
  return plainTextValue(content);
}

function DataValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">None</span>;
    return (
      <ul className="space-y-1 mt-1">
        {value.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <div className="w-1 h-1 rounded-full bg-primary mt-1.5 flex-shrink-0" />
            {item !== null && typeof item === "object" ? (
              <div className="space-y-0.5">
                {Object.entries(item as Record<string, unknown>).map(([k, v]) => (
                  <div key={k}>
                    <span className="text-muted-foreground">{humanizeKey(k)}: </span>
                    <ScalarValue value={v} />
                  </div>
                ))}
              </div>
            ) : (
              <ScalarValue value={item} />
            )}
          </li>
        ))}
      </ul>
    );
  }
  if (value !== null && typeof value === "object") {
    return (
      <div className="space-y-0.5 mt-1">
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="text-sm">
            <span className="text-muted-foreground">{humanizeKey(k)}: </span>
            <ScalarValue value={v} />
          </div>
        ))}
      </div>
    );
  }
  return <ScalarValue value={value} />;
}

function ContentRenderer({
  content,
  onRetry,
  retrying,
  onCopyMessageField,
}: {
  content: Record<string, unknown>;
  onRetry?: () => void;
  retrying?: boolean;
  onCopyMessageField?: (text: string) => void;
}) {
  if (content.unavailable === true) {
    return (
      <div className="bg-secondary/50 border rounded-md p-4 text-sm text-muted-foreground flex items-center justify-between gap-3 flex-wrap" data-testid="copilot-draft-unavailable">
        <span className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
          This draft could not be generated right now.
        </span>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying} className="gap-1" data-testid="button-retry-generation">
            <RefreshCw className={`h-3.5 w-3.5 ${retrying ? "animate-spin" : ""}`} /> {retrying ? "Retrying…" : "Try again"}
          </Button>
        )}
      </div>
    );
  }

  const entries = Object.entries(content).filter(([, v]) => v !== null && v !== undefined);

  return (
    <div className="space-y-3">
      {entries.map(([key, value]) => {
        if (isMessageField(key) && typeof value === "string") {
          return (
            <div key={key} className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {humanizeKey(key)}
              </p>
              <div className="bg-secondary/30 p-3 rounded-md border text-sm whitespace-pre-wrap relative group">
                {value}
                {onCopyMessageField && (
                  <Button
                    size="icon"
                    variant="outline"
                    className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6"
                    onClick={() => onCopyMessageField(value)}
                    title="Copy to clipboard"
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                )}
              </div>
            </div>
          );
        }
        return (
          <div key={key}>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {humanizeKey(key)}
            </p>
            <DataValue value={value} />
          </div>
        );
      })}
    </div>
  );
}

function CopilotOutputCard({
  output,
  onUse,
  onDismiss,
  onEdit,
  onRegenerate,
  regenerating,
  canSaveNote,
  onSaveNote,
  savingNote,
  acting,
}: {
  output: AiCopilotOutput;
  onUse: (id: number) => void;
  onDismiss: (id: number) => void;
  onEdit: (id: number, editedContent: Record<string, unknown>) => void;
  onRegenerate: (output: AiCopilotOutput) => void;
  regenerating: boolean;
  canSaveNote: boolean;
  onSaveNote: (output: AiCopilotOutput, text: string) => void;
  savingNote: boolean;
  acting: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editJson, setEditJson] = useState("");
  const { toast } = useToast();

  const label = OUTPUT_LABELS[output.outputType] ?? humanizeKey(output.outputType);
  const isDeterministic = output.source === "deterministic";
  const displayContent = (output.editedContent || output.content) as Record<string, unknown>;
  const isUnavailable = displayContent.unavailable === true;

  // OS handoff: the draft is copied/opened in the user's own mail/WhatsApp app —
  // Copilot NEVER auto-sends. mailto has no recipient so the OS picks the mail app
  // (honors the "no forced Gmail" preference); wa.me has no number so WhatsApp lets
  // the user pick the contact. Only real generated content is used (no fabrication).
  const isEmail = output.outputType === "email";
  const isWhatsapp = output.outputType === "whatsapp";
  const emailSubject = typeof displayContent.subject === "string" ? displayContent.subject : "";
  const emailBody = typeof displayContent.body === "string" ? displayContent.body : "";
  const waMessage = typeof displayContent.message === "string" ? displayContent.message : "";
  const copyText = plainTextFromContent(displayContent, output.outputType);

  const copyToClipboard = async (text: string) => {
    const ok = await copyTextToClipboard(text);
    if (ok) {
      toast({ title: "Copied to clipboard" });
    } else {
      toast({ title: "Copy failed", description: "Your browser blocked clipboard access — select the text and copy manually.", variant: "destructive" });
    }
  };

  const handleCopy = () => void copyToClipboard(copyText);
  const openEmail = () => {
    window.open(`mailto:?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`, "_blank");
  };
  const openWhatsapp = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(waMessage)}`, "_blank");
  };

  const handleEditOpen = () => {
    setEditJson(JSON.stringify(displayContent, null, 2));
    setIsEditing(true);
  };

  const handleEditSave = () => {
    try {
      const parsed = JSON.parse(editJson);
      onEdit(output.id, parsed);
      setIsEditing(false);
    } catch {
      toast({ title: "Invalid JSON", description: "Fix the JSON syntax and try saving again.", variant: "destructive" });
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-sm">{label}</span>
          <Badge
            variant="outline"
            className="text-[10px] gap-1 font-normal"
            title={isDeterministic ? "Rule-based" : "AI"}
          >
            {isDeterministic ? <ShieldCheck className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
            {isDeterministic ? "Rule-based" : "AI"}
          </Badge>
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${confidenceTone(output.confidence)}`}>
            {output.confidence === null || output.confidence === undefined
              ? "Confidence n/a"
              : `${output.confidence}% confidence`}
          </span>
          <Badge variant={output.status === "used" ? "default" : output.status === "dismissed" ? "secondary" : "outline"} className="capitalize text-[10px]">
            {output.status}
          </Badge>
        </div>
      </div>

      {output.reasoning && (
        <p className="text-sm leading-relaxed text-foreground/90 bg-primary/5 p-2 rounded border border-primary/10">
          <Sparkles className="h-3 w-3 inline mr-1 text-primary" /> {output.reasoning}
        </p>
      )}

      <ContentRenderer
        content={displayContent}
        onRetry={() => onRegenerate(output)}
        retrying={regenerating}
        onCopyMessageField={(text) => void copyToClipboard(text)}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground pt-2 border-t border-border/60">
        <span>Generated {formatTs(output.generatedAt)}</span>
        {!isDeterministic && output.model && <span>Model: {output.model}</span>}
        {output.promptVersion !== null && output.promptVersion !== undefined && (
          <span>Prompt v{output.promptVersion}</span>
        )}
        {output.usedAt && <span>Used {formatTs(output.usedAt)}</span>}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={handleCopy} disabled={isUnavailable} className="gap-1" data-testid={`button-copy-${output.outputType}`}>
          <Copy className="h-3.5 w-3.5" /> Copy
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onRegenerate(output)}
          disabled={acting || regenerating}
          className="gap-1"
          title="Generate a fresh draft of this type. If generation fails, your current draft is kept."
          data-testid={`button-regenerate-${output.outputType}`}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${regenerating ? "animate-spin" : ""}`} /> {regenerating ? "Regenerating…" : "Regenerate"}
        </Button>
        {canSaveNote && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onSaveNote(output, copyText)}
            disabled={savingNote || isUnavailable || !copyText}
            className="gap-1"
            title="Save this draft as a note on the timeline"
            data-testid={`button-save-note-${output.outputType}`}
          >
            <StickyNote className="h-3.5 w-3.5" /> {savingNote ? "Saving…" : "Save as Note"}
          </Button>
        )}
        {isEmail && (emailSubject || emailBody) && (
          <Button size="sm" variant="outline" onClick={openEmail} className="gap-1">
            <Mail className="h-3.5 w-3.5" /> Open in Email
          </Button>
        )}
        {isWhatsapp && waMessage && (
          <Button size="sm" variant="outline" onClick={openWhatsapp} className="gap-1">
            <MessageCircle className="h-3.5 w-3.5" /> Send on WhatsApp
          </Button>
        )}
      </div>

      {(output.status === "generated" || output.status === "edited") && (
        <div className="flex items-center gap-2 pt-2">
          <Button size="sm" onClick={() => onUse(output.id)} disabled={acting} className="gap-1">
            <Check className="h-3.5 w-3.5" /> Mark as Used
          </Button>
          
          <Dialog open={isEditing} onOpenChange={setIsEditing}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={acting} onClick={handleEditOpen} className="gap-1">
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Edit Draft Content</DialogTitle>
              </DialogHeader>
              <div className="py-4">
                <p className="text-xs text-muted-foreground mb-2">Edit the JSON representation of this output:</p>
                <Textarea 
                  value={editJson} 
                  onChange={e => setEditJson(e.target.value)} 
                  className="font-mono text-xs min-h-[300px]" 
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsEditing(false)}>Cancel</Button>
                <Button onClick={handleEditSave} disabled={acting}>Save Changes</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Button
            size="sm"
            variant="outline"
            onClick={() => onDismiss(output.id)}
            disabled={acting}
            className="gap-1 text-destructive hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" /> Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

export function SalesCopilotPanel({
  entityType,
  id,
}: {
  entityType: EntityType;
  id: number;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [outputType, setOutputType] = useState<string>("");
  const [instructions, setInstructions] = useState("");
  const [language, setLanguage] = useState<"en" | "ar">("en");
  const [regeneratingType, setRegeneratingType] = useState<string | null>(null);
  const [savingNoteType, setSavingNoteType] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useGetAiCopilotPanel(entityType, id, {
    query: { queryKey: getGetAiCopilotPanelQueryKey(entityType, id), enabled: id > 0 },
  });

  const generate = useGenerateAiCopilotOutput();
  const edit = useEditAiCopilotOutput();
  const markUsed = useUseAiCopilotOutput();
  const dismiss = useDismissAiCopilotOutput();
  const createContactNote = useCreateContactNote();
  const createLeadActivity = useCreateLeadActivity();

  // Save as Note reuses the timeline note endpoints (contacts + leads only —
  // organizations have no note timeline). Gated on the matching edit permission.
  const isFullAccess = user?.role === "primary_admin" || user?.role === "platform_owner";
  const perms = (user?.permissions ?? {}) as Record<string, string[]>;
  const canSaveNote =
    (entityType === "contact" && (isFullAccess || (perms.contacts ?? []).includes("edit"))) ||
    (entityType === "lead" && (isFullAccess || (perms.leads ?? []).includes("edit")));

  const outputs = data?.outputs ?? [];
  const suggestedAction = data?.suggestedAction ?? null;
  const coachingSignals = data?.coachingSignals ?? [];
  const insights = data?.insights ?? [];
  const validOutputs = data?.availableOutputTypes ?? OUTPUT_TYPES_BY_ENTITY[entityType] ?? [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetAiCopilotPanelQueryKey(entityType, id) });
    queryClient.invalidateQueries({ queryKey: getGetAiCopilotOutputsQueryKey(entityType, id) });
    queryClient.invalidateQueries({ queryKey: getGetAiCopilotOverviewQueryKey() });
  };

  // Shared outcome handling for generate + regenerate: the API soft-degrades to
  // HTTP 200, so "failure" arrives either as generationFailed (previous draft was
  // kept) or as an { unavailable: true } placeholder (no previous draft existed).
  const reportGenerateOutcome = (result: AiCopilotOutput & { generationFailed?: boolean }, regenerated: boolean) => {
    if (result.generationFailed) {
      toast({
        title: "Generation failed — previous draft kept",
        description: "The AI could not produce a new draft, so your existing draft was left untouched. Try again in a moment.",
        variant: "destructive",
      });
      return;
    }
    const content = (result.content ?? {}) as Record<string, unknown>;
    if (content.unavailable === true && !result.editedContent) {
      toast({
        title: "Draft unavailable",
        description: "The AI could not generate this draft right now. Use Try again on the card.",
        variant: "destructive",
      });
      return;
    }
    toast({ title: regenerated ? "Draft regenerated" : "Draft generated successfully" });
  };

  const handleGenerate = () => {
    if (!outputType || generate.isPending) return;
    generate.mutate(
      { entityType, id, outputType, data: { language, instructions: instructions || undefined } },
      {
        onSuccess: (result) => {
          invalidate();
          setInstructions("");
          reportGenerateOutcome(result as AiCopilotOutput & { generationFailed?: boolean }, false);
        },
        onError: (err: unknown) => {
          const info = describeAiError(err, "Generation failed");
          toast({ title: info.title, description: info.description, variant: "destructive" });
        },
      },
    );
  };

  // Regenerate keeps the card's own type + language; per-card busy state.
  const handleRegenerate = (output: AiCopilotOutput) => {
    if (generate.isPending) return;
    setRegeneratingType(output.outputType);
    generate.mutate(
      { entityType, id, outputType: output.outputType, data: { language: (output.language === "ar" ? "ar" : "en") } },
      {
        onSuccess: (result) => {
          invalidate();
          reportGenerateOutcome(result as AiCopilotOutput & { generationFailed?: boolean }, true);
        },
        onError: (err: unknown) => {
          const info = describeAiError(err, "Regeneration failed");
          toast({ title: info.title, description: `${info.description} Your current draft was kept.`, variant: "destructive" });
        },
        onSettled: () => setRegeneratingType(null),
      },
    );
  };

  const handleSaveNote = (output: AiCopilotOutput, text: string) => {
    if (!text || savingNoteType) return;
    const label = OUTPUT_LABELS[output.outputType] ?? humanizeKey(output.outputType);
    setSavingNoteType(output.outputType);
    const onSaved = () => {
      toast({ title: "Saved to timeline", description: `The ${label.toLowerCase()} was saved as a note.` });
    };
    const onFailed = (err: unknown) => {
      const info = describeAiError(err, "Could not save note");
      toast({ title: info.title, description: info.description, variant: "destructive" });
    };
    if (entityType === "contact") {
      createContactNote.mutate(
        { id, data: { body: text, subject: `AI draft — ${label}`, aiGenerated: true, aiOutputType: output.outputType } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetContactTimelineQueryKey(id) });
            onSaved();
          },
          onError: onFailed,
          onSettled: () => setSavingNoteType(null),
        },
      );
    } else if (entityType === "lead") {
      createLeadActivity.mutate(
        { id, data: { type: "note", subject: `AI draft — ${label}`, body: text } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListLeadActivitiesQueryKey(id) });
            onSaved();
          },
          onError: onFailed,
          onSettled: () => setSavingNoteType(null),
        },
      );
    } else {
      setSavingNoteType(null);
    }
  };

  const handleUse = (outputId: number) => {
    markUsed.mutate(
      { id: outputId },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Marked as used" });
        },
        onError: () => toast({ title: "Could not update status", variant: "destructive" }),
      },
    );
  };

  const handleEdit = (outputId: number, editedContent: Record<string, unknown>) => {
    edit.mutate(
      { id: outputId, data: { editedContent } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Draft updated" });
        },
        onError: () => toast({ title: "Could not update draft", variant: "destructive" }),
      },
    );
  };

  const handleDismiss = (outputId: number) => {
    dismiss.mutate(
      { id: outputId },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Draft dismissed" });
        },
        onError: () => toast({ title: "Could not dismiss", variant: "destructive" }),
      },
    );
  };

  const acting = generate.isPending || markUsed.isPending || dismiss.isPending || edit.isPending;

  return (
    <Card className="shadow-sm border-primary/20">
      <CardHeader className="pb-3 border-b border-primary/10">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2 text-primary">
            <Bot className="h-4 w-4" /> AI Sales Copilot
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        <div className="space-y-3 bg-secondary/20 p-3 rounded-lg border border-border">
          <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 mb-1">
            <Info className="h-3.5 w-3.5" />
            Every generated output is a reviewable draft. Copilot never auto-sends messages.
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={outputType} onValueChange={setOutputType}>
              <SelectTrigger className="w-[180px]" data-testid="select-copilot-type">
                <SelectValue placeholder="Select type..." />
              </SelectTrigger>
              <SelectContent>
                {validOutputs.map((t) => (
                  <SelectItem key={t} value={t}>{OUTPUT_LABELS[t] ?? t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={language} onValueChange={(v) => setLanguage(v as "en" | "ar")}>
              <SelectTrigger className="w-[130px]" aria-label="Draft language">
                <Languages className="h-3.5 w-3.5 mr-1 opacity-70" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="ar">العربية</SelectItem>
              </SelectContent>
            </Select>
            <Input 
              placeholder="Optional context/instructions..." 
              value={instructions} 
              onChange={e => setInstructions(e.target.value)} 
              className="flex-1 min-w-[160px]"
            />
            <Button size="sm" onClick={handleGenerate} disabled={acting || !outputType} className="gap-1" data-testid="button-copilot-generate">
              <Sparkles className="h-3.5 w-3.5" /> {generate.isPending ? "Generating..." : "Generate"}
            </Button>
          </div>
        </div>

        {(suggestedAction || coachingSignals.length > 0 || insights.length > 0) && (
          <div className="grid gap-3">
            {suggestedAction && (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-primary mb-1">
                  <Compass className="h-3.5 w-3.5" /> Suggested next action
                  <Badge variant="secondary" className="ml-1 text-[10px]">Rule-based</Badge>
                </div>
                <p className="text-sm">{String((suggestedAction as Record<string, unknown>).basis ?? "Follow up with this contact.")}</p>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                  {(suggestedAction as Record<string, unknown>).suggestedDate ? (
                    <span>Date: {String((suggestedAction as Record<string, unknown>).suggestedDate)}</span>
                  ) : null}
                  {(suggestedAction as Record<string, unknown>).channel ? (
                    <span>Channel: {String((suggestedAction as Record<string, unknown>).channel)}</span>
                  ) : null}
                  {(suggestedAction as Record<string, unknown>).priority ? (
                    <span>Priority: {String((suggestedAction as Record<string, unknown>).priority)}</span>
                  ) : null}
                </div>
              </div>
            )}
            {coachingSignals.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" /> Coaching signals
                </div>
                <ul className="space-y-1">
                  {coachingSignals.map((s, i) => {
                    const sig = s as Record<string, unknown>;
                    return (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <Badge variant="outline" className="text-[10px] shrink-0">{String(sig.severity ?? "info")}</Badge>
                        <span>{String(sig.detail ?? sig.type ?? "")}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {insights.length > 0 && (
              <div className="rounded-lg border border-border bg-secondary/20 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground mb-1.5">
                  <Lightbulb className="h-3.5 w-3.5" /> AI intelligence
                </div>
                <ul className="space-y-1">
                  {insights.map((ins) => (
                    <li key={ins.id} className="text-sm">
                      <span className="font-medium">{humanizeKey(String(ins.insightType ?? ""))}</span>
                      {ins.reasoning ? <span className="text-muted-foreground"> — {ins.reasoning}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="space-y-3">
          {isError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 flex items-center justify-between gap-3 flex-wrap" data-testid="copilot-panel-error">
              <span className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" /> Could not load the Copilot panel.
              </span>
              <Button size="sm" variant="outline" onClick={() => void refetch()} className="gap-1" data-testid="button-retry-panel">
                <RefreshCw className="h-3.5 w-3.5" /> Retry
              </Button>
            </div>
          ) : isLoading ? (
            <p className="text-sm text-muted-foreground">Loading drafts…</p>
          ) : outputs.length === 0 ? (
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <span>No AI drafts generated yet. Choose a type above to generate.</span>
            </div>
          ) : (
            outputs.map((output) => (
              <CopilotOutputCard
                key={output.id}
                output={output}
                onUse={handleUse}
                onDismiss={handleDismiss}
                onEdit={handleEdit}
                onRegenerate={handleRegenerate}
                regenerating={regeneratingType === output.outputType}
                canSaveNote={canSaveNote}
                onSaveNote={handleSaveNote}
                savingNote={savingNoteType === output.outputType}
                acting={acting}
              />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default SalesCopilotPanel;
