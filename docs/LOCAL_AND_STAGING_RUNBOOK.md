# Local & Staging Runbook

Copy-pasteable, verified operating instructions for **Card Scanner Pro** (spec name: *Lead Capture Pro*) — a pnpm monorepo containing an Express + Drizzle API server, a React/Vite admin web app, an Expo React Native mobile app, and shared packages.

This document is authoritative for **running, testing, building, and connecting** the project locally and against staging. It complements — and must stay consistent with — `.env.example` (the environment contract), `docs/PORTABLE_ENVIRONMENT_SETUP.md` (the replacement map), `docs/architecture.md`, `docs/api-guide.md`, `docs/deployment.md`, and `docs/gotchas.md`.

> Every command below was verified against the actual `package.json` scripts and source as of **2026-08-06**. Where a step is Replit-only or optional, it is called out explicitly.

---

## 0. Prerequisites

| Software | Version used / expected | Notes |
|---|---|---|
| Node.js | `24.x` (verified `v24.13.0`) | Any current LTS ≥ 20 should work; the repo is developed on Node 24. |
| pnpm | `10.26.1` | Pinned via `packageManager` in the root `package.json`. **Only pnpm is allowed** — the root `preinstall` hook removes `package-lock.json`/`yarn.lock` and errors if you use npm/yarn. |
| PostgreSQL | 14+ | Any reachable PostgreSQL instance. Schema is applied with `drizzle-kit push` (there are **no versioned SQL migration files**). |
| Expo / EAS CLI | Provided via devDependencies (`@expo/cli`, `eas-cli`) | Run through `pnpm exec` — no global install required. |

The apps read `process.env` **directly**; there is **no bundled dotenv loader**. Supply variables via your shell, your process manager, or a `.env` file that your process manager loads. See `.env.example` for the authoritative variable list.

---

## 1. First Local Startup (from a fresh clone)

### 1.1 Install dependencies

```bash
pnpm install
```

Run from the repository root. This installs and links all workspace packages (`artifacts/*`, `lib/*`).

### 1.2 Provision PostgreSQL and set the environment

Create a database and export the two **required** API secrets (the server refuses to start without them):

```bash
# Required — API server will not boot without these:
export DATABASE_URL="postgresql://user:password@localhost:5432/cardscannerpro"
export SESSION_SECRET="$(openssl rand -hex 32)"   # any strong secret; used to sign JWTs
```

Copy the remaining values you need from `.env.example`. The commonly-used optional ones:

```bash
export PORT=5000            # API listen port (REQUIRED at runtime — see note below)
export NODE_ENV=development
# Gemini (optional — AI features degrade gracefully when unset):
# export GEMINI_API_KEY="..."          # direct Google Gemini API key

# HTTP edge policy (optional — see .env.example §1b and PORTABLE_ENVIRONMENT_SETUP §1.8/§1.9):
# export TRUST_PROXY=false            # local direct exposure (no reverse proxy in front)
# export CORS_ORIGINS=                # local: leave unset — development allows every origin
```

> **CORS / trust-proxy defaults:** unset `CORS_ORIGINS` means *open CORS in development* but *no cross-origin access in production* (same-origin web + native mobile need none). Unset `TRUST_PROXY` trusts exactly **1** reverse-proxy hop (the Replit topology).
> - **Local (API hit directly, no proxy):** `TRUST_PROXY=false`; `CORS_ORIGINS` unset.
> - **Staging (e.g. a browser client on another host calling `https://contact-aggregator--DelowarHossain1.replit.app`):** set `CORS_ORIGINS=https://your-staging-web-host` on the API; `TRUST_PROXY` unset (1 hop behind the Replit ingress).
> - **Production:** leave `CORS_ORIGINS` unset for the standard same-origin setup, or list your web origins explicitly (`CORS_ORIGINS=https://app.example.com`); set `TRUST_PROXY` to your real hop count (e.g. `2` for CDN → LB → app).

> **PORT note:** the API server's `config.resolvePort()` throws if `PORT` is unset when the HTTP listener starts. The `dev` script exports `NODE_ENV=development` for you but **not** `PORT` — export `PORT` yourself (default convention is `5000`).

