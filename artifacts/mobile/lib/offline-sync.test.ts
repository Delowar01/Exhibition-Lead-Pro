// Phase 2 Batch 1 — the offline sync under failure: interrupted runs, duplicate
// prevention, an expired session, an account switch in the middle of an item,
// contacts that already exist, AI being unavailable, answers that are not the
// API's. The engine (lib/offline-queue-model.ts) and the per-item work
// (lib/offline-sync.ts) run for real against a small fake of the four API calls.
import { describe, expect, it } from "vitest";

import ar from "./i18n/locales/ar.json";
import en from "./i18n/locales/en.json";
import {
  enqueueItem,
  parseStoredQueue,
  queueCounts,
  resolveOwnedConflict,
  retryDelayMs,
  retryOwnedItem,
  serializeQueue,
  syncOwnedQueue,
  syncTargets,
  visibleQueue,
  type QueueItem,
  type SyncResult,
} from "./offline-queue-model";
import { classifySyncFailure, createPerformer, extractedToContact, syncProblemKey, type SyncApi } from "./offline-sync";
import { ScanFileError } from "./scan-files";

const A = "11@1";
const B = "22@2";

function httpError(status: number, data?: unknown): Error & { status: number; data: unknown } {
  return Object.assign(new Error(`HTTP ${status}`), { status, data });
}
const NETWORK = () => new TypeError("Network request failed");

interface ServerScan {
  id: number;
  owner: string;
  contactId: number | null;
  extractedData: Record<string, unknown>;
}
interface ServerContact {
  id: number;
  owner: string;
  scanId: number | null;
  body: Record<string, unknown>;
}

/** The four API calls, with the behaviour the real endpoints have and hooks to make them fail. */
class FakeServer implements SyncApi {
  scans = new Map<number, ServerScan>();
  contacts: ServerContact[] = [];
  cards: Array<{ owner: string; body: unknown }> = [];
  calls: string[] = [];
  /** The account whose session the app sends requests with right now. */
  session: string | null = A;
  /** Run before the server handles a call; throw to fail it BEFORE it has any effect. */
  before: (call: string) => void = () => {};
  /** Run after the server handled a call; throw to lose the ANSWER of a call that took effect. */
  after: (call: string) => void = () => {};
  /** E-mails that already exist as contacts (the server answers 409, creating nothing). */
  existing = new Map<string, { id: number; fullName: string }>();
  private nextId = 1;

  private who(): string {
    if (!this.session) throw httpError(401, { error: "Session expired. Please sign in again." });
    return this.session;
  }

  async createScan(input: { imageData: string; eventId?: number | null }): Promise<unknown> {
    this.calls.push("createScan");
    this.before("createScan");
    const owner = this.who();
    const id = this.nextId++;
    const extractedData = { firstName: "Card", lastName: String(id), email: `card${input.imageData.length}-${id}@example.test` };
    this.scans.set(id, { id, owner, contactId: null, extractedData });
    this.after("createScan");
    return { id, extractedData, status: "completed" };
  }

  async getScan(id: number): Promise<unknown> {
    this.calls.push("getScan");
    this.before("getScan");
    const owner = this.who();
    const scan = this.scans.get(id);
    if (!scan || scan.owner !== owner) throw httpError(404, { error: "Scan not found" });
    return { id: scan.id, contactId: scan.contactId, extractedData: scan.extractedData };
  }

