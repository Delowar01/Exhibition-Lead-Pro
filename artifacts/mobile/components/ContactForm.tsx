import { Feather } from "@/components/icons";
import React, { useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import {
  getListCrmOrganizationsQueryKey,
  useListCrmOrganizations,
} from "@workspace/api-client-react";

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
  city: string;
  postalCode: string;
  notes: string;
  organizationId: number | null;
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
  city: "",
  postalCode: "",
  notes: "",
  organizationId: null,
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
    city: clean(values.city),
    postalCode: clean(values.postalCode),
    notes: clean(values.notes),
    organizationId: values.organizationId ?? null,
  };
}

type StringKey = {
  [K in keyof ContactFormValues]: ContactFormValues[K] extends string ? K : never;
}[keyof ContactFormValues];

interface FieldConfig {
  key: StringKey;
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
  { key: "city", labelKey: "city", icon: "map-pin", placeholderKind: "city", autoCapitalize: "words", half: true },
  { key: "country", labelKey: "country", icon: "map-pin", placeholderKind: "country", autoCapitalize: "words", half: true },
  { key: "address", labelKey: "address", icon: "map", placeholderKind: "address", autoCapitalize: "words" },
  { key: "postalCode", labelKey: "postalCode", icon: "hash", placeholderKey: "postalCode", autoCapitalize: "none", half: true },
  { key: "notes", labelKey: "notes", icon: "file-text", placeholderKey: "notes", autoCapitalize: "sentences", multiline: true },
];

export function ContactForm({
  initial,
  submitLabel,
  submitting,
  onSubmit,
  onChange,
}: {
  initial: ContactFormValues;
  submitLabel: string;
  submitting?: boolean;
  onSubmit: (values: ContactFormValues) => void;
  /** Fires on every field change so a parent can react (e.g. live analysis). */
  onChange?: (values: ContactFormValues) => void;
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
  const [orgPickerOpen, setOrgPickerOpen] = useState(false);
  const [orgSearch, setOrgSearch] = useState("");

  const orgsQuery = useListCrmOrganizations(
    { limit: 200 },
    { query: { enabled: orgPickerOpen, queryKey: getListCrmOrganizationsQueryKey({ limit: 200 }) } },
  );
  const orgs = orgsQuery.data?.organizations ?? [];
  const filteredOrgs = orgSearch.trim()
    ? orgs.filter((o) => o.name.toLowerCase().includes(orgSearch.trim().toLowerCase()))
    : orgs;
  const selectedOrg = orgs.find((o) => o.id === values.organizationId);

  function commit(next: ContactFormValues) {
    setValues(next);
    onChange?.(next);
  }

  function update(key: keyof ContactFormValues, value: string) {
    commit({ ...values, [key]: value });
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

      <View style={styles.fieldWrap}>
        <Text numberOfLines={1} style={[styles.label, { color: colors.mutedForeground, textAlign }]}>
          {t("companies.linkLabel")}
        </Text>
        <Pressable
          onPress={() => setOrgPickerOpen(true)}
          style={[
            styles.inputWrap,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderRadius: colors.radius + 2,
              flexDirection: isRTL ? "row-reverse" : "row",
            },
          ]}
        >
          <Feather name="briefcase" size={16} color={colors.mutedForeground} />
          <Text
            numberOfLines={1}
            style={[
              styles.input,
              { color: selectedOrg ? colors.foreground : colors.mutedForeground, textAlign },
            ]}
          >
            {selectedOrg?.name ?? t("companies.none")}
          </Text>
          {values.organizationId != null ? (
            <Pressable
              onPress={() => commit({ ...values, organizationId: null })}
              hitSlop={10}
            >
              <Feather name="x" size={16} color={colors.mutedForeground} />
            </Pressable>
          ) : (
            <Feather name="chevron-down" size={18} color={colors.mutedForeground} />
          )}
        </Pressable>
      </View>

      <PrimaryButton
        label={submitLabel}
        icon="check"
        loading={submitting}
        onPress={() => onSubmit(values)}
        style={{ marginTop: 20 }}
      />

      <Modal
        visible={orgPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setOrgPickerOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setOrgPickerOpen(false)}>
          <Pressable
            style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.modalTitle, { color: colors.foreground, textAlign }]}>
              {t("companies.select")}
            </Text>
            <TextInput
              value={orgSearch}
              onChangeText={setOrgSearch}
              placeholder={t("companies.searchPlaceholder")}
              placeholderTextColor={colors.mutedForeground}
              autoCorrect={false}
              style={[
                styles.modalSearch,
                { color: colors.foreground, borderColor: colors.border, textAlign },
              ]}
            />
            <ScrollView
              style={{ maxHeight: 320 }}
              contentContainerStyle={{ flexGrow: 1 }}
              keyboardShouldPersistTaps="handled"
            >
              <Pressable
                style={[styles.modalRow, { borderBottomColor: colors.border }]}
                onPress={() => {
                  commit({ ...values, organizationId: null });
                  setOrgPickerOpen(false);
                }}
              >
                <Text style={[styles.modalRowText, { color: colors.mutedForeground, textAlign }]}>
                  {t("companies.none")}
                </Text>
              </Pressable>
              {orgsQuery.isLoading ? (
                <Text style={[styles.modalEmpty, { color: colors.mutedForeground }]}>
                  {t("common.loading")}
                </Text>
              ) : filteredOrgs.length === 0 ? (
                <Text style={[styles.modalEmpty, { color: colors.mutedForeground }]}>
                  {t("companies.empty")}
                </Text>
              ) : (
                filteredOrgs.map((o) => (
                  <Pressable
                    key={o.id}
                    style={[styles.modalRow, { borderBottomColor: colors.border }]}
                    onPress={() => {
                      commit({ ...values, organizationId: o.id });
                      setOrgPickerOpen(false);
                    }}
                  >
                    <Feather name="briefcase" size={15} color={colors.mutedForeground} />
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={[styles.modalRowText, { color: colors.foreground, textAlign }]}>
                        {o.name}
                      </Text>
                      {o.industry ? (
                        <Text numberOfLines={1} style={[styles.modalRowSub, { color: colors.mutedForeground, textAlign }]}>
                          {o.industry}
                        </Text>
                      ) : null}
                    </View>
                    {values.organizationId === o.id ? (
                      <Feather name="check" size={16} color={colors.primary} />
                    ) : null}
                  </Pressable>
                ))
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
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
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: 20,
  },
  modalCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
  },
  modalTitle: {
    fontSize: 16,
    fontFamily: FONT.semibold,
    marginBottom: 12,
  },
  modalSearch: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 44,
    fontSize: 15,
    fontFamily: FONT.regular,
    marginBottom: 8,
  },
  modalRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalRowText: {
    fontSize: 15,
    fontFamily: FONT.medium,
  },
  modalRowSub: {
    fontSize: 12.5,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  modalEmpty: {
    fontSize: 14,
    fontFamily: FONT.regular,
    paddingVertical: 20,
    textAlign: "center",
  },
});
