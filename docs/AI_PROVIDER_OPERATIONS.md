# AI providers — operator guide (Claude + Gemini keys on the VPS)

How to give the API server its AI provider keys, check that they are in place, rotate
them and take a provider out of service. Design and rules:
[`AI_PROVIDER_MANAGEMENT.md`](AI_PROVIDER_MANAGEMENT.md).

**Status:** written with the feature (2026-11-20). **Nothing in this guide has been
performed on the hosted stack** — no key has been configured and no provider has been
called. It is the procedure for the release-preparation stage, to be carried out by the
operator on the VPS.

---

## 1. Rules that do not bend

- A provider key lives in **one place**: the API server's runtime environment file on the
  VPS (see `docs/HOSTINGER_VPS_DEPLOYMENT.md` for where that file is). It is owned by the
  service account and must stay mode `600`; the deploy script refuses to run otherwise.
- **Never** put a key in Git, in a GitHub secret or variable, in a compose file, in a
  workflow, in a ticket, in chat, in an email, in a screenshot, or in the web portal. The
  portal has no field for one, by design.
- **Never** paste a key into a shell command line (`echo KEY=… >> file`, `export KEY=…`):
  it ends up in the shell history and in the process list. Edit the file with an editor.
- Use a **dedicated key per environment** (development VPS ≠ production). Do not reuse a
  personal key, and never use a production key on the development stack.
- The mobile app and the browser never hold a key. If a key ever appears outside the VPS
  env file, treat it as leaked: revoke it at the provider first, then replace it (§5).

Two different things are configured in two different places:

| What | Where | Needs a restart / deployment |
| --- | --- | --- |
| **The keys** (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) | VPS runtime env file | Restart of the `api` container |
| **Which provider serves requests** — enabled, primary, fallback, model, limits, company overrides | Platform → Settings → AI Providers | **No.** Applies to the next request |

A provider without a key is skipped, whatever the settings say. A provider the Platform
Owner disabled is not used, whatever keys exist.

## 2. Before the first key

1. The release that contains this feature is deployed (`develop`), and the
   `platform_settings` table exists — `lib/db/migrations/0042_platform_settings.sql`,
   applied under its own authorization *after* the `0040` release, with the release guards
   re-pinned (see `AI_PROVIDER_MANAGEMENT.md` §10). Until the table exists the settings
   page is read-only and shows the default policy.
2. The scheduled backup-health check is green, and a fresh backup exists.
3. In each provider's own console, on the account or workspace the key belongs to:
   - **Anthropic** (`console.anthropic.com`): create a workspace for this environment,
     create an API key in it, and set a **monthly spend limit** for the workspace.
   - **Google** (`aistudio.google.com`): create an API key for a project dedicated to this
     environment, and set a **budget / quota** on that project.
   The spending limits in Settings → AI Providers are this platform's own estimate-based
   guard; the provider-side limit is the hard ceiling. Set both.

## 3. Configure a key

On the VPS, as the service account that owns the stack:

1. Open the runtime env file in an editor (not with `echo`):

   ```bash
   sudoedit <path of the runtime env file>      # see docs/HOSTINGER_VPS_DEPLOYMENT.md
   ```

2. Set the variable on its own line, with nothing around the value:

   ```
   ANTHROPIC_API_KEY=<the key>
   GEMINI_API_KEY=<the key>
   ```

   No quotes, no spaces, no trailing comment. Leave a variable empty (`ANTHROPIC_API_KEY=`)
   to mean "no key".

3. Confirm the file is still private — this prints the mode and the owner, **not** the
   content:

   ```bash
   stat -c '%a %U:%G' <path of the runtime env file>     # must print 600 and the service account
   ```

4. Restart **only** the API container so it reads the new environment (from the stack's
   `docker` directory, with the same two compose files the deploy script uses):

   ```bash
   docker compose -f docker-compose.yml -f compose.vps.yml up -d --no-deps api
   ```

   A plain `restart` does **not** re-read the env file; `up -d` recreates the container.

5. Confirm the container has the variable **without printing it**:

   ```bash
   docker compose -f docker-compose.yml -f compose.vps.yml exec api \
     sh -c 'for v in ANTHROPIC_API_KEY GEMINI_API_KEY; do eval "x=\${$v:-}"; [ -n "$x" ] && echo "$v: set" || echo "$v: empty"; done'
   ```

Do not run `docker compose config`, `docker inspect` or `env` in a shared terminal or a
recorded session: they print the values.

## 4. Check it in the portal

Sign in as a Platform Owner → **Settings → AI Providers**.

| The provider's "API key" line shows | Meaning | What to do |
| --- | --- | --- |
| **No key on the server** | The API process has no value for the variable. | §3 — check the variable name, that the file was saved, and that the container was recreated. |
| **Key present** | A key is loaded. It has not been used since the API started. The page makes no test call. | Make one real request (below). |
| **Key verified** | The provider accepted the key on the most recent request. | Nothing. |
| **Key rejected** | The provider answered 401 / 403. | The key is wrong, revoked, or lacks access to the selected model — replace it (§5). Meanwhile, with automatic fallback on, the other provider serves. |
| **Account stopped by provider** | The provider reported a billing problem or that the account's spend limit is reached. | Resolve it in the provider's console (payment method, credits, spend limit). Until then requests routed to this provider fail and are **not** moved to the other provider — make the other provider primary in Settings to keep AI running. |

