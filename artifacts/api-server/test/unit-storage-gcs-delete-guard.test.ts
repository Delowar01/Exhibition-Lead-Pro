// B25 Correction 6 / 7 — static + runtime guard: the ONLY call of the Google
// Cloud Storage SDK's delete method in the application lives in
// GcsStorageDriver, it is unreachable without an exact generation
// precondition, and (Correction 7) the generation reaches `ifGenerationMatch`
// as the caller's exact STRING — never parsed, coerced, rounded or converted
// to a number anywhere in the storage code. A regression that adds a second
// SDK delete call site, removes the precondition or reintroduces any
// numeric conversion fails here without any database or provider.
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

/** Source text without comment lines and trailing ` // …` comments (the static checks look at code, not prose). */
function codeOnly(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .map((line) => line.replace(/\s\/\/.*$/, ""))
    .join("\n");
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
    expect(store.deleteCalls).toEqual([{ name: "tenants/1/reports/x", opts: { ignoreNotFound: true, ifGenerationMatch: "1" } }]);
  });

  it("the SDK delete receives the caller's generation VERBATIM and the driver never converts a generation to a number (Correction 7)", () => {
    const call = driver.slice(driver.indexOf("this.file(key).delete("));
    const callText = call.slice(0, call.indexOf(";"));
    // the exact value, nothing wrapped around it
    expect(callText).toMatch(/ifGenerationMatch:\s*opts\.ifGeneration\s*[,}]/);
    // every known coercion form is rejected anywhere in the driver's code
    const code = codeOnly(driver);
    expect(code).not.toMatch(/Number\(\s*opts\.ifGeneration/);
    expect(code).not.toMatch(/parseInt\(/);
    expect(code).not.toMatch(/parseFloat\(/);
    expect(code).not.toMatch(/BigInt\(/); // no BigInt round trip (BigInt → Number loses the value just the same)
    expect(code).not.toMatch(/[^\w.]\+\s*opts\.ifGeneration/); // unary plus
    expect(code).not.toMatch(/Number\([^)]*[gG]eneration/);
    expect(code).not.toMatch(/[gG]eneration[^\n]*\*\s*1\b/); // `* 1`
    expect(code).not.toMatch(/Math\.\w+\([^)]*[gG]eneration/);
    // and in the rest of the storage code that carries generations (service, migration, drivers, contract)
    const carriers = files.filter((f) => f.includes("/storage/") || f.endsWith("storage.service.ts"));
    expect(carriers.length).toBeGreaterThan(3);
    for (const f of carriers) {
      const text = codeOnly(readFileSync(f, "utf8"));
      const label = f.replace(SRC, "src");
      expect(text, `${label} converts a generation with Number()`).not.toMatch(/Number\([^)\n]*[gG]eneration/);
      expect(text, `${label} parses a generation`).not.toMatch(/parse(Int|Float)\([^)\n]*[gG]eneration/);
      expect(text, `${label} converts a generation through BigInt`).not.toMatch(/BigInt\([^)\n]*[gG]eneration/);
      expect(text, `${label} applies unary plus to a generation`).not.toMatch(/[=(,\s]\+\s*[\w.]*[gG]eneration\b/);
      expect(text, `${label} multiplies a generation`).not.toMatch(/[gG]eneration\b[^\n;]*\*\s*1\b/);
    }
    // the only numeric generation precondition in the driver's CODE is the create-only write (`ifGenerationMatch: 0`)
    const numericPreconditions = code.match(/ifGenerationMatch:\s*\d+/g) ?? [];
    expect(numericPreconditions).toEqual(["ifGenerationMatch: 0"]);
    // and the delete site itself carries no literal at all
    expect(callText).not.toMatch(/ifGenerationMatch:\s*\d/);
  });

  it("runtime: a non-canonical generation fails closed (GENERATION_INVALID) before the SDK; a canonical large one is passed through untouched", async () => {
    const store = new FakeBucketStore();
    const d = new GcsStorageDriver(fakeGcsClient(store), "fake-bucket");
    const big = "9007199254740993"; // Number(big) === 9007199254740992
    store.seed("tenants/1/reports/big", Buffer.from("x"), "application/octet-stream", {}, big);
    for (const bad of ["", "0", "01", "1.5", "1e3", "abc", " 1", "9007199254740993 ", 9007199254740993 as unknown as string, 1 as unknown as string]) {
      await expect(d.delete("tenants/1/reports/big", { ifGeneration: bad })).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", reason: "GENERATION_INVALID" });
    }
    expect(store.deleteCalls).toEqual([]);
    await d.delete("tenants/1/reports/big", { ifGeneration: big });
    expect(store.deleteCalls).toEqual([{ name: "tenants/1/reports/big", opts: { ignoreNotFound: true, ifGenerationMatch: big } }]);
    expect(typeof store.deleteCalls[0].opts?.ifGenerationMatch).toBe("string");
    expect(store.objects.has("tenants/1/reports/big")).toBe(false);
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
