// B25 Stage 1 — mobile account-state isolation, part 2: offline queue ownership.
// Red on 9306a164 (and 72a2437): the persisted queue `csp_offline_queue` had no
// owner on any item. Work captured offline under account A survived logout and
// an account switch, was listed and counted for account B, and the sync loop
// would have sent it with whatever session was active at sync time — an A
// contact created in B's tenant, an A scan processed under B, an A "my card"
// edit overwriting B's own card. The old module is exercised in the RED block
// at the end of this file through its persisted shape (no `owner` field) and
// the old provider's target selection (every pending/failed item).
import { describe, expect, it } from "vitest";

import {
  type QueueItem,
  type QueueItemDraft,
  canStartSync,
  discardQuarantined,
  enqueueItem,
  isTenantOwnerKey,
  ownsItem,
  parseStoredQueue,
  quarantinedCount,
  queueCounts,
  queueOwnerKey,
  removeOwnedItem,
  retryOwnedItem,
  serializeQueue,
  syncOwnedQueue,
  syncTargets,
  visibleQueue,
} from "./offline-queue-model";
import { accountOwnerKey } from "./settings-model";

const USER_A = { id: 11, companyId: 1 };
const USER_B = { id: 77, companyId: 53 };
const PLATFORM_OWNER = { id: 1, companyId: null };
const A = queueOwnerKey(USER_A)!;
const B = queueOwnerKey(USER_B)!;

const contactDraft = (label: string, eventId: number | null = null): QueueItemDraft => ({
  kind: "contact",
  label,
  source: "manual",
  payload: { firstName: label, eventId },
});
const scanDraft = (label: string): QueueItemDraft => ({ kind: "scan", label, source: "card", imageData: "data:image/jpeg;base64,AAAA", appLanguage: "en", eventId: 501 });
const cardDraft = (label: string): QueueItemDraft => ({ kind: "card", label, source: "card", cardPayload: { fullName: label } });

let seq = 0;
const add = (items: QueueItem[], draft: QueueItemDraft, owner: string | null | undefined): QueueItem[] => {
  const next = enqueueItem(items, draft, owner, 1_700_000_000_000 + seq, `id-${++seq}`);
  if (!next) throw new Error("enqueue refused");
  return next;
};
/** What the provider writes to AsyncStorage and reads back on the next launch. */
const persistAndReload = (items: QueueItem[]): QueueItem[] => parseStoredQueue(serializeQueue(items));

/** A queue persisted by the app BEFORE ownership existed (exact old shape: no `owner`). */
function legacyPersisted(): string {
  return JSON.stringify([
    { id: "old-1", kind: "contact", status: "pending", createdAt: 1, attempts: 0, label: "Old contact", source: "manual", payload: { firstName: "Old" } },
    { id: "old-2", kind: "scan", status: "failed", createdAt: 2, attempts: 1, label: "Old scan", source: "card", imageData: "data:image/jpeg;base64,BBBB" },
    { id: "old-3", kind: "card", status: "pending", createdAt: 3, attempts: 0, label: "Old card", source: "card", cardPayload: { fullName: "Old card" } },
  ]);
}

/** Drive the engine like the provider does; records which items were sent and under which owner. */
async function runSync(
  start: QueueItem[],
  owner: string | null | undefined,
  opts: { ownerSequence?: Array<string | null | undefined>; failIds?: string[]; online?: boolean } = {},
) {
  let queue = start;
  const sent: Array<{ id: string; owner: string | null | undefined }> = [];
  const seqOwners = opts.ownerSequence ? [...opts.ownerSequence] : null;
  let current: string | null | undefined = owner;
  const result = await syncOwnedQueue({
    owner,
    currentOwner: () => {
      if (seqOwners && seqOwners.length > 0) current = seqOwners.shift();
      return current;
    },
    isOnline: () => opts.online ?? true,
    getQueue: () => queue,
    setQueue: (next) => {
      queue = next;
    },
    perform: async (item) => {
      sent.push({ id: item.id, owner: current });
      if (opts.failIds?.includes(item.id)) throw new Error("server said no");
    },
  });
  return { result, queue, sent };
}

