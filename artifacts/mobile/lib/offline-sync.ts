// Phase 2 Batch 1 — what the offline sync sends for one queued item, and how a
// failed attempt is treated. Pure (the API and the image store are injected),
// so the interrupted-sync, duplicate-prevention and account-switch rules are
// unit-tested without a device.
//
// A queued SCAN is two requests against the existing API contract:
//   1. POST /scans      — the server reads the card and stores the scan;
//   2. POST /contacts   — the contact, linked to that scan (`scanId`).
// The scan id returned by step 1 is stored on the item before step 2 starts.
// When an attempt is interrupted after step 1 (connection lost, app closed,
// session ended), the next attempt does NOT read the card again: it asks the
// server whether that scan already has its contact (GET /scans/{id} →
// `contactId`) and only creates the contact when it does not. That link is the
// duplicate guard, and it needs no new server capability.
//
// The same question is asked for a queued CONTACT that names its scan (a card
// reviewed on screen whose save could not be completed, a rapid or batch
// capture kept after its contact request failed).
//
// What remains open without a server-side idempotency key:
//   • an attempt cut off DURING step 1, after the server stored the scan but
//     before the app received its id, is repeated from the start and can leave
//     one extra scan record without a contact. It never produces a second contact;
//   • a queued contact WITHOUT a scan (manual, QR, NFC) whose answer was lost
//     has no such link to check. Its repeat is caught by the server's own
//     duplicate detection (409 → conflict the user resolves, marked "possibly
//     saved by an earlier attempt"), and a decision the user had already given
//     for it is asked again instead of being sent twice; a contact too sparse
//     for that detection to match (a name only) can be created twice.
import type { BusinessCardInput, ContactInput, ExtractedCardData, ScanInput } from "@workspace/api-client-react";

import { classifyApiFailure, isAiWideFailure } from "./api-failure";
import { SyncAbort, type PerformContext, type QueueConflict, type QueueItem, type SyncFailure } from "./offline-queue-model";
import { ScanFileError } from "./scan-files";

