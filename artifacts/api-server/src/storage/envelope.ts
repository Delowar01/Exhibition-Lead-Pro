// =============================================================================
// Batch 25 — encrypted-at-rest file envelope (version 1).
//
// Every object written by the filesystem driver is a stream of authenticated
// AES-256-GCM frames so that (a) arbitrarily large files can be encrypted and
// decrypted in bounded memory, (b) every emitted plaintext byte has already
// passed its authentication tag (fail closed, nothing unauthenticated is ever
// served), and (c) a truncated, reordered, swapped or re-keyed file is detected.
//
//   magic "LCPO" | version u8 | header length u16 | header JSON
//   frame*: plaintext length u32 | ciphertext | tag (16)
//   final frame: same shape, type byte 1, plaintext = JSON { size, sha256, chunks }
//
// header JSON = { v: 1, k: <key id>, n: <64-bit nonce prefix, hex>, c: <chunk size>, o: <storage key> }
//
// Nonce  = 8-byte random prefix (per object) || 4-byte big-endian frame counter.
// AAD    = the complete header bytes || frame counter (u32) || frame type (u8).
// Binding the storage key into the authenticated header means a ciphertext file
// cannot be moved to another object's key; the key id lets a wrong-key read fail
// with a clear error before any GCM work (the tag would fail anyway).
//
// The plaintext size and SHA-256 are carried in the authenticated final frame
// AND in the storage_objects inventory row, so they are verifiable without
// weakening authentication: the reader recomputes both while streaming and
// refuses to finish if they differ.
// =============================================================================
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

export const ENVELOPE_MAGIC = Buffer.from("LCPO", "ascii");
export const ENVELOPE_VERSION = 1;
export const DEFAULT_CHUNK_SIZE = 256 * 1024;
const TAG_BYTES = 16;
const NONCE_PREFIX_BYTES = 8;
const MAX_HEADER_BYTES = 4096;
const FRAME_DATA = 0;
const FRAME_FINAL = 1;

export type EnvelopeErrorCode =
  | "ENVELOPE_BAD_MAGIC"
  | "ENVELOPE_BAD_VERSION"
  | "ENVELOPE_BAD_HEADER"
  | "ENVELOPE_WRONG_KEY"
  | "ENVELOPE_KEY_MISMATCH"
  | "ENVELOPE_AUTH_FAILED"
  | "ENVELOPE_TRUNCATED"
  | "ENVELOPE_TRAILING_DATA"
  | "ENVELOPE_TOO_LARGE"
  | "ENVELOPE_INTEGRITY";

export class EnvelopeError extends Error {
  constructor(readonly code: EnvelopeErrorCode, message?: string) {
    super(message ?? code);
    this.name = "EnvelopeError";
  }
}

/** Parse OBJECT_STORAGE_ENCRYPTION_KEY: 64 hex chars or base64 of exactly 32 bytes. */
export function parseEncryptionKey(raw: string | undefined | null): Buffer {
  const v = (raw ?? "").trim();
  if (!v) throw new Error("object-storage encryption key is not set");
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, "hex");
  let b: Buffer | null = null;
  try {
    b = Buffer.from(v, "base64");
  } catch {
    b = null;
  }
  if (b && b.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(v)) return b;
  throw new Error("object-storage encryption key must be 32 bytes (64 hex characters or base64)");
}

export function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

interface Header {
  v: number;
  k: string;
  n: string;
  c: number;
  o: string;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

function aadFor(headerBytes: Buffer, counter: number, type: number): Buffer {
  return Buffer.concat([headerBytes, u32(counter), Buffer.from([type])]);
}

function nonceFor(prefix: Buffer, counter: number): Buffer {
  return Buffer.concat([prefix, u32(counter)]);
}

export interface EncryptResult {
  size: number;
  sha256: string;
  chunks: number;
}

/**
 * Transform: plaintext in → envelope bytes out. `result` is set once the stream
 * has flushed (plaintext size, plaintext SHA-256, frame count).
 */
export class EncryptStream extends Transform {
  result: EncryptResult | null = null;
  private readonly headerBytes: Buffer;
  private readonly noncePrefix: Buffer;
  private readonly chunkSize: number;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private counter = 0;
  private size = 0;
  private readonly hash = createHash("sha256");
  private headerWritten = false;

