import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
   Alert,
   FlatList,
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
import { useQueryClient } from "@tanstack/react-query";

import {
  type Lead,
  BulkAssignInputStrategy,
  getGetLeadPipelineQueryKey,
  useGetLeadPipeline,
  useBulkAssignLeads,
  useListTeams,
  useListUsers,
} from "@workspace/api-client-react";

import {
  Avatar,
  EmptyState,
  ErrorState,
  FONT,
  LEAD_STAGE_COLORS,
  LEAD_STAGE_ORDER,
  LoadingState,
  prettyLabel,
} from "@/components/ui";
import { ExportSheet } from "@/components/ExportSheet";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { useAuth } from "@/contexts/AuthContext";
import { useSettings } from "@/contexts/SettingsContext";
import { canExport } from "@/lib/export-permissions";
import { getCountry } from "@/lib/countries";
import { convertCurrency, formatCurrency } from "@/lib/currency";

const ALL_STAGE = "all";

const BULK_STRATEGIES: BulkAssignInputStrategy[] = [
  BulkAssignInputStrategy.round_robin,
  BulkAssignInputStrategy.load_balanced,
  BulkAssignInputStrategy.availability,
  BulkAssignInputStrategy.territory,
  BulkAssignInputStrategy.ai,
  BulkAssignInputStrategy.manual,
];

type ColorTokens = ReturnType<typeof useColors>;
type TFn = (key: string, options?: Record<string, unknown>) => string;

// Memoized pipeline row — re-renders only when its lead (or theme) changes.
const LeadRow = React.memo(function LeadRow({
  item,
  colors,
  isRTL,
  textAlign,
  t,
  currencyCode,
  onPress,
  onLongPress,
  selectionMode,
  selected,
}: {
  item: Lead;
  colors: ColorTokens;
  isRTL: boolean;
  textAlign: "left" | "right";
  t: TFn;
  currencyCode: string;
  onPress: (id: number) => void;
  onLongPress: (id: number) => void;
  selectionMode: boolean;
  selected: boolean;
}) {
  const color = LEAD_STAGE_COLORS[item.stage] ?? colors.primary;
  return (
    <Pressable
      onPress={() => onPress(item.id)}
      onLongPress={() => onLongPress(item.id)}
      delayLongPress={250}
      style={({ pressed }) => [
        styles.leadCard,
        {
          backgroundColor: selected ? colors.primary + "14" : colors.card,
          borderColor: selected ? colors.primary : colors.border,
          borderRadius: colors.radius + 4,
          flexDirection: isRTL ? "row-reverse" : "row",
          opacity: pressed ? 0.75 : 1,
        },
      ]}
    >
      {selectionMode ? (
        <View
          style={[
            styles.checkbox,
            {
              borderColor: selected ? colors.primary : colors.border,
              backgroundColor: selected ? colors.primary : "transparent",
            },
          ]}
        >
          {selected ? <Feather name="check" size={14} color="#FFFFFF" /> : null}
        </View>
      ) : (
        <Avatar name={item.contactName ?? "?"} color={color} size={40} />
      )}
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={[styles.leadName, { color: colors.foreground, textAlign }]}>
          {item.contactName ?? t("common.unnamedLead")}
        </Text>
        <Text numberOfLines={1} style={[styles.leadSub, { color: colors.mutedForeground, textAlign }]}>
          {item.contactCompany ?? item.contactEmail ?? t("common.noCompany")}
        </Text>
      </View>
      {item.value != null && Number(item.value) > 0 ? (
        <Text style={[styles.leadValue, { color: colors.success }]}>
          {formatCurrency(Number(item.value), item.currency ?? currencyCode)}
        </Text>
      ) : null}
      {!selectionMode ? <Feather name="chevron-right" size={16} color={colors.mutedForeground} /> : null}
    </Pressable>
  );
});

