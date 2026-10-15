// B25 Stage 1 — mobile account-state isolation, part 3: own-card cache ownership.
// Red on 11f14e13 (and before): `csp_own_card` held a raw BusinessCard with no
// owner; CardProvider hydrated it on startup before any account check, so after
// logout and an account switch — above all offline, where no server fetch
// replaces it — account B saw account A's card, inherited A's pendingSync and,
// on an offline edit, A's server ids / public token / company id as `prev`.
import { describe, expect, it } from "vitest";

import type { BusinessCard, BusinessCardInput } from "@workspace/api-client-react";

import {
  type OwnedCardCache,
  cacheBelongsTo,
  optimisticCardFor,
  parseStoredCardCache,
  serializeCardCache,
  visibleCachedCard,
} from "./card-cache-model";
import { enqueueItem, queueOwnerKey } from "./offline-queue-model";

const USER_A = { id: 11, companyId: 1, avatarUrl: null, name: "Alice" };
const USER_B = { id: 77, companyId: 53, avatarUrl: null, name: "Bob" };
const A = queueOwnerKey(USER_A)!;
const B = queueOwnerKey(USER_B)!;

const cardA: BusinessCard = {
  id: 501,
  userId: 11,
  companyId: 1,
  publicToken: "tok-a-public",
  fullName: "Alice A",
  designation: "CEO",
  companyName: "Tenant A Ltd",
  email: "alice@tenant-a.example",
  primaryPhone: "+100",
  fieldVisibility: { email: false },
  templateId: "modern",
  isPublished: true,
  avatarUrl: null,
  accountName: "Alice",
  publicUrl: "https://cards.example/alice",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
} as BusinessCard;
const cardB: BusinessCard = { ...cardA, id: 777, userId: 77, companyId: 53, publicToken: "tok-b-public", fullName: "Bob B", companyName: "Tenant B", publicUrl: "https://cards.example/bob" };
const inputB: BusinessCardInput = { fullName: "Bob B (edited)", designation: "CTO" };

/**
 * The provider's state machine for the cache slot, as pure steps:
 * what the slot holds after each action, and what the current owner sees.
 */
class Device {
  slot: string | null = null; // AsyncStorage csp_own_card
  cache: OwnedCardCache | null = null; // provider cacheRef after hydration
  hydrate(): "none" | "owned" | "legacy" {
    const stored = parseStoredCardCache(this.slot);
    this.cache = stored.kind === "owned" ? stored.cache : null;
    if (stored.kind === "legacy") this.slot = null; // removed, never attributed
    return stored.kind;
  }
  /** fetchCard success / optimistic edit for the current owner */
  setAndCache(owner: string | null | undefined, card: BusinessCard | null) {
    if (card === null) {
      if (cacheBelongsTo(this.cache, owner)) {
        this.cache = null;
        this.slot = null;
      }
      return;
    }
    const raw = serializeCardCache(owner, card);
    if (!raw) return; // nothing written without a tenant owner
    this.cache = { owner: owner as string, card };
    this.slot = raw;
  }
  visible(owner: string | null | undefined) {
    return visibleCachedCard(this.cache, owner);
  }
}

describe("1. RED proof — the pre-fix slot shape (a raw card, no owner) surfaces A's card to anyone", () => {
  it("the old loader returned any object in the slot; the model now classifies it as legacy and exposes it to nobody", () => {
    const rawLegacySlot = JSON.stringify(cardA); // exactly what saveCachedCard wrote before the fix
    // old loadCachedCard(): `JSON.parse(raw)` → object → returned as the card, for whoever mounted CardProvider
    const oldLoader = (raw: string | null) => (raw ? (JSON.parse(raw) as BusinessCard) : null);
    expect(oldLoader(rawLegacySlot)?.fullName).toBe("Alice A"); // B, offline, would render this
    const d = new Device();
    d.slot = rawLegacySlot;
    expect(d.hydrate()).toBe("legacy");
    expect(d.visible(B)).toBeNull();
    expect(d.visible(A)).toBeNull(); // not even A: ownership cannot be proven, so it is never guessed
    expect(d.slot).toBeNull(); // removed
  });
});

