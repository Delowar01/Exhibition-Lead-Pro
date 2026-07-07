import { Feather } from "@/components/icons";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type CaptureAnalysis,
  type CaptureFields,
  type ContactMatch,
  type ExtractedCardData,
  type ExtractedCardOriginal,
  type FieldValidation,
  getBaseUrl,
  type LeadScorePreview,
  type OrganizationMatch,
  type SmartSuggestion,
  useAnalyzeCapture,
  useCreateContact,
  useReplaceScanImage,
  useReprocessScan,
  useScoreScan,
} from "@workspace/api-client-react";

import {
  ContactForm,
  EMPTY_CONTACT,
  toContactPayload,
  type ContactFormValues,
} from "@/components/ContactForm";
import { FONT } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { useOffline } from "@/contexts/OfflineContext";
import { useSettings } from "@/contexts/SettingsContext";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";

function parseNum(v?: string): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Fields shown in the "as printed" reference panel, in display order. */
const ORIGINAL_FIELDS: {
  key: keyof ExtractedCardOriginal;
  labelKey: string;
}[] = [
  { key: "firstName", labelKey: "firstName" },
  { key: "lastName", labelKey: "lastName" },
  { key: "arabicName", labelKey: "arabicName" },
  { key: "jobTitle", labelKey: "jobTitle" },
  { key: "company", labelKey: "company" },
  { key: "address", labelKey: "address" },
];

