import type { Lead, PipelineStageConfig, PipelineView } from "@workspace/api-client-react";

// Brand system for the Lead Capture Pro pipeline workspace ONLY.
// Scoped here so the global app theme (index.css) stays untouched.
export const BRAND = {
  navy: "#151348",
  navy700: "#1c1a57",
  navy600: "#252268",
  navy500: "#322e82",
  navy300: "#6f6bb0",
  orange: "#E66C25",
  orange600: "#cf5d19",
  orange400: "#f08a4f",
  orangeSoft: "rgba(230, 108, 37, 0.12)",
  navySoft: "rgba(21, 19, 72, 0.06)",
};

export type ViewMode = "table" | "kanban";
export type GroupBy = "none" | "stage" | "owner" | "team" | "priority";
export type StatusFilter = "all" | "open" | "won" | "lost";

export interface LeadFilters {
  search: string;
  stages: string[];
  ownerId: number | null;
  teamId: number | null;
  eventId: number | null;
  priority: string | null;
  tagId: number | null;
  minValue: number | null;
  maxValue: number | null;
  status: StatusFilter;
}

export const EMPTY_FILTERS: LeadFilters = {
  search: "",
  stages: [],
  ownerId: null,
  teamId: null,
  eventId: null,
  priority: null,
  tagId: null,
  minValue: null,
  maxValue: null,
  status: "all",
};

export type StageMap = Record<string, PipelineStageConfig>;

export function buildStageMap(stages: PipelineStageConfig[]): StageMap {
  const map: StageMap = {};
  for (const s of stages) map[s.key] = s;
  return map;
}

export function isWonStage(stageKey: string, stageMap: StageMap): boolean {
  const cfg = stageMap[stageKey];
  if (cfg) return cfg.isWon;
  return stageKey === "won";
}

export function isLostStage(stageKey: string, stageMap: StageMap): boolean {
  const cfg = stageMap[stageKey];
  if (cfg) return cfg.isLost;
  return stageKey === "lost" || stageKey === "archived";
}

export function statusOf(lead: Lead, stageMap: StageMap): StatusFilter {
  if (isWonStage(lead.stage, stageMap)) return "won";
  if (isLostStage(lead.stage, stageMap)) return "lost";
  return "open";
}

export function stageLabel(lead: Lead, stageMap: StageMap): string {
  return stageMap[lead.stage]?.name || lead.stageName || lead.stage;
}

export function stageColor(stageKey: string, stageMap: StageMap): string {
  return stageMap[stageKey]?.color || BRAND.navy300;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "\u20AC", GBP: "\u00A3", JPY: "\u00A5", INR: "\u20B9",
  CAD: "$", AUD: "$", CHF: "CHF", CNY: "\u00A5", AED: "AED", SAR: "SAR",
};

export function currencySymbol(currency?: string | null): string {
  const c = (currency || "USD").toUpperCase();
  return CURRENCY_SYMBOLS[c] || `${c} `;
}

export function formatMoney(
  value: number | null | undefined,
  currency?: string | null,
  opts?: { compact?: boolean }
): string | null {
  if (value == null) return null;
  const cur = (currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
      maximumFractionDigits: opts?.compact ? 1 : 0,
      notation: opts?.compact ? "compact" : "standard",
    }).format(value);
  } catch {
    return `${currencySymbol(cur)}${value.toLocaleString()}`;
  }
}

// Note: no FX source is available client-side, so aggregate money is summed in
// the tenant's dominant lead currency (matches the existing server-derived
// pipeline total). We never invent conversion rates.
export function dominantCurrency(leads: Lead[]): string {
  const counts: Record<string, number> = {};
  for (const l of leads) {
    if (l.currency) counts[l.currency.toUpperCase()] = (counts[l.currency.toUpperCase()] || 0) + 1;
  }
  let best = "USD";
  let bestN = -1;
  for (const [cur, n] of Object.entries(counts)) {
    if (n > bestN) {
      best = cur;
      bestN = n;
    }
  }
  return best;
}

export interface PipelineStats {
  currency: string;
  totalPipelineValue: number;
  weightedRevenue: number;
  wonRevenue: number;
  winRate: number;
  avgDealSize: number;
  openCount: number;
  wonCount: number;
  lostCount: number;
  totalCount: number;
  conversionRate: number;
}

