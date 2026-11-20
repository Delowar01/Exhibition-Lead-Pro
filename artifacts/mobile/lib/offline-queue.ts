import AsyncStorage from "@react-native-async-storage/async-storage";

import { readStoredQueue, serializeQueue, type QueueItem } from "./offline-queue-model";
import {
  MAX_DAMAGED_COPIES,
  MAX_DONE_IDS,
  MAX_INDEX_CHARS,
  externalizeImages,
  fingerprintOf,
  mergeLegacyItems,
  parseDoneIds,
  parseIncident,
  uncoveredIds,
  type QueueIncident,
} from "./offline-queue-store-model";
import type { ScanFileStore } from "./scan-files";

export type { QueueItem, QueueItemKind, QueueItemStatus } from "./offline-queue-model";
export { makeQueueId } from "./offline-queue-model";

// Phase 2 Batch 1 — where the queue lives.
//
//   csp_offline_queue_v2        the queue INDEX: every item, but a scan carries
//                               only the NAME of its image file (lib/scan-files.ts).
//   csp_offline_queue           the queue of earlier versions, with the images
//                               inline. Its items move into the index, their
//                               images into files. It is removed only after the
//                               STORED index was read back and found to hold
//                               every one of them, and it is left untouched
//                               when it cannot be read (in whole or in part).
//   csp_offline_queue_migrated  a mark of the old queue's value once that move
//                               was verified. The same old queue is then never
//                               taken over a second time — but the mark alone
//                               never allows its removal.
//   csp_offline_done            ids of items that were uploaded or removed, so an
//                               image file left behind is never taken for a new
//                               scan and a stale index cannot bring them back.
//   csp_offline_queue_damaged,  the ORIGINAL of an index that could not be read
//   …_damaged_2, …_damaged_3    as it was, each kept untouched under a key of
//                               its own until the user removes it.
//   csp_offline_queue_incident  the record of that damage, or of the index
//                               being gone while photos of captures remain
//                               (when, how much was read back, where the
//                               originals are).
//
// Rules that hold throughout:
//   • nothing here deletes queued work on its own;
//   • no write happens while the stored index is unknown or unreadable;
//   • a damaged index is never replaced before its original is safely kept;
//   • every step is ONE key written at a time, in an order whose every
//     interruption leaves a state the next start completes. No step relies on
//     several keys being written together (that is one transaction on Android
//     but not on every platform this code runs on).
export const OFFLINE_QUEUE_KEY = "csp_offline_queue_v2";
export const LEGACY_QUEUE_KEY = "csp_offline_queue";
const MIGRATED_FLAG_KEY = "csp_offline_queue_migrated";
const DONE_KEY = "csp_offline_done";
const DAMAGED_KEYS = ["csp_offline_queue_damaged", "csp_offline_queue_damaged_2", "csp_offline_queue_damaged_3"] as const;
const INCIDENT_KEY = "csp_offline_queue_incident";

export interface QueueLoad {
  /** Every stored item (all accounts and quarantined ones). */
  items: QueueItem[];
  /** Ids already uploaded or removed (see csp_offline_done). */
  doneIds: string[];
  /**
   * False when the stored index could not be read at all, or was damaged and
   * its original could not be kept: nothing is written for the rest of this
   * session, so whatever is stored cannot be overwritten.
   */
  writable: boolean;
  /** The index was found damaged in THIS load (see `incident` for the lasting record). */
  indexDamaged: boolean;
  /**
   * No index was stored at all although photos of captures are on the device
   * (found in THIS load): the list is gone, the photos are not.
   */
  indexLost: boolean;
  /** The damage could not be set aside or recorded safely (no space, no free place): nothing was touched. */
  damagedCopyFailed: boolean;
  /**
   * Photos made up to this time whose entry is missing are NOT sent by
   * themselves (0 = no such time). It is the recorded time of the damage — or
   * "now" when that record itself could not be read in this start.
   */
  holdUnlistedBefore: number;
  /** The lasting record of a damaged index (null = it never happened on this device). */
  incident: QueueIncident | null;
  /** The queue of an earlier version exists but cannot be read (fully) on this device. It is kept as it is. */
  legacyUnreadable: boolean;
  /** Items taken over from the earlier version's queue in this load. */
  migrated: number;
  /** Scans whose image is still held inline because it could not be written to a file yet. */
  inlineImages: number;
}

