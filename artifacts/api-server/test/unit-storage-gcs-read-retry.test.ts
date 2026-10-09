// B25 Correction 9 — the driver's bounded read re-open, exercised with a controllable fake client and fake
// timers (deterministic: every attempt, delay and consumer event is explicit). Complements the child-process
// scenarios against the real SDK (b25c9-gcs-stream-cancel.test.ts).
//   • an active consumer: a transient provider error is re-opened (200 ms, then 400 ms), three attempts in all
//   • a consumer that closes DURING a back-off cancels the pending re-open: no further request
//   • a consumer that closes after the timer became due but before its callback ran (destroy() is observable
//     synchronously, the 'close' handler only on the next tick): the attempt re-checks and opens nothing
//   • no re-open after any delivered byte; exhausted attempts and non-transient errors surface at once
//   • the deferred pre-response teardown (the crash fix) and the maxBytes data-path enforcement are unchanged
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GcsStorageDriver } from "../src/storage/gcs-driver.js";
import { StorageError } from "../src/storage/contract.js";

type FakeStream = PassThrough & { destroyedByDriver?: boolean };
let streams: FakeStream[];
function fakeClient() {
  streams = [];
  return {
    bucket: () => ({
      file: () => ({
        getMetadata: async () => [{ size: "4", contentType: "application/pdf", generation: "1760000000000001", metadata: {} }],
        createReadStream: () => {
          const rs = new PassThrough() as FakeStream;
          streams.push(rs);
          return rs;
        },
      }),
    }),
  } as unknown as ConstructorParameters<typeof GcsStorageDriver>[0];
}
const tick = () => new Promise<void>((r) => process.nextTick(r));
const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await tick(); };
const transient = (code: number) => Object.assign(new Error(`provider ${code}`), { code });
function observe(out: Readable) {
  const o = { bytes: 0, error: null as StorageError | null, ended: false, closed: false };
  out.on("data", (c: Buffer) => (o.bytes += c.length));
  out.once("error", (e) => (o.error = e as StorageError));
  out.once("end", () => (o.ended = true));
  out.once("close", () => (o.closed = true));
  return o;
}
async function open() {
  const driver = new GcsStorageDriver(fakeClient(), "fake-bucket");
  const opened = await driver.getStream("tenants/1/documents/row", { maxBytes: 1024 });
  await ticks();
  return opened.stream;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("B25 C9 — read re-open with a fake client and fake timers", () => {
  it("an active consumer: a transient error is re-opened after 200 ms and the second attempt delivers the exact bytes", async () => {
    const out = await open();
    const o = observe(out);
    expect(streams).toHaveLength(1);
    streams[0].emit("error", transient(503));
    await ticks();
    expect(streams).toHaveLength(1); // not before the delay
    vi.advanceTimersByTime(199);
    expect(streams).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(streams).toHaveLength(2);
    streams[1].emit("response", {});
    streams[1].end(Buffer.from("abcd"));
    await ticks(8);
    expect(o.bytes).toBe(4);
    expect(o.ended).toBe(true);
    expect(o.error).toBeNull();
  });

  it("exhausted attempts: 200 ms then 400 ms back-off, three attempts in all, then STORAGE_UNAVAILABLE", async () => {
    const out = await open();
    const o = observe(out);
    streams[0].emit("error", transient(503));
    await ticks();
    vi.advanceTimersByTime(200);
    expect(streams).toHaveLength(2);
    streams[1].emit("error", transient(502));
    await ticks();
    vi.advanceTimersByTime(399);
    expect(streams).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(streams).toHaveLength(3);
    streams[2].emit("error", transient(503));
    await ticks();
    expect(o.error?.code).toBe("STORAGE_UNAVAILABLE");
    vi.advanceTimersByTime(10_000);
    expect(streams).toHaveLength(3);
  });

  it("a consumer that closes DURING the first back-off cancels the pending re-open: exactly one attempt", async () => {
    const out = await open();
    streams[0].emit("error", transient(503));
    await ticks();
    vi.advanceTimersByTime(50);
    out.destroy();
    await ticks(); // the 'close' handler runs (requestStop)
    vi.advanceTimersByTime(10_000);
    expect(streams).toHaveLength(1);
  });

  it("a consumer that closes DURING a later back-off: exactly two attempts", async () => {
    const out = await open();
    streams[0].emit("error", transient(503));
    await ticks();
    vi.advanceTimersByTime(200);
    expect(streams).toHaveLength(2);
    streams[1].emit("error", transient(503));
    await ticks();
    vi.advanceTimersByTime(100);
    out.destroy();
    await ticks();
    vi.advanceTimersByTime(10_000);
    expect(streams).toHaveLength(2);
  });

  it("a consumer that closes after the timer became due but before the callback ran: the attempt re-checks and opens nothing", async () => {
    const out = await open();
    streams[0].emit("error", transient(503));
    await ticks();
    // destroy() marks the stream synchronously; its 'close' handler (which clears the timer) only runs on the
    // next tick — the re-open callback fires in between and must find out.destroyed
    out.destroy();
    vi.advanceTimersByTime(200);
    expect(streams).toHaveLength(1);
    await ticks();
    vi.advanceTimersByTime(10_000);
    expect(streams).toHaveLength(1);
  });

  it("no re-open after any delivered byte: the error surfaces at once", async () => {
    const out = await open();
    const o = observe(out);
    streams[0].emit("response", {});
    streams[0].write(Buffer.from("ab"));
    await ticks();
    expect(o.bytes).toBe(2);
    streams[0].emit("error", transient(503));
    await ticks();
    expect(o.error?.code).toBe("STORAGE_UNAVAILABLE");
    vi.advanceTimersByTime(10_000);
    expect(streams).toHaveLength(1);
  });

  it("a non-transient error (404) surfaces at once as STORAGE_NOT_FOUND without any re-open", async () => {
    const out = await open();
    const o = observe(out);
    streams[0].emit("error", transient(404));
    await ticks();
    expect(o.error?.code).toBe("STORAGE_NOT_FOUND");
    vi.advanceTimersByTime(10_000);
    expect(streams).toHaveLength(1);
  });

  it("a transport failure before the response (ECONNRESET) is re-opened like a 5xx", async () => {
    const out = await open();
    streams[0].emit("error", Object.assign(new Error("reset"), { code: "ECONNRESET" }));
    await ticks();
    vi.advanceTimersByTime(200);
    expect(streams).toHaveLength(2);
  });

  it("the deferred pre-response teardown is unchanged: a close before the response destroys the SDK stream only after 'response' (next macrotask)", async () => {
    const out = await open();
    out.destroy();
    await ticks();
    expect(streams[0].destroyed).toBe(false); // nothing to pipe into yet: destroying now is the Node >= 23 crash
    streams[0].emit("response", {});
    expect(streams[0].destroyed).toBe(false);
    vi.advanceTimersByTime(0); // runs the pending setImmediate
    expect(streams[0].destroyed).toBe(true);
    expect(streams).toHaveLength(1);
  });

  it("a close after the response destroys the SDK stream at once", async () => {
    const out = await open();
    streams[0].emit("response", {});
    out.destroy();
    await ticks();
    expect(streams[0].destroyed).toBe(true);
  });

  it("maxBytes on the data path: STORAGE_TOO_LARGE, the source is torn down, no re-open", async () => {
    const out = await open();
    const o = observe(out);
    streams[0].emit("response", {});
    streams[0].write(Buffer.alloc(2048, 1));
    await ticks(6);
    expect(o.error?.code).toBe("STORAGE_TOO_LARGE");
    expect(streams[0].destroyed).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(streams).toHaveLength(1);
  });
});
