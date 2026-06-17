import { Feather } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type ExtractedCardData,
  useCreateContact,
  useCreateScan,
} from "@workspace/api-client-react";

import { FONT, PrimaryButton } from "@/components/ui";
import { useOffline } from "@/contexts/OfflineContext";
import { useColors } from "@/hooks/useColors";

type CaptureMode = "single" | "rapid" | "batch";
type QueueStatus = "queued" | "processing" | "completed" | "failed";

interface QueueItem {
  id: string;
  status: QueueStatus;
  name: string;
}

function extractedToContact(data: ExtractedCardData) {
  return {
    firstName: data.firstName ?? null,
    lastName: data.lastName ?? null,
    jobTitle: data.jobTitle ?? null,
    contactCompany: data.company ?? null,
    email: data.email ?? null,
    mobile: data.mobile ?? null,
    website: data.website ?? null,
    linkedin: data.linkedin ?? null,
    address: data.address ?? null,
  };
}

function contactDisplayName(data: ExtractedCardData): string {
  return [data.firstName, data.lastName].filter(Boolean).join(" ") || data.company || "New contact";
}

const STATUS_META: Record<QueueStatus, { color: string; icon: keyof typeof Feather.glyphMap; label: string }> = {
  queued: { color: "#67707D", icon: "clock", label: "Queued" },
  processing: { color: "#F59E0B", icon: "loader", label: "Processing" },
  completed: { color: "#22C55E", icon: "check-circle", label: "Saved" },
  failed: { color: "#EF4444", icon: "alert-circle", label: "Failed" },
};

