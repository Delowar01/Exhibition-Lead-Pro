---
name: AI usage metering, budgets & stub testing
description: Budget reservation semantics, ledger durability rules, and how to test the AI usage pipeline deterministically without live Gemini.
---

## Budget admission semantics (deliberate)
Reservation admission DENIES when `ledger + active reservations >= budget`; the candidate's own reserve slice is NOT pre-added.
**Why:** pre-adding the reserve (a conservative worst-case slice, larger than most real calls) would permanently lock out tenants whose remaining/total budget is smaller than one slice. Overshoot is bounded by in-flight calls admitted before the sum crossed the line.
**How to apply:** concurrency tests wanting "exactly 1 winner" need a budget smaller than one reserve slice; a budget of ~1.25 slices admits TWO concurrent calls.

## Ledger durability contract
- Reservation is released ONLY after the ledger write is durable: written, queued for retry, or intentionally dropped. If both write AND enqueue fail, keep the reservation until TTL (unrecorded spend keeps counting against admission).
- Reservation TTL must exceed worst-case provider call (timeout × retries + backoff) or in-flight spend vanishes from admission sums mid-call.
- FK violation (Postgres 23503) on a ledger insert means the tenant/user was deleted mid-write — it is PERMANENT; drop with a warn, never retry/dead-letter (walk `err.cause` chain for the code).

## Deterministic AI testing (stub provider, non-prod only)
- Select via PATCH /ai/settings {provider:"stub", model:...}. Models: stub-model (deterministic usage), stub-nousage (estimated-usage fallback), stub-fail, stub-fail-once, stub-timeout, stub-slow (1500ms, for concurrency/dedup races).
- "Fail once then succeed" levers must be keyed per prompt hash, NOT a process-global parity counter — the server process outlives test runs, and any unrelated call or aborted run shifts parity and makes the test flaky forever after.
- Set the stub provider BEFORE creating contacts in fixtures, or background auto-scoring hits live Gemini.
- Non-provider zero-usage rows (cache_hit, dedup_reused, rate_limited) are written fire-and-forget — tests must poll for them, not sleep or assert immediately.

## Test-fixture gotchas
- Users created with role "admin" do NOT get ai_copilot permissions by default; grant via direct DB `permissions || '{"ai_copilot":["view","generate","use"]}'` jsonb merge (mirrors the production backfill; requirePermission re-reads per request so post-login grants work). primary_admin bypasses.
- Playwright: conditionally rendered dashboards (pagination footers only past page 1, "near limit" cards only when data qualifies) — assert an always-present anchor (card title / stat testid), not the conditional testid.
