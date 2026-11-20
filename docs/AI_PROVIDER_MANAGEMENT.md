# AI provider management — Claude + Gemini under the Platform Owner's control

**Status (2026-11-20):** implemented and verified **locally** on
`claude/platform-ai-provider-management` (stacked on `claude/launch-pricing-ui-corrections`,
PR #9). **Not merged, not deployed, not hosted.** No schema change has been applied to any
hosted database, no provider key exists in any environment this work touched, and **no call
was made to Claude or to Gemini** — every test runs on the deterministic test engine or on
a fake client. Live verification is release-preparation work (§14).

Operator procedure for the keys: [`AI_PROVIDER_OPERATIONS.md`](AI_PROVIDER_OPERATIONS.md).

---

## 1. What changed, in one paragraph

The Enterprise AI Layer has a second provider, **Anthropic (Claude)**, next to Google
(Gemini). Which of the two serves a request is no longer a deployment setting or a tenant
setting: it is the **Platform Owner's AI provider policy**, edited in
**Platform → Settings → AI Providers**, stored durably, audited, and applied to the next
request without a deployment. When the provider in use cannot answer, the other enabled,
configured provider is tried **once**. Budgets, plan allowances, spending limits, disabled
features, permissions and a provider's refusal of the content are never worked around by
that fallback.

## 2. What the Platform Owner controls

| Setting | Meaning |
| --- | --- |
| Claude enabled / Gemini enabled | A disabled provider serves **no** request: not as primary, not as fallback, not for a pinned company. |
| Primary provider | Serves every company that has no override. |
| Automatic fallback | When the provider in use cannot answer (§5), try the other one once. |
| Model, per provider | One of the provider's selectable models; each has a price (§8). |
| Monthly spending limit, per provider | US dollars per calendar month across the whole platform; empty = no limit (§6.3). |
| Alert threshold | Platform owners are notified at this share of a limit, and again when it is reached. |
| Company overrides | Pin a company to one provider (optionally one of its models). |

Shown, read-only, per provider: whether a key is on the server and what the provider last
said about it (§11), the model price, and month-to-date requests, failures, requests served
as fallback, tokens and estimated cost from the AI ledger.

**Defaults** (what applies while nothing has been saved — the owner's stated preference):
Claude enabled, Gemini enabled, primary **Claude**, automatic fallback **on**, no limits.
Because a provider without a key is skipped (§4 rule 4), an environment that has only a
Gemini key keeps running on Gemini exactly as before until a Claude key is configured.

## 3. Architecture

```
feature function (extractCardData, scoreLead, composeEmail, …)        lib/ai.ts
  └─ callJson / callJsonWithMeta — the ONE execution seam
       1. AI rate limit
       2. tenant gates (enabled, feature flag)              services/ai.service.ts
          → resolve the provider chain                      services/platform-ai.service.ts
                                                            ai/policy.ts  (pure rule)
       2b. readiness gate — nothing usable → 503 AI_NOT_CONFIGURED
       3. duplicate protection
       4-6. executeProviderCall: for each candidate (at most two)
              a. unpriced model refused where a cost is enforced
              b. platform spending limit admission
              c. tenant budget reservation
              d. provider call                              ai/providers/{anthropic,gemini,stub}.ts
              e. ledger row (ai_invocations), release, settle
            next candidate ONLY after a provider outage (§5)
```

| File | Role |
| --- | --- |
| `artifacts/api-server/src/ai/providers/anthropic.ts` | Claude adapter on the official SDK (`@anthropic-ai/sdk`). |
| `…/ai/providers/gemini.ts` | Gemini adapter — unchanged. |
| `…/ai/providers/stub.ts` | Deterministic engine: the test provider, and (outside production) a named provider on a test model. |
| `…/ai/providers/index.ts` | Registry; `providerFor(name, model)`. |
| `…/ai/types.ts` | `AiProviderError` — typed provider failures. |
| `…/ai/runner.ts` | Failure categories; `isFallbackEligible`. |
| `…/ai/policy.ts` | The policy, its validation, the resolution rule, the availability impact. Pure. |
| `…/ai/pricing.ts` | Cost estimate incl. the long-context tier; reservation ceiling. |
| `…/repositories/platform-settings.repository.ts` | `platform_settings` read / transactional write + audit; platform-wide ledger sums. |
| `…/services/platform-ai.service.ts` | Policy cache, readiness, limits, alerts, status, update. |
| `…/routes/platform-ai.ts` | `GET` / `PUT /api/v1/platform/ai/providers` (platform owner only). |
| `…/lib/ai.ts` | The seam: chain execution, single fallback, per-attempt accounting. |
| `artifacts/web-app/src/components/platform/AiProvidersSettings.tsx`, `src/lib/ai-providers.ts` | The settings page and its logic. |
| `lib/db/src/schema/platform_settings.ts`, `lib/db/migrations/0042_platform_settings.sql` | Storage (§10). |

No second AI system was added: Claude is one more adapter behind the existing seam, and
every feature — card extraction from an image, scoring, enrichment, assignee
recommendation, insights, Sales Copilot, workflow intelligence, executive intelligence,
the Assistant — reaches it through the same code path as before. API contracts of the
existing AI endpoints are unchanged.

## 4. The resolution rule (`ai/policy.ts` → `resolveChain`)

1. A tenant on the deterministic **test provider** uses it, alone. This exists outside
   production only; in production the test provider is not registered and rule 2 applies.
2. Otherwise the order of preference is the company's **override** provider (when the
   Platform Owner pinned the company *and* that provider is enabled), else the platform
   **primary** — followed by the other provider.
3. A **disabled** provider is removed. Nothing brings it back.
4. A provider **without a key** on the server is skipped.
5. The first that remains serves the request. The second is kept as the one fallback only
   when automatic fallback is on.

The result holds **at most two** candidates, never the same provider twice. With none,
the request is refused with `503 AI_NOT_CONFIGURED` before anything is reserved or called.

## 5. Fallback — what moves to the other provider and what never does

The fallback is attempted **once**, and only when the failure came from the provider call
itself and means *"this provider cannot serve right now"*:

| Failure of the provider in use | Other provider tried? |
| --- | --- |
| Outage / overload (5xx, 529), connection failure, timeout | **Yes**, once |
| Provider rate limit (429) | **Yes**, once |
| Provider rejected the platform's key (401 / 403) | **Yes**, once — the key is shown as *rejected* and the platform owners are notified |
| Input this provider cannot take — an image larger than it accepts or of a type it does not read (decided by the adapter, before any request) | **Yes**, once |
| Provider **refused the content** | **No** |
| Provider account stopped — billing error, 402, or a 429 whose code is a spend cap (Claude) | **No** — but reported to the user as "AI unavailable", shown as *account stopped*, and the platform owners are notified |
| Provider rejected the request (400, 404, 413 — unknown model, malformed request) | **No** |
| Unusable answer (not JSON, or JSON that is not an object) | **No** |
| **Tenant AI budget** exhausted, **plan allowance**, tenant AI or feature disabled, AI rate limit, permission (any rejection by this application) | **No** — decided before any provider is called |
| **Platform spending limit** of the provider reached | **No** — the request is refused, not rerouted |
| Model without a price where a cost is enforced | **No** |

Gemini reports rate limiting and quota exhaustion with the same answer
(`429 RESOURCE_EXHAUSTED`); the two cannot be told apart from it, so both are treated as a
rate limit and may fall back. Whether a stopped **Claude** account should fall back as
well is a decision for the owner (§13): today it does not, because the instruction limits
fallback to transient provider errors.

No loop is possible: the chain has two entries and the fallback's own failure is final.
Nothing but the provider call is repeated — callers run their side effects once, after
the seam returns, so a fallback cannot duplicate a scan, a contact, a draft or a
notification. The runner's own optional retries (`AI_MAX_RETRIES`, default 0) never
re-send a refusal, a rejected or unsupported request, a rejected key or a stopped
account to the same provider.

**Time.** The two attempts share one budget (`AI_FALLBACK_TOTAL_BUDGET_MS`, 50 s): the
fallback's timeout is shortened to what the primary left, so a primary that hangs for
its whole 30 s still leaves the fallback 20 s and the request ends before the reverse
proxy's 60 s. There is no circuit breaker: every request first waits for the primary
(§16).

When no provider served a card-reading request — it did not answer, rejected the key, or
its account is stopped — the client gets `503 AI_PROVIDER_UNAVAILABLE`: *"AI card reading
is temporarily unavailable. You can still add the contact manually, or capture it by QR
code or NFC."* instead of *"could not read the card, retake the photo"*. This includes a
provider **timeout**, which used to answer 502 with the retake message. The failed scan
and its image are kept, so **Reprocess OCR** recovers it later. Manual, QR and NFC
capture do not use AI and are not affected by any provider state.

## 6. Accounting

### 6.1 Ledger attribution

Every attempt writes its own `ai_invocations` row with **its** provider and model. The
primary's row carries the request id; the fallback's row carries `<request id>-fb1`.
"Served as fallback" on the settings page counts successful `-fb1` rows. A failed attempt
that consumed tokens (a refusal reports usage) is costed with them. The scan record and
every stored AI output (insight, Copilot draft, workflow recommendation, executive
summary, industry suggestion) are stamped with the provider and model that **actually**
produced them — the fallback provider when it answered — not with a configured value.

Tenant-facing figures count provider **calls**, as before, so a request served by the
fallback shows as two calls, one of them failed. Two tenant-facing consumers were
adjusted so that this does not mislead: the hourly *"High AI failure rate"* alert counts
**requests** (a failed first attempt whose fallback succeeded is not a failure), and a
refusal by the platform's spending limit is not counted in the tenant's own
"stopped by budget" figure.

### 6.2 Tenant budgets and plan allowances

Unchanged in substance, and applied **per attempt**: each attempt reserves against the
tenant's effective budget (its own budget capped by the plan allowance) under the existing
advisory lock, and releases after its ledger row is written. An exhausted budget refuses
the request before the primary is called and is never retried on the other provider. A
reservation is costed at the model's dearest price tier, so it cannot under-reserve.

### 6.3 Platform spending limits

Per provider, per calendar month, across all companies and system calls, in micro-dollars.
Admission uses the same rule as tenant budgets: refuse once month-to-date estimated spend
plus what running calls are holding has reached the limit. A refusal is
`503 AI_PLATFORM_LIMIT_REACHED`, recorded as `budget_denied` / `platform_limit`, and is
**not** moved to the other provider (a company pinned to the other provider is still
served by it). Alerts go to every active platform owner through the existing notification
system (category `ai`, link `/platform/settings`): *approaching* at the configured share,
*reached* at the limit — once per provider per day each, raised by the call that crosses
the threshold or by the first request the limit refuses. A hold is released on every way
out of a call, including an answer that cannot be read.

Saving a policy that would send requests to a provider **already at its limit** — a new
or lower limit, the provider switched back on, made primary, or a company pinned to it —
is held back for confirmation with that fact stated.

Figures are **estimates** from token usage and the price table (`pricingVersion` is
stamped on every row), not provider invoices. Holds for running calls are kept in the API
process and the month total is re-read from the ledger at most every 15 s
(`AI_PLATFORM_SPEND_CACHE_TTL_MS`), so with several API processes a limit could be
overshot by the calls in flight in the other processes. The hosted stack runs one API
process. A hard ceiling should also be set in each provider's own console (see the
operator guide).

