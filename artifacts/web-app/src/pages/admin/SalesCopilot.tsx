import React from "react";
import { Link } from "wouter";
import {
  useGetAiCopilotOverview,
  getGetAiCopilotOverviewQueryKey,
  useUseAiCopilotOutput,
  useDismissAiCopilotOutput,
  useEditAiCopilotOutput,
  type AiCopilotOutput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Bot, ShieldCheck, Cpu, ChevronRight, Copy, Check, X, Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { AiWorkspaceLayout } from "@/components/layouts/AiWorkspaceLayout";

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

const ENTITY_PATH: Record<string, string> = {
  lead: "/admin/leads",
  contact: "/admin/contacts",
  organization: "/admin/companies",
};

function label(type: string): string {
  return (
    OUTPUT_LABELS[type] ??
    type.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function formatTs(ts?: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

function StatCard({ title, value, tone }: { title: string; value: number; tone: string }) {
  return (
    <Card className="shadow-sm">
      <CardContent className="pt-6">
        <div className={`text-3xl font-bold ${tone}`}>{value}</div>
        <div className="text-xs uppercase tracking-widest text-muted-foreground mt-1">{title}</div>
      </CardContent>
    </Card>
  );
}

function RecentRow({ output }: { output: AiCopilotOutput }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = React.useState(false);
  
  const displayContent = (output.editedContent || output.content) as Record<string, unknown>;
  const [editJson, setEditJson] = React.useState(JSON.stringify(displayContent, null, 2));

  const markUsed = useUseAiCopilotOutput();
  const dismiss = useDismissAiCopilotOutput();
  const edit = useEditAiCopilotOutput();

  const acting = markUsed.isPending || dismiss.isPending || edit.isPending;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetAiCopilotOverviewQueryKey() });
  };

  const href = ENTITY_PATH[output.entityType]
    ? `${ENTITY_PATH[output.entityType]}/${output.entityId}`
    : undefined;
  
  const isDeterministic = output.source === "deterministic";

  const handleEditSave = () => {
    try {
      const parsed = JSON.parse(editJson);
      edit.mutate({ id: output.id, data: { editedContent: parsed } }, {
        onSuccess: () => {
          invalidate();
          setIsEditing(false);
          toast({ title: "Draft updated" });
        }
      });
    } catch {
      alert("Invalid JSON format");
    }
  };

  return (
    <div className="flex flex-col gap-3 py-4 px-1">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{label(output.outputType)}</span>
            <Badge variant="outline" className="text-[10px] gap-1 font-normal capitalize">
              {isDeterministic ? <ShieldCheck className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
              {output.entityType}
            </Badge>
            <Badge
              variant={
                output.status === "used"
                  ? "default"
                  : output.status === "dismissed"
                    ? "secondary"
                    : "outline"
              }
              className="capitalize text-[10px]"
            >
              {output.status}
            </Badge>
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Generated {formatTs(output.generatedAt)}
            {output.confidence !== null && output.confidence !== undefined
              ? ` · ${output.confidence}% confidence`
              : ""}
          </p>
        </div>
        {href && (
          <Link href={href} className="flex items-center text-xs font-medium text-primary hover:underline">
            View Record <ChevronRight className="h-4 w-4 ml-0.5" />
          </Link>
        )}
      </div>
      
      <div className="bg-secondary/20 p-3 rounded-md text-sm border font-mono whitespace-pre-wrap max-h-[150px] overflow-y-auto">
        {JSON.stringify(displayContent, null, 2)}
      </div>

      {(output.status === "generated" || output.status === "edited") && (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => {
            markUsed.mutate({ id: output.id }, { onSuccess: () => { invalidate(); toast({ title: "Marked as used" }); }});
          }} disabled={acting} className="gap-1">
            <Check className="h-3.5 w-3.5" /> Use
          </Button>
          
          <Dialog open={isEditing} onOpenChange={setIsEditing}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={acting} className="gap-1">
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Edit Draft Content</DialogTitle>
              </DialogHeader>
              <div className="py-4">
                <Textarea 
                  value={editJson} 
                  onChange={e => setEditJson(e.target.value)} 
                  className="font-mono text-xs min-h-[300px]" 
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsEditing(false)}>Cancel</Button>
                <Button onClick={handleEditSave} disabled={acting}>Save</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              dismiss.mutate({ id: output.id }, { onSuccess: () => { invalidate(); toast({ title: "Dismissed" }); }});
            }}
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

export default function SalesCopilot() {
  const { data, isLoading } = useGetAiCopilotOverview({
    query: { queryKey: getGetAiCopilotOverviewQueryKey() },
  });

  const counts = data?.counts ?? {};
  const recent = data?.recent ?? [];

  return (
    <AiWorkspaceLayout activeTab="copilot">
      <div className="space-y-6 max-w-5xl mx-auto pb-10">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard title="Generated" value={counts.generated ?? 0} tone="text-blue-600" />
        <StatCard title="Edited" value={counts.edited ?? 0} tone="text-purple-600" />
        <StatCard title="Used" value={counts.used ?? 0} tone="text-emerald-600" />
        <StatCard title="Dismissed" value={counts.dismissed ?? 0} tone="text-muted-foreground" />
      </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-3 border-b border-border">
          <CardTitle className="text-base">Recent Drafts</CardTitle>
        </CardHeader>
        <CardContent className="pt-2 divide-y divide-border">
          {isLoading ? (
            <p className="text-sm text-muted-foreground py-4">Loading…</p>
          ) : recent.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No AI drafts generated yet.
            </p>
          ) : (
            recent.map((output) => <RecentRow key={output.id} output={output} />)
          )}
        </CardContent>
      </Card>
      </div>
    </AiWorkspaceLayout>
  );
}
