import { Feather } from "@/components/icons";
import * as FileSystem from "expo-file-system/legacy";
import * as Haptics from "expo-haptics";
import * as IntentLauncher from "expo-intent-launcher";
import * as Sharing from "expo-sharing";
import React, { useMemo, useState } from "react";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  getListContactCommunicationsQueryKey,
  getListLeadCommunicationsQueryKey,
  type LeadActivity,
  useCreateContactCalendarInvite,
  useListContactCommunications,
  useListLeadCommunications,
  useLogContactCommunication,
  useLogLeadCommunication,
} from "@workspace/api-client-react";

import { DateTimeField } from "@/components/DateTimeField";
import { FONT } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";

type Channel = "email" | "phone" | "whatsapp" | "calendar";

interface Props {
  entity: "contact" | "lead";
  id: number;
  email?: string | null;
  phone?: string | null;
  displayName?: string | null;
}

const CHANNEL_ICON: Record<string, keyof typeof Feather.glyphMap> = {
  email: "mail",
  call: "phone",
  message: "message-circle",
  meeting: "calendar",
};

function digitsOnly(value: string): string {
  return value.replace(/[^\d]/g, "");
}

/** Local Date → basic iCal timestamp (floating local time). */
function toIcsLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}00`
  );
}

export function CommunicationHub({ entity, id, email, phone, displayName }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t, isRTL, textAlign, language } = useLocale();

  const isContact = entity === "contact";

  const contactList = useListContactCommunications(id, {
    query: {
      enabled: isContact && id > 0,
      queryKey: getListContactCommunicationsQueryKey(id),
    },
  });
  const leadList = useListLeadCommunications(id, {
    query: {
      enabled: !isContact && id > 0,
      queryKey: getListLeadCommunicationsQueryKey(id),
    },
  });
  const list = isContact ? contactList : leadList;
  const communications: LeadActivity[] = list.data?.communications ?? [];

  const logContact = useLogContactCommunication();
  const logLead = useLogLeadCommunication();
  const calendarInvite = useCreateContactCalendarInvite();

  const logComm = (channel: Channel, subject: string) => {
    const body = { channel, subject };
    if (isContact) {
      logContact.mutate({ id, data: body });
    } else {
      logLead.mutate({ id, data: body });
    }
  };

  function openUrl(url: string) {
    if (Platform.OS !== "web") Haptics.selectionAsync();
    Linking.openURL(url).catch(() => {
      Alert.alert(t("commHub.unavailableTitle"), t("commHub.unavailableBody"));
    });
  }

  async function handleCall() {
    if (!phone) return;
    if (Platform.OS === "android") {
      try {
        await IntentLauncher.startActivityAsync("android.intent.action.DIAL", {
          data: `tel:${phone}`,
        });
      } catch {
        openUrl(`tel:${phone}`);
      }
    } else {
      openUrl(`tel:${phone}`);
    }
    logComm("phone", t("commHub.logCall", { name: displayName ?? phone }));
  }

  function handleWhatsApp() {
    if (!phone) return;
    const digits = digitsOnly(phone);
    if (Platform.OS === "android") {
      openUrl(`whatsapp://send?phone=${digits}`);
    } else {
      openUrl(`https://wa.me/${digits}`);
    }
    logComm("whatsapp", t("commHub.logWhatsApp", { name: displayName ?? phone }));
  }

  async function handleEmail() {
    if (!email) return;
    if (Platform.OS === "android") {
      try {
        await IntentLauncher.startActivityAsync("android.intent.action.SEND", {
          type: "message/rfc822",
          extra: { "android.intent.extra.EMAIL": [email] },
        });
      } catch {
        Alert.alert(t("commHub.unavailableTitle"), t("commHub.unavailableBody"));
      }
    } else {
      openUrl(`mailto:${email}`);
    }
    logComm("email", t("commHub.logEmail", { email }));
  }

  // ── Calendar ──────────────────────────────────────────────────────────────
  const [calOpen, setCalOpen] = useState(false);
  const [calTitle, setCalTitle] = useState("");
  const [calDate, setCalDate] = useState<string | null>(null);
  const [calTime, setCalTime] = useState<string | null>(null);
  const [calLocation, setCalLocation] = useState("");
  const [calBusy, setCalBusy] = useState(false);

  const openCalendar = () => {
    setCalTitle(
      displayName ? t("commHub.meetingWith", { name: displayName }) : t("commHub.meeting"),
    );
    setCalDate(null);
    setCalTime(null);
    setCalLocation("");
    setCalOpen(true);
  };

  async function shareIcs(ics: string, filename: string) {
    if (Platform.OS === "web") return;
    try {
      const uri = `${FileSystem.cacheDirectory}${filename}`;
      await FileSystem.writeAsStringAsync(uri, ics, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: "text/calendar" });
      }
    } catch {
      // Non-fatal — the meeting is already logged to the timeline.
    }
  }

  async function submitCalendar() {
    if (!calTitle.trim() || !calDate) {
      Alert.alert(t("commHub.calMissingTitle"), t("commHub.calMissingBody"));
      return;
    }
    const start = new Date(`${calDate}T${calTime ?? "09:00"}:00`);
    const duration = 30;
    setCalBusy(true);
    try {
      if (isContact) {
        const res = await calendarInvite.mutateAsync({
          id,
          data: {
            title: calTitle.trim(),
            startAt: start.toISOString(),
            durationMinutes: duration,
            location: calLocation.trim() || null,
          },
        });
        await shareIcs(res.ics, res.filename);
      } else {
        const end = new Date(start.getTime() + duration * 60000);
        const ics = [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "PRODID:-//Card Scanner Pro//Communication Hub//EN",
          "BEGIN:VEVENT",
          `UID:csp-lead-${id}-${Date.now()}@cardscannerpro`,
          `DTSTAMP:${toIcsLocal(new Date())}`,
          `DTSTART:${toIcsLocal(start)}`,
          `DTEND:${toIcsLocal(end)}`,
          `SUMMARY:${calTitle.trim().replace(/,/g, "\\,")}`,
          calLocation.trim()
            ? `LOCATION:${calLocation.trim().replace(/,/g, "\\,")}`
            : "",
          "END:VEVENT",
          "END:VCALENDAR",
        ]
          .filter(Boolean)
          .join("\r\n");
        await logLead.mutateAsync({
          id,
          data: { channel: "calendar", subject: calTitle.trim() },
        });
        await shareIcs(ics, `invite-lead-${id}.ics`);
      }
      setCalOpen(false);
    } catch {
      Alert.alert(t("commHub.calErrorTitle"), t("commHub.calErrorBody"));
    } finally {
      setCalBusy(false);
    }
  }

  const pending =
    logContact.isPending || logLead.isPending || calendarInvite.isPending;

  const dateLocale = language === "ar" ? "ar" : "en-US";

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 2 },
      ]}
    >
      <View style={[styles.header, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
        <Feather name="send" size={16} color={colors.primary} />
        <Text style={[styles.headerText, { color: colors.foreground, textAlign }]}>
          {t("commHub.title")}
        </Text>
      </View>

      <View style={styles.actionsRow}>
        <HubAction icon="phone" label={t("commHub.call")} disabled={!phone || pending} onPress={handleCall} />
        <HubAction icon="message-circle" label={t("commHub.whatsapp")} disabled={!phone || pending} onPress={handleWhatsApp} />
        <HubAction icon="mail" label={t("commHub.email")} disabled={!email || pending} onPress={handleEmail} />
        <HubAction icon="calendar" label={t("commHub.calendar")} disabled={pending} onPress={openCalendar} />
      </View>

      {/* SMS — scaffolded but not yet active */}
      <View
        style={[
          styles.smsRow,
          { borderColor: colors.border, flexDirection: isRTL ? "row-reverse" : "row" },
        ]}
      >
        <Feather name="radio" size={14} color={colors.mutedForeground} />
        <Text style={[styles.smsText, { color: colors.mutedForeground, textAlign }]}>
          {t("commHub.smsComingSoon")}
        </Text>
      </View>

      {!email && !phone ? (
        <Text style={[styles.emptyHint, { color: colors.mutedForeground, textAlign }]}>
          {t("commHub.noContactInfo")}
        </Text>
      ) : null}

      <View style={[styles.timeline, { borderTopColor: colors.border }]}>
        <Text style={[styles.timelineHeading, { color: colors.mutedForeground, textAlign }]}>
          {t("commHub.recent")}
        </Text>
        {list.isLoading ? (
          <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 8 }} />
        ) : communications.length === 0 ? (
          <Text style={[styles.emptyHint, { color: colors.mutedForeground, textAlign }]}>
            {t("commHub.none")}
          </Text>
        ) : (
          communications.slice(0, 6).map((c) => (
            <View
              key={c.id}
              style={[styles.commRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}
            >
              <View style={[styles.commIcon, { backgroundColor: colors.accent }]}>
                <Feather name={CHANNEL_ICON[c.type] ?? "message-square"} size={13} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.commSubject, { color: colors.foreground, textAlign }]} numberOfLines={1}>
                  {c.subject || c.type}
                </Text>
                <Text style={[styles.commDate, { color: colors.mutedForeground, textAlign }]}>
                  {new Date(c.occurredAt).toLocaleString(dateLocale, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </Text>
              </View>
            </View>
          ))
        )}
      </View>

      <Modal
        visible={calOpen}
        transparent
        animationType="slide"
        statusBarTranslucent
        hardwareAccelerated
        onRequestClose={() => setCalOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setCalOpen(false)}>
          <Pressable
            style={[
              styles.sheet,
              { backgroundColor: colors.card, borderColor: colors.border, paddingBottom: insets.bottom + 16 },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.handleWrap}>
              <View style={[styles.handleBar, { backgroundColor: colors.border }]} />
            </View>
            <Text style={[styles.sheetTitle, { color: colors.foreground, textAlign }]}>
              {t("commHub.scheduleMeeting")}
            </Text>

            <ScrollView style={{ maxHeight: 440 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground, textAlign }]}>
                {t("commHub.calTitle")}
              </Text>
              <TextInput
                value={calTitle}
                onChangeText={setCalTitle}
                placeholderTextColor={colors.mutedForeground}
                style={[
                  styles.input,
                  { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground, borderRadius: colors.radius, textAlign },
                ]}
              />

              <View style={{ marginTop: 14 }}>
                <DateTimeField
                  label={t("commHub.calWhen")}
                  date={calDate}
                  time={calTime}
                  minToday
                  onChange={(d, tm) => {
                    setCalDate(d);
                    setCalTime(tm);
                  }}
                />
              </View>

              <Text style={[styles.fieldLabel, { color: colors.mutedForeground, textAlign, marginTop: 14 }]}>
                {t("commHub.calLocation")}
              </Text>
              <TextInput
                value={calLocation}
                onChangeText={setCalLocation}
                placeholder={t("commHub.calLocationPlaceholder")}
                placeholderTextColor={colors.mutedForeground}
                style={[
                  styles.input,
                  { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground, borderRadius: colors.radius, textAlign },
                ]}
              />
            </ScrollView>

            <Pressable
              disabled={calBusy || !calDate || !calTitle.trim()}
              onPress={submitCalendar}
              style={[
                styles.submitBtn,
                { backgroundColor: calDate && calTitle.trim() ? colors.primary : colors.muted },
              ]}
            >
              {calBusy ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.submitText}>{t("commHub.createInvite")}</Text>
              )}
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function HubAction({
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
        styles.action,
        {
          backgroundColor: colors.background,
          borderColor: colors.border,
          borderRadius: colors.radius + 2,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
      ]}
    >
      <View style={[styles.actionIcon, { backgroundColor: colors.accent }]}>
        <Feather name={icon} size={18} color={colors.primary} />
      </View>
      <Text style={[styles.actionLabel, { color: colors.foreground }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    padding: 16,
    marginTop: 16,
  },
  header: {
    alignItems: "center",
    gap: 8,
    marginBottom: 14,
  },
  headerText: {
    flex: 1,
    fontSize: 14,
    fontFamily: FONT.semibold,
  },
  actionsRow: {
    flexDirection: "row",
    gap: 8,
  },
  action: {
    flex: 1,
    alignItems: "center",
    gap: 6,
    paddingVertical: 12,
    borderWidth: 1,
  },
  actionIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  actionLabel: {
    fontSize: 11,
    fontFamily: FONT.medium,
  },
  smsRow: {
    alignItems: "center",
    gap: 8,
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: "dashed",
    borderRadius: 8,
  },
  smsText: {
    flex: 1,
    fontSize: 12,
    fontFamily: FONT.medium,
  },
  emptyHint: {
    fontSize: 12,
    fontFamily: FONT.regular,
    fontStyle: "italic",
    marginTop: 8,
  },
  timeline: {
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  timelineHeading: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  commRow: {
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
  },
  commIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  commSubject: {
    fontSize: 13,
    fontFamily: FONT.medium,
  },
  commDate: {
    fontSize: 11.5,
    fontFamily: FONT.regular,
    marginTop: 1,
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  handleWrap: {
    alignItems: "center",
    paddingVertical: 8,
  },
  handleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
  },
  sheetTitle: {
    fontSize: 17,
    fontFamily: FONT.semibold,
    marginBottom: 14,
  },
  fieldLabel: {
    fontSize: 12,
    fontFamily: FONT.medium,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: FONT.regular,
  },
  submitBtn: {
    marginTop: 16,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  submitText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontFamily: FONT.semibold,
  },
});