export function computePipelineStats(leads: Lead[], stageMap: StageMap): PipelineStats {
  let totalPipelineValue = 0;
  let weightedRevenue = 0;
  let wonRevenue = 0;
  let openCount = 0;
  let wonCount = 0;
  let lostCount = 0;
  let valuedSum = 0;
  let valuedCount = 0;

  for (const l of leads) {
    const v = l.value ?? 0;
    const status = statusOf(l, stageMap);
    if (v > 0) {
      valuedSum += v;
      valuedCount += 1;
    }
    if (status === "won") {
      wonCount += 1;
      wonRevenue += v;
    } else if (status === "lost") {
      lostCount += 1;
    } else {
      openCount += 1;
      totalPipelineValue += v;
      weightedRevenue += v * ((l.probability ?? 0) / 100);
    }
  }

  const closed = wonCount + lostCount;
  const winRate = closed > 0 ? (wonCount / closed) * 100 : 0;
  const avgDealSize = valuedCount > 0 ? valuedSum / valuedCount : 0;
  const conversionRate = leads.length > 0 ? (wonCount / leads.length) * 100 : 0;

  return {
    currency: dominantCurrency(leads),
    totalPipelineValue,
    weightedRevenue,
    wonRevenue,
    winRate,
    avgDealSize,
    openCount,
    wonCount,
    lostCount,
    totalCount: leads.length,
    conversionRate,
  };
}

export function displayName(lead: Lead): string {
  return lead.contactName || lead.title || "Unnamed lead";
}

export function companyName(lead: Lead): string | null {
  return lead.contactCompany || lead.companyName || null;
}

export function applyFilters(
  leads: Lead[],
  filters: LeadFilters,
  stageMap: StageMap
): Lead[] {
  const q = filters.search.trim().toLowerCase();
  return leads.filter((l) => {
    if (q) {
      const hay = [
        l.contactName,
        l.contactCompany,
        l.companyName,
        l.contactEmail,
        l.title,
        l.assignedToName,
        l.eventName,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filters.stages.length > 0 && !filters.stages.includes(l.stage)) return false;
    if (filters.ownerId != null && l.assignedToId !== filters.ownerId) return false;
    if (filters.teamId != null && l.teamId !== filters.teamId) return false;
    if (filters.eventId != null && l.eventId !== filters.eventId) return false;
    if (filters.priority != null && l.priority !== filters.priority) return false;
    if (filters.tagId != null && !(l.tags ?? []).some((t) => t.id === filters.tagId)) return false;
    if (filters.minValue != null && (l.value ?? 0) < filters.minValue) return false;
    if (filters.maxValue != null && (l.value ?? 0) > filters.maxValue) return false;
    if (filters.status !== "all" && statusOf(l, stageMap) !== filters.status) return false;
    return true;
  });
}

export function activeFilterCount(filters: LeadFilters): number {
  let n = 0;
  if (filters.stages.length) n += 1;
  if (filters.ownerId != null) n += 1;
  if (filters.teamId != null) n += 1;
  if (filters.eventId != null) n += 1;
  if (filters.priority != null) n += 1;
  if (filters.tagId != null) n += 1;
  if (filters.minValue != null || filters.maxValue != null) n += 1;
  if (filters.status !== "all") n += 1;
  return n;
}

export function groupInfo(
  lead: Lead,
  groupBy: GroupBy,
  stageMap: StageMap
): { key: string; label: string } {
  switch (groupBy) {
    case "stage":
      return { key: lead.stage, label: stageLabel(lead, stageMap) };
    case "owner":
      return {
        key: lead.assignedToId != null ? String(lead.assignedToId) : "none",
        label: lead.assignedToName || "Unassigned",
      };
    case "team":
      return {
        key: lead.teamId != null ? String(lead.teamId) : "none",
        label: lead.teamName || "No team",
      };
    case "priority":
      return {
        key: lead.priority || "none",
        label: lead.priority ? lead.priority[0].toUpperCase() + lead.priority.slice(1) : "No priority",
      };
    default:
      return { key: "all", label: "All leads" };
  }
}

// Optimistically move a lead to another stage inside the grouped pipeline
// query cache, recomputing per-stage counts and values.
export function moveLeadStage(
  view: PipelineView,
  leadId: number,
  toStage: string
): PipelineView {
  const next: PipelineView = {
    ...view,
    stages: view.stages.map((s) => ({ ...s, leads: [...s.leads] })),
  };
  let moving: Lead | undefined;
  for (const s of next.stages) {
    const idx = s.leads.findIndex((l) => l.id === leadId);
    if (idx >= 0) {
      moving = { ...s.leads[idx], stage: toStage as Lead["stage"] };
      s.leads.splice(idx, 1);
      break;
    }
  }
  if (!moving) return view;
  const target = next.stages.find((s) => s.stage === toStage);
  if (target) target.leads.unshift(moving);
  for (const s of next.stages) {
    s.count = s.leads.length;
    s.value = s.leads.reduce((sum, l) => sum + (l.value ?? 0), 0);
  }
  return next;
}

export interface LeadColumnMeta {
  id: string;
  label: string;
  hideable: boolean;
}

export const LEAD_COLUMNS: LeadColumnMeta[] = [
  { id: "select", label: "Select", hideable: false },
  { id: "contact", label: "Contact", hideable: false },
  { id: "company", label: "Company", hideable: true },
  { id: "event", label: "Event", hideable: true },
  { id: "value", label: "Deal Value", hideable: true },
  { id: "stage", label: "Stage", hideable: true },
  { id: "owner", label: "Owner", hideable: true },
  { id: "team", label: "Team", hideable: true },
  { id: "priority", label: "Priority", hideable: true },
  { id: "aiScore", label: "AI Score", hideable: true },
  { id: "lastActivity", label: "Last Activity", hideable: true },
  { id: "nextFollowUp", label: "Next Follow-up", hideable: true },
  { id: "expectedClose", label: "Expected Close", hideable: true },
  { id: "tags", label: "Tags", hideable: true },
  { id: "status", label: "Status", hideable: true },
  { id: "actions", label: "Actions", hideable: false },
];

export interface PipelineViewState {
  viewMode: ViewMode;
  groupBy: GroupBy;
  filters: LeadFilters;
  sorting: { id: string; desc: boolean }[];
  columnVisibility: Record<string, boolean>;
  columnPinning: { left?: string[]; right?: string[] };
}

// Saved-view payloads come back from the API typed as `unknown`. They may be
// legacy, hand-edited, or malformed, so coerce every field defensively before
// letting it drive table/filter state — never trust the raw shape.
export function normalizeFilters(raw: unknown): LeadFilters {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const numOrNull = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const strArr = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === "string") : []);
  const status: StatusFilter = ["all", "open", "won", "lost"].includes(p.status as string)
    ? (p.status as StatusFilter)
    : "all";
  return {
    search: typeof p.search === "string" ? p.search : "",
    stages: strArr(p.stages),
    ownerId: numOrNull(p.ownerId),
    teamId: numOrNull(p.teamId),
    eventId: numOrNull(p.eventId),
    priority: typeof p.priority === "string" ? p.priority : null,
    tagId: numOrNull(p.tagId),
    minValue: numOrNull(p.minValue),
    maxValue: numOrNull(p.maxValue),
    status,
  };
}

