// Phase 2 Batch 1 — the storage-side rules of the offline queue that need no
// device: taking over an earlier version's queue, moving inline images into
// files, restoring a scan from an image the index no longer lists, and the
// outcome of trying to keep a capture. Pure (the file store is injected);
// covered by lib/offline-reliability.test.ts.
import { isSafeScanId, type OrphanImage, type ScanFileFailure, type ScanFileStore, ScanFileError } from "./scan-files";
import { isTenantOwnerKey, type QueueItem } from "./offline-queue-model";

/** An index larger than this is not written: Android could store it but not read it back. */
export const MAX_INDEX_CHARS = 1_500_000;
/** How many finished ids are remembered (oldest dropped first). */
export const MAX_DONE_IDS = 400;

export function parseDoneIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0).slice(-MAX_DONE_IDS);
  } catch {
    return [];
  }
}

export function rememberDone(doneIds: readonly string[], id: string): string[] {
  if (doneIds.includes(id)) return doneIds.slice(-MAX_DONE_IDS);
  return [...doneIds, id].slice(-MAX_DONE_IDS);
}

/**
 * Add an earlier version's items to the index. An item is skipped when the
 * index already has its id (an interrupted take-over ran before) or when it is
 * recorded as finished — so repeating the take-over can never bring back work
 * that was already uploaded. Owners are carried over exactly as stored
 * (ownerless items stay quarantined); nothing is attributed to the account
 * that happens to be signed in.
 */
export function mergeLegacyItems(current: QueueItem[], legacy: QueueItem[], doneIds: readonly string[]): { items: QueueItem[]; added: number } {
  const known = new Set<string>([...current.map((it) => it.id), ...doneIds]);
  const fresh = legacy.filter((it) => !known.has(it.id));
  if (fresh.length === 0) return { items: current, added: 0 };
  return { items: [...current, ...fresh], added: fresh.length };
}

/**
 * Move every inline scan image into a file of its owner (quarantined items into
 * the quarantine directory). An item whose image cannot be written keeps it
 * inline — it is not lost, and the move is tried again at the next start.
 */
export async function externalizeImages(
  items: QueueItem[],
  files: ScanFileStore,
): Promise<{ items: QueueItem[]; changed: boolean; remainingInline: number }> {
  let changed = false;
  let remainingInline = 0;
  const out: QueueItem[] = [];
  for (const item of items) {
    if (item.kind !== "scan" || !item.imageData || item.imageFile) {
      out.push(item);
      continue;
    }
    if (!files.available() || !isSafeScanId(item.id)) {
      remainingInline += 1;
      out.push(item);
      continue;
    }
    try {
      const owner = isTenantOwnerKey(item.owner) ? item.owner : null;
      const stored = await files.saveImage(owner, item.id, item.imageData);
      const { imageData: _inline, ...rest } = item;
      out.push({ ...rest, imageFile: stored.file, imageBytes: stored.bytes });
      changed = true;
    } catch {
      remainingInline += 1;
      out.push(item);
    }
  }
  return { items: out, changed, remainingInline };
}

/** Creation time encoded in a queue id (`<epoch ms>-<random>`), or the fallback. */
export function createdAtOfId(id: string, fallback: number): number {
  const ms = Number(id.split("-")[0]);
  return Number.isFinite(ms) && ms > 1_500_000_000_000 && ms < 4_000_000_000_000 ? ms : fallback;
}

/** Why a recovered photo waits for the user instead of being sent (see {@link recoveredItems}). */
export const RECOVERED_DETAILS_LOST = "recovered_details_lost";

/**
 * Queue items for image files of `owner` that the index does not list. They
 * come back as scans of that same account; the capture's event and position
 * are not known any more.
 *
 * Two cases, told apart by `damagedAt` (when the list of pending captures was
 * last found damaged; 0 = never):
 *   • the photo is NEWER than that — the app stopped between writing the photo
 *     and its entry. Nothing else was ever known about it: it is an ordinary
 *     waiting scan.
 *   • the photo is from BEFORE the damage — its entry existed and was lost with
 *     the list. That entry may have said the card was already read, or already
 *     sent, or which contact the user chose for it. Sending the photo again
 *     unasked could repeat that work, so it is NOT sent by itself: it waits,
 *     marked as needing attention, until the user decides (send it as a new
 *     card, or remove it).
 */
export function recoveredItems(orphans: OrphanImage[], owner: string, now: number, damagedAt = 0): QueueItem[] {
  if (!isTenantOwnerKey(owner)) return [];
  return orphans.map((o) => {
    const createdAt = createdAtOfId(o.id, now);
    const base = {
      id: o.id,
      kind: "scan" as const,
      createdAt,
      attempts: 0,
      owner,
      label: "",
      source: "card",
      imageFile: o.file,
      imageBytes: o.bytes,
      recovered: true,
    };
    if (damagedAt > 0 && createdAt <= damagedAt) {
      return { ...base, status: "failed" as const, retryable: false, errorKind: RECOVERED_DETAILS_LOST };
    }
    return { ...base, status: "pending" as const };
  });
}

/** How many copies of a damaged list are kept at most (each under a key of its own). */
export const MAX_DAMAGED_COPIES = 3;

