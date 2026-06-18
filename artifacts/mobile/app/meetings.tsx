import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Stack, useRouter } from "expo-router";
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
  type Meeting,
  type MeetingUpdateStatus,
  useListMeetings,
  useUpdateMeeting,
} from "@workspace/api-client-react";

import { DateTimeField } from "@/components/DateTimeField";
import {
  Avatar,
  Badge,
  EmptyState,
  ErrorState,
  FONT,
  LoadingState,
  MEETING_STATUS_COLORS,
  MEETING_TYPE_ICONS,
  prettyLabel,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";

type Tab = "upcoming" | "completed" | "cancelled";

const TABS: { key: Tab; label: string }[] = [
  { key: "upcoming", label: "Upcoming" },
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Cancelled" },
];

function parseLocal(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function formatDate(s?: string | null, time?: string | null): string {
  if (!s) return "No date";
  const base = parseLocal(s).toLocaleDateString(undefined, {
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

export default function MeetingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("upcoming");
  const [active, setActive] = useState<Meeting | null>(null);

  const query = useListMeetings();
  const updateMeeting = useUpdateMeeting();

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  const all = query.data?.meetings ?? [];
  const visible = useMemo(() => {
    if (tab === "completed") return all.filter((m) => m.status === "completed");
    if (tab === "cancelled") return all.filter((m) => m.status === "cancelled");
    return all.filter((m) => m.status === "scheduled");
  }, [all, tab]);

  const sorted = useMemo(
    () =>
      [...visible].sort((a, b) =>
        (a.meetingDate ?? "9999") < (b.meetingDate ?? "9999") ? -1 : 1,
      ),
    [visible],
  );

  function renderItem(m: Meeting) {
    const statusColor = MEETING_STATUS_COLORS[m.status] ?? colors.mutedForeground;
    return (
      <Pressable
        key={m.id}
        onPress={() => router.push(`/contact/${m.contactId}`)}
        style={({ pressed }) => [
          styles.item,
          { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <View style={[styles.typeIcon, { backgroundColor: colors.primary + "1A" }]}>
          <Feather name={MEETING_TYPE_ICONS[m.type] ?? "calendar"} size={18} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={[styles.itemName, { color: colors.foreground }]}>
            {m.contactName ?? "Contact"}
          </Text>
          <View style={styles.itemMeta}>
            <Feather name="calendar" size={12} color={colors.mutedForeground} />
            <Text style={[styles.itemDate, { color: colors.mutedForeground }]}>
              {formatDate(m.meetingDate, m.meetingTime)}
            </Text>
            <Badge label={prettyLabel(m.type)} color={colors.primary} />
            <Badge label={prettyLabel(m.status)} color={statusColor} />
          </View>
        </View>
        {tab === "upcoming" ? (
          <Pressable
            onPress={() => {
              if (Platform.OS !== "web") Haptics.selectionAsync();
              setActive(m);
            }}
            hitSlop={8}
            style={({ pressed }) => [
              styles.moreBtn,
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
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ paddingTop: topPad + 14, paddingHorizontal: 20 }}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={10}
            style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Feather name="arrow-left" size={20} color={colors.foreground} />
          </Pressable>
          <Text style={[styles.heading, { color: colors.foreground }]}>Meetings</Text>
        </View>
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
                style={[styles.tab, isActive && { backgroundColor: colors.card, borderRadius: colors.radius - 2 }]}
              >
                <Text style={[styles.tabText, { color: isActive ? colors.foreground : colors.mutedForeground }]}>
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
      ) : sorted.length === 0 ? (
        <View style={{ flex: 1 }}>
          <EmptyState
            icon="calendar"
            title={tab === "upcoming" ? "No meetings scheduled" : "Nothing here"}
            subtitle={
              tab === "upcoming"
                ? "Schedule a meeting from a contact and it will show up here."
                : `No ${tab} meetings yet.`
            }
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 40, gap: 10 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={query.isRefetching} onRefresh={() => query.refetch()} tintColor={colors.primary} />
          }
        >
          {sorted.map(renderItem)}
        </ScrollView>
      )}

      <ActionSheet
        meeting={active}
        pending={updateMeeting.isPending}
        onClose={() => setActive(null)}
        onSubmit={async (status, comment, date, time) => {
          if (Platform.OS !== "web")
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          await updateMeeting.mutateAsync({
            id: active!.id,
            data: {
              status,
              comment: comment || null,
              ...(status === "rescheduled" ? { meetingDate: date, meetingTime: time } : {}),
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
  meeting,
  onClose,
  onSubmit,
  pending,
}: {
  meeting: Meeting | null;
  onClose: () => void;
  onSubmit: (status: MeetingUpdateStatus, comment: string, date: string | null, time: string | null) => void;
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

  const actions: { status: MeetingUpdateStatus; label: string; icon: keyof typeof Feather.glyphMap; color: string }[] = [
    { status: "completed", label: "Mark completed", icon: "check-circle", color: "#22C55E" },
    { status: "rescheduled", label: "Reschedule", icon: "calendar", color: "#F59E0B" },
    { status: "cancelled", label: "Cancel meeting", icon: "x-circle", color: "#EF4444" },
  ];

  return (
    <Modal
      visible={!!meeting}
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
          style={[styles.sheet, { backgroundColor: colors.background, borderColor: colors.border, paddingBottom: insets.bottom + 16 }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
          </View>
          <Text style={[styles.sheetTitle, { color: colors.foreground }]}>
            {meeting?.contactName ?? "Meeting"}
          </Text>

          {mode === "menu" ? (
            <View style={{ gap: 10, marginTop: 12 }}>
              {actions.map((a) => (
                <Pressable
                  key={a.status}
                  disabled={pending}
                  onPress={() => {
                    if (a.status === "rescheduled") {
                      setDate(meeting?.meetingDate ?? null);
                      setTime(meeting?.meetingTime ?? null);
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
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>COMMENT (OPTIONAL)</Text>
              <TextInput
                value={comment}
                onChangeText={setComment}
                placeholder="Add a note about this update"
                placeholderTextColor={colors.mutedForeground}
                multiline
                style={[styles.commentInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, borderRadius: colors.radius }]}
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
                style={[styles.commentInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, borderRadius: colors.radius }]}
              />
              <Pressable
                disabled={pending || !date}
                onPress={() => {
                  onSubmit("rescheduled", comment, date, time);
                  reset();
                }}
                style={[styles.applyBtn, { backgroundColor: date ? colors.primary : colors.muted }]}
              >
                <Text style={styles.applyText}>{pending ? "Saving…" : "Confirm reschedule"}</Text>
              </Pressable>
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  heading: { fontSize: 28, fontFamily: FONT.bold },
  tabBar: { flexDirection: "row", padding: 4, marginTop: 16 },
  tab: { flex: 1, paddingVertical: 8, alignItems: "center" },
  tabText: { fontSize: 13.5, fontFamily: FONT.semibold },
  item: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderWidth: 1 },
  typeIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  itemName: { fontSize: 15.5, fontFamily: FONT.semibold },
  itemMeta: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 6 },
  itemDate: { fontSize: 12.5, fontFamily: FONT.medium, marginRight: 4 },
  moreBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
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
  actionRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderWidth: 1 },
  actionLabel: { fontSize: 15.5, fontFamily: FONT.medium },
  fieldLabel: { fontSize: 11.5, fontFamily: FONT.semibold, letterSpacing: 0.5, marginTop: 8 },
  commentInput: {
    borderWidth: 1,
    padding: 12,
    minHeight: 70,
    fontSize: 14.5,
    fontFamily: FONT.regular,
    textAlignVertical: "top",
    marginTop: 6,
  },
  applyBtn: { marginTop: 14, height: 52, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  applyText: { color: "#FFFFFF", fontSize: 16, fontFamily: FONT.semibold },
});
