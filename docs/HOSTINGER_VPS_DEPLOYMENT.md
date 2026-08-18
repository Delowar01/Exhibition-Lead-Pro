# Hostinger VPS Deployment — dev.kaptnow.com

GitHub-driven deployment of the development environment to the existing
Hostinger VPS (Ubuntu 24.04, CloudPanel). This reuses the repo's self-hosting
Docker stack (`docker/`) unchanged except for VPS port publication — it is not
a second deployment system.

## 1. Architecture

```
Browser ── https://dev.kaptnow.com
              │  CloudPanel nginx (TLS, ports 80/443 — shared with the
              │  existing website; never touched by this stack)
              ▼
        http://127.0.0.1:18080         ← ONLY port this stack publishes
              │  web container (nginx: static SPA + /api proxy)
              ▼
        api container :8080            ← internal to the Docker network,
              │                          never published on the host
              ▼
        Neon PostgreSQL (external, development branch)
```

- Compose files: `docker/docker-compose.yml` + `docker/compose.vps.yml`
  (override pins `web` to `127.0.0.1:18080:80` and removes the `api` port).
- Bundled PostgreSQL, Redis and the `migrate` one-shot stay behind compose
  profiles; the VPS env keeps `COMPOSE_PROFILES=` **empty**, and the deploy
  script refuses to run if anything beyond `api web` would start.
- VPS paths: app checkout `/opt/lead-capture-pro/app` (branch `develop`,
  deploy user `leadpro`), runtime env `/opt/lead-capture-pro/env/.env`.

## 2. Branch & deployment strategy

```
export-ready (protected approved baseline)
   └─ develop (created from export-ready after this infrastructure is approved)
        ├─ claude/batch-XX  → review/tests → merge to develop
        └─ every push to develop → GitHub Actions → VPS → dev.kaptnow.com
```

- Only `develop` deploys automatically. Feature branches, `export-ready` and
  the historical `main` are never auto-deployed (workflow guard enforces it).
- Local dev remains per `docs/LOCALHOST_DEVELOPMENT.md`; the pre-merge gate
  (full API + Playwright suites) still runs on a developer machine.

## 3. GitHub Actions flow (`.github/workflows/deploy-dev-vps.yml`)

Triggers: push to `develop`; `workflow_dispatch` (deploy step still runs only
for the `develop` ref). Sequence:

1. **verify** — pnpm 10.26.1 (from `packageManager`) on Node 24.13.0, frozen
   install, `typecheck:libs`, API/web/mobile typechecks, the mobile unit suite
   (107 tests, infra-free), API + web production builds.
   *Honest limitation:* the API integration suite (728) and Playwright (43)
   need a live seeded stack (Postgres, API on :80, Chromium, GCS for the
   storage subset) and are deliberately **not** run on the hosted runner —
   they are not faked, they remain the developer-machine pre-merge gate.
2. **deploy** — installs the SSH key from `VPS_SSH_KEY`, pins the host key
   from `VPS_KNOWN_HOSTS` (`StrictHostKeyChecking=yes`; never `=no`), then
   over SSH: fetch, detach-checkout the exact `GITHUB_SHA`, run
   `docker/scripts/deploy-vps.sh <sha> develop`.

Repository secrets used: `VPS_HOST`, `VPS_PORT`, `VPS_USER`,
`VPS_DEPLOY_PATH`, `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS`. Application runtime
secrets are **never** stored in GitHub.

## 4. VPS runtime environment file

- Real file: `/opt/lead-capture-pro/env/.env` — owner `leadpro`, `chmod 600`.
- Symlink (so the existing compose reads it unchanged):
  `ln -s /opt/lead-capture-pro/env/.env /opt/lead-capture-pro/app/docker/.env`
- Template with every supported variable: `docker/.env.vps.example`
  (placeholders only). Key values: `COMPOSE_PROFILES=` (empty),
  `DATABASE_URL` (Neon dev, `sslmode=require`), `SESSION_SECRET`,
  `APP_BASE_URL=https://dev.kaptnow.com` (the primary base-URL source in
  `config.ts` — email/reset/invite links), `TRUST_PROXY=2` (CloudPanel nginx +
  stack nginx), CORS unset (same-origin production default). **No `REPLIT_*`
  variable is set.** The one code path that does not read `APP_BASE_URL` —
  the card-share URL builder (`routes/cards.ts` `publicBaseUrl`) — derives
  its origin from `X-Forwarded-Proto` + `Host`, which arrive intact because
  the stack's nginx passes the edge value through (below).

### HTTPS protocol preservation across both proxies

