import AsyncStorage from "@react-native-async-storage/async-storage";

import { parseStoredQueue, serializeQueue, type QueueItem } from "./offline-queue-model";

export type { QueueItem, QueueItemKind, QueueItemStatus } from "./offline-queue-model";
export { makeQueueId } from "./offline-queue-model";

// The storage key is unchanged on purpose: existing installations keep their
// queued work. Entries written before ownership metadata existed come back
// with `owner: null` (quarantined) — see lib/offline-queue-model.ts.
export const OFFLINE_QUEUE_KEY = "csp_offline_queue";

export async function loadQueue(): Promise<QueueItem[]> {
  try {
    return parseStoredQueue(await AsyncStorage.getItem(OFFLINE_QUEUE_KEY));
  } catch {
    return [];
  }
}

// Serialize writes so rapid sequential commits (enqueue → syncing → remove)
// land in AsyncStorage in call order. Without this, fire-and-forget writes can
// resolve out of order and an older snapshot may clobber a newer one.
let writeChain: Promise<void> = Promise.resolve();

export function saveQueue(items: QueueItem[]): Promise<void> {
  const snapshot = serializeQueue(items);
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
