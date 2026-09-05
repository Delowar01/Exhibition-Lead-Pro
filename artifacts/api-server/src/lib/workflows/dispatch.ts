import { db } from "@workspace/db";
import { logger } from "../logger.js";
import { getQueue } from "../jobs/queue.js";
import type { JobQueue } from "../jobs/types.js";
import type { Executor } from "../../repositories/base.js";
import * as definitionsRepo from "../../repositories/workflow_definitions.repository.js";
import * as runsRepo from "../../repositories/workflow_runs.repository.js";
import { evaluateConditions } from "./conditions.js";
import { currentWorkflowRunId } from "./context.js";
import { enqueueRun } from "./engine.js";
import { eventKeyOf, type WorkflowEvent } from "./events.js";
import { matchesTriggerConfig } from "./triggers.js";
import type { WorkflowCondition } from "./definition.js";

// =============================================================================
// Workflow event dispatch (Batch 16) — the ONE place CRM events meet definitions.
//
// Durability boundary (Batch 16 correction 1):
//
//   db.transaction(tx) {
//     CRM mutation (insert/update via the repositories, on tx)
//     runs = persistWorkflowRuns(events, tx)    ← same transaction
//   }                                            ← COMMIT (or roll back BOTH)
//   enqueueWorkflowRuns(runs)                    ← only after the commit
//
// • persistWorkflowRuns evaluates the published definitions of the record's
//   company for each event (trigger config + conditions against the
//   post-mutation record) and inserts the workflow_runs + workflow_action_runs
//   rows ON THE CALLER'S TRANSACTION. Any failure THROWS, so the CRM mutation is
//   rolled back with it — a matching mutation can never commit without its run,
//   and a run can never exist without its mutation. Nothing is swallowed before
//   the work is durable.
// • enqueueWorkflowRuns runs after the commit; an enqueue failure (or a process
//   stop before it) is logged and the persisted `queued` run is picked up by
//   orphan recovery (recovery.ts). The unique (definition, event) index and the
//   per-generation queue dedupe key guarantee no duplicate run or job.
// • Loop safety: inside a workflow action (context set) nothing is persisted or
//   enqueued.
// =============================================================================

export interface DispatchDeps {
  queue?: JobQueue;
}

export interface DispatchOutcome {
  runIds: number[];
  skippedInWorkflowContext: boolean;
}

// Test-only fault injection (mirrors lib/email __setEmailProviderForTests): lets
// the durability tests force a persistence or enqueue failure without touching
// production code paths. Both are no-ops unless set.
let persistFault: ((event: WorkflowEvent) => void) | null = null;
let enqueueFault: ((run: runsRepo.WorkflowRunRow) => void) | null = null;
export function __setWorkflowDispatchFaultsForTests(faults: { persist?: ((event: WorkflowEvent) => void) | null; enqueue?: ((run: runsRepo.WorkflowRunRow) => void) | null }): void {
  persistFault = faults.persist ?? null;
  enqueueFault = faults.enqueue ?? null;
}

/**
 * Evaluate + persist the matching runs for `events` on the caller's transaction.
 * THROWS on any failure (definition lookup, evaluation, insert) so the caller's
 * transaction — the CRM mutation — rolls back with it. Returns the created runs
 * (already-existing runs for the same definition × event are not returned).
 */
export async function persistWorkflowRuns(events: WorkflowEvent[], tx: Executor): Promise<runsRepo.WorkflowRunRow[]> {
  if (events.length === 0) return [];
  const parentRun = currentWorkflowRunId();
  if (parentRun != null) {
    logger.debug({ runId: parentRun, events: events.map((e) => e.triggerType) }, "Workflow-caused mutation: events not dispatched (loop safety)");
    return [];
  }
  const created: runsRepo.WorkflowRunRow[] = [];
  for (const event of events) {
    if (persistFault) persistFault(event);
    const defs = await definitionsRepo.listPublishedForTrigger(event.companyId, event.triggerType, tx);
    for (const def of defs) {
      const trigger = (def.trigger ?? {}) as { type?: string; config?: Record<string, unknown> };
      if (!matchesTriggerConfig(trigger.type ?? def.triggerType, trigger.config ?? {}, event)) continue;
      const conditions = (Array.isArray(def.conditions) ? def.conditions : []) as WorkflowCondition[];
      if (!evaluateConditions(event.entityType, event.record, conditions).matched) continue;
      const actions = (Array.isArray(def.actions) ? def.actions : []) as Array<{ type: string; config?: Record<string, unknown> }>;
      const row = await runsRepo.createRunWithActions(
        {
          companyId: event.companyId, // the RECORD's company — never a caller-supplied id
          workflowDefinitionId: def.id,
          definitionRevision: def.revision,
          definitionSnapshot: { name: def.name, trigger: def.trigger, conditions: def.conditions, actions: def.actions },
          triggerType: event.triggerType,
          entityType: event.entityType,
          entityId: event.entityId,
          actorUserId: event.actorUserId,
          eventKey: eventKeyOf(event),
          status: "queued",
        },
        actions.map((a, i) => ({ actionIndex: i, actionType: a.type })),
        tx,
      );
      if (!row) continue; // this definition already has a run for this event
      created.push(row);
      logger.info(
        { runId: row.id, companyId: row.companyId, workflowDefinitionId: def.id, revision: def.revision, triggerType: event.triggerType, entityType: event.entityType, entityId: event.entityId },
        "Workflow run persisted",
      );
    }
  }
  return created;
}

/**
 * Enqueue the `workflow.run` job for runs whose transaction has COMMITTED. Never
 * throws: an enqueue failure leaves a durable `queued` run that orphan recovery
 * re-enqueues (with a fresh generation key).
 */
export async function enqueueWorkflowRuns(runs: runsRepo.WorkflowRunRow[], deps: DispatchDeps = {}): Promise<void> {
  for (const row of runs) {
    try {
      if (enqueueFault) enqueueFault(row);
      await enqueueRun(deps.queue ?? getQueue(), row);
      logger.info({ runId: row.id, companyId: row.companyId, workflowDefinitionId: row.workflowDefinitionId, triggerType: row.triggerType }, "Workflow run queued");
    } catch (err) {
      logger.error({ err, runId: row.id, companyId: row.companyId }, "Workflow run enqueue failed; left for recovery");
    }
  }
}

/**
 * Convenience for callers that have no surrounding transaction (tests, ad-hoc
 * dispatch): persists the runs in their own transaction, then enqueues them.
 * Throws if persistence fails (nothing is committed in that case).
 */
export async function dispatchWorkflowEvents(events: WorkflowEvent[], deps: DispatchDeps = {}): Promise<DispatchOutcome> {
  if (events.length === 0) return { runIds: [], skippedInWorkflowContext: false };
  if (currentWorkflowRunId() != null) return { runIds: [], skippedInWorkflowContext: true };
  const runs = await db.transaction((tx) => persistWorkflowRuns(events, tx));
  await enqueueWorkflowRuns(runs, deps);
  return { runIds: runs.map((r) => r.id), skippedInWorkflowContext: false };
}