describe("owner key (same format as the settings isolation)", () => {
  it("is <userId>@<companyId> for a tenant user and equals accountOwnerKey", () => {
    expect(A).toBe("11@1");
    expect(A).toBe(accountOwnerKey(USER_A));
    expect(B).toBe("77@53");
    expect(A).not.toBe(B);
  });
  it("is null for a platform operator, a missing user and malformed shapes", () => {
    expect(queueOwnerKey(PLATFORM_OWNER)).toBeNull();
    expect(queueOwnerKey(null)).toBeNull();
    expect(queueOwnerKey(undefined)).toBeNull();
    for (const bad of ["1@platform", "11@", "@1", "11", "0@1", "11@0", "a@b", " 11@1", "11@1 ", "", null, undefined, 7, {}])
      expect(isTenantOwnerKey(bad)).toBe(false);
    expect(isTenantOwnerKey("11@1")).toBe(true);
  });
});

describe("1–4. owner stamp at enqueue; fail closed without a tenant owner", () => {
  it("1. contact enqueue carries exactly the owner", () => {
    const q = add([], contactDraft("Alice"), A);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ kind: "contact", owner: A, status: "pending", attempts: 0 });
  });
  it("2. scan enqueue carries exactly the owner", () => {
    const q = add([], scanDraft("Card photo"), A);
    expect(q[0]).toMatchObject({ kind: "scan", owner: A, eventId: 501 });
  });
  it("3. card enqueue carries exactly the owner", () => {
    const q = add([], cardDraft("My card"), A);
    expect(q[0]).toMatchObject({ kind: "card", owner: A });
  });
  it("4. no authenticated tenant owner → nothing is enqueued", () => {
    for (const noOwner of [null, undefined, "1@platform", "", "bad"]) {
      expect(enqueueItem([], contactDraft("x"), noOwner)).toBeNull();
      expect(enqueueItem([], scanDraft("x"), noOwner)).toBeNull();
      expect(enqueueItem([], cardDraft("x"), noOwner)).toBeNull();
    }
    expect(enqueueItem([], contactDraft("x"), queueOwnerKey(PLATFORM_OWNER))).toBeNull();
  });
});

describe("5–7. visibility and counters are scoped to the signed-in owner", () => {
  const q = add(add(add([], contactDraft("A1"), A), scanDraft("A2"), A), contactDraft("B1"), B);
  const withFailed = q.map((it) => (it.label === "A2" ? { ...it, status: "failed" as const, lastError: "boom" } : it));
  it("5. A sees A's items", () => {
    expect(visibleQueue(withFailed, A).map((it) => it.label)).toEqual(["A2", "A1"]);
  });
  it("6. after the switch to B, A's items are invisible to B (labels, payloads, images never exposed)", () => {
    const seen = visibleQueue(withFailed, B);
    expect(seen.map((it) => it.label)).toEqual(["B1"]);
    expect(JSON.stringify(seen)).not.toContain("A1");
    expect(JSON.stringify(seen)).not.toContain("AAAA");
    expect(visibleQueue(withFailed, null)).toEqual([]);
    expect(visibleQueue(withFailed, undefined)).toEqual([]);
  });
  it("7. B's pending / failed / queued counts exclude A's items; logged out counts nothing", () => {
    expect(queueCounts(withFailed, B)).toEqual({ pending: 1, failed: 0, queued: 1 });
    expect(queueCounts(withFailed, A)).toEqual({ pending: 1, failed: 1, queued: 2 });
    expect(queueCounts(withFailed, null)).toEqual({ pending: 0, failed: 0, queued: 0 });
  });
});

describe("8–10. sync boundary — only the current owner's items are ever sent", () => {
  const q = add(add(add([], contactDraft("A contact"), A), scanDraft("A scan"), A), cardDraft("A card"), A);
  it("8. B cannot sync A's contact item", async () => {
    const { result, sent, queue } = await runSync(q, B);
    expect(sent).toEqual([]);
    expect(result).toMatchObject({ attempted: 0, synced: 0 });
    expect(queue).toEqual(q);
    expect(syncTargets(q, B)).toEqual([]);
  });
  it("9. B cannot sync A's scan item", () => {
    expect(syncTargets(q, B).some((it) => it.kind === "scan")).toBe(false);
  });
  it("10. B cannot apply A's card edit, and B's own card edit is the only card B sends", async () => {
    const withB = add(q, cardDraft("B card"), B);
    const { sent } = await runSync(withB, B);
    expect(sent).toHaveLength(1);
    expect(withB.find((it) => it.id === sent[0]!.id)).toMatchObject({ kind: "card", owner: B, label: "B card" });
  });
  it("A's own sync sends exactly A's three items, each under A", async () => {
    const { result, sent, queue } = await runSync(q, A);
    expect(sent.map((s) => s.owner)).toEqual([A, A, A]);
    expect(result).toMatchObject({ attempted: 3, synced: 3, failed: 0, stopped: null });
    expect(queue).toEqual([]);
  });
});

