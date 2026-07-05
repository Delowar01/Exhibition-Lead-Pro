/**
 * Document upload / download helpers for the mobile app.
 *
 * Upload flow (contract-first, mirrors the web Document Manager):
 *   1. Request a presigned PUT URL from the API (returns { uploadURL, objectPath }).
 *   2. PUT the raw file bytes DIRECTLY to object storage (never through our API).
 *   3. Create the document (or a new version) with the returned objectPath +
 *      captured metadata (fileName, fileSize, mimeType).
 *
 * Download / preview flow:
 *   The API mints a short-lived signed GET URL. Preview opens it in the in-app
 *   browser; download streams it to a cache file then hands it to the native
 *   share sheet ("Save to Files" / "Save Image").
 *
 * Files never contain business logic — that stays in the API. This module only
 * bridges native device capabilities (camera / gallery / file picker / storage)
 * to the generated API client.
 */

import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";

import {
  addDocumentVersion,
  createDocument,
  getDocumentDownloadUrl,
  getDocumentVersionDownloadUrl,
  requestDocumentUploadUrl,
  type Document,
  type DocumentInputEntityType,
} from "@workspace/api-client-react";

// Keep in sync with the API allowlist (lib/documentStorage.ts).
export const MAX_DOCUMENT_SIZE = 25 * 1024 * 1024; // 25 MB

export type DocumentSource = "camera" | "gallery" | "file";

export interface PickedFile {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}

// Minimal extension → MIME map so file picks / camera shots that arrive without
// a declared type still resolve to a server-accepted MIME. Anything unknown is
// surfaced as octet-stream and rejected by the API (graceful 400 → alert).
const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  tiff: "image/tiff",
  tif: "image/tiff",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
};

function extOf(name: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

function guessMime(name: string, fallback = "application/octet-stream"): string {
  return EXT_MIME[extOf(name)] ?? fallback;
}

export function humanFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

// Feather icon name for a given MIME type.
export function iconForMime(mimeType: string | null | undefined): string {
  const m = (mimeType ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf") return "file-text";
  if (m.includes("word")) return "file-text";
  if (m.includes("excel") || m.includes("spreadsheet") || m === "text/csv") return "grid";
  if (m.includes("powerpoint") || m.includes("presentation")) return "monitor";
  if (m.includes("zip")) return "archive";
  if (m.startsWith("text/")) return "file-text";
  return "file";
}

// Resolve a file's size when the picker did not report one.
async function ensureSize(uri: string, reported?: number | null): Promise<number> {
  if (reported && reported > 0) return reported;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && typeof info.size === "number" ? info.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Present the appropriate native picker and return the chosen file (or null if
 * the user cancels). Throws with a user-facing message when a permission is
 * denied so the caller can alert.
 */
export async function pickDocument(source: DocumentSource): Promise<PickedFile | null> {
  if (source === "camera") {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error("permission:camera");
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.[0]) return null;
    const a = result.assets[0];
    const name = a.fileName || `photo_${Date.now()}.jpg`;
    return {
      uri: a.uri,
      name,
      mimeType: a.mimeType || guessMime(name, "image/jpeg"),
      size: await ensureSize(a.uri, a.fileSize),
    };
  }

  if (source === "gallery") {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) throw new Error("permission:gallery");
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.[0]) return null;
    const a = result.assets[0];
    const name = a.fileName || `image_${Date.now()}.jpg`;
    return {
      uri: a.uri,
      name,
      mimeType: a.mimeType || guessMime(name, "image/jpeg"),
      size: await ensureSize(a.uri, a.fileSize),
    };
  }

  // Any-type file picker.
  const result = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  const a = result.assets[0];
  const name = a.name || `file_${Date.now()}`;
  return {
    uri: a.uri,
    name,
    mimeType: a.mimeType || guessMime(name),
    size: await ensureSize(a.uri, a.size),
  };
}

