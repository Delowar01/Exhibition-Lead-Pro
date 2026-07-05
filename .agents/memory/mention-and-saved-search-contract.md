---
name: Mentions + saved-search cross-surface contract
description: How @mentions markup and saved searches/filters are shared across web + mobile + server.
---

# @mention markup + saved-search contract

## Mention markup
- Notes/comments store mentions inline as `@[Name](userId)` tokens in the body text.
- The SERVER derives the authoritative `mentions: number[]` from the body (server richtext lib: extractMentionIds/normalizeBody/toPlainText). Clients never send a separate mention list — they only write the tokens.
- Renderers must NOT use dangerouslySetInnerHTML. Web splits tokens into React spans; mobile `components/MentionText.tsx` parses the same regex and renders styled `<Text>` spans.
- Mention resolution is tenant-only: pick from `useListUsers` filtered by `isActive !== false`.

**Why:** keeping the source of truth as plain tokens + server-side extraction means every surface (web, mobile, notifications) stays consistent and can't be tricked into notifying out-of-tenant users.

## Saved searches / filters / views
- One generic table drives web advanced search AND mobile saved filters via `entityType` + `kind` (`filter` | `view`). `payload` is opaque JSON — each surface stores its own shape and namespaces itself with its own `entityType` (e.g. mobile contact filters use `"contact-mobile-filter"`).
- The API must PRESERVE caller-provided `entityType` (validate as a bounded safe slug, don't collapse to a `leads|contacts` enum) — collapsing it silently hides a surface's own saved rows from that surface's list query.
- Apply saved payloads by merging OVER the surface's defaults (tolerate missing keys) so old payloads stay forward-compatible when new filter keys are added.

**Why:** the opaque-payload + per-surface entityType design lets new surfaces add saved filters/views without schema or API changes; a hard entityType enum broke mobile saved filters because created rows were coerced to `"contacts"` and never matched the mobile listing filter.

**How to apply:** don't add per-call query invalidation on mobile — the global MutationCache.onSuccess already refetches the saved-search list after create/delete.
