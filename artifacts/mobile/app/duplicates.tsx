import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { Stack, useRouter } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type Contact,
  type DuplicateGroup,
  useDeleteContact,
  useGetContactDuplicates,
  useMergeContacts,
} from "@workspace/api-client-react";

import {
  Avatar,
  EmptyState,
  ErrorState,
  FONT,
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

// ── Linked duplicate card ─────────────────────────────────────────────────────
// Used for matchType === "linked" — contacts auto-detected at scan time.
// Shows the original contact prominently; each duplicate has an individual
// "Delete" button that removes only that duplicate record.
function LinkedDuplicateCard({
  group,
  onDeleted,
}: {
  group: DuplicateGroup;
  onDeleted: () => void;
}) {
  const colors = useColors();
  const { t, isRTL, textAlign } = useLocale();
  const del = useDeleteContact();

  const [original, ...duplicates] = group.contacts;

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
        <View style={[styles.matchPill, { backgroundColor: colors.primary + "18", flexDirection: isRTL ? "row-reverse" : "row" }]}>
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
            {[original.contactCompany, original.email].filter(Boolean).join(" · ") || t("duplicates.originalRecord")}
          </Text>
        </View>
        <View style={[styles.badge, { backgroundColor: colors.primary + "18" }]}>
          <Text style={[styles.badgeText, { color: colors.primary }]}>{t("duplicates.originalBadge")}</Text>
        </View>
      </View>

      {/* Duplicates */}
      <View style={{ gap: 8, marginTop: 8 }}>
        {duplicates.map((dup) => (
          <View
            key={dup.id}
            style={[
              styles.option,
              { borderColor: colors.border, borderRadius: colors.radius + 2, flexDirection: isRTL ? "row-reverse" : "row" },
            ]}
          >
            <Avatar name={contactName(dup, t("common.unnamedContact"))} size={40} color={colors.mutedForeground} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={[styles.optName, { color: colors.foreground, textAlign }]}>
                {contactName(dup, t("common.unnamedContact"))}
              </Text>
              <Text numberOfLines={1} style={[styles.optSub, { color: colors.mutedForeground, textAlign }]}>
                {[dup.contactCompany, dup.email].filter(Boolean).join(" · ") || t("duplicates.rescannedDuplicate")}
              </Text>
            </View>
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
        ))}
      </View>
    </View>
  );
}

// ── Similarity-matched duplicate card ────────────────────────────────────────
// Used for matchType "email" | "phone" | "name" — legacy / unlinked detection.
// Allows the user to pick a primary and merge the rest into it.
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
        <View style={[styles.matchPill, { backgroundColor: colors.accent, flexDirection: isRTL ? "row-reverse" : "row" }]}>
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
              <Avatar name={contactName(c, t("common.unnamedContact"))} size={40} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={[styles.optName, { color: colors.foreground, textAlign }]}>
                  {contactName(c, t("common.unnamedContact"))}
                </Text>
                <Text numberOfLines={1} style={[styles.optSub, { color: colors.mutedForeground, textAlign }]}>
                  {[c.contactCompany, c.email].filter(Boolean).join(" · ") || t("duplicates.fieldsCount", { count: fieldCount(c) })}
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

export default function DuplicatesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL, textAlign } = useLocale();
  const query = useGetContactDuplicates();

  const groups = query.data?.groups ?? [];
  const linkedCount = groups.filter((g) => g.matchType === "linked").length;
  const suggestedCount = groups.filter((g) => g.matchType !== "linked").length;

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
          title: t("duplicates.title"),
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
        }}
      />

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
          <View style={{ gap: 16 }}>
            {groups.map((group, idx) =>
              group.matchType === "linked" ? (
                <LinkedDuplicateCard
                  key={`linked-${group.matchValue}-${idx}`}
                  group={group}
                  onDeleted={() => query.refetch()}
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

const styles = StyleSheet.create({
  intro: {
    fontSize: 14,
    fontFamily: FONT.regular,
    marginBottom: 16,
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
});
