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
import { BRAND, computePipelineStats, formatMoney, type StageMap } from "./utils";

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
      {kpis.map((k) => {
        const Icon = k.icon;
        return (
          <div
            key={k.label}
            data-testid={`kpi-${k.label.toLowerCase().replace(/\s+/g, "-")}`}
            className="group relative overflow-hidden rounded-xl border p-3.5 transition-shadow hover:shadow-md"
            style={{
              borderColor: k.accent ? `${BRAND.orange}44` : `${BRAND.navy}1f`,
              backgroundColor: k.accent ? BRAND.orangeSoft : "var(--color-card)",
            }}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {k.label}
              </span>
              <Icon className="h-3.5 w-3.5" style={{ color: k.accent ? BRAND.orange : BRAND.navy300 }} />
            </div>
            <div className="mt-2 text-xl font-bold tracking-tight" style={{ color: BRAND.navy }}>
              <span className="dark:text-foreground">{k.value}</span>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{k.hint}</div>
          </div>
        );
      })}
    </div>
  );
}
