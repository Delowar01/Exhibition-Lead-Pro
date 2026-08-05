import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type Contact,
  getListContactsQueryKey,
  getListEventsQueryKey,
  getListSavedSearchesQueryKey,
  type ListContactsParams,
  type SavedSearch,
  useListContacts,
  useListEvents,
  useListSavedSearches,
  useCreateSavedSearch,
  useDeleteSavedSearch,
} from "@workspace/api-client-react";

import { DateTimeField } from "@/components/DateTimeField";
import { ExportSheet } from "@/components/ExportSheet";
import {
  Avatar,
  Badge,
  CONTACT_PIPELINE_ORDER,
  CONTACT_STATUS_COLORS,
  EmptyState,
  ErrorState,
  FONT,
  LEAD_TEMPERATURE_COLORS,
  LoadingState,
  prettyLabel,
} from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { canExport } from "@/lib/export-permissions";
import {
  DEFAULT_CONTACT_FILTERS,
  type ContactFilters,
  type ContactSortPref,
  useSettings,
} from "@/contexts/SettingsContext";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";

function contactName(c: Contact, fallback: string): string {
  if (c.fullName) return c.fullName;
  const parts = [c.firstName, c.lastName].filter(Boolean);
  return parts.length ? parts.join(" ") : fallback;
}

type ColorTokens = ReturnType<typeof useColors>;
type TFn = (key: string, options?: Record<string, unknown>) => string;

// Memoized list row: with React.memo it only re-renders when ITS contact (or the
// theme) changes, so scrolling a long list and background lead-score updates
// don't re-render every visible row. `colors`, `t`, `isRTL`, `textAlign` and
// `onPress` are all stable references from the parent.
const ContactRow = React.memo(function ContactRow({
  item,
  colors,
  isRTL,
  textAlign,
  t,
  unnamedLabel,
  onPress,
}: {
  item: Contact;
  colors: ColorTokens;
  isRTL: boolean;
  textAlign: "left" | "right";
  t: TFn;
  unnamedLabel: string;
  onPress: (id: number) => void;
}) {
  const statusColor = CONTACT_STATUS_COLORS[item.status] ?? colors.mutedForeground;
  return (
    <Pressable
      onPress={() => onPress(item.id)}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderRadius: colors.radius + 4,
          opacity: pressed ? 0.7 : 1,
          flexDirection: isRTL ? "row-reverse" : "row",
        },
      ]}
    >
      <Avatar name={contactName(item, unnamedLabel)} color={statusColor} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={[styles.name, { color: colors.foreground, textAlign }]}>
          {contactName(item, unnamedLabel)}
        </Text>
        <Text numberOfLines={1} style={[styles.sub, { color: colors.mutedForeground, textAlign }]}>
          {[item.jobTitle, item.contactCompany].filter(Boolean).join(" · ") ||
            item.email ||
            t("common.noDetails")}
        </Text>
        <View style={[styles.badgeRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
          <Badge
            label={t(`leads.stages.${item.status}`, { defaultValue: prettyLabel(item.status) })}
            color={statusColor}
          />
          {item.leadTemperature ? (
            <Badge
              label={
                typeof item.leadScore === "number"
                  ? `${t(`leads.${item.leadTemperature}`, { defaultValue: prettyLabel(item.leadTemperature) })} · ${item.leadScore}`
                  : t(`leads.${item.leadTemperature}`, { defaultValue: prettyLabel(item.leadTemperature) })
              }
              color={LEAD_TEMPERATURE_COLORS[item.leadTemperature] ?? colors.mutedForeground}
            />
          ) : null}
          {item.followUpDate ? (
            <Feather name="clock" size={13} color={colors.mutedForeground} />
          ) : null}
        </View>
      </View>
      <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
    </Pressable>
  );
});

const SORT_OPTIONS: { key: ContactSortPref; labelKey: string }[] = [
  { key: "newest", labelKey: "contacts.sortNewest" },
  { key: "oldest", labelKey: "contacts.sortOldest" },
  { key: "name", labelKey: "contacts.sortName" },
];

const TEMPERATURES = ["hot", "warm", "cold"];

const SAVED_FILTER_ENTITY = "contact-mobile-filter";

