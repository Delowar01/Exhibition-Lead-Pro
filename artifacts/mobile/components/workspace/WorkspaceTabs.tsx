import React from "react";
import { View, ScrollView, Text, Pressable, StyleSheet } from "react-native";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { FONT } from "@/components/ui";
import { RADIUS } from "@/constants/tokens";

export type TabItem = {
  key: string;
  label: string;
  count?: number;
  disabled?: boolean;
};

// Up to this many tabs the bar renders as a fixed, evenly-divided segmented
// control that always fits the screen width (no horizontal scrolling). This is
// the Android-friendly layout: nothing clips off-screen, RTL just reverses the
// row, and every segment is reachable. With more tabs than fit comfortably we
// fall back to the original horizontally scrollable pill row.
const SEGMENTED_MAX_TABS = 4;

function TabButton({
  tab,
  active,
  onChange,
  fill,
}: {
  tab: TabItem;
  active: boolean;
  onChange: (key: string) => void;
  fill: boolean;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={() => {
        if (!tab.disabled) onChange(tab.key);
      }}
      disabled={tab.disabled}
      accessibilityRole="tab"
      accessibilityState={{ selected: active, disabled: !!tab.disabled }}
      style={[
        styles.tab,
        fill && styles.tabFill,
        active && {
          backgroundColor: colors.card,
          borderRadius: RADIUS.sm,
          shadowColor: "#000",
          shadowOpacity: 0.1,
          shadowRadius: 2,
          shadowOffset: { width: 0, height: 1 },
          elevation: 1,
        },
        tab.disabled && { opacity: 0.5 },
      ]}
    >
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit={fill}
        minimumFontScale={0.8}
        style={[
          styles.tabText,
          { color: active ? colors.foreground : colors.mutedForeground },
        ]}
      >
        {tab.label}
        {typeof tab.count === "number" ? ` (${tab.count})` : ""}
      </Text>
    </Pressable>
  );
}

export function WorkspaceTabs({
  tabs,
  activeTab,
  onChange,
}: {
  tabs: TabItem[];
  activeTab: string;
  onChange: (key: string) => void;
}) {
  const colors = useColors();
  const { isRTL } = useLocale();
  const direction = isRTL ? ("row-reverse" as const) : ("row" as const);

  if (tabs.length <= SEGMENTED_MAX_TABS) {
    return (
      <View style={styles.segmentedWrap}>
        <View style={[styles.tabRow, { backgroundColor: colors.muted, flexDirection: direction }]}>
          {tabs.map((tab) => (
            <TabButton
              key={tab.key}
              tab={tab}
              active={activeTab === tab.key}
              onChange={onChange}
              fill
            />
          ))}
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        flexDirection: direction,
        paddingHorizontal: 20,
        paddingVertical: 12,
      }}
    >
      <View style={[styles.tabRow, { backgroundColor: colors.muted, flexDirection: direction }]}>
        {tabs.map((tab) => (
          <TabButton
            key={tab.key}
            tab={tab}
            active={activeTab === tab.key}
            onChange={onChange}
            fill={false}
          />
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  segmentedWrap: {
    paddingVertical: 12,
  },
  tabRow: {
    padding: 4,
    borderRadius: RADIUS.md,
    gap: 4,
  },
  tab: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  tabFill: {
    flex: 1,
    paddingHorizontal: 4,
  },
  tabText: {
    fontSize: 14,
    fontFamily: FONT.medium,
  },
});
