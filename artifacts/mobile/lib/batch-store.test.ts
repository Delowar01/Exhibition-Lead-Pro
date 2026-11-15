import { afterEach, describe, expect, it } from "vitest";
import {
  clearBatchCaptures,
  getBatchCaptures,
  getBatchOcrResult,
  getBatchSession,
  getPendingOcrCount,
  setBatchCaptures,
  setBatchOcrResult,
  type BatchCapture,
} from "./batch-store";

// Batch 8 — batch-capture store lifecycle. This store is the contract between
// capture-camera (which fires background OCR per shot) and batch-review (which
// polls results and retries failures). The ordering rules here are load-bearing:
// background OCR can complete BEFORE the captures list is handed over.

function capture(id: string): BatchCapture {
  return { id, imageData: `data:image/jpeg;base64,${id}`, latitude: null, longitude: null, gpsAccuracy: null };
}

afterEach(() => clearBatchCaptures());

describe("batch-store", () => {
  it("keeps OCR results that arrived BEFORE setBatchCaptures (background OCR race)", () => {
    // Background OCR for shot-1 finishes while the user is still shooting.
    setBatchOcrResult("shot-1", { status: "done", extracted: null, scanId: 101 });
    setBatchCaptures([capture("shot-1"), capture("shot-2")]);
    // Handing over the capture list must NOT wipe the pre-computed result.
    expect(getBatchOcrResult("shot-1")?.status).toBe("done");
    expect(getBatchOcrResult("shot-1")?.scanId).toBe(101);
    expect(getBatchCaptures().map((c) => c.id)).toEqual(["shot-1", "shot-2"]);
  });

  it("represents a partial-success batch (done + error + pending) faithfully", () => {
    setBatchCaptures([capture("a"), capture("b"), capture("c")]);
    setBatchOcrResult("a", { status: "done", extracted: null, scanId: 1 });
    setBatchOcrResult("b", { status: "error", extracted: null, scanId: null });
    setBatchOcrResult("c", { status: "pending", extracted: null, scanId: null });
    expect(getBatchOcrResult("a")?.status).toBe("done");
    expect(getBatchOcrResult("b")?.status).toBe("error");
    expect(getBatchOcrResult("c")?.status).toBe("pending");
    expect(getPendingOcrCount()).toBe(1);
  });

  it("retry updates ONLY the failed item — successful siblings keep their results", () => {
    setBatchCaptures([capture("ok"), capture("bad")]);
    setBatchOcrResult("ok", { status: "done", extracted: null, scanId: 7 });
    setBatchOcrResult("bad", { status: "error", extracted: null, scanId: null });
    // Retry of the failed item: pending → done. The sibling must be untouched.
    setBatchOcrResult("bad", { status: "pending", extracted: null, scanId: null });
    expect(getPendingOcrCount()).toBe(1);
    setBatchOcrResult("bad", { status: "done", extracted: null, scanId: 8 });
    expect(getBatchOcrResult("ok")?.scanId).toBe(7);
    expect(getBatchOcrResult("bad")?.scanId).toBe(8);
    expect(getPendingOcrCount()).toBe(0);
  });

  it("clearBatchCaptures ends the session: captures AND results are wiped", () => {
    setBatchCaptures([capture("x")]);
    setBatchOcrResult("x", { status: "done", extracted: null, scanId: 3 });
    clearBatchCaptures();
    expect(getBatchCaptures()).toEqual([]);
    expect(getBatchOcrResult("x")).toBeUndefined();
    expect(getPendingOcrCount()).toBe(0);
  });

  it("counts only pending results toward the unfinished-work indicator", () => {
    setBatchOcrResult("p1", { status: "pending", extracted: null, scanId: null });
    setBatchOcrResult("p2", { status: "pending", extracted: null, scanId: null });
    setBatchOcrResult("d1", { status: "done", extracted: null, scanId: 2 });
    setBatchOcrResult("e1", { status: "error", extracted: null, scanId: null });
    expect(getPendingOcrCount()).toBe(2);
  });

  // ── Batch 38: pending-count consistency, OCR transitions and session safety ──

  it("pending count increments per shot and decrements on every completion (done or error)", () => {
    const session = getBatchSession();
    setBatchOcrResult("s1", { status: "pending", extracted: null, scanId: null }, session);
    setBatchOcrResult("s2", { status: "pending", extracted: null, scanId: null }, session);
    setBatchOcrResult("s3", { status: "pending", extracted: null, scanId: null }, session);
    expect(getPendingOcrCount()).toBe(3);
    setBatchOcrResult("s1", { status: "done", extracted: null, scanId: 11 }, session);
    expect(getPendingOcrCount()).toBe(2);
    setBatchOcrResult("s2", { status: "error", extracted: null, scanId: null }, session);
    expect(getPendingOcrCount()).toBe(1);
    setBatchOcrResult("s3", { status: "done", extracted: null, scanId: 13 }, session);
    expect(getPendingOcrCount()).toBe(0);
    // Success and failure are both terminal: the counter never goes negative and
    // the per-item results stay faithful.
    expect(getBatchOcrResult("s1")?.status).toBe("done");
    expect(getBatchOcrResult("s2")?.status).toBe("error");
    expect(getBatchOcrResult("s3")?.scanId).toBe(13);
  });

  it("a completion carrying the current session token is accepted", () => {
    const session = getBatchSession();
    expect(setBatchOcrResult("c1", { status: "pending", extracted: null, scanId: null }, session)).toBe(true);
    expect(setBatchOcrResult("c1", { status: "done", extracted: null, scanId: 5 }, session)).toBe(true);
    expect(getBatchOcrResult("c1")?.scanId).toBe(5);
  });

  it("batch exit: a late OCR completion from the ended session is ignored and never re-enters the store", () => {
    const oldSession = getBatchSession();
    setBatchOcrResult("late", { status: "pending", extracted: null, scanId: null }, oldSession);
    expect(getPendingOcrCount()).toBe(1);
    clearBatchCaptures(); // Done → review finished, or the user left the batch
    expect(getBatchSession()).toBe(oldSession + 1);
    // The background request finishes afterwards.
    expect(setBatchOcrResult("late", { status: "done", extracted: null, scanId: 99 }, oldSession)).toBe(false);
    expect(setBatchOcrResult("late", { status: "error", extracted: null, scanId: null }, oldSession)).toBe(false);
    expect(getBatchOcrResult("late")).toBeUndefined();
    expect(getPendingOcrCount()).toBe(0);
  });

  it("batch re-entry: the new session starts at zero pending and old results never surface", () => {
    const first = getBatchSession();
    setBatchOcrResult("old-1", { status: "pending", extracted: null, scanId: null }, first);
    setBatchOcrResult("old-2", { status: "done", extracted: null, scanId: 1 }, first);
    clearBatchCaptures(); // entering batch mode again
    const second = getBatchSession();
    expect(second).not.toBe(first);
    expect(getPendingOcrCount()).toBe(0);
    expect(getBatchOcrResult("old-1")).toBeUndefined();
    expect(getBatchOcrResult("old-2")).toBeUndefined();
    // Work of the new session is counted normally.
    setBatchOcrResult("new-1", { status: "pending", extracted: null, scanId: null }, second);
    expect(getPendingOcrCount()).toBe(1);
    // A straggler from the first session cannot disturb the new count.
    expect(setBatchOcrResult("old-1", { status: "done", extracted: null, scanId: 2 }, first)).toBe(false);
    expect(getPendingOcrCount()).toBe(1);
  });

  it("callers without a session token keep the original contract (results always recorded)", () => {
    setBatchOcrResult("legacy", { status: "done", extracted: null, scanId: 4 });
    expect(getBatchOcrResult("legacy")?.scanId).toBe(4);
  });
});
