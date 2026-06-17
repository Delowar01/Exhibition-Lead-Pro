import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

import type { User } from "@workspace/api-client-react";

import { deleteSecureItem, getSecureItem, setSecureItem } from "./secure-prefs";

const TOKEN_KEY = "csp_token";
const USER_KEY = "csp_user";

// The bearer token + user are sensitive, so on native they live in the
// hardware-backed secure store (via secure-prefs) rather than plaintext
// AsyncStorage. On web SecureStore is unavailable and secure-prefs transparently
// falls back to AsyncStorage.
//
// Earlier builds stored these keys in plaintext AsyncStorage on every platform.
// `migrateLegacySession` reads any such values once, re-persists them through
// secure-prefs, then deletes the old plaintext copies.

// Module-level cache so the auth-token getter (registered at app start, outside
// React) can return the current token synchronously on every request.
let cachedToken: string | null = null;

export function getCachedToken(): string | null {
  return cachedToken;
}

async function migrateLegacySession(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const [legacyToken, legacyUser] = await Promise.all([
      AsyncStorage.getItem(TOKEN_KEY),
      AsyncStorage.getItem(USER_KEY),
    ]);
    if (legacyToken) await setSecureItem(TOKEN_KEY, legacyToken);
    if (legacyUser) await setSecureItem(USER_KEY, legacyUser);
    if (legacyToken || legacyUser) {
      await Promise.all([
        AsyncStorage.removeItem(TOKEN_KEY),
        AsyncStorage.removeItem(USER_KEY),
      ]);
    }
  } catch {
    // Best-effort migration; ignore failures.
  }
}

export async function loadSession(): Promise<{
  token: string | null;
  user: User | null;
}> {
  await migrateLegacySession();

  const [token, userJson] = await Promise.all([
    getSecureItem(TOKEN_KEY),
    getSecureItem(USER_KEY),
  ]);
  cachedToken = token;

  let user: User | null = null;
  if (userJson) {
    try {
      user = JSON.parse(userJson) as User;
    } catch {
      user = null;
    }
  }
  return { token, user };
}

export async function saveSession(token: string, user: User): Promise<void> {
  cachedToken = token;
  await Promise.all([
    setSecureItem(TOKEN_KEY, token),
    setSecureItem(USER_KEY, JSON.stringify(user)),
  ]);
}

export async function clearSession(): Promise<void> {
  cachedToken = null;
  await Promise.all([
    deleteSecureItem(TOKEN_KEY),
    deleteSecureItem(USER_KEY),
  ]);
}
