import { Feather } from "@/components/icons";
import * as Contacts from "expo-contacts";
import * as IntentLauncher from "expo-intent-launcher";
import * as FileSystem from "expo-file-system/legacy";
import * as Haptics from "expo-haptics";
import * as MediaLibrary from "expo-media-library";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useQueryClient } from "@tanstack/react-query";

import {
  type Contact,
  type ContactUpdateStatus,
  getBaseUrl,
  getGetContactQueryKey,
  getListUsersQueryKey,
  type MeetingInputType,
  useCreateFollowUp,
  useCreateMeeting,
  useCreateTask,
  useDeleteContact,
  useGetContact,
  useGetContactStatusHistory,
  useListLeads,
  useListUsers,
  useUpdateContact,
} from "@workspace/api-client-react";
import { useAuth } from "@/contexts/AuthContext";
import { useSettings } from "@/contexts/SettingsContext";
import {
  scheduleFollowUpReminder,
  scheduleMeetingReminder,
} from "@/lib/notifications";

import { DateTimeField } from "@/components/DateTimeField";
import {
  Avatar,
  Badge,
  CONTACT_PIPELINE_ORDER,
  CONTACT_STATUS_COLORS,
  CONTACT_STATUS_ICONS,
  ErrorState,
  FONT,
  LEAD_TEMPERATURE_COLORS,
  LoadingState,
  MEETING_TYPE_ICONS,
  prettyLabel,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { formatGregorian } from "@/lib/date";
import { shareContactAsVCard } from "@/lib/vcard";

const STATUS_OPTIONS = CONTACT_PIPELINE_ORDER as ContactUpdateStatus[];
const MEETING_TYPES: MeetingInputType[] = ["online", "physical", "phone_call"];

// Derived (NOT fabricated) follow-up guidance based on the AI lead temperature
// already stored on the contact. Hot leads warrant urgent, high-priority
// outreach; cold leads can wait. No new data is invented — this is a transparent
// rule applied to the real temperature the AI assigned at capture time.
const TEMPERATURE_GUIDANCE: Record<string, { priorityKey: string; windowKey: string; color: string }> = {
  hot: { priorityKey: "contacts.priorityHigh", windowKey: "contacts.followUpWindowHot", color: "#EF4444" },
  warm: { priorityKey: "contacts.priorityMedium", windowKey: "contacts.followUpWindowWarm", color: "#F59E0B" },
  cold: { priorityKey: "contacts.priorityLow", windowKey: "contacts.followUpWindowCold", color: "#3B82F6" },
};

function formatHistoryDate(iso: string): string {
  const d = new Date(iso);
  return formatGregorian(d, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function contactName(c: Contact, fallback: string): string {
  if (c.fullName) return c.fullName;
  const parts = [c.firstName, c.lastName].filter(Boolean);
  return parts.length ? parts.join(" ") : fallback;
}

function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

export default function ContactDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t } = useLocale();
  const { id } = useLocalSearchParams<{ id: string }>();
  const contactId = Number(id);

  const queryClient = useQueryClient();
  const query = useGetContact(contactId);
  const { user, token } = useAuth();
  const settings = useSettings();
  // Optimistic status change: flip the cached contact's status the moment the
  // user taps so the badge updates instantly. Only the `status` write is made
  // optimistic (the critical "instant" path); other writes (e.g. assignment)
  // fall through to the global post-mutation invalidation. On error we roll the
  // cache back. The global invalidation reconciles status history afterwards.
  const updateContact = useUpdateContact({
    mutation: {
      onMutate: async (vars) => {
        if (!vars.data.status) return undefined;
        const key = getGetContactQueryKey(contactId);
        await queryClient.cancelQueries({ queryKey: key });
        const prev = queryClient.getQueryData<Contact>(key);
        if (prev) {
          queryClient.setQueryData<Contact>(key, { ...prev, status: vars.data.status });
        }
        return { prev, key };
      },
      onError: (_err, _vars, ctx) => {
        if (ctx?.prev) queryClient.setQueryData(ctx.key, ctx.prev);
      },
    },
  });
  const deleteContact = useDeleteContact();
  const historyQuery = useGetContactStatusHistory(contactId);
  const leadsQuery = useListLeads({ contactId, limit: 100 });
  const createFollowUp = useCreateFollowUp();
  const createMeeting = useCreateMeeting();
  const createTask = useCreateTask();
  const [assignOpen, setAssignOpen] = useState(false);
  const [schedule, setSchedule] = useState<"followup" | "meeting" | null>(null);
  const [imageModalOpen, setImageModalOpen] = useState(false);
  const [isDownloadingImage, setIsDownloadingImage] = useState(false);

  // Gesture viewer shared values (pinch-zoom + pan + double-tap reset)
  const imgScale = useSharedValue(1);
  const imgSavedScale = useSharedValue(1);
  const imgX = useSharedValue(0);
  const imgSavedX = useSharedValue(0);
  const imgY = useSharedValue(0);
  const imgSavedY = useSharedValue(0);

  const imgAnimStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: imgScale.value },
      { translateX: imgX.value },
      { translateY: imgY.value },
    ],
  }));

  const pinchGesture = Gesture.Pinch()
    .onStart(() => {
      imgSavedScale.value = imgScale.value;
    })
    .onUpdate((e) => {
      imgScale.value = Math.max(0.5, Math.min(6, imgSavedScale.value * e.scale));
    })
    .onEnd(() => {
      if (imgScale.value < 1) {
        imgScale.value = withTiming(1);
        imgX.value = withTiming(0);
        imgY.value = withTiming(0);
        imgSavedScale.value = 1;
        imgSavedX.value = 0;
        imgSavedY.value = 0;
      }
    });

  const panGesture = Gesture.Pan()
    .averageTouches(true)
    .onStart(() => {
      imgSavedX.value = imgX.value;
      imgSavedY.value = imgY.value;
    })
    .onUpdate((e) => {
      imgX.value = imgSavedX.value + e.translationX;
      imgY.value = imgSavedY.value + e.translationY;
    });

  const doubleTapGesture = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      imgScale.value = withTiming(1);
      imgX.value = withTiming(0);
      imgY.value = withTiming(0);
      imgSavedScale.value = 1;
      imgSavedX.value = 0;
      imgSavedY.value = 0;
    });

  const composedImageGesture = Gesture.Exclusive(
    doubleTapGesture,
    Gesture.Simultaneous(pinchGesture, panGesture),
  );

  useEffect(() => {
    if (!imageModalOpen) {
      imgScale.value = 1;
      imgSavedScale.value = 1;
      imgX.value = 0;
      imgSavedX.value = 0;
      imgY.value = 0;
      imgSavedY.value = 0;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageModalOpen]);

  const usersQuery = useListUsers(
    { limit: 100 },
    { query: { enabled: assignOpen, queryKey: getListUsersQueryKey({ limit: 100 }) } },
  );

  const contact = query.data;
  const history = historyQuery.data?.history ?? [];

  async function handleShare() {
    if (!contact) return;
    if (Platform.OS !== "web") Haptics.selectionAsync();
    try {
      await shareContactAsVCard(contact);
    } catch {
      Alert.alert(t("contacts.unavailableTitle"), t("contacts.unavailableBody"));
    }
  }

  function openMaps() {
    if (!contact?.latitude || !contact?.longitude) return;
    if (Platform.OS !== "web") Haptics.selectionAsync();
    const q = `${contact.latitude},${contact.longitude}`;
    openUrl(`https://www.google.com/maps/search/?api=1&query=${q}`);
  }

  function openUrl(url: string) {
    if (Platform.OS !== "web") Haptics.selectionAsync();
    Linking.openURL(url).catch(() => {
      Alert.alert(t("contacts.unavailableTitle"), t("contacts.unavailableBody"));
    });
  }

  async function handleCall() {
    if (!contact?.mobile) return;
    if (Platform.OS === "android") {
      // ACTION_DIAL routes the intent directly to the system phone dialer.
      // Linking.openURL('tel:...') fires ACTION_VIEW which VoIP and calling
      // apps also register for — that triggers the Android app chooser.
      // ACTION_DIAL is exclusively handled by the telephony stack (default
      // phone dialer), so no chooser appears.
      try {
        await IntentLauncher.startActivityAsync("android.intent.action.DIAL", {
          data: `tel:${contact.mobile}`,
        });
      } catch {
        openUrl(`tel:${contact.mobile}`);
      }
    } else {
      openUrl(`tel:${contact.mobile}`);
    }
  }

  function handleWhatsApp() {
    const number = contact?.mobile;
    if (!number) return;
    const name = contact ? contactName(contact, t("common.unnamedContact")) : t("contacts.whatsappThere");
    const msg = encodeURIComponent(t("contacts.whatsappGreeting", { name }));
    const digits = digitsOnly(number);
    if (Platform.OS === "android") {
      // Both WhatsApp (com.whatsapp) and WhatsApp Business (com.whatsapp.w4b)
      // register handlers for the whatsapp:// URI scheme, so Android's intent
      // resolver automatically shows the native app chooser when both are installed
      // and opens the single installed app directly when only one is present.
      // Using intent://...#Intent;package=com.whatsapp;end would pin to consumer
      // WhatsApp only and bypass the chooser — do NOT do that.
      openUrl(`whatsapp://send?phone=${digits}&text=${msg}`);
    } else {
      openUrl(`https://wa.me/${digits}?text=${msg}`);
    }
  }

  async function handleEmail() {
    if (!contact?.email) return;
    if (Platform.OS === "android") {
      // ACTION_SEND with MIME type message/rfc822 shows Android's app picker
      // filtered to email clients (Gmail, Outlook, Samsung Email, etc.).
      // Unlike ACTION_SENDTO / mailto:, ACTION_SEND has no "default app"
      // concept, so the picker always appears when multiple email apps are
      // installed and opens directly when only one is found.
      // On iOS, mailto: is correct — the system always opens the default mail
      // app and iOS has no concept of an email chooser.
      try {
        await IntentLauncher.startActivityAsync(
          "android.intent.action.SEND",
          {
            type: "message/rfc822",
            extra: {
              "android.intent.extra.EMAIL": contact.email,
            },
          },
        );
      } catch {
        // No email app installed — fall back to the same alert as other actions.
        Alert.alert(t("contacts.unavailableTitle"), t("contacts.unavailableBody"));
      }
    } else {
      openUrl(`mailto:${contact.email}`);
    }
  }

  async function handleDownloadImage() {
    const base = getBaseUrl();
    const uri = contact?.cardImageUrl && base ? `${base}${contact.cardImageUrl}` : null;
    if (!uri) return;
    if (Platform.OS === "web") {
      Alert.alert(t("contacts.notAvailableTitle"), t("contacts.notAvailableBody"));
      return;
    }
    setIsDownloadingImage(true);
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== "granted") {
        setIsDownloadingImage(false);
        Alert.alert(
          t("contacts.photoLibraryPermissionTitle"),
          t("contacts.photoLibraryPermissionBody"),
        );
        return;
      }
      const filename = `card_${contact?.id ?? "image"}_${Date.now()}.jpg`;
      const localUri = `${FileSystem.cacheDirectory}${filename}`;
      const result = await FileSystem.downloadAsync(uri, localUri, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      await MediaLibrary.saveToLibraryAsync(result.uri);
      setIsDownloadingImage(false);
      Alert.alert(t("contacts.imageSavedTitle"), t("contacts.imageSavedBody"));
    } catch {
      setIsDownloadingImage(false);
      Alert.alert(t("contacts.imageDownloadErrorTitle"), t("contacts.imageDownloadErrorBody"));
    }
  }

  function handleWebsite() {
    const w = contact?.website;
    if (!w) return;
    openUrl(w.startsWith("http") ? w : `https://${w}`);
  }

  async function handleSaveToContacts() {
    if (!contact) return;
    if (Platform.OS === "web") {
      Alert.alert(
        t("contacts.notAvailableTitle"),
        t("contacts.notAvailableBody"),
      );
      return;
    }
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          t("contacts.permissionTitle"),
          t("contacts.permissionBody"),
        );
        return;
      }
      const emails = contact.email
        ? [{ email: contact.email, label: "work", isPrimary: true }]
        : undefined;
      const phoneNumbers = [
        contact.mobile
          ? { number: contact.mobile, label: "mobile", isPrimary: true }
          : null,
        contact.officePhone
          ? { number: contact.officePhone, label: "work" }
          : null,
      ].filter(Boolean) as Contacts.PhoneNumber[];

      const newContact: Contacts.Contact = {
        contactType: Contacts.ContactTypes.Person,
        name: contactName(contact, t("common.unnamedContact")),
        firstName: contact.firstName ?? undefined,
        lastName: contact.lastName ?? undefined,
        company: contact.contactCompany ?? undefined,
        jobTitle: contact.jobTitle ?? undefined,
        [Contacts.Fields.Emails]: emails,
        [Contacts.Fields.PhoneNumbers]:
          phoneNumbers.length > 0 ? phoneNumbers : undefined,
      };

      await Contacts.presentFormAsync(null, newContact);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert(t("contacts.couldntSaveTitle"), t("contacts.couldntSaveBody"));
    }
  }

  function changeStatus(status: keyof typeof ContactUpdateStatus) {
    if (!contact || updateContact.isPending) return;
    if (Platform.OS !== "web") Haptics.selectionAsync();
    // Fire-and-forget: onMutate flips the cached status instantly, onError rolls
    // it back, and the global post-mutation invalidation refreshes the status
    // history. No manual await/refetch needed.
    updateContact.mutate(
      { id: contact.id, data: { status } },
      { onError: () => Alert.alert(t("contacts.updateFailedTitle"), t("contacts.updateFailedBody")) },
    );
  }

  async function assignTo(userId: number | null) {
    if (!contact) return;
    if (Platform.OS !== "web") Haptics.selectionAsync();
    try {
      await updateContact.mutateAsync({
        id: contact.id,
        data: { assignedToId: userId },
      });
      // Auto-create a follow-up task for the new assignee so it appears in
      // their My Tasks list. Best-effort — failure never blocks the assignment.
      if (userId !== null) {
        const taskTitle = contactName(contact, t("common.unnamedContact"));
        void createTask
          .mutateAsync({
            data: {
              title: taskTitle,
              assignedToId: userId,
              contactId: contact.id,
              type: "follow_up",
            },
          })
          .catch(() => undefined);
      }
      setAssignOpen(false);
      query.refetch();
    } catch {
      Alert.alert(t("contacts.updateFailedTitle"), t("contacts.updateFailedBody"));
    }
  }

  function confirmDelete() {
    if (!contact) return;
    const run = async () => {
      try {
        await deleteContact.mutateAsync({ id: contact.id });
        if (Platform.OS !== "web")
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.back();
      } catch {
        Alert.alert(t("contacts.couldntDeleteTitle"), t("contacts.couldntDeleteBody"));
      }
    };
    if (Platform.OS === "web") {
      void run();
      return;
    }
    Alert.alert(
      t("contacts.deleteTitle"),
      t("contacts.deleteConfirm"),
      [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("common.delete"), style: "destructive", onPress: run },
      ],
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: contact ? contactName(contact, t("common.unnamedContact")) : t("common.contact"),
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.foreground,
          headerTitleStyle: { fontFamily: FONT.semibold },
          headerRight: () =>
            contact ? (
              <Pressable
                onPress={() => router.push(`/contact/edit/${contact.id}`)}
                hitSlop={10}
              >
                <Feather name="edit-2" size={19} color={colors.primary} />
              </Pressable>
            ) : null,
        }}
      />

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError || !contact ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40, flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Hero */}
          <View style={styles.hero}>
            <Avatar
              name={contactName(contact, t("common.unnamedContact"))}
              size={76}
              color={CONTACT_STATUS_COLORS[contact.status] ?? colors.primary}
            />
            <Text style={[styles.heroName, { color: colors.foreground }]}>
              {contactName(contact, t("common.unnamedContact"))}
            </Text>
            {contact.jobTitle || contact.contactCompany ? (
              <Text style={[styles.heroSub, { color: colors.mutedForeground }]}>
                {[contact.jobTitle, contact.contactCompany].filter(Boolean).join(" · ")}
              </Text>
            ) : null}
            <View style={styles.heroBadges}>
              <Badge
                label={t(`leads.stages.${contact.status}`, { defaultValue: prettyLabel(contact.status) })}
                color={CONTACT_STATUS_COLORS[contact.status] ?? colors.mutedForeground}
              />
              {contact.assignedToName ? (
                <Badge
                  label={contact.assignedToName}
                  color={colors.primary}
                />
              ) : null}
            </View>
          </View>

          {/* Primary lead actions */}
          <View style={styles.actionsRow}>
            <QuickAction icon="phone" label={t("contacts.callMobile")} disabled={!contact.mobile} onPress={handleCall} />
            <QuickAction icon="message-circle" label={t("contacts.whatsapp")} disabled={!contact.mobile} onPress={handleWhatsApp} />
            <QuickAction icon="mail" label={t("contacts.sendEmail")} disabled={!contact.email} onPress={handleEmail} />
            <QuickAction icon="globe" label={t("contacts.openWebsite")} disabled={!contact.website} onPress={handleWebsite} />
          </View>

          {/* Lead intelligence */}
          {contact.leadTemperature || typeof contact.leadScore === "number" ? (
            <Section title={t("contacts.sectionLeadIntel")}>
              <View style={styles.leadRow}>
                {contact.leadTemperature ? (
                  <Badge
                    label={t(`leads.${contact.leadTemperature}`, { defaultValue: prettyLabel(contact.leadTemperature) })}
                    color={LEAD_TEMPERATURE_COLORS[contact.leadTemperature] ?? colors.mutedForeground}
                  />
                ) : null}
                {typeof contact.leadScore === "number" ? (
                  <Text style={[styles.leadScore, { color: colors.foreground }]}>
                    {contact.leadScore}
                    <Text style={[styles.leadScoreMax, { color: colors.mutedForeground }]}> / 100</Text>
                  </Text>
                ) : null}
              </View>
              {contact.aiReasoning ? (
                <Text style={[styles.leadReason, { color: colors.mutedForeground }]}>
                  {contact.aiReasoning}
                </Text>
              ) : null}
              {contact.leadTemperature && TEMPERATURE_GUIDANCE[contact.leadTemperature] ? (
                <View style={[styles.recommendBox, { borderTopColor: colors.border }]}>
                  <View style={styles.recommendRow}>
                    <Feather name="flag" size={13} color={TEMPERATURE_GUIDANCE[contact.leadTemperature].color} />
                    <Text style={[styles.recommendText, { color: colors.mutedForeground }]}>
                      {t("contacts.recommendedPriority")}:{" "}
                      <Text style={{ color: colors.foreground, fontFamily: FONT.semibold }}>
                        {t(TEMPERATURE_GUIDANCE[contact.leadTemperature].priorityKey)}
                      </Text>
                    </Text>
                  </View>
                  <View style={styles.recommendRow}>
                    <Feather name="clock" size={13} color={colors.mutedForeground} />
                    <Text style={[styles.recommendText, { color: colors.mutedForeground }]}>
                      {t("contacts.recommendedFollowUp")}:{" "}
                      <Text style={{ color: colors.foreground, fontFamily: FONT.semibold }}>
                        {t(TEMPERATURE_GUIDANCE[contact.leadTemperature].windowKey)}
                      </Text>
                    </Text>
                  </View>
                </View>
              ) : null}
            </Section>
          ) : null}

          {/* Sales Pipeline opportunity */}
          {(() => {
            const allLeads = leadsQuery.data?.leads ?? [];
            const openLead = allLeads.find(l => l.stage !== "lost");
            return (
              <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
                  {t("pipeline.title", { defaultValue: "SALES PIPELINE" }).toUpperCase()}
                </Text>
                {openLead ? (
                  <Pressable
                    onPress={() => router.push(`/pipeline/${openLead.id}`)}
                    style={({ pressed }) => [styles.pipelineBtn, { backgroundColor: colors.primary + "15", borderColor: colors.primary, opacity: pressed ? 0.75 : 1 }]}
                  >
                    <Feather name="trending-up" size={16} color={colors.primary} />
                    <Text style={[styles.pipelineBtnText, { color: colors.primary }]}>
                      {t("pipeline.viewPipeline")}
                    </Text>
                    <Feather name="chevron-right" size={16} color={colors.primary} style={{ marginLeft: "auto" }} />
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={() => router.push(`/pipeline/form?contactId=${contactId}`)}
                    style={({ pressed }) => [styles.pipelineBtn, { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.75 : 1 }]}
                  >
                    <Feather name="plus-circle" size={16} color={colors.mutedForeground} />
                    <Text style={[styles.pipelineBtnText, { color: colors.foreground }]}>
                      {t("pipeline.addToPipeline")}
                    </Text>
                  </Pressable>
                )}
              </View>
            );
          })()}

          {/* Details */}
          <Section title={t("contacts.sectionDetails")}>
            <DetailRow icon="mail" label={t("contacts.fields.email")} value={contact.email} />
            <DetailRow icon="phone" label={t("contacts.fields.mobile")} value={contact.mobile} />
            <DetailRow icon="phone-call" label={t("contacts.office")} value={contact.officePhone} />
            <DetailRow icon="globe" label={t("contacts.fields.website")} value={contact.website} />
            <DetailRow icon="linkedin" label="LinkedIn" value={contact.linkedin} />
            <DetailRow icon="map-pin" label={t("contacts.fields.address")} value={contact.address} />
            <DetailRow icon="flag" label={t("contacts.fields.country")} value={contact.country} />
            {contact.eventName ? (
              <DetailRow icon="calendar" label={t("contacts.fields.event")} value={contact.eventName} />
            ) : null}
            {contact.latitude && contact.longitude ? (
              <Pressable onPress={openMaps} style={styles.detailRow}>
                <Feather name="map-pin" size={17} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>
                    {t("contacts.captureLocation")}
                  </Text>
                  <Text style={[styles.detailValue, { color: colors.primary }]}>
                    {t("contacts.viewOnMaps")}
                    {typeof contact.gpsAccuracy === "number"
                      ? ` · ±${Math.round(contact.gpsAccuracy)}m`
                      : ""}
                  </Text>
                </View>
                <Feather name="external-link" size={16} color={colors.mutedForeground} />
              </Pressable>
            ) : null}
          </Section>

          {contact.notes ? (
            <Section title={t("contacts.notes")}>
              <Text style={[styles.notes, { color: colors.foreground }]}>
                {contact.notes}
              </Text>
            </Section>
          ) : null}

          {/* Captured card image */}
          {(() => {
            const base = getBaseUrl();
            if (!contact.cardImageUrl || !base) return null;
            return (
              <Section title={t("contacts.sectionCapturedCard")}>
                <ManageRow
                  icon="eye"
                  label={t("contacts.previewImage")}
                  onPress={() => setImageModalOpen(true)}
                />
                <ManageRow
                  icon="download"
                  label={t("contacts.downloadImage")}
                  onPress={handleDownloadImage}
                  loading={isDownloadingImage}
                  divider
                />
              </Section>
            );
          })()}

          {/* Schedule */}
          <Section title={t("contacts.sectionSchedule")}>
            <ManageRow
              icon="clock"
              label={t("contacts.scheduleFollowUp")}
              onPress={() => setSchedule("followup")}
            />
            <ManageRow
              icon="calendar"
              label={t("contacts.scheduleMeeting")}
              onPress={() => setSchedule("meeting")}
              divider
            />
          </Section>

          {/* Manage */}
          <Section title={t("contacts.sectionManage")}>
            <ManageRow
              icon="share-2"
              label={t("contacts.shareContact")}
              onPress={handleShare}
            />
            <ManageRow
              icon="user-plus"
              label={t("contacts.saveToPhone")}
              onPress={handleSaveToContacts}
              divider
            />
            <ManageRow
              icon="users"
              label={contact.assignedToName ? t("contacts.assignedTo", { name: contact.assignedToName }) : t("contacts.assignToTeammate")}
              onPress={() => setAssignOpen(true)}
              divider
            />
            <ManageRow
              icon="trash-2"
              label={t("contacts.deleteTitle")}
              destructive
              onPress={confirmDelete}
              divider
            />
          </Section>

          {/* Status pipeline */}
          <Section title={t("contacts.sectionLeadPipeline")}>
            <View style={styles.statusGrid}>
              {STATUS_OPTIONS.map((status) => {
                const active = contact.status === status;
                const color = CONTACT_STATUS_COLORS[status] ?? colors.primary;
                return (
                  <Pressable
                    key={status}
                    onPress={() => changeStatus(status)}
                    disabled={updateContact.isPending}
                    style={[
                      styles.statusOption,
                      {
                        backgroundColor: active ? color : colors.card,
                        borderColor: active ? color : colors.border,
                        borderRadius: colors.radius,
                      },
                    ]}
                  >
                    <Feather
                      name={CONTACT_STATUS_ICONS[status] ?? "circle"}
                      size={14}
                      color={active ? "#FFFFFF" : color}
                    />
                    <Text
                      style={[
                        styles.statusOptionText,
                        { color: active ? "#FFFFFF" : colors.foreground },
                      ]}
                    >
                      {t(`leads.stages.${status}`, { defaultValue: prettyLabel(status) })}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Section>

          {/* Status history */}
          {history.length > 0 ? (
            <Section title={t("contacts.sectionStatusHistory")}>
              <View style={{ padding: 8, gap: 14 }}>
                {history.map((h, idx) => {
                  const color = CONTACT_STATUS_COLORS[h.toStatus] ?? colors.primary;
                  return (
                    <View key={h.id} style={styles.historyRow}>
                      <View style={styles.historyTimeline}>
                        <View style={[styles.historyDot, { backgroundColor: color }]} />
                        {idx < history.length - 1 ? (
                          <View style={[styles.historyLine, { backgroundColor: colors.border }]} />
                        ) : null}
                      </View>
                      <View style={{ flex: 1, paddingBottom: 2 }}>
                        <Text style={[styles.historyStatus, { color: colors.foreground }]}>
                          {h.fromStatus ? `${t(`leads.stages.${h.fromStatus}`, { defaultValue: prettyLabel(h.fromStatus) })} → ` : ""}
                          {t(`leads.stages.${h.toStatus}`, { defaultValue: prettyLabel(h.toStatus) })}
                        </Text>
                        <Text style={[styles.historyMeta, { color: colors.mutedForeground }]}>
                          {formatHistoryDate(h.createdAt)}
                          {h.changedByName ? ` · ${h.changedByName}` : ""}
                        </Text>
                        {h.comment ? (
                          <Text style={[styles.historyComment, { color: colors.mutedForeground }]}>
                            {h.comment}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </View>
            </Section>
          ) : null}
        </ScrollView>
      )}

      {/* Assign modal */}
      <Modal
        visible={assignOpen}
        transparent
        animationType="slide"
        statusBarTranslucent
        hardwareAccelerated
        onRequestClose={() => setAssignOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setAssignOpen(false)}
        >
          <Pressable
            style={[
              styles.modalSheet,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                paddingBottom: insets.bottom + 16,
                overflow: "hidden",
              },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.modalHandle}>
              <View style={[styles.handleBar, { backgroundColor: colors.border }]} />
            </View>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              {t("contacts.assignContact")}
            </Text>

            {usersQuery.isLoading ? (
              <View style={{ height: 120 }}>
                <LoadingState />
              </View>
            ) : (
              <ScrollView style={{ maxHeight: 360 }}>
                <Pressable
                  onPress={() => assignTo(null)}
                  style={({ pressed }) => [
                    styles.assignRow,
                    { opacity: pressed ? 0.6 : 1 },
                  ]}
                >
                  <View style={[styles.assignIcon, { backgroundColor: colors.muted }]}>
                    <Feather name="user-x" size={18} color={colors.mutedForeground} />
                  </View>
                  <Text style={[styles.assignName, { color: colors.foreground }]}>
                    {t("contacts.unassigned")}
                  </Text>
                  {!contact?.assignedToId ? (
                    <Feather name="check" size={18} color={colors.primary} />
                  ) : null}
                </Pressable>
                {(usersQuery.data?.users ?? [])
                  .filter((u) => u.isActive !== false && u.id !== user?.id)
                  .map((u) => {
                    const active = contact?.assignedToId === u.id;
                    return (
                      <Pressable
                        key={u.id}
                        onPress={() => assignTo(u.id)}
                        style={({ pressed }) => [
                          styles.assignRow,
                          { opacity: pressed ? 0.6 : 1 },
                        ]}
                      >
                        <Avatar name={u.name} size={36} color={colors.primary} />
                        <View style={{ flex: 1 }}>
                          <Text numberOfLines={1} style={[styles.assignName, { color: colors.foreground }]}>
                            {u.name}
                          </Text>
                          <Text numberOfLines={1} style={[styles.assignRole, { color: colors.mutedForeground }]}>
                            {prettyLabel(u.role)}
                          </Text>
                        </View>
                        {active ? (
                          <Feather name="check" size={18} color={colors.primary} />
                        ) : null}
                      </Pressable>
                    );
                  })}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Full-screen card image viewer — pinch-to-zoom + pan + double-tap reset */}
      {(() => {
        const base = getBaseUrl();
        const uri = contact?.cardImageUrl && base ? `${base}${contact.cardImageUrl}` : null;
        const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
        return (
          <Modal
            visible={imageModalOpen}
            transparent
            animationType="fade"
            statusBarTranslucent
            hardwareAccelerated
            onRequestClose={() => setImageModalOpen(false)}
          >
            <View style={styles.imageViewerBackdrop}>
              {uri ? (
                <GestureDetector gesture={composedImageGesture}>
                  <Animated.Image
                    source={{ uri, headers }}
                    style={[styles.imageViewerFull, imgAnimStyle]}
                    resizeMode="contain"
                  />
                </GestureDetector>
              ) : null}
              <Pressable
                style={[styles.imageViewerClose, { backgroundColor: colors.card }]}
                onPress={() => setImageModalOpen(false)}
                hitSlop={12}
              >
                <Feather name="x" size={20} color={colors.foreground} />
              </Pressable>
            </View>
          </Modal>
        );
      })()}

      {/* Schedule follow-up / meeting */}
      <ScheduleModal
        kind={schedule}
        contactName={contact ? contactName(contact, t("common.unnamedContact")) : ""}
        pending={createFollowUp.isPending || createMeeting.isPending}
        onClose={() => setSchedule(null)}
        onSubmit={async ({ date, time, notes, type }) => {
          if (!contact) return;
          if (Platform.OS !== "web")
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          if (schedule === "followup") {
            const created = await createFollowUp.mutateAsync({
              data: {
                contactId: contact.id,
                scheduledDate: date,
                scheduledTime: time,
                notes: notes || null,
              },
            });
            if (settings.followUpNotifications) {
              void scheduleFollowUpReminder(created);
            }
          } else {
            const created = await createMeeting.mutateAsync({
              data: {
                contactId: contact.id,
                meetingDate: date,
                meetingTime: time,
                type: type ?? "online",
                notes: notes || null,
              },
            });
            if (settings.meetingReminders) {
              void scheduleMeetingReminder(created);
            }
          }
          setSchedule(null);
          query.refetch();
        }}
      />
    </View>
  );
}

function ScheduleModal({
  kind,
  contactName,
  onClose,
  onSubmit,
  pending,
}: {
  kind: "followup" | "meeting" | null;
  contactName: string;
  onClose: () => void;
  onSubmit: (v: {
    date: string;
    time: string | null;
    notes: string;
    type?: MeetingInputType;
  }) => void;
  pending: boolean;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t } = useLocale();
  const [date, setDate] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [type, setType] = useState<MeetingInputType>("online");

  React.useEffect(() => {
    if (kind) {
      setDate(null);
      setTime(null);
      setNotes("");
      setType("online");
    }
  }, [kind]);

  const isMeeting = kind === "meeting";

  return (
    <Modal visible={!!kind} transparent animationType="slide" statusBarTranslucent hardwareAccelerated onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable
          style={[
            styles.modalSheet,
            { backgroundColor: colors.card, borderColor: colors.border, paddingBottom: insets.bottom + 16, overflow: "hidden" },
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.modalHandle}>
            <View style={[styles.handleBar, { backgroundColor: colors.border }]} />
          </View>
          <Text style={[styles.modalTitle, { color: colors.foreground }]}>
            {isMeeting ? t("contacts.scheduleMeeting") : t("contacts.scheduleFollowUp")}
          </Text>
          <Text style={[styles.scheduleSub, { color: colors.mutedForeground }]}>
            {contactName}
          </Text>

          <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
            {isMeeting ? (
              <>
                <Text style={[styles.scheduleLabel, { color: colors.mutedForeground }]}>{t("contacts.typeLabel")}</Text>
                <View style={styles.scheduleChips}>
                  {MEETING_TYPES.map((mt) => {
                    const active = type === mt;
                    return (
                      <Pressable
                        key={mt}
                        onPress={() => setType(mt)}
                        style={[
                          styles.scheduleChip,
                          { backgroundColor: active ? colors.primary : colors.background, borderColor: active ? colors.primary : colors.border },
                        ]}
                      >
                        <Feather
                          name={MEETING_TYPE_ICONS[mt] ?? "calendar"}
                          size={14}
                          color={active ? "#FFFFFF" : colors.foreground}
                        />
                        <Text style={[styles.scheduleChipText, { color: active ? "#FFFFFF" : colors.foreground }]}>
                          {t(`tasks.types.${mt}`, { defaultValue: prettyLabel(mt) })}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : null}

            <View style={{ marginTop: 16 }}>
              <DateTimeField
                label={t("contacts.dateTime")}
                date={date}
                time={time}
                minToday
                onChange={(d, t) => {
                  setDate(d);
                  setTime(t);
                }}
              />
            </View>

            <Text style={[styles.scheduleLabel, { color: colors.mutedForeground }]}>
              {t("contacts.notesOptional")}
            </Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder={isMeeting ? t("contacts.agendaPlaceholder") : t("contacts.followUpPlaceholder")}
              placeholderTextColor={colors.mutedForeground}
              multiline
              style={[
                styles.scheduleNotes,
                { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground, borderRadius: colors.radius },
              ]}
            />
          </ScrollView>

          <Pressable
            disabled={pending || !date}
            onPress={() => date && onSubmit({ date, time, notes, type: isMeeting ? type : undefined })}
            style={[styles.scheduleBtn, { backgroundColor: date ? colors.primary : colors.muted }]}
          >
            <Text style={styles.scheduleBtnText}>
              {pending ? t("common.saving") : isMeeting ? t("contacts.scheduleMeeting") : t("contacts.scheduleFollowUp")}
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function QuickAction({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.quickAction,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderRadius: colors.radius + 4,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
      ]}
    >
      <View style={[styles.quickIcon, { backgroundColor: colors.accent }]}>
        <Feather name={icon} size={20} color={colors.primary} />
      </View>
      <Text style={[styles.quickLabel, { color: colors.foreground }]}>{label}</Text>
    </Pressable>
  );
}

function ManageRow({
  icon,
  label,
  onPress,
  destructive,
  divider,
  loading,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  divider?: boolean;
  loading?: boolean;
}) {
  const colors = useColors();
  const tint = loading ? colors.mutedForeground : destructive ? colors.destructive : colors.foreground;
  return (
    <Pressable
      onPress={loading ? undefined : onPress}
      style={({ pressed }) => [
        styles.manageRow,
        divider && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
        !loading && pressed && { backgroundColor: colors.muted },
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : (
        <Feather name={icon} size={18} color={destructive ? colors.destructive : colors.primary} />
      )}
      <Text style={[styles.manageLabel, { color: tint }]}>
        {loading ? "Downloading…" : label}
      </Text>
      {!loading && <Feather name="chevron-right" size={18} color={colors.mutedForeground} />}
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ marginTop: 24 }}>
      <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
        {title.toUpperCase()}
      </Text>
      <View
        style={[
          styles.sectionBody,
          { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

function DetailRow({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value?: string | null;
}) {
  const colors = useColors();
  if (!value) return null;
  return (
    <View style={styles.detailRow}>
      <Feather name={icon} size={17} color={colors.mutedForeground} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>
          {label}
        </Text>
        <Text style={[styles.detailValue, { color: colors.foreground }]}>
          {value}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    alignItems: "center",
    paddingVertical: 12,
  },
  heroName: {
    fontSize: 24,
    fontFamily: FONT.bold,
    marginTop: 14,
    textAlign: "center",
  },
  heroSub: {
    fontSize: 15,
    fontFamily: FONT.regular,
    marginTop: 4,
    textAlign: "center",
  },
  heroBadges: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginTop: 10,
  },
  actionsRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 20,
  },
  quickAction: {
    flex: 1,
    alignItems: "center",
    gap: 8,
    paddingVertical: 14,
    borderWidth: 1,
  },
  quickIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  quickLabel: {
    fontSize: 12,
    fontFamily: FONT.medium,
  },
  sectionTitle: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.6,
    marginBottom: 8,
    marginLeft: 4,
  },
  section: {
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    gap: 10,
  },
  pipelineBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  pipelineBtnText: {
    fontSize: 14,
    fontFamily: FONT.semibold,
    flex: 1,
  },
  sectionBody: {
    borderWidth: 1,
    padding: 4,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  detailLabel: {
    fontSize: 12,
    fontFamily: FONT.regular,
  },
  detailValue: {
    fontSize: 15,
    fontFamily: FONT.medium,
    marginTop: 1,
  },
  notes: {
    fontSize: 15,
    fontFamily: FONT.regular,
    lineHeight: 22,
    padding: 12,
  },
  leadRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  leadScore: {
    fontSize: 22,
    fontFamily: FONT.bold,
  },
  leadScoreMax: {
    fontSize: 14,
    fontFamily: FONT.regular,
  },
  leadReason: {
    fontSize: 14,
    fontFamily: FONT.regular,
    lineHeight: 20,
    padding: 12,
  },
  manageRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 12,
    paddingVertical: 14,
    borderRadius: 6,
  },
  manageLabel: {
    flex: 1,
    fontSize: 15,
    fontFamily: FONT.medium,
  },
  statusGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    padding: 8,
  },
  statusOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
  },
  statusOptionText: {
    fontSize: 13.5,
    fontFamily: FONT.medium,
  },
  historyRow: {
    flexDirection: "row",
    gap: 12,
  },
  historyTimeline: {
    alignItems: "center",
    width: 12,
  },
  historyDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginTop: 3,
  },
  historyLine: {
    flex: 1,
    width: 2,
    marginTop: 2,
  },
  historyStatus: {
    fontSize: 14.5,
    fontFamily: FONT.semibold,
  },
  historyMeta: {
    fontSize: 12.5,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  historyComment: {
    fontSize: 13.5,
    fontFamily: FONT.regular,
    marginTop: 4,
    fontStyle: "italic",
  },
  scheduleSub: {
    fontSize: 14,
    fontFamily: FONT.regular,
    marginLeft: 4,
    marginBottom: 8,
  },
  scheduleLabel: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 8,
    marginLeft: 4,
  },
  scheduleChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  scheduleChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
  },
  scheduleChipText: {
    fontSize: 13.5,
    fontFamily: FONT.medium,
  },
  scheduleNotes: {
    borderWidth: 1,
    padding: 12,
    minHeight: 80,
    fontSize: 14.5,
    fontFamily: FONT.regular,
    textAlignVertical: "top",
  },
  scheduleBtn: {
    marginTop: 14,
    height: 52,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  scheduleBtnText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontFamily: FONT.semibold,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  modalHandle: {
    alignItems: "center",
    paddingVertical: 8,
  },
  handleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: FONT.bold,
    marginBottom: 8,
    marginLeft: 4,
  },
  assignRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  assignIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  assignName: {
    fontSize: 15,
    fontFamily: FONT.semibold,
  },
  assignRole: {
    fontSize: 12.5,
    fontFamily: FONT.regular,
    marginTop: 1,
  },
  recommendBox: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    gap: 8,
  },
  recommendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  recommendText: {
    fontSize: 13.5,
    fontFamily: FONT.regular,
    flex: 1,
  },
  imageViewerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.94)",
    alignItems: "center",
    justifyContent: "center",
  },
  imageViewerFull: {
    width: "100%",
    height: "80%",
  },
  imageViewerClose: {
    position: "absolute",
    top: 56,
    right: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
});
