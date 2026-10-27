// =============================================================================
// B30 — disposable-restore READ-BACK helper (READ-ONLY; operator artefact, NOT product code).
// Runs ONLY inside the isolated restore environment: a THROWAWAY database restored from the dump and a
// RESTORED COPY of the encrypted object volume. Never against production, never against the live
// database or the live volume. For every active filesystem row of storage_objects it (1) checks the
// file (regular, not a symlink, owner uid:gid, mode 0600), (2) parses the envelope header without the
// key (magic LCPO, version 1, header key id = the key id of the supplied key, storage-key binding
// o = the row's storage_key), (3) decrypts the object through the product's own FsStorageDriver in
// read-only mode and compares the plaintext size + SHA-256 with the inventory row, and (4) walks the
// root for entries no active fs row references (the product's health namespace is reported, not
// failed). Output = ONE line of counts (no key, no key id, no path, no object id, no tenant data).
// Exit 0 = PASS (every count equals the row count, no unexpected entry, expectations met),
// exit 2 = FAIL, exit 1 = usage / configuration error.
// Environment (names only): DATABASE_URL (the THROWAWAY database), OBJECT_STORAGE_FS_ROOT (the
// restored copy, mounted read-only), OBJECT_STORAGE_ENCRYPTION_KEY (the owner's recovery copy, via
// an env file created with umask 077 on tmpfs); optional B30_EXPECT_ROWS (integer),
// B30_EXPECT_KEY_ID (16 hex from the manifest), B30_EXPECT_UID / B30_EXPECT_GID (default 999 / 999).
// =============================================================================
import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { pool } from "@workspace/db";
import { ENVELOPE_MAGIC, ENVELOPE_VERSION, keyIdOf, parseEncryptionKey } from "../src/storage/envelope.js";
import { FsStorageDriver, validateFsRoot } from "../src/storage/fs-driver.js";

