# Deployment Guide

_Replit autoscale is the primary deployment target; external Docker self-hosting
is documented separately._

## 1. Primary: Replit Autoscale

The project deploys on Replit using the **autoscale** target, configured in
[`.replit`](../.replit):

```toml
[deployment]
router = "application"
deploymentTarget = "autoscale"

[deployment.postBuild]
args = ["pnpm", "store", "prune"]
env = { "CI" = "true" }
```

A global reverse proxy routes traffic by path using each artifact's
`.replit-artifact/artifact.toml`. The API server owns `/api`:

```toml
# artifacts/api-server/.replit-artifact/artifact.toml
[[services]]
localPort = 8080
name = "API Server"
paths = ["/api"]
```

### How the API server is built and run in production

From the same `artifact.toml`:

- **Build:** `pnpm --filter @workspace/api-server run build` with
  `NODE_ENV=production`. This typechecks and bundles to
  `artifacts/api-server/dist/index.mjs` (esbuild).
- **Run:** `node --enable-source-maps artifacts/api-server/dist/index.mjs` with
  `PORT=8080` and `NODE_ENV=production` (run directly, not through pnpm, for faster
  startup).
- **Startup health check:** `GET /api/healthz`.

### Required configuration in production

The server reads all configuration through `config.ts`. The deployment must
provide:

- `SESSION_SECRET` — **required**; the server fails fast at startup if it is
  missing.
- `DATABASE_URL` — Postgres connection string used by `@workspace/db`.
- `PORT` — provided by the run configuration (`8080`).
- Object-storage vars (`DEFAULT_OBJECT_STORAGE_BUCKET_ID`,
  `PUBLIC_OBJECT_SEARCH_PATHS`, `PRIVATE_OBJECT_DIR`) — needed for card-image
  storage; `/api/readyz` reports `storage: "not_configured"` if the bucket id is
  absent.
- `EXPO_ACCESS_TOKEN`, `REPLIT_DOMAINS` — optional.

> Manage secrets through Replit's environment/secrets tooling — never hard-code
> them. Published apps are served over HTTPS on the domains in `$REPLIT_DOMAINS`.

### Deploy checklist

1. `pnpm run typecheck` is clean.
2. `pnpm --filter @workspace/api-server run test` passes (api-server workflow
   running).
3. `SESSION_SECRET` and `DATABASE_URL` are set in the deployment environment.
4. Any schema changes have been applied to the production database (see the
   `database` skill for pushing dev schema to prod).
5. Publish via Replit; the platform handles build, hosting, TLS, and the
   `/api/healthz` startup check.

### Operating in production

- **Liveness:** `GET /api/healthz` → `200 { "status": "ok" }`.
- **Readiness:** `GET /api/readyz` → `200` when the DB is reachable, `503`
  (`status: "degraded"`) when it is not.
- **Logs:** structured `pino` JSON; inspect production/deployment logs through the
  Replit deployment tooling when debugging a published app.

## 2. Alternative: External Docker self-hosting

For running Card Scanner Pro outside Replit (on a customer's own infrastructure),
a separate **Docker self-hosting bundle** is maintained as its own deliverable.
That bundle owns the Dockerfiles, compose definitions, and the self-hosting
runbook; this guide intentionally does not duplicate them.

- The Replit-native layout above (`.replit`, workflows, the reverse proxy) is
  **not** modified by the Docker setup — self-hosting is purely additive and
  external.
- The same runtime configuration applies (`SESSION_SECRET`, `DATABASE_URL`,
  `PORT`, object-storage vars), and the same `GET /api/healthz` / `GET /api/readyz`
  endpoints are the container health/readiness probes.

> When the Docker self-hosting bundle lands, link its runbook here. Until then,
> Replit autoscale (Section 1) is the supported production path.
