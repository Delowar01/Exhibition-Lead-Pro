import { Feather } from "@/components/icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as ImageManipulator from "expo-image-manipulator";
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
  ApiError,
  type ExtractedCardData,
  useCreateContact,
  useCreateScan,
} from "@workspace/api-client-react";

import { FONT, PrimaryButton } from "@/components/ui";
import { useOffline } from "@/contexts/OfflineContext";
import { useSettings } from "@/contexts/SettingsContext";
import { describeScanError } from "@/lib/scan-error";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import {
  type BatchCapture,
  clearBatchCaptures,
  setBatchCaptures,
  setBatchOcrResult,
} from "@/lib/batch-store";
import { addScanMetric } from "@/lib/scan-perf";

// Dev-only diagnostics for the capture → OCR → save pipeline. Stripped in
// production builds (guarded by __DEV__) so it never leaks to end users.
function scanLog(stage: string, detail?: Record<string, unknown>): void {
  if (__DEV__) {
    console.log(`[Scan] ${stage}`, detail ?? "");
  }
}

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
    officePhone: data.officePhone ?? null,
    website: data.website ?? null,
    linkedin: data.linkedin ?? null,
    country: data.country ?? null,
    address: data.address ?? null,
    eventId,
    latitude: gps.latitude,
    longitude: gps.longitude,
    gpsAccuracy: gps.gpsAccuracy,
  };
}

function contactDisplayName(data: ExtractedCardData, fallback: string): string {
  return [data.firstName, data.lastName].filter(Boolean).join(" ") || data.company || fallback;
}

// We do NOT need a 12MP+ sensor capture for OCR. ~1600px on the long edge keeps
// business-card text crisp while drastically cutting capture time, memory, the
// JPEG encode, and the upload. Pick the SMALLEST available capture size whose
// long edge is still >= this target. (Kept at 1600 — not lower — so the card,
// which only fills part of the frame, still has a real-world detail margin.)
const TARGET_CAPTURE_LONG_EDGE = 1600;

// Upload payload target. Empirical OCR sweep (clean + degraded synthetic cards):
// extraction stayed 100% accurate down to 800px/0.40, and server OCR time was
// flat (~3s) regardless of image size — i.e. shrinking further does NOT speed up
// OCR. We sit at 1100px/0.50: comfortably above the accuracy floor (margin for
// real-world glare/perspective/small fonts) while keeping the upload tiny for
// weak exhibition networks. Tune here if device testing shows accuracy loss.
const UPLOAD_LONG_EDGE = 1100;
const UPLOAD_JPEG_QUALITY = 0.5;

// Choose a capture resolution from the device's available `pictureSize` list.
// Android (and recent iOS) report "WIDTHxHEIGHT" strings; pick the smallest one
// that still has enough detail for OCR. If nothing parses (older iOS preset
// strings), return undefined so the camera keeps its default.
function pickCaptureSize(sizes: string[]): string | undefined {
  const parsed = sizes
    .map((s) => {
      const m = /^(\d+)\s*x\s*(\d+)$/i.exec(s.trim());
      if (!m) return null;
      const w = parseInt(m[1], 10);
      const h = parseInt(m[2], 10);
      if (!w || !h) return null;
      return { s, longEdge: Math.max(w, h), pixels: w * h };
    })
    .filter((x): x is { s: string; longEdge: number; pixels: number } => x !== null)
    .sort((a, b) => a.pixels - b.pixels);
  if (parsed.length === 0) return undefined;
  // Smallest size that still clears the OCR detail threshold; if none do (all
  // smaller than target), fall back to the largest available.
  const adequate = parsed.find((p) => p.longEdge >= TARGET_CAPTURE_LONG_EDGE);
  return (adequate ?? parsed[parsed.length - 1]).s;
}