  async createContact(input: Record<string, unknown>): Promise<unknown> {
    this.calls.push("createContact");
    this.before("createContact");
    const owner = this.who();
    const scanId = typeof input.scanId === "number" ? input.scanId : null;
    if (scanId !== null && this.scans.get(scanId)?.owner !== owner) throw httpError(400, { error: "Invalid scanId" });
    const email = typeof input.email === "string" ? input.email : null;
    // The server's own duplicate detection: an existing contact of the SAME
    // tenant with this e-mail is a high-confidence match (nothing is created).
    const own = email ? this.contacts.find((c) => c.owner === owner && c.body.email === email) : undefined;
    const match = (email ? this.existing.get(email) : undefined) ?? (own ? { id: own.id, fullName: String(own.body.firstName ?? "Contact") } : undefined);
    if (match && input.dedupeResolution == null) {
      throw httpError(409, { code: "existing_contact_found", message: `${match.fullName} already exists in your contacts.`, contact: { id: match.id, fullName: match.fullName } });
    }
    if (input.dedupeResolution === "add_interaction") {
      const target = typeof input.matchedContactId === "number" ? input.matchedContactId : null;
      if (target === null) throw httpError(400, { error: "matchedContactId is required for add_interaction" });
      if (scanId !== null) this.scans.get(scanId)!.contactId = target;
      this.after("createContact");
      return { id: target };
    }
    const id = this.nextId++;
    this.contacts.push({ id, owner, scanId, body: input });
    if (scanId !== null) this.scans.get(scanId)!.contactId = id;
    this.after("createContact");
    return { id };
  }

  async upsertOwnCard(body: unknown): Promise<unknown> {
    this.calls.push("upsertOwnCard");
    this.before("upsertOwnCard");
    this.cards.push({ owner: this.who(), body });
    return { id: 1 };
  }
}

interface Device {
  queue: QueueItem[];
  /** What is durably stored (what survives the app being closed). */
  stored: string;
  owner: string | null;
  online: boolean;
  now: number;
  server: FakeServer;
  images: Map<string, string>;
  uploaded: string[];
}

function device(server = new FakeServer()): Device {
  return { queue: [], stored: "[]", owner: A, online: true, now: 1_800_000_000_000, server, images: new Map(), uploaded: [] };
}

function addScan(d: Device, id: string, owner = A, extra: Partial<QueueItem> = {}): void {
  const file = `${id}.jpg`;
  d.images.set(`${owner}/${file}`, `data:image/jpeg;base64,${"Q".repeat(40 + d.images.size * 4)}`);
  d.queue = enqueueItem(d.queue, { kind: "scan", label: `Scan ${id}`, source: "card", imageFile: file, eventId: 5, ...extra }, owner, d.now, id)!;
  d.stored = serializeQueue(d.queue);
}
function addContact(d: Device, id: string, email: string, owner = A): void {
  d.queue = enqueueItem(d.queue, { kind: "contact", label: email, source: "manual", payload: { firstName: "Manual", email } }, owner, d.now, id)!;
  d.stored = serializeQueue(d.queue);
}

async function sync(d: Device, options: { force?: boolean } = {}): Promise<SyncResult> {
  const perform = createPerformer({
    api: d.server,
    loadImage: async (item) => {
      const image = d.images.get(`${item.owner}/${item.imageFile}`);
      if (!image) throw new ScanFileError("image-missing");
      return image;
    },
    language: () => "en",
  });
  return syncOwnedQueue({
    owner: d.owner,
    currentOwner: () => d.owner,
    isOnline: () => d.online,
    getQueue: () => d.queue,
    setQueue: async (next) => {
      d.queue = next;
      d.stored = serializeQueue(next);
    },
    perform,
    classify: classifySyncFailure,
    now: () => d.now,
    force: options.force,
    onUploaded: (item) => d.uploaded.push(item.id),
  });
}

/** The app was closed: only what was stored survives. */
function restart(d: Device, storedAt: string = d.stored): void {
  d.queue = parseStoredQueue(storedAt);
  d.stored = storedAt;
}

const item = (d: Device, id: string) => d.queue.find((it) => it.id === id);

