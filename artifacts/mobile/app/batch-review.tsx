import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type ExtractedCardData,
  useCreateContact,
  useCreateScan,
} from "@workspace/api-client-react";

import {
  ContactForm,
  EMPTY_CONTACT,
  toContactPayload,
  type ContactFormValues,
} from "@/components/ContactForm";
import { FONT, LoadingState, PrimaryButton } from "@/components/ui";
import { useSettings } from "@/contexts/SettingsContext";
import { useColors } from "@/hooks/useColors";
import {
  type BatchCapture,
  clearBatchCaptures,
  getBatchCaptures,
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
    website: extracted.website ?? "",
    linkedin: extracted.linkedin ?? "",
    address: extracted.address ?? "",
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
  const { activeEventId } = useSettings();
  const eventId = activeEventId ?? null;

  // Snapshot the buffer once; the store is cleared as we go.
  const captures = useMemo<BatchCapture[]>(() => getBatchCaptures(), []);
  const total = captures.length;

  const [index, setIndex] = useState(0);
  const [savedCount, setSavedCount] = useState(0);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState(false);
  const [values, setValues] = useState<ContactFormValues | null>(null);
  const formKey = useRef(0);

  const current = captures[index];

  const runOcr = useCallback(
    async (item: BatchCapture) => {
      setOcrLoading(true);
      setOcrError(false);
      setValues(null);
      try {
        const scan = await createScan.mutateAsync({
          data: {
            imageData: item.imageData,
            eventId,
            latitude: item.latitude,
            longitude: item.longitude,
            gpsAccuracy: item.gpsAccuracy,
          },
        });
        formKey.current += 1;
        setValues(extractedToValues(scan.extractedData ?? {}));
      } catch {
        setOcrError(true);
        formKey.current += 1;
        setValues({ ...EMPTY_CONTACT });
      } finally {
        setOcrLoading(false);
      }
    },
    [createScan, eventId],
  );

  useEffect(() => {
    if (!current) return;
    void runOcr(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  function finish() {
    clearBatchCaptures();
    router.replace("/(tabs)/contacts");
  }

  function advance() {
    if (index + 1 >= total) {
      finish();
      return;
    }
    setIndex((i) => i + 1);
  }

  async function handleSave(formValues: ContactFormValues) {
    const payload = {
      ...toContactPayload(formValues),
      eventId,
      latitude: current?.latitude ?? null,
      longitude: current?.longitude ?? null,
      gpsAccuracy: current?.gpsAccuracy ?? null,
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
        <Text style={[styles.title, { color: colors.foreground }]}>Nothing to review</Text>
        <Text style={[styles.sub, { color: colors.mutedForeground }]}>
          No batch captures were found.
        </Text>
        <View style={{ height: 20 }} />
        <PrimaryButton label="Back to contacts" icon="arrow-left" onPress={finish} />
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
            {index + 1} of {total} · {savedCount} saved
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
            Extracting card details…
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
            <View style={[styles.errorBox, { backgroundColor: colors.destructive + "14", borderRadius: colors.radius }]}>
              <Feather name="alert-circle" size={15} color={colors.destructive} />
              <Text style={[styles.errorText, { color: colors.destructive }]}>
                Couldn't read this card automatically. Enter the details manually or skip.
              </Text>
            </View>
          ) : null}

          {createContact.isError ? (
            <View style={[styles.errorBox, { backgroundColor: colors.destructive + "14", borderRadius: colors.radius }]}>
              <Feather name="alert-circle" size={15} color={colors.destructive} />
              <Text style={[styles.errorText, { color: colors.destructive }]}>
                Couldn't save this contact. Check the details and try again.
              </Text>
            </View>
          ) : null}

          <ContactForm
            key={formKey.current}
            initial={values}
            submitLabel={index + 1 >= total ? "Save & finish" : "Save & next"}
            submitting={createContact.isPending}
            onSubmit={handleSave}
          />

          <Pressable onPress={skip} style={styles.skipBtn} disabled={createContact.isPending}>
            <Text style={[styles.skipText, { color: colors.mutedForeground }]}>
              Skip this card
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
  skipBtn: { alignItems: "center", paddingVertical: 16 },
  skipText: { fontSize: 15, fontFamily: FONT.medium },
});
