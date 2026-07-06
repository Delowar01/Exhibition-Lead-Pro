import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import React from "react";
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import {
  getGetAiWorkflowRecommendationsQueryKey,
  getGetAiWorkflowOverviewQueryKey,
  useAcceptAiWorkflowRecommendation,
  useAnalyzeAiWorkflowEntity,
  useDismissAiWorkflowRecommendation,
  useGetAiWorkflowRecommendations,
  type AiWorkflowRecommendation,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

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

export function WorkflowSection({ entityType, id }: Props) {
  const colors = useColors();
  const { t, textAlign, language } = useLocale();
  const queryClient = useQueryClient();

  const { data, isLoading } = useGetAiWorkflowRecommendations(entityType, id, {
    query: { enabled: id > 0, queryKey: getGetAiWorkflowRecommendationsQueryKey(entityType, id) },
  });

  const analyze = useAnalyzeAiWorkflowEntity();
  const accept = useAcceptAiWorkflowRecommendation();
  const dismiss = useDismissAiWorkflowRecommendation();

  const recommendations = data?.recommendations ?? [];
  const acting = analyze.isPending || accept.isPending || dismiss.isPending;

  const success = () => {
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetAiWorkflowRecommendationsQueryKey(entityType, id) });
    queryClient.invalidateQueries({ queryKey: getGetAiWorkflowOverviewQueryKey() });
  };

  const handleAnalyze = () => {
    analyze.mutate(
      { entityType, id, data: { language } },
      {
        onSuccess: () => {
          invalidate();
          success();
        },
        onError: () => Alert.alert(t("workflow.title"), t("workflow.analyzeFailed")),
      },
    );
  };

  const handleAccept = (recId: number) => {
    accept.mutate(
      { id: recId },
      {
        onSuccess: () => {
          invalidate();
          success();
        },
        onError: () => Alert.alert(t("workflow.title"), t("workflow.actionFailed")),
      },
    );
  };

  const handleDismiss = (recId: number) => {
    dismiss.mutate(
      { id: recId },
      {
        onSuccess: () => {
          invalidate();
          success();
        },
        onError: () => Alert.alert(t("workflow.title"), t("workflow.actionFailed")),
      },
    );
  };

  const typeLabel = (type: string) =>
    t(`workflow.types.${type}`, { defaultValue: humanizeKey(type) });

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

  const renderRec = (rec: AiWorkflowRecommendation) => {
    const isDeterministic = rec.source === "deterministic";
    const recData = (rec.data ?? {}) as Record<string, unknown>;
    const entries = Object.entries(recData).filter(([, v]) => v !== null && v !== undefined);
    const canAct = rec.status === "suggested";

    const confColor =
      rec.confidence == null
        ? colors.mutedForeground
        : rec.confidence >= 80
          ? "#059669"
          : rec.confidence >= 60
            ? "#d97706"
            : "#e11d48";

    return (
      <View key={rec.id} style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
        <View style={styles.cardHeader}>
          <Text style={[styles.cardTitle, { color: colors.foreground, textAlign }]}>{typeLabel(rec.recommendationType)}</Text>
          <View style={[styles.tag, { backgroundColor: colors.muted }]}>
            <Feather name={isDeterministic ? "shield" : "cpu"} size={11} color={colors.mutedForeground} />
            <Text style={[styles.tagText, { color: colors.mutedForeground }]}>
              {isDeterministic ? t("workflow.ruleBased") : t("workflow.ai")}
            </Text>
          </View>
        </View>

        <View style={styles.metaRow}>
          <Text style={[styles.confidence, { color: confColor }]}>
            {rec.confidence == null
              ? t("workflow.confidenceNa")
              : t("workflow.confidence", { value: rec.confidence })}
          </Text>
          <Text
            style={[
              styles.statusText,
              { color: rec.status === "accepted" ? "#059669" : colors.mutedForeground },
            ]}
          >
            {t(`workflow.${rec.status}`, { defaultValue: humanizeKey(rec.status) })}
          </Text>
        </View>

        {rec.reasoning ? (
          <Text style={[styles.reasoning, { color: colors.foreground, textAlign }]}>{rec.reasoning}</Text>
        ) : null}

        {entries.map(([key, value]) => (
          <View key={key} style={styles.dataBlock}>
            <Text style={[styles.dataLabel, { color: colors.mutedForeground, textAlign }]}>{humanizeKey(key)}</Text>
            {renderValue(value, key)}
          </View>
        ))}

        <Text style={[styles.footer, { color: colors.mutedForeground, textAlign }]}>
          {t("workflow.generatedAt", { when: formatTs(rec.generatedAt) })}
          {!isDeterministic && rec.model ? ` · ${t("workflow.model", { model: rec.model })}` : ""}
          {rec.promptVersion != null ? ` · ${t("workflow.promptVersion", { version: rec.promptVersion })}` : ""}
          {rec.acceptedAt ? ` · ${t("workflow.acceptedAt", { when: formatTs(rec.acceptedAt) })}` : ""}
        </Text>

        {canAct ? (
          <View style={styles.actions}>
            <Pressable
              onPress={() => handleAccept(rec.id)}
              disabled={acting}
              style={[styles.actionBtn, { backgroundColor: colors.primary, opacity: acting ? 0.6 : 1 }]}
            >
              <Feather name="check" size={14} color={colors.primaryForeground} />
              <Text style={[styles.actionText, { color: colors.primaryForeground }]}>{t("workflow.accept")}</Text>
            </Pressable>
            <Pressable
              onPress={() => handleDismiss(rec.id)}
              disabled={acting}
              style={[styles.actionBtn, styles.dismissBtn, { borderColor: colors.border, opacity: acting ? 0.6 : 1 }]}
            >
              <Feather name="x" size={14} color={colors.foreground} />
              <Text style={[styles.actionText, { color: colors.foreground }]}>{t("workflow.dismiss")}</Text>
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
          <Feather name="git-branch" size={14} color={colors.primary} />
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
            {t("workflow.title").toUpperCase()}
          </Text>
        </View>
        <Pressable
          onPress={handleAnalyze}
          disabled={acting}
          style={[styles.analyzeBtn, { borderColor: colors.border }]}
        >
          {analyze.isPending ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Feather name="zap" size={13} color={colors.primary} />
          )}
          <Text style={[styles.analyzeText, { color: colors.primary }]}>
            {analyze.isPending ? t("workflow.analyzing") : t("workflow.analyze")}
          </Text>
        </Pressable>
      </View>

      <Text style={[styles.disclaimerText, { color: colors.mutedForeground, textAlign }]}>
        {t("workflow.disclaimer")}
      </Text>

      {isLoading ? (
        <Text style={[styles.empty, { color: colors.mutedForeground, textAlign }]}>{t("workflow.loading")}</Text>
      ) : recommendations.length === 0 ? (
        <Text style={[styles.empty, { color: colors.mutedForeground, textAlign }]}>{t("workflow.empty")}</Text>
      ) : (
        recommendations.map(renderRec)
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 16, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 6 },
  sectionTitle: { fontSize: 12, fontFamily: FONT.semibold, letterSpacing: 1 },
  analyzeBtn: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  analyzeText: { fontSize: 13, fontFamily: FONT.semibold },
  disclaimerText: { fontSize: 11, fontFamily: FONT.regular, fontStyle: "italic", marginBottom: 4 },
  empty: { fontSize: 13, lineHeight: 19, fontFamily: FONT.regular },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  cardTitle: { flex: 1, fontSize: 14, fontFamily: FONT.semibold },
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

export default WorkflowSection;