describe("a scan is two requests; the result of the first is stored before the second", () => {
  it("normal run: one scan, one contact, the contact linked to the scan, the item gone", async () => {
    const d = device();
    addScan(d, "s1");
    const result = await sync(d);
    expect(result).toMatchObject({ attempted: 1, synced: 1, failed: 0, conflicts: 0, stopped: null });
    expect(d.server.calls).toEqual(["createScan", "createContact"]);
    expect(d.server.contacts).toHaveLength(1);
    expect(d.server.contacts[0]).toMatchObject({ owner: A, scanId: 1 });
    expect(d.server.contacts[0]!.body).toMatchObject({ scanId: 1, cardImageUrl: "/api/scans/1/image", eventId: 5 });
    expect(d.queue).toEqual([]);
    expect(d.uploaded).toEqual(["s1"]);
  });

  it("the connection drops between the two requests: the next run does NOT read the card again", async () => {
    const d = device();
    addScan(d, "s1");
    d.server.before = (call) => {
      if (call === "createContact") throw NETWORK();
    };
    const first = await sync(d);
    expect(first).toMatchObject({ synced: 0, failed: 0, stopped: "offline", reasonKind: "network" });
    // not failed, not lost: waiting, with the server's reading of the card kept
    expect(item(d, "s1")).toMatchObject({ status: "pending", scanId: 1, errorKind: "network", attempts: 0 });
    expect(item(d, "s1")!.extracted).toMatchObject({ firstName: "Card" });

    d.server.before = () => {};
    d.server.calls = [];
    const second = await sync(d);
    expect(second).toMatchObject({ synced: 1, stopped: null });
    expect(d.server.calls).toEqual(["getScan", "createContact"]); // no second createScan
    expect(d.server.scans.size).toBe(1);
    expect(d.server.contacts).toHaveLength(1);
  });

  it("the app is closed between the two requests: after the restart the card is still not read twice", async () => {
    const d = device();
    addScan(d, "s1");
    let storedWhenKilled = "";
    d.server.before = (call) => {
      if (call === "createContact") {
        storedWhenKilled = d.stored; // exactly what was on the device at that moment
        throw new Error("process killed");
      }
    };
    await sync(d);
    expect(storedWhenKilled).toContain('"scanId":1'); // the scan id was stored BEFORE the contact request

    restart(d, storedWhenKilled);
    expect(item(d, "s1")).toMatchObject({ status: "pending", scanId: 1 }); // "syncing" came back as pending
    d.server.before = () => {};
    d.server.calls = [];
    await sync(d);
    expect(d.server.calls).toEqual(["getScan", "createContact"]);
    expect(d.server.scans.size).toBe(1);
    expect(d.server.contacts).toHaveLength(1);
    expect(d.queue).toEqual([]);
  });

  it("the contact WAS created but its answer was lost: the next run sees that and creates no second contact", async () => {
    const d = device();
    addScan(d, "s1");
    d.server.after = (call) => {
      if (call === "createContact") throw NETWORK(); // the server did its work; the answer never arrived
    };
    const first = await sync(d);
    expect(first.stopped).toBe("offline");
    expect(d.server.contacts).toHaveLength(1);
    expect(item(d, "s1")).toMatchObject({ status: "pending", scanId: 1 });

    d.server.after = () => {};
    d.server.calls = [];
    const second = await sync(d);
    expect(second).toMatchObject({ synced: 1 });
    expect(d.server.calls).toEqual(["getScan"]); // the scan already has its contact: nothing more is sent
    expect(d.server.contacts).toHaveLength(1);
    expect(d.queue).toEqual([]);
  });

  it("a scan that no longer exists on the server starts over instead of failing forever", async () => {
    const d = device();
    addScan(d, "s1", A, { scanId: 999, extracted: { firstName: "Stale" } });
    const result = await sync(d);
    expect(result).toMatchObject({ synced: 1 });
    expect(d.server.calls).toEqual(["getScan", "createScan", "createContact"]);
    expect(d.server.contacts).toHaveLength(1);
  });

  it("a capture whose card was already read online carries no photo and still becomes a linked contact", async () => {
    const d = device();
    await d.server.createScan({ imageData: "x" }); // rapid capture: the scan request had succeeded
    d.server.calls = [];
    d.queue = enqueueItem(d.queue, { kind: "scan", label: "Rapid", source: "card", scanId: 1, extracted: { firstName: "Rapid", email: "rapid@example.test" } }, A, d.now, "r1")!;
    const result = await sync(d);
    expect(result).toMatchObject({ synced: 1 });
    expect(d.server.calls).toEqual(["getScan", "createContact"]);
    expect(d.server.contacts[0]!.body).toMatchObject({ firstName: "Rapid", scanId: 1 });
  });
});

