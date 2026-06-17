import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type Event, useListEvents } from "@workspace/api-client-react";

import {
  EmptyState,
  ErrorState,
  FONT,
  LoadingState,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";

function formatDateRange(start?: string | null, end?: string | null): string {
  if (!start) return "Date TBD";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const s = new Date(start).toLocaleDateString(undefined, opts);
  if (!end || end === start) return s;
  const e = new Date(end).toLocaleDateString(undefined, opts);
  return `${s} – ${e}`;
}

export default function EventsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const query = useListEvents({ limit: 100 });
  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  const events = query.data?.events ?? [];

  function renderItem({ item }: { item: Event }) {
    return (
      <View
        style={[
          styles.card,
          { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
        ]}
      >
        <View style={styles.cardHeader}>
          <View
            style={[styles.dateBadge, { backgroundColor: colors.accent, borderRadius: colors.radius }]}
          >
            <Feather name="calendar" size={16} color={colors.primary} />
            <Text style={[styles.dateText, { color: colors.primary }]}>
              {formatDateRange(item.startDate, item.endDate)}
            </Text>
          </View>
        </View>
        <Text numberOfLines={2} style={[styles.eventName, { color: colors.foreground }]}>
          {item.name}
        </Text>
        {item.venue ? (
          <View style={styles.metaRow}>
            <Feather name="map-pin" size={14} color={colors.mutedForeground} />
            <Text numberOfLines={1} style={[styles.metaText, { color: colors.mutedForeground }]}>
              {item.venue}
              {item.boothNumber ? ` · Booth ${item.boothNumber}` : ""}
            </Text>
          </View>
        ) : null}
        <View style={[styles.statsRow, { borderTopColor: colors.border }]}>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.foreground }]}>
              {item.contactCount ?? 0}
            </Text>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>
              Contacts
            </Text>
          </View>
          <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.foreground }]}>
              {item.leadCount ?? 0}
            </Text>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>
              Leads
            </Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 12, paddingHorizontal: 20 }}>
        <Text style={[styles.heading, { color: colors.foreground }]}>Events</Text>
        <Text style={[styles.headingSub, { color: colors.mutedForeground }]}>
          {events.length} tracked
        </Text>
      </View>

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <FlatList
          data={events}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          contentContainerStyle={{
            padding: 20,
            paddingBottom: insets.bottom + 100,
            gap: 12,
          }}
          scrollEnabled={events.length > 0}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => query.refetch()}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={{ paddingTop: 60 }}>
              <EmptyState
                icon="calendar"
                title="No events yet"
                subtitle="Events you attend will appear here."
              />
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: {
    fontSize: 30,
    fontFamily: FONT.bold,
  },
  headingSub: {
    fontSize: 14,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  card: {
    padding: 16,
    borderWidth: 1,
  },
  cardHeader: {
    flexDirection: "row",
    marginBottom: 12,
  },
  dateBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  dateText: {
    fontSize: 12.5,
    fontFamily: FONT.semibold,
  },
  eventName: {
    fontSize: 18,
    fontFamily: FONT.bold,
    lineHeight: 24,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
  },
  metaText: {
    fontSize: 13.5,
    fontFamily: FONT.regular,
    flex: 1,
  },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
  },
  stat: {
    flex: 1,
    alignItems: "center",
  },
  statDivider: {
    width: 1,
    height: 28,
  },
  statValue: {
    fontSize: 20,
    fontFamily: FONT.bold,
  },
  statLabel: {
    fontSize: 12,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
});
