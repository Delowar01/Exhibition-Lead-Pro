import { Feather } from "@/components/icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { BusinessCard, BusinessCardInput } from "@workspace/api-client-react";

import { CardQR } from "@/components/CardQR";
import { Avatar, FONT, LoadingState, PrimaryButton } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { useCard } from "@/contexts/CardContext";
import { useOffline } from "@/contexts/OfflineContext";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { buildVCard } from "@/lib/contact-parse";
import { shareCardAsJpeg } from "@/lib/card-share";

interface FormValues {
  fullName: string;
  designation: string;
  companyName: string;
  email: string;
  primaryPhone: string;
  alternatePhone: string;
  officeAddress: string;
}

interface CardFieldConfig {
  key: keyof FormValues;
  labelKey: string;
  icon: keyof typeof Feather.glyphMap;
  /** Static placeholder key under card.placeholders, when not country-aware. */
  placeholderKey?: string;
  /** Country-aware placeholder source from useLocale. */
  placeholderKind?: "phone" | "address";
  keyboardType?: "default" | "email-address" | "phone-pad";
  autoCapitalize?: "none" | "words" | "sentences";
  multiline?: boolean;
  required?: boolean;
}

const FIELDS: CardFieldConfig[] = [
  { key: "fullName", labelKey: "fullName", icon: "user", placeholderKey: "fullName", autoCapitalize: "words", required: true },
  { key: "designation", labelKey: "designation", icon: "briefcase", placeholderKey: "designation", autoCapitalize: "words" },
  { key: "companyName", labelKey: "company", icon: "home", placeholderKey: "company", autoCapitalize: "words" },
  { key: "email", labelKey: "email", icon: "mail", placeholderKey: "email", keyboardType: "email-address", autoCapitalize: "none" },
  { key: "primaryPhone", labelKey: "primaryPhone", icon: "phone", placeholderKind: "phone", keyboardType: "phone-pad" },
  { key: "alternatePhone", labelKey: "alternatePhone", icon: "phone-call", placeholderKey: "alternatePhone", keyboardType: "phone-pad" },
  { key: "officeAddress", labelKey: "officeAddress", icon: "map-pin", placeholderKind: "address", multiline: true },
];

function toForm(card: BusinessCard | null): FormValues {
  return {
    fullName: card?.fullName ?? "",
    designation: card?.designation ?? "",
    companyName: card?.companyName ?? "",
    email: card?.email ?? "",
    primaryPhone: card?.primaryPhone ?? "",
    alternatePhone: card?.alternatePhone ?? "",
    officeAddress: card?.officeAddress ?? "",
  };
}

