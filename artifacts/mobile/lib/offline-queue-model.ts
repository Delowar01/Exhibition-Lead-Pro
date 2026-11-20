// Persisted offline work (`csp_offline_queue`) as pure, framework-free rules, so
// OfflineContext stays a thin React/AsyncStorage shell and the account-isolation
// rules below are unit-tested.
//
// B25 Stage 1 — account-state isolation, part 2 (offline queue ownership).
// Every queued item (contact, scan, card) is TENANT data: it was captured by one
// authenticated user inside one tenant and must only ever be shown to, retried,
// removed or synchronized by that exact account. The queue therefore carries an
// `owner` on every item — the same deterministic key the settings isolation
// uses (`accountOwnerKey`: `<userId>@<companyId>`), restricted here to tenant
// accounts (a platform operator has no tenant and may not create tenant work).
//   • enqueue fails closed without a resolved tenant owner;
//   • the queue a signed-in account sees (list, counts) is only its own items;
//   • only the current owner's items are ever sent, and the owner is re-checked
//     immediately before every request, so an account switch mid-sync stops
//     the loop instead of sending the old owner's work under the new session;
//   • items written before ownership existed (or with malformed ownership)
//     are quarantined: never shown as somebody's work, never synced, never
//     adopted by whoever signs in next, never deleted silently;
//   • another account's items stay persisted, invisible, untouched, and come
//     back when their owner signs in again.
//
// Phase 2 Batch 1 — reliability of the queue itself:
//   • a scan's image is a FILE (`imageFile`), the queue holds only its name, so
//     the stored queue stays small however long the scanning session is;
//   • a scan syncs in two steps (card read → contact). The result of the first
//     step (`scanId`, `extracted`) is stored on the item BEFORE the second
//     request, so an interrupted sync resumes where it stopped instead of
//     reading the card — and creating the contact — a second time;
//   • a failure is classified. An expired session, a lost connection or a
//     changed account STOP the run and leave the items waiting; a contact that
//     already exists becomes a `conflict` a person resolves; only failures that
//     can heal on their own are retried automatically, with a growing delay;
//   • nothing is ever removed from the queue except after a confirmed upload or
//     by the user's own action.
import type { BusinessCardInput, ContactInput, ExtractedCardData } from "@workspace/api-client-react";

import { accountOwnerKey } from "./settings-model";

export type QueueItemKind = "scan" | "contact" | "card";
/**
 * `conflict` = the server found an existing contact that matches this capture
 * and created nothing; the user decides (add to it, create separately, remove).
 */
export type QueueItemStatus = "pending" | "syncing" | "failed" | "conflict";

/** The existing contact a queued capture collided with. */
export interface QueueConflict {
  contactId: number;
  name: string | null;
  /**
   * True when an EARLIER attempt of this item ended without an answer (the
   * connection was lost, the server timed out). The matching contact may then
   * be this very capture, saved by that attempt — the user is told so.
   */
  afterLostAnswer?: boolean;
}

/** The user's explicit answer to a conflict, sent with the next attempt. */
export interface QueueResolution {
  mode: "add_interaction" | "create_separate";
  /** Required for `add_interaction`: the existing contact to attach the capture to. */
  contactId?: number;
}

/**
 * A single piece of work captured while offline (or that failed to reach the
 * server) and is waiting to be synced.
 *
 * - `kind: "contact"` already holds a ready-to-send {@link ContactInput} payload
 *   (manual entry, QR/vCard, NFC, or a reviewed scan).
 * - `kind: "scan"` holds a base64 card image that still needs server-side OCR
 *   before a contact can be created.
 * - `kind: "card"` holds the user's own digital business card edit.
 */
