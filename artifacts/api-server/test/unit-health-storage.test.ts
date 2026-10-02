// Focused unit tests for the readiness storage probe (routes/health.ts
// checkStorageReachable). Batch 25: the probe runs through the PRIMARY
// object-storage driver's bounded probe() and maps outcomes to the existing
// ok | error | not_configured contract. No live storage, no server required —
// the driver registry is replaced with test doubles.
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storageConfigured: vi.fn(),
  getPrimaryDriver: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("../src/storage/registry.js", () => ({
  storageConfigured: mocks.storageConfigured,
  getPrimaryDriver: mocks.getPrimaryDriver,
}));

import { checkStorageReachable } from "../src/routes/health.js";

beforeEach(() => {
  mocks.storageConfigured.mockReset();
  mocks.getPrimaryDriver.mockReset();
  mocks.probe.mockReset();
  mocks.getPrimaryDriver.mockImplementation(async () => ({ kind: "fs", probe: mocks.probe }));
});

describe("checkStorageReachable — primary-driver readiness probe", () => {
  it("returns not_configured when no driver is configured (no driver is resolved at all)", async () => {
    mocks.storageConfigured.mockReturnValue(false);
    await expect(checkStorageReachable()).resolves.toBe("not_configured");
    expect(mocks.getPrimaryDriver).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it("returns ok when the driver probe resolves", async () => {
    mocks.storageConfigured.mockReturnValue(true);
    mocks.probe.mockResolvedValueOnce(undefined);
    await expect(checkStorageReachable()).resolves.toBe("ok");
    expect(mocks.getPrimaryDriver).toHaveBeenCalledTimes(1);
    expect(mocks.probe).toHaveBeenCalledTimes(1);
  });

  it("returns error when the driver probe rejects (never throws, never leaks the reason)", async () => {
    mocks.storageConfigured.mockReturnValue(true);
    mocks.probe.mockRejectedValueOnce(new Error("EACCES: /very/private/path"));
    await expect(checkStorageReachable()).resolves.toBe("error");
  });

  it("returns error when the primary driver itself cannot be initialised (bad root / missing key)", async () => {
    mocks.storageConfigured.mockReturnValue(true);
    mocks.getPrimaryDriver.mockRejectedValueOnce(new Error("OBJECT_STORAGE_ENCRYPTION_KEY is required"));
    await expect(checkStorageReachable()).resolves.toBe("error");
    expect(mocks.probe).not.toHaveBeenCalled();
  });
});
