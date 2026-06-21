import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  Alert,
  Image,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import QRCode from "react-native-qrcode-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type BusinessCard,
  type BusinessCardInput,
  useGetOwnCard,
  useUpsertOwnCard,
  getGetOwnCardQueryKey,
} from "@workspace/api-client-react";

import { Avatar, FONT, LoadingState, PrimaryButton } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { useOffline } from "@/contexts/OfflineContext";
import { useColors } from "@/hooks/useColors";

const LOGO = require("../assets/images/icon.png");

const CARD_NAVY = "#0B1A33";
const CARD_PANEL = "#0F2244";

// Fields whose public visibility the user can toggle. Name / designation /
// company are always shown on the card so they are not in this list.
const VIS_KEYS = [
  "email",
  "primaryPhone",
  "altPhone",
  "officeAddress",
  "website",
  "linkedin",
  "facebook",
  "instagram",
  "twitter",
  "youtube",
] as const;

interface FormValues {
  fullName: string;
  designation: string;
  companyName: string;
  email: string;
  primaryPhone: string;
  altPhone: string;
  officeAddress: string;
  website: string;
  linkedin: string;
  facebook: string;
  instagram: string;
  twitter: string;
  youtube: string;
}

type VisMap = Record<(typeof VIS_KEYS)[number], boolean>;

interface FieldConfig {
  key: keyof FormValues;
  label: string;
  icon: keyof typeof Feather.glyphMap;
  placeholder: string;
  keyboardType?: "default" | "email-address" | "phone-pad" | "url";
  autoCapitalize?: "none" | "words" | "sentences";
  half?: boolean;
}

const SECTIONS: { title: string; fields: FieldConfig[] }[] = [
  {
    title: "IDENTITY",
    fields: [
      { key: "fullName", label: "Full name", icon: "user", placeholder: "Jane Doe", autoCapitalize: "words" },
      { key: "designation", label: "Job title", icon: "briefcase", placeholder: "Sales Director", autoCapitalize: "words" },
      { key: "companyName", label: "Company", icon: "home", placeholder: "Acme Inc.", autoCapitalize: "words" },
    ],
  },
  {
    title: "CONTACT",
    fields: [
      { key: "email", label: "Email", icon: "mail", placeholder: "jane@acme.com", keyboardType: "email-address", autoCapitalize: "none" },
      { key: "primaryPhone", label: "Phone", icon: "phone", placeholder: "+971 50 000 0000", keyboardType: "phone-pad", half: true },
      { key: "altPhone", label: "Alt. phone", icon: "phone-call", placeholder: "+971 4 000 0000", keyboardType: "phone-pad", half: true },
      { key: "officeAddress", label: "Office address", icon: "map-pin", placeholder: "Dubai World Trade Centre", autoCapitalize: "words" },
      { key: "website", label: "Website", icon: "globe", placeholder: "acme.com", keyboardType: "url", autoCapitalize: "none" },
    ],
  },
  {
    title: "SOCIAL",
    fields: [
      { key: "linkedin", label: "LinkedIn", icon: "linkedin", placeholder: "linkedin.com/in/jane", keyboardType: "url", autoCapitalize: "none" },
      { key: "twitter", label: "X / Twitter", icon: "twitter", placeholder: "x.com/jane", keyboardType: "url", autoCapitalize: "none" },
      { key: "facebook", label: "Facebook", icon: "facebook", placeholder: "facebook.com/jane", keyboardType: "url", autoCapitalize: "none" },
      { key: "instagram", label: "Instagram", icon: "instagram", placeholder: "instagram.com/jane", keyboardType: "url", autoCapitalize: "none" },
      { key: "youtube", label: "YouTube", icon: "youtube", placeholder: "youtube.com/@jane", keyboardType: "url", autoCapitalize: "none" },
    ],
  },
];

const SOCIAL_ICONS: Record<string, keyof typeof Feather.glyphMap> = {
  linkedin: "linkedin",
  twitter: "twitter",
  facebook: "facebook",
  instagram: "instagram",
  youtube: "youtube",
};