export default function CaptureCameraScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ source?: string; mode?: string }>();
  const source = params.source === "badge" ? "badge" : "card";
  const mode = (["single", "rapid", "batch"].includes(params.mode ?? "")
    ? params.mode
    : "single") as CaptureMode;

  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const createScan = useCreateScan();
  const createContact = useCreateContact();
  const { isOnline, enqueueScan } = useOffline();

  const [capturing, setCapturing] = useState(false);
  const [rapidCount, setRapidCount] = useState(0);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);

  const topPad = insets.top;
  const sourceLabel = source === "badge" ? "event badge" : "business card";

  const setQueueStatus = useCallback((id: string, status: QueueStatus, name?: string) => {
    setQueue((prev) =>
      prev.map((q) => (q.id === id ? { ...q, status, name: name ?? q.name } : q)),
    );
  }, []);

  const captureImage = useCallback(async (): Promise<string> => {
    if (cameraRef.current) {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.5,
        skipProcessing: true,
      });
      return photo?.base64 ? `data:image/jpeg;base64,${photo.base64}` : "card";
    }
    return "card";
  }, []);

  async function handleCapture() {
    if (capturing) return;
    setCapturing(true);
    setErrorMsg(null);
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    try {
      const imageData = await captureImage();

      // Offline: the image needs server-side OCR we can't run here, so queue
      // the raw capture — it's OCR'd and turned into a contact on sync.
      if (!isOnline) {
        const queueLabel = source === "badge" ? "Event badge" : "Business card";
        if (mode === "single") {
          enqueueScan(imageData, { label: queueLabel, source });
          if (Platform.OS !== "web") {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          router.replace("/sync");
          return;
        }
        // rapid / batch: queue and keep the camera open for the next capture.
        enqueueScan(imageData, { label: queueLabel, source });
        setRapidCount((c) => c + 1);
        setLastSaved(`${queueLabel} (offline)`);
        if (Platform.OS !== "web") Haptics.selectionAsync();
        return;
      }

      if (mode === "single") {
        const scan = await createScan.mutateAsync({ data: { imageData } });
        if (Platform.OS !== "web") {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
        router.replace({
          pathname: "/scan-review",
          params: { data: JSON.stringify(scan.extractedData ?? {}), source },
        });
        return;
      }

      if (mode === "rapid") {
        const scan = await createScan.mutateAsync({ data: { imageData } });
        const extracted = scan.extractedData ?? {};
        await createContact.mutateAsync({ data: extractedToContact(extracted) });
        setRapidCount((c) => c + 1);
        setLastSaved(contactDisplayName(extracted));
        if (Platform.OS !== "web") {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
        return;
      }

      // batch
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setQueue((prev) => [{ id, status: "queued", name: "Card captured" }, ...prev]);
      if (Platform.OS !== "web") Haptics.selectionAsync();
      // Process in the background.
      void (async () => {
        setQueueStatus(id, "processing");
        try {
          const scan = await createScan.mutateAsync({ data: { imageData } });
          const extracted = scan.extractedData ?? {};
          await createContact.mutateAsync({ data: extractedToContact(extracted) });
          setQueueStatus(id, "completed", contactDisplayName(extracted));
        } catch {
          setQueueStatus(id, "failed");
        }
      })();
    } catch {
      setErrorMsg("Couldn't save that scan. Try again.");
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
      <View style={[styles.permissionWrap, { backgroundColor: colors.dark, paddingTop: topPad + 60 }]}>
        <Pressable onPress={() => router.back()} style={styles.permClose} hitSlop={12}>
          <Feather name="x" size={24} color="#FFFFFF" />
        </Pressable>
        <View style={[styles.permIcon, { backgroundColor: colors.primary + "22" }]}>
          <Feather name="camera" size={32} color={colors.primary} />
        </View>
        <Text style={styles.permTitle}>Camera access needed</Text>
        <Text style={styles.permText}>
          Enable camera access to capture a {sourceLabel} and extract contact details automatically.
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

  const completedCount = queue.filter((q) => q.status === "completed").length;

  return (
    <View style={[styles.fill, { backgroundColor: colors.dark }]}>
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />

      {/* Top overlay */}
      <LinearGradient
        colors={["rgba(0,0,0,0.65)", "transparent"]}
        style={[styles.topOverlay, { paddingTop: topPad + 12 }]}
      >
        <View style={styles.topRow}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={styles.closeBtn}>
            <Feather name="x" size={22} color="#FFFFFF" />
          </Pressable>
          <View style={[styles.modePill, { backgroundColor: colors.primary }]}>
            <Text style={styles.modePillText}>{mode.toUpperCase()}</Text>
          </View>
        </View>
        <Text style={styles.overlayTitle}>
          {source === "badge" ? "Scan a badge" : "Scan a card"}
        </Text>
        <Text style={styles.overlaySub}>Align the {sourceLabel} in the frame</Text>
      </LinearGradient>

      {/* Frame guide */}
      <View style={styles.frameWrap} pointerEvents="none">
        <View style={[styles.frame, { borderColor: colors.primary }]}>
          <View style={[styles.corner, styles.tl, { borderColor: colors.primary }]} />
          <View style={[styles.corner, styles.tr, { borderColor: colors.primary }]} />
          <View style={[styles.corner, styles.bl, { borderColor: colors.primary }]} />
          <View style={[styles.corner, styles.br, { borderColor: colors.primary }]} />
        </View>
      </View>

      {/* Rapid feedback */}
      {mode === "rapid" && rapidCount > 0 ? (
        <View style={[styles.rapidBanner, { top: topPad + 110 }]} pointerEvents="none">
          <Feather name="check-circle" size={16} color="#FFFFFF" />
          <Text style={styles.rapidBannerText}>
            Saved {lastSaved} · {rapidCount} this session
          </Text>
        </View>
      ) : null}

      {/* Error feedback */}
      {errorMsg ? (
        <View style={[styles.errorBanner, { top: topPad + 110 }]} pointerEvents="none">
          <Feather name="alert-circle" size={16} color="#FFFFFF" />
          <Text style={styles.rapidBannerText}>{errorMsg}</Text>
        </View>
      ) : null}

      {/* Batch queue */}
      {mode === "batch" && queue.length > 0 ? (
        <View style={[styles.queuePanel, { top: topPad + 110 }]}>
          <Text style={styles.queueHeading}>
            Queue · {completedCount}/{queue.length} saved
          </Text>
          <ScrollView style={{ maxHeight: 150 }} showsVerticalScrollIndicator={false}>
            {queue.map((q) => {
              const meta = STATUS_META[q.status];
              return (
                <View key={q.id} style={styles.queueRow}>
                  <Feather name={meta.icon} size={15} color={meta.color} />
                  <Text numberOfLines={1} style={styles.queueName}>
                    {q.name}
                  </Text>
                  <Text style={[styles.queueStatus, { color: meta.color }]}>{meta.label}</Text>
                </View>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      {/* Capture control */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 28 }]}>
        <Pressable
          onPress={handleCapture}
          disabled={capturing}
          style={({ pressed }) => [styles.shutterOuter, { borderColor: "#FFFFFF", opacity: pressed ? 0.7 : 1 }]}
        >
          <View style={[styles.shutterInner, { backgroundColor: capturing ? colors.mutedForeground : colors.primary }]}>
            {capturing ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Feather name="maximize" size={24} color="#FFFFFF" />
            )}
          </View>
        </Pressable>
        <Text style={styles.shutterLabel}>
          {capturing
            ? "Extracting details…"
            : mode === "rapid"
              ? "Tap to capture & save"
              : mode === "batch"
                ? "Tap to add to queue"
                : "Tap to capture"}
        </Text>

        {mode === "batch" ? (
          <Pressable
            onPress={() => router.replace("/(tabs)/contacts")}
            style={[styles.doneBtn, { borderColor: "rgba(255,255,255,0.4)" }]}
          >
            <Text style={styles.doneBtnText}>
              {completedCount > 0 ? `Done · ${completedCount} saved` : "Done"}
            </Text>
          </Pressable>
        ) : null}
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
  webSkip: { marginTop: 20, padding: 8 },
  webSkipText: { fontSize: 14, fontFamily: FONT.medium, textDecorationLine: "underline" },
  topOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 24,
    paddingBottom: 28,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  closeBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  modePill: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999 },
  modePillText: { color: "#FFFFFF", fontSize: 11, fontFamily: FONT.bold, letterSpacing: 0.6 },
  overlayTitle: { color: "#FFFFFF", fontSize: 22, fontFamily: FONT.bold },
  overlaySub: { color: "rgba(255,255,255,0.8)", fontSize: 14, fontFamily: FONT.regular, marginTop: 4 },
  frameWrap: { alignItems: "center" },
  frame: {
    width: 300,
    height: 190,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
  },
  corner: { position: "absolute", width: 30, height: 30, borderColor: "#FFFFFF" },
  tl: { top: -2, left: -2, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 16 },
  tr: { top: -2, right: -2, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 16 },
  bl: { bottom: -2, left: -2, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 16 },
  br: { bottom: -2, right: -2, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 16 },
  rapidBanner: {
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(34,197,94,0.92)",
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
  },
  rapidBannerText: { color: "#FFFFFF", fontSize: 13, fontFamily: FONT.semibold },
  errorBanner: {
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(239,68,68,0.94)",
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
  },
  queuePanel: {
    position: "absolute",
    left: 20,
    right: 20,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 14,
    padding: 14,
  },
  queueHeading: { color: "#FFFFFF", fontSize: 13, fontFamily: FONT.bold, marginBottom: 8 },
  queueRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  queueName: { flex: 1, color: "rgba(255,255,255,0.9)", fontSize: 13, fontFamily: FONT.medium },
  queueStatus: { fontSize: 12, fontFamily: FONT.semibold },
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
  shutterLabel: { color: "#FFFFFF", fontSize: 14, fontFamily: FONT.medium, marginTop: 14 },
  doneBtn: {
    marginTop: 18,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 22,
    paddingVertical: 10,
  },
  doneBtnText: { color: "#FFFFFF", fontSize: 14, fontFamily: FONT.semibold },
});
