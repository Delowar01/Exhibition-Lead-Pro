---
name: AI copilot deterministic-core + soft-degrade contract
description: How the Sales Copilot (Stage 5B) blends deterministic cores with best-effort AI, and its provenance/soft-degrade/applicability invariants.
---

# AI Sales Copilot generation contract

Two distinct generation paths, and they must NOT be conflated:

- **`followup` + `coaching`** — compute a grounded DETERMINISTIC core FIRST (from real CRM
  fields), always present, `source: "deterministic"`, `confidence: 100`. Then ATTEMPT AI
  phrasing on top; only on success does `source` flip to `"ai"` and confidence come from
  the model. The deterministic core keys (followup: `channel`/`suggestedDate`/`priority`/
  `overdue`/`basis`; coaching: `signals`/`summary`/`recommendations`) survive in `content`
  regardless of source.
- **The other 6 (`email`,`whatsapp`,`call_prep`,`meeting_prep`,`proposal`,`summary`)** —
  LLM-only. On AI failure they SOFT-DEGRADE to HTTP **200** with `content.unavailable: true`
  (+ a note), NEVER 500. The copilot must never block a user because AI is down.

**Why:** trust-critical feature — no fabricated data, and AI availability must not gate the
workflow. **How to apply:** any new output type must pick a lane; tests should assert 200 +
grounded/soft-degrade content, not depend on a live LLM (keeps the suite non-flaky).

## Hard invariants (each has its own guard/test)

- **Provenance masquerade guard:** a `deterministic`-sourced row must carry NULL
  provider/model/promptKey/promptVersion. Only `ai` rows get runtime provenance.
- **NEVER auto-sends / auto-writes CRM:** every output is a reviewable draft; "use" only
  records `usedById`/`usedAt`. Copy-to-clipboard is how a user "uses" a draft.
- **APPLICABLE matrix enforced in BOTH places:** single generate (`assertApplicable`) AND
  batch (`startBatch` re-checks). An inapplicable-but-valid outputType (e.g. `followup` on
  `organization`) → 400. Unknown entity/output → 400. Testing only the single path misses
  the batch gap.
- **Tenant firewall + RBAC** mirror `/ai/insights`: `requireTenantUser` 403s platform_owner
  (customer CRM fenced off), `blockReadOnlyMutations` 403s cancelled tenants (reads still
  200), `ai_copilot` module = view/generate/use. A freshly-created employee has NO
  ai_copilot perms → deny-by-default read is **403** (mirrors reports-permission-policy) —
  reads are gated too, so grant `view` explicitly to unlock.

## Test-writing gotcha

`organizations.normalizedName` is NOT NULL and derived by the service — a raw
`db.insert(organizationsTable)` in a test violates the constraint. Create orgs via
`POST /organizations` (the API derives `normalizedName`) instead of a direct insert.
