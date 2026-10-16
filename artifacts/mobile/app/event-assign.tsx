import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type Event,
  getGetContactQueryKey,
  getListContactsQueryKey,
  useBulkAssignContactsEvent,
  useListEvents,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

import { EmptyState, ErrorState, FONT, LoadingState } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { chunkContactIds, parseContactIds } from "@/lib/event-assign-model";

// MOBILE-R2 — later event assignment. Opened from the contact detail ("Assign to Event" /
// "Change Event") with one id, or from the contacts list multi-select with many. Writes
// through POST /contacts/bulk-assign-event (tenant-scoped, permission-gated, audited per
// contact on the server). Never touches the capture-time active event.
export default function EventAssignScreen() {
  const colors = useColors();
  const { t, isRTL, textAlign } = useLocale();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ ids?: string | string[]; current?: string }>();
  const contactIds = useMemo(() => parseContactIds(params.ids), [params.ids]);
  const currentEventId = params.current && /^[0-9]+$/.test(String(params.current)) ? Number(params.current) : null;

  const query = useListEvents({ limit: 100 });
  const assign = useBulkAssignContactsEvent();
  const [busy, setBusy] = useState(false);

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);
  const events = query.data?.events ?? [];

  async function choose(eventId: number | null) {
    if (busy || contactIds.length === 0) return;
    if (Platform.OS !== "web") Haptics.selectionAsync();
    setBusy(true);
    try {
      let updated = 0;
      for (const chunk of chunkContactIds(contactIds)) {
        const r = await assign.mutateAsync({ data: { contactIds: chunk, eventId } });
        updated += r.updated;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListContactsQueryKey() }),
        ...contactIds.map((id) => queryClient.invalidateQueries({ queryKey: getGetContactQueryKey(id) })),
      ]);
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
      Alert.alert(t("contacts.eventAssignedTitle"), t("contacts.eventAssignedBody", { updated }));
    } catch {
      Alert.alert(t("contacts.updateFailedTitle"), t("contacts.eventAssignFailedBody"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 12, paddingHorizontal: 20 }}>
        <Pressable onPress={() => router.back()} hitSlop={10} style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="chevron-left" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.heading, { color: colors.foreground, textAlign }]}>{t("contacts.eventAssignTitle")}</Text>
        <Text style={[styles.headingSub, { color: colors.mutedForeground, textAlign }]}>
          {t("contacts.eventAssignSub", { count: contactIds.length })}
        </Text>
      </View>

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40, gap: 10 }} showsVerticalScrollIndicator={false}>
          <Pressable
            onPress={() => choose(null)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ selected: currentEventId === null, disabled: busy }}
            style={({ pressed }) => [
              styles.eventRow,
              { backgroundColor: colors.card, borderColor: currentEventId === null ? colors.primary : colors.border, borderRadius: colors.radius + 4, opacity: pressed || busy ? 0.7 : 1, flexDirection: isRTL ? "row-reverse" : "row" },
            ]}
          >
            <View style={[styles.eventIcon, { backgroundColor: colors.muted }]}>
              <Feather name="x-circle" size={18} color={colors.mutedForeground} />
            </View>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={[styles.eventName, { color: colors.foreground, textAlign }]}>{t("contacts.eventAssignNone")}</Text>
              <Text numberOfLines={1} style={[styles.eventMeta, { color: colors.mutedForeground, textAlign }]}>{t("contacts.eventAssignNoneSub")}</Text>
            </View>
            {currentEventId === null ? <Feather name="check-circle" size={20} color={colors.primary} /> : null}
          </Pressable>

          {events.length === 0 ? (
            <View style={{ paddingTop: 40 }}>
              <EmptyState icon="calendar" title={t("events.empty")} subtitle={t("events.createFirstDesc")} />
            </View>
          ) : (
            events.map((ev: Event) => {
              const active = ev.id === currentEventId;
              return (
                <Pressable
                  key={ev.id}
                  onPress={() => choose(ev.id)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active, disabled: busy }}
                  style={({ pressed }) => [
                    styles.eventRow,
                    { backgroundColor: colors.card, borderColor: active ? colors.primary : colors.border, borderRadius: colors.radius + 4, opacity: pressed || busy ? 0.7 : 1, flexDirection: isRTL ? "row-reverse" : "row" },
                  ]}
                >
                  <View style={[styles.eventIcon, { backgroundColor: colors.accent }]}>
                    <Feather name="calendar" size={18} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={[styles.eventName, { color: colors.foreground, textAlign }]}>{ev.name}</Text>
                    {ev.venue || ev.country ? (
                      <Text numberOfLines={1} style={[styles.eventMeta, { color: colors.mutedForeground, textAlign }]}>
                        {[ev.venue, ev.country].filter(Boolean).join(" · ")}
                      </Text>
                    ) : null}
                  </View>
                  {active ? <Feather name="check-circle" size={20} color={colors.primary} /> : <Feather name="chevron-right" size={20} color={colors.mutedForeground} />}
                </Pressable>
              );
            })
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  backBtn: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, alignItems: "center", justifyContent: "center", marginBottom: 12 },
  heading: { fontSize: 28, fontFamily: FONT.bold },
  headingSub: { fontSize: 14, fontFamily: FONT.regular, marginTop: 2 },
  eventRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderWidth: 1 },
  eventIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  eventName: { fontSize: 15.5, fontFamily: FONT.semibold },
  eventMeta: { fontSize: 13, fontFamily: FONT.regular, marginTop: 2 },
});
