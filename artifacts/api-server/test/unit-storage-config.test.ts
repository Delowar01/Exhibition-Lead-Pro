// Batch 25 — object-storage driver selection truth table (config.ts). Pure
// function; the live config object is not mutated.
import { describe, it, expect } from "vitest";
import { resolveObjectStorageDriver } from "../src/config.js";

const ROOT = "/var/lib/lcp/objects";

describe("resolveObjectStorageDriver", () => {
  it("honours an explicit driver and reports why it cannot be used", () => {
    expect(resolveObjectStorageDriver("production", "fs", { fsRoot: ROOT })).toEqual({ driver: "fs", driverReason: null });
    expect(resolveObjectStorageDriver("production", "fs", {})).toEqual({ driver: "none", driverReason: "FS_ROOT_MISSING" });
    expect(resolveObjectStorageDriver("production", "gcs", { bucketId: "b" })).toEqual({ driver: "gcs", driverReason: null });
    expect(resolveObjectStorageDriver("production", "gcs", { fsRoot: ROOT })).toEqual({ driver: "none", driverReason: "BUCKET_MISSING" });
    expect(resolveObjectStorageDriver("development", "memory", {})).toEqual({ driver: "memory", driverReason: null });
    expect(resolveObjectStorageDriver("production", "memory", {})).toEqual({ driver: "none", driverReason: "MEMORY_FORBIDDEN_IN_PRODUCTION" });
    expect(resolveObjectStorageDriver("development", "none", { fsRoot: ROOT, bucketId: "b" })).toEqual({ driver: "none", driverReason: "DISABLED" });
    expect(resolveObjectStorageDriver("development", "s3", { fsRoot: ROOT })).toEqual({ driver: "none", driverReason: "UNKNOWN_DRIVER" });
    expect(resolveObjectStorageDriver("development", " FS ", { fsRoot: ROOT })).toEqual({ driver: "fs", driverReason: null });
  });

  it("auto-selects fs → gcs → memory (non-production) → none when the driver is unset or empty", () => {
    for (const unset of [undefined, "", "  "]) {
      expect(resolveObjectStorageDriver("production", unset, { fsRoot: ROOT, bucketId: "b" })).toEqual({ driver: "fs", driverReason: null });
      expect(resolveObjectStorageDriver("production", unset, { bucketId: "b" })).toEqual({ driver: "gcs", driverReason: null });
      expect(resolveObjectStorageDriver("development", unset, {})).toEqual({ driver: "memory", driverReason: null });
      expect(resolveObjectStorageDriver("test", unset, { fsRoot: "", bucketId: "" })).toEqual({ driver: "memory", driverReason: null });
      expect(resolveObjectStorageDriver("production", unset, {})).toEqual({ driver: "none", driverReason: "NOT_CONFIGURED" });
    }
  });

  it("keeps the hosted pre-B25 behaviour: bucket configured, no OBJECT_STORAGE_* → gcs", () => {
    expect(resolveObjectStorageDriver("production", "", { fsRoot: "", bucketId: "dev-bucket" })).toEqual({ driver: "gcs", driverReason: null });
  });
});
