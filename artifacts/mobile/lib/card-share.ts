import { Platform } from "react-native";
import type { RefObject } from "react";
import type { View } from "react-native";

export type ShareFormat = "jpeg" | "png";

export interface ShareCardOptions {
  format?: ShareFormat;
  quality?: number;
  width?: number;
}

// Gracefully detect environments where native capture is unavailable.
// On Expo Go (appOwnership === "expo") or web, we cannot use react-native-view-shot.
function isNativeBuildAvailable(): boolean {
  if (Platform.OS === "web") return false;
  try {
    // expo-constants is always present; access appOwnership to detect Expo Go.
    const Constants = require("expo-constants").default as {
      appOwnership?: string | null;
    };
    if (Constants.appOwnership === "expo") return false;
  } catch {
    // If expo-constants is unavailable for some reason, assume native is fine.
  }
  return true;
}

/**
 * Captures the React Native view referenced by `captureRef` as a JPEG (or
 * other format), opens the OS share sheet with the image file attached, and
 * deletes the temp file once the sheet is dismissed.
 *
 * The `format` option is intentionally surfaced so callers can later pass
 * `"png"` or `"pdf"` without any changes to this module's internals.
 *
 * Throws a descriptive error on unsupported environments (Expo Go / web) so
 * the caller can show a graceful alert instead of crashing.
 */
export async function shareCardAsJpeg(
  captureRef: RefObject<View | null>,
  options: ShareCardOptions = {},
): Promise<void> {
  const { format = "jpeg", quality = 1, width = 1080 } = options;

  if (!isNativeBuildAvailable()) {
    throw new Error(
      "Image sharing requires a full app build — QR scanning and link sharing still work normally.",
    );
  }

  if (!captureRef.current) {
    throw new Error("Card view is not ready. Please try again.");
  }

  // Dynamic imports keep these heavy native modules out of the web/Expo-Go bundle.
  const { captureRef: captureViewRef } = await import("react-native-view-shot");
  const Sharing = await import("expo-sharing");
  // expo-file-system@19 (SDK 54) made the class-based API the default export;
  // the functional helpers (deleteAsync, etc.) now live under the /legacy entry.
  const FileSystem = await import("expo-file-system/legacy");

  const isAvailable = await Sharing.isAvailableAsync();
  if (!isAvailable) {
    throw new Error("Sharing is not available on this device.");
  }

  // react-native-view-shot uses "jpg" not "jpeg"
  const viewShotFormat = format === "jpeg" ? "jpg" : format;

  const uri = await captureViewRef(captureRef, {
    format: viewShotFormat,
    quality,
    result: "tmpfile",
    width,
    snapshotContentContainer: false,
  });

  try {
    await Sharing.shareAsync(uri, {
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      dialogTitle: "Share business card",
      UTI: format === "jpeg" ? "public.jpeg" : "public.png",
    });
  } finally {
    // Clean up temp file regardless of whether sharing succeeded or was dismissed.
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch {
      // Non-critical — temp file will eventually be cleared by the OS.
    }
  }
}