// On-device capture-quality heuristic (Stage 5E). BEST-EFFORT and purely
// JS/cross-platform: it derives a quality score from the JPEG detail density
// (bytes per pixel) of the already-captured, resized image. A well-lit, in-focus
// card produces more high-frequency detail → a larger JPEG; a dark/blurry
// capture compresses smaller. No native-only APIs are used, so it degrades
// gracefully on web/Expo Go — if dimensions/payload are unavailable it returns
// null and the indicator is simply hidden. Advisory only; never blocks capture.
interface CaptureQuality {
  score: number;
  meta: {
    heuristic: string;
    bytesPerPixel: number;
    payloadKb: number;
    width: number;
    height: number;
  };
}

function computeCaptureQuality(
  imageData: string,
  srcW: number,
  srcH: number,
  outW: number,
): CaptureQuality | null {
  try {
    if (!imageData.startsWith("data:image")) return null;
    const commaIdx = imageData.indexOf(",");
    const b64 = commaIdx >= 0 ? imageData.slice(commaIdx + 1) : "";
    if (!b64 || !srcW || !srcH || !outW) return null;
    const bytes = Math.round(b64.length * 0.75);
    const outH = Math.round(outW * (srcH / srcW));
    const pixels = outW * outH;
    if (pixels <= 0) return null;
    const bpp = bytes / pixels;
    const LO = 0.12;
    const HI = 0.55;
    const score = Math.max(0, Math.min(100, Math.round(((bpp - LO) / (HI - LO)) * 100)));
    return {
      score,
      meta: {
        heuristic: "jpeg-detail-density",
        bytesPerPixel: Math.round(bpp * 1000) / 1000,
        payloadKb: Math.round(bytes / 1024),
        width: outW,
        height: outH,
      },
    };
  } catch {
    return null;
  }
}

