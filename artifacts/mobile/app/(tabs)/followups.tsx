import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React from "react";
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
  type Contact,
  useListContacts,
  useUpdateContact,
} from "@workspace/api-client-react";

import {
  Avatar,
  Badge,
  EmptyState,
  ErrorState,
  FONT,
  LEAD_TEMPERATURE_COLORS,
  LoadingState,
  prettyLabel,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";

type Bucket = "overdue" | "today" | "week" | "later";

const BUCKET_META: Record<
  Bucket,
  { title: string; icon: keyof typeof Feather.glyphMap; color: string }
> = {
  overdue: { title: "Overdue", icon: "alert-circle", color: "#EF4444" },
  today: { title: "Today", icon: "zap", color: "#FF6B00" },
  week: { title: "This Week", icon: "calendar", color: "#06B6D4" },
  later: { title: "Later", icon: "clock", color: "#8B5CF6" },
};

const BUCKET_ORDER: Bucket[] = ["overdue", "today", "week", "later"];

function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}

function parseLocal(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function formatFollowUp(s: string): string {
  return parseLocal(s).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function contactName(c: Contact): string {
  if (c.fullName) return c.fullName;
  const parts = [c.firstName, c.lastName].filter(Boolean);
  return parts.length ? parts.join(" ") : "Unnamed contact";
}

function bucketFor(date: string, today: string, weekEnd: string): Bucket {
  if (date < today) return "overdue";
  if (date === today) return "today";
  if (date <= weekEnd) return "week";
  return "later";
}

export default function FollowUpsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const query = useListContacts({ limit: 200 });
  const updateContact = useUpdateContact();

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  const today = localDateStr(new Date());
  const weekEnd = addDaysStr(6);

  const withFollowUp = (query.data?.contacts ?? [])
    .filter((c) => !!c.followUpDate)
    .sort((a, b) => (a.followUpDate! < b.followUpDate! ? -1 : 1));

  const grouped: Record<Bucket, Contact[]> = {
    overdue: [],
    today: [],
    week: [],
    later: [],
  };
  for (const c of withFollowUp) {
    grouped[bucketFor(c.followUpDate!, today, weekEnd)].push(c);
  }

  const total = withFollowUp.length;

  async function markDone(c: Contact) {
    if (Platform.OS !== "web")
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await updateContact.mutateAsync({ id: c.id, data: { followUpDate: null } });
    query.refetch();
  }

  function renderItem(c: Contact) {
    const temp = c.leadTemperature;
    return (
      <Pressable
        key={c.id}
        onPress={() => router.push(`/contact/${c.id}`)}
        style={({ pressed }) => [
          styles.item,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            borderRadius: colors.radius + 4,
            opacity: pressed ? 0.8 : 1,
          },
        ]}
      >
        <Avatar name={contactName(c)} size={42} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={[styles.itemName, { color: colors.foreground }]}>
            {contactName(c)}
          </Text>
          <Text numberOfLines={1} style={[styles.itemSub, { color: colors.mutedForeground }]}>
            {c.contactCompany ?? prettyLabel(c.status)}
          </Text>
          <View style={styles.itemMeta}>
            <Feather name="calendar" size={12} color={colors.mutedForeground} />
            <Text style={[styles.itemDate, { color: colors.mutedForeground }]}>
              {formatFollowUp(c.followUpDate!)}
            </Text>
            {temp ? (
              <Badge
                label={prettyLabel(temp)}
                color={LEAD_TEMPERATURE_COLORS[temp] ?? colors.mutedForeground}
              />
            ) : null}
          </View>
        </View>
        <Pressable
          onPress={() => markDone(c)}
          hitSlop={8}
          disabled={updateContact.isPending}
          style={({ pressed }) => [
            styles.doneBtn,
            {
              backgroundColor: colors.success + "1A",
              borderRadius: colors.radius,
              opacity: pressed ? 0.6 : 1,
            },
          ]}
        >
          <Feather name="check" size={18} color={colors.success} />
        </Pressable>
      </Pressable>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 14, paddingHorizontal: 20 }}>
        <Text style={[styles.heading, { color: colors.foreground }]}>Follow-Ups</Text>
        <Text style={[styles.headingSub, { color: colors.mutedForeground }]}>
          {total === 0 ? "Nothing scheduled" : `${total} scheduled`}
        </Text>
      </View>

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : total === 0 ? (
        <View style={{ flex: 1 }}>
          <EmptyState
            icon="check-circle"
            title="All caught up"
            subtitle="Set a follow-up date on a contact and it will show up here."
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 16,
            paddingBottom: insets.bottom + 110,
          }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => query.refetch()}
              tintColor={colors.primary}
            />
          }
        >
          {BUCKET_ORDER.map((bucket) => {
            const items = grouped[bucket];
            if (items.length === 0) return null;
            const meta = BUCKET_META[bucket];
            return (
              <View key={bucket} style={{ marginBottom: 22 }}>
                <View style={styles.groupHeader}>
                  <Feather name={meta.icon} size={15} color={meta.color} />
                  <Text style={[styles.groupTitle, { color: colors.foreground }]}>
                    {meta.title}
                  </Text>
                  <View style={[styles.countPill, { backgroundColor: meta.color + "1A" }]}>
                    <Text style={[styles.countText, { color: meta.color }]}>
                      {items.length}
                    </Text>
                  </View>
                </View>
                <View style={{ gap: 10 }}>{items.map(renderItem)}</View>
              </View>
            );
          })}
        </ScrollView>
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
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  groupTitle: {
    fontSize: 16,
    fontFamily: FONT.bold,
  },
  countPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  countText: {
    fontSize: 12,
    fontFamily: FONT.semibold,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderWidth: 1,
  },
  itemName: {
    fontSize: 15.5,
    fontFamily: FONT.semibold,
  },
  itemSub: {
    fontSize: 13,
    fontFamily: FONT.regular,
    marginTop: 1,
  },
  itemMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
  },
  itemDate: {
    fontSize: 12.5,
    fontFamily: FONT.medium,
    marginRight: 4,
  },
  doneBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
});
