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

function contactName(c: Contact): string {
  if (c.fullName) return c.fullName;
  const parts = [c.firstName, c.lastName].filter(Boolean);
  return parts.length ? parts.join(" ") : "Unnamed contact";
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

function DuplicateCard({
  group,
  onMerged,
}: {
  group: DuplicateGroup;
  onMerged: () => void;
}) {
  const colors = useColors();
  const merge = useMergeContacts();

  // Default the most-complete contact as the primary to keep.
  const sorted = [...group.contacts].sort((a, b) => fieldCount(b) - fieldCount(a));
  const [primaryId, setPrimaryId] = useState<number>(sorted[0]?.id);

  async function handleMerge() {
    const duplicateIds = group.contacts
      .map((c) => c.id)
      .filter((id) => id !== primaryId);
    if (duplicateIds.length === 0) return;

    const run = async () => {
      try {
        if (Platform.OS !== "web") Haptics.selectionAsync();
        await merge.mutateAsync({ data: { primaryId, duplicateIds } });
        if (Platform.OS !== "web")
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onMerged();
      } catch {
        Alert.alert("Merge failed", "Please try again.");
      }
    };

    if (Platform.OS === "web") {
      void run();
      return;
    }
    Alert.alert(
      "Merge contacts",
      `Keep the selected contact and merge ${duplicateIds.length} duplicate${
        duplicateIds.length > 1 ? "s" : ""
      } into it? This can't be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Merge", style: "destructive", onPress: run },
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
      <View style={styles.cardHeader}>
        <View style={[styles.matchPill, { backgroundColor: colors.accent }]}>
          <Feather name="copy" size={13} color={colors.primary} />
          <Text style={[styles.matchText, { color: colors.primary }]} numberOfLines={1}>
            {matchLabel(group)}
          </Text>
        </View>
      </View>

      <Text style={[styles.hint, { color: colors.mutedForeground }]}>
        Pick the contact to keep — the rest merge into it.
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
                },
              ]}
            >
              <Avatar name={contactName(c)} size={40} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={[styles.optName, { color: colors.foreground }]}>
                  {contactName(c)}
                </Text>
                <Text numberOfLines={1} style={[styles.optSub, { color: colors.mutedForeground }]}>
                  {[c.contactCompany, c.email].filter(Boolean).join(" · ") || `${fieldCount(c)} fields`}
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
        label={`Merge ${group.contacts.length} into 1`}
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
  const query = useGetContactDuplicates();

  const groups = query.data?.groups ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: "Duplicates",
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
            title="No duplicates found"
            subtitle="Your contact list is clean. We'll flag potential duplicates here as they appear."
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{
            padding: 20,
            paddingBottom: insets.bottom + 40,
          }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => query.refetch()}
              tintColor={colors.primary}
            />
          }
        >
          <Text style={[styles.intro, { color: colors.mutedForeground }]}>
            {groups.length} potential duplicate group{groups.length > 1 ? "s" : ""} detected.
          </Text>
          <View style={{ gap: 16 }}>
            {groups.map((group, idx) => (
              <DuplicateCard
                key={`${group.matchType}-${group.matchValue}-${idx}`}
                group={group}
                onMerged={() => query.refetch()}
              />
            ))}
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
});
