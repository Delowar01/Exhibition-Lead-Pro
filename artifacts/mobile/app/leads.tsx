import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
   FlatList,
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
  type Lead,
  useGetLeadPipeline,
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
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { useSettings } from "@/contexts/SettingsContext";
import { getCountry } from "@/lib/countries";
import { formatCurrency } from "@/lib/currency";

const ALL_STAGE = "all";

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

  const query = useGetLeadPipeline();

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  const stages = useMemo(() => {
    const map = new Map<string, { count: number; value: number; leads: Lead[] }>();
    for (const s of query.data?.stages ?? []) {
      map.set(s.stage, { count: s.count, value: s.value, leads: s.leads });
    }
    return LEAD_STAGE_ORDER.map((stage) => ({
      stage,
      count: map.get(stage)?.count ?? 0,
      value: map.get(stage)?.value ?? 0,
      leads: map.get(stage)?.leads ?? [],
    }));
  }, [query.data]);

  // "All" shows every lead across every stage, sorted by value descending.
  const allLeads = useMemo(
    () =>
      stages
        .flatMap((s) => s.leads)
        .sort((a, b) => (Number(b.value ?? 0)) - (Number(a.value ?? 0))),
    [stages],
  );

  const totalValue = query.data?.totalValue ?? 0;
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
    const allChip = { stage: ALL_STAGE, count: totalCount, value: totalValue };
    return [allChip, ...stages];
  }, [stages, totalCount, totalValue]);

  function renderLead({ item }: { item: Lead }) {
    const color = LEAD_STAGE_COLORS[item.stage] ?? colors.primary;
    return (
      <Pressable
        onPress={() => {
          if (Platform.OS !== "web") Haptics.selectionAsync();
          router.push(`/pipeline/${item.id}`);
        }}
        style={({ pressed }) => [
          styles.leadCard,
          { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4, flexDirection: isRTL ? "row-reverse" : "row", opacity: pressed ? 0.75 : 1 },
        ]}
      >
        <Avatar name={item.contactName ?? "?"} color={color} size={40} />
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
        <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
      </Pressable>
    );
  }

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
        <Text style={[styles.heading, { color: colors.foreground, textAlign }]}>{t("leads.title")}</Text>
        <Text style={[styles.headingSub, { color: colors.mutedForeground, textAlign }]}>
          {formatCurrency(totalValue, currencyCode)} {t("leads.openValueSuffix")}
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

          {/* FAB */}
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
        </>
      )}
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
});
