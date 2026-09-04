import { logger } from "../logger.js";
import { getQueue } from "../jobs/queue.js";
import type { JobQueue } from "../jobs/types.js";
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
//   CRM mutation → dispatchWorkflowEvents(events)
//     → published definitions of the record's company for the trigger type
//     → trigger-config filter → condition evaluation (post-mutation record)
//     → workflow_runs row (definition snapshot + revision, unique per definition
//       × event) + its action rows, committed atomically
//     → `workflow.run` job on the existing JobQueue (dedupe key per run)
//
// Durability boundary (reported honestly): the CRM mutation has already committed
// when dispatch runs (the services are not transactional end-to-end, and the
// JobQueue contract has no transaction parameter). Dispatch is AWAITED inside the
// request before the response is sent, so a persisted run always exists before
// the client sees success; the enqueue may still fail/crash after the run row is
// committed — orphan recovery (recovery.ts) re-enqueues such runs, and the unique
// (definition, event) index guarantees no duplicate run either way. A crash in
// the milliseconds between the CRM commit and the run insert loses that event
// (documented limitation; no second event store is introduced).
//
// Dispatch NEVER throws into the CRM request: the mutation already succeeded and
// must be reported as such; failures are logged with safe identifiers only.
//
// Loop safety: called from inside a workflow action (context set) → no-op.
// =============================================================================

export interface DispatchDeps {
  queue?: JobQueue;
}

export interface DispatchOutcome {
  runIds: number[];
  skippedInWorkflowContext: boolean;
}

export async function dispatchWorkflowEvents(events: WorkflowEvent[], deps: DispatchDeps = {}): Promise<DispatchOutcome> {
  if (events.length === 0) return { runIds: [], skippedInWorkflowContext: false };
  const parentRun = currentWorkflowRunId();
  if (parentRun != null) {
    logger.debug({ runId: parentRun, events: events.map((e) => e.triggerType) }, "Workflow-caused mutation: events not dispatched (loop safety)");
    return { runIds: [], skippedInWorkflowContext: true };
  }
  const runIds: number[] = [];
  for (const event of events) {
    let defs: definitionsRepo.WorkflowDefinitionRow[];
    try {
      defs = await definitionsRepo.listPublishedForTrigger(event.companyId, event.triggerType);
    } catch (err) {
      logger.error({ err, companyId: event.companyId, triggerType: event.triggerType }, "Workflow dispatch: definition lookup failed");
      continue;
    }
    for (const def of defs) {
      try {
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
        );
        if (!row) continue; // this definition already has a run for this event
        runIds.push(row.id);
        logger.info({ runId: row.id, companyId: row.companyId, workflowDefinitionId: def.id, revision: def.revision, triggerType: event.triggerType, entityType: event.entityType, entityId: event.entityId }, "Workflow run queued");
        try {
          await enqueueRun(deps.queue ?? getQueue(), row);
        } catch (err) {
          // The run row is durable; orphan recovery will enqueue it.
          logger.error({ err, runId: row.id, companyId: row.companyId }, "Workflow run enqueue failed; left for recovery");
        }
      } catch (err) {
        logger.error({ err, companyId: event.companyId, workflowDefinitionId: def.id, triggerType: event.triggerType }, "Workflow dispatch failed for definition");
      }
    }
  }
  return { runIds, skippedInWorkflowContext: false };
}
