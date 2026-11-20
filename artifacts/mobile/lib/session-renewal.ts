// Phase 2 Batch 1 — ONE renewal request per refresh token, with a deadline for
// those who wait on it (pure; contexts/AuthContext.tsx supplies the request and
// what to do with its answer).
//
// A refresh token is single-use. The API replaces it when it answers a renewal,
// and it revokes the whole session when a replaced token is presented again.
// Two consequences shape this module:
//
//   1. The renewal request is NEVER cancelled. If the API has handled it, its
//      answer carries the only copy of the new refresh token. A request that is
//      cancelled at a deadline throws that answer away — and the next renewal
//      would present the old token and get the session revoked. So the
//      deadline here ends the WAITING, not the request.
//
//   2. The same refresh token is not sent a second time while its request is
//      still under way. Whoever needs a renewal in the meantime waits on the
//      SAME request (each with a deadline of their own). The answer is taken
//      into use exactly once, whenever it arrives — also when nobody is
//      waiting any more.
//
// Only when a request has been silent for much longer (`abandonMs`) is it given
// up and a new one allowed: by then it is either lost for good (the new one
// succeeds) or it was handled and its answer will never come (the new one is
// refused and the user signs in again — nothing can prevent that without a
// server-side grace window).
import { withTimeout } from "./request-timeout";

export interface SessionRenewerDeps {
  /** Send the renewal request for this refresh token. Must not be given a cancellation signal. */
  request(refreshToken: string): Promise<unknown>;
  /** How long one caller waits for the answer before its own request fails (the session stays). */
  timeoutMs: number;
  /** After this long without an answer a request counts as lost and a new one may be sent. */
  abandonMs: number;
  now(): number;
}

/** What to do with the outcome of the request a call STARTED (a call that joins a request brings none). */
export interface RenewalHandlers {
  /** The API answered. Take the answer into use if it still applies; resolve the access token to retry with, or null. */
  adopt(answer: unknown): Promise<string | null>;
  /** The request failed (refused, no connection, …). Decide what that means for the session. */
  failed(err: unknown): Promise<void>;
}

export interface SessionRenewer {
  /** The access token to retry with, or null (not renewed: refused, no answer in time, or no longer applicable). */
  renew(refreshToken: string, handlers: RenewalHandlers): Promise<string | null>;
  /** Is a request for this refresh token under way (and not given up)? */
  pendingFor(refreshToken: string): boolean;
}

export function createSessionRenewer(deps: SessionRenewerDeps): SessionRenewer {
  interface Pending {
    refreshToken: string;
    startedAt: number;
    /** Settles when the request is answered AND its answer has been dealt with. Never rejects. */
    outcome: Promise<string | null>;
  }
  let pending: Pending | null = null;

  const live = (refreshToken: string): Pending | null => {
    if (!pending || pending.refreshToken !== refreshToken) return null;
    return deps.now() - pending.startedAt < deps.abandonMs ? pending : null;
  };

  return {
    pendingFor: (refreshToken) => live(refreshToken) !== null,

    renew(refreshToken, handlers) {
      let entry = live(refreshToken);
      if (!entry) {
        const started: Pending = { refreshToken, startedAt: deps.now(), outcome: Promise.resolve(null) };
        started.outcome = Promise.resolve()
          .then(() => deps.request(refreshToken))
          .then(
            // Dealt with exactly once, here — whether anybody is still waiting or not.
            (answer) => handlers.adopt(answer).catch(() => null),
            (err) =>
              handlers
                .failed(err)
                .catch(() => {})
                .then(() => null),
          )
          .finally(() => {
            if (pending === started) pending = null;
          });
        pending = started;
        entry = started;
      }
      const outcome = entry.outcome;
      // The deadline ends this caller's wait only; `outcome` goes on.
      return withTimeout(deps.timeoutMs, () => outcome).catch(() => null);
    },
  };
}
