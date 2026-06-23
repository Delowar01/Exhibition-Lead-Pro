---
name: Mobile scan & mutation performance
description: Why mobile OCR was 30s and lead/status updates felt slow, and the levers that fix it.
---

## Gemini "thinking" is the biggest OCR/scoring latency lever
`gemini-2.5-flash` runs extended *thinking* ON by default, adding ~5–15s before the
first output token. For OCR + structured JSON extraction (and lead scoring /
enrichment) this is pure overhead.
**Rule:** every `ai.models.generateContent` config in `api-server/src/lib/ai.ts`
must set `thinkingConfig: { thinkingBudget: 0 }`.
**Why:** OCR/extraction is not a reasoning task; thinking added the bulk of the
30s scan time. Disabling it has no measurable quality loss here.
**How to apply:** if you add a new Gemini call for a non-reasoning task, set
thinkingBudget:0. Reconsider only for genuinely reasoning-heavy prompts.

## Downscale card images client-side before OCR upload
Camera captured at full sensor resolution then base64'd the whole thing. Resize to
~1600px (longest edge) via `expo-image-manipulator` (`manipulateAsync`, JPEG ~0.6)
BEFORE base64. A business card is fully legible at 1600px; the shrink cuts both the
upload time and the server-side OCR inference cost.
**How to apply:** mirror `mobile/lib/avatar.ts` API usage; keep a raw base64
fallback so a manipulation failure never breaks a scan.

## Optimistic UI is required for "instant" status/stage changes
Lead stage (`pipeline/[id].tsx`) and contact status (`contact/[id].tsx`) felt 4–5s
slow because they awaited the mutation then refetched. Fix = Orval hook
`mutation.onMutate` setQueryData on the detail query key + `onError` rollback, then
fire-and-forget `.mutate()`. Drop manual `refetch()` — the global
`MutationCache.onSuccess -> invalidateQueries()` already reconciles (incl. history).
**Why:** the blanket invalidation stays (intentional, see mobile-query-invalidation),
but optimistic onMutate means the UI never waits on the round-trip.
**How to apply:** guard re-taps with `mutation.isPending` to avoid transient
rollback flicker; make only the critical field optimistic when a hook is shared
(e.g. status-only, not assignment).

## React Query defaults for snappy navigation
QueryClient had no defaults, so every screen mount showed a spinner + refetch. Add
`defaultOptions.queries`: `staleTime 30s`, `gcTime 5m`, `refetchOnWindowFocus false`,
`retry 1`. The post-mutation blanket invalidation still forces fresh data where it
matters, so cached navigation is safe.
