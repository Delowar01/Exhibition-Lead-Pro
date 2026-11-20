// Phase 2 Batch 1 — where the offline queue is stored (lib/offline-queue.ts and
// lib/offline-queue-store-model.ts): the take-over of an older version's queue,
// images moving into per-account files, and the rule that nothing stored is
// ever overwritten while it cannot be read. Runs the real modules against an
// in-memory AsyncStorage and file system that fail the way a phone does.
import { beforeEach, describe, expect, it, vi } from "vitest";

import ar from "./i18n/locales/ar.json";
import en from "./i18n/locales/en.json";
import { parseStoredQueue, quarantinedCount, visibleQueue, type QueueItem } from "./offline-queue-model";
import {
  MAX_DONE_IDS,
  MAX_INDEX_CHARS,
  createdAtOfId,
  enqueueFailureKeys,
  enqueueFailureOf,
  externalizeImages,
  mergeLegacyItems,
  parseDoneIds,
  recoveredItems,
  rememberDone,
} from "./offline-queue-store-model";
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
const DAMAGED = "csp_offline_queue_damaged";
const ROOT = "file:///data/app/files/offline-scans/";

/** The queue exactly as the version before this change stored it: one value, images inline. */
function legacyQueue(): unknown[] {
  return [
    { id: "1763630000001-aaa", kind: "scan", status: "pending", createdAt: 1763630000001, attempts: 0, owner: A, label: "Business card", source: "card", imageData: fakeImage(3000, "A"), appLanguage: "ar", eventId: 4, latitude: 25.2, longitude: 55.3, gpsAccuracy: 9 },
    { id: "1763630000002-bbb", kind: "scan", status: "failed", createdAt: 1763630000002, attempts: 2, owner: B, label: "Business card", source: "card", imageData: fakeImage(6000, "B"), lastError: "HTTP 502 Bad Gateway: upstream" },
    { id: "1763630000003-ccc", kind: "contact", status: "syncing", createdAt: 1763630000003, attempts: 0, owner: A, label: "Sara", source: "manual", payload: { firstName: "Sara", email: "sara@example.test" } },
    { id: "1763630000004-ddd", kind: "card", status: "pending", createdAt: 1763630000004, attempts: 0, owner: B, label: "My card", source: "card", cardPayload: { fullName: "B user" } },
    // written before ownership existed: quarantined, never anybody's
    { id: "1763630000005-eee", kind: "scan", status: "pending", createdAt: 1763630000005, attempts: 0, label: "Old scan", source: "card", imageData: fakeImage(3000, "E") },
  ];
}

async function freshModule() {
  vi.resetModules();
  return import("./offline-queue");
}

function setup() {
  const driver = createMemoryScanDriver();
  return { driver, files: createScanFileStore(driver) };
}

beforeEach(() => {
  storage.current = createMemoryAsyncStorage();
});

