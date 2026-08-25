import React from "react";
import { Link } from "wouter";
import {
  useGetAiInsightsOverview,
  getGetAiInsightsOverviewQueryKey,
  type AiInsight,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sparkles, ShieldCheck, Cpu, ChevronRight } from "lucide-react";
import { AiWorkspaceLayout } from "@/components/layouts/AiWorkspaceLayout";
import { ListSkeleton } from "@/components/ds";

const INSIGHT_LABELS: Record<string, string> = {
  lead_intelligence: "Lead Intelligence",
  company_intelligence: "Company Intelligence",
  contact_intelligence: "Contact Intelligence",
  smart_classification: "Smart Classification",
  opportunity_potential: "Opportunity Potential",
  missing_info: "Data Completeness",
  duplicate_intelligence: "Duplicate Detection",
};

const ENTITY_PATH: Record<string, string> = {
  lead: "/admin/leads",
  contact: "/admin/contacts",
  organization: "/admin/companies",
};

function label(type: string): string {
  return (
    INSIGHT_LABELS[type] ??
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

function RecentRow({ insight }: { insight: AiInsight }) {
  const href = ENTITY_PATH[insight.entityType]
    ? `${ENTITY_PATH[insight.entityType]}/${insight.entityId}`
    : undefined;
  const isDeterministic = insight.source === "deterministic";
  const row = (
    <div className="flex items-center justify-between gap-3 py-3 px-1">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{label(insight.insightType)}</span>
          <Badge variant="outline" className="text-[10px] gap-1 font-normal capitalize">
            {isDeterministic ? <ShieldCheck className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
            {insight.entityType}
          </Badge>
          <Badge
            variant={
              insight.status === "accepted"
                ? "default"
                : insight.status === "dismissed"
                  ? "secondary"
                  : "outline"
            }
            className="capitalize text-[10px]"
          >
            {insight.status}
          </Badge>
        </div>
        {insight.reasoning && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{insight.reasoning}</p>
        )}
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Analyzed {formatTs(insight.lastAnalysisAt ?? insight.generatedAt)}
          {insight.confidence !== null && insight.confidence !== undefined
            ? ` · ${insight.confidence}% confidence`
            : ""}
        </p>
      </div>
      {href && <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />}
    </div>
  );

  return href ? (
    <Link href={href} className="block rounded-md hover:bg-secondary/40 transition-colors">
      {row}
    </Link>
  ) : (
    row
  );
}

export default function AiInsightsReview() {
  const { data, isLoading } = useGetAiInsightsOverview({
    query: { queryKey: getGetAiInsightsOverviewQueryKey() },
  });

  const counts = data?.counts ?? {};
  const recent = data?.recent ?? [];

  return (
    <AiWorkspaceLayout activeTab="insights">
      <div className="space-y-6 max-w-5xl mx-auto pb-10">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard title="Awaiting review" value={counts.suggested ?? 0} tone="text-amber-600" />
        <StatCard title="Accepted" value={counts.accepted ?? 0} tone="text-emerald-600" />
        <StatCard title="Dismissed" value={counts.dismissed ?? 0} tone="text-muted-foreground" />
      </div>

      <Card className="shadow-sm">
        <CardHeader className="pb-3 border-b border-border">
          <CardTitle className="text-base">Recent activity</CardTitle>
        </CardHeader>
        <CardContent className="pt-2 divide-y divide-border">
          {isLoading ? (
            <ListSkeleton rows={3} />
          ) : recent.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No AI insights generated yet. Open a lead, contact, or company and run an analysis to get started.
            </p>
          ) : (
            recent.map((insight) => <RecentRow key={insight.id} insight={insight} />)
          )}
        </CardContent>
      </Card>
      </div>
    </AiWorkspaceLayout>
  );
}
