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
  upsertOwnCard,
  type BusinessCardInput,
  type ContactInput,
  type ExtractedCardData,
} from "@workspace/api-client-react";

import { useAuth } from "@/contexts/AuthContext";
import i18n from "@/lib/i18n";

import { loadQueue, saveQueue, type QueueItem } from "@/lib/offline-queue";
import {
  canStartSync,
  discardQuarantined,
  enqueueItem,
  quarantinedCount as countQuarantined,
  queueCounts,
  queueOwnerKey,
  removeOwnedItem,
  retryOwnedItem,
  syncOwnedQueue,
  visibleQueue,
} from "@/lib/offline-queue-model";

const MANUAL_OFFLINE_KEY = "csp_offline_manual";

interface EnqueueMeta {
  label: string;
  source: string;
  appLanguage?: "en" | "ar";
  eventId?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  gpsAccuracy?: number | null;
}

interface OfflineContextValue {
  /** True network reachability (ignores the manual override). */
  isConnected: boolean;
  /** User-controlled "work offline" override (device-wide). */
  manualOffline: boolean;
  /** Effective online state used by the app: connected AND not forced offline. */
  isOnline: boolean;
  /** The signed-in account's own queued work — never another account's. */
  queue: QueueItem[];
  /** Items still waiting to sync (pending + syncing), this account only. */
  pendingCount: number;
  failedCount: number;
  /** Everything of this account (pending + syncing + failed). */
  queuedCount: number;
  /** Items from an older app version (no ownership) kept quarantined on the device; count only. */
  legacyCount: number;
  isSyncing: boolean;
  lastSyncAt: number | null;
  setManualOffline: (value: boolean) => void;
  /** Each enqueue returns false (nothing kept) when no tenant account is signed in. */
  enqueueContact: (payload: ContactInput, meta: EnqueueMeta) => boolean;
  enqueueScan: (imageData: string, meta: EnqueueMeta) => boolean;
  enqueueCard: (payload: BusinessCardInput, label: string) => boolean;
  syncNow: () => void;
  retryItem: (id: string) => void;
  removeItem: (id: string) => void;
  /** Explicitly drop the quarantined legacy items (they are never adopted or synced). */
  discardLegacyItems: () => void;
}

const OfflineContext = createContext<OfflineContextValue>({
  isConnected: true,
  manualOffline: false,
  isOnline: true,
  queue: [],
  pendingCount: 0,
  failedCount: 0,
  queuedCount: 0,
  legacyCount: 0,
  isSyncing: false,
  lastSyncAt: null,
  setManualOffline: () => {},
  enqueueContact: () => false,
  enqueueScan: () => false,
  enqueueCard: () => false,
  syncNow: () => {},
  retryItem: () => {},
  removeItem: () => {},
  discardLegacyItems: () => {},
});

