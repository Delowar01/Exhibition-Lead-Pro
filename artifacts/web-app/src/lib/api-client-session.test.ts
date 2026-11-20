// The shared API client (lib/api-client-react custom-fetch) as the WEB PORTAL
// uses it. Phase 2 Batch 1 changed that client for the mobile app (the 401
// handler now receives the rejected token and the request address; handler
// runs are queued; a retry carries the token the handler returned). This suite
// pins what the portal relies on, so those changes cannot alter it:
//
//   • the portal's handler takes no arguments — it must keep working unchanged;
//   • concurrent 401s share ONE refresh (a refresh token is single-use);
//   • the retry is sent once, with the token the handler just stored;
//   • a refused refresh signs the user out and the request fails with its 401;
//   • sign-in endpoints never trigger a refresh;
//   • 403 FEATURE_NOT_ENTITLED notifies the entitlement observer and nothing else.
//
// The handler below is a line-for-line replica of the one in src/App.tsx, with
// localStorage and the refresh endpoint replaced by in-memory stand-ins. Every
// scenario here was also run against the client as it was BEFORE the change
// (commit cd08c73): the outcomes are identical; the one difference is noted at
// the scenario concerned.
import { afterEach, describe, expect, it, vi } from "vitest";

type Client = typeof import("@workspace/api-client-react");

interface World {
  store: Map<string, string>;
  validAccess: Set<string>;
  validRefresh: Set<string>;
  usedRefresh: Set<string>;
  refreshCalls: number;
  logouts: number;
  denied: number;
  sent: string[];
  revoked: boolean;
  alwaysReject: boolean;
  storeFails: boolean;
  seq: number;
  refreshDelay: () => Promise<void>;
  logout: () => void;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function setup(): Promise<{ w: World; client: Client }> {
  vi.resetModules(); // a fresh client per scenario: no refresh left over from another one
  const client = (await import("@workspace/api-client-react")) as Client;
  const w: World = {
    store: new Map([
      ["csp_token", "T1"],
      ["csp_refresh_token", "R1"],
    ]),
    validAccess: new Set(),
    validRefresh: new Set(["R1"]),
    usedRefresh: new Set(),
    refreshCalls: 0,
    logouts: 0,
    denied: 0,
    sent: [],
    revoked: false,
    alwaysReject: false,
    storeFails: false,
    seq: 1,
    refreshDelay: async () => {},
    logout: () => {},
  };
  w.logout = () => {
    w.logouts += 1;
    w.store.delete("csp_token");
    w.store.delete("csp_refresh_token");
  };

  // The API: access tokens, single-use refresh tokens, reuse detection that revokes the session.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization");
      if (url.endsWith("/api/auth/refresh")) {
        w.refreshCalls += 1;
        const { refreshToken } = JSON.parse(String(init?.body ?? "{}")) as { refreshToken?: string };
        await w.refreshDelay();
        if (w.revoked) return json(401, { error: "Session revoked" });
        if (refreshToken && w.usedRefresh.has(refreshToken)) {
          w.revoked = true;
          return json(401, { error: "Refresh token reuse detected" });
        }
        if (!refreshToken || !w.validRefresh.has(refreshToken)) return json(401, { error: "Invalid refresh token" });
        w.validRefresh.delete(refreshToken);
        w.usedRefresh.add(refreshToken);
        w.seq += 1;
        w.validAccess.add(`T${w.seq}`);
        w.validRefresh.add(`R${w.seq}`);
        return json(200, { token: `T${w.seq}`, refreshToken: `R${w.seq}` });
      }
      w.sent.push(`${url} ${auth ?? "-"}`);
      if (url.endsWith("/api/feature")) return json(403, { code: "FEATURE_NOT_ENTITLED", error: "Not in plan" });
      if (url.endsWith("/api/forbidden")) return json(403, { error: "Forbidden" });
      if (url.endsWith("/api/auth/login")) return json(401, { error: "Invalid credentials" });
      const token = auth?.replace(/^Bearer /, "");
      if (w.revoked || w.alwaysReject || !token || !w.validAccess.has(token)) return json(401, { error: "Invalid or expired token" });
      return json(200, { ok: true, as: token });
    }),
  );

  // src/App.tsx: setAuthTokenGetter(() => localStorage.getItem("csp_token"))
  client.setAuthTokenGetter(() => w.store.get("csp_token") ?? null);
  // src/App.tsx, Router(): the refresh-on-401 handler. It takes NO arguments.
  client.setOnUnauthorized(async () => {
    const refreshToken = w.store.get("csp_refresh_token");
    if (!refreshToken) {
      w.logout();
      return null;
    }
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) throw new Error("refresh failed");
      const data = (await res.json()) as { token: string; refreshToken?: string };
      if (w.storeFails) throw new Error("QuotaExceededError");
      w.store.set("csp_token", data.token);
      if (data.refreshToken) w.store.set("csp_refresh_token", data.refreshToken);
      return data.token;
    } catch {
      w.logout();
      return null;
    }
  });
  // src/contexts/AuthContext.tsx: setOnFeatureDenied(() => refreshUser("feature-denied"))
  client.setOnFeatureDenied(() => {
    w.denied += 1;
  });
  return { w, client };
}

