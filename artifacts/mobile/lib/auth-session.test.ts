// Phase 2 Batch 1 — session renewal and session end.
//   • the pure rules (lib/auth-session-model.ts);
//   • the shared API client's 401 hook (lib/api-client-react custom-fetch),
//     exercised for real with a stubbed `fetch`: which token a rejected request
//     reports, which token its retry carries, and that a request of another
//     session is never retried under the current one;
//   • the remembered biometric sign-in following a renewed session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, customFetch, setAuthTokenGetter, setOnUnauthorized } from "@workspace/api-client-react";

import ar from "./i18n/locales/ar.json";
import en from "./i18n/locales/en.json";
import {
  ENDED_OWNER_GRACE_MS,
  classifyRefreshFailure,
  decideOnUnauthorized,
  endedOwnerWithinGrace,
  parseRefreshResponse,
  sessionEndNoticeKey,
  withIssuedToken,
  type SessionSnapshot,
} from "./auth-session-model";
import { biometricSignInTarget, parseStoredVault, vaultFollowsSession } from "./biometric-account-model";

const session = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  generation: 3,
  accessToken: "access-2",
  refreshToken: "refresh-2",
  issuedTokens: ["access-1", "access-2"],
  ...over,
});

describe("what happens to a request that came back 401", () => {
  it("the current token was rejected → renew with the refresh token", () => {
    expect(decideOnUnauthorized(session(), "access-2")).toEqual({ action: "refresh", refreshToken: "refresh-2" });
  });

  it("an older token of the SAME session was rejected → the session was renewed meanwhile: retry with the current token, renew nothing", () => {
    expect(decideOnUnauthorized(session(), "access-1")).toEqual({ action: "retry", token: "access-2" });
  });

  it("a token of ANOTHER session (sent before a sign-out / before another account signed in) → never retried, nothing changed", () => {
    expect(decideOnUnauthorized(session(), "token-of-the-previous-account")).toEqual({ action: "ignore" });
  });

  it("signed out, or a request sent without a session → nothing to renew and nobody to sign out", () => {
    expect(decideOnUnauthorized(session({ accessToken: null, refreshToken: null }), "access-2")).toEqual({ action: "ignore" });
    expect(decideOnUnauthorized(session(), null)).toEqual({ action: "ignore" });
  });

  it("no refresh token (a session restored from an older version) → the session has ended", () => {
    expect(decideOnUnauthorized(session({ refreshToken: null }), "access-2")).toEqual({ action: "end", reason: "expired" });
  });
});