/**
 * The record of the list of pending captures having been found damaged. Kept
 * for good (it is a few bytes): `at` decides which unlisted photos must wait
 * for the user, long after the notice itself was dismissed.
 */
export interface QueueIncident {
  /**
   * `damaged` — the stored list could not be read as it was;
   * `lost`    — no list was stored at all although photos of captures are on
   *             the device (the store was cleared or replaced underneath the app).
   */
  kind: "damaged" | "lost";
  /** When the damage was (last) found. */
  at: number;
  /** Entries read from the damaged list and put back, exactly as they were stored. */
  salvaged: number;
  /** Entries that were there but could not be read; null = it cannot be told how many. */
  unreadable: number | null;
  /** Storage keys that hold the damaged original(s), untouched. */
  copies: string[];
  /** The user has seen the report and removed the kept copies. */
  acknowledged: boolean;
}

export function parseIncident(raw: string | null): QueueIncident | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown> | null;
    if (!v || typeof v !== "object" || typeof v.at !== "number" || !Number.isFinite(v.at) || v.at <= 0) return null;
    return {
      kind: v.kind === "lost" ? "lost" : "damaged",
      at: v.at,
      salvaged: typeof v.salvaged === "number" && v.salvaged >= 0 ? v.salvaged : 0,
      unreadable: typeof v.unreadable === "number" && v.unreadable >= 0 ? v.unreadable : null,
      copies: Array.isArray(v.copies) ? v.copies.filter((k): k is string => typeof k === "string" && k.length > 0).slice(0, MAX_DAMAGED_COPIES) : [],
      acknowledged: v.acknowledged === true,
    };
  } catch {
    return null;
  }
}

/** Is there something about a damaged list the user has not dealt with yet? */
export function incidentNeedsAttention(incident: QueueIncident | null): boolean {
  return !!incident && (!incident.acknowledged || incident.copies.length > 0);
}

/**
 * What to do about the photos of `owner` that the list does not name
 * (contexts/OfflineContext.tsx carries it out):
 *   • `remove`  — photos of work recorded as finished (their file was left behind);
 *   • `restore` — photos that come back as scans (see {@link recoveredItems} for
 *                 which of them wait for the user).
 * A photo that is listed, or being saved right now, is not touched.
 */
export function planAdoption(input: {
  orphans: OrphanImage[];
  owner: string;
  doneIds: readonly string[];
  /** Ids in the queue or being saved at this moment. */
  presentIds: ReadonlySet<string>;
  now: number;
  /** Photos made up to this time lost their entry with a damaged or lost list (0 = no such event). */
  heldBefore: number;
}): { remove: OrphanImage[]; restore: QueueItem[] } {
  const done = new Set(input.doneIds);
  const remove = input.orphans.filter((o) => done.has(o.id));
  const candidates = input.orphans.filter((o) => !done.has(o.id) && !input.presentIds.has(o.id));
  return { remove, restore: recoveredItems(candidates, input.owner, input.now, input.heldBefore) };
}

/** Of restored photos: how many are ordinary waiting scans (the others wait for the user's decision). */
export function restoredToProcess(restored: readonly QueueItem[]): number {
  return restored.filter((it) => it.status === "pending").length;
}

/**
 * A short, stable mark of a stored value (its length and a 32-bit FNV-1a hash).
 * Used to recognise "this is the very same old queue that was already taken
 * over" — never as a security measure.
 */
export function fingerprintOf(raw: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `v2:${raw.length}:${h.toString(16)}`;
}

/** Ids of `legacy` that are neither in the stored index nor recorded as finished. */
export function uncoveredIds(legacy: readonly QueueItem[], storedIds: ReadonlySet<string>, doneIds: readonly string[]): string[] {
  const done = new Set(doneIds);
  return legacy.filter((it) => !storedIds.has(it.id) && !done.has(it.id)).map((it) => it.id);
}

/** Why a capture could not be kept on the device. */
export type EnqueueFailure =
  /** No tenant account is signed in. */
  | "no-owner"
  /** The device is (nearly) out of storage. */
  | "storage-full"
  /** The device refused to store it (file system or settings store). */
  | "storage-unavailable"
  /** The captured image is not usable. */
  | "image-invalid";

export type EnqueueResult = { ok: true; id: string } | { ok: false; reason: EnqueueFailure };

export function enqueueFailureOf(err: unknown): EnqueueFailure {
  if (err instanceof ScanFileError) {
    const f: ScanFileFailure = err.failure;
    if (f === "storage-full") return "storage-full";
    if (f === "image-invalid") return "image-invalid";
    return "storage-unavailable";
  }
  return "storage-unavailable";
}

/** i18n keys (title, body) telling the user a capture was NOT kept, and what to do. */
export function enqueueFailureKeys(reason: EnqueueFailure): { title: string; body: string } {
  switch (reason) {
    case "no-owner":
      return { title: "sync.notSignedInTitle", body: "sync.notSignedInBody" };
    case "storage-full":
      return { title: "sync.notSavedTitle", body: "sync.storageFullBody" };
    case "image-invalid":
      return { title: "sync.notSavedTitle", body: "sync.imageInvalidBody" };
    default:
      return { title: "sync.notSavedTitle", body: "sync.storageErrorBody" };
  }
}
