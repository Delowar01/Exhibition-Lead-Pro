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

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        flexDirection: isRTL ? "row-reverse" : "row",
        paddingHorizontal: 20,
        paddingVertical: 12,
      }}
    >
      <View style={[styles.tabRow, { backgroundColor: colors.muted, flexDirection: isRTL ? "row-reverse" : "row" }]}>
        {tabs.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <Pressable
              key={tab.key}
              onPress={() => {
                if (!tab.disabled) onChange(tab.key);
              }}
              disabled={tab.disabled}
              style={[
                styles.tab,
                active && { backgroundColor: colors.card, borderRadius: RADIUS.sm, shadowColor: "#000", shadowOpacity: 0.1, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } },
                tab.disabled && { opacity: 0.5 },
              ]}
            >
              <Text
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
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
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
  tabText: {
    fontSize: 14,
    fontFamily: FONT.medium,
  },
});