function countActiveFilters(f: ContactFilters): number {
  let n = 0;
  if (f.status) n++;
  if (f.eventId) n++;
  if (f.temperature) n++;
  if (f.hasFollowUp) n++;
  if (f.hasMeeting) n++;
  if (f.dateFrom || f.dateTo) n++;
  if (f.sort !== "newest") n++;
  return n;
}

export default function ContactsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL, textAlign } = useLocale();
  const { contactFilters, setContactFilters, isLoaded } = useSettings();

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const { user } = useAuth();
  const showExport = canExport(user);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const filters = contactFilters;

  const listParams: ListContactsParams = useMemo(() => {
    const p: ListContactsParams = {
      limit: 200,
      includeDuplicates: false,
      sort: filters.sort,
    };
    if (debounced) p.search = debounced;
    if (filters.status) p.status = filters.status;
    if (filters.temperature) p.temperature = filters.temperature;
    if (filters.eventId) p.eventId = filters.eventId;
    if (filters.hasFollowUp) p.hasFollowUp = true;
    if (filters.hasMeeting) p.hasMeeting = true;
    if (filters.dateFrom) p.dateFrom = filters.dateFrom;
    if (filters.dateTo) p.dateTo = filters.dateTo;
    return p;
  }, [filters, debounced]);

  const query = useListContacts(listParams, {
    query: { enabled: isLoaded, queryKey: getListContactsQueryKey(listParams) },
  });

  // Unfiltered counts for the dashboard widgets (real-time across all contacts).
  const countsParams: ListContactsParams = { limit: 500, includeDuplicates: false };
  const countsQuery = useListContacts(countsParams, {
    query: { enabled: isLoaded, queryKey: getListContactsQueryKey(countsParams) },
  });

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  const contacts = query.data?.contacts ?? [];

  const { width: windowWidth } = useWindowDimensions();
  const cardWidth = (windowWidth - 40 - 21) / 4;

  const counts = useMemo(() => {
    const all = countsQuery.data?.contacts ?? [];
    return {
      total: all.length,
      new: all.filter((c) => c.status === "new").length,
      contacted: all.filter((c) => c.status === "contacted").length,
      hot: all.filter((c) => c.leadTemperature === "hot").length,
      warm: all.filter((c) => c.leadTemperature === "warm").length,
      cold: all.filter((c) => c.leadTemperature === "cold").length,
      won: all.filter((c) => c.status === "won").length,
      lost: all.filter((c) => c.status === "lost").length,
    };
  }, [countsQuery.data]);

  const activeCount = countActiveFilters(filters);

  function patchFilters(patch: Partial<ContactFilters>) {
    setContactFilters({ ...filters, ...patch });
  }

  function toggleWidget(kind: "total" | "new" | "contacted" | "hot" | "warm" | "cold" | "won" | "lost") {
    if (kind === "total") {
      patchFilters({ status: null, temperature: null });
    } else if (kind === "hot" || kind === "warm" || kind === "cold") {
      patchFilters({
        temperature: filters.temperature === kind ? null : kind,
        status: null,
      });
    } else {
      patchFilters({
        status: filters.status === kind ? null : kind,
        temperature: null,
      });
    }
  }

  const widgets: {
    key: "total" | "new" | "contacted" | "hot" | "warm" | "cold" | "won" | "lost";
    label: string;
    value: number;
    color: string;
    icon: keyof typeof Feather.glyphMap;
    active: boolean;
  }[] = [
    {
      key: "total",
      label: t("common.total"),
      value: counts.total,
      color: colors.primary,
      icon: "users",
      active: !filters.status && !filters.temperature,
    },
    {
      key: "new",
      label: t("leads.stages.new"),
      value: counts.new,
      color: CONTACT_STATUS_COLORS.new,
      icon: "user-plus",
      active: filters.status === "new",
    },
    {
      key: "contacted",
      label: t("leads.stages.contacted"),
      value: counts.contacted,
      color: CONTACT_STATUS_COLORS.contacted,
      icon: "message-circle",
      active: filters.status === "contacted",
    },
    {
      key: "hot",
      label: t("leads.hot"),
      value: counts.hot,
      color: LEAD_TEMPERATURE_COLORS.hot,
      icon: "trending-up",
      active: filters.temperature === "hot",
    },
    {
      key: "warm",
      label: t("leads.warm"),
      value: counts.warm,
      color: LEAD_TEMPERATURE_COLORS.warm,
      icon: "thermometer",
      active: filters.temperature === "warm",
    },
    {
      key: "cold",
      label: t("leads.cold"),
      value: counts.cold,
      color: LEAD_TEMPERATURE_COLORS.cold,
      icon: "wind",
      active: filters.temperature === "cold",
    },
    {
      key: "won",
      label: t("leads.stages.won"),
      value: counts.won,
      color: (CONTACT_STATUS_COLORS as Record<string, string>).won ?? "#22C55E",
      icon: "award",
      active: filters.status === "won",
    },
    {
      key: "lost",
      label: t("leads.stages.lost"),
      value: counts.lost,
      color: (CONTACT_STATUS_COLORS as Record<string, string>).lost ?? "#EF4444",
      icon: "x-circle",
      active: filters.status === "lost",
    },
  ];

  const unnamedLabel = t("common.unnamedContact");
  const onRowPress = React.useCallback(
    (id: number) => router.push(`/contact/${id}`),
    [router],
  );
  const renderItem = React.useCallback(
    ({ item }: { item: Contact }) => (
      <ContactRow
        item={item}
        colors={colors}
        isRTL={isRTL}
        textAlign={textAlign}
        t={t}
        unnamedLabel={unnamedLabel}
        onPress={onRowPress}
      />
    ),
    [colors, isRTL, textAlign, t, unnamedLabel, onRowPress],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 12, paddingHorizontal: 20 }}>
        <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={[styles.heading, { color: colors.foreground, textAlign }]}>
            {t("contacts.title")}
          </Text>
          {showExport && (
            <Pressable
              onPress={() => setExportOpen(true)}
              hitSlop={10}
              style={[styles.headerExportBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Feather name="share" size={18} color={colors.foreground} />
            </Pressable>
          )}
        </View>

        {/* Dashboard widgets — 2-row 4-column grid */}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, paddingVertical: 8 }}>
          {widgets.map((w) => (
            <Pressable
              key={w.key}
              onPress={() => toggleWidget(w.key)}
              hitSlop={4}
              style={[
                styles.widget,
                {
                  width: cardWidth,
                  backgroundColor: w.active ? w.color : colors.card,
                  borderColor: w.active ? w.color : colors.border,
                  borderRadius: colors.radius + 2,
                },
              ]}
            >
              <Feather
                name={w.icon}
                size={15}
                color={w.active ? "#FFFFFF" : w.color}
                style={{ marginBottom: 2 }}
              />
              <Text
                style={[
                  styles.widgetValue,
                  { color: w.active ? "#FFFFFF" : colors.foreground },
                ]}
              >
                {w.value}
              </Text>
              <Text
                style={[
                  styles.widgetLabel,
                  { color: w.active ? "#FFFFFF" : colors.mutedForeground },
                ]}
              >
                {w.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Search + filter */}
        <View style={{ flexDirection: isRTL ? "row-reverse" : "row", gap: 10 }}>
          <View
            style={[
              styles.searchRow,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                borderRadius: colors.radius,
                flexDirection: isRTL ? "row-reverse" : "row",
              },
            ]}
          >
            <Feather name="search" size={18} color={colors.mutedForeground} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder={t("contacts.searchPlaceholder")}
              placeholderTextColor={colors.mutedForeground}
              style={[styles.searchInput, { color: colors.foreground, textAlign }]}
              autoCapitalize="none"
            />
            {search ? (
              <Pressable onPress={() => setSearch("")} hitSlop={10}>
                <Feather name="x" size={18} color={colors.mutedForeground} />
              </Pressable>
            ) : null}
          </View>
          <Pressable
            onPress={() => {
              setSheetOpen(true);
            }}
            style={[
              styles.filterBtn,
              {
                backgroundColor: activeCount > 0 ? colors.primary : colors.card,
                borderColor: activeCount > 0 ? colors.primary : colors.border,
                borderRadius: colors.radius,
              },
            ]}
          >
            <Feather
              name="sliders"
              size={18}
              color={activeCount > 0 ? "#FFFFFF" : colors.foreground}
            />
            {activeCount > 0 ? (
              <View style={[styles.filterCount, { backgroundColor: "#FFFFFF" }]}>
                <Text style={[styles.filterCountText, { color: colors.primary }]}>
                  {activeCount}
                </Text>
              </View>
            ) : null}
          </Pressable>
        </View>
      </View>

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <FlatList
          data={contacts}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          removeClippedSubviews
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={11}
          contentContainerStyle={{
            padding: 20,
            paddingBottom: insets.bottom + 100,
            gap: 10,
            flexGrow: 1,
          }}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => {
                query.refetch();
                countsQuery.refetch();
              }}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={{ paddingTop: 60 }}>
              <EmptyState
                icon={debounced || activeCount > 0 ? "search" : "users"}
                title={
                  debounced || activeCount > 0
                    ? t("contacts.noResults")
                    : t("contacts.empty")
                }
                subtitle={
                  debounced || activeCount > 0
                    ? t("contacts.noResultsDesc")
                    : t("contacts.emptyDesc")
                }
              />
            </View>
          }
        />
      )}

      <FilterSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        filters={filters}
        onApply={(f) => {
          setContactFilters(f);
          setSheetOpen(false);
        }}
      />
      <ExportSheet
        visible={exportOpen}
        onClose={() => setExportOpen(false)}
        entityType="contact"
        filters={{
          search: debounced || undefined,
          status: filters.status ?? undefined,
          temperature: filters.temperature ?? undefined,
          eventId: filters.eventId ?? undefined,
          dateFrom: filters.dateFrom ?? undefined,
          dateTo: filters.dateTo ?? undefined,
          sort: filters.sort ?? undefined,
        }}
      />
    </View>
  );
}

