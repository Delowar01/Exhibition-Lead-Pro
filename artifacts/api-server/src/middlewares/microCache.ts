import { type Request, type Response, type NextFunction } from "express";
import { type AuthRequest } from "./requireAuth.js";

// Global monotonic write epoch. Every successful mutating (non-GET) request
// increments it, so any read cached under the prior epoch is instantly
// unreachable — a coarse but bug-free invalidation (no per-tenant tracking, no
// create->read flakiness). Reads only ever serve data no older than the last
// successful write or the TTL, whichever is shorter.
let writeEpoch = 0;

interface Entry {
  expires: number;
  body: unknown;
}
const store = new Map<string, Entry>();
const MAX_ENTRIES = 1000;

// Increment the write epoch after any successful (<400) non-GET request, busting
// every micro-cached read. Mounted high so it covers all mutating routes; the
// bump happens on `finish` so only requests that actually completed successfully
// invalidate the cache.
export function bustCacheOnWrite(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    next();
    return;
  }
  res.on("finish", () => {
    if (res.statusCode < 400) writeEpoch++;
  });
  next();
}

function pruneIfNeeded(): void {
  if (store.size < MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expires <= now) store.delete(k);
  }
  if (store.size >= MAX_ENTRIES) store.clear();
}

// Short-TTL in-memory cache for expensive read-only analytics GETs. Keyed by
// (writeEpoch, userId, url) so a successful write busts all entries and one user
// can never read another user's cached payload. TTL bounds staleness even with
// zero writes. Only successful (<400) responses are cached.
export function microCache(ttlMs: number) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (req.method !== "GET") {
      next();
      return;
    }
    const userKey = req.user ? String(req.user.id) : "anon";
    const key = `${writeEpoch}:${userKey}:${req.originalUrl}`;
    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.expires > now) {
      res.setHeader("X-Cache", "HIT");
      res.json(hit.body);
      return;
    }
    res.setHeader("X-Cache", "MISS");
    const originalJson = res.json.bind(res);
    res.json = ((body?: unknown) => {
      if (res.statusCode < 400) {
        pruneIfNeeded();
        store.set(key, { expires: Date.now() + ttlMs, body });
      }
      return originalJson(body);
    }) as typeof res.json;
    next();
  };
}
