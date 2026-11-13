import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ENTITLEMENT_REFRESH_THROTTLE_MS,
  ENTITLEMENT_REFRESH_TIMEOUT_MS,
  createEntitlementRefresher,
  shouldApplyRefresh,
  userChanged,
  type SessionIdentity,
} from "./entitlement-refresh";
import { featureAllowed, featureEnforcementOf, type FeatureKey } from "./entitlements";

// M5 — client entitlement refresh. The cached user (and its plan entitlements)
// is re-read from GET /auth/me; this suite pins the decision logic the auth
// context delegates to: throttle, de-duplication, the identity guard, and the
// rule that a refresh can only ever REPLACE the cached user — it has no way to
// end a session, whatever the server or the network does.
const FEATURES: FeatureKey[] = [
  "ai.assistant",
  "ai.command_center",
  "workflow.intelligence",
  "executive.intelligence",
  "exports.scheduled",
  "nfc.capture",
  "documents",
  "api.access",
];
const ALL_ALLOWED: Record<string, boolean> = Object.fromEntries(FEATURES.map((k) => [k, true]));

type Enforcement = "legacy" | "enforced" | "invalid";
interface TestUser {
  id: number;
  companyId: number | null;
  name: string;
  entitlements: {
    planVersionId: number | null;
    featureEnforcement: Enforcement;
    features: Record<string, boolean>;
    trialPolicy: { endOutcome: "blocked"; readOnlyGraceDays: number; graceEndsAt: null };
  } | null;
}