describe("upgrade: the queue of the previous version is taken over, nothing is lost", () => {
  it("every item arrives with its owner, status and details; images become files of their owner", async () => {
    storage.current.data.set(LEGACY, JSON.stringify(legacyQueue()));
    const { driver, files } = setup();
    const { loadQueue } = await freshModule();
    const load = await loadQueue(files);

    expect(load).toMatchObject({ writable: true, indexDamaged: false, legacyUnreadable: false, migrated: 5, inlineImages: 0 });
    expect(load.items).toHaveLength(5);
    const byId = Object.fromEntries(load.items.map((it) => [it.id, it]));
    expect(byId["1763630000001-aaa"]).toMatchObject({ owner: A, status: "pending", imageFile: "1763630000001-aaa.jpg", imageBytes: 3000, appLanguage: "ar", eventId: 4, latitude: 25.2, gpsAccuracy: 9 });
    expect(byId["1763630000002-bbb"]).toMatchObject({ owner: B, status: "failed", attempts: 2, imageFile: "1763630000002-bbb.jpg", imageBytes: 6000 });
    expect(byId["1763630000003-ccc"]).toMatchObject({ owner: A, status: "pending", payload: { firstName: "Sara" } }); // "syncing" → pending
    expect(byId["1763630000004-ddd"]).toMatchObject({ owner: B, kind: "card" });
    expect(byId["1763630000005-eee"]).toMatchObject({ owner: null, imageFile: "1763630000005-eee.jpg" }); // still quarantined

    // images: each in its owner's directory, the ownerless one apart
    expect([...driver.files.keys()].sort()).toEqual([
      `${ROOT}11_1/1763630000001-aaa.jpg`,
      `${ROOT}22_2/1763630000002-bbb.jpg`,
      `${ROOT}_quarantine/1763630000005-eee.jpg`,
    ]);
    expect(await files.loadImage(A, "1763630000001-aaa.jpg")).toBe(fakeImage(3000, "A"));

    // stored: a small index without a single image, the flag, and the old value gone
    const index = storage.current.data.get(INDEX)!;
    expect(index).not.toContain("base64");
    expect(index.length).toBeLessThan(3000);
    expect(storage.current.data.get(FLAG)).toBe("1");
    expect(storage.current.data.has(LEGACY)).toBe(false);

    // account isolation is exactly as before
    expect(visibleQueue(load.items, A).map((it) => it.id)).toEqual(["1763630000001-aaa", "1763630000003-ccc"]);
    expect(visibleQueue(load.items, B).map((it) => it.id)).toEqual(["1763630000002-bbb", "1763630000004-ddd"]);
    expect(quarantinedCount(load.items)).toBe(1);
  });

  it("the old value is removed only AFTER the new index is stored: a failed write leaves it for the next start", async () => {
    storage.current.data.set(LEGACY, JSON.stringify(legacyQueue()));
    const { files } = setup();
    storage.current.failNextWrites = 1; // the index write fails (store full)
    let mod = await freshModule();
    const first = await mod.loadQueue(files);
    expect(first.items).toHaveLength(5); // still usable in this session
    expect(storage.current.data.has(LEGACY)).toBe(true); // untouched
    expect(storage.current.data.has(INDEX)).toBe(false);
    expect(storage.current.data.has(FLAG)).toBe(false);

    mod = await freshModule(); // next start
    const second = await mod.loadQueue(files);
    expect(second).toMatchObject({ migrated: 5, inlineImages: 0 });
    expect(second.items).toHaveLength(5);
    expect(storage.current.data.has(LEGACY)).toBe(false);
    expect(parseStoredQueue(storage.current.data.get(INDEX)!)).toHaveLength(5);
  });

  it("repeating the take-over never brings back work that was already uploaded", async () => {
    const { files } = setup();
    storage.current.data.set(LEGACY, JSON.stringify(legacyQueue()));
    let mod = await freshModule();
    const load = await mod.loadQueue(files);
    // one item is uploaded and leaves the queue; its id is remembered as finished
    const rest = load.items.filter((it) => it.id !== "1763630000003-ccc");
    expect(await mod.saveQueue(rest, ["1763630000003-ccc"])).toBe(true);
    // the worst case: the old value is back and the flag is gone (as after a partial restore of app data)
    storage.current.data.set(LEGACY, JSON.stringify(legacyQueue()));
    storage.current.data.delete(FLAG);
    mod = await freshModule();
    const again = await mod.loadQueue(files);
    expect(again.migrated).toBe(0);
    expect(again.items.map((it) => it.id).sort()).toEqual(rest.map((it) => it.id).sort());
  });

  it("an old queue that cannot be read is left exactly where it is, and the user is told", async () => {
    storage.current.data.set(LEGACY, "x".repeat(3_000_000));
    storage.current.unreadable.add(LEGACY); // Android: too large to read back
    const { files } = setup();
    const { loadQueue, saveQueue } = await freshModule();
    const load = await loadQueue(files);
    expect(load).toMatchObject({ legacyUnreadable: true, writable: true, items: [] });
    expect(await saveQueue([{ id: "n1", kind: "contact", status: "pending", createdAt: 1, attempts: 0, owner: A, label: "x", source: "manual" }])).toBe(true);
    expect(storage.current.data.get(LEGACY)).toHaveLength(3_000_000); // never overwritten, never deleted
    expect(storage.current.data.has(FLAG)).toBe(false); // and tried again at the next start
  });

  it("an old value that is not a queue is not deleted either", async () => {
    storage.current.data.set(LEGACY, "{not json");
    const { files } = setup();
    const { loadQueue } = await freshModule();
    expect(await loadQueue(files)).toMatchObject({ legacyUnreadable: true, items: [] });
    expect(storage.current.data.get(LEGACY)).toBe("{not json");
  });

  it("when the device is out of space during the take-over the images stay inline — kept, and moved at the next start", async () => {
    storage.current.data.set(LEGACY, JSON.stringify(legacyQueue()));
    const { driver, files } = setup();
    driver.free = 1024; // no room for files
    let mod = await freshModule();
    const first = await mod.loadQueue(files);
    expect(first).toMatchObject({ migrated: 5, inlineImages: 3 });
    expect(driver.files.size).toBe(0);
    expect(first.items.filter((it) => it.imageData).length).toBe(3); // nothing dropped
    // the index (with the three inline images) is stored and the old value removed: one safe copy
    expect(parseStoredQueue(storage.current.data.get(INDEX)!).filter((it) => it.imageData)).toHaveLength(3);

    driver.free = 8e9; // space was freed
    mod = await freshModule();
    const second = await mod.loadQueue(files);
    expect(second).toMatchObject({ migrated: 0, inlineImages: 0 });
    expect(driver.files.size).toBe(3);
    expect(storage.current.data.get(INDEX)).not.toContain("base64");
  });

  it("a fresh install has nothing to take over and writes nothing at all", async () => {
    const { files } = setup();
    const { loadQueue } = await freshModule();
    expect(await loadQueue(files)).toMatchObject({ items: [], migrated: 0, writable: true, indexDamaged: false, incident: null });
    expect(storage.current.log).toEqual([]);
    expect([...storage.current.data.keys()]).toEqual([]);
  });
});

