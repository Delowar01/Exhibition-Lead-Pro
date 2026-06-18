import { Feather } from "@expo/vector-icons";
import { Stack, useLocalSearchParams } from "expo-router";
import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type TeamMemberActivity,
  useGetTeamMemberReport,
} from "@workspace/api-client-react";

import { Avatar, ErrorState, FONT, LoadingState } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { formatGregorian } from "@/lib/date";

function formatMoney(value: number): string {
  return `$${Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return formatGregorian(d, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const ACTIVITY_ICONS: Record<string, keyof typeof Feather.glyphMap> = {
  captured: "user-plus",
  status_change: "git-commit",
};

export default function TeamMemberReportScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { id, userId } = useLocalSearchParams<{ id: string; userId: string }>();
  const eventId = Number(id);
  const memberId = Number(userId);

  const query = useGetTeamMemberReport({ eventId, userId: memberId });
  const report = query.data;

  const metrics: { label: string; value: string; icon: keyof typeof Feather.glyphMap; color: string }[] =
    report
      ? [
          { label: "Total Leads", value: String(report.totalLeads), icon: "users", color: colors.primary },
          { label: "Qualified", value: String(report.qualifiedLeads), icon: "check-circle", color: "#22C55E" },
          { label: "Meetings", value: String(report.meetings), icon: "calendar", color: "#06B6D4" },
          { label: "Follow-Ups", value: String(report.followUps), icon: "clock", color: "#8B5CF6" },
          { label: "Won", value: String(report.won), icon: "award", color: "#22C55E" },
          { label: "Lost", value: String(report.lost), icon: "x-circle", color: "#EF4444" },
          { label: "Conversion Rate", value: `${Math.round(report.conversionRate)}%`, icon: "trending-up", color: "#F59E0B" },
        ]
      : [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: report?.userName ?? "Team Member",
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
          {/* Header */}
          <View style={styles.header}>
            <Avatar name={report?.userName} uri={report?.avatarUrl} size={64} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={[styles.headerName, { color: colors.foreground }]}>
                {report?.userName ?? ""}
              </Text>
              <Text numberOfLines={1} style={[styles.headerMeta, { color: colors.mutedForeground }]}>
                {report?.eventName ?? ""}
              </Text>
            </View>
          </View>

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
              <Text style={styles.pipelineValue}>{formatMoney(report?.pipelineValue ?? 0)}</Text>
              <Text style={styles.pipelineLabel}>Pipeline value</Text>
            </View>
          </View>

          {/* Activity timeline */}
          <View style={{ marginTop: 24 }}>
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>ACTIVITY TIMELINE</Text>
            <View
              style={[
                styles.sectionBody,
                { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
              ]}
            >
              {report && report.activity.length > 0 ? (
                <View style={{ gap: 16 }}>
                  {report.activity.map((a: TeamMemberActivity, i) => (
                    <ActivityRow key={`${a.type}-${a.timestamp}-${i}`} activity={a} />
                  ))}
                </View>
              ) : (
                <Text style={[styles.emptyLine, { color: colors.mutedForeground }]}>
                  No activity recorded yet.
                </Text>
              )}
            </View>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function ActivityRow({ activity }: { activity: TeamMemberActivity }) {
  const colors = useColors();
  const icon = ACTIVITY_ICONS[activity.type] ?? "activity";
  return (
    <View style={styles.activityRow}>
      <View style={[styles.activityIcon, { backgroundColor: colors.primary + "1A" }]}>
        <Feather name={icon} size={14} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.activityLabel, { color: colors.foreground }]}>
          {activity.label}
        </Text>
        <Text numberOfLines={1} style={[styles.activityContact, { color: colors.mutedForeground }]}>
          {activity.contactName}
        </Text>
        <Text style={[styles.activityTime, { color: colors.mutedForeground }]}>
          {formatTimestamp(activity.timestamp)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginBottom: 4,
  },
  headerName: {
    fontSize: 20,
    fontFamily: FONT.bold,
  },
  headerMeta: {
    fontSize: 13.5,
    fontFamily: FONT.regular,
    marginTop: 3,
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 20,
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
  activityRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  activityIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  activityLabel: {
    fontSize: 14,
    fontFamily: FONT.semibold,
  },
  activityContact: {
    fontSize: 13,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  activityTime: {
    fontSize: 12,
    fontFamily: FONT.regular,
    marginTop: 3,
  },
  emptyLine: {
    fontSize: 14,
    fontFamily: FONT.regular,
    textAlign: "center",
    paddingVertical: 8,
  },
});