TLS terminates at CloudPanel; the CloudPanel → `127.0.0.1:18080` hop is HTTP.
`docker/nginx/default.conf.template` therefore maps `X-Forwarded-Proto`:
when the incoming request already carries one (the CloudPanel hop), it is
forwarded **unchanged**; only when absent (direct self-hosting, where this
container is the first hop) does it fall back to the local `$scheme`. Header
trust stays where it belongs: the API honors forwarded headers only from the
`TRUST_PROXY=2` hops, so a client-injected value never becomes `req.ip` /
`req.protocol` on the VPS (the loopback-only binding means all traffic passes
through CloudPanel anyway).

### First-deployment proxy verification (mandatory, evidence-based)

`TRUST_PROXY=2` assumes exactly two hops (CloudPanel nginx → stack nginx).
On the **first** hosted deployment, confirm all four points with existing
surfaces — no public debug endpoint; remove anything temporary afterwards:

1. **`req.protocol` = https** — log in at `https://dev.kaptnow.com`, open
   *My Card*: the generated `publicUrl` must start `https://dev.kaptnow.com`
   (that value is built from the forwarded proto + host).
2. **Secure cookies** — in browser dev-tools (or `curl -v` against
   `/api/auth/login`), the `csp_refresh`/CSRF `Set-Cookie` headers must carry
   `Secure` and the browser must retain them (NODE_ENV=production sets the
   flag; retention over https proves end-to-end TLS routing).
3. **Real client IP** — log in from a known external connection, then check
   the recorded session/audit IP (web *Sessions* page, or
   `docker compose logs api` pino entries). It must equal your real public
   IP — not `127.0.0.1`, not a `172.x` Docker bridge address, not the VPS's
   own IP.
4. **Spoof rejection / rate-limit identity** — from outside, send
   `curl -H "X-Forwarded-For: 203.0.113.99" https://dev.kaptnow.com/api/auth/login …`
   with a wrong password once: the recorded attempt IP must still be your
   real IP, never `203.0.113.99`. Rate limiting keys off the same `req.ip`,
   so this simultaneously validates lockout/rate-limit identity.

If any check fails, count the actual hops and adjust `TRUST_PROXY` based on
that evidence (e.g. an unexpected extra internal proxy ⇒ 3), then re-verify.
- `.env` is gitignored at every depth; the deploy script hard-fails if
  `docker/.env` ever becomes git-tracked or loses `chmod 600`.

## 5. Deployment script (`docker/scripts/deploy-vps.sh`)

`bash docker/scripts/deploy-vps.sh <git-sha> [branch=develop]` — fail-fast
(`set -euo pipefail`), and in order: precondition checks (env file, perms,
untracked), fetch + verify the SHA is on `origin/<branch>`, refuse a dirty
tree, detach-checkout the exact SHA, **compose service guard** (only `api web`
may resolve), `compose build api web`, `compose up -d --no-deps api web`,
then health checks through the loopback gateway with retries:

- `http://127.0.0.1:18080/healthz` — web nginx alive
- `http://127.0.0.1:18080/api/healthz` — API alive through the proxy
- `http://127.0.0.1:18080/api/readyz` — database reachable

Success records the SHA to `/opt/lead-capture-pro/env/current-deploy.sha`
(previous good → `previous-deploy.sha`) and prints concise `compose ps`.
It never prunes, never touches volumes, never runs `down -v`, and never
touches containers outside the `card-scanner-pro` compose project.

**Shared-VPS build safety:** the VPS has 2 vCPUs and hosts another live
website, so the script builds the api and web images **sequentially**
(`COMPOSE_PARALLEL_LIMIT=1` plus one `compose build` per image) — no parallel
build spikes. No runtime CPU/RAM limits are imposed on the containers; add
them only if real measurements ever show contention.

## 6. Rollback

A failed health check exits non-zero (the Actions run turns red — a failed
deployment can never look green) and automatically attempts one rollback to
the previous known-good SHA (`NO_AUTO_ROLLBACK=1` disables). Manual rollback
is one command:

```bash
bash docker/scripts/deploy-vps.sh "$(cat /opt/lead-capture-pro/env/previous-deploy.sha)" develop
```

## 7. Neon development database

