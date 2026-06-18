import AsyncStorage from "@react-native-async-storage/async-storage";

import type { ContactInput } from "@workspace/api-client-react";

export const OFFLINE_QUEUE_KEY = "csp_offline_queue";

export type QueueItemKind = "scan" | "contact";
export type QueueItemStatus = "pending" | "syncing" | "failed";

/**
 * A single piece of work captured while offline (or that failed to reach the
 * server) and is waiting to be synced.
 *
 * - `kind: "contact"` already holds a ready-to-send {@link ContactInput} payload
 *   (manual entry, QR/vCard, or a reviewed scan).
 * - `kind: "scan"` holds a base64 card image that still needs server-side OCR
 *   before a contact can be created.
 */
export interface QueueItem {
  id: string;
  kind: QueueItemKind;
  status: QueueItemStatus;
  createdAt: number;
  attempts: number;
  /** Human-readable name shown in the Sync Center. */
  label: string;
  /** Where it came from: "card" | "badge" | "qr" | "manual". */
  source: string;
  lastError?: string;
  /** Present when kind === "contact". */
  payload?: ContactInput;
  /** Present when kind === "scan" — a data URL base64 image awaiting OCR. */
  imageData?: string;
  /** Event this capture belongs to (threaded through to scan + contact). */
  eventId?: number | null;
  /** GPS captured at scan time. */
  latitude?: number | null;
  longitude?: number | null;
  gpsAccuracy?: number | null;
}

export function makeQueueId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function loadQueue(): Promise<QueueItem[]> {
  try {
    const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is QueueItem =>
        !!item &&
        typeof item === "object" &&
        typeof (item as QueueItem).id === "string" &&
        ((item as QueueItem).kind === "scan" || (item as QueueItem).kind === "contact"),
    );
  } catch {
    return [];
  }
}

// Serialize writes so rapid sequential commits (enqueue → syncing → remove)
// land in AsyncStorage in call order. Without this, fire-and-forget writes can
// resolve out of order and an older snapshot may clobber a newer one.
let writeChain: Promise<void> = Promise.resolve();

export function saveQueue(items: QueueItem[]): Promise<void> {
  const snapshot = JSON.stringify(items);
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      try {
        await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, snapshot);
      } catch {
        /* best-effort persistence */
      }
    });
  return writeChain;
}

export async function clearQueue(): Promise<void> {
  try {
    await AsyncStorage.removeItem(OFFLINE_QUEUE_KEY);
  } catch {
    /* noop */
  }
}