export interface QueueItem {
  id: string;
  kind: QueueItemKind;
  status: QueueItemStatus;
  createdAt: number;
  attempts: number;
  /**
   * Account that captured this item (`<userId>@<companyId>`), stamped at
   * enqueue time. `null` = quarantined: written before ownership existed, or
   * with ownership metadata that failed validation. Never trusted, never synced,
   * never reassigned.
   */
  owner: string | null;
  /** Human-readable name shown in the Sync Center. */
  label: string;
  /** Where it came from: "card" | "badge" | "qr" | "manual" | "nfc" | "signature". */
  source: string;
  /** Raw failure text of an attempt made WITHOUT a classifier (older versions). Never shown as is. */
  lastError?: string;
  /** Why the last attempt failed (lib/api-failure.ts kinds, a scan-file failure or "malformed"). */
  errorKind?: string;
  /** For a failed item: may the app try again by itself? `false` = only when the user asks. */
  retryable?: boolean;
  /** Time of the last attempt (drives the automatic-retry delay). */
  lastAttemptAt?: number;
  /**
   * A request that creates this item's contact went out and no answer came
   * back, AND there is no scan on the server whose link could tell whether it
   * was handled (see {@link repeatIsUnverifiable}). Only then is it set.
   */
  uncertain?: boolean;
  /** Present while status === "conflict". */
  conflict?: QueueConflict;
  /** The user's decision for a conflict; consumed by the next attempt. */
  resolution?: QueueResolution;
  /** Present when kind === "contact". */
  payload?: ContactInput;
  /** Present when kind === "card" — the user's own digital business card edit. */
  cardPayload?: BusinessCardInput;
  /**
   * kind === "scan": the card image as an inline data URL. Only items written
   * by older versions (until migrated) and the web preview carry it.
   */
  imageData?: string;
  /** kind === "scan": name of the image file in the owner's offline-scan directory. */
  imageFile?: string;
  /** Size of that image in bytes (for the storage figure in the Sync Center). */
  imageBytes?: number;
  /** kind === "scan": id of the scan the server already created for this capture (step 1 done). */
  scanId?: number | null;
  /** kind === "scan": what the server read from the card in step 1. */
  extracted?: ExtractedCardData | null;
  /** True for a scan restored from an image file the queue no longer listed. */
  recovered?: boolean;
  /** App language active at capture time — drives OCR translation on sync. */
  appLanguage?: "en" | "ar";
  /** Event this capture belongs to — the one valid for ITS OWNER at capture time. */
  eventId?: number | null;
  /** GPS captured at scan time. */
  latitude?: number | null;
  longitude?: number | null;
  gpsAccuracy?: number | null;
}

/** Everything of an item except the fields the queue assigns itself. */
export type QueueItemDraft = Omit<QueueItem, "id" | "status" | "createdAt" | "attempts" | "owner">;

const TENANT_OWNER = /^[1-9][0-9]*@[1-9][0-9]*$/;

/** True for a well-formed TENANT owner key (`<userId>@<companyId>`, both positive integers). */
export function isTenantOwnerKey(value: unknown): value is string {
  return typeof value === "string" && TENANT_OWNER.test(value);
}

/**
 * The owner that may create and sync offline work: the signed-in user inside
 * their tenant. Same key as the settings isolation; a platform operator
 * (`<id>@platform`), an unresolved or absent user yield null (fail closed).
 */
export function queueOwnerKey(user: { id: number; companyId?: number | null } | null | undefined): string | null {
  const key = accountOwnerKey(user);
  return isTenantOwnerKey(key) ? key : null;
}

export function makeQueueId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Id of the scan on the server this item's contact is tied to — a queued scan
 * whose card was already read, or a reviewed contact that names its scan — or
 * null. The server links a scan to the contact created from it, so the sync
 * can ASK whether an earlier attempt already went through.
 */
export function scanLinkOf(item: Pick<QueueItem, "kind" | "scanId" | "payload">): number | null {
  const own = positiveInt(item.scanId);
  if (own !== null) return own;
  return item.kind === "contact" ? positiveInt(item.payload?.scanId) : null;
}

/**
 * True for an item whose repeat cannot be checked against the server: a contact
 * without a scan (manual entry, QR, NFC). For it, and only for it, a lost
 * answer leaves real doubt about whether the contact was created.
 */
export function repeatIsUnverifiable(item: Pick<QueueItem, "kind" | "scanId" | "payload">): boolean {
  return item.kind === "contact" && scanLinkOf(item) === null;
}

function isKind(v: unknown): v is QueueItemKind {
  return v === "scan" || v === "contact" || v === "card";
}

/**
 * Parse the persisted queue. Structure is validated item by item; the owner is
 * taken ONLY when it is a well-formed tenant key — a missing, malformed or
 * non-tenant owner becomes `null` (quarantined), never the current account.
 * Items left mid-"syncing" by a previous session are reset to pending; the
 * app stopped while their request was under way, so for an item whose repeat
 * cannot be checked that request counts as "answer lost" (and a decision the
 * user had given for it is asked again rather than sent a second time).
 */
export function parseStoredQueue(raw: string | null): QueueItem[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: QueueItem[] = [];
  for (const entry of parsed) {
    const item = normalizeStoredItem(entry);
    if (item) out.push(item);
  }
  return out;
}

/**
 * One stored entry as a queue item, or `null` when it is not one (no id, or a
 * kind this app does not know). See {@link parseStoredQueue} for the rules.
 */
