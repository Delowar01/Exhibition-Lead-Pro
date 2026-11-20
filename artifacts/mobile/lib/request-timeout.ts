// Phase 2 Batch 1 — a time limit for the requests the offline sync makes.
//
// React Native's network layer has no time limit of its own: a connection that
// stalls (a lift, a tunnel, a captive network) can leave a request hanging for
// a very long time, and the sync — which sends one item after another — would
// stand still behind it until the app is restarted. With a limit the request is
// cancelled, the sync treats it as "no answer" (the item keeps waiting and is
// retried) and the next run can start.
//
// A cancelled request may still have reached the server. That case is exactly
// the "answer lost" case the sync already handles (lib/offline-sync.ts).

/** Run `call` with a signal that aborts after `ms`. Without AbortController the call runs unlimited. */
export async function withTimeout<T>(ms: number, call: (options: { signal?: AbortSignal }) => Promise<T>): Promise<T> {
  if (typeof AbortController === "undefined") return call({});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await call({ signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Limits per request of the sync: a card photo upload includes the server's reading of the card. */
export const SYNC_TIMEOUT_MS = {
  createScan: 180_000,
  getScan: 30_000,
  createContact: 60_000,
  upsertOwnCard: 60_000,
} as const;
