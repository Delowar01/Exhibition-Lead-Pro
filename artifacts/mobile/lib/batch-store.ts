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
}

export function setBatchOcrResult(id: string, result: BatchOcrResult): void {
  ocrResults.set(id, result);
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
