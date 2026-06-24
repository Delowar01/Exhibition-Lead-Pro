---
name: Analytics micro-cache + global write-epoch
description: The chosen short-TTL in-memory cache pattern for expensive analytics GETs and why invalidation is a single global epoch, not per-tenant.
---

# Analytics micro-cache + global write-epoch

**Rule:** Expensive read-only analytics GETs (`/reports/leads-by-event`,
`/reports/team-performance`, `/reports/scan-activity`) are wrapped in a short-TTL (~30s)
in-memory micro-cache (`api-server/src/middlewares/microCache.ts`). Invalidation is a
single process-global monotonic `writeEpoch` that increments on EVERY successful (<400)
non-GET request (`bustCacheOnWrite`, mounted in `app.ts` before the router). The cache
key is `${writeEpoch}:${userId}:${originalUrl}`.

**Why:**
- Coarse global busting (bump epoch on any write) is deliberately chosen over per-tenant
  / per-entity invalidation: it has no invalidation-tracking bugs and no create→read test
  flakiness. Any write makes every prior-epoch key unreachable, so a read never serves
  data older than the last successful write or the TTL, whichever is shorter.
- `userId` is in the key specifically to prevent one user reading another user's cached
  payload (the middleware runs AFTER `requireAuth`, so `req.user` is populated). Do NOT
  key by tenant/company alone — different roles in a tenant see different scoped data.

**How to apply:**
- Only cache GETs that are pure tenant-scoped reads with no per-call side effects. Never
  cache auth or mutation responses.
- Keep TTL short; the epoch handles correctness, the TTL only bounds staleness in quiet
  periods.
- Memory is bounded (`MAX_ENTRIES`, prune-expired then clear). Old-epoch entries are
  unreachable but linger until a prune — that's fine, it's bounded.
- Don't add per-entity invalidation on top of this thinking it's "more correct" — it
  reintroduces exactly the tracking bugs this design avoids.
- Test reliance: `vitest.config.ts` has `fileParallelism: false`, so X-Cache HIT/MISS is
  deterministic within a test file (no parallel writes from other files between two reads).