- Create a **dedicated development** Neon project/branch (never production
  data, never CloudPanel's MySQL). Use the pooled connection string with
  `sslmode=require` as `DATABASE_URL`.
- Before the first schema push: prove the URL is the dev database (host and
  database name only — never print credentials), then get explicit approval.
- Schema sync uses the project's existing command, via the existing one-shot
  compose profile on the VPS:
  `docker compose -f docker-compose.yml -f compose.vps.yml --profile migrate run --rm migrate`
  (equivalent of `pnpm --filter @workspace/db run push`). Not run during
  infrastructure preparation.
- The API/e2e suites additionally expect the four verification tenants of
  `docs/LOCALHOST_DEVELOPMENT.md` §4 if suites are ever pointed at this DB.

## 8. GCS development bucket (closes the 27 storage-gated tests)

Configure later, with a **dedicated development bucket** (no production
bucket, no public bucket, no second storage implementation). Least privilege
for the chosen credential method:

1. Create the bucket + a dedicated development service account. Grant
   **only** `roles/storage.objectAdmin` **scoped to that one bucket** — the
   application creates, reads, overwrites and deletes objects (card images,
   documents/versions, export artifacts), so full object CRUD on the bucket
   is the actual requirement. No project-wide roles, no bucket-admin role.
2. Credential method here is a **service-account JSON key mounted read-only**
   (`GOOGLE_APPLICATION_CREDENTIALS`). With a local private key, the storage
   SDK signs V4 signed URLs **locally** — `iam.serviceAccounts.signBlob` /
   `roles/iam.serviceAccountTokenCreator` is **not required** and must not be
   granted for this path. That role is needed only by keyless setups (ADC via
   metadata server or impersonation, e.g. the Replit sidecar path), which
   this deployment does not use. Never grant permissions the chosen
   implementation does not exercise.
3. Put the JSON key at `/opt/lead-capture-pro/env/gcs-service-account.json`
   (`chmod 600`), uncomment the read-only volume mount in
   `docker/compose.vps.yml`, and set in the VPS env file:
   `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PUBLIC_OBJECT_SEARCH_PATHS`
   (`/<bucket>/public`), `PRIVATE_OBJECT_DIR` (`/<bucket>/.private`),
   `GOOGLE_APPLICATION_CREDENTIALS=/secrets/gcs-service-account.json`.
4. `readyz` then reports storage `ok`; the API baseline target returns to a
   literal **728/728** (storage failures are fixed by configuration, never by
   skipping tests).

## 9. CloudPanel reverse proxy (manual, after approval)

Do not modify the existing website or its vhost. In CloudPanel:

1. **Add site** → type **Reverse Proxy**. Domain: `dev.kaptnow.com`.
   Reverse-proxy URL: `http://127.0.0.1:18080`.
2. Issue the SSL certificate (CloudPanel → the site → SSL/TLS → New
   Let's Encrypt Certificate) once DNS resolves.
3. Headers: CloudPanel's reverse-proxy template already sends `Host`,
   `X-Forwarded-For` and `X-Forwarded-Proto`; nothing extra is required. The
   app does not use WebSockets in production (Vite HMR is dev-only), so no
   WebSocket upgrade config is needed.
4. Verify: `curl -I https://dev.kaptnow.com/healthz` → `200 ok`, then
   `https://dev.kaptnow.com/api/healthz` and `/api/readyz`, then the login
   page in a browser.

## 10. DNS (manual)

Add exactly one record — do not touch `@`, `www`, or any other record:

| Type | Host | Value | TTL |
|---|---|---|---|
| A | `dev` | `187.127.163.196` | default |

## 11. Existing-website safety rules (permanent)

- This stack publishes **only** `127.0.0.1:18080`. Never bind 80/443/8443,
  never use 18000, never `0.0.0.0:18080`.
- Never modify CloudPanel global config, the existing site's vhost, MySQL,
  the VPS Redis, or `elite-marcom.service`; never stop nginx; never restart
  CloudPanel without explicit approval.
- Never run `docker system prune`, `docker volume prune`, or
  `docker compose down -v`; never touch other projects' containers,
  networks, volumes or firewall rules.

## 12. First-deployment checklist (manual steps that remain)

1. Approve + merge this infrastructure branch; create `develop` from the
   approved baseline (maintainer action).
2. On the VPS as `leadpro`: create `/opt/lead-capture-pro/env/.env` from
   `docker/.env.vps.example` (real values, `chmod 600`) + the `docker/.env`
   symlink.
3. Create the Neon development database; set `DATABASE_URL`; approve and run
   the first schema sync (§7); bootstrap demo/verification data as desired.
4. Add the DNS record (§10); create the CloudPanel reverse-proxy site + SSL
   (§9).
5. Push to `develop` (or run the workflow manually) and watch the Actions
   log; verify `https://dev.kaptnow.com/api/readyz`.
6. Run the first-deployment proxy verification (§4) and adjust `TRUST_PROXY`
   only if the evidence demands it.
