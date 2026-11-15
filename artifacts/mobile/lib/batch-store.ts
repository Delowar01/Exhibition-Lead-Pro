import type { ExtractedCardData } from "@workspace/api-client-react";

export interface BatchCapture {
  id: string;
  imageData: string;
  latitude: number | null;
  longitude: number | null;
  gpsAccuracy: number | null;
}

export interface BatchOcrResult {
  status: "pending" | "done" | "error";
  extracted: ExtractedCardData | null;
  scanId: number | null;
}

let captures: BatchCapture[] = [];
const ocrResults = new Map<string, BatchOcrResult>();
// Batch session counter. clearBatchCaptures() starts a new session; a background
// OCR completion that carries an older session token belongs to a batch the user
// already left and must not re-enter the store (Batch 38 audit: stale completion
// after batch exit).
let session = 1;

export function getBatchSession(): number {
  return session;
}

export function setBatchCaptures(items: BatchCapture[]): void {
  captures = items;
  // Do NOT clear ocrResults here — background OCR fires setBatchOcrResult
  // concurrently with (or before) setBatchCaptures. Clearing here wipes every
  // pre-computed result a moment before batch-review tries to read them.
  // ocrResults is only cleared in clearBatchCaptures() (end of a batch session).
}

export function getBatchCaptures(): BatchCapture[] {
  return captures;
}

export function clearBatchCaptures(): void {
  captures = [];
  ocrResults.clear();
  session += 1;
}

/**
 * Records an OCR result. When `forSession` is given (the session token captured
 * when the shot was taken), a result from an ended session is ignored and `false`
 * is returned, so a late background completion can never resurrect a cleared
 * batch or disturb the pending count of the next one.
 */
export function setBatchOcrResult(id: string, result: BatchOcrResult, forSession?: number): boolean {
  if (forSession !== undefined && forSession !== session) return false;
  ocrResults.set(id, result);
  return true;
}

export function getBatchOcrResult(id: string): BatchOcrResult | undefined {
  return ocrResults.get(id);
}

/**
 * Returns the number of captures whose OCR is still in-flight ("pending").
 * Used by the capture-camera Done button to indicate unfinished background work.
 */
export function getPendingOcrCount(): number {
  let count = 0;
  for (const result of ocrResults.values()) {
    if (result.status === "pending") count++;
  }
  return count;
}
