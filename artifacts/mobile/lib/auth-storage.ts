import AsyncStorage from "@react-native-async-storage/async-storage";

import type { User } from "@workspace/api-client-react";

const TOKEN_KEY = "csp_token";
const USER_KEY = "csp_user";

// Module-level cache so the auth-token getter (registered at app start, outside
// React) can return the current token synchronously on every request.
let cachedToken: string | null = null;

export function getCachedToken(): string | null {
  return cachedToken;
}

export async function loadSession(): Promise<{
  token: string | null;
  user: User | null;
}> {
  const [token, userJson] = await Promise.all([
    AsyncStorage.getItem(TOKEN_KEY),
    AsyncStorage.getItem(USER_KEY),
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
    AsyncStorage.setItem(TOKEN_KEY, token),
    AsyncStorage.setItem(USER_KEY, JSON.stringify(user)),
  ]);
}

export async function clearSession(): Promise<void> {
  cachedToken = null;
  await Promise.all([
    AsyncStorage.removeItem(TOKEN_KEY),
    AsyncStorage.removeItem(USER_KEY),
  ]);
}
