import { Feather } from "@expo/vector-icons";
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
} from "expo-camera";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ExtractedCardData } from "@workspace/api-client-react";

import { FONT, PrimaryButton } from "@/components/ui";
import { useColors } from "@/hooks/useColors";

function parseVCard(raw: string): ExtractedCardData {
  const out: ExtractedCardData = {};
  for (const line of raw.split(/\r?\n/)) {
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.split(";")[0].toUpperCase();
    const value = rest.join(":").trim();
    if (!value) continue;
    switch (key) {
      case "FN": {
        const parts = value.split(" ");
        out.firstName = parts[0] ?? null;
        out.lastName = parts.slice(1).join(" ") || null;
        break;
      }
      case "N": {
        const [last, first] = value.split(";");
        if (first) out.firstName = first;
        if (last) out.lastName = last;
        break;
      }
      case "ORG":
        out.company = value.replace(/;/g, " ").trim();
        break;
      case "TITLE":
        out.jobTitle = value;
        break;
      case "EMAIL":
        out.email = value;
        break;
      case "TEL":
        out.mobile = value;
        break;
      case "URL":
        if (/linkedin\.com/i.test(value)) out.linkedin = value;
        else out.website = value;
        break;
      case "ADR":
        out.address = value.replace(/;/g, " ").trim();
        break;
    }
  }
  return out;
}

function parseQr(value: string): ExtractedCardData {
  if (/BEGIN:VCARD/i.test(value)) return parseVCard(value);
  const out: ExtractedCardData = {};
  if (/^https?:\/\//i.test(value)) {
    if (/linkedin\.com/i.test(value)) out.linkedin = value;
    else out.website = value;
  } else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    out.email = value.trim();
  } else {
    out.company = value.slice(0, 120);
  }
  return out;
}

export default function CaptureQrScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);
  const [scanned, setScanned] = useState(false);

  const topPad = insets.top;

  function handleScan(result: BarcodeScanningResult) {
    if (scannedRef.current) return;
    scannedRef.current = true;
    setScanned(true);
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    const data = parseQr(result.data ?? "");
    router.replace({
      pathname: "/scan-review",
      params: { data: JSON.stringify(data), source: "qr" },
    });
  }

  if (!permission) {
    return (
      <View style={[styles.fill, { backgroundColor: colors.dark }]}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (!permission.granted) {
    const blocked = permission.status === "denied" && !permission.canAskAgain;
    return (
      <View style={[styles.permissionWrap, { backgroundColor: colors.dark, paddingTop: topPad + 60 }]}>
        <Pressable onPress={() => router.back()} style={styles.permClose} hitSlop={12}>
          <Feather name="x" size={24} color="#FFFFFF" />
        </Pressable>
        <View style={[styles.permIcon, { backgroundColor: colors.primary + "22" }]}>
          <Feather name="grid" size={32} color={colors.primary} />
        </View>
        <Text style={styles.permTitle}>Camera access needed</Text>
        <Text style={styles.permText}>
          Enable camera access to scan QR codes and LinkedIn profile codes.
        </Text>
        <View style={{ height: 24 }} />
        <PrimaryButton
          label={blocked ? "Open Settings" : "Enable Camera"}
          icon="camera"
          onPress={() => {
            if (blocked && Platform.OS !== "web") {
              try {
                Linking.openSettings();
              } catch {
                /* noop */
              }
            } else {
              requestPermission();
            }
          }}
          style={{ alignSelf: "stretch" }}
        />
      </View>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: colors.dark }]}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={scanned ? undefined : handleScan}
      />

      <LinearGradient
        colors={["rgba(0,0,0,0.65)", "transparent"]}
        style={[styles.topOverlay, { paddingTop: topPad + 12 }]}
      >
        <View style={styles.topRow}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={styles.closeBtn}>
            <Feather name="x" size={22} color="#FFFFFF" />
          </Pressable>
        </View>
        <Text style={styles.overlayTitle}>Scan a QR code</Text>
        <Text style={styles.overlaySub}>Point at a QR or LinkedIn profile code</Text>
      </LinearGradient>

      <View style={styles.frameWrap} pointerEvents="none">
        <View style={[styles.frame, { borderColor: colors.primary }]}>
          <View style={[styles.corner, styles.tl, { borderColor: colors.primary }]} />
          <View style={[styles.corner, styles.tr, { borderColor: colors.primary }]} />
          <View style={[styles.corner, styles.bl, { borderColor: colors.primary }]} />
          <View style={[styles.corner, styles.br, { borderColor: colors.primary }]} />
        </View>
        <Text style={styles.frameHint}>
          {scanned ? "Code detected — opening…" : "Center the code in the frame"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: "center", justifyContent: "center" },
  permissionWrap: { flex: 1, paddingHorizontal: 28, alignItems: "center" },
  permClose: { position: "absolute", top: 56, right: 24 },
  permIcon: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  permTitle: { color: "#FFFFFF", fontSize: 24, fontFamily: FONT.bold, textAlign: "center" },
  permText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
    marginTop: 12,
  },
  topOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 24,
    paddingBottom: 28,
  },
  topRow: { flexDirection: "row", alignItems: "center", marginBottom: 14 },
  closeBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  overlayTitle: { color: "#FFFFFF", fontSize: 22, fontFamily: FONT.bold },
  overlaySub: { color: "rgba(255,255,255,0.8)", fontSize: 14, fontFamily: FONT.regular, marginTop: 4 },
  frameWrap: { alignItems: "center" },
  frame: {
    width: 240,
    height: 240,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
  },
  corner: { position: "absolute", width: 30, height: 30, borderColor: "#FFFFFF" },
  tl: { top: -2, left: -2, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 16 },
  tr: { top: -2, right: -2, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 16 },
  bl: { bottom: -2, left: -2, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 16 },
  br: { bottom: -2, right: -2, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 16 },
  frameHint: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 13,
    fontFamily: FONT.medium,
    marginTop: 16,
  },
});
