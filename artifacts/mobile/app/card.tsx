import { Feather } from "@/components/icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Share,
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
import { buildVCard } from "@/lib/contact-parse";

interface FormValues {
  fullName: string;
  designation: string;
  companyName: string;
  email: string;
  primaryPhone: string;
  alternatePhone: string;
  officeAddress: string;
}

const FIELDS: {
  key: keyof FormValues;
  label: string;
  icon: keyof typeof Feather.glyphMap;
  placeholder: string;
  keyboardType?: "default" | "email-address" | "phone-pad";
  autoCapitalize?: "none" | "words" | "sentences";
  multiline?: boolean;
  required?: boolean;
}[] = [
  { key: "fullName", label: "Full name", icon: "user", placeholder: "Jane Doe", autoCapitalize: "words", required: true },
  { key: "designation", label: "Designation", icon: "briefcase", placeholder: "Sales Director", autoCapitalize: "words" },
  { key: "companyName", label: "Company", icon: "home", placeholder: "Acme Inc.", autoCapitalize: "words" },
  { key: "email", label: "Email", icon: "mail", placeholder: "jane@acme.com", keyboardType: "email-address", autoCapitalize: "none" },
  { key: "primaryPhone", label: "Primary phone", icon: "phone", placeholder: "+1 555 123 4567", keyboardType: "phone-pad" },
  { key: "alternatePhone", label: "Alternative phone", icon: "phone-call", placeholder: "Optional", keyboardType: "phone-pad" },
  { key: "officeAddress", label: "Office address", icon: "map-pin", placeholder: "123 Main St, City", multiline: true },
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
  const { user } = useAuth();
  const { card, isLoading, hasCard, pendingSync, saveCard, deleteCard } = useCard();
  const { isOnline } = useOffline();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const isWorkspace = mode === "edit";

  const [editing, setEditing] = useState(() => isWorkspace && !hasCard);
  const [values, setValues] = useState<FormValues>(toForm(card));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 14);

  const shareUrl = card?.publicUrl ?? null;

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
      setError("Your full name is required.");
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
      setError("Couldn't save your card. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function handleDelete() {
    Alert.alert(
      "Delete Digital Business Card",
      "Are you sure you want to delete your Digital Business Card?\n\nThis action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteCard();
              Alert.alert(
                "Card Deleted",
                "Your Digital Business Card has been deleted successfully.",
                [
                  {
                    text: "OK",
                    onPress: () => router.replace("/(tabs)/more"),
                  },
                ],
              );
            } catch {
              Alert.alert(
                "Deletion Failed",
                "Unable to delete your Digital Business Card. Please try again.",
              );
            }
          },
        },
      ],
    );
  }

  async function handleShare() {
    if (!shareUrl) {
      Alert.alert(
        "Link not ready",
        "Your shareable link will be available once your card syncs online.",
      );
      return;
    }
    const name = card?.fullName ?? "my";
    try {
      await Share.share(
        Platform.OS === "ios"
          ? { url: shareUrl, message: `${name}'s digital business card` }
          : { message: `${name}'s digital business card\n${shareUrl}` },
      );
    } catch {
      /* user dismissed the share sheet */
    }
  }

  const headerBack = (
    <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
      <Feather name="arrow-left" size={22} color={colors.foreground} />
    </Pressable>
  );

  if (isLoading && !card) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: topPad }}>
        <View style={[styles.header, { paddingHorizontal: 20 }]}>
          {headerBack}
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>My Card</Text>
        </View>
        <LoadingState />
      </View>
    );
  }

  // Home Dashboard entry (no mode=edit): if no card exists, show empty state
  if (!isWorkspace && !hasCard) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: topPad }}>
        <View style={[styles.header, { paddingHorizontal: 20 }]}>
          {headerBack}
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>My Card</Text>
        </View>
        <View style={styles.emptyState}>
          <View style={[styles.emptyIcon, { backgroundColor: colors.primary + "1A" }]}>
            <Feather name="credit-card" size={32} color={colors.primary} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            No digital card yet
          </Text>
          <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
            You haven&apos;t created your Digital Business Card yet. Set it up from the Workspace.
          </Text>
          <PrimaryButton
            label="Go to Workspace"
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
        <View style={styles.header}>
          {headerBack}
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>
            {editing ? (hasCard ? "Edit Card" : "Create Card") : "My Card"}
          </Text>
        </View>

        {!isOnline ? (
          <View style={[styles.notice, { backgroundColor: colors.destructive + "14", borderRadius: colors.radius }]}>
            <Feather name="wifi-off" size={15} color={colors.destructive} />
            <Text style={[styles.noticeText, { color: colors.destructive }]}>
              You're offline — changes save locally and sync automatically.
            </Text>
          </View>
        ) : pendingSync ? (
          <View style={[styles.notice, { backgroundColor: "#F59E0B14", borderRadius: colors.radius }]}>
            <Feather name="upload-cloud" size={15} color="#B45309" />
            <Text style={[styles.noticeText, { color: "#B45309" }]}>
              Saved locally — syncing your card now.
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
            shareUrl={shareUrl}
            onShare={handleShare}
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
  return (
    <View>
      <Text style={[styles.intro, { color: colors.mutedForeground }]}>
        This is the card people see when they scan your QR. Only your full name is
        required. Your profile photo comes from your account.
      </Text>

      {error ? (
        <View style={[styles.notice, { backgroundColor: colors.destructive + "14", borderRadius: colors.radius }]}>
          <Feather name="alert-circle" size={15} color={colors.destructive} />
          <Text style={[styles.noticeText, { color: colors.destructive }]}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.grid}>
        {FIELDS.map((f) => (
          <View key={f.key} style={styles.fieldWrap}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>
              {f.label}
              {f.required ? <Text style={{ color: colors.primary }}> *</Text> : null}
            </Text>
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
                onChangeText={(t) => onChange(f.key, t)}
                placeholder={f.placeholder}
                placeholderTextColor={colors.mutedForeground}
                keyboardType={f.keyboardType ?? "default"}
                autoCapitalize={f.autoCapitalize ?? "sentences"}
                autoCorrect={false}
                multiline={f.multiline}
                style={[
                  styles.input,
                  { color: colors.foreground },
                  f.multiline && { height: 80, textAlignVertical: "top" },
                ]}
              />
            </View>
          </View>
        ))}
      </View>

      <PrimaryButton
        label="Save card"
        icon="check"
        loading={saving}
        onPress={onSave}
        style={{ marginTop: 22 }}
      />
      {onCancel ? (
        <Pressable onPress={onCancel} style={styles.cancelBtn} disabled={saving}>
          <Text style={[styles.cancelText, { color: colors.mutedForeground }]}>Cancel</Text>
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
  shareUrl,
  onShare,
  canEdit,
  onEdit,
  onDelete,
}: {
  card: BusinessCard | null;
  account: { name?: string | null; avatarUrl?: string | null };
  shareUrl: string | null;
  onShare: () => void;
  canEdit?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const colors = useColors();
  const name = card?.fullName ?? account.name ?? "";
  const avatarUrl = card?.avatarUrl ?? account.avatarUrl ?? null;

  const rows = useMemo(
    () =>
      [
        { icon: "mail" as const, label: "Email", value: card?.email },
        { icon: "phone" as const, label: "Phone", value: card?.primaryPhone },
        { icon: "phone-call" as const, label: "Alt. phone", value: card?.alternatePhone },
        { icon: "map-pin" as const, label: "Office", value: card?.officeAddress },
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
      <View style={styles.cardShell}>
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
                <View key={r.label} style={styles.contactRow}>
                  <View style={styles.cIcon}>
                    <Feather name={r.icon} size={16} color={ORANGE_LIGHT} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cLabel}>{r.label.toUpperCase()}</Text>
                    <Text style={styles.cValue} numberOfLines={2}>
                      {r.value}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </>
        ) : null}

        <View style={styles.qrSection}>
          <Text style={styles.qrHeading}>SCAN TO SAVE CONTACT</Text>
          {hasContactData ? (
            <CardQR value={vcard} size={150} color={NAVY} />
          ) : (
            <View style={styles.qrPending}>
              <Feather name="user-plus" size={22} color="#4A6E94" />
              <Text style={styles.qrPendingText}>
                Add your details to generate a contact QR
              </Text>
            </View>
          )}
          <Text style={styles.qrSub}>
            Point a camera to save these details as a contact
          </Text>
        </View>

        <View style={styles.band} />
      </View>

      <PrimaryButton
        label="Share my card"
        icon="share-2"
        onPress={onShare}
        style={{ marginTop: 18 }}
      />
      {canEdit && onEdit ? (
        <Pressable
          onPress={onEdit}
          style={({ pressed }) => [
            styles.editBtn,
            { borderColor: colors.border, backgroundColor: colors.card, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Feather name="edit-2" size={16} color={colors.foreground} />
          <Text style={[styles.editText, { color: colors.foreground }]}>Edit details</Text>
        </Pressable>
      ) : null}
      {canEdit && onDelete ? (
        <Pressable
          onPress={onDelete}
          style={({ pressed }) => [
            styles.editBtn,
            { borderColor: colors.destructive + "40", backgroundColor: colors.destructive + "0D", opacity: pressed ? 0.7 : 1, marginTop: 10 },
          ]}
        >
          <Feather name="trash-2" size={16} color={colors.destructive} />
          <Text style={[styles.editText, { color: colors.destructive }]}>Delete card</Text>
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
