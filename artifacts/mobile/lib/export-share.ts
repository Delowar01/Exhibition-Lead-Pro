import { Platform } from "react-native";

import { createExport, type ExportCreateInput } from "@workspace/api-client-react";

export type ExportEntityType = "contact" | "lead";
export type ExportFormat = "csv" | "excel" | "json";

const EXT: Record<ExportFormat, string> = { csv: "csv", excel: "xlsx", json: "json" };
const MIME: Record<ExportFormat, string> = {
  csv: "text/csv",
  excel: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  json: "application/json",
};

function cleanFilters(filters: Record<string, string | number | undefined | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v == null || v === "" || v === "all") continue;
    out[k] = String(v);
  }
  return out;
}

export interface ExportResult {
  rowCount: number;
  shared: "shared" | "browser" | "none";
}

/**
 * Generate a filtered export via the server export API, then hand the file to the
 * OS share sheet (native) or open it (web). Reuses the same tenant-scoped +
 * permission-gated endpoint as the web app; no data is fabricated client-side.
 */
export async function exportAndShare(
  entityType: ExportEntityType,
  format: ExportFormat,
  filters: Record<string, string | number | undefined | null>,
): Promise<ExportResult> {
  const body: ExportCreateInput = {
    entityType,
    format,
    filters: cleanFilters(filters),
    passwordProtected: false,
    password: null,
  };
  const run = await createExport(body);
  if (run.status === "failed") {
    throw new Error(run.error ?? "Export failed");
  }
  const url = run.downloadUrl;
  if (!url) throw new Error("No download link was returned");
  const rowCount = run.rowCount ?? 0;

  if (Platform.OS === "web") {
    if (typeof window !== "undefined") window.open(url, "_blank");
    return { rowCount, shared: "browser" };
  }

  const Sharing = await import("expo-sharing");
  const FileSystem = await import("expo-file-system/legacy");

  const fileName = run.fileName || `${entityType}s-export.${EXT[format]}`;
  const localUri = `${FileSystem.cacheDirectory}${Date.now()}_${fileName}`;
  const result = await FileSystem.downloadAsync(url, localUri);

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(result.uri, { mimeType: MIME[format] });
    return { rowCount, shared: "shared" };
  }
  return { rowCount, shared: "none" };
}
