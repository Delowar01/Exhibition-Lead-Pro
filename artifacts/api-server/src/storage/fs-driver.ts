// =============================================================================
// Batch 25 — filesystem driver (local development, tests, the Hostinger VPS).
//
//   • root: an absolute directory OUTSIDE the repository and outside any web
//     document root (validated at startup); created 0700 when missing.
//   • keys: canonical `tenants/<cid>/<kind>/<id>` / `health/<id>` only (see
//     keys.ts) — an absolute path, "..", encoded traversal, separators or NUL
//     bytes can never form a key, and the resolved path is re-checked to sit
//     under the root.
//   • links: every existing component below the root is lstat'ed and refused
//     when it is a symbolic link; files are opened with O_NOFOLLOW; a
//     non-regular file is treated as absent/refused.
//   • atomic writes: ciphertext streams into a private 0600 temporary file in
//     the destination directory (O_EXCL), is fsync'ed, then renamed into place;
//     the temporary file is removed on any failure. Plaintext is never written
//     to disk: encryption happens in the write pipeline.
//   • bounded streaming: reads and writes enforce an explicit plaintext ceiling.
//   • errors are sanitized StorageErrors (codes + fixed messages; no paths).
// =============================================================================
import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { StorageError, readAll, type DeleteOptions, type GetOptions, type ObjectHead, type ObjectStream, type PutOptions, type PutResult, type StorageDriver } from "./contract.js";
import { DecryptStream, EncryptStream, EnvelopeError, DEFAULT_CHUNK_SIZE } from "./envelope.js";
import { HashingLimiter, toReadable, verifyExpected } from "./hashing.js";
import { assertValidStorageKey, healthKey } from "./keys.js";

export interface FsDriverOptions {
  root: string;
  key: Buffer;
  chunkSize?: number;
  /** Probe time budget in ms (readiness). */
  probeTimeoutMs?: number;
  /** Test barrier awaited right before publication (concurrency tests only). */
  beforePublish?: (key: string) => Promise<void>;
  /**
   * B25 Correction 2 — read-only mode (migration --dry-run / --verify): never
   * creates the root or any directory, temp file, probe or object; a missing
   * root is reported as absent (`rootState()`), every write is refused.
   */
  readOnly?: boolean;
}

const PROBE_BYTES = 1024;

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === code;
}

export function mapEnvelopeError(err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  if (err instanceof EnvelopeError) {
    if (err.code === "ENVELOPE_WRONG_KEY") return new StorageError("STORAGE_WRONG_KEY", undefined, err);
    if (err.code === "ENVELOPE_TOO_LARGE") return new StorageError("STORAGE_TOO_LARGE", undefined, err);
    if (err.code === "ENVELOPE_INTEGRITY") return new StorageError("STORAGE_INTEGRITY", undefined, err);
    return new StorageError("STORAGE_CORRUPT", undefined, err);
  }
  if (isErrno(err, "ENOENT")) return new StorageError("STORAGE_NOT_FOUND", undefined, err);
  return new StorageError("STORAGE_UNAVAILABLE", undefined, err);
}

/**
 * The root must be absolute, must not be "/" and must not sit inside the process
 * working directory (the repository / application bundle). Exported for tests.
 */
export function validateFsRoot(root: string, cwd: string = process.cwd()): string | null {
  if (!root || !path.isAbsolute(root)) return "OBJECT_STORAGE_FS_ROOT must be an absolute path";
  const normalized = path.resolve(root);
  if (normalized === path.parse(normalized).root) return "OBJECT_STORAGE_FS_ROOT must not be the filesystem root";
  const cwdResolved = path.resolve(cwd);
  if (normalized === cwdResolved || normalized.startsWith(cwdResolved + path.sep)) return "OBJECT_STORAGE_FS_ROOT must be outside the application directory";
  for (const forbidden of ["/usr/share/nginx", "/var/www", "/proc", "/sys", "/dev", "/etc"]) {
    if (normalized === forbidden || normalized.startsWith(forbidden + path.sep)) return "OBJECT_STORAGE_FS_ROOT must not be a system or web document directory";
  }
  return null;
}

export class FsStorageDriver implements StorageDriver {
  readonly kind = "fs" as const;
  private readonly root: string;
  private readonly key: Buffer;
  private readonly chunkSize: number;
  private readonly probeTimeoutMs: number;
  private readonly beforePublish?: (key: string) => Promise<void>;
  private readonly readOnly: boolean;
  private rootAbsent = false;
  private initialized = false;

