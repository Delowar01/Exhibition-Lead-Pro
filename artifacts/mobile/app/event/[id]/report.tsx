import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
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
  type EventReportDayCount,
  type EventReportTeamItem,
  type EventReportUserCount,
  type GetEventReportParams,
  useGetTeamPerformance,
  useGetEventReport,
} from "@workspace/api-client-react";

import {
  Avatar,
  CONTACT_STATUS_COLORS,
  ErrorState,
  FONT,
  LEAD_TEMPERATURE_COLORS,
  LoadingState,
  prettyLabel,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { formatGregorian } from "@/lib/date";

type DatePreset = "all" | "7d" | "30d";

const DATE_PRESETS: { key: DatePreset; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
];

const STATUS_FILTERS = ["new", "contacted", "quotation_sent", "negotiation", "won", "lost"];
const TEMPERATURE_FILTERS = ["hot", "warm", "cold"];

function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateFromPreset(preset: DatePreset): string | undefined {
  if (preset === "all") return undefined;
  const days = preset === "7d" ? 6 : 29;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return localDateStr(d);
}

function formatMoney(value: number): string {
  return `$${Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function shortDay(s: string): string {
  const [y, m, d] = s.split("-").map(Number);
  return formatGregorian(new Date(y, (m ?? 1) - 1, d ?? 1), {
    month: "short",
    day: "numeric",
  });
}

export default function EventReportScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventId = Number(id);

  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [assignedToId, setAssignedToId] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [temperature, setTemperature] = useState<string | null>(null);

  const teamQuery = useGetTeamPerformance();
  const teamMembers = teamQuery.data ?? [];

  const params: GetEventReportParams = useMemo(() => {
    const dateFrom = dateFromPreset(datePreset);
    return {
      eventId,
      ...(dateFrom ? { dateFrom } : {}),
      ...(assignedToId != null ? { assignedToId } : {}),
      ...(status ? { status } : {}),
      ...(temperature ? { temperature } : {}),
    };
  }, [eventId, datePreset, assignedToId, status, temperature]);

  const query = useGetEventReport(params);
  const report = query.data;

  const hasFilters =
    datePreset !== "all" || assignedToId != null || status != null || temperature != null;

  function resetFilters() {
    if (Platform.OS !== "web") Haptics.selectionAsync();
    setDatePreset("all");
    setAssignedToId(null);
    setStatus(null);
    setTemperature(null);
  }

  function tap(fn: () => void) {
    if (Platform.OS !== "web") Haptics.selectionAsync();
    fn();
  }

  const metrics: { label: string; value: string; icon: keyof typeof Feather.glyphMap; color: string }[] =
    report
      ? [
          { label: "Total Leads", value: String(report.totalLeads), icon: "users", color: colors.primary },
          { label: "Hot", value: String(report.hotLeads), icon: "trending-up", color: LEAD_TEMPERATURE_COLORS.hot },
          { label: "Warm", value: String(report.warmLeads), icon: "thermometer", color: LEAD_TEMPERATURE_COLORS.warm },
          { label: "Cold", value: String(report.coldLeads), icon: "wind", color: LEAD_TEMPERATURE_COLORS.cold },
          { label: "Meetings", value: String(report.meetings), icon: "calendar", color: "#06B6D4" },
          { label: "Follow-Ups", value: String(report.followUps), icon: "clock", color: "#8B5CF6" },
          { label: "Won", value: String(report.wonDeals), icon: "award", color: "#22C55E" },
          { label: "Lost", value: String(report.lostDeals), icon: "x-circle", color: "#EF4444" },
        ]
      : [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: report?.eventName ?? "Event Report",
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.foreground,
          headerTitleStyle: { fontFamily: FONT.semibold },
        }}
      />

      {query.isLoading && !report ? (
        <LoadingState />
      ) : query.isError && !report ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => query.refetch()}
              tintColor={colors.primary}
            />
          }
        >
          {/* Filters */}
          <View style={styles.filtersHeader}>
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>FILTERS</Text>
            {hasFilters ? (
              <Pressable onPress={resetFilters} hitSlop={8}>
                <Text style={[styles.reset, { color: colors.primary }]}>Reset</Text>
              </Pressable>
            ) : null}
          </View>

          <FilterRow label="Date range">
            {DATE_PRESETS.map((p) => (
              <Chip
                key={p.key}
                label={p.label}
                active={datePreset === p.key}
                onPress={() => tap(() => setDatePreset(p.key))}
              />
            ))}
          </FilterRow>

          {teamMembers.length > 0 ? (
            <FilterRow label="Team member">
              <Chip
                label="Everyone"
                active={assignedToId == null}
                onPress={() => tap(() => setAssignedToId(null))}
              />
              {teamMembers.map((m) => (
                <Chip
                  key={m.userId}
                  label={m.userName}
                  active={assignedToId === m.userId}
                  onPress={() => tap(() => setAssignedToId(m.userId))}
                />
              ))}
            </FilterRow>
          ) : null}

          <FilterRow label="Lead status">
            <Chip label="Any" active={status == null} onPress={() => tap(() => setStatus(null))} />
            {STATUS_FILTERS.map((s) => (
              <Chip
                key={s}
                label={prettyLabel(s)}
                active={status === s}
                color={CONTACT_STATUS_COLORS[s]}
                onPress={() => tap(() => setStatus(status === s ? null : s))}
              />
            ))}
          </FilterRow>

          <FilterRow label="Temperature">
            <Chip
              label="Any"
              active={temperature == null}
              onPress={() => tap(() => setTemperature(null))}
            />
            {TEMPERATURE_FILTERS.map((t) => (
              <Chip
                key={t}
                label={prettyLabel(t)}
                active={temperature === t}
                color={LEAD_TEMPERATURE_COLORS[t]}
                onPress={() => tap(() => setTemperature(temperature === t ? null : t))}
              />
            ))}
          </FilterRow>

          {/* Metrics */}
          <View style={styles.statsGrid}>
            {metrics.map((m) => (
              <View
                key={m.label}
                style={[
                  styles.statCard,
                  { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
                ]}
              >
                <View style={[styles.statIcon, { backgroundColor: m.color + "1A" }]}>
                  <Feather name={m.icon} size={15} color={m.color} />
                </View>
                <Text style={[styles.statValue, { color: colors.foreground }]}>{m.value}</Text>
                <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{m.label}</Text>
              </View>
            ))}
          </View>

          {/* Pipeline value */}
          <View
            style={[
              styles.pipelineCard,
              { backgroundColor: colors.dark, borderRadius: colors.radius + 6 },
            ]}
          >
            <View style={[styles.statIcon, { backgroundColor: "rgba(255,255,255,0.14)" }]}>
              <Feather name="dollar-sign" size={16} color="#FFFFFF" />
            </View>
            <View>
              <Text style={styles.pipelineValue}>
                {formatMoney(report?.pipelineValue ?? 0)}
              </Text>
              <Text style={styles.pipelineLabel}>Pipeline value</Text>
            </View>
          </View>

          {/* Qualification distribution */}
          <Section title="Qualification distribution">
            <View style={{ gap: 10 }}>
              <DistRow
                label="Hot"
                count={report?.qualificationDistribution.hot ?? 0}
                max={qualMax(report)}
                color={LEAD_TEMPERATURE_COLORS.hot}
              />
              <DistRow
                label="Warm"
                count={report?.qualificationDistribution.warm ?? 0}
                max={qualMax(report)}
                color={LEAD_TEMPERATURE_COLORS.warm}
              />
              <DistRow
                label="Cold"
                count={report?.qualificationDistribution.cold ?? 0}
                max={qualMax(report)}
                color={LEAD_TEMPERATURE_COLORS.cold}
              />
            </View>
          </Section>

          {/* Status distribution */}
          {report && report.statusDistribution.length > 0 ? (
            <Section title="Status distribution">
              <View style={{ gap: 10 }}>
                {report.statusDistribution.map((s) => (
                  <DistRow
                    key={s.status}
                    label={prettyLabel(s.status)}
                    count={s.count}
                    max={Math.max(...report.statusDistribution.map((x) => x.count), 1)}
                    color={CONTACT_STATUS_COLORS[s.status] ?? colors.primary}
                  />
                ))}
              </View>
            </Section>
          ) : null}

          {/* Leads by day */}
          {report && report.leadsByDay.length > 0 ? (
            <Section title="Leads by day">
              <LeadsByDayChart data={report.leadsByDay} color={colors.primary} />
            </Section>
          ) : null}

          {/* Leads by user */}
          {report && report.leadsByUser.length > 0 ? (
            <Section title="Leads by user">
              <View style={{ gap: 10 }}>
                {[...report.leadsByUser]
                  .sort((a, b) => b.count - a.count)
                  .map((u: EventReportUserCount) => (
                    <DistRow
                      key={u.userId}
                      label={u.userName}
                      count={u.count}
                      max={Math.max(...report.leadsByUser.map((x) => x.count), 1)}
                      color={colors.primary}
                    />
                  ))}
              </View>
            </Section>
          ) : null}

          {/* Team performance */}
          {report && report.teamPerformance.length > 0 ? (
            <Section title="Team performance">
              <View style={{ gap: 12 }}>
                {[...report.teamPerformance]
                  .sort((a, b) => b.leads - a.leads)
                  .map((m) => (
                    <View key={m.userId} style={styles.teamRow}>
                      <Avatar name={m.userName} size={36} color={colors.primary} />
                      <View style={{ flex: 1 }}>
                        <Text numberOfLines={1} style={[styles.teamName, { color: colors.foreground }]}>
                          {m.userName}
                        </Text>
                        <Text style={[styles.teamMeta, { color: colors.mutedForeground }]}>
                          {m.leads} lead{m.leads === 1 ? "" : "s"} · {m.won} won
                        </Text>
                      </View>
                    </View>
                  ))}
              </View>
            </Section>
          ) : null}

          {/* Top performer */}
          {report && report.teamPerformance.length > 0 ? (
            <Section title="Top performer">
              <View style={{ gap: 12 }}>
                {rankPerformers(report.teamPerformance)
                  .slice(0, 1)
                  .map((m) => (
                    <PerformerRow
                      key={m.userId}
                      performer={m}
                      onPress={() => {
                        if (Platform.OS !== "web") Haptics.selectionAsync();
                        router.push(`/event/${eventId}/member/${m.userId}`);
                      }}
                    />
                  ))}
              </View>
            </Section>
          ) : null}

          {report &&
          report.totalLeads === 0 &&
          report.statusDistribution.length === 0 &&
          report.leadsByDay.length === 0 ? (
            <Text style={[styles.emptyLine, { color: colors.mutedForeground }]}>
              No leads match these filters.
            </Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

function qualMax(report?: { qualificationDistribution: { hot: number; warm: number; cold: number } }): number {
  if (!report) return 1;
  const q = report.qualificationDistribution;
  return Math.max(q.hot, q.warm, q.cold, 1);
}

// Rank highest total leads first, tie-break by qualified leads.
function rankPerformers(items: EventReportTeamItem[]): EventReportTeamItem[] {
  return [...items].sort((a, b) => b.leads - a.leads || b.qualified - a.qualified);
}

function PerformerRow({
  performer,
  onPress,
}: {
  performer: EventReportTeamItem;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.performerRow, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Avatar name={performer.userName} uri={performer.avatarUrl} size={44} color={colors.primary} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={[styles.teamName, { color: colors.foreground }]}>
          {performer.userName}
        </Text>
        <Text style={[styles.teamMeta, { color: colors.mutedForeground }]}>
          {performer.leads} lead{performer.leads === 1 ? "" : "s"} · {performer.qualified} qualified
        </Text>
      </View>
      <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
    </Pressable>
  );
}

function LeadsByDayChart({ data, color }: { data: EventReportDayCount[]; color: string }) {
  const colors = useColors();
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <View style={styles.chartRow}>
      {data.map((d) => (
        <View key={d.date} style={styles.chartCol}>
          <Text style={[styles.chartValue, { color: colors.mutedForeground }]}>{d.count}</Text>
          <View style={[styles.chartBarTrack, { backgroundColor: colors.muted }]}>
            <View
              style={[
                styles.chartBarFill,
                { backgroundColor: color, height: `${(d.count / max) * 100}%` },
              ]}
            />
          </View>
          <Text numberOfLines={1} style={[styles.chartLabel, { color: colors.mutedForeground }]}>
            {shortDay(d.date)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function DistRow({
  label,
  count,
  max,
  color,
}: {
  label: string;
  count: number;
  max: number;
  color: string;
}) {
  const colors = useColors();
  return (
    <View>
      <View style={styles.stageRow}>
        <Text numberOfLines={1} style={[styles.stageLabel, { color: colors.foreground }]}>
          {label}
        </Text>
        <Text style={[styles.stageCount, { color: colors.mutedForeground }]}>{count}</Text>
      </View>
      <View style={[styles.barTrack, { backgroundColor: colors.muted }]}>
        <View style={[styles.barFill, { backgroundColor: color, width: `${(count / max) * 100}%` }]} />
      </View>
    </View>
  );
}

function Chip({
  label,
  active,
  color,
  onPress,
}: {
  label: string;
  active: boolean;
  color?: string;
  onPress: () => void;
}) {
  const colors = useColors();
  const accent = color ?? colors.primary;
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: active ? accent + "1A" : colors.card,
          borderColor: active ? accent : colors.border,
          borderRadius: colors.radius,
        },
      ]}
    >
      <Text
        style={[
          styles.chipText,
          { color: active ? accent : colors.mutedForeground },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={[styles.filterLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
      >
        {children}
      </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ marginTop: 24 }}>
      <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
        {title.toUpperCase()}
      </Text>
      <View
        style={[
          styles.sectionBody,
          { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  filtersHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  reset: {
    fontSize: 13,
    fontFamily: FONT.semibold,
  },
  filterLabel: {
    fontSize: 12,
    fontFamily: FONT.medium,
    marginBottom: 7,
  },
  chipRow: {
    gap: 8,
    paddingRight: 4,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 13,
    fontFamily: FONT.semibold,
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 16,
  },
  statCard: {
    width: "47%",
    flexGrow: 1,
    borderWidth: 1,
    padding: 14,
  },
  statIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  statValue: {
    fontSize: 22,
    fontFamily: FONT.bold,
  },
  statLabel: {
    fontSize: 12.5,
    fontFamily: FONT.medium,
    marginTop: 2,
  },
  pipelineCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 18,
    marginTop: 14,
  },
  pipelineValue: {
    color: "#FFFFFF",
    fontSize: 24,
    fontFamily: FONT.bold,
  },
  pipelineLabel: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 13,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.6,
    marginBottom: 8,
    marginLeft: 4,
  },
  sectionBody: {
    borderWidth: 1,
    padding: 16,
  },
  stageRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 6,
    gap: 12,
  },
  stageLabel: {
    flex: 1,
    fontSize: 13.5,
    fontFamily: FONT.medium,
  },
  stageCount: {
    fontSize: 13.5,
    fontFamily: FONT.semibold,
  },
  barTrack: {
    height: 8,
    borderRadius: 4,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 4,
  },
  chartRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  chartCol: {
    flex: 1,
    alignItems: "center",
    gap: 6,
  },
  chartValue: {
    fontSize: 11,
    fontFamily: FONT.medium,
  },
  chartBarTrack: {
    width: "70%",
    height: 90,
    borderRadius: 6,
    overflow: "hidden",
    justifyContent: "flex-end",
  },
  chartBarFill: {
    width: "100%",
    borderRadius: 6,
  },
  chartLabel: {
    fontSize: 10.5,
    fontFamily: FONT.regular,
  },
  teamRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  performerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  teamName: {
    fontSize: 14.5,
    fontFamily: FONT.semibold,
  },
  teamMeta: {
    fontSize: 12.5,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  emptyLine: {
    fontSize: 14,
    fontFamily: FONT.regular,
    textAlign: "center",
    marginTop: 28,
  },
});