// PUT the raw bytes to the presigned URL. Uses native binary upload on device
// (streams from disk, handles large files) and a blob PUT on web.
async function putToSignedUrl(uploadURL: string, file: PickedFile): Promise<void> {
  if (Platform.OS === "web") {
    const resp = await fetch(file.uri);
    const blob = await resp.blob();
    const put = await fetch(uploadURL, {
      method: "PUT",
      body: blob,
      headers: { "Content-Type": file.mimeType },
    });
    if (!put.ok) throw new Error(`Upload failed (${put.status})`);
    return;
  }
  const res = await FileSystem.uploadAsync(uploadURL, file.uri, {
    httpMethod: "PUT",
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { "Content-Type": file.mimeType },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Upload failed (${res.status})`);
  }
}

export interface CreateDocumentUploadParams {
  entityType: DocumentInputEntityType;
  entityId: number;
  category: string;
  name?: string | null;
  file: PickedFile;
}

/** Full new-document upload: presign → PUT → create. Returns the created doc. */
export async function uploadNewDocument(params: CreateDocumentUploadParams): Promise<Document> {
  const { entityType, entityId, category, name, file } = params;
  if (file.size > MAX_DOCUMENT_SIZE) throw new Error("size");
  const { uploadURL, objectPath } = await requestDocumentUploadUrl({
    fileName: file.name,
    contentType: file.mimeType,
    size: file.size,
  });
  await putToSignedUrl(uploadURL, file);
  return createDocument({
    entityType,
    entityId,
    category,
    name: name?.trim() || file.name,
    objectPath,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.mimeType,
  });
}

/** Upload a new version of an existing document: presign → PUT → add version. */
export async function uploadDocumentVersion(
  documentId: number,
  file: PickedFile,
  label?: string | null,
): Promise<Document> {
  if (file.size > MAX_DOCUMENT_SIZE) throw new Error("size");
  const { uploadURL, objectPath } = await requestDocumentUploadUrl({
    fileName: file.name,
    contentType: file.mimeType,
    size: file.size,
  });
  await putToSignedUrl(uploadURL, file);
  return addDocumentVersion(documentId, {
    objectPath,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.mimeType,
    label: label?.trim() || null,
  });
}

// Resolve a signed URL for the current version or a specific version.
async function resolveUrl(documentId: number, versionId?: number) {
  return versionId != null
    ? getDocumentVersionDownloadUrl(documentId, versionId)
    : getDocumentDownloadUrl(documentId);
}

/** Open a document for preview in the in-app browser (web: new tab). */
export async function previewDocument(documentId: number, versionId?: number): Promise<void> {
  const { url } = await resolveUrl(documentId, versionId);
  if (Platform.OS === "web") {
    if (typeof window !== "undefined") window.open(url, "_blank");
    return;
  }
  await WebBrowser.openBrowserAsync(url);
}

/**
 * Download a document to the device. On native, images are saved to the photo
 * library (when permitted); everything else is handed to the share sheet so the
 * user can "Save to Files". On web the browser handles the download.
 */
export async function downloadDocument(
  documentId: number,
  opts?: { versionId?: number },
): Promise<{ saved: "library" | "shared" | "browser" }> {
  const { url, fileName, mimeType } = await resolveUrl(documentId, opts?.versionId);
  if (Platform.OS === "web") {
    if (typeof window !== "undefined") window.open(url, "_blank");
    return { saved: "browser" };
  }

  const safeName = fileName || `document_${documentId}`;
  const localUri = `${FileSystem.cacheDirectory}${Date.now()}_${safeName}`;
  const result = await FileSystem.downloadAsync(url, localUri);

  if ((mimeType ?? "").startsWith("image/")) {
    const perm = await MediaLibrary.requestPermissionsAsync();
    if (perm.granted) {
      await MediaLibrary.saveToLibraryAsync(result.uri);
      return { saved: "library" };
    }
  }

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(result.uri, { mimeType: mimeType || undefined });
    return { saved: "shared" };
  }
  return { saved: "browser" };
}
