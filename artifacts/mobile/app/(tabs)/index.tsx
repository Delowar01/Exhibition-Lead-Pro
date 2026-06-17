import { Feather } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
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

import { useCreateScan } from "@workspace/api-client-react";

import { FONT, PrimaryButton } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";

export default function ScanScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const createScan = useCreateScan();
  const [capturing, setCapturing] = useState(false);

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  async function handleCapture() {
    if (capturing) return;
    setCapturing(true);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    }
    try {
      let imageData = "";
      if (cameraRef.current) {
        const photo = await cameraRef.current.takePictureAsync({
          base64: true,
          quality: 0.5,
          skipProcessing: true,
        });
        imageData = photo?.base64 ? `data:image/jpeg;base64,${photo.base64}` : "card";
      } else {
        imageData = "card";
      }
      const scan = await createScan.mutateAsync({ data: { imageData } });
      const extracted = scan.extractedData ?? {};
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      router.push({
        pathname: "/scan-review",
        params: { data: JSON.stringify(extracted) },
      });
    } catch {
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } finally {
      setCapturing(false);
    }
  }

  // Permission loading
  if (!permission) {
    return (
      <View style={[styles.fill, { backgroundColor: colors.dark }]}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  // Permission not granted
  if (!permission.granted) {
    const blocked = permission.status === "denied" && !permission.canAskAgain;
    return (
      <View
        style={[
          styles.permissionWrap,
          { backgroundColor: colors.dark, paddingTop: topPad + 40 },
        ]}
      >
        <View style={[styles.permIcon, { backgroundColor: colors.primary + "22" }]}>
          <Feather name="camera" size={32} color={colors.primary} />
        </View>
        <Text style={styles.permTitle}>Scan business cards</Text>
        <Text style={styles.permText}>
          Card Scanner needs camera access to capture cards and extract contact
          details automatically.
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
        {Platform.OS === "web" ? (
          <Pressable onPress={handleCapture} style={styles.webSkip}>
            <Text style={[styles.webSkipText, { color: "rgba(255,255,255,0.6)" }]}>
              Simulate a scan (web preview)
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={[styles.fill, { backgroundColor: colors.dark }]}>
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />

      {/* Top overlay */}
      <LinearGradient
        colors={["rgba(0,0,0,0.6)", "transparent"]}
        style={[styles.topOverlay, { paddingTop: topPad + 12 }]}
      >
        <Text style={styles.overlayTitle}>Scan a card</Text>
        <Text style={styles.overlaySub}>
          {user?.companyName ? user.companyName : "Align the card in the frame"}
        </Text>
      </LinearGradient>

      {/* Frame guide */}
      <View style={styles.frameWrap} pointerEvents="none">
        <View style={[styles.frame, { borderColor: colors.primary }]}>
          <View style={[styles.corner, styles.tl, { borderColor: colors.primary }]} />
          <View style={[styles.corner, styles.tr, { borderColor: colors.primary }]} />
          <View style={[styles.corner, styles.bl, { borderColor: colors.primary }]} />
          <View style={[styles.corner, styles.br, { borderColor: colors.primary }]} />
        </View>
        <Text style={styles.frameHint}>Position the business card here</Text>
      </View>

      {/* Capture control */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 110 }]}>
        <Pressable
          onPress={handleCapture}
          disabled={capturing}
          style={({ pressed }) => [
            styles.shutterOuter,
            { borderColor: "#FFFFFF", opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <View
            style={[
              styles.shutterInner,
              { backgroundColor: capturing ? colors.mutedForeground : colors.primary },
            ]}
          >
            {capturing ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Feather name="maximize" size={24} color="#FFFFFF" />
            )}
          </View>
        </Pressable>
        <Text style={styles.shutterLabel}>
          {capturing ? "Extracting details…" : "Tap to capture"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  permissionWrap: {
    flex: 1,
    paddingHorizontal: 28,
    alignItems: "center",
  },
  permIcon: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  permTitle: {
    color: "#FFFFFF",
    fontSize: 24,
    fontFamily: FONT.bold,
    textAlign: "center",
  },
  permText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
    marginTop: 12,
  },
  webSkip: {
    marginTop: 20,
    padding: 8,
  },
  webSkipText: {
    fontSize: 14,
    fontFamily: FONT.medium,
    textDecorationLine: "underline",
  },
  topOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 24,
    paddingBottom: 28,
  },
  overlayTitle: {
    color: "#FFFFFF",
    fontSize: 22,
    fontFamily: FONT.bold,
  },
  overlaySub: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 14,
    fontFamily: FONT.regular,
    marginTop: 4,
  },
  frameWrap: {
    alignItems: "center",
  },
  frame: {
    width: 300,
    height: 190,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
  },
  corner: {
    position: "absolute",
    width: 30,
    height: 30,
    borderColor: "#FFFFFF",
  },
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
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  shutterOuter: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  shutterLabel: {
    color: "#FFFFFF",
    fontSize: 14,
    fontFamily: FONT.medium,
    marginTop: 14,
  },
});
