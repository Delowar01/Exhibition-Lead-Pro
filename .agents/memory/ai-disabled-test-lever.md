---
name: AI-disabled tenant as deterministic LLM-failure lever
description: How to test AI failure paths and regen retention without live Gemini
---

**Rule:** To test AI failure/soft-degrade paths deterministically, disable AI for the tenant (`PATCH /ai/settings {enabled:false}`, primary_admin only) — every LLM call then fails with a 403 AppError inside the AI layer while deterministic outputs (e.g. rule-based follow-up plan) keep working. Capture original settings before and restore after (beforeAll/afterAll).

**Why:** No live Gemini allowed in tests; mocking the provider would bypass the Enterprise AI layer the tests must exercise.

**How to apply:** Works for both API (vitest) and Playwright suites. Pairs with the regen-retention contract: on LLM failure, if the existing copilot row has a usable draft, the service returns it unchanged with a **response-only** `generationFailed: true` flag (never persisted, never overwrites the draft); with no usable draft it upserts the "unavailable" placeholder and still returns 200 (soft-degrade).
