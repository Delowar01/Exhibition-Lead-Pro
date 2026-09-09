# Localhost Development Guide

How to develop, run, and regression-test Lead Capture Pro (Card Scanner Pro)
entirely on a local machine — no Replit, no cloud deploys. Complements
[`LOCAL_AND_STAGING_RUNBOOK.md`](LOCAL_AND_STAGING_RUNBOOK.md) and the
authoritative env reference [`.env.example`](../.env.example); where this guide
and older docs disagree, the code is authoritative (differences called out
below were verified against the code at baseline `303bf40`).

## 1. Required software

| Tool | Version | Notes |
|---|---|---|
| Node.js | **24.13.0** (verified baseline) | ≥ 20 works; the export was verified on 24.13.0 |
| pnpm | **10.26.1** (pinned) | `packageManager` pin; root `preinstall` rejects npm/yarn |
| PostgreSQL | 14+ (verified on 16) | local server on `localhost:5432` |
| Chromium | any recent | only for Playwright — set `PW_CHROMIUM_PATH` to the binary |

## 2. Install

```bash
pnpm install --frozen-lockfile
```

## 3. Environment configuration

**No dotenv loader is bundled** — the apps read `process.env` directly, so
export variables in your shell (or a profile script you `source`). Never commit
real values.

Required (API refuses to boot without all three):

```bash
export DATABASE_URL="postgresql://<user>:<password>@localhost:5432/<dev-db>"
export SESSION_SECRET="$(openssl rand -hex 32)"
export PORT=8080        # per-app; see §5 (docs elsewhere say 5000 — see note)
```

> **PORT note:** `.env.example` shows `PORT=5000` as if it defaulted; in code
> (`artifacts/api-server/src/config.ts` `resolvePort()`) `PORT` is **required**.
> Use **8080** for the API locally: two test files bypass the gateway and call
> `http://localhost:${API_DIRECT_PORT ?? 8080}` directly.

Optional — correct localhost values:

- `TRUST_PROXY` — **leave unset** (default `1`) when running behind the dev
  gateway (§5); the gateway adds exactly one `X-Forwarded-For` hop, and the
  IP-policy tests depend on that topology. Only set `TRUST_PROXY=false` when
  exposing the API directly with no proxy at all (not the test topology).
- `CORS_ORIGINS` — leave unset: the dev default allows every origin.
- `AI_ENABLE_STUB` — leave unset: the deterministic stub AI provider is
  registered automatically outside production.
- `SMTP_*`, object-storage vars, `GEMINI_API_KEY`, `REPLIT_*` — leave unset
  for normal development: email becomes a logged no-op, uploads report
  "not configured", AI degrades gracefully, and nothing Replit-specific is
  needed (see §12).
- **Billing (Batch 20)** — leave `BILLING_PROVIDER` unset for plain manual
  billing. The B20 API suites (`test/b20-billing-stripe.test.ts`) and the
  Playwright billing spec (`e2e/x-billing.spec.ts`) require the deterministic
  offline provider — export, in the shell that runs the API **and** the one
  that runs the tests:

  ```bash
  export BILLING_PROVIDER=fake
  export STRIPE_WEBHOOK_SECRET="whsec_local_test_only_$(openssl rand -hex 16)"   # any value; never a real secret
  export BILLING_SELF_SERVICE_CHECKOUT=true
  export BILLING_RETURN_URL=http://localhost:80        # explicit localhost HTTP is accepted outside production
  # BILLING_STRIPE_MODE=test                            # optional; defaults to test outside production (fake = test only)
  ```

  No network is used: prices are synthesized from ids such as
  `price_fake_usd_2900_month`, Checkout/Portal URLs are local placeholders, and
  webhooks are signed offline. Never set a real `STRIPE_SECRET_KEY` locally.
  The repair command for existing rows is
  `pnpm --filter @workspace/api-server exec tsx scripts/repair-subscriptions.ts` (dry-run; add `--apply`).

## 4. Development database

Use an **isolated local database — never production, never customer data**.

```bash
# as a Postgres superuser (once):
createuser --pwprompt lcp_dev
createdb --owner lcp_dev leadcapture_dev

export DATABASE_URL="postgresql://lcp_dev:<password>@localhost:5432/leadcapture_dev"
pnpm --filter @workspace/db run push          # sync schema (drizzle-kit push; no SQL migrations)
pnpm --filter @workspace/scripts run seed-demo  # demo tenants for browsing (password Demo123!)
```

> Older docs say `pnpm --filter @workspace/db db:push` — the actual script name
> is `push`. `LOCAL_AND_STAGING_RUNBOOK.md` §1.5 predates `seed-demo` and says
> no seed script exists; `scripts/src/seed-demo.ts` is real.

