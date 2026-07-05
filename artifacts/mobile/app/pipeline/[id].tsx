import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useQueryClient } from "@tanstack/react-query";

import {
  getGetContactQueryKey,
  getGetLeadQueryKey,
  getListLeadNotesQueryKey,
  type Lead,
  type LeadNote,
  type LeadNoteList,
  type Tag,
  type TimelineEntry,
  LeadActivityInputType,
  LeadUpdateStage,
  AssignLeadInputStrategy,
  type AssigneeRecommendation,
  useAttachLeadTag,
  useCreateLeadActivity,
  useCreateLeadNote,
  useDeleteLead,
  useDetachLeadTag,
  useGetContact,
  useGetLead,
  useGetLeadTimeline,
  useListLeadNotes,
  useListLeadTags,
  useListTags,
  useListTeams,
  useListUsers,
  useAssignLead,
  useRecommendLeadAssignee,
  useUpdateLead,
} from "@workspace/api-client-react";

import {
  Avatar,
  Badge,
  EmptyState,
  ErrorState,
  FONT,
  LEAD_STAGE_COLORS,
  LoadingState,
  prettyLabel,
} from "@/components/ui";
import { CommunicationHub } from "@/components/CommunicationHub";
import { DocumentsSection } from "@/components/DocumentsSection";
import { useColors } from "@/hooks/useColors";
import { useLocale } from "@/hooks/useLocale";
import { formatGregorian } from "@/lib/date";

function formatCurrency(value: number, currency = "USD"): string {
  if (value >= 1_000_000) return `${currency} ${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${currency} ${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}k`;
  return `${currency} ${Math.round(value)}`;
}

function formatDate(dateStr: string): string {
  try {
    const parts = dateStr.split("-");
    if (parts.length === 3) {
      const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      return formatGregorian(d, { month: "short", day: "numeric", year: "numeric" });
    }
  } catch { /* ignore */ }
  return dateStr;
}

