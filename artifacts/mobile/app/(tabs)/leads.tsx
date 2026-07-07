import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";

import {
  type Lead,
  type LeadUpdateStage,
  type PipelineView,
  BulkAssignInputStrategy,
  getGetLeadPipelineQueryKey,
  useGetLeadPipeline,
  useBulkAssignLeads,
  useListTeams,
  useListUsers,
  useUpdateLead,
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

type ColumnBounds = { stage: string; x: number; width: number };

// A single draggable lead card inside a Kanban column. Long-press lifts the card
// into a floating overlay (managed by the parent) that follows the finger; on
// release the parent hit-tests the finger X against the captured column bounds
// and, if it lands on a different column, persists the stage change optimistically.
const KanbanCard = React.memo(function KanbanCard({
  item,
  colors,
  isRTL,
  textAlign,
  t,
  currencyCode,
  selectionMode,
  selected,
  hidden,
  dragEnabled,
  onPress,
  onLongPressSelect,
  onDragBegin,
  onDragStart,
  onDragUpdate,
  onDragEnd,
  onDragFinalize,
}: {
  item: Lead;
  colors: ColorTokens;
  isRTL: boolean;
  textAlign: "left" | "right";
  t: TFn;
  currencyCode: string;
  selectionMode: boolean;
  selected: boolean;
  hidden: boolean;
  dragEnabled: boolean;
  onPress: (id: number) => void;
  onLongPressSelect: (id: number) => void;
  onDragBegin: () => void;
  onDragStart: (item: Lead, x: number, y: number) => void;
  onDragUpdate: (x: number, y: number) => void;
  onDragEnd: (item: Lead, x: number) => void;
  onDragFinalize: () => void;
}) {
  const color = LEAD_STAGE_COLORS[item.stage] ?? colors.primary;

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(dragEnabled)
        .activateAfterLongPress(260)
        .onBegin(() => {
          runOnJS(onDragBegin)();
        })
        .onStart((e) => {
          runOnJS(onDragStart)(item, e.absoluteX, e.absoluteY);
        })
        .onUpdate((e) => {
          runOnJS(onDragUpdate)(e.absoluteX, e.absoluteY);
        })
        .onEnd((e) => {
          runOnJS(onDragEnd)(item, e.absoluteX);
        })
        .onFinalize(() => {
          runOnJS(onDragFinalize)();
        }),
    [dragEnabled, item, onDragBegin, onDragStart, onDragUpdate, onDragEnd, onDragFinalize],
  );

  return (
    <GestureDetector gesture={pan}>
      <Pressable
        onPress={() => onPress(item.id)}
        onLongPress={() => {
          if (selectionMode) onLongPressSelect(item.id);
        }}
        delayLongPress={250}
        style={({ pressed }) => [
          styles.card,
          {
            backgroundColor: selected ? colors.primary + "14" : colors.card,
            borderColor: selected ? colors.primary : colors.border,
            borderRadius: colors.radius + 4,
            opacity: hidden ? 0 : pressed ? 0.85 : 1,
          },
        ]}
      >
        <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", gap: 10 }}>
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
              {selected ? <Feather name="check" size={13} color="#FFFFFF" /> : null}
            </View>
          ) : (
            <Avatar name={item.contactName ?? "?"} color={color} size={34} />
          )}
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={[styles.cardName, { color: colors.foreground, textAlign }]}>
              {item.contactName ?? t("common.unnamedLead")}
            </Text>
            <Text numberOfLines={1} style={[styles.cardSub, { color: colors.mutedForeground, textAlign }]}>
              {item.contactCompany ?? item.contactEmail ?? t("common.noCompany")}
            </Text>
          </View>
        </View>
        {item.value != null && Number(item.value) > 0 ? (
          <Text style={[styles.cardValue, { color: colors.success, textAlign }]}>
            {formatCurrency(Number(item.value), item.currency ?? currencyCode)}
          </Text>
        ) : null}
      </Pressable>
    </GestureDetector>
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
  const { width: screenW } = useWindowDimensions();
  const COLUMN_WIDTH = Math.min(300, Math.round(screenW * 0.82));

  // Deep-link focus: if the dashboard passed a valid ?stage=, highlight that column.
  const focusStage =
    params.stage != null && (LEAD_STAGE_ORDER as readonly string[]).includes(params.stage)
      ? (params.stage as string)
      : null;
  const [highlightStage, setHighlightStage] = useState<string | null>(focusStage);

  const [exportOpen, setExportOpen] = useState(false);
  const { user } = useAuth();
  const showExport = canExport(user);

  const queryClient = useQueryClient();
  const query = useGetLeadPipeline();

  // ----- Drag-and-drop state -----
  const [draggingLead, setDraggingLead] = useState<Lead | null>(null);
  const [hoverStage, setHoverStage] = useState<string | null>(null);
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  const dragScale = useSharedValue(1);
  const columnBoundsRef = useRef<ColumnBounds[]>([]);
  const columnRefs = useRef<Record<string, View | null>>({});
  const lastHoverRef = useRef<string | null>(null);

  // ----- Bulk assignment -----
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

  const updateLead = useUpdateLead();

  const exitSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ----- Derived columns (always the full stage order so empty columns show) -----
  const { columns, totalOpenValue } = useMemo(() => {
    const map = new Map<string, Lead[]>();
    for (const s of query.data?.stages ?? []) map.set(s.stage, s.leads);
    const cols = LEAD_STAGE_ORDER.map((stage) => {
      const leads = map.get(stage) ?? [];
      const value = leads.reduce(
        (sum, l) => sum + convertCurrency(Number(l.value ?? 0), l.currency ?? "USD", currencyCode),
        0,
      );
      return { stage, leads, count: leads.length, value };
    });
    const openTotal = cols
      .filter((c) => c.stage !== "won" && c.stage !== "lost")
      .reduce((sum, c) => sum + c.value, 0);
    return { columns: cols, totalOpenValue: openTotal };
  }, [query.data, currencyCode]);

  // ----- Column measurement + hit testing -----
  const measureColumns = useCallback(() => {
    const bounds: ColumnBounds[] = [];
    for (const stage of LEAD_STAGE_ORDER) {
      const node = columnRefs.current[stage];
      if (node) {
        node.measureInWindow((x, _y, w) => {
          bounds.push({ stage, x, width: w });
        });
      }
    }
    columnBoundsRef.current = bounds;
  }, []);

  const stageAtX = useCallback((absX: number): string | null => {
    for (const b of columnBoundsRef.current) {
      if (absX >= b.x && absX <= b.x + b.width) return b.stage;
    }
    return null;
  }, []);

  // ----- Persist a stage change optimistically -----
  const moveLead = useCallback(
    (leadId: number, fromStage: string, toStage: string) => {
      if (fromStage === toStage) return;
      const key = getGetLeadPipelineQueryKey();
      const prev = queryClient.getQueryData<PipelineView>(key);
      if (prev) {
        let moved: Lead | undefined;
        const stripped = prev.stages.map((s) => {
          if (s.stage !== fromStage) return s;
          const leads = s.leads.filter((l) => {
            if (l.id === leadId) {
              moved = l;
              return false;
            }
            return true;
          });
          return { ...s, leads, count: leads.length };
        });
        if (moved) {
          const movedLead: Lead = { ...moved, stage: toStage as Lead["stage"] };
          const next = stripped.map((s) =>
            s.stage === toStage
              ? { ...s, leads: [movedLead, ...s.leads], count: s.leads.length + 1 }
              : s,
          );
          queryClient.setQueryData<PipelineView>(key, { ...prev, stages: next });
        }
      }
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      updateLead.mutate(
        { id: leadId, data: { stage: toStage as LeadUpdateStage } },
        {
          onError: () => {
            if (prev) queryClient.setQueryData(key, prev);
            Alert.alert(t("pipeline.failedSave"));
          },
        },
      );
    },
    [queryClient, updateLead, t],
  );

  // ----- Drag gesture callbacks (all run on the JS thread) -----
  const onDragBegin = useCallback(() => {
    measureColumns();
  }, [measureColumns]);

  const onDragStart = useCallback(
    (lead: Lead, x: number, y: number) => {
      dragX.value = x;
      dragY.value = y;
      dragScale.value = withSpring(1.04, { damping: 14, stiffness: 220 });
      setDraggingLead(lead);
      lastHoverRef.current = lead.stage;
      setHoverStage(lead.stage);
      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    },
    [dragX, dragY, dragScale],
  );

  const onDragUpdate = useCallback(
    (x: number, y: number) => {
      dragX.value = x;
      dragY.value = y;
      const target = stageAtX(x);
      if (target !== lastHoverRef.current) {
        lastHoverRef.current = target;
        setHoverStage(target);
        if (target && Platform.OS !== "web") Haptics.selectionAsync();
      }
    },
    [dragX, dragY, stageAtX],
  );

  const onDragEnd = useCallback(
    (lead: Lead, x: number) => {
      const target = stageAtX(x);
      if (target && target !== lead.stage) {
        moveLead(lead.id, lead.stage, target);
        Alert.alert(
          t("leads.movedTo", {
            stage: t(`leads.stages.${target}`, { defaultValue: prettyLabel(target) }),
          }),
        );
      }
    },
    [stageAtX, moveLead, t],
  );

  const onDragFinalize = useCallback(() => {
    dragScale.value = 1;
    setDraggingLead(null);
    setHoverStage(null);
    lastHoverRef.current = null;
  }, [dragScale]);

  const submitBulkAssign = useCallback(() => {
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
          // Manual with no team chosen must NOT send teamId — the server treats an
          // explicit teamId (incl. null) as a set, silently clearing existing team
          // bindings. Omit it instead.
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
      },
    );
  }, [selectedIds, bulkStrategy, bulkOwnerId, bulkTeamId, bulkTeamRequired, bulkAssign, queryClient, exitSelection, t]);

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  const onCardPress = useCallback(
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

  // Floating drag overlay follows the finger. Positioned in window coordinates
  // (matching e.absoluteX/Y) via a full-screen, non-interactive container.
  const overlayStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: dragX.value - COLUMN_WIDTH / 2 },
      { translateY: dragY.value - 34 },
      { scale: dragScale.value },
    ],
  }));

  const dragColor = draggingLead ? LEAD_STAGE_COLORS[draggingLead.stage] ?? colors.primary : colors.primary;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 12, paddingHorizontal: 20 }}>
        {router.canGoBack() && (
          <Pressable
            onPress={() => router.back()}
            hitSlop={10}
            style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          >
            <Feather name={isRTL ? "chevron-right" : "chevron-left"} size={20} color={colors.foreground} />
          </Pressable>
        )}

        <View style={[styles.headerActions, { top: topPad + 12, right: isRTL ? undefined : 20, left: isRTL ? 20 : undefined, flexDirection: isRTL ? "row-reverse" : "row" }]}>
          <Pressable
            onPress={() => {
              if (selectionMode) exitSelection();
              else setSelectionMode(true);
            }}
            hitSlop={10}
            style={[styles.iconBtn, { backgroundColor: selectionMode ? colors.primary : colors.card, borderColor: selectionMode ? colors.primary : colors.border }]}
          >
            <Feather name={selectionMode ? "x" : "check-square"} size={17} color={selectionMode ? "#FFFFFF" : colors.foreground} />
          </Pressable>
          {showExport && (
            <Pressable
              onPress={() => setExportOpen(true)}
              hitSlop={10}
              style={[styles.iconBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Feather name="share" size={17} color={colors.foreground} />
            </Pressable>
          )}
        </View>

        <Text style={[styles.heading, { color: colors.foreground, textAlign }]}>{t("leads.title")}</Text>
        <Text style={[styles.headingSub, { color: colors.mutedForeground, textAlign }]}>
          {formatCurrency(totalOpenValue, currencyCode)} {t("leads.openValueSuffix")}
        </Text>
        {!selectionMode && (
          <Text style={[styles.hint, { color: colors.mutedForeground, textAlign }]}>{t("leads.kanbanHint")}</Text>
        )}
      </View>

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            scrollEnabled={draggingLead == null}
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingTop: 12,
              paddingBottom: insets.bottom + 100,
              gap: 12,
              flexDirection: isRTL ? "row-reverse" : "row",
            }}
          >
            {columns.map((col) => {
              const color = LEAD_STAGE_COLORS[col.stage] ?? colors.primary;
              const isHover = hoverStage === col.stage && draggingLead != null && draggingLead.stage !== col.stage;
              const isHighlight = highlightStage === col.stage;
              return (
                <View
                  key={col.stage}
                  ref={(node) => {
                    columnRefs.current[col.stage] = node;
                  }}
                  collapsable={false}
                  style={[
                    styles.column,
                    {
                      width: COLUMN_WIDTH,
                      backgroundColor: colors.muted + (colors.radius > 0 ? "55" : "55"),
                      borderRadius: colors.radius + 6,
                      borderColor: isHover ? color : isHighlight ? color + "88" : "transparent",
                      borderWidth: isHover || isHighlight ? 2 : 0,
                    },
                  ]}
                >
                  <View style={[styles.columnHeader, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                    <View style={[styles.columnDot, { backgroundColor: color }]} />
                    <Text style={[styles.columnTitle, { color: colors.foreground }]} numberOfLines={1}>
                      {t(`leads.stages.${col.stage}`, { defaultValue: prettyLabel(col.stage) })}
                    </Text>
                    <View style={[styles.columnCount, { backgroundColor: colors.card }]}>
                      <Text style={[styles.columnCountText, { color: colors.mutedForeground }]}>{col.count}</Text>
                    </View>
                  </View>
                  {col.value > 0 ? (
                    <Text style={[styles.columnValue, { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" }]}>
                      {formatCurrency(col.value, currencyCode)}
                    </Text>
                  ) : null}

                  <ScrollView
                    style={{ flex: 1 }}
                    scrollEnabled={draggingLead == null}
                    showsVerticalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={{ gap: 10, paddingVertical: 10, paddingHorizontal: 10, flexGrow: 1 }}
                    refreshControl={
                      <RefreshControl
                        refreshing={query.isRefetching}
                        onRefresh={() => query.refetch()}
                        tintColor={colors.primary}
                      />
                    }
                  >
                    {col.leads.length === 0 ? (
                      <View style={styles.columnEmpty}>
                        <Text style={[styles.columnEmptyText, { color: colors.mutedForeground }]}>
                          {t("leads.empty")}
                        </Text>
                      </View>
                    ) : (
                      col.leads.map((lead) => (
                        <KanbanCard
                          key={lead.id}
                          item={lead}
                          colors={colors}
                          isRTL={isRTL}
                          textAlign={textAlign}
                          t={t}
                          currencyCode={currencyCode}
                          selectionMode={selectionMode}
                          selected={selectedIds.has(lead.id)}
                          hidden={draggingLead?.id === lead.id}
                          dragEnabled={!selectionMode}
                          onPress={onCardPress}
                          onLongPressSelect={toggleSelect}
                          onDragBegin={onDragBegin}
                          onDragStart={onDragStart}
                          onDragUpdate={onDragUpdate}
                          onDragEnd={onDragEnd}
                          onDragFinalize={onDragFinalize}
                        />
                      ))
                    )}
                  </ScrollView>
                </View>
              );
            })}
          </ScrollView>

          {selectionMode ? (
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

      {/* Floating drag overlay */}
      {draggingLead ? (
        <Animated.View pointerEvents="none" style={[styles.dragOverlay, { width: COLUMN_WIDTH - 20 }, overlayStyle]}>
          <View
            style={[
              styles.card,
              styles.dragCard,
              { backgroundColor: colors.card, borderColor: dragColor, borderRadius: colors.radius + 4 },
            ]}
          >
            <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", gap: 10 }}>
              <Avatar name={draggingLead.contactName ?? "?"} color={dragColor} size={34} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={[styles.cardName, { color: colors.foreground, textAlign }]}>
                  {draggingLead.contactName ?? t("common.unnamedLead")}
                </Text>
                <Text numberOfLines={1} style={[styles.cardSub, { color: colors.mutedForeground, textAlign }]}>
                  {draggingLead.contactCompany ?? draggingLead.contactEmail ?? t("common.noCompany")}
                </Text>
              </View>
            </View>
          </View>
        </Animated.View>
      ) : null}

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
        // The pipeline board has no free-form filter UI; the only active scoping
        // context is the deep-link stage focus (highlightStage). Forward it as the
        // server-supported `stage` filter so an export honors the stage the user
        // arrived focused on; when there's no focus, export the full pipeline.
        filters={{ stage: highlightStage ?? undefined }}
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
  headerActions: {
    position: "absolute",
    gap: 8,
    zIndex: 10,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
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
  hint: {
    fontSize: 12,
    fontFamily: FONT.regular,
    marginTop: 6,
  },
  column: {
    flex: 1,
    paddingTop: 12,
    overflow: "hidden",
  },
  columnHeader: {
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  columnDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  columnTitle: {
    flex: 1,
    fontSize: 15,
    fontFamily: FONT.bold,
  },
  columnCount: {
    minWidth: 24,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 7,
  },
  columnCountText: {
    fontSize: 12,
    fontFamily: FONT.bold,
  },
  columnValue: {
    fontSize: 12.5,
    fontFamily: FONT.semibold,
    paddingHorizontal: 12,
    marginTop: 4,
  },
  columnEmpty: {
    paddingVertical: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  columnEmptyText: {
    fontSize: 12.5,
    fontFamily: FONT.regular,
  },
  card: {
    padding: 12,
    borderWidth: 1,
    gap: 8,
  },
  dragCard: {
    borderWidth: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 12,
  },
  cardName: {
    fontSize: 14.5,
    fontFamily: FONT.semibold,
  },
  cardSub: {
    fontSize: 12.5,
    fontFamily: FONT.regular,
    marginTop: 1,
  },
  cardValue: {
    fontSize: 14,
    fontFamily: FONT.bold,
  },
  dragOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    zIndex: 1000,
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
    width: 34,
    height: 34,
    borderRadius: 9,
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
    fontSize: 15,
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
