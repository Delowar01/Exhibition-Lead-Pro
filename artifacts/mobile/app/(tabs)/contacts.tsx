import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  type Contact,
  useListContacts,
} from "@workspace/api-client-react";

import {
  Avatar,
  Badge,
  CONTACT_STATUS_COLORS,
  EmptyState,
  ErrorState,
  FONT,
  LoadingState,
  prettyLabel,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";

function contactName(c: Contact): string {
  if (c.fullName) return c.fullName;
  const parts = [c.firstName, c.lastName].filter(Boolean);
  return parts.length ? parts.join(" ") : "Unnamed contact";
}

export default function ContactsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [search, setSearch] = useState("");

  const query = useListContacts({ limit: 100 });
  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  const contacts = query.data?.contacts ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => {
      const hay = [
        contactName(c),
        c.contactCompany,
        c.email,
        c.jobTitle,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [contacts, search]);

  function renderItem({ item }: { item: Contact }) {
    const statusColor = CONTACT_STATUS_COLORS[item.status] ?? colors.mutedForeground;
    return (
      <Pressable
        onPress={() => router.push(`/contact/${item.id}`)}
        style={({ pressed }) => [
          styles.row,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            borderRadius: colors.radius + 4,
            opacity: pressed ? 0.7 : 1,
          },
        ]}
      >
        <Avatar name={contactName(item)} color={statusColor} />
        <View style={{ flex: 1 }}>
          <Text
            numberOfLines={1}
            style={[styles.name, { color: colors.foreground }]}
          >
            {contactName(item)}
          </Text>
          <Text
            numberOfLines={1}
            style={[styles.sub, { color: colors.mutedForeground }]}
          >
            {[item.jobTitle, item.contactCompany].filter(Boolean).join(" · ") ||
              item.email ||
              "No details"}
          </Text>
          <View style={{ marginTop: 6 }}>
            <Badge label={prettyLabel(item.status)} color={statusColor} />
          </View>
        </View>
        <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
      </Pressable>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 12, paddingHorizontal: 20 }}>
        <Text style={[styles.heading, { color: colors.foreground }]}>
          Contacts
        </Text>
        <Text style={[styles.headingSub, { color: colors.mutedForeground }]}>
          {contacts.length} captured
        </Text>
        <View
          style={[
            styles.searchRow,
            { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
          ]}
        >
          <Feather name="search" size={18} color={colors.mutedForeground} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search name, company, email"
            placeholderTextColor={colors.mutedForeground}
            style={[styles.searchInput, { color: colors.foreground }]}
            autoCapitalize="none"
          />
          {search ? (
            <Pressable onPress={() => setSearch("")} hitSlop={10}>
              <Feather name="x" size={18} color={colors.mutedForeground} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          contentContainerStyle={{
            padding: 20,
            paddingBottom: insets.bottom + 100,
            gap: 10,
          }}
          scrollEnabled={filtered.length > 0}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => query.refetch()}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={{ paddingTop: 60 }}>
              <EmptyState
                icon={search ? "search" : "users"}
                title={search ? "No matches" : "No contacts yet"}
                subtitle={
                  search
                    ? "Try a different search term."
                    : "Scan a business card to add your first contact."
                }
              />
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: {
    fontSize: 30,
    fontFamily: FONT.bold,
  },
  headingSub: {
    fontSize: 14,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    height: 46,
    marginTop: 16,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: FONT.regular,
    height: "100%",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 14,
    borderWidth: 1,
  },
  name: {
    fontSize: 16,
    fontFamily: FONT.semibold,
  },
  sub: {
    fontSize: 13.5,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
});
