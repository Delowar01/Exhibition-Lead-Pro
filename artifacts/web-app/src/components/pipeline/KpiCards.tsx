import {
  Wallet,
  TrendingUp,
  Trophy,
  Percent,
  BarChart3,
  Layers,
  CircleCheck,
  CircleX,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Lead } from "@workspace/api-client-react";
import { computePipelineStats, formatMoney, type StageMap } from "./utils";
import { MetricCard } from "@/components/ds";

interface KpiCardsProps {
  leads: Lead[];
  stageMap: StageMap;
}

interface Kpi {
  label: string;
  value: string;
  hint: string;
  icon: LucideIcon;
  accent: boolean;
}

export function KpiCards({ leads, stageMap }: KpiCardsProps) {
  const s = computePipelineStats(leads, stageMap);
  const money = (v: number) => formatMoney(v, s.currency, { compact: true }) ?? "-";

  const kpis: Kpi[] = [
    { label: "Open Pipeline", value: money(s.totalPipelineValue), hint: `${s.openCount} open`, icon: Wallet, accent: true },
    { label: "Weighted Forecast", value: money(s.weightedRevenue), hint: "probability-adjusted", icon: TrendingUp, accent: false },
    { label: "Won Revenue", value: money(s.wonRevenue), hint: `${s.wonCount} closed won`, icon: Trophy, accent: true },
    { label: "Win Rate", value: `${s.winRate.toFixed(0)}%`, hint: `${s.wonCount + s.lostCount} closed`, icon: Percent, accent: false },
    { label: "Avg Deal Size", value: money(s.avgDealSize), hint: "valued leads", icon: BarChart3, accent: false },
    { label: "Open Opportunities", value: s.openCount.toLocaleString(), hint: `${s.totalCount} total`, icon: Layers, accent: false },
    { label: "Leads Won", value: s.wonCount.toLocaleString(), hint: `${s.conversionRate.toFixed(0)}% conversion`, icon: CircleCheck, accent: false },
    { label: "Leads Lost", value: s.lostCount.toLocaleString(), hint: "closed lost", icon: CircleX, accent: false },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
      {kpis.map((k) => (
        <div data-testid={`kpi-${k.label.toLowerCase().replace(/\s+/g, "-")}`} key={k.label}>
           <MetricCard
             label={k.label}
             value={k.value}
             footer={k.hint}
             icon={k.icon}
             className={k.accent ? "border-primary/20 bg-primary/5" : undefined}
           />
        </div>
      ))}
    </div>
  );
}
