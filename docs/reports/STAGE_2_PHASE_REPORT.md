# Card Scanner Pro — Stage 2 Report (Phases 2.1 – 2.10)

**Date:** June 24, 2026
**Theme:** Turn a working product into an enterprise-grade platform — security, clean
architecture, organization management, communications, background processing, a
standardized API, test coverage, performance, and observability.

**Ground rule for the whole stage:** every change was **additive and backward-compatible**.
No existing API response shape was broken, no product features were removed, and the web +
mobile clients kept working throughout. Each phase shipped behind a green pre-merge gate
(`typecheck` + full integration `test` suite).

---

## At a glance

| Phase | Focus | Headline result |
|---|---|---|
| 2.1 | Auth & Security Hardening | Rotating refresh tokens, MFA (TOTP + backup codes), brute-force lockout, password policy |
| 2.2 | Service-layer refactor | Business logic extracted from routes — zero behavior change |
| 2.3 | Repository / data-access layer | All DB queries isolated; tenant scoping enforced by construction; soft-delete groundwork |
| 2.4 | Organization, Users, custom-role RBAC | Full user lifecycle + custom roles + Security Center |
| 2.5 | Email & Notifications | Password reset, email verification, invitations, in-app + email notifications |
| 2.6 | Background Jobs & Queue | Async email + recurring maintenance with retries and dead-lettering |
| 2.7 | API Standardization & Versioning | `/api/v1`, unified errors, request IDs, validated writes, standard pagination |
| 2.8 | Testing Expansion | Pure unit tests + audit-trail tests; pre-merge gate formalized |
| 2.9 | Performance Optimization | Indexes, N+1 elimination, server-side currency normalization, response caching |
| 2.10 | Monitoring & Observability | Real readiness probe, metrics endpoint, audit-log viewer, security alerts |

**Test growth across the stage:** 14 → 19 → 26 → 41 → 66 → 74 → ~99 → 124 → 136 → **148 tests**,
all green at each gate.

---

## Phase 2.1 — Auth & Security Hardening

**What was built**
- **Rotating refresh tokens** with server-side sessions; multi-device session list + the
  ability to terminate sessions. Logout/terminate takes effect immediately because
  `requireAuth` validates the session each request. Legacy mobile tokens still work.
- **Multi-factor authentication (MFA):** TOTP enrollment with an AES-256-GCM–encrypted
  secret, hashed single-use backup codes, "remember this device," and a company-required
  MFA policy hook.
- **Brute-force protection:** per-account lockout, per-IP rate limiting, and login-attempt
  logging. CSRF protection for the cookie refresh flow. Password policy on register /
  change-password.
- **Web UI:** remember-me, password visibility toggle, strength meter, MFA challenge step,
  an Active Sessions screen, and MFA setup in Settings.

**Notable results (security fixes caught in review)**
- Closed an **unauthenticated forced-logout DoS**: refresh-token rotation now keys on an
  unguessable family ID and only revokes a session family on a *proven* token replay, not on
  any mismatch.
- Closed a **company-required-MFA bypass**: unenrolled users at MFA-mandated companies no
  longer receive a working session — they're forced into enrollment.
- The per-IP login limiter now counts only *failed* attempts (avoids false lockouts behind
  shared IPs / NAT).

**Verification:** dedicated `auth-security.test.ts` covering the full login → refresh →
replay → revocation path, sessions, lockout, and MFA flows. Suite green (14 tests).

---

## Phase 2.2 — Service-Layer Refactoring

**What was built**
- Extracted a **service layer** beneath the Express routes for all 10 modules (auth, users,
  companies, contacts, leads, events, scans, subscriptions, reports, platform). Routes became
  thin (parse request → call service → shape response); services own the business logic.
- Standardized 4xx handling on `AppError`; Express 5 forwards async errors to one global
  handler, so per-handler try/catch was removed without changing the error shape.

**Notable results**
- This was a **pure, zero-behavior-change refactor** — the existing integration suite passed
  with *no assertion edits*, which is the proof that nothing observable changed.
- Review caught one regression (a dropped "last login" timestamp write) and it was restored.

**Verification:** 15 existing tests green unchanged + 4 new service unit tests = 19 total.

---

## Phase 2.3 — Repository / Data-Access Layer

