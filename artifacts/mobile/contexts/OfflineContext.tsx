import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import * as Network from "expo-network";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Platform } from "react-native";

import {
  createContact,
  createScan,
  type ContactInput,
  type ExtractedCardData,
} from "@workspace/api-client-react";

import {
  loadQueue,
  makeQueueId,
  saveQueue,
  type QueueItem,
} from "@/lib/offline-queue";

const MANUAL_OFFLINE_KEY = "csp_offline_manual";

interface EnqueueMeta {
  label: string;
  source: string;
}

interface OfflineContextValue {
  /** True network reachability (ignores the manual override). */
  isConnected: boolean;
  /** User-controlled "work offline" override. */
  manualOffline: boolean;
  /** Effective online state used by the app: connected AND not forced offline. */
  isOnline: boolean;
  queue: QueueItem[];
  /** Items still waiting to sync (pending + syncing). */
  pendingCount: number;
  failedCount: number;
  /** Everything in the queue (pending + syncing + failed). */
  queuedCount: number;
  isSyncing: boolean;
  lastSyncAt: number | null;
  setManualOffline: (value: boolean) => void;
  enqueueContact: (payload: ContactInput, meta: EnqueueMeta) => void;
  enqueueScan: (imageData: string, meta: EnqueueMeta) => void;
  syncNow: () => void;
  retryItem: (id: string) => void;
  removeItem: (id: string) => void;
}

const OfflineContext = createContext<OfflineContextValue>({
  isConnected: true,
  manualOffline: false,
  isOnline: true,
  queue: [],
  pendingCount: 0,
  failedCount: 0,
  queuedCount: 0,
  isSyncing: false,
  lastSyncAt: null,
  setManualOffline: () => {},
  enqueueContact: () => {},
  enqueueScan: () => {},
  syncNow: () => {},
  retryItem: () => {},
  removeItem: () => {},
});

