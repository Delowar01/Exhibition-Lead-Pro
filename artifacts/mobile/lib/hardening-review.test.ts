// Phase 2 Batch 1 — regression tests for the findings of the SECOND independent
// review (of the hardening itself). Each block names the scenario the review
// reproduced and asserts the corrected behaviour.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { customFetch, refreshToken as requestTokenRefresh, setAuthTokenGetter, setOnUnauthorized } from "@workspace/api-client-react";

import { classifyRefreshFailure, decideOnUnauthorized, parseRefreshResponse } from "./auth-session-model";
import ar from "./i18n/locales/ar.json";
import en from "./i18n/locales/en.json";
import { enqueueItem, readStoredQueue, replacedBy, type QueueItem } from "./offline-queue-model";
import {
  MAX_DONE_IDS,
  RECOVERED_DETAILS_LOST,
  fingerprintOf,
  incidentNeedsAttention,
  parseIncident,
  planAdoption,
  rememberDone,
  restoredToProcess,
} from "./offline-queue-store-model";
import { SESSION_RENEWAL_ABANDON_MS, SESSION_RENEWAL_TIMEOUT_MS } from "./request-timeout";
import { createScanFileStore } from "./scan-files";
import { createSessionRenewer } from "./session-renewal";
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
const DAY = 86_400_000;

