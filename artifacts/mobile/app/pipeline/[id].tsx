import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
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

import {
  getGetLeadQueryKey,
  LeadUpdateStage,
  useDeleteLead,
  useGetLead,
  useUpdateLead,
} from "@workspace/api-client-react";

import {
  Avatar,
  Badge,
  EmptyState,
  ErrorState,
  FONT,
  LEAD_STAGE_COLORS,
  LoadingState,
  prettyLabel,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { formatGregorian } from "@/lib/date";

function formatCurrency(value: number, currency = "USD"): string {
  if (value >= 1_000_000) return `${currency} ${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${currency} ${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`;
  return `${currency} ${Math.round(value)}`;
}

function formatDate(dateStr: string): string {
  try {
    const parts = dateStr.split("-");
    if (parts.length === 3) {
      const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      return formatGregorian(d, { month: "short", day: "numeric", year: "numeric" });
    }
  } catch { /* ignore */ }
  return dateStr;
}

function formatHistoryDate(iso: string): string {
  const d = new Date(iso);
  return formatGregorian(d, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function priorityColor(p: string): string {
  if (p === "high") return "#EF4444";
  if (p === "medium") return "#F59E0B";
  return "#3B82F6";
}

interface InfoRowProps {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value?: string | null;
  valueColor?: string;
}
function InfoRow({ icon, label, value, valueColor }: InfoRowProps) {
  const colors = useColors();
  if (!value) return null;
  return (
    <View style={styles.infoRow}>
      <Feather name={icon} size={16} color={colors.mutedForeground} style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>{label}</Text>
        <Text style={[styles.infoValue, { color: valueColor ?? colors.foreground }]}>{value}</Text>
      </View>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 }]}>
      <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>{title.toUpperCase()}</Text>
      {children}
    </View>
  );
}

