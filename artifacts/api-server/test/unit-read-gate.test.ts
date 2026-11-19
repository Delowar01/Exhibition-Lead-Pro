import { describe, it, expect } from "vitest";
import { createReadGate } from "../src/lib/read-gate.js";

// Pure unit coverage of the gate that bounds how much heavy reporting work runs at once.

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((r) => setImmediate(r));

describe("createReadGate", () => {
  it("never runs more than the limit at once and starts waiters in order", async () => {
    const gate = createReadGate(2);
    const started: number[] = [];
    const jobs = [0, 1, 2, 3, 4].map(() => deferred<string>());
    let peak = 0;
    const results = jobs.map((job, i) =>
      gate.run(async () => {
        started.push(i);
        peak = Math.max(peak, gate.active);
        return job.promise;
      }),
    );
    await tick();
    expect(started).toEqual([0, 1]);
    expect(gate.active).toBe(2);
    expect(gate.waiting).toBe(3);

    jobs[1].resolve("b");
    await tick();
    expect(started).toEqual([0, 1, 2]);
    expect(gate.active).toBe(2);

    jobs[0].resolve("a");
    jobs[2].resolve("c");
    await tick();
    expect(started).toEqual([0, 1, 2, 3, 4]);

    jobs[3].resolve("d");
    jobs[4].resolve("e");
    expect(await Promise.all(results)).toEqual(["a", "b", "c", "d", "e"]);
    expect(peak).toBe(2);
    expect(gate.active).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it("a newcomer cannot overtake the queue or exceed the limit when a slot is handed over", async () => {
    const gate = createReadGate(1);
    const order: string[] = [];
    const first = deferred();
    const a = gate.run(async () => {
      order.push("first");
      await first.promise;
    });
    const b = gate.run(async () => {
      order.push("queued");
      expect(gate.active).toBe(1);
    });
    await tick();
    first.resolve();
    // Asked for in the very turn the slot is released: it must wait behind the queued task.
    const c = gate.run(async () => {
      order.push("newcomer");
      expect(gate.active).toBe(1);
    });
    await Promise.all([a, b, c]);
    expect(order).toEqual(["first", "queued", "newcomer"]);
    expect(gate.active).toBe(0);
  });

  it("frees the slot when a task fails, and passes the failure on", async () => {
    const gate = createReadGate(1);
    await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(
      gate.run(() => {
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");
    expect(gate.active).toBe(0);
    expect(await gate.run(async () => 42)).toBe(42);
  });

  it("handles a burst far larger than the limit", async () => {
    const gate = createReadGate(3);
    let running = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        gate.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await tick();
          running -= 1;
          return i;
        }),
      ),
    );
    expect(results).toEqual(Array.from({ length: 200 }, (_, i) => i));
    expect(peak).toBe(3);
    expect(gate.active).toBe(0);
  });

  it("rejects a limit that is not a positive whole number", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => createReadGate(bad), String(bad)).toThrow();
  });
});
