import { Feather } from "@/components/icons";
import React, { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { FONT, PrimaryButton } from "@/components/ui";
import { useColors } from "@/hooks/useColors";

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
  label: string;
  icon: keyof typeof Feather.glyphMap;
  placeholder: string;
  keyboardType?: "default" | "email-address" | "phone-pad" | "url";
  autoCapitalize?: "none" | "words" | "sentences";
  multiline?: boolean;
  half?: boolean;
}

const FIELDS: FieldConfig[] = [
  { key: "firstName", label: "First name", icon: "user", placeholder: "Jane", autoCapitalize: "words", half: true },
  { key: "lastName", label: "Last name", icon: "user", placeholder: "Doe", autoCapitalize: "words", half: true },
  { key: "jobTitle", label: "Job title", icon: "briefcase", placeholder: "Sales Director", autoCapitalize: "words" },
  { key: "contactCompany", label: "Company", icon: "home", placeholder: "Acme Inc.", autoCapitalize: "words" },
  { key: "email", label: "Email", icon: "mail", placeholder: "jane@acme.com", keyboardType: "email-address", autoCapitalize: "none" },
  { key: "mobile", label: "Mobile", icon: "smartphone", placeholder: "+971 50 000 0000", keyboardType: "phone-pad", half: true },
  { key: "officePhone", label: "Office", icon: "phone", placeholder: "+971 4 000 0000", keyboardType: "phone-pad", half: true },
  { key: "website", label: "Website", icon: "globe", placeholder: "acme.com", keyboardType: "url", autoCapitalize: "none" },
  { key: "linkedin", label: "LinkedIn", icon: "linkedin", placeholder: "linkedin.com/in/jane", keyboardType: "url", autoCapitalize: "none" },
  { key: "country", label: "Country", icon: "map-pin", placeholder: "UAE", autoCapitalize: "words", half: true },
  { key: "address", label: "Address", icon: "map", placeholder: "Dubai World Trade Centre", autoCapitalize: "words", half: true },
  { key: "notes", label: "Notes", icon: "file-text", placeholder: "Met at GITEX — interested in enterprise plan", autoCapitalize: "sentences", multiline: true },
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
  const [values, setValues] = useState<ContactFormValues>(initial);

  function update(key: keyof ContactFormValues, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function renderField(f: FieldConfig) {
    return (
      <View key={f.key} style={[styles.fieldWrap, f.half && styles.half]}>
        <Text style={[styles.label, { color: colors.mutedForeground }]}>{f.label}</Text>
        <View
          style={[
            styles.inputWrap,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderRadius: colors.radius + 2,
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
            onChangeText={(t) => update(f.key, t)}
            placeholder={f.placeholder}
            placeholderTextColor={colors.mutedForeground}
            keyboardType={f.keyboardType ?? "default"}
            autoCapitalize={f.autoCapitalize ?? "sentences"}
            autoCorrect={false}
            multiline={f.multiline}
            style={[
              styles.input,
              { color: colors.foreground },
              f.multiline && { height: 84, textAlignVertical: "top" },
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
