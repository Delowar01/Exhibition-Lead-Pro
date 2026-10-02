import { Router, type IRouter } from "express";
import { HealthCheckResponse, ReadinessCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { liveSnapshot, type MetricsSnapshotData } from "../lib/metrics.js";
import { AppError } from "../middlewares/errorHandler.js";
import { requireAuth, requireRole } from "../middlewares/requireAuth.js";
import { getPrimaryDriver, storageConfigured } from "../storage/registry.js";

const router: IRouter = Router();

// Liveness: the process is up and serving. Cheap, dependency-free, and the
// response shape is unchanged so existing consumers keep working.
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Real object-storage reachability probe (closes tech-debt M2; Batch 25 drives
// it through the PRIMARY storage driver). Bounded so a slow or unreachable
// store can't hang readiness: every driver's probe() carries its own timeout
// and a failure returns "error" instead of blocking. "not_configured" when no
// driver is configured (storage is optional in some envs).
//
//   fs      write → read → verify → delete of ONE small object under the
//           dedicated `health/` namespace (never a tenant prefix); the probe
//           cleans up after itself and reports no path or key.
//   gcs     the legacy least-privilege single-object LIST (Storage Object
//           Admin scope only; never a bucket-metadata call).
//   memory  trivial round trip.
// Exported for the focused unit tests in test/unit-health-storage.test.ts.
export async function checkStorageReachable(): Promise<"ok" | "error" | "not_configured"> {
  if (!storageConfigured()) return "not_configured";
  try {
    const driver = await getPrimaryDriver();
    await driver.probe();
    return "ok";
  } catch {
    return "error";
  }
}

// Readiness: the process can serve real traffic. The database is the only hard gate
// (503 holds traffic until it recovers); object storage is probed for real but a storage
// outage degrades rather than removes the instance — most requests don't touch storage,
// so flapping it off-rotation would do more harm than good. status is "degraded" (still
// 200) when storage is unreachable so the signal is visible without dropping the node.
router.get("/readyz", async (req, res) => {
  let database: "ok" | "error" = "ok";
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    database = "error";
    req.log.error({ err }, "Database readiness check failed");
  }

  const storage = await checkStorageReachable();

  const ready = database === "ok";
  const status = !ready ? "degraded" : storage === "error" ? "degraded" : "ok";
  const data = ReadinessCheckResponse.parse({
    status,
    checks: { database, storage },
  });
  res.status(ready ? 200 : 503).json(data);
});

// Operational metrics snapshot (request counts/latency/error rate + LIVE job-queue
// stats + Batch 25 object-storage counters). Gated to platform_owner — operational
// internals, not a public endpoint.
// Batch 24: `jobs.pending` comes from the queue's authoritative state (the durable
// job_queue table under the postgres driver); when that read fails the endpoint
// answers 503 METRICS_UNAVAILABLE — never a negative, zero or stale substitute.
router.get("/metrics", requireAuth, requireRole("platform_owner"), async (req, res) => {
  let data: MetricsSnapshotData;
  try {
    data = await liveSnapshot();
  } catch (err) {
    req.log.error({ err }, "Operational metrics unavailable: job-queue state could not be read");
    throw new AppError(503, "Operational metrics are temporarily unavailable", { code: "METRICS_UNAVAILABLE" });
  }
  res.json(data);
});

export default router;