### 6.4 Models without a price

A model with no price would be recorded at cost 0, so no cost budget or spending limit
could ever stop it. Such a model cannot be selected (every selectable model is priced, and
the policy validation refuses anything else), and as a last line of defence the seam
refuses it with `503 AI_MODEL_UNPRICED` wherever a tenant cost budget, a plan cost
allowance or a platform limit applies.

## 7. Tenant settings: precedence before and after

| | Before | Now |
| --- | --- | --- |
| Who chooses the provider | `ai_settings.provider` of each tenant (default `gemini`), editable by the tenant's primary admin | The Platform Owner's policy. The tenant's stored value **never selects a real provider**. |
| `ai_settings.provider` / `.model` | Used for the call | Kept as stored (no row is rewritten, no migration of tenant data). Honoured only for the test provider, outside production. |
| `PATCH /ai/settings {provider, model}` | Any registered provider; a priced model | Still accepted for compatibility: the provider must be one the Platform Owner **enabled** (or the test provider), the model one of that provider's models. It is stored and does not select the vendor. |
| `GET /ai/settings`, `GET /ai/health` | The stored provider; `configured` = Gemini key present | The provider and model that **serve the tenant now**; `configured` = some enabled provider can serve it. |
| Tenant controls — master switch, per-feature flags, token / cost budgets, workflow rules | Enforced | Enforced, unchanged, whichever provider is in use. |
| An explicit, permitted override | — | A **company override** set by the Platform Owner in the policy. |

