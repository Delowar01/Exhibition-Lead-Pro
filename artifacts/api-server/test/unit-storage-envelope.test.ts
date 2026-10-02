// Batch 25 — encrypted-at-rest envelope (chunked AES-256-GCM, version 1).
// Pure crypto, no server, no DB. Every failure mode must fail CLOSED: a wrong
// key, a swapped object binding, a flipped byte, reordered frames, truncation
// or trailing bytes rejects the whole read and never yields unauthenticated
// plaintext as a "successful" result.
import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DecryptStream,
  EncryptStream,
  ENVELOPE_MAGIC,
  EnvelopeError,
  decryptBuffer,
  encryptBuffer,
  keyIdOf,
  parseEncryptionKey,
} from "../src/storage/envelope.js";

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const OBJ = "tenants/1/documents/obj-1";
const CHUNK = 1024;

function sha(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

async function expectEnvelopeError(p: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(EnvelopeError);
  expect((caught as EnvelopeError).code).toBe(code);
}

/** Locate frame boundaries of an envelope: [headerEnd, frameStarts...]. */
function frames(bytes: Buffer): { headerEnd: number; offsets: number[] } {
  const len = bytes.readUInt16BE(5);
  const headerEnd = 7 + len;
  const offsets: number[] = [];
  let off = headerEnd;
  while (off < bytes.length) {
    offsets.push(off);
    const plainLen = bytes.readUInt32BE(off);
    off += 4 + plainLen + 16;
  }
  return { headerEnd, offsets };
}

describe("envelope — round trip", () => {
  it("encrypts and decrypts buffers of every boundary size with correct size/sha metadata", async () => {
    for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 17]) {
      const plain = randomBytes(size);
      const { bytes, result } = await encryptBuffer(KEY, OBJ, plain, CHUNK);
      expect(bytes.subarray(0, 4).equals(ENVELOPE_MAGIC)).toBe(true);
      expect(result.size).toBe(size);
      expect(result.sha256).toBe(sha(plain));
      expect(result.chunks).toBe(Math.ceil(size / CHUNK));
      // ciphertext never contains the plaintext (for sizes where that is testable)
      if (size >= 32) expect(bytes.includes(plain.subarray(0, 32))).toBe(false);
      const { plain: back, result: dec } = await decryptBuffer(KEY, OBJ, bytes);
      expect(back.equals(plain)).toBe(true);
      expect(dec.size).toBe(size);
      expect(dec.sha256).toBe(sha(plain));
    }
  });

  it("streams a multi-megabyte object through encrypt → decrypt in bounded frames", async () => {
    const total = 3 * 1024 * 1024 + 123;
    const hash = createHash("sha256");
    const source = Readable.from(
      (function* () {
        let left = total;
        while (left > 0) {
          const n = Math.min(left, 77_777);
          const b = randomBytes(n);
          hash.update(b);
          left -= n;
          yield b;
        }
      })(),
    );
    const enc = new EncryptStream(KEY, OBJ, 64 * 1024);
    const dec = new DecryptStream(KEY, OBJ, null);
    const outHash = createHash("sha256");
    let outSize = 0;
    await pipeline(
      source,
      enc,
      dec,
      new Writable({
        write(chunk: Buffer, _e, cb) {
          outHash.update(chunk);
          outSize += chunk.length;
          cb();
        },
      }),
    );
    expect(outSize).toBe(total);
    expect(outHash.digest("hex")).toBe(hash.digest("hex"));
    expect(enc.result?.size).toBe(total);
    expect(dec.result?.size).toBe(total);
    expect(dec.result?.sha256).toBe(enc.result?.sha256);
  });

  it("uses a fresh random nonce prefix per object (identical plaintext → different ciphertext)", async () => {
    const plain = Buffer.from("same bytes");
    const a = await encryptBuffer(KEY, OBJ, plain, CHUNK);
    const b = await encryptBuffer(KEY, OBJ, plain, CHUNK);
    expect(a.bytes.equals(b.bytes)).toBe(false);
  });
});