async function freshModule() {
  vi.resetModules();
  return import("./offline-queue");
}
const noFiles = () => createScanFileStore(createMemoryScanDriver());
const stored = (key: string): string | undefined => storage.current.data.get(key);
const storedIds = (): string[] => (JSON.parse(stored(INDEX) ?? "[]") as QueueItem[]).map((it) => it.id);

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
describe("review 2/1 — a session renewal that answers late must not cost the session", () => {
  /** The API's rotateSession: single-use refresh tokens; presenting a replaced one revokes the session. */
  function server() {
    const s = {
      current: "R1",
      previous: null as string | null,
      revoked: false,
      seq: 1,
      log: [] as string[],
      rotate(refreshToken: string): { token: string; refreshToken: string } {
        if (s.revoked) throw Object.assign(new Error("HTTP 401"), { status: 401, data: { error: "Session revoked" } });
        if (refreshToken === s.previous) {
          s.revoked = true;
          s.log.push(`REVOKED (reuse of ${refreshToken})`);
          throw Object.assign(new Error("HTTP 401"), { status: 401, data: { error: "Refresh token reuse detected" } });
        }
        if (refreshToken !== s.current) throw Object.assign(new Error("HTTP 401"), { status: 401, data: { error: "Invalid refresh token" } });
        s.seq += 1;
        s.previous = s.current;
        s.current = `R${s.seq}`;
        s.log.push(`rotated ${s.previous}→${s.current}`);
        return { token: `T${s.seq}`, refreshToken: s.current };
      },
    };
    return s;
  }

  /** The app's session and the handlers contexts/AuthContext.tsx passes to the renewer. */
  function app() {
    const state = { access: "T1" as string | null, refresh: "R1" as string | null, ended: null as string | null, adopted: 0 };
    const handlersFor = (expectedAccess: string) => ({
      adopt: async (answer: unknown): Promise<string | null> => {
        const renewed = parseRefreshResponse(answer);
        if (!renewed) return null;
        if (state.access === renewed.token && state.refresh === renewed.refreshToken) return renewed.token;
        if (state.access !== expectedAccess) return null; // signed out, another account, or renewed meanwhile
        state.access = renewed.token;
        state.refresh = renewed.refreshToken;
        state.adopted += 1;
        return renewed.token;
      },
      failed: async (err: unknown): Promise<void> => {
        const failure = classifyRefreshFailure(err);
        if (failure.kind === "ended" && state.access === expectedAccess) {
          state.ended = failure.reason;
          state.access = null;
          state.refresh = null;
        }
      },
    });
    return { state, handlersFor };
  }

  it("the answer arrives after the waiter's deadline: it is taken into use then, the old token is never sent twice, and the session lives", async () => {
    vi.useFakeTimers();
    const api = server();
    const { state, handlersFor } = app();
    const sent: string[] = [];
    const renewer = createSessionRenewer({
      // The server handles the request at once; its answer needs 40 s to get back (a stalled connection that resumes).
      request: (rt) => {
        sent.push(rt);
        const answer = api.rotate(rt);
        return new Promise((r) => setTimeout(() => r(answer), 40_000));
      },
      timeoutMs: SESSION_RENEWAL_TIMEOUT_MS,
      abandonMs: SESSION_RENEWAL_ABANDON_MS,
      now: () => Date.now(),
    });

    const first = renewer.renew("R1", handlersFor("T1"));
    await vi.advanceTimersByTimeAsync(SESSION_RENEWAL_TIMEOUT_MS + 1);
    expect(await first).toBeNull(); // this request fails; the session is untouched
    expect(state).toMatchObject({ access: "T1", refresh: "R1", ended: null });

    // A second request is rejected meanwhile: it waits on the SAME renewal instead of sending R1 again.
    expect(renewer.pendingFor("R1")).toBe(true);
    const second = renewer.renew("R1", handlersFor("T1"));
    await vi.advanceTimersByTimeAsync(10_000); // the answer arrives at 40 s
    expect(await second).toBe("T2");
    expect(sent).toEqual(["R1"]);
    expect(state).toMatchObject({ access: "T2", refresh: "R2", ended: null, adopted: 1 });
    expect(api.log).toEqual(["rotated R1→R2"]); // never "REVOKED"

    // The next renewal uses the new token (its own answer is slow too, and is taken into use when it arrives).
    void renewer.renew(state.refresh as string, handlersFor("T2"));
    await vi.advanceTimersByTimeAsync(40_001);
    expect(state).toMatchObject({ access: "T3", refresh: "R3", ended: null });
    expect(sent).toEqual(["R1", "R2"]);
    expect(api.revoked).toBe(false);
  });

  it("nobody is waiting any more when the answer arrives: it is still taken into use, exactly once", async () => {
    vi.useFakeTimers();
    const api = server();
    const { state, handlersFor } = app();
    const renewer = createSessionRenewer({
      request: (rt) => {
        const answer = api.rotate(rt);
        return new Promise((r) => setTimeout(() => r(answer), 70_000));
      },
      timeoutMs: 30_000,
      abandonMs: 120_000,
      now: () => Date.now(),
    });
    const waiters = [renewer.renew("R1", handlersFor("T1")), renewer.renew("R1", handlersFor("T1"))];
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await Promise.all(waiters)).toEqual([null, null]);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(state).toMatchObject({ access: "T2", refresh: "R2", adopted: 1 });
    expect(renewer.pendingFor("R1")).toBe(false);
  });

  it("the request never answers: nothing is sent a second time until it counts as lost; then one new request is allowed", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const { handlersFor } = app();
    const renewer = createSessionRenewer({
      request: (rt) => {
        sent.push(rt);
        return new Promise(() => {});
      },
      timeoutMs: 30_000,
      abandonMs: 120_000,
      now: () => Date.now(),
    });
    for (let i = 0; i < 3; i++) {
      const waiter = renewer.renew("R1", handlersFor("T1"));
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await waiter).toBeNull();
    }
    expect(sent).toEqual(["R1"]); // 90 s: still the one request
    await vi.advanceTimersByTimeAsync(30_000); // 120 s: given up
    expect(renewer.pendingFor("R1")).toBe(false);
    void renewer.renew("R1", handlersFor("T1"));
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["R1", "R1"]);
  });

  it("a refusal ends the session once, however many requests were waiting; no connection ends nothing", async () => {
    const { state, handlersFor } = app();
    let failures = 0;
    const refusing = createSessionRenewer({
      request: async () => {
        throw Object.assign(new Error("HTTP 401"), { status: 401, data: { error: "Session revoked" } });
      },
      timeoutMs: 30_000,
      abandonMs: 120_000,
      now: () => Date.now(),
    });
    const counted = (expected: string) => {
      const h = handlersFor(expected);
      return { adopt: h.adopt, failed: async (e: unknown) => ((failures += 1), h.failed(e)) };
    };
    expect(await Promise.all([refusing.renew("R1", counted("T1")), refusing.renew("R1", counted("T1")), refusing.renew("R1", counted("T1"))])).toEqual([null, null, null]);
    expect(failures).toBe(1);
    expect(state.ended).toBe("expired");

    const other = app();
    const offline = createSessionRenewer({
      request: async () => {
        throw new TypeError("Network request failed");
      },
      timeoutMs: 30_000,
      abandonMs: 120_000,
      now: () => Date.now(),
    });
    expect(await offline.renew("R1", other.handlersFor("T1"))).toBeNull();
    expect(other.state).toMatchObject({ access: "T1", refresh: "R1", ended: null });
    expect(offline.pendingFor("R1")).toBe(false); // settled: the next 401 may try again
  });

  it("a late answer after a sign-out, or for another account, changes nothing; handlers that throw surface nothing", async () => {
    vi.useFakeTimers();
    const api = server();
    const { state, handlersFor } = app();
    const renewer = createSessionRenewer({
      request: (rt) => {
        const answer = api.rotate(rt);
        return new Promise((r) => setTimeout(() => r(answer), 40_000));
      },
      timeoutMs: 30_000,
      abandonMs: 120_000,
      now: () => Date.now(),
    });
    const waiter = renewer.renew("R1", handlersFor("T1"));
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await waiter).toBeNull();
    state.access = "TB"; // another account signed in
    state.refresh = "RB";
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state).toMatchObject({ access: "TB", refresh: "RB", adopted: 0 });

    const throwing = createSessionRenewer({ request: async () => ({ token: "T9", refreshToken: "R9" }), timeoutMs: 30_000, abandonMs: 120_000, now: () => Date.now() });
    const out = throwing.renew("RX", {
      adopt: async () => {
        throw new Error("storage");
      },
      failed: async () => {},
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(await out).toBeNull();
  });

  it("through the real API client and the app's rules: a slow renewal answer ends in a working session, not a sign-out", async () => {
    vi.useFakeTimers();
    const api = server();
    const { state, handlersFor } = app();
    let aborts = 0;
    // A network layer that DOES honour cancellation — the earlier defect only showed on one.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const auth = new Headers(init?.headers).get("authorization");
        return new Promise<Response>((resolveResponse, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborts += 1;
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          });
          const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
          if (url.endsWith("/api/auth/refresh")) {
            const { refreshToken } = JSON.parse(String(init?.body)) as { refreshToken: string };
            try {
              const answer = api.rotate(refreshToken);
              setTimeout(() => resolveResponse(json(200, answer)), 40_000);
            } catch (e) {
              resolveResponse(json(401, (e as { data: unknown }).data));
            }
            return;
          }
          resolveResponse(auth === `Bearer T${api.seq}` && !api.revoked ? json(200, { ok: true }) : json(401, { error: "Invalid or expired token" }));
        });
      }),
    );
    const renewer = createSessionRenewer({
      request: (refreshToken) => requestTokenRefresh({ refreshToken }), // exactly as contexts/AuthContext.tsx: no signal
      timeoutMs: SESSION_RENEWAL_TIMEOUT_MS,
      abandonMs: SESSION_RENEWAL_ABANDON_MS,
      now: () => Date.now(),
    });
    setAuthTokenGetter(() => state.access);
    setOnUnauthorized(async ({ failedToken, url }) => {
      const session = { generation: 1, accessToken: state.access, refreshToken: state.refresh, issuedTokens: state.access ? [state.access] : [] };
      const decision = decideOnUnauthorized(session, failedToken, url);
      if (decision.action === "retry") return decision.token;
      if (decision.action !== "refresh") return null;
      return renewer.renew(decision.refreshToken, handlersFor(session.accessToken as string));
    });
    const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: { status?: number }) => `err:${e.status}`);

    // The app's access token has expired (the stub accepts only the newest one); its refresh token R1 is good.
    state.access = "T0";
    const first = outcome(customFetch("/api/contacts"));
    await vi.advanceTimersByTimeAsync(SESSION_RENEWAL_TIMEOUT_MS + 1);
    expect(await first).toBe("err:401"); // no answer in time: this request fails
    expect(state.ended).toBeNull(); // …but nobody is signed out
    expect(aborts).toBe(0); // and the renewal request was NOT cancelled
    await vi.advanceTimersByTimeAsync(10_000); // the answer arrives
    expect(state).toMatchObject({ access: "T2", refresh: "R2", ended: null });
    const second = outcome(customFetch("/api/contacts"));
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toBe("ok");
    expect(api.log).toEqual(["rotated R1→R2"]);
  });

  it("the provider sends the renewal without a cancellation signal and through the one renewer (source wiring)", () => {
    const auth = readFileSync(resolve(__dirname, "../contexts/AuthContext.tsx"), "utf8");
    expect(auth).toMatch(/createSessionRenewer\(\{\s*request: \(refreshToken\) => requestTokenRefresh\(\{ refreshToken \}\),\s*timeoutMs: SESSION_RENEWAL_TIMEOUT_MS,\s*abandonMs: SESSION_RENEWAL_ABANDON_MS,/);
    expect(auth).toContain("return renewer.renew(decision.refreshToken, {");
    expect(auth).not.toMatch(/requestTokenRefresh\([^)]*,\s*o\)/); // never with a signal
    expect(auth).not.toContain("withTimeout(");
    // the sync's wording no longer tells a signed-in user to sign in again after a renewal that merely took too long
    expect(en.sync.problem.session).toMatch(/tries again by itself/);
    expect(en.sync.problem.session).not.toMatch(/^.*Sign in again to continue syncing\.$/);
    expect(ar.sync.problem.session.length).toBeGreaterThan(20);
  });
});

