import { Feather } from "@expo/vector-icons";
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
import { useColors } from "@/hooks/useColors";

function payloadLabel(payload: { firstName?: string | null; lastName?: string | null; contactCompany?: string | null }): string {
  return (
    [payload.firstName, payload.lastName].filter(Boolean).join(" ") ||
    payload.contactCompany ||
    "New contact"
  );
}

export default function CaptureManualScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const createContact = useCreateContact();
  const { isOnline, enqueueContact } = useOffline();

  async function handleSave(values: ContactFormValues) {
    const payload = toContactPayload(values);
    if (!isOnline) {
      enqueueContact(payload, { label: payloadLabel(payload), source: "manual" });
      router.replace("/(tabs)/contacts");
      return;
    }
    try {
      await createContact.mutateAsync({ data: payload });
      router.replace("/(tabs)/contacts");
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
      }}
      bottomOffset={20}
      showsVerticalScrollIndicator={false}
    >
      <Text style={[styles.intro, { color: colors.mutedForeground }]}>
        Add a contact by hand — only a name or company is required to start.
      </Text>

      {createContact.isError ? (
        <View style={[styles.errorBox, { backgroundColor: colors.destructive + "14", borderRadius: colors.radius }]}>
          <Feather name="alert-circle" size={15} color={colors.destructive} />
          <Text style={[styles.errorText, { color: colors.destructive }]}>
            Couldn't save this contact. Check the details and try again.
          </Text>
        </View>
      ) : null}

      <ContactForm
        initial={EMPTY_CONTACT}
        submitLabel="Save contact"
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