export default function LeadsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL, textAlign } = useLocale();
  const { country } = useSettings();
  const currencyCode = getCountry(country).currencyCode;
  const params = useLocalSearchParams<{ stage?: string }>();

  // If a stage was passed from the dashboard, use it as the initial filter.
  // "all" is a virtual stage that shows every opportunity sorted by value.
  // Guard against unknown deep-link values (fall back to "all") so an invalid
  // ?stage= param never lands the user on a confusing empty state.
  const isValidStage =
    params.stage != null &&
    (params.stage === ALL_STAGE || (LEAD_STAGE_ORDER as readonly string[]).includes(params.stage));
  const initialStage = isValidStage ? (params.stage as string) : ALL_STAGE;
  const [activeStage, setActiveStage] = useState<string>(initialStage);
  // Track whether the active filter came from the dashboard so we can show
  // the filter banner. Cleared when the user manually selects a chip.
  const [fromDashboard, setFromDashboard] = useState<boolean>(isValidStage);
  const [exportOpen, setExportOpen] = useState(false);
  const { user } = useAuth();
  const showExport = canExport(user);

  const queryClient = useQueryClient();
  const query = useGetLeadPipeline();

  // Bulk assignment
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [assignModalVisible, setAssignModalVisible] = useState(false);
  const [bulkStrategy, setBulkStrategy] = useState<BulkAssignInputStrategy>(BulkAssignInputStrategy.round_robin);
  const [bulkOwnerId, setBulkOwnerId] = useState<number | null>(null);
  const [bulkTeamId, setBulkTeamId] = useState<number | null>(null);
  const bulkAssign = useBulkAssignLeads();
  const bulkUsersQuery = useListUsers({ limit: 200 }, { query: { enabled: assignModalVisible, queryKey: ["/api/users", "bulk-assign"] } });
  const bulkTeamsQuery = useListTeams(undefined, { query: { enabled: assignModalVisible, queryKey: ["/api/teams", "bulk-assign"] } });
  const bulkUsers = bulkUsersQuery.data?.users ?? [];
  const bulkTeams = bulkTeamsQuery.data?.teams ?? [];
  const bulkTeamRequired =
    bulkStrategy === "load_balanced" || bulkStrategy === "availability" || bulkStrategy === "round_robin";

  const exitSelection = React.useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const enterSelection = React.useCallback((id: number) => {
    if (Platform.OS !== "web") Haptics.selectionAsync();
    setSelectionMode(true);
    setSelectedIds(new Set([id]));
  }, []);

  const toggleSelect = React.useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function submitBulkAssign() {
    const leadIds = Array.from(selectedIds);
    if (leadIds.length === 0) return;
    if (bulkStrategy === "manual" && bulkOwnerId == null) {
      Alert.alert(t("leads.bulkAssign.pickOwner"));
      return;
    }
    if (bulkTeamRequired && bulkTeamId == null) {
      Alert.alert(t("leads.bulkAssign.pickTeam"));
      return;
    }
    bulkAssign.mutate(
      {
        data: {
          leadIds,
          strategy: bulkStrategy,
          assignedToId: bulkStrategy === "manual" ? bulkOwnerId : undefined,
          // Manual with no team chosen must NOT send teamId — the server treats
          // an explicit teamId (incl. null) as a set, silently clearing each
          // lead's existing team binding. Omit it instead.
          teamId: bulkTeamId != null ? bulkTeamId : bulkStrategy === "manual" ? undefined : null,
        },
      },
      {
        onSuccess: (res) => {
          if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          queryClient.invalidateQueries({ queryKey: getGetLeadPipelineQueryKey() });
          setAssignModalVisible(false);
          exitSelection();
          Alert.alert(t("leads.bulkAssign.done", { assigned: res.assigned, failed: res.failed }));
        },
        onError: (e: any) => Alert.alert(t("leads.bulkAssign.failed"), e?.message || undefined),
      }
    );
  }

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  const { stages, convertedTotalValue } = useMemo(() => {
    const map = new Map<string, { count: number; value: number; leads: Lead[] }>();
    for (const s of query.data?.stages ?? []) {
      map.set(s.stage, { count: s.count, value: s.value, leads: s.leads });
    }
    const stagesArr = LEAD_STAGE_ORDER.map((stage) => ({
      stage,
      count: map.get(stage)?.count ?? 0,
      value: map.get(stage)?.value ?? 0,
      leads: map.get(stage)?.leads ?? [],
    }));
    const converted = (query.data?.stages ?? [])
      .flatMap((s) => s.leads)
      .filter((l) => l.stage !== "won" && l.stage !== "lost")
      .reduce(
        (sum, l) => sum + convertCurrency(Number(l.value ?? 0), l.currency ?? "USD", currencyCode),
        0,
      );
    return { stages: stagesArr, convertedTotalValue: converted };
  }, [query.data, currencyCode]);

  // "All" shows every lead across every stage, sorted by value descending.
  const allLeads = useMemo(
    () =>
      stages
        .flatMap((s) => s.leads)
        .sort((a, b) => (Number(b.value ?? 0)) - (Number(a.value ?? 0))),
    [stages],
  );
  const totalCount = stages.reduce((sum, s) => sum + s.count, 0);

  const currentLeads =
    activeStage === ALL_STAGE
      ? allLeads
      : (stages.find((s) => s.stage === activeStage)?.leads ?? []);

  const currentCount =
    activeStage === ALL_STAGE
      ? totalCount
      : (stages.find((s) => s.stage === activeStage)?.count ?? 0);

  function selectStage(stage: string) {
    setActiveStage(stage);
    setFromDashboard(false); // user manually chose — clear dashboard origin
  }

  function clearFilter() {
    setActiveStage(ALL_STAGE);
    setFromDashboard(false);
  }

  // Stage chip data: "All" first, then the regular LEAD_STAGE_ORDER stages.
  const stageChips = useMemo(() => {
    const allChip = { stage: ALL_STAGE, count: totalCount, value: convertedTotalValue };
    return [allChip, ...stages];
  }, [stages, totalCount, convertedTotalValue]);

  const onLeadPress = React.useCallback(
    (id: number) => {
      if (selectionMode) {
        toggleSelect(id);
        return;
      }
      if (Platform.OS !== "web") Haptics.selectionAsync();
      router.push(`/pipeline/${id}`);
    },
    [router, selectionMode, toggleSelect],
  );
  const renderLead = React.useCallback(
    ({ item }: { item: Lead }) => (
      <LeadRow
        item={item}
        colors={colors}
        isRTL={isRTL}
        textAlign={textAlign}
        t={t}
        currencyCode={currencyCode}
        onPress={onLeadPress}
        onLongPress={enterSelection}
        selectionMode={selectionMode}
        selected={selectedIds.has(item.id)}
      />
    ),
    [colors, isRTL, textAlign, t, currencyCode, onLeadPress, enterSelection, selectionMode, selectedIds],
  );

  const activeColor =
    activeStage === ALL_STAGE ? colors.primary : (LEAD_STAGE_COLORS[activeStage] ?? colors.primary);

  const activeStageName = t(`leads.stages.${activeStage}`, { defaultValue: prettyLabel(activeStage) });

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 12, paddingHorizontal: 20 }}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Feather name="chevron-left" size={20} color={colors.foreground} />
        </Pressable>
        {showExport && (
          <Pressable
            onPress={() => setExportOpen(true)}
            hitSlop={10}
            style={[styles.exportBtn, { backgroundColor: colors.card, borderColor: colors.border, top: topPad + 12, right: isRTL ? undefined : 20, left: isRTL ? 20 : undefined }]}
          >
            <Feather name="share" size={18} color={colors.foreground} />
          </Pressable>
        )}
        <Text style={[styles.heading, { color: colors.foreground, textAlign }]}>{t("leads.title")}</Text>
        <Text style={[styles.headingSub, { color: colors.mutedForeground, textAlign }]}>
          {formatCurrency(convertedTotalValue, currencyCode)} {t("leads.openValueSuffix")}
        </Text>

        {/* Active filter banner — shown when user arrived from a dashboard KPI */}
        {fromDashboard && (
          <View
            style={[
              styles.filterBanner,
              { backgroundColor: activeColor + "18", borderColor: activeColor + "55", flexDirection: isRTL ? "row-reverse" : "row" },
            ]}
          >
            <Feather name="filter" size={13} color={activeColor} />
            <Text style={[styles.filterBannerText, { color: activeColor }]}>
              {t("leads.filterActive")}: {activeStageName}
            </Text>
            <Pressable onPress={clearFilter} hitSlop={8} style={{ marginLeft: "auto" }}>
              <Text style={[styles.filterClearText, { color: activeColor }]}>
                {t("leads.clearFilter")}
              </Text>
            </Pressable>
          </View>
        )}
      </View>

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <>
          <View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={[styles.stageBar, { flexDirection: isRTL ? "row-reverse" : "row" }]}
            >
              {stageChips.map((s) => {
                const active = s.stage === activeStage;
                const color = s.stage === ALL_STAGE ? colors.primary : (LEAD_STAGE_COLORS[s.stage] ?? colors.primary);
                return (
                  <Pressable
                    key={s.stage}
                    onPress={() => selectStage(s.stage)}
                    style={[
                      styles.stageChip,
                      {
                        backgroundColor: active ? color : colors.card,
                        borderColor: active ? color : colors.border,
                        borderRadius: colors.radius + 2,
                        flexDirection: isRTL ? "row-reverse" : "row",
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.stageChipText,
                        { color: active ? "#FFFFFF" : colors.foreground },
                      ]}
                    >
                      {t(`leads.stages.${s.stage}`, { defaultValue: prettyLabel(s.stage) })}
                    </Text>
                    <View
                      style={[
                        styles.stageCount,
                        {
                          backgroundColor: active
                            ? "rgba(255,255,255,0.25)"
                            : colors.muted,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.stageCountText,
                          { color: active ? "#FFFFFF" : colors.mutedForeground },
                        ]}
                      >
                        {s.count}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>

          <FlatList
            data={currentLeads}
            keyExtractor={(item) => String(item.id)}
            renderItem={renderLead}
            removeClippedSubviews
            initialNumToRender={10}
            maxToRenderPerBatch={10}
            windowSize={11}
            contentContainerStyle={{
              padding: 20,
              paddingBottom: insets.bottom + 120,
              gap: 10,
              flexGrow: 1,
            }}
            refreshControl={
              <RefreshControl
                refreshing={query.isRefetching}
                onRefresh={() => query.refetch()}
                tintColor={colors.primary}
              />
            }
            ListEmptyComponent={
              <View style={{ paddingTop: 40 }}>
                <EmptyState
                  icon="inbox"
                  title={t("leads.empty")}
                  subtitle={t("leads.emptyDesc")}
                />
              </View>
            }
          />

          {selectionMode ? (
            /* Bulk action bar */
            <View
              style={[
                styles.bulkBar,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  paddingBottom: insets.bottom + 12,
                  flexDirection: isRTL ? "row-reverse" : "row",
                },
              ]}
            >
              <Pressable onPress={exitSelection} hitSlop={8} style={styles.bulkCancel}>
                <Feather name="x" size={20} color={colors.foreground} />
              </Pressable>
              <Text style={[styles.bulkCount, { color: colors.foreground, flex: 1, textAlign }]}>
                {t("leads.bulkAssign.selectedCount", { count: selectedIds.size })}
              </Text>
              <Pressable
                onPress={() => {
                  if (selectedIds.size === 0) return;
                  setBulkOwnerId(null);
                  setBulkTeamId(null);
                  setAssignModalVisible(true);
                }}
                disabled={selectedIds.size === 0}
                style={({ pressed }) => [
                  styles.bulkAssignBtn,
                  { backgroundColor: colors.primary, borderRadius: colors.radius + 2, opacity: selectedIds.size === 0 ? 0.4 : pressed ? 0.85 : 1 },
                ]}
              >
                <Feather name="user-check" size={16} color="#FFFFFF" />
                <Text style={styles.bulkAssignText}>{t("leads.bulkAssign.assign")}</Text>
              </Pressable>
            </View>
          ) : (
            /* FAB */
            <Pressable
              onPress={() => {
                if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                router.push("/pipeline/form");
              }}
              style={({ pressed }) => [
                styles.fab,
                { backgroundColor: colors.primary, bottom: insets.bottom + 24, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Feather name="plus" size={26} color="#FFFFFF" />
            </Pressable>
          )}
        </>
      )}

      {/* Bulk-assign modal */}
      <Modal visible={assignModalVisible} animationType="slide" transparent onRequestClose={() => setAssignModalVisible(false)}>
        <Pressable style={modalStyles.backdrop} onPress={() => setAssignModalVisible(false)} />
        <View style={[modalStyles.sheet, { backgroundColor: colors.card, paddingBottom: insets.bottom + 20, maxHeight: "85%" }]}>
          <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <Text style={[modalStyles.title, { color: colors.foreground }]}>
              {t("leads.bulkAssign.title", { count: selectedIds.size })}
            </Text>
            <Pressable onPress={() => setAssignModalVisible(false)} hitSlop={10}>
              <Feather name="x" size={22} color={colors.foreground} />
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }}>
            <Text style={[modalStyles.label, { color: colors.mutedForeground, textAlign }]}>{t("leads.bulkAssign.strategy").toUpperCase()}</Text>
            <View style={[modalStyles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {BULK_STRATEGIES.map((st) => {
                const active = bulkStrategy === st;
                return (
                  <Pressable
                    key={st}
                    onPress={() => setBulkStrategy(st)}
                    style={[
                      modalStyles.chip,
                      { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primary + "1A" : colors.background },
                    ]}
                  >
                    <Text style={[modalStyles.chipText, { color: active ? colors.primary : colors.mutedForeground }]}>
                      {t(`leads.bulkAssign.strategies.${st}`)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {bulkStrategy === "manual" ? (
              <>
                <Text style={[modalStyles.label, { color: colors.mutedForeground, textAlign, marginTop: 14 }]}>{t("leads.bulkAssign.owner").toUpperCase()}</Text>
                <View style={[modalStyles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                  {bulkUsers.map((u) => {
                    const active = bulkOwnerId === u.id;
                    return (
                      <Pressable
                        key={u.id}
                        onPress={() => setBulkOwnerId(u.id)}
                        style={[
                          modalStyles.chip,
                          { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primary + "1A" : colors.background },
                        ]}
                      >
                        <Text style={[modalStyles.chipText, { color: active ? colors.primary : colors.mutedForeground }]}>{u.name}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : null}

            {bulkStrategy !== "manual" && bulkStrategy !== "ai" ? (
              <>
                <Text style={[modalStyles.label, { color: colors.mutedForeground, textAlign, marginTop: 14 }]}>
                  {t("leads.bulkAssign.team")}
                  {bulkTeamRequired ? " *" : ""}
                </Text>
                <View style={[modalStyles.chipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                  {bulkTeams.map((tm) => {
                    const active = bulkTeamId === tm.id;
                    return (
                      <Pressable
                        key={tm.id}
                        onPress={() => setBulkTeamId(tm.id)}
                        style={[
                          modalStyles.chip,
                          { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primary + "1A" : colors.background },
                        ]}
                      >
                        <Text style={[modalStyles.chipText, { color: active ? colors.primary : colors.mutedForeground }]}>{tm.name}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : null}

            <Pressable
              onPress={submitBulkAssign}
              disabled={bulkAssign.isPending}
              style={({ pressed }) => [
                modalStyles.submit,
                { backgroundColor: colors.primary, borderRadius: colors.radius + 4, opacity: bulkAssign.isPending ? 0.5 : pressed ? 0.85 : 1 },
              ]}
            >
              <Feather name="user-check" size={18} color="#FFFFFF" />
              <Text style={modalStyles.submitText}>{t("leads.bulkAssign.assign")}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>

      <ExportSheet
        visible={exportOpen}
        onClose={() => setExportOpen(false)}
        entityType="lead"
        filters={{ stage: activeStage === ALL_STAGE ? undefined : activeStage }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  exportBtn: {
    position: "absolute",
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  heading: {
    fontSize: 30,
    fontFamily: FONT.bold,
  },
  headingSub: {
    fontSize: 14,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  filterBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderRadius: 8,
  },
  filterBannerText: {
    fontSize: 13,
    fontFamily: FONT.semibold,
  },
  filterClearText: {
    fontSize: 13,
    fontFamily: FONT.medium,
    textDecorationLine: "underline",
  },
  stageBar: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 9,
  },
  stageChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 14,
    paddingRight: 8,
    paddingVertical: 9,
    borderWidth: 1,
  },
  stageChipText: {
    fontSize: 14,
    fontFamily: FONT.semibold,
  },
  stageCount: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  stageCountText: {
    fontSize: 12,
    fontFamily: FONT.bold,
  },
  leadCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderWidth: 1,
  },
  leadName: {
    fontSize: 15.5,
    fontFamily: FONT.semibold,
  },
  leadSub: {
    fontSize: 13,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  leadValue: {
    fontSize: 15,
    fontFamily: FONT.bold,
  },
  fab: {
    position: "absolute",
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 8,
    elevation: 8,
  },
  checkbox: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  bulkBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  bulkCancel: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  bulkCount: {
    fontSize: 15,
    fontFamily: FONT.semibold,
  },
  bulkAssignBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  bulkAssignText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontFamily: FONT.semibold,
  },
});

const modalStyles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 18,
  },
  title: {
    fontSize: 18,
    fontFamily: FONT.bold,
  },
  label: {
    fontSize: 11,
    fontFamily: FONT.semibold,
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  chipWrap: {
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 13,
    fontFamily: FONT.medium,
  },
  submit: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 52,
    marginTop: 20,
  },
  submitText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontFamily: FONT.semibold,
  },
});