  constructor(private readonly key: Buffer, storageKey: string, chunkSize = DEFAULT_CHUNK_SIZE) {
    super();
    if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
    if (!Number.isInteger(chunkSize) || chunkSize < 1024 || chunkSize > 8 * 1024 * 1024) throw new Error("invalid chunk size");
    this.chunkSize = chunkSize;
    this.noncePrefix = randomBytes(NONCE_PREFIX_BYTES);
    const header: Header = { v: ENVELOPE_VERSION, k: keyIdOf(key), n: this.noncePrefix.toString("hex"), c: chunkSize, o: storageKey };
    const json = Buffer.from(JSON.stringify(header), "utf8");
    if (json.length > MAX_HEADER_BYTES) throw new Error("envelope header too large");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(json.length, 0);
    this.headerBytes = Buffer.concat([ENVELOPE_MAGIC, Buffer.from([ENVELOPE_VERSION]), len, json]);
  }

  private frame(plain: Buffer, type: number): Buffer {
    const cipher = createCipheriv("aes-256-gcm", this.key, nonceFor(this.noncePrefix, this.counter), { authTagLength: TAG_BYTES });
    cipher.setAAD(aadFor(this.headerBytes, this.counter, type));
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.counter += 1;
    return Buffer.concat([u32(plain.length), ct, tag]);
  }

