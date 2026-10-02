/**
 * B25 Correction 1 — private product files (documents, exports, reports) are
 * served by the API only to the CURRENTLY authenticated user. Their URLs carry
 * no credential, so every byte request must send the normal session token
 * (and uploads the header-bound upload capability). Nothing here opens a bare
 * private URL in a browser: bytes are downloaded to the app cache with auth
 * and then shared / saved / opened from the local file.
 */
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

import { getCachedToken } from "./auth-storage";

export const CAPABILITY_HEADER = "X-Storage-Capability";

/** Authorization header for private byte requests (empty when signed out). */
export function privateFileHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getCachedToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

/** Download a private file to a cache path with the session (native only). */
export async function downloadPrivateFile(url: string, localUri: string): Promise<{ uri: string; status: number }> {
  const result = await FileSystem.downloadAsync(url, localUri, { headers: privateFileHeaders() });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Download failed (${result.status})`);
  }
  return { uri: result.uri, status: result.status };
}

/** Web platform: fetch a private file as a Blob with the session. */
export async function fetchPrivateBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { headers: privateFileHeaders() });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return res.blob();
}

/** Web platform: open/download a private file through an object URL (never the bare URL). */
export async function openPrivateBlobInBrowser(url: string): Promise<void> {
  if (typeof window === "undefined") return;
  const blob = await fetchPrivateBlob(url);
  const objUrl = URL.createObjectURL(blob);
  window.open(objUrl, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
}

/** PUT raw upload bytes with the session + header-bound capability (native streams from disk, web sends a blob). */
export async function putPrivateUpload(uploadURL: string, uploadToken: string, fileUri: string, contentType: string): Promise<void> {
  const headers = privateFileHeaders({ "Content-Type": contentType, [CAPABILITY_HEADER]: uploadToken });
  if (Platform.OS === "web") {
    const resp = await fetch(fileUri);
    const blob = await resp.blob();
    const put = await fetch(uploadURL, { method: "PUT", body: blob, headers });
    if (!put.ok) throw new Error(`Upload failed (${put.status})`);
    return;
  }
  const res = await FileSystem.uploadAsync(uploadURL, fileUri, {
    httpMethod: "PUT",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Upload failed (${res.status})`);
  }
}
