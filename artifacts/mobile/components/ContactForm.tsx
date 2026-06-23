import { Feather } from "@/components/icons";
import React, { useState } from "react";
import { Platform, StyleSheet, Text, TextInput, View } from "react-native";

import { FONT, PrimaryButton } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";

export interface ContactFormValues {
  firstName: string;
  lastName: string;
  jobTitle: string;
  contactCompany: string;
  email: string;
  mobile: string;
  officePhone: string;
  website: string;
  linkedin: string;
  country: string;
  address: string;
  notes: string;
}

export const EMPTY_CONTACT: ContactFormValues = {
  firstName: "",
  lastName: "",
  jobTitle: "",
  contactCompany: "",
  email: "",
  mobile: "",
  officePhone: "",
  website: "",
  linkedin: "",
  country: "",
  address: "",
  notes: "",
};

/** Strips empty strings to null for the API payload. */
export function toContactPayload(values: ContactFormValues) {
  const clean = (v: string) => {
    const t = v.trim();
    return t.length ? t : null;
  };
  const firstName = clean(values.firstName);
  const lastName = clean(values.lastName);
  return {
    firstName,
    lastName,
    jobTitle: clean(values.jobTitle),
    contactCompany: clean(values.contactCompany),
    email: clean(values.email),
    mobile: clean(values.mobile),
    officePhone: clean(values.officePhone),
    website: clean(values.website),
    linkedin: clean(values.linkedin),
    country: clean(values.country),
    address: clean(values.address),
    notes: clean(values.notes),
  };
}

interface FieldConfig {
  key: keyof ContactFormValues;
  labelKey: string;
  icon: keyof typeof Feather.glyphMap;
  /** Static placeholder key under contacts.placeholders, when not country-aware. */
  placeholderKey?: string;
  /** Country-aware placeholder source from useLocale. */
  placeholderKind?: "phone" | "city" | "address" | "country";
  keyboardType?: "default" | "email-address" | "phone-pad" | "url";
  autoCapitalize?: "none" | "words" | "sentences";
  multiline?: boolean;
  half?: boolean;
}

const FIELDS: FieldConfig[] = [
  { key: "firstName", labelKey: "firstName", icon: "user", placeholderKey: "firstName", autoCapitalize: "words", half: true },
  { key: "lastName", labelKey: "lastName", icon: "user", placeholderKey: "lastName", autoCapitalize: "words", half: true },
  { key: "jobTitle", labelKey: "jobTitle", icon: "briefcase", placeholderKey: "jobTitle", autoCapitalize: "words" },
  { key: "contactCompany", labelKey: "company", icon: "home", placeholderKey: "company", autoCapitalize: "words" },
  { key: "email", labelKey: "email", icon: "mail", placeholderKey: "email", keyboardType: "email-address", autoCapitalize: "none" },
  { key: "mobile", labelKey: "mobile", icon: "smartphone", placeholderKind: "phone", keyboardType: "phone-pad", half: true },
  { key: "officePhone", labelKey: "phone", icon: "phone", placeholderKind: "phone", keyboardType: "phone-pad", half: true },
  { key: "website", labelKey: "website", icon: "globe", placeholderKey: "website", keyboardType: "url", autoCapitalize: "none" },
  { key: "linkedin", labelKey: "linkedin", icon: "linkedin", placeholderKey: "linkedin", keyboardType: "url", autoCapitalize: "none" },
  { key: "country", labelKey: "country", icon: "map-pin", placeholderKind: "country", autoCapitalize: "words", half: true },
  { key: "address", labelKey: "address", icon: "map", placeholderKind: "address", autoCapitalize: "words" },
  { key: "notes", labelKey: "notes", icon: "file-text", placeholderKey: "notes", autoCapitalize: "sentences", multiline: true },
];

export function ContactForm({
  initial,
  submitLabel,
  submitting,
  onSubmit,
}: {
  initial: ContactFormValues;
  submitLabel: string;
  submitting?: boolean;
  onSubmit: (values: ContactFormValues) => void;
}) {
  const colors = useColors();
  const {
    t,
    isRTL,
    textAlign,
    phonePlaceholder,
    addressPlaceholder,
    cityPlaceholder,
    countryName,
  } = useLocale();
  const [values, setValues] = useState<ContactFormValues>(initial);

  function update(key: keyof ContactFormValues, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function placeholderFor(f: FieldConfig): string {
    switch (f.placeholderKind) {
      case "phone":
        return phonePlaceholder;
      case "address":
        return addressPlaceholder;
      case "city":
        return cityPlaceholder;
      case "country":
        return countryName;
      default:
        return f.placeholderKey ? t(`contacts.placeholders.${f.placeholderKey}`) : "";
    }
  }

  function renderField(f: FieldConfig) {
    return (
      <View key={f.key} style={[styles.fieldWrap, f.half && styles.half]}>
        <Text numberOfLines={1} style={[styles.label, { color: colors.mutedForeground, textAlign }]}>
          {t(`contacts.fields.${f.labelKey}`)}
        </Text>
        <View
          style={[
            styles.inputWrap,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderRadius: colors.radius + 2,
              flexDirection: isRTL ? "row-reverse" : "row",
            },
            f.multiline && styles.inputWrapMultiline,
          ]}
        >
          <Feather
            name={f.icon}
            size={16}
            color={colors.mutedForeground}
            style={f.multiline ? { marginTop: 2 } : undefined}
          />
          <TextInput
            value={values[f.key]}
            onChangeText={(v) => update(f.key, v)}
            placeholder={placeholderFor(f)}
            placeholderTextColor={colors.mutedForeground}
            keyboardType={f.keyboardType ?? "default"}
            autoCapitalize={f.autoCapitalize ?? "sentences"}
            autoCorrect={false}
            multiline={f.multiline}
            style={[
              styles.input,
              { color: colors.foreground, textAlign },
              f.multiline && { height: 84, textAlignVertical: "top" },
              Platform.OS === "android" && { includeFontPadding: false },
            ]}
          />
        </View>
      </View>
    );
  }

  return (
    <View>
      <View style={styles.grid}>{FIELDS.map(renderField)}</View>
      <PrimaryButton
        label={submitLabel}
        icon="check"
        loading={submitting}
        onPress={() => onSubmit(values)}
        style={{ marginTop: 20 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 14,
  },
  fieldWrap: {
    width: "100%",
  },
  half: {
    width: "47%",
    flexGrow: 1,
  },
  label: {
    fontSize: 12.5,
    fontFamily: FONT.medium,
    marginBottom: 6,
  },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 50,
  },
  inputWrapMultiline: {
    height: 96,
    alignItems: "flex-start",
    paddingVertical: 12,
  },
  input: {
    flex: 1,
    fontSize: 15,
    fontFamily: FONT.regular,
    padding: 0,
  },
});
