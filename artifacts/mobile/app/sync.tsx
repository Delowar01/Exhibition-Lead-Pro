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
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Card, EmptyState, FONT, PrimaryButton } from "@/components/ui";
import { useOffline } from "@/contexts/OfflineContext";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import type { Locale } from "@/hooks/useLocale";
import type { QueueItem } from "@/lib/offline-queue";
import { incidentNeedsAttention } from "@/lib/offline-queue-store-model";
import { syncProblemKey } from "@/lib/offline-sync";

function sourceLabel(t: Locale["t"], source: string): string {
  switch (source) {
    case "card":
      return t("capture.businessCard");
    case "qr":
      return t("capture.qrCode");
    case "manual":
      return t("capture.manual");
    case "nfc":
      return t("sync.sourceNfc");
    case "signature":
      return t("scanReview.sourceSignature");
    default:
      // Never show a raw internal source name.
      return t("capture.businessCard");
  }
}

function timeAgo(t: Locale["t"], ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("sync.justNow");
  if (mins < 60) return t("common.minutesAgo", { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t("common.hoursAgo", { count: hrs });
  return t("common.daysAgo", { count: Math.floor(hrs / 24) });
}

export default function SyncScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL, textAlign } = useLocale();
  const {
    isConnected,
    isOnline,
    manualOffline,
    setManualOffline,
    queue,
    pendingCount,
    failedCount,
    conflictCount,
    legacyCount,
    isSyncing,
    lastSyncAt,
    syncNotice,
    storageProblem,
    legacyUnreadable,
    recoveredCount,
    incident,
    discardDamagedCopies,
    syncNow,
    retryItem,
    removeItem,
    resolveConflict,
    discardLegacyItems,
  } = useOffline();

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  // "Needs attention" = what will not go through by itself: a failed item and
  // a capture that matches an existing contact (the user decides).
  const failed = queue.filter((it) => it.status === "failed" || it.status === "conflict");
  const pending = queue.filter((it) => it.status !== "failed" && it.status !== "conflict");
  const canSync = isOnline && queue.length > 0 && !isSyncing;
  const photos = queue.filter((it) => it.kind === "scan" && typeof it.imageBytes === "number");
  const photoMb = photos.reduce((sum, it) => sum + (it.imageBytes ?? 0), 0) / (1024 * 1024);

  // Removing a queued capture cannot be undone: ask first.
  function confirmRemove(item: QueueItem) {
    Alert.alert(t("sync.removeTitle"), t(item.kind === "scan" ? "sync.removeScanBody" : "sync.removeBody"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("sync.removeConfirm"), style: "destructive", onPress: () => removeItem(item.id) },
    ]);
  }

  // The kept original of a damaged list holds what could not be read back:
  // removing it is the user's own decision, and it is asked for first.
  function confirmDiscardDamaged() {
    Alert.alert(t("sync.damagedDiscardTitle"), t("sync.damagedDiscardBody"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("sync.damagedDiscard"), style: "destructive", onPress: () => void discardDamagedCopies() },
    ]);
  }

  function confirmDiscardLegacy() {
    Alert.alert(t("sync.legacyDiscardTitle"), t("sync.legacyDiscardBody"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("sync.legacyItemsDiscard"), style: "destructive", onPress: discardLegacyItems },
    ]);
  }

  function onSyncPress() {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    syncNow();
  }

  function renderRow(item: QueueItem) {
    const isFailed = item.status === "failed";
    const isConflict = item.status === "conflict";
    const isSyncingItem = item.status === "syncing";
    const statusColor = isFailed ? colors.destructive : isSyncingItem || isConflict ? colors.primary : "#F59E0B";
    const statusLabel = isFailed
      ? t("sync.failed")
      : isConflict
        ? t("sync.conflict")
        : isSyncingItem
          ? t("sync.syncing")
          : t("sync.pending");
    const icon: keyof typeof Feather.glyphMap = item.kind === "scan" ? "camera" : "user";
    const title = item.label || (item.recovered ? t("sync.recoveredLabel") : t("contacts.newContact"));
    // Why it is not through yet — in the user's language, never the raw error text.
    const problem = isConflict
      ? t(item.conflict?.afterLostAnswer ? "sync.problem.duplicateMaybeSaved" : "sync.problem.duplicateNamed", {
          name: item.conflict?.name ?? t("sync.problem.duplicateUnnamed"),
        })
      : isFailed || item.errorKind
        ? t(syncProblemKey(item.errorKind))
        : null;
    return (
      <View
        key={item.id}
        style={[styles.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, flexDirection: isRTL ? "row-reverse" : "row" }]}
      >
        <View style={[styles.rowIcon, { backgroundColor: statusColor + "1A" }]}>
          <Feather name={icon} size={17} color={statusColor} />
        </View>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={[styles.rowTitle, { color: colors.foreground, textAlign }]}>
            {title}
          </Text>
          <Text numberOfLines={1} style={[styles.rowSub, { color: colors.mutedForeground, textAlign }]}>
            {sourceLabel(t, item.source)} · {timeAgo(t, item.createdAt)}
            {item.kind === "scan" ? t("sync.needsOcr") : ""}
          </Text>
          {problem ? (
            <Text numberOfLines={3} style={[styles.rowError, { color: isFailed ? colors.destructive : colors.mutedForeground, textAlign }]}>
              {problem}
            </Text>
          ) : null}
          {isConflict && item.conflict ? (
            // A matching contact exists and nothing was created. The decision is the user's.
            <View style={[styles.conflictActions, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              <Pressable
                onPress={() => router.push(`/contact/${item.conflict!.contactId}`)}
                hitSlop={6}
                style={[styles.conflictBtn, { borderColor: colors.border }]}
                testID={`button-conflict-view-${item.id}`}
              >
                <Text style={[styles.conflictBtnText, { color: colors.foreground }]}>{t("sync.conflictView")}</Text>
              </Pressable>
              <Pressable
                onPress={() => resolveConflict(item.id, "add_interaction")}
                hitSlop={6}
                style={[styles.conflictBtn, { borderColor: colors.primary }]}
                testID={`button-conflict-add-${item.id}`}
              >
                <Text style={[styles.conflictBtnText, { color: colors.primary }]}>{t("sync.conflictAdd")}</Text>
              </Pressable>
              <Pressable
                onPress={() => resolveConflict(item.id, "create_separate")}
                hitSlop={6}
                style={[styles.conflictBtn, { borderColor: colors.border }]}
                testID={`button-conflict-separate-${item.id}`}
              >
                <Text style={[styles.conflictBtnText, { color: colors.foreground }]}>{t("sync.conflictSeparate")}</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
        <View style={[styles.rowActions, { alignItems: isRTL ? "flex-start" : "flex-end" }]}>
          <View style={[styles.statusPill, { backgroundColor: statusColor + "1A" }]}>
            <Text style={[styles.statusPillText, { color: statusColor }]}>{statusLabel}</Text>
          </View>
          <View style={{ flexDirection: isRTL ? "row-reverse" : "row", gap: 4 }}>
            {isFailed ? (
              <Pressable
                onPress={() => {
                  retryItem(item.id);
                }}
                hitSlop={8}
                style={styles.iconBtn}
              >
                <Feather name="refresh-cw" size={16} color={colors.primary} />
              </Pressable>
            ) : null}
            {/* While it is being sent it cannot be taken back: removing it would not stop the request. */}
            {isSyncingItem ? null : (
              <Pressable
                onPress={() => confirmRemove(item)}
                hitSlop={8}
                style={styles.iconBtn}
                accessibilityLabel={t("sync.removeConfirm")}
              >
                <Feather name="trash-2" size={16} color={colors.mutedForeground} />
              </Pressable>
            )}
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
          flexGrow: 1,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={[styles.headerRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
            <Feather name="arrow-left" size={22} color={colors.foreground} style={isRTL ? { transform: [{ scaleX: -1 }] } : undefined} />
          </Pressable>
          <Text style={[styles.heading, { color: colors.foreground, textAlign }]}>{t("sync.title")}</Text>
        </View>

        {/* Connection status */}
        <Card style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", gap: 12 }}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: isOnline ? "#22C55E" : colors.destructive },
              ]}
            />
            <View style={{ flex: 1 }}>
              <Text style={[styles.statusTitle, { color: colors.foreground, textAlign }]}>
                {isOnline ? t("sync.online") : t("sync.offline")}
              </Text>
              <Text style={[styles.statusSub, { color: colors.mutedForeground, textAlign }]}>
                {isOnline
                  ? t("sync.onlineDesc")
                  : manualOffline
                    ? t("sync.offlineDesc")
                    : t("sync.offlineAutoDesc")}
              </Text>
            </View>
          </View>
        </Card>

        {/* Work-offline toggle */}
        <Card style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", gap: 12 }}>
            <View style={[styles.toggleIcon, { backgroundColor: "#67707D1A" }]}>
              <Feather name="wifi-off" size={18} color="#67707D" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.toggleTitle, { color: colors.foreground, textAlign }]}>{t("sync.workOffline")}</Text>
              <Text style={[styles.toggleSub, { color: colors.mutedForeground, textAlign }]}>
                {t("sync.workOfflineDesc")}{!isConnected ? t("sync.noConnectionSuffix") : ""}
              </Text>
            </View>
            <Switch
              value={manualOffline}
              onValueChange={(v) => {
                setManualOffline(v);
              }}
              trackColor={{ false: colors.border, true: colors.primary }}
              thumbColor="#FFFFFF"
            />
          </View>
        </Card>

        {/* What the user should know before syncing: storage trouble, a run that could not finish, recovered photos. */}
        {storageProblem !== "none" ? (
          <Card style={{ marginBottom: 12, borderColor: colors.destructive + "60", backgroundColor: colors.destructive + "10" }}>
            <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "flex-start", gap: 10 }}>
              <Feather name="alert-triangle" size={18} color={colors.destructive} />
              <Text style={[styles.noticeText, { color: colors.foreground, textAlign }]} testID="notice-storage-problem">
                {t(
                  storageProblem === "index-unreadable"
                    ? "sync.storageUnreadableBody"
                    : storageProblem === "index-damaged-unsaved"
                      ? "sync.storageDamagedUnsavedBody"
                      : "sync.storageWriteFailedBody",
                )}
              </Text>
            </View>
          </Card>
        ) : null}
        {incidentNeedsAttention(incident) && incident ? (
          <Card style={{ marginBottom: 12, borderColor: colors.destructive + "60", backgroundColor: colors.destructive + "10" }}>
            <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "flex-start", gap: 10 }}>
              <Feather name="alert-triangle" size={18} color={colors.destructive} />
              <View style={{ flex: 1, gap: 6 }} testID="notice-queue-damaged">
                <Text style={[styles.noticeText, { color: colors.foreground, textAlign, fontFamily: "Inter_600SemiBold", flex: 0 }]}>
                  {t("sync.damagedTitle")}
                </Text>
                <Text style={[styles.noticeText, { color: colors.foreground, textAlign, flex: 0 }]}>{t("sync.damagedBody")}</Text>
                <Text style={[styles.noticeText, { color: colors.foreground, textAlign, flex: 0 }]}>
                  {t("sync.damagedRecovered", { count: incident.salvaged })}
                  {"\n"}
                  {incident.unreadable === null ? t("sync.damagedUnreadableUnknown") : t("sync.damagedUnreadable", { count: incident.unreadable })}
                </Text>
                <Text style={[styles.noticeText, { color: colors.foreground, textAlign, flex: 0 }]}>{t("sync.damagedPhotos")}</Text>
                {incident.copies.length > 0 ? (
                  <>
                    <Text style={[styles.noticeText, { color: colors.foreground, textAlign, flex: 0 }]}>{t("sync.damagedCopyKept")}</Text>
                    <Pressable onPress={confirmDiscardDamaged} hitSlop={8} accessibilityRole="button" testID="discard-damaged-copy">
                      <Text style={[styles.noticeText, { color: colors.destructive, textAlign, fontFamily: "Inter_600SemiBold", flex: 0 }]}>
                        {t("sync.damagedDiscard")}
                      </Text>
                    </Pressable>
                  </>
                ) : null}
              </View>
            </View>
          </Card>
        ) : null}
        {syncNotice ? (
          <Card style={{ marginBottom: 12 }}>
            <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "flex-start", gap: 10 }}>
              <Feather name="info" size={18} color={colors.primary} />
              <Text style={[styles.noticeText, { color: colors.foreground, textAlign }]} testID="notice-sync-stopped">
                {t(syncProblemKey(syncNotice))}
              </Text>
            </View>
          </Card>
        ) : null}
        {recoveredCount > 0 ? (
          <Card style={{ marginBottom: 12 }}>
            <Text style={[styles.noticeText, { color: colors.foreground, textAlign }]}>
              {t("sync.recoveredNotice", { count: recoveredCount })}
            </Text>
          </Card>
        ) : null}
        {legacyUnreadable ? (
          <Card style={{ marginBottom: 12 }}>
            <Text style={[styles.noticeText, { color: colors.foreground, textAlign }]}>{t("sync.legacyUnreadableBody")}</Text>
          </Card>
        ) : null}

        {/* Summary + sync */}
        <View style={[styles.summaryRow, { flexDirection: isRTL ? "row-reverse" : "row", marginBottom: 12 }]}>
          <Card style={{ flex: 1, alignItems: "center", paddingVertical: 16 }}>
            <Text style={[styles.summaryNum, { color: colors.foreground }]}>{pendingCount}</Text>
            <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>{t("sync.pending")}</Text>
          </Card>
          <Card style={{ flex: 1, alignItems: "center", paddingVertical: 16 }}>
            <Text
              style={[
                styles.summaryNum,
                { color: failedCount + conflictCount > 0 ? colors.destructive : colors.foreground },
              ]}
            >
              {failedCount + conflictCount}
            </Text>
            <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>{t("sync.needsAttentionShort")}</Text>
          </Card>
        </View>

        <PrimaryButton
          onPress={onSyncPress}
          disabled={!canSync}
          loading={isSyncing}
          icon="refresh-cw"
          label={isSyncing ? t("sync.syncing") : t("sync.syncNow")}
        />
        {lastSyncAt ? (
          <Text style={[styles.lastSync, { color: colors.mutedForeground }]}>
            {t("sync.lastSyncedPrefix")}{timeAgo(t, lastSyncAt)}
          </Text>
        ) : null}
        {photos.length > 0 ? (
          <Text style={[styles.lastSync, { color: colors.mutedForeground }]}>
            {t("sync.photosOnDevice", { count: photos.length, size: photoMb < 0.1 ? "0.1" : photoMb.toFixed(1) })}
          </Text>
        ) : null}

        {/* Items from an older app version carry no account ownership: never shown, never synced; only an explicit discard. */}
        {legacyCount > 0 ? (
          <Card style={{ marginTop: 12 }}>
            <Text style={[styles.statusSub, { color: colors.mutedForeground, textAlign }]}>
              {t("sync.legacyItemsWarning", { count: legacyCount })}
            </Text>
            <Pressable onPress={confirmDiscardLegacy} hitSlop={8} style={{ alignSelf: isRTL ? "flex-end" : "flex-start", marginTop: 8 }}>
              <Text style={[styles.toggleTitle, { color: colors.destructive }]}>{t("sync.legacyItemsDiscard")}</Text>
            </Pressable>
          </Card>
        ) : null}

        {/* Queue (this account's items only) */}
        {queue.length === 0 ? (
          <View style={{ marginTop: 40 }}>
            <EmptyState
              icon="check-circle"
              title={t("sync.allSynced")}
              subtitle={t("sync.emptyDesc")}
            />
          </View>
        ) : (
          <>
            {failed.length > 0 ? (
              <>
                <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
                  {t("sync.needsAttention")}
                </Text>
                <Card padded={false} style={{ overflow: "hidden" }}>
                  {failed.map(renderRow)}
                </Card>
              </>
            ) : null}
            {pending.length > 0 ? (
              <>
                <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
                  {t("sync.queued")}
                </Text>
                <Card padded={false} style={{ overflow: "hidden" }}>
                  {pending.map(renderRow)}
                </Card>
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
  rowError: { fontSize: 11.5, lineHeight: 16, fontFamily: FONT.medium, marginTop: 2 },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 19, fontFamily: FONT.regular },
  conflictActions: { flexWrap: "wrap", gap: 6, marginTop: 8 },
  conflictBtn: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  conflictBtnText: { fontSize: 12, fontFamily: FONT.semibold },
  rowActions: { alignItems: "flex-end", gap: 6 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  statusPillText: { fontSize: 11, fontFamily: FONT.semibold },
  iconBtn: { padding: 5 },
});
