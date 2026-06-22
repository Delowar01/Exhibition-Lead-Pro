import { Feather } from "@/components/icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import React, { useMemo } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type ExtractedCardData,
  type ExtractedCardOriginal,
  useCreateContact,
} from "@workspace/api-client-react";

import {
  ContactForm,
  EMPTY_CONTACT,
  toContactPayload,
  type ContactFormValues,
} from "@/components/ContactForm";
import { FONT } from "@/components/ui";
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
  }>();
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

  const extracted = useMemo<ExtractedCardData | null>(() => {
    try {
      return params.data ? (JSON.parse(params.data) as ExtractedCardData) : null;
    } catch {
      return null;
    }
  }, [params.data]);

  const initial = useMemo<ContactFormValues>(() => {
    const e = extracted ?? ({} as ExtractedCardData);
    return {
      ...EMPTY_CONTACT,
      firstName: e.firstName ?? "",
      lastName: e.lastName ?? "",
      jobTitle: e.jobTitle ?? "",
      contactCompany: e.company ?? "",
      email: e.email ?? "",
      mobile: e.mobile ?? "",
      website: e.website ?? "",
      linkedin: e.linkedin ?? "",
      address: e.address ?? "",
      notes: e.arabicName
        ? `${t("scanReview.arabicName")}: ${e.arabicName}`
        : "",
    };
  }, [extracted, t]);

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
      }}
      bottomOffset={20}
      showsVerticalScrollIndicator={false}
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

      <ContactForm
        initial={initial}
        submitLabel={
          createContact.isPending ? t("scanReview.saving") : t("scanReview.saveContact")
        }
        submitting={createContact.isPending}
        onSubmit={handleSave}
      />
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
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