describe("an expired session stops the run and loses nothing", () => {
  it("401 on the first item: nothing is marked failed, the rest is not even tried", async () => {
    const d = device();
    for (const id of ["s1", "s2", "s3"]) addScan(d, id);
    addContact(d, "c1", "c1@example.test");
    d.server.session = null; // the server no longer accepts the session
    const result = await sync(d);
    expect(result).toMatchObject({ attempted: 0, synced: 0, failed: 0, stopped: "auth", reasonKind: "session_expired" });
    expect(d.server.calls).toHaveLength(1);
    expect(queueCounts(d.queue, A)).toEqual({ pending: 4, failed: 0, conflicts: 0, queued: 4 });
    expect(d.queue.every((it) => it.attempts === 0)).toBe(true);
  });

  it("after signing in again the same account's items go through, each exactly once", async () => {
    const d = device();
    for (const id of ["s1", "s2"]) addScan(d, id);
    d.server.session = null;
    await sync(d);
    d.owner = null; // the app signed the user out
    expect((await sync(d)).stopped).toBe("no-owner");
    d.owner = A;
    d.server.session = A;
    const result = await sync(d);
    expect(result).toMatchObject({ synced: 2, failed: 0, stopped: null });
    expect(d.server.contacts.map((c) => c.owner)).toEqual([A, A]);
    expect(d.server.scans.size).toBe(2);
  });

  it("the session expires between the two requests of a scan: the scan id survives and is used after sign-in", async () => {
    const d = device();
    addScan(d, "s1");
    d.server.before = (call) => {
      if (call === "createContact") d.server.session = null;
    };
    const first = await sync(d);
    expect(first.stopped).toBe("auth");
    expect(item(d, "s1")).toMatchObject({ status: "pending", scanId: 1 });
    d.server.before = () => {};
    d.server.session = A;
    d.server.calls = [];
    await sync(d);
    expect(d.server.calls).toEqual(["getScan", "createContact"]);
    expect(d.server.scans.size).toBe(1);
    expect(d.server.contacts).toHaveLength(1);
  });
});

describe("account switching", () => {
  it("another account signs in between the two requests of a scan: the second request is never sent under it", async () => {
    const d = device();
    addScan(d, "s1");
    d.server.after = (call) => {
      if (call === "createScan") {
        d.owner = B; // A signed out and B signed in while the scan request was under way
        d.server.session = B;
      }
    };
    const result = await sync(d);
    expect(result).toMatchObject({ synced: 0, failed: 0, stopped: "owner-changed" });
    expect(d.server.calls).toEqual(["createScan"]); // no createContact under B
    expect(d.server.contacts).toEqual([]);
    // A's item waits, with its progress, invisible to B
    expect(item(d, "s1")).toMatchObject({ owner: A, status: "pending", scanId: 1 });
    expect(visibleQueue(d.queue, B)).toEqual([]);
    expect(syncTargets(d.queue, B)).toEqual([]);
  });

  it("B's run never touches A's waiting items; when A returns they continue where they stopped", async () => {
    const d = device();
    addScan(d, "a1", A);
    addScan(d, "b1", B);
    addContact(d, "a2", "a2@example.test", A);
    d.owner = B;
    d.server.session = B;
    const asB = await sync(d);
    expect(asB).toMatchObject({ attempted: 1, synced: 1 });
    expect(d.server.contacts.map((c) => c.owner)).toEqual([B]);
    expect(d.queue.map((it) => it.id).sort()).toEqual(["a1", "a2"]);

    d.owner = A;
    d.server.session = A;
    const asA = await sync(d);
    expect(asA).toMatchObject({ attempted: 2, synced: 2 });
    expect(d.server.contacts.filter((c) => c.owner === A)).toHaveLength(2);
    expect(d.server.contacts.filter((c) => c.owner === B)).toHaveLength(1);
    expect(d.queue).toEqual([]);
  });

  it("an item is sent with the image of ITS owner's directory only", async () => {
    const d = device();
    addScan(d, "same-id", A);
    // B has no image under that name: were B's directory consulted, the load would fail
    d.images.delete(`${B}/same-id.jpg`);
    expect((await sync(d)).synced).toBe(1);
  });
});

