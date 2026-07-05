---
name: Settings stored/reported but not read at runtime
description: A per-tenant setting that is writable + shown by GET endpoints but ignored by the execution path is a silent "reports-X-does-Y" mismatch; unify on one resolver.
---

# Per-tenant settings must drive the runtime, not just the read endpoints

When a tenant-configurable setting (e.g. AI `provider`/`model` in `ai_settings`) is
PATCHable and echoed back by `GET /ai/settings` + `GET /ai/health`, the execution path
(`callJson` in `src/lib/ai.ts`) MUST resolve that same setting — not a global/default
config value. Otherwise a tenant sets model X, every read endpoint reports model X, but
invocations silently run the default model, and the ledger records the wrong model.

**Why:** Code review flagged Stage 5.0 shipping settings that typecheck, pass shallow
tests, and look correct in the UI, yet have zero runtime effect. Tests that only assert
"PATCH persists + GET reflects it" do NOT catch this — both sides read the settings row;
neither exercises the execution path.

**How to apply:**
- Make the read endpoints AND the execution path call the SAME resolver
  (`aiService.resolveSettings(companyId)`), so "what is reported" == "what runs" by
  construction. Then a test asserting the health/settings endpoint reflects an override
  transitively proves runtime resolution.
- Fall back to platform defaults only when there is no tenant context (system calls with
  `ctx.companyId == null`).
- `resolveSettings` and the gate (`ensureAiAllowed`) share an in-process cache, so reading
  settings in the hot path adds no extra DB round-trip.
- General rule: any "override" field is a lie until the code that does the work reads it.
