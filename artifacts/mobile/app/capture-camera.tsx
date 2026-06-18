import { Feather } from "@/components/icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import * as Location from "expo-location";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
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

import {
  type ExtractedCardData,
  useCreateContact,
  useCreateScan,
} from "@workspace/api-client-react";

import { FONT, PrimaryButton } from "@/components/ui";
import { useOffline } from "@/contexts/OfflineContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useColors } from "@/hooks/useColors";
import {
  type BatchCapture,
  clearBatchCaptures,
  setBatchCaptures,
} from "@/lib/batch-store";

type CaptureMode = "single" | "rapid" | "batch";

interface Gps {
  latitude: number | null;
  longitude: number | null;
  gpsAccuracy: number | null;
}

function extractedToContact(data: ExtractedCardData, gps: Gps, eventId: number | null) {
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
    eventId,
    latitude: gps.latitude,
    longitude: gps.longitude,
    gpsAccuracy: gps.gpsAccuracy,
  };
}

function contactDisplayName(data: ExtractedCardData): string {
  return [data.firstName, data.lastName].filter(Boolean).join(" ") || data.company || "New contact";
}

export default function CaptureCameraScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ source?: string; mode?: string }>();
  const source = params.source === "signature" ? "signature" : "card";
  const mode = (["single", "rapid", "batch"].includes(params.mode ?? "")
    ? params.mode
    : "single") as CaptureMode;

  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const createScan = useCreateScan();
  const createContact = useCreateContact();
  const { isOnline, enqueueScan } = useOffline();
  const { activeEventId } = useSettings();
  const eventId = activeEventId ?? null;

  const [capturing, setCapturing] = useState(false);
  const [rapidCount, setRapidCount] = useState(0);
  const [savedCount, setSavedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [batchCount, setBatchCount] = useState(0);

  // #2 GPS — fetched once, non-blocking. Capture works even if this never resolves.
  const gpsRef = useRef<Gps>({ latitude: null, longitude: null, gpsAccuracy: null });
  const batchRef = useRef<BatchCapture[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") return;
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (cancelled) return;
        gpsRef.current = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          gpsAccuracy: pos.coords.accuracy ?? null,
        };
      } catch {
        /* location is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const topPad = insets.top;
  const sourceLabel = source === "signature" ? "email signature" : "business card";

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

  // #3 Rapid — OCR + save happen in the background so the camera frees instantly.
  const processRapid = useCallback(
    async (imageData: string, gps: Gps) => {
      try {
        const scan = await createScan.mutateAsync({
          data: {
            imageData,
            eventId,
            latitude: gps.latitude,
            longitude: gps.longitude,
            gpsAccuracy: gps.gpsAccuracy,
          },
        });
        const extracted = scan.extractedData ?? {};
        await createContact.mutateAsync({ data: extractedToContact(extracted, gps, eventId) });
        setSavedCount((c) => c + 1);
        setLastSaved(contactDisplayName(extracted));
      } catch {
        setFailedCount((c) => c + 1);
      }
    },
    [createScan, createContact, eventId],
  );

  async function handleCapture() {
    if (capturing) return;
    setCapturing(true);
    setErrorMsg(null);
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    try {
      const imageData = await captureImage();
      const gps = { ...gpsRef.current };

      // #4 Batch — capture image only, defer OCR/review to the review screen.
      if (mode === "batch") {
        const item: BatchCapture = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          imageData,
          latitude: gps.latitude,
          longitude: gps.longitude,
          gpsAccuracy: gps.gpsAccuracy,
        };
        batchRef.current = [...batchRef.current, item];
        setBatchCount(batchRef.current.length);
        if (Platform.OS !== "web") Haptics.selectionAsync();
        return;
      }

      // Offline: the image needs server-side OCR we can't run here, so queue
      // the raw capture — it's OCR'd and turned into a contact on sync.
      if (!isOnline) {
        const queueLabel = source === "signature" ? "Email signature" : "Business card";
        const meta = {
          label: queueLabel,
          source,
          eventId,
          latitude: gps.latitude,
          longitude: gps.longitude,
          gpsAccuracy: gps.gpsAccuracy,
        };
        if (mode === "single") {
          enqueueScan(imageData, meta);
          if (Platform.OS !== "web") {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          router.replace("/sync");
          return;
        }
        // rapid: queue and keep the camera open for the next capture.
        enqueueScan(imageData, meta);
        setRapidCount((c) => c + 1);
        setSavedCount((c) => c + 1);
        setLastSaved(`${queueLabel} (offline)`);
        if (Platform.OS !== "web") Haptics.selectionAsync();
        return;
      }

      if (mode === "single") {
        const scan = await createScan.mutateAsync({
          data: {
            imageData,
            eventId,
            latitude: gps.latitude,
            longitude: gps.longitude,
            gpsAccuracy: gps.gpsAccuracy,
          },
        });
        if (Platform.OS !== "web") {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
        router.replace({
          pathname: "/scan-review",
          params: {
            data: JSON.stringify(scan.extractedData ?? {}),
            source,
            lat: gps.latitude != null ? String(gps.latitude) : "",
            lng: gps.longitude != null ? String(gps.longitude) : "",
            acc: gps.gpsAccuracy != null ? String(gps.gpsAccuracy) : "",
          },
        });
        return;
      }

      // rapid (online): return to the camera instantly, process in background.
      setRapidCount((c) => c + 1);
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      void processRapid(imageData, gps);
    } catch {
      setErrorMsg("Couldn't capture that. Try again.");
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } finally {
      setCapturing(false);
    }
  }

  function finishBatch() {
    if (batchRef.current.length === 0) {
      router.back();
      return;
    }
    setBatchCaptures(batchRef.current);
    if (Platform.OS !== "web") Haptics.selectionAsync();
    router.replace({ pathname: "/batch-review", params: { source } });
  }

  // Clear any stale batch buffer when entering batch mode.
  useEffect(() => {
    if (mode === "batch") clearBatchCaptures();
  }, [mode]);

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
          {source === "signature" ? "Scan a signature" : "Scan a card"}
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
            {savedCount} saved{failedCount > 0 ? ` · ${failedCount} failed` : ""}
            {lastSaved ? ` · ${lastSaved}` : ""}
          </Text>
        </View>
      ) : null}

      {/* Batch counter */}
      {mode === "batch" && batchCount > 0 ? (
        <View style={[styles.rapidBanner, { top: topPad + 110, backgroundColor: "rgba(255,107,0,0.94)" }]} pointerEvents="none">
          <Feather name="layers" size={16} color="#FFFFFF" />
          <Text style={styles.rapidBannerText}>
            {batchCount} captured · tap Done to review
          </Text>
        </View>
      ) : null}

      {/* Error feedback */}
      {errorMsg ? (
        <View style={[styles.errorBanner, { top: topPad + 160 }]} pointerEvents="none">
          <Feather name="alert-circle" size={16} color="#FFFFFF" />
          <Text style={styles.rapidBannerText}>{errorMsg}</Text>
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
            ? "Capturing…"
            : mode === "rapid"
              ? "Tap to capture — saves in the background"
              : mode === "batch"
                ? "Tap to capture another"
                : "Tap to capture"}
        </Text>

        {mode === "batch" ? (
          <Pressable
            onPress={finishBatch}
            style={[styles.doneBtn, { borderColor: "rgba(255,255,255,0.4)" }]}
          >
            <Text style={styles.doneBtnText}>
              {batchCount > 0 ? `Done · review ${batchCount}` : "Done"}
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
