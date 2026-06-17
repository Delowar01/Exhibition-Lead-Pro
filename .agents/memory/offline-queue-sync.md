---
name: Offline capture queue + sync engine
description: Durable gotchas for the mobile offline-capture queue (AsyncStorage persistence + auto-sync). Read before touching OfflineContext or the queue lib.
---

# Offline capture queue + sync engine

The mobile app queues captures (contacts + raw scan images) on-device while offline and auto-syncs on reconnect. Core pieces: a persistence lib (queue stored in AsyncStorage) and an OfflineContext that owns connectivity + a sequential sync engine.

## Rule: persistence writes MUST be serialized
The queue save function chains writes through a module-level promise (`writeChain`), not fire-and-forget.

**Why:** commits fire rapidly in sequence (enqueue → mark syncing → remove on success). Parallel fire-and-forget AsyncStorage writes can resolve out of order, so an older snapshot clobbers a newer one — on restart the queue resurrects removed items or loses recent transitions.

**How to apply:** keep `saveQueue` returning the chained promise; never revert it to a bare `await AsyncStorage.setItem`.

## Rule: auto-sync needs BOTH a reconnect trigger AND an initial-launch trigger
The reconnect effect only fires on an `isOnline` false→true transition. That alone misses the case where the app relaunches already-online with a restored queue.

**Why:** without a launch-time kick, queued items sit unsynced until the user manually opens the Sync Center or toggles connectivity.

**How to apply:** a one-shot effect gated on a `hydrated` flag + a `didInitialSyncRef` runs `syncNow()` once after the queue loads if online. Don't depend on `queue` for this (would re-fire); `syncNow` is idempotent (guards on a `syncingRef` and filters pending/failed targets).

## Connectivity detection is platform-split
Native uses `expo-network` (`getNetworkStateAsync` + `addNetworkStateListener`, prefer `isInternetReachable ?? isConnected ?? true`); web uses `navigator.onLine` + window online/offline events. There's also a user "work offline" override persisted separately — `isOnline = isConnected && !manualOffline`.

## Sync engine reads refs, not state
The long-lived sync loop reads `queueRef`/`isOnlineRef`/`syncingRef`, not React state, to avoid stale closures while items mutate mid-flight. Scan items do server OCR (`createScan`) then `createContact`; contact items just `createContact`. Items left mid-"syncing" from a previous session are reset to pending on load.
