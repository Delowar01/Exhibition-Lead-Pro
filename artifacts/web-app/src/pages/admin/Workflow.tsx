import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  useGetAiWorkflowHealth,
  useGetAiWorkflowSlaRisks,
  useGetAiWorkflowBottlenecks,
  useSimulateAiWorkflowScenario,
  getGetAiWorkflowHealthQueryKey,
  getGetAiWorkflowSlaRisksQueryKey,
  getGetAiWorkflowBottlenecksQueryKey,
  type WorkflowSlaRisk,
  type WorkflowBottleneck,
  type WorkflowSimulateResponse,
  type WorkflowWorkloadEntry,
} from "@workspace/api-client-react";
import {
  Workflow,
  Activity,
  AlertTriangle,
  Gauge,
  Users,
  TrendingUp,
  ShieldAlert,
  FlaskConical,
} from "lucide-react";

const RISK_TONE: Record<string, string> = {
  critical: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300 border-rose-300/50",
  high: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 border-amber-300/50",
  medium: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300 border-sky-300/50",
  low: "bg-muted text-muted-foreground",
};

const GRADE_TONE: Record<string, string> = {
  excellent: "text-emerald-600",
  good: "text-sky-600",
  fair: "text-amber-600",
  poor: "text-rose-600",
};

function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function StatTile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className={`text-2xl font-bold tracking-tight ${tone ?? ""}`}>{value}</div>
      <div className="text-[11px] uppercase tracking-widest text-muted-foreground mt-1">{label}</div>
    </div>
  );
}

function RiskRow({ risk }: { risk: WorkflowSlaRisk }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full border shrink-0 ${RISK_TONE[risk.riskLevel] ?? RISK_TONE.low}`}>
        {risk.riskLevel}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{risk.title}</span>
          <Badge variant="outline" className="text-[10px] capitalize">{humanize(risk.category)}</Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{risk.detail}</p>
        {risk.recommendedAction && (
          <p className="text-xs text-primary mt-0.5">→ {risk.recommendedAction}</p>
        )}
      </div>
      {risk.ageDays !== null && risk.ageDays !== undefined && (
        <span className="text-xs text-muted-foreground whitespace-nowrap">{risk.ageDays}d</span>
      )}
    </div>
  );
}

function BottleneckRow({ b }: { b: WorkflowBottleneck }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full border shrink-0 ${RISK_TONE[b.severity] ?? RISK_TONE.low}`}>
        {b.severity}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{b.title}</span>
          <Badge variant="outline" className="text-[10px] capitalize">{humanize(b.type)}</Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{b.detail}</p>
        {b.recommendedAction && <p className="text-xs text-primary mt-0.5">→ {b.recommendedAction}</p>}
      </div>
      <span className="text-sm font-semibold whitespace-nowrap">{b.metric}</span>
    </div>
  );
}