  constructor(opts: FsDriverOptions) {
    const problem = validateFsRoot(opts.root);
    if (problem) throw new Error(problem);
    if (opts.key.length !== 32) throw new Error("object-storage encryption key must be 32 bytes");
    this.root = path.resolve(opts.root);
    this.key = opts.key;
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 2500;
    this.beforePublish = opts.beforePublish;
    this.readOnly = opts.readOnly ?? false;
  }

  /**
   * Create the root (0700) when missing and refuse a root that is a link or
   * not a directory. In read-only mode a missing root is only RECORDED as
   * absent — nothing is created.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const st = await lstat(this.root);
      if (st.isSymbolicLink()) throw new Error("OBJECT_STORAGE_FS_ROOT must not be a symbolic link");
      if (!st.isDirectory()) throw new Error("OBJECT_STORAGE_FS_ROOT must be a directory");
    } catch (err) {
      if (!isErrno(err, "ENOENT")) throw err;
      if (this.readOnly) {
        this.rootAbsent = true;
        this.initialized = true;
        return;
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 });
    }
    this.initialized = true;
  }

  /** Whether the root directory exists (read-only mode reports instead of creating). */
  rootState(): "present" | "absent" {
    return this.rootAbsent ? "absent" : "present";
  }

  private refuseWrite(): never {
    throw new StorageError("STORAGE_UNAVAILABLE", "object store opened read-only", undefined, "READ_ONLY");
  }

  private pathFor(key: string): string {
    assertValidStorageKey(key);
    const p = path.join(this.root, ...key.split("/"));
    if (!p.startsWith(this.root + path.sep)) throw new StorageError("STORAGE_INVALID_KEY");
    return p;
  }

