import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import React, { useMemo } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type ExtractedCardData,
  useCreateContact,
} from "@workspace/api-client-react";

import {
  ContactForm,
  EMPTY_CONTACT,
  toContactPayload,
  type ContactFormValues,
} from "@/components/ContactForm";
import { FONT } from "@/components/ui";
import { useColors } from "@/hooks/useColors";

const SOURCE_LABEL: Record<string, string> = {
  card: "Business card",
  badge: "Event badge",
  qr: "QR code",
};

export default function ScanReviewScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ data?: string; source?: string }>();
  const createContact = useCreateContact();

  const initial = useMemo<ContactFormValues>(() => {
    let extracted: ExtractedCardData = {};
    try {
      extracted = params.data ? JSON.parse(params.data) : {};
    } catch {
      extracted = {};
    }
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
  }, [params.data]);

  const sourceLabel = SOURCE_LABEL[params.source ?? "card"] ?? "Scan";

  async function handleSave(values: ContactFormValues) {
    try {
      await createContact.mutateAsync({ data: toContactPayload(values) });
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
      <View style={[styles.banner, { backgroundColor: colors.accent, borderRadius: colors.radius + 2 }]}>
        <View style={[styles.bannerIcon, { backgroundColor: colors.primary }]}>
          <Feather name="check" size={16} color="#FFFFFF" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.bannerTitle, { color: colors.foreground }]}>
            {sourceLabel} scanned
          </Text>
          <Text style={[styles.bannerSub, { color: colors.mutedForeground }]}>
            Review the extracted details, then save.
          </Text>
        </View>
      </View>

      {createContact.isError ? (
        <View style={[styles.errorBox, { backgroundColor: colors.destructive + "14", borderRadius: colors.radius }]}>
          <Feather name="alert-circle" size={15} color={colors.destructive} />
          <Text style={[styles.errorText, { color: colors.destructive }]}>
            Couldn't save this contact. Check the details and try again.
          </Text>
        </View>
      ) : null}

      <ContactForm
        initial={initial}
        submitLabel="Save contact"
        submitting={createContact.isPending}
        onSubmit={handleSave}
      />
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
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