// Safely format an ISO / date-only timestamp for the timeline. Date-only strings
// (YYYY-MM-DD) are parsed as LOCAL midnight (never UTC, which would day-shift in
// negative-offset zones); full ISO timestamps keep their time. Unparseable values
// fall back to the raw string rather than rendering "Invalid Date".
function formatTimelineDate(iso: string): string {
  try {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.exec(iso);
    if (dateOnly) {
      const [y, m, d] = iso.split("-").map(Number);
      const local = new Date(y, m - 1, d);
      if (isNaN(local.getTime())) return iso;
      return formatGregorian(local, { month: "short", day: "numeric", year: "numeric" });
    }
    const dt = new Date(iso);
    if (isNaN(dt.getTime())) return iso;
    return formatGregorian(dt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function priorityColor(p: string): string {
  if (p === "high") return "#EF4444";
  if (p === "medium") return "#F59E0B";
  return "#3B82F6";
}

const TIMELINE_KIND_ICONS: Record<string, keyof typeof Feather.glyphMap> = {
  activity: "activity",
  note: "file-text",
  lead_history: "git-commit",
  contact_status: "flag",
  follow_up: "clock",
  meeting: "calendar",
  task: "check-square",
  scan: "camera",
};

const ACTIVITY_TYPES = ["call", "email", "meeting", "message", "note", "other"] as const;

const ASSIGN_STRATEGIES: AssignLeadInputStrategy[] = [
  AssignLeadInputStrategy.manual,
  AssignLeadInputStrategy.round_robin,
  AssignLeadInputStrategy.load_balanced,
  AssignLeadInputStrategy.availability,
  AssignLeadInputStrategy.territory,
  AssignLeadInputStrategy.ai,
];

const ACTIVITY_TYPE_ICONS: Record<string, keyof typeof Feather.glyphMap> = {
  call: "phone",
  email: "mail",
  meeting: "calendar",
  message: "message-circle",
  note: "file-text",
  other: "activity",
};

interface InfoRowProps {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value?: string | null;
  valueColor?: string;
}
function InfoRow({ icon, label, value, valueColor }: InfoRowProps) {
  const colors = useColors();
  if (!value) return null;
  return (
    <View style={styles.infoRow}>
      <Feather name={icon} size={16} color={colors.mutedForeground} style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>{label}</Text>
        <Text style={[styles.infoValue, { color: valueColor ?? colors.foreground }]}>{value}</Text>
      </View>
    </View>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  const colors = useColors();
  const { isRTL } = useLocale();
  return (
    <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 }]}>
      <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>{title.toUpperCase()}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}

export default function PipelineDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t, isRTL, textAlign } = useLocale();
  const { id } = useLocalSearchParams<{ id: string }>();
  const leadId = parseInt(id ?? "0");

  const queryClient = useQueryClient();
  const query = useGetLead(leadId, { query: { enabled: leadId > 0, queryKey: getGetLeadQueryKey(leadId) } });
  const leadContactId = query.data?.contactId ?? 0;
  const contactQuery = useGetContact(leadContactId, {
    query: { enabled: leadContactId > 0, queryKey: getGetContactQueryKey(leadContactId) },
  });
  const timelineQuery = useGetLeadTimeline(leadId, { query: { enabled: leadId > 0, queryKey: ["/api/leads", leadId, "timeline"] } });
  const notesQuery = useListLeadNotes(leadId, { query: { enabled: leadId > 0, queryKey: getListLeadNotesQueryKey(leadId) } });
  const tagsQuery = useListLeadTags(leadId, { query: { enabled: leadId > 0, queryKey: ["/api/leads", leadId, "tags"] } });

  // Optimistic stage change: update the cache the instant the user taps so the
  // badge/actions reflect the new stage with zero perceived latency. The server
  // round-trip + the global post-mutation invalidation then reconcile with the
  // authoritative record (including the new history row). On failure we roll the
  // cache back and surface an alert.
  const updateLead = useUpdateLead({
    mutation: {
      onMutate: async (vars) => {
        const key = getGetLeadQueryKey(leadId);
        await queryClient.cancelQueries({ queryKey: key });
        const prev = queryClient.getQueryData<Lead>(key);
        if (vars.data.stage && prev) {
          queryClient.setQueryData<Lead>(key, { ...prev, stage: vars.data.stage });
        }
        return { prev, key };
      },
      onError: (_err, _vars, ctx) => {
        if (ctx?.prev) queryClient.setQueryData(ctx.key, ctx.prev);
        Alert.alert(t("pipeline.failedSave"));
      },
    },
  });
  const deleteLead = useDeleteLead();

  const lead = query.data;

  // Notes — optimistic add: insert a placeholder note immediately, then let the
  // global MutationCache invalidation reconcile with the server row. Roll back on
  // error. Mirrors the stage-change optimistic pattern above.
  const [noteText, setNoteText] = useState("");
  const createNote = useCreateLeadNote({
    mutation: {
      onMutate: async (vars) => {
        const key = getListLeadNotesQueryKey(leadId);
        await queryClient.cancelQueries({ queryKey: key });
        const prev = queryClient.getQueryData<LeadNoteList>(key);
        const optimistic: LeadNote = {
          id: -Date.now(),
          companyId: lead?.companyId ?? 0,
          leadId,
          body: vars.data.body,
          createdAt: new Date().toISOString(),
          userName: null,
        };
        queryClient.setQueryData<LeadNoteList>(key, { notes: [optimistic, ...(prev?.notes ?? [])] });
        return { prev, key };
      },
      onError: (_err, _vars, ctx) => {
        if (ctx?.prev) queryClient.setQueryData(ctx.key, ctx.prev);
        Alert.alert(t("pipeline.notesSection.failed"));
      },
    },
  });

  const attachTag = useAttachLeadTag({ mutation: { onError: () => Alert.alert(t("pipeline.tagsSection.failed")) } });
  const detachTag = useDetachLeadTag({ mutation: { onError: () => Alert.alert(t("pipeline.tagsSection.failed")) } });
  const createActivity = useCreateLeadActivity({ mutation: { onError: () => Alert.alert(t("pipeline.activity.failed")) } });

  // Log-activity modal
  const [activityModalVisible, setActivityModalVisible] = useState(false);
  const [activityType, setActivityType] = useState<string>("call");
  const [activitySubject, setActivitySubject] = useState("");
  const [activityBody, setActivityBody] = useState("");

  // Assignment modal (rule-based + AI recommend)
  const [assignModalVisible, setAssignModalVisible] = useState(false);
  const [assignStrategy, setAssignStrategy] = useState<AssignLeadInputStrategy>(AssignLeadInputStrategy.manual);
  const [assignOwnerId, setAssignOwnerId] = useState<number | null>(null);
  const [assignTeamId, setAssignTeamId] = useState<number | null>(null);
  const [recommendation, setRecommendation] = useState<AssigneeRecommendation | null>(null);
  const assignUsersQuery = useListUsers({ limit: 200 }, { query: { enabled: assignModalVisible, queryKey: ["/api/users", "assign"] } });
  const assignTeamsQuery = useListTeams(undefined, { query: { enabled: assignModalVisible, queryKey: ["/api/teams", "assign"] } });
  const assignUsers = assignUsersQuery.data?.users ?? [];
  const assignTeams = assignTeamsQuery.data?.teams ?? [];
  const assignTeamRequired = assignStrategy === "load_balanced" || assignStrategy === "availability";
  const assignLead = useAssignLead();
  const recommendAssignee = useRecommendLeadAssignee();

  function submitAssignment() {
    if (!lead) return;
    if (assignStrategy === "manual" && assignOwnerId == null) {
      Alert.alert(t("pipeline.assign.pickOwner"));
      return;
    }
    if (assignTeamRequired && assignTeamId == null && lead.teamId == null) {
      Alert.alert(t("pipeline.assign.pickTeam"));
      return;
    }
    assignLead.mutate(
      {
        id: lead.id,
        data: {
          strategy: assignStrategy,
          assignedToId: assignStrategy === "manual" ? assignOwnerId : undefined,
          teamId: assignTeamId ?? lead.teamId ?? null,
        },
      },
      {
        onSuccess: () => {
          if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
          setAssignModalVisible(false);
          setRecommendation(null);
        },
        onError: (e: any) => Alert.alert(t("pipeline.assign.failed"), e?.message || undefined),
      }
    );
  }

  function fetchRecommendation() {
    if (!lead) return;
    recommendAssignee.mutate(
      { id: lead.id, data: { teamId: assignTeamId ?? lead.teamId ?? null } },
      {
        onSuccess: (data) => setRecommendation(data),
        onError: (e: any) => Alert.alert(t("pipeline.assign.noRecommendation"), e?.message || undefined),
      }
    );
  }

  function applyRecommendation() {
    if (!lead || !recommendation) return;
    assignLead.mutate(
      { id: lead.id, data: { strategy: "manual", assignedToId: recommendation.assignedToId, teamId: assignTeamId ?? lead.teamId ?? null } },
      {
        onSuccess: () => {
          if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
          setAssignModalVisible(false);
          setRecommendation(null);
        },
        onError: (e: any) => Alert.alert(t("pipeline.assign.failed"), e?.message || undefined),
      }
    );
  }

  // Tag picker modal
  const [tagModalVisible, setTagModalVisible] = useState(false);
  const allTagsQuery = useListTags({ query: { enabled: tagModalVisible, queryKey: ["/api/tags"] } });

  const timelineEntries = timelineQuery.data?.entries ?? [];
  const notes = notesQuery.data?.notes ?? [];
  const leadTags = tagsQuery.data?.tags ?? [];
  const attachedTagIds = new Set(leadTags.map((tg) => tg.id));
  const availableTags = (allTagsQuery.data?.tags ?? []).filter((tg) => !attachedTagIds.has(tg.id));

  function moveStage(newStage: string) {
    if (!lead || updateLead.isPending) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    updateLead.mutate({ id: lead.id, data: { stage: newStage as LeadUpdateStage } });
  }

  function confirmMarkWon() {
    Alert.alert(t("pipeline.markWon"), t("pipeline.history.changedStage"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("pipeline.markWon"), style: "default", onPress: () => moveStage("won") },
    ]);
  }

  function confirmMarkLost() {
    Alert.alert(t("pipeline.markLost"), t("pipeline.history.changedStage"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("pipeline.markLost"), style: "destructive", onPress: () => moveStage("lost") },
    ]);
  }

  function confirmDelete() {
    if (!lead) return;
    const run = async () => {
      try {
        await deleteLead.mutateAsync({ id: lead.id });
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.back();
      } catch {
        Alert.alert(t("pipeline.deleteFailed"));
      }
    };
    if (Platform.OS === "web") { void run(); return; }
    Alert.alert(t("pipeline.deleteTitle"), t("pipeline.deleteConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.delete"), style: "destructive", onPress: run },
    ]);
  }

  function submitNote() {
    if (!lead) return;
    const body = noteText.trim();
    if (!body || createNote.isPending) return;
    if (Platform.OS !== "web") Haptics.selectionAsync();
    setNoteText("");
    createNote.mutate({ id: lead.id, data: { body } });
  }

  function submitActivity() {
    if (!lead) return;
    const body = activityBody.trim();
    const subject = activitySubject.trim();
    if (!body && !subject) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    createActivity.mutate(
      {
        id: lead.id,
        data: {
          type: activityType as LeadActivityInputType,
          subject: subject || null,
          body: body || null,
          occurredAt: new Date().toISOString(),
        },
      },
      {
        onSuccess: () => {
          setActivityModalVisible(false);
          setActivitySubject("");
          setActivityBody("");
          setActivityType("call");
        },
      },
    );
  }

  function onAttachTag(tag: Tag) {
    if (!lead) return;
    if (Platform.OS !== "web") Haptics.selectionAsync();
    attachTag.mutate({ id: lead.id, data: { tagId: tag.id } });
    setTagModalVisible(false);
  }

  function onDetachTag(tag: Tag) {
    if (!lead) return;
    if (Platform.OS !== "web") Haptics.selectionAsync();
    detachTag.mutate({ id: lead.id, tagId: tag.id });
  }

  function onRefresh() {
    void query.refetch();
    void timelineQuery.refetch();
    void notesQuery.refetch();
    void tagsQuery.refetch();
  }

  const stageColor = LEAD_STAGE_COLORS[lead?.stage ?? "prospect"] ?? colors.primary;
  const isWonOrLost = lead?.stage === "won" || lead?.stage === "lost";
  const refreshing =
    query.isRefetching || timelineQuery.isRefetching || notesQuery.isRefetching || tagsQuery.isRefetching;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: lead?.title ?? t("common.unnamedLead"),
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.foreground,
          headerTitleStyle: { fontFamily: FONT.semibold },
          headerRight: () =>
            lead ? (
              <View style={{ flexDirection: "row", gap: 14 }}>
                <Pressable onPress={() => router.push(`/pipeline/form?id=${lead.id}`)} hitSlop={10}>
                  <Feather name="edit-2" size={19} color={colors.primary} />
                </Pressable>
                <Pressable onPress={confirmDelete} hitSlop={10}>
                  <Feather name="trash-2" size={19} color={colors.destructive} />
                </Pressable>
              </View>
            ) : null,
        }}
      />

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError || !lead ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 60, gap: 16, flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        >
          {/* Hero card */}
          <View style={[styles.heroCard, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 6 }]}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <Badge
                label={t(`leads.stages.${lead.stage}`, { defaultValue: prettyLabel(lead.stage) })}
                color={stageColor}
              />
              {lead.priority ? (
                <Badge
                  label={t(`pipeline.priority${lead.priority.charAt(0).toUpperCase() + lead.priority.slice(1)}`)}
                  color={priorityColor(lead.priority)}
                />
              ) : null}
            </View>

            {lead.title ? (
              <Text style={[styles.heroTitle, { color: colors.foreground }]}>{lead.title}</Text>
            ) : null}

            {lead.value != null && lead.value > 0 ? (
              <Text style={[styles.heroValue, { color: colors.success }]}>
                {formatCurrency(lead.value, lead.currency ?? "USD")}
              </Text>
            ) : null}

            {typeof lead.probability === "number" ? (
              <View style={{ marginTop: 10 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                  <Text style={[styles.probLabel, { color: colors.mutedForeground }]}>{t("pipeline.probability")}</Text>
                  <Text style={[styles.probLabel, { color: colors.foreground, fontFamily: FONT.semibold }]}>{lead.probability}%</Text>
                </View>
                <View style={[styles.probBar, { backgroundColor: colors.muted }]}>
                  <View style={[styles.probFill, { width: `${lead.probability}%` as `${number}%`, backgroundColor: stageColor }]} />
                </View>
              </View>
            ) : null}
          </View>

          {/* Details */}
          <Section
            title={t("contacts.sectionDetails")}
            action={
              <Pressable
                onPress={() => {
                  setAssignStrategy(AssignLeadInputStrategy.manual);
                  setAssignOwnerId(lead.assignedToId ?? null);
                  setAssignTeamId(lead.teamId ?? null);
                  setRecommendation(null);
                  setAssignModalVisible(true);
                }}
                hitSlop={8}
                style={({ pressed }) => [styles.sectionAction, { borderColor: colors.border, opacity: pressed ? 0.6 : 1 }]}
              >
                <Feather name="user-plus" size={13} color={colors.primary} />
                <Text style={[styles.sectionActionText, { color: colors.primary }]}>{t("pipeline.assign.button")}</Text>
              </Pressable>
            }
          >
            {lead.contactName ? (
              <View style={[styles.infoRow, { marginBottom: 4 }]}>
                <Avatar name={lead.contactName} size={28} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>{t("pipeline.contact")}</Text>
                  <Text style={[styles.infoValue, { color: colors.foreground }]}>{lead.contactName}</Text>
                  {lead.contactCompany ? (
                    <Text style={[styles.infoLabel, { color: colors.mutedForeground }]}>{lead.contactCompany}</Text>
                  ) : null}
                </View>
              </View>
            ) : null}
            <InfoRow icon="user-check" label={t("pipeline.assignedTo")} value={lead.assignedToName ?? t("pipeline.unassigned")} />
            <InfoRow icon="users" label={t("pipeline.team")} value={lead.teamName ?? t("pipeline.noTeam")} />
            <InfoRow icon="calendar" label={t("pipeline.event")} value={lead.eventName ?? undefined} />
            <InfoRow
              icon="target"
              label={t("pipeline.closeDate")}
              value={lead.closingDate ? formatDate(lead.closingDate) : t("pipeline.noClosingDate")}
            />
            {lead.notes ? <InfoRow icon="file-text" label={t("pipeline.notes")} value={lead.notes} /> : null}
          </Section>

          <CommunicationHub
            entity="lead"
            id={leadId}
            email={contactQuery.data?.email ?? lead.contactEmail}
            phone={contactQuery.data?.mobile ?? contactQuery.data?.officePhone}
            displayName={lead.contactName ?? lead.title}
          />

          {/* Actions */}
          {!isWonOrLost ? (
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Pressable
                onPress={confirmMarkWon}
                style={({ pressed }) => [styles.actionBtn, { backgroundColor: "#22C55E" + "1A", borderColor: "#22C55E", opacity: pressed ? 0.7 : 1, flex: 1 }]}
              >
                <Feather name="award" size={16} color="#22C55E" />
                <Text style={[styles.actionBtnText, { color: "#22C55E" }]}>{t("pipeline.markWon")}</Text>
              </Pressable>
              <Pressable
                onPress={confirmMarkLost}
                style={({ pressed }) => [styles.actionBtn, { backgroundColor: colors.destructive + "1A", borderColor: colors.destructive, opacity: pressed ? 0.7 : 1, flex: 1 }]}
              >
                <Feather name="x-circle" size={16} color={colors.destructive} />
                <Text style={[styles.actionBtnText, { color: colors.destructive }]}>{t("pipeline.markLost")}</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={() => moveStage("prospect")}
              style={({ pressed }) => [styles.actionBtn, { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
            >
              <Feather name="refresh-cw" size={16} color={colors.foreground} />
              <Text style={[styles.actionBtnText, { color: colors.foreground }]}>{t("pipeline.reopen")}</Text>
            </Pressable>
          )}

          {/* Tags */}
          <Section
            title={t("pipeline.tagsSection.title")}
            action={
              <Pressable
                onPress={() => setTagModalVisible(true)}
                hitSlop={8}
                style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", gap: 4 }}
              >
                <Feather name="plus" size={14} color={colors.primary} />
                <Text style={[styles.linkText, { color: colors.primary }]}>{t("pipeline.tagsSection.add")}</Text>
              </Pressable>
            }
          >
            {leadTags.length === 0 ? (
              <Text style={[styles.emptyInline, { color: colors.mutedForeground, textAlign }]}>
                {t("pipeline.tagsSection.empty")}
              </Text>
            ) : (
              <View style={[styles.tagWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
                {leadTags.map((tag) => {
                  const tColor = (tag.color ?? "") || colors.primary;
                  return (
                    <Pressable
                      key={tag.id}
                      onPress={() => onDetachTag(tag)}
                      style={[styles.tagChip, { backgroundColor: tColor + "1A", borderColor: tColor + "55", flexDirection: isRTL ? "row-reverse" : "row" }]}
                    >
                      <View style={[styles.tagDot, { backgroundColor: tColor }]} />
                      <Text style={[styles.tagText, { color: tColor }]}>{tag.name}</Text>
                      <Feather name="x" size={12} color={tColor} />
                    </Pressable>
                  );
                })}
              </View>
            )}
          </Section>

          {/* Notes */}
          <Section title={t("pipeline.notesSection.title")}>
            <View style={[styles.noteInputRow, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              <TextInput
                style={[styles.noteInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground, textAlign }]}
                placeholder={t("pipeline.notesSection.placeholder")}
                placeholderTextColor={colors.mutedForeground}
                value={noteText}
                onChangeText={setNoteText}
                multiline
              />
              <Pressable
                onPress={submitNote}
                disabled={!noteText.trim() || createNote.isPending}
                style={({ pressed }) => [
                  styles.noteSendBtn,
                  { backgroundColor: colors.primary, opacity: !noteText.trim() || createNote.isPending ? 0.5 : pressed ? 0.8 : 1 },
                ]}
              >
                <Feather name="send" size={16} color={colors.primaryForeground} />
              </Pressable>
            </View>

            {notes.length === 0 ? (
              <Text style={[styles.emptyInline, { color: colors.mutedForeground, textAlign }]}>
                {t("pipeline.notesSection.empty")}
              </Text>
            ) : (
              notes.map((note, idx) => (
                <View
                  key={note.id}
                  style={[styles.noteRow, idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}
                >
                  <Text style={[styles.noteBody, { color: colors.foreground, textAlign }]}>{note.body}</Text>
                  <Text style={[styles.noteMeta, { color: colors.mutedForeground, textAlign }]}>
                    {note.userName ? `${note.userName} · ` : ""}
                    {formatTimelineDate(note.createdAt)}
                  </Text>
                </View>
              ))
            )}
          </Section>

          {/* Log activity quick action */}
          <Pressable
            onPress={() => setActivityModalVisible(true)}
            style={({ pressed }) => [styles.actionBtn, { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
          >
            <Feather name="plus-circle" size={16} color={colors.primary} />
            <Text style={[styles.actionBtnText, { color: colors.primary }]}>{t("pipeline.logActivity")}</Text>
          </Pressable>

          {/* Activity timeline */}
          <Section title={t("pipeline.timeline.title")}>
            {timelineQuery.isLoading ? (
              <View style={{ paddingVertical: 16 }}>
                <LoadingState />
              </View>
            ) : timelineEntries.length === 0 ? (
              <View style={{ paddingVertical: 16 }}>
                <EmptyState icon="activity" title={t("pipeline.timeline.empty")} />
              </View>
            ) : (
              timelineEntries.map((entry: TimelineEntry, idx) => {
                const kindLabel = t(`pipeline.timeline.kinds.${entry.kind}`, { defaultValue: prettyLabel(entry.kind) });
                const icon = TIMELINE_KIND_ICONS[entry.kind] ?? "activity";
                const primary = (entry.title ?? "").trim() || kindLabel;
                return (
                  <View
                    key={entry.id}
                    style={[
                      styles.historyRow,
                      { flexDirection: isRTL ? "row-reverse" : "row" },
                      idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                    ]}
                  >
                    <View style={[styles.timelineIcon, { backgroundColor: colors.muted }]}>
                      <Feather name={icon} size={13} color={colors.mutedForeground} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.historyField, { color: colors.foreground, textAlign }]}>{primary}</Text>
                      {entry.body ? (
                        <Text style={[styles.timelineBody, { color: colors.mutedForeground, textAlign }]}>{entry.body}</Text>
                      ) : null}
                      <Text style={[styles.historyMeta, { color: colors.mutedForeground, textAlign }]}>
                        {entry.actorName ? `${entry.actorName} · ` : ""}
                        {formatTimelineDate(entry.occurredAt)}
                      </Text>
                    </View>
                  </View>
                );
              })
            )}
          </Section>

          {/* Documents */}
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4 }]}>
            <DocumentsSection entityType="lead" entityId={leadId} />
          </View>
        </ScrollView>
      )}

      {/* Log-activity modal */}
      <Modal visible={activityModalVisible} animationType="slide" transparent onRequestClose={() => setActivityModalVisible(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Pressable style={styles.modalBackdrop} onPress={() => setActivityModalVisible(false)} />
          <View style={[styles.modalSheet, { backgroundColor: colors.card, paddingBottom: insets.bottom + 20 }]}>
            <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>{t("pipeline.activity.title")}</Text>
              <Pressable onPress={() => setActivityModalVisible(false)} hitSlop={10}>
                <Feather name="x" size={22} color={colors.foreground} />
              </Pressable>
            </View>

            <Text style={[styles.label, { color: colors.mutedForeground, textAlign }]}>{t("pipeline.activity.type").toUpperCase()}</Text>
            <View style={[styles.typeWrap, { flexDirection: isRTL ? "row-reverse" : "row" }]}>
              {ACTIVITY_TYPES.map((ty) => {
                const active = activityType === ty;
                return (
                  <Pressable
                    key={ty}
                    onPress={() => setActivityType(ty)}
                    style={[
                      styles.typeChip,
                      { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primary + "1A" : colors.background, flexDirection: isRTL ? "row-reverse" : "row" },
                    ]}
                  >
                    <Feather name={ACTIVITY_TYPE_ICONS[ty]} size={13} color={active ? colors.primary : colors.mutedForeground} />
                    <Text style={[styles.typeChipText, { color: active ? colors.primary : colors.mutedForeground }]}>
                      {t(`pipeline.activity.types.${ty}`)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={[styles.label, { color: colors.mutedForeground, textAlign, marginTop: 14 }]}>{t("pipeline.activity.subject").toUpperCase()}</Text>
            <TextInput
              style={[styles.input, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground, textAlign }]}
              placeholder={t("pipeline.activity.subjectPlaceholder")}
              placeholderTextColor={colors.mutedForeground}
              value={activitySubject}
              onChangeText={setActivitySubject}
            />

            <Text style={[styles.label, { color: colors.mutedForeground, textAlign, marginTop: 14 }]}>{t("pipeline.activity.body").toUpperCase()}</Text>
            <TextInput
              style={[styles.textArea, { backgroundColor: colors.background, borderColor: colors.border, color: colors.foreground, textAlign }]}
              placeholder={t("pipeline.activity.bodyPlaceholder")}
              placeholderTextColor={colors.mutedForeground}
              value={activityBody}
              onChangeText={setActivityBody}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />

            <Pressable
              onPress={submitActivity}
              disabled={(!activityBody.trim() && !activitySubject.trim()) || createActivity.isPending}
              style={({ pressed }) => [
                styles.submitBtn,
                {
                  backgroundColor: colors.primary,
                  borderRadius: colors.radius + 4,
                  opacity: (!activityBody.trim() && !activitySubject.trim()) || createActivity.isPending ? 0.5 : pressed ? 0.85 : 1,
                },
              ]}
            >
              <Feather name="check" size={18} color={colors.primaryForeground} />
              <Text style={[styles.submitBtnText, { color: colors.primaryForeground }]}>{t("pipeline.activity.submit")}</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Tag picker modal */}
      <Modal visible={tagModalVisible} animationType="slide" transparent onRequestClose={() => setTagModalVisible(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setTagModalVisible(false)} />
        <View style={[styles.modalSheet, { backgroundColor: colors.card, paddingBottom: insets.bottom + 20, maxHeight: "70%" }]}>
          <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>{t("pipeline.tagsSection.select")}</Text>
            <Pressable onPress={() => setTagModalVisible(false)} hitSlop={10}>
              <Feather name="x" size={22} color={colors.foreground} />
            </Pressable>
          </View>
          {allTagsQuery.isLoading ? (
            <View style={{ paddingVertical: 24 }}>
              <LoadingState />
            </View>
          ) : availableTags.length === 0 ? (
            <Text style={[styles.emptyInline, { color: colors.mutedForeground, textAlign }]}>
              {(allTagsQuery.data?.tags ?? []).length === 0
                ? t("pipeline.tagsSection.none")
                : t("pipeline.tagsSection.allAttached")}
            </Text>
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }}>
              {availableTags.map((tag) => {
                const tColor = (tag.color ?? "") || colors.primary;
                return (
                  <Pressable
                    key={tag.id}
                    onPress={() => onAttachTag(tag)}
                    style={({ pressed }) => [styles.tagPickRow, { borderBottomColor: colors.border, flexDirection: isRTL ? "row-reverse" : "row", opacity: pressed ? 0.7 : 1 }]}
                  >
                    <View style={[styles.tagDot, { backgroundColor: tColor }]} />
                    <Text style={[styles.tagPickText, { color: colors.foreground, textAlign, flex: 1 }]}>{tag.name}</Text>
                    <Feather name="plus" size={16} color={colors.primary} />
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
        </View>
      </Modal>

      {/* Assignment modal */}
      <Modal visible={assignModalVisible} animationType="slide" transparent onRequestClose={() => setAssignModalVisible(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setAssignModalVisible(false)} />
        <View style={[styles.modalSheet, { backgroundColor: colors.card, paddingBottom: insets.bottom + 20, maxHeight: "85%" }]}>
          <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>{t("pipeline.assign.title")}</Text>
            <Pressable onPress={() => setAssignModalVisible(false)} hitSlop={10}>
              <Feather name="x" size={22} color={colors.foreground} />
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }}>
            <Text style={[styles.label, { color: colors.mutedForeground, textAlign }]}>{t("pipeline.assign.strategy").toUpperCase()}</Text>
            <View style={[styles.typeWrap, { flexDirection: isRTL ? "row-reverse" : "row", flexWrap: "wrap" }]}>
              {ASSIGN_STRATEGIES.map((st) => {
                const active = assignStrategy === st;
                return (
                  <Pressable
                    key={st}
                    onPress={() => {
                      setAssignStrategy(st);
                      setRecommendation(null);
                    }}
                    style={[
                      styles.typeChip,
                      { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primary + "1A" : colors.background, flexDirection: isRTL ? "row-reverse" : "row" },
                    ]}
                  >
                    <Text style={[styles.typeChipText, { color: active ? colors.primary : colors.mutedForeground }]}>
                      {t(`pipeline.assign.strategies.${st}`)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {assignStrategy === "manual" ? (
              <>
                <Text style={[styles.label, { color: colors.mutedForeground, textAlign, marginTop: 14 }]}>{t("pipeline.assign.owner").toUpperCase()}</Text>
                <View style={[styles.typeWrap, { flexDirection: isRTL ? "row-reverse" : "row", flexWrap: "wrap" }]}>
                  {assignUsers.map((u) => {
                    const active = assignOwnerId === u.id;
                    return (
                      <Pressable
                        key={u.id}
                        onPress={() => setAssignOwnerId(u.id)}
                        style={[
                          styles.typeChip,
                          { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primary + "1A" : colors.background },
                        ]}
                      >
                        <Text style={[styles.typeChipText, { color: active ? colors.primary : colors.mutedForeground }]}>{u.name}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : null}

            {assignStrategy !== "manual" && assignStrategy !== "ai" ? (
              <>
                <Text style={[styles.label, { color: colors.mutedForeground, textAlign, marginTop: 14 }]}>
                  {t("pipeline.assign.team")}
                  {assignTeamRequired ? " *" : ""}
                </Text>
                <View style={[styles.typeWrap, { flexDirection: isRTL ? "row-reverse" : "row", flexWrap: "wrap" }]}>
                  <Pressable
                    onPress={() => setAssignTeamId(null)}
                    style={[
                      styles.typeChip,
                      { borderColor: assignTeamId == null ? colors.primary : colors.border, backgroundColor: assignTeamId == null ? colors.primary + "1A" : colors.background },
                    ]}
                  >
                    <Text style={[styles.typeChipText, { color: assignTeamId == null ? colors.primary : colors.mutedForeground }]}>{t("pipeline.assign.noTeam")}</Text>
                  </Pressable>
                  {assignTeams.map((tm) => {
                    const active = assignTeamId === tm.id;
                    return (
                      <Pressable
                        key={tm.id}
                        onPress={() => setAssignTeamId(tm.id)}
                        style={[
                          styles.typeChip,
                          { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primary + "1A" : colors.background },
                        ]}
                      >
                        <Text style={[styles.typeChipText, { color: active ? colors.primary : colors.mutedForeground }]}>{tm.name}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : null}

            {/* AI recommendation */}
            <View style={[styles.recBox, { borderColor: colors.border, backgroundColor: colors.background }]}>
              <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flexDirection: isRTL ? "row-reverse" : "row", alignItems: "center", gap: 6 }}>
                  <Feather name="zap" size={14} color={colors.primary} />
                  <Text style={[styles.recTitle, { color: colors.foreground }]}>{t("pipeline.assign.recommend")}</Text>
                </View>
                <Pressable
                  onPress={fetchRecommendation}
                  disabled={recommendAssignee.isPending}
                  hitSlop={8}
                  style={({ pressed }) => [styles.sectionAction, { borderColor: colors.primary, opacity: recommendAssignee.isPending ? 0.5 : pressed ? 0.6 : 1 }]}
                >
                  <Text style={[styles.sectionActionText, { color: colors.primary }]}>
                    {recommendAssignee.isPending ? t("pipeline.assign.recommending") : t("pipeline.assign.recommend")}
                  </Text>
                </Pressable>
              </View>
              {recommendation ? (
                <View style={{ marginTop: 10 }}>
                  <Text style={[styles.recName, { color: colors.foreground, textAlign }]}>{recommendation.assignedToName}</Text>
                  {recommendation.reasoning ? (
                    <Text style={[styles.recReason, { color: colors.mutedForeground, textAlign }]}>{recommendation.reasoning}</Text>
                  ) : null}
                  {recommendation.candidates && recommendation.candidates.length > 0 ? (
                    <View style={{ marginTop: 6 }}>
                      <Text style={[styles.label, { color: colors.mutedForeground, textAlign }]}>{t("pipeline.assign.candidates").toUpperCase()}</Text>
                      {recommendation.candidates.map((c) => (
                        <View key={c.id} style={{ flexDirection: isRTL ? "row-reverse" : "row", justifyContent: "space-between", paddingVertical: 3 }}>
                          <Text style={[styles.recReason, { color: colors.foreground }]}>{c.name}{c.jobTitle ? ` · ${c.jobTitle}` : ""}</Text>
                          <Text style={[styles.recReason, { color: colors.mutedForeground }]}>{t("pipeline.assign.openLeads", { count: c.openLeads })}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                  <Pressable
                    onPress={applyRecommendation}
                    disabled={assignLead.isPending}
                    style={({ pressed }) => [styles.submitBtn, { backgroundColor: colors.primary, borderRadius: colors.radius + 4, marginTop: 10, opacity: assignLead.isPending ? 0.5 : pressed ? 0.85 : 1 }]}
                  >
                    <Feather name="check" size={16} color={colors.primaryForeground} />
                    <Text style={[styles.submitBtnText, { color: colors.primaryForeground }]}>{t("pipeline.assign.applyRecommendation")}</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>

            <Pressable
              onPress={submitAssignment}
              disabled={assignLead.isPending}
              style={({ pressed }) => [
                styles.submitBtn,
                { backgroundColor: colors.primary, borderRadius: colors.radius + 4, marginTop: 16, opacity: assignLead.isPending ? 0.5 : pressed ? 0.85 : 1 },
              ]}
            >
              <Feather name="user-check" size={18} color={colors.primaryForeground} />
              <Text style={[styles.submitBtnText, { color: colors.primaryForeground }]}>{t("pipeline.assign.apply")}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  heroCard: {
    padding: 18,
    borderWidth: 1,
  },
  heroTitle: {
    fontSize: 20,
    fontFamily: FONT.bold,
    marginBottom: 4,
  },
  heroValue: {
    fontSize: 26,
    fontFamily: FONT.bold,
    marginBottom: 4,
  },
  probLabel: {
    fontSize: 12,
    fontFamily: FONT.regular,
  },
  probBar: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
  },
  probFill: {
    height: 6,
    borderRadius: 3,
  },
  section: {
    padding: 16,
    borderWidth: 1,
    gap: 12,
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: FONT.semibold,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  linkText: {
    fontSize: 13,
    fontFamily: FONT.semibold,
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  infoLabel: {
    fontSize: 12,
    fontFamily: FONT.regular,
  },
  infoValue: {
    fontSize: 14,
    fontFamily: FONT.medium,
    marginTop: 1,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  actionBtnText: {
    fontSize: 14,
    fontFamily: FONT.semibold,
  },
  emptyInline: {
    fontSize: 13,
    fontFamily: FONT.regular,
    paddingVertical: 4,
  },
  // Tags
  tagWrap: {
    flexWrap: "wrap",
    gap: 8,
  },
  tagChip: {
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  tagDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  tagText: {
    fontSize: 13,
    fontFamily: FONT.medium,
  },
  tagPickRow: {
    alignItems: "center",
    gap: 10,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tagPickText: {
    fontSize: 15,
    fontFamily: FONT.medium,
  },
  // Notes
  noteInputRow: {
    alignItems: "flex-end",
    gap: 8,
  },
  noteInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: FONT.regular,
  },
  noteSendBtn: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  noteRow: {
    paddingVertical: 10,
  },
  noteBody: {
    fontSize: 14,
    fontFamily: FONT.regular,
    lineHeight: 20,
  },
  noteMeta: {
    fontSize: 12,
    fontFamily: FONT.regular,
    marginTop: 4,
  },
  // Timeline
  historyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 10,
  },
  timelineIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  historyField: {
    fontSize: 13,
    fontFamily: FONT.semibold,
  },
  timelineBody: {
    fontSize: 13,
    fontFamily: FONT.regular,
    marginTop: 2,
    lineHeight: 18,
  },
  historyMeta: {
    fontSize: 12,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  modalSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: FONT.bold,
  },
  label: {
    fontSize: 11,
    fontFamily: FONT.semibold,
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: FONT.regular,
  },
  textArea: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: FONT.regular,
    minHeight: 90,
  },
  typeWrap: {
    flexWrap: "wrap",
    gap: 8,
  },
  typeChip: {
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  typeChipText: {
    fontSize: 13,
    fontFamily: FONT.medium,
  },
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 52,
    marginTop: 20,
  },
  submitBtnText: {
    fontSize: 16,
    fontFamily: FONT.semibold,
  },
  sectionAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  sectionActionText: {
    fontSize: 12,
    fontFamily: FONT.semibold,
  },
  recBox: {
    marginTop: 16,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  recTitle: {
    fontSize: 13,
    fontFamily: FONT.semibold,
  },
  recName: {
    fontSize: 15,
    fontFamily: FONT.semibold,
  },
  recReason: {
    fontSize: 12,
    fontFamily: FONT.regular,
    marginTop: 2,
  },
});
