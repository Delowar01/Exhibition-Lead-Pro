import React, { useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { Feather } from "@/components/icons";
import { FONT } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import {
  exportAndShare,
  type ExportEntityType,
  type ExportFormat,
} from "@/lib/export-share";

const FORMATS: { value: ExportFormat; label: string; icon: string }[] = [
  { value: "csv", label: "CSV", icon: "file-text" },
  { value: "excel", label: "Excel", icon: "grid" },
  { value: "json", label: "JSON", icon: "code" },
];

interface Props {
  visible: boolean;
  onClose: () => void;
  entityType: ExportEntityType;
  filters: Record<string, string | number | undefined | null>;
}

export function ExportSheet({ visible, onClose, entityType, filters }: Props) {
  const colors = useColors();
  const { t, isRTL } = useLocale();
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  const entityLabel = t(`exportShare.${entityType === "contact" ? "contacts" : "leads"}`);

  const run = async (format: ExportFormat) => {
    if (busy) return;
    setBusy(format);
    try {
      const res = await exportAndShare(entityType, format, filters);
      onClose();
      if (res.rowCount === 0) {
        Alert.alert(
          t("exportShare.emptyTitle"),
          t("exportShare.emptyBody", { entity: entityLabel }),
        );
        return;
      }
      if (res.shared === "browser") {
        Alert.alert(
          t("exportShare.successTitle"),
          t("exportShare.successBrowser", { count: res.rowCount, entity: entityLabel }),
        );
      } else if (res.shared === "shared") {
        // Share sheet already gave the user feedback.
      }
    } catch {
      Alert.alert(t("exportShare.errorTitle"), t("exportShare.errorBody"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={busy ? undefined : onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.handle} />
          <Text style={[styles.title, { color: colors.foreground, fontFamily: FONT.bold, textAlign: isRTL ? "right" : "left" }]}>
            {t("exportShare.title")}
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground, textAlign: isRTL ? "right" : "left" }]}>
            {t("exportShare.subtitle", { entity: entityLabel })}
          </Text>

          <View style={{ gap: 10, marginTop: 16 }}>
            {FORMATS.map((f) => (
              <Pressable
                key={f.value}
                disabled={!!busy}
                onPress={() => run(f.value)}
                style={[
                  styles.option,
                  {
                    borderColor: colors.border,
                    backgroundColor: colors.background,
                    flexDirection: isRTL ? "row-reverse" : "row",
                    opacity: busy && busy !== f.value ? 0.5 : 1,
                  },
                ]}
              >
                <View style={[styles.iconWrap, { backgroundColor: colors.primary + "18" }]}>
                  <Feather name={f.icon as any} size={18} color={colors.primary} />
                </View>
                <Text style={[styles.optionLabel, { color: colors.foreground }]}>{f.label}</Text>
                {busy === f.value ? (
                  <ActivityIndicator color={colors.primary} style={{ marginLeft: "auto" }} />
                ) : (
                  <Feather
                    name="share"
                    size={16}
                    color={colors.mutedForeground}
                    style={{ marginLeft: isRTL ? 0 : "auto", marginRight: isRTL ? "auto" : 0 }}
                  />
                )}
              </Pressable>
            ))}
          </View>

          <Pressable onPress={busy ? undefined : onClose} style={styles.cancel}>
            <Text style={[styles.cancelText, { color: colors.mutedForeground }]}>{t("common.cancel")}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 20, paddingBottom: 34 },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: "#9993", marginBottom: 14 },
  title: { fontSize: 18 },
  subtitle: { fontSize: 13, marginTop: 4, fontFamily: FONT.regular },
  option: { alignItems: "center", gap: 12, borderWidth: 1, borderRadius: 14, padding: 14 },
  iconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  optionLabel: { fontSize: 15, fontFamily: FONT.semibold },
  cancel: { alignItems: "center", marginTop: 16, paddingVertical: 10 },
  cancelText: { fontSize: 15, fontFamily: FONT.semibold },
});
