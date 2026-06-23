import { Router, type IRouter } from "express";
import { HealthCheckResponse, ReadinessCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";
import { config } from "../config.js";

const router: IRouter = Router();

// Liveness: the process is up and serving. Cheap, dependency-free, and the
// response shape is unchanged so existing consumers keep working.
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Readiness: the process can serve real traffic — its database is reachable and
// object storage is configured. Returns 503 when a critical dependency (the DB)
// is down so orchestrators can hold traffic until it recovers.
router.get("/readyz", async (req, res) => {
  let database: "ok" | "error" = "ok";
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    database = "error";
    req.log.error({ err }, "Database readiness check failed");
  }

  const storage: "ok" | "not_configured" = config.objectStorage.bucketId
    ? "ok"
    : "not_configured";

  const ready = database === "ok";
  const data = ReadinessCheckResponse.parse({
    status: ready ? "ok" : "degraded",
    checks: { database, storage },
  });
  res.status(ready ? 200 : 503).json(data);
});

export default router;