**What was built**
- A **repository layer** (one module per aggregate) that now owns *all* database queries;
  services contain zero direct DB access.
- **Tenant scoping enforced by construction:** shared base helpers make it structurally
  impossible to run a read scoped by company ID alone (the classic cross-tenant leak).
- **Soft-delete groundwork** for contacts/leads/events: delete now stamps a `deletedAt` and
  replicates the previous cascade behavior inside a transaction; all reads exclude deleted
  rows by default.

**Notable results**
- Another **zero-behavior-change** refactor — existing 19 tests green with no edits.
- Review fix: the background AI scorer now skips rows soft-deleted mid-flight.

**Verification:** 19 existing tests unchanged + 7 new soft-delete / isolation tests = 26 total.

---

## Phase 2.4 — Organization, Users, Custom-Role RBAC, Profile & Security Center

**What was built**
- **Organization management** (company profile/settings) and a **full user lifecycle**:
  invite, enable/disable, soft-delete, force-logout, reset password, login history, and role
  assignment.
- **Custom-role RBAC:** a code-defined permission catalog plus assignable custom roles.
  Effective permissions = legacy per-user permissions ∪ role grants, merged centrally so the
  existing permission checks didn't change.
- **Security Center:** configurable policies (blocked domains/IPs/countries, password &
  session rules) enforced at login, plus a security-events log. **Self-service Profile** with
  activity history.
- Web pages: Organization, Profile, Security, Roles, and Team (full user admin).

**Notable results**
- Review caught and fixed a **privilege-escalation hole**: a user can no longer grant a role
  whose permissions exceed their own.

**Verification:** 15 new tests (41 total, all green), including a dedicated escalation test.

---

## Phase 2.5 — Email & Notification Infrastructure

**What was built**
- **Provider-agnostic email** (SMTP via nodemailer) that degrades gracefully when no provider
  is configured — nothing crashes if email isn't set up.
- **Email auth flows:** forgot/reset password, email verification, resend.
- **Invitation system:** create/list/resend/cancel + public accept/reject with expiry.
- **Notifications:** 8 categories, in-app + email, unread counts, mark-read, preferences —
  with web UI (public auth pages, a notifications page, bell badge, invite-by-email dialog).

**Notable results**
- Review closed a **cross-tenant role-binding + escalation back door** in invitations (role
  IDs are now scoped to the target company *and* permission-subset checked).

**Verification:** invitation lifecycle, notifications CRUD, graceful no-SMTP path, and two
escalation regression tests. Suite 66 total, green.

---

## Phase 2.6 — Background Jobs & Queue System

**What was built**
- A **provider-agnostic job queue** with bounded concurrency, exponential-backoff retries,
  and dead-lettering when retries are exhausted. The driver is swappable (in-process default;
  a single seam for Redis/BullMQ later).
- **Async email delivery** routed through the queue (with a synchronous fallback switch).
- A **scheduler + idempotent maintenance tasks:** token cleanup, stale-session cleanup,
  invitation expiry, notification retention, and opt-in audit-log retention.
- All tunables (concurrency, attempts, backoff, cadences) are config-driven and clamped to
  safe minimums so a misconfiguration can't stall the queue.

**Notable results**
- The email worker **soft-skips** when no provider is configured (no retry storm) but
  **retries** on real transport errors — the right behavior for each failure mode.

**Verification:** queue enqueue/consume, retry-then-succeed, dead-lettering, concurrency
ceiling, and live-DB maintenance correctness/idempotency. Suite 74 total, green.

---

## Phase 2.7 — API Standardization & Versioning

**What was built**
- **Versioning:** canonical `/api/v1` mount alongside legacy `/api` (which now returns a
  Deprecation header pointing to v1).
- **Input validation on every write endpoint** (Zod), rejecting empty/junk bodies with a
  standardized 400.
- **Unified error envelope** + an `X-Request-Id` header on every response for traceability.
- **Standardized list contract** (page/pageSize/sort/order/search with caps) across
  collections — made **opt-in** so existing clients that send no params still get the full set.

**Notable results**
- Review fix: broadened auth cookie paths so cookie-based refresh/logout work on both the
  legacy and versioned routes.

