import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FONT } from "@/components/ui";
import { useSettings } from "@/contexts/SettingsContext";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { RADIUS, SPACING, TOUCH_TARGET } from "@/constants/tokens";

type CaptureMode = "single" | "rapid" | "batch";

const MODES: { key: CaptureMode; labelKey: string; icon: keyof typeof Feather.glyphMap; descKey: string }[] = [
  { key: "single", labelKey: "capture.modeSingle", icon: "square", descKey: "capture.modeSingleDesc" },
  { key: "rapid", labelKey: "capture.modeRapid", icon: "zap", descKey: "capture.modeRapidDesc" },
  { key: "batch", labelKey: "capture.modeBatch", icon: "layers", descKey: "capture.modeBatchDesc" },
];

export default function CaptureScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL, textAlign } = useLocale();
  const { captureMode, isLoaded, activeEventId, activeEventName } = useSettings();
  const [mode, setMode] = useState<CaptureMode>(captureMode);

  const hydrated = useRef(false);
  useEffect(() => {
    if (isLoaded && !hydrated.current) {
      hydrated.current = true;
      setMode(captureMode);
    }
  }, [isLoaded, captureMode]);

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);
  const activeMode = MODES.find((m) => m.key === mode)!;

  function requireEvent(run: () => void) {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (!activeEventId) {
      router.push("/event-picker");
      return;
    }
    run();
  }

  const primaryMethods = [
    {
      key: "card",
      label: t("capture.businessCard"),
      sub: t("capture.businessCardDesc"),
      icon: "camera" as keyof typeof Feather.glyphMap,
      color: colors.primary,
      onPress: () => requireEvent(() => router.push({ pathname: "/capture-camera", params: { source: "card", mode } })),
    },
    {
      key: "qr",
      label: t("capture.qrCode"),
      sub: t("capture.qrCodeDesc"),
      icon: "grid" as keyof typeof Feather.glyphMap,
      color: "#06B6D4",
      onPress: () => requireEvent(() => router.push("/capture-qr")),
    },
  ];

  const secondaryMethods = [
    {
      key: "nfc",
      label: t("capture.nfc"),
      icon: "wifi" as keyof typeof Feather.glyphMap,
      color: "#10B981",
      onPress: () => requireEvent(() => router.push("/capture-nfc")),
    },
    {
      key: "signature",
      label: t("capture.emailSignature"),
      icon: "mail" as keyof typeof Feather.glyphMap,
      color: "#8B5CF6",
      onPress: () => requireEvent(() => router.push({ pathname: "/capture-camera", params: { source: "signature", mode } })),
    },
    {
      key: "manual",
      label: t("capture.manual"),
      icon: "edit-3" as keyof typeof Feather.glyphMap,
      color: "#F59E0B",
      onPress: () => requireEvent(() => router.push("/capture-manual")),
    },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: topPad + SPACING.lg,
          paddingHorizontal: SPACING.xl,
          paddingBottom: insets.bottom + 110,
          flexGrow: 1,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={{ marginBottom: SPACING.xl }}>
          <Text style={[styles.heading, { color: colors.foreground, textAlign }]}>
            {t("capture.title")}
          </Text>
          <Text style={[styles.subheading, { color: colors.mutedForeground, textAlign }]}>
            {t("capture.subtitle")}
          </Text>
        </View>

        {/* Active Event */}
        <Pressable
          onPress={() => router.push("/event-picker")}
          style={({ pressed }) => [
            styles.eventCard,
            {
              backgroundColor: activeEventId ? colors.primary + "12" : colors.card,
              borderColor: activeEventId ? colors.primary + "40" : colors.border,
              borderRadius: RADIUS.lg,
              opacity: pressed ? 0.8 : 1,
              flexDirection: isRTL ? "row-reverse" : "row",
            },
          ]}
        >
          <View style={[styles.eventIcon, { backgroundColor: activeEventId ? colors.primary : colors.muted }]}>
            <Feather name={activeEventId ? "map-pin" : "calendar"} size={18} color={activeEventId ? "#FFF" : colors.mutedForeground} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.eventTitle, { color: activeEventId ? colors.primary : colors.foreground, textAlign }]} numberOfLines={1}>
              {activeEventName ?? t("home.noActiveEvent")}
            </Text>
            <Text style={[styles.eventSub, { color: colors.mutedForeground, textAlign }]}>
              {activeEventId ? t("capture.eventTagged") : t("capture.eventSelectHint")}
            </Text>
          </View>
          <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
        </Pressable>

        {/* Mode Selector */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground, textAlign }]}>
          {t("capture.captureMode").toUpperCase()}
        </Text>
        <View style={[styles.modeBar, { backgroundColor: colors.muted, borderRadius: RADIUS.lg, flexDirection: isRTL ? "row-reverse" : "row" }]}>
          {MODES.map((m) => {
            const active = m.key === mode;
            return (
              <Pressable
                key={m.key}
                onPress={() => setMode(m.key)}
                style={[
                  styles.modeChip,
                  { backgroundColor: active ? colors.card : "transparent", borderRadius: RADIUS.md },
                  active && styles.modeChipActive,
                ]}
              >
                <Feather name={m.icon} size={15} color={active ? colors.primary : colors.mutedForeground} />
                <Text style={[styles.modeChipText, { color: active ? colors.foreground : colors.mutedForeground }]}>
                  {t(m.labelKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <View style={[styles.modeHint, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
          <Feather name="info" size={14} color={colors.mutedForeground} />
          <Text style={[styles.modeHintText, { color: colors.mutedForeground, textAlign }]}>
            {t(activeMode.descKey)}
          </Text>
        </View>

        {/* Primary Methods */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground, textAlign }]}>{t("capture.captureMethod").toUpperCase()}</Text>
        <View style={{ gap: SPACING.md }}>
          {primaryMethods.map((m) => (
            <Pressable
              key={m.key}
              onPress={() => {
                if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                m.onPress();
              }}
              style={({ pressed }) => [
                styles.primaryMethodCard,
                { backgroundColor: colors.card, borderColor: colors.border, borderRadius: RADIUS.lg, opacity: pressed ? 0.8 : 1, flexDirection: isRTL ? "row-reverse" : "row" },
              ]}
            >
              <View style={[styles.primaryMethodIcon, { backgroundColor: m.color + "1A" }]}>
                <Feather name={m.icon} size={28} color={m.color} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.primaryMethodLabel, { color: colors.foreground, textAlign }]}>{m.label}</Text>
                <Text style={[styles.primaryMethodSub, { color: colors.mutedForeground, textAlign }]}>{m.sub}</Text>
              </View>
            </Pressable>
          ))}
        </View>

        {/* Secondary Methods Grid */}
        <View style={[styles.secondaryGrid, { flexDirection: isRTL ? "row-reverse" : "row", marginTop: SPACING.md }]}>
          {secondaryMethods.map((m) => (
            <Pressable
              key={m.key}
              onPress={() => {
                if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                m.onPress();
              }}
              style={({ pressed }) => [
                styles.secondaryMethodCard,
                { backgroundColor: colors.card, borderColor: colors.border, borderRadius: RADIUS.lg, opacity: pressed ? 0.8 : 1 },
              ]}
            >
              <View style={[styles.secondaryMethodIcon, { backgroundColor: m.color + "1A" }]}>
                <Feather name={m.icon} size={20} color={m.color} />
              </View>
              <Text style={[styles.secondaryMethodLabel, { color: colors.foreground, textAlign: "center" }]}>{m.label}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 32, fontFamily: FONT.bold, letterSpacing: -0.5 },
  subheading: { fontSize: 15, fontFamily: FONT.regular, marginTop: 4 },
  sectionTitle: { fontSize: 12, fontFamily: FONT.semibold, letterSpacing: 0.8, marginTop: SPACING.xxl, marginBottom: SPACING.md },
  eventCard: { flexDirection: "row", alignItems: "center", gap: SPACING.md, padding: SPACING.lg, borderWidth: 1 },
  eventIcon: { width: 44, height: 44, borderRadius: RADIUS.full, alignItems: "center", justifyContent: "center" },
  eventTitle: { fontSize: 16, fontFamily: FONT.semibold },
  eventSub: { fontSize: 13, fontFamily: FONT.regular, marginTop: 2 },
  modeBar: { flexDirection: "row", padding: SPACING.xs, gap: SPACING.xs },
  modeChip: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12 },
  modeChipActive: { shadowColor: "#000", shadowOpacity: 0.05, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  modeChipText: { fontSize: 14, fontFamily: FONT.semibold },
  modeHint: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4, marginTop: SPACING.sm },
  modeHintText: { flex: 1, fontSize: 13, fontFamily: FONT.medium, lineHeight: 18 },
  primaryMethodCard: { flexDirection: "row", alignItems: "center", gap: SPACING.lg, padding: SPACING.lg, borderWidth: 1 },
  primaryMethodIcon: { width: 56, height: 56, borderRadius: RADIUS.full, alignItems: "center", justifyContent: "center" },
  primaryMethodLabel: { fontSize: 18, fontFamily: FONT.semibold },
  primaryMethodSub: { fontSize: 14, fontFamily: FONT.regular, marginTop: 4 },
  secondaryGrid: { gap: SPACING.md },
  secondaryMethodCard: { flex: 1, padding: SPACING.lg, borderWidth: 1, alignItems: "center", justifyContent: "center", gap: SPACING.sm },
  secondaryMethodIcon: { width: 40, height: 40, borderRadius: RADIUS.full, alignItems: "center", justifyContent: "center" },
  secondaryMethodLabel: { fontSize: 14, fontFamily: FONT.medium },
});
