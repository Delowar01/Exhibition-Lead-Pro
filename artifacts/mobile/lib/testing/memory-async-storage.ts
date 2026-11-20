// Test support only: the parts of AsyncStorage the offline queue uses, in
// memory, with the failure modes of a real device — a value that can be
// written but not read back, a store that refuses writes.
export interface MemoryAsyncStorage {
  data: Map<string, string>;
  /** Keys whose getItem throws (Android: a row too large for the read window). */
  unreadable: Set<string>;
  /** When set, every write throws it. */
  failWrites: Error | null;
  /** Throw from the next N writes only. */
  failNextWrites: number;
  /** Every completed write, in order: [key, valueLength]. */
  log: Array<[string, number]>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiSet(pairs: [string, string][]): Promise<void>;
}

export function createMemoryAsyncStorage(): MemoryAsyncStorage {
  const store: MemoryAsyncStorage = {
    data: new Map(),
    unreadable: new Set(),
    failWrites: null,
    failNextWrites: 0,
    log: [],
    async getItem(key) {
      if (store.unreadable.has(key)) throw new Error("Row too big to fit into CursorWindow");
      return store.data.has(key) ? (store.data.get(key) as string) : null;
    },
    async setItem(key, value) {
      await store.multiSet([[key, value]]);
    },
    async removeItem(key) {
      if (store.failWrites) throw store.failWrites;
      store.data.delete(key);
    },
    async multiSet(pairs) {
      if (store.failWrites) throw store.failWrites;
      if (store.failNextWrites > 0) {
        store.failNextWrites -= 1;
        throw new Error("database or disk is full (code 13 SQLITE_FULL)");
      }
      // All-or-nothing, like the single transaction AsyncStorage uses on Android.
      for (const [k, v] of pairs) {
        store.data.set(k, v);
        store.log.push([k, v.length]);
      }
    },
  };
  return store;
}
