import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type FollowUp,
  type FollowUpUpdateStatus,
  useListFollowUps,
  useUpdateFollowUp,
} from "@workspace/api-client-react";

import { DateTimeField } from "@/components/DateTimeField";
import {
  Avatar,
  Badge,
  EmptyState,
  ErrorState,
  FOLLOWUP_STATUS_COLORS,
  FONT,
  LoadingState,
  prettyLabel,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { formatGregorian } from "@/lib/date";

type Tab = "upcoming" | "completed" | "cancelled";
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
const TABS: { key: Tab; label: string }[] = [
  { key: "upcoming", label: "Upcoming" },
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Cancelled" },
];

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

function formatDate(s?: string | null, time?: string | null): string {
  if (!s) return "No date";
  const base = formatGregorian(parseLocal(s), {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  if (!time) return base;
  const [h, m] = time.split(":").map((p) => parseInt(p, 10));
  const period = h >= 12 ? "PM" : "AM";
  const hr12 = h % 12 === 0 ? 12 : h % 12;
  return `${base} · ${hr12}:${String(m).padStart(2, "0")} ${period}`;
}

function bucketFor(date: string | null | undefined, today: string, weekEnd: string): Bucket {
  if (!date) return "later";
  if (date < today) return "overdue";
  if (date === today) return "today";
  if (date <= weekEnd) return "week";
  return "later";
}

export default function FollowUpsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("upcoming");
  const [active, setActive] = useState<FollowUp | null>(null);

  const query = useListFollowUps();
  const updateFollowUp = useUpdateFollowUp();

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);
  const today = localDateStr(new Date());
  const weekEnd = addDaysStr(6);

  const all = query.data?.followUps ?? [];
  const visible = useMemo(() => {
    if (tab === "completed") return all.filter((f) => f.status === "completed");
    if (tab === "cancelled") return all.filter((f) => f.status === "cancelled");
    return all.filter((f) => f.status === "pending");
  }, [all, tab]);

  const grouped: Record<Bucket, FollowUp[]> = {
    overdue: [],
    today: [],
    week: [],
    later: [],
  };
  for (const f of [...visible].sort((a, b) =>
    (a.scheduledDate ?? "9999") < (b.scheduledDate ?? "9999") ? -1 : 1,
  )) {
    grouped[bucketFor(f.scheduledDate, today, weekEnd)].push(f);
  }

  function renderItem(f: FollowUp) {
    const statusColor = FOLLOWUP_STATUS_COLORS[f.status] ?? colors.mutedForeground;
    return (
      <Pressable
        key={f.id}
        onPress={() => router.push(`/contact/${f.contactId}`)}
        style={({ pressed }) => [
          styles.item,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            borderRadius: colors.radius + 4,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <Avatar name={f.contactName ?? "?"} size={42} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={[styles.itemName, { color: colors.foreground }]}>
            {f.contactName ?? "Contact"}
          </Text>
          {f.notes ? (
            <Text numberOfLines={1} style={[styles.itemSub, { color: colors.mutedForeground }]}>
              {f.notes}
            </Text>
          ) : null}
          <View style={styles.itemMeta}>
            <Feather name="calendar" size={12} color={colors.mutedForeground} />
            <Text style={[styles.itemDate, { color: colors.mutedForeground }]}>
              {formatDate(f.scheduledDate, f.scheduledTime)}
            </Text>
            <Badge label={prettyLabel(f.status)} color={statusColor} />
          </View>
        </View>
        {tab === "upcoming" ? (
          <Pressable
            onPress={() => {
              if (Platform.OS !== "web") Haptics.selectionAsync();
              setActive(f);
            }}
            hitSlop={8}
            style={({ pressed }) => [
              styles.actionBtn,
              { backgroundColor: colors.muted, borderRadius: colors.radius, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <Feather name="more-horizontal" size={18} color={colors.foreground} />
          </Pressable>
        ) : null}
      </Pressable>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 14, paddingHorizontal: 20 }}>
        <Text style={[styles.heading, { color: colors.foreground }]}>Follow-Ups</Text>
        <View style={[styles.tabBar, { backgroundColor: colors.muted, borderRadius: colors.radius }]}>
          {TABS.map((t) => {
            const isActive = tab === t.key;
            return (
              <Pressable
                key={t.key}
                onPress={() => {
                  if (Platform.OS !== "web") Haptics.selectionAsync();
                  setTab(t.key);
                }}
                style={[
                  styles.tab,
                  isActive && { backgroundColor: colors.card, borderRadius: colors.radius - 2 },
                ]}
              >
                <Text
                  style={[
                    styles.tabText,
                    { color: isActive ? colors.foreground : colors.mutedForeground },
                  ]}
                >
                  {t.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : visible.length === 0 ? (
        <View style={{ flex: 1 }}>
          <EmptyState
            icon="check-circle"
            title={tab === "upcoming" ? "All caught up" : "Nothing here"}
            subtitle={
              tab === "upcoming"
                ? "Schedule a follow-up from a contact and it will show up here."
                : `No ${tab} follow-ups yet.`
            }
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
          {tab === "upcoming" ? (
            BUCKET_ORDER.map((bucket) => {
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
            })
          ) : (
            <View style={{ gap: 10 }}>{visible.map(renderItem)}</View>
          )}
        </ScrollView>
      )}

      <ActionSheet
        followUp={active}
        onClose={() => setActive(null)}
        pending={updateFollowUp.isPending}
        onSubmit={async (status, comment, date, time) => {
          if (Platform.OS !== "web")
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          await updateFollowUp.mutateAsync({
            id: active!.id,
            data: {
              status,
              comment: comment || null,
              ...(status === "rescheduled"
                ? { scheduledDate: date, scheduledTime: time }
                : {}),
            },
          });
          setActive(null);
          query.refetch();
        }}
      />
    </View>
  );
}

function ActionSheet({
  followUp,
  onClose,
  onSubmit,
  pending,
}: {
  followUp: FollowUp | null;
  onClose: () => void;
  onSubmit: (
    status: FollowUpUpdateStatus,
    comment: string,
    date: string | null,
    time: string | null,
  ) => void;
  pending: boolean;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [comment, setComment] = useState("");
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [mode, setMode] = useState<"menu" | "reschedule">("menu");

  function reset() {
    setComment("");
    setDate(null);
    setTime(null);
    setMode("menu");
  }

  const actions: { status: FollowUpUpdateStatus; label: string; icon: keyof typeof Feather.glyphMap; color: string }[] = [
    { status: "completed", label: "Mark completed", icon: "check-circle", color: "#22C55E" },
    { status: "rescheduled", label: "Reschedule", icon: "calendar", color: "#F59E0B" },
    { status: "cancelled", label: "Cancel follow-up", icon: "x-circle", color: "#EF4444" },
  ];

  return (
    <Modal
      visible={!!followUp}
      transparent
      animationType="slide"
      onRequestClose={() => {
        reset();
        onClose();
      }}
    >
      <Pressable
        style={styles.backdrop}
        onPress={() => {
          reset();
          onClose();
        }}
      >
        <Pressable
          style={[
            styles.sheet,
            { backgroundColor: colors.background, borderColor: colors.border, paddingBottom: insets.bottom + 16 },
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
          </View>
          <Text style={[styles.sheetTitle, { color: colors.foreground }]}>
            {followUp?.contactName ?? "Follow-up"}
          </Text>

          {mode === "menu" ? (
            <View style={{ gap: 10, marginTop: 12 }}>
              {actions.map((a) => (
                <Pressable
                  key={a.status}
                  disabled={pending}
                  onPress={() => {
                    if (a.status === "rescheduled") {
                      setDate(followUp?.scheduledDate ?? null);
                      setTime(followUp?.scheduledTime ?? null);
                      setMode("reschedule");
                    } else {
                      onSubmit(a.status, comment, null, null);
                      reset();
                    }
                  }}
                  style={({ pressed }) => [
                    styles.actionRow,
                    { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius, opacity: pressed ? 0.7 : 1 },
                  ]}
                >
                  <Feather name={a.icon} size={20} color={a.color} />
                  <Text style={[styles.actionLabel, { color: colors.foreground }]}>{a.label}</Text>
                </Pressable>
              ))}
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>
                COMMENT (OPTIONAL)
              </Text>
              <TextInput
                value={comment}
                onChangeText={setComment}
                placeholder="Add a note about this update"
                placeholderTextColor={colors.mutedForeground}
                multiline
                style={[
                  styles.commentInput,
                  { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, borderRadius: colors.radius },
                ]}
              />
            </View>
          ) : (
            <View style={{ marginTop: 12 }}>
              <DateTimeField
                label="New date & time"
                date={date}
                time={time}
                minToday
                onChange={(d, t) => {
                  setDate(d);
                  setTime(t);
                }}
              />
              <TextInput
                value={comment}
                onChangeText={setComment}
                placeholder="Reason for rescheduling (optional)"
                placeholderTextColor={colors.mutedForeground}
                multiline
                style={[
                  styles.commentInput,
                  { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, borderRadius: colors.radius },
                ]}
              />
              <Pressable
                disabled={pending || !date}
                onPress={() => {
                  onSubmit("rescheduled", comment, date, time);
                  reset();
                }}
                style={[
                  styles.applyBtn,
                  { backgroundColor: date ? colors.primary : colors.muted },
                ]}
              >
                <Text style={styles.applyText}>
                  {pending ? "Saving…" : "Confirm reschedule"}
                </Text>
              </Pressable>
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 30, fontFamily: FONT.bold },
  tabBar: {
    flexDirection: "row",
    padding: 4,
    marginTop: 14,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
  },
  tabText: { fontSize: 13.5, fontFamily: FONT.semibold },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  groupTitle: { fontSize: 16, fontFamily: FONT.bold },
  countPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  countText: { fontSize: 12, fontFamily: FONT.semibold },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderWidth: 1,
  },
  itemName: { fontSize: 15.5, fontFamily: FONT.semibold },
  itemSub: { fontSize: 13, fontFamily: FONT.regular, marginTop: 1 },
  itemMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
  },
  itemDate: { fontSize: 12.5, fontFamily: FONT.medium, marginRight: 4 },
  actionBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  handleWrap: { alignItems: "center", paddingVertical: 8 },
  handle: { width: 40, height: 4, borderRadius: 2 },
  sheetTitle: { fontSize: 18, fontFamily: FONT.bold },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderWidth: 1,
  },
  actionLabel: { fontSize: 15.5, fontFamily: FONT.medium },
  fieldLabel: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.5,
    marginTop: 8,
  },
  commentInput: {
    borderWidth: 1,
    padding: 12,
    minHeight: 70,
    fontSize: 14.5,
    fontFamily: FONT.regular,
    textAlignVertical: "top",
    marginTop: 6,
  },
  applyBtn: {
    marginTop: 14,
    height: 52,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  applyText: { color: "#FFFFFF", fontSize: 16, fontFamily: FONT.semibold },
});
