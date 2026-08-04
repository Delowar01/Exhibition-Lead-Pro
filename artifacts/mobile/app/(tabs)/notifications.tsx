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

import { FONT, Card, SecondaryButton, EmptyState } from "@/components/ui";
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
            <Feather name={icon} size={20} color={unread ? colors.primary : colors.mutedForeground} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={[styles.titleRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              <Text
                numberOfLines={1}
                style={[
                  styles.title,
                  { color: colors.foreground, textAlign, fontFamily: unread ? FONT.bold : FONT.semibold, flex: 1 },
                ]}
              >
                {item.title}
              </Text>
              <Text style={[styles.time, { color: colors.mutedForeground }]}>
                {timeAgo(item.createdAt, language)}
              </Text>
            </View>
            {item.body ? (
              <Text numberOfLines={2} style={[styles.body, { color: colors.mutedForeground, textAlign }]}>
                {item.body}
              </Text>
            ) : null}
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
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: topPad + 14,
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + 110,
          flexGrow: 1,
          gap: 12,
        }}
        ListHeaderComponent={
          <View style={{ marginBottom: 12 }}>
            <View
              style={{
                flexDirection: isRTL ? "row-reverse" : "row",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 4,
              }}
            >
              <Text style={[styles.heading, { color: colors.foreground, textAlign }]}>
                {t("nav.notifications")}
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
          isLoading ? (
            <View style={{ gap: 12 }}>
               {[1,2,3,4].map(i => (
                 <View key={i} style={[styles.row, { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radius + 4 }]} >
                   <View style={[styles.iconWrap, { backgroundColor: colors.muted }]} />
                   <View style={{ flex: 1, gap: 8 }}>
                     <View style={{ height: 16, backgroundColor: colors.muted, borderRadius: 4, width: '60%' }} />
                     <View style={{ height: 12, backgroundColor: colors.muted, borderRadius: 4, width: '90%' }} />
                   </View>
                 </View>
               ))}
            </View>
          ) : (
            <Card padded style={{ marginTop: 32 }}>
               <EmptyState icon="bell" title={t("notifCenter.empty")} subtitle={t("notifCenter.emptyDesc")} />
            </Card>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  heading: {
    fontSize: 32,
    fontFamily: FONT.bold,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 15,
    fontFamily: FONT.regular,
  },
  markAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
  },
  markAllText: {
    fontSize: 13,
    fontFamily: FONT.semibold,
  },
  row: {
    alignItems: "flex-start",
    gap: 14,
    padding: 16,
    borderWidth: 1,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  titleRow: {
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  title: {
    fontSize: 16,
  },
  body: {
    fontSize: 14,
    fontFamily: FONT.regular,
    lineHeight: 20,
  },
  time: {
    fontSize: 12,
    fontFamily: FONT.regular,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 6,
  },
});
