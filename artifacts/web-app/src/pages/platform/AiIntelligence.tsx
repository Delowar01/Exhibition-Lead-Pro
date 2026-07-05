import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  useGetAiPlatformUsage,
  getGetAiPlatformUsageQueryKey,
} from "@workspace/api-client-react";
import { format, subDays } from "date-fns";
import { Activity, DollarSign, Cpu, AlertTriangle } from "lucide-react";

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

const FEATURE_LABELS: Record<string, string> = {
  card_extraction: "Card Extraction",
  lead_scoring: "Lead Scoring",
  contact_enrichment: "Contact Enrichment",
  assignee_recommendation: "Assignee Recommendation",
};

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

export default function PlatformAiIntelligence() {
  const [rangeDays, setRangeDays] = React.useState(30);
  const to = format(new Date(), "yyyy-MM-dd");
  const from = format(subDays(new Date(), rangeDays - 1), "yyyy-MM-dd");

  const params = { from, to };
  const { data, isLoading, isError } = useGetAiPlatformUsage(params, {
    query: { queryKey: getGetAiPlatformUsageQueryKey(params) },
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">AI Intelligence</h1>
          <p className="mt-1 text-sm text-muted-foreground">Platform-wide AI usage and estimated cost across all tenants.</p>
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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title="Requests"
              value={NUM.format(data.totals.requests)}
              icon={Activity}
              hint={`${NUM.format(data.totals.success)} ok · ${NUM.format(data.totals.errors)} errors`}
            />
            <StatCard title="Est. Cost" value={formatUsd(data.totals.costUsd)} icon={DollarSign} />
            <StatCard
              title="Total Tokens"
              value={NUM.format(data.totals.totalTokens)}
              icon={Cpu}
              hint={`${NUM.format(data.totals.inputTokens)} in · ${NUM.format(data.totals.outputTokens)} out`}
            />
            <StatCard
              title="Failure Rate"
              value={`${Math.round(data.totals.failureRate * 100)}%`}
              icon={AlertTriangle}
              hint={`avg ${NUM.format(data.totals.avgLatencyMs)} ms`}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Usage by Company</CardTitle>
            </CardHeader>
            <CardContent>
              {data.byCompany.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">No AI activity in this range.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Company</TableHead>
                      <TableHead className="text-right">Requests</TableHead>
                      <TableHead className="text-right">Errors</TableHead>
                      <TableHead className="text-right">Tokens</TableHead>
                      <TableHead className="text-right">Est. Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.byCompany.map((c) => (
                      <TableRow key={c.companyId ?? "unknown"}>
                        <TableCell className="font-medium">{c.companyName ?? "Unknown"}</TableCell>
                        <TableCell className="text-right">{NUM.format(c.requests)}</TableCell>
                        <TableCell className="text-right">{NUM.format(c.errors)}</TableCell>
                        <TableCell className="text-right">{NUM.format(c.totalTokens)}</TableCell>
                        <TableCell className="text-right">{formatUsd(c.costUsd)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

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
                        <TableCell className="font-medium">{FEATURE_LABELS[f.feature] ?? f.feature}</TableCell>
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
        </>
      )}
    </div>
  );
}