All other variables (auth tunables, object storage, SMTP, AI pricing/limits, background jobs) are **optional with safe defaults**; see `.env.example` sections 1a–1f.

### 1.3 Apply the database schema (schema sync — no migrations)

There are **no versioned SQL migrations**. The schema in `lib/db/src/schema/` is synced directly to the database with `drizzle-kit push`:

```bash
# From lib/db (or via filter from the root):
pnpm --filter @workspace/db run push
```

Available scripts in `lib/db/package.json`:

| Script | Command | When to use |
|---|---|---|
| `push` | `drizzle-kit push --config ./drizzle.config.ts` | Normal schema sync (interactive prompts on ambiguous changes). |
| `push-force` | `drizzle-kit push --force --config ./drizzle.config.ts` | Apply without interactive prompts (destructive-safe confirmation skipped). |

`drizzle.config.ts` throws `DATABASE_URL, ensure the database is provisioned` if `DATABASE_URL` is unset, so export it before running push.

### 1.4 Seed data

**There are no seed scripts in this repository.** Neither `lib/db/package.json` nor `artifacts/api-server/package.json` defines a `seed` script, and there is no seed module in `lib/db/src`. Application data (companies, users, contacts) is created through the normal application/API flows (registration, invitations, imports). Skip this step.

### 1.5 Start the API server

```bash
pnpm --filter @workspace/api-server run dev
```

The `dev` script (`artifacts/api-server/package.json`) runs `export NODE_ENV=development && pnpm run build && pnpm run start`:
- `build` → `node ./build.mjs` (esbuild bundle to `dist/index.mjs`)
- `start` → `node --enable-source-maps ./dist/index.mjs`

It binds the HTTP listener to `PORT` (export `PORT=5000` first, per §1.2). Required secrets are validated eagerly at module load — a missing `DATABASE_URL` or `SESSION_SECRET` produces a clear startup error (see §5).

### 1.6 Start the web app

```bash
pnpm --filter @workspace/web-app run dev
```

The `dev` script runs `vite --config vite.config.ts --host 0.0.0.0`. The **dev server** needs `PORT` and `BASE_PATH` in the environment:

```bash
export PORT=3000          # dev-server port
export BASE_PATH=/        # base path the app is served under
pnpm --filter @workspace/web-app run dev
```

The web client calls the API via **relative `/api` paths** (same origin / reverse proxy) — there is no runtime API-URL variable for the web app. Point a reverse proxy (or the Replit gateway) so that `/api/*` reaches the API server. (`vite build` does **not** require `PORT`/`BASE_PATH`; base defaults to `/`.)

### 1.7 Start the mobile app (Expo dev)

```bash
pnpm --filter @workspace/mobile run dev
```

The `dev` script starts Expo with Replit-oriented env wiring (`EXPO_PACKAGER_PROXY_URL`, `EXPO_PUBLIC_DOMAIN`, `REACT_NATIVE_PACKAGER_HOSTNAME`, `--localhost --port $PORT`). Off Replit, `PORT` must be set; the Replit-only variables are optional and the app falls back cleanly.

**API URL resolution** (`artifacts/mobile/app/_layout.tsx`, resolved once at module load):
1. `EXPO_PUBLIC_API_URL` — explicit full URL (takes precedence), e.g. `https://api.example.com`.
2. `EXPO_PUBLIC_DOMAIN` — a bare domain; `https://` is prepended automatically (Replit dev flow).
3. If neither resolves, the base URL stays `null`: the app still boots to the login screen and surfaces auth/network errors (it logs a `[CSP] No API URL configured` warning) rather than crashing.

For local dev against a locally-running API:

```bash
export EXPO_PUBLIC_API_URL="http://<your-machine-lan-ip>:5000"
export PORT=8081
pnpm --filter @workspace/mobile run dev
```

> `EXPO_PUBLIC_*` values are **baked into the client bundle** — never place secrets in them.

---

## 2. Typechecks

Run all typechecks from the root:

```bash
pnpm run typecheck
```

The root `typecheck` script runs `typecheck:libs` (`tsc --build`) then every artifact's/`scripts`' `typecheck` script. To run a single package:

