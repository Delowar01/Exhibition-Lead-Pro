import { Feather } from "@/components/icons";
import { useRouter } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import React, { useRef } from "react";
import { Alert, Platform, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useCreateContact } from "@workspace/api-client-react";

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
import { answerWasLost, lostConnectionOrSession } from "@/lib/api-failure";
import { enqueueFailureKeys } from "@/lib/offline-queue-store-model";
import { withCaptureEvent } from "@/lib/settings-model";

function payloadLabel(
  payload: { firstName?: string | null; lastName?: string | null; contactCompany?: string | null },
  fallback: string,
): string {
  return (
    [payload.firstName, payload.lastName].filter(Boolean).join(" ") ||
    payload.contactCompany ||
    fallback
  );
}

export default function CaptureManualScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, textAlign, isRTL } = useLocale();
  const createContact = useCreateContact();
  const { isOnline, enqueueContact, captureOwner } = useOffline();
  const settings = useSettings();
  // One save at a time: a second tap while the first is being stored or sent must not queue the contact twice.
  const savingRef = useRef(false);

  async function handleSave(values: ContactFormValues) {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await saveContact(values);
    } finally {
      savingRef.current = false;
    }
  }

  async function saveContact(values: ContactFormValues) {
    // The account saving this contact (read before anything is sent).
    const savedBy = captureOwner();
    const payload = withCaptureEvent(toContactPayload(values), settings);
    const { eventId } = payload;
    // Keep the contact on the device. The form stays open — and the user is
    // told why — when it could NOT be kept (no signed-in tenant account, or the
    // device refused to store it).
    const keepOffline = async (answerLost = false) => {
      const kept = await enqueueContact(payload, {
        label: payloadLabel(payload, t("contacts.newContact")),
        source: "manual",
        eventId,
        owner: savedBy,
        // No scan stands behind a typed contact: if the request went out and
        // its answer was lost, a matching contact found at sync time may be this one.
        answerLost,
      });
      if (!kept.ok) {
        const msg = enqueueFailureKeys(kept.reason);
        Alert.alert(t(msg.title), t(msg.body));
        return;
      }
      router.replace("/contacts");
    };
    if (!isOnline) {
      await keepOffline();
      return;
    }
    try {
      await createContact.mutateAsync({ data: payload });
      router.replace("/contacts");
    } catch (err) {
      // The connection dropped (or the session ended) while saving: what was
      // typed is kept and sent later instead of being lost with this screen.
      if (lostConnectionOrSession(err)) await keepOffline(answerWasLost(err));
      // any other error is surfaced below
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
    >
      <Text style={[styles.intro, { color: colors.mutedForeground, textAlign }]}>
        {t("capture.manualIntro")}
      </Text>

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
            {t("contacts.saveError")}
          </Text>
        </View>
      ) : null}

      <ContactForm
        initial={EMPTY_CONTACT}
        submitLabel={t("contacts.saveContact")}
        submitting={createContact.isPending}
        onSubmit={handleSave}
      />
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  intro: {
    fontSize: 14,
    fontFamily: FONT.regular,
    lineHeight: 20,
    marginBottom: 18,
  },
  errorBox: {
    flexDirection: "row",
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
