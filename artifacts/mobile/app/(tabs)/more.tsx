import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useUpdateOwnProfile } from "@workspace/api-client-react";

import { Avatar, Badge, FONT, prettyLabel } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { useOffline } from "@/contexts/OfflineContext";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { pickAvatar, type AvatarSource } from "@/lib/avatar";

export default function MoreScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL, textAlign } = useLocale();
  const { user, logout, updateUser } = useAuth();
  const { queuedCount, isOnline } = useOffline();
  const updateProfile = useUpdateOwnProfile();

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  async function applyAvatar(source: AvatarSource) {
    try {
      const uri = await pickAvatar(source);
      if (!uri) return;
      if (Platform.OS !== "web")
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const updated = await updateProfile.mutateAsync({ data: { avatarUrl: uri } });
      await updateUser(updated);
    } catch (err) {
      Alert.alert(
        t("errors.generic"),
        err instanceof Error ? err.message : t("errors.saveFailed"),
      );
    }
  }

  async function removeAvatar() {
    try {
      const updated = await updateProfile.mutateAsync({ data: { avatarUrl: null } });
      await updateUser(updated);
    } catch {
      Alert.alert(t("errors.generic"), t("errors.saveFailed"));
    }
  }

  function onAvatarPress() {
    if (updateProfile.isPending) return;
    if (Platform.OS === "web") {
      void applyAvatar("library");
      return;
    }
    const hasAvatar = !!user?.avatarUrl;
    Alert.alert(t("more.profilePhoto"), undefined, [
      { text: t("more.takePhoto"), onPress: () => void applyAvatar("camera") },
      { text: t("more.chooseFromLibrary"), onPress: () => void applyAvatar("library") },
      ...(hasAvatar
        ? [
            {
              text: t("more.removePhoto"),
              style: "destructive" as const,
              onPress: () => void removeAvatar(),
            },
          ]
        : []),
      { text: t("common.cancel"), style: "cancel" as const },
    ]);
  }

  function confirmLogout() {
    if (Platform.OS === "web") {
      void logout();
      return;
    }
    Alert.alert(t("auth.logout"), t("auth.logoutConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("auth.logout"),
        style: "destructive",
        onPress: () => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          void logout();
        },
      },
    ]);
  }

  const navItems: {
    key: string;
    label: string;
    sub: string;
    icon: keyof typeof Feather.glyphMap;
    color: string;
    onPress: () => void;
    badge?: number;
  }[] = [
    {
      key: "sync",
      label: t("nav.sync"),
      sub: isOnline ? t("more.syncManage") : t("more.syncQueued"),
      icon: "refresh-cw",
      color: queuedCount > 0 ? "#F59E0B" : "#22C55E",
      onPress: () => router.push("/sync"),
      badge: queuedCount,
    },
    {
      key: "card",
      label: t("nav.card"),
      sub: t("card.subtitle"),
      icon: "credit-card",
      color: colors.primary,
      onPress: () => router.push({ pathname: "/card", params: { mode: "edit" } }),
    },
    {
      key: "my-numbers",
      label: t("nav.myNumbers"),
      sub: t("myNumbers.subtitle"),
      icon: "trending-up",
      color: "#10B981",
      onPress: () => router.push("/my-numbers"),
    },
    {
      key: "pipeline",
      label: t("nav.leads"),
      sub: t("leads.subtitle"),
      icon: "bar-chart-2",
      color: "#8B5CF6",
      onPress: () => router.push("/leads"),
    },
    {
      key: "events",
      label: t("nav.events"),
      sub: t("events.subtitle"),
      icon: "calendar",
      color: "#8B5CF6",
      onPress: () => router.push("/events"),
    },
    {
      key: "meetings",
      label: t("nav.meetings"),
      sub: t("meetings.subtitle"),
      icon: "video",
      color: "#0EA5E9",
      onPress: () => router.push("/meetings"),
    },
    {
      key: "tasks",
      label: t("nav.tasks"),
      sub: t("tasks.subtitle"),
      icon: "check-circle",
      color: "#10B981",
      onPress: () => router.push("/tasks"),
    },
    {
      key: "contacts",
      label: t("nav.contacts"),
      sub: t("more.contactsSub"),
      icon: "users",
      color: "#06B6D4",
      onPress: () => router.push("/(tabs)/contacts"),
    },
    {
      key: "duplicates",
      label: t("nav.duplicates"),
      sub: t("duplicates.subtitle"),
      icon: "copy",
      color: "#F59E0B",
      onPress: () => router.push("/duplicates"),
    },
    {
      key: "settings",
      label: t("nav.settings"),
      sub: t("settings.subtitle"),
      icon: "settings",
      color: "#67707D",
      onPress: () => router.push("/settings"),
    },
    ...(__DEV__
      ? [
          {
            key: "dev-perf",
            label: "Dev Performance",
            sub: "Scan pipeline timings (dev build only)",
            icon: "activity" as keyof typeof Feather.glyphMap,
            color: "#8B5CF6",
            onPress: () => router.push("/dev-perf"),
          },
        ]
      : []),
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: topPad + 14,
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + 110,
          flexGrow: 1,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.heading, { color: colors.foreground, textAlign }]}>{t("nav.more")}</Text>

        {/* Profile card */}
        <View
          style={[
            styles.profileCard,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4, flexDirection: isRTL ? "row-reverse" : "row" },
          ]}
        >
          <Pressable onPress={onAvatarPress} hitSlop={8} style={styles.avatarWrap}>
            <Avatar name={user?.name} color={colors.primary} size={56} uri={user?.avatarUrl} />
            <View style={[styles.avatarBadge, { backgroundColor: colors.primary, borderColor: colors.card }]}>
              <Feather name="camera" size={12} color="#FFFFFF" />
            </View>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={[styles.profileName, { color: colors.foreground, textAlign }]}>
              {user?.name ?? "—"}
            </Text>
            <Text numberOfLines={1} style={[styles.profileEmail, { color: colors.mutedForeground, textAlign }]}>
              {user?.email ?? ""}
            </Text>
            {user?.role ? (
              <View style={{ marginTop: 6 }}>
                <Badge label={prettyLabel(user.role)} color={colors.primary} />
              </View>
            ) : null}
          </View>
        </View>

        {/* Company */}
        {user?.companyName ? (
          <View
            style={[
              styles.companyCard,
              { backgroundColor: colors.accent, borderRadius: colors.radius + 4, flexDirection: isRTL ? "row-reverse" : "row" },
            ]}
          >
            <View style={[styles.companyIcon, { backgroundColor: colors.primary }]}>
              <Feather name="briefcase" size={18} color="#FFFFFF" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.companyLabel, { color: colors.mutedForeground, textAlign }]}>
                {t("nav.workspace").toUpperCase()}
              </Text>
              <Text numberOfLines={1} style={[styles.companyName, { color: colors.foreground, textAlign }]}>
                {user.companyName}
              </Text>
            </View>
          </View>
        ) : null}

        {/* Navigation */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground, textAlign }]}>
          {t("nav.workspace").toUpperCase()}
        </Text>
        <View
          style={[
            styles.menuCard,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
          ]}
        >
          {navItems.map((item, idx) => (
            <Pressable
              key={item.key}
              onPress={() => {
                item.onPress();
              }}
              style={({ pressed }) => [
                styles.menuRow,
                { flexDirection: isRTL ? "row-reverse" : "row" },
                idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                pressed && { backgroundColor: colors.muted },
              ]}
            >
              <View style={[styles.menuIcon, { backgroundColor: item.color + "1A" }]}>
                <Feather name={item.icon} size={18} color={item.color} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.menuLabel, { color: colors.foreground, textAlign }]}>{item.label}</Text>
                <Text style={[styles.menuSub, { color: colors.mutedForeground, textAlign }]}>{item.sub}</Text>
              </View>
              {item.badge && item.badge > 0 ? (
                <View style={[styles.countBadge, { backgroundColor: item.color }]}>
                  <Text style={styles.countBadgeText}>{item.badge}</Text>
                </View>
              ) : null}
              <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
            </Pressable>
          ))}
        </View>

        {/* Sign out */}
        <Pressable
          onPress={confirmLogout}
          style={({ pressed }) => [
            styles.logoutBtn,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderRadius: colors.radius + 4,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <Feather name="log-out" size={18} color={colors.destructive} />
          <Text style={[styles.logoutText, { color: colors.destructive }]}>{t("auth.logout")}</Text>
        </Pressable>

        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
            Card Scanner Pro
          </Text>
          <Text style={[styles.footerVersion, { color: colors.mutedForeground }]}>
            {t("settings.poweredBy")}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  heading: {
    fontSize: 30,
    fontFamily: FONT.bold,
    marginBottom: 18,
  },
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 16,
    borderWidth: 1,
  },
  avatarWrap: {
    position: "relative",
  },
  avatarBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  profileName: {
    fontSize: 18,
    fontFamily: FONT.bold,
  },
  profileEmail: {
    fontSize: 13.5,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  companyCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    marginTop: 12,
  },
  companyIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  companyLabel: {
    fontSize: 10.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.6,
  },
  companyName: {
    fontSize: 15.5,
    fontFamily: FONT.semibold,
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.6,
    marginTop: 26,
    marginBottom: 12,
  },
  menuCard: {
    borderWidth: 1,
    overflow: "hidden",
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 16,
  },
  menuIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  menuLabel: {
    fontSize: 15.5,
    fontFamily: FONT.semibold,
  },
  menuSub: {
    fontSize: 12.5,
    fontFamily: FONT.regular,
    marginTop: 1,
  },
  countBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 4,
  },
  countBadgeText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontFamily: FONT.bold,
  },
  logoutBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 52,
    borderWidth: 1,
    marginTop: 26,
  },
  logoutText: {
    fontSize: 15.5,
    fontFamily: FONT.semibold,
  },
  footer: {
    alignItems: "center",
    marginTop: 28,
    gap: 2,
  },
  footerText: {
    fontSize: 13,
    fontFamily: FONT.semibold,
  },
  footerVersion: {
    fontSize: 12,
    fontFamily: FONT.regular,
  },
});
