import { Feather } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type Contact,
  useGetContact,
  useUpdateContact,
} from "@workspace/api-client-react";

import {
  ContactForm,
  type ContactFormValues,
  toContactPayload,
} from "@/components/ContactForm";
import { ErrorState, FONT, LoadingState } from "@/components/ui";
import { useColors } from "@/hooks/useColors";

function toFormValues(c: Contact): ContactFormValues {
  return {
    firstName: c.firstName ?? "",
    lastName: c.lastName ?? "",
    jobTitle: c.jobTitle ?? "",
    contactCompany: c.contactCompany ?? "",
    email: c.email ?? "",
    mobile: c.mobile ?? "",
    officePhone: c.officePhone ?? "",
    website: c.website ?? "",
    linkedin: c.linkedin ?? "",
    country: c.country ?? "",
    address: c.address ?? "",
    notes: c.notes ?? "",
  };
}

export default function EditContactScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const contactId = Number(id);

  const query = useGetContact(contactId);
  const updateContact = useUpdateContact();

  const contact = query.data;

  async function handleSave(values: ContactFormValues) {
    if (!contact) return;
    try {
      await updateContact.mutateAsync({
        id: contact.id,
        data: toContactPayload(values),
      });
      router.back();
    } catch {
      // error surfaced below
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: "Edit contact",
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.foreground,
          headerTitleStyle: { fontFamily: FONT.semibold },
        }}
      />

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError || !contact ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <KeyboardAwareScrollView
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 16,
            paddingBottom: insets.bottom + 40,
          }}
          bottomOffset={20}
          showsVerticalScrollIndicator={false}
        >
          {updateContact.isError ? (
            <View
              style={[
                styles.errorBox,
                { backgroundColor: colors.destructive + "14", borderRadius: colors.radius },
              ]}
            >
              <Feather name="alert-circle" size={15} color={colors.destructive} />
              <Text style={[styles.errorText, { color: colors.destructive }]}>
                Couldn't save your changes. Check the details and try again.
              </Text>
            </View>
          ) : null}

          <ContactForm
            initial={toFormValues(contact)}
            submitLabel="Save changes"
            submitting={updateContact.isPending}
            onSubmit={handleSave}
          />
        </KeyboardAwareScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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
