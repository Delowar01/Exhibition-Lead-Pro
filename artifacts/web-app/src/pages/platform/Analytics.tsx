import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ds";
import {
  ANALYTICS_TABS,
  GRANULARITY_LABEL,
  MAX_DAILY_RANGE_DAYS,
  RANGE_PRESETS,
  buildAnalyticsSearch,
  daysBetween,
  defaultGranularity,
  effectiveGranularity,
  parseAnalyticsSearch,
  plural,
  presetRange,
  previousRange,
  rangeLabel,
  todayUtc,
  validateRange,
  type AnalyticsState,
  type AnalyticsTab,
  type GranularityChoice,
  type RangePreset,
} from "@/lib/platform-analytics";
import type { AnalyticsParams, SectionProps } from "@/components/platform/analytics/shared";
import { OverviewSection } from "@/components/platform/analytics/OverviewSection";
import { GrowthSection } from "@/components/platform/analytics/GrowthSection";
import { SubscriptionsSection } from "@/components/platform/analytics/SubscriptionsSection";
import { RevenueSection } from "@/components/platform/analytics/RevenueSection";
import { ActivitySection } from "@/components/platform/analytics/ActivitySection";
import { AiSection } from "@/components/platform/analytics/AiSection";
import { OperationsSection } from "@/components/platform/analytics/OperationsSection";

// G-7 — Platform Owner Analytics.
//
// One reporting window (whole UTC days) scopes every tab; the window, the bucket size and the
// open tab live in the URL so a view can be bookmarked and shared. Each tab loads its own
// endpoint, so only what is on screen is fetched. Figures come from the API and nothing is
// simulated; the few values worked out here (a change against the previous period, a share
// of a total, the annual run rate as the monthly estimate × 12) are labelled as such, and a
// figure the platform cannot compute says "Unavailable".

const SECTIONS: Record<AnalyticsTab, (props: SectionProps) => React.ReactNode> = {
  overview: OverviewSection,
  growth: GrowthSection,
  subscriptions: SubscriptionsSection,
  revenue: RevenueSection,
  activity: ActivitySection,
  ai: AiSection,
  operations: OperationsSection,
};

const ANALYTICS_PATH = "/platform/analytics";

