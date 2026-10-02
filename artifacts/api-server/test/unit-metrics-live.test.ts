// Batch 24 — unit coverage of the live metrics seam and the /metrics route's
// failure behaviour. No database and no running server: the queue accessor and
// the auth middlewares are replaced with test doubles, the real health router
// and error handler are mounted on a throwaway Express app.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({
  liveStats: vi.fn(),
  stats: vi.fn(),
}));

vi.mock("../src/lib/jobs/queue.js", () => ({
  getQueue: () => ({ driver: "test-double", stats: mocks.stats, liveStats: mocks.liveStats }),
}));
vi.mock("../src/middlewares/requireAuth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { liveSnapshot } from "../src/lib/metrics.js";
import healthRouter from "../src/routes/health.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";

const OK = { pending: 0, active: 0, enqueued: 0, completed: 0, failed: 0, deadLettered: 0 };

beforeEach(() => {
  mocks.liveStats.mockReset();
  mocks.stats.mockReset().mockReturnValue({ ...OK, pending: -1 });
});

describe("liveSnapshot — the operator snapshot carries the live queue view", () => {
  it("reports the live pending count, not the synchronous process view", async () => {
    mocks.liveStats.mockResolvedValue({ ...OK, pending: 7, completed: 2 });
    const snap = await liveSnapshot();
    expect(snap.jobs).toEqual({ ...OK, pending: 7, completed: 2 });
    expect(mocks.stats).not.toHaveBeenCalled();
  });

  it("rejects when the live state cannot be read — no false zero", async () => {
    mocks.liveStats.mockRejectedValue(new Error("relation unreadable (test double)"));
    await expect(liveSnapshot()).rejects.toThrow(/unreadable/);
  });

  it("rejects a negative or non-integer pending value instead of serving it", async () => {
    mocks.liveStats.mockResolvedValue({ ...OK, pending: -1 });
    await expect(liveSnapshot()).rejects.toThrow(/non-negative integer/);
    mocks.liveStats.mockResolvedValue({ ...OK, pending: 1.5 });
    await expect(liveSnapshot()).rejects.toThrow(/non-negative integer/);
  });
});

describe("GET /metrics — route behaviour when the queue state is unreadable", () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: () => void } }).log = { error: vi.fn() };
    next();
  });
  app.use(healthRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/metrics`;
  afterAll(() => server.close());

  it("serves the live snapshot on success", async () => {
    mocks.liveStats.mockResolvedValue({ ...OK, pending: 3 });
    const res = await fetch(url());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs.pending).toBe(3);
    expect(typeof body.requests.total).toBe("number");
  });

  it("answers 503 METRICS_UNAVAILABLE with a generic message when the durable count cannot be read", async () => {
    mocks.liveStats.mockRejectedValue(new Error("FATAL: password authentication failed for user (test double)"));
    const res = await fetch(url());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("METRICS_UNAVAILABLE");
    expect(body.error).toBe("Operational metrics are temporarily unavailable");
    expect(body.jobs).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/password|FATAL|test double/);
  });
});