function cardToForm(card: BusinessCard | undefined, fallback: Partial<FormValues>): FormValues {
  return {
    fullName: card?.fullName ?? fallback.fullName ?? "",
    designation: card?.designation ?? fallback.designation ?? "",
    companyName: card?.companyName ?? fallback.companyName ?? "",
    email: card?.email ?? fallback.email ?? "",
    primaryPhone: card?.primaryPhone ?? fallback.primaryPhone ?? "",
    altPhone: card?.altPhone ?? "",
    officeAddress: card?.officeAddress ?? "",
    website: card?.website ?? "",
    linkedin: card?.linkedin ?? "",
    facebook: card?.facebook ?? "",
    instagram: card?.instagram ?? "",
    twitter: card?.twitter ?? "",
    youtube: card?.youtube ?? "",
  };
}

function cardToVis(card: BusinessCard | undefined): VisMap {
  const vis = card?.fieldVisibility ?? {};
  const out = {} as VisMap;
  for (const k of VIS_KEYS) out[k] = vis[k] ?? true;
  return out;
}

function normalizeUrl(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function displayUrl(raw: string): string {
  return raw.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

export default function DigitalCardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const { isOnline } = useOffline();

  const ownCard = useGetOwnCard({ query: { retry: false, queryKey: getGetOwnCardQueryKey() } });
  const upsert = useUpsertOwnCard();

  // A 404 means "no card yet" — that is the create flow, not an error.
  const status = (ownCard.error as { status?: number } | null)?.status;
  const noCardYet = ownCard.isError && status === 404;
  const card = ownCard.data;

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormValues | null>(null);
  const [vis, setVis] = useState<VisMap | null>(null);
  const [published, setPublished] = useState(true);

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  const publicUrl = card?.publicToken && domain ? `https://${domain}/card/${card.publicToken}` : "";

  function beginEdit() {
    if (Platform.OS !== "web") Haptics.selectionAsync();
    setForm(
      cardToForm(card, {
        fullName: user?.name ?? "",
        email: user?.email ?? "",
        primaryPhone: user?.phone ?? "",
        companyName: user?.companyName ?? "",
      }),
    );
    setVis(cardToVis(card));
    setPublished(card?.isPublished ?? true);
    setEditing(true);
  }

  function update(key: keyof FormValues, value: string) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function toggleVis(key: (typeof VIS_KEYS)[number]) {
    setVis((prev) => (prev ? { ...prev, [key]: !prev[key] } : prev));
  }

  async function handleSave() {
    if (!form || !vis) return;
    const clean = (v: string) => {
      const t = v.trim();
      return t.length ? t : null;
    };
    const payload: BusinessCardInput = {
      fullName: clean(form.fullName),
      designation: clean(form.designation),
      companyName: clean(form.companyName),
      email: clean(form.email),
      primaryPhone: clean(form.primaryPhone),
      altPhone: clean(form.altPhone),
      officeAddress: clean(form.officeAddress),
      website: clean(form.website),
      linkedin: clean(form.linkedin),
      facebook: clean(form.facebook),
      instagram: clean(form.instagram),
      twitter: clean(form.twitter),
      youtube: clean(form.youtube),
      fieldVisibility: { ...vis },
      isPublished: published,
      templateId: "classic",
    };
    try {
      await upsert.mutateAsync({ data: payload });
      if (Platform.OS !== "web")
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await ownCard.refetch();
      setEditing(false);
    } catch (err) {
      Alert.alert(
        "Couldn't save your card",
        err instanceof Error ? err.message : "Please try again.",
      );
    }
  }

  async function handleShare() {
    if (!publicUrl) return;
    if (card && !card.isPublished) {
      Alert.alert(
        "Card is unpublished",
        "Your card link is turned off, so anyone you share it with will see a “not found” page. Publish it first from Edit.",
        [{ text: "OK" }],
      );
      return;
    }
    const message = `${card?.fullName ?? "My"} — digital business card: ${publicUrl}`;
    if (Platform.OS === "web") {
      const nav = typeof navigator !== "undefined" ? navigator : undefined;
      if (nav && typeof nav.share === "function") {
        nav.share({ title: "Digital business card", url: publicUrl }).catch(() => {});
      } else if (nav?.clipboard) {
        nav.clipboard.writeText(publicUrl).then(
          () => Alert.alert("Link copied", publicUrl),
          () => {},
        );
      }
      return;
    }
    Haptics.selectionAsync();
    Share.share({ message, url: publicUrl }).catch(() => {});
  }

  // ── Header ────────────────────────────────────────────────────────────────
  function renderHeader() {
    return (
      <View style={[styles.header, { paddingTop: topPad + 8 }]}>
        <Pressable
          onPress={() => {
            if (editing && !noCardYet) {
              setEditing(false);
              return;
            }
            router.back();
          }}
          hitSlop={10}
          style={styles.headerBtn}
        >
          <Feather name={editing && !noCardYet ? "x" : "arrow-left"} size={22} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>
          {editing ? (noCardYet ? "Create card" : "Edit card") : "Digital Card"}
        </Text>
        {!editing && card ? (
          <Pressable onPress={beginEdit} hitSlop={10} style={styles.headerBtn}>
            <Feather name="edit-2" size={20} color={colors.primary} />
          </Pressable>
        ) : (
          <View style={styles.headerBtn} />
        )}
      </View>
    );
  }

  // ── Loading / error ─────────────────────────────────────────────────────────
  if (ownCard.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {renderHeader()}
        <LoadingState />
      </View>
    );
  }

  if (ownCard.isError && !noCardYet) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {renderHeader()}
        <View style={styles.centerState}>
          <View style={[styles.stateIcon, { backgroundColor: colors.destructive + "1A" }]}>
            <Feather name="alert-triangle" size={26} color={colors.destructive} />
          </View>
          <Text style={[styles.stateTitle, { color: colors.foreground }]}>Couldn't load your card</Text>
          <PrimaryButton label="Try again" icon="refresh-cw" onPress={() => ownCard.refetch()} style={{ marginTop: 16 }} />
        </View>
      </View>
    );
  }

  // ── Empty (no card yet, not editing) ────────────────────────────────────────
  if (noCardYet && !editing) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {renderHeader()}
        <View style={styles.centerState}>
          <View style={[styles.stateIcon, { backgroundColor: colors.accent }]}>
            <Feather name="credit-card" size={28} color={colors.primary} />
          </View>
          <Text style={[styles.stateTitle, { color: colors.foreground }]}>Your digital business card</Text>
          <Text style={[styles.stateSub, { color: colors.mutedForeground }]}>
            Create a shareable card with a QR code. Prospects scan it to get your details instantly — no app needed.
          </Text>
          <PrimaryButton label="Create my card" icon="plus" onPress={beginEdit} style={{ marginTop: 20, alignSelf: "stretch" }} />
        </View>
      </View>
    );
  }

  // ── Edit mode ───────────────────────────────────────────────────────────────
  if (editing && form && vis) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        {renderHeader()}
        <KeyboardAwareScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 48 }}
          bottomOffset={20}
          showsVerticalScrollIndicator={false}
        >
          {/* Avatar (sourced from account) */}
          <View style={[styles.avatarCard, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 }]}>
            <Avatar name={user?.name} color={colors.primary} size={52} uri={user?.avatarUrl} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.avatarTitle, { color: colors.foreground }]}>Profile photo</Text>
              <Text style={[styles.avatarSub, { color: colors.mutedForeground }]}>
                Your card uses your account photo. Change it from More → profile.
              </Text>
            </View>
          </View>

          {!isOnline ? (
            <View style={[styles.notice, { backgroundColor: colors.destructive + "14", borderRadius: colors.radius }]}>
              <Feather name="wifi-off" size={15} color={colors.destructive} />
              <Text style={[styles.noticeText, { color: colors.destructive }]}>
                You're offline. Reconnect to save your card.
              </Text>
            </View>
          ) : null}

          {SECTIONS.map((section) => (
            <View key={section.title}>
              <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>{section.title}</Text>
              <View style={styles.grid}>
                {section.fields.map((f) => {
                  const canToggle = (VIS_KEYS as readonly string[]).includes(f.key);
                  const visible = canToggle ? vis[f.key as (typeof VIS_KEYS)[number]] : true;
                  return (
                    <View key={f.key} style={[styles.fieldWrap, f.half && styles.half]}>
                      <View style={styles.labelRow}>
                        <Text style={[styles.label, { color: colors.mutedForeground }]}>{f.label}</Text>
                        {canToggle ? (
                          <Pressable
                            onPress={() => toggleVis(f.key as (typeof VIS_KEYS)[number])}
                            hitSlop={8}
                            style={styles.eyeBtn}
                          >
                            <Feather
                              name={visible ? "eye" : "eye-off"}
                              size={14}
                              color={visible ? colors.primary : colors.mutedForeground}
                            />
                            <Text
                              style={[
                                styles.eyeLabel,
                                { color: visible ? colors.primary : colors.mutedForeground },
                              ]}
                            >
                              {visible ? "Public" : "Hidden"}
                            </Text>
                          </Pressable>
                        ) : null}
                      </View>
                      <View
                        style={[
                          styles.inputWrap,
                          { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 2 },
                        ]}
                      >
                        <Feather name={f.icon} size={16} color={colors.mutedForeground} />
                        <TextInput
                          value={form[f.key]}
                          onChangeText={(t) => update(f.key, t)}
                          placeholder={f.placeholder}
                          placeholderTextColor={colors.mutedForeground}
                          keyboardType={f.keyboardType ?? "default"}
                          autoCapitalize={f.autoCapitalize ?? "sentences"}
                          autoCorrect={false}
                          style={[styles.input, { color: colors.foreground }]}
                        />
                      </View>
                    </View>
                  );
                })}
              </View>
            </View>
          ))}

          {/* Published toggle */}
          <View
            style={[
              styles.publishRow,
              { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
            ]}
          >
            <View style={[styles.publishIcon, { backgroundColor: colors.accent }]}>
              <Feather name="globe" size={18} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.publishTitle, { color: colors.foreground }]}>Published</Text>
              <Text style={[styles.publishSub, { color: colors.mutedForeground }]}>
                {published ? "Anyone with the link can view your card." : "Your card link is turned off."}
              </Text>
            </View>
            <Switch
              value={published}
              onValueChange={setPublished}
              trackColor={{ true: colors.primary, false: colors.border }}
              thumbColor="#FFFFFF"
            />
          </View>

          <PrimaryButton
            label={noCardYet ? "Create card" : "Save changes"}
            icon="check"
            loading={upsert.isPending}
            disabled={!isOnline}
            onPress={handleSave}
            style={{ marginTop: 22 }}
          />
        </KeyboardAwareScrollView>
      </View>
    );
  }

  // ── View mode ───────────────────────────────────────────────────────────────
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {renderHeader()}
      <CardView
        card={card!}
        publicUrl={publicUrl}
        avatarUrl={user?.avatarUrl ?? card?.avatarUrl ?? null}
        onShare={handleShare}
        onEdit={beginEdit}
        insetsBottom={insets.bottom}
      />
    </View>
  );
}