describe("envelope — fail closed", () => {
  it("rejects a wrong key before any plaintext is produced", async () => {
    const { bytes } = await encryptBuffer(KEY, OBJ, randomBytes(2 * CHUNK), CHUNK);
    await expectEnvelopeError(decryptBuffer(OTHER_KEY, OBJ, bytes), "ENVELOPE_WRONG_KEY");
  });

  it("rejects an envelope moved to another object's key (header binding)", async () => {
    const { bytes } = await encryptBuffer(KEY, OBJ, randomBytes(100), CHUNK);
    await expectEnvelopeError(decryptBuffer(KEY, "tenants/2/documents/other", bytes), "ENVELOPE_KEY_MISMATCH");
    // an unbound read (null) is still allowed for tooling
    const { plain } = await decryptBuffer(KEY, null, bytes);
    expect(plain.length).toBe(100);
  });

  it("rejects a flipped ciphertext byte and a flipped tag byte (authentication)", async () => {
    const plain = randomBytes(2 * CHUNK + 5);
    const { bytes } = await encryptBuffer(KEY, OBJ, plain, CHUNK);
    const { offsets } = frames(bytes);
    const flipCt = Buffer.from(bytes);
    flipCt[offsets[1] + 4 + 10] ^= 0x01;
    await expectEnvelopeError(decryptBuffer(KEY, OBJ, flipCt), "ENVELOPE_AUTH_FAILED");
    const flipTag = Buffer.from(bytes);
    const plainLen = bytes.readUInt32BE(offsets[0]);
    flipTag[offsets[0] + 4 + plainLen + 3] ^= 0x01;
    await expectEnvelopeError(decryptBuffer(KEY, OBJ, flipTag), "ENVELOPE_AUTH_FAILED");
  });

  it("rejects a tampered header (the header is authenticated data of every frame)", async () => {
    const { bytes } = await encryptBuffer(KEY, OBJ, randomBytes(50), CHUNK);
    const tampered = Buffer.from(bytes);
    // flip a byte inside the nonce prefix hex → either bad header or auth failure, never success
    const headerJson = tampered.subarray(7, 7 + tampered.readUInt16BE(5)).toString("utf8");
    const idx = 7 + headerJson.indexOf('"n":"') + 5;
    tampered[idx] = tampered[idx] === 0x30 ? 0x31 : 0x30;
    let caught: unknown;
    try {
      await decryptBuffer(KEY, OBJ, tampered);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EnvelopeError);
  });

  it("rejects reordered frames (per-frame counter in nonce + AAD)", async () => {
    const { bytes } = await encryptBuffer(KEY, OBJ, randomBytes(3 * CHUNK), CHUNK);
    const { headerEnd, offsets } = frames(bytes);
    const f0 = bytes.subarray(offsets[0], offsets[1]);
    const f1 = bytes.subarray(offsets[1], offsets[2]);
    const rest = bytes.subarray(offsets[2]);
    const swapped = Buffer.concat([bytes.subarray(0, headerEnd), f1, f0, rest]);
    await expectEnvelopeError(decryptBuffer(KEY, OBJ, swapped), "ENVELOPE_AUTH_FAILED");
  });

  it("rejects a truncated envelope (no authenticated final frame) and a dropped last data frame", async () => {
    const { bytes } = await encryptBuffer(KEY, OBJ, randomBytes(2 * CHUNK + 1), CHUNK);
    const { offsets } = frames(bytes);
    // cut inside the final frame
    await expectEnvelopeError(decryptBuffer(KEY, OBJ, bytes.subarray(0, bytes.length - 5)), "ENVELOPE_TRUNCATED");
    // drop the whole final frame
    await expectEnvelopeError(decryptBuffer(KEY, OBJ, bytes.subarray(0, offsets[offsets.length - 1])), "ENVELOPE_TRUNCATED");
    // drop a middle data frame but keep the final frame → size/sha/chunk-count mismatch, never success
    const without = Buffer.concat([bytes.subarray(0, offsets[1]), bytes.subarray(offsets[2])]);
    let caught: unknown;
    try {
      await decryptBuffer(KEY, OBJ, without);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EnvelopeError);
  });

  it("rejects trailing bytes after the final frame", async () => {
    const { bytes } = await encryptBuffer(KEY, OBJ, randomBytes(10), CHUNK);
    await expectEnvelopeError(decryptBuffer(KEY, OBJ, Buffer.concat([bytes, Buffer.from([1, 2, 3])])), "ENVELOPE_TRAILING_DATA");
  });

  it("rejects bad magic / version / header", async () => {
    const { bytes } = await encryptBuffer(KEY, OBJ, randomBytes(10), CHUNK);
    const badMagic = Buffer.from(bytes);
    badMagic[0] = 0x58;
    await expectEnvelopeError(decryptBuffer(KEY, OBJ, badMagic), "ENVELOPE_BAD_MAGIC");
    const badVersion = Buffer.from(bytes);
    badVersion[4] = 9;
    await expectEnvelopeError(decryptBuffer(KEY, OBJ, badVersion), "ENVELOPE_BAD_VERSION");
    const badHeader = Buffer.from(bytes);
    badHeader[7] = 0x7b; // corrupt JSON start → '{{'
    badHeader[8] = 0x7b;
    await expectEnvelopeError(decryptBuffer(KEY, OBJ, badHeader), "ENVELOPE_BAD_HEADER");
  });

  it("enforces the plaintext ceiling while streaming", async () => {
    const { bytes } = await encryptBuffer(KEY, OBJ, randomBytes(4 * CHUNK), CHUNK);
    await expectEnvelopeError(decryptBuffer(KEY, OBJ, bytes, 2 * CHUNK), "ENVELOPE_TOO_LARGE");
    const { plain } = await decryptBuffer(KEY, OBJ, bytes, 4 * CHUNK);
    expect(plain.length).toBe(4 * CHUNK);
  });
});

describe("envelope — key handling", () => {
  it("parses 64-hex and base64 32-byte keys and refuses anything else", () => {
    const hex = KEY.toString("hex");
    expect(parseEncryptionKey(hex).equals(KEY)).toBe(true);
    expect(parseEncryptionKey(` ${hex.toUpperCase()} `).equals(KEY)).toBe(true);
    expect(parseEncryptionKey(KEY.toString("base64")).equals(KEY)).toBe(true);
    for (const bad of ["", "abc", hex.slice(0, 62), randomBytes(16).toString("hex"), randomBytes(31).toString("base64"), "not base64 at all!!"]) {
      expect(() => parseEncryptionKey(bad), bad).toThrow();
    }
  });

  it("derives a stable, non-reversible key id", () => {
    expect(keyIdOf(KEY)).toBe(keyIdOf(Buffer.from(KEY)));
    expect(keyIdOf(KEY)).not.toBe(keyIdOf(OTHER_KEY));
    expect(keyIdOf(KEY)).toMatch(/^[0-9a-f]{16}$/);
    expect(KEY.toString("hex").includes(keyIdOf(KEY))).toBe(false);
  });

  it("refuses keys that are not 32 bytes and invalid chunk sizes", () => {
    expect(() => new EncryptStream(randomBytes(16), OBJ)).toThrow();
    expect(() => new DecryptStream(randomBytes(16), OBJ)).toThrow();
    expect(() => new EncryptStream(KEY, OBJ, 10)).toThrow();
  });
});
