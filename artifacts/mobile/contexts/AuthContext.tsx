import { useQueryClient } from "@tanstack/react-query";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import type { User } from "@workspace/api-client-react";

import { useSettings } from "@/contexts/SettingsContext";
import { clearSession, loadSession, saveSession } from "@/lib/auth-storage";
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

  useEffect(() => {
    let mounted = true;
    loadSession()
      .then((session) => {
        if (!mounted) return;
        bindAccount(session.token ? accountOwnerKey(session.user) : null);
        setToken(session.token);
        setUser(session.user);
        setIsLoading(false);
      })
      .catch(() => {
        if (!mounted) return;
        bindAccount(null);
        setIsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [bindAccount]);

  const login = useCallback(
    async (newToken: string, newUser: User) => {
      await saveSession(newToken, newUser);
      bindAccount(accountOwnerKey(newUser));
      setToken(newToken);
      setUser(newUser);
    },
    [bindAccount],
  );

  const logout = useCallback(async () => {
    await clearSession();
    bindAccount(null);
    setToken(null);
    setUser(null);
    queryClient.clear();
  }, [queryClient, bindAccount]);

  const updateUser = useCallback(
    async (nextUser: User) => {
      setUser(nextUser);
      const current = await loadSession();
      if (current.token) await saveSession(current.token, nextUser);
    },
    [],
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
