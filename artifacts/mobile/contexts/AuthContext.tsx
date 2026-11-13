import { useQueryClient } from "@tanstack/react-query";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";

import { getMe, setOnFeatureDenied } from "@workspace/api-client-react";
import type { User } from "@workspace/api-client-react";

import { useSettings } from "@/contexts/SettingsContext";
import {
  clearSession,
  getCachedToken,
  loadSession,
  saveSession,
  saveSessionUser,
} from "@/lib/auth-storage";
import { reconcileBiometricLogin } from "@/lib/biometric";
import { createEntitlementRefresher } from "@/lib/entitlement-refresh";
import { accountOwnerKey } from "@/lib/settings-model";

interface AuthContextValue {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (token: string, user: User) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (user: User) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();
  // Every auth boundary binds the tenant-scoped settings (active event, event
  // filter) to the account now signed in, so they never carry across accounts.
  const { bindAccount } = useSettings();

  // M5 — entitlement refresh. The user stored at sign-in (and with it the plan
  // entitlements) is re-read from GET /auth/me once a stored session is
  // restored (launch, or a sign-in), when the app returns to the foreground and
  // when the API answers 403 FEATURE_NOT_ENTITLED. (This client has no
  // token-refresh flow, so there is no session-renewal trigger to wire.) Best
  // effort: it never signs out, never touches the token, never surfaces an error.
  // `userRef` / `generationRef` are the session as of NOW (not as of the last
  // render), which is what the identity guard compares an answer against.
  const userRef = useRef<User | null>(null);
  const generationRef = useRef(0);
  const [refresher] = useState(() =>
    createEntitlementRefresher<User>({
      getIdentity: () => {
        const current = userRef.current;
        if (!current || !getCachedToken()) return null;
        return {
          userId: current.id,
          companyId: current.companyId ?? null,
          generation: generationRef.current,
        };
      },
      getUser: () => userRef.current,
      fetchUser: (signal) => getMe({ signal }),
      applyUser: (fresh) => {
        const sessionToken = getCachedToken();
        if (!sessionToken) return;
        userRef.current = fresh;
        setUser(fresh);
        void saveSessionUser(sessionToken, fresh).catch(() => {
          // Storage trouble: the in-memory user is still current.
        });
      },
    }),
  );

  useEffect(() => {
    let mounted = true;
    loadSession()
      .then((session) => {
        if (!mounted) return;
        bindAccount(session.token ? accountOwnerKey(session.user) : null);
        setToken(session.token);
        setUser(session.user);
        setIsLoading(false);
        userRef.current = session.user;
        void refresher.refresh("restore");
      })
      .catch(() => {
        if (!mounted) return;
        bindAccount(null);
        setIsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [bindAccount, refresher]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresher.refresh("resume");
    });
    setOnFeatureDenied(() => void refresher.refresh("feature-denied"));
    return () => {
      subscription.remove();
      setOnFeatureDenied(null);
    };
  }, [refresher]);

  const login = useCallback(
    async (newToken: string, newUser: User) => {
      // M5: a refresh still in flight belongs to the previous session — its
      // answer is dropped from here on (generationRef is its identity guard).
      generationRef.current += 1;
      await saveSession(newToken, newUser);
      // The remembered biometric sign-in belongs to ONE account: it stays when
      // this is that account and is cleared when a different account has just
      // authenticated. Best effort — storage trouble must not block a login.
      try {
        await reconcileBiometricLogin(newUser);
      } catch {
        // ignore
      }
      bindAccount(accountOwnerKey(newUser));
      setToken(newToken);
      setUser(newUser);
      userRef.current = newUser;
      // M5: a biometric quick sign-in restores a STORED user snapshot (as old
      // as its enrolment), so every sign-in re-reads the user once. After a
      // password / MFA sign-in this merely confirms the answer just received.
      void refresher.refresh("restore");
    },
    [bindAccount, refresher],
  );

  const logout = useCallback(async () => {
    generationRef.current += 1;
    await clearSession();
    bindAccount(null);
    setToken(null);
    setUser(null);
    userRef.current = null;
    queryClient.clear();
  }, [queryClient, bindAccount]);

  const updateUser = useCallback(
    async (nextUser: User) => {
      // M5: a local edit wins over a refresh answer requested before it.
      generationRef.current += 1;
      userRef.current = nextUser;
      setUser(nextUser);
      const current = await loadSession();
      if (current.token) await saveSession(current.token, nextUser);
      // A profile edit answers with a user that carries no permissions or
      // entitlements: re-read the full user at once, so the cached copy never
      // sits without them until the next resume.
      void refresher.refresh("restore");
    },
    [refresher],
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isLoading,
        isAuthenticated: !!token,
        login,
        logout,
        updateUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
