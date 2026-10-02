/**
 * B25 Correction 1 / 6 — private product files (documents, exports, reports).
 *
 * The B25 API serves them only to the CURRENTLY authenticated user through
 * first-party `/api/files/*` routes: every byte request sends the session
 * token and uploads add the header-bound upload capability. Nothing here opens
 * a bare private URL in a browser: bytes are downloaded to the app cache with
 * auth and then shared / saved / opened from the local file.
 *
 * Correction 6 — the SAME build must keep working if the API is rolled back
 * to the pre-B25 release (5a072fd), which returns V4-signed Google Cloud
 * Storage URLs and no `uploadToken`. Every URL therefore goes through ONE
 * classifier (lib/file-urls.ts) before any request:
 *   • first party        → bearer (+ capability for uploads), exact API origin only;
 *   • legacy signed GCS  → direct signed GET / PUT, NO Lead Capture credential,
 *                          NO capability header, signed query preserved;
 *   • anything else      → refused before a network request.
 * The B25 server contract is unchanged (uploadToken stays required there); the
 * absence of the field is handled here at runtime only.
 */
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";
import { getBaseUrl } from "@workspace/api-client-react";

import { getCachedToken } from "./auth-storage";
import { CAPABILITY_HEADER, classifyFileUrl, fileRequestHeaders, type ClassifiedFileUrl } from "./file-urls";

export { CAPABILITY_HEADER };

type Trusted = Exclude<ClassifiedFileUrl, { kind: "rejected" }>;

/** Classify against the configured API origin and build the headers; throws a fixed error before any request when refused. */
function prepare(url: string, op: "get" | "put", extra: { uploadToken?: string | null; contentType?: string } = {}): { target: Trusted; headers: Record<string, string> } {
  const classified = classifyFileUrl(url, getBaseUrl());
  const headers = fileRequestHeaders(classified, op, { sessionToken: getCachedToken(), ...extra });
  return { target: classified as Trusted, headers };
}

/** Download a private file to a cache path (native only). */
export async function downloadPrivateFile(url: string, localUri: string): Promise<{ uri: string; status: number }> {
  const { target, headers } = prepare(url, "get");
  const result = await FileSystem.downloadAsync(target.url, localUri, { headers });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Download failed (${result.status})`);
  }
  return { uri: result.uri, status: result.status };
}

/** Web platform: fetch a private file as a Blob. */
export async function fetchPrivateBlob(url: string): Promise<Blob> {
  const { target, headers } = prepare(url, "get");
  const res = await fetch(target.url, { headers });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return res.blob();
}

/**
 * Web platform: open/download a private file. First-party bytes are fetched
 * with the session and handed to the browser as an object URL (never the bare
 * URL); a legacy signed GCS URL is itself the short-lived capability and is
 * opened directly, exactly as the pre-B25 client did — after classification.
 */
export async function openPrivateBlobInBrowser(url: string): Promise<void> {
  if (typeof window === "undefined") return;
  const { target } = prepare(url, "get");
  if (target.kind === "legacy_signed_gcs") {
    window.open(target.url, "_blank", "noopener,noreferrer");
    return;
  }
  const blob = await fetchPrivateBlob(url);
  const objUrl = URL.createObjectURL(blob);
  window.open(objUrl, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
}

/**
 * PUT raw upload bytes (native streams from disk, web sends a blob).
 * `uploadToken` is mandatory for a first-party target and ignored (never sent)
 * for a legacy signed GCS target, whose pre-B25 response does not carry it.
 */
export async function putPrivateUpload(uploadURL: string, uploadToken: string | null | undefined, fileUri: string, contentType: string): Promise<void> {
  const { target, headers } = prepare(uploadURL, "put", { uploadToken, contentType });
  if (Platform.OS === "web") {
    const resp = await fetch(fileUri);
    const blob = await resp.blob();
    const put = await fetch(target.url, { method: "PUT", body: blob, headers });
    if (!put.ok) throw new Error(`Upload failed (${put.status})`);
    return;
  }
  const res = await FileSystem.uploadAsync(target.url, fileUri, {
    httpMethod: "PUT",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Upload failed (${res.status})`);
  }
}
