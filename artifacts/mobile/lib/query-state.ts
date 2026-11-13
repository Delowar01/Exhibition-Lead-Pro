// Pure view-state decision shared by the mobile query screens (Home metrics,
// Notifications list, Lead edit form). Framework-free so it is unit-testable
// with the existing vitest setup (lib/**/*.test.ts, node environment).
//
// Rules (Batch 38 integration audit of the Batch 37 error states):
//  - "loading": the first load is in flight, OR a retry after an error is in
//    flight. React Query keeps isError=true while a refetch runs, so without
//    this rule the error state (and its retry button) would stay on screen
//    during the retry with no progress indication.
//  - "error": the query failed and there is nothing to show (no data was ever
//    loaded). This is the only state in which a screen may replace its content
//    with the shared ErrorState + retry.
//  - "ready": data is available (fresh or last known). A failed background
//    refresh never blanks a screen that already has data, and a failed query
//    is never rendered as an empty list or zero metrics.
export type QueryViewState = "loading" | "error" | "ready";

export interface QueryViewInput {
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  hasData: boolean;
}

export function resolveQueryViewState(q: QueryViewInput): QueryViewState {
  if (q.isLoading) return "loading";
  if (q.isError && q.isFetching) return "loading";
  if (q.isError && !q.hasData) return "error";
  return "ready";
}

/**
 * Combines the states of several queries feeding ONE surface (e.g. the Home
 * metrics grid reads the dashboard counts and the pipeline values). Loading
 * wins over error (wait for every source), error wins over ready (never show
 * a partially-failed surface as complete data).
 */
export function combineQueryViewStates(...states: QueryViewState[]): QueryViewState {
  if (states.includes("loading")) return "loading";
  if (states.includes("error")) return "error";
  return "ready";
}
