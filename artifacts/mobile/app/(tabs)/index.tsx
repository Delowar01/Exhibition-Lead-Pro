import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  Modal,
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
  getGetEventReportQueryKey,
  getListEventsQueryKey,
  type GetEventReportParams,
  type MobileActivityItem,
  type MobileDashboard,
  type TeamPerformanceItem,
  useGetEventReport,
  useGetLeadsByEvent,
  useGetMobileDashboard,
  useGetTeamPerformance,
  useListEvents,
} from "@workspace/api-client-react";

import { DateTimeField } from "@/components/DateTimeField";
import {
  Avatar,
  Badge,
  CONTACT_PIPELINE_ORDER,
  FONT,
  LEAD_TEMPERATURE_COLORS,
  LoadingState,
  prettyLabel,
} from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { useOffline } from "@/contexts/OfflineContext";
import { DEFAULT_CONTACT_FILTERS, useSettings } from "@/contexts/SettingsContext";
import { useColors } from "@/hooks/useColors";
import { useLocale, type Locale } from "@/hooks/useLocale";
import { formatGregorian } from "@/lib/date";

function greetingKey(): string {
  const h = new Date().getHours();
  if (h < 12) return "home.greetingMorning";
  if (h < 18) return "home.greetingAfternoon";
  return "home.greetingEvening";
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

function relativeTime(iso: string, t: Locale["t"]): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("common.justNow");
  if (mins < 60) return t("common.minutesAgo", { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t("common.hoursAgo", { count: hrs });
  const days = Math.floor(hrs / 24);
  if (days < 7) return t("common.daysAgo", { count: days });
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

function buildInsights(t: Locale["t"], data?: MobileDashboard): Insight[] {
  if (!data) return [];
  const out: Insight[] = [];
  if (data.followUpsDue > 0) {
    out.push({
      text: t("home.insightFollowUpsDue", { count: data.followUpsDue }),
      icon: "clock",
      tone: "warning",
    });
  }
  if (data.hotLeads > 0) {
    out.push({
      text: t("home.insightHotLeads", { count: data.hotLeads }),
      icon: "trending-up",
      tone: "primary",
    });
  }
  if (data.todayLeads > 0) {
    out.push({
      text: t("home.insightTodayLeads", { count: data.todayLeads }),
      icon: "zap",
      tone: "info",
    });
  }
  if (out.length === 0) {
    out.push({
      text: t("home.insightNone"),
      icon: "compass",
      tone: "info",
    });
  }
  return out.slice(0, 3);
}

interface DashboardFilters {
  eventId: number | null;
  dateFrom: string | null;
  dateTo: string | null;
  assignedToId: number | null;
  status: string | null;
  temperature: string | null;
  captureMethod: string | null;
}

const DEFAULT_DASH_FILTERS: DashboardFilters = {
  eventId: null,
  dateFrom: null,
  dateTo: null,
  assignedToId: null,
  status: null,
  temperature: null,
  captureMethod: null,
};

const CAPTURE_METHODS: { key: string; labelKey: string }[] = [
  { key: "camera", labelKey: "capture.businessCard" },
  { key: "qr", labelKey: "capture.qrCode" },
  { key: "nfc", labelKey: "capture.nfc" },
  { key: "manual", labelKey: "capture.manual" },
];

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const { isOnline, queuedCount } = useOffline();
  const { setContactFilters } = useSettings();
  const { t, isRTL, textAlign } = useLocale();

  const query = useGetMobileDashboard();
  const data = query.data;

  const [filterOpen, setFilterOpen] = useState(false);
  const [dashFilters, setDashFilters] = useState<DashboardFilters>(DEFAULT_DASH_FILTERS);

  const eventsQuery = useGetLeadsByEvent();
  const eventsData = eventsQuery.data ?? [];
  const lastEvent = [...eventsData].sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  )[0];
  const selectedEvent = dashFilters.eventId
    ? (eventsData.find((e) => e.eventId === dashFilters.eventId) ?? lastEvent)
    : lastEvent;
  const selectedEventId = selectedEvent?.eventId ?? null;

  const activeDashFilters = useMemo(
    () =>
      [
        dashFilters.eventId,
        dashFilters.dateFrom,
        dashFilters.dateTo,
        dashFilters.assignedToId,
        dashFilters.status,
        dashFilters.temperature,
        dashFilters.captureMethod,
      ].filter((v) => v != null).length,
    [dashFilters],
  );

  const reportParams = useMemo<GetEventReportParams | null>(() => {
    if (selectedEventId == null) return null;
    return {
      eventId: selectedEventId,
      ...(dashFilters.dateFrom ? { dateFrom: dashFilters.dateFrom } : {}),
      ...(dashFilters.dateTo ? { dateTo: dashFilters.dateTo } : {}),
      ...(dashFilters.assignedToId != null ? { assignedToId: dashFilters.assignedToId } : {}),
      ...(dashFilters.status ? { status: dashFilters.status } : {}),
      ...(dashFilters.temperature ? { temperature: dashFilters.temperature } : {}),
    };
  }, [selectedEventId, dashFilters]);

  const effectiveReportParams = reportParams ?? { eventId: 0 };
  const eventReportQuery = useGetEventReport(effectiveReportParams, {
    query: {
      enabled: reportParams != null,
      queryKey: getGetEventReportQueryKey(effectiveReportParams),
    },
  });
  const eventReport = eventReportQuery.data;

  function openContactsWith(patch: Partial<typeof DEFAULT_CONTACT_FILTERS>) {
    setContactFilters({ ...DEFAULT_CONTACT_FILTERS, ...patch });
    router.push("/(tabs)/contacts");
  }

  const insights = buildInsights(t, data);

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
      label: t("home.stats.leads"),
      value: String(data?.todayLeads ?? 0),
      icon: "zap",
      color: colors.primary,
      onPress: () => openContactsWith({ dateFrom: todayStr(), dateTo: todayStr() }),
    },
    {
      key: "hot",
      label: t("home.stats.hotLeads"),
      value: String(data?.hotLeads ?? 0),
      icon: "trending-up",
      color: "#F59E0B",
      onPress: () => openContactsWith({ temperature: "hot" }),
    },
    {
      key: "followups",
      label: t("home.stats.followups"),
      value: String(data?.followUpsDue ?? 0),
      icon: "clock",
      color: "#06B6D4",
      onPress: () => {
        router.push({ pathname: "/(tabs)/followups", params: { bucket: "due" } });
      },
    },
    {
      key: "meetings",
      label: t("home.stats.meetings"),
      value: String(data?.meetingsScheduled ?? 0),
      icon: "calendar",
      color: "#8B5CF6",
      onPress: () => {
        router.push("/meetings");
      },
    },
    {
      key: "contacted",
      label: t("leads.stages.contacted"),
      value: String(data?.contactedLeads ?? 0),
      icon: "send",
      color: "#3B82F6",
      onPress: () => openContactsWith({ status: "contacted" }),
    },
    {
      key: "pipeline",
      label: t("leads.title"),
      value: formatCurrency(data?.pipelineValue ?? 0),
      icon: "dollar-sign",
      color: colors.success,
      onPress: () => {
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
    { key: "capture", label: t("nav.capture"), icon: "maximize", onPress: () => router.push("/capture") },
    { key: "qr", label: t("capture.qrCode"), icon: "grid", onPress: () => router.push("/capture-qr") },
    { key: "manual", label: t("capture.manual"), icon: "edit-3", onPress: () => router.push("/capture-manual") },
    { key: "pipeline", label: t("nav.leads"), icon: "bar-chart-2", onPress: () => router.push("/leads") },
  ];

  function renderActivity(item: MobileActivityItem) {
    const icon = ACTIVITY_ICON[item.type] ?? "activity";
    return (
      <View key={item.id} style={[styles.activityRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
        <View style={[styles.activityIcon, { backgroundColor: colors.accent }]}>
          <Feather name={icon} size={16} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={[styles.activityTitle, { color: colors.foreground, textAlign }]}>
            {item.title}
          </Text>
          {item.subtitle ? (
            <Text numberOfLines={1} style={[styles.activitySub, { color: colors.mutedForeground, textAlign }]}>
              {item.subtitle}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.activityTime, { color: colors.mutedForeground }]}>
          {relativeTime(item.at, t)}
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
        {/* Branded header */}
        <View style={[styles.header, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.greeting, { color: colors.mutedForeground, textAlign }]}>
              {t(greetingKey())}
            </Text>
            <Text numberOfLines={1} style={[styles.name, { color: colors.foreground, textAlign }]}>
              {user?.name ?? t("auth.welcome")}
            </Text>
            <View style={[styles.metaRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {user?.role ? <Badge label={prettyLabel(user.role)} color={colors.primary} /> : null}
              {user?.companyName ? (
                <View style={[styles.companyRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                  <View style={[styles.companyDot, { backgroundColor: colors.primary }]} />
                  <Text numberOfLines={1} style={[styles.company, { color: colors.mutedForeground, textAlign }]}>
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
              router.push("/sync");
            }}
            style={({ pressed }) => [
              styles.offlineBanner,
              {
                backgroundColor: isOnline ? colors.primary + "14" : colors.destructive + "14",
                borderRadius: colors.radius + 2,
                opacity: pressed ? 0.8 : 1,
                flexDirection: isRTL ? "row-reverse" : "row",
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
                { color: isOnline ? colors.primary : colors.destructive, textAlign },
              ]}
            >
              {!isOnline
                ? queuedCount > 0
                  ? `${t("sync.offline")} — ${t("sync.queuedItems", { count: queuedCount })}`
                  : t("sync.offline")
                : t("sync.queuedItems", { count: queuedCount })}
            </Text>
            <Feather
              name={isRTL ? "chevron-left" : "chevron-right"}
              size={18}
              color={isOnline ? colors.primary : colors.destructive}
            />
          </Pressable>
        ) : null}

        {/* My Digital Business Card action button */}
        <Pressable
          onPress={() => {
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            router.push("/card");
          }}
          style={({ pressed }) => [
            styles.cta,
            {
              backgroundColor: colors.primary,
              borderRadius: colors.radius + 8,
              opacity: pressed ? 0.9 : 1,
              flexDirection: isRTL ? "row-reverse" : "row",
            },
          ]}
        >
          <View style={styles.ctaIcon}>
            <Feather name="credit-card" size={22} color="#FFFFFF" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.ctaTitle, { textAlign }]}>{t("card.title")}</Text>
            <Text style={[styles.ctaSub, { textAlign }]}>{t("card.subtitle")}</Text>
          </View>
          <Feather name={isRTL ? "arrow-left" : "arrow-right"} size={20} color="#FFFFFF" />
        </Pressable>

        {/* Metrics grid */}
        {query.isLoading ? (
          <View style={{ height: 240 }}>
            <LoadingState />
          </View>
        ) : (
          <View style={[styles.grid, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
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
                <Text style={[styles.metricValue, { color: colors.foreground, textAlign }]}>{m.value}</Text>
                <Text style={[styles.metricLabel, { color: colors.mutedForeground, textAlign }]}>{m.label}</Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* Last event */}
        {selectedEvent ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground, textAlign }]}>
              {t("home.lastEvent")}
            </Text>
            <Pressable
              onPress={() => {
                if (!selectedEventId) return;
                if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                router.push(`/event/${selectedEventId}/report`);
              }}
              style={({ pressed }) => [
                styles.eventCard,
                {
                  backgroundColor: colors.dark,
                  borderRadius: colors.radius + 6,
                  opacity: pressed ? 0.92 : 1,
                  flexDirection: isRTL ? "row-reverse" : "row",
                },
              ]}
            >
              {/* Left: event icon */}
              <View style={[styles.eventIcon, { backgroundColor: "rgba(255,255,255,0.14)" }]}>
                <Feather name="bar-chart-2" size={20} color="#FFFFFF" />
              </View>

              {/* Center: header row (name + filter btn) + stats */}
              <View style={{ flex: 1 }}>
                <View
                  style={{
                    flexDirection: isRTL ? "row-reverse" : "row",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <Text numberOfLines={1} style={[styles.eventName, { flex: 1, textAlign }]}>
                    {selectedEvent.eventName}
                  </Text>
                  <Pressable
                    onPress={(e) => {
                      e.stopPropagation();
                      setFilterOpen(true);
                    }}
                    hitSlop={8}
                    style={[
                      styles.eventFilterBtn,
                      {
                        backgroundColor:
                          activeDashFilters > 0 ? colors.primary : "rgba(255,255,255,0.14)",
                        borderColor:
                          activeDashFilters > 0 ? colors.primary : "rgba(255,255,255,0.35)",
                        borderRadius: colors.radius,
                      },
                    ]}
                  >
                    <Feather name="sliders" size={16} color="#FFFFFF" />
                    {activeDashFilters > 0 ? (
                      <View style={[styles.filterCount, { backgroundColor: "#FFFFFF" }]}>
                        <Text style={[styles.filterCountText, { color: colors.primary }]}>
                          {activeDashFilters}
                        </Text>
                      </View>
                    ) : null}
                  </Pressable>
                </View>
                <Text style={[styles.eventMeta, { textAlign }]}>
                  {eventReport
                    ? [
                        t("home.eventLeads", { count: eventReport.totalLeads }),
                        t("home.eventWon", { count: eventReport.wonDeals }),
                        eventReport.totalLeads > 0
                          ? t("home.eventConv", {
                              count: Math.round(
                                (eventReport.wonDeals / eventReport.totalLeads) * 100,
                              ),
                            })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : [
                        t("home.eventLeads", { count: selectedEvent.leadCount }),
                        selectedEvent.wonCount != null
                          ? t("home.eventWon", { count: selectedEvent.wonCount })
                          : null,
                        selectedEvent.conversionRate != null
                          ? t("home.eventConv", {
                              count: Math.round(selectedEvent.conversionRate),
                            })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </Text>
              </View>

              {/* Far-right nav arrow — vertically centered */}
              <Feather
                name={isRTL ? "chevron-left" : "chevron-right"}
                size={20}
                color="rgba(255,255,255,0.7)"
              />
            </Pressable>
          </>
        ) : null}

        {/* Smart insights */}
        {insights.length > 0 ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground, textAlign }]}>
              {t("home.todayOverview")}
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
                      { flexDirection: isRTL ? "row-reverse" : "row" },
                      idx > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: colors.border,
                      },
                    ]}
                  >
                    <View style={[styles.insightIcon, { backgroundColor: tone + "1A" }]}>
                      <Feather name={ins.icon} size={15} color={tone} />
                    </View>
                    <Text style={[styles.insightText, { color: colors.foreground, textAlign }]}>
                      {ins.text}
                    </Text>
                  </View>
                );
              })}
            </View>
          </>
        ) : null}

        {/* Quick actions */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground, textAlign }]}>{t("home.quickActions")}</Text>
        <View style={[styles.actionsRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
          {quickActions.map((a) => (
            <Pressable
              key={a.key}
              onPress={() => {
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
              <Text style={[styles.actionLabel, { color: colors.foreground, textAlign }]}>{a.label}</Text>
            </Pressable>
          ))}
        </View>

        {/* Recent activity */}
        <View style={[styles.activityHeader, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground, marginBottom: 0, textAlign }]}>
            {t("home.recentContacts")}
          </Text>
          <Pressable onPress={() => router.push("/(tabs)/contacts")} hitSlop={8}>
            <Text style={[styles.seeAll, { color: colors.primary, textAlign }]}>{t("common.viewAll")}</Text>
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
              <Text style={[styles.activityEmptyText, { color: colors.mutedForeground, textAlign: "center" }]}>
                {t("empty.generic")}
              </Text>
            </View>
          ) : (
            data!.recentActivity.map(renderActivity)
          )}
        </View>

        {/* Powered by */}
        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
            {t("settings.poweredBy")}
          </Text>
        </View>
      </ScrollView>
      <DashboardFilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        filters={dashFilters}
        events={eventsData}
        onApply={(f) => {
          setDashFilters(f);
          setFilterOpen(false);
        }}
      />
    </View>
  );
}

