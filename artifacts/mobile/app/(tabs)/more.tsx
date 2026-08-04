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

import { Avatar, Badge, Card, FONT, ListRow, prettyLabel } from "@/components/ui";
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

  const isFullAccess = user?.role === "primary_admin" || user?.role === "platform_owner";
  const assistantPerms = (user?.permissions?.ai_assistant as string[] | undefined) ?? [];
  const canViewAssistant =
    user?.role !== "platform_owner" && (isFullAccess || assistantPerms.includes("view"));

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

  type MoreItem = {
    key: string;
    label: string;
    sub: string;
    icon: keyof typeof Feather.glyphMap;
    color: string;
    onPress?: () => void;
    badge?: number;
    disabled?: boolean;
  };
  type MoreGroup = { key: string; title: string; items: MoreItem[] };

  const allGroups: MoreGroup[] = [
    {
      key: "crm",
      title: t("more.groupCrm"),
      items: [
        {
          key: "contacts",
          label: t("nav.contacts"),
          sub: t("more.contactsSub"),
          icon: "users",
          color: "#06B6D4",
          onPress: () => router.push("/contacts"),
        },
        {
          key: "companies",
          label: t("nav.companies"),
          sub: t("companies.subtitle"),
          icon: "briefcase",
          color: "#6366F1",
          onPress: () => router.push("/companies"),
        },
        {
          key: "followups",
          label: t("nav.followups"),
          sub: t("more.followupsSub"),
          icon: "check-square",
          color: "#F97316",
          onPress: () => router.push("/followups"),
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
          key: "events",
          label: t("nav.events"),
          sub: t("events.subtitle"),
          icon: "calendar",
          color: "#8B5CF6",
          onPress: () => router.push("/events"),
        },
        {
          key: "duplicates",
          label: t("nav.duplicates"),
          sub: t("duplicates.subtitle"),
          icon: "copy",
          color: "#F59E0B",
          onPress: () => router.push("/duplicates"),
        },
      ],
    },
    {
      key: "ai",
      title: t("more.groupAi"),
      items: [
        ...(canViewAssistant
          ? [
              {
                key: "assistant",
                label: t("nav.aiAssistant"),
                sub: t("assistant.subtitle"),
                icon: "message-circle" as keyof typeof Feather.glyphMap,
                color: "#8B5CF6",
                onPress: () => router.push("/assistant"),
              },
            ]
          : []),
      ],
    },
    {
      key: "workspace",
      title: t("more.groupWorkspace"),
      items: [
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
          key: "sync",
          label: t("nav.sync"),
          sub: isOnline ? t("more.syncManage") : t("more.syncQueued"),
          icon: "refresh-cw",
          color: queuedCount > 0 ? "#F59E0B" : "#22C55E",
          onPress: () => router.push("/sync"),
          badge: queuedCount,
        },
      ],
    },
    {
      key: "settings",
      title: t("more.groupSettings"),
      items: [
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
                label: t("more.devPerf"),
                sub: t("more.devPerfSub"),
                icon: "activity" as keyof typeof Feather.glyphMap,
                color: "#8B5CF6",
                onPress: () => router.push("/dev-perf"),
              },
            ]
          : []),
      ],
    },
  ];
  const navGroups = allGroups.filter((g) => g.items.length > 0);

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

        <Card padded={false} style={{ overflow: "hidden", marginBottom: 12 }}>
          <View style={[styles.profileCard, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
            <Pressable onPress={onAvatarPress} hitSlop={8} style={styles.avatarWrap}>
              <Avatar name={user?.name} color={colors.primary} size={64} uri={user?.avatarUrl} />
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
                <View style={{ marginTop: 6, alignSelf: isRTL ? "flex-end" : "flex-start" }}>
                  <Badge label={prettyLabel(user.role)} color={colors.primary} />
                </View>
              ) : null}
            </View>
          </View>
        </Card>

        {user?.companyName ? (
          <Card padded={false} style={{ backgroundColor: colors.accent, marginBottom: 20 }}>
            <View style={[styles.companyCard, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
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
          </Card>
        ) : null}

        {navGroups.map((group) => (
          <View key={group.key}>
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground, textAlign }]}>
              {group.title.toUpperCase()}
            </Text>
            <Card padded={false}>
              {group.items.map((item, idx) => (
                <ListRow
                  key={item.key}
                  icon={item.icon}
                  title={item.label}
                  subtitle={item.sub}
                  onPress={item.disabled ? undefined : item.onPress}
                  showChevron={!item.disabled}
                  right={
                    item.badge && item.badge > 0 ? (
                      <View style={[styles.countBadge, { backgroundColor: item.color }]}>
                        <Text style={styles.countBadgeText}>{item.badge}</Text>
                      </View>
                    ) : null
                  }
                  style={[
                    styles.menuRow,
                    idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                    item.disabled && { opacity: 0.55 },
                  ]}
                />
              ))}
            </Card>
          </View>
        ))}

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
    fontSize: 32,
    fontFamily: FONT.bold,
    marginBottom: 20,
    letterSpacing: -0.5,
  },
  profileCard: {
    alignItems: "center",
    gap: 16,
    padding: 16,
  },
  avatarWrap: {
    position: "relative",
  },
  avatarBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  profileName: {
    fontSize: 20,
    fontFamily: FONT.bold,
  },
  profileEmail: {
    fontSize: 14,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  companyCard: {
    alignItems: "center",
    gap: 14,
    padding: 16,
  },
  companyIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  companyLabel: {
    fontSize: 11,
    fontFamily: FONT.semibold,
    letterSpacing: 0.8,
  },
  companyName: {
    fontSize: 16,
    fontFamily: FONT.semibold,
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 12,
    fontFamily: FONT.semibold,
    letterSpacing: 0.8,
    marginTop: 28,
    marginBottom: 10,
    marginLeft: 4,
  },
  menuRow: {
    paddingHorizontal: 16,
  },
  countBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
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
    height: 54,
    borderWidth: 1,
    marginTop: 32,
  },
  logoutText: {
    fontSize: 16,
    fontFamily: FONT.semibold,
  },
  footer: {
    alignItems: "center",
    marginTop: 32,
    gap: 4,
  },
  footerText: {
    fontSize: 14,
    fontFamily: FONT.semibold,
  },
  footerVersion: {
    fontSize: 12,
    fontFamily: FONT.regular,
  },
});
