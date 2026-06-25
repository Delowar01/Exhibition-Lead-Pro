# Enterprise Privacy & Data Governance Audit
## Lead Capture Pro — Elite Marcom Platform

**Audit date:** June 24, 2026
**Auditor:** Automated code inspection + review
**Scope:** Full platform — API server, repository layer, service layer, web UI, background jobs,
logging, notifications, audit trail.

---

## Executive Summary

The platform has a well-designed **UI layer** and **tenant isolation for company users**.
However, there is one pervasive, critical architectural gap: the `platform_owner` role is
explicitly carved out of every tenant-isolation enforcement point in the codebase, leaving
the full customer data API reachable without restriction by the platform operator.

The customer-facing (Admin portal) UI is appropriately scoped and there is no platform-portal
page that browses CRM data. The risk lives entirely at the **API layer** — an operator using
the platform_owner JWT token can call any customer data endpoint and receive unfiltered
cross-tenant results.

**Overall verdict: FAIL → see §7**

---

## 1. Existing Protections

These controls are correctly implemented and functioning.

### 1.1 Tenant isolation for company users
Every list/read query routes through `tenantScope(user, table.companyId)` in
`middlewares/requireAuth.ts`. For non-platform users this produces an `inArray(column,
accessibleCompanies)` SQL condition, enforced at the repository level by construction. A
company admin can never see another company's data regardless of what they pass as a query
parameter. The helpers `activeScope` and `tenantOnly` in `repositories/base.ts` compose this
consistently across every table.

### 1.2 Cross-tenant FK injection prevention
`refAccessible(user, table, id)` in `lib/tenant.ts` validates every foreign-key reference
(contact → event, contact → assignee) against the caller's `accessibleCompanies` before a
write is committed. This prevents a company admin from pointing their own records at another
tenant's entities and leaking metadata through enrichment responses.

### 1.3 Platform portal UI — no CRM data surfaced
The platform portal (`/platform/*`) was fully reviewed. Every page shows only operational,
aggregate, or metadata:
- **Dashboard**: total companies, total users, MRR/ARR, total leads (a single number), AI
  requests.
- **Companies**: company name, plan, status, user count, scan count (a number). No contact
  records, no pipeline data.
- **Users** (platform): name, email, role, company name, join date. No contact notes, leads,
  or CRM records.
- **Subscriptions**: billing and plan-level revenue aggregates.
- **Activity / Audit Log**: action descriptions (e.g., "Contact created") and actor identity.
  The content of the CRM record is never returned — only the fact that an action occurred.

