import { Platform } from "react-native";

import type { FollowUp, Meeting } from "@workspace/api-client-react";

import { Notifications } from "@/lib/push";

const MTG_PREFIX = "mtg-";
const FU_PREFIX = "fu-";

function mtgId(id: number): string {
  return `${MTG_PREFIX}${id}`;
}

function fuId(id: number): string {
  return `${FU_PREFIX}${id}`;
}

/**
 * Build a JS Date from a YYYY-MM-DD string + optional HH:MM time string.
 * Parsed as local time (not UTC) to match the date-only convention used
 * throughout the app (see replit.md gotchas re: parseISO).
 */
function buildLocalDate(date: string, time?: string | null): Date {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  if (time) {
    const [h, min] = time.split(":").map(Number);
    dt.setHours(h ?? 9, min ?? 0, 0, 0);
  } else {
    dt.setHours(9, 0, 0, 0);
  }
  return dt;
}

async function ensurePermission(
  notif: NonNullable<typeof Notifications>,
): Promise<boolean> {
  const { status } = await notif.getPermissionsAsync();
  if (status === "granted") return true;
  const { status: asked } = await notif.requestPermissionsAsync();
  return asked === "granted";
}

function meetingBody(meeting: Meeting): string {
  const parts: string[] = [];
  if (meeting.type) parts.push(meeting.type.replace(/_/g, " "));
  if (meeting.meetingTime) {
    const [h, min] = meeting.meetingTime.split(":").map(Number);
    const period = (h ?? 0) >= 12 ? "PM" : "AM";
    const hr12 = (h ?? 0) % 12 === 0 ? 12 : (h ?? 0) % 12;
    parts.push(`${hr12}:${String(min ?? 0).padStart(2, "0")} ${period}`);
  }
  return parts.join(" · ") || "Meeting starting soon";
}

/**
 * Schedule a local notification 15 minutes before the meeting starts.
 * No-ops when Notifications is null (Expo Go / web), meeting is not
 * scheduled, has no date, or the fire time is already in the past.
 * Always cancels any existing notification for this meeting ID first.
 */
export async function scheduleMeetingReminder(meeting: Meeting): Promise<void> {
  const notif = Notifications;
  if (!notif || Platform.OS === "web") return;
  await notif.cancelScheduledNotificationAsync(mtgId(meeting.id)).catch(() => {});

  if (meeting.status !== "scheduled" || !meeting.meetingDate) return;

  const meetingAt = buildLocalDate(meeting.meetingDate, meeting.meetingTime);
  const fireAt = new Date(meetingAt.getTime() - 15 * 60 * 1000);
  if (fireAt <= new Date()) return;

  const ok = await ensurePermission(notif);
  if (!ok) return;

  await notif
    .scheduleNotificationAsync({
      identifier: mtgId(meeting.id),
      content: {
        title: meeting.contactName ?? "Meeting reminder",
        body: meetingBody(meeting),
        data: { type: "meeting", contactId: meeting.contactId },
      },
      trigger: {
        type: notif.SchedulableTriggerInputTypes.DATE,
        date: fireAt,
      },
    })
    .catch(() => {});
}

/**
 * Cancel any pending notification for the given meeting.
 */
export async function cancelMeetingReminder(meetingId: number): Promise<void> {
  const notif = Notifications;
  if (!notif || Platform.OS === "web") return;
  await notif.cancelScheduledNotificationAsync(mtgId(meetingId)).catch(() => {});
}

/**
 * Schedule a local notification at the follow-up's due time.
 * No-ops when Notifications is null, status is not pending, no date set,
 * or the due time is already in the past.
 * Always cancels any existing notification for this follow-up ID first.
 */
export async function scheduleFollowUpReminder(followUp: FollowUp): Promise<void> {
  const notif = Notifications;
  if (!notif || Platform.OS === "web") return;
  await notif.cancelScheduledNotificationAsync(fuId(followUp.id)).catch(() => {});

  if (followUp.status !== "pending" || !followUp.scheduledDate) return;

  const fireAt = buildLocalDate(followUp.scheduledDate, followUp.scheduledTime);
  if (fireAt <= new Date()) return;

  const ok = await ensurePermission(notif);
  if (!ok) return;

  await notif
    .scheduleNotificationAsync({
      identifier: fuId(followUp.id),
      content: {
        title: followUp.contactName ?? "Follow-up reminder",
        body: followUp.notes?.trim() || "You have a follow-up due",
        data: { type: "followup", contactId: followUp.contactId },
      },
      trigger: {
        type: notif.SchedulableTriggerInputTypes.DATE,
        date: fireAt,
      },
    })
    .catch(() => {});
}

/**
 * Cancel any pending notification for the given follow-up.
 */
export async function cancelFollowUpReminder(followUpId: number): Promise<void> {
  const notif = Notifications;
  if (!notif || Platform.OS === "web") return;
  await notif.cancelScheduledNotificationAsync(fuId(followUpId)).catch(() => {});
}

/**
 * Cancel all app-managed meeting reminders (identifiers starting with "mtg-").
 */
export async function cancelAllMeetingReminders(): Promise<void> {
  const notif = Notifications;
  if (!notif || Platform.OS === "web") return;
  const all = await notif.getAllScheduledNotificationsAsync().catch(() => []);
  await Promise.all(
    all
      .filter((n) => n.identifier.startsWith(MTG_PREFIX))
      .map((n) => notif.cancelScheduledNotificationAsync(n.identifier).catch(() => {})),
  );
}

/**
 * Cancel all app-managed follow-up reminders (identifiers starting with "fu-").
 */
export async function cancelAllFollowUpReminders(): Promise<void> {
  const notif = Notifications;
  if (!notif || Platform.OS === "web") return;
  const all = await notif.getAllScheduledNotificationsAsync().catch(() => []);
  await Promise.all(
    all
      .filter((n) => n.identifier.startsWith(FU_PREFIX))
      .map((n) => notif.cancelScheduledNotificationAsync(n.identifier).catch(() => {})),
  );
}

/**
 * Bulk-cancel all app notifications then reschedule from live server data,
 * honoring the current toggle settings. Called on login and on toggle-on.
 */
export async function rescheduleAllFromServer(
  meetings: Meeting[],
  followUps: FollowUp[],
  settings: { meetingReminders: boolean; followUpNotifications: boolean },
): Promise<void> {
  if (!Notifications || Platform.OS === "web") return;

  await cancelAllMeetingReminders();
  await cancelAllFollowUpReminders();

  if (settings.meetingReminders) {
    for (const m of meetings) {
      await scheduleMeetingReminder(m);
    }
  }
  if (settings.followUpNotifications) {
    for (const fu of followUps) {
      await scheduleFollowUpReminder(fu);
    }
  }
}
