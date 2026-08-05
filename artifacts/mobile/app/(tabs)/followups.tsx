import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  Alert,
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
  useDeleteFollowUp,
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
import { useLocale } from "@/hooks/useLocale";
import type { Locale } from "@/hooks/useLocale";
import { formatGregorian } from "@/lib/date";

type Tab = "upcoming" | "completed" | "cancelled";
type Bucket = "overdue" | "today" | "week" | "later";

const BUCKET_META: Record<
  Bucket,
  { title: string; titleKey?: string; icon: keyof typeof Feather.glyphMap; color: string }
> = {
  overdue: { title: "Overdue", titleKey: "followups.overdue", icon: "alert-circle", color: "#EF4444" },
  today: { title: "Today", titleKey: "common.today", icon: "zap", color: "#FF6B00" },
  week: { title: "This Week", titleKey: "followups.bucketThisWeek", icon: "calendar", color: "#06B6D4" },
  later: { title: "Later", titleKey: "followups.bucketLater", icon: "clock", color: "#8B5CF6" },
};

const BUCKET_ORDER: Bucket[] = ["overdue", "today", "week", "later"];
const DUE_ORDER: Bucket[] = ["overdue", "today"];
const TABS: { key: Tab; label: string; labelKey?: string }[] = [
  { key: "upcoming", label: "Upcoming", labelKey: "followups.upcoming" },
  { key: "completed", label: "Completed", labelKey: "followups.completed" },
  { key: "cancelled", label: "Cancelled", labelKey: "followups.statusCancelled" },
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

function formatDate(t: Locale["t"], s?: string | null, time?: string | null): string {
  if (!s) return t("common.noDate");
  const base = formatGregorian(parseLocal(s), {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  if (!time) return base;
  const [h, m] = time.split(":").map((p) => parseInt(p, 10));
  const period = h >= 12 ? t("common.pm") : t("common.am");
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
  const { t, isRTL, textAlign } = useLocale();
  const { bucket } = useLocalSearchParams<{ bucket?: string }>();
  const dueMode = bucket === "due";
  const [tab, setTab] = useState<Tab>("upcoming");
  const [active, setActive] = useState<FollowUp | null>(null);

  const query = useListFollowUps();
  const updateFollowUp = useUpdateFollowUp();
  const deleteFollowUp = useDeleteFollowUp();

  function handleDelete(f: FollowUp) {
    const run = async () => {
      try {
        await deleteFollowUp.mutateAsync({ id: f.id });
        if (Platform.OS !== "web")
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setActive(null);
        query.refetch();
      } catch {
        Alert.alert(t("followups.deleteFailedTitle"), t("followups.deleteFailedBody"));
      }
    };
    if (Platform.OS === "web") {
      void run();
      return;
    }
    Alert.alert(t("followups.deleteTitle"), t("followups.deleteConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.delete"), style: "destructive", onPress: run },
    ]);
  }

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
            flexDirection: isRTL ? "row-reverse" : "row",
          },
        ]}
      >
        <Avatar name={f.contactName ?? "?"} size={42} color={colors.primary} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center" }}>
            <Text numberOfLines={1} style={[styles.itemName, { flex: 1, color: colors.foreground, textAlign }]}>
              {f.contactName ?? t("common.contact")}
            </Text>
            {tab === "upcoming" ? (
              <Pressable
                onPress={() => setActive(f)}
                style={({ pressed }) => [
                  styles.actionBtn,
                  { backgroundColor: colors.muted, borderRadius: colors.radius, opacity: pressed ? 0.6 : 1 },
                ]}
              >
                <Feather name="more-horizontal" size={18} color={colors.foreground} />
              </Pressable>
            ) : null}
          </View>
          {f.notes ? (
            <Text numberOfLines={1} style={[styles.itemSub, { color: colors.mutedForeground, textAlign }]}>
              {f.notes}
            </Text>
          ) : null}
          <View style={[styles.itemMeta, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
            <Feather name="calendar" size={12} color={colors.mutedForeground} />
            <Text numberOfLines={1} style={[styles.itemDate, { flex: 1, color: colors.mutedForeground, textAlign }]}>
              {formatDate(t, f.scheduledDate, f.scheduledTime)}
            </Text>
            <Badge label={t("statuses." + f.status, { defaultValue: prettyLabel(f.status) })} color={statusColor} />
          </View>
        </View>
      </Pressable>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 14, paddingHorizontal: 20 }}>
        <Text style={[styles.heading, { color: colors.foreground, textAlign }]}>
          {t("followups.title")}
        </Text>
        <View style={[styles.tabBar, { backgroundColor: colors.muted, borderRadius: colors.radius, flexDirection: isRTL ? "row-reverse" : "row" }]}>
          {TABS.map((tabItem) => {
            const isActive = tab === tabItem.key;
            return (
              <Pressable
                key={tabItem.key}
                onPress={() => {
                  setTab(tabItem.key);
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
                  {tabItem.labelKey ? t(tabItem.labelKey) : tabItem.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {dueMode && tab === "upcoming" ? (
          <Pressable
            onPress={() => {
              router.setParams({ bucket: "" });
            }}
            style={[
              styles.dueChip,
              { backgroundColor: colors.primary + "1A", borderRadius: colors.radius, flexDirection: isRTL ? "row-reverse" : "row" },
            ]}
          >
            <Feather name="filter" size={13} color={colors.primary} />
            <Text style={[styles.dueChipText, { color: colors.primary }]}>
              {t("followups.dueNow")}
            </Text>
            <Feather name="x" size={14} color={colors.primary} />
          </Pressable>
        ) : null}
      </View>

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : visible.length === 0 ? (
        <View style={{ flex: 1 }}>
          <EmptyState
            icon="check-circle"
            title={tab === "upcoming" ? t("followups.empty") : t("empty.generic")}
            subtitle={
              tab === "upcoming"
                ? t("followups.emptyDesc")
                : tab === "completed"
                  ? t("followups.emptyCompleted")
                  : t("followups.emptyCancelled")
            }
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 16,
            paddingBottom: insets.bottom + 110,
            flexGrow: 1,
          }}
          keyboardShouldPersistTaps="handled"
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
            (dueMode ? DUE_ORDER : BUCKET_ORDER).map((bucket) => {
              const items = grouped[bucket];
              if (items.length === 0) return null;
              const meta = BUCKET_META[bucket];
              return (
                <View key={bucket} style={{ marginBottom: 22 }}>
                  <View style={[styles.groupHeader, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                    <Feather name={meta.icon} size={15} color={meta.color} />
                    <Text style={[styles.groupTitle, { color: colors.foreground, textAlign }]}>
                      {meta.titleKey ? t(meta.titleKey) : meta.title}
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
        deleting={deleteFollowUp.isPending}
        onDelete={() => active && handleDelete(active)}
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
  onDelete,
  pending,
  deleting,
}: {
  followUp: FollowUp | null;
  onClose: () => void;
  onSubmit: (
    status: FollowUpUpdateStatus,
    comment: string,
    date: string | null,
    time: string | null,
  ) => void;
  onDelete: () => void;
  pending: boolean;
  deleting: boolean;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t, isRTL, textAlign } = useLocale();
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
    { status: "completed", label: t("followups.markDone"), icon: "check-circle", color: "#22C55E" },
    { status: "rescheduled", label: t("followups.reschedule"), icon: "calendar", color: "#F59E0B" },
    { status: "cancelled", label: t("common.cancel"), icon: "x-circle", color: "#EF4444" },
  ];

  return (
    <Modal
      visible={!!followUp}
      transparent
      animationType="slide"
      statusBarTranslucent
      hardwareAccelerated
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
            { backgroundColor: colors.background, borderColor: colors.border, paddingBottom: insets.bottom + 16, maxHeight: "88%", overflow: "hidden" },
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
          </View>
          <Text style={[styles.sheetTitle, { color: colors.foreground, textAlign }]}>
            {followUp?.contactName ?? t("followups.fallbackTitle")}
          </Text>

          <ScrollView bounces={false} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
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
                    { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius, opacity: pressed ? 0.7 : 1, flexDirection: isRTL ? "row-reverse" : "row" },
                  ]}
                >
                  <Feather name={a.icon} size={20} color={a.color} />
                  <Text style={[styles.actionLabel, { color: colors.foreground, textAlign }]}>{a.label}</Text>
                </Pressable>
              ))}
              <Pressable
                disabled={deleting || pending}
                onPress={onDelete}
                style={({ pressed }) => [
                  styles.actionRow,
                  { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius, opacity: pressed ? 0.7 : 1, flexDirection: isRTL ? "row-reverse" : "row" },
                ]}
              >
                <Feather name="trash-2" size={20} color="#EF4444" />
                <Text style={[styles.actionLabel, { color: "#EF4444", textAlign }]}>
                  {deleting ? t("common.saving") : t("followups.deleteFollowUp")}
                </Text>
              </Pressable>
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground, textAlign }]}>
                {t("followups.commentOptional")}
              </Text>
              <TextInput
                value={comment}
                onChangeText={setComment}
                placeholder={t("followups.notePlaceholder")}
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
                label={t("followups.newDateTime")}
                date={date}
                time={time}
                minToday
                onChange={(d, tm) => {
                  setDate(d);
                  setTime(tm);
                }}
              />
              <TextInput
                value={comment}
                onChangeText={setComment}
                placeholder={t("followups.reschedulePlaceholder")}
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
                  {pending ? t("common.saving") : t("followups.confirmReschedule")}
                </Text>
              </Pressable>
            </View>
          )}
          </ScrollView>
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
  dueChip: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 12,
  },
  dueChipText: { fontSize: 12.5, fontFamily: FONT.semibold },
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
