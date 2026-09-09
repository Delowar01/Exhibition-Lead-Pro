import { config } from "../../config.js";
import { logger } from "../logger.js";
import { runFollowUpReminders } from "../followup-scheduler.js";
import { runMaintenance } from "./maintenance.js";
import { runDueSchedules } from "../../services/export.service.js";
import { runWorkflowAlerts } from "../workflow-alerts.js";
import { runAiUsageAlerts } from "../ai-alerts.js";
import { recoverOrphanedWorkflowRuns } from "../workflows/recovery.js";
import { runSubscriptionSweep } from "./subscription-sweep.js";
import { getQueue } from "./queue.js";
import type { JobQueue } from "./types.js";

// Recurring task scheduler (Phase 2.6, made durable in Batch 14). The process
// timer is now only a lightweight DISPATCHER: each tick enqueues a durable
// "recurring.sweep" job instead of executing the (potentially slow) business
// sweep inside the timer callback. Accepted periodic work therefore survives a
// crash/restart, and the sweep itself runs on the queue's worker pool with the
// queue's failure isolation.
//
// Duplicate protection across processes/restarts: every dispatch carries a
// stable cadence-bucket dedupe key — `recurring:<task>:<floor(now/interval)>` —
// so two dispatchers (two API processes, or a restart inside the same bucket
// while the previous job is still active) collapse onto ONE durable job via the
// DB-enforced unique index. Sweeps themselves are idempotent, so the bucket
// boundary re-run after a completed job is harmless and bounded to one per
// interval. Cadence configuration is unchanged.

export const RECURRING_SWEEP_JOB = "recurring.sweep";

const TASKS: Record<string, () => Promise<unknown>> = {
  followUpReminders: runFollowUpReminders,
  maintenance: runMaintenance,
  exportSchedules: runDueSchedules,
  workflowAlerts: runWorkflowAlerts,
  aiUsageAlerts: runAiUsageAlerts,
  // Batch 16: re-enqueue orphaned/abandoned workflow runs (no second scheduler).
  workflowRecovery: () => recoverOrphanedWorkflowRuns(),
  // Batch 20: elapsed MANUAL trials → expired (never touches Stripe-managed rows).
  subscriptionSweep: () => runSubscriptionSweep(),
};

export interface RecurringSweepPayload {
  task: string;
}

// Registered from startWorkers alongside the other handlers.
export function registerRecurringHandler(queue: JobQueue): void {
  queue.register<RecurringSweepPayload>(RECURRING_SWEEP_JOB, async (payload) => {
    const fn = TASKS[payload.task];
    if (!fn) throw new Error(`Unknown recurring task "${payload.task}"`);
    await fn();
  });
}

// Enqueue one durable sweep for a cadence bucket. Exported for tests. Sweeps run
// once (no retry) — the next tick is the natural retry, and a failing sweep must
// not stack retries on top of its own cadence.
export function dispatchRecurring(queue: JobQueue, task: string, intervalMs: number, now = Date.now()): Promise<void> {
  const bucket = Math.floor(now / Math.max(1, intervalMs));
  return queue.enqueue<RecurringSweepPayload>(
    RECURRING_SWEEP_JOB,
    { task },
    { maxAttempts: 1, dedupeKey: `recurring:${task}:${intervalMs}:${bucket}` },
  );
}

const timers: NodeJS.Timeout[] = [];

function registerRecurring(name: string, firstDelayMs: number, intervalMs: number): void {
  const tick = () => {
    dispatchRecurring(getQueue(), name, intervalMs).catch((err) =>
      logger.error({ err, task: name }, "Scheduled task dispatch failed"),
    );
  };
  const startTimer = setTimeout(() => {
    tick();
    const interval = setInterval(tick, intervalMs);
    if (typeof interval.unref === "function") interval.unref();
    timers.push(interval);
  }, firstDelayMs);
  if (typeof startTimer.unref === "function") startTimer.unref();
  timers.push(startTimer);
}

export function startScheduler(): void {
  const s = config.jobs.schedule;
  // Follow-up reminders (folded in from the standalone follow-up scheduler).
  registerRecurring("followUpReminders", s.followUpFirstDelayMs, s.followUpIntervalMs);
  // Maintenance sweep: token/session cleanup, invitation expiry, retention.
  registerRecurring("maintenance", s.maintenanceFirstDelayMs, s.maintenanceIntervalMs);
  // Scheduled-export sweep: produce files for due export schedules (all tenants).
  registerRecurring("exportSchedules", s.exportFirstDelayMs, s.exportIntervalMs);
  // Stage 5F workflow risk alerts: critical/high SLA risks → owner + executive digests.
  registerRecurring("workflowAlerts", s.workflowAlertsFirstDelayMs, s.workflowAlertsIntervalMs);
  // Batch 6 AI usage alerts: spikes, failure rates, ledger-write failures (budget
  // thresholds are checked inline on the invocation path). Deduped per kind/tenant/day.
  registerRecurring("aiUsageAlerts", config.ai.alerts.sweepFirstDelayMs, config.ai.alerts.sweepIntervalMs);
  // Batch 16 workflow-run orphan recovery (queued-but-never-enqueued / abandoned running).
  registerRecurring("workflowRecovery", s.workflowRecoveryFirstDelayMs, s.workflowRecoveryIntervalMs);
  // Batch 20 subscription lifecycle sweep: once shortly after boot, then on a conservative cadence.
  registerRecurring("subscriptionSweep", s.subscriptionSweepFirstDelayMs, s.subscriptionSweepIntervalMs);
  logger.info(
    {
      followUpIntervalMs: s.followUpIntervalMs,
      maintenanceIntervalMs: s.maintenanceIntervalMs,
      exportIntervalMs: s.exportIntervalMs,
      workflowAlertsIntervalMs: s.workflowAlertsIntervalMs,
      subscriptionSweepIntervalMs: s.subscriptionSweepIntervalMs,
    },
    "Recurring task scheduler started (durable dispatch)",
  );
}

// Stops all scheduled timers. Primarily for tests / graceful shutdown.
export function stopScheduler(): void {
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
}
