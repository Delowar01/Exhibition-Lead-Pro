import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams } from "expo-router";
import React from "react";
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type Contact,
  useGetContact,
  useUpdateContact,
  ContactUpdateStatus,
} from "@workspace/api-client-react";

import {
  Avatar,
  Badge,
  CONTACT_STATUS_COLORS,
  ErrorState,
  FONT,
  LEAD_TEMPERATURE_COLORS,
  LoadingState,
  prettyLabel,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";

const STATUS_OPTIONS = Object.values(ContactUpdateStatus);

function contactName(c: Contact): string {
  if (c.fullName) return c.fullName;
  const parts = [c.firstName, c.lastName].filter(Boolean);
  return parts.length ? parts.join(" ") : "Unnamed contact";
}

export default function ContactDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const contactId = Number(id);

  const query = useGetContact(contactId);
  const updateContact = useUpdateContact();

  const contact = query.data;

  function action(type: "call" | "email" | "web", value?: string | null) {
    if (!value) return;
    if (Platform.OS !== "web") Haptics.selectionAsync();
    const url =
      type === "call"
        ? `tel:${value}`
        : type === "email"
          ? `mailto:${value}`
          : value.startsWith("http")
            ? value
            : `https://${value}`;
    Linking.openURL(url).catch(() => {});
  }

  async function changeStatus(status: keyof typeof ContactUpdateStatus) {
    if (!contact) return;
    if (Platform.OS !== "web") Haptics.selectionAsync();
    await updateContact.mutateAsync({
      id: contact.id,
      data: { status },
    });
    query.refetch();
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: contact ? contactName(contact) : "Contact",
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
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40 }}
        >
          {/* Hero */}
          <View style={styles.hero}>
            <Avatar
              name={contactName(contact)}
              size={76}
              color={CONTACT_STATUS_COLORS[contact.status] ?? colors.primary}
            />
            <Text style={[styles.heroName, { color: colors.foreground }]}>
              {contactName(contact)}
            </Text>
            {contact.jobTitle || contact.contactCompany ? (
              <Text style={[styles.heroSub, { color: colors.mutedForeground }]}>
                {[contact.jobTitle, contact.contactCompany].filter(Boolean).join(" · ")}
              </Text>
            ) : null}
            <View style={{ marginTop: 10 }}>
              <Badge
                label={prettyLabel(contact.status)}
                color={CONTACT_STATUS_COLORS[contact.status] ?? colors.mutedForeground}
              />
            </View>
          </View>

          {/* Quick actions */}
          <View style={styles.actionsRow}>
            <QuickAction icon="phone" label="Call" disabled={!contact.mobile} onPress={() => action("call", contact.mobile)} />
            <QuickAction icon="mail" label="Email" disabled={!contact.email} onPress={() => action("email", contact.email)} />
            <QuickAction icon="globe" label="Website" disabled={!contact.website} onPress={() => action("web", contact.website)} />
          </View>

          {/* Lead intelligence */}
          {contact.leadTemperature || typeof contact.leadScore === "number" ? (
            <Section title="Lead intelligence">
              <View style={styles.leadRow}>
                {contact.leadTemperature ? (
                  <Badge
                    label={prettyLabel(contact.leadTemperature)}
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
            </Section>
          ) : null}

          {/* Details */}
          <Section title="Details">
            <DetailRow icon="mail" label="Email" value={contact.email} />
            <DetailRow icon="phone" label="Mobile" value={contact.mobile} />
            <DetailRow icon="phone-call" label="Office" value={contact.officePhone} />
            <DetailRow icon="globe" label="Website" value={contact.website} />
            <DetailRow icon="linkedin" label="LinkedIn" value={contact.linkedin} />
            <DetailRow icon="map-pin" label="Address" value={contact.address} />
            <DetailRow icon="flag" label="Country" value={contact.country} />
            {contact.eventName ? (
              <DetailRow icon="calendar" label="Event" value={contact.eventName} />
            ) : null}
          </Section>

          {contact.notes ? (
            <Section title="Notes">
              <Text style={[styles.notes, { color: colors.foreground }]}>
                {contact.notes}
              </Text>
            </Section>
          ) : null}

          {/* Status picker */}
          <Section title="Update status">
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
                    <Text
                      style={[
                        styles.statusOptionText,
                        { color: active ? "#FFFFFF" : colors.foreground },
                      ]}
                    >
                      {prettyLabel(status)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Section>
        </ScrollView>
      )}
    </View>
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
  actionsRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 20,
  },
  quickAction: {
    flex: 1,
    alignItems: "center",
    gap: 8,
    paddingVertical: 16,
    borderWidth: 1,
  },
  quickIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  quickLabel: {
    fontSize: 13,
    fontFamily: FONT.medium,
  },
  sectionTitle: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.6,
    marginBottom: 8,
    marginLeft: 4,
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
  statusGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    padding: 8,
  },
  statusOption: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
  },
  statusOptionText: {
    fontSize: 13.5,
    fontFamily: FONT.medium,
  },
});
