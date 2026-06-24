import { Router, type IRouter } from "express";
import { HealthCheckResponse, ReadinessCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { config } from "../config.js";
import { objectStorageClient } from "../lib/objectStorage.js";
import { snapshot } from "../lib/metrics.js";
import { requireAuth, requireRole } from "../middlewares/requireAuth.js";

const router: IRouter = Router();

// Liveness: the process is up and serving. Cheap, dependency-free, and the
// response shape is unchanged so existing consumers keep working.
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Real object-storage reachability probe (closes tech-debt M2). Bounded so a slow or
// unreachable bucket can't hang readiness: a ~2s race returns "error" instead of blocking.
// Returns "not_configured" when no bucket is set (storage is optional in some envs).
async function checkStorageReachable(): Promise<"ok" | "error" | "not_configured"> {
  const bucketId = config.objectStorage.bucketId;
  if (!bucketId) return "not_configured";
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("storage probe timed out")), 2000);
    });
    const probe = objectStorageClient
      .bucket(bucketId)
      .exists()
      .then(([exists]) => exists);
    const exists = await Promise.race([probe, timeout]);
    return exists ? "ok" : "error";
  } catch {
    return "error";
  } finally {
    if (timer) clearTimeout(timer);
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

// Operational metrics snapshot (request counts/latency/error rate + job-queue stats).
// Gated to platform_owner — operational internals, not a public endpoint.
router.get("/metrics", requireAuth, requireRole("platform_owner"), (_req, res) => {
  res.json(snapshot());
});

export default router;
