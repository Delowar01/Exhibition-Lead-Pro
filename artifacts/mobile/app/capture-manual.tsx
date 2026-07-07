import { Feather } from "@/components/icons";
import { useRouter } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import React from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
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
  const { isOnline, enqueueContact } = useOffline();
  const { activeEventId } = useSettings();
  const eventId = activeEventId ?? null;

  async function handleSave(values: ContactFormValues) {
    const payload = { ...toContactPayload(values), eventId };
    if (!isOnline) {
      enqueueContact(payload, { label: payloadLabel(payload, t("contacts.newContact")), source: "manual", eventId });
      router.replace("/contacts");
      return;
    }
    try {
      await createContact.mutateAsync({ data: payload });
      router.replace("/contacts");
    } catch {
      // error surfaced below
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