### 1.4 Logging — no sensitive customer data written to logs
`pino-http` is configured with explicit redaction of `Authorization`, `Cookie`, and
`Set-Cookie` headers. Request body content is never logged (only method, URL with query
stripped, and status code). Base64 card images, OCR text, AI results, contact notes, and
lead pipeline data are not written to the log stream. Only operational errors (e.g., "AI
request failed") are logged, without payload content.

### 1.5 Authentication hardening
All implemented in Phase 2.1:
- Rotating refresh tokens with server-side session tracking; logout/terminate is immediately
  effective because `requireAuth` re-validates the session row on every request.
- TOTP MFA with encrypted secrets, single-use backup codes, and company-required-MFA policy.
- Per-account lockout and per-IP rate limiting (failures only, skips successful logins to
  avoid false positives behind NAT).
- CSRF protection for cookie-based refresh flow.
- Password policy on register and password-change.
- `sessions.prevRefreshTokenHash` prevents the unauthenticated forced-logout DoS (proven
  replay required to revoke a token family).

### 1.6 RBAC and role escalation prevention
`requirePermission` enforces a permission matrix for `admin`/`employee` roles.
`setUserRoles` prevents assigning any role with permissions that exceed the caller's own
effective permissions, so neither the role system nor the invitation system can be used for
privilege escalation.

### 1.7 Notifications are user-scoped
The notifications repository filters exclusively by `userId`. A user cannot read another
user's notifications regardless of company membership. Invitation notifications correctly
pass `companyId` for context but access is still controlled by `userId`.

### 1.8 Background jobs respect job-payload scope
The in-process job queue (Phase 2.6) operates on the payload provided at enqueue time.
Email delivery workers receive only the specific recipient/message payload; they do not query
the database. Because payloads are built inside authenticated request handlers (where tenant
scope is already enforced), the data delivered to the worker is already tenant-bounded.

### 1.9 Input validation on all write endpoints
All POST/PATCH endpoints use `validateBody` (Zod) middleware, closing the H1 vulnerability
that was addressed in Phase 2.7. Empty or structurally invalid bodies are rejected with
a 400 before they reach any business logic.

### 1.10 Audit trail
The `audit_logs` table is append-only (no delete route, no cascade FK). The `auditMutations`
middleware records one row per successful non-GET request with caller identity and tenant
context. Platform-owner actions (company create/suspend, subscription modify, security
configuration, user disable) are audited.

---

## 2. Gaps and Missing Protections

### GAP-01 — CRITICAL
**Platform_owner bypasses tenant isolation on every customer data endpoint**

**Root cause — two interlocking bypasses in `middlewares/requireAuth.ts`:**

```typescript
// BYPASS 1: tenantScope (line ~36)
export function tenantScope(user: AuthUser | undefined, column: PgColumn): SQL | undefined {
  if (!user || user.role === "platform_owner") return undefined;  // ← NO WHERE clause
  return inArray(column, user.accessibleCompanies);
}

// BYPASS 2: requirePermission (line ~215)
if (req.user.role === "platform_owner" || req.user.role === "primary_admin") {
  next();  // ← skip the permission check entirely
  return;
}
```

**Effect on every customer data endpoint:**

| Endpoint | What platform_owner receives |
|---|---|
| `GET /contacts` | All contacts across ALL companies |
| `GET /contacts/:id` | Any customer's contact record |
| `GET /contacts/duplicates` | Deduplicated cross-tenant contact list |
| `POST /contacts/:id/enrich` | Triggers AI enrichment on any customer contact |
| `GET /leads` | All leads across ALL companies |
| `GET /leads/pipeline` | Aggregated pipeline value across all tenants |
| `GET /leads/:id` | Any customer's lead detail |
| `GET /scans` | All business card scans across ALL companies |
| `GET /scans/:id` | Any customer's scan record (incl. OCR result) |
| `GET /scans/:id/image` | Downloads the actual business card image |
| `GET /events` | All events across ALL companies |
| `GET /events/:id/stats` | Any customer's event statistics |
| `GET /reports/admin-dashboard` | Platform-wide CRM dashboard data |
| `GET /reports/leads-by-event` | All events with lead/won counts across ALL tenants |
| `GET /reports/team-performance` | All team members across ALL tenants |
| `GET /reports/lead-intelligence` | Hot leads, temperature breakdown, ALL tenants |
| `GET /reports/mobile-dashboard` | Full KPI set, ALL tenants |
| `GET /reports/event?eventId=X` | Any customer's event report |
| `GET /reports/team-member?userId=X` | Any customer's team-member report |

**Write and delete access is also unrestricted:**

| Endpoint | Risk |
|---|---|
| `PATCH /contacts/:id` | Modify any customer's contact |
| `DELETE /contacts/:id` | Delete any customer's contact |
| `POST /contacts/merge` | Merge any customer's contacts |
| `PATCH /leads/:id` | Modify any customer's lead |
| `DELETE /leads/:id` | Delete any customer's lead |
| `PATCH /events/:id` | Modify any customer's event |
| `DELETE /events/:id` | Delete any customer's event |

**This gap is present even if the platform portal UI never surfaces these pages**, because the
platform_owner JWT token can be used directly against the REST API.

---

### GAP-02 — HIGH
**`GET /reports/*` has no role-level guard at all**

Unlike contacts, leads, and scans (which have `requirePermission` on write endpoints), the
reports router applies only `requireAuth`. There is no `requirePermission("reports", ...)` or
role check of any kind:

```typescript
// routes/reports.ts — top of file
router.use(requireAuth);
// No requirePermission, no requireRole
```

For company users, the tenant scope limits what they see. For platform_owner, it is a fully
open door to all customer analytics.

**Impact:** Even if GAP-01 is addressed with a `requireTenantUser` guard on contacts/leads/
scans/events, reports will remain unprotected without a separate fix.

---

### GAP-03 — HIGH
**Platform_owner can download customer business card images**

`GET /scans/:id/image` streams the stored object-storage image to the caller. There is no
guard beyond `requireAuth`. A platform_owner knowing (or discovering) any `scanId` can
download the physical business card image. This is likely the most sensitive single piece
of customer data in the system.

---

### GAP-04 — MEDIUM
**Platform_owner can access full user PII and login history for any user across all tenants**

`GET /users` (with no `companyId` filter) returns all users across all companies. `GET
/users/:id/login-history` returns the login history (timestamps, IPs, device info) of any
user across all tenants. While user management is a legitimate platform function, login-level
PII for all tenants' users goes beyond the operational scope defined in the privacy policy.

---

### GAP-05 — MEDIUM
**No `requirePermission` guard on reports routes means company users with denied permissions can also access all reports**

The report routes have no `requirePermission` check. A company `employee` with all
permissions denied (empty `{}` permissions matrix) can still call `GET /reports/admin-
dashboard` and receive their company's full CRM analytics. This is a customer-side permission
gap, not strictly a platform-isolation gap, but it should be addressed alongside GAP-02.

---

### GAP-06 — MEDIUM
**Follow-up scheduler runs a global query without per-tenant boundary enforcement**

`lib/followup-scheduler.ts` scans the `contactsTable` for `followUpDate <= today` across
all companies in one query, then groups by `assignedToId` and dispatches notifications.
Today this is safe because it only notifies the assigned user. However, any future
modification to this function (e.g., logging contact data, passing records to a new job
type) runs without a tenant boundary. A bug or future change here could cross tenant lines
without the developer noticing, because there is no structural guard.

---

### GAP-07 — LOW
**Platform_owner can trigger AI enrichment on any customer contact (`POST /contacts/:id/enrich`)**

AI enrichment makes external calls with the contact's personal data (name, title, company,
email) and writes enrichment results (industry, seniority, talking points) back to the
record. A platform_owner can trigger this on any contact in any tenant, which both exposes
the contact's PII to the AI provider and modifies customer data.