describe("a contact that already exists becomes the user's decision, never a silent duplicate or a silent drop", () => {
  it("409 existing_contact_found → conflict: nothing created, not retried by itself, progress kept", async () => {
    const d = device();
    addContact(d, "c1", "known@example.test");
    d.server.existing.set("known@example.test", { id: 77, fullName: "Known Person" });
    const first = await sync(d);
    expect(first).toMatchObject({ synced: 0, failed: 0, conflicts: 1, stopped: null });
    expect(item(d, "c1")).toMatchObject({ status: "conflict", conflict: { contactId: 77, name: "Known Person" }, retryable: false });
    expect(queueCounts(d.queue, A)).toMatchObject({ conflicts: 1, failed: 0, pending: 0 });
    d.server.calls = [];
    await sync(d, { force: true });
    expect(d.server.calls).toEqual([]); // waits for the decision — not even "Sync now" resends it
    // survives a restart as a conflict
    restart(d);
    expect(item(d, "c1")).toMatchObject({ status: "conflict", conflict: { contactId: 77 } });
  });

  it('"Add to this contact" sends the explicit resolution for the contact the conflict named', async () => {
    const d = device();
    addScan(d, "s1");
    d.server.before = (call) => {
      if (call === "createContact" && d.server.existing.size === 0) {
        const scan = d.server.scans.get(1)!;
        d.server.existing.set(String(scan.extractedData.email), { id: 77, fullName: "Known Person" });
      }
    };
    await sync(d);
    expect(item(d, "s1")).toMatchObject({ status: "conflict", scanId: 1 });
    d.queue = resolveOwnedConflict(d.queue, "s1", A, "add_interaction");
    expect(item(d, "s1")).toMatchObject({ status: "pending", resolution: { mode: "add_interaction", contactId: 77 } });
    d.server.calls = [];
    const second = await sync(d);
    expect(second).toMatchObject({ synced: 1 });
    expect(d.server.calls).toEqual(["getScan", "createContact"]); // the card is not read again
    expect(d.server.contacts).toEqual([]); // no new contact
    expect(d.server.scans.get(1)!.contactId).toBe(77); // the capture is linked to the existing one
  });

  it('"Create separately" forces a separate contact; another account cannot resolve the item', async () => {
    const d = device();
    addContact(d, "c1", "known@example.test");
    d.server.existing.set("known@example.test", { id: 77, fullName: "Known Person" });
    await sync(d);
    const before = d.queue;
    expect(resolveOwnedConflict(d.queue, "c1", B, "create_separate")).toBe(before);
    expect(resolveOwnedConflict(d.queue, "nope", A, "create_separate")).toBe(before);
    d.queue = resolveOwnedConflict(d.queue, "c1", A, "create_separate");
    await sync(d);
    expect(d.server.contacts).toHaveLength(1);
    expect(d.server.contacts[0]!.body).toMatchObject({ dedupeResolution: "create_separate" });
    expect(d.queue).toEqual([]);
  });
});

