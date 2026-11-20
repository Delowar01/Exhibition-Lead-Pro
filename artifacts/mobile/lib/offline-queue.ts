import AsyncStorage from "@react-native-async-storage/async-storage";

import { inspectStoredQueue, serializeQueue, type QueueItem } from "./offline-queue-model";
import { MAX_DONE_IDS, MAX_INDEX_CHARS, externalizeImages, mergeLegacyItems, parseDoneIds } from "./offline-queue-store-model";
import type { ScanFileStore } from "./scan-files";

export type { QueueItem, QueueItemKind, QueueItemStatus } from "./offline-queue-model";
export { makeQueueId } from "./offline-queue-model";

// Phase 2 Batch 1 — where the queue lives.
//
//   csp_offline_queue_v2       the queue INDEX: every item, but a scan carries
//                              only the NAME of its image file (lib/scan-files.ts).
//   csp_offline_queue          the queue of earlier versions, with the images
//                              inline. Read once: its items move into the index,
//                              their images into files. It is removed only after
//                              the index holding those items was written, and it
//                              is left untouched when it cannot be read.
//   csp_offline_queue_migrated "1" once that move is complete.
//   csp_offline_done           ids of items that were uploaded or removed, so an
//                              image file left behind is never taken for a new scan.
//   csp_offline_queue_damaged  copy of an index value that was not a queue, set
//                              aside before a fresh index replaces it.
//
// Nothing here deletes queued work on its own, and no write happens while the
// stored index is unknown or unreadable.
export const OFFLINE_QUEUE_KEY = "csp_offline_queue_v2";
export const LEGACY_QUEUE_KEY = "csp_offline_queue";
const MIGRATED_FLAG_KEY = "csp_offline_queue_migrated";
const DONE_KEY = "csp_offline_done";
const DAMAGED_KEY = "csp_offline_queue_damaged";

export interface QueueLoad {
  /** Every stored item (all accounts and quarantined ones). */
  items: QueueItem[];
  /** Ids already uploaded or removed (see csp_offline_done). */
  doneIds: string[];
  /**
   * False when the stored index could not be read at all: nothing is written
   * for the rest of this session, so whatever is stored cannot be overwritten.
   */
  writable: boolean;
  /** The index held something that was not a queue (set aside under csp_offline_queue_damaged when possible). */
  indexDamaged: boolean;
  /** The queue of an earlier version exists but cannot be read on this device. It is kept as it is. */
  legacyUnreadable: boolean;
  /** Items taken over from the earlier version's queue in this load. */
  migrated: number;
  /** Scans whose image is still held inline because it could not be written to a file yet. */
  inlineImages: number;
}

let writable = false;

/**
 * Read the stored queue, taking over an earlier version's queue on the way.
 * Never throws; every problem is reported in the result.
 */