  /** Refuse any symbolic link (or non-directory intermediate) on the key's path below the root. */
  private async assertSafeTree(key: string, opts: { allowMissing: boolean }): Promise<void> {
    const parts = key.split("/");
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let st;
      try {
        st = await lstat(current);
      } catch (err) {
        if (isErrno(err, "ENOENT")) {
          if (opts.allowMissing) return;
          throw new StorageError("STORAGE_NOT_FOUND");
        }
        throw new StorageError("STORAGE_UNAVAILABLE", undefined, err);
      }
      if (st.isSymbolicLink()) throw new StorageError("STORAGE_INVALID_KEY", "storage path refused");
      const last = i === parts.length - 1;
      if (!last && !st.isDirectory()) throw new StorageError("STORAGE_INVALID_KEY", "storage path refused");
      if (last && !st.isFile()) throw new StorageError("STORAGE_INVALID_KEY", "storage path refused");
    }
  }

  private async isRegularFile(p: string): Promise<boolean> {
    try {
      const st = await lstat(p);
      return st.isFile();
    } catch {
      return false;
    }
  }

  async put(key: string, source: Readable | Buffer, opts: PutOptions & { allowOverwrite?: boolean }): Promise<PutResult> {
    await this.init();
    if (this.readOnly) this.refuseWrite();
    const final = this.pathFor(key);
    const dir = path.dirname(final);
    await this.assertSafeTree(key, { allowMissing: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await this.assertSafeTree(key, { allowMissing: true });
    if (!opts.allowOverwrite && (await this.isRegularFile(final))) throw new StorageError("STORAGE_CONFLICT");

    const tmp = path.join(dir, `.tmp-${randomBytes(12).toString("hex")}`);
    const fh = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const limiter = new HashingLimiter(opts.maxBytes);
    const encrypt = new EncryptStream(this.key, key, this.chunkSize);
    const input = toReadable(source);
    try {
      // Explicit sink over the file handle: every ciphertext chunk is written
      // through fh.write and the handle is fsync'ed in final() BEFORE the
      // pipeline resolves, so the rename below never publishes unflushed data.
      const sink = new Writable({
        write(chunk: Buffer, _enc, cb) {
          fh.write(chunk).then(() => cb(), cb);
        },
        final(cb) {
          fh.sync().then(() => cb(), cb);
        },
      });
      await pipeline(input, limiter, encrypt, sink);
      await fh.close();
      const result = { sizeBytes: limiter.size, sha256: limiter.sha256 };
      verifyExpected(result, opts);
      if (encrypt.result && (encrypt.result.size !== result.sizeBytes || encrypt.result.sha256 !== result.sha256)) {
        throw new StorageError("STORAGE_INTEGRITY");
      }
      if (this.beforePublish) await this.beforePublish(key);
      // Publication (B25 Correction 1): a no-overwrite write publishes with an
      // atomic hard LINK, which fails with EEXIST when the final path already
      // exists — an exists() check followed by rename() would let two writers
      // race and the later rename silently replace the winner's object. Only
      // an explicit overwrite uses rename (atomic replace).
      if (opts.allowOverwrite) {
        await rename(tmp, final);
      } else {
        try {
          await link(tmp, final);
        } catch (err) {
          if (isErrno(err, "EEXIST")) throw new StorageError("STORAGE_CONFLICT");
          throw err;
        }
        await unlink(tmp).catch(() => undefined);
      }
      await this.syncDir(dir);
      return result;
    } catch (err) {
      // Only OUR temporary file is ever removed here — never the final object,
      // which may belong to the writer that won the publication race.
      await fh.close().catch(() => undefined);
      await unlink(tmp).catch(() => undefined);
      input.destroy();
      throw mapEnvelopeError(err);
    }
  }

  private async syncDir(dir: string): Promise<void> {
    try {
      const dh = await open(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      // best effort — the rename itself is atomic; directory durability is advisory
    }
  }

  async getStream(key: string, opts: GetOptions = {}): Promise<ObjectStream> {
    await this.init();
    const final = this.pathFor(key);
    if (this.rootAbsent) throw new StorageError("STORAGE_NOT_FOUND");
    await this.assertSafeTree(key, { allowMissing: false });
    let fh;
    try {
      fh = await open(final, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (err) {
      throw mapEnvelopeError(err);
    }
    const rs = fh.createReadStream({ autoClose: true });
    const dec = new DecryptStream(this.key, key, opts.maxBytes ?? null);
    const out = new PassThrough();
    const fail = (err: unknown) => {
      if (!out.destroyed) out.destroy(mapEnvelopeError(err));
      rs.destroy();
    };
    rs.on("error", fail);
    dec.on("error", fail);
    out.on("close", () => {
      rs.destroy();
      dec.destroy();
    });
    rs.pipe(dec).pipe(out);
    return { stream: out, sizeBytes: null, contentType: null };
  }

  async head(key: string): Promise<ObjectHead | null> {
    await this.init();
    const final = this.pathFor(key);
    if (this.rootAbsent) return null;
    try {
      await this.assertSafeTree(key, { allowMissing: false });
    } catch (err) {
      if (err instanceof StorageError && err.code === "STORAGE_NOT_FOUND") return null;
      throw err;
    }
    if (!(await this.isRegularFile(final))) return null;
    return { sizeBytes: null, contentType: null };
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  /** Filesystem keys are attempt-unique, so `ifGeneration` has nothing to compare against and is ignored. */
  async delete(key: string, _opts: DeleteOptions = {}): Promise<void> {
    await this.init();
    if (this.readOnly) this.refuseWrite();
    const final = this.pathFor(key);
    let st;
    try {
      st = await lstat(final);
    } catch (err) {
      if (isErrno(err, "ENOENT")) return;
      throw new StorageError("STORAGE_UNAVAILABLE", undefined, err);
    }
    if (st.isSymbolicLink() || !st.isFile()) throw new StorageError("STORAGE_INVALID_KEY", "storage path refused");
    try {
      await unlink(final);
    } catch (err) {
      if (isErrno(err, "ENOENT")) return;
      throw new StorageError("STORAGE_UNAVAILABLE", undefined, err);
    }
  }

  /**
   * Readiness: write / read / verify / delete one random object under the
   * health namespace within the time budget. Never leaves a file behind: the
   * delete runs whether or not the verification succeeded.
   */
  async probe(): Promise<void> {
    await this.init();
    if (this.readOnly) this.refuseWrite();
    const key = healthKey(`probe-${randomUUID()}`);
    const payload = randomBytes(PROBE_BYTES);
    const expected = createHash("sha256").update(payload).digest("hex");
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StorageError("STORAGE_UNAVAILABLE", "storage probe timed out")), this.probeTimeoutMs);
    });
    const work = (async () => {
      try {
        await this.put(key, payload, { contentType: "application/octet-stream", maxBytes: PROBE_BYTES, expectedSha256: expected, expectedSize: PROBE_BYTES });
        const { stream } = await this.getStream(key, { maxBytes: PROBE_BYTES });
        const back = await readAll(stream, PROBE_BYTES);
        if (!back.equals(payload)) throw new StorageError("STORAGE_INTEGRITY", "probe read-back mismatch");
      } finally {
        await this.delete(key).catch(() => undefined);
      }
      if (await this.exists(key)) throw new StorageError("STORAGE_UNAVAILABLE", "probe object could not be removed");
    })();
    try {
      await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
