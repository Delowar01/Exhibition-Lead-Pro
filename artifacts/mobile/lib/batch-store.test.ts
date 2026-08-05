import { afterEach, describe, expect, it } from "vitest";
import {
  clearBatchCaptures,
  getBatchCaptures,
  getBatchOcrResult,
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
});