export default function PlatformAnalytics() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  // "Today" is read on every render, so a page left open past midnight (UTC) moves on to the
  // new day at the next interaction instead of staying on yesterday's window.
  const today = todayUtc();
  const [, rerender] = useState(0);
  const state = useMemo(() => parseAnalyticsSearch(search, today), [search, today]);

  const update = useCallback(
    (patch: Partial<AnalyticsState>) => {
      navigate(`${ANALYTICS_PATH}${buildAnalyticsSearch({ ...state, ...patch })}`, { replace: true });
    },
    [navigate, state],
  );

  // Custom range: the two dates are a draft until "Apply" — a half-typed range never refetches.
  const [customOpen, setCustomOpen] = useState(state.preset === "custom");
  const [draftFrom, setDraftFrom] = useState(state.from);
  const [draftTo, setDraftTo] = useState(state.to);
  const [rangeError, setRangeError] = useState<string | null>(null);
  // The form follows the URL: a link to a preset (or to the bare page) closes the custom
  // range, and a link to a custom range opens it with its dates.
  useEffect(() => {
    setDraftFrom(state.from);
    setDraftTo(state.to);
    setRangeError(null);
    setCustomOpen(state.preset === "custom");
  }, [state.from, state.to, state.preset]);

  const onPreset = (value: string) => {
    if (value === "custom") {
      setCustomOpen(true);
      return;
    }
    const preset = value as Exclude<RangePreset, "custom">;
    setCustomOpen(false);
    update({ preset, ...presetRange(preset, today) });
  };

  const applyCustom = () => {
    const problem = validateRange(draftFrom, draftTo, today);
    setRangeError(problem);
    if (problem) return;
    update({ preset: "custom", from: draftFrom, to: draftTo });
  };

  const days = daysBetween(state.from, state.to);
  const dailyAllowed = days <= MAX_DAILY_RANGE_DAYS;
  const granularityChoice: GranularityChoice = state.granularity === "day" && !dailyAllowed ? "auto" : state.granularity;
  const granularity = effectiveGranularity(state.granularity, days);
  const shownGranularity = granularity ?? defaultGranularity(days);
  const previous = previousRange(state.from, state.to);

  const params = useMemo<AnalyticsParams>(
    () => (granularity ? { from: state.from, to: state.to, granularity } : { from: state.from, to: state.to }),
    [state.from, state.to, granularity],
  );

  const openTab = useCallback((tab: AnalyticsTab) => update({ tab }), [update]);

  // A link inside a panel ("Revenue details") opens another tab. Its panel is then removed,
  // so keyboard focus is moved to the newly selected tab instead of being dropped.
  const focusSelectedTab = useRef(false);
  const openTabFromPanel = useCallback(
    (tab: AnalyticsTab) => {
      focusSelectedTab.current = true;
      update({ tab });
    },
    [update],
  );

  // On narrow screens the tab bar scrolls sideways: keep the open tab in view (deep links included).
  const tabsScroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const selected = tabsScroller.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (focusSelectedTab.current) {
      focusSelectedTab.current = false;
      selected?.focus();
    }
  }, [state.tab]);

  const refresh = () => {
    rerender((n) => n + 1);
    void queryClient.invalidateQueries({
      predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/platform/analytics/"),
    });
  };

  return (
    <div className="space-y-6" data-testid="platform-analytics">
      <PageHeader
        title="Analytics"
        description="Growth, subscriptions, revenue, activity, AI usage and operations across every company."
        actions={
          <Button variant="outline" size="sm" onClick={refresh} data-testid="analytics-refresh">
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <section
        aria-label="Reporting period"
        className="rounded-xl border border-card-border bg-card p-4 shadow-sm"
        data-testid="analytics-filters"
      >
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="w-full space-y-1.5 sm:w-auto">
            <Label htmlFor="analytics-period">Period</Label>
            <Select value={customOpen ? "custom" : state.preset} onValueChange={onPreset}>
              <SelectTrigger id="analytics-period" className="w-full sm:w-[190px]" data-testid="analytics-period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGE_PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom range</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {customOpen && (
            <form
              className="flex w-full flex-wrap items-end gap-x-3 gap-y-3 sm:w-auto"
              data-testid="analytics-custom-range"
              onSubmit={(e) => {
                e.preventDefault();
                applyCustom();
              }}
            >
              <div className="min-w-0 flex-1 space-y-1.5 sm:flex-none">
                <Label htmlFor="analytics-from">From</Label>
                <Input
                  id="analytics-from"
                  type="date"
                  value={draftFrom}
                  max={today}
                  onChange={(e) => setDraftFrom(e.target.value)}
                  aria-invalid={rangeError ? true : undefined}
                  aria-describedby={rangeError ? "analytics-range-error" : undefined}
                  className="w-full sm:w-[160px]"
                  data-testid="analytics-from"
                />
              </div>
              <div className="min-w-0 flex-1 space-y-1.5 sm:flex-none">
                <Label htmlFor="analytics-to">To</Label>
                <Input
                  id="analytics-to"
                  type="date"
                  value={draftTo}
                  max={today}
                  onChange={(e) => setDraftTo(e.target.value)}
                  aria-invalid={rangeError ? true : undefined}
                  aria-describedby={rangeError ? "analytics-range-error" : undefined}
                  className="w-full sm:w-[160px]"
                  data-testid="analytics-to"
                />
              </div>
              <Button type="submit" className="w-full sm:w-auto" data-testid="analytics-apply">
                Apply
              </Button>
            </form>
          )}

          <div className="w-full space-y-1.5 sm:w-auto">
            <Label htmlFor="analytics-granularity">Group by</Label>
            <Select value={granularityChoice} onValueChange={(v) => update({ granularity: v as GranularityChoice })}>
              <SelectTrigger id="analytics-granularity" className="w-full sm:w-[150px]" data-testid="analytics-granularity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automatic</SelectItem>
                <SelectItem value="day" disabled={!dailyAllowed}>
                  Day
                </SelectItem>
                <SelectItem value="week">Week</SelectItem>
                <SelectItem value="month">Month</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {rangeError && (
          <p id="analytics-range-error" role="alert" className="mt-3 text-sm font-medium text-destructive" data-testid="analytics-range-error">
            {rangeError}
          </p>
        )}

        <p className="mt-3 text-sm text-muted-foreground" data-testid="analytics-range-summary">
          <span className="font-medium text-foreground">{rangeLabel(state)}</span> · {plural(days, "day")} ·{" "}
          {GRANULARITY_LABEL[shownGranularity]} figures · compared with {rangeLabel(previous)} · all dates in UTC
        </p>
      </section>

      {/* Manual activation: arrow keys move between tabs and Enter or Space opens one, so
          stepping along the bar does not load every tab on the way. */}
      <Tabs value={state.tab} onValueChange={(v) => openTab(v as AnalyticsTab)} activationMode="manual">
        {/* The fading right edge shows that the bar scrolls. The trailing padding lets the last tab
            clear the fade, and the scroll padding keeps a tab scrolled into view clear of it too. */}
        <div
          ref={tabsScroller}
          className="-mx-4 overflow-x-auto px-4 pb-1 [mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)] [scroll-padding-inline:3.5rem] sm:mx-0 sm:px-0"
          data-testid="analytics-tabs-scroller"
        >
          <div className="w-max pr-10">
            <TabsList aria-label="Analytics sections" className="h-auto w-max justify-start gap-1 p-1">
              {ANALYTICS_TABS.map((t) => (
                <TabsTrigger
                  key={t.id}
                  value={t.id}
                  data-testid={`analytics-tab-${t.id}`}
                  className="px-3 py-1.5 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow"
                >
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </div>
        {ANALYTICS_TABS.map((t) => {
          const Section = SECTIONS[t.id];
          return (
            <TabsContent key={t.id} value={t.id} className="mt-5">
              <h2 className="sr-only">{t.label}</h2>
              <Section params={params} onOpenTab={openTabFromPanel} />
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