describe("AI unavailable for every card", () => {
  for (const [code, status] of [
    ["AI_PROVIDER_UNAVAILABLE", 503],
    ["AI_PLATFORM_LIMIT_REACHED", 503],
    ["AI_NOT_CONFIGURED", 503],
    ["AI_BUDGET_EXCEEDED", 429],
    ["AI_DISABLED", 403],
  ] as const) {
    it(`${code}: the scans wait (one request, not one per photo) and the contacts still go through`, async () => {
      const d = device();
      for (const id of ["s1", "s2", "s3"]) addScan(d, id);
      addContact(d, "c1", "c1@example.test");
      d.server.before = (call) => {
        if (call === "createScan") throw httpError(status, { code, error: "internal provider detail must never be shown" });
      };
      const result = await sync(d);
      expect(result).toMatchObject({ synced: 1, failed: 0, deferred: 3, stopped: null });
      expect(d.server.calls.filter((c) => c === "createScan")).toHaveLength(1);
      expect(d.server.contacts).toHaveLength(1);
      expect(queueCounts(d.queue, A)).toMatchObject({ pending: 3, failed: 0 });
      // the reason is kept as a kind, never as the server's text
      expect(JSON.stringify(d.queue)).not.toContain("internal provider detail");
    });
  }

  it("a rate limit stops the run; everything keeps waiting", async () => {
    const d = device();
    for (const id of ["s1", "s2"]) addScan(d, id);
    d.server.before = () => {
      throw httpError(429, { code: "AI_RATE_LIMITED" });
    };
    const result = await sync(d);
    expect(result).toMatchObject({ synced: 0, failed: 0, stopped: "rate-limited" });
    expect(d.server.calls).toHaveLength(1);
    expect(queueCounts(d.queue, A)).toMatchObject({ pending: 2, failed: 0 });
  });
});

describe("failures: what is retried automatically and what waits for the user", () => {
  it("a photo without a readable card fails once and is NOT uploaded again on every reconnect", async () => {
    const d = device();
    addScan(d, "s1");
    d.server.before = (call) => {
      if (call === "createScan") throw httpError(422, { code: "SCAN_NO_CARD", error: "No readable business card" });
    };
    const first = await sync(d);
    expect(first).toMatchObject({ failed: 1 });
    expect(item(d, "s1")).toMatchObject({ status: "failed", errorKind: "no_card", retryable: false, attempts: 1 });
    d.server.calls = [];
    d.now += 24 * 60 * 60_000;
    await sync(d);
    await sync(d, { force: true });
    expect(d.server.calls).toEqual([]); // not even "Sync now" resends it
    // only the user's own Retry does
    d.queue = retryOwnedItem(d.queue, "s1", A);
    d.server.before = () => {};
    await sync(d);
    expect(d.server.contacts).toHaveLength(1);
  });

  it("a server-side hiccup is retried later with a growing delay, immediately when the user asks", async () => {
    const d = device();
    addContact(d, "c1", "c1@example.test");
    d.server.before = () => {
      throw httpError(500, { error: "Internal server error" });
    };
    await sync(d);
    expect(item(d, "c1")).toMatchObject({ status: "failed", errorKind: "server", retryable: true, attempts: 1 });
    d.server.calls = [];
    d.now += retryDelayMs(1) - 1;
    await sync(d);
    expect(d.server.calls).toEqual([]); // too early
    d.now += 2;
    await sync(d);
    expect(d.server.calls).toEqual(["createContact"]);
    expect(item(d, "c1")).toMatchObject({ attempts: 2 });
    d.server.calls = [];
    await sync(d);
    expect(d.server.calls).toEqual([]); // the second delay is longer
    d.server.before = () => {};
    await sync(d, { force: true });
    expect(d.queue).toEqual([]);
    expect(retryDelayMs(1)).toBeLessThan(retryDelayMs(2));
    expect(retryDelayMs(9)).toBe(retryDelayMs(5));
  });

  it("a plan limit, a refusal and a refused image each fail without automatic retry", () => {
    const scan = { kind: "scan" } as QueueItem;
    for (const err of [
      httpError(409, { code: "LIMIT_EXCEEDED", error: "The contacts limit for this subscription has been reached (5/5; 1 requested)." }),
      httpError(403, { error: "Forbidden" }),
      httpError(403, { code: "FEATURE_NOT_ENTITLED" }),
      httpError(413, {}),
      httpError(400, { code: "SCAN_IMAGE_HEIC_UNSUPPORTED" }),
    ]) {
      expect(classifySyncFailure(err, scan), String(err.status)).toMatchObject({ action: "fail", retryable: false });
    }
  });

  it("a missing photo is reported as such; an unreadable one is retried", () => {
    const scan = { kind: "scan" } as QueueItem;
    expect(classifySyncFailure(new ScanFileError("image-missing"), scan)).toEqual({ action: "fail", kind: "image-missing", retryable: false });
    expect(classifySyncFailure(new ScanFileError("storage-unavailable"), scan)).toEqual({ action: "fail", kind: "storage-unavailable", retryable: true });
  });

  it("an item with nothing to send is failed for good, not sent as garbage", async () => {
    const d = device();
    d.queue = [{ id: "x1", kind: "scan", status: "pending", createdAt: 1, attempts: 0, owner: A, label: "x", source: "card" }];
    await sync(d);
    expect(item(d, "x1")).toMatchObject({ status: "failed", errorKind: "malformed", retryable: false });
    expect(d.server.calls).toEqual([]);
  });
});

