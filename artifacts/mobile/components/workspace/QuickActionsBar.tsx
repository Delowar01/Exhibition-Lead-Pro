import React from "react";
import { View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import { Feather } from "@/components/icons";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { FONT } from "@/components/ui";
import { RADIUS } from "@/constants/tokens";

export type QuickActionItem = {
  key: string;
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
};

export function QuickActionsBar({ actions }: { actions: QuickActionItem[] }) {
  const colors = useColors();
  const { isRTL, textAlign } = useLocale();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        flexDirection: isRTL ? "row-reverse" : "row",
        paddingHorizontal: 20,
        paddingVertical: 16,
        gap: 12,
      }}
    >
      {actions.map((action) => (
        <Pressable
          key={action.key}
          onPress={action.onPress}
          disabled={action.disabled}
          style={({ pressed }) => [
            styles.actionBtn,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              opacity: action.disabled ? 0.4 : pressed ? 0.7 : 1,
            },
          ]}
        >
          <Feather name={action.icon} size={20} color={colors.primary} />
          <Text style={[styles.actionLabel, { color: colors.foreground, textAlign }]}>
            {action.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: RADIUS.full,
    borderWidth: 1,
  },
  actionLabel: {
    fontSize: 14,
    fontFamily: FONT.medium,
  },
});