// ===========================================================================
describe("review 2/2 — an old queue that stays on the device is not taken over a second time", () => {
  const legacy = (): unknown[] => [
    { id: "1763630000001-aaa", kind: "contact", status: "pending", createdAt: 1763630000001, attempts: 0, owner: A, label: "Sara", source: "manual", payload: { firstName: "Sara" } },
    { id: "1763630000002-bbb", kind: "contact", status: "pending", createdAt: 1763630000002, attempts: 0, owner: A, label: "Omar", source: "manual", payload: { firstName: "Omar" } },
    { id: "1763630000003-ccc", kind: "card", status: "pending", createdAt: 1763630000003, attempts: 0, owner: A, label: "My card", source: "card", cardPayload: { fullName: "OLD NAME" } },
  ];
  const IDS = ["1763630000001-aaa", "1763630000002-bbb", "1763630000003-ccc"];

  it("a card edit replaced by a newer one does not come back from the old queue (the mark of the old queue prevents it)", async () => {
    storage.current.data.set(LEGACY, JSON.stringify(legacy()));
    storage.current.failKeys.add(LEGACY); // its removal fails
    const mod = await freshModule();
    const load = await mod.loadQueue(noFiles(), T0);
    expect(load.migrated).toBe(3);
    // The user edits their card again.
    const next = enqueueItem(load.items, { kind: "card", label: "My card", source: "card", cardPayload: { fullName: "NEW NAME" } as never }, A, T0 + 1, "1800000000009-new") as QueueItem[];
    expect(replacedBy(load.items, next).map((it) => it.id)).toEqual([IDS[2]]);
    expect(await mod.saveQueue(next, [])).toBe(true); // even before the replaced edit is recorded as finished

    const again = await (await freshModule()).loadQueue(noFiles(), T0 + 2);
    expect(again.migrated).toBe(0);
    const cards = again.items.filter((it) => it.kind === "card");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.cardPayload).toEqual({ fullName: "NEW NAME" });
  });

  it("replacing a card edit, stopped after EVERY single storage change in turn: one of the two edits always survives", async () => {
    const c1: QueueItem = { id: "1800000000001-card001", kind: "card", status: "pending", createdAt: 1, attempts: 0, owner: A, label: "My card", source: "card", cardPayload: { fullName: "FIRST EDIT" } as never };
    /** Exactly what contexts/OfflineContext.tsx `keep` does for an entry that replaces another. */
    async function replaceCard(mod: Awaited<ReturnType<typeof freshModule>>, before: QueueItem[], done: string[]): Promise<void> {
      const next = enqueueItem(before, { kind: "card", label: "My card", source: "card", cardPayload: { fullName: "SECOND EDIT" } as never }, A, T0, "1800000000002-card002") as QueueItem[];
      const superseded = replacedBy(before, next).map((it) => it.id);
      if (await mod.saveQueue(next, done)) {
        let recorded = done;
        for (const old of superseded) recorded = rememberDone(recorded, old);
        await mod.saveQueue(next, recorded);
      }
    }
    for (let died = 0; died <= 4; died++) {
      storage.current = createMemoryAsyncStorage();
      const mod = await freshModule();
      await mod.loadQueue(noFiles(), T0);
      expect(await mod.saveQueue([c1], [])).toBe(true);
      storage.current.changesLeft = died;
      await replaceCard(mod, [c1], []);
      storage.current.changesLeft = null;
      const after = await (await freshModule()).loadQueue(noFiles(), T0 + 1);
      const names = after.items.filter((it) => it.kind === "card").map((it) => (it.cardPayload as { fullName: string }).fullName);
      expect(names.length, `stopped after ${died} change(s): ${JSON.stringify(names)}`).toBe(1); // never none, never both
      expect(["FIRST EDIT", "SECOND EDIT"]).toContain(names[0]);
    }
    // The provider records the replaced edit as finished only AFTER the new one is stored (source wiring).
    const provider = readFileSync(resolve(__dirname, "../contexts/OfflineContext.tsx"), "utf8");
    const keep = provider.slice(provider.indexOf("const keep = useCallback("), provider.indexOf("const enqueueContact = useCallback("));
    expect(keep.indexOf("if (await commit(next)) {")).toBeGreaterThan(0);
    expect(keep.indexOf("doneRef.current = rememberDone(doneRef.current, old);")).toBeGreaterThan(keep.indexOf("if (await commit(next)) {"));
    expect(keep.match(/rememberDone\(/g)).toHaveLength(1);
  });

  it("the index is damaged or gone while the old queue is still on the device: its entries come back from there, mark or no mark", async () => {
    // (1) The old queue stayed because its removal failed once; later the index is cut short.
    storage.current.data.set(LEGACY, JSON.stringify(legacy()));
    storage.current.failKeys.add(LEGACY);
    await (await freshModule()).loadQueue(noFiles(), T0);
    storage.current.failKeys.clear();
    const index = stored(INDEX) as string;
    storage.current.data.set(INDEX, index.slice(0, index.length - 30)); // the last entry is cut off
    const cut = await (await freshModule()).loadQueue(noFiles(), T0 + 1);
    expect(cut.indexDamaged).toBe(true);
    expect(cut.items.map((it) => it.id).sort()).toEqual([...IDS].sort()); // the cut-off entry is back, from the old queue
    expect(new Set(cut.items.map((it) => it.id)).size).toBe(3); // each once

    // (2) A partly unreadable old queue (kept by design); the index key disappears.
    storage.current = createMemoryAsyncStorage();
    storage.current.data.set(LEGACY, JSON.stringify([...legacy(), { broken: true }]));
    await (await freshModule()).loadQueue(noFiles(), T0);
    expect(stored(FLAG)).toBeDefined();
    storage.current.data.delete(INDEX);
    const gone = await (await freshModule()).loadQueue(noFiles(), T0 + 1);
    expect(gone.items.map((it) => it.id).sort()).toEqual([...IDS].sort());
    expect(gone.migrated).toBe(3);

    // (3) What was uploaded meanwhile still does not come back with them.
    storage.current = createMemoryAsyncStorage();
    storage.current.data.set(LEGACY, JSON.stringify([...legacy(), { broken: true }]));
    const mod = await freshModule();
    const first = await mod.loadQueue(noFiles(), T0);
    expect(await mod.saveQueue(first.items.filter((it) => it.id !== IDS[0]), [IDS[0] as string])).toBe(true);
    storage.current.data.set(INDEX, "{damaged");
    const after = await (await freshModule()).loadQueue(noFiles(), T0 + 1);
    expect(after.items.map((it) => it.id).sort()).toEqual([IDS[1], IDS[2]].sort());
  });

  it("uploaded items do not come back after the finished list has moved on (400 later ids) — neither from a healthy old queue nor from a partly unreadable one", async () => {
    for (const partly of [false, true]) {
      storage.current = createMemoryAsyncStorage();
      const value = partly ? [...legacy(), { broken: true }] : legacy();
      storage.current.data.set(LEGACY, JSON.stringify(value));
      if (!partly) storage.current.failKeys.add(LEGACY); // a healthy one whose removal keeps failing
      const mod = await freshModule();
      const load = await mod.loadQueue(noFiles(), T0);
      expect(load.items.map((it) => it.id)).toEqual(IDS);
      expect(stored(FLAG)).toBe(fingerprintOf(JSON.stringify(value)));

      // Everything syncs, and 400 further captures finish afterwards.
      let done: string[] = [];
      for (const id of IDS) done = rememberDone(done, id);
      for (let i = 0; i < MAX_DONE_IDS; i++) done = rememberDone(done, `later-${i}`);
      expect(done).not.toContain(IDS[0]);
      expect(await mod.saveQueue([], done)).toBe(true);

      const again = await (await freshModule()).loadQueue(noFiles(), T0 + DAY);
      expect(again.items, partly ? "partly unreadable" : "removal failing").toEqual([]);
      expect(again.migrated).toBe(0);
      expect(storedIds()).toEqual([]);
      expect(storage.current.data.has(LEGACY)).toBe(true); // still there, simply no longer read into the queue
    }
  });

  it("a DIFFERENT old queue (written after a downgrade) is taken over; the mark alone never removes anything", async () => {
    storage.current.data.set(LEGACY, JSON.stringify(legacy()));
    await (await freshModule()).loadQueue(noFiles(), T0);
    expect(storage.current.data.has(LEGACY)).toBe(false);
    const later = [{ id: "1763639999999-zzz", kind: "contact", status: "pending", createdAt: 1, attempts: 0, owner: A, label: "New", source: "manual", payload: { firstName: "New" } }];
    storage.current.data.set(LEGACY, JSON.stringify(later));
    const load = await (await freshModule()).loadQueue(noFiles(), T0 + 1);
    expect(load.migrated).toBe(1);
    expect(load.items.map((it) => it.id)).toContain("1763639999999-zzz");

    // A mark that matches, but a stored index that does NOT hold the items: the old queue stays.
    storage.current = createMemoryAsyncStorage();
    storage.current.data.set(LEGACY, JSON.stringify(legacy()));
    storage.current.data.set(FLAG, fingerprintOf(JSON.stringify(legacy())));
    storage.current.data.set(INDEX, "[]");
    const kept = await (await freshModule()).loadQueue(noFiles(), T0 + 2);
    expect(kept.migrated).toBe(0);
    expect(storage.current.data.has(LEGACY)).toBe(true);
  });

  it("fingerprintOf: the same value gives the same mark, a changed value another", () => {
    const a = JSON.stringify(legacy());
    expect(fingerprintOf(a)).toBe(fingerprintOf(a));
    expect(fingerprintOf(a)).toMatch(/^v2:\d+:[0-9a-f]+$/);
    expect(fingerprintOf(`${a} `)).not.toBe(fingerprintOf(a));
    expect(fingerprintOf(a.replace("Sara", "Sarb"))).not.toBe(fingerprintOf(a));
    expect(fingerprintOf("")).toBe("v2:0:811c9dc5");
  });
});

