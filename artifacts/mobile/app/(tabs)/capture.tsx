import { Feather } from "@expo/vector-icons";
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

type CaptureMode = "single" | "rapid" | "batch";

const MODES: { key: CaptureMode; label: string; icon: keyof typeof Feather.glyphMap; desc: string }[] = [
  { key: "single", label: "Single", icon: "square", desc: "Capture one card and review the details before saving." },
  { key: "rapid", label: "Rapid", icon: "zap", desc: "Capture back-to-back — each scan saves instantly and returns to the camera." },
  { key: "batch", label: "Batch", icon: "layers", desc: "Queue several cards, then process them all together." },
];

export default function CaptureScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { captureMode, isLoaded } = useSettings();
  const [mode, setMode] = useState<CaptureMode>(captureMode);

  // Apply the persisted default capture mode once settings hydrate, while still
  // letting the user override it locally afterwards.
  const hydrated = useRef(false);
  useEffect(() => {
    if (isLoaded && !hydrated.current) {
      hydrated.current = true;
      setMode(captureMode);
    }
  }, [isLoaded, captureMode]);

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);
  const activeMode = MODES.find((m) => m.key === mode)!;

  const methods: {
    key: string;
    label: string;
    sub: string;
    icon: keyof typeof Feather.glyphMap;
    color: string;
    onPress: () => void;
  }[] = [
    {
      key: "card",
      label: "Business Card",
      sub: "Scan a printed card",
      icon: "credit-card",
      color: colors.primary,
      onPress: () => router.push({ pathname: "/capture-camera", params: { source: "card", mode } }),
    },
    {
      key: "badge",
      label: "Event Badge",
      sub: "Scan an attendee badge",
      icon: "award",
      color: "#8B5CF6",
      onPress: () => router.push({ pathname: "/capture-camera", params: { source: "badge", mode } }),
    },
    {
      key: "qr",
      label: "QR / LinkedIn",
      sub: "Scan a QR or profile code",
      icon: "grid",
      color: "#06B6D4",
      onPress: () => router.push("/capture-qr"),
    },
    {
      key: "manual",
      label: "Manual Entry",
      sub: "Type the details yourself",
      icon: "edit-3",
      color: "#F59E0B",
      onPress: () => router.push("/capture-manual"),
    },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: topPad + 14,
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + 110,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.heading, { color: colors.foreground }]}>Capture Center</Text>
        <Text style={[styles.subheading, { color: colors.mutedForeground }]}>
          Turn any contact into a lead
        </Text>

        {/* Mode selector */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>CAPTURE MODE</Text>
        <View style={[styles.modeBar, { backgroundColor: colors.muted, borderRadius: colors.radius + 4 }]}>
          {MODES.map((m) => {
            const active = m.key === mode;
            return (
              <Pressable
                key={m.key}
                onPress={() => {
                  if (Platform.OS !== "web") Haptics.selectionAsync();
                  setMode(m.key);
                }}
                style={[
                  styles.modeChip,
                  {
                    backgroundColor: active ? colors.card : "transparent",
                    borderRadius: colors.radius + 1,
                  },
                  active && styles.modeChipActive,
                ]}
              >
                <Feather name={m.icon} size={15} color={active ? colors.primary : colors.mutedForeground} />
                <Text
                  style={[
                    styles.modeChipText,
                    { color: active ? colors.foreground : colors.mutedForeground },
                  ]}
                >
                  {m.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <View style={[styles.modeHint, { backgroundColor: colors.accent, borderRadius: colors.radius }]}>
          <Feather name={activeMode.icon} size={15} color={colors.primary} />
          <Text style={[styles.modeHintText, { color: colors.accentForeground }]}>
            {activeMode.desc}
          </Text>
        </View>

        {/* Methods */}
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>CAPTURE METHOD</Text>
        <View style={{ gap: 12 }}>
          {methods.map((m) => (
            <Pressable
              key={m.key}
              onPress={() => {
                if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                m.onPress();
              }}
              style={({ pressed }) => [
                styles.methodCard,
                { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4, opacity: pressed ? 0.75 : 1 },
              ]}
            >
              <View style={[styles.methodIcon, { backgroundColor: m.color + "1A" }]}>
                <Feather name={m.icon} size={22} color={m.color} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.methodLabel, { color: colors.foreground }]}>{m.label}</Text>
                <Text style={[styles.methodSub, { color: colors.mutedForeground }]}>{m.sub}</Text>
              </View>
              <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  heading: {
    fontSize: 30,
    fontFamily: FONT.bold,
  },
  subheading: {
    fontSize: 14,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.6,
    marginTop: 24,
    marginBottom: 12,
  },
  modeBar: {
    flexDirection: "row",
    padding: 4,
    gap: 4,
  },
  modeChip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
  },
  modeChipActive: {
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  modeChipText: {
    fontSize: 13.5,
    fontFamily: FONT.semibold,
  },
  modeHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    marginTop: 10,
  },
  modeHintText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FONT.medium,
    lineHeight: 18,
  },
  methodCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 16,
    borderWidth: 1,
  },
  methodIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  methodLabel: {
    fontSize: 16,
    fontFamily: FONT.semibold,
  },
  methodSub: {
    fontSize: 13,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
});