/** The server answered with something that is not what the API returns (never treated as success). */
export class UnexpectedResponseError extends Error {
  readonly name = "UnexpectedResponseError";
  constructor(what: string) {
    super(`Unexpected response: ${what}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The queued item lacks what its kind needs (cannot be sent as it is). */
export class MalformedItemError extends Error {
  readonly name = "MalformedItemError";
  constructor() {
    super("Malformed queue item");
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The four existing API calls the sync uses. */
export interface SyncApi {
  createScan(input: ScanInput): Promise<unknown>;
  getScan(id: number): Promise<unknown>;
  createContact(input: ContactInput): Promise<unknown>;
  upsertOwnCard(input: BusinessCardInput): Promise<unknown>;
}

export interface PerformerDeps {
  api: SyncApi;
  /** The item's image as a data URL (from its file); throws ScanFileError when it cannot be read. */
  loadImage(item: QueueItem): Promise<string>;
  /** App language to use for a scan captured before the language was recorded. */
  language(): "en" | "ar";
}

/** Contact fields taken from what the server read on the card — the same mapping rapid capture uses. */
export function extractedToContact(data: ExtractedCardData, extra?: Partial<ContactInput>): ContactInput {
  return {
    firstName: data.firstName ?? null,
    lastName: data.lastName ?? null,
    jobTitle: data.jobTitle ?? null,
    contactCompany: data.company ?? null,
    email: data.email ?? null,
    mobile: data.mobile ?? null,
    officePhone: data.officePhone ?? null,
    website: data.website ?? null,
    linkedin: data.linkedin ?? null,
    country: data.country ?? null,
    address: data.address ?? null,
    ...extra,
  };
}

function positiveId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function resolutionFields(item: QueueItem): Partial<ContactInput> {
  const r = item.resolution;
  if (!r) return {};
  if (r.mode === "add_interaction" && positiveId(r.contactId) !== null) {
    return { dedupeResolution: "add_interaction", matchedContactId: r.contactId };
  }
  if (r.mode === "create_separate") return { dedupeResolution: "create_separate" };
  return {};
}

/** A created (or matched) contact must come back as an object with an id; anything else is not a success. */
function assertContact(value: unknown): void {
  if (positiveId(asRecord(value)?.id) === null) throw new UnexpectedResponseError("contact");
}

/**
 * Build the function the sync engine calls for one item. It performs the
 * item's request(s) under the session active at that moment and calls
 * `ctx.guard()` right before each one.
 */
export function createPerformer(deps: PerformerDeps): (item: QueueItem, ctx: PerformContext) => Promise<void> {
  const { api } = deps;

  async function performScan(item: QueueItem, ctx: PerformContext): Promise<void> {
    let scanId = positiveId(item.scanId);
    let extracted: ExtractedCardData | null = item.extracted ?? null;

    if (scanId !== null) {
      // Step 1 was completed by an earlier attempt. Was its contact created too?
      ctx.guard();
      let existing: Record<string, unknown> | null = null;
      try {
        existing = asRecord(await api.getScan(scanId));
        if (!existing || positiveId(existing.id) !== scanId) throw new UnexpectedResponseError("scan");
      } catch (err) {
        if (classifyApiFailure(err).kind !== "not_found") throw err;
        // The scan no longer exists on the server: start this capture over.
        existing = null;
        scanId = null;
        extracted = null;
        await ctx.progress({ scanId: null, extracted: null });
      }
      if (existing && positiveId(existing.contactId) !== null) return; // already complete: send nothing more
      if (existing && !extracted) extracted = (asRecord(existing.extractedData) as ExtractedCardData | null) ?? {};
    }

    if (scanId === null) {
      const imageData = item.imageData ?? (item.imageFile ? await deps.loadImage(item) : null);
      if (!imageData) throw new MalformedItemError();
      ctx.guard();
      const scan = asRecord(
        await api.createScan({
          imageData,
          appLanguage: item.appLanguage ?? deps.language(),
          eventId: item.eventId ?? undefined,
          latitude: item.latitude ?? undefined,
          longitude: item.longitude ?? undefined,
          gpsAccuracy: item.gpsAccuracy ?? undefined,
        }),
      );
      scanId = positiveId(scan?.id);
      if (scanId === null) throw new UnexpectedResponseError("scan");
      extracted = (asRecord(scan?.extractedData) as ExtractedCardData | null) ?? {};
      // Durable BEFORE the contact request: an interruption from here on resumes at step 2.
      await ctx.progress({ scanId, extracted });
    }

    ctx.guard();
    assertContact(
      await api.createContact({
        ...extractedToContact(extracted ?? {}, {
          eventId: item.eventId ?? null,
          latitude: item.latitude ?? null,
          longitude: item.longitude ?? null,
          gpsAccuracy: item.gpsAccuracy ?? null,
        }),
        scanId,
        cardImageUrl: `/api/scans/${scanId}/image`,
        ...resolutionFields(item),
      }),
    );
  }

  /**
   * A queued contact that names its scan: an earlier request for it (made by a
   * screen before the capture was kept, or by an interrupted sync) may already
   * have created the contact. The server links the scan to that contact, so ask
   * before sending anything.
   */
  async function performLinkedContact(item: QueueItem, payload: ContactInput, scanId: number, ctx: PerformContext): Promise<void> {
    ctx.guard();
    let scanGone = false;
    try {
      const existing = asRecord(await api.getScan(scanId));
      if (!existing || positiveId(existing.id) !== scanId) throw new UnexpectedResponseError("scan");
      if (positiveId(existing.contactId) !== null) return; // already saved: send nothing more
    } catch (err) {
      if (classifyApiFailure(err).kind !== "not_found") throw err;
      scanGone = true; // the scan was deleted on the server: the reviewed details are still worth saving
    }
    const body: ContactInput = scanGone ? { ...payload, scanId: null, cardImageUrl: null } : payload;
    ctx.guard();
    assertContact(await api.createContact({ ...body, ...resolutionFields(item) }));
  }

  return async function perform(item, ctx) {
    if (item.kind === "contact" && item.payload) {
      const linked = positiveId(item.payload.scanId);
      if (linked !== null) {
        await performLinkedContact(item, item.payload, linked, ctx);
        return;
      }
      ctx.guard();
      assertContact(await api.createContact({ ...item.payload, ...resolutionFields(item) }));
      return;
    }
    if (item.kind === "card" && item.cardPayload) {
      ctx.guard();
      if (!asRecord(await api.upsertOwnCard(item.cardPayload))) throw new UnexpectedResponseError("card");
      return;
    }
    if (item.kind === "scan" && (item.imageData || item.imageFile || positiveId(item.scanId) !== null)) {
      await performScan(item, ctx);
      return;
    }
    throw new MalformedItemError();
  };
}

function conflictFrom(err: unknown): QueueConflict | null {
  const data = asRecord((err as { data?: unknown } | null)?.data);
  const contact = asRecord(data?.contact);
  const contactId = positiveId(contact?.id);
  if (contactId === null) return null;
  const name =
    (typeof contact?.fullName === "string" && contact.fullName.trim()) ||
    [contact?.firstName, contact?.lastName].filter((p): p is string => typeof p === "string" && p.length > 0).join(" ") ||
    (typeof contact?.contactCompany === "string" && contact.contactCompany.trim()) ||
    null;
  return { contactId, name: name || null };
}

/**
 * How the engine treats what an attempt threw (see SyncFailure):
 *   • no answer, expired session, rate limit → STOP the run; items keep waiting;
 *   • AI unavailable for every card           → this and the remaining scans wait;
 *   • an existing matching contact            → conflict for the user to decide;
 *   • the image, the plan or a permission refuses this item → failed, retried
 *     only when the user asks (repeating it unasked could never succeed);
 *   • a server-side hiccup                    → failed, retried later with a delay.
 */
export function classifySyncFailure(err: unknown, item: QueueItem): SyncFailure {
  if (err instanceof SyncAbort) return { action: "stop", reason: err.reason, kind: err.reason };
  if (err instanceof ScanFileError) {
    // A missing or invalid image cannot heal by itself; an I/O hiccup can.
    return { action: "fail", kind: err.failure, retryable: err.failure === "storage-unavailable" };
  }
  if (err instanceof MalformedItemError) return { action: "fail", kind: "malformed", retryable: false };
  // No usable answer: the server may or may not have handled the request.
  if (err instanceof UnexpectedResponseError) return { action: "fail", kind: "server", retryable: true, uncertain: true };

  const failure = classifyApiFailure(err);
  switch (failure.kind) {
    case "network":
      // The request may have reached the server before the connection was lost.
      return { action: "stop", reason: "offline", kind: "network", uncertain: true };
    case "session_expired":
      return { action: "stop", reason: "auth", kind: "session_expired" };
    case "rate_limited":
      return { action: "stop", reason: "rate-limited", kind: "rate_limited" };
    case "duplicate": {
      const conflict = conflictFrom(err);
      return conflict ? { action: "conflict", conflict } : { action: "fail", kind: "duplicate", retryable: false };
    }
    case "upstream":
    case "server":
    case "unknown":
      return { action: "fail", kind: failure.kind, retryable: true, uncertain: true };
    default:
      if (isAiWideFailure(failure.kind)) {
        return item.kind === "scan" ? { action: "defer-scans", kind: failure.kind } : { action: "fail", kind: failure.kind, retryable: true };
      }
      // no_card, image_too_large, image_heic, invalid, limit, permission, not_entitled, not_found
      return { action: "fail", kind: failure.kind, retryable: false };
  }
}

/** i18n key (under `sync.`) explaining why a queued item is not synced yet. Unknown kinds fall back to a generic line. */
export function syncProblemKey(kind: string | undefined): string {
  switch (kind) {
    case "network":
      return "sync.problem.network";
    case "session_expired":
      return "sync.problem.session";
    case "rate_limited":
      return "sync.problem.rateLimited";
    case "duplicate":
      return "sync.problem.duplicate";
    case "ai_disabled":
      return "sync.problem.aiDisabled";
    case "ai_not_configured":
      return "sync.problem.aiNotConfigured";
    case "ai_unavailable":
    case "ai_platform_limit":
      return "sync.problem.aiUnavailable";
    case "ai_budget":
      return "sync.problem.aiBudget";
    case "no_card":
      return "sync.problem.noCard";
    case "image_too_large":
    case "image_heic":
    case "image-invalid":
      return "sync.problem.imageRejected";
    case "invalid":
      // A refused request is not always about the photo (an event that no longer exists, for example).
      return "sync.problem.rejected";
    case "image-missing":
      return "sync.problem.imageMissing";
    case "recovered_details_lost":
      return "sync.problem.recoveredDetailsLost";
    case "storage-unavailable":
    case "storage-full":
      return "sync.problem.storage";
    case "storage":
      // The run stopped because the device could not record its progress.
      return "sync.problem.storageWrite";
    case "limit":
      return "sync.problem.limit";
    case "permission":
    case "not_entitled":
      return "sync.problem.permission";
    default:
      return "sync.problem.generic";
  }
}