const outcome = (p: Promise<unknown>): Promise<string> =>
  p.then(
    (v) => `ok:${(v as { as?: string }).as}`,
    (e: { status?: number; name?: string }) => `err:${e.status ?? e.name}`,
  );
const tick = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web portal: the 401 → refresh → retry contract", () => {
  it("an expired access token is renewed once and the request is repeated with the new token", async () => {
    const { w, client } = await setup();
    expect(await outcome(client.customFetch("/api/a"))).toBe("ok:T2");
    expect(w).toMatchObject({ refreshCalls: 1, logouts: 0 });
    expect(w.sent).toEqual(["/api/a Bearer T1", "/api/a Bearer T2"]);
    expect(w.store.get("csp_token")).toBe("T2"); // the retry carried exactly what the handler stored
  });

  it("five requests rejected at once share ONE refresh", async () => {
    const { w, client } = await setup();
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => outcome(client.customFetch(`/api/c${i}`))));
    expect(results).toEqual(["ok:T2", "ok:T2", "ok:T2", "ok:T2", "ok:T2"]);
    expect(w.refreshCalls).toBe(1);
    expect(w.sent.filter((s) => s.endsWith("Bearer T1"))).toHaveLength(5);
    expect(w.sent.filter((s) => s.endsWith("Bearer T2"))).toHaveLength(5);
    expect(w.logouts).toBe(0);
  });

  it("a refused refresh signs out once and every waiting request fails with its own 401", async () => {
    const { w, client } = await setup();
    w.validRefresh.clear();
    const results = await Promise.all([1, 2].map((i) => outcome(client.customFetch(`/api/r${i}`))));
    expect(results).toEqual(["err:401", "err:401"]);
    expect(w).toMatchObject({ refreshCalls: 1, logouts: 1 });
    expect(w.sent).toHaveLength(2); // nothing was repeated
  });

  it("the repeat is attempted once only", async () => {
    const { w, client } = await setup();
    w.alwaysReject = true;
    expect(await outcome(client.customFetch("/api/x"))).toBe("err:401");
    expect(w.refreshCalls).toBe(1);
    expect(w.sent).toEqual(["/api/x Bearer T1", "/api/x Bearer T2"]);
  });

  it("no refresh token stored: sign-out, no refresh request", async () => {
    const { w, client } = await setup();
    w.store.delete("csp_refresh_token");
    expect(await outcome(client.customFetch("/api/a"))).toBe("err:401");
    expect(w).toMatchObject({ refreshCalls: 0, logouts: 1 });
  });

  it("a failed sign-in is never treated as an expired session", async () => {
    const { w, client } = await setup();
    expect(await outcome(client.customFetch("/api/auth/login", { method: "POST", body: "{}" }))).toBe("err:401");
    expect(w).toMatchObject({ refreshCalls: 0, logouts: 0 });
  });

  it("the renewed token cannot be stored: sign-out, and the request fails with its 401", async () => {
    const { w, client } = await setup();
    w.storeFails = true;
    expect(await outcome(client.customFetch("/api/a"))).toBe("err:401");
    expect(w).toMatchObject({ refreshCalls: 1, logouts: 1 });
    expect(w.store.has("csp_token")).toBe(false);
    expect(w.sent).toEqual(["/api/a Bearer T1"]);
  });

  it("a handler that throws leaves the caller with the request's own 401", async () => {
    const { w, client } = await setup();
    client.setOnUnauthorized(async () => {
      throw new Error("storage is not available");
    });
    const err = await client.customFetch("/api/a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(client.ApiError);
    expect((err as { status: number }).status).toBe(401);
    expect(w.sent).toHaveLength(1);
  });
});

