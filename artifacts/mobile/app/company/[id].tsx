import { Feather } from "@/components/icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useState } from "react";
import {
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
  type Lead,
  getGetCrmOrganizationQueryKey,
  getListCrmOrganizationContactsQueryKey,
  getListCrmOrganizationLeadsQueryKey,
  useGetCrmOrganization,
  useListCrmOrganizationContacts,
  useListCrmOrganizationLeads,
} from "@workspace/api-client-react";

import { Avatar, ErrorState, FONT, LoadingState, prettyLabel } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { formatCurrencyFull } from "@/lib/currency";

export default function CompanyDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL, textAlign } = useLocale();
  const { id } = useLocalSearchParams<{ id: string }>();
  const orgId = Number(id);
  const [tab, setTab] = useState<"contacts" | "leads">("contacts");

  const query = useGetCrmOrganization(orgId, {
    query: { enabled: !!orgId, queryKey: getGetCrmOrganizationQueryKey(orgId) },
  });
  const contactsQuery = useListCrmOrganizationContacts(orgId, {
    query: { enabled: !!orgId, queryKey: getListCrmOrganizationContactsQueryKey(orgId) },
  });
  const leadsQuery = useListCrmOrganizationLeads(orgId, {
    query: { enabled: !!orgId, queryKey: getListCrmOrganizationLeadsQueryKey(orgId) },
  });

  const org = query.data;
  const contacts = contactsQuery.data?.contacts ?? [];
  const leads = leadsQuery.data?.leads ?? [];

  const detailRows: { icon: keyof typeof Feather.glyphMap; label: string; value: string }[] = org
    ? (
        [
          { icon: "tag", label: t("companies.industry"), value: org.industry },
          { icon: "globe", label: t("companies.website"), value: org.website },
          { icon: "phone", label: t("companies.phone"), value: org.phone },
          { icon: "mail", label: t("companies.email"), value: org.email },
          { icon: "map-pin", label: t("companies.country"), value: org.country },
          { icon: "map", label: t("companies.address"), value: org.address },
          { icon: "users", label: t("companies.size"), value: org.size },
          { icon: "file-text", label: t("companies.notes"), value: org.notes },
        ] as const
      )
        .filter((r) => !!r.value)
        .map((r) => ({ icon: r.icon, label: r.label, value: r.value as string }))
    : [];

  function contactName(c: Contact): string {
    return (
      (c.fullName ?? [c.firstName, c.lastName].filter(Boolean).join(" ")) ||
      t("common.unnamedContact")
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: org?.name ?? t("companies.title"),
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.foreground,
          headerTitleStyle: { fontFamily: FONT.semibold },
        }}
      />

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError || !org ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <ScrollView
          contentContainerStyle={{
            padding: 20,
            paddingBottom: insets.bottom + 40,
            gap: 20,
            flexGrow: 1,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={[styles.headerRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
            <View style={[styles.orgIcon, { backgroundColor: colors.primary + "1A" }]}>
              <Feather name="briefcase" size={24} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.orgName, { color: colors.foreground, textAlign }]}>{org.name}</Text>
              {org.industry ? (
                <Text style={[styles.orgSub, { color: colors.mutedForeground, textAlign }]}>{org.industry}</Text>
              ) : null}
            </View>
            {org.status === "archived" ? (
              <View style={[styles.archivedBadge, { backgroundColor: colors.muted }]}>
                <Text style={[styles.archivedText, { color: colors.mutedForeground }]}>
                  {t("companies.archivedBadge")}
                </Text>
              </View>
            ) : null}
          </View>

          {/* Stats */}
          <View style={{ flexDirection: "row", gap: 12 }}>
            <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 }]}>
              <Text style={[styles.statValue, { color: colors.foreground }]}>{org.contactCount}</Text>
              <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{t("companies.contacts")}</Text>
            </View>
            <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 }]}>
              <Text style={[styles.statValue, { color: colors.foreground }]}>{org.leadCount}</Text>
              <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{t("companies.leads")}</Text>
            </View>
            <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 }]}>
              <Text style={[styles.statValueSm, { color: colors.foreground }]}>
                {formatCurrencyFull(org.openLeadValue ?? 0, "USD")}
              </Text>
              <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{t("companies.openValue")}</Text>
            </View>
          </View>

          {/* Details */}
          {detailRows.length > 0 ? (
            <View
              style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 }]}
            >
              <Text style={[styles.sectionTitle, { color: colors.mutedForeground, textAlign }]}>
                {t("companies.details").toUpperCase()}
              </Text>
              {detailRows.map((r, idx) => (
                <View
                  key={r.label}
                  style={[
                    styles.detailRow,
                    { flexDirection: isRTL ? "row-reverse" : "row" },
                    idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                  ]}
                >
                  <Feather name={r.icon} size={16} color={colors.mutedForeground} />
                  <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>{r.label}</Text>
                  <Text numberOfLines={1} style={[styles.detailValue, { color: colors.foreground, textAlign: isRTL ? "left" : "right" }]}>
                    {r.value}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          {/* Tabs */}
          <View style={[styles.tabRow, { backgroundColor: colors.muted, borderRadius: colors.radius + 2 }]}>
            {(["contacts", "leads"] as const).map((k) => {
              const active = tab === k;
              return (
                <Pressable
                  key={k}
                  onPress={() => setTab(k)}
                  style={[
                    styles.tab,
                    active && { backgroundColor: colors.card, borderRadius: colors.radius },
                  ]}
                >
                  <Text
                    style={[
                      styles.tabText,
                      { color: active ? colors.foreground : colors.mutedForeground },
                    ]}
                  >
                    {t(`companies.${k}`)} ({k === "contacts" ? org.contactCount : org.leadCount})
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Tab content */}
          {tab === "contacts" ? (
            contacts.length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>{t("companies.noContacts")}</Text>
            ) : (
              <View style={{ gap: 10 }}>
                {contacts.map((c: Contact) => (
                  <Pressable
                    key={c.id}
                    onPress={() => router.push(`/contact/${c.id}`)}
                    style={({ pressed }) => [
                      styles.listRow,
                      {
                        backgroundColor: colors.card,
                        borderColor: colors.border,
                        borderRadius: colors.radius + 2,
                        flexDirection: isRTL ? "row-reverse" : "row",
                        opacity: pressed ? 0.75 : 1,
                      },
                    ]}
                  >
                    <Avatar name={contactName(c)} color={colors.primary} size={40} />
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={[styles.listName, { color: colors.foreground, textAlign }]}>
                        {contactName(c)}
                      </Text>
                      {c.jobTitle || c.email ? (
                        <Text numberOfLines={1} style={[styles.listSub, { color: colors.mutedForeground, textAlign }]}>
                          {c.jobTitle ?? c.email}
                        </Text>
                      ) : null}
                    </View>
                    <Feather name={isRTL ? "chevron-left" : "chevron-right"} size={18} color={colors.mutedForeground} />
                  </Pressable>
                ))}
              </View>
            )
          ) : leads.length === 0 ? (
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>{t("companies.noLeads")}</Text>
          ) : (
            <View style={{ gap: 10 }}>
              {leads.map((l: Lead) => (
                <Pressable
                  key={l.id}
                  onPress={() => router.push(`/pipeline/${l.id}`)}
                  style={({ pressed }) => [
                    styles.listRow,
                    {
                      backgroundColor: colors.card,
                      borderColor: colors.border,
                      borderRadius: colors.radius + 2,
                      flexDirection: isRTL ? "row-reverse" : "row",
                      opacity: pressed ? 0.75 : 1,
                    },
                  ]}
                >
                  <View style={[styles.leadIcon, { backgroundColor: colors.primary + "1A" }]}>
                    <Feather name="target" size={16} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={[styles.listName, { color: colors.foreground, textAlign }]}>
                      {l.title || t("common.unnamedLead")}
                    </Text>
                    <Text numberOfLines={1} style={[styles.listSub, { color: colors.mutedForeground, textAlign }]}>
                      {prettyLabel(l.stage ?? "")}
                      {l.value != null ? ` · ${formatCurrencyFull(Number(l.value), l.currency ?? "USD")}` : ""}
                    </Text>
                  </View>
                  <Feather name={isRTL ? "chevron-left" : "chevron-right"} size={18} color={colors.mutedForeground} />
                </Pressable>
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  orgIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  orgName: {
    fontSize: 22,
    fontFamily: FONT.bold,
  },
  orgSub: {
    fontSize: 14,
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
  statCard: {
    flex: 1,
    borderWidth: 1,
    padding: 14,
    alignItems: "center",
  },
  statValue: {
    fontSize: 22,
    fontFamily: FONT.bold,
  },
  statValueSm: {
    fontSize: 14,
    fontFamily: FONT.bold,
    textAlign: "center",
  },
  statLabel: {
    fontSize: 11.5,
    fontFamily: FONT.regular,
    marginTop: 4,
    textAlign: "center",
  },
  section: {
    borderWidth: 1,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 11.5,
    fontFamily: FONT.semibold,
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
  },
  detailLabel: {
    fontSize: 13.5,
    fontFamily: FONT.regular,
  },
  detailValue: {
    flex: 1,
    fontSize: 14,
    fontFamily: FONT.medium,
  },
  tabRow: {
    flexDirection: "row",
    padding: 4,
    gap: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 9,
    alignItems: "center",
  },
  tabText: {
    fontSize: 14,
    fontFamily: FONT.semibold,
  },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderWidth: 1,
  },
  leadIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  listName: {
    fontSize: 15,
    fontFamily: FONT.semibold,
  },
  listSub: {
    fontSize: 13,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: FONT.regular,
    textAlign: "center",
    paddingVertical: 30,
  },
});