function CardView({
  card,
  publicUrl,
  avatarUrl,
  onShare,
  onEdit,
  insetsBottom,
}: {
  card: BusinessCard;
  publicUrl: string;
  avatarUrl: string | null;
  onShare: () => void;
  onEdit: () => void;
  insetsBottom: number;
}) {
  const colors = useColors();
  const vis = card.fieldVisibility ?? {};

  const rows = useMemo(() => {
    const out: { key: string; icon: keyof typeof Feather.glyphMap; label: string; value: string }[] = [];
    const push = (key: string, icon: keyof typeof Feather.glyphMap, label: string, value: string | null | undefined) => {
      if (value && (vis[key] ?? true)) out.push({ key, icon, label, value });
    };
    push("email", "mail", "Email", card.email);
    push("primaryPhone", "phone", "Phone", card.primaryPhone);
    push("altPhone", "phone-call", "Alt. phone", card.altPhone);
    push("website", "globe", "Website", card.website ? displayUrl(card.website) : null);
    push("officeAddress", "map-pin", "Office", card.officeAddress);
    return out;
  }, [card, vis]);

  const socials = useMemo(
    () =>
      (["linkedin", "twitter", "facebook", "instagram", "youtube"] as const).filter(
        (k) => card[k] && (vis[k] ?? true),
      ),
    [card, vis],
  );

  return (
    <KeyboardAwareScrollView
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: insetsBottom + 48 }}
      showsVerticalScrollIndicator={false}
    >
      {!card.isPublished ? (
        <View style={[styles.notice, { backgroundColor: colors.warning + "1A", borderRadius: colors.radius }]}>
          <Feather name="eye-off" size={15} color={colors.warning} />
          <Text style={[styles.noticeText, { color: colors.warning }]}>
            This card is unpublished — the public link is currently disabled.
          </Text>
        </View>
      ) : null}

      {/* The card */}
      <View style={styles.cardOuter}>
        <View style={styles.orangeBand} />
        <View style={styles.cardHeader}>
          <View style={styles.photoRing}>
            <View style={styles.photoInner}>
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={styles.photo} />
              ) : (
                <Feather name="user" size={34} color="#FF8A3D" />
              )}
            </View>
          </View>
          {card.designation ? <Text style={styles.designation}>{card.designation.toUpperCase()}</Text> : null}
          <Text style={styles.cardName}>{card.fullName ?? "—"}</Text>
          {card.companyName ? <Text style={styles.cardCompany}>{card.companyName}</Text> : null}
        </View>

        <View style={styles.cardDivider} />

        <View style={styles.rows}>
          {rows.map((r) => (
            <View key={r.key} style={styles.contactRow}>
              <View style={styles.cIcon}>
                <Feather name={r.icon} size={16} color="#FF8A3D" />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.cLabel}>{r.label.toUpperCase()}</Text>
                <Text numberOfLines={1} style={styles.cValue}>
                  {r.value}
                </Text>
              </View>
            </View>
          ))}
        </View>

        {socials.length > 0 ? (
          <View style={styles.socialRow}>
            {socials.map((k) => (
              <View key={k} style={styles.socialChip}>
                <Feather name={SOCIAL_ICONS[k]} size={18} color="#FF8A3D" />
              </View>
            ))}
          </View>
        ) : null}

        {/* QR */}
        {publicUrl ? (
          <View style={styles.qrSection}>
            <Text style={styles.qrHeading}>SCAN TO CONNECT</Text>
            <View style={styles.qrWrap}>
              <QRCode
                value={publicUrl}
                size={148}
                color={CARD_NAVY}
                backgroundColor="#FFFFFF"
                ecl="H"
                logo={LOGO}
                logoSize={34}
                logoBackgroundColor="#FFFFFF"
                logoMargin={3}
                logoBorderRadius={7}
              />
            </View>
            <Text style={styles.qrSub}>Point a camera here to open this card</Text>
          </View>
        ) : null}

        <View style={styles.orangeBand} />
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        <PrimaryButton label="Share card" icon="share-2" onPress={onShare} style={{ flex: 1 }} />
        <Pressable
          onPress={onEdit}
          style={({ pressed }) => [
            styles.secondaryBtn,
            { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radius + 4, opacity: pressed ? 0.8 : 1 },
          ]}
        >
          <Feather name="edit-2" size={18} color={colors.foreground} />
          <Text style={[styles.secondaryBtnText, { color: colors.foreground }]}>Edit</Text>
        </Pressable>
      </View>

      <View style={styles.footer}>
        <Text style={[styles.footerText, { color: colors.mutedForeground }]}>Powered by Elite Marcom</Text>
      </View>
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  headerBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 17,
    fontFamily: FONT.bold,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 36,
  },
  stateIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  stateTitle: {
    fontSize: 19,
    fontFamily: FONT.bold,
    textAlign: "center",
  },
  stateSub: {
    fontSize: 14,
    fontFamily: FONT.regular,
    textAlign: "center",
    lineHeight: 20,
    marginTop: 8,
  },
  avatarCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 14,
    borderWidth: 1,
    marginBottom: 18,
  },
  avatarTitle: {
    fontSize: 14.5,
    fontFamily: FONT.semibold,
  },
  avatarSub: {
    fontSize: 12.5,
    fontFamily: FONT.regular,
    marginTop: 2,
    lineHeight: 17,
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
  sectionTitle: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.6,
    marginTop: 18,
    marginBottom: 12,
  },
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
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  label: {
    fontSize: 12.5,
    fontFamily: FONT.medium,
  },
  eyeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  eyeLabel: {
    fontSize: 11,
    fontFamily: FONT.semibold,
  },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 50,
  },
  input: {
    flex: 1,
    fontSize: 15,
    fontFamily: FONT.regular,
    padding: 0,
  },
  publishRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 14,
    borderWidth: 1,
    marginTop: 22,
  },
  publishIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  publishTitle: {
    fontSize: 15,
    fontFamily: FONT.semibold,
  },
  publishSub: {
    fontSize: 12.5,
    fontFamily: FONT.regular,
    marginTop: 2,
    lineHeight: 17,
  },
  // Card preview
  cardOuter: {
    borderRadius: 24,
    overflow: "hidden",
    backgroundColor: CARD_NAVY,
  },
  orangeBand: {
    height: 6,
    backgroundColor: "#FF6B00",
    width: "100%",
  },
  cardHeader: {
    paddingHorizontal: 26,
    paddingTop: 28,
    paddingBottom: 20,
    alignItems: "center",
  },
  photoRing: {
    width: 96,
    height: 96,
    borderRadius: 48,
    padding: 3,
    backgroundColor: "#FF6B00",
    marginBottom: 16,
  },
  photoInner: {
    width: "100%",
    height: "100%",
    borderRadius: 45,
    overflow: "hidden",
    backgroundColor: "#1A3055",
    alignItems: "center",
    justifyContent: "center",
  },
  photo: {
    width: "100%",
    height: "100%",
    borderRadius: 45,
  },
  designation: {
    fontSize: 11,
    fontFamily: FONT.semibold,
    color: "#FF6B00",
    letterSpacing: 1.4,
    marginBottom: 5,
  },
  cardName: {
    fontSize: 24,
    fontFamily: FONT.bold,
    color: "#FFF7F0",
    textAlign: "center",
    marginBottom: 4,
  },
  cardCompany: {
    fontSize: 13,
    fontFamily: FONT.regular,
    color: "#7A9CC4",
    textAlign: "center",
  },
  cardDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.10)",
    marginHorizontal: 26,
  },
  rows: {
    paddingHorizontal: 26,
    paddingTop: 18,
    paddingBottom: 4,
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
    backgroundColor: "rgba(255,107,0,0.13)",
    alignItems: "center",
    justifyContent: "center",
  },
  cLabel: {
    fontSize: 10,
    fontFamily: FONT.medium,
    color: "#3A5E82",
    letterSpacing: 1,
  },
  cValue: {
    fontSize: 13,
    fontFamily: FONT.regular,
    color: "#C8DDEF",
    marginTop: 1,
  },
  socialRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 26,
    paddingTop: 14,
  },
  socialChip: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(255,107,0,0.13)",
    alignItems: "center",
    justifyContent: "center",
  },
  qrSection: {
    marginHorizontal: 26,
    marginTop: 18,
    marginBottom: 24,
    backgroundColor: CARD_PANEL,
    borderRadius: 18,
    padding: 20,
    alignItems: "center",
    gap: 14,
  },
  qrHeading: {
    fontSize: 10,
    fontFamily: FONT.semibold,
    color: "#FF6B00",
    letterSpacing: 1.4,
  },
  qrWrap: {
    backgroundColor: "#FFFFFF",
    borderRadius: 12,
    padding: 10,
  },
  qrSub: {
    fontSize: 11.5,
    fontFamily: FONT.regular,
    color: "#4A6E94",
    textAlign: "center",
    lineHeight: 18,
  },
  actions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 20,
  },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 20,
    height: 52,
    borderWidth: 1,
  },
  secondaryBtnText: {
    fontSize: 15.5,
    fontFamily: FONT.semibold,
  },
  footer: {
    alignItems: "center",
    marginTop: 26,
  },
  footerText: {
    fontSize: 12,
    fontFamily: FONT.medium,
  },
});
