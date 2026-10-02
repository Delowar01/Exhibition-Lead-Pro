// B25 Correction 2 / 3 — deterministic fake of the Google Cloud Storage SDK surface
// the real GcsStorageDriver uses (bucket/file: createWriteStream with
// preconditionOpts + custom metadata, delete with ifGenerationMatch, getMetadata,
// exists, createReadStream). Models object GENERATIONS and custom metadata so the
// ownership rules can be proven without Google. Never used in production.
import { Readable, Writable } from "node:stream";
import type { Storage } from "@google-cloud/storage";

export type FailMode = "transport" | "after-commit" | null;

export interface FakeObject {
  bytes: Buffer;
  generation: number;
  contentType: string;
  metadata: Record<string, string>;
}

export class FakeBucketStore {
  objects = new Map<string, FakeObject>();
  gen = 0;
  deleteCalls: Array<{ name: string; opts: Record<string, unknown> | undefined }> = [];
  failWrite: (name: string) => FailMode = () => null;

  /** Place an object the way an unrelated writer would (no ownership marker). */
  seed(name: string, bytes: Buffer, contentType = "application/octet-stream", metadata: Record<string, string> = {}): FakeObject {
    const o = { bytes, generation: ++this.gen, contentType, metadata };
    this.objects.set(name, o);
    return o;
  }
}

function apiError(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}

class FakeFile {
  metadata: Record<string, unknown> = {};
  constructor(
    private readonly store: FakeBucketStore,
    readonly name: string,
  ) {}
  createWriteStream(opts: { contentType?: string; preconditionOpts?: { ifGenerationMatch?: number }; metadata?: { metadata?: Record<string, string> } }) {
    const chunks: Buffer[] = [];
    const store = this.store;
    const name = this.name;
    const self = this;
    return new Writable({
      write(chunk: Buffer, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        const mode = store.failWrite(name);
        if (mode === "transport") return cb(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
        const existing = store.objects.get(name);
        if (opts?.preconditionOpts?.ifGenerationMatch === 0 && existing) return cb(apiError(412, "Precondition Failed"));
        const generation = ++store.gen;
        const bytes = Buffer.concat(chunks);
        store.objects.set(name, { bytes, generation, contentType: opts?.contentType ?? "application/octet-stream", metadata: { ...(opts?.metadata?.metadata ?? {}) } });
        self.metadata = { generation: String(generation), size: String(bytes.length), metadata: { ...(opts?.metadata?.metadata ?? {}) } };
        if (mode === "after-commit") return cb(Object.assign(new Error("response lost after commit"), { code: "ECONNRESET" }));
        cb();
      },
    });
  }
  async delete(opts?: { ignoreNotFound?: boolean; ifGenerationMatch?: number | string }) {
    this.store.deleteCalls.push({ name: this.name, opts });
    const o = this.store.objects.get(this.name);
    if (!o) {
      if (opts?.ignoreNotFound) return;
      throw apiError(404, "Not Found");
    }
    if (opts?.ifGenerationMatch !== undefined && Number(opts.ifGenerationMatch) !== o.generation) throw apiError(412, "Precondition Failed");
    this.store.objects.delete(this.name);
  }
  async getMetadata() {
    const o = this.store.objects.get(this.name);
    if (!o) throw apiError(404, "Not Found");
    return [{ size: String(o.bytes.length), contentType: o.contentType, generation: String(o.generation), metadata: { ...o.metadata } }];
  }
  async exists() {
    return [this.store.objects.has(this.name)];
  }
  createReadStream() {
    const o = this.store.objects.get(this.name);
    return Readable.from(o ? [Buffer.from(o.bytes)] : []);
  }
}

export function fakeGcsClient(store: FakeBucketStore): Storage {
  return {
    bucket: () => ({ file: (name: string) => new FakeFile(store, name), getFiles: async () => [[]] }),
  } as unknown as Storage;
}

/** A source stream that delivers `prefix` and then dies (client disconnect). */
export function failingSource(prefix: Buffer): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(prefix);
        this.destroy(Object.assign(new Error("client disconnected"), { code: "ECONNRESET" }));
      }
    },
  });
}
