import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState, FONT } from "@/components/ui";
import { useOffline } from "@/contexts/OfflineContext";
import { useColors } from "@/hooks/useColors";
import type { QueueItem } from "@/lib/offline-queue";

const SOURCE_LABEL: Record<string, string> = {
  card: "Business card",
  badge: "Event badge",
  qr: "QR / LinkedIn",
  manual: "Manual entry",
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function SyncScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    isConnected,
    isOnline,
    manualOffline,
    setManualOffline,
    queue,
    pendingCount,
    failedCount,
    isSyncing,
    lastSyncAt,
    syncNow,
    retryItem,
    removeItem,
  } = useOffline();

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  const failed = queue.filter((it) => it.status === "failed");
  const pending = queue.filter((it) => it.status !== "failed");
  const canSync = isOnline && queue.length > 0 && !isSyncing;

  function onSyncPress() {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    syncNow();
  }

  function renderRow(item: QueueItem) {
    const isFailed = item.status === "failed";
    const isSyncingItem = item.status === "syncing";
    const statusColor = isFailed ? colors.destructive : isSyncingItem ? colors.primary : "#F59E0B";
    const statusLabel = isFailed ? "Failed" : isSyncingItem ? "Syncing…" : "Pending";
    const icon: keyof typeof Feather.glyphMap = item.kind === "scan" ? "camera" : "user";
    return (
      <View
        key={item.id}
        style={[styles.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}
      >
        <View style={[styles.rowIcon, { backgroundColor: statusColor + "1A" }]}>
          <Feather name={icon} size={17} color={statusColor} />
        </View>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={[styles.rowTitle, { color: colors.foreground }]}>
            {item.label}
          </Text>
          <Text numberOfLines={1} style={[styles.rowSub, { color: colors.mutedForeground }]}>
            {SOURCE_LABEL[item.source] ?? item.source} · {timeAgo(item.createdAt)}
            {item.kind === "scan" ? " · needs OCR" : ""}
          </Text>
          {isFailed && item.lastError ? (
            <Text numberOfLines={1} style={[styles.rowError, { color: colors.destructive }]}>
              {item.lastError}
            </Text>
          ) : null}
        </View>
        <View style={styles.rowActions}>
          <View style={[styles.statusPill, { backgroundColor: statusColor + "1A" }]}>
            <Text style={[styles.statusPillText, { color: statusColor }]}>{statusLabel}</Text>
          </View>
          <View style={{ flexDirection: "row", gap: 4 }}>
            {isFailed ? (
              <Pressable
                onPress={() => {
                  if (Platform.OS !== "web") Haptics.selectionAsync();
                  retryItem(item.id);
                }}
                hitSlop={8}
                style={styles.iconBtn}
              >
                <Feather name="refresh-cw" size={16} color={colors.primary} />
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => {
                if (Platform.OS !== "web") Haptics.selectionAsync();
                removeItem(item.id);
              }}
              hitSlop={8}
              style={styles.iconBtn}
            >
              <Feather name="trash-2" size={16} color={colors.mutedForeground} />
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: topPad + 14,
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + 40,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.headerRow}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
            <Feather name="arrow-left" size={22} color={colors.foreground} />
          </Pressable>
          <Text style={[styles.heading, { color: colors.foreground }]}>Sync Center</Text>
        </View>

        {/* Connection status */}
        <View
          style={[
            styles.statusCard,
            {
              backgroundColor: isOnline ? colors.primary + "12" : colors.destructive + "12",
              borderRadius: colors.radius + 4,
            },
          ]}
        >
          <View
            style={[
              styles.statusDot,
              { backgroundColor: isOnline ? "#22C55E" : colors.destructive },
            ]}
          />
          <View style={{ flex: 1 }}>
            <Text style={[styles.statusTitle, { color: colors.foreground }]}>
              {isOnline ? "Online" : manualOffline ? "Working offline" : "No connection"}
            </Text>
            <Text style={[styles.statusSub, { color: colors.mutedForeground }]}>
              {isOnline
                ? "Captures save straight to the cloud."
                : manualOffline
                  ? "Captures are queued on this device."
                  : "Captures are queued and sync automatically when you reconnect."}
            </Text>
          </View>
        </View>

        {/* Work-offline toggle */}
        <View
          style={[
            styles.toggleCard,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
          ]}
        >
          <View style={[styles.toggleIcon, { backgroundColor: "#67707D1A" }]}>
            <Feather name="wifi-off" size={18} color="#67707D" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.toggleTitle, { color: colors.foreground }]}>Work offline</Text>
            <Text style={[styles.toggleSub, { color: colors.mutedForeground }]}>
              Queue everything locally{!isConnected ? " (no connection detected)" : ""}
            </Text>
          </View>
          <Switch
            value={manualOffline}
            onValueChange={(v) => {
              if (Platform.OS !== "web") Haptics.selectionAsync();
              setManualOffline(v);
            }}
            trackColor={{ false: colors.border, true: colors.primary }}
            thumbColor="#FFFFFF"
          />
        </View>

        {/* Summary + sync */}
        <View style={styles.summaryRow}>
          <View
            style={[
              styles.summaryCard,
              { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
            ]}
          >
            <Text style={[styles.summaryNum, { color: colors.foreground }]}>{pendingCount}</Text>
            <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Pending</Text>
          </View>
          <View
            style={[
              styles.summaryCard,
              { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
            ]}
          >
            <Text
              style={[
                styles.summaryNum,
                { color: failedCount > 0 ? colors.destructive : colors.foreground },
              ]}
            >
              {failedCount}
            </Text>
            <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>Failed</Text>
          </View>
        </View>

        <Pressable
          onPress={onSyncPress}
          disabled={!canSync}
          style={({ pressed }) => [
            styles.syncBtn,
            {
              backgroundColor: colors.primary,
              borderRadius: colors.radius + 4,
              opacity: !canSync ? 0.5 : pressed ? 0.85 : 1,
            },
          ]}
        >
          <Feather name={isSyncing ? "loader" : "refresh-cw"} size={18} color={colors.primaryForeground} />
          <Text style={[styles.syncBtnText, { color: colors.primaryForeground }]}>
            {isSyncing ? "Syncing…" : "Sync now"}
          </Text>
        </Pressable>
        {lastSyncAt ? (
          <Text style={[styles.lastSync, { color: colors.mutedForeground }]}>
            Last synced {timeAgo(lastSyncAt)}
          </Text>
        ) : null}

        {/* Queue */}
        {queue.length === 0 ? (
          <View style={{ marginTop: 40 }}>
            <EmptyState
              icon="check-circle"
              title="All caught up"
              subtitle="Captures you make offline will appear here, ready to sync."
            />
          </View>
        ) : (
          <>
            {failed.length > 0 ? (
              <>
                <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
                  NEEDS ATTENTION
                </Text>
                <View
                  style={[
                    styles.listCard,
                    { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
                  ]}
                >
                  {failed.map(renderRow)}
                </View>
              </>
            ) : null}
            {pending.length > 0 ? (
              <>
                <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
                  QUEUED
                </Text>
                <View
                  style={[
                    styles.listCard,
                    { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
                  ]}
                >
                  {pending.map(renderRow)}
                </View>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 18 },
  backBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  heading: { fontSize: 26, fontFamily: FONT.bold },
  statusCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
  },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusTitle: { fontSize: 15.5, fontFamily: FONT.semibold },
  statusSub: { fontSize: 12.5, fontFamily: FONT.regular, marginTop: 2 },
  toggleCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderWidth: 1,
    marginTop: 12,
  },
  toggleIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  toggleTitle: { fontSize: 15, fontFamily: FONT.semibold },
  toggleSub: { fontSize: 12.5, fontFamily: FONT.regular, marginTop: 1 },
  summaryRow: { flexDirection: "row", gap: 12, marginTop: 12 },
  summaryCard: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 16,
    borderWidth: 1,
  },
  summaryNum: { fontSize: 26, fontFamily: FONT.bold },
  summaryLabel: { fontSize: 12.5, fontFamily: FONT.medium, marginTop: 2 },
  syncBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 52,
    marginTop: 12,
  },
  syncBtnText: { fontSize: 16, fontFamily: FONT.semibold },
  lastSync: { fontSize: 12.5, fontFamily: FONT.regular, textAlign: "center", marginTop: 10 },
  sectionTitle: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.6,
    marginTop: 26,
    marginBottom: 12,
  },
  listCard: { borderWidth: 1, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { fontSize: 14.5, fontFamily: FONT.semibold },
  rowSub: { fontSize: 12, fontFamily: FONT.regular, marginTop: 1 },
  rowError: { fontSize: 11.5, fontFamily: FONT.medium, marginTop: 2 },
  rowActions: { alignItems: "flex-end", gap: 6 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  statusPillText: { fontSize: 11, fontFamily: FONT.semibold },
  iconBtn: { padding: 5 },
});