function nn(v: string): string | null {
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export default function CardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, textAlign, isRTL, mirror } = useLocale();
  const { user } = useAuth();
  const { card, isLoading, hasCard, pendingSync, saveCard, deleteCard } = useCard();
  const { isOnline } = useOffline();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const isWorkspace = mode === "edit";

  const [editing, setEditing] = useState(() => isWorkspace && !hasCard);
  const [values, setValues] = useState<FormValues>(toForm(card));
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cardRef = useRef<View>(null);

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 14);

  function update(key: keyof FormValues, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function startEdit() {
    setValues(toForm(card));
    setError(null);
    setEditing(true);
  }

  async function handleSave() {
    if (!values.fullName.trim()) {
      setError(t("card.fullNameRequired"));
      return;
    }
    setError(null);
    setSaving(true);
    const input: BusinessCardInput = {
      fullName: values.fullName.trim(),
      designation: nn(values.designation),
      companyName: nn(values.companyName),
      email: nn(values.email),
      primaryPhone: nn(values.primaryPhone),
      alternatePhone: nn(values.alternatePhone),
      officeAddress: nn(values.officeAddress),
    };
    try {
      await saveCard(input);
      setEditing(false);
    } catch {
      setError(t("card.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  function handleDelete() {
    Alert.alert(
      t("card.deleteTitle"),
      t("card.deleteConfirm"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.delete"),
          style: "destructive",
          onPress: async () => {
            try {
              await deleteCard();
              Alert.alert(
                t("card.deletedTitle"),
                t("card.deletedBody"),
                [
                  {
                    text: t("common.ok"),
                    onPress: () => router.replace("/(tabs)/more"),
                  },
                ],
              );
            } catch {
              Alert.alert(
                t("card.deleteFailedTitle"),
                t("card.deleteFailedBody"),
              );
            }
          },
        },
      ],
    );
  }

  async function handleShare() {
    setSharing(true);
    try {
      await shareCardAsJpeg(cardRef);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : t("card.shareFailedBody");
      Alert.alert(t("card.shareFailed"), msg);
    } finally {
      setSharing(false);
    }
  }

  const headerBack = (
    <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
      <Feather name="arrow-left" size={22} color={colors.foreground} style={mirror} />
    </Pressable>
  );

  if (isLoading && !card) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: topPad }}>
        <View style={[styles.header, { paddingHorizontal: 20, flexDirection: isRTL ? "row-reverse" : "row" }]}>
          {headerBack}
          <Text style={[styles.headerTitle, { color: colors.foreground, textAlign }]}>{t("card.myCard")}</Text>
        </View>
        <LoadingState />
      </View>
    );
  }

  // Home Dashboard entry (no mode=edit): if no card exists, show empty state
  if (!isWorkspace && !hasCard) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: topPad }}>
        <View style={[styles.header, { paddingHorizontal: 20, flexDirection: isRTL ? "row-reverse" : "row" }]}>
          {headerBack}
          <Text style={[styles.headerTitle, { color: colors.foreground, textAlign }]}>{t("card.myCard")}</Text>
        </View>
        <View style={styles.emptyState}>
          <View style={[styles.emptyIcon, { backgroundColor: colors.primary + "1A" }]}>
            <Feather name="credit-card" size={32} color={colors.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            {t("card.emptyTitle")}
          </Text>
          <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
            {t("card.emptyDesc")}
          </Text>
          <PrimaryButton
            label={t("card.goToWorkspace")}
            icon="settings"
            onPress={() =>
              router.push({ pathname: "/card", params: { mode: "edit" } })
            }
            style={{ alignSelf: "stretch", marginTop: 8 }}
          />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <KeyboardAwareScrollView
        contentContainerStyle={{
          paddingTop: topPad,
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + 60,
        }}
        bottomOffset={20}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.header, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
          {headerBack}
          <Text style={[styles.headerTitle, { color: colors.foreground, textAlign }]}>
            {editing ? (hasCard ? t("card.editCard") : t("card.createCard")) : t("card.myCard")}
          </Text>
        </View>

        {!isOnline ? (
          <View style={[styles.notice, { backgroundColor: colors.destructive + "14", borderRadius: colors.radius, flexDirection: isRTL ? "row-reverse" : "row" }]}>
            <Feather name="wifi-off" size={15} color={colors.destructive} />
            <Text style={[styles.noticeText, { color: colors.destructive, textAlign }]}>
              {t("card.offlineNotice")}
            </Text>
          </View>
        ) : pendingSync ? (
          <View style={[styles.notice, { backgroundColor: "#F59E0B14", borderRadius: colors.radius, flexDirection: isRTL ? "row-reverse" : "row" }]}>
            <Feather name="upload-cloud" size={15} color="#B45309" />
            <Text style={[styles.noticeText, { color: "#B45309", textAlign }]}>
              {t("card.syncingNotice")}
            </Text>
          </View>
        ) : null}

        {editing ? (
          <CardForm
            values={values}
            error={error}
            saving={saving}
            onChange={update}
            onSave={handleSave}
            onCancel={hasCard ? () => setEditing(false) : undefined}
          />
        ) : (
          <CardPreview
            card={card}
            account={{ name: user?.name, avatarUrl: user?.avatarUrl }}
            cardRef={cardRef}
            onShare={handleShare}
            sharing={sharing}
            canEdit={isWorkspace}
            onEdit={startEdit}
            onDelete={handleDelete}
          />
        )}
      </KeyboardAwareScrollView>
    </KeyboardAvoidingView>
  );
}

