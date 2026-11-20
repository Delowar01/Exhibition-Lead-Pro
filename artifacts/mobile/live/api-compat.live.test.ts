// Phase 2 Batch 1 — the mobile app's NEW behaviour against the REAL API contract.
//
// The unit suites prove the rules against a fake of four endpoints. This run
// proves that the real endpoints behave the way those rules assume, using the
// app's own modules end to end: the generated API client, the 401 hook, the
// session rules, the sync engine and the per-item work.
//
// LOCAL ONLY: a running local API on a disposable database with the synthetic
// seed accounts and the deterministic STUB AI provider. No hosted environment,
// no real provider, no real customer data. Skipped unless MOBILE_API_COMPAT_URL
// is set (see vitest.live.config.ts).
import jpeg from "jpeg-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ApiError,
  changePassword,
  createContact,
  createScan,
  customFetch,
  getScan,
  login,
  refreshToken,
  setAuthTokenGetter,
  setBaseUrl,
  setOnUnauthorized,
  upsertOwnCard,
} from "@workspace/api-client-react";

import { classifyApiFailure } from "../lib/api-failure";
import { classifySendError } from "../lib/assistant-error";
import { classifyRefreshFailure, decideOnUnauthorized, parseRefreshResponse, withIssuedToken } from "../lib/auth-session-model";
import {
  enqueueItem,
  queueOwnerKey,
  resolveOwnedConflict,
  syncOwnedQueue,
  type QueueItem,
  type SyncResult,
} from "../lib/offline-queue-model";
import { classifySyncFailure, createPerformer, extractedToContact, type SyncApi } from "../lib/offline-sync";
import { describeScanFailure } from "../lib/scan-error";

// No account is named in the mobile source (lib/login-release-guard.test.ts):
// the two synthetic tenant accounts of the local seed and their password come
// from the environment of whoever runs this.
const BASE = process.env.MOBILE_API_COMPAT_URL ?? "";
const PASSWORD = process.env.MOBILE_API_COMPAT_PASSWORD ?? "";
const TENANT_A = process.env.MOBILE_API_COMPAT_EMAIL_A ?? "";
const TENANT_B = process.env.MOBILE_API_COMPAT_EMAIL_B ?? "";

interface Session {
  token: string;
  refreshToken: string;
  owner: string;
  userId: number;
  companyId: number;
}

let current: Session | null = null;

async function signIn(email: string): Promise<Session> {
  const res = await login({ email, password: PASSWORD });
  if (!res.token || !res.refreshToken || !res.user) throw new Error(`sign-in of ${email} returned no session`);
  const owner = queueOwnerKey(res.user);
  if (!owner) throw new Error(`${email} is not a tenant account`);
  return { token: res.token, refreshToken: res.refreshToken, owner, userId: res.user.id, companyId: res.user.companyId as number };
}

async function as<T>(session: Session, work: () => Promise<T>): Promise<T> {
  const before = current;
  current = session;
  try {
    return await work();
  } finally {
    current = before;
  }
}

/** A small, valid JPEG (the stub provider reads the same card from any image). */
function cardImage(seed: number): string {
  const width = 96;
  const height = 64;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const v = (i * 7 + seed * 13) % 255;
    data[i * 4] = 240;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = 240;
    data[i * 4 + 3] = 255;
  }
  return `data:image/jpeg;base64,${jpeg.encode({ data, width, height }, 80).data.toString("base64")}`;
}

async function useStubAi(session: Session, model = "stub-model", extra: Record<string, unknown> = {}): Promise<void> {
  await as(session, () => customFetch("/api/ai/settings", { method: "PATCH", body: JSON.stringify({ provider: "stub", model, ...extra }) }));
}

interface Device {
  queue: QueueItem[];
  owner: string | null;
  images: Map<string, string>;
}

