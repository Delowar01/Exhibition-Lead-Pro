import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
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
  type Contact,
  type EventReportDayCount,
  type EventReportTeamItem,
  type EventReportUserCount,
  type GetEventReportParams,
  ListContactsSort,
  useGetEventReport,
  useGetTeamPerformance,
  useListContacts,
  useListLeads,
  useListMeetings,
} from "@workspace/api-client-react";

import { DateTimeField } from "@/components/DateTimeField";
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
import { useLocale } from "@/hooks/useLocale";
import { formatGregorian } from "@/lib/date";

// ─── Types ────────────────────────────────────────────────────────────────────

type DatePreset = "all" | "7d" | "30d";

/**
 * Mutually-exclusive sort key.
 * "none" = default server order on the contacts list (newest first).
 *
 * All keys are fully applied (API or client-side):
 *  name_*       → client-side on Contact.fullName
 *  company_*    → client-side on Contact.contactCompany
 *  date_*       → API param (ListContactsSort.newest / oldest)
 *  score_*      → client-side on Contact.leadScore
 *  pipeline_*   → client-side using lead.value joined from useListLeads({ eventId })
 *  followup_*   → client-side on Contact.followUpDate
 *  meeting_*    → client-side using meetingDate joined from useListMeetings({})
 *                 (meetings are company-scoped; only ones with a known contactId are used)
 */
type SortKey =
  | "none"
  | "name_asc"
  | "name_desc"
  | "company_asc"
  | "company_desc"
  | "date_desc"
  | "date_asc"
  | "score_desc"
  | "score_asc"
  | "followup_asc"
  | "followup_desc"
  | "pipeline_desc"
  | "pipeline_asc"
  | "meeting_asc"
  | "meeting_desc";

interface ReportFilters {
  datePreset: DatePreset;
  dateFrom: string | null;
  dateTo: string | null;
  assignedToId: number | null;
  status: string | null;
  temperature: string | null;
  /**
   * Client-side filter applied to the contacts list after the API call.
   * Uses Contact.cardImageUrl as the source-of-truth proxy:
   *   "camera" → contacts WITH a stored card image (cardImageUrl != null)
   *   "other"  → contacts WITHOUT a stored card image (cardImageUrl == null)
   *   null     → all contacts (no filter)
   *
   * Only two options are exposed so each selection maps to a distinct,
   * non-overlapping data bucket. QR/NFC/Manual cannot be distinguished from
   * Contact data and are therefore grouped under "other".
   * The API does not support captureMethod as a query param, so this filter
   * is applied client-side on the contacts list only; the aggregate KPI
   * stats/charts/team sections come from useGetEventReport which is not
   * affected by this filter (it IS affected by status/temperature/date/team).
   */
  captureMethod: "camera" | "other" | null;
  sortKey: SortKey;
}