describe("11. account switch and return: A's work waits, untouched, for A", () => {
  it("B's session leaves A's items persisted and invisible; signing back in as A restores them", () => {
    let q = add(add([], contactDraft("A1"), A), scanDraft("A2"), A);
    // switch to B: nothing deleted, nothing visible, B works normally
    q = persistAndReload(q);
    expect(visibleQueue(q, B)).toEqual([]);
    q = add(q, contactDraft("B1"), B);
    expect(queueCounts(q, B)).toEqual({ pending: 1, failed: 0, queued: 1 });
    // B's sync sends only B1 and leaves A's items alone
    return runSync(q, B).then(({ sent, queue }) => {
      expect(sent.map((s) => s.owner)).toEqual([B]);
      expect(queue.map((it) => it.label).sort()).toEqual(["A1", "A2"]);
      // back to A after a restart
      const again = persistAndReload(queue);
      expect(visibleQueue(again, A).map((it) => it.label).sort()).toEqual(["A1", "A2"]);
      expect(queueCounts(again, A)).toEqual({ pending: 2, failed: 0, queued: 2 });
      expect(syncTargets(again, A)).toHaveLength(2);
    });
  });
});

describe("12–13. legacy (ownerless) items are quarantined, never adopted, never synced, never silently deleted", () => {
  it("12. a pre-fix queue restored under A or B never becomes a sync target of either", async () => {
    const q = parseStoredQueue(legacyPersisted());
    expect(q).toHaveLength(3);
    expect(q.every((it) => it.owner === null)).toBe(true);
    expect(quarantinedCount(q)).toBe(3);
    for (const owner of [A, B]) {
      expect(visibleQueue(q, owner)).toEqual([]);
      expect(syncTargets(q, owner)).toEqual([]);
      expect(queueCounts(q, owner)).toEqual({ pending: 0, failed: 0, queued: 0 });
      const { sent, queue } = await runSync(q, owner);
      expect(sent).toEqual([]);
      expect(queue).toHaveLength(3);
    }
  });
  it("13. quarantine survives a reload and new owned items coexist with it", () => {
    let q = parseStoredQueue(legacyPersisted());
    q = add(q, contactDraft("A new"), A);
    const again = persistAndReload(q);
    expect(quarantinedCount(again)).toBe(3);
    expect(again.filter((it) => it.owner === null).map((it) => it.id).sort()).toEqual(["old-1", "old-2", "old-3"]);
    expect(visibleQueue(again, A).map((it) => it.label)).toEqual(["A new"]);
    // a legacy card edit is not superseded by A's card edit (it is nobody's)
    const withCard = add(again, cardDraft("A card"), A);
    expect(withCard.some((it) => it.id === "old-3")).toBe(true);
    // only an explicit discard removes them
    const cleared = discardQuarantined(withCard);
    expect(quarantinedCount(cleared)).toBe(0);
    expect(cleared.map((it) => it.label).sort()).toEqual(["A card", "A new"]);
  });
});

describe("14–15. initial start: nothing syncs before hydration + auth resolution + a tenant owner", () => {
  it("14. hydrated queue does not sync while logged out or before auth resolves", async () => {
    expect(canStartSync({ hydrated: true, owner: undefined })).toBe(false);
    expect(canStartSync({ hydrated: true, owner: null })).toBe(false);
    expect(canStartSync({ hydrated: false, owner: A })).toBe(false);
    expect(canStartSync({ hydrated: true, owner: "1@platform" })).toBe(false);
    const q = add([], contactDraft("A1"), A);
    for (const owner of [undefined, null]) {
      const { result, sent } = await runSync(q, owner);
      expect(sent).toEqual([]);
      expect(result.stopped).toBe("no-owner");
    }
  });
  it("15. once A is signed in only A-owned restored items sync; B's and legacy ones stay", async () => {
    expect(canStartSync({ hydrated: true, owner: A })).toBe(true);
    let q = parseStoredQueue(legacyPersisted());
    q = add(add(q, contactDraft("A1"), A), contactDraft("B1"), B);
    const restored = persistAndReload(q);
    const { sent, queue } = await runSync(restored, A);
    expect(sent.map((s) => s.owner)).toEqual([A]);
    expect(queue.map((it) => it.label).sort()).toEqual(["B1", "Old card", "Old contact", "Old scan"]);
  });
});