let writable = false;
let incident: QueueIncident | null = null;
/** The finished-id list as last stored by this session (null = not written yet). */
let storedDone: string | null = null;

async function read(key: string): Promise<{ ok: true; value: string | null } | { ok: false }> {
  try {
    return { ok: true, value: await AsyncStorage.getItem(key) };
  } catch {
    return { ok: false };
  }
}

/** Store one value and confirm it by reading it back. */
async function storeVerified(key: string, value: string): Promise<boolean> {
  try {
    await AsyncStorage.setItem(key, value);
    return (await AsyncStorage.getItem(key)) === value;
  } catch {
    return false;
  }
}

/**
 * Keep the original of a damaged index, untouched, under a key of its own.
 * Resolves every key that now holds an original, and whether THIS original was
 * already kept (an interrupted recovery repeats: the same original is never
 * stored twice). null = it could not be kept.
 */
async function keepDamagedOriginal(raw: string): Promise<{ copies: string[]; alreadyKept: boolean } | null> {
  const occupied: string[] = [];
  let free: string | null = null;
  let alreadyKept = false;
  // Every place is looked at, whatever the record says: a kept original is
  // never left unlisted (it could then never be removed by the user).
  for (const key of DAMAGED_KEYS) {
    const existing = await read(key);
    if (!existing.ok) {
      occupied.push(key); // cannot be inspected: never written over
      continue;
    }
    if (existing.value === raw) {
      alreadyKept = true;
      occupied.push(key);
    } else if (existing.value !== null && existing.value !== "") occupied.push(key);
    else if (free === null) free = key;
  }
  if (alreadyKept) return { copies: occupied, alreadyKept: true };
  if (free === null || occupied.length >= MAX_DAMAGED_COPIES) return null;
  if (!(await storeVerified(free, raw))) return null;
  return { copies: [...occupied, free].sort((x, y) => DAMAGED_KEYS.indexOf(x as (typeof DAMAGED_KEYS)[number]) - DAMAGED_KEYS.indexOf(y as (typeof DAMAGED_KEYS)[number])), alreadyKept: false };
}

/** Of the kept originals a record names: those that are really still there. */
async function existingCopies(keys: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const key of keys) {
    const existing = await read(key);
    if (!existing.ok || (existing.value !== null && existing.value !== "")) out.push(key);
  }
  return out;
}

/**
 * Read the stored queue, taking over an earlier version's queue on the way.
 * Never throws; every problem is reported in the result.
 */
