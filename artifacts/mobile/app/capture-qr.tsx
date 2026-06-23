import { Feather } from "@/components/icons";
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

import { FONT, PrimaryButton } from "@/components/ui";
import { extractedToContact, parseQrBest } from "@/lib/contact-parse";
import { useOffline } from "@/contexts/OfflineContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";

export default function CaptureQrScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t } = useLocale();
  const [permission, requestPermission] = useCameraPermissions();
  const { isOnline, enqueueContact } = useOffline();
  const { activeEventId } = useSettings();
  const eventId = activeEventId ?? null;
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
    // On Android, ML Kit parses structured QR codes (vCard/MECARD) and exposes a
    // lossy display string in `result.data` while the complete payload lives in
    // `result.raw`. Pass BOTH so parseQrBest keeps the richest decode — without
    // this, Android scans yield an empty/company-only contact even though the QR
    // was detected. iOS/web populate only `result.data` and degrade gracefully.
    const data = parseQrBest(result.raw, result.data);
    // QR data is parsed entirely on-device, so we can queue a ready contact
    // when offline — no server OCR required.
    if (!isOnline) {
      const payload = { ...extractedToContact(data), eventId };
      const label =
        [data.firstName, data.lastName].filter(Boolean).join(" ") ||
        data.company ||
        t("qr.contactFallback");
      enqueueContact(payload, { label, source: "qr", eventId });
      router.replace("/(tabs)/contacts");
      return;
    }
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
        <Text style={styles.permTitle}>{t("qr.cameraNeeded")}</Text>
        <Text style={styles.permText}>
          {t("qr.cameraNeededDesc")}
        </Text>
        <View style={{ height: 24 }} />
        <PrimaryButton
          label={blocked ? t("capture.openSettings") : t("capture.enableCamera")}
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
        <Text style={styles.overlayTitle}>{t("qr.scanTitle")}</Text>
        <Text style={styles.overlaySub}>{t("qr.scanHint")}</Text>
      </LinearGradient>

      <View style={styles.frameWrap} pointerEvents="none">
        <View style={[styles.frame, { borderColor: colors.primary }]}>
          <View style={[styles.corner, styles.tl, { borderColor: colors.primary }]} />
          <View style={[styles.corner, styles.tr, { borderColor: colors.primary }]} />
          <View style={[styles.corner, styles.bl, { borderColor: colors.primary }]} />
          <View style={[styles.corner, styles.br, { borderColor: colors.primary }]} />
        </View>
        <Text style={styles.frameHint}>
          {scanned ? t("capture.codeDetected") : t("capture.centerCode")}
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