export default function CaptureCameraScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ source?: string; mode?: string }>();
  const source = params.source === "signature" ? "signature" : "card";
  // Stage 5E: classify + persist the capture source on the scan. Camera cards are
  // "camera"; an email-signature photo maps to the "email_signature" taxonomy value.
  const captureSource = source === "signature" ? "email_signature" : "camera";
  const mode = (["single", "rapid", "batch"].includes(params.mode ?? "")
    ? params.mode
    : "single") as CaptureMode;

  const { t } = useLocale();
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const createScan = useCreateScan();
  const createContact = useCreateContact();
  const { isOnline, enqueueScan } = useOffline();
  const { activeEventId, language } = useSettings();
  const eventId = activeEventId ?? null;

  const [capturing, setCapturing] = useState(false);
  const [rapidCount, setRapidCount] = useState(0);
  const [savedCount, setSavedCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [batchCount, setBatchCount] = useState(0);
  // Transient on-device capture-quality indicator (advisory only).
  const [lastQuality, setLastQuality] = useState<CaptureQuality | null>(null);
  // Direct lower-res capture (set once the camera is ready). undefined = sensor
  // default until we've queried the device's supported sizes.
  const [pictureSize, setPictureSize] = useState<string | undefined>(undefined);

  const onCameraReady = useCallback(async () => {
    const cam = cameraRef.current;
    if (!cam || pictureSize) return;
    try {
      const sizes = await cam.getAvailablePictureSizesAsync();
      const chosen = pickCaptureSize(sizes ?? []);
      if (chosen) {
        setPictureSize(chosen);
        scanLog("capture size selected", { chosen, available: sizes });
      }
    } catch {
      // Keep the camera default if size enumeration isn't supported.
    }
  }, [pictureSize]);

  // #2 GPS — fetched once, non-blocking. Capture works even if this never resolves.
  const gpsRef = useRef<Gps>({ latitude: null, longitude: null, gpsAccuracy: null });
  const batchRef = useRef<BatchCapture[]>([]);
  // Per-stage capture timing — populated inside captureImage(), read in
  // handleCapture() once the await returns. Avoids changing captureImage's
  // return type while still surfacing native-thread timing to the caller.
  const capturePerfRef = useRef<{
    captureRawMs: number;
    processMs: number;
    srcW: number;
    srcH: number;
    outW: number;
  } | null>(null);

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
  const sourceLabel = source === "signature" ? t("capture.sourceLabelSignature") : t("capture.sourceLabelCard");

  const captureImage = useCallback(async (): Promise<string> => {
    const cam = cameraRef.current;
    if (!cam) return "card";
    // NOTE ON THREADING: the heavy work — capture, resize, JPEG compression, file
    // write and base64 encoding — runs in NATIVE modules (expo-camera /
    // expo-image-manipulator) on native background threads, not the JS/UI thread,
    // and the camera preview + spinner keep animating throughout. Minor JS-thread
    // overhead does remain (receiving the base64 over the bridge, building the
    // data: URL, and JSON-serializing the body before fetch), but at this payload
    // size (~1100px JPEG) that is sub-frame and not perceptible.
    //
    // The camera is configured (via `pictureSize`) to capture directly at a
    // standard OCR resolution (~1600px long edge) instead of the sensor's full
    // 12MP+ — so the capture, in-memory bitmap, and JPEG encode are all small.
    // We then downscale to UPLOAD_LONG_EDGE for the upload payload.
    const tCap = Date.now();
    const photo = await cam.takePictureAsync({
      quality: 0.5,
      skipProcessing: true,
    });
    const captureRawMs = Date.now() - tCap;
    if (photo?.uri) {
      try {
        // Clamp the target to the source width so a small capture is never
        // UPSCALED (which would inflate the payload + encode for no OCR gain).
        const targetWidth = photo.width ? Math.min(UPLOAD_LONG_EDGE, photo.width) : UPLOAD_LONG_EDGE;
        const tProc = Date.now();
        const resized = await ImageManipulator.manipulateAsync(
          photo.uri,
          [{ resize: { width: targetWidth } }],
          { compress: UPLOAD_JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG, base64: true },
        );
        // Per-stage profiling: store in ref so handleCapture can assemble the
        // full metric once upload + OCR + contact timings are also known.
        const perfProcessMs = Date.now() - tProc;
        capturePerfRef.current = {
          captureRawMs,
          processMs: perfProcessMs,
          srcW: photo.width ?? 0,
          srcH: photo.height ?? 0,
          outW: targetWidth,
        };
        scanLog("capture pipeline", {
          captureRawMs,
          processMs: perfProcessMs,
          srcW: photo.width,
          srcH: photo.height,
          outW: targetWidth,
        });
        if (resized.base64) return `data:image/jpeg;base64,${resized.base64}`;
      } catch {
        // Manipulation failed (rare) — fall through to a raw base64 capture so
        // the scan still works, just without the size optimization.
      }
    }
    const raw = await cam.takePictureAsync({
      base64: true,
      quality: 0.4,
      skipProcessing: true,
    });
    return raw?.base64 ? `data:image/jpeg;base64,${raw.base64}` : "card";
  }, []);

  // #3 Rapid — OCR + save happen in the background so the camera frees instantly.
  //
  // perfTiming carries the device-side capture metrics captured before the call
  // so the background task can assemble and record a complete ScanMetric once
  // both OCR and contact creation finish.
  const processRapid = useCallback(
    async (
      imageData: string,
      gps: Gps,
      perfTiming: {
        captureRawMs: number;
        processMs: number;
        srcW: number;
        srcH: number;
        outW: number;
        payloadKb: number;
        tStart: number;
      } | null,
      quality: CaptureQuality | null,
    ) => {
      const tOcr = Date.now();
      try {
        scanLog("rapid: OCR started", { bytes: imageData.length, language });
        const scan = await createScan.mutateAsync({
          data: {
            imageData,
            appLanguage: language,
            captureSource,
            eventId,
            latitude: gps.latitude,
            longitude: gps.longitude,
            gpsAccuracy: gps.gpsAccuracy,
            qualityScore: quality?.score ?? null,
            qualityMeta: quality?.meta ?? null,
          },
        });
        const uploadAndOcrMs = Date.now() - tOcr;
        const extracted = scan.extractedData ?? {};
        scanLog("rapid: OCR completed", { confidence: scan.confidence, uploadAndOcrMs });
        const tContact = Date.now();
        await createContact.mutateAsync({ data: extractedToContact(extracted, gps, eventId) });
        const contactMs = Date.now() - tContact;
        const totalMs = perfTiming ? Date.now() - perfTiming.tStart : uploadAndOcrMs + contactMs;
        scanLog("rapid: contact saved", { contactMs, totalMs });
        if (__DEV__ && perfTiming) {
          addScanMetric({
            id: String(perfTiming.tStart),
            ts: perfTiming.tStart,
            mode: "rapid",
            source,
            captureRawMs: perfTiming.captureRawMs,
            processMs: perfTiming.processMs,
            uploadAndOcrMs,
            contactMs,
            totalMs,
            captureW: perfTiming.srcW,
            captureH: perfTiming.srcH,
            uploadW: perfTiming.outW,
            payloadKb: perfTiming.payloadKb,
            confidence: scan.confidence ?? null,
          });
        }
        setSavedCount((c) => c + 1);
        setLastSaved(contactDisplayName(extracted, t("capture.newContactFallback")));
      } catch (e) {
        scanLog("rapid: FAILED", {
          status: e instanceof ApiError ? e.status : undefined,
          message: e instanceof Error ? e.message : String(e),
        });
        setFailedCount((c) => c + 1);
      }
    },
    [createScan, createContact, eventId, language, source, captureSource, t],
  );

  // Phase 7: turn raw failures into specific, actionable messages instead of a
  // single generic "Failed". Prefers the server's localized error body, then
  // maps by HTTP status, then detects offline/network/timeout faults.
  const captureErrorMessage = useCallback(
    (err: unknown): string => {
      if (err instanceof ApiError) {
        // Batch 7: shared mapper — adds AI budget/rate-limit (429), AI-disabled
        // (403 code) and no-readable-card (422) handling on top of the status map.
        const d = describeScanError(err.status, err.data);
        return d.serverMessage || t(d.key);
      }
      if (
        err instanceof TypeError ||
        (err instanceof Error && /network|fetch|timeout|connection/i.test(err.message))
      ) {
        return t("capture.errNetwork");
      }
      return t("capture.captureFailed");
    },
    [t],
  );

  async function handleCapture() {
    if (capturing) return;
    setCapturing(true);
    setErrorMsg(null);
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

    try {
      const tStart = Date.now();
      const imageData = await captureImage();
      const captureMs = Date.now() - tStart;
      // base64 is ~4/3 of the raw byte size; report the actual upload payload KB.
      const payloadKb = Math.round((imageData.length * 0.75) / 1024);
      scanLog("image captured", { mode, source, captureMs, payloadKb, pictureSize });
      const gps = { ...gpsRef.current };

      // On-device capture-quality heuristic (advisory). Surfaced as a transient
      // indicator and attached to the scan; never gates the capture.
      const ct = capturePerfRef.current;
      const quality = ct ? computeCaptureQuality(imageData, ct.srcW, ct.srcH, ct.outW) : null;
      setLastQuality(quality);

      // #4 Batch — capture image and start background OCR immediately so results
      // are already computed (or partially computed) by the time the user reaches
      // the review screen. This eliminates the sequential OCR wait at review time.
      if (mode === "batch") {
        const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const item: BatchCapture = {
          id: batchId,
          imageData,
          latitude: gps.latitude,
          longitude: gps.longitude,
          gpsAccuracy: gps.gpsAccuracy,
        };
        batchRef.current = [...batchRef.current, item];
        setBatchCount(batchRef.current.length);
        // Snapshot capture timing for the background metric (ref will be
        // overwritten on the next shutter press before the IIFE finishes).
        const batchCapTiming = capturePerfRef.current ? { ...capturePerfRef.current } : null;
        // Mark pending then fire-and-forget background OCR.
        setBatchOcrResult(batchId, { status: "pending", extracted: null, scanId: null });
        void (async () => {
          const tOcr = Date.now();
          try {
            const scan = await createScan.mutateAsync({
              data: {
                imageData,
                appLanguage: language,
                captureSource,
                eventId,
                latitude: gps.latitude,
                longitude: gps.longitude,
                gpsAccuracy: gps.gpsAccuracy,
                qualityScore: quality?.score ?? null,
                qualityMeta: quality?.meta ?? null,
              },
            });
            const uploadAndOcrMs = Date.now() - tOcr;
            setBatchOcrResult(batchId, {
              status: "done",
              extracted: scan.extractedData ?? null,
              scanId: scan.id,
            });
            scanLog("batch: OCR done", { id: batchId, uploadAndOcrMs });
            if (__DEV__ && batchCapTiming) {
              addScanMetric({
                id: batchId,
                ts: tStart,
                mode: "batch",
                source,
                captureRawMs: batchCapTiming.captureRawMs,
                processMs: batchCapTiming.processMs,
                uploadAndOcrMs,
                contactMs: null,
                totalMs: uploadAndOcrMs + (batchCapTiming.captureRawMs + batchCapTiming.processMs),
                captureW: batchCapTiming.srcW,
                captureH: batchCapTiming.srcH,
                uploadW: batchCapTiming.outW,
                payloadKb,
                confidence: scan.confidence ?? null,
              });
            }
          } catch (e) {
            setBatchOcrResult(batchId, { status: "error", extracted: null, scanId: null });
            scanLog("batch: OCR error", {
              id: batchId,
              message: e instanceof Error ? e.message : String(e),
            });
          }
        })();
        if (Platform.OS !== "web") Haptics.selectionAsync();
        return;
      }

      // Offline: the image needs server-side OCR we can't run here, so queue
      // the raw capture — it's OCR'd and turned into a contact on sync.
      if (!isOnline) {
        const queueLabel = source === "signature" ? t("scanReview.sourceSignature") : t("scanReview.sourceCard");
        const meta = {
          label: queueLabel,
          source,
          appLanguage: language === "ar" ? ("ar" as const) : ("en" as const),
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
        setLastSaved(t("capture.offlineSuffix", { label: queueLabel }));
        if (Platform.OS !== "web") Haptics.selectionAsync();
        return;
      }

      if (mode === "single") {
        scanLog("single: OCR started", { payloadKb, language });
        const tOcr = Date.now();
        const scan = await createScan.mutateAsync({
          data: {
            imageData,
            appLanguage: language,
            captureSource,
            eventId,
            latitude: gps.latitude,
            longitude: gps.longitude,
            gpsAccuracy: gps.gpsAccuracy,
            qualityScore: quality?.score ?? null,
            qualityMeta: quality?.meta ?? null,
          },
        });
        const uploadAndOcrMs = Date.now() - tOcr;
        const totalMs = Date.now() - tStart;
        // ocrMs = upload + server OCR round-trip; totalMs = shutter press → review.
        // Contact creation happens in scan-review, so contactMs is null here.
        scanLog("single: OCR completed", {
          confidence: scan.confidence,
          uploadAndOcrMs,
          totalMs,
        });
        if (__DEV__ && capturePerfRef.current) {
          const ct = capturePerfRef.current;
          addScanMetric({
            id: String(tStart),
            ts: tStart,
            mode: "single",
            source,
            captureRawMs: ct.captureRawMs,
            processMs: ct.processMs,
            uploadAndOcrMs,
            contactMs: null,
            totalMs,
            captureW: ct.srcW,
            captureH: ct.srcH,
            uploadW: ct.outW,
            payloadKb,
            confidence: scan.confidence ?? null,
          });
        }
        if (Platform.OS !== "web") {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
        router.replace({
          pathname: "/scan-review",
          params: {
            data: JSON.stringify(scan.extractedData ?? {}),
            source,
            conf: scan.confidence != null ? String(scan.confidence) : "",
            lat: gps.latitude != null ? String(gps.latitude) : "",
            lng: gps.longitude != null ? String(gps.longitude) : "",
            acc: gps.gpsAccuracy != null ? String(gps.gpsAccuracy) : "",
            scanId: String(scan.id),
            meta: JSON.stringify({
              captureSource,
              model: scan.aiModel ?? null,
              promptVersion: scan.promptVersion ?? null,
              processingTimeMs: scan.processingTimeMs ?? null,
              qualityScore: scan.qualityScore ?? null,
              extractionMethod: scan.extractionMethod ?? null,
              fieldConfidences: scan.fieldConfidences ?? null,
            }),
          },
        });
        return;
      }

      // rapid (online): return to the camera instantly, process in background.
      setRapidCount((c) => c + 1);
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      // Pass captured timing so processRapid can record a complete metric once
      // OCR + contact creation both finish in the background.
      const rapidPerfTiming = capturePerfRef.current
        ? { ...capturePerfRef.current, payloadKb, tStart }
        : null;
      void processRapid(imageData, gps, rapidPerfTiming, quality);
    } catch (e) {
      scanLog("capture: FAILED", {
        status: e instanceof ApiError ? e.status : undefined,
        message: e instanceof Error ? e.message : String(e),
      });
      setErrorMsg(captureErrorMessage(e));
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
      <View style={[styles.fill, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  // Permission not granted
  if (!permission.granted) {
    const blocked = permission.status === "denied" && !permission.canAskAgain;
    return (
      <View style={[styles.fill, { backgroundColor: colors.background }]}>
        <View style={[styles.permissionWrap, { paddingTop: topPad + 60, paddingBottom: insets.bottom + 20 }]}>
          <Pressable onPress={() => router.back()} style={styles.permClose} hitSlop={12}>
            <Feather name="x" size={28} color={colors.foreground} />
          </Pressable>
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
            <View style={[styles.permIcon, { backgroundColor: colors.primary + "1A" }]}>
              <Feather name="camera" size={40} color={colors.primary} />
            </View>
            <Text style={[styles.permTitle, { color: colors.foreground }]}>{t("capture.cameraNeeded")}</Text>
            <Text style={[styles.permText, { color: colors.mutedForeground }]}>
              {t("capture.cameraNeededDesc", { label: sourceLabel })}
            </Text>
          </View>
          <View style={{ width: "100%", gap: 16 }}>
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
            />
            {Platform.OS === "web" ? (
              <Pressable onPress={handleCapture} style={styles.webSkip}>
                <Text style={[styles.webSkipText, { color: colors.primary }]}>
                  {t("capture.simulateScan")}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    );
  }

  // Advisory capture-quality band → color + label. good ≥66 / fair ≥40 / poor.
  const qualityBand = lastQuality
    ? lastQuality.score >= 66
      ? { color: "#22C55E", label: t("capture.qualityGood"), icon: "check-circle" as const }
      : lastQuality.score >= 40
        ? { color: "#F59E0B", label: t("capture.qualityFair"), icon: "alert-circle" as const }
        : { color: "#EF4444", label: t("capture.qualityPoor"), icon: "alert-triangle" as const }
    : null;

  return (
    <View style={[styles.fill, { backgroundColor: "#000000" }]}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        pictureSize={pictureSize}
        onCameraReady={onCameraReady}
      />

      {/* Top overlay */}
      <LinearGradient
        colors={["rgba(0,0,0,0.8)", "transparent"]}
        style={[styles.topOverlay, { paddingTop: topPad + 12 }]}
      >
        <View style={styles.topRow}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={styles.closeBtn}>
            <Feather name="x" size={24} color="#FFFFFF" />
          </Pressable>
          <View style={[styles.modePill, { backgroundColor: colors.primary }]}>
            <Text style={styles.modePillText}>{mode.toUpperCase()}</Text>
          </View>
          <View style={{ width: 44 }} /> {/* Spacer to balance the row */}
        </View>
        <View style={{ alignItems: "center", marginTop: 8 }}>
          <Text style={styles.overlayTitle}>
            {source === "signature" ? t("capture.scanSignature") : t("capture.scanCardTitle")}
          </Text>
          <Text style={styles.overlaySub}>{t("capture.alignFrame", { label: sourceLabel })}</Text>
        </View>
      </LinearGradient>

      {/* Frame guide */}
      <View style={styles.frameWrap} pointerEvents="none">
        <View style={[styles.frame, { borderColor: "rgba(255,255,255,0.4)" }]}>
          <View style={[styles.corner, styles.tl, { borderColor: colors.primary }]} />
          <View style={[styles.corner, styles.tr, { borderColor: colors.primary }]} />
          <View style={[styles.corner, styles.bl, { borderColor: colors.primary }]} />
          <View style={[styles.corner, styles.br, { borderColor: colors.primary }]} />
        </View>
      </View>

      <View style={[styles.feedbackContainer, { top: topPad + 120 }]} pointerEvents="none">
        {/* Rapid feedback */}
        {mode === "rapid" && rapidCount > 0 ? (
          <View style={styles.rapidBanner}>
            <Feather name="check-circle" size={18} color="#FFFFFF" />
            <Text style={styles.rapidBannerText}>
              {t("capture.savedCount", { count: savedCount })}
              {failedCount > 0 ? t("capture.failedSuffix", { count: failedCount }) : ""}
              {lastSaved ? ` · ${lastSaved}` : ""}
            </Text>
          </View>
        ) : null}

        {/* Batch counter */}
        {mode === "batch" && batchCount > 0 ? (
          <View style={[styles.rapidBanner, { backgroundColor: "#FB923C" }]}>
            <Feather name="layers" size={18} color="#FFFFFF" />
            <Text style={styles.rapidBannerText}>
              {t("capture.batchBanner", { count: batchCount })}
            </Text>
          </View>
        ) : null}

        {/* Error feedback */}
        {errorMsg ? (
          <View style={[styles.errorBanner]}>
            <Feather name="alert-circle" size={18} color="#FFFFFF" />
            <Text style={styles.rapidBannerText}>{errorMsg}</Text>
          </View>
        ) : null}
      </View>

      {/* Capture-quality indicator (advisory, transient) */}
      {qualityBand ? (
        <View
          style={[styles.qualityBanner, { bottom: insets.bottom + 160, backgroundColor: qualityBand.color }]}
          pointerEvents="none"
        >
          <Feather name={qualityBand.icon} size={16} color="#FFFFFF" />
          <Text style={styles.rapidBannerText}>
            {t("capture.qualityLabel")}: {qualityBand.label}
          </Text>
        </View>
      ) : null}

      {/* Capture control */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 32, paddingTop: 40 }]}>
        <LinearGradient
          colors={["transparent", "rgba(0,0,0,0.8)"]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <View style={{ alignItems: "center", justifyContent: "center" }}>
          <Pressable
            onPress={handleCapture}
            disabled={capturing}
            accessibilityRole="button"
            accessibilityLabel={t("capture.tapCapture")}
            style={({ pressed }) => [styles.shutterOuter, { borderColor: "#FFFFFF", opacity: pressed ? 0.8 : 1 }]}
          >
            <View style={[styles.shutterInner, { backgroundColor: capturing ? "rgba(255,255,255,0.4)" : colors.primary }]}>
              {capturing ? (
                <ActivityIndicator color="#FFFFFF" size="large" />
              ) : null}
            </View>
          </Pressable>
          <Text style={styles.shutterLabel}>
            {capturing
              ? t("capture.capturing")
              : mode === "rapid"
                ? t("capture.rapidHint")
                : mode === "batch"
                  ? t("capture.tapCaptureAnother")
                  : t("capture.tapCapture")}
          </Text>
        </View>

        {mode === "batch" ? (
          <Pressable
            onPress={finishBatch}
            accessibilityRole="button"
            accessibilityLabel={t("capture.done")}
            style={({ pressed }) => [styles.doneBtn, { backgroundColor: "rgba(255,255,255,0.2)", opacity: pressed ? 0.7 : 1 }]}
          >
            <Text style={styles.doneBtnText}>
              {batchCount > 0 ? t("capture.doneReview", { count: batchCount }) : t("capture.done")}
            </Text>
            <Feather name="chevron-right" size={20} color="#FFFFFF" />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  permissionWrap: { flex: 1, paddingHorizontal: 24 },
  permClose: { position: "absolute", top: 56, right: 24, zIndex: 10 },
  permIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  permTitle: { fontSize: 24, fontFamily: FONT.bold, textAlign: "center", marginBottom: 12 },
  permText: {
    fontSize: 16,
    fontFamily: FONT.regular,
    lineHeight: 24,
    textAlign: "center",
  },
  webSkip: { alignItems: "center", paddingVertical: 12 },
  webSkipText: { fontSize: 15, fontFamily: FONT.medium },
  topOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingBottom: 32,
    zIndex: 10,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  closeBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  modePill: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: 999 },
  modePillText: { color: "#FFFFFF", fontSize: 13, fontFamily: FONT.bold, letterSpacing: 0.5 },
  overlayTitle: { color: "#FFFFFF", fontSize: 24, fontFamily: FONT.bold, marginBottom: 4 },
  overlaySub: { color: "rgba(255,255,255,0.9)", fontSize: 15, fontFamily: FONT.regular },
  frameWrap: { flex: 1, alignItems: "center", justifyContent: "center", marginTop: -60 },
  frame: {
    width: "85%",
    aspectRatio: 1.586, // Standard business card aspect ratio
    borderRadius: 16,
    borderWidth: 2,
    borderStyle: "dashed",
  },
  corner: { position: "absolute", width: 40, height: 40 },
  tl: { top: -2, left: -2, borderTopWidth: 5, borderLeftWidth: 5, borderTopLeftRadius: 16 },
  tr: { top: -2, right: -2, borderTopWidth: 5, borderRightWidth: 5, borderTopRightRadius: 16 },
  bl: { bottom: -2, left: -2, borderBottomWidth: 5, borderLeftWidth: 5, borderBottomLeftRadius: 16 },
  br: { bottom: -2, right: -2, borderBottomWidth: 5, borderRightWidth: 5, borderBottomRightRadius: 16 },
  feedbackContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    gap: 8,
    zIndex: 20,
  },
  rapidBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#22C55E",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 999,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  rapidBannerText: { color: "#FFFFFF", fontSize: 15, fontFamily: FONT.semibold },
  qualityBanner: {
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 999,
    zIndex: 20,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#EF4444",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 999,
  },
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "flex-end",
    zIndex: 10,
  },
  shutterOuter: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 5,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  shutterInner: {
    width: 68,
    height: 68,
    borderRadius: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  shutterLabel: { color: "#FFFFFF", fontSize: 15, fontFamily: FONT.medium, textShadowColor: "rgba(0,0,0,0.8)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 },
  doneBtn: {
    position: "absolute",
    right: 24,
    bottom: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  doneBtnText: { color: "#FFFFFF", fontSize: 16, fontFamily: FONT.semibold },
});

