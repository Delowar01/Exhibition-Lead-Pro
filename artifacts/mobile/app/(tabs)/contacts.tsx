import { Feather } from "@expo/vector-icons";
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
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type Contact,
  getListContactsQueryKey,
  getListEventsQueryKey,
  type ListContactsParams,
  useListContacts,
  useListEvents,
} from "@workspace/api-client-react";

import { DateTimeField } from "@/components/DateTimeField";
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
import {
  DEFAULT_CONTACT_FILTERS,
  type ContactFilters,
  type ContactSortPref,
  useSettings,
} from "@/contexts/SettingsContext";
import { useColors } from "@/hooks/useColors";

function contactName(c: Contact): string {
  if (c.fullName) return c.fullName;
  const parts = [c.firstName, c.lastName].filter(Boolean);
  return parts.length ? parts.join(" ") : "Unnamed contact";
}

const SORT_OPTIONS: { key: ContactSortPref; label: string }[] = [
  { key: "newest", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
  { key: "name", label: "Name (A–Z)" },
];

const TEMPERATURES = ["hot", "warm", "cold"];

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
  const { contactFilters, setContactFilters, isLoaded } = useSettings();

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);

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

  const counts = useMemo(() => {
    const all = countsQuery.data?.contacts ?? [];
    return {
      total: all.length,
      new: all.filter((c) => c.status === "new").length,
      contacted: all.filter((c) => c.status === "contacted").length,
      hot: all.filter((c) => c.leadTemperature === "hot").length,
    };
  }, [countsQuery.data]);

  const activeCount = countActiveFilters(filters);

  function patchFilters(patch: Partial<ContactFilters>) {
    setContactFilters({ ...filters, ...patch });
  }

  function toggleWidget(kind: "total" | "new" | "contacted" | "hot") {
    if (Platform.OS !== "web") Haptics.selectionAsync();
    if (kind === "total") {
      patchFilters({ status: null, temperature: null });
    } else if (kind === "hot") {
      patchFilters({
        temperature: filters.temperature === "hot" ? null : "hot",
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
    key: "total" | "new" | "contacted" | "hot";
    label: string;
    value: number;
    color: string;
    active: boolean;
  }[] = [
    {
      key: "total",
      label: "Total",
      value: counts.total,
      color: colors.primary,
      active: !filters.status && !filters.temperature,
    },
    {
      key: "new",
      label: "New",
      value: counts.new,
      color: CONTACT_STATUS_COLORS.new,
      active: filters.status === "new",
    },
    {
      key: "contacted",
      label: "Contacted",
      value: counts.contacted,
      color: CONTACT_STATUS_COLORS.contacted,
      active: filters.status === "contacted",
    },
    {
      key: "hot",
      label: "Hot",
      value: counts.hot,
      color: LEAD_TEMPERATURE_COLORS.hot,
      active: filters.temperature === "hot",
    },
  ];

  function renderItem({ item }: { item: Contact }) {
    const statusColor = CONTACT_STATUS_COLORS[item.status] ?? colors.mutedForeground;
    return (
      <Pressable
        onPress={() => router.push(`/contact/${item.id}`)}
        style={({ pressed }) => [
          styles.row,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            borderRadius: colors.radius + 4,
            opacity: pressed ? 0.7 : 1,
          },
        ]}
      >
        <Avatar name={contactName(item)} color={statusColor} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={[styles.name, { color: colors.foreground }]}>
            {contactName(item)}
          </Text>
          <Text numberOfLines={1} style={[styles.sub, { color: colors.mutedForeground }]}>
            {[item.jobTitle, item.contactCompany].filter(Boolean).join(" · ") ||
              item.email ||
              "No details"}
          </Text>
          <View style={styles.badgeRow}>
            <Badge label={prettyLabel(item.status)} color={statusColor} />
            {item.leadTemperature ? (
              <Badge
                label={
                  typeof item.leadScore === "number"
                    ? `${prettyLabel(item.leadTemperature)} · ${item.leadScore}`
                    : prettyLabel(item.leadTemperature)
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
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 12, paddingHorizontal: 20 }}>
        <Text style={[styles.heading, { color: colors.foreground }]}>Contacts</Text>

        {/* Dashboard widgets */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 10, paddingVertical: 12 }}
        >
          {widgets.map((w) => (
            <Pressable
              key={w.key}
              onPress={() => toggleWidget(w.key)}
              style={[
                styles.widget,
                {
                  backgroundColor: w.active ? w.color : colors.card,
                  borderColor: w.active ? w.color : colors.border,
                  borderRadius: colors.radius + 2,
                },
              ]}
            >
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
        </ScrollView>

        {/* Search + filter */}
        <View style={{ flexDirection: "row", gap: 10 }}>
          <View
            style={[
              styles.searchRow,
              { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
            ]}
          >
            <Feather name="search" size={18} color={colors.mutedForeground} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search name, company, email"
              placeholderTextColor={colors.mutedForeground}
              style={[styles.searchInput, { color: colors.foreground }]}
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
              if (Platform.OS !== "web") Haptics.selectionAsync();
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
          contentContainerStyle={{
            padding: 20,
            paddingBottom: insets.bottom + 100,
            gap: 10,
          }}
          scrollEnabled={contacts.length > 0}
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
                title={debounced || activeCount > 0 ? "No matches" : "No contacts yet"}
                subtitle={
                  debounced || activeCount > 0
                    ? "Try adjusting your search or filters."
                    : "Scan a business card to add your first contact."
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
  const [draft, setDraft] = useState<ContactFilters>(filters);
  const eventsQuery = useListEvents(
    { limit: 100 },
    { query: { enabled: open, queryKey: getListEventsQueryKey({ limit: 100 }) } },
  );

  useEffect(() => {
    if (open) setDraft(filters);
  }, [open, filters]);

  const events = eventsQuery.data?.events ?? [];

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
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[
            styles.sheet,
            {
              backgroundColor: colors.background,
              borderColor: colors.border,
              paddingBottom: insets.bottom + 16,
            },
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
          </View>
          <View style={styles.sheetHeader}>
            <Text style={[styles.sheetTitle, { color: colors.foreground }]}>
              Filters & Sort
            </Text>
            <Pressable onPress={() => setDraft(DEFAULT_CONTACT_FILTERS)} hitSlop={8}>
              <Text style={[styles.resetText, { color: colors.primary }]}>Reset</Text>
            </Pressable>
          </View>

          <ScrollView
            style={{ maxHeight: 460 }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 8 }}
          >
            <Text style={[styles.fLabel, { color: colors.mutedForeground }]}>SORT</Text>
            <View style={styles.chipWrap}>
              {SORT_OPTIONS.map((s) =>
                chip(draft.sort === s.key, s.label, () => setDraft({ ...draft, sort: s.key }), s.key),
              )}
            </View>

            <Text style={[styles.fLabel, { color: colors.mutedForeground }]}>STATUS</Text>
            <View style={styles.chipWrap}>
              {chip(!draft.status, "Any", () => setDraft({ ...draft, status: null }), "st-any")}
              {CONTACT_PIPELINE_ORDER.map((s) =>
                chip(draft.status === s, prettyLabel(s), () => setDraft({ ...draft, status: s }), s),
              )}
            </View>

            <Text style={[styles.fLabel, { color: colors.mutedForeground }]}>TEMPERATURE</Text>
            <View style={styles.chipWrap}>
              {chip(!draft.temperature, "Any", () => setDraft({ ...draft, temperature: null }), "tp-any")}
              {TEMPERATURES.map((t) =>
                chip(draft.temperature === t, prettyLabel(t), () => setDraft({ ...draft, temperature: t }), t),
              )}
            </View>

            <Text style={[styles.fLabel, { color: colors.mutedForeground }]}>EVENT</Text>
            <View style={styles.chipWrap}>
              {chip(!draft.eventId, "Any", () => setDraft({ ...draft, eventId: null }), "ev-any")}
              {events.map((e) =>
                chip(draft.eventId === e.id, e.name, () => setDraft({ ...draft, eventId: e.id }), `ev-${e.id}`),
              )}
            </View>

            <Text style={[styles.fLabel, { color: colors.mutedForeground }]}>ACTIVITY</Text>
            <View style={styles.chipWrap}>
              {chip(
                draft.hasFollowUp,
                "Has follow-up",
                () => setDraft({ ...draft, hasFollowUp: !draft.hasFollowUp }),
                "hf",
              )}
              {chip(
                draft.hasMeeting,
                "Has meeting",
                () => setDraft({ ...draft, hasMeeting: !draft.hasMeeting }),
                "hm",
              )}
            </View>

            <Text style={[styles.fLabel, { color: colors.mutedForeground }]}>
              CAPTURED DATE
            </Text>
            <DateTimeField
              label="From"
              date={draft.dateFrom}
              time={null}
              withTime={false}
              optional
              onChange={(d) => setDraft({ ...draft, dateFrom: d })}
            />
            <DateTimeField
              label="To"
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
            <Text style={styles.applyText}>Apply filters</Text>
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
  widget: {
    minWidth: 92,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    alignItems: "flex-start",
  },
  widgetValue: {
    fontSize: 22,
    fontFamily: FONT.bold,
  },
  widgetLabel: {
    fontSize: 12.5,
    fontFamily: FONT.medium,
    marginTop: 2,
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
  applyBtn: {
    marginTop: 14,
    height: 52,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  applyText: { color: "#FFFFFF", fontSize: 16, fontFamily: FONT.semibold },
});
