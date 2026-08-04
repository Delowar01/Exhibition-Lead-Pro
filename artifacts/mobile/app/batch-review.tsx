import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  ApiError,
  type ExtractedCardData,
  useCreateContact,
  useCreateScan,
} from "@workspace/api-client-react";
import { describeScanError } from "@/lib/scan-error";

import {
  ContactForm,
  EMPTY_CONTACT,
  toContactPayload,
  type ContactFormValues,
} from "@/components/ContactForm";
import { Card, FONT, LoadingState, PrimaryButton } from "@/components/ui";
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
  const { t } = useLocale();
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
  const [values, setValues] = useState<ContactFormValues | null>(null);
  const formKey = useRef(0);

  const current = captures[index];

  const runOcr = useCallback(
    async (item: BatchCapture) => {
      // Use pre-computed OCR result from background processing if available.
      const precomputed = getBatchOcrResult(item.id);
      if (precomputed?.status === "done") {
        formKey.current += 1;
        setValues(extractedToValues(precomputed.extracted ?? {}));
        setOcrError(false);
        return;
      }
      if (precomputed?.status === "error") {
        formKey.current += 1;
        setValues({ ...EMPTY_CONTACT });
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
        if (e instanceof ApiError) setOcrErrorKey(describeScanError(e.status, e.data).key);
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
    };
    try {
      await createContact.mutateAsync({ data: payload });
      setSavedCount((c) => c + 1);
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      advance();
    } catch {
      // surfaced via createContact.isError
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
        <PrimaryButton label={t("batch.backToContacts")} icon="arrow-left" onPress={finish} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 12, paddingHorizontal: 20, paddingBottom: 8 }}>
        <View style={styles.headerRow}>
          <Pressable
            onPress={finish}
            hitSlop={10}
            style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
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
              <View style={styles.errorBox}>
                <Feather name="alert-circle" size={16} color={colors.destructive} />
                <Text style={[styles.errorText, { color: colors.destructive }]}>
                  {ocrErrorKey ? t(ocrErrorKey) : t("batch.readError")}
                </Text>
              </View>
              <Pressable
                onPress={() => current && void runSequentialOcr(current)}
                disabled={ocrLoading || createContact.isPending}
                style={[styles.retryBtn, { borderColor: colors.destructive + "60" }]}
                testID="button-batch-retry-ocr"
              >
                <Feather name="refresh-cw" size={14} color={colors.destructive} />
                <Text style={[styles.retryText, { color: colors.destructive }]}>
                  {t("batch.retryOcr")}
                </Text>
              </Pressable>
            </Card>
          ) : null}

          {createContact.isError ? (
            <Card padded={false} style={{ backgroundColor: colors.destructive + "14", borderColor: colors.destructive + "40", marginBottom: 16 }}>
              <View style={styles.errorBox}>
                <Feather name="alert-circle" size={16} color={colors.destructive} />
                <Text style={[styles.errorText, { color: colors.destructive }]}>
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