export function normalizeStoredItem(entry: unknown): QueueItem | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const it = entry as Record<string, unknown>;
  if (typeof it.id !== "string" || it.id.length === 0 || !isKind(it.kind)) return null;
  const conflict = parseConflict(it.conflict);
  // A conflict without its contact cannot be resolved: it waits as an ordinary pending item.
  const status: QueueItemStatus = it.status === "failed" ? "failed" : it.status === "conflict" && conflict ? "conflict" : "pending";
  const interrupted = it.status === "syncing" && repeatIsUnverifiable(it as unknown as QueueItem);
  return {
    ...(it as unknown as QueueItem),
    status,
    ...(interrupted ? { uncertain: true, resolution: undefined } : {}),
    owner: isTenantOwnerKey(it.owner) ? it.owner : null,
    createdAt: typeof it.createdAt === "number" ? it.createdAt : 0,
    attempts: typeof it.attempts === "number" ? it.attempts : 0,
    label: typeof it.label === "string" ? it.label : "",
    source: typeof it.source === "string" ? it.source : "",
    conflict: status === "conflict" ? conflict ?? undefined : undefined,
    scanId: typeof it.scanId === "number" && Number.isInteger(it.scanId) && it.scanId > 0 ? it.scanId : undefined,
    imageFile: typeof it.imageFile === "string" && it.imageFile.length > 0 ? it.imageFile : undefined,
  };
}

function parseConflict(value: unknown): QueueConflict | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  if (typeof c.contactId !== "number" || !Number.isInteger(c.contactId) || c.contactId <= 0) return null;
  return {
    contactId: c.contactId,
    name: typeof c.name === "string" && c.name.length > 0 ? c.name : null,
    ...(c.afterLostAnswer === true ? { afterLostAnswer: true } : {}),
  };
}

/** What a stored queue value turned out to be. */
export interface StoredQueueReading {
  /**
   * `empty`   — nothing was stored;
   * `ok`      — every stored entry was read;
   * `damaged` — something is stored that could not be read as it is: the text
   *             is not a queue, or some of its entries are not queue items.
   */
  state: "empty" | "ok" | "damaged";
  /** Every entry that could be read. For `damaged`: what could be salvaged, exactly as it was stored. */
  items: QueueItem[];
  /**
   * Entries that are there but could not be read. A number only when it is
   * exact (a well-formed list with entries that are not queue items); `null`
   * for a damaged text, where it cannot be told how many were lost.
   */
  unreadable: number | null;
}

/**
 * Read a stored queue value WITHOUT giving up on the whole of it when a part
 * is bad. A value that is not valid JSON (a write that was cut short, a
 * damaged store) is searched for the complete entries it still contains; each
 * of them is a queue item exactly as it was stored, with its owner, its
 * progress and its details. Nothing is invented and nothing is repaired: an
 * entry that is itself incomplete is counted as unreadable, never guessed at.
 *
 * The caller must keep the original value whenever the state is `damaged`.
 */
export function readStoredQueue(raw: string | null): StoredQueueReading {
  if (raw === null || raw === "") return { state: "empty", items: [], unreadable: 0 };
  let entries: unknown[];
  let wellFormed = false;
  let countable = true;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      entries = parsed;
      wellFormed = true;
    } else if (parsed && typeof parsed === "object") {
      entries = [parsed]; // a single entry where a list was expected
    } else {
      return { state: "damaged", items: [], unreadable: null };
    }
  } catch {
    // Damaged text: what is complete is read; how much is missing cannot be told.
    entries = salvageJsonObjects(raw);
    countable = false;
  }
  const items: QueueItem[] = [];
  const seen = new Set<string>();
  let unreadable = 0;
  for (const entry of entries) {
    const item = normalizeStoredItem(entry);
    if (!item) unreadable += 1;
    else if (seen.has(item.id)) continue; // the same entry twice: one is enough
    else {
      seen.add(item.id);
      items.push(item);
    }
  }
  if (wellFormed && unreadable === 0) return { state: "ok", items, unreadable: 0 };
  return { state: "damaged", items, unreadable: countable ? unreadable : null };
}

/** Upper bound for the characters looked at while salvaging (bounds the work on hopeless input). */
const MAX_SALVAGE_STEPS = 40_000_000;

/**
 * The complete JSON objects found in a text that is not valid JSON as a whole.
 *
 * A broken entry does not end the search. After one, every following opening
 * brace is tried in turn as the start of an entry, each time reading with a
 * clean slate — whatever the damage did to quotes or braces before that point
 * no longer matters. Only objects that are queue entries themselves
 * (`looksLikeEntry`) are taken on that path, so an inner object of a broken
 * entry (its payload, say) is never mistaken for an entry. Once an entry is
 * found, reading continues normally from there.
 *
 * How many entries were LOST cannot be told from a damaged text (a damaged
 * stretch may have held one entry or ten), so no count is returned.
 */