---

### GAP-08 — LOW
**No database-level row security (PostgreSQL RLS)**

All tenant isolation is enforced at the application layer. PostgreSQL has no row-level
security policies. A developer with direct database access (or a SQL injection vulnerability)
can read any row without tenant filtering. This is the accepted industry pattern for
application-managed multi-tenancy, and Replit's managed PostgreSQL does not expose direct
psql access to end users. However, it means the application layer is the only enforcement
boundary.

---

### GAP-09 — LOW (Observation)**
**Activity descriptions in `activity_logs` include action context**

`platform.repository.ts:recentActivity()` returns `activity_logs` rows whose `description`
field may contain values like "Contact imported from scan" or "Lead converted". These
descriptions identify the fact and actor of a CRM action, though not the content of the
record. This is appropriate for the platform-owner audit/monitoring context but should be
considered when evaluating what metadata Elite Marcom can routinely observe.

---

## 3. Risk Assessment

| ID | Finding | Severity | Likelihood | Impact |
|---|---|---|---|---|
| GAP-01 | Platform_owner bypasses all customer data endpoint guards | **Critical** | Certain (by design) | Full CRM data exposure across all tenants |
| GAP-02 | Reports router has no role guard | **High** | Certain | All customer analytics visible to platform_owner |
| GAP-03 | Business card images downloadable by platform_owner | **High** | Certain if scan ID known | Physical PII (business cards) accessible |
| GAP-04 | All user PII and login history cross-tenant accessible | **Medium** | Certain | User PII, login history, IPs across all tenants |
| GAP-05 | Company users bypass reports permission | **Medium** | Certain | Employees with denied perms see full analytics |
| GAP-06 | Follow-up scheduler runs without tenant boundary | **Medium** | Unlikely now, risk on future change | Potential future cross-tenant data exposure |
| GAP-07 | AI enrichment triggerable by platform_owner on any contact | **Low** | Requires deliberate API call | Contact PII sent to AI provider; record modified |
| GAP-08 | No PostgreSQL RLS | **Low** | Requires DB access (not exposed) | Moot without app-bypass vector |
| GAP-09 | Activity log descriptions include CRM action context | **Low** | Routine platform operation | Metadata exposure (no record content) |