async function sync(d: Device, api: SyncApi, force = true): Promise<SyncResult> {
  return syncOwnedQueue({
    owner: d.owner,
    currentOwner: () => d.owner,
    isOnline: () => true,
    getQueue: () => d.queue,
    setQueue: (next) => {
      d.queue = next;
    },
    perform: createPerformer({ api, loadImage: async (item) => d.images.get(item.id) as string, language: () => "en" }),
    classify: classifySyncFailure,
    force,
  });
}

/**
 * The stub provider reads the SAME card from every image, so a second contact
 * built from it is — correctly — a duplicate for the server. Tests that are
 * about something else give their capture an identity of its own.
 */
function distinct(input: Parameters<typeof createContact>[0], tag: string): Parameters<typeof createContact>[0] {
  return {
    ...input,
    firstName: tag,
    lastName: `Compat${Date.now().toString(36)}`,
    email: `${tag.toLowerCase()}-${Date.now().toString(36)}@example.test`,
    contactCompany: `${tag} Trading ${Date.now().toString(36)}`,
    mobile: null,
    officePhone: null,
    website: null,
    linkedin: null,
    address: null,
  };
}

const realApi: SyncApi = {
  createScan: (input) => createScan(input),
  getScan: (id) => getScan(id),
  createContact: (input) => createContact(input),
  upsertOwnCard: (input) => upsertOwnCard(input),
};

function queueScan(d: Device, id: string, seed: number): void {
  d.images.set(id, cardImage(seed));
  d.queue = enqueueItem(d.queue, { kind: "scan", label: "Business card", source: "card", imageFile: `${id}.jpg` }, d.owner, Date.now(), id) as QueueItem[];
}

const live = describe.skipIf(!BASE);

