---
name: Observability & monitoring design
description: Durable decisions for the metrics/readiness/audit/alerts observability layer (Phase 2.10) — readiness gating, per-process metrics, and tenant-scoping of login_attempts.
---

## Readiness probe: DB is the only 503 gate; storage degrades, never drops the node
`GET /readyz` runs a real object-storage reachability probe (`bucket(id).exists()` bounded by a ~2s `Promise.race`, timer cleared in `finally`). A storage failure sets `status: "degraded"` but still returns **200**. Only the database failing returns **503**.
**Why:** most requests never touch object storage, so flapping the instance off-rotation on a storage blip would cause more harm than the blip itself; the degraded signal stays visible without dropping traffic. Do NOT "fix" storage-error into a 503 — that regression was deliberately avoided.
**How to apply:** any new readiness dependency that isn't on the hot path of most requests should degrade (200 + degraded), not gate (503).

## Metrics are per-process and reset on restart
`GET /metrics` (platform_owner only) is backed by an in-memory registry + a `res.finish` middleware. Counters reset on restart and report per-instance numbers under multi-instance deploys — same tradeoff as the in-process job queue.
**Why:** acceptable for operational visibility without adding a metrics backend. If accurate fleet-wide aggregates are ever needed, that requires an external store (Prometheus/etc.), not a bigger in-memory counter.

## login_attempts has NO companyId — tenant attribution is via user_id
The `login_attempts` table has no tenant column. Security-alert scoping attributes attempts to a tenant by joining `user_id` → users in `accessibleCompanies`. Attempts for unknown/nonexistent emails carry a null `user_id` and are therefore **visible only to platform_owner** (a tenant can't see failed logins for emails that aren't theirs).
**Why:** this is the only correct tenant boundary available on that table; counting by email alone would leak cross-tenant probing. `lockouts` in the alerts aggregate is an approximation (distinct emails hitting the failure threshold in the window), not the exact runtime lockout state.

## Audit viewer scoping
`GET /security/audit` applies `tenantScope(user, auditLogsTable.companyId)` BEFORE any optional filter, so a `companyId`/`userId`/search filter can only narrow, never widen. Null-company (platform-level) audit rows are excluded for non-platform users. Same `alertCompanyScope` pattern: an out-of-scope `companyId` is silently folded back to the caller's accessible scope.