function salvageJsonObjects(raw: string): unknown[] {
  const objects: unknown[] = [];
  let steps = 0;
  let from = 0;
  let resuming = false; // true after a broken entry: only whole queue entries are accepted
  while (from >= 0 && from < raw.length && steps < MAX_SALVAGE_STEPS) {
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    let failedAt = -1;
    let i = from;
    for (; i < raw.length; i += 1) {
      steps += 1;
      const ch = raw.charCodeAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === 92 /* backslash */) escaped = true;
        else if (ch === 34 /* " */) inString = false;
        continue;
      }
      if (ch === 34) inString = true;
      else if (ch === 123 /* { */) {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === 125 /* } */ && depth > 0) {
        depth -= 1;
        if (depth === 0) {
          let parsed: unknown;
          let ok = true;
          try {
            parsed = JSON.parse(raw.slice(start, i + 1));
          } catch {
            ok = false;
          }
          if (ok && (!resuming || looksLikeEntry(parsed))) {
            objects.push(parsed);
            resuming = false; // among the entries again
            start = -1;
          } else {
            failedAt = start;
            break;
          }
        }
      }
    }
    if (failedAt < 0 && start >= 0 && (depth > 0 || inString)) failedAt = start; // an entry that never closes (cut off)
    if (failedAt < 0) break;
    resuming = true;
    from = raw.indexOf("{", failedAt + 1); // -1 ends the search
  }
  return objects;
}

function looksLikeEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && v.id.length > 0 && isKind(v.kind);
}

/** Serialize for storage: every item exactly as held (owners included, quarantined ones as null). */
export function serializeQueue(items: QueueItem[]): string {
  return JSON.stringify(items);
}

/** The items the given account may see: its own, nothing else (none while logged out / unresolved). */
export function visibleQueue(items: QueueItem[], owner: string | null | undefined): QueueItem[] {
  if (!isTenantOwnerKey(owner)) return [];
  return items.filter((it) => it.owner === owner);
}

/** Delay before the app retries a failed item by itself, growing with the number of attempts. */
export function retryDelayMs(attempts: number): number {
  if (attempts <= 1) return 30_000;
  if (attempts === 2) return 60_000;
  if (attempts === 3) return 2 * 60_000;
  if (attempts === 4) return 5 * 60_000;
  return 15 * 60_000;
}

/**
 * Refusals that concern the ACCOUNT, not the item (plan limit reached, no
 * permission, feature not in the plan). They are not retried unasked, but one
 * "Sync now" tries them all again — an administrator may have changed things —
 * so the user does not have to retry item by item.
 */
const ACCOUNT_WIDE_REFUSALS: ReadonlySet<string> = new Set(["limit", "permission", "not_entitled"]);

export function isAccountWideRefusal(kind: string | undefined): boolean {
  return kind !== undefined && ACCOUNT_WIDE_REFUSALS.has(kind);
}

export interface SyncTargetOptions {
  /** Current time; when given, a failed item is skipped until its retry delay has passed. */
  now?: number;
  /**
   * The user asked ("Sync now"): ignore the retry delay, and try again items
   * refused for an account-wide reason. Never overrides `retryable: false` for
   * a refusal that concerns the item itself (an unreadable photo, for example).
   */
  force?: boolean;
}

/**
 * Items of the owner that a sync run may send:
 *   • every pending item;
 *   • a failed item unless it is marked `retryable: false` (those wait for the
 *     user's own Retry; a forced run also takes the account-wide refusals) —
 *     and, when `now` is given, only once its delay passed;
 *   • never a conflict (it waits for the user's decision).
 */
export function syncTargets(items: QueueItem[], owner: string | null | undefined, options: SyncTargetOptions = {}): QueueItem[] {
  return visibleQueue(items, owner).filter((it) => {
    if (it.status === "pending") return true;
    if (it.status !== "failed") return false;
    if (it.retryable === false) return options.force === true && isAccountWideRefusal(it.errorKind);
    if (options.force || options.now === undefined || it.lastAttemptAt === undefined) return true;
    return options.now - it.lastAttemptAt >= retryDelayMs(it.attempts);
  });
}

/** Quarantined (ownerless / malformed-owner) items — reported only as a number. */
export function quarantinedCount(items: QueueItem[]): number {
  return items.filter((it) => it.owner === null).length;
}

export interface QueueCounts {
  /** Items still waiting to sync (pending + syncing). */
  pending: number;
  failed: number;
  /** Captures that match an existing contact and wait for the user's decision. */
  conflicts: number;
  /** Everything of this owner (pending + syncing + failed + conflicts). */
  queued: number;
}

