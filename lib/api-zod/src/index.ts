export * from "./generated/api";
export * from "./generated/types";

// Orval names BOTH the Zod schema of an operation's PATH parameters (generated/api) and the
// TypeScript type of its QUERY parameters (generated/types) `<Operation>Params`, so an operation
// that carries path AND query parameters makes the two star re-exports above ambiguous
// (TS2308). The explicit re-export keeps the Zod schema — what the server validates with — and
// the query-parameter TYPE stays reachable under a distinct name. Add one pair per such operation.
export { PlatformSubscriptionPlanHistoryParams } from "./generated/api";
export type { PlatformSubscriptionPlanHistoryParams as PlatformSubscriptionPlanHistoryQueryParamsType } from "./generated/types";