  private emitHeader(): void {
    if (this.headerWritten) return;
    this.headerWritten = true;
    this.push(this.headerBytes);
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      this.emitHeader();
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.pending.push(buf);
      this.pendingBytes += buf.length;
      while (this.pendingBytes >= this.chunkSize) {
        const all = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
        const plain = all.subarray(0, this.chunkSize);
        const rest = all.subarray(this.chunkSize);
        this.pending = rest.length ? [Buffer.from(rest)] : [];
        this.pendingBytes = rest.length;
        this.size += plain.length;
        this.hash.update(plain);
        this.push(this.frame(plain, FRAME_DATA));
      }
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    try {
      this.emitHeader();
      if (this.pendingBytes > 0) {
        const plain = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
        this.pending = [];
        this.pendingBytes = 0;
        this.size += plain.length;
        this.hash.update(plain);
        this.push(this.frame(plain, FRAME_DATA));
      }
      const sha256 = this.hash.digest("hex");
      const chunks = this.counter;
      const meta = Buffer.from(JSON.stringify({ size: this.size, sha256, chunks }), "utf8");
      this.push(this.frame(meta, FRAME_FINAL));
      this.result = { size: this.size, sha256, chunks };
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
}

export interface DecryptResult {
  size: number;
  sha256: string;
  chunks: number;
}

/**
 * Transform: envelope bytes in → plaintext out. Every frame is authenticated
 * before its plaintext is emitted; the stream errors (and emits nothing further)
 * on a bad tag, a wrong key, a key mismatch, truncation or trailing data.
 * `result` is set after the authenticated final frame has been verified.
 */
export class DecryptStream extends Transform {
  result: DecryptResult | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private header: Header | null = null;
  private headerBytes: Buffer | null = null;
  private noncePrefix: Buffer | null = null;
  private counter = 0;
  private size = 0;
  private readonly hash = createHash("sha256");
  private finished = false;

  constructor(private readonly key: Buffer, private readonly expectedStorageKey: string | null, private readonly maxPlaintextBytes: number | null = null) {
    super();
    if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  }

  private fail(code: EnvelopeErrorCode, message?: string): never {
    throw new EnvelopeError(code, message);
  }

  private parseHeader(): boolean {
    if (this.buf.length < 7) return false;
    if (!this.buf.subarray(0, 4).equals(ENVELOPE_MAGIC)) this.fail("ENVELOPE_BAD_MAGIC");
    if (this.buf[4] !== ENVELOPE_VERSION) this.fail("ENVELOPE_BAD_VERSION");
    const len = this.buf.readUInt16BE(5);
    if (len === 0 || len > MAX_HEADER_BYTES) this.fail("ENVELOPE_BAD_HEADER");
    if (this.buf.length < 7 + len) return false;
    const headerBytes = Buffer.from(this.buf.subarray(0, 7 + len));
    let header: Header;
    try {
      header = JSON.parse(headerBytes.subarray(7).toString("utf8")) as Header;
    } catch {
      this.fail("ENVELOPE_BAD_HEADER");
    }
    if (!header || header.v !== ENVELOPE_VERSION || typeof header.k !== "string" || typeof header.n !== "string" || typeof header.o !== "string" || !Number.isInteger(header.c) || header.c < 1024 || header.c > 8 * 1024 * 1024) {
      this.fail("ENVELOPE_BAD_HEADER");
    }
    if (!/^[0-9a-f]{16}$/.test(header.n)) this.fail("ENVELOPE_BAD_HEADER");
    if (header.k !== keyIdOf(this.key)) this.fail("ENVELOPE_WRONG_KEY", "object was encrypted with a different key");
    if (this.expectedStorageKey !== null && header.o !== this.expectedStorageKey) this.fail("ENVELOPE_KEY_MISMATCH", "envelope is bound to a different object");
    this.header = header;
    this.headerBytes = headerBytes;
    this.noncePrefix = Buffer.from(header.n, "hex");
    this.buf = Buffer.from(this.buf.subarray(7 + len));
    return true;
  }

  // Returns false when more input is needed.
  private parseFrame(): boolean {
    if (this.buf.length < 4) return false;
    const plainLen = this.buf.readUInt32BE(0);
    if (plainLen > this.header!.c + 1024) this.fail("ENVELOPE_INTEGRITY", "frame larger than chunk size");
    const total = 4 + plainLen + TAG_BYTES;
    if (this.buf.length < total) return false;
    const ct = this.buf.subarray(4, 4 + plainLen);
    const tag = this.buf.subarray(4 + plainLen, total);
    // Try the data frame first; a tag failure there means either corruption or
    // that this is the final frame (different AAD) — try that second.
    const plain = this.open(ct, tag, FRAME_DATA) ?? this.open(ct, tag, FRAME_FINAL);
    if (plain === null) this.fail("ENVELOPE_AUTH_FAILED", "authentication tag mismatch");
    this.buf = Buffer.from(this.buf.subarray(total));
    if (plain.type === FRAME_FINAL) {
      let meta: { size: number; sha256: string; chunks: number };
      try {
        meta = JSON.parse(plain.data.toString("utf8"));
      } catch {
        this.fail("ENVELOPE_INTEGRITY", "final frame unreadable");
      }
      const sha = this.hash.digest("hex");
      if (meta.size !== this.size || meta.sha256 !== sha || meta.chunks !== this.counter - 1) {
        this.fail("ENVELOPE_INTEGRITY", "plaintext size / digest mismatch");
      }
      this.finished = true;
      this.result = { size: this.size, sha256: sha, chunks: meta.chunks };
      return true;
    }
    this.size += plain.data.length;
    if (this.maxPlaintextBytes !== null && this.size > this.maxPlaintextBytes) this.fail("ENVELOPE_TOO_LARGE", "object exceeds the permitted size");
    this.hash.update(plain.data);
    this.push(plain.data);
    return true;
  }

  private open(ct: Buffer, tag: Buffer, type: number): { data: Buffer; type: number } | null {
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, nonceFor(this.noncePrefix!, this.counter), { authTagLength: TAG_BYTES });
      d.setAAD(aadFor(this.headerBytes!, this.counter, type));
      d.setAuthTag(tag);
      const data = Buffer.concat([d.update(ct), d.final()]);
      this.counter += 1;
      return { data, type };
    } catch {
      return null;
    }
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
      if (this.finished) {
        if (this.buf.length > 0) this.fail("ENVELOPE_TRAILING_DATA");
        return cb();
      }
      if (!this.header && !this.parseHeader()) return cb();
      while (!this.finished && this.parseFrame()) {
        /* drain complete frames */
      }
      if (this.finished && this.buf.length > 0) this.fail("ENVELOPE_TRAILING_DATA");
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    if (!this.finished) return cb(new EnvelopeError("ENVELOPE_TRUNCATED", "envelope ended before its authenticated final frame"));
    cb();
  }
}

/** Convenience: encrypt a whole buffer (tests, probes, small objects). */
export async function encryptBuffer(key: Buffer, storageKey: string, plain: Buffer, chunkSize = DEFAULT_CHUNK_SIZE): Promise<{ bytes: Buffer; result: EncryptResult }> {
  const enc = new EncryptStream(key, storageKey, chunkSize);
  const out: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    enc.on("data", (d: Buffer) => out.push(d));
    enc.on("end", resolve);
    enc.on("error", reject);
    enc.end(plain);
  });
  return { bytes: Buffer.concat(out), result: enc.result! };
}

/** Convenience: decrypt a whole buffer (tests, probes, small objects). */
export async function decryptBuffer(key: Buffer, storageKey: string | null, bytes: Buffer, maxPlaintextBytes: number | null = null): Promise<{ plain: Buffer; result: DecryptResult }> {
  const dec = new DecryptStream(key, storageKey, maxPlaintextBytes);
  const out: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    dec.on("data", (d: Buffer) => out.push(d));
    dec.on("end", resolve);
    dec.on("error", reject);
    dec.end(bytes);
  });
  return { plain: Buffer.concat(out), result: dec.result! };
}