/** Counts scoped to the owner; another account's items never influence them. */
export function queueCounts(items: QueueItem[], owner: string | null | undefined): QueueCounts {
  const mine = visibleQueue(items, owner);
  return {
    pending: mine.filter((it) => it.status === "pending" || it.status === "syncing").length,
    failed: mine.filter((it) => it.status === "failed").length,
    conflicts: mine.filter((it) => it.status === "conflict").length,
    queued: mine.length,
  };
}

/** True when the item exists and belongs to the owner (never for a foreign or quarantined item). */
export function ownsItem(items: QueueItem[], id: string, owner: string | null | undefined): boolean {
  if (!isTenantOwnerKey(owner)) return false;
  return items.some((it) => it.id === id && it.owner === owner);
}

/**
 * Add a new item for the owner. Returns the new queue, or `null` (nothing
 * added) when there is no resolved tenant owner — the caller must tell the
 * user the capture could not be kept. A card edit supersedes only the same
 * owner's earlier unsynced card edits; other accounts' card edits are kept.
 */
export function enqueueItem(
  items: QueueItem[],
  draft: QueueItemDraft,
  owner: string | null | undefined,
  now: number = Date.now(),
  id: string = makeQueueId(),
): QueueItem[] | null {
  if (!isTenantOwnerKey(owner)) return null;
  const item: QueueItem = { ...draft, id, status: "pending", createdAt: now, attempts: 0, owner };
  const base = draft.kind === "card" ? items.filter((it) => !(it.kind === "card" && it.owner === owner)) : items;
  return [item, ...base];
}

/**
 * Mark the owner's failed (or conflicting) item pending again; a foreign or
 * quarantined id changes nothing. Progress already made (`scanId`, `extracted`)
 * is kept, so a retry never repeats a step that succeeded.
 */
export function retryOwnedItem(items: QueueItem[], id: string, owner: string | null | undefined): QueueItem[] {
  if (!ownsItem(items, id, owner)) return items;
  return items.map((it) =>
    it.id === id
      ? { ...it, status: "pending" as const, lastError: undefined, errorKind: undefined, retryable: undefined, lastAttemptAt: undefined, conflict: undefined }
      : it,
  );
}

/**
 * Record the user's decision for the owner's conflicting item and queue it for
 * the next run. `add_interaction` needs the contact the conflict named; any
 * other id is refused (unchanged queue), as is a foreign or non-conflict item.
 */
export function resolveOwnedConflict(
  items: QueueItem[],
  id: string,
  owner: string | null | undefined,
  mode: QueueResolution["mode"],
): QueueItem[] {
  if (!ownsItem(items, id, owner)) return items;
  const target = items.find((it) => it.id === id);
  if (!target || target.status !== "conflict" || !target.conflict) return items;
  const resolution: QueueResolution = mode === "add_interaction" ? { mode, contactId: target.conflict.contactId } : { mode };
  return items.map((it) =>
    it.id === id
      ? { ...it, status: "pending" as const, resolution, conflict: undefined, lastError: undefined, errorKind: undefined, retryable: undefined, lastAttemptAt: undefined }
      : it,
  );
}

/**
 * Items of `before` that `next` no longer holds — what an enqueue replaced (an
 * earlier card edit of the same account). They will never be sent, so the
 * caller records them as finished: nothing may bring them back later.
 */
export function replacedBy(before: readonly QueueItem[], next: readonly QueueItem[]): QueueItem[] {
  const kept = new Set(next.map((it) => it.id));
  return before.filter((it) => !kept.has(it.id));
}

/** Remove the owner's item; a foreign/quarantined id changes nothing. */
export function removeOwnedItem(items: QueueItem[], id: string, owner: string | null | undefined): QueueItem[] {
  if (!ownsItem(items, id, owner)) return items;
  return items.filter((it) => it.id !== id);
}

/** Explicit, user-initiated discard of EVERY quarantined item (the only way they ever leave the device). */
export function discardQuarantined(items: QueueItem[]): QueueItem[] {
  return items.filter((it) => it.owner !== null);
}

/**
 * May a sync start? Only once the stored queue is hydrated, authentication has
 * resolved (owner !== undefined) and a tenant owner is signed in.
 */
export function canStartSync(state: { hydrated: boolean; owner: string | null | undefined }): boolean {
  return state.hydrated && isTenantOwnerKey(state.owner);
}

/** Thrown by {@link PerformContext.guard}: the run must end here, the item is left waiting. */
export class SyncAbort extends Error {
  readonly name = "SyncAbort";
  readonly reason: "owner-changed" | "offline" | "storage";
  constructor(reason: "owner-changed" | "offline" | "storage") {
    super(reason);
    Object.setPrototypeOf(this, new.target.prototype);
    this.reason = reason;
  }
}