function user(overrides: Partial<TestUser> = {}, features: Record<string, boolean> = ALL_ALLOWED, featureEnforcement: Enforcement = "enforced"): TestUser {
  return {
    id: 7,
    companyId: 3,
    name: "Field Rep",
    entitlements: {
      planVersionId: 12,
      featureEnforcement,
      features: { ...features },
      trialPolicy: { endOutcome: "blocked", readOnlyGraceDays: 0, graceEndsAt: null },
    },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The session exactly as the auth context holds it (user + token + a generation
 * bumped on every sign-in / sign-out), a controllable clock and a scripted
 * GET /auth/me. `applyUser` is the ONLY write the refresher is given.
 */
function device(initial: TestUser | null = user()) {
  const session = { user: initial, token: initial ? "session-token-1" : null, generation: 0 };
  let clock = 1_700_000_000_000;
  let answer: (signal: AbortSignal) => Promise<TestUser> = () => Promise.resolve(user());
  const fetchUser = vi.fn((signal: AbortSignal) => answer(signal));
  const applyUser = vi.fn((fresh: TestUser) => {
    session.user = fresh;
  });
  const identity = (): SessionIdentity | null =>
    session.user && session.token ? { userId: session.user.id, companyId: session.user.companyId, generation: session.generation } : null;
  const refresher = createEntitlementRefresher<TestUser>({
    getIdentity: identity,
    getUser: () => session.user,
    fetchUser,
    applyUser,
    now: () => clock,
  });
  return {
    session,
    refresher,
    fetchUser,
    applyUser,
    advance: (ms: number) => {
      clock += ms;
    },
    serverAnswers: (next: TestUser) => {
      answer = () => Promise.resolve(next);
    },
    serverFails: (error: unknown) => {
      answer = () => Promise.reject(error);
    },
    serverHolds: () => {
      const gate = deferred<TestUser>();
      answer = () => gate.promise;
      return gate;
    },
    serverNeverAnswers: () => {
      answer = (signal) =>
        new Promise<TestUser>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
    },
    signIn: (next: TestUser, token: string) => {
      session.generation += 1;
      session.user = next;
      session.token = token;
    },
    signOut: () => {
      session.generation += 1;
      session.user = null;
      session.token = null;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("throttle: resume and 403 triggers share one 30 s window", () => {
  it("allows the first resume, skips every resume / feature-denied trigger inside the window, and allows the next one after it", async () => {
    const d = device();
    expect(await d.refresher.refresh("resume")).toBe("unchanged");
    expect(d.fetchUser).toHaveBeenCalledTimes(1);

    d.advance(5_000);
    expect(await d.refresher.refresh("resume")).toBe("throttled");
    expect(await d.refresher.refresh("feature-denied")).toBe("throttled");
    // A skipped trigger does not extend the window: it still ends 30 s after the refresh that opened it.
    d.advance(ENTITLEMENT_REFRESH_THROTTLE_MS - 5_000 - 1);
    expect(await d.refresher.refresh("feature-denied")).toBe("throttled");
    expect(d.fetchUser).toHaveBeenCalledTimes(1);

    d.advance(1);
    expect(await d.refresher.refresh("feature-denied")).toBe("unchanged");
    expect(d.fetchUser).toHaveBeenCalledTimes(2);
    expect(await d.refresher.refresh("resume")).toBe("throttled");
  });

  it("never throttles session restore or a token refresh, and they do not open the window (the first resume after launch still runs)", async () => {
    const d = device();
    expect(await d.refresher.refresh("restore")).toBe("unchanged");
    expect(await d.refresher.refresh("token-refresh")).toBe("unchanged");
    expect(await d.refresher.refresh("restore")).toBe("unchanged");
    expect(d.fetchUser).toHaveBeenCalledTimes(3);

    expect(await d.refresher.refresh("resume")).toBe("unchanged");
    expect(d.fetchUser).toHaveBeenCalledTimes(4);
    expect(await d.refresher.refresh("resume")).toBe("throttled");
    // …and inside the window the unthrottled triggers still go through.
    expect(await d.refresher.refresh("token-refresh")).toBe("unchanged");
    expect(d.fetchUser).toHaveBeenCalledTimes(5);
  });

  it("a failed refresh still consumes the window (a failing server is not retried on every trigger)", async () => {
    const d = device();
    d.serverFails(new Error("HTTP 503"));
    expect(await d.refresher.refresh("feature-denied")).toBe("failed");
    expect(await d.refresher.refresh("feature-denied")).toBe("throttled");
    expect(await d.refresher.refresh("resume")).toBe("throttled");
    expect(d.fetchUser).toHaveBeenCalledTimes(1);
  });

  it("a device clock set back does not freeze the refresh", async () => {
    const d = device();
    expect(await d.refresher.refresh("resume")).toBe("unchanged");
    d.advance(-3_600_000);
    expect(await d.refresher.refresh("resume")).toBe("unchanged");
    expect(d.fetchUser).toHaveBeenCalledTimes(2);
    expect(await d.refresher.refresh("resume")).toBe("throttled");
  });

  it("does not request anything — and does not open the window — while signed out", async () => {
    const d = device(null);
    for (const trigger of ["restore", "token-refresh", "resume", "feature-denied"] as const) {
      expect(await d.refresher.refresh(trigger)).toBe("signed-out");
    }
    expect(d.fetchUser).not.toHaveBeenCalled();

    d.signIn(user(), "session-token-1");
    expect(await d.refresher.refresh("resume")).toBe("unchanged");
    expect(d.fetchUser).toHaveBeenCalledTimes(1);
  });
});

describe("de-duplication: concurrent triggers share one in-flight request", () => {
  it("every trigger that arrives while a refresh is in flight gets that same request", async () => {
    const d = device();
    const gate = d.serverHolds();
    const first = d.refresher.refresh("restore");
    const joined = [d.refresher.refresh("resume"), d.refresher.refresh("feature-denied"), d.refresher.refresh("token-refresh"), d.refresher.refresh("restore")];
    for (const p of joined) expect(p).toBe(first);

    gate.resolve(user({}, { ...ALL_ALLOWED, documents: false }));
    expect(await Promise.all([first, ...joined])).toEqual(["applied", "applied", "applied", "applied", "applied"]);
    expect(d.fetchUser).toHaveBeenCalledTimes(1);
    expect(d.applyUser).toHaveBeenCalledTimes(1);
  });

  it("a trigger that joined an in-flight request did not open the throttle window; once it settles a new request can start", async () => {
    const d = device();
    const gate = d.serverHolds();
    const first = d.refresher.refresh("restore");
    const joined = d.refresher.refresh("resume");
    gate.resolve(user());
    await Promise.all([first, joined]);

    d.serverAnswers(user());
    expect(await d.refresher.refresh("resume")).toBe("unchanged");
    expect(d.fetchUser).toHaveBeenCalledTimes(2);
  });
});

describe("a failed refresh never ends or alters the session", () => {
  const failures: Array<[string, unknown]> = [
    ["a network error", new TypeError("Network request failed")],
    ["a 500", Object.assign(new Error("HTTP 500 Internal Server Error"), { status: 500 })],
    ["a 403", Object.assign(new Error("HTTP 403 Forbidden"), { status: 403 })],
    ["a 401", Object.assign(new Error("HTTP 401 Unauthorized"), { status: 401 })],
  ];
  for (const [name, error] of failures) {
    it(`${name}: resolves "failed" (never rejects), applies nothing, the user and the token stay`, async () => {
      const before = user({}, { ...ALL_ALLOWED, "nfc.capture": false });
      const d = device(before);
      d.serverFails(error);
      for (const trigger of ["restore", "token-refresh", "resume"] as const) {
        await expect(d.refresher.refresh(trigger)).resolves.toBe("failed");
      }
      expect(d.applyUser).not.toHaveBeenCalled();
      expect(d.session.user).toBe(before);
      expect(d.session.token).toBe("session-token-1");
      expect(featureAllowed(d.session.user, "nfc.capture")).toBe(false);
      expect(featureAllowed(d.session.user, "documents")).toBe(true);
    });
  }

  it("a timeout: the request is aborted after 15 s, counts as failed, and the next refresh starts a new request", async () => {
    vi.useFakeTimers();
    const before = user();
    const d = device(before);
    d.serverNeverAnswers();
    const hung = d.refresher.refresh("restore");
    await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_TIMEOUT_MS - 1);
    expect(d.fetchUser.mock.calls[0]![0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.fetchUser.mock.calls[0]![0].aborted).toBe(true);
    await expect(hung).resolves.toBe("failed");
    expect(d.session.user).toBe(before);
    expect(d.session.token).toBe("session-token-1");

    d.serverAnswers(user({}, { ...ALL_ALLOWED, documents: false }));
    await expect(d.refresher.refresh("restore")).resolves.toBe("applied");
    expect(d.fetchUser).toHaveBeenCalledTimes(2);
  });

  it("an answer that is not a user (empty / malformed body) is dropped", async () => {
    const before = user();
    const d = device(before);
    for (const junk of [null, undefined, "<html>captive portal</html>", {}, { id: "7", companyId: 3 }]) {
      d.serverAnswers(junk as unknown as TestUser);
      expect(await d.refresher.refresh("restore")).toBe("discarded");
    }
    expect(d.applyUser).not.toHaveBeenCalled();
    expect(d.session.user).toBe(before);
  });

  it("a throwing dependency is contained as well", async () => {
    const d = device();
    d.fetchUser.mockImplementationOnce(() => {
      throw new Error("sync failure");
    });
    await expect(d.refresher.refresh("restore")).resolves.toBe("failed");
    d.serverAnswers(user({}, { ...ALL_ALLOWED, documents: false }));
    d.applyUser.mockImplementationOnce(() => {
      throw new Error("storage failure");
    });
    await expect(d.refresher.refresh("restore")).resolves.toBe("failed");
    expect(d.session.token).toBe("session-token-1");
  });
});

describe("identity guard: an answer is only applied to the session it was requested for", () => {
  const denied = () => user({}, { ...ALL_ALLOWED, documents: false });

  it("discards an answer that arrives after sign-out (the session stays signed out)", async () => {
    const d = device();
    const gate = d.serverHolds();
    const pending = d.refresher.refresh("restore");
    d.signOut();
    gate.resolve(denied());
    expect(await pending).toBe("discarded");
    expect(d.applyUser).not.toHaveBeenCalled();
    expect(d.session.user).toBeNull();
    expect(d.session.token).toBeNull();
  });

  it("discards an answer for the previous account after another account signed in", async () => {
    const d = device();
    const gate = d.serverHolds();
    const pending = d.refresher.refresh("resume");
    const other = user({ id: 99, companyId: 41, name: "Other Tenant" });
    d.signOut();
    d.signIn(other, "session-token-2");
    gate.resolve(denied());
    expect(await pending).toBe("discarded");
    expect(d.applyUser).not.toHaveBeenCalled();
    expect(d.session.user).toBe(other);
    expect(featureAllowed(d.session.user, "documents")).toBe(true);
  });

  it("discards an answer requested before the SAME account signed in again (new session generation)", async () => {
    const d = device();
    const gate = d.serverHolds();
    const pending = d.refresher.refresh("restore");
    const again = user();
    d.signIn(again, "session-token-2");
    gate.resolve(denied());
    expect(await pending).toBe("discarded");
    expect(d.session.user).toBe(again);
  });

  it("discards an answer that describes a different user or company than the session it was requested for", async () => {
    const d = device();
    d.serverAnswers(user({ id: 99 }, { ...ALL_ALLOWED, documents: false }));
    expect(await d.refresher.refresh("restore")).toBe("discarded");
    d.serverAnswers(user({ companyId: 41 }, { ...ALL_ALLOWED, documents: false }));
    expect(await d.refresher.refresh("restore")).toBe("discarded");
    expect(d.applyUser).not.toHaveBeenCalled();
  });

  it("a trigger for the new session does not join the previous session's request — it gets its own answer", async () => {
    const d = device();
    const oldGate = d.serverHolds();
    const oldPending = d.refresher.refresh("restore");
    const other = user({ id: 99, companyId: 41, name: "Other Tenant" });
    d.signIn(other, "session-token-2");

    const fresh = user({ id: 99, companyId: 41, name: "Other Tenant" }, { ...ALL_ALLOWED, "nfc.capture": false });
    d.serverAnswers(fresh);
    const newPending = d.refresher.refresh("restore");
    expect(newPending).not.toBe(oldPending);
    expect(await newPending).toBe("applied");
    expect(d.session.user).toBe(fresh);

    oldGate.resolve(denied());
    expect(await oldPending).toBe("discarded");
    expect(d.session.user).toBe(fresh);
    expect(d.applyUser).toHaveBeenCalledTimes(1);
  });

  it("shouldApplyRefresh / userChanged: the pure rules", () => {
    const requested: SessionIdentity = { userId: 7, companyId: 3, generation: 4 };
    expect(shouldApplyRefresh(requested, { ...requested }, { id: 7, companyId: 3 })).toBe(true);
    expect(shouldApplyRefresh(requested, null, { id: 7, companyId: 3 })).toBe(false);
    expect(shouldApplyRefresh(requested, { ...requested, generation: 5 }, { id: 7, companyId: 3 })).toBe(false);
    expect(shouldApplyRefresh(requested, { ...requested, userId: 8 }, { id: 7, companyId: 3 })).toBe(false);
    expect(shouldApplyRefresh(requested, { ...requested, companyId: 9 }, { id: 7, companyId: 3 })).toBe(false);
    expect(shouldApplyRefresh(requested, { ...requested }, { id: 7, companyId: null })).toBe(false);
    // A platform operator has no company on either side.
    const platform: SessionIdentity = { userId: 1, companyId: null, generation: 0 };
    expect(shouldApplyRefresh(platform, { ...platform }, { id: 1 })).toBe(true);

    expect(userChanged(user(), user())).toBe(false);
    expect(userChanged(user(), user({ name: "Renamed" }))).toBe(true);
    expect(userChanged(user(), user({}, { ...ALL_ALLOWED, documents: false }))).toBe(true);
    expect(userChanged(null, user())).toBe(true);
  });
});

describe("applying the answer replaces the cached entitlements", () => {
  it("documents true → false on an enforced version: featureAllowed reports the new value, the token is untouched", async () => {
    const d = device(user());
    expect(featureAllowed(d.session.user, "documents")).toBe(true);

    const fresh = user({}, { ...ALL_ALLOWED, documents: false }, "enforced");
    d.serverAnswers(fresh);
    expect(await d.refresher.refresh("feature-denied")).toBe("applied");

    expect(d.applyUser).toHaveBeenCalledTimes(1);
    expect(d.applyUser).toHaveBeenCalledWith(fresh);
    expect(d.session.user).toBe(fresh);
    expect(featureEnforcementOf(d.session.user)).toBe("enforced");
    expect(featureAllowed(d.session.user, "documents")).toBe(false);
    expect(featureAllowed(d.session.user, "nfc.capture")).toBe(true);
    expect(d.session.token).toBe("session-token-1");
    expect(d.session.generation).toBe(0);
  });

  it("…and false → true when the plan includes it again", async () => {
    const d = device(user({}, { ...ALL_ALLOWED, documents: false, "nfc.capture": false }));
    expect(featureAllowed(d.session.user, "nfc.capture")).toBe(false);
    d.serverAnswers(user());
    expect(await d.refresher.refresh("resume")).toBe("applied");
    for (const feature of FEATURES) expect(featureAllowed(d.session.user, feature)).toBe(true);
  });

  it("a legacy (grandfathered) payload keeps every feature allowed", async () => {
    const d = device(user({}, { ...ALL_ALLOWED, documents: false, "ai.assistant": false }));
    d.serverAnswers(user({}, ALL_ALLOWED, "legacy"));
    expect(await d.refresher.refresh("restore")).toBe("applied");
    expect(featureEnforcementOf(d.session.user)).toBe("legacy");
    for (const feature of FEATURES) expect(featureAllowed(d.session.user, feature)).toBe(true);

    // A payload without tenant entitlements at all (platform operator / pre-entitlement server) hides nothing either.
    d.serverAnswers(user({ entitlements: null }));
    expect(await d.refresher.refresh("restore")).toBe("applied");
    expect(featureEnforcementOf(d.session.user)).toBeNull();
    for (const feature of FEATURES) expect(featureAllowed(d.session.user, feature)).toBe(true);
  });

  it("an identical answer is not applied at all (no storage write, no re-render)", async () => {
    const before = user();
    const d = device(before);
    d.serverAnswers(user());
    expect(await d.refresher.refresh("restore")).toBe("unchanged");
    expect(await d.refresher.refresh("resume")).toBe("unchanged");
    expect(d.applyUser).not.toHaveBeenCalled();
    expect(d.session.user).toBe(before);
  });
});

describe("the web app runs the same logic", () => {
  // The web app has no unit-test runner; its copy of this module is covered by
  // this suite as long as the two files stay identical below the header comment.
  it("artifacts/web-app/src/lib/entitlement-refresh.ts matches this module line for line", () => {
    const body = (relativePath: string) => {
      const source = readFileSync(fileURLToPath(String(new URL(relativePath, import.meta.url))), "utf8");
      return source.slice(source.indexOf("// The signed-in `User`"));
    };
    const mobile = body("./entitlement-refresh.ts");
    const web = body("../../web-app/src/lib/entitlement-refresh.ts");
    expect(mobile).toContain("export function createEntitlementRefresher");
    expect(web).toBe(mobile);
  });
});
