import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Feather } from "@/components/icons";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { FONT } from "@/components/ui";

export type QuickActionItem = {
  key: string;
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
};

/**
 * Compact, equal-width quick-action row for the contact workspace.
 *
 * Device round #2: the previous horizontally-scrolling pill row clipped the
 * trailing buttons on real Android widths (Website was half-hidden at 360dp).
 * Four flex:1 buttons with a stacked icon+label always fit — at 360dp each
 * button gets ~76dp, enough for the longest label ("WhatsApp" / Arabic
 * equivalents) at fontSize 11 with no clipping in LTR or RTL.
 */
export function QuickActionsBar({ actions }: { actions: QuickActionItem[] }) {
  const colors = useColors();
  const { isRTL } = useLocale();

  return (
    <View style={[styles.row, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
      {actions.map((action) => (
        <Pressable
          key={action.key}
          onPress={action.onPress}
          disabled={action.disabled}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          accessibilityState={{ disabled: !!action.disabled }}
          style={({ pressed }) => [
            styles.actionBtn,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              opacity: action.disabled ? 0.4 : pressed ? 0.7 : 1,
            },
          ]}
        >
          <Feather name={action.icon} size={18} color={colors.primary} />
          <Text
            numberOfLines={1}
            allowFontScaling={false}
            style={[styles.actionLabel, { color: colors.foreground }]}
          >
            {action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 9,
    paddingHorizontal: 4,
    borderRadius: 14,
    borderWidth: 1,
    minHeight: 56,
  },
  actionLabel: {
    fontSize: 11,
    fontFamily: FONT.medium,
    textAlign: "center",
  },
});
