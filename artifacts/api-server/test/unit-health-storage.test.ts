// Focused unit tests for the readiness storage probe (routes/health.ts
// checkStorageReachable). The probe must use only an operation permitted by a
// bucket-scoped Storage Object Admin grant (a single-object LIST) — never
// bucket metadata/existence calls — and must map outcomes to the existing
// ok | error | not_configured contract. No live GCS, no server required.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFiles: vi.fn(),
  bucket: vi.fn(),
}));

vi.mock("../src/lib/objectStorage.js", () => ({
  objectStorageClient: {
    bucket: mocks.bucket.mockImplementation(() => ({ getFiles: mocks.getFiles })),
  },
}));

import { checkStorageReachable } from "../src/routes/health.js";
import { config } from "../src/config.js";

const storageConfig = config.objectStorage as { bucketId: string };
const originalBucketId = storageConfig.bucketId;

beforeEach(() => {
  mocks.getFiles.mockReset();
  mocks.bucket.mockClear();
});

afterAll(() => {
  storageConfig.bucketId = originalBucketId;
});

describe("checkStorageReachable — least-privilege readiness probe", () => {
  it("returns not_configured when no bucket is set (no API call at all)", async () => {
    storageConfig.bucketId = "";
    await expect(checkStorageReachable()).resolves.toBe("not_configured");
    expect(mocks.bucket).not.toHaveBeenCalled();
    expect(mocks.getFiles).not.toHaveBeenCalled();
  });

  it("returns ok when the object list succeeds — even with zero objects", async () => {
    storageConfig.bucketId = "dev-bucket";
    mocks.getFiles.mockResolvedValueOnce([[]]);
    await expect(checkStorageReachable()).resolves.toBe("ok");
    expect(mocks.bucket).toHaveBeenCalledWith("dev-bucket");
    // Object-Admin-permitted single-request list; no exists()/metadata call.
    expect(mocks.getFiles).toHaveBeenCalledWith({
      maxResults: 1,
      prefix: ".private/",
      autoPaginate: false,
    });
  });

  it("returns error when the storage call fails", async () => {
    storageConfig.bucketId = "dev-bucket";
    mocks.getFiles.mockRejectedValueOnce(new Error("403 forbidden"));
    await expect(checkStorageReachable()).resolves.toBe("error");
  });

  it("returns error when the probe exceeds the 2s timeout", async () => {
    vi.useFakeTimers();
    try {
      storageConfig.bucketId = "dev-bucket";
      mocks.getFiles.mockImplementationOnce(() => new Promise(() => {}));
      const pending = checkStorageReachable();
      await vi.advanceTimersByTimeAsync(2001);
      await expect(pending).resolves.toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });
});
