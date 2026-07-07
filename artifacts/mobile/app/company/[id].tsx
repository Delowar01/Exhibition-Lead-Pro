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
  type Event as CrmEvent,
  type LeadNote,
  type Document as CrmDocument,
  type TimelineEntry,
  getGetCrmOrganizationQueryKey,
  getListCrmOrganizationContactsQueryKey,
  getListCrmOrganizationLeadsQueryKey,
  getListCrmOrganizationEventsQueryKey,
  getListCrmOrganizationNotesQueryKey,
  getListCrmOrganizationDocumentsQueryKey,
  getGetCrmOrganizationTimelineQueryKey,
  useGetCrmOrganization,
  useListCrmOrganizationContacts,
  useListCrmOrganizationLeads,
  useListCrmOrganizationEvents,
  useListCrmOrganizationNotes,
  useListCrmOrganizationDocuments,
  useGetCrmOrganizationTimeline,
} from "@workspace/api-client-react";

import { Avatar, ErrorState, FONT, LoadingState, prettyLabel } from "@/components/ui";
import { WorkflowSection } from "@/components/WorkflowSection";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { formatCurrencyFull } from "@/lib/currency";
import { formatGregorian } from "@/lib/date";

import { WorkspaceHeader } from "@/components/workspace/WorkspaceHeader";
import { WorkspaceTabs, type TabItem } from "@/components/workspace/WorkspaceTabs";

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return formatGregorian(d, { year: "numeric", month: "short", day: "numeric" });
}

