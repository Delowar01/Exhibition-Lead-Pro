// Batch 25 — filesystem driver: atomic encrypted writes, bounded reads,
// sanitized errors and path-escape resistance. Runs against a throwaway root
// under the OS temp directory (outside the repository); no server, no DB.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync, mkdirSync, rmSync, truncateSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { FsStorageDriver, validateFsRoot } from "../src/storage/fs-driver.js";
import { StorageError, readAll } from "../src/storage/contract.js";
import { ENVELOPE_MAGIC } from "../src/storage/envelope.js";
import { tenantKey } from "../src/storage/keys.js";

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
let base: string;
let root: string;
let outside: string;
let driver: FsStorageDriver;

function sha(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

async function readAllErr(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
}

function filePath(key: string): string {
  return path.join(root, ...key.split("/"));
}

beforeAll(async () => {
  base = mkdtempSync(path.join(os.tmpdir(), "lcp-fs-driver-"));
  root = path.join(base, "objects");
  outside = path.join(base, "outside");
  mkdirSync(outside, { recursive: true });
  driver = new FsStorageDriver({ root, key: KEY, chunkSize: 1024, probeTimeoutMs: 5000 });
  await driver.init();
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("fs driver — root validation", () => {
  it("accepts an absolute private directory and refuses the repository, system and web roots", () => {
    expect(validateFsRoot(root)).toBeNull();
    expect(validateFsRoot("")).not.toBeNull();
    expect(validateFsRoot("relative/dir")).not.toBeNull();
    expect(validateFsRoot("/")).not.toBeNull();
    expect(validateFsRoot(process.cwd())).not.toBeNull();
    expect(validateFsRoot(path.join(process.cwd(), "data"))).not.toBeNull();
    expect(validateFsRoot("/var/www/html/objects")).not.toBeNull();
    expect(validateFsRoot("/usr/share/nginx/html")).not.toBeNull();
    expect(validateFsRoot("/etc/objects")).not.toBeNull();
    expect(validateFsRoot("/proc")).not.toBeNull();
  });

  it("creates the root with mode 0700 and refuses a symlinked root", async () => {
    expect((statSync(root).mode & 0o777).toString(8)).toBe("700");
    const linkRoot = path.join(base, "linkroot");
    symlinkSync(outside, linkRoot);
    const d = new FsStorageDriver({ root: linkRoot, key: KEY });
    await expect(d.init()).rejects.toThrow(/symbolic link/);
  });
});

describe("fs driver — put / get / head / delete", () => {
  it("round-trips an object, never stores plaintext, and uses restrictive permissions", async () => {
    const key = tenantKey("document", 1, randomUUID());
    const plain = Buffer.from("hello, encrypted world — ".repeat(200));
    const put = await driver.put(key, plain, { contentType: "text/plain", maxBytes: 1024 * 1024 });
    expect(put.sizeBytes).toBe(plain.length);
    expect(put.sha256).toBe(sha(plain));

    const onDisk = readFileSync(filePath(key));
    expect(onDisk.subarray(0, 4).equals(ENVELOPE_MAGIC)).toBe(true);
    expect(onDisk.includes(Buffer.from("hello, encrypted world"))).toBe(false);
    expect((statSync(filePath(key)).mode & 0o777).toString(8)).toBe("600");
    expect((statSync(path.dirname(filePath(key))).mode & 0o777).toString(8)).toBe("700");
    expect(readdirSync(path.dirname(filePath(key))).some((n) => n.startsWith(".tmp-"))).toBe(false);

    expect(await driver.exists(key)).toBe(true);
    expect(await driver.head(key)).toEqual({ sizeBytes: null, contentType: null });
    const { stream } = await driver.getStream(key, { maxBytes: 1024 * 1024 });
    const back = await readAll(stream, 1024 * 1024);
    expect(back.equals(plain)).toBe(true);

    await driver.delete(key);
    expect(await driver.exists(key)).toBe(false);
    expect(await driver.head(key)).toBeNull();
    await driver.delete(key); // idempotent
    const err = (await readAllErr(driver.getStream(key))) as StorageError;
    expect(err).toBeInstanceOf(StorageError);
    expect(err.code).toBe("STORAGE_NOT_FOUND");
  });

  it("streams a large object through bounded frames and enforces the read ceiling", async () => {
    const key = tenantKey("export", 1, randomUUID());
    const total = 3 * 1024 * 1024 + 11;
    const hash = createHash("sha256");
    const source = Readable.from(
      (function* () {
        let left = total;
        while (left > 0) {
          const n = Math.min(left, 65_000);
          const b = randomBytes(n);
          hash.update(b);
          left -= n;
          yield b;
        }
      })(),
    );
    const put = await driver.put(key, source, { contentType: "application/octet-stream", maxBytes: 4 * 1024 * 1024 });
    expect(put.sizeBytes).toBe(total);
    expect(put.sha256).toBe(hash.digest("hex"));
    const { stream } = await driver.getStream(key, { maxBytes: 4 * 1024 * 1024 });
    const back = await readAll(stream, 4 * 1024 * 1024);
    expect(sha(back)).toBe(put.sha256);

    const capped = await driver.getStream(key, { maxBytes: 1024 * 1024 });
    const err = (await readAllErr(readAll(capped.stream, 4 * 1024 * 1024))) as StorageError;
    expect(err).toBeInstanceOf(StorageError);
    expect(err.code).toBe("STORAGE_TOO_LARGE");
  });

  it("rejects an over-limit write, verifies declared digests, and leaves no temp file behind", async () => {
    const key = tenantKey("document", 2, randomUUID());
    const dir = path.dirname(filePath(key));
    const big = randomBytes(5000);
    const tooLarge = (await readAllErr(driver.put(key, big, { contentType: "x/y", maxBytes: 4096 }))) as StorageError;
    expect(tooLarge.code).toBe("STORAGE_TOO_LARGE");
    expect(existsSync(filePath(key))).toBe(false);
    expect(readdirSync(dir).some((n) => n.startsWith(".tmp-"))).toBe(false);

    const bad = (await readAllErr(driver.put(key, big, { contentType: "x/y", maxBytes: 8192, expectedSha256: "0".repeat(64) }))) as StorageError;
    expect(bad.code).toBe("STORAGE_INTEGRITY");
    expect(existsSync(filePath(key))).toBe(false);
    const badSize = (await readAllErr(driver.put(key, big, { contentType: "x/y", maxBytes: 8192, expectedSize: 1 }))) as StorageError;
    expect(badSize.code).toBe("STORAGE_INTEGRITY");
    expect(readdirSync(dir).some((n) => n.startsWith(".tmp-"))).toBe(false);

    await driver.put(key, big, { contentType: "x/y", maxBytes: 8192, expectedSha256: sha(big), expectedSize: big.length });
    expect(existsSync(filePath(key))).toBe(true);
  });

  it("refuses to overwrite unless allowed, and a failed overwrite keeps the previous object intact", async () => {
    const key = tenantKey("document", 3, randomUUID());
    const first = Buffer.from("first");
    await driver.put(key, first, { contentType: "x/y", maxBytes: 100 });
    const conflict = (await readAllErr(driver.put(key, Buffer.from("second"), { contentType: "x/y", maxBytes: 100 }))) as StorageError;
    expect(conflict.code).toBe("STORAGE_CONFLICT");
    const failed = (await readAllErr(driver.put(key, randomBytes(200), { contentType: "x/y", maxBytes: 100, allowOverwrite: true }))) as StorageError;
    expect(failed.code).toBe("STORAGE_TOO_LARGE");
    expect((await readAll((await driver.getStream(key)).stream, 100)).equals(first)).toBe(true);
    await driver.put(key, Buffer.from("second"), { contentType: "x/y", maxBytes: 100, allowOverwrite: true });
    expect((await readAll((await driver.getStream(key)).stream, 100)).toString()).toBe("second");
  });
});

describe("fs driver — encryption failures surface as sanitized errors", () => {
  it("rejects a read with the wrong key", async () => {
    const key = tenantKey("document", 4, randomUUID());
    await driver.put(key, Buffer.from("secret"), { contentType: "x/y", maxBytes: 100 });
    const other = new FsStorageDriver({ root, key: OTHER_KEY });
    const { stream } = await other.getStream(key);
    const err = (await readAllErr(readAll(stream, 100))) as StorageError;
    expect(err).toBeInstanceOf(StorageError);
    expect(err.code).toBe("STORAGE_WRONG_KEY");
    expect(err.message).not.toContain(root);
  });

  it("rejects a corrupted and a truncated file", async () => {
    const key = tenantKey("document", 4, randomUUID());
    await driver.put(key, randomBytes(3000), { contentType: "x/y", maxBytes: 4096 });
    const p = filePath(key);
    const bytes = readFileSync(p);
    const corrupted = Buffer.from(bytes);
    corrupted[bytes.length - 40] ^= 0x01;
    writeFileSync(p, corrupted);
    const err1 = (await readAllErr(readAll((await driver.getStream(key)).stream, 4096))) as StorageError;
    expect(err1.code).toBe("STORAGE_CORRUPT");
    writeFileSync(p, bytes);
    truncateSync(p, bytes.length - 30);
    const err2 = (await readAllErr(readAll((await driver.getStream(key)).stream, 4096))) as StorageError;
    expect(err2.code).toBe("STORAGE_CORRUPT");
  });

  it("rejects a ciphertext file copied under another object's key", async () => {
    const a = tenantKey("document", 5, randomUUID());
    const b = tenantKey("document", 5, randomUUID());
    await driver.put(a, Buffer.from("object a"), { contentType: "x/y", maxBytes: 100 });
    mkdirSync(path.dirname(filePath(b)), { recursive: true });
    writeFileSync(filePath(b), readFileSync(filePath(a)));
    const err = (await readAllErr(readAll((await driver.getStream(b)).stream, 100))) as StorageError;
    expect(err.code).toBe("STORAGE_CORRUPT");
  });
});

describe("fs driver — path escape resistance", () => {
  const traversal = [
    "../x",
    "tenants/1/documents/../../../x",
    "tenants/1/documents/%2e%2e/%2e%2e/x",
    "/tenants/1/documents/x",
    "tenants/1/documents/a\u0000b",
    "tenants\\1\\documents\\x",
    "tenants/1/documents/.hidden",
    "health/../x",
    "tenants/1/documents/x/y/z/w",
    `${root}/tenants/1/documents/x`,
  ];

  it("refuses traversal, encoded traversal, separators, NUL bytes and absolute keys on every operation", async () => {
    for (const key of traversal) {
      for (const op of [
        () => driver.put(key, Buffer.from("x"), { contentType: "x/y", maxBytes: 10 }),
        () => driver.getStream(key),
        () => driver.head(key),
        () => driver.exists(key),
        () => driver.delete(key),
      ]) {
        const err = (await readAllErr(op())) as { code?: string };
        expect(err, key).toBeTruthy();
        expect(err.code, key).toBe("STORAGE_INVALID_KEY");
      }
    }
    expect(existsSync(path.join(base, "x"))).toBe(false);
  });

  it("refuses symbolic links below the root (file and directory components) and never follows them", async () => {
    const victim = path.join(outside, "victim.txt");
    writeFileSync(victim, "do not read or delete me");
    // symlinked file inside a valid tenant directory
    const dir = path.join(root, "tenants", "9", "documents");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    symlinkSync(victim, path.join(dir, "link"));
    const linkKey = "tenants/9/documents/link";
    for (const op of [
      () => driver.getStream(linkKey),
      () => driver.put(linkKey, Buffer.from("x"), { contentType: "x/y", maxBytes: 10, allowOverwrite: true }),
      () => driver.delete(linkKey),
    ]) {
      const err = (await readAllErr(op())) as StorageError;
      expect(err).toBeInstanceOf(StorageError);
      expect(err.code).toBe("STORAGE_INVALID_KEY");
    }
    await expect(driver.head(linkKey)).rejects.toMatchObject({ code: "STORAGE_INVALID_KEY" });
    await expect(driver.exists(linkKey)).rejects.toMatchObject({ code: "STORAGE_INVALID_KEY" });
    expect(readFileSync(victim, "utf8")).toBe("do not read or delete me");
    expect(existsSync(path.join(dir, "link"))).toBe(true); // the link itself was not touched

    // symlinked directory component
    symlinkSync(outside, path.join(root, "tenants", "10"));
    const dirKey = "tenants/10/documents/escape";
    const err = (await readAllErr(driver.put(dirKey, Buffer.from("x"), { contentType: "x/y", maxBytes: 10 }))) as StorageError;
    expect(err.code).toBe("STORAGE_INVALID_KEY");
    expect(existsSync(path.join(outside, "documents"))).toBe(false);
    expect((await readAllErr(driver.getStream(dirKey)) as StorageError).code).toBe("STORAGE_INVALID_KEY");
  });
});

describe("fs driver — readiness probe", () => {
  it("writes, reads, verifies and deletes one object under health/ and leaves nothing behind", async () => {
    await driver.probe();
    const healthDir = path.join(root, "health");
    const leftovers = existsSync(healthDir) ? readdirSync(healthDir) : [];
    expect(leftovers).toEqual([]);
  });

  it("reports a failure (never hangs) when the root is unusable", async () => {
    const rootFile = path.join(base, "not-a-dir");
    writeFileSync(rootFile, "x");
    const broken = new FsStorageDriver({ root: rootFile, key: KEY, probeTimeoutMs: 2000 });
    await expect(broken.probe()).rejects.toThrow();
  });
});