export default function ScanReviewScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL, textAlign, language } = useLocale();
  const params = useLocalSearchParams<{
    data?: string;
    source?: string;
    conf?: string;
    lat?: string;
    lng?: string;
    acc?: string;
    scanId?: string;
    meta?: string;
  }>();
  const scanMeta = useMemo(() => {
    try {
      if (!params.meta) return null;
      return JSON.parse(params.meta) as {
        captureSource?: string | null;
        model?: string | null;
        promptVersion?: number | null;
        processingTimeMs?: number | null;
        qualityScore?: number | null;
        extractionMethod?: string | null;
        fieldConfidences?: Record<string, number> | null;
      };
    } catch {
      return null;
    }
  }, [params.meta]);
  const createContact = useCreateContact();
  const { isOnline, enqueueContact } = useOffline();
  const { activeEventId } = useSettings();
  const eventId = activeEventId ?? null;
  const gps = {
    latitude: parseNum(params.lat),
    longitude: parseNum(params.lng),
    gpsAccuracy: parseNum(params.acc),
  };

  const sourceLabel = useMemo(() => {
    const map: Record<string, string> = {
      card: t("scanReview.sourceCard"),
      signature: t("scanReview.sourceSignature"),
      qr: t("scanReview.sourceQr"),
      nfc: t("scanReview.sourceNfc"),
    };
    return map[params.source ?? "card"] ?? t("scanReview.sourceScan");
  }, [params.source, t]);

  const [extracted, setExtracted] = useState<ExtractedCardData | null>(() => {
    try {
      return params.data ? (JSON.parse(params.data) as ExtractedCardData) : null;
    } catch {
      return null;
    }
  });

  const { token } = useAuth();
  const scanId = params.scanId ? Number(params.scanId) : 0;
  const reprocess = useReprocessScan();
  const rerunAi = useScoreScan();
  const replaceImage = useReplaceScanImage();
  const [scorePreview, setScorePreview] = useState<LeadScorePreview | null>(null);
  const [formKey, setFormKey] = useState(0);

  // Build the contact-form value object from OCR extraction. Used to seed the
  // form and to reset it after reprocess/replace.
  const buildFormValues = useCallback(
    (e: ExtractedCardData | null): ContactFormValues => {
      const d = e ?? ({} as ExtractedCardData);
      return {
        ...EMPTY_CONTACT,
        firstName: d.firstName ?? "",
        lastName: d.lastName ?? "",
        jobTitle: d.jobTitle ?? "",
        contactCompany: d.company ?? "",
        email: d.email ?? "",
        mobile: d.mobile ?? "",
        officePhone: d.officePhone ?? "",
        website: d.website ?? "",
        linkedin: d.linkedin ?? "",
        country: d.country ?? "",
        address: d.address ?? "",
        city: d.city ?? "",
        postalCode: d.postalCode ?? "",
        notes: d.arabicName ? `${t("scanReview.arabicName")}: ${d.arabicName}` : "",
      };
    },
    [t],
  );

  // Live source-of-truth for the review form. Kept in sync via ContactForm's
  // onChange so the intelligence panel can analyze edits and Apply can write back.
  const [formValues, setFormValues] = useState<ContactFormValues>(() =>
    buildFormValues(extracted),
  );

  // Capture Intelligence (Stage 5E): additive, advisory-only analysis of the
  // captured fields. Never auto-applies, auto-links, or auto-merges.
  const analyze = useAnalyzeCapture();
  const analyzeRef = useRef(analyze);
  analyzeRef.current = analyze;
  const [analysis, setAnalysis] = useState<CaptureAnalysis | null>(null);

  const runAnalyze = useCallback((values: ContactFormValues) => {
    const fields = buildCaptureFields(values);
    if (!hasAnyCaptureField(fields)) {
      setAnalysis(null);
      return;
    }
    analyzeRef.current.mutate(
      { data: { fields, includeAi: true } },
      { onSuccess: (res) => setAnalysis(res) },
    );
  }, []);

  // Debounce field edits (~600ms) before re-analyzing.
  useEffect(() => {
    const fields = buildCaptureFields(formValues);
    if (!hasAnyCaptureField(fields)) {
      setAnalysis(null);
      return;
    }
    const id = setTimeout(() => runAnalyze(formValues), 600);
    return () => clearTimeout(id);
  }, [formValues, runAnalyze]);

  // Apply a suggested value into the form (user-initiated only).
  const applySuggestion = useCallback((field: string, value: string) => {
    const key = FIELD_TO_FORM[field];
    if (!key) return;
    setFormValues((prev) => ({ ...prev, [key]: value }));
    setFormKey((k) => k + 1);
  }, []);
  const [imageVersion, setImageVersion] = useState(0);
  const [rotation, setRotation] = useState(0);

  const ocrLang = language === "ar" ? "ar" : "en";
  const base = getBaseUrl();
  const imageUri =
    scanId && base ? `${base}/api/scans/${scanId}/image?v=${imageVersion}` : null;
  const imageHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      "worklet";
      scale.value = Math.max(1, Math.min(savedScale.value * e.scale, 5));
    })
    .onEnd(() => {
      "worklet";
      savedScale.value = scale.value;
    });
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      "worklet";
      scale.value = 1;
      savedScale.value = 1;
    });
  const composedGesture = Gesture.Simultaneous(pinch, doubleTap);
  const animatedImageStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }, { rotate: `${rotation}deg` }],
  }));

  async function handleReprocess() {
    if (!scanId) return;
    try {
      const res = await reprocess.mutateAsync({ id: scanId, data: { appLanguage: ocrLang } });
      if (res.extractedData) {
        setExtracted(res.extractedData);
        setFormValues(buildFormValues(res.extractedData));
        setFormKey((k) => k + 1);
      }
    } catch {
      Alert.alert(t("scanReview.reprocessErrorTitle"), t("scanReview.reprocessErrorBody"));
    }
  }

  async function handleRerunAi() {
    if (!scanId) return;
    try {
      const res = await rerunAi.mutateAsync({ id: scanId });
      setScorePreview(res);
    } catch {
      Alert.alert(t("scanReview.aiErrorTitle"), t("scanReview.aiErrorBody"));
    }
  }

  async function handleReplaceImage() {
    if (!scanId) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(t("scanReview.permTitle"), t("scanReview.permBody"));
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 1,
    });
    if (picked.canceled || !picked.assets?.[0]) return;
    try {
      const manipulated = await ImageManipulator.manipulateAsync(
        picked.assets[0].uri,
        [{ resize: { width: 1400 } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );
      if (!manipulated.base64) return;
      const res = await replaceImage.mutateAsync({
        id: scanId,
        data: { imageData: `data:image/jpeg;base64,${manipulated.base64}`, appLanguage: ocrLang },
      });
      setImageVersion((v) => v + 1);
      if (res.extractedData) {
        setExtracted(res.extractedData);
        setFormValues(buildFormValues(res.extractedData));
        setFormKey((k) => k + 1);
      }
    } catch {
      Alert.alert(t("scanReview.replaceErrorTitle"), t("scanReview.replaceErrorBody"));
    }
  }

  const reviewBusy = reprocess.isPending || rerunAi.isPending || replaceImage.isPending;

  const confidence = parseNum(params.conf);
  const confidenceTone = useMemo(() => {
    if (confidence == null) return null;
    if (confidence >= 80) {
      return { label: t("scanReview.confidenceHigh"), color: "#16a34a" };
    }
    if (confidence >= 55) {
      return { label: t("scanReview.confidenceMedium"), color: "#d97706" };
    }
    return { label: t("scanReview.confidenceLow"), color: colors.destructive };
  }, [confidence, t, colors.destructive]);

  // Rows where the verbatim "as printed" value differs from what the form is
  // pre-filled with — so the user can verify the OCR translation. The original
  // is reference-only and never overwrites what's saved.
  const originalRows = useMemo(() => {
    const orig = extracted?.original;
    if (!orig) return [];
    const display: Record<string, string | null | undefined> = {
      firstName: extracted?.firstName,
      lastName: extracted?.lastName,
      arabicName: extracted?.arabicName,
      jobTitle: extracted?.jobTitle,
      company: extracted?.company,
      address: extracted?.address,
    };
    const seen = new Set<string>();
    const rows: { label: string; original: string; translated: string | null }[] = [];
    for (const f of ORIGINAL_FIELDS) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      const o = orig[f.key];
      if (!o) continue;
      const d = display[f.key] ?? null;
      if (d && d === o) continue; // identical — nothing to compare
      rows.push({
        label: t(`scanReview.fields.${f.labelKey}`),
        original: o,
        translated: d,
      });
    }
    return rows;
  }, [extracted, t]);

  async function handleSave(values: ContactFormValues) {
    const payload = {
      ...toContactPayload(values),
      eventId,
      latitude: gps.latitude,
      longitude: gps.longitude,
      gpsAccuracy: gps.gpsAccuracy,
      cardImageUrl: params.scanId ? `/api/scans/${params.scanId}/image` : null,
    };
    if (!isOnline) {
      const label =
        [payload.firstName, payload.lastName].filter(Boolean).join(" ") ||
        payload.contactCompany ||
        t("contacts.newContact");
      enqueueContact(payload, {
        label,
        source: params.source ?? "card",
        eventId,
        latitude: gps.latitude,
        longitude: gps.longitude,
        gpsAccuracy: gps.gpsAccuracy,
      });
      router.replace("/(tabs)/contacts");
      return;
    }
    try {
      await createContact.mutateAsync({ data: payload });
      router.replace("/(tabs)/contacts");
    } catch {
      // mutation error surfaced via createContact.isError below
    }
  }

  return (
    <KeyboardAwareScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{
        paddingHorizontal: 20,
        paddingTop: Platform.OS === "web" ? insets.top + 67 + 16 : 16,
        paddingBottom: insets.bottom + 40,
        flexGrow: 1,
      }}
      bottomOffset={20}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <View
        style={[
          styles.banner,
          {
            backgroundColor: colors.accent,
            borderRadius: colors.radius + 2,
            flexDirection: isRTL ? "row-reverse" : "row",
          },
        ]}
      >
        <View style={[styles.bannerIcon, { backgroundColor: colors.primary }]}>
          <Feather name="check" size={16} color="#FFFFFF" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.bannerTitle, { color: colors.foreground, textAlign }]}>
            {t("scanReview.scannedTitle", { source: sourceLabel })}
          </Text>
          <Text style={[styles.bannerSub, { color: colors.mutedForeground, textAlign }]}>
            {t("scanReview.subtitle")}
          </Text>
        </View>
      </View>

      {confidenceTone ? (
        <View
          style={[
            styles.confRow,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderRadius: colors.radius,
              flexDirection: isRTL ? "row-reverse" : "row",
            },
          ]}
        >
          <Feather name="activity" size={15} color={confidenceTone.color} />
          <Text style={[styles.confLabel, { color: colors.foreground, textAlign }]}>
            {t("scanReview.confidence")}: {confidence}%
          </Text>
          <View style={[styles.confPill, { backgroundColor: confidenceTone.color + "1A" }]}>
            <Text style={[styles.confPillText, { color: confidenceTone.color }]}>
              {confidenceTone.label}
            </Text>
          </View>
        </View>
      ) : null}

      {scanMeta ? (
        <View
          style={[
            styles.intelCard,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
          ]}
        >
          <View style={[styles.intelHeader, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
            <Feather name="cpu" size={15} color={colors.primary} />
            <Text style={[styles.intelHeading, { color: colors.foreground, textAlign }]}>
              {t("ocrIntel.title")}
            </Text>
          </View>
          <View style={styles.ocrMetaGrid}>
            {scanMeta.qualityScore != null ? (
              <Text style={[styles.ocrMetaItem, { color: colors.mutedForeground, textAlign }]}>
                {t("ocrIntel.quality")}: {scanMeta.qualityScore}/100
              </Text>
            ) : null}
            {scanMeta.model ? (
              <Text style={[styles.ocrMetaItem, { color: colors.mutedForeground, textAlign }]}>
                {t("ocrIntel.model")}: {scanMeta.model}
              </Text>
            ) : null}
            {scanMeta.promptVersion != null ? (
              <Text style={[styles.ocrMetaItem, { color: colors.mutedForeground, textAlign }]}>
                {t("ocrIntel.prompt")}: v{scanMeta.promptVersion}
              </Text>
            ) : null}
            {scanMeta.processingTimeMs != null ? (
              <Text style={[styles.ocrMetaItem, { color: colors.mutedForeground, textAlign }]}>
                {t("ocrIntel.processing")}: {scanMeta.processingTimeMs} ms
              </Text>
            ) : null}
            {scanMeta.extractionMethod ? (
              <Text style={[styles.ocrMetaItem, { color: colors.mutedForeground, textAlign }]}>
                {t("ocrIntel.method")}: {scanMeta.extractionMethod}
              </Text>
            ) : null}
          </View>
          {scanMeta.fieldConfidences && Object.keys(scanMeta.fieldConfidences).length > 0 ? (
            <View style={{ gap: 6 }}>
              <Text style={[styles.ocrFieldLabel, { color: colors.foreground, textAlign }]}>
                {t("ocrIntel.fieldConfidence")}
              </Text>
              <View style={[styles.ocrChipWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                {Object.entries(scanMeta.fieldConfidences).map(([f, c]) => (
                  <View key={f} style={[styles.ocrChip, { backgroundColor: colors.accent }]}>
                    <Text style={[styles.ocrChipText, { color: colors.primary }]}>
                      {f}: {Math.round(c)}%
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          ) : null}
        </View>
      ) : null}

      {imageUri ? (
        <View
          style={[
            styles.reviewCard,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 2 },
          ]}
        >
          <View style={[styles.reviewHeader, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
            <Feather name="crop" size={15} color={colors.primary} />
            <Text style={[styles.reviewHeading, { color: colors.foreground, textAlign }]}>
              {t("scanReview.ocrReviewTitle")}
            </Text>
          </View>

          <View style={[styles.imageWrap, { borderColor: colors.border, backgroundColor: colors.background }]}>
            <GestureDetector gesture={composedGesture}>
              <Animated.Image
                source={{ uri: imageUri, headers: imageHeaders }}
                style={[styles.reviewImage, animatedImageStyle]}
                resizeMode="contain"
              />
            </GestureDetector>
            <Pressable
              onPress={() => setRotation((r) => (r + 90) % 360)}
              style={[styles.rotateBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
              hitSlop={8}
            >
              <Feather name="rotate-cw" size={16} color={colors.foreground} />
            </Pressable>
          </View>
          <Text style={[styles.zoomHint, { color: colors.mutedForeground, textAlign }]}>
            {t("scanReview.zoomHint")}
          </Text>

          <View style={styles.reviewActions}>
            <ReviewAction
              icon="refresh-cw"
              label={t("scanReview.reprocess")}
              onPress={handleReprocess}
              loading={reprocess.isPending}
              disabled={reviewBusy}
            />
            <ReviewAction
              icon="zap"
              label={t("scanReview.rerunAi")}
              onPress={handleRerunAi}
              loading={rerunAi.isPending}
              disabled={reviewBusy}
            />
            <ReviewAction
              icon="image"
              label={t("scanReview.replaceImage")}
              onPress={handleReplaceImage}
              loading={replaceImage.isPending}
              disabled={reviewBusy}
            />
          </View>

          {scorePreview ? (
            <View style={[styles.scoreBox, { borderTopColor: colors.border }]}>
              <View style={[styles.scoreRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                <Text style={[styles.scoreValue, { color: colors.foreground }]}>
                  {scorePreview.score}
                  <Text style={[styles.scoreMax, { color: colors.mutedForeground }]}> / 100</Text>
                </Text>
                <View style={[styles.tempPill, { backgroundColor: colors.accent }]}>
                  <Text style={[styles.tempText, { color: colors.primary }]}>
                    {t(`leads.${scorePreview.temperature}`, { defaultValue: scorePreview.temperature })}
                  </Text>
                </View>
              </View>
              {scorePreview.reasoning ? (
                <Text style={[styles.scoreReason, { color: colors.mutedForeground, textAlign }]}>
                  {scorePreview.reasoning}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}

      {originalRows.length > 0 ? (
        <View
          style={[
            styles.origBox,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 2 },
          ]}
        >
          <Text style={[styles.origHeading, { color: colors.mutedForeground, textAlign }]}>
            {t("scanReview.originalLabel")}
          </Text>
          {originalRows.map((r, i) => (
            <View
              key={`${r.label}-${i}`}
              style={[
                styles.origRow,
                i > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth },
              ]}
            >
              <Text style={[styles.origFieldLabel, { color: colors.mutedForeground, textAlign }]}>
                {r.label}
              </Text>
              <View
                style={[
                  styles.origValues,
                  { flexDirection: isRTL ? "row-reverse" : "row" },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.origTag, { color: colors.mutedForeground, textAlign }]}>
                    {t("scanReview.original")}
                  </Text>
                  <Text
                    style={[styles.origValue, { color: colors.foreground }]}
                    numberOfLines={2}
                  >
                    {r.original}
                  </Text>
                </View>
                {r.translated ? (
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.origTag, { color: colors.mutedForeground, textAlign }]}>
                      {t("scanReview.translated")}
                    </Text>
                    <Text
                      style={[styles.origValue, { color: colors.foreground }]}
                      numberOfLines={2}
                    >
                      {r.translated}
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {createContact.isError ? (
        <View
          style={[
            styles.errorBox,
            {
              backgroundColor: colors.destructive + "14",
              borderRadius: colors.radius,
              flexDirection: isRTL ? "row-reverse" : "row",
            },
          ]}
        >
          <Feather name="alert-circle" size={15} color={colors.destructive} />
          <Text style={[styles.errorText, { color: colors.destructive, textAlign }]}>
            {t("scanReview.saveError")}
          </Text>
        </View>
      ) : null}

      <CaptureIntelligence
        analysis={analysis}
        loading={analyze.isPending}
        onApply={applySuggestion}
        onRecheck={() => runAnalyze(formValues)}
      />

      <ContactForm
        key={formKey}
        initial={formValues}
        submitLabel={
          createContact.isPending ? t("scanReview.saving") : t("scanReview.saveContact")
        }
        submitting={createContact.isPending}
        onSubmit={handleSave}
        onChange={setFormValues}
      />
    </KeyboardAwareScrollView>
  );
}

// Analyze field → contact-form key. `company` maps to the form's contactCompany.
// Fields with no matching form input (e.g. postalCode) are intentionally absent
// so their suggestions render without an Apply action.
const FIELD_TO_FORM: Record<string, keyof ContactFormValues> = {
  firstName: "firstName",
  lastName: "lastName",
  jobTitle: "jobTitle",
  company: "contactCompany",
  email: "email",
  mobile: "mobile",
  officePhone: "officePhone",
  website: "website",
  linkedin: "linkedin",
  country: "country",
  address: "address",
  city: "city",
  postalCode: "postalCode",
};

/** Map the review form values to the analyze request body (company→company). */
function buildCaptureFields(v: ContactFormValues): CaptureFields {
  const clean = (s: string): string | undefined => {
    const trimmed = s.trim();
    return trimmed.length ? trimmed : undefined;
  };
  return {
    firstName: clean(v.firstName),
    lastName: clean(v.lastName),
    jobTitle: clean(v.jobTitle),
    company: clean(v.contactCompany),
    email: clean(v.email),
    mobile: clean(v.mobile),
    officePhone: clean(v.officePhone),
    website: clean(v.website),
    linkedin: clean(v.linkedin),
    country: clean(v.country),
    address: clean(v.address),
    city: clean(v.city),
    postalCode: clean(v.postalCode),
  };
}

function hasAnyCaptureField(f: CaptureFields): boolean {
  return Object.values(f).some((v) => v != null && v !== "");
}

/**
 * Capture Intelligence panel (Stage 5E). Advisory-only surface: duplicate
 * warning, existing-contact matches, organization matches, field validation,
 * and smart suggestions with a user-initiated Apply. Never auto-applies,
 * auto-links, or auto-merges.
 */
function CaptureIntelligence({
  analysis,
  loading,
  onApply,
  onRecheck,
}: {
  analysis: CaptureAnalysis | null;
  loading: boolean;
  onApply: (field: string, value: string) => void;
  onRecheck: () => void;
}) {
  const colors = useColors();
  const router = useRouter();
  const { t, isRTL, textAlign } = useLocale();

  if (!analysis && !loading) return null;

  const dup = analysis?.duplicateWarning;
  const contactMatches = analysis?.contactMatches ?? [];
  const orgMatches = analysis?.organizationMatches ?? [];
  const validationIssues = (analysis?.validation.validations ?? []).filter(
    (v) => v.status === "invalid" || v.status === "warning",
  );
  const detectedCountry = analysis?.validation.detectedCountry ?? null;
  const detectedDialCode = analysis?.validation.detectedDialCode ?? null;
  const suggestions = analysis?.suggestions ?? [];
  const aiDegraded = analysis?.aiDegraded ?? false;
  const similarWarnings = analysis?.similarWarnings ?? [];
  const insufficient = analysis?.insufficient ?? [];

  const rowDir = isRTL ? "row-reverse" : "row";

  return (
    <View
      style={[
        styles.intelCard,
        { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 2 },
      ]}
    >
      <View style={[styles.intelHeader, { flexDirection: rowDir }]}>
        <Feather name="zap" size={15} color={colors.primary} />
        <Text style={[styles.intelHeading, { color: colors.foreground, textAlign }]}>
          {t("captureIntel.title")}
        </Text>
        {loading ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <Pressable onPress={onRecheck} hitSlop={8} style={[styles.recheckBtn, { flexDirection: rowDir }]}>
            <Feather name="refresh-cw" size={13} color={colors.primary} />
            <Text style={[styles.recheckText, { color: colors.primary }]}>
              {t("captureIntel.recheck")}
            </Text>
          </Pressable>
        )}
      </View>

      {aiDegraded ? (
        <Text style={[styles.intelNote, { color: colors.mutedForeground, textAlign }]}>
          {t("captureIntel.aiUnavailable")}
        </Text>
      ) : null}

      {/* Duplicate warning — advisory only, never auto-merges. */}
      {dup?.isLikelyDuplicate ? (
        <View
          style={[
            styles.dupBox,
            { backgroundColor: "#d9770614", borderColor: "#d97706", borderRadius: colors.radius },
          ]}
        >
          <View style={[styles.dupHeaderRow, { flexDirection: rowDir }]}>
            <Feather name="alert-triangle" size={15} color="#d97706" />
            <Text style={[styles.dupTitle, { color: "#b45309", textAlign }]}>
              {t("captureIntel.duplicateTitle")}
            </Text>
          </View>
          {dup.message ? (
            <Text style={[styles.dupMsg, { color: colors.foreground, textAlign }]}>{dup.message}</Text>
          ) : null}
          <Text style={[styles.dupSub, { color: colors.mutedForeground, textAlign }]}>
            {t("captureIntel.duplicateMatch", { confidence: Math.round(dup.topMatchConfidence) })}
          </Text>
        </View>
      ) : null}

      {/* Existing contact matches — tappable to the contact detail screen. */}
      {contactMatches.length > 0 ? (
        <View style={styles.intelSection}>
          <Text style={[styles.intelSectionTitle, { color: colors.mutedForeground, textAlign }]}>
            {t("captureIntel.contactMatchesTitle")}
          </Text>
          {contactMatches.map((c: ContactMatch) => (
            <Pressable
              key={c.contactId}
              onPress={() => router.push(`/contact/${c.contactId}`)}
              style={[
                styles.matchRow,
                { borderColor: colors.border, borderRadius: colors.radius, flexDirection: rowDir },
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.matchName, { color: colors.foreground, textAlign }]} numberOfLines={1}>
                  {c.fullName || c.email || c.contactCompany || `#${c.contactId}`}
                </Text>
                {c.reasons.length > 0 ? (
                  <Text style={[styles.matchReason, { color: colors.mutedForeground, textAlign }]} numberOfLines={2}>
                    {c.reasons.join(" · ")}
                  </Text>
                ) : null}
                {c.isCustomer || c.isLead || c.isDecisionMaker ? (
                  <View style={[styles.flagRow, { flexDirection: rowDir }]}>
                    {c.isCustomer ? (
                      <View style={[styles.flagPill, { backgroundColor: "#05966914" }]}>
                        <Text style={[styles.flagPillText, { color: "#059669" }]}>
                          {t("captureIntel.existingCustomer")}
                        </Text>
                      </View>
                    ) : null}
                    {c.isLead && !c.isCustomer ? (
                      <View style={[styles.flagPill, { backgroundColor: "#0284c714" }]}>
                        <Text style={[styles.flagPillText, { color: "#0284c7" }]}>
                          {typeof c.leadCount === "number" && c.leadCount > 1
                            ? t("captureIntel.activeLeadCount", { count: c.leadCount })
                            : t("captureIntel.activeLead")}
                        </Text>
                      </View>
                    ) : null}
                    {c.isDecisionMaker ? (
                      <View style={[styles.flagPill, { backgroundColor: "#7c3aed14" }]}>
                        <Text style={[styles.flagPillText, { color: "#7c3aed" }]}>
                          {t("captureIntel.decisionMaker")}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
              <View style={[styles.confChip, { backgroundColor: colors.accent }]}>
                <Text style={[styles.confChipText, { color: colors.primary }]}>
                  {t("captureIntel.matchConfidence", { confidence: Math.round(c.confidence) })}
                </Text>
              </View>
              <Feather name={isRTL ? "chevron-left" : "chevron-right"} size={16} color={colors.mutedForeground} />
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* Organization matches. */}
      {orgMatches.length > 0 ? (
        <View style={styles.intelSection}>
          <Text style={[styles.intelSectionTitle, { color: colors.mutedForeground, textAlign }]}>
            {t("captureIntel.orgMatchesTitle")}
          </Text>
          {orgMatches.map((o: OrganizationMatch) => (
            <Pressable
              key={o.organizationId}
              onPress={() => router.push(`/company/${o.organizationId}`)}
              style={[
                styles.matchRow,
                { borderColor: colors.border, borderRadius: colors.radius, flexDirection: rowDir },
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.matchName, { color: colors.foreground, textAlign }]} numberOfLines={1}>
                  {o.name}
                </Text>
                <Text style={[styles.matchReason, { color: colors.mutedForeground, textAlign }]} numberOfLines={1}>
                  {t("captureIntel.orgCounts", { contacts: o.contactCount, leads: o.leadCount })}
                </Text>
                {o.relationshipSummary ? (
                  <Text style={[styles.matchReason, { color: colors.mutedForeground, textAlign }]} numberOfLines={2}>
                    {o.relationshipSummary}
                  </Text>
                ) : null}
                {(o.recentEvents?.length ?? 0) > 0 ? (
                  <Text style={[styles.matchReason, { color: colors.mutedForeground, textAlign }]} numberOfLines={1}>
                    {t("captureIntel.seenAt", { events: o.recentEvents!.join(isRTL ? "، " : ", ") })}
                  </Text>
                ) : null}
              </View>
              <View style={[styles.matchTypePill, { backgroundColor: colors.accent }]}>
                <Text style={[styles.matchTypeText, { color: colors.primary }]}>
                  {o.matchType === "exact" ? t("captureIntel.matchExact") : t("captureIntel.matchPartial")}
                </Text>
              </View>
              <Feather name={isRTL ? "chevron-left" : "chevron-right"} size={16} color={colors.mutedForeground} />
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* Similar-record warnings — advisory only, never auto-links or merges. */}
      {similarWarnings.length > 0 ? (
        <View style={styles.intelSection}>
          <Text style={[styles.intelSectionTitle, { color: colors.mutedForeground, textAlign }]}>
            {t("captureIntel.similarTitle")}
          </Text>
          {similarWarnings.map((w, i) => {
            const inner = (
              <>
                <Feather name="alert-triangle" size={14} color="#d97706" />
                <Text style={[styles.validationText, { color: colors.foreground, textAlign }]} numberOfLines={3}>
                  {w.message}
                </Text>
                <View style={[styles.confChip, { backgroundColor: colors.accent }]}>
                  <Text style={[styles.confChipText, { color: colors.primary }]}>
                    {t("captureIntel.matchConfidence", { confidence: Math.round(w.confidence) })}
                  </Text>
                </View>
              </>
            );
            return w.contactId ? (
              <Pressable
                key={`${w.kind}-${i}`}
                onPress={() => router.push(`/contact/${w.contactId}`)}
                style={[styles.validationRow, { flexDirection: rowDir }]}
              >
                {inner}
              </Pressable>
            ) : (
              <View key={`${w.kind}-${i}`} style={[styles.validationRow, { flexDirection: rowDir }]}>
                {inner}
              </View>
            );
          })}
          <Text style={[styles.intelNote, { color: colors.mutedForeground, textAlign }]}>
            {t("captureIntel.similarAdvisory")}
          </Text>
        </View>
      ) : null}

      {/* Field validation issues + detected locale. */}
      {validationIssues.length > 0 || detectedCountry || detectedDialCode ? (
        <View style={styles.intelSection}>
          <Text style={[styles.intelSectionTitle, { color: colors.mutedForeground, textAlign }]}>
            {t("captureIntel.validationTitle")}
          </Text>
          {detectedCountry || detectedDialCode ? (
            <Text style={[styles.detectedText, { color: colors.mutedForeground, textAlign }]}>
              {detectedCountry && detectedDialCode
                ? t("captureIntel.detected", { country: detectedCountry, dialCode: detectedDialCode })
                : detectedCountry
                  ? t("captureIntel.detectedCountry", { country: detectedCountry })
                  : t("captureIntel.detectedDialCode", { dialCode: detectedDialCode })}
            </Text>
          ) : null}
          {validationIssues.map((v: FieldValidation, i: number) => {
            const tone = v.status === "invalid" ? colors.destructive : "#d97706";
            return (
              <View key={`${v.field}-${i}`} style={[styles.validationRow, { flexDirection: rowDir }]}>
                <Feather
                  name={v.status === "invalid" ? "x-circle" : "alert-circle"}
                  size={14}
                  color={tone}
                />
                <Text style={[styles.validationText, { color: colors.foreground, textAlign }]} numberOfLines={2}>
                  {v.message ||
                    (v.status === "invalid"
                      ? t("captureIntel.statusInvalid")
                      : t("captureIntel.statusWarning"))}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}

      {/* Smart suggestions — user-initiated Apply only. */}
      {suggestions.length > 0 ? (
        <View style={styles.intelSection}>
          <Text style={[styles.intelSectionTitle, { color: colors.mutedForeground, textAlign }]}>
            {t("captureIntel.suggestionsTitle")}
          </Text>
          {suggestions.map((s: SmartSuggestion, i: number) => {
            const canApply = !!FIELD_TO_FORM[s.field];
            const isAi = s.source === "ai";
            return (
              <View
                key={`${s.field}-${i}`}
                style={[
                  styles.suggestionRow,
                  { borderColor: colors.border, borderRadius: colors.radius, flexDirection: rowDir },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <View style={[styles.suggestionValueRow, { flexDirection: rowDir }]}>
                    <Text style={[styles.suggestionValue, { color: colors.foreground, textAlign }]} numberOfLines={1}>
                      {s.suggested}
                    </Text>
                    <View
                      style={[
                        styles.provBadge,
                        { backgroundColor: isAi ? colors.primary + "1A" : colors.accent },
                      ]}
                    >
                      <Text style={[styles.provBadgeText, { color: isAi ? colors.primary : colors.mutedForeground }]}>
                        {isAi ? t("captureIntel.aiBadge") : t("captureIntel.ruleBadge")}
                      </Text>
                    </View>
                  </View>
                  <Text style={[styles.suggestionReason, { color: colors.mutedForeground, textAlign }]} numberOfLines={2}>
                    {s.reason}
                  </Text>
                </View>
                {canApply ? (
                  <Pressable
                    onPress={() => onApply(s.field, s.suggested)}
                    style={[styles.applyBtn, { backgroundColor: colors.primary, borderRadius: colors.radius }]}
                  >
                    <Text style={styles.applyBtnText}>{t("captureIntel.apply")}</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      {/* Fields with no grounded suggestion — honest "not enough information". */}
      {insufficient.length > 0 ? (
        <View style={styles.intelSection}>
          <Text style={[styles.intelSectionTitle, { color: colors.mutedForeground, textAlign }]}>
            {t("captureIntel.insufficientTitle")}
          </Text>
          <Text style={[styles.intelNote, { color: colors.mutedForeground, textAlign }]}>
            {t("captureIntel.insufficientBody", {
              fields: insufficient
                .map((f) => t(`contacts.fields.${f}`, { defaultValue: f }))
                .join(isRTL ? "، " : ", "),
            })}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function ReviewAction({
  icon,
  label,
  onPress,
  loading,
  disabled,
}: {
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string;
  onPress: () => void;
  loading: boolean;
  disabled: boolean;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.reviewAction,
        {
          backgroundColor: colors.background,
          borderColor: colors.border,
          borderRadius: colors.radius,
          opacity: disabled && !loading ? 0.5 : 1,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : (
        <Feather name={icon} size={16} color={colors.primary} />
      )}
      <Text style={[styles.reviewActionText, { color: colors.foreground }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  intelCard: {
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginBottom: 16,
    gap: 12,
  },
  intelHeader: {
    alignItems: "center",
    gap: 8,
  },
  intelHeading: {
    fontSize: 14,
    fontFamily: FONT.semibold,
    flex: 1,
  },
  recheckBtn: {
    alignItems: "center",
    gap: 4,
  },
  recheckText: {
    fontSize: 12,
    fontFamily: FONT.semibold,
  },
  intelNote: {
    fontSize: 12,
    fontFamily: FONT.regular,
    marginTop: -4,
  },
  ocrMetaGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  ocrMetaItem: {
    fontSize: 12,
    fontFamily: FONT.regular,
    width: "48%",
  },
  ocrFieldLabel: {
    fontSize: 12,
    fontFamily: FONT.semibold,
  },
  ocrChipWrap: {
    flexWrap: "wrap",
    gap: 6,
  },
  ocrChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  ocrChipText: {
    fontSize: 11,
    fontFamily: FONT.medium,
  },
  dupBox: {
    borderWidth: 1,
    padding: 12,
    gap: 6,
  },
  dupHeaderRow: {
    alignItems: "center",
    gap: 8,
  },
  dupTitle: {
    fontSize: 13.5,
    fontFamily: FONT.semibold,
    flex: 1,
  },
  dupMsg: {
    fontSize: 13,
    fontFamily: FONT.medium,
    lineHeight: 18,
  },
  dupSub: {
    fontSize: 12,
    fontFamily: FONT.regular,
  },
  intelSection: {
    gap: 8,
  },
  intelSectionTitle: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  matchRow: {
    alignItems: "center",
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  matchName: {
    fontSize: 13.5,
    fontFamily: FONT.semibold,
  },
  matchReason: {
    fontSize: 12,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  confChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  flagRow: {
    flexWrap: "wrap",
    gap: 6,
    marginTop: 4,
  },
  flagPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  flagPillText: {
    fontSize: 11,
    fontFamily: FONT.semibold,
  },
  confChipText: {
    fontSize: 11,
    fontFamily: FONT.semibold,
  },
  matchTypePill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  matchTypeText: {
    fontSize: 11,
    fontFamily: FONT.semibold,
    textTransform: "capitalize",
  },
  detectedText: {
    fontSize: 12,
    fontFamily: FONT.regular,
  },
  validationRow: {
    alignItems: "center",
    gap: 8,
  },
  validationText: {
    flex: 1,
    fontSize: 12.5,
    fontFamily: FONT.regular,
    lineHeight: 17,
  },
  suggestionRow: {
    alignItems: "center",
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  suggestionValueRow: {
    alignItems: "center",
    gap: 8,
  },
  suggestionValue: {
    fontSize: 13.5,
    fontFamily: FONT.semibold,
    flexShrink: 1,
  },
  provBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  provBadgeText: {
    fontSize: 10,
    fontFamily: FONT.semibold,
    letterSpacing: 0.3,
  },
  suggestionReason: {
    fontSize: 12,
    fontFamily: FONT.regular,
    marginTop: 2,
    lineHeight: 16,
  },
  applyBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  applyBtnText: {
    color: "#FFFFFF",
    fontSize: 12.5,
    fontFamily: FONT.semibold,
  },
  reviewCard: {
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    marginBottom: 16,
    gap: 12,
  },
  reviewHeader: {
    alignItems: "center",
    gap: 8,
  },
  reviewHeading: {
    fontSize: 14,
    fontFamily: FONT.semibold,
    flex: 1,
  },
  imageWrap: {
    width: "100%",
    height: 220,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    overflow: "hidden",
  },
  reviewImage: {
    width: "100%",
    height: "100%",
  },
  rotateBtn: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  zoomHint: {
    fontSize: 11.5,
    fontFamily: FONT.regular,
    marginTop: -4,
  },
  reviewActions: {
    flexDirection: "row",
    gap: 8,
  },
  reviewAction: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 12,
    alignItems: "center",
    gap: 6,
  },
  reviewActionText: {
    fontSize: 11.5,
    fontFamily: FONT.medium,
  },
  scoreBox: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    gap: 6,
  },
  scoreRow: {
    alignItems: "center",
    gap: 10,
  },
  scoreValue: {
    fontSize: 22,
    fontFamily: FONT.bold,
  },
  scoreMax: {
    fontSize: 13,
    fontFamily: FONT.regular,
  },
  tempPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  tempText: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    textTransform: "capitalize",
  },
  scoreReason: {
    fontSize: 13,
    fontFamily: FONT.regular,
    lineHeight: 19,
  },
  banner: {
    alignItems: "center",
    gap: 12,
    padding: 14,
    marginBottom: 18,
  },
  bannerIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  bannerTitle: {
    fontSize: 15.5,
    fontFamily: FONT.semibold,
  },
  bannerSub: {
    fontSize: 13,
    fontFamily: FONT.regular,
    marginTop: 1,
  },
  confRow: {
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    marginBottom: 14,
  },
  confLabel: {
    flex: 1,
    fontSize: 13,
    fontFamily: FONT.medium,
  },
  confPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  confPillText: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
  },
  origBox: {
    borderWidth: 1,
    padding: 14,
    marginBottom: 16,
  },
  origHeading: {
    fontSize: 12,
    fontFamily: FONT.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 10,
  },
  origRow: {
    paddingVertical: 8,
  },
  origFieldLabel: {
    fontSize: 12,
    fontFamily: FONT.medium,
    marginBottom: 4,
  },
  origValues: {
    gap: 12,
  },
  origTag: {
    fontSize: 10.5,
    fontFamily: FONT.medium,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    marginBottom: 2,
  },
  origValue: {
    fontSize: 14,
    fontFamily: FONT.regular,
  },
  errorBox: {
    alignItems: "center",
    gap: 8,
    padding: 12,
    marginBottom: 16,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FONT.medium,
  },
});
