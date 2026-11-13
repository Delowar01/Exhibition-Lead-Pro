// M5 — client entitlement refresh: the decision logic, free of React Native,
// storage and fetch (artifacts/web-app/src/lib/entitlement-refresh.ts is the
// same module — the two apps share no UI library; the unit tests live here).
//
// The signed-in `User` carries the plan-version `entitlements` the server
// resolved at sign-in. The clients used to keep that copy until the next
// sign-in, so a plan change left navigation and feature screens out of date.
// The auth context now re-reads GET /auth/me through this module. The API stays
// authoritative (it resolves entitlements on every request); this only keeps
// the client's copy consistent and never ends, replaces or repairs a session.

/**
 * Resume and 403 triggers share one window: at most one refresh per 30 s. The
 * window opens when such a refresh starts, whatever its outcome (a failed one
 * is not retried early), and a skipped trigger does not extend it.
 */
export const ENTITLEMENT_REFRESH_THROTTLE_MS = 30_000;
/** A refresh that has not answered by then is abandoned (and counts as failed). */
export const ENTITLEMENT_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Why a refresh is asked for.
 *  - "restore" (stored session loaded) and "token-refresh" (session renewed)
 *    happen once per event and are never throttled;
 *  - "resume" (tab/app back in front) and "feature-denied" (a 403
 *    FEATURE_NOT_ENTITLED) can repeat freely and are throttled.
 * Every trigger joins a request already in flight for the same session.
 */
export type RefreshTrigger = "restore" | "token-refresh" | "resume" | "feature-denied";

const THROTTLED_TRIGGERS: ReadonlySet<RefreshTrigger> = new Set<RefreshTrigger>(["resume", "feature-denied"]);

/** The session a refresh is requested for — and the only one it may be applied to. */
export interface SessionIdentity {
  userId: number;
  companyId: number | null;
  /** Bumped by the auth context whenever the session or its user is replaced locally. */
  generation: number;
}

export type RefreshOutcome =
  | "applied" // the server copy differed and replaced the cached user
  | "unchanged" // identical to the cached user — nothing touched, no re-render
  | "signed-out" // no session: no request
  | "throttled" // inside the 30 s window: no request
  | "discarded" // answered for a session that is no longer the current one
  | "failed"; // network error, non-2xx, timeout — ignored, the session is untouched

interface RefreshableUser {
  id: number;
  companyId?: number | null;
}

export interface EntitlementRefreshDeps<U extends RefreshableUser> {
  /** The current session, or null when signed out. Read when a refresh starts and again when it answers. */
  getIdentity: () => SessionIdentity | null;
  /** The cached user the answer is compared with. */
  getUser: () => U | null;
  /** GET /auth/me. May reject; must honour the abort signal. */
  fetchUser: (signal: AbortSignal) => Promise<U>;
  /** Replace the in-memory and the persisted user. Never touches tokens. */
  applyUser: (user: U) => void;
  now?: () => number;
}

export function sameSession(a: SessionIdentity | null, b: SessionIdentity | null): boolean {
  return !!a && !!b && a.userId === b.userId && a.companyId === b.companyId && a.generation === b.generation;
}

/**
 * Identity guard: the answer is only applied when the session it was requested
 * for is still the current one AND it describes that same user and company. An
 * answer that arrives after sign-out, or after another account signed in, is
 * dropped.
 */
export function shouldApplyRefresh(
  requested: SessionIdentity,
  current: SessionIdentity | null,
  fresh: RefreshableUser | null | undefined,
): boolean {
  if (!fresh || typeof fresh !== "object") return false;
  return sameSession(requested, current) && fresh.id === requested.userId && (fresh.companyId ?? null) === requested.companyId;
}

/** Serialized comparison — an identical answer must not cause a write or a re-render. */
export function userChanged(cached: unknown, fresh: unknown): boolean {
  return JSON.stringify(cached ?? null) !== JSON.stringify(fresh ?? null);
}

export function createEntitlementRefresher<U extends RefreshableUser>(deps: EntitlementRefreshDeps<U>) {
  const now = deps.now ?? Date.now;
  let inFlight: { identity: SessionIdentity; promise: Promise<RefreshOutcome> } | null = null;
  let lastThrottledStart: number | null = null;

  // Never rejects: every failure is an outcome.
  async function run(requested: SessionIdentity): Promise<RefreshOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), ENTITLEMENT_REFRESH_TIMEOUT_MS);
      const fresh = await deps.fetchUser(controller.signal);
      if (!shouldApplyRefresh(requested, deps.getIdentity(), fresh)) return "discarded";
      if (!userChanged(deps.getUser(), fresh)) return "unchanged";
      deps.applyUser(fresh);
      return "applied";
    } catch {
      // A refresh is best effort: whatever went wrong, the session and the
      // cached user stay exactly as they were. Only the API client's own 401
      // handling may end a session.
      return "failed";
    } finally {
      clearTimeout(timer);
    }
  }

  function start(trigger: RefreshTrigger): Promise<RefreshOutcome> {
    const requested = deps.getIdentity();
    if (!requested) return Promise.resolve("signed-out");
    if (inFlight && sameSession(inFlight.identity, requested)) return inFlight.promise;
    if (THROTTLED_TRIGGERS.has(trigger)) {
      const at = now();
      // A clock set back (negative elapsed) must not freeze the refresh.
      const elapsed = lastThrottledStart === null ? null : at - lastThrottledStart;
      if (elapsed !== null && elapsed >= 0 && elapsed < ENTITLEMENT_REFRESH_THROTTLE_MS) {
        return Promise.resolve("throttled");
      }
      lastThrottledStart = at;
    }
    const entry = { identity: requested, promise: run(requested) };
    inFlight = entry;
    void entry.promise.then(() => {
      if (inFlight === entry) inFlight = null;
    });
    return entry.promise;
  }

  return {
    /** Never throws and never rejects. */
    refresh(trigger: RefreshTrigger): Promise<RefreshOutcome> {
      try {
        return start(trigger);
      } catch {
        return Promise.resolve("failed");
      }
    },
  };
}