/** What the engine hands to `perform` for one item. */
export interface PerformContext {
  /**
   * Call IMMEDIATELY before every network request of a multi-step item. Throws
   * {@link SyncAbort} when the account bound right now is not the account the
   * run was started for, or the device went offline — so a second request of
   * one item can never go out under another account's session.
   */
  guard(): void;
  /**
   * Store progress on the item (for example the scan id once the card is read)
   * and wait until it is durably written, BEFORE the next request is made.
   * Throws {@link SyncAbort} ("storage") when the device did not store it — the
   * next request is then not made.
   */
  progress(patch: Partial<Pick<QueueItem, "scanId" | "extracted" | "resolution">>): Promise<void>;
}

/** How one failed attempt is to be treated. */
export type SyncFailure =
  /**
   * End the run. The item (and every item after it) keeps waiting; nothing is
   * marked failed. `uncertain` = the request went out and no answer came back.
   */
  | { action: "stop"; reason: "auth" | "offline" | "owner-changed" | "rate-limited" | "storage"; kind: string; uncertain?: boolean }
  /** AI is unavailable for every card: this scan keeps waiting and no further scan is tried in this run. */
  | { action: "defer-scans"; kind: string }
  /** A matching contact exists: the item becomes a conflict for the user to resolve. */
  | { action: "conflict"; conflict: QueueConflict }
  /** The item failed. `retryable: false` = it is not retried until the user asks. */
  | { action: "fail"; kind: string; retryable: boolean; uncertain?: boolean };

export interface SyncDeps {
  /** Owner the sync runs for (captured at start). */
  owner: string | null | undefined;
  /** The owner bound RIGHT NOW — re-read immediately before every request. */
  currentOwner: () => string | null | undefined;
  isOnline: () => boolean;
  getQueue: () => QueueItem[];
  /**
   * Publish the next queue. May return a promise that resolves once it is
   * durably stored; resolving `false` means it was NOT stored, and the engine
   * then sends nothing further (it must be able to record what it does).
   */
  setQueue: (next: QueueItem[]) => void | Promise<unknown>;
  /** The network mutation(s) for one item, sent under the current session. */
  perform: (item: QueueItem, ctx: PerformContext) => Promise<void>;
  /**
   * Classifies what `perform` threw. Without it every failure marks the item
   * failed and retryable, with the error's message as `lastError` (the
   * behaviour of older versions).
   */
  classify?: (err: unknown, item: QueueItem) => SyncFailure;
  /**
   * Called synchronously when an item's upload is confirmed, BEFORE it leaves
   * the queue — so the caller can record the id as finished in the same write
   * that removes it (an image file left behind is then never taken for new work).
   */
  onUploaded?: (item: QueueItem) => void;
  /** Called once an item was uploaded and its removal from the queue is STORED (cleanup of its image file). */
  onSynced?: (item: QueueItem) => void | Promise<void>;
  now?: () => number;
  /** The user asked for this run: failed items are retried without waiting for their delay. */
  force?: boolean;
  /**
   * AI was unavailable for every card a moment ago: leave the scans waiting in
   * this run without asking again (contacts and card edits still sync).
   */
  holdScans?: boolean;
}

export interface SyncResult {
  attempted: number;
  synced: number;
  failed: number;
  /** Items that became a conflict in this run. */
  conflicts: number;
  /** Scans left waiting because AI is unavailable for every card right now. */
  deferred: number;
  /** Why the loop stopped before exhausting its targets (null = ran to the end). */
  stopped: "no-owner" | "owner-changed" | "offline" | "auth" | "rate-limited" | "storage" | null;
  /** The classified reason behind `stopped` / the deferral (for the message shown to the user). */
  reasonKind: string | null;
}

/**
 * Sync the owner's waiting items, one after another. Targets are selected for
 * the owner captured at start; before EACH request the bound owner is read
 * again and must still be the same account — otherwise no further request
 * starts (an in-flight request completes under the session it was sent with).
 * Foreign, quarantined and conflicting items are never targets.
 *
 * Every state change is published through `setQueue` and awaited, so the
 * stored queue never lags behind a request that was already answered. When
 * the device cannot store a change the run ends ("storage"): no request is
 * made whose outcome could not be recorded.
 *
 * Doubt about a lost answer (`uncertain`) is kept only where it is real — a
 * contact without a scan to check. There, a decision the user gave for a
 * conflict is dropped when its attempt ends without an answer, so the next
 * attempt is checked by the server's duplicate detection again instead of
 * being created a second time.
 */
