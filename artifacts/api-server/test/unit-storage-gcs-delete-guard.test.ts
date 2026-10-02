// B25 Correction 6 — static + runtime guard: the ONLY call of the Google Cloud
// Storage SDK's delete method in the application lives in GcsStorageDriver, and
// it is unreachable without an exact generation precondition. A regression that
// adds a second SDK delete call site, or removes the precondition, fails here
// without any database or provider.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { GcsStorageDriver } from "../src/storage/gcs-driver.js";
import { StorageError } from "../src/storage/contract.js";
import { FakeBucketStore, fakeGcsClient } from "./helpers/fake-gcs-sdk.js";

const SRC = join(process.cwd(), "src");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("GCS delete guard", () => {
  const files = walk(SRC);
  const driverPath = join(SRC, "storage", "gcs-driver.ts");
  const driver = readFileSync(driverPath, "utf8");

  it("the GCS driver is the only module that touches the SDK's File.delete, and that call always carries ifGenerationMatch", () => {
    const sdkDeleteCalls = driver.match(/\.file\([^)]*\)\.delete\(|this\.file\(key\)\.delete\(/g) ?? [];
    expect(sdkDeleteCalls).toHaveLength(1);
    const call = driver.slice(driver.indexOf("this.file(key).delete("));
    const callText = call.slice(0, call.indexOf(";"));
    expect(callText).toContain("ifGenerationMatch");
    expect(callText).not.toMatch(/ifGenerationMatch\s*:\s*undefined/);
    // no module other than the driver may reach a bucket/file delete of the SDK
    for (const f of files) {
      if (f === driverPath) continue;
      const text = readFileSync(f, "utf8");
      expect(text, `${f.replace(SRC, "src")} reaches the SDK delete surface`).not.toMatch(/\.bucket\([^)]*\)\.file\([^)]*\)\.delete\(|objectStorageClient[^\n]*\.delete\(/);
    }
  });

  it("the public delete refuses to run without a generation (checked before the SDK)", () => {
    const method = driver.slice(driver.indexOf("async delete(key: string"));
    const body = method.slice(0, method.indexOf("this.file(key).delete("));
    expect(body).toMatch(/opts\.ifGeneration === undefined[\s\S]*throw/);
  });

  it("runtime: delete without a generation throws GENERATION_REQUIRED and never reaches the fake SDK", async () => {
    const store = new FakeBucketStore();
    const d = new GcsStorageDriver(fakeGcsClient(store), "fake-bucket");
    store.seed("tenants/1/reports/x", Buffer.from("x"));
    await expect(d.delete("tenants/1/reports/x")).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", reason: "GENERATION_REQUIRED" });
    await expect(d.delete("gs://fake-bucket/tenants/1/reports/x", {})).rejects.toBeInstanceOf(StorageError);
    expect(store.deleteCalls).toEqual([]);
    await d.delete("tenants/1/reports/x", { ifGeneration: "1" });
    expect(store.deleteCalls).toEqual([{ name: "tenants/1/reports/x", opts: { ignoreNotFound: true, ifGenerationMatch: 1 } }]);
  });

  it("every application delete call site is classified", () => {
    const service = readFileSync(join(SRC, "services", "storage.service.ts"), "utf8");
    // removeCopy: non-GCS by key, GCS by observed generation
    expect(service).toMatch(/if \(driver\.kind !== "gcs"\) \{[\s\S]*?await driver\.delete\(key\);/);
    expect(service).toContain("await driver.delete(key, { ifGeneration: head.generation });");
    // discardCopies: never a bare delete on a GCS driver
    const discard = service.slice(service.indexOf("export async function discardCopies"), service.indexOf("export type LeasedRollbackOutcome"));
    // a GCS copy without a recorded generation is proven by HEAD (owner + generation) before any delete, or left in place;
    // the generic branch is reached only by non-GCS copies or copies that carry their generation
    const guard = discard.indexOf('copy.driver.kind === "gcs" && !copy.generation');
    const generic = discard.indexOf("copy.generation ? { ifGeneration: copy.generation } : undefined");
    expect(guard).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(guard);
    expect(discard.slice(guard, generic)).toContain("head.owner !== attempt.rowId");
    expect(discard.slice(guard, generic)).toContain("copy.driver.delete(copy.key, { ifGeneration: head.generation })");
    // migration mismatch cleanup passes the generation it got
    const migration = readFileSync(join(SRC, "storage", "migration.ts"), "utf8");
    expect(migration).toMatch(/target\.delete\(row\.storageKey, put\.generation \? \{ ifGeneration: put\.generation \} : undefined\)/);
  });
});