function extractedToContact(
  data: ExtractedCardData,
  extra?: Partial<ContactInput>,
): ContactInput {
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
    ...extra,
  };
}

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  // The account that owns new work and may see / sync existing work:
  // undefined until auth resolves, null when logged out or not a tenant user.
  const { user, isLoading: authLoading } = useAuth();
  const owner = authLoading ? undefined : queueOwnerKey(user);
  const ownerRef = useRef<string | null | undefined>(owner);
  ownerRef.current = owner;
  // Every persisted item (all owners + quarantined); only `owner`'s subset is exposed.
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
      // Ownership + "syncing" → pending normalization happen in the parser.
      queueRef.current = stored;
      setQueue(stored);
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

  // --- Sync engine (lib/offline-queue-model.ts syncOwnedQueue). ------------
  // The network work for one item. It runs under the session active at that
  // moment, which is why the engine re-checks the owner right before calling it.
  const performItem = useCallback(async (item: QueueItem) => {
    if (item.kind === "contact" && item.payload) {
      await createContact(item.payload);
    } else if (item.kind === "card" && item.cardPayload) {
      await upsertOwnCard(item.cardPayload);
    } else if (item.kind === "scan" && item.imageData) {
      const scan = await createScan({
        imageData: item.imageData,
        appLanguage: item.appLanguage ?? (i18n.language === "ar" ? "ar" : "en"),
        eventId: item.eventId ?? undefined,
        latitude: item.latitude ?? undefined,
        longitude: item.longitude ?? undefined,
        gpsAccuracy: item.gpsAccuracy ?? undefined,
      });
      await createContact(
        extractedToContact(scan.extractedData ?? {}, {
          eventId: item.eventId ?? null,
          latitude: item.latitude ?? null,
          longitude: item.longitude ?? null,
          gpsAccuracy: item.gpsAccuracy ?? null,
        }),
      );
    } else {
      throw new Error("Malformed queue item");
    }
  }, []);

  const syncNow = useCallback(async () => {
    if (syncingRef.current) return;
    if (!isOnlineRef.current) return;
    // Only a signed-in tenant account syncs, and only its own items. The owner
    // is captured here and re-read before every request inside the engine.
    const syncOwner = ownerRef.current;
    if (!canStartSync({ hydrated: true, owner: syncOwner })) return;

    syncingRef.current = true;
    setIsSyncing(true);
    let result = { synced: 0 };
    try {
      result = await syncOwnedQueue({
        owner: syncOwner,
        currentOwner: () => ownerRef.current,
        isOnline: () => isOnlineRef.current,
        getQueue: () => queueRef.current,
        setQueue: commit,
        perform: performItem,
      });
    } finally {
      syncingRef.current = false;
      setIsSyncing(false);
      setLastSyncAt(Date.now());
      if (result.synced > 0) void queryClient.invalidateQueries();
    }
  }, [commit, performItem, queryClient]);

  // --- Auto-sync when we (re)gain connectivity. -----------------------------
  const prevOnlineRef = useRef(isOnline);
  useEffect(() => {
    const wasOnline = prevOnlineRef.current;
    prevOnlineRef.current = isOnline;
    if (isOnline && !wasOnline) {
      void syncNow();
    }
  }, [isOnline, syncNow]);

  // --- Initial sync on launch / on login with a restored queue. --------------
  // The reconnect effect only fires on a false→true transition, so a relaunch
  // that starts online would otherwise leave restored items unsynced. Nothing
  // runs until the queue is hydrated AND auth has resolved to a tenant owner;
  // a launch while logged out syncs nothing, and a later login syncs only that
  // owner's items (once per owner change).
  const autoSyncedOwnerRef = useRef<string | null>(null);
  useEffect(() => {
    if (!canStartSync({ hydrated, owner })) {
      if (owner === null) autoSyncedOwnerRef.current = null;
      return;
    }
    if (autoSyncedOwnerRef.current === owner) return;
    autoSyncedOwnerRef.current = owner ?? null;
    if (isOnlineRef.current) void syncNow();
  }, [hydrated, owner, syncNow]);

  const setManualOffline = useCallback((value: boolean) => {
    setManualOfflineState(value);
    void AsyncStorage.setItem(MANUAL_OFFLINE_KEY, value ? "1" : "0");
  }, []);

  // Every enqueue stamps the item with the signed-in tenant owner; without one
  // nothing is kept and the caller is told (false) so it can inform the user.
  const enqueueContact = useCallback(
    (payload: ContactInput, meta: EnqueueMeta): boolean => {
      const next = enqueueItem(
        queueRef.current,
        { kind: "contact", label: meta.label, source: meta.source, payload },
        ownerRef.current,
      );
      if (!next) return false;
      commit(next);
      return true;
    },
    [commit],
  );

  const enqueueScan = useCallback(
    (imageData: string, meta: EnqueueMeta): boolean => {
      const next = enqueueItem(
        queueRef.current,
        {
          kind: "scan",
          label: meta.label,
          source: meta.source,
          imageData,
          appLanguage: meta.appLanguage,
          eventId: meta.eventId ?? null,
          latitude: meta.latitude ?? null,
          longitude: meta.longitude ?? null,
          gpsAccuracy: meta.gpsAccuracy ?? null,
        },
        ownerRef.current,
      );
      if (!next) return false;
      commit(next);
      return true;
    },
    [commit],
  );

  const enqueueCard = useCallback(
    (payload: BusinessCardInput, label: string): boolean => {
      // Collapses to a single pending card edit PER OWNER — only the latest of
      // this account matters; another account's queued card edit is kept.
      const next = enqueueItem(
        queueRef.current,
        { kind: "card", label, source: "card", cardPayload: payload },
        ownerRef.current,
      );
      if (!next) return false;
      commit(next);
      return true;
    },
    [commit],
  );

  // retry / remove act only on the current owner's own item (a foreign or
  // quarantined id is a safe no-op).
  const retryItem = useCallback(
    (id: string) => {
      const next = retryOwnedItem(queueRef.current, id, ownerRef.current);
      if (next === queueRef.current) return;
      commit(next);
      void syncNow();
    },
    [commit, syncNow],
  );

  const removeItem = useCallback(
    (id: string) => {
      const next = removeOwnedItem(queueRef.current, id, ownerRef.current);
      if (next === queueRef.current) return;
      commit(next);
    },
    [commit],
  );

  const discardLegacyItems = useCallback(() => {
    commit(discardQuarantined(queueRef.current));
  }, [commit]);

  const visible = visibleQueue(queue, owner);
  const counts = queueCounts(queue, owner);

  const value: OfflineContextValue = {
    isConnected,
    manualOffline,
    isOnline,
    queue: visible,
    pendingCount: counts.pending,
    failedCount: counts.failed,
    queuedCount: counts.queued,
    legacyCount: countQuarantined(queue),
    isSyncing,
    lastSyncAt,
    setManualOffline,
    enqueueContact,
    enqueueScan,
    enqueueCard,
    syncNow: () => void syncNow(),
    retryItem,
    removeItem,
    discardLegacyItems,
  };

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline(): OfflineContextValue {
  return useContext(OfflineContext);
}