The tenant's AI Settings page shows the provider and model as read-only text
("chosen by the platform"); the selector was removed because it no longer chose anything.

## 8. Anthropic integration — what is relied on, and its source

Read from Anthropic's documentation (`platform.claude.com/docs`) on 2026-11-20:

| Topic | Fact used | Page |
| --- | --- | --- |
| Model identifiers | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` (other models the API lists are not offered here) | Models overview |
| Prices, USD per million tokens (input / output) | Opus 5.5 **4 / 20**; Sonnet 5.5 **2 / 10**; Haiku 5.5 **0.10 / 0.50** for prompts up to 100,000 tokens and **0.50 / 2.50** above | Pricing |
| Images | JPEG, PNG, GIF, WebP as base64 image blocks; 10 MB per image on the Claude API; images before the text of the turn | Vision |
| Structured output | `output_config.format` with a JSON schema exists, limited to 24 optional and 16 nullable / union-typed parameters per schema | Structured outputs |
| Token accounting | total input = `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens`; `output_tokens` includes reasoning | Messages API |
| Refusals | HTTP 200 with `stop_reason: "refusal"` | Handling stop reasons |
| Errors | 401 / 403 credentials; 402 billing; 429 rate limit, or the account spend cap (`error.details.error_code`); 5xx / 529 transient | Errors |

Decisions that follow:

- **Default Claude model: `claude-opus-5-5`**, the default Anthropic's developer guidance
  recommends. It is the most capable and the dearest of the three offered; Sonnet 5.5 and Haiku 5.5 are one click
  away in Settings. Which model the product should run on is a cost / quality decision for
  the owner (§13).
- **JSON by instruction, not by schema.** The features' prompts already ask for one JSON
  object; the adapter adds a system line and the layer's tolerant parser reads the answer,
  exactly as for Gemini. Schema-constrained output was *not* adopted: the card-extraction
  shape has 26 nullable fields, above the documented limit of 16, so using it means
  reshaping that contract first. Recorded as a follow-up, not a defect.
- **Reasoning depth** is set with `output_config.effort` (default `low`,
  `AI_ANTHROPIC_EFFORT`). Claude Opus 5.5 always reasons, and reasoning is billed as
  output on every model. Because it counts toward `max_tokens`, a feature's small output
  cap is raised to at least 4,096 for Claude (`AI_ANTHROPIC_MIN_MAX_TOKENS`). The adapter
  sends no `thinking` field: Sonnet 5.5 and Haiku 5.5 have reduced-thinking modes that
  could lower cost and latency for the short structured calls of this product — an
  optimisation to evaluate in the live comparison, not used today. No sampling parameter
  is sent and no assistant prefill is used (the current models reject both).
- **Timeouts** are the existing ones (30 s for card extraction, 20 s for the other
  features). Whether they suit Claude with images and reasoning can only be judged live
  (§14).
- **Anthropic's own refusal fallback between models is not enabled.** A refusal is final
  (§5).
- **SDK retries are off** (`maxRetries: 0`): retrying belongs to the layer's runner and to
  the single fallback, so one request can never fan out into hidden repeats.
- The client's base URL is pinned by configuration, no ambient `ANTHROPIC_AUTH_TOKEN` /
  `ANTHROPIC_BASE_URL` of the host is honoured, and the SDK's log level is pinned to
  `warn` (at `debug` it would print request bodies — the prompt and the card image — to
  the console, outside the application's log redaction).
- **Images** are checked by the adapter against what the Claude API takes (JPEG, PNG,
  GIF, WebP; 10 MB base64-encoded). The application accepts images up to 10 MB of bytes,
  which is more than that once encoded: such an image is "input this provider cannot
  take" and goes to the other provider when fallback allows (§5), so it keeps working as
  it did on Gemini.

Prices live in `config.ts` (`config.ai.pricing`, env-overridable per model) under
`pricingVersion v2-2026-11-claude-gemini`. They must be re-checked against the provider's
price page at release time (§14).

**Dependency.** `@anthropic-ai/sdk` 1.10.0 is a direct dependency of the API. The SDK
imports `@opentelemetry/api`, which the API bundle keeps external, so that package is
declared as a direct dependency too (it is inert without a tracing SDK). The lockfile
consequently resolves `drizzle-orm` and `vitest` with that optional peer present; neither
changes behaviour.

## 9. Client-facing errors

| Status / code | When | Message shown |
| --- | --- | --- |
| `503 AI_NOT_CONFIGURED` | No enabled provider has a key (or both are disabled). Nothing reserved, called or recorded. | "AI features are not configured for this environment…" (existing) |
| `503 AI_PROVIDER_UNAVAILABLE` | Card reading: the provider (and the fallback where allowed) did not answer, rejected the key, or its account is stopped. | "AI card reading is temporarily unavailable. You can still add the contact manually, or capture it by QR code or NFC." |
| `503 AI_PLATFORM_LIMIT_REACHED` | The provider's monthly platform limit is reached. | "AI is not available right now: the platform's monthly AI spending limit has been reached." — on the capture paths followed by "You can still add contacts manually, by QR code or by NFC." |
| `503 AI_MODEL_UNPRICED` | §6.4 | "AI is not available right now. Please contact your administrator." |
| `429 AI_BUDGET_EXCEEDED`, `429 AI_RATE_LIMITED`, `403 AI_DISABLED`, `403 AI_FEATURE_DISABLED` | Unchanged | Unchanged |
| `502` | Card reading failed for another reason (refusal, rejected request, unusable answer) | "Could not read the card. Please retake the photo." (existing) |

**Mobile.** The installed app keeps working without an update: `AI_NOT_CONFIGURED`,
budgets and rate limits are mapped as before, and for a 503 with a code it does not know
the single-capture screen shows the server's own sentence (English). Its batch-review
screen shows only its built-in text for an unknown code — the existing "couldn't read the
card" message, as for any provider failure today. The source now maps
`AI_PROVIDER_UNAVAILABLE` and `AI_PLATFORM_LIMIT_REACHED` to a localized message
(`capture.errAiUnavailable`, English and Arabic) on both screens, which takes effect with
the next mobile build. The pre-scan readiness notice
keeps working from `GET /ai/health`. The app never talks to an AI provider and carries no
key; the bundled-secrets guard now also covers Anthropic keys, SDKs and endpoints.

Features other than card reading keep their existing behaviour on a provider failure
(soft-degrade to their deterministic result, or their existing "temporarily unavailable"
message).

## 10. Persistence and the proposed schema change

The policy is **one JSON document** in a new table:

```
platform_settings(key text PRIMARY KEY, value jsonb NOT NULL,
                  version integer NOT NULL DEFAULT 1,
                  updated_by integer, updated_at timestamp NOT NULL DEFAULT now())