const MAX_PLAINTEXT = 100 * 1024 * 1024;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}
function intEnv(name: string, dflt: number): number {
  const v = env(name);
  if (v === undefined) return dflt;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a non-negative integer`);
  return Number(v);
}

async function walk(dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) { out.push(p); continue; }
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
}

async function readHeader(file: string): Promise<{ ok: boolean; k?: string; o?: string }> {
  const fh = await open(file, "r");
  try {
    const head = Buffer.alloc(7);
    const first = await fh.read(head, 0, 7, 0);
    if (first.bytesRead < 7 || !head.subarray(0, 4).equals(ENVELOPE_MAGIC) || head[4] !== ENVELOPE_VERSION) return { ok: false };
    const len = head.readUInt16BE(5);
    const json = Buffer.alloc(len);
    const second = await fh.read(json, 0, len, 7);
    if (second.bytesRead < len) return { ok: false };
    const h = JSON.parse(json.toString("utf8")) as { v?: unknown; k?: unknown; o?: unknown };
    if (typeof h !== "object" || h === null || h.v !== ENVELOPE_VERSION) return { ok: false };
    return { ok: true, k: typeof h.k === "string" ? h.k : undefined, o: typeof h.o === "string" ? h.o : undefined };
  } catch {
    return { ok: false };
  } finally {
    await fh.close();
  }
}

type Row = { id: string; storage_key: string; size_bytes: string | number | null; sha256: string | null };

async function main(): Promise<number> {
  const root = env("OBJECT_STORAGE_FS_ROOT");
  if (!root) throw new Error("OBJECT_STORAGE_FS_ROOT is required");
  const problem = validateFsRoot(root);
  if (problem) throw new Error(problem);
  const key = parseEncryptionKey(env("OBJECT_STORAGE_ENCRYPTION_KEY"));
  const kid = keyIdOf(key);
  const expectKid = env("B30_EXPECT_KEY_ID");
  if (expectKid !== undefined && !/^[0-9a-f]{16}$/.test(expectKid)) throw new Error("B30_EXPECT_KEY_ID must be 16 lowercase hex characters");
  const expectRows = env("B30_EXPECT_ROWS") === undefined ? undefined : intEnv("B30_EXPECT_ROWS", 0);
  const expectUid = intEnv("B30_EXPECT_UID", 999);
  const expectGid = intEnv("B30_EXPECT_GID", 999);

  const driver = new FsStorageDriver({ root, key, readOnly: true });
  const res = await pool.query("select id, storage_key, size_bytes, sha256 from storage_objects where state = 'active' and driver = 'fs' order by id");
  const rows = res.rows as Row[];

  const c = { present: 0, regular: 0, owner_ok: 0, mode_ok: 0, header_ok: 0, key_id_ok: 0, binding_ok: 0, read_ok: 0, size_match: 0, sha_match: 0, meta_missing: 0 };
  const readErrors = new Map<string, number>();
  const expected = new Set<string>();
  for (const row of rows) {
    const file = path.join(root, ...row.storage_key.split("/"));
    expected.add(file);
    let st;
    try { st = await lstat(file); } catch { continue; }
    c.present++;
    if (!st.isFile()) continue;
    c.regular++;
    if (st.uid === expectUid && st.gid === expectGid) c.owner_ok++;
    if ((st.mode & 0o777) === 0o600) c.mode_ok++;
    const h = await readHeader(file);
    if (h.ok) {
      c.header_ok++;
      if (h.k === kid) c.key_id_ok++;
      if (h.o === row.storage_key) c.binding_ok++;
    }
    if (row.sha256 == null || row.size_bytes == null) c.meta_missing++;
    try {
      const { stream } = await driver.getStream(row.storage_key, { maxBytes: MAX_PLAINTEXT });
      const hash = createHash("sha256");
      let n = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) { hash.update(chunk); n += chunk.length; }
      c.read_ok++;
      if (row.size_bytes != null && Number(row.size_bytes) === n) c.size_match++;
      if (row.sha256 != null && hash.digest("hex") === row.sha256) c.sha_match++;
    } catch (err) {
      const code = String((err as { code?: unknown })?.code ?? "ERROR").replace(/[^A-Z0-9_]/gi, "_");
      readErrors.set(code, (readErrors.get(code) ?? 0) + 1);
    }
  }

  const rootStat = await lstat(root);
  const rootOk = rootStat.isDirectory() && !rootStat.isSymbolicLink() && (rootStat.mode & 0o777) === 0o700 && rootStat.uid === expectUid && rootStat.gid === expectGid;
  const entries: string[] = [];
  await walk(root, entries);
  const health = entries.filter((p) => path.relative(root, p).split(path.sep)[0] === "health");
  const unexpected = entries.filter((p) => !expected.has(p) && !health.includes(p));

  const n = rows.length;
  const perRow = [c.present, c.regular, c.owner_ok, c.mode_ok, c.header_ok, c.key_id_ok, c.binding_ok, c.read_ok, c.size_match, c.sha_match];
  const rowsOk = expectRows === undefined ? "unset" : expectRows === n ? "ok" : "mismatch";
  const kidOk = expectKid === undefined ? "unset" : expectKid === kid ? "match" : "mismatch";
  const pass = n > 0 && perRow.every((x) => x === n) && c.meta_missing === 0 && unexpected.length === 0 && rootOk && rowsOk !== "mismatch" && kidOk !== "mismatch";
  const errs = readErrors.size === 0 ? "none" : [...readErrors.entries()].map(([k, v]) => `${k}:${v}`).sort().join(",");
  console.log(`B30_READBACK rows=${n} present=${c.present} regular=${c.regular} owner_ok=${c.owner_ok} mode_ok=${c.mode_ok} root_ok=${rootOk} header_ok=${c.header_ok} key_id_ok=${c.key_id_ok} binding_ok=${c.binding_ok} read_ok=${c.read_ok} size_match=${c.size_match} sha_match=${c.sha_match} meta_missing=${c.meta_missing} health_entries=${health.length} unexpected_entries=${unexpected.length} read_errors=${errs} expect_rows=${rowsOk} expect_key_id=${kidOk} result=${pass ? "PASS" : "FAIL"}`);
  return pass ? 0 : 2;
}

main()
  .then(async (code) => { await pool.end(); process.exit(code); })
  .catch(async (err) => {
    console.error(`B30_READBACK usage/config error: ${String((err as Error)?.message ?? err).replace(/[A-Za-z0-9+/=_-]{32,}/g, "<redacted>")}`);
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(1);
  });
