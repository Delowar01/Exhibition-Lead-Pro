# Self-Hosting Card Scanner Pro with Docker

This directory contains everything needed to run **Card Scanner Pro** on your own
infrastructure — AWS, GCP, Azure, DigitalOcean, a plain VPS, or on-prem — using
Docker and Docker Compose.

> This bundle is **completely separate** from how the app runs on Replit. Replit
> builds and serves the app through its own workflows and autoscale deployment;
> nothing here changes that. These files are additive and used only for
> self-hosting.

---

## Contents

| File | Purpose |
| --- | --- |
| `Dockerfile.api` | Multi-stage build for the API server (bundle + pruned prod deps, non-root, healthcheck). Also defines the `migrate` stage. |
| `Dockerfile.web` | Builds the web app to static assets and serves them with nginx, reverse-proxying `/api`. |
| `docker-compose.yml` | Wires together API + web + optional PostgreSQL (+ optional Redis, + one-shot migrate job). |
| `.env.example` | Every supported environment variable, documented, with safe placeholders. |
| `nginx/default.conf.template` | nginx site config (SPA fallback + `/api` proxy, `${API_UPSTREAM}` templated at start). |
| `scripts/api-entrypoint.sh` | Production entrypoint for the API container. |

---

## Architecture

```
                 ┌──────────────────────────────┐
  Browser  ──▶   │  web (nginx :80)             │
                 │   • serves static SPA assets │
                 │   • proxies /api/* ──────────┼──▶  api (Node :8080)
                 └──────────────────────────────┘          │
                                                            ▼
                                            postgres :5432 (bundled or external)
```

- The web app makes **relative** `/api/...` requests, so the browser only ever
  talks to the web (nginx) origin. nginx forwards `/api/` to the API container.
  This means **no CORS configuration is required**.
- The API is also published on its own host port (default `5000`) for debugging
  or for a future mobile client.

---

## Prerequisites

- Docker Engine 24+ and the Docker Compose v2 plugin (`docker compose`, not the
  legacy `docker-compose`).
- The full repository checked out (the image builds need the whole pnpm
  workspace as build context).

---

## Quick start

From this `docker/` directory:

```bash
cp .env.example .env
# Edit .env — at minimum set a strong SESSION_SECRET.
# openssl rand -hex 32   # handy for generating one

docker compose up -d --build

# First boot only (and after any schema change): create the DB tables.
docker compose --profile migrate run --rm migrate
```

Then open **http://localhost:8080** (or whatever `WEB_PORT` you set).

To watch logs / stop:

```bash
docker compose logs -f
docker compose down            # keep data
docker compose down -v         # also delete the postgres volume (destructive)
```

---

## Configuration

All configuration is via environment variables in `.env`. See `.env.example`
for the fully-commented list. The essentials:

| Variable | Required | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | ✅ | JWT signing key. Use a long random string. |
| `DATABASE_URL` | ✅ | Postgres connection string. Defaults to the bundled DB. |
| `COMPOSE_PROFILES` | – | `local-db` (default) runs the bundled Postgres. Empty = external DB. |
| `WEB_PORT` / `API_PORT` | – | Host ports for the web app and API. |
| `WEB_BASE_PATH` | – | Base href for web assets (build-time). `/` by default. |
| `GEMINI_API_KEY` | – | Enables AI OCR / scoring / enrichment. |
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID` etc. | – | GCS object storage for card images. |

Secrets are **only** read from the environment — nothing is baked into the
images.

---

## Database options

### Option A — bundled PostgreSQL (default)

`COMPOSE_PROFILES=local-db` (the default in `.env.example`) starts a
`postgres:16` container with a persistent named volume `pgdata`. `DATABASE_URL`
already points at it. Nothing else to do beyond running the one-time `migrate`
job.

### Option B — external managed database

Use this for RDS, Cloud SQL, Azure Database for PostgreSQL, DigitalOcean Managed
Databases, Neon, Supabase, etc.

1. In `.env`, set `COMPOSE_PROFILES=` (empty) so the bundled Postgres is not
   started.
2. Set `DATABASE_URL` to your provider's connection string. Most managed
   databases require TLS, e.g.:
   ```
   DATABASE_URL=postgresql://user:pass@db.example.com:5432/cardscanner?sslmode=require
   ```
3. Run migrations against it:
   ```bash
   docker compose --profile migrate run --rm migrate
   ```
4. Bring up the app: `docker compose up -d --build`.

The `required: false` dependency on Postgres means the API/migrate services
start cleanly without the bundled DB.

---

## Migrations

Schema is applied with Drizzle's `push` (no separate migration files). Run the
one-shot job after the first boot and after any schema change:

```bash
docker compose --profile migrate run --rm migrate
```

It uses the same `DATABASE_URL` as the API.

---

## Volumes & persistence

- `pgdata` — bundled PostgreSQL data. Survives `docker compose down`; removed by
  `docker compose down -v`. Back it up if you rely on the bundled database:
  ```bash
  docker compose exec postgres pg_dump -U cardscanner cardscanner > backup.sql
  ```
- `redisdata` — only created if you enable the optional Redis profile.

For production, prefer an external managed database (Option B) so persistence,
backups, and failover are handled by your provider.

---

## Health checks

| Service | Endpoint / check |
| --- | --- |
| api (liveness) | `GET /api/healthz` → `200` |
| api (readiness) | `GET /api/readyz` → `200` when the DB is reachable, else `503` |
| web | `GET /healthz` → `200` (nginx) |
| postgres | `pg_isready` |

Both images declare Docker `HEALTHCHECK`s, so `docker compose ps` shows health
status. Point your load balancer / orchestrator probes at the endpoints above.

---

## Optional Redis

The app does not require Redis today. A ready-to-use `redis:7` service is
included but **disabled by default**. Enable it only if you add caching or job
queues:

```bash
docker compose --profile redis up -d
```

---

## Updating

```bash
git pull
docker compose build --pull
docker compose up -d
docker compose --profile migrate run --rm migrate   # if the schema changed
```

---

## Provider-specific notes

These are starting points; consult each provider's docs for production hardening
(TLS, secrets management, autoscaling, backups).

### DigitalOcean
- **Droplet (simplest):** create an Ubuntu droplet, install Docker + Compose,
  clone the repo, set `.env`, run `docker compose up -d --build`. Put it behind a
  managed load balancer or Caddy/nginx for TLS.
- **Managed Database:** create a Postgres cluster, use Option B with
  `?sslmode=require`.
- **App Platform:** build the two images from `Dockerfile.api` and
  `Dockerfile.web`, push to a registry, and define two components. Use a managed
  Postgres for `DATABASE_URL` and set `API_UPSTREAM` to the API component's
  internal URL.

### AWS
- **EC2:** same as the Droplet flow. Use an Application Load Balancer for TLS and
  health checks (`/api/healthz`, `/healthz`).
- **ECS / Fargate:** push both images to ECR. Define a task/service per image.
  Use RDS for PostgreSQL (Option B), store `SESSION_SECRET` / `DATABASE_URL` in
  Secrets Manager and inject as env vars. Set `API_UPSTREAM` to the API
  service's discovery DNS (e.g. via AWS Cloud Map / service connect).
- **App Runner:** works for each service image individually; use RDS and wire
  `API_UPSTREAM` to the API service URL.

### Google Cloud
- **Compute Engine:** VM + Docker Compose as above.
- **Cloud Run:** deploy `api` and `web` as two services. Use Cloud SQL for
  Postgres (Option B; connect via the Cloud SQL connector or private IP). Set
  `API_UPSTREAM` to the API service's URL. Note Cloud Run injects `PORT`; the API
  already reads `PORT`, and for the web image nginx listens on 80 — if deploying
  the web image to Cloud Run, adjust it to listen on `$PORT`.

### Azure
- **Azure VM:** VM + Docker Compose as above.
- **Azure Container Apps / App Service for Containers:** push both images to ACR.
  Use Azure Database for PostgreSQL (Option B, TLS required). Configure app
  settings for the env vars and set `API_UPSTREAM` to the API app's internal
  ingress URL.

### Generic VPS / on-prem
1. Install Docker Engine + Compose plugin.
2. Clone the repo, `cp docker/.env.example docker/.env`, edit secrets.
3. `cd docker && docker compose up -d --build`.
4. Terminate TLS with a reverse proxy in front (Caddy, Traefik, or nginx) and
   forward to the `web` container's published port. Point your domain at the host
   and you're live.

---

## Troubleshooting

- **`DATABASE_URL is required` on startup** — set it in `docker/.env`.
- **API healthy but `/api/readyz` returns 503** — the database isn't reachable
  yet (still starting) or `DATABASE_URL` is wrong. Check `docker compose logs
  api postgres`.
- **Login / data calls 500 right after first boot** — you probably haven't run
  the `migrate` job yet (tables don't exist). Run it once.
- **AI features fail** — set `GEMINI_API_KEY`.
- **Web loads but `/api` calls 502** — the API container isn't up/healthy, or
  `API_UPSTREAM` doesn't match the API service. Default is `http://api:8080`.
- **Build is slow the first time** — dependencies are installed and the bundle is
  built inside the image. Subsequent builds reuse the pnpm store cache.
