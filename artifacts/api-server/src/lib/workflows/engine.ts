import { db } from "@workspace/db";
import { config } from "../../config.js";
import { logger } from "../logger.js";
import type { JobQueue } from "../jobs/types.js";
import type { Executor } from "../../repositories/base.js";
import * as runsRepo from "../../repositories/workflow_runs.repository.js";
import { ACTION_EXECUTORS, type ActionContext, type ActionExecutor } from "./actions.js";
import { runInWorkflowContext } from "./context.js";
import { classifyError, WorkflowFailure, WorkflowSkip } from "./errors.js";
import { buildPrincipal } from "./principal.js";
import { loadTenantAccess } from "../company-access.js";
import type { WorkflowActionType, WorkflowEntity } from "./catalog.js";

// =============================================================================
// Workflow run executor (Batch 16). Invoked by the `workflow.run` JobQueue handler
// (at-least-once delivery), so every step is idempotent and resumable:
//   • a run that is already completed/failed is a no-op
//   • an execution lease (claimRun) prevents two workers running the same run
//   • actions execute strictly in index order; action N+1 never starts before
//     action N is completed or skipped
//   • completed/skipped actions are never re-executed on a retry — execution
//     resumes at the first pending action
//   • deterministic failures (bad reference, tenant mismatch, business rule,
//     malformed snapshot, unsupported action) fail the run immediately without
//     burning retries; transient failures release the lease and rethrow so the
//     queue applies its retry/backoff, and on the final attempt the run is
//     persisted as failed with a sanitized error
//   • the run executes ONLY its captured definition snapshot, never the live row
// =============================================================================

export const WORKFLOW_RUN_JOB = "workflow.run";

export interface WorkflowRunJobPayload {
  runId: number;
  companyId: number; // informational (logging); the persisted run decides the tenant
}

export interface JobAttempt {
  attempts: number;
  maxAttempts: number;
}

export type RunOutcome = "completed" | "failed" | "retry" | "noop";

interface SnapshotAction {
  type: WorkflowActionType;
  config: Record<string, unknown>;
}

function snapshotActions(snapshot: unknown): SnapshotAction[] {
  const s = snapshot as { actions?: unknown } | null;
  if (!s || !Array.isArray(s.actions)) throw new WorkflowFailure("SNAPSHOT_INVALID", "captured definition has no actions array");
  return s.actions.map((a, i) => {
    const x = a as { type?: unknown; config?: unknown };
    if (!x || typeof x.type !== "string") throw new WorkflowFailure("SNAPSHOT_INVALID", `captured action ${i} has no type`);
    return { type: x.type as WorkflowActionType, config: (x.config && typeof x.config === "object" ? x.config : {}) as Record<string, unknown> };
  });
}

function sanitizedError(c: ReturnType<typeof classifyError>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { code: c.code, errorClass: c.errorClass, message: c.message, retryable: c.retryable, ...extra };
}

// Enqueue the durable job for a run. The dedupe key is unique per run AND per
// enqueue generation, so the same run is never queued twice for one generation
// while orphan recovery can re-enqueue it under a new generation.
export async function enqueueRun(queue: JobQueue, run: { id: number; companyId: number; enqueueGeneration: number }): Promise<void> {
  await queue.enqueue<WorkflowRunJobPayload>(
    WORKFLOW_RUN_JOB,
    { runId: run.id, companyId: run.companyId },
    { dedupeKey: `${WORKFLOW_RUN_JOB}:${run.id}:${run.enqueueGeneration}`, maxAttempts: config.jobs.maxAttempts },
  );
}

export interface ExecuteDeps {
  executors?: Partial<Record<WorkflowActionType, ActionExecutor>>;
  leaseMs?: number;
}

async function loadEntity(entityType: WorkflowEntity, companyId: number, entityId: number) {
  if (entityType === "lead") {
    const lead = await runsRepo.leadInCompany(companyId, entityId);
    if (!lead) throw new WorkflowFailure("ENTITY_NOT_IN_TENANT", "lead no longer exists in the workflow's company");
    return { lead, contact: undefined };
  }
  const contact = await runsRepo.contactInCompany(companyId, entityId);
  if (!contact) throw new WorkflowFailure("ENTITY_NOT_IN_TENANT", "contact no longer exists in the workflow's company");
  return { lead: undefined, contact };
}

