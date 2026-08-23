// Batch 9 compatibility — password-protected export encryption methods.
// Pure unit tests over export-generate + the service's transient method
// resolution: no API server, no DB, no storage needed, so these run in every
// environment.
//
// Verification approach: ZipCrypto ("zip20") is fully round-tripped with the
// system Info-ZIP `unzip` (correct password extracts, wrong password fails).
// Info-ZIP cannot decrypt WinZip AES, which is itself the distinguishing
// behavior — AES-256 output is verified structurally (local-file-header
// compression method 99 + encryption flag + no plaintext leakage) and by
// Info-ZIP refusing it even with the correct password. Full AES extraction is
// covered by the hosted acceptance test with an AES-capable tool.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateFile, encryptZip } from "../src/lib/export-generate.js";
import { resolveEncryptionMethod } from "../src/services/export.service.js";

const PASSWORD = "unit-zip-pass-42";
const PLAINTEXT_MARK = "Zebra Quartz Ltd"; // distinctive cell value to detect leakage

let tmpDir: string;
let innerCsv: Buffer;

function localHeaderMethod(zip: Buffer): number {
  expect(zip.subarray(0, 4)).toEqual(Buffer.from("PK\x03\x04", "binary"));
  return zip.readUInt16LE(8);
}

function encryptionBitSet(zip: Buffer): boolean {
  return (zip.readUInt16LE(6) & 1) === 1;
}

function tryUnzip(zipPath: string, password: string, outDir: string): { ok: boolean } {
  try {
    execFileSync("unzip", ["-P", password, "-o", zipPath, "-d", outDir], { stdio: "pipe" });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b9-zip-"));
  innerCsv = await generateFile({
    format: "csv",
    title: "Contacts Export",
    columns: ["Name", "Company"],
    rows: [
      ["Ada Lovelace", PLAINTEXT_MARK],
      ["Alan Turing", "Bletchley"],
    ],
  });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveEncryptionMethod (transient request field)", () => {
  it("defaults to aes256 when omitted or null", () => {
    expect(resolveEncryptionMethod(undefined)).toBe("aes256");
    expect(resolveEncryptionMethod(null)).toBe("aes256");
  });
  it("accepts only the two supported methods", () => {
    expect(resolveEncryptionMethod("aes256")).toBe("aes256");
    expect(resolveEncryptionMethod("zip20")).toBe("zip20");
    expect(() => resolveEncryptionMethod("des")).toThrowError(/aes256 or zip20/);
    expect(() => resolveEncryptionMethod(7)).toThrowError(/aes256 or zip20/);
  });
});

describe("encryptZip output formats", () => {
  it("defaults to AES-256 when no method is passed (existing callers unchanged)", async () => {
    const zip = await encryptZip(innerCsv, "inner.csv", PASSWORD);
    expect(localHeaderMethod(zip)).toBe(99); // WinZip AES marker
    expect(encryptionBitSet(zip)).toBe(true);
  });

  it("explicit aes256 produces an AES ZIP that hides the plaintext", async () => {
    const zip = await encryptZip(innerCsv, "inner.csv", PASSWORD, "aes256");
    expect(localHeaderMethod(zip)).toBe(99);
    expect(encryptionBitSet(zip)).toBe(true);
    expect(zip.includes(Buffer.from(PLAINTEXT_MARK))).toBe(false);

    // Info-ZIP has no AES support: even the CORRECT password cannot extract,
    // which also proves this is not a ZipCrypto container.
    const zipPath = path.join(tmpDir, "aes.zip");
    fs.writeFileSync(zipPath, zip);
    expect(tryUnzip(zipPath, PASSWORD, path.join(tmpDir, "aes-out")).ok).toBe(false);
  });

  it("explicit zip20 produces a standard ZipCrypto ZIP (no AES method marker)", async () => {
    const zip = await encryptZip(innerCsv, "inner.csv", PASSWORD, "zip20");
    const method = localHeaderMethod(zip);
    expect([0, 8]).toContain(method); // stored/deflate — NOT 99
    expect(encryptionBitSet(zip)).toBe(true);
    expect(zip.includes(Buffer.from(PLAINTEXT_MARK))).toBe(false);
  });

  it("zip20 requires the correct password: right one extracts the intact CSV", async () => {
    const zip = await encryptZip(innerCsv, "inner.csv", PASSWORD, "zip20");
    const zipPath = path.join(tmpDir, "zip20.zip");
    fs.writeFileSync(zipPath, zip);

    const outDir = path.join(tmpDir, "zip20-good");
    expect(tryUnzip(zipPath, PASSWORD, outDir).ok).toBe(true);
    const extracted = fs.readFileSync(path.join(outDir, "inner.csv"));
    expect(extracted.equals(innerCsv)).toBe(true);
  });

  it("zip20 with a wrong password cannot extract", async () => {
    const zip = await encryptZip(innerCsv, "inner.csv", PASSWORD, "zip20");
    const zipPath = path.join(tmpDir, "zip20-wrong.zip");
    fs.writeFileSync(zipPath, zip);

    const outDir = path.join(tmpDir, "zip20-bad");
    expect(tryUnzip(zipPath, "not-the-password", outDir).ok).toBe(false);
    expect(fs.existsSync(path.join(outDir, "inner.csv"))).toBe(false);
  });
});
