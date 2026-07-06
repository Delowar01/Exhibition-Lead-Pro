import React, { useState } from "react";
import {
  useGetAiCopilotOutputs,
  useGenerateAiCopilotOutput,
  useEditAiCopilotOutput,
  useUseAiCopilotOutput,
  useDismissAiCopilotOutput,
  getGetAiCopilotOutputsQueryKey,
  getGetAiCopilotOverviewQueryKey,
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
import { Bot, Sparkles, Check, X, ShieldCheck, Cpu, Copy, Pencil, Info } from "lucide-react";

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

function ContentRenderer({ content }: { content: Record<string, unknown> }) {
  if (content.unavailable === true) {
    return (
      <div className="bg-secondary/50 border rounded-md p-4 text-sm text-muted-foreground">
        This draft could not be generated right now — try again.
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
                <Button
                  size="icon"
                  variant="outline"
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6"
                  onClick={() => navigator.clipboard.writeText(value)}
                  title="Copy to clipboard"
                >
                  <Copy className="h-3 w-3" />
                </Button>
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
  acting,
}: {
  output: AiCopilotOutput;
  onUse: (id: number) => void;
  onDismiss: (id: number) => void;
  onEdit: (id: number, editedContent: Record<string, unknown>) => void;
  acting: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editJson, setEditJson] = useState("");

  const label = OUTPUT_LABELS[output.outputType] ?? humanizeKey(output.outputType);
  const isDeterministic = output.source === "deterministic";
  const displayContent = (output.editedContent || output.content) as Record<string, unknown>;

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
      alert("Invalid JSON format");
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

      <ContentRenderer content={displayContent} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground pt-2 border-t border-border/60">
        <span>Generated {formatTs(output.generatedAt)}</span>
        {!isDeterministic && output.model && <span>Model: {output.model}</span>}
        {output.promptVersion !== null && output.promptVersion !== undefined && (
          <span>Prompt v{output.promptVersion}</span>
        )}
        {output.usedAt && <span>Used {formatTs(output.usedAt)}</span>}
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
  
  const [outputType, setOutputType] = useState<string>("");
  const [instructions, setInstructions] = useState("");

  const { data, isLoading } = useGetAiCopilotOutputs(entityType, id, {
    query: { queryKey: getGetAiCopilotOutputsQueryKey(entityType, id), enabled: id > 0 },
  });
  
  const generate = useGenerateAiCopilotOutput();
  const edit = useEditAiCopilotOutput();
  const markUsed = useUseAiCopilotOutput();
  const dismiss = useDismissAiCopilotOutput();

  const outputs = data?.outputs ?? [];
  const validOutputs = OUTPUT_TYPES_BY_ENTITY[entityType] ?? [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetAiCopilotOutputsQueryKey(entityType, id) });
    queryClient.invalidateQueries({ queryKey: getGetAiCopilotOverviewQueryKey() });
  };

  const handleGenerate = () => {
    if (!outputType) return;
    generate.mutate(
      { entityType, id, data: { outputType, instructions: instructions || undefined } },
      {
        onSuccess: () => {
          invalidate();
          setInstructions("");
          toast({ title: "Draft generated successfully" });
        },
        onError: () => {
          toast({ title: "Generation failed", description: "Please try again.", variant: "destructive" });
        },
      },
    );
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
          <div className="flex gap-2">
            <Select value={outputType} onValueChange={setOutputType}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Select type..." />
              </SelectTrigger>
              <SelectContent>
                {validOutputs.map((t) => (
                  <SelectItem key={t} value={t}>{OUTPUT_LABELS[t] ?? t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input 
              placeholder="Optional context/instructions..." 
              value={instructions} 
              onChange={e => setInstructions(e.target.value)} 
              className="flex-1"
            />
            <Button size="sm" onClick={handleGenerate} disabled={acting || !outputType} className="gap-1">
              <Sparkles className="h-3.5 w-3.5" /> {generate.isPending ? "Generating..." : "Generate"}
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          {isLoading ? (
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
