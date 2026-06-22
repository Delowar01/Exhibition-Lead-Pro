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
}

let captures: BatchCapture[] = [];
const ocrResults = new Map<string, BatchOcrResult>();

export function setBatchCaptures(items: BatchCapture[]): void {
  captures = items;
  // Clear stale OCR results from any previous session so a new batch never
  // reads pre-computed results that belong to a different capture set or user.
  ocrResults.clear();
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
