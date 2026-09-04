import { config } from "../../config.js";
import { logger } from "../logger.js";
import { getQueue } from "../jobs/queue.js";
import type { JobQueue } from "../jobs/types.js";
import * as runsRepo from "../../repositories/workflow_runs.repository.js";
import { enqueueRun } from "./engine.js";

// =============================================================================
// Orphaned-run recovery (Batch 16). Not a scheduler of its own: it is one task of
// the EXISTING recurring scheduler (and runs once at boot). It re-enqueues runs
// that are still `queued` after the grace period (the process died between the
// run insert and the enqueue, or the enqueue itself failed) and runs stuck in
// `running` long past any lease (worker died, queue attempts exhausted). Each
// re-enqueue bumps the run's enqueue generation → a fresh queue dedupe key; the
// run row itself is reused, so nothing is ever duplicated: the executor is
// idempotent and the execution lease serializes concurrent deliveries.
// =============================================================================

export async function recoverOrphanedWorkflowRuns(queue: JobQueue = getQueue()): Promise<{ scanned: number; requeued: number }> {
  const cfg = config.jobs.workflows;
  const now = Date.now();
  const rows = await runsRepo.listOrphanedRuns(new Date(now - cfg.recoveryQueuedGraceMs), new Date(now - cfg.recoveryStaleRunningMs), cfg.recoveryBatchSize);
  let requeued = 0;
  for (const row of rows) {
    const bumped = await runsRepo.bumpEnqueueGeneration(row.id);
    if (!bumped) continue; // finished in the meantime
    try {
      await enqueueRun(queue, bumped);
      requeued++;
      logger.warn({ runId: bumped.id, companyId: bumped.companyId, status: bumped.status, generation: bumped.enqueueGeneration }, "Orphaned workflow run re-enqueued");
    } catch (err) {
      logger.error({ err, runId: row.id, companyId: row.companyId }, "Orphaned workflow run re-enqueue failed");
    }
  }
  if (rows.length > 0) logger.info({ scanned: rows.length, requeued }, "Workflow orphan recovery sweep complete");
  return { scanned: rows.length, requeued };
}
