import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
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

function formatCurrency(value: number): string {
  if (value >= 1000) return `$${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`;
  return `$${value}`;
}

export default function LeadsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const query = useGetLeadPipeline();
  const [activeStage, setActiveStage] = useState<string>("new");

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

  const totalValue = query.data?.totalValue ?? 0;
  const current = stages.find((s) => s.stage === activeStage);

  function renderLead({ item }: { item: Lead }) {
    const color = LEAD_STAGE_COLORS[item.stage] ?? colors.primary;
    return (
      <View
        style={[
          styles.leadCard,
          { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
        ]}
      >
        <Avatar name={item.contactName ?? "?"} color={color} size={40} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={[styles.leadName, { color: colors.foreground }]}>
            {item.contactName ?? "Unnamed lead"}
          </Text>
          <Text numberOfLines={1} style={[styles.leadSub, { color: colors.mutedForeground }]}>
            {item.contactCompany ?? item.contactEmail ?? "No company"}
          </Text>
        </View>
        {item.value != null && item.value > 0 ? (
          <Text style={[styles.leadValue, { color: colors.success }]}>
            {formatCurrency(item.value)}
          </Text>
        ) : null}
      </View>
    );
  }

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
        <Text style={[styles.heading, { color: colors.foreground }]}>Pipeline</Text>
        <Text style={[styles.headingSub, { color: colors.mutedForeground }]}>
          {formatCurrency(totalValue)} in open value
        </Text>
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
              contentContainerStyle={styles.stageBar}
            >
              {stages.map((s) => {
                const active = s.stage === activeStage;
                const color = LEAD_STAGE_COLORS[s.stage] ?? colors.primary;
                return (
                  <Pressable
                    key={s.stage}
                    onPress={() => {
                      if (Platform.OS !== "web") {
                        Haptics.selectionAsync();
                      }
                      setActiveStage(s.stage);
                    }}
                    style={[
                      styles.stageChip,
                      {
                        backgroundColor: active ? color : colors.card,
                        borderColor: active ? color : colors.border,
                        borderRadius: colors.radius + 2,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.stageChipText,
                        { color: active ? "#FFFFFF" : colors.foreground },
                      ]}
                    >
                      {prettyLabel(s.stage)}
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
            data={current?.leads ?? []}
            keyExtractor={(item) => String(item.id)}
            renderItem={renderLead}
            contentContainerStyle={{
              padding: 20,
              paddingBottom: insets.bottom + 100,
              gap: 10,
            }}
            scrollEnabled={(current?.leads.length ?? 0) > 0}
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
                  title="No leads here"
                  subtitle={`Nothing in ${prettyLabel(activeStage)} yet.`}
                />
              </View>
            }
          />
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
});
