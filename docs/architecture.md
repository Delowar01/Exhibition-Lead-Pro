# Architecture Overview

_Card Scanner Pro — Stage 1 architecture review (current vs. recommended)._

This document describes the system as it exists today, grounded in the real
codebase, and notes where it already meets an enterprise bar versus what is
intentionally deferred to a later stage. It reflects the hardened server
foundation delivered in Stage 1 (centralized configuration, a global error
handler, and a consolidated health/readiness surface).

## 1. System at a glance

Card Scanner Pro is a pnpm-workspace monorepo with a contract-first backend and
multiple front-end clients sharing one generated API layer.

```
                        ┌──────────────────────────────┐
                        │   lib/api-spec/openapi.yaml   │  ← single source of truth
                        └───────────────┬──────────────┘
                          orval codegen │
                 ┌────────────────────┬─┴───────────────────┐
                 ▼                    ▼                      ▼
        lib/api-zod          lib/api-client-react      (server validation)
        (Zod schemas)        (React Query hooks)       (Zod, same schemas)
                 │                    │                      │
   ┌─────────────┴───────┐   ┌────────┴────────┐    ┌───────┴─────────┐
   ▼                     ▼   ▼                 ▼     ▼                 ▼
 artifacts/web-app   artifacts/mobile     artifacts/api-server ── lib/db (Drizzle)
 (React + Vite)      (Expo / RN)          (Express 5)            PostgreSQL
```

- **Clients** (`web-app`, `mobile`) never hand-write API calls or response types —
  they consume generated React Query hooks and Zod schemas.
- **The server** (`api-server`) validates inputs/outputs with the same Zod schemas
  generated from the same spec, so client and server cannot drift.
- **The database** is reached only through the `@workspace/db` package (Drizzle
  ORM + a shared connection pool).

## 2. Contract-first pipeline

The contract is authored once in [`lib/api-spec/openapi.yaml`](../lib/api-spec/openapi.yaml)
and everything else is generated from it via Orval
([`lib/api-spec/orval.config.ts`](../lib/api-spec/orval.config.ts)):

- `lib/api-zod` — Zod schemas for request/response validation.
- `lib/api-client-react` — React Query hooks plus a custom fetch wrapper.

Regenerate after any spec change with
`pnpm --filter @workspace/api-spec run codegen`. See the
[API Guide](api-guide.md) for the full workflow.

**Enterprise bar:** met. A single source of truth with generated clients and
shared validators is the gold standard for keeping multi-client APIs consistent.

## 3. Multi-tenant isolation

- `company_id` **is** the tenant boundary — there is no separate `tenant_id`.
- Every tenant-scoped read must go through `tenantScope(req.user, table.companyId)`
  (in `middlewares/requireAuth.ts`): it returns no filter for `platform_owner`
  and an `inArray(column, accessibleCompanies)` filter for everyone else. Scoping
  a read by `companyId` alone is unsafe — a null `companyId` would produce an
  unfiltered cross-tenant query.
- Foreign-key references on writes are validated with `refAccessible(...)`
  (in `lib/tenant.ts`) so a caller cannot point own-tenant rows at foreign records.
- Cross-tenant access returns **404** (not 403) to avoid leaking record existence.

**Enterprise bar:** met for the implemented surface. The isolation primitives are
centralized and consistently applied.

## 4. Authentication & authorization

- **Auth:** JWT (not session cookies), so the same API can serve the mobile
  client. `requireAuth` loads the **fresh** user row on every request (role,
  permissions, status) rather than trusting the JWT payload, and enforces the
  subscription lifecycle.
- **Role hierarchy:** `platform_owner` → `primary_admin` → `admin` → `employee`.
  `platform_owner` routes to `/platform`; everyone else to `/admin`.
- **Permissions:** `platform_owner`/`primary_admin` bypass permission checks;
  `admin`/`employee` are gated by an explicit `permissions` matrix
  (`module -> [actions]`) on **writes** only (reads stay open but tenant-scoped).
  Empty `{}` = deny-by-default on writes.
- **No role escalation:** a caller can never create or promote a user above their
  own rank (enforced on POST + PATCH `/users`).
- **Subscription lifecycle** (on `companies.status`): `suspended`/`expired`/lapsed
  `trial` block login (403); `cancelled` is read-only (writes 403, reads OK);
  `active`/valid `trial` get full access. Logic in `evaluateCompanyAccess`.

