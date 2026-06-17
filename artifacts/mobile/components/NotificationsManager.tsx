import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";

import { useAuth } from "@/contexts/AuthContext";
import {
  registerForPushNotifications,
  routeForNotificationData,
  unregisterForPushNotifications,
} from "@/lib/push";

/**
 * Headless component that manages the push-notification lifecycle:
 * - registers a token on login, unregisters on logout
 * - deep-links to the relevant contact when a notification is tapped
 *   (both warm taps and cold-start launches), once authenticated.
 */
export function NotificationsManager() {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();

  const tokenRef = useRef<string | null>(null);
  const wasAuthed = useRef(false);
  const authedRef = useRef(false);
  const pendingRoute = useRef<string | null>(null);
  const handledColdStart = useRef(false);

  authedRef.current = isAuthenticated;

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
    }
  }, [isAuthenticated, isLoading, router]);

  // Warm taps: app already running in background/foreground.
  // expo-notifications response APIs are native-only (not available on web).
  useEffect(() => {
    if (Platform.OS === "web") return;
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      navigate(routeForNotificationData(response.notification.request.content.data));
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cold start: app launched by tapping a notification while killed.
  useEffect(() => {
    if (Platform.OS === "web") return;
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