export function normalizeViewState(raw: unknown): Partial<PipelineViewState> {
  if (!raw || typeof raw !== "object") return {};
  const p = raw as Record<string, unknown>;
  const out: Partial<PipelineViewState> = {};
  if (p.viewMode === "table" || p.viewMode === "kanban") out.viewMode = p.viewMode;
  if (["none", "stage", "owner", "team", "priority"].includes(p.groupBy as string)) {
    out.groupBy = p.groupBy as GroupBy;
  }
  if ("filters" in p) out.filters = normalizeFilters(p.filters);
  if (Array.isArray(p.sorting)) {
    out.sorting = p.sorting
      .filter(
        (s): s is { id: string; desc?: unknown } =>
          !!s && typeof s === "object" && typeof (s as { id?: unknown }).id === "string"
      )
      .map((s) => ({ id: s.id, desc: !!s.desc }));
  }
  if (p.columnVisibility && typeof p.columnVisibility === "object") {
    const cv: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(p.columnVisibility as Record<string, unknown>)) {
      if (typeof v === "boolean") cv[k] = v;
    }
    out.columnVisibility = cv;
  }
  if (p.columnPinning && typeof p.columnPinning === "object") {
    const cp = p.columnPinning as Record<string, unknown>;
    const strArr = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === "string") : []);
    out.columnPinning = { left: strArr(cp.left), right: strArr(cp.right) };
  }
  return out;
}

export const PRIORITY_META: Record<string, { label: string; dot: string; badge: string }> = {
  high: { label: "High", dot: "bg-red-500", badge: "border-red-500/40 text-red-600 bg-red-500/10" },
  medium: { label: "Medium", dot: "bg-amber-500", badge: "border-amber-500/40 text-amber-600 bg-amber-500/10" },
  low: { label: "Low", dot: "bg-emerald-500", badge: "border-emerald-500/40 text-emerald-600 bg-emerald-500/10" },
};
