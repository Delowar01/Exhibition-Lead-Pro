import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type ExtractedCardData,
  useCreateContact,
  useCreateScan,
} from "@workspace/api-client-react";
import { answerWasLost, lostConnectionOrSession, worthKeepingForLater } from "@/lib/api-failure";
import { enqueueFailureKeys } from "@/lib/offline-queue-store-model";
import { describeScanFailure } from "@/lib/scan-error";

import {
  ContactForm,
  EMPTY_CONTACT,
  toContactPayload,
  type ContactFormValues,
} from "@/components/ContactForm";
import { Card, FONT, LoadingState, PrimaryButton } from "@/components/ui";
import { useOffline } from "@/contexts/OfflineContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import {
  type BatchCapture,
  clearBatchCaptures,
  getBatchCaptures,
  getBatchOcrResult,
} from "@/lib/batch-store";

function extractedToValues(extracted: ExtractedCardData): ContactFormValues {
  return {
    ...EMPTY_CONTACT,
    firstName: extracted.firstName ?? "",
    lastName: extracted.lastName ?? "",
    jobTitle: extracted.jobTitle ?? "",
    contactCompany: extracted.company ?? "",
    email: extracted.email ?? "",
    mobile: extracted.mobile ?? "",
    officePhone: extracted.officePhone ?? "",
    website: extracted.website ?? "",
    linkedin: extracted.linkedin ?? "",
    country: extracted.country ?? "",
    address: extracted.address ?? "",
    city: extracted.city ?? "",
    postalCode: extracted.postalCode ?? "",
    notes: extracted.arabicName ? `Arabic name: ${extracted.arabicName}` : "",
  };
}

