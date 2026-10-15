import AsyncStorage from "@react-native-async-storage/async-storage";

import type { BusinessCard } from "@workspace/api-client-react";

import { type OwnedCardCache, parseStoredCardCache, serializeCardCache } from "./card-cache-model";

// Last known good copy of the user's own digital business card, so the card
// screen renders instantly on cold start and stays visible while offline.
// The slot holds ONE owner wrapper `{ owner, card }` (lib/card-cache-model.ts);
// the storage key is unchanged on purpose. A pre-ownership raw card in the slot
// is legacy: it is removed on load and never attributed to any account.
const CARD_CACHE_KEY = "csp_own_card";

export async function loadCachedCard(): Promise<OwnedCardCache | null> {
  try {
    const stored = parseStoredCardCache(await AsyncStorage.getItem(CARD_CACHE_KEY));
    if (stored.kind === "owned") return stored.cache;
    if (stored.kind === "legacy") await AsyncStorage.removeItem(CARD_CACHE_KEY);
    return null;
  } catch {
    return null;
  }
}

/** Persist the owner's card; without a tenant owner nothing is written. */
export async function saveCachedCard(owner: string | null | undefined, card: BusinessCard): Promise<void> {
  const snapshot = serializeCardCache(owner, card);
  if (!snapshot) return;
  try {
    await AsyncStorage.setItem(CARD_CACHE_KEY, snapshot);
  } catch {
    /* best-effort persistence */
  }
}

export async function clearCachedCard(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CARD_CACHE_KEY);
  } catch {
    /* noop */
  }
}
