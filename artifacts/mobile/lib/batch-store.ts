export interface BatchCapture {
  id: string;
  imageData: string;
  latitude: number | null;
  longitude: number | null;
  gpsAccuracy: number | null;
}

let captures: BatchCapture[] = [];

export function setBatchCaptures(items: BatchCapture[]): void {
  captures = items;
}

export function getBatchCaptures(): BatchCapture[] {
  return captures;
}

export function clearBatchCaptures(): void {
  captures = [];
}
