---
name: Scope privacy on persisted per-scope AI artifacts
description: Persisted AI artifacts carry a (scopeType, scopeId); a read-scope entitlement must gate EVERY read/get/lifecycle path, not just list.
---

Persisted per-scope AI artifacts (executive summaries/alerts/forecasts/reports, and any future sibling that stores `scopeType`+`scopeId`) must never let a non-manager read wider than the live dashboard would show them.

Rule: compute a caller read-scope entitlement once (managers = all scopes in tenant; non-managers = own employee scope + teams they lead (`leaderId`) + departments they head (`headId`)) and thread it as a predicate through **every** repository read AND lifecycle method — list, get-by-id, status-counts, and status/accept/dismiss mutations — not just the list endpoint.

**Why:** gating only `list` leaks: a view-only employee can still fetch a company-wide row by guessed id, or mutate/accept/dismiss it. The get-by-id and lifecycle paths are the sneaky ones. A managerbypass short-circuit is fine, but the non-manager branch must OR together (own-scope inArray + led-team scopes + headed-dept scopes) with the tenant boundary still applied.

**How to apply:** when adding any new persisted per-scope artifact table or a new read/lifecycle endpoint on an existing one, pass the same read-scope predicate the list path uses. Test parity explicitly: company-scope row must be absent from a non-manager's list AND 404 on direct get; the caller's own-scope row must be present AND 200. Cross-tenant is still 404 (tenant boundary first).
