import AsyncStorage from "@react-native-async-storage/async-storage";

import type { BusinessCard } from "@workspace/api-client-react";

const CARD_CACHE_KEY = "csp_own_card";

// Last known good copy of the user's own digital business card, so the Home
// takeover and card screen render instantly on cold start and stay visible while
// offline (where no server fetch can succeed).
export async function loadCachedCard(): Promise<BusinessCard | null> {
  try {
    const raw = await AsyncStorage.getItem(CARD_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as BusinessCard;
  } catch {
    return null;
  }
}

export async function saveCachedCard(card: BusinessCard | null): Promise<void> {
  try {
    if (card) {
      await AsyncStorage.setItem(CARD_CACHE_KEY, JSON.stringify(card));
    } else {
      await AsyncStorage.removeItem(CARD_CACHE_KEY);
    }
  } catch {
    /* best-effort persistence */
  }
}