// ===========================================================================
describe("review 2/3 — the record of the damage stays true", () => {
  it("the kept copy was deleted but the record could not be rewritten; a NEW damage later is dated now, so photos in between are held", async () => {
    storage.current.data.set(INDEX, "{first damage");
    const mod = await freshModule();
    await mod.loadQueue(noFiles(), T0);
    storage.current.failKeys.add(INCIDENT); // the app dies / the write fails right after the copy is removed
    await mod.discardDamagedCopies();
    expect(stored(DAMAGED[0])).toBeUndefined();
    expect(parseIncident(stored(INCIDENT) ?? null)).toMatchObject({ copies: [DAMAGED[0]], acknowledged: false }); // stale
    storage.current.failKeys.clear();

    storage.current.data.set(INDEX, "{second damage, ten days later");
    const second = await (await freshModule()).loadQueue(noFiles(), T0 + 10 * DAY);
    expect(second.incident).toMatchObject({ at: T0 + 10 * DAY, copies: [DAMAGED[0]], acknowledged: false });
    expect(second.holdUnlistedBefore).toBe(T0 + 10 * DAY);
    // A photo taken between the two damages lost its entry with the second one: it waits for the user.
    const between = { id: `${T0 + 5 * DAY}-between`, file: `${T0 + 5 * DAY}-between.jpg`, bytes: 300 };
    const plan = planAdoption({ orphans: [between], owner: A, doneIds: [], presentIds: new Set(), now: T0 + 11 * DAY, heldBefore: second.holdUnlistedBefore });
    expect(plan.restore[0]).toMatchObject({ status: "failed", retryable: false, errorKind: RECOVERED_DETAILS_LOST });
  });

  it("a new damage whose record never got written is dated when it is recorded — not with the time of an older incident", async () => {
    // An old incident, long dealt with.
    storage.current.data.set(INDEX, "{old damage");
    const mod = await freshModule();
    await mod.loadQueue(noFiles(), T0);
    await mod.discardDamagedCopies();
    // A new damage 60 days later: its original is kept, then the app stops before the record is written.
    storage.current.data.set(INDEX, "{new damage");
    storage.current.failKeys.add(INCIDENT);
    const interrupted = await (await freshModule()).loadQueue(noFiles(), T0 + 60 * DAY);
    expect(interrupted).toMatchObject({ writable: false, damagedCopyFailed: true });
    expect(stored(DAMAGED[0])).toBe("{new damage");
    storage.current.failKeys.clear();
    const next = await (await freshModule()).loadQueue(noFiles(), T0 + 61 * DAY);
    expect(next.incident).toMatchObject({ at: T0 + 61 * DAY, copies: [DAMAGED[0]], acknowledged: false });
    const between = { id: `${T0 + 30 * DAY}-between`, file: `${T0 + 30 * DAY}-between.jpg`, bytes: 300 };
    const plan = planAdoption({ orphans: [between], owner: A, doneIds: [], presentIds: new Set(), now: T0 + 62 * DAY, heldBefore: next.holdUnlistedBefore });
    expect(plan.restore[0]?.status).toBe("failed"); // held, not sent unasked
  });

  it("entries already recorded as finished are not counted as 'read back'", async () => {
    const items = [1, 2, 3].map((n) => ({ id: `180000000000${n}-item00${n}`, kind: "contact", status: "pending", createdAt: n, attempts: 0, owner: A, label: `P${n}`, source: "manual", payload: { firstName: `P${n}` } }));
    storage.current.data.set(INDEX, JSON.stringify(items).slice(0, -1)); // not valid JSON any more, all three entries complete
    storage.current.data.set(DONE, JSON.stringify([items[0]?.id]));
    const load = await (await freshModule()).loadQueue(noFiles(), T0);
    expect(load.items.map((it) => it.id)).toEqual([items[1]?.id, items[2]?.id]);
    expect(load.incident?.salvaged).toBe(2);
  });

  it("a record that names a kept copy which is gone is put right at the next start (the notice does not claim a copy that is not there)", async () => {
    storage.current.data.set(INDEX, "{damage");
    const mod = await freshModule();
    await mod.loadQueue(noFiles(), T0);
    storage.current.failKeys.add(INCIDENT);
    await mod.discardDamagedCopies();
    storage.current.failKeys.clear();
    const next = await (await freshModule()).loadQueue(noFiles(), T0 + 1);
    expect(next.incident).toMatchObject({ copies: [], acknowledged: true, at: T0 });
    expect(incidentNeedsAttention(next.incident)).toBe(false);
    expect(parseIncident(stored(INCIDENT) ?? null)).toMatchObject({ copies: [], acknowledged: true });
  });

  it("a kept original the record does not name is listed all the same — so the user can always remove it", async () => {
    // An original kept earlier whose record was lost.
    storage.current.data.set(DAMAGED[1], "{an earlier original");
    storage.current.data.set(INDEX, "{damage");
    const mod = await freshModule();
    const load = await mod.loadQueue(noFiles(), T0);
    expect(load.incident?.copies).toEqual([DAMAGED[0], DAMAGED[1]]);
    // The same damage met again (the readable index could not be written): still both, still one event.
    storage.current.data.set(INDEX, "{damage");
    const again = await (await freshModule()).loadQueue(noFiles(), T0 + 5);
    expect(again.incident).toMatchObject({ at: T0, copies: [DAMAGED[0], DAMAGED[1]] });
    const mod2 = await freshModule();
    await mod2.loadQueue(noFiles(), T0 + 6);
    await mod2.discardDamagedCopies();
    expect(DAMAGED.map(stored)).toEqual([undefined, undefined, undefined]);
  });

  it("the record itself cannot be read at one start: every unlisted photo waits (the time of the damage is unknown)", async () => {
    storage.current.data.set(INDEX, "[]");
    storage.current.data.set(INCIDENT, JSON.stringify({ kind: "damaged", at: T0, salvaged: 0, unreadable: null, copies: [], acknowledged: true }));
    storage.current.unreadable.add(INCIDENT);
    const load = await (await freshModule()).loadQueue(noFiles(), T0 + 3 * DAY);
    expect(load.incident).toBeNull();
    expect(load.holdUnlistedBefore).toBe(T0 + 3 * DAY);
    const old = { id: `${T0 - DAY}-old0001`, file: `${T0 - DAY}-old0001.jpg`, bytes: 300 };
    const plan = planAdoption({ orphans: [old], owner: A, doneIds: [], presentIds: new Set(), now: T0 + 3 * DAY, heldBefore: load.holdUnlistedBefore });
    expect(plan.restore[0]?.status).toBe("failed");
  });
});

