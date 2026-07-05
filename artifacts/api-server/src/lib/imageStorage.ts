import type { Readable } from "stream";
import sharp from "sharp";
import { objectStorageClient } from "./objectStorage.js";
import { config } from "../config.js";

function getBucketId(): string {
  const id = config.objectStorage.bucketId;
  if (!id) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");
  return id;
}

/**
 * Decode a data-URL or raw base64 string and compress to JPEG ~80 quality.
 * Returns { buffer, contentType }.
 */
async function decodeAndCompress(imageData: string): Promise<{ buffer: Buffer; contentType: string }> {
  const base64 = imageData.startsWith("data:") ? imageData.split(",")[1] : imageData;
  if (!base64) throw new Error("Invalid image data");
  const raw = Buffer.from(base64, "base64");
  const buffer = await sharp(raw).jpeg({ quality: 80, progressive: true }).toBuffer();
  return { buffer, contentType: "image/jpeg" };
}

/**
 * Upload a base64-encoded scan image to GCS after compressing to JPEG.
 * Returns the GCS object name (internal storage key).
 */
export async function uploadScanImage(
  scanId: number,
  companyId: number,
  imageData: string,
): Promise<string> {
  const { buffer, contentType } = await decodeAndCompress(imageData);
  const objectName = `scans/${companyId}/${scanId}.jpg`;
  const bucket = objectStorageClient.bucket(getBucketId());
  await bucket.file(objectName).save(buffer, { contentType });
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

/**
 * Download a previously uploaded scan image from GCS and return it as a base64
 * string (used to re-run OCR on the stored image). Throws if the object does
 * not exist.
 */
export async function loadScanImageBase64(objectName: string): Promise<string> {
  const bucket = objectStorageClient.bucket(getBucketId());
  const file = bucket.file(objectName);
  const [exists] = await file.exists();
  if (!exists) throw new Error("Image not found");
  const [buffer] = await file.download();
  return buffer.toString("base64");
}
