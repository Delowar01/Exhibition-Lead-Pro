# API Guide

_The contract-first workflow, authentication, and the standardized error shape._

## 1. Contract-first workflow

The API is **contract-first**: the OpenAPI document is the source of truth, and
the validators and clients are generated from it. Never hand-write request/response
types or client fetch logic.

```
lib/api-spec/openapi.yaml          ← author the contract here
        │  pnpm --filter @workspace/api-spec run codegen   (Orval)
        ├──► lib/api-zod              Zod schemas (server + client validation)
        └──► lib/api-client-react     React Query hooks + fetch wrapper
```

### Making an API change

1. Edit [`lib/api-spec/openapi.yaml`](../lib/api-spec/openapi.yaml) — add/modify the
   path, parameters, request body, and response schemas.
2. Run codegen:
   ```bash
   pnpm --filter @workspace/api-spec run codegen
   ```
3. Implement the route in `artifacts/api-server/src/routes/<module>.ts`, validating
   the request and response with the generated Zod schemas from `@workspace/api-zod`.
4. Consume the generated React Query hook from `@workspace/api-client-react` in the
   web/mobile clients.
5. `pnpm run typecheck`, then run the integration tests.

> Do not change the OpenAPI `info.title` — it controls generated filenames.
> Do not edit generated files by hand; re-run codegen instead.

### Why it matters

Because the server validates with the **same** schemas the clients are generated
from, the client and server cannot drift. A breaking contract change surfaces as a
typecheck failure in the clients, not as a runtime surprise.

## 2. Authentication

- **Scheme:** JWT (Bearer), not session cookies — so the same API serves the web
  and mobile clients. The web client stores the token as `csp_token` in
  localStorage; mobile stores it in `expo-secure-store`.
- **Global injection:** `setAuthTokenGetter` (in `@workspace/api-client-react`)
  wires the token into every generated call; no per-call `Authorization` header is
  needed.
- **Server enforcement:** `requireAuth` loads the **fresh** user row each request
  (role, permissions, status) instead of trusting the JWT payload, and enforces the
  subscription lifecycle (`evaluateCompanyAccess`).
- **Authorization:** `platform_owner`/`primary_admin` bypass permission checks;
  `admin`/`employee` are gated by a `permissions` matrix on writes (reads stay open
  but tenant-scoped). Cross-tenant access returns **404**, not 403, to avoid leaking
  record existence.

See the [Architecture Overview](architecture.md) for the full role hierarchy and
subscription-lifecycle rules.

## 3. Standardized error shape

All error responses use a single JSON shape:

```json
{ "error": "human-readable message" }
```

This is produced by the global error middleware
(`artifacts/api-server/src/middlewares/errorHandler.ts`), registered after the
`/api` router as an additive safety net. Individual routes keep their explicit
`res.status(...).json({ error })` returns; the global handler catches anything
thrown or rejected (Express 5 forwards async rejections automatically).

### Status-code behavior

- **Explicit app errors:** throw `new AppError(status, message)` to produce a
  specific status with that message.
- **Framework errors are preserved:** body-parser's **413** (oversized body — the
  JSON limit is `15mb` for base64 card images) and **400** (malformed JSON) keep
  their status and message.
- **Unmatched routes:** the `notFoundHandler` returns a JSON **404**
  `{ "error": "Not Found" }`. (Note: `/api/*` paths that flow through the
  router-level `requireAuth` may return **401** before reaching the 404 handler —
  still JSON.)
- **Unknown/5xx errors:** return a generic `"Internal server error"` message so
  internal details never leak; the real error is logged via `req.log`.
- **Domain-specific:** `POST /scans` returns **502** on OCR (Gemini) failure;
  contact creation degrades to a null lead score rather than failing the request.

## 4. Health & readiness endpoints

| Endpoint | Purpose | Success | Failure |
|---|---|---|---|
| `GET /api/healthz` | **Liveness** — the process is up. Cheap, dependency-free. | `200 { "status": "ok" }` | — |
| `GET /api/readyz` | **Readiness** — can serve real traffic. Runs a `SELECT 1` DB probe and an object-storage configuration check. | `200 { "status": "ok", "checks": { "database": "ok", "storage": "ok" } }` | `503` with `status: "degraded"` when the DB is unreachable |

> **Readiness storage semantics:** the `storage` check reports `"ok"` when the
> object-storage bucket id is **configured** (present), and `"not_configured"`
> otherwise. It is a configuration check, **not** a live reachability probe — see
> the [Technical-Debt Register](tech-debt.md) (M2).

Use `/api/healthz` for the deployment startup health check (see the
[Deployment Guide](deployment.md)) and `/api/readyz` for orchestrators that should
hold traffic until dependencies recover.

## 5. Quick reference

```bash
# Liveness / readiness
curl localhost:80/api/healthz
curl localhost:80/api/readyz

# Regenerate the client + schemas after editing the spec
pnpm --filter @workspace/api-spec run codegen
```
