import React from "react";
import {
  useGetAiWorkflowRecommendations,
  useAnalyzeAiWorkflowEntity,
  useAcceptAiWorkflowRecommendation,
  useDismissAiWorkflowRecommendation,
  useUpdateLead,
  useUpdateContact,
  getGetAiWorkflowRecommendationsQueryKey,
  getGetAiWorkflowOverviewQueryKey,
  getGetLeadQueryKey,
  getGetContactQueryKey,
  type AiWorkflowRecommendation,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Workflow, Sparkles, Check, X, ShieldCheck, Cpu, Info, Languages, ArrowUpRight } from "lucide-react";

type EntityType = "lead" | "contact" | "organization";

// A recommendation is "applyable" only when it maps to a concrete field the
// EXISTING manual CRM update endpoint accepts (LeadUpdate/ContactUpdate:
// assignedToId + followUpDate). Applying is a user-initiated write through the
// normal manual endpoint — it never happens automatically, and Accept still
// only records approval without mutating the CRM.
type ApplyTarget = { field: "assignedToId" | "followUpDate"; value: number | string; summary: string };

function applyTarget(rec: AiWorkflowRecommendation, entityType: EntityType): ApplyTarget | null {
  if (entityType !== "lead" && entityType !== "contact") return null;
  const d = (rec.data ?? {}) as Record<string, unknown>;
  if (rec.recommendationType === "owner" && typeof d.suggestedOwnerId === "number") {
    const name = typeof d.suggestedOwnerName === "string" ? d.suggestedOwnerName : "suggested owner";
    return { field: "assignedToId", value: d.suggestedOwnerId, summary: `Assign owner to ${name}` };
  }
  // followUpDate only exists on CONTACTS (leads have no such column) — never offer
  // it for a lead or the manual PATCH strips it to an empty update and 400s.
  if (
    entityType === "contact" &&
    (rec.recommendationType === "follow_up" || rec.recommendationType === "due_date") &&
    typeof d.suggestedDate === "string"
  ) {
    return { field: "followUpDate", value: d.suggestedDate, summary: `Set follow-up date to ${d.suggestedDate}` };
  }
  return null;
}

const TYPE_LABELS: Record<string, string> = {
  next_action: "Next action",
  follow_up: "Follow-up",
  owner: "Suggested owner",
  department: "Suggested department",
  team: "Suggested team",
  priority: "Priority",
  due_date: "Due date",
  routing: "Smart routing",
  progression: "Opportunity progression",
  reminder: "Smart reminder",
  task: "Task recommendation",
};

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function label(type: string): string {
  return TYPE_LABELS[type] ?? humanizeKey(type);
}

