// B25 Correction 2 / 3 / 4 — deterministic fake of the Google Cloud Storage SDK
// surface the real GcsStorageDriver uses (bucket/file: createWriteStream with
// preconditionOpts + custom metadata, delete with ifGenerationMatch, getMetadata,
// exists, createReadStream). Models object GENERATIONS and custom metadata so
// the ownership rules can be proven without Google, and (Correction 4) models a
// provider whose commit is DECOUPLED from the client's view of the request:
//   • "late-commit"  the client sees a transport failure now; the provider
//                    commits the object later, when the test calls
//                    store.commitPending(name)
//   • "hold"         the request never answers (the writer is considered dead);
//                    the provider may still commit later via commitPending
//   • onWriteStart / interceptFinal hooks observe the exact moment the provider
//     request starts / is about to commit (ordering proofs)
//   • "no-generation" (Correction 6): the provider commits the object but the
//     write stream's file metadata exposes NO generation (the SDK contract makes
//     it optional); afterCommit observes the commit; failHead makes getMetadata
//     fail for a name (generation recovery cannot complete)
// Never used in production.
import { Readable, Writable } from "node:stream";
import type { Storage } from "@google-cloud/storage";

export type FailMode = "transport" | "after-commit" | "late-commit" | "hold" | "no-generation" | null;

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
  /** Object names whose provider request started (first chunk written), in order. */
  writeStarts: string[] = [];
  /** Provider commits still outstanding after the client gave up / died (late-commit, hold). */
  pending = new Map<string, () => FakeObject>();
  failWrite: (name: string) => FailMode = () => null;
  onWriteStart?: (name: string) => void;
  /** Awaited right before the provider decides the request's outcome. */
  interceptFinal?: (name: string) => Promise<void> | void;
  /** Called right after a request's object was committed (before the client learns the outcome). */
  afterCommit?: (name: string, object: FakeObject) => void;
  /** When it returns an error for a name, getMetadata (HEAD) rejects with it. */
  failHead: (name: string) => Error | null = () => null;

  /** Place an object the way an unrelated writer would (no ownership marker). */
  seed(name: string, bytes: Buffer, contentType = "application/octet-stream", metadata: Record<string, string> = {}): FakeObject {
    const o = { bytes, generation: ++this.gen, contentType, metadata };
    this.objects.set(name, o);
    return o;
  }

  /** The provider finally commits a request the client already gave up on. */
  commitPending(name: string): FakeObject {
    const commit = this.pending.get(name);
    if (!commit) throw new Error(`no pending provider commit for ${name}`);
    this.pending.delete(name);
    return commit();
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
    let started = false;
    return new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (!started) {
          started = true;
          store.writeStarts.push(name);
          store.onWriteStart?.(name);
        }
        chunks.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        void (async () => {
          try {
            await store.interceptFinal?.(name);
          } catch (err) {
            return cb(err as Error);
          }
          const mode = store.failWrite(name);
          if (mode === "transport") return cb(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
          const commit = (): FakeObject => {
            const existing = store.objects.get(name);
            if (opts?.preconditionOpts?.ifGenerationMatch === 0 && existing) throw apiError(412, "Precondition Failed");
            const generation = ++store.gen;
            const bytes = Buffer.concat(chunks);
            const o = { bytes, generation, contentType: opts?.contentType ?? "application/octet-stream", metadata: { ...(opts?.metadata?.metadata ?? {}) } };
            store.objects.set(name, o);
            self.metadata = mode === "no-generation" ? { size: String(bytes.length), metadata: { ...o.metadata } } : { generation: String(generation), size: String(bytes.length), metadata: { ...o.metadata } };
            store.afterCommit?.(name, o);
            return o;
          };
          if (mode === "late-commit") {
            store.pending.set(name, commit);
            return cb(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
          }
          if (mode === "hold") {
            store.pending.set(name, commit);
            return; // the request never answers
          }
          try {
            commit();
          } catch (err) {
            return cb(err as Error);
          }
          if (mode === "after-commit") return cb(Object.assign(new Error("response lost after commit"), { code: "ECONNRESET" }));
          cb();
        })();
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
    const injected = this.store.failHead(this.name);
    if (injected) throw injected;
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