const DEFAULT_FILTERS: ReportFilters = {
  datePreset: "all",
  dateFrom: null,
  dateTo: null,
  assignedToId: null,
  status: null,
  temperature: null,
  captureMethod: null,
  sortKey: "none",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Apply client-side capture-method filter.
 *   "camera" → keep contacts with a stored card image (cardImageUrl != null)
 *   "other"  → keep contacts without a stored card image (cardImageUrl == null)
 *   null     → return all (no filter)
 */
function applyCaptureMethodClient(
  contacts: Contact[],
  captureMethod: ReportFilters["captureMethod"],
): Contact[] {
  if (!captureMethod) return contacts;
  if (captureMethod === "camera")
    return contacts.filter((c) => c.cardImageUrl != null);
  return contacts.filter((c) => c.cardImageUrl == null);
}

const DATE_PRESETS: { key: DatePreset; labelKey: string }[] = [
  { key: "all", labelKey: "eventReport.allTime" },
  { key: "7d", labelKey: "eventReport.last7" },
  { key: "30d", labelKey: "eventReport.last30" },
];

const STATUS_FILTERS = ["new", "contacted", "quotation_sent", "negotiation", "won", "lost"];
const TEMPERATURE_FILTERS = ["hot", "warm", "cold"] as const;

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

function qualMax(report?: { qualificationDistribution: { hot: number; warm: number; cold: number } }): number {
  if (!report) return 1;
  const q = report.qualificationDistribution;
  return Math.max(q.hot, q.warm, q.cold, 1);
}

function rankPerformers(items: EventReportTeamItem[]): EventReportTeamItem[] {
  return [...items].sort((a, b) => b.leads - a.leads || b.qualified - a.qualified);
}

/** Map our SortKey to the API sort param (or null for client-side sorts). */
function apiSortParam(key: SortKey): ListContactsSort | undefined {
  if (key === "date_desc" || key === "none") return ListContactsSort.newest;
  if (key === "date_asc") return ListContactsSort.oldest;
  if (key === "name_asc") return ListContactsSort.name;
  return undefined; // client-side
}

/**
 * Apply client-side sort to a contacts array.
 *
 * @param leadValueMap  contactId → lead.value (from useListLeads({ eventId })).
 *                      Contacts not in the map sort last (pipeline_* modes).
 * @param meetingDateMap contactId → earliest scheduledMeetingDate string
 *                      (from useListMeetings({}), company-scoped).
 *                      Contacts with no meeting sort last (meeting_* modes).
 */
function applySortClient(
  contacts: Contact[],
  key: SortKey,
  leadValueMap: Map<number, number>,
  meetingDateMap: Map<number, string>,
): Contact[] {
  if (
    key === "none" ||
    key === "date_desc" ||
    key === "date_asc" ||
    key === "name_asc"
  ) {
    return contacts;
  }
  const copy = [...contacts];
  switch (key) {
    case "name_desc":
      return copy.sort((a, b) =>
        (b.fullName ?? "").localeCompare(a.fullName ?? ""),
      );
    case "company_asc":
      return copy.sort((a, b) =>
        (a.contactCompany ?? "").localeCompare(b.contactCompany ?? ""),
      );
    case "company_desc":
      return copy.sort((a, b) =>
        (b.contactCompany ?? "").localeCompare(a.contactCompany ?? ""),
      );
    case "score_desc":
      return copy.sort((a, b) => (b.leadScore ?? 0) - (a.leadScore ?? 0));
    case "score_asc":
      return copy.sort((a, b) => (a.leadScore ?? 0) - (b.leadScore ?? 0));
    case "pipeline_desc":
      return copy.sort(
        (a, b) =>
          (leadValueMap.get(b.id) ?? -1) - (leadValueMap.get(a.id) ?? -1),
      );
    case "pipeline_asc":
      return copy.sort(
        (a, b) =>
          (leadValueMap.get(a.id) ?? Infinity) -
          (leadValueMap.get(b.id) ?? Infinity),
      );
    case "followup_asc":
      return copy.sort((a, b) =>
        (a.followUpDate ?? "9999").localeCompare(b.followUpDate ?? "9999"),
      );
    case "followup_desc":
      return copy.sort((a, b) =>
        (b.followUpDate ?? "").localeCompare(a.followUpDate ?? ""),
      );
    case "meeting_asc":
      // Contacts with a scheduled meeting date sort earliest-first;
      // contacts with no meeting sort to the end.
      return copy.sort((a, b) =>
        (meetingDateMap.get(a.id) ?? "9999-99-99").localeCompare(
          meetingDateMap.get(b.id) ?? "9999-99-99",
        ),
      );
    case "meeting_desc":
      // Latest meeting first; contacts with no meeting sort to the end.
      return copy.sort((a, b) =>
        (meetingDateMap.get(b.id) ?? "").localeCompare(
          meetingDateMap.get(a.id) ?? "",
        ),
      );
    default:
      return copy;
  }
}

/** Count active (non-default) filter + sort values for badge display. */
function countActive(f: ReportFilters): number {
  return [
    f.datePreset !== "all" || f.dateFrom != null || f.dateTo != null,
    f.assignedToId != null,
    f.status != null,
    f.temperature != null,
    f.captureMethod != null,
    f.sortKey !== "none",
  ].filter(Boolean).length;
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function EventReportScreen() {
  const colors = useColors();
  const { t } = useLocale();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventId = Number(id);

  const [filters, setFilters] = useState<ReportFilters>(DEFAULT_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);

  const activeCount = countActive(filters);

  const teamQuery = useGetTeamPerformance();
  const teamMembers = teamQuery.data ?? [];

  // ── Report aggregate params ────────────────────────────────────────────────
  const reportParams: GetEventReportParams = useMemo(() => {
    const dateFrom = filters.dateFrom ?? dateFromPreset(filters.datePreset);
    return {
      eventId,
      ...(dateFrom ? { dateFrom } : {}),
      ...(filters.dateTo ? { dateTo: filters.dateTo } : {}),
      ...(filters.assignedToId != null ? { assignedToId: filters.assignedToId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.temperature ? { temperature: filters.temperature } : {}),
    };
  }, [eventId, filters]);

  const query = useGetEventReport(reportParams);
  const report = query.data;

  // ── Contacts list (with real sort + filter support) ───────────────────────
  const contactsSort = apiSortParam(filters.sortKey);
  const contactsParams = useMemo(() => {
    const dateFrom = filters.dateFrom ?? dateFromPreset(filters.datePreset);
    return {
      eventId,
      limit: 200,
      ...(dateFrom ? { dateFrom } : {}),
      ...(filters.dateTo ? { dateTo: filters.dateTo } : {}),
      ...(filters.assignedToId != null ? { assignedTo: filters.assignedToId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.temperature ? { temperature: filters.temperature } : {}),
      ...(contactsSort ? { sort: contactsSort } : {}),
    };
  }, [eventId, filters, contactsSort]);

  const contactsQuery = useListContacts(contactsParams);
  const contactsRaw = contactsQuery.data?.contacts ?? [];

  // Fetch leads for the same event so we can sort by pipeline value (lead.value)
  const leadsQuery = useListLeads({ eventId, limit: 200 });
  const leadValueMap = useMemo<Map<number, number>>(() => {
    const map = new Map<number, number>();
    for (const lead of leadsQuery.data?.leads ?? []) {
      if (lead.contactId != null && lead.value != null) {
        // If a contact has multiple leads, keep the highest value
        const existing = map.get(lead.contactId) ?? -Infinity;
        if (lead.value > existing) map.set(lead.contactId, lead.value);
      }
    }
    return map;
  }, [leadsQuery.data]);

  // Fetch all company meetings (tenant-scoped by requireAuth) to build a
  // contactId → earliest meetingDate map for the meeting_* sort modes.
  const meetingsQuery = useListMeetings({});
  const meetingDateMap = useMemo<Map<number, string>>(() => {
    const map = new Map<number, string>();
    for (const m of meetingsQuery.data?.meetings ?? []) {
      if (m.contactId != null && m.meetingDate != null) {
        const existing = map.get(m.contactId);
        // Keep the earliest upcoming meeting date per contact
        if (!existing || m.meetingDate < existing) {
          map.set(m.contactId, m.meetingDate);
        }
      }
    }
    return map;
  }, [meetingsQuery.data]);

  // Apply capture method client-side filter, then sort
  const contacts = useMemo(
    () =>
      applySortClient(
        applyCaptureMethodClient(contactsRaw, filters.captureMethod),
        filters.sortKey,
        leadValueMap,
        meetingDateMap,
      ),
    [contactsRaw, filters.captureMethod, filters.sortKey, leadValueMap, meetingDateMap],
  );

  // ── KPI metrics ───────────────────────────────────────────────────────────
  const metrics: { label: string; value: string; icon: keyof typeof Feather.glyphMap; color: string }[] =
    report
      ? [
          { label: t("eventReport.totalLeads"), value: String(report.totalLeads), icon: "users", color: colors.primary },
          { label: t("leads.hot"), value: String(report.hotLeads), icon: "trending-up", color: LEAD_TEMPERATURE_COLORS.hot },
          { label: t("leads.warm"), value: String(report.warmLeads), icon: "thermometer", color: LEAD_TEMPERATURE_COLORS.warm },
          { label: t("leads.cold"), value: String(report.coldLeads), icon: "wind", color: LEAD_TEMPERATURE_COLORS.cold },
          { label: t("eventReport.meetings"), value: String(report.meetings), icon: "calendar", color: "#06B6D4" },
          { label: t("eventReport.followUps"), value: String(report.followUps), icon: "clock", color: "#8B5CF6" },
          { label: t("eventReport.won"), value: String(report.wonDeals), icon: "award", color: "#22C55E" },
          { label: t("eventReport.lost"), value: String(report.lostDeals), icon: "x-circle", color: "#EF4444" },
        ]
      : [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: report?.eventName ?? t("eventReport.reportFallback"),
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.foreground,
          headerTitleStyle: { fontFamily: FONT.semibold },
          headerRight: () => (
            <Pressable
              onPress={() => {
                if (Platform.OS !== "web") Haptics.selectionAsync();
                setFilterOpen(true);
              }}
              hitSlop={8}
              style={[
                styles.filterBtn,
                {
                  backgroundColor: activeCount > 0 ? colors.primary + "1A" : "transparent",
                  borderColor: activeCount > 0 ? colors.primary : colors.border,
                  borderRadius: colors.radius,
                },
              ]}
            >
              <Feather
                name="sliders"
                size={16}
                color={activeCount > 0 ? colors.primary : colors.foreground}
              />
              {activeCount > 0 ? (
                <View style={[styles.filterBadge, { backgroundColor: colors.primary }]}>
                  <Text style={styles.filterBadgeText}>{activeCount}</Text>
                </View>
              ) : null}
            </Pressable>
          ),
        }}
      />

      {query.isLoading && !report ? (
        <LoadingState />
      ) : query.isError && !report ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40, flexGrow: 1 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching || contactsQuery.isRefetching}
              onRefresh={() => {
                query.refetch();
                contactsQuery.refetch();
              }}
              tintColor={colors.primary}
            />
          }
        >
          {/* KPI metrics grid */}
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
              <Text style={styles.pipelineLabel}>{t("eventReport.pipelineValue")}</Text>
            </View>
          </View>

          {/* Qualification distribution */}
          <Section title={t("eventReport.qualificationDistribution")}>
            <View style={{ gap: 10 }}>
              <DistRow
                label={t("leads.hot")}
                count={report?.qualificationDistribution.hot ?? 0}
                max={qualMax(report)}
                color={LEAD_TEMPERATURE_COLORS.hot}
              />
              <DistRow
                label={t("leads.warm")}
                count={report?.qualificationDistribution.warm ?? 0}
                max={qualMax(report)}
                color={LEAD_TEMPERATURE_COLORS.warm}
              />
              <DistRow
                label={t("leads.cold")}
                count={report?.qualificationDistribution.cold ?? 0}
                max={qualMax(report)}
                color={LEAD_TEMPERATURE_COLORS.cold}
              />
            </View>
          </Section>

          {/* Status distribution */}
          {report && report.statusDistribution.length > 0 ? (
            <Section title={t("eventReport.statusDistribution")}>
              <View style={{ gap: 10 }}>
                {report.statusDistribution.map((s) => (
                  <DistRow
                    key={s.status}
                    label={t("leads.stages." + s.status, { defaultValue: prettyLabel(s.status) })}
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
            <Section title={t("eventReport.leadsByDay")}>
              <LeadsByDayChart data={report.leadsByDay} color={colors.primary} />
            </Section>
          ) : null}

          {/* Leads by user */}
          {report && report.leadsByUser.length > 0 ? (
            <Section title={t("eventReport.leadsByUser")}>
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
            <Section title={t("eventReport.teamPerformance")}>
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
                          {`${t("eventReport.perfLeads", { count: m.leads })} · ${t("eventReport.wonCount", { count: m.won })}`}
                        </Text>
                      </View>
                    </View>
                  ))}
              </View>
            </Section>
          ) : null}

          {/* Top performer */}
          {report && report.teamPerformance.length > 0 ? (
            <Section title={t("eventReport.topPerformer")}>
              <View style={{ gap: 12 }}>
                {rankPerformers(report.teamPerformance)
                  .slice(0, 1)
                  .map((m) => (
                    <PerformerRow
                      key={m.userId}
                      performer={m}
                      onPress={() => router.push(`/event/${eventId}/member/${m.userId}`)}
                    />
                  ))}
              </View>
            </Section>
          ) : null}

          {/* Contacts list — real sortable list filtered by event */}
          {contacts.length > 0 ? (
            <Section title={t("eventReport.contactsList")}>
              <View style={{ gap: 0 }}>
                {contacts.map((c, idx) => (
                  <Pressable
                    key={c.id}
                    onPress={() => router.push(`/contact/${c.id}`)}
                    style={({ pressed }) => [
                      styles.contactRow,
                      idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                      { opacity: pressed ? 0.7 : 1 },
                    ]}
                  >
                    <Avatar name={c.fullName ?? undefined} size={36} color={colors.primary} />
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={[styles.contactName, { color: colors.foreground }]}>
                        {c.fullName ?? prettyLabel(c.status)}
                      </Text>
                      {c.contactCompany ? (
                        <Text numberOfLines={1} style={[styles.contactSub, { color: colors.mutedForeground }]}>
                          {c.contactCompany}
                        </Text>
                      ) : null}
                    </View>
                    {c.leadTemperature ? (
                      <View
                        style={[
                          styles.tempDot,
                          { backgroundColor: LEAD_TEMPERATURE_COLORS[c.leadTemperature] ?? colors.muted },
                        ]}
                      />
                    ) : null}
                    {c.leadScore != null ? (
                      <Text style={[styles.scoreText, { color: colors.mutedForeground }]}>
                        {c.leadScore}
                      </Text>
                    ) : null}
                    <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
                  </Pressable>
                ))}
              </View>
            </Section>
          ) : report && report.totalLeads === 0 ? (
            <Text style={[styles.emptyLine, { color: colors.mutedForeground }]}>
              {t("eventReport.noLeadsMatch")}
            </Text>
          ) : null}
        </ScrollView>
      )}

      <EventReportFilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        filters={filters}
        teamMembers={teamMembers}
        onApply={(f) => {
          setFilters(f);
          setFilterOpen(false);
        }}
      />
    </View>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PerformerRow({
  performer,
  onPress,
}: {
  performer: EventReportTeamItem;
  onPress: () => void;
}) {
  const colors = useColors();
  const { t } = useLocale();
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
          {`${t("eventReport.perfLeads", { count: performer.leads })} · ${t("eventReport.qualifiedCount", { count: performer.qualified })}`}
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

// ─── Filter Sheet ─────────────────────────────────────────────────────────────

/**
 * Sort options that can be applied to the contacts list.
 *
 * - name_*    / name_desc  → client-side on Contact.fullName
 * - company_* → client-side on Contact.contactCompany
 * - date_*    → API sort param (newest / oldest / name)
 * - score_*   → client-side on Contact.leadScore
 * - followup_*→ client-side on Contact.followUpDate
 */
interface SortOption {
  key: SortKey;
  fieldLabelKey: string;
  dirLabel: string;
}

const SORT_OPTIONS: SortOption[] = [
  { key: "name_asc",      fieldLabelKey: "eventReport.sortLeadName",      dirLabel: "A → Z" },
  { key: "name_desc",     fieldLabelKey: "eventReport.sortLeadName",      dirLabel: "Z → A" },
  { key: "company_asc",   fieldLabelKey: "eventReport.sortCompanyName",   dirLabel: "A → Z" },
  { key: "company_desc",  fieldLabelKey: "eventReport.sortCompanyName",   dirLabel: "Z → A" },
  { key: "date_desc",     fieldLabelKey: "eventReport.sortCaptureDate",   dirLabel: "eventReport.dirNewest" },
  { key: "date_asc",      fieldLabelKey: "eventReport.sortCaptureDate",   dirLabel: "eventReport.dirOldest" },
  { key: "score_desc",    fieldLabelKey: "eventReport.sortLeadScore",     dirLabel: "eventReport.dirHighest" },
  { key: "score_asc",     fieldLabelKey: "eventReport.sortLeadScore",     dirLabel: "eventReport.dirLowest" },
  { key: "pipeline_desc", fieldLabelKey: "eventReport.sortPipelineValue", dirLabel: "eventReport.dirHighest" },
  { key: "pipeline_asc",  fieldLabelKey: "eventReport.sortPipelineValue", dirLabel: "eventReport.dirLowest" },
  { key: "followup_asc",  fieldLabelKey: "eventReport.sortFollowUpDate",  dirLabel: "eventReport.dirEarliest" },
  { key: "followup_desc", fieldLabelKey: "eventReport.sortFollowUpDate",  dirLabel: "eventReport.dirLatest" },
  { key: "meeting_asc",   fieldLabelKey: "eventReport.sortMeetingDate",   dirLabel: "eventReport.dirEarliest" },
  { key: "meeting_desc",  fieldLabelKey: "eventReport.sortMeetingDate",   dirLabel: "eventReport.dirLatest" },
];

type SortGroup = { fieldLabelKey: string; options: SortOption[] };

function groupSortOptions(): SortGroup[] {
  const groups: SortGroup[] = [];
  const seen = new Set<string>();
  for (const opt of SORT_OPTIONS) {
    if (!seen.has(opt.fieldLabelKey)) {
      seen.add(opt.fieldLabelKey);
      groups.push({
        fieldLabelKey: opt.fieldLabelKey,
        options: SORT_OPTIONS.filter((o) => o.fieldLabelKey === opt.fieldLabelKey),
      });
    }
  }
  return groups;
}

const SORT_GROUPS = groupSortOptions();

function EventReportFilterSheet({
  open,
  onClose,
  filters,
  teamMembers,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  filters: ReportFilters;
  teamMembers: { userId: number; userName: string }[];
  onApply: (f: ReportFilters) => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t, isRTL, textAlign } = useLocale();
  const [draft, setDraft] = useState<ReportFilters>(filters);

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

  function sortChip(opt: SortOption) {
    const active = draft.sortKey === opt.key;
    const dirLabel = opt.dirLabel.startsWith("eventReport.")
      ? t(opt.dirLabel as Parameters<typeof t>[0])
      : opt.dirLabel;
    return (
      <Pressable
        key={opt.key}
        onPress={() => setDraft({ ...draft, sortKey: draft.sortKey === opt.key ? "none" : opt.key })}
        style={[
          styles.chip,
          {
            backgroundColor: active ? colors.primary : colors.card,
            borderColor: active ? colors.primary : colors.border,
          },
        ]}
      >
        <Text style={[styles.chipText, { color: active ? "#FFFFFF" : colors.foreground }]}>
          {dirLabel}
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
          {/* Handle */}
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
          </View>

          {/* Header */}
          <View style={[styles.sheetHeader, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
            <Text style={[styles.sheetTitle, { color: colors.foreground, textAlign }]}>
              {t("common.filters")}
            </Text>
            <Pressable onPress={() => setDraft(DEFAULT_FILTERS)} hitSlop={8}>
              <Text style={[styles.resetText, { color: colors.primary }]}>
                {t("common.clearAll")}
              </Text>
            </Pressable>
          </View>

          <ScrollView
            style={{ maxHeight: 520 }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 8 }}
          >
            {/* Lead Status */}
            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>
              {t("eventReport.leadStatus").toUpperCase()}
            </Text>
            <View style={[styles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {chip(!draft.status, t("eventReport.any"), () => setDraft({ ...draft, status: null }), "st-any")}
              {STATUS_FILTERS.map((s) =>
                chip(
                  draft.status === s,
                  t(`leads.stages.${s}` as Parameters<typeof t>[0], { defaultValue: prettyLabel(s) }),
                  () => setDraft({ ...draft, status: draft.status === s ? null : s }),
                  s,
                ),
              )}
            </View>

            {/* Lead Temperature */}
            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>
              {t("eventReport.temperature").toUpperCase()}
            </Text>
            <View style={[styles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {chip(!draft.temperature, t("eventReport.any"), () => setDraft({ ...draft, temperature: null }), "tp-any")}
              {TEMPERATURE_FILTERS.map((temp) =>
                chip(
                  draft.temperature === temp,
                  t(`leads.${temp}` as Parameters<typeof t>[0], { defaultValue: prettyLabel(temp) }),
                  () => setDraft({ ...draft, temperature: draft.temperature === temp ? null : temp }),
                  temp,
                ),
              )}
            </View>

            {/* Team Member */}
            {teamMembers.length > 0 ? (
              <>
                <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>
                  {t("eventReport.teamMember").toUpperCase()}
                </Text>
                <View style={[styles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                  {chip(!draft.assignedToId, t("eventReport.everyone"), () => setDraft({ ...draft, assignedToId: null }), "tm-any")}
                  {teamMembers.map((m) =>
                    chip(
                      draft.assignedToId === m.userId,
                      m.userName,
                      () => setDraft({ ...draft, assignedToId: draft.assignedToId === m.userId ? null : m.userId }),
                      `tm-${m.userId}`,
                    ),
                  )}
                </View>
              </>
            ) : null}

            {/* Capture Method — 2 real buckets based on Contact.cardImageUrl */}
            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>
              {t("eventReport.captureMethod").toUpperCase()}
            </Text>
            <View style={[styles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {chip(!draft.captureMethod, t("eventReport.any"), () => setDraft({ ...draft, captureMethod: null }), "cm-any")}
              {chip(
                draft.captureMethod === "camera",
                t("capture.businessCard"),
                () => setDraft({ ...draft, captureMethod: draft.captureMethod === "camera" ? null : "camera" }),
                "cm-camera",
              )}
              {chip(
                draft.captureMethod === "other",
                t("eventReport.captureOther"),
                () => setDraft({ ...draft, captureMethod: draft.captureMethod === "other" ? null : "other" }),
                "cm-other",
              )}
            </View>

            {/* Date Range */}
            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>
              {t("eventReport.dateRange").toUpperCase()}
            </Text>
            <View style={[styles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {DATE_PRESETS.map((p) =>
                chip(
                  draft.datePreset === p.key && !draft.dateFrom && !draft.dateTo,
                  t(p.labelKey as Parameters<typeof t>[0]),
                  () => setDraft({ ...draft, datePreset: p.key, dateFrom: null, dateTo: null }),
                  p.key,
                ),
              )}
            </View>
            <DateTimeField
              label={t("common.from")}
              date={draft.dateFrom}
              time={null}
              withTime={false}
              optional
              onChange={(d) => setDraft({ ...draft, dateFrom: d, datePreset: "all" })}
            />
            <DateTimeField
              label={t("common.to")}
              date={draft.dateTo}
              time={null}
              withTime={false}
              optional
              onChange={(d) => setDraft({ ...draft, dateTo: d, datePreset: "all" })}
            />

            {/* Sort By */}
            <View style={[styles.sortDivider, { borderTopColor: colors.border }]} />
            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>
              {t("eventReport.sortBy").toUpperCase()}
            </Text>
            {SORT_GROUPS.map((group) => (
              <View key={group.fieldLabelKey} style={styles.sortRow}>
                <Text style={[styles.sortFieldLabel, { color: colors.foreground }]}>
                  {t(group.fieldLabelKey as Parameters<typeof t>[0])}
                </Text>
                <View style={[styles.sortDirChips, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                  {group.options.map((opt) => sortChip(opt))}
                </View>
              </View>
            ))}
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

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  filterBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    marginRight: 4,
  },
  filterBadge: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 3,
  },
  filterBadgeText: {
    color: "#FFFFFF",
    fontSize: 10,
    fontFamily: FONT.bold,
    lineHeight: 14,
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 4,
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
  contactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
  },
  contactName: {
    fontSize: 14,
    fontFamily: FONT.semibold,
  },
  contactSub: {
    fontSize: 12.5,
    fontFamily: FONT.regular,
    marginTop: 1,
  },
  tempDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  scoreText: {
    fontSize: 12,
    fontFamily: FONT.semibold,
    minWidth: 22,
    textAlign: "right",
  },
  emptyLine: {
    fontSize: 14,
    fontFamily: FONT.regular,
    textAlign: "center",
    marginTop: 28,
  },
  // Sheet
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  handleWrap: {
    alignItems: "center",
    paddingVertical: 8,
  },
  handle: {
    width: 38,
    height: 4,
    borderRadius: 2,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
    marginBottom: 14,
  },
  sheetTitle: {
    fontSize: 17,
    fontFamily: FONT.bold,
  },
  resetText: {
    fontSize: 14,
    fontFamily: FONT.semibold,
  },
  fLabel: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.4,
    marginBottom: 8,
    marginTop: 4,
  },
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 14,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderRadius: 20,
  },
  chipText: {
    fontSize: 13,
    fontFamily: FONT.semibold,
  },
  sortDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    marginVertical: 14,
  },
  sortRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 10,
  },
  sortFieldLabel: {
    fontSize: 13.5,
    fontFamily: FONT.medium,
    flex: 1,
  },
  sortDirChips: {
    flexDirection: "row",
    gap: 6,
  },
  applyBtn: {
    height: 50,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 12,
  },
  applyText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontFamily: FONT.semibold,
  },
});
