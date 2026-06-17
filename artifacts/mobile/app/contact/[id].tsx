import { Feather } from "@expo/vector-icons";
import * as Contacts from "expo-contacts";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
  Linking,
  Modal,
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
  ContactUpdateStatus,
  getListUsersQueryKey,
  useDeleteContact,
  useGetContact,
  useListUsers,
  useUpdateContact,
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

function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

export default function ContactDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const contactId = Number(id);

  const query = useGetContact(contactId);
  const updateContact = useUpdateContact();
  const deleteContact = useDeleteContact();

  const [assignOpen, setAssignOpen] = useState(false);
  const usersQuery = useListUsers(
    { limit: 100 },
    { query: { enabled: assignOpen, queryKey: getListUsersQueryKey({ limit: 100 }) } },
  );

  const contact = query.data;

  function openUrl(url: string) {
    if (Platform.OS !== "web") Haptics.selectionAsync();
    Linking.openURL(url).catch(() => {
      Alert.alert("Unavailable", "No app is available to handle this action.");
    });
  }

  function handleCall() {
    if (contact?.mobile) openUrl(`tel:${contact.mobile}`);
  }

  function handleWhatsApp() {
    const number = contact?.mobile;
    if (!number) return;
    const name = contact ? contactName(contact) : "there";
    const msg = encodeURIComponent(
      `Hi ${name}, great connecting with you. Following up on our conversation.`,
    );
    openUrl(`https://wa.me/${digitsOnly(number)}?text=${msg}`);
  }

  function handleEmail() {
    if (contact?.email) openUrl(`mailto:${contact.email}`);
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
        "Not available",
        "Saving to the device address book is only available on the mobile app.",
      );
      return;
    }
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Permission needed",
          "Allow contacts access to save this lead to your phone.",
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
        name: contactName(contact),
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
      Alert.alert("Couldn't save", "We weren't able to open the contact form.");
    }
  }

  async function changeStatus(status: keyof typeof ContactUpdateStatus) {
    if (!contact) return;
    if (Platform.OS !== "web") Haptics.selectionAsync();
    await updateContact.mutateAsync({ id: contact.id, data: { status } });
    query.refetch();
  }

  async function assignTo(userId: number | null) {
    if (!contact) return;
    if (Platform.OS !== "web") Haptics.selectionAsync();
    await updateContact.mutateAsync({
      id: contact.id,
      data: { assignedToId: userId },
    });
    setAssignOpen(false);
    query.refetch();
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
        Alert.alert("Couldn't delete", "Please try again.");
      }
    };
    if (Platform.OS === "web") {
      void run();
      return;
    }
    Alert.alert(
      "Delete contact",
      `Remove ${contactName(contact)}? This can't be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: run },
      ],
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: contact ? contactName(contact) : "Contact",
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
            <View style={styles.heroBadges}>
              <Badge
                label={prettyLabel(contact.status)}
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
            <QuickAction icon="phone" label="Call" disabled={!contact.mobile} onPress={handleCall} />
            <QuickAction icon="message-circle" label="WhatsApp" disabled={!contact.mobile} onPress={handleWhatsApp} />
            <QuickAction icon="mail" label="Email" disabled={!contact.email} onPress={handleEmail} />
            <QuickAction icon="globe" label="Website" disabled={!contact.website} onPress={handleWebsite} />
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

          {/* Manage */}
          <Section title="Manage">
            <ManageRow
              icon="user-plus"
              label="Save to phone contacts"
              onPress={handleSaveToContacts}
            />
            <ManageRow
              icon="users"
              label={contact.assignedToName ? `Assigned to ${contact.assignedToName}` : "Assign to teammate"}
              onPress={() => setAssignOpen(true)}
              divider
            />
            <ManageRow
              icon="edit-2"
              label="Edit contact"
              onPress={() => router.push(`/contact/edit/${contact.id}`)}
              divider
            />
            <ManageRow
              icon="trash-2"
              label="Delete contact"
              destructive
              onPress={confirmDelete}
              divider
            />
          </Section>

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

      {/* Assign modal */}
      <Modal
        visible={assignOpen}
        transparent
        animationType="slide"
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
              },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.modalHandle}>
              <View style={[styles.handleBar, { backgroundColor: colors.border }]} />
            </View>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              Assign contact
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
                    Unassigned
                  </Text>
                  {!contact?.assignedToId ? (
                    <Feather name="check" size={18} color={colors.primary} />
                  ) : null}
                </Pressable>
                {(usersQuery.data?.users ?? [])
                  .filter((u) => u.isActive !== false)
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

function ManageRow({
  icon,
  label,
  onPress,
  destructive,
  divider,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  divider?: boolean;
}) {
  const colors = useColors();
  const tint = destructive ? colors.destructive : colors.foreground;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.manageRow,
        divider && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
        pressed && { backgroundColor: colors.muted },
      ]}
    >
      <Feather name={icon} size={18} color={destructive ? colors.destructive : colors.primary} />
      <Text style={[styles.manageLabel, { color: tint }]}>{label}</Text>
      <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
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
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
  },
  statusOptionText: {
    fontSize: 13.5,
    fontFamily: FONT.medium,
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
});
