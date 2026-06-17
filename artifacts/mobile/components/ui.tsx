import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from "react-native";

import { useColors } from "@/hooks/useColors";

export const FONT = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
} as const;

// ---------------------------------------------------------------------------
// Status / stage palettes
// ---------------------------------------------------------------------------

export const CONTACT_STATUS_COLORS: Record<string, string> = {
  new: "#3B82F6",
  qualified: "#8B5CF6",
  interested: "#F59E0B",
  proposal_sent: "#06B6D4",
  won: "#22C55E",
  lost: "#EF4444",
};

export const LEAD_STAGE_COLORS: Record<string, string> = {
  new: "#3B82F6",
  contacted: "#8B5CF6",
  meeting_scheduled: "#06B6D4",
  proposal_sent: "#F59E0B",
  negotiation: "#FB923C",
  won: "#22C55E",
  lost: "#EF4444",
};

export const LEAD_STAGE_ORDER = [
  "new",
  "contacted",
  "meeting_scheduled",
  "proposal_sent",
  "negotiation",
  "won",
  "lost",
];

export function prettyLabel(value: string): string {
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

export function Avatar({
  name,
  size = 44,
  color,
}: {
  name: string | null | undefined;
  size?: number;
  color?: string;
}) {
  const colors = useColors();
  const bg = color ?? colors.primary;
  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: bg },
      ]}
    >
      <Text style={[styles.avatarText, { fontSize: size * 0.38 }]}>
        {initials(name)}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

export function Badge({
  label,
  color,
}: {
  label: string;
  color: string;
}) {
  return (
    <View style={[styles.badge, { backgroundColor: color + "1A" }]}>
      <View style={[styles.badgeDot, { backgroundColor: color }]} />
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export function PrimaryButton({
  label,
  onPress,
  loading,
  disabled,
  icon,
  style,
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  icon?: keyof typeof Feather.glyphMap;
  style?: ViewStyle;
}) {
  const colors = useColors();
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.primaryBtn,
        {
          backgroundColor: colors.primary,
          borderRadius: colors.radius + 4,
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={colors.primaryForeground} />
      ) : (
        <>
          {icon ? (
            <Feather name={icon} size={18} color={colors.primaryForeground} />
          ) : null}
          <Text
            style={[styles.primaryBtnText, { color: colors.primaryForeground }]}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// State views
// ---------------------------------------------------------------------------

export function LoadingState() {
  const colors = useColors();
  return (
    <View style={styles.centerState}>
      <ActivityIndicator color={colors.primary} size="large" />
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  subtitle,
}: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  subtitle?: string;
}) {
  const colors = useColors();
  return (
    <View style={styles.centerState}>
      <View
        style={[styles.emptyIcon, { backgroundColor: colors.muted }]}
      >
        <Feather name={icon} size={28} color={colors.mutedForeground} />
      </View>
      <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
        {title}
      </Text>
      {subtitle ? (
        <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  const colors = useColors();
  return (
    <View style={styles.centerState}>
      <View style={[styles.emptyIcon, { backgroundColor: colors.destructive + "1A" }]}>
        <Feather name="alert-triangle" size={26} color={colors.destructive} />
      </View>
      <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
        Something went wrong
      </Text>
      <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
        We couldn't load this data.
      </Text>
      <Pressable
        onPress={onRetry}
        style={({ pressed }) => [
          styles.retryBtn,
          {
            borderColor: colors.border,
            borderRadius: colors.radius,
            opacity: pressed ? 0.7 : 1,
          },
        ]}
      >
        <Feather name="refresh-cw" size={15} color={colors.foreground} />
        <Text style={[styles.retryText, { color: colors.foreground }]}>
          Retry
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#FFFFFF",
    fontFamily: FONT.semibold,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    alignSelf: "flex-start",
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  badgeText: {
    fontSize: 12,
    fontFamily: FONT.semibold,
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 52,
    paddingHorizontal: 20,
  },
  primaryBtnText: {
    fontSize: 16,
    fontFamily: FONT.semibold,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 8,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  emptyTitle: {
    fontSize: 17,
    fontFamily: FONT.semibold,
  },
  emptySubtitle: {
    fontSize: 14,
    fontFamily: FONT.regular,
    textAlign: "center",
    lineHeight: 20,
  },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginTop: 10,
  },
  retryText: {
    fontSize: 14,
    fontFamily: FONT.medium,
  },
});
