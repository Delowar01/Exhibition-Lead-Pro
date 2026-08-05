/**
 * NotificationBell — compact header bell with unread badge + a small anchored
 * panel showing the latest 3 notifications.
 *
 * Reads the SAME generated react-query hooks (and query keys) as the full
 * Notification Center screen, so there is one shared cache and zero duplicated
 * notification state. Deep links go through the shared
 * `mapLinkToMobileRoute` helper for consistent behavior.
 */

import React, { useCallback, useMemo, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  useListNotifications,
  getListNotificationsQueryKey,
  useGetUnreadCount,
  getGetUnreadCountQueryKey,
  useMarkNotificationRead,
  type Notification,
} from "@workspace/api-client-react";

import { Feather } from "@/components/icons";
import { FONT } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { CATEGORY_ICONS, mapLinkToMobileRoute, timeAgo } from "@/lib/notification-center";

export function NotificationBell() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t, isRTL, textAlign, language } = useLocale();
  const { width: screenWidth } = useWindowDimensions();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);

  const { data: unreadData } = useGetUnreadCount({
    query: { queryKey: getGetUnreadCountQueryKey(), refetchInterval: 60000 },
  });
  const unreadCount = unreadData?.count ?? 0;

  // Same list query/key as the Notification Center — shared cache, no 2nd API.
  const listQuery = useListNotifications(undefined, {
    query: { queryKey: getListNotificationsQueryKey(), enabled: open },
  });
  const markRead = useMarkNotificationRead();

  const latest = useMemo(
    () => (listQuery.data?.notifications ?? []).slice(0, 3),
    [listQuery.data],
  );

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetUnreadCountQueryKey() });
  }, [queryClient]);

  const onPressItem = useCallback(
    (n: Notification) => {
      if (!n.readAt) markRead.mutate({ id: n.id }, { onSettled: invalidate });
      setOpen(false);
      const target = mapLinkToMobileRoute(n.link);
      if (target) router.push(target as never);
    },
    [markRead, invalidate, router],
  );

  const onViewAll = useCallback(() => {
    setOpen(false);
    router.push("/notifications");
  }, [router]);

  // Never overflow narrow screens: cap the panel width and keep 16px margins.
  const panelWidth = Math.min(340, screenWidth - 32);
  const panelTop = insets.top + (Platform.OS === "web" ? 76 : 60);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("nav.notifications")}
        style={({ pressed }) => [
          styles.bellBtn,
          { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <Feather name="bell" size={19} color={colors.foreground} />
        {unreadCount > 0 ? (
          <View style={[styles.badge, { backgroundColor: colors.primary, borderColor: colors.background }]}>
            <Text style={styles.badgeText}>{unreadCount > 99 ? "99+" : unreadCount}</Text>
          </View>
        ) : null}
      </Pressable>

      <Modal visible={open} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={[
              styles.panel,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                width: panelWidth,
                marginTop: panelTop,
                // Anchor under the bell: trailing edge in LTR, leading in RTL.
                alignSelf: isRTL ? "flex-start" : "flex-end",
              },
            ]}
          >
            {/* Panel header */}
            <View style={[styles.panelHeader, { flexDirection: isRTL ? "row-reverse" : "row", borderBottomColor: colors.border }]}>
              <Text style={[styles.panelTitle, { color: colors.foreground, textAlign }]}>
                {t("nav.notifications")}
              </Text>
              {unreadCount > 0 ? (
                <View style={[styles.unreadPill, { backgroundColor: colors.primary + "1A" }]}>
                  <Text style={[styles.unreadPillText, { color: colors.primary }]}>
                    {t("notifCenter.unread", { count: unreadCount })}
                  </Text>
                </View>
              ) : null}
            </View>

            {/* Body: loading / error / empty / latest 3 */}
            {listQuery.isLoading ? (
              <View style={styles.body}>
                {[1, 2, 3].map((i) => (
                  <View key={i} style={[styles.item, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                    <View style={[styles.itemIcon, { backgroundColor: colors.muted }]} />
                    <View style={{ flex: 1, gap: 6 }}>
                      <View style={{ height: 13, backgroundColor: colors.muted, borderRadius: 4, width: "62%" }} />
                      <View style={{ height: 10, backgroundColor: colors.muted, borderRadius: 4, width: "88%" }} />
                    </View>
                  </View>
                ))}
              </View>
            ) : listQuery.isError ? (
              <View style={[styles.body, styles.stateWrap]}>
                <Feather name="alert-triangle" size={20} color={colors.destructive} />
                <Text style={[styles.stateText, { color: colors.mutedForeground }]}>
                  {t("notifCenter.loadFailed")}
                </Text>
                <Pressable
                  onPress={() => void listQuery.refetch()}
                  style={({ pressed }) => [
                    styles.retryBtn,
                    { borderColor: colors.border, opacity: pressed ? 0.6 : 1 },
                  ]}
                >
                  <Text style={[styles.retryText, { color: colors.primary }]}>{t("common.retry")}</Text>
                </Pressable>
              </View>
            ) : latest.length === 0 ? (
              <View style={[styles.body, styles.stateWrap]}>
                <Feather name="bell" size={20} color={colors.mutedForeground} />
                <Text style={[styles.stateText, { color: colors.mutedForeground }]}>
                  {t("notifCenter.empty")}
                </Text>
              </View>
            ) : (
              <View style={styles.body}>
                {latest.map((n) => {
                  const unread = !n.readAt;
                  return (
                    <Pressable
                      key={n.id}
                      onPress={() => onPressItem(n)}
                      accessibilityRole="button"
                      accessibilityLabel={n.title}
                      style={({ pressed }) => [
                        styles.item,
                        {
                          flexDirection: isRTL ? "row-reverse" : "row",
                          backgroundColor: pressed ? colors.muted : "transparent",
                        },
                      ]}
                    >
                      <View
                        style={[
                          styles.itemIcon,
                          { backgroundColor: (unread ? colors.primary : colors.mutedForeground) + "1A" },
                        ]}
                      >
                        <Feather
                          name={CATEGORY_ICONS[n.category] ?? "bell"}
                          size={15}
                          color={unread ? colors.primary : colors.mutedForeground}
                        />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text
                          numberOfLines={1}
                          style={{
                            fontSize: 13,
                            fontFamily: unread ? FONT.bold : FONT.semibold,
                            color: colors.foreground,
                            textAlign,
                          }}
                        >
                          {n.title}
                        </Text>
                        {n.body ? (
                          <Text
                            numberOfLines={1}
                            style={{ fontSize: 12, fontFamily: FONT.regular, color: colors.mutedForeground, textAlign }}
                          >
                            {n.body}
                          </Text>
                        ) : null}
                        <Text style={{ fontSize: 11, fontFamily: FONT.regular, color: colors.mutedForeground, textAlign }}>
                          {timeAgo(n.createdAt, language)}
                        </Text>
                      </View>
                      {unread ? <View style={[styles.dot, { backgroundColor: colors.primary }]} /> : null}
                    </Pressable>
                  );
                })}
              </View>
            )}

            {/* View all — opens the full Notification Center */}
            <Pressable
              onPress={onViewAll}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.viewAll,
                { borderTopColor: colors.border, opacity: pressed ? 0.6 : 1, flexDirection: isRTL ? "row-reverse" : "row" },
              ]}
            >
              <Text style={[styles.viewAllText, { color: colors.primary }]}>
                {t("notifCenter.viewAll")}
              </Text>
              <Feather
                name={isRTL ? "chevron-left" : "chevron-right"}
                size={15}
                color={colors.primary}
              />
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  bellBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: "#FFFFFF",
    fontSize: 10,
    fontFamily: FONT.bold,
  },
  backdrop: {
    flex: 1,
    backgroundColor: "#00000042",
    paddingHorizontal: 16,
  },
  panel: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
    // Soft elevation so the panel reads as a sheet on both themes.
    elevation: 8,
    shadowColor: "#000000",
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  panelHeader: {
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  panelTitle: {
    fontSize: 15,
    fontFamily: FONT.bold,
  },
  unreadPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  unreadPillText: {
    fontSize: 11,
    fontFamily: FONT.semibold,
  },
  body: {
    paddingVertical: 4,
  },
  item: {
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  itemIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  stateWrap: {
    alignItems: "center",
    gap: 6,
    paddingVertical: 20,
    paddingHorizontal: 16,
  },
  stateText: {
    fontSize: 13,
    fontFamily: FONT.medium,
    textAlign: "center",
  },
  retryBtn: {
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  retryText: {
    fontSize: 12,
    fontFamily: FONT.semibold,
  },
  viewAll: {
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  viewAllText: {
    fontSize: 13,
    fontFamily: FONT.semibold,
  },
});