describe("16. owner change while a multi-item sync is running", () => {
  it("after the owner changes no further old-owner request starts; remaining items stay pending", async () => {
    const q = add(add(add([], contactDraft("A1"), A), contactDraft("A2"), A), contactDraft("A3"), A);
    // owner read before request 1 → A (sent), before request 2 → B (stop)
    const { result, sent, queue } = await runSync(q, A, { ownerSequence: [A, B] });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.owner).toBe(A);
    expect(result).toMatchObject({ attempted: 1, synced: 1, stopped: "owner-changed" });
    expect(queue.map((it) => it.status)).toEqual(["pending", "pending"]);
    expect(queue.every((it) => it.owner === A)).toBe(true);
  });
  it("logout mid-sync (owner → null) stops the loop the same way", async () => {
    const q = add(add([], contactDraft("A1"), A), contactDraft("A2"), A);
    const { sent, result } = await runSync(q, A, { ownerSequence: [A, null] });
    expect(sent).toHaveLength(1);
    expect(result.stopped).toBe("owner-changed");
  });
  it("going offline mid-sync stops the loop", async () => {
    const q = add(add([], contactDraft("A1"), A), contactDraft("A2"), A);
    let online = true;
    let queue = q;
    const sent: string[] = [];
    const result = await syncOwnedQueue({
      owner: A,
      currentOwner: () => A,
      isOnline: () => online,
      getQueue: () => queue,
      setQueue: (n) => {
        queue = n;
      },
      perform: async (item) => {
        sent.push(item.id);
        online = false;
      },
    });
    expect(sent).toHaveLength(1);
    expect(result.stopped).toBe("offline");
  });
  it("a failed request marks only that item failed and continues with the owner's next item", async () => {
    const q = add(add([], contactDraft("A1"), A), contactDraft("A2"), A);
    const first = q.find((it) => it.label === "A2")!.id; // newest first
    const { result, queue, sent } = await runSync(q, A, { failIds: [first] });
    expect(sent).toHaveLength(2);
    expect(result).toMatchObject({ attempted: 2, synced: 1, failed: 1, stopped: null });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: first, status: "failed", attempts: 1, lastError: "server said no", owner: A });
  });
});

describe("17. owner-scoped card collapse", () => {
  it("B's card enqueue supersedes only B's earlier card edit; A's queued card edit is kept", () => {
    let q = add([], cardDraft("A card v1"), A);
    q = add(q, cardDraft("B card v1"), B);
    q = add(q, cardDraft("B card v2"), B);
    expect(q.filter((it) => it.kind === "card" && it.owner === B).map((it) => it.label)).toEqual(["B card v2"]);
    expect(q.filter((it) => it.kind === "card" && it.owner === A).map((it) => it.label)).toEqual(["A card v1"]);
    q = add(q, cardDraft("A card v2"), A);
    expect(q.filter((it) => it.kind === "card").map((it) => it.label).sort()).toEqual(["A card v2", "B card v2"]);
    // non-card items are never collapsed
    q = add(q, contactDraft("A contact"), A);
    q = add(q, cardDraft("A card v3"), A);
    expect(q.map((it) => it.label).sort()).toEqual(["A card v3", "A contact", "B card v2"]);
  });
});

describe("18–20. retry / remove ownership", () => {
  const q = add(add([], contactDraft("A1"), A), contactDraft("B1"), B).map((it) => ({ ...it, status: "failed" as const }));
  const aId = q.find((it) => it.owner === A)!.id;
  const bId = q.find((it) => it.owner === B)!.id;
  it("18. B cannot retry A's item (no-op, same array)", () => {
    expect(retryOwnedItem(q, aId, B)).toBe(q);
    expect(ownsItem(q, aId, B)).toBe(false);
  });
  it("19. B cannot remove A's item (no-op); a quarantined id is never removable", () => {
    expect(removeOwnedItem(q, aId, B)).toBe(q);
    const legacy = parseStoredQueue(legacyPersisted());
    expect(removeOwnedItem(legacy, "old-1", A)).toBe(legacy);
    expect(retryOwnedItem(legacy, "old-1", A)).toBe(legacy);
    expect(removeOwnedItem(q, aId, null)).toBe(q);
  });
  it("20. the same owner can retry and remove its own item", () => {
    const retried = retryOwnedItem(q, aId, A);
    expect(retried.find((it) => it.id === aId)).toMatchObject({ status: "pending", lastError: undefined, owner: A });
    expect(retried.find((it) => it.id === bId)).toMatchObject({ status: "failed" });
    const removed = removeOwnedItem(q, bId, B);
    expect(removed.map((it) => it.id)).toEqual([aId]);
  });
});

