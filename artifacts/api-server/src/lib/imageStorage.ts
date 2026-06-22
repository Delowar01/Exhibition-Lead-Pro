import type { Readable } from "stream";
import { objectStorageClient } from "./objectStorage.js";

function getBucketId(): string {
  const id = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID ?? "";
  if (!id) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");
  return id;
}

/**
 * Upload a base64-encoded scan image to GCS.
 * Returns the GCS object name (relative key within the bucket).
 */
export async function uploadScanImage(
  scanId: number,
  companyId: number,
  imageData: string,
): Promise<string> {
  const base64 = imageData.startsWith("data:") ? imageData.split(",")[1] : imageData;
  if (!base64) throw new Error("Invalid image data for upload");
  const buffer = Buffer.from(base64, "base64");
  const objectName = `scans/${companyId}/${scanId}.jpg`;
  const bucket = objectStorageClient.bucket(getBucketId());
  await bucket.file(objectName).save(buffer, { contentType: "image/jpeg" });
  return objectName;
}

/**
 * Stream a previously uploaded scan image from GCS.
 * Throws if the object does not exist.
 */
export async function streamScanImage(
  objectName: string,
): Promise<{ stream: Readable; contentType: string }> {
  const bucket = objectStorageClient.bucket(getBucketId());
  const file = bucket.file(objectName);
  const [exists] = await file.exists();
  if (!exists) throw new Error("Image not found");
  return { stream: file.createReadStream(), contentType: "image/jpeg" };
}