**Verification:** pagination, versioned-auth cookie scoping, and validation tests. Full suite
green (~99 tests across standardization + main + auth).

---

## Phase 2.8 — Testing Expansion

**What was built**
- **Pure unit tests** (no DB/API) for the list-query parser, RBAC helpers, crypto round-trips,
  and MFA helpers.
- **Audit-trail tests** proving writes are recorded with the right caller/tenant attribution,
  reads and rejected writes are *not* audited, and login is recorded.
- Formalized the **pre-merge gate**: `typecheck` + `test` registered as required checks, with
  the operational gotcha (restart the server between back-to-back full runs) documented.

**Notable results**
- A clean full run was established as the merge bar: **124 tests across 11 files**, green.

**Verification:** the suite itself is the deliverable for this phase.

---

## Phase 2.9 — Performance Optimization

**What was built**
- **Database indexes** across all hot tables.
- **N+1 query elimination** in contacts, leads (list + pipeline), and reports — same output
  shapes, far fewer queries (batched/grouped lookups).
- **Server-side currency normalization to USD** before summing, fixing cross-currency totals
  on pipeline and report surfaces (closed a real correctness bug, not just speed).
- **Response compression** + a short-TTL (30s) in-memory cache for expensive report reads,
  auto-invalidated on any write.

**Notable results**
- Also fixed a pre-existing **intermittent test flake** in backup-code generation that was
  destabilizing the gate.

**Verification:** currency unit tests (incl. mixed-currency baskets), report-shape parity,
and cache hit/miss + bust-on-write tests. Full suite green (136 tests). Architect review: PASS.

---

## Phase 2.10 — Monitoring & Observability

**What was built**
- **Structured logging enrichment:** every request log now carries the user ID and company ID
  for per-user / per-tenant correlation.
- **Metrics endpoint** (`GET /metrics`, platform-owner only): request volume, latency
  (avg/max), error rate, uptime, and job-queue stats.
- **Real readiness probe** (`GET /readyz`): replaced a placeholder with an actual
  object-storage reachability check (with a 2s timeout). The database stays the only hard
  "not ready" gate; a storage blip degrades the status but keeps serving traffic. *This closed
  a tracked technical-debt item.*
- **Audit-log viewer** (`GET /security/audit`): searchable and filterable (org, user, action,
  entity type, entity ID, free-text, date range), strictly tenant-scoped, with a before/after
  detail view.
- **Security alerts** (`GET /security/alerts`): failed logins, lockouts, policy blocks, and
  distinct attacking IPs over a time window.
- **Web surfacing:** Platform → Activity (Feed + Audit tabs); Admin → Security (alert summary
  cards + a tenant-scoped Audit Log tab).

**Notable results**
- Tenant isolation is enforced server-side on both new read endpoints — a company admin can
  only ever see their own tenant's audit rows and alerts; filters can only narrow, never widen.

**Verification:** `monitoring.test.ts` — readiness shape + DB-200 invariant, metrics auth/role
gating + shape, audit pagination/filtering + **cross-tenant isolation**, and alert shape /
window clamping / non-widening scope. Full suite green (**148 tests**). Architect review:
APPROVED.

---

## Where the records live

- **This report:** `docs/reports/STAGE_2_PHASE_REPORT.md`
- **Phase 2.10 deep dive:** `docs/reports/STAGE_2_DEFINITION_OF_DONE.md`
- **QA / E2E / release records:** `docs/reports/` (`QA_REPORT.md`, `E2E_VERIFICATION.md`,
  `PRODUCTION_RELEASE_CHECKLIST.md`)
- **Architecture & technical-debt register:** `docs/` (`architecture.md`, `tech-debt.md`)
- Each phase corresponds to a commit on `main` (`Phase 2.1` … `Phase 2.10`).

## Open / deferred follow-ups noted during the stage

- Browser/OS and explicit "result" fields are **not** captured in the audit trail today (only
  IP + a metadata blob) — would require a schema addition if mandatory.
- `acceptInvitation` runs sequentially rather than in a single transaction (flagged as low,
  operational-consistency risk).
- Background jobs are in-process (die with the process by design); a durable driver
  (Redis/BullMQ) is the documented upgrade path.
- Metrics counters are per-process and reset on restart; a metrics backend would be needed for
  fleet-wide aggregation.
