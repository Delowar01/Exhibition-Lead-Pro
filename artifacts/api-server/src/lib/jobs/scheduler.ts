import { config } from "../../config.js";
import { logger } from "../logger.js";
import { runFollowUpReminders } from "../followup-scheduler.js";
import { runMaintenance } from "./maintenance.js";
import { runDueSchedules } from "../../services/export.service.js";

// Recurring task scheduler (Phase 2.6). A single mechanism for all periodic work,
// replacing per-feature setTimeout/setInterval. Tasks run after a first-run delay and
// then on a fixed interval; every run is wrapped so a throwing task only logs and the
// schedule keeps ticking. Timers are unref'd so they never keep the process alive.

const timers: NodeJS.Timeout[] = [];

function registerRecurring(name: string, firstDelayMs: number, intervalMs: number, fn: () => Promise<unknown>): void {
  const tick = () => {
    fn().catch((err) => logger.error({ err, task: name }, "Scheduled task failed"));
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
  registerRecurring("followUpReminders", s.followUpFirstDelayMs, s.followUpIntervalMs, runFollowUpReminders);
  // Maintenance sweep: token/session cleanup, invitation expiry, retention.
  registerRecurring("maintenance", s.maintenanceFirstDelayMs, s.maintenanceIntervalMs, runMaintenance);
  // Scheduled-export sweep: produce files for due export schedules (all tenants).
  registerRecurring("exportSchedules", s.exportFirstDelayMs, s.exportIntervalMs, runDueSchedules);
  logger.info(
    {
      followUpIntervalMs: s.followUpIntervalMs,
      maintenanceIntervalMs: s.maintenanceIntervalMs,
      exportIntervalMs: s.exportIntervalMs,
    },
    "Recurring task scheduler started",
  );
}

// Stops all scheduled timers. Primarily for tests / graceful shutdown.
export function stopScheduler(): void {
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
}
