import React from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@/components/icons";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { Avatar, Badge, FONT } from "@/components/ui";
import { TOUCH_TARGET, RADIUS, SPACING } from "@/constants/tokens";

export function WorkspaceHeader({
  title,
  subtitle,
  avatarName,
  avatarColor,
  avatarUri,
  badges = [],
  onBack,
  rightAction,
}: {
  title: string;
  subtitle?: string;
  avatarName?: string;
  avatarColor?: string;
  avatarUri?: string;
  badges?: { label: string; color: string }[];
  onBack?: () => void;
  rightAction?: React.ReactNode;
}) {
  const colors = useColors();
  const { isRTL, textAlign } = useLocale();

  return (
    <View style={[styles.container, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
      <View style={[styles.topRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
        {onBack && (
          <Pressable
            onPress={onBack}
            hitSlop={10}
            style={[styles.iconBtn, { backgroundColor: colors.background, borderColor: colors.border }]}
          >
            <Feather name={isRTL ? "chevron-right" : "chevron-left"} size={20} color={colors.foreground} />
          </Pressable>
        )}
        <View style={styles.spacer} />
        {rightAction && <View>{rightAction}</View>}
      </View>
      
      <View style={[styles.mainRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
        {(avatarName || avatarUri) && (
          <Avatar name={avatarName} uri={avatarUri} size={64} color={avatarColor} />
        )}
        <View style={styles.textContainer}>
          <Text style={[styles.title, { color: colors.foreground, textAlign }]} numberOfLines={2}>
            {title}
          </Text>
          {subtitle && (
            <Text style={[styles.subtitle, { color: colors.mutedForeground, textAlign }]} numberOfLines={1}>
              {subtitle}
            </Text>
          )}
          {badges.length > 0 && (
            <View style={[styles.badgeContainer, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {badges.map((b, i) => (
                <Badge key={i} label={b.label} color={b.color} />
              ))}
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    paddingBottom: 20,
    borderBottomWidth: 1,
  },
  topRow: {
    alignItems: "center",
    marginBottom: 16,
  },
  spacer: {
    flex: 1,
  },
  iconBtn: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    borderRadius: RADIUS.md,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  mainRow: {
    alignItems: "center",
    gap: 16,
  },
  textContainer: {
    flex: 1,
  },
  title: {
    fontSize: 24,
    fontFamily: FONT.bold,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 15,
    fontFamily: FONT.regular,
    marginBottom: 8,
  },
  badgeContainer: {
    flexWrap: "wrap",
    gap: 8,
  },
});