describe("web portal: session changes while a refresh is under way", () => {
  it("sign-out during the refresh: the handler alone decides what is stored — the client adds nothing", async () => {
    const { w, client } = await setup();
    let release: () => void = () => {};
    w.refreshDelay = () => new Promise<void>((r) => (release = r));
    const pending = outcome(client.customFetch("/api/a"));
    await tick();
    w.logout();
    release();
    // Unchanged from before the change: the portal's handler stores the renewed tokens when its refresh returns.
    expect(await pending).toBe("ok:T2");
    expect(w.sent).toEqual(["/api/a Bearer T1", "/api/a Bearer T2"]);
    expect(w.refreshCalls).toBe(1);
  });

  it("another account signs in during the refresh: the repeat carries what the handler returned, as before", async () => {
    const { w, client } = await setup();
    let release: () => void = () => {};
    w.refreshDelay = () => new Promise<void>((r) => (release = r));
    const pending = outcome(client.customFetch("/api/a"));
    await tick();
    w.validAccess.add("TB");
    w.validRefresh.add("RB");
    w.store.set("csp_token", "TB");
    w.store.set("csp_refresh_token", "RB");
    release();
    expect(await pending).toBe("ok:T2");
    expect(w.sent).toEqual(["/api/a Bearer T1", "/api/a Bearer T2"]);
  });

  it("a request rejected after the session was already renewed (stale): renewed again and repeated, as before", async () => {
    const { w, client } = await setup();
    expect(await outcome(client.customFetch("/api/a"))).toBe("ok:T2");
    w.validAccess.delete("T2"); // …and that token expires too
    expect(await outcome(client.customFetch("/api/b"))).toBe("ok:T3");
    expect(w).toMatchObject({ refreshCalls: 2, logouts: 0 });
  });
});

describe("web portal: requests that are not the session's", () => {
  it("a request with its own Authorization header keeps that header on the repeat (it is never replaced by the session's token)", async () => {
    const { w, client } = await setup();
    expect(await outcome(client.customFetch("/api/b", { headers: { authorization: "Bearer OTHER" } }))).toBe("err:401");
    expect(w.sent).toEqual(["/api/b Bearer OTHER", "/api/b Bearer OTHER"]);
  });

  it("two requests rejected at once with DIFFERENT tokens never refresh at the same moment (no refresh-token reuse, no sign-out)", async () => {
    const { w, client } = await setup();
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => (open = r));
    w.refreshDelay = () => gate;
    const a = outcome(client.customFetch("/api/a"));
    const b = outcome(client.customFetch("/api/b", { headers: { authorization: "Bearer T0" } }));
    await tick();
    expect(w.refreshCalls).toBe(1); // the second handler run waits for the first
    open();
    expect([(await a).slice(0, 3), await b]).toEqual(["ok:", "err:401"]);
    expect(w).toMatchObject({ logouts: 0, revoked: false });
    // The one difference to the client before the change: it shared a single refresh here;
    // now each rejected token gets its own handler run, one after the other (2 refreshes, both valid).
    expect(w.refreshCalls).toBe(2);
  });

  it("a request its caller cancelled is not repeated when its 401 arrives late, and starts no refresh", async () => {
    const { w, client } = await setup();
    let release: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        w.sent.push(String(input));
        return new Promise<Response>((r) => (release = r));
      }),
    );
    const controller = new AbortController();
    const pending = outcome(client.customFetch("/api/a", { signal: controller.signal }));
    await tick();
    controller.abort();
    release(json(401, { error: "Invalid or expired token" }));
    expect(await pending).toBe("err:401");
    expect(w.sent).toEqual(["/api/a"]);
    expect(w).toMatchObject({ refreshCalls: 0, logouts: 0 });
  });
});

describe("web portal: 403 handling", () => {
  it("FEATURE_NOT_ENTITLED notifies the entitlement observer; no refresh, no sign-out, the 403 reaches the caller", async () => {
    const { w, client } = await setup();
    const err = await client.customFetch("/api/feature").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(client.ApiError);
    expect(err).toMatchObject({ status: 403, data: { code: "FEATURE_NOT_ENTITLED" } });
    expect(w).toMatchObject({ denied: 1, refreshCalls: 0, logouts: 0 });
    expect(w.sent).toHaveLength(1);
  });

  it("any other 403 notifies nobody", async () => {
    const { w, client } = await setup();
    expect(await outcome(client.customFetch("/api/forbidden"))).toBe("err:403");
    expect(w).toMatchObject({ denied: 0, refreshCalls: 0, logouts: 0 });
  });

  it("an observer that throws never replaces the 403", async () => {
    const { w, client } = await setup();
    client.setOnFeatureDenied(() => {
      throw new Error("observer failed");
    });
    const err = await client.customFetch("/api/feature").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 403 });
    expect(w.logouts).toBe(0);
  });
});
