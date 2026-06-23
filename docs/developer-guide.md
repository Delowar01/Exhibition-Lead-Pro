# Developer Guide

_Local setup, running the apps, codegen, tests, and coding conventions._

## 1. Prerequisites

- **Node.js 24** and **pnpm** (`packageManager` is pinned in the root
  [`package.json`](../package.json); on Replit the `nodejs-24` and
  `postgresql-16` modules are provisioned via [`.replit`](../.replit)).
- A **PostgreSQL** database reachable via `DATABASE_URL`.
- A `SESSION_SECRET` for JWT signing (required — the API fails fast at startup
  without it).

Install dependencies from the repo root:

```bash
pnpm install
```

> Do **not** run `pnpm dev` / `pnpm run dev` at the workspace root. Apps run via
> Replit **workflows**, which inject per-artifact `PORT` and `BASE_PATH`. The root
> has no `dev` script by design.

## 2. Running the apps

Each artifact has its own workflow. To run or restart one, use the workflow for
that artifact (or the Replit preview pane). The dev commands behind them are:

| App | Command | Served at |
|---|---|---|
| API server | `pnpm --filter @workspace/api-server run dev` | `/api` (proxy → localPort 8080) |
| Web app | `pnpm --filter @workspace/web-app run dev` | `/` |
| Mobile (Expo) | `pnpm --filter @workspace/mobile run dev` | Expo dev domain |
| Pitch deck | `pnpm --filter @workspace/pitch-deck run dev` | `/pitch-deck` |
| Mockup sandbox | `pnpm --filter @workspace/mockup-sandbox run dev` | preview server |

**Accessing services for ad-hoc requests** (e.g. `curl`) always goes through the
shared proxy at `localhost:80`, never a service port directly:

```bash
curl localhost:80/api/healthz      # ✅ correct
curl localhost:8080/api/healthz    # ❌ wrong — bypasses the proxy
```

Paths are **not** rewritten by the proxy, so the API server owns its full `/api`
base path.

## 3. Core commands

| Task | Command |
|---|---|
| Full typecheck (all packages) | `pnpm run typecheck` |
| Typecheck libs only | `pnpm run typecheck:libs` |
| Typecheck one package | `pnpm --filter @workspace/<name> run typecheck` |
| Build everything | `pnpm run build` |
| API integration tests | `pnpm --filter @workspace/api-server run test` |
| Regenerate API client + Zod | `pnpm --filter @workspace/api-spec run codegen` |
| Push DB schema (dev only) | `pnpm --filter @workspace/db run push` |

### Typecheck

`pnpm run typecheck` builds the composite libs first (`tsc --build`), then runs
each leaf package's `tsc --noEmit`. Prefer **verifying with `typecheck`, not
`build`** — `build` needs workflow-provided `PORT`/`BASE_PATH` and can fail from a
plain shell even when the code is correct. When the editor/LSP and the CLI
disagree, trust `pnpm run typecheck`.

### Tests

The API integration tests (`vitest`) run against the **live** API at
`localhost:80` with seeded demo tenants — the `api-server` workflow **must be
running**. They cover happy-path CRUD, auth, and the hardened error/health
behavior (e.g. `/healthz` shape, `/readyz` semantics, 413 on oversized body, 400
on malformed JSON).

```bash
pnpm --filter @workspace/api-server run test
```

### Codegen

After **any** change to [`lib/api-spec/openapi.yaml`](../lib/api-spec/openapi.yaml),
run codegen to regenerate the Zod schemas and React Query hooks:

```bash
pnpm --filter @workspace/api-spec run codegen
```

Do not edit generated files by hand. See the [API Guide](api-guide.md).

### Database schema changes

Edit the Drizzle schema in `lib/db/src/schema/index.ts`, then:

```bash
pnpm --filter @workspace/db run push
```

If a lib changes, run `pnpm run typecheck:libs` before leaf checks; missing
`@workspace/db` exports usually mean stale lib declarations, not bad imports.

## 4. Conventions

### Workspace & dependencies

- Workspace package names use the `@workspace/` prefix.
- Each package declares its own dependencies; nothing is shared implicitly.
- Root dependencies are repo-level tooling only (TypeScript, Prettier).
- Use the `pnpm-workspace.yaml` `catalog:` pin when one exists for a dependency.
- **Server** runtime imports → `dependencies`; build tools + `@types/*` →
  `devDependencies`. **Static/client** artifacts → all `devDependencies`.
- `artifacts/*` must never import each other — promote shared code into a `lib/*`
  package.

### Server code

- **Never use `console.log`.** Use `req.log` in route handlers and the singleton
  `logger` elsewhere.
- **Read configuration from `config.ts`**, never `process.env` directly, in the
  api-server. `config.ts` is the only module that touches `process.env`.
- **API routes must include the full `/api/...` base path** — the proxy does not
  strip it.
- **Path-scope terminating guards** (`requireRole`, `auditMutations`) to the
  module base (e.g. `router.use("/contacts", auditMutations("contacts"))`).
  Sub-routers mount path-less on a shared parent, so a path-less terminating
  guard fires on every request. `requireAuth` is non-terminating, so path-less is
  fine.
- **Register static sub-paths before `/:id`** (e.g. `GET /contacts/duplicates`
  before `GET /contacts/:id`) — Express matches in declaration order.
- **Tenant safety:** use `tenantScope(...)` on every list/report/stats/pipeline
  read and `refAccessible(...)` to validate FK references on writes. Never scope a
  read by `companyId` alone.
- **Errors:** throw `AppError(status, message)` (from `middlewares/errorHandler.ts`)
  for explicit HTTP errors, or let async rejections bubble to the global handler.
  Keep the `{ error }` response shape.
- **Date-only columns** are plain `YYYY-MM-DD` strings — parse with `parseISO(s)`,
  not `new Date(s)`.
- Wrap mixed `??`/`||`: `(a ?? b) || c` (unparenthesized fails esbuild).

### Clients

- Consume generated React Query hooks and Zod schemas; do not hand-write fetch
  calls or response types.
- The Bearer token is injected globally via `setAuthTokenGetter` — no per-call
  headers.

### Naming & structure

- Routes live in `artifacts/api-server/src/routes/<module>.ts`, one router per
  module, mounted in `routes/index.ts`.
- Cross-cutting middleware lives in `artifacts/api-server/src/middlewares/`.
- Server helpers live in `artifacts/api-server/src/lib/`.
- Web pages are split by portal: `web-app/src/pages/platform/` and
  `web-app/src/pages/admin/`.

## 5. Where to look next

- [Architecture Overview](architecture.md) — how the pieces fit together.
- [API Guide](api-guide.md) — the contract-first workflow and error shape.
- [Deployment Guide](deployment.md) — shipping to production.
- [`replit.md`](../replit.md) — quick reference, demo credentials, and the full
  gotchas list.