describe("the stored queue is never overwritten while it cannot be read", () => {
  it("an unreadable index disables every write for the session", async () => {
    storage.current.data.set(INDEX, JSON.stringify([{ id: "keep", kind: "contact", status: "pending", createdAt: 1, attempts: 0, owner: A, label: "keep me", source: "manual" }]));
    storage.current.unreadable.add(INDEX);
    const before = storage.current.data.get(INDEX);
    const { files } = setup();
    const { loadQueue, saveQueue, queueWritable } = await freshModule();
    const load = await loadQueue(files);
    expect(load).toMatchObject({ writable: false, indexDamaged: true, items: [] });
    expect(queueWritable()).toBe(false);
    expect(await saveQueue([])).toBe(false); // the old code wrote "[]" here and destroyed the queue
    expect(await saveQueue([{ id: "new", kind: "contact", status: "pending", createdAt: 2, attempts: 0, owner: A, label: "new", source: "manual" }])).toBe(false);
    expect(storage.current.data.get(INDEX)).toBe(before);
  });

  it("an index that is not a queue is set aside before a fresh one replaces it", async () => {
    storage.current.data.set(INDEX, '{"oops":true}');
    const { files } = setup();
    const { loadQueue, saveQueue } = await freshModule();
    const load = await loadQueue(files);
    expect(load).toMatchObject({ writable: true, indexDamaged: true, items: [] });
    expect(storage.current.data.get(DAMAGED)).toBe('{"oops":true}');
    expect(await saveQueue([])).toBe(true);
  });

  it("…and when it cannot even be set aside, nothing is written at all", async () => {
    storage.current.data.set(INDEX, "garbage");
    storage.current.failWrites = new Error("disk full");
    const { files } = setup();
    const { loadQueue, saveQueue } = await freshModule();
    expect(await loadQueue(files)).toMatchObject({ writable: false, indexDamaged: true });
    storage.current.failWrites = null;
    expect(await saveQueue([])).toBe(false);
    expect(storage.current.data.get(INDEX)).toBe("garbage");
  });

  it("no write is possible before the stored queue has been loaded", async () => {
    storage.current.data.set(INDEX, JSON.stringify([{ id: "keep", kind: "contact", status: "pending", createdAt: 1, attempts: 0, owner: A, label: "keep", source: "manual" }]));
    const { saveQueue } = await freshModule();
    expect(await saveQueue([])).toBe(false); // an early capture cannot wipe what is stored
    expect(parseStoredQueue(storage.current.data.get(INDEX)!)).toHaveLength(1);
  });
});

