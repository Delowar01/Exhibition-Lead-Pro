// Phase 2 Batch 1 — final reliability hardening (PR #11).
//
//   A. A damaged queue index: what can be read comes back, the original is
//      kept, the damage is reported, and nothing unknown is sent, deleted or
//      overwritten — through failed recovery writes and restarts.
//   B. Hard deadlines: a request that ignores cancellation still ends at its
//      limit, and whatever it does afterwards changes nothing.
//   C. The take-over of the earlier queue, interrupted after every single step,
//      without relying on several keys being written together.
//   D. The shared API client's 401 handling as the mobile app uses it.
//
// The real modules run against an in-memory AsyncStorage / file system that
// fail the way a phone does. Every case here was first reproduced as a defect
// (or ruled out) on the previous head of this branch.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, customFetch, setAuthTokenGetter, setOnUnauthorized } from "@workspace/api-client-react";

import { decideOnUnauthorized, type SessionSnapshot } from "./auth-session-model";
import ar from "./i18n/locales/ar.json";
import en from "./i18n/locales/en.json";
import {
  enqueueItem,
  readStoredQueue,
  retryOwnedItem,
  syncOwnedQueue,
  syncTargets,
  type PerformContext,
  type QueueItem,
  type SyncResult,
} from "./offline-queue-model";
import {
  MAX_DAMAGED_COPIES,
  RECOVERED_DETAILS_LOST,
  fingerprintOf,
  incidentNeedsAttention,
  parseIncident,
  planAdoption,
  recoveredItems,
  restoredToProcess,
  uncoveredIds,
  type QueueIncident,
} from "./offline-queue-store-model";
import { classifySyncFailure, createPerformer, syncProblemKey, type SyncApi } from "./offline-sync";
import { RequestTimeoutError, SESSION_RENEWAL_TIMEOUT_MS, SYNC_TIMEOUT_MS, withTimeout } from "./request-timeout";
import { ScanFileError, createScanFileStore } from "./scan-files";
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
const B = "22@2";
const INDEX = "csp_offline_queue_v2";
const LEGACY = "csp_offline_queue";
const FLAG = "csp_offline_queue_migrated";
const DONE = "csp_offline_done";
const DAMAGED = ["csp_offline_queue_damaged", "csp_offline_queue_damaged_2", "csp_offline_queue_damaged_3"];
const INCIDENT = "csp_offline_queue_incident";
const T0 = 1_800_000_000_000;

const SCAN = "1800000000001-aaaaaaa";
const CONTACT = "1800000000002-bbbbbbb";
const CARD = "1800000000003-ccccccc";
/** A queue as the app stores it: a scan that was already read by the server, a typed contact, a card edit. */
const queued = (): QueueItem[] => [
  { id: SCAN, kind: "scan", status: "pending", createdAt: 1800000000001, attempts: 0, owner: A, label: "Card", source: "card", imageFile: `${SCAN}.jpg`, imageBytes: 300, eventId: 7, latitude: 25.2, longitude: 55.3, scanId: 41, extracted: { email: "card@example.test" } },
  { id: CONTACT, kind: "contact", status: "conflict", createdAt: 1800000000002, attempts: 1, owner: B, label: "Sara {brace} \"quoted\"", source: "manual", payload: { firstName: "Sara", email: "sara@example.test", notes: "a } and a { and a \\ and \"x\"" } as never, conflict: { contactId: 9, name: "Sara" } },
  { id: CARD, kind: "card", status: "pending", createdAt: 1800000000003, attempts: 0, owner: A, label: "My card", source: "card", cardPayload: { fullName: "A user" } as never },
];

async function freshModule() {
  vi.resetModules();
  return import("./offline-queue");
}
const noFiles = () => createScanFileStore(createMemoryScanDriver());
const stored = (key: string): string | undefined => storage.current.data.get(key);
const storedIndex = (): QueueItem[] => JSON.parse(stored(INDEX) ?? "[]") as QueueItem[];
const storedIncident = (): QueueIncident | null => parseIncident(stored(INCIDENT) ?? null);

beforeEach(() => {
  storage.current = createMemoryAsyncStorage();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setOnUnauthorized(null);
  setAuthTokenGetter(null);
});

