import { AsyncLocalStorage } from "node:async_hooks";

// Execution context for workflow-caused CRM mutations (Batch 16 — loop safety).
//
// Every action executor runs inside `runInWorkflowContext(runId, …)`. The CRM
// services dispatch workflow events synchronously in the same async continuation,
// so `currentWorkflowRunId()` is non-null exactly while a workflow action is
// mutating CRM data — and the dispatcher refuses to emit events in that case.
// Result: workflow A updating a stage can never trigger workflow B (no chaining,
// no recursion). Human/API/import/capture mutations run outside any context and
// keep producing normal events.
const storage = new AsyncLocalStorage<{ runId: number }>();

export function runInWorkflowContext<T>(runId: number, fn: () => Promise<T>): Promise<T> {
  return storage.run({ runId }, fn);
}

export function currentWorkflowRunId(): number | null {
  return storage.getStore()?.runId ?? null;
}
