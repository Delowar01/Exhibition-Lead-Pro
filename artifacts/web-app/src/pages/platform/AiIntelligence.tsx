import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  useGetAiPlatformUsage,
  getGetAiPlatformUsageQueryKey,
  type GetAiPlatformUsageParams,
} from "@workspace/api-client-react";
import { format, subDays } from "date-fns";
import {
  Activity,
  DollarSign,
  Cpu,
  AlertTriangle,
  ShieldCheck,
  Gauge,
  Filter,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

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

// All server-side AI features (mirrors the API's feature registry).
const AI_FEATURES = [
  "card_extraction",
  "lead_scoring",
  "contact_enrichment",
  "assignee_recommendation",
  "lead_intelligence",
  "company_intelligence",
  "contact_intelligence",
  "smart_classification",
  "opportunity_potential",
  "email_composer",
  "whatsapp_composer",
  "call_preparation",
  "meeting_preparation",
  "proposal_assistant",
  "followup_suggestions",
  "sales_coaching",
  "conversation_summary",
  "workflow_next_action",
  "workflow_routing",
  "workflow_progression",
  "workflow_reminder",
  "workflow_task",
  "executive_summary",
  "executive_forecast",
  "assistant_answer",
];

function featureLabel(f: string): string {
  return f
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const CATEGORY_LABELS: Record<string, string> = {
  timeout: "Timeout",
  provider_rate_limited: "Provider rate-limited",
  provider_unavailable: "Provider unavailable",
  invalid_response: "Invalid response",
  network: "Network",
  other: "Other",
};

function StatCard({ title, value, icon: Icon, hint, testId }: { title: string; value: string; icon: React.ElementType; hint?: string; testId?: string }) {
  return (
    <Card data-testid={testId}>
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

export default function PlatformAiIntelligence() {
  const [rangeDays, setRangeDays] = React.useState(30);
  const [feature, setFeature] = React.useState<string>("all");
  const [modelDraft, setModelDraft] = React.useState("");
  const [model, setModel] = React.useState("");
  const [companyId, setCompanyId] = React.useState<number | null>(null);
  const [companyName, setCompanyName] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);
  const pageSize = 25;

  const to = format(new Date(), "yyyy-MM-dd");
  const from = format(subDays(new Date(), rangeDays - 1), "yyyy-MM-dd");

  const params: GetAiPlatformUsageParams = { from, to, page, pageSize };
  if (feature !== "all") params.feature = feature;
  if (model) params.model = model;
  if (companyId != null) params.companyId = companyId;

  const { data, isLoading, isError } = useGetAiPlatformUsage(params, {
    query: { queryKey: getGetAiPlatformUsageQueryKey(params) },
  });

  const resetPage = () => setPage(1);

  const totalPages = data ? Math.max(1, Math.ceil(data.byCompany.total / data.byCompany.pageSize)) : 1;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">AI Intelligence</h1>
          <p className="mt-1 text-sm text-muted-foreground">Platform-wide AI usage and estimated cost across all tenants. Aggregates only — no prompt or response content.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={feature}
            onValueChange={(v) => {
              setFeature(v);
              resetPage();
            }}
          >
            <SelectTrigger className="w-[210px]" data-testid="select-platform-feature">
              <SelectValue placeholder="All features" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All features</SelectItem>
              {AI_FEATURES.map((f) => (
                <SelectItem key={f} value={f}>
                  {featureLabel(f)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="w-[180px]"
            placeholder="Model (e.g. gemini-…)"
            value={modelDraft}
            data-testid="input-platform-model"
            onChange={(e) => setModelDraft(e.target.value)}
            onBlur={() => {
              setModel(modelDraft.trim());
              resetPage();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setModel(modelDraft.trim());
                resetPage();
              }
            }}
          />
          <Select value={String(rangeDays)} onValueChange={(v) => { setRangeDays(parseInt(v)); resetPage(); }}>
            <SelectTrigger className="w-[150px]" data-testid="select-platform-range">
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
      </div>

      {companyId != null && (
        <Badge variant="secondary" className="gap-1" data-testid="badge-company-filter">
          <Filter className="h-3 w-3" />
          {companyName ?? `Company #${companyId}`}
          <button
            className="ml-1"
            aria-label="Clear company filter"
            data-testid="button-clear-company-filter"
            onClick={() => {
              setCompanyId(null);
              setCompanyName(null);
              resetPage();
            }}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      )}

      {isError ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">Could not load platform AI usage.</CardContent>
        </Card>
      ) : isLoading || !data ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <StatCard
              title="Requests"
              value={NUM.format(data.totals.requests)}
              icon={Activity}
              hint={`${NUM.format(data.totals.success)} ok · ${NUM.format(data.totals.errors)} errors`}
              testId="stat-requests"
            />
            <StatCard title="Est. Cost" value={formatUsd(data.totals.costUsd)} icon={DollarSign} testId="stat-cost" />
            <StatCard
              title="Total Tokens"
              value={NUM.format(data.totals.totalTokens)}
              icon={Cpu}
              hint={`${NUM.format(data.totals.inputTokens)} in · ${NUM.format(data.totals.outputTokens)} out${data.totals.estimatedRows > 0 ? ` · ${NUM.format(data.totals.estimatedRows)} estimated` : ""}`}
              testId="stat-tokens"
            />
            <StatCard
              title="Failure Rate"
              value={`${Math.round(data.totals.failureRate * 100)}%`}
              icon={AlertTriangle}
              hint={`avg ${NUM.format(data.totals.avgLatencyMs)} ms`}
              testId="stat-failure"
            />
            <StatCard
              title="Saved Calls"
              value={NUM.format(data.totals.cacheHits + data.totals.dedupReused)}
              icon={ShieldCheck}
              hint={`${NUM.format(data.totals.cacheHits)} cached · ${NUM.format(data.totals.dedupReused)} deduped`}
              testId="stat-saved"
            />
            <StatCard
              title="Denied"
              value={NUM.format(data.totals.budgetDenied + data.totals.rateLimited)}
              icon={Gauge}
              hint={`${NUM.format(data.totals.budgetDenied)} budget · ${NUM.format(data.totals.rateLimited)} rate limit`}
              testId="stat-denied"
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Daily Requests</CardTitle>
              <CardDescription>Provider calls per UTC day. Hover for tokens and estimated cost.</CardDescription>
            </CardHeader>
            <CardContent>
              {data.byDay.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">No AI activity in this range.</div>
              ) : (
                <div className="h-56 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.byDay} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={(d: string) => d.slice(5)} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={40} />
                      <Tooltip
                        formatter={(value: number, name: string) => [NUM.format(value), name]}
                        labelFormatter={(d) => String(d)}
                        content={({ active, payload, label }) => {
                          if (!active || !payload?.length) return null;
                          const row = payload[0].payload as (typeof data.byDay)[number];
                          return (
                            <div className="rounded-md border bg-popover p-2 text-xs shadow-md">
                              <div className="font-medium">{label}</div>
                              <div>{NUM.format(row.requests)} requests · {NUM.format(row.errors)} errors</div>
                              <div>{NUM.format(row.totalTokens)} tokens · {formatUsd(row.costUsd)}</div>
                            </div>
                          );
                        }}
                      />
                      <Bar dataKey="requests" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          {data.tenantsNearLimit.length > 0 && (
            <Card data-testid="card-near-limit">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                  Tenants Near Budget Limit
                </CardTitle>
                <CardDescription>Month-to-date usage at or above the approaching-budget threshold.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Company</TableHead>
                      <TableHead className="text-right">% Used</TableHead>
                      <TableHead className="text-right">Tokens Used</TableHead>
                      <TableHead className="text-right">Token Budget</TableHead>
                      <TableHead className="text-right">Cost Used</TableHead>
                      <TableHead className="text-right">Cost Budget</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.tenantsNearLimit.map((t) => (
                      <TableRow key={t.companyId}>
                        <TableCell className="font-medium">{t.companyName ?? `Company #${t.companyId}`}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant={t.pctUsed >= 100 ? "destructive" : "secondary"}>{t.pctUsed}%</Badge>
                        </TableCell>
                        <TableCell className="text-right">{NUM.format(t.usedTokens)}</TableCell>
                        <TableCell className="text-right">{t.tokenBudget == null ? "—" : NUM.format(t.tokenBudget)}</TableCell>
                        <TableCell className="text-right">{formatUsd(t.usedCostUsd)}</TableCell>
                        <TableCell className="text-right">{t.costBudgetUsd == null ? "—" : formatUsd(t.costBudgetUsd)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Usage by Company</CardTitle>
              <CardDescription>
                {NUM.format(data.byCompany.total)} compan{data.byCompany.total === 1 ? "y" : "ies"} in range · ordered by estimated cost
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.byCompany.items.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">No AI activity in this range.</div>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Company</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead className="text-right">Errors</TableHead>
                        <TableHead className="text-right">Denied</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                        <TableHead className="text-right">Est. Cost</TableHead>
                        <TableHead className="w-10" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.byCompany.items.map((c) => (
                        <TableRow key={c.companyId ?? "unknown"}>
                          <TableCell className="font-medium">{c.companyName ?? "Unknown"}</TableCell>
                          <TableCell className="text-right">{NUM.format(c.requests)}</TableCell>
                          <TableCell className="text-right">{NUM.format(c.errors)}</TableCell>
                          <TableCell className="text-right">{NUM.format(c.budgetDenied + c.rateLimited)}</TableCell>
                          <TableCell className="text-right">{NUM.format(c.totalTokens)}</TableCell>
                          <TableCell className="text-right">{formatUsd(c.costUsd)}</TableCell>
                          <TableCell>
                            {c.companyId != null && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                aria-label={`Filter by ${c.companyName ?? c.companyId}`}
                                data-testid={`button-filter-company-${c.companyId}`}
                                onClick={() => {
                                  setCompanyId(c.companyId!);
                                  setCompanyName(c.companyName ?? null);
                                  resetPage();
                                }}
                              >
                                <Filter className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {totalPages > 1 && (
                    <div className="mt-3 flex items-center justify-end gap-2 text-sm text-muted-foreground">
                      <span data-testid="text-company-page">
                        Page {data.byCompany.page} of {totalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        disabled={page <= 1}
                        data-testid="button-company-prev"
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        disabled={page >= totalPages}
                        data-testid="button-company-next"
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Usage by Feature</CardTitle>
              </CardHeader>
              <CardContent>
                {data.byFeature.length === 0 ? (
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
                      {data.byFeature.map((f) => (
                        <TableRow key={f.feature}>
                          <TableCell className="font-medium">{featureLabel(f.feature)}</TableCell>
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

            <Card data-testid="card-failure-categories">
              <CardHeader>
                <CardTitle>Failure Categories</CardTitle>
                <CardDescription>Failed provider calls by category (no message content).</CardDescription>
              </CardHeader>
              <CardContent>
                {data.failureCategories.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">No failures in this range.</div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Category</TableHead>
                        <TableHead className="text-right">Count</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.failureCategories.map((f) => (
                        <TableRow key={f.category}>
                          <TableCell className="font-medium">{CATEGORY_LABELS[f.category] ?? f.category}</TableCell>
                          <TableCell className="text-right">{NUM.format(f.count)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
