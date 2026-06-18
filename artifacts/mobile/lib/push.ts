import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";
import type * as NotificationsModule from "expo-notifications";

import { registerPushToken, unregisterPushToken } from "@workspace/api-client-react";

// expo-notifications push APIs were removed from Expo Go on Android in SDK 53.
// Merely *importing* the module in Expo Go runs its push-token side-effect
// (`DevicePushTokenAutoRegistration.fx`), which logs a red console.error on
// Android, plus a top-level console.warn. We therefore lazily `require` it ONLY
// outside Expo Go, so the app is completely error-free in Expo Go while keeping
// full notification functionality in dev/production native builds.
export const isExpoGo = Constants.executionEnvironment === "storeClient";

export const Notifications: typeof NotificationsModule | null = isExpoGo
  ? null
  : (require("expo-notifications") as typeof NotificationsModule);

// Show notifications while the app is foregrounded too. (Native builds only.)
if (Notifications) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

// The EAS projectId is required to mint a real Expo push token. It is present
// once the app is configured with EAS (app.json extra.eas.projectId) or via the
// EXPO_PUBLIC_EAS_PROJECT_ID env var. Absent in plain Expo Go — we handle that
// honestly by skipping registration rather than faking a token.
function getProjectId(): string | undefined {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId ??
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID
  );
}

/**
 * Requests notification permission and registers an Expo push token with the
 * API. Returns the token on success, or null if registration was skipped
 * (Expo Go, simulator, permission denied, or no EAS projectId configured).
 */
export async function registerForPushNotifications(): Promise<string | null> {
  // Not available in Expo Go (module not loaded) — skip cleanly.
  if (!Notifications) {
    console.log("[push] Skipping registration: not supported in Expo Go");
    return null;
  }

  // Remote push only works on a physical device.
  if (!Device.isDevice) {
    console.log("[push] Skipping registration: not a physical device");
    return null;
  }

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Default",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#FF6B00",
    });
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;
  if (existing !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") {
    console.log("[push] Notification permission not granted");
    return null;
  }

  const projectId = getProjectId();
  if (!projectId) {
    console.log(
      "[push] No EAS projectId configured; skipping push token registration. " +
        "Set EXPO_PUBLIC_EAS_PROJECT_ID (or app.json extra.eas.projectId) and use a dev build to enable.",
    );
    return null;
  }

  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await registerPushToken({ token, platform: Platform.OS === "ios" ? "ios" : "android" });
    return token;
  } catch (err) {
    console.log("[push] Failed to obtain/register Expo push token", err);
    return null;
  }
}

/** Removes the device's push token from the API (e.g. on logout). */
export async function unregisterForPushNotifications(token: string | null): Promise<void> {
  if (!token) return;
  try {
    await unregisterPushToken({ token });
  } catch (err) {
    console.log("[push] Failed to unregister push token", err);
  }
}

/** Extracts a deep-link route from a notification's data payload. */
export function routeForNotificationData(data: unknown): string | null {
  if (data && typeof data === "object" && "contactId" in data) {
    const id = (data as { contactId?: number | string }).contactId;
    if (id != null && id !== "") return `/contact/${id}`;
  }
  return null;
}
