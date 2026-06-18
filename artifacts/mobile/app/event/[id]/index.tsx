import { Feather } from "@expo/vector-icons";
import { Stack, useLocalSearchParams } from "expo-router";
import React from "react";
import {
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  useGetEvent,
  useGetEventStats,
  useGetTeamPerformance,
} from "@workspace/api-client-react";

import {
  Avatar,
  CONTACT_STATUS_COLORS,
  ErrorState,
  FONT,
  LoadingState,
  prettyLabel,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { formatGregorian } from "@/lib/date";

function formatRange(start?: string | null, end?: string | null): string | null {
  const fmt = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return formatGregorian(new Date(y, (m ?? 1) - 1, d ?? 1), {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };
  if (start && end) return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`;
  if (start) return fmt(start);
  if (end) return fmt(end);
  return null;
}

export default function EventDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventId = Number(id);

  const eventQuery = useGetEvent(eventId);
  const statsQuery = useGetEventStats(eventId);
  const teamQuery = useGetTeamPerformance();

  const event = eventQuery.data;
  const stats = statsQuery.data;

  const leaderboard = [...(teamQuery.data ?? [])]
    .sort((a, b) => b.scanCount - a.scanCount)
    .slice(0, 8);
  const maxScans = leaderboard.length ? Math.max(...leaderboard.map((t) => t.scanCount), 1) : 1;

  const refreshing =
    eventQuery.isRefetching || statsQuery.isRefetching || teamQuery.isRefetching;

  function refetchAll() {
    eventQuery.refetch();
    statsQuery.refetch();
    teamQuery.refetch();
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: event?.name ?? "Event",
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.foreground,
          headerTitleStyle: { fontFamily: FONT.semibold },
        }}
      />

      {eventQuery.isLoading ? (
        <LoadingState />
      ) : eventQuery.isError || !event ? (
        <ErrorState onRetry={refetchAll} />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refetchAll}
              tintColor={colors.primary}
            />
          }
        >
          {/* Event header */}
          <View
            style={[
              styles.headerCard,
              { backgroundColor: colors.dark, borderRadius: colors.radius + 6 },
            ]}
          >
            <Text style={styles.eventName}>{event.name}</Text>
            {event.venue ? (
              <View style={styles.headerMeta}>
                <Feather name="map-pin" size={14} color="rgba(255,255,255,0.7)" />
                <Text style={styles.headerMetaText}>{event.venue}</Text>
              </View>
            ) : null}
            {formatRange(event.startDate, event.endDate) ? (
              <View style={styles.headerMeta}>
                <Feather name="calendar" size={14} color="rgba(255,255,255,0.7)" />
                <Text style={styles.headerMetaText}>
                  {formatRange(event.startDate, event.endDate)}
                </Text>
              </View>
            ) : null}
            {event.boothNumber ? (
              <View style={styles.headerMeta}>
                <Feather name="grid" size={14} color="rgba(255,255,255,0.7)" />
                <Text style={styles.headerMetaText}>Booth {event.boothNumber}</Text>
              </View>
            ) : null}
          </View>

          {event.description ? (
            <Text style={[styles.description, { color: colors.mutedForeground }]}>
              {event.description}
            </Text>
          ) : null}

          {/* Stats grid */}
          <View style={styles.statsGrid}>
            <StatCard
              icon="users"
              label="Contacts"
              value={stats?.contactCount ?? event.contactCount ?? 0}
              loading={statsQuery.isLoading}
              color="#3B82F6"
            />
            <StatCard
              icon="target"
              label="Leads"
              value={stats?.leadCount ?? event.leadCount ?? 0}
              loading={statsQuery.isLoading}
              color="#FF6B00"
            />
            <StatCard
              icon="award"
              label="Won"
              value={stats?.wonCount ?? 0}
              loading={statsQuery.isLoading}
              color="#22C55E"
            />
            <StatCard
              icon="trending-up"
              label="Conversion"
              value={`${Math.round(stats?.conversionRate ?? 0)}%`}
              loading={statsQuery.isLoading}
              color="#8B5CF6"
            />
          </View>

          {/* Pipeline breakdown */}
          {stats?.byStage && stats.byStage.length > 0 ? (
            <Section title="Pipeline breakdown">
              <View style={{ gap: 10 }}>
                {stats.byStage.map((s) => {
                  const color = CONTACT_STATUS_COLORS[s.status] ?? colors.primary;
                  const max = Math.max(...stats.byStage!.map((x) => x.count), 1);
                  return (
                    <View key={s.status}>
                      <View style={styles.stageRow}>
                        <Text style={[styles.stageLabel, { color: colors.foreground }]}>
                          {s.label ?? prettyLabel(s.status)}
                        </Text>
                        <Text style={[styles.stageCount, { color: colors.mutedForeground }]}>
                          {s.count}
                        </Text>
                      </View>
                      <View style={[styles.barTrack, { backgroundColor: colors.muted }]}>
                        <View
                          style={[
                            styles.barFill,
                            { backgroundColor: color, width: `${(s.count / max) * 100}%` },
                          ]}
                        />
                      </View>
                    </View>
                  );
                })}
              </View>
            </Section>
          ) : null}

          {/* Team leaderboard */}
          <Section title="Team leaderboard">
            {teamQuery.isLoading ? (
              <View style={{ height: 80 }}>
                <LoadingState />
              </View>
            ) : leaderboard.length === 0 ? (
              <Text style={[styles.emptyLine, { color: colors.mutedForeground }]}>
                No scan activity yet.
              </Text>
            ) : (
              <View style={{ gap: 12 }}>
                {leaderboard.map((member, idx) => (
                  <View key={member.userId} style={styles.leaderRow}>
                    <Text
                      style={[
                        styles.rank,
                        { color: idx < 3 ? colors.primary : colors.mutedForeground },
                      ]}
                    >
                      {idx + 1}
                    </Text>
                    <Avatar name={member.userName} size={36} color={colors.primary} />
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={[styles.leaderName, { color: colors.foreground }]}>
                        {member.userName}
                      </Text>
                      <View style={[styles.barTrack, { backgroundColor: colors.muted, marginTop: 5 }]}>
                        <View
                          style={[
                            styles.barFill,
                            {
                              backgroundColor: colors.primary,
                              width: `${(member.scanCount / maxScans) * 100}%`,
                            },
                          ]}
                        />
                      </View>
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      <Text style={[styles.leaderStat, { color: colors.foreground }]}>
                        {member.scanCount}
                      </Text>
                      <Text style={[styles.leaderStatLabel, { color: colors.mutedForeground }]}>
                        scans
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </Section>
        </ScrollView>
      )}
    </View>
  );
}

function StatCard({
  icon,
  label,
  value,
  color,
  loading,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string | number;
  color: string;
  loading?: boolean;
}) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.statCard,
        { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
      ]}
    >
      <View style={[styles.statIcon, { backgroundColor: color + "1A" }]}>
        <Feather name={icon} size={16} color={color} />
      </View>
      <Text style={[styles.statValue, { color: colors.foreground }]}>
        {loading ? "—" : value}
      </Text>
      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{label}</Text>
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
  headerCard: {
    padding: 20,
  },
  eventName: {
    fontSize: 22,
    fontFamily: FONT.bold,
    color: "#FFFFFF",
    marginBottom: 10,
  },
  headerMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  headerMetaText: {
    fontSize: 14,
    fontFamily: FONT.regular,
    color: "rgba(255,255,255,0.85)",
  },
  description: {
    fontSize: 14,
    fontFamily: FONT.regular,
    lineHeight: 21,
    marginTop: 14,
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 20,
  },
  statCard: {
    width: "47%",
    flexGrow: 1,
    borderWidth: 1,
    padding: 14,
  },
  statIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  statValue: {
    fontSize: 24,
    fontFamily: FONT.bold,
  },
  statLabel: {
    fontSize: 12.5,
    fontFamily: FONT.medium,
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
  },
  stageLabel: {
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
  emptyLine: {
    fontSize: 14,
    fontFamily: FONT.regular,
  },
  leaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rank: {
    width: 18,
    fontSize: 15,
    fontFamily: FONT.bold,
    textAlign: "center",
  },
  leaderName: {
    fontSize: 14.5,
    fontFamily: FONT.semibold,
  },
  leaderStat: {
    fontSize: 16,
    fontFamily: FONT.bold,
  },
  leaderStatLabel: {
    fontSize: 11,
    fontFamily: FONT.regular,
  },
});