export async function syncOwnedQueue(deps: SyncDeps): Promise<SyncResult> {
  const result: SyncResult = { attempted: 0, synced: 0, failed: 0, conflicts: 0, deferred: 0, stopped: null, reasonKind: null };
  const owner = deps.owner;
  if (!isTenantOwnerKey(owner)) {
    result.stopped = "no-owner";
    return result;
  }
  const now = deps.now ?? Date.now;
  /** Apply a change to the owner's item. Resolves false when the device did not store it. */
  const patch = async (id: string, change: (it: QueueItem) => QueueItem): Promise<boolean> => {
    return (await deps.setQueue(deps.getQueue().map((it) => (it.id === id && it.owner === owner ? change(it) : it)))) !== false;
  };
  const guard = (): void => {
    if (deps.currentOwner() !== owner) throw new SyncAbort("owner-changed");
    if (!deps.isOnline()) throw new SyncAbort("offline");
  };

  const targets = syncTargets(deps.getQueue(), owner, { now: now(), force: deps.force });
  let skipScans = deps.holdScans === true;
  // Item kinds refused for an account-wide reason in this run: the rest of that kind is not sent.
  const refusedKinds = new Set<QueueItemKind>();
  for (const target of targets) {
    if (!deps.isOnline()) {
      result.stopped = "offline";
      break;
    }
    if (deps.currentOwner() !== owner) {
      result.stopped = "owner-changed";
      break;
    }
    // The item must still be this owner's (it may have been removed meanwhile).
    const item = deps.getQueue().find((it) => it.id === target.id && it.owner === owner);
    if (!item) continue;
    if (skipScans && item.kind === "scan") {
      result.deferred += 1;
      continue;
    }
    if (refusedKinds.has(item.kind)) continue;
    result.attempted += 1;
    if (!(await patch(item.id, (it) => ({ ...it, status: "syncing" as const, lastError: undefined })))) {
      // The device cannot record this attempt: do not make it.
      await patch(item.id, (it) => ({ ...it, status: item.status }));
      result.attempted -= 1;
      result.stopped = "storage";
      break;
    }
    // The attempt is "open" only while the engine waits for it. Once its
    // outcome has been taken (an answer, a failure, a time limit), nothing that
    // still runs on its behalf may send a request or change the item: a
    // response that arrives late finds the attempt closed.
    let open = true;
    const ctx: PerformContext = {
      guard: () => {
        if (!open) throw new SyncAbort("offline");
        guard();
      },
      progress: async (change) => {
        if (!open) throw new SyncAbort("offline");
        if (!(await patch(item.id, (it) => ({ ...it, ...change })))) throw new SyncAbort("storage");
      },
    };
    let stored = true;
    try {
      const current = deps.getQueue().find((it) => it.id === item.id && it.owner === owner) ?? item;
      await deps.perform(current, ctx);
      open = false;
      const done = deps.getQueue().find((it) => it.id === item.id && it.owner === owner) ?? current;
      deps.onUploaded?.(done);
      stored = (await deps.setQueue(deps.getQueue().filter((it) => !(it.id === item.id && it.owner === owner)))) !== false;
      result.synced += 1;
      // The photo goes only once the removal is stored: until then the stored
      // queue still lists the item, and its next attempt finds it complete.
      if (stored && deps.onSynced) {
        try {
          await deps.onSynced(done);
        } catch {
          // Cleanup is best effort; the upload itself is complete.
        }
      }
    } catch (err) {
      open = false;
      const waiting = (it: QueueItem, kind: string | undefined): QueueItem => ({ ...it, status: "pending" as const, errorKind: kind, lastAttemptAt: now() });
      /** Doubt is recorded only where a repeat cannot be checked; a decision given for a conflict is then asked again. */
      const doubt = (it: QueueItem, lost: boolean | undefined): Partial<QueueItem> => {
        if (!repeatIsUnverifiable(it)) return { uncertain: undefined };
        if (!lost) return { uncertain: it.uncertain || undefined };
        return { uncertain: true, resolution: undefined };
      };
      if (err instanceof SyncAbort) {
        // Not a failure of the item: the run simply may not continue.
        result.attempted -= 1;
        await patch(item.id, (it) => ({ ...it, status: "pending" as const }));
        result.stopped = err.reason;
        break;
      }
      const failure: SyncFailure = deps.classify ? deps.classify(err, item) : { action: "fail", kind: "unknown", retryable: true };
      if (failure.action === "stop") {
        await patch(item.id, (it) => ({ ...waiting(it, failure.kind), ...doubt(it, failure.uncertain) }));
        result.attempted -= 1;
        result.stopped = failure.reason;
        result.reasonKind = failure.kind;
        break;
      }
      if (failure.action === "defer-scans") {
        stored = await patch(item.id, (it) => waiting(it, failure.kind));
        result.attempted -= 1;
        result.deferred += 1;
        result.reasonKind = failure.kind;
        skipScans = true;
      } else if (failure.action === "conflict") {
        result.conflicts += 1;
        stored = await patch(item.id, (it) => ({
          ...it,
          status: "conflict" as const,
          // "Possibly saved by an earlier attempt" only where that doubt is real.
          conflict: it.uncertain && repeatIsUnverifiable(it) ? { ...failure.conflict, afterLostAnswer: true } : failure.conflict,
          resolution: undefined,
          errorKind: "duplicate",
          retryable: false,
          lastAttemptAt: now(),
        }));
      } else {
        result.failed += 1;
        if (deps.classify && failure.retryable === false && isAccountWideRefusal(failure.kind)) refusedKinds.add(item.kind);
        stored = await patch(item.id, (it) => ({
          ...it,
          status: "failed" as const,
          attempts: it.attempts + 1,
          // Raw error text is kept only on the classifier-less path (older behaviour); it is never shown as is.
          lastError: deps.classify ? undefined : err instanceof Error ? err.message : "Sync failed",
          errorKind: deps.classify ? failure.kind : it.errorKind,
          retryable: deps.classify ? failure.retryable : it.retryable,
          ...doubt(it, failure.uncertain),
          // A decision that the server refused as it stands (the contact it named is gone) is asked again.
          ...(it.resolution && (failure.kind === "invalid" || failure.kind === "not_found") ? { resolution: undefined } : {}),
          lastAttemptAt: now(),
        }));
      }
    }
    if (!stored) {
      result.stopped = "storage";
      break;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Automatic retries — when the next run happens by itself (pure rules; the
// timer lives in contexts/OfflineContext.tsx).
//
// A run that leaves work behind is followed by another one after 30 s, then
// 1, 2, 5 and finally every 15 minutes. Progress (an item uploaded) starts the
// sequence over. Two situations hold work back in between, so that a trigger
// such as "app came to the foreground" does not ask the server again at once:
//   • the server said "too many requests" — no automatic run until the delay passed;
//   • AI is unavailable for every card  — scans are left out of automatic runs
//     until the delay passed (contacts and card edits keep syncing).
// A run the user asks for ("Sync now", Retry) ignores both.
// ---------------------------------------------------------------------------

export interface AutoRetryState {
  /** How many runs in a row left work behind without uploading anything. */
  step: number;
  /** No automatic run before this time (rate limit). 0 = none. */
  rateHoldUntil: number;
  /** Automatic runs leave scans waiting before this time (AI unavailable). 0 = none. */
  aiHoldUntil: number;
}

export const NO_AUTO_RETRY: AutoRetryState = { step: 0, rateHoldUntil: 0, aiHoldUntil: 0 };

/** The owner's items an automatic run could still send (now or later). */
export function autoSyncCandidates(items: QueueItem[], owner: string | null | undefined): QueueItem[] {
  return visibleQueue(items, owner).filter(
    (it) => it.status === "pending" || it.status === "syncing" || (it.status === "failed" && it.retryable !== false),
  );
}

export interface AutoRetryInput {
  /** `autoSyncCandidates(...).length` after the run. */
  remaining: number;
  now: number;
  /** Is the device online right now? Offline → no timer; the reconnect starts the next run. */
  online: boolean;
  /** This run left the scans out because of an AI hold (it learned nothing new about AI). */
  heldScans: boolean;
}

/** State after a run, and in how many milliseconds the next automatic run is due (null = none). */
export function planAutoRetry(state: AutoRetryState, result: SyncResult, input: AutoRetryInput): { state: AutoRetryState; nextInMs: number | null } {
  if (result.stopped === "no-owner" || result.stopped === "owner-changed") return { state: NO_AUTO_RETRY, nextInMs: null };
  if (input.remaining <= 0) return { state: NO_AUTO_RETRY, nextInMs: null };
  const aiHoldActive = state.aiHoldUntil > input.now;
  // Nothing was asked of the server that could have changed the picture: keep waiting for the hold to end.
  if (input.heldScans && result.attempted === 0 && result.synced === 0 && result.stopped === null && aiHoldActive) {
    return { state, nextInMs: input.online ? Math.max(state.aiHoldUntil - input.now, 1_000) : null };
  }
  const step = result.synced > 0 ? 1 : state.step + 1;
  const delay = retryDelayMs(step);
  const next: AutoRetryState = {
    step,
    rateHoldUntil: result.stopped === "rate-limited" ? input.now + delay : 0,
    aiHoldUntil: result.deferred > 0 && result.reasonKind !== null && !input.heldScans ? input.now + delay : aiHoldActive ? state.aiHoldUntil : 0,
  };
  return { state: next, nextInMs: input.online ? delay : null };
}
