# Stage 2 — Definition of Done

**Phase 2.10 — Monitoring & Observability**
Date: June 24, 2026
Scope: `@workspace/api-server` + `@workspace/web-app`. Additive / backward-compatible — no product features, no breaking contract changes.

This report records what was built for the observability phase and how each item was
verified. It closes technical-debt item **M2** (placeholder readiness probe).

## Summary

| Area | Outcome |
|---|---|
| Structured logging enrichment | ✅ Each request-completion log carries `userId` + `companyId` |
| Request + job metrics | ✅ `GET /metrics` (platform-owner only) |
| Readiness probe (closes M2) | ✅ `GET /readyz` performs a real object-storage reachability probe |
| Audit-log viewer | ✅ `GET /security/audit` — searchable, filterable, tenant-scoped |
| Security alerts | ✅ `GET /security/alerts` — failed logins, lockouts, policy blocks |
| Web surfacing | ✅ Platform Activity (Audit tab) + Admin Security (Alerts cards + Audit tab) |

## What was delivered

### 1. Structured logging enrichment
- `pino-http` `customProps` adds the authenticated principal (`userId`, `companyId`) to every
  request-completion log. Evaluated at log time, so it sees the `req.user` populated by
  `requireAuth`. Anonymous / pre-auth requests add nothing.
- **Why it matters:** logs are now correlatable per user and per tenant without changing any
  response payload.

### 2. Request + job metrics — `GET /metrics`
- In-process registry (`src/lib/metrics.ts`) + middleware records every request's status class,
  latency (avg + max), and 5xx error count, plus process uptime. Job-queue stats are pulled from
  `getQueue().stats()`.
- Vendor-neutral JSON snapshot. **Gated to `platform_owner`** (operational internals, not public).
- **Caveat (documented):** counters are per-process and reset on restart, mirroring the in-process
  job queue's existing tradeoff. Acceptable for operational visibility; a multi-instance deployment
  reports per-instance numbers.

### 3. Readiness probe — `GET /readyz` (closes M2)
- Replaced the placeholder storage check with a **real reachability probe**:
  `bucket(bucketId).exists()` bounded by a ~2s race so a slow/unreachable bucket cannot hang
  readiness. Returns `ok | error | not_configured`.
- **Database remains the only hard 503 gate** (holds traffic off until it recovers). A storage
  outage degrades to `status: "degraded"` while still returning **200** — most requests don't touch
  storage, so flapping the node off-rotation would do more harm than good while keeping the signal
  visible.
- Response shape unchanged (`status` + `checks.{database,storage}` are still plain strings), so
  existing consumers and the `health-errors` test keep passing.

### 4. Audit-log viewer — `GET /security/audit`
- New `audit.repository.ts` + `audit.service.ts`. Gated by `requirePermission("security","view")`.
- **Tenant-scoped** via `tenantScope(user, auditLogsTable.companyId)`: a company admin sees only
  their accessible companies (and never null-company platform rows); `platform_owner` sees all.
- Filters: `companyId` (platform), `userId`, `action`, `entityType`, `entityId`, `q` (ILIKE over
  user name / action / entity type), `startDate`, `endDate`, plus `page` / `pageSize`.
- `endDate` is **inclusive** — a date-only value is extended to end-of-day.
- Returns `{ items, total, page, pageSize }`; `metadata` carries before/after values where present.

### 5. Security alerts — `GET /security/alerts`
- Aggregates, over a `windowHours` window (clamped 1–720): `failedLogins`, `lockouts` (distinct
  emails reaching the failure threshold), `policyBlocks` (`login_policy_blocked` events), and
  `distinctFailedIps`.
- **Scoping:** `login_attempts` are attributed to a tenant via the `user_id` → accessible
  companies; attempts for unknown emails carry no `user_id` and are visible only to `platform_owner`.
  `security_events` are scoped by `companyId`.

### 6. Web surfacing
- Shared `AuditLogViewer` component (filters + table + before/after metadata dialog + pagination).
- **Platform → Activity:** tabs split into Activity Feed + Audit Log (with company column).
- **Admin → Security:** four alert summary cards (failed logins, lockouts, policy blocks, distinct
  IPs) + a new tenant-scoped Audit Log tab.

## Verification

- `pnpm --filter @workspace/api-server run typecheck` — clean.
- `pnpm --filter @workspace/web-app run typecheck` — clean.
- `test/monitoring.test.ts` (live integration suite) covers:
  - `/readyz` storage is a real `ok|error|not_configured` string; DB-200 invariant.
  - `/metrics` requires auth (401), forbids non-platform roles (403), returns the request + job
    snapshot for `platform_owner`.
  - `/security/audit` paginated envelope, action filter, and **cross-tenant isolation** (a company
    admin sees only their own tenant; two tenants' views never overlap).
  - `/security/alerts` aggregate shape and window clamping.
- Full pre-merge gate (`typecheck` + `test`) run against a freshly restarted api-server.

## Contract changes (additive only)

`lib/api-spec/openapi.yaml` gained paths `/metrics`, `/security/audit`, `/security/alerts` and
schemas `MetricsSnapshot`, `AuditLogEntry`, `AuditLogListResponse`, `SecurityAlerts`. Codegen was
re-run. No existing path, schema, or field was changed or removed.