describe("a save reports the truth", () => {
  const one: QueueItem = { id: "n1", kind: "contact", status: "pending", createdAt: 1, attempts: 0, owner: A, label: "x", source: "manual" };

  it("true only when the device stored it; false when the store refuses", async () => {
    const { files } = setup();
    const { loadQueue, saveQueue } = await freshModule();
    await loadQueue(files);
    expect(await saveQueue([one])).toBe(true);
    storage.current.failWrites = new Error("database or disk is full (code 13 SQLITE_FULL)");
    expect(await saveQueue([one, { ...one, id: "n2" }])).toBe(false);
    storage.current.failWrites = null;
    expect(parseStoredQueue(storage.current.data.get(INDEX)!).map((it) => it.id)).toEqual(["n1"]); // the last good state is intact
    expect(await saveQueue([one, { ...one, id: "n2" }])).toBe(true); // and a later save heals it
  });

  it("an index too large to be read back is refused instead of written", async () => {
    const { files } = setup();
    const { loadQueue, saveQueue } = await freshModule();
    await loadQueue(files);
    const huge: QueueItem = { ...one, id: "big", kind: "scan", imageData: `data:image/jpeg;base64,${"A".repeat(MAX_INDEX_CHARS)}` };
    expect(await saveQueue([huge])).toBe(false);
    expect(storage.current.data.has(INDEX)).toBe(false); // nothing of it reached the store
  });

  it("writes land in the order they were made, the finished ids with them in one step", async () => {
    const { files } = setup();
    const { loadQueue, saveQueue } = await freshModule();
    await loadQueue(files);
    const results = await Promise.all([saveQueue([one]), saveQueue([one, { ...one, id: "n2" }]), saveQueue([{ ...one, id: "n2" }], ["n1"])]);
    expect(results).toEqual([true, true, true]);
    expect(parseStoredQueue(storage.current.data.get(INDEX)!).map((it) => it.id)).toEqual(["n2"]);
    expect(JSON.parse(storage.current.data.get(DONE)!)).toEqual(["n1"]);
  });

  it("600 scans of a long session: the index stays a few hundred bytes per scan", async () => {
    const { driver, files } = setup();
    const { loadQueue, saveQueue } = await freshModule();
    await loadQueue(files);
    const items: QueueItem[] = [];
    for (let i = 0; i < 600; i += 1) {
      const id = `${1763630000000 + i}-s${i}`;
      const saved = await files.saveImage(i % 2 ? A : B, id, fakeImage(300_000, "ABCD"[i % 4]!));
      items.push({ id, kind: "scan", status: "pending", createdAt: 1763630000000 + i, attempts: 0, owner: i % 2 ? A : B, label: "Business card", source: "card", imageFile: saved.file, imageBytes: saved.bytes, appLanguage: "en", eventId: 3, latitude: 25.2048, longitude: 55.2708, gpsAccuracy: 12 });
    }
    expect(await saveQueue(items)).toBe(true);
    const index = storage.current.data.get(INDEX)!;
    expect(index.length).toBeLessThan(250_000); // 180 MB of photos; the old design needed one 240 MB value
    expect(index.length / 600).toBeLessThan(400);
    expect(driver.files.size).toBe(600);
    const { loadQueue: reload } = await freshModule();
    expect((await reload(files)).items).toHaveLength(600);
  });
});