// ===========================================================================
describe("review 2/4 — salvage when the damage upsets quotes, and no count that could be wrong", () => {
  const entry = (n: number): QueueItem => ({
    id: `180000000000${n}-entry0${n}`,
    kind: "contact",
    status: "pending",
    createdAt: 1_800_000_000_000 + n,
    attempts: 0,
    owner: A,
    label: `Person ${n}`,
    source: "manual",
    payload: { firstName: `P${n}`, notes: `a "quoted" note, a } and a { for ${n}` } as never,
  });
  const five = () => [1, 2, 3, 4, 5].map(entry);
  const idsOf = (raw: string) => readStoredQueue(raw).items.map((it) => it.id);
  const texts = () => five().map((e) => JSON.stringify(e));

  it("a quote turned into another byte in the FIRST entry: the four entries after it are read", () => {
    const t = texts();
    const broken = (t[0] as string).replace('"kind"', '\u0000kind"');
    const reading = readStoredQueue(`[${[broken, ...t.slice(1)].join(",")}]`);
    expect(reading.state).toBe("damaged");
    expect(reading.items).toEqual(five().slice(1));
    expect(reading.unreadable).toBeNull();
  });

  it("a quote dropped in the THIRD entry: the two before and the two after are read", () => {
    const t = texts();
    const broken = (t[2] as string).replace('"label":"', '"label":');
    expect(idsOf(`[${[t[0], t[1], broken, t[3], t[4]].join(",")}]`)).toEqual([entry(1).id, entry(2).id, entry(4).id, entry(5).id]);
  });

  it("sixty bytes wiped across the border of two entries: the others are read", () => {
    const t = texts();
    const raw = `[${t.join(",")}]`;
    const border = raw.indexOf(t[2] as string) - 30;
    const wiped = raw.slice(0, border) + "\u0000".repeat(60) + raw.slice(border + 60);
    expect(idsOf(wiped)).toEqual([entry(1).id, entry(4).id, entry(5).id]);
    expect(readStoredQueue(wiped).unreadable).toBeNull();
  });

  it("the Sync Center states a number only when it is exact, and says so otherwise", () => {
    const exact = readStoredQueue(JSON.stringify([...five(), { nope: true }, 7]));
    expect(exact).toMatchObject({ state: "damaged", unreadable: 2 });
    expect(readStoredQueue(JSON.stringify(five()).slice(0, -20)).unreadable).toBeNull();
    const screen = readFileSync(resolve(__dirname, "../app/sync.tsx"), "utf8");
    expect(screen).toContain('incident.unreadable === null ? t("sync.damagedUnreadableUnknown") : t("sync.damagedUnreadable", { count: incident.unreadable })');
    expect(en.sync.damagedUnreadableUnknown).toMatch(/how many cannot be told/);
  });
});