---

## 4. Recommendations

### R1 — Introduce a `requireTenantUser` middleware
Create a single middleware that rejects `platform_owner` with a 403 when called on customer
data routes. This is the simplest, most surgical fix for GAP-01 through GAP-03:

```typescript
// Proposed: middlewares/requireTenantUser.ts
export const requireTenantUser: RequestHandler = (req, res, next) => {
  if (!req.user || req.user.role === "platform_owner") {
    res.status(403).json({ error: "Platform operators cannot access tenant CRM data" });
    return;
  }
  next();
};
```

Apply this middleware as the first guard (after `requireAuth`) to:
- All routes in `routes/contacts.ts`
- All routes in `routes/leads.ts`
- All routes in `routes/scans.ts`
- All routes in `routes/events.ts`
- All routes in `routes/reports.ts`

This preserves the existing `tenantScope` logic (which continues to enforce tenant isolation
for company users) and adds the missing layer that blocks platform_owner.

### R2 — Add `requirePermission("reports", "view")` to the reports router
Address GAP-02 and GAP-05 independently of R1. Add to `routes/reports.ts`:
```typescript
router.use(requireAuth);
router.use(requirePermission("reports", "view"));
```
`platform_owner` and `primary_admin` still bypass `requirePermission`, so this serves
double duty as a guard for GAP-05 (employee with denied perms) without breaking any
existing access for intended users.

### R3 — Scope platform user-management to operational fields
For GAP-04: if the user-management endpoint is intended for operational use (enabling/
disabling accounts), consider a dedicated platform endpoint that returns operational fields
only (id, email, role, status, company, join date) and explicitly excludes login history
from the cross-tenant platform view.

### R4 — Add a tenant boundary to the follow-up scheduler
For GAP-06: add an explicit `WHERE companyId IS NOT NULL` and tenant grouping to the
scheduler query, or process contacts via a query scoped per active company. This makes
the function structurally safe against future modification.

### R5 — Design a formal "support access" mechanism (future)
If Elite Marcom legitimately needs to debug customer data for support purposes, implement a
deliberate, audited break-glass mechanism: a time-bounded support token issued by a platform
administrator, scoped to a single `companyId`, logged on every use, and visible to the
tenant in their audit log. This gives the capability where it is genuinely needed while
maintaining the principle that routine platform operation never touches customer CRM data.

---

## 5. Implementation Plan

> Do not implement until the audit findings have been reviewed and approved.

### Phase 1 — Critical remediation (1–2 days, no schema changes)

**P1-A: Create `requireTenantUser` middleware and apply to all customer routes**
- New file: `artifacts/api-server/src/middlewares/requireTenantUser.ts`
- Apply to `routes/contacts.ts`, `routes/leads.ts`, `routes/scans.ts`, `routes/events.ts`,
  `routes/reports.ts` (router-level, before any other middleware on each file)
- Add integration tests asserting platform_owner receives 403 on `GET /contacts`,
  `GET /leads`, `GET /scans`, `GET /reports/admin-dashboard`
- No schema change, no contract change (403 is already a valid response for all these routes)