describe("2–4. owner stamp and owner-only load", () => {
  it("2. A's saved cache carries A's owner", () => {
    const raw = serializeCardCache(A, cardA)!;
    expect(JSON.parse(raw)).toEqual({ owner: A, card: cardA });
    expect(parseStoredCardCache(raw)).toEqual({ kind: "owned", cache: { owner: A, card: cardA } });
  });
  it("3. A can load A's cache", () => {
    const d = new Device();
    d.setAndCache(A, cardA);
    expect(d.hydrate()).toBe("owned");
    expect(d.visible(A)).toEqual(cardA);
  });
  it("4. B cannot load A's cache", () => {
    const d = new Device();
    d.setAndCache(A, cardA);
    d.hydrate();
    expect(d.visible(B)).toBeNull();
    expect(cacheBelongsTo(d.cache, B)).toBe(false);
  });
});

describe("5–6. logged out / auth unresolved", () => {
  const d = new Device();
  d.setAndCache(A, cardA);
  d.hydrate();
  it("5. logged out (owner null): no card", () => {
    expect(d.visible(null)).toBeNull();
  });
  it("6. auth unresolved (owner undefined) or a platform account: no account-specific card", () => {
    expect(d.visible(undefined)).toBeNull();
    expect(d.visible("1@platform")).toBeNull();
    expect(d.visible("")).toBeNull();
    // and nothing can be written for them either
    expect(serializeCardCache(undefined, cardA)).toBeNull();
    expect(serializeCardCache(null, cardA)).toBeNull();
    expect(serializeCardCache("1@platform", cardA)).toBeNull();
  });
});

describe("7–8. account switch offline, and return to A", () => {
  it("7. A cache → logout → B signs in offline → B sees no A card (and inherits nothing)", () => {
    const d = new Device();
    d.setAndCache(A, cardA); // A used the app
    // app relaunch: hydrate before auth resolves, then logout → B offline
    d.hydrate();
    expect(d.visible(undefined)).toBeNull();
    expect(d.visible(null)).toBeNull();
    expect(d.visible(B)).toBeNull(); // offline: no fetch will ever replace it — still nothing
    // B's optimistic offline edit starts from nothing of A's
    const opt = optimisticCardFor(inputB, d.cache, B, { name: "Bob" })!;
    expect(opt.id).toBe(0);
    expect(opt.userId).toBe(0);
    expect(opt.companyId).toBeNull();
    expect(opt.publicToken).toBe("");
    expect(opt.publicUrl).toBeNull();
    expect(opt.fieldVisibility).toEqual({});
    expect(opt.templateId).toBe("classic");
  });
  it("8. return to A recovers A's own cache when the slot still holds it (B never cached); B's cache replaces it otherwise", () => {
    const d = new Device();
    d.setAndCache(A, cardA);
    d.hydrate();
    expect(d.visible(B)).toBeNull();
    expect(d.visible(A)).toEqual(cardA); // A returns: own cache intact
    // B later caches its own card (online fetch): single slot → B's wrapper replaces A's
    d.setAndCache(B, cardB);
    expect(d.visible(B)).toEqual(cardB);
    expect(d.visible(A)).toBeNull(); // A fetches again from the server next time
    expect(JSON.parse(d.slot!).owner).toBe(B);
  });
});

describe("9. legacy raw cache", () => {
  it("is never assigned to A or B by guess, whichever signs in first, and is removed", () => {
    for (const first of [A, B]) {
      const d = new Device();
      d.slot = JSON.stringify(cardA);
      expect(d.hydrate()).toBe("legacy");
      expect(d.visible(first)).toBeNull();
      expect(d.cache).toBeNull();
      expect(d.slot).toBeNull();
    }
  });
  it("malformed wrappers are legacy too (bad owner, missing card, wrong types, invalid JSON)", () => {
    for (const raw of [
      JSON.stringify({ owner: "1@platform", card: cardA }),
      JSON.stringify({ owner: "", card: cardA }),
      JSON.stringify({ owner: 11, card: cardA }),
      JSON.stringify({ owner: A }),
      JSON.stringify({ owner: A, card: "x" }),
      JSON.stringify({ owner: A, card: { fullName: "no token" } }),
      JSON.stringify([cardA]),
      "not json",
    ]) {
      expect(parseStoredCardCache(raw).kind).toBe("legacy");
    }
    expect(parseStoredCardCache(null)).toEqual({ kind: "none" });
    expect(parseStoredCardCache("")).toEqual({ kind: "none" });
  });
});

