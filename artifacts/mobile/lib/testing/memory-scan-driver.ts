// Test support only (never imported by the app): an in-memory stand-in for the
// device file system behind lib/scan-files.ts, which can also be told to fail
// the way a phone does — no space left, a write cut short, an I/O error.
import { base64ByteLength, type ScanFileDriver } from "../scan-files";

export interface MemoryScanDriver extends ScanFileDriver {
  /** uri → base64 content, exactly what is "on disk". */
  files: Map<string, string>;
  /** Free space reported to the store (null = unknown). */
  free: number | null;
  /** Throw this from the next write (then cleared). */
  failNextWrite: Error | null;
  /** Write only this many base64 characters of the next write (a write cut short), then cleared. */
  truncateNextWrite: number | null;
  /** Throw this from every read until cleared. */
  failReads: Error | null;
  /** Throw this from every remove until cleared. */
  failRemoves: Error | null;
  writes: number;
  setRoot(root: string | null): void;
  /** File names (not paths) under one directory. */
  names(dir: string): string[];
}

export function createMemoryScanDriver(root: string | null = "file:///data/app/files/offline-scans/"): MemoryScanDriver {
  let currentRoot = root;
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const driver: MemoryScanDriver = {
    files,
    free: 8 * 1024 * 1024 * 1024,
    failNextWrite: null,
    truncateNextWrite: null,
    failReads: null,
    failRemoves: null,
    writes: 0,
    setRoot(next) {
      currentRoot = next;
    },
    names(dir) {
      return [...files.keys()].filter((u) => u.startsWith(dir) && !u.slice(dir.length).includes("/")).map((u) => u.slice(dir.length));
    },
    root: () => currentRoot,
    async ensureDir(uri) {
      dirs.add(uri);
    },
    async writeBase64(uri, base64) {
      driver.writes += 1;
      if (driver.failNextWrite) {
        const err = driver.failNextWrite;
        driver.failNextWrite = null;
        throw err;
      }
      if (driver.truncateNextWrite !== null) {
        const keep = driver.truncateNextWrite;
        driver.truncateNextWrite = null;
        files.set(uri, base64.slice(0, keep - (keep % 4)));
        return;
      }
      files.set(uri, base64);
    },
    async readBase64(uri) {
      if (driver.failReads) throw driver.failReads;
      const v = files.get(uri);
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    async move(from, to) {
      const v = files.get(from);
      if (v === undefined) throw new Error("ENOENT");
      files.delete(from);
      files.set(to, v);
    },
    async remove(uri) {
      if (driver.failRemoves) throw driver.failRemoves;
      files.delete(uri);
    },
    async size(uri) {
      const v = files.get(uri);
      return v === undefined ? null : base64ByteLength(v);
    },
    async list(uri) {
      // Like the device: the files AND the folders directly inside `uri`.
      const entries = new Set<string>(driver.names(uri));
      for (const known of [...files.keys(), ...dirs]) {
        if (!known.startsWith(uri) || known === uri) continue;
        const rest = known.slice(uri.length);
        const slash = rest.indexOf("/");
        if (slash > 0) entries.add(rest.slice(0, slash));
      }
      return [...entries];
    },
    async freeBytes() {
      return driver.free;
    },
  };
  return driver;
}

/** A syntactically valid JPEG-typed data URL of `bytes` decoded bytes, rounded up to a multiple of 3 (content is irrelevant to the store). */
export function fakeImage(bytes = 3000, seed = "A"): string {
  const chars = Math.ceil(bytes / 3) * 4;
  return `data:image/jpeg;base64,${seed.repeat(chars).slice(0, chars)}`;
}
