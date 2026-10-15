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
import type { BusinessCardInput, ContactInput } from "@workspace/api-client-react";

import { accountOwnerKey } from "./settings-model";

export type QueueItemKind = "scan" | "contact" | "card";
export type QueueItemStatus = "pending" | "syncing" | "failed";

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
  lastError?: string;
  /** Present when kind === "contact". */
  payload?: ContactInput;
  /** Present when kind === "card" — the user's own digital business card edit. */
  cardPayload?: BusinessCardInput;
  /** Present when kind === "scan" — a data URL base64 image awaiting OCR. */
  imageData?: string;
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

function isKind(v: unknown): v is QueueItemKind {
  return v === "scan" || v === "contact" || v === "card";
}

/**
 * Parse the persisted queue. Structure is validated item by item; the owner is
 * taken ONLY when it is a well-formed tenant key — a missing, malformed or
 * non-tenant owner becomes `null` (quarantined), never the current account.
 * Items left mid-"syncing" by a previous session are reset to pending.
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
    if (!entry || typeof entry !== "object") continue;
    const it = entry as Record<string, unknown>;
    if (typeof it.id !== "string" || !isKind(it.kind)) continue;
    const status: QueueItemStatus = it.status === "failed" ? "failed" : "pending";
    out.push({
      ...(it as unknown as QueueItem),
      status,
      owner: isTenantOwnerKey(it.owner) ? it.owner : null,
      createdAt: typeof it.createdAt === "number" ? it.createdAt : 0,
      attempts: typeof it.attempts === "number" ? it.attempts : 0,
      label: typeof it.label === "string" ? it.label : "",
      source: typeof it.source === "string" ? it.source : "",
    });
  }
  return out;
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

/** Items of the owner that still need a sync attempt (pending or failed). */
export function syncTargets(items: QueueItem[], owner: string | null | undefined): QueueItem[] {
  return visibleQueue(items, owner).filter((it) => it.status === "pending" || it.status === "failed");
}

/** Quarantined (ownerless / malformed-owner) items — reported only as a number. */
export function quarantinedCount(items: QueueItem[]): number {
  return items.filter((it) => it.owner === null).length;
}

export interface QueueCounts {
  /** Items still waiting to sync (pending + syncing). */
  pending: number;
  failed: number;
  /** Everything of this owner (pending + syncing + failed). */
  queued: number;
}

/** Counts scoped to the owner; another account's items never influence them. */
export function queueCounts(items: QueueItem[], owner: string | null | undefined): QueueCounts {
  const mine = visibleQueue(items, owner);
  return {
    pending: mine.filter((it) => it.status === "pending" || it.status === "syncing").length,
    failed: mine.filter((it) => it.status === "failed").length,
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

/** Mark the owner's failed item pending again; a foreign/quarantined id changes nothing. */
export function retryOwnedItem(items: QueueItem[], id: string, owner: string | null | undefined): QueueItem[] {
  if (!ownsItem(items, id, owner)) return items;
  return items.map((it) => (it.id === id ? { ...it, status: "pending" as const, lastError: undefined } : it));
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

export interface SyncDeps {
  /** Owner the sync runs for (captured at start). */
  owner: string | null | undefined;
  /** The owner bound RIGHT NOW — re-read immediately before every request. */
  currentOwner: () => string | null | undefined;
  isOnline: () => boolean;
  getQueue: () => QueueItem[];
  setQueue: (next: QueueItem[]) => void;
  /** The network mutation(s) for one item, sent under the current session. */
  perform: (item: QueueItem) => Promise<void>;
}

export interface SyncResult {
  attempted: number;
  synced: number;
  failed: number;
  /** Why the loop stopped before exhausting its targets (null = ran to the end). */
  stopped: "no-owner" | "owner-changed" | "offline" | null;
}

/**
 * Sync the owner's pending/failed items, one request after another. Targets are
 * selected for the owner captured at start; before EACH request the bound owner
 * is read again and must still be the same account — otherwise no further
 * request starts (an in-flight request completes under the session it was sent
 * with). Foreign and quarantined items are never targets.
 */
export async function syncOwnedQueue(deps: SyncDeps): Promise<SyncResult> {
  const result: SyncResult = { attempted: 0, synced: 0, failed: 0, stopped: null };
  const owner = deps.owner;
  if (!isTenantOwnerKey(owner)) {
    result.stopped = "no-owner";
    return result;
  }
  const targets = syncTargets(deps.getQueue(), owner);
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
    result.attempted += 1;
    deps.setQueue(deps.getQueue().map((it) => (it.id === item.id ? { ...it, status: "syncing" as const, lastError: undefined } : it)));
    try {
      await deps.perform(item);
      deps.setQueue(deps.getQueue().filter((it) => it.id !== item.id));
      result.synced += 1;
    } catch (err) {
      result.failed += 1;
      deps.setQueue(
        deps.getQueue().map((it) =>
          it.id === item.id
            ? { ...it, status: "failed" as const, attempts: it.attempts + 1, lastError: err instanceof Error ? err.message : "Sync failed" }
            : it,
        ),
      );
    }
  }
  return result;
}