describe("only a definite refusal ends the session", () => {
  it("401 / 403 on the renewal itself end it", () => {
    expect(classifyRefreshFailure({ status: 401, data: { error: "Session expired" } })).toEqual({ kind: "ended", reason: "expired" });
    expect(classifyRefreshFailure({ status: 401, data: { error: "Refresh token reuse detected" } })).toEqual({ kind: "ended", reason: "expired" });
    expect(classifyRefreshFailure({ status: 403, data: { error: "Subscription expired" } })).toEqual({ kind: "ended", reason: "blocked" });
  });

  it("no connection, a timeout, a server error or a rate limit do NOT sign the user out", () => {
    for (const err of [new TypeError("Network request failed"), new Error("timeout"), { status: 500 }, { status: 502 }, { status: 503 }, { status: 429 }, undefined, null]) {
      expect(classifyRefreshFailure(err)).toEqual({ kind: "transient" });
    }
  });

  it("a renewal answer counts only with both tokens", () => {
    expect(parseRefreshResponse({ token: "a", refreshToken: "r" })).toEqual({ token: "a", refreshToken: "r" });
    for (const bad of [null, "html", {}, { token: "a" }, { refreshToken: "r" }, { token: "", refreshToken: "r" }, { token: 1, refreshToken: "r" }]) {
      expect(parseRefreshResponse(bad)).toBeNull();
    }
  });

  it("the tokens a session carried are remembered, newest last, without growing forever", () => {
    expect(withIssuedToken(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(withIssuedToken(["a", "b"], "a")).toEqual(["b", "a"]);
    let issued: string[] = [];
    for (let i = 0; i < 30; i += 1) issued = withIssuedToken(issued, `t${i}`);
    expect(issued).toHaveLength(8);
    expect(issued[7]).toBe("t29");
  });
});

describe("after a session ended by itself", () => {
  it("the sign-in screen has a sentence for each reason, in both languages, and it says the captures are kept", () => {
    for (const reason of ["expired", "blocked"] as const) {
      const [section, leaf] = sessionEndNoticeKey(reason).split(".") as [string, string];
      const enText = (en as unknown as Record<string, Record<string, string>>)[section]![leaf]!;
      const arText = (ar as unknown as Record<string, Record<string, string>>)[section]![leaf]!;
      expect(enText).toMatch(/kept/);
      expect(arText.length).toBeGreaterThan(20);
    }
  });

  it("a capture under way may be kept for that account for a short while — never longer, never backwards in time", () => {
    const ended = { owner: "11@1", at: 1_000_000 };
    expect(endedOwnerWithinGrace(ended, 1_000_000)).toBe("11@1");
    expect(endedOwnerWithinGrace(ended, 1_000_000 + ENDED_OWNER_GRACE_MS)).toBe("11@1");
    expect(endedOwnerWithinGrace(ended, 1_000_000 + ENDED_OWNER_GRACE_MS + 1)).toBeNull();
    expect(endedOwnerWithinGrace(ended, 999_999)).toBeNull();
    expect(endedOwnerWithinGrace(null, 1_000_000)).toBeNull(); // an explicit sign-out leaves no grace
  });
});

describe("the API client's 401 hook (real customFetch, stubbed fetch)", () => {
  const realFetch = globalThis.fetch;
  let currentToken: string | null;
  let requests: Array<{ url: string; authorization: string | null }>;
  /** token → HTTP status the fake server answers with */
  let accepts: (token: string | null) => boolean;

  beforeEach(() => {
    currentToken = "access-1";
    requests = [];
    accepts = (token) => token === "access-2";
    setAuthTokenGetter(() => currentToken);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      requests.push({ url, authorization });
      const token = authorization ? authorization.replace(/^Bearer /, "") : null;
      const ok = accepts(token);
      return new Response(JSON.stringify(ok ? { ok: true, as: token } : { error: "Invalid or expired token" }), {
        status: ok ? 200 : 401,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setOnUnauthorized(null);
    setAuthTokenGetter(null);
  });

  it("tells the handler which token was rejected and retries with exactly the token the handler returns", async () => {
    const seen: Array<string | null> = [];
    setOnUnauthorized(async ({ failedToken }) => {
      seen.push(failedToken);
      currentToken = "access-2"; // the session was renewed
      return "access-2";
    });
    const result = await customFetch<{ ok: boolean; as: string }>("https://api.example.test/api/contacts");
    expect(result).toEqual({ ok: true, as: "access-2" });
    expect(seen).toEqual(["access-1"]);
    expect(requests.map((r) => r.authorization)).toEqual(["Bearer access-1", "Bearer access-2"]);
  });

  it("a request sent under account A is NOT retried under account B, although B's token is the current one by then", async () => {
    // A's request is under way …
    currentToken = "token-of-A";
    const snapshotOfB: SessionSnapshot = { generation: 2, accessToken: "token-of-B", refreshToken: "refresh-of-B", issuedTokens: ["token-of-B"] };
    accepts = (token) => token === "token-of-B"; // … the server rejects A's token; B's would be accepted
    let renewals = 0;
    setOnUnauthorized(async ({ failedToken }) => {
      // … and by the time the 401 arrives, B is signed in (the app's handler, in short)
      const decision = decideOnUnauthorized(snapshotOfB, failedToken);
      if (decision.action === "refresh") renewals += 1;
      return decision.action === "retry" ? decision.token : null;
    });
    const pending = customFetch("https://api.example.test/api/scans", { method: "POST", body: JSON.stringify({ imageData: "A's card" }) });
    currentToken = "token-of-B";
    await expect(pending).rejects.toBeInstanceOf(ApiError);
    expect(requests).toHaveLength(1); // no second request: A's scan never reached B's tenant
    expect(requests[0]!.authorization).toBe("Bearer token-of-A");
    expect(renewals).toBe(0); // and B's session was not touched
  });

  it("concurrent rejections of one session share ONE renewal (a refresh token is single-use)", async () => {
    let renewals = 0;
    setOnUnauthorized(async () => {
      renewals += 1;
      await new Promise((r) => setTimeout(r, 5));
      currentToken = "access-2";
      return "access-2";
    });
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => customFetch<{ as: string }>(`https://api.example.test/api/contacts/${n}`)));
    expect(renewals).toBe(1);
    expect(results.every((r) => r.as === "access-2")).toBe(true);
    expect(requests.filter((r) => r.authorization === "Bearer access-2")).toHaveLength(5);
  });

  it("a rejection with a different token does not borrow another token's renewal", async () => {
    const seen: Array<string | null> = [];
    setOnUnauthorized(async ({ failedToken }) => {
      seen.push(failedToken);
      await new Promise((r) => setTimeout(r, 5));
      return failedToken === "access-1" ? "access-2" : null;
    });
    const mine = customFetch<{ as: string }>("https://api.example.test/api/a");
    const foreign = customFetch("https://api.example.test/api/b", { headers: { authorization: "Bearer someone-else" } });
    await expect(foreign).rejects.toBeInstanceOf(ApiError);
    expect((await mine).as).toBe("access-2");
    expect(seen.sort()).toEqual(["access-1", "someone-else"]);
  });

  it("when the handler declines, the caller gets the 401 — once, without a retry loop", async () => {
    setOnUnauthorized(async () => null);
    await expect(customFetch("https://api.example.test/api/contacts")).rejects.toMatchObject({ status: 401 });
    expect(requests).toHaveLength(1);
  });

  it("a retry that is rejected again is not renewed a second time", async () => {
    let calls = 0;
    accepts = () => false;
    setOnUnauthorized(async () => {
      calls += 1;
      return "access-2";
    });
    await expect(customFetch("https://api.example.test/api/contacts")).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
    expect(requests).toHaveLength(2);
  });

  it("a handler that throws means 'no retry', not a different error", async () => {
    setOnUnauthorized(async () => {
      throw new Error("storage exploded");
    });
    await expect(customFetch("https://api.example.test/api/contacts")).rejects.toBeInstanceOf(ApiError);
  });

  it("sign-in, MFA and the renewal endpoint themselves never trigger a renewal", async () => {
    const handler = vi.fn(async () => "access-2");
    setOnUnauthorized(handler);
    for (const path of ["/api/auth/login", "/api/auth/refresh", "/api/auth/mfa/verify-login"]) {
      await expect(customFetch(`https://api.example.test${path}`, { method: "POST", body: "{}" })).rejects.toMatchObject({ status: 401 });
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("the remembered biometric sign-in follows its session", () => {
  const user = { id: 11, companyId: 1, email: "a@example.test" };
  const vaultOf = (v: Record<string, unknown>) => parseStoredVault(JSON.stringify(v));

  it("a vault written with a refresh token signs in with it; an older vault still works without", () => {
    const withRefresh = vaultOf({ token: "access-1", user, refreshToken: "refresh-1" });
    expect(biometricSignInTarget(withRefresh, { owner: "11@1", emailHint: "a***@example.test" })).toEqual({
      kind: "login",
      owner: "11@1",
      token: "access-1",
      user,
      refreshToken: "refresh-1",
    });
    const legacy = vaultOf({ token: "access-1", user });
    expect(biometricSignInTarget(legacy, { owner: "11@1", emailHint: "a***@example.test" })).toEqual({ kind: "login", owner: "11@1", token: "access-1", user });
    expect(vaultOf({ token: "access-1", user, refreshToken: 42 })).toEqual(legacy); // a malformed value is ignored, not trusted
  });

  it("it follows the session whose tokens it holds — by access token or by refresh token — and no other", () => {
    const vault = vaultOf({ token: "access-1", user, refreshToken: "refresh-1" });
    expect(vaultFollowsSession(vault, { token: "access-1", refreshToken: "refresh-1" })).toBe(true);
    expect(vaultFollowsSession(vault, { token: "access-9", refreshToken: "refresh-1" })).toBe(true);
    expect(vaultFollowsSession(vault, { token: "access-1", refreshToken: null })).toBe(true);
    expect(vaultFollowsSession(vault, { token: "access-9", refreshToken: "refresh-9" })).toBe(false); // another sign-in of the same account
    expect(vaultFollowsSession(vault, { token: null, refreshToken: null })).toBe(false);
    expect(vaultFollowsSession(vaultOf({ token: "access-1", user }), { token: "access-9", refreshToken: null })).toBe(false);
    expect(vaultFollowsSession({ present: false }, { token: "access-1", refreshToken: "refresh-1" })).toBe(false);
    expect(vaultFollowsSession(parseStoredVault("garbage"), { token: "access-1", refreshToken: "refresh-1" })).toBe(false);
  });
});
