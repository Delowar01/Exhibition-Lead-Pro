import { Feather } from "@/components/icons";
import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type AnalyticsActivityItem,
  type AnalyticsFunnelStage,
  type AnalyticsPerformer,
  type ScopedAnalytics,
  getGetEmployeeAnalyticsQueryKey,
  getGetTeamAnalyticsQueryKey,
  useGetAnalyticsScopeOptions,
  useGetEmployeeAnalytics,
  useGetTeamAnalytics,
} from "@workspace/api-client-react";

import {
  Avatar,
  EmptyState,
  ErrorState,
  FONT,
  LoadingState,
  prettyLabel,
} from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { formatCurrency } from "@/lib/currency";

type RangeKey = "7" | "30" | "90";

// Build a YYYY-MM-DD date `days` ago (local date, matches the API contract
// which expects plain local-date strings — never UTC-shifted timestamps).
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function MyNumbersScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL, textAlign } = useLocale();
  const { user } = useAuth();

  const [range, setRange] = useState<RangeKey>("30");
  const [scope, setScope] = useState<"me" | "team">("me");

  const dateFrom = useMemo(() => isoDaysAgo(parseInt(range, 10)), [range]);

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  // Scope options tell us whether this user leads a team they may drill into.
  // For an employee the API only returns own team when team.leaderId === self,
  // so the mere presence of a team here is the "is team lead" signal.
  const scopeOptionsQuery = useGetAnalyticsScopeOptions();
  const leadTeam = useMemo(
    () => scopeOptionsQuery.data?.teams?.[0] ?? null,
    [scopeOptionsQuery.data],
  );
  const canViewTeam = leadTeam != null;

  // If the user can't view a team, force the "me" scope.
  const activeScope = canViewTeam ? scope : "me";

  const employeeQuery = useGetEmployeeAnalytics(
    { id: user?.id ?? 0, dateFrom },
    {
      query: {
        enabled: user?.id != null && activeScope === "me",
        queryKey: getGetEmployeeAnalyticsQueryKey({ id: user?.id ?? 0, dateFrom }),
      },
    },
  );

  const teamQuery = useGetTeamAnalytics(
    { id: leadTeam?.id ?? 0, dateFrom },
    {
      query: {
        enabled: canViewTeam && activeScope === "team",
        queryKey: getGetTeamAnalyticsQueryKey({ id: leadTeam?.id ?? 0, dateFrom }),
      },
    },
  );

  const activeQuery = activeScope === "team" ? teamQuery : employeeQuery;
  const data: ScopedAnalytics | undefined = activeQuery.data;

  const refreshing = activeQuery.isRefetching || scopeOptionsQuery.isRefetching;
  const onRefresh = () => {
    void activeQuery.refetch();
    void scopeOptionsQuery.refetch();
  };

  const ranges: RangeKey[] = ["7", "30", "90"];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 12, paddingHorizontal: 20 }}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Feather name={isRTL ? "chevron-right" : "chevron-left"} size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.heading, { color: colors.foreground, textAlign }]}>
          {t("myNumbers.title")}
        </Text>
        <Text style={[styles.headingSub, { color: colors.mutedForeground, textAlign }]}>
          {t("myNumbers.subtitle")}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: insets.bottom + 40,
          flexGrow: 1,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        {/* Scope toggle — only when the user leads a team */}
        {canViewTeam ? (
          <View style={[styles.segment, { backgroundColor: colors.muted, flexDirection: isRTL ? "row-reverse" : "row" }]}>
            {(["me", "team"] as const).map((s) => {
              const active = activeScope === s;
              return (
                <Pressable
                  key={s}
                  onPress={() => setScope(s)}
                  style={[
                    styles.segmentItem,
                    active && { backgroundColor: colors.card, borderColor: colors.border },
                  ]}
                >
                  <Text
                    style={[
                      styles.segmentText,
                      { color: active ? colors.foreground : colors.mutedForeground },
                    ]}
                  >
                    {s === "me" ? t("myNumbers.scopeMine") : t("myNumbers.scopeTeam")}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {/* Date-range chips */}
        <View style={[styles.rangeRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
          {ranges.map((r) => {
            const active = range === r;
            return (
              <Pressable
                key={r}
                onPress={() => setRange(r)}
                style={[
                  styles.rangeChip,
                  {
                    backgroundColor: active ? colors.primary : colors.card,
                    borderColor: active ? colors.primary : colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.rangeChipText,
                    { color: active ? colors.primaryForeground : colors.mutedForeground },
                  ]}
                >
                  {t(`myNumbers.range${r}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {user?.id == null ? (
          <EmptyState icon="bar-chart-2" title={t("myNumbers.unavailable")} />
        ) : activeQuery.isLoading ? (
          <LoadingState />
        ) : activeQuery.isError ? (
          <ErrorState onRetry={() => void activeQuery.refetch()} />
        ) : data == null ? (
          <EmptyState icon="bar-chart-2" title={t("myNumbers.noData")} />
        ) : (
          <Content data={data} t={t} isRTL={isRTL} textAlign={textAlign} colors={colors} />
        )}
      </ScrollView>
    </View>
  );
}

type ColorTokens = ReturnType<typeof useColors>;
type TFn = ReturnType<typeof useLocale>["t"];

function Content({
  data,
  t,
  isRTL,
  textAlign,
  colors,
}: {
  data: ScopedAnalytics;
  t: TFn;
  isRTL: boolean;
  textAlign: "left" | "right";
  colors: ColorTokens;
}) {
  const k = data.kpis;
  const d = data.deltas;

  const kpiCards: {
    key: string;
    label: string;
    value: string;
    icon: keyof typeof Feather.glyphMap;
    color: string;
    delta?: number | null;
    sub?: string;
  }[] = [
    {
      key: "scans",
      label: t("myNumbers.scans"),
      value: String(k.scans),
      icon: "camera",
      color: colors.primary,
      delta: d.scans,
    },
    {
      key: "newLeads",
      label: t("myNumbers.newLeads"),
      value: String(k.newLeads),
      icon: "user-plus",
      color: "#8B5CF6",
      delta: d.newLeads,
    },
    {
      key: "newContacts",
      label: t("myNumbers.newContacts"),
      value: String(k.newContacts),
      icon: "users",
      color: "#06B6D4",
      delta: d.newContacts,
    },
    {
      key: "conversionRate",
      label: t("myNumbers.conversionRate"),
      value: `${Math.round(k.conversionRate)}%`,
      icon: "trending-up",
      color: "#10B981",
      delta: d.conversionRate,
      sub: t("myNumbers.wonLostBreakdown", { won: k.wonCount, lost: k.lostCount }),
    },
    {
      key: "openPipeline",
      label: t("myNumbers.openPipeline"),
      value: formatCurrency(k.pipelineValue),
      icon: "bar-chart-2",
      color: "#F59E0B",
      delta: d.pipelineValue,
    },
    {
      key: "wonValue",
      label: t("myNumbers.wonValue"),
      value: formatCurrency(k.wonValue),
      icon: "award",
      color: "#22C55E",
    },
    {
      key: "followUpAdherence",
      label: t("myNumbers.followUpAdherence"),
      value: `${Math.round(k.followUpAdherence)}%`,
      icon: "check-circle",
      color: "#0EA5E9",
      sub: t("myNumbers.followUpsBreakdown", {
        overdue: k.followUpsOverdueCount,
        due: k.followUpsDueCount,
      }),
    },
  ];

  return (
    <>
      {/* KPI grid */}
      <View style={styles.grid}>
        {kpiCards.map((c) => (
          <View
            key={c.key}
            style={[
              styles.metricCard,
              { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
            ]}
          >
            <View style={[styles.metricIcon, { backgroundColor: c.color + "1A" }]}>
              <Feather name={c.icon} size={14} color={c.color} />
            </View>
            <Text style={[styles.metricValue, { color: colors.foreground, textAlign }]} numberOfLines={1}>
              {c.value}
            </Text>
            <Text style={[styles.metricLabel, { color: colors.mutedForeground, textAlign }]} numberOfLines={1}>
              {c.label}
            </Text>
            {c.sub ? (
              <Text style={[styles.metricSub, { color: colors.mutedForeground, textAlign }]} numberOfLines={1}>
                {c.sub}
              </Text>
            ) : c.delta != null ? (
              <DeltaPill delta={c.delta} colors={colors} />
            ) : null}
          </View>
        ))}
      </View>

      {/* Funnel */}
      {data.funnel.length > 0 ? (
        <Section title={t("myNumbers.funnel")} colors={colors} textAlign={textAlign}>
          {(() => {
            const max = Math.max(1, ...data.funnel.map((f) => f.count));
            return data.funnel.map((f: AnalyticsFunnelStage) => (
              <View key={f.stage} style={styles.funnelRow}>
                <View style={[styles.funnelHead, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                  <Text style={[styles.funnelLabel, { color: colors.foreground, textAlign }]}>
                    {t(`leads.stages.${f.stage}`, { defaultValue: f.label || prettyLabel(f.stage) })}
                  </Text>
                  <Text style={[styles.funnelCount, { color: colors.mutedForeground }]}>{f.count}</Text>
                </View>
                <View style={[styles.barTrack, { backgroundColor: colors.muted }]}>
                  <View
                    style={[
                      styles.barFill,
                      { width: `${(f.count / max) * 100}%`, backgroundColor: colors.primary },
                    ]}
                  />
                </View>
              </View>
            ));
          })()}
        </Section>
      ) : null}

      {/* Top performers (team scope) */}
      {data.topPerformers.length > 0 ? (
        <Section title={t("myNumbers.topPerformers")} colors={colors} textAlign={textAlign}>
          {data.topPerformers.map((p: AnalyticsPerformer) => (
            <View
              key={p.userId}
              style={[styles.performerRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}
            >
              <Avatar name={p.userName} uri={p.avatarUrl} size={36} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.performerName, { color: colors.foreground, textAlign }]} numberOfLines={1}>
                  {p.userName}
                </Text>
                <Text style={[styles.performerSub, { color: colors.mutedForeground, textAlign }]} numberOfLines={1}>
                  {t("myNumbers.performerStats", { leads: p.leads, won: p.won, scans: p.scans })}
                </Text>
              </View>
              <Text style={[styles.performerValue, { color: colors.success }]}>
                {formatCurrency(p.pipelineValue)}
              </Text>
            </View>
          ))}
        </Section>
      ) : null}

      {/* Recent activity */}
      {data.recentActivity.length > 0 ? (
        <Section title={t("myNumbers.recentActivity")} colors={colors} textAlign={textAlign}>
          {data.recentActivity.map((a: AnalyticsActivityItem) => (
            <View
              key={a.id}
              style={[styles.activityRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}
            >
              <View style={[styles.activityDot, { backgroundColor: colors.primary }]} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.activityTitle, { color: colors.foreground, textAlign }]} numberOfLines={1}>
                  {a.title}
                </Text>
                {a.subtitle ? (
                  <Text style={[styles.activitySub, { color: colors.mutedForeground, textAlign }]} numberOfLines={1}>
                    {a.subtitle}
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
        </Section>
      ) : (
        <View style={{ marginTop: 24 }}>
          <EmptyState icon="activity" title={t("myNumbers.noActivity")} />
        </View>
      )}
    </>
  );
}

function DeltaPill({ delta, colors }: { delta: number; colors: ColorTokens }) {
  if (delta === 0) {
    return (
      <Text style={[styles.deltaText, { color: colors.mutedForeground }]}>±0%</Text>
    );
  }
  const up = delta > 0;
  const color = up ? "#22C55E" : "#EF4444";
  return (
    <View style={styles.deltaRow}>
      <Feather name={up ? "arrow-up-right" : "arrow-down-right"} size={11} color={color} />
      <Text style={[styles.deltaText, { color }]}>{Math.abs(Math.round(delta))}%</Text>
    </View>
  );
}

function Section({
  title,
  colors,
  textAlign,
  children,
}: {
  title: string;
  colors: ColorTokens;
  textAlign: "left" | "right";
  children: React.ReactNode;
}) {
  return (
    <>
      <Text style={[styles.sectionTitle, { color: colors.mutedForeground, textAlign }]}>
        {title.toUpperCase()}
      </Text>
      <View
        style={[
          styles.sectionCard,
          { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
        ]}
      >
        {children}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  heading: {
    fontSize: 26,
    fontFamily: FONT.bold,
  },
  headingSub: {
    fontSize: 13.5,
    fontFamily: FONT.regular,
    marginTop: 3,
  },
  segment: {
    padding: 4,
    borderRadius: 12,
    gap: 4,
    marginBottom: 14,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: "transparent",
    alignItems: "center",
  },
  segmentText: {
    fontSize: 13.5,
    fontFamily: FONT.semibold,
  },
  rangeRow: {
    gap: 8,
    marginBottom: 18,
  },
  rangeChip: {
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1,
  },
  rangeChipText: {
    fontSize: 12.5,
    fontFamily: FONT.semibold,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 9,
  },
  metricCard: {
    width: "47.5%",
    flexGrow: 1,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    minHeight: 92,
  },
  metricIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  metricValue: {
    fontSize: 20,
    fontFamily: FONT.bold,
  },
  metricLabel: {
    fontSize: 11,
    fontFamily: FONT.medium,
    marginTop: 2,
  },
  metricSub: {
    fontSize: 10.5,
    fontFamily: FONT.regular,
    marginTop: 4,
  },
  deltaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    marginTop: 4,
  },
  deltaText: {
    fontSize: 11,
    fontFamily: FONT.semibold,
  },
  sectionTitle: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.6,
    marginTop: 26,
    marginBottom: 12,
  },
  sectionCard: {
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  funnelRow: {
    paddingVertical: 10,
  },
  funnelHead: {
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 7,
  },
  funnelLabel: {
    fontSize: 13.5,
    fontFamily: FONT.medium,
    flex: 1,
  },
  funnelCount: {
    fontSize: 13,
    fontFamily: FONT.semibold,
  },
  barTrack: {
    height: 8,
    borderRadius: 4,
    overflow: "hidden",
  },
  barFill: {
    height: 8,
    borderRadius: 4,
  },
  performerRow: {
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
  },
  performerName: {
    fontSize: 14.5,
    fontFamily: FONT.semibold,
  },
  performerSub: {
    fontSize: 12,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  performerValue: {
    fontSize: 13.5,
    fontFamily: FONT.bold,
  },
  activityRow: {
    alignItems: "center",
    gap: 12,
    paddingVertical: 11,
  },
  activityDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  activityTitle: {
    fontSize: 13.5,
    fontFamily: FONT.medium,
  },
  activitySub: {
    fontSize: 12,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
});