export default function PipelineDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t } = useLocale();
  const { id } = useLocalSearchParams<{ id: string }>();
  const leadId = parseInt(id ?? "0");

  const query = useGetLead(leadId, { query: { enabled: leadId > 0, queryKey: getGetLeadQueryKey(leadId) } });
  const updateLead = useUpdateLead();
  const deleteLead = useDeleteLead();

  const lead = query.data;
  const history = (lead as { history?: unknown[] })?.history ?? [];

  async function moveStage(newStage: string) {
    if (!lead) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await updateLead.mutateAsync({ id: lead.id, data: { stage: newStage as LeadUpdateStage } });
      query.refetch();
    } catch {
      Alert.alert(t("pipeline.failedSave"));
    }
  }

  function confirmMarkWon() {
    Alert.alert(t("pipeline.markWon"), t("pipeline.history.changedStage"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("pipeline.markWon"), style: "default", onPress: () => moveStage("won") },
    ]);
  }

  function confirmMarkLost() {
    Alert.alert(t("pipeline.markLost"), t("pipeline.history.changedStage"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("pipeline.markLost"), style: "destructive", onPress: () => moveStage("lost") },
    ]);
  }

  function confirmDelete() {
    if (!lead) return;
    const run = async () => {
      try {
        await deleteLead.mutateAsync({ id: lead.id });
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.back();
      } catch {
        Alert.alert(t("pipeline.deleteFailed"));
      }
    };
    if (Platform.OS === "web") { void run(); return; }
    Alert.alert(t("pipeline.deleteTitle"), t("pipeline.deleteConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.delete"), style: "destructive", onPress: run },
    ]);
  }

  const stageColor = LEAD_STAGE_COLORS[lead?.stage ?? "prospect"] ?? colors.primary;
  const isWonOrLost = lead?.stage === "won" || lead?.stage === "lost";

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: lead?.title ?? t("common.unnamedLead"),
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.foreground,
          headerTitleStyle: { fontFamily: FONT.semibold },
          headerRight: () =>
            lead ? (
              <View style={{ flexDirection: "row", gap: 14 }}>
                <Pressable onPress={() => router.push(`/pipeline/form?id=${lead.id}`)} hitSlop={10}>
                  <Feather name="edit-2" size={19} color={colors.primary} />
                </Pressable>
                <Pressable onPress={confirmDelete} hitSlop={10}>
                  <Feather name="trash-2" size={19} color={colors.destructive} />
                </Pressable>
              </View>
            ) : null,
        }}
      />

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError || !lead ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 60, gap: 16 }}
        >
          {/* Hero card */}
          <View style={[styles.heroCard, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 6 }]}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <Badge
                label={t(`leads.stages.${lead.stage}`, { defaultValue: prettyLabel(lead.stage) })}
                color={stageColor}
              />
              {lead.priority ? (
                <Badge
                  label={t(`pipeline.priority${lead.priority.charAt(0).toUpperCase() + lead.priority.slice(1)}`)}
                  color={priorityColor(lead.priority)}
                />
              ) : null}
            </View>

            {lead.title ? (
              <Text style={[styles.heroTitle, { color: colors.foreground }]}>{lead.title}</Text>
            ) : null}

            {lead.value != null && lead.value > 0 ? (
              <Text style={[styles.heroValue, { color: colors.success }]}>
                {formatCurrency(lead.value, lead.currency ?? "USD")}
              </Text>
            ) : null}

            {typeof lead.probability === "number" ? (
              <View style={{ marginTop: 10 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                  <Text style={[styles.probLabel, { color: colors.mutedForeground }]}>{t("pipeline.probability")}</Text>
                  <Text style={[styles.probLabel, { color: colors.foreground, fontFamily: FONT.semibold }]}>{lead.probability}%</Text>
                </View>
                <View style={[styles.probBar, { backgroundColor: colors.muted }]}>
                  <View style={[styles.probFill, { width: `${lead.probability}%` as `${number}%`, backgroundColor: stageColor }]} />
                </View>
              </View>
            ) : null}
          </View>

          {/* Details */}
          <Section title={t("contacts.sectionDetails")}>
            {lead.contactName ? (
              <View style={[styles.infoRow, { marginBottom: 4 }]}>
                <Avatar name={lead.contactName} size={28} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>{t("pipeline.contact")}</Text>
                  <Text style={[styles.infoValue, { color: colors.foreground }]}>{lead.contactName}</Text>
                  {lead.contactCompany ? (
                    <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>{lead.contactCompany}</Text>
                  ) : null}
                </View>
              </View>
            ) : null}
            <InfoRow icon="user-check" label={t("pipeline.assignedTo")} value={lead.assignedToName ?? t("pipeline.unassigned")} />
            <InfoRow icon="calendar" label={t("pipeline.event")} value={lead.eventName ?? undefined} />
            <InfoRow
              icon="target"
              label={t("pipeline.closeDate")}
              value={lead.closingDate ? formatDate(lead.closingDate) : t("pipeline.noClosingDate")}
            />
            {lead.notes ? <InfoRow icon="file-text" label={t("pipeline.notes")} value={lead.notes} /> : null}
          </Section>

          {/* Actions */}
          {!isWonOrLost ? (
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Pressable
                onPress={confirmMarkWon}
                style={({ pressed }) => [styles.actionBtn, { backgroundColor: "#22C55E" + "1A", borderColor: "#22C55E", opacity: pressed ? 0.7 : 1, flex: 1 }]}
              >
                <Feather name="award" size={16} color="#22C55E" />
                <Text style={[styles.actionBtnText, { color: "#22C55E" }]}>{t("pipeline.markWon")}</Text>
              </Pressable>
              <Pressable
                onPress={confirmMarkLost}
                style={({ pressed }) => [styles.actionBtn, { backgroundColor: colors.destructive + "1A", borderColor: colors.destructive, opacity: pressed ? 0.7 : 1, flex: 1 }]}
              >
                <Feather name="x-circle" size={16} color={colors.destructive} />
                <Text style={[styles.actionBtnText, { color: colors.destructive }]}>{t("pipeline.markLost")}</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={() => moveStage("prospect")}
              style={({ pressed }) => [styles.actionBtn, { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
            >
              <Feather name="refresh-cw" size={16} color={colors.foreground} />
              <Text style={[styles.actionBtnText, { color: colors.foreground }]}>{t("pipeline.reopen")}</Text>
            </Pressable>
          )}

          {/* History */}
          <Section title={t("pipeline.history.title")}>
            {history.length === 0 ? (
              <View style={{ paddingVertical: 16 }}>
                <EmptyState icon="activity" title={t("pipeline.history.empty")} />
              </View>
            ) : (
              (history as Array<{ id: number; fieldName: string; oldValue: string | null; newValue: string | null; changedByName: string | null; changedAt: string }>).map((h, idx) => {
                const fieldLabel = h.fieldName === "stage"
                  ? t("pipeline.history.changedStage")
                  : h.fieldName === "value"
                    ? t("pipeline.history.changedValue")
                    : t("pipeline.history.changedAssigned");
                const oldLabel = h.fieldName === "stage" && h.oldValue
                  ? t(`leads.stages.${h.oldValue}`, { defaultValue: prettyLabel(h.oldValue) })
                  : h.oldValue ?? "—";
                const newLabel = h.fieldName === "stage" && h.newValue
                  ? t(`leads.stages.${h.newValue}`, { defaultValue: prettyLabel(h.newValue) })
                  : h.newValue ?? "—";
                return (
                  <View key={h.id} style={[styles.historyRow, idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}>
                    <View style={[styles.historyDot, { backgroundColor: colors.primary }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.historyField, { color: colors.foreground }]}>
                        {fieldLabel}{" "}
                        <Text style={{ color: colors.mutedForeground, fontFamily: FONT.regular }}>
                          {oldLabel} {t("pipeline.history.to")} {newLabel}
                        </Text>
                      </Text>
                      <Text style={[styles.historyMeta, { color: colors.mutedForeground }]}>
                        {h.changedByName ? `${t("pipeline.history.by")} ${h.changedByName} · ` : ""}
                        {formatHistoryDate(h.changedAt)}
                      </Text>
                    </View>
                  </View>
                );
              })
            )}
          </Section>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  heroCard: {
    padding: 18,
    borderWidth: 1,
  },
  heroTitle: {
    fontSize: 20,
    fontFamily: FONT.bold,
    marginBottom: 4,
  },
  heroValue: {
    fontSize: 26,
    fontFamily: FONT.bold,
    marginBottom: 4,
  },
  probLabel: {
    fontSize: 12,
    fontFamily: FONT.regular,
  },
  probBar: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
  },
  probFill: {
    height: 6,
    borderRadius: 3,
  },
  section: {
    padding: 16,
    borderWidth: 1,
    gap: 12,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: FONT.semibold,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  infoLabel: {
    fontSize: 12,
    fontFamily: FONT.regular,
  },
  infoValue: {
    fontSize: 14,
    fontFamily: FONT.medium,
    marginTop: 1,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  actionBtnText: {
    fontSize: 14,
    fontFamily: FONT.semibold,
  },
  historyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 8,
  },
  historyDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 4,
  },
  historyField: {
    fontSize: 13,
    fontFamily: FONT.semibold,
  },
  historyMeta: {
    fontSize: 12,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
});