### Test-suite verification accounts (required before running the API/e2e suites)

The API and Playwright suites authenticate as three pre-existing accounts that
**no repo script creates** (they were retained in the original dev database —
see `EXPORT_PACKAGE_INFO.md` "Manual post-export actions"):

| Account | Password | Role | Constraint |
|---|---|---|---|
| `admin@cardscannerpro.com` | `Admin123!` | `platform_owner` | — |
| `admin@techcorp.com` | `Admin123!` | `primary_admin` | its company **must be company id 2** |
| `admin@nexussys.io` | `Admin123!` | `primary_admin` | its company **must be company id 3** |

`test/tenant-isolation-matrix.test.ts` hardcodes `A_CID = 2` and discovers
"seeded tenant-A" rows by querying company 2 directly, so on a **fresh, empty**
database create, in order: the platform company (+owner), TechCorp (+admin),
Nexus (+admin) — then give TechCorp at least one row each of: contact, lead,
event, follow-up, document (with one version), scan, team, department, and
organization. Give TechCorp/Nexus generous subscription limits (the suites
create hundreds of rows). Insert via `@workspace/db` the way
`scripts/src/seed-demo.ts` does, or via the API as the TechCorp admin.

## 5. Running the stack (three processes)

The web client calls the API via **relative `/api` paths** and both test suites
target `http://localhost:80`, so web + API must share one origin — the same
role the Replit gateway / self-host nginx plays. Use the bundled dev gateway:

```bash
# terminal 1 — API (in-process workers + schedulers start automatically)
PORT=8080 pnpm --filter @workspace/api-server run dev

# terminal 2 — web dev server (HMR)
PORT=3000 BASE_PATH=/ pnpm --filter @workspace/web-app run dev

# terminal 3 — same-origin gateway on :80  (/api/* → :8080, else → :3000)
pnpm --filter @workspace/scripts run dev-gateway
```

Gateway overrides: `GATEWAY_PORT`, `API_UPSTREAM`, `WEB_UPSTREAM`. On Linux,
binding port 80 needs root or `CAP_NET_BIND_SERVICE`; on Windows, an elevated
terminal.

Verify:

```bash
curl http://localhost:80/api/healthz   # {"status":"ok"}
curl http://localhost:80/api/readyz    # database "ok"; storage "not_configured" is expected without GCS
# browser: http://localhost:80 → login page; demo login buttons appear in dev builds
```

## 6. Mobile app (Expo)

```bash
cd artifacts/mobile
PORT=8081 EXPO_PUBLIC_API_URL="http://<YOUR-LAN-IP>:8080" pnpm exec expo start --lan --port 8081
```

- The package's `dev` script interpolates Replit variables (they expand empty
  off-Replit) and uses `--localhost`; for a physical device prefer the direct
  `expo start --lan` above.
- `EXPO_PUBLIC_API_URL` must be the **computer's LAN IPv4** (pattern
  `http://<LAN-IP>:<API-PORT>`, e.g. `http://192.168.1.20:8080`) — a physical
  phone cannot reach your `localhost`. Point it at the API port directly.
- Camera/NFC/push need an Expo **dev-client or EAS build** — not Expo Go. Do
  not build APKs during normal development.

### Windows: LAN access & firewall (documented — verify on the Windows machine)

1. `ipconfig` → note the IPv4 address of the active adapter.
2. Allow inbound connections to the API port once, in an elevated PowerShell:
   ```powershell
   New-NetFirewallRule -DisplayName "LeadCapturePro dev API" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080 -Profile Private
   ```
3. Phone and computer must be on the same Wi-Fi network, and the network
   profile should be **Private**.
4. Do **not** port-forward or otherwise expose the development API to the
   internet.

## 7. Typechecks, tests, builds — expected baseline

```bash
pnpm run typecheck                              # all packages — PASS
pnpm --filter @workspace/api-server run test    # 1210 tests; 1210/1210 only with storage configured (see note)
pnpm --filter @workspace/web-app run test:e2e   # 142/142 (needs the Batch 20 billing env, §3)
pnpm --filter @workspace/mobile run test        # 114/114
pnpm --filter @workspace/api-server run build   # PASS → dist/index.mjs
pnpm --filter @workspace/web-app run build      # PASS → dist/public (env-free)
```

> **Object-storage-gated subset:** 27 of the API tests exercise GCS-backed
> uploads (document upload/download/versioning, the stored-scan-image
> reprocess, executive report export artifacts). Without object-storage
> credentials the local result is **1173 passed / 9 failed / 28 skipped of
> 1210 — the 9 failures and 18 of the skips are that storage subset; everything
> else green**. Configure the GCS vars from `.env.example` §1d (dev bucket +
> service account, never production) to reach a fully green run.