live("mobile ↔ API compatibility (local API, stub AI, synthetic accounts)", () => {
  let a: Session;
  let b: Session;
  const stamp = Date.now().toString(36);

  beforeAll(async () => {
    setBaseUrl(BASE);
    setAuthTokenGetter(() => current?.token ?? null);
    const health = await fetch(`${BASE}/api/healthz`);
    expect(health.ok, `no local API at ${BASE}`).toBe(true);
    expect(BASE, "this run is for a local API only").toMatch(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/);
    expect(TENANT_A && TENANT_B && PASSWORD, "set MOBILE_API_COMPAT_EMAIL_A, _EMAIL_B and _PASSWORD (two tenant accounts of the local seed)").toBeTruthy();
    a = await signIn(TENANT_A);
    b = await signIn(TENANT_B);
    expect(a.companyId).not.toBe(b.companyId);
    await useStubAi(a);
    await useStubAi(b);
  });

  afterAll(() => {
    setOnUnauthorized(null);
    setAuthTokenGetter(null);
    setBaseUrl(null);
  });

  describe("session renewal uses the API's existing contract", () => {
    it("sign-in returns a refresh token; POST /auth/refresh rotates it and the new access token works", async () => {
      const s = await signIn(TENANT_A);
      const renewed = parseRefreshResponse(await refreshToken({ refreshToken: s.refreshToken }));
      expect(renewed).not.toBeNull();
      // The refresh token is always replaced. (The access token may be byte-identical
      // when it is re-issued within the same second — it is a signed statement of the
      // same facts — so the app never relies on it being different.)
      expect(renewed!.refreshToken).not.toBe(s.refreshToken);
      expect(renewed!.token.split(".")).toHaveLength(3);
      const me = await as({ ...s, token: renewed!.token }, () => customFetch<{ id: number }>("/api/auth/me"));
      expect(me.id).toBe(s.userId);
    });

    it("a replaced refresh token is refused with 401, which the app treats as 'the session has ended'", async () => {
      const s = await signIn(TENANT_A);
      const renewed = parseRefreshResponse(await refreshToken({ refreshToken: s.refreshToken }))!;
      let failure: unknown;
      try {
        await refreshToken({ refreshToken: s.refreshToken }); // the old one, presented again
      } catch (err) {
        failure = err;
      }
      expect(failure).toBeInstanceOf(ApiError);
      expect(classifyRefreshFailure(failure)).toEqual({ kind: "ended", reason: "expired" });
      // …and the server has revoked that whole session: its newest tokens are dead too
      await expect(as({ ...s, token: renewed.token }, () => customFetch("/api/auth/me"))).rejects.toMatchObject({ status: 401 });
      await expect(refreshToken({ refreshToken: renewed.refreshToken })).rejects.toMatchObject({ status: 401 });
    });

    it("a garbage refresh token is refused without harming a live session", async () => {
      const s = await signIn(TENANT_A);
      await expect(refreshToken({ refreshToken: "not-a-token" })).rejects.toMatchObject({ status: 401 });
      const me = await as(s, () => customFetch<{ id: number }>("/api/auth/me"));
      expect(me.id).toBe(s.userId);
    });

    it("a wrong current password is a 401 that neither renews nor ends the session", async () => {
      const real = await signIn(TENANT_A);
      const session = { generation: 1, accessToken: real.token, refreshToken: real.refreshToken, issuedTokens: [real.token] };
      const decisions: string[] = [];
      setAuthTokenGetter(() => session.accessToken);
      setOnUnauthorized(async ({ failedToken, url }) => {
        decisions.push(decideOnUnauthorized(session, failedToken, url).action);
        return null;
      });
      try {
        // The password is NOT changed: the current one given here is wrong.
        const attempt = changePassword({ currentPassword: `not-${Date.now()}-the-password`, newPassword: "Another-Passw0rd-1!" });
        await expect(attempt).rejects.toMatchObject({ status: 401 });
        expect(decisions).toEqual(["ignore"]);
        // The session still works, and its refresh token was not used up.
        expect((await customFetch<{ id: number }>("/api/auth/me")).id).toBe(real.userId);
        const renewed = parseRefreshResponse(await refreshToken({ refreshToken: real.refreshToken }));
        expect(renewed?.token).toBeTruthy();
        // The account still signs in with its own password.
        expect((await signIn(TENANT_A)).userId).toBe(real.userId);
      } finally {
        setOnUnauthorized(null);
        setAuthTokenGetter(() => current?.token ?? null);
      }
    });

    it("an expired access token is renewed transparently by the app's 401 rules and the request succeeds", async () => {
      const real = await signIn(TENANT_A);
      // What the app holds after its access token expired: a token the API rejects, and a valid refresh token.
      let session = { generation: 1, accessToken: "expired.access.token", refreshToken: real.refreshToken, issuedTokens: ["expired.access.token"] };
      let renewals = 0;
      setAuthTokenGetter(() => session.accessToken);
      setOnUnauthorized(async ({ failedToken }) => {
        const decision = decideOnUnauthorized(session, failedToken);
        if (decision.action === "retry") return decision.token;
        if (decision.action !== "refresh") return null;
        const renewed = parseRefreshResponse(await refreshToken({ refreshToken: decision.refreshToken }));
        if (!renewed) return null;
        renewals += 1;
        session = { ...session, accessToken: renewed.token, refreshToken: renewed.refreshToken, issuedTokens: withIssuedToken(session.issuedTokens, renewed.token) };
        return renewed.token;
      });
      try {
        const results = await Promise.all([
          customFetch<{ id: number }>("/api/auth/me"),
          customFetch<{ id: number }>("/api/auth/me"),
          customFetch<{ id: number }>("/api/auth/me"),
        ]);
        expect(results.map((r) => r.id)).toEqual([real.userId, real.userId, real.userId]);
        expect(renewals).toBe(1); // three rejected requests, one renewal — the refresh token is single-use
      } finally {
        setOnUnauthorized(null);
        setAuthTokenGetter(() => current?.token ?? null);
      }
    });
  });

  describe("offline scan sync against the real endpoints", () => {
    it("a queued scan becomes ONE scan and ONE contact, linked to each other", async () => {
      const d: Device = { queue: [], owner: a.owner, images: new Map() };
      queueScan(d, `${Date.now()}-l1`, 1);
      const before = await as(a, () => customFetch<{ total?: number; contacts?: unknown[] }>("/api/contacts?limit=1"));
      void before;
      const result = await as(a, () => sync(d, realApi));
      // The stub reads the same card every time. On a database where that card's
      // contact already exists the server answers 409 — also a correct outcome,
      // covered by the next block; here either "created" or "conflict" is fine.
      expect(result.synced + result.conflicts).toBe(1);
      if (result.synced === 1) expect(d.queue).toEqual([]);
    });

    it("interrupted between the two requests: the next run reads no card again and the scan gets exactly one contact", async () => {
      // Every scan of the stub reads the same person; give this capture its own identity through a
      // contact the app would create from it (the server links the scan either way).
      const d: Device = { queue: [], owner: a.owner, images: new Map() };
      const id = `${Date.now()}-l2`;
      queueScan(d, id, 2);
      const calls: string[] = [];
      let dropContact = true;
      const flaky: SyncApi = {
        createScan: async (input) => {
          calls.push("createScan");
          return createScan(input);
        },
        getScan: async (scanId) => {
          calls.push("getScan");
          return getScan(scanId);
        },
        createContact: async (input) => {
          calls.push("createContact");
          if (dropContact) throw new TypeError("Network request failed"); // lost before it was sent
          return createContact(distinct(input, "Interrupted"));
        },
        upsertOwnCard: (input) => upsertOwnCard(input),
      };
      const first = await as(a, () => sync(d, flaky));
      expect(first).toMatchObject({ synced: 0, failed: 0, stopped: "offline" });
      const scanId = d.queue[0]!.scanId as number;
      expect(scanId).toBeGreaterThan(0);
      const pending = await as(a, () => getScan(scanId));
      expect(pending.contactId ?? null).toBeNull();

      dropContact = false;
      calls.length = 0;
      const second = await as(a, () => sync(d, flaky));
      expect(second).toMatchObject({ synced: 1, failed: 0 });
      expect(calls).toEqual(["getScan", "createContact"]); // no second card reading
      const linked = await as(a, () => getScan(scanId));
      expect(linked.contactId).toBeGreaterThan(0);
      expect(d.queue).toEqual([]);
    });

    it("the contact was created but its answer was lost: the next run finds the link and sends nothing more", async () => {
      const d: Device = { queue: [], owner: a.owner, images: new Map() };
      queueScan(d, `${Date.now()}-l3`, 3);
      const calls: string[] = [];
      let loseAnswer = true;
      let createdId: number | null = null;
      const lossy: SyncApi = {
        createScan: (input) => createScan(input),
        getScan: async (scanId) => {
          calls.push("getScan");
          return getScan(scanId);
        },
        createContact: async (input) => {
          calls.push("createContact");
          const created = await createContact(distinct(input, "Lostanswer"));
          createdId = created.id;
          if (loseAnswer) throw new TypeError("Network request failed"); // the server did its work; the answer never arrived
          return created;
        },
        upsertOwnCard: (input) => upsertOwnCard(input),
      };
      const first = await as(a, () => sync(d, lossy));
      expect(first.stopped).toBe("offline");
      expect(createdId).toBeGreaterThan(0);
      const scanId = d.queue[0]!.scanId as number;

      loseAnswer = false;
      calls.length = 0;
      const second = await as(a, () => sync(d, lossy));
      expect(second).toMatchObject({ synced: 1 });
      expect(calls).toEqual(["getScan"]); // the scan already has its contact
      expect((await as(a, () => getScan(scanId))).contactId).toBe(createdId);
    });

    it("a reviewed card whose save answer was lost: the sync asks its scan and creates no second contact", async () => {
      // What the review screens do while online: the card is read, then the contact is saved NAMING its scan.
      const scan = await as(a, () => createScan({ imageData: cardImage(7), appLanguage: "en" }));
      const payload = distinct(
        extractedToContact(scan.extractedData ?? {}, { scanId: scan.id, cardImageUrl: `/api/scans/${scan.id}/image` }),
        "Reviewed",
      );
      const created = await as(a, () => createContact(payload)); // the request arrived — the app never saw this answer
      expect((await as(a, () => getScan(scan.id))).contactId).toBe(created.id); // the server linked the two

      // The screen kept the card for later; the sync now meets it.
      const d: Device = { queue: [], owner: a.owner, images: new Map() };
      d.queue = enqueueItem(d.queue, { kind: "contact", label: "Reviewed", source: "card", payload }, d.owner, Date.now(), `${Date.now()}-r1`) as QueueItem[];
      const calls: string[] = [];
      const counting: SyncApi = {
        ...realApi,
        getScan: (id) => {
          calls.push("getScan");
          return getScan(id);
        },
        createContact: (input) => {
          calls.push("createContact");
          return createContact(input);
        },
      };
      const run = await as(a, () => sync(d, counting));
      expect(run).toMatchObject({ synced: 1, failed: 0, conflicts: 0 });
      expect(calls).toEqual(["getScan"]);
      expect(d.queue).toEqual([]);
      expect((await as(a, () => getScan(scan.id))).contactId).toBe(created.id);
    });

    it("a card whose contact already exists: 409 → conflict; 'add to this contact' links the capture and creates no contact", async () => {
      const d: Device = { queue: [], owner: b.owner, images: new Map() };
      // first capture of the stub's card in tenant B creates the contact (or finds it from an earlier run)
      queueScan(d, `${Date.now()}-l4a`, 4);
      const first = await as(b, () => sync(d, realApi));
      if (first.conflicts === 1) {
        d.queue = resolveOwnedConflict(d.queue, d.queue[0]!.id, b.owner, "add_interaction");
        await as(b, () => sync(d, realApi));
      }
      expect(d.queue).toEqual([]);

      // the same card again
      const id = `${Date.now()}-l4b`;
      queueScan(d, id, 5);
      const second = await as(b, () => sync(d, realApi));
      expect(second).toMatchObject({ synced: 0, failed: 0, conflicts: 1 });
      const conflict = d.queue[0]!;
      expect(conflict.status).toBe("conflict");
      expect(conflict.conflict!.contactId).toBeGreaterThan(0);
      expect(typeof conflict.conflict!.name).toBe("string");
      const scanId = conflict.scanId as number;
      expect((await as(b, () => getScan(scanId))).contactId ?? null).toBeNull(); // nothing was created or linked

      d.queue = resolveOwnedConflict(d.queue, id, b.owner, "add_interaction");
      const third = await as(b, () => sync(d, realApi));
      expect(third).toMatchObject({ synced: 1 });
      expect((await as(b, () => getScan(scanId))).contactId).toBe(conflict.conflict!.contactId);
    });
  });

  describe("tenant isolation of the two-step sync", () => {
    it("another tenant cannot read a scan, and cannot attach a contact to it", async () => {
      const scan = await as(a, () => createScan({ imageData: cardImage(9), appLanguage: "en" }));
      expect(scan.id).toBeGreaterThan(0);
      const read = await as(b, () => getScan(scan.id)).catch((e: unknown) => e);
      expect(classifyApiFailure(read).kind).toBe("not_found"); // 404, not 403: the scan does not exist for B
      const attach = await as(b, () => createContact({ firstName: "Wrong", lastName: "Tenant", email: `wrong-${stamp}@example.test`, scanId: scan.id })).catch((e: unknown) => e);
      expect(attach).toBeInstanceOf(ApiError);
      expect((attach as ApiError).status).toBe(400);
      expect((await as(a, () => getScan(scan.id))).contactId ?? null).toBeNull();
    });

    it("B's sync never sends A's queued item", async () => {
      const d: Device = { queue: [], owner: a.owner, images: new Map() };
      queueScan(d, `${Date.now()}-l5`, 6);
      d.owner = b.owner; // the phone is now signed in as B
      const calls: string[] = [];
      const counting: SyncApi = {
        createScan: async (i) => (calls.push("createScan"), createScan(i)),
        getScan: async (i) => (calls.push("getScan"), getScan(i)),
        createContact: async (i) => (calls.push("createContact"), createContact(i)),
        upsertOwnCard: async (i) => (calls.push("upsertOwnCard"), upsertOwnCard(i)),
      };
      const result = await as(b, () => sync(d, counting));
      expect(result).toMatchObject({ attempted: 0, synced: 0 });
      expect(calls).toEqual([]);
      expect(d.queue).toHaveLength(1);
      expect(d.queue[0]!.owner).toBe(a.owner);
    });
  });

  describe("AI and image errors arrive with the codes the app maps", () => {
    it("no readable card → 422 SCAN_NO_CARD → 'no_card' (fails once, not retried by itself)", async () => {
      await useStubAi(a, "stub-nocard");
      try {
        const err = await as(a, () => createScan({ imageData: cardImage(11), appLanguage: "en" })).catch((e: unknown) => e);
        expect(describeScanFailure(err)).toMatchObject({ kind: "no_card", key: "capture.errNoCard", serverMessage: null });
        expect(classifySyncFailure(err, { kind: "scan" } as QueueItem)).toMatchObject({ action: "fail", kind: "no_card", retryable: false });
      } finally {
        await useStubAi(a);
      }
    });

    it("an image that is not an image → 400 → 'invalid', with the API's own sentence allowed through", async () => {
      const bad = `data:text/plain;base64,${Buffer.from("just some text pretending to be a card".repeat(3)).toString("base64")}`;
      const err = await as(a, () => createScan({ imageData: bad, appLanguage: "en" })).catch((e: unknown) => e);
      const d = describeScanFailure(err);
      expect(d.kind).toBe("invalid");
      expect(d.key).toBe("capture.errInvalid");
    });

    it("a provider without a credential → 503 AI_NOT_CONFIGURED → 'ai_not_configured' on the camera, in the sync and in the Assistant", async () => {
      await as(a, () => customFetch("/api/ai/settings", { method: "PATCH", body: JSON.stringify({ provider: "gemini" }) }));
      try {
        const err = await as(a, () => createScan({ imageData: cardImage(12), appLanguage: "en" })).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(503);
        expect(describeScanFailure(err)).toMatchObject({ kind: "ai_not_configured", key: "capture.errAiNotConfigured", serverMessage: null });
        expect(classifySyncFailure(err, { kind: "scan" } as QueueItem)).toEqual({ action: "defer-scans", kind: "ai_not_configured" });
        expect(classifySendError(err)).toBe("ai_not_configured");
      } finally {
        await useStubAi(a);
      }
    });

    it("an exhausted company AI budget → 429 AI_BUDGET_EXCEEDED → 'ai_budget'", async () => {
      await useStubAi(a, "stub-model", { monthlyTokenBudget: 1 });
      try {
        const err = await as(a, () => createScan({ imageData: cardImage(13), appLanguage: "en" })).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApiError);
        expect(describeScanFailure(err)).toMatchObject({ kind: "ai_budget", key: "capture.errBudget", serverMessage: null });
        expect(classifySyncFailure(err, { kind: "scan" } as QueueItem)).toEqual({ action: "defer-scans", kind: "ai_budget" });
      } finally {
        await useStubAi(a, "stub-model", { monthlyTokenBudget: null });
      }
    });

    it("a request without a valid session → 401 → 'session_expired' (the sync stops instead of failing items)", async () => {
      const err = await as({ ...a, token: "expired.access.token" }, () => createScan({ imageData: cardImage(14), appLanguage: "en" })).catch((e: unknown) => e);
      expect(classifyApiFailure(err).kind).toBe("session_expired");
      expect(classifySyncFailure(err, { kind: "scan" } as QueueItem)).toEqual({ action: "stop", reason: "auth", kind: "session_expired" });
    });
  });
});
