import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";

import {
  getListFollowUpsQueryKey,
  getListMeetingsQueryKey,
  useListFollowUps,
  useListMeetings,
} from "@workspace/api-client-react";

import { useAuth } from "@/contexts/AuthContext";
import { useSettings } from "@/contexts/SettingsContext";
import {
  cancelAllFollowUpReminders,
  cancelAllMeetingReminders,
  rescheduleAllFromServer,
  scheduleFollowUpReminder,
  scheduleMeetingReminder,
} from "@/lib/notifications";
import {
  Notifications,
  registerForPushNotifications,
  routeForNotificationData,
  unregisterForPushNotifications,
} from "@/lib/push";

/**
 * Headless component that manages the push-notification lifecycle:
 * - registers a token on login, unregisters on logout
 * - deep-links to the relevant contact when a notification is tapped
 *   (both warm taps and cold-start launches), once authenticated.
 * - schedules / cancels local meeting and follow-up reminders in response
 *   to login events and settings toggle changes.
 */
export function NotificationsManager() {
  const { isAuthenticated, isLoading } = useAuth();
  const settings = useSettings();
  const router = useRouter();

  const tokenRef = useRef<string | null>(null);
  const wasAuthed = useRef(false);
  const authedRef = useRef(false);
  const pendingRoute = useRef<string | null>(null);
  const handledColdStart = useRef(false);

  // Local-notification lifecycle tracking
  const didInitNotif = useRef(false);
  const prevMeetingReminders = useRef(settings.meetingReminders);
  const prevFollowUpNotifications = useRef(settings.followUpNotifications);

  authedRef.current = isAuthenticated;

  // Fetch scheduled meetings and pending follow-ups for local notification
  // scheduling. Queries are disabled until the user is authenticated.
  const meetingParams = { status: "scheduled" };
  const followUpParams = { status: "pending" };

  const meetingsQuery = useListMeetings(meetingParams, {
    query: {
      enabled: isAuthenticated,
      queryKey: getListMeetingsQueryKey(meetingParams),
    },
  });
  const followUpsQuery = useListFollowUps(followUpParams, {
    query: {
      enabled: isAuthenticated,
      queryKey: getListFollowUpsQueryKey(followUpParams),
    },
  });

  const navigate = (route: string | null) => {
    if (!route) return;
    if (authedRef.current) {
      router.push(route as never);
    } else {
      // Defer until the user is authenticated (post-login).
      pendingRoute.current = route;
    }
  };

  // Register on login; unregister on logout. Flush any deferred deep-link.
  useEffect(() => {
    if (isLoading) return;
    if (isAuthenticated && !wasAuthed.current) {
      wasAuthed.current = true;
      registerForPushNotifications().then((t) => {
        tokenRef.current = t;
      });
      if (pendingRoute.current) {
        const route = pendingRoute.current;
        pendingRoute.current = null;
        router.push(route as never);
      }
    } else if (!isAuthenticated && wasAuthed.current) {
      wasAuthed.current = false;
      const t = tokenRef.current;
      tokenRef.current = null;
      void unregisterForPushNotifications(t);
      // Reset local notification state so the next login re-schedules cleanly.
      didInitNotif.current = false;
      prevMeetingReminders.current = settings.meetingReminders;
      prevFollowUpNotifications.current = settings.followUpNotifications;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, isLoading, router]);

  // Reschedule all local notifications once, right after login, when both
  // meetings and follow-ups data have loaded for the first time in this session.
  useEffect(() => {
    if (!isAuthenticated || !settings.isLoaded) return;
    if (!meetingsQuery.isSuccess || !followUpsQuery.isSuccess) return;
    if (didInitNotif.current) return;

    didInitNotif.current = true;
    prevMeetingReminders.current = settings.meetingReminders;
    prevFollowUpNotifications.current = settings.followUpNotifications;

    void rescheduleAllFromServer(
      meetingsQuery.data.meetings,
      followUpsQuery.data.followUps,
      {
        meetingReminders: settings.meetingReminders,
        followUpNotifications: settings.followUpNotifications,
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isAuthenticated,
    settings.isLoaded,
    meetingsQuery.isSuccess,
    followUpsQuery.isSuccess,
  ]);

  // React to toggle changes after the initial reschedule is done.
  // Toggle off → cancel all of that type immediately.
  // Toggle on  → re-schedule from the currently cached query data.
  useEffect(() => {
    if (!didInitNotif.current) return;

    const mrChanged = settings.meetingReminders !== prevMeetingReminders.current;
    const fuChanged = settings.followUpNotifications !== prevFollowUpNotifications.current;
    prevMeetingReminders.current = settings.meetingReminders;
    prevFollowUpNotifications.current = settings.followUpNotifications;

    if (mrChanged) {
      if (!settings.meetingReminders) {
        void cancelAllMeetingReminders();
      } else {
        const meetings = meetingsQuery.data?.meetings ?? [];
        void Promise.all(meetings.map((m) => scheduleMeetingReminder(m)));
      }
    }

    if (fuChanged) {
      if (!settings.followUpNotifications) {
        void cancelAllFollowUpReminders();
      } else {
        const followUps = followUpsQuery.data?.followUps ?? [];
        void Promise.all(followUps.map((fu) => scheduleFollowUpReminder(fu)));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.meetingReminders, settings.followUpNotifications]);

  // Warm taps: app already running in background/foreground.
  // Notifications is null on web and in Expo Go (module not loaded), so skip.
  useEffect(() => {
    if (Platform.OS === "web" || !Notifications) return;
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      navigate(routeForNotificationData(response.notification.request.content.data));
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cold start: app launched by tapping a notification while killed.
  useEffect(() => {
    if (Platform.OS === "web" || !Notifications) return;
    if (handledColdStart.current) return;
    handledColdStart.current = true;
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      navigate(routeForNotificationData(response.notification.request.content.data));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