**API suite rules** (`artifacts/api-server/vitest.config.ts`): it is an
integration suite against the **live** API at `http://localhost:80/api` — the
full stack (§5) must be up, and the vitest process itself needs `DATABASE_URL`
and `SESSION_SECRET` exported. The login rate limiter is **stateful in the
server process**: restart the API server first, then run the suite **exactly
once**; repeat runs against the same process yield spurious 429s.

**Playwright** (`artifacts/web-app/playwright.config.ts`): needs the stack up,
`DATABASE_URL` exported (global-setup talks to Postgres directly), and — off
NixOS — `PW_CHROMIUM_PATH=/path/to/chrome`. Target override: `E2E_BASE_URL`
(default `http://localhost:80`).

**Mobile suite**: pure unit tests, no server or DB needed.

## 8. AI during development — stub vs live Gemini

- Normal runs never call live Gemini. The deterministic **stub provider**
  (`src/ai/providers/stub.ts`) registers automatically when
  `NODE_ENV !== "production"`; a tenant opts in via
  `PATCH /api/ai/settings {"provider":"stub","model":"stub-model"}` (the test
  suites do this themselves). Failure modes: `stub-fail`, `stub-timeout`, etc.
- **Controlled real-Gemini verification** (opt-in, deliberate):
  set `GEMINI_API_KEY`, then run
  `pnpm --filter @workspace/api-server exec tsx scripts/verify-ocr-live.ts`.
  Never wire live Gemini into the normal suites.

## 9. Safe restart

```bash
# stop: Ctrl-C each process (or kill the node processes)
# start again in order: API → web → gateway (web/gateway have no state)
# after schema edits: pnpm --filter @workspace/db run push, then restart the API
# ALWAYS restart the API before an API test run (rate-limiter state)
```

## 10. Common errors

| Symptom | Cause / fix |
|---|---|
| API exits: `PORT ... not set` | `PORT` is required — export it (`resolvePort()` throws) |
| API exits: `SESSION_SECRET is not set` / `DATABASE_URL must be set` | export both before starting |
| Web dev server exits immediately | the **dev server** (not build) requires `PORT` and `BASE_PATH` |
| Tests: many 401s "login failed" | verification accounts missing — §4 |
| Tests: `no seeded tenant-A row for <resource>` | TechCorp is not company id 2, or fixture rows missing — §4 |
| Tests: spurious 429s | API served a previous run — restart it, run once |
| Playwright: browser launch error | set `PW_CHROMIUM_PATH` to a real Chromium binary |
| Uploads fail, `readyz` storage `not_configured` | expected without GCS credentials; harmless for dev |
| Email "skipped (not configured)" | expected without `SMTP_*`; honest no-op |
| `EADDRINUSE` on :80 | another gateway/process on port 80, or missing privilege to bind 80 |
| Playwright: every test times out in `page.goto` waiting for `load`, though the page renders | Restricted-network environments only (containers/CI without direct internet): the app's Google-Fonts stylesheets (`index.html`, `src/index.css`) hang, and Chromium on Linux also honors `http_proxy`/`https_proxy` env with nondeterministic timing. Fix: run the suite with proxy env unset (`env -u HTTP_PROXY -u HTTPS_PROXY …`) and, if there is no direct egress, blackhole `fonts.googleapis.com`/`fonts.gstatic.com` to `127.0.0.1` in `/etc/hosts` so they fail instantly. Normal machines with direct internet are unaffected |

## 11. What runs where

| Concern | URL |
|---|---|
| Web app (through gateway) | `http://localhost:80` |
| API (through gateway) | `http://localhost:80/api` |
| API direct | `http://localhost:8080/api` |
| Web dev server direct (HMR) | `http://localhost:3000` |
| Physical device → API | `http://<LAN-IP>:8080` |

## 12. Verifying there is no Replit runtime dependency

1. Start the API with **no** `REPL_ID`/`REPLIT_*` variables → boots clean;
   `healthz`/`readyz` OK (storage `not_configured` only).
2. `grep -rn "REPLIT_\|REPL_ID" artifacts/api-server/src lib` — every consumer
   is optional-with-fallback (`config.ts` `APP_BASE_URL` fallback,
   `objectStorage.ts` sidecar detection, `cards.ts` public-URL fallback).
3. The web `vite.config.ts` loads `@replit/*` dev plugins only when `REPL_ID`
   is set. The only genuinely Replit-shaped requirement is in
   `artifacts/mobile/scripts/build.js` (mobile web export), which needs
   `EXPO_PUBLIC_DOMAIN` as the portable escape hatch — irrelevant to API/web
   development and tests.
