// Phase 2 Batch 1 — the REAL token storage (lib/auth-storage.ts), run against
// an in-memory secure store that can fail: what happens to a renewed session's
// tokens when storing them fails, when the user signs out while they are being
// stored, and when another account has signed in meanwhile. (The session
// provider relies on exactly these guards when it takes a renewal answer into
// use — see contexts/AuthContext.tsx `adopt`.)
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@workspace/api-client-react";

const secure = vi.hoisted(() => ({
  data: new Map<string, string>(),
  failSet: new Set<string>(),
  /** Runs at the start of the next write (to model something happening while a write is under way). */
  duringNextSet: null as null | (() => Promise<void> | void),
  writes: [] as string[],
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("./secure-prefs", () => ({
  getSecureItem: async (key: string) => secure.data.get(key) ?? null,
  setSecureItem: async (key: string, value: string) => {
    const hook = secure.duringNextSet;
    secure.duringNextSet = null;
    if (hook) await hook();
    if (secure.failSet.has(key)) throw new Error("secure store unavailable");
    secure.data.set(key, value);
    secure.writes.push(key);
  },
  deleteSecureItem: async (key: string) => {
    secure.data.delete(key);
  },
}));

const USER_A = { id: 11, companyId: 1, email: "a@example.test", name: "A" } as unknown as User;
const USER_B = { id: 22, companyId: 2, email: "b@example.test", name: "B" } as unknown as User;

async function fresh() {
  vi.resetModules();
  return import("./auth-storage");
}

beforeEach(() => {
  secure.data.clear();
  secure.failSet.clear();
  secure.duringNextSet = null;
  secure.writes.length = 0;
});

describe("storing the tokens of a renewed session", () => {
  it("normal case: both tokens replaced, in memory and in the secure store", async () => {
    const auth = await fresh();
    await auth.saveSession("T1", USER_A, "R1");
    expect(await auth.saveRotatedTokens("T1", { token: "T2", refreshToken: "R2" })).toBe(true);
    expect(auth.getCachedToken()).toBe("T2");
    expect(auth.getCachedRefreshToken()).toBe("R2");
    expect(secure.data.get("csp_token")).toBe("T2");
    expect(secure.data.get("csp_refresh")).toBe("R2");
    // and they survive a restart
    const next = await fresh();
    expect(await next.loadSession()).toMatchObject({ token: "T2", refreshToken: "R2" });
  });

  it("the secure store refuses the write: the session goes on with the new tokens for this run", async () => {
    const auth = await fresh();
    await auth.saveSession("T1", USER_A, "R1");
    secure.failSet.add("csp_token");
    secure.failSet.add("csp_refresh");
    expect(await auth.saveRotatedTokens("T1", { token: "T2", refreshToken: "R2" })).toBe(true);
    expect(auth.getCachedToken()).toBe("T2"); // requests use the token the server now expects
    expect(auth.getCachedRefreshToken()).toBe("R2"); // and the next renewal presents the token the server now expects
    expect(secure.data.get("csp_refresh")).toBe("R1"); // stale on disk: after a restart the server refuses it and the user signs in again
  });

  it("the answer belongs to a session that is no longer the one in use: nothing is stored (signed out / another account / renewed meanwhile)", async () => {
    const auth = await fresh();
    await auth.saveSession("T1", USER_A, "R1");
    await auth.clearSession(); // signed out
    expect(await auth.saveRotatedTokens("T1", { token: "T2", refreshToken: "R2" })).toBe(false);
    expect(auth.getCachedToken()).toBeNull();
    expect(secure.data.has("csp_token")).toBe(false);

    await auth.saveSession("TB", USER_B, "RB"); // another account
    expect(await auth.saveRotatedTokens("T1", { token: "T2", refreshToken: "R2" })).toBe(false);
    expect(auth.getCachedToken()).toBe("TB");
    expect(secure.data.get("csp_token")).toBe("TB");
    expect(secure.data.get("csp_refresh")).toBe("RB");

    expect(await auth.saveRotatedTokens("TB", { token: "TB2", refreshToken: "RB2" })).toBe(true); // B's own renewal
    expect(await auth.saveRotatedTokens("TB", { token: "TB3", refreshToken: "RB3" })).toBe(false); // an answer for the token before that
    expect(auth.getCachedToken()).toBe("TB2");
  });

  it("the user signs out WHILE the renewed tokens are being stored: the signed-out state wins and nothing is left behind", async () => {
    const auth = await fresh();
    await auth.saveSession("T1", USER_A, "R1");
    secure.duringNextSet = () => auth.clearSession();
    expect(await auth.saveRotatedTokens("T1", { token: "T2", refreshToken: "R2" })).toBe(false);
    expect(auth.getCachedToken()).toBeNull();
    expect(auth.getCachedRefreshToken()).toBeNull();
    expect(secure.data.has("csp_token")).toBe(false);
    expect(secure.data.has("csp_refresh")).toBe(false);
  });

  it("another account signs in WHILE they are being stored: that account's tokens are what remains", async () => {
    const auth = await fresh();
    await auth.saveSession("T1", USER_A, "R1");
    secure.duringNextSet = () => auth.saveSession("TB", USER_B, "RB");
    expect(await auth.saveRotatedTokens("T1", { token: "T2", refreshToken: "R2" })).toBe(false);
    expect(auth.getCachedToken()).toBe("TB");
    expect(auth.getCachedRefreshToken()).toBe("RB");
    expect(secure.data.get("csp_token")).toBe("TB");
    expect(secure.data.get("csp_refresh")).toBe("RB");
  });

  it("a profile edit (the user row only) never touches the tokens, and never revives a signed-out session", async () => {
    const auth = await fresh();
    await auth.saveSession("T1", USER_A, "R1");
    await auth.saveSessionUser("T1", { ...USER_A, name: "A renamed" } as User);
    expect(JSON.parse(secure.data.get("csp_user") as string)).toMatchObject({ name: "A renamed" });
    expect(secure.data.get("csp_refresh")).toBe("R1");
    await auth.clearSession();
    await auth.saveSessionUser("T1", USER_A);
    expect(secure.data.has("csp_user")).toBe(false);
    expect(secure.data.has("csp_token")).toBe(false);
  });

  it("a refresh token is never restored without the session it belongs to", async () => {
    secure.data.set("csp_refresh", "R-orphan");
    const auth = await fresh();
    expect(await auth.loadSession()).toMatchObject({ token: null, refreshToken: null });
    expect(auth.getCachedRefreshToken()).toBeNull();
  });
});
