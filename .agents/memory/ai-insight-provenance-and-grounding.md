---
name: AI insight provenance & CRM-only grounding
description: Stage 5A reviewable AI insights must stamp the real runtime provider/model and never allow a "general knowledge" escape hatch in prompts.
---

# AI insight provenance & CRM-only grounding

Two safety-contract traps in the reviewable AI-insight layer that shallow tests pass through:

## 1. Provenance must be the ACTUAL runtime provider/model, never hardcoded
When persisting an AI-sourced insight, do NOT hardcode `provider:"gemini"` / `model:null`.
Resolve the tenant's effective settings (`resolveSettings(companyId)` in ai.service — shares
lib/ai.ts's in-process cache, so it's not an extra DB read) and stamp the real provider+model.

**Why:** tenants can override provider/model; hardcoding makes the recorded provenance a lie
and diverges from what `GET /ai/settings` / the invocation ledger report. The contract requires
every recommendation carry accurate confidence/source/provider/model/promptKey/promptVersion.

**How to apply:** resolve once per analyzed entity, guard the resolve in try/catch (a failure
must not break the always-on deterministic engines; any AI feature would also fail and persist
no row, so provenance is only ever stamped on a successful AI call). Deterministic rows carry
provider/model/promptKey/promptVersion = null and must never look AI-sourced.

## 2. Stage 5A prompts must be STRICTLY CRM-grounded — no "general knowledge"
The older Stage 5.0 `ENRICHMENT_PROMPT` intentionally says "plus general knowledge about the
named company/industry". Stage 5A intelligence prompts must NOT copy that phrasing — it's a
direct path to fabricated, non-CRM inferences and violates "derive ONLY from tenant CRM data;
say 'Not enough information' when insufficient".

**Why:** the product's non-negotiable contract is no fabricated data. A single "plus general
knowledge" clause silently reopens hallucination even though the shared GROUNDING_RULES block
is present.

**How to apply:** every Stage 5A prompt keeps only the strict grounding. When you materially
change a prompt's text, bump its version in the `PROMPTS` registry so historical rows stay
attributable to the exact prompt that produced them.