describe("an answer that is not the API's is never taken for success", () => {
  it("a sign-in page of a public Wi-Fi (HTML text instead of a scan) keeps the item", async () => {
    const d = device();
    addScan(d, "s1");
    const portal = "<html><body>Please sign in to the hotel Wi-Fi</body></html>";
    d.server.createScan = async () => portal;
    d.server.createContact = async () => portal;
    const result = await sync(d);
    expect(result).toMatchObject({ synced: 0, failed: 1 });
    expect(item(d, "s1")).toMatchObject({ status: "failed", errorKind: "server", retryable: true });
    expect(item(d, "s1")!.scanId).toBeUndefined();
  });

  it("the same for a contact and for the user's own card", async () => {
    const d = device();
    addContact(d, "c1", "c1@example.test");
    d.queue = enqueueItem(d.queue, { kind: "card", label: "My card", source: "card", cardPayload: { fullName: "Me" } }, A, d.now, "k1")!;
    d.server.createContact = async () => "";
    d.server.upsertOwnCard = async () => null;
    const result = await sync(d);
    expect(result).toMatchObject({ synced: 0, failed: 2 });
    expect(d.queue).toHaveLength(2);
  });
});

describe("offline", () => {
  it("nothing is sent while offline; going offline mid-run leaves the rest waiting, unmarked", async () => {
    const d = device();
    for (const id of ["s1", "s2", "s3"]) addScan(d, id);
    d.online = false;
    expect(await sync(d)).toMatchObject({ attempted: 0, stopped: "offline" });
    expect(d.server.calls).toEqual([]);
    d.online = true;
    d.server.after = (call) => {
      if (call === "createContact") d.online = false; // connection lost after the first item
    };
    const result = await sync(d);
    expect(result).toMatchObject({ synced: 1, failed: 0, stopped: "offline" });
    expect(queueCounts(d.queue, A)).toMatchObject({ pending: 2, failed: 0 });
  });
});