function formatTs(ts?: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

function ScalarValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  return <span>{String(value)}</span>;
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

function RecommendationCard({
  rec,
  entityType,
  onAccept,
  onDismiss,
  onApply,
  acting,
}: {
  rec: AiWorkflowRecommendation;
  entityType: EntityType;
  onAccept: (id: number) => void;
  onDismiss: (id: number) => void;
  onApply: (rec: AiWorkflowRecommendation) => void;
  acting: boolean;
}) {
  const isDeterministic = rec.source === "deterministic";
  const data = (rec.data ?? {}) as Record<string, unknown>;
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined);
  const target = rec.status === "dismissed" ? null : applyTarget(rec, entityType);

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm">{label(rec.recommendationType)}</span>
        <Badge variant="outline" className="text-[10px] gap-1 font-normal" title={isDeterministic ? "Rule-based" : "AI"}>
          {isDeterministic ? <ShieldCheck className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
          {isDeterministic ? "Rule-based" : "AI"}
        </Badge>
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          {rec.confidence === null || rec.confidence === undefined ? "Confidence n/a" : `${rec.confidence}% confidence`}
        </span>
        <Badge
          variant={rec.status === "accepted" ? "default" : rec.status === "dismissed" ? "secondary" : "outline"}
          className="capitalize text-[10px]"
        >
          {rec.status}
        </Badge>
      </div>

      {rec.reasoning && (
        <p className="text-sm leading-relaxed text-foreground/90 bg-primary/5 p-2 rounded border border-primary/10">
          <Sparkles className="h-3 w-3 inline mr-1 text-primary" /> {rec.reasoning}
        </p>
      )}

      {entries.length > 0 && (
        <div className="space-y-2">
          {entries.map(([key, value]) => (
            <div key={key}>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{humanizeKey(key)}</p>
              <DataValue value={value} />
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground pt-2 border-t border-border/60">
        <span>Generated {formatTs(rec.generatedAt)}</span>
        {!isDeterministic && rec.model && <span>Model: {rec.model}</span>}
        {rec.promptVersion !== null && rec.promptVersion !== undefined && <span>Prompt v{rec.promptVersion}</span>}
        {rec.acceptedAt && <span>Accepted {formatTs(rec.acceptedAt)}</span>}
      </div>

      {(rec.status === "suggested" || target) && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {rec.status === "suggested" && (
            <>
              <Button size="sm" onClick={() => onAccept(rec.id)} disabled={acting} className="gap-1">
                <Check className="h-3.5 w-3.5" /> Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onDismiss(rec.id)}
                disabled={acting}
                className="gap-1 text-destructive hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" /> Dismiss
              </Button>
            </>
          )}
          {target && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onApply(rec)}
              disabled={acting}
              className="gap-1"
              title={`${target.summary} (updates the CRM via the normal manual edit)`}
            >
              <ArrowUpRight className="h-3.5 w-3.5" /> Apply
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkflowIntelligencePanel({ entityType, id }: { entityType: EntityType; id: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [language, setLanguage] = React.useState<"en" | "ar">("en");

  const { data, isLoading } = useGetAiWorkflowRecommendations(entityType, id, {
    query: { queryKey: getGetAiWorkflowRecommendationsQueryKey(entityType, id), enabled: id > 0 },
  });

  const analyze = useAnalyzeAiWorkflowEntity();
  const accept = useAcceptAiWorkflowRecommendation();
  const dismiss = useDismissAiWorkflowRecommendation();
  const updateLead = useUpdateLead();
  const updateContact = useUpdateContact();

  const recommendations = data?.recommendations ?? [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetAiWorkflowRecommendationsQueryKey(entityType, id) });
    queryClient.invalidateQueries({ queryKey: getGetAiWorkflowOverviewQueryKey() });
  };

  // Apply routes through the EXISTING manual update endpoint (PATCH /leads|/contacts).
  // It is user-initiated and writes a single recommended field — the recommendation
  // engine never does this itself.
  const handleApply = (rec: AiWorkflowRecommendation) => {
    const target = applyTarget(rec, entityType);
    if (!target) return;
    const body = { [target.field]: target.value } as Record<string, unknown>;
    const opts = {
      onSuccess: () => {
        if (entityType === "lead") queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(id) });
        else if (entityType === "contact") queryClient.invalidateQueries({ queryKey: getGetContactQueryKey(id) });
        invalidate();
        toast({ title: "Applied via CRM", description: target.summary });
      },
      onError: () => toast({ title: "Could not apply", description: "Please try the manual edit.", variant: "destructive" as const }),
    };
    if (entityType === "lead") updateLead.mutate({ id, data: body }, opts);
    else if (entityType === "contact") updateContact.mutate({ id, data: body }, opts);
  };

  const handleAnalyze = () => {
    analyze.mutate(
      { entityType, id, data: { language } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Workflow recommendations generated" });
        },
        onError: () => toast({ title: "Analysis failed", description: "Please try again.", variant: "destructive" }),
      },
    );
  };

  const handleAccept = (recId: number) => {
    accept.mutate(
      { id: recId },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Recommendation accepted" });
        },
        onError: () => toast({ title: "Could not accept", variant: "destructive" }),
      },
    );
  };

  const handleDismiss = (recId: number) => {
    dismiss.mutate(
      { id: recId },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Recommendation dismissed" });
        },
        onError: () => toast({ title: "Could not dismiss", variant: "destructive" }),
      },
    );
  };

  const acting = analyze.isPending || accept.isPending || dismiss.isPending || updateLead.isPending || updateContact.isPending;

  return (
    <Card className="shadow-sm border-primary/20">
      <CardHeader className="pb-3 border-b border-primary/10">
        <CardTitle className="text-base flex items-center gap-2 text-primary">
          <Workflow className="h-4 w-4" /> Workflow Intelligence
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        <div className="space-y-3 bg-secondary/20 p-3 rounded-lg border border-border">
          <div className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5" />
            Recommendations are reviewable suggestions — accepting records your approval and never auto-changes the CRM.
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={language} onValueChange={(v) => setLanguage(v as "en" | "ar")}>
              <SelectTrigger className="w-[130px]" aria-label="Recommendation language">
                <Languages className="h-3.5 w-3.5 mr-1 opacity-70" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="ar">العربية</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" onClick={handleAnalyze} disabled={acting} className="gap-1">
              <Sparkles className="h-3.5 w-3.5" /> {analyze.isPending ? "Analyzing..." : "Analyze"}
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading recommendations…</p>
          ) : recommendations.length === 0 ? (
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <span>No workflow recommendations yet. Click Analyze to generate them.</span>
            </div>
          ) : (
            recommendations.map((rec) => (
              <RecommendationCard
                key={rec.id}
                rec={rec}
                entityType={entityType}
                onAccept={handleAccept}
                onDismiss={handleDismiss}
                onApply={handleApply}
                acting={acting}
              />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default WorkflowIntelligencePanel;
