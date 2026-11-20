// Phase 2 Batch 1 — the device side of lib/scan-files.ts: offline scan images
// in the app's PRIVATE document directory (not the cache, which the OS may
// clear; not shared storage, which other apps can read). One sub-directory per
// account; see lib/scan-files.ts for the rules.
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

import { SCAN_DIR_NAME, createScanFileStore, type ScanFileDriver, type ScanFileStore } from "./scan-files";

const expoDriver: ScanFileDriver = {
  root() {
    // The web preview has no document directory: scans stay inline there.
    if (Platform.OS === "web") return null;
    const base = FileSystem.documentDirectory;
    return base ? `${base}${SCAN_DIR_NAME}/` : null;
  },
  async ensureDir(uri) {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) return;
    await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
  },
  async writeBase64(uri, base64) {
    await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
  },
  async readBase64(uri) {
    return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  },
  async move(from, to) {
    await FileSystem.moveAsync({ from, to });
  },
  async remove(uri) {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  },
  async size(uri) {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists || info.isDirectory) return null;
    return typeof info.size === "number" ? info.size : null;
  },
  async list(uri) {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return [];
    return FileSystem.readDirectoryAsync(uri);
  },
  async freeBytes() {
    const free = await FileSystem.getFreeDiskStorageAsync();
    return typeof free === "number" && Number.isFinite(free) ? free : null;
  },
};

/** The one file store of the app (offline scan images). */
export const scanFiles: ScanFileStore = createScanFileStore(expoDriver);
