import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useGetAiSettings,
  useUpdateAiSettings,
  useGetAiUsage,
  useGetAiHealth,
  getGetAiSettingsQueryKey,
  getGetAiUsageQueryKey,
  getGetAiHealthQueryKey,
  type AiSettingsResponse,
  type UpdateAiSettings,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format, parseISO, subDays } from "date-fns";
import { Sparkles, Activity, DollarSign, Cpu, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";

type FeatureKey = "card_extraction" | "lead_scoring" | "contact_enrichment" | "assignee_recommendation";

const FEATURE_LABELS: Record<FeatureKey, { title: string; desc: string }> = {
  card_extraction: { title: "Card Extraction (OCR)", desc: "Read business-card images into structured contact fields." },
  lead_scoring: { title: "Lead Scoring", desc: "Score and temperature-rate new leads automatically." },
  contact_enrichment: { title: "Contact Enrichment", desc: "Infer industry, seniority and talking points for a contact." },
  assignee_recommendation: { title: "Assignee Recommendation", desc: "Suggest the best owner for an incoming lead." },
};

const FEATURE_ORDER: FeatureKey[] = ["card_extraction", "lead_scoring", "contact_enrichment", "assignee_recommendation"];

type RuleKey =
  | "stalledDays"
  | "stalledHighDays"
  | "agingDays"
  | "unansweredDays"
  | "expiringTaskDays"
  | "highValueThreshold"
  | "followupOverdueCriticalDays";

const RULE_FIELDS: Array<{ key: RuleKey; label: string; desc: string; min: number; max: number }> = [
  { key: "stalledDays", label: "Stalled lead (days)", desc: "Open lead with no update for this many days is flagged as stalled.", min: 1, max: 365 },
  { key: "stalledHighDays", label: "Severely stalled (days)", desc: "Stalled leads older than this escalate to high risk.", min: 1, max: 365 },
  { key: "agingDays", label: "Aging lead (days)", desc: "Open lead older than this without closing is flagged as aging.", min: 1, max: 365 },
  { key: "unansweredDays", label: "Unanswered activity (days)", desc: "Last activity older than this counts as unanswered communication.", min: 1, max: 365 },
  { key: "expiringTaskDays", label: "Task due-soon window (days)", desc: "Open tasks due within this many days are flagged as expiring.", min: 0, max: 365 },
  { key: "highValueThreshold", label: "High-value lead threshold", desc: "Leads at or above this value get escalated risk priority.", min: 0, max: 1_000_000_000 },
  { key: "followupOverdueCriticalDays", label: "Critical overdue follow-up (days)", desc: "Follow-ups overdue by this many days become critical.", min: 1, max: 365 },
];

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const NUM = new Intl.NumberFormat("en-US");

function formatUsd(n: number): string {
  return USD.format(n);
}

const DATE_PRESETS = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

function StatCard({ title, value, icon: Icon, hint }: { title: string; value: string; icon: React.ElementType; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{title}</span>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="mt-2 text-2xl font-bold tracking-tight">{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

interface SettingsFormProps {
  settings: AiSettingsResponse;
  canEdit: boolean;
}

function SettingsForm({ settings, canEdit }: SettingsFormProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdateAiSettings();

  const [enabled, setEnabled] = React.useState(settings.enabled);
  const [provider, setProvider] = React.useState(settings.provider);
  const [model, setModel] = React.useState(settings.model);
  const [flags, setFlags] = React.useState<Record<FeatureKey, boolean>>({
    card_extraction: settings.featureFlags.card_extraction,
    lead_scoring: settings.featureFlags.lead_scoring,
    contact_enrichment: settings.featureFlags.contact_enrichment,
    assignee_recommendation: settings.featureFlags.assignee_recommendation,
  });
  const [tokenBudget, setTokenBudget] = React.useState<string>(
    settings.monthlyTokenBudget == null ? "" : String(settings.monthlyTokenBudget),
  );
  const [costBudget, setCostBudget] = React.useState<string>(
    settings.monthlyCostBudgetUsd == null ? "" : String(settings.monthlyCostBudgetUsd),
  );
  const [rules, setRules] = React.useState<Record<RuleKey, string>>(() =>
    Object.fromEntries(RULE_FIELDS.map((f) => [f.key, String(settings.workflowRules[f.key])])) as Record<RuleKey, string>,
  );

  const ruleError = (f: (typeof RULE_FIELDS)[number]): string | null => {
    const raw = rules[f.key].trim();
    if (raw === "") return "Required";
    const n = Number(raw);
    if (!Number.isInteger(n)) return "Must be a whole number";
    if (n < f.min || n > f.max) return `Must be ${f.min}–${NUM.format(f.max)}`;
    return null;
  };
  const rulesInvalid = RULE_FIELDS.some((f) => ruleError(f) !== null);

  const handleSave = () => {
    // Send only the rules that changed from the current effective values (server merges
    // partial overrides over the effective rules; omit = unchanged).
    const changedRules: Partial<Record<RuleKey, number>> = {};
    for (const f of RULE_FIELDS) {
      const n = Number(rules[f.key].trim());
      if (n !== settings.workflowRules[f.key]) changedRules[f.key] = n;
    }
    const body: UpdateAiSettings = {
      enabled,
      provider,
      model: model.trim(),
      featureFlags: flags,
      monthlyTokenBudget: tokenBudget.trim() === "" ? null : Number(tokenBudget),
      monthlyCostBudgetUsd: costBudget.trim() === "" ? null : Number(costBudget),
      ...(Object.keys(changedRules).length > 0 ? { workflowRules: changedRules } : {}),
    };
    update.mutate(
      { data: body },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetAiSettingsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetAiHealthQueryKey() });
          toast({ title: "AI settings saved" });
        },
        onError: (err: unknown) => {
          const message = err instanceof Error ? err.message : "Could not save AI settings";
          toast({ title: "Save failed", description: message, variant: "destructive" });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              AI Configuration
            </CardTitle>
            <CardDescription className="mt-1">
              {canEdit
                ? "Control which AI features run for your organization and cap monthly spend."
                : "Only a primary admin can change these settings."}
            </CardDescription>
          </div>
          {!settings.hasCustomSettings && <Badge variant="secondary">Defaults</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Master toggle */}
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div>
            <div className="font-medium">AI Features</div>
            <div className="text-sm text-muted-foreground">Master switch for all AI processing in this tenant.</div>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!canEdit} />
        </div>

        {/* Provider + model */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Provider</Label>
            <Select value={provider} onValueChange={setProvider} disabled={!canEdit}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {settings.availableProviders.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-model">Model</Label>
            <Input id="ai-model" value={model} onChange={(e) => setModel(e.target.value)} disabled={!canEdit} />
          </div>
        </div>

        {/* Feature flags */}
        <div className="space-y-3">
          <div className="text-sm font-medium">Per-feature controls</div>
          <div className="space-y-2">
            {FEATURE_ORDER.map((key) => (
              <div key={key} className="flex items-center justify-between gap-4 rounded-lg border p-3">
                <div className="min-w-0">
                  <div className="font-medium">{FEATURE_LABELS[key].title}</div>
                  <div className="text-sm text-muted-foreground">{FEATURE_LABELS[key].desc}</div>
                </div>
                <Switch
                  checked={flags[key]}
                  onCheckedChange={(v) => setFlags((f) => ({ ...f, [key]: v }))}
                  disabled={!canEdit || !enabled}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Budgets */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="token-budget">Monthly token budget</Label>
            <Input
              id="token-budget"
              type="number"
              min={0}
              placeholder="Unlimited"
              value={tokenBudget}
              onChange={(e) => setTokenBudget(e.target.value)}
              disabled={!canEdit}
            />
            <p className="text-xs text-muted-foreground">Leave blank for unlimited.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cost-budget">Monthly cost budget (USD)</Label>
            <Input
              id="cost-budget"
              type="number"
              min={0}
              step="0.01"
              placeholder="Unlimited"
              value={costBudget}
              onChange={(e) => setCostBudget(e.target.value)}
              disabled={!canEdit}
            />
            <p className="text-xs text-muted-foreground">Estimated spend cap. Leave blank for unlimited.</p>
          </div>
        </div>

        {/* Workflow intelligence rules (Stage 5F) */}
        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium">Workflow risk thresholds</div>
            <p className="text-xs text-muted-foreground">
              Tune when the AI workflow engine flags leads, tasks and follow-ups as at risk. Applies to SLA risks, health scores, bottlenecks and alerts.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {RULE_FIELDS.map((f) => {
              const err = ruleError(f);
              return (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={`rule-${f.key}`}>{f.label}</Label>
                  <Input
                    id={`rule-${f.key}`}
                    type="number"
                    min={f.min}
                    max={f.max}
                    value={rules[f.key]}
                    onChange={(e) => setRules((r) => ({ ...r, [f.key]: e.target.value }))}
                    disabled={!canEdit}
                    aria-invalid={err !== null}
                  />
                  <p className={`text-xs ${err ? "text-destructive" : "text-muted-foreground"}`}>{err ?? f.desc}</p>
                </div>
              );
            })}
          </div>
        </div>

        {canEdit && (
          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={update.isPending || rulesInvalid}>
              {update.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HealthCard({ from, to }: { from: string; to: string }) {
  const { data: health, isLoading } = useGetAiHealth({ query: { queryKey: getGetAiHealthQueryKey() } });

  if (isLoading || !health) {
    return <Skeleton className="h-40 w-full" />;
  }

  const statusMap: Record<string, { label: string; icon: React.ElementType; color: string }> = {
    healthy: { label: "Healthy", icon: CheckCircle2, color: "text-emerald-600" },
    degraded: { label: "Degraded", icon: AlertTriangle, color: "text-amber-600" },
    unconfigured: { label: "Not configured", icon: XCircle, color: "text-rose-600" },
    down: { label: "Down", icon: XCircle, color: "text-rose-600" },
  };
  const s = statusMap[health.status] ?? { label: health.status, icon: Activity, color: "text-muted-foreground" };
  const StatusIcon = s.icon;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="h-5 w-5 text-primary" />
          Provider Health
        </CardTitle>
        <CardDescription>
          {health.provider} · {health.model}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <StatusIcon className={`h-5 w-5 ${s.color}`} />
          <span className={`font-medium ${s.color}`}>{s.label}</span>
          {!health.configured && <Badge variant="destructive">API key missing</Badge>}
          {!health.pricingAvailable && <Badge variant="secondary">Pricing unavailable</Badge>}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted-foreground">Requests (24h)</div>
            <div className="text-lg font-semibold">{NUM.format(health.last24h.requests)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Errors (24h)</div>
            <div className="text-lg font-semibold">{NUM.format(health.last24h.errors)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Failure rate</div>
            <div className="text-lg font-semibold">{Math.round(health.last24h.failureRate * 100)}%</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Avg latency</div>
            <div className="text-lg font-semibold">{NUM.format(health.last24h.avgLatencyMs)} ms</div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Usage window: {from} → {to}</p>
      </CardContent>
    </Card>
  );
}

function UsageSection({ from, to }: { from: string; to: string }) {
  const params = { from, to };
  const { data: usage, isLoading } = useGetAiUsage(params, { query: { queryKey: getGetAiUsageQueryKey(params) } });

  if (isLoading || !usage) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const t = usage.totals;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Requests" value={NUM.format(t.requests)} icon={Activity} hint={`${NUM.format(t.success)} ok · ${NUM.format(t.errors)} errors`} />
        <StatCard title="Est. Cost" value={formatUsd(t.costUsd)} icon={DollarSign} />
        <StatCard title="Total Tokens" value={NUM.format(t.totalTokens)} icon={Cpu} hint={`${NUM.format(t.inputTokens)} in · ${NUM.format(t.outputTokens)} out`} />
        <StatCard title="Failure Rate" value={`${Math.round(t.failureRate * 100)}%`} icon={AlertTriangle} hint={`avg ${NUM.format(t.avgLatencyMs)} ms`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Usage by Feature</CardTitle>
        </CardHeader>
        <CardContent>
          {usage.byFeature.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">No AI activity in this range.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Feature</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Est. Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage.byFeature.map((f) => (
                  <TableRow key={f.feature}>
                    <TableCell className="font-medium">
                      {FEATURE_LABELS[f.feature as FeatureKey]?.title ?? f.feature}
                    </TableCell>
                    <TableCell className="text-right">{NUM.format(f.requests)}</TableCell>
                    <TableCell className="text-right">{NUM.format(f.errors)}</TableCell>
                    <TableCell className="text-right">{NUM.format(f.totalTokens)}</TableCell>
                    <TableCell className="text-right">{formatUsd(f.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Invocations</CardTitle>
        </CardHeader>
        <CardContent>
          {usage.recent.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">No recent invocations.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Feature</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead className="text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage.recent.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{FEATURE_LABELS[r.feature as FeatureKey]?.title ?? r.feature}</TableCell>
                    <TableCell>
                      <Badge variant={r.status === "success" ? "secondary" : "destructive"}>{r.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">{NUM.format(r.totalTokens)}</TableCell>
                    <TableCell className="text-right">{formatUsd(r.costUsd)}</TableCell>
                    <TableCell className="text-right">{NUM.format(r.latencyMs)} ms</TableCell>
                    <TableCell className="text-right whitespace-nowrap">{format(parseISO(r.createdAt), "MMM d, HH:mm")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function AdminAiSettings() {
  const { user } = useAuth();
  const canEdit = user?.role === "primary_admin";
  const [rangeDays, setRangeDays] = React.useState(30);

  const to = format(new Date(), "yyyy-MM-dd");
  const from = format(subDays(new Date(), rangeDays - 1), "yyyy-MM-dd");

  const { data: settings, isLoading, isError } = useGetAiSettings({ query: { queryKey: getGetAiSettingsQueryKey() } });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">AI Intelligence</h1>
          <p className="mt-1 text-sm text-muted-foreground">Configure AI features, monitor usage and estimated cost.</p>
        </div>
        <Select value={String(rangeDays)} onValueChange={(v) => setRangeDays(parseInt(v))}>
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATE_PRESETS.map((p) => (
              <SelectItem key={p.days} value={String(p.days)}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isError ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">Could not load AI settings.</CardContent>
        </Card>
      ) : isLoading || !settings ? (
        <div className="space-y-4">
          <Skeleton className="h-96 w-full" />
        </div>
      ) : (
        <SettingsForm settings={settings} canEdit={canEdit} />
      )}

      <HealthCard from={from} to={to} />
      <UsageSection from={from} to={to} />
    </div>
  );
}
