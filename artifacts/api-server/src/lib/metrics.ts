import type { Request, Response, NextFunction } from "express";
import { getQueue } from "./jobs/queue.js";

// Phase 2.10 — in-process request/job metrics. A tiny, dependency-free registry that
// accumulates request counts (by status class), latency (sum/max for avg + worst case),
// and an error count, plus a process-uptime baseline. It is intentionally vendor-neutral:
// the snapshot is plain JSON, so it can be scraped by anything or rendered in the UI.
//
// CAVEAT: counters live only in this process's memory, so they reset on restart and a
// multi-instance deployment reports per-instance numbers. This mirrors the in-process
// job queue's documented tradeoff and is acceptable for operational visibility.

const startedAt = Date.now();

type StatusClass = "2xx" | "3xx" | "4xx" | "5xx";

const byStatusClass: Record<StatusClass, number> = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
let total = 0;
let errors = 0;
let latencySumMs = 0;
let latencyMaxMs = 0;

function classOf(statusCode: number): StatusClass | null {
  if (statusCode >= 200 && statusCode < 300) return "2xx";
  if (statusCode >= 300 && statusCode < 400) return "3xx";
  if (statusCode >= 400 && statusCode < 500) return "4xx";
  if (statusCode >= 500) return "5xx";
  return null;
}

export function recordRequest(statusCode: number, durationMs: number): void {
  const cls = classOf(statusCode);
  if (!cls) return;
  total++;
  byStatusClass[cls]++;
  if (cls === "5xx") errors++;
  latencySumMs += durationMs;
  if (durationMs > latencyMaxMs) latencyMaxMs = durationMs;
}

// Records every request's outcome on response `finish`. Mounted early so the measured
// latency spans the whole pipeline. Additive: observes only, never alters the response.
export function metricsMiddleware(_req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    recordRequest(res.statusCode, durationMs);
  });
  next();
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface MetricsSnapshotData {
  uptimeSeconds: number;
  timestamp: string;
  requests: {
    total: number;
    errors: number;
    errorRate: number;
    avgLatencyMs: number;
    maxLatencyMs: number;
    byStatusClass: Record<StatusClass, number>;
  };
  jobs: ReturnType<ReturnType<typeof getQueue>["stats"]>;
}

export function snapshot(): MetricsSnapshotData {
  return {
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
    requests: {
      total,
      errors,
      errorRate: total > 0 ? round2(errors / total) : 0,
      avgLatencyMs: total > 0 ? round2(latencySumMs / total) : 0,
      maxLatencyMs: round2(latencyMaxMs),
      byStatusClass: { ...byStatusClass },
    },
    jobs: getQueue().stats(),
  };
}