**Enterprise bar:** met for the implemented surface.

## 5. Audit & logging

- **Audit:** `audit_logs` is append-only (no delete route, no cascade FK).
  `auditMutations(module)` records one row per successful non-GET request;
  `writeAudit` handles explicit events (e.g. login). Guards must be **path-scoped**
  to a module base, because sub-routers mount path-less on a shared parent (see
  the router-guard note in [`replit.md`](../replit.md) gotchas).
- **Logging:** structured logging via `pino` / `pino-http`. Use `req.log` inside
  request handlers and the singleton `logger` elsewhere. **Never** use
  `console.log` in server code. The `Authorization` header is redacted in logs.

**Enterprise bar:** met.

## 6. Hardened server foundation (Stage 1)

Three cross-cutting hardening changes were landed without altering any business
logic, API contract, or schema:

- **Centralized configuration** — `artifacts/api-server/src/config.ts` is the
  single place that reads `process.env` or defines tunable constants (HTTP body
  limit, AI model + timeouts + token/thinking budgets, object-storage vars, Expo
  token, Replit domains). The required `SESSION_SECRET` is validated eagerly at
  module load (fail-fast at startup); `PORT` is validated lazily on access so the
  Express app stays importable without a `PORT` (e.g. in tests); object-storage
  values are validated lazily by their consumers, preserving prior semantics.
- **Global error handling** — `middlewares/errorHandler.ts` adds a typed
  `AppError`, a JSON `notFoundHandler` (404), and a unified `errorHandler`. The
  handler preserves framework-provided HTTP status codes (e.g. body-parser's 413
  for oversized bodies, 400 for malformed JSON) and emits the existing
  `{ error }` shape; 5xx/unknown errors get a generic message so internals never
  leak. It is registered after the router as an additive safety net — routes keep
  their own explicit status returns.
- **Health/readiness** — `GET /api/healthz` (liveness, unchanged `{status:"ok"}`)
  and `GET /api/readyz` (readiness: a `SELECT 1` DB probe + an object-storage
  configuration check; returns 503 when the DB is unreachable). Readiness
  "storage" currently means **configured**, not a live reachability probe.
- **Security headers** — `helmet` is enabled with CSP and the cross-origin
  resource/embedder policies **disabled on purpose**: this is a JSON + image API
  consumed cross-origin (open CORS) by the web and mobile clients, so CORP/COEP
  would block legitimate cross-origin image loads and CSP applies to HTML this
  server never serves. Remaining helmet defaults change no response bodies and
  reject no valid requests.

The Express middleware order is: `pino-http` → `helmet` → `cors` → body parsers
→ `/api` router → `notFoundHandler` → `errorHandler`.

## 7. Recommended next steps (deferred to Stage 2)

These are out of scope for Stage 1 (foundation only) and are captured in the
[Technical-Debt Register](tech-debt.md):

- **Service-layer extraction** — route handlers currently mix HTTP concerns with
  data access and business rules. Extracting a service layer per module would
  improve testability and reuse. Deferred to keep Stage 1 regression-free.
- **Zod request validation on all writes** — some write routes validate via manual
  destructuring rather than the generated Zod schemas (e.g. `POST /contacts` with
  `{}` can create an all-null record). Adopt the shared schemas on writes.
- **Server-side currency normalization in reports** — some report/pipeline totals
  are converted client-side from a capped list; a server-side normalization in
  `reports.ts` is the durable fix.
- **Readiness storage probe** — upgrade the storage check from "configured" to a
  real reachability probe if storage outages become a concern.

## 8. Summary scorecard

| Concern | Status |
|---|---|
| Contract-first pipeline | ✅ Meets bar |
| Multi-tenant isolation | ✅ Meets bar (implemented surface) |
| AuthN / AuthZ / role hierarchy | ✅ Meets bar |
| Audit (append-only) | ✅ Meets bar |
| Structured logging | ✅ Meets bar |
| Centralized config | ✅ Delivered (Stage 1) |
| Global error handling | ✅ Delivered (Stage 1) |
| Health + readiness | ✅ Delivered (Stage 1) |
| Security headers | ✅ Delivered (Stage 1) |
| Service-layer extraction | ⏭ Deferred (Stage 2) |
| Zod validation on all writes | ⏭ Deferred (Stage 2) |
