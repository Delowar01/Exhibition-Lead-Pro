import { Feather } from "@/components/icons";
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
  type MobileActivityItem,
  type MobileDashboard,
  useGetLeadsByEvent,
  useGetMobileDashboard,
} from "@workspace/api-client-react";

import { Avatar, Badge, FONT, LoadingState, prettyLabel } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { useOffline } from "@/contexts/OfflineContext";
import { DEFAULT_CONTACT_FILTERS, useSettings } from "@/contexts/SettingsContext";
import { useColors } from "@/hooks/useColors";
import { formatGregorian } from "@/lib/date";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`;
  return `$${Math.round(value)}`;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return formatGregorian(new Date(iso), { month: "short", day: "numeric" });
}

const ACTIVITY_ICON: Record<string, keyof typeof Feather.glyphMap> = {
  lead_captured: "user-plus",
  contact: "user",
};

interface Insight {
  text: string;
  icon: keyof typeof Feather.glyphMap;
  tone: "primary" | "warning" | "info";
}

function buildInsights(data?: MobileDashboard): Insight[] {
  if (!data) return [];
  const out: Insight[] = [];
  if (data.followUpsDue > 0) {
    out.push({
      text: `${data.followUpsDue} follow-up${data.followUpsDue === 1 ? "" : "s"} due — reach out before the day ends.`,
      icon: "clock",
      tone: "warning",
    });
  }
  if (data.hotLeads > 0) {
    out.push({
      text: `${data.hotLeads} hot lead${data.hotLeads === 1 ? "" : "s"} are primed to convert. Prioritize these.`,
      icon: "trending-up",
      tone: "primary",
    });
  }
  if (data.todayLeads > 0) {
    out.push({
      text: `You've captured ${data.todayLeads} lead${data.todayLeads === 1 ? "" : "s"} today. Great momentum.`,
      icon: "zap",
      tone: "info",
    });
  }
  if (out.length === 0) {
    out.push({
      text: "No urgent follow-ups. Capture a card to start building your pipeline.",
      icon: "compass",
      tone: "info",
    });
  }
  return out.slice(0, 3);
}

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const { isOnline, queuedCount } = useOffline();
  const { setContactFilters } = useSettings();

  const query = useGetMobileDashboard();
  const data = query.data;

  const eventsQuery = useGetLeadsByEvent();
  const lastEvent = [...(eventsQuery.data ?? [])].sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  )[0];

  function openContactsWith(patch: Partial<typeof DEFAULT_CONTACT_FILTERS>) {
    if (Platform.OS !== "web") Haptics.selectionAsync();
    setContactFilters({ ...DEFAULT_CONTACT_FILTERS, ...patch });
    router.push("/(tabs)/contacts");
  }

  const insights = buildInsights(data);

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  const metrics: {
    key: string;
    label: string;
    value: string;
    icon: keyof typeof Feather.glyphMap;
    color: string;
    onPress: () => void;
  }[] = [
    {
      key: "today",
      label: "Today's Leads",
      value: String(data?.todayLeads ?? 0),
      icon: "zap",
      color: colors.primary,
      onPress: () => openContactsWith({ dateFrom: todayStr(), dateTo: todayStr() }),
    },
    {
      key: "hot",
      label: "Hot Leads",
      value: String(data?.hotLeads ?? 0),
      icon: "trending-up",
      color: "#F59E0B",
      onPress: () => openContactsWith({ temperature: "hot" }),
    },
    {
      key: "followups",
      label: "Follow-Ups Due",
      value: String(data?.followUpsDue ?? 0),
      icon: "clock",
      color: "#06B6D4",
      onPress: () => {
        if (Platform.OS !== "web") Haptics.selectionAsync();
        router.push({ pathname: "/(tabs)/followups", params: { bucket: "due" } });
      },
    },
    {
      key: "meetings",
      label: "Meetings",
      value: String(data?.meetingsScheduled ?? 0),
      icon: "calendar",
      color: "#8B5CF6",
      onPress: () => {
        if (Platform.OS !== "web") Haptics.selectionAsync();
        router.push("/meetings");
      },
    },
    {
      key: "contacted",
      label: "Contacted",
      value: String(data?.contactedLeads ?? 0),
      icon: "send",
      color: "#3B82F6",
      onPress: () => openContactsWith({ status: "contacted" }),
    },
    {
      key: "pipeline",
      label: "Pipeline Value",
      value: formatCurrency(data?.pipelineValue ?? 0),
      icon: "dollar-sign",
      color: colors.success,
      onPress: () => {
        if (Platform.OS !== "web") Haptics.selectionAsync();
        router.push("/leads");
      },
    },
  ];

  const quickActions: {
    key: string;
    label: string;
    icon: keyof typeof Feather.glyphMap;
    onPress: () => void;
  }[] = [
    { key: "capture", label: "Capture", icon: "maximize", onPress: () => router.push("/capture") },
    { key: "qr", label: "Scan QR", icon: "grid", onPress: () => router.push("/capture-qr") },
    { key: "manual", label: "Manual", icon: "edit-3", onPress: () => router.push("/capture-manual") },
    { key: "pipeline", label: "Pipeline", icon: "bar-chart-2", onPress: () => router.push("/leads") },
  ];

  function renderActivity(item: MobileActivityItem) {
    const icon = ACTIVITY_ICON[item.type] ?? "activity";
    return (
      <View key={item.id} style={styles.activityRow}>
        <View style={[styles.activityIcon, { backgroundColor: colors.accent }]}>
          <Feather name={icon} size={16} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={[styles.activityTitle, { color: colors.foreground }]}>
            {item.title}
          </Text>
          {item.subtitle ? (
            <Text numberOfLines={1} style={[styles.activitySub, { color: colors.mutedForeground }]}>
              {item.subtitle}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.activityTime, { color: colors.mutedForeground }]}>
          {relativeTime(item.at)}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: topPad + 14,
          paddingHorizontal: 20,
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
        {/* Branded header */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.greeting, { color: colors.mutedForeground }]}>
              {greeting()}
            </Text>
            <Text numberOfLines={1} style={[styles.name, { color: colors.foreground }]}>
              {user?.name ?? "Welcome"}
            </Text>
            <View style={styles.metaRow}>
              {user?.role ? <Badge label={prettyLabel(user.role)} color={colors.primary} /> : null}
              {user?.companyName ? (
                <View style={styles.companyRow}>
                  <View style={[styles.companyDot, { backgroundColor: colors.primary }]} />
                  <Text numberOfLines={1} style={[styles.company, { color: colors.mutedForeground }]}>
                    {user.companyName}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
          <Avatar name={user?.name} color={colors.primary} size={48} uri={user?.avatarUrl} />
        </View>

        {/* Offline / pending-sync banner */}
        {!isOnline || queuedCount > 0 ? (
          <Pressable
            onPress={() => {
              if (Platform.OS !== "web") Haptics.selectionAsync();
              router.push("/sync");
            }}
            style={({ pressed }) => [
              styles.offlineBanner,
              {
                backgroundColor: isOnline ? colors.primary + "14" : colors.destructive + "14",
                borderRadius: colors.radius + 2,
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Feather
              name={isOnline ? "upload-cloud" : "wifi-off"}
              size={18}
              color={isOnline ? colors.primary : colors.destructive}
            />
            <Text
              style={[
                styles.offlineBannerText,
                { color: isOnline ? colors.primary : colors.destructive },
              ]}
            >
              {!isOnline
                ? queuedCount > 0
                  ? `Offline — ${queuedCount} capture${queuedCount === 1 ? "" : "s"} queued`
                  : "You're offline — captures will be queued"
                : `${queuedCount} capture${queuedCount === 1 ? "" : "s"} waiting to sync`}
            </Text>
            <Feather
              name="chevron-right"
              size={18}
              color={isOnline ? colors.primary : colors.destructive}
            />
          </Pressable>
        ) : null}

        {/* Primary CTA */}
        <Pressable
          onPress={() => {
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            router.push("/capture");
          }}
          style={({ pressed }) => [
            styles.cta,
            { backgroundColor: colors.primary, borderRadius: colors.radius + 8, opacity: pressed ? 0.9 : 1 },
          ]}
        >
          <View style={styles.ctaIcon}>
            <Feather name="maximize" size={22} color="#FFFFFF" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.ctaTitle}>Capture a lead</Text>
            <Text style={styles.ctaSub}>Scan a card, badge, or QR code</Text>
          </View>
          <Feather name="arrow-right" size={20} color="#FFFFFF" />
        </Pressable>

        {/* Metrics grid */}
        {query.isLoading ? (
          <View style={{ height: 240 }}>
            <LoadingState />
          </View>
        ) : (
          <View style={styles.grid}>
            {metrics.map((m) => (
              <Pressable
                key={m.key}
                onPress={m.onPress}
                style={({ pressed }) => [
                  styles.metricCard,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                    borderRadius: colors.radius + 4,
                    opacity: pressed ? 0.7 : 1,
                  },
                ]}
              >
                <View style={[styles.metricIcon, { backgroundColor: m.color + "1A" }]}>
                  <Feather name={m.icon} size={16} color={m.color} />
                </View>
                <Text style={[styles.metricValue, { color: colors.foreground }]}>{m.value}</Text>
                <Text style={[styles.metricLabel, { color: colors.mutedForeground }]}>{m.label}</Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* Last event */}
        {lastEvent ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
              LAST EVENT
            </Text>
            <Pressable
              onPress={() => {
                if (Platform.OS !== "web") Haptics.selectionAsync();
                router.push(`/event/${lastEvent.eventId}/report`);
              }}
              style={({ pressed }) => [
                styles.eventCard,
                { backgroundColor: colors.dark, borderRadius: colors.radius + 6, opacity: pressed ? 0.92 : 1 },
              ]}
            >
              <View style={[styles.eventIcon, { backgroundColor: "rgba(255,255,255,0.14)" }]}>
                <Feather name="bar-chart-2" size={20} color="#FFFFFF" />
              </View>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={styles.eventName}>
                  {lastEvent.eventName}
                </Text>
                <Text style={styles.eventMeta}>
                  {lastEvent.leadCount} lead{lastEvent.leadCount === 1 ? "" : "s"}
                  {lastEvent.wonCount != null ? ` · ${lastEvent.wonCount} won` : ""}
                  {lastEvent.conversionRate != null
                    ? ` · ${Math.round(lastEvent.conversionRate)}% conv.`
                    : ""}
                </Text>
              </View>
              <Feather name="chevron-right" size={20} color="rgba(255,255,255,0.7)" />
            </Pressable>
          </>
        ) : null}

        {/* Smart insights */}
        {insights.length > 0 ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
              TODAY&apos;S FOCUS
            </Text>
            <View
              style={[
                styles.insightCard,
                { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
              ]}
            >
              {insights.map((ins, idx) => {
                const tone =
                  ins.tone === "warning"
                    ? "#F59E0B"
                    : ins.tone === "primary"
                      ? colors.primary
                      : "#06B6D4";
                return (
                  <View
                    key={idx}
                    style={[
                      styles.insightRow,
                      idx > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: colors.border,
                      },
                    ]}
                  >
                    <View style={[styles.insightIcon, { backgroundColor: tone + "1A" }]}>
                      <Feather name={ins.icon} size={15} color={tone} />
                    </View>
                    <Text style={[styles.insightText, { color: colors.foreground }]}>
                      {ins.text}
                    </Text>
                  </View>
                );
              })}
            </View>
          </>
        ) : null}

        {/* Quick actions */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>QUICK ACTIONS</Text>
        <View style={styles.actionsRow}>
          {quickActions.map((a) => (
            <Pressable
              key={a.key}
              onPress={() => {
                if (Platform.OS !== "web") Haptics.selectionAsync();
                a.onPress();
              }}
              style={({ pressed }) => [
                styles.actionCard,
                { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <View style={[styles.actionIcon, { backgroundColor: colors.accent }]}>
                <Feather name={a.icon} size={18} color={colors.primary} />
              </View>
              <Text style={[styles.actionLabel, { color: colors.foreground }]}>{a.label}</Text>
            </Pressable>
          ))}
        </View>

        {/* Recent activity */}
        <View style={styles.activityHeader}>
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground, marginBottom: 0 }]}>
            RECENT ACTIVITY
          </Text>
          <Pressable onPress={() => router.push("/(tabs)/contacts")} hitSlop={8}>
            <Text style={[styles.seeAll, { color: colors.primary }]}>See all</Text>
          </Pressable>
        </View>
        <View
          style={[
            styles.activityCard,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
          ]}
        >
          {(data?.recentActivity?.length ?? 0) === 0 ? (
            <View style={styles.activityEmpty}>
              <Feather name="inbox" size={22} color={colors.mutedForeground} />
              <Text style={[styles.activityEmptyText, { color: colors.mutedForeground }]}>
                No activity yet. Capture your first lead.
              </Text>
            </View>
          ) : (
            data!.recentActivity.map(renderActivity)
          )}
        </View>

        {/* Powered by */}
        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
            Powered by Elite Marcom
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 18,
  },
  offlineBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 18,
  },
  offlineBannerText: {
    flex: 1,
    fontSize: 13.5,
    fontFamily: FONT.semibold,
  },
  greeting: {
    fontSize: 14,
    fontFamily: FONT.regular,
  },
  name: {
    fontSize: 26,
    fontFamily: FONT.bold,
    marginTop: 1,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 7,
  },
  companyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  companyDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  company: {
    fontSize: 13.5,
    fontFamily: FONT.medium,
  },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 16,
    marginBottom: 22,
  },
  ctaIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  ctaTitle: {
    color: "#FFFFFF",
    fontSize: 17,
    fontFamily: FONT.bold,
  },
  ctaSub: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 13.5,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  metricCard: {
    width: "47.5%",
    flexGrow: 1,
    padding: 14,
    borderWidth: 1,
  },
  metricIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  metricValue: {
    fontSize: 24,
    fontFamily: FONT.bold,
  },
  metricLabel: {
    fontSize: 12.5,
    fontFamily: FONT.medium,
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.6,
    marginTop: 26,
    marginBottom: 12,
  },
  actionsRow: {
    flexDirection: "row",
    gap: 10,
  },
  actionCard: {
    flex: 1,
    alignItems: "center",
    gap: 8,
    paddingVertical: 14,
    borderWidth: 1,
  },
  actionIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  actionLabel: {
    fontSize: 12.5,
    fontFamily: FONT.medium,
  },
  activityHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 26,
    marginBottom: 12,
  },
  seeAll: {
    fontSize: 13,
    fontFamily: FONT.semibold,
  },
  activityCard: {
    borderWidth: 1,
    paddingHorizontal: 14,
  },
  activityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
  },
  activityIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  activityTitle: {
    fontSize: 14.5,
    fontFamily: FONT.semibold,
  },
  activitySub: {
    fontSize: 12.5,
    fontFamily: FONT.regular,
    marginTop: 1,
  },
  activityTime: {
    fontSize: 12,
    fontFamily: FONT.regular,
  },
  activityEmpty: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 28,
  },
  activityEmptyText: {
    fontSize: 13.5,
    fontFamily: FONT.regular,
  },
  eventCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 16,
  },
  eventIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  eventName: {
    color: "#FFFFFF",
    fontSize: 16,
    fontFamily: FONT.bold,
  },
  eventMeta: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 13,
    fontFamily: FONT.regular,
    marginTop: 3,
  },
  insightCard: {
    borderWidth: 1,
    paddingHorizontal: 14,
  },
  insightRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 13,
  },
  insightIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  insightText: {
    flex: 1,
    fontSize: 13.5,
    fontFamily: FONT.medium,
    lineHeight: 19,
  },
  footer: {
    alignItems: "center",
    marginTop: 28,
  },
  footerText: {
    fontSize: 12,
    fontFamily: FONT.medium,
  },
});
