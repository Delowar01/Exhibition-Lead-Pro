// Phase 2 Batch 1 — regression tests for the defects the independent review
// found. Each block states the scenario the review reproduced and asserts the
// corrected behaviour (the review's own probes asserted the faulty one).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, customFetch, setAuthTokenGetter, setOnUnauthorized } from "@workspace/api-client-react";

import { answerWasLost } from "./api-failure";
import { classifyRefreshFailure, decideOnUnauthorized, isCredentialCheckRequest, type SessionSnapshot } from "./auth-session-model";
import ar from "./i18n/locales/ar.json";
import en from "./i18n/locales/en.json";
import {
  NO_AUTO_RETRY,
  autoSyncCandidates,
  enqueueItem,
  isAccountWideRefusal,
  parseStoredQueue,
  planAutoRetry,
  repeatIsUnverifiable,
  resolveOwnedConflict,
  retryDelayMs,
  scanLinkOf,
  serializeQueue,
  syncOwnedQueue,
  syncTargets,
  type QueueItem,
  type SyncResult,
} from "./offline-queue-model";
import { classifySyncFailure, createPerformer, syncProblemKey, type SyncApi } from "./offline-sync";
import { SYNC_TIMEOUT_MS, withTimeout } from "./request-timeout";
import { createScanFileStore } from "./scan-files";
import { createMemoryAsyncStorage, type MemoryAsyncStorage } from "./testing/memory-async-storage";
import { createMemoryScanDriver, fakeImage } from "./testing/memory-scan-driver";

const storage = vi.hoisted(() => ({ current: null as unknown as MemoryAsyncStorage }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (k: string) => storage.current.getItem(k),
    setItem: (k: string, v: string) => storage.current.setItem(k, v),
    removeItem: (k: string) => storage.current.removeItem(k),
    multiSet: (p: [string, string][]) => storage.current.multiSet(p),
  },
}));

const A = "11@1";
const NOW = 1_800_000_000_000;
const httpError = (status: number, data?: unknown) => Object.assign(new Error(`HTTP ${status}`), { status, data });
const lost = () => new TypeError("Network request failed");

/**
 * The API as the sync sees it, with the server's real rules: a contact request
 * that names a scan links the scan to the contact; duplicate detection (by
 * e-mail here) is skipped whenever the request carries the user's decision.
 */
class Server implements SyncApi {
  scans = new Map<number, { id: number; contactId: number | null }>();
  contacts: Array<{ id: number; body: Record<string, unknown> }> = [];
  interactions: Array<{ contactId: number }> = [];
  calls: string[] = [];
  /** Handle the next request of this name, then lose its answer. */
  loseAnswerOf: string | null = null;
  /** Refuse the next request of this name before handling it. */
  failNext: Record<string, unknown> = {};
  next = 1;

  private fail(name: string): void {
    const err = this.failNext[name];
    if (err !== undefined) {
      delete this.failNext[name];
      throw err;
    }
  }
  async createScan() {
    this.calls.push("createScan");
    this.fail("createScan");
    const id = this.next++;
    this.scans.set(id, { id, contactId: null });
    return { id, extractedData: { email: "card@example.test", firstName: "Card" } };
  }
  async getScan(id: number) {
    this.calls.push("getScan");
    this.fail("getScan");
    const s = this.scans.get(id);
    if (!s) throw httpError(404, { error: "Scan not found" });
    return { id: s.id, contactId: s.contactId, extractedData: {} };
  }
  async createContact(input: Record<string, unknown>) {
    this.calls.push("createContact");
    this.fail("createContact");
    const email = input.email as string | undefined;
    const match = email ? this.contacts.find((c) => c.body.email === email) : undefined;
    if (match && input.dedupeResolution == null) {
      throw httpError(409, { code: "existing_contact_found", contact: { id: match.id, fullName: "Existing Person" } });
    }
    const scanId = typeof input.scanId === "number" ? input.scanId : null;
    if (scanId !== null && !this.scans.has(scanId)) throw httpError(400, { error: "Invalid scanId" });
    let id: number;
    if (input.dedupeResolution === "add_interaction") {
      id = input.matchedContactId as number;
      if (!this.contacts.some((c) => c.id === id)) throw httpError(400, { error: "Invalid matchedContactId" });
      this.interactions.push({ contactId: id });
    } else {
      id = this.next++;
      this.contacts.push({ id, body: input });
    }
    if (scanId !== null) this.scans.get(scanId)!.contactId = id;
    if (this.loseAnswerOf === "createContact") {
      this.loseAnswerOf = null;
      throw lost();
    }
    return { id };
  }
  async upsertOwnCard() {
    this.calls.push("upsertOwnCard");
    return { id: 1 };
  }
}