describe("pure storage rules", () => {
  it("taking over skips ids already in the index or already finished, and never changes an owner", () => {
    const current = [{ id: "a", owner: A }, { id: "b", owner: B }] as QueueItem[];
    const legacy = [{ id: "a", owner: A }, { id: "c", owner: null }, { id: "d", owner: B }, { id: "e", owner: A }] as QueueItem[];
    const merged = mergeLegacyItems(current, legacy, ["e"]);
    expect(merged.added).toBe(2);
    expect(merged.items.map((it) => [it.id, it.owner])).toEqual([["a", A], ["b", B], ["c", null], ["d", B]]);
    expect(mergeLegacyItems(current, [], [])).toEqual({ items: current, added: 0 });
  });

  it("an image that cannot be written stays inline; contacts, cards and already-moved scans are left alone", async () => {
    const driver = createMemoryScanDriver();
    const files = createScanFileStore(driver);
    const items = [
      { id: "1-a", kind: "scan", owner: A, imageData: fakeImage(3000) },
      { id: "2-b", kind: "scan", owner: B, imageData: "not an image" },
      { id: "3-c", kind: "scan", owner: A, imageFile: "3-c.jpg" },
      { id: "4-d", kind: "contact", owner: A },
      { id: "../5", kind: "scan", owner: A, imageData: fakeImage(3000) },
    ] as QueueItem[];
    const out = await externalizeImages(items, files);
    expect(out).toMatchObject({ changed: true, remainingInline: 2 });
    expect(out.items[0]).toMatchObject({ imageFile: "1-a.jpg", imageBytes: 3000 });
    expect(out.items[0]!.imageData).toBeUndefined();
    expect(out.items[1]!.imageData).toBe("not an image");
    expect(out.items[2]).toBe(items[2]);
    expect(out.items[3]).toBe(items[3]);
    expect(out.items[4]!.imageData).toBeDefined(); // an unsafe id is never turned into a path
    expect(driver.files.size).toBe(1);
  });

  it("a photo the queue no longer lists comes back as a waiting scan of the SAME account", () => {
    const now = 1_800_000_000_000;
    const items = recoveredItems([{ id: "1763630000009-zz", file: "1763630000009-zz.jpg", bytes: 4000 }, { id: "weird", file: "weird.jpg", bytes: 10 }], A, now);
    expect(items).toEqual([
      { id: "1763630000009-zz", kind: "scan", status: "pending", createdAt: 1763630000009, attempts: 0, owner: A, label: "", source: "card", imageFile: "1763630000009-zz.jpg", imageBytes: 4000, recovered: true },
      { id: "weird", kind: "scan", status: "pending", createdAt: now, attempts: 0, owner: A, label: "", source: "card", imageFile: "weird.jpg", imageBytes: 10, recovered: true },
    ]);
    expect(recoveredItems([{ id: "x", file: "x.jpg", bytes: 1 }], "7@platform", now)).toEqual([]);
    expect(createdAtOfId("abc-1", 5)).toBe(5);
  });

  it("the list of finished ids is bounded and tolerant", () => {
    expect(parseDoneIds(null)).toEqual([]);
    expect(parseDoneIds("{")).toEqual([]);
    expect(parseDoneIds('{"a":1}')).toEqual([]);
    expect(parseDoneIds('["a",1,"","b"]')).toEqual(["a", "b"]);
    let ids: string[] = [];
    for (let i = 0; i < MAX_DONE_IDS + 50; i += 1) ids = rememberDone(ids, `id${i}`);
    expect(ids).toHaveLength(MAX_DONE_IDS);
    expect(ids[0]).toBe("id50");
    expect(rememberDone(["a", "b"], "a")).toEqual(["a", "b"]);
  });

  it("every reason a capture was not kept has a title and an explanation in both languages", () => {
    const lookup = (obj: unknown, path: string) => path.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), obj);
    for (const reason of ["no-owner", "storage-full", "storage-unavailable", "image-invalid"] as const) {
      const keys = enqueueFailureKeys(reason);
      for (const key of [keys.title, keys.body]) {
        expect(typeof lookup(en, key), `en ${key}`).toBe("string");
        expect(typeof lookup(ar, key), `ar ${key}`).toBe("string");
      }
    }
    expect(enqueueFailureOf(new ScanFileError("storage-full"))).toBe("storage-full");
    expect(enqueueFailureOf(new ScanFileError("image-invalid"))).toBe("image-invalid");
    expect(enqueueFailureOf(new ScanFileError("image-missing"))).toBe("storage-unavailable");
    expect(enqueueFailureOf(new Error("anything"))).toBe("storage-unavailable");
  });
});