export default function CompanyDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL, textAlign } = useLocale();
  const { id } = useLocalSearchParams<{ id: string }>();
  const orgId = Number(id);
  const [tab, setTab] = useState<
    "contacts" | "leads" | "events" | "notes" | "documents" | "timeline"
  >("contacts");

  const query = useGetCrmOrganization(orgId, {
    query: { enabled: !!orgId, queryKey: getGetCrmOrganizationQueryKey(orgId) },
  });
  const contactsQuery = useListCrmOrganizationContacts(orgId, {
    query: { enabled: !!orgId, queryKey: getListCrmOrganizationContactsQueryKey(orgId) },
  });
  const leadsQuery = useListCrmOrganizationLeads(orgId, {
    query: { enabled: !!orgId, queryKey: getListCrmOrganizationLeadsQueryKey(orgId) },
  });
  const eventsQuery = useListCrmOrganizationEvents(orgId, {
    query: { enabled: !!orgId, queryKey: getListCrmOrganizationEventsQueryKey(orgId) },
  });
  const notesQuery = useListCrmOrganizationNotes(orgId, {
    query: { enabled: !!orgId, queryKey: getListCrmOrganizationNotesQueryKey(orgId) },
  });
  const documentsQuery = useListCrmOrganizationDocuments(orgId, {
    query: { enabled: !!orgId, queryKey: getListCrmOrganizationDocumentsQueryKey(orgId) },
  });
  const timelineQuery = useGetCrmOrganizationTimeline(orgId, {
    query: { enabled: !!orgId, queryKey: getGetCrmOrganizationTimelineQueryKey(orgId) },
  });

  const org = query.data;
  const contacts = contactsQuery.data?.contacts ?? [];
  const leads = leadsQuery.data?.leads ?? [];
  const events = eventsQuery.data?.events ?? [];
  const notes = notesQuery.data?.notes ?? [];
  const documents = documentsQuery.data?.documents ?? [];
  const timeline = timelineQuery.data?.entries ?? [];

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
          headerShown: !org,
          title: t("companies.title"),
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
          <WorkspaceHeader
            title={org.name}
            subtitle={org.industry ?? undefined}
            avatarName={org.name}
            avatarColor={colors.primary}
            badges={org.status === "archived" ? [{ label: t("companies.archivedBadge"), color: colors.mutedForeground }] : undefined}
            onBack={() => router.back()}
          />

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

          {orgId > 0 ? <WorkflowSection entityType="organization" id={orgId} /> : null}

          {/* Tabs */}
          <WorkspaceTabs
            tabs={[
              { key: "contacts", label: t("companies.contacts"), count: contacts.length },
              { key: "leads", label: t("companies.leads"), count: leads.length },
              { key: "events", label: t("companies.events"), count: events.length },
              { key: "notes", label: t("companies.companyNotes"), count: notes.length },
              { key: "documents", label: t("companies.documents"), count: documents.length },
              { key: "timeline", label: t("companies.timeline"), count: timeline.length },
            ]}
            activeTab={tab}
            onChange={(k) => setTab(k as typeof tab)}
          />

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
          ) : tab === "leads" ? (
            leads.length === 0 ? (
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
            )
          ) : tab === "events" ? (
            events.length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>{t("companies.noEvents")}</Text>
            ) : (
              <View style={{ gap: 10 }}>
                {events.map((e: CrmEvent) => (
                  <Pressable
                    key={e.id}
                    onPress={() => router.push(`/event/${e.id}`)}
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
                      <Feather name="calendar" size={16} color={colors.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={[styles.listName, { color: colors.foreground, textAlign }]}>
                        {e.name}
                      </Text>
                      <Text numberOfLines={1} style={[styles.listSub, { color: colors.mutedForeground, textAlign }]}>
                        {[formatDate(e.startDate), e.venue].filter(Boolean).join(" · ") || "—"}
                      </Text>
                    </View>
                    <Feather name={isRTL ? "chevron-left" : "chevron-right"} size={18} color={colors.mutedForeground} />
                  </Pressable>
                ))}
              </View>
            )
          ) : tab === "notes" ? (
            notes.length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>{t("companies.noNotes")}</Text>
            ) : (
              <View style={{ gap: 10 }}>
                {notes.map((n: LeadNote) => (
                  <View
                    key={n.id}
                    style={[
                      styles.noteCard,
                      { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 2 },
                    ]}
                  >
                    <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <Text style={[styles.listName, { color: colors.foreground, textAlign }]}>
                        {n.userName ?? t("common.unnamedContact")}
                      </Text>
                      <Text style={[styles.listSub, { color: colors.mutedForeground }]}>{formatDate(n.createdAt)}</Text>
                    </View>
                    <Text style={[styles.noteBody, { color: colors.foreground, textAlign }]}>{n.body}</Text>
                  </View>
                ))}
              </View>
            )
          ) : tab === "documents" ? (
            documents.length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>{t("companies.noDocuments")}</Text>
            ) : (
              <View style={{ gap: 10 }}>
                {documents.map((d: CrmDocument) => (
                  <View
                    key={d.id}
                    style={[
                      styles.listRow,
                      {
                        backgroundColor: colors.card,
                        borderColor: colors.border,
                        borderRadius: colors.radius + 2,
                        flexDirection: isRTL ? "row-reverse" : "row",
                      },
                    ]}
                  >
                    <View style={[styles.leadIcon, { backgroundColor: colors.primary + "1A" }]}>
                      <Feather name="file-text" size={16} color={colors.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={[styles.listName, { color: colors.foreground, textAlign }]}>
                        {d.name}
                      </Text>
                      <Text numberOfLines={1} style={[styles.listSub, { color: colors.mutedForeground, textAlign }]}>
                        {[prettyLabel(d.entityType), d.entityName].filter(Boolean).join(": ")}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )
          ) : timeline.length === 0 ? (
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>{t("companies.noTimeline")}</Text>
          ) : (
            <View style={{ gap: 10 }}>
              {timeline.map((tItem: TimelineEntry) => (
                <View
                  key={tItem.id}
                  style={[
                    styles.noteCard,
                    { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 2 },
                  ]}
                >
                  <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <Text style={[styles.listName, { color: colors.foreground, textAlign }]}>
                      {tItem.title ?? prettyLabel(tItem.type ?? tItem.kind)}
                    </Text>
                    <Text style={[styles.listSub, { color: colors.mutedForeground }]}>{formatDate(tItem.occurredAt)}</Text>
                  </View>
                  {tItem.body ? (
                    <Text style={[styles.noteBody, { color: colors.mutedForeground, textAlign }]}>{tItem.body}</Text>
                  ) : null}
                  {tItem.actorName ? (
                    <Text style={[styles.listSub, { color: colors.mutedForeground, textAlign }]}>{tItem.actorName}</Text>
                  ) : null}
                </View>
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
  noteCard: {
    borderWidth: 1,
    padding: 12,
    gap: 6,
  },
  noteBody: {
    fontSize: 14,
    fontFamily: FONT.regular,
    lineHeight: 20,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: FONT.regular,
    textAlign: "center",
    paddingVertical: 30,
  },
});