export async function loadQueue(files: ScanFileStore): Promise<QueueLoad> {
  const out: QueueLoad = { items: [], doneIds: [], writable: true, indexDamaged: false, legacyUnreadable: false, migrated: 0, inlineImages: 0 };

  // 1. The index.
  let rawIndex: string | null = null;
  try {
    rawIndex = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
  } catch {
    // Unreadable: do not guess, and above all do not write over it.
    out.writable = false;
    out.indexDamaged = true;
  }
  if (out.writable) {
    const index = inspectStoredQueue(rawIndex);
    if (index.state === "corrupt") {
      out.indexDamaged = true;
      try {
        await AsyncStorage.setItem(DAMAGED_KEY, rawIndex ?? "");
      } catch {
        out.writable = false; // could not set it aside → keep it where it is
      }
    } else {
      out.items = index.items;
    }
  }

  // 2. Ids already dealt with. An entry recorded as finished (uploaded, or
  //    removed by the user) whose removal from the index could not be stored
  //    is not brought back: it would be sent a second time.
  try {
    out.doneIds = parseDoneIds(await AsyncStorage.getItem(DONE_KEY));
  } catch {
    out.doneIds = [];
  }
  let finishedDropped = false;
  if (out.doneIds.length > 0 && out.items.length > 0) {
    const done = new Set(out.doneIds);
    const open = out.items.filter((it) => !done.has(it.id));
    finishedDropped = open.length !== out.items.length;
    out.items = open;
  }

  // 3. The queue of an earlier version (once).
  let migratedFlag = false;
  try {
    migratedFlag = (await AsyncStorage.getItem(MIGRATED_FLAG_KEY)) === "1";
  } catch {
    migratedFlag = false;
  }
  let legacyTaken = false;
  if (!migratedFlag) {
    let rawLegacy: string | null = null;
    let legacyReadable = true;
    try {
      rawLegacy = await AsyncStorage.getItem(LEGACY_QUEUE_KEY);
    } catch {
      legacyReadable = false;
      out.legacyUnreadable = true;
    }
    if (legacyReadable && rawLegacy !== null) {
      const legacy = inspectStoredQueue(rawLegacy);
      if (legacy.state === "corrupt") {
        out.legacyUnreadable = true;
      } else {
        const merged = mergeLegacyItems(out.items, legacy.items, out.doneIds);
        out.migrated = merged.added;
        out.items = merged.items;
        legacyTaken = true;
      }
    } else if (legacyReadable) {
      legacyTaken = true; // nothing to take over
    }
  }

  // 4. Images still held inline (taken-over items, or an earlier attempt that ran out of space) → files.
  const moved = await externalizeImages(out.items, files);
  out.items = moved.items;
  out.inlineImages = moved.remainingInline;

  writable = out.writable;

  // 5. Publish the result. The earlier version's queue goes only after the index that contains its items is stored.
  if (out.writable && (out.migrated > 0 || moved.changed || finishedDropped || (!migratedFlag && legacyTaken))) {
    const snapshot = serializeQueue(out.items);
    if (snapshot.length <= MAX_INDEX_CHARS) {
      try {
        const pairs: [string, string][] = [[OFFLINE_QUEUE_KEY, snapshot]];
        if (!migratedFlag && legacyTaken) pairs.push([MIGRATED_FLAG_KEY, "1"]);
        await AsyncStorage.multiSet(pairs);
        if (!migratedFlag && legacyTaken) {
          try {
            await AsyncStorage.removeItem(LEGACY_QUEUE_KEY);
          } catch {
            /* the flag already says it was taken over; removal is retried by the next cleanup */
          }
        }
      } catch {
        /* not stored: the earlier queue stays, and the take-over is repeated at the next start */
      }
    }
  } else if (out.writable && migratedFlag) {
    // Left over from an interrupted removal.
    try {
      await AsyncStorage.removeItem(LEGACY_QUEUE_KEY);
    } catch {
      /* noop */
    }
  }
  return out;
}

// Writes are serialized so rapid commits (enqueue → syncing → progress →
// remove) reach the store in call order: each write is a complete snapshot, and
// an older one must never land after a newer one.
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Store the queue index (and the list of finished ids). Resolves `true` only
 * when the store accepted it. `false` = NOT stored: the caller must tell the
 * user instead of reporting the capture as saved.
 */
export function saveQueue(items: QueueItem[], doneIds: readonly string[] = []): Promise<boolean> {
  if (!writable) return Promise.resolve(false);
  const snapshot = serializeQueue(items);
  const done = JSON.stringify(doneIds.slice(-MAX_DONE_IDS));
  const run = async (): Promise<boolean> => {
    // An index that large could be written but not read back on Android. The
    // (small) list of finished ids is still stored, so work that was uploaded
    // is not sent again after a restart.
    if (snapshot.length > MAX_INDEX_CHARS) {
      try {
        await AsyncStorage.setItem(DONE_KEY, done);
      } catch {
        /* nothing more can be done here; the caller is told the index was not stored */
      }
      return false;
    }
    try {
      await AsyncStorage.multiSet([
        [OFFLINE_QUEUE_KEY, snapshot],
        [DONE_KEY, done],
      ]);
      return true;
    } catch {
      // The pair could not be stored together: try the finished ids alone.
      try {
        await AsyncStorage.setItem(DONE_KEY, done);
      } catch {
        /* see above */
      }
      return false;
    }
  };
  const result = writeChain.then(run, run);
  writeChain = result;
  return result;
}

/** Whether queue writes are possible in this session (false after an unreadable index). */
export function queueWritable(): boolean {
  return writable;
}
