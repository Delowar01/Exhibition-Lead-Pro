---
name: Mobile global query invalidation
description: Why the Expo app uses a centralized MutationCache to invalidate all React Query caches after every mutation.
---

# Centralized mutation invalidation (mobile)

The Orval-generated React Query hooks in `@workspace/api-client-react` have NO
built-in cache invalidation, and call sites historically did not invalidate
either. So after any online create/update/delete the dashboard counters,
contacts list, follow-ups, leads, tasks, meetings, and events stayed stale until
a manual pull-to-refresh or app restart. The bug was hidden offline because
`OfflineContext` calls `queryClient.invalidateQueries()` after a successful sync.

**Fix / rule:** the QueryClient in `artifacts/mobile/app/_layout.tsx` is built
with a global `MutationCache({ onSuccess: () => queryClient.invalidateQueries() })`
so EVERY successful mutation hook marks all queries stale (active ones refetch
immediately, inactive ones on next mount). This also mitigates the missing
`useFocusEffect` "stale after returning from edit" symptom.

**Why:** per-call-site invalidation across ~16 mutation sites was fragile and
inconsistently applied; one central guard is robust and matches the offline path.

**How to apply:** do NOT add redundant per-call invalidation for correctness —
the global guard covers it. Only narrow invalidation by key family later if
telemetry shows excessive refetch chatter, and never remove the central guard.
The self-referential `const queryClient = new QueryClient({ mutationCache: ... onSuccess: () => queryClient.invalidateQueries() })`
is TDZ-safe because the callback runs only after construction. CardContext's
optimistic updates use offline-queue direct functions (not mutation hooks), so
the global invalidation does not fight them.