// ===========================================================================
describe("A — a damaged queue index: nothing recoverable is lost, and it is said", () => {
  /** The index as a write that was cut short leaves it: the last entry is incomplete. */
  const truncated = (): string => {
    const raw = JSON.stringify(queued());
    return raw.slice(0, raw.length - 25);
  };

  it("a cut-off index: the complete entries come back exactly as stored; the original is kept; the damage is recorded", async () => {
    const raw = truncated();
    storage.current.data.set(INDEX, raw);
    const mod = await freshModule();
    const load = await mod.loadQueue(noFiles(), T0);

    expect(load).toMatchObject({ writable: true, indexDamaged: true, damagedCopyFailed: false });
    // The scan keeps its owner, its event, its position and the fact that the server already read the card.
    expect(load.items.map((it) => it.id)).toEqual([SCAN, CONTACT]);
    expect(load.items[0]).toEqual(queued()[0]);
    expect(load.items[1]).toEqual(queued()[1]); // braces, quotes and backslashes inside the text included
    // The cut-off card edit cannot be read. How much a damaged text has lost cannot be told: no number is claimed.
    expect(load.incident).toEqual({ kind: "damaged", at: T0, salvaged: 2, unreadable: null, copies: [DAMAGED[0]], acknowledged: false });
    // The original, byte for byte, under a key of its own — and only then the readable index.
    expect(stored(DAMAGED[0])).toBe(raw);
    expect(storedIncident()).toEqual(load.incident);
    expect(storedIndex().map((it) => it.id)).toEqual([SCAN, CONTACT]);
    const order = storage.current.log.map(([k]) => k);
    expect(order.indexOf(DAMAGED[0])).toBeLessThan(order.indexOf(INCIDENT));
    expect(order.indexOf(INCIDENT)).toBeLessThan(order.indexOf(INDEX));
  });

  it("after a restart the recovered entries are simply there; the record and the original stay", async () => {
    const raw = truncated();
    storage.current.data.set(INDEX, raw);
    await (await freshModule()).loadQueue(noFiles(), T0);
    const again = await (await freshModule()).loadQueue(noFiles(), T0 + 60_000);
    expect(again).toMatchObject({ writable: true, indexDamaged: false });
    expect(again.items.map((it) => it.id)).toEqual([SCAN, CONTACT]);
    expect(again.incident).toEqual({ kind: "damaged", at: T0, salvaged: 2, unreadable: null, copies: [DAMAGED[0]], acknowledged: false });
    expect(incidentNeedsAttention(again.incident)).toBe(true);
    expect(stored(DAMAGED[0])).toBe(raw);
    expect(stored(DAMAGED[1])).toBeUndefined();
  });

  it("a later, different damage never overwrites the earlier original", async () => {
    storage.current.data.set(INDEX, "{first damaged value");
    await (await freshModule()).loadQueue(noFiles(), T0);
    storage.current.data.set(INDEX, "[{second damaged value");
    const second = await (await freshModule()).loadQueue(noFiles(), T0 + 5_000);
    expect(stored(DAMAGED[0])).toBe("{first damaged value");
    expect(stored(DAMAGED[1])).toBe("[{second damaged value");
    expect(second.incident).toMatchObject({ at: T0 + 5_000, copies: [DAMAGED[0], DAMAGED[1]], acknowledged: false });
  });

  it("a valid list with entries that are not queue items: the good ones stay, the original is kept, the bad ones are counted", async () => {
    const list: unknown[] = [...queued(), { kind: "contact", payload: { firstName: "NoId" } }, { id: "x", kind: "note" }, "garbage", null];
    const raw = JSON.stringify(list);
    storage.current.data.set(INDEX, raw);
    const load = await (await freshModule()).loadQueue(noFiles(), T0);
    expect(load.items.map((it) => it.id)).toEqual([SCAN, CONTACT, CARD]);
    expect(load.incident).toMatchObject({ kind: "damaged", salvaged: 3, unreadable: 4 }); // a well-formed list: here the count is exact
    expect(stored(DAMAGED[0])).toBe(raw);
  });

  it.each([
    ["a number", "42"],
    ["null", "null"],
    ["a text", '"hello"'],
    ["nothing recognisable", "\u0000\u0001 not json at all"],
  ])("a value that is not a queue (%s): kept, reported, and the queue starts empty but writable", async (_name, raw) => {
    storage.current.data.set(INDEX, raw);
    const mod = await freshModule();
    const load = await mod.loadQueue(noFiles(), T0);
    expect(load).toMatchObject({ items: [], writable: true, indexDamaged: true });
    expect(load.incident).toMatchObject({ salvaged: 0, unreadable: null, copies: [DAMAGED[0]] });
    expect(stored(DAMAGED[0])).toBe(raw);
    expect(await mod.saveQueue([queued()[2] as QueueItem])).toBe(true);
    expect(stored(DAMAGED[0])).toBe(raw); // a later save does not touch the original
  });

  describe("failed recovery writes: nothing is touched until the original is safe", () => {
    it("the original cannot be kept (no space): the damaged index stays where it is and nothing is written", async () => {
      const raw = truncated();
      storage.current.data.set(INDEX, raw);
      for (const key of DAMAGED) storage.current.failKeys.add(key);
      const mod = await freshModule();
      const load = await mod.loadQueue(noFiles(), T0);
      expect(load).toMatchObject({ items: [], writable: false, indexDamaged: true, damagedCopyFailed: true, incident: null });
      expect(stored(INDEX)).toBe(raw);
      expect(storage.current.log).toEqual([]);
      expect(await mod.saveQueue([queued()[2] as QueueItem])).toBe(false);
      expect(mod.queueWritable()).toBe(false);
      expect(stored(INDEX)).toBe(raw);

      // Space is back at the next start: now it recovers.
      storage.current.failKeys.clear();
      const next = await (await freshModule()).loadQueue(noFiles(), T0 + 1_000);
      expect(next).toMatchObject({ writable: true, damagedCopyFailed: false });
      expect(next.items.map((it) => it.id)).toEqual([SCAN, CONTACT]);
    });

    it("the original is kept but the record of it cannot be written: still nothing is replaced", async () => {
      const raw = truncated();
      storage.current.data.set(INDEX, raw);
      storage.current.failKeys.add(INCIDENT);
      const mod = await freshModule();
      const load = await mod.loadQueue(noFiles(), T0);
      expect(load).toMatchObject({ items: [], writable: false, damagedCopyFailed: true });
      expect(stored(INDEX)).toBe(raw);
      expect(stored(DAMAGED[0])).toBe(raw); // kept already — the next start recognises it

      storage.current.failKeys.clear();
      const next = await (await freshModule()).loadQueue(noFiles(), T0 + 1_000);
      expect(next.incident?.copies).toEqual([DAMAGED[0]]); // the same original is not stored twice
      expect(stored(DAMAGED[1])).toBeUndefined();
      expect(next.items).toHaveLength(2);
    });

    it("the readable index cannot be written: the entries are in use, the original is safe, and the restart repeats without a second copy", async () => {
      const raw = truncated();
      storage.current.data.set(INDEX, raw);
      storage.current.failKeys.add(INDEX);
      const mod = await freshModule();
      const load = await mod.loadQueue(noFiles(), T0);
      expect(load).toMatchObject({ writable: true, indexDamaged: true });
      expect(load.items).toHaveLength(2);
      expect(stored(INDEX)).toBe(raw);
      expect(stored(DAMAGED[0])).toBe(raw);
      expect(await mod.saveQueue(load.items)).toBe(false); // and the user is told captures cannot be kept

      storage.current.failKeys.clear();
      const next = await (await freshModule()).loadQueue(noFiles(), T0 + 90_000);
      expect(next.items).toHaveLength(2);
      expect(next.incident).toMatchObject({ at: T0, copies: [DAMAGED[0]] }); // the same incident, not a new one
      expect(stored(DAMAGED[1])).toBeUndefined();
      expect(storedIndex()).toHaveLength(2);
    });

    it("the original cannot be read back after writing it: it does not count as kept", async () => {
      const raw = truncated();
      storage.current.data.set(INDEX, raw);
      const realSet = storage.current.multiSet.bind(storage.current);
      storage.current.multiSet = async (pairs) => {
        await realSet(pairs.map(([k, v]) => (DAMAGED.includes(k) ? [k, v.slice(0, 10)] : [k, v]) as [string, string]));
      };
      const load = await (await freshModule()).loadQueue(noFiles(), T0);
      expect(load).toMatchObject({ writable: false, damagedCopyFailed: true });
      expect(stored(INDEX)).toBe(raw);
    });

    it("all places for originals are taken: nothing is overwritten; after the user removes the kept copies it recovers", async () => {
      for (let i = 0; i < MAX_DAMAGED_COPIES; i++) {
        storage.current.data.set(INDEX, `{damage number ${i}`);
        await (await freshModule()).loadQueue(noFiles(), T0 + i);
      }
      expect(DAMAGED.map(stored)).toEqual(["{damage number 0", "{damage number 1", "{damage number 2"]);

      const raw = truncated();
      storage.current.data.set(INDEX, raw);
      const mod = await freshModule();
      const blocked = await mod.loadQueue(noFiles(), T0 + 10);
      expect(blocked).toMatchObject({ items: [], writable: false, damagedCopyFailed: true });
      expect(stored(INDEX)).toBe(raw);
      expect(DAMAGED.map(stored)).toEqual(["{damage number 0", "{damage number 1", "{damage number 2"]);
      expect(blocked.incident?.copies).toEqual(DAMAGED); // the Sync Center offers their removal

      // The user's own, confirmed action — possible although nothing else is written.
      const after = await mod.discardDamagedCopies();
      expect(after).toMatchObject({ copies: [], acknowledged: true, at: T0 + 2 });
      expect(DAMAGED.map(stored)).toEqual([undefined, undefined, undefined]);
      expect(stored(INDEX)).toBe(raw); // the damaged index itself was not touched

      const next = await (await freshModule()).loadQueue(noFiles(), T0 + 20);
      expect(next).toMatchObject({ writable: true });
      expect(next.items).toHaveLength(2);
      expect(stored(DAMAGED[0])).toBe(raw);
      expect(next.incident).toMatchObject({ acknowledged: false, at: T0 + 20 });
    });
  });

  it("removing the kept copies is the user's decision only, and leaves the queue and the record of the damage", async () => {
    const raw = truncated();
    storage.current.data.set(INDEX, raw);
    const mod = await freshModule();
    await mod.loadQueue(noFiles(), T0);
    const before = stored(INDEX);
    const after = await mod.discardDamagedCopies();
    expect(after).toEqual({ kind: "damaged", at: T0, salvaged: 2, unreadable: null, copies: [], acknowledged: true });
    expect(incidentNeedsAttention(after)).toBe(false);
    expect(stored(DAMAGED[0])).toBeUndefined();
    expect(stored(INDEX)).toBe(before);
    // The time of the damage is kept for good: it still decides which unlisted photos wait.
    const later = await (await freshModule()).loadQueue(noFiles(), T0 + 1_000_000);
    expect(later.incident).toMatchObject({ at: T0, acknowledged: true });
    // Nothing in the source removes them without that call.
    const src = readFileSync(resolve(__dirname, "offline-queue.ts"), "utf8");
    const removals = src.split("\n").filter((l) => l.includes("removeItem("));
    expect(removals.map((l) => l.trim())).toEqual(["await AsyncStorage.removeItem(LEGACY_QUEUE_KEY);", "await AsyncStorage.removeItem(key);"]);
    expect(src.slice(src.indexOf("export async function discardDamagedCopies")).includes("await AsyncStorage.removeItem(key);")).toBe(true);
  });

  describe("entries without a recoverable photo, and photos without an entry", () => {
    const A_DIR = "file:///data/app/files/offline-scans/11_1/";

    it("a recovered scan whose photo is gone stays visible as 'photo no longer on this device' — never dropped, never retried unasked", async () => {
      // The entry as it comes back from a damaged list (the cut-off card edit behind it is lost).
      const damagedList = JSON.stringify([{ ...(queued()[0] as QueueItem), scanId: undefined, extracted: undefined }, queued()[2]]).slice(0, -30);
      const reading = readStoredQueue(damagedList);
      expect(reading).toMatchObject({ state: "damaged", unreadable: null });
      const items: QueueItem[] = reading.items;
      expect(items.map((it) => it.id)).toEqual([SCAN]);
      const files = noFiles(); // the photo file does not exist
      let queue = items;
      const api: SyncApi = { createScan: vi.fn(), getScan: vi.fn(), createContact: vi.fn(), upsertOwnCard: vi.fn() };
      const result = await syncOwnedQueue({
        owner: A,
        currentOwner: () => A,
        isOnline: () => true,
        getQueue: () => queue,
        setQueue: (next) => {
          queue = next;
        },
        perform: createPerformer({ api, loadImage: (it) => files.loadImage(it.owner, it.imageFile ?? ""), language: () => "en" }),
        classify: classifySyncFailure,
        now: () => T0,
      });
      expect(result).toMatchObject({ failed: 1, synced: 0 });
      expect(queue[0]).toMatchObject({ id: SCAN, status: "failed", errorKind: "image-missing", retryable: false });
      expect(api.createScan).not.toHaveBeenCalled();
      // Not dropped, and neither an automatic run nor "Sync now" tries it again.
      expect(queue).toHaveLength(1);
      expect(syncTargets(queue, A, { now: T0 + 999_999_999 })).toEqual([]);
      expect(syncTargets(queue, A, { now: T0 + 999_999_999, force: true })).toEqual([]);
      expect(syncProblemKey("image-missing")).toBe("sync.problem.imageMissing");
    });

    it("a recovered scan that the server had already read needs no photo: it resumes at the contact", async () => {
      // Read back from a damaged list: the entry still knows that the server has scan 41 of this card.
      const reading = readStoredQueue(JSON.stringify(queued()).slice(0, -25));
      let queue: QueueItem[] = reading.items.filter((it) => it.id === SCAN);
      expect(queue[0]).toMatchObject({ scanId: 41, eventId: 7 });
      const calls: string[] = [];
      const api: SyncApi = {
        createScan: async () => {
          calls.push("createScan");
          return {};
        },
        getScan: async () => {
          calls.push("getScan");
          return { id: 41, contactId: null, extractedData: {} };
        },
        createContact: async () => {
          calls.push("createContact");
          return { id: 77 };
        },
        upsertOwnCard: async () => ({}),
      };
      const result = await syncOwnedQueue({
        owner: A,
        currentOwner: () => A,
        isOnline: () => true,
        getQueue: () => queue,
        setQueue: (next) => {
          queue = next;
        },
        perform: createPerformer({
          api,
          loadImage: async () => {
            throw new ScanFileError("image-missing");
          },
          language: () => "en",
        }),
        classify: classifySyncFailure,
        now: () => T0,
      });
      expect(result.synced).toBe(1);
      expect(calls).toEqual(["getScan", "createContact"]);
    });

    it("a photo from BEFORE the damage lost its entry: it is put back but waits for the user, and is never sent by itself", () => {
      const before = { id: `${T0 - 60_000}-old0001`, file: `${T0 - 60_000}-old0001.jpg`, bytes: 300 };
      const after = { id: `${T0 + 60_000}-new0001`, file: `${T0 + 60_000}-new0001.jpg`, bytes: 300 };
      const restored = recoveredItems([before, after], A, T0 + 120_000, T0);
      expect(restored[0]).toMatchObject({ id: before.id, owner: A, kind: "scan", status: "failed", retryable: false, errorKind: RECOVERED_DETAILS_LOST, recovered: true, imageFile: before.file });
      // A photo newer than the damage only missed its entry (the app stopped mid-save): an ordinary waiting scan.
      expect(restored[1]).toMatchObject({ id: after.id, status: "pending", recovered: true });
      expect(restored[1]?.errorKind).toBeUndefined();

      // Neither an automatic run nor "Sync now" takes the held photo.
      expect(syncTargets(restored, A, { now: T0 + 999_999_999 }).map((it) => it.id)).toEqual([after.id]);
      expect(syncTargets(restored, A, { now: T0 + 999_999_999, force: true }).map((it) => it.id)).toEqual([after.id]);
      // Only the user's own Retry on that item releases it.
      const released = retryOwnedItem(restored, before.id, A);
      expect(syncTargets(released, A, { now: T0 + 999_999_999 }).map((it) => it.id).sort()).toEqual([before.id, after.id].sort());
      expect(retryOwnedItem(restored, before.id, B)).toBe(restored); // not by another account
      // Without any recorded damage nothing is held (the earlier behaviour).
      expect(recoveredItems([before], A, T0, 0)[0]?.status).toBe("pending");
      expect(syncProblemKey(RECOVERED_DETAILS_LOST)).toBe("sync.problem.recoveredDetailsLost");
    });

    it("end to end: the index is lost entirely, the photo is on the device — it is neither uploaded nor deleted, and it is still there after a restart", async () => {
      const driver = createMemoryScanDriver();
      const files = createScanFileStore(driver);
      await files.saveImage(A, SCAN, fakeImage(300, "A"));
      storage.current.data.set(INDEX, "\u0000 unreadable \u0000");
      const mod = await freshModule();
      const load = await mod.loadQueue(files, T0 + 5_000_000);
      expect(load.items).toEqual([]);
      // The plan the provider carries out for the signed-in account (the same function it calls):
      const orphans = await files.findOrphans(A, new Set<string>());
      const plan = planAdoption({ orphans, owner: A, doneIds: load.doneIds, presentIds: new Set(), now: T0 + 5_000_000, heldBefore: load.holdUnlistedBefore });
      expect(plan.remove).toEqual([]); // nothing is deleted
      const restored = plan.restore;
      expect(restoredToProcess(restored)).toBe(0); // …and nothing of it is announced as "will be processed"
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({ id: SCAN, status: "failed", retryable: false, errorKind: RECOVERED_DETAILS_LOST });
      expect(await mod.saveQueue(restored)).toBe(true);
      expect(syncTargets(restored, A, { force: true })).toEqual([]);
      expect(driver.names(A_DIR)).toEqual([`${SCAN}.jpg`]); // the photo was not touched

      const again = await (await freshModule()).loadQueue(files, T0 + 6_000_000);
      expect(again.items[0]).toMatchObject({ id: SCAN, status: "failed", retryable: false, errorKind: RECOVERED_DETAILS_LOST });
      expect(driver.names(A_DIR)).toEqual([`${SCAN}.jpg`]);
    });

    it("the provider carries out exactly that plan, with the recorded time of the damage (source wiring — the provider itself is not run by these tests)", () => {
      const provider = readFileSync(resolve(__dirname, "../contexts/OfflineContext.tsx"), "utf8");
      expect(provider).toContain("holdBeforeRef.current = stored.holdUnlistedBefore;");
      expect(provider).toMatch(/const plan = planAdoption\(\{[\s\S]{0,400}heldBefore: holdBeforeRef\.current,\s*\}\);/);
      expect(provider).toContain("for (const o of plan.remove) await scanFiles.deleteImage(owner, o.file);");
      expect(provider).toContain("setRecoveredCount(restoredToProcess(restored));");
      expect(provider).toContain("if (isOnlineRef.current && restoredToProcess(restored) > 0) void syncNow();");
      expect(provider).not.toContain("recoveredItems("); // no second, private version of the rule
    });
  });

  describe("readStoredQueue", () => {
    it("reads a healthy list unchanged and reports an empty one", () => {
      expect(readStoredQueue(null)).toEqual({ state: "empty", items: [], unreadable: 0 });
      expect(readStoredQueue("")).toEqual({ state: "empty", items: [], unreadable: 0 });
      const ok = readStoredQueue(JSON.stringify(queued()));
      expect(ok.state).toBe("ok");
      expect(ok.items).toEqual(queued());
      expect(readStoredQueue("[]")).toEqual({ state: "ok", items: [], unreadable: 0 });
    });

    it("salvages complete entries around damage in the middle, and never invents one", () => {
      const [a, b, c] = queued().map((it) => JSON.stringify(it)) as [string, string, string];
      const damaged = `[${a},{"id":"broken","kind":"scan","status":,${b}\u0000\u0000,${c}`;
      const reading = readStoredQueue(damaged);
      expect(reading.state).toBe("damaged");
      // The broken entry never closes — the entries AFTER it are found all the same, exactly as stored.
      expect(reading.items.map((it) => it.id)).toEqual([SCAN, CONTACT, CARD]);
      expect(reading.items).toEqual(queued());
      expect(reading.unreadable).toBeNull(); // how many a damaged text lost is never claimed
    });

    it("a broken entry with inner objects: those are not mistaken for entries, and hopeless input ends quickly", () => {
      const good = JSON.stringify(queued()[2]);
      // a contact whose text was damaged after its payload: the payload object itself is complete
      const brokenContact = '{"id":"1800000000002-bbbbbbb","kind":"contact","payload":{"firstName":"Sara","email":"sara@example.test"},"conflict":{"contactId":9,"name":"S"},"status":';
      const reading = readStoredQueue(`[${brokenContact},${good}`);
      expect(reading.items.map((it) => it.id)).toEqual([CARD]);
      expect(reading.unreadable).toBeNull();
      const hopeless = "{".repeat(50_000);
      const started = Date.now();
      expect(readStoredQueue(hopeless)).toMatchObject({ state: "damaged", items: [] });
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("an entry stored twice counts once; ownership rules still apply to salvaged entries", () => {
      const one = JSON.stringify(queued()[0]);
      const foreign = JSON.stringify({ ...queued()[2], id: "1800000000009-zzzzzzz", owner: "not-an-owner" });
      const reading = readStoredQueue(`[${one},${one},${foreign}`);
      expect(reading.items.map((it) => it.id)).toEqual([SCAN, "1800000000009-zzzzzzz"]);
      expect(reading.items[1]?.owner).toBeNull(); // quarantined, never attributed to anybody
    });
  });

  it("the damage is reported at once and in the Sync Center, in both languages (source wiring)", () => {
    const provider = readFileSync(resolve(__dirname, "../contexts/OfflineContext.tsx"), "utf8");
    expect(provider).toMatch(/if \(stored\.indexDamaged \|\| stored\.indexLost\) \{[\s\S]{0,500}Alert\.alert\(i18n\.t\(stored\.indexLost \? "sync\.lostTitle" : "sync\.damagedTitle"\), i18n\.t\(body\)\);/);
    expect(provider).toContain('stored.writable ? "none" : stored.damagedCopyFailed ? "index-damaged-unsaved" : "index-unreadable"');
    const screen = readFileSync(resolve(__dirname, "../app/sync.tsx"), "utf8");
    expect(screen).toContain('testID="notice-queue-damaged"');
    expect(screen).toContain("incidentNeedsAttention(incident)");
    expect(screen).toContain('"sync.storageDamagedUnsavedBody"');
    // removal of the kept copy is asked for first
    expect(screen).toMatch(/function confirmDiscardDamaged\(\) \{\s*Alert\.alert\(t\("sync\.damagedDiscardTitle"\), t\("sync\.damagedDiscardBody"\)/);
    for (const locale of [en, ar] as const) {
      const sync = locale.sync as Record<string, unknown>;
      for (const key of ["damagedTitle", "damagedAlertBody", "damagedBody", "damagedRecovered", "damagedUnreadable", "damagedUnreadableUnknown", "damagedPhotos", "damagedCopyKept", "damagedDiscard", "damagedDiscardTitle", "damagedDiscardBody", "damagedDismiss", "lostTitle", "lostAlertBody", "lostBody", "storageDamagedUnsavedBody"]) {
        expect(typeof sync[key], key).toBe("string");
        expect((sync[key] as string).length, key).toBeGreaterThan(8);
      }
      expect(locale.sync.damagedRecovered).toContain("{{count}}");
      expect(locale.sync.damagedUnreadable).toContain("{{count}}");
      expect(locale.sync.problem.recoveredDetailsLost.length).toBeGreaterThan(20);
    }
  });
});

// ===========================================================================
describe("B — hard deadlines: a request that ignores cancellation still ends, and nothing late gets through", () => {
  const hangs = () => new Promise<never>(() => {});

  it("a request that completely ignores the abort signal is ended at the limit", async () => {
    vi.useFakeTimers();
    let outcome: unknown = "pending";
    void withTimeout(1_000, hangs).then(
      () => {
        outcome = "resolved";
      },
      (e: unknown) => {
        outcome = e;
      },
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(2); // the limit, plus the one turn an answer that has just arrived is given
    expect(outcome).toBeInstanceOf(RequestTimeoutError);
    expect((outcome as RequestTimeoutError).name).toBe("TimeoutError");
    expect(vi.getTimerCount()).toBe(0);
    // For the sync that is "no answer": the run stops, the item keeps waiting.
    const scan: QueueItem = { id: "s", kind: "scan", status: "syncing", createdAt: 1, attempts: 0, owner: A, label: "", source: "card" };
    expect(classifySyncFailure(outcome, scan)).toMatchObject({ action: "stop", reason: "offline", kind: "network", uncertain: true });
  });

  it("the request is still asked to stop (a co-operating request frees its connection)", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const p = withTimeout(500, (o) => {
      signal = o.signal;
      return hangs();
    }).catch((e: unknown) => e);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(501);
    expect(signal?.aborted).toBe(true);
    expect(await p).toBeInstanceOf(RequestTimeoutError);
  });

  it("a late answer is dropped (or handed to onLate exactly once); a late failure concerns nobody", async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      let finish: (v: string) => void = () => {};
      const late: string[] = [];
      const first = withTimeout(100, () => new Promise<string>((r) => (finish = r)), { onLate: (v) => late.push(v) }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(101);
      expect(await first).toBeInstanceOf(RequestTimeoutError);
      finish("too late");
      await vi.advanceTimersByTimeAsync(0);
      expect(late).toEqual(["too late"]);

      // An onLate that throws must never surface as a new error…
      let finishLate: (v: string) => void = () => {};
      let threw = 0;
      const second = withTimeout(100, () => new Promise<string>((r) => (finishLate = r)), {
        onLate: () => {
          threw += 1;
          throw new Error("must not surface");
        },
      }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(101);
      expect(await second).toBeInstanceOf(RequestTimeoutError);
      finishLate("late");
      await vi.advanceTimersByTimeAsync(10);
      expect(threw).toBe(1);

      // …and a late FAILURE concerns nobody.
      let fail: (e: Error) => void = () => {};
      const third = withTimeout(100, () => new Promise<string>((_, r) => (fail = r))).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(101);
      expect(await third).toBeInstanceOf(RequestTimeoutError);
      fail(new Error("late failure"));
      await vi.advanceTimersByTimeAsync(10);
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 5));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("an answer that becomes due together with the deadline wins (the app was suspended and both are overdue)", async () => {
    vi.useFakeTimers();
    let answer: (v: string) => void = () => {};
    const p = withTimeout(1_000, () => new Promise<string>((r) => (answer = r)));
    // The deadline's timer and the answer are delivered in the same turn, the timer first.
    setTimeout(() => answer("arrived"), 1_000);
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(p).resolves.toBe("arrived");
  });

  it("an answer in time passes through untouched; a failure in time keeps its own error; a call that throws at once is reported", async () => {
    vi.useFakeTimers();
    const late = vi.fn();
    await expect(withTimeout(1_000, async () => "ok", { onLate: late })).resolves.toBe("ok");
    const boom = new Error("HTTP 500");
    await expect(withTimeout(1_000, async () => Promise.reject(boom))).rejects.toBe(boom);
    await expect(
      withTimeout(1_000, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(late).not.toHaveBeenCalled();
    expect(SYNC_TIMEOUT_MS.createScan).toBeGreaterThan(SYNC_TIMEOUT_MS.createContact);
    expect(SESSION_RENEWAL_TIMEOUT_MS).toBeGreaterThan(0);
  });

  /** A device whose API calls go through the same deadline wrapper the provider uses. */
  function timedDevice(raw: SyncApi, limit = 1_000) {
    const state = { queue: [] as QueueItem[], owner: A as string | null, writes: 0 };
    const api: SyncApi = {
      createScan: (input) => withTimeout(limit, () => raw.createScan(input)),
      getScan: (id) => withTimeout(limit, () => raw.getScan(id)),
      createContact: (input) => withTimeout(limit, () => raw.createContact(input)),
      upsertOwnCard: (input) => withTimeout(limit, () => raw.upsertOwnCard(input)),
    };
    const run = (owner: string = A): Promise<SyncResult> =>
      syncOwnedQueue({
        owner,
        currentOwner: () => state.owner,
        isOnline: () => true,
        getQueue: () => state.queue,
        setQueue: (next) => {
          state.queue = next;
          state.writes += 1;
        },
        perform: createPerformer({ api, loadImage: async () => fakeImage(300, "X"), language: () => "en" }),
        classify: classifySyncFailure,
        now: () => T0,
        force: true,
      });
    return { state, run };
  }

  it("a sync run ends at the deadline when the upload never answers; the late answer changes nothing and nothing is sent twice", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let answerScan: (v: unknown) => void = () => {};
    const scans = new Map<number, number | null>();
    const raw: SyncApi = {
      createScan: () => {
        calls.push("createScan");
        return new Promise((r) => (answerScan = r)); // ignores every signal
      },
      getScan: async (id) => {
        calls.push("getScan");
        return { id, contactId: scans.get(id) ?? null, extractedData: {} };
      },
      createContact: async (input) => {
        calls.push("createContact");
        const scanId = (input as { scanId?: number }).scanId as number;
        scans.set(scanId, 500);
        return { id: 500 };
      },
      upsertOwnCard: async () => ({}),
    };
    const d = timedDevice(raw);
    d.state.queue = enqueueItem([], { kind: "scan", label: "c", source: "card", imageFile: "x.jpg" }, A, T0, "s1") as QueueItem[];

    const running = d.run();
    await vi.advanceTimersByTimeAsync(1_001);
    const result = await running;
    expect(result).toMatchObject({ stopped: "offline", reasonKind: "network", synced: 0, failed: 0 });
    expect(d.state.queue[0]).toMatchObject({ id: "s1", status: "pending" });
    expect(d.state.queue[0]?.scanId).toBeUndefined();

    // The server answers after all — nobody is listening any more.
    const writesBefore = d.state.writes;
    const snapshot = JSON.stringify(d.state.queue);
    answerScan({ id: 41, extractedData: { email: "x@example.test" } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(JSON.stringify(d.state.queue)).toBe(snapshot); // no stale progress
    expect(d.state.writes).toBe(writesBefore);
    expect(calls).toEqual(["createScan"]); // no contact request on the late answer's behalf
  });

  it("the contact request never answers: the next run asks the scan instead of creating the contact again", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const scans = new Map<number, number | null>([[41, null]]);
    let hang = true;
    const raw: SyncApi = {
      createScan: async () => ({ id: 41, extractedData: {} }),
      getScan: async (id) => {
        calls.push("getScan");
        return { id, contactId: scans.get(id) ?? null, extractedData: {} };
      },
      createContact: (input) => {
        calls.push("createContact");
        scans.set((input as { scanId: number }).scanId, 500); // the server DID create it
        return hang ? new Promise(() => {}) : Promise.resolve({ id: 500 });
      },
      upsertOwnCard: async () => ({}),
    };
    const d = timedDevice(raw);
    d.state.queue = enqueueItem([], { kind: "scan", label: "c", source: "card", imageFile: "x.jpg" }, A, T0, "s1") as QueueItem[];
    const first = d.run();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await first).toMatchObject({ stopped: "offline" });
    expect(d.state.queue[0]).toMatchObject({ scanId: 41, status: "pending" });

    hang = false;
    calls.length = 0;
    const second = await d.run();
    expect(second.synced).toBe(1);
    expect(calls).toEqual(["getScan"]); // already saved: nothing is sent again
  });

  it("an attempt whose outcome was taken is closed: work still running for it can neither send nor record anything", async () => {
    let captured: PerformContext | null = null;
    let queue: QueueItem[] = enqueueItem([], { kind: "scan", label: "c", source: "card", imageFile: "x.jpg" }, A, T0, "s1") as QueueItem[];
    const result = await syncOwnedQueue({
      owner: A,
      currentOwner: () => A,
      isOnline: () => true,
      getQueue: () => queue,
      setQueue: (next) => {
        queue = next;
      },
      // A performer that reports "no answer" but keeps running in the background.
      perform: async (_item, ctx) => {
        captured = ctx;
        throw new RequestTimeoutError(1);
      },
      classify: classifySyncFailure,
      now: () => T0,
    });
    expect(result.stopped).toBe("offline");
    const before = JSON.stringify(queue);
    const ctx = captured as unknown as PerformContext;
    expect(() => ctx.guard()).toThrow(); // it may not send its next request
    await expect(ctx.progress({ scanId: 99, extracted: {} })).rejects.toThrow(); // nor record progress
    expect(JSON.stringify(queue)).toBe(before);
  });

  it("the account changed while a request hung: its late answer does nothing under the new account, and that account's run never sends it", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let answer: (v: unknown) => void = () => {};
    const raw: SyncApi = {
      createScan: () => {
        calls.push("createScan");
        return new Promise((r) => (answer = r));
      },
      getScan: async () => ({}),
      createContact: async () => {
        calls.push("createContact");
        return { id: 1 };
      },
      upsertOwnCard: async () => ({}),
    };
    const d = timedDevice(raw);
    d.state.queue = enqueueItem([], { kind: "scan", label: "c", source: "card", imageFile: "x.jpg" }, A, T0, "s1") as QueueItem[];
    const running = d.run(A);
    await vi.advanceTimersByTimeAsync(1_001);
    await running;
    d.state.owner = B; // A signed out, B signed in
    answer({ id: 41, extractedData: {} });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toEqual(["createScan"]);
    const asB = await d.run(B);
    expect(asB).toMatchObject({ attempted: 0, synced: 0 });
    expect(calls).toEqual(["createScan"]);
    expect(d.state.queue[0]).toMatchObject({ id: "s1", owner: A, status: "pending" });
  });

  it("the provider wraps every sync request in the deadline (source wiring)", () => {
    const provider = readFileSync(resolve(__dirname, "../contexts/OfflineContext.tsx"), "utf8");
    for (const name of ["createScan", "getScan", "createContact", "upsertOwnCard"]) {
      expect(provider).toContain(`${name}: (`);
      expect(provider).toMatch(new RegExp(`${name}: \\((input|id)\\) => withTimeout\\(SYNC_TIMEOUT_MS\\.${name}, \\(o\\) => ${name}\\((input|id), o\\)\\)`));
    }
    // Reading the photo back has a limit too, and running into it is reported as a storage matter, not as "no connection".
    expect(provider).toMatch(/loadImage: \(item\) =>\s*withTimeout\(PHOTO_READ_TIMEOUT_MS, \(\) => scanFiles\.loadImage\(item\.owner, item\.imageFile \?\? ""\)\)\.catch\(/);
    expect(provider).toContain('if (err instanceof RequestTimeoutError) throw new ScanFileError("storage-unavailable", "photo read timed out");');
  });
});

// ===========================================================================
describe("C — the take-over of the earlier queue, interrupted anywhere", () => {
  const legacy = (): unknown[] => [
    { id: "1763630000001-aaa", kind: "scan", status: "pending", createdAt: 1763630000001, attempts: 0, owner: A, label: "Card", source: "card", imageData: fakeImage(3000, "A") },
    { id: "1763630000002-bbb", kind: "contact", status: "pending", createdAt: 1763630000002, attempts: 0, owner: B, label: "Sara", source: "manual", payload: { firstName: "Sara" } },
    { id: "1763630000003-ccc", kind: "card", status: "pending", createdAt: 1763630000003, attempts: 0, owner: A, label: "My card", source: "card", cardPayload: { fullName: "A user" } },
  ];
  const LEGACY_IDS = ["1763630000001-aaa", "1763630000002-bbb", "1763630000003-ccc"];
  const indexIds = (): string[] => {
    try {
      return storedIndex().map((it) => it.id);
    } catch {
      return [];
    }
  };
  /** The one rule that must hold at EVERY moment: the old queue is gone only if the new index holds all of it. */
  const nothingAbandoned = (): boolean => storage.current.data.has(LEGACY) || LEGACY_IDS.every((id) => indexIds().includes(id));

  it("no step relies on several keys being written together", async () => {
    storage.current.data.set(LEGACY, JSON.stringify(legacy()));
    const driver = createMemoryScanDriver();
    const mod = await freshModule();
    const load = await mod.loadQueue(createScanFileStore(driver), T0);
    await mod.saveQueue(load.items, ["some-finished-id"]);
    expect(storage.current.multiKeyWrites).toBe(0);
    expect(readFileSync(resolve(__dirname, "offline-queue.ts"), "utf8")).not.toMatch(/AsyncStorage\.multi(Set|Remove|Merge)\(/);
  });

  it("the order is: new index (read back) → completion note → old queue removed", async () => {
    storage.current.data.set(LEGACY, JSON.stringify(legacy()));
    const load = await (await freshModule()).loadQueue(createScanFileStore(createMemoryScanDriver()), T0);
    expect(load.migrated).toBe(3);
    expect(storage.current.log.map(([k]) => k)).toEqual([INDEX, FLAG]);
    expect(storage.current.data.has(LEGACY)).toBe(false);
    expect(indexIds()).toEqual(LEGACY_IDS);
    expect(stored(FLAG)).toBe(fingerprintOf(JSON.stringify(legacy()))); // a mark of exactly the value that was taken over
  });

  it("stopped after EVERY single storage change in turn: the old queue is never gone before the new index holds it, and the next start finishes", async () => {
    // How many changes does a complete take-over make?
    storage.current.data.set(LEGACY, JSON.stringify(legacy()));
    storage.current.changesLeft = 1_000;
    await (await freshModule()).loadQueue(createScanFileStore(createMemoryScanDriver()), T0);
    const total = 1_000 - (storage.current.changesLeft as number);
    expect(total).toBe(3); // index, note, removal

    for (let died = 0; died <= total; died++) {
      storage.current = createMemoryAsyncStorage();
      storage.current.data.set(LEGACY, JSON.stringify(legacy()));
      const driver = createMemoryScanDriver();
      storage.current.changesLeft = died; // the process dies after `died` changes
      const interrupted = await (await freshModule()).loadQueue(createScanFileStore(driver), T0);
      expect(nothingAbandoned(), `after ${died} change(s)`).toBe(true);
      expect(interrupted.items.map((it) => it.id), `after ${died} change(s)`).toEqual(LEGACY_IDS); // in memory the work is always there

      storage.current.changesLeft = null; // restart on a healthy store
      const next = await (await freshModule()).loadQueue(createScanFileStore(driver), T0 + 1);
      expect(next.items.map((it) => it.id), `restart after ${died}`).toEqual(LEGACY_IDS); // each exactly once
      expect(indexIds(), `restart after ${died}`).toEqual(LEGACY_IDS);
      expect(storage.current.data.has(LEGACY), `restart after ${died}`).toBe(false);
      expect(stored(FLAG), `restart after ${died}`).toBe(fingerprintOf(JSON.stringify(legacy())));
      expect(next.items[0]?.imageData, `restart after ${died}`).toBeUndefined(); // the photo is a file
      expect(next.items[0]?.imageFile, `restart after ${died}`).toBe("1763630000001-aaa.jpg");
      expect(next.items.map((it) => it.owner)).toEqual([A, B, A]); // owners unchanged
    }
  });

  it("the completion note exists but the new index does NOT hold the items (the earlier defect): the old queue is not deleted — it is taken over", async () => {
    storage.current.data.set(LEGACY, JSON.stringify(legacy()));
    storage.current.data.set(FLAG, "1"); // as a multi-key write that is not atomic could leave it
    const load = await (await freshModule()).loadQueue(createScanFileStore(createMemoryScanDriver()), T0);
    expect(load.items.map((it) => it.id)).toEqual(LEGACY_IDS);
    expect(load.migrated).toBe(3);
    expect(indexIds()).toEqual(LEGACY_IDS);
    expect(nothingAbandoned()).toBe(true);
  });

  it("the new index was written but cannot be read back: the note is not set and the old queue stays", async () => {
    storage.current.data.set(LEGACY, JSON.stringify(legacy()));
    const realSet = storage.current.multiSet.bind(storage.current);
    storage.current.multiSet = async (pairs) => {
      await realSet(pairs);
      if (pairs.some(([k]) => k === INDEX)) storage.current.unreadable.add(INDEX); // "Row too big"
    };
    await (await freshModule()).loadQueue(createScanFileStore(createMemoryScanDriver()), T0);
    expect(storage.current.data.has(LEGACY)).toBe(true);
    expect(stored(FLAG)).toBeUndefined();
  });

  it("items already uploaded after the take-over are not brought back by a leftover old queue", async () => {
    storage.current.data.set(LEGACY, JSON.stringify(legacy()));
    storage.current.failKeys.add(LEGACY); // the removal keeps failing
    const mod = await freshModule();
    const first = await mod.loadQueue(createScanFileStore(createMemoryScanDriver()), T0);
    expect(storage.current.data.has(LEGACY)).toBe(true);
    // the contact syncs and leaves the queue
    const rest = first.items.filter((it) => it.id !== LEGACY_IDS[1]);
    expect(await mod.saveQueue(rest, [LEGACY_IDS[1] as string])).toBe(true);

    storage.current.failKeys.clear();
    const next = await (await freshModule()).loadQueue(createScanFileStore(createMemoryScanDriver()), T0 + 1);
    expect(next.items.map((it) => it.id)).toEqual([LEGACY_IDS[0], LEGACY_IDS[2]]);
    expect(next.migrated).toBe(0);
    expect(storage.current.data.has(LEGACY)).toBe(false); // every item is accounted for: now it may go
  });

  it("an old queue that can only partly be read: what can be read is taken over, and the old queue is kept as it is and reported", async () => {
    const list = [...legacy(), { broken: true }];
    const raw = JSON.stringify(list);
    storage.current.data.set(LEGACY, raw);
    const load = await (await freshModule()).loadQueue(createScanFileStore(createMemoryScanDriver()), T0);
    expect(load.items.map((it) => it.id)).toEqual(LEGACY_IDS);
    expect(load.legacyUnreadable).toBe(true);
    expect(stored(LEGACY)).toBe(raw);
    // and it does not multiply at the next start
    const next = await (await freshModule()).loadQueue(createScanFileStore(createMemoryScanDriver()), T0 + 1);
    expect(next.items.map((it) => it.id)).toEqual(LEGACY_IDS);
    expect(next.migrated).toBe(0);
    expect(stored(LEGACY)).toBe(raw);
  });

  it("uncoveredIds: what the stored index and the finished list do not account for", () => {
    const items = queued();
    expect(uncoveredIds(items, new Set([SCAN]), [CARD])).toEqual([CONTACT]);
    expect(uncoveredIds(items, new Set([SCAN, CONTACT, CARD]), [])).toEqual([]);
    expect(uncoveredIds([], new Set(), [])).toEqual([]);
  });

  describe("an ordinary save: the finished list is stored before the index, each on its own", () => {
    const item = (id: string): QueueItem => ({ id, kind: "contact", status: "pending", createdAt: 1, attempts: 0, owner: A, label: id, source: "manual", payload: { firstName: id } as never });

    it("order of the two writes, and the finished list only when it changed", async () => {
      const mod = await freshModule();
      await mod.loadQueue(noFiles(), T0);
      expect(await mod.saveQueue([item("a"), item("b")], [])).toBe(true);
      expect(await mod.saveQueue([item("a")], ["b"])).toBe(true);
      expect(await mod.saveQueue([item("a"), item("c")], ["b"])).toBe(true);
      expect(storage.current.log.map(([k]) => k)).toEqual([DONE, INDEX, DONE, INDEX, INDEX]);
      expect(storage.current.multiKeyWrites).toBe(0);
    });

    it("only the finished list lands: the stale index cannot bring the uploaded item back", async () => {
      const mod = await freshModule();
      await mod.loadQueue(noFiles(), T0);
      expect(await mod.saveQueue([item("a"), item("b")], [])).toBe(true);
      storage.current.failKeys.add(INDEX);
      expect(await mod.saveQueue([item("a")], ["b"])).toBe(false); // "b" was uploaded; its removal could not be stored
      expect(storedIndex().map((it) => it.id)).toEqual(["a", "b"]);
      expect(JSON.parse(stored(DONE) ?? "[]")).toEqual(["b"]);
      storage.current.failKeys.clear();
      const next = await (await freshModule()).loadQueue(noFiles(), T0 + 1);
      expect(next.items.map((it) => it.id)).toEqual(["a"]);
      expect(storedIndex().map((it) => it.id)).toEqual(["a"]);
    });

    it("the finished list cannot be stored: the index is not written either, so it never gets ahead", async () => {
      const mod = await freshModule();
      await mod.loadQueue(noFiles(), T0);
      expect(await mod.saveQueue([item("a"), item("b")], [])).toBe(true);
      storage.current.failKeys.add(DONE);
      expect(await mod.saveQueue([item("a")], ["b"])).toBe(false);
      expect(storedIndex().map((it) => it.id)).toEqual(["a", "b"]); // unchanged
      expect(JSON.parse(stored(DONE) ?? "[]")).toEqual([]);
    });
  });
});

// ===========================================================================
describe("D — the shared API client as the mobile app uses it", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const session = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({ generation: 1, accessToken: "T1", refreshToken: "R1", issuedTokens: ["T1"], ...over });

  it("handler runs never overlap, even for requests rejected with different tokens", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => json(401, { error: "Invalid or expired token" })));
    setAuthTokenGetter(() => "T1");
    setOnUnauthorized(async ({ failedToken }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${failedToken}`);
      await new Promise((r) => setTimeout(r, 15));
      order.push(`end:${failedToken}`);
      active -= 1;
      return null;
    });
    await Promise.allSettled([
      customFetch("/api/a"),
      customFetch("/api/b", { headers: { authorization: "Bearer T0" } }),
      customFetch("/api/c", { headers: { authorization: "Bearer TX" } }),
      customFetch("/api/d"),
    ]);
    expect(maxActive).toBe(1);
    expect(order.filter((o) => o.startsWith("start")).sort()).toEqual(["start:T0", "start:T1", "start:TX"]); // one run per rejected token
    for (let i = 0; i < order.length; i += 2) expect(order[i + 1]).toBe((order[i] as string).replace("start", "end"));
  });

  it("a request that carries its own Authorization header keeps it on the retry; one sent with the session's token gets the renewed one", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("authorization") ?? "-";
        sent.push(`${String(input)} ${auth}`);
        return auth === "Bearer T2" ? json(200, { ok: true }) : json(401, { error: "Invalid or expired token" });
      }),
    );
    setAuthTokenGetter(() => "T1");
    setOnUnauthorized(async () => "T2");
    await expect(customFetch("/api/own", { headers: { authorization: "Bearer OTHER" } })).rejects.toMatchObject({ status: 401 });
    await expect(customFetch("/api/session")).resolves.toEqual({ ok: true });
    expect(sent).toEqual(["/api/own Bearer OTHER", "/api/own Bearer OTHER", "/api/session Bearer T1", "/api/session Bearer T2"]);
  });

  it("a request its caller gave up on starts no renewal and is never sent again, even when its 401 arrives later", async () => {
    let release: (r: Response) => void = () => {};
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        sent.push(String(input));
        return new Promise<Response>((r) => (release = r)); // ignores the signal completely
      }),
    );
    const handler = vi.fn(async () => "T2");
    setAuthTokenGetter(() => "T1");
    setOnUnauthorized(handler);
    const controller = new AbortController();
    const call = customFetch("/api/contacts", { method: "POST", body: "{}", signal: controller.signal }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5)); // the request is on its way
    controller.abort(); // the deadline passed
    release(json(401, { error: "Invalid or expired token" })); // …and now the answer arrives
    const err = await call;
    expect(err).toBeInstanceOf(ApiError);
    expect(handler).not.toHaveBeenCalled();
    expect(sent).toEqual(["/api/contacts"]); // no second POST behind the caller's back
  });

  it("given up while the renewal was under way: the renewal finishes, the request is not sent again", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        sent.push(String(input));
        return json(401, { error: "Invalid or expired token" });
      }),
    );
    let finishRenewal: (t: string) => void = () => {};
    setAuthTokenGetter(() => "T1");
    setOnUnauthorized(() => new Promise<string>((r) => (finishRenewal = r)));
    const controller = new AbortController();
    const call = customFetch("/api/contacts", { method: "POST", body: "{}", signal: controller.signal }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    finishRenewal("T2");
    expect(await call).toMatchObject({ status: 401 });
    expect(sent).toEqual(["/api/contacts"]);
  });

  it("with the app's own rules: a stale request of this session is retried once with the current token; another account's request is never retried", async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("authorization") ?? "-";
        sent.push(`${String(input)} ${auth}`);
        return auth === "Bearer T2" ? json(200, { ok: true }) : json(401, { error: "Invalid or expired token" });
      }),
    );
    // The session was renewed from T1 to T2 a moment ago.
    const now = session({ accessToken: "T2", refreshToken: "R2", issuedTokens: ["T1", "T2"] });
    let renewals = 0;
    setOnUnauthorized(async ({ failedToken, url }) => {
      const d = decideOnUnauthorized(now, failedToken, url);
      if (d.action === "retry") return d.token;
      if (d.action === "refresh") renewals += 1;
      return null;
    });
    let token = "T1"; // a request that left before the renewal
    setAuthTokenGetter(() => token);
    await expect(customFetch("/api/stale")).resolves.toEqual({ ok: true });
    token = "TB-other-account";
    await expect(customFetch("/api/foreign")).rejects.toMatchObject({ status: 401 });
    expect(sent).toEqual(["/api/stale Bearer T1", "/api/stale Bearer T2", "/api/foreign Bearer TB-other-account"]);
    expect(renewals).toBe(0);
  });
});