```bash
pnpm --filter @workspace/api-server run typecheck   # tsc -p tsconfig.json --noEmit
pnpm --filter @workspace/web-app    run typecheck   # tsc -p tsconfig.json --noEmit
pnpm --filter @workspace/mobile     run typecheck   # tsc -p tsconfig.json --noEmit
```

**Baseline:** all typechecks clean.

---

## 3. Test Suites

### 3.1 API suite — vitest (against the live server)

The API tests are **integration tests that hit the running server** at `http://localhost:80/api` (the gateway proxy), not in-process. The vitest config (`artifacts/api-server/vitest.config.ts`) runs files under `test/**/*.test.ts` with `fileParallelism: false`.

> **⚠️ RESTART THE API SERVER FIRST, AND RUN THE SUITE ONLY ONCE.**
> The login rate limiter is **stateful within a server process** — it counts prior failed logins (and, via the shared `/api/auth` ceiling, prior auth requests). The suite performs hundreds of logins in a single run. Running it against a server that has already served a prior test run (or repeated runs without a restart) trips the limiter and yields spurious `429` failures. **Restart the API server, then run the suite exactly once.**

```bash
# 1. (Re)start the API server in another terminal (see §1.5), fresh.
# 2. Then, once:
pnpm --filter @workspace/api-server run test    # vitest run
```

**Baseline:** 705/705 passing.

### 3.2 Mobile suite — vitest

```bash
pnpm --filter @workspace/mobile run test         # vitest run
```

Pure unit tests (no server, no device required). Config: `artifacts/mobile/vitest.config.ts`.

**Baseline:** 107/107 passing.

### 3.3 Web suite — Playwright (E2E)

```bash
pnpm --filter @workspace/web-app run test:e2e     # playwright test
```

Configuration (`artifacts/web-app/playwright.config.ts`) — this is a **long-running, real-login** suite:
- **Chromium binary:** resolved via `PW_CHROMIUM_PATH` if set and existing; otherwise it auto-discovers the newest Nix-store Playwright Chromium build (`/nix/store/*-playwright-browsers-chromium/...`). Off NixOS, set `PW_CHROMIUM_PATH` to your Chromium binary.
- **Target:** `E2E_BASE_URL` if set, else `http://localhost:80`.
- **Prerequisites:** the config does **not** start the web dev server or the API — both must already be running (web dev server with HMR up, API reachable via the same-origin `/api` proxy). It runs `workers: 1`, `fullyParallel: false`, `retries: 0`, with `globalSetup`/`globalTeardown` that perform real login.

```bash
# Prerequisites: web dev server + API running, reachable at E2E_BASE_URL.
export E2E_BASE_URL="http://localhost:80"
# export PW_CHROMIUM_PATH="/path/to/chrome"   # only if not on NixOS
pnpm --filter @workspace/web-app run test:e2e
```

**Baseline:** 43/43 passing.

### 3.4 OCR live verification (optional, spends live Gemini calls)

**Not part of the automated suite.** `artifacts/api-server/scripts/verify-ocr-live.ts` sends 8 fixture images through the real `POST /api/scans` pipeline against **live Gemini 2.5 Flash** under a throwaway tenant (deleted at the end), writing `scripts/ocr-live-report.json`.

```bash
# The API dev server must be up AND Gemini must be configured (GEMINI_API_KEY
# or the Replit AI-integration pair). This consumes real Gemini quota.
cd artifacts/api-server
npx tsx scripts/verify-ocr-live.ts
```

Only run this when you specifically need live-provider evidence. Normal tests never call live Gemini (a deterministic stub provider is used in dev/test and is never registered in production).

---

## 4. Production Builds (no paid credits consumed)

| Package | Command | Output |
|---|---|---|
| Web | `pnpm --filter @workspace/web-app run build` | `vite build` → static bundle. Does **not** require `PORT`/`BASE_PATH`. |
| API | `pnpm --filter @workspace/api-server run build` | `node ./build.mjs` → `dist/index.mjs` (esbuild). |
| Mobile (JS bundle) | `cd artifacts/mobile && npx expo export` | Exports the JS/asset bundle. Does **not** build an APK and spends no EAS credits. |

None of these consume external paid credits.

---

