import { Feather } from "@/components/icons";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
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

import {
  getListUsersQueryKey,
  type ListTasksScope,
  type Task,
  type TaskInputType,
  type TaskStatus,
  useCreateTask,
  useDeleteTask,
  useListTasks,
  useListUsers,
  useUpdateTask,
} from "@workspace/api-client-react";

import { DateTimeField } from "@/components/DateTimeField";
import {
  Avatar,
  Badge,
  EmptyState,
  ErrorState,
  FONT,
  LoadingState,
  prettyLabel,
  TASK_STATUS_COLORS,
  TASK_TYPE_ICONS,
} from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import { useColors } from "@/hooks/useColors";
import { formatGregorian } from "@/lib/date";

const STATUS_FILTERS: { key: TaskStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "in_progress", label: "In progress" },
  { key: "completed", label: "Completed" },
  { key: "overdue", label: "Overdue" },
];

const TASK_TYPES: TaskInputType[] = ["call", "follow_up", "meeting", "proposal", "custom"];

function parseLocal(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function formatDate(s?: string | null, time?: string | null): string {
  if (!s) return "No due date";
  const base = formatGregorian(parseLocal(s), {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  if (!time) return base;
  const [h, m] = time.split(":").map((p) => parseInt(p, 10));
  const period = h >= 12 ? "PM" : "AM";
  const hr12 = h % 12 === 0 ? 12 : h % 12;
  return `${base} · ${hr12}:${String(m).padStart(2, "0")} ${period}`;
}

export default function TasksScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const canManageAll =
    user?.role === "platform_owner" ||
    user?.role === "primary_admin" ||
    user?.role === "admin";

  const [scope, setScope] = useState<ListTasksScope>("mine");
  const [status, setStatus] = useState<TaskStatus | "all">("all");
  const [active, setActive] = useState<Task | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const query = useListTasks({
    scope,
    ...(status !== "all" ? { status } : {}),
  });
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);
  const tasks = query.data?.tasks ?? [];

  const sorted = useMemo(
    () =>
      [...tasks].sort((a, b) => (a.dueDate ?? "9999") < (b.dueDate ?? "9999") ? -1 : 1),
    [tasks],
  );

  function renderItem(t: Task) {
    const statusColor = TASK_STATUS_COLORS[t.status] ?? colors.mutedForeground;
    return (
      <Pressable
        key={t.id}
        onPress={() => {
          if (Platform.OS !== "web") Haptics.selectionAsync();
          setActive(t);
        }}
        style={({ pressed }) => [
          styles.item,
          { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius + 4, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <View style={[styles.typeIcon, { backgroundColor: statusColor + "1A" }]}>
          <Feather name={TASK_TYPE_ICONS[t.type] ?? "check-square"} size={18} color={statusColor} />
        </View>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={[styles.itemName, { color: colors.foreground }]}>
            {t.title}
          </Text>
          {t.contactName ? (
            <Text numberOfLines={1} style={[styles.itemSub, { color: colors.mutedForeground }]}>
              {t.contactName}
            </Text>
          ) : null}
          <View style={styles.itemMeta}>
            <Feather name="clock" size={12} color={colors.mutedForeground} />
            <Text style={[styles.itemDate, { color: colors.mutedForeground }]}>
              {formatDate(t.dueDate, t.dueTime)}
            </Text>
            <Badge label={prettyLabel(t.status)} color={statusColor} />
            {scope === "all" && t.assignedToName ? (
              <Badge label={t.assignedToName} color={colors.mutedForeground} />
            ) : null}
          </View>
        </View>
        <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
      </Pressable>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingTop: topPad + 14, paddingHorizontal: 20 }}>
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            <Pressable
              onPress={() => router.back()}
              hitSlop={10}
              style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <Feather name="arrow-left" size={20} color={colors.foreground} />
            </Pressable>
            <Text style={[styles.heading, { color: colors.foreground }]}>Tasks</Text>
          </View>
          <Pressable
            onPress={() => {
              if (Platform.OS !== "web") Haptics.selectionAsync();
              setCreateOpen(true);
            }}
            style={[styles.addBtn, { backgroundColor: colors.primary }]}
          >
            <Feather name="plus" size={20} color="#FFFFFF" />
          </Pressable>
        </View>

        {canManageAll ? (
          <View style={[styles.scopeBar, { backgroundColor: colors.muted, borderRadius: colors.radius }]}>
            {(["mine", "all"] as ListTasksScope[]).map((s) => {
              const isActive = scope === s;
              return (
                <Pressable
                  key={s}
                  onPress={() => {
                    if (Platform.OS !== "web") Haptics.selectionAsync();
                    setScope(s);
                  }}
                  style={[styles.scopeTab, isActive && { backgroundColor: colors.card, borderRadius: colors.radius - 2 }]}
                >
                  <Text style={[styles.scopeText, { color: isActive ? colors.foreground : colors.mutedForeground }]}>
                    {s === "mine" ? "Assigned to me" : "All tasks"}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingVertical: 12 }}
        >
          {STATUS_FILTERS.map((f) => {
            const isActive = status === f.key;
            return (
              <Pressable
                key={f.key}
                onPress={() => setStatus(f.key)}
                style={[
                  styles.chip,
                  { backgroundColor: isActive ? colors.primary : colors.card, borderColor: isActive ? colors.primary : colors.border },
                ]}
              >
                <Text style={[styles.chipText, { color: isActive ? "#FFFFFF" : colors.foreground }]}>
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {query.isLoading ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : sorted.length === 0 ? (
        <View style={{ flex: 1 }}>
          <EmptyState
            icon="check-square"
            title="No tasks"
            subtitle="Create a task to keep track of your to-dos."
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: insets.bottom + 40, gap: 10 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={query.isRefetching} onRefresh={() => query.refetch()} tintColor={colors.primary} />
          }
        >
          {sorted.map(renderItem)}
        </ScrollView>
      )}

      <TaskActionSheet
        task={active}
        pending={updateTask.isPending || deleteTask.isPending}
        onClose={() => setActive(null)}
        onStatus={async (s) => {
          if (Platform.OS !== "web") Haptics.selectionAsync();
          await updateTask.mutateAsync({ id: active!.id, data: { status: s } });
          setActive(null);
          query.refetch();
        }}
        onDelete={async () => {
          if (Platform.OS !== "web")
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          await deleteTask.mutateAsync({ id: active!.id });
          setActive(null);
          query.refetch();
        }}
      />

      <CreateTaskSheet
        open={createOpen}
        canAssign={canManageAll}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          query.refetch();
        }}
      />
    </View>
  );
}

function TaskActionSheet({
  task,
  onClose,
  onStatus,
  onDelete,
  pending,
}: {
  task: Task | null;
  onClose: () => void;
  onStatus: (s: TaskStatus) => void;
  onDelete: () => void;
  pending: boolean;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const statuses: { status: TaskStatus; label: string; icon: keyof typeof Feather.glyphMap }[] = [
    { status: "pending", label: "Pending", icon: "circle" },
    { status: "in_progress", label: "In progress", icon: "loader" },
    { status: "completed", label: "Completed", icon: "check-circle" },
  ];

  return (
    <Modal visible={!!task} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: colors.background, borderColor: colors.border, paddingBottom: insets.bottom + 16 }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
          </View>
          <Text style={[styles.sheetTitle, { color: colors.foreground }]}>{task?.title}</Text>
          <View style={{ gap: 10, marginTop: 12 }}>
            {statuses.map((s) => {
              const isCurrent = task?.status === s.status;
              const color = TASK_STATUS_COLORS[s.status] ?? colors.foreground;
              return (
                <Pressable
                  key={s.status}
                  disabled={pending || isCurrent}
                  onPress={() => onStatus(s.status)}
                  style={({ pressed }) => [
                    styles.actionRow,
                    { backgroundColor: colors.card, borderColor: isCurrent ? color : colors.border, borderRadius: colors.radius, opacity: pressed ? 0.7 : 1 },
                  ]}
                >
                  <Feather name={s.icon} size={20} color={color} />
                  <Text style={[styles.actionLabel, { color: colors.foreground }]}>{s.label}</Text>
                  {isCurrent ? <Feather name="check" size={18} color={color} /> : null}
                </Pressable>
              );
            })}
            <Pressable
              disabled={pending}
              onPress={onDelete}
              style={({ pressed }) => [
                styles.actionRow,
                { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Feather name="trash-2" size={20} color={colors.destructive} />
              <Text style={[styles.actionLabel, { color: colors.destructive }]}>Delete task</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function CreateTaskSheet({
  open,
  canAssign,
  onClose,
  onCreated,
}: {
  open: boolean;
  canAssign: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const createTask = useCreateTask();
  const usersQuery = useListUsers(
    { limit: 100 },
    { query: { enabled: open && canAssign, queryKey: getListUsersQueryKey({ limit: 100 }) } },
  );

  const [title, setTitle] = useState("");
  const [type, setType] = useState<TaskInputType>("custom");
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [dueTime, setDueTime] = useState<string | null>(null);
  const [assignedToId, setAssignedToId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");

  function reset() {
    setTitle("");
    setType("custom");
    setDueDate(null);
    setDueTime(null);
    setAssignedToId(null);
    setNotes("");
  }

  const users = usersQuery.data?.users ?? [];

  async function submit() {
    if (!title.trim()) return;
    if (Platform.OS !== "web")
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await createTask.mutateAsync({
      data: {
        title: title.trim(),
        type,
        dueDate,
        dueTime,
        notes: notes.trim() || null,
        ...(assignedToId ? { assignedToId } : {}),
      },
    });
    reset();
    onCreated();
  }

  return (
    <Modal
      visible={open}
      transparent
      animationType="slide"
      onRequestClose={() => {
        reset();
        onClose();
      }}
    >
      <Pressable
        style={styles.backdrop}
        onPress={() => {
          reset();
          onClose();
        }}
      >
        <Pressable
          style={[styles.sheet, { backgroundColor: colors.background, borderColor: colors.border, paddingBottom: insets.bottom + 16 }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.handleWrap}>
            <View style={[styles.handle, { backgroundColor: colors.border }]} />
          </View>
          <Text style={[styles.sheetTitle, { color: colors.foreground }]}>New Task</Text>

          <ScrollView style={{ maxHeight: 460 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 12 }}>
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>TITLE</Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="What needs to be done?"
              placeholderTextColor={colors.mutedForeground}
              style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, borderRadius: colors.radius }]}
            />

            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>TYPE</Text>
            <View style={styles.chipWrap}>
              {TASK_TYPES.map((t) => {
                const isActive = type === t;
                return (
                  <Pressable
                    key={t}
                    onPress={() => setType(t)}
                    style={[styles.chip, { backgroundColor: isActive ? colors.primary : colors.card, borderColor: isActive ? colors.primary : colors.border }]}
                  >
                    <Feather
                      name={TASK_TYPE_ICONS[t] ?? "check-square"}
                      size={13}
                      color={isActive ? "#FFFFFF" : colors.foreground}
                    />
                    <Text style={[styles.chipText, { color: isActive ? "#FFFFFF" : colors.foreground, marginLeft: 5 }]}>
                      {prettyLabel(t)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={{ marginTop: 16 }}>
              <DateTimeField
                label="Due date & time"
                date={dueDate}
                time={dueTime}
                optional
                minToday
                onChange={(d, t) => {
                  setDueDate(d);
                  setDueTime(t);
                }}
              />
            </View>

            {canAssign ? (
              <>
                <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>ASSIGN TO</Text>
                <View style={styles.chipWrap}>
                  <Pressable
                    onPress={() => setAssignedToId(null)}
                    style={[styles.chip, { backgroundColor: !assignedToId ? colors.primary : colors.card, borderColor: !assignedToId ? colors.primary : colors.border }]}
                  >
                    <Text style={[styles.chipText, { color: !assignedToId ? "#FFFFFF" : colors.foreground }]}>Me</Text>
                  </Pressable>
                  {users.map((u) => {
                    const isActive = assignedToId === u.id;
                    return (
                      <Pressable
                        key={u.id}
                        onPress={() => setAssignedToId(u.id)}
                        style={[styles.chip, { backgroundColor: isActive ? colors.primary : colors.card, borderColor: isActive ? colors.primary : colors.border }]}
                      >
                        <Text style={[styles.chipText, { color: isActive ? "#FFFFFF" : colors.foreground }]}>{u.name}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : null}

            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>NOTES (OPTIONAL)</Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="Extra details"
              placeholderTextColor={colors.mutedForeground}
              multiline
              style={[styles.commentInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground, borderRadius: colors.radius }]}
            />
          </ScrollView>

          <Pressable
            disabled={createTask.isPending || !title.trim()}
            onPress={submit}
            style={[styles.applyBtn, { backgroundColor: title.trim() ? colors.primary : colors.muted }]}
          >
            <Text style={styles.applyText}>{createTask.isPending ? "Creating…" : "Create task"}</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 12 },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  heading: { fontSize: 28, fontFamily: FONT.bold },
  addBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  scopeBar: { flexDirection: "row", padding: 4, marginTop: 14 },
  scopeTab: { flex: 1, paddingVertical: 8, alignItems: "center" },
  scopeText: { fontSize: 13.5, fontFamily: FONT.semibold },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  chipText: { fontSize: 13.5, fontFamily: FONT.medium },
  item: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderWidth: 1 },
  typeIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  itemName: { fontSize: 15.5, fontFamily: FONT.semibold },
  itemSub: { fontSize: 13, fontFamily: FONT.regular, marginTop: 1 },
  itemMeta: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 6 },
  itemDate: { fontSize: 12.5, fontFamily: FONT.medium, marginRight: 4 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  handleWrap: { alignItems: "center", paddingVertical: 8 },
  handle: { width: 40, height: 4, borderRadius: 2 },
  sheetTitle: { fontSize: 18, fontFamily: FONT.bold },
  actionRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderWidth: 1 },
  actionLabel: { flex: 1, fontSize: 15.5, fontFamily: FONT.medium },
  fieldLabel: { fontSize: 11.5, fontFamily: FONT.semibold, letterSpacing: 0.5, marginTop: 16, marginBottom: 8 },
  input: {
    borderWidth: 1,
    paddingHorizontal: 14,
    height: 48,
    fontSize: 15,
    fontFamily: FONT.regular,
  },
  commentInput: {
    borderWidth: 1,
    padding: 12,
    minHeight: 70,
    fontSize: 14.5,
    fontFamily: FONT.regular,
    textAlignVertical: "top",
  },
  applyBtn: { marginTop: 14, height: 52, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  applyText: { color: "#FFFFFF", fontSize: 16, fontFamily: FONT.semibold },
});