export async function loadQueue(files: ScanFileStore, now: number = Date.now()): Promise<QueueLoad> {
  const out: QueueLoad = {
    items: [],
    doneIds: [],
    writable: true,
    indexDamaged: false,
    indexLost: false,
    damagedCopyFailed: false,
    holdUnlistedBefore: 0,
    incident: null,
    legacyUnreadable: false,
    migrated: 0,
    inlineImages: 0,
  };
  let publish = false;

  const storedIncident = await read(INCIDENT_KEY);
  out.incident = storedIncident.ok ? parseIncident(storedIncident.value) : null;
  // A record that names kept originals which are gone (their removal was
  // interrupted before the record could be rewritten) is put right.
  if (out.incident && out.incident.copies.length > 0) {
    const still = await existingCopies(out.incident.copies);
    if (still.length !== out.incident.copies.length) {
      const fixed: QueueIncident = { ...out.incident, copies: still, acknowledged: out.incident.acknowledged || still.length === 0 };
      try {
        await AsyncStorage.setItem(INCIDENT_KEY, JSON.stringify(fixed));
      } catch {
        /* the in-memory record is right for this session; the next start repeats this */
      }
      out.incident = fixed;
    }
  }

  // 1. The index.
  const index = await read(OFFLINE_QUEUE_KEY);
  if (!index.ok) {
    // Unreadable: do not guess, and above all do not write over it.
    out.writable = false;
    out.indexDamaged = true;
  } else {
    const reading = readStoredQueue(index.value);
    if (reading.state === "damaged") {
      out.indexDamaged = true;
      // The original first: nothing replaces a damaged index before it is kept.
      const kept = await keepDamagedOriginal(index.value as string);
      const record: QueueIncident | null = kept
        ? {
            kind: "damaged",
            // The same original met again (its recovery was interrupted) is the
            // same event; anything else is a new one, dated now.
            at: kept.alreadyKept && out.incident ? out.incident.at : now,
            salvaged: reading.items.length,
            unreadable: reading.unreadable,
            copies: kept.copies,
            acknowledged: false,
          }
        : null;
      if (record && (await storeVerified(INCIDENT_KEY, JSON.stringify(record)))) {
        out.incident = record;
        out.items = reading.items; // what could be read comes back exactly as it was stored
        publish = true;
      } else {
        // Not kept, or not recorded: leave everything where it is.
        out.writable = false;
        out.damagedCopyFailed = true;
      }
    } else {
      out.items = reading.items;
      // Nothing is stored — but are photos of captures on the device? Then the
      // list did not start empty: it is GONE (the store was cleared or replaced
      // underneath the app; Android replaces a database it cannot open). The
      // photos are all that is left of those captures. That is recorded, so
      // they are put back for the user to decide on instead of being sent
      // unasked without their details. (One photo whose very first save was
      // interrupted looks the same and is treated the same.)
      if (reading.state === "empty" && files.available() && (await files.anyImages()) === true) {
        const record: QueueIncident = { kind: "lost", at: now, salvaged: 0, unreadable: null, copies: out.incident?.copies ?? [], acknowledged: false };
        if (await storeVerified(INCIDENT_KEY, JSON.stringify(record))) {
          out.incident = record;
          out.indexLost = true;
        } else {
          // It cannot be recorded, so it could not be honoured after a restart: nothing is written or sent.
          out.writable = false;
          out.indexLost = true;
          out.damagedCopyFailed = true;
        }
      }
    }
  }
  out.holdUnlistedBefore = storedIncident.ok ? out.incident?.at ?? 0 : now;

  // 2. Ids already dealt with. An entry recorded as finished (uploaded, or
  //    removed by the user) whose removal from the index could not be stored
  //    is not brought back: it would be sent a second time.
  const done = await read(DONE_KEY);
  out.doneIds = done.ok ? parseDoneIds(done.value) : [];
  if (out.doneIds.length > 0 && out.items.length > 0) {
    const finished = new Set(out.doneIds);
    const open = out.items.filter((it) => !finished.has(it.id));
    if (open.length !== out.items.length) publish = true;
    out.items = open;
  }

  // 3. The queue of an earlier version. The completion flag is only a note:
  //    whether the old queue may go is decided by what the STORED index holds.
  const flag = await read(MIGRATED_FLAG_KEY);
  const legacy = await read(LEGACY_QUEUE_KEY);
  let legacyItems: QueueItem[] | null = null;
  let legacyComplete = false;
  let legacyMark: string | null = null;
  let alreadyTakenOver = false;
  if (!legacy.ok) {
    out.legacyUnreadable = true;
  } else if (legacy.value !== null && out.writable) {
    const reading = readStoredQueue(legacy.value);
    if (reading.state === "damaged" && reading.items.length === 0) {
      out.legacyUnreadable = true; // nothing of it can be read: it stays exactly where it is
    } else {
      legacyMark = fingerprintOf(legacy.value);
      // This very value was taken over before (and verified then). It is not
      // taken over again: what was uploaded, removed or replaced since must
      // not come back from it. Whether it may be REMOVED is decided below, on
      // what the stored index holds — never on this mark.
      alreadyTakenOver = flag.ok && flag.value === legacyMark;
      if (!alreadyTakenOver) {
        const merged = mergeLegacyItems(out.items, reading.items, out.doneIds);
        out.migrated = merged.added;
        out.items = merged.items;
        if (merged.added > 0) publish = true;
      }
      legacyItems = reading.items;
      legacyComplete = reading.state !== "damaged";
      // Part of it cannot be read: what can be is taken over, the original is never removed.
      if (!legacyComplete) out.legacyUnreadable = true;
    }
  }

  // 4. Images still held inline (taken-over items, or an earlier attempt that ran out of space) → files.
  const moved = await externalizeImages(out.items, files);
  out.items = moved.items;
  out.inlineImages = moved.remainingInline;
  if (moved.changed) publish = true;

  writable = out.writable;
  incident = out.incident;
  storedDone = null;

  // 5. Publish the index — one key, confirmed by reading it back.
  let storedIds: Set<string> | null = null;
  if (out.writable) {
    if (publish) {
      const snapshot = serializeQueue(out.items);
      if (snapshot.length <= MAX_INDEX_CHARS && (await storeVerified(OFFLINE_QUEUE_KEY, snapshot))) {
        storedIds = new Set(out.items.map((it) => it.id));
      }
      // Not stored: every source stays where it is, and the next start repeats this.
    } else if (index.ok) {
      // Nothing to publish: the stored index is exactly what was read.
      storedIds = new Set(out.items.map((it) => it.id));
    }
  }

  // 6. The earlier version's queue goes only when the STORED index (or the
  //    finished list) accounts for every item of it — never on the flag alone.
  if (legacyItems && legacyMark && storedIds && uncoveredIds(legacyItems, storedIds, out.doneIds).length === 0) {
    let flagged = alreadyTakenOver;
    if (!flagged) {
      try {
        await AsyncStorage.setItem(MIGRATED_FLAG_KEY, legacyMark);
        flagged = true;
      } catch {
        /* repeated at the next start */
      }
    }
    if (flagged && legacyComplete) {
      try {
        await AsyncStorage.removeItem(LEGACY_QUEUE_KEY);
      } catch {
        /* repeated at the next start */
      }
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
 *
 * Two single-key writes, the finished list FIRST. Whatever interrupts them
 * leaves a state that is safe to start from:
 *   • neither stored          — as before the call;
 *   • only the finished list  — the index still lists a finished item; the next
 *                               start drops it (it is recorded as finished);
 *   • both                    — done.
 * The index never gets ahead of the finished list, so a photo left behind by an
 * uploaded scan is always recognised as finished and never taken for new work.
 */
export function saveQueue(items: QueueItem[], doneIds: readonly string[] = []): Promise<boolean> {
  if (!writable) return Promise.resolve(false);
  const snapshot = serializeQueue(items);
  const done = JSON.stringify(doneIds.slice(-MAX_DONE_IDS));
  const run = async (): Promise<boolean> => {
    if (done !== storedDone) {
      try {
        await AsyncStorage.setItem(DONE_KEY, done);
        storedDone = done;
      } catch {
        return false;
      }
    }
    // An index that large could be written but not read back on Android.
    if (snapshot.length > MAX_INDEX_CHARS) return false;
    try {
      await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, snapshot);
      return true;
    } catch {
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

/**
 * The user's own, confirmed decision: remove the kept originals of a damaged
 * index. The record of the damage stays (it still decides which unlisted
 * photos wait for the user). Resolves the record as it now stands, or null
 * when nothing could be changed.
 */
export async function discardDamagedCopies(): Promise<QueueIncident | null> {
  if (!incident) return null;
  const remaining: string[] = [];
  for (const key of incident.copies) {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      remaining.push(key);
    }
  }
  const next: QueueIncident = { ...incident, copies: remaining, acknowledged: remaining.length === 0 };
  try {
    await AsyncStorage.setItem(INCIDENT_KEY, JSON.stringify(next));
  } catch {
    // The copies are gone; the note about it could not be updated. The next
    // start finds the keys empty and the notice simply shows once more.
  }
  incident = next;
  return next;
}