describe("21–22. persistence", () => {
  it("21. an owned queue round-trips with owners, payloads and statuses intact (syncing → pending)", () => {
    let q = add(add([], contactDraft("A1", 501), A), scanDraft("A2"), A);
    q = add(q, cardDraft("B card"), B).map((it) => (it.label === "A2" ? { ...it, status: "syncing" as const } : it));
    const again = persistAndReload(q);
    expect(again.map((it) => [it.label, it.owner, it.status])).toEqual([
      ["B card", B, "pending"],
      ["A2", A, "pending"],
      ["A1", A, "pending"],
    ]);
    expect(again.find((it) => it.label === "A1")!.payload).toEqual({ firstName: "A1", eventId: 501 });
    expect(again.find((it) => it.label === "A2")!.imageData).toBe("data:image/jpeg;base64,AAAA");
    expect(JSON.parse(serializeQueue(again))[2].owner).toBe(A);
  });
  it("22. malformed ownership metadata is quarantined, never trusted, never converted to the current account", () => {
    const raw = JSON.stringify([
      { id: "m1", kind: "contact", status: "pending", createdAt: 1, attempts: 0, label: "x", source: "manual", owner: 11 },
      { id: "m2", kind: "contact", status: "pending", createdAt: 1, attempts: 0, label: "x", source: "manual", owner: "1@platform" },
      { id: "m3", kind: "scan", status: "pending", createdAt: 1, attempts: 0, label: "x", source: "card", owner: { id: 11 } },
      { id: "m4", kind: "card", status: "pending", createdAt: 1, attempts: 0, label: "x", source: "card", owner: "" },
      { id: "m5", kind: "card", status: "pending", createdAt: 1, attempts: 0, label: "x", source: "card", owner: "11@1@2" },
      { id: "ok", kind: "contact", status: "pending", createdAt: 1, attempts: 0, label: "x", source: "manual", owner: "11@1" },
      { id: 5, kind: "contact" },
      { id: "nokind", kind: "other" },
      null,
    ]);
    const q = parseStoredQueue(raw);
    expect(q.map((it) => it.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "ok"]);
    expect(quarantinedCount(q)).toBe(5);
    expect(visibleQueue(q, A).map((it) => it.id)).toEqual(["ok"]);
    expect(persistAndReload(q).filter((it) => it.owner === null)).toHaveLength(5);
    expect(parseStoredQueue("not json")).toEqual([]);
    expect(parseStoredQueue(JSON.stringify({ owner: A }))).toEqual([]);
    expect(parseStoredQueue(null)).toEqual([]);
  });
});

describe("23–24. unchanged neighbours", () => {
  it("23. the device-level manual-offline flag is not part of the queue model (stays device-wide)", () => {
    // The flag lives in `csp_offline_manual`, outside the queue: no queue API takes or stores it.
    const q = add([], contactDraft("A1"), A);
    expect(Object.keys(q[0]!)).not.toContain("manualOffline");
    expect(serializeQueue(q)).not.toContain("csp_offline_manual");
    expect(serializeQueue(q)).not.toContain("manualOffline");
  });
  it("24. queued captures keep the event valid for THEIR owner; nothing rewrites it for another account", async () => {
    const q = add([], contactDraft("A1", 501), A);
    const { sent } = await runSync(q, B);
    expect(sent).toEqual([]);
    const restoredForA = persistAndReload(q);
    expect(restoredForA[0]!.payload).toMatchObject({ eventId: 501 });
    expect(restoredForA[0]!.owner).toBe(A);
  });
});

describe("RED on 9306a164 — the persisted shape the old code produced and selected", () => {
  it("old queue entries carry no owner, so the old target selection (`pending || failed`) picks A's work for whoever is signed in", () => {
    const old = JSON.parse(legacyPersisted()) as Array<Record<string, unknown>>;
    expect(old.every((it) => !("owner" in it))).toBe(true);
    const oldTargets = old.filter((it) => it.status === "pending" || it.status === "failed");
    expect(oldTargets.map((it) => it.kind)).toEqual(["contact", "scan", "card"]); // contact AND scan AND card
    // the corrected model refuses all of them for any account
    const q = parseStoredQueue(legacyPersisted());
    expect(syncTargets(q, A)).toEqual([]);
    expect(syncTargets(q, B)).toEqual([]);
  });
});