function extractedToContact(data: ExtractedCardData): ContactInput {
  return {
    firstName: data.firstName ?? null,
    lastName: data.lastName ?? null,
    jobTitle: data.jobTitle ?? null,
    contactCompany: data.company ?? null,
    email: data.email ?? null,
    mobile: data.mobile ?? null,
    website: data.website ?? null,
    linkedin: data.linkedin ?? null,
    address: data.address ?? null,
  };
}

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isConnected, setIsConnected] = useState(true);
  const [manualOffline, setManualOfflineState] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Refs mirror the latest state so the (long-lived) sync loop never works off
  // a stale closure while items are being mutated mid-flight.
  const queueRef = useRef<QueueItem[]>([]);
  const syncingRef = useRef(false);
  const isOnline = isConnected && !manualOffline;
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  const commit = useCallback((next: QueueItem[]) => {
    queueRef.current = next;
    setQueue(next);
    void saveQueue(next);
  }, []);

  // --- Load persisted queue + manual flag once. -----------------------------
  useEffect(() => {
    let mounted = true;
    void (async () => {
      const [stored, manual] = await Promise.all([
        loadQueue(),
        AsyncStorage.getItem(MANUAL_OFFLINE_KEY),
      ]);
      if (!mounted) return;
      // Any item left mid-"syncing" from a previous session is reset to pending.
      const normalized = stored.map((it) =>
        it.status === "syncing" ? { ...it, status: "pending" as const } : it,
      );
      queueRef.current = normalized;
      setQueue(normalized);
      setManualOfflineState(manual === "1");
      setHydrated(true);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // --- Connectivity detection. ----------------------------------------------
  useEffect(() => {
    let mounted = true;

    if (Platform.OS === "web") {
      const update = () => {
        if (mounted) setIsConnected(typeof navigator === "undefined" ? true : navigator.onLine);
      };
      update();
      if (typeof window !== "undefined") {
        window.addEventListener("online", update);
        window.addEventListener("offline", update);
        return () => {
          mounted = false;
          window.removeEventListener("online", update);
          window.removeEventListener("offline", update);
        };
      }
      return () => {
        mounted = false;
      };
    }

    void Network.getNetworkStateAsync()
      .then((state) => {
        if (mounted) setIsConnected(state.isInternetReachable ?? state.isConnected ?? true);
      })
      .catch(() => {
        /* assume online on probe failure */
      });
    const sub = Network.addNetworkStateListener((state) => {
      if (mounted) setIsConnected(state.isInternetReachable ?? state.isConnected ?? true);
    });
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  // --- Sync engine. ---------------------------------------------------------
  const updateItem = useCallback(
    (id: string, patch: Partial<QueueItem>) => {
      commit(queueRef.current.map((it) => (it.id === id ? { ...it, ...patch } : it)));
    },
    [commit],
  );

  const syncNow = useCallback(async () => {
    if (syncingRef.current) return;
    if (!isOnlineRef.current) return;
    const targets = queueRef.current.filter(
      (it) => it.status === "pending" || it.status === "failed",
    );
    if (targets.length === 0) return;

    syncingRef.current = true;
    setIsSyncing(true);
    let syncedAny = false;

    try {
      for (const item of targets) {
        if (!isOnlineRef.current) break;
        updateItem(item.id, { status: "syncing", lastError: undefined });
        try {
          if (item.kind === "contact" && item.payload) {
            await createContact(item.payload);
          } else if (item.kind === "scan" && item.imageData) {
            const scan = await createScan({ imageData: item.imageData });
            await createContact(extractedToContact(scan.extractedData ?? {}));
          } else {
            throw new Error("Malformed queue item");
          }
          // Success → drop it from the queue.
          commit(queueRef.current.filter((it) => it.id !== item.id));
          syncedAny = true;
        } catch (err) {
          updateItem(item.id, {
            status: "failed",
            attempts: item.attempts + 1,
            lastError: err instanceof Error ? err.message : "Sync failed",
          });
        }
      }
    } finally {
      syncingRef.current = false;
      setIsSyncing(false);
      setLastSyncAt(Date.now());
      if (syncedAny) void queryClient.invalidateQueries();
    }
  }, [commit, updateItem, queryClient]);

  // --- Auto-sync when we (re)gain connectivity. -----------------------------
  const prevOnlineRef = useRef(isOnline);
  useEffect(() => {
    const wasOnline = prevOnlineRef.current;
    prevOnlineRef.current = isOnline;
    if (isOnline && !wasOnline) {
      void syncNow();
    }
  }, [isOnline, syncNow]);

  // --- Initial sync on launch when already online with a restored queue. -----
  // The reconnect effect only fires on a false→true transition, so a relaunch
  // that starts online would otherwise leave restored items unsynced.
  const didInitialSyncRef = useRef(false);
  useEffect(() => {
    if (!hydrated || didInitialSyncRef.current) return;
    didInitialSyncRef.current = true;
    if (isOnlineRef.current) void syncNow();
  }, [hydrated, syncNow]);

  const setManualOffline = useCallback((value: boolean) => {
    setManualOfflineState(value);
    void AsyncStorage.setItem(MANUAL_OFFLINE_KEY, value ? "1" : "0");
  }, []);

  const enqueueContact = useCallback(
    (payload: ContactInput, meta: EnqueueMeta) => {
      const item: QueueItem = {
        id: makeQueueId(),
        kind: "contact",
        status: "pending",
        createdAt: Date.now(),
        attempts: 0,
        label: meta.label,
        source: meta.source,
        payload,
      };
      commit([item, ...queueRef.current]);
    },
    [commit],
  );

  const enqueueScan = useCallback(
    (imageData: string, meta: EnqueueMeta) => {
      const item: QueueItem = {
        id: makeQueueId(),
        kind: "scan",
        status: "pending",
        createdAt: Date.now(),
        attempts: 0,
        label: meta.label,
        source: meta.source,
        imageData,
      };
      commit([item, ...queueRef.current]);
    },
    [commit],
  );

  const retryItem = useCallback(
    (id: string) => {
      updateItem(id, { status: "pending", lastError: undefined });
      void syncNow();
    },
    [updateItem, syncNow],
  );

  const removeItem = useCallback(
    (id: string) => {
      commit(queueRef.current.filter((it) => it.id !== id));
    },
    [commit],
  );

  const pendingCount = queue.filter(
    (it) => it.status === "pending" || it.status === "syncing",
  ).length;
  const failedCount = queue.filter((it) => it.status === "failed").length;

  const value: OfflineContextValue = {
    isConnected,
    manualOffline,
    isOnline,
    queue,
    pendingCount,
    failedCount,
    queuedCount: queue.length,
    isSyncing,
    lastSyncAt,
    setManualOffline,
    enqueueContact,
    enqueueScan,
    syncNow: () => void syncNow(),
    retryItem,
    removeItem,
  };

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline(): OfflineContextValue {
  return useContext(OfflineContext);
}