export default function BatchReviewScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  useLocalSearchParams<{ source?: string }>();
  const createScan = useCreateScan();
  const createContact = useCreateContact();
  const { activeEventId, language } = useSettings();
  const { t, isRTL, textAlign } = useLocale();
  const { enqueueScan, enqueueContact, captureOwner } = useOffline();
  const eventId = activeEventId ?? null;

  // Snapshot the buffer once; the store is cleared as we go.
  const captures = useMemo<BatchCapture[]>(() => getBatchCaptures(), []);
  const total = captures.length;

  const [index, setIndex] = useState(0);
  const [savedCount, setSavedCount] = useState(0);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState(false);
  // Batch 7: specific error key (budget/rate-limit/no-card…) for the failure banner.
  const [ocrErrorKey, setOcrErrorKey] = useState<string | null>(null);
  // Phase 2 Batch 1: the classified cause, to offer "save the photo for later"
  // when nothing is wrong with the photo itself (no connection, AI unavailable…).
  const [ocrErrorKind, setOcrErrorKind] = useState<string | null>(null);
  const [keeping, setKeeping] = useState(false);
  const [values, setValues] = useState<ContactFormValues | null>(null);
  const formKey = useRef(0);
  // The account reviewing this batch: anything kept for later belongs to it,
  // whoever is signed in when a failed request finally returns.
  const batchOwner = useRef(captureOwner());

  const current = captures[index];

  const runOcr = useCallback(
    async (item: BatchCapture) => {
      // Use pre-computed OCR result from background processing if available.
      const precomputed = getBatchOcrResult(item.id);
      if (precomputed?.status === "done") {
        formKey.current += 1;
        setValues(extractedToValues(precomputed.extracted ?? {}));
        setOcrError(false);
        setOcrErrorKey(null);
        setOcrErrorKind(null);
        return;
      }
      if (precomputed?.status === "error") {
        formKey.current += 1;
        setValues({ ...EMPTY_CONTACT });
        // The background read failed: show ITS reason, not a generic one.
        setOcrErrorKey(precomputed.errorKey ?? null);
        setOcrErrorKind(precomputed.errorKind ?? null);
        setOcrError(true);
        return;
      }
      // Background OCR still in-flight ("pending") — show a loading indicator
      // and poll the store every 500 ms for up to 20 s so we reuse the result
      // rather than firing a duplicate scan API call. Only if it times out do
      // we fall through to sequential OCR as a last resort.
      if (precomputed?.status === "pending") {
        setOcrLoading(true);
        setOcrError(false);
        setValues(null);
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          await new Promise<void>((r) => setTimeout(r, 500));
          const result = getBatchOcrResult(item.id);
          if (result?.status === "done") {
            formKey.current += 1;
            setValues(extractedToValues(result.extracted ?? {}));
            setOcrLoading(false);
            return;
          }
          if (result?.status === "error") {
            formKey.current += 1;
            setValues({ ...EMPTY_CONTACT });
            setOcrErrorKey(result.errorKey ?? null);
            setOcrErrorKind(result.errorKind ?? null);
            setOcrError(true);
            setOcrLoading(false);
            return;
          }
        }
        // 20 s elapsed and still pending — fall through to sequential OCR.
      }
      // Not started or timed-out: run OCR sequentially now.
      await runSequentialOcr(item);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [createScan, eventId, language],
  );

  // Batch 7: sequential per-item OCR, also used by "Retry OCR" on a failed item —
  // retrying ONE card never reruns the successful ones.
  const runSequentialOcr = useCallback(
    async (item: BatchCapture) => {
      setOcrLoading(true);
      setOcrError(false);
      setOcrErrorKey(null);
      setOcrErrorKind(null);
      setValues(null);
      try {
        const scan = await createScan.mutateAsync({
          data: {
            imageData: item.imageData,
            appLanguage: language,
            eventId,
            latitude: item.latitude,
            longitude: item.longitude,
            gpsAccuracy: item.gpsAccuracy,
          },
        });
        formKey.current += 1;
        setValues(extractedToValues(scan.extractedData ?? {}));
      } catch (e) {
        // Shared classification: also covers "no connection" (not an ApiError).
        const d = describeScanFailure(e);
        setOcrErrorKey(d.key);
        setOcrErrorKind(d.kind);
        setOcrError(true);
        formKey.current += 1;
        setValues({ ...EMPTY_CONTACT });
      } finally {
        setOcrLoading(false);
      }
    },
    [createScan, eventId, language],
  );

  useEffect(() => {
    if (!current) return;
    void runOcr(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  function finish() {
    clearBatchCaptures();
    router.replace("/contacts");
  }

  // Closing the review drops every card not saved yet (the batch lives in
  // memory only). Ask first instead of losing them to one tap.
  function confirmClose() {
    const remaining = total - index;
    if (remaining <= 0) {
      finish();
      return;
    }
    Alert.alert(t("batch.closeTitle"), t("batch.closeBody", { count: remaining }), [
      { text: t("batch.closeKeepReviewing"), style: "cancel" },
      { text: t("batch.closeDiscard"), style: "destructive", onPress: finish },
    ]);
  }

  // The card could not be read for a reason that is not the photo's fault:
  // keep the photo on the device and let the sync read it later.
  async function keepPhotoForLater() {
    if (!current || keeping) return;
    setKeeping(true);
    try {
      const kept = await enqueueScan(current.imageData, {
        label: t("scanReview.sourceCard"),
        source: "card",
        owner: batchOwner.current,
        appLanguage: language === "ar" ? "ar" : "en",
        eventId,
        latitude: current.latitude,
        longitude: current.longitude,
        gpsAccuracy: current.gpsAccuracy,
      });
      if (!kept.ok) {
        const msg = enqueueFailureKeys(kept.reason);
        Alert.alert(t(msg.title), t(msg.body));
        return;
      }
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      advance();
    } finally {
      setKeeping(false);
    }
  }

  function advance() {
    if (index + 1 >= total) {
      finish();
      return;
    }
    setIndex((i) => i + 1);
  }

  async function handleSave(formValues: ContactFormValues) {
    const ocrResult = current ? getBatchOcrResult(current.id) : undefined;
    const payload = {
      ...toContactPayload(formValues),
      eventId,
      latitude: current?.latitude ?? null,
      longitude: current?.longitude ?? null,
      gpsAccuracy: current?.gpsAccuracy ?? null,
      cardImageUrl: ocrResult?.scanId ? `/api/scans/${ocrResult.scanId}/image` : null,
      // The contact names its scan: the server links the two, and a card kept
      // after this request failed can later be checked instead of saved twice.
      scanId: ocrResult?.scanId ?? undefined,
    };
    try {
      await createContact.mutateAsync({ data: payload });
      setSavedCount((c) => c + 1);
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      advance();
    } catch (err) {
      // The connection dropped (or the session ended) while saving: the reviewed
      // card is kept on the device and sent later, and the review goes on.
      if (lostConnectionOrSession(err)) {
        const label =
          [payload.firstName, payload.lastName].filter(Boolean).join(" ") || payload.contactCompany || t("contacts.newContact");
        const kept = await enqueueContact(payload, {
          label,
          source: "card",
          eventId,
          latitude: payload.latitude,
          longitude: payload.longitude,
          gpsAccuracy: payload.gpsAccuracy,
          owner: batchOwner.current,
          answerLost: answerWasLost(err),
        });
        if (kept.ok) {
          createContact.reset();
          setSavedCount((c) => c + 1);
          advance();
          return;
        }
        const msg = enqueueFailureKeys(kept.reason);
        Alert.alert(t(msg.title), t(msg.body));
      }
      // otherwise surfaced via createContact.isError
    }
  }

  function skip() {
    if (Platform.OS !== "web") Haptics.selectionAsync();
    advance();
  }

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  if (total === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: topPad + 40, paddingHorizontal: 24 }}>
        <Text style={[styles.title, { color: colors.foreground }]}>{t("batch.nothingTitle")}</Text>
        <Text style={[styles.sub, { color: colors.mutedForeground }]}>
          {t("batch.nothingDesc")}
        </Text>
        <View style={{ height: 20 }} />
        <PrimaryButton label={t("batch.backToContacts")} icon={isRTL ? "arrow-right" : "arrow-left"} onPress={finish} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 12, paddingHorizontal: 20, paddingBottom: 8 }}>
        <View style={[styles.headerRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
          <Pressable
            onPress={confirmClose}
            hitSlop={10}
            style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            testID="button-batch-close"
          >
            <Feather name="x" size={20} color={colors.foreground} />
          </Pressable>
          <Text style={[styles.progress, { color: colors.mutedForeground }]}>
            {t("batch.progress", { index: index + 1, total, saved: savedCount })}
          </Text>
        </View>
        {/* Progress bar */}
        <View style={[styles.track, { backgroundColor: colors.muted }]}>
          <View
            style={[
              styles.trackFill,
              { backgroundColor: colors.primary, width: `${((index + (values ? 0.5 : 0)) / total) * 100}%` },
            ]}
          />
        </View>
      </View>

      {ocrLoading ? (
        <View style={{ flex: 1 }}>
          <LoadingState />
          <Text style={[styles.loadingCaption, { color: colors.mutedForeground }]}>
            {t("batch.extracting")}
          </Text>
        </View>
      ) : values ? (
        <KeyboardAwareScrollView
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 8,
            paddingBottom: insets.bottom + 40,
          }}
          bottomOffset={20}
          showsVerticalScrollIndicator={false}
        >
          {ocrError ? (
            <Card padded={false} style={{ backgroundColor: colors.destructive + "14", borderColor: colors.destructive + "40", marginBottom: 16 }}>
              <View style={[styles.errorBox, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                <Feather name="alert-circle" size={16} color={colors.destructive} />
                <Text style={[styles.errorText, { color: colors.destructive, textAlign }]}>
                  {ocrErrorKey ? t(ocrErrorKey) : t("batch.readError")}
                </Text>
              </View>
              <Pressable
                onPress={() => current && void runSequentialOcr(current)}
                disabled={ocrLoading || createContact.isPending || keeping}
                style={[styles.retryBtn, { borderColor: colors.destructive + "60", flexDirection: isRTL ? "row-reverse" : "row" }]}
                testID="button-batch-retry-ocr"
              >
                <Feather name="refresh-cw" size={14} color={colors.destructive} />
                <Text style={[styles.retryText, { color: colors.destructive }]}>
                  {t("batch.retryOcr")}
                </Text>
              </Pressable>
              {ocrErrorKind && worthKeepingForLater(ocrErrorKind as Parameters<typeof worthKeepingForLater>[0]) ? (
                <Pressable
                  onPress={() => void keepPhotoForLater()}
                  disabled={ocrLoading || createContact.isPending || keeping}
                  style={[styles.retryBtn, { borderColor: colors.primary + "60", flexDirection: isRTL ? "row-reverse" : "row" }]}
                  testID="button-batch-keep-later"
                >
                  <Feather name="clock" size={14} color={colors.primary} />
                  <Text style={[styles.retryText, { color: colors.primary }]}>
                    {t("batch.keepForLater")}
                  </Text>
                </Pressable>
              ) : null}
            </Card>
          ) : null}

          {createContact.isError ? (
            <Card padded={false} style={{ backgroundColor: colors.destructive + "14", borderColor: colors.destructive + "40", marginBottom: 16 }}>
              <View style={[styles.errorBox, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                <Feather name="alert-circle" size={16} color={colors.destructive} />
                <Text style={[styles.errorText, { color: colors.destructive, textAlign }]}>
                  {t("batch.saveError")}
                </Text>
              </View>
            </Card>
          ) : null}

          <ContactForm
            key={formKey.current}
            initial={values}
            submitLabel={index + 1 >= total ? t("batch.saveFinish") : t("batch.saveNext")}
            submitting={createContact.isPending}
            onSubmit={handleSave}
          />

          <Pressable onPress={skip} style={styles.skipBtn} disabled={createContact.isPending}>
            <Text style={[styles.skipText, { color: colors.mutedForeground }]}>
              {t("batch.skipCard")}
            </Text>
          </Pressable>
        </KeyboardAwareScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 24, fontFamily: FONT.bold },
  sub: { fontSize: 14, fontFamily: FONT.regular, marginTop: 4 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 14 },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  progress: { fontSize: 14, fontFamily: FONT.semibold },
  loadingCaption: { textAlign: "center", marginTop: 12, fontSize: 14, fontFamily: FONT.medium },
  track: { height: 5, borderRadius: 999, overflow: "hidden" },
  trackFill: { height: 5, borderRadius: 999 },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    marginBottom: 16,
  },
  errorText: { flex: 1, fontSize: 13, fontFamily: FONT.medium },
  retryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginHorizontal: 12,
    marginBottom: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  retryText: { fontSize: 13, fontFamily: FONT.semibold },
  skipBtn: { alignItems: "center", paddingVertical: 16 },
  skipText: { fontSize: 15, fontFamily: FONT.medium },
});
