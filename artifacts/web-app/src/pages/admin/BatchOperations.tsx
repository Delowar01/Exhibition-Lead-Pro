import React, { useState } from "react";
import {
  useListAiInsightsBatches,
  useStartAiInsightsBatch,
  getListAiInsightsBatchesQueryKey,
  type AiBatchJob,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Layers, Sparkles, Contact, Building2, BarChart2, Info } from "lucide-react";

type EntityType = "lead" | "contact" | "organization";

const ENTITY_OPTIONS: { value: EntityType; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "contact", label: "Contacts", icon: Contact },
  { value: "lead", label: "Leads", icon: BarChart2 },
  { value: "organization", label: "Organizations", icon: Building2 },
];

const STATUS_TONE: Record<string, string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
};

function formatTs(ts?: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

function JobRow({ job }: { job: AiBatchJob }) {
  const pct = job.total > 0 ? Math.round((job.processed / job.total) * 100) : job.status === "completed" ? 100 : 0;
  const entityLabel = ENTITY_OPTIONS.find((e) => e.value === job.entityType)?.label ?? job.entityType;
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm capitalize">{entityLabel}</span>
          <Badge variant="outline" className={`text-[10px] font-medium capitalize ${STATUS_TONE[job.status] ?? ""}`}>
            {job.status}
          </Badge>
        </div>
        <span className="text-[11px] text-muted-foreground">Started {formatTs(job.startedAt)}</span>
      </div>

      <div className="space-y-1">
        <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full transition-all ${job.status === "failed" ? "bg-rose-500" : "bg-primary"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span>
            {job.processed} / {job.total} processed ({pct}%)
          </span>
          <span className="text-emerald-600 dark:text-emerald-400">{job.succeeded} succeeded</span>
          {job.failed > 0 && <span className="text-rose-600 dark:text-rose-400">{job.failed} failed</span>}
          {job.finishedAt && <span>Finished {formatTs(job.finishedAt)}</span>}
        </div>
      </div>

      {job.errors.length > 0 && (
        <div className="text-[11px] text-rose-600 dark:text-rose-400 space-y-0.5">
          {job.errors.slice(0, 5).map((e, i) => (
            <div key={i}>
              #{e.entityId}: {e.message}
            </div>
          ))}
          {job.errors.length > 5 && <div>…and {job.errors.length - 5} more</div>}
        </div>
      )}
    </div>
  );
}

export default function BatchOperations() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [entityType, setEntityType] = useState<EntityType>("contact");

  const { data, isLoading } = useListAiInsightsBatches({
    query: { queryKey: getListAiInsightsBatchesQueryKey(), refetchInterval: 2500 },
  });
  const start = useStartAiInsightsBatch();

  const jobs = data?.jobs ?? [];

  const handleStart = () => {
    start.mutate(
      { data: { entityType } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAiInsightsBatchesQueryKey() });
          toast({ title: "Batch analysis started", description: `Analyzing all ${entityType}s in your CRM.` });
        },
        onError: () => toast({ title: "Could not start batch", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Layers className="h-6 w-6 text-primary" /> Batch AI Operations
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Generate AI insights across all records of an entity type at once. All recommendations stay reviewable and
          are never applied automatically.
        </p>
      </div>

      <Card className="shadow-sm border-primary/20">
        <CardHeader className="pb-3 border-b border-primary/10">
          <CardTitle className="text-base flex items-center gap-2 text-primary">
            <Sparkles className="h-4 w-4" /> Start a batch
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-4">
          <div className="flex flex-wrap gap-2">
            {ENTITY_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const active = entityType === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => setEntityType(opt.value)}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-secondary/80 hover:text-foreground"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {opt.label}
                </button>
              );
            })}
          </div>
          <Button onClick={handleStart} disabled={start.isPending} className="gap-1">
            <Sparkles className="h-3.5 w-3.5" />
            {start.isPending ? "Starting…" : "Analyze all"}
          </Button>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="pb-3 border-b border-border">
          <CardTitle className="text-base">Recent batch jobs</CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading jobs…</p>
          ) : jobs.length === 0 ? (
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>No batch jobs yet. Start one above to analyze all records of an entity type.</span>
            </div>
          ) : (
            jobs.map((job) => <JobRow key={job.id} job={job} />)
          )}
        </CardContent>
      </Card>
    </div>
  );
}