## 5. Staging

**Current staging = this Repl, published at:**

```
https://contact-aggregator--DelowarHossain1.replit.app
```

This URL is **baked into `artifacts/mobile/eas.json`** as `EXPO_PUBLIC_API_URL` for both the `preview` and `production` build profiles, so mobile builds from those profiles talk to staging automatically.

### 5.1 Verify staging

```bash
# Basic reachability (expects the web app / API to respond):
curl -sS -o /dev/null -w "%{http_code}\n" https://contact-aggregator--DelowarHossain1.replit.app/
# API surface is served under /api on the same origin.
```

### 5.2 Connect the mobile app to staging (dev, without a build)

```bash
export EXPO_PUBLIC_API_URL="https://contact-aggregator--DelowarHossain1.replit.app"
pnpm --filter @workspace/mobile run dev
```

### 5.3 Build the mobile APK (manual, spends EAS credits — do not run casually)

The `preview` profile produces an internal-distribution Android **APK** and already targets staging:

```bash
cd artifacts/mobile
pnpm exec eas build --platform android --profile preview --non-interactive
```

Authentication is via `EXPO_TOKEN` in the shell/CI environment (never place it in app env or `EXPO_PUBLIC_*`). This is a **manual, credit-consuming** step — run it only when an APK is explicitly required.

> `eas.json` profiles: `development` (dev client APK), `preview` (internal APK, staging URL), `production` (auto-incremented, staging URL).

---

## 6. Provider-Specific / Optional Steps

These are **optional** — the app runs without them (features degrade gracefully) and none are required to run the exported repository elsewhere:

- **Replit dev/hosting wiring:** `REPL_ID`, `REPLIT_DOMAINS`, and the Replit env baked into the mobile `dev` script and web Vite plugins. Absent off Replit; every consumer falls back cleanly.
- **Gemini AI:** set `GEMINI_API_KEY` (portable) or the `AI_INTEGRATIONS_GEMINI_*` pair (Replit AI integration, takes precedence). Without either, AI/OCR features are disabled gracefully.
- **Object storage (GCS):** `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PUBLIC_OBJECT_SEARCH_PATHS`, `PRIVATE_OBJECT_DIR`, plus credentials (Replit sidecar auto-detected on Replit; `GOOGLE_APPLICATION_CREDENTIALS` elsewhere; force with `OBJECT_STORAGE_AUTH`). Without these, file/scan-image storage reports "not configured" and uploads fail, but the server boots.
- **Email (SMTP):** `SMTP_*` + `EMAIL_*`. Without them, transactional email is a logged no-op.
- **EXPO push:** `EXPO_ACCESS_TOKEN` (server-side push enhancement).

---

## 7. Steps Still Performed Manually

- Applying the database schema after schema changes (`pnpm --filter @workspace/db run push`).
- Building the mobile APK via EAS (§5.3) — credit-consuming, run on demand.
- Deploying/publishing the Repl to staging.
- Running the OCR live verification (§3.4) when live-provider evidence is needed.

---

## 8. Safe Shutdown & Restart

- **Shutdown:** stop each dev process with `Ctrl-C`. The background-job queue is in-process, so stopping the API server stops pending jobs; email delivery is queued off the request path (`JOBS_ASYNC_EMAIL=true`).
- **Restart order:** database → API server → web dev server → mobile.
- **Before running the API test suite:** always restart the API server first and run the suite exactly once (see §3.1) to avoid a stale rate-limiter state.

---

## 9. Troubleshooting — Common Failures & Fixes