function SimulationTool({ candidates }: { candidates: WorkflowWorkloadEntry[] }) {
  const [leadId, setLeadId] = React.useState("");
  const [scenario, setScenario] = React.useState("follow_up");
  const [delayDays, setDelayDays] = React.useState("3");
  const [candidateUserId, setCandidateUserId] = React.useState("");
  const [result, setResult] = React.useState<WorkflowSimulateResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const simulate = useSimulateAiWorkflowScenario();

  const run = () => {
    const id = parseInt(leadId);
    if (!Number.isFinite(id) || id <= 0) {
      setError("Enter a valid lead ID.");
      return;
    }
    const body: { leadId: number; scenario: string; delayDays?: number; candidateUserId?: number } = {
      leadId: id,
      scenario,
    };
    if (scenario === "delay") body.delayDays = parseInt(delayDays) || 1;
    if (scenario === "reassign") {
      const cid = parseInt(candidateUserId);
      if (!Number.isFinite(cid) || cid <= 0) {
        setError("Choose an owner to reassign to.");
        return;
      }
      body.candidateUserId = cid;
    }
    setError(null);
    simulate.mutate(
      { data: body },
      {
        onSuccess: (data) => setResult(data as WorkflowSimulateResponse),
        onError: () => setError("Could not simulate — check the lead ID is in your workspace."),
      },
    );
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-primary" /> Scenario Simulation
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Preview the predicted outcome of an action. This is a read-only estimate — nothing is written to the CRM.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Lead ID</label>
            <Input value={leadId} onChange={(e) => setLeadId(e.target.value)} placeholder="e.g. 1" className="w-[110px]" />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Scenario</label>
            <Select value={scenario} onValueChange={setScenario}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="follow_up">Schedule follow-up</SelectItem>
                <SelectItem value="reassign">Reassign owner</SelectItem>
                <SelectItem value="delay">Delay</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {scenario === "delay" && (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Delay (days)</label>
              <Input value={delayDays} onChange={(e) => setDelayDays(e.target.value)} className="w-[90px]" />
            </div>
          )}
          {scenario === "reassign" && (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Reassign to</label>
              <Select value={candidateUserId} onValueChange={setCandidateUserId}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder={candidates.length === 0 ? "No eligible owners" : "Choose owner"} />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((c) => (
                    <SelectItem key={c.userId} value={String(c.userId)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <Button size="sm" onClick={run} disabled={simulate.isPending} className="gap-1">
            <TrendingUp className="h-3.5 w-3.5" /> {simulate.isPending ? "Simulating..." : "Simulate"}
          </Button>
        </div>

        {error && <p className="text-sm text-rose-600">{error}</p>}

        {result && (
          <div className="rounded-lg border border-border bg-secondary/20 p-4 space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Baseline</div>
                <div className="text-xl font-bold">{result.baseline.winProbability}%</div>
                <Badge variant="outline" className={`text-[10px] capitalize mt-1 ${RISK_TONE[result.baseline.riskLevel] ?? ""}`}>
                  {result.baseline.riskLevel} risk
                </Badge>
                <p className="text-xs text-muted-foreground mt-1">{result.baseline.note}</p>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-widest text-muted-foreground">Predicted</div>
                <div className="text-xl font-bold text-primary">
                  {result.predicted.winProbability}%
                  <span className={`text-sm ml-2 ${result.deltas.winProbability >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {result.deltas.winProbability >= 0 ? "+" : ""}
                    {result.deltas.winProbability}
                  </span>
                </div>
                <Badge variant="outline" className={`text-[10px] capitalize mt-1 ${RISK_TONE[result.predicted.riskLevel] ?? ""}`}>
                  {result.predicted.riskLevel} risk
                </Badge>
                <p className="text-xs text-muted-foreground mt-1">{result.predicted.note}</p>
              </div>
            </div>
            <p className="text-sm">{result.explanation}</p>
            {result.assumptions.length > 0 && (
              <ul className="space-y-1">
                {result.assumptions.map((a, i) => (
                  <li key={i} className="text-xs text-muted-foreground flex items-start gap-2">
                    <div className="w-1 h-1 rounded-full bg-muted-foreground mt-1.5 shrink-0" /> {a}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-muted-foreground">Estimate confidence: {result.confidence}%</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminWorkflow() {
  const healthQuery = useGetAiWorkflowHealth(undefined, { query: { queryKey: getGetAiWorkflowHealthQueryKey() } });
  const risksQuery = useGetAiWorkflowSlaRisks(undefined, { query: { queryKey: getGetAiWorkflowSlaRisksQueryKey() } });
  const bottlenecksQuery = useGetAiWorkflowBottlenecks(undefined, {
    query: { queryKey: getGetAiWorkflowBottlenecksQueryKey() },
  });

  const health = healthQuery.data;
  const risks = risksQuery.data;
  const bottlenecks = bottlenecksQuery.data;

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center gap-2">
        <Workflow className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Workflow Intelligence</h1>
          <p className="text-sm text-muted-foreground">
            Operational health, SLA risk alerts, pipeline bottlenecks, and scenario simulation across your workspace.
          </p>
        </div>
      </div>

      {/* Health dashboard */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Gauge className="h-4 w-4 text-primary" /> Operational Health
            {health && <span className="text-xs font-normal text-muted-foreground">· {health.scope.name}</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {healthQuery.isLoading || !health ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
                <StatTile
                  label={`Health · ${health.grade}`}
                  value={health.healthScore}
                  tone={GRADE_TONE[health.grade] ?? ""}
                />
                <StatTile label="SLA Compliance" value={`${health.slaCompliance}%`} />
                <StatTile label="At-Risk Items" value={health.totals.atRiskItems ?? 0} tone="text-rose-600" />
                <StatTile label="Tracked Items" value={health.totals.trackedItems ?? 0} />
              </div>
              <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
                {Object.entries(health.totals)
                  .filter(([k]) => k !== "atRiskItems" && k !== "trackedItems")
                  .map(([k, v]) => (
                    <div key={k} className="rounded-md border border-border bg-secondary/20 p-2.5">
                      <div className="text-lg font-semibold">{v}</div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{humanize(k)}</div>
                    </div>
                  ))}
              </div>

              {health.recommendedActions.length > 0 && (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-primary mb-1.5">
                    <Activity className="h-3.5 w-3.5" /> Recommended actions
                  </div>
                  <ul className="space-y-1">
                    {health.recommendedActions.map((a, i) => (
                      <li key={i} className="text-sm flex items-start gap-2">
                        <div className="w-1 h-1 rounded-full bg-primary mt-2 shrink-0" /> {a}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {health.workload.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground mb-1.5">
                    <Users className="h-3.5 w-3.5" /> Team workload
                  </div>
                  <div className="space-y-2">
                    {health.workload.map((w) => (
                      <div key={w.userId} className="flex items-center justify-between text-sm">
                        <span className="font-medium">{w.name}</span>
                        <span className="text-muted-foreground">
                          {w.openLeads} open · {w.overdueItems} overdue
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* SLA risk alerts */}
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" /> SLA Risk Alerts
              {risks && <span className="text-xs font-normal text-muted-foreground">· {risks.total}</span>}
            </CardTitle>
            {risks && (
              <div className="flex flex-wrap gap-2 pt-1">
                {(["critical", "high", "medium", "low"] as const).map((lvl) =>
                  (risks.counts[lvl] ?? 0) > 0 ? (
                    <span key={lvl} className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full border ${RISK_TONE[lvl]}`}>
                      {risks.counts[lvl]} {lvl}
                    </span>
                  ) : null,
                )}
              </div>
            )}
          </CardHeader>
          <CardContent className="divide-y divide-border">
            {risksQuery.isLoading ? (
              <p className="text-sm text-muted-foreground py-4">Loading…</p>
            ) : !risks || risks.risks.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No SLA risks detected. 🎉</p>
            ) : (
              risks.risks.slice(0, 25).map((r) => <RiskRow key={`${r.entityType}-${r.entityId}-${r.category}`} risk={r} />)
            )}
          </CardContent>
        </Card>

        {/* Bottlenecks */}
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-rose-600" /> Workflow Bottlenecks
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            {bottlenecksQuery.isLoading ? (
              <p className="text-sm text-muted-foreground py-4">Loading…</p>
            ) : !bottlenecks || bottlenecks.bottlenecks.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No bottlenecks detected.</p>
            ) : (
              bottlenecks.bottlenecks.map((b, i) => <BottleneckRow key={`${b.type}-${i}`} b={b} />)
            )}
          </CardContent>
        </Card>
      </div>

      <SimulationTool candidates={health?.workload ?? []} />
    </div>
  );
}
