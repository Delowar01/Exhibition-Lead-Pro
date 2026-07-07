import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import React from "react";
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import {
  getGetAiInsightsQueryKey,
  useAcceptAiInsight,
  useAnalyzeAiInsights,
  useDismissAiInsight,
  useGetAiInsights,
  type AiInsight,
} from "@workspace/api-client-react";

import { FONT } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";

type EntityType = "lead" | "contact" | "organization";

interface Props {
  entityType: EntityType;
  id: number;
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatTs(ts?: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleDateString();
}

function scalar(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function AiInsightsSection({ entityType, id }: Props) {
  const colors = useColors();
  const { t, textAlign } = useLocale();

  const { data, isLoading } = useGetAiInsights(entityType, id, {
    query: { enabled: id > 0, queryKey: getGetAiInsightsQueryKey(entityType, id) },
  });
  const analyze = useAnalyzeAiInsights();
  const accept = useAcceptAiInsight();
  const dismiss = useDismissAiInsight();

  const insights = data?.insights ?? [];
  const acting = accept.isPending || dismiss.isPending;

  const success = () => {
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
  };

  const handleAnalyze = () => {
    analyze.mutate(
      { entityType, id },
      {
        onSuccess: (res) => {
          const errs = res.aiErrors ?? [];
          if (errs.length > 0) {
            Alert.alert(t("aiInsights.title"), t("aiInsights.analysisWarnings", { count: errs.length }));
          } else {
            success();
          }
        },
        onError: () => Alert.alert(t("aiInsights.title"), t("aiInsights.analysisFailed")),
      },
    );
  };

  const handleAccept = (insightId: number) => {
    accept.mutate(
      { id: insightId },
      { onSuccess: success, onError: () => Alert.alert(t("aiInsights.title"), t("aiInsights.actionFailed")) },
    );
  };

  const handleDismiss = (insightId: number) => {
    dismiss.mutate(
      { id: insightId },
      { onSuccess: success, onError: () => Alert.alert(t("aiInsights.title"), t("aiInsights.actionFailed")) },
    );
  };

  const typeLabel = (type: string) =>
    t(`aiInsights.types.${type}`, { defaultValue: humanizeKey(type) });

  const renderValue = (value: unknown, keyPrefix: string) => {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return <Text style={[styles.valueText, { color: colors.mutedForeground, textAlign }]}>—</Text>;
      }
      return value.map((item, i) => (
        <View key={`${keyPrefix}-${i}`} style={styles.bulletRow}>
          <View style={[styles.bulletDot, { backgroundColor: colors.primary }]} />
          {item !== null && typeof item === "object" ? (
            <View style={styles.flex1}>
              {Object.entries(item as Record<string, unknown>).map(([k, v]) => (
                <Text key={k} style={[styles.valueText, { color: colors.foreground, textAlign }]}>
                  <Text style={{ color: colors.mutedForeground }}>{humanizeKey(k)}: </Text>
                  {scalar(v)}
                </Text>
              ))}
            </View>
          ) : (
            <Text style={[styles.valueText, { color: colors.foreground, textAlign }]}>{scalar(item)}</Text>
          )}
        </View>
      ));
    }
    if (value !== null && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>).map(([k, v]) => (
        <Text key={`${keyPrefix}-${k}`} style={[styles.valueText, { color: colors.foreground, textAlign }]}>
          <Text style={{ color: colors.mutedForeground }}>{humanizeKey(k)}: </Text>
          {scalar(v)}
        </Text>
      ));
    }
    return <Text style={[styles.valueText, { color: colors.foreground, textAlign }]}>{scalar(value)}</Text>;
  };

  const renderInsight = (insight: AiInsight) => {
    const isDeterministic = insight.source === "deterministic";
    const dataEntries = Object.entries(insight.data ?? {}).filter(([, v]) => v !== null && v !== undefined);
    const confColor =
      insight.confidence == null
        ? colors.mutedForeground
        : insight.confidence >= 80
          ? "#059669"
          : insight.confidence >= 60
            ? "#d97706"
            : "#e11d48";

    return (
      <View key={insight.id} style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
        <View style={styles.cardHeader}>
          <Text style={[styles.cardTitle, { color: colors.foreground, textAlign }]}>{typeLabel(insight.insightType)}</Text>
          <View style={[styles.tag, { backgroundColor: colors.muted }]}>
            <Feather name={isDeterministic ? "shield" : "cpu"} size={11} color={colors.mutedForeground} />
            <Text style={[styles.tagText, { color: colors.mutedForeground }]}>
              {isDeterministic ? t("aiInsights.ruleBased") : t("aiInsights.ai")}
            </Text>
          </View>
        </View>

        <View style={styles.metaRow}>
          <Text style={[styles.confidence, { color: confColor }]}>
            {insight.confidence == null
              ? t("aiInsights.confidenceNa")
              : t("aiInsights.confidence", { value: insight.confidence })}
          </Text>
          {insight.status !== "suggested" ? (
            <Text style={[styles.statusText, { color: insight.status === "accepted" ? "#059669" : colors.mutedForeground }]}>
              {t(`aiInsights.${insight.status}`)}
            </Text>
          ) : null}
        </View>

        {insight.reasoning ? (
          <Text style={[styles.reasoning, { color: colors.foreground, textAlign }]}>{insight.reasoning}</Text>
        ) : null}

        {dataEntries.map(([key, value]) => (
          <View key={key} style={styles.dataBlock}>
            <Text style={[styles.dataLabel, { color: colors.mutedForeground, textAlign }]}>{humanizeKey(key)}</Text>
            {renderValue(value, key)}
          </View>
        ))}

        <Text style={[styles.footer, { color: colors.mutedForeground, textAlign }]}>
          {t("aiInsights.analyzedAt", { when: formatTs(insight.lastAnalysisAt ?? insight.generatedAt) })}
          {!isDeterministic && insight.model ? ` · ${t("aiInsights.model", { model: insight.model })}` : ""}
          {insight.promptVersion != null ? ` · ${t("aiInsights.promptVersion", { version: insight.promptVersion })}` : ""}
        </Text>

        {insight.status === "suggested" ? (
          <View style={styles.actions}>
            <Pressable
              onPress={() => handleAccept(insight.id)}
              disabled={acting}
              style={[styles.actionBtn, { backgroundColor: colors.primary, opacity: acting ? 0.6 : 1 }]}
            >
              <Feather name="check" size={14} color={colors.primaryForeground} />
              <Text style={[styles.actionText, { color: colors.primaryForeground }]}>{t("aiInsights.accept")}</Text>
            </Pressable>
            <Pressable
              onPress={() => handleDismiss(insight.id)}
              disabled={acting}
              style={[styles.actionBtn, styles.dismissBtn, { borderColor: colors.border, opacity: acting ? 0.6 : 1 }]}
            >
              <Feather name="x" size={14} color={colors.foreground} />
              <Text style={[styles.actionText, { color: colors.foreground }]}>{t("aiInsights.dismiss")}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Feather name="zap" size={14} color={colors.primary} />
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
            {t("aiInsights.title").toUpperCase()}
          </Text>
        </View>
        <Pressable
          onPress={handleAnalyze}
          disabled={analyze.isPending}
          style={[styles.analyzeBtn, { borderColor: colors.border }]}
        >
          {analyze.isPending ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Feather name="refresh-cw" size={13} color={colors.primary} />
          )}
          <Text style={[styles.analyzeText, { color: colors.primary }]}>
            {insights.length > 0 ? t("aiInsights.reanalyze") : t("aiInsights.analyze")}
          </Text>
        </Pressable>
      </View>

      {isLoading ? (
        <Text style={[styles.empty, { color: colors.mutedForeground, textAlign }]}>{t("aiInsights.loading")}</Text>
      ) : insights.length === 0 ? (
        <Text style={[styles.empty, { color: colors.mutedForeground, textAlign }]}>{t("aiInsights.empty")}</Text>
      ) : (
        insights.map(renderInsight)
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { borderRadius: 16, padding: 16, marginBottom: 16, gap: 16, overflow: "hidden" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionTitle: { fontSize: 14, fontFamily: FONT.bold, letterSpacing: 0.5 },
  analyzeBtn: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },
  analyzeText: { fontSize: 13, fontFamily: FONT.semibold },
  empty: { fontSize: 14, lineHeight: 20, fontFamily: FONT.regular, fontStyle: "italic", opacity: 0.8 },
  card: { borderRadius: 16, padding: 16, gap: 12, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  cardTitle: { flex: 1, fontSize: 16, fontFamily: FONT.bold },
  tag: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  tagText: { fontSize: 10, fontFamily: FONT.medium },
  metaRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  confidence: { fontSize: 12, fontFamily: FONT.semibold },
  statusText: { fontSize: 12, fontFamily: FONT.semibold, textTransform: "capitalize" },
  reasoning: { fontSize: 13, lineHeight: 19, fontFamily: FONT.regular },
  dataBlock: { gap: 2 },
  dataLabel: { fontSize: 11, fontFamily: FONT.semibold, letterSpacing: 0.5, textTransform: "uppercase" },
  valueText: { fontSize: 13, lineHeight: 19, fontFamily: FONT.regular },
  bulletRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 1 },
  bulletDot: { width: 4, height: 4, borderRadius: 2, marginTop: 8 },
  flex1: { flex: 1 },
  footer: { fontSize: 11, fontFamily: FONT.regular, paddingTop: 4 },
  actions: { flexDirection: "row", gap: 8, paddingTop: 2 },
  actionBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 14, flex: 1 },
  dismissBtn: { borderWidth: 1, backgroundColor: "transparent" },
  actionText: { fontSize: 13, fontFamily: FONT.semibold },
});

export default AiInsightsSection;
