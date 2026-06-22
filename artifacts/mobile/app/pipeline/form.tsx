import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
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
  getGetLeadQueryKey,
  getListContactsQueryKey,
  getListEventsQueryKey,
  getListUsersQueryKey,
  LeadInputStage,
  LeadUpdateStage,
  useCreateLead,
  useGetLead,
  useListContacts,
  useListEvents,
  useListUsers,
  useUpdateLead,
} from "@workspace/api-client-react";

import { DateTimeField } from "@/components/DateTimeField";
import {
  FONT,
  LEAD_STAGE_COLORS,
  LEAD_STAGE_ORDER,
  LoadingState,
  PrimaryButton,
  prettyLabel,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";

const CURRENCIES = ["USD", "EUR", "GBP", "AED", "SAR", "EGP", "QAR", "KWD", "BHD", "OMR", "JOD"];
const PRIORITIES = ["low", "medium", "high"] as const;

function PickerModal({
  visible,
  title,
  items,
  onSelect,
  onClose,
  searchPlaceholder,
  renderItem,
}: {
  visible: boolean;
  title: string;
  items: { id: number | string; label: string; sub?: string }[];
  onSelect: (id: number | string | null) => void;
  onClose: () => void;
  searchPlaceholder?: string;
  renderItem?: (item: { id: number | string; label: string; sub?: string }) => React.ReactNode;
}) {
  const colors = useColors();
  const [search, setSearch] = useState("");
  const filtered = items.filter(i =>
    i.label.toLowerCase().includes(search.toLowerCase()) ||
    (i.sub ?? "").toLowerCase().includes(search.toLowerCase())
  );
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="formSheet">
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={[styles.modalHeader, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
          <Text style={[styles.modalTitle, { color: colors.foreground }]}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <Feather name="x" size={22} color={colors.foreground} />
          </Pressable>
        </View>
        <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="search" size={16} color={colors.mutedForeground} />
          <TextInput
            style={[styles.searchInput, { color: colors.foreground }]}
            placeholder={searchPlaceholder ?? "Search…"}
            placeholderTextColor={colors.mutedForeground}
            value={search}
            onChangeText={setSearch}
            autoFocus
          />
        </View>
        <Pressable onPress={() => { onSelect(null); onClose(); }} style={[styles.pickerItem, { borderBottomColor: colors.border }]}>
          <Text style={[styles.pickerItemText, { color: colors.mutedForeground }]}>— None —</Text>
        </Pressable>
        <ScrollView keyboardShouldPersistTaps="handled">
          {filtered.map(item => (
            <Pressable
              key={String(item.id)}
              onPress={() => { onSelect(item.id); onClose(); }}
              style={({ pressed }) => [styles.pickerItem, { borderBottomColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
            >
              {renderItem ? renderItem(item) : (
                <View>
                  <Text style={[styles.pickerItemText, { color: colors.foreground }]}>{item.label}</Text>
                  {item.sub ? <Text style={[styles.pickerItemSub, { color: colors.mutedForeground }]}>{item.sub}</Text> : null}
                </View>
              )}
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

export default function PipelineFormScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t } = useLocale();
  const params = useLocalSearchParams<{ id?: string; contactId?: string }>();
  const editId = params.id ? parseInt(params.id) : null;
  const prefillContactId = params.contactId ? parseInt(params.contactId) : null;
  const isEdit = editId != null;

  const existingLead = useGetLead(editId ?? 0, { query: { enabled: isEdit, queryKey: getGetLeadQueryKey(editId ?? 0) } });
  const createLead = useCreateLead();
  const updateLead = useUpdateLead();

  const [stage, setStage] = useState("prospect");
  const [title, setTitle] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [probability, setProbability] = useState("");
  const [closingDate, setClosingDate] = useState<string | null>(null);
  const [priority, setPriority] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [contactId, setContactId] = useState<number | null>(prefillContactId);
  const [assignedToId, setAssignedToId] = useState<number | null>(null);
  const [eventId, setEventId] = useState<number | null>(null);

  const [picker, setPicker] = useState<"contact" | "user" | "event" | "stage" | "currency" | null>(null);

  const contactsQuery = useListContacts({ limit: 200 }, { query: { enabled: picker === "contact", queryKey: getListContactsQueryKey({ limit: 200 }) } });
  const usersQuery = useListUsers({ limit: 100 }, { query: { enabled: picker === "user", queryKey: getListUsersQueryKey({ limit: 100 }) } });
  const eventsQuery = useListEvents(undefined, { query: { enabled: picker === "event", queryKey: getListEventsQueryKey(undefined) } });

  const lead = existingLead.data;
  useEffect(() => {
    if (!lead) return;
    setStage(lead.stage ?? "prospect");
    setTitle(lead.title ?? "");
    setCompanyName((lead as { companyName?: string | null }).companyName ?? "");
    setValue(lead.value != null ? String(lead.value) : "");
    setCurrency(lead.currency ?? "USD");
    setProbability(lead.probability != null ? String(lead.probability) : "");
    setClosingDate(lead.closingDate ?? null);
    setPriority(lead.priority ?? null);
    setNotes(lead.notes ?? "");
    setContactId(lead.contactId ?? null);
    setAssignedToId(lead.assignedToId ?? null);
    setEventId(lead.eventId ?? null);
  }, [lead]);

  const contactItems = (contactsQuery.data?.contacts ?? []).map(c => ({
    id: c.id,
    label: (c.fullName ?? [c.firstName, c.lastName].filter(Boolean).join(" ")) || "Unnamed",
    sub: c.contactCompany ?? c.email ?? undefined,
  }));
  const userItems = (usersQuery.data?.users ?? []).map(u => ({ id: u.id, label: u.name ?? "Unknown" }));
  const eventItems = (eventsQuery.data?.events ?? []).map(e => ({ id: e.id, label: e.name }));
  const stageItems = LEAD_STAGE_ORDER.map(s => ({ id: s, label: t(`leads.stages.${s}`, { defaultValue: prettyLabel(s) }) }));
  const currencyItems = CURRENCIES.map(c => ({ id: c, label: c }));

  const selectedContact = contactItems.find(c => c.id === contactId);
  const selectedUser = userItems.find(u => u.id === assignedToId);
  const selectedEvent = eventItems.find(e => e.id === eventId);

  async function handleSave() {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const basePayload = {
      title: title.trim() || null,
      companyName: companyName.trim() || null,
      value: value ? parseFloat(value) : null,
      currency,
      probability: probability ? parseInt(probability) : null,
      closingDate: closingDate ?? null,
      priority: priority ?? null,
      notes: notes.trim() || null,
      contactId: contactId ?? null,
      assignedToId: assignedToId ?? null,
      eventId: eventId ?? null,
    };
    try {
      if (isEdit) {
        const updated = await updateLead.mutateAsync({ id: editId, data: { ...basePayload, stage: stage as LeadUpdateStage } });
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace(`/pipeline/${updated.id}`);
      } else {
        const created = await createLead.mutateAsync({ data: { ...basePayload, stage: stage as LeadInputStage } });
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.replace(`/pipeline/${created.id}`);
      }
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 409) {
        Alert.alert(t("pipeline.duplicate"), "", [{ text: t("common.ok") }]);
      } else {
        Alert.alert(t("pipeline.failedSave"));
      }
    }
  }

  const isSaving = createLead.isPending || updateLead.isPending;

  if (isEdit && existingLead.isLoading) {
    return <LoadingState />;
  }

  const stageColor = LEAD_STAGE_COLORS[stage] ?? colors.primary;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: isEdit ? t("pipeline.editOpportunity") : t("pipeline.newOpportunity"),
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.foreground,
          headerTitleStyle: { fontFamily: FONT.semibold },
        }}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40, gap: 20 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Stage */}
          <View>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>{t("pipeline.stage").toUpperCase()}</Text>
            <Pressable
              onPress={() => setPicker("stage")}
              style={[styles.pickerBtn, { backgroundColor: colors.card, borderColor: stageColor }]}
            >
              <View style={[styles.stageDot, { backgroundColor: stageColor }]} />
              <Text style={[styles.pickerBtnText, { color: colors.foreground, flex: 1 }]}>
                {t(`leads.stages.${stage}`, { defaultValue: prettyLabel(stage) })}
              </Text>
              <Feather name="chevron-down" size={18} color={colors.mutedForeground} />
            </Pressable>
          </View>

          {/* Title */}
          <View>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>{t("pipeline.oppTitle").toUpperCase()}</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
              placeholder={t("pipeline.oppTitlePlaceholder")}
              placeholderTextColor={colors.mutedForeground}
              value={title}
              onChangeText={setTitle}
            />
          </View>

          {/* Company */}
          <View>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>{t("pipeline.company").toUpperCase()}</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
              placeholder={t("pipeline.companyPlaceholder")}
              placeholderTextColor={colors.mutedForeground}
              value={companyName}
              onChangeText={setCompanyName}
            />
          </View>

          {/* Value + Currency */}
          <View style={{ flexDirection: "row", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.label, { color: colors.mutedForeground }]}>{t("pipeline.value").toUpperCase()}</Text>
              <TextInput
                style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
                placeholder="0"
                placeholderTextColor={colors.mutedForeground}
                value={value}
                onChangeText={setValue}
                keyboardType="numeric"
              />
            </View>
            <View style={{ width: 90 }}>
              <Text style={[styles.label, { color: colors.mutedForeground }]}>{t("pipeline.currency").toUpperCase()}</Text>
              <Pressable
                onPress={() => setPicker("currency")}
                style={[styles.pickerBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <Text style={[styles.pickerBtnText, { color: colors.foreground }]}>{currency}</Text>
                <Feather name="chevron-down" size={16} color={colors.mutedForeground} />
              </Pressable>
            </View>
          </View>

          {/* Probability */}
          <View>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>{t("pipeline.probability").toUpperCase()}</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
              placeholder="0–100"
              placeholderTextColor={colors.mutedForeground}
              value={probability}
              onChangeText={v => {
                const n = parseInt(v);
                if (v === "" || (!isNaN(n) && n >= 0 && n <= 100)) setProbability(v);
              }}
              keyboardType="numeric"
            />
          </View>

          {/* Closing Date */}
          <View>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>{t("pipeline.closingDate").toUpperCase()}</Text>
            <DateTimeField
              label={t("pipeline.closingDate")}
              date={closingDate}
              onChange={(d) => setClosingDate(d)}
              withTime={false}
              optional
            />
          </View>

          {/* Priority */}
          <View>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>{t("pipeline.priority").toUpperCase()}</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {PRIORITIES.map(p => {
                const active = priority === p;
                const pColor = p === "high" ? "#EF4444" : p === "medium" ? "#F59E0B" : "#3B82F6";
                return (
                  <Pressable
                    key={p}
                    onPress={() => setPriority(active ? null : p)}
                    style={[
                      styles.priorityChip,
                      { borderColor: active ? pColor : colors.border, backgroundColor: active ? pColor + "1A" : colors.card },
                    ]}
                  >
                    <Text style={[styles.priorityChipText, { color: active ? pColor : colors.mutedForeground }]}>
                      {t(`pipeline.priority${p.charAt(0).toUpperCase() + p.slice(1)}`)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Contact */}
          <View>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>{t("pipeline.contact").toUpperCase()}</Text>
            <Pressable
              onPress={() => { if (!contactsQuery.isFetched) contactsQuery.refetch(); setPicker("contact"); }}
              style={[styles.pickerBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Feather name="user" size={16} color={colors.mutedForeground} />
              <Text style={[styles.pickerBtnText, { color: selectedContact ? colors.foreground : colors.mutedForeground, flex: 1 }]}>
                {selectedContact?.label ?? t("pipeline.noContact")}
              </Text>
              <Feather name="chevron-down" size={18} color={colors.mutedForeground} />
            </Pressable>
          </View>

          {/* Assigned To */}
          <View>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>{t("pipeline.assignedTo").toUpperCase()}</Text>
            <Pressable
              onPress={() => { if (!usersQuery.isFetched) usersQuery.refetch(); setPicker("user"); }}
              style={[styles.pickerBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Feather name="user-check" size={16} color={colors.mutedForeground} />
              <Text style={[styles.pickerBtnText, { color: selectedUser ? colors.foreground : colors.mutedForeground, flex: 1 }]}>
                {selectedUser?.label ?? t("pipeline.unassigned")}
              </Text>
              <Feather name="chevron-down" size={18} color={colors.mutedForeground} />
            </Pressable>
          </View>

          {/* Event */}
          <View>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>{t("pipeline.event").toUpperCase()}</Text>
            <Pressable
              onPress={() => { if (!eventsQuery.isFetched) eventsQuery.refetch(); setPicker("event"); }}
              style={[styles.pickerBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Feather name="calendar" size={16} color={colors.mutedForeground} />
              <Text style={[styles.pickerBtnText, { color: selectedEvent ? colors.foreground : colors.mutedForeground, flex: 1 }]}>
                {selectedEvent?.label ?? t("pipeline.noEvent")}
              </Text>
              <Feather name="chevron-down" size={18} color={colors.mutedForeground} />
            </Pressable>
          </View>

          {/* Notes */}
          <View>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>{t("pipeline.notes").toUpperCase()}</Text>
            <TextInput
              style={[styles.textArea, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
              placeholder={t("common.optional")}
              placeholderTextColor={colors.mutedForeground}
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </View>

          <PrimaryButton
            label={isSaving ? t("pipeline.savingLabel") : t("common.save")}
            onPress={handleSave}
            loading={isSaving}
            icon={isEdit ? "check" : "plus"}
          />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Stage picker */}
      <PickerModal
        visible={picker === "stage"}
        title={t("pipeline.selectStage")}
        items={stageItems}
        onSelect={v => { if (v != null) setStage(String(v)); }}
        onClose={() => setPicker(null)}
      />
      {/* Currency picker */}
      <PickerModal
        visible={picker === "currency"}
        title={t("pipeline.currency")}
        items={currencyItems}
        onSelect={v => { if (v != null) setCurrency(String(v)); }}
        onClose={() => setPicker(null)}
        searchPlaceholder="USD, EUR…"
      />
      {/* Contact picker */}
      <PickerModal
        visible={picker === "contact"}
        title={t("pipeline.selectContact")}
        items={contactItems}
        onSelect={v => {
          const id = v != null ? Number(v) : null;
          setContactId(id);
          if (id != null) {
            const item = contactItems.find(c => c.id === id);
            if (item?.sub && !companyName.trim()) setCompanyName(item.sub);
          }
        }}
        onClose={() => setPicker(null)}
        searchPlaceholder={t("pipeline.searchContact")}
      />
      {/* User picker */}
      <PickerModal
        visible={picker === "user"}
        title={t("pipeline.selectUser")}
        items={userItems}
        onSelect={v => setAssignedToId(v != null ? Number(v) : null)}
        onClose={() => setPicker(null)}
        searchPlaceholder={t("pipeline.searchUser")}
      />
      {/* Event picker */}
      <PickerModal
        visible={picker === "event"}
        title={t("pipeline.selectEvent")}
        items={eventItems}
        onSelect={v => setEventId(v != null ? Number(v) : null)}
        onClose={() => setPicker(null)}
        searchPlaceholder={t("pipeline.searchEvent")}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 11,
    fontFamily: FONT.semibold,
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  input: {
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: FONT.regular,
  },
  textArea: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 14,
    fontSize: 15,
    fontFamily: FONT.regular,
    minHeight: 100,
  },
  pickerBtn: {
    height: 48,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  pickerBtnText: {
    fontSize: 15,
    fontFamily: FONT.regular,
  },
  stageDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  priorityChip: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  priorityChipText: {
    fontSize: 13,
    fontFamily: FONT.semibold,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 18,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 17,
    fontFamily: FONT.semibold,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    margin: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
    height: 42,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: FONT.regular,
  },
  pickerItem: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pickerItemText: {
    fontSize: 15,
    fontFamily: FONT.regular,
  },
  pickerItemSub: {
    fontSize: 13,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
});
