import { requestUploadURL, getDownloadURL } from "./documentStorage.js";

// Stage 4B — Export Center storage helper. Unlike documents (client-side
// presigned upload), export files are produced SERVER-SIDE, so we request a
// presigned PUT URL and stream the generated buffer to it ourselves. Only the
// normalized `/objects/...` path is persisted (export_runs.objectPath); bytes
// live in object storage.
export async function uploadExportBuffer(buffer: Buffer, contentType: string): Promise<{ objectPath: string }> {
  const { uploadURL, objectPath } = await requestUploadURL();
  const res = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(buffer.length) },
    body: new Uint8Array(buffer),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`Export upload failed: ${res.status}`);
  }
  return { objectPath };
}

// Mint a short-lived signed GET URL for a produced export file.
export async function exportDownloadURL(objectPath: string, ttlSec = 300): Promise<string> {
  return getDownloadURL(objectPath, ttlSec);
}
