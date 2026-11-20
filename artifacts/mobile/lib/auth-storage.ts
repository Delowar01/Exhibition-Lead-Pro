import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

import type { User } from "@workspace/api-client-react";

import { deleteSecureItem, getSecureItem, setSecureItem } from "./secure-prefs";

const TOKEN_KEY = "csp_token";
const USER_KEY = "csp_user";
// Phase 2 Batch 1: the refresh token the API issues at sign-in. Same protection
// as the access token (hardware-backed secure store on native). It is replaced
// at every renewal and deleted at sign-out and when the session ends.
const REFRESH_KEY = "csp_refresh";

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
let cachedRefreshToken: string | null = null;

export function getCachedToken(): string | null {
  return cachedToken;
}

/** The refresh token of the current session (null = signed out, or a session restored without one). */
export function getCachedRefreshToken(): string | null {
  return cachedRefreshToken;
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
  refreshToken: string | null;
}> {
  await migrateLegacySession();

  const [token, userJson, storedRefresh] = await Promise.all([
    getSecureItem(TOKEN_KEY),
    getSecureItem(USER_KEY),
    getSecureItem(REFRESH_KEY),
  ]);
  cachedToken = token;
  // A refresh token is only ever used together with the session it belongs to.
  const refreshToken = token ? storedRefresh : null;
  cachedRefreshToken = refreshToken;

  let user: User | null = null;
  if (userJson) {
    try {
      user = JSON.parse(userJson) as User;
    } catch {
      user = null;
    }
  }
  return { token, user, refreshToken };
}

export async function saveSession(token: string, user: User, refreshToken: string | null = null): Promise<void> {
  cachedToken = token;
  cachedRefreshToken = refreshToken;
  await Promise.all([
    setSecureItem(TOKEN_KEY, token),
    setSecureItem(USER_KEY, JSON.stringify(user)),
    // Never leave another session's refresh token next to this session's access token.
    refreshToken ? setSecureItem(REFRESH_KEY, refreshToken) : deleteSecureItem(REFRESH_KEY),
  ]);
}

/**
 * Store the tokens of a RENEWED session. Applies only while `expectedToken` is
 * still the current access token — i.e. the session that asked for the renewal
 * is still the one signed in. Returns false (and stores nothing) when a
 * sign-out or another sign-in happened meanwhile, so a late renewal answer can
 * neither revive a signed-out session nor replace another account's tokens.
 */
export async function saveRotatedTokens(expectedToken: string, next: { token: string; refreshToken: string }): Promise<boolean> {
  if (cachedToken !== expectedToken) return false;
  cachedToken = next.token;
  cachedRefreshToken = next.refreshToken;
  try {
    await Promise.all([setSecureItem(TOKEN_KEY, next.token), setSecureItem(REFRESH_KEY, next.refreshToken)]);
  } catch {
    // The renewed session still works for this run (tokens are in memory). If
    // the stored copy is stale at the next start the server refuses it and the
    // user signs in again — the safe outcome.
  }
  if (cachedToken === next.token) return true;
  // The session changed while the write was under way: restore what is current.
  if (cachedToken === null) {
    await Promise.all([deleteSecureItem(TOKEN_KEY), deleteSecureItem(REFRESH_KEY)]);
  } else {
    const token = cachedToken;
    const refresh = cachedRefreshToken;
    await Promise.all([setSecureItem(TOKEN_KEY, token), refresh ? setSecureItem(REFRESH_KEY, refresh) : deleteSecureItem(REFRESH_KEY)]).catch(() => {});
  }
  return false;
}

// M5 (entitlement refresh): replaces ONLY the stored user of the session that
// owns `token`. The token itself is never written here, so a refresh that
// answers late can never bring a signed-out session back.
export async function saveSessionUser(token: string, user: User): Promise<void> {
  if (cachedToken !== token) return;
  await setSecureItem(USER_KEY, JSON.stringify(user));
  // Signed out while the write was in flight: leave nothing behind.
  if (cachedToken === null) await deleteSecureItem(USER_KEY);
}

export async function clearSession(): Promise<void> {
  cachedToken = null;
  cachedRefreshToken = null;
  await Promise.all([
    deleteSecureItem(TOKEN_KEY),
    deleteSecureItem(USER_KEY),
    deleteSecureItem(REFRESH_KEY),
  ]);
}