```

There was no existing platform-wide settings store to reuse (`ai_settings` is per
company; `platform_owner` users have no company), so this additive table is the
"separately reviewable development artifact": `lib/db/src/schema/platform_settings.ts`
and its reviewed SQL equivalent `lib/db/migrations/0042_platform_settings.sql`
(`CREATE TABLE IF NOT EXISTS`, one transaction, no existing object touched, created
empty). It was **not applied to any hosted database**.

Verified locally on a disposable database (2026-11-20):

| Check | Result |
| --- | --- |
| Fingerprint of the schema **without** the table | `c36a8a2d9c7e502a2ce31ff5f3f412d9` — exactly the post-`0040` fingerprint the release guards are pinned to |
| Fingerprint **with** the table (by `0042` or by `push`) | `fae275efc409c5020a792a7fb0d59689` |
| `push` after applying `0042` | "No changes detected" |
| `0042` applied a second time | No error, no change |
| Documented rollback (`DROP TABLE platform_settings`) | Fingerprint back to `c36a8a2d…` |

**Compatibility with `0040` and the release guards.** `0042` references no object of
`0040` and neither depends on the other, but the *order* matters operationally: the
release tooling's guards are pinned to `c36a8a2d…`, and a database with this table has a
different fingerprint. So `0042` must be applied **after** the `0040` release has
completed under its pinned guards, and the guards re-pinned to the new fingerprint by a
separately authorized operations change. **No release guard was changed in this batch.**
(`0041` is the example name of the G-7 index proposal and was not created; if those
indexes are adopted too, the fingerprint to pin is that of the combined schema and must
be computed in the rehearsal.)

**The application does not need the table to run.** Deployed before `0042`, it serves the
default policy read-only (`storage: "unavailable"`), AI keeps resolving through those
defaults, and a save is refused with `503 AI_POLICY_STORAGE_UNAVAILABLE`; the settings
page says so. This was run locally against a database without the table: no error-level
log line, tenant endpoints unaffected.

**Writes.** `PUT` carries the complete policy and the version it was read at. One
transaction locks the row, checks the version, writes the document and inserts the audit
row (`audit_logs`, action `platform.ai_providers.update`, `company_id` NULL, the changed
fields, the policy before and after, the confirmation and its reasons). A stale version is
`409 AI_POLICY_VERSION_CONFLICT`; two simultaneous saves cannot both succeed. A change
that reduces AI availability is held back with `409 AI_POLICY_CONFIRMATION_REQUIRED` and
its reasons until it is sent again with `confirm: true` — the server decides, so no client
can skip the question. A new company override must name an existing company; an override
of a company that has since been deleted is dropped by the next save (and named in its
audit row) instead of blocking it.

**Reads.** The policy is cached per process for 10 s (`AI_POLICY_CACHE_TTL_MS`); a save
takes effect at once in the process that handled it. While the table does not exist it is
looked for once a minute. If the policy cannot be read, the
last one known to the process stays in effect; with none known, AI requests fail closed
(`503`) — a provider the owner disabled never comes back because of a database error.
A stored document is read tolerantly field by field, so a document written by another
version can neither take AI down nor re-enable what it does not mention.

## 11. Credentials

- `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` are read from the **API server's environment
  only**, through `config.ts`. They are not in the database, not in the policy (unknown
  keys in the policy are refused, so a key cannot be smuggled into it), not in any API
  response, not in the web bundle, not in the mobile app.
- The settings page reports, per provider, one of: **No key on the server** ·
  **Key present** (not yet used since the server started) · **Key verified** (the provider
  accepted it on the most recent request) · **Key rejected** (the provider answered 401 /
  403) · **Account stopped by provider** (a billing error or an account spend cap). It
  names the environment variable; it never shows a key, a part of one or its length. It
  makes **no test call**: the state changes only as real requests are served, and it is
  kept in memory, so it starts again at "Key present" after a restart.
- A rejected key and a stopped account are also sent to every active platform owner as a
  notification, once per provider and kind per day.
- Error messages stored in the ledger and written to the log are the provider's short
  error text; they never contain the key, the prompt or the image.

## 12. Tests

All local, on synthetic data, with mocked or simulated providers. No billable call.

| Suite | What it covers |
| --- | --- |
| `api-server/test/unit-ai-anthropic-adapter.test.ts` (38) | Request shape (text, image blocks, system line, effort, `max_tokens` floor, no sampling), answers, usage incl. cache tokens, refusal, every error mapping (incl. the three spend-cap codes and billing errors) with its fallback eligibility and what the user is told, unsupported / oversized images, base64 line breaks, no key, key rotation, no secret in messages. Fake client; SDK errors constructed locally. |
| `api-server/test/unit-ai-policy.test.ts` (62) | Defaults, resolution in every enable / key / fallback / override combination, strict validation, tolerant parsing, availability impact, fallback eligibility, the runner's no-retry rule, the shared time budget, Claude and Gemini prices incl. the Haiku tier. |
| `api-server/test/unit-ai-policy-storage.test.ts` (14) | Table missing → defaults read-only, save refused, re-check interval; policy unreadable → last known policy, else fail closed; limit admission under concurrency; unpriced models. |
| `api-server/test/unit-ai-credential-status.test.ts` (8) | Key verified / rejected / account stopped as the provider answers; owner notifications, once per day; nothing recorded for a test model. |
| `api-server/test/unit-ai-production-gating.test.ts` (5) | With the test engine disabled as in production: no test provider, no test model in any catalog, a stored test model ignored, a `stub-…` model name routed to the real adapter. |
| `api-server/test/ai-provider-management.test.ts` (53) | Live local API: access control, validation, confirmation, versioning, concurrency, audit, stale overrides; Claude and Gemini each serving; switching without a restart; both enable / disable states; overrides; every fallback and non-fallback case with ledger rows; budgets and limits across attempts; alerts; holds released; unpriced model; every feature family on each provider; provenance after a fallback; durability across processes. |
| `web-app/src/lib/ai-providers.test.ts` (18) | Exact limit conversion, dirty rule, wording of every state, refused-save handling. |
| `web-app/e2e/zj-ai-providers.spec.ts` (17) | The page end to end: readiness, prices, save, reload, every confirmation, limits, usage, overrides, conflict, failed refresh, read-only storage state, tenant page, access, desktop / tablet / phone / dark. |
| `mobile/lib/scan-error.test.ts`, `no-bundled-secrets.test.ts` | New code mapping in EN and AR; no AI key, SDK or endpoint in the app. |

One existing test changed its expectation, deliberately: `b22c1-ocr-unconfigured.test.ts`
pinned *"provider timeout → 502, could not read the card"*; a timeout now answers
`503 AI_PROVIDER_UNAVAILABLE` (§5). One existing Playwright test had its **wait** made
deterministic, with its assertions untouched: `zh-platform-dashboard.spec.ts` measured the
status ring after a fixed pause and once caught it mid-animation during a full run; it now
measures once the ring has stopped changing. Nothing else in the existing suites was
modified.

Verified by hand on the local stack: the saved policy is identical after a real restart
of the API process; the migration checks of §10.

**Not verified** (and not claimed): any live Claude or Gemini call, the quality of Claude's
extraction on real cards, real token counts and real cost, behaviour on the hosted stack,
any device.

## 13. Decisions for the owner

1. **Claude model.** Default is `claude-opus-5-5` at $4 / $20 per million tokens. Gemini
   2.5 Flash is $0.30 / $2.50, Haiku 5.5 $0.10 / $0.50. Card extraction is high-volume;
   choosing Sonnet or Haiku for it is a setting, not a code change — but the choice should
   follow a live quality comparison on real cards (§14).
2. **Reasoning effort** for Claude (`low` by default): raise only if the live comparison
   shows a quality gap.
3. **Spending limits**: none are set by default. Recommended before go-live: a platform
   limit per provider here **and** a spend limit in each provider's console.
4. **Company overrides**: available to the Platform Owner only. Whether tenants should
   ever choose their own provider (e.g. as a plan feature) is a product decision; today
   they cannot.
5. **`0042` application and guard re-pin**: needs explicit authorization (§10, §14).
6. **Schema-constrained output for Claude**: adopt only together with a reshaped
   extraction contract (§8).
7. **Other features on outage**: only card reading got the dedicated
   `AI_PROVIDER_UNAVAILABLE` answer; the others keep their existing soft-degrade.
8. **A stopped Claude account** (billing, spend cap) is final today: the user is told AI
   is unavailable and the owners are alerted, but the request is not moved to Gemini.
   Treating it like an outage is a one-line change if the owner prefers availability.
9. **A circuit breaker** (send requests to the other provider first for a short time
   after the primary timed out) would cut the wait during a hang-type outage; it changes
   routing semantics and was left out (§16).

## 14. Before release integration (Prompt 3)

1. **Backup health.** The scheduled backup-health check on `export-ready` **failed on
   2026-11-19** (the expected 03:15 backup of that day was missing). This is an open
   release blocker carried over unchanged; it must be confirmed recovered — not assumed —
   before any hosted change.
2. Review and merge order of the stacked draft PRs — this one sits on #9
   (`claude/launch-pricing-ui-corrections`), which sits on the G-7 branch (#8); retarget
   as the base branches merge.
3. Authorize and apply `0042` to the hosted database **after** the `0040` release, with a
   fresh backup, then re-pin the release guards to the new fingerprint (recompute it in
   the rehearsal; `fae275ef…` holds only for post-`0040` + this table).
4. Configure `ANTHROPIC_API_KEY` (and confirm `GEMINI_API_KEY`) on the VPS per the
   operator guide. Never through chat, Git or GitHub secrets.
5. **First live verification**, opt-in and outside the normal test runs:
   `artifacts/api-server/scripts/verify-ocr-live.ts` was adapted to the policy — it must
   be told the provider (`VERIFY_AI_PROVIDER=anthropic|gemini`), pins its throwaway
   company to it through a policy override, refuses to call anything unless that
   provider is the one that will serve, and names the provider from the ledger rows. The
   adapted script **has not been executed** (no key, no billable call in this batch): run
   it once per provider on the English and Arabic card fixtures; compare field accuracy,
   latency against the 30 s / 20 s timeouts, real token counts and cost; confirm the
   usage the ledger records matches the provider's console.
6. Re-check model identifiers and prices against Anthropic's and Google's pages on the
   release day; bump `AI_PRICING_VERSION` if anything changed.
7. Decide model, effort and limits (§13) from the live comparison, then save the policy in
   Settings.
8. Exercise one real fallback on the hosted stack (e.g. Claude key removed → Gemini
   serves) and one "both unavailable" case.
9. Mobile: the new localized outage message ships with the next build; no build is
   required for this release.
10. Update the living documents (§15).

## 15. Living documents to update after integration

Not rewritten on this branch, by the established practice for stacked work:

- **`CLAUDE.md` — "AI rules": "Google Gemini 2.5 Flash is the ONLY approved AI
  provider/model."** This batch, by the owner's instruction, adds Anthropic Claude. The
  rule must be restated (two approved providers behind the one Enterprise AI Layer;
  provider choice is the Platform Owner's policy) once the work is integrated. Until then
  the file and the code disagree, and the code on this branch is the newer statement of
  intent.
- `docs/PROJECT_TECHNICAL_BRIEF.md`, `docs/ai-architecture.md`, `replit.md` — provider
  list, the policy, the new table.
- `docs/PROJECT_FILE_MAP.md` — the new files.
- `docs/LOCALHOST_DEVELOPMENT.md` §7 — the test baseline totals.
- `docs/GEMINI_PRODUCTION_CONFIG_RUNBOOK.md` — cross-reference to the operator guide.
- `docs/HOSTINGER_VPS_DEPLOYMENT.md` — the second key in the VPS env file.

## 16. Known limits

- Limits and holds assume one API process (§6.3).
- Credential status is per process and observational (§11).
- The estimated cost of a Claude request uses list prices without cache discounts; the
  product does not use prompt caching, so the two coincide today.
- Outside production the model lists include the test models; they are never offered in
  production (`NODE_ENV=production` disables the test engine entirely).
- No circuit breaker. In a hang-type outage every request waits for the primary's
  timeout before the fallback is tried. A card scan still ends inside the proxy's 60 s
  (§5); an endpoint that makes several AI calls in one request (insights, workflow
  analysis) may not, although each call would succeed on the fallback. Switching the
  primary in Settings takes effect at once and is the remedy during such an outage.
- A result answered from the short duplicate cache (up to 30 s) is replayed as it was
  produced, even if its provider has been disabled in between.
- A request stopped by the AI rate limit is recorded before the provider is resolved,
  under the pre-policy default provider name.
- The tenant AI health card's failure rate counts provider calls, so it reads high during
  an outage the fallback is covering; the alert does not (§6.1).