interface Device {
  queue: QueueItem[];
  server: Server;
  /** When set, the device refuses to store the next N queue writes. */
  refuseWrites: number;
  writes: number;
  synced: string[];
}
const device = (server = new Server()): Device => ({ queue: [], server, refuseWrites: 0, writes: 0, synced: [] });

function sync(d: Device, options: { force?: boolean; holdScans?: boolean } = {}): Promise<SyncResult> {
  const perform = createPerformer({ api: d.server, loadImage: async () => fakeImage(300, "X"), language: () => "en" });
  return syncOwnedQueue({
    owner: A,
    currentOwner: () => A,
    isOnline: () => true,
    getQueue: () => d.queue,
    setQueue: async (next) => {
      d.queue = next; // memory always follows; the STORED copy may not
      d.writes += 1;
      if (d.refuseWrites > 0) {
        d.refuseWrites -= 1;
        return false;
      }
      return true;
    },
    perform,
    classify: classifySyncFailure,
    now: () => NOW,
    force: options.force ?? true,
    holdScans: options.holdScans,
    onSynced: (item) => {
      d.synced.push(item.id);
    },
  });
}

const manual = (d: Device, id: string, payload: Record<string, unknown>): void => {
  d.queue = enqueueItem(d.queue, { kind: "contact", label: "m", source: "manual", payload: payload as never }, A, NOW, id)!;
};
const item = (d: Device, id: string): QueueItem | undefined => d.queue.find((it) => it.id === id);

// ---------------------------------------------------------------------------
describe("review 2 — a decision the user gave is not sent twice after a lost answer", () => {
  it('"Create separately": the answer is lost → the repeat is checked again, no second contact', async () => {
    const d = device();
    d.server.contacts.push({ id: 900, body: { email: "dup@example.test" } });
    manual(d, "i1", { firstName: "M", email: "dup@example.test" });
    await sync(d);
    expect(item(d, "i1")?.status).toBe("conflict");

    d.queue = resolveOwnedConflict(d.queue, "i1", A, "create_separate");
    d.server.loseAnswerOf = "createContact";
    const lostRun = await sync(d);
    expect(lostRun.stopped).toBe("offline");
    // The decision is gone and the doubt is recorded.
    expect(item(d, "i1")).toMatchObject({ status: "pending", uncertain: true });
    expect(item(d, "i1")?.resolution).toBeUndefined();

    await sync(d);
    // Exactly ONE separate contact exists; the repeat became a question for the user.
    expect(d.server.contacts.filter((c) => c.body.email === "dup@example.test")).toHaveLength(2);
    expect(item(d, "i1")).toMatchObject({ status: "conflict", conflict: { afterLostAnswer: true } });
  });

  it('"Add to this contact": the answer is lost → one interaction, not two', async () => {
    const d = device();
    d.server.contacts.push({ id: 900, body: { email: "dup@example.test" } });
    manual(d, "i1", { firstName: "M", email: "dup@example.test" });
    await sync(d);
    d.queue = resolveOwnedConflict(d.queue, "i1", A, "add_interaction");
    d.server.loseAnswerOf = "createContact";
    await sync(d);
    await sync(d);
    expect(d.server.interactions).toHaveLength(1);
    expect(item(d, "i1")?.status).toBe("conflict");
  });

  it("the same after a server error (5xx) instead of a lost connection", async () => {
    const d = device();
    d.server.contacts.push({ id: 900, body: { email: "dup@example.test" } });
    manual(d, "i1", { firstName: "M", email: "dup@example.test" });
    await sync(d);
    d.queue = resolveOwnedConflict(d.queue, "i1", A, "create_separate");
    d.server.failNext.createContact = httpError(500, { error: "Internal error" });
    await sync(d);
    expect(item(d, "i1")).toMatchObject({ status: "failed", uncertain: true });
    expect(item(d, "i1")?.resolution).toBeUndefined();
  });

  it("a scan-linked item KEEPS the decision: its repeat is checked against the scan instead", async () => {
    const d = device();
    d.server.contacts.push({ id: 900, body: { email: "card@example.test" } });
    d.queue = enqueueItem(d.queue, { kind: "scan", label: "c", source: "card", imageFile: "x.jpg" }, A, NOW, "s1")!;
    await sync(d);
    expect(item(d, "s1")?.status).toBe("conflict");
    d.queue = resolveOwnedConflict(d.queue, "s1", A, "add_interaction");
    d.server.loseAnswerOf = "createContact";
    await sync(d);
    expect(item(d, "s1")?.resolution).toMatchObject({ mode: "add_interaction" });
    expect(item(d, "s1")?.uncertain).toBeUndefined();
    await sync(d);
    // The scan already has its contact: nothing was sent again.
    expect(d.server.interactions).toHaveLength(1);
    expect(d.queue).toHaveLength(0);
  });

  it("a decision the server refuses as it stands (the contact it named is gone) is asked again on retry", async () => {
    const d = device();
    d.server.contacts.push({ id: 900, body: { email: "dup@example.test" } });
    manual(d, "i1", { firstName: "M", email: "dup@example.test" });
    await sync(d);
    d.queue = resolveOwnedConflict(d.queue, "i1", A, "add_interaction");
    d.server.contacts = []; // deleted meanwhile
    await sync(d);
    expect(item(d, "i1")).toMatchObject({ status: "failed", errorKind: "invalid", retryable: false });
    expect(item(d, "i1")?.resolution).toBeUndefined();
    expect(syncProblemKey("invalid")).toBe("sync.problem.rejected");
  });
});

