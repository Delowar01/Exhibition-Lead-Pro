import { useQueryClient } from "@tanstack/react-query";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  deleteOwnCard,
  getOwnCard,
  upsertOwnCard,
  type BusinessCard,
  type BusinessCardInput,
} from "@workspace/api-client-react";

import { useAuth } from "@/contexts/AuthContext";
import { useOffline } from "@/contexts/OfflineContext";
import { cacheBelongsTo, optimisticCardFor, visibleCachedCard, type OwnedCardCache } from "@/lib/card-cache-model";
import { clearCachedCard, loadCachedCard, saveCachedCard } from "@/lib/card-storage";
import { queueOwnerKey } from "@/lib/offline-queue-model";

interface CardContextValue {
  /** Best known copy of the card: server → local optimistic → cache. */
  card: BusinessCard | null;
  /** True until the first load (cache or network) settles. */
  isLoading: boolean;
  /** The user has created a card (has a stored full name). */
  hasCard: boolean;
  /** A local edit exists that hasn't reached the server yet. */
  pendingSync: boolean;
  /** Upsert the card — online writes immediately, offline queues + caches. */
  saveCard: (input: BusinessCardInput) => Promise<void>;
  /** Delete the card permanently (requires network). */
  deleteCard: () => Promise<void>;
  /** Force a server refetch (e.g. pull-to-refresh). */
  refresh: () => void;
}

const CardContext = createContext<CardContextValue>({
  card: null,
  isLoading: true,
  hasCard: false,
  pendingSync: false,
  saveCard: async () => {},
  deleteCard: async () => {},
  refresh: () => {},
});

export function CardProvider({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const { isOnline, enqueueCard, lastSyncAt } = useOffline();
  const queryClient = useQueryClient();

  // The account the card belongs to: undefined until auth resolves, null when
  // logged out or not a tenant user. Everything exposed below is scoped to it.
  const owner = authLoading ? undefined : queueOwnerKey(user);
  const ownerRef = useRef<string | null | undefined>(owner);
  ownerRef.current = owner;

  // The stored slot (whoever's it is) and the card the CURRENT owner may see.
  const cacheRef = useRef<OwnedCardCache | null>(null);
  const [card, setCard] = useState<BusinessCard | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingSync, setPendingSync] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Hold `next` as the current owner's card (state + cache). Without a tenant
  // owner nothing is shown or written; clearing only removes the owner's own
  // slot, never silently another account's.
  const setAndCache = useCallback((next: BusinessCard | null) => {
    const o = ownerRef.current;
    if (next === null) {
      if (cacheBelongsTo(cacheRef.current, o)) {
        cacheRef.current = null;
        void clearCachedCard();
      }
      setCard(null);
      return;
    }
    if (typeof o !== "string") {
      setCard(null);
      return;
    }
    cacheRef.current = { owner: o, card: next };
    setCard(next);
    void saveCachedCard(o, next);
  }, []);

  // --- Cache hydration (instant render on cold start, owner-gated). ---------
  useEffect(() => {
    let mounted = true;
    void (async () => {
      const cached = await loadCachedCard();
      if (!mounted) return;
      cacheRef.current = cached;
      setHydrated(true);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // --- Owner binding: the visible card is the owner's own cache, or nothing. --
  // Runs on hydration and on every auth boundary (login, logout, switch): a
  // different account never sees the previous one's card or pending state.
  useEffect(() => {
    if (!hydrated) return;
    setCard(visibleCachedCard(cacheRef.current, owner));
    setPendingSync(false);
  }, [hydrated, owner]);

  // --- Server fetch. --------------------------------------------------------
  const fetchCard = useCallback(async () => {
    if (!isAuthenticated) return;
    const fetchOwner = ownerRef.current;
    if (typeof fetchOwner !== "string") {
      setIsLoading(false);
      return;
    }
    try {
      const server = await getOwnCard();
      // The response belongs to the account that was signed in when the
      // request was sent; if the owner changed meanwhile, it is dropped.
      if (ownerRef.current !== fetchOwner) return;
      setAndCache(server);
      setPendingSync(false);
    } catch (err) {
      if (ownerRef.current !== fetchOwner) return;
      // A 404 means "no card yet" — clear any stale cache so the empty state
      // shows. Other errors (offline, server) keep the last known card.
      const status = (err as { status?: number } | null)?.status;
      if (status === 404) {
        setAndCache(null);
      }
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated, setAndCache]);

  useEffect(() => {
    if (!isAuthenticated) {
      setIsLoading(false);
      return;
    }
    if (isOnline) {
      void fetchCard();
    } else {
      setIsLoading(false);
    }
  }, [isAuthenticated, isOnline, fetchCard]);

  // --- Refetch after an offline queue flush completes. ----------------------
  const lastSyncSeen = useRef(lastSyncAt);
  useEffect(() => {
    if (lastSyncAt !== lastSyncSeen.current) {
      lastSyncSeen.current = lastSyncAt;
      if (isOnline) void fetchCard();
    }
  }, [lastSyncAt, isOnline, fetchCard]);

  const saveCard = useCallback(
    async (input: BusinessCardInput) => {
      const account = { avatarUrl: user?.avatarUrl, name: user?.name };
      const saveOwner = ownerRef.current;
      // Server-owned fields come only from THIS owner's cached card (never
      // another account's); without a tenant owner nothing is saved.
      const optimistic = optimisticCardFor(input, cacheRef.current, saveOwner, account);
      if (!optimistic) throw new Error("No signed-in company account");
      const previous = visibleCachedCard(cacheRef.current, saveOwner);
      // Optimistic update first so the UI reflects the edit immediately.
      setAndCache(optimistic);

      if (isOnline) {
        const server = await upsertOwnCard(input);
        if (ownerRef.current !== saveOwner) return;
        setAndCache(server);
        setPendingSync(false);
        void queryClient.invalidateQueries();
      } else if (enqueueCard(input, input.fullName || "My business card")) {
        setPendingSync(true);
      } else {
        // No signed-in tenant account: nothing is queued; roll back the optimistic edit and surface a save error.
        setAndCache(previous);
        throw new Error("No signed-in company account");
      }
    },
    [isOnline, enqueueCard, queryClient, setAndCache, user?.avatarUrl, user?.name],
  );

  const deleteCard = useCallback(async () => {
    await deleteOwnCard();
    setAndCache(null);
    setPendingSync(false);
    void queryClient.invalidateQueries();
  }, [setAndCache, queryClient]);

  const value: CardContextValue = {
    card,
    isLoading,
    hasCard: !!card?.fullName,
    pendingSync,
    saveCard,
    deleteCard,
    refresh: () => void fetchCard(),
  };

  return <CardContext.Provider value={value}>{children}</CardContext.Provider>;
}

export function useCard(): CardContextValue {
  return useContext(CardContext);
}