**P1-B: Add `requirePermission("reports", "view")` to the reports router**
- One-line change to `routes/reports.ts`
- Addresses both GAP-02 and GAP-05
- Add tests asserting an employee with empty permissions cannot access reports

### Phase 2 — Medium severity (1 day)

**P2-A: Scope platform user list to operational fields**
- Create or extend a platform-specific user-list endpoint that returns only operational
  fields (no login-history linkage at the platform level)
- Or: add a `platform_owner` exclusion to `GET /users/:id/login-history`

**P2-B: Add tenant grouping to the follow-up scheduler**
- Modify `lib/followup-scheduler.ts` to either process per-company or add an explicit
  `notNull(contactsTable.companyId)` structural guard

### Phase 3 — Long-term (design + implementation sprint)

**P3-A: Break-glass support access mechanism**
- Design: scoped, time-bounded, audited support token
- Logged on every use with the affected tenant notified
- Makes "support access" a deliberate, traceable act rather than a structural capability

**P3-B: Consider PostgreSQL RLS for defense-in-depth** (optional)
- Add RLS policies as a second enforcement layer
- Higher effort; most appropriate when the platform operates at a scale where defense-in-depth
  at the DB layer is mandated by compliance requirements (SOC 2, ISO 27001)

---

## 6. Scope Confirmation — Items Verified Clean

| Audit area | Result |
|---|---|
| Authentication (JWT, sessions, MFA, lockout) | ✅ Clean |
| Tenant isolation for company users | ✅ Clean |
| Cross-tenant FK injection prevention | ✅ Clean |
| Platform portal UI — no CRM data surfaced | ✅ Clean |
| Customer portal — no cross-tenant leakage | ✅ Clean |
| Request/response logging — no sensitive data | ✅ Clean |
| Auth credential logging (tokens, passwords) | ✅ Redacted |
| Notifications — user-scoped | ✅ Clean |
| Background job email workers — payload-scoped | ✅ Clean |
| Input validation on writes | ✅ Clean |
| Role escalation prevention | ✅ Clean |
| Audit trail — append-only, complete | ✅ Clean |
| CSRF on cookie refresh flow | ✅ Clean |
| Rate limiting (per-IP failures only) | ✅ Clean |
| Debug / dev endpoints exposed | ✅ None found |
| Subscription lifecycle enforcement | ✅ Clean |

---

## 7. Final Compliance Statement

> **"Does Lead Capture Pro currently satisfy the Standard Enterprise SaaS Privacy Model where
> Elite Marcom can fully operate the platform without having routine access to customer
> business data?"**

### Verdict: **FAIL**

**Justification:**

The platform UI is well-designed and does not surface customer CRM data in the platform
portal — a platform_owner logging into the web application sees only operational and
aggregate information. That layer passes.

However, the API layer — which is the authoritative definition of what the platform is
capable of — contains no guard preventing the platform_owner JWT from calling customer data
endpoints. The `tenantScope` function is explicitly coded to return no SQL filter for
`platform_owner`, and `requirePermission` is explicitly coded to skip all permission checks
for `platform_owner`. This is a deliberate "super-admin" design choice from the initial
build that was appropriate for development and early-stage operation, but does not meet the
Standard Enterprise SaaS Privacy Model.

A platform_owner using the Elite Marcom credentials can today:
- Retrieve every contact record, lead record, scan record, and event record across every
  tenant company via standard REST calls.
- Download the actual business card images from every scan.
- View AI-generated enrichment results (industry, seniority, talking points) for any
  customer contact.
- Read full CRM analytics and pipeline reports for any tenant.
- Modify or delete any customer's CRM data.

These capabilities violate the privacy policy requirement that Platform Owner must not browse
customer contacts, search customer leads, view customer pipelines, open customer reports, read
customer notes, view business cards, or download attachments.

