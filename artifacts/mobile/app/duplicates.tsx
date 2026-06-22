import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { Stack, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  Alert,
  BackHandler,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type Contact,
  type DuplicateGroup,
  useDeleteContact,
  useGetContactDuplicates,
  useMakeContactOriginal,
  useMergeContacts,
} from "@workspace/api-client-react";

import {
  Avatar,
  CONTACT_STATUS_COLORS,
  EmptyState,
  ErrorState,
  FONT,
  LEAD_TEMPERATURE_COLORS,
  LoadingState,
  PrimaryButton,
  prettyLabel,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";

function contactName(c: Contact, fallback: string): string {
  if (c.fullName) return c.fullName;
  const parts = [c.firstName, c.lastName].filter(Boolean);
  return parts.length ? parts.join(" ") : fallback;
}

function matchLabel(group: DuplicateGroup): string {
  const type = prettyLabel(group.matchType);
  return `${type}: ${group.matchValue}`;
}

function fieldCount(c: Contact): number {
  const fields = [
    c.firstName,
    c.lastName,
    c.jobTitle,
    c.contactCompany,
    c.email,
    c.mobile,
    c.officePhone,
    c.website,
    c.linkedin,
    c.country,
    c.address,
    c.notes,
  ];
  return fields.filter(Boolean).length;
}

// ── Contact Preview Sheet ─────────────────────────────────────────────────────
function ContactPreviewSheet({
  contact,
  isLinkedDuplicate,
  groupOriginalId,
  visible,
  onClose,
  onMadeOriginal,
}: {
  contact: Contact | null;
  isLinkedDuplicate: boolean;
  groupOriginalId: number | null;
  visible: boolean;
  onClose: () => void;
  onMadeOriginal: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t, isRTL, textAlign } = useLocale();
  const makeOriginal = useMakeContactOriginal();

  if (!contact) return null;

  function row(label: string, value: string | null | undefined) {
    if (!value) return null;
    return (
      <View
        key={label}
        style={[
          previewStyles.fieldRow,
          { flexDirection: isRTL ? "row-reverse" : "row", borderBottomColor: colors.border },
        ]}
      >
        <Text style={[previewStyles.fieldLabel, { color: colors.mutedForeground, textAlign }]}>
          {label}
        </Text>
        <Text
          style={[previewStyles.fieldValue, { color: colors.foreground, textAlign }]}
          selectable
        >
          {value}
        </Text>
      </View>
    );
  }

  function handleMakeOriginal() {
    if (!groupOriginalId || !contact) return;
    const run = async () => {
      try {
        await makeOriginal.mutateAsync({
          data: { duplicateId: contact.id, groupOriginalId },
        });
        if (Platform.OS !== "web")
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onClose();
        onMadeOriginal();
      } catch {
        Alert.alert(t("duplicates.makeOriginalError"));
      }
    };
    if (Platform.OS === "web") {
      void run();
      return;
    }
    Alert.alert(
      t("duplicates.makeOriginalConfirmTitle"),
      t("duplicates.makeOriginalConfirmBody"),
      [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("duplicates.makeOriginal"), style: "default", onPress: run },
      ],
    );
  }

  const name = contactName(contact, t("common.unnamedContact"));
  const temp = contact.leadTemperature;
  const tempColor = temp ? (LEAD_TEMPERATURE_COLORS[temp] ?? colors.mutedForeground) : null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={previewStyles.overlay}>
        <Pressable style={previewStyles.backdrop} onPress={onClose} />
        <View
          style={[
            previewStyles.sheet,
            {
              backgroundColor: colors.card,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              paddingBottom: insets.bottom + 16,
            },
          ]}
        >
          {/* Handle bar */}
          <View style={[previewStyles.handle, { backgroundColor: colors.border }]} />

          {/* Header */}
          <View
            style={[
              previewStyles.sheetHeader,
              { borderBottomColor: colors.border, flexDirection: isRTL ? "row-reverse" : "row" },
            ]}
          >
            <View style={{ flex: 1, flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", gap: 12 }}>
              <Avatar name={name} size={44} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text
                  numberOfLines={1}
                  style={[previewStyles.sheetTitle, { color: colors.foreground, textAlign }]}
                >
                  {name}
                </Text>
                {(contact.jobTitle || contact.contactCompany) ? (
                  <Text
                    numberOfLines={1}
                    style={[previewStyles.sheetSub, { color: colors.mutedForeground, textAlign }]}
                  >
                    {[contact.jobTitle, contact.contactCompany].filter(Boolean).join(" · ")}
                  </Text>
                ) : null}
              </View>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10} style={{ padding: 4 }}>
              <Feather name="x" size={22} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 8 }}
          >
            {/* Lead score + temperature */}
            {(contact.leadScore != null || temp) ? (
              <View
                style={[
                  previewStyles.scoreRow,
                  { flexDirection: isRTL ? "row-reverse" : "row", borderBottomColor: colors.border },
                ]}
              >
                {contact.leadScore != null && (
                  <View style={[previewStyles.scoreBadge, { backgroundColor: colors.primary + "18" }]}>
                    <Text style={[previewStyles.scoreBadgeText, { color: colors.primary }]}>
                      {t("leads.score")}: {contact.leadScore}
                    </Text>
                  </View>
                )}
                {temp && tempColor && (
                  <View style={[previewStyles.scoreBadge, { backgroundColor: tempColor + "18" }]}>
                    <Text style={[previewStyles.scoreBadgeText, { color: tempColor }]}>
                      {prettyLabel(temp)}
                    </Text>
                  </View>
                )}
                {contact.status && (
                  <View
                    style={[
                      previewStyles.scoreBadge,
                      { backgroundColor: (CONTACT_STATUS_COLORS[contact.status] ?? colors.mutedForeground) + "18" },
                    ]}
                  >
                    <Text
                      style={[
                        previewStyles.scoreBadgeText,
                        { color: CONTACT_STATUS_COLORS[contact.status] ?? colors.mutedForeground },
                      ]}
                    >
                      {prettyLabel(contact.status)}
                    </Text>
                  </View>
                )}
              </View>
            ) : null}

            {/* Fields */}
            {row(t("contacts.fields.firstName"), contact.firstName)}
            {row(t("contacts.fields.lastName"), contact.lastName)}
            {row(t("contacts.fields.arabicName"), contact.arabicName)}
            {row(t("contacts.fields.jobTitle"), contact.jobTitle)}
            {row(t("contacts.fields.company"), contact.contactCompany)}
            {row(t("contacts.fields.email"), contact.email)}
            {row(t("contacts.fields.mobile"), contact.mobile)}
            {row(t("contacts.fields.phone"), contact.officePhone)}
            {row(t("contacts.fields.website"), contact.website)}
            {row(t("contacts.fields.linkedin"), contact.linkedin)}
            {row(t("contacts.fields.address"), contact.address)}
            {row(t("contacts.fields.country"), contact.country)}
            {row(t("contacts.fields.event"), contact.eventName)}
            {row(
              t("duplicates.captureDate"),
              contact.createdAt
                ? new Date(contact.createdAt).toLocaleDateString()
                : null,
            )}
            {row(t("contacts.fields.notes"), contact.notes)}

            {/* AI reasoning */}
            {contact.aiReasoning ? (
              <View style={[previewStyles.fieldRow, { flexDirection: "column", borderBottomColor: colors.border }]}>
                <Text style={[previewStyles.fieldLabel, { color: colors.mutedForeground, marginBottom: 4 }]}>
                  {t("leads.reasoning")}
                </Text>
                <Text style={[previewStyles.fieldValue, { color: colors.mutedForeground }]} selectable>
                  {contact.aiReasoning}
                </Text>
              </View>
            ) : null}

            {/* Make Original button — only for linked duplicates */}
            {isLinkedDuplicate && groupOriginalId != null && (
              <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
                <Pressable
                  onPress={handleMakeOriginal}
                  disabled={makeOriginal.isPending}
                  style={({ pressed }) => [
                    previewStyles.makeOriginalBtn,
                    {
                      backgroundColor: colors.primary,
                      borderRadius: colors.radius + 2,
                      opacity: pressed || makeOriginal.isPending ? 0.7 : 1,
                    },
                  ]}
                >
                  <Feather name="star" size={15} color="#fff" />
                  <Text style={previewStyles.makeOriginalBtnText}>
                    {makeOriginal.isPending ? t("common.saving") : t("duplicates.makeOriginal")}
                  </Text>
                </Pressable>
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ── Linked duplicate card ─────────────────────────────────────────────────────
function LinkedDuplicateCard({
  group,
  selectionMode,
  selectedIds,
  onLongPressAvatar,
  onToggleSelect,
  onDeleted,
  onRefresh,
}: {
  group: DuplicateGroup;
  selectionMode: boolean;
  selectedIds: Set<number>;
  onLongPressAvatar: (id: number) => void;
  onToggleSelect: (id: number) => void;
  onDeleted: () => void;
  onRefresh: () => void;
}) {
  const colors = useColors();
  const { t, isRTL, textAlign } = useLocale();
  const del = useDeleteContact();

  const [previewContact, setPreviewContact] = useState<Contact | null>(null);
  const [previewIsLinkedDup, setPreviewIsLinkedDup] = useState(false);
  const [previewGroupOriginalId, setPreviewGroupOriginalId] = useState<number | null>(null);

  const [original, ...duplicates] = group.contacts;

  function openPreview(contact: Contact, isLinkedDup: boolean, origId: number | null) {
    setPreviewContact(contact);
    setPreviewIsLinkedDup(isLinkedDup);
    setPreviewGroupOriginalId(origId);
  }

  function handleDelete(dup: Contact) {
    const run = async () => {
      try {
        await del.mutateAsync({ id: dup.id });
        if (Platform.OS !== "web")
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onDeleted();
      } catch {
        Alert.alert(t("errors.generic"));
      }
    };

    if (Platform.OS === "web") {
      void run();
      return;
    }
    Alert.alert(
      t("common.delete"),
      t("contacts.deleteConfirm"),
      [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("common.delete"), style: "destructive", onPress: run },
      ],
    );
  }

  if (!original) return null;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
      ]}
    >
      <View style={[styles.cardHeader, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
        <View
          style={[styles.matchPill, { backgroundColor: colors.primary + "18", flexDirection: isRTL ? "row-reverse" : "row" }]}
        >
          <Feather name="link-2" size={13} color={colors.primary} />
          <Text style={[styles.matchText, { color: colors.primary }]} numberOfLines={1}>
            {t("duplicates.rescanDetected", { count: duplicates.length })}
          </Text>
        </View>
      </View>

      <Text style={[styles.hint, { color: colors.mutedForeground, textAlign }]}>
        {t("duplicates.originalKeptHint")}
      </Text>

      {/* Original */}
      <View
        style={[
          styles.originalRow,
          {
            borderColor: colors.primary + "40",
            backgroundColor: colors.accent,
            borderRadius: colors.radius + 2,
            flexDirection: isRTL ? "row-reverse" : "row",
          },
        ]}
      >
        <Avatar name={contactName(original, t("common.unnamedContact"))} size={40} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={[styles.optName, { color: colors.foreground, textAlign }]}>
            {contactName(original, t("common.unnamedContact"))}
          </Text>
          <Text numberOfLines={1} style={[styles.optSub, { color: colors.mutedForeground, textAlign }]}>
            {[original.contactCompany, original.email].filter(Boolean).join(" · ") ||
              t("duplicates.originalRecord")}
          </Text>
        </View>
        <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", gap: 6 }}>
          <View style={[styles.badge, { backgroundColor: colors.primary + "18" }]}>
            <Text style={[styles.badgeText, { color: colors.primary }]}>
              {t("duplicates.originalBadge")}
            </Text>
          </View>
          <Pressable
            onPress={() => openPreview(original, false, null)}
            style={({ pressed }) => [
              styles.previewBtn,
              { backgroundColor: colors.accent, borderRadius: colors.radius, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <Feather name="eye" size={15} color={colors.primary} />
          </Pressable>
        </View>
      </View>

      {/* Duplicates */}
      <View style={{ gap: 8, marginTop: 8 }}>
        {duplicates.map((dup) => {
          const isSelected = selectedIds.has(dup.id);
          return (
            <Pressable
              key={dup.id}
              onPress={() => {
                if (selectionMode) onToggleSelect(dup.id);
              }}
              style={[
                styles.option,
                {
                  borderColor: isSelected ? colors.primary : colors.border,
                  backgroundColor: isSelected ? colors.primary + "12" : "transparent",
                  borderRadius: colors.radius + 2,
                  flexDirection: isRTL ? "row-reverse" : "row",
                },
              ]}
            >
              {/* Avatar with long-press and checkmark overlay */}
              <Pressable
                onLongPress={() => onLongPressAvatar(dup.id)}
                delayLongPress={400}
                style={{ position: "relative" }}
              >
                <Avatar
                  name={contactName(dup, t("common.unnamedContact"))}
                  size={40}
                  color={isSelected ? colors.primary : colors.mutedForeground}
                />
                {isSelected && (
                  <View
                    style={[
                      styles.checkOverlay,
                      { backgroundColor: colors.primary, borderColor: colors.card },
                    ]}
                  >
                    <Feather name="check" size={11} color="#fff" />
                  </View>
                )}
              </Pressable>

              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={[styles.optName, { color: colors.foreground, textAlign }]}>
                  {contactName(dup, t("common.unnamedContact"))}
                </Text>
                <Text numberOfLines={1} style={[styles.optSub, { color: colors.mutedForeground, textAlign }]}>
                  {[dup.contactCompany, dup.email].filter(Boolean).join(" · ") ||
                    t("duplicates.rescannedDuplicate")}
                </Text>
              </View>

              {/* Action buttons (hidden in selection mode) */}
              {!selectionMode && (
                <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", gap: 6 }}>
                  <Pressable
                    onPress={() => openPreview(dup, true, original.id)}
                    style={({ pressed }) => [
                      styles.previewBtn,
                      {
                        backgroundColor: colors.accent,
                        borderRadius: colors.radius,
                        opacity: pressed ? 0.6 : 1,
                      },
                    ]}
                  >
                    <Feather name="eye" size={15} color={colors.primary} />
                  </Pressable>
                  <Pressable
                    onPress={() => handleDelete(dup)}
                    disabled={del.isPending}
                    style={({ pressed }) => [
                      styles.deleteBtn,
                      {
                        backgroundColor: colors.destructive + "14",
                        borderRadius: colors.radius,
                        opacity: pressed || del.isPending ? 0.6 : 1,
                      },
                    ]}
                  >
                    <Feather name="trash-2" size={15} color={colors.destructive} />
                  </Pressable>
                </View>
              )}

              {/* Checkmark indicator in selection mode (when not selected) */}
              {selectionMode && !isSelected && (
                <View
                  style={[
                    styles.checkCircle,
                    { borderColor: colors.border },
                  ]}
                />
              )}
            </Pressable>
          );
        })}
      </View>

      {/* Preview sheet */}
      <ContactPreviewSheet
        contact={previewContact}
        isLinkedDuplicate={previewIsLinkedDup}
        groupOriginalId={previewGroupOriginalId}
        visible={previewContact != null}
        onClose={() => setPreviewContact(null)}
        onMadeOriginal={onRefresh}
      />
    </View>
  );
}

// ── Similarity-matched duplicate card ────────────────────────────────────────
function DuplicateCard({
  group,
  onMerged,
}: {
  group: DuplicateGroup;
  onMerged: () => void;
}) {
  const colors = useColors();
  const { t, isRTL, textAlign } = useLocale();
  const merge = useMergeContacts();

  const sorted = [...group.contacts].sort((a, b) => fieldCount(b) - fieldCount(a));
  const [primaryId, setPrimaryId] = useState<number>(sorted[0]?.id);

  async function handleMerge() {
    const duplicateIds = group.contacts
      .map((c) => c.id)
      .filter((id) => id !== primaryId);
    if (duplicateIds.length === 0) return;

    const run = async () => {
      try {
        await merge.mutateAsync({ data: { primaryId, duplicateIds } });
        if (Platform.OS !== "web")
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onMerged();
      } catch {
        Alert.alert(t("errors.generic"));
      }
    };

    if (Platform.OS === "web") {
      void run();
      return;
    }
    Alert.alert(
      t("duplicates.merge"),
      t("duplicates.mergeConfirm"),
      [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("duplicates.merge"), style: "destructive", onPress: run },
      ],
    );
  }

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 },
      ]}
    >
      <View style={[styles.cardHeader, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
        <View
          style={[styles.matchPill, { backgroundColor: colors.accent, flexDirection: isRTL ? "row-reverse" : "row" }]}
        >
          <Feather name="copy" size={13} color={colors.primary} />
          <Text style={[styles.matchText, { color: colors.primary }]} numberOfLines={1}>
            {matchLabel(group)}
          </Text>
        </View>
      </View>

      <Text style={[styles.hint, { color: colors.mutedForeground, textAlign }]}>
        {t("duplicates.pickKeepHint")}
      </Text>

      <View style={{ gap: 8, marginTop: 4 }}>
        {sorted.map((c) => {
          const selected = c.id === primaryId;
          return (
            <Pressable
              key={c.id}
              onPress={() => setPrimaryId(c.id)}
              style={[
                styles.option,
                {
                  borderColor: selected ? colors.primary : colors.border,
                  backgroundColor: selected ? colors.accent : "transparent",
                  borderRadius: colors.radius + 2,
                  flexDirection: isRTL ? "row-reverse" : "row",
                },
              ]}
            >
              <Avatar
                name={contactName(c, t("common.unnamedContact"))}
                size={40}
                color={colors.primary}
              />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={[styles.optName, { color: colors.foreground, textAlign }]}>
                  {contactName(c, t("common.unnamedContact"))}
                </Text>
                <Text numberOfLines={1} style={[styles.optSub, { color: colors.mutedForeground, textAlign }]}>
                  {[c.contactCompany, c.email].filter(Boolean).join(" · ") ||
                    t("duplicates.fieldsCount", { count: fieldCount(c) })}
                </Text>
              </View>
              <View
                style={[
                  styles.radio,
                  { borderColor: selected ? colors.primary : colors.border },
                ]}
              >
                {selected ? (
                  <View style={[styles.radioDot, { backgroundColor: colors.primary }]} />
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>

      <PrimaryButton
        label={t("duplicates.merge")}
        icon="git-merge"
        loading={merge.isPending}
        onPress={handleMerge}
        style={{ marginTop: 14 }}
      />
    </View>
  );
}

// ── Selection toolbar ─────────────────────────────────────────────────────────
function SelectionToolbar({
  selectedCount,
  totalCount,
  onSelectAll,
  onDeleteSelected,
  onCancel,
}: {
  selectedCount: number;
  totalCount: number;
  onSelectAll: () => void;
  onDeleteSelected: () => void;
  onCancel: () => void;
}) {
  const colors = useColors();
  const { t, isRTL } = useLocale();
  const allSelected = selectedCount >= totalCount;

  return (
    <View
      style={[
        toolbarStyles.container,
        {
          backgroundColor: colors.card,
          borderBottomColor: colors.border,
          flexDirection: isRTL ? "row-reverse" : "row",
        },
      ]}
    >
      <TouchableOpacity onPress={onCancel} style={toolbarStyles.btn} hitSlop={8}>
        <Feather name="x" size={18} color={colors.foreground} />
      </TouchableOpacity>

      <Text style={[toolbarStyles.count, { color: colors.foreground, flex: 1 }]}>
        {t("duplicates.selectedCount", { count: selectedCount })}
      </Text>

      <TouchableOpacity onPress={onSelectAll} style={toolbarStyles.btn} hitSlop={8}>
        <Text style={[toolbarStyles.actionText, { color: colors.primary }]}>
          {allSelected ? t("common.none") : t("duplicates.selectAll")}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={onDeleteSelected}
        disabled={selectedCount === 0}
        style={[toolbarStyles.btn, { opacity: selectedCount === 0 ? 0.4 : 1 }]}
        hitSlop={8}
      >
        <Feather name="trash-2" size={18} color={colors.destructive} />
      </TouchableOpacity>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────
export default function DuplicatesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL, textAlign } = useLocale();
  const query = useGetContactDuplicates();
  const del = useDeleteContact();

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const groups = query.data?.groups ?? [];
  const linkedGroups = groups.filter((g) => g.matchType === "linked");
  const linkedCount = linkedGroups.length;
  const suggestedCount = groups.filter((g) => g.matchType !== "linked").length;

  // All duplicate contacts (not originals) from linked groups
  const allDuplicateContacts: Contact[] = linkedGroups.flatMap((g) => {
    const [, ...dups] = g.contacts;
    return dups;
  });
  const totalDupCount = allDuplicateContacts.length;

  // Back-gesture exits selection mode
  React.useEffect(() => {
    if (Platform.OS === "android" && selectionMode) {
      const handler = BackHandler.addEventListener("hardwareBackPress", () => {
        setSelectionMode(false);
        setSelectedIds(new Set());
        return true;
      });
      return () => handler.remove();
    }
  }, [selectionMode]);

  const enterSelectionMode = useCallback((id: number) => {
    if (Platform.OS !== "web")
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectionMode(true);
    setSelectedIds(new Set([id]));
  }, []);

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    const allIds = allDuplicateContacts.map((c) => c.id);
    setSelectedIds((prev) =>
      prev.size >= allIds.length ? new Set() : new Set(allIds),
    );
  }, [allDuplicateContacts]);

  const cancelSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  function handleDeleteSelected() {
    const count = selectedIds.size;
    if (count === 0) return;

    const run = async () => {
      let hadError = false;
      for (const id of selectedIds) {
        try {
          await del.mutateAsync({ id });
        } catch {
          hadError = true;
        }
      }
      if (Platform.OS !== "web")
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      cancelSelection();
      void query.refetch();
      if (hadError) Alert.alert(t("duplicates.deleteSelectedError"));
    };

    if (Platform.OS === "web") {
      void run();
      return;
    }
    Alert.alert(
      t("duplicates.deleteSelectedConfirmTitle"),
      t("duplicates.deleteSelectedConfirmBody", { count }),
      [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("common.delete"), style: "destructive", onPress: run },
      ],
    );
  }

  const summaryText =
    linkedCount > 0 && suggestedCount > 0
      ? `${t("duplicates.rescanCount", { count: linkedCount })} · ${t("duplicates.suggestedGroup", { count: suggestedCount })}`
      : linkedCount > 0
        ? t("duplicates.rescanDuplicateDetected", { count: linkedCount })
        : t("duplicates.potentialGroupDetected", { count: suggestedCount });

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: selectionMode ? "" : t("duplicates.title"),
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.foreground,
          headerTitleStyle: { fontFamily: FONT.semibold },
          headerLeft:
            Platform.OS === "web"
              ? () => (
                  <Pressable onPress={() => router.back()} hitSlop={10}>
                    <Feather name="arrow-left" size={22} color={colors.foreground} />
                  </Pressable>
                )
              : undefined,
          headerShown: !selectionMode,
        }}
      />

      {/* Selection toolbar replaces header when in selection mode */}
      {selectionMode && (
        <View style={{ paddingTop: insets.top }}>
          <SelectionToolbar
            selectedCount={selectedIds.size}
            totalCount={totalDupCount}
            onSelectAll={selectAll}
            onDeleteSelected={handleDeleteSelected}
            onCancel={cancelSelection}
          />
        </View>
      )}

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : groups.length === 0 ? (
        <View style={{ flex: 1 }}>
          <EmptyState
            icon="check-circle"
            title={t("duplicates.empty")}
            subtitle={t("duplicates.emptyDesc")}
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{
            padding: 20,
            paddingBottom: insets.bottom + 40,
            flexGrow: 1,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => query.refetch()}
              tintColor={colors.primary}
            />
          }
        >
          <Text style={[styles.intro, { color: colors.mutedForeground, textAlign }]}>
            {summaryText}.
          </Text>

          {/* Long-press hint when duplicates exist */}
          {linkedCount > 0 && !selectionMode && (
            <Text
              style={[
                styles.hint2,
                { color: colors.mutedForeground + "99", textAlign },
              ]}
            >
              {t("duplicates.longPressHint")}
            </Text>
          )}

          <View style={{ gap: 16 }}>
            {groups.map((group, idx) =>
              group.matchType === "linked" ? (
                <LinkedDuplicateCard
                  key={`linked-${group.matchValue}-${idx}`}
                  group={group}
                  selectionMode={selectionMode}
                  selectedIds={selectedIds}
                  onLongPressAvatar={enterSelectionMode}
                  onToggleSelect={toggleSelect}
                  onDeleted={() => query.refetch()}
                  onRefresh={() => query.refetch()}
                />
              ) : (
                <DuplicateCard
                  key={`${group.matchType}-${group.matchValue}-${idx}`}
                  group={group}
                  onMerged={() => query.refetch()}
                />
              ),
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  intro: {
    fontSize: 14,
    fontFamily: FONT.regular,
    marginBottom: 8,
  },
  hint2: {
    fontSize: 12,
    fontFamily: FONT.regular,
    marginBottom: 14,
    fontStyle: "italic",
  },
  card: {
    borderWidth: 1,
    padding: 16,
  },
  cardHeader: {
    flexDirection: "row",
    marginBottom: 10,
  },
  matchPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    maxWidth: "100%",
  },
  matchText: {
    fontSize: 12.5,
    fontFamily: FONT.semibold,
    flexShrink: 1,
  },
  hint: {
    fontSize: 13,
    fontFamily: FONT.regular,
    marginBottom: 12,
  },
  originalRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1.5,
    padding: 10,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  badgeText: {
    fontSize: 10,
    fontFamily: FONT.semibold,
    letterSpacing: 0.5,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1.5,
    padding: 10,
  },
  optName: {
    fontSize: 15,
    fontFamily: FONT.semibold,
  },
  optSub: {
    fontSize: 12.5,
    fontFamily: FONT.regular,
    marginTop: 1,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: {
    width: 11,
    height: 11,
    borderRadius: 6,
  },
  deleteBtn: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  previewBtn: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOverlay: {
    position: "absolute",
    bottom: -2,
    right: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  checkCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
  },
});

const previewStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  sheet: {
    maxHeight: "85%",
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginTop: 10,
    marginBottom: 4,
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  sheetTitle: {
    fontSize: 16,
    fontFamily: FONT.semibold,
  },
  sheetSub: {
    fontSize: 13,
    fontFamily: FONT.regular,
    marginTop: 1,
  },
  scoreRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  scoreBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  scoreBadgeText: {
    fontSize: 12,
    fontFamily: FONT.semibold,
  },
  fieldRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
    alignItems: "flex-start",
  },
  fieldLabel: {
    fontSize: 12,
    fontFamily: FONT.medium,
    width: 110,
    flexShrink: 0,
    paddingTop: 1,
  },
  fieldValue: {
    fontSize: 14,
    fontFamily: FONT.regular,
    flex: 1,
  },
  makeOriginalBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
  },
  makeOriginalBtnText: {
    fontSize: 15,
    fontFamily: FONT.semibold,
    color: "#fff",
  },
});

const toolbarStyles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  btn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  count: {
    fontSize: 15,
    fontFamily: FONT.semibold,
    paddingHorizontal: 4,
  },
  actionText: {
    fontSize: 14,
    fontFamily: FONT.semibold,
  },
});
