// B25 Correction 1 — private product files (documents, exports, executive
// reports) are served by the API only to the CURRENTLY authenticated user:
// their URLs carry no credential, so the browser must fetch them with the
// normal session (customFetch attaches the bearer token and handles the 401
// refresh) and hand the bytes over as a blob — never navigate an <a>/<img>/
// <iframe> straight at the URL.
import { customFetch } from "@workspace/api-client-react";

/** Fetch a private file as a Blob with the normal API authentication. */
export async function fetchPrivateBlob(url: string): Promise<Blob> {
  return customFetch<Blob>(url, { method: "GET", responseType: "blob" });
}

/** Download a private file through the browser's save flow (authenticated). */
export async function downloadPrivateFile(url: string, fileName: string): Promise<void> {
  const blob = await fetchPrivateBlob(url);
  const objUrl = URL.createObjectURL(blob);
  const a = window.document.createElement("a");
  a.href = objUrl;
  a.download = fileName || "download";
  a.rel = "noopener";
  window.document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
}

/** PUT raw upload bytes to a reserved upload target with the session + header-bound capability. */
export async function putPrivateUpload(uploadURL: string, uploadToken: string, file: Blob, contentType: string): Promise<{ sizeBytes: number; sha256: string }> {
  return customFetch<{ sizeBytes: number; sha256: string }>(uploadURL, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": contentType, "X-Storage-Capability": uploadToken },
    responseType: "json",
  });
}