// ===========================================================================
describe("review 2 — no stored list at all, but photos on the device (a cleared or replaced store)", () => {
  const photo = (at: number, tag: string) => `${at}-${tag}`;

  async function deviceWithPhotos() {
    const driver = createMemoryScanDriver();
    const files = createScanFileStore(driver);
    await files.saveImage(A, photo(T0 - 3 * DAY, "aaaaaaa"), fakeImage(300, "A"));
    await files.saveImage(A, photo(T0 - 2 * DAY, "bbbbbbb"), fakeImage(300, "B"));
    await files.saveImage(B, photo(T0 - DAY, "ccccccc"), fakeImage(300, "C"));
    return { driver, files };
  }

  it("anyImages: yes/no, accounts' folders only", async () => {
    const empty = noFiles();
    expect(await empty.anyImages()).toBe(false);
    const { driver, files } = await deviceWithPhotos();
    expect(await files.anyImages()).toBe(true);
    const other = createMemoryScanDriver();
    other.files.set(`${other.root()}_quarantine/${photo(T0, "qqqqqqq")}.jpg`, "AAAA");
    other.files.set(`${other.root()}11_1/notes.txt`, "AAAA");
    expect(await createScanFileStore(other).anyImages()).toBe(false);
    driver.setRoot(null);
    expect(await files.anyImages()).toBe(false);
  });

  it("the photos are put back for the user to decide on — not sent unasked, not deleted — and it is recorded and reported", async () => {
    const { driver, files } = await deviceWithPhotos();
    const mod = await freshModule();
    const load = await mod.loadQueue(files, T0);
    expect(load).toMatchObject({ items: [], writable: true, indexLost: true, indexDamaged: false, holdUnlistedBefore: T0 });
    expect(load.incident).toEqual({ kind: "lost", at: T0, salvaged: 0, unreadable: null, copies: [], acknowledged: false });
    expect(incidentNeedsAttention(load.incident)).toBe(true);

    const orphans = await files.findOrphans(A, new Set());
    const plan = planAdoption({ orphans, owner: A, doneIds: [], presentIds: new Set(), now: T0 + 1, heldBefore: load.holdUnlistedBefore });
    expect(plan.remove).toEqual([]);
    expect(plan.restore).toHaveLength(2);
    for (const it of plan.restore) expect(it).toMatchObject({ owner: A, status: "failed", retryable: false, errorKind: RECOVERED_DETAILS_LOST });
    expect(restoredToProcess(plan.restore)).toBe(0);
    expect(await mod.saveQueue(plan.restore)).toBe(true);
    expect(driver.files.size).toBe(3);

    // Weeks later the OTHER account signs in: its photo from before is held as well.
    const later = await (await freshModule()).loadQueue(files, T0 + 20 * DAY);
    expect(later).toMatchObject({ indexLost: false, holdUnlistedBefore: T0 });
    const forB = planAdoption({ orphans: await files.findOrphans(B, new Set(later.items.map((it) => it.id))), owner: B, doneIds: later.doneIds, presentIds: new Set(), now: T0 + 20 * DAY, heldBefore: later.holdUnlistedBefore });
    expect(forB.restore).toHaveLength(1);
    expect(forB.restore[0]).toMatchObject({ owner: B, status: "failed", errorKind: RECOVERED_DETAILS_LOST });

    // With nothing kept there is nothing to delete: the report is simply acknowledged.
    const mod3 = await freshModule();
    await mod3.loadQueue(files, T0 + 21 * DAY);
    const ack = await mod3.discardDamagedCopies();
    expect(ack).toMatchObject({ kind: "lost", acknowledged: true, at: T0 });
    expect(incidentNeedsAttention(ack)).toBe(false);
  });

  it("the lost list is found ONCE: an (empty) list is stored, so the alert does not return at every start and 'seen' stays seen", async () => {
    const { files } = await deviceWithPhotos();
    const mod = await freshModule();
    const first = await mod.loadQueue(files, T0);
    expect(first.indexLost).toBe(true);
    expect(stored(INDEX)).toBe("[]");
    expect((await mod.discardDamagedCopies())?.acknowledged).toBe(true); // "OK, I have seen this" — nobody adopted a photo
    for (let start = 1; start <= 3; start++) {
      const again = await (await freshModule()).loadQueue(files, T0 + start * DAY);
      expect(again.indexLost, `start ${start}`).toBe(false);
      expect(again.incident, `start ${start}`).toMatchObject({ kind: "lost", at: T0, acknowledged: true });
      expect(incidentNeedsAttention(again.incident)).toBe(false);
      expect(again.holdUnlistedBefore).toBe(T0); // the photos are still held for whoever they belong to
    }
  });

  it("an old queue whose take-over was interrupted after its photos were written is NOT 'a lost list': the entries come back from it", async () => {
    const legacy = [{ id: "1763630000001-aaa", kind: "scan", status: "pending", createdAt: 1763630000001, attempts: 0, owner: A, label: "Card", source: "card", imageData: fakeImage(3000, "A"), eventId: 7 }];
    storage.current.data.set(LEGACY, JSON.stringify(legacy));
    const driver = createMemoryScanDriver();
    const files = createScanFileStore(driver);
    storage.current.changesLeft = 0; // the app stops before the new index is stored — the photo file is already written
    await (await freshModule()).loadQueue(files, T0);
    expect(await files.anyImages()).toBe(true);
    expect(storage.current.data.has(INDEX)).toBe(false);
    storage.current.changesLeft = null;
    const next = await (await freshModule()).loadQueue(files, T0 + 1);
    expect(next).toMatchObject({ indexLost: false, incident: null, migrated: 1, holdUnlistedBefore: 0 });
    expect(next.items[0]).toMatchObject({ id: "1763630000001-aaa", status: "pending", eventId: 7, imageFile: "1763630000001-aaa.jpg" });
  });

  it("an old-queue value that merely stays on the device does not hide a lost list: photos of newer captures are still held", async () => {
    const partly = JSON.stringify([{ id: "1763630000001-aaa", kind: "contact", status: "pending", createdAt: 1, attempts: 0, owner: A, label: "Sara", source: "manual", payload: { firstName: "Sara" } }, { broken: true }]);
    for (const [name, oldValue] of [["partly unreadable, taken over before", partly], ["not a queue at all", "\u0000 not a queue \u0000"]] as const) {
      storage.current = createMemoryAsyncStorage();
      storage.current.data.set(LEGACY, oldValue);
      const driver = createMemoryScanDriver();
      const files = createScanFileStore(driver);
      await (await freshModule()).loadQueue(files, T0 - 30 * DAY); // the upgrade, a month ago: the old value stays by design
      expect(storage.current.data.has(LEGACY), name).toBe(true);
      // Since then captures were made with this version; now the index key is lost.
      await files.saveImage(A, `${T0 - DAY}-newcapt`, fakeImage(300, "N"));
      storage.current.data.delete(INDEX);
      const load = await (await freshModule()).loadQueue(files, T0);
      expect(load.indexLost, name).toBe(true);
      expect(load.incident, name).toMatchObject({ kind: "lost", at: T0 });
      const plan = planAdoption({ orphans: await files.findOrphans(A, new Set(load.items.map((it) => it.id))), owner: A, doneIds: load.doneIds, presentIds: new Set(), now: T0, heldBefore: load.holdUnlistedBefore });
      expect(plan.restore.map((it) => it.status), name).toEqual(["failed"]); // held, not sent without its details
    }
  });

  it("a fresh install (no photos) records nothing; an empty-string index with photos counts as lost too", async () => {
    const fresh = await (await freshModule()).loadQueue(noFiles(), T0);
    expect(fresh).toMatchObject({ indexLost: false, incident: null, holdUnlistedBefore: 0 });
    expect(storage.current.log).toEqual([]);

    const { files } = await deviceWithPhotos();
    storage.current.data.set(INDEX, "");
    const load = await (await freshModule()).loadQueue(files, T0);
    expect(load.indexLost).toBe(true);
    // An index that exists — even an empty list — is not "lost": an unlisted photo is then the leftover of an interrupted save.
    storage.current = createMemoryAsyncStorage();
    storage.current.data.set(INDEX, "[]");
    const present = await (await freshModule()).loadQueue(files, T0);
    expect(present).toMatchObject({ indexLost: false, incident: null, holdUnlistedBefore: 0 });
  });

  it("it cannot be recorded: nothing is written or sent in that session (it could not be honoured after a restart)", async () => {
    const { files } = await deviceWithPhotos();
    storage.current.failKeys.add(INCIDENT);
    const mod = await freshModule();
    const load = await mod.loadQueue(files, T0);
    expect(load).toMatchObject({ writable: false, indexLost: true, damagedCopyFailed: true });
    expect(mod.queueWritable()).toBe(false);
    expect(storage.current.log).toEqual([]);
  });

  it("the provider reports it at once and the Sync Center explains it (source wiring), in both languages", () => {
    const provider = readFileSync(resolve(__dirname, "../contexts/OfflineContext.tsx"), "utf8");
    expect(provider).toContain('? "sync.lostAlertBody"');
    const screen = readFileSync(resolve(__dirname, "../app/sync.tsx"), "utf8");
    expect(screen).toContain('t(incident.kind === "lost" ? "sync.lostBody" : "sync.damagedBody")');
    expect(screen).toContain('testID="dismiss-damaged-notice"');
    expect(screen).toContain("{heldPhotos > 0 ? (");
    // …and the home screen keeps pointing to it until the user has dealt with it
    const home = readFileSync(resolve(__dirname, "../app/(tabs)/index.tsx"), "utf8");
    expect(home).toMatch(/\{incidentNeedsAttention\(incident\) && incident \? \(\s*<Pressable\s*onPress=\{\(\) => \{\s*router\.push\("\/sync"\);/);
    expect(home).toContain('testID="home-queue-damaged"');
    for (const locale of [en, ar] as const) {
      expect(locale.sync.lostBody.length).toBeGreaterThan(40);
      expect(locale.sync.lostAlertBody.length).toBeGreaterThan(40);
      expect(locale.sync.damagedDismiss.length).toBeGreaterThan(3);
    }
    // the Arabic notice names the section by the heading it really has
    expect(ar.sync.damagedPhotos).toContain(ar.sync.needsAttentionShort);
    expect(en.sync.damagedPhotos).toContain(en.sync.needsAttentionShort);
  });
});

// ===========================================================================
describe("review 2/5 — 'restored and will be processed' counts only what is processed by itself", () => {
  it("held photos are not announced as being processed", () => {
    const orphans = [
      { id: `${T0 - DAY}-held001`, file: `${T0 - DAY}-held001.jpg`, bytes: 1 },
      { id: `${T0 + DAY}-fresh01`, file: `${T0 + DAY}-fresh01.jpg`, bytes: 1 },
      { id: "1700000000000-done001", file: "1700000000000-done001.jpg", bytes: 1 },
    ];
    const plan = planAdoption({ orphans, owner: A, doneIds: ["1700000000000-done001"], presentIds: new Set(), now: T0 + 2 * DAY, heldBefore: T0 });
    expect(plan.remove.map((o) => o.id)).toEqual(["1700000000000-done001"]); // the leftover of finished work
    expect(plan.restore.map((it) => it.status)).toEqual(["failed", "pending"]);
    expect(restoredToProcess(plan.restore)).toBe(1);
    // a photo that is listed, or being saved right now, is left alone
    const busy = planAdoption({ orphans, owner: A, doneIds: [], presentIds: new Set([orphans[1]?.id as string]), now: T0 + 2 * DAY, heldBefore: 0 });
    expect(busy.restore.map((it) => it.id)).not.toContain(orphans[1]?.id);
    expect(planAdoption({ orphans, owner: "nobody", doneIds: [], presentIds: new Set(), now: T0, heldBefore: 0 }).restore).toEqual([]);
  });
});