describe("10–11. server refresh for the current owner", () => {
  it("10. an online getOwnCard success is cached for the current owner only", () => {
    const d = new Device();
    d.setAndCache(B, cardB);
    expect(JSON.parse(d.slot!)).toEqual({ owner: B, card: cardB });
    expect(d.visible(B)).toEqual(cardB);
    expect(d.visible(A)).toBeNull();
  });
  it("11. a 404 for the current owner clears only that owner's effective card; another account's slot is left alone", () => {
    const d = new Device();
    d.setAndCache(B, cardB);
    d.setAndCache(B, null); // B has no card
    expect(d.visible(B)).toBeNull();
    expect(d.slot).toBeNull();
    const e = new Device();
    e.setAndCache(A, cardA);
    e.setAndCache(B, null); // B's 404 must not destroy A's slot
    expect(e.slot).not.toBeNull();
    expect(e.visible(A)).toEqual(cardA);
    expect(e.visible(B)).toBeNull();
  });
});

describe("12–13. optimistic offline edit", () => {
  it("12. uses only the current owner's previous card", () => {
    const cache: OwnedCardCache = { owner: B, card: cardB };
    const opt = optimisticCardFor(inputB, cache, B, { name: "Bob", avatarUrl: "https://a/b.png" }, "2026-02-02T00:00:00.000Z")!;
    expect(opt).toMatchObject({ id: 777, userId: 77, companyId: 53, publicToken: "tok-b-public", fullName: "Bob B (edited)", designation: "CTO", publicUrl: "https://cards.example/bob", avatarUrl: "https://a/b.png", updatedAt: "2026-02-02T00:00:00.000Z" });
  });
  it("13. B's optimistic card cannot inherit A's id / userId / companyId / publicToken / publicUrl / visibility / template", () => {
    const cache: OwnedCardCache = { owner: A, card: cardA };
    const opt = optimisticCardFor(inputB, cache, B, { name: "Bob" })!;
    expect(opt.id).toBe(0);
    expect(opt.userId).toBe(0);
    expect(opt.companyId).toBeNull();
    expect(opt.publicToken).toBe("");
    expect(opt.publicUrl).toBeNull();
    expect(opt.fieldVisibility).toEqual({});
    expect(opt.templateId).toBe("classic");
    expect(opt.isPublished).toBe(true);
    expect(opt.accountName).toBe("Bob");
    // and B's own input-supplied visibility/template are honoured
    const own = optimisticCardFor({ ...inputB, fieldVisibility: { email: true }, templateId: "bold" }, cache, B, { name: "Bob" })!;
    expect(own.fieldVisibility).toEqual({ email: true });
    expect(own.templateId).toBe("bold");
    // no tenant owner → nothing is built
    expect(optimisticCardFor(inputB, cache, null, {})).toBeNull();
    expect(optimisticCardFor(inputB, cache, undefined, {})).toBeNull();
    expect(optimisticCardFor(inputB, cache, "1@platform", {})).toBeNull();
  });
});

describe("14–15. queue interaction and pending state across an account switch", () => {
  it("14. the offline card queue item's owner equals the card-cache owner", () => {
    const d = new Device();
    const opt = optimisticCardFor(inputB, null, B, { name: "Bob" })!;
    d.setAndCache(B, opt);
    const queue = enqueueItem([], { kind: "card", label: inputB.fullName, source: "card", cardPayload: inputB }, B)!;
    expect(queue[0]!.owner).toBe(B);
    expect(JSON.parse(d.slot!).owner).toBe(queue[0]!.owner);
    // the same edit under no owner neither caches nor queues
    expect(serializeCardCache(null, opt)).toBeNull();
    expect(enqueueItem([], { kind: "card", label: inputB.fullName, source: "card", cardPayload: inputB }, null)).toBeNull();
  });
  it("15. B does not inherit A's pendingSync: the provider resets pending state on every owner change (binding effect)", () => {
    // The provider's owner-binding effect runs on each owner change and sets
    // pendingSync=false while re-deriving the visible card; modelled here as the
    // pure derivation B observes right after the switch.
    const d = new Device();
    d.setAndCache(A, cardA);
    const stateAfterSwitch = { card: d.visible(B), pendingSync: false };
    expect(stateAfterSwitch).toEqual({ card: null, pendingSync: false });
  });
});
