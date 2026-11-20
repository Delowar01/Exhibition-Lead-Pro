// Phase 2 Batch 1 — a HARD time limit for requests that must not hang.
//
// React Native's network layer has no time limit of its own: a connection that
// stalls (a lift, a tunnel, a captive network) can leave a request hanging for
// a very long time, and the sync — which sends one item after another — would
// stand still behind it until the app is restarted.
//
// The limit here does not depend on the request co-operating. At the deadline
//   1. the request is asked to stop (AbortSignal — honoured by fetch, but a
//      request is free to ignore it), and
//   2. the returned promise is REJECTED with a TimeoutError, whatever the
//      request does.
// So the caller always continues at the deadline. What the request does
// afterwards can no longer reach the caller: a late success is dropped (or
// handed to `onLate`, for the one caller that can use it safely), a late
// failure is swallowed.
//
// A request that ran into its limit may still have reached the server. For the
// sync that is exactly the "answer lost" case it already handles
// (lib/offline-sync.ts): where a scan stands behind the item the server is
// asked, otherwise the repeat goes through duplicate detection again.

/** Thrown at the deadline. `name` is "TimeoutError", which the app classifies as "no answer". */
export class RequestTimeoutError extends Error {
  readonly name = "TimeoutError";
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`No answer within ${timeoutMs} ms`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.timeoutMs = timeoutMs;
  }
}

export interface TimeoutOptions<T> {
  /**
   * Called when the request succeeds AFTER the deadline (the caller was already
   * told "no answer"). Only for a caller that can apply a late answer without
   * repeating anything — it must check for itself that the answer still
   * belongs to the present state. Errors it throws are ignored.
   */
  onLate?: (value: T) => void;
}

/**
 * Run `call` with a signal that aborts after `ms`, and settle after `ms` at the
 * latest even if `call` ignores the signal and never settles itself.
 */
export function withTimeout<T>(ms: number, call: (options: { signal?: AbortSignal }) => Promise<T>, options: TimeoutOptions<T> = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        controller?.abort();
      } catch {
        // Asking it to stop is best effort; the deadline holds regardless.
      }
      reject(new RequestTimeoutError(ms));
    }, ms);

    let work: Promise<T>;
    try {
      work = Promise.resolve(call(controller ? { signal: controller.signal } : {}));
    } catch (err) {
      settled = true;
      clearTimeout(timer);
      reject(err);
      return;
    }
    work.then(
      (value) => {
        if (settled) {
          // Too late: the caller has moved on.
          try {
            options.onLate?.(value);
          } catch {
            // A late answer must never surface as a new error.
          }
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return; // a late failure concerns nobody any more
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Limits per request of the sync: a card photo upload includes the server's reading of the card. */
export const SYNC_TIMEOUT_MS = {
  createScan: 180_000,
  getScan: 30_000,
  createContact: 60_000,
  upsertOwnCard: 60_000,
} as const;

/** Limit for renewing the session (POST /auth/refresh). */
export const SESSION_RENEWAL_TIMEOUT_MS = 30_000;