function FilterSheet({
  open,
  onClose,
  filters,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  filters: ContactFilters;
  onApply: (f: ContactFilters) => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t, isRTL, textAlign } = useLocale();
  const [draft, setDraft] = useState<ContactFilters>(filters);
  const [saveName, setSaveName] = useState("");
  const eventsQuery = useListEvents(
    { limit: 100 },
    { query: { enabled: open, queryKey: getListEventsQueryKey({ limit: 100 }) } },
  );
  const savedQuery = useListSavedSearches(
    { entityType: SAVED_FILTER_ENTITY, kind: "filter" },
    {
      query: {
        enabled: open,
        queryKey: getListSavedSearchesQueryKey({ entityType: SAVED_FILTER_ENTITY, kind: "filter" }),
      },
    },
  );
  const createSaved = useCreateSavedSearch();
  const deleteSaved = useDeleteSavedSearch();

  useEffect(() => {
    if (open) {
      setDraft(filters);
      setSaveName("");
    }
  }, [open, filters]);

  const events = eventsQuery.data?.events ?? [];
  const savedFilters = savedQuery.data?.savedSearches ?? [];

  function applySaved(s: SavedSearch) {
    const payload = (s.payload ?? {}) as Partial<ContactFilters>;
    setDraft({ ...DEFAULT_CONTACT_FILTERS, ...payload });
  }

  function saveCurrent() {
    const name = saveName.trim();
    if (!name || createSaved.isPending) return;
    createSaved.mutate(
      {
        data: {
          name,
          kind: "filter",
          entityType: SAVED_FILTER_ENTITY,
          payload: draft,
        },
      },
      { onSuccess: () => setSaveName("") },
    );
  }

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
        <Text
          style={[styles.chipText, { color: active ? "#FFFFFF" : colors.foreground }]}
        >
          {label}
        </Text>
      </Pressable>
    );
  }

  return (
    <Modal visible={open} transparent animationType="slide" statusBarTranslucent hardwareAccelerated onRequestClose={onClose}>
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
            <Pressable onPress={() => setDraft(DEFAULT_CONTACT_FILTERS)} hitSlop={8}>
              <Text style={[styles.resetText, { color: colors.primary }]}>{t("common.clearAll")}</Text>
            </Pressable>
          </View>

          <ScrollView
            style={{ maxHeight: 460 }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 8 }}
          >
            {savedFilters.length > 0 ? (
              <>
                <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>
                  {t("contacts.savedFilters")}
                </Text>
                <View style={[styles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                  {savedFilters.map((s) => (
                    <View
                      key={`sf-${s.id}`}
                      style={[
                        styles.savedChip,
                        { backgroundColor: colors.card, borderColor: colors.border, flexDirection: isRTL ? "row-reverse" : "row" },
                      ]}
                    >
                      <Pressable onPress={() => applySaved(s)} hitSlop={6}>
                        <Text style={[styles.chipText, { color: colors.foreground }]}>{s.name}</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => deleteSaved.mutate({ id: s.id })}
                        hitSlop={8}
                        disabled={deleteSaved.isPending}
                      >
                        <Feather name="x" size={13} color={colors.mutedForeground} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              </>
            ) : null}

            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>{t("contacts.sortLabel")}</Text>
            <View style={[styles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {SORT_OPTIONS.map((s) =>
                chip(draft.sort === s.key, t(s.labelKey), () => setDraft({ ...draft, sort: s.key }), s.key),
              )}
            </View>

            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>{t("contacts.statusLabel")}</Text>
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

            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>
              {t("leads.temperature").toUpperCase()}
            </Text>
            <View style={[styles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {chip(!draft.temperature, t("common.all"), () => setDraft({ ...draft, temperature: null }), "tp-any")}
              {TEMPERATURES.map((temp) =>
                chip(
                  draft.temperature === temp,
                  t(`leads.${temp}`, { defaultValue: prettyLabel(temp) }),
                  () => setDraft({ ...draft, temperature: temp }),
                  temp,
                ),
              )}
            </View>

            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>
              {t("contacts.fields.event").toUpperCase()}
            </Text>
            <View style={[styles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {chip(!draft.eventId, t("common.all"), () => setDraft({ ...draft, eventId: null }), "ev-any")}
              {events.map((e) =>
                chip(draft.eventId === e.id, e.name, () => setDraft({ ...draft, eventId: e.id }), `ev-${e.id}`),
              )}
            </View>

            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>{t("contacts.activityLabel")}</Text>
            <View style={[styles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {chip(
                draft.hasFollowUp,
                t("contacts.addFollowUp"),
                () => setDraft({ ...draft, hasFollowUp: !draft.hasFollowUp }),
                "hf",
              )}
              {chip(
                draft.hasMeeting,
                t("contacts.addMeeting"),
                () => setDraft({ ...draft, hasMeeting: !draft.hasMeeting }),
                "hm",
              )}
            </View>

            <Text style={[styles.fLabel, { color: colors.mutedForeground, textAlign }]}>
              {t("contacts.capturedDate")}
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

          <View style={[styles.saveRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
            <TextInput
              style={[
                styles.saveInput,
                { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, textAlign },
              ]}
              placeholder={t("contacts.savedFilterNamePlaceholder")}
              placeholderTextColor={colors.mutedForeground}
              value={saveName}
              onChangeText={setSaveName}
            />
            <Pressable
              onPress={saveCurrent}
              disabled={!saveName.trim() || createSaved.isPending}
              style={[
                styles.saveBtn,
                { borderColor: colors.primary, opacity: !saveName.trim() || createSaved.isPending ? 0.5 : 1 },
              ]}
            >
              <Text style={[styles.saveBtnText, { color: colors.primary }]}>{t("common.save")}</Text>
            </Pressable>
          </View>

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
  heading: {
    fontSize: 30,
    fontFamily: FONT.bold,
  },
  headerExportBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  widget: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderWidth: 1,
    alignItems: "flex-start",
  },
  widgetValue: {
    fontSize: 17,
    fontFamily: FONT.bold,
  },
  widgetLabel: {
    fontSize: 10.5,
    fontFamily: FONT.medium,
    marginTop: 1,
  },
  searchRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    height: 46,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: FONT.regular,
    height: "100%",
  },
  filterBtn: {
    width: 46,
    height: 46,
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 14,
    borderWidth: 1,
  },
  name: {
    fontSize: 16,
    fontFamily: FONT.semibold,
  },
  sub: {
    fontSize: 13.5,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  badgeRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 6,
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
  savedChip: {
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  saveRow: {
    alignItems: "center",
    gap: 8,
    marginTop: 14,
  },
  saveInput: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 14,
    fontFamily: FONT.regular,
  },
  saveBtn: {
    height: 44,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  saveBtnText: { fontSize: 14, fontFamily: FONT.semibold },
  applyBtn: {
    marginTop: 14,
    height: 52,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  applyText: { color: "#FFFFFF", fontSize: 16, fontFamily: FONT.semibold },
});
