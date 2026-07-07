import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import * as Clipboard from "expo-clipboard";
import React, { useState } from "react";
import { ActivityIndicator, Alert, Linking, Platform, Pressable, StyleSheet, Text, View, Modal, ScrollView } from "react-native";

import {
  getGetAiCopilotPanelQueryKey,
  useDismissAiCopilotOutput,
  useGenerateAiCopilotOutput,
  useGetAiCopilotPanel,
  useUseAiCopilotOutput,
  type AiCopilotOutput,
} from "@workspace/api-client-react";

import { FONT } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";

type EntityType = "lead" | "contact" | "organization";

interface Props {
  entityType: EntityType;
  id: number;
}

const APPLICABLE_OUTPUT_TYPES: Record<EntityType, string[]> = {
  lead: ["email", "whatsapp", "call_prep", "meeting_prep", "proposal", "followup", "coaching", "summary"],
  contact: ["email", "whatsapp", "call_prep", "meeting_prep", "proposal", "followup", "coaching", "summary"],
  organization: ["email", "meeting_prep", "proposal", "summary"],
};

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

export function CopilotSection({ entityType, id }: Props) {
  const colors = useColors();
  const { t, textAlign, language } = useLocale();

  const [typeModalVisible, setTypeModalVisible] = useState(false);

  const { data, isLoading } = useGetAiCopilotPanel(entityType, id, {
    query: { enabled: id > 0, queryKey: getGetAiCopilotPanelQueryKey(entityType, id) },
  });
  
  const generate = useGenerateAiCopilotOutput();
  const markUsed = useUseAiCopilotOutput();
  const dismiss = useDismissAiCopilotOutput();

  const outputs = data?.outputs ?? [];
  const suggestedAction = (data?.suggestedAction ?? null) as Record<string, unknown> | null;
  const coachingSignals = (data?.coachingSignals ?? []) as Record<string, unknown>[];
  const acting = markUsed.isPending || dismiss.isPending;

  const success = () => {
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
  };

  const handleGenerate = (outputType: string) => {
    setTypeModalVisible(false);
    generate.mutate(
      { entityType, id, outputType, data: { language } },
      {
        onSuccess: success,
        onError: () => Alert.alert(t("copilot.title"), t("copilot.generateFailed")),
      },
    );
  };

  const handleUse = (outputId: number) => {
    markUsed.mutate(
      { id: outputId },
      { onSuccess: success, onError: () => Alert.alert(t("copilot.title"), t("copilot.actionFailed")) },
    );
  };

  const handleDismiss = (outputId: number) => {
    dismiss.mutate(
      { id: outputId },
      { onSuccess: success, onError: () => Alert.alert(t("copilot.title"), t("copilot.actionFailed")) },
    );
  };

  const handleCopy = async (text: string) => {
    await Clipboard.setStringAsync(text);
    success();
    Alert.alert(t("copilot.title"), t("copilot.copied"));
  };

  const openHandoff = async (url: string) => {
    try {
      await Linking.openURL(url);
      success();
    } catch {
      Alert.alert(t("copilot.title"), t("copilot.actionFailed"));
    }
  };

  const handleEmail = (subject: string, body: string) => {
    const params = [
      subject ? `subject=${encodeURIComponent(subject)}` : "",
      body ? `body=${encodeURIComponent(body)}` : "",
    ].filter(Boolean).join("&");
    openHandoff(params ? `mailto:?${params}` : "mailto:");
  };

  const handleWhatsapp = (message: string) => {
    openHandoff(`https://wa.me/?text=${encodeURIComponent(message)}`);
  };

  const typeLabel = (type: string) =>
    t(`copilot.outputTypes.${type}`, { defaultValue: humanizeKey(type) });

  const renderValue = (value: unknown, keyPrefix: string, isMessage = false) => {
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
      return Object.entries(value as Record<string, unknown>).map(([k, v]) => {
        const isMsg = k === "draftMessage" || k === "body" || k === "message";
        return (
          <View key={`${keyPrefix}-${k}`} style={{ marginTop: 4 }}>
            <Text style={[styles.valueText, { color: colors.foreground, textAlign }]}>
              <Text style={{ color: colors.mutedForeground }}>{humanizeKey(k)}: </Text>
              {!isMsg ? scalar(v) : null}
            </Text>
            {isMsg && typeof v === "string" ? (
              <View style={[styles.messageBox, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                <Text style={[styles.valueText, { color: colors.foreground, textAlign }]}>{v}</Text>
                <Pressable onPress={() => handleCopy(v)} style={styles.copyBtn}>
                  <Feather name="copy" size={14} color={colors.primary} />
                  <Text style={[styles.copyBtnText, { color: colors.primary }]}>{t("copilot.copy")}</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        );
      });
    }
    
    if (isMessage && typeof value === "string") {
      return (
        <View style={[styles.messageBox, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <Text style={[styles.valueText, { color: colors.foreground, textAlign }]}>{value}</Text>
          <Pressable onPress={() => handleCopy(value)} style={styles.copyBtn}>
            <Feather name="copy" size={14} color={colors.primary} />
            <Text style={[styles.copyBtnText, { color: colors.primary }]}>{t("copilot.copy")}</Text>
          </Pressable>
        </View>
      );
    }
    
    return <Text style={[styles.valueText, { color: colors.foreground, textAlign }]}>{scalar(value)}</Text>;
  };

  const renderOutput = (output: AiCopilotOutput) => {
    const isDeterministic = output.source === "deterministic";
    const dataToRender = output.editedContent || output.content;
    const hasUnavailable = (dataToRender as any)?.unavailable === true;
    
    const dataEntries = hasUnavailable ? [] : Object.entries(dataToRender ?? {}).filter(([, v]) => v !== null && v !== undefined);

    const emailSubject = typeof (dataToRender as any)?.subject === "string" ? (dataToRender as any).subject : "";
    const emailBody = typeof (dataToRender as any)?.body === "string" ? (dataToRender as any).body : "";
    const waMessage =
      typeof (dataToRender as any)?.draftMessage === "string"
        ? (dataToRender as any).draftMessage
        : typeof (dataToRender as any)?.message === "string"
          ? (dataToRender as any).message
          : "";
    const canEmail = output.outputType === "email" && !hasUnavailable && (emailSubject || emailBody);
    const canWhatsapp = output.outputType === "whatsapp" && !hasUnavailable && !!waMessage;
    const canAct = output.status === "generated" || output.status === "edited";
    
    const confColor =
      output.confidence == null
        ? colors.mutedForeground
        : output.confidence >= 80
          ? colors.success
          : output.confidence >= 60
            ? colors.warning
            : colors.destructive;

    return (
      <View key={output.id} style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
        <View style={styles.cardHeader}>
          <Text style={[styles.cardTitle, { color: colors.foreground, textAlign }]}>{typeLabel(output.outputType)}</Text>
          <View style={[styles.tag, { backgroundColor: colors.muted }]}>
            <Feather name={isDeterministic ? "shield" : "cpu"} size={11} color={colors.mutedForeground} />
            <Text style={[styles.tagText, { color: colors.mutedForeground }]}>
              {isDeterministic ? t("copilot.ruleBased") : t("copilot.ai")}
            </Text>
          </View>
        </View>

        <View style={styles.metaRow}>
          <Text style={[styles.confidence, { color: confColor }]}>
            {output.confidence == null
              ? t("copilot.confidenceNa")
              : t("copilot.confidence", { value: output.confidence })}
          </Text>
          <Text style={[styles.statusText, { color: output.status === "used" ? colors.success : colors.mutedForeground }]}>
            {t(`copilot.${output.status}`, { defaultValue: humanizeKey(output.status) })}
          </Text>
        </View>

        {output.reasoning ? (
          <Text style={[styles.reasoning, { color: colors.foreground, textAlign }]}>{output.reasoning}</Text>
        ) : null}

        {hasUnavailable ? (
           <View style={styles.dataBlock}>
             <Text style={[styles.valueText, { color: colors.foreground, textAlign }]}>{t("copilot.unavailable")}</Text>
           </View>
        ) : dataEntries.map(([key, value]) => {
          const isMsg = key === "draftMessage" || key === "body" || key === "message";
          return (
            <View key={key} style={styles.dataBlock}>
              <Text style={[styles.dataLabel, { color: colors.mutedForeground, textAlign }]}>{humanizeKey(key)}</Text>
              {renderValue(value, key, isMsg)}
            </View>
          );
        })}

        <Text style={[styles.footer, { color: colors.mutedForeground, textAlign }]}>
          {t("copilot.generatedAt", { when: formatTs(output.generatedAt) })}
          {!isDeterministic && output.model ? ` · ${t("copilot.model", { model: output.model })}` : ""}
          {output.promptVersion != null ? ` · ${t("copilot.promptVersion", { version: output.promptVersion })}` : ""}
        </Text>

        {canEmail || canWhatsapp ? (
          <View style={styles.actions}>
            {canEmail ? (
              <Pressable
                onPress={() => handleEmail(emailSubject, emailBody)}
                style={[styles.actionBtn, styles.dismissBtn, { borderColor: colors.border }]}
              >
                <Feather name="mail" size={14} color={colors.foreground} />
                <Text style={[styles.actionText, { color: colors.foreground }]}>{t("copilot.openEmail")}</Text>
              </Pressable>
            ) : null}
            {canWhatsapp ? (
              <Pressable
                onPress={() => handleWhatsapp(waMessage)}
                style={[styles.actionBtn, styles.dismissBtn, { borderColor: colors.border }]}
              >
                <Feather name="message-circle" size={14} color={colors.foreground} />
                <Text style={[styles.actionText, { color: colors.foreground }]}>{t("copilot.sendWhatsapp")}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {canAct ? (
          <View style={styles.actions}>
            <Pressable
              onPress={() => handleUse(output.id)}
              disabled={acting}
              style={[styles.actionBtn, { backgroundColor: colors.primary, opacity: acting ? 0.6 : 1 }]}
            >
              <Feather name="check" size={14} color={colors.primaryForeground} />
              <Text style={[styles.actionText, { color: colors.primaryForeground }]}>{t("copilot.use")}</Text>
            </Pressable>
            <Pressable
              onPress={() => handleDismiss(output.id)}
              disabled={acting}
              style={[styles.actionBtn, styles.dismissBtn, { borderColor: colors.border, opacity: acting ? 0.6 : 1 }]}
            >
              <Feather name="x" size={14} color={colors.foreground} />
              <Text style={[styles.actionText, { color: colors.foreground }]}>{t("copilot.dismiss")}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };

  const types = APPLICABLE_OUTPUT_TYPES[entityType] || [];

  return (
    <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Feather name="compass" size={14} color={colors.primary} />
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
            {t("copilot.title").toUpperCase()}
          </Text>
        </View>
        <Pressable
          onPress={() => setTypeModalVisible(true)}
          disabled={generate.isPending}
          style={[styles.analyzeBtn, { borderColor: colors.border }]}
        >
          {generate.isPending ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Feather name="plus" size={13} color={colors.primary} />
          )}
          <Text style={[styles.analyzeText, { color: colors.primary }]}>
            {generate.isPending ? t("copilot.generating") : t("copilot.generate")}
          </Text>
        </Pressable>
      </View>
      
      <Text style={[styles.disclaimerText, { color: colors.mutedForeground, textAlign }]}>
        {t("copilot.disclaimer")}
      </Text>

      {suggestedAction ? (
        <View style={[styles.panelBlock, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <View style={styles.panelHeaderRow}>
            <Feather name="compass" size={13} color={colors.primary} />
            <Text style={[styles.panelHeader, { color: colors.primary }]}>{t("copilot.suggestedAction")}</Text>
          </View>
          <Text style={[styles.valueText, { color: colors.foreground, textAlign }]}>
            {scalar(suggestedAction.basis)}
          </Text>
        </View>
      ) : null}

      {coachingSignals.length > 0 ? (
        <View style={[styles.panelBlock, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <View style={styles.panelHeaderRow}>
            <Feather name="alert-triangle" size={13} color={colors.warning} />
            <Text style={[styles.panelHeader, { color: colors.warning }]}>{t("copilot.coachingSignals")}</Text>
          </View>
          {coachingSignals.map((s, i) => (
            <Text key={i} style={[styles.valueText, { color: colors.foreground, textAlign }]}>
              • {scalar(s.detail ?? s.type)}
            </Text>
          ))}
        </View>
      ) : null}

      {isLoading ? (
        <Text style={[styles.empty, { color: colors.mutedForeground, textAlign }]}>{t("copilot.loading")}</Text>
      ) : outputs.length === 0 ? (
        <Text style={[styles.empty, { color: colors.mutedForeground, textAlign }]}>{t("copilot.empty")}</Text>
      ) : (
        outputs.map(renderOutput)
      )}

      {/* Output Type Picker Modal */}
      <Modal
        visible={typeModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setTypeModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.card }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>{t("copilot.pickType")}</Text>
              <Pressable onPress={() => setTypeModalVisible(false)} hitSlop={10}>
                <Feather name="x" size={20} color={colors.mutedForeground} />
              </Pressable>
            </View>
            <ScrollView style={styles.modalScroll}>
              {types.map((type) => (
                <Pressable
                  key={type}
                  style={({ pressed }) => [
                    styles.typeItem,
                    { borderBottomColor: colors.border, backgroundColor: pressed ? colors.muted : "transparent" },
                  ]}
                  onPress={() => handleGenerate(type)}
                >
                  <Text style={[styles.typeItemText, { color: colors.foreground }]}>{typeLabel(type)}</Text>
                  <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
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
  disclaimerText: { fontSize: 13, fontFamily: FONT.regular, fontStyle: "italic", marginBottom: 4, opacity: 0.8 },
  panelBlock: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 8, gap: 6 },
  panelHeaderRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 2 },
  panelHeader: { fontSize: 13, fontFamily: FONT.bold, textTransform: "uppercase", letterSpacing: 0.4 },
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
  messageBox: { borderWidth: 1, borderRadius: 8, padding: 12, marginTop: 4, gap: 8 },
  copyBtn: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-end", marginTop: 4 },
  copyBtnText: { fontSize: 12, fontFamily: FONT.medium },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  modalContent: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 20, maxHeight: "70%" },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  modalTitle: { fontSize: 18, fontFamily: FONT.semibold },
  modalScroll: { flexGrow: 0 },
  typeItem: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  typeItemText: { fontSize: 15, fontFamily: FONT.medium },
});

export default CopilotSection;
