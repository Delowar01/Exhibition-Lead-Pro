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

/**
 * Queue items for image files of `owner` that the index does not list (the
 * index was damaged, or the app stopped between writing the image and the
 * index). They come back as ordinary pending scans of that same account; the
 * capture's event and position are not known any more.
 */
export function recoveredItems(orphans: OrphanImage[], owner: string, now: number): QueueItem[] {
  if (!isTenantOwnerKey(owner)) return [];
  return orphans.map((o) => ({
    id: o.id,
    kind: "scan" as const,
    status: "pending" as const,
    createdAt: createdAtOfId(o.id, now),
    attempts: 0,
    owner,
    label: "",
    source: "card",
    imageFile: o.file,
    imageBytes: o.bytes,
    recovered: true,
  }));
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