This status is kept in the API's memory: after every restart it starts again at "Key
present" until the next real request. A rejected key and a stopped account are also sent
to every platform owner as an in-app notification (once per provider and kind per day).

**First real request.** Performed once, deliberately, by the operator — it is billable
(a few cents at most). Use the opt-in verification procedure of the release plan
(`AI_PROVIDER_MANAGEMENT.md` §14 step 5), or scan one test business card with a test
account. Then confirm on the settings page: "Key verified", one request under "This
month" for the provider that served it, and a small estimated cost. Normal automated
test runs never call a provider.

The top of the page states what serves requests right now, for example *"Claude
(claude-opus-5-5) serves requests; Gemini (gemini-2.5-flash) is tried once when it
cannot."*, with a note for every provider that is disabled or has no key.

## 5. Rotate or replace a key

1. Create the new key at the provider.
2. Replace the value in the env file (§3 steps 1–4). There is a brief restart of the API
   container; requests in flight during it fail and can be retried.
3. Verify (§4), then **revoke the old key** at the provider.

To avoid any AI interruption during the rotation of one provider's key: make sure the
other provider is enabled, has a verified key and automatic fallback is on. Requests are
then served by the other provider while the first one's key is being replaced.

If a key may have leaked: revoke it at the provider **first**, then do steps 1–3.

## 6. Take a provider out of service

| Goal | How | Effect |
| --- | --- | --- |
| Stop using a provider now | Settings → AI Providers → switch it off (confirm) | Immediate. It serves nothing: not as primary, not as fallback, not for a pinned company. No restart. |
| Prefer the other provider | Settings → change the primary (confirm) | Immediate. |
| Remove the key | Empty the variable in the env file, recreate the `api` container | The provider is skipped. If it was the only usable one, AI answers `503` and manual, QR and NFC capture keep working. |

**Rollback to "Gemini only", as before this feature:** switch Claude off in Settings, or
leave `ANTHROPIC_API_KEY` empty. Either is enough; neither needs a code change.

## 7. Spending

- Settings → AI Providers shows month-to-date **estimated** cost per provider and model
  (from token usage and the built-in price table), and an optional monthly limit per
  provider with an alert threshold. Once a limit is reached, requests routed to that
  provider are refused for the rest of the month — they are **not** moved to the other
  provider. Raising or removing the limit takes effect at once.
- Platform owners receive a notification when a provider approaches and when it reaches
  its limit.
- The figures are estimates. The provider's console is the record of what is billed;
  compare the two after the first week.
- If a provider changes its prices, the price table can be overridden per model with the
  `AI_PRICE_…` variables listed in `.env.example`, and `AI_PRICING_VERSION` must be bumped
  with it.

## 8. Troubleshooting

| What users see | Code | Cause | Action |
| --- | --- | --- | --- |
| "AI features are not configured for this environment…" | `503 AI_NOT_CONFIGURED` | No enabled provider has a key, or both providers are disabled. | §3, or enable a provider in Settings. |
| "AI card reading is temporarily unavailable. You can still add the contact manually…" | `503 AI_PROVIDER_UNAVAILABLE` | The provider (and the fallback, if allowed) did not serve: outage, rate limit, timeout, rejected key, or a stopped provider account. | Check the provider's status page and the "API key" line (§4). During a long outage of the primary, make the other provider primary in Settings (immediate). Failed scans can be reprocessed afterwards. |
| "…the platform's monthly AI spending limit has been reached…" | `503 AI_PLATFORM_LIMIT_REACHED` | The provider's limit in Settings is reached. | Raise the limit, or wait for the month to end. |
| "AI is not available right now. Please contact your administrator." | `503 AI_MODEL_UNPRICED` | The selected model has no price while a budget or limit applies (a price override was removed). | Restore the price, or select another model. |
| "Monthly AI … budget exhausted for your organization" | `429 AI_BUDGET_EXCEEDED` | That company's own budget or plan allowance. | Not a provider problem. |
| "Could not read the card. Please retake the photo." | `502` | The provider answered, but not with a usable result, refused the image, or rejected the request (for example a model the key has no access to). | Retake; if every scan fails this way, look at the error category in the AI ledger — `provider_rejected` points at the selected model or the account, not at the photos. |

In the API log, AI failures appear as `AI request failed` with a `context` and a short
provider message; a fallback appears as `AI provider could not serve the request; trying
the fallback provider once`. Neither contains a key, a prompt or an image.

The AI ledger (Platform → AI Intelligence, and `ai_invocations`) has one row per attempt
with its provider, model, status and error category; the fallback attempt of a request has
the request id suffixed `-fb1`.

## 9. What this guide deliberately does not do

It does not apply a schema change, deploy, change a release guard, dispatch a workflow or
trigger a mobile build. Each of those is its own authorized step of the release plan.
