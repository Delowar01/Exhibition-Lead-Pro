import { Feather } from "@/components/icons";
import React, { useCallback, useMemo } from "react";
import {
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";

import {
  useListNotifications,
  getListNotificationsQueryKey,
  useGetUnreadCount,
  getGetUnreadCountQueryKey,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  type Notification,
} from "@workspace/api-client-react";

import { FONT } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";

const CATEGORY_ICONS: Record<string, keyof typeof Feather.glyphMap> = {
  security: "shield",
  billing: "credit-card",
  invitations: "user-plus",
  reports: "bar-chart-2",
  ai: "zap",
  subscription: "credit-card",
  events: "calendar",
  user_mgmt: "users",
  mentions: "at-sign",
};

// Server notification links are web-portal paths; map the ones with a mobile
// counterpart and safely ignore the rest (never open external/unknown links).
function mapLinkToMobileRoute(link: string | null | undefined): string | null {
  if (!link || !link.startsWith("/admin")) return null;
  const lead = link.match(/^\/admin\/leads\/(\d+)/);
  if (lead) return `/pipeline/${lead[1]}`;
  const contact = link.match(/^\/admin\/contacts\/(\d+)/);
  if (contact) return `/contact/${contact[1]}`;
  if (link.startsWith("/admin/workflow")) return "/workflow";
  if (link.startsWith("/admin/leads")) return "/leads";
  if (link.startsWith("/admin/contacts")) return "/contacts";
  return null;
}

function timeAgo(iso: string, locale: string): string {
  const then = new Date(iso).getTime();
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (mins < 60) return rtf.format(-mins, "minute");
  const hours = Math.round(mins / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 30) return rtf.format(-days, "day");
  return new Date(iso).toLocaleDateString(locale);
}

export default function NotificationsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t, isRTL, textAlign, language } = useLocale();
  const queryClient = useQueryClient();
  const router = useRouter();

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  const { data, isLoading, isRefetching, refetch } = useListNotifications(undefined, {
    query: { queryKey: getListNotificationsQueryKey() },
  });
  const { data: unreadData } = useGetUnreadCount({
    query: { queryKey: getGetUnreadCountQueryKey() },
  });
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  const notifications = useMemo(() => data?.notifications ?? [], [data]);
  const unreadCount = unreadData?.count ?? 0;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetUnreadCountQueryKey() });
  }, [queryClient]);

  const onPressItem = useCallback(
    (n: Notification) => {
      if (!n.readAt) {
        markRead.mutate({ id: n.id }, { onSettled: invalidate });
      }
      const target = mapLinkToMobileRoute(n.link);
      if (target) router.push(target as never);
    },
    [markRead, invalidate, router],
  );

  const onMarkAll = useCallback(() => {
    markAll.mutate(undefined, { onSettled: invalidate });
  }, [markAll, invalidate]);

  const renderItem = useCallback(
    ({ item }: { item: Notification }) => {
      const icon = CATEGORY_ICONS[item.category] ?? "bell";
      const unread = !item.readAt;
      return (
        <Pressable
          onPress={() => onPressItem(item)}
          accessibilityRole="button"
          accessibilityLabel={item.title}
          style={({ pressed }) => [
            styles.row,
            {
              backgroundColor: pressed ? colors.muted : colors.card,
              borderColor: colors.border,
              borderRadius: colors.radius + 4,
              flexDirection: isRTL ? "row-reverse" : "row",
            },
          ]}
        >
          <View
            style={[
              styles.iconWrap,
              { backgroundColor: (unread ? colors.primary : colors.mutedForeground) + "1A" },
            ]}
          >
            <Feather name={icon} size={18} color={unread ? colors.primary : colors.mutedForeground} />
          </View>
          <View style={{ flex: 1 }}>
            <Text
              numberOfLines={2}
              style={[
                styles.title,
                { color: colors.foreground, textAlign, fontFamily: unread ? FONT.bold : FONT.semibold },
              ]}
            >
              {item.title}
            </Text>
            {item.body ? (
              <Text numberOfLines={2} style={[styles.body, { color: colors.mutedForeground, textAlign }]}>
                {item.body}
              </Text>
            ) : null}
            <Text style={[styles.time, { color: colors.mutedForeground, textAlign }]}>
              {timeAgo(item.createdAt, language)}
            </Text>
          </View>
          {unread ? <View style={[styles.dot, { backgroundColor: colors.primary }]} /> : null}
        </Pressable>
      );
    },
    [colors, isRTL, textAlign, language, onPressItem],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <FlatList
        data={notifications}
        keyExtractor={(n) => String(n.id)}
        renderItem={renderItem}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.primary} />
        }
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingTop: topPad + 14,
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + 110,
          flexGrow: 1,
          gap: 10,
        }}
        ListHeaderComponent={
          <View style={{ marginBottom: 8 }}>
            <View
              style={{
                flexDirection: isRTL ? "row-reverse" : "row",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <Text style={[styles.heading, { color: colors.foreground, textAlign }]}>
                {t("notifCenter.title")}
              </Text>
              {unreadCount > 0 ? (
                <Pressable
                  onPress={onMarkAll}
                  disabled={markAll.isPending}
                  accessibilityRole="button"
                  accessibilityLabel={t("notifCenter.markAllRead")}
                  style={({ pressed }) => [
                    styles.markAllBtn,
                    { borderColor: colors.border, backgroundColor: colors.card, opacity: pressed || markAll.isPending ? 0.6 : 1 },
                  ]}
                >
                  <Feather name="check-circle" size={14} color={colors.primary} />
                  <Text style={[styles.markAllText, { color: colors.primary }]}>
                    {t("notifCenter.markAllRead")}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            <Text style={[styles.subtitle, { color: colors.mutedForeground, textAlign }]}>
              {unreadCount > 0
                ? t("notifCenter.unread", { count: unreadCount })
                : t("notifCenter.allCaughtUp")}
            </Text>
          </View>
        }
        ListEmptyComponent={
          isLoading ? null : (
            <View style={styles.empty}>
              <View style={[styles.emptyIcon, { backgroundColor: colors.primary + "1A" }]}>
                <Feather name="bell" size={26} color={colors.primary} />
              </View>
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                {t("notifCenter.empty")}
              </Text>
              <Text style={[styles.emptyDesc, { color: colors.mutedForeground }]}>
                {t("notifCenter.emptyDesc")}
              </Text>
            </View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  heading: {
    fontSize: 30,
    fontFamily: FONT.bold,
  },
  subtitle: {
    fontSize: 13.5,
    fontFamily: FONT.regular,
    marginTop: 4,
  },
  markAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
  },
  markAllText: {
    fontSize: 12.5,
    fontFamily: FONT.semibold,
  },
  row: {
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderWidth: 1,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 14.5,
  },
  body: {
    fontSize: 13,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  time: {
    fontSize: 11.5,
    fontFamily: FONT.regular,
    marginTop: 4,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    flexGrow: 1,
    paddingVertical: 60,
    gap: 8,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize: 16.5,
    fontFamily: FONT.bold,
  },
  emptyDesc: {
    fontSize: 13.5,
    fontFamily: FONT.regular,
    textAlign: "center",
    maxWidth: 260,
  },
});