export async function executeRun(runId: number, attempt: JobAttempt, deps: ExecuteDeps = {}): Promise<RunOutcome> {
  const leaseMs = deps.leaseMs ?? config.jobs.workflows.runLeaseMs;
  const executors = { ...ACTION_EXECUTORS, ...(deps.executors ?? {}) };

  const existing = await runsRepo.findRunById(runId);
  if (!existing) {
    logger.warn({ runId }, "Workflow run job for unknown run — ignored");
    return "noop";
  }
  if (existing.status === "completed" || existing.status === "failed") return "noop";

  const run = await runsRepo.claimRun(runId, leaseMs);
  if (!run) {
    logger.info({ runId, companyId: existing.companyId }, "Workflow run is held by another worker — ignored");
    return "noop";
  }
  const base = { runId: run.id, companyId: run.companyId, workflowDefinitionId: run.workflowDefinitionId, triggerType: run.triggerType, attempt: attempt.attempts };
  logger.info(base, "Workflow run started");

  const finalAttempt = attempt.attempts >= attempt.maxAttempts;

  try {
    const actionsDef = snapshotActions(run.definitionSnapshot);
    const entityType = run.entityType as WorkflowEntity;
    const principal = await buildPrincipal(run.companyId, run.actorUserId);
    const actionRows = await runsRepo.actionsForRun(run.id);

    for (const action of actionRows) {
      if (action.status === "completed" || action.status === "skipped") continue;
      const def = actionsDef[action.actionIndex];
      if (!def || def.type !== action.actionType) throw new WorkflowFailure("SNAPSHOT_INVALID", `captured action ${action.actionIndex} does not match its run record`);
      const executor = executors[def.type];
      if (!executor) throw new WorkflowFailure("UNSUPPORTED_ACTION", `no executor for action type "${def.type}"`);

      // Entitlement re-check before EVERY action (B20 Correction 1): the canonical
      // subscription is re-read now, not at trigger time. A read_only or blocked
      // tenant gets NO action — no email, no notification, no CRM mutation — and the
      // run fails deterministically (never retried, never replayed). The action row
      // records the failure so the history explains why nothing happened.
      const tenant = await loadTenantAccess(run.companyId);
      if (tenant.access.blocked || tenant.access.readOnly) {
        const accessMode = tenant.entitlement.accessMode;
        const reasonCode = tenant.entitlement.reasonCode ?? "UNKNOWN_STATUS";
        await runsRepo.updateActionRun(action.id, {
          status: "failed",
          error: { code: "SUBSCRIPTION_NOT_WRITABLE", errorClass: "WorkflowFailure", retryable: false, accessMode, reasonCode, actionIndex: action.actionIndex, actionType: def.type, message: `subscription access is ${accessMode}` },
          completedAt: new Date(),
        });
        throw new WorkflowFailure("SUBSCRIPTION_NOT_WRITABLE", `subscription access is ${accessMode} (${reasonCode}); workflow actions are not executed`);
      }

      // Tenant re-check before EVERY mutation: the entity must still belong to
      // the run's company (deterministic failure otherwise). Reloaded per action so
      // later actions see what earlier ones changed.
      const entity = await loadEntity(entityType, run.companyId, run.entityId);

      await runsRepo.updateActionRun(action.id, { status: "running", attempts: action.attempts + 1, startedAt: action.startedAt ?? new Date(), error: null });
      let completedInTx = false;
      const ctx: ActionContext = {
        runId: run.id,
        companyId: run.companyId,
        actorUserId: run.actorUserId ?? null,
        principal,
        entityType,
        entityId: run.entityId,
        lead: entity.lead,
        contact: entity.contact,
        actionIndex: action.actionIndex,
        idempotencyKey: `wf:${run.id}:${action.actionIndex}`,
        transactional: (fn) =>
          db.transaction(async (tx: Executor) => {
            const result = await fn(tx);
            await runsRepo.updateActionRun(action.id, { status: "completed", result, error: null, completedAt: new Date() }, tx);
            completedInTx = true;
            return result;
          }),
      };

      try {
        const result = await runInWorkflowContext(run.id, () => executor(def.config, ctx));
        if (!completedInTx) await runsRepo.updateActionRun(action.id, { status: "completed", result, error: null, completedAt: new Date() });
        logger.debug({ ...base, actionIndex: action.actionIndex, actionType: def.type }, "Workflow action completed");
      } catch (err) {
        if (err instanceof WorkflowSkip) {
          await runsRepo.updateActionRun(action.id, { status: "skipped", result: { reason: err.reason }, error: null, completedAt: new Date() });
          logger.info({ ...base, actionIndex: action.actionIndex, actionType: def.type, reason: err.reason }, "Workflow action skipped");
          continue;
        }
        const c = classifyError(err);
        const errInfo = sanitizedError(c, { actionIndex: action.actionIndex, actionType: def.type });
        if (!c.retryable || finalAttempt) {
          await runsRepo.updateActionRun(action.id, { status: "failed", error: errInfo, completedAt: new Date() });
          await runsRepo.finishRun(run.id, "failed", finalAttempt && c.retryable ? { ...errInfo, code: "RETRIES_EXHAUSTED", underlyingCode: c.code } : errInfo);
          logger.error({ ...base, actionIndex: action.actionIndex, actionType: def.type, code: errInfo.code, errorClass: c.errorClass }, "Workflow run failed");
          return "failed";
        }
        // Transient: keep the action pending (attempt count persisted), hand the
        // run back to the queue's retry/backoff.
        await runsRepo.updateActionRun(action.id, { status: "pending", error: errInfo });
        await runsRepo.releaseRunLock(run.id);
        logger.warn({ ...base, actionIndex: action.actionIndex, actionType: def.type, code: c.code, errorClass: c.errorClass }, "Workflow action failed transiently; retry scheduled");
        throw err;
      }
      await runsRepo.refreshRunLock(run.id, leaseMs);
    }

    await runsRepo.finishRun(run.id, "completed", null);
    logger.info({ ...base, actions: actionRows.length }, "Workflow run completed");
    return "completed";
  } catch (err) {
    if (err instanceof WorkflowSkip) throw err; // impossible outside the loop; keep the type narrow
    const c = classifyError(err);
    // Errors raised outside an action (snapshot, principal, entity): same policy.
    const alreadyFinal = (await runsRepo.findRunById(run.id))?.status;
    if (alreadyFinal === "failed" || alreadyFinal === "completed") return alreadyFinal === "failed" ? "failed" : "completed";
    if (!c.retryable || finalAttempt) {
      await runsRepo.finishRun(run.id, "failed", sanitizedError(c, finalAttempt && c.retryable ? { code: "RETRIES_EXHAUSTED", underlyingCode: c.code } : {}));
      logger.error({ ...base, code: c.code, errorClass: c.errorClass }, "Workflow run failed");
      return "failed";
    }
    // Transient, attempts remain: release the lease (idempotent if the loop already
    // did) and hand the run back to the queue's retry/backoff.
    await runsRepo.releaseRunLock(run.id).catch(() => undefined);
    throw err;
  }
}

// JobQueue handler registration (called from lib/jobs/handlers.ts). The payload is
// minimal — run/company ids only; the persisted run carries everything else.
export function registerWorkflowRunHandler(queue: JobQueue): void {
  queue.register<WorkflowRunJobPayload>(WORKFLOW_RUN_JOB, async (payload, job) => {
    if (!payload || typeof payload.runId !== "number") throw new WorkflowFailure("INVALID_PAYLOAD", "workflow.run payload must carry runId");
    await executeRun(payload.runId, { attempts: job.attempts, maxAttempts: job.maxAttempts });
  });
}