| Symptom | Cause | Fix |
|---|---|---|
| `Required environment variable SESSION_SECRET is not set. The API server cannot start without it.` | `SESSION_SECRET` missing. Validated eagerly at config module load (`artifacts/api-server/src/config.ts`, `requireEnv`). | Export `SESSION_SECRET` (`openssl rand -hex 32`). |
| `DATABASE_URL must be set. Did you forget to provision a database?` (or, from drizzle-kit: `DATABASE_URL, ensure the database is provisioned`) | `DATABASE_URL` missing. Thrown by `lib/db/src/index.ts` and `lib/db/drizzle.config.ts`. | Export `DATABASE_URL` pointing at a reachable PostgreSQL. |
| `PORT environment variable is required but was not provided.` / `Invalid PORT value` | The API `dev` script exports `NODE_ENV` but not `PORT`; `resolvePort()` throws. | `export PORT=5000` before starting the API server. |
| Startup warning: *"APP_BASE_URL is not set in production — links in outgoing emails … will point at localhost."* | `APP_BASE_URL` (and `REPLIT_DOMAINS`) unset in production while email is configured (`artifacts/api-server/src/lib/email/index.ts`). | Set `APP_BASE_URL` to the public web app URL so reset/invite links are correct. |
| Startup warning: email provider **not configured** (logged no-op) | `SMTP_*` unset. Transactional email is skipped by design. | Configure `SMTP_*` + `EMAIL_*` if you need real email; otherwise ignore. |
| Uploads/scan images fail; storage reports **"not configured"** | Object-storage env unset (`artifacts/api-server/src/lib/objectStorage.ts`). | Set `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PUBLIC_OBJECT_SEARCH_PATHS`, `PRIVATE_OBJECT_DIR` + credentials (§6). Server still boots without them. |
| AI/OCR features disabled: *"Gemini is not configured…"* | No Gemini credential (`lib/integrations-gemini-ai/src/client.ts`, lazy init). | Set `GEMINI_API_KEY` **or** the `AI_INTEGRATIONS_GEMINI_*` pair. Optional — everything else works. |
| API tests fail with spurious **`429`** responses | Login rate limiter counts prior failed logins / shared `/api/auth` ceiling counts all auth requests within the window. | **Restart the API server, then run the suite once** (§3.1). Do not run it repeatedly against the same running server. |
| Playwright cannot launch Chromium (shared-library / binary errors) | Downloaded Chromium can't resolve libs on NixOS; auto-discovery found nothing. | Set `PW_CHROMIUM_PATH` to a working Chromium binary; ensure web dev server + API are up and `E2E_BASE_URL` is correct. |
| Metro crashes with `ENOENT` watching `pdfkit_tmp_*` / node_modules churn | pnpm hoists the server-only `pdfkit` into the shared workspace `node_modules`, where Metro's crawler tries to watch transient install staging dirs. | Already handled: `artifacts/mobile/metro.config.js` sets `config.resolver.blockList` to `/\/node_modules\/\.pnpm\/pdfkit@[^/]+\/.*/`. **Do not remove this blocklist entry** — it prevents the watcher crash. |
| `Use pnpm instead` on install | npm/yarn used instead of pnpm; the root `preinstall` hook enforces pnpm. | Use `pnpm install`. |
| Mobile logs `[CSP] No API URL configured` and requests fail | Neither `EXPO_PUBLIC_API_URL` nor `EXPO_PUBLIC_DOMAIN` resolved. | Set `EXPO_PUBLIC_API_URL` (or `EXPO_PUBLIC_DOMAIN`) before starting/building mobile. |

---

## Appendix — Verified command reference

| Purpose | Command |
|---|---|
| Install | `pnpm install` |
| DB schema sync | `pnpm --filter @workspace/db run push` (or `push-force`) |
| Start API | `PORT=5000 pnpm --filter @workspace/api-server run dev` |
| Start web (dev) | `PORT=3000 BASE_PATH=/ pnpm --filter @workspace/web-app run dev` |
| Start mobile (dev) | `pnpm --filter @workspace/mobile run dev` |
| Typecheck (all) | `pnpm run typecheck` |
| API tests | restart server, then `pnpm --filter @workspace/api-server run test` (once) |
| Mobile tests | `pnpm --filter @workspace/mobile run test` |
| Web E2E | `pnpm --filter @workspace/web-app run test:e2e` |
| OCR live verify (optional) | `cd artifacts/api-server && npx tsx scripts/verify-ocr-live.ts` |
| Web build | `pnpm --filter @workspace/web-app run build` |
| API build | `pnpm --filter @workspace/api-server run build` |
| Mobile JS export | `cd artifacts/mobile && npx expo export` |
| Mobile APK (manual, EAS credits) | `cd artifacts/mobile && pnpm exec eas build --platform android --profile preview --non-interactive` |