describe("stress: a long session with interruptions of every kind", () => {
  it("300 captures, repeatedly interrupted and restarted: every one ends up as exactly one contact of its own account", async () => {
    const d = device();
    const owners: Record<string, string> = {};
    for (let i = 0; i < 300; i += 1) {
      const owner = i % 4 === 0 ? B : A;
      const id = `${1763630000000 + i}-n${i}`;
      owners[id] = owner;
      if (i % 5 === 0) addContact(d, id, `manual${i}@example.test`, owner);
      else addScan(d, id, owner);
    }
    // Deterministic trouble: every 7th request loses its connection BEFORE it is
    // handled; every 11th contact answer is lost AFTER the server did its work;
    // every 13th request finds the session expired; and the app is closed now and then.
    let n = 0;
    d.server.before = (call) => {
      n += 1;
      if (n % 7 === 0) throw NETWORK();
      if (n % 13 === 0) throw httpError(401, { error: "Session expired. Please sign in again." });
      void call;
    };
    let answers = 0;
    d.server.after = (call) => {
      if (call !== "createContact") return;
      answers += 1;
      if (answers % 11 === 0) throw NETWORK();
    };
    let rounds = 0;
    let explainedConflicts = 0;
    while (d.queue.length > 0 && rounds < 4000) {
      rounds += 1;
      d.owner = rounds % 3 === 0 ? B : A;
      d.server.session = d.owner;
      d.now += 20 * 60_000; // past any retry delay
      await sync(d);
      // The user looks at the Sync Center. A manual contact whose answer was
      // lost comes back as "already in your contacts — probably saved by an
      // earlier attempt": the user checks and removes the entry. Nothing else
      // may ever become a conflict here.
      for (const it of visibleQueue(d.queue, d.owner)) {
        if (it.status !== "conflict") continue;
        expect(it.kind).toBe("contact");
        expect(it.conflict?.afterLostAnswer).toBe(true);
        const saved = d.server.contacts.find((c) => c.id === it.conflict!.contactId)!;
        expect(saved.owner).toBe(it.owner);
        expect(saved.body.email).toBe(it.payload!.email);
        explainedConflicts += 1;
        d.uploaded.push(it.id);
        d.queue = d.queue.filter((q) => q.id !== it.id);
        d.stored = serializeQueue(d.queue);
      }
      if (rounds % 5 === 0) restart(d); // the app is closed and opened again
    }
    expect(d.queue).toEqual([]);
    expect(explainedConflicts).toBeGreaterThan(0);
    expect(d.server.contacts).toHaveLength(300);
    // exactly one contact per capture, under the account that made it
    const scanContacts = d.server.contacts.filter((c) => c.scanId !== null);
    expect(new Set(scanContacts.map((c) => c.scanId)).size).toBe(scanContacts.length);
    expect(scanContacts).toHaveLength(240);
    for (const c of d.server.contacts) {
      if (c.scanId !== null) expect(d.server.scans.get(c.scanId)!.owner).toBe(c.owner);
    }
    expect(d.server.contacts.filter((c) => c.owner === B)).toHaveLength(75);
    // no card was read twice: an interruption before a request has no effect on the server,
    // and one after the scan request is resumed from the stored scan id
    expect(d.server.scans.size).toBe(240);
    expect(new Set(d.uploaded).size).toBe(300);
  });
});

describe("what the user is told", () => {
  const lookup = (obj: unknown, path: string) => path.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), obj);

  it("every reason has a sentence in English and Arabic; an unknown reason gets the generic one", () => {
    const kinds = [
      "network", "session_expired", "rate_limited", "duplicate", "ai_disabled", "ai_not_configured", "ai_unavailable", "ai_platform_limit",
      "ai_budget", "no_card", "image_too_large", "image_heic", "invalid", "image-invalid", "image-missing", "storage-unavailable", "storage-full",
      "limit", "permission", "not_entitled", "server", "upstream", "unknown", "malformed", undefined, "something-new",
    ];
    for (const kind of kinds) {
      const key = syncProblemKey(kind);
      expect(typeof lookup(en, key), `en ${key}`).toBe("string");
      expect(typeof lookup(ar, key), `ar ${key}`).toBe("string");
    }
    expect(syncProblemKey("something-new")).toBe("sync.problem.generic");
    expect(syncProblemKey(undefined)).toBe("sync.problem.generic");
  });

  it("a provider outage and a reached platform limit read the same to a customer", () => {
    expect(syncProblemKey("ai_platform_limit")).toBe(syncProblemKey("ai_unavailable"));
  });

  it("the card fields mapped from a scan are the ones rapid capture uses", () => {
    expect(extractedToContact({ firstName: "A", company: "Co", officePhone: "1", country: "AE" }, { eventId: 3 })).toMatchObject({
      firstName: "A",
      contactCompany: "Co",
      officePhone: "1",
      country: "AE",
      eventId: 3,
    });
  });
});
