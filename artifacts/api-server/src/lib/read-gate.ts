// A small process-wide gate for heavy read-only work.
//
// The API shares one PostgreSQL pool between tenant requests and platform reporting. A
// reporting request fans out into many aggregate queries; without a bound, a few of them
// would hold every pooled connection while tenant requests wait. A gate lets at most `limit`
// units of such work run at once, however many requests ask for it; the rest wait in order.
export interface ReadGate {
  /** Runs `task` when a slot is free; resolves or rejects with its outcome. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Slots currently in use (for tests and diagnostics). */
  readonly active: number;
  /** Tasks waiting for a slot. */
  readonly waiting: number;
}

export function createReadGate(limit: number): ReadGate {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("A read gate needs a positive whole-number limit");
  let active = 0;
  const waiters: Array<() => void> = [];

  // A freed slot is handed straight to the next waiter (the count is not decremented in
  // between), so a newcomer can never slip in ahead of the queue or exceed the limit.
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else active -= 1;
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active < limit) active += 1;
      else await new Promise<void>((resolve) => waiters.push(resolve));
      try {
        return await task();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get waiting() {
      return waiters.length;
    },
  };
}