function CardForm({
  values,
  error,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  values: FormValues;
  error: string | null;
  saving: boolean;
  onChange: (key: keyof FormValues, value: string) => void;
  onSave: () => void;
  onCancel?: () => void;
}) {
  const colors = useColors();
  const { t, isRTL, textAlign, phonePlaceholder, addressPlaceholder } = useLocale();

  function placeholderFor(f: CardFieldConfig): string {
    if (f.placeholderKind === "phone") return phonePlaceholder;
    if (f.placeholderKind === "address") return addressPlaceholder;
    return f.placeholderKey ? t(`card.placeholders.${f.placeholderKey}`) : "";
  }

  return (
    <View>
      <Text style={[styles.intro, { color: colors.mutedForeground, textAlign }]}>
        {t("card.formIntro")}
      </Text>

      {error ? (
        <View style={[styles.notice, { backgroundColor: colors.destructive + "14", borderRadius: colors.radius, flexDirection: isRTL ? "row-reverse" : "row" }]}>
          <Feather name="alert-circle" size={15} color={colors.destructive} />
          <Text style={[styles.noticeText, { color: colors.destructive, textAlign }]}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.grid}>
        {FIELDS.map((f) => (
          <View key={f.key} style={styles.fieldWrap}>
            <Text style={[styles.label, { color: colors.mutedForeground, textAlign }]}>
              {t(`card.fields.${f.labelKey}`)}
              {f.required ? <Text style={{ color: colors.primary }}> *</Text> : null}
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
                onChangeText={(v) => onChange(f.key, v)}
                placeholder={placeholderFor(f)}
                placeholderTextColor={colors.mutedForeground}
                keyboardType={f.keyboardType ?? "default"}
                autoCapitalize={f.autoCapitalize ?? "sentences"}
                autoCorrect={false}
                multiline={f.multiline}
                style={[
                  styles.input,
                  { color: colors.foreground, textAlign },
                  f.multiline && { height: 80, textAlignVertical: "top" },
                ]}
              />
            </View>
          </View>
        ))}
      </View>

      <PrimaryButton
        label={t("card.saveCard")}
        icon="check"
        loading={saving}
        onPress={onSave}
        style={{ marginTop: 22 }}
      />
      {onCancel ? (
        <Pressable onPress={onCancel} style={styles.cancelBtn} disabled={saving}>
          <Text style={[styles.cancelText, { color: colors.mutedForeground }]}>{t("common.cancel")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const NAVY = "#0B1A33";
const PANEL = "#0F2244";
const ORANGE = "#F97316";
const ORANGE_LIGHT = "#FB923C";

function CardPreview({
  card,
  account,
  cardRef,
  onShare,
  sharing,
  canEdit,
  onEdit,
  onDelete,
}: {
  card: BusinessCard | null;
  account: { name?: string | null; avatarUrl?: string | null };
  cardRef: React.RefObject<View | null>;
  onShare: () => void;
  sharing?: boolean;
  canEdit?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const colors = useColors();
  const { t, isRTL, textAlign } = useLocale();
  const name = card?.fullName ?? account.name ?? "";
  const avatarUrl = card?.avatarUrl ?? account.avatarUrl ?? null;

  const rows = useMemo(
    () =>
      [
        { icon: "mail" as const, labelKey: "email", value: card?.email },
        { icon: "phone" as const, labelKey: "phone", value: card?.primaryPhone },
        { icon: "phone-call" as const, labelKey: "altPhone", value: card?.alternatePhone },
        { icon: "map-pin" as const, labelKey: "office", value: card?.officeAddress },
      ].filter((r) => r.value),
    [card],
  );

  const subtitle = [card?.companyName].filter(Boolean).join(" · ");

  const vcard = useMemo(
    () =>
      buildVCard({
        fullName: card?.fullName ?? account.name ?? null,
        companyName: card?.companyName,
        designation: card?.designation,
        primaryPhone: card?.primaryPhone,
        alternatePhone: card?.alternatePhone,
        email: card?.email,
        website: card?.website,
        officeAddress: card?.officeAddress,
      }),
    [card, account.name],
  );

  const hasContactData = Boolean(
    card?.fullName ??
      account.name ??
      card?.email ??
      card?.primaryPhone ??
      card?.alternatePhone ??
      card?.companyName,
  );

  return (
    <View>
      <View ref={cardRef} style={styles.cardShell} collapsable={false}>
        <View style={styles.band} />
        <View style={styles.cardHeader}>
          <View style={styles.avatarRing}>
            <Avatar name={name} uri={avatarUrl} size={90} color={PANEL} />
          </View>
          {card?.designation ? (
            <Text style={styles.cardJob}>{card.designation.toUpperCase()}</Text>
          ) : null}
          <Text style={styles.cardName}>{name}</Text>
          {subtitle ? <Text style={styles.cardCompany}>{subtitle}</Text> : null}
        </View>

        {rows.length > 0 ? (
          <>
            <View style={styles.cardDivider} />
            <View style={styles.contactSection}>
              {rows.map((r) => (
                <View key={r.labelKey} style={[styles.contactRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                  <View style={styles.cIcon}>
                    <Feather name={r.icon} size={16} color={ORANGE_LIGHT} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.cLabel, { textAlign }]}>{t(`card.previewLabels.${r.labelKey}`).toUpperCase()}</Text>
                    <Text style={[styles.cValue, { textAlign }]} numberOfLines={2}>
                      {r.value}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </>
        ) : null}

        <View style={styles.qrSection}>
          <Text style={styles.qrHeading}>{t("card.qrScanToSave")}</Text>
          {hasContactData ? (
            <CardQR value={vcard} size={150} color={NAVY} />
          ) : (
            <View style={styles.qrPending}>
              <Feather name="user-plus" size={22} color="#4A6E94" />
              <Text style={styles.qrPendingText}>
                {t("card.qrPending")}
              </Text>
            </View>
          )}
          <Text style={styles.qrSub}>
            {t("card.qrSub")}
          </Text>
        </View>

        <View style={styles.band} />
      </View>

      <PrimaryButton
        label={sharing ? t("card.generatingImage") : t("card.share")}
        icon="share-2"
        loading={sharing}
        onPress={onShare}
        style={{ marginTop: 18 }}
      />
      {canEdit && onEdit ? (
        <Pressable
          onPress={onEdit}
          style={({ pressed }) => [
            styles.editBtn,
            { borderColor: colors.border, backgroundColor: colors.card, opacity: pressed ? 0.7 : 1, flexDirection: isRTL ? "row-reverse" : "row" },
          ]}
        >
          <Feather name="edit-2" size={16} color={colors.foreground} />
          <Text style={[styles.editText, { color: colors.foreground }]}>{t("card.editDetails")}</Text>
        </Pressable>
      ) : null}
      {canEdit && onDelete ? (
        <Pressable
          onPress={onDelete}
          style={({ pressed }) => [
            styles.editBtn,
            { borderColor: colors.destructive + "40", backgroundColor: colors.destructive + "0D", opacity: pressed ? 0.7 : 1, marginTop: 10, flexDirection: isRTL ? "row-reverse" : "row" },
          ]}
        >
          <Feather name="trash-2" size={16} color={colors.destructive} />
          <Text style={[styles.editText, { color: colors.destructive }]}>{t("card.deleteCard")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 18,
  },
  backBtn: { padding: 2 },
  headerTitle: {
    fontSize: 24,
    fontFamily: FONT.bold,
  },
  intro: {
    fontSize: 13.5,
    fontFamily: FONT.regular,
    lineHeight: 20,
    marginBottom: 16,
  },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    marginBottom: 16,
  },
  noticeText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FONT.medium,
  },
  // form
  grid: { gap: 14 },
  fieldWrap: { width: "100%" },
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
    height: 92,
    alignItems: "flex-start",
    paddingVertical: 12,
  },
  input: {
    flex: 1,
    fontSize: 15,
    fontFamily: FONT.regular,
    padding: 0,
  },
  cancelBtn: {
    alignItems: "center",
    paddingVertical: 14,
    marginTop: 4,
  },
  cancelText: {
    fontSize: 14.5,
    fontFamily: FONT.medium,
  },
  // preview card
  cardShell: {
    borderRadius: 24,
    overflow: "hidden",
    backgroundColor: NAVY,
    shadowColor: NAVY,
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.32,
    shadowRadius: 30,
    elevation: 8,
  },
  band: {
    height: 6,
    width: "100%",
    backgroundColor: ORANGE,
  },
  cardHeader: {
    paddingHorizontal: 26,
    paddingTop: 30,
    paddingBottom: 22,
    alignItems: "center",
  },
  avatarRing: {
    width: 96,
    height: 96,
    borderRadius: 48,
    padding: 3,
    backgroundColor: ORANGE,
    marginBottom: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  cardJob: {
    fontSize: 11,
    fontFamily: FONT.medium,
    color: ORANGE,
    letterSpacing: 1.5,
    marginBottom: 5,
    textAlign: "center",
  },
  cardName: {
    fontSize: 24,
    fontFamily: FONT.bold,
    color: "#FFF7F0",
    textAlign: "center",
    marginBottom: 5,
  },
  cardCompany: {
    fontSize: 13,
    fontFamily: FONT.regular,
    color: "#7A9CC4",
    textAlign: "center",
  },
  cardDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.1)",
    marginHorizontal: 26,
  },
  contactSection: {
    paddingHorizontal: 26,
    paddingTop: 18,
    paddingBottom: 16,
    gap: 13,
  },
  contactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
  },
  cIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: "rgba(249,115,22,0.13)",
    alignItems: "center",
    justifyContent: "center",
  },
  cLabel: {
    fontSize: 10,
    fontFamily: FONT.medium,
    color: "#3A5E82",
    letterSpacing: 1,
    marginBottom: 1,
  },
  cValue: {
    fontSize: 13,
    fontFamily: FONT.regular,
    color: "#C8DDEF",
  },
  qrSection: {
    marginHorizontal: 26,
    marginTop: 8,
    marginBottom: 24,
    backgroundColor: PANEL,
    borderRadius: 18,
    padding: 20,
    alignItems: "center",
    gap: 14,
  },
  qrHeading: {
    fontSize: 10,
    fontFamily: FONT.medium,
    color: ORANGE,
    letterSpacing: 1.5,
  },
  qrPending: {
    width: 150,
    height: 150,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 16,
  },
  qrPendingText: {
    fontSize: 11.5,
    fontFamily: FONT.regular,
    color: "#4A6E94",
    textAlign: "center",
    lineHeight: 16,
  },
  qrSub: {
    fontSize: 11.5,
    fontFamily: FONT.regular,
    color: "#4A6E94",
    textAlign: "center",
    lineHeight: 16,
  },
  editBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 50,
    borderWidth: 1,
    borderRadius: 14,
    marginTop: 12,
  },
  editText: {
    fontSize: 15,
    fontFamily: FONT.semibold,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 36,
    gap: 14,
  },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize: 20,
    fontFamily: FONT.bold,
    textAlign: "center",
  },
  emptySub: {
    fontSize: 14,
    fontFamily: FONT.regular,
    textAlign: "center",
    lineHeight: 20,
  },
});