function DashboardFilterSheet({
  open,
  onClose,
  filters,
  events,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  filters: DashboardFilters;
  events: Array<{ eventId: number; eventName: string }>;
  onApply: (f: DashboardFilters) => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t, isRTL, textAlign } = useLocale();
  const [draft, setDraft] = useState<DashboardFilters>(filters);

  const teamQuery = useGetTeamPerformance();
  const teamMembers: TeamPerformanceItem[] = teamQuery.data ?? [];

  useEffect(() => {
    if (open) setDraft(filters);
  }, [open, filters]);

  function chip(active: boolean, label: string, onPress: () => void, key: string) {
    return (
      <Pressable
        key={key}
        onPress={onPress}
        style={[
          styles.chip,
          {
            backgroundColor: active ? colors.primary : colors.card,
            borderColor: active ? colors.primary : colors.border,
          },
        ]}
      >
        <Text style={[styles.chipText, { color: active ? "#FFFFFF" : colors.foreground }]}>
          {label}
        </Text>
      </Pressable>
    );
  }

  return (
    <Modal
      visible={open}
      transparent
      animationType="slide"
      statusBarTranslucent
      hardwareAccelerated
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[
            styles.sheet,
            {
              backgroundColor: colors.background,
              borderColor: colors.border,
              paddingBottom: insets.bottom + 16,
              overflow: "hidden",
            },
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
          </View>
          <View style={[styles.sheetHeader, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
            <Text style={[styles.sheetTitle, { color: colors.foreground, textAlign }]}>
              {t("common.filters")}
            </Text>
            <Pressable onPress={() => setDraft(DEFAULT_DASH_FILTERS)} hitSlop={8}>
              <Text style={[styles.resetText, { color: colors.primary }]}>
                {t("common.clearAll")}
              </Text>
            </Pressable>
          </View>

          <ScrollView
            style={{ maxHeight: 460 }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 8 }}
          >
            {/* Event */}
            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>
              {t("contacts.fields.event", { defaultValue: "Event" }).toUpperCase()}
            </Text>
            <View style={[styles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {chip(!draft.eventId, t("common.all"), () => setDraft({ ...draft, eventId: null }), "ev-any")}
              {events.map((e) =>
                chip(
                  draft.eventId === e.eventId,
                  e.eventName,
                  () => setDraft({ ...draft, eventId: e.eventId }),
                  `ev-${e.eventId}`,
                ),
              )}
            </View>

            {/* Lead Status */}
            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>
              {t("contacts.statusLabel", { defaultValue: "STATUS" })}
            </Text>
            <View style={[styles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {chip(!draft.status, t("common.all"), () => setDraft({ ...draft, status: null }), "st-any")}
              {CONTACT_PIPELINE_ORDER.map((s) =>
                chip(
                  draft.status === s,
                  t(`leads.stages.${s}`, { defaultValue: prettyLabel(s) }),
                  () => setDraft({ ...draft, status: s }),
                  s,
                ),
              )}
            </View>

            {/* Lead Temperature */}
            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>
              {t("leads.temperature", { defaultValue: "Temperature" }).toUpperCase()}
            </Text>
            <View style={[styles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {chip(!draft.temperature, t("common.all"), () => setDraft({ ...draft, temperature: null }), "tp-any")}
              {(["hot", "warm", "cold"] as const).map((temp) =>
                chip(
                  draft.temperature === temp,
                  t(`leads.${temp}`, { defaultValue: prettyLabel(temp) }),
                  () => setDraft({ ...draft, temperature: temp }),
                  temp,
                ),
              )}
            </View>

            {/* Team Member */}
            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>
              {t("contacts.teamMember", { defaultValue: "Team Member" }).toUpperCase()}
            </Text>
            <View style={[styles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {chip(!draft.assignedToId, t("common.all"), () => setDraft({ ...draft, assignedToId: null }), "tm-any")}
              {teamMembers.map((m) =>
                chip(
                  draft.assignedToId === m.userId,
                  m.userName,
                  () => setDraft({ ...draft, assignedToId: m.userId }),
                  `tm-${m.userId}`,
                ),
              )}
            </View>

            {/* Capture Method */}
            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>
              {t("capture.title", { defaultValue: "Capture Method" }).toUpperCase()}
            </Text>
            <View style={[styles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {chip(!draft.captureMethod, t("common.all"), () => setDraft({ ...draft, captureMethod: null }), "cm-any")}
              {CAPTURE_METHODS.map((m) =>
                chip(
                  draft.captureMethod === m.key,
                  t(m.labelKey, { defaultValue: prettyLabel(m.key) }),
                  () => setDraft({ ...draft, captureMethod: m.key }),
                  `cm-${m.key}`,
                ),
              )}
            </View>

            {/* Date Range */}
            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>
              {t("contacts.capturedDate", { defaultValue: "DATE RANGE" })}
            </Text>
            <DateTimeField
              label={t("common.from")}
              date={draft.dateFrom}
              time={null}
              withTime={false}
              optional
              onChange={(d) => setDraft({ ...draft, dateFrom: d })}
            />
            <DateTimeField
              label={t("common.to")}
              date={draft.dateTo}
              time={null}
              withTime={false}
              optional
              onChange={(d) => setDraft({ ...draft, dateTo: d })}
            />
          </ScrollView>

          <Pressable
            onPress={() => onApply(draft)}
            style={[styles.applyBtn, { backgroundColor: colors.primary }]}
          >
            <Text style={styles.applyText}>{t("common.apply")}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
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
  eventCardRight: {
    alignItems: "center",
    gap: 8,
    alignSelf: "stretch",
    justifyContent: "space-between",
    paddingVertical: 2,
  },
  eventFilterBtn: {
    width: 32,
    height: 32,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  filterBtn: {
    width: 36,
    height: 36,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  filterCount: {
    position: "absolute",
    top: -5,
    right: -5,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  filterCountText: {
    fontSize: 11,
    fontFamily: FONT.bold,
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
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sheetTitle: { fontSize: 19, fontFamily: FONT.bold },
  resetText: { fontSize: 14.5, fontFamily: FONT.semibold },
  fLabel: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 8,
  },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: { fontSize: 13.5, fontFamily: FONT.medium },
  applyBtn: {
    marginTop: 14,
    height: 52,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  applyText: { color: "#FFFFFF", fontSize: 16, fontFamily: FONT.semibold },
});
