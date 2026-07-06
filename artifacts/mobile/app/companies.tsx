import { Feather } from "@/components/icons";
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
  type CrmOrganization,
  getListCrmOrganizationsQueryKey,
  useListCrmOrganizations,
} from "@workspace/api-client-react";

import {
  EmptyState,
  ErrorState,
  FONT,
  LoadingState,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { formatCurrencyFull } from "@/lib/currency";

export default function CompaniesScreen() {
  const colors = useColors();
  const { t, isRTL, textAlign } = useLocale();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);

  const query = useListCrmOrganizations(
    { limit: 200 },
    { query: { queryKey: getListCrmOrganizationsQueryKey({ limit: 200 }) } },
  );

  const organizations = query.data?.organizations ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return organizations;
    return organizations.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        (o.industry ?? "").toLowerCase().includes(q) ||
        (o.country ?? "").toLowerCase().includes(q),
    );
  }, [organizations, search]);

  function renderItem({ item }: { item: CrmOrganization }) {
    return (
      <Pressable
        onPress={() => router.push(`/company/${item.id}`)}
        style={({ pressed }) => [
          styles.card,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            borderRadius: colors.radius + 4,
            opacity: pressed ? 0.75 : 1,
          },
        ]}
      >
        <View style={[styles.cardHeader, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
          <View style={[styles.orgIcon, { backgroundColor: colors.primary + "1A" }]}>
            <Feather name="briefcase" size={18} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={[styles.orgName, { color: colors.foreground, textAlign }]}>
              {item.name}
            </Text>
            {item.industry || item.country ? (
              <Text numberOfLines={1} style={[styles.orgSub, { color: colors.mutedForeground, textAlign }]}>
                {[item.industry, item.country].filter(Boolean).join(" · ")}
              </Text>
            ) : null}
          </View>
          {item.status === "archived" ? (
            <View style={[styles.archivedBadge, { backgroundColor: colors.muted }]}>
              <Text style={[styles.archivedText, { color: colors.mutedForeground }]}>
                {t("companies.archivedBadge")}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={[styles.statsRow, { borderTopColor: colors.border }]}>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.foreground }]}>{item.contactCount}</Text>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{t("companies.contacts")}</Text>
          </View>
          <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.foreground }]}>{item.leadCount}</Text>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{t("companies.leads")}</Text>
          </View>
          <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.foreground }]}>
              {formatCurrencyFull(item.openLeadValue ?? 0, "USD")}
            </Text>
            <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{t("companies.openValue")}</Text>
          </View>
        </View>
      </Pressable>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 12, paddingHorizontal: 20 }}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Feather name={isRTL ? "chevron-right" : "chevron-left"} size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.heading, { color: colors.foreground, textAlign }]}>{t("companies.title")}</Text>
        <Text style={[styles.headingSub, { color: colors.mutedForeground, textAlign }]}>
          {t("companies.count", { count: organizations.length })}
        </Text>
        <View
          style={[
            styles.searchBox,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderRadius: colors.radius + 2,
              flexDirection: isRTL ? "row-reverse" : "row",
            },
          ]}
        >
          <Feather name="search" size={16} color={colors.mutedForeground} />
          <TextInput
            style={[styles.searchInput, { color: colors.foreground, textAlign }]}
            placeholder={t("companies.searchPlaceholder")}
            placeholderTextColor={colors.mutedForeground}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
          />
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
            gap: 12,
            flexGrow: 1,
          }}
          keyboardShouldPersistTaps="handled"
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
                icon="briefcase"
                title={t("companies.empty")}
                subtitle={t("companies.emptyDesc")}
              />
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  heading: {
    fontSize: 30,
    fontFamily: FONT.bold,
  },
  headingSub: {
    fontSize: 14,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 46,
    marginTop: 16,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontFamily: FONT.regular,
    padding: 0,
  },
  card: {
    padding: 16,
    borderWidth: 1,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  orgIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  orgName: {
    fontSize: 17,
    fontFamily: FONT.bold,
  },
  orgSub: {
    fontSize: 13,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  archivedBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  archivedText: {
    fontSize: 11,
    fontFamily: FONT.semibold,
  },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
  },
  stat: {
    flex: 1,
    alignItems: "center",
  },
  statDivider: {
    width: 1,
    height: 28,
  },
  statValue: {
    fontSize: 16,
    fontFamily: FONT.bold,
  },
  statLabel: {
    fontSize: 11.5,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
});