// ---------------------------------------------------------------------------
describe("review 3 — a kept capture that names its scan asks the server before sending", () => {
  it("the screen's own request already created the contact: the sync sends nothing more", async () => {
    const d = device();
    await d.server.createScan();
    d.server.loseAnswerOf = "createContact";
    await d.server.createContact({ firstName: "OnlyName", scanId: 1 }).catch(() => {});
    expect(d.server.scans.get(1)?.contactId).not.toBeNull();
    d.server.calls = [];
    // what scan-review / batch-review keep after their request failed
    manual(d, "i2", { firstName: "OnlyName", scanId: 1, cardImageUrl: "/api/scans/1/image" });
    await sync(d);
    expect(d.server.calls).toEqual(["getScan"]);
    expect(d.server.contacts.filter((c) => c.body.firstName === "OnlyName")).toHaveLength(1);
    expect(d.queue).toHaveLength(0);
  });

  it("the scan has no contact yet: the contact is created once, linked to it", async () => {
    const d = device();
    await d.server.createScan();
    d.server.calls = [];
    manual(d, "i2", { firstName: "Late", scanId: 1 });
    await sync(d);
    expect(d.server.calls).toEqual(["getScan", "createContact"]);
    expect(d.server.scans.get(1)?.contactId).not.toBeNull();
  });

  it("the scan was deleted on the server: the reviewed details are still saved, without the dead link", async () => {
    const d = device();
    manual(d, "i2", { firstName: "Orphan", scanId: 77, cardImageUrl: "/api/scans/77/image" });
    await sync(d);
    expect(d.queue).toHaveLength(0);
    expect(d.server.contacts[0]?.body).toMatchObject({ firstName: "Orphan", scanId: null, cardImageUrl: null });
  });

  it("an answer that is not the API's for the scan question is never taken as 'not saved yet'", async () => {
    const d = device();
    await d.server.createScan();
    d.server.calls = [];
    d.server.failNext.getScan = lost();
    manual(d, "i2", { firstName: "Late", scanId: 1 });
    const r = await sync(d);
    expect(r.stopped).toBe("offline");
    expect(d.server.calls).toEqual(["getScan"]);
    expect(item(d, "i2")?.status).toBe("pending");
  });

  it("scanLinkOf / repeatIsUnverifiable", () => {
    const base = { kind: "contact" as const };
    expect(scanLinkOf({ ...base, payload: { scanId: 5 } as never })).toBe(5);
    expect(scanLinkOf({ ...base, payload: { firstName: "x" } as never })).toBeNull();
    expect(scanLinkOf({ kind: "scan", scanId: 9 })).toBe(9);
    expect(repeatIsUnverifiable({ ...base, payload: { firstName: "x" } as never })).toBe(true);
    expect(repeatIsUnverifiable({ ...base, payload: { scanId: 5 } as never })).toBe(false);
    expect(repeatIsUnverifiable({ kind: "scan" })).toBe(false);
    expect(repeatIsUnverifiable({ kind: "card" })).toBe(false);
  });

  it("the rapid and batch screens name the scan in their own contact request", () => {
    const camera = readFileSync(resolve(__dirname, "../app/capture-camera.tsx"), "utf8");
    expect(camera).toMatch(/createContact\.mutateAsync\(\{\s*data: \{ \.\.\.extractedToContact\(extracted, gps, eventId\), scanId: scan\.id, cardImageUrl:/);
    const batch = readFileSync(resolve(__dirname, "../app/batch-review.tsx"), "utf8");
    expect(batch).toMatch(/scanId: ocrResult\?\.scanId \?\? undefined,\n\s*\};\n\s*try \{\n\s*await createContact\.mutateAsync\(\{ data: payload \}\)/);
  });
});

// ---------------------------------------------------------------------------
describe("review 3d / 4 — 'possibly saved by an earlier attempt' only where that doubt is real", () => {
  it("the app was closed while a typed contact was being sent: its repeat is flagged, and a decision is asked again", async () => {
    const d = device();
    manual(d, "i3", { firstName: "M", email: "k@example.test" });
    d.queue = d.queue.map((it) => ({ ...it, status: "syncing" as const, resolution: { mode: "create_separate" as const } }));
    await d.server.createContact({ firstName: "M", email: "k@example.test" }); // the request DID arrive
    d.queue = parseStoredQueue(serializeQueue(d.queue));
    expect(item(d, "i3")).toMatchObject({ status: "pending", uncertain: true });
    expect(item(d, "i3")?.resolution).toBeUndefined();
    await sync(d);
    expect(item(d, "i3")?.conflict?.afterLostAnswer).toBe(true);
    expect(d.server.contacts).toHaveLength(1);
  });

  it("a scan-linked item left 'syncing' is NOT marked: the scan answers the question", () => {
    const raw = JSON.stringify([
      { id: "a", kind: "scan", status: "syncing", owner: A, label: "", source: "card", scanId: 4, createdAt: 1, attempts: 0 },
      { id: "b", kind: "contact", status: "syncing", owner: A, label: "", source: "card", payload: { scanId: 4 }, createdAt: 1, attempts: 0 },
      { id: "c", kind: "card", status: "syncing", owner: A, label: "", source: "card", cardPayload: { fullName: "x" }, createdAt: 1, attempts: 0 },
    ]);
    for (const it of parseStoredQueue(raw)) {
      expect(it.status).toBe("pending");
      expect(it.uncertain).toBeUndefined();
    }
  });

  it("a scan whose UPLOAD failed once, then meets a contact that existed all along: a plain 'already exists'", async () => {
    const d = device();
    d.server.contacts.push({ id: 500, body: { email: "card@example.test" } }); // a customer for years
    d.queue = enqueueItem(d.queue, { kind: "scan", label: "c", source: "card", imageFile: "x.jpg" }, A, NOW, "s1")!;
    d.server.failNext.createScan = lost();
    const first = await sync(d);
    expect(first.stopped).toBe("offline");
    expect(item(d, "s1")?.uncertain).toBeUndefined();
    await sync(d);
    expect(item(d, "s1")).toMatchObject({ status: "conflict", conflict: { contactId: 500 } });
    expect(item(d, "s1")?.conflict?.afterLostAnswer).toBeUndefined();
  });

  it("the wording no longer tells the user to remove the entry", () => {
    for (const locale of [en, ar] as const) {
      const text = locale.sync.problem.duplicateMaybeSaved;
      expect(text).toContain("{{name}}");
    }
    expect(en.sync.problem.duplicateMaybeSaved).not.toMatch(/remove/i);
    expect(ar.sync.problem.duplicateMaybeSaved).not.toContain("أزِل");
  });

  it("answerWasLost: only a request without an answer", () => {
    expect(answerWasLost(lost())).toBe(true);
    expect(answerWasLost(httpError(401, { error: "Session expired. Please sign in again." }))).toBe(false);
    expect(answerWasLost(httpError(503, { code: "AI_PROVIDER_UNAVAILABLE" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("review 5 / 6 — account and storage guards in the provider and the screens (source wiring)", () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");
  const provider = read("../contexts/OfflineContext.tsx");

  it("a capture kept after a failed request is stored for the account that made it", () => {
    expect(provider).toMatch(/const enqueueOwner = useCallback\(\s*\(capturedBy\?: string \| null\): string \| null => \{\s*if \(capturedBy !== undefined && capturedBy !== null\) return isTenantOwnerKey\(capturedBy\) \? capturedBy : null;/);
    expect(provider).toContain("const itemOwner = enqueueOwner(meta.owner);");
    // every screen that keeps a capture AFTER an awaited request hands over the account read before it
    const camera = read("../app/capture-camera.tsx");
    expect(camera).toContain("const capturedBy = captureOwner();");
    expect(camera).toContain("owner: capturedBy,");
    // every place the camera keeps a capture names the account that took it
    const keeps = camera.split("\n").filter((line) => line.includes("await keepForLater("));
    expect(keeps).toHaveLength(3);
    for (const line of keeps) expect(line).toMatch(/, capturedBy\);$/);
    expect(camera).toContain("void processRapid(imageData, gps, rapidPerfTiming, quality, capturedBy);");
    for (const screen of ["../app/scan-review.tsx", "../app/capture-manual.tsx"]) {
      const src = read(screen);
      expect(src).toContain("const savedBy = captureOwner();");
      expect(src).toContain("owner: savedBy,");
    }
    const batch = read("../app/batch-review.tsx");
    expect(batch).toContain("const batchOwner = useRef(captureOwner());");
    expect(batch.match(/owner: batchOwner\.current,/g)?.length).toBe(2);
  });

  it("no sync and no photo adoption while the stored queue could not be read", () => {
    const run = provider.slice(provider.indexOf("const runSync = useCallback("));
    expect(run.indexOf("if (!queueWritable()) return;")).toBeGreaterThan(0);
    expect(run.indexOf("if (!queueWritable()) return;")).toBeLessThan(run.indexOf("syncingRef.current = true;"));
    const adoption = provider.slice(provider.indexOf("const adoptedOwnerRef"));
    expect(adoption.indexOf("if (!queueWritable()) return;")).toBeGreaterThan(0);
    expect(adoption.indexOf("if (!queueWritable()) return;")).toBeLessThan(adoption.indexOf("scanFiles.findOrphans"));
  });

  it("an item whose request is under way cannot be removed; one save at a time on the forms", () => {
    expect(provider).toContain('if (target?.status === "syncing") return;');
    expect(read("../app/sync.tsx")).toContain("{isSyncingItem ? null : (");
    for (const screen of ["../app/scan-review.tsx", "../app/capture-manual.tsx"]) {
      expect(read(screen)).toMatch(/if \(savingRef\.current\) return;\s*savingRef\.current = true;/);
    }
  });

  it("the notice and the waiting times of one account do not carry over to the next", () => {
    expect(provider).toContain("const sameAccount = ownerRef.current === syncOwner;");
    expect(provider).toMatch(/autoSyncedOwnerRef\.current = owner \?\? null;\s*\/\/[^\n]*\n\s*setSyncNotice\(null\);\s*cancelAutoSync\(\);\s*autoRetryRef\.current = NO_AUTO_RETRY;/);
  });
});

// ---------------------------------------------------------------------------
describe("review 7 — the sync sends nothing whose outcome the device cannot record", () => {
  it("the 'being sent' mark cannot be stored: no request is made, the run stops", async () => {
    const d = device();
    manual(d, "i1", { firstName: "M" });
    d.refuseWrites = 5;
    const r = await sync(d);
    expect(r).toMatchObject({ stopped: "storage", attempted: 0, synced: 0 });
    expect(d.server.calls).toEqual([]);
    expect(item(d, "i1")?.status).toBe("pending");
  });

  it("the scan id cannot be stored: the contact request is NOT made", async () => {
    const d = device();
    d.queue = enqueueItem(d.queue, { kind: "scan", label: "c", source: "card", imageFile: "x.jpg" }, A, NOW, "s1")!;
    let writes = 0;
    const perform = createPerformer({ api: d.server, loadImage: async () => fakeImage(300, "X"), language: () => "en" });
    const r = await syncOwnedQueue({
      owner: A,
      currentOwner: () => A,
      isOnline: () => true,
      getQueue: () => d.queue,
      setQueue: async (next) => {
        d.queue = next;
        writes += 1;
        return writes !== 2; // 1 = "being sent" (stored), 2 = the scan id (refused)
      },
      perform,
      classify: classifySyncFailure,
      now: () => NOW,
      force: true,
    });
    expect(r.stopped).toBe("storage");
    expect(d.server.calls).toEqual(["createScan"]);
    expect(d.server.contacts).toHaveLength(0);
    expect(item(d, "s1")?.status).toBe("pending");
  });

  it("the removal after an upload cannot be stored: the photo is kept and the run stops", async () => {
    const d = device();
    manual(d, "i2", { firstName: "Next" });
    // added last = sent first
    d.queue = enqueueItem(d.queue, { kind: "scan", label: "c", source: "card", imageFile: "x.jpg" }, A, NOW, "s1")!;
    let writes = 0;
    const perform = createPerformer({ api: d.server, loadImage: async () => fakeImage(300, "X"), language: () => "en" });
    const r = await syncOwnedQueue({
      owner: A,
      currentOwner: () => A,
      isOnline: () => true,
      getQueue: () => d.queue,
      setQueue: async (next) => {
        d.queue = next;
        writes += 1;
        return writes < 3; // "being sent" and the scan id are stored; the removal is not
      },
      perform,
      classify: classifySyncFailure,
      now: () => NOW,
      force: true,
      onSynced: (it) => {
        d.synced.push(it.id);
      },
    });
    expect(r).toMatchObject({ stopped: "storage", synced: 1 });
    expect(d.synced).toEqual([]); // the photo was not deleted
    expect(d.server.calls).toEqual(["createScan", "createContact"]); // the next item was not sent
    expect(item(d, "i2")?.status).toBe("pending");
  });

  it("the run notice for it has its own wording in both languages", () => {
    expect(syncProblemKey("storage")).toBe("sync.problem.storageWrite");
    expect(en.sync.problem.storageWrite.length).toBeGreaterThan(20);
    expect(ar.sync.problem.storageWrite.length).toBeGreaterThan(20);
    expect(en.sync.problem.rejected.length).toBeGreaterThan(20);
    expect(ar.sync.problem.rejected.length).toBeGreaterThan(20);
  });
});

describe("review 7 — finished work is recorded even when the queue index cannot be written", () => {
  const INDEX = "csp_offline_queue_v2";
  const DONE = "csp_offline_done";
  beforeEach(() => {
    storage.current = createMemoryAsyncStorage();
  });
  async function freshModule() {
    vi.resetModules();
    return import("./offline-queue");
  }
  const files = () => createScanFileStore(createMemoryScanDriver());
  const contact = (id: string, extra: Partial<QueueItem> = {}): QueueItem => ({
    id,
    kind: "contact",
    status: "pending",
    createdAt: 1,
    attempts: 0,
    owner: A,
    label: "x",
    source: "manual",
    payload: { firstName: id } as never,
    ...extra,
  });

  it("an index too large to store: the finished ids are stored on their own", async () => {
    const mod = await freshModule();
    await mod.loadQueue(files());
    const huge = contact("big", { label: "y".repeat(1_600_000) });
    expect(await mod.saveQueue([huge], ["done-1"])).toBe(false);
    expect(storage.current.data.get(INDEX)).toBe("[]"); // the index stored before is untouched
    expect(JSON.parse(storage.current.data.get(DONE) ?? "[]")).toEqual(["done-1"]);
  });

  it("an entry recorded as finished is not brought back by a stale index", async () => {
    storage.current.data.set(INDEX, JSON.stringify([contact("1800000000001-aaa"), contact("1800000000002-bbb")]));
    storage.current.data.set(DONE, JSON.stringify(["1800000000001-aaa"]));
    const mod = await freshModule();
    const load = await mod.loadQueue(files());
    expect(load.items.map((it) => it.id)).toEqual(["1800000000002-bbb"]);
    // and the corrected index is stored, so the next start agrees
    expect(JSON.parse(storage.current.data.get(INDEX) ?? "[]").map((it: QueueItem) => it.id)).toEqual(["1800000000002-bbb"]);
  });
});

// ---------------------------------------------------------------------------
describe("review 8 — account-wide refusals and automatic retries", () => {
  it("a plan-limit refusal is asked once per run, not once per item", async () => {
    const d = device();
    for (const id of ["a", "b", "c"]) manual(d, id, { firstName: id });
    const refusal = httpError(409, { code: "LIMIT_EXCEEDED", error: "Contact limit reached" });
    d.server.createContact = async () => {
      d.server.calls.push("createContact");
      throw refusal;
    };
    const r = await sync(d, { force: false });
    expect(d.server.calls).toHaveLength(1);
    expect(r.failed).toBe(1);
    expect(d.queue.filter((it) => it.status === "failed")).toHaveLength(1);
    expect(d.queue.filter((it) => it.status === "pending")).toHaveLength(2);
  });

  it('"Sync now" tries account-wide refusals again; a refused PHOTO still waits for its own Retry', () => {
    const failed = (id: string, errorKind: string): QueueItem => ({
      id,
      kind: "scan",
      status: "failed",
      createdAt: 1,
      attempts: 1,
      owner: A,
      label: "",
      source: "card",
      retryable: false,
      errorKind,
    });
    const items = [failed("limit", "limit"), failed("perm", "permission"), failed("plan", "not_entitled"), failed("nocard", "no_card"), failed("img", "image_too_large")];
    expect(syncTargets(items, A, { now: NOW, force: true }).map((it) => it.id)).toEqual(["limit", "perm", "plan"]);
    expect(syncTargets(items, A, { now: NOW })).toEqual([]);
    expect(isAccountWideRefusal("limit")).toBe(true);
    expect(isAccountWideRefusal("no_card")).toBe(false);
    expect(isAccountWideRefusal(undefined)).toBe(false);
  });

  it("an AI hold leaves scans out of an automatic run without asking the server; contacts still sync", async () => {
    const d = device();
    d.queue = enqueueItem(d.queue, { kind: "scan", label: "c", source: "card", imageFile: "x.jpg" }, A, NOW, "s1")!;
    manual(d, "c1", { firstName: "Typed" });
    const r = await sync(d, { force: false, holdScans: true });
    expect(d.server.calls).toEqual(["createContact"]);
    expect(r).toMatchObject({ synced: 1, deferred: 1, reasonKind: null });
    expect(item(d, "s1")?.status).toBe("pending");
  });

  const result = (over: Partial<SyncResult> = {}): SyncResult => ({ attempted: 0, synced: 0, failed: 0, conflicts: 0, deferred: 0, stopped: null, reasonKind: null, ...over });
  const input = { remaining: 3, now: NOW, online: true, heldScans: false };

  it("work left behind is tried again after 30 s, 1, 2, 5, then every 15 minutes", () => {
    let state = NO_AUTO_RETRY;
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const plan = planAutoRetry(state, result({ attempted: 1, failed: 1 }), input);
      state = plan.state;
      delays.push(plan.nextInMs as number);
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 300_000, 900_000, 900_000, 900_000]);
    expect(delays[0]).toBe(retryDelayMs(1));
  });

  it("progress starts the sequence over; nothing left ends it", () => {
    const tired = { step: 4, rateHoldUntil: 0, aiHoldUntil: 0 };
    expect(planAutoRetry(tired, result({ attempted: 2, synced: 1, failed: 1 }), input)).toMatchObject({ state: { step: 1 }, nextInMs: 30_000 });
    expect(planAutoRetry(tired, result({ attempted: 1, synced: 1 }), { ...input, remaining: 0 })).toEqual({ state: NO_AUTO_RETRY, nextInMs: null });
  });

  it("no timer while offline, after an account change or without an account", () => {
    expect(planAutoRetry(NO_AUTO_RETRY, result({ stopped: "offline", reasonKind: "network" }), { ...input, online: false }).nextInMs).toBeNull();
    expect(planAutoRetry(NO_AUTO_RETRY, result({ stopped: "owner-changed" }), input)).toEqual({ state: NO_AUTO_RETRY, nextInMs: null });
    expect(planAutoRetry(NO_AUTO_RETRY, result({ stopped: "no-owner" }), input)).toEqual({ state: NO_AUTO_RETRY, nextInMs: null });
  });

  it("'too many requests' and 'AI unavailable' hold automatic runs back for the delay", () => {
    const rate = planAutoRetry(NO_AUTO_RETRY, result({ stopped: "rate-limited", reasonKind: "rate_limited" }), input);
    expect(rate.state.rateHoldUntil).toBe(NOW + 30_000);
    expect(rate.nextInMs).toBe(30_000);
    const ai = planAutoRetry(NO_AUTO_RETRY, result({ deferred: 2, reasonKind: "ai_unavailable" }), input);
    expect(ai.state.aiHoldUntil).toBe(NOW + 30_000);
    // a trigger during the hold (app to the foreground): scans were left out, nothing new is known
    const during = planAutoRetry(ai.state, result({ deferred: 2 }), { ...input, now: NOW + 10_000, heldScans: true });
    expect(during.state).toEqual(ai.state);
    expect(during.nextInMs).toBe(20_000);
    // the probe after the hold fails again: the next hold is longer
    const again = planAutoRetry(ai.state, result({ deferred: 2, reasonKind: "ai_unavailable" }), { ...input, now: NOW + 30_000 });
    expect(again.state.aiHoldUntil).toBe(NOW + 30_000 + 60_000);
  });

  it("autoSyncCandidates: waiting and self-healing items of the account only", () => {
    const base = { kind: "contact" as const, createdAt: 1, attempts: 0, label: "", source: "manual" };
    const items: QueueItem[] = [
      { ...base, id: "p", status: "pending", owner: A },
      { ...base, id: "f", status: "failed", owner: A, retryable: true },
      { ...base, id: "n", status: "failed", owner: A, retryable: false },
      { ...base, id: "c", status: "conflict", owner: A, conflict: { contactId: 1, name: null } },
      { ...base, id: "o", status: "pending", owner: "22@2" },
      { ...base, id: "q", status: "pending", owner: null },
    ];
    expect(autoSyncCandidates(items, A).map((it) => it.id)).toEqual(["p", "f"]);
    expect(autoSyncCandidates(items, null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("review 11 — a stalled request and leftovers of an interrupted write", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a request that does not answer is cancelled after its limit and counts as 'no answer'", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const hung = withTimeout(1_000, ({ signal }) =>
      new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        });
      }),
    );
    const outcome = hung.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const err = await outcome;
    expect(aborted).toBe(true);
    const scan: QueueItem = { id: "s", kind: "scan", status: "syncing", createdAt: 1, attempts: 0, owner: A, label: "", source: "card" };
    expect(classifySyncFailure(err, scan)).toMatchObject({ action: "stop", reason: "offline", kind: "network" });
  });

  it("an answered request is passed through and its timer is cleared", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(1_000, async () => "ok")).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
    expect(SYNC_TIMEOUT_MS.createScan).toBeGreaterThan(SYNC_TIMEOUT_MS.createContact);
  });

  it("temporary files of an interrupted write are removed; a running write and the photos are not", async () => {
    const driver = createMemoryScanDriver();
    const files = createScanFileStore(driver);
    const dir = `${driver.root()}11_1/`;
    const now = 1_800_000_600_000;
    const old = `${now - 20 * 60_000}-aaaaaaa`;
    const fresh = `${now - 5_000}-bbbbbbb`;
    await files.saveImage(A, `${now - 60 * 60_000}-ccccccc`, fakeImage(300, "P"));
    driver.files.set(`${dir}${old}.jpg.part`, "AAAA");
    driver.files.set(`${dir}${fresh}.jpg.part`, "AAAA");
    driver.files.set(`${dir}notes.txt.part`, "AAAA");
    expect(await files.cleanPartials(A, now)).toBe(1);
    expect(driver.names(dir).sort()).toEqual([`${now - 60 * 60_000}-ccccccc.jpg`, `${fresh}.jpg.part`, "notes.txt.part"].sort());
    expect(await files.cleanPartials("not-an-owner", now)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("review 1 / 9 — a 401 that is not about the session, and who may end a session", () => {
  const session = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
    generation: 1,
    accessToken: "T1",
    refreshToken: "R1",
    issuedTokens: ["T1"],
    ...over,
  });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  afterEach(() => {
    vi.unstubAllGlobals();
    setOnUnauthorized(null);
    setAuthTokenGetter(null);
  });

  it("the password-check endpoints are recognised, with or without a base URL or query", () => {
    for (const url of ["/api/auth/change-password", "https://api.example.test/api/auth/mfa/disable", "/api/auth/mfa/backup-codes?x=1"]) {
      expect(isCredentialCheckRequest(url)).toBe(true);
    }
    for (const url of ["/api/auth/me", "/api/contacts", "/api/auth/mfa/status", "/api/auth/change-password/other", "", null, undefined]) {
      expect(isCredentialCheckRequest(url)).toBe(false);
    }
  });

  it("a wrong current password neither renews nor ends the session — with or without a refresh token", () => {
    expect(decideOnUnauthorized(session(), "T1", "/api/auth/change-password")).toEqual({ action: "ignore" });
    expect(decideOnUnauthorized(session({ refreshToken: null }), "T1", "/api/auth/change-password")).toEqual({ action: "ignore" });
    // any other request of the session is unchanged
    expect(decideOnUnauthorized(session(), "T1", "/api/contacts")).toEqual({ action: "refresh", refreshToken: "R1" });
    expect(decideOnUnauthorized(session({ refreshToken: null }), "T1", "/api/contacts")).toEqual({ action: "end", reason: "expired" });
  });

  it("through the real API client: the handler is told where the request went, makes no renewal call, and the screen gets the 401", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return json(401, { error: "Current password is incorrect" });
      }),
    );
    setAuthTokenGetter(() => "T1");
    const decisions: unknown[] = [];
    setOnUnauthorized(async ({ failedToken, url }) => {
      const d = decideOnUnauthorized(session({ refreshToken: null }), failedToken, url);
      decisions.push(d);
      return null;
    });
    const call = customFetch("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword: "wrong", newPassword: "Abcdef12!" }) });
    await expect(call).rejects.toBeInstanceOf(ApiError);
    await expect(call).rejects.toMatchObject({ status: 401 });
    expect(decisions).toEqual([{ action: "ignore" }]);
    expect(urls).toHaveLength(1); // no retry, no renewal
    expect(urls[0]).toContain("/auth/change-password");
  });

  it("only the API's own refusal of a renewal ends the session", () => {
    expect(classifyRefreshFailure(httpError(401, { error: "Session revoked" }))).toEqual({ kind: "ended", reason: "expired" });
    expect(classifyRefreshFailure(httpError(403, { error: "Your organization is suspended" }))).toEqual({ kind: "ended", reason: "blocked" });
    // something in between answered (a proxy, a firewall, a public Wi-Fi sign-in page)
    expect(classifyRefreshFailure(httpError(403, "<html>Forbidden</html>"))).toEqual({ kind: "transient" });
    expect(classifyRefreshFailure(httpError(403, undefined))).toEqual({ kind: "transient" });
    expect(classifyRefreshFailure(httpError(401, { message: "login required" }))).toEqual({ kind: "transient" });
    expect(classifyRefreshFailure(httpError(503, { error: "unavailable" }))).toEqual({ kind: "transient" });
    expect(classifyRefreshFailure(lost())).toEqual({ kind: "transient" });
  });

  it("a profile edit does not disturb a renewal, rewrite the tokens or forget a merely blocked sign-in (source wiring)", () => {
    const auth = readFileSync(resolve(__dirname, "../contexts/AuthContext.tsx"), "utf8");
    const update = auth.slice(auth.indexOf("const updateUser = useCallback("), auth.indexOf("const dismissSessionNotice"));
    expect(update).not.toContain("sessionEpochRef");
    expect(update).not.toContain("loadSession(");
    expect(update).not.toContain("saveSession(");
    expect(update).toContain("await saveSessionUser(sessionToken, nextUser);");
    const handler = auth.slice(auth.indexOf("const handleUnauthorized = useCallback("), auth.indexOf("const login = useCallback("));
    expect(handler).toContain("generation: sessionEpochRef.current,");
    expect(handler).toContain("decideOnUnauthorized(snapshot, failedToken, url)");
    expect(handler).not.toContain("generationRef");
    expect(auth).toContain('if (reason === "expired") await forgetBiometricSession(ended);');
  });
});