**Path to PASS WITH RECOMMENDATIONS:** Implementing Phase 1 of the remediation plan
(GAP-01 through GAP-03 — approximately 1–2 days, no schema or contract changes) closes the
critical and high findings. After Phase 1, the platform would satisfy the Standard Enterprise
SaaS Privacy Model with a recommendation to implement the formal break-glass support access
mechanism (Phase 3) for the rare cases where customer-data debugging is legitimately required.

---

*Report location: `docs/reports/ENTERPRISE_PRIVACY_AUDIT.md`*
*All findings are derived from static code inspection of the live codebase. No penetration
testing or runtime exploitation was performed.*

---

## 8. Remediation Status (post-audit)

All API-layer findings have been remediated across two stages. No schema, contract, or UI
changes were required; every fix reuses existing middleware (`requireTenantUser`,
`requirePermission`) and is covered by regression tests.

| Gap | Severity | Status | Fix |
|---|---|---|---|
| GAP-01 (platform_owner reaches customer CRM endpoints) | Critical | ✅ Fixed (Stage 2.11A) | `requireTenantUser` path-scoped on contacts/leads/events/scans/reports/follow-ups/meetings/tasks |
| GAP-02 (reports reachable by platform_owner) | High | ✅ Fixed (2.11A + 2.11B) | `requireTenantUser` blocks platform_owner; `requirePermission("reports","view")` gates company users |
| GAP-03 (cross-tenant write/delete) | High | ✅ Fixed (Stage 2.11A) | covered by `requireTenantUser` on mutating customer routers |
| GAP-04 (platform_owner sees login/IP/device forensics) | Medium | ✅ Fixed (Stage 2.11B) | `requireTenantUser` on `GET /users/:id/login-history`; operational user mgmt retained |
| GAP-05 (company user w/ denied perms reads full analytics) | Medium | ✅ Fixed (Stage 2.11B) | `requirePermission("reports","view")` on the reports router (R2). Reports policy: platform_owner blocked; primary_admin bypass; `admin` keeps `reports:view` by default (seed + one-time backfill of existing admins, revocable via Role & Permission Management); `employee` has no reports access unless explicitly granted |
| GAP-06 (follow-up scheduler global cross-tenant sweep) | Low | ✅ Fixed (Stage 2.11B) | explicit `companyId IS NOT NULL` guard + strict `(companyId, assignedToId)` grouping (R4) |
| GAP-07 (platform_owner can trigger AI on customer data) | Medium | ✅ Fixed (Stage 2.11A) | every AI trigger (OCR via `POST /scans`, scoring via `POST /contacts`, enrichment via `POST /contacts/:id/enrich`) routes through routers already blocked by `requireTenantUser`; verified by tests |

**AI protection summary (GAP-07):** the three AI entry points are `extractCardData` (card OCR,
invoked from `POST /scans`), `scoreLead` (lead scoring, invoked from `POST /contacts`), and
`enrichContact` (industry/seniority/talking-points, invoked from `POST /contacts/:id/enrich`).
All three live on the contacts/scans routers, which carry router-level `requireTenantUser`.
A `platform_owner` token therefore receives HTTP 403 before any AI model is called — confirmed
by `test/governance-2_11b.test.ts`. No standalone AI route exists. A future, deliberately-audited
"support access" flow (recommendation R5 / Phase 3 break-glass) would be the only sanctioned way
to re-enable platform-side AI on customer data.

**Recommendations status:** R2 (reports permission) and R4 (scheduler tenant boundary)
implemented. R3 (platform_owner exclusion from login-history) implemented via the minimal
`requireTenantUser` option. R5 (break-glass support access) remains an intentional future design
item (Phase 3) — not required for the Standard Enterprise SaaS Privacy Model to pass.

**Revised verdict:** with Stages 2.11A + 2.11B merged, the platform satisfies the Standard
Enterprise SaaS Privacy Model — Elite Marcom can fully operate the platform without routine
access to customer business data. The only remaining recommendation is the formal break-glass
mechanism for the rare, audited cases where customer-data debugging is genuinely required.
