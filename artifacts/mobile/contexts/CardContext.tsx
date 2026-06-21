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
  getOwnCard,
  upsertOwnCard,
  type BusinessCard,
  type BusinessCardInput,
} from "@workspace/api-client-react";

import { useAuth } from "@/contexts/AuthContext";
import { useOffline } from "@/contexts/OfflineContext";
import { loadCachedCard, saveCachedCard } from "@/lib/card-storage";

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
  /** Force a server refetch (e.g. pull-to-refresh). */
  refresh: () => void;
}

const CardContext = createContext<CardContextValue>({
  card: null,
  isLoading: true,
  hasCard: false,
  pendingSync: false,
  saveCard: async () => {},
  refresh: () => {},
});

// Builds an optimistic BusinessCard from a pending input so the UI updates
// instantly (offline or while the request is in flight). Server-owned fields
// (token, ids, timestamps) are carried over from the previous card when present.
function optimisticCard(
  input: BusinessCardInput,
  prev: BusinessCard | null,
  account: { avatarUrl?: string | null; name?: string | null },
): BusinessCard {
  const now = new Date().toISOString();
  return {
    id: prev?.id ?? 0,
    userId: prev?.userId ?? 0,
    companyId: prev?.companyId ?? null,
    publicToken: prev?.publicToken ?? "",
    fullName: input.fullName,
    designation: input.designation ?? null,
    companyName: input.companyName ?? null,
    email: input.email ?? null,
    primaryPhone: input.primaryPhone ?? null,
    alternatePhone: input.alternatePhone ?? null,
    officeAddress: input.officeAddress ?? null,
    website: input.website ?? null,
    linkedin: input.linkedin ?? null,
    facebook: input.facebook ?? null,
    instagram: input.instagram ?? null,
    twitter: input.twitter ?? null,
    youtube: input.youtube ?? null,
    fieldVisibility: input.fieldVisibility ?? prev?.fieldVisibility ?? {},
    templateId: input.templateId ?? prev?.templateId ?? "classic",
    isPublished: input.isPublished ?? prev?.isPublished ?? true,
    avatarUrl: account.avatarUrl ?? prev?.avatarUrl ?? null,
    accountName: account.name ?? prev?.accountName ?? null,
    publicUrl: prev?.publicUrl ?? null,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
}

export function CardProvider({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated } = useAuth();
  const { isOnline, enqueueCard, lastSyncAt } = useOffline();
  const queryClient = useQueryClient();

  const [card, setCard] = useState<BusinessCard | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingSync, setPendingSync] = useState(false);

  const cardRef = useRef<BusinessCard | null>(null);
  cardRef.current = card;

  const setAndCache = useCallback((next: BusinessCard | null) => {
    cardRef.current = next;
    setCard(next);
    void saveCachedCard(next);
  }, []);

  // --- Cache hydration (instant render on cold start). ----------------------
  useEffect(() => {
    let mounted = true;
    void (async () => {
      const cached = await loadCachedCard();
      if (mounted && cached) {
        cardRef.current = cached;
        setCard(cached);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // --- Server fetch. --------------------------------------------------------
  const fetchCard = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const server = await getOwnCard();
      setAndCache(server);
      setPendingSync(false);
    } catch (err) {
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
      // Optimistic update first so the UI reflects the edit immediately.
      setAndCache(optimisticCard(input, cardRef.current, account));

      if (isOnline) {
        const server = await upsertOwnCard(input);
        setAndCache(server);
        setPendingSync(false);
        void queryClient.invalidateQueries();
      } else {
        enqueueCard(input, input.fullName || "My business card");
        setPendingSync(true);
      }
    },
    [isOnline, enqueueCard, queryClient, setAndCache, user?.avatarUrl, user?.name],
  );

  const value: CardContextValue = {
    card,
    isLoading,
    hasCard: !!card?.fullName,
    pendingSync,
    saveCard,
    refresh: () => void fetchCard(),
  };

  return <CardContext.Provider value={value}>{children}</CardContext.Provider>;
}

export function useCard(): CardContextValue {
  return useContext(CardContext);
}
